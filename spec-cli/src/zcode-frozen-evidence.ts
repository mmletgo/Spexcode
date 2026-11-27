import { createHash } from 'node:crypto'
import { zcodeReplay } from '../llm-manager/native-runtime.mjs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { frozenReadTool, proveFrozenReads, type FrozenContextRef, type FrozenNativeItem, type FrozenReadProof } from './frozen-context.js'
import { StructuredSessionError } from './session-structured-policy.js'

export const ZCODE_FROZEN_TOOL = 'mcp__frozen__spex_read_frozen' as const
type NativeRecord = Record<string, unknown>
/** 原生 core 记录原样保存；不接受协议声明中的 messageId/callId 别名。 */
export type ZCodeNativeMessage = { info: NativeRecord; parts: NativeRecord[] }
export type ZCodeNativeEvent = { eventId: string; sessionId: string; turnId?: string; seq: number; type: string; payload: NativeRecord }
export type ZCodeFrozenWitness = {
  version: 1; provider: 'zcode'; cliVersion: string; cliSha256: string; providerId: string; modelId: string
  sessionId: string; turnId: string; inputId: string; prompt: string
  send: { sessionId: string; content: string; inputId: string; modelSelection?: Pick<ZCodeFrozenModel, 'providerId' | 'modelId' | 'options'> }
  messages: ZCodeNativeMessage[]; events: ZCodeNativeEvent[]
  mcpHistory: { records: NativeRecord[]; digest: string }
}
type SharedProof = Pick<FrozenReadProof, 'contextDigest' | 'threadId' | 'turnId' | 'receipts' | 'coveredEntryIds' | 'historyDigest'>
export type ZCodeFrozenReadProof = SharedProof & {
  version: 4; provider: 'zcode'; providerId: string; modelId: string; cliVersion: string; cliSha256: string
  inputId: string; promptDigest: string; witnessDigest: string
}
export type ZCodeFrozenIdentity = { threadId: string; turnId: string; inputId?: string; prompt?: string }
export type ZCodeFrozenModel = { providerId: string; modelId: string; cliVersion?: string; cliSha256?: string; options?: { reasoningLevel?: string } }
type ZCodeObservedReadTurn = {
  calls: Map<string, { state: NativeRecord }>
  reads: { callId: string; input: NativeRecord; output: string }[]
  response: string
  realUserModelSelection: NativeRecord
}
export type ZCodeFrozenNativeAdapter = {
  ZCodeProtocolError: abstract new (...args: never[]) => Error & { code: string }
  observeZCodeFrozenReadTurn(input: Pick<ZCodeFrozenWitness, 'sessionId' | 'turnId' | 'inputId' | 'prompt' | 'providerId' | 'modelId' | 'send' | 'messages' | 'events'> & { expectedTool: string }): ZCodeObservedReadTurn
  decodeZCodeJsonText(rawText: string): string
}
const frozenReplay = zcodeReplay as ZCodeFrozenNativeAdapter
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function stale(message: string): never { throw new StructuredSessionError('stale_result', `ZCode ${message}`) }
function record(value: unknown): NativeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stale('native evidence requires an object')
  return value as NativeRecord
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) stale('native evidence requires a nonempty identity')
  return value
}
function complete(value: NativeRecord): void {
  for (const key of ['truncated', 'omitted', 'inputOmitted', 'outputOmitted'])
    if (value[key] !== undefined && value[key] !== false) stale('native evidence is truncated or omitted')
}
function witnessPath(ref: FrozenContextRef, hash: string): string { return join(dirname(ref.manifestPath), 'histories', `zcode-witness-${hash}`) }

function checkMcpHistory(witness: ZCodeFrozenWitness, calls: Map<string, { state: NativeRecord }>): void {
  const history = record(witness.mcpHistory)
  if (!Array.isArray(history.records) || history.digest !== sha(encode(history.records))) stale('MCP public history digest differs')
  const pending = new Map<string, NativeRecord>(), seen = new Set<string>(), matched = new Set<string>()
  let initialized = false, listed = false
  for (const raw of history.records) {
    const row = record(raw)
    if (row.type === 'process' || row.type === 'exit') continue
    if (row.type !== 'request' && row.type !== 'response') stale('MCP public history has an unknown record')
    const rpc = record(row[row.type])
    if (rpc.jsonrpc !== '2.0' || typeof rpc.id !== 'string' && typeof rpc.id !== 'number') stale('MCP history has no exact RPC identity')
    const id = `${typeof rpc.id}:${rpc.id}`
    if (row.type === 'request') {
      if (seen.has(id) || !['initialize', 'tools/list', 'tools/call', 'ping'].includes(String(rpc.method))) stale('MCP request is repeated or foreign')
      seen.add(id); pending.set(id, rpc); continue
    }
    const request = pending.get(id), result = record(rpc.result)
    if (!request || rpc.error !== undefined || result.isError !== undefined && result.isError !== false) stale('MCP response is unpaired or failed')
    pending.delete(id); complete(result)
    if (request.method === 'initialize') {
      const client = record(record(request.params).clientInfo)
      if (client.name !== 'zcode' || client.version !== witness.cliVersion || record(result.serverInfo).name !== 'spex-immutable-reader') stale('MCP initialize differs from its exact CLI/reader')
      initialized = true
    } else if (request.method === 'tools/list') {
      if (!Array.isArray(result.tools) || result.tools.length !== 1) stale('MCP exposes more than the frozen reader')
      const tool = record(result.tools[0])
      if (tool.name !== 'spex_read_frozen' || !isDeepStrictEqual(tool.inputSchema, frozenReadTool.inputSchema)) stale('MCP reader surface differs')
      listed = true
    } else if (request.method === 'tools/call') {
      const params = record(request.params), meta = record(params._meta)
      if (!initialized || !listed || params.name !== 'spex_read_frozen' || meta.session_id !== witness.sessionId || meta.turn_id !== witness.turnId) stale('MCP call differs from its original reader/session/turn')
      if (meta['com.zcode/request-context'] !== undefined) {
        const nested = record(meta['com.zcode/request-context'])
        if (nested.session_id !== witness.sessionId || nested.turn_id !== witness.turnId) stale('MCP nested request context differs')
      }
      const match = [...calls].find(([id, call]) => !matched.has(id) && isDeepStrictEqual(call.state.input, params.arguments))
      if (!match || !isDeepStrictEqual(result.content, [{ type: 'text', text: match[1].state.output }])) stale('MCP call/response differs from a full original native part')
      const input = record(match[1].state.input)
      if (Number(input.endByte) - Number(input.startByte) > 65536 || String(match[1].state.output).length > 500000) stale('reader exceeded its fixed MCP bounds')
      matched.add(match[0])
    }
  }
  if (!initialized || !listed || pending.size || matched.size !== calls.size) stale('MCP history lacks complete native call/response coverage')
}

function prepareZCodeFrozenProof(ref: FrozenContextRef, witness: ZCodeFrozenWitness, decoder: ZCodeFrozenNativeAdapter) {
  record(witness)
  const { sessionId, turnId, inputId, prompt, providerId, modelId, cliVersion, cliSha256, send, messages, events } = witness
  if (witness.version !== 1 || witness.provider !== 'zcode' || !digest(cliSha256)) stale('witness has no exact CLI identity')
  for (const value of [sessionId, turnId, inputId, prompt, providerId, modelId, cliVersion]) text(value)
  let observed: ZCodeObservedReadTurn
  try { observed = decoder.observeZCodeFrozenReadTurn({ sessionId, turnId, inputId, prompt, providerId, modelId, send, messages, events, expectedTool: ZCODE_FROZEN_TOOL }) }
  catch (error) {
    if (!(error instanceof decoder.ZCodeProtocolError) || error.code !== 'stale_result') throw error
    throw new StructuredSessionError('stale_result', error.message)
  }
  const items = observed.reads.map(({ callId, input, output }): FrozenNativeItem => ({
    type: 'dynamicToolCall', id: callId, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true,
    arguments: input, contentItems: [{ type: 'inputText', text: output }],
  }))
  checkMcpHistory(witness, observed.calls)
  const shared = proveFrozenReads(ref, { threadId: sessionId, turnId }, items)
  const bytes = encode(witness), witnessDigest = sha(bytes), path = witnessPath(ref, witnessDigest)
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== witnessDigest) stale('saved native witness was modified')
  const proof: ZCodeFrozenReadProof = { ...shared, version: 4, provider: 'zcode', providerId, modelId, cliVersion, cliSha256, inputId, promptDigest: sha(prompt), witnessDigest }
  return { proof, observed }
}

/** 从绑定的原始 ZCode 轮次重建调用，再复用通用冻结字节覆盖证明。 */
export function proveZCodeFrozenReads(ref: FrozenContextRef, witness: ZCodeFrozenWitness, decoder = frozenReplay): ZCodeFrozenReadProof {
  return prepareZCodeFrozenProof(ref, witness, decoder).proof
}

/** 仅去除外围空白或单一完整 JSON 围栏，正文仍由同一个 JSON/schema 校验入口处理。 */
export const { decodeZCodeJsonText } = frozenReplay

/** 冷恢复只重读内容寻址原始见证和标准化历史，绝不启动 CLI 或重发工具。 */
export function verifyZCodeFrozenReadProof(ref: FrozenContextRef, proof: ZCodeFrozenReadProof, identity: ZCodeFrozenIdentity, expectedModel?: ZCodeFrozenModel, result?: { output: unknown }): void {
  if (proof.version !== 4 || proof.provider !== 'zcode' || proof.contextDigest !== ref.contextDigest || proof.threadId !== identity.threadId || proof.turnId !== identity.turnId
    || !digest(proof.witnessDigest) || !digest(proof.historyDigest) || identity.inputId !== undefined && proof.inputId !== identity.inputId || identity.prompt !== undefined && proof.promptDigest !== sha(identity.prompt)) stale('evidence differs from the exact context/session/turn/input')
  if (expectedModel && (proof.providerId !== expectedModel.providerId || proof.modelId !== expectedModel.modelId || expectedModel.cliVersion !== undefined && proof.cliVersion !== expectedModel.cliVersion || expectedModel.cliSha256 !== undefined && proof.cliSha256 !== expectedModel.cliSha256)) stale('evidence differs from its fixed model/CLI')
  const bytes = readFileSync(witnessPath(ref, proof.witnessDigest)), history = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.historyDigest))
  if (sha(bytes) !== proof.witnessDigest || sha(history) !== proof.historyDigest) stale('saved witness or normalized history digest differs')
  const witness = JSON.parse(bytes.toString('utf8')) as ZCodeFrozenWitness
  const { proof: actual, observed } = prepareZCodeFrozenProof(ref, witness, frozenReplay)
  if (expectedModel?.options?.reasoningLevel !== undefined
    && record(observed.realUserModelSelection.options).reasoningLevel !== expectedModel.options.reasoningLevel) stale('original real user reasoning level differs from the fixed model options')
  if (result) {
    const { response } = observed
    let output: unknown
    try { output = JSON.parse(decodeZCodeJsonText(response)) }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; stale('authoritative native response is not one JSON value') }
    if (!isDeepStrictEqual(output, result.output)) stale('result differs from its authoritative native response')
  }
  if (!isDeepStrictEqual(actual, proof)) stale('evidence differs from its authoritative native witness')
}
