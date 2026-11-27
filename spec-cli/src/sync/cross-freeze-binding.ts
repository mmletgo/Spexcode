import { isDeepStrictEqual } from 'node:util'
import { selectCrossFreezeSource, type CrossFreezeSource } from './cross-freeze-source.js'
import type { BlobRef, SyncOperation } from './operation-types.js'
import { identifyWorktree, readEvidence, sourceGit, writeEvidence } from './snapshot.js'
import { frozenSyncCanonicalBranch } from './settings.js'
import type { SyncStore } from './store.js'

const NO_SOURCE_REASONS = ['source_head_changed', 'source_not_clean', 'source_git_unavailable', 'source_not_found', 'source_evidence_unavailable'] as const
type NoSourceReason = typeof NO_SOURCE_REASONS[number]
type InvalidReason = 'binding_storage_unavailable' | 'binding_current_mismatch' | 'binding_unreadable' | 'binding_invalid'
  | 'binding_provenance_unreadable' | 'binding_provenance_mismatch' | 'binding_source_ineligible'

type BindingBasis = {
  version: 'cross-freeze-binding-v1'
  operationId: string
  inputId: string
  policyDigest: string
  canonicalBranch: string
  requestedOldOperationId: string | null
}
type SelectedBinding = BindingBasis & {
  kind: 'selected'
  oldOperationId: string
  attemptIds: string[]
  provenanceRef: BlobRef
  provenanceDigest: string
}
type DeclinedBinding = BindingBasis & { kind: 'no-source'; reason: NoSourceReason }
export type CrossFreezeBinding = SelectedBinding | DeclinedBinding
type PublishedBinding =
  | { source: CrossFreezeSource; binding: SelectedBinding; bindingRef: BlobRef }
  | { source: null; binding: DeclinedBinding; bindingRef: BlobRef; reason: NoSourceReason; cause?: unknown }
export type CrossFreezeBindingResult = PublishedBinding
  | { source: null; binding: null; bindingRef: BlobRef | null; reason: InvalidReason; cause?: unknown }

export type CrossFreezeBindingPersistence = {
  load: () => BlobRef | null
  /** 原子保留首个决定并返回已持久化的胜出引用。 */
  save: (proposed: BlobRef) => BlobRef
}
type BindingOptions = { oldOperationId?: string; canonicalBranch?: string }
type Discovery = { source: CrossFreezeSource } | { reason: NoSourceReason; cause?: unknown }
type Unavailable = Extract<Discovery, { reason: NoSourceReason }>

const sha256 = /^[a-f0-9]{64}$/
const evidenceRef = (value: unknown): value is BlobRef => !!value && typeof value === 'object' && 'sha256' in value
  && typeof value.sha256 === 'string' && sha256.test(value.sha256)

function invalid(reason: InvalidReason, bindingRef: BlobRef | null = null, cause?: unknown): CrossFreezeBindingResult {
  return { source: null, binding: null, bindingRef, reason, ...(cause === undefined ? {} : { cause }) }
}

function isBinding(value: unknown): value is CrossFreezeBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as Partial<SelectedBinding> & { reason?: unknown }
  if (binding.version !== 'cross-freeze-binding-v1' || ![binding.operationId, binding.inputId, binding.policyDigest, binding.canonicalBranch].every(field => typeof field === 'string' && field.length)
    || (binding.requestedOldOperationId !== null && (typeof binding.requestedOldOperationId !== 'string' || !binding.requestedOldOperationId))) return false
  if ((value as { kind?: unknown }).kind === 'no-source') return NO_SOURCE_REASONS.some(reason => reason === binding.reason)
  return binding.kind === 'selected' && typeof binding.oldOperationId === 'string' && binding.oldOperationId.length > 0
    && Array.isArray(binding.attemptIds) && binding.attemptIds.length > 0
    && binding.attemptIds.every(id => typeof id === 'string' && id.length > 0)
    && new Set(binding.attemptIds).size === binding.attemptIds.length && evidenceRef(binding.provenanceRef)
    && typeof binding.provenanceDigest === 'string' && sha256.test(binding.provenanceDigest)
}

function cleanFreeze(current: SyncOperation): Unavailable | null {
  const { input } = current, { source } = input, root = source.canonicalRoot
  try {
    const head = (): string => sourceGit(root, ['rev-parse', '--verify', 'HEAD']).toString().trim()
    if (!isDeepStrictEqual(identifyWorktree(root), source) || head() !== input.headCommit
      || sourceGit(root, ['rev-parse', '--verify', 'HEAD^{tree}']).toString().trim() !== input.immutableTree
      || input.indexTree !== input.immutableTree) return { reason: 'source_head_changed' }
    const index = sourceGit(root, ['--no-optional-locks', 'ls-files', '-v', '-z']).toString()
    const status = sourceGit(root, ['--no-optional-locks', '-c', 'core.fileMode=true', '-c', 'core.ignoreStat=false', '-c', 'core.untrackedCache=false',
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])
    if (status.length || index.split('\0').some(record => /^[a-zS] /.test(record))) return { reason: 'source_not_clean' }
    return head() === input.headCommit && isDeepStrictEqual(identifyWorktree(root), source) ? null : { reason: 'source_head_changed' }
  } catch (cause) { return { reason: 'source_git_unavailable', cause } }
}

function discover(store: SyncStore, current: SyncOperation, options: BindingOptions): Discovery {
  const before = cleanFreeze(current)
  if (before) return before
  let source: CrossFreezeSource | null
  try { source = selectCrossFreezeSource(store, current, options) }
  catch (cause) { return { reason: 'source_evidence_unavailable', cause } }
  return source ? cleanFreeze(current) ?? { source } : { reason: 'source_not_found' }
}

function restore(store: SyncStore, current: SyncOperation, basis: BindingBasis, bindingRef: BlobRef, options: BindingOptions): CrossFreezeBindingResult {
  const commonDir = current.input.source.commonDir
  let value: unknown
  try { value = JSON.parse(readEvidence(commonDir, bindingRef).toString('utf8')) }
  catch (cause) { return invalid('binding_unreadable', bindingRef, cause) }
  if (!isBinding(value)) return invalid('binding_invalid', bindingRef)
  if (value.operationId !== basis.operationId || value.inputId !== basis.inputId || value.policyDigest !== basis.policyDigest
    || value.canonicalBranch !== basis.canonicalBranch || options.oldOperationId !== undefined && value.requestedOldOperationId !== options.oldOperationId)
    return invalid('binding_current_mismatch', bindingRef)
  if (value.kind === 'no-source') return { source: null, binding: value, bindingRef, reason: value.reason }
  if (value.requestedOldOperationId && value.oldOperationId !== value.requestedOldOperationId) return invalid('binding_invalid', bindingRef)
  let provenance: Buffer
  try { provenance = readEvidence(commonDir, value.provenanceRef) }
  catch (cause) { return invalid('binding_provenance_unreadable', bindingRef, cause) }
  let source: CrossFreezeSource | null
  try {
    source = selectCrossFreezeSource(store, current, { canonicalBranch: value.canonicalBranch, oldOperationId: value.oldOperationId, expectedAttemptIds: value.attemptIds })
  } catch (cause) { return invalid('binding_source_ineligible', bindingRef, cause) }
  if (!source) return invalid('binding_source_ineligible', bindingRef)
  if (source.provenance.digest !== value.provenanceDigest || !provenance.equals(Buffer.from(JSON.stringify(source.provenance))))
    return invalid('binding_provenance_mismatch', bindingRef)
  return { source, binding: value, bindingRef }
}

/** 首次固定原操作及 Git 原件，冷恢复只复验已固定的来源或无来源决定。 */
export function lockCrossFreezeSource(store: SyncStore, operation: SyncOperation, persistence: CrossFreezeBindingPersistence, options: BindingOptions = {}): CrossFreezeBindingResult {
  let saved: BlobRef | null
  try { saved = persistence.load() }
  catch (cause) { return invalid('binding_storage_unavailable', null, cause) }
  if (saved !== null && !evidenceRef(saved)) return invalid('binding_unreadable')
  let current: SyncOperation
  try { current = store.readOperation(operation.id) }
  catch (cause) { return invalid('binding_current_mismatch', saved, cause) }
  const canonicalBranch = frozenSyncCanonicalBranch(current.input)
  if (options.canonicalBranch !== undefined && options.canonicalBranch !== canonicalBranch || current.origin !== 'initial' || current.retryOf || current.requestBlob || current.input.captureKind !== 'commit'
    || current.input.source.branch !== canonicalBranch || current.policyDigest !== operation.policyDigest
    || !isDeepStrictEqual(current.input, operation.input) || options.oldOperationId === '')
    return invalid('binding_current_mismatch', saved)
  const basis = { version: 'cross-freeze-binding-v1' as const, operationId: current.id,
    inputId: current.input.id, policyDigest: current.policyDigest, canonicalBranch, requestedOldOperationId: options.oldOperationId ?? null }
  if (saved) return restore(store, current, basis, saved, options)

  const outcome = discover(store, current, options), commonDir = current.input.source.commonDir
  let proposal: PublishedBinding
  let winner: BlobRef
  try {
    if ('source' in outcome) {
      const { source } = outcome
      const binding: SelectedBinding = { ...basis, kind: 'selected', oldOperationId: source.operation.id,
        attemptIds: source.attempts.map(attempt => attempt.id), provenanceRef: writeEvidence(commonDir, source.provenance), provenanceDigest: source.provenance.digest }
      proposal = { source, binding, bindingRef: writeEvidence(commonDir, binding) }
    } else {
      const binding: DeclinedBinding = { ...basis, kind: 'no-source', reason: outcome.reason }
      proposal = { source: null, binding, bindingRef: writeEvidence(commonDir, binding), ...outcome }
    }
    winner = persistence.save(proposal.bindingRef)
  } catch (cause) { return invalid('binding_storage_unavailable', null, cause) }
  if (!evidenceRef(winner)) return invalid('binding_storage_unavailable')
  return winner.sha256 === proposal.bindingRef.sha256 ? proposal : restore(store, current, basis, winner, options)
}
