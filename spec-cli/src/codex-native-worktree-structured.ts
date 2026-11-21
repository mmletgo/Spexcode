import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Ajv } from 'ajv'
import { detachedRuntimeIsGone, verifyDetachedRuntime, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { codexTextInput, type CodexStructuredStop } from './codex-harness.js'
import { sessionIdentityEnvVars } from './harness-shim.js'
import { periodicNativeWorktreeSampler, sampleNativeWorktreeProcesses, waitForNativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { assertRejectedOutput, isNativeTokenCount, rejectedFinalOutput, StructuredSessionError, structuredExecutionTimer, type NativeTokenUsage, type StructuredExecution } from './session-structured-policy.js'
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

const STOP_MS = 15_000
const CONTROL_MS = 10_000
const nativeErrorKinds = new Set(['contextWindowExceeded', 'sessionBudgetExceeded',
  'flexUnavailable', 'serverOverloaded', 'internalServerError', 'unauthorized', 'badRequest', 'sandboxError', 'other'])
const nativeHttpErrorKinds = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']
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

function observedUsage(total: Packet | undefined): NativeTokenUsage | undefined {
  if (!total) return
  const { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens } = total
  if (!isNativeTokenCount(inputTokens) || !isNativeTokenCount(cachedInputTokens) || cachedInputTokens > inputTokens || !isNativeTokenCount(outputTokens)) return
  return { source: 'codex-turn-usage', totalInputTokens: inputTokens, uncachedInputTokens: inputTokens - cachedInputTokens,
    cacheReadInputTokens: cachedInputTokens, outputTokens, ...(isNativeTokenCount(cacheWriteInputTokens) ? { cacheWriteInputTokens } : {}) }
}

function resultFromFinal(final: Final, prompt: string, execution: Execution): NativeResult {
  const nativeTokenUsage = observedUsage(final.tokenUsage)
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
  const model = nativeModelValue(execution.model, 'codex')
  const final = readFinalProof(native.root, prompt, execution, workspace, model === 'default' ? undefined : model)
  assertRejectedOutput(original, prompt, execution, execution)
  if (original.text !== final.text) throw stale('Codex rejected draft differs from its native terminal')
  try { resultFromFinal(final, prompt, execution) }
  catch (error) { if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid') return; throw error }
  throw stale('Codex rejected draft unexpectedly passes its original schema')
}

class AppServer {
  private requestId = 0
  private error: Error | undefined
  private readonly pending = new Map<number, { method: string; resolve(value: Packet): void; reject(error: Error): void }>()
  constructor(private readonly input: Writable, output: Readable, onEvent: (method: string, params: Packet) => void, onFailure: () => void) {
    const lines = createInterface({ input: output })
    lines.on('line', line => {
      try {
        const packet = object(JSON.parse(line))
        if (string(packet.method)) {
          if (packet.id !== undefined) this.send({ id: packet.id, error: { code: -32601, message: 'Worktree execution grants no interactive requests or approvals' } })
          else onEvent(packet.method, object(packet.params))
        } else if (typeof packet.id === 'number') {
          const waiter = this.pending.get(packet.id)
          this.pending.delete(packet.id)
          if (packet.error) waiter?.reject(failed(`Codex app-server rejected ${waiter.method}`))
          else waiter?.resolve(object(packet.result))
        }
      } catch (error) { this.fail(failed('Codex app-server returned an invalid native event'), error); onFailure() }
    })
    lines.on('close', () => this.fail(failed('Codex app-server closed its native stream')))
    output.on('error', error => { this.fail(failed('Codex app-server output failed'), error); onFailure() })
    input.on('error', error => { this.fail(failed('Codex app-server input failed'), error); onFailure() })
  }
  private send(packet: Packet): void { this.input.write(JSON.stringify(packet) + '\n') }
  notify(method: string): void { this.send({ method, params: {} }) }
  fail(error: Error, cause?: unknown): void {
    this.error ??= cause ? Object.assign(error, { cause }) : error
    for (const waiter of this.pending.values()) waiter.reject(this.error)
    this.pending.clear()
  }
  get failure(): Error | undefined { return this.error }
  async request(method: string, params: Packet): Promise<Packet> {
    if (this.error) throw this.error
    const id = ++this.requestId
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<Packet>((resolve, reject) => {
        this.pending.set(id, { method, resolve, reject })
        timer = setTimeout(() => reject(failed(`Codex app-server did not answer ${method}`)), CONTROL_MS)
        this.send({ id, method, params })
      })
    } finally { clearTimeout(timer); this.pending.delete(id) }
  }
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

function editPermissions(workspace: string, tmp: string): { name: string; config: Packet; roots: string[] } {
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
  return { name, roots, config: {
    ...(devTools ? { 'shell_environment_policy.set.PATH': `${devTools}${delimiter}${process.env.PATH}`, allow_login_shell: false } : {}),
    [`permissions.${name}.filesystem`]: Object.fromEntries([[':root', 'read'], ...roots.map(path => [path, 'write'])]),
    [`permissions.${name}.network.enabled`]: false,
  } }
}

export async function codexNativeWorktreeTurn(realm: string, id: string, prompt: string, execution: Execution, callbacks: Callbacks, workspace: string | undefined, modelSelection?: string): Promise<NativeResult> {
  const nativeModel = modelSelection === 'default' ? undefined : modelSelection
  if (execution.version !== 6 || execution.policy !== 'native-worktree-v1' || execution.nativeConfiguration !== 'cli-config-v1'
    || !execution.worktree || !workspace || execution.frozenContext || execution.readerRuntime)
    throw new StructuredSessionError('unsupported', 'Codex CLI requires the native worktree policy')
  const root = join(realm, id)
  if (callbacks.signal?.aborted || execution.cancellation || ['cancelled', 'cancelling', 'timeout'].includes(execution.state ?? ''))
    throw new StructuredSessionError(execution.cancellation?.reason ?? (execution.state === 'timeout' ? 'timeout' : 'cancelled'), 'Codex worktree turn was cancelled')
  if (execution.state === 'completed') {
    try { return resultFromFinal(readFinalProof(root, prompt, execution, workspace, nativeModel), prompt, execution) }
    catch (error) {
      if (error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid')
        throw stale('Codex completed state cannot replay a rejected native final')
      throw error
    }
  }
  if (execution.codexNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(root))
    throw pending('Codex original worktree dispatch has no settled result; exact stop is required')
  if (realpathSync(workspace) !== workspace) throw stale('Codex requires the physical worktree path')
  const tmp = join(root, 'tmp'), receiptFile = join(root, 'process.json')
  const plan: Plan = { root, workspace, tmp, policyDigest: policyDigest(execution), promptDigest: sha(prompt), ...(nativeModel ? { model: nativeModel } : {}) }
  const permissions = execution.worktree.mode === 'edit' ? editPermissions(workspace, tmp) : undefined
  const args = ['app-server', '--listen', 'stdio://',
    '-c', `sqlite_home=${JSON.stringify(root)}`, '-c', `log_dir=${JSON.stringify(tmp)}`, '-c', 'history.persistence="none"',
    ...['apps', 'plugins', 'hooks', 'code_mode', 'code_mode_host'].flatMap(feature => ['-c', `features.${feature}=false`])]
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
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r ready <&3 && [ "$ready" = start ] || exit 1; exec 3<&-; exec "$@"',
    'spex-codex-launch', 'codex', ...args], { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
  const gate = child.stdio[3] as Writable, stdin = child.stdin!
  const closed = new Promise<Exit>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  let owned: OwnedLaunch | undefined, interrupted = false, timedOut = false, closing = false, streamEnded = false
  let fault: unknown, threadId: string | undefined, turnId: string | undefined
  let interrupting: Promise<void> | undefined
  let wake!: () => void
  const terminal = new Promise<void>(resolve => { wake = resolve })
  const completions = new Map<string, Packet>(), finals = new Map<string, Packet[]>(), usages = new Map<string, Packet>()
  const rpc = new AppServer(stdin, child.stdout!, (method, params) => {
    if (!threadId || params.threadId !== threadId) return
    if (method === 'turn/completed') {
      const turn = object(params.turn)
      if (string(turn.id)) {
        if (completions.has(turn.id)) throw failed('Codex repeated its exact terminal event')
        completions.set(turn.id, turn)
        if (turn.id === turnId) wake()
      }
    } else if (string(params.turnId)) {
      if (method === 'item/completed') {
        const item = object(params.item)
        if (item.type === 'agentMessage' && item.phase === 'final_answer')
          finals.set(params.turnId, [...(finals.get(params.turnId) ?? []), item])
      } else if (method === 'thread/tokenUsage/updated') usages.set(params.turnId, object(object(params.tokenUsage).total))
    }
  }, wake)
  const fail = (error: unknown): void => { fault ??= error; rpc.fail(failed('Codex worktree observation failed'), error); wake() }
  child.once('error', fail); gate.on('error', fail)
  child.stdout!.once('end', () => { streamEnded = true; wake() })
  const cancelFile = join(root, 'cancel.json')
  const exactTurn = (status: string): boolean => turnId !== undefined && completions.get(turnId)?.status === status
  const interrupt = (): Promise<void> => {
    if (interrupting) return interrupting
    interrupted = true
    interrupting = (async () => {
      if (!threadId || !turnId || closing || streamEnded || exactTurn('completed')) return
      const identity = { threadId, turnId }
      try {
        const reply = await Promise.race([rpc.request('turn/interrupt', identity), delay(750).then(() => null)])
        if (reply) {
          await Promise.race([terminal, delay(250)])
          if (exactTurn('interrupted')) write(root, 'interrupt.json', { ...identity, planDigest: native.planDigest })
        }
      } catch (error) { fault ??= error }
    })().finally(wake)
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
    await rpc.request('initialize', { clientInfo: { name: 'spexcode-native-worktree', version: '1' }, capabilities: { experimentalApi: true } })
    rpc.notify('initialized')
    const model = nativeModel === undefined ? {} : { model: nativeModel }
    const effective = object((await rpc.request('config/read', { cwd: workspace, includeLayers: false })).config)
    const config = { ...permissions?.config, mcp_servers: Object.fromEntries(Object.keys(object(effective.mcp_servers))
      .map(server => [server, { enabled: false }])) }
    assertRunning()
    const thread = await rpc.request('thread/start', { cwd: workspace, runtimeWorkspaceRoots: [workspace], approvalPolicy: 'never',
      ephemeral: true, config, ...model, allowProviderModelFallback: false,
      ...(permissions ? { permissions: permissions.name } : { sandbox: 'read-only' }) })
    const row = object(thread.thread), sandbox = object(thread.sandbox), profile = object(thread.activePermissionProfile)
    if (!string(row.id) || row.cwd !== workspace || row.ephemeral !== true || row.path !== null || !string(row.cliVersion)
      || thread.cwd !== workspace || thread.approvalPolicy !== 'never' || sandbox.networkAccess !== false
      || !Array.isArray(thread.runtimeWorkspaceRoots) || thread.runtimeWorkspaceRoots.length !== 1 || thread.runtimeWorkspaceRoots[0] !== workspace
      || !string(thread.model) || nativeModel !== undefined && thread.model !== nativeModel
      || (permissions ? profile.id !== permissions.name || sandbox.type !== 'workspaceWrite'
        || !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some(path => !permissions.roots.includes(path))
        : sandbox.type !== 'readOnly'))
      throw new StructuredSessionError('unsupported', 'Codex did not confirm the exact model, worktree and permission boundary')
    threadId = native.threadId = row.id
    await callbacks.onNative({ ...native })
    await callbacks.onThread(threadId)
    assertRunning()
    const accepted = object((await rpc.request('turn/start', { threadId, input: codexTextInput(prompt), cwd: workspace, approvalPolicy: 'never',
      runtimeWorkspaceRoots: [workspace], outputSchema: execution.schema, ...model, ...(execution.effort ? { effort: execution.effort } : {}),
      ...(permissions ? { permissions: permissions.name } : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }) })).turn)
    if (!string(accepted.id)) throw failed('Codex returned no accepted native turn identity')
    turnId = native.turnId = accepted.id
    await callbacks.onNative({ ...native })
    await callbacks.onTurn(turnId)
    if (completions.has(turnId)) wake()
    await terminal
    assertRunning()
    const answers = finals.get(turnId), usage = usages.get(turnId)
    if (exactTurn('interrupted')) throw new StructuredSessionError('cancelled', 'Codex exact native turn was interrupted')
    if (!exactTurn('completed')) {
      const info = object(completions.get(turnId)?.error).codexErrorInfo
      if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded')
        throw new StructuredSessionError('provider_quota_exhausted', `Codex exact native turn failed (${info})`)
      if (string(info) && nativeErrorKinds.has(info)) throw failed(`Codex exact native turn failed (${info})`)
      for (const kind of nativeHttpErrorKinds) {
        const status = object(object(info)[kind]).httpStatusCode
        if (status === 429) throw new StructuredSessionError('provider_quota_exhausted', `Codex exact native turn failed (${kind}, HTTP 429)`)
        if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
          throw failed(`Codex exact native turn failed (${kind}, HTTP ${status})`)
      }
      throw failed('Codex exact native turn did not complete successfully')
    }
    if (answers?.length !== 1 || !string(answers[0].id) || !string(answers[0].text)) throw failed('Codex exact native turn did not return one final answer')
    const final: Final = { threadId, turnId, status: 'completed', itemId: answers[0].id, text: answers[0].text, ...(usage ? { tokenUsage: usage } : {}) }
    proof = { launchDigest: digest(launch), thread: { id: threadId, cwd: workspace, model: thread.model, cliVersion: row.cliVersion }, final, stopDigest: '' }
  } catch (cause) { error = cause }
  finally {
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
  }
  if (interrupted || callbacks.signal?.aborted || existsSync(cancelFile))
    throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'Codex worktree turn was cancelled')
  if (error) throw error
  write(root, 'settlement.json', proof)
  await callbacks.onNative({ ...native, proofDigest: digest(proof) })
  return resultFromFinal(proof!.final, prompt, execution)
}
