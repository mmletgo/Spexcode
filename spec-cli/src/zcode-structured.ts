import { zcodeReplay as managerZCodeReplay } from '../llm-manager/native-runtime.mjs'
import { managedRoute } from './llm-manager-route.js'
import { loadManagerNativeRuntime } from './llm-manager-host.js'
import { nativeWorktreeLaunch, sampleNativeWorktreeProcesses, nativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt, type ProcessIdentity } from '@spexcode/spec-core'
import { rejectedFinalOutput, structuredExecutionTimer, StructuredSessionError, structuredExecutionPolicy, structuredRealmRoot, structuredSeatbeltProfile, type NativeTokenUsage, type StructuredExecution } from './session-structured-policy.js'
import type { ZCodeFrozenNativeAdapter, ZCodeFrozenReadProof, ZCodeFrozenWitness } from './zcode-frozen-evidence.js'

type ZCodeCapability = Readonly<{
  cliVersion: string; cliSha256: string; builtinSha256: string; builtinPath: string; tool: string
}>
export type ZCodeNativeState = { version: 1 | 2 | 3; root: string; sessionId: string; inputId: string; pid?: number; receiptFile?: string; turnId?: string }
export type ZCodeStructuredExecution = Omit<StructuredExecution, 'version' | 'policy' | 'frozenReadProof'> & {
  version: 4 | 5 | 6; policy: 'zcode-frozen-read-only-v1' | 'native-worktree-v1'; zcodeNative?: ZCodeNativeState; frozenReadProof?: ZCodeFrozenReadProof
}
type NativeCallbacks = { onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onNative(state: ZCodeNativeState): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type WorktreeNativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never; nativeTokenUsage?: NativeTokenUsage }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: ZCodeFrozenReadProof }
type NativeEvent = { sessionId: string; turnId?: string; seq: number; eventId: string; type: string; payload: Record<string, unknown>; nativeTokenUsage?: NativeTokenUsage }
type NativeMessage = { info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }
type WorktreeCompletionEvidence = { terminal: NativeEvent; events: NativeEvent[]; messages: NativeMessage[]; exit: StopEvidence; send: unknown }
type NativeModel = { providerId: string; modelId: string; options?: Record<string, unknown> }
type NativeSelection = { model: NativeModel; thoughtLevel?: string }
type NativeConfigSelection = { model?: NativeModel; thoughtLevel?: string }
type ModelSnapshot = { session?: { sessionId: string; model?: NativeModel }; settings?: { model?: { current?: NativeModel }; thoughtLevel?: { current?: string; available?: { label: string; value: string }[] } } }
type IdleSnapshot = { session?: { sessionId: string; status: string }; runtime?: { activeTurnId?: string; activeTurnKind?: string; pendingRequestIds?: string[] }; projection?: { currentTurnId?: string; status?: string; pendingPermissions?: { requestId?: string; toolCallId?: string }[]; activeToolCalls?: { toolCallId: string; toolName: string; status: string }[] } }
type NativePermissionRequest = { sessionId?: string; toolName?: string; input?: { file_path?: string; path?: string } }
type NativePermissionScope = { access: 'read' } | { access: 'edit'; path: string }
type PublicCliIdentity = { cliSha256: string; builtinPath?: string; builtinSha256?: string }
type NativePlan = ZCodeNativeState & NativeConfigSelection & PublicCliIdentity & { nativeConfiguration?: 'cli-config-v1'; toolDenylist?: readonly string[]; worktreeProcessBaseline?: 1; requestDigest: string; policyDigest: string; cliPath: string; cliVersion: string; queryId: string; runtime: string; tmp: string; workspace: string; receiptFile: string; modelSnapshotDigest?: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type StopEvidence = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; acknowledged: boolean; idle: boolean; closed: boolean; stderrBytes: number; stderrSha256: string }
type Completed = { plan: NativePlan; witness: ZCodeFrozenWitness; result: NativeResult }
type NativeSend = { sessionId: string; inputId: string; content: string; modelSelection: NativeModel; toolDenylist?: readonly string[] }
type ManagerZCodeError = Error & { threadId?: string; turnId?: string; code: ConstructorParameters<typeof StructuredSessionError>[0]; detail: { threadId?: string; turnId?: string } }
type NativeIdleObservation = { idle: boolean; observed: Record<string, unknown> }
type ManagerZCodeSession = {
  open(input: { workspace: string; selection: NativeConfigSelection; mode: 'read' | 'edit'; frozenReader?: { command: string; args: string[] }; generic: boolean }, onCreated: (sessionId: string) => Promise<void>):
    Promise<{ selection: NativeConfigSelection; modelSnapshot: { sessionId: string; model: NativeModel; thoughtLevel?: string } }>
  send(input: NativeSend, queryId: string): Promise<void>
  poll(observation: {
    sent: boolean; model?: NativeModel; beforePoll(): Promise<void>; onTurn(id: string): Promise<void>
    onTerminal(event: NativeEvent): void; onEvents(events: NativeEvent[], counts: Record<string, number>): void
  }, canRetry?: () => boolean): Promise<NativeEvent | undefined>
  messages(): Promise<NativeMessage[]>
  stop(): Promise<void>
  readIdle(turnId?: string): Promise<NativeIdleObservation>
  closeSession(): Promise<boolean>
  close(): void
}
type ManagerZCodeAdapter = Pick<ZCodeFrozenNativeAdapter, 'observeZCodeFrozenReadTurn' | 'decodeZCodeJsonText' | 'zcodeMcpClientMatches' | 'assertZCodeMcpRequestContext'> & {
  ZCodeProtocolError: abstract new (...args: never[]) => ManagerZCodeError
  ZCodeNativeTurnFailedError: new (sessionId: string, turnId: string, code: unknown, worktree: boolean, attribution?: unknown) => ManagerZCodeError
  zcodeCapability: ZCodeCapability
  zcodeNoninteractiveReadInstruction: string
  inspectZCodeCliVersion(launch: ReturnType<typeof nativeWorktreeLaunch> & { cwd: string; env: NodeJS.ProcessEnv }, nativeConfiguration: boolean): string
  zcodeLaunchIdentity(cliPath: string, nativeConfiguration: boolean): PublicCliIdentity
  zcodeLaunchIdentityMatches(plan: NativePlan, nativeConfiguration: boolean): boolean
  zcodeAppServerArgs(workspace: string): string[]
  zcodeNativeIdentity(): { sessionId: string; inputId: string; queryId: string }
  zcodeNativeSelection(model: string | undefined, effort?: string): NativeSelection
  zcodeNativeConfigSelection(model: string | undefined, effort?: string, resolvedModel?: string): NativeConfigSelection
  zcodeNativeConfigModel(model: string | undefined): NativeModel | undefined
  zcodePlanModelMatches(plan: NativePlan, model: NativeConfigSelection, state: { generic: boolean; sent: boolean }): boolean
  assertZCodeModelSnapshot(snapshot: ModelSnapshot, expected: NativeConfigSelection, generic?: boolean): void
  zcodeWorktreeConfiguration(): Record<string, unknown>
  zcodeRuntimeConfiguration(): Record<string, unknown>
  prepareZCodeRuntime(input: { home: string; hostHome: string; tmp: string; path: string; worktree: boolean }): {
    config: string; protectedPaths: string[]; env: NodeJS.ProcessEnv
  }
  zcodeSendInput(plan: NativePlan, content: string): NativeSend
  connectZCodeStructuredSession(streams: { stdin: Writable; stdout: Readable }, options: {
    identity: Pick<NativePlan, 'sessionId' | 'inputId' | 'queryId'>; worktree: boolean; managed: boolean;
    permission?(scope: NativePermissionScope | undefined): 'allow' | 'deny'; onProtocolError(error: ManagerZCodeError): void; isEnded(): boolean
  }): ManagerZCodeSession
  zcodePermissionScope(request: NativePermissionRequest, sessionId: string): NativePermissionScope | undefined
  zcodeIdleObservation(snapshot: IdleSnapshot, identity: { sessionId: string; turnId?: string }): NativeIdleObservation
  zcodeSuccessfulTerminal(plan: NativePlan, terminal: NativeEvent | undefined): string | undefined
  zcodeWorktreeResponse(evidence: { identity: NativePlan; model: NativeModel; prompt: string; terminal: NativeEvent; events: NativeEvent[]; messages: NativeMessage[] }): { text: string }
  decodeZCodeStructuredText(text: string): unknown
  zcodeProofEvent(event: NativeEvent): NativeEvent | undefined
  zcodeProtocolLine(packet: Record<string, unknown>): string
}
type ManagerZCodeErrors = Pick<ManagerZCodeAdapter, 'ZCodeProtocolError' | 'ZCodeNativeTurnFailedError'>
type ManagerZCodeReplay = ManagerZCodeErrors & Pick<ManagerZCodeAdapter,
  'zcodeCapability' | 'zcodeNativeSelection' | 'zcodeNativeConfigSelection' | 'zcodePlanModelMatches' | 'zcodeSendInput'
  | 'zcodeLaunchIdentityMatches' | 'zcodeNoninteractiveReadInstruction' | 'zcodeSuccessfulTerminal' | 'zcodeWorktreeResponse' | 'decodeZCodeStructuredText'> & {
  zcodeNativeModel(model: string | undefined): { providerId: string; modelId: string }
  zcodeIsTerminal(event: NativeEvent): boolean
  zcodeWorktreeTurnMatches(plan: NativePlan, snapshot: { sessionId: string; model: NativeModel }, events: NativeEvent[], terminals: NativeEvent[], terminal: NativeEvent): plan is NativePlan & { model: NativeModel }
  isZCodeProviderRejection(failure?: { code: string; message: string } | null): boolean
  zcodeReplayTerminal(terminal: NativeEvent):
    | { kind: 'failed'; pipeFailure: boolean; providerInputRejection: boolean; publicHttp429: boolean }
    | { kind: 'completed'; result: 'success' | 'cancelled' | 'other'; hasResponse: boolean }
    | { kind: 'other' }
  isZCodeEventsRpcTimeout(execution: Pick<StructuredExecution, 'state' | 'errorCode' | 'error'>): boolean
}

const replay = managerZCodeReplay as ManagerZCodeReplay
export const { zcodeCapability, isZCodeProviderRejection, isZCodeEventsRpcTimeout } = replay
const { zcodeReplayTerminal, zcodeIsTerminal, zcodeWorktreeTurnMatches } = replay

export async function loadZCodeNativeAdapter(runtime?: Awaited<ReturnType<typeof loadManagerNativeRuntime>>): Promise<ManagerZCodeAdapter> {
  const adapter = await (runtime ?? await loadManagerNativeRuntime()).loadNativeAdapter('zcode') as ManagerZCodeAdapter
  if (typeof adapter?.connectZCodeStructuredSession !== 'function') throw new StructuredSessionError('unsupported', 'Installed LLM Manager ZCode native adapter is incompatible')
  return adapter
}

function zcodeHostError(adapter: ManagerZCodeErrors, error: unknown): unknown {
  if (error instanceof adapter.ZCodeNativeTurnFailedError) return new ZCodeNativeTurnFailedError(error.code, error.message, error.detail)
  if (error instanceof adapter.ZCodeProtocolError) return new StructuredSessionError(error.code, error.message, error.detail)
  return error
}

function zcodeAdapterValue<T>(adapter: ManagerZCodeErrors, read: () => T): T {
  try { return read() } catch (error) { throw zcodeHostError(adapter, error) }
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytesDigest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const active = new Map<string, { interrupt(): void }>()
const fixedPolicy = (execution: ZCodeStructuredExecution) => execution.policy === 'native-worktree-v1' ? structuredExecutionPolicy(execution) : ({ ...structuredExecutionPolicy(execution), version: execution.timeoutMs === null ? 5 : 4, policy: 'zcode-frozen-read-only-v1' })
const UNPUBLISHED_ZCODE_LAUNCH = 'ZCode spawned ownership could not be durably published; exact stop is required'

export class ZCodeNativeTurnFailedError extends StructuredSessionError {}

/** 原业务正文逐字保留；唯一原生user输入前置固定、只读的精确JSON schema控制段。 */
export function zcodeStructuredPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `SpexCode structured-output contract (read-only control):\nReturn exactly one JSON value matching the JSON Schema below. Do not add prose or Markdown.\nJSON Schema: ${JSON.stringify(schema)}\nEnd of structured-output contract.\n\n${prompt}`
}

/** 只有新请求冻结的非交互策略增加控制段；历史请求保留原输入字节。 */
function zcodeExecutionPrompt(prompt: string, execution: ZCodeStructuredExecution, adapter?: ManagerZCodeAdapter): string {
  return execution.policy === 'native-worktree-v1' ? `${execution.zcodeToolPolicy ? (adapter ?? replay).zcodeNoninteractiveReadInstruction : ''}Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}` : zcodeStructuredPrompt(prompt, execution.schema)
}

function requestedModel(execution: ZCodeStructuredExecution, adapter?: ManagerZCodeAdapter): NativeConfigSelection {
  const provider = adapter ?? replay
  return zcodeAdapterValue(provider, () => execution.nativeConfiguration === 'cli-config-v1'
    ? provider.zcodeNativeConfigSelection(execution.model, execution.effort, execution.model?.startsWith('zcode:') ? managedRoute(execution.model)?.model : undefined)
    : provider.zcodeNativeSelection(execution.model, execution.effort))
}

function requestDigest(prompt: string, execution: ZCodeStructuredExecution, adapter?: ManagerZCodeAdapter): string {
  return digest({ prompt, nativePrompt: zcodeExecutionPrompt(prompt, execution, adapter), policy: fixedPolicy(execution), selection: requestedModel(execution, adapter), ...(execution.zcodeToolPolicy ? { toolDenylist: execution.zcodeToolPolicy.toolDenylist } : {}) })
}

function nativeSend(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution, adapter?: ManagerZCodeAdapter): NativeSend {
  return (adapter ?? replay).zcodeSendInput(plan, zcodeExecutionPrompt(prompt, execution, adapter))
}

/** 同步路由与历史请求认证保持原命名空间解码。 */
export function zcodeNativeModel(model: string | undefined): { providerId: string; modelId: string } {
  return zcodeAdapterValue(replay, () => replay.zcodeNativeModel(model))
}

/** 固定公开builtin只证明此模型的high语义；create两个正式字段均显式绑定。 */
export function zcodeNativeSelection(model: string | undefined, effort?: StructuredExecution['effort']): NativeSelection {
  return zcodeAdapterValue(replay, () => replay.zcodeNativeSelection(model, effort))
}

/** 新配置将显式模型与努力级别交给 SDK，默认模型由创建后的原生快照解析。 */
export function zcodeNativeConfigSelection(model: string | undefined, effort?: StructuredExecution['effort']): NativeConfigSelection {
  return zcodeAdapterValue(replay, () => replay.zcodeNativeConfigSelection(model, effort, model?.startsWith('zcode:') ? managedRoute(model)?.model : undefined))
}

/** 依据任务授权和路径约束裁决 Manager 已解码的权限请求。 */
export function zcodeWorktreePermission(scope: NativePermissionScope | undefined, worktreePath: string, mode: 'read' | 'edit'): 'allow' | 'deny' {
  if (!scope) return 'deny'
  if (scope.access === 'read') return 'allow'
  if (mode === 'read') return 'deny'
  const target = resolve(worktreePath, scope.path), root = resolve(worktreePath)
  return target === root || target.startsWith(root + sep) ? 'allow' : 'deny'
}

function writeJson(path: string, value: unknown, immutable = false): void {
  const bytes = JSON.stringify(value)
  if (immutable && existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new StructuredSessionError('stale_result', 'ZCode immutable native evidence differs')
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, bytes, { mode: immutable ? 0o400 : 0o600 }); renameSync(temporary, path)
}

/** 宿主只读ps元数据补充reader内不可用的startToken，不读取命令行或认证参数。 */
async function sampleOwnedProcesses(plan: NativePlan, deadline?: number): Promise<ProcessIdentity[]> {
  if (plan.worktreeProcessBaseline === 1) {
    await sampleNativeWorktreeProcesses(plan, deadline)
    return JSON.parse(readFileSync(join(plan.root, 'owned-processes.json'), 'utf8')) as ProcessIdentity[]
  }
  const saved = join(plan.root, 'owned-processes.json')
  const owned = new Map((existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) as ProcessIdentity[] : []).map(item => [item.pid, item]))
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new StructuredSessionError('cancellation_pending', 'ZCode owned process observation is unavailable')
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) throw new StructuredSessionError('cancellation_pending', 'ZCode process observation has an unknown shape')
    return { pid: Number(match[1]), ppid: Number(match[2]), startToken: match[3].replace(/\s+/g, ' ') }
  })
  const queue = [plan.pid!], seen = new Set<number>()
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find(item => item.pid === pid), old = owned.get(pid)
    if (old && row && old.startToken !== row.startToken) continue
    if (row) owned.set(pid, { pid, startToken: row.startToken })
    queue.push(...rows.filter(item => item.ppid === pid).map(item => item.pid))
  }
  const identities = [...owned.values()]
  writeJson(saved, identities)
  return identities
}

function processIdentityState(identity: ProcessIdentity): 'live' | 'gone' | 'unknown' {
  const start = processStartToken(identity.pid)?.replace(/\s+/g, ' ')
  if (start) return start === identity.startToken ? 'live' : 'gone'
  try { process.kill(identity.pid, 0); return 'unknown' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown' }
}

/** 整组、宿主观察后代与实际reader记录分别核死亡；缺身份不取得冷取消权限。 */
async function ownedProcessesStopped(plan: NativePlan, terminate = false, deadline?: number): Promise<boolean> {
  if (plan.worktreeProcessBaseline === 1) return nativeWorktreeProcessesStopped(plan, terminate, deadline)
  if (!plan.pid || !existsSync(join(plan.root, 'owned-processes.json'))) return false
  const owned = JSON.parse(readFileSync(join(plan.root, 'owned-processes.json'), 'utf8')) as ProcessIdentity[]
  const ledger = join(plan.runtime, 'frozen-mcp', 'mcp-public.jsonl')
  const records = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; pid?: number; startToken?: string }) : []
  let stopped = detachedRuntimeIsGone(plan.pid, plan.receiptFile)
  for (const record of records.filter(item => item.type === 'process')) {
    if (!record.pid) return false
    if (!owned.some(item => item.pid === record.pid)) {
      if (record.startToken) owned.push({ pid: record.pid, startToken: record.startToken.replace(/\s+/g, ' ') })
      else {
        try { process.kill(record.pid, 0); return false }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
      }
    }
  }
  for (const identity of owned) {
    const state = processIdentityState(identity)
    if (state === 'gone') continue
    stopped = false
    if (terminate && state === 'live') {
      if (deadline !== undefined && Date.now() >= deadline) return false
      try { process.kill(identity.pid, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return stopped
}

function verifyPlan(plan: NativePlan, root: string, prompt: string | undefined, execution: ZCodeStructuredExecution, unpublishedLaunch = false, adapter?: ManagerZCodeAdapter): void {
  const native = execution.zcodeNative
  const generic = execution.nativeConfiguration === 'cli-config-v1'
  const requested = requestedModel(execution, adapter)
  const sent = existsSync(join(root, 'send.json'))
  const expectedVersion = generic ? 3 : execution.zcodeToolPolicy ? 2 : 1
  const runtimeIdentityValid = (adapter ?? replay).zcodeLaunchIdentityMatches(plan, generic)
  const selectionMatches = (adapter ?? replay).zcodePlanModelMatches(plan, requested, { generic, sent })
  if (plan.version !== expectedVersion || native?.version !== plan.version || plan.nativeConfiguration !== execution.nativeConfiguration || !isDeepStrictEqual(plan.toolDenylist, execution.zcodeToolPolicy?.toolDenylist)
    || execution.policy === 'native-worktree-v1' && plan.worktreeProcessBaseline !== 1 || plan.root !== root || native?.root !== root || plan.sessionId !== native.sessionId || plan.inputId !== native.inputId
    || plan.policyDigest !== digest(fixedPolicy(execution)) || prompt !== undefined && plan.requestDigest !== requestDigest(prompt, execution, adapter)
    || !runtimeIdentityValid || !selectionMatches || native.turnId && native.turnId !== plan.turnId || !unpublishedLaunch && native.pid !== plan.pid || native.receiptFile && native.receiptFile !== plan.receiptFile
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== plan.turnId)
    throw new StructuredSessionError('stale_result', 'ZCode fixed native plan or durable identity differs')
  if (sent && (!plan.modelSnapshotDigest || !existsSync(join(root, 'model-snapshot.json')) || plan.modelSnapshotDigest !== digest(JSON.parse(readFileSync(join(root, 'model-snapshot.json'), 'utf8'))))) throw new StructuredSessionError('stale_result', 'ZCode saved pre-send model selection differs')
  if (prompt !== undefined && sent && digest(JSON.parse(readFileSync(join(root, 'send.json'), 'utf8'))) !== digest(nativeSend(plan, prompt, execution, adapter))) throw new StructuredSessionError('stale_result', 'ZCode original send differs from the exact native schema/prompt input')
}

/** 从原公开证据冷验指定 P1 角色的 provider EPIPE 和进程停止。 */
export function assertZCodeSettledProviderFailure(sessionId: string, prompt: string, execution: ZCodeStructuredExecution, worktreePath: string, purpose: 'elaboration_generate' | 'elaboration_review', options?: { crossProviderRetry: boolean }): void {
  const native = execution.zcodeNative, realm = structuredRealmRoot(execution)
  if (execution.version !== 6 || execution.purpose !== purpose || execution.worktree?.mode !== (purpose === 'elaboration_generate' ? 'edit' : 'read') || !realm || !native
    || native.root !== join(realm, sessionId) || execution.state !== 'failed' || execution.errorCode !== 'unsupported' || !execution.turnStartRequested
    || execution.cancellation?.nativeStopped !== true || execution.cancellation.nativeStatus !== 'stopped' || existsSync(join(native.root, 'completed.json')))
    throw new StructuredSessionError('stale_result', 'ZCode provider continuation requires its original settled P1 role and failure')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(native.root, name), 'utf8'))
  const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const isEvent = (value: unknown): value is NativeEvent => isRecord(value) && isRecord(value.payload)
  const savedPlan = read('plan.json'), send = read('send.json'), snapshot = read('model-snapshot.json')
  const events = read('events.json'), terminal = read('terminal.json'), exit = read('exit.json')
  if (!isRecord(savedPlan) || !isRecord(send) || !isRecord(snapshot) || !isRecord(snapshot.model)
    || !Array.isArray(events) || !events.every(isEvent) || !isEvent(terminal) || !isRecord(exit))
    throw new StructuredSessionError('stale_result', 'ZCode provider failure has malformed original native evidence')
  const plan = savedPlan as NativePlan
  verifyPlan(plan, native.root, prompt, execution)
  if (plan.workspace !== worktreePath || !plan.pid || plan.receiptFile !== join(native.root, 'process.json') || !detachedRuntimeIsGone(plan.pid, plan.receiptFile))
    throw new StructuredSessionError('stale_result', 'ZCode provider failure differs from its original workspace or stopped process group')
  const terminals = events.filter(zcodeIsTerminal)
  const observed = zcodeReplayTerminal(terminal)
  if (digest(send) !== digest(nativeSend(plan, prompt, execution)) || !zcodeWorktreeTurnMatches(plan, snapshot as { sessionId: string; model: NativeModel }, events, terminals, terminal)
    || observed.kind !== 'failed' || !observed.providerInputRejection
    || options?.crossProviderRetry && observed.publicHttp429
    || exit.stopped !== true || exit.code !== 0 || exit.signal !== null || exit.idle !== false || exit.closed !== false || exit.acknowledged !== execution.cancellation.acknowledged)
    throw new StructuredSessionError('stale_result', 'ZCode provider failure lacks its exact input, failure attribution or exit evidence')
}

/** 只读核原任务与公开终态。 */
export function assertZCodeStoppedDraftSource(prompt: string, execution: ZCodeStructuredExecution, worktreePath: string, mode?: 'unpublished-completion' | 'cancelled-commit' | 'p1-cross-provider-retry'): boolean | 'cancelled-commit' | null {
  const native = execution.zcodeNative
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('zcode:') || execution.worktree?.mode !== 'edit' || !native || !['failed', 'cancelled'].includes(execution.state ?? '') || !execution.cancellation?.nativeStopped)
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft requires its original stopped native worktree')
  const completedPath = join(native.root, 'completed.json')
  const sealed = existsSync(completedPath)
  if (sealed && (mode !== 'unpublished-completion' || execution.state !== 'cancelled' || execution.errorCode !== undefined || execution.output !== undefined || execution.resultDigest !== undefined || execution.resultWorktree || execution.failedWorktree || execution.rejectedOutput))
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft requires its original stopped native worktree')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(native.root, name), 'utf8'))
  const plan = read('plan.json') as NativePlan
  verifyPlan(plan, native.root, prompt, execution)
  if (plan.workspace !== worktreePath || !plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) throw new StructuredSessionError('stale_result', 'stopped ZCode draft differs from its exact workspace/process')
  const send = read('send.json'), snapshot = read('model-snapshot.json') as { sessionId: string; model: NativeModel }, events = read('events.json') as NativeEvent[]
  const terminals = events.filter(zcodeIsTerminal)
  const completedEventsRpc = isZCodeEventsRpcTimeout(execution)
  let terminal: NativeEvent
  try { terminal = read('terminal.json') as NativeEvent }
  catch (error) {
    const cancelledWithoutTerminal = execution.state === 'cancelled' && execution.errorCode === undefined && !sealed && terminals.length === 0
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (completedEventsRpc || cancelledWithoutTerminal)) return null
    throw error
  }
  let exit: StopEvidence
  try { exit = read('exit.json') as StopEvidence }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (sealed) throw new StructuredSessionError('stale_result', 'ZCode unpublished completion lacks its original exit evidence')
    return null
  }
  const observed = zcodeReplayTerminal(terminal)
  const nonSuccess = completedEventsRpc && (observed.kind !== 'completed' || observed.result === 'cancelled' && observed.hasResponse)
  const exitMatches = nonSuccess ? exit.stopped === true && (exit.code === null || Number.isSafeInteger(exit.code) && exit.code >= 0)
    && (exit.signal === null || exit.code === null && typeof exit.signal === 'string' && Object.hasOwn(constants.signals, exit.signal)) : !!exit.stopped && exit.code === 0 && exit.signal === null
  const unfinishedFailureExit = !sealed && execution.state === 'failed' && execution.errorCode === undefined && observed.kind === 'failed'
    && exit.code === null && exit.signal === null && exit.stopped === false && exit.acknowledged === false && exit.idle === false && exit.closed === false
  if (digest(send) !== digest(nativeSend(plan, prompt, execution)) || !zcodeWorktreeTurnMatches(plan, snapshot, events, terminals, terminal) || !(exitMatches || unfinishedFailureExit))
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft lost its original model/input/terminal/exit identity')
  if (unfinishedFailureExit) return null
  if (sealed) {
    const messages = read('messages.json') as NativeMessage[]
    const { completed } = verifyWorktreeCompletion(plan, plan.model, prompt, execution, { terminal, events, messages, exit, send }, true)
    if (readFileSync(completedPath, 'utf8') !== JSON.stringify(completed)) throw new StructuredSessionError('stale_result', 'ZCode immutable native evidence differs')
    return null
  }
  if (nonSuccess) return null
  const cancelledCommit = mode === 'cancelled-commit' && execution.state === 'cancelled' && execution.errorCode === undefined
    && execution.turnStartRequested === true && execution.cancellation.nativeStatus === 'stopped' && execution.cancellation.acknowledged === true
    && observed.kind === 'completed' && observed.result === 'cancelled'
  if (completedEventsRpc || cancelledCommit) {
    let idle: { sessionId: string; turnId: string; idle: boolean }
    try { idle = read('idle.json') as typeof idle }
    catch (error) { if (cancelledCommit && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    const normalExit = idle.sessionId === plan.sessionId && idle.turnId === plan.turnId && idle.idle === true
      && exit.idle === true && exit.closed === true && exit.stopped === true && observed.kind === 'completed' && observed.hasResponse
    if (cancelledCommit) return normalExit && exit.acknowledged === true ? 'cancelled-commit' : false
    if (!normalExit || observed.result !== 'success')
      throw new StructuredSessionError('stale_result', 'ZCode events RPC draft has no exact completed terminal and idle/closed stop')
    return true
  }
  if (execution.errorCode === 'native_turn_transport_failed' && (observed.kind !== 'failed' || !observed.pipeFailure)) throw new StructuredSessionError('stale_result', 'ZCode turn transport failure differs from the original EPIPE terminal')
  if (mode === 'p1-cross-provider-retry' && execution.purpose === 'elaboration_generate' && execution.state === 'failed' && execution.errorCode === undefined
    && execution.cancellation.nativeStatus === 'stopped' && exit.stopped === true && observed.kind === 'failed' && observed.publicHttp429) return null
  return observed.kind === 'failed'
}

function verifyWorktreeCompletion(plan: NativePlan, model: NativeModel, prompt: string, execution: ZCodeStructuredExecution, evidence: WorktreeCompletionEvidence, strictCompleted: boolean, adapter?: ManagerZCodeAdapter) {
  const { terminal, events, messages, exit, send } = evidence
  if (!plan.turnId || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null) throw new StructuredSessionError('stale_result', 'ZCode worktree exact native model/terminal/process evidence differs')
  const provider = adapter ?? replay
  const nativePrompt = zcodeExecutionPrompt(prompt, execution, adapter)
  const response = zcodeAdapterValue(provider, () => provider.zcodeWorktreeResponse({ identity: plan, model, prompt: nativePrompt, terminal, events, messages })).text
  const { nativeTokenUsage } = terminal
  let output: unknown
  try { output = zcodeAdapterValue(provider, () => provider.decodeZCodeStructuredText(response)) }
  catch (error) {
    if (strictCompleted && error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal response is not one strict JSON document')
    if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw new StructuredSessionError(error.code, error.message, { threadId: plan.sessionId, turnId: plan.turnId, nativeTokenUsage, rejectedOutput: rejectedFinalOutput(response, prompt, execution, { threadId: plan.sessionId, turnId: plan.turnId }) })
    throw error
  }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(output)) {
    if (strictCompleted) throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal JSON no longer matches its schema')
    const diagnostics = validate.errors?.map(({ instancePath, schemaPath, keyword, params, message }) => ({ instancePath, schemaPath, keyword, params, message })) ?? []
    throw new StructuredSessionError('structured_output_format_invalid', `ZCode worktree terminal JSON does not match its schema: ${JSON.stringify(diagnostics)}`, { threadId: plan.sessionId, turnId: plan.turnId, nativeTokenUsage, rejectedOutput: rejectedFinalOutput(response, prompt, execution, { threadId: plan.sessionId, turnId: plan.turnId }) })
  }
  const result: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.turnId, text: JSON.stringify(output) }
  return { completed: { plan, terminal, events, messages, exit, send, result }, output }
}

async function settleWorktreeResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution, freshStopDeadline?: number, adapter?: ManagerZCodeAdapter): Promise<WorktreeNativeResult> {
  verifyPlan(plan, plan.root, prompt, execution, false, adapter)
  const model = plan.model
  if (!model) throw new StructuredSessionError('stale_result', 'ZCode worktree plan has no actual model selection')
  // 本次调用写 exit 前已做最终停止观察。未结算的冷重放不能借用这次观察。
  if (freshStopDeadline === undefined && execution.state !== 'completed' && !(await ownedProcessesStopped(plan))) throw new StructuredSessionError('cancellation_pending', 'ZCode worktree native or unknown orphan stop remains unproven')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(plan.root, name), 'utf8'))
  const terminal = read('terminal.json') as NativeEvent, events = read('events.json') as NativeEvent[], messages = read('messages.json') as NativeMessage[]
  const exit = read('exit.json') as StopEvidence, send = read('send.json')
  const { completed, output } = verifyWorktreeCompletion(plan, model, prompt, execution, { terminal, events, messages, exit, send }, execution.state === 'completed', adapter)
  const { result } = completed
  const path = join(plan.root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== result.threadId || execution.turnId !== result.turnId || execution.resultDigest !== digest(output))) throw new StructuredSessionError('stale_result', 'ZCode worktree durable completed identity differs')
  if (freshStopDeadline !== undefined && Date.now() >= freshStopDeadline) throw new StructuredSessionError('cancellation_pending', 'ZCode completion exceeded the original stop deadline')
  writeJson(path, completed, true)
  return terminal.nativeTokenUsage ? { ...result, nativeTokenUsage: terminal.nativeTokenUsage } : result
}

async function settleResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution, adapter?: ManagerZCodeAdapter): Promise<NativeResult> {
  const provider = adapter ?? replay
  const terminal = JSON.parse(readFileSync(join(plan.root, 'terminal.json'), 'utf8')) as NativeEvent
  const exit = JSON.parse(readFileSync(join(plan.root, 'exit.json'), 'utf8')) as StopEvidence
  const messages = JSON.parse(readFileSync(join(plan.root, 'messages.json'), 'utf8')) as unknown[]
  const events = JSON.parse(readFileSync(join(plan.root, 'events.json'), 'utf8')) as NativeEvent[]
  const send = JSON.parse(readFileSync(join(plan.root, 'send.json'), 'utf8')) as { sessionId: string; content: string; inputId: string }
  const response = provider.zcodeSuccessfulTerminal(plan, terminal)
  if (!plan.turnId || response === undefined || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null)
    throw new StructuredSessionError('failed', 'ZCode has no exact successful terminal, close and complete native stop')
  const mcpPath = join(plan.runtime, 'frozen-mcp', 'mcp-public.jsonl')
  const records = readFileSync(mcpPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const model = plan.model
  if (!model) throw new StructuredSessionError('stale_result', 'ZCode frozen plan has no exact model selection')
  const witness = { version: 1, provider: 'zcode', cliVersion: plan.cliVersion, cliSha256: plan.cliSha256, providerId: model.providerId, modelId: model.modelId, sessionId: plan.sessionId, turnId: plan.turnId, inputId: plan.inputId, prompt: zcodeExecutionPrompt(prompt, execution), send, messages, events,
    mcpHistory: { records, digest: digest(records) } } as ZCodeFrozenWitness
  if (!events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode terminal differs from its original native events')
  const { proveZCodeFrozenReads } = await import('./zcode-frozen-evidence.js')
  const frozenReadProof = proveZCodeFrozenReads(execution.frozenContext!, witness, adapter)
  const output = zcodeAdapterValue(provider, () => provider.decodeZCodeStructuredText(response))
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(output)) throw new StructuredSessionError('failed', 'ZCode terminal JSON does not match the pinned JSON schema')
  const result: NativeResult = { threadId: plan.sessionId, turnId: plan.turnId, text: JSON.stringify(output), frozenReadProof }
  writeJson(join(plan.root, 'witness.json'), witness, true)
  writeJson(join(plan.root, 'completed.json'), { plan, witness, result } satisfies Completed, true)
  return result
}

async function completedResult(root: string, prompt: string, execution: ZCodeStructuredExecution): Promise<NativeResult | null> {
  if (!existsSync(join(root, 'plan.json'))) return null
  const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan
  verifyPlan(plan, root, prompt, execution)
  const model = plan.model
  if (!model) throw new StructuredSessionError('stale_result', 'ZCode frozen plan has no exact model selection')
  const path = join(root, 'completed.json')
  if (!existsSync(path)) {
    if (!['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) || !(await ownedProcessesStopped(plan))) return null
    const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as StopEvidence
    const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as NativeEvent
    const observed = zcodeReplayTerminal(terminal)
    if (!exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null || observed.kind !== 'completed' || observed.result !== 'success') return null
    return settleResult(plan, prompt, execution)
  }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Completed
  const nativePrompt = zcodeExecutionPrompt(prompt, execution)
  const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as StopEvidence
  const mcpRecords = readFileSync(join(plan.runtime, 'frozen-mcp/mcp-public.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  if (digest(saved.plan) !== digest(plan) || digest(saved.witness) !== digest(JSON.parse(readFileSync(join(root, 'witness.json'), 'utf8')))
    || saved.witness.prompt !== nativePrompt || digest(saved.witness.messages) !== digest(JSON.parse(readFileSync(join(root, 'messages.json'), 'utf8')))
    || digest(saved.witness.events) !== digest(JSON.parse(readFileSync(join(root, 'events.json'), 'utf8'))) || saved.witness.mcpHistory.digest !== digest(mcpRecords)
    || digest(saved.witness) !== saved.result.frozenReadProof.witnessDigest
    || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null)
    throw new StructuredSessionError('stale_result', 'ZCode completion cache differs from original native evidence')
  const { verifyZCodeFrozenReadProof } = await import('./zcode-frozen-evidence.js')
  const proof = saved.result.frozenReadProof
  const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as NativeEvent
  if (!saved.witness.events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode original terminal differs from completion')
  let output: unknown
  try { output = zcodeAdapterValue(replay, () => replay.decodeZCodeStructuredText(terminal.payload.response as string)) }
  catch (error) {
    if (!(error instanceof StructuredSessionError) || error.code !== 'structured_output_format_invalid') throw error
    throw new StructuredSessionError('stale_result', 'ZCode completed response is not one strict JSON document')
  }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  verifyZCodeFrozenReadProof(execution.frozenContext!, saved.result.frozenReadProof, { threadId: plan.sessionId, turnId: plan.turnId!, inputId: plan.inputId, prompt: nativePrompt }, { ...model, cliVersion: plan.cliVersion, cliSha256: plan.cliSha256 }, { output })
  if (!validate(output) || saved.result.text !== JSON.stringify(output) || saved.result.threadId !== plan.sessionId || saved.result.turnId !== plan.turnId) throw new StructuredSessionError('stale_result', 'ZCode original terminal, schema or evidence differs from completion')
  if (execution.state === 'completed') {
    if (execution.threadId !== plan.sessionId || execution.turnId !== plan.turnId || execution.resultDigest !== digest(execution.output) || execution.resultDigest !== digest(output)
      || !execution.frozenReadProof || digest(execution.frozenReadProof) !== digest(proof)) throw new StructuredSessionError('stale_result', 'ZCode durable completed result or evidence differs')
  } else if (!(await ownedProcessesStopped(plan))) return null
  return saved.result
}

/** 正式取消仅对同一固定plan及已核PID/start/receipt操作，不恢复或追加prompt。 */
export async function stopZCodeStructuredTurn(execution: ZCodeStructuredExecution, timeoutMs = 15000): Promise<StopResult> {
  const deadline = Date.now() + timeoutMs
  const native = execution.zcodeNative
  if (!native) return execution.turnStartRequested ? { nativeStopped: false, acknowledged: false, error: 'ZCode dispatch identity is unproven' } : { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const path = join(native.root, 'plan.json')
  if (!existsSync(path)) return { nativeStopped: false, acknowledged: false, error: 'ZCode exact launch plan is missing' }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as NativePlan
  const unpublishedLaunch = execution.policy === 'native-worktree-v1' && execution.state === 'cancelling' && execution.error === UNPUBLISHED_ZCODE_LAUNCH && execution.turnStartRequested === true
    && native.pid === undefined && native.receiptFile === undefined && !native.turnId && !plan.turnId && !execution.threadId && !execution.turnId
    && !existsSync(join(native.root, 'send.json')) && !existsSync(join(native.root, 'terminal.json'))
  try { verifyPlan(plan, native.root, undefined, execution, unpublishedLaunch) }
  catch { return { nativeStopped: false, acknowledged: false, error: 'ZCode fixed launch policy or native identity differs' } }
  if (!execution.turnStartRequested && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  if (!plan.pid || !unpublishedLaunch && (plan.pid !== native.pid || plan.receiptFile !== native.receiptFile)) return { nativeStopped: false, acknowledged: false, error: 'ZCode launch/process identity differs' }
  if (unpublishedLaunch) {
    const ownedPath = join(native.root, 'owned-processes.json')
    if (plan.receiptFile !== join(native.root, 'process.json') || !existsSync(ownedPath) || !detachedRuntimeIsGone(plan.pid, plan.receiptFile))
      return { nativeStopped: false, acknowledged: false, error: 'ZCode unpublished launch has no exact stopped process-group witness' }
    const receipt = JSON.parse(readFileSync(plan.receiptFile, 'utf8')) as ProcessIdentity
    const owned = JSON.parse(readFileSync(ownedPath, 'utf8')) as ProcessIdentity[]
    if (!owned.some(identity => identity.pid === plan.pid && identity.startToken === receipt.startToken.replace(/\s+/g, ' ')))
      return { nativeStopped: false, acknowledged: false, error: 'ZCode unpublished launch has no captured original leader' }
  }
  if (Date.now() >= deadline) return { nativeStopped: false, acknowledged: false, error: 'ZCode native stop deadline expired' }
  const local = unpublishedLaunch ? undefined : active.get(native.root)
  if (local) local.interrupt()
  else if (!unpublishedLaunch && !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
    if (!verifyDetachedRuntime(plan.pid, plan.receiptFile).ok) return { nativeStopped: false, acknowledged: false, error: 'ZCode detached runtime identity is unproven' }
    try { await sampleOwnedProcesses(plan, deadline) }
    catch (error) { if (error instanceof StructuredSessionError && error.code === 'cancellation_pending') return { nativeStopped: false, acknowledged: false, error: error.message }; throw error }
    if (!verifyDetachedRuntime(plan.pid, plan.receiptFile).ok || Date.now() >= deadline) return { nativeStopped: false, acknowledged: false, error: 'ZCode detached runtime identity is unproven' }
    try { process.kill(-plan.pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const stoppedProcesses = async (terminate = false): Promise<boolean> => {
    if (Date.now() >= deadline) return false
    try { const stopped = await ownedProcessesStopped(plan, terminate, deadline); return Date.now() < deadline && stopped }
    catch (error) { if (error instanceof StructuredSessionError && error.code === 'cancellation_pending') return false; throw error }
  }
  while (Date.now() < deadline && !(await stoppedProcesses(!local && !unpublishedLaunch))) await sleep(50)
  const stopped = await stoppedProcesses(), exitPath = join(native.root, 'exit.json')
  const exit = existsSync(exitPath) ? JSON.parse(readFileSync(exitPath, 'utf8')) as StopEvidence : undefined
  return { nativeStopped: stopped, acknowledged: exit?.acknowledged ?? false, nativeStatus: stopped ? 'stopped' : 'unknown', ...(!stopped ? { error: 'ZCode owned app/MCP processes remain unproven' } : {}) }
}

/** 单次真实send及原生证明共用已有结构化队列；未完成身份只允许精确取消。 */
export function zcodeStructuredTurn(realm: string, id: string, prompt: string, execution: ZCodeStructuredExecution, callbacks: NativeCallbacks): Promise<NativeResult>
// eslint-disable-next-line no-redeclare -- Preserve the legacy frozen proof return type.
export function zcodeStructuredTurn(realm: string, id: string, prompt: string, execution: ZCodeStructuredExecution, callbacks: NativeCallbacks, worktreePath: string | undefined): Promise<NativeResult | WorktreeNativeResult>
// eslint-disable-next-line no-redeclare -- TypeScript implementation of both executor modes.
export async function zcodeStructuredTurn(realm: string, id: string, prompt: string, execution: ZCodeStructuredExecution, callbacks: NativeCallbacks, worktreePath?: string): Promise<NativeResult | WorktreeNativeResult> {
  const worktree = execution.version === 6 && execution.policy === 'native-worktree-v1' && !!execution.worktree && !!worktreePath && !execution.frozenContext && !execution.readerRuntime
  const genericNativeConfiguration = execution.nativeConfiguration === 'cli-config-v1'
  if (genericNativeConfiguration && !worktree) throw new StructuredSessionError('unsupported', 'ZCode native configuration is only supported by a native worktree')
  if (!worktree && (execution.version !== (execution.timeoutMs === null ? 5 : 4) || execution.policy !== 'zcode-frozen-read-only-v1' || !execution.frozenContext || execution.readerRuntime)) throw new StructuredSessionError('unsupported', 'ZCode requires its exact isolated frozen policy')
  const root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) ? settleWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution) : null
    : await completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.zcodeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'ZCode in-progress dispatch cannot append another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'ZCode requires the verified macOS read-only sandbox')
  const runtimeAdapter = await loadManagerNativeRuntime()
  const adapter = await loadZCodeNativeAdapter(runtimeAdapter)
  // 加载期间另一次调用可能已经写入原计划。
  if (existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'ZCode in-progress dispatch cannot append another prompt; exact stop is required')
  const selection = requestedModel(execution, adapter)
  const managed = !!managedRoute(execution.model)
  const cliPath = runtimeAdapter.findNativeExecutable('zcode')
  if (!cliPath) throw new StructuredSessionError('unsupported', 'ZCode CLI is unavailable')
  const worktreeLaunch = worktree ? nativeWorktreeLaunch(worktreePath!, cliPath, []) : undefined
  const launchIdentity = zcodeAdapterValue(adapter, () => adapter.zcodeLaunchIdentity(cliPath, genericNativeConfiguration))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const runtime = join(root, 'runtime'), home = join(runtime, 'home'), ledgerRoot = join(runtime, 'frozen-mcp'), tmp = mkdtempSync(worktree ? join(tmpdir(), 'spex-zcode-tmp-') : '/private/tmp/spex-zcode-tmp-'), workspace = worktree ? worktreePath! : mkdtempSync('/private/tmp/spex-zcode-frozen-')
  for (const path of [runtime, home, ledgerRoot]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const { config, protectedPaths, env } = zcodeAdapterValue(adapter, () => adapter.prepareZCodeRuntime({
    home, hostHome: homedir(), tmp, path: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, worktree,
  }))
  const input = join(root, 'reader-input.json'), profile = join(root, 'policy.sb')
  if (!worktree) {
    writeJson(input, { root: ledgerRoot, ref: execution.frozenContext }, true)
    let policy = structuredSeatbeltProfile(realpathSync(runtime)) + `(allow file-write* (subpath ${JSON.stringify(realpathSync(tmp))}))\n`
    for (const path of [...protectedPaths, input, profile]) policy += `(deny file-write* (literal ${JSON.stringify(path)}))\n`
    writeFileSync(profile, policy, { mode: 0o400 })
  }
  const launch = worktreeLaunch ?? { command: '/usr/bin/sandbox-exec', args: ['-f', profile, cliPath] }
  const cliVersion = zcodeAdapterValue(adapter, () => adapter.inspectZCodeCliVersion({ ...launch, cwd: workspace, env }, genericNativeConfiguration))
  if (!worktree) {
    const oracle = join(root, 'outside-oracle.txt'); writeFileSync(oracle, 'UNCHANGED', { mode: 0o600 })
    const targets = { runtime: join(runtime, 'canary'), tmp: join(tmp, 'canary'), oracle, config, input, profile, frozen: execution.frozenContext!.manifestPath, workspace: join(workspace, 'forbidden-write') }
    const canaryCode = `const fs=require('node:fs'),net=require('node:net'),x=JSON.parse(process.argv[1]),r={};for(const[k,p]of Object.entries(x)){try{if(['runtime','tmp','oracle','workspace'].includes(k))fs.appendFileSync(p,'CANARY');else fs.closeSync(fs.openSync(p,'a'));r[k]=true}catch{r[k]=false}}const s=net.createServer();s.once('error',()=>{r.socket=false;process.stdout.write(JSON.stringify(r));process.exitCode=1});s.listen(process.argv[2],()=>{r.socket=true;s.close(()=>process.stdout.write(JSON.stringify(r)))})`
    const canary = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', canaryCode, JSON.stringify(targets), join(tmp, 's.sock')], { cwd: workspace, env, encoding: 'utf8', timeout: 10000 })
    let boundary: Record<string, boolean> = {}
    if (!canary.error && canary.status === 0) { try { boundary = JSON.parse(canary.stdout) as typeof boundary } catch { /* fail closed below */ } }
    if (!boundary.runtime || !boundary.tmp || !boundary.socket || Object.keys(targets).filter(key => !['runtime', 'tmp'].includes(key)).some(key => boundary[key] !== false) || readFileSync(oracle, 'utf8') !== 'UNCHANGED') throw new StructuredSessionError('unsupported', 'ZCode exact read-only write/socket boundary preflight failed')
    writeJson(join(root, 'boundary.json'), { passed: true, results: boundary, profileSha256: bytesDigest(profile) }, true)
  }
  let plan: NativePlan = { ...(worktree ? { worktreeProcessBaseline: 1 as const } : {}), version: genericNativeConfiguration ? 3 : execution.zcodeToolPolicy ? 2 : 1, ...(genericNativeConfiguration ? { nativeConfiguration: execution.nativeConfiguration } : {}), ...(execution.zcodeToolPolicy ? { toolDenylist: execution.zcodeToolPolicy.toolDenylist } : {}), root, ...adapter.zcodeNativeIdentity(), requestDigest: requestDigest(prompt, execution, adapter), policyDigest: digest(fixedPolicy(execution)), cliPath, cliVersion, ...launchIdentity, ...selection, runtime, tmp, workspace, receiptFile: join(root, 'process.json') }
  writeJson(join(root, 'plan.json'), plan)
  const native = (): ZCodeNativeState => ({ version: plan.version, root, sessionId: plan.sessionId, inputId: plan.inputId, ...(plan.pid ? { pid: plan.pid, receiptFile: plan.receiptFile } : {}), ...(plan.turnId ? { turnId: plan.turnId } : {}) })
  await callbacks.onNative(native()); await callbacks.onTurnStarting?.()
  let launchFailure: Error | undefined
  if (worktree) await sampleNativeWorktreeProcesses(plan)
  const child = runtimeAdapter.spawnNativeProcess(launch.command, [...launch.args, ...adapter.zcodeAppServerArgs(workspace)], { cwd: workspace, env })
  child.once('error', () => { launchFailure = new StructuredSessionError('cancellation_pending', 'ZCode native process failed during launch') })
  if (!child.pid) throw new StructuredSessionError('failed', 'ZCode isolated process could not start')
  const pid = child.pid
  let launchStartToken: string | undefined
  const launchStillOwned = (): boolean => {
    if (!launchStartToken) return false
    const live = verifyDetachedRuntime(pid, plan.receiptFile)
    return live.ok && live.identity.startToken === launchStartToken
  }
  let exited = false
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  try {
    launchStartToken = writeDetachedRuntimeReceipt(pid, plan.receiptFile).startToken
    plan = { ...plan, pid }; writeJson(join(root, 'plan.json'), plan)
    await callbacks.onNative(native())
    try { await sampleOwnedProcesses(plan) }
    catch (error) {
      if (!worktree || !(error instanceof StructuredSessionError) || error.code !== 'cancellation_pending' || callbacks.signal?.aborted
        || !launchStillOwned()) throw error
      await sampleOwnedProcesses(plan)
    }
  } catch {
    if (launchStillOwned()) try { process.kill(-pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', UNPUBLISHED_ZCODE_LAUNCH)
  }
  let protocolError: Error | undefined = launchFailure, abortRequested = false, timedOut = false, acknowledged = false, sessionCreated = false, sent = false, closeAcknowledged = false, idle = false
  const session = adapter.connectZCodeStructuredSession(child, {
    identity: { sessionId: plan.sessionId, inputId: plan.inputId, queryId: plan.queryId },
    worktree, managed,
    ...(worktree ? { permission: (scope: NativePermissionScope | undefined) => zcodeWorktreePermission(scope, workspace, execution.worktree!.mode) } : {}),
    onProtocolError: error => { protocolError = error },
    isEnded: () => exited,
  })
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; stderrHash.update(bytes) })
  child.once('error', () => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode native process failed') })
  let terminal: NativeEvent | undefined, stopSent = false, nativeStopped = false
  let stopAt: number | undefined
  const interrupt = (): void => { abortRequested = true }
  active.set(root, { interrupt }); callbacks.signal?.addEventListener('abort', interrupt, { once: true })
  const timeout = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true; interrupt()
    void Promise.resolve().then(() => callbacks.onTimeout?.()).catch(() => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode timeout cancellation could not be durably published') })
  })
  const poll = (deadline?: number, canRetry?: () => boolean): Promise<NativeEvent | undefined> => session.poll({
    sent, model: plan.model,
    async beforePoll() {
      await sampleOwnedProcesses(plan, deadline)
      if (deadline !== undefined && Date.now() >= deadline) throw new StructuredSessionError('cancellation_pending', 'ZCode process observation exceeded the original stop deadline')
    },
    async onTurn(turnId) {
      plan = { ...plan, turnId }; writeJson(join(root, 'plan.json'), plan); await callbacks.onNative(native()); await callbacks.onTurn(turnId)
    },
    onTerminal(event) { terminal = event; writeJson(join(root, 'terminal.json'), event, true) },
    onEvents(events, counts) {
      writeJson(join(root, 'events.json'), events); writeJson(join(root, 'event-counts.json'), counts)
    },
  }, canRetry)

  const stop = async (): Promise<void> => {
    if (stopSent || !sessionCreated || terminal) return
    stopSent = true; await session.stop(); acknowledged = true
  }
  let resultError: unknown
  try {
    let frozenReader: { command: string; args: string[] } | undefined
    if (!worktree) {
      const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
      frozenReader = { command: process.execPath, args: [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, input] }
    }
    const selected = await session.open({ workspace, selection, mode: worktree ? execution.worktree!.mode : 'read', frozenReader, generic: genericNativeConfiguration }, async sessionId => {
      sessionCreated = true; await callbacks.onThread(sessionId)
    })
    writeJson(join(root, 'model-snapshot.json'), selected.modelSnapshot, true)
    plan = { ...plan, ...selected.selection, modelSnapshotDigest: digest(selected.modelSnapshot) }; writeJson(join(root, 'plan.json'), plan)
    if (callbacks.signal?.aborted) interrupt()
    if (abortRequested) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'ZCode cancelled before send')
    verifyPlan(plan, root, prompt, { ...execution, zcodeNative: native() }, false, adapter)
    const send = nativeSend(plan, prompt, execution, adapter)
    writeJson(join(root, 'send.json'), send, true); sent = true
    await session.send(send, plan.queryId)
    let cancellationDeadline: number | undefined
    while (!terminal) {
      if (protocolError) throw protocolError
      if (abortRequested) { await stop(); cancellationDeadline ??= Date.now() + 10000 }
      await poll(undefined, () => !abortRequested && !protocolError)
      if (cancellationDeadline && Date.now() > cancellationDeadline) throw new StructuredSessionError('cancellation_pending', 'ZCode stop ACK has no bounded exact terminal')
      if (!terminal) await sleep(100)
    }
    writeJson(join(root, 'messages.json'), await session.messages(), true)
  } catch (error) { resultError = zcodeHostError(adapter, error) }
  try {
    try {
      if (sent && !terminal) {
        await stop()
        const deadline = Date.now() + 10000
        while (!terminal && Date.now() < deadline && !exited) { await poll(deadline); if (!terminal) await sleep(100) }
      }
      if (sessionCreated && (!sent || terminal)) {
        const idleWindowMs = 3000
        const deadline = Date.now() + idleWindowMs
        const observations: NativeIdleObservation[] = []
        do {
          const observation = await session.readIdle(terminal?.turnId)
          idle = observation.idle; observations.push(observation)
          writeJson(join(root, 'idle.json'), { sessionId: plan.sessionId, turnId: plan.turnId, idle, observations })
          if (!idle) await sleep(50)
        } while (!idle && Date.now() < deadline)
        if (!idle) throw new StructuredSessionError('cancellation_pending', 'ZCode exact terminal has no matching idle runtime')
        try { await sampleOwnedProcesses(plan, deadline) }
        catch (error) {
          if (!worktree || adapter.zcodeSuccessfulTerminal(plan, terminal) === undefined
            || !(error instanceof StructuredSessionError) || error.code !== 'cancellation_pending'
            || abortRequested || protocolError || resultError || !launchStillOwned()) throw error
          const retryDeadline = Date.now() + idleWindowMs
          await sleep(50)
          if (abortRequested || protocolError || exited || !launchStillOwned()) throw error
          await sampleOwnedProcesses(plan, retryDeadline)
        }
        closeAcknowledged = await session.closeSession()
      }
    } catch (error) { resultError ??= zcodeHostError(adapter, error) }
    child.stdin.end()
    let exit = await Promise.race([closed, sleep(3000).then(() => undefined)])
    stopAt = Date.now() + 3000
    const stoppedOnClose = !!exit && await ownedProcessesStopped(plan, false, stopAt)
    if (!stoppedOnClose) {
      if (verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok) {
        await sampleOwnedProcesses(plan, stopAt)
        if (verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok && Date.now() < stopAt) try { process.kill(-plan.pid!, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      while (Date.now() < stopAt && !(await ownedProcessesStopped(plan, true, stopAt))) await sleep(50)
      exit ??= await Promise.race([closed, sleep(100).then(() => undefined)])
    }
    const reuseCloseStop = worktree && stoppedOnClose && !stopSent && !abortRequested && protocolError === undefined && resultError === undefined
    const stopped = Date.now() < stopAt && (reuseCloseStop || await ownedProcessesStopped(plan, false, stopAt))
    writeJson(join(root, 'exit.json'), { code: exit?.code ?? null, signal: exit?.signal ?? null, stopped, acknowledged, idle, closed: closeAcknowledged, stderrBytes, stderrSha256: stderrHash.digest('hex') } satisfies StopEvidence, true)
    nativeStopped = stopped
    if (!stopped) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); if (!(resultError instanceof ZCodeNativeTurnFailedError) && !(resultError instanceof StructuredSessionError && resultError.code === 'native_rpc_timeout')) resultError = new StructuredSessionError('cancellation_pending', 'ZCode app/MCP process stop is unproven') }
  } catch {
    if (!(resultError instanceof ZCodeNativeTurnFailedError) && !(resultError instanceof StructuredSessionError && resultError.code === 'native_rpc_timeout')) resultError = new StructuredSessionError('cancellation_pending', 'ZCode native cleanup or stop evidence could not be settled')
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
  } finally {
    clearTimeout(timeout); callbacks.signal?.removeEventListener('abort', interrupt); active.delete(root)
    session.close()
  }
  if (abortRequested) throw new StructuredSessionError(nativeStopped ? timedOut ? 'timeout' : 'cancelled' : 'cancellation_pending', 'ZCode cancellation revoked result publication')
  if (resultError) throw resultError
  return worktree ? settleWorktreeResult(plan, prompt, { ...execution, zcodeNative: native() }, nativeStopped ? stopAt : undefined, adapter) : settleResult(plan, prompt, execution, adapter)
}
