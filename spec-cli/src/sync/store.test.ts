import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyComponentMigrations, openProtocol } from '@spexcode/session-protocol'
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
  const ready = (value = admit(), readyScope = value.scope, blockedScope: SyncScope = { paths: [], contractIds: [], flowIds: [] }, blockedReason: 'needs_input' | 'conflicted' | null = null) => {
    const claimed = claim(value), target = { ...input(source('delivery'), 'target'), manifestBlob: put({ version: 1, entries: readyScope.paths.map(path => ({ path, mode: '100644', oid: 'a'.repeat(40), digest: '1'.repeat(64) })) }) }
    store.bindDelivery(claimed.fence, target.source)
    store.bindComposedInput(claimed.fence, { sourceInputId: value.input.id, previousBaselinePairId: value.previousBaselinePair?.id ?? null, tree: value.input.immutableTree, manifestBlob: target.manifestBlob, contentDigest: value.input.contentDigest })
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
  const receipt = (journalId: string, plan: ApplyPlan): ApplyReceipt => ({ id: `receipt-${journalId}`, journalId, effectKey: plan.effectKey, actualTree: 'f'.repeat(40), actualCommit: '3'.repeat(40), deliverySnapshot: { ...input(source('delivery'), `delivered-${journalId}`), immutableTree: 'f'.repeat(40) }, evidenceRefs: [put({ bytesChecked: true })], completedAtMs: time })
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
    assert.throws(() => f.store.admitAndEnqueue({ ...input, ingressKey: 'another-event-key', policyDigest: 'changed' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(f.protocol.listPending(SYNC_COORDINATOR_ADDRESS).length, 1)
  } finally { f.cleanup() }
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
    f.protocol.withTransaction(tx => tx.exec('INSERT INTO schema_migrations(component,version,checksum,applied_at_ms) VALUES(?,?,?,?)', SYNC_COMPONENT, 2, 'future', 1000))
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
