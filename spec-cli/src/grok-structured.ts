import { managedRoute, nativeModelValue } from './llm-manager-route.js'
import { grokReplay } from '../llm-manager/native-runtime.mjs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { NATIVE_PERIODIC_OBSERVATION_FAILURE, nativeWorktreeLaunch, periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, stopNativeWorktreeDescendants, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { assertRejectedOutput, rejectedFinalOutput, structuredExecutionPolicy, structuredExecutionTimer, structuredRealmRoot, StructuredSessionError, type StructuredExecution } from './session-structured-policy.js'
import { loadManagerNativeRuntime } from './llm-manager-host.js'

export type GrokNativeState = { version: 1; root: string; sessionId: string; pid?: number; receiptFile?: string; turnId?: string }
export type GrokStructuredExecution = StructuredExecution
type Callbacks = { onNative(state: GrokNativeState): Promise<void>; onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof?: never }
type NativePlan = { version: 1; readGuidance?: 'direct-git-read-v1' | 'native-file-read-v2' | 'native-candidate-read-v3' | 'native-review-table-read-v4' | 'native-behavior-evidence-v5'; root: string; sessionId: string; workspace: string; promptDigest: string; policyDigest: string; cliPath: string; cliVersion: string }
type NativeLaunch = { planDigest: string; pid: number; receiptFile: string; receiptDigest: string }
type OwnedLaunch = NativePlan & NativeLaunch
type Terminal = { sessionId: string; requestId: string }
type NativeOutput = { terminal: Terminal; text: string; structuredOutput?: 'present' | 'missing' }
type NativeDiagnostic = Record<string, unknown>
type NativeFailure = { code: 'failed' | 'provider_quota_exhausted'; message: string; httpStatus?: 402 }
type GrokInvocation = {
  cliVersion: string
  profile: Record<string, unknown>
  args: readonly string[]
  environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  connect(pipes: {
    stdin: Writable; stdout: Readable; stderr: Readable; released: Promise<boolean>
  }, onTerminal: (terminal?: Terminal) => void): { observed: Promise<unknown>; diagnostics: () => NativeDiagnostic }
  describeError(error: unknown): { message: string; missingTerminal: boolean; waitForExit: boolean } | undefined
  classifyStoppedError(error: unknown, facts: {
    stderr?: NativeDiagnostic; exit?: Exit; stdoutEnded: boolean; managed: boolean
  }): NativeFailure | undefined
  settle(observation: unknown, exit: Exit, managed: boolean): { output: NativeOutput } | {
    error: NativeFailure; diagnostic?: { name: string; payload: NativeDiagnostic }
  }
}
type GrokAdapter = {
  prepareGrokStructuredInvocation(request: {
    launch: { command: string; args: readonly string[]; cwd: string }; mode: 'read' | 'edit'
    sessionId: string; prompt: string; promptFile: string; schema: unknown; model: string
  }): GrokInvocation
  grokTerminalCompleted(terminal?: Terminal): boolean
  classifyGrokNativeExit(observation: {
    terminal?: Terminal; deadline: number; observedAt?: number; interrupted: boolean; observationFailed: boolean
  }): 'accepted' | 'unproven' | { code: 'failed'; message: string; kind: 'exit_deadline' }
  grokCleanNativeExit(terminal: Terminal | undefined, exit?: Exit): boolean
}
type Exit = { code: number | null; signal: NodeJS.Signals | null }
type NativeSettlement = { launchDigest: string; outputDigest: string; stopDigest: string; exit: Exit }
type StopResult = { nativeStopped: boolean; acknowledged: false; nativeStatus?: string; error?: string }

const replay = grokReplay as {
  grokReadOnlyGuidance: { repository: string; candidate: string; legacy: string }
  grokSettlementTiming: { stopMs: number; nativeShutdownGraceMs: number }
  grokStructuredProfileMatches(plan: NativePlan, mode?: 'read' | 'edit'): boolean
  grokSettledInvocationMatches(plan: NativePlan, output: NativeOutput, exit: Exit): boolean
  isGrokNativeExitFailure(failure: { code?: string; message?: string }): boolean
}
const { stopMs: STOP_MS, nativeShutdownGraceMs: NATIVE_SHUTDOWN_GRACE_MS } = replay.grokSettlementTiming
export const { isGrokNativeExitFailure } = replay
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

const candidateReviewPurposes = new Set(['elaboration_review', 'code_review'])
const behaviorDraftPurposes = new Set(['code_behavior_analyze', 'code_behavior_review'])
const { grokReadOnlyGuidance } = replay

const readGuidanceText = {
  'direct-git-read-v1': grokReadOnlyGuidance.legacy,
  'native-file-read-v2': grokReadOnlyGuidance.repository,
  'native-candidate-read-v3': grokReadOnlyGuidance.candidate,
  'native-review-table-read-v4': grokReadOnlyGuidance.repository + String.raw` Interpret Markdown table cells before comparing code literals to source code. Outside a matched code span, \\ encodes one literal backslash and \| encodes a cell character. Inside a code span, preserve literal backslashes except for an escaped table separator. For example, a plain cell containing /\\s+/ denotes /\s+/ in the contract. Check the decoded meaning against the actual implementation and tests, including any genuinely different decoded literal.`,
  'native-behavior-evidence-v5': 'Ground current and previous business behavior in the frozen source and historical role objects identified in the task. Cite the actual repository path and symbol, condition, or assertion. Do not cite the current worktree HEAD, its ancestry, or temporary .spex-sync-drafts commits as business evidence. Analyze and review have separate seed and draft commits. On repair, replace inherited claims about temporary Git identities with evidence from the actual frozen business files. In independent review, reject incorrect frozen-object or code claims and request correction of misleading draft HEAD claims. Still inspect every required path and verify the substantive claims against the source and tests.',
} satisfies Record<NonNullable<NativePlan['readGuidance']>, string>

const nativePrompt = (prompt: string, execution: GrokStructuredExecution, readGuidance?: NativePlan['readGuidance']): string =>
  `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}${readGuidance ? `\n\n${readGuidanceText[readGuidance]}` : ''}`

function assertPlan(plan: NativePlan, root: string, execution: GrokStructuredExecution, prompt?: string, worktreePath?: string): void {
  const native = execution.grokNative
  const guidance = plan?.readGuidance
  const guidanceMatches = guidance === undefined || (guidance === 'native-behavior-evidence-v5'
    ? execution.worktree?.mode === 'edit' && behaviorDraftPurposes.has(execution.purpose)
    : Object.hasOwn(readGuidanceText, guidance) && execution.worktree?.mode === 'read' && (
      guidance === 'direct-git-read-v1' || guidance === 'native-file-read-v2' || candidateReviewPurposes.has(execution.purpose)))
  if (plan?.version !== 1 || !guidanceMatches || !replay.grokStructuredProfileMatches(plan, execution.worktree?.mode)
    || native?.version !== 1 || plan.root !== root || native.root !== root || plan.sessionId !== native.sessionId
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== native.turnId || worktreePath !== undefined && worktreePath !== plan.workspace
    || plan.policyDigest !== digest(structuredExecutionPolicy(execution)) || !plan.cliPath || !plan.cliVersion
    || prompt !== undefined && (plan.promptDigest !== sha256(nativePrompt(prompt, execution, plan.readGuidance)) || plan.promptDigest !== sha256(readEvidence(root, 'prompt.txt'))))
    throw stale('Grok original worktree, prompt, policy or session binding differs')
}

function assertLaunch(plan: NativePlan, launch: NativeLaunch, execution: GrokStructuredExecution): void {
  if (!Number.isSafeInteger(launch?.pid) || launch.pid <= 1 || launch.pid !== execution.grokNative?.pid
    || launch.receiptFile !== join(plan.root, 'process.json') || launch.receiptFile !== execution.grokNative.receiptFile
    || launch.planDigest !== digest(plan) || launch.receiptDigest !== sha256(readEvidence(plan.root, 'process.json')))
    throw stale('Grok original detached launch or receipt differs')
}

function verifyFinal(native: NativeOutput, prompt: string, execution: GrokStructuredExecution): NativeResult {
  const identity = { threadId: native.terminal.sessionId, turnId: native.terminal.requestId }
  let output: unknown
  const invalid = (message: string): StructuredSessionError => new StructuredSessionError('structured_output_format_invalid', message, {
    ...identity, rejectedOutput: rejectedFinalOutput(native.text, prompt, execution, identity, native.structuredOutput === 'present' ? 'native_json' : 'text'),
  })
  if (native.structuredOutput === 'missing') throw invalid('Grok native terminal did not provide structured output')
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
    || existsSync(join(root, 'cancel.json'))
    || !replay.grokSettledInvocationMatches(plan, output, settlement.exit)
    || output.terminal.requestId !== execution.turnId || output.terminal.requestId !== execution.grokNative?.turnId
    || output.terminal.sessionId !== execution.threadId)
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
  catch (error) {
    if (!(error instanceof StructuredSessionError) || error.code !== 'structured_output_format_invalid') throw error
    if (error.rejectedOutput?.representation !== execution.rejectedOutput.representation) throw stale('Grok stopped draft output representation differs from its native terminal')
    return
  }
  throw stale('Grok stopped draft unexpectedly passes its original schema')
}

/** 冷验未发布的原生退出，供同步继续原草稿或只读独审。 */
export function assertGrokUnpublishedExitSource(id: string, prompt: string, execution: GrokStructuredExecution, worktreePath: string, purpose: 'code_behavior_analyze' | 'elaboration_generate' | 'elaboration_review', terminal: 'failed' | 'cancelled' = 'failed'): void {
  const native = execution.grokNative, realm = structuredRealmRoot(execution)
  const mode = purpose === 'elaboration_review' ? 'read' : 'edit'
  if (!realm || !native || native.root !== join(realm, id) || execution.state !== terminal || execution.errorCode
    || (terminal === 'cancelled' ? mode !== 'read' || execution.cancellation?.reason !== 'cancelled' : !isGrokNativeExitFailure({ code: 'failed', message: execution.error }))
    || execution.worktree?.mode !== mode || execution.purpose !== purpose || !execution.turnStartRequested
    || execution.threadId !== undefined || execution.turnId !== undefined || native.turnId !== undefined || execution.rejectedOutput || execution.resultWorktree || execution.failedWorktree
    || execution.output !== undefined || execution.resultDigest !== undefined || execution.cancellation?.nativeStopped !== true
    || execution.cancellation.nativeStatus !== 'stopped' || execution.cancellation.acknowledged !== false || execution.cancellation.error !== undefined
    || existsSync(join(native.root, 'settlement.json')) || existsSync(join(native.root, 'result.json')))
    throw stale('Grok source lacks its original unpublished exit')
  const plan = read<NativePlan>(native.root, 'plan.json'), launch = read<NativeLaunch>(native.root, 'launch.json')
  assertPlan(plan, native.root, execution, prompt, worktreePath)
  assertLaunch(plan, launch, execution)
  if (terminal === 'cancelled' ? read<{ launchDigest: string }>(native.root, 'cancel.json')?.launchDigest !== digest(launch) : existsSync(join(native.root, 'cancel.json')))
    throw stale('Grok original native cancellation binding differs')
  if (!detachedRuntimeIsGone(launch.pid, launch.receiptFile)) throw stale('Grok unpublished exit process identity is not gone')
  stopObservation(native.root, launch)
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
  const root = join(realm, id)
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

  const runtime = await loadManagerNativeRuntime()
  const provider = await runtime.loadNativeAdapter('grok') as GrokAdapter
  const cliPath = runtime.findNativeExecutable('grok')
  if (!cliPath) throw new StructuredSessionError('unsupported', 'Grok Build CLI is unavailable')
  if (realpathSync(worktreePath) !== worktreePath) throw new StructuredSessionError('unsupported', 'Grok Build requires the exact physical worktree path')
  const launch = nativeWorktreeLaunch(worktreePath, cliPath, [])
  const native = { version: 1 as const, root, sessionId: randomUUID() }
  const readGuidance = execution.worktree.mode === 'read'
    ? candidateReviewPurposes.has(execution.purpose) ? 'native-review-table-read-v4' : 'native-file-read-v2'
    : behaviorDraftPurposes.has(execution.purpose) ? 'native-behavior-evidence-v5' : undefined
  const promptPath = join(root, 'prompt.txt'), promptBytes = nativePrompt(prompt, execution, readGuidance), receiptFile = join(root, 'process.json'), tmp = join(root, 'tmp')
  let invocation: GrokInvocation
  try {
    invocation = provider.prepareGrokStructuredInvocation({
      launch: { ...launch, cwd: worktreePath }, mode: execution.worktree.mode, model: nativeModelValue(execution.model, 'grok'),
      sessionId: native.sessionId, prompt: promptBytes, promptFile: promptPath, schema: execution.schema,
    })
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'unsupported') throw error
    throw new StructuredSessionError('unsupported', error.message)
  }
  const plan: NativePlan = {
    ...invocation.profile, ...native, ...(readGuidance ? { readGuidance } : {}),
    workspace: worktreePath, cliPath, cliVersion: invocation.cliVersion, promptDigest: sha256(promptBytes), policyDigest: digest(structuredExecutionPolicy(execution)),
  }
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

  const env = invocation.environment({ ...process.env, TMPDIR: tmp })
  for (const key of sessionIdentityEnvVars()) delete env[key]
  const launchedAt = performance.now()
  const child = runtime.spawnGatedNativeProcess(launch.command, [...launch.args, ...invocation.args], { cwd: worktreePath, env }) as ChildProcessWithoutNullStreams
  const gate = child.stdio[3] as Writable
  let observedExit: Exit | undefined
  let exitAtMs: number | null = null
  const exited = new Promise<Exit & { observedAt: number }>(resolve => child.once('exit', (code, signal) => {
    const observedAt = Date.now()
    observedExit = { code, signal }
    exitAtMs = performance.now() - launchedAt
    armStop()
    resolve({ code, signal, observedAt })
  }))
  let processFailed = false
  child.stdin.once('error', () => { processFailed = true })
  gate.once('error', () => { processFailed = true })
  let owned: OwnedLaunch | undefined
  let launchBinding: NativeLaunch | undefined
  let deadline: number | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined
  let census: ReturnType<typeof setInterval> | undefined
  let terminalAtMs: number | undefined, deadlineAtMs: number | undefined, timerFiredAtMs: number | null = null
  let timedOut = false, observerFailure: unknown, timeoutFailure: unknown
  let originalObserverError: unknown
  let stopPhase = 'native-exit-or-terminal'
  let release!: (start: boolean) => void
  const released = new Promise<boolean>(resolve => { release = resolve })
  let expire!: () => void
  const expiry = new Promise<null>(resolve => { expire = () => resolve(null) })
  const armStop = (): void => {
    if (deadline !== undefined) return
    deadline = Date.now() + STOP_MS
    clearInterval(census)
    deadlineAtMs = performance.now() - launchedAt + STOP_MS
    stopTimer = setTimeout(() => {
      timerFiredAtMs = performance.now() - launchedAt
      expire()
    }, STOP_MS)
  }
  const interrupt = (): void => {
    armStop()
    release(false)
    gate.destroy()
    child.stdin.destroy()
    if (owned) signalOwnedGroup(owned)
  }
  const abort = (): void => { try { interrupt() } catch (error) { observerFailure ??= error } }
  child.once('error', () => { processFailed = true; abort() })
  let terminal: Terminal | undefined, stdoutFinished = false
  let missingTerminal = false
  let notifyTerminal!: () => void
  const terminalSeen = new Promise<void>(resolve => { notifyTerminal = resolve })
  const onTerminal = (value?: Terminal): void => {
    terminal = value
    terminalAtMs = performance.now() - launchedAt
    armStop()
    notifyTerminal()
  }
  const connected = invocation.connect({ stdout: child.stdout, stdin: child.stdin, stderr: child.stderr, released }, onTerminal)
  const observed = connected.observed
    .catch((error: unknown) => {
      const protocolError = invocation.describeError(error)
      if (observerFailure === undefined) {
        originalObserverError = error
        missingTerminal = protocolError?.missingTerminal === true
        observerFailure = protocolError ? pending(protocolError.message) : error
      }
      if (stopPhase === 'native-exit-or-terminal') stopPhase = 'native-stdout-protocol'
      if (protocolError?.waitForExit) armStop()
      else abort()
      return null
    }).finally(() => { stdoutFinished = true })
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true
    abort()
    void callbacks.onTimeout?.().catch(error => { timeoutFailure = error })
  })
  let exitWindowFailure: StructuredSessionError | undefined
  let deadlineDecision: {
    atMs: number; exitObserved: boolean; exitCode: Exit['code']; signalCode: Exit['signal']
    exitOverdueMs: number | null; stdoutEnded: boolean; signaledDescendants: number
  } | undefined
  let cleanupProcessGroupStopped: boolean | null = null
  let stopped = false
  try {
    if (!child.pid) throw pending('Grok launch PID is unavailable')
    try { writeDetachedRuntimeReceipt(child.pid, receiptFile) }
    catch (error) { throw Object.assign(pending('Grok detached process ownership could not be recorded'), { cause: error }) }
    const binding = { planDigest: digest(plan), pid: child.pid, receiptFile, receiptDigest: sha256(readFileSync(receiptFile)) }
    launchBinding = binding
    const ownedLaunch = { ...plan, ...binding }
    owned = ownedLaunch
    writeEvidence(root, 'launch.json', binding)
    const running = { ...native, pid: binding.pid, receiptFile }
    await callbacks.onNative(running)
    await sampleNativeWorktreeProcesses(owned)
    if (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json'))) abort()
    else {
      gate.end('start\n')
      release(true)
    }
    if (deadline === undefined) census = setInterval(periodicNativeWorktreeSampler(owned, () => deadline !== undefined, error => {
      stopPhase = 'native-periodic-process-observation'
      observerFailure ??= Object.assign(new StructuredSessionError('failed', NATIVE_PERIODIC_OBSERVATION_FAILURE.grok), { cause: error })
      abort()
    }), 250)
    const terminalOrStream = Promise.race([terminalSeen, observed])
    let reapTimer: ReturnType<typeof setTimeout> | undefined
    const signaled = new Map<number, string>()
    let exit: Exit
    try {
      const ended = await Promise.race([terminalOrStream.then(async () => {
        if (provider.grokTerminalCompleted(terminal) && deadline !== undefined && !observedExit && !observerFailure) {
          const exitDeadline = deadline
          const stillWaiting = (): boolean => Date.now() < exitDeadline && !observedExit && !timedOut && !observerFailure && !processFailed
            && !callbacks.signal?.aborted && !existsSync(join(root, 'cancel.json')) && sha256(readFileSync(receiptFile)) === binding.receiptDigest
          const signalAfter = exitDeadline - STOP_MS + NATIVE_SHUTDOWN_GRACE_MS
          while (stillWaiting()) {
            await Promise.race([exited, new Promise<void>(resolve => { reapTimer = setTimeout(resolve, 500) })])
            clearTimeout(reapTimer)
            if (!stillWaiting()) break
            await Promise.race([exited, stopNativeWorktreeDescendants(ownedLaunch, exitDeadline, stillWaiting, signaled, signalAfter).catch(error => {
              if (!(error instanceof StructuredSessionError && error.code === 'cancellation_pending')) throw error
            })])
          }
        }
        return exited
      }), expiry])
      const settlement = provider.classifyGrokNativeExit({
        terminal, deadline: deadline!, observedAt: ended?.observedAt,
        interrupted: timedOut || callbacks.signal?.aborted === true, observationFailed: Boolean(observerFailure),
      })
      if (typeof settlement === 'object') {
        deadlineDecision = {
          atMs: performance.now() - launchedAt, exitObserved: observedExit !== undefined, exitCode: child.exitCode, signalCode: child.signalCode,
          exitOverdueMs: ended ? ended.observedAt - deadline! : null,
          stdoutEnded: child.stdout.readableEnded, signaledDescendants: signaled.size,
        }
        exitWindowFailure = new StructuredSessionError(settlement.code, settlement.message)
        throw exitWindowFailure
      }
      if (!ended || settlement === 'unproven') throw pending('Grok native exit or terminal remains unproven')
      exit = { code: ended.code, signal: ended.signal }
    } finally { clearTimeout(reapTimer) }
    armStop()
    clearTimeout(stopTimer)
    const interrupted = callbacks.signal?.aborted === true || timedOut
    const successfulExit = !observerFailure && !processFailed && provider.grokCleanNativeExit(terminal, exit)
    const stopDeadline = successfulExit && !interrupted ? Date.now() + STOP_MS : deadline!
    if (!observerFailure) stopPhase = 'native-process-group'
    stopped = await waitForStop(owned, stopDeadline, interrupted || observerFailure !== undefined || successfulExit && !stdoutFinished)
    if (!stopped) throw pending('Grok native process-group stop remains unproven')
    stopPhase = 'native-stdout-eof'
    stopTimer = setTimeout(expire, Math.max(0, stopDeadline - Date.now()))
    const observation = await Promise.race([observed, expiry])
    if (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json'))) throw Object.assign(cancelled(timedOut), timeoutFailure === undefined ? {} : { cause: timeoutFailure })
    if (observerFailure) throw observerFailure
    if (processFailed || !observation || !child.stdout.readableEnded || Date.now() >= stopDeadline) throw pending('Grok native stdout EOF was not observed within the settlement window')
    const settlement = invocation.settle(observation, exit, !!managedRoute(execution.model))
    if ('error' in settlement) {
      if (settlement.diagnostic) {
        writeEvidence(root, settlement.diagnostic.name, {
          version: 1, launchDigest: digest(binding), planDigest: digest(plan), stopDigest: stopObservation(root, binding),
          ...settlement.diagnostic.payload, exit, stdoutEnded: true,
        })
      }
      throw new StructuredSessionError(settlement.error.code, settlement.error.message, { quotaHttpStatus: settlement.error.httpStatus })
    }
    const { output } = settlement
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
      if (owned && exitWindowFailure && error === exitWindowFailure) {
        const cleanupDeadline = Date.now() + STOP_MS
        stopped = await waitForStop(owned, cleanupDeadline, true)
        cleanupProcessGroupStopped = stopped
        if (stopped && !child.stdout.readableEnded) {
          let markEof!: (ended: boolean) => void
          const eof = new Promise<boolean>(resolve => { markEof = resolve })
          const onEnd = (): void => markEof(Date.now() < cleanupDeadline)
          const cleanupTimer = setTimeout(() => markEof(false), Math.max(0, cleanupDeadline - Date.now()))
          child.stdout.once('end', onEnd)
          try {
            child.stdout.resume()
            stopped = await eof
          } finally {
            clearTimeout(cleanupTimer)
            child.stdout.off('end', onEnd)
          }
        }
      } else {
        const exit = await Promise.race([exited, expiry])
        stopped = !!exit && !!owned && await waitForStop(owned, deadline!, true)
      }
    }
    if (!stopped) throw Object.assign(pending(`Grok native stop remains unproven (${stopPhase})`), { cause: error })
    if (exitWindowFailure && error === exitWindowFailure && (callbacks.signal?.aborted || timedOut || existsSync(join(root, 'cancel.json')))) throw cancelled(timedOut)
    let stderr: NativeDiagnostic | undefined
    if (error === observerFailure && missingTerminal && launchBinding && observedExit) {
      stderr = connected.diagnostics()
      try {
        writeEvidence(root, 'missing-terminal-diagnostic.json', {
          version: 1, launchDigest: digest(launchBinding), planDigest: launchBinding.planDigest,
          stopDigest: stopObservation(root, launchBinding), exit: observedExit, stderr,
        })
      } catch (diagnosticError) {
        const io = diagnosticError as NodeJS.ErrnoException
        const fileIO = diagnosticError instanceof Error && Number.isInteger(io.errno) && ['open', 'fstat', 'read', 'write', 'close', 'rename'].includes(io.syscall ?? '')
        const invalidStopEvidence = diagnosticError instanceof SyntaxError || diagnosticError instanceof StructuredSessionError && diagnosticError.code === 'stale_result'
        if (!fileIO && !invalidStopEvidence) throw diagnosticError
        console.warn('spex grok native missing-terminal diagnostic unavailable')
        throw error
      }
    }
    if (error === observerFailure
      && !timedOut && !callbacks.signal?.aborted && !existsSync(join(root, 'cancel.json'))) {
      const classified = invocation.classifyStoppedError(originalObserverError, {
        stderr, exit: observedExit, stdoutEnded: child.stdout.readableEnded, managed: !!managedRoute(execution.model),
      })
      if (classified) throw new StructuredSessionError(classified.code, classified.message, { quotaHttpStatus: classified.httpStatus })
    }
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(stopTimer); clearInterval(census)
    callbacks.signal?.removeEventListener('abort', abort)
    gate.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    if (deadlineDecision) {
      console.warn('spex grok native exit deadline', JSON.stringify({
        pid: child.pid, terminalAtMs, deadlineAtMs, exitAtMs, timerFiredAtMs,
        timerLatenessMs: timerFiredAtMs === null ? null : Math.max(0, timerFiredAtMs - deadlineAtMs!),
        stderr: 'metadata-only', decision: deadlineDecision,
        cleanup: { atMs: performance.now() - launchedAt, processGroupStopped: cleanupProcessGroupStopped, stdoutEnded: child.stdout.readableEnded, settled: stopped },
      }))
    }
  }
}
