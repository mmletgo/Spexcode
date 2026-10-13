import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { openProtocol } from '@spexcode/session-protocol'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { captureInputSnapshot, contentHash, readEvidence, verifySnapshot, writeEvidence } from './snapshot.js'
import { composeInputSnapshots } from './composition.js'
import { freezeCandidate } from './candidate.js'
import { applyJournalFiles, prepareApplyPlan } from './apply-files.js'
import type { ApplyFilesOptions } from './apply-files.js'
import type { CandidateChanges } from './candidate.js'
import type { InputSnapshot, SyncScope, VerificationRef, VerificationResultBlob } from './operation-types.js'

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim()
const change = (snapshot: InputSnapshot, path: string, content: string | null, mode?: '100644' | '100755'): CandidateChanges['changes'][number] => { const entry = verifySnapshot(snapshot).find(entry => entry.path === path); return { path, content, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, ...(mode ? { mode } : {}) } }
async function fixture(t: test.TestContext, build?: (input: InputSnapshot) => CandidateChanges, mutateSource?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'sync-apply-test-'))
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'apply@example.invalid'); git(root, 'config', 'user.name', 'apply fixture')
  writeFileSync(join(root, 'a.ts'), 'old-a\n'); writeFileSync(join(root, 'b.ts'), 'old-b\n'); mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder/child.ts'), 'old-child\n'); symlinkSync('b.ts', join(root, 'unchanged-link'))
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  const deliveryParent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-private-delivery-'))), targetRoot = join(deliveryParent, 'worktree'), stagingDirectory = join(deliveryParent, 'staging')
  mkdirSync(stagingDirectory, { mode: 0o700 }); git(root, 'worktree', 'add', '-b', 'private-delivery', targetRoot, 'HEAD')
  writeFileSync(join(root, 'a.ts'), 'source-staged\n'); git(root, 'add', 'a.ts'); writeFileSync(join(root, 'a.ts'), 'source-unstaged\n')
  mutateSource?.(root)
  const sourceIndex = readFileSync(join(root, '.git/index')), input = await captureInputSnapshot(root), target = await captureInputSnapshot(targetRoot), targetIndex = readFileSync(join(target.source.gitDir, 'index'))
  const coveredScope: SyncScope = { paths: ['a.ts', 'b.ts', 'folder', 'unchanged-link', 'new-link', 'chain-link'], contractIds: ['REQ-APPLY'], flowIds: ['FLOW-APPLY'] }
  const protocol = openProtocol(join(root, '.git/apply.sqlite'))
  t.after(() => { protocol.close(); rmSync(deliveryParent, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(root, '.git/apply.backup') })
  const commonDir = input.source.commonDir, store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const operation = store.admitAndEnqueue({ ingressKey: input.id, rootCauseId: 'fixture', origin: 'combined', input, scope: coveredScope, budget: { maxAttempts: 3, maxCalls: 6, maxRepairs: 2, timeoutMs: 1000000 }, delivery: target.source, deliveryPlan: { canonicalRoot: target.source.canonicalRoot, branch: target.source.branch, baseCommit: target.headCommit }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read' })
  const claimed = store.claimAttempt({ operationId: operation.id, source: input.source, scope: coveredScope, leaseMs: 1000000 })
  const composed = composeInputSnapshots(input).composed!
  store.bindComposedInput(claimed.fence, composed); store.startGeneration(claimed.fence)
  const changes = build?.(input) ?? { version: 'sync-files-v1', changes: [change(input, 'a.ts', 'candidate-a\n'), change(input, 'b.ts', 'candidate-b\n', '100755')] }
  const candidate = freezeCandidate(input, changes, coveredScope, composed); store.freezeCandidate(claimed.fence, candidate)
  const evidence = writeEvidence(commonDir, { fixture: '前置验证门禁的可控测试证据' })
  const bindings = { inputId: input.id, candidateDigest: candidate.digest, policyDigest: 'policy', readSetDigest: 'read', environmentDigest: 'fixture', contextDigest: 'context' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
  const verification: VerificationRef = { ...bindings, passed: true, coveredScope, evidenceRefs: [evidence], resultBlob: writeEvidence(commonDir, result) }
  store.recordVerification(claimed.fence, verification)
  const plan = prepareApplyPlan(store.readOperation(operation.id), store.readAttempt(claimed.attempt.id), target), journal = store.beginApply(claimed.fence, plan, target)
  let authorityChecks = 0
  const ownerPath = join(deliveryParent, 'owner.json'), rootStat = lstatSync(stagingDirectory, { bigint: true })
  writeFileSync(ownerPath, JSON.stringify({ target: target.source, stagingDirectory, stagingFingerprint: contentHash(`${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeNs}`), journalId: journal.id, attemptId: claimed.attempt.id }))
  const options: ApplyFilesOptions = { stagingDirectory, assertExclusivePrivateDelivery: (identity, staging) => {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
    assert.equal(identity.canonicalRoot, owner.target.canonicalRoot); assert.equal(identity.physicalFingerprint, owner.target.physicalFingerprint)
    assert.equal(staging.rootDirectory, owner.stagingDirectory); assert.equal(staging.journalId, owner.journalId); assert.equal(staging.attemptId, owner.attemptId)
    assert.ok(staging.directory === owner.stagingDirectory || dirname(staging.directory) === owner.stagingDirectory && basename(staging.directory).startsWith(`journal-${contentHash(`${journal.id}:${claimed.attempt.id}`).slice(0, 24)}-`))
    const stat = lstatSync(staging.directory, { bigint: true }); assert.equal(stat.isSymbolicLink(), false); assert.equal(staging.physicalFingerprint, contentHash(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`))
    if (staging.directory === owner.stagingDirectory) assert.equal(staging.physicalFingerprint, owner.stagingFingerprint)
    authorityChecks++
  } }
  return { root, targetRoot: target.source.canonicalRoot, input, target, sourceIndex, targetIndex, store, operation, claimed, candidate, plan, journal, options, stagingDirectory, ownerPath, checks: () => authorityChecks }
}

test('写后checkpoint故障由真实journal恢复postimage，已完成文件不重复改，source/index不变', async t => {
  const f = await fixture(t)
  assert.deepEqual(prepareApplyPlan(f.store.readOperation(f.operation.id), { ...f.store.readAttempt(f.claimed.attempt.id), status: 'verified' }, { ...f.target, capturedAtMs: f.target.capturedAtMs + 1000 }), f.plan)
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, afterFileWrite: path => { if (path === 'a.ts') throw new Error('injected checkpoint boundary crash') } }), /injected/)
  assert.equal(f.store.readOperation(f.operation.id).phase, 'recovery_required'); assert.equal(f.store.readJournal(f.journal.id).steps[0].status, 'planned')
  const stat = lstatSync(join(f.targetRoot, 'a.ts'), { bigint: true })
  const result = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  assert.ok(result.replayedPaths.includes('a.ts')); assert.equal(lstatSync(join(f.targetRoot, 'a.ts'), { bigint: true }).ino, stat.ino); assert.equal(lstatSync(join(f.targetRoot, 'a.ts'), { bigint: true }).mtimeNs, stat.mtimeNs)
  assert.equal(result.snapshot.immutableTree, f.candidate.tree); assert.equal(lstatSync(join(f.targetRoot, 'b.ts')).mode & 0o111, 0o111)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.sourceIndex); assert.deepEqual(readFileSync(join(f.target.source.gitDir, 'index')), f.targetIndex); assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), 'source-unstaged\n')
  assert.ok(f.checks() >= 5); assert.equal(f.store.readJournal(f.journal.id).receipt, null)
  const completed = lstatSync(join(f.targetRoot, 'b.ts'), { bigint: true }), replay = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  assert.deepEqual(replay.replayedPaths, ['a.ts', 'b.ts']); assert.equal(lstatSync(join(f.targetRoot, 'b.ts'), { bigint: true }).mtimeNs, completed.mtimeNs)
})

test('预检全部文件，第三方值保留，第一文件也不被提前覆盖', async t => {
  const f = await fixture(t); writeFileSync(join(f.targetRoot, 'b.ts'), 'third-party\n')
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options), /SYNC_APPLY_THIRD_PARTY/)
  assert.equal(readFileSync(join(f.targetRoot, 'a.ts'), 'utf8'), 'old-a\n'); assert.equal(readFileSync(join(f.targetRoot, 'b.ts'), 'utf8'), 'third-party\n'); assert.equal(f.store.readOperation(f.operation.id).phase, 'recovery_required')
})

test('完成一步后第三方编辑后续路径，恢复不覆盖它或重写已完成文件', async t => {
  const f = await fixture(t)
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, afterStepRecord: path => { if (path === 'a.ts') writeFileSync(join(f.targetRoot, 'b.ts'), 'human after checkpoint\n') } }), /SYNC_APPLY_THIRD_PARTY/)
  const stat = lstatSync(join(f.targetRoot, 'a.ts'), { bigint: true })
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options), /SYNC_APPLY_THIRD_PARTY/)
  assert.equal(lstatSync(join(f.targetRoot, 'a.ts'), { bigint: true }).mtimeNs, stat.mtimeNs); assert.equal(readFileSync(join(f.targetRoot, 'b.ts'), 'utf8'), 'human after checkpoint\n')
})

test('applying取消仍完成已登记短单元，根协调器结算receipt后才cancelled', async t => {
  const f = await fixture(t)
  const result = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, afterFileWrite: path => { if (path === 'a.ts') f.store.requestControl(f.operation.id, 'cancel') } })
  assert.equal(f.store.readOperation(f.operation.id).phase, 'cancelling'); assert.ok(f.store.readJournal(f.journal.id).steps.every(step => step.status === 'completed')); assert.equal(result.snapshot.immutableTree, f.candidate.tree)
  const receipt = { id: 'root-receipt', journalId: f.journal.id, effectKey: f.plan.effectKey, actualTree: result.snapshot.immutableTree, actualCommit: null, deliverySnapshot: result.snapshot, evidenceRefs: result.evidenceRefs, completedAtMs: Date.now() }
  f.store.recordReceipt(f.journal.id, receipt); assert.equal(f.store.settleApply(f.journal.id, receipt.id).phase, 'cancelled')
})

test('file与directory双向转换安全删除已计划子文件，只读未变symlink，完整重复恢复', async t => {
  const f = await fixture(t, input => ({ version: 'sync-files-v1', changes: [change(input, 'a.ts', null), change(input, 'a.ts/new.ts', 'new child\n'), change(input, 'folder/child.ts', null), change(input, 'folder', 'folder becomes file\n')] }))
  const result = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  assert.equal(result.snapshot.immutableTree, f.candidate.tree); assert.equal(readFileSync(join(f.targetRoot, 'a.ts/new.ts'), 'utf8'), 'new child\n'); assert.equal(readFileSync(join(f.targetRoot, 'folder'), 'utf8'), 'folder becomes file\n'); assert.ok(lstatSync(join(f.targetRoot, 'unchanged-link')).isSymbolicLink())
  assert.equal((await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)).snapshot.immutableTree, f.candidate.tree)
})

test('目录转换不递归删除未知文件，symlink父目录不跟随', async t => {
  const f = await fixture(t, input => ({ version: 'sync-files-v1', changes: [change(input, 'folder/child.ts', null), change(input, 'folder', 'replace dir')] }))
  writeFileSync(join(f.targetRoot, 'folder/unplanned.ts'), 'human value')
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options), /SYNC_APPLY_DIRECTORY_CONFLICT/)
  assert.equal(readFileSync(join(f.targetRoot, 'folder/unplanned.ts'), 'utf8'), 'human value'); assert.equal(readFileSync(join(f.targetRoot, 'folder/child.ts'), 'utf8'), 'old-child\n')
  rmSync(join(f.targetRoot, 'folder'), { recursive: true }); symlinkSync(f.root, join(f.targetRoot, 'folder'))
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options), /SYNC_APPLY_PARENT_SYMLINK|SYNC_APPLY_THIRD_PARTY/)
  assert.ok(lstatSync(join(f.targetRoot, 'folder')).isSymbolicLink())
})

test('无变更计划返回真实完整snapshot；所有权/原source/验证范围错误拒绝', async t => {
  const f = await fixture(t, input => ({ version: 'sync-files-v1', changes: [change(input, 'a.ts', 'old-a\n')] }))
  assert.deepEqual(f.plan.files, [])
  assert.equal((await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)).snapshot.immutableTree, f.candidate.tree)
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, assertExclusivePrivateDelivery: () => { throw new Error('not exclusively owned') } }), /not exclusively/)
  const op = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(f.claimed.attempt.id)
  assert.throws(() => prepareApplyPlan({ ...op, delivery: f.input.source }, { ...attempt, status: 'verified' }, f.input), /PRIVATE_DELIVERY/)
  // 执行期失败状态不伪装ready；计划生成单独验证差量超出已验证路径。
  const expanded = await fixture(t)
  const expandedAttempt = expanded.store.readAttempt(expanded.claimed.attempt.id)
  assert.throws(() => prepareApplyPlan(expanded.store.readOperation(expanded.operation.id), { ...expandedAttempt, status: 'verified', verification: { ...expandedAttempt.verification!, coveredScope: { paths: ['a.ts'], contractIds: ['REQ-APPLY'], flowIds: ['FLOW-APPLY'] } } }, expanded.target), /SYNC_APPLY_SCOPE/)
})


test('来源新增安全内部链接与链在fresh delivery原子应用，postimage恢复不重新创建', async t => {
  const f = await fixture(t, undefined, root => { symlinkSync('b.ts', join(root, 'new-link')); symlinkSync('new-link', join(root, 'chain-link')) })
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, afterFileWrite: path => { if (path === 'new-link') throw new Error('link checkpoint crash') } }), /link checkpoint/)
  const stat = lstatSync(join(f.targetRoot, 'new-link'), { bigint: true })
  const result = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  assert.equal(result.snapshot.immutableTree, f.candidate.tree); assert.ok(result.replayedPaths.includes('new-link')); assert.equal(lstatSync(join(f.targetRoot, 'new-link'), { bigint: true }).ino, stat.ino); assert.equal(lstatSync(join(f.targetRoot, 'new-link'), { bigint: true }).mtimeNs, stat.mtimeNs); assert.equal(readFileSync(join(f.targetRoot, 'chain-link'), 'utf8'), 'candidate-b\n')
})

test('模型新增链接、外部链接目标与循环链接拒绝；第三方link值保留', async t => {
  const ordinary = await fixture(t)
  assert.throws(() => freezeCandidate(ordinary.input, { version: 'sync-files-v1', changes: [{ path: 'new-link', beforeDigest: null, beforeMode: null, content: 'b.ts', mode: '120000' }] }, ordinary.operation.scope), /schema/)
  await assert.rejects(fixture(t, undefined, root => symlinkSync('/etc/passwd', join(root, 'new-link'))), /符号链接越界/)
  await assert.rejects(fixture(t, undefined, root => { symlinkSync('chain-link', join(root, 'new-link')); symlinkSync('new-link', join(root, 'chain-link')) }), /循环链接/)
  const source = await fixture(t, undefined, root => symlinkSync('b.ts', join(root, 'new-link')))
  symlinkSync('a.ts', join(source.targetRoot, 'new-link'))
  await assert.rejects(applyJournalFiles(source.store, source.claimed.fence, source.journal.id, source.options), /SYNC_APPLY_THIRD_PARTY/)
  assert.equal(readFileSync(join(source.targetRoot, 'new-link'), 'utf8'), 'old-a\n')
})


test('目录替换安全来源链接后receipt前重入，旧子文件删除可重放而不跟随链接', async t => {
  const f = await fixture(t, undefined, root => { rmSync(join(root, 'folder'), { recursive: true }); symlinkSync('b.ts', join(root, 'folder')) })
  const first = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  const stat = lstatSync(join(f.targetRoot, 'folder'), { bigint: true })
  const replay = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
  assert.equal(first.snapshot.immutableTree, f.candidate.tree); assert.equal(replay.snapshot.immutableTree, f.candidate.tree); assert.equal(lstatSync(join(f.targetRoot, 'folder'), { bigint: true }).ino, stat.ino)
})

test('来源链接替换目录首次预检与重复恢复不跟随应删preimage链接', async t => {
  const f = await fixture(t, undefined, root => { rmSync(join(root, 'unchanged-link')); mkdirSync(join(root, 'unchanged-link')); writeFileSync(join(root, 'unchanged-link/child.ts'), 'source child\n') })
  assert.equal((await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)).snapshot.immutableTree, f.candidate.tree)
  assert.equal((await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)).snapshot.immutableTree, f.candidate.tree)
})

for (const bytesWritten of [0, 3]) {
  test(`真实应用子进程暂存${bytesWritten}bytes后SIGKILL，保留残片并恢复同一journal`, async t => {
    const f = await fixture(t)
    const child = `
      import assert from 'node:assert/strict';
      import { readFileSync, lstatSync, writeSync, fsyncSync } from 'node:fs';
      import { openProtocol } from '@spexcode/session-protocol';
      import { SyncStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
      import { applyJournalFiles } from ${JSON.stringify(new URL('./apply-files.ts', import.meta.url).href)};
      import { readEvidence, contentHash } from ${JSON.stringify(new URL('./snapshot.ts', import.meta.url).href)};
      const state = JSON.parse(readFileSync(0, 'utf8'));
      const owner = JSON.parse(readFileSync(state.ownerPath, 'utf8'));
      const protocol = openProtocol(state.dbPath);
      const store = new SyncStore(protocol, { readBlob: ref => readEvidence(state.commonDir, ref) });
      await applyJournalFiles(store, state.fence, state.journalId, {
        stagingDirectory: state.stagingDirectory,
        assertExclusivePrivateDelivery: (target, staging) => {
          assert.equal(target.physicalFingerprint, owner.target.physicalFingerprint);
          assert.equal(target.canonicalRoot, owner.target.canonicalRoot);
          assert.equal(staging.rootDirectory, owner.stagingDirectory);
          assert.equal(staging.journalId, owner.journalId); assert.equal(staging.attemptId, owner.attemptId);
          const stat = lstatSync(staging.directory, { bigint: true });
          assert.equal(staging.physicalFingerprint, contentHash(stat.dev+':'+stat.ino+':'+stat.birthtimeNs));
        },
        afterStagingFileOpen: (path, fd) => {
          if (state.bytesWritten) writeSync(fd, Buffer.from('can'));
          fsyncSync(fd); process.stdout.write(JSON.stringify({ path }));
          process.kill(process.pid, 'SIGKILL');
        }
      });
    `
    const crashed = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { input: JSON.stringify({ dbPath: join(f.root, '.git/apply.sqlite'), commonDir: f.input.source.commonDir, fence: f.claimed.fence, journalId: f.journal.id, stagingDirectory: f.stagingDirectory, ownerPath: f.ownerPath, bytesWritten }), encoding: 'utf8', timeout: 30000 })
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr)
    const temporary = (JSON.parse(crashed.stdout) as { path: string }).path, fragment = readFileSync(temporary)
    assert.equal(fragment.length, bytesWritten); assert.equal(f.store.readJournal(f.journal.id).steps.find(step => step.key === 'a.ts')!.status, 'planned')
    assert.equal(readFileSync(join(f.targetRoot, 'a.ts'), 'utf8'), 'old-a\n')
    const result = await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)
    assert.equal(result.snapshot.immutableTree, f.candidate.tree); assert.deepEqual(readFileSync(temporary), fragment)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.sourceIndex); assert.deepEqual(readFileSync(join(f.target.source.gitDir, 'index')), f.targetIndex); assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), 'source-unstaged\n')
    assert.ok(readdirSync(f.stagingDirectory).length >= 2); assert.equal(readdirSync(f.targetRoot).some(name => name.startsWith('.spex-sync-')), false)
  })
}

test('暂存目录拒绝source/target内部与symlink，未知残片与其它namespace链接不采用或删除', async t => {
  const f = await fixture(t)
  for (const stagingDirectory of [f.targetRoot, f.root, relative(process.cwd(), f.stagingDirectory)]) await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, stagingDirectory }), /SYNC_APPLY_STAGING_INVALID/)
  const alias = join(dirname(f.stagingDirectory), 'alias'); symlinkSync(f.stagingDirectory, alias)
  await assert.rejects(applyJournalFiles(f.store, f.claimed.fence, f.journal.id, { ...f.options, stagingDirectory: alias }), /SYNC_APPLY_STAGING_INVALID/)
  const unknown = join(f.stagingDirectory, 'unknown.tmp'); writeFileSync(unknown, 'not owned by this apply invocation')
  const unadopted = join(f.stagingDirectory, `journal-${contentHash(`${f.journal.id}:${f.claimed.attempt.id}`).slice(0, 24)}-unadopted`); symlinkSync(f.root, unadopted)
  assert.equal((await applyJournalFiles(f.store, f.claimed.fence, f.journal.id, f.options)).snapshot.immutableTree, f.candidate.tree)
  assert.equal(readFileSync(unknown, 'utf8'), 'not owned by this apply invocation'); assert.ok(lstatSync(unadopted).isSymbolicLink()); assert.equal(readFileSync(join(f.root, 'a.ts'), 'utf8'), 'source-unstaged\n')
})
