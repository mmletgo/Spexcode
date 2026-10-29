import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest } from './elaboration.js'
import { elaborationSchema, outputErrors } from './elaboration-schema.js'
import { bindElaborationTargets, elaborationTargetBindings, renderElaboration } from './elaboration-markdown.js'
import type { GeneratedTargetElaboration } from './elaboration-markdown.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'

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
