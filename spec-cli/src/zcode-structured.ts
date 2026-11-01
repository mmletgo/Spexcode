import { sampleNativeWorktreeProcesses, nativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt, type ProcessIdentity } from '@spexcode/spec-core'
import { structuredExecutionTimer, StructuredSessionError, structuredExecutionPolicy, structuredSeatbeltProfile, type StructuredExecution } from './session-structured-policy.js'
import { decodeZCodeJsonText, type ZCodeFrozenReadProof, type ZCodeFrozenWitness } from './zcode-frozen-proof.js'

export const zcodeCapability = Object.freeze({
  cliVersion: '0.17.1',
  cliSha256: '9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6',
  builtinSha256: 'e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9',
  builtinPath: '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json',
  tool: 'mcp__frozen__spex_read_frozen',
})
export type ZCodeNativeState = { version: 1; root: string; sessionId: string; inputId: string; pid?: number; receiptFile?: string; turnId?: string }
export type ZCodeStructuredExecution = Omit<StructuredExecution, 'version' | 'policy' | 'frozenReadProof'> & {
  version: 4 | 5 | 6; policy: 'zcode-frozen-read-only-v1' | 'native-worktree-v1'; zcodeNative?: ZCodeNativeState; frozenReadProof?: ZCodeFrozenReadProof
}
type NativeCallbacks = { onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onNative(state: ZCodeNativeState): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type WorktreeNativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: ZCodeFrozenReadProof }
type NativeEvent = { sessionId: string; turnId?: string; seq: number; eventId: string; type: string; payload: Record<string, unknown> }
type NativeModel = { providerId: string; modelId: string; options?: { reasoningLevel: 'high' } }
type NativeSelection = { model: NativeModel; thoughtLevel?: 'high' }
type ModelSnapshot = { session?: { sessionId: string; model: NativeModel }; settings?: { model?: { current?: { providerId: string; modelId: string; options?: Record<string, unknown> } }; thoughtLevel?: { current?: string; available?: { label: string; value: string }[] } } }
type IdleSnapshot = { session?: { sessionId: string; status: string }; runtime?: { activeTurnId?: string; activeTurnKind?: string; pendingRequestIds?: string[] }; projection?: { currentTurnId?: string; status?: string; pendingPermissions?: { requestId?: string; toolCallId?: string }[]; activeToolCalls?: { toolCallId: string; toolName: string; status: string }[] } }
type NativePlan = ZCodeNativeState & NativeSelection & { worktreeProcessBaseline?: 1; requestDigest: string; policyDigest: string; cliPath: string; cliVersion: string; cliSha256: string; builtinSha256: string; queryId: string; runtime: string; tmp: string; workspace: string; receiptFile: string; modelSnapshotDigest?: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type StopEvidence = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; acknowledged: boolean; idle: boolean; closed: boolean; stderrBytes: number; stderrSha256: string }
type Completed = { plan: NativePlan; witness: ZCodeFrozenWitness; result: NativeResult }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytesDigest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const active = new Map<string, { interrupt(): void }>()
const fixedPolicy = (execution: ZCodeStructuredExecution) => execution.policy === 'native-worktree-v1' ? structuredExecutionPolicy(execution) : ({ ...structuredExecutionPolicy(execution), version: execution.timeoutMs === null ? 5 : 4, policy: 'zcode-frozen-read-only-v1' })

/** 原业务正文逐字保留；唯一原生user输入前置固定、只读的精确JSON schema控制段。 */
export function zcodeStructuredPrompt(prompt: string, schema: Record<string, unknown>): string {
  return `SpexCode structured-output contract (read-only control):\nReturn exactly one JSON value matching the JSON Schema below. Do not add prose or Markdown.\nJSON Schema: ${JSON.stringify(schema)}\nEnd of structured-output contract.\n\n${prompt}`
}

/** 正常工作区模式的 schema 只约束结果，不声明只读工具控制。 */
function zcodeExecutionPrompt(prompt: string, execution: ZCodeStructuredExecution): string {
  return execution.policy === 'native-worktree-v1' ? `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}` : zcodeStructuredPrompt(prompt, execution.schema)
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

/** session.model仅显示基础身份；正式effort以settings的真实selection和可用thoughtLevel核实。 */
export function assertZCodeModelSnapshot(snapshot: ModelSnapshot, expected: NativeSelection): void {
  const displayed = snapshot.session?.model, current = snapshot.settings?.model?.current, thought = snapshot.settings?.thoughtLevel
  for (const model of [displayed, current]) {
    if (!model || model.providerId !== expected.model.providerId || model.modelId !== expected.model.modelId || Object.keys(model).some(key => !['providerId', 'modelId', 'options'].includes(key))
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
    throw new StructuredSessionError('structured_output_format_invalid', 'ZCode terminal response is not one strict JSON document')
  }
}

/** 仅返回原样安全证明事件；transport只按type计数，绝不读取或保存headers。 */
export function zcodeProofEvent(event: NativeEvent): NativeEvent | undefined {
  if (['turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'tool.updated'].includes(event.type)) return event
  if (event.type !== 'session.updated' || typeof event.payload.toolCount !== 'number') return undefined
  const keys = ['messageCount', 'providerId', 'modelId', 'temperature', 'maxTokens', 'toolCount', 'iteration']
  if (Object.keys(event.payload).some(key => !keys.includes(key))) throw new StructuredSessionError('stale_result', 'ZCode ModelRequest includes unknown proof fields')
  return event
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
function sampleOwnedProcesses(plan: NativePlan): ProcessIdentity[] {
  if (plan.worktreeProcessBaseline === 1) {
    sampleNativeWorktreeProcesses(plan)
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
function ownedProcessesStopped(plan: NativePlan, terminate = false): boolean {
  if (plan.worktreeProcessBaseline === 1) return nativeWorktreeProcessesStopped(plan, terminate)
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
      try { process.kill(identity.pid, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return stopped
}

function verifyPlan(plan: NativePlan, root: string, prompt: string | undefined, execution: ZCodeStructuredExecution): void {
  const native = execution.zcodeNative
  if (execution.policy === 'native-worktree-v1' && plan.worktreeProcessBaseline !== 1 || plan.root !== root || native?.root !== root || plan.sessionId !== native.sessionId || plan.inputId !== native.inputId
    || plan.policyDigest !== digest(fixedPolicy(execution)) || prompt !== undefined && plan.requestDigest !== digest({ prompt, nativePrompt: zcodeExecutionPrompt(prompt, execution), policy: fixedPolicy(execution), selection: zcodeNativeSelection(execution.model, execution.effort) })
    || plan.cliVersion !== zcodeCapability.cliVersion || plan.cliSha256 !== zcodeCapability.cliSha256 || plan.builtinSha256 !== zcodeCapability.builtinSha256
    || digest({ model: plan.model, ...(plan.thoughtLevel ? { thoughtLevel: plan.thoughtLevel } : {}) }) !== digest(zcodeNativeSelection(execution.model, execution.effort)) || native.turnId && native.turnId !== plan.turnId || native.pid !== plan.pid || native.receiptFile && native.receiptFile !== plan.receiptFile
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== plan.turnId)
    throw new StructuredSessionError('stale_result', 'ZCode fixed native plan or durable identity differs')
  if (existsSync(join(root, 'send.json')) && (!plan.modelSnapshotDigest || !existsSync(join(root, 'model-snapshot.json')) || plan.modelSnapshotDigest !== digest(JSON.parse(readFileSync(join(root, 'model-snapshot.json'), 'utf8'))))) throw new StructuredSessionError('stale_result', 'ZCode saved pre-send model selection differs')
  if (prompt !== undefined && existsSync(join(root, 'send.json')) && digest(JSON.parse(readFileSync(join(root, 'send.json'), 'utf8'))) !== digest({ sessionId: plan.sessionId, content: zcodeExecutionPrompt(prompt, execution), inputId: plan.inputId, modelSelection: plan.model })) throw new StructuredSessionError('stale_result', 'ZCode original send differs from the exact native schema/prompt input')
}

/** 同一原生 session/input/query/turn 和实际模型选择证明正常工具执行的终态。 */
function settleWorktreeResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution): WorktreeNativeResult {
  verifyPlan(plan, plan.root, prompt, execution)
  if (execution.state !== 'completed' && !ownedProcessesStopped(plan)) throw new StructuredSessionError('cancellation_pending', 'ZCode worktree native or unknown orphan stop remains unproven')
  const read = (name: string): unknown => JSON.parse(readFileSync(join(plan.root, name), 'utf8'))
  const terminal = read('terminal.json') as NativeEvent, events = read('events.json') as NativeEvent[], messages = read('messages.json') as Array<{ info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }>
  const exit = read('exit.json') as StopEvidence, send = read('send.json')
  const starts = events.filter(event => event.type === 'turn.started'), requests = events.filter(event => event.type === 'session.updated')
  if (!plan.turnId || terminal.type !== 'turn.completed' || terminal.sessionId !== plan.sessionId || terminal.turnId !== plan.turnId || terminal.payload.inputId !== plan.inputId || terminal.payload.resultType !== 'success' || typeof terminal.payload.response !== 'string'
    || starts.length !== 1 || starts[0].payload.inputId !== plan.inputId || starts[0].payload.queryId !== plan.queryId || starts[0].turnId !== plan.turnId
    || !events.some(event => digest(event) === digest(terminal)) || events.some(event => event.sessionId !== plan.sessionId || event.turnId !== plan.turnId)
    || !requests.length || requests.some(event => event.payload.providerId !== plan.model.providerId || event.payload.modelId !== plan.model.modelId)
    || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null) throw new StructuredSessionError('stale_result', 'ZCode worktree exact native model/terminal/process evidence differs')
  const users = messages.filter(message => message.info?.role === 'user' && (message.info.semantics as Record<string, unknown>)?.kind === 'user_prompt')
  if (users.length !== 1 || users[0].info?.id !== starts[0].payload.messageId || (users[0].info?.anchor as Record<string, unknown>)?.turnId !== plan.turnId || digest(users[0].info?.modelSelection) !== digest(plan.model) || users[0].info?.sessionID !== plan.sessionId || users[0].parts?.filter(part => part.type === 'text').map(part => part.text).join('') !== zcodeExecutionPrompt(prompt, execution)) throw new StructuredSessionError('stale_result', 'ZCode worktree original native user/input differs')
  const finals = messages.filter(message => message.info?.role === 'assistant' && (message.info.anchor as Record<string, unknown>)?.turnId === plan.turnId && (message.info.semantics as Record<string, unknown>)?.kind === 'assistant_response')
  if (!finals.length || finals.at(-1)!.info?.providerId !== plan.model.providerId || finals.at(-1)!.info?.modelId !== plan.model.modelId || finals.at(-1)!.parts?.filter(part => part.type === 'text').map(part => part.text).join('') !== terminal.payload.response) throw new StructuredSessionError('stale_result', 'ZCode worktree final assistant identity/response differs')
  let output: unknown
  try { output = decodeZCodeStructuredText(terminal.payload.response) }
  catch (error) {
    if (execution.state === 'completed' && error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal response is not one strict JSON document')
    throw error
  }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(output)) {
    if (execution.state === 'completed') throw new StructuredSessionError('stale_result', 'ZCode completed worktree terminal JSON no longer matches its schema')
    const diagnostics = validate.errors?.map(({ instancePath, schemaPath, keyword, params, message }) => ({ instancePath, schemaPath, keyword, params, message })) ?? []
    throw new StructuredSessionError('structured_output_format_invalid', `ZCode worktree terminal JSON does not match its schema: ${JSON.stringify(diagnostics)}`)
  }
  const result: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.turnId, text: JSON.stringify(output) }
  const completed = { plan, terminal, events, messages, exit, send, result }
  const path = join(plan.root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== result.threadId || execution.turnId !== result.turnId || execution.resultDigest !== digest(output))) throw new StructuredSessionError('stale_result', 'ZCode worktree durable completed identity differs')
  writeJson(path, completed, true)
  return result
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
  const witness = { version: 1, provider: 'zcode', cliVersion: plan.cliVersion, cliSha256: plan.cliSha256, providerId: plan.model.providerId, modelId: plan.model.modelId, sessionId: plan.sessionId, turnId: plan.turnId, inputId: plan.inputId, prompt: zcodeExecutionPrompt(prompt, execution), send, messages, events,
    mcpHistory: { records, digest: digest(records) } } as ZCodeFrozenWitness
  if (!events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode terminal differs from its original native events')
  const { proveZCodeFrozenReads } = await import('./zcode-frozen-proof.js')
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
  const path = join(root, 'completed.json')
  if (!existsSync(path)) {
    if (!['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) || !ownedProcessesStopped(plan)) return null
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
  const { verifyZCodeFrozenReadProof } = await import('./zcode-frozen-proof.js')
  const proof = saved.result.frozenReadProof
  const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as NativeEvent
  if (!saved.witness.events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode original terminal differs from completion')
  let output: unknown
  try { output = JSON.parse(decodeZCodeJsonText(terminal.payload.response as string)) }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new StructuredSessionError('stale_result', 'ZCode completed response is not one strict JSON document') }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  verifyZCodeFrozenReadProof(execution.frozenContext!, saved.result.frozenReadProof, { threadId: plan.sessionId, turnId: plan.turnId!, inputId: plan.inputId, prompt: nativePrompt }, { ...plan.model, cliVersion: plan.cliVersion, cliSha256: plan.cliSha256 }, { output })
  if (!validate(output) || saved.result.text !== JSON.stringify(output) || saved.result.threadId !== plan.sessionId || saved.result.turnId !== plan.turnId) throw new StructuredSessionError('stale_result', 'ZCode original terminal, schema or proof differs from completion')
  if (execution.state === 'completed') {
    if (execution.threadId !== plan.sessionId || execution.turnId !== plan.turnId || execution.resultDigest !== digest(execution.output) || execution.resultDigest !== digest(output)
      || !execution.frozenReadProof || digest(execution.frozenReadProof) !== digest(proof)) throw new StructuredSessionError('stale_result', 'ZCode durable completed result or proof differs')
  } else if (!ownedProcessesStopped(plan)) return null
  return saved.result
}

/** 正式取消仅对同一固定plan及已核PID/start/receipt操作，不恢复或追加prompt。 */
export async function stopZCodeStructuredTurn(execution: ZCodeStructuredExecution, timeoutMs = 15000): Promise<StopResult> {
  const native = execution.zcodeNative
  if (!native) return execution.turnStartRequested ? { nativeStopped: false, acknowledged: false, error: 'ZCode dispatch identity is unproven' } : { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const path = join(native.root, 'plan.json')
  if (!existsSync(path)) return { nativeStopped: false, acknowledged: false, error: 'ZCode exact launch plan is missing' }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as NativePlan
  try { verifyPlan(plan, native.root, undefined, execution) }
  catch { return { nativeStopped: false, acknowledged: false, error: 'ZCode fixed launch policy or native identity differs' } }
  if (!execution.turnStartRequested && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  if (!plan.pid || plan.pid !== native.pid || plan.receiptFile !== native.receiptFile) return { nativeStopped: false, acknowledged: false, error: 'ZCode launch/process identity differs' }
  const local = active.get(native.root)
  if (local) local.interrupt()
  else if (!detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
    if (!verifyDetachedRuntime(plan.pid, plan.receiptFile).ok) return { nativeStopped: false, acknowledged: false, error: 'ZCode detached runtime identity is unproven' }
    sampleOwnedProcesses(plan)
    try { process.kill(-plan.pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const deadline = Date.now() + timeoutMs
  while (!ownedProcessesStopped(plan, !local) && Date.now() < deadline) await sleep(50)
  const stopped = ownedProcessesStopped(plan), exitPath = join(native.root, 'exit.json')
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
  if (!worktree && (execution.version !== (execution.timeoutMs === null ? 5 : 4) || execution.policy !== 'zcode-frozen-read-only-v1' || !execution.frozenContext || execution.readerRuntime)) throw new StructuredSessionError('unsupported', 'ZCode requires its exact isolated frozen policy')
  const selection = zcodeNativeSelection(execution.model, execution.effort), model = selection.model, nativePrompt = zcodeExecutionPrompt(prompt, execution), root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) ? settleWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution) : null
    : await completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.zcodeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'ZCode in-progress dispatch cannot append another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'ZCode requires the verified macOS read-only sandbox')
  const resolved = spawnSync('/usr/bin/which', ['zcode'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  if (resolved.error || resolved.status !== 0) throw new StructuredSessionError('unsupported', 'ZCode CLI is unavailable')
  const cliPath = realpathSync(resolved.stdout.trim())
  if (bytesDigest(cliPath) !== zcodeCapability.cliSha256 || !existsSync(zcodeCapability.builtinPath) || bytesDigest(zcodeCapability.builtinPath) !== zcodeCapability.builtinSha256) throw new StructuredSessionError('unsupported', 'ZCode CLI or public builtin capability digest is unverified')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const runtime = join(root, 'runtime'), home = join(runtime, 'home'), ledgerRoot = join(runtime, 'frozen-mcp'), tmp = mkdtempSync('/private/tmp/spex-zcode-tmp-'), workspace = worktree ? worktreePath! : mkdtempSync('/private/tmp/spex-zcode-frozen-')
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
  const version = spawnSync(worktree ? cliPath : '/usr/bin/sandbox-exec', worktree ? ['--version'] : ['-f', profile, cliPath, '--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 10000 })
  if (version.error || version.status !== 0 || version.stdout.trim() !== zcodeCapability.cliVersion) throw new StructuredSessionError('unsupported', 'ZCode CLI version has no verified isolated capability identity')
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
  let plan: NativePlan = { ...(worktree ? { worktreeProcessBaseline: 1 as const } : {}), version: 1, root, sessionId: `sess_${randomUUID()}`, inputId: randomUUID(), queryId: randomUUID(), requestDigest: digest({ prompt, nativePrompt, policy: fixedPolicy(execution), selection }), policyDigest: digest(fixedPolicy(execution)), cliPath, cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, ...selection, runtime, tmp, workspace, receiptFile: join(root, 'process.json') }
  writeJson(join(root, 'plan.json'), plan)
  const native = (): ZCodeNativeState => ({ version: 1, root, sessionId: plan.sessionId, inputId: plan.inputId, ...(plan.pid ? { pid: plan.pid, receiptFile: plan.receiptFile } : {}), ...(plan.turnId ? { turnId: plan.turnId } : {}) })
  await callbacks.onNative(native()); await callbacks.onTurnStarting?.()
  let launchFailure: Error | undefined
  if (worktree) sampleNativeWorktreeProcesses(plan)
  const child: ChildProcessWithoutNullStreams = spawn(worktree ? cliPath : '/usr/bin/sandbox-exec', worktree ? [ 'app-server', '--cwd', workspace] : ['-f', profile, cliPath, 'app-server', '--cwd', workspace], { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.once('error', () => { launchFailure = new StructuredSessionError('cancellation_pending', 'ZCode native process failed during launch') })
  if (!child.pid) throw new StructuredSessionError('failed', 'ZCode isolated process could not start')
  let exited = false
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  try {
    writeDetachedRuntimeReceipt(child.pid, plan.receiptFile)
    plan = { ...plan, pid: child.pid }; writeJson(join(root, 'plan.json'), plan); sampleOwnedProcesses(plan); await callbacks.onNative(native())
  } catch {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', 'ZCode spawned ownership could not be durably published; exact stop is required')
  }
  let nextId = 0, protocolError: Error | undefined = launchFailure, abortRequested = false, timedOut = false, acknowledged = false, sessionCreated = false, sent = false, closeAcknowledged = false, idle = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (exited || !child.stdin.writable) { reject(new StructuredSessionError('cancellation_pending', 'ZCode native transport ended before exact settlement')); return }
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new StructuredSessionError('cancellation_pending', `ZCode native RPC timeout (${method})`)) }, 10000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let packet: { id?: number | string; method?: string; params?: { sessionId?: string; toolName?: string; input?: { file_path?: string; path?: string } }; result?: unknown; error?: { code?: number } }
    try { packet = JSON.parse(line) as typeof packet } catch { protocolError = new StructuredSessionError('failed', 'ZCode emitted non-JSON native protocol'); return }
    if (packet.method && packet.id !== undefined) {
      if (packet.method === 'session/requestRuntimePreferences' && packet.params?.sessionId === plan.sessionId) child.stdin.write(`${JSON.stringify({ id: packet.id, result: { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, additionalDirectories: [], modelContextBudgetStrategy: 'preflight-v1' } })}\n`)
      else if (worktree && packet.method === 'interaction/requestPermission' && packet.params?.sessionId === plan.sessionId) {
        const decision = zcodeWorktreePermission(packet.params, plan.sessionId, workspace, execution.worktree!.mode)
        child.stdin.write(`${JSON.stringify({ id: packet.id, result: { decision, reason: decision === 'allow' ? 'Task-authorized native worktree invocation' : 'Outside this native worktree task' } })}\n`)
      }
      else child.stdin.write(`${JSON.stringify({ id: packet.id, error: { code: -32601, message: 'Unavailable in frozen read-only runtime' } })}\n`)
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
  let terminal: NativeEvent | undefined, cursor: number | undefined, stopSent = false
  const interrupt = (): void => { abortRequested = true }
  active.set(root, { interrupt }); callbacks.signal?.addEventListener('abort', interrupt, { once: true })
  const timeout = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true; interrupt()
    void Promise.resolve().then(() => callbacks.onTimeout?.()).catch(() => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode timeout cancellation could not be durably published') })
  })
  const poll = async (): Promise<void> => {
    sampleOwnedProcesses(plan)
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
      if (!plan.turnId || event.turnId !== plan.turnId) throw new StructuredSessionError('stale_result', 'ZCode proof event belongs to another turn')
      if (event.type === 'session.updated' && (event.payload.providerId !== model.providerId || event.payload.modelId !== model.modelId || (!worktree && event.payload.toolCount !== 1))) throw new StructuredSessionError('unsupported', 'ZCode actual ModelRequest identity or toolCount differs')
      if (event.type === 'tool.updated' && event.payload.kind === 'scheduled' && !worktree && event.payload.toolName !== zcodeCapability.tool) throw new StructuredSessionError('unsupported', 'ZCode scheduled an uncontrolled tool')
      events.push(event)
      if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
        if (terminal) throw new StructuredSessionError('stale_result', 'ZCode returned multiple terminal events')
        terminal = event; writeJson(join(root, 'terminal.json'), terminal, true)
      }
    }
    writeJson(join(root, 'events.json'), events); writeJson(join(root, 'event-counts.json'), counts)
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
      ...(worktree ? { mcpServers: [] } : { mcpServers: [{ name: 'frozen', command: process.execPath, args, env: [], cwd: workspace, isolation: 'session', protocolVersion: 'legacy', alwaysLoad: true }], toolAllowlist: [zcodeCapability.tool], toolDenylist: ['Bash', 'Read', 'Edit', 'Write', 'Task', 'WebSearch', 'WebFetch'] }) }) as { session?: { sessionId: string; model: typeof model }; snapshot?: { session?: { sessionId: string; model: typeof model } } }
    const session = created.session ?? created.snapshot?.session
    if (session?.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode actual session identity differs')
    sessionCreated = true; await callbacks.onThread(plan.sessionId)
    const ready = await request('session/read', { sessionId: plan.sessionId }) as ModelSnapshot
    if (ready.session?.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode model snapshot belongs to another session')
    assertZCodeModelSnapshot({ session, settings: ready.settings }, selection)
    assertZCodeModelSnapshot(ready, selection)
    const modelSnapshot = { sessionId: plan.sessionId, model: ready.settings!.model!.current, thoughtLevel: ready.settings?.thoughtLevel?.current }
    writeJson(join(root, 'model-snapshot.json'), modelSnapshot, true)
    plan = { ...plan, modelSnapshotDigest: digest(modelSnapshot) }; writeJson(join(root, 'plan.json'), plan)
    if (callbacks.signal?.aborted) interrupt()
    if (abortRequested) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'ZCode cancelled before send')
    const send = { sessionId: plan.sessionId, content: nativePrompt, inputId: plan.inputId, modelSelection: selection.model }
    writeJson(join(root, 'send.json'), send, true); sent = true
    const ack = await request('session/send', { ...send, queryId: plan.queryId }) as { accepted?: boolean; sessionId?: string }
    if (ack.accepted !== true || ack.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode send ACK has no exact accepted session')
    let cancellationDeadline: number | undefined
    while (!terminal) {
      if (protocolError) throw protocolError
      if (abortRequested) { await stop(); cancellationDeadline ??= Date.now() + 10000 }
      await poll()
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
        while (!terminal && Date.now() < deadline && !exited) { await poll(); if (!terminal) await sleep(100) }
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
        sampleOwnedProcesses(plan)
        const response = await request('session/close', { sessionId: plan.sessionId, expectedPersistence: 'immediate' }) as { closed?: boolean }
        closeAcknowledged = response.closed === true
      }
    } catch (error) { resultError ??= error }
    child.stdin.end()
    let exit = await Promise.race([closed, sleep(3000).then(() => undefined)])
    if (!exit || !ownedProcessesStopped(plan)) {
      if (verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok) {
        sampleOwnedProcesses(plan)
        try { process.kill(-plan.pid!, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const deadline = Date.now() + 3000
      while (!ownedProcessesStopped(plan, true) && Date.now() < deadline) await sleep(50)
      exit ??= await Promise.race([closed, sleep(100).then(() => undefined)])
    }
    const stopped = ownedProcessesStopped(plan)
    writeJson(join(root, 'exit.json'), { code: exit?.code ?? null, signal: exit?.signal ?? null, stopped, acknowledged, idle, closed: closeAcknowledged, stderrBytes, stderrSha256: stderrHash.digest('hex') } satisfies StopEvidence, true)
    if (!stopped) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); resultError = new StructuredSessionError('cancellation_pending', 'ZCode app/MCP process stop is unproven') }
  } catch {
    resultError = new StructuredSessionError('cancellation_pending', 'ZCode native cleanup or stop evidence could not be settled')
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
  } finally {
    clearTimeout(timeout); callbacks.signal?.removeEventListener('abort', interrupt); active.delete(root); lines.close()
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new StructuredSessionError('cancellation_pending', 'ZCode transport closed')) }
  }
  if (abortRequested) throw new StructuredSessionError(ownedProcessesStopped(plan) ? timedOut ? 'timeout' : 'cancelled' : 'cancellation_pending', 'ZCode cancellation revoked result publication')
  if (resultError) throw resultError
  return worktree ? settleWorktreeResult(plan, prompt, { ...execution, zcodeNative: native() }) : settleResult(plan, prompt, execution)
}
