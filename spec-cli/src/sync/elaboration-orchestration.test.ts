import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildContractGraph, CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts, projectContractCoverage } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest, freezeElaborationInput, projectElaborationFlowReadiness } from './elaboration.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationRepairSeed, ElaborationReview, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { ContractCell, GeneratedElaboration, GeneratedTables, GeneratedTargetElaboration } from './elaboration-markdown.js'
import { bindElaborationTargets, renderElaboration } from './elaboration-markdown.js'
import { CONTRACT_INSTRUCTIONS, ELABORATION_SCHEMA, outputErrors } from './elaboration-schema.js'
import type { CodeBehaviorEvidence, SyncDecisionAuthority } from './writeback-types.js'
import { adaptElaborationNativeOutput } from '../../test/elaboration-native-output.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(new URL(path, fixture), 'utf8')
const rawSource = parseContract({ nodeId: 'export-contract', path, source }).contract!.rawSource
const files = new Map(['src/export.js', 'tests/export.test.mjs'].map(file => [file, readFileSync(new URL(file, fixture), 'utf8')]))
const input = (existing = false): ElaborationInput => ({ root: '/test/frozen-repository', requestKey: 'operation-1', intent: { nodeId: 'export-contract', rawSource }, targets: [{ nodeId: 'export-contract', path, source: existing ? source : null, sourceDigest: existing ? elaborationDigest(source) : null }], facts: [{ source: 'decision:EXPORT-POLICY', text: source }], files, maxRepairs: 1 })
const candidate = (_request: ElaborationSessionRequest, source: string, beforeDigest: string | null = null): GeneratedElaboration => {
  const contract = parseContract({ nodeId: 'export-contract', path, source }).contract!
  const fm = parseFrontmatter(source).fm
  const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => {
    const items = contract.items.filter(item => item.kind === kind)
    return [kind, items.map(item => Object.fromEntries(columns.map(column => {
      const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
      const value = (item as unknown as Record<string, ContractCell>)[key]
      return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
    })))]
  })) as GeneratedTables
  return { version: 'elaboration-rows-v2', changes: [{ nodeId: 'export-contract', path, title: String(fm.title), description: '', code: contract.code, related: contract.related, removeIds: beforeDigest ? parseContract({ nodeId: 'export-contract', path, source: input(true).targets[0].source! }).contract!.items.filter(item => !contract.items.some(next => next.id === item.id)).map(item => item.id) : [], prose: parseParts(source)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '冻结夹具的显式事件及政策', affectedIds: ['REQ-EXPORT-01'] })) }
}
const review = (_request: ElaborationSessionRequest): Omit<ElaborationReview, 'inputDigest' | 'candidateDigest'> => ({ verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] })
const runner = (build: (request: ElaborationSessionRequest, call: number) => unknown, inspect = review): { run: ElaborationRunner; calls: ElaborationSessionRequest[] } => {
  const calls: ElaborationSessionRequest[] = []
  return { calls, run: async request => {
    calls.push(request)
    const generated = request.purpose === 'elaboration_review' ? inspect(request) : build(request, calls.length)
    const output = adaptElaborationNativeOutput(request, generated)
    return { sessionId: `session-${calls.length}`, threadId: `thread-${calls.length}`, turnId: 'turn-1', output, resultDigest: elaborationDigest(JSON.stringify(output)) }
  } }
}

const registeredVerification = (() => {
  const item = parseContract({ nodeId: 'export-contract', path, source }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(item.kind, 'VERIFY')
  return { id: item.id, command: [...item.command], cwd: item.cwd, timeoutMs: item.timeoutMs }
})()

for (const timeoutMs of [1200000, null]) test(`P1显式null总期与模型调用timeout=${timeoutMs}原样进入生成和独审`, async () => {
  const model = runner(request => { assert.equal(request.timeoutMs, timeoutMs); assert.equal(request.signal?.aborted, false); return candidate(request, source) })
  const result = await elaborate({ ...input(), totalTimeoutMs: null, timeoutMs }, { runner: model.run })
  assert.equal(result.status, 'complete'); assert.equal(result.structurePassed, true); assert.equal(result.reviewPassed, true)
  assert.deepEqual(model.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.ok(model.calls.every(call => call.timeoutMs === timeoutMs && call.signal?.aborted === false))
})

test('父接口实际生成和独审请求只承担必要共享接口，不混入完整P1覆盖任务', async () => {
  const raw = '保留导出任务的明确原意，由子实现承接完整流程与验收。'
  const before = `---\ntitle: 导出接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const parent = `---\ntitle: 导出接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层保留必要共享接口。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-EXPORT-01 | 保留导出任务原意 | user:raw | 由子实现承接流程与验收 | 子实现完整保持原意 | - |\n`
  const fake = runner(request => candidate(request, parent))
  const result = await elaborate({ ...input(), phase: 'interface_seed', intent: { nodeId: 'export-contract', rawSource: raw }, targets: [{ nodeId: 'export-contract', path, source: before, sourceDigest: elaborationDigest(before) }], facts: [], maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'interface_seed', JSON.stringify(result.rounds.flatMap(round => round.findings)))
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  for (const request of fake.calls) {
    assert.doesNotMatch(request.prompt, /逐项展开可完成主流程、状态处置和AC|每个业务REQ至少由一个主FLOW.req直接覆盖|每个适用对象全部可达状态×事件必须有TR|主动从场景发现响应丢失后的重复请求|若遗漏对象\/事件\/场景/)
    assert.match(request.prompt, /REQ\/RULE\/GAP/)
    assert.match(request.prompt, /schema允许null的列用JSON null/)
    assert.match(request.prompt, /source必须是唯一单值/)
    assert.match(request.prompt, /description.*prose.*稳定.*业务/)
    assert.match(request.prompt, /不能弱化.*raw|不能.*改写raw/)
  }
})

test('Native P1生成与独审共用来源语义和只读实现边界，interface_seed仍只审父接口', async () => {
  const nativeWorktree = { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const }
  const full = runner(request => candidate(request, source))
  const fullResult = await elaborate({ ...input(), worktree: nativeWorktree, implementationWritePaths: [], maxRepairs: 0 }, { runner: full.run })
  assert.equal(fullResult.status, 'complete', JSON.stringify({ failure: fullResult.failure, findings: fullResult.rounds.flatMap(round => round.findings) }))
  assert.deepEqual(full.calls.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  for (const request of full.calls) {
    assert.match(request.prompt, /可观察本身不等于重大业务政策/)
    assert.match(request.prompt, /普通字段表示\/参数类型\/序列化及等价校验顺序/)
    assert.match(request.prompt, /使用code来源并追到REQ/)
    assert.match(request.prompt, /参数类型或校验若违反明确raw\/facts，必须保留要求并修实现/)
    assert.match(request.prompt, /implementationWritePaths为空数组/)
    assert.match(request.prompt, /源码与全部测试只读/)
    assert.match(request.prompt, /不得发明、新增或补写测试/)
    assert.match(request.prompt, /不得以implementation-review交给无授权P2/)
    assert.match(request.prompt, /readonly_implementation_gap/)
    if (request.purpose === 'elaboration_review') {
      assert.match(request.prompt, /只读实现范围下不派发P2/)
      assert.doesNotMatch(request.prompt, /业务完整但实现错误仅以repair\/implementation-review/)
    }
  }

  const raw = '保留导出任务的明确原意，由子实现承接完整流程与验收。'
  const before = `---\ntitle: 导出接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const parent = `---\ntitle: 导出接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层保留必要共享接口。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-EXPORT-01 | 保留导出任务原意 | user:raw | 由子实现承接流程与验收 | 子实现完整保持原意 | - |\n`
  const seed = runner(request => candidate(request, parent))
  const seedResult = await elaborate({ ...input(), worktree: nativeWorktree, implementationWritePaths: [], phase: 'interface_seed', intent: { nodeId: 'export-contract', rawSource: raw }, targets: [{ nodeId: 'export-contract', path, source: before, sourceDigest: elaborationDigest(before) }], facts: [], maxRepairs: 0 }, { runner: seed.run })
  assert.equal(seedResult.status, 'interface_seed')
  assert.deepEqual(seed.calls.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  for (const request of seed.calls) {
    assert.match(request.prompt, /可观察本身不等于重大业务政策/)
    assert.match(request.prompt, /未由raw\/facts确定的普通字段表示.*由后续子分区读取实现后细化/)
    assert.match(request.prompt, /interface_seed|父接口/)
    assert.doesNotMatch(request.prompt, /逐项展开可完成主流程、状态处置和AC|每个业务REQ至少由一个主FLOW\.req直接覆盖|重新从用户原意和冻结事实走正常、失败、边界、重试/)
  }
})

for (const mode of ['structure', 'review'] as const) test(`Native P1 ${mode}拒绝的第二轮收到真实输出和具体发现，保持只读权限`, async () => {
  const missing = source.split('\n').filter(line => !/^\| TR-EXPORT-(?:STALE-)?CANCELLED-COMPLETE \|/.test(line)).join('\n')
  let generations = 0, reviews = 0
  const fake = runner(request => candidate(request, ++generations === 1 && mode === 'structure' ? missing : source), request => ++reviews === 1 && mode === 'review'
    ? { ...review(request), verdict: 'repair', findings: [{ code: 'native_condition_boundary', kind: 'repair', message: '取消后完成的否定分支遗漏', affectedIds: ['TR-EXPORT-CANCELLED-COMPLETE'], evidence: '真实取消后收到COMPLETE的反例', decision: '保留原REQ/AC并补齐该出口，不造GAP' }] }
    : review(request))
  const snapshot = { ...input(), worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const }, implementationWritePaths: [] }
  const original = structuredClone(snapshot)
  const result = await elaborate(snapshot, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.equal(result.rounds.length, 2)
  const first = result.rounds[0], second = fake.calls.filter(call => call.purpose === 'elaboration_generate')[1]
  assert.ok(second.prompt.includes(JSON.stringify(first.output)), 'Native第二轮必须包含上一轮真实结构化输出')
  assert.ok(second.prompt.includes(mode === 'structure' ? 'missing-event-disposition' : 'native_condition_boundary'), 'Native第二轮必须包含具体拒绝诊断')
  if (mode === 'review') assert.ok(second.prompt.includes(JSON.stringify(first.review)), '完整原独审证据和修复决定必须进入Native修复')
  assert.notEqual(second.inputDigest, fake.calls[0].inputDigest, '真实请求摘要必须绑定反馈变化')
  assert.match(second.prompt, /源码与全部测试只读/)
  assert.match(second.prompt, /deferredImplementation仅原写权允许才交P2实现/)
  assert.match(second.prompt, /readonly_implementation_gap保持阻断/)
  assert.match(second.prompt, /不造GAP|不能.*制造GAP/)
  assert.equal(result.contracts[0].rawSource, rawSource)
  assert.deepEqual(result.gaps, [])
  assert.deepEqual(snapshot, original)
})

test('Native P1跨attempt拒绝seed保留完整JSON、候选和独审，仍需新独立审查', async () => {
  const snapshot = { ...input(), maxRepairs: 0, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const } }
  const first = runner(request => candidate(request, source), request => ({ ...review(request), verdict: 'repair', findings: [{ code: 'native_seed_boundary', kind: 'repair', message: '原seed的取消边界缺失', affectedIds: ['REQ-EXPORT-01'], evidence: '原始独审反例', decision: '保持AC及原意重新核对' }] }))
  const rejected = await elaborate(snapshot, { runner: first.run }), last = rejected.rounds[0]
  const seed: ElaborationRepairSeed = { settled: true, requestKey: snapshot.requestKey, inputDigest: rejected.inputDigest, candidateDigest: last.candidateDigest!, output: last.output, candidate: last.candidate!, findings: last.findings, review: last.review, traces: last.traces }
  const fresh = runner(request => candidate(request, source))
  const accepted = await elaborate({ ...snapshot, requestKey: 'native-seed-attempt-2' }, { seed, runner: async request => { const result = await fresh.run(request); return { ...result, sessionId: `fresh-${result.sessionId}`, threadId: `fresh-${result.threadId}` } } })
  assert.equal(accepted.status, 'complete')
  assert.equal(accepted.inputDigest, seed.inputDigest)
  for (const original of [last.output, last.candidate, last.review]) assert.ok(fresh.calls[0].prompt.includes(JSON.stringify(original)), 'Native须收到经核真的原拒绝JSON/候选/独审')
  assert.match(fresh.calls[0].prompt, /native_seed_boundary/)
  assert.deepEqual(fresh.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('Native P1候选前格式失败的原件诊断进入真实请求摘要且不改变业务输入', async () => {
  const snapshot = { ...input(), maxRepairs: 0, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const }, implementationWritePaths: [] }
  const failed = await elaborate(snapshot, { runner: async () => { throw Object.assign(new Error('terminal输出不是单JSON，$.changes必须为数组；不是新decision授权'), { code: 'structured_output_format_invalid', sessionId: 'failed-native', threadId: 'failed-thread', turnId: 'failed-turn' }) } })
  const diagnostics = { requestKey: snapshot.requestKey, inputDigest: failed.inputDigest, resultRef: { sha256: elaborationDigest(JSON.stringify(failed)) }, failure: failed.failure!, round: failed.rounds[0] }
  const original = structuredClone(diagnostics), fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...snapshot, requestKey: 'native-format-attempt-2' }, { runner: fresh.run, repairDiagnostics: diagnostics })
  assert.equal(result.status, 'complete')
  assert.equal(result.inputDigest, failed.inputDigest)
  assert.equal(result.prior, null, '没有候选的失败不伪造业务拒绝seed')
  assert.deepEqual(result.repairDiagnostics, original)
  assert.deepEqual(diagnostics, original)
  assert.ok(fresh.calls[0].prompt.includes(JSON.stringify(original)))
  assert.match(fresh.calls[0].prompt, /不是raw、事实、业务批准或新授权/)
  assert.equal(fresh.calls[0].inputDigest, elaborationDigest(JSON.stringify({ inputDigest: failed.inputDigest, purpose: fresh.calls[0].purpose, prompt: fresh.calls[0].prompt, schema: fresh.calls[0].schema, worktree: fresh.calls[0].worktree })), '既有真实requestDigest绑定诊断正文和ref')
  assert.deepEqual(result.gaps, [])
  assert.equal(result.contracts[0].rawSource, rawSource)
  await assert.rejects(elaborate({ ...snapshot, requestKey: 'changed-input', facts: [] }, { runner: async () => assert.fail('异业务输入不能收到旧诊断'), repairDiagnostics: diagnostics }), /同一业务输入/)
  await assert.rejects(elaborate(snapshot, { runner: async () => assert.fail('同请求键不能伪装新调用'), repairDiagnostics: diagnostics }), /新的请求键/)
})

test('analysisRef与interface_seed分类变化都会改变P1冻结摘要', () => {
  const sha = 'c'.repeat(64)
  const analysis: CodeBehaviorEvidence = {
    ref: { sha256: 'd'.repeat(64) },
    analysis: { version: 'code-behavior-v1', inputId: 'analysis-input', baselinePairId: null, composedDigest: sha, readSetDigest: sha, policyDigest: sha, inputDigest: sha, changes: [], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [], reviewPassed: true },
  }
  const binding = { planDigest: sha, partitionId: 'export-leaf', analysisRef: analysis.ref }
  const base = { ...input(), analysis, partitionBinding: binding }
  const changedAnalysisRef = { ...base, analysis: { ...analysis, ref: { sha256: 'e'.repeat(64) } }, partitionBinding: { ...binding, analysisRef: { sha256: 'e'.repeat(64) } } }
  const firstDigest = freezeElaborationInput(base).inputDigest
  assert.notEqual(freezeElaborationInput(changedAnalysisRef).inputDigest, firstDigest)

  const seedBase = { ...base, phase: 'interface_seed' as const, partitionBinding: { ...binding, interfaceSeed: { phase: 'interface_seed' as const, parentNodeId: 'export-contract', parentPath: path, descendants: [] } } }
  const changedClassification = { ...seedBase, partitionBinding: { ...seedBase.partitionBinding, interfaceSeed: { phase: 'interface_seed' as const, parentNodeId: 'export-contract', parentPath: path, descendants: [{ nodeId: 'export-child', path: '.spec/export/export-child/spec.md', codePaths: ['src/export.js'], sourcePartitionId: 'export-leaf' }] } } }
  assert.notEqual(freezeElaborationInput(changedClassification).inputDigest, freezeElaborationInput(seedBase).inputDigest)
})

test('非父完整细化的共同指令逐字保留完整P1覆盖与独审任务', async () => {
  assert.equal(elaborationDigest(CONTRACT_INSTRUCTIONS), '1d47bf418e05f7148fb9facf6056334d36817bda9ee023d9c3486fddf0ac126f')
  const fake = runner(request => candidate(request, source))
  await elaborate(input(), { runner: fake.run })
  for (const request of fake.calls) {
    assert.ok(request.prompt.includes(CONTRACT_INSTRUCTIONS))
    assert.doesNotMatch(request.prompt, /implementationWritePaths为空数组表示本轮源码与全部测试只读/)
  }
  assert.match(fake.calls[0].prompt, /逐项展开可完成主流程、状态处置和AC/)
  assert.match(fake.calls[1].prompt, /重新从用户原意和冻结事实走正常、失败、边界、重试、取消、重复及必要竞争顺序/)
})

test('AC-ELABORATION-32 不合法可信登记在任何native前拒绝，复用schema与parser', async () => {
  for (const verifications of [
    [{ ...registeredVerification, id: 'VERIFY-EXPORT' }],
    [{ ...registeredVerification, command: ['sh', '-c', 'node --test'] }],
    [{ ...registeredVerification, command: ['node', '\n'] }],
    [{ ...registeredVerification, cwd: '../outside' }],
    [{ ...registeredVerification, timeoutMs: 0 }],
    [registeredVerification, registeredVerification],
  ]) {
    const fake = runner(request => candidate(request, source))
    await assert.rejects(elaborate({ ...input(), verifications }, { runner: fake.run }), /可信验证登记/)
    assert.equal(fake.calls.length, 0)
  }
})

test('AC-ELABORATION-33 登记不符的输出先硬拒，不能借GAP占位或进入独立review', async () => {
  for (const replaced of [
    source.replaceAll(registeredVerification.id, 'VERIFY-EXPORT-PLACEHOLDER'),
    source.replace(JSON.stringify(registeredVerification.command), JSON.stringify(['node', '--version'])),
  ]) {
    const fake = runner(request => candidate(request, replaced))
    const result = await elaborate({ ...input(), verifications: [registeredVerification], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reviewPassed, false)
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
    assert.ok(result.rounds[0].findings.some(issue => issue.code === 'verification_registration_mismatch'))
  }
})

test('AC-ELABORATION-34 合法独立登记绑定输入摘要，不造作者职责业务GAP或验证完成声明', async () => {
  const verification = structuredClone(registeredVerification)
  const original = structuredClone(verification)
  const fake = runner(request => {
    verification.command[0] = 'changed-after-freeze'
    return candidate(request, source)
  })
  const result = await elaborate({ ...input(), verifications: [verification] }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.gaps, [])
  assert.equal(result.runtimeVerification, 'not_run')
  assert.equal(result.implementationReady, false)
  assert.match(fake.calls[0].prompt, /verifications.*可信执行器/)
  assert.ok(fake.calls[0].prompt.includes(JSON.stringify(original)))
  assert.match(fake.calls[0].prompt, /不自行启动runner\/oracle/)
  const noRegistration = runner(request => candidate(request, source))
  const other = await elaborate(input(), { runner: noRegistration.run })
  assert.notEqual(result.inputDigest, other.inputDigest)
  assert.equal(other.runtimeVerification, 'not_run')
})

test('AC-ELABORATION-01 生产编排完成解析、矩阵和独立评审，完整绑定仍不宣称运行或同步', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.structurePassed, true)
  assert.equal(result.reviewPassed, true)
  assert.equal(result.runtimeVerification, 'not_run')
  assert.equal(result.implementationReady, false)
  assert.equal(result.coverage!.matrix.length, 30)
  assert.equal(result.contracts[0].rawSource, rawSource)
  assert.deepEqual(result.readyFlowIds, ['FLOW-EXPORT-01', 'FLOW-EXPORT-02'])
  assert.deepEqual(result.blockedFlows, [])
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.notEqual(fake.calls[0].requestKey, fake.calls[1].requestKey)
  assert.notEqual(result.rounds[0].traces[0].sessionId, result.rounds[0].traces[1].sessionId)
  assert.match(fake.calls[1].prompt, /冻结业务输入/)
  assert.match(fake.calls[1].prompt, /候选Markdown与适用性/)
})

test('AC-ELABORATION-02 状态事件缺支先产生具体失败，再按失败修复并重新独立审查', async () => {
  const missing = source.split('\n').filter(line => !/^\| TR-EXPORT-(?:STALE-)?CANCELLED-COMPLETE \|/.test(line)).join('\n')
  const fake = runner((request, call) => candidate(request, call === 1 ? missing : source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.rounds.length, 2)
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'missing-event-disposition'))
  assert.equal(fake.calls[0].purpose, 'elaboration_generate')
  assert.equal(fake.calls[1].purpose, 'elaboration_generate')
  assert.match(fake.calls[1].prompt, /missing-event-disposition/)
})

test('AC-ELABORATION-03 独立评审发现弱化或漏分支后必须修复具体发现', async () => {
  let reviews = 0
  const fake = runner(request => candidate(request, source), request => {
    reviews++
    return reviews === 1 ? { ...review(request), verdict: 'repair', findings: [{ code: 'condition_boundary_missing', kind: 'repair', message: '条件不成立缺少反馈', affectedIds: ['TR-EXPORT-RUNNING-COMPLETE'], evidence: '重走完成路径发现失败出口遗漏', decision: '补齐否定分支' }] } : review(request)
  })
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.rounds.length, 2)
  assert.match(fake.calls[2].prompt, /condition_boundary_missing/)
  assert.equal(reviews, 2)
})

test('AC-ELABORATION-04 未知重试政策仅阻塞依赖，成功主流程可继续', async () => {
  const gapSource = `${source}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-RETRY | missing_fact | 是否允许失败后重试 | RULE-EXPORT-06,TR-EXPORT-FAILED-RETRY,AC-EXPORT-08 | 用户未定义重试政策 | 明确重试权限及attempt身份 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, gapSource), request => ({ ...review(request), verdict: 'needs_input', findings: [{ code: 'retry_policy', kind: 'missing_fact', message: '重试政策未确认', affectedIds: ['RULE-EXPORT-06'], evidence: '原意未定义恢复', decision: '明确重试政策' }] }))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.rounds.length, 1)
  assert.ok(result.blockedIds.includes('FLOW-EXPORT-02'))
  assert.ok(result.readyIds.includes('FLOW-EXPORT-01'))
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'unresolved-gap'))
})

test('AC-ELABORATION-05 未决冲突保留明确证据，不伪装为自动修复失败', async () => {
  const conflicted = `${source}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-CONFLICT | conflict | 下载权限双方互斥 | RULE-EXPORT-01 | 用户要求权限隔离，变更公开下载 | 明确是否允许公开下载 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, conflicted))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'conflict')
  assert.equal(result.gaps[0].evidence, '用户要求权限隔离，变更公开下载')
})

test('AC-ELABORATION-06 越界路径、错误源摘要和raw改写都不能绕过门禁', async () => {
  for (const variant of ['path', 'digest', 'raw']) {
    const fake = runner(request => {
      const output = candidate(request, source)
      if (variant === 'path') output.changes[0].path = '../escape/spec.md'
      if (variant === 'digest') Object.assign(output.changes[0], { beforeDigest: 'stale' })
      if (variant === 'raw') Object.assign(output.changes[0], { rawSource: '模型擅自替换用户目标' })
      return output
    })
    const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted', variant)
    assert.equal(result.reviewPassed, false)
    assert.equal(fake.calls.length, 1)
  }
})

test('AC-ELABORATION-07 删除既有验收或改变验证命令不能自行退出门禁', async () => {
  for (const changed of [source.split('\n').filter(line => !line.startsWith('| AC-EXPORT-03 |')).join('\n'), source.replace('["node","--test","tests/export.test.mjs"]', '["node","--version"]')]) {
    const snapshot = input(true)
    const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
    const result = await elaborate({ ...snapshot, maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.ok(result.rounds[0].findings.some(issue => ['protected_item_removed', 'verification_policy_changed'].includes(issue.code)))
  }
})

test('AC-ELABORATION-08 结构化错误、伪绿评审和重复会话都明确失败且留存产物', async () => {
  const malformed = runner(() => ({ summary: '已完成' }))
  const malformedResult = await elaborate({ ...input(), maxRepairs: 0 }, { runner: malformed.run })
  assert.equal(malformedResult.status, 'exhausted')
  assert.deepEqual(malformedResult.rounds[0].output, { summary: '已完成' })
  const reused = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: async request => ({ ...await reused.run(request), sessionId: 'same-session' }) })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'review_not_independent'))
})

test('AC-ELABORATION-09 新功能未实现不伪造锚点/运行证据，保留实现缺口给P2', async () => {
  const planned = source.replace('code:\n  - src/export.js#ExportService\n', '')
  const fake = runner(request => candidate(request, planned))
  const result = await elaborate({ ...input(), files: new Map() }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.implementationReady, false)
  assert.ok(result.deferredImplementationFindings.some(issue => issue.code === 'missing-implementation'))
  assert.ok(result.deferredImplementationFindings.some(issue => issue.code === 'missing-test-file'))
})

test('AC-ELABORATION-10 未提供的重要政策来源不允许模型假造', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), facts: [], maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'unsupported_policy_source'))
})

test('AC-ELABORATION-11 安全能力不足及执行失败保留真实状态，取消不再派发', async () => {
  for (const code of ['unsupported', 'failed', 'timeout']) {
    const result = await elaborate(input(), { runner: async () => { throw Object.assign(new Error(`真实${code}错误`), { code }) } })
    assert.equal(result.status, code === 'unsupported' ? 'unsupported' : 'failed')
    assert.equal(result.failure!.code, code)
    assert.equal(result.reviewPassed, false)
  }
  const controller = new AbortController()
  controller.abort()
  const result = await elaborate({ ...input(), signal: controller.signal }, { runner: async () => { assert.fail('取消后不能派发') } })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.rounds.length, 0)
  const during = new AbortController()
  const fake = runner(request => { during.abort(); return candidate(request, source) })
  const interrupted = await elaborate({ ...input(), signal: during.signal }, { runner: fake.run })
  assert.equal(interrupted.status, 'cancelled')
  assert.equal(fake.calls.length, 1)
  assert.equal(interrupted.contracts[0].rawSource, rawSource)
})

test('AC-ELABORATION-12 调用中外部继续编辑不改变冻结业务输入', async () => {
  const mutable = input()
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(mutable, { runner: async request => {
    mutable.intent.rawSource = '继续编辑的新意图'
    return fake.run(request)
  } })
  assert.equal(result.status, 'complete')
  assert.ok(fake.calls.every(call => !call.prompt.includes('继续编辑的新意图')))
})

test('AC-ELABORATION-13 用户原意已决定的退役自动处理且输出稳定ID，历史退役ID不可复用', async () => {
  const snapshot = input(true)
  const changedRaw = `${rawSource} 用户移除重复验收 AC-EXPORT-04，保留全部状态处置和逐规则验收。`
  const changed = source.replace(rawSource, changedRaw).split('\n').filter(line => !line.startsWith('| AC-EXPORT-04 |')).join('\n')
  const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
  const result = await elaborate({ ...snapshot, intent: { ...snapshot.intent, rawSource: changedRaw }, authorizedChanges: [{ id: 'AC-EXPORT-04', action: 'retire', source: 'user:raw', reason: '用户取消重复验收条目，其他状态处置保留' }] }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.retiredIds, ['AC-EXPORT-04'])
  assert.match(fake.calls[1].prompt, /authorizedChanges/)
  const reused = runner(request => candidate(request, source))
  const rejected = await elaborate({ ...input(), retiredIds: ['AC-EXPORT-04'], maxRepairs: 0 }, { runner: reused.run })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'retired_id_reused'))
})

test('AC-ELABORATION-14 可信且已决定的验证政策变更须经独立审查，未提供裁决不能伪造授权', async () => {
  const snapshot = input(true)
  const changedRaw = `${rawSource} 验证命令添加 tap 报告格式。`
  const changed = source.replace(rawSource, changedRaw).replace('["node","--test","tests/export.test.mjs"]', '["node","--test","--test-reporter=tap","tests/export.test.mjs"]')
  const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
  const result = await elaborate({ ...snapshot, intent: { ...snapshot.intent, rawSource: changedRaw }, authorizedChanges: [{ id: 'VERIFY-EXPORT-01', action: 'update_verification', source: 'user:raw', reason: '已明确要求tap报告，不删除或弱化用例' }] }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(fake.calls.length, 2)
  await assert.rejects(() => elaborate({ ...snapshot, authorizedChanges: [{ id: 'AC-EXPORT-04', action: 'retire', source: 'decision:FAKE', reason: '模型伪造批准' }] }, { runner: fake.run }), /没有可信来源/)
})

test('AC-ELABORATION-15 raw里的围栏标题完整保留，不误判为正文分界', async () => {
  const raw = `${rawSource}\n\n\`\`\`markdown\n## expanded spec\n示例内容\n\`\`\``
  const fake = runner(request => candidate(request, source.replace(rawSource, raw)))
  const result = await elaborate({ ...input(), intent: { nodeId: 'export-contract', rawSource: raw } }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.contracts[0].rawSource, raw)
})

test('AC-ELABORATION-16 GAP覆盖的未知状态事件对不要求虚构TR，独立成功分支仍经review推进', async () => {
  const removed = new Set(['TR-EXPORT-CANCELLED-COMPLETE', 'TR-EXPORT-STALE-CANCELLED-COMPLETE'])
  const missing = source.split('\n').filter(line => !/^\| TR-EXPORT-(?:STALE-)?CANCELLED-COMPLETE \|/.test(line)).map(line => {
    if (!line.startsWith('| AC-')) return line
    const cells = line.split('|')
    cells[2] = ` ${cells[2].trim().split(',').filter(id => !removed.has(id)).join(',')} `
    return cells.join('|')
  }).join('\n')
  const gapSource = `${missing}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-CANCEL-COMPLETE | missing_fact | 取消终态收到完成回调的政策未知 | STATE-EXPORT-CANCELLED,EVENT-EXPORT-COMPLETE | 原意未定义这对状态事件 | 明确是否拒绝或幂等忽略 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, gapSource))
  const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.reviewPassed, true)
  assert.ok(result.blockedStructureFindings.some(issue => issue.code === 'missing-event-disposition'))
  assert.ok(result.readyIds.includes('FLOW-EXPORT-01'))
  assert.equal(fake.calls.length, 2)
  const dangling = runner(request => candidate(request, gapSource.replace('| STEP-EXPORT-01 | FLOW-EXPORT-01 |', '| STEP-EXPORT-01 | FLOW-NONEXISTENT-01 |')))
  const rejected = await elaborate({ ...input(), maxRepairs: 0 }, { runner: dangling.run })
  assert.equal(rejected.status, 'exhausted')
  assert.equal(rejected.reviewPassed, false)
})

test('AC-ELABORATION-17 调用预算和总时间预算真实截止，保留生成产物并停止后续review', async () => {
  const one = runner(request => candidate(request, source))
  const calls = await elaborate({ ...input(), maxCalls: 1 }, { runner: one.run })
  assert.equal(calls.status, 'exhausted')
  assert.equal(calls.failure!.code, 'budget_exhausted')
  assert.equal(one.calls.length, 1)
  assert.equal(calls.contracts[0].rawSource, rawSource)
  const slow = runner(request => candidate(request, source))
  const expired = await elaborate({ ...input(), timeoutMs: 10000, totalTimeoutMs: 10 }, { runner: async request => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return slow.run(request)
  } })
  assert.equal(expired.status, 'exhausted')
  assert.equal(expired.failure!.code, 'budget_exhausted')
  assert.equal(slow.calls.length, 1)
  assert.equal(slow.calls[0].timeoutMs, 10000)
})

test('AC-ELABORATION-18 真实错列问题由业务行协议和程序固定分隔行解决', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.ok(result.changes[0].source.includes('### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |'))
  assert.ok(result.changes[0].source.includes('### FLOW\n\n| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |'))
  assert.match(fake.calls[0].prompt, /不填写Markdown\/表头\/分隔行\/raw\/digest/)
  assert.ok(!fake.calls[0].prompt.includes('输出inputDigest='))
})

test('AC-ELABORATION-19 未提供真实文件时不能新造code锚点充实现覆盖', async () => {
  const fake = runner(request => candidate(request, source))
  const rejected = await elaborate({ ...input(), files: undefined, maxRepairs: 0 }, { runner: fake.run })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'unverified_new_code_anchor'))
})

test('AC-ELABORATION-20 固定调用身份不包含剩余预算，重放相同输入和阶段仍幂等', async () => {
  const now = Date.now
  let elapsed = 0
  Date.now = () => now() + elapsed
  try {
    const snapshot = { ...input(), timeoutMs: 10000, totalTimeoutMs: 1000 }
    const first = runner(request => candidate(request, source))
    const second = runner(request => candidate(request, source))
    const execute = async (fake: ReturnType<typeof runner>, delta: number) => elaborate(snapshot, { runner: async request => {
      elapsed += delta
      return fake.run(request)
    } })
    assert.equal((await execute(first, 100)).status, 'complete')
    assert.equal((await execute(second, 200)).status, 'complete')
    assert.deepEqual(first.calls.map(({ signal: _signal, ...identity }) => identity), second.calls.map(({ signal: _signal, ...identity }) => identity))
    assert.ok(first.calls.every(call => call.timeoutMs === 10000))
  } finally { Date.now = now }
})

test('AC-ELABORATION-21 行schema在模型边界拒绝拼接来源、错误引用/布尔/argv', () => {
  const request = { purpose: 'elaboration_generate', prompt: `冻结业务输入:\n${JSON.stringify({ targets: input().targets })}\n` } as ElaborationSessionRequest
  assert.deepEqual(outputErrors(adaptElaborationNativeOutput(request, candidate(request, source)), ELABORATION_SCHEMA), [])
  for (const edit of [
    (rows: GeneratedTables) => { rows.RULE[0].source = 'decision:EXPORT-POLICY,user:raw' },
    (rows: GeneratedTables) => { rows.STATE[0].initial = 'true' },
    (rows: GeneratedTables) => { rows.FLOW[0].req = ['不是稳定ID'] },
    (rows: GeneratedTables) => { delete rows.TR[0].to },
    (rows: GeneratedTables) => { rows.TR[0].to = '' },
    (rows: GeneratedTables) => { rows.TR[0].to = '-' },
    (rows: GeneratedTables) => { rows.VERIFY[0].command = '["node"]' },
    (rows: GeneratedTables) => { rows.VERIFY[0].command = ['node', '非法\n参数'] },
    (rows: GeneratedTables) => { rows.VERIFY[0]['timeout-ms'] = 0 },
  ]) {
    const output = candidate(request, source)
    edit(output.changes[0].tables)
    const errors = outputErrors(adaptElaborationNativeOutput(request, output), ELABORATION_SCHEMA)
    assert.ok(errors.some(error => error.startsWith('$.changes[0].tables.')), JSON.stringify(errors))
  }
  const nullable = candidate(request, source)
  nullable.changes[0].tables.TR[0].to = null
  nullable.changes[0].tables.TR[0].disposition = 'not_applicable'
  const wireNullable = adaptElaborationNativeOutput(request, nullable) as GeneratedTargetElaboration
  assert.deepEqual(outputErrors(wireNullable, ELABORATION_SCHEMA), [])
  const snapshot = input(true)
  const rendered = renderElaboration(snapshot, bindElaborationTargets(snapshot, wireNullable), 'nullable-json-input')
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered.changes[0].source })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.items.find(item => item.kind === 'TR')!.to, null)
})

test('AC-ELABORATION-22 程序复制原文和绑定，保留元数据，正确渲染转义及argv', () => {
  const snapshot = input(true)
  snapshot.targets[0].source = source.replace('status: active', 'status: active\nhue: 175')
  snapshot.targets[0].sourceDigest = elaborationDigest(snapshot.targets[0].source!)
  const output = candidate({ purpose: 'elaboration_generate' } as ElaborationSessionRequest, source)
  output.changes[0].tables.REQ[0].goal = '管道 | 路径 \\ 和换行\n下一行'
  output.changes[0].tables.VERIFY[0].command = ['node', '--test', 'tests/export.test.mjs', '`含|参数`', '路径\\参数']
  const rendered = renderElaboration(snapshot, output, 'program-bound-input')
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered.changes[0].source })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.rawSource, snapshot.intent.rawSource)
  assert.equal(rendered.inputDigest, 'program-bound-input')
  assert.equal(rendered.changes[0].beforeDigest, snapshot.targets[0].sourceDigest)
  assert.equal(parseFrontmatter(rendered.changes[0].source).fm.hue, parseFrontmatter(snapshot.targets[0].source!).fm.hue)
  assert.equal(parsed.contract!.items.find(item => item.kind === 'REQ')!.goal, '管道 | 路径 \\ 和换行<br>下一行')
  assert.deepEqual(parsed.contract!.items.find(item => item.kind === 'VERIFY')!.command, output.changes[0].tables.VERIFY[0].command)
  assert.ok(!rendered.changes[0].source.includes('### GAP'))
})

test('AC-ELABORATION-45 独审取得同一候选解析业务值，转义不增改字符且不重复只读上下文', async () => {
  const goal = '正则 `^\\d{1,4}(?:\\.\\d{1,2})?$`，管道 a|b，路径 C:\\temp，``双反引号``。'
  const snapshot = input()
  snapshot.intent.rawSource = goal
  snapshot.validationScope = 'partition_local'
  const contextPath = '.spec/export/review-context/spec.md'
  const contextSource = '---\ntitle: 只读接口\ncontract-schema: sync-v1\n---\n## raw source\n\n只读需求。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-CONTEXT-01 | 只读需求 | user:raw | 原义务 | 保留 | - |\n'
  snapshot.context = [{ nodeId: 'review-context', path: contextPath, source: contextSource }]
  const fake = runner(request => {
    const output = candidate(request, source)
    output.changes[0].tables.REQ[0].goal = goal
    return output
  })
  const result = await elaborate(snapshot, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds[0].findings))
  assert.ok(result.contracts.some(contract => contract.nodeId === 'review-context'))
  const prompt = fake.calls[1].prompt
  const marker = '\n程序解析的候选业务行:\n'
  assert.ok(prompt.includes(marker), '独审只有序列化Markdown，缺少可直接还原业务值的解析视图')
  const rows = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length))
  const contract = parseContract({ nodeId: 'export-contract', path, source: result.changes[0].source }).contract!
  assert.deepEqual(rows, contract.items.filter(item => item.kind !== 'VERIFY'))
  assert.equal(contract.rawSource, goal)
  const requirement = rows.find(row => row.id === 'REQ-EXPORT-01')
  assert.ok(requirement?.kind === 'REQ')
  assert.equal(requirement.goal, goal)
  assert.ok(rows.every((row: { nodeId: string; path: string }) => row.nodeId === 'export-contract' && row.path === path))
  assert.ok(!rows.some((row: { id: string }) => row.id === 'REQ-CONTEXT-01'))
  assert.ok(prompt.includes(JSON.stringify(result.rounds[0].candidate)), '完整Markdown仍交给独审')
  assert.ok(prompt.includes(JSON.stringify(snapshot.intent)), '原始意图仍交给独审')
})

test('AC-ELABORATION-46 引用说明和解析视图不豁免错误rules类型、悬空VERIFY或无REQ追溯', async () => {
  const variants: { code: string; edit: (tables: GeneratedTables) => void }[] = [
    { code: 'reference-kind', edit: tables => { tables.STEP[0].rules = ['REQ-EXPORT-01'] } },
    { code: 'dangling-reference', edit: tables => { tables.VERIFY = [] } },
    { code: 'untraceable_intent', edit: tables => { tables.RULE[0].source = 'user:raw'; tables.RULE[0]['depends-on'] = [] } },
  ]
  for (const { code, edit } of variants) {
    const fake = runner(request => {
      const output = candidate(request, source)
      edit(output.changes[0].tables)
      return output
    })
    const result = await elaborate({ ...input(), verifications: [registeredVerification], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted', code)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === code), JSON.stringify(result.rounds[0].findings))
    assert.equal(result.reviewPassed, false)
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})

test('AC-ELABORATION-23 总预算耗尽但原生停止未证实时保留pending身份，不派后续会话', async () => {
  let calls = 0
  const result = await elaborate({ ...input(), totalTimeoutMs: 10 }, { runner: async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 20))
    throw Object.assign(new Error('原生interrupt尚未证实停稳'), { code: 'cancellation_pending', sessionId: 'pending-session', threadId: 'pending-thread', turnId: 'pending-turn' })
  } })
  assert.equal(result.status, 'failed')
  assert.equal(result.failure!.code, 'cancellation_pending')
  assert.equal(result.failure!.sessionId, 'pending-session')
  assert.equal(result.failure!.threadId, 'pending-thread')
  assert.equal(result.failure!.turnId, 'pending-turn')
  assert.equal(calls, 1)
  assert.equal(result.reviewPassed, false)
})

test('AC-ELABORATION-24 完整业务行生成默认保留900秒调用窗口，上层可明确覆盖', async () => {
  const defaults = runner(request => candidate(request, source))
  assert.equal((await elaborate(input(), { runner: defaults.run })).status, 'complete')
  assert.ok(defaults.calls.every(call => call.timeoutMs === 900000))
  const configured = runner(request => candidate(request, source))
  assert.equal((await elaborate({ ...input(), timeoutMs: 1200000 }, { runner: configured.run })).status, 'complete')
  assert.ok(configured.calls.every(call => call.timeoutMs === 1200000))
})

test('AC-ELABORATION-25 真实GAP候选的父流程聚合阻塞，创建和查看仍独立可推进', () => {
  const actual = readFileSync(new URL('./elaboration-fixtures/todo-gap.spec.md', import.meta.url), 'utf8')
  const parsed = parseContract({ nodeId: 'todo', path: '.spec/todo/spec.md', source: actual })
  assert.deepEqual(parsed.findings, [])
  const graph = buildContractGraph([parsed.contract!])
  const coverage = projectContractCoverage(graph)
  // core 的导航边不污染声明依赖；这里复现真实结果中父 FLOW 仍未直接阻塞的缺口。
  assert.ok(coverage.items.filter(item => item.id === 'FLOW-TODO-COMPLETE' || item.id === 'FLOW-TODO-CANCEL').every(item => item.blockedBy.length === 0))
  const projected = projectElaborationFlowReadiness(graph, coverage)
  assert.deepEqual(projected.readyFlowIds, ['FLOW-TODO-CREATE', 'FLOW-TODO-VIEW'])
  assert.deepEqual(projected.blockedFlows, [
    { flowId: 'FLOW-TODO-CANCEL', blockedStepIds: ['STEP-TODO-CANCEL-DISPATCH'], gapIds: ['GAP-TODO-MUTATION-AUTH'] },
    { flowId: 'FLOW-TODO-COMPLETE', blockedStepIds: ['STEP-TODO-COMPLETE-DISPATCH'], gapIds: ['GAP-TODO-MUTATION-AUTH'] },
  ])
  assert.ok(coverage.items.filter(item => ['STEP-TODO-CREATE-COMMIT', 'STEP-TODO-VIEW-DISPATCH'].includes(item.id)).every(item => item.blockedBy.length === 0))
})

const rejectedSeed = async (goal?: string): Promise<ElaborationRepairSeed> => {
  const fake = runner(request => {
    const output = candidate(request, source)
    if (goal) output.changes[0].tables.REQ[0].goal = goal
    return output
  }, request => ({ ...review(request), verdict: 'repair', findings: [{ code: 'recheck_sources', kind: 'repair', message: '应核实普通错误协议来源', affectedIds: ['RULE-EXPORT-01'], evidence: '错误名可由现存无冲突代码确认', decision: '不能为普通实现细节制造GAP' }] }))
  const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
  const last = result.rounds[0]
  assert.equal(result.status, 'exhausted')
  return { settled: true, requestKey: 'operation-1', inputDigest: result.inputDigest, candidateDigest: last.candidateDigest!, output: last.output, candidate: last.candidate!, findings: last.findings, review: last.review, traces: last.traces }
}

test('部分wire候选结算为诊断seed后，本次必需目标重列且完整新输出不继承seed行', async () => {
  const base = input(true)
  const newTargetPath = '.spec/export/new-target/spec.md'
  const rawOnlyPath = '.spec/export/raw-only-target/spec.md'
  const legacyPath = '.spec/export/legacy-target/spec.md'
  const rawOnlyRaw = 'raw-only 目标的冻结原意。'
  const rawOnlySource = `---\ntitle: Raw-only target\nstatus: active\n---\n\n## raw source\n\n${rawOnlyRaw}\n`
  const legacySource = '---\ntitle: Legacy target\nstatus: active\n---\n\n# Historical note\nThis source predates sync-v1.\n'
  const snapshot: ElaborationInput = {
    ...base,
    targets: [
      base.targets[0],
      { nodeId: 'new-target', path: newTargetPath, source: null, sourceDigest: null, rawSource: '新增叶子目标的冻结原意。' },
      { nodeId: 'raw-only-target', path: rawOnlyPath, source: rawOnlySource, sourceDigest: elaborationDigest(rawOnlySource), rawSource: rawOnlyRaw },
      { nodeId: 'legacy-target', path: legacyPath, source: legacySource, sourceDigest: elaborationDigest(legacySource), rawSource: '旧版且尚未启用sync-v1的目标原意。' },
    ],
    maxRepairs: 0,
  }
  const output = (indices: number[], verifyIds: Record<number, string>): GeneratedTargetElaboration => ({
    version: 'elaboration-target-rows-v3',
    changes: indices.map(targetIndex => {
      const tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
      tables.VERIFY = [{ id: verifyIds[targetIndex], command: ['node', '--version'], cwd: '.', 'timeout-ms': 1000 }]
      return { targetIndex, title: `Target ${targetIndex}`, description: '', code: [], related: [], prose: '按冻结输入登记本叶目标。', removeIds: [], tables }
    }),
    applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '本次冻结目标只登记独立验证入口。', affectedIds: [] })),
  })

  const partialNative = runner(() => output([1], { 1: 'VERIFY-SEED-ONLY' }))
  const partial = await elaborate(snapshot, { runner: partialNative.run })
  assert.equal(partial.status, 'exhausted')
  assert.ok(partial.rounds[0].candidate)
  assert.equal(partial.reviewPassed, false)
  assert.equal(partial.rounds[0].reviewOutput, null)
  assert.deepEqual(partial.rounds[0].findings.filter(issue => issue.code === 'target_not_elaborated').map(issue => issue.message), [
    '新目标或raw-only目标必须显式完成细化: .spec/export/raw-only-target/spec.md',
    `新目标或raw-only目标必须显式完成细化: ${legacyPath}`,
  ])
  assert.ok(!partial.rounds[0].findings.some(issue => issue.code === 'output_schema'))
  assert.match(partialNative.calls[0].prompt, /必须显式构建\s*3\s*个目标/)
  assert.match(partialNative.calls[0].prompt, /原始 targetIndex：\[1,2,3\]/)
  assert.match(partialNative.calls[0].prompt, /完整、可解析的紧凑JSON对象/)
  assert.deepEqual((partialNative.calls[0].schema.properties as Record<string, { minItems?: number }>).changes.minItems, 0)
  assert.deepEqual((partial.rounds[0].output as GeneratedTargetElaboration).changes.map(change => change.targetIndex), [1])

  const rejected = partial.rounds[0]
  const seed: ElaborationRepairSeed = {
    settled: true,
    requestKey: 'operation-1',
    inputDigest: partial.inputDigest,
    candidateDigest: rejected.candidateDigest!,
    output: rejected.output,
    candidate: rejected.candidate!,
    findings: rejected.findings,
    review: rejected.review,
    traces: rejected.traces,
  }
  const originalSeed = structuredClone(seed)
  const freshNative = runner(() => output([1, 2, 3], { 1: 'VERIFY-NEW-FRESH', 2: 'VERIFY-RAW-ONLY', 3: 'VERIFY-LEGACY-01' }))
  const fresh = await elaborate({ ...snapshot, requestKey: 'operation-2' }, { seed, runner: async request => {
    const session = await freshNative.run(request)
    return { ...session, sessionId: `fresh-${session.sessionId}`, threadId: `fresh-${session.threadId}`, turnId: `fresh-${session.turnId}` }
  } })

  assert.equal(fresh.status, 'complete', JSON.stringify(fresh.rounds[0].findings))
  assert.equal(fresh.structurePassed, true)
  assert.equal(fresh.reviewPassed, true)
  assert.deepEqual(freshNative.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal(fresh.inputDigest, partial.inputDigest)
  assert.notEqual(partialNative.calls[0].inputDigest, freshNative.calls[0].inputDigest)
  for (const trace of fresh.rounds[0].traces) {
    assert.ok(seed.traces.every(previous => trace.sessionId !== previous.sessionId && trace.threadId !== previous.threadId && trace.turnId !== previous.turnId))
  }
  assert.deepEqual((fresh.rounds[0].output as GeneratedTargetElaboration).changes.map(change => change.targetIndex), [1, 2, 3])
  assert.equal(fresh.changes.length, 4)
  assert.deepEqual(new Set(fresh.changes.map(change => change.path)), new Set([
    path,
    newTargetPath,
    rawOnlyPath,
    legacyPath,
  ]))
  assert.ok(!fresh.changes.some(change => change.source.includes('VERIFY-SEED-ONLY')))
  assert.ok(fresh.graph && !fresh.graph.items.has('VERIFY-SEED-ONLY'))
  assert.deepEqual(seed, originalSeed)
})

for (const mode of ['review', 'nullable'] as const) test(`跨attempt续修原JSON ${mode} 保留null与数组而Markdown仅作渲染对照`, async () => {
  let seed: ElaborationRepairSeed
  if (mode === 'review') seed = await rejectedSeed()
  else {
    const rejected = runner(request => {
      const output = candidate(request, source)
      output.changes[0].tables.TR[0].to = null
      output.changes[0].tables.TR[0].disposition = 'not_applicable'
      return output
    }, request => ({ ...review(request), verdict: 'repair', findings: [{ code: 'nullable-source-check', kind: 'repair', message: '按原意核对不适用分支', affectedIds: ['RULE-EXPORT-01'], evidence: '完整原始需求与状态派发', decision: '保留JSON真实类型并修正确有问题的分支' }] }))
    const first = await elaborate({ ...input(), maxRepairs: 0 }, { runner: rejected.run })
    assert.equal(first.status, 'exhausted')
    const last = first.rounds[0]
    seed = { settled: true, requestKey: 'operation-1', inputDigest: first.inputDigest, candidateDigest: last.candidateDigest!, output: last.output, candidate: last.candidate!, findings: last.findings, review: last.review, traces: last.traces }
  }
  const original = structuredClone(seed), fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), requestKey: 'json-repair-attempt' }, { seed, runner: async request => {
    if (process.env.SPEX_REPAIR_JSON_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_REPAIR_JSON_EVIDENCE_DIR, `${mode}-${request.purpose}.prompt.txt`), request.prompt)
    const session = await fresh.run(request)
    return { ...session, sessionId: `fresh-${session.sessionId}`, threadId: `fresh-${session.threadId}` }
  } })
  assert.equal(result.status, 'complete')
  const prompt = fresh.calls[0].prompt
  assert.ok(prompt.includes(JSON.stringify(seed.output)), '跨attempt提示缺少已validateRepairSeed核真的原始结构化JSON')
  const raw = JSON.parse(prompt.split('原始结构化拒绝输出JSON（仅格式骨架/诊断，以当前schema为准，非事实或授权）:\n')[1].split('\n')[0]) as GeneratedTargetElaboration
  assert.deepEqual(raw, seed.output)
  assert.ok(raw.changes[0].tables.FLOW.some(row => Array.isArray(row.terminal)))
  assert.ok(raw.changes[0].tables.STEP.some(row => Array.isArray(row.next)))
  if (mode === 'nullable') assert.equal(raw.changes[0].tables.TR[0].to, null)
  assert.match(prompt, /Markdown渲染视图.*不能将表格占位符复制到JSON/)
  assert.match(prompt, /原具体失败/); assert.match(prompt, /当前程序结构诊断/)
  assert.ok(prompt.includes(JSON.stringify(seed.review)))
  assert.deepEqual(seed, original); assert.deepEqual(result.prior!.traces, original.traces)
  assert.deepEqual(fresh.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('AC-ELABORATION-26 已结算失败种子仅作诊断，旧结果不变，新执行重新独立审查', async () => {
  const seed = await rejectedSeed()
  const original = structuredClone(seed)
  const fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), requestKey: 'operation-2' }, { seed, runner: async request => {
    const session = await fresh.run(request)
    return { ...session, sessionId: `new-${session.sessionId}`, threadId: `new-${session.threadId}` }
  } })
  assert.equal(result.status, 'complete')
  assert.equal(result.inputDigest, seed.inputDigest)
  assert.equal(result.rounds.length, 1)
  assert.deepEqual(seed, original)
  assert.deepEqual(result.prior!.traces, original.traces)
  assert.notEqual(result.rounds[0].traces[0].sessionId, original.traces[0].sessionId)
  assert.match(fresh.calls[0].prompt, /绝非用户原意或权威事实/)
  assert.match(fresh.calls[0].prompt, /可观察本身不等于重大业务政策/)
  assert.ok(fresh.calls.every(call => call.requestKey.startsWith('operation-2:')))
})

test('v3失败seed中的错误RULE.authority仍进入候选诊断和新的受限生成', async () => {
  const seed = await rejectedSeed(), snapshot = input()
  const previous = candidate({} as ElaborationSessionRequest, source)
  previous.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-01')!.authority = 'REQ-EXPORT-01'
  const output: GeneratedTargetElaboration = {
    version: 'elaboration-target-rows-v3',
    changes: [{
      targetIndex: 0, title: previous.changes[0].title, description: previous.changes[0].description,
      code: previous.changes[0].code, related: previous.changes[0].related, prose: previous.changes[0].prose,
      removeIds: previous.changes[0].removeIds, tables: previous.changes[0].tables,
    }],
    applicability: previous.applicability,
  }
  seed.output = output
  seed.candidate = renderElaboration(snapshot, bindElaborationTargets(snapshot, output), seed.inputDigest)
  seed.candidateDigest = elaborationDigest(JSON.stringify(seed.candidate))
  seed.findings = [{ code: 'rule-authority', severity: 'error', nodeId: 'export-contract', path, itemId: 'RULE-EXPORT-01', message: 'RULE-EXPORT-01 权威定义必须归属当前节点 export-contract' }]
  seed.review = null
  seed.traces = seed.traces.filter(trace => trace.purpose === 'elaboration_generate')
  seed.traces[0].resultDigest = elaborationDigest(JSON.stringify(output))
  const original = structuredClone(seed)

  const fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...snapshot, requestKey: 'operation-2' }, { seed, runner: fresh.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds.flatMap(round => round.findings)))
  assert.ok(fresh.calls[0].prompt.includes('rule-authority'))
  assert.ok(fresh.calls[0].prompt.includes('权威定义必须归属当前节点 export-contract'))
  assert.deepEqual(fresh.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.deepEqual(seed, original)

  const rejectInvalidDiagnosticSeed = async (invalidSeed: ElaborationRepairSeed): Promise<void> => {
    invalidSeed.traces[0].resultDigest = elaborationDigest(JSON.stringify(invalidSeed.output))
    const invalidRunner = runner(() => assert.fail('结构无效的诊断seed不得调用Native'))
    await assert.rejects(() => elaborate({ ...snapshot, requestKey: 'operation-3' }, { seed: invalidSeed, runner: invalidRunner.run }), /续修种子不符合业务行诊断schema/)
    assert.deepEqual(invalidRunner.calls, [])
  }
  const invalidIndex = structuredClone(original)
  const invalidIndexOutput = invalidIndex.output as GeneratedTargetElaboration
  invalidIndexOutput.changes[0].targetIndex = 1
  await rejectInvalidDiagnosticSeed(invalidIndex)
  const invalidType = structuredClone(original)
  const invalidTypeOutput = invalidType.output as unknown as { changes: Record<string, unknown>[] }
  invalidTypeOutput.changes[0].code = '不是数组'
  await rejectInvalidDiagnosticSeed(invalidType)
  const invalidIdentity = structuredClone(original)
  const invalidIdentityOutput = invalidIdentity.output as unknown as { changes: Record<string, unknown>[] }
  invalidIdentityOutput.changes[0].path = path
  await rejectInvalidDiagnosticSeed(invalidIdentity)
})

test('AC-ELABORATION-27 输入改变、未结算、摘要/评审身份伪造不能恢复种子', async () => {
  const original = await rejectedSeed()
  const edits = [
    (seed: ElaborationRepairSeed) => { seed.candidateDigest = 'forged' },
    (seed: ElaborationRepairSeed) => { seed.traces[0].resultDigest = 'forged' },
    (seed: ElaborationRepairSeed) => { seed.review!.inputDigest = 'forged' },
    (seed: ElaborationRepairSeed) => { seed.review!.candidateDigest = 'forged' },
    (seed: ElaborationRepairSeed) => { seed.review!.findings[0].evidence = '篡改原生评审' },
    (seed: ElaborationRepairSeed) => { Object.assign(seed, { settled: false }) },
    (seed: ElaborationRepairSeed) => { (seed.output as GeneratedElaboration).changes[0].tables.VERIFY[0].command = ['node', '非法\n参数'] },
  ]
  for (const edit of edits) {
    const seed = structuredClone(original); edit(seed)
    await assert.rejects(() => elaborate({ ...input(), requestKey: 'operation-2' }, { seed, runner: async () => assert.fail('无效种子不得派发') }), TypeError)
  }
  await assert.rejects(() => elaborate({ ...input(), requestKey: 'operation-2', facts: [...input().facts!, { source: 'decision:NEW', text: '改过事实' }] }, { seed: original }), /输入一致/)
  await assert.rejects(() => elaborate({ ...input(), requestKey: 'operation-2', intent: { ...input().intent, rawSource: '用户已改原意' } }, { seed: original }), /输入一致/)
  await assert.rejects(() => elaborate(input(), { seed: original }), /新的请求键/)
})

test('AC-ELABORATION-28 新评审复用种子线程不能继承过去上下文或伪装独立', async () => {
  const seed = await rejectedSeed()
  const fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), requestKey: 'operation-2', maxRepairs: 0 }, { seed, runner: async request => {
    const session = await fresh.run(request)
    return request.purpose === 'elaboration_review' ? { ...session, sessionId: seed.traces[1].sessionId, threadId: seed.traces[1].threadId } : { ...session, sessionId: 'new-builder', threadId: 'new-builder-thread' }
  } })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'review_not_independent'))
  assert.deepEqual(result.readyFlowIds, [])
})

test('AC-ELABORATION-29 渲染版本改变时保留原摘要，新Markdown必须新独立审查', async () => {
  const goal = '导出`筛选`数据'
  const seed = await rejectedSeed(goal)
  seed.candidate.changes[0].source = seed.candidate.changes[0].source.replace(/\\`/g, '`')
  seed.candidateDigest = elaborationDigest(JSON.stringify(seed.candidate))
  seed.review!.candidateDigest = seed.candidateDigest
  const original = structuredClone(seed)
  const fresh = runner(request => { const output = candidate(request, source); output.changes[0].tables.REQ[0].goal = goal; return output })
  const result = await elaborate({ ...input(), requestKey: 'operation-2' }, { seed, runner: async request => {
    const session = await fresh.run(request)
    return { ...session, sessionId: `new-${session.sessionId}`, threadId: `new-${session.threadId}` }
  } })
  assert.equal(result.status, 'complete')
  assert.equal(result.prior!.candidateDigest, original.candidateDigest)
  assert.notEqual(result.prior!.renderedCandidateDigest, original.candidateDigest)
  assert.equal(result.rounds[0].review!.candidateDigest, result.candidateDigest)
  assert.equal(fresh.calls.filter(call => call.purpose === 'elaboration_review').length, 1)
  assert.deepEqual(seed, original)
})


test('AC-ELABORATION-30 真实派发STEP的next→TR传递精确GAP，纯导航和独立流程不受父阻塞影响', () => {
  const actual = readFileSync(new URL('./elaboration-fixtures/todo-gap.spec.md', import.meta.url), 'utf8')
  const parsed = parseContract({ nodeId: 'todo', path: '.spec/todo/spec.md', source: actual })
  assert.deepEqual(parsed.findings, [])
  const gap = parsed.contract!.items.find(item => item.kind === 'GAP')!
  assert.equal(gap.kind, 'GAP')
  gap.affects = gap.affects.filter(id => id.startsWith('TR-'))
  const graph = buildContractGraph([parsed.contract!])
  const coverage = projectContractCoverage(graph)
  const projected = projectElaborationFlowReadiness(graph, coverage)
  assert.deepEqual(projected.readyFlowIds, ['FLOW-TODO-CREATE', 'FLOW-TODO-VIEW'])
  assert.deepEqual(projected.blockedFlows, [
    { flowId: 'FLOW-TODO-CANCEL', blockedStepIds: ['STEP-TODO-CANCEL-DISPATCH'], gapIds: ['GAP-TODO-MUTATION-AUTH'] },
    { flowId: 'FLOW-TODO-COMPLETE', blockedStepIds: ['STEP-TODO-COMPLETE-DISPATCH'], gapIds: ['GAP-TODO-MUTATION-AUTH'] },
  ])
  for (const id of ['STEP-TODO-CREATE-COMMIT', 'STEP-TODO-VIEW-DISPATCH', 'STEP-TODO-COMPLETE-RESOLVE', 'STEP-TODO-CANCEL-RESOLVE', 'STEP-TODO-COMPLETE-FAIL', 'STEP-TODO-CANCEL-FAIL']) {
    assert.deepEqual(coverage.items.find(item => item.id === id)!.blockedBy, [])
  }
  assert.ok(coverage.items.filter(item => item.id === 'FLOW-TODO-COMPLETE' || item.id === 'FLOW-TODO-CANCEL').every(item => item.blockedBy.length === 0))
})


test('AC-ELABORATION-31 旧拒绝种子的新结构缺口须反馈本轮构建，原发现和追踪保持不变', async () => {
  const seed = await rejectedSeed()
  const output = seed.output as GeneratedElaboration
  const dependencies = output.changes[0].tables.STEP[0]['depends-on']
  assert.ok(Array.isArray(dependencies))
  dependencies.push('EVENT-EXPORT-COMPLETE')
  seed.candidate = renderElaboration(input(), output, seed.inputDigest)
  seed.candidateDigest = elaborationDigest(JSON.stringify(seed.candidate))
  seed.traces[0].resultDigest = elaborationDigest(JSON.stringify(output))
  seed.review!.candidateDigest = seed.candidateDigest
  const original = structuredClone(seed)
  const fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), requestKey: 'operation-current-check' }, { seed, runner: fresh.run })
  assert.equal(result.status, 'complete')
  assert.match(fresh.calls[0].prompt, /当前程序结构诊断/)
  assert.match(fresh.calls[0].prompt, /step-event-disposition-missing/)
  assert.ok(!seed.findings.some(issue => issue.code === 'step-event-disposition-missing'))
  assert.deepEqual(seed, original)
  assert.deepEqual(result.prior!.traces, original.traces)
})

test('AC-ELABORATION-35 v2小增量独审收到完整Markdown，保留旧义务与输入事实', async () => {
  const output = candidate({} as ElaborationSessionRequest, source)
  const fullBytes = JSON.stringify(output).length
  output.changes[0].prose = null
  output.changes[0].tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
  output.changes[0].tables.RULE.push({ id: 'RULE-EXPORT-DELTA', scope: '导出', constraint: '保持明确旧政策', basis: '冻结业务事实', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] })
  output.changes[0].tables.AC.push({ ...candidate({} as ElaborationSessionRequest, source).changes[0].tables.AC[0], id: 'AC-EXPORT-DELTA', covers: ['RULE-EXPORT-DELTA'], source: 'rule:RULE-EXPORT-DELTA', 'depends-on': ['RULE-EXPORT-DELTA'], test: 'tests/export.test.mjs#AC-EXPORT-DELTA' })
  const fake = runner(() => output)
  const result = await elaborate({ ...input(true), maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.ok(JSON.stringify(output).length < fullBytes / 5)
  assert.equal(Object.values(output.changes[0].tables).flat().length, 2)
  assert.equal(result.contracts[0].items.length, parseContract({ nodeId: 'export-contract', path, source }).contract!.items.length + 2)
  for (const item of parseContract({ nodeId: 'export-contract', path, source }).contract!.items) assert.ok(fake.calls[1].prompt.includes(item.id), item.id)
  const parsedRows = JSON.parse(fake.calls[1].prompt.split('\n程序解析的候选业务行:\n')[1])
  assert.deepEqual(parsedRows, result.contracts[0].items.filter(item => item.kind !== 'VERIFY'))
  assert.ok(fake.calls[1].prompt.includes(JSON.stringify(result.rounds[0].candidate)))
  assert.ok(fake.calls[0].prompt.includes(JSON.stringify(input(true).facts)))
  assert.deepEqual((fake.calls[0].schema.properties as Record<string, { enum?: string[] }>).version.enum, ['elaboration-target-rows-v3'])
})

test('AC-ELABORATION-36 旧v1失败seed仅按原摘要读诊断，新v1输出拒绝且不继承seed新增政策', async () => {
  const seed = await rejectedSeed()
  const output = candidate({} as ElaborationSessionRequest, source)
  output.changes[0].tables.RULE.push({ id: 'RULE-EXPORT-SEED-ONLY', scope: '导出', constraint: '失败候选自行提出的政策', basis: '拒绝候选', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] })
  seed.candidate = renderElaboration(input(), output, seed.inputDigest)
  const legacy = structuredClone(output) as unknown as { version: string; changes: { removeIds?: string[] }[] }
  legacy.version = 'elaboration-rows-v1'
  for (const node of legacy.changes) delete node.removeIds
  seed.output = legacy
  seed.candidateDigest = elaborationDigest(JSON.stringify(seed.candidate))
  seed.traces[0].resultDigest = elaborationDigest(JSON.stringify(seed.output))
  seed.review!.candidateDigest = seed.candidateDigest
  const original = structuredClone(seed)
  const fresh = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), requestKey: 'new-v2' }, { seed, runner: async request => {
    const session = await fresh.run(request)
    return { ...session, sessionId: `v2-${session.sessionId}`, threadId: `v2-${session.threadId}` }
  } })
  assert.equal(result.status, 'complete')
  assert.deepEqual(seed, original)
  assert.equal(result.prior!.candidateDigest, original.candidateDigest)
  assert.equal(result.prior!.renderedCandidateDigest, original.candidateDigest)
  assert.ok(!result.graph!.items.has('RULE-EXPORT-SEED-ONLY'))
  assert.match(fresh.calls[0].prompt, /旧v1\/v2路径回显协议不可用当前目标绑定渲染器重放/)
  const rejected = await elaborate({ ...input(), maxRepairs: 0 }, { runner: runner(() => legacy).run })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'output_schema'))
})

test('AC-ELABORATION-37 修复反馈分类保留P2缺测试与GAP闭包，只要求当前P1阻断', async () => {
  const incompleteFiles = new Map(files)
  incompleteFiles.set('tests/export.test.mjs', '')
  const fake = runner(request => candidate(request, source), request => ({ ...review(request), verdict: 'repair', findings: [{ code: 'business_check', kind: 'repair', message: '核实当前明确主流程', affectedIds: ['REQ-EXPORT-01'], evidence: '冻结原意', decision: '保留政策' }] }))
  const result = await elaborate({ ...input(true), files: incompleteFiles, maxRepairs: 1 }, { runner: fake.run })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.deferredImplementationFindings.some(issue => issue.code === 'missing-test-case'))
  const repair = fake.calls.find(call => call.requestKey.startsWith('operation-1:1:'))!.prompt
  const diagnostics = JSON.parse(repair.split('分类诊断（仅blocking需P1修复；deferredImplementation交P2实现，blockedByGap保留已有未知闭包，不造GAP或挪绑旧测试）:\n')[1].split('\n独立评审:')[0]) as { blocking: { code: string }[]; deferredImplementation: { code: string }[] }
  assert.ok(diagnostics.blocking.some(issue => issue.code === 'business_check'))
  assert.ok(diagnostics.blocking.every(issue => !issue.code.startsWith('missing-test')))
  assert.ok(diagnostics.deferredImplementation.some(issue => issue.code === 'missing-test-case'))
})

test('AC-ELABORATION-38 空changes保留所有既有完整目标并经真实编排独审', async () => {
  const output = candidate({} as ElaborationSessionRequest, source)
  output.changes = []
  const fake = runner(() => output)
  const result = await elaborate({ ...input(true), maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.changes[0].source, source)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.ok(fake.calls[1].prompt.includes(JSON.stringify(result.rounds[0].candidate)))
})

test('AC-ELABORATION-39 只回传child差量仍保留省略primary与其他既有目标', async () => {
  const childPath = '.spec/export/export-count/spec.md', childId = 'export-count', childRaw = '原始业务需求见 [[export-contract]]。'
  const output = candidate({} as ElaborationSessionRequest, source), child = structuredClone(output.changes[0])
  child.nodeId = childId; child.path = childPath; child.title = '计数规则'; child.prose = '保持原始导出业务政策。'
  child.tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
  child.tables.RULE = [{ id: 'RULE-EXPORT-COUNT', scope: '导出计数', constraint: '按原始记录计数', basis: '冻结业务原意', authority: childId, source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] }]
  child.tables.AC = [{ ...output.changes[0].tables.AC[0], id: 'AC-EXPORT-COUNT', covers: ['RULE-EXPORT-COUNT'], source: 'rule:RULE-EXPORT-COUNT', 'depends-on': ['RULE-EXPORT-COUNT'], test: 'tests/export.test.mjs#AC-EXPORT-COUNT' }]
  const freshTarget = { nodeId: childId, path: childPath, source: null, sourceDigest: null, rawSource: childRaw }
  const childSource = renderElaboration({ ...input(true), targets: [...input(true).targets, freshTarget] }, { ...output, changes: [child] }, 'input').changes.find(change => change.nodeId === childId)!.source
  const extraPath = '.spec/export/export-extra/spec.md', extraSource = childSource.replaceAll('export-count', 'export-extra').replaceAll('RULE-EXPORT-COUNT', 'RULE-EXPORT-EXTRA').replaceAll('AC-EXPORT-COUNT', 'AC-EXPORT-EXTRA')
  const snapshot = { ...input(true), targets: [...input(true).targets, { ...freshTarget, source: childSource, sourceDigest: elaborationDigest(childSource) }, { nodeId: 'export-extra', path: extraPath, source: extraSource, sourceDigest: elaborationDigest(extraSource) }], maxRepairs: 0 }
  child.prose = null; child.tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
  child.tables.AC = [{ ...output.changes[0].tables.AC[0], id: 'AC-EXPORT-COUNT-BOUNDARY', covers: ['RULE-EXPORT-COUNT'], source: 'rule:RULE-EXPORT-COUNT', 'depends-on': ['RULE-EXPORT-COUNT'], test: 'tests/export.test.mjs#AC-EXPORT-COUNT-BOUNDARY' }]
  const fake = runner(() => ({ ...output, changes: [child] }))
  const result = await elaborate(snapshot, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.changes.find(change => change.nodeId === 'export-contract')!.source, source)
  assert.equal(result.changes.find(change => change.nodeId === 'export-extra')!.source, extraSource)
  assert.ok(result.graph!.items.has('RULE-EXPORT-COUNT') && result.graph!.items.has('AC-EXPORT-COUNT-BOUNDARY'))
  assert.ok(fake.calls[1].prompt.includes(JSON.stringify(result.rounds[0].candidate)))
})


test('AC-ELABORATION-40 省略新目标或raw-only目标不能假细化，不能进入独审', async () => {
  const output = candidate({} as ElaborationSessionRequest, source)
  output.changes = []
  for (const targetSource of [null, '---\ntitle: 新子能力\n---\n## raw source\n真实待细化原意。\n## expanded spec\n已有业务说明。\n', '---\ntitle: 新子能力\n---\n# 无分段的旧业务说明\n既有未细化正文必须显式处理。\n']) {
    const fake = runner(() => output)
    const target = { nodeId: 'export-child', path: '.spec/export/export-child/spec.md', source: targetSource, sourceDigest: targetSource === null ? null : elaborationDigest(targetSource), rawSource: '真实待细化原意。' }
    const result = await elaborate({ ...input(true), targets: [...input(true).targets, target], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.ok(result.rounds[0].candidate)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === 'target_not_elaborated'))
    assert.ok(!result.rounds[0].findings.some(issue => issue.code === 'output_schema'))
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})

test('rawless旧目标通过真实细化保留旧body与raw缺席，未变context不误报raw_changed', async () => {
  const legacyBody = '# 全树验证\n\n全树验证的完整旧业务说明。\n\n## 校验范围\n\n保留原有目录、执行约束和后置依据。\n'
  const childPath = '.spec/export/full-tree-verification/spec.md', legacy = `---\ntitle: 全树验证\n---\n${legacyBody}`
  const target = { nodeId: 'full-tree-verification', path: childPath, source: legacy, sourceDigest: elaborationDigest(legacy) }
  for (const prose of [null, '补充技术验证说明。']) {
    const output = candidate({} as ElaborationSessionRequest, source)
    const child = { ...output.changes[0], nodeId: target.nodeId, path: childPath, title: '全树验证', code: [], related: [], prose, tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables }
    child.tables.VERIFY = [{ id: 'VERIFY-EXPORT-TREE', command: ['node', '--version'], cwd: '.', 'timeout-ms': 1000 }]
    output.changes = [child]
    const fake = runner(() => output)
    const result = await elaborate({ ...input(true), targets: [...input(true).targets, target], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'complete', JSON.stringify(result.rounds[0].findings))
    const rendered = result.changes.find(change => change.path === childPath)!.source
    assert.ok(rendered.includes(legacyBody))
    assert.equal(parseParts(rendered)!.rawSource, '')
    assert.ok(!rendered.includes(rawSource))
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  }
  const output = candidate({} as ElaborationSessionRequest, source); output.changes = []
  const fake = runner(() => output)
  const result = await elaborate({ ...input(true), context: [target], maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds[0].findings))
  assert.ok(!result.rounds[0].findings.some(issue => issue.code === 'raw_changed'))
  const enabled = legacy.replace('title: 全树验证', 'title: 全树验证\ncontract-schema: sync-v1')
  const unchanged = runner(() => output)
  const preserved = await elaborate({ ...input(true), targets: [...input(true).targets, { ...target, source: enabled, sourceDigest: elaborationDigest(enabled) }], maxRepairs: 0 }, { runner: unchanged.run })
  assert.equal(preserved.status, 'complete', JSON.stringify(preserved.rounds[0].findings))
  assert.equal(preserved.changes.find(change => change.path === childPath)!.source, enabled)
})

test('rawless目标新增user:raw业务行仍被missing-raw-source拒绝，错误scope继续拒绝', async () => {
  const childPath = '.spec/export/full-tree-verification/spec.md', legacy = '---\ntitle: 全树验证\n---\n# 原有全树验证说明\n完整保留。\n'
  const target = { nodeId: 'full-tree-verification', path: childPath, source: legacy, sourceDigest: elaborationDigest(legacy) }
  for (const wrongScope of [false, true]) {
    const output = candidate({} as ElaborationSessionRequest, source)
    const child = { ...output.changes[0], nodeId: target.nodeId, path: wrongScope ? '.spec/export/wrong-scope/spec.md' : childPath, title: '全树验证', code: [], related: [], prose: null, tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables }
    child.tables.REQ = [{ id: 'REQ-EXPORT-RAWLESS', goal: '自造业务需求', source: 'user:raw', constraints: '-', success: '完成', 'depends-on': [] }]
    output.changes = [child]
    const fake = runner(() => output)
    const result = await elaborate({ ...input(true), targets: [...input(true).targets, target], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.ok(result.rounds[0].findings.some(issue => issue.code === (wrongScope ? 'output_schema' : 'missing-raw-source') && (!wrongScope || issue.message.includes('targetIndex'))), JSON.stringify(result.rounds[0].findings))
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})

test('AC-ELABORATION-41 完整业务契约的规范实现独审缺陷交P2，保留位置反例与全部受影响身份', async () => {
  const defects = [
    { code: 'implementation-review', kind: 'repair' as const, message: '测试将请求DTO误当完整任务递归，导致测试自身TypeError', affectedIds: ['AC-EXPORT-03', 'REQ-EXPORT-01'], evidence: 'tests/export.test.mjs#AC-EXPORT-03：符合规定的DTO不含rows，递归copy[0]产生TypeError；业务契约已完整。', decision: '仅修测试对象对应关系，保留raw、REQ、RULE、AC、VERIFY，不新增业务政策或GAP。' },
    { code: 'implementation-review', kind: 'repair' as const, message: '重复调用断言按已污染first的新增字段遍历正确third', affectedIds: ['AC-EXPORT-03'], evidence: 'tests/export.test.mjs:30：mutateResult(first)新增extra后assertDetached(third,first)，正确third无extra却触发断言失败。', decision: '仅修测试引用比较，不改变既有重复调用语义和验收义务。' },
  ]
  const output = candidate({} as ElaborationSessionRequest, source); output.changes = []
  const fake = runner(() => output, request => ({ ...review(request), verdict: 'repair', findings: defects }))
  const result = await elaborate({ ...input(true), maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.structurePassed, true)
  assert.equal(result.reviewPassed, true)
  assert.equal(result.implementationReady, false)
  assert.equal(result.runtimeVerification, 'not_run')
  assert.deepEqual(result.gaps, [])
  assert.equal(result.changes[0].source, source)
  assert.deepEqual(result.rounds[0].review!.findings, defects)
  assert.equal(result.deferredImplementationFindings.length, 2)
  for (const [index, defect] of defects.entries()) {
    const deferred = result.deferredImplementationFindings[index]
    assert.equal(deferred.code, defect.code)
    assert.deepEqual(deferred.relatedIds, defect.affectedIds)
    assert.ok(deferred.message.includes(defect.evidence))
    assert.ok(deferred.message.includes(defect.decision))
  }
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.match(fake.calls[1].prompt, /implementation-review/)
  const last = result.rounds[0]
  const seed: ElaborationRepairSeed = { settled: true, requestKey: 'operation-1', inputDigest: result.inputDigest, candidateDigest: last.candidateDigest!, output: last.output, candidate: last.candidate!, findings: last.findings, review: last.review, traces: last.traces }
  await assert.rejects(elaborate({ ...input(true), requestKey: 'implementation-only-seed' }, { seed, runner: async () => assert.fail('仅待实现发现不得续修业务契约') }), /具体被拒绝发现/)
})

test('AC-ELABORATION-42 实现review缺少冻结治理位置或有效受影响ID时仍具体阻塞', async () => {
  const defect = { code: 'implementation-review', kind: 'repair' as const, message: '测试存在断言形状缺陷', affectedIds: ['AC-EXPORT-03'], evidence: 'tests/export.test.mjs#AC-EXPORT-03：正确结果被断言误判。', decision: '只修测试。' }
  for (const invalid of [
    { ...defect, evidence: 'tests/outside.test.mjs#AC-EXPORT-03：断言有问题。' },
    { ...defect, evidence: 'unrelated/export.test.mjs#AC-EXPORT-03：断言有问题。' },
    { ...defect, evidence: 'tests/export.test.mjs：测试有问题，未提供位置。' },
    { ...defect, affectedIds: ['AC-EXPORT-NOT-FOUND'] },
    { ...defect, affectedIds: [] },
  ]) {
    const fake = runner(request => candidate(request, source), request => ({ ...review(request), verdict: 'repair', findings: [invalid] }))
    const result = await elaborate({ ...input(), files: new Map([...files, ['unrelated/export.test.mjs', 'not governed']]), maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reviewPassed, false)
    assert.equal(result.deferredImplementationFindings.length, 0)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === 'review_implementation_binding'))
    assert.deepEqual(result.rounds[0].review!.findings, [invalid])
  }
})

test('AC-ELABORATION-43 自定义业务repair和遗漏边界继续阻塞，不能因实现发现绕过', async () => {
  for (const code of ['condition_boundary_missing', 'custom-business-repair']) {
    const business = { code, kind: 'repair' as const, message: '完成条件不成立缺少用户反馈', affectedIds: ['TR-EXPORT-RUNNING-COMPLETE'], evidence: '冻结原意要求失败出口，候选遗漏。', decision: '补齐确定业务分支。' }
    const implementation = { code: 'implementation-review', kind: 'repair' as const, message: '已确定契约下测试有错误', affectedIds: ['AC-EXPORT-03'], evidence: 'tests/export.test.mjs#AC-EXPORT-03：正确结果被断言误判。', decision: '只修测试。' }
    const fake = runner(request => candidate(request, source), request => ({ ...review(request), verdict: 'repair', findings: [implementation, business] }))
    const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.equal(result.reviewPassed, false)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === code && issue.severity === 'error'))
    assert.equal(result.deferredImplementationFindings[0].code, 'implementation-review')
    assert.deepEqual(result.rounds[0].review!.findings, [implementation, business])
  }
})

test('AC-ELABORATION-44 当前裁决REQ来源指令同入生成与独审，受控候选仍受原授权门禁', async () => {
  const sha = elaborationDigest('captured decision provenance'), decisionSource = `decision:${sha}`
  const authority: SyncDecisionAuthority = { stableDecisionId: sha, requestRef: { sha256: sha }, analysisRef: { sha256: sha }, operationId: 'parent-operation', inputId: 'frozen-input', findingIds: ['selected-download'], ruleIds: ['RULE-EXPORT-01'], affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'], paths: ['src/export.js'], decision: { choice: 'new_rule', rule: '成功结果下载必须包含全部匹配记录，不以摘要代替；其他政策保持。' } }
  const analysis: CodeBehaviorEvidence = { ref: { sha256: sha }, analysis: { version: 'code-behavior-v1', inputId: authority.inputId, baselinePairId: 'baseline', composedDigest: sha, readSetDigest: sha, policyDigest: sha, inputDigest: sha, decisionAuthorities: [authority], decision: { requestRef: authority.requestRef, analysisRef: authority.analysisRef, findingIds: authority.findingIds }, authorChanges: [], rawIntegrations: [], changes: [{ id: 'selected-change', kind: 'allowed_change', paths: authority.paths, affectedIds: authority.affectedIds, ruleIds: authority.ruleIds, originalIntent: '下载完整结果', previousBehavior: '返回记录', sourceBehavior: '明确完整结果范围', deliveryBehavior: '保留其他权限和状态限制', evidence: '所选当前裁决明确完整结果下载，未选义务保持', counterexample: '摘要不能替代完整匹配记录' }], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: ['code_behavior_analyze', 'code_behavior_review'].map((purpose, index) => ({ purpose, sessionId: `analysis-${index}`, threadId: `analysis-thread-${index}`, turnId: 'turn', resultDigest: sha, inputDigest: sha })), reviewPassed: true } }
  analysis.ref = { sha256: elaborationDigest(JSON.stringify(analysis.analysis)) }
  const frozenInput: ElaborationInput = { ...input(true), maxRepairs: 0, analysis, decisionAuthorities: [authority], facts: [...input(true).facts!, { source: decisionSource, text: authority.decision.choice === 'new_rule' ? authority.decision.rule : '' }] }
  const fake = runner(request => {
    const output = candidate(request, source), req = output.changes[0].tables.REQ.find(row => row.id === 'REQ-EXPORT-01')!, rule = output.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-01')!
    req.goal = `${req.goal}；成功下载返回全部匹配记录，不以摘要代替。`
    // 受控builder依据真实派发指令填写来源，不模拟native自然语言能力。
    req.source = request.prompt.includes('REQ.source必须准确为decision:<当前stableDecisionId>') ? decisionSource : 'user:raw'
    rule.constraint = `${rule.constraint}；成功下载返回全部匹配记录，不以摘要代替。`; rule.source = decisionSource
    return output
  })
  const accepted = await elaborate(frozenInput, { runner: fake.run })
  assert.equal(accepted.status, 'complete', JSON.stringify(accepted.rounds.map(round => round.findings)))
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  for (const request of fake.calls) {
    assert.match(request.prompt, /REQ.source必须准确为decision:<当前stableDecisionId>/)
    assert.match(request.prompt, /同一已独审allowed_change/)
    assert.match(request.prompt, /keep_intent.*来源和业务意义/)
    assert.match(request.prompt, /仅更换RULE来源/)
    assert.doesNotMatch(request.prompt, /REQ来源user:raw；其他单值来源/)
    assert.ok(request.prompt.includes(decisionSource))
  }
  const req = accepted.contracts.flatMap(contract => contract.items).find(item => item.id === 'REQ-EXPORT-01')!
  assert.equal(req.kind, 'REQ'); assert.deepEqual(req.source, { kind: 'decision', ref: sha })
  assert.equal(accepted.changes[0].source.includes(rawSource), true)
  const originalRule = parseContract({ nodeId: 'export-contract', path, source }).contract!.items.find(item => item.id === 'RULE-EXPORT-01')!
  assert.equal(originalRule.kind, 'RULE')
  for (const invalid of ['raw-source', 'source-only-rule'] as const) {
    const rejected = runner(request => {
      const output = candidate(request, accepted.changes[0].source)
      if (invalid === 'raw-source') output.changes[0].tables.REQ.find(row => row.id === req.id)!.source = 'user:raw'
      else output.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-01')!.constraint = originalRule.constraint
      return output
    })
    const result = await elaborate(frozenInput, { runner: rejected.run })
    assert.equal(result.reviewPassed, false)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
    assert.deepEqual(rejected.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})


test('只读实现模式仅接受现存测试，不把缺文件或用例延后给代码生成', async () => {
  const complete = runner(request => candidate(request, source))
  const accepted = await elaborate({ ...input(), implementationWritePaths: [], maxRepairs: 0 }, { runner: complete.run })
  assert.equal(accepted.status, 'complete')
  for (const testSource of [null, "import test from 'node:test'\n"]) {
    const readonlyFiles = new Map(files)
    if (testSource === null) readonlyFiles.delete('tests/export.test.mjs')
    else readonlyFiles.set('tests/export.test.mjs', testSource)
    const fake = runner(request => candidate(request, source))
    const result = await elaborate({ ...input(), files: readonlyFiles, implementationWritePaths: [], maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.structurePassed, false)
    assert.equal(result.reviewPassed, false)
    assert.equal(result.deferredImplementationFindings.length, 0)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === 'readonly_implementation_gap'))
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})


test('只读实现模式的独审实现缺陷保留为阻断而非待生成任务', async () => {
  const defect = { code: 'implementation-review', kind: 'repair' as const, message: '测试断言需要改写', affectedIds: ['AC-EXPORT-03'], evidence: 'tests/export.test.mjs#AC-EXPORT-03：现存断言与已确定契约不一致。', decision: '只修测试。' }
  const fake = runner(request => candidate(request, source), request => ({ ...review(request), verdict: 'repair', findings: [defect] }))
  const result = await elaborate({ ...input(), implementationWritePaths: [], maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.reviewPassed, false)
  assert.equal(result.deferredImplementationFindings.length, 0)
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'readonly_implementation_gap'))
  assert.deepEqual(result.rounds[0].review!.findings, [defect])
})

for (const scenario of ['author-ac', 'missing-oracle', 'stable-id'] as const) test(`candidate_review诊断不授权降低已有义务 ${scenario}`, async () => {
  const built = await elaborate(input(), { runner: runner(request => candidate(request, source)).run })
  assert.equal(built.reviewPassed, true)
  const snapshot = input(scenario === 'author-ac')
  const repair: NonNullable<ElaborationInput['readonlySpecRepair']> = { kind: 'candidate_review', reviewEvidence: [{ partitionId: 'owner', resultRef: { sha256: 'a'.repeat(64) } }], baseInputDigest: 'b'.repeat(64), candidateDigest: built.candidateDigest!, generationRef: { sha256: 'c'.repeat(64) }, acceptedRef: { sha256: 'd'.repeat(64) }, changes: built.changes, output: built.rounds.at(-1)!.output, review: built.rounds.at(-1)!.review, findings: [{ code: 'candidate-review-repair', severity: 'error', nodeId: 'export-contract', path, itemId: 'AC-EXPORT-01', message: 'critic要求迎合现有实现或测试覆盖' }] }
  const fake = runner(request => {
    const generated = candidate(request, source)
    if (scenario === 'author-ac') generated.changes[0].tables.AC[0].assertion = '只需返回任意结果，降低原完整结果义务'
    if (scenario === 'stable-id') generated.changes[0].tables.AC[0].id = 'AC-EXPORT-REPLACED'
    return generated
  })
  const context = new Map(files)
  if (scenario === 'missing-oracle') context.delete('tests/export.test.mjs')
  const result = await elaborate({ ...snapshot, readonlySpecRepair: repair, implementationWritePaths: [], readonlyTestPaths: ['tests/export.test.mjs'], files: context, maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.reviewPassed, false)
  const code = scenario === 'author-ac' ? 'acceptance_update_unauthorized' : scenario === 'stable-id' ? 'readonly_repair_id_removed' : 'readonly_implementation_gap'
  assert.ok(result.rounds.flatMap(round => round.findings).some(finding => finding.code === code), JSON.stringify(result.rounds.map(round => round.findings)))
  assert.equal(fake.calls.some(call => call.purpose === 'elaboration_review'), false, '原硬门失败不得靠新独审自批')
  assert.equal(snapshot.intent.rawSource, rawSource)
})
