import { loadManagerNativeRuntime } from './llm-manager-host.js'
import { managedRoute, nativeModelValue } from './llm-manager-route.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt, type ProcessIdentity } from '@spexcode/spec-core'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { NATIVE_PERIODIC_OBSERVATION_FAILURE, nativeWorktreeLaunch, nativeWorktreeResult, periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
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
type NativeSettlement = { launchDigest: string; outputDigest: string; stopDigest: string; exit: Exit; closeDigest?: string; quotaDigest?: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type RpcObject = Record<string, unknown>

type CursorAdapter = {
  CursorAcpError: new (...args: never[]) => Error & {
    code: 'failed' | 'unsupported' | 'cancellation_pending' | 'provider_quota_exhausted'
    detail?: { threadId: string; turnId: string }
  }
  cursorModelArgument(value: string): string | undefined
  inspectCursorCliVersion(launch: ReturnType<typeof nativeWorktreeLaunch> & { cwd: string }): string
  cursorLaunchArgs(workspace: string, mode: NativePlan['mode'], model?: string): string[]
  cursorAcpInitialize(): RpcObject
  cursorAcpCancel(sessionId: string): RpcObject
  encodeCursorAcpPacket(packet: RpcObject): string
  cursorUsageLimitNotice(value: unknown): boolean
  observeCursorAcp(stdout: Readable, plan: Pick<NativePlan, 'workspace' | 'mode'> & { planDigest: string }, prompt: string, send: (packet: RpcObject) => void, hooks: {
    onSession(id: string): Promise<void>
    startPrompt(request: NativeRequest): Promise<boolean>
    onTerminal(output: NativeOutput): void
    onProviderQuota?(request: NativeRequest, evidence: 'http_429' | 'usage_limit'): void
    isInterrupted(): boolean
    digestRequest(request: NativeRequest): string
  }): Promise<{ output: NativeOutput; textOnlyWithoutTools: boolean }>
}

function cursorHostError(provider: CursorAdapter, error: unknown): unknown {
  return error instanceof provider.CursorAcpError ? new StructuredSessionError(error.code, error.message, error.detail) : error
}

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
const usageLimitNotice = (value: unknown): boolean => typeof value === 'string' && /^(?:Upgrade your plan to continue|You've hit your usage limit)[.!]?$/iu.test(value.trim())
const quotaFailure = (request: NativeRequest): StructuredSessionError => new StructuredSessionError('provider_quota_exhausted',
  'Cursor provider reported quota exhaustion for the original ACP prompt', { threadId: request.sessionId, turnId: request.requestId })
const terminalQuotaReceipt = (request: NativeRequest, output: NativeOutput) => ({ requestDigest: digest(request), sessionId: request.sessionId,
  requestId: request.requestId, evidence: 'usage_limit' as const, source: 'acp_terminal' as const, outputDigest: digest(output) })

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
  const value = nativeModelValue(model, 'cursor')
  if (!value.trim() || value.includes('\0'))
    throw new StructuredSessionError('unsupported', 'Cursor CLI requires cursor:<model> or cursor:default')
  return value === 'default' ? undefined : value
}

function recordedLaunchArgs(workspace: string, mode: NativePlan['mode'], model: string | undefined): string[] {
  return ['--workspace', workspace, '--sandbox', 'enabled', '--trust', ...(mode === 'read' ? ['--mode', 'ask'] : []), ...(model === undefined ? [] : ['--model', model]), 'acp']
}

const nativePrompt = (prompt: string, execution: CursorStructuredExecution): string =>
  `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}`

function assertPlan(plan: NativePlan, root: string, execution: CursorStructuredExecution, prompt?: string, worktreePath?: string): void {
  const native = execution.cursorNative
  if (plan?.version !== 1 || native?.version !== 1 || plan.root !== root || native.root !== root
    || !nonempty(plan.workspace) || worktreePath !== undefined && worktreePath !== plan.workspace || plan.tmp !== join(root, 'tmp')
    || plan.mode !== execution.worktree?.mode || !nonempty(plan.cliPath) || !nonempty(plan.cliVersion)
    || !Array.isArray(plan.args) || digest(plan.args) !== digest(recordedLaunchArgs(plan.workspace, plan.mode, cursorNativeModel(execution.model)))
    || plan.policyDigest !== digest(structuredExecutionPolicy(execution))
    || prompt !== undefined && (plan.promptDigest !== sha256(nativePrompt(prompt, execution)) || plan.promptDigest !== sha256(readEvidence(root, 'prompt.txt'))))
    throw stale('Cursor original worktree, prompt or policy binding differs')
}

function assertRawLaunch(plan: NativePlan, launch: NativeLaunch): void {
  if (!Number.isSafeInteger(launch?.pid) || launch.pid <= 1 || launch.receiptFile !== join(plan.root, 'process.json')
    || launch.planDigest !== digest(plan) || launch.receiptDigest !== sha256(readEvidence(plan.root, 'process.json')))
    throw stale('Cursor original detached launch or receipt differs')
}

function assertLaunch(plan: NativePlan, launch: NativeLaunch, native: CursorNativeState): void {
  assertRawLaunch(plan, launch)
  if (launch.pid !== native?.pid || launch.receiptFile !== native.receiptFile) throw stale('Cursor original detached launch or receipt differs')
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

function readSettledOutput(root: string, prompt: string, execution: CursorStructuredExecution, worktreePath: string): { request: NativeRequest; output: NativeOutput; quota: boolean } {
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
  const receipt = existsSync(join(root, 'provider-quota.json')) ? object(read<unknown>(root, 'provider-quota.json')) : undefined
  const quota = receipt?.source === 'acp_terminal'
  if (quota !== (settlement.quotaDigest !== undefined) || quota && (!managedRoute(execution.model) || !usageLimitNotice(output.text)
    || digest(receipt) !== settlement.quotaDigest || digest(terminalQuotaReceipt(request, output)) !== settlement.quotaDigest))
    throw stale('Cursor settled ACP usage notice does not match its original quota receipt')
  return { request, output, quota }
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
  const { request, output, quota } = readSettledOutput(execution.cursorNative.root, prompt, execution, worktreePath)
  if (quota) throw stale('Cursor settled usage notice cannot authenticate rejected structured output')
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

function hasObservedLaunchLeader(plan: OwnedLaunch, owned = read<ProcessIdentity[]>(plan.root, 'owned-processes.json')): boolean {
  const receipt = read<{ startToken: string }>(plan.root, 'process.json')
  return Array.isArray(owned) && owned.some(identity => identity?.pid === plan.pid && identity.startToken === receipt.startToken.replace(/\s+/g, ' '))
}

async function waitForStop(plan: OwnedLaunch, deadline: number, terminate: boolean): Promise<boolean> {
  const receiptMatches = (): boolean => sha256(readEvidence(plan.root, 'process.json')) === plan.receiptDigest
  try {
    if (terminate && (!receiptMatches() || !hasObservedLaunchLeader(plan))) return false
    return await waitForNativeWorktreeProcessesStopped(plan, deadline, terminate, receiptMatches)
  } catch (error) {
    if (!(error instanceof StructuredSessionError && ['cancellation_pending', 'stale_result'].includes(error.code))) throw error
  }
  return false
}

async function waitForGatedStop(plan: OwnedLaunch, deadline: number): Promise<boolean> {
  if (Date.now() >= deadline || !detachedRuntimeIsGone(plan.pid, plan.receiptFile)) return false
  const owned = read<ProcessIdentity[]>(plan.root, 'owned-processes.json')
  if (!Array.isArray(owned) || (owned.length > 0 && !hasObservedLaunchLeader(plan, owned))) return false
  return waitForStop(plan, deadline, false)
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
    const unpublished = execution.turnStartRequested === true
      && [native.pid, native.receiptFile, native.sessionId, native.requestId, execution.threadId, execution.turnId].every(value => value === undefined)
      && !['request.json', 'close.json', 'result.json', 'settlement.json', 'cancel-ack.json'].some(name => existsSync(join(native.root, name)))
    if (unpublished) {
      assertRawLaunch(plan, launch)
      return await waitForGatedStop({ ...plan, ...launch }, deadline) ? { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } : unproven
    }
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

/** 启动 Cursor ACP 原生会话。已存在的派发只允许读取原结果或精确停止。 */
export async function cursorStructuredTurn(realm: string, id: string, prompt: string, execution: CursorStructuredExecution, callbacks: Callbacks, worktreePath: string | undefined): Promise<NativeResult> {
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || !execution.worktree || !worktreePath || execution.frozenContext || execution.readerRuntime || execution.effort)
    throw new StructuredSessionError('unsupported', 'Cursor CLI requires an explicit native worktree request with native CLI effort')
  const root = join(realm, id)
  if (callbacks.signal?.aborted || execution.cancellation || ['cancelled', 'cancelling', 'timeout'].includes(execution.state ?? '')) throw cancelled(execution.cancellation?.reason === 'timeout' || execution.state === 'timeout')
  if (existsSync(join(root, 'settlement.json'))) {
    const { request, output, quota } = readSettledOutput(root, prompt, execution, worktreePath)
    if (quota) {
      if (execution.state === 'completed') throw stale('Cursor completed state differs from its settled usage notice')
      throw quotaFailure(request)
    }
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

  const runtime = await loadManagerNativeRuntime()
  const provider = await runtime.loadNativeAdapter('cursor') as CursorAdapter
  const cliPath = runtime.findNativeExecutable('cursor')
  if (!cliPath) throw new StructuredSessionError('unsupported', 'Cursor CLI is unavailable')
  let model: string | undefined
  try { model = provider.cursorModelArgument(nativeModelValue(execution.model, 'cursor')) }
  catch (error) { throw cursorHostError(provider, error) }
  if (realpathSync(worktreePath) !== worktreePath) throw new StructuredSessionError('unsupported', 'Cursor CLI requires the exact physical worktree path')
  const launch = nativeWorktreeLaunch(worktreePath, cliPath, [])
  const args = provider.cursorLaunchArgs(worktreePath, execution.worktree.mode, model)
  let cliVersion: string
  try { cliVersion = provider.inspectCursorCliVersion({ ...launch, cwd: worktreePath }) }
  catch (error) { throw cursorHostError(provider, error) }

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
  const child = runtime.spawnGatedNativeProcess(launch.command, [...launch.args, ...args], { cwd: worktreePath, env, stderr: 'ignore' })
  const stdin = child.stdin!, stdout = child.stdout!, gate = child.stdio[3] as Writable
  const closed = new Promise<Exit>(resolveExit => child.once('close', (code, signal) => resolveExit({ code, signal })))
  let gatedLaunch: OwnedLaunch | undefined, owned: OwnedLaunch | undefined, boundRequest: NativeRequest | undefined
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
  const send = (packet: RpcObject): void => { stdin.write(provider.encodeCursorAcpPacket(packet)) }
  const shutdown = (): void => {
    armStop()
    if (!owned || forceTimer) return
    if (boundRequest && !terminalSeen && !stdin.destroyed && !stdin.writableEnded) {
      send(provider.cursorAcpCancel(boundRequest.sessionId))
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
    fault(Object.assign(failed(NATIVE_PERIODIC_OBSERVATION_FAILURE.cursor), { cause: error }))
  }
  child.once('error', fault); stdin.once('error', fault); gate.once('error', fault)
  activeInterrupts.set(root, abort)
  callbacks.signal?.addEventListener('abort', abort, { once: true })
  const timer = structuredExecutionTimer(execution.timeoutMs, () => {
    timedOut = true
    abort()
    void callbacks.onTimeout?.().catch(error => { timeoutFailure = error })
  })
  const observed = provider.observeCursorAcp(stdout, { workspace: plan.workspace, mode: plan.mode, planDigest: digest(plan) }, promptBytes, send, {
    digestRequest: digest,
    onSession: callbacks.onThread,
    ...(managedRoute(execution.model) ? {
      onProviderQuota: (request: NativeRequest, evidence: 'http_429' | 'usage_limit') =>
        writeEvidence(root, 'provider-quota.json', { requestDigest: digest(request), sessionId: request.sessionId, requestId: request.requestId, evidence }),
    } : {}),
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
  }).then(output => output, (error: unknown) => {
    fault(cursorHostError(provider, error))
    return null
  })
  try {
    if (!child.pid) throw pending('Cursor launch PID is unavailable')
    try { writeDetachedRuntimeReceipt(child.pid, receiptFile) }
    catch (error) { throw Object.assign(pending('Cursor detached process ownership could not be recorded'), { cause: error }) }
    const binding = { planDigest: digest(plan), pid: child.pid, receiptFile, receiptDigest: sha256(readEvidence(root, 'process.json')) }
    writeEvidence(root, 'launch.json', binding)
    const launched = { ...plan, ...binding }
    gatedLaunch = launched
    await sampleNativeWorktreeProcesses(launched)
    owned = launched
    await callbacks.onNative({ ...native, pid: child.pid, receiptFile })
    if (interrupted || callbacks.signal?.aborted || existsSync(cancelPath)) abort()
    else if (!failure) {
      gate.end('start\n')
      send(provider.cursorAcpInitialize())
    } else shutdown()
    const sample = periodicNativeWorktreeSampler(launched, () => deadline !== undefined, observationFault)
    census = setInterval(() => {
      if (!interrupted && existsSync(cancelPath)) abort()
      sample()
    }, 250)

    const ended = await Promise.race([Promise.all([closed, observed]), expiry])
    armStop()
    if (!ended) throw pending('Cursor native close and process-group stop remain unproven')
    const [exit, observation] = ended
    const output = observation?.output
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
    let quotaDigest: string | undefined
    if (managedRoute(execution.model) && observation?.textOnlyWithoutTools && provider.cursorUsageLimitNotice(output.text)) {
      try {
        const actual = nativeWorktreeResult(worktreePath, execution.worktree)
        if (actual.headCommit === execution.worktree.baseCommit && actual.tree === execution.worktree.tree) {
          const receipt = terminalQuotaReceipt(boundRequest, output)
          writeEvidence(root, 'provider-quota.json', receipt)
          quotaDigest = digest(receipt)
        }
      } catch (error) {
        // An edited worktree makes the text ordinary rejected output, retaining its original bytes.
        if (!(error instanceof StructuredSessionError) || error.code !== 'native_worktree_result_invalid') throw error
      }
    }
    writeEvidence(root, 'settlement.json', { launchDigest: digest(binding), outputDigest: digest(output), stopDigest: stopObservation(root, binding), exit, ...(normalClose ? { closeDigest: digest(normalClose) } : {}), ...(quotaDigest ? { quotaDigest } : {}) } satisfies NativeSettlement)
    if (quotaDigest) throw quotaFailure(boundRequest)
    return verifyFinal(boundRequest, output, prompt, execution)
  } catch (error) {
    if (!stopped) {
      if (!owned) gate.destroy()
      shutdown()
      const exit = await Promise.race([closed, expiry])
      if (exit && owned) stopped = await waitForStop(owned, deadline!, true)
      else if (exit && gatedLaunch) stopped = await waitForGatedStop(gatedLaunch, deadline!)
    }
    if (!stopped) throw Object.assign(pending('Cursor native stop remains unproven'), { cause: error })
    if (!owned) {
      if (interrupted || callbacks.signal?.aborted || existsSync(cancelPath))
        throw Object.assign(cancelled(timedOut), timeoutFailure === undefined ? {} : { cause: timeoutFailure })
      throw Object.assign(failed('Cursor gated launch process observation failed'), { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(forceTimer); clearTimeout(closeTimer); clearInterval(census)
    activeInterrupts.delete(root)
    callbacks.signal?.removeEventListener('abort', abort)
    gate.destroy(); stdin.destroy(); stdout.destroy(); child.unref()
  }
}
