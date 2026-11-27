import { createHash } from 'node:crypto'
import { claudeReplay, codexReplay } from '../llm-manager/native-runtime.mjs'
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
export type FrozenReadProof = FrozenCoverageProof & ({ version?: never } | { version: 2; visibilityDigest: string; toolOutputTokenLimit: number } | { version: 3; provider: 'claude-code'; promptId: string; model: string; cliVersion: string; maxReadBytes: 65536; maxResultSizeChars: 500000 } | { version: 4; provider: 'zcode'; providerId: string; modelId: string; cliVersion: string; cliSha256: string; inputId: string; promptDigest: string; witnessDigest: string })
type ClaudePublicContentBlock = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | Array<{ type: string; text: string }>; text?: string; is_error?: boolean }
export type ClaudePublicMessage = { role: string; content: string | ClaudePublicContentBlock[] }
type ClaudeCompaction = { runningTurnSends: { uuids: string[]; openerUuid: string }; preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string }; preservedMessages?: { anchorUuid: string; uuids: string[]; allUuids: string[] } }
type ClaudeRequestRetry = { source: string; level: string; retryInMs: number; retryAttempt: number; maxRetries: number; errorDigest: string }
export type ClaudePublicRecord = { type: string; sessionId: string; uuid?: string; parentUuid?: string | null; promptId?: string; requestRef?: string; sourceToolAssistantUUID?: string; isMeta?: boolean; turnCompanion?: boolean; message?: ClaudePublicMessage; id?: string; hash?: string; shapeHash?: string; base?: string; keep?: number; tail?: string[]; model?: string; toolNames?: string[]; placeholderValid?: boolean
  subtype?: string; logicalParentUuid?: string; compactMetadata?: ClaudeCompaction
  requestRetry?: ClaudeRequestRetry
  compactSummary?: { transcriptOnly: boolean; promptUuids?: string[]; messageDigest: string; textOnly: boolean }
  compactSummaryDigest?: string
}
export type ClaudeFrozenWitness = { version: 1; provider: 'claude-code'; cliVersion: string; model: string; sessionId: string; userUuid: string; promptId: string; prompt: string; nativeHistoryPath: string; history: ClaudePublicRecord[]; mcpHistory?: { path: string; toolNames: string[] }; echo: { uuid: string; session_id: string; message: ClaudePublicMessage }; result: { type: string; subtype: string; is_error: boolean; session_id: string; uuid: string; user_message_uuid: string; user_message_uuids: string[]; structured_output: unknown }; initTools: string[] }
export type FrozenVisibleOutput = { callId: string; output: string | { type: 'input_text'; text: string }[]; historyTokenLimit: number }
export type NormalizedFrozenRead = { callId: string; arguments: unknown; text: string }
type FrozenVisibility = { toolOutputTokenLimit: number; outputs: FrozenVisibleOutput[] }
export type FrozenNativeItem = { type: string; id?: string; namespace?: string | null; tool?: string; arguments?: unknown; status?: string; success?: boolean | null; contentItems?: unknown }
export type FrozenToolResponse = { contentItems: { type: 'inputText'; text: string }[]; success: true }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')
function stale(message: string): never { throw new StructuredSessionError('stale_result', message) }
const bytesPath = (ref: FrozenContextRef, hash: string): string => join(dirname(ref.manifestPath), 'bytes', hash)
function describeFrozenEntry(entry: FrozenContextInput): { metadata: FrozenEntry; bytes: Buffer } {
  const bytes = entry.kind === 'absent' ? Buffer.alloc(0) : entry.bytes
  if (entry.kind === 'utf8') new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return { bytes, metadata: { id: entry.id, label: entry.label, kind: entry.kind, sha256: sha(bytes), byteLength: bytes.length, required: entry.required ?? true } }
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
    const { metadata, bytes } = describeFrozenEntry(entry)
    if (!existsSync(join(root, 'bytes', metadata.sha256))) writeFileSync(join(root, 'bytes', metadata.sha256), bytes, { mode: 0o400 })
    entries.push(metadata)
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

type FrozenPromptRequest = { root: string; prompt: string; requestKey: string; inputDigest: string; model?: string; frozenContext?: FrozenContextRef; frozenEntries?: readonly FrozenEntryJson[] }

function originalTaskEntry(prompt: string): FrozenContextInput {
  return { id: 'task', label: 'Complete original task and frozen context', kind: 'utf8', bytes: Buffer.from(prompt, 'utf8'), required: true }
}

/** 在任何派发摘要之前冻结超大正文或调用者给出的纯 JSON 条目；同键同内容返回同一个稳定引用。已有 ref 原样返回。 */
export function prepareFrozenPrompt<T extends FrozenPromptRequest>(request: T, options: { directory: string; binding?: Pick<FrozenContextBinding, 'policyDigest' | 'attemptId'> }): Omit<T, 'frozenEntries'> & { frozenContext?: FrozenContextRef } {
  const binding = { requestKey: request.requestKey, inputDigest: request.inputDigest, ...options.binding }
  if (request.frozenContext) { assertFrozenBinding(request.frozenContext, binding); return request }
  const declared = request.frozenEntries ?? []
  const promptBytes = Buffer.byteLength(request.prompt, 'utf8')
  const claude = request.model?.startsWith('claude:') === true
  const zcode = request.model?.startsWith('zcode:') === true
  if (!claude && !zcode && declared.length === 0 && promptBytes <= FROZEN_PROMPT_THRESHOLD_BYTES) return request
  const entries = frozenEntryInputs(declared)
  if (claude || zcode || promptBytes > FROZEN_PROMPT_THRESHOLD_BYTES) entries.unshift(originalTaskEntry(request.prompt))
  const frozenContext = freezeContext({ directory: options.directory, sourceRoot: request.root, binding, entries })
  const prompt = zcode ? `Read every required frozen entry completely using mcp__frozen__spex_read_frozen. Entry task contains the original instructions. Follow those instructions after reading. Each call reads at most 4096 original bytes; continue from original endByte, never decodedEndByte. Do not use files, shell, discovery, subagents, or other tools. Return only the requested JSON object, without prose or Markdown.\n${directFrozenContextPrompt(frozenContext, 4096)}` : claude ? `Read every required frozen entry completely using mcp__frozen__spex_read_frozen. Entry task contains the original instructions. Follow those instructions after reading. Each call reads at most 65536 original bytes; continue from original endByte, never decodedEndByte. Do not use files, shell, discovery, subagents, or other tools. Return the requested structured answer through StructuredOutput.\n${claudeFrozenContextPrompt(frozenContext)}` : codexFrozenHistory.codexFrozenPrompt({
    ...frozenCodexPromptInput(frozenContext), prompt: request.prompt, taskIsFrozen: promptBytes > FROZEN_PROMPT_THRESHOLD_BYTES,
  }).prompt
  const { frozenEntries: _entries, ...rest } = request
  return { ...rest, prompt, frozenContext }
}

export type ManagedFrozenPromptInput = {
  prompt: string
  taskIsFrozen: boolean
  contextDigest: string
  maxReadBytes: number
  maxResponseBytes: number
  entries: readonly FrozenEntry[]
  plans: readonly FrozenEntryReadPlan[]
}

type ManagedFrozenPromptBuilder = { codexFrozenPrompt(input: ManagedFrozenPromptInput): { prompt: string; toolOutputTokenLimit: number } }

type CodexFrozenHistory = ManagedFrozenPromptBuilder & ManagedFrozenVisibilityVerifier & {
  CodexNativeProtocolError: new (...args: never[]) => Error & { code: string }
  codexFrozenPromptIndex(input: Omit<ManagedFrozenPromptInput, 'prompt' | 'taskIsFrozen'>): { index: string; toolOutputTokenLimit: number }
  codexFrozenToolDefinition(): { type: 'function'; name: typeof FROZEN_READ_TOOL; description: string; inputSchema: Record<string, unknown> }
  codexReadLegacyFrozenVisibleOutputs(rollout: string, turnId: string): FrozenVisibleOutput[]
}
const codexFrozenHistory = codexReplay as CodexFrozenHistory

function frozenCodexPromptInput(ref: FrozenContextRef, entries = readFrozenManifest(ref).entries): Omit<ManagedFrozenPromptInput, 'prompt' | 'taskIsFrozen'> {
  return { contextDigest: ref.contextDigest, entries, maxReadBytes: FROZEN_READ_MAX_BYTES,
    maxResponseBytes: maximumResponseBytes(ref, entries), plans: frozenReadPlans(ref, entries, FROZEN_READ_MAX_BYTES) }
}

/** 宿主冻结原输入和范围边界，Manager 负责原生提示和分批。 */
export function prepareManagedFrozenPrompt<T extends FrozenPromptRequest>(request: T, options: { directory: string; builder: ManagedFrozenPromptBuilder; pinned?: FrozenContextRef }): Omit<T, 'frozenEntries'> & { frozenContext?: FrozenContextRef } {
  const binding = { requestKey: request.requestKey, inputDigest: request.inputDigest }
  if (request.frozenContext) {
    const existing = readFrozenManifest(request.frozenContext)
    assertFrozenBinding(request.frozenContext, { ...existing.binding, ...binding })
    return request
  }
  const taskIsFrozen = Buffer.byteLength(request.prompt, 'utf8') > FROZEN_PROMPT_THRESHOLD_BYTES
  const entries = frozenEntryInputs(request.frozenEntries ?? [])
  if (taskIsFrozen) entries.unshift(originalTaskEntry(request.prompt))
  if (!entries.length && !options.pinned) return request
  const frozenContext = options.pinned ?? freezeContext({ directory: options.directory, sourceRoot: request.root, binding, entries })
  const manifest = readFrozenManifest(frozenContext)
  if (options.pinned) {
    assertFrozenBinding(frozenContext, binding)
    if (!encode(manifest.entries).equals(encode(entries.map(entry => describeFrozenEntry(entry).metadata))))
      stale('managed frozen replay input differs from the immutable manifest')
  }
  const { prompt } = options.builder.codexFrozenPrompt({
    ...frozenCodexPromptInput(frozenContext, manifest.entries), prompt: taskIsFrozen ? '' : request.prompt, taskIsFrozen,
  })
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
type FrozenEntryReadPlan = { entryId: string; ranges: Array<FrozenReadPlanRange & { responseBytes: number }> }

function frozenRangeText(entry: FrozenEntry, args: FrozenReadArguments, bytes: Buffer): string {
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
  return JSON.stringify({ ...args, kind: entry.kind, sha256: entry.sha256, byteLength: entry.byteLength, rangeSha256: sha(range), ...content })
}

function maximumResponseBytes(ref: FrozenContextRef, entries: readonly FrozenEntry[]): number {
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
  return maximumBytes
}

export function frozenReadMaximumResponseBytes(ref: FrozenContextRef): number {
  return maximumResponseBytes(ref, readFrozenManifest(ref).entries)
}

function frozenReadPlans(ref: FrozenContextRef, entries: readonly FrozenEntry[], maxReadBytes: number): FrozenEntryReadPlan[] {
  const verifiedBytes = new Map<string, Buffer>(), plannedContent = new Set<string>(), plans: FrozenEntryReadPlan[] = []
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
    const ranges: FrozenEntryReadPlan['ranges'] = []
    for (let startByte = 0; entry.byteLength === 0 ? startByte === 0 : startByte < entry.byteLength;) {
      const endByte = Math.min(entry.byteLength, startByte + maxReadBytes)
      const args = { contextDigest: ref.contextDigest, entryId: entry.id, startByte, endByte }
      const response = frozenRangeText(entry, args, bytes)
      ranges.push({ startByte, endByte, responseBytes: Buffer.byteLength(response, 'utf8') })
      if (entry.byteLength === 0) break
      startByte = endByte
    }
    plans.push({ entryId: entry.id, ranges })
  }
  return plans
}

/** 模型索引只含冻结条目元数据与由冻结正文派生的有界读取计划。 */
export function frozenContextPrompt(ref: FrozenContextRef): string {
  return codexFrozenHistory.codexFrozenPromptIndex(frozenCodexPromptInput(ref)).index
}

/** Claude直接调用同一reader；字符上限独立于Codex的exec与token证明。 */
export function claudeFrozenContextPrompt(ref: FrozenContextRef): string {
  return directFrozenContextPrompt(ref, 65536, 500000)
}

/** 直接MCP执行器共用冻结索引，保留各自已经验证的单次读取上限。 */
function directFrozenContextPrompt(ref: FrozenContextRef, maxReadBytes: number, maxResultSizeChars?: number): string {
  const manifest = readFrozenManifest(ref)
  return JSON.stringify({ tool: 'mcp__frozen__spex_read_frozen', contextDigest: ref.contextDigest, maxReadBytes, ...(maxResultSizeChars === undefined ? {} : { maxResultSizeChars }),
    rangeRule: `Copy each planned startByte/endByte exactly. ${maxReadBytes} is only a maximum span, never the end of a shorter entry. Never exceed entry.byteLength.`,
    entries: manifest.entries, readBatches: frozenReadPlans(ref, manifest.entries, maxReadBytes)
      .flatMap(({ entryId, ranges }) => ranges.map(({ startByte, endByte }) => ({ entryId, ranges: [{ startByte, endByte }] }))) })
}

/** 按冻结清单的真实元数据和最坏 JSON 转义，界定单个模型可见 inputText 的固定预算。 */
export function frozenReadOutputTokenLimit(ref: FrozenContextRef): number {
  return codexFrozenHistory.codexFrozenToolOutputTokenLimit(frozenReadMaximumResponseBytes(ref))
}

export const frozenReadTool = codexFrozenHistory.codexFrozenToolDefinition()

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
  const text = frozenRangeText(entry, args, bytes)
  return { arguments: { ...args }, response: { contentItems: [{ type: 'inputText', text }], success: true } }
}

type FrozenEvidenceAccess = 'record' | 'verify'

function frozenEvidence(path: string, bytes: Buffer, digest: string, description: string, access: FrozenEvidenceAccess): void {
  if (!existsSync(path)) {
    if (access === 'verify') stale(`${description} is missing`)
    writeFileSync(path, bytes, { mode: 0o400 })
  } else if (sha(readFileSync(path)) !== digest) stale(`${description} was modified`)
}

/** 在发送RPC回复前持久保存真实返回字节；RPC id不作为可恢复的调用身份。 */
export function persistFrozenRead(ref: FrozenContextRef, identity: { threadId: string; turnId: string; callId: string }, value: unknown): { receipt: FrozenReadReceipt; response: FrozenToolResponse } {
  const { arguments: args, response } = readFrozenRange(ref, value)
  return { receipt: frozenReadReceipt(ref, identity, args, response, 'record'), response }
}

function frozenReadReceipt(ref: FrozenContextRef, identity: { threadId: string; turnId: string; callId: string }, args: FrozenReadArguments, response: FrozenToolResponse, access: FrozenEvidenceAccess): FrozenReadReceipt {
  const bytes = encode(response), responseDigest = sha(bytes)
  frozenEvidence(join(dirname(ref.manifestPath), 'responses', responseDigest), bytes, responseDigest, 'persisted frozen response bytes', access)
  return { ...identity, arguments: args, responseDigest }
}

function codexFrozenEvidenceError(error: unknown): never {
  if (error instanceof codexFrozenHistory.CodexNativeProtocolError) {
    if (error.code === 'not_materialized') throw new StructuredSessionTransportError(error.message)
    if (error.code === 'stale_result') stale(error.message)
  }
  throw error
}

/** 由 Manager 认证旧 Codex 精确 turn 中的真实 exec/wait 输出。 */
export function frozenVisibleOutputs(rollout: string, turnId: string): FrozenVisibleOutput[] {
  try { return codexFrozenHistory.codexReadLegacyFrozenVisibleOutputs(rollout, turnId) }
  catch (error) { codexFrozenEvidenceError(error) }
}

function checkFrozenVisibility(ref: FrozenContextRef, visibility: FrozenVisibility, responses: string[]): void {
  if (visibility.toolOutputTokenLimit !== frozenReadOutputTokenLimit(ref)) stale('frozen visible evidence differs from the fixed response budget')
  try { codexFrozenHistory.codexValidateFrozenVisibility(visibility.outputs, visibility.toolOutputTokenLimit, responses, true) }
  catch (error) { codexFrozenEvidenceError(error) }
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
  return commitFrozenReadProof(ref, identity, items, receipts, visibility, visibility && (() => checkFrozenVisibility(ref, visibility, responses)))
}

export type ManagedFrozenVisibilityVerifier = {
  codexFrozenToolOutputTokenLimit(maxResponseBytes: number): number
  codexValidateFrozenVisibility(outputs: FrozenVisibleOutput[], limit: number, responses: string[], legacy?: boolean): void
}

/** 管理端证实原生调用形态后，宿主仍把每个回复逐字重算并绑定原始历史。 */
export function proveManagedFrozenReads(ref: FrozenContextRef, identity: { threadId: string; turnId: string }, items: readonly Record<string, unknown>[], reads: readonly NormalizedFrozenRead[], visibility: FrozenVisibility, verifier: ManagedFrozenVisibilityVerifier, access: FrozenEvidenceAccess): FrozenReadProof {
  const responses: string[] = []
  const receipts = reads.map(read => {
    const { arguments: args, response } = readFrozenRange(ref, read.arguments)
    const text = response.contentItems[0].text
    if (read.text !== text) stale('native frozen read result bytes differ from the immutable entry')
    responses.push(text)
    return frozenReadReceipt(ref, { ...identity, callId: read.callId }, args, response, access)
  })
  if (visibility.toolOutputTokenLimit !== verifier.codexFrozenToolOutputTokenLimit(frozenReadMaximumResponseBytes(ref))) stale('frozen visible history limit differs from the immutable manifest')
  return commitFrozenReadProof(ref, identity, items, receipts, visibility, () => verifier.codexValidateFrozenVisibility(visibility.outputs, visibility.toolOutputTokenLimit, responses), access)
}

function commitFrozenReadProof(ref: FrozenContextRef, identity: { threadId: string; turnId: string }, items: readonly unknown[], receipts: FrozenReadReceipt[], visibility?: FrozenVisibility, auditVisibility?: () => void, access: FrozenEvidenceAccess = 'record'): FrozenReadProof {
  const coveredEntryIds = frozenReadCoverage(ref, receipts)
  const history = encode(items), historyDigest = sha(history), historyPath = join(dirname(ref.manifestPath), 'histories', historyDigest)
  frozenEvidence(historyPath, history, historyDigest, 'persisted native frozen history', access)
  const proof = { contextDigest: ref.contextDigest, ...identity, receipts, coveredEntryIds, historyDigest }
  if (!visibility) return proof
  auditVisibility!()
  const visible = encode({ ...identity, ...visibility }), visibilityDigest = sha(visible), visiblePath = join(dirname(ref.manifestPath), 'histories', visibilityDigest)
  frozenEvidence(visiblePath, visible, visibilityDigest, 'persisted frozen visible history', access)
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

export type ClaudeApiSourceMetadata = { digest: string; role: 'user' | 'assistant' | 'system'; kind: 'cas' | 'transcript-prefix'; sourceUuids: string[]; ordinal: number }
export type ClaudeApiRequestSourceMetadata = { ordinal: number; messages: ReadonlyMap<string, ClaudeApiSourceMetadata> }
type ClaudeFrozenReplayRead = { callId: string; input: unknown; text?: string; error?: string }

export type ClaudeHistoryDecoder = {
  ClaudeNativeProtocolError: new (...args: never[]) => Error & { code: 'unsupported' | 'stale_result' | 'history_pending' }
  projectClaudeReplayHistory(source: string, sessionId: string): ClaudePublicRecord[]
  projectClaudeReplayApiSourceMetadata(source: string, sessionId: string, model: string): Map<string, ClaudeApiRequestSourceMetadata>
  claudeMcpToolNames(source: string): string[]
  claudeMessageDigest(value: unknown): string
  claudeWorktreeTerminal(result: ClaudeFrozenWitness['result']): {
    subtype: 'schema_exhausted' | 'success' | 'other'
    isSuccess: boolean; isSchemaExhausted: boolean; isStoppedError: boolean; mayRecoverFrozenRead: boolean; reportedError: boolean | 'invalid'; output: unknown
  }
  claudeTerminalMatchesIdentity(result: ClaudeFrozenWitness['result'], identity: { sessionId: string; userUuid: string }): boolean
  projectClaudeFrozenReadEvidence(witness: ClaudeFrozenWitness, options: {
    allowedTools: readonly string[]
    frozenToolName: string
    mcpToolName: string
    readNativeHistory(): string
    readMcpHistory(): string
  }): ClaudeFrozenReplayRead[]
}
const claudeHistoryReplay = claudeReplay as ClaudeHistoryDecoder

function claudeHistoryError(decoder: ClaudeHistoryDecoder, error: unknown, pendingMessage?: string): never {
  if (error instanceof decoder.ClaudeNativeProtocolError) {
    if (error.code === 'history_pending') throw new StructuredSessionTransportError(pendingMessage ?? error.message)
    if (error.code === 'stale_result') stale(error.message)
  }
  throw error
}

/** 读取宿主已绑定的原件，委托同一原生适配验证其公开消息与请求链。 */
export function readClaudePublicHistory(path: string, sessionId: string, decoder = claudeHistoryReplay): ClaudePublicRecord[] {
  const source = readFileSync(path, 'utf8')
  try { return decoder.projectClaudeReplayHistory(source, sessionId) }
  catch (error) { claudeHistoryError(decoder, error) }
}

/** 从已绑定的原生原件提取实际 API 消费来源。 */
export function readClaudeApiSourceMetadata(path: string, sessionId: string, model: string, decoder = claudeHistoryReplay): Map<string, ClaudeApiRequestSourceMetadata> {
  const source = readFileSync(path, 'utf8')
  try { return decoder.projectClaudeReplayApiSourceMetadata(source, sessionId, model) }
  catch (error) { claudeHistoryError(decoder, error, 'Claude native source history has not flushed its final record') }
}

export function readClaudeMcpToolNames(path: string, decoder = claudeHistoryReplay): string[] {
  try { return decoder.claudeMcpToolNames(readFileSync(path, 'utf8')) }
  catch (error) { claudeHistoryError(decoder, error) }
}

export const claudeMessageDigest = claudeHistoryReplay.claudeMessageDigest
/** Manager 证明回复已进入实际原生请求；宿主逐字核验冻结范围并提交读取收据。 */
export function proveClaudeFrozenReads(ref: FrozenContextRef, witness: ClaudeFrozenWitness, decoder = claudeHistoryReplay): FrozenReadProof {
  const { sessionId, userUuid, promptId, model } = witness
  let reads: ClaudeFrozenReplayRead[]
  try {
    reads = decoder.projectClaudeFrozenReadEvidence(witness, {
      allowedTools: ['StructuredOutput', 'mcp__frozen__spex_read_frozen'],
      frozenToolName: 'mcp__frozen__spex_read_frozen',
      mcpToolName: FROZEN_READ_TOOL,
      readNativeHistory: () => readFileSync(witness.nativeHistoryPath, 'utf8'),
      readMcpHistory: () => readFileSync(witness.mcpHistory!.path, 'utf8'),
    })
  } catch (error) { claudeHistoryError(decoder, error) }
  const receipts: FrozenReadReceipt[] = []
  for (const { callId, input, text, error: nativeError } of reads) {
    let read: ReturnType<typeof readFrozenRange>
    try { read = readFrozenRange(ref, input) }
    catch (error) {
      if (!(error instanceof StructuredSessionError) || error.code !== 'stale_result' || error.message !== 'frozen reader range is invalid or exceeds its bounded response'
        || !witness.mcpHistory || nativeError !== error.message) throw error
      continue
    }
    const { arguments: args, response } = read
    if (args.endByte - args.startByte > 65536 || text !== response.contentItems[0].text || text.length > 500000) stale('Claude public tool_result is truncated, substituted or differs from immutable bytes')
    const { receipt } = persistFrozenRead(ref, { threadId: sessionId, turnId: userUuid, callId }, args)
    receipts.push(receipt)
  }
  const coveredEntryIds = frozenReadCoverage(ref, receipts)
  const historyBytes = encode(witness), historyDigest = sha(historyBytes)
  const path = join(dirname(ref.manifestPath), 'histories', historyDigest)
  if (!existsSync(path)) writeFileSync(path, historyBytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== historyDigest) stale('Claude public witness content was modified')
  return { version: 3, provider: 'claude-code', contextDigest: ref.contextDigest, threadId: sessionId, turnId: userUuid, promptId, model,
    cliVersion: witness.cliVersion, maxReadBytes: 65536, maxResultSizeChars: 500000, receipts, coveredEntryIds, historyDigest }
}

/** 已结算资源重放核验保存的原生历史全文和同一逻辑覆盖，不再派发工具。 */
export function verifyFrozenReadProof(ref: FrozenContextRef, proof: FrozenReadProof, identity: { threadId: string; turnId: string }, toolOutputTokenLimit?: number, result?: { output: unknown }): void {
  if (proof.version === 4) stale('ZCode frozen evidence requires its native provider verifier')
  if (proof.contextDigest !== ref.contextDigest || proof.threadId !== identity.threadId || proof.turnId !== identity.turnId || !/^[a-f0-9]{64}$/.test(proof.historyDigest)) stale('frozen coverage evidence differs from its exact context/thread/turn')
  if (toolOutputTokenLimit !== undefined && (proof.version !== 2 || proof.toolOutputTokenLimit !== toolOutputTokenLimit)) stale('current frozen runtime requires its exact v2 model-visible evidence')
  const history = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.historyDigest))
  if (sha(history) !== proof.historyDigest) stale('saved native frozen history digest differs')
  if (proof.version === 3) {
    const witness = JSON.parse(history.toString('utf8')) as ClaudeFrozenWitness
    if (result && !encode(claudeHistoryReplay.claudeWorktreeTerminal(witness.result).output).equals(encode(result.output))) stale('Claude result differs from its authoritative content-addressed native witness')
    if (JSON.stringify(readClaudePublicHistory(witness.nativeHistoryPath, witness.sessionId)) !== JSON.stringify(witness.history)) stale('Claude saved public witness differs from original native history')
    if (!encode(proveClaudeFrozenReads(ref, witness)).equals(encode(proof))) stale('Claude frozen evidence differs from its exact native witness')
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
