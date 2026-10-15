import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { parseContract, validateContractGraph } from '@spexcode/spec-core/contracts'
import { freezeCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import { migrateSyncStore } from './migrations.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { captureInputSnapshot, readEvidence, readObject, verifySnapshot, writeEvidence } from './snapshot.js'
import { SyncStore } from './store.js'
import type { BaselinePair, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
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
  t.after(() => rmSync(parent, { recursive: true, force: true }))
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
