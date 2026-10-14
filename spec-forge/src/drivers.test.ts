import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const tsx = createRequire(import.meta.url).resolve('tsx/esm')
const drivers = fileURLToPath(new URL('./drivers.ts', import.meta.url))
const resident = fileURLToPath(new URL('./resident.ts', import.meta.url))

test('local repository without origin has no resident Forge calls while explicit configuration retains authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-local-forge-')), repo = join(root, 'repo'), bin = join(root, 'bin'), trace = join(root, 'gh-trace')
  try {
    mkdirSync(repo); mkdirSync(bin)
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf 'called\\n' >> ${JSON.stringify(trace)}\nprintf '[]\\n'\n`)
    chmodSync(join(bin, 'gh'), 0o755)
    const script = join(root, 'read.mts')
    writeFileSync(script, `import{resolveForgeHost,forgeIssueStores}from${JSON.stringify(drivers)};import{residentForgeState,refreshForgeNow}from${JSON.stringify(resident)};await refreshForgeNow();console.log(JSON.stringify({host:resolveForgeHost(),stores:forgeIssueStores(),state:residentForgeState()}));`)
    const run = (): { host: string; stores: unknown[]; state: { issues: unknown[]; prs: unknown[] } } => JSON.parse(execFileSync(process.execPath, ['--import', tsx, script], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })) as { host: string; stores: unknown[]; state: { issues: unknown[]; prs: unknown[] } }
    const local = run()
    assert.equal(local.host, 'local')
    assert.deepEqual(local.stores, [])
    assert.deepEqual(local.state, { issues: [], prs: [] })
    assert.equal(existsSync(trace), false, 'absence of a remote must not spawn gh and absorb its error')
    mkdirSync(join(repo, '.spec'))
    writeFileSync(join(repo, '.spec', 'spexcode.json'), '{"forge":{"host":"github"}}')
    assert.equal(run().host, 'github')
    assert.equal(readFileSync(trace, 'utf8').trim().split('\n').length, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
