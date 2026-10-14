import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeCodeBehavior, deriveBehaviorAuthorization } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { composeInputSnapshots } from './composition.js'
import type { ElaborationRunner } from './elaboration-types.js'
import type { BaselinePair } from './operation-types.js'
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
