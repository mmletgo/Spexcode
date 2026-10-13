import { Ajv } from 'ajv'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getBlob, putBlob } from '@spexcode/spec-core'
import { readRecord, type SessRec } from '../session-record.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { cancelStructuredSession, runStructuredSession, StructuredSessionError, type StructuredCancellationResult } from '../session-structured.js'
import type { StructuredExecution } from '../session-structured-policy.js'
import type { ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult } from './elaboration-types.js'
import { SyncStoreError, type SyncStore } from './store.js'
import type { BlobRef, NativeSessionRef, SyncResourcePhase, WriteFence } from './operation-types.js'

type FrozenRequest = Omit<ElaborationSessionRequest, 'signal'>
export type NativeRunRecord = Pick<SessRec, 'session' | 'status' | 'harnessSessionId' | 'structuredExecution' | 'createRequestId' | 'createPayloadHash'>
export type AttemptRunnerOptions = {
  runtime?: { run: typeof runStructuredSession; cancel: typeof cancelStructuredSession; readRecord: (id: string) => NativeRunRecord | null }
  blobIO?: { put: (bytes: Buffer) => BlobRef; read: (ref: BlobRef) => Buffer }
  pollMs?: number
}
export type NativeRunPlan = {
  schemaVersion: 1; request: FrozenRequest; requestDigest: string; sessionCreateKey: string
  operationId: string; attemptId: string; inputId: string; candidateDigest: string | null; expectedSessionId: string
}
export type NativeRunCheckpoint = {
  schemaVersion: 1; operationId: string; attemptId: string; inputId: string; candidateDigest: string | null
  requestDigest: string; expectedSessionId: string; phase: SyncResourcePhase; nativeCallRequested: boolean
  nativeStarted: boolean; nativeState: StructuredExecution['state'] | 'queued' | 'unpublished'
  session: NativeSessionRef; result?: ElaborationSessionResult; status?: 'completed' | 'cancelled' | 'timeout'
  stop?: StructuredCancellationResult
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const hash = (value: unknown): string => sha(JSON.stringify(value))
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 为一个固定attempt连接既有结构化执行与资源证据，不承担候选发布或文件写入。 */
export function createAttemptRunner(store: SyncStore, fence: WriteFence, options: AttemptRunnerOptions = {}): ElaborationRunner {
  const operation = store.readOperation(fence.operationId)
  const evidenceDir = join(operation.input.source.commonDir, 'spexcode', 'evidence')
  const blobs = options.blobIO ?? { put: (bytes: Buffer): BlobRef => ({ sha256: putBlob(bytes, evidenceDir) }), read: (ref: BlobRef): Buffer => {
    const bytes = getBlob(ref.sha256, evidenceDir)
    if (!bytes) throw new StructuredSessionError('stale_result', 'native execution evidence blob is missing')
    return bytes
  } }
  const runtime = options.runtime ?? { run: runStructuredSession, cancel: cancelStructuredSession, readRecord }
  const flights = new Map<string, { digest: string; controller: AbortController; promise: Promise<ElaborationSessionResult> }>()
  const read = <T>(ref: BlobRef): T => {
    const bytes = blobs.read(ref)
    if (sha(bytes) !== ref.sha256) throw new StructuredSessionError('stale_result', 'native execution evidence blob digest is invalid')
    return JSON.parse(bytes.toString('utf8')) as T
  }
  const put = (value: unknown): BlobRef => blobs.put(Buffer.from(JSON.stringify(value)))

  const execute = async (request: FrozenRequest, requestDigest: string, controller: AbortController): Promise<ElaborationSessionResult> => {
    let resource = store.findResource(fence.attemptId, request.requestKey)
    const attempt = store.readAttempt(fence.attemptId)
    let dispatch = attempt.dispatchPlans.find(plan => plan.key === request.requestKey)
    if (resource && (!dispatch || dispatch.requestDigest !== requestDigest || resource.plan.payloadDigest !== requestDigest)) throw new StructuredSessionError('key_reused', 'native dispatch key was reused with different request bytes')
    if (!resource) dispatch = store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    if (!dispatch) throw new StructuredSessionError('stale_result', 'native resource lost its durable dispatch plan')
    const expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const execution: StructuredExecution = { version: 1, policy: 'codex-read-only-v1', schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs, ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}) }
    const expectedCreateHash = hash({ prompt: request.prompt, parent: null, launcher: null, ...(request.base?.trim() ? { base: request.base.trim() } : {}), structuredExecution: execution })
    const validate = new Ajv({ allErrors: true }).compile(request.schema)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: resource ? resource.plan.candidateDigest : attempt.candidate?.digest ?? null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    let checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    const errorIdentity = (): { sessionId: string; threadId?: string; turnId?: string } => ({ sessionId: expectedSessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined })
    const checkEvidence = (value: NativeRunCheckpoint): void => {
      if (value.schemaVersion !== 1 || value.operationId !== identity.operationId || value.attemptId !== identity.attemptId || value.inputId !== identity.inputId || value.candidateDigest !== identity.candidateDigest || value.requestDigest !== requestDigest || value.expectedSessionId !== expectedSessionId || value.session.sessionId !== expectedSessionId) throw new StructuredSessionError('stale_result', 'native checkpoint identity does not match fixed dispatch')
    }
    const checkResult = (result: ElaborationSessionResult): void => {
      if (!result || result.sessionId !== expectedSessionId || !result.threadId || !result.turnId || (checkpoint.session.threadId !== null && result.threadId !== checkpoint.session.threadId) || (checkpoint.session.turnId !== null && result.turnId !== checkpoint.session.turnId) || !validate(result.output) || result.resultDigest !== hash(result.output)) throw new StructuredSessionError('stale_result', 'native result identity, schema or hash is invalid')
    }
    if (resource) {
      const savedPlan = read<NativeRunPlan>(resource.plan.planBlob)
      if (hash(savedPlan) !== hash(plan)) throw new StructuredSessionError('key_reused', 'native resource plan differs from frozen request')
      checkpoint = read<NativeRunCheckpoint>(resource.checkpointRef); checkEvidence(checkpoint)
      if (resource.phase === 'removed') {
        if (checkpoint.status !== 'completed' || !checkpoint.result) throw new StructuredSessionError(checkpoint.status === 'timeout' ? 'timeout' : 'cancelled', 'native execution has already stopped', errorIdentity())
        checkResult(checkpoint.result)
        return copy(checkpoint.result)
      }
    } else {
      const initial = put(checkpoint)
      resource = store.planResource(fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: identity.inputId, candidateDigest: identity.candidateDigest, planBlob: put(plan), checkpointRef: initial })
    }
    const save = (next: NativeRunCheckpoint): void => {
      checkEvidence(next)
      const ref = put(next)
      resource = store.recordResourceCheckpoint(resource!.id, { ...identity, phase: next.phase, expectedCheckpointRef: resource!.checkpointRef, checkpointRef: ref })
      checkpoint = next
    }
    const authority = (): boolean => {
      try { store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest }); return true }
      catch (error) { if (error instanceof SyncStoreError && error.code === 'SYNC_FENCE_EXPIRED') return false; throw error }
    }
    const observe = (): NativeRunRecord | null => {
      const record = runtime.readRecord(expectedSessionId)
      if (!record) return null
      const state = record.structuredExecution
      if (record.session !== expectedSessionId || !state || record.createRequestId !== sha(dispatch!.sessionCreateKey) || record.createPayloadHash !== expectedCreateHash || hash({ version: state.version, policy: state.policy, schema: state.schema, inputDigest: state.inputDigest, purpose: state.purpose, timeoutMs: state.timeoutMs, ...(state.model ? { model: state.model } : {}), ...(state.effort ? { effort: state.effort } : {}) }) !== hash(execution) || (record.harnessSessionId !== null && record.harnessSessionId !== state.threadId)) throw new StructuredSessionError('stale_result', 'published native record differs from fixed request or policy')
      const session: NativeSessionRef = { sessionId: expectedSessionId, threadId: state.threadId ?? null, turnId: state.turnId ?? null }
      if ((checkpoint.session.threadId && checkpoint.session.threadId !== session.threadId) || (checkpoint.session.turnId && checkpoint.session.turnId !== session.turnId)) throw new StructuredSessionError('stale_result', 'native thread or turn identity was replaced')
      if (resource!.phase === 'planned' || resource!.phase === 'created') {
        const next: NativeRunCheckpoint = { ...checkpoint, phase: 'created' as const, nativeState: state.state ?? 'queued', nativeStarted: !!state.turnId, session }
        if (hash(next) !== hash(checkpoint)) save(next)
      }
      if (authority()) store.bindSession(fence, request.requestKey, session)
      return record
    }
    const settle = (status: 'completed' | 'cancelled' | 'timeout', extra: { result?: ElaborationSessionResult; stop?: StructuredCancellationResult }): void => {
      if (resource!.phase !== 'terminal') save({ ...checkpoint, ...extra, status, phase: 'terminal' })
      save({ ...checkpoint, phase: 'removed' })
    }
    const stop = async (): Promise<never> => {
      controller.abort()
      const record = observe()
      if (!record && !checkpoint.nativeCallRequested) {
        settle('cancelled', { stop: { sessionId: expectedSessionId, state: 'cancelled', nativeStopped: true, acknowledged: false, nativeStatus: 'notDispatched' } })
        throw new StructuredSessionError('cancelled', 'native request cancelled before dispatch', errorIdentity())
      }
      if (!record) throw new StructuredSessionError('cancellation_pending', 'native creation may be in progress; absence is not stop proof', errorIdentity())
      let stopped: StructuredCancellationResult | undefined
      let failure: unknown
      try { stopped = await runtime.cancel(expectedSessionId, { reason: 'cancelled', timeoutMs: Math.min(15_000, request.timeoutMs) }) }
      catch (error) { failure = error }
      const after = observe()
      if (!after?.structuredExecution) throw new StructuredSessionError('cancellation_pending', 'native record disappeared before exact stop proof', errorIdentity())
      const state = after.structuredExecution
      const durableStop = state.cancellation?.nativeStopped && (state.state === 'cancelled' || state.state === 'timeout')
      if (!stopped && durableStop) stopped = { sessionId: expectedSessionId, state: state.state!, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation!.acknowledged, nativeStatus: state.cancellation!.nativeStatus }
      if (stopped?.nativeStopped && stopped.sessionId === expectedSessionId && ['completed', 'cancelled', 'timeout'].includes(stopped.state) && (stopped.threadId ?? null) === (state.threadId ?? null) && (stopped.turnId ?? null) === (state.turnId ?? null)) settle(stopped.state === 'timeout' ? 'timeout' : 'cancelled', { stop: stopped })
      if (failure) throw failure
      throw new StructuredSessionError(resource!.phase === 'removed' ? 'cancelled' : 'cancellation_pending', resource!.phase === 'removed' ? 'native execution cancelled and exact stop settled' : stopped?.error ?? 'native cancellation has not been proven', errorIdentity())
    }
    if (resource.phase === 'terminal') {
      if (checkpoint.stop?.nativeStopped && checkpoint.stop.sessionId === expectedSessionId && ['completed', 'cancelled', 'timeout'].includes(checkpoint.stop.state) && (checkpoint.stop.threadId ?? null) === checkpoint.session.threadId && (checkpoint.stop.turnId ?? null) === checkpoint.session.turnId) {
        save({ ...checkpoint, phase: 'removed' })
        throw new StructuredSessionError(checkpoint.status === 'timeout' ? 'timeout' : 'cancelled', 'native execution stop evidence was already settled', errorIdentity())
      }
      if (checkpoint.status === 'completed' && checkpoint.result) { checkResult(checkpoint.result); settle('completed', { result: checkpoint.result }); return copy(checkpoint.result) }
      return stop()
    }
    if (controller.signal.aborted || !authority()) return stop()
    save({ ...checkpoint, nativeCallRequested: true })
    let outcome: { ok: true; result: ElaborationSessionResult } | { ok: false; error: unknown } | undefined
    Promise.resolve().then(() => runtime.run({ ...request, requestKey: dispatch!.sessionCreateKey, signal: controller.signal })).then(result => { outcome = { ok: true, result } }, error => { outcome = { ok: false, error } })
    for (;;) {
      observe()
      if (controller.signal.aborted || !authority()) return await stop()
      if (outcome) {
        if (!outcome.ok) {
          const state = runtime.readRecord(expectedSessionId)?.structuredExecution
          if (state?.cancellation?.nativeStopped && (state.state === 'cancelled' || state.state === 'timeout')) settle(state.state, { stop: { sessionId: expectedSessionId, state: state.state, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation.acknowledged, nativeStatus: state.cancellation.nativeStatus } })
          throw outcome.error
        }
        const record = observe(), state = record?.structuredExecution
        checkResult(outcome.result)
        if (state?.state !== 'completed' || state.threadId !== outcome.result.threadId || state.turnId !== outcome.result.turnId || state.resultDigest !== outcome.result.resultDigest || hash(state.output) !== outcome.result.resultDigest) throw new StructuredSessionError('stale_result', 'native result lacks matching durable exact-turn completion')
        settle('completed', { result: copy(outcome.result) })
        return copy(outcome.result)
      }
      await new Promise<void>(resolve => setTimeout(resolve, options.pollMs ?? 50))
    }
  }
  return async request => {
    const { signal, ...value } = request
    const frozen = copy(value), requestDigest = hash(frozen)
    let flight = flights.get(frozen.requestKey)
    if (flight && flight.digest !== requestDigest) throw new StructuredSessionError('key_reused', 'native request key was reused with different bytes')
    if (!flight) {
      const controller = new AbortController()
      if (signal?.aborted) controller.abort()
      const promise = execute(frozen, requestDigest, controller)
      flight = { digest: requestDigest, controller, promise }; flights.set(frozen.requestKey, flight)
    }
    const current = flight
    if (signal?.aborted) current.controller.abort()
    const abort = (): void => current.controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    try { return copy(await current.promise) }
    finally { signal?.removeEventListener('abort', abort); if (flights.get(frozen.requestKey) === current) flights.delete(frozen.requestKey) }
  }
}
