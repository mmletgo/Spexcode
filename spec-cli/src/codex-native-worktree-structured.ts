import { loadManagerNativeRuntime } from './llm-manager-host.js'
import { codexReplay } from '../llm-manager/native-runtime.mjs'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import type { CodexStructuredStop } from './codex-harness.js'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { assertRejectedOutput, rejectedFinalOutput, StructuredSessionError, structuredExecutionTimer, type NativeTokenUsage, type StructuredExecution } from './session-structured-policy.js'
import { nativeModelValue } from './llm-manager-route.js'

export type NativeCodexWorktreeState = {
  version: 1; root: string; planDigest: string; pid?: number; receiptFile?: string
  threadId?: string; turnId?: string; proofDigest?: string
}
type Execution = StructuredExecution & { codexNative?: NativeCodexWorktreeState }
type Callbacks = {
  onNative(state: NativeCodexWorktreeState): Promise<void>; onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>
  onTurnStarting?(): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal
}
type NativeResult = { threadId: string; turnId: string; text: string; nativeTokenUsage?: NativeTokenUsage; frozenReadProof?: never }
type Plan = { root: string; workspace: string; tmp: string; policyDigest: string; promptDigest: string; model?: string }
type Launch = { planDigest: string; pid: number; receiptFile: string; receiptDigest: string }
type OwnedLaunch = Plan & Launch
type Identity = { threadId: string; turnId: string }
type Final = { threadId: string; turnId: string; status: 'completed'; itemId: string; text: string; tokenUsage?: Packet }
type Proof = { launchDigest: string; thread: { id: string; cwd: string; model: string; cliVersion: string }; final: Final; stopDigest: string }
type Packet = Record<string, unknown>
type Exit = { code: number | null; signal: NodeJS.Signals | null }

type NativePermissions = { name: string; writableRoots: string[]; shellPath?: string }
type NativeThreadOptions = { workspace: string; model?: string; permissions?: NativePermissions }
type CodexAdapter = {
  CodexNativeProtocolError: new (...args: never[]) => Error & { code: 'failed' | 'unsupported' | 'cancelled' | 'provider_quota_exhausted' }
  codexNativeModel(selection?: string): string | undefined
  codexNativeWorktreeArgs(root: string, tmp: string): string[]
  codexNativeTokenUsage(total?: Packet): NativeTokenUsage | undefined
  CodexNativeAppServer: new (input: Writable, output: Readable) => {
    readonly failure?: Error
    fail(cause: unknown): void
    initialize(clientName: string, version: string): Promise<void>
    startThread(options: NativeThreadOptions & { beforeStart?: () => void }): Promise<Proof['thread']>
    startTurn(options: NativeThreadOptions & { prompt: string; schema: Packet; effort?: string }): Promise<string>
    waitForTerminal(): Promise<void>
    interrupt(): Promise<Identity | undefined>
    readFinal(): Final
  }
}

const { codexNativeModel, codexNativeTokenUsage } = codexReplay as Pick<CodexAdapter, 'codexNativeModel' | 'codexNativeTokenUsage'>
const STOP_MS = 15_000
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const digest = (value: unknown): string => sha(JSON.stringify(value))
const read = <T>(root: string, name: string): T => {
  const value: unknown = JSON.parse(readFileSync(join(root, name), 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SyntaxError('Codex native evidence is not an object')
  return value as T
}
const write = (root: string, name: string, value: unknown): void => writeFileSync(join(root, name), JSON.stringify(value), { flag: 'wx', mode: 0o400 })
const object = (value: unknown): Packet => value && typeof value === 'object' && !Array.isArray(value) ? value as Packet : {}
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const pending = (message: string) => new StructuredSessionError('cancellation_pending', message)
const stale = (message: string) => new StructuredSessionError('stale_result', message)
const failed = (message: string) => new StructuredSessionError('failed', message)
const policyDigest = ({ version, policy, schema, inputDigest, purpose, timeoutMs, model, effort, worktree, nativeConfiguration }: Execution): string =>
  digest({ version, policy, schema, inputDigest, purpose, timeoutMs, model, effort, worktree, nativeConfiguration })

function assertPlan(plan: Plan, execution: Execution, native: NativeCodexWorktreeState): void {
  if (native.version !== 1 || plan.root !== native.root || plan.tmp !== join(plan.root, 'tmp')
    || plan.policyDigest !== policyDigest(execution) || digest(plan) !== native.planDigest)
    throw stale('Codex worktree plan differs from the fixed execution')
}

function ownedLaunch(plan: Plan, native: NativeCodexWorktreeState): OwnedLaunch {
  const launch = read<Launch>(plan.root, 'launch.json')
  if (!Number.isInteger(launch.pid) || launch.pid <= 0 || launch.planDigest !== native.planDigest
    || launch.receiptFile !== join(plan.root, 'process.json')
    || launch.receiptDigest !== sha(readFileSync(launch.receiptFile))
    || native.pid !== undefined && (native.pid !== launch.pid || native.receiptFile !== launch.receiptFile))
    throw stale('Codex worktree detached launch identity differs')
  return { ...plan, ...launch }
}

function stopDigest(plan: OwnedLaunch, expected?: string): string {
  const observations = readFileSync(join(plan.root, 'process-stop-observations.jsonl'), 'utf8').trimEnd().split('\n')
  const line = expected ? observations.find(row => sha(row) === expected) : observations.at(-1)
  const observed = line ? object(JSON.parse(line)) : {}
  if (!line || observed.boundaryVersion !== 2 || observed.pid !== plan.pid || observed.receiptFile !== plan.receiptFile
    || observed.knownStopped !== true || observed.nativeStopped !== true
    || !Array.isArray(observed.taskRelatedPending) || observed.taskRelatedPending.length)
    throw stale('Codex worktree process stop observation differs')
  return sha(line)
}

function resultFromFinal(final: Final, prompt: string, execution: Execution, nativeTokenUsage: NativeTokenUsage | undefined): NativeResult {
  const reject = (message: string) => new StructuredSessionError('structured_output_format_invalid', message, {
    threadId: final.threadId, turnId: final.turnId, nativeTokenUsage,
    rejectedOutput: rejectedFinalOutput(final.text, prompt, execution, final),
  })
  let output: unknown
  try { output = JSON.parse(final.text) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw reject('Codex final answer is not JSON')
  }
  if (!new Ajv({ allErrors: true }).compile(execution.schema)(output))
    throw reject('Codex final answer does not match the fixed schema')
  if (execution.state === 'completed' && (execution.resultDigest !== digest(output) || digest(execution.output) !== digest(output)
    || digest(execution.nativeTokenUsage ?? null) !== digest(nativeTokenUsage ?? null)))
    throw stale('Codex persisted result differs from its original final')
  return { threadId: final.threadId, turnId: final.turnId, text: final.text, ...(nativeTokenUsage ? { nativeTokenUsage } : {}) }
}

function readFinalProof(root: string, prompt: string, execution: Execution, workspace: string, nativeModel: string | undefined): Final {
  const native = execution.codexNative
  if (!native || native.root !== root || !native.proofDigest || !native.threadId || !native.turnId || !native.pid)
    throw stale('Codex completed execution has no exact native settlement')
  try {
    const plan = read<Plan>(root, 'plan.json')
    assertPlan(plan, execution, native)
    const launch = ownedLaunch(plan, native)
    const proof = read<Proof>(root, 'settlement.json')
    if (plan.workspace !== workspace || plan.promptDigest !== sha(prompt) || plan.model !== nativeModel
      || digest(proof) !== native.proofDigest || proof.launchDigest !== digest(read<Launch>(root, 'launch.json'))
      || proof.thread.id !== native.threadId || proof.thread.cwd !== workspace || !string(proof.thread.model) || !string(proof.thread.cliVersion)
      || nativeModel !== undefined && proof.thread.model !== nativeModel
      || proof.final.threadId !== native.threadId || proof.final.turnId !== native.turnId || execution.threadId !== native.threadId
      || execution.turnId !== native.turnId || proof.final.status !== 'completed' || !string(proof.final.itemId) || !string(proof.final.text)
      || existsSync(join(root, 'cancel.json')))
      throw stale('Codex worktree terminal evidence differs from the fixed turn')
    stopDigest(launch, proof.stopDigest)
    return proof.final
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      throw stale('Codex original native settlement is unavailable or invalid')
    throw error
  }
}

export function assertCodexRejectedFinalSource(session: string, prompt: string, execution: Execution, workspace: string): void {
  const native = execution.codexNative, original = execution.rejectedOutput
  if (execution.state !== 'failed' || execution.errorCode !== 'structured_output_format_invalid' || !execution.cancellation?.nativeStopped
    || !native || basename(native.root) !== session || !original)
    throw stale('Codex stopped draft lacks its original rejected worktree turn')
  const model = codexNativeModel(nativeModelValue(execution.model, 'codex'))
  const final = readFinalProof(native.root, prompt, execution, workspace, model)
  assertRejectedOutput(original, prompt, execution, execution)
  if (original.text !== final.text) throw stale('Codex rejected draft differs from its native terminal')
  try { resultFromFinal(final, prompt, execution, codexNativeTokenUsage(final.tokenUsage)) }
  catch (error) { if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') return; throw error }
  throw stale('Codex rejected draft unexpectedly passes its original schema')
}

function signalGroup(launch: OwnedLaunch): void {
  if (!verifyDetachedRuntime(launch.pid, launch.receiptFile).ok) return
  try { process.kill(-launch.pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
}

const active = new Map<string, { interrupt(): Promise<void>; planDigest: string }>()
const launchMatches = (launch: OwnedLaunch): boolean => sha(readFileSync(launch.receiptFile)) === launch.receiptDigest

/** The ephemeral native runtime has no shared Codex generation to archive. */
export async function codexNativeWorktreeIsStopped(session: string, threadId: string | null | undefined, execution: Execution): Promise<boolean> {
  if (!execution.state || !['completed', 'failed', 'cancelled', 'timeout'].includes(execution.state)) return false
  if ((threadId ?? undefined) !== execution.threadId) return false
  const native = execution.codexNative
  const notStarted = !execution.turnStartRequested && !execution.threadId && !execution.turnId && !native?.pid
  if (!native) return notStarted
  if (basename(native.root) !== session) return false
  try {
    const plan = read<Plan>(native.root, 'plan.json')
    assertPlan(plan, execution, native)
    if (!existsSync(join(native.root, 'launch.json'))) return notStarted
    if (native.threadId !== execution.threadId || native.turnId !== execution.turnId) return false
    const launch = ownedLaunch(plan, native)
    if (!detachedRuntimeIsGone(launch.pid, launch.receiptFile)) return false
    return await waitForNativeWorktreeProcessesStopped(launch, Date.now() + STOP_MS, false, () => launchMatches(launch))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof StructuredSessionError
      && (error.code === 'stale_result' || error.code === 'cancellation_pending')) return false
    throw error
  }
}

export async function stopCodexNativeWorktreeTurn(execution: Execution, timeoutMs = STOP_MS): Promise<CodexStructuredStop> {
  const native = execution.codexNative, deadline = Date.now() + timeoutMs
  const notStarted = { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const unproven = { nativeStopped: false, acknowledged: false, error: 'Codex exact native worktree process stop remains unproven' }
  if (!native) return !execution.turnStartRequested && !execution.threadId && !execution.turnId ? notStarted : unproven
  try {
    const plan = read<Plan>(native.root, 'plan.json')
    assertPlan(plan, execution, native)
    if (!existsSync(join(native.root, 'launch.json')))
      return !execution.turnStartRequested && !native.pid && !execution.threadId && !execution.turnId ? notStarted : unproven
    const launch = ownedLaunch(plan, native)
    if (execution.threadId !== undefined && native.threadId !== execution.threadId || execution.turnId !== undefined && native.turnId !== execution.turnId) return unproven
    const cancelFile = join(native.root, 'cancel.json')
    const cancellation = execution.state !== 'completed' && (execution.state === 'cancelling' || execution.cancellation !== undefined)
    if (cancellation && !existsSync(cancelFile)) write(native.root, 'cancel.json', { planDigest: native.planDigest })
    const connection = active.get(native.root)
    if (connection?.planDigest === native.planDigest) {
      void connection.interrupt()
      await delay(Math.min(1_000, Math.max(0, deadline - Date.now())))
    }
    if (Date.now() >= deadline || !launchMatches(launch)) return unproven
    signalGroup(launch)
    if (!await waitForNativeWorktreeProcessesStopped(launch, deadline, true, () => launchMatches(launch))) return unproven
    const ackPath = join(native.root, 'interrupt.json')
    const ack = existsSync(ackPath) ? read<Identity & { planDigest: string }>(native.root, 'interrupt.json') : undefined
    const acknowledged = !!ack && ack.planDigest === native.planDigest && ack.threadId === native.threadId && ack.turnId === native.turnId
    return { nativeStopped: true, acknowledged, nativeStatus: 'stopped', ...(native.turnId ? { turnId: native.turnId } : {}) }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof StructuredSessionError && error.code === 'stale_result') return unproven
    throw error
  }
}

function editPermissions(workspace: string, tmp: string): NativePermissions {
  const git = (...args: string[]): string => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim()
  const gitDir = realpathSync(git('rev-parse', '--absolute-git-dir')), common = realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
  const ref = git('symbolic-ref', 'HEAD')
  if (gitDir === common || !ref.startsWith('refs/heads/'))
    throw new StructuredSessionError('unsupported', 'Codex edit worktree requires an independent linked Git branch')
  const name = `spex-native-${randomUUID()}`
  const branchRef = join(common, ref)
  const roots = [workspace, tmp, gitDir, join(common, 'objects'), branchRef, branchRef + '.lock', join(common, 'logs', ref)]
  const appleGit = process.platform === 'darwin' && execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim() === '/usr/bin/git'
  // The Apple Git shim can invoke xcodebuild, which writes global developer caches before running Git.
  const devTools = appleGit ? dirname(execFileSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim()) : undefined
  return { name, writableRoots: roots, ...(devTools ? { shellPath: `${devTools}${delimiter}${process.env.PATH}` } : {}) }
}

export async function codexNativeWorktreeTurn(realm: string, id: string, prompt: string, execution: Execution, callbacks: Callbacks, workspace: string | undefined, modelSelection?: string): Promise<NativeResult> {
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || execution.nativeConfiguration !== 'cli-config-v1'
    || !execution.worktree || !workspace || execution.frozenContext || execution.readerRuntime)
    throw new StructuredSessionError('unsupported', 'Codex CLI requires the native worktree policy')
  const root = join(realm, id)
  if (callbacks.signal?.aborted || execution.cancellation || ['cancelled', 'cancelling', 'timeout'].includes(execution.state ?? ''))
    throw new StructuredSessionError(execution.cancellation?.reason ?? (execution.state === 'timeout' ? 'timeout' : 'cancelled'), 'Codex worktree turn was cancelled')
  if (execution.state === 'completed') {
    try {
      const final = readFinalProof(root, prompt, execution, workspace, codexNativeModel(modelSelection))
      return resultFromFinal(final, prompt, execution, codexNativeTokenUsage(final.tokenUsage))
    }
    catch (error) {
      if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid')
        throw stale('Codex completed state cannot replay a rejected native final')
      throw error
    }
  }
  if (execution.codexNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(root))
    throw pending('Codex original worktree dispatch has no settled result; exact stop is required')
  if (realpathSync(workspace) !== workspace) throw stale('Codex requires the physical worktree path')
  const runtime = await loadManagerNativeRuntime()
  const provider = await runtime.loadNativeAdapter('codex') as CodexAdapter
  const nativeModel = provider.codexNativeModel(modelSelection)
  const tmp = join(root, 'tmp'), receiptFile = join(root, 'process.json')
  const plan: Plan = { root, workspace, tmp, policyDigest: policyDigest(execution), promptDigest: sha(prompt), ...(nativeModel ? { model: nativeModel } : {}) }
  const permissions = execution.worktree.mode === 'edit' ? editPermissions(workspace, tmp) : undefined
  const cli = runtime.findNativeExecutable('codex')
  if (!cli) throw new StructuredSessionError('unsupported', 'Codex CLI is unavailable')
  const args = provider.codexNativeWorktreeArgs(root, tmp)
  mkdirSync(realm, { recursive: true, mode: 0o700 })
  try { mkdirSync(root, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw pending('Codex worktree dispatch is already reserved'); throw error }
  mkdirSync(tmp, { mode: 0o700 })
  const native: NativeCodexWorktreeState = { version: 1, root, planDigest: digest(plan) }
  write(root, 'plan.json', plan)
  await callbacks.onNative({ ...native })
  await sampleNativeWorktreeProcesses({ ...plan, receiptFile })
  if (callbacks.signal?.aborted) throw new StructuredSessionError('cancelled', 'Codex worktree turn was cancelled before startup')
  await callbacks.onTurnStarting?.()

  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp }
  for (const key of sessionIdentityEnvVars()) delete env[key]
  const child = runtime.spawnGatedNativeProcess(cli, args, { cwd: workspace, env, stderr: 'ignore' })
  const gate = child.stdio[3] as Writable, stdin = child.stdin!
  const closed = new Promise<Exit>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  let owned: OwnedLaunch | undefined, interrupted = false, timedOut = false, closing = false, streamEnded = false
  let fault: unknown
  let interrupting: Promise<void> | undefined
  const rpc = new provider.CodexNativeAppServer(stdin, child.stdout!)
  const fail = (error: unknown): void => { fault ??= error; rpc.fail(error) }
  child.once('error', fail); gate.on('error', fail)
  child.stdout!.once('end', () => { streamEnded = true })
  const cancelFile = join(root, 'cancel.json')
  const interrupt = (): Promise<void> => {
    if (interrupting) return interrupting
    interrupted = true
    interrupting = (async () => {
      if (closing || streamEnded) return
      try {
        const ack = await rpc.interrupt()
        if (ack) write(root, 'interrupt.json', { ...ack, planDigest: native.planDigest })
      } catch (error) { fault ??= error }
    })()
    return interrupting
  }
  const abort = (): void => { void interrupt() }
  active.set(root, { interrupt, planDigest: native.planDigest })
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true; abort()
    void callbacks.onTimeout?.().catch(fail)
  })
  let census: ReturnType<typeof setInterval> | undefined
  let proof: Proof | undefined
  let error: unknown
  const assertRunning = (): void => {
    if (interrupted || callbacks.signal?.aborted || existsSync(cancelFile)) {
      abort()
      throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Codex worktree turn was cancelled')
    }
    if (fault) throw fault
    if (rpc.failure) throw rpc.failure
    if (streamEnded) throw failed('Codex app-server disconnected before terminal evidence')
  }
  try {
    if (!child.pid) throw pending('Codex worktree has no launch PID')
    writeDetachedRuntimeReceipt(child.pid, receiptFile)
    const launch: Launch = { planDigest: native.planDigest, pid: child.pid, receiptFile, receiptDigest: sha(readFileSync(receiptFile)) }
    write(root, 'launch.json', launch)
    owned = { ...plan, ...launch }
    await sampleNativeWorktreeProcesses(owned)
    Object.assign(native, { pid: child.pid, receiptFile })
    await callbacks.onNative({ ...native })
    assertRunning()
    gate.end('start\n')
    const sample = periodicNativeWorktreeSampler(owned, () => closing, fail)
    census = setInterval(() => { if (existsSync(cancelFile)) abort(); sample() }, 250)
    await rpc.initialize('spexcode-native-worktree', '1')
    const options = { workspace, model: nativeModel, permissions }
    const thread = await rpc.startThread({ ...options, beforeStart: assertRunning })
    native.threadId = thread.id
    await callbacks.onNative({ ...native })
    await callbacks.onThread(thread.id)
    assertRunning()
    const turnId = await rpc.startTurn({ ...options, prompt, schema: execution.schema, effort: execution.effort })
    native.turnId = turnId
    await callbacks.onNative({ ...native })
    await callbacks.onTurn(turnId)
    await rpc.waitForTerminal()
    assertRunning()
    proof = { launchDigest: digest(launch), thread, final: rpc.readFinal(), stopDigest: '' }
  } catch (cause) {
    error = cause instanceof provider.CodexNativeProtocolError ? new StructuredSessionError(cause.code, cause.message) : cause
  }
  closing = true
  clearInterval(census)
  const deadline = Date.now() + STOP_MS
  try {
    await interrupting
    gate.destroy()
    stdin.end()
    const exit = await Promise.race([closed, delay(500).then(() => null)])
    if (!exit && owned) signalGroup(owned)
    if (!owned || !await waitForNativeWorktreeProcessesStopped(owned, deadline, !exit, () => launchMatches(owned!)))
      throw pending('Codex exact native process stop remains unproven')
    if (proof) {
      const finalExit = exit ?? await Promise.race([closed, delay(Math.max(0, deadline - Date.now())).then(() => null)])
      if (!finalExit || !(finalExit.code === 0 && finalExit.signal === null || !exit && finalExit.code === null && finalExit.signal === 'SIGTERM'))
        throw failed('Codex app-server did not complete its native shutdown')
      proof.stopDigest = stopDigest(owned)
    }
  } finally {
    clearTimeout(timer)
    callbacks.signal?.removeEventListener('abort', abort)
    active.delete(root)
    child.stdout!.destroy()
  }
  if (interrupted || callbacks.signal?.aborted || existsSync(cancelFile))
    throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Codex worktree turn was cancelled')
  if (error) throw error
  write(root, 'settlement.json', proof)
  await callbacks.onNative({ ...native, proofDigest: digest(proof) })
  return resultFromFinal(proof!.final, prompt, execution, provider.codexNativeTokenUsage(proof!.final.tokenUsage))
}
