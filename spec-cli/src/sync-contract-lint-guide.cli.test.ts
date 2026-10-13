import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT_COLUMNS } from '@spexcode/spec-core/contracts'
import type { SpecLintReport } from './lint.js'

const cli = fileURLToPath(new URL('../../bin/spex.mjs', import.meta.url))
const specPath = '.spec/project/spec.md'
const raw = '---\ncontract-schema: sync-v1\n---\n## raw source\n导出筛选数据。\n## expanded spec\n'
const req = `${raw}### REQ
| id | goal | source | constraints | success | depends-on |
|---|---|---|---|---|---|
| REQ-EXPORT-01 | 导出数据 | user:raw | - | 用户取得结果 | - |
`

function fixture(source: string): { root: string; git(...args: string[]): string; run(...args: string[]): { code: number; stdout: string; stderr: string }; write(path: string, text: string): void } {
  const root = mkdtempSync(join(tmpdir(), 'spex-sync-contract-lint-'))
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const write = (path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text, 'utf8') }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  write(specPath, source)
  write('.spec/spexcode.json', '{"lint":{"governedRoots":[]}}\n')
  git('add', '-A'); git('commit', '-qm', 'fixture')
  return { root, git, write, run: (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } })
    if (result.error) throw result.error
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
  } }
}

test('AC-SYNC-CONTRACT-LINT-01 raw及REQ草稿可以保存，围栏里的表格只是原文', () => {
  for (const source of [raw, req, raw.replace('导出筛选数据。', '导出筛选数据。\n```markdown\n## expanded spec\n### REQ\n| invalid |\n```')]) {
    const repo = fixture(source)
    try {
      const result = repo.run('spec', 'lint', '--json')
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const report = JSON.parse(result.stdout) as SpecLintReport
      assert.ok(!report.findings.some((finding) => finding.level === 'error'))
      assert.ok(!report.findings.some((finding) => finding.rule === 'sync-contract'))
    } finally { rmSync(repo.root, { recursive: true, force: true }) }
  }
})

test('AC-SYNC-CONTRACT-LINT-02 错误表头、ID、悬空引用及未知schema通过真实JSON CLI阻止保存', () => {
  const dangling = `${req}### RULE
| id | scope | constraint | basis | authority | source | depends-on |
|---|---|---|---|---|---|---|
| RULE-EXPORT-01 | 导出 | 只导出筛选数据 | 用户原意 | project | user:REQ-EXPORT-MISSING | REQ-EXPORT-MISSING |
`
  for (const [source, diagnostic] of [
    [req.replace('| goal |', '| bogus |'), 'table-header'],
    [req.replace('REQ-EXPORT-01', 'req-export-01'), 'invalid-id'],
    [dangling, 'dangling-reference'],
    [raw.replace('sync-v1', 'sync-v99'), 'unsupported-schema'],
  ]) {
    const repo = fixture(source)
    try {
      const result = repo.run('spec', 'lint', '--json')
      assert.equal(result.code, 1, result.stderr + result.stdout)
      assert.equal(result.stderr, '')
      const report = JSON.parse(result.stdout) as SpecLintReport
      assert.ok(report.findings.some((finding) => finding.rule === 'sync-contract' && finding.level === 'error' && finding.msg.startsWith(diagnostic + ':')))
    } finally { rmSync(repo.root, { recursive: true, force: true }) }
  }
})

test('AC-SYNC-CONTRACT-LINT-03 跨启用节点引用可用，重复稳定ID阻止保存', () => {
  const repo = fixture(req)
  try {
    repo.write('.spec/project/child/spec.md', `${raw}### RULE
| id | scope | constraint | basis | authority | source | depends-on |
|---|---|---|---|---|---|---|
| RULE-EXPORT-01 | 导出 | 只导出筛选数据 | 用户原意 | child | user:REQ-EXPORT-01 | REQ-EXPORT-01 |
`)
    repo.git('add', '-A')
    assert.equal(repo.run('spec', 'lint', '--json').code, 0)
    repo.write('.spec/project/child/spec.md', req)
    const result = repo.run('spec', 'lint', '--json')
    assert.equal(result.code, 1)
    const report = JSON.parse(result.stdout) as SpecLintReport
    assert.ok(report.findings.some((finding) => finding.rule === 'sync-contract' && finding.msg.startsWith('duplicate-id:')))
  } finally { rmSync(repo.root, { recursive: true, force: true }) }
})

test('AC-SYNC-CONTRACT-LINT-04 candidate始终校验提交树，工作区不同字节不能改变结论', () => {
  const repo = fixture(req)
  try {
    const good = repo.git('rev-parse', 'HEAD')
    repo.write(specPath, req.replace('| goal |', '| bogus |'))
    assert.equal(repo.run('spec', 'lint', '--json', '--pending', good).code, 0)
    repo.git('add', '-A'); repo.git('commit', '-qm', 'invalid candidate')
    const bad = repo.git('rev-parse', 'HEAD')
    repo.write(specPath, req)
    const result = repo.run('spec', 'lint', '--json', '--pending', bad)
    assert.equal(result.code, 1)
    const report = JSON.parse(result.stdout) as SpecLintReport
    assert.ok(report.findings.some((finding) => finding.rule === 'sync-contract' && finding.msg.startsWith('table-header:')))
  } finally { rmSync(repo.root, { recursive: true, force: true }) }
})

test('AC-SYNC-CONTRACT-LINT-05 未实现AC绑定及未决GAP不阻止草稿，不执行VERIFY', () => {
  const repo = fixture(`${req}### AC
| id | covers | preconditions | action | assertion | test | command | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| AC-EXPORT-01 | REQ-EXPORT-01 | - | 请求导出 | 取得筛选结果 | tests/not-written.test.js#AC-EXPORT-01 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |
### VERIFY
| id | command | cwd | timeout-ms |
|---|---|---|---|
| VERIFY-EXPORT-01 | ["node","-e","require('node:fs').writeFileSync('verify-ran','executed')"] | . | 1000 |
### GAP
| id | kind | unknown | affects | evidence | decision | source | depends-on |
|---|---|---|---|---|---|---|---|
| GAP-EXPORT-POLICY | missing_fact | 导出权限待定义 | REQ-EXPORT-01 | 用户尚未提供权限事实 | 决定谁可以导出 | user:raw | REQ-EXPORT-01 |
`)
  try {
    const result = repo.run('spec', 'lint', '--json')
    assert.equal(result.code, 0, result.stderr + result.stdout)
    const report = JSON.parse(result.stdout) as SpecLintReport
    assert.ok(!report.findings.some((finding) => finding.level === 'error'))
    assert.ok(report.findings.some((finding) => finding.rule === 'sync-contract' && finding.level === 'warn' && finding.msg.startsWith('bindings-unverified:')))
    assert.equal(existsSync(join(repo.root, 'verify-ran')), false)
  } finally { rmSync(repo.root, { recursive: true, force: true }) }
})

test('AC-SYNC-CONTRACT-GUIDE-01 真实guide输出由核心列派生，明确草稿和未运行边界', () => {
  const repo = fixture(raw)
  try {
    const result = repo.run('guide', 'spec')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /contract-schema: sync-v1/)
    for (const [kind, columns] of Object.entries(CONTRACT_COLUMNS)) assert.ok(result.stdout.includes(`### ${kind}: ${columns.join(', ')}`))
    assert.match(result.stdout, /source is ONE origin/)
    assert.match(result.stdout, /depends-on is a comma-separated ID list/)
    assert.match(result.stdout, /Raw-only and REQ-only input are legal drafts/)
    assert.match(result.stdout, /lint NEVER\s+executes that command or launches an Agent/)
    assert.match(result.stdout, /Bound does not mean a test ran/)
    assert.ok(!result.stdout.includes('sync run'))
    const help = repo.run('help', 'spec')
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /sync-contract \(sync-v1 draft/)
    assert.match(help.stdout, /never complete\s+synchronization or execution proof/)
  } finally { rmSync(repo.root, { recursive: true, force: true }) }
})
