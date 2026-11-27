import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { freezeCandidate } from './candidate.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { selectCrossFreezeSource } from './cross-freeze-source.js'
import { migrateSyncStore } from './migrations.js'
import type { AdmitSyncInput, ClaimedAttempt, InputSnapshot, SyncOperation, SyncScope, VerificationResultBlob } from './operation-types.js'
import { captureInputSnapshot, readEvidence, writeEvidence } from './snapshot.js'
import { SyncStore } from './store.js'

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-cross-freeze-source-')), root = join(directory, 'repo')
  const path = '.spec/demo/spec.md'
  mkdirSync(join(root, '.spec', 'demo'), { recursive: true })
  const protocol = openProtocol(join(directory, 'sync.sqlite'))
  t.after(() => { protocol.close(); rmSync(directory, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(directory, 'initial.backup') })
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', root, ...args,
  ], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  const write = (file: string, text: string) => writeFileSync(join(root, file), text)
  const intent = (raw: string) => write(path, `# Demo\n\n## raw source\n\n${raw}\n\n## expanded spec\n\nCurrent contract.\n`)
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'freeze', '--allow-empty') }
  intent('Original user requirements.')
  commit()
  const snapshot = (committed = true) => captureInputSnapshot(root, { committed })
  const first = await snapshot(false), common = first.source.commonDir
  const store = new SyncStore(protocol, { now: () => 1000, readBlob: ref => readEvidence(common, ref) })
  const plan = {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1',
    intentNodeId: 'demo', targets: [{ nodeId: 'demo', path }], readPaths: [path], writePaths: [path],
    partitionPolicy: { version: 'sync-partition-policy-v2', maxReadBytes: 512 * 1024, maxParallel: 4 },
    facts: [], verifications: [], mandatoryTests: [],
  } satisfies SyncCoordinatorPlan
  const scope: SyncScope = { paths: [path], contractIds: [], flowIds: [] }
  const put = (value: unknown) => writeEvidence(common, value)
  const admit = (input: InputSnapshot, name: string, overrides: Partial<AdmitSyncInput> = {}) => {
    const planBlob = put(plan)
    return store.admitAndEnqueue({
      origin: 'initial', rootCauseId: name, ingressKey: `request-${name}`, input, scope, planBlob, policyDigest: planBlob.sha256,
      readSetDigest: 'frozen-reads', impactDigest: 'same-intent', budget: { mode: 'unlimited' }, delivery: null,
      deliveryPlan: { canonicalRoot: input.source.canonicalRoot, branch: input.source.branch, baseCommit: input.headCommit }, ...overrides,
    })
  }
  const start = (operation: SyncOperation): ClaimedAttempt => {
    const claimed = store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 100 })
    store.bindComposedInput(claimed.fence, { sourceInputId: operation.input.id, previousBaselinePairId: null,
      tree: operation.input.immutableTree, manifestBlob: operation.input.manifestBlob, contentDigest: operation.input.contentDigest })
    store.checkpoint(claimed.fence, put({ operationId: operation.id, attemptId: claimed.attempt.id, inputId: operation.input.id }))
    return claimed
  }
  const fail = (claimed: ClaimedAttempt) => store.recordFailure(claimed.fence, { code: 'fixture_failed', message: 'Fixture failure', kind: 'unsupported', evidenceRefs: [] })
  const next = async (content: string) => { write('shared.txt', content); commit(); return snapshot() }
  return { directory, store, first, path, intent, commit, snapshot, next, plan, put, admit, start, fail }
}

test('selects the nearest genuine old initial by admission order and preserves an explicit binding', async t => {
  const f = await fixture(t)
  const older = f.admit(f.first, 'older'), first = f.start(older)
  f.fail(first)
  const lateInput = await f.next('This commit will be admitted late.\n')
  const latest = f.admit(await f.next('Latest old freeze.\n'), 'latest'), last = f.start(latest)
  f.fail(last)
  const current = f.admit(await f.next('Current freeze.\n'), 'current')
  const result = selectCrossFreezeSource(f.store, current)
  assert.ok(result)
  assert.equal(result.operation.id, latest.id)
  assert.deepEqual(result.attempts.map(attempt => attempt.id), [last.attempt.id])
  assert.deepEqual(result.provenance.changes.map(change => change.path), ['shared.txt'])
  assert.equal(selectCrossFreezeSource(f.store, current, { oldOperationId: current.id }), null)
  assert.equal(selectCrossFreezeSource(f.store, current, { oldOperationId: 'unknown' }), null)
  assert.equal(selectCrossFreezeSource(f.store, current, { oldOperationId: older.id })?.attempts[0].id, first.attempt.id)
  const late = f.admit(lateInput, 'late')
  f.fail(f.start(late))
  assert.equal(selectCrossFreezeSource(f.store, current, { oldOperationId: late.id }), null)
  assert.equal(selectCrossFreezeSource(f.store, current)?.operation.id, latest.id)
  const explicit = { oldOperationId: latest.id, expectedAttemptIds: [last.attempt.id], expectedProvenanceDigest: result.provenance.digest }
  assert.deepEqual(selectCrossFreezeSource(f.store, current, explicit), result)
  assert.equal(selectCrossFreezeSource(f.store, current, { ...explicit, expectedAttemptIds: [first.attempt.id] }), null)
  assert.equal(selectCrossFreezeSource(f.store, current, { ...explicit, expectedProvenanceDigest: 'unexpected' }), null)
})

test('rejects live old resources until the original resource is formally removed', async t => {
  const f = await fixture(t), original = f.admit(f.first, 'source'), claimed = f.start(original)
  const checkpointRef = f.put({ phase: 'planned' })
  const resource = f.store.planResource(claimed.fence, { key: 'review', kind: 'native_session', payloadDigest: 'resource',
    inputId: original.input.id, candidateDigest: null, planBlob: checkpointRef, checkpointRef })
  const current = f.admit(await f.next('New input.\n'), 'current')
  const options = { oldOperationId: original.id }
  assert.equal(f.store.readOperation(original.id).phase, 'superseded')
  assert.equal(selectCrossFreezeSource(f.store, current, options), null)
  const terminal = f.put({ phase: 'terminal' })
  f.store.recordResourceCheckpoint(resource.id, { operationId: original.id, attemptId: claimed.attempt.id, inputId: original.input.id,
    candidateDigest: null, phase: 'terminal', expectedCheckpointRef: checkpointRef, checkpointRef: terminal })
  assert.equal(selectCrossFreezeSource(f.store, current, options), null)
  f.store.recordResourceCheckpoint(resource.id, { operationId: original.id, attemptId: claimed.attempt.id, inputId: original.input.id,
    candidateDigest: null, phase: 'removed', expectedCheckpointRef: terminal, checkpointRef: f.put({ phase: 'removed' }) })
  assert.equal(selectCrossFreezeSource(f.store, current, options)?.attempts[0].id, claimed.attempt.id)
})

test('rejects a different frozen policy, changed raw request, dirty old freeze and non-initial current request', async t => {
  const f = await fixture(t), original = f.admit(f.first, 'source')
  f.fail(f.start(original))
  const changedPlan = f.put({ ...f.plan, facts: [{ source: 'policy', text: 'Different.' }] })
  const policy = f.admit(await f.next('New policy.\n'), 'policy', { planBlob: changedPlan, policyDigest: changedPlan.sha256 })
  assert.equal(selectCrossFreezeSource(f.store, policy), null)
  f.intent('Changed user requirements.')
  f.commit()
  const changed = f.admit(await f.snapshot(), 'changed')
  assert.equal(selectCrossFreezeSource(f.store, changed, { oldOperationId: original.id }), null)
  f.intent('Original user requirements.')
  f.commit()
  const code = f.admit(await f.snapshot(), 'code', { origin: 'code' })
  assert.equal(selectCrossFreezeSource(f.store, code, { oldOperationId: original.id }), null)
  f.intent('Dirty worktree request.')
  const dirty = f.admit(await f.snapshot(false), 'dirty')
  f.fail(f.start(dirty))
  f.intent('Original user requirements.')
  const next = f.admit(await f.next('A new committed snapshot.\n'), 'next')
  assert.equal(selectCrossFreezeSource(f.store, next, { oldOperationId: dirty.id }), null)
  f.fail(f.start(next))
  const retry = f.admit(next.input, 'retry', { retryOf: next.id })
  assert.equal(selectCrossFreezeSource(f.store, retry, { oldOperationId: original.id }), null)
})

test('rejects a pending private-delivery journal and reads the closed receipt without altering it', async t => {
  const f = await fixture(t), old = f.admit(f.first, 'source'), { fence } = f.start(old)
  f.store.bindDelivery(fence, old.input.source)
  f.store.startGeneration(fence, { readyScope: old.scope, blockedScope: { paths: [], contractIds: [], flowIds: [] }, blockedReason: null })
  const candidate = freezeCandidate(old.input, { version: 'sync-files-v1', changes: [] }, old.scope)
  f.store.freezeCandidate(fence, candidate)
  const evidenceRefs = [f.put({ checked: true })]
  const verification = { inputId: old.input.id, candidateDigest: candidate.digest, policyDigest: old.policyDigest,
    readSetDigest: old.readSetDigest, environmentDigest: 'env', contextDigest: 'context', coveredScope: old.scope }
  const report: VerificationResultBlob = { ...verification, schemaVersion: 1,
    layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs })) }
  const resultBlob = f.put(report)
  f.store.recordVerification(fence, { ...verification, passed: true, evidenceRefs, resultBlob })
  const journal = f.store.beginApply(fence, { target: old.input.source, candidateDigest: candidate.digest, verificationBlob: resultBlob,
    expectedTargetSnapshotId: old.input.id, expectedBaselinePairId: null, files: [], coveredScope: old.scope,
    planBlob: f.put({ files: [] }), effectKey: 'fixture-apply', payloadDigest: 'effect' }, old.input)
  const current = f.admit(await f.next('Another committed snapshot.\n'), 'current')
  const options = { oldOperationId: old.id }
  assert.equal(selectCrossFreezeSource(f.store, current, options), null)
  assert.deepEqual(f.store.readJournal(journal.id), journal)
  const receipt = { id: `receipt-${journal.id}`, journalId: journal.id, effectKey: journal.plan.effectKey,
    actualCommit: old.input.headCommit, actualTree: old.input.immutableTree, deliverySnapshot: old.input, evidenceRefs, completedAtMs: 1000 }
  const completed = f.store.recordReceipt(journal.id, receipt)
  assert.equal(selectCrossFreezeSource(f.store, current, options), null)
  assert.deepEqual(f.store.readJournal(journal.id), completed)
  const settled = f.store.settleApply(journal.id, receipt.id)
  const originalJournal = f.store.readJournal(journal.id)
  assert.equal(selectCrossFreezeSource(f.store, current, options)?.operation.id, settled.id)
  assert.deepEqual(f.store.readJournal(journal.id), originalJournal)
})
