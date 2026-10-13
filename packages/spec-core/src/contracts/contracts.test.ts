import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseFrontmatter, parseParts } from '../spec-source.js'
import { buildContractGraph, contractDigest, contractImpact, parseContract, projectContractCoverage, validateContractGraph } from './index.js'
import type { Contract, ContractFinding, ContractKind } from './types.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../..', 'spec-cli/test/fixtures/spec-sync/export-repo')
const specPath = '.spec/export/export-contract/spec.md'
const baseline = readFileSync(resolve(fixtureRoot, specPath), 'utf8')
const files = new Map(['src/export.js', 'tests/export.test.mjs'].map((path) => [path, readFileSync(resolve(fixtureRoot, path), 'utf8')]))
const parse = (source = baseline, nodeId = 'export-contract'): Contract => {
  const result = parseContract({ nodeId, path: specPath, source })
  assert.deepEqual(result.findings, [])
  assert.ok(result.contract)
  return result.contract
}
const errors = (findings: ContractFinding[]): ContractFinding[] => findings.filter((finding) => finding.severity === 'error')
const variant = (name: string): { source: string; files: Map<string, string> } => {
  const root = mkdtempSync(resolve(tmpdir(), 'contract-fixture-'))
  try {
    cpSync(fixtureRoot, root, { recursive: true })
    execFileSync('git', ['-C', root, 'apply', resolve(fixtureRoot, '../variants', `${name}.patch`)])
    return { source: readFileSync(resolve(root, specPath), 'utf8'), files: new Map([...files.keys()].map((path) => [path, readFileSync(resolve(root, path), 'utf8')])) }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const without = (source: string, kind: ContractKind): string => source.replace(new RegExp(`^### ${kind}\\n[\\s\\S]*?(?=^### |$(?![\\s\\S]))`, 'm'), '')

test('完整真实夹具解析、30格状态事件矩阵和argv绑定，无运行通过投影', () => {
  const contract = parse()
  const graph = buildContractGraph([contract])
  assert.deepEqual(errors(validateContractGraph(graph, { files })), [])
  assert.ok(validateContractGraph(graph, { files }).some((finding) => finding.code === 'semantic-review-required'))
  const coverage = projectContractCoverage(graph)
  assert.equal(coverage.matrix.length, 30)
  assert.ok(coverage.matrix.every((cell) => cell.status === 'bound'))
  assert.ok(coverage.items.every((item) => item.status === 'declared' || item.status === 'bound'))
  const verify = contract.items.find((item) => item.kind === 'VERIFY')!
  assert.equal(verify.kind, 'VERIFY')
  if (verify.kind === 'VERIFY') assert.deepEqual(verify.command, ['node', '--test', 'tests/export.test.mjs'])
})

test('缺失取消完成分支拒绝；有其他TR不能冒充完整处置', () => {
  const changed = variant('missing-branch')
  const graph = buildContractGraph([parse(changed.source)])
  assert.ok(errors(validateContractGraph(graph, { files })).some((finding) => finding.code === 'missing-event-disposition' && finding.itemId === 'STATE-EXPORT-CANCELLED' && finding.relatedIds?.includes('EVENT-EXPORT-COMPLETE')))
  assert.equal(projectContractCoverage(graph).matrix.filter((cell) => cell.status === 'missing').length, 1)
})

test('未知重试政策只扩散依赖闭包，成功流程保持独立', () => {
  const graph = buildContractGraph([parse(variant('missing-policy').source)])
  const coverage = projectContractCoverage(graph)
  assert.equal(coverage.gaps.length, 1)
  assert.ok(coverage.gaps[0].affectedIds.includes('FLOW-EXPORT-02'))
  assert.ok(coverage.gaps[0].affectedIds.includes('STEP-EXPORT-05'))
  assert.ok(!coverage.gaps[0].affectedIds.includes('FLOW-EXPORT-01'))
  assert.ok(!coverage.gaps[0].affectedIds.includes('STEP-EXPORT-03'))
  const gap = validateContractGraph(graph, { files }).find((finding) => finding.code === 'unresolved-gap')!
  assert.equal(gap.severity, 'error')
  assert.ok(gap.relatedIds?.includes('AC-EXPORT-08'))
})

test('下载权限冲突留给真实运行和语义层，结构检查不伪检测', () => {
  const changed = variant('conflicting-download')
  assert.deepEqual(errors(validateContractGraph(buildContractGraph([parse(changed.source)]), { files: changed.files })), [])
  assert.notEqual(changed.files.get('src/export.js'), files.get('src/export.js'))
})

test('raw及REQ-only可细化，final另报incomplete，未启用节点不创建契约', () => {
  const raw = '---\ncontract-schema: sync-v1\n---\n## raw source\n支持计算\n'
  const contract = parse(raw)
  assert.equal(contract.rawSource, '支持计算')
  assert.deepEqual(validateContractGraph(buildContractGraph([contract]), { mode: 'draft' }), [])
  assert.ok(validateContractGraph(buildContractGraph([contract])).some((finding) => finding.code === 'incomplete-contract'))
  const reqOnly = baseline.slice(0, baseline.indexOf('### RULE'))
  assert.equal(parse(reqOnly).items.length, 1)
  assert.deepEqual(parseContract({ nodeId: 'legacy', path: 'spec.md', source: '# legacy' }), { contract: null, findings: [] })
})

test('围栏、转义pipe、code spans、CRLF共享纯正文解析，行号定位真实源', () => {
  const source = baseline.replace('### REQ', '~~~~markdown\n### REQ\n| bogus |\n```\n~~~~\n\n### REQ').replace('遵守显式演示政策', '文本\\|值和 ``a|b``').replace(/\n/g, '\r\n')
  const contract = parse(source)
  const req = contract.items.find((item) => item.kind === 'REQ')!
  if (req.kind === 'REQ') assert.equal(req.constraints, '文本|值和 ``a|b``')
  assert.equal(parseFrontmatter(source).fm['contract-schema'], 'sync-v1')
  assert.ok(parseParts(parseFrontmatter(source).body)?.rawSource.includes('用户可以'))
  assert.equal(source.split('\r\n')[req.line - 1].split('|')[1].trim(), req.id)
})

test('列数、来源、bool、argv、仓库路径、空表和多文件治理快速拒绝', () => {
  for (const [source, code] of [
    [baseline.replace('| id | goal |', '| id | nope |'), 'table-header'],
    [baseline.replace('user:raw', 'invented:raw'), 'invalid-source'],
    [baseline.replace('| true | false |', '| yes | false |'), 'invalid-boolean'],
    [baseline.replace('["node","--test","tests/export.test.mjs"]', 'node --test tests/export.test.mjs'), 'invalid-command'],
    [baseline.replace('["node","--test","tests/export.test.mjs"]', '["sh","-c","node --test tests/export.test.mjs"]'), 'shell-command'],
    [baseline.replace('tests/export.test.mjs#AC-EXPORT-01', '../tests/export.test.mjs#AC-EXPORT-01'), 'invalid-test-binding'],
    [baseline.replace('  - src/export.js#ExportService', '  - src/export.js#ExportService\n  - src/other.js#Other'), 'multiple-governed-files'],
    [baseline.replace(/^\| VERIFY-EXPORT-01 .*\n/m, ''), 'empty-table'],
  ]) {
    const result = parseContract({ nodeId: 'export-contract', path: specPath, source })
    assert.equal(result.contract, null, code)
    assert.ok(result.findings.some((finding) => finding.code === code), code)
  }
})

test('ID全局唯一、引用类型/归属、依赖循环；正常失败重试业务循环合法', () => {
  const contract = parse()
  assert.ok(buildContractGraph([contract, { ...contract, nodeId: 'copy', path: 'copy/spec.md' }]).findings.some((finding) => finding.code === 'duplicate-id'))
  const wrongType = parse(baseline.replace('| REQ-EXPORT-01 | 所有者,worker |', '| RULE-EXPORT-01 | 所有者,worker |'))
  assert.ok(validateContractGraph(buildContractGraph([wrongType])).some((finding) => finding.code === 'reference-kind'))
  const cycle = structuredClone(contract)
  const req = cycle.items.find((item) => item.kind === 'REQ')!
  if (req.kind === 'REQ') req.dependsOn = ['RULE-EXPORT-01']
  assert.ok(validateContractGraph(buildContractGraph([cycle])).some((finding) => finding.code === 'dependency-cycle'))
  assert.ok(!validateContractGraph(buildContractGraph([contract])).some((finding) => finding.code === 'dependency-cycle'))
  const bad = parse(baseline.replace('| export-contract | decision:', '| other-node | decision:'))
  assert.ok(validateContractGraph(buildContractGraph([bad])).some((finding) => finding.code === 'rule-authority'))
})

 test('无文件context明确未验证；真实测试标题/argv/治理文件必须匹配', () => {
  const graph = buildContractGraph([parse()])
  assert.ok(validateContractGraph(graph).some((finding) => finding.code === 'bindings-unverified'))
  const missing = new Map(files)
  missing.delete('tests/export.test.mjs')
  assert.ok(validateContractGraph(graph, { files: missing }).some((finding) => finding.code === 'missing-test-file'))
  const fake = new Map(files)
  for (const source of ["// test('AC-EXPORT-01 注释', () => {})", "/* test('AC-EXPORT-01 注释', () => {}) */", 'const text = "test(\'AC-EXPORT-01 示例\', () => {})"', "test('AC-EXPORT-01-OTHER 不同稳定ID', () => {})"]) {
    fake.set('tests/export.test.mjs', source)
    assert.ok(validateContractGraph(graph, { files: fake }).some((finding) => finding.code === 'missing-test-case' && finding.itemId === 'AC-EXPORT-01'))
  }
  fake.set('tests/export.test.mjs', 'test("AC-EXPORT-01 owner\'s result", () => {})')
  assert.ok(!validateContractGraph(graph, { files: fake }).some((finding) => finding.code === 'missing-test-case' && finding.itemId === 'AC-EXPORT-01'))
  const command = parse(baseline.replace('["node","--test","tests/export.test.mjs"]', '["node","--test","tests/other.mjs"]'))
  assert.ok(validateContractGraph(buildContractGraph([command]), { files }).some((finding) => finding.code === 'verification-selection-unverified' && finding.severity === 'warning'))
  const unrelated = parse(baseline.replace('code:', 'related:'))
  assert.ok(validateContractGraph(buildContractGraph([unrelated]), { files }).some((finding) => finding.code === 'missing-implementation'))
})

 test('输入不变、摘要确定性与影响包含裸代码/测试路径及共享文件治理', () => {
  const contract = parse()
  const before = JSON.stringify(contract)
  const graph = buildContractGraph([contract])
  projectContractCoverage(graph); validateContractGraph(graph, { files })
  const impact = contractImpact(graph, ['RULE-EXPORT-06'])
  assert.deepEqual(impact.codePaths, ['src/export.js'])
  assert.deepEqual(impact.testPaths, ['tests/export.test.mjs'])
  assert.ok(impact.itemIds.includes('FLOW-EXPORT-02'))
  assert.equal(JSON.stringify(contract), before)
  const other = { ...parse('---\ncontract-schema: sync-v1\ncode: src/export.js#Other\n---\n## raw source\n其他职责\n', 'other'), path: 'other/spec.md' }
  const shared = contractImpact(buildContractGraph([contract, other]), ['RULE-EXPORT-06'])
  assert.ok(shared.nodeIds.includes('other'))
  assert.equal(contractDigest([contract, other]), contractDigest([other, contract]))
  assert.match(contractDigest([contract]), /^[a-f0-9]{64}$/)
  const changed = structuredClone(contract)
  changed.rawSource += '修改业务事实'
  assert.notEqual(contractDigest([changed]), contractDigest([contract]))
})

 test('高层REQ无需治理文件，通过跨节点依赖、规则及AC绑定叶实现', () => {
  const contract = parse()
  const req = contract.items.find((item) => item.kind === 'REQ')!
  const parent: Contract = { ...contract, nodeId: 'parent', path: '.spec/export/spec.md', code: [], items: [{ ...req, nodeId: 'parent', path: '.spec/export/spec.md' }] }
  const leaf: Contract = { ...contract, items: contract.items.filter((item) => item.kind !== 'REQ') }
  const graph = buildContractGraph([parent, leaf])
  assert.deepEqual(errors(validateContractGraph(graph, { files })), [])
  const row = projectContractCoverage(graph).items.find((item) => item.id === req.id)!
  assert.equal(row.status, 'bound')
  assert.deepEqual(row.code, ['src/export.js#ExportService'])
  assert.ok(row.acceptanceIds.length > 0)
})

test('REQ、实现及验收各自归属节点时，推导关系仍绑定叶实现', () => {
  const contract = parse()
  const req = contract.items.find((item) => item.kind === 'REQ')!
  const parent: Contract = { ...contract, nodeId: 'parent', path: 'parent/spec.md', code: [],
    items: [{ ...req, nodeId: 'parent', path: 'parent/spec.md' }] }
  const leaf: Contract = { ...contract, items: contract.items.filter((item) => !['REQ', 'AC', 'VERIFY'].includes(item.kind)) }
  const acceptance: Contract = { ...contract, nodeId: 'acceptance', path: 'acceptance/spec.md', code: [],
    items: contract.items.filter((item) => ['AC', 'VERIFY'].includes(item.kind)).map((item) => ({ ...item, nodeId: 'acceptance', path: 'acceptance/spec.md' })) }
  const unrelated: Contract = { ...contract, nodeId: 'unrelated', path: 'unrelated/spec.md', code: ['src/unrelated.js'],
    items: [{ ...req, id: 'REQ-OTHER-01', nodeId: 'unrelated', path: 'unrelated/spec.md' }] }
  const graph = buildContractGraph([parent, leaf, acceptance, unrelated])
  const row = projectContractCoverage(graph).items.find((item) => item.id === req.id)!
  assert.equal(row.status, 'bound')
  assert.deepEqual(row.code, ['src/export.js#ExportService'])
  assert.ok(!validateContractGraph(graph, { files }).some((finding) => finding.itemId === req.id && finding.code === 'missing-implementation'))
  assert.deepEqual(errors(validateContractGraph(buildContractGraph([parent, leaf, acceptance]), { files })), [])
})

test('AC可覆盖全部业务项，VERIFY仍不能冒充业务覆盖', () => {
  const contract = parse()
  const ac = contract.items.find((item) => item.kind === 'AC')!
  if (ac.kind !== 'AC') throw new Error('夹具缺少 AC')
  for (const kind of ['FLOW', 'STEP', 'STATE', 'EVENT'] as const) {
    const covered = contract.items.find((item) => item.kind === kind)!
    ac.covers.push(covered.id)
    const graph = buildContractGraph([contract])
    assert.deepEqual(errors(validateContractGraph(graph, { files })), [])
    assert.ok(projectContractCoverage(graph).items.find((item) => item.id === covered.id)!.acceptanceIds.includes(ac.id))
  }
  ac.covers.push('VERIFY-EXPORT-01')
  assert.ok(validateContractGraph(buildContractGraph([contract]), { files }).some((finding) => finding.code === 'reference-kind' && finding.itemId === ac.id))
})

test('真实Node测试导入别名保留静态标题，注释和字符串不能声明别名', () => {
  const graph = buildContractGraph([parse()])
  const fake = new Map(files)
  for (const source of [
    "import { test as check } from 'node:test'; check('AC-EXPORT-01 创建并完成', () => {});",
    "import { it as check } from 'node:test'; check('AC-EXPORT-01 创建并完成', () => {});",
    "import check from 'node:test'; check('AC-EXPORT-01 创建并完成', () => {});",
    "check('AC-EXPORT-01 创建并完成', () => {}); import { test as check } from 'node:test';",
  ]) {
    fake.set('tests/export.test.mjs', source)
    assert.ok(!validateContractGraph(graph, { files: fake }).some((finding) => finding.code === 'missing-test-case' && finding.itemId === 'AC-EXPORT-01'))
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    })
    assert.match(output, /ok 1 - AC-EXPORT-01 创建并完成/)
  }
  for (const source of [
    "// import { test as check } from 'node:test';\ncheck('AC-EXPORT-01 注释', () => {});",
    "/* import { test as check } from 'node:test'; */ check('AC-EXPORT-01 注释', () => {});",
    'const example = "import { test as check } from \'node:test\';"; check("AC-EXPORT-01 示例", () => {});',
    "import { test as check } from 'unrelated-library'; check('AC-EXPORT-01 非测试API', () => {});",
    "import { test as check } from 'node:test'; check('AC-EXPORT-01-OTHER 其他ID', () => {});",
  ]) {
    fake.set('tests/export.test.mjs', source)
    assert.ok(validateContractGraph(graph, { files: fake }).some((finding) => finding.code === 'missing-test-case' && finding.itemId === 'AC-EXPORT-01'))
  }
})

 test('非终态无出口、不可达状态、跨对象事件和未解释无状态分支被拒绝', () => {
  const contract = parse()
  const changed = structuredClone(contract)
  const state = changed.items.find((item) => item.id === 'STATE-EXPORT-CANCELLED')!
  if (state.kind === 'STATE') { state.terminal = false; state.object = 'other-object' }
  const findings = validateContractGraph(buildContractGraph([changed]), { files })
  assert.ok(findings.some((finding) => finding.code === 'transition-object'))
  assert.ok(findings.some((finding) => finding.code === 'nonterminal-no-exit'))
  assert.ok(findings.some((finding) => finding.code === 'unreachable-state'))
  const noState = parse(without(without(without(baseline, 'STATE'), 'EVENT'), 'TR'))
  for (const item of noState.items) if (item.kind === 'FLOW') item.terminal = 'END'
  assert.ok(validateContractGraph(buildContractGraph([noState]), { files }).some((finding) => finding.code === 'missing-stateless-rationale'))
})

 test('无状态完整计算契约保留输入、失败规则、结束结果及AC', () => {
  const source = `---
contract-schema: sync-v1
code: src/math.js#compute
---
## raw source
计算正整数翻倍，非法输入拒绝。
## expanded spec
无状态纯计算，持久状态不适用。
### REQ
| id | goal | source | constraints | success | depends-on |
|---|---|---|---|---|---|
| REQ-MATH-01 | 翻倍 | user:raw | 正整数 | 返回两倍 | - |
### RULE
| id | scope | constraint | basis | authority | source | depends-on |
|---|---|---|---|---|---|---|
| RULE-MATH-01 | 输入与结果 | 正整数翻倍，其余拒绝 | 用户输入 | math | user:REQ-MATH-01 | REQ-MATH-01 |
### FLOW
| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| FLOW-MATH-01 | REQ-MATH-01 | 调用者 | 计算调用 | - | STEP-MATH-01 | END | derived:REQ-MATH-01 | REQ-MATH-01 |
### STEP
| id | flow | action | input | output | rules | next | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| STEP-MATH-01 | FLOW-MATH-01 | 校验并翻倍 | 正整数或非法值 | 两倍或拒绝错误 | RULE-MATH-01 | END | derived:FLOW-MATH-01 | RULE-MATH-01 |
### AC
| id | covers | preconditions | action | assertion | test | command | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| AC-MATH-01 | REQ-MATH-01,RULE-MATH-01 | - | 输入正数、零和负数 | 正数返回两倍，其余拒绝 | tests/math.test.js#AC-MATH-01 | VERIFY-MATH-01 | derived:REQ-MATH-01 | RULE-MATH-01 |
### VERIFY
| id | command | cwd | timeout-ms |
|---|---|---|---|
| VERIFY-MATH-01 | ["node","--test","tests/math.test.js"] | . | 1000 |
`
  const graph = buildContractGraph([parse(source, 'math')])
  assert.deepEqual(errors(validateContractGraph(graph, { files: new Map([['src/math.js', 'export const compute = n => n * 2'], ['tests/math.test.js', "test('AC-MATH-01 正数、非法输入', () => {})"]]) })), [])
  assert.deepEqual(projectContractCoverage(graph).matrix, [])
})

test('纯契约入口可以从无Git仓库目录导入，不触发fs/git/root初始化', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'contract-pure-'))
  try {
    const entry = new URL('./index.js', import.meta.url).href
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const api = await import(${JSON.stringify(entry)}); console.log(api.parseContract({nodeId:'x',path:'spec.md',source:'# plain'}).contract)`], { cwd: root, encoding: 'utf8' })
    assert.equal(output.trim(), 'null')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
