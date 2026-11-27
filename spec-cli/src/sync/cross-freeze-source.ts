import { isDeepStrictEqual } from 'node:util'
import { parseParts } from '@spexcode/spec-core/contracts'
import { isUtf8Text } from './composition.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { deriveCrossFreezeProvenance, type CrossFreezeProvenance } from './cross-freeze-provenance.js'
import { isSyncSpecPath } from './frozen-contracts.js'
import type { SyncAttempt, SyncOperation } from './operation-types.js'
import { readEvidence, readObject, verifySnapshot, withReadonlySnapshotQuery } from './snapshot.js'
import { SyncStoreError, type SyncStore } from './store.js'
import { frozenSyncCanonicalBranch } from './settings.js'

export type CrossFreezeSource = {
  operation: SyncOperation
  attempts: SyncAttempt[]
  provenance: CrossFreezeProvenance
}

type SourceSelection = {
  oldOperationId?: string
  expectedAttemptIds?: readonly string[]
  expectedProvenanceDigest?: string
  canonicalBranch?: string
}

const RETRY_PHASES = ['failed', 'budget_exhausted', 'cancelled']
const DELIVERED_PHASES = ['workspace_synced', 'awaiting_landing', 'canonical_synced']

function originalsMatch(store: SyncStore, operation: SyncOperation): boolean {
  const receipt = store.findIngressReceipt(operation.ingressKey)
  return !!receipt && receipt.operationId === operation.id && receipt.payloadDigest === operation.payloadDigest
    && receipt.origin === 'initial' && !receipt.requestBlob && isDeepStrictEqual(receipt.input, operation.input)
    && receipt.recordUnverifiedCoverage === operation.recordUnverifiedCoverage
}

function settledAttempts(store: SyncStore, operation: SyncOperation): SyncAttempt[] {
  const delivered = DELIVERED_PHASES.includes(operation.phase)
  if (operation.phase === 'superseded') {
    if (!store.isSupersededOperationSettled(operation.id)) return []
  } else if (RETRY_PHASES.includes(operation.phase)) {
    const eligibility = store.readRetryEligibility(operation.id)
    if (!eligibility.eligible && eligibility.reason?.code !== 'SYNC_RETRY_DELIVERED') return []
  } else if (!delivered) return []
  if (store.sourceContinuityState(operation.input.source.commonDir).leasedOperationIds.includes(operation.id)) return []
  const attempts = store.listAttempts(operation.id), journals = store.listJournals(operation.id)
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]))
  if (!operation.currentAttemptId || !byId.has(operation.currentAttemptId) || delivered && !journals.length
    || journals.some(journal => journal.status !== 'settled' || journal.operationId !== operation.id
      || byId.get(journal.attemptId)?.generation !== journal.generation
      || journal.receipt?.journalId !== journal.id || journal.receipt.effectKey !== journal.plan.effectKey
      || journal.steps.some(step => step.status !== 'completed' || !step.evidenceRef))) return []
  if (attempts.some(attempt => attempt.operationId !== operation.id || !['failed', 'superseded', 'settled'].includes(attempt.status)
    || store.listResources(attempt.id).some(resource => resource.phase !== 'removed' || resource.operationId !== operation.id
      || resource.attemptId !== attempt.id || resource.generation !== attempt.generation || resource.plan.inputId !== operation.input.id))) return []
  return attempts.filter(attempt => attempt.composedInput?.sourceInputId === operation.input.id && attempt.checkpointRefs.length)
}

function sameRequest(current: SyncOperation, provenance: CrossFreezeProvenance, plan: SyncCoordinatorPlan): boolean {
  const targets = plan.targets.filter(target => target.nodeId === plan.intentNodeId)
  if (targets.length !== 1 || !isSyncSpecPath(targets[0].path)) return false
  const { path } = targets[0], change = provenance.changes.find(entry => entry.path === path)
  const existing = verifySnapshot(current.input).find(entry => entry.path === path)
  const sources = change ? [change.before, change.after] : [existing, existing]
  const raw = sources.map(entry => {
    if (!entry || entry.mode === '120000') return null
    const bytes = readObject(current.input.source.commonDir, entry.oid)
    return isUtf8Text(bytes) ? parseParts(bytes.toString('utf8'))?.rawSource : null
  })
  return !!raw[0] && raw[0] === raw[1]
}

function earlierOperations(store: SyncStore, current: SyncOperation, oldOperationId?: string): SyncOperation[] {
  if (oldOperationId === current.id) return []
  if (oldOperationId) {
    let old: SyncOperation
    try { old = store.readOperation(oldOperationId) }
    catch (error) {
      if (error instanceof SyncStoreError && error.code === 'SYNC_OPERATION_UNKNOWN') return []
      throw error
    }
    // 原消息的 enqueue seq 可冷验未继承队列锚的显式来源，即使它已退出最近记录窗口。
    if (old.dispatchAnchor?.firstMessageId === old.dispatchMessageId && current.dispatchAnchor?.firstMessageId === current.dispatchMessageId)
      return old.dispatchAnchor.firstEnqueueSeq < current.dispatchAnchor.firstEnqueueSeq ? [old] : []
  }
  const operations = store.listOperations(current.input.source.repositoryId, { sourceRoot: current.input.source.canonicalRoot, limit: 500 })
  const position = operations.findIndex(operation => operation.id === current.id)
  return position < 0 ? [] : operations.slice(position + 1).filter(operation => !oldOperationId || operation.id === oldOperationId)
}

/** 只读定位旧初始操作的真实冻结材料，供当前分区独审核验。 */
export function selectCrossFreezeSource(store: SyncStore, operation: SyncOperation, options: SourceSelection = {}): CrossFreezeSource | null {
  return withReadonlySnapshotQuery(() => {
    const current = store.readOperation(operation.id), { oldOperationId, expectedAttemptIds, expectedProvenanceDigest } = options
    const canonicalBranch = frozenSyncCanonicalBranch(current.input)
    if (options.canonicalBranch !== undefined && options.canonicalBranch !== canonicalBranch || !isDeepStrictEqual(current.input, operation.input) || current.policyDigest !== operation.policyDigest
      || current.origin !== 'initial' || current.retryOf || current.requestBlob || current.input.captureKind !== 'commit'
      || current.input.source.branch !== canonicalBranch
      || !current.planBlob || current.planBlob.sha256 !== current.policyDigest || !originalsMatch(store, current)
      || !oldOperationId && (expectedAttemptIds || expectedProvenanceDigest)) return null
    const plan = JSON.parse(readEvidence(current.input.source.commonDir, current.planBlob).toString('utf8')) as SyncCoordinatorPlan
    for (const old of earlierOperations(store, current, oldOperationId)) {
      if (old.origin !== 'initial' || old.requestBlob || old.input.headCommit === current.input.headCommit
        || !isDeepStrictEqual(old.input.source, current.input.source) || old.policyDigest !== current.policyDigest
        || old.planBlob?.sha256 !== current.planBlob.sha256 || old.recordUnverifiedCoverage !== current.recordUnverifiedCoverage
        || !originalsMatch(store, old) || frozenSyncCanonicalBranch(old.input) !== canonicalBranch) continue
      const attempts = settledAttempts(store, old)
      if (!attempts.length || expectedAttemptIds && !isDeepStrictEqual(attempts.map(attempt => attempt.id), expectedAttemptIds)) continue
      const provenance = deriveCrossFreezeProvenance(old.input, current.input)
      if (!provenance || expectedProvenanceDigest && provenance.digest !== expectedProvenanceDigest || !sameRequest(current, provenance, plan)) continue
      if (store.readOperation(old.id).revision === old.revision) return { operation: old, attempts, provenance }
    }
    return null
  })
}
