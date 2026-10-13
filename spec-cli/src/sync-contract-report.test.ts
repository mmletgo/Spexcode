import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContractReportScopeError, readContractReport, readProjectContractReport } from './sync/contract-report.js'

const fixture = fileURLToPath(new URL('../test/fixtures/spec-sync/export-repo', import.meta.url))

test('the contract read model exposes real bindings without claiming execution evidence', async () => {
  const report = await readContractReport(fixture)
  assert.equal(report.contracts.length, 1)
  assert.equal(report.coverage.matrix.length, 30)
  assert.equal(report.findings.filter((finding) => finding.severity === 'error').length, 0, JSON.stringify(report.findings))
  assert.equal(report.verification, 'not_run')
  assert.equal(report.digest, (await readContractReport(fixture)).digest)
})

test('a missing real test binding is incomplete even though the Markdown still names it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-contract-report-'))
  try {
    cpSync(fixture, root, { recursive: true })
    rmSync(join(root, 'tests/export.test.mjs'))
    const report = await readContractReport(root)
    assert.ok(report.findings.some((finding) => finding.severity === 'error'))
    assert.equal(report.verification, 'not_run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlink binding cannot read a file outside the worktree', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spex-contract-symlink-'))
  const root = join(parent, 'repo')
  try {
    cpSync(fixture, root, { recursive: true })
    const outside = join(parent, 'external.js')
    writeFileSync(outside, readFileSync(join(root, 'src/export.js')))
    rmSync(join(root, 'src/export.js'))
    symlinkSync(outside, join(root, 'src/export.js'))
    const report = await readContractReport(root)
    assert.ok(report.findings.some((finding) => finding.code === 'binding-outside-root'))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('HTTP contract scope follows a registered worktree and rejects unrelated directories', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spex-contract-scope-'))
  const root = join(parent, 'repo'), worktree = join(parent, 'worktree')
  try {
    cpSync(fixture, root, { recursive: true })
    for (const args of [
      ['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.test'],
      ['config', 'user.name', 'fixture'], ['add', '.'], ['commit', '-qm', 'fixture'],
      ['worktree', 'add', '-q', '-b', 'contract-scope', worktree],
    ]) execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    rmSync(join(worktree, 'tests/export.test.mjs'))
    const current = await readProjectContractReport(root)
    const selected = await readProjectContractReport(root, worktree)
    assert.equal(current.targetTree, realpathSync(root))
    assert.equal(selected.targetTree, realpathSync(worktree))
    assert.equal(current.findings.filter((item) => item.severity === 'error').length, 0)
    assert.ok(selected.findings.some((item) => item.code === 'missing-test-file'))
    await assert.rejects(readProjectContractReport(root, parent), ContractReportScopeError)
    await assert.rejects(readProjectContractReport(root, '../repo'), ContractReportScopeError)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a spec source symlink cannot expose a document outside the selected worktree', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spex-contract-source-'))
  const root = join(parent, 'repo')
  try {
    cpSync(fixture, root, { recursive: true })
    const path = join(root, '.spec/export/export-contract/spec.md')
    const outside = join(parent, 'external-spec.md')
    writeFileSync(outside, readFileSync(path))
    rmSync(path)
    symlinkSync(outside, path)
    await assert.rejects(readContractReport(root), ContractReportScopeError)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('an incomplete newly marked contract still reads its real governed file before reporting missing business rows', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'spex-contract-empty-'))
  try {
    cpSync(fixture, parent, { recursive: true })
    writeFileSync(join(parent, '.spec/export/export-contract/spec.md'), '---\ntitle: Export\nstatus: active\ncontract-schema: sync-v1\ncode:\n  - src/export.js\n---\n# Export\n\n## raw source\nExport filtered records.\n\n## expanded spec\nDetails pending.\n')
    const report = await readContractReport(parent)
    assert.ok(report.findings.some(finding => finding.code === 'incomplete-contract'))
    assert.ok(!report.findings.some(finding => finding.code === 'missing-governed-file'), JSON.stringify(report.findings))
    assert.equal(report.verification, 'not_run')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})
