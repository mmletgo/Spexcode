import { createHash, randomUUID } from 'node:crypto'
import { getBlob } from '@spexcode/spec-core'
import { applyComponentMigrations, type ProtocolTransaction, type SessionProtocol } from '@spexcode/session-protocol'
import { controlledDecisionIdentity, readControlledDecision, readControlledRequest } from './request-input.js'
import { verifyPublicationBase } from './publication-base.js'
import type { PublicationBase, PublicationHeads } from './operation-types.js'
import { SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress, syncSemanticDigest } from './migrations.js'
import type { BaselineResource, BaselineBinding, FrozenBaselineSelection, BaselineSelectionResult, PhysicalScope, PhysicalControl, ClaimQueuedAttemptInput, SyncObserverHealth, SyncObservationInput, SyncObservation, ObserveAndAdmitResult, AdmitSyncInput, ApplyFilePlan, ApplyJournal, ApplyPlan, ApplyReceipt, ApplyStep, BaselinePair, BlobRef, CandidateRef, ClaimedAttempt, ClaimAttemptInput, ComposedInputRef, RecoverableSyncResource, SyncResourceCheckpoint, SyncResourcePlan, SyncResourceRecord, DispatchPlan, InputSnapshot, NativeSessionRef, RecoverableSync, ScopeLease, SyncAttempt, SyncControl, SyncDispatchEnvelope, SyncFailure, SyncOperation, SyncIngressReceipt, SyncScope, VerificationRef, VerificationResultBlob, WorktreeIdentity, WriteFence } from './operation-types.js'

export { SYNC_COORDINATOR_ADDRESS, syncCoordinatorAddress } from './migrations.js'
export const SYNC_DISPATCH_KIND = 'sync.dispatch.v1'
export type SyncDecisionEligibility = { eligible: boolean; reason?: { code: string; message: string } }
export type SyncRetryEligibility = { eligible: boolean; reason?: { code: string; message: string } }
export class SyncStoreError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'SyncStoreError' }
}
function fail(code: string, message: string): never { throw new SyncStoreError(code, message) }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
const physicalScope = ({ repositoryId, canonicalRoot, physicalFingerprint }: PhysicalScope): PhysicalScope => ({ repositoryId, canonicalRoot, physicalFingerprint })
const resourceKey = (resource: BaselineResource): string => resource.kind === 'path' ? `path:${resource.path}` : `${resource.kind}:${resource.id}`
const scopeResources = (scope: SyncScope): BaselineResource[] => [...scope.paths.map(path => ({ kind: 'path' as const, path })), ...scope.contractIds.map(id => ({ kind: 'contract' as const, id })), ...scope.flowIds.map(id => ({ kind: 'flow' as const, id }))]
const identityKey = (identity: WorktreeIdentity): string => digest(identity)
const scopeKeys = (scope: SyncScope): string[] => [...new Set([...scope.paths.map(path => `path:${path}`), ...scope.contractIds.map(id => `contract:${id}`), ...scope.flowIds.map(id => `flow:${id}`)])].sort()
const pathOverlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
const resourceOverlap = (a: string, b: string): boolean => {
  const namespaced = /^([^:]+):@([a-f0-9]{64}):(.*)$/
  const left = namespaced.exec(a), right = namespaced.exec(b)
  if (left && right && (left[1] !== right[1] || left[2] !== right[2])) return false
  const l = left ? `${left[1]}:${left[3]}` : a, r = right ? `${right[1]}:${right[3]}` : b
  return l.startsWith('path:') && r.startsWith('path:') ? pathOverlap(l, r) : l === r
}
const overlaps = (a: SyncScope, b: SyncScope): boolean => scopeKeys(a).some(left => scopeKeys(b).some(right => resourceOverlap(left, right)))
const canonicalScope = (scope: SyncScope): SyncScope => ({ paths: [...new Set(scope.paths)].sort(), contractIds: [...new Set(scope.contractIds)].sort(), flowIds: [...new Set(scope.flowIds)].sort() })
const emptyScope = (): SyncScope => ({ paths: [], contractIds: [], flowIds: [] })
const contains = (scope: SyncScope, part: SyncScope): boolean => part.paths.every(path => scope.paths.some(parent => path === parent || path.startsWith(`${parent}/`))) && part.contractIds.every(id => scope.contractIds.includes(id)) && part.flowIds.every(id => scope.flowIds.includes(id))
const union = (a: SyncScope, b: SyncScope): SyncScope => ({ paths: [...new Set([...a.paths, ...b.paths])].sort(), contractIds: [...new Set([...a.contractIds, ...b.contractIds])].sort(), flowIds: [...new Set([...a.flowIds, ...b.flowIds])].sort() })
const TERMINAL = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced', 'cancelled', 'superseded'])
const dispatchStopped = (operation: SyncOperation): boolean => operation.control !== 'run' || TERMINAL.has(operation.phase) || operation.phase === 'budget_exhausted'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const parseRecord = <T>(row: Record<string, unknown> | undefined): T | null => row ? JSON.parse(String(row.record_json)) as T : null
const inputPayload = (input: InputSnapshot): Omit<InputSnapshot, 'capturedAtMs'> => ({ id: input.id, source: input.source, headCommit: input.headCommit, immutableTree: input.immutableTree, indexTree: input.indexTree, indexDigest: input.indexDigest, manifestBlob: input.manifestBlob, contentDigest: input.contentDigest })
const validateScope = (scope: SyncScope): void => {
  if (scope.paths.some(path => !path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..'))) fail('SYNC_SCOPE_INVALID', 'paths must be canonical relative repository paths')
}

/** 同一会话数据库内的协调动作；任何原生会话、文件、Git 或 blob 读取都在事务外。 */
export class SyncStore {
  private readonly now: () => number
  private readonly readBlob: (ref: BlobRef) => Buffer
  constructor(private readonly protocol: SessionProtocol, options: { now?: () => number; readBlob?: (ref: BlobRef) => Buffer } = {}) {
    this.now = options.now ?? Date.now
    this.readBlob = options.readBlob ?? (ref => {
      const bytes = getBlob(ref.sha256)
      if (!bytes) return fail('SYNC_BLOB_MISSING', ref.sha256)
      return bytes
    })
    this.protocol.withTransaction(tx => this.assertSchema(tx))
    applyComponentMigrations(this.protocol, SYNC_COMPONENT, SYNC_MIGRATIONS)
  }
  private assertSchema(tx: ProtocolTransaction): void {
    const version = Number(tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT)[0].version ?? 0)
    if (version !== SYNC_MIGRATIONS.length) fail('SYNC_SCHEMA_UNSUPPORTED', `expected ${SYNC_MIGRATIONS.length}, found ${version}`)
  }
  private write<T>(body: (tx: ProtocolTransaction) => T): T {
    return this.protocol.withTransaction(tx => { this.assertSchema(tx); return body(tx) })
  }
  private operation(tx: ProtocolTransaction, id: string): SyncOperation {
    return parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE id=?', id)[0]) ?? fail('SYNC_OPERATION_UNKNOWN', id)
  }
  private attempt(tx: ProtocolTransaction, id: string): SyncAttempt {
    return parseRecord<SyncAttempt>(tx.query('SELECT record_json FROM sync_attempts WHERE id=?', id)[0]) ?? fail('SYNC_ATTEMPT_UNKNOWN', id)
  }
  private journal(tx: ProtocolTransaction, id: string): ApplyJournal {
    return parseRecord<ApplyJournal>(tx.query('SELECT record_json FROM sync_apply_journals WHERE id=?', id)[0]) ?? fail('SYNC_JOURNAL_UNKNOWN', id)
  }
  private resource(tx: ProtocolTransaction, id: string): SyncResourceRecord {
    return parseRecord<SyncResourceRecord>(tx.query('SELECT record_json FROM sync_resources WHERE id=?', id)[0]) ?? fail('SYNC_RESOURCE_UNKNOWN', id)
  }
  private saveOperation(tx: ProtocolTransaction, operation: SyncOperation): void {
    operation.revision++; operation.updatedAtMs = this.now()
    tx.exec('UPDATE sync_operations SET generation=?,phase=?,control=?,current_attempt_id=?,updated_at_ms=?,record_json=? WHERE id=?', operation.generation, operation.phase, operation.control, operation.currentAttemptId, operation.updatedAtMs, JSON.stringify(operation), operation.id)
  }
  private saveAttempt(tx: ProtocolTransaction, attempt: SyncAttempt): void {
    tx.exec('UPDATE sync_attempts SET generation=?,status=?,expires_at_ms=?,record_json=? WHERE id=?', attempt.generation, attempt.status, attempt.expiresAtMs, JSON.stringify(attempt), attempt.id)
  }
  private saveJournal(tx: ProtocolTransaction, journal: ApplyJournal): void {
    tx.exec('UPDATE sync_apply_journals SET status=?,receipt_id=?,record_json=? WHERE id=?', journal.status, journal.receipt?.id ?? null, JSON.stringify(journal), journal.id)
  }
  private dispatchHead(tx: ProtocolTransaction, repositoryId: string): { operation: SyncOperation; messageId: string; envelope: SyncDispatchEnvelope } | null {
    const row = tx.query('SELECT message_id,kind,body FROM protocol_messages WHERE target_session_id=? AND dequeued_at_ms IS NULL ORDER BY enqueue_seq LIMIT 1', syncCoordinatorAddress(repositoryId))[0]
    if (!row) return null
    if (row.kind !== SYNC_DISPATCH_KIND) fail('SYNC_DISPATCH_INVALID', 'coordinator head is not a typed sync dispatch')
    let envelope: SyncDispatchEnvelope
    try { envelope = JSON.parse(Buffer.from(row.body as Uint8Array).toString('utf8')) as SyncDispatchEnvelope }
    catch (error) { if (error instanceof SyntaxError) fail('SYNC_DISPATCH_INVALID', 'dispatch envelope is not JSON'); throw error }
    if (!envelope || envelope.version !== 1 || envelope.type !== 'sync.dispatch' || typeof envelope.operationId !== 'string') fail('SYNC_DISPATCH_INVALID', 'invalid dispatch envelope')
    const operation = this.operation(tx, envelope.operationId), messageId = String(row.message_id)
    if (operation.input.source.repositoryId !== repositoryId || operation.dispatchMessageId !== messageId || envelope.inputId !== operation.input.id || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1 || envelope.generation > operation.generation || envelope.dispatchKey !== `sync-dispatch-${operation.id}-${envelope.generation}`) fail('SYNC_DISPATCH_BINDING', 'dispatch differs from durable operation')
    return { operation, messageId, envelope }
  }
  nextDispatch(repositoryId: string): { operation: SyncOperation; messageId: string; envelope: SyncDispatchEnvelope } | null { return this.write(tx => this.dispatchHead(tx, repositoryId)) }
  private physicalControl(tx: ProtocolTransaction, scope: PhysicalScope): PhysicalControl {
    scope = physicalScope(scope)
    return parseRecord<PhysicalControl>(tx.query('SELECT record_json FROM sync_physical_controls WHERE scope_key=?', digest(scope))[0]) ?? { scope: clone(scope), control: 'run', revision: 0 }
  }
  readPhysicalControl(scope: PhysicalScope): PhysicalControl { return this.write(tx => this.physicalControl(tx, scope)) }
  readObserverHealth(scope: PhysicalScope): SyncObserverHealth | null {
    return this.write(tx => parseRecord<SyncObserverHealth>(tx.query('SELECT record_json FROM sync_observer_health WHERE scope_key=?', digest(physicalScope(scope)))[0]))
  }
  recordObserverHealth(health: SyncObserverHealth, expectedInstanceId: string | null): SyncObserverHealth {
    for (const ref of health.failure?.evidenceRefs ?? []) this.blob(ref)
    return this.write(tx => {
      const scope = physicalScope(health.scope), key = digest(scope)
      const current = parseRecord<SyncObserverHealth>(tx.query('SELECT record_json FROM sync_observer_health WHERE scope_key=?', key)[0])
      if ((current?.instanceId ?? null) !== expectedInstanceId) fail('SYNC_OBSERVER_STALE', 'observer instance changed')
      const record = clone({ ...health, scope })
      tx.exec('INSERT INTO sync_observer_health(scope_key,record_json) VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record_json=excluded.record_json', key, JSON.stringify(record))
      return record
    })
  }
  requestPhysicalControl(scope: PhysicalScope, control: 'run' | 'pause', expectedRevision: number): PhysicalControl {
    scope = physicalScope(scope)
    return this.write(tx => {
      const current = this.physicalControl(tx, scope)
      if (current.revision !== expectedRevision) fail('SYNC_CONTROL_STALE', 'physical control revision changed')
      const record: PhysicalControl = { scope: clone(scope), control, revision: current.revision + 1 }
      tx.exec('INSERT INTO sync_physical_controls(scope_key,record_json) VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record_json=excluded.record_json', digest(scope), JSON.stringify(record))
      if (control === 'run') for (const row of tx.query("SELECT record_json FROM sync_operations WHERE repository_id=? AND phase='paused'", scope.repositoryId)) {
        const operation = parseRecord<SyncOperation>(row)!
        if (operation.control !== 'run' || digest(physicalScope(operation.input.source)) !== digest(scope) || !operation.currentAttemptId || this.attempt(tx, operation.currentAttemptId).status !== 'settled' || !tx.query("SELECT id FROM sync_apply_journals WHERE operation_id=? AND attempt_id=? AND status='settled' AND receipt_id IS NOT NULL LIMIT 1", operation.id, operation.currentAttemptId).length) continue
        operation.phase = operation.blockedReason ?? (contains(operation.deliveredScope, operation.scope) ? 'workspace_synced' : 'needs_input')
        this.saveOperation(tx, operation)
      }
      return record
    })
  }
  private baselineSelection(tx: ProtocolTransaction, source: WorktreeIdentity, resources: BaselineResource[]): BaselineSelectionResult {
    const exact = [...new Map(resources.map(resource => [resourceKey(resource), resource])).values()].sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)))
    const bindings: BaselineBinding[] = []
    for (const resource of exact) {
      const legacy = resource.kind === 'path' ? tx.query("SELECT resource_key,legacy_reason FROM sync_baseline_heads WHERE source_key=? AND legacy_reason IS NOT NULL AND resource_key LIKE 'path:%'", identityKey(source)).find(row => pathOverlap(resource.path, String(row.resource_key).slice(5))) : undefined
      if (legacy) return { failure: { code: 'SYNC_BASELINE_LEGACY_UNKNOWN', message: String(legacy.legacy_reason), kind: 'unsupported', evidenceRefs: [] } }
      const head = tx.query('SELECT pair_id,legacy_reason FROM sync_baseline_heads WHERE source_key=? AND resource_key=?', identityKey(source), resourceKey(resource))[0]
      if (head?.legacy_reason) return { failure: { code: 'SYNC_BASELINE_LEGACY_UNKNOWN', message: String(head.legacy_reason), kind: 'unsupported', evidenceRefs: [] } }
      const pair = head?.pair_id ? parseRecord<BaselinePair>(tx.query('SELECT record_json FROM sync_baseline_pairs WHERE id=?', String(head.pair_id))[0])! : null
      bindings.push(resource.kind === 'path' ? { resource, bytePair: pair } : { resource, intentPair: pair })
    }
    const body = { version: 'sync-baseline-selection-v1' as const, source: clone(source), bindings }
    return { selection: { ...body, digest: digest(body) } }
  }
  readBaselineSelection(source: WorktreeIdentity, exactResources: BaselineResource[]): BaselineSelectionResult {
    validateScope({ paths: exactResources.flatMap(resource => resource.kind === 'path' ? [resource.path] : []), contractIds: [], flowIds: [] })
    return this.write(tx => this.baselineSelection(tx, source, exactResources))
  }
  private publicationHeads(tx: ProtocolTransaction, source: WorktreeIdentity): PublicationHeads {
    const bindings: BaselineBinding[] = [], unknownPaths: PublicationHeads['unknownPaths'] = []
    for (const row of tx.query("SELECT resource_key,pair_id,legacy_reason FROM sync_baseline_heads WHERE source_key=? AND resource_key LIKE 'path:%' ORDER BY resource_key", identityKey(source))) {
      const path = String(row.resource_key).slice(5)
      if (row.legacy_reason) { unknownPaths.push({ path, reason: String(row.legacy_reason) }); continue }
      const pair = row.pair_id ? parseRecord<BaselinePair>(tx.query('SELECT record_json FROM sync_baseline_pairs WHERE id=?', String(row.pair_id))[0]) : null
      if (!pair || !tx.query("SELECT id FROM sync_apply_journals WHERE receipt_id=? AND status='settled'", pair.receiptId).length) fail('SYNC_PUBLICATION_BASE_BINDING', 'path head lacks settled receipt')
      bindings.push({ resource: { kind: 'path', path }, bytePair: pair })
    }
    const body = { version: 'sync-baseline-selection-v1' as const, source: clone(source), bindings }
    return { selection: { ...body, digest: digest(body) }, unknownPaths }
  }
  readPublicationHeads(source: WorktreeIdentity): PublicationHeads { return this.write(tx => this.publicationHeads(tx, source)) }
  private assertPublicationCurrent(tx: ProtocolTransaction, operation: SyncOperation, attempt: SyncAttempt, heads: PublicationHeads): void {
    const others = tx.query('SELECT a.record_json FROM sync_attempts a JOIN sync_operations o ON o.id=a.operation_id WHERE o.source_key=? AND a.id!=?', identityKey(operation.input.source), attempt.id)
    for (const row of others) {
      const other = parseRecord<SyncAttempt>(row)!
      if (other.publicationBase && (!['failed', 'superseded', 'settled'].includes(other.status) || tx.query("SELECT id FROM sync_resources WHERE attempt_id=? AND phase!='removed' LIMIT 1", other.id).length || tx.query("SELECT id FROM sync_apply_journals WHERE attempt_id=? AND status!='settled' LIMIT 1", other.id).length)) fail('SYNC_PUBLICATION_BUSY', 'same-source frozen publication has not settled or released its resources')
    }
    if (operation.baselineSelection) this.assertSelection(tx, operation.input.source, operation.baselineSelection, scopeResources(operation.scope))
    if (digest(heads) !== digest(this.publicationHeads(tx, operation.input.source))) fail('SYNC_PUBLICATION_BASE_STALE', 'publication frontier advanced after freezing')
  }
  /** 已冻结但尚未应用时复核持久发布权；真实 applying 恢复仍结算原 journal。 */
  assertPublicationBaseCurrent(operationId: string, attemptId: string): void {
    const before = this.readAttempt(attemptId)
    if (!before.publicationBase) return
    const ref = before.publicationBase.provenanceBlob, provenance = JSON.parse(this.blob(ref).toString()) as { heads: PublicationHeads }
    this.write(tx => {
      const operation = this.operation(tx, operationId), attempt = this.attempt(tx, attemptId)
      if (attempt.operationId !== operation.id || operation.currentAttemptId !== attempt.id || attempt.publicationBase?.provenanceBlob.sha256 !== ref.sha256) fail('SYNC_PUBLICATION_BASE_BINDING', 'publication attempt changed')
      if (['applying', 'settled'].includes(attempt.status)) return
      this.assertPublicationCurrent(tx, operation, attempt, provenance.heads)
    })
  }
  listBaselineResources(source: WorktreeIdentity): BaselineResource[] {
    return this.write(tx => tx.query('SELECT resource_key FROM sync_baseline_heads WHERE source_key=? ORDER BY resource_key', identityKey(source)).map(row => {
      const key = String(row.resource_key), separator = key.indexOf(':'), kind = key.slice(0, separator), value = key.slice(separator + 1)
      if (kind === 'path') return { kind, path: value }
      if (kind === 'contract' || kind === 'flow') return { kind, id: value }
      return fail('SYNC_BASELINE_RESOURCE_INVALID', key)
    }))
  }
  private assertSelection(tx: ProtocolTransaction, source: WorktreeIdentity, selection: FrozenBaselineSelection, resources: BaselineResource[]): void {
    const selected = selection.bindings.map(binding => binding.resource)
    if (resources.some(resource => !selected.some(item => resourceKey(item) === resourceKey(resource)))) fail('SYNC_BASELINE_STALE', 'selection must explicitly bind every operation write resource')
    const current = this.baselineSelection(tx, source, selected)
    if ('failure' in current) fail(current.failure.code, current.failure.message)
    if (digest(selection.source) !== digest(source) || selection.digest !== digest({ version: selection.version, source: selection.source, bindings: selection.bindings }) || current.selection.digest !== selection.digest) fail('SYNC_BASELINE_STALE', 'exact baseline frontier changed or selection is incomplete')
  }
  private compatibleSelection(tx: ProtocolTransaction, operation: SyncOperation, incoming: FrozenBaselineSelection): boolean {
    if (!operation.baselineSelection || identityKey(incoming.source) !== identityKey(operation.input.source)) return false
    return incoming.bindings.every(binding => {
      const prior = operation.baselineSelection!.bindings.find(item => resourceKey(item.resource) === resourceKey(binding.resource))
      if (!prior) return false
      const old = 'bytePair' in prior ? prior.bytePair : prior.intentPair, next = 'bytePair' in binding ? binding.bytePair : binding.intentPair
      if ((old?.id ?? null) === (next?.id ?? null)) return true
      return next !== null && tx.query('SELECT operation_id FROM sync_apply_journals WHERE receipt_id=? AND status=?', next.receiptId, 'settled')[0]?.operation_id === operation.id
    })
  }
  ackDispatch(repositoryId: string, expectedMessageId: string): SyncOperation {
    return this.write(tx => {
      const head = this.dispatchHead(tx, repositoryId)
      if (!head || head.messageId !== expectedMessageId) fail('SYNC_DISPATCH_MISMATCH', 'expected message is not protocol FIFO head')
      const { operation } = head
      const row = tx.query('SELECT enqueue_seq FROM protocol_messages WHERE message_id=?', expectedMessageId)[0]
      operation.dispatchAnchor ??= { scope: physicalScope(operation.input.source), firstMessageId: expectedMessageId, firstEnqueueSeq: Number(row.enqueue_seq), budgetRootOperationId: operation.id }
      operation.dispatchAcknowledged = true
      this.saveOperation(tx, operation)
      tx.dequeue(syncCoordinatorAddress(repositoryId), expectedMessageId)
      return operation
    })
  }
  private queuedPredecessor(tx: ProtocolTransaction, operation: SyncOperation): boolean {
    const seq = operation.dispatchAnchor!.firstEnqueueSeq
    return tx.query('SELECT record_json FROM sync_operations WHERE repository_id=?', operation.input.source.repositoryId).map(row => parseRecord<SyncOperation>(row)!).some(other => {
      if (other.id === operation.id || TERMINAL.has(other.phase) || ['failed', 'budget_exhausted', 'conflicted', 'needs_input'].includes(other.phase) || !this.leaseKeys(other, scopeKeys(other.scope)).some(left => this.leaseKeys(operation, scopeKeys(operation.scope)).some(right => resourceOverlap(left,right)))) return false
      const otherSeq = other.dispatchAnchor?.firstEnqueueSeq ?? Number(tx.query('SELECT enqueue_seq FROM protocol_messages WHERE message_id=?', other.dispatchMessageId)[0]?.enqueue_seq)
      return otherSeq < seq || otherSeq === seq && other.successorOf === operation.id
    })
  }
  private queuedRunnable(tx: ProtocolTransaction, operation: SyncOperation, continuation = false): boolean {
    if (tx.query("SELECT id FROM sync_resources WHERE operation_id=? AND phase!='removed' LIMIT 1", operation.id).length || tx.query("SELECT id FROM sync_apply_journals WHERE operation_id=? AND status!='settled' LIMIT 1", operation.id).length) return false
    const old = continuation && operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
    const resume = old && !['applying', 'settled', 'superseded'].includes(old.status) && (old.expiresAtMs <= this.now() && old.status !== 'failed' || old.failure?.kind === 'repairable' || old.verification?.passed === false)
    if (!resume && operation.phase !== 'queued' || !operation.dispatchAcknowledged || !operation.dispatchAnchor || operation.control !== 'run' || this.physicalControl(tx, physicalScope(operation.input.source)).control !== 'run' || dispatchStopped(operation) || ['applying', 'recovery_required', 'needs_input', 'conflicted'].includes(operation.phase) || this.queuedPredecessor(tx, operation)) return false
    const held = tx.query('SELECT resource_key,operation_id,attempt_id,expires_at_ms FROM sync_leases WHERE repository_id=? AND token IS NOT NULL', operation.input.source.repositoryId)
    return !held.some(row => row.operation_id !== operation.id && (Number(row.expires_at_ms) > this.now() || tx.query("SELECT id FROM sync_resources WHERE attempt_id=? AND phase!='removed' LIMIT 1", String(row.attempt_id)).length > 0) && this.leaseKeys(operation, scopeKeys(operation.scope)).some(key => resourceOverlap(key, String(row.resource_key))))
  }
  nextQueued(repositoryId: string): SyncOperation | null {
    return this.write(tx => tx.query('SELECT record_json FROM sync_operations WHERE repository_id=?', repositoryId).map(row => parseRecord<SyncOperation>(row)!).filter(operation => this.queuedRunnable(tx, operation)).sort((a,b) => a.dispatchAnchor!.firstEnqueueSeq - b.dispatchAnchor!.firstEnqueueSeq)[0] ?? null)
  }
  claimQueuedAttempt(input: ClaimQueuedAttemptInput): ClaimedAttempt { return this.claim(input, true) }
  private release(tx: ProtocolTransaction, token: string): void {
    if (tx.query("SELECT r.id FROM sync_resources r JOIN sync_attempts a ON a.id=r.attempt_id WHERE a.record_json->>'$.leaseToken'=? AND r.phase!='removed' LIMIT 1", token).length) return
    tx.exec('UPDATE sync_leases SET token=NULL,operation_id=NULL,attempt_id=NULL,expires_at_ms=NULL WHERE token=?', token)
  }
  private leaseKeys(operation: SyncOperation, keys: string[]): string[] {
    if (!operation.baselineSelection) return keys
    const source = identityKey(operation.input.source), target = digest({ repositoryId: operation.input.source.repositoryId, canonicalRoot: operation.deliveryPlan.canonicalRoot, branch: operation.deliveryPlan.branch })
    return keys.flatMap(key => {
      const separator = key.indexOf(':'), kind = key.slice(0, separator), value = key.slice(separator + 1)
      return kind === 'path' ? [`path:@${source}:${value}`, `path:@${target}:${value}`] : [`${kind}:@${source}:${value}`]
    })
  }
  private acquireResources(tx: ProtocolTransaction, operation: SyncOperation, attempt: SyncAttempt, keys: string[]): void {
    keys = this.leaseKeys(operation, keys)
    const held = tx.query('SELECT l.resource_key,l.token,l.attempt_id,l.expires_at_ms,a.status FROM sync_leases l LEFT JOIN sync_attempts a ON a.id=l.attempt_id WHERE l.repository_id=? AND l.token IS NOT NULL', operation.input.source.repositoryId)
    const owns = (row: Record<string, unknown>): boolean => row.token === attempt.leaseToken && row.attempt_id === attempt.id
    for (const row of held) if (!owns(row) && (Number(row.expires_at_ms) > this.now() || row.status === 'applying' || tx.query("SELECT id FROM sync_resources WHERE attempt_id=? AND phase!='removed' LIMIT 1", String(row.attempt_id)).length > 0) && keys.some(key => resourceOverlap(key, String(row.resource_key)))) fail('SYNC_LEASE_CONFLICT', String(row.resource_key))
    for (const key of keys) if (!held.some(row => row.resource_key === key && owns(row))) tx.exec('INSERT INTO sync_leases(repository_id,resource_key,generation,token,operation_id,attempt_id,expires_at_ms) VALUES(?,?,1,?,?,?,?) ON CONFLICT(repository_id,resource_key) DO UPDATE SET generation=generation+1,token=excluded.token,operation_id=excluded.operation_id,attempt_id=excluded.attempt_id,expires_at_ms=excluded.expires_at_ms', operation.input.source.repositoryId, key, attempt.leaseToken, operation.id, attempt.id, attempt.expiresAtMs)
  }
  private checkFence(tx: ProtocolTransaction, fence: WriteFence, finishing = false): { operation: SyncOperation; attempt: SyncAttempt } {
    const operation = this.operation(tx, fence.operationId), attempt = this.attempt(tx, fence.attemptId)
    if (operation.baselineSelection && attempt.baselineSelectionDigest !== operation.baselineSelection.digest) fail('SYNC_FENCE_EXPIRED', 'attempt baseline selection changed')
    if (operation.currentAttemptId !== attempt.id || operation.generation !== fence.generation || attempt.generation !== fence.generation || attempt.operationId !== operation.id || operation.input.source.physicalFingerprint !== fence.sourceFingerprint || attempt.leaseToken !== fence.leaseToken || attempt.status === 'superseded' || attempt.status === 'settled' || attempt.status === 'failed') fail('SYNC_FENCE_EXPIRED', 'operation, attempt, generation or physical source changed')
    const applying = ['applying', 'cancelling', 'pausing', 'recovery_required'].includes(operation.phase)
    if ((!finishing && this.now() >= operation.deadlineAtMs) || operation.phase === 'superseded' || (!finishing && (operation.control !== 'run' || this.physicalControl(tx, physicalScope(operation.input.source)).control !== 'run')) || (attempt.expiresAtMs <= this.now() && !(finishing && applying))) fail('SYNC_FENCE_EXPIRED', 'write authority is expired or controlled')
    const rows = tx.query('SELECT resource_key,token,attempt_id FROM sync_leases WHERE token=?', fence.leaseToken)
    const required = this.leaseKeys(operation, scopeKeys(operation.readyScope))
    if (!required.every(key => rows.some(row => row.resource_key === key && row.attempt_id === attempt.id))) fail('SYNC_FENCE_EXPIRED', 'a resource lease was released or replaced')
    if (!finishing && operation.baselineSelection) this.assertSelection(tx, operation.input.source, operation.baselineSelection, scopeResources(operation.scope))
    return { operation, attempt }
  }
  private blob(ref: BlobRef): Buffer {
    const bytes = this.readBlob(ref)
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) fail('SYNC_BLOB_DIGEST_MISMATCH', ref.sha256)
    return bytes
  }
  private manifest(ref: BlobRef): Map<string, { mode: string; digest: string }> {
    const manifest = JSON.parse(this.blob(ref).toString('utf8')) as { version: number; entries: { path: string; mode: string; oid: string; digest: string }[] }
    if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.some(entry => typeof entry.path !== 'string' || !['100644', '100755', '120000'].includes(entry.mode) || !/^[0-9a-f]{64}$/.test(entry.digest) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.oid)) || new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) fail('SYNC_MANIFEST_INVALID', 'manifest must contain unique canonical Git file entries')
    validateScope({ paths: manifest.entries.map(entry => entry.path), contractIds: [], flowIds: [] })
    return new Map(manifest.entries.map(entry => [entry.path, entry]))
  }
  private manifestDiff(before: BlobRef, after: BlobRef): ApplyFilePlan[] {
    const left = this.manifest(before), right = this.manifest(after)
    return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(path => {
      const pre = left.get(path), post = right.get(path)
      return pre?.digest === post?.digest && pre?.mode === post?.mode ? [] : [{ path, preDigest: pre?.digest ?? null, postDigest: post?.digest ?? null, preMode: pre?.mode ?? null, postMode: post?.mode ?? null }]
    })
  }
  private diff(candidate: CandidateRef): ApplyFilePlan[] {
    const files: unknown = JSON.parse(this.blob(candidate.actualDiffBlob).toString('utf8'))
    if (!Array.isArray(files) || files.some(file => !file || typeof file.path !== 'string' || !['preDigest', 'postDigest', 'preMode', 'postMode'].every(key => Object.hasOwn(file, key)))) fail('SYNC_DIFF_INVALID', 'actual diff must be ApplyFilePlan[]')
    validateScope({ paths: files.map(file => file.path), contractIds: [], flowIds: [] })
    return files as ApplyFilePlan[]
  }
  private normalizedSemanticDigest(input: Pick<SyncOperation, 'input' | 'requestBlob' | 'origin' | 'policyDigest' | 'scope' | 'retryOf' | 'baselineSelection'>): string {
    if (!input.requestBlob) return syncSemanticDigest(input)
    const evidence = JSON.parse(this.blob(input.requestBlob).toString('utf8')) as { type?: string }
    if (evidence.type === 'sync.decision') {
      const decision = readControlledDecision(input.input, input.requestBlob)
      return digest({ source: input.input.source, inputId: input.input.id, origin: input.origin, decision: controlledDecisionIdentity(decision), retryOf: input.retryOf ?? null })
    }
    const request = readControlledRequest(input.input, input.requestBlob)
    const { requestId: _requestId, ...origin } = request.origin
    return syncSemanticDigest({ ...input, requestBlob: { sha256: digest({ ...request, origin }) } })
  }
  private saveIngressReceipt(tx: ProtocolTransaction, input: AdmitSyncInput, operationId: string, payloadDigest: string): void {
    const receipt: SyncIngressReceipt = { operationId, payloadDigest, input: clone(input.input), origin: input.origin, ...(input.requestBlob ? { requestBlob: input.requestBlob } : {}), budget: input.budget, deliveryPlan: input.deliveryPlan, previousBaselinePair: input.previousBaselinePair ?? null, ...(input.baselineSelection ? { baselineSelection: clone(input.baselineSelection) } : {}) }
    tx.exec('INSERT INTO sync_ingress_receipts(ingress_key,operation_id,payload_digest,record_json) VALUES(?,?,?,?)', input.ingressKey, operationId, payloadDigest, JSON.stringify(receipt))
  }
  /** 稳定接入记录与既有消息派发计划共享一个 SQL 事务。 */
  admitAndEnqueue(input: AdmitSyncInput): SyncOperation { return this.admitWithObservation(input) }
  private admitWithObservation(input: AdmitSyncInput, observation?: SyncObservation): SyncOperation {
    validateScope(input.scope)
    if (input.retryOf !== undefined && (typeof input.retryOf !== 'string' || !input.retryOf.trim())) fail('SYNC_RETRY_BINDING', '显式重试需要有效的原operation身份')
    this.blob(input.input.manifestBlob)
    if (input.retryOf && (this.readOperation(input.retryOf).requestBlob?.sha256 ?? null) !== (input.requestBlob?.sha256 ?? null)) fail('SYNC_RETRY_BINDING', '显式重试必须继承原始用户请求引用')
    if (input.planBlob) { this.blob(input.planBlob); if (input.planBlob.sha256 !== input.policyDigest) fail('SYNC_PLAN_BINDING', 'plan evidence must have exactly the frozen policy digest') }
    if (input.delivery && (input.delivery.canonicalRoot !== input.deliveryPlan.canonicalRoot || input.delivery.branch !== input.deliveryPlan.branch || input.delivery.repositoryId !== input.input.source.repositoryId)) fail('SYNC_DELIVERY_BINDING', 'bound delivery differs from durable plan')
    const payload = { input: inputPayload(input.input), ...(input.requestBlob ? { requestBlob: input.requestBlob } : {}), ...(input.planBlob ? { planBlob: input.planBlob } : {}), ...(input.retryOf ? { retryOf: input.retryOf } : {}), scope: canonicalScope(input.scope), policyDigest: input.policyDigest, impactDigest: input.impactDigest, readSetDigest: input.readSetDigest, deliveryPlan: input.deliveryPlan, previousBaselinePairId: input.previousBaselinePair?.id ?? null, ...(input.baselineSelection ? { baselineSelectionDigest: input.baselineSelection.digest } : {}), budget: input.budget }
    const legacyPayloadDigest = digest(payload), payloadDigest = digest({ ...payload, origin: input.origin })
    const requestType = input.requestBlob ? JSON.parse(this.blob(input.requestBlob).toString('utf8')) as { type?: string } : null
    const decision = requestType?.type === 'sync.decision' ? readControlledDecision(input.input, input.requestBlob!) : null
    if (decision && input.origin !== 'decision') fail('SYNC_DECISION_BINDING', '业务裁决需要decision来源')
    const semanticDigest = this.normalizedSemanticDigest(input)
    const compatibleCandidates = input.baselineSelection ? this.write(tx => tx.query("SELECT record_json FROM sync_operations WHERE repository_id=? AND source_key=? AND json_extract(record_json,'$.input.id')=? AND json_extract(record_json,'$.origin')=? AND json_extract(record_json,'$.retryOf') IS ?", input.input.source.repositoryId, identityKey(input.input.source), input.input.id, input.origin, input.retryOf ?? null).map(row => parseRecord<SyncOperation>(row)!).filter(operation => operation.baselineSelection && contains(operation.scope, canonicalScope(input.scope)) && (decision || operation.policyDigest === input.policyDigest))) : []
    const semanticIntent = input.baselineSelection ? this.normalizedSemanticDigest({ ...input, baselineSelection: undefined }) : null
    const compatibleIds = compatibleCandidates.filter(operation => this.normalizedSemanticDigest({ ...operation, scope: input.scope, baselineSelection: undefined }) === semanticIntent).map(operation => operation.id)
    const legacyCandidates = this.write(tx => tx.query("SELECT record_json FROM sync_operations WHERE repository_id=? AND source_key=? AND json_extract(record_json,'$.input.id')=? AND json_extract(record_json,'$.origin')=? AND json_extract(record_json,'$.retryOf') IS ? AND (? OR normalized_semantic_digest IS NULL AND json_extract(record_json,'$.policyDigest')=?)", input.input.source.repositoryId, identityKey(input.input.source), input.input.id, input.origin, input.retryOf ?? null, decision ? 1 : 0, input.policyDigest).map(row => parseRecord<SyncOperation>(row)!).filter(operation => decision || digest(canonicalScope(operation.scope).paths) === digest(canonicalScope(input.scope).paths)))
    const normalized = legacyCandidates.map(operation => {
      try { return { id: operation.id, digest: this.normalizedSemanticDigest(operation) } }
      catch (error) { fail('SYNC_REQUEST_IDENTITY_UNAVAILABLE', `旧请求 ${operation.id} 的不可变证据不能核验：${error instanceof Error ? error.message : String(error)}`) }
    })
    return this.write(tx => {
      if (observation) {
        if (this.physicalControl(tx, physicalScope(input.input.source)).revision !== observation.controlRevision) fail('SYNC_CONTROL_STALE', 'observation physical control changed')
        if (!input.baselineSelection || input.baselineSelection.digest !== observation.selectionDigest) fail('SYNC_BASELINE_STALE', 'observation selection differs from frozen input')
      }
      if (observation && input.baselineSelection) this.assertSelection(tx, input.input.source, input.baselineSelection, scopeResources(input.scope))
      const finish = (operation: SyncOperation, outcome: 'admitted' | 'coalesced' | 'duplicate'): SyncOperation => {
        if (observation) { observation.operationId = operation.id; observation.outcome = outcome; this.saveObservation(tx, observation) }
        return operation
      }
      for (const operation of normalized) tx.exec('UPDATE sync_operations SET normalized_semantic_digest=? WHERE id=?', operation.digest, operation.id)
      const prior = parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE ingress_key=? OR EXISTS (SELECT 1 FROM json_each(sync_operations.ingress_aliases_json) WHERE value=?)', input.ingressKey, input.ingressKey)[0])
      if (prior) { const receipt = parseRecord<SyncIngressReceipt>(tx.query('SELECT record_json FROM sync_ingress_receipts WHERE ingress_key=?', input.ingressKey)[0]); if ((receipt?.origin ?? prior.origin) !== input.origin || !(receipt ? receipt.payloadDigest === payloadDigest : [payloadDigest, legacyPayloadDigest].includes(prior.payloadDigest))) fail('SYNC_IDEMPOTENCY_CONFLICT', input.ingressKey); return finish(prior, 'duplicate') }
      if (observation && !input.retryOf && !input.requestBlob) {
        const previous = parseRecord<SyncObservation>(tx.query("SELECT record_json FROM sync_observations WHERE source_key=? AND json_extract(record_json,'$.configRef.sha256')=? AND json_extract(record_json,'$.latestDifferenceDigest')=? AND json_extract(record_json,'$.selectionDigest')=? AND json_extract(record_json,'$.outcome') IN ('admitted','coalesced','duplicate') AND operation_id IS NOT NULL ORDER BY rowid DESC LIMIT 1", identityKey(input.input.source), observation.configRef.sha256, observation.latestDifferenceDigest, observation.selectionDigest)[0])
        if (previous) {
          const existing = this.operation(tx, previous.operationId!)
          tx.exec("UPDATE sync_operations SET ingress_aliases_json=json_insert(ingress_aliases_json,'$[#]',?) WHERE id=?", input.ingressKey, existing.id)
          this.saveIngressReceipt(tx, input, existing.id, payloadDigest)
          return finish(existing, 'duplicate')
        }
      }
      const compatible = compatibleIds.map(id => this.operation(tx, id)).find(operation => this.compatibleSelection(tx, operation, input.baselineSelection!))
      const sameInput = compatible ?? parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE normalized_semantic_digest=? ORDER BY rowid DESC LIMIT 1', semanticDigest)[0])
      if (sameInput) { tx.exec("UPDATE sync_operations SET ingress_aliases_json=json_insert(ingress_aliases_json,'$[#]',?) WHERE id=?", input.ingressKey, sameInput.id); this.saveIngressReceipt(tx, input, sameInput.id, payloadDigest); return finish(sameInput, 'duplicate') }
      if (input.baselineSelection) this.assertSelection(tx, input.input.source, input.baselineSelection, scopeResources(input.scope))
      if (input.retryOf) {
        const previous = this.operation(tx, input.retryOf), eligibility = this.retryEligibility(tx, previous)
        if (!eligibility.eligible) fail(eligibility.reason!.code, eligibility.reason!.message)
        if ((previous.baselineSelection?.digest ?? null) !== (input.baselineSelection?.digest ?? null) || previous.origin !== input.origin || identityKey(previous.input.source) !== identityKey(input.input.source) || digest(inputPayload(previous.input)) !== digest(inputPayload(input.input)) || (previous.requestBlob?.sha256 ?? null) !== (input.requestBlob?.sha256 ?? null) || previous.policyDigest !== input.policyDigest || previous.impactDigest !== input.impactDigest || previous.readSetDigest !== input.readSetDigest || previous.deliveryPlan.baseCommit !== input.deliveryPlan.baseCommit || (previous.previousBaselinePair?.id ?? null) !== (input.previousBaselinePair?.id ?? null) || digest(previous.scope.paths) !== digest(canonicalScope(input.scope).paths) || !contains(previous.scope, input.scope)) fail('SYNC_RETRY_BINDING', '显式重试必须完整复用原冻结来源、用户请求、政策及授权范围')
        if (input.ingressKey === previous.ingressKey || input.rootCauseId === previous.rootCauseId) fail('SYNC_RETRY_BINDING', '显式重试需要新的用户请求身份')
      }
      if (input.previousBaselinePair) {
        const pair = parseRecord<BaselinePair>(tx.query('SELECT record_json FROM sync_baseline_pairs WHERE id=?', input.previousBaselinePair.id)[0])
        if (!pair || identityKey(pair.source) !== identityKey(input.input.source) || digest(pair) !== digest(input.previousBaselinePair)) fail('SYNC_BASELINE_STALE', 'previous source baseline does not match durable pair')
      }
      if (decision) {
        const parent = this.operation(tx, decision.operationId), eligibility = this.decisionEligibility(tx, parent)
        if (parent.input.id !== input.input.id || identityKey(parent.input.source) !== identityKey(input.input.source)) fail('SYNC_DECISION_BINDING', '裁决必须绑定原操作完整冻结来源')
        if (!eligibility.eligible) fail(eligibility.reason!.code, eligibility.reason!.message)
      }
      const older = tx.query('SELECT record_json FROM sync_operations WHERE repository_id=? AND source_root=?', input.input.source.repositoryId, input.input.source.canonicalRoot).map(row => parseRecord<SyncOperation>(row)!)
      const predecessor = observation && input.baselineSelection && !input.retryOf ? older.filter(operation => identityKey(operation.input.source) === identityKey(input.input.source) && digest(canonicalScope(operation.scope)) === digest(canonicalScope(input.scope)) && !TERMINAL.has(operation.phase)).sort((a,b) => (b.dispatchAnchor?.firstEnqueueSeq ?? 0) - (a.dispatchAnchor?.firstEnqueueSeq ?? 0))[0] : undefined
      const inheritedAnchor = predecessor ? predecessor.dispatchAnchor ?? {
        scope: physicalScope(predecessor.input.source), firstMessageId: predecessor.dispatchMessageId,
        firstEnqueueSeq: Number(tx.query('SELECT enqueue_seq FROM protocol_messages WHERE message_id=?', predecessor.dispatchMessageId)[0].enqueue_seq),
        budgetRootOperationId: predecessor.id,
      } : undefined
      const generation = Math.max(0, ...older.map(operation => operation.generation)) + 1
      for (const operation of older) {
        if (TERMINAL.has(operation.phase) || operation.id === input.retryOf) continue
        if (identityKey(operation.input.source) !== identityKey(input.input.source) || overlaps(operation.scope, input.scope)) {
          if (['applying', 'cancelling', 'pausing', 'recovery_required'].includes(operation.phase)) { operation.control = 'cancel'; operation.phase = 'cancelling' }
          else {
            operation.phase = 'superseded'
            if (operation.currentAttemptId) { const attempt = this.attempt(tx, operation.currentAttemptId); attempt.status = 'superseded'; this.saveAttempt(tx, attempt); this.release(tx, attempt.leaseToken) }
          }
          this.saveOperation(tx, operation)
        }
      }
      const id = randomUUID(), dispatchKey = `sync-dispatch-${id}-${generation}`
      const envelope: SyncDispatchEnvelope = { version: 1, type: 'sync.dispatch', operationId: id, inputId: input.input.id, generation, dispatchKey }
      const address = syncCoordinatorAddress(input.input.source.repositoryId)
      tx.initialize(address)
      const message = tx.enqueue(address, { kind: SYNC_DISPATCH_KIND, body: Buffer.from(JSON.stringify(envelope)), idempotencyKey: dispatchKey })
      const operation: SyncOperation = { ...clone(input), scope: canonicalScope(input.scope), id, payloadDigest, generation, revision: 1, phase: 'queued', control: 'run', previousBaselinePair: clone(input.previousBaselinePair ?? null), ...(predecessor ? { successorOf: predecessor.id, ...(inheritedAnchor ? { dispatchAnchor: clone(inheritedAnchor) } : {}), budget: clone(predecessor.budget) } : {}), readyScope: canonicalScope(input.scope), blockedScope: emptyScope(), deliveredScope: emptyScope(), blockedReason: null, callsUsed: 0, deadlineAtMs: predecessor?.deadlineAtMs ?? this.now() + input.budget.timeoutMs, currentAttemptId: null, dispatchMessageId: message.messageId, createdAtMs: this.now(), updatedAtMs: this.now() }
      tx.exec('INSERT INTO sync_operations(id,ingress_key,payload_digest,semantic_digest,normalized_semantic_digest,repository_id,source_key,source_root,generation,phase,control,current_attempt_id,updated_at_ms,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, input.ingressKey, payloadDigest, syncSemanticDigest(input), semanticDigest, input.input.source.repositoryId, identityKey(input.input.source), input.input.source.canonicalRoot, generation, operation.phase, operation.control, null, operation.updatedAtMs, JSON.stringify(operation))
      operation.dispatchAnchor ??= { scope: physicalScope(operation.input.source), firstMessageId: message.messageId, firstEnqueueSeq: Number(tx.query('SELECT enqueue_seq FROM protocol_messages WHERE message_id=?', message.messageId)[0].enqueue_seq), budgetRootOperationId: operation.id }
      tx.exec('UPDATE sync_operations SET record_json=? WHERE id=?', JSON.stringify(operation), operation.id)
      this.saveIngressReceipt(tx, input, operation.id, payloadDigest)
      return finish(operation, predecessor ? 'coalesced' : 'admitted')
    })
  }
  private saveObservation(tx: ProtocolTransaction, observation: SyncObservation): void {
    tx.exec('INSERT INTO sync_observations(id,source_key,operation_id,record_json) VALUES(?,?,?,?)', observation.id, identityKey(observation.input.source), observation.operationId, JSON.stringify(observation))
  }
  recordObservation(input: SyncObservationInput, expected: { controlRevision: number; selectionDigest: string | null }): SyncObservation {
    this.blob(input.configRef); this.blob(input.input.manifestBlob)
    const observation: SyncObservation = { ...clone(input), id: randomUUID(), ...expected, observedAtMs: this.now(), operationId: null, outcome: 'observed', reason: null }
    return this.write(tx => { this.saveObservation(tx, observation); return observation })
  }
  observeAndAdmit(input: SyncObservationInput, admission: AdmitSyncInput, expected: { controlRevision: number; selectionDigest: string }): ObserveAndAdmitResult {
    this.blob(input.configRef)
    const observation: SyncObservation = { ...clone(input), id: randomUUID(), ...expected, observedAtMs: this.now(), operationId: null, outcome: 'observed', reason: null }
    if (input.failure) { observation.outcome = 'blocked'; observation.reason = clone(input.failure); this.write(tx => this.saveObservation(tx, observation)); return { outcome: 'blocked', observation, reason: input.failure } }
    try {
      if (!input.selection || digest(inputPayload(input.input)) !== digest(inputPayload(admission.input)) || input.selection.digest !== admission.baselineSelection?.digest || input.selection.digest !== expected.selectionDigest) fail('SYNC_OBSERVATION_BINDING', 'captured snapshot or selection differs from planned admission')
      const operation = this.admitWithObservation(admission, observation)
      return { outcome: observation.outcome as 'admitted' | 'coalesced' | 'duplicate', operation, observation }
    } catch (error) {
      if (!(error instanceof SyncStoreError)) throw error
      const reason: SyncFailure = { code: error.code, message: error.message, kind: error.code === 'SYNC_BASELINE_LEGACY_UNKNOWN' ? 'unsupported' : 'conflict', evidenceRefs: [] }
      observation.outcome = 'blocked'; observation.reason = reason
      this.write(tx => this.saveObservation(tx, observation))
      return { outcome: 'blocked', observation, reason }
    }
  }
  readLatestObservation(source: WorktreeIdentity): SyncObservation | null {
    return this.write(tx => parseRecord<SyncObservation>(tx.query('SELECT record_json FROM sync_observations WHERE source_key=? ORDER BY rowid DESC LIMIT 1', identityKey(source))[0]))
  }
  listObservations(source: WorktreeIdentity, limit = 100): SyncObservation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('SYNC_LIST_LIMIT', 'limit must be an integer between 1 and 500')
    return this.write(tx => tx.query('SELECT record_json FROM sync_observations WHERE source_key=? ORDER BY rowid DESC LIMIT ?', identityKey(source), limit).map(row => parseRecord<SyncObservation>(row)!))
  }
  private family(tx: ProtocolTransaction, operation: SyncOperation): { calls: number; attempts: SyncAttempt[] } {
    const root = operation.dispatchAnchor?.budgetRootOperationId ?? operation.id
    const ids = tx.query('SELECT record_json FROM sync_operations WHERE repository_id=?', operation.input.source.repositoryId).map(row => parseRecord<SyncOperation>(row)!).filter(item => (item.dispatchAnchor?.budgetRootOperationId ?? item.id) === root).map(item => item.id)
    const attempts = ids.flatMap(id => tx.query('SELECT record_json FROM sync_attempts WHERE operation_id=?', id).map(row => parseRecord<SyncAttempt>(row)!))
    return { attempts, calls: attempts.reduce((sum, attempt) => sum + attempt.dispatchPlans.length, 0) }
  }
  discardDispatch(operationId: string, expectedMessageId: string): void {
    this.write(tx => {
      const operation = this.operation(tx, operationId)
      if (operation.dispatchMessageId !== expectedMessageId || !dispatchStopped(operation)) fail('SYNC_DISPATCH_NOT_STALE', 'dispatch still requires a durable attempt')
      tx.dequeue(syncCoordinatorAddress(operation.input.source.repositoryId), expectedMessageId)
    })
  }
  claimAttempt(input: ClaimAttemptInput): ClaimedAttempt { return this.claim(input, false) }
  private claim(input: ClaimAttemptInput | ClaimQueuedAttemptInput, queued: boolean): ClaimedAttempt {
    validateScope(input.scope)
    return this.write(tx => {
      const operation = this.operation(tx, input.operationId)
      if (!queued && operation.baselineSelection) fail('SYNC_CLAIM_LEGACY_ONLY', 'P4 attempts require durable ack and revision checked queued claim')
      if (queued && operation.baselineSelection) this.assertSelection(tx, operation.input.source, operation.baselineSelection, scopeResources(operation.scope))
      if (queued && (!('expectedRevision' in input) || operation.revision !== input.expectedRevision || !this.queuedRunnable(tx, operation, 'continuation' in input && input.continuation === true))) fail('SYNC_QUEUED_STALE', 'queued operation revision, control, predecessor or leases changed')
      if (this.physicalControl(tx, physicalScope(operation.input.source)).control !== 'run') fail('SYNC_PHYSICAL_PAUSED', 'physical scope is paused')
      if (operation.control !== 'run' || TERMINAL.has(operation.phase) || ['applying', 'cancelling', 'pausing', 'recovery_required'].includes(operation.phase)) fail('SYNC_CLAIM_REFUSED', operation.phase)
      if (identityKey(operation.input.source) !== identityKey(input.source)) fail('SYNC_SOURCE_CHANGED', 'worktree physical identity changed')
      if (!contains(operation.scope, input.scope) || !scopeKeys(input.scope).length) fail('SYNC_SCOPE_INVALID', 'lease scope must be a nonempty operation subset')
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) fail('SYNC_LEASE_INVALID', 'leaseMs must be positive')
      const old = operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
      if (old && old.expiresAtMs > this.now() && !['failed', 'superseded', 'settled'].includes(old.status)) fail('SYNC_ATTEMPT_ACTIVE', old.id)
      if (old) { old.status = 'superseded'; this.saveAttempt(tx, old); this.release(tx, old.leaseToken); operation.generation++ }
      const number = Number(tx.query('SELECT MAX(number) AS number FROM sync_attempts WHERE operation_id=?', operation.id)[0].number ?? 0) + 1
      const family = this.family(tx, operation)
      const repairFailures = family.attempts.filter(attempt => attempt.verification?.passed === false || attempt.failure?.kind === 'repairable').length
      if (this.now() >= operation.deadlineAtMs || family.calls >= operation.budget.maxCalls || repairFailures > operation.budget.maxRepairs) fail('SYNC_BUDGET_EXHAUSTED', 'deadline or repair budget exhausted')
      if (family.attempts.length >= operation.budget.maxAttempts) fail('SYNC_BUDGET_EXHAUSTED', 'attempt budget exhausted')
      const resources = scopeKeys(input.scope)
      const id = randomUUID(), token = randomUUID(), expiresAtMs = this.now() + input.leaseMs
      const attempt: SyncAttempt = { id, operationId: operation.id, number, generation: operation.generation, ...(operation.baselineSelection ? { baselineSelectionDigest: operation.baselineSelection.digest } : {}), dispatchKey: `sync-attempt-${operation.id}-${number}`, sessionCreateKey: `sync-session-${operation.id}-${number}`, status: 'claimed', currentSession: null, dispatchPlans: [], composedInput: null, candidate: null, verification: null, checkpointRefs: [], failure: null, leaseToken: token, expiresAtMs }
      tx.exec('INSERT INTO sync_attempts(id,operation_id,number,generation,dispatch_key,session_create_key,status,expires_at_ms,record_json) VALUES(?,?,?,?,?,?,?,?,?)', id, operation.id, number, operation.generation, attempt.dispatchKey, attempt.sessionCreateKey, attempt.status, expiresAtMs, JSON.stringify(attempt))
      this.acquireResources(tx, operation, attempt, resources)
      if (!queued && input.expectedMessageId !== undefined) {
        if (input.expectedMessageId !== operation.dispatchMessageId) fail('SYNC_DISPATCH_MISMATCH', 'message does not belong to operation')
        const owned = tx.query('SELECT target_session_id,dequeued_at_ms FROM protocol_messages WHERE message_id=?', input.expectedMessageId)[0]
        if (!owned || (owned.target_session_id !== syncCoordinatorAddress(operation.input.source.repositoryId) && !(owned.dequeued_at_ms !== null && owned.target_session_id === 'spec-sync-coordinator'))) fail('SYNC_DISPATCH_BINDING', 'durable message is missing or belongs to another address')
        if (owned.dequeued_at_ms === null) {
          let head = this.dispatchHead(tx, operation.input.source.repositoryId)
          while (head && head.messageId !== input.expectedMessageId && dispatchStopped(head.operation)) {
            tx.dequeue(syncCoordinatorAddress(operation.input.source.repositoryId), head.messageId)
            head = this.dispatchHead(tx, operation.input.source.repositoryId)
          }
          tx.dequeue(syncCoordinatorAddress(operation.input.source.repositoryId), input.expectedMessageId)
        } else {
          let head = this.dispatchHead(tx, operation.input.source.repositoryId)
          while (head && dispatchStopped(head.operation)) {
            tx.dequeue(syncCoordinatorAddress(operation.input.source.repositoryId), head.messageId)
            head = this.dispatchHead(tx, operation.input.source.repositoryId)
          }
          if (head) fail('SYNC_DISPATCH_WAITING', 'valid pending FIFO dispatch must run before a dequeued operation resumes')
        }
      }
      operation.currentAttemptId = id; operation.phase = 'analyzing'; operation.readyScope = canonicalScope(input.scope); this.saveOperation(tx, operation)
      const fence: WriteFence = { operationId: operation.id, attemptId: id, generation: operation.generation, sourceFingerprint: operation.input.source.physicalFingerprint, leaseToken: token }
      const lease: ScopeLease = { token, operationId: operation.id, attemptId: id, repositoryId: operation.input.source.repositoryId, generation: operation.generation, scope: clone(input.scope), expiresAtMs }
      return { operation, attempt, fence, lease }
    })
  }
  bindDelivery(fence: WriteFence, delivery: WorktreeIdentity): SyncOperation {
    return this.write(tx => {
      const { operation } = this.checkFence(tx, fence)
      if (delivery.repositoryId !== operation.input.source.repositoryId || delivery.commonDir !== operation.input.source.commonDir || delivery.canonicalRoot !== operation.deliveryPlan.canonicalRoot || delivery.branch !== operation.deliveryPlan.branch) fail('SYNC_DELIVERY_BINDING', 'physical delivery differs from durable creation plan')
      if (operation.delivery && identityKey(operation.delivery) !== identityKey(delivery)) fail('SYNC_DELIVERY_BINDING', 'delivery identity cannot be replaced')
      operation.delivery = clone(delivery); this.saveOperation(tx, operation); return operation
    })
  }
  bindComposedInput(fence: WriteFence, composed: ComposedInputRef, bindings?: { readSetDigest: string }): SyncAttempt {
    this.blob(composed.manifestBlob)
    if (composed.requestBlob) this.blob(composed.requestBlob)
    if (composed.compositionEvidenceBlob) this.blob(composed.compositionEvidenceBlob)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (operation.baselineSelection && composed.baselineSelectionDigest !== operation.baselineSelection.digest) fail('SYNC_COMPOSITION_BINDING', 'composition baseline selection digest differs')
      if (composed.sourceInputId !== operation.input.id || composed.previousBaselinePairId !== (operation.previousBaselinePair?.id ?? null) || (composed.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null)) fail('SYNC_COMPOSITION_BINDING', 'composition must retain original source, baseline pair and controlled request')
      const expanded = operation.baselineSelection && attempt.composedInput?.baselineSelectionDigest !== operation.baselineSelection.digest && operation.contractScopeExpansions?.some(expansion => expansion.baselineSelectionDigest === operation.baselineSelection!.digest && expansion.previousBaselineSelectionDigest !== expansion.baselineSelectionDigest) && ['analyzing', 'elaborating', 'repairing'].includes(operation.phase) && !attempt.candidate && !attempt.verification
      if (bindings && bindings.readSetDigest !== operation.readSetDigest) {
        if (!expanded) fail('SYNC_READ_SET_FROZEN', 'read set can only rebind after reviewed scope expansion before generation')
        operation.readSetDigest = bindings.readSetDigest; this.saveOperation(tx, operation)
      }
      if (attempt.composedInput && digest(attempt.composedInput) !== digest(composed)) {
        if (!expanded) fail('SYNC_COMPOSITION_FROZEN', 'composed input cannot be replaced without reviewed pre-generation scope expansion')
      }
      attempt.composedInput = clone(composed); this.saveAttempt(tx, attempt); return attempt
    })
  }
  bindPublicationBase(fence: WriteFence, base: PublicationBase): SyncAttempt {
    const originalOperation = this.readOperation(fence.operationId), originalAttempt = this.readAttempt(fence.attemptId)
    const provenance = verifyPublicationBase(originalOperation, originalAttempt, base)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (operation.phase !== 'generating' || attempt.candidate || attempt.verification || !operation.baselineSelection || !attempt.composedInput || digest(attempt.composedInput) !== digest(originalAttempt.composedInput)) fail('SYNC_PUBLICATION_BASE_FROZEN', 'publication base only binds before candidate freeze')
      if (attempt.publicationBase) {
        if (digest(attempt.publicationBase) !== digest(base)) fail('SYNC_PUBLICATION_BASE_FROZEN', 'publication base cannot be replaced')
        this.assertPublicationCurrent(tx, operation, attempt, provenance.heads)
        return attempt
      }
      this.assertPublicationCurrent(tx, operation, attempt, provenance.heads)
      attempt.publicationBase = clone(base); this.saveAttempt(tx, attempt); return attempt
    })
  }
  reserveDispatch(fence: WriteFence, input: Pick<DispatchPlan, 'key' | 'purpose' | 'requestDigest'>): DispatchPlan {
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      const prior = attempt.dispatchPlans.find(plan => plan.key === input.key)
      if (prior) { if (prior.purpose !== input.purpose || prior.requestDigest !== input.requestDigest) fail('SYNC_DISPATCH_CONFLICT', input.key); return prior }
      if (this.family(tx, operation).calls >= operation.budget.maxCalls || this.now() >= operation.deadlineAtMs) fail('SYNC_BUDGET_EXHAUSTED', 'native call budget or deadline exhausted')
      const plan: DispatchPlan = { ...clone(input), sessionCreateKey: `sync-call-${digest({ attemptId: attempt.id, key: input.key })}`, session: null }
      attempt.dispatchPlans.push(plan); operation.callsUsed++; this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return plan
    })
  }
  bindSession(fence: WriteFence, dispatchKey: string, session: NativeSessionRef): SyncAttempt {
    return this.write(tx => {
      const { attempt } = this.checkFence(tx, fence)
      const plan = attempt.dispatchPlans.find(entry => entry.key === dispatchKey)
      if (!plan) fail('SYNC_DISPATCH_UNKNOWN', dispatchKey)
      if (plan.session && (plan.session.sessionId !== session.sessionId || (plan.session.threadId !== null && plan.session.threadId !== session.threadId) || (plan.session.turnId !== null && plan.session.turnId !== session.turnId))) fail('SYNC_SESSION_CONFLICT', 'native identities cannot be replaced')
      plan.session = clone(session); attempt.currentSession = clone(session); if (attempt.status === 'claimed') attempt.status = 'running'; this.saveAttempt(tx, attempt); return attempt
    })
  }
  /** 在创建原生资源前登记固定计划，仍必须持有当前业务fence。 */
  planResource(fence: WriteFence, plan: SyncResourcePlan): SyncResourceRecord {
    this.blob(plan.planBlob); this.blob(plan.checkpointRef)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (plan.inputId !== operation.input.id || plan.candidateDigest !== (attempt.candidate?.digest ?? null) || (plan.kind === 'verification' && !attempt.candidate)) fail('SYNC_RESOURCE_BINDING', 'resource plan does not bind current input and frozen candidate')
      const prior = parseRecord<SyncResourceRecord>(tx.query('SELECT record_json FROM sync_resources WHERE attempt_id=? AND resource_key=?', attempt.id, plan.key)[0])
      if (prior) { if (digest(prior.plan) !== digest(plan)) fail('SYNC_RESOURCE_PLAN_CONFLICT', plan.key); return prior }
      const resource: SyncResourceRecord = { id: randomUUID(), operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, plan: clone(plan), phase: 'planned', checkpointRef: clone(plan.checkpointRef), checkpoints: [{ phase: 'planned', checkpointRef: clone(plan.checkpointRef) }], createdAtMs: this.now(), updatedAtMs: this.now() }
      tx.exec('INSERT INTO sync_resources(id,operation_id,attempt_id,generation,resource_key,kind,input_id,candidate_digest,payload_digest,phase,checkpoint_sha,created_at_ms,updated_at_ms,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', resource.id, operation.id, attempt.id, attempt.generation, plan.key, plan.kind, plan.inputId, plan.candidateDigest, plan.payloadDigest, resource.phase, resource.checkpointRef.sha256, resource.createdAtMs, resource.updatedAtMs, JSON.stringify(resource))
      return resource
    })
  }
  /** 资源观测只核固定身份与CAS；取消、过期或历史attempt仍需登记真实清理。 */
  recordResourceCheckpoint(resourceId: string, checkpoint: SyncResourceCheckpoint): SyncResourceRecord {
    this.blob(checkpoint.checkpointRef)
    return this.write(tx => {
      const resource = this.resource(tx, resourceId)
      if (checkpoint.operationId !== resource.operationId || checkpoint.attemptId !== resource.attemptId || checkpoint.inputId !== resource.plan.inputId || checkpoint.candidateDigest !== resource.plan.candidateDigest) fail('SYNC_RESOURCE_BINDING', 'observation belongs to a different resource attempt or immutable input')
      if (resource.checkpoints.some(prior => prior.phase === checkpoint.phase && prior.checkpointRef.sha256 === checkpoint.checkpointRef.sha256)) return resource
      if (checkpoint.expectedCheckpointRef.sha256 !== resource.checkpointRef.sha256) fail('SYNC_RESOURCE_CHECKPOINT_CONFLICT', 'checkpoint changed after this observation was prepared')
      const phases = ['planned', 'created', 'terminal', 'removed'] as const
      const current = phases.indexOf(resource.phase), next = phases.indexOf(checkpoint.phase)
      const preCreateTermination = resource.phase === 'planned' && checkpoint.phase === 'terminal'
      if (next < current || next < 0 || (next > current + 1 && !preCreateTermination)) fail('SYNC_RESOURCE_PHASE_INVALID', `${resource.phase} cannot advance to ${checkpoint.phase}`)
      resource.phase = checkpoint.phase; resource.checkpointRef = clone(checkpoint.checkpointRef); resource.checkpoints.push({ phase: checkpoint.phase, checkpointRef: clone(checkpoint.checkpointRef) }); resource.updatedAtMs = this.now()
      tx.exec('UPDATE sync_resources SET phase=?,checkpoint_sha=?,updated_at_ms=?,record_json=? WHERE id=? AND checkpoint_sha=?', resource.phase, resource.checkpointRef.sha256, resource.updatedAtMs, JSON.stringify(resource), resource.id, checkpoint.expectedCheckpointRef.sha256)
      if (resource.phase === 'removed') {
        const attempt = this.attempt(tx, resource.attemptId)
        if (['superseded', 'failed', 'settled'].includes(attempt.status)) this.release(tx, attempt.leaseToken)
      }
      return resource
    })
  }
  findResource(attemptId: string, key: string): SyncResourceRecord | null { return this.write(tx => parseRecord<SyncResourceRecord>(tx.query('SELECT record_json FROM sync_resources WHERE attempt_id=? AND resource_key=?', attemptId, key)[0])) }
  readResource(id: string): SyncResourceRecord { return this.write(tx => this.resource(tx, id)) }
  listRecoverableResources(): RecoverableSyncResource[] {
    return this.write(tx => tx.query("SELECT r.record_json AS resource_json,o.record_json AS operation_json,a.record_json AS attempt_json FROM sync_resources r JOIN sync_operations o ON o.id=r.operation_id JOIN sync_attempts a ON a.id=r.attempt_id WHERE r.phase!='removed' ORDER BY r.rowid").map(row => ({ operation: JSON.parse(String(row.operation_json)) as SyncOperation, attempt: JSON.parse(String(row.attempt_json)) as SyncAttempt, resource: JSON.parse(String(row.resource_json)) as SyncResourceRecord })))
  }
  checkpoint(fence: WriteFence, ref: BlobRef): SyncAttempt {
    this.blob(ref)
    return this.write(tx => { const { attempt } = this.checkFence(tx, fence, true); if (!attempt.checkpointRefs.some(prior => prior.sha256 === ref.sha256)) attempt.checkpointRefs.push(clone(ref)); this.saveAttempt(tx, attempt); return attempt })
  }
  renewLease(fence: WriteFence, leaseMs: number): SyncAttempt {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) fail('SYNC_LEASE_INVALID', 'leaseMs must be positive')
    return this.write(tx => { const { attempt } = this.checkFence(tx, fence); attempt.expiresAtMs = this.now() + leaseMs; tx.exec('UPDATE sync_leases SET expires_at_ms=? WHERE token=?', attempt.expiresAtMs, attempt.leaseToken); this.saveAttempt(tx, attempt); return attempt })
  }
  /** 协调器核对并持久保存当前独审分析后，记录其业务冲突而不改变执行结论。 */
  recordReviewedConflict(fence: WriteFence): SyncOperation {
    return this.write(tx => {
      const { operation } = this.checkFence(tx, fence)
      if (operation.phase !== 'analyzing') fail('SYNC_PHASE_INVALID', operation.phase)
      if (operation.blockedReason !== 'conflicted') { operation.blockedReason = 'conflicted'; this.saveOperation(tx, operation) }
      return operation
    })
  }
  startElaboration(fence: WriteFence): SyncOperation {
    return this.write(tx => { const { operation } = this.checkFence(tx, fence); if (operation.phase !== 'analyzing') fail('SYNC_PHASE_INVALID', operation.phase); operation.phase = 'elaborating'; this.saveOperation(tx, operation); return operation })
  }
  /** 可信细化只扩展业务 ID；路径授权和接入身份保持冻结，新增租约同事务取得。 */
  expandContractScope(fence: WriteFence, ids: Pick<SyncScope, 'contractIds' | 'flowIds'> & { paths?: string[] }, evidenceRef: BlobRef): SyncOperation {
    this.blob(evidenceRef)
    if (Object.keys(ids).some(key => !['contractIds', 'flowIds', 'paths'].includes(key)) || !(['contractIds', 'flowIds'] as const).every(key => Array.isArray(ids[key]) && ids[key].every(id => typeof id === 'string' && id.length > 0 && id === id.trim() && !id.includes('\0')))) fail('SYNC_SCOPE_INVALID', 'scope expansion accepts only complete contractIds/flowIds')
    if (ids.paths) validateScope({ paths: ids.paths, contractIds: [], flowIds: [] })
    const requested = canonicalScope({ paths: ids.paths ?? [], contractIds: ids.contractIds, flowIds: ids.flowIds })
    const expansion = { contractIds: requested.contractIds, flowIds: requested.flowIds, ...(ids.paths ? { paths: requested.paths } : {}), evidenceRef: clone(evidenceRef) }
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (ids.paths && !operation.baselineSelection) fail('SYNC_SCOPE_INVALID', 'legacy frozen operation cannot expand path authority')
      const prior = operation.contractScopeExpansions?.find(record => record.evidenceRef.sha256 === evidenceRef.sha256)
      if (prior && digest({ contractIds: prior.contractIds, flowIds: prior.flowIds, ...(prior.paths ? { paths: prior.paths } : {}), evidenceRef: prior.evidenceRef }) !== digest(expansion)) fail('SYNC_SCOPE_EVIDENCE_CONFLICT', 'the same elaboration evidence cannot claim different ID sets')
      const keys = scopeKeys(requested), owned = tx.query('SELECT resource_key FROM sync_leases WHERE repository_id=? AND token=? AND attempt_id=?', operation.input.source.repositoryId, attempt.leaseToken, attempt.id)
      if (prior && this.leaseKeys(operation, keys).every(key => owned.some(row => row.resource_key === key))) return operation
      if (!['analyzing', 'elaborating', 'repairing', 'needs_input', 'conflicted'].includes(operation.phase)) fail('SYNC_PHASE_INVALID', operation.phase)
      if (!contains(requested, { paths: [], contractIds: operation.scope.contractIds, flowIds: operation.scope.flowIds })) fail('SYNC_SCOPE_INVALID', 'expanded ID sets cannot delete existing business authority')
      this.acquireResources(tx, operation, attempt, keys)
      const added: SyncScope = { paths: requested.paths.filter(path => !operation.scope.paths.includes(path)), contractIds: requested.contractIds.filter(id => !operation.scope.contractIds.includes(id)), flowIds: requested.flowIds.filter(id => !operation.scope.flowIds.includes(id)) }
      const previousBaselineSelectionDigest = operation.baselineSelection?.digest
      if (operation.baselineSelection) {
        this.assertSelection(tx, operation.input.source, operation.baselineSelection, scopeResources(operation.scope))
        const expanded = this.baselineSelection(tx, operation.input.source, [...operation.baselineSelection.bindings.map(binding => binding.resource), ...scopeResources(requested)])
        if ('failure' in expanded) fail(expanded.failure.code, expanded.failure.message)
        operation.baselineSelection = expanded.selection
        attempt.baselineSelectionDigest = expanded.selection.digest
        this.saveAttempt(tx, attempt)
      }
      operation.scope = union(operation.scope, requested)
      operation.readyScope = union(operation.readyScope, added)
      if (!prior) operation.contractScopeExpansions = [...(operation.contractScopeExpansions ?? []), { ...expansion, ...(previousBaselineSelectionDigest ? { previousBaselineSelectionDigest, baselineSelectionDigest: operation.baselineSelection!.digest } : {}) }]
      this.saveOperation(tx, operation); return operation
    })
  }
  startGeneration(fence: WriteFence, scopes?: { readyScope: SyncScope; blockedScope: SyncScope; blockedReason: 'needs_input' | 'conflicted' | null }): SyncOperation {
    if (scopes) { validateScope(scopes.readyScope); validateScope(scopes.blockedScope) }
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (!['analyzing', 'elaborating', 'repairing', 'needs_input', 'conflicted'].includes(operation.phase)) fail('SYNC_PHASE_INVALID', operation.phase)
      if (scopes) {
        if (!contains(operation.readyScope, scopes.readyScope) || !contains(operation.scope, scopes.blockedScope) || overlaps(scopes.readyScope, scopes.blockedScope)) fail('SYNC_SCOPE_INVALID', 'ready/blocked scopes must be disjoint operation subsets')
        operation.readyScope = clone(scopes.readyScope); operation.blockedScope = clone(scopes.blockedScope); operation.blockedReason = scopes.blockedReason
      }
      if (operation.baselineSelection && attempt.composedInput && attempt.composedInput.baselineSelectionDigest !== operation.baselineSelection.digest) fail('SYNC_COMPOSITION_BINDING', 'scope expansion requires a composition bound to the expanded selection')
      operation.phase = 'generating'; attempt.status = 'running'; this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return operation
    })
  }
  freezeCandidate(fence: WriteFence, candidate: CandidateRef): SyncAttempt {
    validateScope(candidate.coveredScope)
    this.blob(candidate.manifestBlob)
    const priorAttempt = this.readAttempt(fence.attemptId)
    if (!priorAttempt.composedInput) fail('SYNC_COMPOSITION_MISSING', fence.attemptId)
    const files = this.diff(candidate)
    const composed = priorAttempt.publicationBase?.composed ?? priorAttempt.composedInput
    if (digest(files) !== digest(this.manifestDiff(composed.manifestBlob, candidate.manifestBlob))) fail('SYNC_DIFF_BINDING', 'model diff differs from composed input to candidate manifest')
    if (!contains(candidate.coveredScope, { paths: files.map(file => file.path), contractIds: [], flowIds: [] })) fail('SYNC_CANDIDATE_SCOPE', 'actual changed files escape claimed candidate scope')
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (operation.phase !== 'generating' || !attempt.composedInput || candidate.baseTree !== (attempt.publicationBase?.composed ?? attempt.composedInput).tree || candidate.sourceInputId !== operation.input.id) fail('SYNC_PHASE_INVALID', operation.phase)
      if (!contains(operation.readyScope, candidate.coveredScope)) fail('SYNC_CANDIDATE_SCOPE', 'candidate escapes acquired ready scope')
      if (attempt.candidate && digest(attempt.candidate) !== digest(candidate)) fail('SYNC_CANDIDATE_FROZEN', 'frozen candidate cannot be replaced')
      attempt.candidate = clone(candidate); attempt.status = 'frozen'; operation.phase = 'verifying'; this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return attempt
    })
  }
  recordVerification(fence: WriteFence, verification: VerificationRef): SyncAttempt {
    const result = JSON.parse(this.blob(verification.resultBlob).toString('utf8')) as VerificationResultBlob
    const bindings = ['inputId', 'candidateDigest', 'policyDigest', 'readSetDigest', 'environmentDigest', 'contextDigest'] as const
    if (result.schemaVersion !== 1 || !result.coveredScope || digest(result.coveredScope) !== digest(verification.coveredScope) || bindings.some(key => result[key] !== verification[key]) || !Array.isArray(result.layers) || result.layers.length !== 4 || !['V1', 'V2', 'V3', 'V4'].every(layer => result.layers.filter(entry => entry.layer === layer).length === 1) || result.layers.some(layer => !['pass', 'fail', 'unsupported'].includes(layer.verdict) || !Array.isArray(layer.evidenceRefs) || !layer.evidenceRefs.length) || verification.passed !== result.layers.every(layer => layer.verdict === 'pass')) fail('SYNC_VERIFICATION_INVALID', 'four unique independently evidenced layers and exact bindings required')
    for (const ref of verification.evidenceRefs) this.blob(ref)
    for (const layer of result.layers) for (const ref of layer.evidenceRefs) this.blob(ref)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (operation.baselineSelection && (verification.baselineSelectionDigest !== operation.baselineSelection.digest || result.baselineSelectionDigest !== operation.baselineSelection.digest)) fail('SYNC_VERIFICATION_BINDING', 'verification selection differs from current frozen attempt')
      if (operation.phase !== 'verifying' || !attempt.candidate || verification.inputId !== operation.input.id || verification.policyDigest !== operation.policyDigest || verification.readSetDigest !== operation.readSetDigest || verification.candidateDigest !== attempt.candidate.digest || !contains(attempt.candidate.coveredScope, verification.coveredScope)) fail('SYNC_VERIFICATION_BINDING', 'verification does not bind current frozen input and candidate')
      attempt.verification = clone({ ...verification, evidenceRefs: [...new Map([...verification.evidenceRefs, ...result.layers.flatMap(layer => layer.evidenceRefs)].map(ref => [ref.sha256, ref])).values()] }); attempt.status = verification.passed ? 'verified' : 'failed'; operation.phase = verification.passed ? 'ready_to_apply' : 'failed'
      if (!verification.passed) this.release(tx, attempt.leaseToken)
      this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return attempt
    })
  }
  beginApply(fence: WriteFence, plan: ApplyPlan, currentTarget: InputSnapshot): ApplyJournal {
    this.blob(plan.planBlob); this.blob(plan.verificationBlob)
    validateScope(plan.coveredScope)
    const before = this.readAttempt(fence.attemptId)
    if (!before?.candidate) fail('SYNC_CANDIDATE_MISSING', fence.attemptId)
    const files = this.manifestDiff(currentTarget.manifestBlob, before.candidate.manifestBlob)
    const publication = before.publicationBase ? JSON.parse(this.blob(before.publicationBase.provenanceBlob).toString()) as { heads: PublicationHeads } : null
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      const prior = parseRecord<ApplyJournal>(tx.query('SELECT record_json FROM sync_apply_journals WHERE effect_key=?', plan.effectKey)[0])
      if (prior) { if (prior.plan.payloadDigest !== plan.payloadDigest || digest(prior.plan) !== digest(plan) || prior.attemptId !== attempt.id) fail('SYNC_EFFECT_CONFLICT', plan.effectKey); return prior }
      if (publication) this.assertPublicationCurrent(tx, operation, attempt, publication.heads)
      if (operation.phase !== 'ready_to_apply' || !attempt.candidate || !attempt.verification?.passed) fail('SYNC_APPLY_NOT_VERIFIED', operation.phase)
      if (plan.candidateDigest !== attempt.candidate.digest || plan.verificationBlob.sha256 !== attempt.verification.resultBlob.sha256 || digest(plan.files) !== digest(files) || !contains(attempt.verification.coveredScope, plan.coveredScope) || !contains(plan.coveredScope, { paths: files.map(file => file.path), contractIds: [], flowIds: [] })) fail('SYNC_APPLY_BINDING', 'plan differs from frozen candidate or verified scope')
      if (!operation.delivery || identityKey(plan.target) !== identityKey(operation.delivery) || identityKey(currentTarget.source) !== identityKey(plan.target) || currentTarget.id !== plan.expectedTargetSnapshotId) fail('SYNC_TARGET_STALE', 'physical target or current snapshot changed')
      if (plan.expectedBaselinePairId !== (operation.previousBaselinePair?.id ?? null)) fail('SYNC_BASELINE_STALE', 'plan baseline differs from frozen operation')
      if ((plan.publicationBaseRef?.sha256 ?? null) !== (attempt.publicationBase?.provenanceBlob.sha256 ?? null)) fail('SYNC_PUBLICATION_BASE_BINDING', 'apply publication base differs from frozen attempt')
      if (attempt.publicationBase && (currentTarget.headCommit !== attempt.publicationBase.parentCommit || currentTarget.immutableTree !== attempt.publicationBase.parentTree || currentTarget.manifestBlob.sha256 !== attempt.publicationBase.parentManifestBlob.sha256 || currentTarget.indexTree !== attempt.publicationBase.parentTree)) fail('SYNC_PUBLICATION_BASE_BINDING', 'actual target differs from frozen publication parent')
      if (operation.baselineSelection) {
        if (plan.expectedBaselineSelectionDigest !== operation.baselineSelection.digest) fail('SYNC_BASELINE_STALE', 'apply selection differs from frozen operation')
        this.assertSelection(tx, operation.input.source, operation.baselineSelection, scopeResources(operation.scope))
      } else {
        const latest = this.baseline(tx, operation.input.source)
        if (operation.previousBaselinePair && latest?.id !== operation.previousBaselinePair.id) fail('SYNC_BASELINE_STALE', 'legacy source baseline advanced')
      }
      const journal: ApplyJournal = { id: randomUUID(), operationId: operation.id, attemptId: attempt.id, generation: operation.generation, plan: clone(plan), status: 'prepared', steps: plan.files.map(file => ({ key: file.path, status: 'planned', evidenceRef: null })), receipt: null, createdAtMs: this.now() }
      tx.exec('INSERT INTO sync_apply_journals(id,operation_id,attempt_id,effect_key,payload_digest,status,receipt_id,record_json) VALUES(?,?,?,?,?,?,NULL,?)', journal.id, operation.id, attempt.id, plan.effectKey, plan.payloadDigest, journal.status, JSON.stringify(journal))
      operation.phase = 'applying'; attempt.status = 'applying'; this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return journal
    })
  }
  recordApplyStep(fence: WriteFence, journalId: string, step: ApplyStep): ApplyJournal {
    if (step.evidenceRef) this.blob(step.evidenceRef)
    return this.write(tx => {
      const { attempt } = this.checkFence(tx, fence, true), journal = this.journal(tx, journalId)
      if (journal.attemptId !== attempt.id || journal.status === 'settled') fail('SYNC_JOURNAL_BINDING', journalId)
      const index = journal.steps.findIndex(prior => prior.key === step.key)
      if (index < 0 || (journal.steps[index].status === 'completed' && digest(journal.steps[index]) !== digest(step))) fail('SYNC_STEP_CONFLICT', step.key)
      journal.steps[index] = clone(step); journal.status = 'applying'; this.saveJournal(tx, journal); return journal
    })
  }
  /** 已实际发生的副作用即使 fence 失效也必须保存，不能假装取消撤销了写入。 */
  recordReceipt(journalId: string, receipt: ApplyReceipt): ApplyJournal {
    this.blob(receipt.deliverySnapshot.manifestBlob); for (const ref of receipt.evidenceRefs) this.blob(ref)
    return this.write(tx => {
      const journal = this.journal(tx, journalId)
      const attempt = this.attempt(tx, journal.attemptId)
      if (receipt.actualTree !== attempt.candidate?.tree || receipt.deliverySnapshot.manifestBlob.sha256 !== attempt.candidate.manifestBlob.sha256 || receipt.journalId !== journal.id || receipt.effectKey !== journal.plan.effectKey || identityKey(receipt.deliverySnapshot.source) !== identityKey(journal.plan.target) || receipt.actualTree !== receipt.deliverySnapshot.immutableTree) fail('SYNC_RECEIPT_BINDING', journalId)
      if (journal.receipt) { if (digest(journal.receipt) !== digest(receipt)) fail('SYNC_RECEIPT_CONFLICT', receipt.id); return journal }
      if (journal.steps.some(step => step.status !== 'completed')) fail('SYNC_STEPS_INCOMPLETE', journalId)
      journal.receipt = clone(receipt); journal.status = 'completed'; this.saveJournal(tx, journal); return journal
    })
  }
  settleApply(journalId: string, receiptId: string): SyncOperation {
    const verificationRef = this.write(tx => { const journal = this.journal(tx, journalId); return this.attempt(tx, journal.attemptId).verification!.resultBlob })
    const verification = JSON.parse(this.blob(verificationRef).toString('utf8')) as VerificationResultBlob
    return this.write(tx => {
      const journal = this.journal(tx, journalId), operation = this.operation(tx, journal.operationId), attempt = this.attempt(tx, journal.attemptId)
      if (!journal.receipt || journal.receipt.id !== receiptId) fail('SYNC_RECEIPT_MISSING', receiptId)
      if (journal.status === 'settled') return operation
      if (attempt.verification?.resultBlob.sha256 !== verificationRef.sha256) fail('SYNC_VERIFICATION_INVALID', 'settlement verification changed')
      const historicalPairs = [...(operation.previousBaselinePair ? [operation.previousBaselinePair] : []), ...(operation.baselineSelection?.bindings.flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [pair] : [] }) ?? [])]
      const retiredIds = [...new Set([...historicalPairs.flatMap(pair => pair.retiredIds ?? []), ...(verification.retiredIds ?? [])])].sort()
      const decisionRefs = [...new Map([...historicalPairs.flatMap(pair => pair.decisionRefs ?? []), ...(verification.decisionRefs ?? [])].map(ref => [ref.sha256, ref])).values()]
      const pair: BaselinePair = { id: `baseline-${journal.id}`, repositoryId: operation.input.source.repositoryId, source: clone(operation.input.source), sourceInput: clone(operation.input), verifiedDelivery: clone(journal.receipt.deliverySnapshot), coveredScope: clone(journal.plan.coveredScope), retiredIds, decisionRefs, receiptId, settledAtMs: this.now() }
      tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', pair.id, pair.repositoryId, identityKey(pair.source), pair.receiptId, pair.settledAtMs, JSON.stringify(pair))
      const advance = (published: BaselinePair): void => {
        const retiredKeys = (verification.retiredIds ?? []).flatMap(id => {
          const keys = [...(operation.scope.flowIds.includes(id) ? [`flow:${id}`] : []), ...(operation.scope.contractIds.includes(id) ? [`contract:${id}`] : [])]
          if (keys.length) return keys
          if (operation.baselineSelection) fail('SYNC_RETIRE_SCOPE', 'retired ID is not in the reviewed frozen resource scope')
          for (const resourceKey of [`flow:${id}`, `contract:${id}`]) tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,NULL,?) ON CONFLICT(source_key,resource_key) DO UPDATE SET legacy_reason=excluded.legacy_reason', identityKey(published.source), resourceKey, 'legacy retirement kind has no reviewed scope proof')
          return []
        })
        const resources = [...journal.plan.files.map(file => `path:${file.path}`), ...journal.plan.coveredScope.contractIds.map(id => `contract:${id}`), ...journal.plan.coveredScope.flowIds.map(id => `flow:${id}`), ...retiredKeys]
        for (const key of new Set(resources)) tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,?,NULL) ON CONFLICT(source_key,resource_key) DO UPDATE SET pair_id=excluded.pair_id,legacy_reason=NULL', identityKey(published.source), key, published.id)
      }
      advance(pair)
      if (identityKey(pair.source) !== identityKey(pair.verifiedDelivery.source) || pair.sourceInput.id !== pair.verifiedDelivery.id) {
        const published: BaselinePair = { ...pair, id: `${pair.id}-delivery`, source: clone(pair.verifiedDelivery.source), sourceInput: clone(pair.verifiedDelivery) }
        tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', published.id, published.repositoryId, identityKey(published.source), receiptId, published.settledAtMs, JSON.stringify(published))
        advance(published)
      }
      operation.deliveredScope = union(operation.deliveredScope, journal.plan.coveredScope)
      if (operation.control === 'cancel') operation.phase = 'cancelled'
      else if (operation.control === 'pause' || this.physicalControl(tx, physicalScope(operation.input.source)).control === 'pause') operation.phase = 'paused'
      else if (operation.blockedReason) operation.phase = operation.blockedReason
      else operation.phase = contains(operation.deliveredScope, operation.scope) ? 'workspace_synced' : 'needs_input'
      attempt.status = 'settled'; journal.status = 'settled'; this.saveJournal(tx, journal); this.saveAttempt(tx, attempt); this.release(tx, attempt.leaseToken); this.saveOperation(tx, operation); return operation
    })
  }
  requestControl(operationId: string, control: SyncControl): SyncOperation {
    return this.write(tx => {
      const operation = this.operation(tx, operationId)
      if (TERMINAL.has(operation.phase)) return operation
      const previousControl = operation.control
      operation.control = control
      if (['applying', 'pausing', 'cancelling', 'recovery_required'].includes(operation.phase)) operation.phase = control === 'cancel' ? 'cancelling' : control === 'pause' ? 'pausing' : 'applying'
      else if (control === 'run' && previousControl !== 'run') {
        const settled = operation.currentAttemptId && this.attempt(tx, operation.currentAttemptId).status === 'settled' && tx.query("SELECT id FROM sync_apply_journals WHERE operation_id=? AND attempt_id=? AND status='settled' AND receipt_id IS NOT NULL LIMIT 1", operation.id, operation.currentAttemptId).length > 0
        operation.phase = settled ? operation.blockedReason ?? (contains(operation.deliveredScope, operation.scope) ? 'workspace_synced' : 'needs_input') : 'queued'
      }
      else if (control !== 'run') {
        operation.phase = control === 'cancel' ? 'cancelled' : 'paused'
        if (operation.currentAttemptId) { const attempt = this.attempt(tx, operation.currentAttemptId); attempt.status = 'superseded'; this.saveAttempt(tx, attempt); this.release(tx, attempt.leaseToken) }
      }
      this.saveOperation(tx, operation); return operation
    })
  }
  recordBudgetExhaustion(operationId: string): SyncOperation {
    return this.write(tx => {
      const operation = this.operation(tx, operationId)
      const family = this.family(tx, operation), attempts = family.attempts
      const repairs = attempts.filter(attempt => attempt.verification?.passed === false || attempt.failure?.kind === 'repairable').length
      if (this.now() < operation.deadlineAtMs && family.calls < operation.budget.maxCalls && attempts.length < operation.budget.maxAttempts && repairs <= operation.budget.maxRepairs) fail('SYNC_BUDGET_NOT_EXHAUSTED', 'budget remains available')
      if (TERMINAL.has(operation.phase)) return operation
      const attempt = operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
      if (attempt) {
        attempt.failure ??= { code: 'SYNC_BUDGET_EXHAUSTED', message: '执行预算或截止时间已耗尽', kind: 'budget', evidenceRefs: [] }
        if (attempt.status === 'applying') operation.phase = 'recovery_required'
        else { attempt.status = 'failed'; operation.phase = 'budget_exhausted'; this.release(tx, attempt.leaseToken) }
        this.saveAttempt(tx, attempt)
      } else operation.phase = 'budget_exhausted'
      this.saveOperation(tx, operation); return operation
    })
  }
  recordFailure(fence: WriteFence, failure: SyncFailure): SyncOperation {
    for (const ref of failure.evidenceRefs) this.blob(ref)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence, true)
      if (attempt.status === 'applying') { operation.phase = 'recovery_required'; attempt.failure = clone(failure) }
      else { attempt.failure = clone(failure); attempt.status = 'failed'; operation.phase = failure.kind === 'missing_input' ? 'needs_input' : failure.kind === 'conflict' ? 'conflicted' : failure.kind === 'budget' ? 'budget_exhausted' : 'failed'; this.release(tx, attempt.leaseToken) }
      this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return operation
    })
  }
  private decisionEligibility(tx: ProtocolTransaction, operation: SyncOperation): SyncDecisionEligibility {
    if (!['conflicted', 'needs_input', 'superseded'].includes(operation.phase) && !(['failed', 'budget_exhausted'].includes(operation.phase) && operation.blockedReason !== null)) return { eligible: false, reason: { code: 'SYNC_DECISION_BINDING', message: '此操作没有待裁决的已结算具体业务分歧' } }
    if (operation.currentAttemptId && !['failed', 'superseded', 'settled'].includes(this.attempt(tx, operation.currentAttemptId).status)) return { eligible: false, reason: { code: 'SYNC_DECISION_BINDING', message: '当前执行尝试尚未结算，不能裁决在途业务阶段' } }
    if (tx.query("SELECT id FROM sync_resources WHERE operation_id=? AND phase!='removed' LIMIT 1", operation.id).length || tx.query("SELECT id FROM sync_apply_journals WHERE operation_id=? AND status!='settled' LIMIT 1", operation.id).length) return { eligible: false, reason: { code: 'SYNC_DECISION_RESOURCE_PENDING', message: '请先恢复原操作的未结算资源或写入日志' } }
    return { eligible: true }
  }
  readDecisionEligibility(operationId: string): SyncDecisionEligibility { return this.write(tx => this.decisionEligibility(tx, this.operation(tx, operationId))) }
  private retryEligibility(tx: ProtocolTransaction, operation: SyncOperation): SyncRetryEligibility {
    const refused = (code: string, message: string): SyncRetryEligibility => ({ eligible: false, reason: { code, message } })
    if (!['failed', 'budget_exhausted', 'cancelled'].includes(operation.phase)) return refused('SYNC_RETRY_PHASE', '当前操作未以失败、预算耗尽或取消结束')
    if (operation.phase === 'cancelled' && tx.query('SELECT id FROM sync_apply_journals WHERE operation_id=? AND receipt_id IS NOT NULL LIMIT 1', operation.id).length) return refused('SYNC_RETRY_DELIVERED', '取消操作已有真实交付结果，不能重复交付')
    if (tx.query("SELECT id FROM sync_resources WHERE operation_id=? AND phase!='removed' LIMIT 1", operation.id).length) return refused('SYNC_RETRY_RESOURCE_PENDING', '旧操作仍有未确认结算的原生资源')
    if (tx.query("SELECT id FROM sync_apply_journals WHERE operation_id=? AND status!='settled' LIMIT 1", operation.id).length) return refused('SYNC_RETRY_JOURNAL_PENDING', '旧操作仍有未结算的文件或Git副作用')
    if (operation.currentAttemptId && !['failed', 'superseded', 'settled'].includes(this.attempt(tx, operation.currentAttemptId).status) || tx.query('SELECT resource_key FROM sync_leases WHERE operation_id=? AND token IS NOT NULL AND expires_at_ms>? LIMIT 1', operation.id, this.now()).length) return refused('SYNC_RETRY_ATTEMPT_ACTIVE', '旧操作仍有有效执行或租约写权')
    return { eligible: true }
  }
  readRetryEligibility(operationId: string): SyncRetryEligibility { return this.write(tx => this.retryEligibility(tx, this.operation(tx, operationId))) }
  readBudgetUsage(operationId: string): { budgetRootOperationId: string; callsUsed: number; attemptsUsed: number; repairFailures: number } {
    return this.write(tx => {
      const operation = this.operation(tx, operationId), family = this.family(tx, operation)
      return { budgetRootOperationId: operation.dispatchAnchor?.budgetRootOperationId ?? operation.id, callsUsed: family.calls, attemptsUsed: family.attempts.length, repairFailures: family.attempts.filter(attempt => attempt.verification?.passed === false || attempt.failure?.kind === 'repairable').length }
    })
  }
  readOperation(id: string): SyncOperation { return this.write(tx => this.operation(tx, id)) }
  findOperationByIngressKey(ingressKey: string): SyncOperation | null {
    return this.write(tx => parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE ingress_key=? OR EXISTS (SELECT 1 FROM json_each(sync_operations.ingress_aliases_json) WHERE value=?)', ingressKey, ingressKey)[0]))
  }
  findIngressReceipt(ingressKey: string): SyncIngressReceipt | null { return this.write(tx => parseRecord<SyncIngressReceipt>(tx.query('SELECT record_json FROM sync_ingress_receipts WHERE ingress_key=?', ingressKey)[0])) }
  listOperations(repositoryId: string, options: { limit?: number; sourceRoot?: string } = {}): SyncOperation[] {
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('SYNC_LIST_LIMIT', 'limit must be an integer between 1 and 500')
    return this.write(tx => tx.query(`SELECT record_json FROM sync_operations WHERE repository_id=?${options.sourceRoot === undefined ? '' : ' AND source_root=?'} ORDER BY rowid DESC LIMIT ?`, ...[repositoryId, ...(options.sourceRoot === undefined ? [] : [options.sourceRoot]), limit]).map(row => parseRecord<SyncOperation>(row)!))
  }
  readAttempt(id: string): SyncAttempt { return this.write(tx => this.attempt(tx, id)) }
  listAttempts(operationId: string): SyncAttempt[] {
    return this.write(tx => { this.operation(tx, operationId); return tx.query('SELECT record_json FROM sync_attempts WHERE operation_id=? ORDER BY rowid', operationId).map(row => parseRecord<SyncAttempt>(row)!) })
  }
  readJournal(id: string): ApplyJournal { return this.write(tx => this.journal(tx, id)) }
  listJournals(operationId: string): ApplyJournal[] {
    return this.write(tx => { this.operation(tx, operationId); return tx.query('SELECT record_json FROM sync_apply_journals WHERE operation_id=? ORDER BY rowid', operationId).map(row => parseRecord<ApplyJournal>(row)!) })
  }
  private baseline(tx: ProtocolTransaction, source: WorktreeIdentity): BaselinePair | null { return parseRecord<BaselinePair>(tx.query('SELECT record_json FROM sync_baseline_pairs WHERE repository_id=? AND source_key=? ORDER BY rowid DESC LIMIT 1', source.repositoryId, identityKey(source))[0]) }
  readBaseline(source: WorktreeIdentity): BaselinePair | null { return this.write(tx => this.baseline(tx, source)) }
  listRecoverable(): RecoverableSync[] {
    return this.write(tx => tx.query('SELECT record_json FROM sync_operations ORDER BY updated_at_ms,id').map(row => parseRecord<SyncOperation>(row)!).flatMap(operation => {
      const attempt = operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
      const journals = tx.query("SELECT record_json FROM sync_apply_journals WHERE operation_id=? AND status!='settled'", operation.id).map(row => parseRecord<ApplyJournal>(row)!)
      return (!TERMINAL.has(operation.phase) && operation.phase !== 'paused') || journals.length ? [{ operation, attempt, journals }] : []
    }))
  }
  pinnedBlobRefs(): BlobRef[] {
    return this.write(tx => {
      const refs = new Set<string>()
      const visit = (value: unknown): void => { if (!value || typeof value !== 'object') return; if ('sha256' in value && typeof value.sha256 === 'string') refs.add(value.sha256); for (const entry of Object.values(value)) visit(entry) }
      for (const table of ['sync_operations', 'sync_attempts', 'sync_apply_journals', 'sync_baseline_pairs', 'sync_resources', 'sync_ingress_receipts', 'sync_observations', 'sync_observer_health']) for (const row of tx.query(`SELECT record_json FROM ${table}`)) visit(JSON.parse(String(row.record_json)))
      return [...refs].sort().map(sha256 => ({ sha256 }))
    })
  }
}
