import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { migrateSyncStore, SYNC_COMPONENT, SYNC_MIGRATIONS } from './migrations.js'
import type { AdmitSyncInput, ApplyFilePlan, ApplyPlan, ApplyReceipt, BlobRef, CandidateRef, ClaimedAttempt, InputSnapshot, SyncScope, VerificationRef, VerificationResultBlob, WorktreeIdentity } from './operation-types.js'
import { captureInputSnapshot, readEvidence } from './snapshot.js'
import { prepareControlledDecision, prepareControlledRequest } from './request-input.js'
import { SyncStore, SYNC_COORDINATOR_ADDRESS, syncCoordinatorAddress } from './store.js'

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
  const ready = (value = admit(), readyScope = value.scope, blockedScope: SyncScope = { paths: [], contractIds: [], flowIds: [] }, blockedReason: 'needs_input' | 'conflicted' | null = null, beforeGeneration?: (claimed: ClaimedAttempt) => void, verificationMetadata: Pick<VerificationResultBlob, 'retiredIds' | 'decisionRefs'> = {}) => {
    const claimed = claim(value), target = { ...input(value.deliveryPlan.canonicalRoot === value.input.source.canonicalRoot ? value.input.source : source('delivery'), 'target'), manifestBlob: put({ version: 1, entries: readyScope.paths.map(path => ({ path, mode: '100644', oid: 'a'.repeat(40), digest: '1'.repeat(64) })) }) }
    store.bindDelivery(claimed.fence, target.source)
    store.bindComposedInput(claimed.fence, { sourceInputId: value.input.id, previousBaselinePairId: value.previousBaselinePair?.id ?? null, tree: value.input.immutableTree, manifestBlob: target.manifestBlob, contentDigest: value.input.contentDigest, ...(value.requestBlob ? { requestBlob: value.requestBlob } : {}) })
    beforeGeneration?.(claimed)
    store.startGeneration(claimed.fence, { readyScope, blockedScope, blockedReason })
    const files: ApplyFilePlan[] = readyScope.paths.map(path => ({ path, preDigest: '1'.repeat(64), postDigest: '2'.repeat(64), preMode: '100644', postMode: '100644' }))
    const candidate: CandidateRef = { baseTree: value.input.immutableTree, sourceInputId: value.input.id, tree: 'f'.repeat(40), digest: 'candidate', manifestBlob: put({ version: 1, entries: readyScope.paths.map(path => ({ path, mode: '100644', oid: 'b'.repeat(40), digest: '2'.repeat(64) })) }), actualDiffBlob: put(files), coveredScope: readyScope }
    store.freezeCandidate(claimed.fence, candidate)
    const evidence = put({ observed: 'layer evidence' })
    const bindings = { inputId: value.input.id, candidateDigest: candidate.digest, policyDigest: value.policyDigest, readSetDigest: value.readSetDigest, environmentDigest: 'env', contextDigest: 'context' }
    const result: VerificationResultBlob = { schemaVersion: 1, coveredScope: readyScope, ...bindings, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })), ...verificationMetadata }
    const verification: VerificationRef = { ...bindings, passed: true, coveredScope: readyScope, evidenceRefs: [evidence], resultBlob: put(result) }
    store.recordVerification(claimed.fence, verification)
    const plan: ApplyPlan = { effectKey: `effect-${claimed.operation.id}`, payloadDigest: 'apply-digest', candidateDigest: candidate.digest, verificationBlob: verification.resultBlob, target: target.source, expectedTargetSnapshotId: target.id, expectedBaselinePairId: value.previousBaselinePair?.id ?? null, coveredScope: readyScope, files, planBlob: put({ files, candidateDigest: candidate.digest }) }
    return { ...claimed, target, candidate, verification, plan }
  }
  const controlled = async (requestId = 'edit-A', replacement = '新的明确需求', intent = '保留原用户意图'): Promise<{ input: InputSnapshot; requestBlob: BlobRef }> => {
    const sourceRoot = join(root, 'source'), path = '.spec/demo/spec.md', text = '---\ntitle: Demo\nstatus: pending\n---\n# 原始需求\n'
    if (!existsSync(sourceRoot)) {
      mkdirSync(join(sourceRoot, '.spec/demo'), { recursive: true }); writeFileSync(join(sourceRoot, path), text)
      const git = (args: string[]): void => { execFileSync('git', ['-C', sourceRoot, ...args], { stdio: 'pipe' }) }
      git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['add', '.']); git(['commit', '-qm', 'fixture'])
    }
    const snapshot = await captureInputSnapshot(sourceRoot)
    const prepared = prepareControlledRequest(snapshot, { path, source: text, next: text.replace('原始需求', replacement), changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId, nodeId: 'demo', intent })
    assert.ok(prepared.changed)
    for (const ref of [snapshot.manifestBlob, prepared.requestBlob]) blobs.set(ref.sha256, readEvidence(snapshot.source.commonDir, ref))
    return { input: snapshot, requestBlob: prepared.requestBlob }
  }
  const receipt = (journalId: string, plan: ApplyPlan): ApplyReceipt => ({ id: `receipt-${journalId}`, journalId, effectKey: plan.effectKey, actualTree: 'f'.repeat(40), actualCommit: '3'.repeat(40), deliverySnapshot: { ...input(store.readJournal(journalId).plan.target, `delivered-${journalId}`), immutableTree: 'f'.repeat(40), manifestBlob: store.readAttempt(store.readJournal(journalId).attemptId).candidate!.manifestBlob }, evidenceRefs: [put({ bytesChecked: true })], completedAtMs: time })
  return { root, path, protocol, store, options, put, input, admit, claim, ready, receipt, controlled, blobs, tick: (ms: number) => { time += ms }, cleanup: () => { protocol.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('same stable admission and capture-time replay create one operation and protocol message; conflict rolls back', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), first = f.store.admitAndEnqueue(input)
    const second = f.store.admitAndEnqueue({ ...input, input: { ...input.input, capturedAtMs: 9000 } })
    assert.equal(first.id, second.id)
    assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 1)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, policyDigest: 'different' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(f.store.readOperation(first.id).policyDigest, 'policy')
    const third = f.store.admitAndEnqueue({ ...input, ingressKey: 'another-event-key' })
    assert.equal(first.id, third.id)
    assert.equal(f.store.findOperationByIngressKey(input.ingressKey)?.id, first.id)
    assert.equal(f.store.findOperationByIngressKey('another-event-key')?.id, first.id)
    assert.equal(f.store.findOperationByIngressKey('unknown-key'), null)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, ingressKey: 'another-event-key', policyDigest: 'changed' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 1)
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
    const request = await f.controlled(), input = { ...f.admit(request.input.source), input: request.input }, requestBlob = request.requestBlob
    const first = f.store.admitAndEnqueue({ ...input, requestBlob })
    assert.deepEqual(first.input, input.input)
    assert.deepEqual(first.requestBlob, requestBlob)
    assert.equal(f.store.admitAndEnqueue({ ...input, requestBlob }).id, first.id)
    assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === requestBlob.sha256))
    const changedRequest = (await f.controlled('edit-B', '后续用户修改')).requestBlob
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
    assert.deepEqual(f.store.listAttempts(r.operation.id).map(attempt => attempt.id), [r.attempt.id])
    assert.deepEqual(f.store.listAttempts(other.id), [])
    assert.throws(() => f.store.listAttempts('unknown'), /SYNC_OPERATION_UNKNOWN/)
  } finally { f.cleanup() }
})

test('resume after an applying pause and settled receipt restores actual delivery phase without a new attempt or budget', async () => {
  for (const partial of [false, true]) {
    const f = await fixture()
    try {
      const value = f.admit(), ready = partial ? { ...value.scope, contractIds: [] } : value.scope
      const r = f.ready(value, ready, partial ? { paths: [], contractIds: value.scope.contractIds, flowIds: [] } : { paths: [], contractIds: [], flowIds: [] }, partial ? 'needs_input' : null)
      const journal = f.store.beginApply(r.fence, r.plan, r.target)
      f.store.requestControl(r.operation.id, 'pause')
      for (const step of journal.steps) f.store.recordApplyStep(r.fence, journal.id, { ...step, status: 'completed' })
      const receipt = f.receipt(journal.id, r.plan)
      f.store.recordReceipt(journal.id, receipt)
      assert.equal(f.store.settleApply(journal.id, receipt.id).phase, 'paused')
      const before = f.store.readOperation(r.operation.id), after = f.store.requestControl(r.operation.id, 'run')
      assert.equal(after.phase, partial ? 'needs_input' : 'workspace_synced')
      assert.equal(after.currentAttemptId, before.currentAttemptId); assert.equal(after.generation, before.generation)
      assert.equal(after.callsUsed, before.callsUsed); assert.equal(after.deadlineAtMs, before.deadlineAtMs)
      assert.equal(f.store.readAttempt(r.attempt.id).status, 'settled')
      assert.deepEqual(f.store.listJournals(r.operation.id)[0].receipt, receipt)
    } finally { f.cleanup() }
  }
})

test('v2 upgrade preserves requestless dedup identity and backs up the old component version', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v2.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 2))
    legacy.initialize(SYNC_COORDINATOR_ADDRESS)
    legacy.initialize(syncCoordinatorAddress('repo'))
    const input = f.admit(), old = f.store.admitAndEnqueue(input)
    for (const table of ['protocol_messages', 'sync_operations'] as const) {
      const rows = f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))
      legacy.withTransaction(tx => {
        for (const row of rows) {
          const columns = Object.keys(row).filter(column => column !== 'enqueue_seq' && column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
          tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[])
        }
      })
    }
    assert.throws(() => new SyncStore(legacy, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    const path = join(f.root, 'v2-backup.sqlite')
    assert.equal(await migrateSyncStore(legacy, { backupPath: path }), SYNC_MIGRATIONS.length)
    const upgraded = new SyncStore(legacy, f.options)
    assert.equal(upgraded.admitAndEnqueue(input).id, old.id)
    assert.equal(upgraded.readOperation(old.id).payloadDigest, old.payloadDigest)
    backup = openProtocol(path)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 2)
    assert.equal(backup.listPending(syncCoordinatorAddress('repo')).length, 1)
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('v3 upgrade backs up and preserves planless identity, v4 plans are hash-bound and pinned before dispatch', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v3.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 3))
    legacy.initialize(SYNC_COORDINATOR_ADDRESS)
    legacy.initialize(syncCoordinatorAddress('repo'))
    const input = f.admit(), old = f.store.admitAndEnqueue(input)
    for (const table of ['protocol_messages', 'sync_operations'] as const) for (const row of f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))) {
      const columns = Object.keys(row).filter(column => column !== 'enqueue_seq' && column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
      legacy.withTransaction(tx => tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    }
    assert.throws(() => new SyncStore(legacy, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    const path = join(f.root, 'v3-backup.sqlite')
    assert.equal(await migrateSyncStore(legacy, { backupPath: path }), SYNC_MIGRATIONS.length)
    const upgraded = new SyncStore(legacy, f.options)
    assert.equal(upgraded.admitAndEnqueue(input).payloadDigest, old.payloadDigest)
    assert.equal(upgraded.readOperation(old.id).planBlob, undefined)
    backup = openProtocol(path)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 3)
    assert.equal(backup.listPending(syncCoordinatorAddress('repo')).length, 1)
    const planBlob = f.put({ version: 'trusted-plan', readPaths: ['src'] })
    const planned = { ...f.admit(source('planned')), planBlob, policyDigest: planBlob.sha256 }
    const operation = upgraded.admitAndEnqueue(planned)
    assert.equal(operation.phase, 'queued'); assert.deepEqual(operation.planBlob, planBlob)
    assert.ok(upgraded.pinnedBlobRefs().some(ref => ref.sha256 === planBlob.sha256))
    assert.equal(upgraded.admitAndEnqueue(planned).id, operation.id)
    assert.throws(() => upgraded.admitAndEnqueue({ ...planned, policyDigest: 'different' }), /SYNC_PLAN_BINDING/)
    assert.throws(() => new SyncStore(legacy, { ...f.options, readBlob: () => Buffer.from('changed bytes') }).admitAndEnqueue(planned), /SYNC_BLOB_DIGEST_MISMATCH/)
    const reopened = openProtocol(legacy.databasePath)
    try { assert.deepEqual(new SyncStore(reopened, f.options).readOperation(operation.id).planBlob, planBlob); assert.equal(await migrateSyncStore(reopened), SYNC_MIGRATIONS.length) } finally { reopened.close() }
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('claim exact message and all leases are one transaction, native dispatch budget is atomic', async () => {
  const f = await fixture()
  try {
    const operation = f.store.admitAndEnqueue(f.admit())
    assert.throws(() => f.store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 1000, expectedMessageId: 'wrong' }), /SYNC_DISPATCH_MISMATCH/)
    assert.equal(f.store.readOperation(operation.id).currentAttemptId, null)
    const claimed = f.store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 1000, expectedMessageId: operation.dispatchMessageId })
    assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 0)
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

test('claim skips stopped FIFO heads in the same transaction while preserving every valid queued dispatch', async () => {
  const f = await fixture()
  try {
    const older = f.store.admitAndEnqueue(f.admit()), latest = f.store.admitAndEnqueue(f.admit(source(), 'input-latest'))
    assert.equal(f.store.readOperation(older.id).phase, 'superseded')
    assert.equal(f.store.nextDispatch('repo')!.messageId, older.dispatchMessageId)
    assert.equal(f.store.nextDispatch('repo')!.envelope.operationId, older.id)
    assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 2)
    const claimed = f.store.claimAttempt({ operationId: latest.id, source: latest.input.source, scope: latest.scope, leaseMs: 1000, expectedMessageId: latest.dispatchMessageId })
    assert.equal(claimed.operation.id, latest.id); assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 0)
    assert.equal(f.store.nextDispatch('repo'), null)
    const stopped = f.store.admitAndEnqueue(f.admit(source('stopped'), 'input-stop', scope('stop.ts', 'RULE-Z')))
    f.store.requestControl(stopped.id, 'pause')
    const before = f.store.admitAndEnqueue(f.admit(source('independent-a'), 'input-a', scope('a.ts', 'RULE-X'))), after = f.store.admitAndEnqueue(f.admit(source('independent-b'), 'input-b', scope('b.ts', 'RULE-Y')))
    assert.throws(() => f.store.claimAttempt({ operationId: after.id, source: after.input.source, scope: after.scope, leaseMs: 1000, expectedMessageId: after.dispatchMessageId }))
    assert.equal(f.store.readOperation(after.id).currentAttemptId, null)
    assert.deepEqual(f.protocol.listPending(syncCoordinatorAddress('repo')).map(message => message.messageId), [stopped.dispatchMessageId, before.dispatchMessageId, after.dispatchMessageId])
    assert.equal(f.store.nextDispatch('repo')!.operation.id, stopped.id)
    f.store.claimAttempt({ operationId: before.id, source: before.input.source, scope: before.scope, leaseMs: 1000, expectedMessageId: before.dispatchMessageId })
    assert.equal(f.store.nextDispatch('repo')!.operation.id, after.id)
    f.store.requestControl(stopped.id, 'run')
    assert.throws(() => f.store.claimAttempt({ operationId: stopped.id, source: stopped.input.source, scope: stopped.scope, leaseMs: 1000, expectedMessageId: stopped.dispatchMessageId }), /SYNC_DISPATCH_WAITING/)
    assert.equal(f.store.readOperation(stopped.id).currentAttemptId, null)
    assert.equal(f.store.nextDispatch('repo')!.operation.id, after.id)
    f.store.claimAttempt({ operationId: after.id, source: after.input.source, scope: after.scope, leaseMs: 1000, expectedMessageId: after.dispatchMessageId })
    const resumed = f.store.claimAttempt({ operationId: stopped.id, source: stopped.input.source, scope: stopped.scope, leaseMs: 1000, expectedMessageId: stopped.dispatchMessageId })
    assert.equal(resumed.attempt.number, 1)
    assert.equal(f.store.nextDispatch('repo'), null)
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
    assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 0)
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
    legacy.initialize(syncCoordinatorAddress('repo'))
    for (const table of ['protocol_messages', 'sync_operations', 'sync_attempts', 'sync_leases'] as const) {
      const rows = f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))
      legacy.withTransaction(tx => {
        for (const row of rows) {
          const columns = Object.keys(row).filter(column => column !== 'enqueue_seq' && column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
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
      assert.equal(f.protocol.listPending(syncCoordinatorAddress('repo')).length, 0)
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

test('origin belongs to admission identity: same ingress refuses another origin and same input never coalesces across origins', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), first = f.store.admitAndEnqueue(input)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, retryOf: '' }), /SYNC_RETRY_BINDING/)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, origin: 'code' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    const initial = f.store.admitAndEnqueue({ ...input, ingressKey: 'initial-ingress', origin: 'initial' })
    assert.notEqual(first.id, initial.id); assert.notEqual(first.payloadDigest, initial.payloadDigest)
    assert.equal(f.store.admitAndEnqueue({ ...input, ingressKey: 'initial-alias', origin: 'initial' }).id, initial.id)
    assert.throws(() => f.store.admitAndEnqueue({ ...input, ingressKey: 'initial-alias' }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { f.cleanup() }
})

test('repository scoped FIFO has real independent addresses while same-repository worktrees cannot skip heads', async () => {
  const f = await fixture(), other = openProtocol(f.path)
  try {
    const first = f.store.admitAndEnqueue(f.admit(source('first'))), second = f.store.admitAndEnqueue(f.admit(source('second')))
    const separateInput = f.admit({ ...source('other'), repositoryId: 'other-repo' }), separate = new SyncStore(other, f.options).admitAndEnqueue(separateInput)
    assert.equal(f.store.nextDispatch('repo')?.operation.id, first.id)
    assert.equal(f.store.nextDispatch('other-repo')?.operation.id, separate.id)
    const third = new SyncStore(other, f.options).claimAttempt({ operationId: separate.id, source: separateInput.input.source, scope: separateInput.scope, leaseMs: 1000, expectedMessageId: separate.dispatchMessageId })
    assert.equal(third.operation.id, separate.id)
    assert.equal(f.store.nextDispatch('repo')?.operation.id, first.id)
    assert.throws(() => f.store.claimAttempt({ operationId: second.id, source: second.input.source, scope: second.scope, leaseMs: 1000, expectedMessageId: second.dispatchMessageId }), { code: 'PROTOCOL_CURSOR_INVALID' })
    assert.equal(f.store.readOperation(second.id).currentAttemptId, null)
  } finally { other.close(); f.cleanup() }
})

test('v4 to v5 routing is backed up and atomic, preserves old admission digests/history and reopens without duplicate dispatch', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v4.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 4))
    legacy.initialize(SYNC_COORDINATOR_ADDRESS)
    const inputs = [f.admit(source('one')), f.admit({ ...source('other'), repositoryId: 'other-repo' }), f.admit(source('two'))]
    const oldOperations = inputs.map(input => {
      const current = f.store.admitAndEnqueue(input), { capturedAtMs: _capture, ...stableInput } = input.input
      void _capture
      const payload = { input: stableInput, scope: input.scope, policyDigest: input.policyDigest, impactDigest: input.impactDigest, readSetDigest: input.readSetDigest, deliveryPlan: input.deliveryPlan, previousBaselinePairId: null, budget: input.budget }
      const hash = createHash('sha256').update(JSON.stringify(payload, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
      const envelope = { version: 1, type: 'sync.dispatch', operationId: current.id, inputId: current.input.id, generation: current.generation, dispatchKey: `sync-dispatch-${current.id}-${current.generation}` }
      const message = legacy.enqueue(SYNC_COORDINATOR_ADDRESS, { kind: 'sync.dispatch.v1', body: Buffer.from(JSON.stringify(envelope)), idempotencyKey: envelope.dispatchKey })
      const old = { ...current, payloadDigest: hash, dispatchMessageId: message.messageId }
      const row = f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_operations WHERE id=?', current.id))[0]
      row.payload_digest = hash; row.record_json = JSON.stringify(old)
      const columns = Object.keys(row).filter(column => column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
      legacy.withTransaction(tx => tx.exec(`INSERT INTO sync_operations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
      return old
    })
    assert.throws(() => new SyncStore(legacy, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    const migration = SYNC_MIGRATIONS[4]
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, [...SYNC_MIGRATIONS.slice(0, 4), { ...migration, afterApply: { key: migration.afterApply!.key, run(tx) { migration.afterApply!.run(tx); throw new Error('route-interrupted') } } }]), /route-interrupted/)
    assert.equal(legacy.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 4)
    assert.deepEqual(legacy.listPending(SYNC_COORDINATOR_ADDRESS).map(row => row.messageId), oldOperations.map(op => op.dispatchMessageId))
    assert.equal(legacy.withTransaction(tx => tx.query('SELECT record_json FROM sync_operations WHERE id=?', oldOperations[0].id))[0].record_json, JSON.stringify(oldOperations[0]))
    const backupPath = join(f.root, 'v4-backup.sqlite')
    assert.equal(await migrateSyncStore(legacy, { backupPath }), SYNC_MIGRATIONS.length)
    backup = openProtocol(backupPath)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 4)
    assert.deepEqual(backup.listPending(SYNC_COORDINATOR_ADDRESS).map(row => row.messageId), oldOperations.map(op => op.dispatchMessageId))
    assert.equal(legacy.listPending(SYNC_COORDINATOR_ADDRESS).length, 0)
    assert.deepEqual(legacy.readMessages(SYNC_COORDINATOR_ADDRESS).map(row => row.messageId), oldOperations.map(op => op.dispatchMessageId))
    const upgraded = new SyncStore(legacy, f.options)
    assert.deepEqual(legacy.listPending(syncCoordinatorAddress('repo')).map(row => JSON.parse(Buffer.from(row.body).toString()).operationId), [oldOperations[0].id, oldOperations[2].id])
    assert.equal(upgraded.nextDispatch('other-repo')?.operation.id, oldOperations[1].id)
    assert.equal(upgraded.admitAndEnqueue(inputs[0]).id, oldOperations[0].id)
    assert.equal(upgraded.admitAndEnqueue({ ...inputs[0], ingressKey: 'legacy-alias' }).payloadDigest, oldOperations[0].payloadDigest)
    assert.throws(() => upgraded.admitAndEnqueue({ ...inputs[0], origin: 'code' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 4)), { code: 'PROTOCOL_SCHEMA_GENERATION_UNSUPPORTED' })
    const reopened = openProtocol(legacy.databasePath)
    try {
      assert.equal(await migrateSyncStore(reopened), SYNC_MIGRATIONS.length)
      assert.equal(reopened.listPending(syncCoordinatorAddress('repo')).length, 2)
      assert.equal(new SyncStore(reopened, f.options).readOperation(oldOperations[0].id).payloadDigest, oldOperations[0].payloadDigest)
    } finally { reopened.close() }
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('explicit user retry receives a fresh operation and budget while automatic replay retains the old terminal identity', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), claimed = f.claim(input)
    f.store.recordFailure(claimed.fence, { code: 'model_failed', kind: 'environment', message: '真实已结束错误', evidenceRefs: [] })
    const previous = f.store.readOperation(claimed.operation.id)
    assert.equal(f.store.admitAndEnqueue(input).id, previous.id)
    assert.deepEqual(f.store.readRetryEligibility(previous.id), { eligible: true })
    const retryInput = { ...input, retryOf: previous.id, ingressKey: 'user-retry-1', rootCauseId: 'user-retry-1', budget: { ...input.budget, maxCalls: 20 }, deliveryPlan: { ...input.deliveryPlan, canonicalRoot: '/repo/retry-delivery', branch: 'retry-delivery' } }
    const retry = f.store.admitAndEnqueue(retryInput)
    assert.notEqual(retry.id, previous.id); assert.equal(retry.retryOf, previous.id); assert.equal(retry.callsUsed, 0)
    assert.equal(retry.budget.maxCalls, 20); assert.equal(f.store.readOperation(previous.id).phase, 'failed')
    assert.deepEqual(f.store.readOperation(previous.id), previous)
    assert.equal(f.store.admitAndEnqueue(retryInput).id, retry.id)
    assert.throws(() => f.store.admitAndEnqueue({ ...retryInput, budget: { ...retryInput.budget, maxCalls: 21 } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    for (const changed of [{ origin: 'initial' as const }, { policyDigest: 'changed' }, { requestBlob: f.put({ changed: 'lost original request' }) }, { input: { ...input.input, id: 'different' } }, { scope: { ...input.scope, paths: ['src', 'extra'] } }]) assert.throws(() => f.store.admitAndEnqueue({ ...retryInput, ...changed, ingressKey: `new-${Object.keys(changed)[0]}` }), /SYNC_RETRY_BINDING/)
  } finally { f.cleanup() }
})

test('retry gating uses historical resource settlement and immutable controlled request bytes', async () => {
  const f = await fixture()
  try {
    const request = await f.controlled(), input = { ...f.admit(request.input.source), ...request }, claimed = f.claim(input), planned = f.put({ phase: 'planned' })
    const resource = f.store.planResource(claimed.fence, { key: 'native-retry', kind: 'native_session', inputId: input.input.id, candidateDigest: null, payloadDigest: 'same-request', planBlob: planned, checkpointRef: planned })
    f.store.recordFailure(claimed.fence, { code: 'native_failed', kind: 'environment', message: '终态回执尚未完整持久', evidenceRefs: [] })
    const retry = { ...input, retryOf: claimed.operation.id, ingressKey: 'retry-native', rootCauseId: 'retry-native' }
    assert.equal(f.store.readRetryEligibility(claimed.operation.id).reason!.code, 'SYNC_RETRY_RESOURCE_PENDING')
    assert.throws(() => f.store.admitAndEnqueue(retry), /SYNC_RETRY_RESOURCE_PENDING/)
    const terminal = f.put({ phase: 'terminal' }), removed = f.put({ phase: 'removed' })
    f.store.recordResourceCheckpoint(resource.id, { operationId: claimed.operation.id, attemptId: claimed.attempt.id, inputId: input.input.id, candidateDigest: null, expectedCheckpointRef: planned, phase: 'terminal', checkpointRef: terminal })
    assert.equal(f.store.readRetryEligibility(claimed.operation.id).eligible, false)
    f.store.recordResourceCheckpoint(resource.id, { operationId: claimed.operation.id, attemptId: claimed.attempt.id, inputId: input.input.id, candidateDigest: null, expectedCheckpointRef: terminal, phase: 'removed', checkpointRef: removed })
    assert.equal(f.store.readRetryEligibility(claimed.operation.id).eligible, true)
    assert.throws(() => f.store.admitAndEnqueue({ ...retry, requestBlob: undefined }), /SYNC_RETRY_BINDING/)
    const next = f.store.admitAndEnqueue(retry)
    assert.deepEqual(next.requestBlob, input.requestBlob); assert.equal(f.store.admitAndEnqueue(input).id, claimed.operation.id)
  } finally { f.cleanup() }
})

test('budget-exhausted pending FIFO can yield to explicit retry; cancelled without receipt can retry but real delivery cannot', async () => {
  const f = await fixture()
  try {
    const input = f.admit(), old = f.store.admitAndEnqueue(input)
    f.tick(input.budget.timeoutMs + 1); f.store.recordBudgetExhaustion(old.id)
    const retry = f.store.admitAndEnqueue({ ...input, retryOf: old.id, ingressKey: 'budget-retry', rootCauseId: 'budget-retry' })
    assert.equal(f.store.nextDispatch('repo')!.operation.id, old.id)
    assert.equal(f.store.claimAttempt({ operationId: retry.id, source: retry.input.source, scope: retry.scope, leaseMs: 1000, expectedMessageId: retry.dispatchMessageId }).operation.id, retry.id)
    assert.equal(f.store.readOperation(old.id).phase, 'budget_exhausted')
    assert.equal(f.store.readRetryEligibility(retry.id).reason!.code, 'SYNC_RETRY_PHASE')
    f.store.requestControl(retry.id, 'cancel')
    assert.equal(f.store.readRetryEligibility(retry.id).eligible, true)
    const r = f.ready(f.admit(source('delivered-cancel'))), journal = f.store.beginApply(r.fence, r.plan, r.target)
    assert.equal(f.store.readRetryEligibility(r.operation.id).eligible, false)
    f.store.requestControl(r.operation.id, 'cancel')
    for (const step of journal.steps) f.store.recordApplyStep(r.fence, journal.id, { ...step, status: 'completed' })
    const receipt = f.receipt(journal.id, r.plan); f.store.recordReceipt(journal.id, receipt); f.store.settleApply(journal.id, receipt.id)
    assert.equal(f.store.readRetryEligibility(r.operation.id).reason!.code, 'SYNC_RETRY_DELIVERED')
    assert.throws(() => f.store.admitAndEnqueue({ ...f.admit(source('delivered-cancel')), retryOf: r.operation.id, ingressKey: 'no-repeat', rootCauseId: 'no-repeat' }), /SYNC_RETRY_DELIVERED/)
  } finally { f.cleanup() }
})

test('v5 to v6 backs up the original marker and refuses older writers without rewriting legacy operation identity', async () => {
  const f = await fixture(), previous = openProtocol(join(f.root, 'v5.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(previous, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 5))
    const input = f.admit(), admitted = f.store.admitAndEnqueue(input)
    previous.initialize(syncCoordinatorAddress('repo'))
    const message = previous.enqueue(syncCoordinatorAddress('repo'), { kind: 'sync.dispatch.v1', body: Buffer.from(JSON.stringify({ version: 1, type: 'sync.dispatch', operationId: admitted.id, inputId: admitted.input.id, generation: admitted.generation, dispatchKey: `sync-dispatch-${admitted.id}-${admitted.generation}` })), idempotencyKey: `sync-dispatch-${admitted.id}-${admitted.generation}` })
    const original = { ...admitted, dispatchMessageId: message.messageId }, row = f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_operations WHERE id=?', admitted.id))[0]
    row.record_json = JSON.stringify(original)
    const columns = Object.keys(row).filter(column => column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
    previous.withTransaction(tx => tx.exec(`INSERT INTO sync_operations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    const migration = SYNC_MIGRATIONS[5]
    assert.throws(() => applyComponentMigrations(previous, SYNC_COMPONENT, [...SYNC_MIGRATIONS.slice(0, 5), { ...migration, afterApply: { key: migration.afterApply!.key, run(tx) { migration.afterApply!.run(tx); throw new Error('semantic-backfill-interrupted') } } }]), /semantic-backfill-interrupted/)
    assert.ok(!previous.withTransaction(tx => tx.query('PRAGMA table_info(sync_operations)')).some(column => column.name === 'semantic_digest'))
    assert.equal(previous.listPending(syncCoordinatorAddress('repo'))[0].messageId, message.messageId)
    const backupPath = join(f.root, 'v5-backup.sqlite')
    assert.throws(() => new SyncStore(previous, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    assert.equal(await migrateSyncStore(previous, { backupPath }), SYNC_MIGRATIONS.length)
    assert.throws(() => applyComponentMigrations(previous, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 5)), { code: 'PROTOCOL_SCHEMA_GENERATION_UNSUPPORTED' })
    backup = openProtocol(backupPath)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 5)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT record_json FROM sync_operations WHERE id=?', original.id))[0].record_json, JSON.stringify(original))
    const upgraded = new SyncStore(previous, f.options)
    assert.deepEqual(upgraded.readOperation(original.id), original)
    assert.equal(upgraded.admitAndEnqueue({ ...input, ingressKey: 'new-auto-allocation', budget: { ...input.budget, maxCalls: 99 }, readSetDigest: 'advanced-composed-readset', impactDigest: 'advanced-baseline-impact', deliveryPlan: { ...input.deliveryPlan, canonicalRoot: '/repo/new-auto-allocation', branch: 'new-auto-allocation' } }).id, original.id)
    assert.equal(upgraded.readOperation(original.id).payloadDigest, original.payloadDigest)
    assert.equal(await migrateSyncStore(previous), SYNC_MIGRATIONS.length)
  } finally { backup?.close(); previous.close(); f.cleanup() }
})

test('canonical controlled intent retains one operation and budget with exact per-ingress receipts and pinned provenance', async () => {
  const f = await fixture()
  try {
    const a = await f.controlled('ordinary-A'), b = await f.controlled('ordinary-B')
    const admission = { ...f.admit(a.input.source), ...a, ingressKey: 'ordinary-A' }, claimed = f.claim(admission)
    f.store.reserveDispatch(claimed.fence, { key: 'model-1', purpose: 'elaborate', requestDigest: 'request' })
    f.store.recordFailure(claimed.fence, { code: 'unsupported', kind: 'environment', message: '已结束失败', evidenceRefs: [] })
    const original = f.store.readOperation(claimed.operation.id)
    f.tick(1000)
    const alias = { ...admission, ...b, ingressKey: 'ordinary-B', rootCauseId: 'ordinary-B', budget: { ...admission.budget, maxCalls: 99 }, deliveryPlan: { ...admission.deliveryPlan, canonicalRoot: '/repo/alias-B', branch: 'alias-B' } }
    assert.equal(f.store.admitAndEnqueue(alias).id, original.id)
    assert.equal(f.store.admitAndEnqueue(alias).id, original.id)
    assert.deepEqual(f.store.readOperation(original.id), original)
    const receipt = f.store.findIngressReceipt(alias.ingressKey)!
    assert.deepEqual(receipt.requestBlob, b.requestBlob); assert.deepEqual(receipt.deliveryPlan, alias.deliveryPlan)
    assert.notEqual(receipt.requestBlob!.sha256, original.requestBlob!.sha256)
    assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === b.requestBlob.sha256))
    assert.throws(() => f.store.admitAndEnqueue({ ...alias, budget: { ...alias.budget, maxCalls: 100 } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    const changed = await f.controlled('ordinary-B', '不同正文')
    assert.throws(() => f.store.admitAndEnqueue({ ...alias, ...changed }), /SYNC_IDEMPOTENCY_CONFLICT/)
    const intent = await f.controlled('ordinary-C', '新的明确需求', '不同用户原意')
    assert.notEqual(f.store.admitAndEnqueue({ ...admission, ...intent, ingressKey: 'ordinary-C' }).id, original.id)
    assert.equal(f.store.listOperations(a.input.source.repositoryId).length, 2)
  } finally { f.cleanup() }
})

test('v6 controlled request normalization is lazy, preserves historical identity and fails closed on missing current-source evidence', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v6.sqlite'))
  let backup: ReturnType<typeof openProtocol> | null = null
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 6))
    const a = await f.controlled('old-A'), b = await f.controlled('new-B'), value = { ...f.admit(a.input.source), ...a }
    const original = f.store.admitAndEnqueue(value)
    const row = f.protocol.withTransaction(tx => tx.query('SELECT * FROM sync_operations WHERE id=?', original.id))[0]
    const columns = Object.keys(row).filter(column => column !== 'normalized_semantic_digest')
    legacy.initialize(syncCoordinatorAddress(a.input.source.repositoryId))
    const message = legacy.enqueue(syncCoordinatorAddress(a.input.source.repositoryId), { kind: 'sync.dispatch.v1', body: Buffer.from(JSON.stringify({ version: 1, type: 'sync.dispatch', operationId: original.id, inputId: a.input.id, generation: original.generation, dispatchKey: `sync-dispatch-${original.id}-${original.generation}` })), idempotencyKey: `sync-dispatch-${original.id}-${original.generation}` })
    const historical = { ...original, dispatchMessageId: message.messageId }
    row.record_json = JSON.stringify(historical)
    const gone = { ...historical, id: 'removed-repository-operation', ingressKey: 'removed-repository-ingress', payloadDigest: 'removed-payload', input: { ...historical.input, source: { ...historical.input.source, repositoryId: 'removed-repository', commonDir: '/missing/removed/.git', canonicalRoot: '/missing/removed' } }, requestBlob: { sha256: 'f'.repeat(64) } }
    legacy.withTransaction(tx => {
      tx.exec(`INSERT INTO sync_operations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[])
      tx.exec(`INSERT INTO sync_operations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => column === 'id' ? gone.id : column === 'ingress_key' ? gone.ingressKey : column === 'payload_digest' ? gone.payloadDigest : column === 'repository_id' ? gone.input.source.repositoryId : column === 'source_root' ? gone.input.source.canonicalRoot : column === 'record_json' ? JSON.stringify(gone) : row[column]) as SqlParam[])
    })
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, [...SYNC_MIGRATIONS.slice(0, 6), { version: 7, sql: `${SYNC_MIGRATIONS[6].sql} INSERT INTO missing_v7_table VALUES(1);` }]))
    assert.ok(!legacy.withTransaction(tx => tx.query('PRAGMA table_info(sync_operations)')).some(column => column.name === 'normalized_semantic_digest'))
    assert.equal(legacy.listPending(syncCoordinatorAddress(a.input.source.repositoryId))[0].messageId, message.messageId)
    const backupPath = join(f.root, 'v6.backup')
    assert.equal(await migrateSyncStore(legacy, { backupPath }), SYNC_MIGRATIONS.length)
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 6)), { code: 'PROTOCOL_SCHEMA_GENERATION_UNSUPPORTED' })
    backup = openProtocol(backupPath)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 6)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT record_json FROM sync_operations WHERE id=?', original.id))[0].record_json, JSON.stringify(historical))
    const upgraded = new SyncStore(legacy, f.options), alias = { ...value, ...b, ingressKey: 'new-B' }
    f.blobs.delete(a.requestBlob.sha256)
    assert.throws(() => upgraded.admitAndEnqueue(alias), /SYNC_REQUEST_IDENTITY_UNAVAILABLE/)
    assert.equal(upgraded.listOperations(a.input.source.repositoryId).length, 1)
    assert.equal(legacy.withTransaction(tx => tx.query('SELECT normalized_semantic_digest FROM sync_operations WHERE id=?', original.id))[0].normalized_semantic_digest, null)
    f.blobs.set(a.requestBlob.sha256, readEvidence(a.input.source.commonDir, a.requestBlob))
    assert.equal(upgraded.admitAndEnqueue(alias).id, original.id)
    assert.deepEqual(upgraded.readOperation(original.id), historical)
    assert.equal(upgraded.admitAndEnqueue(alias).id, original.id)
    assert.throws(() => upgraded.admitAndEnqueue({ ...alias, impactDigest: 'changed' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal(legacy.withTransaction(tx => tx.query('SELECT normalized_semantic_digest FROM sync_operations WHERE id=?', gone.id))[0].normalized_semantic_digest, null)
    const reopened = openProtocol(join(f.root, 'v6.sqlite'))
    try {
      assert.equal(await migrateSyncStore(reopened), SYNC_MIGRATIONS.length)
      assert.equal(new SyncStore(reopened, f.options).admitAndEnqueue(alias).id, historical.id)
      assert.deepEqual(new SyncStore(reopened, f.options).findIngressReceipt('new-B')?.requestBlob, b.requestBlob)
    } finally { reopened.close() }
    assert.equal(legacy.listPending(syncCoordinatorAddress(a.input.source.repositoryId)).length, 1)
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('P3退役记录只随真实receipt结算进入成对基线，重启及重复settle保持', async () => {
  const f = await fixture()
  try {
    const r = f.ready(undefined, undefined, undefined, undefined, undefined, { retiredIds: ['AC-EXPORT-OLD'] })
    assert.equal(f.store.readBaseline(r.operation.input.source), null)
    const journal = f.store.beginApply(r.fence, r.plan, r.target), receipt = f.receipt(journal.id, r.plan)
    for (const step of journal.steps) f.store.recordApplyStep(r.fence, journal.id, { ...step, status: 'completed' })
    f.store.recordReceipt(journal.id, receipt)
    assert.equal(f.store.readBaseline(r.operation.input.source), null)
    f.store.settleApply(journal.id, receipt.id)
    assert.deepEqual(f.store.readBaseline(r.operation.input.source)!.retiredIds, ['AC-EXPORT-OLD'])
    assert.deepEqual(f.store.readBaseline(receipt.deliverySnapshot.source)!.retiredIds, ['AC-EXPORT-OLD'])
    const reopened = openProtocol(f.path)
    try { const store = new SyncStore(reopened, f.options); store.settleApply(journal.id, receipt.id); assert.deepEqual(store.readBaseline(r.operation.input.source)!.retiredIds, ['AC-EXPORT-OLD']) } finally { reopened.close() }
  } finally { f.cleanup() }
})

test('P3 v8→v9先备份后登记授权writer版本，旧writer拒写且无改历史记录', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.root, 'v8.sqlite'))
  let backup: ReturnType<typeof openProtocol> | undefined
  try {
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 8))
    assert.throws(() => new SyncStore(legacy, f.options), /SYNC_SCHEMA_UNSUPPORTED/)
    const backupPath = join(f.root, 'v8.backup')
    assert.equal(await migrateSyncStore(legacy, { backupPath }), SYNC_MIGRATIONS.length)
    assert.throws(() => applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 8)), { code: 'PROTOCOL_SCHEMA_GENERATION_UNSUPPORTED' })
    backup = openProtocol(backupPath)
    assert.equal(backup.withTransaction(tx => tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT))[0].version, 8)
    assert.equal(await migrateSyncStore(legacy), SYNC_MIGRATIONS.length)
    assert.deepEqual(new SyncStore(legacy, f.options).listOperations('repo'), [])
  } finally { backup?.close(); legacy.close(); f.cleanup() }
})

test('P3同选择新requestId/finding次序复用原预算，真实新选择撤旧fence且历史conflict保留', async () => {
  const f = await fixture()
  try {
    const real = await f.controlled(), base = { ...f.admit(real.input.source, real.input.id), origin: 'code' as const, input: real.input, deliveryPlan: { canonicalRoot: real.input.source.canonicalRoot, branch: real.input.source.branch, baseCommit: real.input.headCommit } }
    const old = f.claim(base)
    f.store.recordFailure(old.fence, { code: 'business_conflict', message: '双方权限规则互斥；保真实历史分析', kind: 'conflict', evidenceRefs: [] })
    const make = (requestId: string, findingIds: string[], choice: 'keep_intent' | 'adopt_behavior') => {
      const requestBlob = prepareControlledDecision(real.input, { requestId, operationId: old.operation.id, inputId: real.input.id, analysisRef: { sha256: 'a'.repeat(64) }, findingIds, decision: { choice } })
      f.blobs.set(requestBlob.sha256, readEvidence(real.input.source.commonDir, requestBlob))
      return { ...base, ingressKey: requestId, origin: 'decision' as const, requestBlob }
    }
    const firstInput = make('choice-A', ['finding-1', 'finding-2'], 'keep_intent'), first = f.store.admitAndEnqueue(firstInput)
    assert.equal(f.store.readOperation(old.operation.id).phase, 'superseded')
    assert.equal(f.store.readAttempt(old.attempt.id).failure!.code, 'business_conflict')
    assert.throws(() => f.store.renewLease(old.fence, 1000), /SYNC_FENCE_EXPIRED/)
    const alias = f.store.admitAndEnqueue({ ...make('choice-B', ['finding-2', 'finding-1'], 'keep_intent'), policyDigest: 'new-request-ref-and-settled-facts', readSetDigest: 'derived-readset', scope: { ...base.scope, contractIds: [...base.scope.contractIds, 'AC-SETTLED-NEW'] } })
    assert.equal(alias.id, first.id); assert.equal(alias.callsUsed, 0); assert.equal(alias.deadlineAtMs, first.deadlineAtMs)
    assert.throws(() => f.store.admitAndEnqueue(make('choice-A', ['finding-1', 'finding-2'], 'adopt_behavior')), /SYNC_IDEMPOTENCY_CONFLICT/)
    const ready = f.ready(firstInput, firstInput.scope, undefined, null, undefined, { decisionRefs: [firstInput.requestBlob] })
    const journal = f.store.beginApply(ready.fence, ready.plan, ready.target), receipt = f.receipt(journal.id, ready.plan)
    for (const step of journal.steps) f.store.recordApplyStep(ready.fence, journal.id, { ...step, status: 'completed' })
    f.store.recordReceipt(journal.id, receipt); f.store.settleApply(journal.id, receipt.id)
    const settled = f.store.readOperation(first.id), baseline = f.store.readBaseline(base.input.source)!
    assert.deepEqual(baseline.decisionRefs, [firstInput.requestBlob])
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_operations SET normalized_semantic_digest=? WHERE id=?', 'old-v8-derived-policy-identity', first.id))
    const repeated = f.store.admitAndEnqueue({ ...make('choice-after-receipt', ['finding-2', 'finding-1'], 'keep_intent'), policyDigest: 'settled-history-and-new-transport-reference', previousBaselinePair: baseline })
    assert.equal(repeated.id, first.id); assert.equal(repeated.callsUsed, settled.callsUsed); assert.equal(repeated.deadlineAtMs, settled.deadlineAtMs)

    const replacement = f.store.admitAndEnqueue(make('choice-C', ['finding-1', 'finding-2'], 'adopt_behavior'))
    assert.notEqual(replacement.id, first.id); assert.equal(f.store.readOperation(first.id).phase, 'workspace_synced')
    assert.equal(f.store.requestControl(old.operation.id, 'run').phase, 'superseded')
    assert.equal(f.store.listAttempts(old.operation.id).length, 1)
  } finally { f.cleanup() }
})


test('当前fence记录独审业务conflict不改变执行状态，失败/预算与重启仍保原因', async () => {
  const f = await fixture()
  try {
    const claimed = f.claim(), before = f.store.readOperation(claimed.operation.id)
    assert.throws(() => f.store.recordReviewedConflict({ ...claimed.fence, generation: claimed.fence.generation + 1 }), /SYNC_FENCE_EXPIRED/)
    assert.throws(() => f.store.recordReviewedConflict({ ...claimed.fence, sourceFingerprint: 'foreign-source' }), /SYNC_FENCE_EXPIRED/)
    const marked = f.store.recordReviewedConflict(claimed.fence)
    assert.equal(marked.phase, 'analyzing'); assert.equal(marked.blockedReason, 'conflicted')
    assert.deepEqual(marked.input, before.input); assert.deepEqual(marked.scope, before.scope); assert.deepEqual(marked.readyScope, before.readyScope); assert.deepEqual(marked.blockedScope, before.blockedScope)
    assert.deepEqual(marked.budget, before.budget); assert.equal(marked.callsUsed, before.callsUsed); assert.equal(marked.deadlineAtMs, before.deadlineAtMs)
    assert.equal(f.store.recordReviewedConflict(claimed.fence).revision, marked.revision)
    const issue = { code: 'invalid_p1', message: 'P1非法候选并非合法业务义务', kind: 'environment' as const, evidenceRefs: [f.put({ rejectedCandidate: true })] }
    f.store.recordFailure(claimed.fence, issue)
    assert.equal(f.store.readOperation(marked.id).phase, 'failed'); assert.equal(f.store.readOperation(marked.id).blockedReason, 'conflicted')
    assert.deepEqual(f.store.readAttempt(claimed.attempt.id).failure, issue); assert.equal(f.store.listJournals(marked.id).length, 0)
    const reopened = openProtocol(f.path)
    try { assert.equal(new SyncStore(reopened, f.options).readOperation(marked.id).blockedReason, 'conflicted') } finally { reopened.close() }
    f.tick(100001); f.store.recordBudgetExhaustion(marked.id)
    assert.equal(f.store.readOperation(marked.id).phase, 'budget_exhausted'); assert.equal(f.store.readOperation(marked.id).blockedReason, 'conflicted')
    assert.deepEqual(f.store.readAttempt(claimed.attempt.id).failure, issue)
    assert.throws(() => f.store.recordReviewedConflict(claimed.fence), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})


test('decision admission事务复核当前阶段/attempt/资源，早期conflict与applying不能授裁决权', async () => {
  for (const state of ['active', 'applying', 'pending-resource', 'race', 'coverage-gap'] as const) {
    const f = await fixture()
    try {
      const real = await f.controlled(), value = { ...f.admit(real.input.source), input: real.input, origin: 'code' as const, deliveryPlan: { canonicalRoot: real.input.source.canonicalRoot, branch: real.input.source.branch, baseCommit: real.input.headCommit } }
      const make = (operationId: string): AdmitSyncInput => {
        const requestBlob = prepareControlledDecision(real.input, { requestId: `choice-${state}`, operationId, inputId: real.input.id, analysisRef: { sha256: 'a'.repeat(64) }, findingIds: ['finding-1'], decision: { choice: 'keep_intent' } })
        f.blobs.set(requestBlob.sha256, readEvidence(real.input.source.commonDir, requestBlob))
        return { ...value, ingressKey: `choice-${state}`, origin: 'decision', requestBlob }
      }
      if (state === 'applying') {
        const ready = f.ready(value, value.scope, undefined, null, claimed => { f.store.recordReviewedConflict(claimed.fence) })
        f.store.beginApply(ready.fence, ready.plan, ready.target)
        assert.equal(f.store.readDecisionEligibility(ready.operation.id).eligible, false)
        assert.throws(() => f.store.admitAndEnqueue(make(ready.operation.id)), /SYNC_DECISION_BINDING/)
        assert.equal(f.store.readOperation(ready.operation.id).phase, 'applying'); assert.equal(f.store.listJournals(ready.operation.id).length, 1)
        continue
      }
      const claimed = f.claim(value)
      if (state !== 'coverage-gap') f.store.recordReviewedConflict(claimed.fence)
      if (state === 'pending-resource') f.store.planResource(claimed.fence, { key: 'native-unsettled', kind: 'native_session', payloadDigest: 'original-native-request', inputId: real.input.id, candidateDigest: null, planBlob: f.put({ nativeIntent: true }), checkpointRef: f.put({ phase: 'planned' }) })
      if (state !== 'active') f.store.recordFailure(claimed.fence, { code: 'p1_failed', message: '保原具体业务原因', kind: state === 'coverage-gap' ? 'missing_input' : 'environment', evidenceRefs: [f.put({ failure: state })] })
      const input = make(claimed.operation.id)
      if (state === 'coverage-gap') {
        assert.equal(f.store.readOperation(claimed.operation.id).blockedReason, null); assert.equal(f.store.readDecisionEligibility(claimed.operation.id).eligible, true)
        assert.equal(f.store.admitAndEnqueue(input).origin, 'decision', '真实缺事实仍可按旧入口裁决'); continue
      }
      if (state === 'race') {
        assert.equal(f.store.readDecisionEligibility(claimed.operation.id).eligible, true)
        f.store.claimAttempt({ operationId: claimed.operation.id, source: real.input.source, scope: value.scope, leaseMs: 1000, expectedMessageId: claimed.operation.dispatchMessageId })
      }
      assert.equal(f.store.readDecisionEligibility(claimed.operation.id).eligible, false)
      assert.throws(() => f.store.admitAndEnqueue(input), state === 'pending-resource' ? /SYNC_DECISION_RESOURCE_PENDING/ : /SYNC_DECISION_BINDING/)
      assert.equal(f.store.listOperations(real.input.source.repositoryId).length, 1); assert.equal(f.store.listJournals(claimed.operation.id).length, 0)
    } finally { f.cleanup() }
  }
})


test('partial needs_input原因在生成失败或预算耗尽后仍可裁决，在途生成继续拒绝', async () => {
  for (const terminal of ['failed', 'budget_exhausted'] as const) {
    const f = await fixture()
    try {
      const real = await f.controlled(), value = { ...f.admit(real.input.source), input: real.input, origin: 'code' as const }, claimed = f.claim(value)
      f.store.startGeneration(claimed.fence, { readyScope: { paths: value.scope.paths, contractIds: [], flowIds: [] }, blockedScope: { paths: [], contractIds: value.scope.contractIds, flowIds: [] }, blockedReason: 'needs_input' })
      const requestBlob = prepareControlledDecision(real.input, { requestId: `partial-fact-${terminal}`, operationId: claimed.operation.id, inputId: real.input.id, analysisRef: { sha256: 'a'.repeat(64) }, findingIds: ['finding-1'], decision: { choice: 'new_rule', rule: '补充已选分支的具体业务事实' } })
      f.blobs.set(requestBlob.sha256, readEvidence(real.input.source.commonDir, requestBlob))
      const decision: AdmitSyncInput = { ...value, ingressKey: `partial-fact-${terminal}`, origin: 'decision', requestBlob }
      assert.equal(f.store.readDecisionEligibility(claimed.operation.id).eligible, false)
      assert.throws(() => f.store.admitAndEnqueue(decision), /SYNC_DECISION_BINDING/)
      const issue = { code: 'generation_environment', message: '独立ready分支生成失败，业务缺事实原因仍保留', kind: 'environment' as const, evidenceRefs: [f.put({ originalFailure: terminal })] }
      f.store.recordFailure(claimed.fence, issue)
      if (terminal === 'budget_exhausted') { f.tick(100001); f.store.recordBudgetExhaustion(claimed.operation.id) }
      const parent = f.store.readOperation(claimed.operation.id)
      assert.equal(parent.phase, terminal); assert.equal(parent.blockedReason, 'needs_input'); assert.deepEqual(f.store.readAttempt(claimed.attempt.id).failure, issue)
      assert.equal(f.store.readDecisionEligibility(parent.id).eligible, true)
      const admitted = f.store.admitAndEnqueue(decision)
      assert.equal(admitted.origin, 'decision'); assert.notEqual(admitted.id, parent.id); assert.equal(admitted.currentAttemptId, null)
      assert.deepEqual(f.store.readAttempt(claimed.attempt.id).failure, issue); assert.equal(f.store.listJournals(parent.id).length, 0)
    } finally { f.cleanup() }
  }
})
