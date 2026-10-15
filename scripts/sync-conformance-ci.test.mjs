import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(new URL('./sync-conformance-ci.mjs', import.meta.url))
const git = (root, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8' }).trim()
test('CI starts the unchanged protected runner and never executes the candidate runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-ci-boundary-'))
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'CI']); git(root, ['config', 'user.email', 'ci@example.test'])
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'spec-cli/dist'), { recursive: true })
  writeFileSync(join(root, 'scripts/check.mjs'), source)
  writeFileSync(join(root, 'spec-cli/dist/cli.js'), 'console.log("TRUSTED-BASE-RUNNER", process.argv.slice(2).join(" "))\n')
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base'])
  const base = git(root, ['rev-parse', 'HEAD'])
  writeFileSync(join(root, 'spec-cli/dist/cli.js'), 'console.log("UNTRUSTED-CANDIDATE")\n')
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'candidate'])
  const candidate = git(root, ['rev-parse', 'HEAD'])
  git(root, ['checkout', '-q', base])
  const execute = (policy = base) => spawnSync(process.execPath, [join(root, 'scripts/check.mjs'), base, candidate, policy], { encoding: 'utf8' })
  const trusted = execute()
  assert.equal(trusted.status, 0, trusted.stderr); assert.match(trusted.stdout, /TRUSTED-BASE-RUNNER/); assert.doesNotMatch(trusted.stdout, /UNTRUSTED-CANDIDATE/); assert.match(trusted.stdout, new RegExp(`--candidate ${candidate} --policy ${base}`))
  assert.notEqual(execute('HEAD').status, 0)
  writeFileSync(join(root, 'spec-cli/dist/cli.js'), 'console.log("DIRTY-RUNNER")\n')
  const dirty = execute()
  assert.notEqual(dirty.status, 0); assert.doesNotMatch(dirty.stdout, /DIRTY-RUNNER/)
})
