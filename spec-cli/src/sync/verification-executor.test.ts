import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeVerification, parseVerificationReport, verificationExportDigest } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationCommandResult, VerificationDriver, VerificationPolicy, VerificationRequest } from './verification-executor-types.js'

const image = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const policy: VerificationPolicy = { version: 'test-v1', image, platform: 'linux/arm64', argv: ['node', '--test', 'test.mjs'], expectedTestIds: ['AC-VERIFY-01'], timeoutMs: 30_000, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 64 * 1024 }
const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', truncated: false })
const report = (id = 'AC-VERIFY-01', type = 'test:pass'): string => `${JSON.stringify({ type, data: { name: `${id} title`, nesting: 0 } })}\n${JSON.stringify({ type: 'test:summary', data: { counts: { tests: 1 }, success: true } })}\n`
async function request(): Promise<VerificationRequest> {
  const root = await mkdtemp(join(tmpdir(), 'spex-executor-test-'))
  const exported = join(root, 'export')
  await mkdir(exported)
  await writeFile(join(exported, 'test.mjs'), 'import test from "node:test"; test("AC-VERIFY-01 fixture", () => {});\n')
  return { runId: 'run-1', inputDigest: 'input-1', candidateDigest: 'candidate-1', candidateExportDigest: await verificationExportDigest(exported), candidateExportPath: exported, privateScratchRoot: join(root, 'scratch'), policy: { ...policy } }
}
function fake() {
  const calls: string[][] = []
  let checkpoint: VerificationCheckpoint
  let exists = false
  let state = 'created'
  let labelsMismatch = false
  let disconnected = false
  let configMismatch = false
  let logs = report()
  const actual = () => {
    const config = checkpoint.config
    return { Id: 'a'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: '/candidate', Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: labelsMismatch ? { ...checkpoint.labels, 'spex.config': 'wrong' } : checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: configMismatch ? 'host' : 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: config.policy.memoryBytes, MemorySwap: config.policy.memoryBytes, NanoCpus: config.policy.cpus * 1e9, PidsLimit: config.policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(config.policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: state, Running: state === 'running', ExitCode: 0, OOMKilled: false, Error: '' } }
  }
  const driver: VerificationDriver = async argv => {
    calls.push([...argv])
    if (disconnected) return { ...ok(), exitCode: 1, stderr: 'daemon unavailable' }
    if (argv[0] === 'version') return ok(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.4.3' }))
    if (argv[0] === 'image') return ok(JSON.stringify([{ Id: 'sha256:image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]))
    if (argv[1] === 'inspect') return exists ? ok(JSON.stringify([actual()])) : { ...ok(), exitCode: 1, stderr: 'Error: No such container' }
    if (argv[1] === 'create') { exists = true; return ok('a'.repeat(64)) }
    if (argv[1] === 'start') { state = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'stop' || argv[1] === 'kill') { state = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'logs') return ok(logs)
    if (argv[1] === 'rm') { exists = false; return ok('a'.repeat(64)) }
    assert.fail(`unexpected ${argv}`)
  }
  return { driver, calls, save: (value: VerificationCheckpoint) => { checkpoint = value }, mismatch: () => { labelsMismatch = true }, badConfig: () => { configMismatch = true }, disconnect: () => { disconnected = true }, setLogs: (value: string) => { logs = value }, running: () => { state = 'running' } }
}

test('AC-VERIFIER-01 create/start/terminal/remove 持久顺序与真实测试结果', async () => {
  const input = await request(); const engine = fake(); const phases: string[] = []
  const result = await executeVerification(input, { driver: engine.driver, onCheckpoint: async checkpoint => { engine.save(checkpoint); phases.push(checkpoint.phase) } })
  assert.equal(result.status, 'passed')
  assert.deepEqual(phases, ['planned', 'created', 'terminal', 'removed'])
  assert.equal(result.evidence!.exitCode, 0)
  assert.equal(result.evidence!.tests[0].testId, 'AC-VERIFY-01')
  assert.ok(engine.calls.find(call => call[1] === 'create')!.includes('--read-only'))
  assert.ok(!engine.calls.find(call => call[1] === 'create')!.includes('--rm'))
})

test('AC-VERIFIER-02 创建回执持久失败后精确恢复，不重复 create、不提前 start', async () => {
  const input = await request(); const engine = fake(); let saved: VerificationCheckpoint | undefined
  const first = await executeVerification(input, { driver: engine.driver, onCheckpoint: async checkpoint => { if (checkpoint.phase === 'created') throw new Error('durable unavailable'); engine.save(checkpoint); saved = checkpoint } })
  assert.equal(first.status, 'recovery_required')
  assert.equal(saved!.phase, 'planned')
  assert.ok(!engine.calls.some(call => call[1] === 'start' || call[1] === 'rm'))
  const recovered = await executeVerification({ ...input, previousCheckpoint: saved }, { driver: engine.driver, onCheckpoint: async checkpoint => engine.save(checkpoint) })
  assert.equal(recovered.status, 'passed')
  assert.equal(engine.calls.filter(call => call[1] === 'create').length, 1)
})

test('AC-VERIFIER-03 错误 labels/config 和 daemon 断连不得接管/释放容器', async () => {
  for (const mutation of ['labels', 'config', 'daemon']) {
    const input = await request(); const engine = fake()
    const first = await executeVerification(input, { driver: engine.driver, onCheckpoint: async checkpoint => { engine.save(checkpoint); if (checkpoint.phase === 'created') throw new Error('crash') } })
    if (mutation === 'labels') engine.mismatch(); else if (mutation === 'config') engine.badConfig(); else engine.disconnect()
    const result = await executeVerification({ ...input, previousCheckpoint: first.checkpoint }, { driver: engine.driver, onCheckpoint: async checkpoint => engine.save(checkpoint) })
    assert.equal(result.status, 'recovery_required')
    assert.ok(!engine.calls.some(call => call[1] === 'start' || call[1] === 'rm'))
  }
})

test('AC-VERIFIER-04 terminal 持久失败不删除，删除回执窗口安全恢复', async () => {
  for (const phase of ['terminal', 'removed']) {
    const input = await request(); const engine = fake()
    const first = await executeVerification(input, { driver: engine.driver, onCheckpoint: async checkpoint => { if (checkpoint.phase === phase) throw new Error('durable failure'); engine.save(checkpoint) } })
    assert.equal(first.status, 'recovery_required')
    if (phase === 'terminal') assert.ok(!engine.calls.some(call => call[1] === 'rm'))
    const result = await executeVerification({ ...input, previousCheckpoint: first.checkpoint }, { driver: engine.driver, onCheckpoint: async checkpoint => engine.save(checkpoint) })
    assert.equal(result.status, 'passed')
    assert.equal(engine.calls.filter(call => call[1] === 'create').length, 1)
  }
})

test('AC-VERIFIER-05 exit0、缺失/重复/skip、候选 stdout 伪报告和截断不能伪绿', async () => {
  const variants = ['', report('OTHER'), report() + report(), report().replace('"nesting":0}', '"nesting":0,"skip":true}'), JSON.stringify({ type: 'test:stdout', data: { message: report() } }), report() + JSON.stringify({ type: 'spex:truncated', data: {} })]
  for (const logs of variants) {
    const input = await request(); const engine = fake(); engine.setLogs(logs)
    const result = await executeVerification(input, { driver: engine.driver, onCheckpoint: async checkpoint => engine.save(checkpoint) })
    assert.equal(result.status, 'failed', logs)
  }
  assert.equal(parseVerificationReport(report(), ['AC-VERIFY-01']).reportComplete, true)
})

test('AC-VERIFIER-06 取消必须停止 exact ID，并 inspect 终态；不能以 CLI 退出作终止证据', async () => {
  const input = await request(); const engine = fake(); const signal = new AbortController()
  const result = await executeVerification({ ...input, signal: signal.signal }, { driver: engine.driver, onCheckpoint: async checkpoint => { engine.save(checkpoint); if (checkpoint.phase === 'created') { engine.running(); signal.abort() } } })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.evidence!.outcome, 'cancelled')
  assert.ok(engine.calls.some(call => call[1] === 'stop' && call.at(-1) === 'a'.repeat(64)))
  assert.equal((result.evidence!.terminalInspect as { State: { Running: boolean } }).State.Running, false)
})

test('AC-VERIFIER-07 不支持政策/无 Docker/含 Git export 明确 unsupported，没有宿主执行', async () => {
  const input = await request(); const engine = fake()
  const bad = await executeVerification({ ...input, policy: { ...input.policy, image: 'node:22' } }, { driver: engine.driver, onCheckpoint: async () => assert.fail() })
  assert.equal(bad.status, 'unsupported'); assert.equal(engine.calls.length, 0)
  const missing = await executeVerification(input, { driver: async () => { throw new Error('ENOENT') }, onCheckpoint: async () => assert.fail() })
  assert.equal(missing.status, 'unsupported')
  await mkdir(join(input.candidateExportPath, '.git'))
  await assert.rejects(verificationExportDigest(input.candidateExportPath), /不得包含 .git/)
})
