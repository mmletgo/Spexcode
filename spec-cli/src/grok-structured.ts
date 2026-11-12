import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { NATIVE_PERIODIC_OBSERVATION_FAILURE, nativeWorktreeLaunch, periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { assertRejectedOutput, rejectedFinalOutput, structuredExecutionPolicy, structuredExecutionTimer, StructuredSessionError, type StructuredExecution } from './session-structured-policy.js'

export type GrokNativeState = { version: 1; root: string; sessionId: string; pid?: number; receiptFile?: string; turnId?: string }
export type GrokStructuredExecution = StructuredExecution
type Callbacks = { onNative(state: GrokNativeState): Promise<void>; onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type NativePlan = { version: 1; root: string; sessionId: string; workspace: string; promptDigest: string; policyDigest: string; cliPath: string; cliVersion: string }
type NativeLaunch = { planDigest: string; pid: number; receiptFile: string; receiptDigest: string }
type OwnedLaunch = NativePlan & NativeLaunch
type Terminal = { sessionId: string; requestId: string; cwd: string; stopReason: string; models: string[] }
type NativeOutput = { terminal: Terminal; text: string }
type Exit = { code: number | null; signal: NodeJS.Signals | null }
type NativeSettlement = { launchDigest: string; outputDigest: string; stopDigest: string; exit: Exit }
type StopResult = { nativeStopped: boolean; acknowledged: false; nativeStatus?: string; error?: string }

const STOP_MS = 15_000
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const digest = (value: unknown): string => sha256(JSON.stringify(value))
const pending = (message: string): StructuredSessionError => new StructuredSessionError('cancellation_pending', message)
const stale = (message: string): StructuredSessionError => new StructuredSessionError('stale_result', message)
const cancelled = (timedOut = false): StructuredSessionError => new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', timedOut ? 'Grok native turn timed out' : 'Grok native turn cancelled')

function readEvidence(root: string, name: string): Buffer {
  try { return readFileSync(join(root, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw stale('Grok original native evidence is missing'); throw error }
}

function read<T>(root: string, name: string): T {
  try { return JSON.parse(readEvidence(root, name).toString('utf8')) as T }
  catch (error) { if (error instanceof SyntaxError) throw stale('Grok original native evidence is invalid'); throw error }
}

function writeEvidence(root: string, name: string, value: unknown): void {
  const temporary = join(root, `.${name}.${randomUUID()}`)
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o400, flag: 'wx' })
  renameSync(temporary, join(root, name))
}

export function grokNativeModel(model: string | undefined): string | undefined {
  if (!model?.startsWith('grok:') || !model.slice(5).trim() || model.includes('\0'))
    throw new StructuredSessionError('unsupported', 'Grok Build requires grok:<model> or grok:default')
  return model === 'grok:default' ? undefined : model.slice(5)
}

const nativePrompt = (prompt: string, execution: GrokStructuredExecution): string =>
  `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}`

function assertPlan(plan: NativePlan, root: string, execution: GrokStructuredExecution, prompt?: string, worktreePath?: string): void {
  const native = execution.grokNative
  if (plan?.version !== 1 || native?.version !== 1 || plan.root !== root || native.root !== root || plan.sessionId !== native.sessionId
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== native.turnId || worktreePath !== undefined && worktreePath !== plan.workspace
    || plan.policyDigest !== digest(structuredExecutionPolicy(execution)) || !plan.cliPath || !plan.cliVersion
    || prompt !== undefined && (plan.promptDigest !== sha256(nativePrompt(prompt, execution)) || plan.promptDigest !== sha256(readEvidence(root, 'prompt.txt'))))
    throw stale('Grok original worktree, prompt, policy or session binding differs')
}

function assertLaunch(plan: NativePlan, launch: NativeLaunch, execution: GrokStructuredExecution): void {
  if (!Number.isSafeInteger(launch?.pid) || launch.pid <= 1 || launch.pid !== execution.grokNative?.pid
    || launch.receiptFile !== join(plan.root, 'process.json') || launch.receiptFile !== execution.grokNative.receiptFile
    || launch.planDigest !== digest(plan) || launch.receiptDigest !== sha256(readEvidence(plan.root, 'process.json')))
    throw stale('Grok original detached launch or receipt differs')
}

function terminalMatches(terminal: Terminal, plan: NativePlan): boolean {
  return terminal.sessionId === plan.sessionId && terminal.cwd === plan.workspace && typeof terminal.requestId === 'string' && !!terminal.requestId.trim()
    && typeof terminal.stopReason === 'string' && !!terminal.stopReason && Array.isArray(terminal.models)
    && terminal.models.every(model => typeof model === 'string' && !!model.trim())
}

async function observeNativeOutput(stdout: Readable, plan: NativePlan, onEnd: () => void): Promise<NativeOutput> {
  const lines = createInterface({ input: stdout, crlfDelay: Infinity })
  const chunks: string[] = []
  let terminal: Terminal | undefined
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let event: Record<string, unknown>
      try { event = JSON.parse(line) as Record<string, unknown> }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; throw pending('Grok native event is not valid JSON') }
      if (terminal || typeof event?.type !== 'string') throw pending('Grok native stream has an invalid event or data after its terminal')
      if (event.type === 'tool_call' || event.type === 'tool_call_update') chunks.length = 0
      else if (event.type === 'text') {
        if (typeof event.data !== 'string') throw pending('Grok native text event has an invalid shape')
        chunks.push(event.data)
      } else if (event.type === 'end') {
        const models = event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage) ? Object.keys(event.modelUsage) : []
        terminal = { sessionId: event.sessionId as string, requestId: event.requestId as string, cwd: event.cwd as string, stopReason: event.stopReason as string, models }
        if (!terminalMatches(terminal, plan) || terminal.stopReason === 'end_turn' && !models.length) throw pending('Grok native terminal lacks the original session, worktree, request or actual model identity')
        onEnd()
      }
    }
  } finally { lines.close() }
  if (!terminal) throw pending('Grok native stream closed without its original terminal')
  return { terminal, text: chunks.join('') }
}

function verifyFinal(native: NativeOutput, prompt: string, execution: GrokStructuredExecution): NativeResult {
  const identity = { threadId: native.terminal.sessionId, turnId: native.terminal.requestId }
  let output: unknown
  const invalid = (message: string): StructuredSessionError => new StructuredSessionError('structured_output_format_invalid', message, {
    ...identity, rejectedOutput: rejectedFinalOutput(native.text, prompt, execution, identity),
  })
  try { output = JSON.parse(native.text) as unknown }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; throw invalid('Grok final output is not one complete JSON value') }
  if (!new Ajv({ allErrors: true }).compile(execution.schema)(output)) throw invalid('Grok final JSON does not match the fixed schema')
  return { ...identity, text: native.text }
}

function stopObservation(root: string, launch: NativeLaunch, hash?: string): string {
  const rows = readEvidence(root, 'process-stop-observations.jsonl').toString('utf8').trimEnd().split('\n')
  const line = hash === undefined ? rows.at(-1) : rows.find(row => sha256(row) === hash)
  const observation = line ? JSON.parse(line) as { boundaryVersion?: number; pid?: number; receiptFile?: string; knownStopped?: boolean; nativeStopped?: boolean; taskRelatedPending?: unknown[] } : null
  if (!line || observation?.boundaryVersion !== 2 || observation.pid !== launch.pid || observation.receiptFile !== launch.receiptFile
    || observation.knownStopped !== true || observation.nativeStopped !== true || !Array.isArray(observation.taskRelatedPending) || observation.taskRelatedPending.length)
    throw stale('Grok exact native stop observation differs')
  return sha256(line)
}

function readSettledOutput(root: string, prompt: string, execution: GrokStructuredExecution, worktreePath: string): NativeOutput {
  const plan = read<NativePlan>(root, 'plan.json'), launch = read<NativeLaunch>(root, 'launch.json')
  assertPlan(plan, root, execution, prompt, worktreePath)
  assertLaunch(plan, launch, execution)
  const output = read<NativeOutput>(root, 'result.json'), settlement = read<NativeSettlement>(root, 'settlement.json')
  if (settlement?.launchDigest !== digest(launch) || settlement.outputDigest !== digest(output) || typeof settlement.stopDigest !== 'string'
    || settlement.exit?.code !== 0 || settlement.exit.signal !== null || existsSync(join(root, 'cancel.json'))
    || !output?.terminal || !terminalMatches(output.terminal, plan) || output.terminal.stopReason !== 'end_turn' || !output.terminal.models.length
    || output.terminal.requestId !== execution.turnId || output.terminal.requestId !== execution.grokNative?.turnId
    || output.terminal.sessionId !== execution.threadId || typeof output.text !== 'string')
    throw stale('Grok settled native terminal or stopped process evidence differs')
  stopObservation(root, launch, settlement.stopDigest)
  return output
}

/** 冷读取核对原生拒绝结果和停止证明。 */
export function assertGrokRejectedFinalSource(prompt: string, execution: GrokStructuredExecution, worktreePath: string): void {
  if (execution.state !== 'failed' || execution.errorCode !== 'structured_output_format_invalid' || !execution.worktree
    || !execution.cancellation?.nativeStopped || !execution.grokNative || !execution.rejectedOutput) throw stale('Grok stopped draft lacks the original rejected worktree turn')
  const native = readSettledOutput(execution.grokNative.root, prompt, execution, worktreePath)
  assertRejectedOutput(execution.rejectedOutput, prompt, execution, execution)
  if (execution.rejectedOutput.text !== native.text) throw stale('Grok stopped draft output differs from its native terminal')
  try { verifyFinal(native, prompt, execution) }
  catch (error) { if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') return; throw error }
  throw stale('Grok stopped draft unexpectedly passes its original schema')
}

function signalOwnedGroup(plan: OwnedLaunch): boolean {
  if (sha256(readFileSync(plan.receiptFile)) !== plan.receiptDigest || !verifyDetachedRuntime(plan.pid, plan.receiptFile).ok) return false
  try { process.kill(-plan.pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false }
  return true
}

async function waitForStop(plan: OwnedLaunch, deadline: number, terminate: boolean): Promise<boolean> {
  try {
    return await waitForNativeWorktreeProcessesStopped(plan, deadline, terminate, () => sha256(readFileSync(plan.receiptFile)) === plan.receiptDigest)
  } catch (error) {
    if (!(error instanceof StructuredSessionError && error.code === 'cancellation_pending') && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return false
}

export async function stopGrokStructuredTurn(execution: GrokStructuredExecution, timeoutMs = STOP_MS): Promise<StopResult> {
  const deadline = Date.now() + timeoutMs, native = execution.grokNative
  const noLaunch = !execution.turnStartRequested && !execution.threadId && !execution.turnId && !native?.pid
  const notStarted = { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' } as const
  const unproven = { nativeStopped: false, acknowledged: false, error: 'Grok exact native process stop remains unproven' } as const
  if (!native) return noLaunch ? notStarted : unproven
  try {
    const plan = read<NativePlan>(native.root, 'plan.json')
    assertPlan(plan, native.root, execution)
    if (noLaunch && !existsSync(join(native.root, 'launch.json'))) return notStarted
    const launch = read<NativeLaunch>(native.root, 'launch.json')
    assertLaunch(plan, launch, execution)
    const owned = { ...plan, ...launch }
    if (Date.now() >= deadline) return unproven
    const live = !detachedRuntimeIsGone(launch.pid, launch.receiptFile)
    if (live && !verifyDetachedRuntime(launch.pid, launch.receiptFile).ok) return unproven
    if (live || execution.state === 'cancelling' || execution.state === 'cancelled' || execution.state === 'timeout')
      writeEvidence(native.root, 'cancel.json', { launchDigest: digest(launch) })
    if (live) signalOwnedGroup(owned)
    return await waitForStop(owned, deadline, true) ? { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } : unproven
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof StructuredSessionError && error.code === 'stale_result' || (error as NodeJS.ErrnoException).code === 'ENOENT') return unproven
    throw error
  }
}

/** 仅在独立进程组已登记后放行同一 PID exec Grok，避免先执行任务再追认所有权。 */
export async function grokStructuredTurn(realm: string, id: string, prompt: string, execution: GrokStructuredExecution, callbacks: Callbacks, worktreePath: string | undefined): Promise<NativeResult> {
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.worktree || !worktreePath || execution.frozenContext || execution.readerRuntime || execution.effort)
    throw new StructuredSessionError('unsupported', 'Grok Build requires an explicit native worktree request with native CLI effort')
  const model = grokNativeModel(execution.model), root = join(realm, id)
  if (callbacks.signal?.aborted || execution.cancellation || ['cancelled', 'cancelling', 'timeout'].includes(execution.state ?? '')) throw cancelled(execution.cancellation?.reason === 'timeout' || execution.state === 'timeout')
  if (existsSync(join(root, 'settlement.json'))) {
    const native = readSettledOutput(root, prompt, execution, worktreePath)
    let result: NativeResult
    try { result = verifyFinal(native, prompt, execution) }
    catch (error) {
      if (execution.state === 'completed' && error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') throw stale('Grok completed native output no longer matches its frozen schema')
      throw error
    }
    if (execution.state === 'completed' && (execution.output === undefined || execution.resultDigest !== digest(JSON.parse(result.text)) || execution.resultDigest !== digest(execution.output)))
      throw stale('Grok persisted completed result differs from the original native output')
    return result
  }
  if (execution.state === 'completed') throw stale('Grok completed result lost its native settlement')
  if (execution.grokNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(root))
    throw pending('Grok original dispatch has no settled result; exact stop is required')

  const resolved = spawnSync('/usr/bin/which', ['grok'], { encoding: 'utf8', timeout: 10_000 })
  if (resolved.status !== 0 || !resolved.stdout.trim()) throw new StructuredSessionError('unsupported', 'Grok Build CLI is unavailable')
  const cliPath = realpathSync(resolved.stdout.trim())
  if (realpathSync(worktreePath) !== worktreePath) throw new StructuredSessionError('unsupported', 'Grok Build requires the exact physical worktree path')
  const launch = nativeWorktreeLaunch(worktreePath, cliPath, [])
  const version = spawnSync(launch.command, [...launch.args, '--version'], { cwd: worktreePath, encoding: 'utf8', timeout: 10_000 })
  const cliVersion = version.stdout?.trim()
  if (version.status !== 0 || !cliVersion) throw new StructuredSessionError('unsupported', 'Grok Build CLI did not report a version')

  const native = { version: 1 as const, root, sessionId: randomUUID() }
  const promptPath = join(root, 'prompt.txt'), promptBytes = nativePrompt(prompt, execution), receiptFile = join(root, 'process.json'), tmp = join(root, 'tmp')
  const plan: NativePlan = { ...native, workspace: worktreePath, cliPath, cliVersion, promptDigest: sha256(promptBytes), policyDigest: digest(structuredExecutionPolicy(execution)) }
  const args = ['--cwd', worktreePath, '--session-id', native.sessionId, '--prompt-file', promptPath, '--output-format', 'streaming-json',
    ...(execution.worktree.mode === 'read' ? ['--permission-mode', 'plan', '--disallowed-tools', 'enter_plan_mode,exit_plan_mode'] : ['--permission-mode', 'bypassPermissions']),
    ...(model === undefined ? [] : ['--model', model])]
  mkdirSync(realm, { recursive: true, mode: 0o700 })
  try { mkdirSync(root, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw pending('Grok original dispatch is already reserved'); throw error }
  mkdirSync(tmp, { mode: 0o700 })
  writeFileSync(promptPath, promptBytes, { mode: 0o400, flag: 'wx' })
  writeEvidence(root, 'plan.json', plan)
  await callbacks.onNative(native)
  await sampleNativeWorktreeProcesses({ ...plan, receiptFile })
  if (callbacks.signal?.aborted) throw cancelled()
  await callbacks.onTurnStarting?.()

  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp }
  for (const key of sessionIdentityEnvVars()) delete env[key]
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready && [ "$ready" = start ] || exit 1; exec "$@"', 'spex-grok-launch', launch.command, ...launch.args, ...args], { cwd: worktreePath, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  const closed = new Promise<Exit>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  let processFailed = false
  child.once('error', () => { processFailed = true })
  child.stdin.once('error', () => { processFailed = true })
  let owned: OwnedLaunch | undefined
  let deadline: number | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined
  let census: ReturnType<typeof setInterval> | undefined
  let timedOut = false, observerFailure: unknown, timeoutFailure: unknown
  let expire!: () => void
  const expiry = new Promise<null>(resolve => { expire = () => resolve(null) })
  const armStop = (): void => {
    if (deadline !== undefined) return
    deadline = Date.now() + STOP_MS
    clearInterval(census)
    stopTimer = setTimeout(expire, STOP_MS)
  }
  const interrupt = (): void => {
    armStop()
    child.stdin.destroy()
    if (owned) signalOwnedGroup(owned)
  }
  const abort = (): void => { try { interrupt() } catch (error) { observerFailure ??= error } }
  const observed = observeNativeOutput(child.stdout, plan, armStop).then(output => output, error => {
    observerFailure ??= error
    abort()
    return null
  })
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true
    abort()
    void callbacks.onTimeout?.().catch(error => { timeoutFailure = error })
  })
  let stopped = false
  try {
    if (!child.pid) throw pending('Grok launch PID is unavailable')
    try { writeDetachedRuntimeReceipt(child.pid, receiptFile) }
    catch (error) { throw Object.assign(pending('Grok detached process ownership could not be recorded'), { cause: error }) }
    const binding = { planDigest: digest(plan), pid: child.pid, receiptFile, receiptDigest: sha256(readFileSync(receiptFile)) }
    owned = { ...plan, ...binding }
    writeEvidence(root, 'launch.json', binding)
    const running = { ...native, pid: binding.pid, receiptFile }
    await callbacks.onNative(running)
    await sampleNativeWorktreeProcesses(owned)
    if (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json'))) abort()
    else child.stdin.end('start\n')
    if (deadline === undefined) census = setInterval(periodicNativeWorktreeSampler(owned, () => deadline !== undefined, error => {
      observerFailure ??= Object.assign(new StructuredSessionError('failed', NATIVE_PERIODIC_OBSERVATION_FAILURE.grok), { cause: error })
      abort()
    }), 250)
    const ended = await Promise.race([Promise.all([closed, observed]), expiry])
    armStop()
    if (!ended) throw pending('Grok native close and process-group stop remain unproven')
    clearTimeout(stopTimer)
    const [exit, output] = ended
    const interrupted = callbacks.signal?.aborted === true || timedOut
    const successfulExit = !observerFailure && !processFailed && output?.terminal.stopReason === 'end_turn' && exit.code === 0 && exit.signal === null
    const stopDeadline = successfulExit && !interrupted ? Date.now() + STOP_MS : deadline!
    stopped = await waitForStop(owned, stopDeadline, interrupted)
    if (!stopped) throw pending('Grok native close and process-group stop remain unproven')
    if (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json'))) throw Object.assign(cancelled(timedOut), timeoutFailure === undefined ? {} : { cause: timeoutFailure })
    if (observerFailure) throw observerFailure
    if (processFailed || !output) throw pending('Grok native result was not fully observed')
    if (output.terminal.stopReason !== 'end_turn' || exit.code !== 0 || exit.signal !== null) throw new StructuredSessionError('failed', 'Grok native turn did not complete successfully')
    const turnId = output.terminal.requestId
    await callbacks.onThread(native.sessionId)
    await callbacks.onNative({ ...running, turnId })
    await callbacks.onTurn(turnId)
    if (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json'))) throw cancelled(timedOut)
    writeEvidence(root, 'result.json', output)
    writeEvidence(root, 'settlement.json', { launchDigest: digest(binding), outputDigest: digest(output), stopDigest: stopObservation(root, binding), exit } satisfies NativeSettlement)
    return verifyFinal(output, prompt, execution)
  } catch (error) {
    if (!stopped) {
      abort()
      const exit = await Promise.race([closed, expiry])
      stopped = !!exit && !!owned && await waitForStop(owned, deadline!, true)
    }
    if (!stopped) throw Object.assign(pending('Grok native stop remains unproven'), { cause: error })
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(stopTimer); clearInterval(census)
    callbacks.signal?.removeEventListener('abort', abort)
    child.stdin.destroy(); child.stdout.destroy(); child.unref()
  }
}
