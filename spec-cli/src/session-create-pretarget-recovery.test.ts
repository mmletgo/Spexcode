import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

for (const scenario of ['absent', 'path', 'branch', 'store', 'invalid-receipt', 'wrong-payload', 'canonical-address', 'candidate-lock'] as const) {
  test(`pretarget creation recovery ${scenario} preserves exact publication authority`, { timeout: 30000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), 'spex-pretarget-recovery-')), root = join(temp, 'source'), home = join(temp, 'runtime')
    try {
      mkdirSync(root)
      writeFileSync(join(root, 'README'), 'original author input\n')
      const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
      for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', 'README'], ['commit', '-qm', 'fixture']]) git(...args)
      const runner = join(temp, 'run.mts')
      writeFileSync(runner, `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {digest,recoverSessionCreateTermination,readSessionCreateTermination,sessionCreateRequest,sessionIdForCreateKey} from ${JSON.stringify(fileURLToPath(new URL('./sessions.ts', import.meta.url)))};
import {configuredSessionApplication} from ${JSON.stringify(fileURLToPath(new URL('./session-application.ts', import.meta.url)))};
import {withRecordLock} from ${JSON.stringify(fileURLToPath(new URL('./session-record.ts', import.meta.url)))};
import {nodeFromPrompt,slugify,titleFromPrompt} from ${JSON.stringify(fileURLToPath(new URL('./session-prompt.ts', import.meta.url)))};
import {runtimeRoot,sessionStoreDir} from ${JSON.stringify(fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url)))};
const key='pretarget-create-proof',prompt='pretarget recovery',id=sessionIdForCreateKey(key);
const git=(...args)=>execFileSync('git',['-C',process.cwd(),...args],{encoding:'utf8'}).trim();
const base=git('rev-parse','HEAD');
const policy={version:1,policy:'codex-read-only-v1',schema:{type:'object'},inputDigest:'frozen-input',purpose:'pretarget-recovery',timeoutMs:10000};
const payloadHash=digest(JSON.stringify({prompt,parent:null,launcher:null,base,structuredExecution:policy}));
if(process.argv[2]==='crash'){
 const original=console.error;
 console.error=(...args)=>{original(...args);if(String(args[0]).includes('"phase":"target-resolution","event":"start"'))process.exit(73);};
 await sessionCreateRequest({prompt,base},{requestKey:key,structuredExecution:policy});
 assert.fail('real create must stop at the target-resolution trace before any target mutation');
}
const application=configuredSessionApplication();
assert.equal(application.readAddress(id),null);
assert.equal(readSessionCreateTermination(key),null);
const slug=slugify(nodeFromPrompt(prompt)||titleFromPrompt(prompt))+'-'+id.slice(0,4);
const path=join(realpathSync(runtimeRoot()),'structured-worktrees',slug),branch='node/'+slug;
const receiptDir=join(runtimeRoot(),'.session-create-candidates'),receiptPath=join(receiptDir,id+'.json');
assert.equal(existsSync(receiptPath),false);
assert.equal(existsSync(sessionStoreDir(id)),false);
const before={head:base,index:readFileSync(git('rev-parse','--git-path','index')),status:git('status','--porcelain=v1'),worktrees:git('worktree','list','--porcelain')};
const scenario=${JSON.stringify(scenario)};
if(scenario==='path'){mkdirSync(path,{recursive:true});writeFileSync(join(path,'user-data'),'keep user data');}
if(scenario==='branch')git('branch',branch);
if(scenario==='store'){mkdirSync(sessionStoreDir(id),{recursive:true});writeFileSync(join(sessionStoreDir(id),'user-data'),'keep user data');}
if(scenario==='invalid-receipt'){mkdirSync(receiptDir,{recursive:true});writeFileSync(receiptPath,'{}');}
if(scenario==='canonical-address')application.protocol.withTransaction(tx=>tx.initialize(id));
const options={prompt,payloadHash,base,signal:AbortSignal.timeout(5000),structuredExecution:policy};
if(scenario==='wrong-payload')options.payloadHash='0'.repeat(64);
let pending,unlock,held;
if(scenario==='candidate-lock'){
 const admitted=new Promise(resolve=>{held=resolve;});
 pending=withRecordLock('create-resource-'+digest(path+'\\0'+branch),async()=>{held();await new Promise(resolve=>{unlock=resolve;});mkdirSync(path,{recursive:true});writeFileSync(join(path,'user-data'),'concurrent target');});
 await admitted;
}
let result;
if(scenario==='invalid-receipt'||scenario==='wrong-payload')await assert.rejects(recoverSessionCreateTermination(key,options),/invalid private candidate receipt|payload|does not match/);
else if(scenario==='candidate-lock'){
 let settled=false;
 const recovering=recoverSessionCreateTermination(key,options).then(value=>{settled=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(settled,false,'recovery must hold the same exact candidate lock');
 unlock();await pending;result=await recovering;assert.equal(result,null);
}else result=await recoverSessionCreateTermination(key,options);
if(scenario==='absent'){
 assert.ok(result,'crashed admitted create before ownership must obtain a real bounded termination proof');
 assert.equal(result.sessionId,id);assert.equal(result.requestDigest,digest(key));assert.equal(result.payloadHash,payloadHash);
 assert.equal(result.phase,'target-resolution');assert.equal(result.nativeStatus,'notStarted');assert.equal(result.cleanupComplete,true);
 assert.deepEqual(readSessionCreateTermination(key),result);
 const retry=await sessionCreateRequest({prompt,base},{requestKey:key,structuredExecution:policy});
 assert.equal(retry.status,408);assert.equal(retry.code,'session_create_cancelled');
 assert.deepEqual(retry.termination,result,'same frozen key cannot publish or launch after termination');
 assert.equal(application.readAddress(id),null);assert.equal(application.readState(id),null);
 assert.equal(existsSync(path),false);assert.equal(existsSync(sessionStoreDir(id)),false);assert.equal(existsSync(receiptPath),false);
}else{
 assert.equal(readSessionCreateTermination(key),null,'unknown/occupied/canonical/payload evidence must remain unproven');
 if(scenario==='path'||scenario==='candidate-lock')assert.equal(readFileSync(join(path,'user-data'),'utf8'),scenario==='path'?'keep user data':'concurrent target');
 if(scenario==='store')assert.equal(readFileSync(join(sessionStoreDir(id),'user-data'),'utf8'),'keep user data');
 if(scenario==='branch')assert.equal(git('rev-parse','refs/heads/'+branch),base);
 if(scenario==='invalid-receipt')assert.equal(readFileSync(receiptPath,'utf8'),'{}');
 if(scenario==='canonical-address')assert.ok(application.readAddress(id));
}
assert.equal(git('rev-parse','HEAD'),before.head);assert.deepEqual(readFileSync(git('rev-parse','--git-path','index')),before.index);assert.equal(git('status','--porcelain=v1'),before.status);assert.equal(git('worktree','list','--porcelain'),before.worktrees);
console.log(JSON.stringify({scenario,termination:result?.nativeStatus??null,canonicalAddress:application.readAddress(id),completedRecovery:true}));process.exit();
`)
      const env = { ...process.env, NODE_TEST_CONTEXT: undefined, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_SESSION_ID: undefined }
      const args = ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner]
      const crashed = spawnSync(process.execPath, [...args, 'crash'], { cwd: root, encoding: 'utf8', timeout: 12000, env })
      assert.equal(crashed.status, 73, `${crashed.stdout}\n${crashed.stderr}`)
      assert.match(crashed.stderr, /"phase":"target-resolution","event":"start"/)
      const recovered = spawnSync(process.execPath, [...args, 'recover'], { cwd: root, encoding: 'utf8', timeout: 12000, env })
      assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`)
      assert.match(recovered.stdout, /"completedRecovery":true/)
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
