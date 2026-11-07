import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import test from 'node:test'
import { createRemoteVerificationRun, remoteVerificationEnvironment, type VerificationRpc } from './verification-transport.js'
import { verificationEffectDigest, verificationExportDigest } from './verification-remote-helper.mjs'
import { executeVerification } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationEffect, VerificationRequest } from './verification-executor-types.js'
import { openProtocol } from '@spexcode/session-protocol'
import { captureInputSnapshot, readEvidence } from './snapshot.js'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { composeInputSnapshots } from './composition.js'
import { freezeCandidate } from './candidate.js'
import { runAttemptVerification } from './verification-run.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const helper = new URL('./verification-remote-helper.mjs', import.meta.url).href
const waitUntil = async (condition: () => boolean): Promise<void> => {
  const until = Date.now() + 10_000
  while (!condition()) { if (Date.now() > until) throw new Error('fixture condition timeout'); await new Promise(resolve => setTimeout(resolve, 20)) }
}

function fixture(t: test.TestContext, inlineBootstrap = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'sv3-'))), root = join(temporary, 'remote'), source = join(temporary, 'local'), calls = join(temporary, 'calls.jsonl'), state = join(temporary, 'docker.json'), settings = join(temporary, 'settings.json')
  mkdirSync(root, { mode: 0o700 }); mkdirSync(source); writeFileSync(join(source, 'test.mjs'), 'export const value = 1\n')
  const socketPath = join(temporary, 'docker.sock'), socket = createServer()
  socket.listen(socketPath)
  const flock = join(temporary, 'flock'), docker = join(temporary, 'docker'), ssh = join(temporary, 'ssh'), bootstraps = join(temporary, 'bootstraps.jsonl')
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
  writeFileSync(ssh, inlineBootstrap ? `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const command=process.argv.at(-1), source=readFileSync(new URL(${JSON.stringify(helper)}));
const payload=/Buffer\\.from\\("([A-Za-z0-9+/=]+)","base64"\\)/.exec(command)?.[1];
appendFileSync(${JSON.stringify(bootstraps)},JSON.stringify({sourceBytes:source.length,commandBytes:Buffer.byteLength(command),originalBase64Bytes:source.toString('base64').length,restoredOriginalBytes:payload?gunzipSync(Buffer.from(payload,'base64')).equals(source):false,containsProjectRoot:command.includes(${JSON.stringify(root)})})+'\\n');
const p=spawn('/bin/sh',['-c',command],{stdio:'inherit'});p.on('exit',code=>process.exit(code??1));
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
  return { temporary, root, source, state, settings, bootstraps, request, checkpoint, configuration, rpc, start, scoped, events, options }
}

test('AC-REMOTE-15 可信bootstrap压缩后恢复原helper字节，并由真实Node入口读取原stdin协议', async t => {
  const f = fixture(t, true), previousPath = process.env.PATH
  process.env.PATH = f.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  const result = await remoteVerificationEnvironment(f.configuration).driver(['version', '--format', '{{json .Server}}'], 65536)
  assert.equal(result.exitCode, 0)
  assert.equal(JSON.parse(result.stdout).Version, 'fixture')
  const bootstrap = JSON.parse(readFileSync(f.bootstraps, 'utf8')) as { commandBytes: number; originalBase64Bytes: number; restoredOriginalBytes: boolean; containsProjectRoot: boolean }
  t.diagnostic(JSON.stringify(bootstrap))
  assert.equal(bootstrap.restoredOriginalBytes, true, '固定command必须携带可精确恢复原helper字节的gzip载荷')
  assert.ok(bootstrap.commandBytes < bootstrap.originalBase64Bytes * 0.4, '完整command须小于原base64载荷的40%')
  assert.equal(bootstrap.containsProjectRoot, false, '项目路径只经stdin传送')
  assert.equal(existsSync(join(f.root, '.spex-verification-control')), false, '环境只读入口不产生远端effect')
})

test('AC-REMOTE-01 正式executor真实运输、POSIX摘要、链接/模式和remote inspect原件', async t => {
  const f = fixture(t), previousPath = process.env.PATH
  process.env.PATH = f.temporary + ':' + previousPath
  t.after(() => { process.env.PATH = previousPath })
  mkdirSync(join(f.source, '目录')); writeFileSync(join(f.source, '目录', '😀.mjs'), 'unicode\0bytes'); writeFileSync(join(f.source, 'a.mjs'), '#!/bin/sh\n', { mode: 0o755 }); symlinkSync('目录/😀.mjs', join(f.source, 'linked.mjs'))
  const input = await f.request(), phases: string[] = []
  const result = await executeVerification(input, { transport: f.configuration, onCheckpoint: async checkpoint => { if (checkpoint.phase === 'terminal' && !phases.includes('terminal')) assert.ok(existsSync(f.state), '原terminal先持久再rm'); phases.push(checkpoint.phase) } })
  assert.equal(result.status, 'passed', result.reason)
  assert.equal(result.checkpoint!.version, 'verification-checkpoint-v2')
  assert.equal(result.checkpoint!.phase, 'removed')
  assert.equal(result.evidence!.exportDigest, input.candidateExportDigest)
  const actual = result.evidence!.terminalInspect as { Mounts: { Source: string }[] }
  assert.ok(actual.Mounts.every(item => item.Source.startsWith(f.root)))
  assert.notEqual(result.checkpoint!.config.candidatePath, input.candidateExportPath)
  assert.equal(f.events().filter(item => item.args[1] === 'create').length, 1)
  assert.equal(f.events().filter(item => item.args[1] === 'start').length, 1)
  assert.equal(existsSync(result.checkpoint!.transport!.plan.directory), false)
  assert.equal(existsSync(join(f.root, '.spex-verification-control', result.checkpoint!.transport!.plan.runKey, 'closed.json')), true)
  assert.ok(phases.indexOf('terminal') < phases.lastIndexOf('removed'))
})

test('AC-REMOTE-02 planned无remote intent，closed先持久后未执行结算，迟到上传被拒', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  const payload = { reporter: Buffer.from('trusted reporter\n').toString('base64'), exportDigest: checkpoint.config.exportDigest, runnerDigest: checkpoint.config.runnerDigest }
  const effect: VerificationEffect = { id: 'materialize-0', kind: 'materialize', digest: verificationEffectDigest({ effect: { kind: 'materialize' }, ...payload }) }
  checkpoint.transport!.effects.push(effect)
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => assert.fail('recover-only无launch'), { rpc: f.rpc })
  const closed = await run.close() as { fencedNotExecuted: string[] }
  assert.deepEqual(closed.fencedNotExecuted, [effect.id])
  await run.cleanup()
  const late = await f.rpc(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload })) as { rejected: string }
  assert.equal(late.rejected, 'closed')
  assert.equal(existsSync(checkpoint.transport!.plan.directory), false)
  assert.equal(f.events().some(item => ['create', 'start'].includes(item.args[1])), false)
})

test('AC-REMOTE-03 断开SSH时迟延上传worker继续排空，close不能越过锁', async t => {
  const f = fixture(t), checkpoint = await f.checkpoint(), payload = { reporter: Buffer.from('trusted reporter\n').toString('base64'), exportDigest: checkpoint.config.exportDigest, runnerDigest: checkpoint.config.runnerDigest }
  const effect = { id: 'materialize-0', kind: 'materialize', digest: verificationEffectDigest({ effect: { kind: 'materialize' }, ...payload }) }
  const input = (async function* () { yield JSON.stringify({ kind: 'file', path: 'test.mjs', executable: 0, bytes: Buffer.from('export const value = 1\n').toString('base64') }) + '\n'; await new Promise(resolve => setTimeout(resolve, 500)); yield '{"kind":"end"}\n' })()
  const active = f.start(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload }), input)
  const failed = active.finished.catch(() => undefined)
  const intent = join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'intents', effect.id + '.json')
  await waitUntil(() => existsSync(intent))
  await assert.rejects(f.rpc(f.scoped(checkpoint, { action: 'close', effects: [effect] })), /busy/)
  active.child.kill('SIGKILL'); await failed
  const receipt = join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'receipts', effect.id + '.json')
  await waitUntil(() => existsSync(receipt))
  const original = JSON.parse(readFileSync(receipt, 'utf8')) as { settled: boolean; uploaded: boolean }
  assert.equal(original.settled, true)
  assert.equal(original.uploaded, false)
  const closed = await f.rpc(f.scoped(checkpoint, { action: 'close', effects: [effect] })) as { rebuildersDrained: boolean }
  assert.equal(closed.rebuildersDrained, true)
})

test('AC-REMOTE-04 create原worker断SSH仍完成；重入仅原receipt，不二次create', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => {}, { rpc: f.rpc })
  await run.materialize(await f.request(), 'trusted reporter\n')
  writeFileSync(f.settings, JSON.stringify({ delay: { create: 500 } }))
  const args = ['container', 'create', '--name', 'fixture-name', '--mount', `type=bind,src=${checkpoint.config.candidatePath},dst=/candidate,readonly`, '--mount', `type=bind,src=${checkpoint.config.runnerPath},dst=/runner,readonly`, '--memory', '100', '--memory-swap', '100', '--cpus', '1', '--pids-limit', '20', '--tmpfs', '/tmp:rw,noexec', '--user', '1000:1000', '--workdir', '/candidate', '--entrypoint', 'node', checkpoint.config.image, '--test']
  const payload = { args, maxBytes: 65536 }, effect = { id: 'create-0', kind: 'create', digest: verificationEffectDigest({ effect: { kind: 'create' }, ...payload }) }
  checkpoint.transport!.effects.push(effect)
  const active = f.start(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload })), disconnected = active.finished.catch(() => undefined)
  await waitUntil(() => f.events().some(item => item.args[1] === 'create'))
  active.child.kill('SIGKILL'); await disconnected
  await assert.rejects(run.close(), /busy/)
  await waitUntil(() => existsSync(join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'receipts', effect.id + '.json')))
  const result = await run.driver(args, 65536)
  assert.equal(result.exitCode, 0)
  assert.equal(f.events().filter(item => item.args[1] === 'create').length, 1)
})

test('AC-REMOTE-05 worker被杀但DockerCLI仍活时锁不释放，无receipt即使NoSuch也unknown', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => {}, { rpc: f.rpc })
  await run.materialize(await f.request(), 'trusted reporter\n')
  writeFileSync(f.settings, JSON.stringify({ delay: { create: 700 } }))
  const args = ['container', 'create', '--name', 'fixture-name', '--mount', `type=bind,src=${checkpoint.config.candidatePath},dst=/candidate,readonly`, '--mount', `type=bind,src=${checkpoint.config.runnerPath},dst=/runner,readonly`, '--memory', '100', '--memory-swap', '100', '--cpus', '1', '--pids-limit', '20', '--tmpfs', '/tmp:rw,noexec', '--user', '1000:1000', '--workdir', '/candidate', '--entrypoint', 'node', checkpoint.config.image, '--test']
  const payload = { args, maxBytes: 65536 }, effect = { id: 'create-0', kind: 'create', digest: verificationEffectDigest({ effect: { kind: 'create' }, ...payload }) }
  checkpoint.transport!.effects.push(effect)
  const active = f.start(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload })), disconnected = active.finished.catch(() => undefined)
  await waitUntil(() => f.events().some(item => item.args[1] === 'create'))
  const ownCli = f.events().find(item => item.args[1] === 'create')!
  process.kill(ownCli.parent, 'SIGKILL')
  const pending = await active.finished as { pending: boolean }
  await disconnected
  assert.equal(pending.pending, true)
  assert.equal(active.child.exitCode, 0, 'worker丢失后bootstrap有界返回pending，不留下stdin管道阻止退出')
  await assert.rejects(run.close(), /busy/)
  await waitUntil(() => existsSync(f.state))
  await assert.rejects(run.close(), /未排空/)
  rmSync(f.state)
  const absent = await run.driver(['container', 'inspect', 'fixture-name'], 65536)
  assert.notEqual(absent.exitCode, 0)
  await assert.rejects(run.close(), /未排空/)
  assert.equal(checkpoint.phase, 'planned')
  assert.equal(f.events().filter(item => item.args[1] === 'create').length, 1)
})

test('AC-REMOTE-06 并发run的目录/锁/attestation不串线，关闭一run不影响另一run', async t => {
  const f = fixture(t); let left = await f.checkpoint(), right = await f.checkpoint()
  const a = createRemoteVerificationRun(f.configuration, () => left, async next => { left = next }, () => {}, { rpc: f.rpc })
  const b = createRemoteVerificationRun(f.configuration, () => right, async next => { right = next }, () => {}, { rpc: f.rpc })
  await Promise.all([a.materialize(await f.request(), 'trusted reporter\n'), b.materialize(await f.request(), 'trusted reporter\n')])
  assert.notEqual(left.transport!.plan.runKey, right.transport!.plan.runKey)
  await Promise.all([a.attest(), b.attest()])
  await a.cleanup()
  assert.equal(existsSync(left.transport!.plan.directory), false)
  assert.equal(existsSync(right.transport!.plan.candidatePath), true)
  await b.cleanup()
})

test('AC-REMOTE-07 写前拒绝symlink parent，不能等最终attest才发现写穿', async t => {
  const f = fixture(t), checkpoint = await f.checkpoint(), outside = join(f.temporary, 'outside')
  mkdirSync(outside)
  const payload = { reporter: Buffer.from('trusted reporter\n').toString('base64'), exportDigest: checkpoint.config.exportDigest, runnerDigest: checkpoint.config.runnerDigest }
  const effect = { id: 'materialize-0', kind: 'materialize', digest: verificationEffectDigest({ effect: { kind: 'materialize' }, ...payload }) }
  const directory = join(checkpoint.transport!.plan.candidatePath, 'parent')
  const input = (async function* () {
    yield '{"kind":"directory","path":"parent"}\n'
    await waitUntil(() => existsSync(directory)); rmSync(directory, { recursive: true }); symlinkSync(outside, directory)
    yield JSON.stringify({ kind: 'file', path: 'parent/payload', executable: 0, bytes: Buffer.from('must not escape').toString('base64') }) + '\n'
    yield '{"kind":"end"}\n'
  })()
  const failed = await f.rpc(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload }), input) as { settled: boolean; uploaded: boolean; reason: string }
  assert.equal(failed.settled, true); assert.equal(failed.uploaded, false); assert.match(failed.reason, /父目录不能为链接/)
  assert.equal(existsSync(join(outside, 'payload')), false)
})

test('AC-REMOTE-08 大日志gzip往返保存原stdout/stderr字节，预算按解压前原始流', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => {}, { rpc: f.rpc })
  writeFileSync(f.state, '{}'); writeFileSync(f.settings, JSON.stringify({ largeLogs: 300_000 }))
  const logs = await run.driver(['container', 'logs', 'fixture-name'], 400_000)
  assert.equal(logs.stdout.length, 300_000); assert.equal(hash(logs.stdout), hash('x'.repeat(300_000))); assert.equal(logs.stderr, 'stderr原件'); assert.equal(logs.truncated, false)
  const limited = await run.driver(['container', 'logs', 'fixture-name'], 100_000)
  assert.equal(Buffer.byteLength(limited.stdout) + Buffer.byteLength(limited.stderr), 100_000)
  assert.equal(limited.truncated, true)
})

for (const lost of ['rm', 'cleanup'] as const) test(`AC-REMOTE-09 ${lost}完成后丢原receipt，追加不存在观察且不重放删除`, async t => {
  const f = fixture(t), previousPath = process.env.PATH
  process.env.PATH = f.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  const input = await f.request(); let durable: VerificationCheckpoint | undefined, injected = false
  const first = await executeVerification(input, { transport: f.configuration, onCheckpoint: async checkpoint => {
    durable = structuredClone(checkpoint)
    if (!injected && checkpoint.phase === 'terminal' && (lost === 'rm' ? checkpoint.transport!.effects.some(item => item.kind === 'cleanup') : !!checkpoint.transport!.cleanup)) {
      injected = true
      const target = checkpoint.transport!.effects.find(item => item.kind === lost)!
      rmSync(join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'receipts', target.id + '.json'))
      throw new Error('原调用回执丢失，仅保留原intent')
    }
  } })
  assert.equal(first.status, 'recovery_required', first.reason)
  assert.equal(injected, true)
  const recovered = await executeVerification({ ...input, signal: AbortSignal.abort(), previousCheckpoint: durable }, { transport: f.configuration, onCheckpoint: async checkpoint => { durable = structuredClone(checkpoint) } })
  assert.equal(recovered.status, 'passed', recovered.reason)
  assert.equal(recovered.checkpoint!.phase, 'removed')
  assert.ok(recovered.checkpoint!.transport!.removal)
  assert.equal(existsSync(recovered.checkpoint!.transport!.plan.directory), false)
  assert.equal(f.events().filter(item => item.args[1] === 'rm').length, 1)
  assert.equal(f.events().filter(item => item.args[1] === 'create').length, 1)
  const original = recovered.checkpoint!.transport!.effects.find(item => item.kind === lost)!
  assert.equal(existsSync(join(f.root, '.spex-verification-control', recovered.checkpoint!.transport!.plan.runKey, 'receipts', original.id + '.json')), false, '不得补签原调用完成receipt')
})

test('AC-REMOTE-10 target变更拒绝，removed原结果重放不调用SSH且v1不热迁移', async t => {
  const f = fixture(t); const checkpoint = await f.checkpoint()
  assert.throws(() => createRemoteVerificationRun({ ...f.configuration, sshAlias: 'different' }, () => checkpoint, async () => assert.fail(), () => {}, { rpc: async () => assert.fail() }), /原远端绑定不匹配/)
  checkpoint.phase = 'removed'; checkpoint.notCreated = { outcome: 'cancelled', observation: { absent: true } }
  const result = await executeVerification({ ...await f.request(), runId: checkpoint.runId, previousCheckpoint: checkpoint }, { transport: f.configuration, driver: async () => assert.fail(), onCheckpoint: async () => assert.fail() })
  assert.equal(result.status, 'cancelled')
})

test('AC-REMOTE-11 半帧JSON/base64 EOF持锁保存已排空失败，同资源新序号续传', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  const payload = { reporter: Buffer.from('trusted reporter\n').toString('base64'), exportDigest: checkpoint.config.exportDigest, runnerDigest: checkpoint.config.runnerDigest, cwd: '.' }
  const effect = { id: 'materialize-0', kind: 'materialize', digest: verificationEffectDigest({ effect: { kind: 'materialize' }, ...payload }) }
  checkpoint.transport!.effects.push(effect)
  const input = (async function* () { yield '{"kind":"file","path":"test.mjs","bytes":"ZXhwb3J'; await new Promise(resolve => setTimeout(resolve, 500)) })()
  const active = f.start(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload }), input), disconnected = active.finished.catch(() => undefined)
  const control = join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey)
  await waitUntil(() => existsSync(join(checkpoint.transport!.plan.directory, 'candidate')))
  active.child.kill('SIGKILL'); await disconnected
  await waitUntil(() => existsSync(join(control, 'receipts', 'materialize-0.json')))
  const failed = JSON.parse(readFileSync(join(control, 'receipts', 'materialize-0.json'), 'utf8')) as { settled: boolean; uploaded: boolean; reason: string }
  assert.equal(failed.settled, true); assert.equal(failed.uploaded, false); assert.match(failed.reason, /JSON|Unterminated|Unexpected/)
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => {}, { rpc: f.rpc })
  await run.materialize(await f.request(), 'trusted reporter\n')
  assert.deepEqual(checkpoint.transport!.effects.map(item => item.id), ['materialize-0', 'materialize-1'])
  await run.attest(); await run.cleanup()
  assert.equal(existsSync(checkpoint.transport!.plan.directory), false)
})

test('AC-REMOTE-12 同canonical ledger保存v2、关库恢复原run，removed重放不调用SSH', async t => {
  const f = fixture(t), previousPath = process.env.PATH
  const baseRequest = await f.request()
  process.env.PATH = f.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  const git = (...args: string[]) => execFileSync('git', ['-C', f.source, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-b', 'main'); git('config', 'user.name', 'Transport fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture')
  const snapshot = await captureInputSnapshot(f.source), database = join(f.temporary, 'isolated.sqlite')
  const protocol = openProtocol(database); await migrateSyncStore(protocol)
  const scope = { paths: ['test.mjs'], contractIds: ['AC-REMOTE-01'], flowIds: [] }, options = { readBlob: (ref: { sha256: string }) => readEvidence(snapshot.source.commonDir, ref) }, store = new SyncStore(protocol, options)
  const operation = store.admitAndEnqueue({ ingressKey: 'transport-test', rootCauseId: 'input', origin: 'spec', input: snapshot, scope, budget: { maxCalls: 4, maxAttempts: 3, maxRepairs: 2, timeoutMs: 60_000 }, delivery: null, deliveryPlan: { canonicalRoot: join(f.temporary, 'delivery'), branch: 'refs/heads/codex/transport-fixture', baseCommit: snapshot.headCommit }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'readset' })
  const claim = store.claimAttempt({ operationId: operation.id, source: snapshot.source, scope, leaseMs: 60_000, expectedMessageId: operation.dispatchMessageId })
  const composed = composeInputSnapshots(snapshot).composed!; store.bindComposedInput(claim.fence, composed); store.startGeneration(claim.fence)
  const candidate = freezeCandidate(snapshot, { version: 'sync-files-v1', changes: [] }, scope, composed); store.freezeCandidate(claim.fence, candidate)
  // export必须没有Git；使用fixture原bytes，摘要仍由同walker计算。
  const exported = join(f.temporary, 'export'); mkdirSync(exported); writeFileSync(join(exported, 'test.mjs'), readFileSync(join(f.source, 'test.mjs')))
  const request = { ...baseRequest, inputDigest: snapshot.id, candidateDigest: candidate.digest, candidateExportPath: exported, candidateExportDigest: await verificationExportDigest(exported) }
  const first = await runAttemptVerification(store, claim.fence, request, { transport: f.configuration, onCheckpointRecorded: async resource => { if (resource.phase === 'created') throw new Error('模拟持久后应用中断') } })
  assert.equal(first.result.status, 'recovery_required'); assert.equal(store.readResource(first.resourceId!).phase, 'created')
  protocol.close()
  const reopened = openProtocol(database)
  try {
    const recoveredStore = new SyncStore(reopened, options)
    recoveredStore.requestControl(operation.id, 'pause')
    const settled = await runAttemptVerification(recoveredStore, claim.fence, request, { transport: f.configuration })
    assert.equal(settled.result.status, 'cancelled', settled.result.reason)
    assert.equal(settled.resourceId, first.resourceId)
    assert.equal(recoveredStore.readResource(first.resourceId!).phase, 'removed')
    assert.deepEqual(recoveredStore.listRecoverableResources(), [])
    assert.equal(recoveredStore.readAttempt(claim.attempt.id).verification, null)
    const count = f.events().length
    const replay = await runAttemptVerification(recoveredStore, claim.fence, request, { transport: { ...f.configuration, sshAlias: 'must-not-be-contacted' } })
    assert.equal(replay.result.status, 'cancelled'); assert.equal(f.events().length, count)
    assert.equal(f.events().filter(item => item.args[1] === 'create').length, 1)
    assert.equal(f.events().filter(item => item.args[1] === 'start').length, 0)
  } finally { reopened.close() }
})

test('AC-REMOTE-13 上传前只读inspect暂时失败也保存已排空receipt，可新物化序号续传', async t => {
  const f = fixture(t); let checkpoint = await f.checkpoint()
  writeFileSync(f.settings, JSON.stringify({ failInspects: 1 }))
  const run = createRemoteVerificationRun(f.configuration, () => checkpoint, async next => { checkpoint = next }, () => {}, { rpc: f.rpc })
  await run.materialize(await f.request(), 'trusted reporter\n')
  assert.deepEqual(checkpoint.transport!.effects.map(item => item.id), ['materialize-0', 'materialize-1'])
  const original = JSON.parse(readFileSync(join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'receipts', 'materialize-0.json'), 'utf8')) as { settled: boolean; uploaded: boolean }
  assert.equal(original.settled, true); assert.equal(original.uploaded, false)
  await run.attest(); await run.cleanup()
  assert.equal(existsSync(checkpoint.transport!.plan.directory), false)
})

test('AC-REMOTE-14 回执等待从上传EOF后计时，受控短时钟不会截断仍在上传的文件', async t => {
  const f = fixture(t), checkpoint = await f.checkpoint()
  f.options.replyWaitMs = 10
  const payload = { reporter: Buffer.from('trusted reporter\n').toString('base64'), exportDigest: checkpoint.config.exportDigest, runnerDigest: checkpoint.config.runnerDigest }
  const effect = { id: 'materialize-0', kind: 'materialize', digest: verificationEffectDigest({ effect: { kind: 'materialize' }, ...payload }) }
  let finishInput!: () => void
  const release = new Promise<void>(resolve => { finishInput = resolve })
  const input = (async function* () { yield JSON.stringify({ kind: 'file', path: 'test.mjs', executable: 0, bytes: readFileSync(join(f.source, 'test.mjs')).toString('base64') }) + '\n'; await release; yield '{"kind":"end"}\n' })()
  const active = f.start(f.scoped(checkpoint, { action: 'effect', requestId: randomUUID(), effect, ...payload }), input)
  const receipt = join(f.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'receipts', effect.id + '.json')
  await waitUntil(() => existsSync(join(checkpoint.transport!.plan.candidatePath, 'test.mjs')))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(existsSync(receipt), false, '输入EOF之前不能因短回执期限截断上传')
  assert.equal(active.child.exitCode, null)
  finishInput(); await active.finished
  await waitUntil(() => existsSync(receipt))
  assert.equal((JSON.parse(readFileSync(receipt, 'utf8')) as { uploaded: boolean }).uploaded, true)
})
