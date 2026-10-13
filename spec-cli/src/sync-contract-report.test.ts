import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readContractReport } from './sync/contract-report.js'

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
