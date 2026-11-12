import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import type { FrozenContracts, GenerationContractPolicy } from './frozen-contracts.js'

const fixture = resolve('spec-cli/test/fixtures/spec-sync/export-repo')
const spec = '.spec/export/export-contract/spec.md'
const source = readFileSync(resolve(fixture, spec), 'utf8')
const inputs = (): Map<string, string> => new Map([spec, 'src/export.js', 'tests/export.test.mjs'].map(path => [path, readFileSync(resolve(fixture, path), 'utf8')]))
const policy = (state: FrozenContracts): GenerationContractPolicy => ({ newNodeRawSources: new Map(), verifications: state.contracts.flatMap(contract => contract.items.filter(item => item.kind === 'VERIFY')) })

test('完整候选路径清单让V1拒绝不存在的related身份，保留真实未读取文件和目录', async () => {
  const files = inputs()
  const invalid = ['export-contract', 'REQ-EXPORT-01', 'FLOW-EXPORT-01', 'RULE-EXPORT-01', 'VERIFY-EXPORT-01']
  files.set(spec, source.replace('code:\n', `related:\n${invalid.map(value => `  - ${value}`).join('\n')}\ncode:\n`))
  const paths = new Set([...files.keys(), 'docs/reference.png'])
  const inventory = new Set(paths), pending = readFrozenContracts('/frozen', files, inventory)
  for (const value of invalid) inventory.add(value)
  const rejected = await pending
  assert.deepEqual(rejected.findings.filter(finding => finding.code === 'related-file-missing').map(finding => finding.citation), invalid.map(ref => ({ origin: 'related', ref })))
  files.set(spec, source.replace('code:\n', 'related:\n  - docs/reference.png\n  - docs/\ncode:\n'))
  const accepted = await readFrozenContracts('/frozen', files, paths)
  assert.deepEqual(accepted.findings.filter(finding => finding.code === 'integrity' || finding.code === 'related-file-missing'), [])
})

test('冻结输入在不存在的宿主目录仍重建真实契约、源码锚点与验收', async () => {
  const files = inputs()
  const promise = readFrozenContracts('/no-such-frozen-input', files)
  files.set(spec, 'invalid live text')
  files.delete('src/export.js')
  const state = await promise
  assert.equal(state.contracts.length, 1)
  assert.equal(state.coverage.matrix.length, 30)
  assert.deepEqual(state.findings.filter(finding => finding.severity === 'error'), [])
  assert.deepEqual(checkGenerationContractIntent(state, state, policy(state)), [])
})

test('实例插件契约不进入业务图，plugin-system产品规格及普通业务义务保留', async () => {
  const files = inputs()
  files.set('.spec/export/.plugins/spec.md', '---\ntitle: 插件实例\n---\n## raw source\n工具配置。\n')
  files.set('.spec/export/.plugins/instance-contract/spec.md', source.replaceAll('EXPORT', 'INSTANCE'))
  files.set('.spec/export/plugin-system/spec.md', source.replaceAll('EXPORT', 'SYSTEM'))
  const frozen = await readFrozenContracts('/frozen', files)
  assert.deepEqual(frozen.nodes.map(node => node.id).sort(), ['export-contract', 'plugin-system'])
  assert.ok(![...frozen.graph.items.keys()].some(id => id.includes('INSTANCE')))
  assert.ok(frozen.graph.items.has('REQ-SYSTEM-01'))
  assert.ok(frozen.graph.items.has('REQ-EXPORT-01'))
})

test('缺席和空raw统一冻结为null，既有rawless节点不误报生成意图变化', async () => {
  const childPath = '.spec/export/full-tree-verification/spec.md'
  for (const body of ['# 旧正文\n完整保留。\n', '## expanded spec\n完整保留。\n', '## raw source\n\n## expanded spec\n完整保留。\n']) {
    const files = inputs()
    files.set(childPath, `---\ntitle: 全树验证\n---\n${body}`)
    const state = await readFrozenContracts('/frozen', files)
    assert.equal(state.nodes.find(node => node.path === childPath)!.rawSource, null)
    assert.deepEqual(checkGenerationContractIntent(state, state, policy(state)), [])
  }
})

test('删除schema/AC、弱化断言、改raw/命令不能让生成候选免检', async () => {
  const before = await readFrozenContracts('/frozen', inputs())
  const ac = before.contracts[0].items.find(item => item.kind === 'AC')!
  assert.equal(ac.kind, 'AC')
  const raw = before.contracts[0].rawSource
  const variants = [
    [source.replace('contract-schema: sync-v1', ''), 'generation-schema-removed'],
    [source.replace(new RegExp(`^\\| ${ac.id} .*\\n`, 'm'), ''), 'generation-protected-item-removed'],
    [source.replace(ac.assertion, '只需函数不抛错'), 'generation-protected-meaning-changed'],
    [source.replace(raw, '模型自造的新需求'), 'generation-raw-changed'],
    [source.replace('["node","--test","tests/export.test.mjs"]', '["node","--test","tests/empty.test.mjs"]'), 'generation-protected-meaning-changed'],
  ]
  for (const [text, expected] of variants) {
    const files = inputs(); files.set(spec, text)
    const after = await readFrozenContracts('/frozen', files)
    assert.ok(checkGenerationContractIntent(before, after, policy(before)).some(finding => finding.code === expected), expected)
  }
})

test('仅实际测试定位可补齐，验证登记的字节不能被候选决定', async () => {
  const before = await readFrozenContracts('/frozen', inputs())
  const after = await readFrozenContracts('/frozen', inputs())
  const ac = after.contracts[0].items.find(item => item.kind === 'AC')!
  assert.equal(ac.kind, 'AC')
  ac.test = 'tests/new.test.mjs#AC-EXPORT-01'
  assert.deepEqual(checkGenerationContractIntent(before, after, policy(before)), [])
  const rejected = checkGenerationContractIntent(before, after, { newNodeRawSources: new Map(), verifications: [] })
  assert.ok(rejected.some(finding => finding.code === 'generation-verification-unregistered'))
})

test('稳定AC移动到有固定上层原意的新叶节点，不误判为删除验收', async () => {
  const before = await readFrozenContracts('/frozen', inputs())
  const row = source.match(/^\| AC-EXPORT-01 .*$/m)![0]
  const columns = source.match(/^\| id \| covers .*$/m)![0]
  const addedPath = '.spec/export/export-acceptance/spec.md'
  const raw = '实现原始需求见 [[export-contract]]。'
  const files = inputs()
  files.set(spec, source.replace(`${row}\n`, ''))
  files.set(addedPath, `---\ncontract-schema: sync-v1\n---\n## raw source\n${raw}\n## expanded spec\n### AC\n${columns}\n|---|---|---|---|---|---|---|---|---|\n${row}\n`)
  const after = await readFrozenContracts('/frozen', files)
  assert.equal(after.graph.owners.get('AC-EXPORT-01')!.path, addedPath)
  assert.deepEqual(checkGenerationContractIntent(before, after, { ...policy(before), newNodeRawSources: new Map([[addedPath, raw]]) }), [])
  assert.ok(checkGenerationContractIntent(before, after, policy(before)).some(finding => finding.code === 'generation-new-intent'))
})
