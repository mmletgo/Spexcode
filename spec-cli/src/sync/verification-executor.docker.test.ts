import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { dockerVerificationDriver, executeVerification, verificationExportDigest } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationPolicy, VerificationRequest } from './verification-executor-types.js'

const enabled = process.env.SPEX_DOCKER_VERIFICATION_TEST === '1'
const evidenceRoot = process.env.SPEX_VERIFICATION_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'spex-docker-evidence-'))
const fixture = resolve('spec-cli/test/fixtures/spec-sync/verification-repo')
const image = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
async function input(name: string, hanging = false): Promise<VerificationRequest> {
  const policy: VerificationPolicy = { version: 'docker-fixture-v1', image, platform: 'linux/arm64', cwd: '.', argv: ['node', '--test', hanging ? 'hang.test.mjs' : 'isolation.test.mjs'], expectedTestIds: hanging ? ['AC-DOCKER-HANG'] : ['AC-DOCKER-CHILD', 'AC-DOCKER-READONLY', 'AC-DOCKER-PRIVATE', 'AC-DOCKER-NETWORK', 'AC-DOCKER-SPOOF'], timeoutMs: 30_000, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 64 * 1024 }
  return { runId: name, inputDigest: 'real-input', candidateDigest: 'real-candidate', candidateExportDigest: await verificationExportDigest(fixture), candidateExportPath: fixture, privateScratchRoot: join(evidenceRoot, 'scratch'), policy }
}
const save = async (checkpoint: VerificationCheckpoint): Promise<void> => {
  await writeFile(join(evidenceRoot, `${checkpoint.runId}-${checkpoint.phase}.json`), JSON.stringify(checkpoint, null, 2))
}

test('AC-VERIFIER-DOCKER-01 真实 Linux Docker readonly/child/network/source/auth 隔离', { skip: !enabled }, async () => {
  const result = await executeVerification(await input('isolation'), { onCheckpoint: save })
  console.log(`Docker evidence: ${evidenceRoot}; status=${result.status}; reason=${result.reason ?? ''}`)
  assert.equal(result.status, 'passed', result.reason)
  assert.equal(result.evidence!.exitCode, 0)
  assert.equal(result.evidence!.tests.length, 5)
  assert.equal(result.evidence!.environment.driver, 'docker')
})

test('AC-VERIFIER-DOCKER-02 真实超时/取消必须实际 terminal', { skip: !enabled }, async () => {
  for (const mode of ['timeout', 'cancelled'] as const) {
    const request = await input(mode, true)
    const controller = new AbortController()
    request.signal = controller.signal
    if (mode === 'timeout') request.policy.timeoutMs = 1000
    const result = await executeVerification(request, { onCheckpoint: async checkpoint => { await save(checkpoint); if (mode === 'cancelled' && checkpoint.phase === 'created') setTimeout(() => controller.abort(), 500) } })
    assert.equal(result.status, mode, result.reason)
    const actual = result.evidence!.terminalInspect as { State: { Running: boolean; Status: string } }
    assert.equal(actual.State.Running, false)
    assert.equal(actual.State.Status, 'exited')
    assert.notEqual(result.evidence!.exitCode, 0)
  }
})

test('AC-VERIFIER-DOCKER-03 真实创建持久失败窗口，恢复不重复创建', { skip: !enabled }, async () => {
  const request = await input('recovery')
  let creates = 0
  const driver: typeof dockerVerificationDriver = async (argv, maxBytes) => { if (argv[1] === 'create') creates++; return dockerVerificationDriver(argv, maxBytes) }
  const first = await executeVerification(request, { driver, onCheckpoint: async checkpoint => { if (checkpoint.phase === 'created') throw new Error('fault-injection: durable created failure'); await save(checkpoint) } })
  assert.equal(first.status, 'recovery_required')
  assert.equal(first.checkpoint!.phase, 'planned')
  const inspected = await dockerVerificationDriver(['container', 'inspect', first.checkpoint!.uniqueContainerName], 1024 * 1024)
  await writeFile(join(evidenceRoot, 'recovery-native-inspect.json'), inspected.stdout)
  assert.equal(JSON.parse(inspected.stdout)[0].State.Status, 'created')
  const recovered = await executeVerification({ ...request, previousCheckpoint: first.checkpoint }, { driver, onCheckpoint: save })
  assert.equal(recovered.status, 'passed', recovered.reason)
  assert.equal(creates, 1)
  assert.equal(recovered.evidence!.containerId, JSON.parse(inspected.stdout)[0].Id)
})


test('AC-VERIFIER-DOCKER-04 CLI 进程真实退出后由新调用恢复同一容器', { skip: !enabled }, async () => {
  const request = await input('process-crash')
  const requestPath = join(evidenceRoot, 'process-crash-request.json')
  await writeFile(requestPath, JSON.stringify(request))
  const exitCode = await new Promise<number | null>((fulfil, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'spec-cli/test/fixtures/spec-sync/verification-crash.mjs', requestPath, evidenceRoot], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => { if (code !== 73) reject(new Error(stderr)); else fulfil(code) })
  })
  assert.equal(exitCode, 73)
  const previousCheckpoint = JSON.parse(await readFile(join(evidenceRoot, 'process-crash-checkpoint.json'), 'utf8')) as VerificationCheckpoint
  assert.equal(previousCheckpoint.phase, 'planned')
  const before = await dockerVerificationDriver(['container', 'inspect', previousCheckpoint.uniqueContainerName], 1024 * 1024)
  const actual = JSON.parse(before.stdout)[0]
  await writeFile(join(evidenceRoot, 'process-crash-native-inspect.json'), before.stdout)
  assert.equal(actual.State.Status, 'created')
  const recovered = await executeVerification({ ...request, previousCheckpoint }, { onCheckpoint: save })
  assert.equal(recovered.status, 'passed', recovered.reason)
  assert.equal(recovered.evidence!.containerId, actual.Id)
})

test('AC-VERIFIER-DOCKER-05 仓库内相对软链接在真实只读容器中保持可用', { skip: !enabled }, async () => {
  const request = await input('internal-link')
  const source = join(evidenceRoot, 'symlink-export')
  await cp(fixture, source, { recursive: true })
  await symlink('isolation.test.mjs', join(source, 'linked.test.mjs'))
  request.candidateExportPath = source
  request.candidateExportDigest = await verificationExportDigest(source)
  request.policy.argv = ['node', '--test', 'linked.test.mjs']
  const result = await executeVerification(request, { onCheckpoint: save })
  assert.equal(result.status, 'passed', result.reason)
  assert.equal(result.evidence!.tests.length, 5)
})

test('AC-VERIFIER-DOCKER-06 按VERIFY的子目录执行，绑定真实稳定用例标识', { skip: !enabled }, async () => {
  const request = await input('subdirectory')
  const source = join(evidenceRoot, 'cwd-export')
  await mkdir(join(source, 'cases'), { recursive: true })
  await writeFile(join(source, 'cases/check.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; test('export.case:1 cwd', () => assert.equal(process.cwd(), '/candidate/cases'));\n`)
  request.candidateExportPath = source
  request.candidateExportDigest = await verificationExportDigest(source)
  request.policy.cwd = 'cases'
  request.policy.argv = ['node', '--test', 'check.test.mjs']
  request.policy.expectedTestIds = ['export.case:1']
  const result = await executeVerification(request, { onCheckpoint: save })
  assert.equal(result.status, 'passed', result.reason)
  assert.deepEqual(result.evidence!.tests, [{ testId: 'export.case:1', status: 'passed' }])
})
