import type { SyncResourceRecord, WriteFence } from './operation-types.js'
import { contentHash, readEvidence, writeEvidence } from './snapshot.js'
import type { SyncStore } from './store.js'
import { executeVerification } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationDriver, VerificationRequest, VerificationResult } from './verification-executor-types.js'

export type AttemptVerificationOptions = {
  driver?: VerificationDriver
  onCheckpointRecorded?: (resource: SyncResourceRecord) => Promise<void>
}

/** 资源回执独立于候选写权；精确恢复同一尝试、同一容器，不重新派发已结算验收。 */
export async function runAttemptVerification(store: SyncStore, fence: WriteFence, supplied: Omit<VerificationRequest, 'previousCheckpoint'>, options: AttemptVerificationOptions = {}): Promise<{ result: VerificationResult; resourceId: string | null }> {
  const { signal, ...serializable } = supplied
  const request = structuredClone(serializable)
  const operation = store.readOperation(fence.operationId)
  const attempt = store.readAttempt(fence.attemptId)
  if (attempt.operationId !== operation.id || request.inputDigest !== operation.input.id || request.candidateDigest !== attempt.candidate?.digest) throw new Error('验证请求必须绑定已有尝试的冻结输入与候选')
  const commonDir = operation.input.source.commonDir
  const key = `verification:${request.runId}`
  const payloadDigest = contentHash(JSON.stringify(request))
  let resource = store.findResource(attempt.id, key)
  let previousCheckpoint: VerificationCheckpoint | undefined
  if (resource) {
    if (resource.plan.kind !== 'verification' || resource.plan.payloadDigest !== payloadDigest || resource.plan.inputId !== request.inputDigest || resource.plan.candidateDigest !== request.candidateDigest) throw new Error('验证 runId 已绑定另一请求')
    previousCheckpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString('utf8')) as VerificationCheckpoint
    if (previousCheckpoint.version !== 'verification-checkpoint-v1' || previousCheckpoint.phase !== resource.phase) throw new Error('验证资源与实际检查点阶段不一致')
  }
  const obsolete = operation.control !== 'run' || operation.currentAttemptId !== attempt.id || ['superseded', 'failed'].includes(attempt.status)
  const result = await executeVerification({ ...request, signal: obsolete ? AbortSignal.abort() : signal, previousCheckpoint }, {
    driver: options.driver,
    onCheckpoint: async checkpoint => {
      const checkpointRef = writeEvidence(commonDir, checkpoint)
      if (!resource) {
        if (checkpoint.phase !== 'planned') throw new Error('首次资源记录必须先登记 planned')
        resource = store.planResource(fence, { key, kind: 'verification', payloadDigest, inputId: operation.input.id, candidateDigest: attempt.candidate!.digest, planBlob: writeEvidence(commonDir, request), checkpointRef })
      } else {
        resource = store.recordResourceCheckpoint(resource.id, { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: attempt.candidate!.digest, phase: checkpoint.phase, expectedCheckpointRef: resource.checkpointRef, checkpointRef })
      }
      await options.onCheckpointRecorded?.(structuredClone(resource))
    },
  })
  return { result, resourceId: resource?.id ?? null }
}
