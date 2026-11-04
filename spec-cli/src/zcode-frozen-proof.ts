import { createHash } from 'node:crypto'
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

/** 从精确原生消息与安全事件重建调用，再复用通用冻结字节覆盖证明。 */
export function proveZCodeFrozenReads(ref: FrozenContextRef, witness: ZCodeFrozenWitness): ZCodeFrozenReadProof {
  record(witness)
  const { sessionId, turnId, inputId, prompt, providerId, modelId, cliVersion, cliSha256 } = witness
  if (witness.version !== 1 || witness.provider !== 'zcode' || !digest(cliSha256)) stale('witness has no exact CLI identity')
  for (const value of [sessionId, turnId, inputId, prompt, providerId, modelId, cliVersion]) text(value)
  const send = record(witness.send)
  if (send.sessionId !== sessionId || send.content !== prompt || send.inputId !== inputId) stale('send differs from the exact frozen prompt/input')
  if (!Array.isArray(witness.messages) || !Array.isArray(witness.events)) stale('witness lacks raw native messages/events')
  const messages = new Map<string, NativeRecord>(), calls = new Map<string, { messageId: string; state: NativeRecord }>(), partIds = new Set<string>(), rawMessageIds = new Set<string>()
  let user: ZCodeNativeMessage | undefined
  const runtimeSources = new Set<string>(), requestPrefixCounts: number[] = []
  let assistantCount = 0, modelChangeTime: number | undefined
  for (const message of witness.messages) {
    record(message)
    const info = record(message.info), id = text(info.id)
    if (rawMessageIds.has(id) || info.sessionID !== sessionId || !['user', 'assistant'].includes(String(info.role)) || !Array.isArray(message.parts)) stale('raw message identity or role differs')
    rawMessageIds.add(id)
    for (const raw of message.parts) {
      const part = record(raw), partId = text(part.id)
      if (partIds.has(partId) || part.sessionID !== sessionId || part.messageID !== id) stale('raw part is not bound to its exact message/session')
      partIds.add(partId); complete(part)
    }
    const semantics = record(info.semantics)
    if (semantics.providerVisibility === 'hidden') {
      const part = record(message.parts[0]), time = record(info.time), tokens = record(info.tokens), cache = record(tokens.cache), location = record(info.path)
      if (rawMessageIds.size !== 1 || info.role !== 'assistant' || info.anchor !== undefined || info.parentID !== id || info.modelId !== modelId || info.providerId !== providerId
        || typeof info.mode !== 'string' || typeof info.planEnabled !== 'boolean' || typeof info.agent !== 'string'
        || typeof location.cwd !== 'string' || typeof location.root !== 'string' || Object.keys(location).some(key => !['cwd', 'root'].includes(key))
        || info.cost !== 0 || info.finish !== 'completed' || !Number.isSafeInteger(time.created) || Number(time.created) < 0 || !isDeepStrictEqual(time, { created: time.created, completed: time.created })
        || !isDeepStrictEqual(semantics, { origin: 'system', kind: 'timeline_event', uiVisibility: 'visible', providerVisibility: 'hidden', transcriptVisibility: 'visible' })
        || Object.keys(info).some(key => !['id', 'sessionID', 'role', 'time', 'parentID', 'modelId', 'providerId', 'mode', 'planEnabled', 'agent', 'path', 'cost', 'tokens', 'finish', 'semantics'].includes(key))
        || tokens.input !== 0 || tokens.output !== 0 || tokens.reasoning !== 0 || tokens.total !== undefined && tokens.total !== 0 || !isDeepStrictEqual(cache, { read: 0, write: 0 })
        || Object.keys(tokens).some(key => !['input', 'output', 'reasoning', 'cache', 'total'].includes(key)) || message.parts.length !== 1
        || part.type !== 'timeline' || part.timelineType !== 'model_change' || part.display !== 'separator' || part.status !== 'completed'
        || !isDeepStrictEqual(part.time, { start: time.created, end: time.created }) || Object.keys(part).some(key => !['id', 'sessionID', 'messageID', 'type', 'timelineType', 'display', 'status', 'time', 'fromModel', 'toModel'].includes(key))) stale('hidden message is not a pre-turn display-only native model change')
      for (const value of [part.fromModel, part.toModel].filter(value => value !== undefined)) {
        const model = record(value)
        if (!text(model.providerId).trim() || !text(model.modelId).trim() || model.label !== undefined && typeof model.label !== 'string'
          || Object.keys(model).some(key => !['providerId', 'modelId', 'options', 'label'].includes(key))) stale('model change contains an unknown model selection payload')
        if (model.options !== undefined) {
          const options = record(model.options)
          if (Object.keys(options).some(key => key !== 'reasoningLevel') || options.reasoningLevel !== undefined && (typeof options.reasoningLevel !== 'string' || !options.reasoningLevel.trim())) stale('model change contains invalid model options')
        }
      }
      const target = record(part.toModel)
      if (target.providerId !== providerId || target.modelId !== modelId) stale('model change target differs from the fixed model')
      modelChangeTime = Number(time.created); continue
    }
    messages.set(id, info)
    const anchor = record(info.anchor)
    if (anchor.turnId !== turnId || semantics.providerVisibility !== 'visible') stale('message is outside the exact model-visible native turn')
    if (info.role === 'user') {
      const model = record(info.modelSelection)
      if (model.providerId !== providerId || model.modelId !== modelId) stale('user input has a foreign native model selection')
      if (info.synthetic === true) {
        const source = text(semantics.source), metadata = record(info.metadata)
        const silentReminder = source === 'silent_turn_reminder'
        if (!['environment', 'model', 'runtime_mode', 'date', 'silent_turn_reminder'].includes(source) || !silentReminder && (runtimeSources.has(source) || assistantCount > 0) || anchor.origin !== 'synthetic'
          || info.visibility !== 'model-only' || semantics.origin !== 'agent_runtime' || semantics.kind !== 'system_reminder'
          || semantics.uiVisibility !== 'hidden' || semantics.transcriptVisibility !== 'hidden' || metadata.source !== source
          || metadata.visibility !== 'model-only' || record(metadata.runtimeMessage).source !== source || message.parts.length !== 1) stale('synthetic user is not a known same-turn native runtime reminder')
        if (silentReminder && (assistantCount === 0 || message.parts[0].text !== "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.")) stale('silent reminder differs from its known native body or mid-turn position')
        runtimeSources.add(source)
      } else {
        if (user || anchor.origin !== 'realUser' || semantics.origin !== 'real_user' || semantics.kind !== 'user_prompt'
          || semantics.uiVisibility !== 'visible' || semantics.transcriptVisibility !== 'visible') stale('history contains another or unrecognized real user input')
        if (modelChangeTime !== undefined && (!Number.isSafeInteger(record(info.time).created) || Number(record(info.time).created) < modelChangeTime)) stale('display-only model change was inserted after the real user input')
        text(anchor.sourceCommandId); user = message
      }
    } else {
      requestPrefixCounts.push(messages.size - 1)
      assistantCount++
      if (info.providerId !== providerId || info.modelId !== modelId || info.error !== undefined || semantics.origin !== 'agent_runtime'
        || semantics.kind !== 'assistant_response' || semantics.uiVisibility !== 'visible' || semantics.transcriptVisibility !== 'visible') stale('assistant has a foreign model, origin or native error')
    }
    for (const raw of message.parts) {
      const part = record(raw)
      if (part.type !== 'tool') {
        if (['text', 'reasoning'].includes(String(part.type)) && typeof part.text !== 'string') stale('native text part lacks its original text')
        if (!['text', 'reasoning', 'step-start', 'step-finish'].includes(String(part.type)) || info.role === 'user' && (part.type !== 'text' || (part.synthetic === true) !== (info.synthetic === true) || info.synthetic === true && !isDeepStrictEqual(part.metadata, info.metadata))) stale('native message contains unsupported input or part')
        continue
      }
      const callId = text(part.callID), state = record(part.state)
      complete(state)
      const metadata = record(state.metadata), serialization = record(metadata.serialization)
      complete(metadata); complete(serialization)
      const bytes = typeof state.output === 'string' ? Buffer.byteLength(state.output, 'utf8') : -1
      if (serialization.truncated !== false || serialization.originalBytes !== bytes || serialization.returnedBytes !== bytes) stale('raw tool part serialization is incomplete or truncated')
      if (info.role !== 'assistant' || calls.has(callId) || part.tool !== ZCODE_FROZEN_TOOL || state.status !== 'completed' || typeof state.output !== 'string') stale('tool part is foreign, repeated, pending or incomplete')
      record(state.input)
      calls.set(callId, { messageId: id, state })
    }
  }
  if (!user || user.parts.map(part => part.text).join('') !== prompt) stale('original native user message differs from the exact prompt')
  if (send.modelSelection !== undefined && !isDeepStrictEqual(send.modelSelection, user.info.modelSelection)) stale('explicit native send model selection differs from the original real user')
  const userId = text(user.info.id)
  for (const [id, info] of messages) {
    if (info.role !== 'assistant') continue
    const seen = new Set([id]); let parent = text(info.parentID)
    while (parent !== userId) {
      if (seen.has(parent) || !messages.has(parent)) stale('assistant parent chain is outside the original user input')
      seen.add(parent); parent = text(messages.get(parent)!.parentID)
    }
  }
  const finalMessage = witness.messages.at(-1)!, finalAnchor = record(finalMessage.info.anchor)
  if (finalMessage.info.role !== 'assistant' || finalAnchor.boundaryMessageId !== finalMessage.info.id
    || !isDeepStrictEqual(finalAnchor.orderedMessageIds, [...messages.keys()]) || finalAnchor.historyRoundCount !== assistantCount) stale('final native boundary does not close its exact ordered message history')
  const assistants = [...messages].filter(([, info]) => info.role === 'assistant'), assistantIndices = new Map(assistants.map(([id], index) => [id, index]))
  const eventIds = new Set<string>(), scheduled = new Map<string, number>(), started = new Set<string>(), results = new Map<string, number>(), requests: number[] = []
  let previousSeq = -1, began = false, ended = false
  let response: string | undefined
  for (const raw of witness.events) {
    const event = record(raw), payload = record(event.payload)
    if (event.sessionId !== sessionId || event.turnId !== turnId || !Number.isSafeInteger(event.seq) || Number(event.seq) <= previousSeq || eventIds.has(text(event.eventId)) || ended) stale('event identity, order or terminal boundary differs')
    const seq = Number(event.seq); previousSeq = seq; eventIds.add(String(event.eventId))
    if (event.type === 'turn.started') {
      if (began || payload.input !== prompt || payload.inputId !== inputId || payload.messageId !== userId || payload.turnNumber !== 0 || payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > 0)) stale('turn start differs from the unique original user/input')
      began = true; continue
    }
    if (!began) stale('evidence precedes its original native turn start')
    if (event.type === 'turn.completed') {
      if (payload.resultType !== 'success' || payload.inputId !== inputId || typeof payload.response !== 'string' || payload.error !== undefined || payload.toolCallCount !== calls.size) stale('turn has no exact successful native completion')
      response = payload.response; ended = true; continue
    }
    if (event.type === 'session.updated') {
      if (payload.providerId !== providerId || payload.modelId !== modelId || payload.toolCount !== 1 || payload.iteration !== Math.ceil(results.size / 10) || payload.messageCount !== requestPrefixCounts[requests.length] + results.size) stale('actual ModelRequest has a foreign model, tool surface or iteration')
      requests.push(seq); continue
    }
    if (event.type !== 'tool.updated') stale('evidence contains a foreign turn, user input or unsupported event')
    if (payload.toolName !== undefined && payload.toolName !== ZCODE_FROZEN_TOOL || ['source', 'agentId', 'childSessionId', 'parentToolCallId'].some(key => payload[key] !== undefined)) stale('tool event exposes a foreign tool or subagent')
    if (payload.kind === 'batch') {
      if (!Array.isArray(payload.toolCallIds) || new Set(payload.toolCallIds).size !== payload.toolCallIds.length || payload.toolCallIds.some(id => typeof id !== 'string' || !results.has(id)) || payload.errorCount !== 0 || payload.successCount !== payload.toolCallIds.length) stale('tool batch differs from completed native calls')
      continue
    }
    const callId = text(payload.toolCallId), call = calls.get(callId)
    if (!call) stale('tool event is outside the exact native reader call')
    if (payload.kind === 'scheduled') {
      if (scheduled.has(callId) || payload.toolName !== ZCODE_FROZEN_TOOL || payload.assistantMessageId !== call.messageId || !requests.length || payload.input !== undefined && !isDeepStrictEqual(payload.input, call.state.input)) stale('scheduled tool differs from its original message/input')
      scheduled.set(callId, seq)
    } else if (payload.kind === 'started') {
      if (!scheduled.has(callId) || started.has(callId)) stale('tool start has no unique original schedule')
      started.add(callId)
    } else if (payload.kind === 'result') {
      const result = record(payload.result), bytes = Buffer.byteLength(String(call.state.output), 'utf8')
      complete(result)
      if (!started.has(callId) || results.has(callId) || result.success !== true || result.truncated !== false || result.content !== call.state.output || result.originalBytes !== bytes || result.returnedBytes !== bytes) stale('native tool result is incomplete, substituted or truncated')
      results.set(callId, seq)
    } else if (payload.kind !== 'progress' || !started.has(callId) || results.has(callId)) stale('tool event is not a supported successful lifecycle')
  }
  if (!ended || !requests.length || requests.length !== assistantCount || response === undefined || scheduled.size !== calls.size || results.size !== calls.size) stale('turn or native call evidence is unfinished')
  if (finalMessage.parts.filter(part => part.type === 'text').map(part => part.text).join('') !== response) stale('terminal response differs from its final native boundary message')
  const items: FrozenNativeItem[] = []
  for (const [callId, scheduleSeq] of scheduled) {
    const call = calls.get(callId)!, index = assistantIndices.get(call.messageId)!, consumer = requests[index + 1]
    if (scheduleSeq <= requests[index] || consumer === undefined || results.get(callId)! >= consumer) stale('reader lifecycle differs from its assistant generation and next ModelRequest consumer')
    items.push({ type: 'dynamicToolCall', id: callId, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true,
      arguments: call.state.input, contentItems: [{ type: 'inputText', text: call.state.output }] })
  }
  checkMcpHistory(witness, calls)
  const shared = proveFrozenReads(ref, { threadId: sessionId, turnId }, items)
  const bytes = encode(witness), witnessDigest = sha(bytes), path = witnessPath(ref, witnessDigest)
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== witnessDigest) stale('saved native witness was modified')
  return { ...shared, version: 4, provider: 'zcode', providerId, modelId, cliVersion, cliSha256, inputId, promptDigest: sha(prompt), witnessDigest }
}

/** 仅去除外围空白或单一完整 JSON 围栏，正文仍由同一个 JSON/schema 校验入口处理。 */
export function decodeZCodeJsonText(rawText: string): string {
  const text = rawText.trim(), fenced = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text)
  return fenced ? fenced[1] : text
}

/** 冷恢复只重读内容寻址原始见证和标准化历史，绝不启动 CLI 或重发工具。 */
export function verifyZCodeFrozenReadProof(ref: FrozenContextRef, proof: ZCodeFrozenReadProof, identity: ZCodeFrozenIdentity, expectedModel?: ZCodeFrozenModel, result?: { output: unknown }): void {
  if (proof.version !== 4 || proof.provider !== 'zcode' || proof.contextDigest !== ref.contextDigest || proof.threadId !== identity.threadId || proof.turnId !== identity.turnId
    || !digest(proof.witnessDigest) || !digest(proof.historyDigest) || identity.inputId !== undefined && proof.inputId !== identity.inputId || identity.prompt !== undefined && proof.promptDigest !== sha(identity.prompt)) stale('proof differs from the exact context/session/turn/input')
  if (expectedModel && (proof.providerId !== expectedModel.providerId || proof.modelId !== expectedModel.modelId || expectedModel.cliVersion !== undefined && proof.cliVersion !== expectedModel.cliVersion || expectedModel.cliSha256 !== undefined && proof.cliSha256 !== expectedModel.cliSha256)) stale('proof differs from its fixed model/CLI')
  const bytes = readFileSync(witnessPath(ref, proof.witnessDigest)), history = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.historyDigest))
  if (sha(bytes) !== proof.witnessDigest || sha(history) !== proof.historyDigest) stale('saved witness or normalized history digest differs')
  const witness = JSON.parse(bytes.toString('utf8')) as ZCodeFrozenWitness
  const actual = proveZCodeFrozenReads(ref, witness)
  if (expectedModel?.options?.reasoningLevel !== undefined) {
    const user = witness.messages.find(message => message.info.role === 'user' && message.info.synthetic !== true)!
    if (record(record(user.info.modelSelection).options).reasoningLevel !== expectedModel.options.reasoningLevel) stale('original real user reasoning level differs from the fixed model options')
  }
  if (result) {
    const response = witness.events.find(event => event.type === 'turn.completed')!.payload.response as string
    let output: unknown
    try { output = JSON.parse(decodeZCodeJsonText(response)) }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; stale('authoritative native response is not one JSON value') }
    if (!isDeepStrictEqual(output, result.output)) stale('result differs from its authoritative native response')
  }
  if (!isDeepStrictEqual(actual, proof)) stale('proof differs from its authoritative native witness')
}
