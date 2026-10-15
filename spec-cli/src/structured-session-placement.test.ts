import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

for (const scenario of ['plain', 'main-runtime', 'source-runtime'] as const) test(`structured session placement ${scenario} ${scenario === 'plain' ? 'preserves the uninitialized author checkout' : 'rejects an in-checkout runtime'}`, { timeout: 30000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'spex-structured-placement-')), main = join(temp, 'main'), source = scenario === 'source-runtime' ? join(temp, 'source') : main
  try {
    mkdirSync(main)
    writeFileSync(join(main, 'README'), 'uninitialized author repository\n')
    const git = (...args: string[]): string => execFileSync('git', ['-C', main, ...args], { encoding: 'utf8' }).trim()
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', 'README'], ['commit', '-qm', 'fixture']]) git(...args)
    if (source !== main) git('worktree', 'add', '-q', '-b', 'author', source)
    const runner = join(temp, 'run.mts')
    writeFileSync(runner, `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {sessionCreateRequest} from ${JSON.stringify(fileURLToPath(new URL('./sessions.ts', import.meta.url)))};
import {runtimeRoot} from ${JSON.stringify(fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url)))};
const git=(...args)=>execFileSync('git',['-C',process.cwd(),...args],{encoding:'utf8'}).trim();
const before={head:git('rev-parse','HEAD'),tree:git('write-tree'),status:git('status','--porcelain=v1'),index:readFileSync(git('rev-parse','--git-path','index')),worktrees:git('worktree','list','--porcelain')};
assert.equal(before.status,'');
const policy={version:1,policy:'codex-read-only-v1',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},inputDigest:'placement-input',purpose:'placement-regression',timeoutMs:10000};
const created=await sessionCreateRequest({prompt:'placement regression',base:before.head},{requestKey:'placement-${scenario}',structuredExecution:policy});
if(${JSON.stringify(scenario)}==='plain'){
 assert.equal(created.status,201,JSON.stringify(created));
 const path=created.session.path;
 assert.ok(path,JSON.stringify(created));
 assert.equal(dirname(path),join(realpathSync(runtimeRoot()),'structured-worktrees'));
 for(const root of [realpathSync(${JSON.stringify(main)}),realpathSync(process.cwd())]){const value=relative(root,path);assert.ok(value==='..'||value.startsWith('../')||isAbsolute(value), 'structured candidate must remain outside every author checkout');}
 assert.equal(statSync(dirname(path)).mode&0o777,0o700);
 assert.ok(git('worktree','list','--porcelain').includes('worktree '+path));
 assert.equal(git('status','--porcelain=v1'),before.status);
 assert.equal(existsSync(join(process.cwd(),'.worktrees')),false);
}else{
 assert.equal(created.status,400,JSON.stringify(created));
 assert.match(created.error,/structured.*runtime.*outside.*(?:source|checkout)/i);
 assert.equal(git('worktree','list','--porcelain'),before.worktrees);
}
assert.equal(git('rev-parse','HEAD'),before.head);assert.equal(git('write-tree'),before.tree);assert.deepEqual(readFileSync(git('rev-parse','--git-path','index')),before.index);
console.log(JSON.stringify({scenario:${JSON.stringify(scenario)},status:created.status,sourceStatus:git('status','--porcelain=v1'),worktree:created.session?.path}));process.exit();
`)
    const home = scenario === 'plain' ? join(temp, 'runtime') : join(source, '.runtime')
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: source, encoding: 'utf8', timeout: 25000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_SESSION_ID: undefined } })
    if (process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, `placement-${scenario}.log`), `${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /"scenario"/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
