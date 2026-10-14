import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { elaborationPatchErrors, renderElaboration } from './elaboration-markdown.js'
import type { GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { elaborationDigest } from './elaboration.js'
import type { ElaborationInput } from './elaboration-types.js'

const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(new URL('../../test/fixtures/spec-sync/export-repo/' + path, import.meta.url), 'utf8')
const baseline = parseContract({ nodeId: 'export-contract', path, source }).contract!
const input: ElaborationInput = { root: '/frozen', requestKey: 'delta', intent: { nodeId: 'export-contract', rawSource: baseline.rawSource }, targets: [{ nodeId: 'export-contract', path, source, sourceDigest: elaborationDigest(source) }] }
const tables = (): GeneratedTables => Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
const patch = (): GeneratedElaboration => ({ version: 'elaboration-rows-v2', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(source).fm.title), description: String(parseFrontmatter(source).fm.desc ?? ''), code: baseline.code, related: baseline.related, prose: null, removeIds: [], tables: tables() }], applicability: [] })

test('少量新增行保留冻结契约全部旧义务、raw和完整正文', () => {
  const output = patch()
  output.changes[0].tables.RULE.push({ id: 'RULE-EXPORT-DELTA', scope: '导出', constraint: '返回行数', basis: '冻结新意图', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] })
  const rendered = renderElaboration(input, output, 'input').changes[0].source
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered })
  assert.deepEqual(parsed.findings, [])
  for (const item of baseline.items) assert.ok(parsed.contract!.items.some(next => next.id === item.id), item.id)
  assert.equal(parsed.contract!.items.length, baseline.items.length + 1)
  assert.equal(parseParts(rendered)!.rawSource, baseline.rawSource)
})


test('空差量与原样upsert逐字保留Markdown、表格布局和正文围栏', () => {
  const extras = '\n\n### 状态不适用依据\n输入域、业务不变量与可观察结束均由原契约界定。\n\n~~~markdown\n### RULE\n| 这是正文示例 | 不能当业务表 |\n~~~'
  const rich = source.replace('## expanded spec', '## expanded spec' + extras)
  for (const frozen of [rich, rich.replace(/\n/g, '\r\n'), rich.replace('### RULE', '###   RULE  ').replace(/^\|/gm, '  |'), rich.replace(/code:\n  - ([^\n]+)/, 'code: $1')]) {
    const snapshot = { ...input, targets: [{ ...input.targets[0], source: frozen, sourceDigest: elaborationDigest(frozen) }] }
    assert.equal(renderElaboration(snapshot, patch(), 'input').changes[0].source, frozen)
    const output = patch(), item = baseline.items.find(item => item.kind === 'RULE')!
    assert.equal(item.kind, 'RULE')
    output.changes[0].tables.RULE.push({ id: item.id, scope: item.scope, constraint: item.constraint, basis: item.basis, authority: item.authority, source: `${item.source.kind}:${item.source.ref}`, 'depends-on': item.dependsOn })
    assert.equal(renderElaboration(snapshot, output, 'input').changes[0].source, frozen)
  }
})

test('大冻结基线只输出一行，保留全部旧ID和后置正文，响应字节不随旧行增长', () => {
  const oldRow = source.match(/^\| RULE-EXPORT-01 .*$/m)![0]
  const many = Array.from({ length: 150 }, (_, index) => oldRow.replace('RULE-EXPORT-01', `RULE-EXPORT-FROZEN-${index}`))
  const large = source.replace(oldRow, [oldRow, ...many].join('\n')) + '\n保留的后置业务说明。\n'
  const snapshot = { ...input, targets: [{ ...input.targets[0], source: large, sourceDigest: elaborationDigest(large) }] }
  const output = patch()
  output.changes[0].tables.RULE.push({ id: 'RULE-EXPORT-DELTA', scope: '导出', constraint: '新增行数', basis: '明确业务事实', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] })
  const rendered = renderElaboration(snapshot, output, 'input').changes[0].source
  const before = parseContract({ nodeId: 'export-contract', path, source: large }).contract!
  const after = parseContract({ nodeId: 'export-contract', path, source: rendered }).contract!
  assert.equal(after.items.length, before.items.length + 1)
  for (const item of before.items) assert.deepEqual(after.items.find(next => next.id === item.id), { ...item, line: after.items.find(next => next.id === item.id)!.line })
  assert.ok(rendered.includes('保留的后置业务说明。'))
  assert.ok(rendered.includes(baseline.rawSource))
  assert.equal(Object.values(output.changes[0].tables).flat().length, 1)
  assert.equal(renderElaboration(input, output, 'input').changes[0].source.includes('RULE-EXPORT-FROZEN-0'), false)
  assert.ok(JSON.stringify(output).length < large.length / 10)
})

test('替换完整行和显式删除保留所有其他行，删空类型不留空表', () => {
  const output = patch(), rule = baseline.items.find(item => item.kind === 'RULE')!
  assert.equal(rule.kind, 'RULE')
  output.changes[0].tables.RULE.push({ id: rule.id, scope: rule.scope, constraint: '合法替换内容由上层门禁核对', basis: rule.basis, authority: rule.authority, source: `${rule.source.kind}:${rule.source.ref}`, 'depends-on': rule.dependsOn })
  output.changes[0].removeIds = baseline.items.filter(item => item.kind === 'AC').map(item => item.id)
  const rendered = renderElaboration(input, output, 'input').changes[0].source
  const after = parseContract({ nodeId: 'export-contract', path, source: rendered })
  assert.deepEqual(after.findings, [])
  assert.ok(!rendered.includes('### AC'))
  assert.equal(after.contract!.items.length, baseline.items.length - output.changes[0].removeIds.length)
  assert.equal(after.contract!.items.find(item => item.id === rule.id && item.kind === 'RULE')?.kind, 'RULE')
  assert.ok(rendered.includes('合法替换内容由上层门禁核对'))
})

test('重复upsert、重复删除、异节点删除、同节点删除再更新均显式拒绝', () => {
  const output = patch(), row = { id: 'RULE-EXPORT-DELTA', scope: '导出', constraint: '返回行数', basis: '事实', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] }
  output.changes[0].tables.RULE = [row, row]
  assert.ok(elaborationPatchErrors(input, output).some(error => error.includes('重复更新')))
  output.changes[0].tables.RULE = []
  output.changes[0].removeIds = ['AC-EXPORT-01', 'AC-EXPORT-01', 'AC-OTHER-01']
  assert.ok(elaborationPatchErrors(input, output).some(error => error.includes('重复删除')))
  assert.ok(elaborationPatchErrors(input, output).some(error => error.includes('不属于冻结节点')))
  output.changes[0].tables.REQ = [{ id: 'REQ-EXPORT-01' }]
  output.changes[0].removeIds = ['REQ-EXPORT-01']
  assert.ok(elaborationPatchErrors(input, output).some(error => error.includes('同时删除和更新')))
  assert.throws(() => renderElaboration(input, output, 'input'), /同时删除和更新/)
})

test('raw-only旧节点用同一协议首次建立契约，保留原raw及既有说明', () => {
  const rawOnly = '---\ntitle: 导出服务\n---\n## raw source\n\n真实旧原意。\n\n## expanded spec\n\n原有不适用依据与业务输入域。\n'
  const output = patch()
  output.changes[0].tables.REQ = [{ id: 'REQ-EXPORT-01', goal: '导出', source: 'user:raw', constraints: '-', success: '返回数据', 'depends-on': [] }]
  const snapshot = { ...input, intent: { ...input.intent, rawSource: '真实旧原意。' }, targets: [{ ...input.targets[0], source: rawOnly, sourceDigest: elaborationDigest(rawOnly) }] }
  const rendered = renderElaboration(snapshot, output, 'input').changes[0].source
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.items.length, 1)
  assert.equal(parsed.contract!.rawSource, '真实旧原意。')
  assert.ok(rendered.includes('原有不适用依据与业务输入域。'))
})

test('无状态N/A正文与普通STATE/EVENT/TR显式转换，不混留旧表或丢不适用依据', () => {
  const output = patch(), node = output.changes[0]
  node.prose = 'N/A：此能力无状态；输入域是记录数组，计数不变量为数组长度，可观察结束为返回计数。'
  node.tables.REQ = [{ id: 'REQ-EXPORT-COUNT', goal: '返回计数', source: 'user:raw', constraints: '-', success: '正确计数', 'depends-on': [] }]
  const empty = { ...input, targets: [{ ...input.targets[0], source: null, sourceDigest: null }] }
  const stateless = renderElaboration(empty, output, 'input').changes[0].source
  const snapshot = { ...input, targets: [{ ...input.targets[0], source: stateless, sourceDigest: elaborationDigest(stateless) }] }
  const stateful = patch()
  stateful.changes[0].prose = '记录对象有运行中和结束状态；输入域是记录数组，状态结束返回计数。'
  stateful.changes[0].tables.STATE = [
    { id: 'STATE-EXPORT-COUNT-RUNNING', object: 'count', meaning: '运行中', initial: true, terminal: false, feedback: '处理中', source: 'user:REQ-EXPORT-COUNT', 'depends-on': ['REQ-EXPORT-COUNT'] },
    { id: 'STATE-EXPORT-COUNT-END', object: 'count', meaning: '完成', initial: false, terminal: true, feedback: '返回计数', source: 'user:REQ-EXPORT-COUNT', 'depends-on': ['REQ-EXPORT-COUNT'] },
  ]
  stateful.changes[0].tables.EVENT = [{ id: 'EVENT-EXPORT-COUNT-FINISH', object: 'count', origin: '调用', trigger: '计数完成', input: '记录数组', source: 'user:REQ-EXPORT-COUNT', 'depends-on': ['REQ-EXPORT-COUNT'] }]
  stateful.changes[0].tables.TR = [{ id: 'TR-EXPORT-COUNT-FINISH', object: 'count', from: 'STATE-EXPORT-COUNT-RUNNING', event: 'EVENT-EXPORT-COUNT-FINISH', condition: '计数完成', to: 'STATE-EXPORT-COUNT-END', disposition: 'transition', reason: '完成', effects: '返回计数', rules: [], source: 'user:REQ-EXPORT-COUNT', 'depends-on': ['REQ-EXPORT-COUNT'] }]
  const running = renderElaboration(snapshot, stateful, 'input').changes[0].source
  const parsed = parseContract({ nodeId: 'export-contract', path, source: running })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.items.filter(item => ['STATE', 'EVENT', 'TR'].includes(item.kind)).length, 4)
  assert.ok(!running.includes('N/A：此能力无状态'))
  assert.ok(running.includes('记录对象有运行中和结束状态'))
  const back = patch()
  back.changes[0].prose = node.prose
  back.changes[0].removeIds = parsed.contract!.items.filter(item => ['STATE', 'EVENT', 'TR'].includes(item.kind)).map(item => item.id)
  const settled = renderElaboration({ ...input, targets: [{ ...input.targets[0], source: running, sourceDigest: elaborationDigest(running) }] }, back, 'input').changes[0].source
  assert.equal(parseContract({ nodeId: 'export-contract', path, source: settled }).contract!.items.length, 1)
  assert.ok(settled.includes(node.prose))
  assert.ok(!/^### (STATE|EVENT|TR)$/m.test(settled))
})

test('raw中的完整契约示例不被正文差量替换，空sync-v1空差量仍逐字保留', () => {
  const raw = `${baseline.rawSource}\n\n示例：\n\`\`\`markdown\n${baseline.expandedSpec}\n\`\`\``
  const copied = source.replace(baseline.rawSource, raw)
  const output = patch()
  output.changes[0].tables.RULE.push({ id: 'RULE-EXPORT-DELTA', scope: '导出', constraint: '新行', basis: '冻结原意', authority: 'export-contract', source: 'user:REQ-EXPORT-01', 'depends-on': ['REQ-EXPORT-01'] })
  const result = renderElaboration({ ...input, intent: { ...input.intent, rawSource: raw }, targets: [{ ...input.targets[0], source: copied, sourceDigest: elaborationDigest(copied) }] }, output, 'input')
  assert.equal(parseParts(result.changes[0].source)!.rawSource, raw)
  assert.ok(result.changes[0].source.includes(raw))
  assert.ok(parseContract({ nodeId: 'export-contract', path, source: result.changes[0].source }).contract!.items.some(item => item.id === 'RULE-EXPORT-DELTA'))
  const blank = source.slice(0, source.indexOf(baseline.expandedSpec))
  const snapshot = { ...input, targets: [{ ...input.targets[0], source: blank, sourceDigest: elaborationDigest(blank) }] }
  assert.equal(renderElaboration(snapshot, patch(), 'input').changes[0].source, blank)
})

test('冻结表头列顺序由现parser定义，null正文的新增替换行不与旧列错位', () => {
  const requirement = baseline.items.find(item => item.kind === 'REQ')!
  assert.equal(requirement.kind, 'REQ')
  const oldRow = source.match(/^\| REQ-EXPORT-01 .*$/m)![0]
  const reordered = source.replace('| id | goal | source |', '| id | source | goal |').replace(oldRow, oldRow.replace(`| ${requirement.goal} | user:raw |`, `| user:raw | ${requirement.goal} |`))
  assert.deepEqual(parseContract({ nodeId: 'export-contract', path, source: reordered }).findings, [])
  const output = patch()
  output.changes[0].tables.REQ = [
    { id: requirement.id, goal: '替换后的业务目标', source: 'user:raw', constraints: requirement.constraints, success: requirement.success, 'depends-on': requirement.dependsOn },
    { id: 'REQ-EXPORT-DELTA', goal: '新增业务目标', source: 'user:raw', constraints: '-', success: '正确新增', 'depends-on': [] },
  ]
  const rendered = renderElaboration({ ...input, targets: [{ ...input.targets[0], source: reordered, sourceDigest: elaborationDigest(reordered) }] }, output, 'input').changes[0].source
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.items.find(item => item.id === requirement.id && item.kind === 'REQ')?.kind, 'REQ')
  assert.ok(rendered.includes('| id | source | goal |'))
  assert.ok(rendered.includes('| REQ-EXPORT-01 | user:raw | 替换后的业务目标 |'))
  assert.ok(rendered.includes('| REQ-EXPORT-DELTA | user:raw | 新增业务目标 |'))
})


test('显式prose替换新canonical表头时继承旧非canonical列序行仍按字段保义务', () => {
  const requirement = baseline.items.find(item => item.kind === 'REQ')!
  assert.equal(requirement.kind, 'REQ')
  const oldRow = source.match(/^\| REQ-EXPORT-01 .*$/m)![0]
  const reordered = source.replace('| id | goal | source |', '| id | source | goal |').replace(oldRow, oldRow.replace(`| ${requirement.goal} | user:raw |`, `| user:raw | ${requirement.goal} |`))
  const output = patch()
  output.changes[0].prose = '显式更新的业务说明。'
  const rendered = renderElaboration({ ...input, targets: [{ ...input.targets[0], source: reordered, sourceDigest: elaborationDigest(reordered) }] }, output, 'input').changes[0].source
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered })
  assert.deepEqual(parsed.findings, [])
  for (const item of baseline.items) assert.deepEqual(parsed.contract!.items.find(next => next.id === item.id), { ...item, line: parsed.contract!.items.find(next => next.id === item.id)!.line })
  assert.ok(rendered.includes('| id | goal | source |'))
  assert.ok(rendered.includes('显式更新的业务说明。'))
})
