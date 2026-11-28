import { loadManagerNativeRuntime, managedClaudeCommand } from './llm-manager-host.js'
import { managedRoute, nativeModelValue } from './llm-manager-route.js'
import { claudeReplay } from '../llm-manager/native-runtime.mjs'
import { NATIVE_PROCESS_OBSERVATION_LIMIT_MS, NATIVE_PROCESS_OBSERVATION_PENDING, nativeWorktreeLaunch, nativeWorktreeProcessesStopped, sampleNativeWorktreeProcesses } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { proveClaudeFrozenReads, readClaudeMcpToolNames, readClaudePublicHistory, verifyFrozenReadProof, type ClaudeHistoryDecoder, type ClaudeFrozenWitness, type ClaudePublicMessage, type ClaudePublicRecord, type FrozenReadProof } from './frozen-context.js'
import { rejectedFinalOutput, structuredExecutionTimer, StructuredSessionError, StructuredSessionTransportError, structuredExecutionPolicy, structuredSeatbeltProfile, type NativeTokenUsage, type StructuredExecution } from './session-structured-policy.js'
import { sessionIdentityEnvVars } from './harness-shim.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type NativePlan = { version: 1 | 2; root: string; sessionId: string; userUuid: string; requestDigest: string; policyDigest: string; historyPath?: string; cliPath: string; cliVersion: string; binaryDigest: string; pid?: number; receiptFile: string; workspace?: string; configRoot?: string; requestedModel?: string; resolvedModel?: string; historyDigest?: string }
type WorktreeNativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never; nativeTokenUsage?: NativeTokenUsage }
type NativeExit = { code: number | null; signal: string | null; stopped: boolean }
type WorktreeTerminalResult = ClaudeFrozenWitness['result'] & { nativeTokenUsage?: NativeTokenUsage; apiErrorStatus?: 429 }
type ClaudeInit = { tools: string[]; session_id: string; model: string }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: FrozenReadProof }
type Completed = { plan: NativePlan; witness: ClaudeFrozenWitness; result: NativeResult }
type TerminalStopRequest = { version: 1; reason: 'terminal_settlement'; sessionId: string; userUuid: string; pid: number; receiptDigest: string; requestDigest: string; resultDigest: string; signal: 'SIGTERM'; requestedAt: number }
type TerminalStopObservation = { version: 1; requestObservationDigest: string; outcome: 'sent' | 'gone'; observedAt: number }
type NativeCallbacks = { onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onNative(state: NonNullable<StructuredExecution['claudeNative']>): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type ClaudeModelOptions = { sessionId: string; model: string; schema: Record<string, unknown>; effort?: string }
type ClaudeConfiguration = 'cli-config-v1'
type ClaudeProjection =
  | { kind: 'init'; init: ClaudeInit }
  | { kind: 'user-echo'; echo: ClaudeFrozenWitness['echo'] }
  | { kind: 'interrupt-ack'; requestId: string }
  | { kind: 'result'; result: ClaudeFrozenWitness['result']; receipt: WorktreeTerminalResult }
type ClaudeRetryEvidence = { calls: Map<string, ClaudePublicRecord>; responses: Map<string, ClaudeToolReply> }
type ClaudeDiagnostics = {
  claudeSchemaRetryDiagnostics(calls: ClaudeRetryEvidence['calls'], responses: ClaudeRetryEvidence['responses']): { callId: string; fields: { path: string; error: string }[] }[]
  projectClaudeWorktreeSchemaFailure(history: readonly ClaudePublicRecord[], original: ClaudePublicRecord, options: { exactModel?: string; isSchemaValid(input: unknown): boolean }): ClaudeRetryEvidence & { rejected: unknown }
  projectClaudeFrozenSchemaFailure(history: readonly ClaudePublicRecord[], source: string, original: ClaudePublicRecord, options: {
    sessionId: string; userUuid: string; model: string; prompt: string; allowedTools: readonly string[]
    init: ClaudeInit; echo: ClaudeFrozenWitness['echo']; result: ClaudeFrozenWitness['result']
  }): ClaudeRetryEvidence
}
type ClaudeSettlement = {
  claudeUnsuccessfulExitMessage(exit: Pick<NativeExit, 'code' | 'signal'>, reportedError: boolean | 'invalid'): string
  claudeStoppedAnalysisFailureMatches(message?: string): boolean
  claudeNaturalSuccessExit(exit: Pick<NativeExit, 'code' | 'signal'>): boolean
  claudeControlledTerminalExit(exit: Pick<NativeExit, 'code' | 'signal'>): boolean
  claudeSchemaExhaustionExit(exit: Pick<NativeExit, 'code' | 'signal'>, terminalSignalSent: boolean): boolean
  claudeStoppedErrorExit(exit: Pick<NativeExit, 'code' | 'signal' | 'stopped'>): boolean
}
type ClaudeEvidenceAdapter = ClaudeHistoryDecoder & {
  CLAUDE_LEGACY_CLI_VERSION: ClaudeFrozenWitness['cliVersion']
  CLAUDE_FROZEN_TOOLS: readonly string[]
  claudeNativeHistoryPath(configRoot: string, sessionId: string): string
  claudeMessageMatchesPrompt(message: unknown, prompt: string): boolean
}
type ClaudeAdapter = ClaudeEvidenceAdapter & ClaudeDiagnostics & ClaudeSettlement & {
  inspectClaudeCliVersion(launch: ReturnType<typeof nativeWorktreeLaunch>, nativeConfiguration?: ClaudeConfiguration): string
  assertClaudeLegacyConfiguration(environment: NodeJS.ProcessEnv): void
  claudeNativeModel(model: string | undefined, configuration?: ClaudeConfiguration, managedModel?: string): string
  claudeStructuredArgs(options: ClaudeModelOptions & { mcpConfig: string; allowedTools: readonly string[]; systemPrompt: string }): string[]
  claudeWorktreeArgs(options: ClaudeModelOptions & { mode?: 'read' | 'edit'; nativeConfiguration?: ClaudeConfiguration; managedApi?: true }): string[]
  prepareClaudeAuthenticationEnvironment(env: NodeJS.ProcessEnv, settingsPath?: string): { environment: NodeJS.ProcessEnv; source: string }
  prepareClaudeStructuredInvocation(input: ClaudeModelOptions & {
    cwd: string; environment: NodeJS.ProcessEnv; nativeConfiguration?: ClaudeConfiguration; configHome: string
    tmpDir: string; debugDir: string; stripEnvironment: readonly string[]
    worktreeMode?: 'read' | 'edit'; managedApi?: true
    frozen?: { mcpConfig: string; authentication: ReturnType<typeof nativeWorktreeLaunch> }
  }, onAuthentication: (receipt: object) => void): { environment: NodeJS.ProcessEnv; configRoot: string; args: string[] }
  claudeFrozenMcpConfiguration(command: string, args: string[]): object
  connectClaudeStructuredStream(pipes: Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout'>, options: {
    sessionId: string; userUuid: string; model: string; nativeConfiguration?: ClaudeConfiguration; worktree: boolean
    managedRoute: boolean
  }, callbacks: {
    shouldConsume(): boolean
    onObservation(observation: object): void
    onEvent(event: ClaudeProjection): Promise<void>
    onError(error: unknown, ordinal: number): void
  }): { start(prompt: string): void; interrupt(requestId: string): void; drain(): Promise<void>; close(): void }
  isClaudeRateLimitTerminal(result: WorktreeTerminalResult, exit: Pick<NativeExit, 'code' | 'signal'>): boolean
}

const claudeReplayAdapter = claudeReplay as Pick<ClaudeAdapter, 'claudeNativeModel'> & ClaudeEvidenceAdapter & ClaudeDiagnostics & ClaudeSettlement
const { CLAUDE_LEGACY_CLI_VERSION: CLI_VERSION, CLAUDE_FROZEN_TOOLS: toolNames } = claudeReplayAdapter

export async function loadClaudeNativeAdapter(): Promise<ClaudeAdapter> {
  return await (await loadManagerNativeRuntime()).loadNativeAdapter('claude') as ClaudeAdapter
}

function claudeAdapterError(adapter: Pick<ClaudeAdapter, 'ClaudeNativeProtocolError'>, error: unknown): unknown {
  if (!(error instanceof adapter.ClaudeNativeProtocolError)) return error
  return error.code === 'history_pending' ? new StructuredSessionTransportError(error.message) : new StructuredSessionError(error.code, error.message)
}

const active = new Map<string, { child: ChildProcessWithoutNullStreams; interrupt: () => void }>()
/** MCP可能由CLI另建进程组；还需逐个核本桥自记的PID/start，不能只看CLI leader。 */
function claudeMcpStopped(root: string, terminate = false): boolean {
  const path = join(root, 'mcp-public.jsonl')
  if (!existsSync(path)) return false
  const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; pid?: number; startToken?: string })
  const processes = records.filter(record => record.type === 'process')
  if (!processes.length) return false
  let stopped = true
  for (const record of processes) {
    if (!record.pid) return false
    const token = processStartToken(record.pid)
    if (record.startToken && token && token !== record.startToken) continue
    try { process.kill(record.pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error }
    stopped = false
    if (terminate && record.startToken && token === record.startToken) {
      try { process.kill(record.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return stopped
}

/** 同一完成见证可重入复用；原子发布避免崩溃留下半个只读JSON。 */
function persistCompletionJson(path: string, value: unknown): void {
  const bytes = JSON.stringify(value)
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new StructuredSessionError('stale_result', 'Claude immutable completion evidence differs')
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, bytes, { mode: 0o400 }); renameSync(temporary, path)
}

function nativeHistoryPath(configRoot: string, sessionId: string, decoder: ClaudeEvidenceAdapter): string {
  try { return decoder.claudeNativeHistoryPath(configRoot, sessionId) }
  catch (error) { throw claudeAdapterError(decoder, error) }
}

/** 新配置语义将不透明选择交给CLI；旧冻结请求保持原exact ID约束。 */
export function claudeNativeModel(model: string | undefined, nativeConfiguration?: 'cli-config-v1'): string {
  try { return claudeReplayAdapter.claudeNativeModel(model, nativeConfiguration, nativeConfiguration && nativeModelValue(model, 'claude')) }
  catch (error) { throw claudeAdapterError(claudeReplayAdapter, error) }
}

type ClaudeToolReply = Exclude<ClaudePublicMessage['content'], string>[number]

/** 两种执行模式共用原生 schema 错误字段提取，不修补模型业务结果。 */
function claudeSchemaRetryError(calls: ClaudeRetryEvidence['calls'], responses: ClaudeRetryEvidence['responses'], identity: { threadId: string; turnId: string; rejectedOutput?: StructuredExecution['rejectedOutput']; nativeTokenUsage?: NativeTokenUsage }, diagnostics: ClaudeDiagnostics): StructuredSessionError {
  const schemaErrors = diagnostics.claudeSchemaRetryDiagnostics(calls, responses)
  return new StructuredSessionError('structured_output_retries_exhausted', `Claude error_max_structured_output_retries rejected the structured output; original native result and schema errors remain in its history${schemaErrors.length ? `; schemaErrors=${JSON.stringify(schemaErrors)}` : ''}`, identity)
}

/** 旧 worktree plan 的真实 cwd 已在不可变 launch 中；所有结算入口共用同一归一。 */
function claudeWorktreeProcessPlan(plan: NativePlan): NativePlan {
  if (plan.workspace) return plan
  const path = join(plan.root, 'launch.json')
  if (!existsSync(path)) throw new StructuredSessionError('cancellation_pending', 'Claude worktree task directory is unproven')
  const launch = JSON.parse(readFileSync(path, 'utf8')) as { cwd?: unknown }
  if (typeof launch.cwd !== 'string' || !isAbsolute(launch.cwd)) throw new StructuredSessionError('cancellation_pending', 'Claude worktree launch cwd is unproven')
  return { ...plan, workspace: launch.cwd }
}

/** 新轮绑定唯一init的选择表达式；API实际模型由各自原生history记录认证。 */
function claudeWorktreeModel(plan: NativePlan, execution: StructuredExecution, init: { model: string }): string {
  if (execution.nativeConfiguration === 'cli-config-v1') {
    if (plan.version !== 2 || plan.requestedModel !== execution.model || typeof init.model !== 'string' || !init.model.trim() || plan.resolvedModel !== init.model || !plan.cliVersion.trim())
      throw new StructuredSessionError('stale_result', 'Claude native configuration or resolved init model differs from its launch')
    return init.model
  }
  if (plan.version === 2 || plan.cliVersion !== CLI_VERSION || init.model !== claudeNativeModel(execution.model)) throw new StructuredSessionError('stale_result', 'Claude legacy exact model/version identity differs')
  return init.model
}

/** 原生history只读过滤后封存到本轮；冷完成不再读取当前配置或全局history。 */
function claudeWorktreeHistory(plan: NativePlan, completed: boolean, decoder: ClaudeEvidenceAdapter): ClaudePublicRecord[] {
  if (plan.version !== 2) return readClaudePublicHistory(nativeHistoryPath(join(plan.root, 'claude-home'), plan.sessionId, decoder), plan.sessionId, decoder)
  const path = join(plan.root, 'public-history.json')
  if (!existsSync(path)) {
    if (completed || !plan.configRoot) throw new StructuredSessionError('stale_result', 'Claude native completion has no pinned public history')
    const historyPath = nativeHistoryPath(plan.configRoot, plan.sessionId, decoder)
    const history = readClaudePublicHistory(historyPath, plan.sessionId, decoder)
    if (plan.historyDigest && plan.historyDigest !== hash(history)) throw new StructuredSessionError('stale_result', 'Claude native history changed before public snapshot publication')
    plan.historyPath = historyPath
    plan.historyDigest = hash(history)
    writeFileSync(join(plan.root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
    persistCompletionJson(path, { version: 1, sessionId: plan.sessionId, history })
  }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sessionId: string; history: ClaudePublicRecord[] }
  if (saved.version !== 1 || saved.sessionId !== plan.sessionId || !Array.isArray(saved.history) || !plan.historyDigest || plan.historyDigest !== hash(saved.history)) throw new StructuredSessionError('stale_result', 'Claude native public history snapshot differs from its launch')
  return saved.history
}

/** 正常文件工具保持开放；失败仅认证同轮工具配对、原生模型与严格 companion。 */
function worktreeSchemaRetryError(history: readonly ClaudePublicRecord[], original: ClaudePublicRecord, execution: StructuredExecution, prompt: string, exactModel: string | undefined, nativeTokenUsage: NativeTokenUsage | undefined, diagnostics: ClaudeDiagnostics & ClaudeHistoryDecoder): StructuredSessionError {
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  let projection: ClaudeRetryEvidence & { rejected: unknown }
  try { projection = diagnostics.projectClaudeWorktreeSchemaFailure(history, original, { exactModel, isSchemaValid: validate }) }
  catch (error) { throw claudeAdapterError(diagnostics, error) }
  const { calls, responses, rejected } = projection
  const identity = { threadId: original.sessionId, turnId: original.uuid! }
  return claudeSchemaRetryError(calls, responses, { ...identity, nativeTokenUsage, ...(rejected !== undefined ? { rejectedOutput: rejectedFinalOutput(JSON.stringify(rejected), prompt, execution, identity, 'native_json') } : {}) }, diagnostics)
}

/** 终态控制只凭同请求的不可变意图及真实 syscall 结果；不推定已发送信号。 */
function terminalStopOutcome(plan: NativePlan, result: ClaudeFrozenWitness['result']): 'sent' | 'gone' | null {
  const requestPath = join(plan.root, 'terminal-stop-request.json'), observationPath = join(plan.root, 'terminal-stop.json')
  if (!existsSync(requestPath) && !existsSync(observationPath)) return null
  if (!existsSync(requestPath)) throw new StructuredSessionError('stale_result', 'Claude terminal stop has no matching request observation')
  if (!existsSync(observationPath)) throw new StructuredSessionError('cancellation_pending', 'Claude terminal stop syscall outcome remains unproven')
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as TerminalStopRequest, observation = JSON.parse(readFileSync(observationPath, 'utf8')) as TerminalStopObservation
  if (request.version !== 1 || request.reason !== 'terminal_settlement' || request.signal !== 'SIGTERM' || request.sessionId !== plan.sessionId || request.userUuid !== plan.userUuid
    || request.pid !== plan.pid || request.receiptDigest !== hash(JSON.parse(readFileSync(plan.receiptFile, 'utf8'))) || request.requestDigest !== plan.requestDigest || request.resultDigest !== hash(result)
    || !Number.isFinite(request.requestedAt) || request.requestedAt <= 0 || observation.version !== 1 || observation.requestObservationDigest !== hash(request)
    || !['sent', 'gone'].includes(observation.outcome) || !Number.isFinite(observation.observedAt) || observation.observedAt < request.requestedAt)
    throw new StructuredSessionError('stale_result', 'Claude terminal stop observation differs from its exact native request/result/receipt')
  return observation.outcome
}

/** 自有终态清理只解释实际退出形态，不替代原生结果与停止认证。 */
function controlledClaudeWorktreeTerminalExit(plan: NativePlan, execution: StructuredExecution, result: ClaudeFrozenWitness['result'], exit: { code: number | null; signal: string | null; stopped: boolean }, signal?: AbortSignal, adapter: Pick<ClaudeHistoryDecoder, 'claudeWorktreeTerminal'> & Pick<ClaudeSettlement, 'claudeControlledTerminalExit'> = claudeReplayAdapter): boolean {
  if (!adapter.claudeControlledTerminalExit(exit) || exit.stopped !== true
    || !adapter.claudeWorktreeTerminal(result).isSuccess
    || signal?.aborted || execution.cancellation || execution.error !== undefined || execution.errorCode !== undefined
    || execution.state !== undefined && execution.state !== 'running' && execution.state !== 'completed'
    || existsSync(join(plan.root, 'interrupt-request.json'))) return false
  const protocol = join(plan.root, 'native-protocol.jsonl')
  if (existsSync(protocol) && readFileSync(protocol, 'utf8').split('\n').some(line => line && (JSON.parse(line) as { kind: string }).kind === 'error')) return false
  return terminalStopOutcome(plan, result) === 'sent'
}

/** 原生计划只认证固定请求和进程身份；不会采样、派发或写入。 */
function assertClaudeWorktreePlan(plan: NativePlan, prompt: string, execution: StructuredExecution): void {
  const root = plan.root, native = execution.claudeNative
  if (plan.requestDigest !== hash({ prompt, policy: structuredExecutionPolicy(execution) }) || plan.policyDigest !== hash(structuredExecutionPolicy(execution))
    || !native || native.version !== (plan.version === 2 ? 2 : 1) || native.root !== root || native.sessionId !== plan.sessionId || native.userUuid !== plan.userUuid || native.pid !== plan.pid || native.receiptFile !== plan.receiptFile) throw new StructuredSessionError('stale_result', 'Claude worktree completion lost its exact request/native/process identity')
}

/** 原工作区请求与公开终态共用认证；sealed只读模式不封存或改写旧原件。 */
function authenticateClaudeWorktreeResult(plan: NativePlan, prompt: string, execution: StructuredExecution, sealed = false, decoder: ClaudeEvidenceAdapter = claudeReplayAdapter) {
  assertClaudeWorktreePlan(plan, prompt, execution)
  const root = plan.root
  if (sealed && (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile))) throw new StructuredSessionError('cancellation_pending', 'Claude worktree native or unknown orphan stop remains unproven')
  const init = JSON.parse(readFileSync(join(root, 'init.json'), 'utf8')) as { session_id: string; model: string; tools: string[] }
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  const { nativeTokenUsage, ...result } = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as WorktreeTerminalResult
  const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number | null; signal: string | null; stopped: boolean }
  const selection = claudeWorktreeModel(plan, execution, init)
  const history = claudeWorktreeHistory(plan, sealed || execution.state === 'completed', decoder), original = history.find(row => row.type === 'user' && row.uuid === plan.userUuid)
  if (init.session_id !== plan.sessionId || !original?.promptId || original.sessionId !== plan.sessionId || plan.version === 2 && history.some(row => row.sessionId !== plan.sessionId || row.type === 'api-request' && (typeof row.id !== 'string' || !row.id || typeof row.model !== 'string' || !row.model.trim()))
    || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || !decoder.claudeMessageMatchesPrompt(echo.message, prompt) || hash(original.message) !== hash(echo.message)
    || original.parentUuid !== null || !decoder.claudeTerminalMatchesIdentity(result, plan) || !exit.stopped) throw new StructuredSessionError('stale_result', 'Claude worktree original prompt/model/exit evidence differs')
  return { root, init, echo, result, exit, selection, history, original, nativeTokenUsage }
}

/** 工作区模式只核原生输入、模型和终态身份，不借用冻结读取证明。 */
async function settleClaudeWorktreeResult(plan: NativePlan, prompt: string, execution: StructuredExecution, deadline?: number, signal?: AbortSignal, adapter: ClaudeDiagnostics & ClaudeEvidenceAdapter & ClaudeSettlement = claudeReplayAdapter): Promise<() => WorktreeNativeResult> {
  assertClaudeWorktreePlan(plan, prompt, execution)
  if (execution.state !== 'completed' && !(await nativeWorktreeProcessesStopped(claudeWorktreeProcessPlan(plan), false, deadline))) throw new StructuredSessionError('cancellation_pending', 'Claude worktree native or unknown orphan stop remains unproven')
  const { root, init, echo, result, exit, selection, history, original, nativeTokenUsage } = authenticateClaudeWorktreeResult(plan, prompt, execution, false, adapter)
  const terminal = adapter.claudeWorktreeTerminal(result)
  if (terminal.subtype === 'schema_exhausted') {
    const terminalOutcome = terminalStopOutcome(plan, result)
    if (execution.state === 'completed' || existsSync(join(root, 'completed.json'))
      || !adapter.claudeSchemaExhaustionExit(exit, terminalOutcome === 'sent') || !terminal.isSchemaExhausted)
      throw new StructuredSessionError('stale_result', 'Claude worktree schema exhaustion terminal differs')
    throw worktreeSchemaRetryError(history, original, execution, prompt, plan.version === 2 ? undefined : selection, nativeTokenUsage, adapter)
  }
  const controlled = controlledClaudeWorktreeTerminalExit(plan, execution, result, exit, signal, adapter)
  if (!controlled && execution.state !== 'completed' && terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('failed', 'Claude terminal success required process-group termination and is not a completed result')
  if (!controlled && !adapter.claudeNaturalSuccessExit(exit) || !terminal.isSuccess) throw new StructuredSessionError('stale_result', 'Claude worktree success evidence differs')
  if (terminal.output === undefined) throw new StructuredSessionError(execution.state === 'completed' || existsSync(join(root, 'completed.json')) ? 'stale_result' : 'structured_output_format_invalid', 'Claude worktree success is missing required structured_output', { threadId: plan.sessionId, turnId: plan.userUuid, nativeTokenUsage })
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(terminal.output)) throw new StructuredSessionError('failed', 'Claude worktree structured output does not match its schema', execution.state === 'completed' ? {} : { threadId: plan.sessionId, turnId: plan.userUuid, nativeTokenUsage, rejectedOutput: rejectedFinalOutput(JSON.stringify(terminal.output), prompt, execution, { threadId: plan.sessionId, turnId: plan.userUuid }, 'native_json') })
  const answer: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.userUuid, text: JSON.stringify(terminal.output) }
  const completion = { plan, init, echo, result, exit, promptId: original.promptId, answer }
  const path = join(root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== answer.threadId || execution.turnId !== answer.turnId || execution.resultDigest !== hash(terminal.output))) throw new StructuredSessionError('stale_result', 'Claude worktree durable completed identity differs')
  return () => {
    if (deadline !== undefined && Date.now() >= deadline) throw new StructuredSessionError('cancellation_pending', 'Claude completion exceeded the original stop deadline')
    if (controlled && signal?.aborted) throw new StructuredSessionError('cancelled', 'Claude exact process group stopped after cancellation')
    persistCompletionJson(path, completion)
    return nativeTokenUsage ? { ...answer, nativeTokenUsage } : answer
  }
}

/** 只识别P0规范失败投影；原Native与停止证据由读取入口核实。 */
export function isClaudeFailedAnalysisDraftSource(execution: StructuredExecution): boolean {
  return execution.state === 'failed' && execution.purpose === 'code_behavior_analyze' && execution.errorCode === undefined
    && claudeReplayAdapter.claudeStoppedAnalysisFailureMatches(execution.error)
}

function readClaudeStoppedErrorTerminal(native: NonNullable<StructuredExecution['claudeNative']>) {
  const { nativeTokenUsage: _usage, ...result } = JSON.parse(readFileSync(join(native.root, 'result.json'), 'utf8')) as WorktreeTerminalResult
  const exit = JSON.parse(readFileSync(join(native.root, 'exit.json'), 'utf8')) as NativeExit
  if (claudeReplayAdapter.claudeStoppedErrorExit(exit) && claudeReplayAdapter.claudeWorktreeTerminal(result).isStoppedError
    && claudeReplayAdapter.claudeTerminalMatchesIdentity(result, native)) return { exit, result }
  return null
}

/** 停止材料须核原计划、已回显输入和同一owned工作树；不签发final。 */
export function assertClaudeStoppedDraftSource(prompt: string, execution: StructuredExecution, worktreePath: string): void {
  const native = execution.claudeNative, failedAnalysis = isClaudeFailedAnalysisDraftSource(execution)
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('claude:') || execution.worktree?.mode !== 'edit' || !native || execution.state !== 'cancelled' && !failedAnalysis || !execution.cancellation?.nativeStopped || execution.threadId !== native.sessionId || execution.turnId !== native.userUuid || existsSync(join(native.root, 'completed.json'))) throw new StructuredSessionError('stale_result', 'stopped draft observation requires its original stopped native worktree')
  const plan = JSON.parse(readFileSync(join(native.root, 'plan.json'), 'utf8')) as NativePlan
  assertClaudeWorktreePlan(plan, prompt, execution)
  if (plan.root !== native.root || realpathSync(claudeWorktreeProcessPlan(plan).workspace!) !== realpathSync(worktreePath) || !plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) throw new StructuredSessionError('stale_result', 'stopped draft observation differs from its recorded native worktree/process')
  const init = JSON.parse(readFileSync(join(plan.root, 'init.json'), 'utf8')) as ClaudeInit, echo = JSON.parse(readFileSync(join(plan.root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  claudeWorktreeModel(plan, execution, init)
  if (init.session_id !== plan.sessionId || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || !claudeReplayAdapter.claudeMessageMatchesPrompt(echo.message, prompt)) throw new StructuredSessionError('stale_result', 'stopped draft observation lost its original native input')
  if (failedAnalysis) {
    const terminal = readClaudeStoppedErrorTerminal(native)
    if (execution.cancellation.nativeStatus !== 'processGroupGone' || !terminal || execution.error !== claudeReplayAdapter.claudeUnsuccessfulExitMessage(terminal.exit, claudeReplayAdapter.claudeWorktreeTerminal(terminal.result).reportedError)
      || terminalStopOutcome(plan, terminal.result) === 'sent') throw new StructuredSessionError('stale_result', 'Claude failed analysis draft lacks its exact stopped error terminal')
  }
}

/** 新attempt只观察已停止的原缺final失败；不派发、不补签或改写旧Native证据。 */
export function observeClaudeWorktreeMissingFinal(prompt: string, execution: StructuredExecution, worktreePath: string): StructuredSessionError {
  const native = execution.claudeNative
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('claude:') || execution.worktree?.mode !== 'edit' || !native || !['failed', 'cancelled'].includes(execution.state ?? '') || execution.threadId !== native.sessionId || execution.turnId !== native.userUuid || existsSync(join(native.root, 'completed.json'))) throw new StructuredSessionError('stale_result', 'missing final observation requires the exact original failed native worktree')
  const plan = JSON.parse(readFileSync(join(native.root, 'plan.json'), 'utf8')) as NativePlan
  if (plan.root !== native.root || realpathSync(claudeWorktreeProcessPlan(plan).workspace!) !== realpathSync(worktreePath)) throw new StructuredSessionError('stale_result', 'missing final observation differs from its recorded native worktree')
  const { result, exit } = authenticateClaudeWorktreeResult(plan, prompt, execution, true)
  const terminal = claudeReplayAdapter.claudeWorktreeTerminal(result)
  if (!claudeReplayAdapter.claudeNaturalSuccessExit(exit) || !terminal.isSuccess || terminal.output !== undefined || terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('stale_result', 'original native evidence is not a naturally stopped success missing structured_output')
  return new StructuredSessionError('structured_output_format_invalid', 'Claude worktree success is missing required structured_output', { threadId: plan.sessionId, turnId: plan.userUuid })
}

/** 已停错误结果只授予未批准Git材料，不冒充缺final格式失败或成功。 */
export function observeClaudeStoppedWorktreeFailure(prompt: string, execution: StructuredExecution, worktreePath: string): StructuredSessionError | undefined {
  assertClaudeStoppedDraftSource(prompt, execution, worktreePath)
  if (readClaudeStoppedErrorTerminal(execution.claudeNative!)) return undefined
  return observeClaudeWorktreeMissingFinal(prompt, execution, worktreePath)
}

/** 完整终态重放只核原公开history、schema与原进程组，不启动CLI或新增turn。 */
function completedResult(root: string, prompt: string, execution: StructuredExecution): NativeResult | null {
  const path = join(root, 'completed.json'), planPath = join(root, 'plan.json')
  if (!existsSync(planPath)) return null
  const plan = JSON.parse(readFileSync(planPath, 'utf8')) as NativePlan
  if (plan.requestDigest !== hash({ prompt, policy: structuredExecutionPolicy(execution) }) || plan.root !== root
    || plan.sessionId !== execution.claudeNative?.sessionId || plan.userUuid !== execution.claudeNative.userUuid) throw new StructuredSessionError('stale_result', 'Claude saved launch lost its fixed request or native identity')
  if (!existsSync(path)) {
    if (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile) || !claudeMcpStopped(root)) return null
    if (!['result.json', 'init.json', 'user-echo.json'].every(name => existsSync(join(root, name)))) return null
    const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
    if (!claudeReplayAdapter.claudeWorktreeTerminal(result).mayRecoverFrozenRead) return null
    return settleClaudeResult(plan, prompt, execution)
  }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Completed
  if (hash(saved.plan) !== hash(plan)) throw new StructuredSessionError('stale_result', 'Claude completed launch plan differs')
  if (hash(saved.witness) !== saved.result.frozenReadProof.historyDigest || saved.witness.sessionId !== plan.sessionId || saved.witness.userUuid !== plan.userUuid || saved.witness.prompt !== prompt
    || saved.witness.cliVersion !== plan.cliVersion || saved.witness.model !== claudeNativeModel(execution.model) || saved.result.threadId !== plan.sessionId || saved.result.turnId !== plan.userUuid) throw new StructuredSessionError('stale_result', 'Claude cached completion witness or plan/native identities differ from authoritative evidence')
  verifyFrozenReadProof(execution.frozenContext!, saved.result.frozenReadProof, { threadId: saved.result.threadId, turnId: saved.result.turnId }, undefined, { output: JSON.parse(saved.result.text) as unknown })
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  const output = claudeReplayAdapter.claudeWorktreeTerminal(saved.witness.result).output
  if (!validate(output) || saved.result.text !== JSON.stringify(output)
    || saved.result.frozenReadProof.version !== 3 || saved.result.frozenReadProof.model !== claudeNativeModel(execution.model)) throw new StructuredSessionError('stale_result', 'Claude completed schema or provider witness differs')
  if (execution.state === 'completed') {
    if (execution.threadId !== plan.sessionId || execution.turnId !== plan.userUuid || execution.claudeNative?.pid !== plan.pid || execution.claudeNative.receiptFile !== plan.receiptFile
      || !execution.resultDigest || execution.resultDigest !== hash(execution.output) || execution.resultDigest !== hash(output)
      || !execution.frozenReadProof || hash(execution.frozenReadProof) !== hash(saved.result.frozenReadProof)) throw new StructuredSessionError('stale_result', 'Claude durable completed state has missing or mismatched result/identity/evidence')
    return saved.result
  }
  if (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile) || !claudeMcpStopped(root)) return null
  return saved.result
}

/** 原生完整result和停止证据可在崩溃后补成相同proof；任何缺失都不能通过新prompt补齐。 */
function settleClaudeResult(plan: NativePlan, prompt: string, execution: StructuredExecution, adapter: ClaudeDiagnostics & ClaudeEvidenceAdapter & ClaudeSettlement = claudeReplayAdapter): NativeResult {
  const { root } = plan, model = claudeNativeModel(execution.model)
  const init = JSON.parse(readFileSync(join(root, 'init.json'), 'utf8')) as { session_id: string; model: string; tools: string[] }
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
  if (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile) || !claudeMcpStopped(root) || plan.cliVersion !== CLI_VERSION || init.model !== model || init.session_id !== plan.sessionId) throw new StructuredSessionError('stale_result', 'Claude complete native result lost its version, model or process-stop identity')
  const terminal = adapter.claudeWorktreeTerminal(result)
  if (terminal.subtype === 'success' && terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('failed', 'Claude terminal success required process-group termination and is not a completed result')
  const historyPath = nativeHistoryPath(join(root, 'claude-home'), plan.sessionId, adapter)
  if (plan.historyPath && plan.historyPath !== historyPath) throw new StructuredSessionError('stale_result', 'Claude pinned native history path differs')
  const history = readClaudePublicHistory(historyPath, plan.sessionId, adapter), original = history.find(row => row.type === 'user' && row.uuid === plan.userUuid)
  if (!original?.promptId) throw new StructuredSessionError('stale_result', 'Claude original native promptId is missing')
  const mcpPath = join(root, 'mcp-public.jsonl')
  if (terminal.subtype === 'schema_exhausted') {
    const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number | null; signal: string | null; stopped: boolean }
    if (!adapter.claudeStoppedErrorExit(exit) || terminalStopOutcome(plan, result) === 'sent'
      || plan.policyDigest !== hash(structuredExecutionPolicy(execution)) || execution.claudeNative && (execution.claudeNative.pid !== plan.pid || execution.claudeNative.receiptFile !== plan.receiptFile)
      || readClaudeMcpToolNames(mcpPath, adapter).some(name => name !== 'spex_read_frozen'))
      throw new StructuredSessionError('stale_result', 'Claude schema retry exhaustion lost its exact terminal, API, original user or isolated capability identity')
    const source = readFileSync(historyPath, 'utf8')
    let projection: ClaudeRetryEvidence
    try {
      projection = adapter.projectClaudeFrozenSchemaFailure(history, source, original, {
        sessionId: plan.sessionId, userUuid: plan.userUuid, model, prompt, allowedTools: toolNames, init, echo, result,
      })
    } catch (error) { throw claudeAdapterError(adapter, error) }
    const { calls, responses } = projection
    throw claudeSchemaRetryError(calls, responses, { threadId: plan.sessionId, turnId: plan.userUuid }, adapter)
  }
  plan = { ...plan, historyPath }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
  const witness: ClaudeFrozenWitness = { version: 1, provider: 'claude-code', cliVersion: CLI_VERSION, model, sessionId: plan.sessionId, userUuid: plan.userUuid, promptId: original.promptId, prompt, nativeHistoryPath: historyPath, history, mcpHistory: { path: mcpPath, toolNames: readClaudeMcpToolNames(mcpPath, adapter) }, echo, result, initTools: init.tools }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(terminal.output)) throw new StructuredSessionError('failed', 'Claude structured_output does not match the pinned JSON schema')
  persistCompletionJson(join(root, 'witness.json'), witness)
  const proof = proveClaudeFrozenReads(execution.frozenContext!, witness, adapter)
  const answer: NativeResult = { threadId: plan.sessionId, turnId: plan.userUuid, text: JSON.stringify(terminal.output), frozenReadProof: proof }
  persistCompletionJson(join(root, 'completed.json'), { plan, witness, result: answer } satisfies Completed)
  return answer
}

/** 原专属进程组及receipt是冷取消权限；不以缺history或resume新prompt冒充停止。 */
export async function stopClaudeStructuredTurn(execution: StructuredExecution, timeoutMs = 15000): Promise<{ nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs
  const native = execution.claudeNative
  if (!native) return execution.turnStartRequested ? { nativeStopped: false, acknowledged: false, error: 'Claude dispatch identity is unproven' } : { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const path = join(native.root, 'plan.json')
  if (!existsSync(path)) return { nativeStopped: false, acknowledged: false, error: 'Claude exact launch plan is missing' }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as NativePlan
  if (plan.root !== native.root || plan.sessionId !== native.sessionId || plan.userUuid !== native.userUuid || plan.policyDigest !== hash(structuredExecutionPolicy(execution))) return { nativeStopped: false, acknowledged: false, error: 'Claude fixed launch policy or native identity differs' }
  const unstarted = !execution.threadId && !execution.turnId && !plan.pid && !native.pid && !native.receiptFile
  if (unstarted && !execution.turnStartRequested) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const historicalPrelaunchFailure = unstarted && execution.version === 6 && execution.policy === 'native-worktree-v1' && execution.worktree && plan.workspace
    && execution.state === 'cancelling' && execution.cancellation?.nativeStopped === false && execution.error === NATIVE_PROCESS_OBSERVATION_PENDING
    && plan.version === native.version && plan.receiptFile === join(native.root, 'process.json') && existsSync(join(native.root, 'launch.json'))
    && !native.promptId && !plan.resolvedModel && !plan.historyPath && !plan.historyDigest && !active.has(native.root)
    && readdirSync(native.root).every(name => ['plan.json', 'launch.json', 'tmp', 'debug', 'cwd', 'claude-home'].includes(name))
  if (historicalPrelaunchFailure) {
    const launch = JSON.parse(readFileSync(join(native.root, 'launch.json'), 'utf8')) as { command: string; cwd: string; capability?: { cliVersion: string; binaryDigest: string } }
    if (plan.cliPath && plan.cliVersion && /^[a-f0-9]{64}$/.test(plan.binaryDigest) && launch.command === plan.cliPath && launch.cwd === plan.workspace
      && launch.capability?.cliVersion === plan.cliVersion && launch.capability?.binaryDigest === plan.binaryDigest)
      return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  }
  if (!plan.pid || plan.pid !== native.pid || plan.receiptFile !== native.receiptFile) return { nativeStopped: false, acknowledged: false, error: 'Claude launch/process identity differs' }
  if (Date.now() >= deadline) return { nativeStopped: false, acknowledged: false, error: 'Claude native stop deadline expired' }
  const local = active.get(native.root)
  if (local) local.interrupt()
  else if (!detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
    const proof = verifyDetachedRuntime(plan.pid, plan.receiptFile)
    if (!proof.ok) return { nativeStopped: false, acknowledged: false, error: 'Claude exact process-group ownership is unproven' }
    if (Date.now() >= deadline) return { nativeStopped: false, acknowledged: false, error: 'Claude native stop deadline expired' }
    try { process.kill(-plan.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const stoppedProcesses = async (terminate = false): Promise<boolean> => {
    if (Date.now() >= deadline) return false
    try { const stopped = execution.policy === 'native-worktree-v1' ? await nativeWorktreeProcessesStopped(claudeWorktreeProcessPlan(plan), terminate, deadline) : detachedRuntimeIsGone(plan.pid!, plan.receiptFile) && claudeMcpStopped(native.root, terminate); return Date.now() < deadline && stopped }
    catch (error) { if (error instanceof StructuredSessionError && error.code === 'cancellation_pending') return false; throw error }
  }
  if (execution.policy !== 'native-worktree-v1') claudeMcpStopped(native.root, true)
  while (Date.now() < deadline && !(await stoppedProcesses(true))) await new Promise<void>(resolve => setTimeout(resolve, 25))
  let acknowledged = false
  if (existsSync(join(native.root, 'interrupt-ack.json'))) {
    const ack = JSON.parse(readFileSync(join(native.root, 'interrupt-ack.json'), 'utf8')) as { requestId: string; sessionId: string }
    const request = JSON.parse(readFileSync(join(native.root, 'interrupt-request.json'), 'utf8')) as { requestId: string; sessionId: string; userUuid: string }
    if (ack.requestId !== request.requestId || ack.sessionId !== native.sessionId || request.sessionId !== native.sessionId || request.userUuid !== native.userUuid) throw new StructuredSessionError('stale_result', 'Claude interrupt ACK differs from its exact session/user/request')
    acknowledged = true
  }
  return await stoppedProcesses() ? { nativeStopped: true, acknowledged, nativeStatus: 'processGroupGone' }
    : { nativeStopped: false, acknowledged, error: 'Claude native/MCP process group has not been proven stopped' }
}

/** 每次正式派发只有一个原生session和user；未知in-progress只保留恢复债务，绝不自动resume。 */
export function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks): Promise<NativeResult>
// eslint-disable-next-line no-redeclare -- Preserve the legacy frozen proof return type.
export function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks, worktreePath: string | undefined): Promise<NativeResult | WorktreeNativeResult>
// eslint-disable-next-line no-redeclare -- TypeScript implementation of both executor modes.
export async function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks, worktreePath?: string): Promise<NativeResult | WorktreeNativeResult> {
  const worktree = execution.version === 6 && execution.policy === 'native-worktree-v1' && !!execution.worktree && !!worktreePath && !execution.frozenContext && !execution.readerRuntime
  const nativeConfiguration = execution.nativeConfiguration
  if (nativeConfiguration && !worktree) throw new StructuredSessionError('unsupported', 'Claude native CLI configuration requires a native worktree request')
  if (!worktree && (execution.version !== (execution.timeoutMs === null ? 5 : 3) || execution.policy !== 'claude-frozen-read-only-v1' || !execution.frozenContext || execution.readerRuntime)) throw new StructuredSessionError('unsupported', 'Claude requires its exact isolated frozen policy')
  const root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['init.json', 'user-echo.json', 'result.json', 'exit.json'].every(name => existsSync(join(root, name))) ? settleClaudeWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution, undefined, callbacks.signal).then(publish => publish()) : null
    : completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.claudeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'Claude in-progress dispatch cannot be resumed by appending another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'Claude requires the verified outer macOS read-only sandbox')
  const runtime = await loadManagerNativeRuntime()
  const provider = await runtime.loadNativeAdapter('claude') as ClaudeAdapter
  const route = nativeConfiguration ? managedRoute(execution.model) : undefined
  let model: string
  try {
    if (!nativeConfiguration) provider.assertClaudeLegacyConfiguration(process.env)
    model = provider.claudeNativeModel(execution.model, nativeConfiguration, route?.model)
  } catch (error) { throw claudeAdapterError(provider, error) }
  const cliPath = runtime.findNativeExecutable('claude')
  if (!cliPath) throw new StructuredSessionError('unsupported', 'Claude CLI is unavailable in the current process PATH')
  const worktreeLaunch = worktree ? nativeWorktreeLaunch(worktreePath!, cliPath, []) : undefined
  let cliVersion: string
  try { cliVersion = provider.inspectClaudeCliVersion(worktreeLaunch ?? { command: cliPath, args: [] }, nativeConfiguration) }
  catch (error) { throw claudeAdapterError(provider, error) }
  const binaryDigest = createHash('sha256').update(readFileSync(cliPath)).digest('hex')
  mkdirSync(realm, { recursive: true, mode: 0o700 })
  try { mkdirSync(root, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new StructuredSessionError('cancellation_pending', 'Claude original dispatch directory is already reserved')
    throw error
  }
  for (const name of [...(nativeConfiguration ? [] : ['cwd', 'claude-home']), 'tmp', 'debug']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  const native = { version: nativeConfiguration ? 2 as const : 1 as const, root, sessionId: randomUUID(), userUuid: randomUUID() }
  const configHome = join(root, 'claude-home'), cwd = worktree ? worktreePath! : join(root, 'cwd')
  const mcpInput = join(root, 'reader.json'), mcpConfig = join(root, 'mcp.json'), profile = join(root, 'policy.sb')
  if (!worktree) {
    writeFileSync(mcpInput, JSON.stringify({ root, ref: execution.frozenContext }), { mode: 0o400 })
    const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
    const readerArgs = [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, mcpInput]
    writeFileSync(mcpConfig, JSON.stringify(provider.claudeFrozenMcpConfiguration(process.execPath, readerArgs)), { mode: 0o400 })
    writeFileSync(profile, structuredSeatbeltProfile(realpathSync(root)), { mode: 0o400 })
  }
  let invocation: ReturnType<ClaudeAdapter['prepareClaudeStructuredInvocation']>
  try {
    invocation = provider.prepareClaudeStructuredInvocation({
      cwd, environment: process.env, nativeConfiguration, configHome, tmpDir: join(root, 'tmp'), debugDir: join(root, 'debug'),
      stripEnvironment: sessionIdentityEnvVars(), sessionId: native.sessionId, model, schema: execution.schema, effort: execution.effort,
      ...(worktree ? { worktreeMode: execution.worktree!.mode } : { frozen: { mcpConfig, authentication: { command: '/usr/bin/sandbox-exec', args: ['-f', profile, cliPath] } } }),
      ...(route?.kind === 'anthropic-messages' ? { managedApi: true } : {}),
    }, receipt => writeFileSync(join(root, 'auth-status.json'), JSON.stringify(receipt), { mode: 0o600 }))
    if (nativeConfiguration) invocation.environment.SPEXCODE_SESSION_ID = id
  } catch (error) { throw claudeAdapterError(provider, error) }
  const { environment: env, args, configRoot } = invocation
  let plan: NativePlan = { ...native, ...(worktree ? { workspace: cwd } : {}), ...(nativeConfiguration ? { configRoot, requestedModel: execution.model } : {}), requestDigest: hash({ prompt, policy: structuredExecutionPolicy(execution) }), policyDigest: hash(structuredExecutionPolicy(execution)), cliPath, cliVersion, binaryDigest, receiptFile: join(root, 'process.json') }
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
  await callbacks.onNative(native)
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ command: cliPath, args, environmentNames: Object.keys(env), cwd, capability: { cliVersion, binaryDigest, ...(nativeConfiguration ? { configurationSource: 'native' } : { maxReadBytes: 65536, maxResultSizeChars: 500000, maxMcpOutputTokens: 500000 }) } }), { mode: 0o400 })
  if (worktree) await sampleNativeWorktreeProcesses(plan)
  if (callbacks.signal?.aborted) throw new StructuredSessionError('cancelled', 'Claude native launch cancelled before spawn')
  await callbacks.onTurnStarting?.()
  const managedLaunch = route?.kind === 'anthropic-messages'
    ? managedClaudeCommand(route, id, cliPath, worktreeLaunch?.command === '/usr/bin/sandbox-exec' ? worktreeLaunch.args[1] : undefined)
    : undefined
  const launch = managedLaunch ?? worktreeLaunch ?? { command: '/usr/bin/sandbox-exec', args: ['-f', profile, cliPath] }
  const child = runtime.spawnNativeProcess(launch.command, [...launch.args, ...args], { cwd, env })
  if (!child.pid) throw new StructuredSessionError('failed', 'Claude isolated process could not start')
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  child.once('error', () => {})
  try {
    writeDetachedRuntimeReceipt(child.pid, plan.receiptFile)
    plan = { ...plan, pid: child.pid }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
    if (worktree) await sampleNativeWorktreeProcesses(plan)
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile: plan.receiptFile })
  } catch (error) {
    // This is the child just returned by spawn, before any user prompt was sent. A failed receipt
    // publication still leaves recovery debt; neither leader exit nor our signal releases capacity.
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1000))])
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', `Claude spawned process ownership could not be durably published (${(error as NodeJS.ErrnoException).code ?? 'unknown'}); exact process-group stop remains required`)
  }
  let init: ClaudeInit | undefined, echo: ClaudeFrozenWitness['echo'] | undefined, result: ClaudeFrozenWitness['result'] | undefined
  let failure: Error | undefined, aborted = false, timedOut = false
  let observationFailure: Error | undefined
  const pendingObservationFailure = (): StructuredSessionError | undefined => observationFailure
    && Object.assign(new StructuredSessionError('cancellation_pending', observationFailure.message), { cause: observationFailure })
  let rejectStop: (error: Error) => void = () => {}
  const stopDeadline = new Promise<never>((_resolve, reject) => { rejectStop = error => reject(pendingObservationFailure() ?? error) })
  const killOwnGroup = (): void => {
    if (stopAt !== undefined && Date.now() >= stopAt) { rejectStop(new StructuredSessionError('cancellation_pending', 'Claude native stop deadline expired')); return }
    if (!verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok) return
    try {
      const request = result && !aborted && !failure ? { version: 1 as const, reason: 'terminal_settlement' as const, sessionId: native.sessionId, userUuid: native.userUuid, pid: plan.pid!, receiptDigest: hash(JSON.parse(readFileSync(plan.receiptFile, 'utf8'))), requestDigest: plan.requestDigest, resultDigest: hash(result), signal: 'SIGTERM' as const, requestedAt: Date.now() } satisfies TerminalStopRequest : undefined
      if (request) persistCompletionJson(join(root, 'terminal-stop-request.json'), request)
      if (stopAt !== undefined && Date.now() >= stopAt) { rejectStop(new StructuredSessionError('cancellation_pending', 'Claude native stop deadline expired')); return }
      let outcome: TerminalStopObservation['outcome'] = 'sent'
      try { process.kill(-plan.pid!, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; outcome = 'gone' }
      if (request) persistCompletionJson(join(root, 'terminal-stop.json'), { version: 1, requestObservationDigest: hash(request), outcome, observedAt: Date.now() } satisfies TerminalStopObservation)
    } catch (error) { rejectStop(new StructuredSessionError('cancellation_pending', `Claude exact process-group termination or its observation remains unproven (${(error as NodeJS.ErrnoException).code ?? 'observation_failed'})`)) }
  }

  let stopAt: number | undefined, processCensus: ReturnType<typeof setInterval> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let stopLimit: ReturnType<typeof setTimeout> | undefined
  const armStop = (): void => {
    stopAt ??= Date.now() + 15000
    clearInterval(processCensus)
    stopTimer ??= setTimeout(killOwnGroup, 10000)
    stopLimit ??= setTimeout(() => rejectStop(new StructuredSessionError('cancellation_pending', 'Claude terminal/cancellation exceeded the exact native stop budget')), 15000)
  }
  const stream = provider.connectClaudeStructuredStream({ stdin: child.stdin, stdout: child.stdout }, {
    sessionId: native.sessionId, userUuid: native.userUuid, model, nativeConfiguration, worktree, managedRoute: !!route,
  }, {
    shouldConsume: () => !failure,
    onObservation(observation) {
      appendFileSync(join(root, 'native-protocol.jsonl'), JSON.stringify(observation) + '\n', { mode: 0o600 })
    },
    async onEvent(event) {
      if (event.kind === 'init') {
        init = event.init
        writeFileSync(join(root, 'init.json'), JSON.stringify(init), { mode: 0o400 })
        if (nativeConfiguration) { plan = { ...plan, resolvedModel: init.model }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 }) }
        await callbacks.onThread(native.sessionId)
      } else if (event.kind === 'user-echo') {
        echo = event.echo
        writeFileSync(join(root, 'user-echo.json'), JSON.stringify(echo), { mode: 0o400 })
        await callbacks.onTurn(native.userUuid)
      } else if (event.kind === 'interrupt-ack') {
        writeFileSync(join(root, 'interrupt-ack.json'), JSON.stringify({ requestId: event.requestId, sessionId: native.sessionId }), { mode: 0o400 })
      } else {
        result = event.result
        writeFileSync(join(root, 'result.json'), JSON.stringify(event.receipt), { mode: 0o400 })
        armStop()
      }
    },
    onError(error, ordinal) {
      failure ??= claudeAdapterError(provider, error) as Error
      stopAt ??= Date.now() + 15000
      clearInterval(processCensus)
      killOwnGroup()
      stopLimit ??= setTimeout(() => rejectStop(new StructuredSessionError('cancellation_pending', 'Claude failed protocol observation has no bounded native stop evidence')), 15000)
      appendFileSync(join(root, 'native-protocol.jsonl'), JSON.stringify({ version: 1, ordinal, kind: 'error', code: failure instanceof StructuredSessionError ? failure.code : 'observer_failed' }) + '\n', { mode: 0o600 })
    },
  })
  const interrupt = (): void => {
    const requested = aborted
    aborted = true
    armStop()
    if (requested) return
    const requestId = randomUUID()
    writeFileSync(join(root, 'interrupt-request.json'), JSON.stringify({ requestId, sessionId: native.sessionId, userUuid: native.userUuid }), { mode: 0o600 })
    stream.interrupt(requestId)
  }
  active.set(root, { child, interrupt })
  const abort = (): void => interrupt()
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => { timedOut = true; interrupt(); void callbacks.onTimeout?.() })
  let sampling: Promise<void> | undefined
  let observationRecovery: { startedAt: number; firstError: StructuredSessionError } | undefined
  const reportObservation = (status: 'pending' | 'recovered' | 'expired', startedAt: number): void => {
    console.warn('spex claude periodic observation', JSON.stringify({ status, elapsedMs: Date.now() - startedAt }))
  }
  const stopAfterObservationFailure = (error: unknown): void => {
    failure ??= Object.assign(new StructuredSessionError('failed', error instanceof Error ? error.message : String(error)), { cause: error })
    observationFailure = failure
    armStop()
  }
  processCensus = worktree ? setInterval(() => {
    if (sampling || stopAt !== undefined) return
    const recovery = observationRecovery
    const deadline = recovery && recovery.startedAt + NATIVE_PROCESS_OBSERVATION_LIMIT_MS
    if (recovery && Date.now() - recovery.startedAt >= NATIVE_PROCESS_OBSERVATION_LIMIT_MS) {
      reportObservation('expired', recovery.startedAt)
      stopAfterObservationFailure(recovery.firstError)
      return
    }
    sampling = sampleNativeWorktreeProcesses(plan, deadline).then(() => {
      if (recovery && stopAt === undefined) {
        reportObservation('recovered', recovery.startedAt)
        observationRecovery = undefined
      }
    }, error => {
      if (stopAt !== undefined) return
      if (error instanceof StructuredSessionError && error.code === 'cancellation_pending') {
        if (!recovery) {
          observationRecovery = { startedAt: Date.now(), firstError: error }
          reportObservation('pending', observationRecovery.startedAt)
        }
      } else stopAfterObservationFailure(recovery?.firstError ?? error)
    }).finally(() => { sampling = undefined })
  }, 100) : undefined
  const stoppedProcesses = async (final = false): Promise<boolean> => {
    let stopped: boolean
    try { stopped = worktree ? await nativeWorktreeProcessesStopped(plan, false, stopAt) : detachedRuntimeIsGone(plan.pid!, plan.receiptFile) && claudeMcpStopped(root) }
    catch (error) { throw pendingObservationFailure() ?? error }
    if (final && !stopped) {
      const pending = pendingObservationFailure()
      if (pending) throw pending
    }
    return stopped
  }
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrHash.update(bytes); stderrBytes += bytes.length })
  child.once('error', error => { failure ??= error })
  let answer: NativeResult | (() => WorktreeNativeResult)
  let finallyStopped = false
  try {
    stream.start(prompt)
    if (callbacks.signal?.aborted) interrupt()
    const exit = await Promise.race([exited, stopDeadline])
    await stream.drain()
    stopAt ??= Date.now() + 15000
    clearInterval(processCensus); await sampling
    for (let retry = 0; retry < 100 && !(await stoppedProcesses()); retry++) await new Promise<void>(resolve => setTimeout(resolve, 25))
    const stopped = await stoppedProcesses()
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ ...exit, stopped, stderrBytes, stderrSha256: stderrHash.digest('hex') }), { mode: 0o400 })
    if (!stopped) throw pendingObservationFailure() ?? new StructuredSessionError('cancellation_pending', 'Claude or MCP descendant process group remains unproven')
    if (observationFailure) throw observationFailure
    if (aborted) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Claude exact process group stopped after cancellation')
    if (failure) throw failure
    if (!init || !echo || !result) throw new StructuredSessionError('failed', `Claude execution is missing native events: ${[!init ? 'init' : '', !echo ? 'user-echo' : '', !result ? 'result' : ''].filter(Boolean).join(', ')}`)
    if (worktree && route) {
      const publicResult = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as WorktreeTerminalResult
      if (provider.isClaudeRateLimitTerminal(publicResult, exit)) {
        authenticateClaudeWorktreeResult(plan, prompt, { ...execution, claudeNative: { ...native, pid: plan.pid, receiptFile: plan.receiptFile } }, false, provider)
        throw new StructuredSessionError('provider_quota_exhausted', 'Claude provider returned HTTP 429 for the original native turn',
          { threadId: plan.sessionId, turnId: plan.userUuid, nativeTokenUsage: publicResult.nativeTokenUsage })
      }
    }
    const terminal = provider.claudeWorktreeTerminal(result)
    if (!provider.claudeNaturalSuccessExit(exit) && terminal.subtype !== 'schema_exhausted'
      && !(worktree && controlledClaudeWorktreeTerminalExit(plan, execution, result, { ...exit, stopped }, callbacks.signal, provider)))
      throw new StructuredSessionError('failed', provider.claudeUnsuccessfulExitMessage(exit, terminal.reportedError))
    const history = worktree ? claudeWorktreeHistory(plan, false, provider) : readClaudePublicHistory(nativeHistoryPath(configHome, native.sessionId, provider), native.sessionId, provider), original = history.find(row => row.type === 'user' && row.uuid === native.userUuid)
    if (!original?.promptId) throw new StructuredSessionError('stale_result', 'Claude original native promptId is missing')
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile: plan.receiptFile, promptId: original.promptId })
    answer = await (worktree ? settleClaudeWorktreeResult(plan, prompt, { ...execution, claudeNative: { ...native, pid: plan.pid, receiptFile: plan.receiptFile } }, stopAt, callbacks.signal, provider) : settleClaudeResult(plan, prompt, execution, provider))
  } finally {
    stopAt ??= Date.now() + 15000
    clearInterval(processCensus); await sampling
    stream.close()
    try { finallyStopped = await stoppedProcesses(true) }
    finally {
      clearTimeout(timer); if (stopTimer) clearTimeout(stopTimer); if (stopLimit) clearTimeout(stopLimit)
      callbacks.signal?.removeEventListener('abort', abort); active.delete(root)
      if (!finallyStopped) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref() }
    }
  }
  if (!finallyStopped) throw new StructuredSessionError('cancellation_pending', 'Claude native stop remains unproven')
  if (worktree && aborted && !failure) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Claude exact process group stopped after cancellation')
  if (failure) throw failure
  return typeof answer === 'function' ? answer() : answer
}
