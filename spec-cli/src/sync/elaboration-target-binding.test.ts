import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest, elaborationScopeErrors, freezeElaborationInput } from './elaboration.js'
import { elaborationSchema, outputErrors } from './elaboration-schema.js'
import { bindElaborationTargets, elaborationTargetBindings, renderElaboration } from './elaboration-markdown.js'
import type { GeneratedTargetElaboration } from './elaboration-markdown.js'
import { contractBusinessProse } from './contract-evolution.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationRepairSeed, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const primaryPath = '.spec/export/export-contract/spec.md'
const primarySource = readFileSync(new URL(primaryPath, fixture), 'utf8')
const primary = parseContract({ nodeId: 'export-contract', path: primaryPath, source: primarySource }).contract!
const leafPath = '.spec/export/research/research/nested-leaf/spec.md'
const files = new Map(['src/export.js', 'tests/export.test.mjs'].map(path => [path, readFileSync(new URL(path, fixture), 'utf8')]))
const input = (): ElaborationInput => ({
  root: '/test/frozen-target-binding',
  requestKey: 'frozen-target-binding',
  intent: { nodeId: 'export-contract', rawSource: primary.rawSource },
  targets: [
    { nodeId: 'export-contract', path: primaryPath, source: primarySource, sourceDigest: elaborationDigest(primarySource) },
    { nodeId: 'nested-leaf', path: leafPath, source: null, sourceDigest: null, rawSource: '保留父节点的导出义务；本节点只登记同一受信验证命令。' },
  ],
  facts: [{ source: 'decision:EXPORT-POLICY', text: primarySource }],
  files,
  maxRepairs: 0,
})
const version = (request: ElaborationSessionRequest): string => (request.schema.properties as Record<string, { enum: string[] }>).version.enum[0]
type RuleAuthoritySchemaView = {
  changes: {
    items: {
      properties: {
        tables: {
          properties: {
            RULE: { items: { properties: Record<string, Record<string, unknown>> } }
          }
        }
      }
    }
  }
}
const ruleAuthoritySchema = (request: ElaborationInput): Record<string, unknown> => {
  const schema = elaborationSchema(request)
  const properties = schema.properties as RuleAuthoritySchemaView
  return properties.changes.items.properties.tables.properties.RULE.items.properties.authority
}
const leaf = (request: ElaborationSessionRequest): Record<string, unknown> => ({
  ...(version(request) === 'elaboration-rows-v2' ? { nodeId: 'nested-leaf', path: '.spec/export/research/nested-leaf/spec.md' } : { targetIndex: 1 }),
  title: '受信验证登记',
  description: '',
  code: [],
  related: [],
  prose: '此节点只登记既有验证工具，不增加业务政策。',
  removeIds: [],
  tables: {
    ...Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])),
    VERIFY: [{ id: 'VERIFY-NESTED-01', command: ['node', '--version'], cwd: '.', 'timeout-ms': 1000 }],
  },
})
const build = (request: ElaborationSessionRequest, changes = [leaf(request)]): unknown => ({
  version: version(request),
  changes,
  applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '新增节点只登记技术验证，父契约完整保留业务边界。', affectedIds: [] })),
})
const runner = (generate: (request: ElaborationSessionRequest) => unknown): { run: ElaborationRunner; calls: ElaborationSessionRequest[] } => {
  const calls: ElaborationSessionRequest[] = []
  return { calls, run: async request => {
    calls.push(request)
    const output = request.purpose === 'elaboration_generate' ? generate(request) : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: 'target-session-' + calls.length, threadId: 'target-thread-' + calls.length, turnId: 'turn', output, resultDigest: elaborationDigest(JSON.stringify(output)) }
  } }
}

const ownerScopeInput = (): ElaborationInput => {
  const frozen = input()
  const source = `---\ntitle: 原父接口\ndesc: 保留原说明\ncontract-schema: sync-v1\nrelated:\n  - tests/export.test.mjs\n---\n# 原父标题\n\n## raw source\n\n父接口原意。\n\n## expanded spec\n\n父接口原解释。\n\n### VERIFY\n\n| id | command | cwd | timeout-ms |\n| --- | --- | --- | --- |\n| VERIFY-PARENT-01 | ["node","--version"] | . | 1000 |\n\n后置解释。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-PARENT-01 | 保留父接口 | user:raw | 不改变接口 | 子叶可承接 | - |\n`.replace(/\n/g, '\r\n')
  const fullSource = source.replace(/\| REQ-PARENT-01[^\r]*\r\n/, row => row + Array.from({ length: 7 }, (_, index) => `| REQ-PARENT-0${index + 2} | 保留父接口 | user:raw | 不改变接口 | 子叶可承接 | - |\r\n`).join(''))
  frozen.targets = [frozen.targets[0], { nodeId: 'parent', path: '.spec/parent/spec.md', source: fullSource, sourceDigest: elaborationDigest(fullSource) }]
  const analysis: CodeBehaviorAnalysis = { version: 'code-behavior-v1', inputId: 'scope-input', baselinePairId: null, composedDigest: 'a'.repeat(64), readSetDigest: 'a'.repeat(64), policyDigest: 'a'.repeat(64), inputDigest: 'a'.repeat(64), changes: [{ id: 'current-change', kind: 'allowed_change', paths: [], affectedIds: ['RULE-EXPORT-01'], ruleIds: ['RULE-EXPORT-01'], originalIntent: '保留导出义务', previousBehavior: '原导出说明', sourceBehavior: '补充导出说明', deliveryBehavior: '补充导出说明', evidence: '本轮只影响导出节点解释', counterexample: '父接口未改变' }], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [], reviewPassed: true }
  frozen.analysis = { analysis, ref: { sha256: elaborationDigest(JSON.stringify(analysis)) } }
  return frozen
}
const unchangedOwner = (frozen: ElaborationInput, targetIndex: number): GeneratedTargetElaboration['changes'][number] => {
  const target = frozen.targets[targetIndex], contract = parseContract({ ...target, source: target.source! }).contract!, fm = parseFrontmatter(target.source!).fm
  return { targetIndex, title: String(fm.title ?? ''), description: String(fm.desc ?? ''), code: contract.code, related: contract.related, prose: null, tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTargetElaboration['changes'][number]['tables'], removeIds: [] }
}

test('当前分析只影响A时拒绝B显式metadata、prose、related及行变化，旧schema仍接收原稿', () => {
  const frozen = ownerScopeInput(), node = unchangedOwner(frozen, 1)
  for (const changed of [{ title: '越界标题' }, { description: '越界说明' }, { prose: '越界解释' }, { related: ['src/export.js'] }, { code: ['src/export.js'] }, { removeIds: ['REQ-PARENT-01'] }, { tables: { ...node.tables, REQ: [{ id: 'REQ-PARENT-01', goal: '越界父接口', source: 'user:raw', constraints: '不改变接口', success: '子叶可承接', 'depends-on': [] }] } }]) {
    const output: GeneratedTargetElaboration = { version: 'elaboration-target-rows-v3', changes: [{ ...node, ...changed }], applicability: [] }
    assert.deepEqual(outputErrors(output.changes[0], ((elaborationSchema(frozen).properties as Record<string, { items: Record<string, unknown> }>).changes.items)), [], '新范围门不得改变历史草稿schema')
    const generated = bindElaborationTargets(frozen, output)
    assert.match(elaborationScopeErrors(frozen, generated).join(';'), /本轮分析未影响.*parent/, JSON.stringify(changed))
  }
})

test('受影响A的合法prose-only仍交付，B省略或显式等价正文与行逐字保留含VERIFY位置和CRLF', () => {
  const frozen = ownerScopeInput(), a = unchangedOwner(frozen, 0), b = unchangedOwner(frozen, 1)
  const prose = contractBusinessProse(parseParts(primarySource)!.expandedSpec) + '\n\n本轮合法补充导出解释。'
  const equivalent = { ...b, prose: contractBusinessProse(parseParts(frozen.targets[1].source!)!.expandedSpec), tables: { ...b.tables, REQ: [{ id: 'REQ-PARENT-01', goal: '保留父接口', source: 'user:raw', constraints: '不改变接口', success: '子叶可承接', 'depends-on': [] }] } }
  for (const others of [[], [b], [equivalent]]) {
    const generated = bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...a, prose }, ...others], applicability: [] })
    assert.deepEqual(elaborationScopeErrors(frozen, generated), [])
    const result = renderElaboration(frozen, generated, 'scope-proof')
    assert.match(result.changes.find(change => change.nodeId === 'export-contract')!.source, /本轮合法补充导出解释/)
    assert.equal(result.changes.find(change => change.nodeId === 'parent')!.source, frozen.targets[1].source)
  }
})

test('无变化的已有interface parent不因宽计划变更metadata或重排VERIFY，新required与明确move及VERIFY授权保持', () => {
  const frozen = ownerScopeInput(), parent = frozen.targets[1]
  frozen.targets = [parent]; frozen.intent = { nodeId: parent.nodeId, rawSource: parseParts(parent.source!)!.rawSource }; frozen.phase = 'interface_seed'
  frozen.analysis!.analysis.changes = []
  const node = unchangedOwner(frozen, 0)
  const render = (change: GeneratedTargetElaboration['changes'][number]) => renderElaboration(frozen, bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [change], applicability: [] }), 'parent-proof')
  assert.equal(elaborationScopeErrors(frozen, bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...node, title: '旧草稿标题', prose: '旧草稿解释' }], applicability: [] })).length, 1)
  assert.equal(render({ ...node, prose: contractBusinessProse(parseParts(parent.source!)!.expandedSpec) }).changes[0].source, parent.source)
  frozen.authorizedChanges = [{ id: 'VERIFY-PARENT-01', action: 'update_verification', source: 'user:raw', reason: '明确更新技术预算' }]
  frozen.verifications = [{ id: 'VERIFY-PARENT-01', command: ['node', '--version'], cwd: '.', timeoutMs: 2000 }]
  assert.match(render(node).changes[0].source, /2000/)
  frozen.authorizedChanges = []; frozen.verifications = undefined
  frozen.nodeChanges = [{ action: 'move', from: { nodeId: parent.nodeId, path: parent.path }, to: { nodeId: 'moved-parent', path: '.spec/moved-parent/spec.md' }, evidenceRef: { sha256: 'b'.repeat(64) } }]
  assert.equal(render(node).changes[0].nodeId, 'moved-parent')
  assert.deepEqual(elaborationScopeErrors(frozen, bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [node], applicability: [] })), [])
  frozen.nodeChanges = []; frozen.targets = [{ ...parent, source: null, sourceDigest: null, rawSource: '首次接口原意' }]
  assert.doesNotThrow(() => render({ ...node, title: '首次接口', prose: '首次接口说明' }))
  assert.deepEqual(elaborationScopeErrors(frozen, bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...node, prose: '首次接口说明' }], applicability: [] })), [])
  frozen.targets = [{ ...parent, source: '# 尚未启用契约的接口\n', sourceDigest: 'raw-only' }]
  assert.doesNotThrow(() => render({ ...node, title: '首次接口', prose: '首次接口说明' }))
  const emptySource = '---\ncontract-schema: sync-v1\n---\n## raw source\n\n父接口原意。\n\n## expanded spec\n\n'
  frozen.targets = [{ ...parent, source: emptySource, sourceDigest: elaborationDigest(emptySource) }]
  assert.deepEqual(elaborationScopeErrors(frozen, bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...node, prose: '首次接口说明' }], applicability: [] })), [])
  frozen.nodeChanges = [{ action: 'retire', from: { nodeId: parent.nodeId, path: parent.path }, evidenceRef: { sha256: 'b'.repeat(64) } }]
  assert.deepEqual(elaborationTargetBindings(frozen), [])
})

test('本轮真实code或AC.test路径确定owner，related和诊断不扩权，明确作者差量可命中', () => {
  const frozen = ownerScopeInput(), a = unchangedOwner(frozen, 0), b = unchangedOwner(frozen, 1), change = frozen.analysis!.analysis.changes[0]
  change.affectedIds = []; change.ruleIds = []
  for (const path of ['src/export.js', 'tests/export.test.mjs']) {
    change.paths = [path]
    const output = bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...a, prose: '当前owner合法解释' }, { ...b, title: '关联不能扩权' }], applicability: [] })
    assert.deepEqual(elaborationScopeErrors(frozen, output), ['本轮分析未影响目标，必须沿用冻结正文: .spec/parent/spec.md'])
  }
  frozen.refinement = { candidateDigest: 'a'.repeat(64), diagnostics: [{ code: 'repair', message: '诊断不是扩权' }] }
  const output = bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...b, title: '明确作者更新' }], applicability: [] })
  assert.equal(elaborationScopeErrors(frozen, output).length, 1)
  frozen.analysis!.analysis.authorChanges = [{ nodeId: 'parent', path: frozen.targets[1].path, beforeRaw: '旧原意', afterRaw: '父接口原意。', changedIds: ['REQ-PARENT-01'] }]
  assert.deepEqual(elaborationScopeErrors(frozen, output), [])
})

test('显式等价完整AC保留原字节，AC.test变化不能被业务等价投影掩盖', () => {
  const frozen = ownerScopeInput(), node = unchangedOwner(frozen, 0), ac = primary.items.find(item => item.kind === 'AC')!
  frozen.analysis!.analysis.changes = []
  const row = { id: ac.id, covers: ac.covers, preconditions: ac.preconditions, action: ac.action, assertion: ac.assertion, source: `${ac.source.kind}:${ac.source.ref}`, test: ac.test, command: ac.command, 'depends-on': ac.dependsOn }
  const generated = bindElaborationTargets(frozen, { version: 'elaboration-target-rows-v3', changes: [{ ...node, tables: { ...node.tables, AC: [row] } }], applicability: [] })
  assert.deepEqual(elaborationScopeErrors(frozen, generated), [])
  assert.equal(renderElaboration(frozen, generated, 'ac-proof').changes[0].source, primarySource)
  generated.changes[0].tables.AC[0].test = 'tests/changed.test.mjs#changed'
  assert.equal(elaborationScopeErrors(frozen, generated).length, 1)
})

test('未受影响owner旧JSON经rows_patch保留并在原预算续修，不能提前独审或升ready', async () => {
  const frozen = ownerScopeInput(), parent = frozen.targets[1]
  frozen.targets = [parent]; frozen.intent = { nodeId: parent.nodeId, rawSource: parseParts(parent.source!)!.rawSource }; frozen.phase = 'interface_seed'; frozen.maxRepairs = 1
  frozen.verifications = [{ id: 'VERIFY-PARENT-01', command: ['node', '--version'], cwd: '.', timeoutMs: 1000 }]
  frozen.analysis!.analysis.changes = []; frozen.analysis!.ref.sha256 = elaborationDigest(JSON.stringify(frozen.analysis!.analysis))
  const node = unchangedOwner(frozen, 0), outputs: unknown[] = []
  const fake = runner(request => {
    const output = build(request, [{ ...node, ...(outputs.length ? { prose: contractBusinessProse(parseParts(parent.source!)!.expandedSpec) } : { title: '旧草稿越界标题', prose: '旧草稿越界说明' }) }])
    outputs.push(output); return output
  })
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.status, 'interface_seed', JSON.stringify(result.rounds.flatMap(round => round.findings)))
  assert.deepEqual(result.rounds[0].output, outputs[0], '被拒JSON原件保留供续修')
  assert.equal(result.rounds[0].candidate, null); assert.equal(result.rounds[0].review, null)
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'rows_patch' && finding.message.includes('本轮分析未影响')))
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  assert.match(fake.calls[1].prompt, /rows_patch/); assert.match(fake.calls[1].prompt, /旧草稿越界标题/)
  assert.equal(result.changes[0].source, parent.source)
  assert.equal(result.implementationReady, false)
})

test('历史已结算v3拒绝seed保留原JSON和candidate身份，新owner范围诊断不阻断续修入口', async () => {
  const frozen = ownerScopeInput(), parent = frozen.targets[1]
  frozen.targets = [parent]; frozen.intent = { nodeId: parent.nodeId, rawSource: parseParts(parent.source!)!.rawSource }; frozen.phase = 'interface_seed'
  frozen.verifications = [{ id: 'VERIFY-PARENT-01', command: ['node', '--version'], cwd: '.', timeoutMs: 1000 }]
  frozen.analysis!.analysis.changes = []; frozen.analysis!.ref.sha256 = elaborationDigest(JSON.stringify(frozen.analysis!.analysis))
  const node = unchangedOwner(frozen, 0), output: GeneratedTargetElaboration = { version: 'elaboration-target-rows-v3', changes: [{ ...node, title: '历史拒绝稿标题', prose: '历史拒绝稿说明' }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口不执行子业务', affectedIds: [] })) }
  const inputDigest = freezeElaborationInput(frozen).inputDigest, candidate = renderElaboration(frozen, bindElaborationTargets(frozen, output), inputDigest)
  const seed: ElaborationRepairSeed = { settled: true, requestKey: 'prior-settled-owner', inputDigest, candidateDigest: elaborationDigest(JSON.stringify(candidate)), output, candidate, review: null, findings: [{ code: 'prior-review-repair', severity: 'error', nodeId: parent.nodeId, path: parent.path, message: '旧稿需恢复未受影响父说明' }], traces: [{ purpose: 'elaboration_generate', sessionId: 'prior-owner-session', threadId: 'prior-owner-thread', turnId: 'prior-turn', resultDigest: elaborationDigest(JSON.stringify(output)), inputDigest }] }
  const original = structuredClone(seed), fake = runner(request => build(request, [node]))
  const result = await elaborate(frozen, { seed, runner: fake.run })
  assert.equal(result.status, 'interface_seed', JSON.stringify(result.failure))
  assert.equal(result.prior?.candidateDigest, seed.candidateDigest)
  assert.match(fake.calls[0].prompt, /历史拒绝稿标题/); assert.match(fake.calls[0].prompt, /rows_patch/)
  assert.equal(result.changes[0].source, parent.source)
  assert.deepEqual(seed, original, '原seed和摘要不能重签')
})

test('冻结节点身份决定深层canonical路径，模型不再回显可写路径', async () => {
  const fake = runner(request => build(request))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds.flatMap(round => round.findings)))
  const generated = result.changes.find(change => change.nodeId === 'nested-leaf')!
  assert.equal(generated.path, leafPath)
  assert.match(generated.source, /保留父节点的导出义务/)
  const schema = fake.calls[0].schema.properties as Record<string, { items: { properties: Record<string, unknown> }; minItems: number }>
  assert.equal('path' in schema.changes.items.properties, false)
  assert.equal('nodeId' in schema.changes.items.properties, false)
  assert.deepEqual(schema.changes.items.properties.targetIndex, { type: 'integer', minimum: 0, maximum: 1 })
  assert.equal(schema.changes.minItems, 0)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal('path' in (result.rounds[0].output as { changes: Record<string, unknown>[] }).changes[0], false)
})


test('既有reelaborate提示分别列全部可更新目标与首次必建子集', async () => {
  const frozen = input(); frozen.targets = [frozen.targets[0]]; frozen.mode = 'reelaborate'
  frozen.intent.rawSource += '\n\n按本轮明确原意补齐必要业务差量。'
  frozen.targets = [{ ...frozen.targets[0], rawSource: frozen.intent.rawSource }]
  frozen.context = [{ nodeId: 'export', path: '.spec/export/spec.md', source: '# 只读父原意\n' }]
  const before = structuredClone(frozen)
  let captured: ElaborationSessionRequest | undefined
  const result = await elaborate(frozen, { runner: async request => { captured = request; throw Object.assign(new Error('只捕获冻结提示，不派Native'), { code: 'unsupported' }) } })
  assert.ok(captured); assert.equal(result.status, 'unsupported')
  assert.match(captured.prompt, /本次可更新的冻结目标共 1 个，可编辑的原始 targetIndex：\[0\]/)
  assert.match(captured.prompt, /首次必须显式构建 0 个目标，原始 targetIndex：\[\]/)
  assert.ok(!captured.prompt.includes('本次必须显式构建 0 个目标'))
  assert.match(captured.prompt, /reelaborate.*raw\/facts.*authorizedChanges.*repair/)
  const changes = (captured.schema.properties as Record<string, { minItems: number; maxItems: number; items: { properties: Record<string, unknown> } }>).changes
  assert.equal(changes.minItems, 0); assert.equal(changes.maxItems, 1)
  assert.deepEqual(changes.items.properties.targetIndex, { type: 'integer', minimum: 0, maximum: 0 })
  assert.deepEqual(outputErrors(build(captured, []), captured.schema), [], '空行差量仍可进入原候选与独审门')
  assert.deepEqual(frozen, before, '提示不能改目标、raw、事实或权限')
})

test('真实retire零可更新目标提示和schema保持零且不复活旧目标', async () => {
  const frozen = input(); frozen.targets = [frozen.targets[0]]
  frozen.nodeChanges = [{ action: 'retire', from: { nodeId: 'export-contract', path: primaryPath }, evidenceRef: { sha256: 'a'.repeat(64) } }]
  frozen.authorizedChanges = primary.items.map(item => ({ id: item.id, action: 'retire', source: 'user:raw', reason: '夹具用户明确退役全部既有身份' }))
  let captured: ElaborationSessionRequest | undefined
  await elaborate(frozen, { runner: async request => { captured = request; throw Object.assign(new Error('只捕获零目标提示'), { code: 'unsupported' }) } })
  assert.ok(captured)
  assert.match(captured.prompt, /本次可更新的冻结目标共 0 个，可编辑的原始 targetIndex：\[\]/)
  assert.deepEqual(elaborationTargetBindings(frozen), [])
  assert.equal((captured.schema.properties as Record<string, { maxItems: number }>).changes.maxItems, 0)
})

test('已有纯父接口首次必建零不扩大父阶段业务表', async () => {
  const frozen = input(), raw = '由真实子区承接既有导出能力。'
  const source = `---\ntitle: 父接口\ncontract-schema: sync-v1\n---\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-PARENT-01 | 导出能力 | user:raw | 由子区承接 | 保持既有行为 | - |\n`
  frozen.phase = 'interface_seed'; frozen.intent = { nodeId: 'export', rawSource: raw }
  frozen.targets = [{ nodeId: 'export', path: '.spec/export/spec.md', source, sourceDigest: elaborationDigest(source) }]
  let captured: ElaborationSessionRequest | undefined
  await elaborate(frozen, { runner: async request => { captured = request; throw Object.assign(new Error('只捕获父接口提示'), { code: 'unsupported' }) } })
  assert.ok(captured)
  assert.match(captured.prompt, /本次可更新的冻结目标共 1 个，可编辑的原始 targetIndex：\[0\]/)
  assert.match(captured.prompt, /首次必须显式构建 0 个目标/)
  const properties = captured.schema.properties as Record<string, { items: { properties: { tables: { properties: Record<string, { maxItems: number }> } } } }>
  for (const kind of ['FLOW', 'STEP', 'AC', 'VERIFY']) assert.equal(properties.changes.items.properties.tables.properties[kind].maxItems, 0)
})

test('确无变化的已有完整契约继续允许空行差量逐字沿用', async () => {
  const frozen = input(); frozen.targets = [frozen.targets[0]]
  const fake = runner(request => build(request, []))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.equal(result.changes[0].source, primarySource)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('RULE.authority schema限制为冻结canonical nodeId，move兼容旧owner且无目标不生成空enum', () => {
  const multiple = input(), multipleAuthority = ruleAuthoritySchema(multiple)
  assert.deepEqual(outputErrors('REQ-EXPORT-01', multipleAuthority), ['$: 未满足枚举'])
  assert.deepEqual([...(multipleAuthority.enum as string[])].sort(), ['export-contract', 'nested-leaf'])

  const single = input(); single.targets = [single.targets[0]]
  const singleAuthority = ruleAuthoritySchema(single)
  assert.deepEqual(singleAuthority.enum, ['export-contract'])
  assert.deepEqual(outputErrors('export-contract', singleAuthority), [])
  assert.ok(outputErrors('RULE-EXPORT-01', singleAuthority).length)

  const moved = input(); moved.targets = [moved.targets[0]]
  moved.nodeChanges = [{ action: 'move', from: { nodeId: 'export-contract', path: primaryPath }, to: { nodeId: 'moved-export', path: '.spec/export/moved-export/spec.md' }, evidenceRef: { sha256: 'a'.repeat(64) } }]
  const movedAuthority = ruleAuthoritySchema(moved)
  assert.deepEqual([...(movedAuthority.enum as string[])].sort(), ['export-contract', 'moved-export'])
  assert.deepEqual(outputErrors('export-contract', movedAuthority), [])
  assert.deepEqual(outputErrors('moved-export', movedAuthority), [])
  const rule = primary.items.find(item => item.kind === 'RULE')!
  const tables = Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTargetElaboration['changes'][number]['tables']
  tables.RULE = [{ id: rule.id, scope: rule.scope, constraint: rule.constraint, basis: rule.basis, authority: rule.authority, source: `${rule.source.kind}:${rule.source.ref}`, 'depends-on': rule.dependsOn }]
  const output: GeneratedTargetElaboration = {
    version: 'elaboration-target-rows-v3',
    changes: [{ targetIndex: 0, title: '导出事件服务契约', description: '', code: primary.code, related: primary.related, prose: null, tables, removeIds: [] }],
    applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '冻结原意', affectedIds: [] })),
  }
  const bound = bindElaborationTargets(moved, output)
  const rendered = renderElaboration(moved, bound, elaborationDigest('move authority'))
  const movedContract = parseContract({ nodeId: 'moved-export', path: '.spec/export/moved-export/spec.md', source: rendered.changes[0].source }).contract!
  assert.ok(movedContract.items.some(item => item.kind === 'RULE' && item.id === rule.id && item.authority === 'moved-export'))

  const retired = input()
  retired.nodeChanges = retired.targets.map(target => ({ action: 'retire', from: { nodeId: target.nodeId, path: target.path }, evidenceRef: { sha256: 'b'.repeat(64) } }))
  const retiredAuthority = ruleAuthoritySchema(retired)
  assert.equal('enum' in retiredAuthority, false)
})

test('合法部分输出保留候选并反馈漏目标，schema最低数量不替代逐目标门禁', async () => {
  const frozen = input()
  const rawSource = '另一个由冻结原意指定的验证入口。'
  const source = '# 原始入口\n\n## raw source\n\n' + rawSource + '\n'
  frozen.targets = [...frozen.targets, { nodeId: 'raw-only', path: '.spec/export/raw-only/spec.md', source, sourceDigest: elaborationDigest(source), rawSource }]
  const fake = runner(request => build(request))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.ok(result.rounds[0].candidate)
  assert.equal(result.reviewPassed, false)
  assert.deepEqual(result.rounds[0].findings.filter(finding => finding.code === 'target_not_elaborated').map(finding => finding.message), [
    '新目标或raw-only目标必须显式完成细化: .spec/export/raw-only/spec.md',
  ])
  assert.ok(!result.rounds[0].findings.some(finding => finding.code === 'output_schema'))
  const schema = fake.calls[0].schema.properties as Record<string, { minItems: number }>
  assert.equal(schema.changes.minItems, 0)
  assert.match(fake.calls[0].prompt, /必须显式构建\s*2\s*个目标/)
  assert.match(fake.calls[0].prompt, /原始 targetIndex：\[1,2\]/)
  assert.match(fake.calls[0].prompt, /完整、可解析的紧凑JSON对象/)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
})

test('未知节点和模型额外路径字段在结构化边界拒绝，不能扩大冻结写入范围', async () => {
  for (const mutation of [
    (node: Record<string, unknown>) => ({ ...node, targetIndex: -1 }),
    (node: Record<string, unknown>) => ({ ...node, targetIndex: 1.5 }),
    (node: Record<string, unknown>) => ({ ...node, targetIndex: 2 }),
    (node: Record<string, unknown>) => ({ ...node, nodeId: 'not-authorized' }),
    (node: Record<string, unknown>) => ({ ...node, path: '.spec/outside/spec.md' }),
  ]) {
    const fake = runner(request => build(request, [mutation(leaf(request))]))
    const result = await elaborate(input(), { runner: fake.run })
    assert.equal(result.reviewPassed, false)
    assert.ok(result.rounds[0].findings.some(finding => finding.code === 'output_schema'))
    assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
  }
})

test('681个冻结目标乱序返回时仍逐项绑定原下标，wire不要求回显身份或路径', async () => {
  const frozen = input()
  const children = Array.from({ length: 680 }, (_, index) => ({
    nodeId: 'target-' + index,
    path: '.spec/export/target-' + index + '/spec.md',
    source: null,
    sourceDigest: null,
    rawSource: '只登记既有导出义务所用的技术验证入口。',
  }))
  frozen.targets = [frozen.targets[0], ...children]
  const fake = runner(request => build(request, children.map((_, index) => ({
    ...leaf(request),
    targetIndex: index + 1,
    tables: {
      ...Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])),
      VERIFY: [{ id: 'VERIFY-TARGET-' + index, command: ['node', '--version'], cwd: '.', 'timeout-ms': 1000 }],
    },
  })).reverse()))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds.flatMap(round => round.findings).slice(0,4)))
  const changes = new Map(result.changes.map(change => [change.nodeId, change]))
  for (const target of children) assert.equal(changes.get(target.nodeId)?.path, target.path)
  const wire = JSON.parse(fake.calls[0].prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { targetIndex: number; nodeId: string; path: string }[] }
  assert.deepEqual(wire.targets.map(target => target.targetIndex), frozen.targets.map((_, index) => index))
  assert.equal(result.changes.length, frozen.targets.length)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('retire不压缩原下标，move只绑定冻结目的身份；退役下标不能写入', () => {
  const frozen = input()
  frozen.nodeChanges = [
    { action: 'retire', from: { nodeId: 'export-contract', path: primaryPath }, evidenceRef: { sha256: 'a'.repeat(64) } },
    { action: 'move', from: { nodeId: 'nested-leaf', path: leafPath }, to: { nodeId: 'moved-leaf', path: '.spec/export/moved-leaf/spec.md' }, evidenceRef: { sha256: 'b'.repeat(64) } },
  ]
  const bindings = elaborationTargetBindings(frozen)
  assert.deepEqual(bindings.map(({ targetIndex, nodeId, path }) => ({ targetIndex, nodeId, path })), [{ targetIndex: 1, nodeId: 'moved-leaf', path: '.spec/export/moved-leaf/spec.md' }])
  const output: GeneratedTargetElaboration = { version: 'elaboration-target-rows-v3', changes: [{ targetIndex: 1, title: '验证入口', description: '', code: [], related: [], prose: null, tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTargetElaboration['changes'][number]['tables'], removeIds: [] }], applicability: [] }
  const bound = bindElaborationTargets(frozen, output)
  assert.equal(bound.changes[0].nodeId, 'moved-leaf')
  assert.equal(bound.changes[0].path, '.spec/export/moved-leaf/spec.md')
  output.changes[0].targetIndex = 0
  assert.throws(() => bindElaborationTargets(frozen, output), /已退役目标/)
})

test('重复目标不能替代漏项，即使schema允许该行数也不进入独审', async () => {
  const frozen = input()
  frozen.targets = [...frozen.targets, { nodeId: 'another-leaf', path: '.spec/export/another-leaf/spec.md', source: null, sourceDigest: null, rawSource: '另一个冻结验证入口。' }]
  const fake = runner(request => build(request, [leaf(request), leaf(request)]))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.reviewPassed, false)
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'write_scope'))
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'target_not_elaborated'))
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
})

test('退役下标先被拒绝后仍可在既有预算内修复，不提前终止同步', async () => {
  const frozen = input()
  const source = '---\ntitle: 退役验证入口\ncontract-schema: sync-v1\n---\n\n## expanded spec\n\n旧技术验证。\n\n### VERIFY\n\n| id | command | cwd | timeout-ms |\n| --- | --- | --- | --- |\n| VERIFY-NESTED-01 | ["node","--version"] | . | 1000 |\n'
  frozen.targets = [frozen.targets[0], { ...frozen.targets[1], source, sourceDigest: elaborationDigest(source) }]
  frozen.nodeChanges = [{ action: 'retire', from: { nodeId: 'nested-leaf', path: leafPath }, evidenceRef: { sha256: 'a'.repeat(64) } }]
  frozen.authorizedChanges = [{ id: 'VERIFY-NESTED-01', action: 'retire', source: 'user:raw', reason: '用户明确取消旧技术验证节点' }]
  frozen.maxRepairs = 1
  let generated = 0
  const fake = runner(request => build(request, generated++ === 0 ? [leaf(request)] : []))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds.map(round => round.findings)))
  assert.equal(result.rounds.length, 2)
  assert.equal(result.rounds[0].candidate, null)
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'output_schema'))
  assert.match(fake.calls[1].prompt, /targetIndex/)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  assert.equal(result.changes.some(change => change.path === leafPath), false)
})

test('调用者在await期间重排或改写targets不能改变冻结索引绑定', async () => {
  const frozen = input()
  const fake = runner(request => {
    frozen.targets = [...frozen.targets].reverse()
    frozen.targets[0].path = '.spec/outside/spec.md'
    return build(request)
  })
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.changes.find(change => change.nodeId === 'nested-leaf')?.path, leafPath)
})
