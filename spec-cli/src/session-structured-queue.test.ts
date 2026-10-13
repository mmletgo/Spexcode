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
for (const scenario of ['sequential', 'cancel', 'materializing', 'abort', 'timeout', 'queued', 'refused', 'ack-active', 'cross-process', 'running-restart', 'owner-crashed-running', 'owner-crashed-completed', 'owner-crashed-concurrent', 'owner-live', 'owner-live-disconnect']) test(`structured queue ${scenario} preserves native control and maxActive=1`, { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-structured-queue-')), repo = join(root, 'repo'), bin = join(root, 'bin')
  try {
    mkdirSync(join(repo, '.spec'), { recursive: true }); mkdirSync(bin)
    writeFileSync(join(repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', branchPrefix: 'codex/', sessions: { maxActive: 1 } }))
    writeFileSync(join(repo, 'README'), 'fixture\n')
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']])
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    const executor = join(bin, 'codex')
    writeFileSync(executor, `#!/usr/bin/env node
import {createServer} from 'node:net';import{writeFileSync}from'node:fs';import{join}from'node:path';
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
  else if(m.method==='turn/start'){counts.turnStarts++;trace();const thread=threads.get(m.params.threadId);const turn={id:'turn-'+counter,status:m.params.input[0].text.includes('hold')?'inProgress':'completed',items:[{type:'userMessage',content:m.params.input},{type:'agentMessage',phase:'final_answer',text:JSON.stringify({answer:m.params.input[0].text.includes('first')?'first':'second'})}]};thread.turns.push(turn);owners.set(thread.id,socket);result={turn:{id:turn.id}};if(m.params.input[0].text.includes('owner-live-disconnect'))setTimeout(()=>socket.destroy(),50);if(m.params.input[0].text.includes('owner-live'))setTimeout(()=>complete(thread),1200);if(turn.status==='completed')setTimeout(()=>send({method:'turn/completed',params:{threadId:thread.id,turn}}),5);}
  else if(m.method==='turn/interrupt'){const thread=threads.get(m.params.threadId),turn=thread.turns.find(t=>t.id===m.params.turnId);if(thread.turns[0].items[0].content[0].text.includes('ack-active')){thread.interrupts=(thread.interrupts||0)+1;if(thread.interrupts>1){send({id:m.id,error:{message:'fixture retry refused after prior acknowledgement'}});return;}}if(thread.turns[0].items[0].content[0].text.includes('cross-process')){thread.interrupts=(thread.interrupts||0)+1;if(thread.interrupts>1)return;}if(thread.turns[0].items[0].content[0].text.includes('refused')){send({id:m.id,error:{message:'fixture refused exact interruption'}});return;}result={};if(!thread.turns[0].items[0].content[0].text.includes('ack-active'))setTimeout(()=>{turn.status='interrupted';send({method:'turn/completed',params:{threadId:thread.id,turn}})},thread.turns[0].items[0].content[0].text.includes('cross-process')?350:50);}
  else if(m.method==='thread/read'||m.method==='thread/resume'){const thread=threads.get(m.params.threadId);if(m.method==='thread/resume'){counts.resumes++;trace();if(thread.turns[0].items[0].content[0].text.includes('owner-crashed-running')||thread.turns[0].items[0].content[0].text.includes('owner-crashed-concurrent')||thread.turns[0].items[0].content[0].text.includes('owner-live-disconnect'))setTimeout(()=>complete(thread),100);}result={thread};}
  else if(m.method==='thread/turns/list'){if(threads.get(m.params.threadId).turns[0].items[0].content[0].text.includes('materializing')&&reads++<2){send({id:m.id,error:{message:'rollout at fixture is empty'}});return;}result={data:threads.get(m.params.threadId).turns};}
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
 if(scenario.startsWith('owner-')){
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
  const id=sessionIdForCreateKey('queue-active');const controller=new AbortController();const active=runStructuredSession({...request('hold '+scenario,'queue-active',scenario==='timeout'?1200:5000),...(scenario==='abort'?{signal:controller.signal}:{})}).then(result=>({result}),e=>({error:{code:e.code,message:e.message}}));
  await wait(()=>!!readRecord(id)?.structuredExecution?.turnId);
  const running=(await listSessions()).find(s=>s.id===id);if(readRecord(id).status!=='active'||running.lifecycle!=='active'||running.status!=='working'||running.liveness!=='unknown')throw new Error('accepted native turn still projects queued or fails to reserve capacity');
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
   const external=join(${JSON.stringify(root)},'external.mts');writeFileSync(external,'import {cancelStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {writeFileSync} from "node:fs";const result=await cancelStructuredSession('+JSON.stringify(id)+',{timeoutMs:2000});writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'external.json'))})+',JSON.stringify(result));process.exit();');
   await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},external],{stdio:'inherit'});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('external cancellation failed')))});
   cancellation=JSON.parse(readFileSync(${JSON.stringify(join(root,'external.json'))},'utf8'));results.push(await active);
   if(!readRecord(id).structuredExecution.cancellation.nativeStopped||readRecord(id).structuredExecution.state!=='cancelled'||results[0].error?.code!=='cancelled'||!readRecord(id).note.includes('native interrupted'))throw new Error('late owner cancellation downgraded externally confirmed native settlement');
   const restart=join(${JSON.stringify(root)},'restart.mts');writeFileSync(restart,'import {runStructuredSession,cancelStructuredSession} from '+JSON.stringify(${JSON.stringify(source)})+';import {writeFileSync} from "node:fs";const settled=await cancelStructuredSession('+JSON.stringify(id)+',{reason:"timeout"});if(settled.state!=="cancelled"||!settled.nativeStopped||!settled.acknowledged||settled.nativeStatus!=="interrupted")throw new Error("late cancellation begin downgraded terminal proof");const result=await runStructuredSession('+JSON.stringify(request('second','queue-after-restart'))+');writeFileSync('+JSON.stringify(${JSON.stringify(join(root,'restart.json'))})+',JSON.stringify(result));process.exit();');
   const next=spawnSync(process.execPath,['--import',${JSON.stringify(createRequire(import.meta.url).resolve('tsx/esm'))},restart],{encoding:'utf8',timeout:5000});if(next.status!==0)throw new Error('new embedded process did not start next unique request: '+next.stderr);results.push(JSON.parse(readFileSync(${JSON.stringify(join(root,'restart.json'))},'utf8')));
  }
  else if(scenario==='abort')controller.abort();
  if(scenario!=='cross-process'){
   if(scenario==='timeout'||scenario==='abort'){results.push(await active);cancellation=readRecord(id).structuredExecution.cancellation;}
   else{cancellation=await cancelStructuredSession(id,{timeoutMs:scenario==='materializing'?1000:300});results.push(await active);}
  }
  if(scenario==='refused'||scenario==='ack-active'){
   const row=(await listSessions()).find(s=>s.id===id);if(cancellation.nativeStopped||readRecord(id).structuredExecution.state!=='cancelling'||row.liveness!=='unknown')throw new Error('unconfirmed native stop became falsely terminal');
   if(scenario==='ack-active'){const before=readRecord(id).structuredExecution.cancellation;const retry=await cancelStructuredSession(id,{reason:'timeout',timeoutMs:100});const after=readRecord(id).structuredExecution.cancellation;if(retry.nativeStopped||!retry.acknowledged||!after.acknowledged||after.reason!==before.reason||after.requestedAt!==before.requestedAt)throw new Error('retry refusal discarded prior native ACK or cancellation identity');}
   try{await runStructuredSession(request('second','queue-blocked',300));throw new Error('unconfirmed native task released its model capacity');}catch(e){if(e.code!=='timeout')throw e;}
  }else{
   if(!cancellation.nativeStopped||!cancellation.acknowledged||cancellation.nativeStatus!=='interrupted')throw new Error('cancellation lacks acknowledged exact native settlement');
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
    assert.equal(child.status, 0, `second distinct structured request never completed: ${evidence}\n${child.stderr.slice(-1000)}`)
    if (scenario !== 'sequential') { const parsed = JSON.parse(evidence); assert.equal(parsed.error, undefined); return }
    const { results } = JSON.parse(evidence) as { results: Array<{ sessionId: string; threadId: string; turnId: string; output: { answer: string } }> }
    assert.deepEqual(results.map((result) => result.output.answer), ['first', 'second'])
    assert.notEqual(results[0].sessionId, results[1].sessionId)
    assert.notEqual(results[0].threadId, results[1].threadId)
    assert.notEqual(results[0].turnId, results[1].turnId)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
