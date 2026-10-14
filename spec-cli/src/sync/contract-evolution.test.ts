import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { contractBusinessMeaning, contractBusinessProse, decisionScopeIds, resolvedDecisionGapIds, validateContractEvolution } from './contract-evolution.js'
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
  return { version: 'elaboration-rows-v2', changes: [{ nodeId, path: nodePath, title: String(fm.title), description: '', code: contract.code, related: contract.related, removeIds: [], prose: parseParts(text)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '冻结业务约束', affectedIds: [] })) }
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


test('实现诊断再细化接入已有主流程失败STEP与TR，保留原意和旧验收', async () => {
  const refinement: NonNullable<ElaborationInput['refinement']> = { candidateDigest: sha, diagnostics: [{ code: 'missing_boundary', message: '既定幂等组合缺少空键边界断言' }] }
  const output = build(source), original = structuredClone(output.changes[0].tables.AC[0])
  output.changes[0].prose = contractBusinessProse(parseParts(source)!.expandedSpec)
  const node = output.changes[0]
  const flow = node.tables.FLOW.find(row => row.id === 'FLOW-EXPORT-01')!
  flow.steps = [...flow.steps as string[], 'STEP-EXPORT-FAILURE']
  flow.terminal = [...flow.terminal as string[], 'STATE-EXPORT-FAILED']
  const dispatch = node.tables.STEP.find(row => row.id === 'STEP-EXPORT-03')!
  dispatch.next = [...dispatch.next as string[], 'STEP-EXPORT-FAILURE', 'TR-EXPORT-RUNNING-EMPTY-FAIL']
  const transition = node.tables.TR.find(row => row.id === 'TR-EXPORT-RUNNING-FAIL')!
  transition.effects = '保留失败原因，返回FAILED状态'
  node.tables.TR.push({ ...transition, id: 'TR-EXPORT-RUNNING-EMPTY-FAIL', condition: '当前attempt且reason为空', to: 'STATE-EXPORT-RUNNING', disposition: 'reject', reason: 'invalid-input', effects: '明确拒绝且保持RUNNING' })
  node.tables.STEP.push({ ...dispatch, id: 'STEP-EXPORT-FAILURE', action: '处理当前attempt失败回调，reason非空转FAILED，空reason明确拒绝', input: '当前attempt,reason', output: 'FAILED与原因或保持RUNNING', next: ['TR-EXPORT-RUNNING-FAIL', 'TR-EXPORT-RUNNING-EMPTY-FAIL'], 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL'] })
  node.tables.AC.push({ ...original, id: 'AC-EXPORT-NEW', covers: ['RULE-EXPORT-05', 'TR-EXPORT-RUNNING-EMPTY-FAIL'], action: '当前attempt提交空reason失败回调', assertion: '明确拒绝且保持RUNNING', test: 'tests/export.test.mjs#AC-EXPORT-NEW' })
  const prompts: string[] = []
  const result = await elaborate({ ...input(), refinement }, { runner: runner(output, prompts) })
  assert.equal(result.status, 'complete')
  assert.ok(result.graph!.items.has('AC-EXPORT-NEW'))
  assert.deepEqual(result.graph!.items.get('AC-EXPORT-01') && contractBusinessMeaning(result.graph!.items.get('AC-EXPORT-01')!), contractBusinessMeaning(parseContract({ nodeId: 'export-contract', path, source }).contract!.items.find(item => item.id === 'AC-EXPORT-01')!))
  assert.ok(prompts[0].includes('仅是失败诊断，不是新业务事实或授权'))
  const ordinary = await elaborate(input(), { runner: runner(output) })
  assert.notEqual(result.inputDigest, ordinary.inputDigest)
  const unknown = structuredClone(output)
  unknown.changes[0].tables.GAP.push({ id: 'GAP-EXPORT-FAILURE-AUTO', kind: 'missing_fact', unknown: '新增失败出口是否允许后台自动重试', affects: ['STEP-EXPORT-FAILURE', 'AC-EXPORT-NEW'], evidence: '当前原意只明确所有者重试，未授权后台主体', decision: '明确是否允许后台自动重试', source: 'user:raw', 'depends-on': ['REQ-EXPORT-01'] })
  const blocked = await elaborate({ ...input(), refinement }, { runner: runner(unknown) })
  assert.equal(blocked.status, 'needs_input')
  assert.ok(blocked.blockedIds.includes('AC-EXPORT-NEW'))
  assert.ok(blocked.readyIds.includes('AC-EXPORT-01'))
  const notApplicable = structuredClone(output)
  notApplicable.changes[0].tables.TR.find(row => row.id === 'TR-EXPORT-RUNNING-FAIL')!.disposition = 'not_applicable'
  const escaped = await elaborate({ ...input(), refinement }, { runner: runner(notApplicable) })
  assert.ok(escaped.rounds[0].findings.some(issue => issue.code === 'refinement_accepted_disposition_removed'))
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

test('preserve_business的可信VERIFY登记只校验技术行，不清空已有业务表', async () => {
  const verification = parseContract({ nodeId: 'export-contract', path, source }).contract!.items.filter(item => item.kind === 'VERIFY')
  const result = await elaborate({ ...input(), mode: 'preserve_business', verifications: verification.map(item => ({ id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs })) }, { runner: runner(build(source)) })
  assert.equal(result.status, 'complete')
  assert.equal(result.contracts[0].items.length, parseContract({ nodeId: 'export-contract', path, source }).contract!.items.length)
})

test('纯重构保留反引号及波浪线围栏中的契约表格示例原字节', async () => {
  for (const marker of ['```', '~~~~', '````']) {
    const example = `${marker}markdown\n### REQ\n\n| id | example |\n| --- | --- |\n| REQ-EXAMPLE-01 | 示例 |\n${marker}\n`
    const fenced = source.replace('## expanded spec\n', `## expanded spec\n\n${example}`)
    const context = files(); context.set(path, fenced)
    const state = await readFrozenContracts('/frozen', context)
    assert.deepEqual(state.findings.filter(issue => issue.severity === 'error'), [])
    const snapshot: ElaborationInput = { ...input(), mode: 'preserve_business', targets: [{ nodeId: 'export-contract', path, source: fenced, sourceDigest: elaborationDigest(fenced) }], files: context }
    const output = build(fenced), rendered = renderElaboration(snapshot, output, sha)
    assert.ok(rendered.changes[0].source.includes(example))
    const prompts: string[] = []
    const result = await elaborate(snapshot, { runner: runner(output, prompts) })
    assert.equal(result.status, 'complete')
    assert.equal(prompts.length, 2)
  }
})

test('独立RULE跨叶搬迁可更新canonical authority，真实constraint变化及错误authority仍拒', async () => {
  const before = await readFrozenContracts('/frozen', files()), nextFiles = files()
  const row = source.match(/^\| RULE-EXPORT-02 .*$/m)![0]
  const addedPath = '.spec/export/export-idempotency/spec.md', raw = '原始原意见 [[export-contract]]。'
  const addedSource = `---\ntitle: 幂等权威规则\ncontract-schema: sync-v1\ncode:\n  - src/export.js#ExportService\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |\n${row.replace('| export-contract |', '| export-idempotency |')}\n`
  nextFiles.set(path, source.replace(`${row}\n`, '')); nextFiles.set(addedPath, addedSource)
  const after = await readFrozenContracts('/frozen', nextFiles), newNodeRawSources = new Map([[addedPath, raw]])
  assert.deepEqual(after.findings.filter(issue => issue.severity === 'error'), [])
  const generationPolicy = { newNodeRawSources, verifications: before.contracts[0].items.filter(item => item.kind === 'VERIFY') }
  assert.deepEqual(checkGenerationContractIntent(before, after, generationPolicy), [])
  assert.deepEqual(validateContractEvolution(before, after, policy({ mode: 'preserve_business', newNodeRawSources })), [])
  const snapshot = input(), output = build(nextFiles.get(path)!)
  output.changes[0].removeIds = ['RULE-EXPORT-02']
  output.changes.push(build(addedSource, 'export-idempotency', addedPath).changes[0])
  const result = await elaborate({ ...snapshot, mode: 'preserve_business', targets: [...snapshot.targets, { nodeId: 'export-idempotency', path: addedPath, source: null, sourceDigest: null, rawSource: raw }] }, { runner: runner(output) })
  assert.equal(result.status, 'complete')
  const omittedRemoval = structuredClone(output)
  omittedRemoval.changes[0].removeIds = []
  const duplicate = await elaborate({ ...snapshot, mode: 'preserve_business', targets: [...snapshot.targets, { nodeId: 'export-idempotency', path: addedPath, source: null, sourceDigest: null, rawSource: raw }] }, { runner: runner(omittedRemoval) })
  assert.equal(duplicate.status, 'exhausted')
  assert.ok(duplicate.rounds[0].findings.some(issue => issue.code === 'duplicate-id'))
  const rule = after.graph.items.get('RULE-EXPORT-02')!
  assert.equal(rule.kind, 'RULE')
  for (const invalidSource of [addedSource.replace(rule.constraint, '所有组合均可合并，取消幂等隔离'), addedSource.replace('| export-idempotency |', '| export-contract |')]) {
    const invalidFiles = new Map(nextFiles); invalidFiles.set(addedPath, invalidSource)
    const invalid = await readFrozenContracts('/frozen', invalidFiles)
    assert.ok(checkGenerationContractIntent(before, invalid, generationPolicy).some(issue => issue.code === 'generation-protected-meaning-changed'))
    assert.ok(validateContractEvolution(before, invalid, policy({ mode: 'preserve_business', newNodeRawSources })).some(issue => issue.code === 'refactor_business_meaning_changed'))
  }
})

test('当前裁决的规则与AC范围双检，旧facts、假user:raw和新连边不能扩大作用范围', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence()
  const authority = { stableDecisionId: 'RETRY-ONLY', requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['finding-retry'], ruleIds: ['RULE-EXPORT-06'], affectedIds: ['RULE-EXPORT-06'], paths: [path], decision: { choice: 'new_rule' as const, rule: '只允许失败后重试两次' } }
  const sourceDecision = `decision:${authority.stableDecisionId}` as const
  analysis.analysis.decisionAuthorities = [authority]
  analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.authorizedChanges = [{ ...proposal, source: sourceDecision }]
  const facts = [{ source: sourceDecision, text: '模型声称裁决授权所有规则，实际只选择重试' }, { source: 'decision:EXPORT-POLICY', text: source }]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const authorization = (): AuthorizedContractChange => ({ ...proposal, source: sourceDecision, analysisRef: analysis.ref })
  const changedFiles = files(), rule = before.graph.items.get('RULE-EXPORT-02')!
  assert.equal(rule.kind, 'RULE')
  changedFiles.set(path, updatedSource(source).replace(rule.constraint, `${rule.constraint}；重复调用同时返回当前状态`))
  const after = await readFrozenContracts('/frozen', changedFiles)
  const rejected = validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorization()], facts, decisionAuthorities: [authority] }))
  assert.ok(rejected.some(issue => issue.code === 'acceptance_update_unauthorized' && issue.itemId === 'AC-EXPORT-01'))
  assert.ok(rejected.some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
  const ruleOnly = files(); ruleOnly.set(path, source.replace(rule.constraint, `${rule.constraint}；取消隔离`))
  assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', ruleOnly), policy({ analysis, facts, decisionAuthorities: [authority] })).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
  analysis.analysis.authorizedChanges = [{ ...proposal, source: 'user:raw' }]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const rawAuthorization: AuthorizedContractChange = { ...proposal, source: 'user:raw', analysisRef: analysis.ref }
  await assert.rejects(elaborate({ ...input(), analysis, facts, authorizedChanges: [rawAuthorization], decisionAuthorities: [authority] }, { runner: runner(build(changedFiles.get(path)!)) }), /作用范围/)
  const relinked = changedFiles.get(path)!.replace('| decision:EXPORT-POLICY | REQ-EXPORT-01 |', '| decision:EXPORT-POLICY | REQ-EXPORT-01,RULE-EXPORT-06 |')
  changedFiles.set(path, relinked)
  const linked = await readFrozenContracts('/frozen', changedFiles)
  assert.ok(validateContractEvolution(before, linked, policy({ analysis, facts, decisionAuthorities: [authority] })).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
})

test('合法所选重试规则及其旧AC通过，已结算裁决不能借事实授权无关AC', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence()
  const authority = { stableDecisionId: 'RETRY-ONLY', requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['finding-retry'], ruleIds: ['RULE-EXPORT-06'], affectedIds: ['RULE-EXPORT-06'], paths: [path], decision: { choice: 'new_rule' as const, rule: '只允许失败后重试两次' } }
  const sourceDecision = `decision:${authority.stableDecisionId}` as const
  analysis.analysis.decisionAuthorities = [authority]
  analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  const authorized: Extract<AuthorizedContractChange, { action: 'update_acceptance' }> = { id: 'AC-EXPORT-08', action: 'update_acceptance', source: sourceDecision, reason: '用户裁决只更新失败重试次数', ruleIds: ['RULE-EXPORT-06'], analysisRef: analysis.ref }
  analysis.analysis.authorizedChanges = [{ ...authorized }]
  delete (analysis.analysis.authorizedChanges[0] as unknown as Record<string, unknown>).analysisRef
  analysis.analysis.changes[0].affectedIds = ['RULE-EXPORT-06', 'AC-EXPORT-08']; analysis.analysis.changes[0].ruleIds = ['RULE-EXPORT-06']
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis)); authorized.analysisRef = { ...analysis.ref }
  const nextFiles = files(), changed = source.replace('仅FAILED可由所有者重试，保持ID，attempt加一并清除失败原因', '仅FAILED可由所有者重试最多两次，保持ID，attempt加一并清除失败原因').replace('ID保持、attempt增加，旧结果无效', 'ID保持、attempt增加，旧结果无效；第三次明确拒绝')
  nextFiles.set(path, changed)
  const after = await readFrozenContracts('/frozen', nextFiles), facts = [{ source: sourceDecision, text: '只允许失败后重试两次' }]
  assert.deepEqual(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: [authorized], facts, decisionAuthorities: [authority] })), [])
  const result = await elaborate({ ...input(), analysis, authorizedChanges: [authorized], facts: [...input().facts!, ...facts], decisionAuthorities: [authority] }, { runner: runner(build(changed)) })
  assert.equal(result.status, 'complete')
  delete analysis.analysis.decision
  analysis.analysis.authorizedChanges = [{ ...proposal, source: sourceDecision }]
  analysis.analysis.changes[0].affectedIds = ['AC-EXPORT-01']; analysis.analysis.changes[0].ruleIds = ['RULE-EXPORT-02']
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const unrelated: AuthorizedContractChange = { ...proposal, source: sourceDecision, analysisRef: analysis.ref }
  await assert.rejects(elaborate({ ...input(), analysis, authorizedChanges: [unrelated], facts, decisionAuthorities: [authority] }, { runner: runner(build(source)) }), /作用范围/)
  const oldRow = source.match(/^\| RULE-EXPORT-02 .*$/m)![0]
  const oldScoped = source.replace(oldRow, oldRow.replace('decision:EXPORT-POLICY', sourceDecision))
  const previousFiles = files(); previousFiles.set(path, oldScoped)
  const changedFiles = files(); changedFiles.set(path, oldScoped.replace('不同filter拒绝且原任务不变', '不同filter也返回同任务'))
  const oldAuthorityIssues = validateContractEvolution(await readFrozenContracts('/frozen', previousFiles), await readFrozenContracts('/frozen', changedFiles), policy({ analysis, facts, decisionAuthorities: [authority] }))
  assert.ok(oldAuthorityIssues.some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
})

test('裁决退役逐项绑定旧节点删除独审，全节点选择通过、部分规则选择不得扩大退役', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence()
  const ids = [...before.graph.items.keys()], authority = { stableDecisionId: 'RETIRE-EXPORT', requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['finding-node-removal'], ruleIds: [] as string[], affectedIds: ids, paths: [path], decision: { choice: 'adopt_behavior' as const } }
  const sourceDecision = `decision:${authority.stableDecisionId}` as const
  analysis.analysis.decisionAuthorities = [authority]
  analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.authorizedChanges = ids.map(id => ({ id, action: 'retire', source: sourceDecision, reason: '用户选择已查证的整个节点退役' }))
  analysis.analysis.nodeChanges = [{ action: 'retire', from: { nodeId: 'export-contract', path } }]
  analysis.analysis.resolutions = [{ path, content: null, mode: null }]
  analysis.analysis.changes[0].paths = [path]; analysis.analysis.changes[0].affectedIds = ids
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const authorizedChanges: AuthorizedContractChange[] = analysis.analysis.authorizedChanges.map(proposal => ({ ...proposal, analysisRef: analysis.ref }))
  const nextFiles = files(); nextFiles.delete(path)
  const after = await readFrozenContracts('/frozen', nextFiles), facts = [{ source: sourceDecision, text: '整个导出节点退役，已查证源与交付差量' }]
  assert.deepEqual(validateContractEvolution(before, after, policy({ analysis, authorizedChanges, facts, decisionAuthorities: [authority], nodeChanges: [{ ...analysis.analysis.nodeChanges[0], evidenceRef: analysis.ref }] })), [])
  const authorDeleted = structuredClone(analysis)
  delete authorDeleted.analysis.decision
  authorDeleted.analysis.authorizedChanges = ids.map(id => ({ id, action: 'retire', source: 'user:raw', reason: '作者明确删除已采纳节点' }))
  authorDeleted.ref.sha256 = elaborationDigest(JSON.stringify(authorDeleted.analysis))
  const authorPolicy = (): ContractEvolutionPolicy => policy({ analysis: authorDeleted, authorizedChanges: authorDeleted.analysis.authorizedChanges.map(proposal => ({ ...proposal, analysisRef: authorDeleted.ref })), nodeChanges: [{ ...authorDeleted.analysis.nodeChanges[0], evidenceRef: authorDeleted.ref }] })
  assert.ok(validateContractEvolution(before, after, authorPolicy()).some(issue => issue.code === 'contract_authorization_untrusted'))
  authorDeleted.analysis.authorChanges = [{ nodeId: 'export-contract', path, beforeRaw: '作者原文与尚未ff的前轮交付原意版本不同。', afterRaw: null, changedIds: ids }]
  authorDeleted.ref.sha256 = elaborationDigest(JSON.stringify(authorDeleted.analysis))
  assert.deepEqual(validateContractEvolution(before, after, authorPolicy()), [])
  const partial = { ...authority, ruleIds: ['RULE-EXPORT-06'], affectedIds: ['RULE-EXPORT-06'] }
  analysis.analysis.decisionAuthorities = [partial]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.ok(validateContractEvolution(before, after, policy({ analysis, authorizedChanges: authorizedChanges.map(change => ({ ...change, analysisRef: analysis.ref })), facts, decisionAuthorities: [partial], nodeChanges: [{ ...analysis.analysis.nodeChanges[0], evidenceRef: analysis.ref }] })).some(issue => issue.code === 'contract_authorization_untrusted' && issue.itemId === 'AC-EXPORT-01'))
  authorDeleted.analysis.decision = { requestRef: partial.requestRef, analysisRef: partial.analysisRef, findingIds: partial.findingIds }
  authorDeleted.analysis.decisionAuthorities = [partial]
  authorDeleted.ref.sha256 = elaborationDigest(JSON.stringify(authorDeleted.analysis))
  assert.deepEqual(validateContractEvolution(before, after, authorPolicy()), [])
})

test('当前裁决保留独立raw-only作者更新，精确三方正文及具体AC授权不扩未选规则范围', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence(), originalRaw = before.contracts[0].rawSource
  const authorRaw = `${originalRaw}\n重复提交还应返回当前状态。`, integratedRaw = `${authorRaw}\n失败重试最多两次。`
  const authority = { stableDecisionId: 'RETRY-ONLY', requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['finding-retry'], ruleIds: ['RULE-EXPORT-06'], affectedIds: ['RULE-EXPORT-06'], paths: [path], decision: { choice: 'new_rule' as const, rule: '失败重试最多两次。' } }
  const proposal = { id: 'AC-EXPORT-01', action: 'update_acceptance' as const, source: 'user:raw' as const, reason: '原不可变作者请求明确返回当前状态', ruleIds: ['REQ-EXPORT-01'] }
  analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.decisionAuthorities = [authority]
  analysis.analysis.authorizedChanges = [proposal]
  analysis.analysis.authorChanges = [{ nodeId: 'export-contract', path, beforeRaw: originalRaw, afterRaw: authorRaw, changedIds: ['REQ-EXPORT-01'] }]
  analysis.analysis.rawIntegrations = [{ path, sourceRaw: authorRaw, deliveryRaw: originalRaw, resolvedRaw: authorRaw, expectedRaw: integratedRaw }]
  analysis.analysis.resolutions = [{ path, content: source.replace(originalRaw, authorRaw), mode: '100644' }]
  analysis.analysis.changes[0].ruleIds = proposal.ruleIds
  analysis.analysis.changes[0].paths = [path]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const changes = (): AuthorizedContractChange[] => [{ ...proposal, analysisRef: analysis.ref }]
  const expectedRaw = new Map([[path, integratedRaw]])
  const candidate = source.replace(originalRaw, integratedRaw).replace('同组合返回同ID，冲突不改原任务', '同组合返回同ID及当前状态，冲突不改原任务')
  const candidateFiles = files(); candidateFiles.set(path, candidate)
  const after = await readFrozenContracts('/frozen', candidateFiles)
  const selectedPolicy = (): ContractEvolutionPolicy => policy({ analysis, authorizedChanges: changes(), decisionAuthorities: [authority], newNodeRawSources: expectedRaw })
  assert.deepEqual(validateContractEvolution(before, after, selectedPolicy()), [])
  const result = await elaborate({ ...input(), intent: { nodeId: 'export-contract', rawSource: integratedRaw }, analysis, authorizedChanges: changes(), decisionAuthorities: [authority] }, { runner: runner(build(candidate)) })
  assert.equal(result.status, 'complete')
  const bareRuleFiles = new Map(candidateFiles); bareRuleFiles.set(path, candidate.replace('不同filter拒绝且原任务不变', '不同filter也返回同任务'))
  assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', bareRuleFiles), selectedPolicy()).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
  analysis.analysis.rawIntegrations[0].expectedRaw = authorRaw
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.ok(validateContractEvolution(before, after, selectedPolicy()).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'AC-EXPORT-01'))
  const explicitRuleFiles = files(); explicitRuleFiles.set(path, source.replace('不同filter拒绝且原任务不变', '不同filter明确拒绝并保持原任务状态'))
  analysis.analysis.authorizedChanges = []
  analysis.analysis.authorChanges = [{ nodeId: 'export-contract', path, beforeRaw: originalRaw, afterRaw: originalRaw, changedIds: ['RULE-EXPORT-02'] }]
  analysis.analysis.changes[0].affectedIds = ['RULE-EXPORT-02']
  analysis.analysis.changes[0].ruleIds = ['RULE-EXPORT-02']
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.deepEqual(validateContractEvolution(before, await readFrozenContracts('/frozen', explicitRuleFiles), policy({ analysis, decisionAuthorities: [authority] })), [])
})

test('独立raw-only参数需求可派生既有RULE及AC，具体独审映射不授权无关规则', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence(), originalRaw = before.contracts[0].rawSource
  const authorRaw = `${originalRaw}\n导出filter长度最多128个字符。`, expectedRaw = `${authorRaw}\n失败重试最多两次。`
  const authority = { stableDecisionId: 'RETRY-ONLY', requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['finding-retry'], ruleIds: ['RULE-EXPORT-06'], affectedIds: ['RULE-EXPORT-06'], paths: [path], decision: { choice: 'new_rule' as const, rule: '失败重试最多两次。' } }
  const proposal = { id: 'AC-EXPORT-02', action: 'update_acceptance' as const, source: 'user:raw' as const, reason: '真实高层参数长度需求更新下游规则与边界验收', ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-02'] }
  analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.decisionAuthorities = [authority]
  analysis.analysis.authorizedChanges = [proposal]
  analysis.analysis.authorChanges = [{ nodeId: 'export-contract', path, beforeRaw: originalRaw, afterRaw: authorRaw, changedIds: ['REQ-EXPORT-01'] }]
  analysis.analysis.resolutions = [{ path, content: source.replace(originalRaw, authorRaw), mode: '100644' }]
  analysis.analysis.rawIntegrations = [{ path, sourceRaw: authorRaw, deliveryRaw: originalRaw, resolvedRaw: authorRaw, expectedRaw }]
  analysis.analysis.changes[0].affectedIds = ['RULE-EXPORT-02', 'AC-EXPORT-02']
  analysis.analysis.changes[0].ruleIds = ['REQ-EXPORT-01', 'RULE-EXPORT-02']
  analysis.analysis.changes[0].paths = [path]
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  const authorizedChanges = (): AuthorizedContractChange[] => [{ ...proposal, analysisRef: analysis.ref }]
  const candidate = source.replace(originalRaw, expectedRaw).replace('key与非空字符串filter必需；', 'key与非空字符串filter必需且长度最多128；').replace('非法输入或空结果回调 | 明确拒绝，状态不变', '非法输入、129字符filter或空结果回调 | 明确拒绝，状态不变')
  const candidateFiles = files(); candidateFiles.set(path, candidate)
  const selectedPolicy = (): ContractEvolutionPolicy => policy({ analysis, authorizedChanges: authorizedChanges(), decisionAuthorities: [authority], newNodeRawSources: new Map([[path, expectedRaw]]) })
  assert.deepEqual(validateContractEvolution(before, await readFrozenContracts('/frozen', candidateFiles), selectedPolicy()), [])
  assert.equal((await elaborate({ ...input(), intent: { nodeId: 'export-contract', rawSource: expectedRaw }, analysis, authorizedChanges: authorizedChanges(), decisionAuthorities: [authority] }, { runner: runner(build(candidate)) })).status, 'complete')
  const unrelatedFiles = new Map(candidateFiles); unrelatedFiles.set(path, candidate.replace('成功需非空result、发布一次', '成功允许空result且发布两次'))
  assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', unrelatedFiles), selectedPolicy()).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-05'))
  analysis.analysis.changes[0].ruleIds = ['RULE-EXPORT-02']
  analysis.ref.sha256 = elaborationDigest(JSON.stringify(analysis.analysis))
  assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', candidateFiles), selectedPolicy()).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
})

test('真实冻结move允许空tables保留RULE稳定ID并程序迁移authority，未授权rename仍拒', async () => {
  const nextPath = '.spec/export/renamed-contract/spec.md'
  const move: ContractNodeChange = { action: 'move', from: { nodeId: 'export-contract', path }, to: { nodeId: 'renamed-contract', path: nextPath }, evidenceRef: { sha256: sha } }
  const output = build(source, 'renamed-contract', nextPath)
  output.changes[0].prose = null
  output.changes[0].tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
  const result = await elaborate({ ...input(), nodeChanges: [move] }, { runner: runner(output) })
  assert.equal(result.status, 'complete')
  assert.equal(result.changes[0].path, nextPath)
  assert.equal(result.contracts[0].rawSource, parseParts(source)!.rawSource)
  assert.ok(result.changes[0].source.includes(parseParts(source)!.rawSource))
  const rules = result.contracts[0].items.filter(item => item.kind === 'RULE')
  assert.ok(rules.length > 0 && rules.every(rule => rule.authority === move.to.nodeId))
  assert.deepEqual(rules.map(rule => rule.id), parseContract({ nodeId: 'export-contract', path, source }).contract!.items.filter(item => item.kind === 'RULE').map(rule => rule.id))
  const omitted = await elaborate({ ...input(), nodeChanges: [move] }, { runner: runner({ ...output, changes: [] }) })
  assert.equal(omitted.status, 'complete')
  assert.equal(omitted.changes[0].path, nextPath)
  assert.ok(omitted.contracts[0].items.filter(item => item.kind === 'RULE').every(rule => rule.authority === move.to.nodeId))
  const unauthorized = await elaborate(input(), { runner: runner(output) })
  assert.equal(unauthorized.status, 'exhausted')
  assert.ok(unauthorized.rounds[0].findings.some(issue => issue.code === 'write_scope'))
})


test('共享REQ仅当前真实所选规则上游本身eligible，不从父REQ扩闭包或借新连边', async () => {
  const previousFiles = files(), row = source.split('\n').find(line => line.startsWith('| REQ-EXPORT-01 '))!
  previousFiles.set(path, source.replace(row, `${row}\n${row.replace('REQ-EXPORT-01', 'REQ-EXPORT-OTHER').replace('提交筛选数据导出并下载完成结果', '独立管理义务不得被本次下载裁决改变')}`))
  const before = await readFrozenContracts('/frozen', previousFiles)
  const authority = { stableDecisionId: sha, requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['selected-owner'], ruleIds: ['RULE-EXPORT-01'], affectedIds: ['REQ-EXPORT-01', 'REQ-EXPORT-OTHER', 'RULE-EXPORT-01', 'STEP-EXPORT-04', 'AC-EXPORT-03'], paths: ['src/export.js'], decision: { choice: 'new_rule' as const, rule: '只变更下载权限，其他需求与原所有者操作保持' } }
  const current = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  const scope = decisionScopeIds(before, authority, current)
  assert.ok(scope.has('REQ-EXPORT-01')); assert.ok(scope.has('AC-EXPORT-03')); assert.ok(scope.has('STEP-EXPORT-04'))
  assert.equal(scope.has('REQ-EXPORT-OTHER'), false, 'affectedIds包含也不构成所选旧规则来源')
  assert.equal(scope.has('RULE-EXPORT-02'), false, '父REQ不能重新成为闭包种子')
  const mixed = decisionScopeIds(before, { ...authority, ruleIds: ['REQ-EXPORT-01', ...authority.ruleIds] }, current)
  assert.deepEqual([...mixed].sort(), [...scope].sort(), 'REQ在原ruleIds中也不能扩消费者')
  const requirementOnly = { ...authority, ruleIds: ['REQ-EXPORT-01'], affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'] }
  assert.deepEqual([...decisionScopeIds(before, requirementOnly, current)].sort(), [...requirementOnly.affectedIds].sort(), 'REQ-only只保明确affected旧项')
  assert.equal(scope.has('FLOW-EXPORT-02'), false); assert.equal(scope.has('STEP-EXPORT-05'), false, '共享规则的未选旧流程/步骤保持')
  assert.equal(decisionScopeIds(before, authority).has('REQ-EXPORT-01'), false, '旧authority没有当前请求绑定不能追加上游权限')
  for (const binding of [{ ...current, requestRef: { sha256: elaborationDigest('foreign-request') } }, { ...current, analysisRef: { sha256: elaborationDigest('foreign-analysis') } }, { ...current, findingIds: ['unselected-finding'] }]) assert.equal(decisionScopeIds(before, authority, binding).has('REQ-EXPORT-01'), false)
  assert.equal(decisionScopeIds(before, { ...authority, decision: { choice: 'keep_intent' } }, current).has('REQ-EXPORT-01'), false)
  const nextFiles = new Map(previousFiles), rule = before.graph.items.get('RULE-EXPORT-01')!; assert.equal(rule.kind, 'RULE')
  const oldRuleRow = previousFiles.get(path)!.split('\n').find(line => line.startsWith('| RULE-EXPORT-01 '))!
  nextFiles.set(path, previousFiles.get(path)!.replace(oldRuleRow, oldRuleRow.replace('REQ-EXPORT-01', 'REQ-EXPORT-01,REQ-EXPORT-OTHER')))
  assert.equal(decisionScopeIds(before, authority, current, await readFrozenContracts('/frozen', nextFiles)).has('REQ-EXPORT-OTHER'), false, '新依赖边不能自批旧上游')
})


test('共享REQ自然语言扩大未选操作仍由原P1完整候选独审拒绝，eligible不是语义通过', async () => {
  const before = await readFrozenContracts('/frozen', files()), analysis = evidence(), sourceDecision = `decision:${sha}` as const
  const authority = { stableDecisionId: sha, requestRef: { sha256: sha }, operationId: 'operation', inputId: 'input', analysisRef: { sha256: sha }, findingIds: ['selected-download'], ruleIds: ['RULE-EXPORT-01'], affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01', 'AC-EXPORT-03'], paths: ['src/export.js'], decision: { choice: 'new_rule' as const, rule: '仅成功结果下载允许非所有者；取消、重试仍限所有者' } }
  analysis.analysis.decisionAuthorities = [authority]; analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.changes[0] = { ...analysis.analysis.changes[0], affectedIds: authority.affectedIds, ruleIds: authority.ruleIds }
  const proposal: AcceptanceChangeProposal = { id: 'AC-EXPORT-03', action: 'update_acceptance', source: sourceDecision, reason: '仅成功下载权限按所选裁决演化', ruleIds: ['RULE-EXPORT-01'] }
  analysis.analysis.authorizedChanges = [proposal]; analysis.analysis.facts = [{ source: sourceDecision, text: authority.decision.rule }]; analysis.ref = { sha256: elaborationDigest(JSON.stringify(analysis.analysis)) }
  const req = before.graph.items.get('REQ-EXPORT-01')!, rule = before.graph.items.get('RULE-EXPORT-01')!; assert.equal(req.kind, 'REQ'); assert.equal(rule.kind, 'RULE')
  const oldReq = source.split('\n').find(line => line.startsWith('| REQ-EXPORT-01 '))!, oldRule = source.split('\n').find(line => line.startsWith('| RULE-EXPORT-01 '))!
  const candidate = source.replace(oldReq, oldReq.replace(req.goal, '非所有者也可下载、取消、重试其他人的任务').replace('user:raw', sourceDecision)).replace(oldRule, oldRule.replace(rule.constraint, '成功结果允许非所有者下载；取消、重试仍必须所有者').replace('decision:EXPORT-POLICY', sourceDecision)).replace('全部拒绝，原结果可由所有者下载', '成功下载允许非所有者，取消与重试仍拒绝')
  const authorization = { ...proposal, analysisRef: analysis.ref }, afterFiles = files(); afterFiles.set(path, candidate)
  const selected = policy({ analysis, authorizedChanges: [authorization], facts: analysis.analysis.facts, decisionAuthorities: [authority] })
  assert.deepEqual(validateContractEvolution(before, await readFrozenContracts('/frozen', afterFiles), selected), [], '图关系不冒充自由文本语义判定')
  let calls = 0
  const result = await elaborate({ ...input(), analysis, authorizedChanges: [authorization], facts: [...input().facts!, ...analysis.analysis.facts], decisionAuthorities: [authority] }, { runner: async request => {
    calls++
    if (request.purpose === 'elaboration_review') { assert.ok(request.prompt.includes('非所有者也可下载、取消、重试')); assert.ok(request.prompt.includes(authority.decision.rule)) }
    const output = request.purpose === 'elaboration_generate' ? build(candidate) : { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'selected-policy-contradiction', kind: 'repair', message: '共享REQ扩大取消与重试，超出明确仅下载的裁决', affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-06'], evidence: 'REQ声明非所有者可重试，而原RULE-EXPORT-06仍要求FAILED且所有者', decision: '只同步下载例外，保取消及重试的原所有权约束' }] }
    return { sessionId: `semantic-session-${calls}`, threadId: `semantic-thread-${calls}`, turnId: 'turn', output, resultDigest: elaborationDigest(JSON.stringify(output)) }
  } })
  assert.equal(calls, 2); assert.equal(result.structurePassed, true); assert.equal(result.reviewPassed, false); assert.equal(result.failure?.code, 'repair_budget_exhausted')
  assert.ok(result.rounds.flatMap(round => round.findings).some(finding => finding.code === 'selected-policy-contradiction'))
})


test('已审精确裁决仅删除所选旧诊断GAP与依赖，独审后记录退役且不扩大keep业务权', async () => {
  const gapId = 'GAP-EXPORT-DOWNLOAD-DIAGNOSTIC', flowId = 'FLOW-EXPORT-01', stepId = 'STEP-EXPORT-04'
  const flowRow = source.split('\n').find(line => line.startsWith(`| ${flowId} `))!, stepRow = source.split('\n').find(line => line.startsWith(`| ${stepId} `))!
  const gapSection = `\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${gapId} | conflict | 实现下载权限与既定政策冲突 | ${flowId},${stepId},AC-EXPORT-03 | 冻结下载源码未检查所有者 | 按原政策恢复权限 | derived:RULE-EXPORT-01 | REQ-EXPORT-01,RULE-EXPORT-01 |\n`
  const previousSource = source.replace(flowRow, flowRow.replace(/ \|$/, `,${gapId} |`)).replace(stepRow, stepRow.replace(/ \|$/, `,${gapId} |`)) + gapSection
  const previousFiles = files(); previousFiles.set(path, previousSource)
  const before = await readFrozenContracts('/frozen', previousFiles), after = await readFrozenContracts('/frozen', files()), analysis = evidence()
  const authority = { stableDecisionId: sha, requestRef: { sha256: sha }, operationId: 'old-operation', inputId: 'old-input', analysisRef: { sha256: sha }, findingIds: ['selected-download-conflict'], ruleIds: ['RULE-EXPORT-01'], affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01', stepId, 'AC-EXPORT-03'], paths: ['src/export.js'], decision: { choice: 'keep_intent' as const } }
  analysis.analysis.decisionAuthorities = [authority]; analysis.analysis.decision = { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }
  analysis.analysis.changes[0] = { ...analysis.analysis.changes[0], ruleIds: authority.ruleIds, affectedIds: authority.affectedIds }; analysis.analysis.authorizedChanges = []
  analysis.ref = { sha256: elaborationDigest(JSON.stringify(analysis.analysis)) }
  const selected = policy({ analysis, decisionAuthorities: [authority] })
  assert.deepEqual([...resolvedDecisionGapIds(before, after, selected)], [gapId]); assert.deepEqual(validateContractEvolution(before, after, selected), [])
  assert.equal(authority.affectedIds.includes(flowId), false, '父FLOW只有纯诊断依赖清理，不获得业务授权')
  assert.deepEqual([...resolvedDecisionGapIds(before, before, selected)], [], '仍存在的GAP不冒称已删除')
  for (const choice of ['adopt_behavior', 'new_rule'] as const) {
    const alternative = structuredClone(selected); alternative.decisionAuthorities![0].decision = choice === 'new_rule' ? { choice, rule: '仅结清所选下载分歧' } : { choice }; alternative.analysis!.analysis.decisionAuthorities = alternative.decisionAuthorities as typeof analysis.analysis.decisionAuthorities; alternative.analysis!.ref = { sha256: elaborationDigest(JSON.stringify(alternative.analysis!.analysis)) }
    assert.deepEqual(validateContractEvolution(before, after, alternative), [])
  }
  const mutations: ((value: ContractEvolutionPolicy) => void)[] = [
    value => { value.analysis!.analysis.reviewPassed = false },
    value => { value.analysis!.analysis.decision!.requestRef = { sha256: elaborationDigest('foreign-request') } },
    value => { value.analysis!.analysis.decision!.analysisRef = { sha256: elaborationDigest('old-analysis') } },
    value => { value.analysis!.analysis.decision!.findingIds = ['unselected-finding'] },
    value => { value.analysis!.analysis.changes[0].evidence = '' },
    value => { value.analysis!.analysis.changes[0].ruleIds = [] },
    value => { value.analysis!.analysis.changes[0].affectedIds = ['RULE-EXPORT-01'] },
    value => { value.analysis!.analysis.findings = [{ id: 'still-open', kind: 'conflict', affectedIds: [stepId], paths: [path], ruleIds: authority.ruleIds, originalIntent: '下载权限保持', sourceBehavior: '仍开放', deliveryBehavior: '仍开放', evidence: '当前仍冲突', counterexample: '非所有者仍可下载', decision: '待解决' }] },
    value => { value.mode = 'preserve_business' },
    value => { value.preserveAcceptedItems = true },
  ]
  for (const mutate of mutations) {
    const rejected = structuredClone(selected); mutate(rejected); rejected.analysis!.ref = { sha256: elaborationDigest(JSON.stringify(rejected.analysis!.analysis)) }
    assert.deepEqual([...resolvedDecisionGapIds(before, after, rejected)], [])
    assert.ok(validateContractEvolution(before, after, rejected).some(issue => issue.itemId === gapId))
  }
  for (const old of [previousSource.replace(`${flowId},${stepId},AC-EXPORT-03 | 冻结`, `${flowId},${stepId},AC-EXPORT-03,AC-EXPORT-08 | 冻结`), previousSource.replace('derived:RULE-EXPORT-01 | REQ-EXPORT-01,RULE-EXPORT-01', 'derived:RULE-EXPORT-02 | REQ-EXPORT-01,RULE-EXPORT-02'), previousSource.replace('REQ-EXPORT-01,RULE-EXPORT-01 |\n', 'REQ-EXPORT-01,RULE-EXPORT-01,RULE-EXPORT-02 |\n'), previousSource.replace('| RULE-EXPORT-01,RULE-EXPORT-06 |', `| RULE-EXPORT-01,RULE-EXPORT-06,${gapId} |`)]) {
    const prior = files(); prior.set(path, old)
    assert.deepEqual([...resolvedDecisionGapIds(await readFrozenContracts('/frozen', prior), after, selected)], [], '共享选外义务及隐藏消费者不能借诊断自批清除')
  }
  const flow = before.graph.items.get(flowId)!, step = before.graph.items.get(stepId)!, rule = before.graph.items.get('RULE-EXPORT-01')!, ac = before.graph.items.get('AC-EXPORT-03')!, verify = before.graph.items.get('VERIFY-EXPORT-01')!
  assert.equal(flow.kind, 'FLOW'); assert.equal(step.kind, 'STEP'); assert.equal(rule.kind, 'RULE'); assert.equal(ac.kind, 'AC'); assert.equal(verify.kind, 'VERIFY')
  for (const changed of [source.replace(flow.entry, '任意人可操作其他任务'), source.replace(step.action, '无条件下载'), source.replace('| END | derived:FLOW-EXPORT-01 | RULE-EXPORT-01,RULE-EXPORT-03 |', '| STEP-EXPORT-05 | derived:FLOW-EXPORT-01 | RULE-EXPORT-01,RULE-EXPORT-03 |'), source.replace(rule.constraint, '不要求所有者'), source.replace(ac.assertion, '无条件允许'), source.replace(JSON.stringify(verify.command), '["node","--version"]'), source.replace(parseParts(source)!.rawSource, '改变原始业务目标'), source.replace(/^\| AC-EXPORT-03 .*\n/m, ''), source.replace(/^\| VERIFY-EXPORT-01 .*\n/m, '')]) {
    const next = files(); next.set(path, changed)
    assert.ok(validateContractEvolution(before, await readFrozenContracts('/frozen', next), selected).length, '清理不授权raw/政策/业务字段/AC/VERIFY改变或删除')
  }
  const output = build(source); output.changes[0].removeIds = [gapId]
  const elaborationInput = { ...input(), targets: [{ nodeId: 'export-contract', path, source: previousSource, sourceDigest: elaborationDigest(previousSource) }], files: previousFiles, analysis, decisionAuthorities: [authority] }
  const accepted = await elaborate(elaborationInput, { runner: runner(output) })
  assert.equal(accepted.status, 'complete', JSON.stringify(accepted.rounds.map(round => round.findings))); assert.equal(accepted.reviewPassed, true); assert.deepEqual(accepted.retiredIds, [gapId])
  let calls = 0
  const rejected = await elaborate(elaborationInput, { runner: async request => {
    calls++; const result = await runner(output)(request)
    if (request.purpose === 'elaboration_review') { result.output = { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'diagnostic-not-resolved', kind: 'repair', message: '候选尚不能结清诊断', affectedIds: [stepId], evidence: '完整候选审查发现权限仍冲突', decision: '恢复诊断并修复权限' }] }; result.resultDigest = elaborationDigest(JSON.stringify(result.output)) }
    return { ...result, sessionId: `gap-review-${calls}`, threadId: `gap-review-thread-${calls}` }
  } })
  assert.equal(rejected.reviewPassed, false); assert.deepEqual(rejected.retiredIds, [])
  const reused = await elaborate({ ...input(), retiredIds: accepted.retiredIds }, { runner: runner(build(previousSource)) })
  assert.ok(reused.rounds[0].findings.some(issue => issue.code === 'retired_id_reused' && issue.itemId === gapId))
})
