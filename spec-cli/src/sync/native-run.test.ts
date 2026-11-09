import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionIdForCreateKey, readSessionCreateTermination, recoverSessionCreateTermination, type SessionCreateTermination } from '../sessions.js'
import { cancelStructuredSession, runStructuredSession, SettledSessionCreateTimeoutError, StructuredSessionError, type StructuredSessionRequest, type StructuredSessionResult } from '../session-structured.js'
import { rejectedFinalOutput, structuredExecutionPolicy } from '../session-structured-policy.js'
import { freezeContext, proveFrozenReads, readFrozenManifest, readFrozenRange } from '../frozen-context.js'
import { createAttemptRunner, type AttemptRunnerOptions, type NativeRunCheckpoint, type NativeRunPlan, type NativeRunRecord } from './native-run.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef } from './operation-types.js'
import { SyncStore } from './store.js'
import { nativeReviewRequestMatches } from './coordinator.js'

const tsxImport = createRequire(import.meta.url).resolve('tsx/esm')

for (const scenario of ['turn-failed', 'archived-edit', 'cancelled-edit', 'cancelled-empty', 'dirty-failed', 'ordinary-failure', 'events-timeout', 'events-recover', 'events-recover-schema', 'completed-read', 'completed-preserve', 'events-cancelled', 'foreign-session', 'foreign-turn', 'foreign-input', 'unknown-stop', 'provider-business', 'provider-unknown-stop', 'legacy-provider-metadata', 'legacy-generic-failure'] as const) test(`ZCode Native settlement binds one original send and exact stop: ${scenario}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-zcode-failure-')), root = join(directory, 'repo'), home = join(directory, 'home'), bin = join(directory, 'bin'), count = join(directory, 'sends.json')
  for (const path of [root, home, bin]) mkdirSync(path)
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'failure fixture'); git('config', 'user.email', 'failure@example.invalid')
    mkdirSync(join(root, '.spec')); writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    writeFileSync(join(root, 'value'), 'original seed\n'); git('add', '.'); git('commit', '-qm', 'seed')
    const executable = join(bin, 'zcode')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
if(process.argv.includes('--version')){console.log('controlled-native-fixture');process.exit(0)}
const scenario=${JSON.stringify(scenario)},count=${JSON.stringify(count)},send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let session,model,input,query,prompt,stopping=false,delayedId,completed=false,seq=0;const turn='exact-turn';
const event=(type,payload)=>({sessionId:session,turnId:turn,seq:++seq,eventId:'event-'+seq,type,payload});
rl.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line),p=request.params,reply=result=>send({id:request.id,result});
if(request.method==='session/create'){session=p.sessionId;model=p.model;reply({session:{sessionId:session,model}})}
else if(request.method==='session/read')reply({session:{sessionId:session,status:input&&!stopping&&!completed&&!prompt.includes('next-request')?'error':'idle',model},settings:{model:{current:model}},runtime:{pendingRequestIds:[]},projection:{currentTurnId:input?turn:undefined,pendingPermissions:[],activeToolCalls:[]}});
else if(request.method==='session/send'){
  input=p.inputId;query=p.queryId;prompt=p.content;const rows=fs.existsSync(count)?JSON.parse(fs.readFileSync(count,'utf8')):[];rows.push({sessionId:session,inputId:input});fs.writeFileSync(count,JSON.stringify(rows));
  if((scenario.startsWith('events-recover')||['archived-edit','cancelled-edit','dirty-failed'].includes(scenario))&&!prompt.includes('next-request')){
    fs.mkdirSync('.spex-sync-drafts',{recursive:true});fs.writeFileSync('.spex-sync-drafts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json',scenario==='events-recover-schema'?'{"draft":42}':'{"draft":');const cp=require('node:child_process');
    if(scenario!=='dirty-failed'){cp.execFileSync('git',['add','.spex-sync-drafts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json']);cp.execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','agent draft'])}
  }
  reply({accepted:true,sessionId:session})
}
else if(request.method==='session/events'){
  if(scenario.startsWith('events-')&&!prompt.includes('next-request')){
    if(p.afterSeq===undefined){reply({events:[event('turn.started',{inputId:input,queryId:query,messageId:'exact-user'}),event('session.updated',{providerId:model.providerId,modelId:model.modelId,toolCount:3})]});return}
    if(p.afterSeq!==2)throw Error('events reread changed cursor');
    if(delayedId===undefined){delayedId=request.id;return}
    const late={...event('turn.completed',{inputId:input,resultType:'success',response:'{"ok":false}'}),sessionId:'foreign'};
    send({id:delayedId,result:{events:[late]}});
    if(scenario==='events-timeout'&&!stopping){reply({events:[]});return}
    completed=true;const resultType=scenario.startsWith('events-recover')?'success':'cancelled';
    reply({events:[event('turn.completed',{inputId:input,resultType,response:resultType==='success'?'{"ok":true}':''})]});return
  }
  const events=[];if(!p.afterSeq)events.push(event('turn.started',{inputId:input,queryId:query,messageId:'exact-user'}));
  events.push(event('session.updated',{providerId:model.providerId,modelId:model.modelId,toolCount:3}));
  if(scenario.startsWith('cancelled-')&&!stopping){reply({events});return}
  if(scenario.startsWith('completed-'))completed=true;
  const terminal=stopping||scenario.startsWith('completed-')||prompt.includes('next-request')?event('turn.completed',{inputId:input,resultType:stopping?'cancelled':'success',response:stopping?'':'{"ok":true}'}):event('turn.failed',{inputId:input,error:{code:scenario==='ordinary-failure'||scenario==='legacy-generic-failure'?'EACCES':'EPIPE',message:'UNTRUSTED_PROVIDER_BODY'}});
  if(scenario.startsWith('provider-')&&!stopping&&!prompt.includes('next-request'))terminal.payload.error.attribution={source:'provider',errorPhase:'stream',exceptionKind:'provider_business',transport:'sse',retryable:false};
  if(!stopping&&!prompt.includes('next-request')){
    if(scenario==='foreign-session')terminal.sessionId='foreign';if(scenario==='foreign-turn')terminal.turnId='foreign';if(scenario==='foreign-input')terminal.payload.inputId='foreign';
    if(scenario==='unknown-stop'||scenario==='provider-unknown-stop'){const receipt=path.join(path.dirname(path.dirname(process.env.ZCODE_DATA_BASE_DIR)),'process.json'),value=JSON.parse(fs.readFileSync(receipt,'utf8'));fs.writeFileSync(receipt,JSON.stringify({...value,processGroupId:process.pid+1}))}
  }
  events.push(terminal);reply({events})
}
else if(request.method==='session/messages')reply({hasMore:false,messages:[{info:{role:'user',id:'exact-user',semantics:{kind:'user_prompt'},anchor:{turnId:turn},modelSelection:model,sessionID:session},parts:[{type:'text',text:prompt}]},{info:{role:'assistant',semantics:{kind:'assistant_response'},anchor:{turnId:turn},providerId:model.providerId,modelId:model.modelId},parts:[{type:'text',text:'{"ok":true}'}]}]});
else if(request.method==='session/stop'){stopping=true;reply({})}
else if(request.method==='session/close')reply({closed:true});
});`)
    chmodSync(executable, 0o755)
    const modulePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url)), script = join(directory, 'runner.mts')
    const gitExecutable = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const failRestoreGit = `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args.includes('diff')){process.stderr.write('controlled restore diff failure');process.exit(23)}const result=spawnSync(${JSON.stringify(gitExecutable)},args,{stdio:'inherit'});process.exit(result.status??1);`
    const intrudingGit = `#!/usr/bin/env node
const {spawnSync}=require('node:child_process'),{existsSync}=require('node:fs');const args=process.argv.slice(2),target=__TARGET__,branch=__BRANCH__;if(args.includes('list')&&args.includes('--porcelain')&&!existsSync(target)){const added=spawnSync(${JSON.stringify(gitExecutable)},['worktree','add',target,branch],{stdio:'inherit'});if(added.status)process.exit(added.status)}const result=spawnSync(${JSON.stringify(gitExecutable)},args,{stdio:'inherit'});process.exit(result.status??1);`
    writeFileSync(script, `import assert from'node:assert/strict';import{readFileSync,existsSync,writeFileSync,chmodSync,rmSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';
import{Ajv}from'${createRequire(import.meta.url).resolve('ajv')}';import{openProtocol}from'${createRequire(import.meta.url).resolve('@spexcode/session-protocol')}';import{configuredSessionApplication,setSessionApplicationCommitWake,withoutSessionApplicationExecutionWake}from${JSON.stringify(modulePath('../session-application.ts'))};import{sessionArtifactPath}from'${createRequire(import.meta.url).resolve('@spexcode/spec-core')}';import{structuredExecutionPolicy}from${JSON.stringify(modulePath('../session-structured-policy.ts'))};
import{runStructuredSession}from${JSON.stringify(modulePath('../session-structured.ts'))};import{migrateSyncStore}from${JSON.stringify(modulePath('./migrations.ts'))};import{SyncStore}from${JSON.stringify(modulePath('./store.ts'))};import{createAttemptRunner}from${JSON.stringify(modulePath('./native-run.ts'))};import{captureInputSnapshot,readEvidence,contentHash}from${JSON.stringify(modulePath('./snapshot.ts'))};import{nativeWorktreeResult}from${JSON.stringify(modulePath('../native-worktree-runtime.ts'))};import{stageWorktree,overlayStageTree,captureStageDraft,readStageDraft,readStoppedPhysicalDraft}from${JSON.stringify(modulePath('./stage-worktree.ts'))};import{readRecord,writeRecord}from${JSON.stringify(modulePath('../session-record.ts'))};import{closeSession,refreshQueueCandidate,drainQueue,withArchivedStructuredWorktree}from${JSON.stringify(modulePath('../sessions.ts'))};
const scenario=${JSON.stringify(scenario)},owner='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',draftPath='.spex-sync-drafts/'+owner+'.json',draftSource=scenario==='events-recover-schema'?'{"draft":42}':'{"draft":',schema=JSON.stringify({type:'object',properties:{draft:{type:'boolean'}},required:['draft']}),snapshot=await captureInputSnapshot(process.cwd(),{committed:true});configuredSessionApplication();const protocol=openProtocol(process.env.SPEX_SESSION_DATABASE_PATH);await migrateSyncStore(protocol);const store=new SyncStore(protocol,{readBlob:ref=>readEvidence(snapshot.source.commonDir,ref)}),scope={paths:['value'],contractIds:[],flowIds:[]};
const operation=store.admitAndEnqueue({ingressKey:'failure',rootCauseId:'failure',origin:'spec',input:snapshot,scope,budget:{maxCalls:3,maxAttempts:1,maxRepairs:0,timeoutMs:60000},policyDigest:'policy',impactDigest:'impact',readSetDigest:'read',delivery:null,deliveryPlan:{canonicalRoot:process.cwd()+'/delivery',branch:'delivery',baseCommit:snapshot.headCommit}}),claim=store.claimAttempt({operationId:operation.id,source:snapshot.source,scope,leaseMs:60000,expectedMessageId:operation.dispatchMessageId}),seed=stageWorktree(snapshot.source.commonDir,snapshot.headCommit,scenario.startsWith('events-recover')||['archived-edit','cancelled-edit','dirty-failed'].includes(scenario)?overlayStageTree(snapshot.source.commonDir,snapshot.immutableTree,[{path:draftPath.replace(/\\.json$/,'.schema.json'),source:schema}]):snapshot.immutableTree,scenario.startsWith('events-recover')||['archived-edit','cancelled-edit','dirty-failed'].includes(scenario)?'edit':'read'),request={root:process.cwd(),base:seed.baseCommit,worktree:seed,requestKey:'failure',inputDigest:'original-input',purpose:'code_behavior_analyze',prompt:'controlled failure',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},timeoutMs:null,model:'zcode:fixture/model'},runner=createAttemptRunner(store,claim.fence,{pollMs:2,retireSettledWorktrees:scenario==='completed-preserve'||scenario==='archived-edit'?undefined:true});
if(scenario.startsWith('cancelled-')){const controller=new AbortController();request.signal=controller.signal;const timer=setInterval(()=>{const dispatch=store.readAttempt(claim.attempt.id).dispatchPlans[0],current=dispatch?.session?.sessionId?readRecord(dispatch.session.sessionId):null;if(current?.structuredExecution?.turnId){clearInterval(timer);controller.abort()}},10)}
const {result,failure}=await runner(request).then(result=>({result}),failure=>({failure})),record=readRecord((result??failure).sessionId),state=record.structuredExecution,native=state.zcodeNative.root,resource=store.findResource(claim.attempt.id,request.requestKey);
const exitPath=native+'/exit.json',unknownStop=scenario==='unknown-stop'||scenario==='provider-unknown-stop';
const exit=unknownStop&&!existsSync(exitPath)?null:JSON.parse(readFileSync(exitPath,'utf8'));
if(unknownStop)assert.notEqual(exit?.stopped,true);
if(scenario==='archived-edit'||scenario.startsWith('cancelled-')){
  assert.equal(failure.code,scenario==='archived-edit'?'native_turn_transport_failed':'cancelled');assert.equal(resource.phase,'removed');assert.equal(state.cancellation.nativeStopped,true);
  const before=JSON.stringify(state);if(!record.archived)await withoutSessionApplicationExecutionWake(()=>closeSession(record.session,undefined,{wakeQueue:false}));
  assert.equal(existsSync(record.worktreePath),false);
  const archived=readRecord(record.session),originalRecord=JSON.stringify(archived),originalCheckpoint=readEvidence(snapshot.source.commonDir,resource.checkpointRef),archiveRef=execFileSync('git',['rev-parse','refs/spex-archive/'+record.session],{encoding:'utf8'}),binding={ownerDigest:owner,sourceInputId:snapshot.id,schemaDigest:contentHash(schema),path:draftPath};
  let wakes=0;setSessionApplicationCommitWake(()=>wakes++);
  const material=await withArchivedStructuredWorktree(archived,path=>{
    const witness=nativeWorktreeResult(path,seed);if(seed.mode==='read'){assert.equal(witness.headCommit,seed.baseCommit);return null}
    const physical=readStoppedPhysicalDraft(snapshot.source.commonDir,path,seed,binding,{allowCommitted:true}),draft=captureStageDraft(snapshot.source.commonDir,seed,{worktree:witness},binding);
    assert.equal(readStageDraft(snapshot.source.commonDir,draft,binding),draftSource);return physical;
  });
  if(seed.mode==='read')assert.equal(material,null);else assert.equal(material.source,draftSource,'正式close后仍沿原Git稿续修');
  assert.equal(JSON.stringify(readRecord(record.session)),originalRecord);assert.equal(JSON.stringify(readRecord(record.session).structuredExecution),before);assert.equal(existsSync(record.worktreePath),false);assert.deepEqual(readEvidence(snapshot.source.commonDir,resource.checkpointRef),originalCheckpoint);assert.equal(execFileSync('git',['rev-parse','refs/spex-archive/'+record.session],{encoding:'utf8'}),archiveRef);
  await assert.rejects(withArchivedStructuredWorktree(readRecord(record.session),path=>{assert.equal(existsSync(path),true);throw Error('material callback failure')}),/material callback failure/);
  assert.equal(existsSync(record.worktreePath),false);assert.equal(JSON.stringify(readRecord(record.session)),originalRecord);
  writeRecord({...archived,coldProof:'foreign-proof'});await assert.rejects(withArchivedStructuredWorktree(readRecord(record.session),()=>assert.fail('invalid cold proof must not observe')),/cold and absent/);writeRecord(archived);
  if(scenario==='archived-edit'){
    const shim=process.cwd()+'/restore-fault-bin';mkdirSync(shim);writeFileSync(shim+'/git',${JSON.stringify(failRestoreGit)});chmodSync(shim+'/git',0o755);const originalPath=process.env.PATH;process.env.PATH=shim+':'+originalPath;
    try{await assert.rejects(withArchivedStructuredWorktree(archived,()=>assert.fail('failed restore must not observe')),/archived changes could not be restored/)}finally{process.env.PATH=originalPath}
    assert.equal(existsSync(record.worktreePath),false,'restore后半失败也回收本次checkout');assert.equal(JSON.stringify(readRecord(record.session)),originalRecord);assert.equal(execFileSync('git',['rev-parse','refs/spex-archive/'+record.session],{encoding:'utf8'}),archiveRef);
    assert.equal(await withArchivedStructuredWorktree(archived,path=>readFileSync(path+'/'+draftPath,'utf8')),draftSource,'去故障后同一archive可重试');assert.equal(existsSync(record.worktreePath),false);
    writeFileSync(shim+'/git',${JSON.stringify(intrudingGit)}.replace('__TARGET__',JSON.stringify(record.worktreePath)).replace('__BRANCH__',JSON.stringify(archived.branch)));process.env.PATH=shim+':'+originalPath;
    try{await assert.rejects(withArchivedStructuredWorktree(archived,()=>assert.fail('matching path inserted before registry must not observe')),/temporary restore requires an absent checkout/)}finally{process.env.PATH=originalPath}
    assert.equal(existsSync(record.worktreePath),true,'registry锁前出现的matching checkout不是本次创建，不可删除');assert.equal(JSON.stringify(readRecord(record.session)),originalRecord);assert.equal(execFileSync('git',['rev-parse','refs/spex-archive/'+record.session],{encoding:'utf8'}),archiveRef);
    execFileSync('git',['worktree','remove',record.worktreePath],{stdio:'pipe'});
  }
  assert.equal(wakes,0);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);assert.equal(store.readOperation(operation.id).callsUsed,1);
  console.log(JSON.stringify({scenario,material:seed.mode==='read'?'null':'original-json',checkoutRemoved:true,nativeUnchanged:true,checkpointUnchanged:true,sends:1,wakes}));protocol.close();process.exit(0);
}
if(scenario.startsWith('events-recover')||scenario.startsWith('completed-')){
  assert.equal(JSON.parse(readFileSync(native+'/terminal.json','utf8')).payload.resultType,'success');
  assert.deepEqual({idle:exit.idle,closed:exit.closed,stopped:exit.stopped},{idle:true,closed:true,stopped:true});
  assert.equal(failure?.code,undefined,'同一轮已取得成功终态和正常退出，事件读取超时不应吞掉交付');
  assert.deepEqual(result.output,{ok:true});assert.equal(state.state,'completed');assert.equal(resource.phase,'removed');
  const worktree=result.worktree,git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
  assert.equal(worktree.baseCommit,seed.baseCommit);
  if(scenario==='completed-preserve'){
    const warnings=[],warn=console.warn;console.warn=(...args)=>warnings.push(args.join(' '));
    const replay=()=>createAttemptRunner(store,claim.fence,{pollMs:2,retireSettledWorktrees:true})(request),path=worktree.worktreePath,original=JSON.stringify(readRecord(result.sessionId));
    writeFileSync(path+'/uncommitted.json','{"unfinished":');
    assert.deepEqual(await replay(),result);assert.equal(existsSync(path),true);assert.equal(JSON.stringify(readRecord(result.sessionId)),original);assert.match(warnings.at(-1),/cleanup pending.*clean/);assert.equal(readFileSync(path+'/uncommitted.json','utf8'),'{"unfinished":');
    rmSync(path+'/uncommitted.json');
    const expected=readRecord(result.sessionId);writeRecord({...expected,runtimeStartToken:'new-user-runtime'});
    await assert.rejects(closeSession(result.sessionId,undefined,{wakeQueue:false,settled:{record:expected,commonDir:snapshot.source.commonDir,worktree}}),/identity changed/);assert.equal(existsSync(path),true);assert.equal(readRecord(result.sessionId).runtimeStartToken,'new-user-runtime');
    writeRecord(expected);
    const sibling='cleanup-queued-sibling',siblingPath=process.cwd()+'/queued-sibling',siblingBranch='queued-sibling',siblingPrompt='next-request';
    git('worktree','add','-q','-b',siblingBranch,siblingPath,seed.baseCommit);
    configuredSessionApplication().createSession({sessionId:sibling,status:'queued'});
    writeRecord({...expected,session:sibling,worktreePath:siblingPath,branch:siblingBranch,status:'queued',proposal:null,harnessSessionId:null,runtimeStartToken:null,launchOwner:null,stopped:false,archived:false,closedAt:null,coldProof:null,adapterRecovery:null,createRequestId:null,createPayloadHash:null,structuredExecution:structuredExecutionPolicy(expected.structuredExecution)});
    writeFileSync(sessionArtifactPath(sibling,'launch'),siblingPrompt);refreshQueueCandidate(sibling);
    const queuedBefore=JSON.stringify(readRecord(sibling));let executionWakes=0;setSessionApplicationCommitWake(()=>executionWakes++);
    const hook=snapshot.source.commonDir+'/hooks/reference-transaction';
    writeFileSync(hook,'#!/bin/sh\\n[ "$1" = prepared ] || exit 0\\nwhile read old new ref; do case "$ref" in refs/spex-archive/*) exit 1 ;; esac; done\\nexit 0\\n');chmodSync(hook,0o755);
    assert.deepEqual(await replay(),result);assert.equal(existsSync(path),true);assert.equal(readRecord(result.sessionId).archived,false);assert.match(warnings.at(-1),/cleanup pending.*publish/);assert.equal(store.findResource(claim.attempt.id,request.requestKey).phase,'removed');
    rmSync(hook);console.warn=warn;assert.deepEqual(await replay(),result);
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(executionWakes,0,'completed close不发execution wake');assert.equal(JSON.stringify(readRecord(sibling)),queuedBefore,'completed close不唤醒已有queued sibling');assert.equal(readFileSync(sessionArtifactPath(sibling,'launch'),'utf8'),siblingPrompt);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1,'close不调用兄弟模型');
    await drainQueue();
    const deadline=Date.now()+5000;while(readRecord(sibling).structuredExecution.state!=='completed'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(readRecord(sibling).structuredExecution.state,'completed','显式drain正控制证明sentinel真实可启动: '+JSON.stringify(readRecord(sibling).structuredExecution));assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,2);
    console.log(JSON.stringify({scenario,deferrals:warnings.length,resultUnchanged:true,queuedSiblingUnchangedUntilExplicitDrain:true}));
  }
  assert.equal(existsSync(worktree.worktreePath),false,'完成的同步任务必须回收物理worktree');
  if(scenario.startsWith('events-recover'))assert.equal(git('diff-tree','--no-commit-id','--name-only','-r',worktree.baseCommit,worktree.headCommit),draftPath);
  if(scenario.startsWith('events-recover')){
    assert.equal(git('show',worktree.headCommit+':'+draftPath),draftSource);
    const binding={ownerDigest:owner,sourceInputId:snapshot.id,schemaDigest:contentHash(schema),path:draftPath};
    const draft=captureStageDraft(snapshot.source.commonDir,seed,result,binding),bytes=readStageDraft(snapshot.source.commonDir,draft,binding);
    assert.equal(bytes,draftSource);if(scenario==='events-recover-schema'){const validate=new Ajv().compile(JSON.parse(schema));assert.equal(validate(JSON.parse(bytes)),false);assert.equal(validate.errors[0].keyword,'type')}else assert.throws(()=>JSON.parse(bytes));assert.equal(draft.errors.length,0);assert.equal(draft.resultCommit,worktree.headCommit);
    const nextTree=overlayStageTree(snapshot.source.commonDir,seed.tree,[{path:draftPath,source:bytes}]);
    assert.equal(git('show',nextTree+':'+draftPath),bytes,'后续业务JSON拒绝后仍把同一原稿完整叠入新seed，不从零开始');
  }
  const saved=JSON.parse(readEvidence(snapshot.source.commonDir,resource.checkpointRef).toString());
  assert.deepEqual(saved.result.worktree,worktree);
  assert.equal(JSON.parse(readFileSync(native+'/messages.json','utf8')).length,2);
  assert.equal(readRecord(result.sessionId).archived,true);
  assert.equal(git('rev-parse','refs/spex-archive/'+result.sessionId).length,worktree.headCommit.length);
  assert.equal(git('rev-parse',record.branch),worktree.headCommit);
  assert.equal(git('worktree','list','--porcelain').includes(worktree.worktreePath),false);
  assert.deepEqual(await createAttemptRunner(store,claim.fence,{pollMs:2,retireSettledWorktrees:true})(request),result,'归档后从原removed结果冷重放');
  assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,scenario==='completed-preserve'?2:1);
  assert.equal(store.readOperation(operation.id).callsUsed,1);assert.equal(exit.acknowledged,false,'恢复读取不得发送 stop');
  protocol.close();process.exit(0);
}
assert(failure,'failed Native cannot publish output');
assert.equal(state.output,undefined);assert.equal(state.resultDigest,undefined);assert.equal(state.rejectedOutput,undefined);assert.equal(state.failedWorktree,undefined);assert.equal(existsSync(native+'/completed.json'),false);assert.equal(state.error.includes('UNTRUSTED_PROVIDER_BODY'),false);
console.log(JSON.stringify({scenario,code:failure.code,message:failure.message,state:state.state,phase:resource.phase,nativeStopped:state.cancellation?.nativeStopped,idle:exit?.idle,closed:exit?.closed}));
if(scenario==='provider-business'||scenario.startsWith('legacy-')){
  const code=scenario==='provider-business'?'unsupported':scenario==='legacy-generic-failure'?'failed':'native_turn_transport_failed',message=scenario==='provider-business'?'ZCode provider rejected the native turn (retryable=false)':scenario==='legacy-generic-failure'?'ZCode native turn failed (code=EACCES)':'ZCode native turn failed (code=EPIPE)';
  assert.equal(failure.code,code);assert.equal(failure.message,message);assert.equal(state.state,'failed');assert.equal(state.error,message);assert.equal(state.errorCode,scenario==='legacy-generic-failure'?undefined:code);assert.equal(state.cancellation.nativeStopped,true);assert.equal(resource.phase,'removed');assert.equal(exit.stopped,true);
  const savedPlan=JSON.parse(readEvidence(snapshot.source.commonDir,resource.plan.planBlob).toString());
  if(scenario.startsWith('legacy-')){const terminal=JSON.parse(readFileSync(native+'/terminal.json','utf8'));terminal.payload.error={code:'EPIPE',attribution:{source:'provider',exceptionKind:'provider_business',retryable:false}};chmodSync(native+'/terminal.json',0o600);writeFileSync(native+'/terminal.json',JSON.stringify(terminal));chmodSync(native+'/terminal.json',0o400);}
  const before=JSON.stringify(readRecord(record.session)),checkpoint=readEvidence(snapshot.source.commonDir,resource.checkpointRef),terminal=readFileSync(native+'/terminal.json'),stopped=readFileSync(native+'/exit.json');
  await assert.rejects(runStructuredSession({...savedPlan.request,sessionCreateKey:savedPlan.sessionCreateKey}),{code,message});
  await assert.rejects(createAttemptRunner(store,claim.fence,{pollMs:2,retireSettledWorktrees:true})(request),{code,message});
  assert.equal(JSON.stringify(readRecord(record.session)),before);assert.deepEqual(readEvidence(snapshot.source.commonDir,resource.checkpointRef),checkpoint);assert.deepEqual(readFileSync(native+'/terminal.json'),terminal);assert.deepEqual(readFileSync(native+'/exit.json'),stopped);
  assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1,'live/cold/removed rejection cannot launch another Native turn');assert.equal(store.readOperation(operation.id).callsUsed,1);
  protocol.close();process.exit(0);
}
if(scenario==='provider-unknown-stop'){assert.equal(failure.code,'cancellation_pending');assert.equal(state.state,'cancelling');assert.equal(state.errorCode,undefined);assert.equal(state.error,'ZCode provider rejected the native turn (retryable=false)');assert.notEqual(state.cancellation.nativeStopped,true);assert.notEqual(resource.phase,'removed');assert.equal(existsSync(record.worktreePath),true);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);protocol.close();process.exit(0);}
if(scenario==='turn-failed')assert.equal(failure.code,'native_turn_transport_failed','原生公开EPIPE须保专用typed失败，不能退化为generic failed');
assert.equal(existsSync(record.worktreePath),resource.phase!=='removed'||scenario==='dirty-failed','仅已精确停止且clean的失败目录自动回收，未知停止保留');
const eventsFailure=scenario==='events-timeout'||scenario==='events-cancelled';
if(scenario==='turn-failed'||scenario==='dirty-failed'||scenario==='ordinary-failure'||eventsFailure){
  assert.equal(failure.code,eventsFailure?'native_rpc_timeout':scenario==='turn-failed'||scenario==='dirty-failed'?'native_turn_transport_failed':'failed');
  assert.ok(failure.message.includes(eventsFailure?'session/events':scenario==='turn-failed'||scenario==='dirty-failed'?'code=EPIPE':'code=EACCES'));
  assert.equal(state.state,'failed');assert.equal(state.cancellation.nativeStopped,true);assert.equal(resource.phase,'removed');assert.equal(exit.stopped,true);
  if(!eventsFailure){assert.equal(exit.idle,false);assert.equal(exit.closed,false)}else{assert.equal(exit.idle,true);assert.equal(exit.closed,true);assert.equal(exit.acknowledged,scenario==='events-timeout');assert.equal(JSON.parse(readFileSync(native+'/terminal.json','utf8')).payload.resultType,'cancelled')}
  const saved=JSON.parse(readEvidence(snapshot.source.commonDir,resource.checkpointRef).toString());assert.deepEqual(saved.failure,{code:failure.code,message:failure.message});
  if(scenario==='turn-failed'){assert.equal(state.errorCode,failure.code);assert.equal(failure.requestKey,request.requestKey);assert.equal(failure.inputDigest,request.inputDigest);assert.equal(failure.threadId,saved.session.threadId);assert.equal(failure.turnId,saved.session.turnId)}
  if(scenario==='ordinary-failure')assert.equal(state.errorCode,undefined);
  const recordBefore=JSON.stringify(record),rawBefore=readFileSync(native+'/exit.json');await assert.rejects(createAttemptRunner(store,claim.fence,{pollMs:2})(request),{code:failure.code,message:failure.message,...(scenario==='turn-failed'?{requestKey:request.requestKey,inputDigest:request.inputDigest,threadId:failure.threadId,turnId:failure.turnId}:{})});assert.equal(JSON.stringify(readRecord(failure.sessionId)),recordBefore);assert.deepEqual(readFileSync(native+'/exit.json'),rawBefore);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);
  const next=await runner({...request,requestKey:'next',inputDigest:'next-input',prompt:'next-request'});assert.deepEqual(next.output,{ok:true});assert.notEqual(next.sessionId,failure.sessionId);assert.equal(store.findResource(claim.attempt.id,'next').phase,'removed');assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,2);
}else{
  assert.notEqual(resource.phase,'removed');assert.notEqual(state.cancellation?.nativeStopped,true);
  if(scenario==='unknown-stop'){assert.equal(state.state,'cancelling');assert.equal(failure.code,'cancellation_pending');assert.match(state.error,/ZCode native turn failed \\(code=EPIPE\\)/);assert(state.cancellation.error);assert.notEqual(state.error,state.cancellation.error)}else{assert.equal(failure.code,'failed');assert.match(state.error,/differs|belongs to another/);assert.doesNotMatch(state.error,/ZCode native turn failed/)}
}
protocol.close();process.exit(0);`)
    const result = spawnSync(process.execPath, ['--import', tsxImport, script], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 45000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    console.log(result.stdout)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() > deadline) assert.fail('observable native state did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
function published(request: StructuredSessionRequest): NativeRunRecord {
  const execution = structuredExecutionPolicy(request), createKey = request.sessionCreateKey ?? request.requestKey
  return { session: sessionIdForCreateKey(createKey), status: 'queued', harnessSessionId: null, structuredExecution: execution, createRequestId: textHash(createKey), createPayloadHash: hash({ prompt: request.prompt, parent: null, launcher: null, ...(request.base?.trim() ? { base: request.base.trim() } : {}), structuredExecution: execution }) }
}
function completed(record: NativeRunRecord): StructuredSessionResult {
  const output = { answer: 'verified output' }, threadId = record.structuredExecution!.threadId ?? 'actual-thread', turnId = record.structuredExecution!.turnId ?? 'actual-turn'
  record.status = 'awaiting'; record.harnessSessionId = threadId
  record.structuredExecution = { ...record.structuredExecution!, state: 'completed', threadId, turnId, output, resultDigest: hash(output) }
  return { sessionId: record.session, threadId, turnId, output, resultDigest: hash(output) }
}
async function fixture(existingRoot?: string, model?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'native-run-')), protocol = openProtocol(join(root, 'db.sqlite'))
  const cache = new Map<string, Buffer>()
  const blobIO = { put: (bytes: Buffer): BlobRef => { const sha256 = createHash('sha256').update(bytes).digest('hex'); cache.set(sha256, bytes); return { sha256 } }, read: (ref: BlobRef): Buffer => { const bytes = cache.get(ref.sha256); assert.ok(bytes); return bytes } }
  const manifestBlob = blobIO.put(Buffer.from('{"version":1,"entries":[]}'))
  await migrateSyncStore(protocol)
  const store = new SyncStore(protocol, { readBlob: blobIO.read })
  const source = { repositoryId: 'repo', commonDir: join(root, '.git'), canonicalRoot: root, gitDir: join(root, '.git'), branch: 'source', physicalFingerprint: 'physical-source' }
  const operation = store.admitAndEnqueue({ ingressKey: 'request', rootCauseId: 'cause', origin: 'spec', ...(model ? { model } : {}), input: { id: 'source-input', source, headCommit: 'a'.repeat(40), immutableTree: 'b'.repeat(40), indexTree: 'b'.repeat(40), indexDigest: 'c'.repeat(64), manifestBlob, contentDigest: 'd'.repeat(64), capturedAtMs: Date.now() }, scope: { paths: ['src/a.ts'], contractIds: ['RULE-A'], flowIds: [] }, budget: { maxCalls: 4, maxAttempts: 4, maxRepairs: 2, timeoutMs: 60000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: join(root, 'delivery'), branch: 'delivery', baseCommit: 'a'.repeat(40) } })
  const claimed = store.claimAttempt({ operationId: operation.id, source, scope: operation.scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
  const request = { root, base: 'a'.repeat(40), prompt: 'Return the frozen answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, requestKey: 'generation-1', inputDigest: 'elaboration-input', purpose: 'generation', timeoutMs: 5000, ...(model ? { model, effort: 'high' as const } : {}) }
  const records = new Map<string, NativeRunRecord>()
  const resource = () => store.findResource(claimed.attempt.id, request.requestKey)!
  const checkpoint = (): NativeRunCheckpoint => JSON.parse(blobIO.read(resource().checkpointRef).toString('utf8')) as NativeRunCheckpoint
  const runtimeBase = { readRecord: (id: string) => records.get(id) ?? null, cancel: async (): Promise<never> => { throw new Error('unexpected cancellation') } }
  const runner = (runtime: AttemptRunnerOptions['runtime']) => createAttemptRunner(store, claimed.fence, { runtime, blobIO, pollMs: 2 })
  return { root, store, claimed, request, records, resource, checkpoint, blobIO, cache, runtimeBase, runner, cleanup: () => { protocol.close(); if (!existingRoot) rmSync(root, { recursive: true, force: true }) } }
}

for (const model of ['claude:default', 'zcode:default']) for (const historical of [false, true]) test(`原生CLI配置仅冻结新resource，历史缺席与摘要保持 ${model}/${historical}`, async t => {
  const f = await fixture(undefined, model)
  try {
    const request = { ...f.request, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'edit' as const } }
    if (historical) f.store.reserveDispatch(f.claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest: hash(request) })
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async actual => {
      calls++
      assert.equal((actual as StructuredSessionRequest & { nativeConfiguration?: string }).nativeConfiguration, historical ? undefined : 'cli-config-v1')
      throw new StructuredSessionError('failed', 'mock-native-config-boundary')
    } })
    await assert.rejects(run(request), /mock-native-config-boundary/)
    const resource = f.resource(), bytes = f.blobIO.read(resource.plan.planBlob), plan = JSON.parse(bytes.toString()) as NativeRunPlan
    assert.equal((plan.request as typeof request & { nativeConfiguration?: string }).nativeConfiguration, historical ? undefined : 'cli-config-v1')
    assert.equal(plan.requestDigest, hash(plan.request))
    assert.equal(resource.plan.payloadDigest, plan.requestDigest)
    await t.test('实际持久Native请求可沿同一冻结规则冷验', () => {
      assert.equal(nativeReviewRequestMatches(plan.request, request, { attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }), true)
    })
    await t.test('新CLI沿原生effort而旧请求保内部high', () => {
      assert.equal(plan.request.effort, historical ? 'high' : undefined)
    })
    await assert.rejects(run(request), /mock-native-config-boundary/)
    assert.deepEqual(f.blobIO.read(f.resource().plan.planBlob), bytes)
    const changed = { ...request, nativeConfiguration: historical ? 'cli-config-v1' : 'unknown' } as typeof request
    await assert.rejects(run(changed), { code: 'key_reused' })
    for (const mutation of [{ model: 'claude:other-native-alias' }, { inputDigest: 'other-input' }, { root: join(f.root, 'other-source') }, { base: 'c'.repeat(40) }, { timeoutMs: null }])
      await assert.rejects(run({ ...request, ...mutation }), { code: 'key_reused' })
    assert.equal(calls, 2)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

for (const historical of [false, true]) test(`ZCode read resource freezes noninteractive tools only for new plans; historical=${historical}`, async () => {
  const f = await fixture(undefined, 'zcode:bigmodel-api/GLM-5.3-Flash')
  try {
    const request = { ...f.request, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const } }
    if (historical) {
      const requestDigest = hash(request), dispatch = f.store.reserveDispatch(f.claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
      const identity = { operationId: f.claimed.operation.id, attemptId: f.claimed.attempt.id, inputId: f.claimed.operation.input.id, candidateDigest: null }
      const expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
      const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
      const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
      f.store.planResource(f.claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: identity.inputId, candidateDigest: null, planBlob: f.blobIO.put(Buffer.from(JSON.stringify(plan))), checkpointRef: f.blobIO.put(Buffer.from(JSON.stringify(checkpoint))) })
    }
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async actual => {
      calls++
      assert.equal(actual.requestKey, request.requestKey)
      assert.equal(actual.sessionCreateKey, f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey)
      assert.deepEqual(actual.zcodeToolPolicy, historical ? undefined : { version: 1, toolDenylist: ['ExitPlanMode'] })
      assert.equal(actual.inputDigest, request.inputDigest)
      throw new StructuredSessionError('failed', 'mock-before-native-session')
    } })
    await assert.rejects(run(request), /mock-before-native-session/)
    const resource = f.resource(), planBytes = f.blobIO.read(resource.plan.planBlob), saved = JSON.parse(planBytes.toString()) as NativeRunPlan
    assert.deepEqual(saved.request.zcodeToolPolicy, historical ? undefined : { version: 1, toolDenylist: ['ExitPlanMode'] })
    assert.equal(saved.requestDigest, hash(saved.request))
    assert.equal(f.records.size, 0, 'the fixture covers persisted requests before any Native session or send')
    await assert.rejects(run(request), /mock-before-native-session/)
    assert.deepEqual(f.blobIO.read(f.resource().plan.planBlob), planBytes)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    const changed = { ...request, zcodeToolPolicy: { version: 1, toolDenylist: historical ? ['ExitPlanMode'] : ['ExitPlanMode', 'Bash'] } } as typeof request
    await assert.rejects(run(changed), { code: 'key_reused' })
    assert.equal(calls, 2, 'tampered control policy must not reach the native runtime')
  } finally { f.cleanup() }
})

for (const historical of [false, true, 'tool-policy-only', 'configured-high'] as const) test(`reserved-only ZCode dispatch restores its exact frozen request from a new store connection; historical=${historical}`, async t => {
  const f = await fixture(undefined, 'zcode:bigmodel-api/GLM-5.3-Flash')
  const coldProtocol = openProtocol(join(f.root, 'db.sqlite'))
  try {
    const request = { ...f.request, worktree: { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'read' as const } }
    const original = { ...request, ...(historical === false || historical === 'configured-high' ? { nativeConfiguration: 'cli-config-v1' as const } : {}), ...(historical === true ? {} : { zcodeToolPolicy: { version: 1 as const, toolDenylist: ['ExitPlanMode'] as const } }) }
    if (historical === false) delete original.effort
    const dispatch = f.store.reserveDispatch(f.claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest: hash(original) }), before = JSON.stringify(dispatch)
    assert.equal(f.resource(), null)
    let calls = 0
    const coldStore = new SyncStore(coldProtocol, { readBlob: f.blobIO.read })
    const run = createAttemptRunner(coldStore, f.claimed.fence, { blobIO: f.blobIO, pollMs: 2, runtime: { ...f.runtimeBase, run: async actual => {
      calls++
      assert.deepEqual(actual.zcodeToolPolicy, original.zcodeToolPolicy)
      assert.equal(actual.nativeConfiguration, original.nativeConfiguration)
      assert.equal(actual.effort, original.effort)
      assert.equal(actual.sessionCreateKey, dispatch.sessionCreateKey)
      throw new StructuredSessionError('failed', 'mock-before-native-session')
    } } })
    for (const changed of [
      { ...request, prompt: 'changed full request' },
      { ...request, schema: { type: 'object', additionalProperties: false } },
      { ...request, worktree: { ...request.worktree, tree: 'c'.repeat(40) } },
      { ...request, purpose: 'changed purpose' },
    ]) await assert.rejects(run(changed), { code: 'SYNC_DISPATCH_CONFLICT' })
    assert.equal(f.resource(), null); assert.equal(calls, 0)
    assert.equal(JSON.stringify(coldStore.readAttempt(f.claimed.attempt.id).dispatchPlans[0]), before)
    await assert.rejects(run(request), /mock-before-native-session/)
    const resource = f.resource(), saved = JSON.parse(f.blobIO.read(resource.plan.planBlob).toString()) as NativeRunPlan
    assert.deepEqual(saved.request, original)
    assert.equal(saved.requestDigest, dispatch.requestDigest)
    assert.equal(resource.plan.payloadDigest, dispatch.requestDigest)
    assert.equal(JSON.stringify(coldStore.readAttempt(f.claimed.attempt.id).dispatchPlans[0]), before)
    assert.equal(coldStore.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.records.size, 0); assert.equal(calls, 1)
    t.diagnostic(JSON.stringify({ historical, originalRequestDigest: dispatch.requestDigest, savedRequestDigest: hash(saved.request), dispatchUnchanged: JSON.stringify(coldStore.readAttempt(f.claimed.attempt.id).dispatchPlans[0]) === before, sessionCreateKeyUnchanged: saved.sessionCreateKey === dispatch.sessionCreateKey, callsUsed: coldStore.readOperation(f.claimed.operation.id).callsUsed, nativeRecords: f.records.size }))
  } finally { coldProtocol.close(); f.cleanup() }
})

test('native intent precedes run, published queued session is created with unknown thread, result binds exact identity and replays', async t => {
  const f = await fixture()
  try {
    let calls = 0, writes = 0, runningObservations = 0, finish: (value: StructuredSessionResult) => void = () => {}
    const bind = f.store.bindSession.bind(f.store)
    f.store.bindSession = (...args) => { writes++; return bind(...args) }
    const readRecord = (id: string): NativeRunRecord | null => {
      const record = f.runtimeBase.readRecord(id)
      if (record?.structuredExecution?.state === 'running') runningObservations++
      return record
    }
    const run = f.runner({ ...f.runtimeBase, readRecord, run: async request => {
      calls++
      assert.equal(f.resource().phase, 'planned')
      assert.equal(f.checkpoint().nativeCallRequested, true)
      assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
      const record = published(request); f.records.set(record.session, record)
      return new Promise<StructuredSessionResult>(resolve => { finish = resolve })
    } })
    const pending = run(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().nativeState, 'queued')
    assert.equal(f.checkpoint().session.threadId, null)
    const id = sessionIdForCreateKey(f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey)
    assert.equal(f.checkpoint().expectedSessionId, id)
    const record = f.records.get(id)!
    record.status = 'active'; record.harnessSessionId = 'actual-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'actual-thread', turnId: 'actual-turn', turnStartRequested: true }
    await waitUntil(() => f.store.readAttempt(f.claimed.attempt.id).currentSession?.turnId === 'actual-turn')
    assert.equal(f.checkpoint().nativeStarted, true)
    await waitUntil(() => runningObservations >= 8)
    const result = completed(record); finish(result)
    assert.deepEqual(await pending, result)
    t.diagnostic(JSON.stringify({ runningObservations, bindings: writes }))
    assert.equal(writes, 2, '只写已发布及真实thread/turn两次身份变化')
    assert.equal(f.resource().phase, 'removed')
    assert.deepEqual(f.checkpoint().result, result)
    f.store.requestControl(f.claimed.operation.id, 'cancel')
    assert.deepEqual(await run(f.request), result)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.ok(f.records.has(id))
    const ref = f.resource().checkpointRef
    f.cache.set(ref.sha256, Buffer.from('{"tampered":true}'))
    await assert.rejects(run(f.request), /evidence object digest is invalid/)
    assert.equal(calls, 1)
  } finally { f.cleanup() }
})

test('same key concurrent callers share one run and call budget; changed payload is refused', async () => {
  const f = await fixture()
  try {
    let calls = 0, finish: (value: StructuredSessionResult) => void = () => {}
    const run = f.runner({ ...f.runtimeBase, run: async request => { calls++; const record = published(request); f.records.set(record.session, record); return new Promise(resolve => { finish = resolve }) } })
    const first = run(f.request), second = run(f.request)
    await waitUntil(() => calls === 1)
    await assert.rejects(run({ ...f.request, prompt: 'different bytes' }), /key was reused/)
    finish(completed([...f.records.values()][0]))
    assert.deepEqual(await first, await second)
    await assert.rejects(run({ ...f.request, prompt: 'different bytes' }), /key was reused/)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('exactly stopped typed RPC failure removes its Native resource and replays the original failure without redispatch', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const message = 'ZCode native RPC timeout (session/create)'
    const runtime = { ...f.runtimeBase, run: async (request: StructuredSessionRequest): Promise<never> => {
      calls++
      const record = published(request)
      record.structuredExecution = { ...record.structuredExecution!, state: 'failed', errorCode: 'native_rpc_timeout', error: message, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } }
      f.records.set(record.session, record)
      throw new StructuredSessionError('native_rpc_timeout', message, { sessionId: record.session })
    } }
    const run = f.runner(runtime)
    for (let replay = 0; replay < 2; replay++) {
      await assert.rejects(run(f.request), error => { assert.equal((error as StructuredSessionError).code, 'native_rpc_timeout'); assert.equal((error as Error).message, message); return true })
      assert.equal(f.resource().phase, 'removed'); assert.equal(f.checkpoint().status, 'failed')
      assert.equal(f.checkpoint().stop?.state, 'failed'); assert.equal(f.checkpoint().stop?.nativeStopped, true)
      assert.equal(f.checkpoint().result, undefined)
    }
    assert.equal(calls, 1); assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('frozen native dispatch preserves business binding, uses actual attempt/policy and verifies proof on removed replay', async () => {
  const f = await fixture(undefined, 'gpt-6.1-terra'), directory = mkdtempSync(join(tmpdir(), 'native-run-frozen-'))
  try {
    const frozenContext = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: f.request.requestKey, inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('frozen task') }] })
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; assert.equal(request.requestKey, f.request.requestKey); assert.ok(request.sessionCreateKey)
      assert.equal(readFrozenManifest(request.frozenContext!).binding.attemptId, f.claimed.attempt.id)
      const record = published(request); f.records.set(record.session, record)
      const result = completed(record), args = { contextDigest: frozenContext.contextDigest, entryId: 'task', startByte: 0, endByte: 11 }
      const frozenReadProof = proveFrozenReads(frozenContext, { threadId: result.threadId, turnId: result.turnId }, [{ type: 'dynamicToolCall', id: 'controlled-call', namespace: null, tool: 'spex_read_frozen', arguments: args, status: 'completed', success: true, contentItems: readFrozenRange(frozenContext, args).response.contentItems }])
      record.structuredExecution!.frozenReadProof = frozenReadProof
      return { ...result, frozenReadProof }
    } })
    const request = { ...f.request, frozenContext }, result = await run(request)
    const plan = JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString()) as NativeRunPlan
    assert.equal(plan.request.model, 'gpt-6.1-terra'); assert.equal(plan.request.effort, 'high')
    assert.equal(plan.requestDigest, hash(plan.request)); assert.equal(f.records.get(result.sessionId)!.structuredExecution!.model, 'gpt-6.1-terra')
    await assert.rejects(run({ ...request, model: 'gpt-6-astra' }), /key was reused/)
    assert.equal(f.resource().phase, 'removed'); assert.equal(calls, 1)
    assert.deepEqual(await run(request), result); assert.equal(calls, 1)
    const bad = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: 'foreign', inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [] })
    await assert.rejects(run({ ...f.request, frozenContext: bad }), /requestKey/)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup(); rmSync(directory, { recursive: true, force: true }) }
})

for (const defect of ['claude-legacy', 'claude-model', 'zcode-provider', 'zcode-model'] as const) test(`v5/null ${defect} proof is refused live and on removed replay`, async () => {
  const model = defect.startsWith('claude') ? 'claude:MiniMax-M3.1-Flash' : 'zcode:bigmodel-api/GLM-5.3-Flash'
  const f = await fixture(undefined, model), directory = mkdtempSync(join(tmpdir(), 'native-v5-proof-'))
  try {
    const frozenContext = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: f.request.requestKey, inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('frozen task') }] })
    let calls = 0, bad: StructuredSessionResult | undefined
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; const record = published(request), result = completed(record); f.records.set(record.session, record)
      assert.equal(record.structuredExecution!.version, 5)
      const args = { contextDigest: frozenContext.contextDigest, entryId: 'task', startByte: 0, endByte: 11 }
      const coverage = proveFrozenReads(frozenContext, { threadId: result.threadId, turnId: result.turnId }, [{ type: 'dynamicToolCall', id: 'call', namespace: null, tool: 'spex_read_frozen', arguments: args, status: 'completed', success: true, contentItems: readFrozenRange(frozenContext, args).response.contentItems }])
      const frozenReadProof = defect === 'claude-legacy' ? coverage : defect === 'claude-model'
        ? { ...coverage, version: 3 as const, provider: 'claude-code' as const, promptId: 'prompt', model: 'foreign', cliVersion: '2.1.309', maxReadBytes: 65536 as const, maxResultSizeChars: 500000 as const }
        : { ...coverage, version: 4 as const, provider: 'zcode' as const, providerId: defect === 'zcode-provider' ? 'foreign' : 'bigmodel-api', modelId: defect === 'zcode-model' ? 'foreign' : 'GLM-5.3-Flash', cliVersion: '0.17.1', cliSha256: 'a'.repeat(64), inputId: 'input', promptDigest: 'b'.repeat(64), witnessDigest: 'c'.repeat(64) }
      bad = { ...result, frozenReadProof }; record.structuredExecution!.frozenReadProof = frozenReadProof
      return bad
    } })
    const request = { ...f.request, frozenContext, timeoutMs: null }, message = defect.startsWith('claude') ? /Claude result lacks its exact native provider\/model evidence/ : /ZCode result lacks its exact native provider\/model evidence/
    await assert.rejects(run(request), message)
    assert.notEqual(f.resource().phase, 'removed'); assert.equal(calls, 1)
    for (const phase of ['terminal', 'removed'] as const) {
      const current = f.resource(), checkpoint = { ...f.checkpoint(), phase, status: 'completed' as const, result: bad! }
      f.store.recordResourceCheckpoint(current.id, { operationId: checkpoint.operationId, attemptId: checkpoint.attemptId, inputId: checkpoint.inputId, candidateDigest: checkpoint.candidateDigest, phase, expectedCheckpointRef: current.checkpointRef, checkpointRef: f.blobIO.put(Buffer.from(JSON.stringify(checkpoint))) })
    }
    await assert.rejects(run(request), message); assert.equal(calls, 1)
  } finally { f.cleanup(); rmSync(directory, { recursive: true, force: true }) }
})

test('large native prompt freezes before reserveDispatch and reuses stable manifest on retry', async () => {
  const f = await fixture()
  try {
    const original = ' '.repeat(2 * 1024 * 1024) + 'frozen-tail'
    let first: StructuredSessionRequest | undefined, calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; assert.ok(request.frozenContext); assert.ok(request.prompt.length < 2048)
      assert.equal(request.inputDigest, f.request.inputDigest); assert.equal(request.requestKey, f.request.requestKey)
      const manifest = readFrozenManifest(request.frozenContext)
      assert.equal(manifest.entries[0].byteLength, Buffer.byteLength(original))
      assert.equal(manifest.binding.attemptId, f.claimed.attempt.id)
      if (first) assert.deepEqual({ ...request, signal: undefined }, { ...first, signal: undefined })
      else first = request
      const record = published(request); f.records.set(record.session, record)
      throw new Error('controlled unresolved native request')
    } })
    const request = { ...f.request, prompt: original }
    await assert.rejects(run(request), /controlled unresolved/)
    await assert.rejects(run(request), /controlled unresolved/)
    assert.equal(calls, 2); assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().phase, 'created')
  } finally { f.cleanup() }
})

test('pure JSON frozen entries bind the real attempt before dispatch and terminal replay does not call native again', async () => {
  const f = await fixture()
  try {
    const text = '\uFEFF原生计划正文'
    let calls = 0, preparedPrompt = ''
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++
      preparedPrompt = request.prompt
      assert.equal(request.frozenEntries, undefined)
      assert.ok(request.frozenContext)
      const manifest = readFrozenManifest(request.frozenContext)
      assert.equal(manifest.binding.attemptId, f.claimed.attempt.id)
      assert.equal(manifest.binding.policyDigest, f.claimed.operation.policyDigest)
      assert.equal(manifest.binding.requestKey, f.request.requestKey)
      assert.equal(manifest.binding.inputDigest, f.request.inputDigest)
      const entry = manifest.entries.find(item => item.sha256 === createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'))
      assert.equal(entry?.required, false)
      assert.equal(request.prompt.includes(text), false)
      const record = published(request); f.records.set(record.session, record)
      const result = completed(record)
      const frozenReadProof = proveFrozenReads(request.frozenContext, { threadId: result.threadId, turnId: result.turnId }, [])
      record.structuredExecution!.frozenReadProof = frozenReadProof
      return { ...result, frozenReadProof }
    } })
    const request = { ...f.request, frozenEntries: [{ id: 'note', label: 'optional note', required: false, kind: 'utf8' as const, text }] }
    const result = await run(request)
    const plan = JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString()) as NativeRunPlan
    assert.equal(plan.request.frozenEntries, undefined)
    assert.equal(JSON.stringify(plan.request).includes(text), false)
    assert.equal(plan.request.prompt, preparedPrompt)
    assert.equal(plan.requestDigest, hash(plan.request))
    assert.equal(f.resource().phase, 'removed'); assert.equal(calls, 1)
    assert.deepEqual(await run(request), result); assert.equal(calls, 1)
    assert.deepEqual(await run(plan.request), result); assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('exact legacy inline resource recovers after reader threshold change without rewriting its request or dispatch', async () => {
  const f = await fixture()
  try {
    const request = { ...f.request, prompt: 'x'.repeat(1_369_916) + '义'.repeat(82_260) + '尾部义' }, requestDigest = hash(request)
    assert.equal(request.prompt.length, 1_452_179); assert.equal(Buffer.byteLength(request.prompt), 1_616_705)
    const dispatch = f.store.reserveDispatch(f.claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    const record = published({ ...request, requestKey: dispatch.sessionCreateKey }), threadId = 'legacy-refused-first-thread'
    record.status = 'error'; record.harnessSessionId = threadId
    record.structuredExecution = { ...record.structuredExecution!, state: 'failed', threadId, turnStartRequested: true, error: 'legacy first turn refused' }
    f.records.set(record.session, record)
    const identity = { operationId: f.claimed.operation.id, attemptId: f.claimed.attempt.id, inputId: f.claimed.operation.input.id, candidateDigest: null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: record.session, ...identity }
    const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId: record.session, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'failed', session: { sessionId: record.session, threadId, turnId: null } }
    const put = (value: unknown) => f.blobIO.put(Buffer.from(JSON.stringify(value)))
    const resource = f.store.planResource(f.claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: identity.inputId, candidateDigest: null, planBlob: put(plan), checkpointRef: put(checkpoint) })
    f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: resource.checkpointRef, checkpointRef: put({ ...checkpoint, phase: 'created' }) })
    const beforeOperation = f.store.readOperation(f.claimed.operation.id), beforeAttempt = f.store.readAttempt(f.claimed.attempt.id)
    assert.ok(beforeAttempt.expiresAtMs > Date.now(), '证明清理时旧fence仍有效')
    let authorityChecks = 0, bindings = 0, newPlans = 0
    const reserve = f.store.reserveDispatch.bind(f.store), bind = f.store.bindSession.bind(f.store), planResource = f.store.planResource.bind(f.store)
    f.store.reserveDispatch = (...args) => { authorityChecks++; return reserve(...args) }
    f.store.bindSession = (...args) => { bindings++; return bind(...args) }
    f.store.planResource = (...args) => { newPlans++; return planResource(...args) }
    let calls = 0, stops = 0
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async () => { calls++; throw new Error('legacy recovery must not start native work') }, cancel: async id => {
      stops++; assert.equal(id, record.session)
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' } }
      return { sessionId: id, state: 'cancelled', threadId, nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' }
    } })
    const controller = new AbortController(); controller.abort()
    await assert.rejects(run({ ...request, signal: controller.signal }), /native execution cancelled and exact stop settled/)
    assert.equal(f.resource().phase, 'removed'); assert.equal(stops, 1); assert.equal(calls, 0)
    assert.equal(authorityChecks, 0, 'aborted清理不能检查或申请业务dispatch权')
    assert.equal(bindings, 0); assert.equal(newPlans, 0)
    assert.deepEqual(f.store.readOperation(f.claimed.operation.id), beforeOperation)
    assert.deepEqual(f.store.readAttempt(f.claimed.attempt.id), beforeAttempt)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().plan.payloadDigest, requestDigest)
    assert.deepEqual(JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString('utf8')), plan)
    await assert.rejects(run({ ...request, prompt: request.prompt + 'changed', signal: controller.signal }), /key was reused/)
    assert.equal(stops, 1); assert.equal(calls, 0); assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('transport failure leaves live resource; same-key recovery rejoins existing native turn without a new turn or budget', async () => {
  const f = await fixture()
  try {
    let calls = 0, nativeStarts = 0
    const runtime: NonNullable<AttemptRunnerOptions['runtime']> = { ...f.runtimeBase, run: async request => {
      calls++
      const id = sessionIdForCreateKey(request.requestKey)
      let record = f.records.get(id)
      if (!record) { nativeStarts++; record = published(request); record.status = 'active'; record.harnessSessionId = 'retained-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'retained-thread', turnId: 'retained-turn', turnStartRequested: true }; f.records.set(id, record) }
      if (calls === 1) throw new Error('transport disconnected')
      return completed(record)
    } }
    await assert.rejects(f.runner(runtime)(f.request), /transport disconnected/)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.store.listRecoverableResources().length, 1)
    const result = await f.runner(runtime)(f.request)
    assert.equal(result.threadId, 'retained-thread')
    assert.equal(result.turnId, 'retained-turn')
    assert.equal(calls, 2)
    assert.equal(nativeStarts, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().phase, 'removed')
  } finally { f.cleanup() }
})

test('incorrect native result identity, hash or published request binding is never delivered or marked removed', async () => {
  for (const defect of ['session', 'thread', 'hash', 'record_payload', 'record_model'] as const) {
    const f = await fixture()
    try {
      const run = f.runner({ ...f.runtimeBase, run: async request => {
        const record = published(request), result = completed(record); f.records.set(record.session, record)
        if (defect === 'record_payload') record.createPayloadHash = 'wrong-request-hash'
        if (defect === 'record_model') record.structuredExecution!.model = 'gpt-6-astra'
        return { ...result, ...(defect === 'session' ? { sessionId: 'wrong-session' } : {}), ...(defect === 'thread' ? { threadId: 'wrong-thread' } : {}), ...(defect === 'hash' ? { resultDigest: 'wrong-output-hash' } : {}) }
      } })
      await assert.rejects(run(f.request), /invalid|differs/)
      assert.notEqual(f.resource().phase, 'removed')
      assert.equal(f.store.listRecoverableResources().length, 1)
    } finally { f.cleanup() }
  }
})

for (const timeoutMs of [5000, null]) test(`cancel acknowledgement loss with timeout=${timeoutMs} still settles exact resources after fence revocation`, async () => {
  const f = await fixture()
  try {
    let cancellations = 0
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async request => {
      const record = published(request); record.status = 'active'; record.harnessSessionId = 'thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread', turnId: 'turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true }))
    }, cancel: async (id, options) => {
      assert.equal(options?.timeoutMs, timeoutMs === null ? 15000 : timeoutMs)
      cancellations++; assert.equal(id, f.checkpoint().expectedSessionId)
      const record = f.records.get(id)!
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' } }
      throw new Error('cancel reply lost')
    } })
    const pending = run({ ...f.request, timeoutMs })
    await waitUntil(() => f.resource()?.phase === 'created')
    f.store.requestControl(f.claimed.operation.id, 'cancel')
    await assert.rejects(pending, /cancel reply lost/)
    assert.equal(cancellations, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().stop?.nativeStopped, true)
    assert.equal(f.checkpoint().stop?.turnId, 'turn')
    assert.equal(f.store.readAttempt(f.claimed.attempt.id).status, 'superseded')
    assert.equal(f.store.readOperation(f.claimed.operation.id).phase, 'cancelled')
    assert.throws(() => f.store.reserveDispatch(f.claimed.fence, { key: 'new-call', purpose: 'generation', requestDigest: 'new' }), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})

test('unproven native cancellation keeps resource for restart and subsequent exact stop recovery never reruns native creation', async () => {
  const f = await fixture()
  try {
    let calls = 0, stops = 0
    const runtime: NonNullable<AttemptRunnerOptions['runtime']> = { readRecord: f.runtimeBase.readRecord, run: async request => {
      calls++; const record = published(request); record.status = 'active'; record.harnessSessionId = 'thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread', turnId: 'turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('local promise finished')), { once: true }))
    }, cancel: async id => {
      stops++; const record = f.records.get(id)!
      const proved = stops > 1
      record.structuredExecution = { ...record.structuredExecution!, state: proved ? 'cancelled' : 'cancelling', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: proved, acknowledged: true, nativeStatus: proved ? 'interrupted' : 'active' } }
      return { sessionId: id, state: proved ? 'cancelled' : 'cancelling', threadId: 'thread', turnId: 'turn', nativeStopped: proved, acknowledged: true, nativeStatus: proved ? 'interrupted' : 'active' }
    } }
    const pending = f.runner(runtime)(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, /not been proven/)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.store.listRecoverableResources().length, 1)
    await assert.rejects(f.runner(runtime)(f.request), /cancelled and exact stop settled/)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(calls, 1)
    assert.equal(stops, 2)
  } finally { f.cleanup() }
})

test('superseding source aborts only the old exact session and settles its resource without giving the old attempt write authority', async () => {
  const f = await fixture()
  try {
    let cancelledId: string | undefined
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async request => {
      const record = published(request); record.status = 'active'; record.harnessSessionId = 'old-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'old-thread', turnId: 'old-turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('old observer aborted')), { once: true }))
    }, cancel: async id => {
      cancelledId = id
      const record = f.records.get(id)!
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' } }
      return { sessionId: id, state: 'cancelled', threadId: 'old-thread', turnId: 'old-turn', nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' }
    } })
    const pending = run(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    const old = f.store.readOperation(f.claimed.operation.id)
    const next = f.store.admitAndEnqueue({ ...old, ingressKey: 'new-source', input: { ...old.input, id: 'new-source' } })
    await assert.rejects(pending, /cancelled and exact stop settled/)
    assert.equal(cancelledId, f.checkpoint().expectedSessionId)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.store.readOperation(old.id).phase, 'superseded')
    assert.equal(f.store.readOperation(next.id).phase, 'queued')
    assert.throws(() => f.store.bindSession(f.claimed.fence, f.request.requestKey, { sessionId: cancelledId!, threadId: 'new-thread', turnId: 'new-turn' }), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})

test('terminal result persisted before removal survives a local failure and replays without another native call', async () => {
  const f = await fixture()
  try {
    let calls = 0, failRemoval = true
    const runtime = { ...f.runtimeBase, run: async (request: StructuredSessionRequest) => { calls++; const record = published(request); f.records.set(record.session, record); return completed(record) } }
    const blobIO = { ...f.blobIO, put: (bytes: Buffer): BlobRef => {
      const value = JSON.parse(bytes.toString('utf8')) as { phase?: string }
      if (failRemoval && value.phase === 'removed') { failRemoval = false; throw new Error('local crash before removed checkpoint') }
      return f.blobIO.put(bytes)
    } }
    await assert.rejects(createAttemptRunner(f.store, f.claimed.fence, { runtime, blobIO, pollMs: 2 })(f.request), /local crash/)
    assert.equal(f.resource().phase, 'terminal')
    const result = await f.runner(runtime)(f.request)
    assert.equal(result.resultDigest, hash(result.output))
    assert.equal(f.resource().phase, 'removed')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('resource binding takes the actual durable frozen candidate instead of assuming null', async () => {
  const f = await fixture()
  try {
    const input = f.store.readOperation(f.claimed.operation.id).input
    f.store.bindComposedInput(f.claimed.fence, { sourceInputId: input.id, previousBaselinePairId: null, tree: input.immutableTree, manifestBlob: input.manifestBlob, contentDigest: input.contentDigest })
    f.store.startGeneration(f.claimed.fence)
    f.store.freezeCandidate(f.claimed.fence, { sourceInputId: input.id, baseTree: input.immutableTree, tree: 'e'.repeat(40), digest: 'actual-frozen-candidate', manifestBlob: input.manifestBlob, actualDiffBlob: f.blobIO.put(Buffer.from('[]')), coveredScope: f.claimed.operation.scope })
    const run = f.runner({ ...f.runtimeBase, run: async request => { assert.equal(f.resource().plan.candidateDigest, 'actual-frozen-candidate'); const record = published(request); f.records.set(record.session, record); return completed(record) } })
    await run(f.request)
    assert.equal(f.checkpoint().candidateDigest, 'actual-frozen-candidate')
  } finally { f.cleanup() }
})

test('already aborted request proves notDispatched without creating or cancelling a session', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController(); controller.abort()
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async () => { calls++; throw new Error('unexpected dispatch') } })
    await assert.rejects(run({ ...f.request, signal: controller.signal }), /cancelled before dispatch/)
    assert.equal(calls, 0)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().stop?.nativeStatus, 'notDispatched')
  } finally { f.cleanup() }
})


test('creation cancellation does not release unpublished resources before the create transaction ends', async () => {
  const f = await fixture()
  let finishCreation: () => void = () => {}
  try {
    let calls = 0, cancelled = false
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++
      return new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => { cancelled = true }, { once: true })
        finishCreation = () => reject(new Error('creation transaction still lacks an exact durable stop receipt'))
      })
    } })
    const input = { ...f.request, timeoutMs: 50 }
    const pending = run(input)
    await waitUntil(() => calls === 1)
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, /absence alone does not confirm stop/)
    assert.equal(cancelled, true)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.store.listRecoverableResources().length, 1)
    finishCreation()
    await assert.rejects(f.runner({ ...f.runtimeBase, run: async () => { calls++; throw new Error('must not redispatch cancelled creation') } })(input), /absence alone does not confirm stop/)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { finishCreation(); f.cleanup() }
})


test('exact unpublished creation termination settles only after cleanup and replays without another call', async () => {
  const f = await fixture()
  try {
    let calls = 0, cancelled = false
    let termination: { version: 1; sessionId: string; requestDigest: string; payloadHash: string; code: 'session_create_cancelled'; phase: 'git-worktree'; nativeStopped: true; nativeStatus: 'notStarted'; cleanupComplete: true } | null = null
    const creationReceipt = { readCreateTermination: () => termination }
    const run = f.runner({ ...f.runtimeBase, ...creationReceipt, run: async request => {
      calls++
      const record = published(request)
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      assert.equal(f.resource().phase, 'planned', 'resource remains held while creation cleans up')
      termination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_cancelled', phase: 'git-worktree', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
      throw new StructuredSessionError('cancelled', 'session creation cancelled after exact cleanup')
    } })
    const pending = run(f.request)
    await waitUntil(() => calls === 1)
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancelled')
    assert.equal(cancelled, true)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().stop?.nativeStatus, 'notStarted')
    assert.equal(f.records.size, 0)
    await assert.rejects(f.runner({ ...f.runtimeBase, ...creationReceipt, run: async () => { calls++; throw new Error('cancelled creation cannot be recreated') } })(f.request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})


for (const creationPhase of ['target-resolution', 'git-worktree', 'cleanup-failed', 'cleanup-preserved', 'cleanup-interrupted', 'cleanup-rebuilt-path', 'cleanup-advanced-branch', 'published-concurrent'] as const) test(`real Git creation abort ${creationPhase} holds capacity through cleanup and restart reads exact termination without redispatch`, { timeout: 25_000 }, async () => {
  const childMode = process.env.SPEX_NATIVE_CREATE_PROOF_MODE
  if (childMode) {
    const f = await fixture(process.cwd())
    try {
      const request = { ...f.request, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
      const sourceIndex = readFileSync(join(process.cwd(), '.git', 'index')), sourceReadme = readFileSync('README')
      const userPath = join(process.cwd(), 'user-worktree'), userReadme = readFileSync(join(userPath, 'README'))
      let calls = 0, creationError: unknown
      const runtime = { run: async (input: StructuredSessionRequest) => { calls++; try { return await runStructuredSession(input) } catch (error) { creationError = error; throw error } }, cancel: cancelStructuredSession, readRecord: (await import('../session-record.js')).readRecord, readCreateTermination: readSessionCreateTermination }
      const run = f.runner(runtime)
      const pending = run(request)
      await waitUntil(() => existsSync(process.env.SPEX_NATIVE_CREATE_PROOF_TRACE!))
      assert.equal(f.resource().phase, 'planned')
      assert.equal(f.checkpoint().nativeCallRequested, true)
      assert.equal(f.checkpoint().nativeStarted, false)
      const createKey = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey
      assert.equal(readSessionCreateTermination(createKey), null)
      const waiterController = new AbortController()
      const waiter = (await import('../sessions.js')).sessionCreateRequest({ prompt: request.prompt, base: request.base }, { requestKey: createKey, signal: waiterController.signal, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      waiterController.abort()
      const waited = await waiter
      assert.equal(waited.status, 408)
      assert.equal(readSessionCreateTermination(createKey), null, 'a cancelled lock waiter cannot prove the admitted creator ended')
      assert.equal(f.resource().phase, 'planned')
      f.store.requestControl(f.claimed.operation.id, 'pause')
      if (creationPhase.startsWith('cleanup-') || creationPhase === 'published-concurrent') {
        await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancellation_pending')
        await waitUntil(() => creationError !== undefined, 12_000)
        assert.equal(readSessionCreateTermination(createKey), null)
        assert.equal(f.resource().phase, 'planned')
        assert.equal(f.store.listRecoverableResources().length, 1)
        assert.ok(creationError instanceof StructuredSessionError)
        assert.equal(creationError.code, 'failed')
        assert.match(creationError.message, /cleanup left residue/)
        if (creationPhase === 'cleanup-interrupted') assert.match(creationError.message, /during branch delete \(cleanup deadline expired\)/)
        const record = published({ ...request, requestKey: createKey })
        const recoveryOptions = { prompt: request.prompt, payloadHash: record.createPayloadHash!, base: request.base, signal: AbortSignal.timeout(5000), structuredExecution: record.structuredExecution! }
        await assert.rejects(recoverSessionCreateTermination(createKey, { ...recoveryOptions, payloadHash: '0'.repeat(64) }), /does not match cancelled create request/)
        if (creationPhase === 'cleanup-preserved') {
          const { runtimeRoot } = await import('@spexcode/spec-core')
          const preparedPath = join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`), preparedBytes = readFileSync(preparedPath)
          const candidate = JSON.parse(preparedBytes.toString()) as { path: string; branch: string }
          const gitDir = execFileSync('git', ['-C', candidate.path, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
          rmSync(join(gitDir, 'index')); writeFileSync(join(gitDir, 'locked'), 'initializing\n')
          writeFileSync(join(candidate.path, 'README'), 'retained user bytes\n')
          const branchBefore = execFileSync('git', ['rev-parse', `refs/heads/${candidate.branch}`], { encoding: 'utf8' })
          const operationBefore = f.store.readOperation(f.claimed.operation.id), attemptBefore = f.store.readAttempt(f.claimed.attempt.id)
          const recoveryRequest = { ...request, signal: AbortSignal.abort() }
          let recoveryCalls = 0
          const recoverCreateTermination: typeof recoverSessionCreateTermination = async (key, options) => {
            recoveryCalls++; assert.equal(options.resourceRecoveryOnly, true)
            return recoverSessionCreateTermination(key, options)
          }
          const stoppedRuntime = { ...runtime, run: async (): Promise<never> => { throw new Error('preserved recovery must not dispatch native') }, recoverCreateTermination }
          const recoveryRunner = () => createAttemptRunner(f.store, f.claimed.fence, { resourceRecoveryOnly: true, runtime: stoppedRuntime, blobIO: f.blobIO, pollMs: 2 })
          const save = f.store.recordResourceCheckpoint.bind(f.store)
          f.store.recordResourceCheckpoint = (id, update) => {
            if (update.phase === 'removed') throw new Error('controlled failure after preserved terminal')
            return save(id, update)
          }
          await assert.rejects(recoveryRunner()(recoveryRequest), /controlled failure after preserved terminal/)
          assert.equal(f.resource().phase, 'terminal')
          const receipt = readSessionCreateTermination(createKey)
          assert.equal(receipt?.version, 2)
          assert.equal(receipt?.cleanupComplete, false)
          assert.equal(f.checkpoint().creationTermination?.version, 2)
          const terminationPath = join(runtimeRoot(), '.session-create-terminations', `${record.session}.json`), terminationBytes = readFileSync(terminationPath)
          f.store.recordResourceCheckpoint = save
          rmSync(terminationPath)
          await assert.rejects(recoveryRunner()(recoveryRequest), /canonical receipt is missing/)
          assert.equal(f.resource().phase, 'terminal', 'missing proof cannot turn terminal into removed')
          writeFileSync(terminationPath, terminationBytes)
          await assert.rejects(recoveryRunner()(recoveryRequest), error => error instanceof StructuredSessionError && error.code === 'cancelled')
          assert.equal(f.resource().phase, 'removed')
          writeFileSync(preparedPath, Buffer.concat([preparedBytes, Buffer.from('\n')]))
          await assert.rejects(recoveryRunner()(recoveryRequest), /original receipt differs/)
          writeFileSync(preparedPath, preparedBytes)
          const application = (await import('../session-application.js')).configuredSessionApplication()
          const { fromRaw, writeRecord } = await import('../session-record.js')
          const ownerId = sessionIdForCreateKey('later retained candidate owner')
          application.createSession({ sessionId: ownerId, status: 'idle' })
          writeRecord(fromRaw({ session_id: ownerId, governed: true, worktree_path: candidate.path, branch: candidate.branch, title: null, name: null, status: 'idle', proposal: null, merges: 0, note: null, sortkey: null, createdAt: 0, stopped: true }))
          const ownerBefore = application.readState(ownerId), ownerRecordBefore = runtime.readRecord(ownerId)
          await assert.rejects(recoveryRunner()(recoveryRequest), error => error instanceof StructuredSessionError && error.code === 'cancelled')
          assert.deepEqual(application.readState(ownerId), ownerBefore)
          assert.deepEqual(runtime.readRecord(ownerId), ownerRecordBefore)
          assert.deepEqual(f.store.readOperation(f.claimed.operation.id), operationBefore)
          assert.deepEqual(f.store.readAttempt(f.claimed.attempt.id), attemptBefore)
          assert.equal(calls, 1); assert.equal(recoveryCalls, 1)
          assert.deepEqual(readFileSync(preparedPath), preparedBytes)
          assert.equal(readFileSync(join(candidate.path, 'README'), 'utf8'), 'retained user bytes\n')
          assert.equal(existsSync(join(gitDir, 'index')), false)
          assert.equal(readFileSync(join(gitDir, 'locked'), 'utf8'), 'initializing\n')
          assert.equal(execFileSync('git', ['rev-parse', `refs/heads/${candidate.branch}`], { encoding: 'utf8' }), branchBefore)
          assert.deepEqual(readFileSync(join(process.cwd(), '.git', 'index')), sourceIndex)
          assert.deepEqual(readFileSync('README'), sourceReadme)
          assert.deepEqual(readFileSync(join(userPath, 'README')), userReadme)
          console.log(JSON.stringify({ creationTermination: receipt, resource: f.resource().phase, phases: ['planned', 'terminal', 'removed'], nativeStarted: false, calls, callsUsed: operationBefore.callsUsed, replay: 'authenticated' }))
          return
        }
        if (creationPhase === 'cleanup-failed') {
          await assert.rejects(recoverSessionCreateTermination(createKey, { ...recoveryOptions, structuredExecution: undefined }), /does not match cancelled create request/)
          process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = 'recovery'
          const { runtimeRoot } = await import('@spexcode/spec-core')
          const candidate = JSON.parse(readFileSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`), 'utf8')) as { path: string }
          assert.equal(dirname(candidate.path), join(realpathSync(runtimeRoot()), 'structured-worktrees'))
          const original = readFileSync(join(candidate.path, 'README'))
          for (const kind of ['unstaged', 'staged', 'untracked', 'ignored'] as const) {
            const userFile = join(candidate.path, kind === 'unstaged' || kind === 'staged' ? 'README' : `${kind}-user-data`)
            writeFileSync(userFile, `user ${kind} content\n`)
            if (kind === 'staged') execFileSync('git', ['-C', candidate.path, 'add', 'README'])
            if (kind === 'ignored') writeFileSync(join(process.cwd(), '.git', 'info', 'exclude'), 'ignored-user-data\n')
            await assert.rejects(recoverSessionCreateTermination(createKey, recoveryOptions), /preserving user edits/)
            assert.equal(readFileSync(userFile, 'utf8'), `user ${kind} content\n`)
            assert.equal(f.resource().phase, 'planned')
            assert.equal(readSessionCreateTermination(createKey), null)
            if (kind === 'unstaged' || kind === 'staged') {
              writeFileSync(userFile, original)
              execFileSync('git', ['-C', candidate.path, 'reset', '-q', request.base, '--', 'README'])
            } else rmSync(userFile)
          }
        }
        if (creationPhase === 'cleanup-rebuilt-path' || creationPhase === 'cleanup-advanced-branch') {
          const { runtimeRoot } = await import('@spexcode/spec-core')
          const candidate = JSON.parse(readFileSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`), 'utf8')) as { path: string; branch: string }
          const ref = `refs/heads/${candidate.branch}`
          const advanced = execFileSync('git', ['commit-tree', `${request.base}^{tree}`, '-p', request.base, '-m', 'concurrent user commit'], { encoding: 'utf8' }).trim()
          process.env.SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH = candidate.path
          process.env.SPEX_NATIVE_CREATE_PROOF_CANDIDATE_REF = ref
          process.env.SPEX_NATIVE_CREATE_PROOF_ADVANCED = advanced
          process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = creationPhase === 'cleanup-rebuilt-path' ? 'recovery-rebuilt-path' : 'recovery-advanced-branch'
          await assert.rejects(async () => {
            const result = await recoverSessionCreateTermination(createKey, recoveryOptions)
            console.log(JSON.stringify({ unexpectedRecovery: creationPhase, termination: result, rebuiltPathPreserved: existsSync(join(candidate.path, 'concurrent-user-data')), advancedBranchPreserved: execFileSync('git', ['for-each-ref', ref, '--format=%(objectname)'], { encoding: 'utf8' }).trim() === advanced }))
            return result
          }, /matching candidate recovery left residue/)
          assert.equal(readSessionCreateTermination(createKey), null)
          assert.equal(f.resource().phase, 'planned')
          assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
          assert.equal(calls, 1)
          assert.ok(existsSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`)))
          if (creationPhase === 'cleanup-rebuilt-path') {
            assert.equal(readFileSync(join(candidate.path, 'concurrent-user-data'), 'utf8'), 'concurrent user content\n')
            rmSync(candidate.path, { recursive: true })
          } else {
            assert.equal(execFileSync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' }).trim(), advanced)
            execFileSync('git', ['update-ref', ref, request.base, advanced])
            const hook = join(process.cwd(), '.git', 'hooks', 'reference-transaction')
            writeFileSync(hook, '#!/bin/sh\nif [ "$1" = committed ]; then cat >> "$SPEX_NATIVE_CREATE_PROOF_REF_TRACE"; fi\n')
            chmodSync(hook, 0o755)
          }
        }
        if (creationPhase === 'published-concurrent') {
          const { withRecordLock } = await import('../session-record.js')
          let unlock: () => void = () => {}, admitted: () => void = () => {}, settled = false
          const locked = new Promise<void>(resolve => { admitted = resolve })
          const publisher = withRecordLock(record.session, async () => { admitted(); await new Promise<void>(resolve => { unlock = resolve }); (await import('../session-application.js')).configuredSessionApplication().createSession({ sessionId: record.session, status: 'queued' }) })
          await locked
          const before = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
          const recovery = recoverSessionCreateTermination(createKey, recoveryOptions).then(value => { settled = true; return value })
          await new Promise<void>(resolve => setTimeout(resolve, 25))
          assert.equal(settled, false, 'recovery cannot overtake the creator publication fence')
          unlock(); await publisher
          assert.equal(await recovery, null, 'canonical publication without an envelope still refuses notStarted cleanup')
          assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }), before)
          assert.equal(readSessionCreateTermination(createKey), null)
          assert.equal(f.resource().phase, 'planned')
          assert.equal(calls, 1)
          console.log(JSON.stringify({ cleanupFailure: creationError.message, publishedPreserved: true, resource: f.resource().phase, calls }))
          return
        }
        process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = 'recovery'
        await assert.rejects(createAttemptRunner(f.store, f.claimed.fence, { blobIO: f.blobIO, pollMs: 2 })(request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
        assert.equal(calls, 1)
      }
      else await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancelled')
      const receipt = readSessionCreateTermination(createKey)
      assert.ok(receipt)
      assert.equal(receipt.cleanupComplete, true)
      assert.equal(receipt.phase, creationPhase.startsWith('cleanup-') ? 'cleanup' : creationPhase)
      assert.equal(receipt.nativeStatus, 'notStarted')
      if (creationPhase === 'cleanup-advanced-branch') assert.match(readFileSync(process.env.SPEX_NATIVE_CREATE_PROOF_REF_TRACE!, 'utf8'), new RegExp(`${request.base} 0+ refs/heads/codex/`), 'successful expected-old deletion must run the normal reference transaction hook')
      assert.equal(f.resource().phase, 'removed')
      assert.equal(runtime.readRecord(receipt.sessionId), null)
      assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).match(/^worktree /gm)?.length, 2)
      assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/codex', '--format=%(refname)'], { encoding: 'utf8' }).trim(), '')
      assert.deepEqual(readFileSync(join(process.cwd(), '.git', 'index')), sourceIndex)
      assert.deepEqual(readFileSync('README'), sourceReadme)
      assert.deepEqual(readFileSync(join(userPath, 'README')), userReadme)
      assert.equal(execFileSync('git', ['-C', userPath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), 'user-work')
      const terminated = await (await import('../sessions.js')).sessionCreateRequest({ prompt: request.prompt, base: request.base }, { requestKey: createKey, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      assert.notEqual(terminated.status, 201)
      if (terminated.status === 201) assert.fail('terminated creation published')
      assert.equal(terminated.code, 'session_create_cancelled')
      assert.equal(terminated.status, 408)
      const changed = await (await import('../sessions.js')).sessionCreateRequest({ prompt: 'different operation', base: request.base }, { requestKey: createKey, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      assert.notEqual(changed.status, 201)
      if (changed.status === 201) assert.fail('changed creation published')
      assert.equal(changed.code, 'session_create_key_reused')
      const replayScript = `import{readSessionCreateTermination,sessionCreateRequest}from${JSON.stringify(fileURLToPath(new URL('../sessions.ts', import.meta.url)))};import{readFileSync,writeFileSync}from'node:fs';const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const before=readSessionCreateTermination(input.key);const result=await sessionCreateRequest(input.body,{requestKey:input.key,structuredExecution:input.execution});writeFileSync(process.argv[3],JSON.stringify({before,result}));process.exit();`
      const replayPath = join(process.cwd(), 'replay.mts'), inputPath = join(process.cwd(), 'replay-input.json'), outputPath = join(process.cwd(), 'replay-output.json')
      writeFileSync(replayPath, replayScript)
      writeFileSync(inputPath, JSON.stringify({ key: createKey, body: { prompt: request.prompt, base: request.base }, execution: published({ ...request, requestKey: createKey }).structuredExecution }))
      const replayed = spawnSync(process.execPath, ['--import', tsxImport, replayPath, inputPath, outputPath], { encoding: 'utf8', timeout: 5000, env: process.env })
      assert.equal(replayed.status, 0, replayed.stderr)
      const replay = JSON.parse(readFileSync(outputPath, 'utf8')) as { before: unknown; result: { status: number; code: string } }
      assert.deepEqual(replay.before, receipt)
      assert.equal(replay.result.status, 408)
      assert.equal(replay.result.code, 'session_create_cancelled')
      await assert.rejects(run(request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
      assert.equal(calls, 1)
      assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
      assert.equal(readFileSync(process.env.SPEX_NATIVE_CREATE_PROOF_TRACE!, 'utf8').trim().split('\n').length, 1)
      console.log(JSON.stringify({ creationTermination: receipt, resource: f.resource().phase, nativeStarted: f.checkpoint().nativeStarted, calls, callsUsed: f.store.readOperation(f.claimed.operation.id).callsUsed, replay: replay.result.code }))
    } finally { f.cleanup() }
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'native-real-create-')), repo = join(root, 'repo'), bin = join(root, 'bin'), trace = join(root, 'git-create-trace')
  try {
    mkdirSync(join(repo, '.spec'), { recursive: true }); mkdirSync(bin)
    writeFileSync(join(repo, '.spec', 'spexcode.json'), JSON.stringify({ mainBranch: 'main', branchPrefix: 'codex/', sessions: { maxActive: 1 } }))
    writeFileSync(join(repo, 'README'), 'creation cancellation fixture\n')
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'fixture']]) execFileSync('git', ['-C', repo, ...args])
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'user-work', join(repo, 'user-worktree')])
    writeFileSync(join(repo, 'README'), 'user staged input\n'); execFileSync('git', ['-C', repo, 'add', 'README'])
    writeFileSync(join(repo, 'README'), 'user unstaged input\n')
    writeFileSync(join(repo, 'user-worktree', 'README'), 'other user worktree input\n')
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in *" branch -D "*) ${JSON.stringify(gitPath)} "$@" || exit $?; if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = cleanup-interrupted ]; then sleep 30; fi ;; *" worktree remove "*) case "$SPEX_NATIVE_CREATE_PROOF_PHASE" in cleanup-failed|cleanup-preserved|cleanup-rebuilt-path|cleanup-advanced-branch|published-concurrent) printf 'controlled cleanup failure\\n' >&2; exit 17 ;; recovery-rebuilt-path) ${JSON.stringify(gitPath)} "$@" || exit $?; mkdir -p "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH"; printf 'concurrent user content\\n' > "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH/concurrent-user-data" ;; recovery-advanced-branch) ${JSON.stringify(gitPath)} "$@" || exit $?; exec ${JSON.stringify(gitPath)} update-ref "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_REF" "$SPEX_NATIVE_CREATE_PROOF_ADVANCED" ;; *) exec ${JSON.stringify(gitPath)} "$@" ;; esac ;; *" rev-parse --verify --quiet "*) if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = target-resolution ]; then printf 'target\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30; else exec ${JSON.stringify(gitPath)} "$@"; fi ;; *" worktree add "*) ${JSON.stringify(gitPath)} "$@" || exit $?; printf 'created\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30 ;; *) exec ${JSON.stringify(gitPath)} "$@" ;; esac
`)
    chmodSync(join(bin, 'git'), 0o755)
    const result = spawnSync(process.execPath, ['--import', tsxImport, '--test', '--test-name-pattern', `^real Git creation abort ${creationPhase}`, fileURLToPath(import.meta.url)], { cwd: repo, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEX_SESSION_DATABASE_PATH: join(root, 'home', 'sessions.sqlite'), PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: join(root, 'home'), SPEX_NATIVE_CREATE_PROOF_MODE: 'child', SPEX_NATIVE_CREATE_PROOF_PHASE: creationPhase, SPEX_NATIVE_CREATE_PROOF_TRACE: trace, SPEX_NATIVE_CREATE_PROOF_REF_TRACE: join(root, 'ref-trace') } })
    if (process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR) {
      mkdirSync(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, `native-create-${creationPhase}.log`), `${result.stdout}\n${result.stderr}`)
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /creationTermination|cleanupFailure/, 'the nested real Git fixture must actually execute')
    console.log(result.stdout.split('\n').find(line => line.includes('"creationTermination"') || line.includes('"cleanupFailure"')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('restart with an exact creation termination settles held resource without calling runtime even while its fence is valid', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('creation observer transport lost') } }
    await assert.rejects(f.runner(runtime)(f.request), /transport lost/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'target-resolution', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    const settledRunner = f.runner({ ...runtime, readCreateTermination: () => receipt })
    const assertSettledTimeout = (error: unknown): boolean => {
      assert.ok(error instanceof SettledSessionCreateTimeoutError)
      assert.equal(error.code, 'timeout')
      assert.deepEqual(error.termination, receipt)
      return true
    }
    await assert.rejects(settledRunner(f.request), assertSettledTimeout)
    await assert.rejects(settledRunner(f.request), assertSettledTimeout, 'removed replay retains the exact settled creation timeout subtype')
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().creationTermination?.code, 'session_create_timeout')
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('timeout without an exact creation termination receipt is not classified as a settled retry', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new StructuredSessionError('timeout', 'creation observer timed out without a termination receipt') } }
    await assert.rejects(f.runner(runtime)(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error.code, 'timeout')
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(f.checkpoint().nativeCallRequested, true)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('terminal create timeout checkpoint resumes terminal-to-removed with its exact subtype', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('creation observer transport lost') } }
    await assert.rejects(f.runner(runtime)(f.request), /transport lost/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    const resource = f.resource(), checkpoint = f.checkpoint(), terminal: NativeRunCheckpoint = {
      ...checkpoint,
      phase: 'terminal',
      status: 'timeout',
      creationTermination: receipt,
      stop: { sessionId: record.session, state: 'timeout', nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' },
    }
    f.store.recordResourceCheckpoint(resource.id, {
      operationId: checkpoint.operationId, attemptId: checkpoint.attemptId, inputId: checkpoint.inputId, candidateDigest: checkpoint.candidateDigest,
      phase: 'terminal', expectedCheckpointRef: resource.checkpointRef, checkpointRef: f.blobIO.put(Buffer.from(JSON.stringify(terminal))),
    })
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof SettledSessionCreateTimeoutError)
      assert.deepEqual(error.termination, receipt)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

for (const defect of ['session', 'request', 'payload', 'cleanup', 'native', 'schema', 'v1-preserved', 'v2-cleaned', 'v2-timeout', 'v2-forged'] as const) test(`creation termination ${defect} mismatch cannot settle or dispatch`, async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('observer disconnected') } }
    await assert.rejects(f.runner(runtime)(f.request), /disconnected/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_cancelled', phase: 'git-worktree', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    if (defect === 'session') receipt.sessionId = 'other-session'
    if (defect === 'request') receipt.requestDigest = textHash('other-request')
    if (defect === 'payload') receipt.payloadHash = hash('other-payload')
    if (defect === 'cleanup') Object.assign(receipt, { cleanupComplete: false })
    if (defect === 'native') Object.assign(receipt, { nativeStopped: false })
    if (defect === 'schema') receipt.version = 2 as 1
    if (defect === 'v1-preserved') Object.assign(receipt, { disposition: 'preserved', retained: {} })
    if (defect.startsWith('v2-')) {
      Object.assign(receipt, { version: 2, disposition: 'preserved', cleanupComplete: false, phase: 'cleanup', retained: { root: f.root } })
      if (defect === 'v2-cleaned') Object.assign(receipt, { cleanupComplete: true })
      if (defect === 'v2-timeout') Object.assign(receipt, { code: 'session_create_timeout' })
    }
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      assert.match(error.message, /termination differs|preserved candidate/)
      return true
    })
    assert.equal(f.resource().phase, 'planned')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('exact creation timeout cannot be retried as settled after native thread and turn have started', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async (request: StructuredSessionRequest) => {
      calls++
      const record = published(request)
      record.status = 'active'
      record.harnessSessionId = 'thread-started'
      record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread-started', turnId: 'turn-started', turnStartRequested: true }
      f.records.set(record.session, record)
      throw new Error('native transport lost after start')
    } }
    await assert.rejects(f.runner(runtime)(f.request), /native transport lost after start/)
    const record = [...f.records.values()][0]
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error.code, 'stale_result')
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.checkpoint().nativeStarted, true)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('worktree资源桥贯通真实创建/queue/fake CLI，prompt只规范一次，实际commit和冷重放绑定完整', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-native-worktree-bridge-')), root = join(directory, 'repo'), home = join(directory, 'home'), bin = join(directory, 'bin'), count = join(directory, 'dispatches.json')
  mkdirSync(root); mkdirSync(home); mkdirSync(bin)
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'bridge fixture'); git('config', 'user.email', 'bridge@example.invalid')
    mkdirSync(join(root, '.spec')); writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    writeFileSync(join(root, 'value'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed')
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline'),cp=require('node:child_process');
if(process.argv.includes('--version')){process.stdout.write('2.1.309 (Claude Code)\\n');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const prompt=user.message.content[0].text;
const calls=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];calls.push({prompt,cwd:process.cwd()});fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(calls));
const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
send({type:'system',subtype:'init',session_id:session,model,tools:['Read','Bash','Edit','StructuredOutput']});send(user);
if(prompt.startsWith('malformed')){const Ajv=require(${JSON.stringify(createRequire(import.meta.url).resolve('ajv'))}).default,validate=new Ajv({allErrors:true}).compile(JSON.parse(arg('--json-schema'))),input={items:{}};validate(input);const error='Output does not match required schema: '+validate.errors.map(item=>item.instancePath+': '+item.message).join(', '),rows=[{type:'api-request',sessionId:session,id:'request',params:{model}},{type:'assistant',sessionId:session,uuid:'schema-assistant',parentUuid:user.uuid,requestRef:'request',message:{role:'assistant',content:[{type:'tool_use',id:'schema-call',name:'StructuredOutput',input}]}},{type:'user',sessionId:session,uuid:'schema-error',parentUuid:'schema-assistant',promptId:'prompt-'+user.uuid,sourceToolAssistantUUID:'schema-assistant',message:{role:'user',content:[{type:'tool_result',tool_use_id:'schema-call',is_error:true,content:error}]}}];fs.appendFileSync(path.join(project,session+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');process.exitCode=1;send({type:'result',subtype:'error_max_structured_output_retries',is_error:true,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});return;}

if(prompt.startsWith('alias')){const copy=path.join(${JSON.stringify(directory)},'alias-copy');fs.cpSync(process.cwd(),copy,{recursive:true});fs.writeFileSync(path.join(copy,'probe'),'draft');cp.execFileSync('git',['-C',copy,'add','probe']);cp.execFileSync('git',['-C',copy,'commit','-qm','experimental probe']);fs.writeFileSync(path.join(copy,'index-probe'),'staged');cp.execFileSync('git',['-C',copy,'add','index-probe'])}
if(prompt.startsWith('edit')){fs.writeFileSync('value','actual committed candidate\\n');cp.execFileSync('git',['add','value']);cp.execFileSync('git',['commit','-qm','native candidate'])}
send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'result',user_message_uuid:user.uuid,user_message_uuids:[user.uuid],...(prompt.startsWith('edit-missing')?{}:{structured_output:{answer:'actual native result'}})});
});`)
    chmodSync(executable, 0o755)
    const modulePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url)), script = join(directory, 'runner.mts')
    writeFileSync(script, `import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
import{openProtocol}from'${createRequire(import.meta.url).resolve('@spexcode/session-protocol')}';import{configuredSessionApplication}from${JSON.stringify(modulePath('../session-application.ts'))};
import{migrateSyncStore}from${JSON.stringify(modulePath('./migrations.ts'))};import{SyncStore}from${JSON.stringify(modulePath('./store.ts'))};import{createAttemptRunner}from${JSON.stringify(modulePath('./native-run.ts'))};import{captureInputSnapshot,readEvidence}from${JSON.stringify(modulePath('./snapshot.ts'))};import{stageWorktree}from${JSON.stringify(modulePath('./stage-worktree.ts'))};import{nativeWorktreePrompt}from${JSON.stringify(modulePath('../native-worktree-runtime.ts'))};import{readRecord}from${JSON.stringify(modulePath('../session-record.ts'))};import{StructuredSessionError}from${JSON.stringify(modulePath('../session-structured.ts'))};import{structuredExecutionPolicy}from${JSON.stringify(modulePath('../session-structured-policy.ts'))};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),git=args=>execFileSync('git',args,{encoding:'utf8'}).trim(),snapshot=await captureInputSnapshot(process.cwd(),{committed:true}),application=configuredSessionApplication(),protocol=openProtocol(process.env.SPEX_SESSION_DATABASE_PATH);await migrateSyncStore(protocol);const store=new SyncStore(protocol,{readBlob:ref=>readEvidence(snapshot.source.commonDir,ref)}),scope={paths:['value'],contractIds:[],flowIds:[]};
const operation=store.admitAndEnqueue({ingressKey:'bridge',rootCauseId:'bridge',origin:'spec',input:snapshot,scope,budget:{maxCalls:6,maxAttempts:2,maxRepairs:1,timeoutMs:60000},policyDigest:'policy',impactDigest:'impact',readSetDigest:'read',delivery:null,deliveryPlan:{canonicalRoot:process.cwd()+'/delivery',branch:'delivery',baseCommit:snapshot.headCommit}}),claim=store.claimAttempt({operationId:operation.id,source:snapshot.source,scope,leaseMs:30000,expectedMessageId:operation.dispatchMessageId}),seed=stageWorktree(snapshot.source.commonDir,snapshot.headCommit,snapshot.immutableTree,'edit'),request={root:process.cwd(),base:seed.baseCommit,worktree:seed,requestKey:'edit-bridge',inputDigest:'bound',purpose:'code_generate',prompt:'edit once',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},timeoutMs:10000,model:'claude:MiniMax-M3.1-Flash',effort:'high'},runner=createAttemptRunner(store,claim.fence,{pollMs:2});
const result=await runner(request),record=readRecord(result.sessionId),expected=hash({prompt:nativeWorktreePrompt(request.prompt,seed),parent:null,launcher:null,base:seed.baseCommit,structuredExecution:structuredExecutionPolicy({...request,effort:undefined,nativeConfiguration:'cli-config-v1'})});assert.equal(record.structuredExecution.nativeConfiguration,'cli-config-v1');assert.equal(record.structuredExecution.effort,undefined);assert.equal(JSON.parse(readFileSync(record.structuredExecution.claudeNative.root+'/launch.json','utf8')).args.includes('--effort'),false);assert.equal(record.createPayloadHash,expected);assert.equal(result.frozenReadProof,undefined);assert.equal(record.structuredExecution.frozenContext,undefined);assert.equal(record.structuredExecution.resultWorktree.tree,result.worktree.tree);assert.notEqual(result.worktree.headCommit,seed.baseCommit);assert.equal(git(['show',result.worktree.headCommit+':value']),'actual committed candidate');assert.equal(store.findResource(claim.attempt.id,request.requestKey).phase,'removed');
const calls=JSON.parse(readFileSync(${JSON.stringify(count)},'utf8'));assert.equal(calls.length,1);assert.equal(calls[0].prompt,nativeWorktreePrompt(request.prompt,seed));assert.equal(calls[0].cwd,result.worktree.worktreePath);
git(['worktree','remove',result.worktree.worktreePath]);assert.deepEqual(await createAttemptRunner(store,claim.fence,{pollMs:2})(request),result);assert.equal(store.readOperation(operation.id).callsUsed,1);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);await assert.rejects(runner({...request,prompt:'another task'}),{code:'key_reused'});
const malformed={...request,requestKey:'schema-bridge',purpose:'code_behavior_analyze',prompt:'malformed original response',schema:{type:'object',properties:{items:{type:'array',maxItems:0}},required:['items'],additionalProperties:false},worktree:{...seed,mode:'read'},timeoutMs:null},failure=await runner(malformed).then(()=>null,error=>error);assert(failure instanceof StructuredSessionError);assert.equal(failure.code,'structured_output_retries_exhausted');assert.match(failure.message,/items.*must be array/);const failed=readRecord(failure.sessionId),exitPath=failed.structuredExecution.claudeNative.root+'/exit.json',originalExit=readFileSync(exitPath);assert.equal(failed.structuredExecution.errorCode,'structured_output_retries_exhausted');assert.equal(failed.structuredExecution.output,undefined);assert.equal(store.findResource(claim.attempt.id,malformed.requestKey).phase,'removed');assert.equal(failed.structuredExecution.cancellation.nativeStopped,true);
await assert.rejects(createAttemptRunner(store,claim.fence,{pollMs:2})({...malformed,signal:AbortSignal.abort()}),{code:'structured_output_retries_exhausted'});assert.equal(store.findResource(claim.attempt.id,malformed.requestKey).phase,'removed');assert.deepEqual(readFileSync(exitPath),originalExit);
const repair={...malformed,requestKey:'schema-repair-bridge',prompt:'repair original fields using actual Native diagnostic: '+failure.message,schema:request.schema},repaired=await runner(repair);assert.equal(repaired.output.answer,'actual native result');assert.notEqual(repaired.sessionId,failure.sessionId);assert.equal(store.findResource(claim.attempt.id,repair.requestKey).phase,'removed');assert.equal(store.readOperation(operation.id).callsUsed,3);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,3);
const alias={...malformed,requestKey:'alias-bridge',prompt:'alias read experiment',schema:request.schema},aliasFailure=await runner(alias).then(()=>null,error=>error);assert(aliasFailure instanceof StructuredSessionError);assert.equal(aliasFailure.code,'native_worktree_result_invalid');assert.match(aliasFailure.message,/index-probe/);const aliasRecord=readRecord(aliasFailure.sessionId),aliasNative=aliasRecord.structuredExecution.claudeNative.root,aliasGit=args=>execFileSync('git',['-C',aliasRecord.worktreePath,...args],{encoding:'utf8'}).trim(),aliasHead=aliasGit(['rev-parse','HEAD']),aliasStatus=aliasGit(['status','--porcelain']),aliasIndexPath=aliasGit(['rev-parse','--path-format=absolute','--git-path','index']),aliasIndex=readFileSync(aliasIndexPath),protocolComplete=readFileSync(aliasNative+'/completed.json');assert.equal(aliasRecord.structuredExecution.state,'failed');assert.equal(aliasRecord.structuredExecution.output,undefined);assert.notEqual(aliasHead,seed.baseCommit);assert.notEqual(store.findResource(claim.attempt.id,alias.requestKey).phase,'removed');
await assert.rejects(createAttemptRunner(store,claim.fence,{pollMs:2})({...alias,signal:AbortSignal.abort()}),{code:'cancelled'});assert.equal(store.findResource(claim.attempt.id,alias.requestKey).phase,'removed');assert.equal(aliasGit(['rev-parse','HEAD']),aliasHead);assert.equal(aliasGit(['status','--porcelain']),aliasStatus);assert.deepEqual(readFileSync(aliasIndexPath),aliasIndex);assert.deepEqual(readFileSync(aliasNative+'/completed.json'),protocolComplete);
const gitRepair={...alias,requestKey:'alias-repair-bridge',prompt:'review in new worktree; actual prior Git failure: '+aliasFailure.message},gitRepaired=await runner(gitRepair);assert.notEqual(gitRepaired.sessionId,aliasFailure.sessionId);assert.notEqual(gitRepaired.worktree.worktreePath,aliasRecord.worktreePath);assert.equal(gitRepaired.worktree.headCommit,seed.baseCommit);assert.equal(store.findResource(claim.attempt.id,gitRepair.requestKey).phase,'removed');assert.equal(aliasGit(['rev-parse','HEAD']),aliasHead);assert.equal(aliasGit(['status','--porcelain']),aliasStatus);assert.equal(store.readOperation(operation.id).callsUsed,5);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,5);const missing={...request,requestKey:'missing-bridge',prompt:'edit-missing final'},missingFailure=await runner(missing).then(()=>null,error=>error);assert.equal(missingFailure.code,'structured_output_format_invalid');assert.equal(missingFailure.rejectedOutput,undefined);assert(missingFailure.failedWorktree);const missingRecord=readRecord(missingFailure.sessionId),missingResource=store.findResource(claim.attempt.id,missing.requestKey),missingCheckpoint=JSON.parse(readEvidence(snapshot.source.commonDir,missingResource.checkpointRef));assert.equal(missingRecord.structuredExecution.state,'failed');assert.equal(missingRecord.structuredExecution.output,undefined);assert.equal(missingRecord.structuredExecution.resultWorktree,undefined);assert.equal(missingRecord.structuredExecution.rejectedOutput,undefined);assert.equal(missingRecord.structuredExecution.cancellation.nativeStopped,true);assert.equal(missingResource.phase,'removed');assert.equal(missingCheckpoint.failure.rejectedOutput,undefined);assert.deepEqual(missingCheckpoint.failure.failedWorktree,missingFailure.failedWorktree);assert.equal(git(['show',missingFailure.failedWorktree.headCommit+':value']),'actual committed candidate');const recordBefore=JSON.stringify(missingRecord);await assert.rejects(createAttemptRunner(store,claim.fence,{pollMs:2})(missing),error=>{assert.equal(error.code,'structured_output_format_invalid');assert.deepEqual(error.failedWorktree,missingFailure.failedWorktree);assert.equal(error.rejectedOutput,undefined);return true});assert.equal(JSON.stringify(readRecord(missingFailure.sessionId)),recordBefore);assert.equal(store.readOperation(operation.id).callsUsed,6);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,6);protocol.close();process.exit(0);`)
    const result = spawnSync(process.execPath, ['--import', tsxImport, script], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), CLAUDE_CONFIG_DIR: join(home, 'claude-config'), ANTHROPIC_BASE_URL: 'https://example.invalid', SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

for (const defect of ['none', 'session', 'thread', 'turn', 'input', 'schema', 'prompt', 'purpose', 'sha', 'record-absence', 'unsettled', 'legacy'] as const) test(`rejected final diagnostic bridge authenticates exact failed record and preserves legacy absence: ${defect}`, async () => {
  const f = await fixture()
  try {
    const text = '{"answer":[}', message = 'original format failure'
    const run = f.runner({ ...f.runtimeBase, run: async actual => {
      const record = published(actual), identity = { threadId: 'native-thread', turnId: 'native-turn' }
      const rejectedOutput = rejectedFinalOutput(text, actual.prompt, record.structuredExecution!, identity)
      if (defect === 'thread') rejectedOutput.threadId = 'foreign'
      if (defect === 'turn') rejectedOutput.turnId = 'foreign'
      if (defect === 'input') rejectedOutput.inputDigest = 'foreign-owner-input'
      if (defect === 'schema') rejectedOutput.schemaDigest = '0'.repeat(64)
      if (defect === 'prompt') rejectedOutput.promptDigest = '0'.repeat(64)
      if (defect === 'purpose') rejectedOutput.purpose = 'another-owner'
      if (defect === 'sha') rejectedOutput.sha256 = '0'.repeat(64)
      record.harnessSessionId = identity.threadId
      record.structuredExecution = { ...record.structuredExecution!, ...identity, state: defect === 'unsettled' ? 'cancelling' : 'failed', ...(defect === 'legacy' || defect === 'record-absence' ? {} : { rejectedOutput }) }
      f.records.set(record.session, record)
      throw new StructuredSessionError('structured_output_format_invalid', message, { sessionId: defect === 'session' ? 'foreign' : record.session, ...identity, ...(defect === 'legacy' ? {} : { rejectedOutput }) })
    } })
    await assert.rejects(run(f.request), error => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, defect === 'none' || defect === 'legacy' ? 'structured_output_format_invalid' : 'stale_result')
      if (defect === 'none') {
        assert.equal(error.message, message); assert(error.rejectedOutput?.ref)
        assert.equal(f.blobIO.read(error.rejectedOutput.ref).toString('utf8'), text)
      } else assert.equal(error.rejectedOutput, undefined)
      return true
    })
    assert.equal(f.cache.has(textHash(text)), defect === 'none', 'no rejected bytes are granted for mismatched/unsettled/legacy records')
    assert.notEqual(f.resource().phase, 'removed', 'failure diagnostic does not claim stop or success')
  } finally { f.cleanup() }
})
