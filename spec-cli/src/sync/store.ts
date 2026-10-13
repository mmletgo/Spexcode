import { createHash, randomUUID } from 'node:crypto'
import { getBlob } from '@spexcode/spec-core'
import { applyComponentMigrations, type ProtocolTransaction, type SessionProtocol } from '@spexcode/session-protocol'
import { SYNC_COMPONENT, SYNC_MIGRATIONS } from './migrations.js'
import type { AdmitSyncInput, ApplyFilePlan, ApplyJournal, ApplyPlan, ApplyReceipt, ApplyStep, BaselinePair, BlobRef, CandidateRef, ClaimedAttempt, ClaimAttemptInput, ComposedInputRef, RecoverableSyncResource, SyncResourceCheckpoint, SyncResourcePlan, SyncResourceRecord, DispatchPlan, InputSnapshot, NativeSessionRef, RecoverableSync, ScopeLease, SyncAttempt, SyncControl, SyncDispatchEnvelope, SyncFailure, SyncOperation, SyncScope, VerificationRef, VerificationResultBlob, WorktreeIdentity, WriteFence } from './operation-types.js'

export const SYNC_COORDINATOR_ADDRESS = 'spec-sync-coordinator'
export const SYNC_DISPATCH_KIND = 'sync.dispatch.v1'
export class SyncStoreError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'SyncStoreError' }
}
function fail(code: string, message: string): never { throw new SyncStoreError(code, message) }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
const identityKey = (identity: WorktreeIdentity): string => digest(identity)
const scopeKeys = (scope: SyncScope): string[] => [...new Set([...scope.paths.map(path => `path:${path}`), ...scope.contractIds.map(id => `contract:${id}`), ...scope.flowIds.map(id => `flow:${id}`)])].sort()
const pathOverlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
const resourceOverlap = (a: string, b: string): boolean => a.startsWith('path:') && b.startsWith('path:') ? pathOverlap(a, b) : a === b
const overlaps = (a: SyncScope, b: SyncScope): boolean => scopeKeys(a).some(left => scopeKeys(b).some(right => resourceOverlap(left, right)))
const canonicalScope = (scope: SyncScope): SyncScope => ({ paths: [...new Set(scope.paths)].sort(), contractIds: [...new Set(scope.contractIds)].sort(), flowIds: [...new Set(scope.flowIds)].sort() })
const emptyScope = (): SyncScope => ({ paths: [], contractIds: [], flowIds: [] })
const contains = (scope: SyncScope, part: SyncScope): boolean => part.paths.every(path => scope.paths.some(parent => path === parent || path.startsWith(`${parent}/`))) && part.contractIds.every(id => scope.contractIds.includes(id)) && part.flowIds.every(id => scope.flowIds.includes(id))
const union = (a: SyncScope, b: SyncScope): SyncScope => ({ paths: [...new Set([...a.paths, ...b.paths])].sort(), contractIds: [...new Set([...a.contractIds, ...b.contractIds])].sort(), flowIds: [...new Set([...a.flowIds, ...b.flowIds])].sort() })
const TERMINAL = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced', 'cancelled', 'superseded'])
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
    this.protocol.initialize(SYNC_COORDINATOR_ADDRESS)
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
  private release(tx: ProtocolTransaction, token: string): void {
    tx.exec('UPDATE sync_leases SET token=NULL,operation_id=NULL,attempt_id=NULL,expires_at_ms=NULL WHERE token=?', token)
  }
  private acquireResources(tx: ProtocolTransaction, operation: SyncOperation, attempt: SyncAttempt, keys: string[]): void {
    const held = tx.query('SELECT l.resource_key,l.token,l.attempt_id,l.expires_at_ms,a.status FROM sync_leases l LEFT JOIN sync_attempts a ON a.id=l.attempt_id WHERE l.repository_id=? AND l.token IS NOT NULL', operation.input.source.repositoryId)
    const owns = (row: Record<string, unknown>): boolean => row.token === attempt.leaseToken && row.attempt_id === attempt.id
    for (const row of held) if (!owns(row) && (Number(row.expires_at_ms) > this.now() || row.status === 'applying') && keys.some(key => resourceOverlap(key, String(row.resource_key)))) fail('SYNC_LEASE_CONFLICT', String(row.resource_key))
    for (const key of keys) if (!held.some(row => row.resource_key === key && owns(row))) tx.exec('INSERT INTO sync_leases(repository_id,resource_key,generation,token,operation_id,attempt_id,expires_at_ms) VALUES(?,?,1,?,?,?,?) ON CONFLICT(repository_id,resource_key) DO UPDATE SET generation=generation+1,token=excluded.token,operation_id=excluded.operation_id,attempt_id=excluded.attempt_id,expires_at_ms=excluded.expires_at_ms', operation.input.source.repositoryId, key, attempt.leaseToken, operation.id, attempt.id, attempt.expiresAtMs)
  }
  private checkFence(tx: ProtocolTransaction, fence: WriteFence, finishing = false): { operation: SyncOperation; attempt: SyncAttempt } {
    const operation = this.operation(tx, fence.operationId), attempt = this.attempt(tx, fence.attemptId)
    if (operation.currentAttemptId !== attempt.id || operation.generation !== fence.generation || attempt.generation !== fence.generation || attempt.operationId !== operation.id || operation.input.source.physicalFingerprint !== fence.sourceFingerprint || attempt.leaseToken !== fence.leaseToken || attempt.status === 'superseded' || attempt.status === 'settled' || attempt.status === 'failed') fail('SYNC_FENCE_EXPIRED', 'operation, attempt, generation or physical source changed')
    const applying = ['applying', 'cancelling', 'pausing', 'recovery_required'].includes(operation.phase)
    if ((!finishing && this.now() >= operation.deadlineAtMs) || operation.phase === 'superseded' || (!finishing && operation.control !== 'run') || (attempt.expiresAtMs <= this.now() && !(finishing && applying))) fail('SYNC_FENCE_EXPIRED', 'write authority is expired or controlled')
    const rows = tx.query('SELECT resource_key,token,attempt_id FROM sync_leases WHERE token=?', fence.leaseToken)
    const required = scopeKeys(operation.readyScope)
    if (!required.every(key => rows.some(row => row.resource_key === key && row.attempt_id === attempt.id))) fail('SYNC_FENCE_EXPIRED', 'a resource lease was released or replaced')
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
  /** 稳定接入记录与既有消息派发计划共享一个 SQL 事务。 */
  admitAndEnqueue(input: AdmitSyncInput): SyncOperation {
    validateScope(input.scope)
    this.blob(input.input.manifestBlob)
    if (input.requestBlob) this.blob(input.requestBlob)
    if (input.planBlob) { this.blob(input.planBlob); if (input.planBlob.sha256 !== input.policyDigest) fail('SYNC_PLAN_BINDING', 'plan evidence must have exactly the frozen policy digest') }
    if (input.delivery && (input.delivery.canonicalRoot !== input.deliveryPlan.canonicalRoot || input.delivery.branch !== input.deliveryPlan.branch || input.delivery.repositoryId !== input.input.source.repositoryId)) fail('SYNC_DELIVERY_BINDING', 'bound delivery differs from durable plan')
    const payloadDigest = digest({ input: inputPayload(input.input), ...(input.requestBlob ? { requestBlob: input.requestBlob } : {}), ...(input.planBlob ? { planBlob: input.planBlob } : {}), scope: canonicalScope(input.scope), policyDigest: input.policyDigest, impactDigest: input.impactDigest, readSetDigest: input.readSetDigest, deliveryPlan: input.deliveryPlan, previousBaselinePairId: input.previousBaselinePair?.id ?? null, budget: input.budget })
    return this.write(tx => {
      const prior = parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE ingress_key=? OR EXISTS (SELECT 1 FROM json_each(sync_operations.ingress_aliases_json) WHERE value=?)', input.ingressKey, input.ingressKey)[0])
      if (prior) { if (prior.payloadDigest !== payloadDigest) fail('SYNC_IDEMPOTENCY_CONFLICT', input.ingressKey); return prior }
      const sameInput = parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE payload_digest=?', payloadDigest)[0])
      if (sameInput) { tx.exec("UPDATE sync_operations SET ingress_aliases_json=json_insert(ingress_aliases_json,'$[#]',?) WHERE id=?", input.ingressKey, sameInput.id); return sameInput }
      if (input.previousBaselinePair) {
        const pair = parseRecord<BaselinePair>(tx.query('SELECT record_json FROM sync_baseline_pairs WHERE id=?', input.previousBaselinePair.id)[0])
        if (!pair || identityKey(pair.source) !== identityKey(input.input.source) || digest(pair) !== digest(input.previousBaselinePair)) fail('SYNC_BASELINE_STALE', 'previous source baseline does not match durable pair')
      }
      const older = tx.query('SELECT record_json FROM sync_operations WHERE repository_id=? AND source_root=?', input.input.source.repositoryId, input.input.source.canonicalRoot).map(row => parseRecord<SyncOperation>(row)!)
      const generation = Math.max(0, ...older.map(operation => operation.generation)) + 1
      for (const operation of older) {
        if (TERMINAL.has(operation.phase)) continue
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
      const message = tx.enqueue(SYNC_COORDINATOR_ADDRESS, { kind: SYNC_DISPATCH_KIND, body: Buffer.from(JSON.stringify(envelope)), idempotencyKey: dispatchKey })
      const operation: SyncOperation = { ...clone(input), scope: canonicalScope(input.scope), id, payloadDigest, generation, revision: 1, phase: 'queued', control: 'run', previousBaselinePair: clone(input.previousBaselinePair ?? null), readyScope: canonicalScope(input.scope), blockedScope: emptyScope(), deliveredScope: emptyScope(), blockedReason: null, callsUsed: 0, deadlineAtMs: this.now() + input.budget.timeoutMs, currentAttemptId: null, dispatchMessageId: message.messageId, createdAtMs: this.now(), updatedAtMs: this.now() }
      tx.exec('INSERT INTO sync_operations(id,ingress_key,payload_digest,repository_id,source_key,source_root,generation,phase,control,current_attempt_id,updated_at_ms,record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, input.ingressKey, payloadDigest, input.input.source.repositoryId, identityKey(input.input.source), input.input.source.canonicalRoot, generation, operation.phase, operation.control, null, operation.updatedAtMs, JSON.stringify(operation))
      return operation
    })
  }
  discardDispatch(operationId: string, expectedMessageId: string): void {
    this.write(tx => {
      const operation = this.operation(tx, operationId)
      if (operation.dispatchMessageId !== expectedMessageId || (operation.control === 'run' && !TERMINAL.has(operation.phase))) fail('SYNC_DISPATCH_NOT_STALE', 'dispatch still requires a durable attempt')
      tx.dequeue(SYNC_COORDINATOR_ADDRESS, expectedMessageId)
    })
  }
  claimAttempt(input: ClaimAttemptInput): ClaimedAttempt {
    validateScope(input.scope)
    return this.write(tx => {
      const operation = this.operation(tx, input.operationId)
      if (operation.control !== 'run' || TERMINAL.has(operation.phase) || ['applying', 'cancelling', 'pausing', 'recovery_required'].includes(operation.phase)) fail('SYNC_CLAIM_REFUSED', operation.phase)
      if (identityKey(operation.input.source) !== identityKey(input.source)) fail('SYNC_SOURCE_CHANGED', 'worktree physical identity changed')
      if (!contains(operation.scope, input.scope) || !scopeKeys(input.scope).length) fail('SYNC_SCOPE_INVALID', 'lease scope must be a nonempty operation subset')
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) fail('SYNC_LEASE_INVALID', 'leaseMs must be positive')
      const old = operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
      if (old && old.expiresAtMs > this.now() && !['failed', 'superseded', 'settled'].includes(old.status)) fail('SYNC_ATTEMPT_ACTIVE', old.id)
      if (old) { old.status = 'superseded'; this.saveAttempt(tx, old); this.release(tx, old.leaseToken); operation.generation++ }
      const number = Number(tx.query('SELECT MAX(number) AS number FROM sync_attempts WHERE operation_id=?', operation.id)[0].number ?? 0) + 1
      const repairFailures = tx.query('SELECT record_json FROM sync_attempts WHERE operation_id=?', operation.id).map(row => parseRecord<SyncAttempt>(row)!).filter(attempt => attempt.verification?.passed === false || attempt.failure?.kind === 'repairable').length
      if (this.now() >= operation.deadlineAtMs || repairFailures > operation.budget.maxRepairs) fail('SYNC_BUDGET_EXHAUSTED', 'deadline or repair budget exhausted')
      if (number > operation.budget.maxAttempts) fail('SYNC_BUDGET_EXHAUSTED', 'attempt budget exhausted')
      const resources = scopeKeys(input.scope)
      const id = randomUUID(), token = randomUUID(), expiresAtMs = this.now() + input.leaseMs
      const attempt: SyncAttempt = { id, operationId: operation.id, number, generation: operation.generation, dispatchKey: `sync-attempt-${operation.id}-${number}`, sessionCreateKey: `sync-session-${operation.id}-${number}`, status: 'claimed', currentSession: null, dispatchPlans: [], composedInput: null, candidate: null, verification: null, checkpointRefs: [], failure: null, leaseToken: token, expiresAtMs }
      tx.exec('INSERT INTO sync_attempts(id,operation_id,number,generation,dispatch_key,session_create_key,status,expires_at_ms,record_json) VALUES(?,?,?,?,?,?,?,?,?)', id, operation.id, number, operation.generation, attempt.dispatchKey, attempt.sessionCreateKey, attempt.status, expiresAtMs, JSON.stringify(attempt))
      this.acquireResources(tx, operation, attempt, resources)
      if (input.expectedMessageId !== undefined) {
        if (input.expectedMessageId !== operation.dispatchMessageId) fail('SYNC_DISPATCH_MISMATCH', 'message does not belong to operation')
        tx.dequeue(SYNC_COORDINATOR_ADDRESS, input.expectedMessageId)
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
  bindComposedInput(fence: WriteFence, composed: ComposedInputRef): SyncAttempt {
    this.blob(composed.manifestBlob)
    if (composed.requestBlob) this.blob(composed.requestBlob)
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (composed.sourceInputId !== operation.input.id || composed.previousBaselinePairId !== (operation.previousBaselinePair?.id ?? null) || (composed.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null)) fail('SYNC_COMPOSITION_BINDING', 'composition must retain original source, baseline pair and controlled request')
      if (attempt.composedInput && digest(attempt.composedInput) !== digest(composed)) fail('SYNC_COMPOSITION_FROZEN', 'composed input cannot be replaced')
      attempt.composedInput = clone(composed); this.saveAttempt(tx, attempt); return attempt
    })
  }
  reserveDispatch(fence: WriteFence, input: Pick<DispatchPlan, 'key' | 'purpose' | 'requestDigest'>): DispatchPlan {
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      const prior = attempt.dispatchPlans.find(plan => plan.key === input.key)
      if (prior) { if (prior.purpose !== input.purpose || prior.requestDigest !== input.requestDigest) fail('SYNC_DISPATCH_CONFLICT', input.key); return prior }
      if (operation.callsUsed >= operation.budget.maxCalls || this.now() >= operation.deadlineAtMs) fail('SYNC_BUDGET_EXHAUSTED', 'native call budget or deadline exhausted')
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
  startElaboration(fence: WriteFence): SyncOperation {
    return this.write(tx => { const { operation } = this.checkFence(tx, fence); if (operation.phase !== 'analyzing') fail('SYNC_PHASE_INVALID', operation.phase); operation.phase = 'elaborating'; this.saveOperation(tx, operation); return operation })
  }
  /** 可信细化只扩展业务 ID；路径授权和接入身份保持冻结，新增租约同事务取得。 */
  expandContractScope(fence: WriteFence, ids: Pick<SyncScope, 'contractIds' | 'flowIds'>, evidenceRef: BlobRef): SyncOperation {
    this.blob(evidenceRef)
    if (Object.keys(ids).some(key => !['contractIds', 'flowIds'].includes(key)) || !(['contractIds', 'flowIds'] as const).every(key => Array.isArray(ids[key]) && ids[key].every(id => typeof id === 'string' && id.length > 0 && id === id.trim() && !id.includes('\0')))) fail('SYNC_SCOPE_INVALID', 'scope expansion accepts only complete contractIds/flowIds')
    const requested = canonicalScope({ paths: [], ...ids })
    const expansion = { contractIds: requested.contractIds, flowIds: requested.flowIds, evidenceRef: clone(evidenceRef) }
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      const prior = operation.contractScopeExpansions?.find(record => record.evidenceRef.sha256 === evidenceRef.sha256)
      if (prior && digest(prior) !== digest(expansion)) fail('SYNC_SCOPE_EVIDENCE_CONFLICT', 'the same elaboration evidence cannot claim different ID sets')
      const keys = scopeKeys(requested), owned = tx.query('SELECT resource_key FROM sync_leases WHERE repository_id=? AND token=? AND attempt_id=?', operation.input.source.repositoryId, attempt.leaseToken, attempt.id)
      if (prior && keys.every(key => owned.some(row => row.resource_key === key))) return operation
      if (!['analyzing', 'elaborating', 'repairing', 'needs_input', 'conflicted'].includes(operation.phase)) fail('SYNC_PHASE_INVALID', operation.phase)
      if (!contains(requested, { paths: [], contractIds: operation.scope.contractIds, flowIds: operation.scope.flowIds })) fail('SYNC_SCOPE_INVALID', 'expanded ID sets cannot delete existing business authority')
      this.acquireResources(tx, operation, attempt, keys)
      const added: SyncScope = { paths: [], contractIds: requested.contractIds.filter(id => !operation.scope.contractIds.includes(id)), flowIds: requested.flowIds.filter(id => !operation.scope.flowIds.includes(id)) }
      operation.scope = union(operation.scope, requested)
      operation.readyScope = union(operation.readyScope, added)
      if (!prior) operation.contractScopeExpansions = [...(operation.contractScopeExpansions ?? []), expansion]
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
      operation.phase = 'generating'; attempt.status = 'running'; this.saveAttempt(tx, attempt); this.saveOperation(tx, operation); return operation
    })
  }
  freezeCandidate(fence: WriteFence, candidate: CandidateRef): SyncAttempt {
    validateScope(candidate.coveredScope)
    this.blob(candidate.manifestBlob)
    const priorAttempt = this.readAttempt(fence.attemptId)
    if (!priorAttempt.composedInput) fail('SYNC_COMPOSITION_MISSING', fence.attemptId)
    const files = this.diff(candidate)
    if (digest(files) !== digest(this.manifestDiff(priorAttempt.composedInput.manifestBlob, candidate.manifestBlob))) fail('SYNC_DIFF_BINDING', 'model diff differs from composed input to candidate manifest')
    if (!contains(candidate.coveredScope, { paths: files.map(file => file.path), contractIds: [], flowIds: [] })) fail('SYNC_CANDIDATE_SCOPE', 'actual changed files escape claimed candidate scope')
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      if (operation.phase !== 'generating' || !attempt.composedInput || candidate.baseTree !== attempt.composedInput.tree || candidate.sourceInputId !== operation.input.id) fail('SYNC_PHASE_INVALID', operation.phase)
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
    return this.write(tx => {
      const { operation, attempt } = this.checkFence(tx, fence)
      const prior = parseRecord<ApplyJournal>(tx.query('SELECT record_json FROM sync_apply_journals WHERE effect_key=?', plan.effectKey)[0])
      if (prior) { if (prior.plan.payloadDigest !== plan.payloadDigest || digest(prior.plan) !== digest(plan) || prior.attemptId !== attempt.id) fail('SYNC_EFFECT_CONFLICT', plan.effectKey); return prior }
      if (operation.phase !== 'ready_to_apply' || !attempt.candidate || !attempt.verification?.passed) fail('SYNC_APPLY_NOT_VERIFIED', operation.phase)
      if (plan.candidateDigest !== attempt.candidate.digest || plan.verificationBlob.sha256 !== attempt.verification.resultBlob.sha256 || digest(plan.files) !== digest(files) || !contains(attempt.verification.coveredScope, plan.coveredScope) || !contains(plan.coveredScope, { paths: files.map(file => file.path), contractIds: [], flowIds: [] })) fail('SYNC_APPLY_BINDING', 'plan differs from frozen candidate or verified scope')
      if (!operation.delivery || identityKey(plan.target) !== identityKey(operation.delivery) || identityKey(currentTarget.source) !== identityKey(plan.target) || currentTarget.id !== plan.expectedTargetSnapshotId) fail('SYNC_TARGET_STALE', 'physical target or current snapshot changed')
      if (plan.expectedBaselinePairId !== (operation.previousBaselinePair?.id ?? null)) fail('SYNC_BASELINE_STALE', 'plan baseline differs from frozen operation')
      const latest = this.baseline(tx, operation.input.source)
      if (operation.previousBaselinePair && latest?.id !== operation.previousBaselinePair.id) fail('SYNC_BASELINE_STALE', 'source baseline advanced')
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
    return this.write(tx => {
      const journal = this.journal(tx, journalId), operation = this.operation(tx, journal.operationId), attempt = this.attempt(tx, journal.attemptId)
      if (!journal.receipt || journal.receipt.id !== receiptId) fail('SYNC_RECEIPT_MISSING', receiptId)
      if (journal.status === 'settled') return operation
      const pair: BaselinePair = { id: `baseline-${journal.id}`, repositoryId: operation.input.source.repositoryId, source: clone(operation.input.source), sourceInput: clone(operation.input), verifiedDelivery: clone(journal.receipt.deliverySnapshot), coveredScope: clone(journal.plan.coveredScope), receiptId, settledAtMs: this.now() }
      tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', pair.id, pair.repositoryId, identityKey(pair.source), pair.receiptId, pair.settledAtMs, JSON.stringify(pair))
      if (identityKey(pair.source) !== identityKey(pair.verifiedDelivery.source) || pair.sourceInput.id !== pair.verifiedDelivery.id) {
        const published: BaselinePair = { ...pair, id: `${pair.id}-delivery`, source: clone(pair.verifiedDelivery.source), sourceInput: clone(pair.verifiedDelivery) }
        tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', published.id, published.repositoryId, identityKey(published.source), receiptId, published.settledAtMs, JSON.stringify(published))
      }
      operation.deliveredScope = union(operation.deliveredScope, journal.plan.coveredScope)
      if (operation.control === 'cancel') operation.phase = 'cancelled'
      else if (operation.control === 'pause') operation.phase = 'paused'
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
      const attempts = tx.query('SELECT record_json FROM sync_attempts WHERE operation_id=?', operationId).map(row => parseRecord<SyncAttempt>(row)!)
      const repairs = attempts.filter(attempt => attempt.verification?.passed === false || attempt.failure?.kind === 'repairable').length
      if (this.now() < operation.deadlineAtMs && operation.callsUsed < operation.budget.maxCalls && attempts.length < operation.budget.maxAttempts && repairs <= operation.budget.maxRepairs) fail('SYNC_BUDGET_NOT_EXHAUSTED', 'budget remains available')
      if (TERMINAL.has(operation.phase)) return operation
      const attempt = operation.currentAttemptId ? this.attempt(tx, operation.currentAttemptId) : null
      if (attempt) {
        attempt.failure = { code: 'SYNC_BUDGET_EXHAUSTED', message: '执行预算或截止时间已耗尽', kind: 'budget', evidenceRefs: [] }
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
  readOperation(id: string): SyncOperation { return this.write(tx => this.operation(tx, id)) }
  findOperationByIngressKey(ingressKey: string): SyncOperation | null {
    return this.write(tx => parseRecord<SyncOperation>(tx.query('SELECT record_json FROM sync_operations WHERE ingress_key=? OR EXISTS (SELECT 1 FROM json_each(sync_operations.ingress_aliases_json) WHERE value=?)', ingressKey, ingressKey)[0]))
  }
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
      for (const table of ['sync_operations', 'sync_attempts', 'sync_apply_journals', 'sync_baseline_pairs', 'sync_resources']) for (const row of tx.query(`SELECT record_json FROM ${table}`)) visit(JSON.parse(String(row.record_json)))
      return [...refs].sort().map(sha256 => ({ sha256 }))
    })
  }
}
