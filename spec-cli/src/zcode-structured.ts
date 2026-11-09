import { nativeWorktreeLaunch, sampleNativeWorktreeProcesses, nativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { constants, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt, type ProcessIdentity } from '@spexcode/spec-core'
import { isNativeTokenCount, rejectedFinalOutput, structuredExecutionTimer, StructuredSessionError, structuredExecutionPolicy, structuredSeatbeltProfile, type NativeTokenUsage, type StructuredExecution } from './session-structured-policy.js'
import { decodeZCodeJsonText, type ZCodeFrozenReadProof, type ZCodeFrozenWitness } from './zcode-frozen-evidence.js'

export const zcodeCapability = Object.freeze({
  cliVersion: '0.17.1',
  cliSha256: '9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6',
  builtinSha256: 'e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9',
  builtinPath: '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json',
  tool: 'mcp__frozen__spex_read_frozen',
})
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
type NativePlan = ZCodeNativeState & NativeConfigSelection & { nativeConfiguration?: 'cli-config-v1'; toolDenylist?: readonly ['ExitPlanMode']; worktreeProcessBaseline?: 1; requestDigest: string; policyDigest: string; cliPath: string; cliVersion: string; cliSha256: string; builtinPath?: string; builtinSha256?: string; queryId: string; runtime: string; tmp: string; workspace: string; receiptFile: string; modelSnapshotDigest?: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type StopEvidence = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; acknowledged: boolean; idle: boolean; closed: boolean; stderrBytes: number; stderrSha256: string }
type Completed = { plan: NativePlan; witness: ZCodeFrozenWitness; result: NativeResult }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytesDigest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const active = new Map<string, { interrupt(): void }>()
const fixedPolicy = (execution: ZCodeStructuredExecution) => execution.policy === 'native-worktree-v1' ? structuredExecutionPolicy(execution) : ({ ...structuredExecutionPolicy(execution), version: execution.timeoutMs === null ? 5 : 4, policy: 'zcode-frozen-read-only-v1' })

/** 只认证本次精确失败终态；原生正文不进入错误诊断，停止权限仍由既有adapter独立证明。 */
export class ZCodeNativeTurnFailedError extends StructuredSessionError {
  constructor(threadId: string, turnId: string, nativeCode: unknown, worktree: boolean, nativeAttribution?: unknown) {
    const code = typeof nativeCode === 'string' && Object.hasOwn(constants.errno, nativeCode) ? nativeCode : 'unavailable'
    const attribution = nativeAttribution as { source?: unknown; exceptionKind?: unknown; retryable?: unknown } | null | undefined
    const providerRejection = worktree && code === 'EPIPE' && attribution?.source === 'provider' && attribution.exceptionKind === 'provider_business' && attribution.retryable === false
    super(providerRejection ? 'unsupported' : worktree && code === 'EPIPE' ? 'native_turn_transport_failed' : 'failed', providerRejection ? 'ZCode provider rejected the native turn (retryable=false)' : `ZCode native turn failed (code=${code})`, { threadId, turnId })
  }
}

/** 原业务正文逐字保留；唯一原生user输入前置固定、只读的精确JSON schema控制段。 */
export function zcodeStructuredPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `SpexCode structured-output contract (read-only control):\nReturn exactly one JSON value matching the JSON Schema below. Do not add prose or Markdown.\nJSON Schema: ${JSON.stringify(schema)}\nEnd of structured-output contract.\n\n${prompt}`
}

/** SDK stdin 逐 Buffer 解码；ASCII 线路避免跨块拆坏 Unicode，持久 send 仍为原语义对象。 */
export function zcodeProtocolLine(packet: Record<string, unknown>): string {
  return `${JSON.stringify(packet).replace(/[\u0080-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))}\n`
}

/** 只有新请求冻结的非交互策略增加控制段；历史请求保留原输入字节。 */
function zcodeExecutionPrompt(prompt: string, execution: ZCodeStructuredExecution): string {
  return execution.policy === 'native-worktree-v1' ? `${execution.zcodeToolPolicy ? 'This read-only turn must return the complete schema JSON. Do not request plan approval or call ExitPlanMode.\n' : ''}Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}` : zcodeStructuredPrompt(prompt, execution.schema)
}

function requestDigest(prompt: string, execution: ZCodeStructuredExecution): string {
  const selection = execution.nativeConfiguration === 'cli-config-v1' ? zcodeNativeConfigSelection(execution.model, execution.effort) : zcodeNativeSelection(execution.model, execution.effort)
  return digest({ prompt, nativePrompt: zcodeExecutionPrompt(prompt, execution), policy: fixedPolicy(execution), selection, ...(execution.zcodeToolPolicy ? { toolDenylist: execution.zcodeToolPolicy.toolDenylist } : {}) })
}

function nativeSend(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution) {
  return { sessionId: plan.sessionId, content: zcodeExecutionPrompt(prompt, execution), inputId: plan.inputId, modelSelection: plan.model!, ...(plan.version >= 2 ? { toolDenylist: plan.toolDenylist } : {}) }
}

/** 只投影结算所需白名单字段；历史currentTurnId与真正activeTurn分别观察。 */
export function zcodeIdleObservation(snapshot: IdleSnapshot, identity: { sessionId: string; turnId?: string }) {
  const runtime = snapshot.runtime, projection = snapshot.projection
  const observed = { sessionId: snapshot.session?.sessionId, status: snapshot.session?.status, activeTurnId: runtime?.activeTurnId, activeTurnKind: runtime?.activeTurnKind,
    pendingRequestIds: runtime?.pendingRequestIds, currentTurnId: projection?.currentTurnId, projectionStatus: projection?.status,
    pendingPermissions: projection?.pendingPermissions?.map(permission => ({ requestId: permission.requestId, toolCallId: permission.toolCallId })),
    activeToolCalls: projection?.activeToolCalls?.map(tool => ({ toolCallId: tool.toolCallId, toolName: tool.toolName, status: tool.status })) }
  const idle = observed.sessionId === identity.sessionId && observed.status === 'idle' && !!runtime && !observed.activeTurnId && !observed.activeTurnKind
    && Array.isArray(observed.pendingRequestIds) && observed.pendingRequestIds.length === 0 && !!projection && (!observed.currentTurnId || observed.currentTurnId === identity.turnId)
    && Array.isArray(observed.pendingPermissions) && observed.pendingPermissions.length === 0 && Array.isArray(observed.activeToolCalls)
    && observed.activeToolCalls.every(tool => ['completed', 'failed', 'denied'].includes(tool.status))
  return { idle, observed }
}

/** namespace只做原生路由，provider与模型必须同时明确，不接受动态别名。 */
export function zcodeNativeModel(model: string | undefined): { providerId: string; modelId: string } {
  const match = /^zcode:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(model ?? '')
  if (!match || ['default', 'auto', 'latest', 'fast', 'smart'].includes(match[2].toLowerCase())) throw new StructuredSessionError('unsupported', 'ZCode execution requires zcode:<provider-id>/<exact-model-id>')
  return { providerId: match[1], modelId: match[2] }
}

/** 固定公开builtin只证明此模型的high语义；create两个正式字段均显式绑定。 */
export function zcodeNativeSelection(model: string | undefined, effort?: StructuredExecution['effort']): NativeSelection {
  const native = zcodeNativeModel(model)
  if (effort === undefined) return { model: native }
  if (effort !== 'high' || native.providerId !== 'bigmodel-api' || native.modelId !== 'GLM-5.3-Flash') throw new StructuredSessionError('unsupported', 'ZCode effort requires the verified bigmodel-api/GLM-5.3-Flash high mapping')
  return { model: { ...native, options: { reasoningLevel: 'high' } }, thoughtLevel: 'high' }
}

/** 新配置只拆 provider/model 分隔符；SDK 仍负责解析具体模型与配置。 */
export function zcodeNativeConfigModel(model: string | undefined): NativeModel | undefined {
  if (model === 'zcode:default') return undefined
  const prefix = 'zcode:'
  if (!model?.startsWith(prefix)) throw new StructuredSessionError('unsupported', 'ZCode native configuration requires zcode:default or zcode:<provider>/<model>')
  const value = model.slice(prefix.length), separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) throw new StructuredSessionError('unsupported', 'ZCode native configuration requires zcode:default or zcode:<provider>/<model>')
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
}

/** 新配置将显式模型与努力级别交给 SDK，默认模型由创建后的原生快照解析。 */
export function zcodeNativeConfigSelection(model: string | undefined, effort?: StructuredExecution['effort']): NativeConfigSelection {
  const selected = zcodeNativeConfigModel(model)
  return {
    ...(selected ? { model: effort ? { ...selected, options: { reasoningLevel: effort } } : selected } : {}),
    ...(effort ? { thoughtLevel: effort } : {}),
  }
}

/** session.model仅显示基础身份；正式effort以settings的真实selection和可用thoughtLevel核实。 */
export function assertZCodeModelSnapshot(snapshot: ModelSnapshot, expected: NativeConfigSelection, generic = false): void {
  const displayed = snapshot.session?.model, current = snapshot.settings?.model?.current, thought = snapshot.settings?.thoughtLevel
  if (generic) {
    for (const model of [displayed, current]) {
      if (!model || expected.model && (model.providerId !== expected.model.providerId || model.modelId !== expected.model.modelId)) throw new StructuredSessionError('unsupported', 'ZCode actual session model differs from the requested model')
    }
    for (const [key, value] of Object.entries(expected.model?.options ?? {})) if (!isDeepStrictEqual(current?.options?.[key], value)) throw new StructuredSessionError('unsupported', `ZCode actual session model option ${key} differs from the request`)
    if (expected.thoughtLevel && (current?.options?.reasoningLevel !== expected.thoughtLevel || thought?.current !== expected.thoughtLevel
      || !Array.isArray(thought.available) || !thought.available.some(level => level.value === expected.thoughtLevel))) throw new StructuredSessionError('unsupported', 'ZCode actual snapshot did not select the requested effort')
    return
  }
  for (const model of [displayed, current]) {
    if (!model || !expected.model || model.providerId !== expected.model.providerId || model.modelId !== expected.model.modelId || Object.keys(model).some(key => !['providerId', 'modelId', 'options'].includes(key))
      || model.options && (Object.keys(model.options).some(key => key !== 'reasoningLevel') || typeof model.options.reasoningLevel !== 'string')) throw new StructuredSessionError('unsupported', 'ZCode actual session model or native options differ')
  }
  if (expected.thoughtLevel && (current?.options?.reasoningLevel !== expected.thoughtLevel || thought?.current !== expected.thoughtLevel
    || !Array.isArray(thought.available) || !thought.available.some(level => level.value === expected.thoughtLevel)
    || displayed?.options?.reasoningLevel !== undefined && displayed.options.reasoningLevel !== expected.thoughtLevel)) throw new StructuredSessionError('unsupported', 'ZCode actual snapshot did not select the requested high effort')
}

/** 只解一个完整json围栏；不修补正文，不接受解释文字、多段或宽松JSON。 */
export function decodeZCodeStructuredText(text: string): unknown {
  try { return JSON.parse(decodeZCodeJsonText(text)) as unknown }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const location = / at position (\d+)(?: \(line (\d+) column (\d+)\))?$/.exec(error.message)
    const category = [
      ["Expected ',' or '}' after property value in JSON", 'expected_property_delimiter'],
      ["Expected ',' or ']' after array element in JSON", 'expected_array_delimiter'],
      ['Unexpected end of JSON input', 'unexpected_end'],
    ].find(([prefix]) => error.message.startsWith(prefix))?.[1] ?? 'invalid_json'
    const diagnostic = { category, ...(location ? { position: Number(location[1]), ...(location[2] ? { line: Number(location[2]), column: Number(location[3]) } : {}) } : {}) }
    throw new StructuredSessionError('structured_output_format_invalid', `ZCode terminal response is not one strict JSON document: ${JSON.stringify(diagnostic)}`)
  }
}

/** 仅返回原样安全证明事件；transport只按type计数，绝不读取或保存headers。 */
export function zcodeProofEvent(event: NativeEvent): NativeEvent | undefined {
  if (['turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'tool.updated'].includes(event.type)) return event
  if (event.type !== 'session.updated' || typeof event.payload.toolCount !== 'number') return undefined
  const keys = ['messageCount', 'providerId', 'modelId', 'temperature', 'maxTokens', 'toolCount', 'iteration']
  if (Object.keys(event.payload).some(key => !keys.includes(key))) throw new StructuredSessionError('stale_result', 'ZCode ModelRequest includes unknown evidence fields')
  return event
}

function zcodeProviderUsage(value: unknown): NativeTokenUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const nativeUsage = value as Record<string, unknown>
  if (nativeUsage.source !== 'provider') return

  const usage: NativeTokenUsage = { source: 'zcode-turn-usage' }
  for (const [field, nativeField] of [
    ['totalInputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['cacheReadInputTokens', 'cacheReadTokens'],
    ['cacheWriteInputTokens', 'cacheWriteTokens'],
  ] as const) {
    const count = nativeUsage[nativeField]
    if (isNativeTokenCount(count)) usage[field] = count
  }
  if (Object.keys(usage).length > 1) return usage
}

/** 正常原生文件工具保持可用，仅旧冻结模式设置唯一 MCP 工具面。 */
export function zcodeWorktreeConfiguration(): Record<string, unknown> {
  return { ...zcodeRuntimeConfiguration(), features: { mcp: false, subagent: false, memory: false, skill: false } }
}

/** 只批准当前 session 的一次正常工具调用；读取无路径白名单，文件修改归属本工作区。 */
export function zcodeWorktreePermission(request: { sessionId?: string; toolName?: string; input?: { file_path?: string; path?: string } }, sessionId: string, worktreePath: string, mode: 'read' | 'edit'): 'allow' | 'deny' {
  if (request.sessionId !== sessionId || !['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'NotebookEdit'].includes(request.toolName ?? '')) return 'deny'
  if (!['Edit', 'Write', 'NotebookEdit'].includes(request.toolName!)) return 'allow'
  if (mode === 'read') return 'deny'
  const path = request.input?.file_path ?? request.input?.path
  if (typeof path !== 'string') return 'deny'
  const target = resolve(worktreePath, path), root = resolve(worktreePath)
  return target === root || target.startsWith(root + sep) ? 'allow' : 'deny'
}

/** 配置由控制面固定，SDK只消费认证路径引用；不继承用户能力或读取认证字节。 */
export function zcodeRuntimeConfiguration(): Record<string, unknown> {
  return { features: { mcp: true, subagent: false, memory: false, skill: false }, mcp: { servers: {} }, plugins: { enabled: false, dirs: [], enabledPlugins: {}, extraKnownMarketplaces: {}, options: {}, suppressedBuiltins: [] }, hooks: { enabled: false, events: {} }, skills: { enabled: false, includeInstructions: false, roots: [] } }
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

function verifyPlan(plan: NativePlan, root: string, prompt: string | undefined, execution: ZCodeStructuredExecution): void {
  const native = execution.zcodeNative
  const generic = execution.nativeConfiguration === 'cli-config-v1'
  const requested = generic ? zcodeNativeConfigSelection(execution.model, execution.effort) : zcodeNativeSelection(execution.model, execution.effort)
  const expectedVersion = generic ? 3 : execution.zcodeToolPolicy ? 2 : 1
  const digestValid = (value: string | undefined): boolean => value === undefined || /^[a-f0-9]{64}$/.test(value)
  const runtimeIdentityValid = typeof plan.cliVersion === 'string' && plan.cliVersion.length > 0 && /^[a-f0-9]{64}$/.test(plan.cliSha256)
    && (generic ? plan.builtinPath === zcodeCapability.builtinPath && digestValid(plan.builtinSha256)
      : typeof plan.builtinSha256 === 'string' && /^[a-f0-9]{64}$/.test(plan.builtinSha256))
  const selectionMatches = generic
    ? (!requested.model || plan.model?.providerId === requested.model.providerId && plan.model.modelId === requested.model.modelId
      && Object.entries(requested.model.options ?? {}).every(([key, value]) => isDeepStrictEqual(plan.model?.options?.[key], value)))
      && (!requested.thoughtLevel || plan.thoughtLevel === requested.thoughtLevel)
      && (existsSync(join(root, 'send.json')) ? !!plan.model : true)
    : isDeepStrictEqual({ model: plan.model, ...(plan.thoughtLevel ? { thoughtLevel: plan.thoughtLevel } : {}) }, zcodeNativeSelection(execution.model, execution.effort))
  if (plan.version !== expectedVersion || native?.version !== plan.version || plan.nativeConfiguration !== execution.nativeConfiguration || !isDeepStrictEqual(plan.toolDenylist, execution.zcodeToolPolicy?.toolDenylist)
    || execution.policy === 'native-worktree-v1' && plan.worktreeProcessBaseline !== 1 || plan.root !== root || native?.root !== root || plan.sessionId !== native.sessionId || plan.inputId !== native.inputId
    || plan.policyDigest !== digest(fixedPolicy(execution)) || prompt !== undefined && plan.requestDigest !== requestDigest(prompt, execution)
    || !runtimeIdentityValid || !selectionMatches || native.turnId && native.turnId !== plan.turnId || native.pid !== plan.pid || native.receiptFile && native.receiptFile !== plan.receiptFile
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== plan.turnId)
    throw new StructuredSessionError('stale_result', 'ZCode fixed native plan or durable identity differs')
  if (existsSync(join(root, 'send.json')) && (!plan.modelSnapshotDigest || !existsSync(join(root, 'model-snapshot.json')) || plan.modelSnapshotDigest !== digest(JSON.parse(readFileSync(join(root, 'model-snapshot.json'), 'utf8'))))) throw new StructuredSessionError('stale_result', 'ZCode saved pre-send model selection differs')
  if (prompt !== undefined && existsSync(join(root, 'send.json')) && digest(JSON.parse(readFileSync(join(root, 'send.json'), 'utf8'))) !== digest(nativeSend(plan, prompt, execution))) throw new StructuredSessionError('stale_result', 'ZCode original send differs from the exact native schema/prompt input')
}

const nativeRpcTimeoutMessage = (method: string): string => `ZCode native RPC timeout (${method})`

export function isZCodeEventsRpcTimeout(execution: Pick<StructuredExecution, 'state' | 'errorCode' | 'error'>): boolean {
  return execution.state === 'failed' && execution.errorCode === 'native_rpc_timeout' && execution.error === nativeRpcTimeoutMessage('session/events')
}

/** 只读核原任务与公开终态；true认证未批准稿，null跳过不具资格的候选。 */
export function assertZCodeStoppedDraftSource(prompt: string, execution: ZCodeStructuredExecution, worktreePath: string, allowUnpublishedCompletion = false): boolean | null {
  const native = execution.zcodeNative
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('zcode:') || execution.worktree?.mode !== 'edit' || !native || !['failed', 'cancelled'].includes(execution.state ?? '') || !execution.cancellation?.nativeStopped)
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft requires its original stopped native worktree')
  const completedPath = join(native.root, 'completed.json')
  const sealed = existsSync(completedPath)
  if (sealed && (!allowUnpublishedCompletion || execution.state !== 'cancelled' || execution.errorCode !== undefined || execution.output !== undefined || execution.resultDigest !== undefined || execution.resultWorktree || execution.failedWorktree || execution.rejectedOutput))
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft requires its original stopped native worktree')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(native.root, name), 'utf8'))
  const plan = read('plan.json') as NativePlan
  verifyPlan(plan, native.root, prompt, execution)
  if (plan.workspace !== worktreePath || !plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) throw new StructuredSessionError('stale_result', 'stopped ZCode draft differs from its exact workspace/process')
  const send = read('send.json'), snapshot = read('model-snapshot.json') as { sessionId: string; model: NativeModel }, events = read('events.json') as NativeEvent[]
  const completedEventsRpc = isZCodeEventsRpcTimeout(execution)
  let terminal: NativeEvent
  try { terminal = read('terminal.json') as NativeEvent }
  catch (error) { if (completedEventsRpc && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  let exit: StopEvidence
  try { exit = read('exit.json') as StopEvidence }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (sealed) throw new StructuredSessionError('stale_result', 'ZCode unpublished completion lacks its original exit evidence')
    return null
  }
  const starts = events.filter(event => event.type === 'turn.started'), terminals = events.filter(event => ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)), requests = events.filter(event => event.type === 'session.updated')
  const nonSuccess = completedEventsRpc && (terminal.type !== 'turn.completed' || terminal.payload.resultType === 'cancelled' && typeof terminal.payload.response === 'string')
  const exitMatches = nonSuccess ? exit.stopped === true && (exit.code === null || Number.isSafeInteger(exit.code) && exit.code >= 0)
    && (exit.signal === null || exit.code === null && typeof exit.signal === 'string' && Object.hasOwn(constants.signals, exit.signal)) : !!exit.stopped && exit.code === 0 && exit.signal === null
  if (digest(send) !== digest(nativeSend(plan, prompt, execution)) || !plan.turnId || typeof plan.model?.providerId !== 'string' || !plan.model.providerId || typeof plan.model.modelId !== 'string' || !plan.model.modelId || snapshot.sessionId !== plan.sessionId || digest(snapshot.model) !== digest(plan.model) || starts.length !== 1 || starts[0].payload.inputId !== plan.inputId || starts[0].payload.queryId !== plan.queryId || typeof starts[0].payload.messageId !== 'string' || !starts[0].payload.messageId
    || events.some(event => event.sessionId !== plan.sessionId || event.turnId !== plan.turnId || !Number.isSafeInteger(event.seq) || typeof event.eventId !== 'string') || new Set(events.map(event => event.eventId)).size !== events.length
    || !requests.length || requests.some(event => event.payload.providerId !== plan.model?.providerId || event.payload.modelId !== plan.model?.modelId)
    || terminals.length !== 1 || digest(terminals[0]) !== digest(terminal) || terminal.sessionId !== plan.sessionId || terminal.turnId !== plan.turnId || terminal.payload.inputId !== plan.inputId || !exitMatches)
    throw new StructuredSessionError('stale_result', 'stopped ZCode draft lost its original model/input/terminal/exit identity')
  if (sealed) {
    const messages = read('messages.json') as NativeMessage[]
    const { completed } = verifyWorktreeCompletion(plan, plan.model, prompt, execution, { terminal, events, messages, exit, send }, true)
    if (readFileSync(completedPath, 'utf8') !== JSON.stringify(completed)) throw new StructuredSessionError('stale_result', 'ZCode immutable native evidence differs')
    return null
  }
  if (completedEventsRpc) {
    if (nonSuccess) return null
    const idle = read('idle.json') as { sessionId: string; turnId: string; idle: boolean }
    if (terminal.payload.resultType !== 'success' || typeof terminal.payload.response !== 'string'
      || idle.sessionId !== plan.sessionId || idle.turnId !== plan.turnId || idle.idle !== true || exit.idle !== true || exit.closed !== true || exit.stopped !== true)
      throw new StructuredSessionError('stale_result', 'ZCode events RPC draft has no exact completed terminal and idle/closed stop')
    return true
  }
  if (execution.errorCode === 'native_turn_transport_failed' && (terminal.type !== 'turn.failed' || (terminal.payload.error as { code?: unknown } | undefined)?.code !== 'EPIPE')) throw new StructuredSessionError('stale_result', 'ZCode turn transport failure differs from the original EPIPE terminal')
  return terminal.type === 'turn.failed'
}

/* 同一原生 session/input/query/turn 和实际模型选择证明正常工具执行的终态。 */
function verifyWorktreeCompletion(plan: NativePlan, model: NativeModel, prompt: string, execution: ZCodeStructuredExecution, evidence: WorktreeCompletionEvidence, strictCompleted: boolean) {
  const { terminal, events, messages, exit, send } = evidence
  const starts = events.filter(event => event.type === 'turn.started'), requests = events.filter(event => event.type === 'session.updated')
  if (!plan.turnId || terminal.type !== 'turn.completed' || terminal.sessionId !== plan.sessionId || terminal.turnId !== plan.turnId || terminal.payload.inputId !== plan.inputId || terminal.payload.resultType !== 'success' || typeof terminal.payload.response !== 'string'
    || starts.length !== 1 || starts[0].payload.inputId !== plan.inputId || starts[0].payload.queryId !== plan.queryId || starts[0].turnId !== plan.turnId
    || !events.some(event => digest(event) === digest(terminal)) || events.some(event => event.sessionId !== plan.sessionId || event.turnId !== plan.turnId)
    || !requests.length || requests.some(event => event.payload.providerId !== model.providerId || event.payload.modelId !== model.modelId)
    || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null) throw new StructuredSessionError('stale_result', 'ZCode worktree exact native model/terminal/process evidence differs')
  const users = messages.filter(message => message.info?.role === 'user' && (message.info.semantics as Record<string, unknown>)?.kind === 'user_prompt')
  if (users.length !== 1 || users[0].info?.id !== starts[0].payload.messageId || (users[0].info?.anchor as Record<string, unknown>)?.turnId !== plan.turnId || digest(users[0].info?.modelSelection) !== digest(model) || users[0].info?.sessionID !== plan.sessionId || users[0].parts?.filter(part => part.type === 'text').map(part => part.text).join('') !== zcodeExecutionPrompt(prompt, execution)) throw new StructuredSessionError('stale_result', 'ZCode worktree original native user/input differs')
  const finals = messages.filter(message => message.info?.role === 'assistant' && (message.info.anchor as Record<string, unknown>)?.turnId === plan.turnId && (message.info.semantics as Record<string, unknown>)?.kind === 'assistant_response')
  if (!finals.length || finals.at(-1)!.info?.providerId !== model.providerId || finals.at(-1)!.info?.modelId !== model.modelId || finals.at(-1)!.parts?.filter(part => part.type === 'text').map(part => part.text).join('') !== terminal.payload.response) throw new StructuredSessionError('stale_result', 'ZCode worktree final assistant identity/response differs')
  const { nativeTokenUsage } = terminal
  let output: unknown
  try { output = decodeZCodeStructuredText(terminal.payload.response) }
  catch (error) {
    if (strictCompleted && error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal response is not one strict JSON document')
    if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw new StructuredSessionError(error.code, error.message, { threadId: plan.sessionId, turnId: plan.turnId, nativeTokenUsage, rejectedOutput: rejectedFinalOutput(terminal.payload.response, prompt, execution, { threadId: plan.sessionId, turnId: plan.turnId }) })
    throw error
  }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(output)) {
    if (strictCompleted) throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal JSON no longer matches its schema')
    const diagnostics = validate.errors?.map(({ instancePath, schemaPath, keyword, params, message }) => ({ instancePath, schemaPath, keyword, params, message })) ?? []
    throw new StructuredSessionError('structured_output_format_invalid', `ZCode worktree terminal JSON does not match its schema: ${JSON.stringify(diagnostics)}`, { threadId: plan.sessionId, turnId: plan.turnId, nativeTokenUsage, rejectedOutput: rejectedFinalOutput(terminal.payload.response, prompt, execution, { threadId: plan.sessionId, turnId: plan.turnId }) })
  }
  const result: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.turnId, text: JSON.stringify(output) }
  return { completed: { plan, terminal, events, messages, exit, send, result }, output }
}

async function settleWorktreeResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution, freshStopDeadline?: number): Promise<WorktreeNativeResult> {
  verifyPlan(plan, plan.root, prompt, execution)
  const model = plan.model
  if (!model) throw new StructuredSessionError('stale_result', 'ZCode worktree plan has no actual model selection')
  // 本次调用写 exit 前已做最终停止观察。未结算的冷重放不能借用这次观察。
  if (freshStopDeadline === undefined && execution.state !== 'completed' && !(await ownedProcessesStopped(plan))) throw new StructuredSessionError('cancellation_pending', 'ZCode worktree native or unknown orphan stop remains unproven')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(plan.root, name), 'utf8'))
  const terminal = read('terminal.json') as NativeEvent, events = read('events.json') as NativeEvent[], messages = read('messages.json') as NativeMessage[]
  const exit = read('exit.json') as StopEvidence, send = read('send.json')
  const { completed, output } = verifyWorktreeCompletion(plan, model, prompt, execution, { terminal, events, messages, exit, send }, execution.state === 'completed')
  const { result } = completed
  const path = join(plan.root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== result.threadId || execution.turnId !== result.turnId || execution.resultDigest !== digest(output))) throw new StructuredSessionError('stale_result', 'ZCode worktree durable completed identity differs')
  if (freshStopDeadline !== undefined && Date.now() >= freshStopDeadline) throw new StructuredSessionError('cancellation_pending', 'ZCode completion exceeded the original stop deadline')
  writeJson(path, completed, true)
  return terminal.nativeTokenUsage ? { ...result, nativeTokenUsage: terminal.nativeTokenUsage } : result
}

async function settleResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution): Promise<NativeResult> {
  const terminal = JSON.parse(readFileSync(join(plan.root, 'terminal.json'), 'utf8')) as NativeEvent
  const exit = JSON.parse(readFileSync(join(plan.root, 'exit.json'), 'utf8')) as StopEvidence
  const messages = JSON.parse(readFileSync(join(plan.root, 'messages.json'), 'utf8')) as unknown[]
  const events = JSON.parse(readFileSync(join(plan.root, 'events.json'), 'utf8')) as NativeEvent[]
  const send = JSON.parse(readFileSync(join(plan.root, 'send.json'), 'utf8')) as { sessionId: string; content: string; inputId: string }
  if (!plan.turnId || terminal.type !== 'turn.completed' || terminal.sessionId !== plan.sessionId || terminal.turnId !== plan.turnId || terminal.payload.inputId !== plan.inputId
    || terminal.payload.resultType !== 'success' || typeof terminal.payload.response !== 'string' || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null)
    throw new StructuredSessionError('failed', 'ZCode has no exact successful terminal, close and complete native stop')
  const mcpPath = join(plan.runtime, 'frozen-mcp', 'mcp-public.jsonl')
  const records = readFileSync(mcpPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const model = plan.model
  if (!model) throw new StructuredSessionError('stale_result', 'ZCode frozen plan has no exact model selection')
  const witness = { version: 1, provider: 'zcode', cliVersion: plan.cliVersion, cliSha256: plan.cliSha256, providerId: model.providerId, modelId: model.modelId, sessionId: plan.sessionId, turnId: plan.turnId, inputId: plan.inputId, prompt: zcodeExecutionPrompt(prompt, execution), send, messages, events,
    mcpHistory: { records, digest: digest(records) } } as ZCodeFrozenWitness
  if (!events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode terminal differs from its original native events')
  const { proveZCodeFrozenReads } = await import('./zcode-frozen-evidence.js')
  const frozenReadProof = proveZCodeFrozenReads(execution.frozenContext!, witness)
  const output = decodeZCodeStructuredText(terminal.payload.response), validate = new Ajv({ allErrors: true }).compile(execution.schema)
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
    if (!exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null || terminal.type !== 'turn.completed' || terminal.payload.resultType !== 'success') return null
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
  try { output = JSON.parse(decodeZCodeJsonText(terminal.payload.response as string)) }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new StructuredSessionError('stale_result', 'ZCode completed response is not one strict JSON document') }
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
  try { verifyPlan(plan, native.root, undefined, execution) }
  catch { return { nativeStopped: false, acknowledged: false, error: 'ZCode fixed launch policy or native identity differs' } }
  if (!execution.turnStartRequested && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  if (!plan.pid || plan.pid !== native.pid || plan.receiptFile !== native.receiptFile) return { nativeStopped: false, acknowledged: false, error: 'ZCode launch/process identity differs' }
  if (Date.now() >= deadline) return { nativeStopped: false, acknowledged: false, error: 'ZCode native stop deadline expired' }
  const local = active.get(native.root)
  if (local) local.interrupt()
  else if (!detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
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
  while (Date.now() < deadline && !(await stoppedProcesses(!local))) await sleep(50)
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
  let selection: NativeSelection | NativeConfigSelection = genericNativeConfiguration ? zcodeNativeConfigSelection(execution.model, execution.effort) : zcodeNativeSelection(execution.model, execution.effort)
  const root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) ? settleWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution) : null
    : await completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.zcodeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'ZCode in-progress dispatch cannot append another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'ZCode requires the verified macOS read-only sandbox')
  const resolved = spawnSync('/usr/bin/which', ['zcode'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  if (resolved.error || resolved.status !== 0) throw new StructuredSessionError('unsupported', 'ZCode CLI is unavailable')
  const cliPath = realpathSync(resolved.stdout.trim())
  const worktreeLaunch = worktree ? nativeWorktreeLaunch(worktreePath!, cliPath, []) : undefined
  const cliSha256 = bytesDigest(cliPath), builtinExists = existsSync(zcodeCapability.builtinPath), builtinSha256 = builtinExists ? bytesDigest(zcodeCapability.builtinPath) : undefined
  if (!genericNativeConfiguration && (cliSha256 !== zcodeCapability.cliSha256 || !builtinExists || builtinSha256 !== zcodeCapability.builtinSha256)) throw new StructuredSessionError('unsupported', 'ZCode CLI or public builtin capability digest is unverified')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const runtime = join(root, 'runtime'), home = join(runtime, 'home'), ledgerRoot = join(runtime, 'frozen-mcp'), tmp = mkdtempSync(worktree ? join(tmpdir(), 'spex-zcode-tmp-') : '/private/tmp/spex-zcode-tmp-'), workspace = worktree ? worktreePath! : mkdtempSync('/private/tmp/spex-zcode-frozen-')
  for (const path of [runtime, home, ledgerRoot, join(home, '.zcode/cli'), join(home, '.zcode/v2')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const config = join(home, '.zcode/cli/config.json'), credentialSource = join(homedir(), '.zcode/v2/credentials.json'), personal = join(homedir(), '.zcode/v2/provider_config.json'), credentialLink = join(home, '.zcode/v2/credentials.json')
  writeJson(config, worktree ? zcodeWorktreeConfiguration() : zcodeRuntimeConfiguration(), true)
  if (existsSync(credentialSource)) symlinkSync(credentialSource, credentialLink)
  const input = join(root, 'reader-input.json'), profile = join(root, 'policy.sb')
  if (!worktree) {
    writeJson(input, { root: ledgerRoot, ref: execution.frozenContext }, true)
    let policy = structuredSeatbeltProfile(realpathSync(runtime)) + `(allow file-write* (subpath ${JSON.stringify(realpathSync(tmp))}))\n`
    for (const path of [config, credentialLink, credentialSource, personal, zcodeCapability.builtinPath, input, profile]) policy += `(deny file-write* (literal ${JSON.stringify(path)}))\n`
    writeFileSync(profile, policy, { mode: 0o400 })
  }
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: `${tmp}/`, ZCODE_DATA_BASE_DIR: home, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeCapability.builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal }
  const launch = worktreeLaunch ?? { command: '/usr/bin/sandbox-exec', args: ['-f', profile, cliPath] }
  const version = spawnSync(launch.command, [...launch.args, '--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 10000 })
  const cliVersion = version.stdout.trim()
  if (version.error || version.status !== 0 || !cliVersion || !genericNativeConfiguration && cliVersion !== zcodeCapability.cliVersion) throw new StructuredSessionError('unsupported', 'ZCode CLI version could not be recorded for this runtime')
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
  let plan: NativePlan = { ...(worktree ? { worktreeProcessBaseline: 1 as const } : {}), version: genericNativeConfiguration ? 3 : execution.zcodeToolPolicy ? 2 : 1, ...(genericNativeConfiguration ? { nativeConfiguration: execution.nativeConfiguration } : {}), ...(execution.zcodeToolPolicy ? { toolDenylist: execution.zcodeToolPolicy.toolDenylist } : {}), root, sessionId: `sess_${randomUUID()}`, inputId: randomUUID(), queryId: randomUUID(), requestDigest: requestDigest(prompt, execution), policyDigest: digest(fixedPolicy(execution)), cliPath, cliVersion, cliSha256, ...(genericNativeConfiguration ? { builtinPath: zcodeCapability.builtinPath, ...(builtinSha256 ? { builtinSha256 } : {}) } : { builtinSha256: zcodeCapability.builtinSha256 }), ...selection, runtime, tmp, workspace, receiptFile: join(root, 'process.json') }
  writeJson(join(root, 'plan.json'), plan)
  const native = (): ZCodeNativeState => ({ version: plan.version, root, sessionId: plan.sessionId, inputId: plan.inputId, ...(plan.pid ? { pid: plan.pid, receiptFile: plan.receiptFile } : {}), ...(plan.turnId ? { turnId: plan.turnId } : {}) })
  await callbacks.onNative(native()); await callbacks.onTurnStarting?.()
  let launchFailure: Error | undefined
  if (worktree) await sampleNativeWorktreeProcesses(plan)
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, [...launch.args, 'app-server', '--cwd', workspace], { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.once('error', () => { launchFailure = new StructuredSessionError('cancellation_pending', 'ZCode native process failed during launch') })
  if (!child.pid) throw new StructuredSessionError('failed', 'ZCode isolated process could not start')
  let exited = false
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  try {
    writeDetachedRuntimeReceipt(child.pid, plan.receiptFile)
    plan = { ...plan, pid: child.pid }; writeJson(join(root, 'plan.json'), plan); await sampleOwnedProcesses(plan); await callbacks.onNative(native())
  } catch {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', 'ZCode spawned ownership could not be durably published; exact stop is required')
  }
  let nextId = 0, protocolError: Error | undefined = launchFailure, abortRequested = false, timedOut = false, acknowledged = false, sessionCreated = false, sent = false, closeAcknowledged = false, idle = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (exited || !child.stdin.writable) { reject(new StructuredSessionError('cancellation_pending', 'ZCode native transport ended before exact settlement')); return }
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new StructuredSessionError('native_rpc_timeout', nativeRpcTimeoutMessage(method))) }, 10000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(zcodeProtocolLine({ id, method, params }))
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let packet: { id?: number | string; method?: string; params?: { sessionId?: string; toolName?: string; input?: { file_path?: string; path?: string } }; result?: unknown; error?: { code?: number } }
    try { packet = JSON.parse(line) as typeof packet } catch { protocolError = new StructuredSessionError('failed', 'ZCode emitted non-JSON native protocol'); return }
    if (packet.method && packet.id !== undefined) {
      if (packet.method === 'session/requestRuntimePreferences' && packet.params?.sessionId === plan.sessionId) child.stdin.write(zcodeProtocolLine({ id: packet.id, result: { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, additionalDirectories: [], modelContextBudgetStrategy: 'preflight-v1' } }))
      else if (worktree && packet.method === 'interaction/requestPermission' && packet.params?.sessionId === plan.sessionId) {
        const decision = zcodeWorktreePermission(packet.params, plan.sessionId, workspace, execution.worktree!.mode)
        child.stdin.write(zcodeProtocolLine({ id: packet.id, result: { decision, reason: decision === 'allow' ? 'Task-authorized native worktree invocation' : 'Outside this native worktree task' } }))
      }
      else child.stdin.write(zcodeProtocolLine({ id: packet.id, error: { code: -32601, message: 'Unavailable in frozen read-only runtime' } }))
      return
    }
    if (typeof packet.id !== 'number') return
    const waiter = pending.get(packet.id)
    if (!waiter) return
    pending.delete(packet.id); clearTimeout(waiter.timer)
    if (packet.error) waiter.reject(new StructuredSessionError('failed', `ZCode native RPC rejected (code ${typeof packet.error.code === 'number' ? packet.error.code : 'unknown'})`))
    else waiter.resolve(packet.result)
  })
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; stderrHash.update(bytes) })
  child.once('error', () => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode native process failed') })
  const events: NativeEvent[] = [], seen = new Set<string>(), counts: Record<string, number> = {}
  let terminal: NativeEvent | undefined, cursor: number | undefined, stopSent = false, nativeStopped = false
  let stopAt: number | undefined
  const interrupt = (): void => { abortRequested = true }
  active.set(root, { interrupt }); callbacks.signal?.addEventListener('abort', interrupt, { once: true })
  const timeout = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true; interrupt()
    void Promise.resolve().then(() => callbacks.onTimeout?.()).catch(() => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode timeout cancellation could not be durably published') })
  })
  const poll = async (deadline?: number): Promise<NativeEvent | undefined> => {
    await sampleOwnedProcesses(plan, deadline)
    if (deadline !== undefined && Date.now() >= deadline) throw new StructuredSessionError('cancellation_pending', 'ZCode process observation exceeded the original stop deadline')
    const page = await request('session/events', { sessionId: plan.sessionId, ...(cursor === undefined ? {} : { afterSeq: cursor }), limit: 100 }) as { events?: NativeEvent[] }
    for (const event of page.events ?? []) {
      if (seen.has(event.eventId)) continue
      seen.add(event.eventId)
      if (event.sessionId !== plan.sessionId || !Number.isSafeInteger(event.seq) || typeof event.eventId !== 'string') throw new StructuredSessionError('stale_result', 'ZCode native event identity differs')
      cursor = Math.max(cursor ?? -1, event.seq); counts[event.type] = (counts[event.type] ?? 0) + 1
      const safe = zcodeProofEvent(event)
      if (!safe) continue
      if (event.type === 'turn.started') {
        if (!sent || plan.turnId || !event.turnId || event.payload.inputId !== plan.inputId || event.payload.queryId !== plan.queryId) throw new StructuredSessionError('stale_result', 'ZCode has no exact original input/query turn identity')
        plan = { ...plan, turnId: event.turnId }; writeJson(join(root, 'plan.json'), plan); await callbacks.onNative(native()); await callbacks.onTurn(plan.turnId!)
      }
      if (!plan.turnId || event.turnId !== plan.turnId) throw new StructuredSessionError('stale_result', 'ZCode evidence event belongs to another turn')
      if (event.type === 'session.updated' && (!plan.model || event.payload.providerId !== plan.model.providerId || event.payload.modelId !== plan.model.modelId || (!worktree && event.payload.toolCount !== 1))) throw new StructuredSessionError('unsupported', 'ZCode actual ModelRequest identity or toolCount differs')
      if (event.type === 'tool.updated' && event.payload.kind === 'scheduled' && !worktree && event.payload.toolName !== zcodeCapability.tool) throw new StructuredSessionError('unsupported', 'ZCode scheduled an uncontrolled tool')
      let evidence = event
      if (worktree && event.type === 'turn.completed') {
        const { usage, ...payload } = event.payload
        evidence = { ...event, payload, nativeTokenUsage: zcodeProviderUsage(usage) }
      }
      events.push(evidence)
      if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
        if (event.payload.inputId !== plan.inputId) throw new StructuredSessionError('stale_result', 'ZCode terminal belongs to another original input')
        if (terminal) throw new StructuredSessionError('stale_result', 'ZCode returned multiple terminal events')
        terminal = evidence; writeJson(join(root, 'terminal.json'), terminal, true)
      }
    }
    writeJson(join(root, 'events.json'), events); writeJson(join(root, 'event-counts.json'), counts)
    if (terminal?.type === 'turn.failed') {
      const error = terminal.payload.error as { code?: unknown; attribution?: unknown } | undefined
      throw new ZCodeNativeTurnFailedError(plan.sessionId, plan.turnId!, error?.code, worktree, error?.attribution)
    }
    return terminal
  }
  const stop = async (): Promise<void> => {
    if (stopSent || !sessionCreated || terminal) return
    stopSent = true; await request('session/stop', { sessionId: plan.sessionId }); acknowledged = true
  }
  let resultError: unknown
  try {
    const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
    const args = [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, input]
    const created = await request('session/create', { sessionId: plan.sessionId, workspace: { workspacePath: workspace, workspaceKey: workspace }, ...selection, mode: worktree && execution.worktree!.mode === 'edit' ? 'build' : 'plan', persistence: 'immediate', titleGenerationEnabled: false,
      ...(worktree ? { mcpServers: [] } : { mcpServers: [{ name: 'frozen', command: process.execPath, args, env: [], cwd: workspace, isolation: 'session', protocolVersion: 'legacy', alwaysLoad: true }], toolAllowlist: [zcodeCapability.tool], toolDenylist: ['Bash', 'Read', 'Edit', 'Write', 'Task', 'WebSearch', 'WebFetch'] }) }) as { session?: { sessionId: string; model?: NativeModel }; snapshot?: { session?: { sessionId: string; model?: NativeModel } } }
    const session = created.session ?? created.snapshot?.session
    if (session?.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode actual session identity differs')
    sessionCreated = true; await callbacks.onThread(plan.sessionId)
    const ready = await request('session/read', { sessionId: plan.sessionId }) as ModelSnapshot
    if (ready.session?.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode model snapshot belongs to another session')
    const currentModel = ready.settings?.model?.current
    if (genericNativeConfiguration && (!currentModel?.providerId || !currentModel.modelId)) throw new StructuredSessionError('unsupported', 'ZCode SDK did not expose its selected model')
    const checkedSelection = genericNativeConfiguration && !selection.model ? { ...selection, model: { providerId: currentModel!.providerId, modelId: currentModel!.modelId } } : selection
    assertZCodeModelSnapshot({ session, settings: ready.settings }, checkedSelection, genericNativeConfiguration)
    assertZCodeModelSnapshot(ready, checkedSelection, genericNativeConfiguration)
    if (genericNativeConfiguration) selection = { ...selection, model: currentModel! }
    const modelSnapshot = { sessionId: plan.sessionId, model: ready.settings!.model!.current, thoughtLevel: ready.settings?.thoughtLevel?.current }
    writeJson(join(root, 'model-snapshot.json'), modelSnapshot, true)
    plan = { ...plan, ...selection, modelSnapshotDigest: digest(modelSnapshot) }; writeJson(join(root, 'plan.json'), plan)
    if (callbacks.signal?.aborted) interrupt()
    if (abortRequested) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'ZCode cancelled before send')
    verifyPlan(plan, root, prompt, { ...execution, zcodeNative: native() })
    const send = nativeSend(plan, prompt, execution)
    writeJson(join(root, 'send.json'), send, true); sent = true
    const ack = await request('session/send', { ...send, queryId: plan.queryId }) as { accepted?: boolean; sessionId?: string }
    if (ack.accepted !== true || ack.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode send ACK has no exact accepted session')
    let cancellationDeadline: number | undefined
    while (!terminal) {
      if (protocolError) throw protocolError
      if (abortRequested) { await stop(); cancellationDeadline ??= Date.now() + 10000 }
      try {
        await poll()
      } catch (error) {
        if (abortRequested || protocolError || !(error instanceof StructuredSessionError)
          || error.code !== 'native_rpc_timeout' || error.message !== nativeRpcTimeoutMessage('session/events')) throw error
        const recovered = await poll()
        if (abortRequested || protocolError || recovered?.type !== 'turn.completed' || recovered.payload.resultType !== 'success') throw error
      }
      if (cancellationDeadline && Date.now() > cancellationDeadline) throw new StructuredSessionError('cancellation_pending', 'ZCode stop ACK has no bounded exact terminal')
      if (!terminal) await sleep(100)
    }
    const history = await request('session/messages', { sessionId: plan.sessionId }) as { messages?: unknown[]; hasMore?: boolean }
    if (!Array.isArray(history.messages) || history.hasMore === true) throw new StructuredSessionError('stale_result', 'ZCode raw native history is incomplete')
    writeJson(join(root, 'messages.json'), history.messages, true)
  } catch (error) { resultError = error }
  try {
    try {
      if (sent && !terminal) {
        await stop()
        const deadline = Date.now() + 10000
        while (!terminal && Date.now() < deadline && !exited) { await poll(deadline); if (!terminal) await sleep(100) }
      }
      if (sessionCreated && (!sent || terminal)) {
        const deadline = Date.now() + 3000
        const observations: ReturnType<typeof zcodeIdleObservation>[] = []
        do {
          const snapshot = await request('session/read', { sessionId: plan.sessionId }) as IdleSnapshot
          const observation = zcodeIdleObservation(snapshot, { sessionId: plan.sessionId, turnId: terminal?.turnId })
          idle = observation.idle; observations.push(observation)
          writeJson(join(root, 'idle.json'), { sessionId: plan.sessionId, turnId: plan.turnId, idle, observations })
          if (!idle) await sleep(50)
        } while (!idle && Date.now() < deadline)
        if (!idle) throw new StructuredSessionError('cancellation_pending', 'ZCode exact terminal has no matching idle runtime')
        await sampleOwnedProcesses(plan, deadline)
        const response = await request('session/close', { sessionId: plan.sessionId, expectedPersistence: 'immediate' }) as { closed?: boolean }
        closeAcknowledged = response.closed === true
      }
    } catch (error) { resultError ??= error }
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
    clearTimeout(timeout); callbacks.signal?.removeEventListener('abort', interrupt); active.delete(root); lines.close()
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new StructuredSessionError('cancellation_pending', 'ZCode transport closed')) }
  }
  if (abortRequested) throw new StructuredSessionError(nativeStopped ? timedOut ? 'timeout' : 'cancelled' : 'cancellation_pending', 'ZCode cancellation revoked result publication')
  if (resultError) throw resultError
  return worktree ? settleWorktreeResult(plan, prompt, { ...execution, zcodeNative: native() }, nativeStopped ? stopAt : undefined) : settleResult(plan, prompt, execution)
}
