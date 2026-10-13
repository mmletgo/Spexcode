import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { migrateSyncStore, SYNC_COMPONENT, SYNC_MIGRATIONS } from './migrations.js'
import type { AdmitSyncInput, ApplyFilePlan, ApplyPlan, ApplyReceipt, BlobRef, CandidateRef, ClaimedAttempt, InputSnapshot, SyncScope, VerificationRef, VerificationResultBlob, WorktreeIdentity } from './operation-types.js'
import { SyncStore, SYNC_COORDINATOR_ADDRESS } from './store.js'

const source = (name = 'source'): WorktreeIdentity => ({ repositoryId: 'repo', commonDir: '/repo/.git', canonicalRoot: `/repo/${name}`, gitDir: `/repo/.git/worktrees/${name}`, branch: name, physicalFingerprint: `${name}-inode-1` })
const scope = (path = 'src/a.ts', rule = 'RULE-A'): SyncScope => ({ paths: [path], contractIds: [rule], flowIds: [] })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-store-'))
  const path = join(root, 'db.sqlite')
  let time = 1000
  const blobs = new Map<string, Buffer>()
  const put = (value: unknown): BlobRef => { const bytes = Buffer.from(JSON.stringify(value)); const sha256 = createHash('sha256').update(bytes).digest('hex'); blobs.set(sha256, bytes); return { sha256 } }
  const manifest = put({ version: 1, entries: [] })
  const input = (identity = source(), id = 'input-1'): InputSnapshot => ({ id, source: identity, headCommit: 'a'.repeat(40), immutableTree: 'b'.repeat(40), indexTree: 'c'.repeat(40), indexDigest: 'd'.repeat(64), manifestBlob: manifest, contentDigest: 'e'.repeat(64), capturedAtMs: time })
  const options = { now: () => time, readBlob: (ref: BlobRef) => { const bytes = blobs.get(ref.sha256); assert.ok(bytes); return bytes } }
  const protocol = openProtocol(path)
  await migrateSyncStore(protocol, { backupPath: join(root, 'initial.backup') })
  const store = new SyncStore(protocol, options)
  const admit = (identity = source(), id = 'input-1', covered = scope()): AdmitSyncInput => ({ ingressKey: `ingress-${identity.canonicalRoot}-${id}`, rootCauseId: 'cause', origin: 'spec', input: input(identity, id), scope: covered, budget: { maxAttempts: 4, maxCalls: 4, maxRepairs: 2, timeoutMs: 100000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'readset', delivery: null, deliveryPlan: { canonicalRoot: '/repo/delivery', branch: 'delivery', baseCommit: 'a'.repeat(40) } })
  const claim = (value = admit()): ClaimedAttempt => { const operation = store.admitAndEnqueue(value); return store.claimAttempt({ operationId: operation.id, source: value.input.source, scope: value.scope, leaseMs: 1000, expectedMessageId: operation.dispatchMessageId }) }
  const ready = (value = admit(), readyScope = value.scope, blockedScope: SyncScope = { paths: [], contractIds: [], flowIds: [] }, blockedReason: 'needs_input' | 'conflicted' | null = null, beforeGeneration?: (claimed: ClaimedAttempt) => void) => {
    const claimed = claim(value), target = { ...input(value.deliveryPlan.canonicalRoot === value.input.source.canonicalRoot ? value.input.source : source('delivery'), 'target'), manifestBlob: put({ version: 1, entries: readyScope.paths.map(path => ({ path, mode: '100644', oid: 'a'.repeat(40), digest: '1'.repeat(64) })) }) }
    store.bindDelivery(claimed.fence, target.source)
    store.bindComposedInput(claimed.fence, { sourceInputId: value.input.id, previousBaselinePairId: value.previousBaselinePair?.id ?? null, tree: value.input.immutableTree, manifestBlob: target.manifestBlob, contentDigest: value.input.contentDigest })
    beforeGeneration?.(claimed)
    store.startGeneration(claimed.fence, { readyScope, blockedScope, blockedReason })
    const files: ApplyFilePlan[] = readyScope.paths.map(path => ({ path, preDigest: '1'.repeat(64), postDigest: '2'.repeat(64), preMode: '100644', postMode: '100644' }))
    const candidate: CandidateRef = { baseTree: value.input.immutableTree, sourceInputId: value.input.id, tree: 'f'.repeat(40), digest: 'candidate', manifestBlob: put({ version: 1, entries: readyScope.paths.map(path => ({ path, mode: '100644', oid: 'b'.repeat(40), digest: '2'.repeat(64) })) }), actualDiffBlob: put(files), coveredScope: readyScope }
    store.freezeCandidate(claimed.fence, candidate)
    const evidence = put({ observed: 'layer evidence' })
    const bindings = { inputId: value.input.id, candidateDigest: candidate.digest, policyDigest: value.policyDigest, readSetDigest: value.readSetDigest, environmentDigest: 'env', contextDigest: 'context' }
    const result: VerificationResultBlob = { schemaVersion: 1, coveredScope: readyScope, ...bindings, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
    const verification: VerificationRef = { ...bindings, passed: true, coveredScope: readyScope, evidenceRefs: [evidence], resultBlob: put(result) }
    store.recordVerification(claimed.fence, verification)
    const plan: ApplyPlan = { effectKey: `effect-${claimed.operation.id}`, payloadDigest: 'apply-digest', candidateDigest: candidate.digest, verificationBlob: verification.resultBlob, target: target.source, expectedTargetSnapshotId: target.id, expectedBaselinePairId: value.previousBaselinePair?.id ?? null, coveredScope: readyScope, files, planBlob: put({ files, candidateDigest: candidate.digest }) }
    return { ...claimed, target, candidate, verification, plan }
  }
  const receipt = (journalId: string, plan: ApplyPlan): ApplyReceipt => ({ id: `receipt-${journalId}`, journalId, effectKey: plan.effectKey, actualTree: 'f'.repeat(40), actualCommit: '3'.repeat(40), deliverySnapshot: { ...input(store.readJournal(journalId).plan.target, `delivered-${journalId}`), immutableTree: 'f'.repeat(40), manifestBlob: store.readAttempt(store.readJournal(journalId).attemptId).candidate!.manifestBlob }, evidenceRefs: [put({ bytesChecked: true })], completedAtMs: time })
  return { root, path, protocol, store, options, put, input, admit, claim, ready, receipt, tick: (ms: number) => { time += ms }, cleanup: () => { protocol.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('same stable admission and capture-time replay create one operation and protocol message; conflict rolls back', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), first = f.store.admitAndEnqueue(input)
    const second = f.store.admitAndEnqueue({ ...input, input: { ...input.input, capturedAtMs: 9000 } })
    assert.equal(first.id, second.id)
    assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 1)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, policyDigest: 'different' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(f.store.readOperation(first.id).policyDigest, 'policy')
    const third = f.store.admitAndEnqueue({ ...input, ingressKey: 'another-event-key' })
    assert.equal(first.id, third.id)
    assert.equal(f.store.findOperationByIngressKey(input.ingressKey)?.id, first.id)
    assert.equal(f.store.findOperationByIngressKey('another-event-key')?.id, first.id)
    assert.equal(f.store.findOperationByIngressKey('unknown-key'), null)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, ingressKey: 'another-event-key', policyDigest: 'changed' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 1)
  } finally { f.cleanup() }
})

test('operation lists include terminal records, isolate repository/root and use insertion order with bounded limit', async () => {
  const f = await fixture()
  try {
    const first = f.store.admitAndEnqueue(f.admit(source('a')))
    f.store.requestControl(first.id, 'cancel')
    f.tick(-100)
    const second = f.store.admitAndEnqueue(f.admit(source('b')))
    f.store.admitAndEnqueue(f.admit({ ...source('other'), repositoryId: 'other-repo' }))
    assert.deepEqual(f.store.listOperations('repo').map(op => op.id), [second.id, first.id])
    assert.equal(f.store.listOperations('repo')[1].phase, 'cancelled')
    assert.deepEqual(f.store.listOperations('repo', { sourceRoot: first.input.source.canonicalRoot }).map(op => op.id), [first.id])
    assert.deepEqual(f.store.listOperations('repo', { limit: 1 }).map(op => op.id), [second.id])
    assert.deepEqual(f.store.listOperations('unknown'), [])
    for (const limit of [0, 501, 1.5, NaN]) assert.throws(() => f.store.listOperations('repo', { limit }), /SYNC_LIST_LIMIT/)
  } finally { f.cleanup() }
})

test('controlled requests preserve source snapshots and take part in admission identity and blob pins', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), requestBlob = f.put({ kind: 'spec-edit', replacement: '新的明确原始需求' })
    const first = f.store.admitAndEnqueue({ ...input, requestBlob })
    assert.deepEqual(first.input, input.input)
    assert.deepEqual(first.requestBlob, requestBlob)
    assert.equal(f.store.admitAndEnqueue({ ...input, requestBlob }).id, first.id)
    assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === requestBlob.sha256))
    const changedRequest = f.put({ kind: 'spec-edit', replacement: '后续用户修改' })
    assert.throws(() => f.store.admitAndEnqueue({ ...input, requestBlob: changedRequest }), /IDEMPOTENCY_CONFLICT/)
    const next = f.store.admitAndEnqueue({ ...input, ingressKey: 'next-request', requestBlob: changedRequest })
    assert.notEqual(next.id, first.id)
    assert.equal(next.input.id, first.input.id)
    assert.equal(f.store.readOperation(first.id).phase, 'superseded')
  } finally { f.cleanup() }
})

test('journals query exact operation and retains settled receipts in terminal operations', async () => {
  const f = await fixture()
  try {
    const r = f.ready(), journal = f.store.beginApply(r.fence, r.plan, r.target)
    for (const step of journal.steps) f.store.recordApplyStep(r.fence, journal.id, { ...step, status: 'completed' })
    const receipt = f.receipt(journal.id, r.plan)
    f.store.recordReceipt(journal.id, receipt)
    f.store.settleApply(journal.id, receipt.id)
    assert.equal(f.store.listJournals(r.operation.id)[0].receipt?.id, receipt.id)
    assert.equal(f.store.listJournals(r.operation.id)[0].status, 'settled')
    const other = f.store.admitAndEnqueue(f.admit(source('other')))
    assert.deepEqual(f.store.listJournals(other.id), [])
    assert.throws(() => f.store.listJournals('unknown'), /SYNC_OPERATION_UNKNOWN/)
  } finally { f.cleanup() }
})

test('v2 upgrade preserves requestless dedup identity and backs up the old component version', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v2.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 2))
    legacy.initialize(SYNC_COORDINATOR_ADDRESS)
    const input = f.admit(), old = f.store.admitAndEnqueue(input)
    for (const table of ['protocol_messages', 'sync_operations'] as const) {
      const rows = f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))
      legacy.withTransaction(tx => {
        for (const row of rows) {
          const columns = Object.keys(row).filter(column => column !== 'enqueue_seq')
          tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[])
        }
      })
    }
    assert.throws(() => new SyncStore(legacy, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    const path = join(f.root, 'v2-backup.sqlite')
    assert.equal(await migrateSyncStore(legacy, { backupPath: path }), 3)
    const upgraded = new SyncStore(legacy, f.options)
    assert.equal(upgraded.admitAndEnqueue(input).id, old.id)
    assert.equal(upgraded.readOperation(old.id).payloadDigest, old.payloadDigest)
    backup = openProtocol(path)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 2)
    assert.equal(backup.listPending(SYNC_COORDINATOR_ADDRESS).length, 1)
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('claim exact message and all leases are one transaction, native dispatch budget is atomic', async () => {
  const f = await fixture()
  try {
    const operation = f.store.admitAndEnqueue(f.admit())
    assert.throws(() => f.store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 1000, expectedMessageId: 'wrong' }), /SYNC_DISPATCH_MISMATCH/)
    assert.equal(f.store.readOperation(operation.id).currentAttemptId, null)
    const claimed = f.store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 1000, expectedMessageId: operation.dispatchMessageId })
    assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 0)
    const dispatch = f.store.reserveDispatch(claimed.fence, { key: 'call-1', purpose: 'generate', requestDigest: 'request' })
    assert.ok(dispatch.sessionCreateKey.length <= 128)
    assert.deepEqual(f.store.reserveDispatch(claimed.fence, { key: 'call-1', purpose: 'generate', requestDigest: 'request' }), dispatch)
    assert.equal(f.store.readOperation(operation.id).callsUsed, 1)
    assert.throws(() => f.store.reserveDispatch(claimed.fence, { key: 'call-1', purpose: 'generate', requestDigest: 'different' }), /SYNC_DISPATCH_CONFLICT/)
    f.store.bindSession(claimed.fence, dispatch.key, { sessionId: 'native', threadId: 'thread', turnId: null })
    assert.throws(() => f.store.bindSession(claimed.fence, dispatch.key, { sessionId: 'another', threadId: 'thread', turnId: null }), /SYNC_SESSION_CONFLICT/)
    for (let i = 2; i <= 4; i++) f.store.reserveDispatch(claimed.fence, { key: `call-${i}`, purpose: 'review', requestDigest: 'request' })
    assert.throws(() => f.store.reserveDispatch(claimed.fence, { key: 'call-5', purpose: 'review', requestDigest: 'request' }), /SYNC_BUDGET_EXHAUSTED/)
  } finally { f.cleanup() }
})

test('real SQLite handles contend on shared paths or rules, independent scope proceeds, release preserves generation', async () => {
  const f = await fixture(), secondProtocol = openProtocol(f.path), second = new SyncStore(secondProtocol, f.options)
  try {
    const first = f.claim()
    const conflict = second.admitAndEnqueue(f.admit(source('other'), 'input-2', scope('src/b.ts', 'RULE-A')))
    assert.throws(() => second.claimAttempt({ operationId: conflict.id, source: conflict.input.source, scope: conflict.scope, leaseMs: 1000 }), /SYNC_LEASE_CONFLICT/)
    assert.equal(second.readOperation(conflict.id).currentAttemptId, null)
    const independent = second.admitAndEnqueue(f.admit(source('independent'), 'input-3', scope('src/c.ts', 'RULE-C')))
    assert.ok(second.claimAttempt({ operationId: independent.id, source: independent.input.source, scope: independent.scope, leaseMs: 1000 }))
    f.store.requestControl(first.operation.id, 'cancel')
    assert.equal(f.protocol.withTransaction(tx => tx.query("SELECT generation,token FROM sync_leases WHERE resource_key='path:src/a.ts'"))[0].generation, 1)
    const next = second.claimAttempt({ operationId: conflict.id, source: conflict.input.source, scope: conflict.scope, leaseMs: 1000 })
    assert.equal(secondProtocol.withTransaction(tx => tx.query("SELECT generation FROM sync_leases WHERE resource_key='contract:RULE-A'"))[0].generation, 2)
    assert.throws(() => f.store.checkpoint(first.fence, f.put({ stale: true })), /SYNC_FENCE_EXPIRED/)
    assert.notEqual(next.fence.leaseToken, first.fence.leaseToken)
  } finally { secondProtocol.close(); f.cleanup() }
})

test('expired attempts recover from durable record after dequeue; retry revokes old fence and retains calls', async () => {
  const f = await fixture()
  try {
    const first = f.claim()
    f.store.reserveDispatch(first.fence, { key: 'create', purpose: 'generate', requestDigest: 'r' })
    f.tick(1001)
    assert.throws(() => f.store.bindDelivery(first.fence, source('delivery')), /SYNC_FENCE_EXPIRED/)
    const reopened = openProtocol(f.path), recovered = new SyncStore(reopened, f.options)
    try {
      assert.equal(recovered.listRecoverable()[0].attempt?.id, first.attempt.id)
      assert.equal(recovered.listRecoverable()[0].attempt?.dispatchPlans[0].key, 'create')
      const next = recovered.claimAttempt({ operationId: first.operation.id, source: first.operation.input.source, scope: first.operation.scope, leaseMs: 1000 })
      assert.ok(next.fence.generation > first.fence.generation)
      assert.equal(next.operation.callsUsed, 1)
      assert.throws(() => recovered.checkpoint(first.fence, f.put({ stale: true })), /SYNC_FENCE_EXPIRED/)
    } finally { reopened.close() }
  } finally { f.cleanup() }
})

test('branch switch or delete-recreate physical source supersedes previous write authority', async () => {
  const f = await fixture()
  try {
    const first = f.claim(), rebuilt = { ...source(), physicalFingerprint: 'source-inode-2' }
    f.store.admitAndEnqueue(f.admit(rebuilt, 'input-2'))
    assert.equal(f.store.readOperation(first.operation.id).phase, 'superseded')
    assert.throws(() => f.store.reserveDispatch(first.fence, { key: 'stale', purpose: 'generate', requestDigest: 'r' }), /SYNC_FENCE_EXPIRED/)
    assert.throws(() => f.store.claimAttempt({ operationId: first.operation.id, source: rebuilt, scope: scope(), leaseMs: 1000 }), /SYNC_CLAIM_REFUSED/)
  } finally { f.cleanup() }
})

test('actual diff and all independent verification layers gate journal; changed target creates no journal', async () => {
  const f = await fixture()
  try {
    const prepared = f.ready()
    assert.throws(() => f.store.beginApply(prepared.fence, prepared.plan, { ...prepared.target, id: 'edited' }), /SYNC_TARGET_STALE/)
    assert.equal(f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_apply_journals')).length, 0)
    assert.throws(() => f.store.beginApply(prepared.fence, { ...prepared.plan, files: [] }, prepared.target), /SYNC_APPLY_BINDING/)
    const journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    assert.equal(journal.id, f.store.beginApply(prepared.fence, prepared.plan, prepared.target).id)
    assert.throws(() => f.store.beginApply(prepared.fence, { ...prepared.plan, payloadDigest: 'changed' }, prepared.target), /SYNC_EFFECT_CONFLICT/)
  } finally { f.cleanup() }
})

test('passed boolean cannot substitute missing V1-V4 evidence and binding', async () => {
  const f = await fixture()
  try {
    const first = f.claim()
    f.store.bindComposedInput(first.fence, { sourceInputId: first.operation.input.id, previousBaselinePairId: null, tree: 'b'.repeat(40), manifestBlob: f.input().manifestBlob, contentDigest: 'content' })
    f.store.startGeneration(first.fence)
    const candidate: CandidateRef = { baseTree: 'b'.repeat(40), sourceInputId: 'input-1', tree: 'f'.repeat(40), digest: 'candidate', manifestBlob: f.input().manifestBlob, actualDiffBlob: f.put([]), coveredScope: scope() }
    f.store.freezeCandidate(first.fence, candidate)
    const verification: VerificationRef = { inputId: 'input-1', candidateDigest: candidate.digest, policyDigest: 'policy', readSetDigest: 'readset', environmentDigest: 'env', contextDigest: 'context', passed: true, coveredScope: scope(), evidenceRefs: [], resultBlob: f.put({ schemaVersion: 1, layers: [] }) }
    assert.throws(() => f.store.recordVerification(first.fence, verification), /SYNC_VERIFICATION_INVALID/)
    assert.equal(f.store.readOperation(first.operation.id).phase, 'verifying')
    assert.equal(f.store.readAttempt(first.attempt.id).verification, null)
  } finally { f.cleanup() }
})

test('cancel before apply has no journal, cancel during apply waits for receipt settlement and preserves receipt', async () => {
  const f = await fixture()
  try {
    const first = f.ready()
    assert.equal(f.store.requestControl(first.operation.id, 'cancel').phase, 'cancelled')
    assert.throws(() => f.store.beginApply(first.fence, first.plan, first.target), /SYNC_FENCE_EXPIRED/)
    assert.equal(f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_apply_journals')).length, 0)
    const second = f.ready(f.admit(source(), 'input-2'))
    const journal = f.store.beginApply(second.fence, second.plan, second.target)
    assert.equal(f.store.requestControl(second.operation.id, 'cancel').phase, 'cancelling')
    assert.throws(() => f.store.settleApply(journal.id, 'missing'), /SYNC_RECEIPT_MISSING/)
    f.tick(1001)
    for (const file of second.plan.files) f.store.recordApplyStep(second.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ observed: file.path }) })
    const receipt = f.receipt(journal.id, second.plan)
    f.store.recordReceipt(journal.id, receipt)
    assert.equal(f.store.settleApply(journal.id, receipt.id).phase, 'cancelled')
    assert.deepEqual(f.store.readJournal(journal.id).receipt, receipt)
    assert.equal(f.store.settleApply(journal.id, receipt.id).phase, 'cancelled')
    assert.ok(f.store.readBaseline(source()))
  } finally { f.cleanup() }
})

test('receipt durable before settlement survives reopen; paired source/delivery baselines and pins settle once', async () => {
  const f = await fixture()
  try {
    const prepared = f.ready(), journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ bytes: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan)
    f.store.recordReceipt(journal.id, receipt)
    const reopen = openProtocol(f.path), recovered = new SyncStore(reopen, f.options)
    try {
      assert.equal(recovered.listRecoverable()[0].journals[0].receipt?.id, receipt.id)
      assert.equal(recovered.settleApply(journal.id, receipt.id).phase, 'workspace_synced')
      const sourcePair = recovered.readBaseline(source())!, deliveryPair = recovered.readBaseline(source('delivery'))!
      assert.equal(sourcePair.sourceInput.id, 'input-1')
      assert.equal(sourcePair.verifiedDelivery.id, receipt.deliverySnapshot.id)
      assert.deepEqual(deliveryPair.sourceInput, deliveryPair.verifiedDelivery)
      const next = recovered.admitAndEnqueue({ ...f.admit(source('delivery'), 'delivery-edited'), previousBaselinePair: deliveryPair })
      assert.equal(next.previousBaselinePair?.source.canonicalRoot, '/repo/delivery')
      assert.ok(recovered.pinnedBlobRefs().some(ref => ref.sha256 === prepared.candidate.actualDiffBlob.sha256))
      recovered.settleApply(journal.id, receipt.id)
      assert.equal(reopen.withTransaction(tx => tx.query('SELECT * FROM sync_baseline_pairs')).length, 2)
    } finally { reopen.close() }
  } finally { f.cleanup() }
})

test('partial delivery advances only covered scope and preserves root needs_input', async () => {
  const f = await fixture()
  try {
    const full = { paths: ['src/a.ts', 'src/b.ts'], contractIds: ['RULE-A', 'RULE-B'], flowIds: [] }
    const prepared = f.ready(f.admit(source(), 'input-1', full), scope(), scope('src/b.ts', 'RULE-B'), 'needs_input')
    const journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ observed: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan); f.store.recordReceipt(journal.id, receipt)
    const settled = f.store.settleApply(journal.id, receipt.id)
    assert.equal(settled.phase, 'needs_input')
    assert.deepEqual(settled.deliveredScope, scope())
    assert.deepEqual(f.store.readBaseline(source())?.coveredScope, scope())
  } finally { f.cleanup() }
})

test('component migration online backup restores old database, failed DDL rolls back, future schema refuses writes', async () => {
  const f = await fixture()
  try {
    const backup = openProtocol(join(f.root, 'initial.backup'))
    try {
      assert.equal(backup.withTransaction(tx => tx.query('SELECT * FROM schema_migrations WHERE component=?', SYNC_COMPONENT)).length, 0)
      assert.equal(backup.withTransaction(tx => tx.query("SELECT * FROM sqlite_master WHERE name='sync_operations'")).length, 0)
    } finally { backup.close() }
    assert.throws(() => applyComponentMigrations(f.protocol, 'broken-test', [{ version: 1, sql: 'CREATE TABLE will_rollback(id TEXT) STRICT; INSERT INTO missing VALUES(1);' }]))
    assert.equal(f.protocol.withTransaction(tx => tx.query("SELECT * FROM sqlite_master WHERE name='will_rollback'")).length, 0)
    assert.equal(await migrateSyncStore(f.protocol), SYNC_MIGRATIONS.length)
    f.protocol.withTransaction(tx => tx.exec('INSERT INTO schema_migrations(component,version,checksum,applied_at_ms) VALUES(?,?,?,?)', SYNC_COMPONENT, SYNC_MIGRATIONS.length + 1, 'future', 1000))
    await assert.rejects(migrateSyncStore(f.protocol), /SYNC_SCHEMA_UNSUPPORTED/)
    assert.throws(() => f.store.admitAndEnqueue(f.admit()), /SYNC_SCHEMA_UNSUPPORTED/)
  } finally { f.cleanup() }
})

test('delivery intent is durable before binding, physical target cannot change after binding', async () => {
  const f = await fixture()
  try {
    const first = f.claim()
    assert.equal(first.operation.delivery, null)
    assert.equal(first.operation.deliveryPlan.canonicalRoot, '/repo/delivery')
    assert.throws(() => f.store.bindDelivery(first.fence, source('other-target')), /SYNC_DELIVERY_BINDING/)
    f.store.bindDelivery(first.fence, source('delivery'))
    assert.throws(() => f.store.bindDelivery(first.fence, { ...source('delivery'), physicalFingerprint: 'recreated' }), /SYNC_DELIVERY_BINDING/)
  } finally { f.cleanup() }
})

test('human source input is journaled together with model diff; candidate cannot claim a false model diff', async () => {
  const f = await fixture()
  try {
    const sourceManifest = f.put({ version: 1, entries: [{ path: 'src/a.ts', mode: '100644', oid: 'a'.repeat(40), digest: '1'.repeat(64) }] })
    const candidateManifest = f.put({ version: 1, entries: [{ path: 'src/a.ts', mode: '100755', oid: 'b'.repeat(40), digest: '2'.repeat(64) }] })
    const claim = f.claim()
    f.store.bindDelivery(claim.fence, source('delivery'))
    f.store.bindComposedInput(claim.fence, { sourceInputId: claim.operation.input.id, previousBaselinePairId: null, tree: 'b'.repeat(40), manifestBlob: sourceManifest, contentDigest: 'source-content' })
    f.store.startGeneration(claim.fence)
    const candidate: CandidateRef = { baseTree: 'b'.repeat(40), sourceInputId: claim.operation.input.id, tree: 'f'.repeat(40), digest: 'candidate', manifestBlob: candidateManifest, actualDiffBlob: f.put([]), coveredScope: scope() }
    assert.throws(() => f.store.freezeCandidate(claim.fence, candidate), /SYNC_DIFF_BINDING/)
    const modelFiles: ApplyFilePlan[] = [{ path: 'src/a.ts', preDigest: '1'.repeat(64), postDigest: '2'.repeat(64), preMode: '100644', postMode: '100755' }]
    candidate.actualDiffBlob = f.put(modelFiles)
    f.store.freezeCandidate(claim.fence, candidate)
    const evidence = f.put({ validated: true })
    const bindings = { inputId: 'input-1', candidateDigest: 'candidate', policyDigest: 'policy', readSetDigest: 'readset', environmentDigest: 'env', contextDigest: 'context' }
    const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: scope(), layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
    const verification: VerificationRef = { ...bindings, coveredScope: scope(), passed: true, evidenceRefs: [evidence], resultBlob: f.put(result) }
    f.store.recordVerification(claim.fence, verification)
    const target = f.input(source('delivery'), 'target-without-human-input')
    const files: ApplyFilePlan[] = [{ path: 'src/a.ts', preDigest: null, postDigest: '2'.repeat(64), preMode: null, postMode: '100755' }]
    const plan: ApplyPlan = { effectKey: 'includes-human-input', payloadDigest: 'payload', candidateDigest: candidate.digest, verificationBlob: verification.resultBlob, target: target.source, expectedTargetSnapshotId: target.id, expectedBaselinePairId: null, coveredScope: scope(), files, planBlob: f.put({ files }) }
    assert.throws(() => f.store.beginApply(claim.fence, { ...plan, files: modelFiles }, target), /SYNC_APPLY_BINDING/)
    const journal = f.store.beginApply(claim.fence, plan, target)
    assert.equal(journal.plan.files[0].preDigest, null)
    assert.equal(journal.status, 'prepared')
  } finally { f.cleanup() }
})

test('late native binding cannot demote applying attempt, expired applying leases remain exclusive', async () => {
  const f = await fixture()
  try {
    const prepared = f.ready()
    const dispatch = f.store.reserveDispatch(prepared.fence, { key: 'earlier-call', purpose: 'generate', requestDigest: 'r' })
    f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    f.store.bindSession(prepared.fence, dispatch.key, { sessionId: 'native', threadId: 'thread', turnId: 'turn' })
    assert.equal(f.store.readAttempt(prepared.attempt.id).status, 'applying')
    f.tick(1001)
    const overlapping = f.store.admitAndEnqueue(f.admit(source('other-source'), 'other-input'))
    assert.throws(() => f.store.claimAttempt({ operationId: overlapping.id, source: overlapping.input.source, scope: overlapping.scope, leaseMs: 1000 }), /SYNC_LEASE_CONFLICT/)
  } finally { f.cleanup() }
})

test('narrow coveredScope inside verification blob cannot be expanded by outer reference', async () => {
  const f = await fixture()
  try {
    const first = f.claim()
    f.store.bindComposedInput(first.fence, { sourceInputId: 'input-1', previousBaselinePairId: null, tree: 'b'.repeat(40), manifestBlob: f.input().manifestBlob, contentDigest: 'c' })
    f.store.startGeneration(first.fence)
    f.store.freezeCandidate(first.fence, { baseTree: 'b'.repeat(40), sourceInputId: 'input-1', tree: 'f'.repeat(40), digest: 'candidate', manifestBlob: f.input().manifestBlob, actualDiffBlob: f.put([]), coveredScope: scope() })
    const evidence = f.put({ checked: true }), bindings = { inputId: 'input-1', candidateDigest: 'candidate', policyDigest: 'policy', readSetDigest: 'readset', environmentDigest: 'env', contextDigest: 'context' }
    const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: { paths: [], contractIds: [], flowIds: [] }, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
    assert.throws(() => f.store.recordVerification(first.fence, { ...bindings, passed: true, coveredScope: scope(), evidenceRefs: [evidence], resultBlob: f.put(result) }), /SYNC_VERIFICATION_INVALID/)
  } finally { f.cleanup() }
})

test('partial baseline retains original blocked source and scope when the same source is readmitted', async () => {
  const f = await fixture()
  try {
    const full = { paths: ['src/a.ts', 'src/b.ts'], contractIds: ['RULE-A', 'RULE-B'], flowIds: [] }
    const value = f.admit(source(), 'input-1', full)
    const prepared = f.ready(value, scope(), scope('src/b.ts', 'RULE-B'), 'conflicted')
    const journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ observed: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan); f.store.recordReceipt(journal.id, receipt)
    assert.equal(f.store.settleApply(journal.id, receipt.id).phase, 'conflicted')
    const pair = f.store.readBaseline(source())!
    assert.deepEqual(pair.sourceInput, value.input)
    assert.deepEqual(pair.coveredScope, scope())
    const next = f.store.admitAndEnqueue({ ...value, ingressKey: 'decision-with-identical-source', origin: 'decision', previousBaselinePair: pair })
    assert.deepEqual(next.input, value.input)
    assert.deepEqual(next.scope, full)
    assert.deepEqual(next.previousBaselinePair?.coveredScope, scope())
  } finally { f.cleanup() }
})

test('deadline exhaustion becomes a durable budget state and retries cannot reset it', async () => {
  const f = await fixture()
  try {
    const first = f.claim()
    assert.throws(() => f.store.recordBudgetExhaustion(first.operation.id), /SYNC_BUDGET_NOT_EXHAUSTED/)
    f.tick(100001)
    assert.throws(() => f.store.claimAttempt({ operationId: first.operation.id, source: first.operation.input.source, scope: scope(), leaseMs: 1000 }), /SYNC_BUDGET_EXHAUSTED/)
    assert.equal(f.store.recordBudgetExhaustion(first.operation.id).phase, 'budget_exhausted')
    assert.equal(f.store.readAttempt(first.attempt.id).failure?.kind, 'budget')
    assert.throws(() => f.store.checkpoint(first.fence, f.put({ stale: true })), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})

test('superseded pending dispatch is atomically discarded so a newer operation can claim the FIFO head', async () => {
  const f = await fixture()
  try {
    const old = f.store.admitAndEnqueue(f.admit())
    assert.throws(() => f.store.discardDispatch(old.id, old.dispatchMessageId), /SYNC_DISPATCH_NOT_STALE/)
    const newer = f.store.admitAndEnqueue(f.admit(source(), 'input-2'))
    assert.equal(f.store.readOperation(old.id).phase, 'superseded')
    f.store.discardDispatch(old.id, old.dispatchMessageId)
    const claimed = f.store.claimAttempt({ operationId: newer.id, source: newer.input.source, scope: newer.scope, leaseMs: 1000, expectedMessageId: newer.dispatchMessageId })
    assert.equal(claimed.operation.id, newer.id)
    assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 0)
  } finally { f.cleanup() }
})


test('receipt cannot settle a manifest different from the frozen candidate', async () => {
  const f = await fixture()
  try {
    const prepared = f.ready(), journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ checked: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan)
    assert.throws(() => f.store.recordReceipt(journal.id, { ...receipt, deliverySnapshot: { ...receipt.deliverySnapshot, manifestBlob: f.input().manifestBlob } }), /SYNC_RECEIPT_BINDING/)
    assert.equal(f.store.readJournal(journal.id).receipt, null)
    f.store.recordReceipt(journal.id, receipt)
    assert.equal(f.store.settleApply(journal.id, receipt.id).phase, 'workspace_synced')
  } finally { f.cleanup() }
})


test('cooperative source and delivery sharing physical identity rebase the next source baseline onto actual publication', async () => {
  const f = await fixture()
  try {
    const value = f.admit()
    value.deliveryPlan = { canonicalRoot: value.input.source.canonicalRoot, branch: value.input.source.branch, baseCommit: value.input.headCommit }
    const prepared = f.ready(value), journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ checked: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan); f.store.recordReceipt(journal.id, receipt); f.store.settleApply(journal.id, receipt.id)
    const baseline = f.store.readBaseline(source())!
    assert.deepEqual(baseline.sourceInput, receipt.deliverySnapshot)
    assert.deepEqual(baseline.verifiedDelivery, receipt.deliverySnapshot)
    assert.equal(f.protocol.withTransaction(tx => tx.query('SELECT record_json FROM sync_baseline_pairs WHERE id=?', `baseline-${journal.id}`)).length, 1)
    const next = f.store.admitAndEnqueue({ ...value, ingressKey: 'after-publication', input: { ...receipt.deliverySnapshot, id: 'new-user-edit' }, previousBaselinePair: baseline })
    assert.equal(next.previousBaselinePair?.sourceInput.id, receipt.deliverySnapshot.id)
  } finally { f.cleanup() }
})

test('wall clock rollback cannot select an older settled source or delivery baseline after reopening', async () => {
  const f = await fixture()
  try {
    const first = f.ready(), firstJournal = f.store.beginApply(first.fence, first.plan, first.target)
    for (const file of first.plan.files) f.store.recordApplyStep(first.fence, firstJournal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ checked: file.path }) })
    const firstReceipt = f.receipt(firstJournal.id, first.plan)
    f.store.recordReceipt(firstJournal.id, firstReceipt); f.store.settleApply(firstJournal.id, firstReceipt.id)
    const firstBaseline = f.store.readBaseline(source())!
    assert.equal(firstBaseline.settledAtMs, 1000)

    f.tick(100)
    const second = f.ready({ ...f.admit(source(), 'input-2'), previousBaselinePair: firstBaseline })
    const secondJournal = f.store.beginApply(second.fence, second.plan, second.target)
    f.tick(-200)
    for (const file of second.plan.files) f.store.recordApplyStep(second.fence, secondJournal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ checked: file.path }) })
    const secondReceipt = f.receipt(secondJournal.id, second.plan)
    f.store.recordReceipt(secondJournal.id, secondReceipt)
    assert.equal(f.store.settleApply(secondJournal.id, secondReceipt.id).phase, 'workspace_synced')

    const reopened = openProtocol(f.path), recovered = new SyncStore(reopened, f.options)
    try {
      const latest = recovered.readBaseline(source())!
      assert.equal(latest.sourceInput.id, 'input-2')
      assert.equal(latest.receiptId, secondReceipt.id)
      assert.equal(latest.settledAtMs, 900)
      assert.equal(recovered.readBaseline(source('delivery'))?.receiptId, secondReceipt.id)
    } finally { reopened.close() }
  } finally { f.cleanup() }
})

test('cancelled verification attempt persists resource checkpoints without restoring business authority', async () => {
  const f = await fixture()
  try {
    const prepared = f.ready()
    const planned = f.put({ runId: 'verification-run', phase: 'planned' })
    const resource = f.store.planResource(prepared.fence, { key: 'verification-run', kind: 'verification', payloadDigest: 'resource-payload', inputId: prepared.operation.input.id, candidateDigest: prepared.candidate.digest, planBlob: planned, checkpointRef: planned })
    f.store.requestControl(prepared.operation.id, 'cancel')
    const created = f.put({ runId: 'verification-run', phase: 'created', containerId: 'actual-created-container' })
    assert.throws(() => f.store.checkpoint(prepared.fence, created), /SYNC_FENCE_EXPIRED/)
    const binding = { operationId: resource.operationId, attemptId: resource.attemptId, inputId: resource.plan.inputId, candidateDigest: resource.plan.candidateDigest }
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: planned, checkpointRef: created })
    assert.equal(f.store.listRecoverableResources()[0].resource.id, resource.id)
    assert.equal(f.store.listRecoverableResources()[0].operation.phase, 'cancelled')
    assert.throws(() => f.store.recordVerification(prepared.fence, prepared.verification), /SYNC_FENCE_EXPIRED/)
    assert.throws(() => f.store.beginApply(prepared.fence, prepared.plan, prepared.target), /SYNC_FENCE_EXPIRED/)
    const terminal = f.put({ runId: 'verification-run', phase: 'terminal', exitCode: 137 })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'terminal', expectedCheckpointRef: created, checkpointRef: terminal })
    const reopened = openProtocol(f.path), recovered = new SyncStore(reopened, f.options)
    try {
      assert.equal(recovered.listRecoverableResources()[0].resource.phase, 'terminal')
      const removed = f.put({ runId: 'verification-run', phase: 'removed' })
      recovered.recordResourceCheckpoint(resource.id, { ...binding, phase: 'removed', expectedCheckpointRef: terminal, checkpointRef: removed })
      assert.equal(recovered.listRecoverableResources().length, 0)
      assert.equal(recovered.readOperation(prepared.operation.id).phase, 'cancelled')
      assert.equal(recovered.readAttempt(prepared.attempt.id).status, 'superseded')
      assert.ok(recovered.pinnedBlobRefs().some(ref => ref.sha256 === terminal.sha256))
    } finally { reopened.close() }
  } finally { f.cleanup() }
})


test('resource plan binding, exact replay and checkpoint CAS protect newer same-phase evidence across handles', async () => {
  const f = await fixture(), otherProtocol = openProtocol(f.path), other = new SyncStore(otherProtocol, f.options)
  try {
    const prepared = f.ready(), planned = f.put({ runId: 'run', phase: 'planned' })
    const plan = { key: 'run', kind: 'verification' as const, payloadDigest: 'fixed-payload', inputId: prepared.operation.input.id, candidateDigest: prepared.candidate.digest, planBlob: planned, checkpointRef: planned }
    const resource = f.store.planResource(prepared.fence, plan)
    assert.equal(f.store.planResource(prepared.fence, plan).id, resource.id)
    assert.equal(other.findResource(prepared.attempt.id, 'run')?.id, resource.id)
    assert.equal(other.findResource(prepared.attempt.id, 'missing'), null)
    assert.throws(() => f.store.planResource(prepared.fence, { ...plan, payloadDigest: 'different' }), /SYNC_RESOURCE_PLAN_CONFLICT/)
    assert.throws(() => f.store.planResource(prepared.fence, { ...plan, inputId: 'different-input' }), /SYNC_RESOURCE_BINDING/)
    assert.throws(() => f.store.planResource(prepared.fence, { ...plan, candidateDigest: 'different-candidate' }), /SYNC_RESOURCE_BINDING/)
    const binding = { operationId: resource.operationId, attemptId: resource.attemptId, inputId: resource.plan.inputId, candidateDigest: resource.plan.candidateDigest }
    const created = f.put({ phase: 'created', threadId: 'thread', turnId: null })
    const updated = f.put({ phase: 'created', threadId: 'thread', turnId: 'actual-turn' })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: planned, checkpointRef: created })
    other.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: created, checkpointRef: updated })
    const lateCreated = f.put({ phase: 'created', threadId: 'thread', turnId: null, stale: true })
    assert.throws(() => f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: created, checkpointRef: lateCreated }), /SYNC_RESOURCE_CHECKPOINT_CONFLICT/)
    assert.deepEqual(f.store.readResource(resource.id).checkpointRef, updated)
    assert.deepEqual(f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: planned, checkpointRef: created }).checkpointRef, updated)
    assert.throws(() => f.store.recordResourceCheckpoint(resource.id, { ...binding, attemptId: 'different-attempt', phase: 'terminal', expectedCheckpointRef: updated, checkpointRef: f.put({ phase: 'terminal' }) }), /SYNC_RESOURCE_BINDING/)
    const terminal = f.put({ phase: 'terminal', exitCode: 0 })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'terminal', expectedCheckpointRef: updated, checkpointRef: terminal })
    const stalePlanned = f.put({ phase: 'planned', stale: true })
    assert.throws(() => other.recordResourceCheckpoint(resource.id, { ...binding, phase: 'planned', expectedCheckpointRef: terminal, checkpointRef: stalePlanned }), /SYNC_RESOURCE_PHASE_INVALID/)
    assert.equal(other.listRecoverableResources()[0].resource.phase, 'terminal')
    const removed = f.put({ phase: 'removed' })
    other.recordResourceCheckpoint(resource.id, { ...binding, phase: 'removed', expectedCheckpointRef: terminal, checkpointRef: removed })
    assert.equal(f.store.listRecoverableResources().length, 0)
    assert.deepEqual(f.store.findResource(prepared.attempt.id, 'run')?.checkpointRef, removed)
    assert.equal(f.store.planResource(prepared.fence, plan).phase, 'removed')
    assert.deepEqual(f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'terminal', expectedCheckpointRef: updated, checkpointRef: terminal }).checkpointRef, removed)
  } finally { otherProtocol.close(); f.cleanup() }
})

test('resources from superseded historical attempts remain recoverable without renewing their fence', async () => {
  const f = await fixture()
  try {
    const old = f.ready(), planned = f.put({ runId: 'old-run', phase: 'planned' })
    const resource = f.store.planResource(old.fence, { key: 'old-run', kind: 'verification', payloadDigest: 'fixed-payload', inputId: old.operation.input.id, candidateDigest: old.candidate.digest, planBlob: planned, checkpointRef: planned })
    f.tick(1001)
    const next = f.store.claimAttempt({ operationId: old.operation.id, source: old.operation.input.source, scope: old.operation.scope, leaseMs: 1000 })
    assert.equal(f.store.listRecoverable()[0].attempt?.id, next.attempt.id)
    assert.equal(f.store.listRecoverableResources()[0].attempt.id, old.attempt.id)
    const binding = { operationId: resource.operationId, attemptId: resource.attemptId, inputId: resource.plan.inputId, candidateDigest: resource.plan.candidateDigest }
    const created = f.put({ runId: 'old-run', phase: 'created', actualContainerId: 'old-container' })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'created', expectedCheckpointRef: planned, checkpointRef: created })
    assert.throws(() => f.store.planResource(old.fence, resource.plan), /SYNC_FENCE_EXPIRED/)
    assert.throws(() => f.store.recordVerification(old.fence, old.verification), /SYNC_FENCE_EXPIRED/)
    assert.throws(() => f.store.beginApply(old.fence, old.plan, old.target), /SYNC_FENCE_EXPIRED/)
    assert.equal(f.store.readOperation(old.operation.id).currentAttemptId, next.attempt.id)
    assert.equal(f.store.readOperation(old.operation.id).generation, next.operation.generation)
    assert.equal(f.store.readAttempt(old.attempt.id).status, 'superseded')
  } finally { f.cleanup() }
})

test('native resource planned before candidate freeze can terminate without creation and requires removal before capacity release', async () => {
  const f = await fixture()
  try {
    const claimed = f.claim(), planned = f.put({ sessionCreateKey: claimed.attempt.sessionCreateKey, phase: 'planned' })
    const plan = { key: 'session-request', kind: 'native_session' as const, payloadDigest: 'request-digest', inputId: claimed.operation.input.id, candidateDigest: null, planBlob: planned, checkpointRef: planned }
    assert.throws(() => f.store.planResource(claimed.fence, { ...plan, kind: 'verification' }), /SYNC_RESOURCE_BINDING/)
    const resource = f.store.planResource(claimed.fence, plan)
    f.store.requestControl(claimed.operation.id, 'cancel')
    const binding = { operationId: resource.operationId, attemptId: resource.attemptId, inputId: resource.plan.inputId, candidateDigest: null }
    assert.throws(() => f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'removed', expectedCheckpointRef: planned, checkpointRef: f.put({ phase: 'removed' }) }), /SYNC_RESOURCE_PHASE_INVALID/)
    const terminal = f.put({ phase: 'terminal', reason: 'cancelled_before_creation' })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'terminal', expectedCheckpointRef: planned, checkpointRef: terminal })
    assert.equal(f.store.listRecoverableResources()[0].resource.phase, 'terminal')
    const removed = f.put({ phase: 'removed', actualResourceAbsent: true })
    f.store.recordResourceCheckpoint(resource.id, { ...binding, phase: 'removed', expectedCheckpointRef: terminal, checkpointRef: removed })
    assert.equal(f.store.listRecoverableResources().length, 0)
    assert.equal(f.store.readOperation(claimed.operation.id).phase, 'cancelled')
  } finally { f.cleanup() }
})

test('v1 upgrade keeps active attempt and queue data, online backup restores v1, interrupted v2 DDL rolls back', async () => {
  const f = await fixture(), path = join(f.root, 'v1.sqlite'), legacy = openProtocol(path)
  let restored: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 1))
    const old = f.claim()
    legacy.initialize('existing_session')
    const message = legacy.enqueue('existing_session', { kind: 'session.text.v1', body: Buffer.from('existing durable message') })
    legacy.initialize(SYNC_COORDINATOR_ADDRESS)
    for (const table of ['protocol_messages', 'sync_operations', 'sync_attempts', 'sync_leases'] as const) {
      const rows = f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))
      legacy.withTransaction(tx => {
        for (const row of rows) {
          const columns = Object.keys(row).filter(column => column !== 'enqueue_seq')
          tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[])
        }
      })
    }
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, [SYNC_MIGRATIONS[0], { version: 2, sql: `${SYNC_MIGRATIONS[1].sql} INSERT INTO missing_resource_table VALUES(1);` }]))
    assert.equal(legacy.withTransaction(tx => tx.query("SELECT * FROM sqlite_master WHERE name='sync_resources'")).length, 0)
    assert.equal(legacy.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 1)
    const backupPath = join(f.root, 'v1-upgrade.backup')
    assert.equal(await migrateSyncStore(legacy, { backupPath }), SYNC_MIGRATIONS.length)
    const upgraded = new SyncStore(legacy, f.options)
    assert.equal(upgraded.readAttempt(old.attempt.id).id, old.attempt.id)
    assert.equal(upgraded.readOperation(old.operation.id).currentAttemptId, old.attempt.id)
    assert.equal(legacy.listPending('existing_session')[0].messageId, message.messageId)
    const planned = f.put({ phase: 'planned' })
    const resource = upgraded.planResource(old.fence, { key: 'after-upgrade', kind: 'native_session', payloadDigest: 'fixed-request', inputId: old.operation.input.id, candidateDigest: null, planBlob: planned, checkpointRef: planned })
    restored = openProtocol(backupPath)
    assert.equal(restored.listPending('existing_session')[0].messageId, message.messageId)
    assert.equal(restored.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 1)
    assert.equal(restored.withTransaction(tx => tx.query("SELECT * FROM sqlite_master WHERE name='sync_resources'")).length, 0)
    const reopened = openProtocol(path), recovered = new SyncStore(reopened, f.options)
    try {
      assert.equal(recovered.findResource(old.attempt.id, 'after-upgrade')?.id, resource.id)
      assert.equal(recovered.listRecoverableResources()[0].attempt.id, old.attempt.id)
      assert.equal(await migrateSyncStore(reopened), SYNC_MIGRATIONS.length)
    } finally { reopened.close() }
  } finally { restored?.close(); legacy.close(); f.cleanup() }
})

test('trusted elaboration expands unknown future IDs; shared file stays ready while GAP business IDs remain blocked after partial receipt', async () => {
  const f = await fixture()
  try {
    const input = f.admit(source(), 'natural-input', { paths: ['src/a.ts'], contractIds: [], flowIds: [] })
    const ids = { contractIds: ['REQ-A', 'AC-A', 'REQ-B', 'GAP-B'], flowIds: ['FLOW-A', 'FLOW-B'] }
    const readyScope = { paths: ['src/a.ts'], contractIds: ['AC-A', 'REQ-A'], flowIds: ['FLOW-A'] }
    const blockedScope = { paths: [], contractIds: ['GAP-B', 'REQ-B'], flowIds: ['FLOW-B'] }
    const evidence = f.put({ stage: 'reviewed-elaboration', inputId: input.input.id })
    const prepared = f.ready(input, readyScope, blockedScope, 'needs_input', claimed => {
      assert.throws(() => f.store.startGeneration(claimed.fence, { readyScope, blockedScope, blockedReason: 'needs_input' }), /SYNC_SCOPE_INVALID/)
      const expanded = f.store.expandContractScope(claimed.fence, ids, evidence)
      assert.deepEqual(expanded.scope, { paths: ['src/a.ts'], contractIds: ['AC-A', 'GAP-B', 'REQ-A', 'REQ-B'], flowIds: ['FLOW-A', 'FLOW-B'] })
      for (const scopes of [
        { readyScope, blockedScope: { ...blockedScope, contractIds: [...blockedScope.contractIds, 'REQ-A'] }, blockedReason: 'needs_input' as const },
        { readyScope, blockedScope: { ...blockedScope, flowIds: [...blockedScope.flowIds, 'FLOW-A'] }, blockedReason: 'needs_input' as const },
      ]) assert.throws(() => f.store.startGeneration(claimed.fence, scopes), /SYNC_SCOPE_INVALID/)
    })
    assert.throws(() => f.store.beginApply(prepared.fence, { ...prepared.plan, coveredScope: { ...readyScope, contractIds: [...readyScope.contractIds, 'REQ-B'] } }, prepared.target), /SYNC_APPLY_BINDING/)
    const before = f.store.readOperation(prepared.operation.id)
    assert.deepEqual(f.store.expandContractScope(prepared.fence, ids, evidence), before)
    assert.deepEqual(before.blockedScope, blockedScope)
    const journal = f.store.beginApply(prepared.fence, prepared.plan, prepared.target)
    for (const file of prepared.plan.files) f.store.recordApplyStep(prepared.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ observed: file.path }) })
    const receipt = f.receipt(journal.id, prepared.plan); f.store.recordReceipt(journal.id, receipt)
    const settled = f.store.settleApply(journal.id, receipt.id)
    assert.equal(settled.phase, 'needs_input'); assert.deepEqual(settled.deliveredScope, readyScope)
    assert.deepEqual(f.store.readBaseline(source())?.coveredScope, readyScope)
    assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === evidence.sha256))
  } finally { f.cleanup() }
})

test('scope expansion is canonical/idempotent, retains admission identity and budget, and survives restart/retry without reviving old fence', async () => {
  const f = await fixture()
  try {
    const input = f.admit(source(), 'natural-input', { paths: ['src/a.ts'], contractIds: [], flowIds: [] }), first = f.claim(input)
    const ids = { contractIds: ['REQ-A', 'AC-A'], flowIds: ['FLOW-A'] }, evidence = f.put({ reviewed: true })
    f.store.reserveDispatch(first.fence, { key: 'elaborate', purpose: 'elaborate', requestDigest: 'request' })
    const before = f.store.readOperation(first.operation.id), expanded = f.store.expandContractScope(first.fence, ids, evidence)
    for (const key of ['input', 'payloadDigest', 'generation', 'deadlineAtMs', 'budget', 'callsUsed', 'dispatchMessageId'] as const) assert.deepEqual(expanded[key], before[key])
    const leases = f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_leases ORDER BY resource_key'))
    assert.deepEqual(f.store.expandContractScope(first.fence, { contractIds: ['AC-A', 'REQ-A', 'REQ-A'], flowIds: ['FLOW-A'] }, evidence), expanded)
    assert.deepEqual(f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_leases ORDER BY resource_key')), leases)
    assert.deepEqual(f.store.admitAndEnqueue(input), expanded)
    const reopened = openProtocol(f.path), recovered = new SyncStore(reopened, f.options)
    try {
      assert.deepEqual(recovered.readOperation(expanded.id), expanded)
      f.tick(1001)
      const retry = recovered.claimAttempt({ operationId: expanded.id, source: input.input.source, scope: expanded.scope, leaseMs: 1000 })
      assert.deepEqual(recovered.expandContractScope(retry.fence, ids, evidence), retry.operation)
      assert.throws(() => f.store.expandContractScope(first.fence, ids, evidence), /SYNC_FENCE_EXPIRED/)
      assert.equal(retry.operation.callsUsed, 1); assert.equal(retry.operation.deadlineAtMs, before.deadlineAtMs)
      assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 0)
    } finally { reopened.close() }
  } finally { f.cleanup() }
})

test('two SQLite handles atomically acquire new ID resources; conflicting set rolls back every new lease and preserves held path', async () => {
  const f = await fixture(), secondProtocol = openProtocol(f.path), second = new SyncStore(secondProtocol, f.options)
  try {
    const first = f.claim(f.admit(source(), 'natural-input', { paths: ['src/a.ts'], contractIds: [], flowIds: [] }))
    const other = second.claimAttempt({ operationId: second.admitAndEnqueue(f.admit(source('other'), 'input-2', scope('src/b.ts', 'REQ-SHARED'))).id, source: source('other'), scope: scope('src/b.ts', 'REQ-SHARED'), leaseMs: 1000 })
    const before = f.store.readOperation(first.operation.id), leases = f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_leases ORDER BY resource_key'))
    const ids = { contractIds: ['AC-FREE', 'REQ-SHARED'], flowIds: ['FLOW-FREE'] }, evidence = f.put({ reviewed: 'conflicting-result' })
    assert.throws(() => f.store.expandContractScope(first.fence, ids, evidence), /SYNC_LEASE_CONFLICT/)
    assert.deepEqual(second.readOperation(first.operation.id), before)
    assert.deepEqual(secondProtocol.withTransaction(tx => tx.query('SELECT * FROM sync_leases ORDER BY resource_key')), leases)
    second.requestControl(other.operation.id, 'cancel')
    const expanded = f.store.expandContractScope(first.fence, ids, evidence)
    const acquired = secondProtocol.withTransaction(tx => tx.query('SELECT * FROM sync_leases WHERE token=? ORDER BY resource_key', first.fence.leaseToken))
    assert.equal(acquired.length, 4)
    assert.ok(acquired.every(row => row.attempt_id === first.attempt.id && row.expires_at_ms === first.attempt.expiresAtMs))
    assert.equal(acquired.find(row => row.resource_key === 'contract:REQ-SHARED')?.generation, 2)
    assert.equal(acquired.find(row => row.resource_key === 'path:src/a.ts')?.generation, 1)
    assert.deepEqual(second.expandContractScope(first.fence, ids, evidence), expanded)
  } finally { secondProtocol.close(); f.cleanup() }
})

test('scope expansion refuses path authority, deleting old IDs, evidence disagreement/tampering, expired fence and frozen phase', async () => {
  const f = await fixture()
  try {
    const first = f.claim(), ids = { contractIds: ['RULE-A', 'REQ-A'], flowIds: [] }, evidence = f.put({ reviewed: true })
    const initial = f.store.readOperation(first.operation.id)
    assert.throws(() => f.store.expandContractScope(first.fence, { ...ids, paths: ['src/b.ts'] } as typeof ids, evidence), /SYNC_SCOPE_INVALID/)
    assert.throws(() => f.store.expandContractScope(first.fence, { contractIds: ['REQ-A'], flowIds: [] }, evidence), /SYNC_SCOPE_INVALID/)
    assert.deepEqual(f.store.readOperation(first.operation.id), initial)
    const expanded = f.store.expandContractScope(first.fence, ids, evidence)
    assert.throws(() => f.store.expandContractScope(first.fence, { ...ids, contractIds: [...ids.contractIds, 'REQ-B'] }, evidence), /SYNC_SCOPE_EVIDENCE_CONFLICT/)
    const tampered = new SyncStore(f.protocol, { ...f.options, readBlob: () => Buffer.from('tampered evidence') })
    assert.throws(() => tampered.expandContractScope(first.fence, ids, evidence), /SYNC_BLOB_DIGEST_MISMATCH/)
    assert.deepEqual(f.store.readOperation(first.operation.id), expanded)
    f.tick(1001)
    assert.throws(() => f.store.expandContractScope(first.fence, ids, evidence), /SYNC_FENCE_EXPIRED/)
    const prepared = f.ready(f.admit(source('fresh'), 'input-frozen'))
    assert.throws(() => f.store.expandContractScope(prepared.fence, { contractIds: ['RULE-A', 'REQ-NEW'], flowIds: [] }, f.put({ reviewed: 'late' })), /SYNC_PHASE_INVALID/)
  } finally { f.cleanup() }
})

test('simultaneous SQLite processes grant a new business ID to one attempt only', async t => {
  const f = await fixture()
  try {
    const claims = ['first', 'second'].map(name => f.claim(f.admit(source(name), `input-${name}`, { paths: [`src/${name}.ts`], contractIds: [], flowIds: [] })))
    const evidenceValue = { reviewed: 'simultaneous-expansion' }, evidence = f.put(evidenceValue)
    const processes = claims.map(claimed => {
      const script = `import {openProtocol} from '@spexcode/session-protocol';
        import {SyncStore,SyncStoreError} from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
        const protocol=openProtocol(${JSON.stringify(f.path)});
        const store=new SyncStore(protocol,{now:()=>1000,readBlob:()=>Buffer.from(${JSON.stringify(JSON.stringify(evidenceValue))})});
        console.log('ready'); await new Promise(resolve=>process.stdin.once('data',resolve));
        try {store.expandContractScope(${JSON.stringify(claimed.fence)},{contractIds:['REQ-CONTENDED'],flowIds:[]},${JSON.stringify(evidence)});console.log('ok');}
        catch(error){if(!(error instanceof SyncStoreError))throw error;console.log(error.code);}
        finally{protocol.close();process.stdin.destroy();}`
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], { cwd: process.cwd(), stdio: 'pipe' })
      t.after(() => { if (child.exitCode === null) child.kill() })
      let output = '', errors = ''
      child.stderr.on('data', chunk => { errors += String(chunk) })
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) resolve() })
        child.once('error', reject); child.once('close', () => { if (!output.includes('ready\n')) reject(new Error(errors)) })
      })
      const completion = new Promise<string>((resolve, reject) => { child.once('error', reject); child.once('close', code => { if (code === 0) resolve(output.trim().split('\n').at(-1)!); else reject(new Error(errors)) }) })
      return { child, ready, completion }
    })
    await Promise.all(processes.map(entry => entry.ready))
    for (const entry of processes) entry.child.stdin.write('go\n')
    assert.deepEqual((await Promise.all(processes.map(entry => entry.completion))).sort(), ['SYNC_LEASE_CONFLICT', 'ok'])
    const holders = f.protocol.withTransaction(tx => tx.query("SELECT token,attempt_id,generation FROM sync_leases WHERE resource_key='contract:REQ-CONTENDED'"))
    assert.equal(holders.length, 1); assert.equal(holders[0].generation, 1)
    assert.equal(claims.filter(claimed => f.store.readOperation(claimed.operation.id).scope.contractIds.includes('REQ-CONTENDED')).length, 1)
    assert.ok(claims.every(claimed => f.protocol.withTransaction(tx => tx.query('SELECT token FROM sync_leases WHERE resource_key=?', `path:src/${claimed.operation.input.source.branch}.ts`))[0].token === claimed.fence.leaseToken))
  } finally { f.cleanup() }
})

test('different elaboration evidence after needs_input adds only new ready IDs and retains the existing blocked partition', async () => {
  const f = await fixture()
  try {
    const readyScope = { paths: ['src/a.ts'], contractIds: ['RULE-A'], flowIds: ['FLOW-A'] }
    const blockedScope = { paths: [], contractIds: ['RULE-B'], flowIds: ['FLOW-B'] }
    const fullScope = { paths: ['src/a.ts'], contractIds: ['RULE-A', 'RULE-B'], flowIds: ['FLOW-A', 'FLOW-B'] }
    const first = f.ready(f.admit(source(), 'partial-input', fullScope), readyScope, blockedScope, 'needs_input')
    const journal = f.store.beginApply(first.fence, first.plan, first.target)
    for (const file of first.plan.files) f.store.recordApplyStep(first.fence, journal.id, { key: file.path, status: 'completed', evidenceRef: f.put({ observed: file.path }) })
    const receipt = f.receipt(journal.id, first.plan); f.store.recordReceipt(journal.id, receipt)
    const partial = f.store.settleApply(journal.id, receipt.id)
    assert.equal(partial.phase, 'needs_input')
    const next = f.store.claimAttempt({ operationId: partial.id, source: partial.input.source, scope: partial.readyScope, leaseMs: 1000 })
    const expanded = f.store.expandContractScope(next.fence, { contractIds: [...fullScope.contractIds, 'REQ-NEW'], flowIds: [...fullScope.flowIds, 'FLOW-NEW'] }, f.put({ reviewed: 'new-proof' }))
    assert.deepEqual(expanded.blockedScope, blockedScope)
    assert.deepEqual(expanded.readyScope, { paths: ['src/a.ts'], contractIds: ['REQ-NEW', 'RULE-A'], flowIds: ['FLOW-A', 'FLOW-NEW'] })
    assert.equal(expanded.blockedReason, 'needs_input')
  } finally { f.cleanup() }
})
