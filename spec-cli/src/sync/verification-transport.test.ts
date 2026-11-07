import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { createRemoteVerificationRun, remoteVerificationEnvironment } from './verification-transport.js'
import { verificationEffectDigest, verificationExportDigest } from './verification-remote-helper.mjs'
import { executeVerification } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationEffect } from './verification-executor-types.js'
import { openProtocol } from '@spexcode/session-protocol'
import { captureInputSnapshot, readEvidence } from './snapshot.js'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { composeInputSnapshots } from './composition.js'
import { freezeCandidate } from './candidate.js'
import { runAttemptVerification } from './verification-run.js'
import { remoteVerificationFixture as fixture } from './verification-transport.fixture.test.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const realSetTimeout = setTimeout
const waitUntil = async (condition: () => boolean): Promise<void> => {
  const until = Date.now() + 10_000
  while (!condition()) { if (Date.now() > until) throw new Error('fixture condition timeout'); await new Promise(resolve => setTimeout(resolve, 20)) }
}


for (const mode of ['silent', 'complete-response'] as const) test(`AC-REMOTE-16 ${mode}超时仅保留安全元数据，区分完整响应与无响应及timer迟到`, async t => {
  t.after(() => { t.mock.timers.reset(); t.mock.restoreAll() })
  const f = fixture(t, true), previousPath = process.env.PATH, secret = 'sensitive-project-token-marker'
  process.env.PATH = f.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  writeFileSync(f.settings, JSON.stringify(mode === 'silent' ? { silentSsh: true } : { holdSshClose: true, daemon: secret, sensitiveStderr: secret }))
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rpc = remoteVerificationEnvironment(f.configuration).rpc
  const pending = rpc({ action: mode === 'silent' ? secret : 'probe', args: [secret], privateRoot: f.root, dockerEndpoint: f.configuration.dockerEndpoint, projectSecret: secret })
  const rejected = assert.rejects(pending, error => {
    const diagnostics = (error as Error & { diagnostics?: Record<string, unknown> }).diagnostics
    assert.ok(diagnostics, 'SSH超时必须附结构化安全诊断')
    assert.equal(diagnostics.action, mode === 'silent' ? 'unknown' : 'probe'); assert.equal(diagnostics.dockerVerb, mode === 'silent' ? undefined : 'info')
    assert.equal(diagnostics.budgetMs, 15_000); assert.equal(diagnostics.elapsedMs, 15_075); assert.equal(diagnostics.overdueMs, 75)
    assert.ok(Number(diagnostics.eventLoopActiveMs) >= 0); assert.ok(Number(diagnostics.eventLoopIdleMs) >= 0)
    assert.equal(diagnostics.responseLineComplete, mode === 'complete-response')
    assert.equal(Number(diagnostics.stdoutBytes) > 0, mode === 'complete-response')
    assert.equal(diagnostics.firstOutputAtMs === null, mode === 'silent')
    assert.equal(diagnostics.childCloseObserved, false)
    assert.equal(diagnostics.moduleFile, 'verification-transport.ts')
    assert.match(String(diagnostics.helperSha256), /^[a-f0-9]{64}$/)
    assert.match(String(diagnostics.moduleUrlSha256), /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(diagnostics).includes(secret), false)
    assert.equal(JSON.stringify(error).includes(secret), false)
    assert.equal(JSON.stringify(diagnostics).includes(f.root), false)
    t.diagnostic(JSON.stringify(diagnostics))
    return true
  })
  const until = Date.now() + 10_000
  while (!existsSync(f.sshReady)) { assert.ok(Date.now() < until, 'fakeSSH启动期限'); await new Promise(resolve => realSetTimeout(resolve, 20)) }
  await new Promise(resolve => realSetTimeout(resolve, 50))
  clock = 15_075
  t.mock.timers.tick(15_000)
  await rejected
})

for (const recovering of [false, true]) test(`AC-REMOTE-17 ${recovering ? '已有planned恢复' : 'planned前'}超时沿Result保诊断且不伪造资源清算`, async t => {
  t.after(() => { t.mock.timers.reset(); t.mock.restoreAll() })
  const f = fixture(t, true), input = await f.request(), previous = recovering ? await f.checkpoint() : undefined, previousPath = process.env.PATH
  process.env.PATH = f.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  writeFileSync(f.settings, JSON.stringify({ silentSsh: true }))
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = executeVerification({ ...input, ...(previous ? { runId: previous.runId, previousCheckpoint: previous } : {}) }, { transport: f.configuration, onCheckpoint: async () => assert.fail('RPC超时不造checkpoint或清算') })
  const until = Date.now() + 10_000
  while (!existsSync(f.sshReady)) { assert.ok(Date.now() < until, 'fakeSSH启动期限'); await new Promise(resolve => realSetTimeout(resolve, 20)) }
  clock = 15_025
  t.mock.timers.tick(15_000)
  const result = await pending
  assert.equal(result.status, recovering ? 'recovery_required' : 'unsupported')
  assert.equal(result.checkpoint?.phase, recovering ? 'planned' : undefined)
  assert.equal(result.evidence, undefined)
  assert.equal(result.rpcDiagnostics?.action, recovering ? 'read' : 'unscoped-read')
  assert.equal(result.rpcDiagnostics?.dockerVerb, 'version')
  assert.equal(result.rpcDiagnostics?.budgetMs, 15_000)
  assert.equal(result.reason, 'SSH验证请求超时；远端worker/CLI状态仍待原effect恢复')
  assert.equal(f.events().some(item => ['create', 'start', 'rm'].includes(item.args[1])), false)
})

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
