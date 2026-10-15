import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { freezeCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { migrateSyncStore } from './migrations.js'
import type { CandidateRef, ClaimedAttempt, ComposedInputRef, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import { deliverVerifiedAttempt, planPrivateDelivery } from './private-delivery.js'
import type { PrivateDeliveryOptions } from './private-delivery.js'
import { assemblePublicationBase, verifyPublicationBase } from './publication-base.js'
import { captureInputSnapshot, contentHash, objectGit, readEvidence, readObject, readTree, verifySnapshot, writeEvidence, writeObject, writeTree } from './snapshot.js'
import { SyncStore } from './store.js'

async function fixture(t: test.TestContext, dirtyReadonly = true) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'spex-publication-base-'))), root = join(parent, 'source'), managed = join(parent, 'managed'), runtime = join(parent, 'runtime')
  mkdirSync(root); mkdirSync(managed, { mode: 0o700 }); mkdirSync(join(runtime, 'dist/sync'), { recursive: true }); mkdirSync(join(runtime, 'templates/hooks'), { recursive: true })
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Publication fixture'); git('config', 'user.email', 'publication@example.invalid')
  for (const path of ['a.txt', 'b.txt', 'config.txt', 'oracle.txt']) writeFileSync(join(root, path), `base-${path}\n`)
  git('add', '.'); git('commit', '-m', 'base')
  writeFileSync(join(root, 'a.txt'), 'author-A2-unconsumed\n')
  if (dirtyReadonly) { writeFileSync(join(root, 'config.txt'), 'readonly-current-config\n'); writeFileSync(join(root, 'oracle.txt'), 'readonly-current-oracle\n') }
  const input = await captureInputSnapshot(root), commonDir = input.source.commonDir, index = readFileSync(join(root, '.git/index'))
  const protocol = openProtocol(join(commonDir, 'sync.sqlite'))
  t.after(() => { protocol.close(); rmSync(parent, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(parent, 'backup.sqlite') })
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const hooks = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
  for (const name of readdirSync(hooks)) {
    copyFileSync(join(hooks, name), join(runtime, 'templates/hooks', name)); copyFileSync(join(hooks, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  copyFileSync(fileURLToPath(new URL('../../dist/sync/trusted-footprint.js', import.meta.url)), join(runtime, 'dist/sync/trusted-footprint.js'))
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  writeFileSync(join(runtime, 'dist/cli.js'), "if(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n")
  const options: PrivateDeliveryOptions = { managedRoot: managed, tools: { trustedRuntimeRoot: runtime, toolEntry: join(runtime, 'dist/cli.js'), canonicalHooksDir: join(runtime, 'templates/hooks'), gitPath: '/usr/bin/git' }, beforeApply: async () => { assert.equal((await captureInputSnapshot(root)).id, input.id) } }
  const reads = (path: string): string[] => [path, 'config.txt', 'oracle.txt', 'absent-readonly.txt']
  const claim = (path: string, snapshot: InputSnapshot = input): ClaimedAttempt => {
    const resources = [...reads(path).map(path => ({ kind: 'path' as const, path })), { kind: 'contract' as const, id: `RULE-${path}` }], selection = store.readBaselineSelection(snapshot.source, resources)
    assert.ok('selection' in selection)
    const scope: SyncScope = { paths: [path], contractIds: [`RULE-${path}`], flowIds: [] }
    const planBlob = writeEvidence(commonDir, { readPaths: reads(path), fixture: 'publication read closure only; not full coordinator policy' })
    const operation = store.admitAndEnqueue({ ingressKey: `${snapshot.id}:${path}`, rootCauseId: `${snapshot.id}:${path}`, origin: 'spec', input: snapshot, scope, baselineSelection: selection.selection, budget: { maxAttempts: 3, maxCalls: 8, maxRepairs: 2, timeoutMs: 1000000 }, delivery: null, deliveryPlan: planPrivateDelivery(snapshot, managed, `${snapshot.id}:${path}`), planBlob, policyDigest: planBlob.sha256, impactDigest: 'fixture-impact', readSetDigest: 'fixture-read' })
    const ack = store.ackDispatch(snapshot.source.repositoryId, operation.dispatchMessageId)
    const claimed = store.claimQueuedAttempt({ operationId: operation.id, source: snapshot.source, scope, leaseMs: 1000000, expectedRevision: ack.revision })
    const raw = composeInputSnapshots(snapshot, selection.selection, { executionPaths: [path] }).composed!
    // 模拟可信 read-closure composition：只读配置/oracle保留真实冻结字节，未选A2仍被排除。
    const original = verifySnapshot(snapshot), entries = new Map(readTree(commonDir, raw.tree).map(entry => [entry.path, entry]))
    for (const entry of original.filter(entry => ['config.txt', 'oracle.txt'].includes(entry.path))) entries.set(entry.path, entry)
    const tree = writeTree(commonDir, [...entries.values()]), frozenEntries = readTree(commonDir, tree)
    const composed: ComposedInputRef = { ...raw, tree, manifestBlob: writeEvidence(commonDir, { version: 1, entries: frozenEntries }), contentDigest: contentHash(JSON.stringify(frozenEntries)) }
    store.bindComposedInput(claimed.fence, composed); store.startGeneration(claimed.fence)
    return { ...claimed, operation: store.readOperation(operation.id), attempt: store.readAttempt(claimed.attempt.id) }
  }
  const verify = (claimed: ClaimedAttempt, candidate: CandidateRef): void => {
    const operation = store.readOperation(claimed.operation.id)
    const evidence = writeEvidence(commonDir, { fixture: '真实Git/SQLite/hook/journal；V1-V4与native仅受控前置证据，本测试不证明Docker/native' })
    const bindings = { inputId: operation.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, baselineSelectionDigest: operation.baselineSelection!.digest, environmentDigest: 'controlled-fixture', contextDigest: 'controlled-fixture' }
    const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.readyScope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
    store.recordVerification(claimed.fence, { ...bindings, passed: true, coveredScope: operation.readyScope, evidenceRefs: [evidence], resultBlob: writeEvidence(commonDir, result) })
  }
  const freeze = (claimed: ClaimedAttempt, path: string, content: string | null, mode: '100755' | null = null) => {
    const operation = store.readOperation(claimed.operation.id), attempt = store.readAttempt(claimed.attempt.id), composed = attempt.composedInput!
    const base = assemblePublicationBase(store, operation, attempt, composed, reads(path))
    store.bindPublicationBase(claimed.fence, base)
    const before = readTree(commonDir, composed.tree).find(entry => entry.path === path)!
    const candidate = freezeCandidate(operation.input, { version: 'sync-files-v1', changes: [{ path, beforeDigest: before.digest, beforeMode: before.mode, content, mode }] }, operation.readyScope, base.composed)
    store.freezeCandidate(claimed.fence, candidate); verify(claimed, candidate)
    return { candidate, base }
  }
  const text = (tree: string, path: string): string | null => { const entry = readTree(commonDir, tree).find(entry => entry.path === path); return entry ? readObject(commonDir, entry.oid).toString() : null }
  return { root, input, commonDir, index, store, protocol, claim, freeze, verify, text, git, options, reads }
}

test('A1已结算未合回来源后B2交付保全A1；B journal不冒领A及readonly，source/index保留A2', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'); f.freeze(a, 'a.txt', 'delivered-A1\n')
  const first = await deliverVerifiedAttempt(f.store, a.fence, f.options)
  const headA = f.store.readBaselineSelection(f.input.source, [{ kind: 'path', path: 'a.txt' }])
  const b = f.claim('b.txt'), frozen = f.freeze(b, 'b.txt', 'delivered-B2\n')
  assert.equal(f.text(b.attempt.composedInput!.tree, 'a.txt'), 'base-a.txt\n')
  assert.equal(f.text(frozen.candidate.tree, 'a.txt'), 'delivered-A1\n')
  const second = await deliverVerifiedAttempt(f.store, b.fence, f.options)
  assert.equal(f.text(second.receipt.actualTree, 'a.txt'), 'delivered-A1\n'); assert.equal(f.text(second.receipt.actualTree, 'b.txt'), 'delivered-B2\n')
  for (const path of ['config.txt', 'oracle.txt']) assert.equal(f.text(second.receipt.actualTree, path), readFileSync(join(f.root, path), 'utf8'))
  assert.equal(f.text(second.receipt.actualTree, 'absent-readonly.txt'), null)
  assert.deepEqual(f.store.listJournals(b.operation.id)[0].plan.files.map(file => file.path), ['b.txt'])
  assert.equal(f.store.listJournals(b.operation.id)[0].plan.publicationBaseRef?.sha256, frozen.base.provenanceBlob.sha256)
  assert.equal(f.store.listJournals(b.operation.id)[0].plan.expectedBaselineSelectionDigest, b.operation.baselineSelection!.digest)
  assert.deepEqual(f.store.readBaselineSelection(f.input.source, [{ kind: 'path', path: 'a.txt' }]), headA)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'author-A2-unconsumed\n'); assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit)
  assert.notEqual(first.receipt.actualCommit, second.receipt.actualCommit)
})

for (const order of [['a.txt', 'b.txt'], ['b.txt', 'a.txt']]) test(`同HEAD并行生成，按${order.join('→')}冻结发布保完整A1+B2且不夹A2`, { timeout: 60000 }, async t => {
  const f = await fixture(t), attempts = new Map(['a.txt', 'b.txt'].map(path => [path, f.claim(path)]))
  assert.equal(attempts.get('a.txt')!.operation.input.headCommit, attempts.get('b.txt')!.operation.input.headCommit)
  let lastTree = ''
  for (const path of order) {
    const claimed = attempts.get(path)!; f.freeze(claimed, path, path === 'a.txt' ? 'delivered-A1\n' : 'delivered-B2\n')
    lastTree = (await deliverVerifiedAttempt(f.store, claimed.fence, f.options)).receipt.actualTree
    assert.deepEqual(f.store.listJournals(claimed.operation.id)[0].plan.files.map(file => file.path), [path])
  }
  assert.equal(f.text(lastTree, 'a.txt'), 'delivered-A1\n'); assert.equal(f.text(lastTree, 'b.txt'), 'delivered-B2\n')
  assert.equal(readFileSync(join(f.root, 'a.txt'), 'utf8'), 'author-A2-unconsumed\n'); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('伪造parent/读闭包/absence/来源拒绝；base绑定后不能替换、candidate冻结后不能再绑定', { timeout: 30000 }, async t => {
  const f = await fixture(t), b = f.claim('b.txt'), base = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  assert.throws(() => f.store.bindPublicationBase(b.fence, { ...base, parentTree: b.operation.input.immutableTree }), /PUBLICATION_BASE_BINDING/)
  assert.throws(() => assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, ['b.txt']), /read closure differs/)
  const evidence = JSON.parse(readEvidence(f.commonDir, base.provenanceBlob).toString())
  for (const path of ['config.txt', 'absent-readonly.txt']) {
    const entries = readTree(f.commonDir, base.composed.tree).filter(entry => entry.path !== path)
    const bytes = Buffer.from('forged-readonly\n'); entries.push({ path, mode: '100644', oid: writeObject(f.commonDir, bytes), digest: contentHash(bytes) })
    const tree = writeTree(f.commonDir, entries), actual = readTree(f.commonDir, tree), composed = { ...base.composed, tree, manifestBlob: writeEvidence(f.commonDir, { version: 1, entries: actual }), contentDigest: contentHash(JSON.stringify(actual)) }
    const forged = { ...base, composed, provenanceBlob: writeEvidence(f.commonDir, { ...evidence, composed }) }
    assert.throws(() => f.store.bindPublicationBase(b.fence, forged), /PUBLICATION_BASE_BINDING/)
  }
  const foreign = { ...evidence, heads: { ...evidence.heads, selection: { ...evidence.heads.selection, source: { ...f.input.source, branch: 'other' } } } }
  assert.throws(() => f.store.bindPublicationBase(b.fence, { ...base, provenanceBlob: writeEvidence(f.commonDir, foreign) }), /foreign source/)
  f.store.bindPublicationBase(b.fence, base)
  assert.deepEqual(f.store.bindPublicationBase(b.fence, base).publicationBase, base)
  const alternate = { ...evidence, readPaths: [...evidence.readPaths, 'another-absent.txt'].sort() }
  assert.throws(() => f.store.bindPublicationBase(b.fence, { ...base, provenanceBlob: writeEvidence(f.commonDir, alternate) }), /read closure differs/)
  f.freeze(b, 'b.txt', 'delivered-B2\n')
  assert.throws(() => f.store.bindPublicationBase(b.fence, base), /PUBLICATION_BASE_FROZEN/)
  assert.throws(() => f.store.bindPublicationBase({ ...b.fence, leaseToken: 'expired-fence' }, base), /FENCE/)
})

for (const deleted of [false, true]) test(`真实已结算${deleted ? '删除tombstone' : '可执行mode/OID'}跨独立B交付保留`, { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'); f.freeze(a, 'a.txt', deleted ? null : 'executable-delivered-A1\n', deleted ? null : '100755')
  const first = await deliverVerifiedAttempt(f.store, a.fence, f.options), b = f.claim('b.txt'), frozen = f.freeze(b, 'b.txt', 'delivered-B2\n')
  const original = readTree(f.commonDir, first.receipt.actualTree).find(entry => entry.path === 'a.txt') ?? null
  const inherited = readTree(f.commonDir, frozen.candidate.tree).find(entry => entry.path === 'a.txt') ?? null
  assert.deepEqual(inherited, original)
  const provenance = JSON.parse(readEvidence(f.commonDir, frozen.base.provenanceBlob).toString())
  assert.deepEqual(provenance.paths.find((entry: { path: string }) => entry.path === 'a.txt').delivered, original)
  const delivered = await deliverVerifiedAttempt(f.store, b.fence, f.options)
  assert.deepEqual(readTree(f.commonDir, delivered.receipt.actualTree).find(entry => entry.path === 'a.txt') ?? null, original)
  assert.equal(original?.mode ?? null, deleted ? null : '100755')
  assert.deepEqual(f.store.listJournals(b.operation.id)[0].plan.files.map(file => file.path), ['b.txt'])
})

test('全head CAS拒绝在assemble与bind间新增交付；原精确selection不因无关head过期', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'), b = f.claim('b.txt')
  const old = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  f.freeze(a, 'a.txt', 'delivered-A1\n'); await deliverVerifiedAttempt(f.store, a.fence, f.options)
  assert.throws(() => f.store.bindPublicationBase(b.fence, old), /PUBLICATION_BASE_STALE/)
  const current = f.freeze(b, 'b.txt', 'delivered-B2\n')
  assert.equal(f.text(current.candidate.tree, 'a.txt'), 'delivered-A1\n')
})

test('真实readonly配置head结算后原selection CAS失效，publication不能改读集合绕过', { timeout: 60000 }, async t => {
  const f = await fixture(t), b = f.claim('b.txt'), config = f.claim('config.txt')
  f.freeze(config, 'config.txt', 'new-verified-config\n'); await deliverVerifiedAttempt(f.store, config.fence, f.options)
  const base = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  assert.throws(() => f.store.bindPublicationBase(b.fence, base), /BASELINE_STALE/)
  assert.equal(f.store.readAttempt(b.attempt.id).candidate, null)
})

test('冻结A跨崩溃阻止B发布；无base的B生成可并行，A真实恢复后B继承A且不重扣calls', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'), b = f.claim('b.txt')
  f.store.reserveDispatch(a.fence, { key: 'generate-A', purpose: 'code_generate', requestDigest: 'A' }); f.store.reserveDispatch(b.fence, { key: 'generate-B', purpose: 'code_generate', requestDigest: 'B' })
  const checkpoint = writeEvidence(f.commonDir, { native: 'B still generating independently' })
  const resource = f.store.planResource(b.fence, { key: 'B-generation', kind: 'native_session', payloadDigest: 'B-generation', inputId: f.input.id, candidateDigest: null, planBlob: checkpoint, checkpointRef: checkpoint })
  const frozen = f.freeze(a, 'a.txt', 'delivered-A1\n')
  await assert.rejects(deliverVerifiedAttempt(f.store, a.fence, { ...f.options, afterCommit: () => { throw new Error('publication crash') } }), /publication crash/)
  const commit = f.git('rev-parse', a.operation.deliveryPlan.branch)
  const waiting = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  assert.throws(() => f.store.bindPublicationBase(b.fence, waiting), /SYNC_PUBLICATION_BUSY/)
  assert.equal(f.store.readAttempt(b.attempt.id).publicationBase, undefined)
  for (const phase of ['terminal', 'removed'] as const) f.store.recordResourceCheckpoint(resource.id, { operationId: b.operation.id, attemptId: b.attempt.id, inputId: f.input.id, candidateDigest: null, phase, expectedCheckpointRef: checkpoint, checkpointRef: checkpoint })
  const restored = assemblePublicationBase(f.store, f.store.readOperation(a.operation.id), f.store.readAttempt(a.attempt.id), a.attempt.composedInput!, f.reads('a.txt'))
  assert.deepEqual(restored, frozen.base); f.store.assertPublicationBaseCurrent(a.operation.id, a.attempt.id)
  const delivered = await deliverVerifiedAttempt(f.store, a.fence, f.options)
  assert.equal(delivered.receipt.actualCommit, commit); assert.equal(delivered.receipt.actualTree, frozen.candidate.tree)
  assert.equal(f.git('show', '-s', '--format=%P', commit), frozen.base.parentCommit)
  assert.throws(() => f.store.bindPublicationBase(b.fence, waiting), /PUBLICATION_BASE_STALE/)
  f.freeze(b, 'b.txt', 'delivered-B2\n')
  const second = await deliverVerifiedAttempt(f.store, b.fence, f.options)
  assert.equal(f.text(second.receipt.actualTree, 'a.txt'), 'delivered-A1\n'); assert.equal(f.text(second.receipt.actualTree, 'b.txt'), 'delivered-B2\n')
  assert.equal(f.store.readBudgetUsage(a.operation.id).callsUsed, 1); assert.equal(f.store.readBudgetUsage(b.operation.id).callsUsed, 1)
})

test('hash-valid额外a读路径不能抹掉已交付A1；factory及verifier均核精确可信闭包', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'); f.freeze(a, 'a.txt', 'delivered-A1\n'); await deliverVerifiedAttempt(f.store, a.fence, f.options)
  const b = f.claim('b.txt'), base = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt')), evidence = JSON.parse(readEvidence(f.commonDir, base.provenanceBlob).toString())
  const originalA = readTree(f.commonDir, b.attempt.composedInput!.tree).find(entry => entry.path === 'a.txt')!
  const parentTree = writeTree(f.commonDir, [...readTree(f.commonDir, base.parentTree).filter(entry => entry.path !== 'a.txt'), originalA]), parentManifestBlob = writeEvidence(f.commonDir, { version: 1, entries: readTree(f.commonDir, parentTree) })
  const tree = writeTree(f.commonDir, [...readTree(f.commonDir, base.composed.tree).filter(entry => entry.path !== 'a.txt'), originalA]), entries = readTree(f.commonDir, tree), composed = { ...base.composed, tree, manifestBlob: writeEvidence(f.commonDir, { version: 1, entries }), contentDigest: contentHash(JSON.stringify(entries)) }
  const parentCommit = objectGit(f.commonDir, ['commit-tree', parentTree, '-p', f.input.headCommit], Buffer.from('forged extra readonly input\n')).toString().trim(), readPaths = [...evidence.readPaths, 'a.txt'].sort()
  const forged = { parentCommit, parentTree, parentManifestBlob, composed, provenanceBlob: writeEvidence(f.commonDir, { ...evidence, readPaths, parentCommit, parentTree, parentManifestBlob, composed }) }
  assert.equal(f.text(forged.composed.tree, 'a.txt'), 'base-a.txt\n')
  assert.throws(() => f.store.bindPublicationBase(b.fence, forged), /read closure differs/)
  assert.throws(() => assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, readPaths), /read closure differs/)
  assert.equal(f.store.readAttempt(b.attempt.id).publicationBase, undefined)
})

test('failed/superseded发布仍有未知resource时持久阻B；真实removed后释放且不阻其它无base生成', async t => {
  const f = await fixture(t), a = f.claim('a.txt'), b = f.claim('b.txt'), aBase = assemblePublicationBase(f.store, a.operation, a.attempt, a.attempt.composedInput!, f.reads('a.txt'))
  f.store.bindPublicationBase(a.fence, aBase)
  const checkpoint = writeEvidence(f.commonDir, { native: 'unknown published-attempt resource' }), resource = f.store.planResource(a.fence, { key: 'unknown-A', kind: 'native_session', payloadDigest: 'unknown-A', inputId: f.input.id, candidateDigest: null, planBlob: checkpoint, checkpointRef: checkpoint })
  f.store.recordFailure(a.fence, { code: 'GENERATION_EXIT', kind: 'environment', message: 'publication attempt exited before native cleanup', evidenceRefs: [checkpoint] })
  const bBase = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  assert.throws(() => f.store.bindPublicationBase(b.fence, bBase), /SYNC_PUBLICATION_BUSY/)
  for (const phase of ['terminal', 'removed'] as const) f.store.recordResourceCheckpoint(resource.id, { operationId: a.operation.id, attemptId: a.attempt.id, inputId: f.input.id, candidateDigest: null, phase, expectedCheckpointRef: checkpoint, checkpointRef: checkpoint })
  assert.deepEqual(f.store.bindPublicationBase(b.fence, bBase).publicationBase, bBase)
})

test('已绑定base重入与verified新apply核全heads；legacy实际head推进后明确stale且无A journal', { timeout: 60000 }, async t => {
  const f = await fixture(t, false), a = f.claim('a.txt'), b = f.claim('b.txt'), base = assemblePublicationBase(f.store, a.operation, a.attempt, a.attempt.composedInput!, f.reads('a.txt'))
  f.store.bindPublicationBase(a.fence, base)
  // 旧冻结操作不带publicationBase，沿原真实交付路径结算，验证新门禁不会假定heads永不变。
  for (const [claimed, path, composed, content] of [[b, 'b.txt', b.attempt.composedInput!, 'delivered-B2\n'], [a, 'a.txt', base.composed, 'delivered-A1\n']] as const) {
    const before = readTree(f.commonDir, composed.tree).find(entry => entry.path === path)!, candidate = freezeCandidate(f.input, { version: 'sync-files-v1', changes: [{ path, beforeDigest: before.digest, beforeMode: before.mode, content, mode: null }] }, claimed.operation.readyScope, composed)
    f.store.freezeCandidate(claimed.fence, candidate); f.verify(claimed, candidate)
    if (path === 'b.txt') {
      await deliverVerifiedAttempt(f.store, claimed.fence, f.options)
      assert.throws(() => f.store.bindPublicationBase(a.fence, base), /PUBLICATION_BASE_STALE/)
    }
  }
  assert.throws(() => f.store.assertPublicationBaseCurrent(a.operation.id, a.attempt.id), /PUBLICATION_BASE_STALE/)
  await assert.rejects(deliverVerifiedAttempt(f.store, a.fence, f.options), /PUBLICATION_BASE_STALE/)
  assert.equal(f.store.readAttempt(a.attempt.id).status, 'verified'); assert.equal(f.store.listJournals(a.operation.id).length, 0)
})

test('不相关legacy只作诊断；已提交新HEAD对象保留，不用旧delivery覆盖', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = f.claim('a.txt'); f.freeze(a, 'a.txt', 'delivered-A1\n'); await deliverVerifiedAttempt(f.store, a.fence, f.options)
  writeFileSync(join(f.root, 'a.txt'), 'committed-A3\n'); f.git('-c', 'core.hooksPath=/dev/null', 'add', 'a.txt'); f.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'independent committed author input')
  const snapshot = await captureInputSnapshot(f.root), b = f.claim('b.txt', snapshot)
  f.protocol.withTransaction(tx => {
    const key = tx.query("SELECT source_key FROM sync_baseline_heads WHERE resource_key='path:a.txt' AND pair_id NOT LIKE '%-delivery' LIMIT 1")[0].source_key
    tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,NULL,?)', String(key), 'path:unrelated-legacy.txt', 'unknown legacy proof')
  })
  const base = assemblePublicationBase(f.store, b.operation, b.attempt, b.attempt.composedInput!, f.reads('b.txt'))
  const evidence = verifyPublicationBase(b.operation, b.attempt, base)
  assert.equal(f.text(base.parentTree, 'a.txt'), 'committed-A3\n'); assert.equal(evidence.paths.find(path => path.path === 'a.txt')?.cause, 'current_head')
  assert.deepEqual(evidence.heads.unknownPaths, [{ path: 'unrelated-legacy.txt', reason: 'unknown legacy proof' }])
  f.store.bindPublicationBase(b.fence, base)
  assert.equal(objectGit(f.commonDir, ['rev-parse', `${base.parentCommit}^{tree}`]).toString().trim(), base.parentTree)
})
