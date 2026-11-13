import assert from 'node:assert/strict'
import test from 'node:test'
import type { Extractor } from '@spexcode/spec-core'
import { buildContractGraph, type Contract } from '@spexcode/spec-core/contracts'
import { findWholeFileSourcePaths, isReadonlyCitationFailure, validateFrozenAnchors } from './frozen-anchors.js'

function contract(code: string[], related: string[] = [], source = 'src/export.ts#Exporter.run'): Contract {
  return { schema: 'sync-v1', nodeId: 'export', path: '.spec/export/spec.md', rawSource: '导出数据', expandedSpec: '', code, related,
    items: [{ kind: 'RULE', id: 'RULE-EXPORT-01', nodeId: 'export', path: '.spec/export/spec.md', line: 12, source: { kind: 'code', ref: source }, dependsOn: [], scope: '导出', constraint: '导出结果', basis: '实现表示', authority: 'export' }] }
}

test('V1解析冻结的TS/Python、related和代码来源，不要求宿主存在对应文件', async () => {
  const graph = buildContractGraph([contract(['src/export.ts#Exporter.run'], ['src/worker.py#execute', 'src/export.ts#Task'])])
  const result = await validateFrozenAnchors(graph, new Map([
    ['src/export.ts', 'export type Task = { id: string }; export class Exporter { run() { return 1 } }'],
    ['src/worker.py', 'def execute():\n    return 1\n'],
  ]))
  assert.deepEqual(result.findings.map(x => [x.code, x.severity]), [['anchor-type-only', 'warning']])
  assert.equal(result.anchors.length, 4)
  assert.ok(result.anchors.every(x => x.unit))
  assert.equal(result.anchors.find(x => x.origin === 'source')!.itemId, 'RULE-EXPORT-01')
})

test('V1精确引用JS族本地默认导出声明及其源码范围', async () => {
  const path = 'src/config.ts', ref = `${path}#default`
  const source = 'const target = "local"\nexport default defineConfig({\n  test: { environment: "jsdom" },\n  build: { manualChunks(id: string) { return id } },\n  target,\n})\n'
  const files = new Map([[path, source]])
  const graph = buildContractGraph([contract([ref], [], ref)])
  const valid = await validateFrozenAnchors(graph, files)
  assert.deepEqual(valid.findings, [])
  assert.deepEqual(valid.anchors.map(anchor => anchor.unit), [
    { name: 'default', kind: 'export-default', start: 2, end: 6 },
    { name: 'default', kind: 'export-default', start: 2, end: 6 },
  ])
  const dead = await validateFrozenAnchors(buildContractGraph([contract([], [], `${path}#manualChunks`)]), files)
  assert.equal(dead.findings[0].code, 'anchor-dead')
  assert.match(dead.findings[0].message, /#default/)
  const onlyDefault = new Map([[path, source.slice(source.indexOf('\n') + 1)]])
  assert.deepEqual(await findWholeFileSourcePaths(onlyDefault, [path]), [])
})

test('V1文件级来源保留精确路径和空选择器，不改变裸治理及相关路径的语义', async () => {
  const files = new Map([['src/export.ts', 'export const value = 1'], ['src/related.py', 'def run(): pass\n'], ['src/docs.py', '"""说明。"""\n']])
  const graph = buildContractGraph([contract(['src/export.ts'], ['src/related.py'], 'src/docs.py')])
  const result = await validateFrozenAnchors(graph, files)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.anchors, [{ nodeId: 'export', path: 'src/docs.py', declarationPath: '.spec/export/spec.md',
    line: 12, itemId: 'RULE-EXPORT-01', origin: 'source', selector: null, unit: null }])
  const requiresSelector = await validateFrozenAnchors(buildContractGraph([contract([], [], 'src/export.ts')]), files)
  assert.equal(requiresSelector.findings[0].code, 'anchor-selector-required')
  assert.deepEqual(requiresSelector.findings[0].citation, { origin: 'source', ref: 'src/export.ts' })
  assert.ok(isReadonlyCitationFailure(requiresSelector.findings[0]))
})

test('文件级候选只返回解析成功且零命名声明的精确冻结路径', async () => {
  const files = new Map([
    ['src/z.py', '# comment\n'],
    ['src/a.py', ''],
    ['src/unoffered.py', ''],
    ['src/named.py', 'value = 1\n'],
    ['src/broken.py', 'def broken(\n'],
    ['src/unknown.zzz', ''],
  ])
  const paths = ['src/z.py', 'src/named.py', 'src', 'src/missing.py', 'src/z.py', 'src/broken.py', 'src/unknown.zzz', 'src/a.py', 'src/A.py']
  assert.deepEqual(await findWholeFileSourcePaths(files, paths), ['src/a.py', 'src/z.py'])
})

test('V1分别拒绝实际候选中的改名、歧义和语法错误', async () => {
  for (const [source, code] of [
    ['export function renamed() {}', 'anchor-dead'],
    ['function run() {}\nfunction run() {}', 'anchor-ambiguous'],
    ['export function run( {', 'anchor-parse-error'],
  ]) {
    const graph = buildContractGraph([contract(['src/export.ts#run'], [], 'src/export.ts#run')])
    const result = await validateFrozenAnchors(graph, new Map([['src/export.ts', source]]))
    assert.equal(result.findings[0].code, code)
    assert.ok(result.anchors.every(x => x.unit === null))
  }
})

test('限定名建议保留原锚点失败并绑定具体关系与行', async () => {
  const ref = 'src/export.ts#run'
  const graph = buildContractGraph([contract([ref], [], ref)])
  const result = await validateFrozenAnchors(graph, new Map([['src/export.ts', 'export class Exporter { run() {} }']]))
  assert.deepEqual(result.findings.map(issue => [issue.code, issue.citation, issue.itemId]), [
    ['anchor-dead', { origin: 'code', ref }, undefined],
    ['anchor-dead', { origin: 'source', ref }, 'RULE-EXPORT-01'],
  ])
  assert.ok(result.findings.every(issue => isReadonlyCitationFailure(issue) && issue.message.includes('Exporter.run')))
  assert.ok(result.anchors.every(anchor => anchor.unit === null))
})

test('V1缺失related/source文件、未知语言与不可用解析器不能静默跳过', async () => {
  const graph = buildContractGraph([contract(['src/unknown.zzz#run'], ['src/missing.ts#other'], 'src/absent.ts#run')])
  const result = await validateFrozenAnchors(graph, new Map([['src/unknown.zzz', 'run']]))
  assert.deepEqual(result.findings.map(x => x.code), ['anchor-language-unsupported', 'anchor-file-missing', 'anchor-file-missing'])
  const unavailable: Extractor = { id: 'unavailable', claims: () => true, ready: () => '缺少语法包', extract: () => { throw new Error('不可执行回退') }, memoKey: path => path }
  const blocked = await validateFrozenAnchors(buildContractGraph([contract(['src/export.ts#run'], [], 'src/export.ts#run')]), new Map([['src/export.ts', 'run']]), [unavailable])
  assert.ok(blocked.findings.every(x => x.code === 'anchor-extractor-unavailable'))
  assert.deepEqual(await findWholeFileSourcePaths(new Map([['src/export.ts', '']]), ['src/export.ts'], [unavailable]), [])
})

test('V1在异步解析前固定输入，多个锚点共享同一冻结文件解析', async () => {
  const files = new Map([['src/export.ts', 'original']])
  let calls = 0
  const extractor: Extractor = { id: 'immutable-fixture', claims: () => true, ready: async () => { files.set('src/export.ts', 'changed'); return true as const },
    extract: source => { calls++; assert.equal(source, 'original'); return [{ name: 'run', kind: 'function', start: 1, end: 1 }] }, memoKey: path => `immutable-fixture:${path}` }
  const result = await validateFrozenAnchors(buildContractGraph([contract(['src/export.ts#run'], ['src/export.ts#run'], 'src/export.ts#run')]), files, [extractor])
  assert.deepEqual(result.findings, [])
  assert.equal(calls, 1)
  assert.equal(result.anchors.length, 3)
})
