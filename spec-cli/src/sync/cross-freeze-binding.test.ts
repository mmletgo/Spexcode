import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { lockCrossFreezeSource, type CrossFreezeBindingPersistence } from './cross-freeze-binding.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef, InputSnapshot } from './operation-types.js'
import { captureInputSnapshot, readEvidence, writeEvidence } from './snapshot.js'
import { SyncStore } from './store.js'

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-cross-freeze-binding-')), root = join(directory, 'source')
  const specPath = '.spec/demo/spec.md'
  mkdirSync(join(root, '.spec', 'demo'), { recursive: true })
  const protocol = openProtocol(join(directory, 'sync.sqlite'))
  t.after(() => { protocol.close(); rmSync(directory, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(directory, 'initial.backup') })
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', root, ...args,
  ], { stdio: 'pipe' }).toString().trim()
  const write = (path: string, text: string) => writeFileSync(join(root, path), text)
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'freeze') }
  git('init', '-q', '-b', 'main')
  write(specPath, '# Demo\n\n## raw source\n\nKeep the current behavior.\n\n## expanded spec\n\nCurrent contract.\n')
  write('shared.txt', 'Previous freeze.\n')
  commit()
  const first = await captureInputSnapshot(root, { committed: true }), common = first.source.commonDir
  const put = (value: unknown) => writeEvidence(common, value)
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(common, ref) })
  const scope = { paths: [specPath], contractIds: [], flowIds: [] }
  const planBlob = put({ version: 'sync-coordinator-v2', intentNodeId: 'demo', targets: [{ nodeId: 'demo', path: specPath }] })
  const admit = (input: InputSnapshot, name: string) => store.admitAndEnqueue({
    origin: 'initial', rootCauseId: name, ingressKey: name, input, scope, planBlob, policyDigest: planBlob.sha256,
    readSetDigest: 'read', impactDigest: 'impact', budget: { mode: 'unlimited' }, delivery: null,
    deliveryPlan: { canonicalRoot: input.source.canonicalRoot, branch: input.source.branch, baseCommit: input.headCommit },
  })
  const old = admit(first, 'previous'), { fence, attempt } = store.claimAttempt({ operationId: old.id, source: first.source, scope, leaseMs: 10000 })
  store.bindComposedInput(fence, { sourceInputId: first.id, previousBaselinePairId: null, tree: first.immutableTree, manifestBlob: first.manifestBlob, contentDigest: first.contentDigest })
  store.checkpoint(fence, put({ operationId: old.id, attemptId: attempt.id }))
  store.recordFailure(fence, { code: 'fixture_failed', message: 'Fixture failure.', kind: 'unsupported', evidenceRefs: [] })
  write('shared.txt', 'Current freeze.\n')
  commit()
  const current = admit(await captureInputSnapshot(root, { committed: true }), 'current')
  return { root, store, old, attempt, current, git, write, commit, put }
}

function slot() {
  let ref: BlobRef | null = null, saves = 0
  const persistence: CrossFreezeBindingPersistence = { load: () => ref, save: proposed => { saves++; return ref ??= proposed } }
  return { persistence, saves: () => saves }
}

test('freezes the clean main binding once and restores it after HEAD advances', async t => {
  const f = await fixture(t), stored = slot()
  const options = { oldOperationId: f.old.id }
  const original = lockCrossFreezeSource(f.store, f.current, stored.persistence, options)
  assert.ok(original.source)
  assert.equal(original.binding.oldOperationId, f.old.id)
  assert.equal(original.binding.operationId, f.current.id)
  assert.equal(original.binding.inputId, f.current.input.id)
  assert.equal(original.binding.policyDigest, f.current.policyDigest)
  assert.equal(original.binding.provenanceDigest, original.source.provenance.digest)
  assert.deepEqual(original.binding.attemptIds, [f.attempt.id])
  assert.deepEqual(lockCrossFreezeSource(f.store, f.current, stored.persistence), original)
  f.write('shared.txt', 'Later main commit.\n')
  f.commit()
  f.write('untracked-newer.txt', 'Appeared after the source selection.\n')
  assert.deepEqual(lockCrossFreezeSource(f.store, f.current, stored.persistence), original)
  assert.equal(stored.saves(), 1)
  const late = lockCrossFreezeSource(f.store, f.current, slot().persistence, options)
  assert.equal(late.source, null)
  assert.equal(late.reason, 'source_head_changed')
})

test('checks staged, unstaged, untracked, assume-unchanged and wrong-branch state before binding', async t => {
  const f = await fixture(t)
  const clean = slot(), assertUnavailable = (expected: string) => {
    const decision = lockCrossFreezeSource(f.store, f.current, slot().persistence)
    assert.equal(decision.source, null)
    assert.equal(decision.reason, expected)
    assert.equal(decision.binding?.kind, 'no-source')
  }
  f.write('shared.txt', 'Unstaged.\n')
  assertUnavailable('source_not_clean')
  f.git('add', 'shared.txt')
  assertUnavailable('source_not_clean')
  f.git('reset', '--hard', 'HEAD')
  f.write('extra.txt', 'Untracked.\n')
  assertUnavailable('source_not_clean')
  const declined = lockCrossFreezeSource(f.store, f.current, clean.persistence)
  rmSync(join(f.root, 'extra.txt'))
  assert.deepEqual(lockCrossFreezeSource(f.store, f.current, clean.persistence), declined)
  f.git('update-index', '--assume-unchanged', 'shared.txt')
  f.write('shared.txt', 'Hidden worktree change.\n')
  assertUnavailable('source_not_clean')
  f.git('update-index', '--no-assume-unchanged', 'shared.txt')
  f.git('reset', '--hard', 'HEAD')
  f.git('switch', '-c', 'other')
  assertUnavailable('source_head_changed')
})

test('classifies damaged sticky bindings and provenance without publishing a replacement', async t => {
  const f = await fixture(t)
  const original = lockCrossFreezeSource(f.store, f.current, slot().persistence)
  assert.ok(original.source)
  const replay = (ref: BlobRef) => {
    const result = lockCrossFreezeSource(f.store, f.current, { load: () => ref, save: () => assert.fail('A durable binding was replaced.') })
    assert.equal(result.source, null)
    assert.equal(result.binding, null)
    assert.deepEqual(result.bindingRef, ref)
    return result.reason
  }
  assert.equal(replay({ sha256: 'f'.repeat(64) }), 'binding_unreadable')
  assert.equal(replay(f.put({ ...original.binding, version: 'other' })), 'binding_invalid')
  assert.equal(replay(f.put({ ...original.binding, inputId: 'different-input' })), 'binding_current_mismatch')
  assert.equal(replay(f.put({ ...original.binding, oldOperationId: 'missing' })), 'binding_source_ineligible')
  assert.equal(replay(f.put({ ...original.binding, attemptIds: ['different-attempt'] })), 'binding_source_ineligible')
  assert.equal(replay(f.put({ ...original.binding, provenanceRef: { sha256: 'f'.repeat(64) } })), 'binding_provenance_unreadable')
  assert.equal(replay(f.put({ ...original.binding, provenanceDigest: 'f'.repeat(64) })), 'binding_provenance_mismatch')
  const differentPatch = f.put({ ...original.source.provenance, patch: 'A different Git patch.' })
  assert.equal(replay(f.put({ ...original.binding, provenanceRef: differentPatch })), 'binding_provenance_mismatch')
})

test('a concurrent durable no-source decision wins over a later valid proposal', async t => {
  const f = await fixture(t)
  const unavailable = slot()
  const notFound = lockCrossFreezeSource(f.store, f.current, unavailable.persistence, { oldOperationId: 'missing' })
  assert.equal(notFound.source, null)
  assert.equal(notFound.reason, 'source_not_found')
  assert.deepEqual(lockCrossFreezeSource(f.store, f.current, unavailable.persistence), notFound)
  f.write('shared.txt', 'Changed during the first decision.\n')
  const rejected = lockCrossFreezeSource(f.store, f.current, slot().persistence)
  assert.equal(rejected.source, null)
  assert.ok(rejected.bindingRef)
  const winner = rejected.bindingRef
  f.git('reset', '--hard', 'HEAD')
  const raced = lockCrossFreezeSource(f.store, f.current, {
    load: () => null,
    save: proposed => { assert.notDeepEqual(proposed, winner); return winner },
  })
  assert.deepEqual(raced, rejected)
})
