import { nativeWorktreeProcessesStopped, sampleNativeWorktreeProcesses } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { checkClaudeHistoryChain, claudeRecoveryCompanion, claudeApiRequestHashes, claudeApiSourceDigest, claudeApiToolResultIds, claudeMessageBlocks, claudeMessageDigest, claudeOutputLimitCompanions, matchingClaudeRecoveries, recordClaudeRecoveryRequest, consumeClaudeRecoveryRequest, proveClaudeFrozenReads, readClaudeApiMessageBlobs, readClaudeApiSourceMetadata, readClaudeMcpToolNames, readClaudePublicHistory, verifyFrozenReadProof, type ClaudeRecovery, type ClaudeFrozenWitness, type ClaudePublicMessage, type ClaudePublicRecord, type FrozenReadProof } from './frozen-context.js'
import { structuredExecutionTimer, StructuredSessionError, structuredExecutionPolicy, structuredSeatbeltProfile, type StructuredExecution } from './session-structured-policy.js'

const CLI_VERSION = '2.1.309 (Claude Code)'
const toolNames = ['StructuredOutput', 'mcp__frozen__spex_read_frozen']
const systemPrompt = 'Read only immutable context through the configured spex_read_frozen MCP. Follow the frozen task and return the requested schema using StructuredOutput. No shell, files, network, tools discovery, skills or subagents. Never call DeferredToolPlaceholder.'
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type NativePlan = { version: 1; root: string; sessionId: string; userUuid: string; requestDigest: string; policyDigest: string; historyPath?: string; cliPath: string; cliVersion: string; binaryDigest: string; pid?: number; receiptFile: string; workspace?: string }
type WorktreeNativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: FrozenReadProof }
type Completed = { plan: NativePlan; witness: ClaudeFrozenWitness; result: NativeResult }
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

/** CLI会缩短过长cwd目录名；只在本专属空home查找精确UUID，不猜其私有路径算法。 */
function nativeHistoryPath(root: string, sessionId: string): string {
  const projects = join(root, 'claude-home', 'projects')
  const paths = readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(projects, entry.name, `${sessionId}.jsonl`)).filter(path => existsSync(path))
  if (paths.length !== 1 || !realpathSync(paths[0]).startsWith(`${realpathSync(projects)}/`)) throw new StructuredSessionError('stale_result', 'Claude dedicated home has no unique exact native session history')
  return paths[0]
}

/** namespace只路由执行器；模型必须是原生明确ID，不能接受动态别名或上下文显示后缀。 */
export function claudeNativeModel(model: string | undefined): string {
  const value = model?.startsWith('claude:') ? model.slice(7) : ''
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
export function claudeWorktreeArgs(input: { sessionId: string; model: string; schema: Record<string, unknown>; effort?: string; mode?: 'read' | 'edit' }): string[] {
  if (input.effort && !['low', 'medium', 'high', 'xhigh'].includes(input.effort)) throw new StructuredSessionError('unsupported', 'Claude effort must be an explicitly supported native value')
  return ['-p', '--session-id', input.sessionId, '--model', input.model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
    '--setting-sources', '', '--settings', JSON.stringify({ autoMemoryEnabled: false, enabledPlugins: {} }), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', input.mode === 'read' ? 'plan' : 'bypassPermissions', '--json-schema', JSON.stringify(input.schema), ...(input.effort ? ['--effort', input.effort] : [])]
}

type ClaudeToolReply = Exclude<ClaudePublicMessage['content'], string>[number]

/** 两种执行模式共用原生 schema 错误字段提取，不修补模型业务结果。 */
function claudeSchemaRetryError(calls: ReadonlyMap<string, ClaudePublicRecord>, responses: ReadonlyMap<string, ClaudeToolReply>, identity: { threadId: string; turnId: string }): StructuredSessionError {
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

/** 正常文件工具保持开放；失败仅认证同轮工具配对、原生模型与严格 companion。 */
function worktreeSchemaRetryError(history: readonly ClaudePublicRecord[], original: ClaudePublicRecord, execution: StructuredExecution): StructuredSessionError {
  const calls = new Map<string, ClaudePublicRecord>(), responses = new Map<string, ClaudeToolReply>(), requests = new Set<string>()
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  let latestMessage: string | undefined, latestAssistant: string | undefined, schemaErrors = 0, enforcementSeen = false
  for (const row of checkClaudeHistoryChain(history, original)) {
    if (row.type === 'api-request') {
      if (!row.id || row.model !== claudeNativeModel(execution.model)) throw new StructuredSessionError('stale_result', 'Claude worktree schema failure model request differs')
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
            schemaErrors++
          }
        }
      }
    }
    if (row.type === 'user' || row.type === 'assistant' || row.type === 'system' && row.subtype === 'api_error') latestMessage = row.uuid
  }
  if (!requests.size || !schemaErrors) throw new StructuredSessionError('stale_result', 'Claude worktree exhaustion has no original native schema errors')
  return claudeSchemaRetryError(calls, responses, { threadId: original.sessionId, turnId: original.uuid! })
}

/** 工作区模式只核原生输入、模型和终态身份，不借用冻结读取证明。 */
function settleClaudeWorktreeResult(plan: NativePlan, prompt: string, execution: StructuredExecution): WorktreeNativeResult {
  const root = plan.root, native = execution.claudeNative
  if (plan.cliVersion !== CLI_VERSION || plan.requestDigest !== hash({ prompt, policy: structuredExecutionPolicy(execution) }) || plan.policyDigest !== hash(structuredExecutionPolicy(execution))
    || !native || native.root !== root || native.sessionId !== plan.sessionId || native.userUuid !== plan.userUuid || native.pid !== plan.pid || native.receiptFile !== plan.receiptFile) throw new StructuredSessionError('stale_result', 'Claude worktree completion lost its exact request/native/process identity')
  if (execution.state !== 'completed' && !nativeWorktreeProcessesStopped(claudeWorktreeProcessPlan(plan))) throw new StructuredSessionError('cancellation_pending', 'Claude worktree native or unknown orphan stop remains unproven')
  const init = JSON.parse(readFileSync(join(root, 'init.json'), 'utf8')) as { session_id: string; model: string; tools: string[] }
  const echo = JSON.parse(readFileSync(join(root, 'user-echo.json'), 'utf8')) as ClaudeFrozenWitness['echo']
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as ClaudeFrozenWitness['result']
  const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as { code: number; signal: string | null; stopped: boolean }
  const history = readClaudePublicHistory(nativeHistoryPath(root, plan.sessionId), plan.sessionId), original = history.find(row => row.type === 'user' && row.uuid === plan.userUuid)
  if (init.session_id !== plan.sessionId || init.model !== claudeNativeModel(execution.model) || !original?.promptId || original.sessionId !== plan.sessionId
    || echo.uuid !== plan.userUuid || echo.session_id !== plan.sessionId || hash(echo.message) !== hash({ role: 'user', content: [{ type: 'text', text: prompt }] }) || hash(original.message) !== hash(echo.message)
    || original.parentUuid !== null || result.session_id !== plan.sessionId || result.user_message_uuid !== plan.userUuid || hash(result.user_message_uuids) !== hash([plan.userUuid]) || !exit.stopped || exit.signal !== null) throw new StructuredSessionError('stale_result', 'Claude worktree original prompt/model/exit evidence differs')
  if (result.subtype === 'error_max_structured_output_retries') {
    if (execution.state === 'completed' || existsSync(join(root, 'completed.json')) || exit.code !== 1 || result.type !== 'result' || result.is_error !== true) throw new StructuredSessionError('stale_result', 'Claude worktree schema exhaustion terminal differs')
    throw worktreeSchemaRetryError(history, original, execution)
  }
  if (exit.code !== 0 || result.subtype !== 'success' || result.is_error || result.structured_output === undefined) throw new StructuredSessionError('stale_result', 'Claude worktree success evidence differs')
  const validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(result.structured_output)) throw new StructuredSessionError('failed', 'Claude worktree structured output does not match its schema')
  const answer: WorktreeNativeResult = { threadId: plan.sessionId, turnId: plan.userUuid, text: JSON.stringify(result.structured_output) }
  const completion = { plan, init, echo, result, exit, promptId: original.promptId, answer }
  const path = join(root, 'completed.json')
  if (execution.state === 'completed' && (!existsSync(path) || execution.threadId !== answer.threadId || execution.turnId !== answer.turnId || execution.resultDigest !== hash(result.structured_output))) throw new StructuredSessionError('stale_result', 'Claude worktree durable completed identity differs')
  persistCompletionJson(path, completion)
  return answer
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
      || !execution.frozenReadProof || hash(execution.frozenReadProof) !== hash(saved.result.frozenReadProof)) throw new StructuredSessionError('stale_result', 'Claude durable completed state has missing or mismatched result/identity/proof')
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
    if (exit.code !== 1 || exit.signal !== null || exit.stopped !== true || result.type !== 'result' || result.is_error !== true
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
      if (row.type === 'api-request-blob' && row.compactSummaryDigest && !compactSummaries.has(row.compactSummaryDigest)) throw new StructuredSessionError('stale_result', 'Claude API string message is not an observed same-turn compact summary')
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
  const native = execution.claudeNative
  if (!native) return execution.turnStartRequested ? { nativeStopped: false, acknowledged: false, error: 'Claude dispatch identity is unproven' } : { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const path = join(native.root, 'plan.json')
  if (!existsSync(path)) return { nativeStopped: false, acknowledged: false, error: 'Claude exact launch plan is missing' }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as NativePlan
  if (plan.root !== native.root || plan.sessionId !== native.sessionId || plan.userUuid !== native.userUuid || plan.policyDigest !== hash(structuredExecutionPolicy(execution))) return { nativeStopped: false, acknowledged: false, error: 'Claude fixed launch policy or native identity differs' }
  if (!execution.turnStartRequested && !execution.threadId && !execution.turnId && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  if (!plan.pid || plan.pid !== native.pid || plan.receiptFile !== native.receiptFile) return { nativeStopped: false, acknowledged: false, error: 'Claude launch/process identity differs' }
  const local = active.get(native.root)
  if (local) local.interrupt()
  else if (!detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
    const proof = verifyDetachedRuntime(plan.pid, plan.receiptFile)
    if (!proof.ok) return { nativeStopped: false, acknowledged: false, error: 'Claude exact process-group ownership is unproven' }
    try { process.kill(-plan.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const stoppedProcesses = (terminate = false): boolean => execution.policy === 'native-worktree-v1' ? nativeWorktreeProcessesStopped(claudeWorktreeProcessPlan(plan), terminate) : detachedRuntimeIsGone(plan.pid!, plan.receiptFile) && claudeMcpStopped(native.root, terminate)
  if (execution.policy !== 'native-worktree-v1') claudeMcpStopped(native.root, true)
  const deadline = Date.now() + timeoutMs
  while (!stoppedProcesses(true) && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 25))
  let acknowledged = false
  if (existsSync(join(native.root, 'interrupt-ack.json'))) {
    const ack = JSON.parse(readFileSync(join(native.root, 'interrupt-ack.json'), 'utf8')) as { requestId: string; sessionId: string }
    const request = JSON.parse(readFileSync(join(native.root, 'interrupt-request.json'), 'utf8')) as { requestId: string; sessionId: string; userUuid: string }
    if (ack.requestId !== request.requestId || ack.sessionId !== native.sessionId || request.sessionId !== native.sessionId || request.userUuid !== native.userUuid) throw new StructuredSessionError('stale_result', 'Claude interrupt ACK differs from its exact session/user/request')
    acknowledged = true
  }
  return stoppedProcesses() ? { nativeStopped: true, acknowledged, nativeStatus: 'processGroupGone' }
    : { nativeStopped: false, acknowledged, error: 'Claude native/MCP process group has not been proven stopped' }
}

/** 每次正式派发只有一个原生session和user；未知in-progress只保留恢复债务，绝不自动resume。 */
export function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks): Promise<NativeResult>
// eslint-disable-next-line no-redeclare -- Preserve the legacy frozen proof return type.
export function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks, worktreePath: string | undefined): Promise<NativeResult | WorktreeNativeResult>
// eslint-disable-next-line no-redeclare -- TypeScript implementation of both executor modes.
export async function claudeStructuredTurn(realm: string, id: string, prompt: string, execution: StructuredExecution, callbacks: NativeCallbacks, worktreePath?: string): Promise<NativeResult | WorktreeNativeResult> {
  const worktree = execution.version === 6 && execution.policy === 'native-worktree-v1' && !!execution.worktree && !!worktreePath && !execution.frozenContext && !execution.readerRuntime
  if (!worktree && (execution.version !== (execution.timeoutMs === null ? 5 : 3) || execution.policy !== 'claude-frozen-read-only-v1' || !execution.frozenContext || execution.readerRuntime)) throw new StructuredSessionError('unsupported', 'Claude requires its exact isolated frozen policy')
  const model = claudeNativeModel(execution.model), root = join(realm, id)
  const replay = worktree
    ? existsSync(join(root, 'plan.json')) && ['init.json', 'user-echo.json', 'result.json', 'exit.json'].every(name => existsSync(join(root, name))) ? settleClaudeWorktreeResult(JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan, prompt, execution) : null
    : completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.claudeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'Claude in-progress dispatch cannot be resumed by appending another prompt; exact stop is required')
  if (!worktree && (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))) throw new StructuredSessionError('unsupported', 'Claude requires the verified outer macOS read-only sandbox')
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => process.env[key])) throw new StructuredSessionError('unsupported', 'Claude third-party provider isolation has not been verified')
  for (const name of ['CLAUDE.md', 'managed-settings.json', 'managed-mcp.json']) if (existsSync(join('/Library/Application Support/ClaudeCode', name))) throw new StructuredSessionError('unsupported', 'Claude managed policy isolation needs separate capability proof')
  const resolved = spawnSync('/usr/bin/which', ['claude'], { encoding: 'utf8' })
  if (resolved.error || resolved.status !== 0) throw new StructuredSessionError('unsupported', 'Claude CLI is unavailable in the current process PATH')
  const cliPath = realpathSync(resolved.stdout.trim())
  if (execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim() !== CLI_VERSION) throw new StructuredSessionError('unsupported', 'Claude CLI version has no verified isolated capability identity')
  const binaryDigest = createHash('sha256').update(readFileSync(cliPath)).digest('hex')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const name of ['cwd', 'claude-home', 'tmp', 'debug']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  const native = { version: 1 as const, root, sessionId: randomUUID(), userUuid: randomUUID() }
  const configHome = join(root, 'claude-home'), cwd = worktree ? worktreePath! : join(root, 'cwd')
  let plan: NativePlan = { ...native, ...(worktree ? { workspace: cwd } : {}), requestDigest: hash({ prompt, policy: structuredExecutionPolicy(execution) }), policyDigest: hash(structuredExecutionPolicy(execution)), cliPath, cliVersion: CLI_VERSION, binaryDigest, receiptFile: join(root, 'process.json') }
  const mcpInput = join(root, 'reader.json'), mcpConfig = join(root, 'mcp.json'), profile = join(root, 'policy.sb')
  if (!worktree) {
    writeFileSync(mcpInput, JSON.stringify({ root, ref: execution.frozenContext }), { mode: 0o400 })
    const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
    const readerArgs = [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, mcpInput]
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { frozen: { type: 'stdio', command: process.execPath, args: readerArgs } } }), { mode: 0o400 })
    writeFileSync(profile, structuredSeatbeltProfile(realpathSync(root)), { mode: 0o400 })
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: join(root, 'tmp'), CLAUDE_CONFIG_DIR: configHome, CLAUDE_CODE_TMPDIR: join(root, 'tmp'), CLAUDE_CODE_DEBUG_LOGS_DIR: join(root, 'debug'), MAX_MCP_OUTPUT_TOKENS: '500000' }
  const authenticationEnvironment = prepareClaudeAuthenticationEnvironment(process.env)
  Object.assign(env, authenticationEnvironment.environment)
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
  const args = worktree ? claudeWorktreeArgs({ sessionId: native.sessionId, model, schema: execution.schema, effort: execution.effort, mode: execution.worktree!.mode }) : claudeStructuredArgs({ sessionId: native.sessionId, model, mcpConfig, schema: execution.schema, effort: execution.effort })
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ command: cliPath, args, environmentNames: Object.keys(env), cwd, capability: { cliVersion: CLI_VERSION, binaryDigest, maxReadBytes: 65536, maxResultSizeChars: 500000, maxMcpOutputTokens: 500000 } }), { mode: 0o400 })
  await callbacks.onTurnStarting?.()
  if (worktree) sampleNativeWorktreeProcesses(plan)
  const child = spawn(worktree ? cliPath : '/usr/bin/sandbox-exec', worktree ? args : ['-f', profile, cliPath, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (!child.pid) throw new StructuredSessionError('failed', 'Claude isolated process could not start')
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  child.once('error', () => {})
  try {
    writeDetachedRuntimeReceipt(child.pid, plan.receiptFile)
    plan = { ...plan, pid: child.pid }; writeFileSync(join(root, 'plan.json'), JSON.stringify(plan), { mode: 0o600 })
    if (worktree) sampleNativeWorktreeProcesses(plan)
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile: plan.receiptFile })
  } catch (error) {
    // This is the child just returned by spawn, before any user prompt was sent. A failed receipt
    // publication still leaves recovery debt; neither leader exit nor our signal releases capacity.
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1000))])
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', `Claude spawned process ownership could not be durably published (${(error as NodeJS.ErrnoException).code ?? 'unknown'}); exact process-group stop remains required`)
  }
  let init: { tools: string[]; session_id: string; model: string } | undefined, echo: ClaudeFrozenWitness['echo'] | undefined, result: ClaudeFrozenWitness['result'] | undefined
  let failure: Error | undefined, work = Promise.resolve(), aborted = false, timedOut = false, interruptId: string | undefined
  let rejectStop: (error: Error) => void = () => {}
  const stopDeadline = new Promise<never>((_resolve, reject) => { rejectStop = reject })
  const killOwnGroup = (): void => {
    if (!verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok) return
    try { process.kill(-plan.pid!, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') rejectStop(new StructuredSessionError('cancellation_pending', 'Claude exact process-group termination was refused')) }
  }
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let stopLimit: ReturnType<typeof setTimeout> | undefined
  const interrupt = (): void => {
    aborted = true
    if (interruptId || !child.stdin.writable) return
    interruptId = randomUUID()
    writeFileSync(join(root, 'interrupt-request.json'), JSON.stringify({ requestId: interruptId, sessionId: native.sessionId, userUuid: native.userUuid }), { mode: 0o600 })
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: interruptId, request: { subtype: 'interrupt' } })}\n`)
    stopTimer = setTimeout(killOwnGroup, 10000)
    stopLimit = setTimeout(() => rejectStop(new StructuredSessionError('cancellation_pending', 'Claude cancellation exceeded the exact native stop budget')), 15000)
  }
  active.set(root, { child, interrupt })
  const abort = (): void => interrupt()
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => { timedOut = true; interrupt(); void callbacks.onTimeout?.() })
  const processCensus = worktree ? setInterval(() => { try { sampleNativeWorktreeProcesses(plan) } catch (error) { failure = error as Error; interrupt() } }, 100) : undefined
  const stoppedProcesses = (): boolean => worktree ? nativeWorktreeProcessesStopped(plan) : detachedRuntimeIsGone(plan.pid!, plan.receiptFile) && claudeMcpStopped(root)
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    work = work.then(async () => {
      if (failure) return
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'system' && event.subtype === 'init') {
        init = event as unknown as typeof init
        if (!init || init.session_id !== native.sessionId || init.model !== model || (!worktree && JSON.stringify([...init.tools].sort()) !== JSON.stringify([...toolNames].sort()))) throw new StructuredSessionError('unsupported', 'Claude actual init model or tool surface differs from fixed isolation policy')
        writeFileSync(join(root, 'init.json'), JSON.stringify({ session_id: init.session_id, model: init.model, tools: init.tools }), { mode: 0o400 })
        await callbacks.onThread(native.sessionId)
      } else if (event.type === 'user' && event.uuid === native.userUuid) {
        echo = { uuid: String(event.uuid), session_id: String(event.session_id), message: event.message as ClaudePublicMessage }
        writeFileSync(join(root, 'user-echo.json'), JSON.stringify(echo), { mode: 0o400 }); await callbacks.onTurn(native.userUuid)
      } else if (event.type === 'control_response' && (event.response as { request_id?: string; subtype?: string })?.request_id === interruptId) {
        const response = event.response as { request_id: string; subtype: string }
        if (response.subtype === 'success') writeFileSync(join(root, 'interrupt-ack.json'), JSON.stringify({ requestId: response.request_id, sessionId: native.sessionId }), { mode: 0o400 })
      } else if (event.type === 'result') {
        result = Object.fromEntries(['type', 'subtype', 'is_error', 'session_id', 'uuid', 'user_message_uuid', 'user_message_uuids', 'structured_output'].map(key => [key, event[key]])) as ClaudeFrozenWitness['result']
        writeFileSync(join(root, 'result.json'), JSON.stringify(result), { mode: 0o400 }); child.stdin.end()
      }
    }).catch(error => {
      failure = error as Error; killOwnGroup()
      stopLimit ??= setTimeout(() => rejectStop(new StructuredSessionError('cancellation_pending', 'Claude failed protocol observation has no bounded native stop proof')), 15000)
    })
  })
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrHash.update(bytes); stderrBytes += bytes.length })
  child.once('error', error => { failure = error })
  try {
    child.stdin.write(`${JSON.stringify({ type: 'user', session_id: native.sessionId, uuid: native.userUuid, message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`)
    if (callbacks.signal?.aborted) interrupt()
    const exit = await Promise.race([exited, stopDeadline])
    await work
    for (let retry = 0; retry < 100 && !stoppedProcesses(); retry++) await new Promise<void>(resolve => setTimeout(resolve, 25))
    const stopped = stoppedProcesses()
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ ...exit, stopped, stderrBytes, stderrSha256: stderrHash.digest('hex') }), { mode: 0o400 })
    if (!stopped) throw new StructuredSessionError('cancellation_pending', 'Claude or MCP descendant process group remains unproven')
    if (aborted) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Claude exact process group stopped after cancellation')
    if (failure) throw failure
    if (!init || !echo || !result || exit.code !== 0 && result.subtype !== 'error_max_structured_output_retries') throw new StructuredSessionError('failed', 'Claude execution ended without a complete native result and user echo')
    const history = readClaudePublicHistory(nativeHistoryPath(root, native.sessionId), native.sessionId), original = history.find(row => row.type === 'user' && row.uuid === native.userUuid)
    if (!original?.promptId) throw new StructuredSessionError('stale_result', 'Claude original native promptId is missing')
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile: plan.receiptFile, promptId: original.promptId })
    return worktree ? settleClaudeWorktreeResult(plan, prompt, { ...execution, claudeNative: { ...native, pid: plan.pid, receiptFile: plan.receiptFile } }) : settleClaudeResult(plan, prompt, execution)
  } finally {
    clearInterval(processCensus); clearTimeout(timer); if (stopTimer) clearTimeout(stopTimer); if (stopLimit) clearTimeout(stopLimit)
    callbacks.signal?.removeEventListener('abort', abort); active.delete(root); lines.close()
    if (!stoppedProcesses()) {
      failure = new StructuredSessionError('cancellation_pending', 'Claude native stop remains unproven')
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    }
  }
}
