import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest } from './elaboration.js'
import { bindElaborationTargets, elaborationTargetBindings } from './elaboration-markdown.js'
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
  assert.equal(schema.changes.minItems, 1)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal('path' in (result.rounds[0].output as { changes: Record<string, unknown>[] }).changes[0], false)
})

test('派发schema按新目标和raw-only目标派生最低覆盖数量，漏目标不得进入独审', async () => {
  const frozen = input()
  const rawSource = '另一个由冻结原意指定的验证入口。'
  const source = '# 原始入口\n\n## raw source\n\n' + rawSource + '\n'
  frozen.targets = [...frozen.targets, { nodeId: 'raw-only', path: '.spec/export/raw-only/spec.md', source, sourceDigest: elaborationDigest(source), rawSource }]
  const fake = runner(request => build(request))
  const result = await elaborate(frozen, { runner: fake.run })
  const schema = fake.calls[0].schema.properties as Record<string, { minItems: number }>
  assert.equal(schema.changes.minItems, 2)
  assert.equal(result.reviewPassed, false)
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'output_schema'))
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

test('重复目标不能替代漏项，即使满足schema最低数量也不进入独审', async () => {
  const frozen = input()
  frozen.targets = [...frozen.targets, { nodeId: 'another-leaf', path: '.spec/export/another-leaf/spec.md', source: null, sourceDigest: null, rawSource: '另一个冻结验证入口。' }]
  const fake = runner(request => build(request, [leaf(request), leaf(request)]))
  const result = await elaborate(frozen, { runner: fake.run })
  assert.equal(result.reviewPassed, false)
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'write_scope'))
  assert.ok(result.rounds[0].findings.some(finding => finding.code === 'target_not_elaborated'))
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate'])
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
