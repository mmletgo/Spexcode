import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { freezeCandidate, exportCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { migrateSyncStore } from './migrations.js'
import { captureInputSnapshot, readEvidence } from './snapshot.js'
import { SyncStore } from './store.js'
import { dockerVerificationDriver, verificationExportDigest } from './verification-executor.js'
import type { VerificationRequest } from './verification-executor-types.js'
import { runAttemptVerification } from './verification-run.js'

const enabled = process.env.SPEX_DOCKER_VERIFICATION_TEST === '1'
async function fixture(t: test.TestContext) {
  const temporary = mkdtempSync(join(tmpdir(), 'spex-attempt-verify-'))
  const root = join(temporary, 'source')
  mkdirSync(root)
  writeFileSync(join(root, 'check.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; test('AC-RUN-01 actual', () => assert.equal(1 + 1, 2));\n`)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-b', 'main'); git('config', 'user.name', 'Verification fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture')
  const input = await captureInputSnapshot(root)
  const protocol = openProtocol(join(temporary, 'operations.sqlite'))
  t.after(() => { protocol.close(); if (existsSync(join(temporary, 'export'))) chmodSync(join(temporary, 'export'), 0o755); rmSync(temporary, { recursive: true, force: true }) })
  await migrateSyncStore(protocol)
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) })
  const scope = { paths: ['check.test.mjs'], contractIds: ['AC-RUN-01'], flowIds: [] }
  const operation = store.admitAndEnqueue({ ingressKey: 'resource-input', rootCauseId: 'input', origin: 'spec', input, scope, budget: { maxCalls: 4, maxAttempts: 3, maxRepairs: 2, timeoutMs: 60_000 }, delivery: null, deliveryPlan: { canonicalRoot: join(temporary, 'delivery'), branch: 'refs/heads/codex/delivery', baseCommit: input.headCommit }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'readset' })
  const claim = store.claimAttempt({ operationId: operation.id, source: input.source, scope, leaseMs: 60_000, expectedMessageId: operation.dispatchMessageId })
  const composed = composeInputSnapshots(input).composed!
  store.bindComposedInput(claim.fence, composed)
  store.startGeneration(claim.fence)
  const candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [] }, scope, composed)
  store.freezeCandidate(claim.fence, candidate)
  const exported = exportCandidate(input.source.commonDir, candidate, join(temporary, 'export'))
  const request: VerificationRequest = { runId: 'verify-1', inputDigest: input.id, candidateDigest: candidate.digest, candidateExportDigest: await verificationExportDigest(exported.root), candidateExportPath: exported.root, privateScratchRoot: join(temporary, 'scratch'), policy: { version: 'run-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', argv: ['node', '--test', 'check.test.mjs'], cwd: '.', expectedTestIds: ['AC-RUN-01'], timeoutMs: 30_000, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 65536 } }
  return { root, store, protocol, request, ...claim }
}

test('AC-VERIFY-RUN-01 真实创建后取消业务写权，仍持久终态及清理且不标已同步', { skip: !enabled }, async t => {
  const f = await fixture(t)
  const index = readFileSync(join(f.root, '.git/index'))
  const cancellation = new AbortController()
  const { result, resourceId } = await runAttemptVerification(f.store, f.fence, { ...f.request, signal: cancellation.signal }, {
    onCheckpointRecorded: async resource => {
      if (resource.phase === 'created') { f.store.requestControl(f.operation.id, 'cancel'); cancellation.abort() }
    },
  })
  assert.equal(result.status, 'cancelled', result.reason)
  assert.equal(f.store.readOperation(f.operation.id).phase, 'cancelled')
  assert.equal(f.store.readResource(resourceId!).phase, 'removed')
  assert.equal(f.store.readAttempt(f.attempt.id).verification, null)
  assert.deepEqual(f.store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  const actual = await dockerVerificationDriver(['container', 'inspect', result.evidence!.containerId], 4096)
  assert.notEqual(actual.exitCode, 0)
  assert.match(actual.stderr, /No such (object|container)/i)
})

test('AC-VERIFY-RUN-02 创建检查点后中断观察者，重开SQLite恢复一次真实容器，完成重入不再调用Docker', { skip: !enabled }, async t => {
  const f = await fixture(t)
  let creates = 0
  const driver: typeof dockerVerificationDriver = async (args, bytes) => { if (args[1] === 'create') creates++; return dockerVerificationDriver(args, bytes) }
  const first = await runAttemptVerification(f.store, f.fence, f.request, { driver, onCheckpointRecorded: async resource => { if (resource.phase === 'created') throw new Error('observer stopped') } })
  assert.equal(first.result.status, 'recovery_required')
  assert.equal(f.store.readResource(first.resourceId!).phase, 'created')
  const reopenedProtocol = openProtocol(f.protocol.databasePath)
  try {
    const reopened = new SyncStore(reopenedProtocol, { readBlob: ref => readEvidence(f.operation.input.source.commonDir, ref) })
    const recovered = await runAttemptVerification(reopened, f.fence, f.request, { driver })
    assert.equal(recovered.result.status, 'passed', recovered.result.reason)
    assert.equal(creates, 1)
    assert.equal(recovered.resourceId, first.resourceId)
    const replay = await runAttemptVerification(reopened, f.fence, f.request, { driver: async () => assert.fail('已结算重入不能重建/查询容器') })
    assert.equal(replay.result.status, 'passed')
    assert.equal(replay.result.evidence!.containerId, recovered.result.evidence!.containerId)
    await assert.rejects(runAttemptVerification(reopened, f.fence, { ...f.request, policy: { ...f.request.policy, timeoutMs: 2000 } }), /另一请求/)
  } finally { reopenedProtocol.close() }
})

test('AC-VERIFY-RUN-03 过期尝试恢复只结算既有资源，不重新启动容器', { skip: !enabled }, async t => {
  const f = await fixture(t)
  const first = await runAttemptVerification(f.store, f.fence, f.request, { onCheckpointRecorded: async resource => { if (resource.phase === 'created') throw new Error('paused observer') } })
  assert.equal(first.result.status, 'recovery_required')
  f.store.requestControl(f.operation.id, 'pause')
  const recovered = await runAttemptVerification(f.store, f.fence, f.request, { driver: async (args, bytes) => { assert.notEqual(args[1], 'start'); return dockerVerificationDriver(args, bytes) } })
  assert.equal(recovered.result.status, 'cancelled', recovered.result.reason)
  assert.equal(f.store.readOperation(f.operation.id).phase, 'paused')
  assert.equal(f.store.readResource(first.resourceId!).phase, 'removed')
})
