import { Ajv } from 'ajv'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getBlob, putBlob, runtimeRoot } from '@spexcode/spec-core'
import { readRecord, type SessRec } from '../session-record.js'
import { closeSession, sessionIdForCreateKey, readSessionCreateTermination, recoverSessionCreateTermination, verifyPreservedSessionCreateTermination, type SessionCreateTermination } from '../sessions.js'
import { cancelStructuredSession, runStructuredSession, SettledSessionCreateTimeoutError, StructuredSessionError, type StructuredCancellationResult } from '../session-structured.js'
import { assertRejectedOutput, prepareFrozenReaderRuntime, structuredExecutionPolicy, pinNativeConfiguration, pinZCodeToolPolicy, type FrozenReaderRuntime, type StructuredExecution } from '../session-structured-policy.js'
import { assertFrozenBinding, prepareFrozenPrompt } from '../frozen-context.js'
import { verifyStructuredFrozenReadProof as verifyFrozenReadProof } from '../structured-frozen-evidence.js'
import { nativeWorktreePrompt } from '../native-worktree-runtime.js'
import { verifyStageResult } from './stage-worktree.js'
import { withoutSessionApplicationExecutionWake } from '../session-application.js'
import { zcodeNativeModel } from '../zcode-structured.js'
import type { ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult } from './elaboration-types.js'
import { SyncStoreError, type SyncStore } from './store.js'
import type { BlobRef, NativeSessionRef, SyncResourcePhase, WriteFence } from './operation-types.js'
import type { SyncAttempt, SyncOperation } from './operation-types.js'

type FrozenRequest = Omit<ElaborationSessionRequest, 'signal'> & { readerRuntime?: FrozenReaderRuntime }

/** 同步冻结与原件冷验共用CLI配置规则；历史请求保持原字段及执行强度。 */
export function pinSyncNativeRequest(request: FrozenRequest, saved: Pick<StructuredExecution, 'nativeConfiguration' | 'zcodeToolPolicy' | 'effort'> | null): FrozenRequest {
  const nativeConfiguration = pinNativeConfiguration(request, saved), zcodeToolPolicy = pinZCodeToolPolicy(request, saved)
  const pinned = { ...request, ...(nativeConfiguration ? { nativeConfiguration } : {}), ...(zcodeToolPolicy ? { zcodeToolPolicy } : {}) }
  if (nativeConfiguration && saved?.effort === undefined) delete pinned.effort
  return pinned
}
export type NativeRunRecord = Pick<SessRec, 'session' | 'status' | 'harnessSessionId' | 'structuredExecution' | 'createRequestId' | 'createPayloadHash'> & Partial<Pick<SessRec, 'worktreePath'>>
export type AttemptRunnerOptions = {
  resourceRecoveryOnly?: true
  retireSettledWorktrees?: true
  runtime?: { run: typeof runStructuredSession; cancel: typeof cancelStructuredSession; readRecord: (id: string) => NativeRunRecord | null; readCreateTermination?: typeof readSessionCreateTermination; recoverCreateTermination?: typeof recoverSessionCreateTermination }
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
  session: NativeSessionRef; result?: ElaborationSessionResult; status?: 'completed' | 'cancelled' | 'timeout' | 'failed'
  failure?: { code: StructuredSessionError['code']; message: string; rejectedOutput?: StructuredSessionError['rejectedOutput']; failedWorktree?: StructuredSessionError['failedWorktree'] }
  stop?: StructuredCancellationResult
  creationTermination?: SessionCreateTermination
}
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const hash = (value: unknown): string => sha(JSON.stringify(value))
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

type NativeFailureIdentity = { code?: string; message?: string; sessionId?: string; threadId?: string; turnId?: string; requestKey?: string; inputDigest?: string }

export function hasSettledNativeRpcFailure(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, failure: NativeFailureIdentity): boolean {
  return failure.code === 'native_rpc_timeout' && hasSettledNativeFailure(store, operation, attempt, failure)
}

export function hasSettledNativeTurnTransportFailure(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, failure: NativeFailureIdentity): boolean {
  return failure.code === 'native_turn_transport_failed' && hasSettledNativeFailure(store, operation, attempt, failure)
}

function hasSettledNativeFailure(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, failure: NativeFailureIdentity): boolean {
  const current = store.readOperation(operation.id)
  if (!failure.sessionId || current.control !== 'run' || current.currentAttemptId !== attempt.id || current.generation !== attempt.generation || ['failed', 'superseded', 'settled'].includes(attempt.status) || attempt.expiresAtMs <= Date.now() || store.readPhysicalControl(current.input.source).control !== 'run') return false
  const resources = attempt.dispatchPlans.map(dispatch => ({ dispatch, resource: store.findResource(attempt.id, dispatch.key) }))
  if (resources.some(({ resource }) => !resource || resource.phase !== 'removed')) return false
  const directory = join(operation.input.source.commonDir, 'spexcode', 'evidence')
  const read = <T>(ref: BlobRef): T => {
    const bytes = getBlob(ref.sha256, directory)
    if (!bytes || sha(bytes) !== ref.sha256) throw new StructuredSessionError('stale_result', 'native RPC settlement evidence object is missing or invalid')
    return JSON.parse(bytes.toString('utf8')) as T
  }
  return resources.some(({ dispatch, resource }) => {
    if (resource!.plan.kind !== 'native_session') return false
    const plan = read<NativeRunPlan>(resource!.plan.planBlob), checkpoint = read<NativeRunCheckpoint>(resource!.checkpointRef), stop = checkpoint.stop
    const settled = resource!.operationId === operation.id && resource!.attemptId === attempt.id && resource!.generation === attempt.generation && resource!.plan.inputId === operation.input.id && plan.operationId === operation.id && plan.attemptId === attempt.id && plan.inputId === operation.input.id && plan.expectedSessionId === failure.sessionId && plan.sessionCreateKey === dispatch.sessionCreateKey && plan.expectedSessionId === sessionIdForCreateKey(dispatch.sessionCreateKey) && plan.request.requestKey === dispatch.key && plan.requestDigest === dispatch.requestDigest && plan.requestDigest === resource!.plan.payloadDigest && plan.requestDigest === hash(plan.request)
      && (failure.requestKey === undefined || failure.requestKey === plan.request.requestKey) && (failure.inputDigest === undefined || failure.inputDigest === plan.request.inputDigest) && checkpoint.operationId === plan.operationId && checkpoint.attemptId === plan.attemptId && checkpoint.inputId === plan.inputId && checkpoint.candidateDigest === plan.candidateDigest && checkpoint.candidateDigest === resource!.plan.candidateDigest && checkpoint.requestDigest === plan.requestDigest && checkpoint.expectedSessionId === plan.expectedSessionId && checkpoint.phase === 'removed' && checkpoint.status === 'failed' && checkpoint.nativeState === 'failed' && checkpoint.failure?.code === failure.code && checkpoint.failure?.message === failure.message
      && stop?.nativeStopped === true && stop.state === 'failed' && stop.sessionId === failure.sessionId && checkpoint.session.sessionId === stop.sessionId && checkpoint.session.threadId === (stop.threadId ?? null) && checkpoint.session.turnId === (stop.turnId ?? null) && stop.threadId === failure.threadId && stop.turnId === failure.turnId
    if (!settled || failure.code !== 'native_turn_transport_failed') return settled
    return resource!.plan.key === dispatch.key && plan.schemaVersion === 1 && checkpoint.schemaVersion === 1
      && plan.request.model?.startsWith('zcode:') === true && !!plan.request.worktree && !plan.request.frozenContext
      && (plan.request.purpose === 'code_behavior_analyze' || plan.request.purpose === 'code_behavior_review') && dispatch.purpose === plan.request.purpose
      && failure.requestKey === plan.request.requestKey && failure.inputDigest === plan.request.inputDigest && !!failure.threadId && !!failure.turnId
      && dispatch.session?.sessionId === checkpoint.session.sessionId && dispatch.session.threadId === checkpoint.session.threadId && dispatch.session.turnId === checkpoint.session.turnId
      && checkpoint.nativeCallRequested && checkpoint.nativeStarted && stop?.nativeStatus === 'stopped'
      && !checkpoint.failure?.failedWorktree && !checkpoint.failure?.rejectedOutput && !checkpoint.result
  })
}

/** 为一个固定attempt连接既有结构化执行与资源证据，不承担候选发布或文件写入。 */
export function createAttemptRunner(store: SyncStore, fence: WriteFence, options: AttemptRunnerOptions = {}): ElaborationRunner {
  const operation = store.readOperation(fence.operationId)
  const evidenceDir = join(operation.input.source.commonDir, 'spexcode', 'evidence')
  const blobs = options.blobIO ?? { put: (bytes: Buffer): BlobRef => ({ sha256: putBlob(bytes, evidenceDir) }), read: (ref: BlobRef): Buffer => {
    const bytes = getBlob(ref.sha256, evidenceDir)
    if (!bytes) throw new StructuredSessionError('stale_result', 'native execution evidence object is missing')
    return bytes
  } }
  const runtime = options.runtime ?? { run: runStructuredSession, cancel: cancelStructuredSession, readRecord, readCreateTermination: readSessionCreateTermination, recoverCreateTermination: recoverSessionCreateTermination }
  const flights = new Map<string, { digest: string; controller: AbortController; promise: Promise<ElaborationSessionResult> }>()
  const read = <T>(ref: BlobRef): T => {
    const bytes = blobs.read(ref)
    if (sha(bytes) !== ref.sha256) throw new StructuredSessionError('stale_result', 'native execution evidence object digest is invalid')
    return JSON.parse(bytes.toString('utf8')) as T
  }
  const put = (value: unknown): BlobRef => blobs.put(Buffer.from(JSON.stringify(value)))

  const execute = async (request: FrozenRequest, requestDigest: string, controller: AbortController): Promise<ElaborationSessionResult> => {
    if (request.frozenContext) assertFrozenBinding(request.frozenContext, { requestKey: request.requestKey, inputDigest: request.inputDigest, attemptId: fence.attemptId, policyDigest: operation.policyDigest })
    let resource = store.findResource(fence.attemptId, request.requestKey)
    const attempt = store.readAttempt(fence.attemptId)
    let dispatch = attempt.dispatchPlans.find(plan => plan.key === request.requestKey)
    if (resource && (!dispatch || dispatch.requestDigest !== requestDigest || resource.plan.payloadDigest !== requestDigest)) throw new StructuredSessionError('key_reused', 'native dispatch key was reused with different request bytes')
    if (!resource) dispatch = store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    if (!dispatch) throw new StructuredSessionError('stale_result', 'native resource lost its durable dispatch plan')
    const expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const execution = structuredExecutionPolicy(request)
    const creationPrompt = request.worktree ? nativeWorktreePrompt(request.prompt, request.worktree) : request.prompt
    const creationBase = request.worktree?.baseCommit ?? request.base
    const expectedCreateHash = hash({ prompt: creationPrompt, parent: null, launcher: null, ...(creationBase?.trim() ? { base: creationBase.trim() } : {}), structuredExecution: execution })
    const validate = new Ajv({ allErrors: true }).compile(request.schema)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: resource ? resource.plan.candidateDigest : attempt.candidate?.digest ?? null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    let checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    const errorIdentity = (): { sessionId: string; threadId?: string; turnId?: string; requestKey: string; inputDigest: string } => ({ sessionId: expectedSessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined, requestKey: request.requestKey, inputDigest: request.inputDigest })
    const checkEvidence = (value: NativeRunCheckpoint): void => {
      if (value.schemaVersion !== 1 || value.operationId !== identity.operationId || value.attemptId !== identity.attemptId || value.inputId !== identity.inputId || value.candidateDigest !== identity.candidateDigest || value.requestDigest !== requestDigest || value.expectedSessionId !== expectedSessionId || value.session.sessionId !== expectedSessionId) throw new StructuredSessionError('stale_result', 'native checkpoint identity does not match fixed dispatch')
    }
    const checkResult = (result: ElaborationSessionResult): void => {
      if (!result || result.sessionId !== expectedSessionId || !result.threadId || !result.turnId || (checkpoint.session.threadId !== null && result.threadId !== checkpoint.session.threadId) || (checkpoint.session.turnId !== null && result.turnId !== checkpoint.session.turnId) || !validate(result.output) || result.resultDigest !== hash(result.output)) throw new StructuredSessionError('stale_result', 'native result identity, schema or hash is invalid')
      if (request.worktree) {
        try { verifyStageResult(operation.input.source.commonDir, request.worktree, result) }
        catch (error) { throw new StructuredSessionError('stale_result', (error as Error).message) }
      }
      if (request.frozenContext) {
        if (!result.frozenReadProof) throw new StructuredSessionError('stale_result', 'native frozen result has no real history coverage evidence')
        if (execution.version === (execution.timeoutMs === null ? 5 : 3) && execution.policy === 'claude-frozen-read-only-v1' && (result.frozenReadProof.version !== 3 || result.frozenReadProof.model !== request.model?.slice(7))) throw new StructuredSessionError('stale_result', 'Claude result lacks its exact native provider/model evidence')
        if (execution.version === (execution.timeoutMs === null ? 5 : 4) && execution.policy === 'zcode-frozen-read-only-v1') {
          const model = zcodeNativeModel(request.model)
          if (result.frozenReadProof.version !== 4 || result.frozenReadProof.providerId !== model.providerId || result.frozenReadProof.modelId !== model.modelId) throw new StructuredSessionError('stale_result', 'ZCode result lacks its exact native provider/model evidence')
        }
        verifyFrozenReadProof(request.frozenContext, result.frozenReadProof, { threadId: result.threadId, turnId: result.turnId }, request.readerRuntime?.version === 2 ? request.readerRuntime.toolOutputTokenLimit : undefined, { output: result.output })
      }
    }
    const creationTermination = (): SessionCreateTermination | null => {
      const receipt = runtime.readCreateTermination?.(dispatch!.sessionCreateKey) ?? null
      if (!receipt) return null
      const dispositionValid = receipt.version === 1 && receipt.cleanupComplete === true && !('disposition' in receipt) && !('retained' in receipt)
        || receipt.version === 2 && receipt.disposition === 'preserved' && receipt.cleanupComplete === false && receipt.code === 'session_create_cancelled' && receipt.phase === 'cleanup' && !!receipt.retained
      if (!dispositionValid || receipt.sessionId !== expectedSessionId || receipt.requestDigest !== sha(dispatch!.sessionCreateKey) || receipt.payloadHash !== expectedCreateHash || !['session_create_cancelled', 'session_create_timeout'].includes(receipt.code) || receipt.nativeStopped !== true || receipt.nativeStatus !== 'notStarted' || checkpoint.session.threadId || checkpoint.session.turnId || checkpoint.nativeStarted)
        throw new StructuredSessionError('stale_result', 'native creation termination differs from fixed request or started execution', errorIdentity())
      if (receipt.version === 2) {
        try { verifyPreservedSessionCreateTermination(receipt) }
        catch (error) { throw new StructuredSessionError('stale_result', error instanceof Error ? error.message : String(error), errorIdentity()) }
      }
      return receipt
    }
    const stoppedFailedEvidence = (state: StructuredExecution): NativeRunCheckpoint['failure'] | null => {
      if (state.state !== 'failed' || !state.cancellation?.nativeStopped) return null
      if (state.errorCode === 'native_turn_transport_failed' && (!request.worktree || !request.model?.startsWith('zcode:') || !state.threadId || !state.turnId
        || state.zcodeNative?.sessionId !== state.threadId || state.zcodeNative.turnId !== state.turnId || state.cancellation.nativeStatus !== 'stopped'
        || state.failedWorktree || state.rejectedOutput || state.resultWorktree || state.output !== undefined || state.resultDigest !== undefined)) throw new StructuredSessionError('stale_result', 'typed native turn transport failure lacks its exact stopped ZCode identity', errorIdentity())
      let rejectedOutput: StructuredSessionError['rejectedOutput']
      if (state.rejectedOutput) {
        assertRejectedOutput(state.rejectedOutput, creationPrompt, execution, state)
        const { ref: _ref, ...packet } = state.rejectedOutput
        rejectedOutput = packet
      }
      if (state.failedWorktree) {
        if (!request.worktree || !rejectedOutput && !['structured_output_format_invalid', 'structured_output_retries_exhausted'].includes(state.errorCode ?? '')) throw new StructuredSessionError('stale_result', 'failed Git witness lacks its original rejected request', errorIdentity())
        verifyStageResult(operation.input.source.commonDir, request.worktree, { worktree: state.failedWorktree })
      }
      return { code: state.errorCode ?? 'failed', message: state.error!, ...(rejectedOutput ? { rejectedOutput } : {}), ...(state.failedWorktree ? { failedWorktree: state.failedWorktree } : {}) }
    }
    const restoreSettledCreationTermination = (saved?: SessionCreateTermination): SettledSessionCreateTimeoutError | null => {
      if (!saved) return null
      const receipt = creationTermination()
      if (!receipt) throw new StructuredSessionError('stale_result', 'native creation termination canonical receipt is missing', errorIdentity())
      if (hash(receipt) !== hash(saved)) throw new StructuredSessionError('stale_result', 'native creation termination checkpoint differs from its canonical receipt', errorIdentity())
      return receipt.code === 'session_create_timeout' ? new SettledSessionCreateTimeoutError(receipt) : null
    }
    const restoreSettledFailure = (): StructuredSessionError | null => {
      if (checkpoint.status !== 'failed') return null
      const stop = checkpoint.stop
      if (!checkpoint.failure || checkpoint.nativeState !== 'failed' || !stop?.nativeStopped || stop.state !== 'failed' || stop.sessionId !== expectedSessionId || (stop.threadId ?? null) !== checkpoint.session.threadId || (stop.turnId ?? null) !== checkpoint.session.turnId) throw new StructuredSessionError('stale_result', 'native failure lacks its exact durable stop evidence', errorIdentity())
      const record = runtime.readRecord(expectedSessionId), state = record?.structuredExecution
      if (checkpoint.failure.code === 'native_turn_transport_failed' && (!record || !state || record.session !== expectedSessionId || record.createRequestId !== sha(dispatch!.sessionCreateKey) || record.createPayloadHash !== expectedCreateHash
        || hash(structuredExecutionPolicy(state)) !== hash(execution) || record.harnessSessionId !== null && record.harnessSessionId !== state.threadId
        || dispatch!.session?.sessionId !== expectedSessionId || dispatch!.session.threadId !== checkpoint.session.threadId || dispatch!.session.turnId !== checkpoint.session.turnId
        || state.threadId !== stop.threadId || state.turnId !== stop.turnId || state.cancellation?.acknowledged !== stop.acknowledged || state.cancellation?.nativeStatus !== stop.nativeStatus
        || checkpoint.result || hash(stoppedFailedEvidence(state)) !== hash(checkpoint.failure))) throw new StructuredSessionError('stale_result', 'typed native turn transport checkpoint differs from its canonical stopped failure', errorIdentity())
      if (checkpoint.failure.failedWorktree && !checkpoint.failure.rejectedOutput && (!record || !state || record.session !== expectedSessionId || record.worktreePath !== checkpoint.failure.failedWorktree.worktreePath || record.createRequestId !== sha(dispatch!.sessionCreateKey) || record.createPayloadHash !== expectedCreateHash || hash(structuredExecutionPolicy(state)) !== hash(execution) || record.harnessSessionId !== null && record.harnessSessionId !== state.threadId || state.state !== 'failed' || (state.errorCode ?? 'failed') !== checkpoint.failure.code || state.error !== checkpoint.failure.message || state.threadId !== stop.threadId || state.turnId !== stop.turnId || state.cancellation?.nativeStopped !== true || state.cancellation.acknowledged !== stop.acknowledged || state.cancellation.nativeStatus !== stop.nativeStatus || state.cancellation.error !== stop.error || hash(state.failedWorktree ?? null) !== hash(checkpoint.failure.failedWorktree ?? null))) throw new StructuredSessionError('stale_result', 'native failure checkpoint differs from its canonical stopped failed record', errorIdentity())
      let rejectedOutput = checkpoint.failure.rejectedOutput
      if (rejectedOutput) {
        assertRejectedOutput(rejectedOutput, creationPrompt, execution, errorIdentity())
        const ref = blobs.put(Buffer.from(rejectedOutput.text, 'utf8'))
        if (ref.sha256 !== rejectedOutput.sha256) throw new StructuredSessionError('stale_result', 'failed native packet differs from its original bytes', errorIdentity())
        rejectedOutput = { ...rejectedOutput, ref }
      }
      if (checkpoint.failure.failedWorktree) {
        if (!request.worktree || !checkpoint.failure.rejectedOutput && !['structured_output_format_invalid', 'structured_output_retries_exhausted'].includes(checkpoint.failure.code)) throw new StructuredSessionError('stale_result', 'failed Git witness lacks its exact rejected native request', errorIdentity())
        verifyStageResult(operation.input.source.commonDir, request.worktree, { worktree: checkpoint.failure.failedWorktree })
      }
      return new StructuredSessionError(checkpoint.failure.code, checkpoint.failure.message, { ...errorIdentity(), rejectedOutput, failedWorktree: checkpoint.failure.failedWorktree })
    }
    if (resource) {
      const savedPlan = read<NativeRunPlan>(resource.plan.planBlob)
      if (hash(savedPlan) !== hash(plan)) throw new StructuredSessionError('key_reused', 'native resource plan differs from frozen request')
      checkpoint = read<NativeRunCheckpoint>(resource.checkpointRef); checkEvidence(checkpoint)
      if (resource.phase === 'removed') {
        const rpcFailure = restoreSettledFailure()
        if (rpcFailure) throw rpcFailure
        if (checkpoint.status !== 'completed' || !checkpoint.result) {
          const settledTimeout = restoreSettledCreationTermination(checkpoint.creationTermination)
          if (settledTimeout) throw settledTimeout
          throw new StructuredSessionError(checkpoint.status === 'timeout' ? 'timeout' : 'cancelled', 'native execution has already stopped', errorIdentity())
        }
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
    const authority = (fresh = false): boolean => {
      try {
        store.assertObservedDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest }, fresh)
        return true
      }
      catch (error) { if (error instanceof SyncStoreError && error.code === 'SYNC_FENCE_EXPIRED') return false; throw error }
    }
    let boundSession = dispatch.session
    const observe = (): NativeRunRecord | null => {
      const record = runtime.readRecord(expectedSessionId)
      if (!record) return null
      const state = record.structuredExecution
      if (record.session !== expectedSessionId || !state || record.createRequestId !== sha(dispatch!.sessionCreateKey) || record.createPayloadHash !== expectedCreateHash || hash(structuredExecutionPolicy(state)) !== hash(execution) || state.version !== execution.version || state.policy !== execution.policy || (record.harnessSessionId !== null && record.harnessSessionId !== state.threadId)) throw new StructuredSessionError('stale_result', 'published native record differs from fixed request or policy')
      const session: NativeSessionRef = { sessionId: expectedSessionId, threadId: state.threadId ?? null, turnId: state.turnId ?? null }
      if ((checkpoint.session.threadId && checkpoint.session.threadId !== session.threadId) || (checkpoint.session.turnId && checkpoint.session.turnId !== session.turnId)) throw new StructuredSessionError('stale_result', 'native thread or turn identity was replaced')
      if (resource!.phase === 'planned' || resource!.phase === 'created') {
        const next: NativeRunCheckpoint = { ...checkpoint, phase: 'created' as const, nativeState: state.state ?? 'queued', nativeStarted: !!state.turnId, session }
        if (hash(next) !== hash(checkpoint)) save(next)
      }
      if ((!boundSession || boundSession.sessionId !== session.sessionId || boundSession.threadId !== session.threadId || boundSession.turnId !== session.turnId) && !controller.signal.aborted && authority()) {
        store.bindSession(fence, request.requestKey, session)
        boundSession = session
      }
      return record
    }
    let outcome: { ok: true; result: ElaborationSessionResult } | { ok: false; error: unknown } | undefined
    let nativePromise: Promise<void> | undefined
    const settle = (status: 'completed' | 'cancelled' | 'timeout' | 'failed', extra: { result?: ElaborationSessionResult; stop?: StructuredCancellationResult; creationTermination?: SessionCreateTermination; failure?: NativeRunCheckpoint['failure'] }): void => {
      if (resource!.phase !== 'terminal') save({ ...checkpoint, ...extra, status, phase: 'terminal' })
      save({ ...checkpoint, phase: 'removed' })
    }
    const stop = async (): Promise<never> => {
      controller.abort()
      let record = observe()
      if (!record && !checkpoint.nativeCallRequested) {
        settle('cancelled', { stop: { sessionId: expectedSessionId, state: 'cancelled', nativeStopped: true, acknowledged: false, nativeStatus: 'notDispatched' } })
        throw new StructuredSessionError('cancelled', 'native request cancelled before dispatch', errorIdentity())
      }
      if (!record) {
        const deadline = Date.now() + Math.min(15_000, request.timeoutMs ?? 15_000)
        let receipt = creationTermination()
        while (!record && !receipt && nativePromise && !outcome && Date.now() < deadline) {
          await new Promise<void>(resolve => setTimeout(resolve, Math.min(options.pollMs ?? 50, Math.max(1, deadline - Date.now()))))
          record = observe(); receipt = creationTermination()
        }
        if (!record && !receipt && (!nativePromise || outcome) && runtime.recoverCreateTermination) {
          await runtime.recoverCreateTermination(dispatch!.sessionCreateKey, { prompt: creationPrompt, payloadHash: expectedCreateHash, base: creationBase, signal: AbortSignal.timeout(Math.min(15_000, request.timeoutMs ?? 15_000)), structuredExecution: execution, ...(options.resourceRecoveryOnly ? { resourceRecoveryOnly: true } : {}) })
          record = observe(); receipt = creationTermination()
        }
        if (!record && receipt) {
          const status = receipt.code === 'session_create_timeout' ? 'timeout' : 'cancelled'
          settle(status, { creationTermination: receipt, stop: { sessionId: expectedSessionId, state: status, nativeStopped: true, acknowledged: false, nativeStatus: receipt.nativeStatus } })
          if (receipt.code === 'session_create_timeout') throw new SettledSessionCreateTimeoutError(receipt)
          throw new StructuredSessionError(status, receipt.version === 2 ? 'native creation cancelled; exact candidate retained and execution capacity settled' : 'native creation cancelled and exact cleanup settled', errorIdentity())
        }
        if (!record) throw new StructuredSessionError('cancellation_pending', 'native creation may be in progress; absence alone does not confirm stop', errorIdentity())
      }
      let stopped: StructuredCancellationResult | undefined
      let failure: unknown
      try { stopped = await runtime.cancel(expectedSessionId, { reason: 'cancelled', timeoutMs: Math.min(15_000, request.timeoutMs ?? 15_000), ...(options.resourceRecoveryOnly ? { wakeQueue: false } : {}) }) }
      catch (error) { failure = error }
      const after = observe()
      if (!after?.structuredExecution) throw new StructuredSessionError('cancellation_pending', 'native record disappeared before exact stop confirmation', errorIdentity())
      const state = after.structuredExecution
      const stoppedFailure = stoppedFailedEvidence(state)
      const durableStop = state.cancellation?.nativeStopped && (state.state === 'cancelled' || state.state === 'timeout' || !!stoppedFailure)
      if (!stopped && durableStop) stopped = { sessionId: expectedSessionId, state: state.state!, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation!.acknowledged, nativeStatus: state.cancellation!.nativeStatus }
      if (stopped?.nativeStopped && stopped.sessionId === expectedSessionId && ['completed', 'cancelled', 'timeout'].includes(stopped.state) && (stopped.threadId ?? null) === (state.threadId ?? null) && (stopped.turnId ?? null) === (state.turnId ?? null)) settle(stopped.state === 'timeout' ? 'timeout' : 'cancelled', { stop: stopped })
      if (stopped?.nativeStopped && stopped.sessionId === expectedSessionId && stopped.state === 'failed' && stoppedFailure && (stopped.threadId ?? null) === (state.threadId ?? null) && (stopped.turnId ?? null) === (state.turnId ?? null)) settle('failed', { stop: stopped, failure: stoppedFailure })
      if (failure) throw failure
      throw new StructuredSessionError(resource!.phase === 'removed' ? 'cancelled' : 'cancellation_pending', resource!.phase === 'removed' ? 'native execution cancelled and exact stop settled' : stopped?.error ?? 'native cancellation has not been proven', errorIdentity())
    }
    if (resource.phase === 'terminal') {
      const rpcFailure = restoreSettledFailure()
      if (rpcFailure) { save({ ...checkpoint, phase: 'removed' }); throw rpcFailure }
      if (checkpoint.stop?.nativeStopped && checkpoint.stop.sessionId === expectedSessionId && ['completed', 'cancelled', 'timeout'].includes(checkpoint.stop.state) && (checkpoint.stop.threadId ?? null) === checkpoint.session.threadId && (checkpoint.stop.turnId ?? null) === checkpoint.session.turnId) {
        const settledTimeout = restoreSettledCreationTermination(checkpoint.creationTermination)
        save({ ...checkpoint, phase: 'removed' })
        if (settledTimeout) throw settledTimeout
        throw new StructuredSessionError(checkpoint.status === 'timeout' ? 'timeout' : 'cancelled', 'native execution stop evidence was already settled', errorIdentity())
      }
      if (checkpoint.status === 'completed' && checkpoint.result) { checkResult(checkpoint.result); settle('completed', { result: checkpoint.result }); return copy(checkpoint.result) }
      return stop()
    }
    if (creationTermination() || controller.signal.aborted || !authority(true)) return stop()
    save({ ...checkpoint, nativeCallRequested: true })
    nativePromise = Promise.resolve().then(() => runtime.run({ ...request, ...(request.frozenContext || request.worktree ? { sessionCreateKey: dispatch!.sessionCreateKey } : { requestKey: dispatch!.sessionCreateKey }), signal: controller.signal })).then(result => { outcome = { ok: true, result } }, error => { outcome = { ok: false, error } })
    for (;;) {
      observe()
      if (controller.signal.aborted || !authority()) return await stop()
      if (outcome) {
        if (!outcome.ok) {
          if (!observe() && creationTermination()) return stop()
          const state = runtime.readRecord(expectedSessionId)?.structuredExecution
          const stoppedFailure = state ? stoppedFailedEvidence(state) : null
          if (stoppedFailure) {
            if (!(outcome.error instanceof StructuredSessionError) || outcome.error.code !== stoppedFailure.code || state!.error !== outcome.error.message || outcome.error.sessionId !== expectedSessionId || outcome.error.threadId !== state!.threadId || outcome.error.turnId !== state!.turnId) throw new StructuredSessionError('stale_result', 'native failure lacks its matching stopped failed record', errorIdentity())
            if (outcome.error.code === 'native_turn_transport_failed' && (outcome.error.requestKey !== request.requestKey || outcome.error.inputDigest !== request.inputDigest)) throw new StructuredSessionError('stale_result', 'typed native turn transport failure differs from its fixed request', errorIdentity())
            if (hash(outcome.error.failedWorktree ?? null) !== hash(state!.failedWorktree ?? null)) throw new StructuredSessionError('stale_result', 'failed stage Git witness differs from its exact stopped native error', errorIdentity())
            settle('failed', { failure: stoppedFailure, stop: { sessionId: expectedSessionId, state: 'failed', threadId: state!.threadId, turnId: state!.turnId, nativeStopped: true, acknowledged: state!.cancellation!.acknowledged, nativeStatus: state!.cancellation!.nativeStatus } })
          }
          if (outcome.error instanceof StructuredSessionError && outcome.error.code === 'native_rpc_timeout' && !stoppedFailure) throw new StructuredSessionError('stale_result', 'typed native RPC failure has no exact stopped failed record', errorIdentity())
          if (outcome.error instanceof StructuredSessionError && outcome.error.code === 'native_turn_transport_failed' && !stoppedFailure) throw new StructuredSessionError('stale_result', 'typed native turn transport failure has no exact stopped failed record', errorIdentity())
          if (state?.cancellation?.nativeStopped && (state.state === 'cancelled' || state.state === 'timeout')) settle(state.state, { stop: { sessionId: expectedSessionId, state: state.state, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation.acknowledged, nativeStatus: state.cancellation.nativeStatus } })
          if (outcome.error instanceof StructuredSessionError && outcome.error.rejectedOutput) {
            const rejectedOutput = outcome.error.rejectedOutput
            if (state?.state !== 'failed' || !state.rejectedOutput || hash(state.rejectedOutput) !== hash(rejectedOutput) || outcome.error.sessionId !== expectedSessionId || outcome.error.threadId !== state.threadId || outcome.error.turnId !== state.turnId) throw new StructuredSessionError('stale_result', 'rejected final output lacks its matching failed native record', errorIdentity())
            assertRejectedOutput(rejectedOutput, creationPrompt, execution, state)
            const ref = blobs.put(Buffer.from(rejectedOutput.text, 'utf8'))
            if (ref.sha256 !== rejectedOutput.sha256) throw new StructuredSessionError('stale_result', 'rejected final output content differs from its exact native bytes', errorIdentity())
            const failedWorktree = outcome.error.failedWorktree
            if (failedWorktree) {
              if (!request.worktree || !state.cancellation?.nativeStopped || !state.failedWorktree || hash(state.failedWorktree) !== hash(failedWorktree)) throw new StructuredSessionError('stale_result', 'failed stage Git witness lacks its matching stopped failed record', errorIdentity())
              verifyStageResult(operation.input.source.commonDir, request.worktree, { worktree: failedWorktree })
            }
            const diagnostic = { ...rejectedOutput, ref }
            throw new StructuredSessionError(outcome.error.code, outcome.error.message, { ...errorIdentity(), rejectedOutput: diagnostic, failedWorktree })
          }
          if (outcome.error instanceof StructuredSessionError && (outcome.error.code === 'native_rpc_timeout' || outcome.error.code === 'native_turn_transport_failed')) throw new StructuredSessionError(outcome.error.code, outcome.error.message, errorIdentity())
          throw outcome.error
        }
        const record = observe(), state = record?.structuredExecution
        if (!authority(true)) return stop()
        checkResult(outcome.result)
        if (state?.state !== 'completed' || state.threadId !== outcome.result.threadId || state.turnId !== outcome.result.turnId || state.resultDigest !== outcome.result.resultDigest || hash(state.output) !== outcome.result.resultDigest) throw new StructuredSessionError('stale_result', 'native result lacks matching durable exact-turn completion')
        if (request.worktree && hash(state.resultWorktree) !== hash(outcome.result.worktree)) throw new StructuredSessionError('stale_result', 'native worktree result differs from its durable immutable result')
        if (request.frozenContext && hash(state.frozenReadProof) !== hash(outcome.result.frozenReadProof)) throw new StructuredSessionError('stale_result', 'native frozen result differs from its durable history evidence')
        settle('completed', { result: copy(outcome.result) })
        return copy(outcome.result)
      }
      await new Promise<void>(resolve => setTimeout(resolve, options.pollMs ?? 50))
    }
  }
  return async request => {
    const { signal, ...value } = request
    const resource = store.findResource(fence.attemptId, value.requestKey)
    const dispatch = resource ? undefined : store.readAttempt(fence.attemptId).dispatchPlans.find(plan => plan.key === value.requestKey)
    let saved = resource ? read<NativeRunPlan>(resource.plan.planBlob).request : dispatch?.requestDigest === hash(value) ? value : null
    const zcodeToolPolicy = pinZCodeToolPolicy(value, saved)
    if (!saved && dispatch) {
      const previous = zcodeToolPolicy ? { ...value, zcodeToolPolicy } : value
      const configuration = pinNativeConfiguration(value, null)
      saved = [previous, ...(configuration ? [{ ...value, nativeConfiguration: configuration, ...(zcodeToolPolicy ? { zcodeToolPolicy } : {}) }] : [])].find(candidate => dispatch.requestDigest === hash(candidate)) ?? null
    }
    const pinned = pinSyncNativeRequest(value, saved)
    const exactResourceRequest = resource?.plan.payloadDigest === hash(pinned)
    let frozen: FrozenRequest = exactResourceRequest || pinned.worktree ? copy(pinned) : prepareFrozenPrompt(copy(pinned), { directory: join(runtimeRoot(), 'frozen-context-v2'), binding: { attemptId: fence.attemptId, policyDigest: operation.policyDigest } })
    if (!exactResourceRequest && frozen.frozenContext && !options.runtime && !frozen.model?.startsWith('claude:') && !frozen.model?.startsWith('zcode:')) frozen = { ...frozen, readerRuntime: await prepareFrozenReaderRuntime(join(runtimeRoot(), 'structured-frozen-read-only-v2'), frozen.frozenContext) }
    const requestDigest = hash(frozen)
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
    const retire = async (result?: ElaborationSessionResult): Promise<void> => {
      if (!options.retireSettledWorktrees || !frozen.worktree) return
      const resource = store.findResource(fence.attemptId, frozen.requestKey)
      if (!resource || resource.phase !== 'removed') return
      const attempt = store.readAttempt(fence.attemptId), dispatch = attempt.dispatchPlans.find(plan => plan.key === frozen.requestKey)
      const id = dispatch && sessionIdForCreateKey(dispatch.sessionCreateKey)
      try {
        const checkpoint = read<NativeRunCheckpoint>(resource.checkpointRef), record = id ? readRecord(id) : null, state = record?.structuredExecution
        const plan = read<NativeRunPlan>(resource.plan.planBlob)
        const execution = structuredExecutionPolicy(frozen), prompt = nativeWorktreePrompt(frozen.prompt, frozen.worktree)
        const payloadHash = hash({ prompt, parent: null, launcher: null, base: frozen.worktree.baseCommit, structuredExecution: execution })
        if (!record || !state || !dispatch || resource.operationId !== operation.id || resource.attemptId !== attempt.id || resource.generation !== attempt.generation
          || hash(plan) !== hash({ schemaVersion: 1, request: frozen, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: id, operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: resource.plan.candidateDigest })
          || checkpoint.operationId !== operation.id || checkpoint.attemptId !== attempt.id || checkpoint.inputId !== operation.input.id || checkpoint.candidateDigest !== resource.plan.candidateDigest
          || resource.plan.inputId !== operation.input.id || resource.plan.payloadDigest !== requestDigest || checkpoint.requestDigest !== requestDigest
          || checkpoint.expectedSessionId !== id || checkpoint.phase !== 'removed' || checkpoint.session.sessionId !== id
          || record.createRequestId !== sha(dispatch.sessionCreateKey) || record.createPayloadHash !== payloadHash
          || hash(structuredExecutionPolicy(state)) !== hash(execution) || (state.threadId ?? null) !== checkpoint.session.threadId || (state.turnId ?? null) !== checkpoint.session.turnId)
          throw new Error('settled native identity no longer matches its durable resource')
        if (result) {
          if (checkpoint.status !== 'completed' || hash(checkpoint.result) !== hash(result) || state.state !== 'completed'
            || state.threadId !== result.threadId || state.turnId !== result.turnId || state.resultDigest !== result.resultDigest
            || hash(state.output) !== result.resultDigest || hash(state.resultWorktree) !== hash(result.worktree))
            throw new Error('completed native identity no longer matches its durable result')
        } else {
          if (!['failed', 'cancelled'].includes(state.state ?? '') || state.cancellation?.nativeStopped !== true) return
          const stop = { sessionId: id, state: state.state, threadId: state.threadId, turnId: state.turnId, nativeStopped: true,
            acknowledged: state.cancellation.acknowledged, nativeStatus: state.cancellation.nativeStatus, error: state.cancellation.error }
          if (checkpoint.status !== state.state || checkpoint.result || !checkpoint.stop?.nativeStopped || checkpoint.stop.state !== stop.state || checkpoint.stop.sessionId !== stop.sessionId
            || (checkpoint.stop.threadId ?? null) !== (stop.threadId ?? null) || (checkpoint.stop.turnId ?? null) !== (stop.turnId ?? null)
            || checkpoint.stop.acknowledged !== stop.acknowledged || checkpoint.stop.nativeStatus !== stop.nativeStatus || checkpoint.stop.error !== stop.error
            || state.state === 'failed' && (checkpoint.failure?.code !== (state.errorCode ?? 'failed') || checkpoint.failure.message !== state.error))
            throw new Error('failed native identity no longer matches its durable stop')
        }
        await withoutSessionApplicationExecutionWake(() => closeSession(record.session, undefined, {
          wakeQueue: false, settled: { record, commonDir: operation.input.source.commonDir, ...(result?.worktree ? { worktree: result.worktree } : {}) },
        }))
      } catch (error) {
        console.warn(`spex sync: settled worktree cleanup pending for ${id ?? frozen.requestKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const result = await current.promise
      await retire(result)
      return copy(result)
    } catch (error) {
      await retire()
      throw error
    }
    finally { signal?.removeEventListener('abort', abort); if (flights.get(frozen.requestKey) === current) flights.delete(frozen.requestKey) }
  }
}
