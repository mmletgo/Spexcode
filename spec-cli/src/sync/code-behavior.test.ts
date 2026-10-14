import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeCodeBehavior, deriveBehaviorAuthorization } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { adoptedDeliveryPaths, composeInputSnapshots } from './composition.js'
import { buildSyncApplicationPlan } from './planning.js'
import { readFrozenContracts } from './frozen-contracts.js'
import type { ElaborationRunner } from './elaboration-types.js'
import type { BaselinePair } from './operation-types.js'
import { controlledDecisionIdentity, prepareControlledDecision } from './request-input.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import type { CodeBehaviorAnalysis, CodeBehaviorKind } from './writeback-types.js'

const fixturePath = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
async function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-behavior-')), root = join(parent, 'source'), delivery = join(parent, 'delivery')
  mkdirSync(root); cpSync(fixturePath, root, { recursive: true }); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'behavior fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  git(root, 'switch', '-c', 'source'); git(root, 'worktree', 'add', '-b', 'delivery', delivery, 'HEAD')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const base = await captureInputSnapshot(root), raw = readFileSync(join(root, '.spec/export/export-contract/spec.md'), 'utf8')
  const source = readFileSync(join(root, 'src/export.js'), 'utf8')
  const pair = async (): Promise<BaselinePair> => ({ id: 'pair-verified', repositoryId: base.source.repositoryId, source: base.source, sourceInput: base, verifiedDelivery: await captureInputSnapshot(delivery), coveredScope: { paths: ['src', '.spec', 'tests'], contractIds: [], flowIds: [] }, receiptId: 'receipt-real-fixture', settledAtMs: 1 })
  const input = async (): Promise<CodeBehaviorInput> => {
    const snapshot = await captureInputSnapshot(root), baseline = await pair(), composed = composeInputSnapshots(snapshot, baseline, { retainConflicts: true }).composed!
    return { snapshot, baseline, composed, readSetDigest: 'readset-frozen', policyDigest: 'policy-frozen', requestKey: 'behavior-test', timeoutMs: 10000, plan: { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: '.spec/export/export-contract/spec.md' }], readPaths: ['src', '.spec', 'tests'], writePaths: ['src', '.spec', 'tests'], facts: [{ source: 'decision:EXPORT-POLICY', text: raw }], verifications: [], mandatoryTests: [] } }
  }
  return { root, delivery, base, raw, source, input }
}
function runner(kind: CodeBehaviorKind, patch?: (proposal: Record<string, unknown>, frozen: { changedPaths: string[] }) => void, reviewPatch?: (review: Record<string, unknown>) => void): ElaborationRunner {
  return async request => {
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      const proposal = { changes: frozen.changedPaths.map(path => ({ kind, paths: [path], affectedIds: ['RULE-EXPORT-05', 'AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '成功返回非空结果并发布一次', previousBehavior: '完成任务返回副本', sourceBehavior: '完成任务返回副本与可观察扩展信息', deliveryBehavior: '前次交付保留副本与明确原意', evidence: `完整冻结源码/调用测试 ${path}`, counterexample: '完成同一任务两次不得发布两次' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
      patch?.(proposal, frozen); output = proposal
    } else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: CodeBehaviorAnalysis }
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      const review = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: frozen.changedPaths, checkedChangeIds: reviewed.analysis.changes.map(item => item.id), findings: [] }
      reviewPatch?.(review); output = review
    }
    return { sessionId: `session-${request.purpose}`, threadId: `thread-${request.purpose}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}

test('真实三方Git对象进入独立行为分析，允许外部行为证据先冻结再派生AC授权', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, observable: true };'))
  const input = await f.input(), calls: string[] = [], fake = runner('allowed_change', proposal => { proposal.facts = [{ source: 'code:src/export.js#ExportService.dispatch', text: '完成视图保留结果并附加observable:true' }]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source: 'code:src/export.js#ExportService.dispatch', reason: '更新已允许输出的可观察细节，不删旧断言' }] })
  const analysis = await analyzeCodeBehavior(input, async request => { calls.push(request.prompt); return fake(request) })
  assert.equal(analysis.reviewPassed, true); assert.equal(analysis.baselinePairId, 'pair-verified')
  assert.equal(analysis.traces.length, 2); assert.notEqual(analysis.traces[0].sessionId, analysis.traces[1].sessionId)
  assert.ok(calls.every(prompt => prompt.includes(JSON.stringify(f.source)) && prompt.includes('observable: true') && prompt.includes('verifiedDelivery') && prompt.includes('assert')))
  const ref = writeEvidence(input.snapshot.source.commonDir, analysis), auth = deriveBehaviorAuthorization(analysis, ref)
  assert.equal(auth[0].action, 'update_acceptance'); assert.deepEqual(auth[0].action === 'update_acceptance' && auth[0].analysisRef, ref)
  assert.deepEqual(JSON.parse(readEvidence(input.snapshot.source.commonDir, ref).toString()), analysis)
  assert.throws(() => deriveBehaviorAuthorization(analysis, { sha256: 'f'.repeat(64) }), /已冻结独审blob/)
})

test('文本冲突先保留三方对象，不因git重叠判业务冲突；相容解决方案由独审核对', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.delivery, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, priorDelivery: true };'))
  writeFileSync(join(f.root, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, newSource: true };'))
  const input = await f.input()
  assert.ok(input.composed.compositionEvidenceBlob)
  const overlaps = JSON.parse(readEvidence(input.snapshot.source.commonDir, input.composed.compositionEvidenceBlob!).toString()) as { conflicts: unknown[] }
  assert.equal(overlaps.conflicts.length, 1)
  assert.equal(composeInputSnapshots(input.snapshot, input.baseline!).composed, null)
  const content = f.source.replace('return { ...job };', 'return { ...job, priorDelivery: true, newSource: true };')
  const analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.resolutions = [{ path: 'src/export.js', content, mode: '100644' }] }))
  assert.equal(analysis.findings.length, 0); assert.equal(analysis.resolutions[0].content, content)
  const entry = readTree(input.snapshot.source.commonDir, input.composed.tree).find(item => item.path === 'src/export.js')!
  assert.ok(readObject(input.snapshot.source.commonDir, entry.oid).toString().includes('newSource: true'))
  assert.ok(readFileSync(join(f.delivery, 'src/export.js'), 'utf8').includes('priorDelivery: true'))
})

test('重构只分类映射，不生成业务授权；冲突与GAP保留具体规则/路径/原意/反例稳定ID', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// internal refactor\n`)
  const input = await f.input(), refactor = await analyzeCodeBehavior(input, runner('refactor'))
  assert.deepEqual(refactor.authorizedChanges, []); assert.deepEqual(refactor.findings, [])
  for (const kind of ['conflict', 'coverage_gap'] as const) {
    const first = await analyzeCodeBehavior(input, runner(kind)), second = await analyzeCodeBehavior(input, runner(kind))
    assert.equal(first.findings[0].id, second.findings[0].id); assert.equal(first.findings[0].kind, kind)
    assert.deepEqual(first.findings[0].ruleIds, ['RULE-EXPORT-05']); assert.ok(first.findings[0].originalIntent && first.findings[0].sourceBehavior && first.findings[0].deliveryBehavior && first.findings[0].counterexample)
  }
})

test('独审不完整/不独立、遗漏外部路径、自授权删除与弱化验收均不产出授权', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// new source\n`)
  const input = await f.input()
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.changes = [] })), /遗漏/)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', undefined, review => { review.checkedPaths = [] })), /独审未接受/)
  await assert.rejects(analyzeCodeBehavior(input, async request => { const result = await runner('refactor')(request); return { ...result, sessionId: 'same' } }), /独立会话/)
  await assert.rejects(analyzeCodeBehavior(input, runner('conflict', proposal => { proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source: 'user:raw', reason: '通过删除错误原始验收变绿' }] })), /没有合法已审规则变化/)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.facts = [{ source: 'decision:SELF-APPROVED', text: '自批允许所有人下载' }] })), /没有冻结代码来源/)
})

test('无治理新增实现自动定位真实上层并生成唯一叶身份；未知上层不能略过', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/view.js'), 'export const view = job => ({ id: job.id });\n')
  const input = await f.input(), analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: 'src/view.js', parentNodeId: 'export-contract', basis: '导出任务可见反馈属于明确raw' }] }))
  assert.equal(analysis.newNodes.length, 1); assert.match(analysis.newNodes[0].path, /^\.spec\/export\/export-contract\/sync-code-/)
  assert.ok(analysis.newNodes[0].rawSource.includes('[[export-contract]]')); assert.equal(analysis.newNodes[0].codePath, 'src/view.js')
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: 'src/view.js', parentNodeId: 'unknown', basis: '猜测目标' }] })), /没有真实上层需求/)
})

test('共同基线区分前次交付接受回声与真实新raw，已交付详细规则不升为user:raw', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  const delivered = f.raw.replace('成功需非空result、发布一次', '成功需非空result、发布一次并返回额外可观察字段')
  writeFileSync(join(f.delivery, path), delivered); writeFileSync(join(f.root, path), delivered)
  const echo = await analyzeCodeBehavior(await f.input(), runner('refactor'))
  assert.deepEqual(echo.authorChanges, [])
  writeFileSync(join(f.root, path), f.raw.replace('用户可以提交符合筛选条件的数据导出，任务完成后下载结果。', '用户可以提交符合筛选条件的数据导出，任务完成后下载结果并看到明确的计数。'))
  const changed = await analyzeCodeBehavior(await f.input(), runner('allowed_change'))
  assert.equal(changed.authorChanges!.length, 1); assert.ok(changed.authorChanges![0].changedIds.includes('REQ-EXPORT-01'))
  assert.equal(changed.authorChanges![0].changedIds.includes('RULE-EXPORT-05'), false)
})

test('结构化所选retry裁决不能借decision或user:raw来源更改无关幂等RULE/AC', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external behavior\n`)
  const input = await f.input(), previous = await analyzeCodeBehavior(input, runner('conflict', proposal => { proposal.changes = (proposal.changes as { paths: string[] }[]).map(change => ({ ...change, kind: 'conflict', affectedIds: ['RULE-EXPORT-06'], ruleIds: ['RULE-EXPORT-06'], originalIntent: '明确失败后所有者重试', previousBehavior: '保持ID并增加attempt', sourceBehavior: '外部重试规则待裁决', deliveryBehavior: '原明确重试规则', evidence: '重试分支冻结差异', counterexample: '失败后重复RETRY应保持隔离' })) }))
  const ref = writeEvidence(input.snapshot.source.commonDir, previous)
  const request = { requestId: 'retry-only', operationId: 'original-operation', inputId: input.snapshot.id, analysisRef: ref, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'new_rule' as const, rule: '失败后仅允许重试两次' } }
  input.composed.requestBlob = prepareControlledDecision(input.snapshot, request); input.decision = { request, previous: { ref, analysis: previous } }; input.origin = 'decision'
  const source = `decision:${controlledDecisionIdentity(request)}`
  const fact = { source, text: '只变更失败重试次数，幂等、权限和其他规则保持' }
  input.plan.facts = [...input.plan.facts, fact]
  for (const authorizationSource of [source, 'user:raw']) await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'] }))
    proposal.facts = [fact]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-02'], source: authorizationSource, reason: '借重试裁决更改幂等政策' }]
  })), /所选裁决范围/)
  const scoped = await analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['AC-EXPORT-08'], ruleIds: ['RULE-EXPORT-06'] }))
    proposal.facts = [fact]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-08', ruleIds: ['RULE-EXPORT-06'], source, reason: '仅对应明确的失败重试新规则' }]
  }))
  assert.equal(scoped.authorizedChanges[0].id, 'AC-EXPORT-08'); assert.deepEqual(scoped.decisionAuthorities![0].ruleIds, ['RULE-EXPORT-06'])
})


test('公共计划识别已交付新增叶ff采纳后的move/完整delete，未采纳缺失不退役', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/summary-child/spec.md'
  const config = { sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'], facts: [], mandatoryTests: [], budget: { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 30000 }, verifications: [{ definition: { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs', 'tests/summary.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }] } }
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify(config)); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'trusted sync settings'); git(f.delivery, 'merge', '--ff-only', git(f.root, 'rev-parse', 'HEAD'))
  const before = await captureInputSnapshot(f.root)
  const child = `---
title: 导出计数
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循 [[export-contract]] 的导出反馈需求。

## expanded spec

### REQ

| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-SUMMARY-01 | 返回行数 | user:raw | 遵循导出反馈 | 返回rows.length | REQ-EXPORT-01 |

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-SUMMARY-01 | 成功行数组 | 读取计数 | 返回rows.length | tests/summary.test.mjs#AC-SUMMARY-01 | VERIFY-EXPORT-01 | derived:REQ-SUMMARY-01 | REQ-SUMMARY-01 |
`
  mkdirSync(join(f.delivery, path, '..'), { recursive: true }); writeFileSync(join(f.delivery, path), child)
  writeFileSync(join(f.delivery, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n'); writeFileSync(join(f.delivery, 'tests/summary.test.mjs'), '// accepted helper acceptance\n')
  git(f.delivery, 'add', '.'); git(f.delivery, 'commit', '-m', 'verified delivery introduces helper governance')
  const baseline: BaselinePair = { id: 'actual-delivery-pair', repositoryId: before.source.repositoryId, source: before.source, sourceInput: before, verifiedDelivery: await captureInputSnapshot(f.delivery), coveredScope: { paths: ['src', '.spec', 'tests'], contractIds: ['REQ-SUMMARY-01', 'AC-SUMMARY-01'], flowIds: [] }, receiptId: 'helper-receipt', settledAtMs: 1 }
  const unaccepted = composeInputSnapshots(before, baseline).composed!
  assert.ok(readTree(before.source.commonDir, unaccepted.tree).some(entry => entry.path === path)); assert.equal(adoptedDeliveryPaths(before, baseline).has(path), false)
  git(f.root, 'merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  const movedPath = '.spec/export/summary-moved/spec.md'
  mkdirSync(join(f.root, movedPath, '..'), { recursive: true }); writeFileSync(join(f.root, movedPath), child); rmSync(join(f.root, path))
  let snapshot = await captureInputSnapshot(f.root), composed = composeInputSnapshots(snapshot, baseline).composed!
  assert.equal(readTree(snapshot.source.commonDir, composed.tree).some(entry => entry.path === path), false)
  let plan = await buildSyncApplicationPlan(snapshot, 'summary-child', baseline)
  let analysis = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-move', policyDigest: 'policy-move', requestKey: 'public-move', timeoutMs: 10000 }, runner('refactor'))
  assert.deepEqual(analysis.nodeChanges, [{ action: 'move', from: { nodeId: 'summary-child', path }, to: { nodeId: 'summary-moved', path: movedPath } }]); assert.deepEqual(analysis.authorizedChanges, [])
  rmSync(join(f.root, movedPath)); rmSync(join(f.root, 'src/summary.js'))
  snapshot = await captureInputSnapshot(f.root); composed = composeInputSnapshots(snapshot, baseline).composed!
  plan = await buildSyncApplicationPlan(snapshot, 'summary-child', baseline)
  assert.equal(plan.intentNodeId, 'export-contract'); assert.ok(plan.targets.some(target => target.path === path)); assert.deepEqual(plan.authorizedChanges, undefined)
  analysis = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-retire', policyDigest: 'policy-retire', requestKey: 'public-retire', timeoutMs: 10000 }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: null, mode: null }] }))
  assert.equal(analysis.findings.length, 0, JSON.stringify(analysis)); assert.deepEqual(analysis.nodeChanges, [{ action: 'retire', from: { nodeId: 'summary-child', path } }]); assert.deepEqual(analysis.authorizedChanges.map(change => [change.id, change.action, change.source]), [['REQ-SUMMARY-01', 'retire', 'user:raw'], ['AC-SUMMARY-01', 'retire', 'user:raw']])
  const ref = writeEvidence(snapshot.source.commonDir, analysis); assert.ok(deriveBehaviorAuthorization(analysis, ref).every(change => change.analysisRef?.sha256 === ref.sha256))
  assert.ok(analysis.authorChanges!.some(change => change.path === path && change.afterRaw === null))
  const unresolved = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-retire-conflict', policyDigest: 'policy-retire-conflict', requestKey: 'retire-conflict', timeoutMs: 10000 }, runner('refactor'))
  const unresolvedRef = writeEvidence(snapshot.source.commonDir, unresolved), finding = unresolved.findings.find(item => item.paths.includes(path))!
  assert.ok(finding); assert.deepEqual(finding.ruleIds, [])
  for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) {
    const request = { requestId: `retire-${choice}`, operationId: 'real-retire-parent', inputId: snapshot.id, analysisRef: unresolvedRef, findingIds: [finding.id], decision: choice === 'new_rule' ? { choice, rule: '退役计数辅助，保留导出主流程和旧验证命令' } : { choice } }
    const requestBlob = prepareControlledDecision(snapshot, request)
    const selected = await analyzeCodeBehavior({ snapshot, composed: { ...composed, requestBlob }, baseline, plan, readSetDigest: `readset-${choice}`, policyDigest: `policy-${choice}`, requestKey: `retire-${choice}`, timeoutMs: 10000, decision: { request, previous: { ref: unresolvedRef, analysis: unresolved } } }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: choice === 'keep_intent' ? child : null, mode: choice === 'keep_intent' ? '100644' : null }] }))
    assert.equal(selected.findings.length, 0, JSON.stringify(selected.findings)); assert.equal(selected.nodeChanges.some(item => item.action === 'retire'), choice !== 'keep_intent')
    if (choice !== 'keep_intent') assert.ok(selected.authorizedChanges.every(item => item.source === `decision:${controlledDecisionIdentity(request)}`))
  }

  rmSync(join(f.root, '.spec/export/export-contract'), { recursive: true })
  const empty = await captureInputSnapshot(f.root), finalPlan = await buildSyncApplicationPlan(empty, 'export-contract', baseline)
  assert.equal(finalPlan.intentNodeId, 'export-contract'); assert.ok(finalPlan.targets.some(target => target.path === '.spec/export/export-contract/spec.md' && target.rawSource))
  const frozen = await readFrozenContracts(f.root, new Map(readTree(snapshot.source.commonDir, composed.tree).filter(entry => entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')])))
  assert.ok(frozen.graph.items.has('AC-EXPORT-01'))
})
