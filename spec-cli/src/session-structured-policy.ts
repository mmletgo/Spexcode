import { codexReplay } from '../llm-manager/native-runtime.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { processStartToken, runtimeRoot, verifyDetachedRuntime, type ProcessIdentity } from '@spexcode/spec-core'
import { spawnDetachedRuntime } from './runtime-ownership.js'
import { ensureCodexCurrentGeneration, type CodexGenerationEndpoint } from './codex-runtime-generations.js'
import type { FrozenContextRef, FrozenReadProof, FrozenReadReceipt } from './frozen-context.js'
import type { NativeWorktreeRequest, NativeWorktreeResult } from './native-worktree-runtime.js'
import type { GrokNativeState } from './grok-structured.js'
import type { CursorNativeState } from './cursor-structured.js'
import type { NativeCodexWorktreeState } from './codex-native-worktree-structured.js'
import { withDeliveryLocks } from './delivery-lock.js'
import type { ManagedCodexFrozenRuntime, ManagerPersistentCodexModule } from './llm-manager-host.js'
import { managedRoute } from './llm-manager-route.js'

export type FrozenReaderRuntime = { cliVersion: string; catalogDigest: string; catalogPath: string } & ({ version: 1 } | { version: 2; toolOutputTokenLimit: number })
export type ZCodeToolPolicy = { version: 1; toolDenylist: readonly ['ExitPlanMode'] }
export type NativeTokenUsage = {
  source: 'claude-model-usage' | 'zcode-turn-usage' | 'codex-turn-usage'
  uncachedInputTokens?: number
  totalInputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}
export function isNativeTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
export type RejectedStructuredOutput = {
  version: 1; kind: 'untrusted_final'; representation: 'text' | 'native_json'
  text: string; sha256: string; ref?: { sha256: string }
  inputDigest: string; schemaDigest: string; promptDigest: string; purpose: string
  threadId: string; turnId: string
}
const zcodeReadToolPolicy: ZCodeToolPolicy = Object.freeze({ version: 1, toolDenylist: Object.freeze(['ExitPlanMode'] as const) })

export type StructuredExecution = {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7
  policy: 'native-worktree-v1' | 'codex-read-only-v1' | 'codex-frozen-read-only-v2' | 'claude-frozen-read-only-v1' | 'zcode-frozen-read-only-v1' | 'codex-managed-frozen-worktree-v1'
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
  cancellation?: {
    reason: 'cancelled' | 'timeout'; requestedAt: number; nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string
    pendingManagerQuota?: { routeId: string; httpStatus?: StructuredSessionError['quotaHttpStatus'] }
  }
  output?: unknown
  resultDigest?: string
  nativeTokenUsage?: NativeTokenUsage
  error?: string
  errorCode?: 'structured_output_retries_exhausted' | 'structured_output_format_invalid' | 'native_worktree_result_invalid' | 'native_rpc_timeout' | 'native_turn_transport_failed' | 'provider_quota_exhausted' | 'llm_manager_route_unavailable' | 'unsupported'
  rejectedOutput?: RejectedStructuredOutput
  worktree?: NativeWorktreeRequest
  zcodeToolPolicy?: ZCodeToolPolicy
  nativeConfiguration?: 'cli-config-v1'
  resultWorktree?: NativeWorktreeResult
  failedWorktree?: NativeWorktreeResult
  frozenContext?: FrozenContextRef
  frozenReads?: FrozenReadReceipt[]
  frozenReadProof?: FrozenReadProof
  readerRuntime?: FrozenReaderRuntime
  claudeNative?: { version: 1 | 2; root: string; sessionId: string; userUuid: string; pid?: number; receiptFile?: string; promptId?: string }
  zcodeNative?: { version: 1 | 2 | 3; root: string; sessionId: string; inputId: string; pid?: number; receiptFile?: string; turnId?: string }
  grokNative?: GrokNativeState
  cursorNative?: CursorNativeState
  codexNative?: NativeCodexWorktreeState
}

/** 只识别原生路由形状；模型与别名是否可用由CLI实际初始化确认。 */
function nativeConfigurationHarness(model?: string): 'claude' | 'zcode' | 'grok' | 'cursor' | 'codex' | null {
  if (model?.startsWith('claude:') && model.length > 7) return 'claude'
  if (model?.startsWith('grok:') && model.slice(5).trim() && !model.includes('\0')) return 'grok'
  if (model?.startsWith('cursor:') && model.slice(7).trim() && !model.includes('\0')) return 'cursor'
  if (model?.startsWith('codex:') && model.slice(6).trim() && !model.includes('\0')) return 'codex'
  if (model === 'zcode:default') return 'zcode'
  if (model?.startsWith('zcode:')) {
    const separator = model.indexOf('/', 6)
    if (separator > 6 && separator < model.length - 1) return 'zcode'
  }
  return null
}

/** 仅真正新建工作树请求冻结CLI配置；历史缺席和上游已固定请求保持原样。 */
export function pinNativeConfiguration(request: Pick<StructuredExecution, 'model' | 'worktree' | 'nativeConfiguration'>, saved: Pick<StructuredExecution, 'nativeConfiguration'> | null): StructuredExecution['nativeConfiguration'] {
  const configuration = saved === null ? request.worktree && nativeConfigurationHarness(request.model) ? 'cli-config-v1' : undefined : saved.nativeConfiguration
  if (request.nativeConfiguration !== undefined && request.nativeConfiguration !== configuration) throw new StructuredSessionError(saved === null ? 'unsupported' : 'key_reused', 'native CLI configuration differs from the fixed structured request')
  return configuration
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
  if (state.nativeConfiguration !== undefined && (state.nativeConfiguration !== 'cli-config-v1' || state.version !== 6 || state.policy !== 'native-worktree-v1')) return null
  if (state.version === 6 && state.policy === 'native-worktree-v1' && state.worktree && !state.frozenContext && !state.readerRuntime) {
    if (state.nativeConfiguration === 'cli-config-v1') {
      const harness = nativeConfigurationHarness(state.model)
      return harness ? join(root, 'structured-native-worktree-v1', harness) : null
    }
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
  const managed = state.version === 7 && state.policy === 'codex-managed-frozen-worktree-v1' ? managedRoute(state.model) : undefined
  if (managed?.frozenReader && state.worktree?.mode === 'read' && state.frozenContext?.version === 1 && readerRuntime?.version === 2
    && /^[a-f0-9]{64}$/.test(state.frozenContext.contextDigest) && readerRuntime.cliVersion === managed.frozenReader.cliVersion && /^[a-f0-9]{64}$/.test(readerRuntime.catalogDigest)
    && Number.isSafeInteger(readerRuntime.toolOutputTokenLimit) && readerRuntime.toolOutputTokenLimit > 0)
    return join(root, 'structured-managed-frozen-worktree-v1', managed.routeId, state.frozenContext.contextDigest, readerRuntime.catalogDigest, `output-${readerRuntime.toolOutputTokenLimit}`)
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
export function structuredExecutionPolicy(request: Pick<StructuredExecution, 'schema' | 'inputDigest' | 'purpose' | 'timeoutMs' | 'model' | 'effort' | 'frozenContext' | 'readerRuntime' | 'worktree' | 'zcodeToolPolicy' | 'nativeConfiguration'>): StructuredExecution {
  const claude = request.model?.startsWith('claude:') === true
  const zcode = request.model?.startsWith('zcode:') === true
  const grok = request.model?.startsWith('grok:') === true
  const cursor = request.model?.startsWith('cursor:') === true
  const codex = request.model?.startsWith('codex:') === true
  const managedReader = managedRoute(request.model)?.frozenReader
  if (managedReader) {
    if (request.worktree?.mode !== 'read' || request.nativeConfiguration || request.zcodeToolPolicy || request.frozenContext?.version !== 1
      || request.readerRuntime?.version !== 2 || request.readerRuntime.cliVersion !== managedReader.cliVersion)
      throw new StructuredSessionError('unsupported', 'managed frozen execution requires a fixed read-only worktree and matching reader capability')
    return { version: 7, policy: 'codex-managed-frozen-worktree-v1', schema: request.schema, inputDigest: request.inputDigest,
      purpose: request.purpose, timeoutMs: request.timeoutMs, model: request.model, ...(request.effort ? { effort: request.effort } : {}), worktree: request.worktree,
      frozenContext: request.frozenContext, readerRuntime: request.readerRuntime }
  }
  if (grok && (!request.worktree || request.nativeConfiguration !== 'cli-config-v1')) throw new StructuredSessionError('unsupported', 'Grok Build requires the native CLI worktree policy')
  if (cursor && (!request.worktree || request.nativeConfiguration !== 'cli-config-v1')) throw new StructuredSessionError('unsupported', 'Cursor CLI requires the native CLI worktree policy')
  if (codex && (!request.worktree || request.nativeConfiguration !== 'cli-config-v1')) throw new StructuredSessionError('unsupported', 'Codex CLI requires the native CLI worktree policy')
  if (request.nativeConfiguration !== undefined && (request.nativeConfiguration !== 'cli-config-v1' || !request.worktree || !nativeConfigurationHarness(request.model) || request.frozenContext || request.readerRuntime)) throw new StructuredSessionError('unsupported', 'native CLI configuration requires a v6 CLI worktree request')
  if (request.zcodeToolPolicy !== undefined && (!zcode || request.worktree?.mode !== 'read' || !isDeepStrictEqual(request.zcodeToolPolicy, zcodeReadToolPolicy))) throw new StructuredSessionError('unsupported', 'ZCode structured tool policy requires the exact noninteractive read policy')
  if (request.worktree) {
    if ((!claude && !zcode && !grok && !cursor && !codex) || request.frozenContext || request.readerRuntime) throw new StructuredSessionError('unsupported', 'native worktree requires an explicit native CLI model and no frozen reader policy')
    return { version: 6, policy: 'native-worktree-v1', schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs, model: request.model, ...(request.effort ? { effort: request.effort } : {}), worktree: request.worktree, ...(request.nativeConfiguration ? { nativeConfiguration: request.nativeConfiguration } : {}), ...(request.zcodeToolPolicy ? { zcodeToolPolicy: request.zcodeToolPolicy } : {}) }
  }
  return { version: request.timeoutMs === null ? 5 : zcode ? 4 : claude ? 3 : request.frozenContext ? 2 : 1, policy: zcode ? 'zcode-frozen-read-only-v1' : claude ? 'claude-frozen-read-only-v1' : request.frozenContext ? 'codex-frozen-read-only-v2' : 'codex-read-only-v1',
    schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs,
    ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}), ...(request.frozenContext ? { frozenContext: request.frozenContext } : {}), ...(request.readerRuntime ? { readerRuntime: request.readerRuntime } : {}) }
}
/** 模型调用无期限时不装计时器；创建和精确停止预算由各自入口持有。 */
export function structuredExecutionTimer(timeoutMs: number | null, onTimeout: () => void): ReturnType<typeof setTimeout> | undefined {
  return timeoutMs === null ? undefined : setTimeout(onTimeout, timeoutMs)
}

/** Manager 准入拒绝只在原派发尚无任何原生身份或产物时证明未启动。 */
export function structuredDispatchUnstarted(state: StructuredExecution): boolean {
  return !state.turnStartRequested && state.threadId === undefined && state.turnId === undefined
    && !state.grokNative && !state.cursorNative && !state.codexNative && !state.claudeNative && !state.zcodeNative
    && state.output === undefined && !state.resultDigest && !state.resultWorktree && !state.failedWorktree && !state.rejectedOutput
    && !state.nativeTokenUsage && !state.frozenReads?.length && !state.frozenReadProof
}

/** 只接受 Manager 在原名额请求明确返回前置拒绝所写的失败与停止记录。 */
export function isManagedReservationRejection(state: StructuredExecution): boolean {
  const stop = state.cancellation
  return state.state === 'failed' && state.errorCode === 'llm_manager_route_unavailable' && state.error === state.errorCode
    && !!managedRoute(state.model) && structuredDispatchUnstarted(state) && stop?.nativeStopped === true
    && stop.nativeStatus === 'notStarted' && stop.acknowledged === false && stop.reason === 'cancelled' && stop.error === undefined && stop.pendingManagerQuota === undefined
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
  readonly nativeTokenUsage?: NativeTokenUsage
  readonly failedWorktree?: NativeWorktreeResult
  readonly requestKey?: string
  readonly inputDigest?: string
  readonly quotaHttpStatus?: 402
  constructor(readonly code: 'unsupported' | 'failed' | 'cancelled' | 'timeout' | 'key_reused' | 'stale_result' | 'cancellation_pending' | NonNullable<StructuredExecution['errorCode']>, message: string, identity: { sessionId?: string; threadId?: string; turnId?: string; rejectedOutput?: RejectedStructuredOutput; nativeTokenUsage?: NativeTokenUsage; failedWorktree?: NativeWorktreeResult; requestKey?: string; inputDigest?: string; quotaHttpStatus?: 402 } = {}) {
    super(message)
    this.name = 'StructuredSessionError'
    this.sessionId = identity.sessionId
    this.threadId = identity.threadId
    this.turnId = identity.turnId
    if (identity.rejectedOutput !== undefined) this.rejectedOutput = identity.rejectedOutput
    if (identity.nativeTokenUsage !== undefined) this.nativeTokenUsage = identity.nativeTokenUsage
    if (identity.failedWorktree !== undefined) this.failedWorktree = identity.failedWorktree
    if (identity.requestKey !== undefined) this.requestKey = identity.requestKey
    if (identity.inputDigest !== undefined) this.inputDigest = identity.inputDigest
    if (identity.quotaHttpStatus !== undefined) this.quotaHttpStatus = identity.quotaHttpStatus
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

const codexFrozenAdapter = codexReplay as Pick<ManagerPersistentCodexModule,
  'codexAuditFrozenCatalog' | 'codexBuildFrozenCatalog' | 'codexPersistentAppServerArgs'
  | 'codexPersistentConfig' | 'codexPersistentHomePaths' | 'codexPersistentSocketPaths'> & {
  CodexPersistentAppServer: new (socketPath: string) => InstanceType<ManagerPersistentCodexModule['CodexPersistentAppServer']> & {
    initializeLegacyControl(): Promise<void>
  }
  codexLegacyFrozenCliVersion(): string
  codexPersistentDisabledFeatures: readonly string[]
}
export const frozenReaderDisabledFeatures = codexFrozenAdapter.codexPersistentDisabledFeatures
const readerFlights = new Map<string, Promise<FrozenReaderRuntime>>()

/** 固定原生版本和去工具目录共同构成v2的能力身份，不读取用户模型缓存。 */
export function assertFrozenReaderRuntime(runtime: FrozenReaderRuntime, model?: string, toolOutputTokenLimit?: number, hosted?: Pick<ManagedCodexFrozenRuntime, 'reader'> & Pick<ManagerPersistentCodexModule, 'codexAuditFrozenCatalog'>): void {
  const adapter = hosted ?? codexFrozenAdapter
  try {
    const cliVersion = hosted?.reader.cliVersion ?? codexFrozenAdapter.codexLegacyFrozenCliVersion()
    if ((runtime.version !== 1 && runtime.version !== 2) || (runtime.version === 2 && (!Number.isSafeInteger(runtime.toolOutputTokenLimit) || runtime.toolOutputTokenLimit <= 0
      || (toolOutputTokenLimit !== undefined && runtime.toolOutputTokenLimit !== toolOutputTokenLimit)))
      || runtime.cliVersion !== cliVersion || !/^[a-f0-9]{64}$/.test(runtime.catalogDigest))
      throw new StructuredSessionError('unsupported', 'frozen reader CLI version or immutable tool catalog identity differs')
    adapter.codexAuditFrozenCatalog({ path: runtime.catalogPath, digest: runtime.catalogDigest, model })
  } catch (error) {
    if ((error as { code?: string }).code === 'unsupported' && !(error instanceof StructuredSessionError))
      throw new StructuredSessionError('unsupported', (error as Error).message)
    throw error
  }
}

/** 从独立无turn的清洁原生realm获取provider metadata，只删工具能力并固定摘要。 */
export async function prepareFrozenReaderRuntime(root: string, frozenContext: FrozenContextRef, hosted?: ManagedCodexFrozenRuntime): Promise<FrozenReaderRuntime> {
  const adapter = hosted ?? codexFrozenAdapter
  let cliVersion: string
  try { cliVersion = hosted?.reader.cliVersion ?? codexFrozenAdapter.codexLegacyFrozenCliVersion() }
  catch (error) { throw new StructuredSessionError('unsupported', (error as Error).message) }
  const { frozenReadMaximumResponseBytes, frozenReadOutputTokenLimit } = await import('./frozen-context.js')
  const toolOutputTokenLimit = hosted ? hosted.codexFrozenToolOutputTokenLimit(frozenReadMaximumResponseBytes(frozenContext)) : frozenReadOutputTokenLimit(frozenContext)
  const policyRoot = join(root, 'reader-policy', createHash('sha256').update(JSON.stringify({ cliVersion, toolOutputTokenLimit, ...(hosted ? { capability: hosted.reader } : {}) })).digest('hex').slice(0, 16))
  const descriptor = join(policyRoot, 'runtime.json')
  if (existsSync(descriptor)) { const runtime = JSON.parse(readFileSync(descriptor, 'utf8')) as FrozenReaderRuntime; assertFrozenReaderRuntime(runtime, hosted?.reader.model, toolOutputTokenLimit, hosted); return runtime }
  let flight = readerFlights.get(policyRoot)
  if (!flight) {
    flight = withDeliveryLocks([`frozen-reader-policy-${createHash('sha256').update(policyRoot).digest('hex')}`], async () => {
      if (existsSync(descriptor)) { const runtime = JSON.parse(readFileSync(descriptor, 'utf8')) as FrozenReaderRuntime; assertFrozenReaderRuntime(runtime, hosted?.reader.model, toolOutputTokenLimit, hosted); return runtime }
      mkdirSync(policyRoot, { recursive: true, mode: 0o700 })
      const metadataRoot = join(policyRoot, 'metadata')
      const { stopUnboundManagedFrozenRealm } = await import('./codex-harness.js')
      const { endpoint, beforeDigest, changedFields, runtime } = await (async () => {
        try {
          const { endpoint } = await structuredGeneration(metadataRoot, undefined, hosted)
          const legacyClient = hosted ? undefined : new codexFrozenAdapter.CodexPersistentAppServer(endpoint.socketPath)
          const client = legacyClient ?? new hosted!.CodexPersistentAppServer(endpoint.socketPath)
          try {
            if (legacyClient) await legacyClient.initializeLegacyControl()
            else await client.initialize('spexcode-frozen-metadata', '1')
            const models = await client.refreshModels()
            if (hosted && !models.includes(hosted.reader.model)) throw new StructuredSessionError('unsupported', 'Manager model is absent from the isolated native catalog')
            const home = join(metadataRoot, 'data/codex-home')
            const catalog = adapter.codexBuildFrozenCatalog({ home, cliVersion, model: hosted?.reader.model })
            const catalogDigest = catalog.digest, catalogPath = join(policyRoot, `${catalogDigest}.json`)
            if (!existsSync(catalogPath)) writeFileSync(catalogPath, catalog.bytes, { mode: 0o400 })
            const runtime: FrozenReaderRuntime = { version: 2, cliVersion, catalogDigest, catalogPath, toolOutputTokenLimit }
            assertFrozenReaderRuntime(runtime, hosted?.reader.model, toolOutputTokenLimit, hosted)
            if (!hosted) {
              const references = await client.listLoadedThreadIds()
              const pid = Number(readFileSync(endpoint.pidFile, 'utf8').trim()), proof = verifyDetachedRuntime(pid, endpoint.receiptFile)
              if (references.length || !proof.ok)
                throw new StructuredSessionError('unsupported', 'isolated metadata realm cannot prove zero threads and its exact process identity')
              process.kill(pid, 'SIGTERM')
              for (let retry = 0; retry < 100 && processStartToken(pid) === proof.identity.startToken; retry++) await new Promise<void>(resolve => setTimeout(resolve, 20))
              if (processStartToken(pid) === proof.identity.startToken) throw new StructuredSessionError('unsupported', 'isolated metadata process did not stop after exact zero-thread cleanup')
            }
            return { endpoint, runtime, beforeDigest: catalog.beforeDigest, changedFields: catalog.changedFields }
          } finally { client.close() }
        } finally {
          if (hosted) await stopUnboundManagedFrozenRealm(metadataRoot, async () => hosted, 'metadata').catch((error: Error) => {
            throw new StructuredSessionError('cancellation_pending', `Manager metadata realm needs exact recovery: ${error.message}`)
          })
        }
      })()
      writeFileSync(join(policyRoot, 'provenance.json'), JSON.stringify({ cliVersion, source: 'isolated native provider model/list + models_cache.models', beforeDigest, afterDigest: runtime.catalogDigest, changedFields, metadataEndpoint: endpoint, metadataStopped: true }), { mode: 0o400 })
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

function managedFrozenHomeIdentity(realm: string, endpoint: CodexGenerationEndpoint): { home: string; receipt: string; identity: string } {
  const home = join(realpathSync(realm), 'data/codex-home')
  if (realpathSync(home) !== home) throw new Error('managed frozen CODEX_HOME escaped its original realm')
  const stat = statSync(home, { bigint: true })
  if (!stat.isDirectory()) throw new Error('managed frozen CODEX_HOME is not the original directory')
  return { home, receipt: `${endpoint.receiptFile}.home`,
    identity: JSON.stringify({ generation: endpoint.id, home, device: String(stat.dev), inode: String(stat.ino) }) }
}

/** 使用原 generation 启动时记录的私有 CODEX_HOME，拒绝路径或目录替换。 */
export function managedFrozenGenerationHome(realm: string, endpoint: CodexGenerationEndpoint): string {
  const { home, receipt, identity } = managedFrozenHomeIdentity(realm, endpoint)
  if (readFileSync(receipt, 'utf8') !== identity) throw new Error('managed frozen CODEX_HOME differs from the generation launch receipt')
  return home
}

export function prepareStructuredRealm(root: string, readerRuntime?: FrozenReaderRuntime, hosted?: ManagedCodexFrozenRuntime): { runtimeDir: string; start: (endpoint: CodexGenerationEndpoint) => Promise<void> } {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new StructuredSessionError('unsupported', 'structured read-only execution requires a verified macOS Seatbelt runtime; no permissive fallback is allowed')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const writable = join(root, 'data'); mkdirSync(writable, { recursive: true, mode: 0o700 })
  const home = join(root, 'config'); mkdirSync(home, { recursive: true, mode: 0o700 })
  const auth = process.env.CODEX_HOME || join(homedir(), '.codex')
  const adapter = hosted ?? codexFrozenAdapter
  const paths = adapter.codexPersistentHomePaths
  const config = paths(home).configPath
  if (readerRuntime) assertFrozenReaderRuntime(readerRuntime, hosted?.reader.model, undefined, hosted)
  const trustedConfig = adapter.codexPersistentConfig(readerRuntime)
  if (existsSync(config) && readFileSync(config, 'utf8') !== trustedConfig)
    throw new StructuredSessionError('unsupported', 'structured runtime configuration differs from the trusted fixed policy')
  writeFileSync(config, trustedConfig, { mode: 0o600 })
  // Auth remains an existing system-managed file. Do not read, copy or log its bytes. The outer sandbox
  // prevents refresh/overwrite of the original; an expired credential fails explicitly and needs login.
  const authSource = paths(auth).authPath, reference = paths(home).authPath
  if (existsSync(authSource) && !existsSync(reference)) symlinkSync(realpathSync(authSource), reference)
  // Codex writes state/cache files at CODEX_HOME, so use a clean writable home with only fixed config and
  // auth symlinks. Protect those exact paths in addition to the deny-by-default external write rule.
  const runtimeHome = join(writable, 'codex-home'); mkdirSync(runtimeHome, { recursive: true, mode: 0o700 })
  const homePaths = paths(home), runtimePaths = paths(runtimeHome)
  for (const key of ['configPath', 'authPath'] as const)
    if (existsSync(homePaths[key]) && !existsSync(runtimePaths[key])) symlinkSync(homePaths[key], runtimePaths[key])
  const profile = join(root, 'policy.sb')
  const policy = structuredSeatbeltProfile(realpathSync(writable)) + `(deny file-write* (literal ${JSON.stringify(paths(realpathSync(runtimeHome)).configPath)}) (literal ${JSON.stringify(paths(realpathSync(runtimeHome)).authPath)}))\n`
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
    const managedHome = hosted ? managedFrozenHomeIdentity(root, endpoint) : undefined
    if (managedHome) writeFileSync(managedHome.receipt, managedHome.identity, { mode: 0o600, flag: 'wx' })
    const runtimeCwd = managedHome?.home ?? runtimeHome
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: join(writable, 'tmp'), CODEX_HOME: runtimeCwd }
    mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 })
    const endpointProfile = join(root, `${endpoint.id}.sb`)
    const { rendezvous, daemonDirectory, physicalSocket, lockPath } = adapter.codexPersistentSocketPaths(endpoint.socketPath, process.getuid!())
    writeFileSync(endpointProfile, policy
      + `(allow file-write-create (literal ${JSON.stringify(daemonDirectory)}) (literal ${JSON.stringify(dirname(rendezvous))}))\n`
      + `(allow file-write* (literal ${JSON.stringify(rendezvous)}) (literal ${JSON.stringify(physicalSocket)}) (literal ${JSON.stringify(lockPath)}) (literal ${JSON.stringify(join(realpathSync(dirname(endpoint.logFile)), basename(endpoint.logFile)))}))\n`, { mode: 0o600 })
    const command = [hosted?.executable ?? 'codex', ...adapter.codexPersistentAppServerArgs(endpoint.socketPath)]
    spawnDetachedRuntime({ cwd: runtimeCwd, logFile: endpoint.logFile, pidFile: endpoint.pidFile,
      receiptFile: endpoint.receiptFile, command: '/usr/bin/sandbox-exec',
      args: ['-f', endpointProfile, ...command], env })
  }
  return { runtimeDir, start }
}

export async function structuredGeneration(root: string, readerRuntime?: FrozenReaderRuntime, hosted?: ManagedCodexFrozenRuntime): Promise<{ endpoint: CodexGenerationEndpoint; runtimeDir: string }> {
  const { runtimeDir, start } = prepareStructuredRealm(root, readerRuntime, hosted)
  const socketDirectory = join('/private/tmp', `spex-ro-${createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)}`)
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
  return { endpoint: await ensureCodexCurrentGeneration(runtimeDir, start, { socketDirectory }), runtimeDir }
}
