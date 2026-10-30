import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StructuredSessionError, StructuredSessionTransportError } from './session-structured-policy.js'

export const FROZEN_READER_POLICY = 'codex-frozen-read-only-v2' as const
export const FROZEN_READ_TOOL = 'spex_read_frozen' as const
export const FROZEN_READ_MAX_BYTES = 262_144
export const FROZEN_PROMPT_THRESHOLD_BYTES = 512 * 1024
export type FrozenContextBinding = { requestKey: string; inputDigest: string; policyDigest?: string; attemptId?: string }
export type FrozenEntry = { id: string; label: string; kind: 'utf8' | 'binary' | 'absent'; sha256: string; byteLength: number; required: boolean }
export type FrozenContextManifest = { version: 1; binding: FrozenContextBinding; entries: FrozenEntry[] }
/** 路径仅供可信控制面使用，不能进入模型 prompt 或工具参数。 */
export type FrozenContextRef = { version: 1; contextDigest: string; manifestPath: string }
export type FrozenContextInput = { id: string; label: string; required?: boolean } & ({ kind: 'utf8' | 'binary'; bytes: Buffer } | { kind: 'absent' })
/** 可经 JSON 拷贝的通用冻结条目；字节在冻结时才物化，避免 Buffer 被拷贝成普通对象。 */
export type FrozenEntryJson = { id: string; label: string; required?: boolean } & ({ kind: 'utf8'; text: string } | { kind: 'binary'; base64: string } | { kind: 'absent' })
export type FrozenReadArguments = { contextDigest: string; entryId: string; startByte: number; endByte: number }
export type FrozenReadReceipt = { threadId: string; turnId: string; callId: string; arguments: FrozenReadArguments; responseDigest: string }
type FrozenCoverageProof = { contextDigest: string; threadId: string; turnId: string; receipts: FrozenReadReceipt[]; coveredEntryIds: string[]; historyDigest: string }
export type FrozenReadProof = FrozenCoverageProof & ({ version?: never } | { version: 2; visibilityDigest: string; toolOutputTokenLimit: number } | { version: 3; provider: 'claude-code'; promptId: string; model: string; cliVersion: string; maxReadBytes: 65536; maxResultSizeChars: 500000 })
export type ClaudePublicMessage = { role: string; content: Array<{ type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | Array<{ type: string; text: string }>; text?: string; is_error?: boolean }> }
type ClaudeCompaction = { runningTurnSends: { uuids: string[]; openerUuid: string }; preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string }; preservedMessages?: { anchorUuid: string; uuids: string[]; allUuids: string[] } }
export type ClaudePublicRecord = { type: string; sessionId: string; uuid?: string; parentUuid?: string | null; promptId?: string; requestRef?: string; sourceToolAssistantUUID?: string; message?: ClaudePublicMessage; id?: string; hash?: string; shapeHash?: string; base?: string; keep?: number; tail?: string[]; model?: string; toolNames?: string[]; placeholderValid?: boolean
  subtype?: string; logicalParentUuid?: string; compactMetadata?: ClaudeCompaction
  compactSummary?: { transcriptOnly: boolean; promptUuids?: string[]; messageDigest: string; textOnly: boolean }
  compactSummaryDigest?: string
}
export type ClaudeFrozenWitness = { version: 1; provider: 'claude-code'; cliVersion: string; model: string; sessionId: string; userUuid: string; promptId: string; prompt: string; nativeHistoryPath: string; history: ClaudePublicRecord[]; mcpHistory?: { path: string; toolNames: string[] }; echo: { uuid: string; session_id: string; message: ClaudePublicMessage }; result: { type: string; subtype: string; is_error: boolean; session_id: string; uuid: string; user_message_uuid: string; user_message_uuids: string[]; structured_output: unknown }; initTools: string[] }
export type FrozenVisibleOutput = { callId: string; output: string | { type: 'input_text'; text: string }[]; historyTokenLimit: number }
type FrozenVisibility = { toolOutputTokenLimit: number; outputs: FrozenVisibleOutput[] }
export type FrozenNativeItem = { type: string; id?: string; namespace?: string | null; tool?: string; arguments?: unknown; status?: string; success?: boolean | null; contentItems?: unknown }
export type FrozenToolResponse = { contentItems: { type: 'inputText'; text: string }[]; success: true }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')
function stale(message: string): never { throw new StructuredSessionError('stale_result', message) }
const bytesPath = (ref: FrozenContextRef, hash: string): string => join(dirname(ref.manifestPath), 'bytes', hash)
function isFrozenVisibleOutput(value: unknown): value is FrozenVisibleOutput['output'] {
  return typeof value === 'string' || Array.isArray(value) && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item) && item.type === 'input_text' && typeof item.text === 'string')
}
function frozenVisibleTexts(output: FrozenVisibleOutput['output']): string[] {
  return typeof output === 'string' ? [output] : output.map(item => item.text)
}
function frozenVisibleTokenCost(output: FrozenVisibleOutput['output']): number {
  return frozenVisibleTexts(output).reduce((cost, text) => cost + Math.ceil(Buffer.byteLength(text, 'utf8') / 4), 0)
}

/** 将调用者已冻结的字节写入源码树之外的私有内容寻址存储。 */
export function freezeContext(input: { directory: string; sourceRoot: string; binding: FrozenContextBinding; entries: readonly FrozenContextInput[] }): FrozenContextRef {
  const directory = resolve(input.directory), source = realpathSync(input.sourceRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const location = realpathSync(directory), rel = relative(source, location)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) stale('frozen context storage must be outside the source tree')
  if (!input.binding.requestKey || !input.binding.inputDigest) stale('frozen context requires exact request and input binding')
  const root = mkdtempSync(join(location, 'frozen-')); chmodSync(root, 0o700)
  mkdirSync(join(root, 'bytes'), { mode: 0o700 }); mkdirSync(join(root, 'responses'), { mode: 0o700 }); mkdirSync(join(root, 'histories'), { mode: 0o700 })
  const ids = new Set<string>(), entries: FrozenEntry[] = []
  for (const entry of input.entries) {
    if (!entry.id || ids.has(entry.id) || !entry.label) stale('frozen entries require unique nonempty identities and labels')
    ids.add(entry.id)
    const bytes = entry.kind === 'absent' ? Buffer.alloc(0) : entry.bytes
    if (entry.kind === 'utf8') new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const hash = sha(bytes)
    if (!existsSync(join(root, 'bytes', hash))) writeFileSync(join(root, 'bytes', hash), bytes, { mode: 0o400 })
    entries.push({ id: entry.id, label: entry.label, kind: entry.kind, sha256: hash, byteLength: bytes.length, required: entry.required ?? true })
  }
  const manifest: FrozenContextManifest = { version: 1, binding: { ...input.binding }, entries }
  const bytes = encode(manifest), contextDigest = sha(bytes), destination = join(location, contextDigest)
  writeFileSync(join(root, 'manifest.json'), bytes, { mode: 0o400 })
  try { renameSync(root, destination) }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    if (sha(readFileSync(join(destination, 'manifest.json'))) !== contextDigest) stale('existing frozen context has different manifest bytes')
    rmSync(root, { recursive: true })
  }
  return { version: 1, contextDigest, manifestPath: join(destination, 'manifest.json') }
}

function frozenEntryInputs(entries: readonly FrozenEntryJson[]): FrozenContextInput[] {
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) stale('frozen entry must be pure JSON')
    if (entry.kind === 'utf8') {
      if (typeof entry.text !== 'string') stale('utf8 frozen entry requires text')
      return { id: entry.id, label: entry.label, required: entry.required, kind: 'utf8', bytes: Buffer.from(entry.text, 'utf8') }
    }
    if (entry.kind === 'binary') {
      if (typeof entry.base64 !== 'string' || entry.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) stale('binary frozen entry requires canonical base64')
      const bytes = Buffer.from(entry.base64, 'base64')
      if (bytes.toString('base64') !== entry.base64) stale('binary frozen entry requires canonical base64')
      return { id: entry.id, label: entry.label, required: entry.required, kind: 'binary', bytes }
    }
    if (entry.kind === 'absent') return { id: entry.id, label: entry.label, required: entry.required, kind: 'absent' }
    stale('frozen entry kind is invalid')
  })
}

/** 在任何派发摘要之前冻结超大正文或调用者给出的纯 JSON 条目；同键同内容返回同一个稳定引用。已有 ref 原样返回。 */
export function prepareFrozenPrompt<T extends { root: string; prompt: string; requestKey: string; inputDigest: string; model?: string; frozenContext?: FrozenContextRef; frozenEntries?: readonly FrozenEntryJson[] }>(request: T, options: { directory: string; binding?: Pick<FrozenContextBinding, 'policyDigest' | 'attemptId'> }): Omit<T, 'frozenEntries'> & { frozenContext?: FrozenContextRef } {
  const binding = { requestKey: request.requestKey, inputDigest: request.inputDigest, ...options.binding }
  if (request.frozenContext) { assertFrozenBinding(request.frozenContext, binding); return request }
  const declared = request.frozenEntries ?? []
  const promptBytes = Buffer.byteLength(request.prompt, 'utf8')
  const claude = request.model?.startsWith('claude:') === true
  if (!claude && declared.length === 0 && promptBytes <= FROZEN_PROMPT_THRESHOLD_BYTES) return request
  const entries = frozenEntryInputs(declared)
  if (claude || promptBytes > FROZEN_PROMPT_THRESHOLD_BYTES) entries.unshift({ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8', bytes: Buffer.from(request.prompt, 'utf8'), required: true })
  const frozenContext = freezeContext({ directory: options.directory, sourceRoot: request.root, binding, entries })
  const prompt = claude ? `Read every required frozen entry completely using mcp__frozen__spex_read_frozen. Entry task contains the original instructions. Follow those instructions after reading. Each call reads at most 65536 original bytes; continue from original endByte, never decodedEndByte. Do not use files, shell, discovery, subagents, or other tools. Return the requested structured answer through StructuredOutput.\n${claudeFrozenContextPrompt(frozenContext)}` : promptBytes > FROZEN_PROMPT_THRESHOLD_BYTES
    ? `The complete original task, instructions, and context are frozen without truncation in entry task. Read its entire required content using ${FROZEN_READ_TOOL}, then follow that original task and return its requested structured final answer. Byte offsets are end-exclusive; continue from the response's original endByte, never decodedEndByte. No shell, paths or live data are available.\n${frozenContextPrompt(frozenContext)}`
    : `${request.prompt}\n${frozenContextPrompt(frozenContext)}`
  const { frozenEntries: _entries, ...rest } = request
  return { ...rest, prompt, frozenContext }
}

/** 只从内容摘要已锚定的清单恢复条目，不读取 live source 或模型提供的路径。 */
export function readFrozenManifest(ref: FrozenContextRef): FrozenContextManifest {
  if (ref.version !== 1 || !/^[a-f0-9]{64}$/.test(ref.contextDigest) || !ref.manifestPath) stale('invalid frozen context reference')
  if ((statSync(dirname(ref.manifestPath)).mode & 0o077) !== 0) stale('frozen context storage is not private')
  const bytes = readFileSync(ref.manifestPath)
  if (sha(bytes) !== ref.contextDigest) stale('frozen context manifest digest differs from its immutable reference')
  const manifest = JSON.parse(bytes.toString('utf8')) as FrozenContextManifest
  if (manifest.version !== 1 || !manifest.binding?.requestKey || !manifest.binding.inputDigest || !Array.isArray(manifest.entries)) stale('invalid frozen context manifest')
  for (const entry of manifest.entries)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || !['utf8', 'binary', 'absent'].includes(entry.kind)) stale('invalid frozen context entry')
  return manifest
}

export function assertFrozenBinding(ref: FrozenContextRef, expected: FrozenContextBinding): void {
  const binding = readFrozenManifest(ref).binding
  for (const key of ['requestKey', 'inputDigest', 'policyDigest', 'attemptId'] as const)
    if (binding[key] !== expected[key]) stale(`frozen context ${key} differs from its exact request binding`)
}

type FrozenReadPlanRange = { startByte: number; endByte: number }
type FrozenReadBatch = { entryId: string; ranges: FrozenReadPlanRange[] }

function serializeFrozenRange(entry: FrozenEntry, args: FrozenReadArguments, bytes: Buffer): { arguments: FrozenReadArguments; response: FrozenToolResponse } {
  const range = bytes.subarray(args.startByte, args.endByte)
  let decodedStartByte = args.startByte, decodedEndByte = args.endByte
  if (entry.kind === 'utf8') {
    while (decodedStartByte > 0 && (bytes[decodedStartByte] & 0xc0) === 0x80) decodedStartByte--
    while (decodedEndByte < bytes.length && (bytes[decodedEndByte] & 0xc0) === 0x80) decodedEndByte++
  }
  const expanded = decodedStartByte !== args.startByte || decodedEndByte !== args.endByte
  const content = entry.kind === 'utf8' ? { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: expanded }).decode(bytes.subarray(decodedStartByte, decodedEndByte)),
    ...(expanded ? { decodedStartByte, decodedEndByte } : {}) }
    : entry.kind === 'binary' ? { base64: range.toString('base64') } : { absent: true }
  const text = JSON.stringify({ ...args, kind: entry.kind, sha256: entry.sha256, byteLength: entry.byteLength, rangeSha256: sha(range), ...content })
  return { arguments: { ...args }, response: { contentItems: [{ type: 'inputText', text }], success: true } }
}

function frozenReadOutputTokenLimitForEntries(ref: FrozenContextRef, entries: readonly FrozenEntry[]): number {
  let maximumBytes = 1
  for (const entry of entries) {
    const args = { contextDigest: ref.contextDigest, entryId: entry.id, startByte: entry.byteLength, endByte: entry.byteLength }
    const metadata = { ...args, kind: entry.kind, sha256: entry.sha256, byteLength: entry.byteLength, rangeSha256: entry.sha256 }
    const rangeBytes = Math.min(entry.byteLength, FROZEN_READ_MAX_BYTES)
    const bytes = entry.kind === 'utf8'
      ? encode({ ...metadata, text: '', decodedStartByte: entry.byteLength, decodedEndByte: entry.byteLength }).length + 6 * (rangeBytes + 6)
      : entry.kind === 'binary' ? encode({ ...metadata, base64: '' }).length + 4 * Math.ceil(rangeBytes / 3)
        : encode({ ...metadata, absent: true }).length
    maximumBytes = Math.max(maximumBytes, bytes)
  }
  return Math.max(10_000, Math.ceil(maximumBytes / 4))
}

function frozenReadBatches(ref: FrozenContextRef, entries: readonly FrozenEntry[], tokenLimit: number, maxReadBytes = FROZEN_READ_MAX_BYTES): FrozenReadBatch[] {
  const verifiedBytes = new Map<string, Buffer>(), plannedContent = new Set<string>(), batches: FrozenReadBatch[] = []
  for (const entry of entries) {
    if (!entry.required) continue
    const contentKey = `${entry.kind}:${entry.sha256}:${entry.byteLength}`
    if (plannedContent.has(contentKey)) continue
    plannedContent.add(contentKey)
    let bytes = verifiedBytes.get(entry.sha256)
    if (!bytes) {
      bytes = readFileSync(bytesPath(ref, entry.sha256))
      if (bytes.length !== entry.byteLength || sha(bytes) !== entry.sha256) stale('frozen entry bytes differ from their immutable digest')
      verifiedBytes.set(entry.sha256, bytes)
    }
    if (bytes.length !== entry.byteLength) stale('frozen entry bytes differ from their immutable digest')
    const ranges: FrozenReadPlanRange[] = [], costs: number[] = []
    for (let startByte = 0; entry.byteLength === 0 ? startByte === 0 : startByte < entry.byteLength;) {
      const endByte = Math.min(entry.byteLength, startByte + maxReadBytes)
      const args = { contextDigest: ref.contextDigest, entryId: entry.id, startByte, endByte }
      const response = serializeFrozenRange(entry, args, bytes).response.contentItems[0].text
      ranges.push({ startByte, endByte })
      costs.push(Math.ceil(Buffer.byteLength(response, 'utf8') / 4))
      if (entry.byteLength === 0) break
      startByte = endByte
    }
    for (let index = 0; index < ranges.length;) {
      const paired = ranges[index + 1] !== undefined && costs[index] + costs[index + 1] <= tokenLimit
      batches.push({ entryId: entry.id, ranges: paired ? [ranges[index], ranges[index + 1]!] : [ranges[index]] })
      index += paired ? 2 : 1
    }
  }
  return batches
}

/** 模型索引只含冻结条目元数据与由冻结正文派生的有界读取计划，不泄露控制面路径。 */
export function frozenContextPrompt(ref: FrozenContextRef): string {
  const manifest = readFrozenManifest(ref)
  const toolOutputTokenLimit = frozenReadOutputTokenLimitForEntries(ref, manifest.entries)
  return JSON.stringify({ tool: FROZEN_READ_TOOL, contextDigest: ref.contextDigest, maxReadBytes: FROZEN_READ_MAX_BYTES,
    toolOutputTokenLimit, execMaxOutputTokens: Math.ceil(toolOutputTokenLimit * 1.2), entries: manifest.entries,
    readBatches: frozenReadBatches(ref, manifest.entries, toolOutputTokenLimit) })
}

/** Claude直接调用同一reader；字符上限独立于Codex的exec与token证明。 */
export function claudeFrozenContextPrompt(ref: FrozenContextRef): string {
  const manifest = readFrozenManifest(ref)
  return JSON.stringify({ tool: 'mcp__frozen__spex_read_frozen', contextDigest: ref.contextDigest, maxReadBytes: 65536, maxResultSizeChars: 500000,
    rangeRule: 'Copy each planned startByte/endByte exactly. 65536 is only a maximum span, never the end of a shorter entry. Never exceed entry.byteLength.',
    entries: manifest.entries, readBatches: frozenReadBatches(ref, manifest.entries, 0, 65536) })
}

/** 按冻结清单的真实元数据和最坏 JSON 转义，界定单个模型可见 inputText 的固定预算。 */
export function frozenReadOutputTokenLimit(ref: FrozenContextRef): number {
  const manifest = readFrozenManifest(ref)
  // Codex 0.160.0 charges ceil(inputText UTF-8 bytes / 4); the exec allowance adds its existing 20% margin.
  return frozenReadOutputTokenLimitForEntries(ref, manifest.entries)
}

export const frozenReadTool = {
  type: 'function', name: FROZEN_READ_TOOL,
  description: 'Read immutable frozen context only. The index readBatches are a plan, not extra authorization: read every required unique content fully, using one exec per planned batch and at most its two listed adjacent ranges. Set each exec first-line // @exec: {"max_output_tokens": H} with H = execMaxOutputTokens from the index; call each listed read in order and print every returned string verbatim with its own text(await tools.spex_read_frozen(...)) call. If exec returns Script running with cell ID, do not rerun any read or advance the batch; call wait with {cell_id, yield_time_ms: 10000, max_tokens: H}, repeat with the same cell_id if still running, and wait for Script completed before continuing. A running marker is not read content; use the completed wait output, preserving each full text item. Optional entries remain available for reads as needed. Byte ranges are end-exclusive. Continue with startByte equal to the response original endByte; decodedStartByte/decodedEndByte only describe UTF-8 display expansion and are never cursors. No paths, live files, shell, or network are available.',
  inputSchema: { type: 'object', properties: { contextDigest: { type: 'string' }, entryId: { type: 'string' }, startByte: { type: 'integer', minimum: 0 }, endByte: { type: 'integer', minimum: 0 } }, required: ['contextDigest', 'entryId', 'startByte', 'endByte'], additionalProperties: false },
} as const

/** 校验系统边界的工具参数，并生成可由原生历史逐字节复核的唯一返回值。 */
export function readFrozenRange(ref: FrozenContextRef, value: unknown): { arguments: FrozenReadArguments; response: FrozenToolResponse } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) stale('frozen reader requires an argument object')
  const args = value as FrozenReadArguments
  if (Object.keys(args).sort().join(',') !== 'contextDigest,endByte,entryId,startByte' || args.contextDigest !== ref.contextDigest || typeof args.entryId !== 'string') stale('frozen reader context identity or argument shape differs')
  const entry = readFrozenManifest(ref).entries.find(item => item.id === args.entryId)
  if (!entry) stale('frozen reader entry is not in this context')
  if (!Number.isSafeInteger(args.startByte) || !Number.isSafeInteger(args.endByte) || args.startByte < 0 || args.endByte < args.startByte || args.endByte > entry.byteLength || args.endByte - args.startByte > FROZEN_READ_MAX_BYTES || (entry.byteLength > 0 && args.endByte === args.startByte)) stale('frozen reader range is invalid or exceeds its bounded response')
  const bytes = readFileSync(bytesPath(ref, entry.sha256))
  if (bytes.length !== entry.byteLength || sha(bytes) !== entry.sha256) stale('frozen entry bytes differ from their immutable digest')
  return serializeFrozenRange(entry, args, bytes)
}

/** 在发送RPC回复前持久保存真实返回字节；RPC id不作为可恢复的调用身份。 */
export function persistFrozenRead(ref: FrozenContextRef, identity: { threadId: string; turnId: string; callId: string }, value: unknown): { receipt: FrozenReadReceipt; response: FrozenToolResponse } {
  const { arguments: args, response } = readFrozenRange(ref, value)
  const bytes = encode(response), responseDigest = sha(bytes)
  const path = join(dirname(ref.manifestPath), 'responses', responseDigest)
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== responseDigest) stale('persisted frozen response bytes were modified')
  return { receipt: { ...identity, arguments: args, responseDigest }, response }
}

/** 仅提取精确 turn 中真实配对的公开 exec/wait 回复；不把完整rollout等同于模型实际可见的history。 */
export function frozenVisibleOutputs(rollout: string, turnId: string): FrozenVisibleOutput[] {
  if (!rollout.endsWith('\n')) throw new StructuredSessionTransportError('exact frozen visible rollout has not flushed its final record yet')
  let currentTurn: string | undefined, completed = false
  const calls = new Map<string, 'custom' | 'function'>(), outputs: FrozenVisibleOutput[] = [], returned = new Set<string>()
  for (const line of rollout.split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string; call_id?: string; name?: string; output?: unknown }; metadata?: { fallback_token_limit_override?: number } }
    const payload = record.payload
    if (record.type === 'turn_context' || record.type === 'event_msg' && payload?.type === 'task_started') currentTurn = payload?.turn_id
    if (record.type === 'event_msg' && payload?.type === 'task_complete' && payload.turn_id === turnId) {
      if (currentTurn !== turnId) stale('frozen visible completion does not belong to the active exact turn')
      completed = true; currentTurn = undefined
    }
    if (currentTurn !== turnId || record.type !== 'response_item') continue
    if (payload?.type === 'custom_tool_call' || payload?.type === 'function_call') {
      const expectedName = payload.type === 'custom_tool_call' ? 'exec' : 'wait'
      if (payload.name !== expectedName || !payload.call_id || calls.has(payload.call_id)) stale('frozen visible history contains an invalid or repeated host call')
      calls.set(payload.call_id, payload.type === 'custom_tool_call' ? 'custom' : 'function')
    } else if (payload?.type === 'custom_tool_call_output' || payload?.type === 'function_call_output') {
      const outputKind = payload.type === 'custom_tool_call_output' ? 'custom' : 'function'
      if (!payload.call_id || calls.get(payload.call_id) !== outputKind || returned.has(payload.call_id) || !isFrozenVisibleOutput(payload.output)
        || !Number.isSafeInteger(record.metadata?.fallback_token_limit_override) || record.metadata!.fallback_token_limit_override! <= 0)
        stale('frozen visible output is not bound to its exact exec/wait call and history budget')
      returned.add(payload.call_id)
      outputs.push({ callId: payload.call_id, output: payload.output, historyTokenLimit: record.metadata!.fallback_token_limit_override! })
    }
  }
  if (!completed) throw new StructuredSessionTransportError('exact frozen visible rollout has not persisted its completed turn yet')
  if (returned.size !== calls.size) stale('frozen visible history contains an exec call without its output')
  return outputs
}

/** 校验所有外层文本的真实预算，并逐项证明内层冻结正文原样进入模型可见回复。 */
function checkFrozenVisibility(ref: FrozenContextRef, visibility: FrozenVisibility, responses: string[]): void {
  if (visibility.toolOutputTokenLimit !== frozenReadOutputTokenLimit(ref)) stale('frozen visible proof differs from the fixed response budget')
  const callIds = new Set<string>(), texts = new Set<string>()
  for (const outer of visibility.outputs) {
    if (!outer.callId || callIds.has(outer.callId) || !isFrozenVisibleOutput(outer.output)
      || outer.historyTokenLimit !== Math.ceil(visibility.toolOutputTokenLimit * 1.2)
      || frozenVisibleTokenCost(outer.output) > outer.historyTokenLimit)
      stale('frozen outer output exceeds or differs from its actual fixed history budget')
    callIds.add(outer.callId)
    for (const text of frozenVisibleTexts(outer.output)) texts.add(text)
  }
  if (responses.some(text => !texts.has(text))) stale('frozen response was not returned verbatim in the exact model-visible exec output')
}

/** 以精确原生turn的真实arguments和result重建coverage；不信模型声明或本地回执。 */
export function proveFrozenReads(ref: FrozenContextRef, identity: { threadId: string; turnId: string }, items: readonly FrozenNativeItem[], visibility?: FrozenVisibility): FrozenReadProof {
  const receipts: FrozenReadReceipt[] = [], ids = new Set<string>()
  const responses: string[] = []
  for (const item of items) {
    if (item.type !== 'dynamicToolCall') continue
    if (!item.id || ids.has(item.id) || item.tool !== FROZEN_READ_TOOL || item.namespace != null || item.status !== 'completed' || item.success !== true) stale('exact frozen turn contains an invalid, pending or foreign dynamic tool call')
    ids.add(item.id)
    const { arguments: args, response } = readFrozenRange(ref, item.arguments)
    if (JSON.stringify(item.contentItems) !== JSON.stringify(response.contentItems)) stale('native frozen read result bytes differ from the immutable entry')
    responses.push(response.contentItems[0].text)
    const { receipt } = persistFrozenRead(ref, { ...identity, callId: item.id }, args)
    receipts.push(receipt)
  }
  const coveredEntryIds = frozenReadCoverage(ref, receipts)
  const history = encode(items), historyDigest = sha(history), historyPath = join(dirname(ref.manifestPath), 'histories', historyDigest)
  if (!existsSync(historyPath)) writeFileSync(historyPath, history, { mode: 0o400 })
  else if (sha(readFileSync(historyPath)) !== historyDigest) stale('persisted native frozen history was modified')
  const proof = { contextDigest: ref.contextDigest, ...identity, receipts, coveredEntryIds, historyDigest }
  if (!visibility) return proof
  checkFrozenVisibility(ref, visibility, responses)
  const visible = encode({ ...identity, ...visibility }), visibilityDigest = sha(visible), visiblePath = join(dirname(ref.manifestPath), 'histories', visibilityDigest)
  if (!existsSync(visiblePath)) writeFileSync(visiblePath, visible, { mode: 0o400 })
  else if (sha(readFileSync(visiblePath)) !== visibilityDigest) stale('persisted frozen visible history was modified')
  return { ...proof, version: 2, visibilityDigest, toolOutputTokenLimit: visibility.toolOutputTokenLimit }
}

/** 所有执行器共享原requested字节覆盖，原生见证格式由各执行器单独核验。 */
export function frozenReadCoverage(ref: FrozenContextRef, receipts: readonly FrozenReadReceipt[]): string[] {
  const manifest = readFrozenManifest(ref), ranges = new Map<string, [number, number][]>()
  for (const receipt of receipts) {
    const args = receipt.arguments, entry = manifest.entries.find(entry => entry.id === args.entryId)!
    const key = `${entry.kind}:${entry.sha256}:${entry.byteLength}`
    const intervals = ranges.get(key) ?? []; intervals.push([args.startByte, args.endByte]); ranges.set(key, intervals)
  }
  const coveredEntryIds: string[] = []
  for (const entry of manifest.entries) {
    const intervals = ranges.get(`${entry.kind}:${entry.sha256}:${entry.byteLength}`)?.sort((a, b) => a[0] - b[0])
    let end = 0
    for (const range of intervals ?? []) { if (range[0] > end) break; end = Math.max(end, range[1]) }
    if (intervals?.length && end === entry.byteLength) coveredEntryIds.push(entry.id)
    else if (entry.required) stale(`required frozen entry ${entry.id} was not completely read in this exact native turn`)
  }
  return coveredEntryIds
}

/** 与Claude原生api-request.tail一致的递归键排序消息摘要；不触及私密推理。 */
export function claudeMessageDigest(value: unknown): string {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item !== null && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted((item as Record<string, unknown>)[key])])) : item
  return sha(encode(sorted(value)))
}

/** 只提取本专属session的公开调用、回复、主链身份和实际API索引；推理正文与签名不进入证据。 */
export function readClaudePublicHistory(path: string, sessionId: string): ClaudePublicRecord[] {
  const source = readFileSync(path, 'utf8')
  if (!source.endsWith('\n')) throw new StructuredSessionTransportError('Claude native history has not flushed its final record')
  const records: ClaudePublicRecord[] = []
  for (const line of source.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as Record<string, unknown> & { message?: ClaudePublicMessage; shape?: { tools: { name: string; description?: string; input_schema?: unknown; defer_loading?: boolean }[] }; params?: { model: string } }
    const compact = row.type === 'system' && row.subtype === 'compact_boundary'
    if (!compact && !['user', 'assistant', 'attachment', 'api-request', 'api-request-shape', 'api-request-blob'].includes(String(row.type))) continue
    if (row.type === 'api-request-blob' && row.message?.role !== 'user') continue
    if (row.sessionId !== sessionId || row.isSidechain === true) stale('Claude history contains a foreign session or sidechain')
    const record = Object.fromEntries(['type', 'sessionId', 'uuid', 'parentUuid', 'promptId', 'requestRef', 'sourceToolAssistantUUID'].filter(key => key in row).map(key => [key, row[key]])) as ClaudePublicRecord
    if (compact) {
      const metadata = row.compactMetadata as ClaudeCompaction | undefined
      Object.assign(record, { subtype: row.subtype, logicalParentUuid: row.logicalParentUuid, compactMetadata: metadata && { runningTurnSends: metadata.runningTurnSends, ...(metadata.preservedSegment !== undefined ? { preservedSegment: metadata.preservedSegment } : {}), ...(metadata.preservedMessages !== undefined ? { preservedMessages: metadata.preservedMessages } : {}) } })
    }
    if (row.type === 'user') {
      if (row.isCompactSummary === true) {
        const content: unknown = row.message?.content
        record.compactSummary = { transcriptOnly: row.isVisibleInTranscriptOnly === true, promptUuids: row.summarizedTurnPromptUuids as string[] | undefined, messageDigest: claudeMessageDigest(row.message), textOnly: row.message?.role === 'user' && (typeof content === 'string' ? content.length > 0 : Array.isArray(content) && content.length > 0 && content.every(block => block?.type === 'text' && typeof block.text === 'string')) }
      } else record.message = row.message
    }
    if (row.type === 'api-request-blob') {
      const content: unknown = row.message!.content
      record.message = typeof content === 'string' ? { ...row.message!, content: [{ type: 'text', text: content }] } : row.message
      if (typeof content === 'string') record.compactSummaryDigest = claudeMessageDigest(row.message)
      record.hash = String(row.hash)
    }
    if (row.type === 'assistant') record.message = { role: 'assistant', content: row.message!.content.filter(block => block.type === 'tool_use') }
    if (row.type === 'api-request') Object.assign(record, { id: row.id, shapeHash: row.shapeHash, base: row.base, keep: row.keep, tail: row.tail, model: row.params!.model })
    if (row.type === 'api-request-shape') {
      record.shapeHash = String(row.shapeHash)
      record.toolNames = row.shape!.tools.map(tool => tool.name)
      record.placeholderValid = row.shape!.tools.filter(tool => tool.name === 'DeferredToolPlaceholder').every(tool => tool.description === 'Reserved placeholder that keeps deferred tool loading active; never call this tool.' && tool.defer_loading === true && claudeMessageDigest(tool.input_schema) === claudeMessageDigest({ type: 'object', properties: {} }))
    }
    records.push(record)
  }
  return records
}

/** 只读取专属 MCP 的实际派发名；原生不可用工具回复不能掩盖服务端派发的矛盾证据。 */
export function readClaudeMcpToolNames(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    const row = JSON.parse(line) as { type: string; request?: { method: string; params?: { name?: string } } }
    if (row.type !== 'request' || row.request?.method !== 'tools/call') return []
    if (typeof row.request.params?.name !== 'string') stale('Claude MCP call has no exact tool identity')
    return [row.request.params.name]
  })
}

/** Claude用原生user UUID/promptId、配对公开消息及真实API请求索引证明可见性，绝不冒充Codex动态工具。 */
export function proveClaudeFrozenReads(ref: FrozenContextRef, witness: ClaudeFrozenWitness): FrozenReadProof {
  const { sessionId, userUuid, promptId, model, result, echo, history } = witness
  const allowed = ['StructuredOutput', 'mcp__frozen__spex_read_frozen']
  if (witness.version !== 1 || witness.provider !== 'claude-code' || witness.cliVersion !== '2.1.309 (Claude Code)' || !model || !promptId
    || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || result.structured_output === undefined
    || result.session_id !== sessionId || result.user_message_uuid !== userUuid || JSON.stringify(result.user_message_uuids) !== JSON.stringify([userUuid])
    || echo.uuid !== userUuid || echo.session_id !== sessionId || JSON.stringify([...witness.initTools].sort()) !== JSON.stringify([...allowed].sort())) stale('Claude completion lacks exact native identity or isolated capabilities')
  const original = history.find(row => row.type === 'user' && row.uuid === userUuid)
  if (!original || original.parentUuid !== null || original.promptId !== promptId || JSON.stringify(original.message) !== JSON.stringify(echo.message)
    || JSON.stringify(original.message) !== JSON.stringify({ role: 'user', content: [{ type: 'text', text: witness.prompt }] })) stale('Claude original user echo/history/prompt identity differs')
  const seen = new Set<string>(), requests = new Map<string, string[]>(), shapes = new Set<string>(), calls = new Map<string, { row: ClaudePublicRecord; block: ClaudePublicMessage['content'][number] }>()
  const parents = new Map<string, string | null>()
  const compactSummaries = new Set<string>()
  let latestMessage: string | undefined, compaction: { ancestors: Set<string>; anchor?: string } | undefined
  const receipts: FrozenReadReceipt[] = [], rejectedCalls: string[] = [], responseMessages = new Map<string, string>(), responseBlocks = new Map<string, ClaudePublicMessage['content'][number]>(), requestRefs = new Set<string>()
  if (witness.mcpHistory && (JSON.stringify(readClaudeMcpToolNames(witness.mcpHistory.path)) !== JSON.stringify(witness.mcpHistory.toolNames) || witness.mcpHistory.toolNames.some(name => name !== 'spex_read_frozen'))) stale('Claude MCP dispatched a foreign tool or its actual history changed')
  let acceptedOutput = false
  for (const row of history) {
    if (row.sessionId !== sessionId) stale('Claude native history changed its session identity')
    const compact = row.type === 'system' && row.subtype === 'compact_boundary'
    if (row.type === 'system' && !compact) stale('Claude public system event is not a supported compact boundary')
    if (compact) {
      const metadata = row.compactMetadata, segment = metadata?.preservedSegment, preserved = metadata?.preservedMessages
      if (!row.uuid || seen.has(row.uuid) || row.parentUuid !== null || !row.logicalParentUuid || row.logicalParentUuid !== latestMessage || !seen.has(row.logicalParentUuid) || compaction
        || metadata?.runningTurnSends?.openerUuid !== userUuid || JSON.stringify(metadata.runningTurnSends.uuids) !== JSON.stringify([userUuid])) stale('Claude compact boundary lost its exact running turn or logical parent')
      if (segment !== undefined || preserved !== undefined) {
        const ids = preserved?.allUuids
        if (!segment || !preserved || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || JSON.stringify(preserved.uuids) !== JSON.stringify(ids)
          || segment.headUuid !== ids[0] || segment.tailUuid !== ids.at(-1) || segment.tailUuid !== row.logicalParentUuid
          || !segment.anchorUuid || segment.anchorUuid !== preserved.anchorUuid || seen.has(segment.anchorUuid)
          || ids.some((id, index) => !seen.has(id) || index > 0 && parents.get(id) !== ids[index - 1])) stale('Claude compact preserved segment is not the exact observed chain')
      }
      compaction = { ancestors: new Set([row.uuid]), ...(segment ? { anchor: segment.anchorUuid } : {}) }
      parents.set(row.uuid, row.logicalParentUuid); seen.add(row.uuid)
      continue
    }
    if (row.uuid) {
      if (seen.has(row.uuid) || row.uuid !== userUuid && (!row.parentUuid || !seen.has(row.parentUuid))) stale('Claude public history is not the exact original main chain')
      seen.add(row.uuid); parents.set(row.uuid, row.parentUuid ?? null)
    }
    if (compaction && row.type === 'attachment') {
      if (!row.uuid || !row.parentUuid || !compaction.ancestors.has(row.parentUuid)) stale('Claude compact attachment is outside its exact boundary')
      compaction.ancestors.add(row.uuid)
    }
    if (row.compactSummary) {
      const summary = row.compactSummary
      if (row.type !== 'user' || !row.uuid || !row.parentUuid || !compaction?.ancestors.has(row.parentUuid) || compaction.anchor && compaction.anchor !== row.uuid
        || row.promptId !== promptId || row.sourceToolAssistantUUID !== undefined || !summary.transcriptOnly || !summary.textOnly
        || !/^[a-f0-9]{64}$/.test(summary.messageDigest) || JSON.stringify(summary.promptUuids) !== JSON.stringify([userUuid])) stale('Claude compact summary is not the exact original turn metadata')
      compactSummaries.add(summary.messageDigest)
      compaction = undefined; latestMessage = row.uuid
      continue
    }
    if (compaction && ['user', 'assistant', 'api-request'].includes(row.type)) stale('Claude compact boundary has no exact same-turn summary')
    if (row.type === 'api-request-shape') {
      if (!row.shapeHash || !/^[a-f0-9]{64}$/.test(row.shapeHash) || !row.toolNames || allowed.some(name => !row.toolNames!.includes(name)) || row.toolNames.some(name => ![...allowed, 'DeferredToolPlaceholder'].includes(name)) || !row.placeholderValid) stale('Claude API exposes a foreign or discoverable tool or has no shape identity')
      shapes.add(row.shapeHash)
    }
    if (row.type === 'api-request-blob') {
      if (row.compactSummaryDigest && !compactSummaries.has(row.compactSummaryDigest)) stale('Claude API string message is not an observed same-turn compact summary')
      if (!row.message || row.hash !== claudeMessageDigest(row.message) || row.message.content.some(block => !['tool_result', 'text'].includes(block.type))) stale('Claude public API message blob has invalid bytes or type')
      for (const block of row.message.content.filter(block => block.type === 'tool_result')) {
        const originalBlock = responseBlocks.get(block.tool_use_id!)
        if (!originalBlock || claudeMessageDigest(originalBlock) !== claudeMessageDigest(block)) stale('Claude merged API tool result differs from its exact native public reply')
        responseMessages.set(block.tool_use_id!, row.hash)
      }
    }
    if (row.type === 'api-request') {
      const base = row.base ? requests.get(row.base) : []
      if (!row.id || requests.has(row.id) || !row.shapeHash || !shapes.has(row.shapeHash) || !base || !Number.isSafeInteger(row.keep) || row.keep! < 0 || row.keep! > base.length || !Array.isArray(row.tail) || row.model !== model) stale('Claude API model, tools shape or request history boundary differs')
      if (!requests.size && (!row.tail.includes(claudeMessageDigest(original.message)) || row.keep !== 0 || row.base)) stale('Claude original user prompt was not in the actual first API request')
      requests.set(row.id, [...base.slice(0, row.keep), ...row.tail])
    }
    if (row.type === 'assistant') {
      latestMessage = row.uuid
      if (!row.requestRef || !requests.has(row.requestRef)) stale('Claude assistant lacks an exact actual API request reference')
      requestRefs.add(row.requestRef)
      for (const block of row.message!.content) {
        if (!block.id || calls.has(block.id) || !block.name || block.name === 'DeferredToolPlaceholder') stale('Claude called a forbidden, placeholder or repeated tool')
        calls.set(block.id, { row, block })
      }
    }
    if (row.type === 'user' && row.uuid !== userUuid) {
      latestMessage = row.uuid
      if (row.promptId !== promptId || !row.message?.content.length || row.message.content.some(block => block.type !== 'tool_result')) stale('Claude history appended another user turn')
      for (const block of row.message.content) {
        const call = calls.get(block.tool_use_id!)
        if (!call || responseMessages.has(block.tool_use_id!) || row.sourceToolAssistantUUID !== call.row.uuid || row.parentUuid !== call.row.uuid) stale('Claude tool result is not paired with its exact native call')
        responseMessages.set(block.tool_use_id!, claudeMessageDigest(row.message))
        responseBlocks.set(block.tool_use_id!, block)
        if (!allowed.includes(call.block.name!)) {
          if (!witness.mcpHistory || block.is_error !== true || block.content !== `<tool_use_error>Error: No such tool available: ${call.block.name}</tool_use_error>`) stale('Claude foreign tool call has no exact native non-dispatch rejection')
          rejectedCalls.push(block.tool_use_id!); continue
        }
        if (call.block.name === 'StructuredOutput') { if (!block.is_error && claudeMessageDigest(call.block.input) === claudeMessageDigest(result.structured_output)) acceptedOutput = true; continue }
        let read: ReturnType<typeof readFrozenRange>
        try { read = readFrozenRange(ref, call.block.input) }
        catch (error) {
          if (!(error instanceof StructuredSessionError) || error.code !== 'stale_result' || error.message !== 'frozen reader range is invalid or exceeds its bounded response'
            || !witness.mcpHistory || block.is_error !== true || block.content !== error.message) throw error
          rejectedCalls.push(block.tool_use_id!); continue
        }
        const { arguments: args, response } = read
        if (args.endByte - args.startByte > 65536 || block.is_error || !Array.isArray(block.content)
          || JSON.stringify(block.content) !== JSON.stringify(response.contentItems.map(item => ({ type: 'text', text: item.text }))) || response.contentItems[0].text.length > 500000) stale('Claude public tool_result is truncated, substituted or differs from immutable bytes')
        const { receipt } = persistFrozenRead(ref, { threadId: sessionId, turnId: userUuid, callId: call.block.id! }, args)
        receipts.push(receipt)
      }
    }
    if (row.uuid === userUuid) latestMessage = row.uuid
  }
  if (compaction) stale('Claude compact boundary has no exact same-turn summary')
  if (!acceptedOutput || [...calls].some(([id]) => !responseMessages.has(id))) stale('Claude result has no matching accepted schema tool output or has unanswered calls')
  const coveredEntryIds = frozenReadCoverage(ref, receipts)
  for (const callId of [...receipts.map(receipt => receipt.callId), ...rejectedCalls]) {
    const messageHash = responseMessages.get(callId)!
    if (![...requests].some(([id, hashes]) => hashes.includes(messageHash) && requestRefs.has(id))) stale('Claude reader result was not present in a subsequent actual model API request')
  }
  const historyBytes = encode(witness), historyDigest = sha(historyBytes)
  const path = join(dirname(ref.manifestPath), 'histories', historyDigest)
  if (!existsSync(path)) writeFileSync(path, historyBytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== historyDigest) stale('Claude public witness content was modified')
  return { version: 3, provider: 'claude-code', contextDigest: ref.contextDigest, threadId: sessionId, turnId: userUuid, promptId, model,
    cliVersion: witness.cliVersion, maxReadBytes: 65536, maxResultSizeChars: 500000, receipts, coveredEntryIds, historyDigest }
}

/** 已结算资源重放核验保存的原生历史全文和同一逻辑覆盖，不再派发工具。 */
export function verifyFrozenReadProof(ref: FrozenContextRef, proof: FrozenReadProof, identity: { threadId: string; turnId: string }, toolOutputTokenLimit?: number, result?: { output: unknown }): void {
  if (proof.contextDigest !== ref.contextDigest || proof.threadId !== identity.threadId || proof.turnId !== identity.turnId || !/^[a-f0-9]{64}$/.test(proof.historyDigest)) stale('frozen coverage evidence differs from its exact context/thread/turn')
  if (toolOutputTokenLimit !== undefined && (proof.version !== 2 || proof.toolOutputTokenLimit !== toolOutputTokenLimit)) stale('current frozen runtime requires its exact v2 model-visible proof')
  const history = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.historyDigest))
  if (sha(history) !== proof.historyDigest) stale('saved native frozen history digest differs')
  if (proof.version === 3) {
    const witness = JSON.parse(history.toString('utf8')) as ClaudeFrozenWitness
    if (result && !encode(witness.result.structured_output).equals(encode(result.output))) stale('Claude result differs from its authoritative content-addressed native witness')
    if (JSON.stringify(readClaudePublicHistory(witness.nativeHistoryPath, witness.sessionId)) !== JSON.stringify(witness.history)) stale('Claude saved public witness differs from original native history')
    if (!encode(proveClaudeFrozenReads(ref, witness)).equals(encode(proof))) stale('Claude frozen proof differs from its exact native witness')
    return
  }
  let visibility: FrozenVisibility | undefined
  if (proof.version === 2) {
    if (!/^[a-f0-9]{64}$/.test(proof.visibilityDigest)) stale('frozen visible history digest is invalid')
    const bytes = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.visibilityDigest))
    if (sha(bytes) !== proof.visibilityDigest) stale('saved frozen visible history digest differs')
    const saved = JSON.parse(bytes.toString('utf8')) as FrozenVisibility & { threadId: string; turnId: string }
    if (saved.threadId !== identity.threadId || saved.turnId !== identity.turnId || saved.toolOutputTokenLimit !== proof.toolOutputTokenLimit) stale('saved frozen visible history names a different runtime or turn')
    visibility = { toolOutputTokenLimit: saved.toolOutputTokenLimit, outputs: saved.outputs }
  }
  const actual = proveFrozenReads(ref, identity, JSON.parse(history.toString('utf8')) as FrozenNativeItem[], visibility)
  if (!encode(actual).equals(encode(proof))) stale('frozen read coverage differs from its saved exact native history')
}
