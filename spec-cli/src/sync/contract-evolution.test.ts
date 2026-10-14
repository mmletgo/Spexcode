import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { contractBusinessProse, validateContractEvolution } from './contract-evolution.js'
import type { ContractEvolutionPolicy } from './contract-evolution.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import { elaborate, elaborationDigest } from './elaboration.js'
import { renderElaboration } from './elaboration-markdown.js'
import type { ContractCell, GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { AuthorizedContractChange, ElaborationInput, ElaborationRunner } from './elaboration-types.js'
import type { AcceptanceChangeProposal, CodeBehaviorEvidence, ContractNodeChange } from './writeback-types.js'

const fixture = resolve('spec-cli/test/fixtures/spec-sync/export-repo')
const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(resolve(fixture, path), 'utf8')
const files = (): Map<string, string> => new Map([path, 'src/export.js', 'tests/export.test.mjs'].map(path => [path, readFileSync(resolve(fixture, path), 'utf8')]))
const sha = elaborationDigest('native evidence')
const policy = (extra: Partial<ContractEvolutionPolicy> = {}): ContractEvolutionPolicy => ({ mode: 'reelaborate', authorizedChanges: [], nodeChanges: [], retiredIds: [], newNodeRawSources: new Map(), ...extra })
const proposal: AcceptanceChangeProposal = { id: 'AC-EXPORT-01', action: 'update_acceptance', source: 'code:src/export.js#ExportService', reason: '明确幂等结果，保持原始业务目标', ruleIds: ['RULE-EXPORT-02'] }
const evidence = (): CodeBehaviorEvidence => {
  const analysis: CodeBehaviorEvidence['analysis'] = { version: 'code-behavior-v1', inputId: 'input', baselinePairId: 'baseline', composedDigest: sha, readSetDigest: sha, policyDigest: sha, inputDigest: sha,
    changes: [{ id: 'change-1', kind: 'allowed_change', paths: ['src/export.js'], affectedIds: ['AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'], originalIntent: '相同键返回同一任务', previousBehavior: '返回ID', sourceBehavior: '返回ID与状态', deliveryBehavior: '返回ID', evidence: '真实外部修改同键返回值，保留幂等语义', counterexample: '' }], findings: [],
    facts: [{ source: proposal.source, text: '源码同键返回ID与状态，合法细化结果' }], authorizedChanges: [proposal], nodeChanges: [], newNodes: [], resolutions: [],
    traces: ['code_behavior_analyze', 'code_behavior_review'].map((purpose, index) => ({ purpose, sessionId: `session-${index}`, threadId: `thread-${index}`, turnId: `turn-${index}`, resultDigest: sha, inputDigest: sha })), reviewPassed: true }
  return { ref: { sha256: elaborationDigest(JSON.stringify(analysis)) }, analysis }
}
const authorization = (analysis: CodeBehaviorEvidence): AuthorizedContractChange => ({ ...proposal, analysisRef: analysis.ref })
const updatedSource = (base: string): string => base.replace('同组合返回同ID，冲突不改原任务；不同所有者与键的组合不共享任务', '同组合返回同ID及当前状态，冲突不改原任务；不同所有者与键的组合不共享任务').replace('同actor+key+filter重复提交返回同ID', '同actor+key+filter重复提交返回同ID及当前状态')
const build = (text: string, nodeId = 'export-contract', nodePath = path): GeneratedElaboration => {
  const contract = parseContract({ nodeId, path: nodePath, source: text }).contract!
  const fm = parseFrontmatter(text).fm
  const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
    const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
    return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]]
  })))])) as GeneratedTables
  return { version: 'elaboration-rows-v1', changes: [{ nodeId, path: nodePath, title: String(fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(text)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '冻结业务约束', affectedIds: [] })) }
}
const input = (): ElaborationInput => ({ root: '/frozen', requestKey: 'evolution', intent: { nodeId: 'export-contract', rawSource: parseParts(source)!.rawSource }, targets: [{ nodeId: 'export-contract', path, source, sourceDigest: elaborationDigest(source) }], facts: [{ source: 'decision:EXPORT-POLICY', text: '冻结既有业务政策' }], files: files(), maxRepairs: 0 })
const runner = (output: GeneratedElaboration, prompts: string[] = []): ElaborationRunner => async request => {
  prompts.push(request.prompt)
  const value = request.purpose === 'elaboration_generate' ? output : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
  return { sessionId: `session-${prompts.length}`, threadId: `thread-${prompts.length}`, turnId: 'turn', output: value, resultDigest: elaborationDigest(JSON.stringify(value)) }
}

test('合法独审规则变化自动更新AC，接受后的生成器仍不能改政策', async () => {
  const before = await readFrozenContracts('/frozen', files())
  const analysis = evidence(), nextFiles = files()
  const oldRule = before.graph.items.get('RULE-EXPORT-02')!
  assert.equal(oldRule.kind, 'RULE')
  const changed = updatedSource(source).replace(oldRule.constraint, `${oldRule.constraint}；重复调用同时返回当前状态`)
  nextFiles.set(path, changed)
  const after = await readFrozenContracts('/frozen', nextFiles)
  assert.deepEqual(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorization(analysis)] })), [])
  const result = await elaborate({ ...input(), analysis, authorizedChanges: [authorization(analysis)] }, { runner: runner(build(changed)) })
  assert.equal(result.status, 'complete')
  assert.equal(result.reviewPassed, true)
  assert.ok(checkGenerationContractIntent(before, after, { newNodeRawSources: new Map(), verifications: before.contracts[0].items.filter(item => item.kind === 'VERIFY') }).some(issue => issue.code === 'generation-protected-meaning-changed'))
})

test('未授权弱化、伪造分析、自生成失败和未改变规则都被拒绝', async () => {
  const before = await readFrozenContracts('/frozen', files()), nextFiles = files()
  nextFiles.set(path, updatedSource(source))
  const after = await readFrozenContracts('/frozen', nextFiles)
  assert.ok(validateContractEvolution(before, after, policy()).some(issue => issue.code === 'acceptance_update_unauthorized'))
  const analysis = evidence()
  assert.ok(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorization(analysis)] })).some(issue => issue.code === 'acceptance_rule_unchanged'))
  for (const mutate of [(value: CodeBehaviorEvidence) => { value.ref.sha256 = sha }, (value: CodeBehaviorEvidence) => { value.analysis.reviewPassed = false }, (value: CodeBehaviorEvidence) => { value.analysis.traces[1].threadId = value.analysis.traces[0].threadId }, (value: CodeBehaviorEvidence) => { value.analysis.changes[0].kind = 'coverage_gap' }]) {
    const forged = evidence(); mutate(forged)
    if (forged.ref.sha256 !== sha) forged.ref.sha256 = elaborationDigest(JSON.stringify(forged.analysis))
    await assert.rejects(elaborate({ ...input(), analysis: forged, authorizedChanges: [authorization(forged)] }, { runner: runner(build(source)) }), /可信分析/)
  }
})

test('AC跨叶保留原ID，node改名复用mint身份并保持raw和旧新授权可见', async () => {
  const before = await readFrozenContracts('/frozen', files())
  const row = source.match(/^\| AC-EXPORT-01 .*$/m)![0], columns = source.match(/^\| id \| covers .*$/m)![0]
  const addedPath = '.spec/export/export-acceptance/spec.md', raw = '实现原始需求见 [[export-contract]]。'
  const nextFiles = files(); nextFiles.set(path, source.replace(`${row}\n`, ''))
  nextFiles.set(addedPath, `---\ncontract-schema: sync-v1\n---\n## raw source\n${raw}\n## expanded spec\n### AC\n${columns}\n|---|---|---|---|---|---|---|---|---|\n${row}\n`)
  const after = await readFrozenContracts('/frozen', nextFiles)
  assert.deepEqual(validateContractEvolution(before, after, policy({ newNodeRawSources: new Map([[addedPath, raw]]) })), [])
  const nextPath = '.spec/export/renamed-contract/spec.md'
  const move: ContractNodeChange = { action: 'move', from: { nodeId: 'export-contract', path }, to: { nodeId: 'renamed-contract', path: nextPath }, evidenceRef: { sha256: sha } }
  const moved = source.replaceAll('| export-contract |', '| renamed-contract |')
  const prompts: string[] = []
  const result = await elaborate({ ...input(), mode: 'preserve_business', nodeChanges: [move] }, { runner: runner(build(moved, 'renamed-contract', nextPath), prompts) })
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.nodeChanges, [move])
  assert.equal(result.contracts[0].rawSource, before.contracts[0].rawSource)
  assert.equal(result.graph!.items.get('AC-EXPORT-01')!.id, 'AC-EXPORT-01')
  assert.ok(prompts[1].includes(path) && prompts[1].includes(nextPath) && prompts[1].includes('evidenceRef'))
  assert.equal(result.changes[0].beforeDigest, elaborationDigest(source))
})

test('退役清理引用、跨操作不可复用，零active AC仍检查旧节点/schema', async () => {
  const before = await readFrozenContracts('/frozen', files())
  const retire: ContractNodeChange = { action: 'retire', from: { nodeId: 'export-contract', path }, evidenceRef: { sha256: sha } }
  const authorizations: AuthorizedContractChange[] = [...before.graph.items.values()].map(item => ({ id: item.id, action: 'retire', source: 'user:raw', reason: '用户明确退役整个业务能力' }))
  const nextFiles = files(); nextFiles.delete(path)
  const after = await readFrozenContracts('/frozen', nextFiles)
  assert.ok(validateContractEvolution(before, after, policy()).some(issue => issue.code === 'protected_node_removed'))
  assert.deepEqual(validateContractEvolution(before, after, policy({ nodeChanges: [retire], authorizedChanges: authorizations })), [])
  const output = build(source); output.changes = []
  const result = await elaborate({ ...input(), nodeChanges: [retire], authorizedChanges: authorizations }, { runner: runner(output) })
  assert.equal(result.status, 'complete')
  assert.equal(result.graph!.items.size, 0)
  assert.ok(result.retiredIds.includes('export-contract') && result.retiredIds.includes('AC-EXPORT-01'))
  assert.ok(validateContractEvolution(after, before, policy({ retiredIds: result.retiredIds, newNodeRawSources: new Map([[path, before.contracts[0].rawSource]]) })).some(issue => issue.code === 'retired_id_reused'))
  const removedRuleFiles = files(); removedRuleFiles.set(path, source.replace(/^\| RULE-EXPORT-02 .*\n/m, ''))
  const referenced = await readFrozenContracts('/frozen', removedRuleFiles)
  assert.ok(validateContractEvolution(before, referenced, policy({ authorizedChanges: [{ id: 'RULE-EXPORT-02', action: 'retire', source: 'user:raw', reason: '已退役' }] })).some(issue => issue.code === 'retired_reference_remaining'))
})

test('纯重构保留业务正文和字段，仅实现测试符号可改变', async () => {
  const before = await readFrozenContracts('/frozen', files()), nextFiles = files()
  nextFiles.set(path, source.replace('tests/export.test.mjs#AC-EXPORT-01', 'tests/export.test.mjs#AC-EXPORT-NEW'))
  const after = await readFrozenContracts('/frozen', nextFiles)
  assert.deepEqual(validateContractEvolution(before, after, policy({ mode: 'preserve_business' })), [])
  const output = build(source)
  output.changes[0].prose = '模型为生成一致重写全部业务解释'
  output.changes[0].title = '换个业务标题'
  const rendered = renderElaboration({ ...input(), mode: 'preserve_business' }, output, sha)
  assert.equal(parseParts(rendered.changes[0].source)!.rawSource, parseParts(source)!.rawSource)
  assert.ok(!rendered.changes[0].source.includes('模型为生成一致'))
  assert.equal(parseFrontmatter(rendered.changes[0].source).fm.title, parseFrontmatter(source).fm.title)
  const proseFiles = files(); proseFiles.set(path, source.replace('用户事件无权限', '用户事件允许'))
  const prose = await readFrozenContracts('/frozen', proseFiles)
  assert.ok(validateContractEvolution(before, prose, policy({ mode: 'preserve_business' })).some(issue => issue.code === 'refactor_business_prose_changed'))
  assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', new Map([...files()].map(([file, text]) => [file, file === path ? updatedSource(text) : text]))), policy({ mode: 'preserve_business' })).some(issue => issue.code === 'refactor_business_meaning_changed'))
})

test('用户明确raw变化的简单REQ来源能授权AC更新，不要求虚构中间RULE', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence()
  analysis.analysis.authorizedChanges = [{ ...proposal, source: 'user:raw', ruleIds: ['REQ-EXPORT-01'], reason: '用户原意明确要求同键结果包含当前状态' }]
  analysis.analysis.changes[0].ruleIds = ['REQ-EXPORT-01']
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const authorization: AuthorizedContractChange = { ...analysis.analysis.authorizedChanges[0], analysisRef: analysis.ref }
  const raw = `${before.contracts[0].rawSource} 同键返回ID及当前状态。`
  const changed = updatedSource(source).replace(before.contracts[0].rawSource, raw)
  const afterFiles = files(); afterFiles.set(path, changed)
  const after = await readFrozenContracts('/frozen', afterFiles)
  assert.deepEqual(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorization], newNodeRawSources: new Map([[path, raw]]) })), [])
  const result = await elaborate({ ...input(), intent: { nodeId: 'export-contract', rawSource: raw }, analysis, authorizedChanges: [authorization] }, { runner: runner(build(changed)) })
  assert.equal(result.status, 'complete')
})

test('已发生作者规则变化的真实独审差量允许反写AC，错误raw绑定及code自批拒绝', async () => {
  const prior = await readFrozenContracts('/frozen', files()), rule = prior.graph.items.get('RULE-EXPORT-02')!
  assert.equal(rule.kind, 'RULE')
  const authored = source.replace(rule.constraint, `${rule.constraint}；重复调用同时返回当前状态`)
  const sourceFiles = files(); sourceFiles.set(path, authored)
  const before = await readFrozenContracts('/frozen', sourceFiles), afterFiles = new Map(sourceFiles)
  afterFiles.set(path, updatedSource(authored))
  const after = await readFrozenContracts('/frozen', afterFiles), analysis = evidence()
  analysis.analysis.authorizedChanges = [{ ...proposal, source: 'user:raw' }]
  analysis.analysis.authorChanges = [{ nodeId: 'export-contract', path, beforeRaw: prior.contracts[0].rawSource, afterRaw: before.contracts[0].rawSource, changedIds: ['RULE-EXPORT-02'] }]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const authorized = (): AuthorizedContractChange => ({ ...analysis.analysis.authorizedChanges[0], analysisRef: analysis.ref })
  assert.deepEqual(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorized()] })), [])
  const result = await elaborate({ ...input(), targets: [{ nodeId: 'export-contract', path, source: authored, sourceDigest: elaborationDigest(authored) }], analysis, authorizedChanges: [authorized()] }, { runner: runner(build(updatedSource(authored))) })
  assert.equal(result.status, 'complete')
  analysis.analysis.authorChanges[0].afterRaw = '不属于当前输入的旧原意'
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.ok(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorized()] })).some(issue => issue.code === 'acceptance_rule_unchanged'))
  analysis.analysis.authorizedChanges = [proposal]
  analysis.analysis.authorChanges[0].afterRaw = before.contracts[0].rawSource
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.ok(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorization(analysis)] })).some(issue => issue.code === 'acceptance_rule_unchanged'))
})

test('P1审查必须使用不同于行为分析的当前会话线程', async () => {
  const analysis = evidence()
  analysis.analysis.traces[1].sessionId = 'session-2'
  analysis.analysis.traces[1].threadId = 'thread-2'
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const result = await elaborate({ ...input(), analysis }, { runner: runner(build(source)) })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'review_not_independent'))
})


test('实现诊断有限再细化只新增遗漏边界，冻结摘要且保留全部已接受业务', async () => {
  const refinement: NonNullable<ElaborationInput['refinement']> = { candidateDigest: sha, diagnostics: [{ code: 'missing_boundary', message: '既定幂等组合缺少空键边界断言' }] }
  const output = build(source), original = structuredClone(output.changes[0].tables.AC[0])
  output.changes[0].prose = contractBusinessProse(parseParts(source)!.expandedSpec)
  output.changes[0].tables.AC.push({ ...original, id: 'AC-EXPORT-NEW', action: '空键调用', assertion: '明确拒绝且不创建任务', test: 'tests/export.test.mjs#AC-EXPORT-NEW' })
  const prompts: string[] = []
  const result = await elaborate({ ...input(), refinement }, { runner: runner(output, prompts) })
  assert.equal(result.status, 'complete')
  assert.ok(result.graph!.items.has('AC-EXPORT-NEW'))
  assert.ok(prompts[0].includes('仅是失败诊断，不是新业务事实或授权'))
  const ordinary = await elaborate(input(), { runner: runner(output) })
  assert.notEqual(result.inputDigest, ordinary.inputDigest)
  output.changes[0].tables.RULE[0].constraint = '实现失败就取消原政策'
  const rejected = await elaborate({ ...input(), refinement }, { runner: runner(output) })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'refinement_accepted_meaning_changed'))
  await assert.rejects(elaborate({ ...input(), refinement: { ...refinement, candidateDigest: 'stale' } }, { runner: runner(output) }), /再细化诊断/)
})

test('同一操作退役节点后也不能换路径立即复用canonical身份', async () => {
  const before = await readFrozenContracts('/frozen', files()), nextFiles = files()
  nextFiles.delete(path)
  const addedPath = '.spec/new/export-contract/spec.md', raw = '新业务原意，与旧能力无关。'
  nextFiles.set(addedPath, `## raw source\n${raw}\n\n## expanded spec\n新业务说明。\n`)
  const after = await readFrozenContracts('/frozen', nextFiles)
  const authorizedChanges: AuthorizedContractChange[] = [...before.graph.items.values()].map(item => ({ id: item.id, action: 'retire', source: 'user:raw', reason: '用户明确退役旧能力' }))
  const findings = validateContractEvolution(before, after, policy({ authorizedChanges, nodeChanges: [{ action: 'retire', from: { nodeId: 'export-contract', path }, evidenceRef: { sha256: sha } }], newNodeRawSources: new Map([[addedPath, raw]]) }))
  assert.ok(findings.some(issue => issue.code === 'retired_id_reused' && issue.itemId === 'export-contract'))
})
