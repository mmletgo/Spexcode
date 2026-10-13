import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('真实commitSurgery的materialize EACCES：ordinary advisory，trusted严格传播原异常', t => {
  const root = mkdtempSync(join(tmpdir(), 'spex-surgery-error-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('/usr/bin/git', ['init', '-q', root])
  const source = new URL('./commit-surgery.ts', import.meta.url).href
  const tsx = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {commitSurgery} from ${JSON.stringify(source)};
const original=fs.mkdirSync, error=Object.assign(new Error('injected mkdir EACCES'),{code:'EACCES'});
fs.mkdirSync=()=>{throw error}; syncBuiltinESMExports();
try { commitSurgery(); } catch(actual) { if(actual!==error) throw actual; console.error('strict original EACCES propagated'); process.exitCode=23; }
finally {fs.mkdirSync=original;syncBuiltinESMExports();}`
  for (const strict of [false, true]) {
    const env = { ...process.env }
    if (strict) env.SPEXCODE_SYNC_HOOK_MODE = 'trusted-v1'
    else delete env.SPEXCODE_SYNC_HOOK_MODE
    const result = spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, strict ? 23 : 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stderr, strict ? /strict original EACCES propagated/ : /footprint may be stale this commit/)
  }
})
