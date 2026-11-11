import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { nativeWorktreeLaunch, periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { assertRejectedOutput, rejectedFinalOutput, StructuredSessionError, structuredExecutionPolicy, structuredExecutionTimer, type StructuredExecution } from './session-structured-policy.js'

export type CursorNativeState = { version: 1; root: string; sessionId?: string; requestId?: string; pid?: number; receiptFile?: string }
export type CursorStructuredExecution = StructuredExecution & { cursorNative?: CursorNativeState }
type Callbacks = { onNative(state: CursorNativeState): Promise<void>; onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type NativePlan = { version: 1; root: string; workspace: string; tmp: string; mode: 'read' | 'edit'; promptDigest: string; policyDigest: string; cliPath: string; cliVersion: string; args: string[] }
type NativeLaunch = { planDigest: string; pid: number; receiptFile: string; receiptDigest: string }
type OwnedLaunch = NativePlan & NativeLaunch
type NativeRequest = { planDigest: string; sessionId: string; requestId: string; reportedModel?: string }
type NativeOutput = { requestDigest: string; stopReason: string; reportedModel?: string; text: string }
type Exit = { code: number | null; signal: NodeJS.Signals | null }
type NativeClose = { launchDigest: string; outputDigest: string; signal: 'SIGTERM' }
type NativeSettlement = { launchDigest: string; outputDigest: string; stopDigest: string; exit: Exit; closeDigest?: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type RpcObject = Record<string, unknown>

const STOP_MS = 15_000
const CANCEL_GRACE_MS = 1_000
const EOF_GRACE_MS = 500
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown): string => sha256(JSON.stringify(value))
const pending = (message: string): StructuredSessionError => new StructuredSessionError('cancellation_pending', message)
const stale = (message: string): StructuredSessionError => new StructuredSessionError('stale_result', message)
const failed = (message: string): StructuredSessionError => new StructuredSessionError('failed', message)
const cancelled = (timedOut = false): StructuredSessionError => new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'Cursor native turn timed out' : 'Cursor native turn cancelled')
const object = (value: unknown): RpcObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcObject : undefined
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

function readEvidence(root: string, name: string): Buffer {
  try { return readFileSync(join(root, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw stale('Cursor original native evidence is missing'); throw error }
}

function read<T>(root: string, name: string): T {
  try { return JSON.parse(readEvidence(root, name).toString('utf8')) as T }
  catch (error) { if (error instanceof SyntaxError) throw stale('Cursor original native evidence is invalid'); throw error }
}

function writeEvidence(root: string, name: string, value: unknown): void {
  const temporary = join(root, `.${name}.${randomUUID()}`)
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o400, flag: 'wx' })
  renameSync(temporary, join(root, name))
}

function cursorNativeModel(model: string | undefined): string | undefined {
  if (!model?.startsWith('cursor:') || !model.slice(7).trim() || model.includes('\0'))
    throw new StructuredSessionError('unsupported', 'Cursor CLI requires cursor:<model> or cursor:default')
  return model === 'cursor:default' ? undefined : model.slice(7)
}

function launchArgs(workspace: string, mode: NativePlan['mode'], model: string | undefined): string[] {
  return ['--workspace', workspace, '--sandbox', 'enabled', '--trust', ...(mode === 'read' ? ['--mode', 'ask'] : []), ...(model === undefined ? [] : ['--model', model]), 'acp']
}

const nativePrompt = (prompt: string, execution: CursorStructuredExecution): string =>
  `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}`

function assertPlan(plan: NativePlan, root: string, execution: CursorStructuredExecution, prompt?: string, worktreePath?: string): void {
  const native = execution.cursorNative
  if (plan?.version !== 1 || native?.version !== 1 || plan.root !== root || native.root !== root
    || !nonempty(plan.workspace) || worktreePath !== undefined && worktreePath !== plan.workspace || plan.tmp !== join(root, 'tmp')
    || plan.mode !== execution.worktree?.mode || !nonempty(plan.cliPath) || !nonempty(plan.cliVersion)
    || !Array.isArray(plan.args) || digest(plan.args) !== digest(launchArgs(plan.workspace, plan.mode, cursorNativeModel(execution.model)))
    || plan.policyDigest !== digest(structuredExecutionPolicy(execution))
    || prompt !== undefined && (plan.promptDigest !== sha256(nativePrompt(prompt, execution)) || plan.promptDigest !== sha256(readEvidence(root, 'prompt.txt'))))
    throw stale('Cursor original worktree, prompt or policy binding differs')
}

function assertLaunch(plan: NativePlan, launch: NativeLaunch, native: CursorNativeState): void {
  if (!Number.isSafeInteger(launch?.pid) || launch.pid <= 1 || launch.pid !== native.pid
    || launch.receiptFile !== join(plan.root, 'process.json') || launch.receiptFile !== native.receiptFile
    || launch.planDigest !== digest(plan) || launch.receiptDigest !== sha256(readEvidence(plan.root, 'process.json')))
    throw stale('Cursor original detached launch or receipt differs')
}

function readRequest(plan: NativePlan, execution: CursorStructuredExecution): NativeRequest {
  const request = read<NativeRequest>(plan.root, 'request.json'), native = execution.cursorNative!
  if (request?.planDigest !== digest(plan) || !nonempty(request.sessionId) || !nonempty(request.requestId)
    || request.sessionId !== native.sessionId || request.sessionId !== execution.threadId
    || request.requestId !== native.requestId || request.requestId !== execution.turnId
    || request.reportedModel !== undefined && !nonempty(request.reportedModel))
    throw stale('Cursor original ACP session or prompt request differs')
  return request
}

function stopObservation(root: string, launch: NativeLaunch, hash?: string): string {
  const rows = readEvidence(root, 'process-stop-observations.jsonl').toString('utf8').trimEnd().split('\n')
  const line = hash === undefined ? rows.at(-1) : rows.find(row => sha256(row) === hash)
  let observation: RpcObject | undefined
  try { observation = line ? object(JSON.parse(line)) : undefined }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw stale('Cursor original native stop observation is invalid') }
  if (!line || observation?.boundaryVersion !== 2 || observation.pid !== launch.pid || observation.receiptFile !== launch.receiptFile
    || observation.knownStopped !== true || observation.nativeStopped !== true || !Array.isArray(observation.taskRelatedPending) || observation.taskRelatedPending.length)
    throw stale('Cursor exact native stop observation differs')
  return sha256(line)
}

function closeMatches(exit: Exit | undefined, signalled: boolean): boolean {
  return exit?.code === 0 && exit.signal === null || signalled && (
    exit?.code === 143 && exit.signal === null || exit?.code === null && exit.signal === 'SIGTERM'
  )
}

function readSettledOutput(root: string, prompt: string, execution: CursorStructuredExecution, worktreePath: string): { request: NativeRequest; output: NativeOutput } {
  const plan = read<NativePlan>(root, 'plan.json'), launch = read<NativeLaunch>(root, 'launch.json')
  assertPlan(plan, root, execution, prompt, worktreePath)
  assertLaunch(plan, launch, execution.cursorNative!)
  const request = readRequest(plan, execution), output = read<NativeOutput>(root, 'result.json'), settlement = read<NativeSettlement>(root, 'settlement.json')
  if (settlement?.launchDigest !== digest(launch) || settlement.outputDigest !== digest(output) || !nonempty(settlement.stopDigest)
    || !closeMatches(settlement.exit, settlement.closeDigest !== undefined) || existsSync(join(root, 'cancel.json'))
    || existsSync(join(root, 'close.json')) !== (settlement.closeDigest !== undefined)
    || output?.requestDigest !== digest(request) || output.stopReason !== 'end_turn' || typeof output.text !== 'string'
    || output.reportedModel !== undefined && !nonempty(output.reportedModel))
    throw stale('Cursor settled native terminal or stopped process evidence differs')
  if (settlement.closeDigest !== undefined) {
    const close = read<NativeClose>(root, 'close.json')
    if (close?.launchDigest !== settlement.launchDigest || close.outputDigest !== settlement.outputDigest
      || close.signal !== 'SIGTERM' || digest(close) !== settlement.closeDigest) throw stale('Cursor original ACP server shutdown differs')
  }
  stopObservation(root, launch, settlement.stopDigest)
  return { request, output }
}

function verifyFinal(request: NativeRequest, output: NativeOutput, prompt: string, execution: CursorStructuredExecution): NativeResult {
  const identity = { threadId: request.sessionId, turnId: request.requestId }
  const invalid = (message: string): StructuredSessionError => new StructuredSessionError('structured_output_format_invalid', message, {
    ...identity, rejectedOutput: rejectedFinalOutput(output.text, prompt, execution, identity),
  })
  let value: unknown
  try { value = JSON.parse(output.text) as unknown }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw invalid('Cursor final output is not one complete JSON value') }
  if (!new Ajv({ allErrors: true }).compile(execution.schema)(value)) throw invalid('Cursor final JSON does not match the fixed schema')
  return { ...identity, text: output.text }
}

/** 冷读取复验 Cursor 拒绝输出和对应工作树的停止原件。 */
export function assertCursorRejectedFinalSource(prompt: string, execution: CursorStructuredExecution, worktreePath: string): void {
  if (execution.state !== 'failed' || execution.errorCode !== 'structured_output_format_invalid' || !execution.worktree
    || !execution.cancellation?.nativeStopped || !execution.cursorNative || !execution.rejectedOutput) throw stale('Cursor stopped draft lacks the original rejected worktree turn')
  const { request, output } = readSettledOutput(execution.cursorNative.root, prompt, execution, worktreePath)
  assertRejectedOutput(execution.rejectedOutput, prompt, execution, execution)
  if (execution.rejectedOutput.text !== output.text) throw stale('Cursor stopped draft output differs from its native terminal')
  try { verifyFinal(request, output, prompt, execution) }
  catch (error) { if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') return; throw error }
  throw stale('Cursor stopped draft unexpectedly passes its original schema')
}

function signalOwnedGroup(plan: OwnedLaunch): boolean {
  if (sha256(readEvidence(plan.root, 'process.json')) !== plan.receiptDigest || !verifyDetachedRuntime(plan.pid, plan.receiptFile).ok) return false
  try { process.kill(-plan.pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  return true
}

async function waitForStop(plan: OwnedLaunch, deadline: number, terminate: boolean): Promise<boolean> {
  const receiptMatches = (): boolean => sha256(readEvidence(plan.root, 'process.json')) === plan.receiptDigest
  try {
    if (terminate) {
      if (!receiptMatches()) return false
      const receipt = read<{ startToken: string }>(plan.root, 'process.json')
      const owned = read<Array<{ pid: number; startToken: string }>>(plan.root, 'owned-processes.json')
      if (!Array.isArray(owned) || !owned.some(identity => identity?.pid === plan.pid && identity.startToken === receipt.startToken.replace(/\s+/g, ' '))) return false
    }
    return await waitForNativeWorktreeProcessesStopped(plan, deadline, terminate, receiptMatches)
  } catch (error) {
    if (!(error instanceof StructuredSessionError && ['cancellation_pending', 'stale_result'].includes(error.code))) throw error
  }
  return false
}

const activeInterrupts = new Map<string, () => void>()

export async function stopCursorStructuredTurn(execution: CursorStructuredExecution, timeoutMs = STOP_MS): Promise<StopResult> {
  const deadline = Date.now() + timeoutMs, native = execution.cursorNative
  const noLaunch = !execution.turnStartRequested && !execution.threadId && !execution.turnId && !native?.pid
  const notStarted = { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const unproven = { nativeStopped: false, acknowledged: false, error: 'Cursor exact native process stop remains unproven' }
  if (!native) return noLaunch ? notStarted : unproven
  try {
    const plan = read<NativePlan>(native.root, 'plan.json')
    assertPlan(plan, native.root, execution)
    if (noLaunch && !existsSync(join(native.root, 'launch.json'))) return notStarted
    const launch = read<NativeLaunch>(native.root, 'launch.json')
    assertLaunch(plan, launch, native)
    const owned = { ...plan, ...launch }, launchDigest = digest(launch)
    const live = !detachedRuntimeIsGone(launch.pid, launch.receiptFile)
    if (live || ['cancelling', 'cancelled', 'timeout'].includes(execution.state ?? ''))
      writeEvidence(native.root, 'cancel.json', { launchDigest })
    if (live) {
      activeInterrupts.get(native.root)?.()
      await delay(Math.min(CANCEL_GRACE_MS, Math.max(0, deadline - Date.now())))
      if (Date.now() < deadline && !detachedRuntimeIsGone(launch.pid, launch.receiptFile)) signalOwnedGroup(owned)
    }
    if (!await waitForStop(owned, deadline, true)) return unproven
    let acknowledged = false
    if (existsSync(join(native.root, 'cancel-ack.json'))) {
      const ack = read<{ launchDigest: string; requestDigest: string; stopReason: string }>(native.root, 'cancel-ack.json')
      const cancel = read<{ launchDigest: string }>(native.root, 'cancel.json')
      acknowledged = ack?.launchDigest === launchDigest && cancel?.launchDigest === launchDigest && ack.stopReason === 'cancelled' && ack.requestDigest === digest(readRequest(plan, execution))
    }
    return { nativeStopped: true, acknowledged, nativeStatus: 'stopped' }
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof StructuredSessionError && error.code === 'stale_result') return unproven
    throw error
  }
}

function reportedModel(packet: RpcObject): string | undefined {
  const modelConfig = Array.isArray(packet.configOptions) ? packet.configOptions.map(object).find(option => option?.category === 'model' && option.type === 'select') : undefined
  const value = modelConfig?.currentValue ?? object(packet.models)?.currentModelId
  return nonempty(value) ? value : undefined
}

function permissionResult(params: RpcObject | undefined, plan: NativePlan, sessionId: string | undefined): RpcObject {
  if (params?.sessionId !== sessionId || !sessionId) return { outcome: { outcome: 'cancelled' } }
  const tool = object(params?.toolCall)
  const withinWorktree = (value: unknown): boolean => {
    const path = object(value)?.path
    if (!nonempty(path)) return false
    const fromWorkspace = relative(plan.workspace, resolve(plan.workspace, path))
    return !isAbsolute(fromWorkspace) && fromWorkspace !== '..' && !fromWorkspace.startsWith('../') && fromWorkspace !== '.git' && !fromWorkspace.startsWith('.git/')
  }
  const editable = plan.mode === 'edit' && tool?.kind === 'edit' && Array.isArray(tool.locations) && tool.locations.length > 0 && tool.locations.every(withinWorktree)
  // Commands that Cursor can run in its sandbox do not require a client grant to run outside it.
  const allow = tool?.kind === 'read' || tool?.kind === 'search' || editable
  const option = Array.isArray(params?.options) ? params.options.map(object).find(entry => entry?.kind === (allow ? 'allow_once' : 'reject_once')) : undefined
  return nonempty(option?.optionId) ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }
}

async function observeAcp(stdout: Readable, plan: NativePlan, prompt: string, send: (packet: RpcObject) => void, hooks: {
  onSession(sessionId: string): Promise<void>
  startPrompt(request: NativeRequest): Promise<boolean>
  onTerminal(output: NativeOutput): void
  isInterrupted(): boolean
}): Promise<NativeOutput> {
  const lines = createInterface({ input: stdout, crlfDelay: Infinity }), chunks: string[] = []
  let awaiting: number | string = 1, sessionId: string | undefined, request: NativeRequest | undefined, terminal: NativeOutput | undefined, model: string | undefined
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let packet: RpcObject | undefined
      try { packet = object(JSON.parse(line)) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; throw pending('Cursor ACP stream contains invalid JSON') }
      if (packet?.jsonrpc !== '2.0') throw pending('Cursor ACP stream contains an invalid envelope')
      if (typeof packet.method === 'string') {
        const params = object(packet.params)
        if (typeof packet.id === 'string' || typeof packet.id === 'number') {
          if (packet.method === 'session/request_permission') {
            const outcome = hooks.isInterrupted() || terminal || !request ? { outcome: { outcome: 'cancelled' } } : permissionResult(params, plan, sessionId)
            send({ id: packet.id, result: outcome })
          } else send({ id: packet.id, error: { code: -32601, message: 'Client method unavailable' } })
        } else if (packet.method === 'session/update' && request && params?.sessionId === sessionId) {
          if (terminal) throw pending('Cursor ACP emitted session updates after its original prompt terminal')
          const update = object(params?.update)
          if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') chunks.length = 0
          else if (update?.sessionUpdate === 'agent_message_chunk') {
            const content = object(update.content)
            if (content?.type === 'text') {
              if (typeof content.text !== 'string') throw pending('Cursor ACP assistant text chunk is malformed')
              chunks.push(content.text)
            }
          } else if (update?.sessionUpdate === 'config_option_update') model = reportedModel(update) ?? model
          else if (update?.sessionUpdate === 'current_mode_update' && plan.mode === 'read' && update.currentModeId !== 'ask') {
            throw pending('Cursor ACP read session changed to an unverified mode')
          }
        }
        continue
      }
      if (terminal || packet.id !== awaiting || Object.hasOwn(packet, 'result') === Object.hasOwn(packet, 'error'))
        throw pending('Cursor ACP response differs from its original request')
      const rpcError = object(packet.error), result = object(packet.result)
      if (rpcError?.code === -32000 && typeof rpcError.message === 'string' && /^authentication required[.!]?$/i.test(rpcError.message.trim()))
        throw failed('Cursor CLI authentication is required')
      if (!result) throw failed(typeof awaiting === 'number' ? 'Cursor ACP session could not be started' : 'Cursor ACP prompt returned an error')
      if (awaiting === 1) {
        if (result.protocolVersion !== 1) throw new StructuredSessionError('unsupported', 'Cursor CLI does not negotiate ACP protocol v1')
        awaiting = 2
        send({ id: awaiting, method: 'session/new', params: { cwd: plan.workspace, mcpServers: [] } })
        continue
      }
      if (awaiting === 2) {
        if (!nonempty(result.sessionId)) throw failed('Cursor ACP session/new did not return a session ID')
        sessionId = result.sessionId
        await hooks.onSession(sessionId)
        model = reportedModel(result)
        const modes = object(result.modes)
        if (plan.mode === 'read' && modes?.currentModeId !== 'ask') {
          if (!Array.isArray(modes?.availableModes) || !modes.availableModes.some(mode => object(mode)?.id === 'ask'))
            throw new StructuredSessionError('unsupported', 'Cursor ACP session does not advertise the ask mode')
          if (hooks.isInterrupted()) break
          awaiting = 3
          send({ id: awaiting, method: 'session/set_mode', params: { sessionId, modeId: 'ask' } })
          continue
        }
      }
      if (awaiting === 2 || awaiting === 3) {
        const binding = { planDigest: digest(plan), sessionId: sessionId!, requestId: randomUUID(), ...(model === undefined ? {} : { reportedModel: model }) }
        if (!await hooks.startPrompt(binding) || hooks.isInterrupted()) break
        request = binding
        awaiting = request.requestId
        send({ id: awaiting, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: prompt }] } })
      } else {
        if (!request || !nonempty(result.stopReason)) throw pending('Cursor ACP lacks the original prompt stop reason')
        model = reportedModel(result) ?? model
        terminal = { requestDigest: digest(request), stopReason: result.stopReason, ...(model === undefined ? {} : { reportedModel: model }), text: chunks.join('') }
        hooks.onTerminal(terminal)
      }
    }
  } finally { lines.close() }
  if (!terminal) throw request ? pending('Cursor ACP stream closed without its original prompt terminal') : failed('Cursor ACP closed before prompt dispatch')
  return terminal
}

/** 启动 Cursor ACP 原生会话。已存在的派发只允许读取原结果或精确停止。 */
export async function cursorStructuredTurn(realm: string, id: string, prompt: string, execution: CursorStructuredExecution, callbacks: Callbacks, worktreePath: string | undefined): Promise<NativeResult> {
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.worktree || !worktreePath || execution.frozenContext || execution.readerRuntime || execution.effort)
    throw new StructuredSessionError('unsupported', 'Cursor CLI requires an explicit native worktree request with native CLI effort')
  const model = cursorNativeModel(execution.model), root = join(realm, id)
  if (callbacks.signal?.aborted || execution.cancellation || ['cancelled', 'cancelling', 'timeout'].includes(execution.state ?? '')) throw cancelled(execution.cancellation?.reason === 'timeout' || execution.state === 'timeout')
  if (existsSync(join(root, 'settlement.json'))) {
    const { request, output } = readSettledOutput(root, prompt, execution, worktreePath)
    let result: NativeResult
    try { result = verifyFinal(request, output, prompt, execution) }
    catch (error) {
      if (execution.state === 'completed' && error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw stale('Cursor completed native output no longer matches its frozen schema')
      throw error
    }
    if (execution.state === 'completed' && (execution.output === undefined || execution.resultDigest !== digest(JSON.parse(result.text)) || execution.resultDigest !== digest(execution.output)))
      throw stale('Cursor persisted completed result differs from the original native output')
    return result
  }
  if (execution.state === 'completed') throw stale('Cursor completed result lost its native settlement')
  if (execution.cursorNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(root))
    throw pending('Cursor original dispatch has no settled result; exact stop is required')

  const resolved = spawnSync('/usr/bin/which', ['cursor-agent'], { encoding: 'utf8', timeout: 10_000 })
  if (resolved.status !== 0 || !resolved.stdout.trim()) throw new StructuredSessionError('unsupported', 'Cursor CLI is unavailable')
  const cliPath = realpathSync(resolved.stdout.trim())
  if (realpathSync(worktreePath) !== worktreePath) throw new StructuredSessionError('unsupported', 'Cursor CLI requires the exact physical worktree path')
  const launch = nativeWorktreeLaunch(worktreePath, cliPath, []), args = launchArgs(worktreePath, execution.worktree.mode, model)
  const version = spawnSync(launch.command, [...launch.args, '--version'], { cwd: worktreePath, encoding: 'utf8', timeout: 10_000 })
  const cliVersion = version.stdout?.trim()
  if (version.status !== 0 || !cliVersion) throw new StructuredSessionError('unsupported', 'Cursor CLI did not report a version')

  const native: CursorNativeState = { version: 1, root }
  const promptBytes = nativePrompt(prompt, execution), receiptFile = join(root, 'process.json'), tmp = join(root, 'tmp'), cancelPath = join(root, 'cancel.json')
  const plan: NativePlan = { version: 1, root, workspace: worktreePath, tmp, mode: execution.worktree.mode, cliPath, cliVersion, args, promptDigest: sha256(promptBytes), policyDigest: digest(structuredExecutionPolicy(execution)) }
  mkdirSync(realm, { recursive: true, mode: 0o700 })
  try { mkdirSync(root, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw pending('Cursor original dispatch is already reserved'); throw error }
  mkdirSync(tmp, { mode: 0o700 })
  writeFileSync(join(root, 'prompt.txt'), promptBytes, { mode: 0o400, flag: 'wx' })
  writeEvidence(root, 'plan.json', plan)
  await callbacks.onNative(native)
  await sampleNativeWorktreeProcesses({ ...plan, receiptFile })
  if (callbacks.signal?.aborted) throw cancelled()
  await callbacks.onTurnStarting?.()

  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp }
  for (const key of sessionIdentityEnvVars()) delete env[key]
  // Keep the launch gate separate from ACP stdin. The shell may otherwise read ahead into the first frame.
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready <&3 && [ "$ready" = start ] || exit 1; exec 3<&-; exec "$@"', 'spex-cursor-launch', launch.command, ...launch.args, ...args], { cwd: worktreePath, env, detached: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
  const stdin = child.stdin!, stdout = child.stdout!, gate = child.stdio[3] as Writable
  const closed = new Promise<Exit>(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })))
  let owned: OwnedLaunch | undefined, boundRequest: NativeRequest | undefined
  let normalClose: NativeClose | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined
  let terminalSeen = false, cancelSent = false, interrupted = false, timedOut = false, stopped = false
  let failure: unknown, timeoutFailure: unknown, deadline: number | undefined, expire!: () => void
  let stopTimer: ReturnType<typeof setTimeout> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined
  let census: ReturnType<typeof setInterval> | undefined
  const expiry = new Promise<null>(resolveExpiry => { expire = () => resolveExpiry(null) })
  const armStop = (): void => {
    if (deadline !== undefined) return
    deadline = Date.now() + STOP_MS
    stopTimer = setTimeout(expire, STOP_MS)
  }
  const send = (packet: RpcObject): void => { stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n') }
  const shutdown = (): void => {
    armStop()
    if (!owned || forceTimer) return
    if (boundRequest && !terminalSeen && !stdin.destroyed && !stdin.writableEnded) {
      send({ method: 'session/cancel', params: { sessionId: boundRequest.sessionId } })
      cancelSent = true
    }
    forceTimer = setTimeout(() => {
      try {
        gate.destroy()
        stdin.destroy()
        if (owned) signalOwnedGroup(owned)
      } catch (error) { failure ??= error }
    }, cancelSent ? CANCEL_GRACE_MS : 0)
  }
  const abort = (): void => {
    interrupted = true
    try {
      if (owned && !existsSync(cancelPath)) {
        const launch = read<NativeLaunch>(root, 'launch.json')
        writeEvidence(root, 'cancel.json', { launchDigest: digest(launch) })
      }
    } catch (error) { failure ??= error }
    shutdown()
  }
  const fault = (error: unknown): void => { failure ??= error; shutdown() }
  const observationFault = (error: unknown): void => {
    fault(Object.assign(failed('Cursor periodic native process observation did not recover'), { cause: error }))
  }
  child.once('error', fault); stdin.once('error', fault); gate.once('error', fault)
  activeInterrupts.set(root, abort)
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true
    abort()
    void callbacks.onTimeout?.().catch(error => { timeoutFailure = error })
  })
  const observed = observeAcp(stdout, plan, promptBytes, send, {
    onSession: callbacks.onThread,
    startPrompt: async request => {
      await callbacks.onNative({ ...native, pid: child.pid, receiptFile, sessionId: request.sessionId, requestId: request.requestId })
      await callbacks.onTurn(request.requestId)
      if (interrupted || callbacks.signal?.aborted || existsSync(cancelPath)) return false
      writeEvidence(root, 'request.json', request)
      boundRequest = request
      return true
    },
    isInterrupted: () => interrupted,
    onTerminal: output => {
      terminalSeen = true
      armStop()
      stdin.end()
      // Cursor ACP is a persistent server and can remain alive after the client's EOF.
      closeTimer = setTimeout(() => {
        if (!owned || interrupted || failure) return
        try {
          if (signalOwnedGroup(owned)) {
            const binding = read<NativeLaunch>(root, 'launch.json')
            normalClose = { launchDigest: digest(binding), outputDigest: digest(output), signal: 'SIGTERM' }
            writeEvidence(root, 'close.json', normalClose)
          }
        } catch (error) { fault(error) }
      }, EOF_GRACE_MS)
    },
  }).then(output => output, error => { fault(error); return null })
  try {
    if (!child.pid) throw pending('Cursor launch PID is unavailable')
    try { writeDetachedRuntimeReceipt(child.pid, receiptFile) }
    catch (error) { throw Object.assign(pending('Cursor detached process ownership could not be recorded'), { cause: error }) }
    const binding = { planDigest: digest(plan), pid: child.pid, receiptFile, receiptDigest: sha256(readEvidence(root, 'process.json')) }
    writeEvidence(root, 'launch.json', binding)
    const launched = { ...plan, ...binding }
    await sampleNativeWorktreeProcesses(launched)
    owned = launched
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile })
    if (interrupted || callbacks.signal?.aborted || existsSync(cancelPath)) abort()
    else if (!failure) {
      gate.end('start\n')
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })
    } else shutdown()
    const sample = periodicNativeWorktreeSampler(launched, () => deadline !== undefined, observationFault)
    census = setInterval(() => {
      if (!interrupted && existsSync(cancelPath)) abort()
      sample()
    }, 250)

    const ended = await Promise.race([Promise.all([closed, observed]), expiry])
    armStop()
    if (!ended) throw pending('Cursor native close and process-group stop remain unproven')
    const [exit, output] = ended
    if (interrupted && cancelSent && boundRequest && output?.stopReason === 'cancelled')
      writeEvidence(root, 'cancel-ack.json', { launchDigest: digest(binding), requestDigest: digest(boundRequest), stopReason: output.stopReason })
    const success = !failure && output?.stopReason === 'end_turn' && closeMatches(exit, normalClose !== undefined) && !interrupted
    stopped = await waitForStop(owned, success ? Date.now() + STOP_MS : deadline!, !success || normalClose !== undefined)
    if (!stopped) throw pending('Cursor native close and process-group stop remain unproven')
    if (interrupted || callbacks.signal?.aborted || existsSync(cancelPath)) {
      throw Object.assign(cancelled(timedOut), timeoutFailure === undefined ? {} : { cause: timeoutFailure })
    }
    if (failure) throw failure
    if (!output || !boundRequest) throw pending('Cursor ACP result was not fully observed')
    if (!success) throw failed('Cursor ACP prompt did not complete successfully')
    writeEvidence(root, 'result.json', output)
    writeEvidence(root, 'settlement.json', { launchDigest: digest(binding), outputDigest: digest(output), stopDigest: stopObservation(root, binding), exit, ...(normalClose ? { closeDigest: digest(normalClose) } : {}) } satisfies NativeSettlement)
    return verifyFinal(boundRequest, output, prompt, execution)
  } catch (error) {
    if (!stopped) {
      if (!owned) gate.destroy()
      shutdown()
      const exit = await Promise.race([closed, expiry])
      stopped = !!exit && !!owned && await waitForStop(owned, deadline!, true)
    }
    if (!stopped) throw Object.assign(pending('Cursor native stop remains unproven'), { cause: error })
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(forceTimer); clearTimeout(closeTimer); clearInterval(census)
    activeInterrupts.delete(root)
    callbacks.signal?.removeEventListener('abort', abort)
    gate.destroy(); stdin.destroy(); stdout.destroy(); child.unref()
  }
}
