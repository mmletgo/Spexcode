import { Ajv } from 'ajv'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainRoot, runtimeRoot, sessionArtifactPath } from '@spexcode/spec-core'
import { readRecord, withRecordLock, writeRecord } from './session-record.js'
import { codexStructuredTurn, codexStopStructuredTurn } from './codex-harness.js'
import { commitCodexGenerationRegistration, prepareCodexGenerationRegistration, readCodexGenerationLedger, resolveCodexGenerationForClose } from './codex-runtime-generations.js'
import { structuredGeneration, prepareStructuredRealm, prepareFrozenReaderRuntime, assertFrozenReaderRuntime, StructuredSessionError, StructuredSessionTransportError, structuredObserverState, structuredExecutionPolicy, structuredRealmRoot, type StructuredExecution, type FrozenReaderRuntime } from './session-structured-policy.js'
import { assertFrozenBinding, prepareFrozenPrompt, readFrozenManifest, verifyFrozenReadProof, type FrozenContextRef, type FrozenReadProof } from './frozen-context.js'
import { configuredSessionApplication } from './session-application.js'
import { withDeliveryLocks } from './delivery-lock.js'
export { StructuredSessionError } from './session-structured-policy.js'

export type StructuredSessionRequest = {
  root: string
  base?: string
  prompt: string
  schema: Record<string, unknown>
  requestKey: string
  inputDigest: string
  purpose: string
  timeoutMs: number
  signal?: AbortSignal
  model?: string
  effort?: StructuredExecution['effort']
  frozenContext?: FrozenContextRef
  /** 只有已登记reserveDispatch的内部资源桥设置；业务requestKey保持冻结清单绑定。 */
  sessionCreateKey?: string
  readerRuntime?: FrozenReaderRuntime
}
export type StructuredSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string; frozenReadProof?: FrozenReadProof }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requiredRealmRoot = (execution: StructuredExecution): string => {
  const root = structuredRealmRoot(execution)
  if (!root) throw new StructuredSessionError('unsupported', 'structured execution policy cannot select a trusted control realm')
  return root
}
const activeControllers = new Map<string, AbortController>()
const activeFinished = new Map<string, Promise<void>>()
const cancellations = new Map<string, Promise<StructuredCancellationResult>>()

export async function executeQueuedStructuredSession(id: string): Promise<StructuredExecution['state']> {
  const rec = readRecord(id)
  if (!rec?.structuredExecution) throw new StructuredSessionError('failed', 'queued structured session lost its execution policy')
  if (rec.structuredExecution.state && rec.structuredExecution.state !== 'running') return rec.structuredExecution.state
  const execution = rec.structuredExecution
  if (digest(structuredExecutionPolicy(execution)) !== digest({ ...execution, threadId: undefined, turnId: undefined, state: undefined, observer: undefined, cancellation: undefined, turnStartRequested: undefined, output: undefined, resultDigest: undefined, error: undefined, frozenReads: undefined, frozenReadProof: undefined }) || rec.harness !== 'codex-headless' || rec.launchCmd !== 'codex')
    throw new StructuredSessionError('unsupported', 'structured session no longer has the trusted fixed executor policy')
  const controller = new AbortController(); activeControllers.set(id, controller)
  let finish: () => void = () => {}
  activeFinished.set(id, new Promise<void>((resolvePromise) => { finish = resolvePromise }))
  const update = async (change: Partial<StructuredExecution>): Promise<void> => {
    await withRecordLock(id, async () => {
      const current = readRecord(id)
      if (!current?.structuredExecution) throw new StructuredSessionError('failed', 'structured session record disappeared')
      for (const field of ['threadId', 'turnId'] as const)
        if (current.structuredExecution[field] && change[field] && current.structuredExecution[field] !== change[field])
          throw new StructuredSessionError('stale_result', `structured ${field} cannot replace its pinned identity`)
      if (['completed', 'cancelling', 'cancelled', 'timeout'].includes(current.structuredExecution.state ?? '') && (change.state !== undefined || change.turnStartRequested !== undefined) && change.state !== current.structuredExecution.state)
        throw new StructuredSessionError(current.structuredExecution.state === 'completed' ? 'stale_result' : current.structuredExecution.cancellation?.reason ?? 'cancelled', current.structuredExecution.error || 'structured execution has already settled')
      const next = { ...current.structuredExecution, ...change }
      if (change.turnId && next.state === 'running') {
        configuredSessionApplication().transitionSession(id, { status: 'active', proposal: null, note: null })
        writeRecord({ ...current, status: 'active', proposal: null, note: null, launchOwner: null, launchReadinessStartedAt: null, structuredExecution: next })
      } else writeRecord({ ...current, structuredExecution: next })
    })
  }
  try {
    await update({ state: 'running' })
    const { endpoint, runtimeDir } = await structuredGeneration(requiredRealmRoot(execution), execution.readerRuntime)
    const result = await codexStructuredTurn(endpoint.socketPath, rec.worktreePath, readFileSync(sessionArtifactPath(id, 'launch'), 'utf8'), execution, {
      signal: controller.signal,
      onTimeout: async () => { await cancelStructuredSession(id, { reason: 'timeout' }) },
      onTurnStarting: async () => update({ turnStartRequested: true }),
      onThread: async (threadId) => {
        await withRecordLock(id, async () => {
          const current = readRecord(id)!
          if ((current.structuredExecution?.threadId && current.structuredExecution.threadId !== threadId) || (current.harnessSessionId && current.harnessSessionId !== threadId))
            throw new StructuredSessionError('stale_result', 'structured thread cannot replace its pinned identity')
          prepareCodexGenerationRegistration(runtimeDir, id, threadId, endpoint.id)
          writeRecord({ ...current, harnessSessionId: threadId, structuredExecution: { ...current.structuredExecution!, threadId, turnStartRequested: current.structuredExecution!.turnStartRequested ?? false } })
        })
        commitCodexGenerationRegistration(runtimeDir, id, threadId, endpoint.id)
      },
      onTurn: async (turnId) => update({ turnId }),
      onFrozenRead: async (receipt) => {
        await withRecordLock(id, async () => {
          const current = readRecord(id)!, state = current.structuredExecution!
          if (state.state !== 'running' || state.threadId !== receipt.threadId || state.turnId !== receipt.turnId)
            throw new StructuredSessionError('stale_result', 'frozen read cannot publish outside its active exact native turn')
          const receipts = state.frozenReads ?? [], previous = receipts.find(item => item.callId === receipt.callId)
          if (previous && digest(previous) !== digest(receipt)) throw new StructuredSessionError('stale_result', 'frozen native call identity was reused with different bytes')
          if (!previous) writeRecord({ ...current, structuredExecution: { ...state, frozenReads: [...receipts, receipt] } })
        })
      },
    })
    const output: unknown = JSON.parse(result.text)
    const validate = new Ajv({ allErrors: true }).compile(execution.schema)
    if (!validate(output)) throw new StructuredSessionError('failed', `structured output does not match JSON schema: ${JSON.stringify(validate.errors)}`)
    await update({ state: 'completed', threadId: result.threadId, turnId: result.turnId, output, resultDigest: digest(output), ...(result.frozenReadProof ? { frozenReadProof: result.frozenReadProof } : {}) })
    return 'completed'
  } catch (error) {
    // A disconnected transport is recoverable from the same exact thread/turn. Preserve the running state
    // for a subsequent create retry; deterministic model, policy and JSON failures remain terminal.
    const pendingStop = readRecord(id)?.structuredExecution
    if (pendingStop?.state === 'completed' || pendingStop?.state === 'cancelling' || pendingStop?.state === 'cancelled' || pendingStop?.state === 'timeout') return pendingStop.state
    if (error instanceof StructuredSessionTransportError) throw error
    if (error instanceof StructuredSessionError && error.code === 'cancellation_pending') {
      await update({ state: 'cancelling', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: false, acknowledged: false, error: error.message }, error: error.message })
      return 'cancelling'
    }
    const state = error instanceof StructuredSessionError && (error.code === 'cancelled' || error.code === 'timeout') ? error.code : 'failed'
    await update({ state, error: error instanceof Error ? error.message : String(error) })
    return state
  } finally { activeControllers.delete(id); activeFinished.delete(id); finish() }
}

export async function runStructuredSession(request: StructuredSessionRequest): Promise<StructuredSessionResult> {
  if (resolve(mainRoot(request.root)) !== resolve(mainRoot()))
    throw new StructuredSessionError('unsupported', 'structured execution root must belong to the backend project')
  if (!request.prompt.trim() || !request.inputDigest || !request.purpose || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0
    || !request.schema || request.schema.type !== 'object')
    throw new StructuredSessionError('failed', 'structured execution requires a prompt, input digest, purpose, bounded timeout and object JSON schema')
  if (!request.frozenContext) request = prepareFrozenPrompt(request, { directory: join(runtimeRoot(), 'frozen-context-v2') })
  const deadline = Date.now() + request.timeoutMs
  if (request.frozenContext) assertFrozenBinding(request.frozenContext, { ...readFrozenManifest(request.frozenContext).binding, requestKey: request.requestKey, inputDigest: request.inputDigest })
  const validate = new Ajv().compile(request.schema)
  if (request.frozenContext && !request.readerRuntime) request = { ...request, readerRuntime: await prepareFrozenReaderRuntime(join(runtimeRoot(), 'structured-frozen-read-only-v2')) }
  if (request.readerRuntime) assertFrozenReaderRuntime(request.readerRuntime, request.model)
  const { sessionCreateRequest, requestQueueDrain, queueStructuredRecovery, refreshQueueCandidate } = await import('./sessions.js')
  const execution = structuredExecutionPolicy(request)
  prepareStructuredRealm(requiredRealmRoot(execution), request.readerRuntime)
  const created = await sessionCreateRequest({ prompt: request.prompt, ...(request.base ? { base: request.base } : {}) }, {
    requestKey: request.sessionCreateKey ?? request.requestKey, signal: request.signal, timeoutMs: Math.min(30_000, request.timeoutMs), structuredExecution: execution,
  })
  if (created.status !== 201) throw new StructuredSessionError(created.code === 'session_create_key_reused' ? 'key_reused' : created.code === 'session_create_cancelled' ? 'cancelled' : created.code === 'session_create_timeout' ? 'timeout' : 'failed', created.error, { sessionId: created.termination?.sessionId })
  const id = created.session.id
  let cancelTask: Promise<StructuredCancellationResult> | undefined
  const cancel = (reason: 'cancelled' | 'timeout'): Promise<StructuredCancellationResult> => cancelTask ??= cancelStructuredSession(id, { reason })
  const onAbort = (): void => {
    // Retain the promise for the polling caller; the handler only prevents an event-callback rejection
    // from becoming unhandled before that caller awaits the exact cancellation result.
    void cancel('cancelled').catch(() => {})
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // Embedded callers have no index/graph watcher to refresh the queue's durable candidate cache.
    refreshQueueCandidate(id)
    requestQueueDrain()
    // Existing queue/drain owns execution capacity. A retry can rejoin an exact running native turn after
    // transport loss without manufacturing a second session or consulting an arbitrary assistant message.
    let recoveryRequested = false
    for (;;) {
      if (request.signal?.aborted) {
        const stopped = await cancel('cancelled')
        throw new StructuredSessionError(stopped.nativeStopped ? 'cancelled' : 'cancellation_pending', stopped.error || 'structured caller cancelled')
      }
      const rec = readRecord(id)
      const state = rec?.structuredExecution
      if (!state) throw new StructuredSessionError('stale_result', 'structured execution policy/result is missing')
      if (state.version !== execution.version || state.policy !== execution.policy || digest(structuredExecutionPolicy(state)) !== digest(execution))
        throw new StructuredSessionError('stale_result', 'structured result no longer matches its pinned input/schema/policy')
      if (state.state === 'completed') {
        if (!state.threadId || !state.turnId || !state.resultDigest || state.resultDigest !== digest(state.output) || !validate(state.output))
          throw new StructuredSessionError('stale_result', 'structured result identity or digest is invalid')
        if (state.frozenContext && (!state.frozenReadProof || state.frozenReadProof.contextDigest !== state.frozenContext.contextDigest || state.frozenReadProof.threadId !== state.threadId || state.frozenReadProof.turnId !== state.turnId))
          throw new StructuredSessionError('stale_result', 'structured frozen result lacks exact native history coverage evidence')
        if (state.frozenContext) {
          verifyFrozenReadProof(state.frozenContext, state.frozenReadProof!, { threadId: state.threadId, turnId: state.turnId })
          const runtimeDir = join(requiredRealmRoot(state), 'control'), ledger = readCodexGenerationLedger(runtimeDir)
          const binding = ledger.bindings[id], generation = binding && ledger.generations[binding.generationId]
          if (!generation || generation.state === 'reclaimed' || binding.threadId !== state.threadId || rec.harnessSessionId !== state.threadId)
            throw new StructuredSessionError('stale_result', 'frozen completed result lost its exact native generation binding')
          const recovered = await codexStructuredTurn(generation.endpoint.socketPath, rec.worktreePath, request.prompt, { ...state, timeoutMs: Math.max(1, deadline - Date.now()) }, {
            signal: request.signal, onThread: async () => { throw new StructuredSessionError('stale_result', 'completed recovery cannot create a new thread') },
            onTurn: async (turnId) => { if (turnId !== state.turnId) throw new StructuredSessionError('stale_result', 'completed recovery cannot replace its exact turn') },
            onFrozenRead: async () => { throw new StructuredSessionError('stale_result', 'completed recovery cannot reply to a new dynamic call') },
          })
          if (digest(JSON.parse(recovered.text)) !== state.resultDigest || digest(recovered.frozenReadProof) !== digest(state.frozenReadProof))
            throw new StructuredSessionError('stale_result', 'completed frozen result differs from exact native history')
        }
        return { sessionId: id, threadId: state.threadId, turnId: state.turnId, output: state.output, resultDigest: state.resultDigest, ...(state.frozenReadProof ? { frozenReadProof: state.frozenReadProof } : {}) }
      }
      if (state.state === 'cancelling') {
        if (state.cancellation?.error) throw new StructuredSessionError('cancellation_pending', state.cancellation.error)
        const stopped = await cancel(state.cancellation?.reason ?? 'cancelled')
        throw new StructuredSessionError(stopped.nativeStopped ? state.cancellation?.reason ?? 'cancelled' : 'cancellation_pending', stopped.error || 'structured cancellation settled')
      }
      if (state.state === 'cancelled' || state.state === 'timeout') {
        const stopped = await cancel(state.state)
        throw new StructuredSessionError(stopped.nativeStopped ? state.state : 'cancellation_pending', stopped.error || 'structured cancellation settlement recovered')
      }
      if (state.state === 'failed')
        throw new StructuredSessionError('failed', state.error || 'structured execution failed')
      if (state.state === 'running' && !recoveryRequested && structuredObserverState(state) === 'gone')
        recoveryRequested = await queueStructuredRecovery(id)
      if (Date.now() >= deadline) {
        const stopped = await cancel('timeout')
        throw new StructuredSessionError(stopped.nativeStopped ? 'timeout' : 'cancellation_pending', stopped.error || 'structured execution exceeded caller deadline')
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  } catch (error) {
    if (error instanceof StructuredSessionError) {
      const state = readRecord(id)?.structuredExecution
      throw new StructuredSessionError(error.code, error.message, { sessionId: id, threadId: state?.threadId, turnId: state?.turnId })
    }
    throw error
  } finally { request.signal?.removeEventListener('abort', onAbort) }
}


export type StructuredCancellationResult = {
  sessionId: string
  state: NonNullable<StructuredExecution['state']>
  threadId?: string
  turnId?: string
  nativeStopped: boolean
  acknowledged: boolean
  nativeStatus?: string
  error?: string
}

// Cancellation revokes result publication before native control. A queued task has no native turn to
// stop; an accepted task stops only its pinned turn and requires native acknowledgement + settled read.
export async function cancelStructuredSession(id: string, options: { reason?: 'cancelled' | 'timeout'; timeoutMs?: number } = {}): Promise<StructuredCancellationResult> {
  if ((options.reason !== undefined && !['cancelled', 'timeout'].includes(options.reason)) || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)))
    throw new StructuredSessionError('failed', 'structured cancellation needs a valid reason and positive bounded deadline', { sessionId: id })
  const existing = cancellations.get(id)
  if (existing) return existing
  // This control lock is distinct from the record lock: native RPC may wait while the observer
  // persists its exact identities and finishes. Cross-process callers join the same native cancellation.
  const flight = withDeliveryLocks([`structured-cancel-${id}`], async (): Promise<StructuredCancellationResult> => {
    let reason = options.reason ?? 'cancelled'
    const before = await withRecordLock(id, async () => {
      const rec = readRecord(id)
      if (!rec?.structuredExecution) throw new StructuredSessionError('unsupported', 'target is not a structured session', { sessionId: id })
      const execution = rec.structuredExecution
      if (execution.state === 'completed' || execution.cancellation?.nativeStopped) return rec
      reason = execution.cancellation?.reason ?? reason
      writeRecord({ ...rec, stopped: true, structuredExecution: { ...execution, state: 'cancelling', cancellation: {
        reason, requestedAt: execution.cancellation?.requestedAt ?? Date.now(), nativeStopped: false, acknowledged: execution.cancellation?.acknowledged ?? false,
      } } })
      return readRecord(id)!
    })
    const execution = before.structuredExecution!
    if (execution.state === 'completed' || execution.cancellation?.nativeStopped) {
      if (execution.cancellation?.nativeStopped) {
        activeControllers.get(id)?.abort()
        await activeFinished.get(id)
      }
      return { sessionId: id, state: execution.state!, threadId: execution.threadId, turnId: execution.turnId,
        nativeStopped: true, acknowledged: execution.cancellation?.acknowledged ?? false, nativeStatus: execution.cancellation?.nativeStatus ?? execution.state }
    }
    activeControllers.get(id)?.abort()
    const finished = activeFinished.get(id)
    if (finished && (execution.turnStartRequested || execution.turnId)) await finished
    const current = readRecord(id)!, state = current.structuredExecution!
    let stop: { nativeStopped: boolean; acknowledged: boolean; turnId?: string; nativeStatus?: string; error?: string }
    if ((!state.threadId || state.turnStartRequested === false) && !state.turnId) stop = { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
    else {
      const runtimeDir = join(requiredRealmRoot(state), 'control')
      const binding = state.threadId && current.harnessSessionId === state.threadId ? resolveCodexGenerationForClose(runtimeDir, id, state.threadId) : null
      if (!binding)
        stop = { nativeStopped: false, acknowledged: false, error: 'exact structured generation/thread binding is unavailable; native stop is unproven' }
      else if (binding.gone) stop = { nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' }
      else stop = await codexStopStructuredTurn(runtimeDir, binding.endpoint, state.threadId!, state.turnId,
        readFileSync(sessionArtifactPath(id, 'launch'), 'utf8'), options.timeoutMs ?? 15_000)
    }
    const result = await withRecordLock(id, async (): Promise<StructuredCancellationResult> => {
      const latest = readRecord(id)!, pinned = latest.structuredExecution!
      // A late native refusal/timeout cannot downgrade an already durable exact stop proof.
      if (pinned.cancellation?.nativeStopped)
        return { sessionId: id, state: pinned.state!, threadId: pinned.threadId, turnId: pinned.turnId,
          nativeStopped: true, acknowledged: pinned.cancellation.acknowledged, nativeStatus: pinned.cancellation.nativeStatus }
      const cancellation = { reason, requestedAt: pinned.cancellation!.requestedAt, ...stop, acknowledged: stop.acknowledged || pinned.cancellation!.acknowledged }
      const next = stop.nativeStopped ? reason : 'cancelling'
      const note = stop.nativeStopped ? `structured execution ${reason}; native ${stop.nativeStatus}` : `structured cancellation pending: ${stop.error}`
      configuredSessionApplication().transitionSession(id, { status: 'error', proposal: null, note })
      writeRecord({ ...latest, status: 'error', proposal: null, note, launchOwner: null, launchReadinessStartedAt: null,
        structuredExecution: { ...pinned, state: next, ...(stop.turnId ? { turnId: stop.turnId } : {}), cancellation, error: note } })
      return { sessionId: id, state: next, threadId: pinned.threadId, turnId: stop.turnId ?? pinned.turnId, ...stop, acknowledged: cancellation.acknowledged }
    })
    const { refreshQueueCandidate, requestQueueDrain } = await import('./sessions.js')
    refreshQueueCandidate(id); requestQueueDrain()
    return result
  })
  cancellations.set(id, flight)
  try { return await flight } finally { if (cancellations.get(id) === flight) cancellations.delete(id) }
}
