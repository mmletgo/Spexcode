import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [baseCommit, candidateCommit, policyCommit = baseCommit] = process.argv.slice(2)
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
if (![baseCommit, candidateCommit, policyCommit].every(value => typeof value === 'string' && oid.test(value))) throw new Error('trusted CI requires full base/candidate/policy commit SHA arguments')
const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_REPLACE_OBJECTS: '1' } }).trim()
if (git(['rev-parse', 'HEAD']) !== baseCommit || git(['status', '--porcelain=v1', '--untracked-files=no'])) throw new Error('trusted CI runner must be built from the unchanged protected base checkout')
for (const value of [baseCommit, candidateCommit, policyCommit]) if (git(['rev-parse', '--verify', `${value}^{commit}`]) !== value) throw new Error('CI commit binding mismatch')
const run = spawnSync(process.execPath, [join(root, 'spec-cli/dist/cli.js'), 'sync', 'check', '--repository', root, '--base', baseCommit, '--candidate', candidateCommit, '--policy', policyCommit], { stdio: 'inherit', env: process.env })
if (run.error) throw run.error
process.exitCode = run.status ?? 1
