import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { parseContract, validateContractGraph } from '@spexcode/spec-core/contracts'
import { analyzeCodeBehavior } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { freezeCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import { migrateSyncStore } from './migrations.js'
import { prepareSyncAdmission, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { planSyncPartitions, projectSyncPartition } from './partitioning.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, verifySnapshot, writeEvidence } from './snapshot.js'
import { readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'
import { SyncStore } from './store.js'
import { SyncApplication } from './application.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { deliverVerifiedAttempt } from './private-delivery.js'
import type { BaselinePair, BaselineResource, FrozenBaselineSelection, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import type { SyncSettings } from './settings.js'

const specA = '.spec/export/export-contract/spec.md', specB = '.spec/other/other-contract/spec.md'
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()

async function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-policy-planning-')), root = join(parent, 'source'), deliveryRoot = join(parent, 'delivery')
  mkdirSync(root); cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  mkdirSync(join(root, '.spec/other/other-contract'), { recursive: true })
  const original = readFileSync(join(root, specA), 'utf8'), other = original.replaceAll('EXPORT', 'OTHER').replaceAll('export-contract', 'other-contract').replaceAll('export.js', 'other.js').replaceAll('export.test.mjs', 'other.test.mjs')
  writeFileSync(join(root, specB), other)
  cpSync(join(root, 'src/export.js'), join(root, 'src/other.js')); cpSync(join(root, 'tests/export.test.mjs'), join(root, 'tests/other.test.mjs'))
  const config: SyncSettings = {
    version: 'sync-settings-v1', nodeIds: ['export-contract', 'other-contract'], sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: [], facts: [],
    budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 30000 },
    verifications: [original, other].map((source, index) => {
      const verify = parseContract({ nodeId: index ? 'other-contract' : 'export-contract', path: index ? specB : specA, source }).contract!.items.find(item => item.kind === 'VERIFY')!
      assert.equal(verify.kind, 'VERIFY')
      return { definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }
    }),
    mandatoryTests: [{ verificationId: 'VERIFY-EXPORT-01', testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }, { verificationId: 'VERIFY-OTHER-01', testPath: 'tests/other.test.mjs', testId: 'AC-OTHER-03' }],
  }
  const configure = (): void => writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ sync: config }))
  configure(); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', '真实政策规划夹具'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'two independent versioned oracle policies')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD')
  const source = await captureInputSnapshot(root), delivery = await captureInputSnapshot(deliveryRoot)
  t.after(() => {
    const directories = [parent]
    while (directories.length) { const directory = directories.pop()!; chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) directories.push(join(directory, entry.name)) }
    rmSync(parent, { recursive: true, force: true })
  })
  return { parent, root, source, delivery, original, other, config, configure }
}

/** 真实store动作建立旧政策pair；Git对象与receipt真实，四层验证显式fake，不是产品验收。 */
async function settleBaseline(t: test.TestContext, parent: string, source: InputSnapshot, delivery: InputSnapshot, requestedScope?: SyncScope): Promise<BaselinePair> {
  const protocol = openProtocol(join(parent, 'policy.sqlite')); t.after(() => protocol.close())
  await migrateSyncStore(protocol, { backupPath: join(parent, 'backup.sqlite') })
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(source.source.commonDir, ref) }), put = (value: unknown) => writeEvidence(source.source.commonDir, value)
  const contract = parseContract({ nodeId: 'export-contract', path: specA, source: readObject(source.source.commonDir, verifySnapshot(source).find(entry => entry.path === specA)!.oid).toString('utf8') }).contract!
  const scope: SyncScope = requestedScope ?? { paths: [specA, 'src/export.js'], contractIds: contract.items.filter(item => !['VERIFY', 'FLOW'].includes(item.kind)).map(item => item.id), flowIds: contract.items.filter(item => item.kind === 'FLOW').map(item => item.id) }
  const operation = store.admitAndEnqueue({ ingressKey: 'policy-baseline', rootCauseId: 'policy-baseline', origin: 'spec', input: source, scope, budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 100000 }, policyDigest: 'fake-policy', impactDigest: 'fake-impact', readSetDigest: 'fake-read', delivery: null, deliveryPlan: { canonicalRoot: delivery.source.canonicalRoot, branch: delivery.source.branch, baseCommit: source.headCommit } })
  const claim = store.claimAttempt({ operationId: operation.id, source: source.source, scope, leaseMs: 100000, expectedMessageId: operation.dispatchMessageId })
  store.bindDelivery(claim.fence, delivery.source); store.bindComposedInput(claim.fence, composeInputSnapshots(source).composed!)
  store.startGeneration(claim.fence, { readyScope: scope, blockedScope: { paths: [], contractIds: [], flowIds: [] }, blockedReason: null })
  const candidate = { sourceInputId: source.id, baseTree: source.immutableTree, tree: delivery.immutableTree, digest: delivery.contentDigest, manifestBlob: delivery.manifestBlob, actualDiffBlob: put([]), coveredScope: scope }
  store.freezeCandidate(claim.fence, candidate)
  const fake = put({ fake: true, reason: '仅用于旧政策基线夹具，非业务验证' }), bindings = { inputId: source.id, candidateDigest: candidate.digest, policyDigest: 'fake-policy', readSetDigest: 'fake-read', environmentDigest: 'fake-env', contextDigest: 'fake-context' }
  const verification: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [fake] })) }
  const resultBlob = put(verification); store.recordVerification(claim.fence, { ...bindings, passed: true, coveredScope: scope, evidenceRefs: [fake], resultBlob })
  const plan = { effectKey: 'policy-delivery', payloadDigest: 'policy-delivery', candidateDigest: candidate.digest, verificationBlob: resultBlob, target: delivery.source, expectedTargetSnapshotId: source.id, expectedBaselinePairId: null, coveredScope: scope, files: [], planBlob: put({ files: [], candidateDigest: candidate.digest }) }
  const journal = store.beginApply(claim.fence, plan, { ...source, source: delivery.source })
  for (const step of journal.steps) store.recordApplyStep(claim.fence, journal.id, { ...step, status: 'completed' })
  const receipt = { id: 'receipt-policy', journalId: journal.id, effectKey: 'policy-delivery', actualTree: delivery.immutableTree, actualCommit: delivery.headCommit, deliverySnapshot: delivery, evidenceRefs: [fake], completedAtMs: Date.now() }
  store.recordReceipt(journal.id, receipt); store.settleApply(journal.id, receipt.id)
  return store.readBaseline(source.source)!
}

async function context(snapshot: InputSnapshot, paths: readonly string[]) {
  return readFrozenContracts(snapshot.source.canonicalRoot, new Map(verifySnapshot(snapshot).filter(entry => paths.includes(entry.path)).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')])))
}

test('正式adoption的插件实例不进入业务规划，真实业务子树和验证政策继续纳入', async t => {
  const f = await fixture(t)
  cpSync(new URL('../../templates/spec/project/.plugins/', import.meta.url), join(f.root, '.spec/export/export-contract/.plugins'), { recursive: true })
  const snapshot = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(snapshot, 'export-contract')
  assert.deepEqual(plan.targets, [{ nodeId: 'export-contract', path: specA }])
  assert.ok(![...plan.readPaths, ...plan.writePaths, ...plan.executionScope.paths].some(path => path.split('/').includes('.plugins')))
  assert.ok(plan.readPaths.includes('src/export.js'))
  assert.deepEqual(plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01'])
  assert.deepEqual(plan.mandatoryTests, [f.config.mandatoryTests[0]])
  const pluginScript = verifySnapshot(snapshot).find(entry => entry.path === '.spec/export/export-contract/.plugins/core/session-fail/fail.sh')!
  assert.throws(() => freezeCandidate(snapshot, { version: 'sync-files-v1', changes: [{ path: pluginScript.path, beforeDigest: pluginScript.digest, beforeMode: pluginScript.mode, content: 'exit 0\n' }] }, plan.executionScope), /越界/)
  const files = new Map(verifySnapshot(snapshot).filter(entry => entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  assert.ok(!(await readFrozenContracts(f.root, files)).nodes.some(node => node.path.split('/').includes('.plugins')))
  await assert.rejects(buildSyncApplicationPlan(snapshot, 'session-fail'), /不存在 Spec 节点/)
  cpSync(new URL('../../templates/spec/project/.plugins/', import.meta.url), join(f.delivery.source.canonicalRoot, '.spec/export/export-contract/.plugins'), { recursive: true })
  const baseline = await settleBaseline(t, f.parent, snapshot, await captureInputSnapshot(f.delivery.source.canonicalRoot))
  const protectedPlan = await buildSyncApplicationPlan(snapshot, 'export-contract', baseline)
  assert.deepEqual(protectedPlan.targets, plan.targets)
  assert.ok(![...protectedPlan.readPaths, ...protectedPlan.writePaths, ...protectedPlan.executionScope.paths].some(path => path.split('/').includes('.plugins')))
  assert.deepEqual(protectedPlan.mandatoryTests, plan.mandatoryTests)
})

test('两节点真实Git规划按意图筛政策，不把独立B oracle或VERIFY送给A候选', async t => {
  const f = await fixture(t), plan = await buildSyncApplicationPlan(f.source, 'export-contract')
  assert.deepEqual(plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01'])
  assert.deepEqual(plan.mandatoryTests, [f.config.mandatoryTests[0]])
  assert.ok(!plan.readPaths.includes(specB)); assert.ok(!plan.readPaths.includes('tests/other.test.mjs'))
  assert.ok(!plan.executionScope.paths.some(path => path.includes('other')))
  const resources = await deriveSyncBaselineResources(f.source, plan)
  assert.ok(!resources.some(resource => resource.kind === 'path' && resource.path.includes('other')))
  const frozen = await context(f.source, plan.readPaths)
  for (const mandatory of plan.mandatoryTests) assert.equal(frozen.graph.items.get(mandatory.verificationId)?.kind, 'VERIFY')
  for (const content of [null, 'test("fake", () => {})\n']) {
    const entry = verifySnapshot(f.source).find(entry => entry.path === 'tests/export.test.mjs')!
    assert.throws(() => freezeCandidate(f.source, { version: 'sync-files-v1', changes: [{ path: entry.path, beforeDigest: entry.digest, beforeMode: entry.mode, content }] }, plan.executionScope), /越界/)
  }
  for (const changed of [f.original.replace('| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |', ''), f.original.replace('10000 |', '1000 |')]) {
    const files = new Map(frozen.files); files.set(specA, changed)
    const after = await readFrozenContracts(f.root, files)
    assert.ok(checkGenerationContractIntent(frozen, after, { newNodeRawSources: new Map(), verifications: plan.verifications.map(item => item.definition) }).some(finding => /protected|verification/.test(finding.code)))
  }
  const evidenceRoot = process.env.SPEX_COMPOSITION_EVIDENCE_DIR
  if (evidenceRoot) writeFileSync(join(evidenceRoot, 'planner-policy-after.json'), JSON.stringify({ limitation: '真实Git/snapshot/planner及候选硬门禁；无native/Docker', source: f.source, config: f.config, plan, resources, candidateVerifyIds: [...frozen.graph.items.values()].filter(item => item.kind === 'VERIFY').map(item => item.id) }, null, 2))
})

for (const mode of ['dependency', 'explicit-read'] as const) test(`readonly ${mode} owner的VERIFY定义保candidate严格登记，但不全跑其无关mandatory`, async t => {
  const f = await fixture(t)
  const row = f.original.split('\n').find(line => line.startsWith('| RULE-EXPORT-05 |'))!
  if (mode === 'dependency') writeFileSync(join(f.root, specA), f.original.replace(row, row.replace(/RULE-EXPORT-03 \|$/, 'RULE-OTHER-01 |')))
  else { f.config.readPaths = [specB]; f.configure() }
  const source = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(source, 'export-contract')
  assert.ok(plan.readPaths.includes(specB)); assert.ok(!plan.targets.some(target => target.nodeId === 'other-contract'))
  assert.deepEqual(plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01', 'VERIFY-OTHER-01'])
  assert.deepEqual(plan.mandatoryTests, [f.config.mandatoryTests[0]])
  const frozen = await context(source, plan.readPaths)
  assert.deepEqual(checkGenerationContractIntent(frozen, frozen, { newNodeRawSources: new Map(), verifications: plan.verifications.map(item => item.definition) }), [])
  assert.ok(!plan.executionScope.paths.includes(specB)); assert.ok(!plan.executionScope.paths.includes('tests/other.test.mjs'))
})

test('raw-only冷启动读取已授权测试正文且不扩大到其他目录', async t => {
  const f = await fixture(t), testPaths = ['backend/tests', 'contracts/tests', 'frontend/src', 'qlib-engine/tests', 'runtime-support/tests', 'worker/tests', 'scripts/tests']
  const testFiles = [
    ['backend/tests/domain/test_recovery_ports.py', 'def test_recovery_port_contract():\n    assert True\n'],
    ['worker/tests/test_worker_llm.py', 'def test_worker_llm_contract():\n    assert True\n'],
    ['scripts/tests/test_sync_verification.py', 'def test_sync_verification_contract():\n    assert True\n'],
  ] as const
  const outsideTestPath = 'tests/other.test.mjs'
  writeFileSync(join(f.root, specA), f.original.split('## expanded spec')[0])
  f.config.testPaths = testPaths
  f.config.mandatoryTests = []
  f.configure()
  for (const [testPath, testBody] of testFiles) {
    mkdirSync(dirname(join(f.root, testPath)), { recursive: true })
    writeFileSync(join(f.root, testPath), testBody)
  }
  git(f.root, 'add', specA, '.spec/spexcode.json', ...testFiles.map(([path]) => path))
  git(f.root, 'commit', '-m', 'seed raw-only intent and authorized tests')
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\n// initial behavior change\n`)

  const snapshot = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(snapshot, 'export-contract')
  const input: CodeBehaviorInput = {
    snapshot, baseline: null, composed: composeInputSnapshots(snapshot, null).composed!, origin: 'initial',
    readSetDigest: 'raw-only-read-set', policyDigest: 'raw-only-policy', requestKey: 'raw-only-readable-tests', timeoutMs: 10000,
    plan: { ...plan, facts: [] },
  }
  type Frozen = { changedPaths: string[]; readablePaths: { path: string; snapshots: string[] }[]; newSource: [string, string][] }
  const captured: { frozen: Frozen | null } = { frozen: null }
  const stopAfterCapture = new Error('captured frozen test read set')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    captured.frozen = readFrozenBehaviorContext<Frozen>(request)
    throw stopAfterCapture
  }), error => error === stopAfterCapture)

  const frozen = captured.frozen
  const readableTestFiles = testFiles.filter(([path]) => frozen?.readablePaths.some(item => item.path === path)).map(([path]) => path).sort()
  const checks = {
    readableTestDirectories: plan.readPaths.filter(path => testPaths.includes(path)).sort(),
    readableTestFiles,
    existingTestBodiesFrozen: testFiles.every(([path, body]) => new Map(frozen?.newSource ?? []).get(path) === body),
    unrelatedTestExcluded: verifySnapshot(snapshot).some(entry => entry.path === outsideTestPath) && !plan.readPaths.some(path => path === 'tests' || path.startsWith('tests/')) && !frozen?.readablePaths.some(item => item.path === outsideTestPath),
    unrelatedSourceExcluded: verifySnapshot(snapshot).some(entry => entry.path === 'src/other.js') && !plan.readPaths.includes('src/other.js') && !frozen?.readablePaths.some(item => item.path === 'src/other.js'),
    readOnlyContextOnly: testFiles.every(([path]) => !plan.executionScope.paths.includes(path)) && plan.mandatoryTests.length === 0,
    businessChangedPaths: frozen?.changedPaths,
  }
  assert.deepEqual(checks, {
    readableTestDirectories: testPaths.sort(),
    readableTestFiles: testFiles.map(([path]) => path).sort(),
    existingTestBodiesFrozen: true,
    unrelatedTestExcluded: true,
    unrelatedSourceExcluded: true,
    readOnlyContextOnly: true,
    businessChangedPaths: ['src/export.js'],
  })
})

test('冻结source角色参与政策摘要，旧持久JSON保持原摘要', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, specA), f.original.split('## expanded spec')[0])
  f.config.readPaths = ['src', 'generated-tests']
  f.config.mandatoryTests = []
  f.configure()
  const originalSources = [...f.config.sourcePaths]
  const first = await buildSyncApplicationPlan(await captureInputSnapshot(f.root), 'export-contract')
  f.config.sourcePaths = ['generated-tests']; f.config.testPaths = ['src']; f.configure()
  const second = await buildSyncApplicationPlan(await captureInputSnapshot(f.root), 'export-contract')
  assert.deepEqual(first.readPaths, second.readPaths)
  assert.deepEqual(first.writePaths, second.writePaths)
  assert.deepEqual(first.executionScope, second.executionScope)
  assert.deepEqual({ ...first, sourcePaths: undefined }, { ...second, sourcePaths: undefined })
  assert.deepEqual(first.sourcePaths, originalSources.sort())
  assert.deepEqual(second.sourcePaths, [...f.config.sourcePaths].sort())
  assert.notEqual(syncPlanDigest(first), syncPlanDigest(second))
  const legacyJson = '{"facts":[],"intentNodeId":"raw","mandatoryTests":[],"readPaths":["src","tests"],"targets":[{"nodeId":"raw","path":".spec/raw/spec.md"}],"verifications":[],"version":"sync-coordinator-v1","writePaths":["src","tests"]}'
  const legacy = JSON.parse(legacyJson) as SyncCoordinatorPlan
  assert.equal(syncPlanDigest(legacy), contentHash(legacyJson))
  assert.equal(syncPlanDigest({ ...legacy, sourcePaths: undefined }), contentHash(legacyJson))
})

test('真实store旧政策防删owner规避：整个A节点/VERIFY删除后退役仍保原命令和oracle', async t => {
  const f = await fixture(t), baseline = await settleBaseline(t, f.parent, f.source, f.delivery)
  rmSync(join(f.root, specA))
  const source = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(source, 'export-contract', baseline)
  assert.deepEqual(plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01'])
  assert.deepEqual(plan.mandatoryTests, [f.config.mandatoryTests[0]])
  assert.ok(plan.readPaths.includes('tests/export.test.mjs')); assert.ok(!plan.executionScope.paths.includes('tests/export.test.mjs'))
  assert.ok(!plan.executionScope.paths.some(path => path.includes('other')))
  const evidenceRoot = process.env.SPEX_COMPOSITION_EVIDENCE_DIR
  if (evidenceRoot) writeFileSync(join(evidenceRoot, 'planner-retirement-after.json'), JSON.stringify({ limitation: '真实Git/store/receipt；四层verification明确fake', baseline, source, plan }, null, 2))
})

test('无owner预登记不被丢弃，坏配置仍在可信schema边界拒绝', async t => {
  const f = await fixture(t), future = { definition: { id: 'VERIFY-FUTURE-01', command: ['node', '--test', 'tests/future.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: f.config.verifications[0].environment }
  f.config.verifications.push(future); f.config.mandatoryTests.push({ verificationId: future.definition.id, testPath: 'tests/future.test.mjs', testId: 'FUTURE-01' }); f.configure()
  const source = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(source, 'export-contract')
  assert.deepEqual(plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01', 'VERIFY-FUTURE-01'])
  assert.ok(plan.mandatoryTests.some(item => item.verificationId === future.definition.id)); assert.ok(plan.readPaths.includes('tests/future.test.mjs'))
  future.definition.command = ['bash', 'unsafe']; f.configure()
  await assert.rejects(buildSyncApplicationPlan(await captureInputSnapshot(f.root), 'export-contract'), /支持已登记的 Docker Node --test/)
})

for (const historical of [false, true]) test(`移动子节点完整读取readonly父契约声明assets，历史映射${historical ? '变化' : '保持'}且不扩大写范围`, async t => {
  const f = await fixture(t), oldChild = '.spec/export/export-contract/summary/spec.md', movedChild = '.spec/export/export-contract/moved-summary/spec.md'
  const child = `---
title: 导出计数辅助
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循导出原始反馈需求。

## expanded spec

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-EXPORT-01,RULE-EXPORT-05 | 成功行数组 | 读取计数辅助 | 返回rows.length | generated-tests/summary.test.mjs#AC-SUMMARY-01 | VERIFY-SUMMARY-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |

### VERIFY

| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-SUMMARY-01 | ["node","--test","generated-tests/summary.test.mjs"] | . | 10000 |
`
  const childContract = parseContract({ nodeId: 'summary', path: oldChild, source: child })
  assert.ok(childContract.contract, JSON.stringify(childContract.findings))
  assert.deepEqual(childContract.contract.items.map(item => item.id), ['AC-SUMMARY-01', 'VERIFY-SUMMARY-01'])
  mkdirSync(join(f.root, oldChild, '..'), { recursive: true }); mkdirSync(join(f.root, 'generated-tests'))
  writeFileSync(join(f.root, oldChild), child)
  writeFileSync(join(f.root, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n')
  writeFileSync(join(f.root, 'generated-tests/summary.test.mjs'), "import test from 'node:test'; test('AC-SUMMARY-01', () => {});\n")
  f.config.mandatoryTests = []
  f.config.verifications.push({ ...f.config.verifications[0], definition: { id: 'VERIFY-SUMMARY-01', command: ['node', '--test', 'generated-tests/summary.test.mjs'], cwd: '.', timeoutMs: 10000 } }); f.configure()
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'governed child with readonly parent obligations')
  git(f.delivery.source.canonicalRoot, 'reset', '--hard', 'main')
  const source = await captureInputSnapshot(f.root), delivery = await captureInputSnapshot(f.delivery.source.canonicalRoot)
  const parentContract = parseContract({ nodeId: 'export-contract', path: specA, source: f.original }).contract!
  const baseline = await settleBaseline(t, f.parent, source, delivery, { paths: [specA, oldChild, 'src/export.js', 'src/summary.js', 'generated-tests/summary.test.mjs'], contractIds: [...parentContract.items.filter(item => !['VERIFY', 'FLOW'].includes(item.kind)).map(item => item.id), 'AC-SUMMARY-01'], flowIds: parentContract.items.filter(item => item.kind === 'FLOW').map(item => item.id) })
  renameSync(join(f.root, '.spec/export/export-contract/summary'), join(f.root, '.spec/export/export-contract/moved-summary'))
  if (historical) {
    writeFileSync(join(f.root, specA), f.original.replaceAll('src/export.js', 'src/current-export.js').replaceAll('tests/export.test.mjs', 'tests/current-export.test.mjs'))
    cpSync(join(f.root, 'src/export.js'), join(f.root, 'src/current-export.js')); cpSync(join(f.root, 'tests/export.test.mjs'), join(f.root, 'tests/current-export.test.mjs'))
    f.config.verifications[0].definition.command = ['node', '--test', 'tests/current-export.test.mjs']; f.configure()
  }
  const current = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(current, 'moved-summary', baseline)
  assert.ok(plan.readPaths.includes(specA)); assert.ok(!plan.targets.some(target => target.nodeId === 'export-contract'))
  for (const path of ['src/export.js', 'tests/export.test.mjs', ...(historical ? ['src/current-export.js', 'tests/current-export.test.mjs'] : [])]) {
    assert.ok(plan.readPaths.includes(path), `完整readonly父契约与历史声明必须读取${path}`)
    assert.ok(!plan.executionScope.paths.includes(path), `readonly声明不能取得${path}写范围`)
    const entry = verifySnapshot(current).find(entry => entry.path === path)!
    assert.throws(() => freezeCandidate(current, { version: 'sync-files-v1', changes: [{ path, beforeDigest: entry.digest, beforeMode: entry.mode, content: 'unauthorized overwrite\n' }] }, plan.executionScope), /越界/)
  }
  const frozen = await context(current, plan.readPaths)
  assert.deepEqual(validateContractGraph(frozen.graph, { mode: 'final', files: frozen.files, nodeIds: new Set(frozen.nodes.map(node => node.id)) }).filter(finding => finding.severity === 'error'), [])
  assert.deepEqual(plan.executionScope.paths, [oldChild, movedChild, 'src/summary.js', 'generated-tests/summary.test.mjs'].sort())
  assert.ok(parentContract.items.every(item => !plan.executionScope.contractIds.includes(item.id) && !plan.executionScope.flowIds.includes(item.id)))
  assert.deepEqual(plan.writePaths, [oldChild, movedChild, '.spec/export/export-contract/moved-summary', 'src', 'generated-tests'].sort())
  for (const path of [specB, 'src/other.js', 'tests/other.test.mjs']) assert.ok(!plan.readPaths.includes(path), `独立B的${path}不能进入读取`)
  const resources = await deriveSyncBaselineResources(current, plan)
  assert.ok(resources.some(resource => resource.kind === 'path' && resource.path === 'src/export.js'))
  assert.ok(!resources.some(resource => resource.kind === 'path' && resource.path.includes('other')))
})

test('v2无验证基线的真实提交删除仍读取before原意与旧身份，不把before冒作交付', async t => {
  const f = await fixture(t), before = await captureInputSnapshot(f.root, { committed: true })
  rmSync(join(f.root, specA)); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'author removes the specification')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const plan = await buildSyncApplicationPlan(snapshot, 'export-contract', null, { direction: 'combined', commitTrigger: { before, paths: [specA] } })
  assert.equal(plan.version, 'sync-coordinator-v2')
  assert.ok(plan.targets.some(target => target.nodeId === 'export-contract' && target.path === specA && target.rawSource))
  assert.ok(plan.readPaths.includes(specA))
  assert.ok(plan.readPaths.includes('src/export.js'))
  assert.ok(plan.executionScope.contractIds.includes('REQ-EXPORT-01'))
  const resources = await deriveSyncBaselineResources(snapshot, plan)
  assert.ok(resources.some(resource => resource.kind === 'path' && resource.path === specA))
  assert.ok(resources.some(resource => resource.kind === 'contract' && resource.id === 'REQ-EXPORT-01'))
})


/** 只投影已结算基线的输入形状；不伪造 store receipt，也不声称 Native/Docker 已验证。 */
function projectedSelection(pair: BaselinePair, resources: BaselineResource[]): FrozenBaselineSelection {
  const bindings: FrozenBaselineSelection['bindings'] = resources.map(resource => resource.kind === 'path'
    ? { resource, bytePair: pair.coveredScope.paths.includes(resource.path) ? pair : null }
    : { resource, intentPair: (resource.kind === 'flow' ? pair.coveredScope.flowIds : pair.coveredScope.contractIds).includes(resource.id) ? pair : null })
  const value = { version: 'sync-baseline-selection-v1' as const, source: pair.source, bindings }
  return { ...value, digest: contentHash(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)) }
}

async function incrementalRepository(t: test.TestContext, mode: 'independent' | 'shared' | 'dependency' = 'independent') {
  const f = await fixture(t), rootSpec = '.spec/project/spec.md'
  const paths = [specA, specB, '.spec/third/third-contract/spec.md'].map(path => path.replace('.spec/', '.spec/project/'))
  mkdirSync(join(f.root, paths[2], '..'), { recursive: true })
  writeFileSync(join(f.root, paths[2]), f.original.replaceAll('EXPORT', 'THIRD').replaceAll('export-contract', 'third-contract').replaceAll('export.js', 'third.js').replaceAll('export.test.mjs', 'third.test.mjs'))
  for (const [index, old] of [specA, specB].entries()) { mkdirSync(join(f.root, paths[index], '..'), { recursive: true }); renameSync(join(f.root, old), join(f.root, paths[index])) }
  writeFileSync(join(f.root, rootSpec), '---\ntitle: 项目原意\nstatus: active\n---\n## raw source\n\n三个独立服务均完整同步。\n')
  cpSync(join(f.root, 'src/export.js'), join(f.root, 'src/third.js')); cpSync(join(f.root, 'tests/export.test.mjs'), join(f.root, 'tests/third.test.mjs'))
  if (mode === 'shared') writeFileSync(join(f.root, paths[1]), f.other.replace('src/other.js#ExportService', 'src/export.js#ExportService'))
  if (mode === 'dependency') writeFileSync(join(f.root, paths[1]), f.other.replace('REQ-OTHER-01 |\n', 'REQ-EXPORT-01 |\n'))
  const third = parseContract({ nodeId: 'third-contract', path: paths[2], source: readFileSync(join(f.root, paths[2]), 'utf8') }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(third.kind, 'VERIFY')
  f.config.nodeIds = ['project']
  f.config.verifications.push({ ...f.config.verifications[0], definition: { id: third.id, command: third.command, cwd: third.cwd, timeoutMs: third.timeoutMs } })
  f.config.mandatoryTests.push({ verificationId: third.id, testPath: 'tests/third.test.mjs', testId: 'AC-THIRD-03' }); f.configure()
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'three complete specification leaves below registered intent')
  git(f.delivery.source.canonicalRoot, 'reset', '--hard', 'main')
  const before = await captureInputSnapshot(f.root, { committed: true }), delivery = await captureInputSnapshot(f.delivery.source.canonicalRoot, { committed: true })
  const fullPlan = await buildSyncApplicationPlan(before, 'project')
  return { ...f, rootSpec, paths, before, fullPlan, delivery }
}

async function incrementalFixture(t: test.TestContext, mode: 'independent' | 'shared' | 'dependency' = 'independent') {
  const f = await incrementalRepository(t, mode), { before, delivery, fullPlan, rootSpec, paths } = f
  const baseline: BaselinePair = { id: 'fixture-projected-settled-baseline', repositoryId: before.source.repositoryId, source: before.source, sourceInput: before, verifiedDelivery: delivery, coveredScope: fullPlan.executionScope, receiptId: 'fixture-projection-no-store-receipt', settledAtMs: 1 }
  const heads = projectedSelection(baseline, await deriveSyncBaselineResources(before, fullPlan))
  return { ...f, rootSpec, paths, before, fullPlan, baseline, heads }
}

test('已采纳基线的单叶源码commit只规划owner并保持三轮selection收敛，分区派发不含无关叶', async t => {
  const f = await incrementalFixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'change only the owned export source')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const changedPaths = git(f.root, 'diff', '--name-only', f.before.headCommit, snapshot.headCommit).split('\n')
  assert.deepEqual(changedPaths, ['src/export.js'])
  const rounds = [], options = { direction: 'code_to_spec' as const, commitTrigger: { before: f.before, paths: changedPaths }, discoverySelection: f.heads }
  let selection = f.heads
  for (let round = 0; round < 3; round++) {
    const plan = await buildSyncApplicationPlan(snapshot, 'project', selection, options)
    rounds.push(plan)
    selection = projectedSelection(f.baseline, await deriveSyncBaselineResources(snapshot, plan, selection))
  }
  const plan = rounds[2], frozen = await context(snapshot, verifySnapshot(snapshot).map(entry => entry.path))
  const partitions = planSyncPartitions({ plan, files: frozen.files, contracts: frozen.contracts, nodes: frozen.nodes, changedPaths })
  const dispatch = partitions.partitions.map(partition => projectSyncPartition(plan, partition))
  const evidence = { limitation: '真实 Git before/after、snapshot/planner/partition projection；settled baseline为明确fixture投影，未调用Native/Docker或伪造store receipt', before: f.before, snapshot, changedPaths, rounds, partitions, dispatch }
  if (process.env.SPEX_INCREMENTAL_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_INCREMENTAL_EVIDENCE_DIR, 'single-leaf-plan.json'), JSON.stringify(evidence, null, 2))
  for (const round of rounds) assert.deepEqual(round.targets.map(target => target.nodeId), ['export-contract'])
  assert.deepEqual(dispatch.flatMap(local => local.targets.map(target => target.nodeId)), ['export-contract'])
  assert.deepEqual(partitions.expectedPaths, changedPaths)
  for (const nodeId of ['other-contract', 'third-contract']) {
    assert.ok(!plan.executionScope.contractIds.some(id => id.includes(nodeId === 'other-contract' ? 'OTHER' : 'THIRD')))
    assert.ok(!dispatch.some(local => local.targets.some(target => target.nodeId === nodeId)))
  }
  for (const path of [f.paths[1], f.paths[2], 'src/other.js', 'src/third.js', 'tests/other.test.mjs', 'tests/third.test.mjs']) {
    assert.ok(!plan.executionScope.paths.includes(path))
    assert.ok(!dispatch.some(local => local.readPaths.includes(path) || local.writePaths.includes(path)))
    const old = verifySnapshot(f.before).find(entry => entry.path === path), next = verifySnapshot(snapshot).find(entry => entry.path === path)
    assert.deepEqual(next, old)
  }
})


for (const mode of ['shared', 'dependency'] as const) test(`已采纳基线源码commit保留真实${mode} owner与影响，独立第三叶不派发`, async t => {
  const f = await incrementalFixture(t, mode)
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', `change with ${mode} impact`)
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.heads, { discoverySelection: f.heads, direction: 'code_to_spec', commitTrigger: { before: f.before, paths: ['src/export.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId), ['export-contract', 'other-contract'])
  const frozen = await context(snapshot, verifySnapshot(snapshot).map(entry => entry.path))
  const partitions = planSyncPartitions({ plan, files: frozen.files, contracts: frozen.contracts, nodes: frozen.nodes, changedPaths: ['src/export.js'] })
  assert.deepEqual(partitions.partitions.flatMap(partition => partition.targets.map(target => target.nodeId)).sort(), ['export-contract', 'other-contract'])
  assert.ok(!partitions.partitions.some(partition => partition.readPaths.includes(f.paths[2]) || partition.readPaths.includes('src/third.js')))
  if (mode === 'shared') assert.equal(partitions.partitions.length, 1)
  else assert.ok(partitions.dependencies.some(edge => edge.paths.includes(f.paths[0]) && edge.paths.includes(f.paths[1])))
})

test('首次与未完成基线保持全树bootstrap，before或失败admission本身不能证明已完成，显式根Spec仍全树', async t => {
  const f = await incrementalFixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'source after initial input')
  const snapshot = await captureInputSnapshot(f.root, { committed: true }), complete = f.fullPlan.targets.map(target => target.nodeId)
  const incomplete = projectedSelection({ ...f.baseline, coveredScope: { ...f.baseline.coveredScope, paths: f.baseline.coveredScope.paths.filter(path => path !== f.paths[2]) } }, f.heads.bindings.map(binding => binding.resource))
  for (const [baseline, before] of [[null, null], [f.heads, null], [null, f.before], [incomplete, f.before]] as const) {
    const plan = await buildSyncApplicationPlan(snapshot, 'project', baseline, { direction: 'code_to_spec', commitTrigger: { before, paths: ['src/export.js'] } })
    assert.ok(plan.version === 'sync-coordinator-v2')
    assert.equal(plan.partitionPolicy.version, !baseline && !before ? 'sync-partition-policy-v2' : 'sync-partition-policy-v1')
    assert.deepEqual(plan.targets.map(target => target.nodeId), complete)
    const frozen = await context(snapshot, verifySnapshot(snapshot).map(entry => entry.path))
    const partitions = planSyncPartitions({ plan, files: frozen.files, contracts: frozen.contracts, nodes: frozen.nodes, changedPaths: before ? ['src/export.js'] : verifySnapshot(snapshot).map(entry => entry.path) })
    assert.deepEqual(partitions.partitions.flatMap(partition => partition.targets.map(target => target.nodeId)).sort(), [...complete].sort())
  }
  writeFileSync(join(f.root, f.rootSpec), `${readFileSync(join(f.root, f.rootSpec), 'utf8')}\n新增共同需求。\n`)
  git(f.root, 'add', f.rootSpec); git(f.root, 'commit', '-m', 'new explicit root intent')
  const explicit = await buildSyncApplicationPlan(await captureInputSnapshot(f.root, { committed: true }), 'project', f.heads, { commitTrigger: { before: f.before, paths: ['src/export.js', f.rootSpec] } })
  assert.deepEqual(explicit.targets.map(target => target.nodeId), complete)
  const manual = await buildSyncApplicationPlan(snapshot, 'project', f.heads)
  assert.deepEqual(manual.targets.map(target => target.nodeId), complete)
})

test('已结算交付尚未被来源Git采纳时仍按完整bootstrap，不以相同旧HEAD冒充采纳', async t => {
  const f = await incrementalFixture(t), deliveryRoot = f.delivery.source.canonicalRoot
  writeFileSync(join(deliveryRoot, f.paths[2]), `${readFileSync(join(deliveryRoot, f.paths[2]), 'utf8')}\n交付分支新增约束。\n`)
  git(deliveryRoot, 'add', '.'); git(deliveryRoot, 'commit', '-m', 'settled delivery that source has not adopted')
  const unadopted = { ...f.baseline, verifiedDelivery: await captureInputSnapshot(deliveryRoot, { committed: true }) }
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'source without adopting delivery')
  const plan = await buildSyncApplicationPlan(await captureInputSnapshot(f.root, { committed: true }), 'project', unadopted, { commitTrigger: { before: f.before, paths: ['src/export.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId), f.fullPlan.targets.map(target => target.nodeId))
})

test('发现selection缺少精确bootstrap path binding时不借完整BaselinePair冒充已覆盖', async t => {
  const f = await incrementalFixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'change one source with an incomplete discovery selection')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const resources = f.heads.bindings.filter(binding => binding.resource.kind !== 'path' || binding.resource.path !== f.paths[2]).map(binding => binding.resource)
  const incompleteHeads = projectedSelection(f.baseline, resources)
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.baseline, { discoverySelection: incompleteHeads, direction: 'code_to_spec', commitTrigger: { before: f.before, paths: ['src/export.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), f.fullPlan.targets.map(target => target.nodeId).sort())
})

test('裸BaselinePair只提供历史基线，不能替代完整discoverySelection证明bootstrap', async t => {
  const f = await incrementalFixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${readFileSync(join(f.root, 'src/export.js'), 'utf8')}\nexport const incremental = 1;\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'change one source without discovery heads')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.baseline, { direction: 'code_to_spec', commitTrigger: { before: f.before, paths: ['src/export.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), f.fullPlan.targets.map(target => target.nodeId).sort())
})

for (const action of ['move', 'delete'] as const) test(`已采纳基线${action}保留真实before owner、旧原意与验证政策，不派无关叶`, async t => {
  const f = await incrementalFixture(t), moved = f.paths[0].replace('export-contract', 'moved-contract')
  if (action === 'move') renameSync(join(f.root, f.paths[0], '..'), join(f.root, moved, '..'))
  else rmSync(join(f.root, f.paths[0]))
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', `${action} the export specification`)
  const snapshot = await captureInputSnapshot(f.root, { committed: true }), changedPaths = git(f.root, 'diff', '--no-renames', '--name-only', f.before.headCommit, snapshot.headCommit).split('\n')
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.heads, { discoverySelection: f.heads, direction: 'combined', commitTrigger: { before: f.before, paths: changedPaths } })
  assert.deepEqual(plan.targets.map(target => target.nodeId), [action === 'move' ? 'moved-contract' : 'export-contract'])
  assert.ok(plan.readPaths.includes(f.paths[0])); assert.ok(plan.executionScope.paths.includes(f.paths[0]))
  assert.ok(plan.readPaths.includes('src/export.js')); assert.ok(plan.readPaths.includes('tests/export.test.mjs'))
  assert.deepEqual(plan.mandatoryTests.map(item => item.verificationId), ['VERIFY-EXPORT-01'])
  assert.ok(!plan.executionScope.paths.includes('tests/export.test.mjs'))
  if (action === 'delete') assert.ok(plan.targets[0].rawSource)
  else assert.ok(plan.executionScope.paths.includes(moved))
  assert.ok(!plan.targets.some(target => ['other-contract', 'third-contract'].includes(target.nodeId)))
})

test('未治理新源码commit仍完整发现纳管，不因增量owner集合为空丢失任务', async t => {
  const f = await incrementalFixture(t), path = 'src/new-module.js'
  writeFileSync(join(f.root, path), 'export const discovered = true;\n')
  git(f.root, 'add', path); git(f.root, 'commit', '-m', 'new unowned source')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.heads, { discoverySelection: f.heads, direction: 'code_to_spec', commitTrigger: { before: f.before, paths: [path] } })
  assert.ok(plan.readPaths.includes(path)); assert.ok(plan.targets.length)
  const frozen = await context(snapshot, verifySnapshot(snapshot).map(entry => entry.path))
  const partitions = planSyncPartitions({ plan, files: frozen.files, contracts: frozen.contracts, nodes: frozen.nodes, changedPaths: [path] })
  assert.deepEqual(partitions.expectedPaths, [path])
  const discovered = partitions.partitions.filter(partition => partition.changedPaths.includes(path))
  assert.equal(discovered.length, 1); assert.deepEqual(discovered[0].targets, [])
  assert.ok(discovered[0].readPaths.includes(path)); assert.ok(discovered[0].contextNodeIds.length)
})


/** 正式交付/采纳只写Spec；四门仅为明确受控前置证据，不代表真实模型/Docker验收。 */
async function settledReadonlyRepository(t: test.TestContext, mode: 'independent' | 'shared' | 'dependency' = 'independent', omitScopePath?: string) {
  const repo = await incrementalRepository(t, mode), f = { ...repo, root: realpathSync(repo.root), parent: realpathSync(repo.parent) }
  git(f.root, 'switch', '-c', 'author')
  const configPath = join(f.root, '.spec/spexcode.json'); writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')) as object, mainBranch: 'main', harnesses: [] }))
  writeFileSync(join(f.root, 'src/third.js'), readFileSync(join(f.root, 'src/third.js'), 'utf8') + '\nexport const saveTasks = tasks => JSON.stringify(tasks, null, 2);\n')
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'readonly storage serialization input')
  const runtime = await freezeDeliveryRuntime(join(f.parent, 'trusted-runtime'))
  for (const name of readdirSync(runtime.canonicalHooksDir)) { copyFileSync(join(runtime.canonicalHooksDir, name), join(f.root, '.git/hooks', name)); chmodSync(join(f.root, '.git/hooks', name), 0o755) }
  const tools = { trustedRuntimeRoot: runtime.trustedRuntimeRoot, toolEntry: runtime.toolEntry, canonicalHooksDir: runtime.canonicalHooksDir, gitPath: '/usr/bin/git' }
  const appRoot = join(f.parent, 'readonly-app'), protocol = openProtocol(join(f.parent, 'readonly.sqlite')); t.after(() => protocol.close())
  const application = await SyncApplication.create(f.root, { protocol, runtimeDirectory: appRoot, tools }); await application.enable()
  const input = await captureInputSnapshot(f.root, { committed: true }), plan = await buildSyncApplicationPlan(input, 'project', null, { direction: 'code_to_spec' })
  if (omitScopePath) plan.executionScope.paths = plan.executionScope.paths.filter(path => path !== omitScopePath)
  const initial = application.store.readBaselineSelection(input.source, await deriveSyncBaselineResources(input, plan)); assert.ok('selection' in initial)
  const queued = application.store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: 'readonly-initialization', rootCauseId: 'readonly-initialization', origin: 'initial', budget: { mode: 'unlimited' }, managedRoot: join(appRoot, 'managed'), baselineSelection: initial.selection, executionScope: plan.executionScope }))
  const operation = application.store.ackDispatch(input.source.repositoryId, queued.dispatchMessageId)
  writeFileSync(join(appRoot, 'artifacts', `application-runtime-${contentHash(operation.ingressKey)}.json`), JSON.stringify({ version: 'sync-tools-v1', tools, runtimeDigest: null }))
  const claim = application.store.claimQueuedAttempt({ operationId: operation.id, source: input.source, scope: operation.scope, leaseMs: 60_000, expectedRevision: operation.revision }), composed = composeInputSnapshots(input, initial.selection).composed!
  application.store.bindComposedInput(claim.fence, composed); application.store.startGeneration(claim.fence)
  const specPaths = [f.rootSpec, ...f.paths]
  const entries = verifySnapshot(input)
  const candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: specPaths.map(path => { const entry = entries.find(entry => entry.path === path)!; return { path, beforeDigest: entry.digest, beforeMode: entry.mode, content: readObject(input.source.commonDir, entry.oid).toString('utf8') + '\n初始化规格核验。\n' } }) }, operation.scope, composed)
  application.store.freezeCandidate(claim.fence, candidate)
  const evidence = writeEvidence(input.source.commonDir, { fixture: '受控四门，仅验证真实交付、采纳与增量资格，不代表模型/Docker产品验收' })
  const bindings = { inputId: input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, baselineSelectionDigest: operation.baselineSelection!.digest, environmentDigest: 'fixture', contextDigest: 'fixture' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
  application.store.recordVerification(claim.fence, { ...bindings, passed: true, coveredScope: operation.scope, evidenceRefs: [evidence], resultBlob: writeEvidence(input.source.commonDir, result) })
  const delivered = await deliverVerifiedAttempt(application.store, claim.fence, { managedRoot: join(appRoot, 'managed'), tools, beforeApply: () => {} })
  const journal = application.store.listJournals(operation.id)[0]
  assert.deepEqual(journal.plan.files.map(file => file.path).sort(), specPaths.sort())
  assert.equal(journal.status, 'settled')
  const sourceAndTests = (snapshot: InputSnapshot) => verifySnapshot(snapshot).filter(entry => entry.path.startsWith('src/') || entry.path.startsWith('tests/') || entry.path.startsWith('generated-tests/'))
  assert.deepEqual(sourceAndTests(delivered.receipt.deliverySnapshot), sourceAndTests(input), 'code→Spec正式交付不得改变源码/tests的path、mode、OID或absence')
  const adopted = await application.adopt(operation.id); assert.equal(adopted.sourceSynced, true)
  const before = await captureInputSnapshot(f.root, { committed: true }), store = application.store
  const heads = store.readBaselineSelection(before.source, store.listBaselineResources(before.source)); assert.ok('selection' in heads)
  assert.ok(operation.scope.contractIds.length > 0)
  for (const id of [...operation.scope.contractIds, ...operation.scope.flowIds]) assert.ok(heads.selection.bindings.some(binding => binding.resource.kind !== 'path' && binding.resource.id === id && 'intentPair' in binding && binding.intentPair))
  for (const path of ['src/export.js', 'src/other.js', 'src/third.js']) assert.equal(heads.selection.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === path), false)
  return { ...f, application, protocol, store, input, before, delivered, journal, discovery: heads.selection }
}

test('真实settle/adopt只写Spec且源码无byte head，Storage型单叶commit保持三轮增量', { timeout: 90_000 }, async t => {
  const f = await settledReadonlyRepository(t)
  const source = readFileSync(join(f.root, 'src/third.js'), 'utf8'); writeFileSync(join(f.root, 'src/third.js'), source.replace('JSON.stringify(tasks, null, 2)', 'JSON.stringify(tasks)'))
  git(f.root, 'add', 'src/third.js'); git(f.root, 'commit', '-m', 'storage serialization formatting only')
  const snapshot = await captureInputSnapshot(f.root, { committed: true }), options = { discoverySelection: f.discovery, direction: 'code_to_spec' as const, commitTrigger: { before: f.before, paths: ['src/third.js'] } }
  let selection = f.discovery
  const allFiles = await context(snapshot, verifySnapshot(snapshot).map(entry => entry.path))
  const frozen = await f.application['freezeNodePlan'](snapshot, 'project', false, options.direction, options.commitTrigger)
  for (let round = 0; round < 3; round++) {
    const plan = await buildSyncApplicationPlan(snapshot, 'project', selection, options)
    if (round === 2) {
      plan.agentWorkflow = 'native-worktree-v1'
      assert.equal(JSON.stringify(frozen), JSON.stringify({ plan, selection }))
    }
    t.diagnostic(JSON.stringify({ round, settledBusinessHeads: f.discovery.bindings.filter(binding => binding.resource.kind !== 'path').length, journalFiles: f.journal.plan.files.map(file => file.path), knownByteHeads: f.discovery.bindings.filter(binding => binding.resource.kind === 'path').map(binding => binding.resource), targets: plan.targets.map(target => target.nodeId) }))
    assert.deepEqual(plan.targets.map(target => target.nodeId), ['third-contract'], '已经正式验证并采纳但从未写过的源码不能使完整初始化资格退回全树')
    const partitions = planSyncPartitions({ plan, files: allFiles.files, contracts: allFiles.contracts, nodes: allFiles.nodes, changedPaths: ['src/third.js'] })
    assert.deepEqual(partitions.partitions.flatMap(partition => partition.targets.map(target => target.nodeId)), ['third-contract'])
    const read = f.store.readBaselineSelection(snapshot.source, await deriveSyncBaselineResources(snapshot, plan, selection)); assert.ok('selection' in read); selection = read.selection
    const storage = selection.bindings.find(binding => binding.resource.kind === 'path' && binding.resource.path === 'src/third.js')!
    assert.equal('bytePair' in storage ? storage.bytePair : undefined, null, '只读初始化证明不能制造文件写头')
  }
  assert.deepEqual(f.store.listJournals(f.delivered.operation.id)[0], f.journal, '不能回写原receipt/journal')
})


test('只读初始化证明不借缺失头、未采纳、源码对象或owner声明漂移取得增量资格', { timeout: 90_000 }, async t => {
  const f = await settledReadonlyRepository(t), full = [...f.fullPlan.targets.map(target => target.nodeId)].sort()
  const bootstrap = async (before: InputSnapshot, discovery = f.discovery): Promise<void> => {
    const plan = await buildSyncApplicationPlan(f.before, 'project', discovery, { discoverySelection: discovery, direction: 'code_to_spec', commitTrigger: { before, paths: ['src/third.js'] } })
    assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), full)
  }
  await bootstrap(f.input)
  for (const key of [`path:${f.paths[1]}`, 'contract:RULE-OTHER-05']) {
    const rows = f.protocol.withTransaction(tx => { const rows = tx.query('SELECT source_key,resource_key,pair_id,legacy_reason FROM sync_baseline_heads WHERE resource_key=?', key); tx.exec('DELETE FROM sync_baseline_heads WHERE resource_key=?', key); return rows })
    const read = f.store.readBaselineSelection(f.before.source, f.store.listBaselineResources(f.before.source)); assert.ok('selection' in read)
    await bootstrap(f.before, read.selection)
    f.protocol.withTransaction(tx => { for (const row of rows) tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,?,?)', row.source_key as string, row.resource_key as string, row.pair_id as string | null, row.legacy_reason as string | null) })
  }
  for (const change of ['content', 'mode', 'absence', 'owner_claim'] as const) {
    const path = join(f.root, change === 'owner_claim' ? f.paths[1] : 'src/other.js'), original = readFileSync(path)
    if (change === 'content') writeFileSync(path, Buffer.concat([original, Buffer.from('\n// prior unverified code change\n')]))
    if (change === 'mode') chmodSync(path, 0o755)
    if (change === 'absence') rmSync(path)
    if (change === 'owner_claim') writeFileSync(path, original.toString('utf8').replace('code:\n', 'code:\n  - src/third.js#saveTasks\n'))
    // 历史snapshot对象的不相容本身已足以撤销只读资格；此负例不假称新的正式提交或验证。
    await bootstrap(await captureInputSnapshot(f.root))
    writeFileSync(path, original); chmodSync(path, 0o644)
  }
  f.protocol.withTransaction(tx => tx.exec("UPDATE sync_apply_journals SET status='prepared',record_json=? WHERE id=?", JSON.stringify({ ...f.journal, status: 'prepared' }), f.journal.id))
  const missingReceipt = f.store.readBaselineSelection(f.before.source, f.store.listBaselineResources(f.before.source))
  assert.ok('failure' in missingReceipt); assert.equal(missingReceipt.failure.kind, 'unsupported'); assert.equal(missingReceipt.failure.code, 'SYNC_PUBLICATION_BASE_BINDING')
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_apply_journals SET status=?,record_json=? WHERE id=?', f.journal.status, JSON.stringify(f.journal), f.journal.id))
})

test('formal owner已采纳但source不在真实verified scope时仍bootstrap', { timeout: 90_000 }, async t => {
  const f = await settledReadonlyRepository(t, 'independent', 'src/third.js')
  const plan = await buildSyncApplicationPlan(f.before, 'project', f.discovery, { discoverySelection: f.discovery, direction: 'code_to_spec', commitTrigger: { before: f.before, paths: ['src/third.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), f.fullPlan.targets.map(target => target.nodeId).sort())
})

test('真实只读初始化的contract依赖仍进入增量targets，无关第三叶不进入写目标', { timeout: 90_000 }, async t => {
  const f = await settledReadonlyRepository(t, 'dependency')
  writeFileSync(join(f.root, 'src/export.js'), readFileSync(join(f.root, 'src/export.js'), 'utf8') + '\n// real committed source change\n')
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'dependency owner source commit')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const plan = await buildSyncApplicationPlan(snapshot, 'project', f.discovery, { discoverySelection: f.discovery, direction: 'code_to_spec', commitTrigger: { before: f.before, paths: ['src/export.js'] } })
  assert.deepEqual(plan.targets.map(target => target.nodeId), ['export-contract', 'other-contract'])
  assert.equal(plan.targets.some(target => target.nodeId === 'third-contract'), false)
})
