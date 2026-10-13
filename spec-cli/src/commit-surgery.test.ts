import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('真实commitSurgery的materialize EACCES：ordinary advisory，trusted严格传播原异常', t => {
  const root = mkdtempSync(join(tmpdir(), 'spex-surgery-error-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('/usr/bin/git', ['init', '-q', root])
  mkdirSync(join(root, '.spec')); writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ harnesses: [] }))
  const footprint = mkdtempSync(join(tmpdir(), 'spex-surgery-private-'))
  t.after(() => rmSync(footprint, { recursive: true, force: true }))
  const source = new URL('./commit-surgery.ts', import.meta.url).href
  const tsx = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
  const policySource = new URL('./sync/trusted-footprint.ts', import.meta.url).href
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
import {commitSurgery} from ${JSON.stringify(source)};
import {readFootprintConfiguration,footprintDigest} from ${JSON.stringify(policySource)};
const privateDir=${JSON.stringify(footprint)},stat=fs.statSync(privateDir),strict=process.env.SPEXCODE_SYNC_HOOK_MODE==='trusted-v1';
const policy={version:'frozen-delivery-footprint-v1',privateDirectory:{path:fs.realpathSync(privateDir),device:stat.dev,inode:stat.ino,mode:stat.mode&511},configurationDigest:readFootprintConfiguration('/usr/bin/git',process.cwd()).digest,files:[]};
process.env.SPEXCODE_SYNC_FOOTPRINT_POLICY=JSON.stringify(policy);process.env.SPEXCODE_SYNC_FOOTPRINT_SHA256=footprintDigest(JSON.stringify(policy));
const method=strict?'writeFileSync':'mkdirSync',original=fs[method], error=Object.assign(new Error('injected materialize EACCES'),{code:'EACCES'});
fs[method]=()=>{throw error}; syncBuiltinESMExports();
try { commitSurgery(); } catch(actual) { if(actual!==error) throw actual; console.error('strict original EACCES propagated'); process.exitCode=23; }
finally {fs[method]=original;syncBuiltinESMExports();}`
  for (const strict of [false, true]) {
    const env = { ...process.env }
    if (strict) env.SPEXCODE_SYNC_HOOK_MODE = 'trusted-v1'
    else delete env.SPEXCODE_SYNC_HOOK_MODE
    const result = spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, strict ? 23 : 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stderr, strict ? /strict original EACCES propagated/ : /footprint may be stale this commit/)
  }
})
