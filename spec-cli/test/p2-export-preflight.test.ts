import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertVerificationRegistrationId, FIXTURE_FILES, ORACLE_IDS, VERIFICATION, WRITE_PATHS } from './p2-export-preflight.js'
import { captureInputSnapshot, contentHash } from '../src/sync/snapshot.js'
import { freezeCandidate } from '../src/sync/candidate.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/spec-sync/export-implementation-repo')
test('派发前直接复用生产 schema 拒绝不可满足的两段验证登记', () => {
  assert.throws(() => assertVerificationRegistrationId('VERIFY-EXPORT'), /生产 VERIFY ID/)
  assert.throws(() => assertVerificationRegistrationId('AC-EXPORT-01'), /生产 VERIFY ID/)
  assert.doesNotThrow(() => assertVerificationRegistrationId(VERIFICATION.id))
  assert.equal(VERIFICATION.id, 'VERIFY-EXPORT-01')
  for (const path of ['AGENTS.md', 'fixture-facts.txt']) {
    const text = readFileSync(join(fixture, path), 'utf8')
    assert.ok(text.includes(VERIFICATION.id))
    assert.doesNotMatch(text, /VERIFY-EXPORT(?!-01)/)
  }
})
test('自然语言输入不预填契约或业务实现，可信验证包含独立 oracle', () => {
  for (const path of ['.spec/export/spec.md', '.spec/export/export-contract/spec.md']) {
    const text = readFileSync(join(fixture, path), 'utf8')
    assert.ok(text.includes('## raw source'))
    assert.doesNotMatch(text, /contract_schema:|\|.*\||\b(?:STATE|FLOW|TR|STEP|AC|REQ)-/)
  }
  assert.ok(!FIXTURE_FILES.some(path => path.startsWith('src/') || path.startsWith('tests/')))
  const oracle = readFileSync(join(fixture, 'trusted-oracle/export.oracle.test.mjs'), 'utf8')
  for (const id of ORACLE_IDS) assert.ok(oracle.includes(`test('${id} `))
  assert.deepEqual(VERIFICATION.command, ['node', '--test', 'tests/export.generated.test.mjs', 'trusted-oracle/export.oracle.test.mjs'])
  assert.equal(VERIFICATION.cwd, '.')
})

test('真实 freeze 拒绝 oracle、facts、package 和初始上层原意改动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-preflight-scope-'))
  try {
    cpSync(fixture, root, { recursive: true })
    execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'add', '.'])
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { stdio: 'ignore' })
    const snapshot = await captureInputSnapshot(root)
    for (const path of FIXTURE_FILES.filter(path => !WRITE_PATHS.includes(path))) {
      const text = readFileSync(join(root, path), 'utf8')
      assert.throws(() => freezeCandidate(snapshot, { version: 'sync-files-v1', changes: [{ path, beforeDigest: contentHash(text), beforeMode: '100644', content: `${text}\nchanged` }] }, { paths: WRITE_PATHS, contractIds: [], flowIds: [] }), /越界/)
    }
    assert.equal((await captureInputSnapshot(root)).id, snapshot.id)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
