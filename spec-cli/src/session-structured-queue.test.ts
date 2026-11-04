import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise the complete creation/queue/native-result path with a local RPC executor and no model calls.
// A separate process starts in the fixture repo so the existing project-scoped layout caches stay truthful.
for (const scenario of ['resource-only-queued', 'sequential', 'cancel', 'materializing', 'abort', 'timeout', 'queued', 'refused', 'ack-active', 'settled-read-pending', 'cross-process', 'running-restart', 'owner-crashed-running', 'owner-crashed-completed', 'owner-crashed-concurrent', 'owner-live', 'owner-live-disconnect']) test(`structured queue ${scenario} preserves native control and maxActive=1`, { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-structured-queue-')), repo = join(root, 'repo'), bin = join(root, 'bin')
  try {
    mkdirSync(join(repo, '.spec'), { recursive: true }); mkdirSync(bin)
    writeFileSync(join(repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', branchPrefix: 'codex/', sessions: { maxActive: 1 } }))
    writeFileSync(join(repo, 'README'), 'fixture\n')
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']])
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    const executor = join(bin, 'codex')
    // Ordinary positive interrupts settle after ACK in protocol order; the read-pending case fences their proof.
    // Only cross-process cancellation intentionally delays settlement to exercise the late-owner race.
    writeFileSync(executor, `#!/usr/bin/env node
import {createServer} from 'node:net';import{existsSync,writeFileSync}from'node:fs';import{join}from'node:path';
const threads=new Map();const listeners=new Set(),owners=new Map();let counter=0;let reads=0;const counts={threadStarts:0,turnStarts:0,resumes:0};const trace=()=>writeFileSync(join(process.env.CODEX_HOME,'protocol-counts.json'),JSON.stringify(counts));const complete=thread=>{thread.turns[0].status='completed';for(const send of listeners)send({method:'turn/completed',params:{threadId:thread.id,turn:thread.turns[0]}});};
const path=process.argv[process.argv.indexOf('--listen')+1].replace('unix://','');
const server=createServer(socket=>{let buffer=Buffer.alloc(0),upgraded=false;
 const send=value=>{if(socket.destroyed)return;const p=Buffer.from(JSON.stringify(value));const h=p.length<126?Buffer.from([129,p.length]):Buffer.from([129,126,p.length>>8,p.length&255]);socket.write(Buffer.concat([h,p]));};
 listeners.add(send);socket.on('close',()=>{listeners.delete(send);for(const[id,owner]of owners)if(owner===socket&&threads.get(id).turns[0].items[0].content[0].text.includes('owner-crashed-completed'))complete(threads.get(id));});
 const handle=m=>{let result;
  if(m.id===undefined)return;
  if(m.method==='initialize')result={};
  else if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'never',features:{apps:false,plugins:false,hooks:false,shell_tool:false,code_mode:false,code_mode_host:false},mcp_servers:{}}};
  else if(m.method==='hooks/list')result={data:[{hooks:[],errors:[]}]};
  else if(m.method==='mcpServerStatus/list')result={data:[],nextCursor:null};
  else if(m.method==='thread/start'){counts.threadStarts++;trace();const id='thread-'+(++counter);const thread={id,turns:[]};threads.set(id,thread);result={thread};}
  else if(m.method==='turn/start'){counts.turnStarts++;trace();const thread=threads.get(m.params.threadId);const turn={id:'turn-'+counter,status:m.params.input[0].text.includes('hold')?'inProgress':'completed',items:[{type:'userMessage',content:m.params.input},{type:'agentMessage',phase:'final_answer',text:JSON.stringify({answer:m.params.input[0].text.includes('first')?'first':'second'})}]};thread.turns.push(turn);owners.set(thread.id,socket);result={turn:{id:turn.id}};if(m.params.input[0].text.includes('settled-read-pending'))queueMicrotask(()=>{turn.status='interrupted';writeFileSync(join(process.env.CODEX_HOME,'pending-settlement-read.json'),JSON.stringify({threadId:thread.id,turnId:turn.id,status:turn.status}));});if(m.params.input[0].text.includes('owner-live-disconnect'))setTimeout(()=>socket.destroy(),50);if(m.params.input[0].text.includes('owner-live'))setTimeout(()=>complete(thread),1200);if(turn.status==='completed')setTimeout(()=>send({method:'turn/completed',params:{threadId:thread.id,turn}}),5);}
  else if(m.method==='turn/interrupt'){const thread=threads.get(m.params.threadId),turn=thread.turns.find(t=>t.id===m.params.turnId);if(thread.turns[0].items[0].content[0].text.includes('ack-active')){thread.interrupts=(thread.interrupts||0)+1;if(thread.interrupts>1){send({id:m.id,error:{message:'fixture retry refused after prior acknowledgement'}});return;}}if(thread.turns[0].items[0].content[0].text.includes('cross-process')){thread.interrupts=(thread.interrupts||0)+1;if(thread.interrupts>1)return;}if(thread.turns[0].items[0].content[0].text.includes('refused')){send({id:m.id,error:{message:'fixture refused exact interruption'}});return;}result={};if(!thread.turns[0].items[0].content[0].text.includes('ack-active')){const settle=()=>{turn.status='interrupted';send({method:'turn/completed',params:{threadId:thread.id,turn}})};if(thread.turns[0].items[0].content[0].text.includes('cross-process'))setTimeout(settle,350);else queueMicrotask(settle);};}
  else if(m.method==='thread/read'||m.method==='thread/resume'){const thread=threads.get(m.params.threadId);if(m.method==='thread/resume'){counts.resumes++;trace();if(thread.turns[0].items[0].content[0].text.includes('owner-crashed-running')||thread.turns[0].items[0].content[0].text.includes('owner-crashed-concurrent')||thread.turns[0].items[0].content[0].text.includes('owner-live-disconnect'))setTimeout(()=>complete(thread),100);}result={thread};}
  else if(m.method==='thread/items/list'){const thread=threads.get(m.params.threadId),turn=thread.turns.find(t=>t.id===m.params.turnId);result={data:turn.items.map(item=>({turnId:turn.id,item})),nextCursor:null};}
  else if(m.method==='thread/turns/list'){const thread=threads.get(m.params.threadId),turn=thread.turns[0];if(turn.status==='interrupted'&&turn.items[0].content[0].text.includes('settled-read-pending')&&!existsSync(join(process.env.CODEX_HOME,'release-settlement-read')))return;if(threads.get(m.params.threadId).turns[0].items[0].content[0].text.includes('materializing')&&reads++<2){send({id:m.id,error:{message:'rollout at fixture is empty'}});return;}result={data:threads.get(m.params.threadId).turns};}
  else if(m.method==='thread/loaded/list')result={data:[...threads.keys()]};
  else result={};
  send({id:m.id,result});
 };
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(!upgraded){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');buffer=buffer.subarray(end+4);upgraded=true;}
 while(buffer.length>=2){const masked=!!(buffer[1]&128);let n=buffer[1]&127,o=2;if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);o=4;}if(n===127){if(buffer.length<10)return;n=Number(buffer.readBigUInt64BE(2));o=10;}const start=o+(masked?4:0);if(buffer.length<start+n)return;const p=Buffer.from(buffer.subarray(start,start+n));if(masked)for(let i=0;i<n;i++)p[i]^=buffer[o+i%4];buffer=buffer.subarray(start+n);handle(JSON.parse(p.toString()));}
 });
});server.listen(path);
`)
    // Node treats extensionless files as CommonJS unless its nearby package opts into modules.
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n'); chmodSync(executor, 0o755)
    const runner = join(root, 'runner.mts'), source = fileURLToPath(new URL('./session-structured.ts', import.meta.url))
    const generations = fileURLToPath(new URL('./codex-runtime-generations.ts', import.meta.url))
    const sessions = fileURLToPath(new URL('./sessions.ts', import.meta.url))
    const records = fileURLToPath(new URL('./session-record.ts', import.meta.url))
    const core = fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url))
    writeFileSync(runner, `import {runStructuredSession,cancelStructuredSession} from ${JSON.stringify(source)};
import {sessionIdForCreateKey,listSessions} from ${JSON.stringify(sessions)};
import {readRecord} from ${JSON.stringify(records)};
import {currentCodexGeneration} from ${JSON.stringify(generations)};
import {runtimeRoot,verifyDetachedRuntime} from ${JSON.stringify(core)};
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {spawn,spawnSync} from 'node:child_process';
const results=[];let error;let cancellation;const scenario=${JSON.stringify(scenario)};
const request=(answer,key,timeoutMs=3000)=>({root:process.cwd(),requestKey:key,inputDigest:'frozen-'+key,purpose:'queue-regression',prompt:'Return '+answer,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},timeoutMs});
const wait=async check=>{const until=Date.now()+2500;while(!check()){if(Date.now()>until)throw new Error('fixture native turn never started');await new Promise(r=>setTimeout(r,10));}};
try{
 if(scenario==='resource-only-queued'){
  const assert=(await import('node:assert/strict')).default,{createHash}=await import('node:crypto');
  const applicationModule=await import(${JSON.stringify(fileURLToPath(new URL('./session-application.ts', import.meta.url)))}),app=applicationModule.configuredSessionApplication();
  const {fromRaw,writeRecord}=await import(${JSON.stringify(records)}),sessions=await import(${JSON.stringify(sessions)}),{structuredExecutionPolicy}=await import(${JSON.stringify(fileURLToPath(new URL('./session-structured-policy.ts', import.meta.url)))});
  const {captureInputSnapshot,contentHash,writeEvidence,readEvidence}=await import(${JSON.stringify(fileURLToPath(new URL('./sync/snapshot.ts', import.meta.url)))}),{migrateSyncStore}=await import(${JSON.stringify(fileURLToPath(new URL('./sync/migrations.ts', import.meta.url)))}),{SyncStore}=await import(${JSON.stringify(fileURLToPath(new URL('./sync/store.ts', import.meta.url)))}),{recoverSyncOperationResources}=await import(${JSON.stringify(fileURLToPath(new URL('./sync/coordinator.ts', import.meta.url)))});
  await migrateSyncStore(app.protocol);const input=await captureInputSnapshot(process.cwd()),store=new SyncStore(app.protocol,{readBlob:ref=>readEvidence(input.source.commonDir,ref)}),scope={paths:['README'],contractIds:[],flowIds:[]};
  const op=store.admitAndEnqueue({ingressKey:'quiet',rootCauseId:'quiet',origin:'spec',input,scope,budget:{maxCalls:4,maxAttempts:2,maxRepairs:1,timeoutMs:30000},delivery:null,deliveryPlan:{canonicalRoot:process.cwd(),branch:'refs/heads/codex/delivery',baseCommit:input.headCommit},policyDigest:'policy',impactDigest:'impact',readSetDigest:'readset'}),claim=store.claimAttempt({operationId:op.id,source:input.source,scope,leaseMs:30000,expectedMessageId:op.dispatchMessageId});
  const nativeRequest={root:process.cwd(),base:input.headCommit,prompt:'Return first',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},requestKey:'quiet-owned',inputDigest:'local-input',purpose:'elaboration_generate',timeoutMs:3000},requestDigest=contentHash(JSON.stringify(nativeRequest)),dispatch=store.reserveDispatch(claim.fence,{key:nativeRequest.requestKey,purpose:nativeRequest.purpose,requestDigest}),target=sessionIdForCreateKey(dispatch.sessionCreateKey),policy=structuredExecutionPolicy(nativeRequest),identity={operationId:op.id,attemptId:claim.attempt.id,inputId:input.id,candidateDigest:null};
  const rec=(id,execution,status='queued')=>{app.createSession({sessionId:id,status});const r=fromRaw({session_id:id,governed:true,worktree_path:process.cwd(),branch:null,status,createdAt:1,harness:'codex-headless',launch_cmd:'codex'});r.structuredExecution=execution;writeRecord(r);return r;};
  const targetRecord=rec(target,policy);targetRecord.createRequestId=createHash('sha256').update(dispatch.sessionCreateKey).digest('hex');targetRecord.createPayloadHash=contentHash(JSON.stringify({prompt:nativeRequest.prompt,parent:null,launcher:null,base:nativeRequest.base,structuredExecution:policy}));writeRecord(targetRecord);
  const bait='quiet-queued-bait',watcher='quiet-watcher',control='quiet-normal-control';rec(bait,{...policy,inputDigest:'bait-input',purpose:'bait'});const launch=(await import(${JSON.stringify(core)})).sessionArtifactPath(bait,'launch');(await import('node:fs')).mkdirSync(join(launch,'..'),{recursive:true});writeFileSync(launch,'Return second');
  app.createSession({sessionId:watcher,status:'awaiting'});app.bindRuntime(watcher,{namespace:'spex-governed',runtimeKind:'test',nativeSessionId:'watch-native',nativeStartToken:'watch-token'});await new Promise(r=>setImmediate(r));app.attachWatcher(watcher,target);let deliveries=0;sessions.setDeliveryHandover(async()=>{deliveries++;});app.enqueueMessage(watcher,{kind:'fixture.pending.v1',body:Buffer.from('原待投递消息保留')});await new Promise(r=>setImmediate(r));deliveries=0;const pendingBefore=app.readPendingMessages(watcher);
  const plan={schemaVersion:1,request:nativeRequest,requestDigest,sessionCreateKey:dispatch.sessionCreateKey,expectedSessionId:target,...identity},checkpoint={schemaVersion:1,...identity,requestDigest,expectedSessionId:target,phase:'planned',nativeCallRequested:true,nativeStarted:false,nativeState:'queued',session:{sessionId:target,threadId:null,turnId:null}};
  const resource=store.planResource(claim.fence,{key:nativeRequest.requestKey,kind:'native_session',payloadDigest:requestDigest,inputId:input.id,candidateDigest:null,planBlob:writeEvidence(input.source.commonDir,plan),checkpointRef:writeEvidence(input.source.commonDir,checkpoint)}),before=store.readAttempt(claim.attempt.id),baitBefore=readRecord(bait),eventsBefore=app.readEvents(target).length;
  (await import('node:fs')).mkdirSync(join(${JSON.stringify(root)},'artifacts'),{mode:0o700});const recovered=await recoverSyncOperationResources(store,op.id,{root:process.cwd(),inputId:input.id,artifactRoot:(await import('node:fs')).realpathSync(join(${JSON.stringify(root)},'artifacts'))});assert.equal(recovered.status,'resources_recovered',JSON.stringify(recovered));
  await new Promise(r=>setTimeout(r,300));const counts=()=>{try{return JSON.parse(readFileSync(join(runtimeRoot(),'structured-read-only-v1/data/codex-home/protocol-counts.json'),'utf8'));}catch{return {threadStarts:0,turnStarts:0};}};
  if(readRecord(bait)?.structuredExecution?.state==='running')await wait(()=>counts().turnStarts>0);console.log(JSON.stringify({resourceOnly:true,deliveries,counts:counts(),baitState:readRecord(bait)?.structuredExecution?.state,targetState:readRecord(target)?.structuredExecution?.state}));
  assert.equal(deliveries,0,'resource-only不能主动唤醒既有watcher');assert.equal(counts().turnStarts,0,'resource-only不能启动旁置queued turn');assert.deepEqual(readRecord(bait),baitBefore,'resource-only不能claim旁置queued observer');assert.equal(store.readResource(resource.id).phase,'removed');assert.deepEqual(store.readAttempt(claim.attempt.id),before);assert.ok(app.readEvents(target).length>eventsBefore);assert.deepEqual(app.readPendingMessages(watcher),pendingBefore);assert.ok(app.readWatchEvents([watcher]).some(event=>event.subjectSessionId===target));assert.equal(readRecord(target).structuredExecution.cancellation.nativeStopped,true);
  await sessions.drainQueue();await wait(()=>readRecord(bait)?.structuredExecution?.state==='completed'&&readRecord(bait)?.structuredExecution?.observer===null);assert.equal(counts().turnStarts,1);assert.equal(readRecord(target).structuredExecution.state,'cancelled');assert.equal(readRecord(target).structuredExecution.threadId,undefined);
  rec(control,{...policy,inputDigest:'control-input'});app.attachWatcher(watcher,control);deliveries=0;await cancelStructuredSession(control);await new Promise(r=>setImmediate(r));assert.ok(deliveries>0,'普通cancel默认仍唤醒watcher');
  const parallel='quiet-parallel-control';rec(parallel,{...policy,inputDigest:'parallel-input'});app.attachWatcher(watcher,parallel);await new Promise(r=>setImmediate(r));let wakes=0;const observed=[];applicationModule.setSessionApplicationCommitWake(()=>{wakes++;});applicationModule.setSessionApplicationCommitObserver(change=>{observed.push(...change.subjectSessionIds);});let release,entered;const enteredPromise=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r});
  const quiet=applicationModule.withoutSessionApplicationExecutionWake(async()=>{app.transitionSession(target,{status:'error',proposal:null,note:'quiet-one'});applicationModule.withoutSessionApplicationExecutionWake(()=>app.transitionSession(target,{status:'error',proposal:null,note:'quiet-nested'}));app.bindRuntime(target,{namespace:'quiet-probe',runtimeKind:'test',nativeSessionId:'quiet-native',nativeStartToken:'quiet-token'});queueMicrotask(()=>app.transitionSession(target,{status:'error',proposal:null,note:'quiet-microtask'}));entered();await gate;app.transitionSession(target,{status:'error',proposal:null,note:'quiet-after-await'});});
  await enteredPromise;await cancelStructuredSession(parallel);app.bindRuntime(parallel,{namespace:'normal-probe',runtimeKind:'test',nativeSessionId:'normal-native',nativeStartToken:'normal-token'});release();await quiet;applicationModule.withoutSessionApplicationExecutionWake(()=>{setImmediate(()=>app.transitionSession(target,{status:'error',proposal:null,note:'quiet-after-return'}));});await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(wakes,2,'普通并发commit和runtime bind仍wake，quiet派生任务不wake');assert.deepEqual(observed,[parallel]);assert.equal(app.resolveRuntime(target,'quiet-probe')?.status,'bound');assert.equal(app.readState(target)?.note,'quiet-after-return');app.transitionSession(control,{status:'error',proposal:null,note:'normal-after-scope'});await new Promise(r=>setImmediate(r));assert.equal(wakes,3);assert.deepEqual(observed,[parallel,control]);console.log(JSON.stringify({afterExplicitNormalDrain:counts(),targetNeverStarted:readRecord(target).structuredExecution.threadId===undefined,canonicalEventsPersisted:app.readEvents(target).length>eventsBefore,parallelNormalWakes:wakes,scopeIsolation:true}));
 }else if(scenario.startsWith('owner-')){
  const key='queue-owner',id=sessionIdForCreateKey(key),input=request('hold '+scenario+' first',key,3000),owner=join(${JSON.stringify(root)},'owner.mts');
  writeFileSync(owner,'import {runStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {readRecord} from '+JSON.stringify(${JSON.stringify(records)})+';import{writeFileSync}from "node:fs";const task=runStructuredSession('+JSON.stringify(input)+');while(!readRecord('+JSON.stringify(id)+')?.structuredExecution?.turnId)await new Promise(r=>setTimeout(r,10));const r=readRecord('+JSON.stringify(id)+');writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'accepted.json'))})+',JSON.stringify({sessionId:r.session,threadId:r.structuredExecution.threadId,turnId:r.structuredExecution.turnId}));'+(scenario.startsWith('owner-live')?'const result=await task;writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'owner-result.json'))})+',JSON.stringify(result));':'')+'process.exit();');
  const processA=spawn(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},owner],{stdio:'inherit'});const exitA=new Promise((resolve,reject)=>{processA.on('error',reject);processA.on('close',code=>code===0?resolve():reject(new Error('owner process failed')))});
  await wait(()=>{try{return !!readFileSync(${JSON.stringify(join(root,'accepted.json'))},'utf8')}catch{return false}});const accepted=JSON.parse(readFileSync(${JSON.stringify(join(root,'accepted.json'))},'utf8'));if(!scenario.startsWith('owner-live'))await exitA;
  const rejoin=join(${JSON.stringify(root)},'rejoin.mts');writeFileSync(rejoin,'import{runStructuredSession}from '+JSON.stringify(${JSON.stringify(source)})+';import{writeFileSync}from "node:fs";try{const result=await runStructuredSession('+JSON.stringify(input)+');const replay=await runStructuredSession('+JSON.stringify(input)+');writeFileSync(process.argv[2]||'+JSON.stringify(${JSON.stringify(join(root,'rejoined.json'))})+',JSON.stringify({result,replay}));process.exit();}catch(error){writeFileSync(process.argv[2]||'+JSON.stringify(${JSON.stringify(join(root,'rejoined.json'))})+',JSON.stringify({error:{code:error.code,message:error.message}}));process.exit(1);}');
  let rejoined;
  if(scenario==='owner-crashed-concurrent'){
   const callers=await Promise.all(['b','c'].map(async name=>{const output=join(${JSON.stringify(root)},'rejoin-'+name+'.json');const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},rejoin,output],{stdio:'inherit'});child.on('error',reject);child.on('close',resolve)});const value=JSON.parse(readFileSync(output,'utf8'));if(code!==0)throw new Error('concurrent same-key recovery failed: '+JSON.stringify(value));return value;}));
   if(JSON.stringify(callers[0])!==JSON.stringify(callers[1]))throw new Error('concurrent callers observed different exact results');rejoined=callers[0];
  }else{
   const processB=spawnSync(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},rejoin],{encoding:'utf8',timeout:8000});rejoined=JSON.parse(readFileSync(${JSON.stringify(join(root,'rejoined.json'))},'utf8'));if(processB.status!==0)throw new Error('same-key orphan recovery failed: '+JSON.stringify(rejoined));
  }
  await exitA;
  if(rejoined.result.sessionId!==accepted.sessionId||rejoined.result.threadId!==accepted.threadId||rejoined.result.turnId!==accepted.turnId||JSON.stringify(rejoined.replay)!==JSON.stringify(rejoined.result))throw new Error('recovery changed exact native identity or completed replay');
  const count=JSON.parse(readFileSync(join(runtimeRoot(),'structured-read-only-v1/data/codex-home/protocol-counts.json'),'utf8'));if(count.threadStarts!==1||count.turnStarts!==1||count.resumes!==(scenario==='owner-live'?0:1))throw new Error('recovery started a duplicate native turn or observer: '+JSON.stringify(count));results.push(rejoined);
 }
 else if(scenario==='sequential'){for(const answer of ['first','second'])results.push(await runStructuredSession(request(answer,'queue-'+answer)));}
 else{
  const id=sessionIdForCreateKey('queue-active');const controller=new AbortController();const active=runStructuredSession({...request('hold '+scenario,'queue-active',5000),...(scenario==='abort'?{signal:controller.signal}:{})}).then(result=>({result}),e=>({error:{code:e.code,message:e.message}}));
  await wait(()=>!!readRecord(id)?.structuredExecution?.turnId);
  const running=(await listSessions()).find(s=>s.id===id),accepted=readRecord(id);if(accepted.status!=='active'||running.lifecycle!=='active'||running.status!=='working'||running.liveness!=='unknown')throw new Error('accepted native turn is no longer active: '+JSON.stringify({recordStatus:accepted.status,executionState:accepted.structuredExecution.state,lifecycle:running.lifecycle,status:running.status,liveness:running.liveness}));
  if(scenario==='running-restart'){
   const inspect=join(${JSON.stringify(root)},'inspect.mts');writeFileSync(inspect,'import {runStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {readRecord} from '+JSON.stringify(${JSON.stringify(records)})+';import {listSessions} from '+JSON.stringify(${JSON.stringify(sessions)})+';import {writeFileSync} from "node:fs";const id='+JSON.stringify(id)+';const before=readRecord(id);const row=(await listSessions()).find(s=>s.id===id);if(before.status!=="active"||row.lifecycle!=="active"||row.status!=="working"||row.liveness!=="unknown")throw new Error("fresh process lost exact accepted execution phase");let failure;try{await runStructuredSession('+JSON.stringify(request('second','queue-while-running',300))+');throw new Error("fresh process overlaunched while native task occupies capacity");}catch(error){if(error.code!=="timeout")throw error;failure=error.code;}writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'inspect.json'))})+',JSON.stringify({row:{lifecycle:row.lifecycle,status:row.status,liveness:row.liveness},failure}));process.exit();');
   const inspected=spawnSync(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},inspect],{encoding:'utf8',timeout:5000});if(inspected.status!==0)throw new Error('new embedded process failed active/capacity observation: '+inspected.stderr);
  }
  if(scenario==='queued'){
   const queuedId=sessionIdForCreateKey('queue-second');const queued=runStructuredSession(request('second','queue-second')).then(result=>({result}),e=>({error:{code:e.code}}));
   await wait(()=>!!readRecord(queuedId));const neverStarted=await cancelStructuredSession(queuedId);
   if(!neverStarted.nativeStopped||neverStarted.nativeStatus!=='notStarted'||readRecord(queuedId).harnessSessionId)throw new Error('queued cancellation guessed a native target');
   results.push(await queued);
  }
  if(scenario==='cross-process'){
   const external=join(${JSON.stringify(root)},'external.mts');writeFileSync(external,'import {cancelStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {writeFileSync} from "node:fs";const result=await cancelStructuredSession('+JSON.stringify(id)+');writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'external.json'))})+',JSON.stringify(result));process.exit();');
   await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},external],{stdio:'inherit'});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('external cancellation failed')))});
   cancellation=JSON.parse(readFileSync(${JSON.stringify(join(root,'external.json'))},'utf8'));results.push(await active);
   if(!readRecord(id).structuredExecution.cancellation.nativeStopped||readRecord(id).structuredExecution.state!=='cancelled'||results[0].error?.code!=='cancelled'||!readRecord(id).note.includes('native interrupted'))throw new Error('late owner cancellation downgraded externally confirmed native settlement');
   const restart=join(${JSON.stringify(root)},'restart.mts');writeFileSync(restart,'import {runStructuredSession,cancelStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {writeFileSync} from "node:fs";const settled=await cancelStructuredSession('+JSON.stringify(id)+',{reason:"timeout"});if(settled.state!=="cancelled"||!settled.nativeStopped||!settled.acknowledged||settled.nativeStatus!=="interrupted")throw new Error("late cancellation begin downgraded terminal proof");const result=await runStructuredSession('+JSON.stringify(request('second','queue-after-restart'))+');writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'restart.json'))})+',JSON.stringify(result));process.exit();');
   const next=spawnSync(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},restart],{encoding:'utf8',timeout:5000});if(next.status!==0)throw new Error('new embedded process did not start next unique request: '+next.stderr);results.push(JSON.parse(readFileSync(${JSON.stringify(join(root,'restart.json'))},'utf8')));
  }
  else if(scenario==='abort')controller.abort();
  if(scenario==='settled-read-pending'){
   // Native settlement precedes the short deadline; omit its notification and gate only the exact read reply.
   await wait(()=>{try{return JSON.parse(readFileSync(join(runtimeRoot(),'structured-read-only-v1/data/codex-home/pending-settlement-read.json'),'utf8')).status==='interrupted'}catch{return false}});
  }
  if(scenario!=='cross-process'){
   if(scenario==='timeout'||scenario==='abort'){results.push(await active);cancellation=readRecord(id).structuredExecution.cancellation;}
   // The ACK-preservation case first allows a normal control handshake, then separately probes its short retry refusal.
   else{cancellation=await cancelStructuredSession(id,scenario==='ack-active'?{timeoutMs:5000}:scenario==='refused'||scenario==='settled-read-pending'?{timeoutMs:300}:undefined);results.push(await active);}
  }
  if(scenario==='settled-read-pending'){
   const home=join(runtimeRoot(),'structured-read-only-v1/data/codex-home'),proof=JSON.parse(readFileSync(join(home,'pending-settlement-read.json'),'utf8')),before=readRecord(id).structuredExecution.cancellation;
   const row=(await listSessions()).find(s=>s.id===id);
   if(proof.threadId!==cancellation.threadId||proof.turnId!==cancellation.turnId||proof.status!=='interrupted'||cancellation.nativeStopped||cancellation.acknowledged||cancellation.error!=='exact structured turn read timed out'||readRecord(id).structuredExecution.state!=='cancelling'||row.liveness!=='unknown')throw new Error('settled native turn without an exact read became falsely terminal');
   try{await runStructuredSession(request('second','queue-before-read-proof',300));throw new Error('unread settled native task released its model capacity');}catch(e){if(e.code!=='timeout')throw e;}
   const count=JSON.parse(readFileSync(join(home,'protocol-counts.json'),'utf8'));if(count.threadStarts!==1||count.turnStarts!==1)throw new Error('unread settlement launched a second native task');
   writeFileSync(join(home,'release-settlement-read'),'released');
   cancellation=await cancelStructuredSession(id);
   const after=readRecord(id).structuredExecution.cancellation;
   if(cancellation.threadId!==proof.threadId||cancellation.turnId!==proof.turnId||cancellation.acknowledged||after.reason!==before.reason||after.requestedAt!==before.requestedAt)throw new Error('exact settlement recovery lost its cancellation identity or invented an interrupt ACK');
  }
  if(scenario==='refused'||scenario==='ack-active'){
   const row=(await listSessions()).find(s=>s.id===id);if(cancellation.nativeStopped||readRecord(id).structuredExecution.state!=='cancelling'||row.liveness!=='unknown')throw new Error('unconfirmed native stop became falsely terminal');
   if(scenario==='ack-active'){const before=readRecord(id).structuredExecution.cancellation;const retry=await cancelStructuredSession(id,{reason:'timeout',timeoutMs:100});const after=readRecord(id).structuredExecution.cancellation;if(retry.nativeStopped||!retry.acknowledged||!after.acknowledged||after.reason!==before.reason||after.requestedAt!==before.requestedAt)throw new Error('retry refusal discarded prior native ACK or cancellation identity');}
   try{await runStructuredSession(request('second','queue-blocked',300));throw new Error('unconfirmed native task released its model capacity');}catch(e){if(e.code!=='timeout')throw e;}
  }else{
   if(!cancellation.nativeStopped||(scenario!=='settled-read-pending'&&!cancellation.acknowledged)||cancellation.nativeStatus!=='interrupted')throw new Error('cancellation lacks acknowledged exact native settlement');
   if(scenario==='timeout'&&results[0].error.code!=='timeout')throw new Error('timeout lost its reason');
   if(scenario!=='cross-process')results.push(await runStructuredSession(request('second','queue-after-stop')));
  }
 }
}
catch(e){error={code:e.code,message:e.message,sessionId:e.sessionId,threadId:e.threadId};}
finally{const endpoint=currentCodexGeneration(join(runtimeRoot(),'structured-read-only-v1/control'));if(endpoint){const pid=Number(readFileSync(endpoint.pidFile,'utf8'));if(verifyDetachedRuntime(pid,endpoint.receiptFile).ok)process.kill(-pid,'SIGTERM');}}
writeFileSync(${JSON.stringify(join(root, 'results.json'))},JSON.stringify({results,error,cancellation}));process.exit(error?1:0);
`)
    const child = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, SPEXCODE_HOME: join(root, 'runtime'), SPEX_SESSION_DATABASE_PATH: join(root, 'runtime/sessions.sqlite'), PATH: `${bin}:${process.env.PATH}` },
    })
    const evidence = readFileSync(join(root, 'results.json'), 'utf8')
    assert.equal(child.status, 0, `second distinct structured request never completed: ${evidence}\n${child.stdout}\n${child.stderr.slice(-1000)}`)
    if (scenario === 'resource-only-queued') console.log(child.stdout.trim())
    if (scenario !== 'sequential') { const parsed = JSON.parse(evidence); assert.equal(parsed.error, undefined); return }
    const { results } = JSON.parse(evidence) as { results: Array<{ sessionId: string; threadId: string; turnId: string; output: { answer: string } }> }
    assert.deepEqual(results.map((result) => result.output.answer), ['first', 'second'])
    assert.notEqual(results[0].sessionId, results[1].sessionId)
    assert.notEqual(results[0].threadId, results[1].threadId)
    assert.notEqual(results[0].turnId, results[1].turnId)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
