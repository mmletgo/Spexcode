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
test('two distinct structured requests complete sequentially without a watcher at maxActive=1', { skip: process.platform !== 'darwin' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'spex-structured-queue-')), repo = join(root, 'repo'), bin = join(root, 'bin')
  try {
    mkdirSync(join(repo, '.spec'), { recursive: true }); mkdirSync(bin)
    writeFileSync(join(repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', branchPrefix: 'codex/', sessions: { maxActive: 1 } }))
    writeFileSync(join(repo, 'README'), 'fixture\n')
    for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']])
      execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
    const executor = join(bin, 'codex')
    writeFileSync(executor, `#!/usr/bin/env node
import {createServer} from 'node:net';
const threads=new Map();let counter=0;
const path=process.argv[process.argv.indexOf('--listen')+1].replace('unix://','');
const server=createServer(socket=>{let buffer=Buffer.alloc(0),upgraded=false;
 const send=value=>{const p=Buffer.from(JSON.stringify(value));const h=p.length<126?Buffer.from([129,p.length]):Buffer.from([129,126,p.length>>8,p.length&255]);socket.write(Buffer.concat([h,p]));};
 const handle=m=>{let result;
  if(m.id===undefined)return;
  if(m.method==='initialize')result={};
  else if(m.method==='config/read')result={config:{sandbox_mode:'read-only',approval_policy:'never',features:{apps:false,plugins:false,hooks:false,shell_tool:false,code_mode:false,code_mode_host:false},mcp_servers:{}}};
  else if(m.method==='hooks/list')result={data:[{hooks:[],errors:[]}]};
  else if(m.method==='mcpServerStatus/list')result={data:[],nextCursor:null};
  else if(m.method==='thread/start'){const id='thread-'+(++counter);const thread={id,turns:[]};threads.set(id,thread);result={thread};}
  else if(m.method==='turn/start'){const thread=threads.get(m.params.threadId);const turn={id:'turn-'+counter,status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:JSON.stringify({answer:m.params.input[0].text.includes('first')?'first':'second'})}]};thread.turns.push(turn);result={turn:{id:turn.id}};setTimeout(()=>send({method:'turn/completed',params:{threadId:thread.id,turn}}),5);}
  else if(m.method==='thread/read'||m.method==='thread/resume')result={thread:threads.get(m.params.threadId)};
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
    const core = fileURLToPath(new URL('../../packages/spec-core/src/index.ts', import.meta.url))
    writeFileSync(runner, `import {runStructuredSession} from ${JSON.stringify(source)};
import {currentCodexGeneration} from ${JSON.stringify(generations)};
import {runtimeRoot,verifyDetachedRuntime} from ${JSON.stringify(core)};
import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const results=[];let error;
try{for(const answer of ['first','second'])results.push(await runStructuredSession({root:process.cwd(),requestKey:'queue-'+answer,inputDigest:'frozen-'+answer,purpose:'queue-regression',prompt:'Return '+answer,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},timeoutMs:3000}));}
catch(e){error={code:e.code,message:e.message,sessionId:e.sessionId,threadId:e.threadId};}
finally{const endpoint=currentCodexGeneration(join(runtimeRoot(),'structured-read-only-v1/control'));if(endpoint){const pid=Number(readFileSync(endpoint.pidFile,'utf8'));if(verifyDetachedRuntime(pid,endpoint.receiptFile).ok)process.kill(-pid,'SIGTERM');}}
writeFileSync(${JSON.stringify(join(root, 'results.json'))},JSON.stringify({results,error}));process.exit(results.length===2?0:1);
`)
    const child = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], {
      cwd: repo, encoding: 'utf8', timeout: 12_000,
      env: { ...process.env, SPEXCODE_HOME: join(root, 'runtime'), SPEX_SESSION_DATABASE_PATH: join(root, 'runtime/sessions.sqlite'), PATH: `${bin}:${process.env.PATH}` },
    })
    const evidence = readFileSync(join(root, 'results.json'), 'utf8')
    assert.equal(child.status, 0, `second distinct structured request never completed: ${evidence}\n${child.stderr.slice(-1000)}`)
    const { results } = JSON.parse(evidence) as { results: Array<{ sessionId: string; threadId: string; turnId: string; output: { answer: string } }> }
    assert.deepEqual(results.map((result) => result.output.answer), ['first', 'second'])
    assert.notEqual(results[0].sessionId, results[1].sessionId)
    assert.notEqual(results[0].threadId, results[1].threadId)
    assert.notEqual(results[0].turnId, results[1].turnId)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
