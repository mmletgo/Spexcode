import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { processStartToken, runtimeRoot, verifyDetachedRuntime, type ProcessIdentity } from '@spexcode/spec-core'
import { spawnDetachedRuntime } from './runtime-ownership.js'
import { ensureCodexCurrentGeneration, type CodexGenerationEndpoint } from './codex-runtime-generations.js'
import type { FrozenContextRef, FrozenReadProof, FrozenReadReceipt } from './frozen-context.js'
import type { NativeWorktreeRequest, NativeWorktreeResult } from './native-worktree-runtime.js'
import { withDeliveryLocks } from './delivery-lock.js'

export type FrozenReaderRuntime = { cliVersion: string; catalogDigest: string; catalogPath: string } & ({ version: 1 } | { version: 2; toolOutputTokenLimit: number })
export type ZCodeToolPolicy = { version: 1; toolDenylist: readonly ['ExitPlanMode'] }
export type RejectedStructuredOutput = {
  version: 1; kind: 'untrusted_final'; representation: 'text' | 'native_json'
  text: string; sha256: string; ref?: { sha256: string }
  inputDigest: string; schemaDigest: string; promptDigest: string; purpose: string
  threadId: string; turnId: string
}
const zcodeReadToolPolicy: ZCodeToolPolicy = Object.freeze({ version: 1, toolDenylist: Object.freeze(['ExitPlanMode'] as const) })

export type StructuredExecution = {
  version: 1 | 2 | 3 | 4 | 5 | 6
  policy: 'native-worktree-v1' | 'codex-read-only-v1' | 'codex-frozen-read-only-v2' | 'claude-frozen-read-only-v1' | 'zcode-frozen-read-only-v1'
  schema: Record<string, unknown>
  inputDigest: string
  purpose: string
  timeoutMs: number | null
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  threadId?: string
  turnId?: string
  state?: 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'timeout'
  observer?: ProcessIdentity | null
  turnStartRequested?: boolean
  cancellation?: { reason: 'cancelled' | 'timeout'; requestedAt: number; nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
  output?: unknown
  resultDigest?: string
  error?: string
  errorCode?: 'structured_output_retries_exhausted' | 'structured_output_format_invalid' | 'native_worktree_result_invalid'
  rejectedOutput?: RejectedStructuredOutput
  worktree?: NativeWorktreeRequest
  zcodeToolPolicy?: ZCodeToolPolicy
  resultWorktree?: NativeWorktreeResult
  frozenContext?: FrozenContextRef
  frozenReads?: FrozenReadReceipt[]
  frozenReadProof?: FrozenReadProof
  readerRuntime?: FrozenReaderRuntime
  claudeNative?: { version: 1; root: string; sessionId: string; userUuid: string; pid?: number; receiptFile?: string; promptId?: string }
  zcodeNative?: { version: 1 | 2; root: string; sessionId: string; inputId: string; pid?: number; receiptFile?: string; turnId?: string }
}

/** 新请求冻结已验证工具策略；已有请求的缺席也是固定语义，显式换策略必须拒绝。 */
export function pinZCodeToolPolicy(request: Pick<StructuredExecution, 'model' | 'worktree' | 'zcodeToolPolicy'>, saved: Pick<StructuredExecution, 'zcodeToolPolicy'> | null): ZCodeToolPolicy | undefined {
  const policy = saved === null ? request.model?.startsWith('zcode:') && request.worktree?.mode === 'read' ? zcodeReadToolPolicy : undefined : saved.zcodeToolPolicy
  if (request.zcodeToolPolicy !== undefined && !isDeepStrictEqual(request.zcodeToolPolicy, policy)) throw new StructuredSessionError(saved === null ? 'unsupported' : 'key_reused', 'ZCode tool policy differs from the fixed structured request')
  return policy
}

/** 从持久化策略推导结构化 realm；无效或不完整策略不获得控制根。 */
export function structuredRealmRoot(execution: unknown, root = runtimeRoot()): string | null {
  if (!execution || typeof execution !== 'object') return null
  const state = execution as Partial<StructuredExecution>
  if (state.version === 6 && state.policy === 'native-worktree-v1' && state.worktree && !state.frozenContext && !state.readerRuntime) {
    if (state.model?.startsWith('claude:')) return join(root, 'structured-native-worktree-v1', 'claude')
    if (/^zcode:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(state.model ?? '')) return join(root, 'structured-native-worktree-v1', 'zcode')
  }
  if (state.version === (state.timeoutMs === null ? 5 : 4) && state.policy === 'zcode-frozen-read-only-v1' && state.frozenContext?.version === 1 && /^zcode:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(state.model ?? '') && !state.readerRuntime)
    return join(root, 'structured-zcode-read-only-v1')
  if (state.version === (state.timeoutMs === null ? 5 : 3) && state.policy === 'claude-frozen-read-only-v1' && state.frozenContext?.version === 1 && state.model?.startsWith('claude:') && !state.readerRuntime)
    return join(root, 'structured-claude-read-only-v1')
  if (state.version === (state.timeoutMs === null ? 5 : 1) && state.policy === 'codex-read-only-v1' && state.readerRuntime === undefined && state.frozenContext === undefined)
    return join(root, 'structured-read-only-v1')
  const readerRuntime = state.readerRuntime
  if (state.version === (state.timeoutMs === null ? 5 : 2) && state.policy === 'codex-frozen-read-only-v2' && state.frozenContext?.version === 1 && readerRuntime
    && /^[a-f0-9]{64}$/.test(readerRuntime.catalogDigest)) {
    const realm = join(root, 'structured-frozen-read-only-v2', readerRuntime.catalogDigest)
    if (readerRuntime.version === 1) return realm
    if (readerRuntime.version === 2 && Number.isSafeInteger(readerRuntime.toolOutputTokenLimit) && readerRuntime.toolOutputTokenLimit > 0)
      return join(realm, `output-${readerRuntime.toolOutputTokenLimit}`)
  }
  return null
}

/** 固定策略只有一份构造，运行观测与冻结读取证明不参与创建载荷。 */
export function structuredExecutionPolicy(request: Pick<StructuredExecution, 'schema' | 'inputDigest' | 'purpose' | 'timeoutMs' | 'model' | 'effort' | 'frozenContext' | 'readerRuntime' | 'worktree' | 'zcodeToolPolicy'>): StructuredExecution {
  const claude = request.model?.startsWith('claude:') === true
  const zcode = request.model?.startsWith('zcode:') === true
  if (request.zcodeToolPolicy !== undefined && (!zcode || request.worktree?.mode !== 'read' || !isDeepStrictEqual(request.zcodeToolPolicy, zcodeReadToolPolicy))) throw new StructuredSessionError('unsupported', 'ZCode structured tool policy requires the exact noninteractive read policy')
  if (request.worktree) {
    if ((!claude && !zcode) || request.frozenContext || request.readerRuntime) throw new StructuredSessionError('unsupported', 'native worktree requires an explicit Claude/ZCode model and no frozen reader policy')
    return { version: 6, policy: 'native-worktree-v1', schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs, model: request.model, ...(request.effort ? { effort: request.effort } : {}), worktree: request.worktree, ...(request.zcodeToolPolicy ? { zcodeToolPolicy: request.zcodeToolPolicy } : {}) }
  }
  return { version: request.timeoutMs === null ? 5 : zcode ? 4 : claude ? 3 : request.frozenContext ? 2 : 1, policy: zcode ? 'zcode-frozen-read-only-v1' : claude ? 'claude-frozen-read-only-v1' : request.frozenContext ? 'codex-frozen-read-only-v2' : 'codex-read-only-v1',
    schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs,
    ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), ...(request.frozenContext ? { frozenContext: request.frozenContext } : {}), ...(request.readerRuntime ? { readerRuntime: request.readerRuntime } : {}) }
}
/** 模型调用无期限时不装计时器；创建和精确停止预算由各自入口持有。 */
export function structuredExecutionTimer(timeoutMs: number | null, onTimeout: () => void): ReturnType<typeof setTimeout> | undefined {
  return timeoutMs === null ? undefined : setTimeout(onTimeout, timeoutMs)
}
// A missing process-start probe is not proof of death. Only an explicit release, ESRCH or a
// different start token permits another process to claim this exact native turn's observation.
export function structuredObserverState(execution: StructuredExecution): 'live' | 'gone' | 'unproven' {
  const owner = execution.observer
  if (owner === null) return 'gone'
  if (!owner) return execution.state === 'running' ? 'unproven' : 'gone'
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.startToken !== 'string' || !owner.startToken) return 'unproven'
  const token = processStartToken(owner.pid)
  if (token) return token === owner.startToken ? 'live' : 'gone'
  try { process.kill(owner.pid, 0); return 'unproven' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unproven' }
}

export class StructuredSessionError extends Error {
  readonly sessionId?: string
  readonly threadId?: string
  readonly turnId?: string
  readonly rejectedOutput?: RejectedStructuredOutput
  constructor(readonly code: 'unsupported' | 'failed' | 'cancelled' | 'timeout' | 'key_reused' | 'stale_result' | 'cancellation_pending' | 'structured_output_retries_exhausted' | 'structured_output_format_invalid' | 'native_worktree_result_invalid', message: string, identity: { sessionId?: string; threadId?: string; turnId?: string; rejectedOutput?: RejectedStructuredOutput } = {}) {
    super(message)
    this.name = 'StructuredSessionError'
    this.sessionId = identity.sessionId
    this.threadId = identity.threadId
    this.turnId = identity.turnId
    if (identity.rejectedOutput !== undefined) this.rejectedOutput = identity.rejectedOutput
  }
}

const rejectedDigest = (text: string): string => createHash('sha256').update(text).digest('hex')

/** 仅由已认证final的adapter调用；正文只进入失败诊断，不是成功结果。 */
export function rejectedFinalOutput(text: string, prompt: string, execution: Pick<StructuredExecution, 'inputDigest' | 'schema' | 'purpose'>, identity: { threadId: string; turnId: string }, representation: RejectedStructuredOutput['representation'] = 'text'): RejectedStructuredOutput {
  return { version: 1, kind: 'untrusted_final', representation, text, sha256: rejectedDigest(text), inputDigest: execution.inputDigest, schemaDigest: rejectedDigest(JSON.stringify(execution.schema)), promptDigest: rejectedDigest(prompt), purpose: execution.purpose, threadId: identity.threadId, turnId: identity.turnId }
}

/** 失败证据跨record、资源桥与owner请求边界时逐项核原绑定。 */
export function assertRejectedOutput(output: RejectedStructuredOutput, prompt: string, execution: Pick<StructuredExecution, 'inputDigest' | 'schema' | 'purpose'>, identity: { threadId?: string; turnId?: string }): void {
  if (typeof output.text !== 'string' || !identity.threadId || !identity.turnId || !isDeepStrictEqual({ ...output, ref: undefined }, { ...rejectedFinalOutput(output.text, prompt, execution, { threadId: identity.threadId, turnId: identity.turnId }, output.representation), ref: undefined })
    || !['text', 'native_json'].includes(output.representation) || output.ref && output.ref.sha256 !== output.sha256)
    throw new StructuredSessionError('stale_result', 'rejected final output differs from its exact request/schema/native identity')
}

export class StructuredSessionTransportError extends StructuredSessionError {
  constructor(message: string) {
    super('failed', message)
    this.name = 'StructuredSessionTransportError'
  }
}

const configText = `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\napps = false\nplugins = false\nhooks = false\nmulti_agent = false\nshell_tool = false\ncode_mode = false\ncode_mode_host = false\nunified_exec = false\n[mcp_servers]\n`
export const frozenReaderDisabledFeatures = ['goals', 'view_image', 'image_generation', 'sleep_tool', 'tool_suggest', 'current_time_reminder', 'send_message_to_user_async', 'token_budget', 'default_mode_request_user_input'] as const
const readerFlights = new Map<string, Promise<FrozenReaderRuntime>>()

/** 固定原生版本和去工具目录共同构成v2的能力身份，不读取用户模型缓存。 */
export function assertFrozenReaderRuntime(runtime: FrozenReaderRuntime, model?: string, toolOutputTokenLimit?: number): void {
  const cliVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
  if ((runtime.version !== 1 && runtime.version !== 2) || (runtime.version === 2 && (!Number.isSafeInteger(runtime.toolOutputTokenLimit) || runtime.toolOutputTokenLimit <= 0
    || (toolOutputTokenLimit !== undefined && runtime.toolOutputTokenLimit !== toolOutputTokenLimit)))
    || cliVersion !== 'codex-cli 0.160.0' || runtime.cliVersion !== cliVersion || !/^[a-f0-9]{64}$/.test(runtime.catalogDigest)
    || createHash('sha256').update(readFileSync(runtime.catalogPath)).digest('hex') !== runtime.catalogDigest)
    throw new StructuredSessionError('unsupported', 'frozen reader CLI version or immutable tool catalog identity differs')
  const catalog = JSON.parse(readFileSync(runtime.catalogPath, 'utf8')) as { models?: Array<{ slug?: string; apply_patch_tool_type?: unknown; experimental_supported_tools?: unknown[] }> }
  if (!catalog.models?.length || catalog.models.some(model => model.apply_patch_tool_type !== null || !Array.isArray(model.experimental_supported_tools) || model.experimental_supported_tools.length))
    throw new StructuredSessionError('unsupported', 'frozen reader catalog still exposes native tool capabilities')
  if (model && !catalog.models.some(entry => entry.slug === model))
    throw new StructuredSessionError('unsupported', 'requested model is absent from the immutable frozen reader catalog')
}

/** 从独立无turn的清洁原生realm获取provider metadata，只删工具能力并固定摘要。 */
export async function prepareFrozenReaderRuntime(root: string, frozenContext: FrozenContextRef): Promise<FrozenReaderRuntime> {
  const cliVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
  if (cliVersion !== 'codex-cli 0.160.0') throw new StructuredSessionError('unsupported', 'this native CLI has no verified frozen-reader host capability evidence')
  const { frozenReadOutputTokenLimit } = await import('./frozen-context.js')
  const toolOutputTokenLimit = frozenReadOutputTokenLimit(frozenContext)
  const policyRoot = join(root, 'reader-policy', createHash('sha256').update(JSON.stringify({ cliVersion, toolOutputTokenLimit })).digest('hex').slice(0, 16))
  const descriptor = join(policyRoot, 'runtime.json')
  if (existsSync(descriptor)) { const runtime = JSON.parse(readFileSync(descriptor, 'utf8')) as FrozenReaderRuntime; assertFrozenReaderRuntime(runtime, undefined, toolOutputTokenLimit); return runtime }
  let flight = readerFlights.get(policyRoot)
  if (!flight) {
    flight = withDeliveryLocks([`frozen-reader-policy-${createHash('sha256').update(policyRoot).digest('hex')}`], async () => {
      if (existsSync(descriptor)) { const runtime = JSON.parse(readFileSync(descriptor, 'utf8')) as FrozenReaderRuntime; assertFrozenReaderRuntime(runtime, undefined, toolOutputTokenLimit); return runtime }
      mkdirSync(policyRoot, { recursive: true, mode: 0o700 })
      const metadataRoot = join(policyRoot, 'metadata'), { endpoint } = await structuredGeneration(metadataRoot)
      const { codexLoadedReferenceIds, codexRefreshStructuredModels } = await import('./codex-harness.js')
      await codexRefreshStructuredModels(endpoint.socketPath)
      const provider = JSON.parse(readFileSync(join(metadataRoot, 'data/codex-home/models_cache.json'), 'utf8')) as { client_version?: string; models?: Array<Record<string, unknown>> }
      if (provider.client_version !== '0.160.0' || !provider.models?.length || provider.models.some(model => typeof model.slug !== 'string'))
        throw new StructuredSessionError('unsupported', 'clean native provider catalog provenance is unavailable')
      const catalog = Buffer.from(JSON.stringify({ models: provider.models.map(model => ({ ...model, apply_patch_tool_type: null, experimental_supported_tools: [] })) }))
      const catalogDigest = createHash('sha256').update(catalog).digest('hex'), catalogPath = join(policyRoot, `${catalogDigest}.json`)
      if (!existsSync(catalogPath)) writeFileSync(catalogPath, catalog, { mode: 0o400 })
      const runtime: FrozenReaderRuntime = { version: 2, cliVersion, catalogDigest, catalogPath, toolOutputTokenLimit }
      assertFrozenReaderRuntime(runtime, undefined, toolOutputTokenLimit)
      const references = await codexLoadedReferenceIds(endpoint.socketPath), pid = Number(readFileSync(endpoint.pidFile, 'utf8').trim()), proof = verifyDetachedRuntime(pid, endpoint.receiptFile)
      if (!references.ok || references.referenceIds.length || !proof.ok)
        throw new StructuredSessionError('unsupported', 'isolated metadata realm cannot prove zero threads and its exact process identity')
      process.kill(pid, 'SIGTERM')
      for (let retry = 0; retry < 100 && processStartToken(pid) === proof.identity.startToken; retry++) await new Promise<void>(resolve => setTimeout(resolve, 20))
      if (processStartToken(pid) === proof.identity.startToken) throw new StructuredSessionError('unsupported', 'isolated metadata process did not stop after exact zero-thread cleanup')
      writeFileSync(join(policyRoot, 'provenance.json'), JSON.stringify({ cliVersion, source: 'isolated native provider model/list + models_cache.models', beforeDigest: createHash('sha256').update(JSON.stringify({ models: provider.models })).digest('hex'), afterDigest: catalogDigest, changedFields: ['apply_patch_tool_type', 'experimental_supported_tools'], metadataEndpoint: endpoint, metadataStopped: true }), { mode: 0o400 })
      writeFileSync(descriptor, JSON.stringify(runtime), { mode: 0o400 })
      return runtime
    })
    readerFlights.set(policyRoot, flight)
  }
  try { return await flight } finally { if (readerFlights.get(policyRoot) === flight) readerFlights.delete(policyRoot) }
}

// The outer boundary contains the app-server itself, hooks, MCP subprocesses and tool descendants. Native
// read-only applies inside it too. Only the runtime's own rollouts/cache can be written; configuration and
// the secure auth reference remain outside that writable subtree. No launcher or user config is inherited.
export function structuredSeatbeltProfile(writableRoot: string): string {
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(writableRoot)}) (literal "/dev/null"))\n`
}

export function prepareStructuredRealm(root: string, readerRuntime?: FrozenReaderRuntime): { runtimeDir: string; start: (endpoint: CodexGenerationEndpoint) => Promise<void> } {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new StructuredSessionError('unsupported', 'structured read-only execution requires a verified macOS Seatbelt runtime; no permissive fallback is allowed')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const writable = join(root, 'data'); mkdirSync(writable, { recursive: true, mode: 0o700 })
  const home = join(root, 'config'); mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = join(home, 'config.toml')
  if (readerRuntime) assertFrozenReaderRuntime(readerRuntime)
  const trustedConfig = readerRuntime ? `model_catalog_json = ${JSON.stringify(readerRuntime.catalogPath)}\n` + (readerRuntime.version === 2 ? `tool_output_token_limit = ${readerRuntime.toolOutputTokenLimit}\n` : '') + configText.replace('code_mode_host = false', 'code_mode_host = true').replace('[features]', '[features]\n' + frozenReaderDisabledFeatures.map(feature => `${feature} = false`).join('\n')) : configText
  if (existsSync(config) && readFileSync(config, 'utf8') !== trustedConfig)
    throw new StructuredSessionError('unsupported', 'structured runtime configuration differs from the trusted fixed policy')
  writeFileSync(config, trustedConfig, { mode: 0o600 })
  // Auth remains an existing system-managed file. Do not read, copy or log its bytes. The outer sandbox
  // prevents refresh/overwrite of the original; an expired credential fails explicitly and needs login.
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  const reference = join(home, 'auth.json')
  if (existsSync(auth) && !existsSync(reference)) symlinkSync(realpathSync(auth), reference)
  // Codex writes state/cache files at CODEX_HOME, so use a clean writable home with only fixed config and
  // auth symlinks. Protect those exact paths in addition to the deny-by-default external write rule.
  const runtimeHome = join(writable, 'codex-home'); mkdirSync(runtimeHome, { recursive: true, mode: 0o700 })
  for (const name of ['config.toml', 'auth.json']) {
    const source = join(home, name)
    if (existsSync(source) && !existsSync(join(runtimeHome, name))) symlinkSync(source, join(runtimeHome, name))
  }
  const profile = join(root, 'policy.sb')
  const policy = structuredSeatbeltProfile(realpathSync(writable)) + `(deny file-write* (literal ${JSON.stringify(join(realpathSync(runtimeHome), 'config.toml'))}) (literal ${JSON.stringify(join(realpathSync(runtimeHome), 'auth.json'))}))\n`
  writeFileSync(profile, policy, { mode: 0o600 })
  const outside = join(root, 'write-probe'); writeFileSync(outside, 'unchanged', { mode: 0o600 })
  const probe = join(writable, 'write-probe')
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', 'printf allowed > "$1"; printf forbidden > "$2" 2>/dev/null; test -f "$1"', 'probe', probe, outside], { stdio: 'ignore' })
    if (readFileSync(outside, 'utf8') !== 'unchanged') throw new Error('outside write succeeded')
  } catch {
    throw new StructuredSessionError('unsupported', 'outer read-only sandbox probe failed; refusing Agent execution')
  }
  const runtimeDir = join(root, 'control'); mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const start = async (endpoint: CodexGenerationEndpoint): Promise<void> => {
    // Explicit allowlist avoids inherited wrappers, server overrides, tools, credentials in logs and
    // foreign session identity. The auth reference is consumed by Codex's normal authentication mechanism.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: join(writable, 'tmp'), CODEX_HOME: runtimeHome }
    mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 })
    const endpointProfile = join(root, `${endpoint.id}.sb`)
    const rendezvous = join(realpathSync(dirname(endpoint.socketPath)), basename(endpoint.socketPath))
    // Codex 0.160 protects Unix RPC sockets in its fixed executor-local daemon directory; the advertised
    // endpoint is a symlink. Grant only this generation's hashed socket/lock, never the shared directory.
    const daemonDirectory = join('/private/tmp', `codex-daemon-${process.getuid!()}`)
    const physicalSocket = join(daemonDirectory, createHash('sha256').update(rendezvous).digest('hex'))
    writeFileSync(endpointProfile, policy
      + `(allow file-write-create (literal ${JSON.stringify(daemonDirectory)}) (literal ${JSON.stringify(dirname(rendezvous))}))\n`
      + `(allow file-write* (literal ${JSON.stringify(rendezvous)}) (literal ${JSON.stringify(physicalSocket)}) (literal ${JSON.stringify(`${physicalSocket}.lock`)}) (literal ${JSON.stringify(join(realpathSync(dirname(endpoint.logFile)), basename(endpoint.logFile)))}))\n`, { mode: 0o600 })
    spawnDetachedRuntime({ cwd: runtimeHome, logFile: endpoint.logFile, pidFile: endpoint.pidFile,
      receiptFile: endpoint.receiptFile, command: '/usr/bin/sandbox-exec',
      args: ['-f', endpointProfile, 'codex', 'app-server', '--strict-config', '--listen', `unix://${endpoint.socketPath}`], env })
  }
  return { runtimeDir, start }
}

export async function structuredGeneration(root: string, readerRuntime?: FrozenReaderRuntime): Promise<{ endpoint: CodexGenerationEndpoint; runtimeDir: string }> {
  const { runtimeDir, start } = prepareStructuredRealm(root, readerRuntime)
  const socketDirectory = join('/private/tmp', `spex-ro-${createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)}`)
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
  return { endpoint: await ensureCodexCurrentGeneration(runtimeDir, start, { socketDirectory }), runtimeDir }
}
