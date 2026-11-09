import { nativeWorktreeProcessesStopped, sampleNativeWorktreeProcesses } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { checkClaudeHistoryChain, claudeRecoveryCompanion, claudeApiRequestHashes, claudeApiSourceDigest, claudeApiToolResultIds, claudeMessageBlocks, claudeMessageDigest, claudeOutputLimitCompanions, matchingClaudeRecoveries, recordClaudeRecoveryRequest, consumeClaudeRecoveryRequest, proveClaudeFrozenReads, readClaudeApiMessageBlobs, readClaudeApiSourceMetadata, readClaudeMcpToolNames, readClaudePublicHistory, verifyFrozenReadProof, type ClaudeRecovery, type ClaudeFrozenWitness, type ClaudePublicMessage, type ClaudePublicRecord, type FrozenReadProof } from './frozen-context.js'
import { rejectedFinalOutput, structuredExecutionTimer, StructuredSessionError, structuredExecutionPolicy, structuredSeatbeltProfile, type StructuredExecution } from './session-structured-policy.js'
import { sessionIdentityEnvVars } from './harness-shim.js'

const CLI_VERSION = '2.1.309 (Claude Code)'
const toolNames = ['StructuredOutput', 'mcp__frozen__spex_read_frozen']
const systemPrompt = 'Read only immutable context through the configured spex_read_frozen MCP. Follow the frozen task and return the requested schema using StructuredOutput. No shell, files, network, tools discovery, skills or subagents. Never call DeferredToolPlaceholder.'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type NativePlan = { version: 1 | 2; root: string; sessionId: string; userUuid: string; requestDigest: string; policyDigest: string; historyPath?: string; cliPath: string; cliVersion: string; binaryDigest: string; pid?: number; receiptFile: string; workspace?: string; configRoot?: string; requestedModel?: string; resolvedModel?: string; historyDigest?: string }
type WorktreeNativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type ClaudeInit = { tools: string[]; session_id: string; model: string }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: FrozenReadProof }
type Completed = { plan: NativePlan; witness: ClaudeFrozenWitness; result: NativeResult }
type TerminalStopRequest = { version: 1; reason: 'terminal_settlement'; sessionId: string; userUuid: string; pid: number; receiptDigest: string; requestDigest: string; resultDigest: string; signal: 'SIGTERM'; requestedAt: number }
type TerminalStopObservation = { version: 1; requestObservationDigest: string; outcome: 'sent' | 'gone'; observedAt: number }
type NativeCallbacks = { onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onNative(state: NonNullable<StructuredExecution['claudeNative']>): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
const active = new Map<string, { child: ChildProcessWithoutNullStreams; interrupt: () => void }>()
const authenticationKeys = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'] as const

/** 只在没有显式认证整组时，内存投影原生用户配置的四个认证/路由键；不继承其它设置。 */
export function prepareClaudeAuthenticationEnvironment(environment: NodeJS.ProcessEnv, settingsPath = join(homedir(), '.claude', 'settings.json')): { environment: NodeJS.ProcessEnv; source: 'process' | 'native-user-settings' | 'cli' } {
  if (authenticationKeys.some(key => Object.hasOwn(environment, key))) return { environment: Object.fromEntries(authenticationKeys.filter(key => Object.hasOwn(environment, key)).map(key => [key, environment[key]])), source: 'process' }
  if (!existsSync(settingsPath)) return { environment: {}, source: 'cli' }
  let settings: { env?: Record<string, unknown> }
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings }
  catch { throw new StructuredSessionError('unsupported', 'Claude native user authentication settings could not be parsed safely') }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.env !== undefined && (settings.env === null || typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new StructuredSessionError('unsupported', 'Claude native user authentication settings have an invalid shape')
  const selected: NodeJS.ProcessEnv = {}
  for (const key of authenticationKeys) {
    if (!settings.env || !Object.hasOwn(settings.env, key)) continue
    if (typeof settings.env[key] !== 'string') throw new StructuredSessionError('unsupported', 'Claude native user authentication setting must be a string')
    selected[key] = settings.env[key]
  }
  return { environment: selected, source: Object.keys(selected).length ? 'native-user-settings' : 'cli' }
}

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

/** CLI会缩短过长cwd目录名；只在固定配置根的projects一层目录查找精确UUID。 */
function nativeHistoryPath(root: string, sessionId: string, configRoot = join(root, 'claude-home')): string {
  const projects = join(configRoot, 'projects')
  if (!existsSync(projects)) throw new StructuredSessionError('stale_result', 'Claude native config root has no session projects')
  const paths = readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(projects, entry.name, `${sessionId}.jsonl`)).filter(path => existsSync(path))
  if (paths.length !== 1 || !realpathSync(paths[0]).startsWith(`${realpathSync(projects)}/`)) throw new StructuredSessionError('stale_result', 'Claude config root has no unique exact native session history')
  return paths[0]
}

/** 新配置语义将不透明选择交给CLI；旧冻结请求保持原exact ID约束。 */
export function claudeNativeModel(model: string | undefined, nativeConfiguration?: 'cli-config-v1'): string {
  const value = model?.startsWith('claude:') ? model.slice(7) : ''
  if (nativeConfiguration === 'cli-config-v1') {
    if (!value.trim() || value.includes('\0')) throw new StructuredSessionError('unsupported', 'Claude execution requires a nonempty claude:<native-model-selection>')
    return value
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || ['sonnet', 'opus', 'haiku', 'fable', 'default'].includes(value.toLowerCase())) throw new StructuredSessionError('unsupported', 'Claude execution requires claude:<exact-native-model-id>')
  return value
}

/** 官方restricted模式兼容现有认证；配置与可调用工具只来自本轮可信控制面。 */
export function claudeStructuredArgs(input: { sessionId: string; model: string; mcpConfig: string; schema: Record<string, unknown>; effort?: string }): string[] {
  if (input.effort && !['low', 'medium', 'high', 'xhigh'].includes(input.effort)) throw new StructuredSessionError('unsupported', 'Claude effort must be an explicitly supported native value')
  return ['-p', '--session-id', input.sessionId, '--model', input.model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['**'], enabledPlugins: {} }),
    '--strict-mcp-config', '--mcp-config', input.mcpConfig, '--tools', '', '--allowedTools', ...toolNames, '--disallowedTools', 'EndConversation', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--disable-slash-commands', '--no-chrome', '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(input.schema), ...(input.effort ? ['--effort', input.effort] : [])]
}

/** 正常工作区能力仅约束结果格式，内置读取、编辑和 shell 工具保持可用。 */
export function claudeWorktreeArgs(input: { sessionId: string; model: string; schema: Record<string, unknown>; effort?: string; mode?: 'read' | 'edit'; nativeConfiguration?: 'cli-config-v1' }): string[] {
  if (input.effort && !['low', 'medium', 'high', 'xhigh'].includes(input.effort)) throw new StructuredSessionError('unsupported', 'Claude effort must be an explicitly supported native value')
  return ['-p', '--session-id', input.sessionId, ...(input.nativeConfiguration && input.model === 'default' ? [] : ['--model', input.model]), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    ...(input.nativeConfiguration ? [] : ['--setting-sources', '', '--settings', JSON.stringify({ autoMemoryEnabled: false, enabledPlugins: {} }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']),
    '--permission-mode', input.mode === 'read' ? 'plan' : 'bypassPermissions', '--json-schema', JSON.stringify(input.schema), ...(input.effort ? ['--effort', input.effort] : [])]
}

type ClaudeToolReply = Exclude<ClaudePublicMessage['content'], string>[number]

/** 两种执行模式共用原生 schema 错误字段提取，不修补模型业务结果。 */
function claudeSchemaRetryError(calls: ReadonlyMap<string, ClaudePublicRecord>, responses: ReadonlyMap<string, ClaudeToolReply>, identity: { threadId: string; turnId: string; rejectedOutput?: StructuredExecution['rejectedOutput'] }): StructuredSessionError {
  const schemaErrors = [...responses].flatMap(([callId, reply]) => {
    const call = calls.get(callId)?.message?.content
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId) || !Array.isArray(call) || !call.some(block => block.id === callId && block.name === 'StructuredOutput') || reply.is_error !== true || typeof reply.content !== 'string' || !reply.content.startsWith('Output does not match required schema: ')) return []
    const fields = [...reply.content.slice('Output does not match required schema: '.length).matchAll(/(?:^|, )(\/[A-Za-z0-9_/-]{0,160}): (must be (?:array|object|string|number|integer|boolean|null)|must NOT have more than \d{1,8} items|must have required property '[A-Za-z0-9_-]{1,80}')(?=, | \(got \d+\)|$)/g)].slice(0, 12).map(match => ({ path: match[1], error: match[2] }))
    return fields.length ? [{ callId, fields }] : []
  }).slice(-5)
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
function claudeWorktreeHistory(plan: NativePlan, completed: boolean): ClaudePublicRecord[] {
  if (plan.version !== 2) return readClaudePublicHistory(nativeHistoryPath(plan.root, plan.sessionId), plan.sessionId)
  const path = join(plan.root, 'public-history.json')
  if (!existsSync(path)) {
    if (completed || !plan.configRoot) throw new StructuredSessionError('stale_result', 'Claude native completion has no pinned public history')
    const historyPath = nativeHistoryPath(plan.root, plan.sessionId, plan.configRoot)
    const history = readClaudePublicHistory(historyPath, plan.sessionId)
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
function worktreeSchemaRetryError(history: readonly ClaudePublicRecord[], original: ClaudePublicRecord, execution: StructuredExecution, prompt: string, exactModel?: string): StructuredSessionError {
  const calls = new Map<string, ClaudePublicRecord>(), responses = new Map<string, ClaudeToolReply>(), requests = new Set<string>()
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  let latestMessage: string | undefined, latestAssistant: string | undefined, schemaErrors = 0, enforcementSeen = false, rejected: unknown
  for (const row of checkClaudeHistoryChain(history, original)) {
    if (row.type === 'api-request') {
      if (!row.id || exactModel !== undefined && row.model !== exactModel) throw new StructuredSessionError('stale_result', 'Claude worktree schema failure model request differs')
      requests.add(row.id)
    }
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content) {
        if (!block.id || calls.has(block.id) || !row.requestRef || !requests.has(row.requestRef)) throw new StructuredSessionError('stale_result', 'Claude worktree schema failure has no exact native tool call')
        calls.set(block.id, row)
      }
      latestAssistant = row.uuid
    }
    if (row.type === 'user' && row.uuid !== original.uuid && !row.compactSummary) {
      const recovery = claudeRecoveryCompanion(row, original.promptId, latestMessage, latestAssistant)
      if (recovery && row.turnCompanion === undefined) {
        if (enforcementSeen) throw new StructuredSessionError('stale_result', 'Claude worktree schema enforcement was repeated')
        enforcementSeen = true
      }
      if (!recovery) {
        if (row.promptId !== original.promptId || !row.sourceToolAssistantUUID || row.sourceToolAssistantUUID !== row.parentUuid || !Array.isArray(row.message?.content) || !row.message.content.length) throw new StructuredSessionError('stale_result', 'Claude worktree schema failure contains another user input')
        for (const reply of row.message.content) {
          const call = calls.get(reply.tool_use_id ?? '')
          if (reply.type !== 'tool_result' || !call || call.uuid !== row.sourceToolAssistantUUID || responses.has(reply.tool_use_id!)) throw new StructuredSessionError('stale_result', 'Claude worktree schema error reply lost its exact native call')
          responses.set(reply.tool_use_id!, reply)
          const block = Array.isArray(call.message?.content) ? call.message.content.find(block => block.id === reply.tool_use_id) : undefined
          if (block?.name === 'StructuredOutput' && reply.is_error === true && typeof reply.content === 'string' && reply.content.startsWith('Output does not match required schema: ')) {
            if (validate(block.input)) throw new StructuredSessionError('stale_result', 'Claude worktree schema error contradicts its pinned schema')
            rejected = block.input
            schemaErrors++
          }
        }
      }
    }
    if (row.type === 'user' || row.type === 'assistant' || row.type === 'system' && row.subtype === 'api_error') latestMessage = row.uuid
  }
  if (!requests.size || !schemaErrors) throw new StructuredSessionError('stale_result', 'Claude worktree exhaustion has no original native schema errors')
  const identity = { threadId: original.sessionId, turnId: original.uuid! }
  return claudeSchemaRetryError(calls, responses, { ...identity, ...(rejected !== undefined ? { rejectedOutput: rejectedFinalOutput(JSON.stringify(rejected), prompt, execution, identity, 'native_json') } : {}) })
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
function controlledClaudeWorktreeSuccess(plan: NativePlan, execution: StructuredExecution, result: ClaudeFrozenWitness['result'], exit: { code: number | null; signal: string | null; stopped: boolean }, signal?: AbortSignal): boolean {
  if (!(exit.code === 143 && exit.signal === null || exit.code === null && exit.signal === 'SIGTERM') || exit.stopped !== true
    || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || result.structured_output === undefined
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
function authenticateClaudeWorktreeResult(plan: NativePlan, prompt: string, execution: StructuredExecution, sealed = false) {
  assertClaudeWorktreePlan(plan, prompt, execution)
  const root = plan.root
  if (sealed && (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile))) throw new StructuredSessionError('cancellation_pending', 'Claude worktree native or unknown orphan stop remains unproven')
  const init = JSON.parse(readFileSync(join(root, 'init.json'), 'utf8')) as { session_id: string; model: string; tools: string[] }
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
  const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number | null; signal: string | null; stopped: boolean }
  const selection = claudeWorktreeModel(plan, execution, init)
  const history = claudeWorktreeHistory(plan, sealed || execution.state === 'completed'), original = history.find(row => row.type === 'user' && row.uuid === plan.userUuid)
  if (init.session_id !== plan.sessionId || !original?.promptId || original.sessionId !== plan.sessionId || plan.version === 2 && history.some(row => row.sessionId !== plan.sessionId || row.type === 'api-request' && (typeof row.id !== 'string' || !row.id || typeof row.model !== 'string' || !row.model.trim()))
    || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || hash(echo.message) !== hash({ role: 'user', content: [{ type: 'text', text: prompt }] }) || hash(original.message) !== hash(echo.message)
    || original.parentUuid !== null || result.session_id !== plan.sessionId || result.user_message_uuid !== plan.userUuid || hash(result.user_message_uuids) !== hash([plan.userUuid]) || !exit.stopped) throw new StructuredSessionError('stale_result', 'Claude worktree original prompt/model/exit evidence differs')
  return { root, init, echo, result, exit, selection, history, original }
}

/** 工作区模式只核原生输入、模型和终态身份，不借用冻结读取证明。 */
async function settleClaudeWorktreeResult(plan: NativePlan, prompt: string, execution: StructuredExecution, deadline?: number, signal?: AbortSignal): Promise<() => WorktreeNativeResult> {
  assertClaudeWorktreePlan(plan, prompt, execution)
  if (execution.state !== 'completed' && !(await nativeWorktreeProcessesStopped(claudeWorktreeProcessPlan(plan), false, deadline))) throw new StructuredSessionError('cancellation_pending', 'Claude worktree native or unknown orphan stop remains unproven')
  const { root, init, echo, result, exit, selection, history, original } = authenticateClaudeWorktreeResult(plan, prompt, execution)
  if (result.subtype === 'error_max_structured_output_retries') {
    const terminalOutcome = terminalStopOutcome(plan, result)
    const naturalExit = exit.code === 1 && exit.signal === null && terminalOutcome !== 'sent'
    const controlledExit = exit.code === null && exit.signal === 'SIGTERM' && terminalOutcome === 'sent'
    if (execution.state === 'completed' || existsSync(join(root, 'completed.json')) || !naturalExit && !controlledExit || result.type !== 'result' || result.is_error !== true) throw new StructuredSessionError('stale_result', 'Claude worktree schema exhaustion terminal differs')
    throw worktreeSchemaRetryError(history, original, execution, prompt, plan.version === 2 ? undefined : selection)
  }
  const controlled = controlledClaudeWorktreeSuccess(plan, execution, result, exit, signal)
  if (!controlled && execution.state !== 'completed' && terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('failed', 'Claude terminal success required process-group termination and is not a completed result')
  if (!controlled && (exit.code !== 0 || exit.signal !== null) || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false) throw new StructuredSessionError('stale_result', 'Claude worktree success evidence differs')
  if (result.structured_output === undefined) throw new StructuredSessionError(execution.state === 'completed' || existsSync(join(root, 'completed.json')) ? 'stale_result' : 'structured_output_format_invalid', 'Claude worktree success is missing required structured_output', { threadId: plan.sessionId, turnId: plan.userUuid })
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(result.structured_output)) throw new StructuredSessionError('failed', 'Claude worktree structured output does not match its schema', execution.state === 'completed' ? {} : { threadId: plan.sessionId, turnId: plan.userUuid, rejectedOutput: rejectedFinalOutput(JSON.stringify(result.structured_output), prompt, execution, { threadId: plan.sessionId, turnId: plan.userUuid }, 'native_json') })
  const answer: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.userUuid, text: JSON.stringify(result.structured_output) }
  const completion = { plan, init, echo, result, exit, promptId: original.promptId, answer }
  const path = join(root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== answer.threadId || execution.turnId !== answer.turnId || execution.resultDigest !== hash(result.structured_output))) throw new StructuredSessionError('stale_result', 'Claude worktree durable completed identity differs')
  return () => {
    if (deadline !== undefined && Date.now() >= deadline) throw new StructuredSessionError('cancellation_pending', 'Claude completion exceeded the original stop deadline')
    if (controlled && signal?.aborted) throw new StructuredSessionError('cancelled', 'Claude exact process group stopped after cancellation')
    persistCompletionJson(path, completion)
    return answer
  }
}

/** 正式暂停后的新材料仍须核原计划、已回显输入和同一owned工作树；不签发final。 */
export function assertClaudeStoppedDraftSource(prompt: string, execution: StructuredExecution, worktreePath: string): void {
  const native = execution.claudeNative
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('claude:') || execution.worktree?.mode !== 'edit' || !native || execution.state !== 'cancelled' || !execution.cancellation?.nativeStopped || execution.threadId !== native.sessionId || execution.turnId !== native.userUuid || existsSync(join(native.root, 'completed.json'))) throw new StructuredSessionError('stale_result', 'stopped draft observation requires its original cancelled native worktree')
  const plan = JSON.parse(readFileSync(join(native.root, 'plan.json'), 'utf8')) as NativePlan
  assertClaudeWorktreePlan(plan, prompt, execution)
  if (plan.root !== native.root || realpathSync(claudeWorktreeProcessPlan(plan).workspace!) !== realpathSync(worktreePath) || !plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) throw new StructuredSessionError('stale_result', 'stopped draft observation differs from its recorded native worktree/process')
  const init = JSON.parse(readFileSync(join(plan.root, 'init.json'), 'utf8')) as ClaudeInit, echo = JSON.parse(readFileSync(join(plan.root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  claudeWorktreeModel(plan, execution, init)
  if (init.session_id !== plan.sessionId || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || hash(echo.message) !== hash({ role: 'user', content: [{ type: 'text', text: prompt }] })) throw new StructuredSessionError('stale_result', 'stopped draft observation lost its original native input')
}

/** 新attempt只观察已停止的原缺final失败；不派发、不补签或改写旧Native证据。 */
export function observeClaudeWorktreeMissingFinal(prompt: string, execution: StructuredExecution, worktreePath: string): StructuredSessionError {
  const native = execution.claudeNative
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.model?.startsWith('claude:') || execution.worktree?.mode !== 'edit' || !native || !['failed', 'cancelled'].includes(execution.state ?? '') || execution.threadId !== native.sessionId || execution.turnId !== native.userUuid || existsSync(join(native.root, 'completed.json'))) throw new StructuredSessionError('stale_result', 'missing final observation requires the exact original failed native worktree')
  const plan = JSON.parse(readFileSync(join(native.root, 'plan.json'), 'utf8')) as NativePlan
  if (plan.root !== native.root || realpathSync(claudeWorktreeProcessPlan(plan).workspace!) !== realpathSync(worktreePath)) throw new StructuredSessionError('stale_result', 'missing final observation differs from its recorded native worktree')
  const { result, exit } = authenticateClaudeWorktreeResult(plan, prompt, execution, true)
  if (exit.code !== 0 || exit.signal !== null || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || result.structured_output !== undefined || terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('stale_result', 'original native evidence is not a naturally stopped success missing structured_output')
  return new StructuredSessionError('structured_output_format_invalid', 'Claude worktree success is missing required structured_output', { threadId: plan.sessionId, turnId: plan.userUuid })
}

/** 已停错误结果只授予未批准Git材料，不冒充缺final格式失败或成功。 */
export function observeClaudeStoppedWorktreeFailure(prompt: string, execution: StructuredExecution, worktreePath: string): StructuredSessionError | undefined {
  assertClaudeStoppedDraftSource(prompt, execution, worktreePath)
  const native = execution.claudeNative!
  const result = JSON.parse(readFileSync(join(native.root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
  const exit = JSON.parse(readFileSync(join(native.root, 'exit.json'), 'utf8')) as { code: number | null; signal: string | null; stopped: boolean }
  if (exit.code === 1 && exit.signal === null && exit.stopped && result.type === 'result' && result.subtype === 'success' && result.is_error === true && result.structured_output === undefined
    && result.session_id === native.sessionId && result.user_message_uuid === native.userUuid && hash(result.user_message_uuids) === hash([native.userUuid])) return undefined
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
    if (result.subtype !== 'error_max_structured_output_retries' && (result.subtype !== 'success' || result.is_error || result.structured_output === undefined)) return null
    return settleClaudeResult(plan, prompt, execution)
  }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Completed
  if (hash(saved.plan) !== hash(plan)) throw new StructuredSessionError('stale_result', 'Claude completed launch plan differs')
  if (hash(saved.witness) !== saved.result.frozenReadProof.historyDigest || saved.witness.sessionId !== plan.sessionId || saved.witness.userUuid !== plan.userUuid || saved.witness.prompt !== prompt
    || saved.witness.cliVersion !== plan.cliVersion || saved.witness.model !== claudeNativeModel(execution.model) || saved.result.threadId !== plan.sessionId || saved.result.turnId !== plan.userUuid) throw new StructuredSessionError('stale_result', 'Claude cached completion witness or plan/native identities differ from authoritative evidence')
  verifyFrozenReadProof(execution.frozenContext!, saved.result.frozenReadProof, { threadId: saved.result.threadId, turnId: saved.result.turnId }, undefined, { output: JSON.parse(saved.result.text) as unknown })
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(saved.witness.result.structured_output) || saved.result.text !== JSON.stringify(saved.witness.result.structured_output)
    || saved.result.frozenReadProof.version !== 3 || saved.result.frozenReadProof.model !== claudeNativeModel(execution.model)) throw new StructuredSessionError('stale_result', 'Claude completed schema or provider witness differs')
  if (execution.state === 'completed') {
    if (execution.threadId !== plan.sessionId || execution.turnId !== plan.userUuid || execution.claudeNative?.pid !== plan.pid || execution.claudeNative.receiptFile !== plan.receiptFile
      || !execution.resultDigest || execution.resultDigest !== hash(execution.output) || execution.resultDigest !== hash(saved.witness.result.structured_output)
      || !execution.frozenReadProof || hash(execution.frozenReadProof) !== hash(saved.result.frozenReadProof)) throw new StructuredSessionError('stale_result', 'Claude durable completed state has missing or mismatched result/identity/evidence')
    return saved.result
  }
  if (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile) || !claudeMcpStopped(root)) return null
  return saved.result
}

/** 原生完整result和停止证据可在崩溃后补成相同proof；任何缺失都不能通过新prompt补齐。 */
function settleClaudeResult(plan: NativePlan, prompt: string, execution: StructuredExecution): NativeResult {
  const { root } = plan, model = claudeNativeModel(execution.model)
  const init = JSON.parse(readFileSync(join(root, 'init.json'), 'utf8')) as { session_id: string; model: string; tools: string[] }
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
  if (!plan.pid || !detachedRuntimeIsGone(plan.pid, plan.receiptFile) || !claudeMcpStopped(root) || plan.cliVersion !== CLI_VERSION || init.model !== model || init.session_id !== plan.sessionId) throw new StructuredSessionError('stale_result', 'Claude complete native result lost its version, model or process-stop identity')
  if (result.subtype === 'success' && terminalStopOutcome(plan, result) === 'sent') throw new StructuredSessionError('failed', 'Claude terminal success required process-group termination and is not a completed result')
  const historyPath = nativeHistoryPath(root, plan.sessionId)
  if (plan.historyPath && plan.historyPath !== historyPath) throw new StructuredSessionError('stale_result', 'Claude pinned native history path differs')
  const history = readClaudePublicHistory(historyPath, plan.sessionId), original = history.find(row => row.type === 'user' && row.uuid === plan.userUuid)
  if (!original?.promptId) throw new StructuredSessionError('stale_result', 'Claude original native promptId is missing')
  const mcpPath = join(root, 'mcp-public.jsonl')
  if (result.subtype === 'error_max_structured_output_retries') {
    const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number | null; signal: string | null; stopped: boolean }
    const requests = history.filter(row => row.type === 'api-request'), shapes = history.filter(row => row.type === 'api-request-shape')
    const summaries = new Map([...checkClaudeHistoryChain(history, original)].filter(row => row.compactSummary).map(row => [row.uuid!, row.compactSummary!.messageDigest])), compactSummaries = new Set<string>()
    const companions = claudeOutputLimitCompanions(history, original), recoveries: ClaudeRecovery[] = []
    const unknownUser = history.some(row => {
      if (row.type !== 'user' || row.uuid === plan.userUuid) return false
      if (summaries.has(row.uuid!)) return false
      if (companions.has(row.uuid!)) return false
      if (row.promptId !== original.promptId || !row.sourceToolAssistantUUID || row.parentUuid !== row.sourceToolAssistantUUID || row.message?.role !== 'user' || !Array.isArray(row.message.content) || !row.message.content.length) return true
      const assistant = history.find(assistant => assistant.type === 'assistant' && assistant.uuid === row.sourceToolAssistantUUID)
      return row.message.content.some(block => block.type !== 'tool_result' || !Array.isArray(assistant?.message?.content) || !assistant.message.content.some(call => call.type === 'tool_use' && call.id === block.tool_use_id))
    })
    if (exit.code !== 1 || exit.signal !== null || exit.stopped !== true || terminalStopOutcome(plan, result) === 'sent' || result.type !== 'result' || result.is_error !== true
      || plan.policyDigest !== hash(structuredExecutionPolicy(execution)) || execution.claudeNative && (execution.claudeNative.pid !== plan.pid || execution.claudeNative.receiptFile !== plan.receiptFile)
      || result.session_id !== plan.sessionId || result.user_message_uuid !== plan.userUuid || JSON.stringify(result.user_message_uuids) !== JSON.stringify([plan.userUuid])
      || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || original.parentUuid !== null
      || JSON.stringify(original.message) !== JSON.stringify(echo.message) || JSON.stringify(original.message) !== JSON.stringify({ role: 'user', content: [{ type: 'text', text: prompt }] })
      || JSON.stringify([...init.tools].sort()) !== JSON.stringify([...toolNames].sort()) || readClaudeMcpToolNames(mcpPath).some(name => name !== 'spex_read_frozen')
      || !requests.length || requests[0].keep !== 0 || requests[0].base || !requests[0].tail?.includes(claudeMessageDigest(original.message))
      || requests.some(row => row.model !== model || !shapes.some(shape => shape.shapeHash === row.shapeHash && shape.placeholderValid && shape.toolNames && toolNames.every(name => shape.toolNames!.includes(name)) && shape.toolNames.every(name => [...toolNames, 'DeferredToolPlaceholder'].includes(name))))
      || new Set(history.filter(row => row.uuid).map(row => row.uuid)).size !== history.filter(row => row.uuid).length
      || unknownUser || history.some(row => row.sessionId !== plan.sessionId || row.type === 'assistant' && Array.isArray(row.message?.content) && row.message.content.some(block => !block.name || !toolNames.includes(block.name))))
      throw new StructuredSessionError('stale_result', 'Claude schema retry exhaustion lost its exact terminal, API, original user or isolated capability identity')
    const blobs = readClaudeApiMessageBlobs(history), metadata = readClaudeApiSourceMetadata(historyPath, plan.sessionId, model), api = new Map<string, string[]>(), observedShapes = new Set<string>(), assistants = new Set<string>()
    const users = new Map<string, ClaudePublicMessage>(), calls = new Map<string, ClaudePublicRecord>(), responses = new Map<string, Exclude<ClaudePublicMessage['content'], string>[number]>()
    const originalHash = claudeMessageDigest(original.message)
    for (const row of history) {
      if (row.type === 'system') continue
      if (row.compactSummary) {
        compactSummaries.add(row.compactSummary.messageDigest)
        for (const recovery of recoveries) if (recovery.consumed) { recovery.summaries.add(row.compactSummary.messageDigest); recovery.hashes.add(row.compactSummary.messageDigest) }
        continue
      }
      if (row.turnCompanion && !companions.has(row.uuid!)) throw new StructuredSessionError('stale_result', 'Claude schema retry exhaustion cannot classify unknown recovery user inputs')
      if (row.type === 'api-request-blob' && row.compactSummaryDigest && !compactSummaries.has(row.compactSummaryDigest)) throw new StructuredSessionError('stale_result', 'Claude API string message is not an observed same-turn compact summary') // dead-words-ok: Claude CLI 原生公开事件类型，外部协议名称必须逐字匹配。
      if (row.type === 'api-request-shape') observedShapes.add(row.shapeHash!)
      if (row.type === 'assistant') {
        if (!row.requestRef || !api.has(row.requestRef)) throw new StructuredSessionError('stale_result', 'Claude assistant has no preceding actual API request')
        consumeClaudeRecoveryRequest(recoveries, row.requestRef)
        assistants.add(row.uuid!)
        for (const block of row.message!.content as Exclude<ClaudePublicMessage['content'], string>) {
          if (!block.id || calls.has(block.id)) throw new StructuredSessionError('stale_result', 'Claude schema failure reused a native tool call identity')
          calls.set(block.id, row)
        }
      }
      if (row.type === 'user') {
        const recovery = companions.get(row.uuid!)
        if (recovery) { recoveries.push(recovery); users.set(row.uuid!, row.message!); continue }
        if (row.uuid !== plan.userUuid) for (const block of row.message!.content as Exclude<ClaudePublicMessage['content'], string>) {
          const call = calls.get(block.tool_use_id!)
          if (!call || responses.has(block.tool_use_id!) || call.uuid !== row.sourceToolAssistantUUID || call.uuid !== row.parentUuid) throw new StructuredSessionError('stale_result', 'Claude schema failure tool reply has no preceding exact native call')
          responses.set(block.tool_use_id!, block)
        }
        users.set(row.uuid!, row.message!)
      }
      if (row.type === 'api-request') {
        const hashes = claudeApiRequestHashes(row, api, observedShapes, model)
        const requestSources = metadata.get(row.id!)
        for (const digest of hashes) {
          const source = requestSources?.messages.get(digest)
          if (!requestSources || !source || source.ordinal >= requestSources.ordinal) throw new StructuredSessionError('stale_result', 'Claude actual API input has no prior exact role source')
          if (source.role !== 'user') {
            if (source.kind === 'transcript-prefix' && source.sourceUuids.some(uuid => !assistants.has(uuid))) throw new StructuredSessionError('stale_result', 'Claude assistant source has no preceding public native identity')
            continue
          }
          const blob = blobs.get(digest), userSources = source.sourceUuids.map(uuid => users.get(uuid))
          const summaryAliases = [...(blob?.summaries ?? [])].filter(hash => compactSummaries.has(hash))
          if (compactSummaries.has(digest) || summaryAliases.length) {
            if (blob) claudeApiToolResultIds(blob.content, responses)
            for (const recovery of recoveries) if (recovery.summaries.has(digest) || summaryAliases.some(hash => recovery.summaries.has(hash))) recovery.hashes.add(digest)
            continue
          }
          if (source.kind === 'transcript-prefix' && userSources.some((message, index) => !message || !Array.isArray(message.content) && source.sourceUuids[index] !== plan.userUuid && !companions.has(source.sourceUuids[index]))) throw new StructuredSessionError('stale_result', 'Claude user source UUID has no preceding authenticated public content')
          const content = source.kind === 'transcript-prefix' ? userSources.flatMap(message => claudeMessageBlocks(message!)) : blob?.content
          if (!users.has(plan.userUuid) || !Array.isArray(content) || !content.length
            || claudeApiSourceDigest({ role: 'user', content }) !== digest || source.kind === 'cas' && blob && (!blob.canonical || blob.summaries.size)) throw new StructuredSessionError('stale_result', 'Claude actual API user message has no observed original prompt or exact tool reply source')
          const matching = matchingClaudeRecoveries(recoveries, content, prompt)
          if (content.some(block => block.type === 'text') && digest !== originalHash && digest !== claudeMessageDigest({ role: 'user', content: claudeMessageBlocks(original.message!) }) && !matching.length) throw new StructuredSessionError('stale_result', 'Claude actual API user message contains unobserved recovery text')
          for (const recovery of matching) recovery.hashes.add(digest)
          claudeApiToolResultIds(content, responses)
        }
        api.set(row.id!, hashes)
        recordClaudeRecoveryRequest(recoveries, row, hashes)
      }
    }
    if (recoveries.some(recovery => !recovery.consumed)) throw new StructuredSessionError('stale_result', 'Claude recovery companion has no new exact actual API consumer')
    throw claudeSchemaRetryError(calls, responses, { threadId: plan.sessionId, turnId: plan.userUuid })
  }
  plan = { ...plan, historyPath }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
  const witness: ClaudeFrozenWitness = { version: 1, provider: 'claude-code', cliVersion: CLI_VERSION, model, sessionId: plan.sessionId, userUuid: plan.userUuid, promptId: original.promptId, prompt, nativeHistoryPath: historyPath, history, mcpHistory: { path: mcpPath, toolNames: readClaudeMcpToolNames(mcpPath) }, echo, result, initTools: init.tools }
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(result.structured_output)) throw new StructuredSessionError('failed', 'Claude structured_output does not match the pinned JSON schema')
  persistCompletionJson(join(root, 'witness.json'), witness)
  const proof = proveClaudeFrozenReads(execution.frozenContext!, witness)
  const answer: NativeResult = { threadId: plan.sessionId, turnId: plan.userUuid, text: JSON.stringify(result.structured_output), frozenReadProof: proof }
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
  if (!execution.turnStartRequested && !execution.threadId && !execution.turnId && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
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
  const model = claudeNativeModel(execution.model, nativeConfiguration), root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['init.json', 'user-echo.json', 'result.json', 'exit.json'].every(name => existsSync(join(root, name))) ? settleClaudeWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution, undefined, callbacks.signal).then(publish => publish()) : null
    : completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.claudeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'Claude in-progress dispatch cannot be resumed by appending another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'Claude requires the verified outer macOS read-only sandbox')
  if (!nativeConfiguration) {
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => process.env[key])) throw new StructuredSessionError('unsupported', 'Claude third-party provider isolation has not been verified')
    for (const name of ['CLAUDE.md', 'managed-settings.json', 'managed-mcp.json']) if (existsSync(join('/Library/Application Support/ClaudeCode', name))) throw new StructuredSessionError('unsupported', 'Claude managed policy isolation needs separate capability evidence')
  }
  const resolved = spawnSync('/usr/bin/which', ['claude'], { encoding: 'utf8' })
  if (resolved.error || resolved.status !== 0) throw new StructuredSessionError('unsupported', 'Claude CLI is unavailable in the current process PATH')
  const cliPath = realpathSync(resolved.stdout.trim())
  const cliVersion = execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim()
  if (!cliVersion || !nativeConfiguration && cliVersion !== CLI_VERSION) throw new StructuredSessionError('unsupported', 'Claude CLI version has no verified isolated capability identity')
  const binaryDigest = createHash('sha256').update(readFileSync(cliPath)).digest('hex')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const name of [...(nativeConfiguration ? [] : ['cwd', 'claude-home']), 'tmp', 'debug']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  const native = { version: nativeConfiguration ? 2 as const : 1 as const, root, sessionId: randomUUID(), userUuid: randomUUID() }
  const configHome = join(root, 'claude-home'), cwd = worktree ? worktreePath! : join(root, 'cwd')
  let plan: NativePlan = { ...native, ...(worktree ? { workspace: cwd } : {}), ...(nativeConfiguration ? { configRoot: resolve(cwd, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')), requestedModel: execution.model } : {}), requestDigest: hash({ prompt, policy: structuredExecutionPolicy(execution) }), policyDigest: hash(structuredExecutionPolicy(execution)), cliPath, cliVersion, binaryDigest, receiptFile: join(root, 'process.json') }
  const mcpInput = join(root, 'reader.json'), mcpConfig = join(root, 'mcp.json'), profile = join(root, 'policy.sb')
  if (!worktree) {
    writeFileSync(mcpInput, JSON.stringify({ root, ref: execution.frozenContext }), { mode: 0o400 })
    const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
    const readerArgs = [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, mcpInput]
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { frozen: { type: 'stdio', command: process.execPath, args: readerArgs } } }), { mode: 0o400 })
    writeFileSync(profile, structuredSeatbeltProfile(realpathSync(root)), { mode: 0o400 })
  }
  const env: NodeJS.ProcessEnv = nativeConfiguration
    ? { ...process.env, TMPDIR: join(root, 'tmp'), CLAUDE_CODE_TMPDIR: join(root, 'tmp'), CLAUDE_CODE_DEBUG_LOGS_DIR: join(root, 'debug') }
    : { PATH: process.env.PATH, HOME: homedir(), TMPDIR: join(root, 'tmp'), CLAUDE_CONFIG_DIR: configHome, CLAUDE_CODE_TMPDIR: join(root, 'tmp'), CLAUDE_CODE_DEBUG_LOGS_DIR: join(root, 'debug'), MAX_MCP_OUTPUT_TOKENS: '500000' }
  if (nativeConfiguration) {
    for (const key of sessionIdentityEnvVars()) delete env[key]
    env.SPEXCODE_SESSION_ID = id
  }
  const authenticationEnvironment = nativeConfiguration ? { environment: {}, source: 'native' } : prepareClaudeAuthenticationEnvironment(process.env)
  if (!nativeConfiguration) Object.assign(env, authenticationEnvironment.environment)
  if (!worktree) {
    const auth = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, cliPath, '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['**'], enabledPlugins: {} }), 'auth', 'status', '--json'], { cwd, env, encoding: 'utf8', timeout: 10000 })
    if (auth.error) throw new StructuredSessionError('unsupported', `Claude isolated authentication status failed (${(auth.error as NodeJS.ErrnoException).code ?? 'unknown'})`)
    let authentication: { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
    try { authentication = JSON.parse(auth.stdout) as typeof authentication }
    catch { throw new StructuredSessionError('unsupported', `Claude isolated authentication returned invalid status (exit ${auth.status ?? 'signal'})`) }
    if (!['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper'].includes(authentication.authMethod ?? '') || authentication.apiProvider !== 'firstParty') throw new StructuredSessionError('unsupported', 'Claude isolated authentication provider/status has no verified capability identity')
    writeFileSync(join(root, 'auth-status.json'), JSON.stringify({ loggedIn: authentication.loggedIn, authMethod: authentication.authMethod, apiProvider: authentication.apiProvider, source: authenticationEnvironment.source, exitStatus: auth.status }), { mode: 0o600 })
    if (auth.status !== 0 || authentication.loggedIn !== true) throw new StructuredSessionError('unsupported', 'The actual Claude CLI reports authentication unavailable in its isolated runtime; existing keychain/wrapper authentication is preserved and credentials are never copied')
  }
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
  await callbacks.onNative(native)
  const args = worktree ? claudeWorktreeArgs({ sessionId: native.sessionId, model, schema: execution.schema, effort: execution.effort, mode: execution.worktree!.mode, ...(nativeConfiguration ? { nativeConfiguration } : {}) }) : claudeStructuredArgs({ sessionId: native.sessionId, model, mcpConfig, schema: execution.schema, effort: execution.effort })
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ command: cliPath, args, environmentNames: Object.keys(env), cwd, capability: { cliVersion, binaryDigest, ...(nativeConfiguration ? { configurationSource: 'native' } : { maxReadBytes: 65536, maxResultSizeChars: 500000, maxMcpOutputTokens: 500000 }) } }), { mode: 0o400 })
  await callbacks.onTurnStarting?.()
  if (worktree) await sampleNativeWorktreeProcesses(plan)
  const child = spawn(worktree ? cliPath : '/usr/bin/sandbox-exec', worktree ? args : ['-f', profile, cliPath, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
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
  let failure: Error | undefined, work = Promise.resolve(), aborted = false, timedOut = false, interruptId: string | undefined
  let rejectStop: (error: Error) => void = () => {}
  const stopDeadline = new Promise<never>((_resolve, reject) => { rejectStop = reject })
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
  const interrupt = (): void => {
    const requested = aborted
    aborted = true
    armStop()
    if (requested) return
    const requestId = randomUUID()
    writeFileSync(join(root, 'interrupt-request.json'), JSON.stringify({ requestId, sessionId: native.sessionId, userUuid: native.userUuid }), { mode: 0o600 })
    if (!child.stdin.writable) return
    interruptId = requestId
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: interruptId, request: { subtype: 'interrupt' } })}\n`)
  }
  active.set(root, { child, interrupt })
  const abort = (): void => interrupt()
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => { timedOut = true; interrupt(); void callbacks.onTimeout?.() })
  let sampling: Promise<void> | undefined
  processCensus = worktree ? setInterval(() => {
    if (sampling) return
    sampling = sampleNativeWorktreeProcesses(plan, stopAt).catch(error => { failure ??= error as Error; interrupt() }).finally(() => { sampling = undefined })
  }, 100) : undefined
  const stoppedProcesses = async (): Promise<boolean> => worktree ? nativeWorktreeProcessesStopped(plan, false, stopAt) : detachedRuntimeIsGone(plan.pid!, plan.receiptFile) && claudeMcpStopped(root)
  const lines = createInterface({ input: child.stdout })
  let protocolOrdinal = 0
  lines.on('line', line => {
    let ordinal = 0
    work = work.then(async () => {
      if (failure) return
      ordinal = ++protocolOrdinal
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'result' || event.type === 'system' && event.subtype === 'init') {
        const initEvent = event.type === 'system', strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
        appendFileSync(join(root, 'native-protocol.jsonl'), JSON.stringify({
          version: 1, ordinal, kind: initEvent ? 'init' : 'result',
          sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
          uuid: typeof event.uuid === 'string' ? event.uuid : undefined,
          parentToolUseIdOwn: Object.hasOwn(event, 'parent_tool_use_id'),
          ...(typeof event.parent_tool_use_id === 'string' || event.parent_tool_use_id === null ? { parentToolUseId: event.parent_tool_use_id } : {}),
          ...(initEvent ? { modelDigest: typeof event.model === 'string' ? hash(event.model) : undefined, toolsDigest: strings(event.tools) ? hash(event.tools) : undefined, toolsCount: Array.isArray(event.tools) ? event.tools.length : undefined }
            : { subtype: typeof event.subtype === 'string' && /^[a-z0-9_-]{1,80}$/i.test(event.subtype) ? event.subtype : undefined, isError: typeof event.is_error === 'boolean' ? event.is_error : undefined,
              userUuid: typeof event.user_message_uuid === 'string' ? event.user_message_uuid : undefined, userUuidsDigest: strings(event.user_message_uuids) ? hash(event.user_message_uuids) : undefined, userUuidsCount: Array.isArray(event.user_message_uuids) ? event.user_message_uuids.length : undefined, structuredOutputOwn: Object.hasOwn(event, 'structured_output') }),
        }) + '\n', { mode: 0o600 })
      }
      if (event.type === 'system' && event.subtype === 'init') {
        if (init) throw new StructuredSessionError('stale_result', 'Claude emitted more than one native init identity')
        init = event as unknown as ClaudeInit
        if (!init || init.session_id !== native.sessionId || typeof init.model !== 'string' || !init.model.trim() || !nativeConfiguration && init.model !== model || (!worktree && JSON.stringify([...init.tools].sort()) !== JSON.stringify([...toolNames].sort()))) throw new StructuredSessionError('unsupported', 'Claude actual init model or tool surface differs from fixed isolation policy')
        writeFileSync(join(root, 'init.json'), JSON.stringify({ session_id: init.session_id, model: init.model, tools: init.tools }), { mode: 0o400 })
        if (nativeConfiguration) { plan = { ...plan, resolvedModel: init.model }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 }) }
        await callbacks.onThread(native.sessionId)
      } else if (event.type === 'user' && event.uuid === native.userUuid) {
        echo = { uuid: String(event.uuid), session_id: String(event.session_id), message: event.message as ClaudePublicMessage }
        writeFileSync(join(root, 'user-echo.json'), JSON.stringify(echo), { mode: 0o400 }); await callbacks.onTurn(native.userUuid)
      } else if (event.type === 'control_response' && interruptId && (event.response as { request_id?: string; subtype?: string })?.request_id === interruptId) {
        const response = event.response as { request_id: string; subtype: string }
        if (response.subtype === 'success') writeFileSync(join(root, 'interrupt-ack.json'), JSON.stringify({ requestId: response.request_id, sessionId: native.sessionId }), { mode: 0o400 })
      } else if (event.type === 'result') {
        result = Object.fromEntries(['type', 'subtype', 'is_error', 'session_id', 'uuid', 'user_message_uuid', 'user_message_uuids', 'structured_output'].map(key => [key, event[key]])) as ClaudeFrozenWitness['result']
        writeFileSync(join(root, 'result.json'), JSON.stringify(result), { mode: 0o400 }); armStop(); child.stdin.end()
      }
    }).catch(error => {
      failure ??= error as Error
      stopAt ??= Date.now() + 15000
      clearInterval(processCensus)
      killOwnGroup()
      stopLimit ??= setTimeout(() => rejectStop(new StructuredSessionError('cancellation_pending', 'Claude failed protocol observation has no bounded native stop evidence')), 15000)
      appendFileSync(join(root, 'native-protocol.jsonl'), JSON.stringify({ version: 1, ordinal, kind: 'error', code: failure instanceof StructuredSessionError ? failure.code : 'observer_failed' }) + '\n', { mode: 0o600 })
    })
  })
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrHash.update(bytes); stderrBytes += bytes.length })
  child.once('error', error => { failure ??= error })
  let settled: { answer: NativeResult | (() => WorktreeNativeResult) } | { error: unknown }
  let finallyStopped = false
  try {
    child.stdin.write(`${JSON.stringify({ type: 'user', session_id: native.sessionId, uuid: native.userUuid, message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`)
    if (callbacks.signal?.aborted) interrupt()
    const exit = await Promise.race([exited, stopDeadline])
    await work
    stopAt ??= Date.now() + 15000
    clearInterval(processCensus); await sampling
    for (let retry = 0; retry < 100 && !(await stoppedProcesses()); retry++) await new Promise<void>(resolve => setTimeout(resolve, 25))
    const stopped = await stoppedProcesses()
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ ...exit, stopped, stderrBytes, stderrSha256: stderrHash.digest('hex') }), { mode: 0o400 })
    if (!stopped) throw new StructuredSessionError('cancellation_pending', 'Claude or MCP descendant process group remains unproven')
    if (aborted) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Claude exact process group stopped after cancellation')
    if (failure) throw failure
    if (!init || !echo || !result) throw new StructuredSessionError('failed', `Claude execution is missing native events: ${[!init ? 'init' : '', !echo ? 'user-echo' : '', !result ? 'result' : ''].filter(Boolean).join(', ')}`)
    if (exit.code !== 0 && result.subtype !== 'error_max_structured_output_retries' && !(worktree && controlledClaudeWorktreeSuccess(plan, execution, result, { ...exit, stopped }, callbacks.signal))) throw new StructuredSessionError('failed', `Claude native execution exited unsuccessfully: code=${exit.code}, signal=${exit.signal}, result.is_error=${typeof result.is_error === 'boolean' ? result.is_error : 'invalid'}`)
    const history = worktree ? claudeWorktreeHistory(plan, false) : readClaudePublicHistory(nativeHistoryPath(root, native.sessionId), native.sessionId), original = history.find(row => row.type === 'user' && row.uuid === native.userUuid)
    if (!original?.promptId) throw new StructuredSessionError('stale_result', 'Claude original native promptId is missing')
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile: plan.receiptFile, promptId: original.promptId })
    settled = { answer: await (worktree ? settleClaudeWorktreeResult(plan, prompt, { ...execution, claudeNative: { ...native, pid: plan.pid, receiptFile: plan.receiptFile } }, stopAt, callbacks.signal) : settleClaudeResult(plan, prompt, execution)) }
  } catch (error) { settled = { error } }
  finally {
    stopAt ??= Date.now() + 15000
    clearInterval(processCensus); await sampling
    lines.close()
    try { finallyStopped = await stoppedProcesses() }
    finally {
      clearTimeout(timer); if (stopTimer) clearTimeout(stopTimer); if (stopLimit) clearTimeout(stopLimit)
      callbacks.signal?.removeEventListener('abort', abort); active.delete(root)
      if (!finallyStopped) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref() }
    }
  }
  if (!finallyStopped) throw new StructuredSessionError('cancellation_pending', 'Claude native stop remains unproven')
  if ('error' in settled && settled.error instanceof StructuredSessionError && settled.error.code === 'cancellation_pending') throw settled.error
  if (worktree && aborted && !failure) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Claude exact process group stopped after cancellation')
  if ('error' in settled) throw settled.error
  if (failure) throw failure
  return typeof settled.answer === 'function' ? settled.answer() : settled.answer
}
