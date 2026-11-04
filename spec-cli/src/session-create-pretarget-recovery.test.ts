import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

for (const scenario of ['absent', 'path', 'branch', 'store', 'invalid-receipt', 'wrong-payload', 'canonical-address', 'candidate-lock', 'current-receipt', 'current-removed', 'legacy-receipt', 'legacy-modified', 'legacy-forged-path', 'legacy-identity', 'legacy-path', 'legacy-branch', 'legacy-published-owner', 'legacy-archived-owner', 'legacy-archived-branch-owner', 'legacy-path-owner', 'legacy-alias-owner', 'legacy-foreign-branch'] as const) {
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
import {existsSync,mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {digest,recoverSessionCreateTermination,readSessionCreateTermination,sessionCreateRequest,sessionIdForCreateKey} from ${JSON.stringify(fileURLToPath(new URL('./sessions.ts', import.meta.url)))};
import {configuredSessionApplication} from ${JSON.stringify(fileURLToPath(new URL('./session-application.ts', import.meta.url)))};
import {fromRaw,writeRecord} from ${JSON.stringify(fileURLToPath(new URL('./session-record.ts', import.meta.url)))};
import {withRecordLock} from ${JSON.stringify(fileURLToPath(new URL('./session-record.ts', import.meta.url)))};
import {nodeFromPrompt,slugify,titleFromPrompt} from ${JSON.stringify(fileURLToPath(new URL('./session-prompt.ts', import.meta.url)))};
import {runtimeRoot,sessionStoreDir} from ${JSON.stringify(fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url)))};
const scenario=${JSON.stringify(scenario)};
const key=scenario.includes('owner')||scenario==='legacy-foreign-branch'?'crash-3':'pretarget-create-proof',prompt='pretarget recovery',id=sessionIdForCreateKey(key);
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
const slug=slugify(nodeFromPrompt(prompt)||titleFromPrompt(prompt))+'-'+(scenario.startsWith('legacy-')?id.slice(0,4):id);
const path=join(realpathSync(runtimeRoot()),'structured-worktrees',slug),branch='node/'+slug;
const receiptDir=join(runtimeRoot(),'.session-create-candidates'),receiptPath=join(receiptDir,id+'.json');
assert.equal(existsSync(receiptPath),false);
assert.equal(existsSync(sessionStoreDir(id)),false);
const before={head:base,index:readFileSync(git('rev-parse','--git-path','index')),status:git('status','--porcelain=v1'),worktrees:git('worktree','list','--porcelain')};
if(scenario==='path'||scenario==='legacy-path'){mkdirSync(path,{recursive:true});writeFileSync(join(path,'user-data'),'keep user data');}
if(scenario==='branch'||scenario==='legacy-branch')git('branch',branch);
if(scenario==='store'){mkdirSync(sessionStoreDir(id),{recursive:true});writeFileSync(join(sessionStoreDir(id),'user-data'),'keep user data');}
if(scenario==='invalid-receipt'){mkdirSync(receiptDir,{recursive:true});writeFileSync(receiptPath,'{}');}
if(scenario==='canonical-address')application.protocol.withTransaction(tx=>tx.initialize(id));
// Synthetic old-writer receipt with real isolated Git resources; no production receipt is accessed.
if(['current-receipt','current-removed','legacy-receipt','legacy-modified','legacy-forged-path','legacy-identity','legacy-published-owner','legacy-archived-owner','legacy-archived-branch-owner','legacy-path-owner','legacy-alias-owner','legacy-foreign-branch'].includes(scenario)){
 mkdirSync(join(realpathSync(runtimeRoot()),'structured-worktrees'),{recursive:true});
 git('worktree','add','--no-track','-b',branch,path,base);
 mkdirSync(receiptDir,{recursive:true});
 writeFileSync(receiptPath,JSON.stringify({version:1,requestDigest:digest(key),payloadHash,root:git('rev-parse','--show-toplevel'),path:scenario==='legacy-forged-path'?path+'-foreign':path,branch,prestate:{store:false,path:false,worktree:false,branch:false},stage:'git-created'}));
 if(scenario==='legacy-modified')writeFileSync(join(path,'user-data'),'keep user data');
 if(scenario==='legacy-identity')execFileSync('git',['-C',path,'checkout','--detach'],{stdio:'ignore'});
}
if(scenario==='current-removed')git('worktree','remove',path);
let ownerId,ownerBefore,ownerRecordBefore;
if(scenario.includes('owner')||scenario==='legacy-foreign-branch'){
 ownerId=sessionIdForCreateKey('crash-157');assert.equal(ownerId.slice(0,4),id.slice(0,4));assert.notEqual(ownerId,id);
 let ownerPath=path,ownerBranch=branch;
 if(scenario==='legacy-path-owner')ownerBranch='node/other-published-branch';
 if(scenario==='legacy-alias-owner'){ownerPath=join(process.cwd(),'..','owner-alias');symlinkSync(path,ownerPath,'dir');ownerBranch='node/alias-published-branch';}
 if(scenario==='legacy-archived-branch-owner')ownerPath=join(realpathSync(runtimeRoot()),'structured-worktrees','archived-owner');
 if(scenario==='legacy-foreign-branch'){
  ownerPath=join(process.cwd(),'..','foreign');mkdirSync(ownerPath);
  const foreign=(...args)=>execFileSync('git',['-C',ownerPath,...args],{encoding:'utf8'}).trim();
  foreign('init','-q','-b',branch);foreign('-c','user.name=fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','foreign owner');
 }
 application.createSession({sessionId:ownerId,status:'idle',proposal:null,note:null,parentSessionId:null});
 writeRecord(fromRaw({session_id:ownerId,governed:true,worktree_path:ownerPath,branch:ownerBranch,status:'idle',stopped:true,archived:scenario.startsWith('legacy-archived-')}));
 ownerBefore={state:application.readState(ownerId),address:application.readAddress(ownerId)};
 ownerRecordBefore=readFileSync(join(sessionStoreDir(ownerId),'runtime.json'),'utf8');
}
const registeredBeforeRecovery=git('worktree','list','--porcelain');
const options={prompt,payloadHash,base,signal:AbortSignal.timeout(5000),structuredExecution:policy,...(scenario==='current-removed'?{resourceRecoveryOnly:true}:{})};
if(scenario==='wrong-payload')options.payloadHash='0'.repeat(64);
let pending,unlock,held;
if(scenario==='candidate-lock'){
 const admitted=new Promise(resolve=>{held=resolve;});
 pending=withRecordLock('create-resource-'+digest(path+'\\0'+branch),async()=>{held();await new Promise(resolve=>{unlock=resolve;});mkdirSync(path,{recursive:true});writeFileSync(join(path,'user-data'),'concurrent target');});
 await admitted;
}
let result;
if(['invalid-receipt','wrong-payload','legacy-modified','legacy-forged-path','legacy-identity','legacy-published-owner','legacy-archived-owner','legacy-archived-branch-owner','legacy-path-owner','legacy-alias-owner'].includes(scenario))await assert.rejects(recoverSessionCreateTermination(key,options),/invalid private candidate receipt|payload|does not match|identity mismatch|new or modified|published session/);
else if(scenario==='candidate-lock'){
 let settled=false;
 const recovering=recoverSessionCreateTermination(key,options).then(value=>{settled=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(settled,false,'recovery must hold the same exact candidate lock');
 unlock();await pending;result=await recovering;assert.equal(result,null);
}else result=await recoverSessionCreateTermination(key,options);
if(scenario==='absent'||scenario==='current-receipt'||scenario==='current-removed'||scenario==='legacy-receipt'||scenario==='legacy-foreign-branch'){
 assert.ok(result,'crashed admitted create before ownership must obtain a real bounded termination proof');
 assert.equal(result.sessionId,id);assert.equal(result.requestDigest,digest(key));assert.equal(result.payloadHash,payloadHash);
 assert.equal(result.phase,scenario==='absent'?'target-resolution':'cleanup');assert.equal(result.nativeStatus,'notStarted');assert.equal(result.cleanupComplete,true);
 assert.deepEqual(readSessionCreateTermination(key),result);
 const retry=await sessionCreateRequest({prompt,base},{requestKey:key,structuredExecution:policy});
 assert.equal(retry.status,408);assert.equal(retry.code,'session_create_cancelled');
 assert.deepEqual(retry.termination,result,'same frozen key cannot publish or launch after termination');
 assert.equal(application.readAddress(id),null);assert.equal(application.readState(id),null);
 assert.equal(existsSync(path),false);assert.equal(existsSync(sessionStoreDir(id)),false);assert.equal(existsSync(receiptPath),false);
}else{
 assert.equal(readSessionCreateTermination(key),null,'unknown/occupied/canonical/payload evidence must remain unproven');
 if(['path','legacy-path','legacy-modified','candidate-lock'].includes(scenario))assert.equal(readFileSync(join(path,'user-data'),'utf8'),scenario==='candidate-lock'?'concurrent target':'keep user data');
 if(scenario==='store')assert.equal(readFileSync(join(sessionStoreDir(id),'user-data'),'utf8'),'keep user data');
 if(scenario==='branch'||scenario==='legacy-branch')assert.equal(git('rev-parse','refs/heads/'+branch),base);
 if(scenario.startsWith('legacy-')&&scenario!=='legacy-path'&&scenario!=='legacy-branch')assert.ok(existsSync(receiptPath),'refused legacy recovery preserves ownership receipt');
 if(scenario==='invalid-receipt')assert.equal(readFileSync(receiptPath,'utf8'),'{}');
 if(scenario==='canonical-address')assert.ok(application.readAddress(id));
}
if(ownerId){assert.deepEqual({state:application.readState(ownerId),address:application.readAddress(ownerId)},ownerBefore);assert.equal(readFileSync(join(sessionStoreDir(ownerId),'runtime.json'),'utf8'),ownerRecordBefore);}
assert.equal(git('rev-parse','HEAD'),before.head);assert.deepEqual(readFileSync(git('rev-parse','--git-path','index')),before.index);assert.equal(git('status','--porcelain=v1'),before.status);assert.equal(git('worktree','list','--porcelain'),scenario==='current-receipt'||scenario==='legacy-receipt'||scenario==='legacy-foreign-branch'?before.worktrees:registeredBeforeRecovery);
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

for (const scenario of ['partial', 'staged', 'payload', 'root', 'branch', 'advanced', 'race-fork', 'published', 'native', 'other-owner', 'cold-receipt', 'cold-registration', 'cold-schema', 'cold-published', 'cold-fork', 'later-owner'] as const) test(`resource-only candidate preservation ${scenario} keeps exact publication authority and originals`, { timeout: 30000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'spex-candidate-preservation-')), root = join(temp, 'source'), home = join(temp, 'runtime')
  try {
    mkdirSync(root)
    writeFileSync(join(root, 'README'), 'original seed\n')
    writeFileSync(join(root, 'missing'), 'not checked out\n')
    writeFileSync(join(root, '.gitignore'), 'ignored/\n')
    const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'seed']]) git(...args)
    const runner = join(temp, 'run.mts')
    writeFileSync(runner, String.raw`import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {digest,recoverSessionCreateTermination,readSessionCreateTermination,sessionCreateRequest,sessionIdForCreateKey} from ${JSON.stringify(fileURLToPath(new URL('./sessions.ts', import.meta.url)))};
import {initializeFreshSessionApplication} from ${JSON.stringify(fileURLToPath(new URL('./session-application.ts', import.meta.url)))};
import {fromRaw,writeRecord} from ${JSON.stringify(fileURLToPath(new URL('./session-record.ts', import.meta.url)))};
import {nodeFromPrompt,slugify,titleFromPrompt} from ${JSON.stringify(fileURLToPath(new URL('./session-prompt.ts', import.meta.url)))};
import {runtimeRoot,sessionStoreDir} from ${JSON.stringify(fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url)))};
const application=initializeFreshSessionApplication();
const scenario=${JSON.stringify(scenario)};
const key='partially-initialized-candidate',prompt='preserve partial candidate',id=sessionIdForCreateKey(key);
const git=(...args)=>execFileSync('git',['-C',process.cwd(),...args],{encoding:'utf8'}).trim();
const base=git('rev-parse','HEAD'),policy={version:1,policy:'codex-read-only-v1',schema:{type:'object'},inputDigest:'frozen-input',purpose:'preservation',timeoutMs:10000};
const payloadHash=digest(JSON.stringify({prompt,parent:null,launcher:null,base,structuredExecution:policy}));
const slug=slugify(nodeFromPrompt(prompt)||titleFromPrompt(prompt))+'-'+id,path=join(realpathSync(runtimeRoot()),'structured-worktrees',slug),branch='node/'+slug;
mkdirSync(join(runtimeRoot(),'structured-worktrees'),{recursive:true});
git('worktree','add','--no-checkout','--lock','--reason','initializing','-b',branch,path,base);
const gitDir=execFileSync('git',['-C',path,'rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();
assert.equal(existsSync(join(gitDir,'index')),false);
writeFileSync(join(path,'README'),'unknown modified candidate bytes\n');writeFileSync(join(path,'.gitignore'),'ignored/\n');
writeFileSync(join(path,'empty'),'');writeFileSync(join(path,'executable'),'#!/bin/sh\\nexit 0\\n');chmodSync(join(path,'executable'),0o755);
mkdirSync(join(path,'ignored'));writeFileSync(join(path,'ignored','secret'),'ignored bytes\0');mkdirSync(join(path,'empty-dir'));
const outside=join(process.cwd(),'..','outside');writeFileSync(outside,'outside must not be followed');symlinkSync(outside,join(path,'link'));
const receiptPath=join(runtimeRoot(),'.session-create-candidates',id+'.json');mkdirSync(join(runtimeRoot(),'.session-create-candidates'),{recursive:true});
const prepared=JSON.stringify({version:1,requestDigest:digest(key),payloadHash,root:process.cwd(),path,branch,prestate:{store:false,path:false,worktree:false,branch:false},stage:'prepared'})+'\n';writeFileSync(receiptPath,prepared);
if(scenario==='staged'){execFileSync('git',['-C',path,'add','README']);writeFileSync(join(path,'README'),'working differs from staged bytes');}
const snapshot=(root)=>{const entries=[];const walk=(directory)=>{for(const name of readdirSync(directory).sort()){const file=join(directory,name),stat=lstatSync(file),type=stat.isSymbolicLink()?'link':stat.isDirectory()?'directory':'file';entries.push({path:relative(root,file),type,mode:stat.mode,bytes:type==='directory'?null:(type==='link'?Buffer.from(readlinkSync(file)):readFileSync(file)).toString('base64')});if(type==='directory')walk(file);}};walk(root);return entries;};
const options={prompt,payloadHash,base,signal:AbortSignal.timeout(10000),structuredExecution:policy};
await assert.rejects(recoverSessionCreateTermination(key,options),/new or modified/);
const originals={candidate:snapshot(path),admin:snapshot(gitDir),prepared:readFileSync(receiptPath),branch:git('rev-parse','refs/heads/'+branch),sourceIndex:readFileSync(git('rev-parse','--git-path','index')),sourceStatus:git('status','--porcelain=v1'),outside:readFileSync(outside),registry:git('worktree','list','--porcelain')};
assert.equal(readSessionCreateTermination(key),null);
if(['payload','root','branch','advanced','race-fork','published','native','other-owner'].includes(scenario)){
 const explicit={...options,resourceRecoveryOnly:true};
 if(scenario==='payload')explicit.payloadHash='0'.repeat(64);
 if(scenario==='root'||scenario==='branch'){const changed=JSON.parse(prepared);changed[scenario]+='-foreign';writeFileSync(receiptPath,JSON.stringify(changed));}
 if(scenario==='advanced'){const commit=git('commit-tree',git('rev-parse',base+'^{tree}'),'-p',base,'-m','foreign advance');git('update-ref','refs/heads/'+branch,commit);}
 if(scenario==='published')application.protocol.withTransaction(tx=>tx.initialize(id));
 if(scenario==='other-owner'){const ownerId=sessionIdForCreateKey('published-other-owner');application.createSession({sessionId:ownerId,status:'idle',proposal:null,note:null,parentSessionId:null});writeRecord(fromRaw({session_id:ownerId,governed:true,worktree_path:path,branch,status:'idle',stopped:true}));}
 if(scenario==='native'){const control=join(runtimeRoot(),'structured-read-only-v1','control');mkdirSync(control,{recursive:true});writeFileSync(join(control,'codex-app-server-generations.json'),JSON.stringify({version:3,revision:1,current:null,pending:null,generations:{fixture:{state:'draining',endpoint:{id:'fixture',pidFile:'fixture-pid',receiptFile:'fixture-receipt',logFile:'fixture-log',socketPath:'fixture-socket'}}},bindings:{[id]:{generationId:'fixture',threadId:'already-native'}}}));}
 const expected={candidate:snapshot(path),admin:snapshot(gitDir),receipt:readFileSync(receiptPath),branch:git('rev-parse','refs/heads/'+branch)};
 if(scenario==='race-fork'){
  const advanced=git('commit-tree',git('rev-parse',base+'^{tree}'),'-p',base,'-m','concurrent advance'),realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim(),bin=join(process.cwd(),'..','race-bin'),trace=join(bin,'advanced'),quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  mkdirSync(bin);writeFileSync(join(bin,'git'),['#!/bin/sh','case " $* " in *'+quote(' rev-parse --verify refs/heads/'+branch+'^{commit} ')+'*)','if [ ! -e '+quote(trace)+' ]; then',quote(realGit)+' "$@" || exit $?','printf advanced > '+quote(trace),quote(realGit)+' -C '+quote(process.cwd())+' update-ref '+quote('refs/heads/'+branch)+' '+quote(advanced)+' '+quote(base),'exit $?','fi',';;','esac','exec '+quote(realGit)+' "$@"'].join('\n'));chmodSync(join(bin,'git'),0o755);process.env.PATH=bin+':'+process.env.PATH;expected.branch=advanced;
 }
 await assert.rejects(recoverSessionCreateTermination(key,explicit),/does not match|frozen fork|fork changed|not cold|published session/);
 assert.equal(readSessionCreateTermination(key),null);assert.deepEqual(snapshot(path),expected.candidate);assert.deepEqual(snapshot(gitDir),expected.admin);assert.deepEqual(readFileSync(receiptPath),expected.receipt);assert.equal(git('rev-parse','refs/heads/'+branch),expected.branch);
 console.log(JSON.stringify({preserved:true,scenario,refused:true}));process.exit();
}
const receipt=await recoverSessionCreateTermination(key,{...options,resourceRecoveryOnly:true});
assert.ok(receipt,'explicit resource-only recovery must return real preservation proof');assert.equal(receipt.version,2);assert.equal(receipt.disposition,'preserved');assert.equal(receipt.cleanupComplete,false);
assert.equal(receipt.nativeStatus,'notStarted');assert.equal(receipt.payloadHash,payloadHash);assert.deepEqual(readSessionCreateTermination(key),receipt);
assert.deepEqual(snapshot(path),originals.candidate);assert.deepEqual(snapshot(gitDir),originals.admin);assert.deepEqual(readFileSync(receiptPath),originals.prepared);assert.equal(git('rev-parse','refs/heads/'+branch),originals.branch);
assert.deepEqual(readFileSync(git('rev-parse','--git-path','index')),originals.sourceIndex);assert.equal(git('status','--porcelain=v1'),originals.sourceStatus);assert.equal(git('worktree','list','--porcelain'),originals.registry);assert.deepEqual(readFileSync(outside),originals.outside);
assert.equal(existsSync(join(gitDir,'index')),scenario==='staged');assert.equal(readFileSync(join(gitDir,'locked'),'utf8'),'initializing\n');assert.equal(existsSync(join(path,'missing')),false);assert.equal(application.readAddress(id),null);assert.equal(existsSync(sessionStoreDir(id)),false);
const retry=await sessionCreateRequest({prompt,base},{requestKey:key,structuredExecution:policy});assert.equal(retry.status,408);assert.deepEqual(retry.termination,receipt);
writeFileSync(join(path,'README'),'later user content stays retained');
assert.deepEqual(readSessionCreateTermination(key),receipt,'later content is not deletion authority and does not revive the key');
assert.equal(readFileSync(receiptPath,'utf8'),prepared);
if(scenario==='later-owner'){
 const ownerId=sessionIdForCreateKey('later-published-owner');application.createSession({sessionId:ownerId,status:'idle',proposal:null,note:null,parentSessionId:null});writeRecord(fromRaw({session_id:ownerId,governed:true,worktree_path:path,branch,status:'idle',stopped:true}));
 const ownerBefore=application.readState(ownerId),recordPath=join(sessionStoreDir(ownerId),'runtime.json'),recordBefore=readFileSync(recordPath),siteBefore=snapshot(path);
 assert.deepEqual(readSessionCreateTermination(key),receipt);assert.deepEqual(await recoverSessionCreateTermination(key,options),receipt);
 assert.deepEqual(application.readState(ownerId),ownerBefore);assert.deepEqual(readFileSync(recordPath),recordBefore);assert.deepEqual(snapshot(path),siteBefore);
}
if(scenario.startsWith('cold-')){
 if(scenario==='cold-receipt')writeFileSync(receiptPath,prepared+'\n');
 if(scenario==='cold-registration')writeFileSync(join(path,'.git'),readFileSync(join(path,'.git'),'utf8')+'\n');
 if(scenario==='cold-schema'){const file=join(runtimeRoot(),'.session-create-terminations',id+'.json'),bad={...receipt,cleanupComplete:true};writeFileSync(file,JSON.stringify(bad));}
 if(scenario==='cold-published')application.protocol.withTransaction(tx=>tx.initialize(id));
 if(scenario==='cold-fork'){const advanced=git('commit-tree',git('rev-parse',base+'^{tree}'),'-p',base,'-m','later fork drift');git('update-ref','refs/heads/'+branch,advanced);}
 assert.throws(()=>readSessionCreateTermination(key),/preserved candidate|invalid structured|not cold/);
 console.log(JSON.stringify({preserved:true,scenario,coldRefused:true}));process.exit();
}
console.log(JSON.stringify({preserved:true,indexAbsent:true,initializingLock:'unchanged',native:'notStarted',disposition:receipt.disposition,retained:receipt.retained}));process.exit();
`)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_SESSION_ID: undefined } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /"preserved":true/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
