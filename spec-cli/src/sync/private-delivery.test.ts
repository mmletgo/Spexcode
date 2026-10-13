import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProtocol } from '@spexcode/session-protocol'
import { deliverVerifiedAttempt, planPrivateDelivery } from './private-delivery.js'
import type { PrivateDeliveryOptions } from './private-delivery.js'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { captureInputSnapshot, readEvidence, verifySnapshot, writeEvidence } from './snapshot.js'
import { composeInputSnapshots } from './composition.js'
import { freezeCandidate } from './candidate.js'
import type { VerificationResultBlob } from './operation-types.js'

async function fixture(t: test.TestContext, unchanged = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'spex-private-delivery-'))), root = join(parent, 'source'), managed = join(parent, 'managed'), runtime = join(parent, 'runtime')
  mkdirSync(root); mkdirSync(managed, { mode: 0o700 }); mkdirSync(join(runtime, 'dist'), { recursive: true }); mkdirSync(join(runtime, 'templates/hooks'), { recursive: true })
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Sync fixture'); git('config', 'user.email', 'sync@example.invalid')
  writeFileSync(join(root, 'a.txt'), 'base-a\n'); writeFileSync(join(root, 'b.txt'), 'base-b\n'); git('add', '.'); git('commit', '-m', 'base')
  if (!unchanged) { writeFileSync(join(root, 'a.txt'), 'staged-a\n'); git('add', 'a.txt'); writeFileSync(join(root, 'a.txt'), 'unstaged-a\n') }
  const index = readFileSync(join(root, '.git/index')), input = await captureInputSnapshot(root), scope = { paths: ['a.txt', 'b.txt'], contractIds: ['REQ-FIXTURE'], flowIds: [] }
  const protocol = openProtocol(join(root, '.git/sync.sqlite'))
  t.after(() => { protocol.close(); rmSync(parent, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(parent, 'backup.sqlite') })
  const commonDir = input.source.commonDir, store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const operation = store.admitAndEnqueue({ ingressKey: input.id, rootCauseId: input.id, origin: 'spec', input, scope, budget: { maxAttempts: 3, maxCalls: 8, maxRepairs: 2, timeoutMs: 1000000 }, delivery: null, deliveryPlan: planPrivateDelivery(input, managed, input.id), policyDigest: 'fixture-policy', impactDigest: 'fixture-impact', readSetDigest: 'fixture-read' })
  const claimed = store.claimAttempt({ operationId: operation.id, source: input.source, scope, leaseMs: 1000000 }), composed = composeInputSnapshots(input).composed!
  store.bindComposedInput(claimed.fence, composed); store.startGeneration(claimed.fence)
  const entries = verifySnapshot(input), candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: unchanged ? [] : ['a.txt', 'b.txt'].map(path => { const entry = entries.find(entry => entry.path === path)!; return { path, beforeDigest: entry.digest, beforeMode: entry.mode, content: `verified-${path}\n` } }) }, scope, composed)
  store.freezeCandidate(claimed.fence, candidate)
  const evidence = writeEvidence(commonDir, { fixture: '明确控制的V1-V3前置证明；不是模型或完整CLI产品验收' })
  const bindings = { inputId: input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, environmentDigest: 'fixture', contextDigest: 'fixture' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
  store.recordVerification(claimed.fence, { ...bindings, passed: true, coveredScope: scope, evidenceRefs: [evidence], resultBlob: writeEvidence(commonDir, result) })
  const canonical = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
  for (const name of readdirSync(canonical)) {
    copyFileSync(join(canonical, name), join(runtime, 'templates/hooks', name))
    copyFileSync(join(canonical, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  mkdirSync(join(runtime, 'dist/sync'))
  copyFileSync(fileURLToPath(new URL('../../dist/sync/trusted-footprint.js', import.meta.url)), join(runtime, 'dist/sync/trusted-footprint.js'))
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  writeFileSync(join(runtime, 'dist/cli.js'), `if(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n`)
  const options: PrivateDeliveryOptions = { managedRoot: managed, tools: { trustedRuntimeRoot: runtime, toolEntry: join(runtime, 'dist/cli.js'), canonicalHooksDir: join(runtime, 'templates/hooks'), gitPath: '/usr/bin/git' }, beforeApply: async () => { assert.equal((await captureInputSnapshot(root)).id, input.id) } }
  return { root, index, input, store, operation, fence: claimed.fence, candidate, options, git }
}

test('真实Git完整落盘和receipt，source/index保留，重入无重复提交', { timeout: 30000 }, async t => {
  const f = await fixture(t), delivered = await deliverVerifiedAttempt(f.store, f.fence, f.options), tree = f.operation.deliveryPlan.canonicalRoot
  assert.equal(delivered.operation.phase, 'workspace_synced'); assert.equal(delivered.receipt.actualTree, f.candidate.tree)
  assert.equal(readFileSync(join(tree, 'a.txt'), 'utf8'), 'verified-a.txt\n')
  assert.equal(f.git('rev-list', '--count', f.operation.deliveryPlan.branch), '2')
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  const replay = await deliverVerifiedAttempt(f.store, f.fence, f.options)
  assert.deepEqual(replay.receipt, delivered.receipt); assert.equal(f.git('rev-list', '--count', f.operation.deliveryPlan.branch), '2')
})

test('commit已发生而receipt未写时恢复真实HEAD，不重复作者提交', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, { ...f.options, afterCommit: () => { throw new Error('after commit crash') } }), /after commit crash/)
  assert.equal(f.store.readOperation(f.operation.id).phase, 'recovery_required')
  const commit = f.git('rev-parse', f.operation.deliveryPlan.branch)
  assert.notEqual(commit, f.input.headCommit)
  const recovered = await deliverVerifiedAttempt(f.store, f.fence, f.options)
  assert.equal(recovered.receipt.actualCommit, commit); assert.equal(f.git('rev-list', '--count', f.operation.deliveryPlan.branch), '2')
})

test('Git返回128但主ref已推进，按真实tree/parent/effect结算而不重复提交', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  writeFileSync(f.options.tools.toolEntry, `import { appendFileSync } from 'node:fs';\nif(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\nif(process.env.SPEXCODE_SYNC_OPERATION==='publish'&&process.argv[2]==='spec') appendFileSync(new URL(import.meta.url),'// runtime changed after prepared lint\\n');\n`)
  const delivered = await deliverVerifiedAttempt(f.store, f.fence, f.options)
  const outcome = f.store.readAttempt(f.fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => typeof value.status === 'number')
  assert.equal(outcome.status, 128); assert.match(outcome.stderr, /trusted sync tool binding/)
  assert.equal(delivered.operation.phase, 'workspace_synced'); assert.equal(f.git('rev-list', '--count', f.operation.deliveryPlan.branch), '2')
  assert.equal(f.git('show', '-s', '--format=%T', f.operation.deliveryPlan.branch), f.candidate.tree)
})

test('receipt已写但尚未结算，恢复只结算同一receipt', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, { ...f.options, afterReceipt: () => { throw new Error('after receipt crash') } }), /after receipt crash/)
  const journal = f.store.listRecoverable().find(row => row.operation.id === f.operation.id)!.journals[0], receipt = journal.receipt!
  assert.ok(receipt)
  const recovered = await deliverVerifiedAttempt(f.store, f.fence, f.options)
  assert.deepEqual(recovered.receipt, receipt); assert.equal(recovered.operation.phase, 'workspace_synced')
})

test('applying中取消完整短单元结算，原树未变且结果保留', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  const delivered = await deliverVerifiedAttempt(f.store, f.fence, { ...f.options, afterFileWrite: () => { f.store.requestControl(f.operation.id, 'cancel') } })
  assert.equal(delivered.operation.phase, 'cancelled'); assert.equal(delivered.receipt.actualTree, f.candidate.tree)
  assert.equal((await captureInputSnapshot(f.root)).id, f.input.id); assert.ok(existsSync(f.operation.deliveryPlan.canonicalRoot))
})

test('写前取消拒绝创建交付目录', async t => {
  const f = await fixture(t); f.store.requestControl(f.operation.id, 'cancel')
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /NOT_VERIFIED/)
  assert.equal(existsSync(f.operation.deliveryPlan.canonicalRoot), false); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('相同完整tree只登记已验证基线，不制造空提交', { timeout: 30000 }, async t => {
  const f = await fixture(t, true), delivered = await deliverVerifiedAttempt(f.store, f.fence, f.options)
  assert.equal(delivered.receipt.actualCommit, f.input.headCommit); assert.equal(f.git('rev-list', '--count', f.operation.deliveryPlan.branch), '1')
  assert.equal(delivered.operation.phase, 'workspace_synced')
})

test('中断后第三方更改候选文件，恢复保持原值并拒绝提交', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, { ...f.options, afterFileWrite: path => { if (path === 'a.txt') throw new Error('partial files crash') } }), /partial files crash/)
  const file = join(f.operation.deliveryPlan.canonicalRoot, 'b.txt'); writeFileSync(file, 'human private edit\n')
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /THIRD_PARTY/)
  assert.equal(readFileSync(file, 'utf8'), 'human private edit\n'); assert.equal(f.git('rev-parse', f.operation.deliveryPlan.branch), f.input.headCommit)
})

test('私有指令投影目录被重建会撤销写入授权，原source/index仍保留', { timeout: 30000 }, async t => {
  const f = await fixture(t), footprint = join(dirname(f.operation.deliveryPlan.canonicalRoot), 'footprint')
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, { ...f.options, afterFileWrite: path => {
    if (path !== 'a.txt') return
    renameSync(footprint, `${footprint}-old`); mkdirSync(footprint, { mode: 0o700 })
  } }), /OWNERSHIP/)
  assert.equal(f.store.readOperation(f.operation.id).phase, 'recovery_required')
  assert.equal((await captureInputSnapshot(f.root)).id, f.input.id); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('无owner的既有空parent不能被认领为自己的交付', { timeout: 30000 }, async t => {
  const f = await fixture(t), parent = dirname(f.operation.deliveryPlan.canonicalRoot)
  mkdirSync(parent, { mode: 0o700 }); mkdirSync(join(parent, 'staging')); mkdirSync(join(parent, 'footprint'))
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /UNOWNED/)
  assert.equal(existsSync(join(parent, 'owner.json')), false); assert.equal(existsSync(f.operation.deliveryPlan.canonicalRoot), false)
})

test('prepare失败后的精确base可由重新验证的新attempt接管，旧fence仍失权', { timeout: 40000 }, async t => {
  const f = await fixture(t)
  writeFileSync(f.options.tools.toolEntry, `if(process.argv[2]==='internal'&&process.argv[3]==='refresh-footprint') process.exit(1);\nif(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n`)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /PREPARE_FAILED/)
  assert.ok(existsSync(join(f.operation.deliveryPlan.canonicalRoot, '.git')))
  assert.equal(f.store.readAttempt(f.fence.attemptId).status, 'failed')
  writeFileSync(f.options.tools.toolEntry, `if(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n`)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /NOT_VERIFIED/)
  const previous = f.store.readAttempt(f.fence.attemptId), operation = f.store.readOperation(f.operation.id)
  const retry = f.store.claimAttempt({ operationId: operation.id, source: f.input.source, scope: operation.scope, leaseMs: 1000000 })
  f.store.bindComposedInput(retry.fence, previous.composedInput!); f.store.startGeneration(retry.fence)
  f.store.freezeCandidate(retry.fence, f.candidate); f.store.recordVerification(retry.fence, previous.verification!)
  const delivered = await deliverVerifiedAttempt(f.store, retry.fence, f.options)
  assert.equal(delivered.operation.phase, 'workspace_synced'); assert.equal(f.git('rev-list', '--count', operation.deliveryPlan.branch), '2')
  assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
})

test('prepare失败树已被第三方编辑时，新attempt不能接管或覆盖', { timeout: 30000 }, async t => {
  const f = await fixture(t)
  writeFileSync(f.options.tools.toolEntry, `if(process.argv[2]==='internal'&&process.argv[3]==='refresh-footprint') process.exit(1);\n`)
  await assert.rejects(deliverVerifiedAttempt(f.store, f.fence, f.options), /PREPARE_FAILED/)
  const file = join(f.operation.deliveryPlan.canonicalRoot, 'a.txt'); writeFileSync(file, 'third-party preparation edit\n')
  const previous = f.store.readAttempt(f.fence.attemptId), operation = f.store.readOperation(f.operation.id)
  const retry = f.store.claimAttempt({ operationId: operation.id, source: f.input.source, scope: operation.scope, leaseMs: 1000000 })
  f.store.bindComposedInput(retry.fence, previous.composedInput!); f.store.startGeneration(retry.fence)
  f.store.freezeCandidate(retry.fence, f.candidate); f.store.recordVerification(retry.fence, previous.verification!)
  await assert.rejects(deliverVerifiedAttempt(f.store, retry.fence, f.options), /已有非base内容/)
  assert.equal(readFileSync(file, 'utf8'), 'third-party preparation edit\n')
  const owner = JSON.parse(readFileSync(join(dirname(operation.deliveryPlan.canonicalRoot), 'owner.json'), 'utf8'))
  assert.equal(owner.attemptId, f.fence.attemptId); assert.equal(f.git('rev-parse', operation.deliveryPlan.branch), f.input.headCommit)
})
