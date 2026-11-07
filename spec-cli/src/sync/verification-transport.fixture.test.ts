import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type test from 'node:test'
import { remoteVerificationEnvironment, type VerificationRpc } from './verification-transport.js'
import { verificationExportDigest } from './verification-remote-helper.mjs'
import type { VerificationCheckpoint, VerificationRequest } from './verification-executor-types.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const helper = new URL('./verification-remote-helper.mjs', import.meta.url).href

export function remoteVerificationFixture(t: test.TestContext, inlineBootstrap = false, failMaterialize = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'sv3-'))), root = join(temporary, 'remote'), source = join(temporary, 'local'), calls = join(temporary, 'calls.jsonl'), state = join(temporary, 'docker.json'), settings = join(temporary, 'settings.json')
  mkdirSync(root, { mode: 0o700 }); mkdirSync(source); writeFileSync(join(source, 'test.mjs'), 'export const value = 1\n')
  const socketPath = join(temporary, 'docker.sock'), socket = createServer()
  socket.listen(socketPath)
  const flock = join(temporary, 'flock'), docker = join(temporary, 'docker'), ssh = join(temporary, 'ssh'), bootstraps = join(temporary, 'bootstraps.jsonl'), sshReady = join(temporary, 'ssh-ready')
  writeFileSync(flock, `#!/usr/bin/env python3\nimport fcntl,sys\ntry:\n fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError:\n sys.exit(1)\n`, { mode: 0o755 })
  const options: { flockProgram: string; dockerProgram: string; replyWaitMs?: number } = { flockProgram: flock, dockerProgram: docker }
  const fakeDocker = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
const calls=${JSON.stringify(calls)}, state=${JSON.stringify(state)}, settings=${JSON.stringify(settings)};
const raw=process.argv.slice(2);if(raw[0]!=='--host'||raw[1]!==${JSON.stringify('unix://' + socketPath)})throw new Error('original Unix endpoint missing');
if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT||process.env.DOCKER_TLS_VERIFY)throw new Error('Docker context override leaked');
const args=raw.slice(2), get=flag=>args[args.indexOf(flag)+1], all=flag=>args.flatMap((v,i)=>v===flag?[args[i+1]]:[]), config=existsSync(settings)?JSON.parse(readFileSync(settings,'utf8')):{};
appendFileSync(calls,JSON.stringify({args,endpoint:raw[1],pid:process.pid,parent:process.ppid})+'\\n');
if(config.delay?.[args[1]]) await new Promise(resolve=>setTimeout(resolve,config.delay[args[1]]));
if(args[1]==='inspect'&&config.failInspects) {config.failInspects--;writeFileSync(settings,JSON.stringify(config));console.error('transient inspect transport failure');process.exit(1);}
if(args[0]==='info') { console.log(config.daemon??'fixture-daemon'); process.exit(0); }
if(args[0]==='version') { console.log(JSON.stringify({Os:'linux',Arch:'amd64',Version:'fixture'})); process.exit(0); }
if(args[0]==='image') { console.log(JSON.stringify([{Id:'sha256:fixture',Os:'linux',Architecture:'amd64',Config:{Env:['PATH=/usr/bin'],Volumes:null}}])); process.exit(0); }
let data=existsSync(state)?JSON.parse(readFileSync(state,'utf8')):null;
if(args[1]==='create') {
 const mounts=all('--mount').map(v=>Object.fromEntries(v.split(',').map(s=>s.includes('=')?s.split('='):[s,true])));
 if(mounts.some(m=>!existsSync(m.src))) {console.error('mount source does not exist on daemon host');process.exit(1);}
 if(data) {console.error('name exists');process.exit(1);}
 const label=Object.fromEntries(all('--label').map(s=>{const p=s.indexOf('=');return [s.slice(0,p),s.slice(p+1)]})), image=args.indexOf('node@sha256:'+ 'a'.repeat(64));
 data={Id:'c'.repeat(64),Name:'/'+get('--name'),Image:'sha256:fixture',Platform:'linux',Config:{Image:args[image],User:get('--user'),WorkingDir:get('--workdir'),Entrypoint:[get('--entrypoint')],Cmd:args.slice(image+1),Labels:label,Env:['PATH=/usr/bin',...all('--env')],Healthcheck:{Test:['NONE']}},HostConfig:{ReadonlyRootfs:true,NetworkMode:'none',Privileged:false,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Init:true,AutoRemove:false,CgroupnsMode:'private',RestartPolicy:{Name:'no'},Memory:Number(get('--memory')),MemorySwap:Number(get('--memory-swap')),NanoCpus:Number(get('--cpus'))*1e9,PidsLimit:Number(get('--pids-limit')),Tmpfs:{'/tmp':get('--tmpfs').slice('/tmp:'.length)},LogConfig:{Type:'local',Config:Object.fromEntries(all('--log-opt').map(s=>s.split('=')))},Binds:null,Devices:[],PidMode:'',IpcMode:'private'},Mounts:mounts.map(m=>({Type:'bind',Source:m.src,Destination:m.dst,RW:false})),State:{Status:'created',Running:false,ExitCode:0,OOMKilled:false,Error:''}};
 writeFileSync(state,JSON.stringify(data));console.log(data.Id);process.exit(0);
}
if(!data) {console.error('Error: No such container');process.exit(1);}
if(args[1]==='inspect') {console.log(JSON.stringify([data]));process.exit(0);}
if(args[1]==='start'||args[1]==='stop'||args[1]==='kill') {data.State.Status=config.running&&args[1]==='start'?'running':'exited';data.State.Running=data.State.Status==='running';writeFileSync(state,JSON.stringify(data));console.log(data.Id);process.exit(0);}
if(args[1]==='logs') {
 const events=[{type:'test:pass',data:{name:'AC-REMOTE-01 real',nesting:0}},{type:'test:summary',data:{success:true,counts:{tests:1}}}];
 if(config.largeLogs) {await new Promise(resolve=>process.stdout.write('x'.repeat(config.largeLogs),resolve));await new Promise(resolve=>process.stderr.write('stderr原件',resolve));} else for(const e of events) console.log(JSON.stringify(e));
 process.exit(0);
}
if(args[1]==='rm') {rmSync(state);console.log(data.Id);process.exit(0);}
throw new Error('unexpected Docker request '+args.join(' '));
`
  writeFileSync(docker, fakeDocker, { mode: 0o755 })
  writeFileSync(ssh, failMaterialize ? `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
let buffer = '';
process.stdin.on('data', function first(chunk) {
 buffer += chunk; const end = buffer.indexOf('\\n'); if (end < 0) return;
 process.stdin.removeListener('data', first); const request = JSON.parse(buffer.slice(0, end));
 appendFileSync(${JSON.stringify(bootstraps)}, JSON.stringify({ action: request.action, kind: request.effect?.kind }) + '\\n');
 if (request.action === 'effect' && request.effect.kind === 'materialize') { console.error('fixture SSH materialize Broken pipe'); process.exit(1); }
 const p = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import(${JSON.stringify(helper)}).then(m=>m.verificationSshMain(${JSON.stringify(options)}))`)}], { stdio: ['pipe', 'inherit', 'inherit'] });
 p.stdin.write(buffer); process.stdin.pipe(p.stdin); if (process.stdin.readableEnded) p.stdin.end(); p.on('exit', code => process.exit(code ?? 1));
});
` : inlineBootstrap ? `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const command=process.argv.at(-1), source=readFileSync(new URL(${JSON.stringify(helper)}));
const payload=/Buffer\\.from\\("([A-Za-z0-9+/=]+)","base64"\\)/.exec(command)?.[1];
appendFileSync(${JSON.stringify(bootstraps)},JSON.stringify({sourceBytes:source.length,commandBytes:Buffer.byteLength(command),originalBase64Bytes:source.toString('base64').length,restoredOriginalBytes:payload?gunzipSync(Buffer.from(payload,'base64')).equals(source):false,containsProjectRoot:command.includes(${JSON.stringify(root)})})+'\\n');
const settings=existsSync(${JSON.stringify(settings)})?JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8')):{};
if(settings.silentSsh) {process.stdin.resume();writeFileSync(${JSON.stringify(sshReady)},'ready');setInterval(()=>{},1000);}
else {
 const p=spawn('/bin/sh',['-c',command],{stdio:['inherit','pipe','inherit']});p.stdout.pipe(process.stdout,{end:false});
 p.on('close',code=>{if(settings.holdSshClose){process.stderr.write(settings.sensitiveStderr);writeFileSync(${JSON.stringify(sshReady)},'ready');setInterval(()=>{},1000);}else process.exit(code??1);});
}
` : `#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nconst p=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(`import(${JSON.stringify(helper)}).then(m=>m.verificationSshMain(${JSON.stringify(options)}))`)}],{stdio:'inherit'});p.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 })
  const children: ReturnType<typeof spawn>[] = []
  const start = (request: Record<string, unknown>, frames?: AsyncIterable<string>) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(helper)}).then(m=>m.verificationSshMain(${JSON.stringify(options)}))`], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let output = '', stderr = ''
    child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') throw error })
    const finished = new Promise<unknown>((fulfil, reject) => {
      child.once('error', reject); child.once('close', code => {
        if (code !== 0) { reject(new Error('fixture SSH disconnected: ' + stderr)); return }
        try { const value = JSON.parse(output) as { ok: boolean; value: unknown; error?: string }; if (!value.ok) throw new Error(value.error); fulfil(value.value) } catch (error) { reject(error) }
      })
    })
    void (async () => { child.stdin.write(JSON.stringify(request) + '\n'); if (frames) for await (const line of frames) child.stdin.write(line); child.stdin.end() })()
    return { child, finished }
  }
  const rpc: VerificationRpc = async (request, frames) => start(request, frames).finished
  const configuration = { kind: 'ssh-docker-v1' as const, sshAlias: "fixture alias ' $", privateRoot: root, dockerEndpoint: 'unix://' + socketPath }
  const request = async (): Promise<VerificationRequest> => ({ runId: randomUUID(), inputDigest: 'input', candidateDigest: 'candidate', candidateExportDigest: await verificationExportDigest(source), candidateExportPath: source, privateScratchRoot: join(temporary, 'scratch'), policy: { version: 'remote-v1', image: 'node@sha256:' + 'a'.repeat(64), platform: 'linux/amd64', argv: ['node', '--test', 'test.mjs'], cwd: '.', expectedTestIds: ['AC-REMOTE-01'], timeoutMs: 30_000, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 1024 * 1024 } })
  const checkpoint = async (): Promise<VerificationCheckpoint> => {
    const input = await request(), plan = await remoteVerificationEnvironment(configuration, { rpc }).plan(input.runId, 'fixture-name')
    const policy = input.policy, reporter = 'trusted reporter\n', config = { image: policy.image, imageId: 'sha256:fixture', environment: ['PATH=/usr/bin', 'HOME=/tmp', 'NODE_OPTIONS='], platform: policy.platform, argv: ['node', '--test-reporter=/runner/reporter.mjs', '--test', 'test.mjs'], candidatePath: plan.candidatePath, runnerPath: plan.runnerPath, exportDigest: input.candidateExportDigest, runnerDigest: hash(reporter), policy, transport: plan }, configDigest = hash(JSON.stringify(config))
    return { version: 'verification-checkpoint-v2', phase: 'planned', runId: input.runId, inputDigest: input.inputDigest, candidateDigest: input.candidateDigest, policyDigest: hash(JSON.stringify(policy)), uniqueContainerName: 'fixture-name', labels: {}, configDigest, config, daemonVersion: 'fixture', deadlineAt: Date.now() + 30_000, transport: { plan, effects: [] } }
  }
  const events = (): { args: string[]; pid: number; parent: number }[] => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; pid: number; parent: number }) : []
  const identity = (checkpoint: VerificationCheckpoint) => ({ runId: checkpoint.runId, inputDigest: checkpoint.inputDigest, candidateDigest: checkpoint.candidateDigest, configDigest: checkpoint.configDigest, uniqueContainerName: checkpoint.uniqueContainerName })
  const scoped = (checkpoint: VerificationCheckpoint, body: Record<string, unknown>) => ({ ...body, plan: checkpoint.transport!.plan, identity: identity(checkpoint), deadlineAt: checkpoint.deadlineAt })
  t.after(async () => {
    await new Promise<void>(resolve => socket.close(() => resolve()))
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(temporary, { recursive: true, force: true })
  })
  return { temporary, root, source, state, settings, bootstraps, sshReady, request, checkpoint, configuration, rpc, start, scoped, events, options }
}
