import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StructuredSessionError } from './session-structured-policy.js'

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
export type FrozenReadArguments = { contextDigest: string; entryId: string; startByte: number; endByte: number }
export type FrozenReadReceipt = { threadId: string; turnId: string; callId: string; arguments: FrozenReadArguments; responseDigest: string }
export type FrozenReadProof = { contextDigest: string; threadId: string; turnId: string; receipts: FrozenReadReceipt[]; coveredEntryIds: string[]; historyDigest: string }
export type FrozenNativeItem = { type: string; id?: string; namespace?: string | null; tool?: string; arguments?: unknown; status?: string; success?: boolean | null; contentItems?: unknown }
export type FrozenToolResponse = { contentItems: { type: 'inputText'; text: string }[]; success: true }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')
function stale(message: string): never { throw new StructuredSessionError('stale_result', message) }
const bytesPath = (ref: FrozenContextRef, hash: string): string => join(dirname(ref.manifestPath), 'bytes', hash)

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

/** 在任何派发摘要之前冻结超大正文；同键同内容返回同一个稳定引用。 */
export function prepareFrozenPrompt<T extends { root: string; prompt: string; requestKey: string; inputDigest: string; frozenContext?: FrozenContextRef }>(request: T, options: { directory: string; binding?: Pick<FrozenContextBinding, 'policyDigest' | 'attemptId'> }): T & { frozenContext?: FrozenContextRef } {
  const binding = { requestKey: request.requestKey, inputDigest: request.inputDigest, ...options.binding }
  if (request.frozenContext) { assertFrozenBinding(request.frozenContext, binding); return request }
  if (Buffer.byteLength(request.prompt, 'utf8') <= FROZEN_PROMPT_THRESHOLD_BYTES) return request
  const frozenContext = freezeContext({ directory: options.directory, sourceRoot: request.root, binding,
    entries: [{ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8', bytes: Buffer.from(request.prompt, 'utf8') }] })
  const prompt = `The complete original task, instructions, and context are frozen without truncation in entry task. Read its entire required content using ${FROZEN_READ_TOOL}, then follow that original task and return its requested structured final answer. Byte offsets are end-exclusive. No shell, paths or live data are available.\n${frozenContextPrompt(frozenContext)}`
  return { ...request, prompt, frozenContext }
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

/** 模型索引只有逻辑条目、内容身份和字节长度，不泄露控制面路径。 */
export function frozenContextPrompt(ref: FrozenContextRef): string {
  const manifest = readFrozenManifest(ref)
  return JSON.stringify({ tool: FROZEN_READ_TOOL, contextDigest: ref.contextDigest, maxReadBytes: FROZEN_READ_MAX_BYTES, entries: manifest.entries })
}

export const frozenReadTool = {
  type: 'function', name: FROZEN_READ_TOOL,
  description: 'Read immutable frozen context only. Read every required unique content fully before the final answer. Byte ranges are end-exclusive and must preserve UTF-8 boundaries. No paths, live files, shell, or network are available.',
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

/** 在发送RPC回复前持久保存真实返回字节；RPC id不作为可恢复的调用身份。 */
export function persistFrozenRead(ref: FrozenContextRef, identity: { threadId: string; turnId: string; callId: string }, value: unknown): { receipt: FrozenReadReceipt; response: FrozenToolResponse } {
  const { arguments: args, response } = readFrozenRange(ref, value)
  const bytes = encode(response), responseDigest = sha(bytes)
  const path = join(dirname(ref.manifestPath), 'responses', responseDigest)
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o400 })
  else if (sha(readFileSync(path)) !== responseDigest) stale('persisted frozen response bytes were modified')
  return { receipt: { ...identity, arguments: args, responseDigest }, response }
}

/** 以精确原生turn的真实arguments和result重建coverage；不信模型声明或本地回执。 */
export function proveFrozenReads(ref: FrozenContextRef, identity: { threadId: string; turnId: string }, items: readonly FrozenNativeItem[]): FrozenReadProof {
  const receipts: FrozenReadReceipt[] = [], ranges = new Map<string, [number, number][]>(), ids = new Set<string>()
  const manifest = readFrozenManifest(ref)
  for (const item of items) {
    if (item.type !== 'dynamicToolCall') continue
    if (!item.id || ids.has(item.id) || item.tool !== FROZEN_READ_TOOL || item.namespace != null || item.status !== 'completed' || item.success !== true) stale('exact frozen turn contains an invalid, pending or foreign dynamic tool call')
    ids.add(item.id)
    const { arguments: args, response } = readFrozenRange(ref, item.arguments)
    if (JSON.stringify(item.contentItems) !== JSON.stringify(response.contentItems)) stale('native frozen read result bytes differ from the immutable entry')
    const { receipt } = persistFrozenRead(ref, { ...identity, callId: item.id }, args)
    receipts.push(receipt)
    const entry = manifest.entries.find(entry => entry.id === args.entryId)!
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
  const history = encode(items), historyDigest = sha(history), historyPath = join(dirname(ref.manifestPath), 'histories', historyDigest)
  if (!existsSync(historyPath)) writeFileSync(historyPath, history, { mode: 0o400 })
  else if (sha(readFileSync(historyPath)) !== historyDigest) stale('persisted native frozen history was modified')
  return { contextDigest: ref.contextDigest, ...identity, receipts, coveredEntryIds, historyDigest }
}

/** 已结算资源重放核验保存的原生历史全文和同一逻辑覆盖，不再派发工具。 */
export function verifyFrozenReadProof(ref: FrozenContextRef, proof: FrozenReadProof, identity: { threadId: string; turnId: string }): void {
  if (proof.contextDigest !== ref.contextDigest || proof.threadId !== identity.threadId || proof.turnId !== identity.turnId || !/^[a-f0-9]{64}$/.test(proof.historyDigest)) stale('frozen coverage proof differs from its exact context/thread/turn')
  const history = readFileSync(join(dirname(ref.manifestPath), 'histories', proof.historyDigest))
  if (sha(history) !== proof.historyDigest) stale('saved native frozen history digest differs')
  const actual = proveFrozenReads(ref, identity, JSON.parse(history.toString('utf8')) as FrozenNativeItem[])
  if (!encode(actual).equals(encode(proof))) stale('frozen read coverage differs from its saved exact native history')
}
