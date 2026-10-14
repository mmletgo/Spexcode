import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { parseContract } from '@spexcode/spec-core/contracts'
import { analyzeCodeBehavior, authoredContractChanges, selectedAuthoredContractChanges } from './code-behavior.js'
import { composeInputSnapshots, readCompositionEvidence } from './composition.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { composeControlledRequest, prepareControlledRequest } from './request-input.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, verifySnapshot, writeEvidence } from './snapshot.js'
import type { BaselinePair, FrozenBaselineSelection, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import type { ElaborationRunner } from './elaboration-types.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'

const path = '.spec/export/export-contract/spec.md', a = 'RULE-EXPORT-05'
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
const texts = (input: InputSnapshot): Map<string, string> => new Map(verifySnapshot(input).map(entry => [entry.path, readObject(input.source.commonDir, entry.oid).toString('utf8')]))

/** Git快照、提交、mode与store事务是真实的；验证四层是显式fake，不能作为native产品通过证据。 */
async function fixture(t: test.TestContext, pendingInB = false, legacyDirectoryCoverage = false) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-frontier-')), root = join(parent, 'source'), deliveryRoot = join(parent, 'delivery')
  mkdirSync(root); cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', '真实组合夹具'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'sourceA0')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD')
  const original = readFileSync(join(root, path), 'utf8'), firstA = original.replace('成功需非空result、发布一次', '成功需非空result、版本A1、发布一次'), nextA = original.replace('成功需非空result、发布一次', '成功需非空result、版本A2、发布一次')
  const addB = (text: string): string => text.replace('key与非空字符串filter必需', 'key与非空字符串filter必需；交付B1政策保留')
  const sourceA0 = await captureInputSnapshot(root)
  const protocol = openProtocol(join(parent, 'db.sqlite')); await migrateSyncStore(protocol, { backupPath: join(parent, 'backup.sqlite') })
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(sourceA0.source.commonDir, ref) })
  t.after(() => { protocol.close(); rmSync(parent, { recursive: true, force: true }) })
  const settle = async (source: InputSnapshot, delivery: InputSnapshot, id: string, ids: string[]): Promise<BaselinePair> => {
    const scope: SyncScope = { paths: [legacyDirectoryCoverage ? '.spec' : path], contractIds: ids.filter(id => !id.startsWith('FLOW-') && !id.startsWith('VERIFY-')), flowIds: ids.filter(id => id.startsWith('FLOW-')) }, commonDir = source.source.commonDir
    const put = (value: unknown) => writeEvidence(commonDir, value)
    const admitted = store.admitAndEnqueue({ ingressKey: id, rootCauseId: id, origin: 'spec', input: source, scope, budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 100000 }, policyDigest: `fake-policy-${id}`, impactDigest: id, readSetDigest: id, delivery: null, deliveryPlan: { canonicalRoot: delivery.source.canonicalRoot, branch: delivery.source.branch, baseCommit: source.headCommit } })
    const claim = store.claimAttempt({ operationId: admitted.id, source: source.source, scope, leaseMs: 100000, expectedMessageId: admitted.dispatchMessageId })
    store.bindDelivery(claim.fence, delivery.source)
    store.bindComposedInput(claim.fence, composeInputSnapshots(source).composed!)
    store.startGeneration(claim.fence, { readyScope: scope, blockedScope: { paths: [], contractIds: [], flowIds: [] }, blockedReason: null })
    const before = verifySnapshot(source).find(entry => entry.path === path)!, after = verifySnapshot(delivery).find(entry => entry.path === path)!
    const files = [{ path, preDigest: before.digest, postDigest: after.digest, preMode: before.mode, postMode: after.mode }]
    const candidate = { sourceInputId: source.id, baseTree: source.immutableTree, tree: delivery.immutableTree, digest: delivery.contentDigest, manifestBlob: delivery.manifestBlob, actualDiffBlob: put(files), coveredScope: scope }
    store.freezeCandidate(claim.fence, candidate)
    const fake = put({ fake: true, reason: '验证协议仅供基线结算，非业务验收' }), bindings = { inputId: source.id, candidateDigest: candidate.digest, policyDigest: `fake-policy-${id}`, readSetDigest: id, environmentDigest: 'fake-env', contextDigest: 'fake-context' }
    const verification: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [fake] })) }
    const resultBlob = put(verification); store.recordVerification(claim.fence, { ...bindings, passed: true, coveredScope: scope, evidenceRefs: [fake], resultBlob })
    const plan = { effectKey: id, payloadDigest: id, candidateDigest: candidate.digest, verificationBlob: resultBlob, target: delivery.source, expectedTargetSnapshotId: source.id, expectedBaselinePairId: null, coveredScope: scope, files, planBlob: put({ files, candidateDigest: candidate.digest }) }
    const target = { ...source, source: delivery.source }, journal = store.beginApply(claim.fence, plan, target)
    for (const step of journal.steps) store.recordApplyStep(claim.fence, journal.id, { ...step, status: 'completed' })
    const receipt = { id: `receipt-${id}`, journalId: journal.id, effectKey: id, actualTree: delivery.immutableTree, actualCommit: delivery.headCommit, deliverySnapshot: delivery, evidenceRefs: [fake], completedAtMs: Date.now() }
    store.recordReceipt(journal.id, receipt); store.settleApply(journal.id, receipt.id)
    return store.readBaseline(source.source)!
  }
  writeFileSync(join(deliveryRoot, path), firstA); git(deliveryRoot, 'add', path); git(deliveryRoot, 'commit', '-m', 'deliveryA1')
  const deliveryA1 = await captureInputSnapshot(deliveryRoot), pairA = await settle(sourceA0, deliveryA1, 'settle-A', [a])
  if (pendingInB) writeFileSync(join(root, path), nextA)
  const sourceB = pendingInB ? await captureInputSnapshot(root) : sourceA0
  writeFileSync(join(deliveryRoot, path), addB(firstA)); chmodSync(join(deliveryRoot, path), 0o755); git(deliveryRoot, 'add', path); git(deliveryRoot, 'commit', '-m', 'deliveryA1B1 executable')
  const deliveryB1 = await captureInputSnapshot(deliveryRoot)
  const allIds = parseContract({ nodeId: 'export-contract', path, source: original }).contract!.items.map(item => item.id)
  const pairB = await settle(sourceB, deliveryB1, 'settle-B', allIds.filter(id => id !== a))
  const selection = (): FrozenBaselineSelection => {
    const result = store.readBaselineSelection(sourceA0.source, [{ kind: 'path', path }, ...allIds.filter(id => !id.startsWith('VERIFY-')).map(id => ({ kind: id.startsWith('FLOW-') ? 'flow' as const : 'contract' as const, id }))])
    assert.ok('selection' in result); return result.selection
  }
  const plan: SyncCoordinatorPlan = { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec', 'src', 'tests'], facts: [], verifications: [], mandatoryTests: [] }
  return { root, deliveryRoot, original, nextA, addB, sourceA0, pairA, pairB, deliveryB1, selection, plan, allIds }
}

function fakeBehavior(resolution?: string, assertInput?: (frozen: Record<string, unknown>) => void): ElaborationRunner {
  return async request => {
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      assertInput?.(frozen)
      output = { changes: frozen.changedPaths.map(path => ({ kind: 'allowed_change', paths: [path], affectedIds: [a], ruleIds: [a], originalIntent: '保留作者A与已交付B', previousBehavior: 'A1', sourceBehavior: 'A2', deliveryBehavior: 'A1+B1', evidence: '真实Git对象及逐ID残差', counterexample: '不能把A2隐藏为A1' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: resolution ? [{ path, content: resolution, mode: '100755' }] : [] }
    } else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: CodeBehaviorAnalysis }
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: frozen.changedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    }
    return { sessionId: `fake-session-${request.purpose}`, threadId: `fake-thread-${request.purpose}`, turnId: 'fake-turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}

test('真实store partial heads：A作者残差保留B交付，不以不同pairID制造业务冲突', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, path), f.nextA)
  const input = await captureInputSnapshot(f.root), selection = f.selection(), result = composeInputSnapshots(input, selection, { retainConflicts: true })
  const selectedA = selection.bindings.find(binding => binding.resource.kind === 'contract' && binding.resource.id === a)
  assert.ok(selectedA && 'intentPair' in selectedA); assert.equal(selectedA.intentPair?.id, f.pairA.id)
  const evidence = readCompositionEvidence(input, result.composed!, selection)
  assert.equal(evidence.paths[0].pairId, f.pairB.id)
  assert.deepEqual(selectedAuthoredContractChanges(evidence).flatMap(change => change.changedIds), [a])
  const analysis = await analyzeCodeBehavior({ snapshot: input, baseline: null, baselineSelection: selection, composed: result.composed!, readSetDigest: 'test-read', policyDigest: 'test-policy', requestKey: 'case1', timeoutMs: 10000, plan: f.plan }, fakeBehavior(f.addB(f.nextA)))
  assert.equal(analysis.findings.length, 0); assert.equal(analysis.baselineSelectionDigest, selection.digest)
  assert.match(analysis.resolutions[0].content!, /版本A2/); assert.match(analysis.resolutions[0].content!, /交付B1政策保留/)
})

test('同一Git反例 fail→pass：B.source夹A2但onlycoveredB，nextSource不变仍强制A2整合', async t => {
  const f = await fixture(t, true), input = await captureInputSnapshot(f.root)
  const legacy = composeInputSnapshots(input, f.pairB, { retainConflicts: true }).composed!
  assert.deepEqual(authoredContractChanges(texts(f.pairB.sourceInput), texts(input), texts(f.pairB.verifiedDelivery), [{ id: 'export-contract', path }]), [])
  const legacyText = readObject(input.source.commonDir, readTree(input.source.commonDir, legacy.tree).find(entry => entry.path === path)!.oid).toString('utf8')
  assert.match(legacyText, /版本A1/); assert.doesNotMatch(legacyText, /版本A2/)
  const selection = f.selection(), composed = composeInputSnapshots(input, selection, { retainConflicts: true }).composed!, evidence = readCompositionEvidence(input, composed, selection)
  assert.deepEqual(evidence.residualPaths, [path]); assert.deepEqual(selectedAuthoredContractChanges(evidence).flatMap(change => change.changedIds), [a])
  const analysis = await analyzeCodeBehavior({ snapshot: input, baseline: null, baselineSelection: selection, composed, readSetDigest: 'test-read', policyDigest: 'test-policy', requestKey: 'case2', timeoutMs: 10000, plan: f.plan }, fakeBehavior(f.addB(f.nextA), frozen => {
    assert.deepEqual(frozen.changedPaths, [path]); assert.equal((frozen.authorChanges as CodeBehaviorAnalysis['authorChanges'])![0].changedIds[0], a)
  }))
  assert.match(analysis.resolutions[0].content!, /版本A2/); assert.match(analysis.resolutions[0].content!, /交付B1政策保留/)
})

test('真实ff接受实际commit/blob/mode：B回声无作者变化，随后A编辑仍检测', async t => {
  const f = await fixture(t)
  git(f.root, 'merge', '--ff-only', f.deliveryB1.headCommit)
  const accepted = await captureInputSnapshot(f.root), selection = f.selection(), composed = composeInputSnapshots(accepted, selection, { retainConflicts: true }).composed!
  const evidence = readCompositionEvidence(accepted, composed, selection)
  assert.equal(evidence.paths[0].adopted, true); assert.equal(evidence.paths[0].source?.mode, '100755')
  assert.deepEqual(selectedAuthoredContractChanges(evidence), []); assert.deepEqual(evidence.residualPaths, [])
  writeFileSync(join(f.root, path), f.addB(f.nextA))
  const next = await captureInputSnapshot(f.root), changed = readCompositionEvidence(next, composeInputSnapshots(next, selection, { retainConflicts: true }).composed!, selection)
  assert.deepEqual(selectedAuthoredContractChanges(changed).flatMap(change => change.changedIds), [a])
})

test('完整整合即使fake独审accept，程序仍拒Bpolicy、AC删除和权限弱化', async t => {
  const f = await fixture(t, true), input = await captureInputSnapshot(f.root), selection = f.selection(), composed = composeInputSnapshots(input, selection, { retainConflicts: true }).composed!
  const safe = f.addB(f.nextA), wrong = [safe.replace('交付B1政策保留', '被恶意改写'), safe.split('\n').filter(line => !line.startsWith('| AC-EXPORT-01 |')).join('\n'), safe.replace('CANCEL/RETRY/DOWNLOAD必须是当前所有者', 'CANCEL/RETRY/DOWNLOAD允许任何人')]
  for (const content of wrong) await assert.rejects(analyzeCodeBehavior({ snapshot: input, baseline: null, baselineSelection: selection, composed, readSetDigest: 'test-read', policyDigest: 'test-policy', requestKey: content.slice(0, 20), timeoutMs: 10000, plan: f.plan }, fakeBehavior(content)), /精确组合破坏/)
})

test('实际读取资源含代码/保护契约与旧tombstone，不把授权目录当资源或coverage', async t => {
  const f = await fixture(t), input = await captureInputSnapshot(f.root), resources = await deriveSyncBaselineResources(input, f.plan, f.selection())
  assert.ok(resources.some(resource => resource.kind === 'path' && resource.path === 'src/export.js'))
  assert.ok(resources.some(resource => resource.kind === 'contract' && resource.id === 'AC-EXPORT-01'))
  assert.ok(resources.some(resource => resource.kind === 'flow' && resource.id === 'FLOW-EXPORT-01'))
  assert.ok(!resources.some(resource => resource.kind === 'contract' && (resource.id.startsWith('FLOW-') || resource.id.startsWith('VERIFY-'))))
  assert.ok(!resources.some(resource => resource.kind === 'path' && ['src', 'tests', '.spec'].includes(resource.path)))
})

test('精确组合的受控非重叠编辑保真实patch、selection证据与B交付，source/index不变', async t => {
  const f = await fixture(t), input = await captureInputSnapshot(f.root), selection = f.selection(), original = texts(input).get(path)!
  const next = original.replace('用户可以提交符合筛选条件的数据导出', '用户可以提交符合筛选条件的数据导出并查看作者请求提示')
  const request = prepareControlledRequest(input, { path, source: original, next, changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'controlled-nonoverlap', nodeId: 'export-contract', intent: '新增作者提示' })
  assert.ok(request.changed)
  const result = composeControlledRequest(input, composeInputSnapshots(input, selection, { retainConflicts: true }).composed!, request.requestBlob, { retainConflicts: true })
  const evidence = readCompositionEvidence(input, result.composed!, selection)
  assert.equal(evidence.controlledAuthorPatch!.requestBlob.sha256, request.requestBlob.sha256)
  assert.ok(selectedAuthoredContractChanges(evidence).some(change => change.beforeRaw !== change.afterRaw))
  const text = readObject(input.source.commonDir, readTree(input.source.commonDir, result.composed!.tree).find(entry => entry.path === path)!.oid).toString('utf8')
  assert.match(text, /作者请求提示/); assert.match(text, /版本A1/); assert.match(text, /交付B1政策保留/)
  const after = await captureInputSnapshot(f.root); assert.equal(after.id, input.id); assert.equal(after.indexDigest, input.indexDigest)
})

test('精确组合的受控重叠编辑继续保真实request三方与ID基线，独审不漏作者patch', async t => {
  const f = await fixture(t), input = await captureInputSnapshot(f.root), selection = f.selection(), original = texts(input).get(path)!
  const next = original.replace('成功需非空result、发布一次', '成功需明确作者A2结果政策、发布一次')
  const request = prepareControlledRequest(input, { path, source: original, next, changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'controlled-overlap', nodeId: 'export-contract', intent: '作者A2' })
  assert.ok(request.changed)
  const result = composeControlledRequest(input, composeInputSnapshots(input, selection, { retainConflicts: true }).composed!, request.requestBlob, { retainConflicts: true })
  assert.equal(result.conflicts.length, 1)
  const evidence = readCompositionEvidence(input, result.composed!, selection)
  assert.equal(evidence.version, 'selected-composition-v1'); assert.equal(evidence.paths[0].pairId, f.pairB.id)
  assert.equal(evidence.controlledAuthorPatch!.next.oid, result.conflicts[0].source!.oid)
  assert.deepEqual(selectedAuthoredContractChanges(evidence).flatMap(change => change.changedIds), [a])
  const analysis = await analyzeCodeBehavior({ snapshot: input, baseline: null, baselineSelection: selection, composed: result.composed!, readSetDigest: 'test-read', policyDigest: 'test-policy', requestKey: 'controlled-overlap', timeoutMs: 10000, plan: f.plan }, fakeBehavior(f.addB(next), frozen => {
    assert.deepEqual((frozen.authorChanges as CodeBehaviorAnalysis['authorChanges'])![0].changedIds, [a])
  }))
  assert.match(analysis.resolutions[0].content!, /作者A2结果政策/); assert.match(analysis.resolutions[0].content!, /交付B1政策保留/)
})

test('精确executionPaths不夹带另一节点用户dirty或untracked，完整snapshot仍保真实字节', async t => {
  const f = await fixture(t)
  const committed = readFileSync(join(f.root, 'src/export.js'), 'utf8')
  writeFileSync(join(f.root, 'src/export.js'), 'unrelated author draft\n'); writeFileSync(join(f.root, 'src/unrelated.js'), 'untracked draft\n')
  const input = await captureInputSnapshot(f.root), composed = composeInputSnapshots(input, f.selection(), { retainConflicts: true, executionPaths: [path] }).composed!
  const entries = readTree(input.source.commonDir, composed.tree)
  assert.equal(readObject(input.source.commonDir, entries.find(entry => entry.path === 'src/export.js')!.oid).toString('utf8'), committed)
  assert.ok(!entries.some(entry => entry.path === 'src/unrelated.js'))
  assert.equal(texts(input).get('src/export.js'), 'unrelated author draft\n'); assert.equal(texts(input).get('src/unrelated.js'), 'untracked draft\n')
})

test('P3真实API目录覆盖pair仍可为journal精确文件head作证，不把prefix当exactbinding', async t => {
  const f = await fixture(t, true, true), input = await captureInputSnapshot(f.root), selection = f.selection()
  const byte = selection.bindings.find(binding => binding.resource.kind === 'path')
  assert.ok(byte && 'bytePair' in byte); assert.equal(byte.resource.path, path); assert.deepEqual(byte.bytePair!.coveredScope.paths, ['.spec'])
  const composed = composeInputSnapshots(input, selection, { retainConflicts: true }).composed!
  assert.deepEqual(readCompositionEvidence(input, composed, selection).residualPaths, [path])
})

test('同一input/hash合法的新证据不能伪造无残差或替换真实source OID', async t => {
  const f = await fixture(t, true), input = await captureInputSnapshot(f.root), selection = f.selection(), composed = composeInputSnapshots(input, selection, { retainConflicts: true }).composed!
  const original = readCompositionEvidence(input, composed, selection)
  const removed = structuredClone(original); removed.intents.find(item => item.resource.id === a)!.changed = false; removed.residualPaths = []
  const fake = { ...composed, compositionEvidenceBlob: writeEvidence(input.source.commonDir, removed) }
  assert.throws(() => readCompositionEvidence(input, fake, selection), /true intent objects or residual differ/)
  const wrongSource = structuredClone(original); wrongSource.paths[0].source = wrongSource.paths[0].delivery
  assert.throws(() => readCompositionEvidence(input, { ...composed, compositionEvidenceBlob: writeEvidence(input.source.commonDir, wrongSource) }, selection), /true byte objects differ/)
})

test('规划只读实际闭包，宽src/tests授权不把独立节点锁入scope或纳入读取', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.root, '.spec/independent'))
  writeFileSync(join(f.root, '.spec/independent/spec.md'), '---\ntitle: 独立节点\nstatus: active\ncode:\n  - src/independent.js\n---\n## raw source\n\n独立业务。\n\n## expanded spec\n\n独立实现。\n')
  writeFileSync(join(f.root, 'src/independent.js'), 'export const independent = true\n')
  writeFileSync(join(f.root, 'tests/independent.test.mjs'), 'independent test bytes\n')
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: {
    version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: [],
    facts: [], mandatoryTests: [], budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 30000 },
    verifications: [{ definition: { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }],
  } }))
  const input = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(input, 'export-contract', f.selection())
  assert.ok(plan.writePaths.includes('src')); assert.ok(plan.writePaths.includes('tests'))
  assert.ok(!plan.readPaths.includes('src')); assert.ok(!plan.readPaths.includes('tests'))
  assert.ok(!plan.targets.some(target => target.nodeId === 'independent'))
  const resources = await deriveSyncBaselineResources(input, plan, f.selection())
  assert.ok(!resources.some(resource => resource.kind === 'path' && resource.path.includes('independent')))
  assert.ok(!plan.executionScope.paths.some(path => path.includes('independent')))
  assert.ok(plan.executionScope.paths.includes('src/export.js'))
})
