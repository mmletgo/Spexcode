import { retainHistoricalFrozenWorkflow } from './historical-workflow.test-helpers.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress } from './migrations.js'
import { SyncApplication } from './application.js'
import { prepareSpecBodyEdit } from '../spec-body-edit.js'
import { prepareSyncAdmission } from './coordinator.js'
import { readSyncCheckpoints } from './checkpoint-evidence.js'
import type { VerificationResult } from './verification-executor-types.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { captureInputSnapshot } from './snapshot.js'
import { readSyncSettings, SyncApplicationError } from './settings.js'
import type { SyncSettings } from './settings.js'
import type { ContractCell, GeneratedTables } from './elaboration-markdown.js'
import { contractBusinessProse, sameContractBusinessMeaning } from './contract-evolution.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationSessionRequest } from './elaboration-types.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { contentHash, identifyWorktree, writeEvidence, readEvidence, readObject, readTree, writeObject, writeTree } from './snapshot.js'
import { claimFileMutex } from './file-mutex.js'
import type { FileMutex } from './file-mutex.js'
import { composeAuthoredInput } from './author-input.js'
import { assemblePublicationBase, verifyPublicationBase } from './publication-base.js'
import { ownedObligationPaths } from './prior-context.js'
import { readCompositionEvidence } from './composition.js'
import { adaptElaborationNativeOutput } from '../../test/elaboration-native-output.js'
import { readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'
import { composeControlledRequest, prepareControlledRequest, renderControlledDecisionRaw } from './request-input.js'
import { inspectTrustedRuntime } from './trusted-hooks.js'
import type { NativeRunPlan, NativeRunCheckpoint } from './native-run.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { ApplyJournal, BaselinePair, VerificationResultBlob } from './operation-types.js'

const settings = {
  version: 'sync-settings-v1', nodeIds: ['demo'], sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'],
  verifications: [{ definition: { id: 'VERIFY-DEMO-01', command: ['node', '--test', 'tests/demo.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }],
  mandatoryTests: [], facts: [], budget: { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 30000 },
} satisfies SyncSettings
const source = '---\ntitle: Demo\nstatus: pending\n---\n# Demo\n\n## raw source\n\n返回用户指定的文本。\n\n## expanded spec\n\n待细化。\n'
function gitReadCounter(directory: string): { reset(): void; entries(): string[]; restore(): void } {
  const bin = join(directory, 'git-read-counter-bin'), log = join(directory, 'git-read-counter.log'), wrapper = join(bin, 'git')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  mkdirSync(bin, { mode: 0o700 }); writeFileSync(log, '')
  writeFileSync(wrapper, '#!/bin/sh\ncase " $* " in\n  *" ls-tree -rlz --full-tree "*) last=""; for arg do last="$arg"; done; printf "tree:%s\\n" "$last" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\n  *" ls-files -z --full-name --cached --others --exclude-standard "*) printf "capture\\n" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\nesac\nexec "$SPEX_SYNC_TEST_REAL_GIT" "$@"\n')
  chmodSync(wrapper, 0o700)
  const oldPath = process.env.PATH, oldCounter = process.env.SPEX_SYNC_TEST_GIT_COUNTER, oldRealGit = process.env.SPEX_SYNC_TEST_REAL_GIT
  process.env.PATH = `${bin}:${oldPath ?? ''}`; process.env.SPEX_SYNC_TEST_GIT_COUNTER = log; process.env.SPEX_SYNC_TEST_REAL_GIT = realGit
  return {
    reset: () => writeFileSync(log, ''),
    entries: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    restore: () => {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
      if (oldCounter === undefined) delete process.env.SPEX_SYNC_TEST_GIT_COUNTER; else process.env.SPEX_SYNC_TEST_GIT_COUNTER = oldCounter
      if (oldRealGit === undefined) delete process.env.SPEX_SYNC_TEST_REAL_GIT; else process.env.SPEX_SYNC_TEST_REAL_GIT = oldRealGit
    },
  }
}
async function fixture(config: unknown = settings, onRun?: (request: ElaborationSessionRequest) => Promise<never>, nativeWorktree = false) {
  const temp = mkdtempSync(join(tmpdir(), 'sync-application-')), root = join(temp, 'source')
  mkdirSync(join(root, '.spec', 'demo'), { recursive: true }); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, '.spec', 'demo', 'spec.md'), source)
  writeFileSync(join(root, '.spec', 'spexcode.json'), JSON.stringify({ sync: config }))
  writeFileSync(join(root, 'src', 'demo.mjs'), 'export const demo = text => text\n')
  writeFileSync(join(root, 'tests', 'demo.test.mjs'), "import test from 'node:test'; test('DEMO-01', () => {})\n")
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const git = (args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['add', '.']); git(['commit', '-qm', 'fixture'])
  const protocol = openProtocol(join(temp, 'sessions.sqlite'))
  const calls: ElaborationSessionRequest[] = []
  const application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); if (onRun) return onRun(request); throw Object.assign(new Error('受控生成环境故障'), { code: 'unsupported' }) } })
  if (!nativeWorktree) retainHistoricalFrozenWorkflow(application)
  return { temp, root, git, protocol, application, calls, cleanup: (): void => { protocol.close(); rmSync(temp, { recursive: true, force: true }) } }
}
function governDemoCode(f: Awaited<ReturnType<typeof fixture>>): void {
  writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
  f.git(['add', '.spec/demo/spec.md'])
  f.git(['commit', '-qm', 'fixture: govern demo implementation'])
}

for (const mode of ['settled', 'pending-journal', 'unknown', 'wrong-input', 'foreign-root', 'bad-plan', 'missing-plan'] as const) test(`resource-only真实source身份变化仍能只结算旧资源，正常recover/read/resume继续404 ${mode}`, async t => {
  const f = await fixture()
  try {
    const input = await captureInputSnapshot(f.root)
    const plan: SyncCoordinatorPlan = { version: 'sync-coordinator-v1', intentNodeId: 'demo', targets: [{ nodeId: 'demo', path: '.spec/demo/spec.md' }], readPaths: ['.spec', 'src', 'tests', 'package.json'], writePaths: ['.spec', 'src'], facts: [], verifications: settings.verifications, mandatoryTests: [] }
    const operation = f.application.store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: 'resource-only-old-source', rootCauseId: 'resource-only-old-source', origin: 'spec', budget: settings.budget, managedRoot: f.application['managedRoot'] }))
    const claimed = f.application.store.claimAttempt({ operationId: operation.id, source: input.source, scope: operation.scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
    const request = { root: f.root, base: input.headCommit, prompt: '尚未请求Native的精确历史资源', schema: { type: 'object' }, requestKey: 'resource-only-native', inputDigest: input.id, purpose: 'elaboration_generate', timeoutMs: 1000 }
    const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.application.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: claimed.attempt.id, inputId: input.id, candidateDigest: null }
    const nativePlan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    const resource = f.application.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: input.id, candidateDigest: null, planBlob: writeEvidence(input.source.commonDir, nativePlan), checkpointRef: writeEvidence(input.source.commonDir, checkpoint) })
    if (mode === 'unknown') f.application.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: resource.checkpointRef, checkpointRef: writeEvidence(input.source.commonDir, { ...checkpoint, phase: 'created', nativeCallRequested: true, nativeStarted: true, nativeState: 'running', session: { sessionId: expectedSessionId, threadId: 'historical-missing-thread', turnId: 'historical-missing-turn' } }) })
    if (mode === 'bad-plan' || mode === 'missing-plan') {
      const damaged = { ...f.application.store.readResource(resource.id), plan: { ...resource.plan, planBlob: mode === 'missing-plan' ? { sha256: 'f'.repeat(64) } : writeEvidence(input.source.commonDir, { ...nativePlan, expectedSessionId: 'foreign-session' }) } }
      f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET record_json=? WHERE id=?', JSON.stringify(damaged), resource.id))
    }
    if (mode === 'pending-journal') {
      // 仅登记opaque未决日志作故障夹具，不声称已有V1–V4或有效交付；资源入口必须保持它而不回放。
      const journal: ApplyJournal = { id: 'resource-only-pending-journal', operationId: operation.id, attemptId: claimed.attempt.id, generation: claimed.attempt.generation, status: 'applying', steps: [], receipt: null, createdAtMs: Date.now(), plan: { effectKey: 'resource-only-pending', payloadDigest: 'pending', candidateDigest: 'pending', verificationBlob: writeEvidence(input.source.commonDir, { pending: true }), target: input.source, expectedTargetSnapshotId: input.id, expectedBaselinePairId: null, coveredScope: operation.scope, files: [], planBlob: writeEvidence(input.source.commonDir, { pending: true }) } }
      f.protocol.withTransaction(tx => tx.exec('INSERT INTO sync_apply_journals(id,operation_id,attempt_id,effect_key,payload_digest,status,receipt_id,record_json) VALUES(?,?,?,?,?,?,?,?)', journal.id, operation.id, claimed.attempt.id, journal.plan.effectKey, journal.plan.payloadDigest, journal.status, null, JSON.stringify(journal)))
    }
    const businessEvidence = writeEvidence(input.source.commonDir, { outputDigest: '原失败输出摘要不改', findings: [{ code: 'reference-kind', message: 'FLOW.req必须引用REQ' }] })
    f.application.store.checkpoint(claimed.fence, businessEvidence)
    f.application.store.recordFailure(claimed.fence, { code: 'repair_budget_exhausted', message: '原结构失败不因资源清理升格', kind: 'repairable', evidenceRefs: [businessEvidence] })
    const before = f.application.store.readOperation(operation.id), beforeAttempt = f.application.store.readAttempt(claimed.attempt.id), beforeResources = f.application.store.readResource(resource.id), beforeJournals = f.application.store.listJournals(operation.id)
    const gitBackup = join(f.temp, 'original-git')
    renameSync(join(f.root, '.git'), gitBackup); cpSync(gitBackup, join(f.root, '.git'), { recursive: true })
    const current = identifyWorktree(f.root)
    assert.equal(current.canonicalRoot, input.source.canonicalRoot); assert.equal(current.commonDir, input.source.commonDir)
    assert.notEqual(current.repositoryId, input.source.repositoryId, '真实.git inode变化复现repoId漂移，未改旧input')
    for (const action of ['recover', 'cancel', 'resume'] as const) await assert.rejects(f.application.control(operation.id, action), { code: 'sync_operation_wrong_source', status: 404 })
    await assert.rejects(f.application.readOperation(operation.id), { code: 'sync_operation_wrong_source', status: 404 })
    t.diagnostic(JSON.stringify({ sourceMismatchBlocksNormalRecovery: true, sameCanonicalRoot: true, sameCommonDir: true, repositoryIdChanged: true }))
    const businessCalls: string[] = []
    for (const key of ['claimAttempt', 'reserveDispatch', 'bindSession', 'planResource', 'startGeneration', 'freezeCandidate', 'recordVerification', 'beginApply', 'recordReceipt', 'settleApply'] as const) f.application.store[key] = () => { businessCalls.push(key); return assert.fail(`资源入口触碰业务方法: ${key}`) }
    if (mode === 'wrong-input') await assert.rejects(f.application.recoverResources(operation.id, 'wrong-input'), { code: 'resource_recovery_input', status: 409 })
    else if (mode === 'foreign-root') {
      const foreignRoot = join(f.temp, 'foreign-root'); mkdirSync(foreignRoot); execFileSync('git', ['init', '-q', foreignRoot])
      execFileSync('git', ['-C', foreignRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
      const foreign = await SyncApplication.createResourceRecovery(foreignRoot, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'foreign-runtime') })
      await assert.rejects(foreign.recoverResources(operation.id, input.id), { code: 'resource_recovery_source', status: 404 })
    } else {
      const recovered = await f.application.recoverResources(operation.id, input.id)
      const pending = ['unknown', 'bad-plan', 'missing-plan'].includes(mode)
      assert.equal(recovered.status, pending ? 'recovery_required' : 'resources_recovered', JSON.stringify(recovered.failure))
      assert.equal(f.application.store.readResource(resource.id).phase, pending ? beforeResources.phase : 'removed')
      assert.deepEqual(recovered.pendingJournalIds, mode === 'pending-journal' ? ['resource-only-pending-journal'] : [])
      if (mode === 'bad-plan') assert.equal(recovered.failure!.code, 'resource_recovery')
      if (mode === 'unknown') assert.notEqual((JSON.parse(readEvidence(input.source.commonDir, f.application.store.readResource(resource.id).checkpointRef).toString()) as NativeRunCheckpoint).stop?.nativeStopped, true)
    }
    assert.deepEqual(businessCalls, [])
    if (mode === 'wrong-input' || mode === 'foreign-root') assert.deepEqual(f.application.store.readResource(resource.id), beforeResources)
    assert.deepEqual(f.application.store.readOperation(operation.id), before)
    assert.deepEqual(f.application.store.readAttempt(claimed.attempt.id), beforeAttempt)
    assert.deepEqual(readEvidence(input.source.commonDir, businessEvidence), Buffer.from(JSON.stringify({ outputDigest: '原失败输出摘要不改', findings: [{ code: 'reference-kind', message: 'FLOW.req必须引用REQ' }] })))
    assert.equal(f.calls.length, 0); assert.deepEqual(f.application.store.listJournals(operation.id), beforeJournals)
    for (const action of ['recover', 'resume'] as const) await assert.rejects(f.application.control(operation.id, action), { code: 'sync_operation_wrong_source', status: 404 })
  } finally { await f.application.stopService(); f.cleanup() }
})

test('操作模型经真实Git入口持久化，重启和省略重试继承，普通重复不能刷新预算', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    await f.application.automaticControl('pause')
    const first = (await f.application.submit({ nodeId: 'demo', requestId: 'default-model' })).operation!
    assert.equal(first.model, undefined)
    const toolsRef = (operation: typeof first): string => join(f.temp, 'runtime', 'artifacts', `application-runtime-${contentHash(operation.ingressKey)}.json`)
    const oldTools = readFileSync(toolsRef(first), 'utf8'), oldPayload = first.payloadDigest
    assert.equal(JSON.parse(oldTools).version, 'sync-tools-v1')
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'default-model', model: 'gpt-6.1-terra' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-model-change', model: 'gpt-6.1-terra' }), /SYNC_MODEL_RETRY_REQUIRED/)
    assert.equal((await f.application.status()).operations.length, 1)
    assert.equal((await f.application.submit({ nodeId: 'demo', requestId: 'default-model', model: 'gpt-6.1-sol' })).operation!.id, first.id)
    await f.application.control(first.id, 'cancel')
    const residualKey = `application:${first.input.source.repositoryId}:${first.input.source.canonicalRoot}:ordinary-model-change`
    const dispatchBefore = f.application.store.nextDispatch(first.input.source.repositoryId)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-model-change', retryOf: first.id, model: 'gpt-6-astra' }), /模型不同/)
    const residualPath = join(f.temp, 'runtime', 'artifacts', `application-runtime-${contentHash(residualKey)}.json`)
    renameSync(residualPath, `${residualPath}.saved`)
    try {
      await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-model-change', retryOf: first.id, model: 'gpt-6-astra' }), /模型不同/)
      assert.throws(() => readFileSync(residualPath), /ENOENT/)
    } finally { renameSync(`${residualPath}.saved`, residualPath) }
    assert.equal(f.application.store.findOperationByIngressKey(residualKey), null); assert.equal(f.application.store.findIngressReceipt(residualKey), null)
    assert.deepEqual(f.application.store.nextDispatch(first.input.source.repositoryId), dispatchBefore)
    assert.equal((await f.application.status()).operations.length, 1)
    const chosen = (await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-model-change', retryOf: first.id, model: 'gpt-6.1-terra' })).operation!
    assert.equal(chosen.model, 'gpt-6.1-terra'); assert.equal(chosen.callsUsed, 0)
    assert.deepEqual(chosen.input, first.input); assert.equal(chosen.policyDigest, first.policyDigest); assert.equal(chosen.readSetDigest, first.readSetDigest)
    assert.deepEqual(chosen.budget, first.budget)
    const selectedTools = readFileSync(toolsRef(chosen), 'utf8')
    assert.equal(JSON.parse(selectedTools).version, 'sync-tools-v2'); assert.equal(JSON.parse(selectedTools).model, chosen.model)
    await f.application.stopService()
    const restarted = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { f.calls.push(request); throw Object.assign(new Error('受控原生环境故障'), { code: 'unsupported' }) } })
    retainHistoricalFrozenWorkflow(restarted)
    try {
      const replay = (await restarted.submit({ nodeId: 'demo', requestId: 'ordinary-model-change', retryOf: first.id })).operation!
      assert.equal(replay.id, chosen.id); assert.equal(replay.model, chosen.model)
      assert.equal(readFileSync(toolsRef(chosen), 'utf8'), selectedTools)
      assert.equal(restarted.store.readOperation(first.id).payloadDigest, oldPayload); assert.equal(readFileSync(toolsRef(first), 'utf8'), oldTools)
      await restarted.control(chosen.id, 'cancel')
      const inherited = (await restarted.submit({ nodeId: 'demo', requestId: 'inherited-model', retryOf: chosen.id })).operation!
      assert.equal(inherited.model, chosen.model)
      await restarted.automaticControl('resume')
      await restarted.wait(inherited.id)
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, 'gpt-6.1-terra'); assert.equal(f.calls[0].effort, 'high')
      const saved = JSON.parse(readFileSync(toolsRef(inherited), 'utf8'))
      writeFileSync(toolsRef(inherited), JSON.stringify({ ...saved, model: 'gpt-6-astra' }))
      const availability = (await restarted.readOperation(inherited.id)).executionAvailability
      assert.equal(availability.status, 'recovery_required'); assert.equal(availability.failure!.code, 'sync_execution_metadata_unavailable'); assert.match(availability.failure!.message, /模型不同/)
    } finally { await restarted.stopService() }
  } finally { await f.application.stopService(); f.cleanup() }
})

test('新手动操作采用各项目版本化默认模型，显式模型优先且省略retry沿用原选择', async () => {
  const firstProject = await fixture({ ...settings, model: 'claude:MiniMax-M3' })
  const secondProject = await fixture({ ...settings, model: 'gpt-6.1-astra' })
  try {
    await firstProject.application.enable(); await secondProject.application.enable()
    const first = (await firstProject.application.submit({ nodeId: 'demo', requestId: 'project-default-A' })).operation!
    const second = (await secondProject.application.submit({ nodeId: 'demo', requestId: 'project-default-B' })).operation!
    await firstProject.application.wait(first.id); await secondProject.application.wait(second.id)
    assert.equal(first.model, 'claude:MiniMax-M3')
    assert.equal(second.model, 'gpt-6.1-astra')

    const override = (await firstProject.application.submit({ nodeId: 'demo', requestId: 'manual-model-override', retryOf: first.id, model: 'gpt-6.1-terra' })).operation!
    assert.equal(override.model, 'gpt-6.1-terra')
    await firstProject.application.wait(override.id)
    const inherited = (await firstProject.application.submit({ nodeId: 'demo', requestId: 'retry-model-inherited', retryOf: override.id })).operation!
    assert.equal(inherited.model, 'gpt-6.1-terra')
    await firstProject.application.wait(inherited.id)
    assert.deepEqual(firstProject.calls.map(request => request.model), ['claude:MiniMax-M3', 'gpt-6.1-terra', 'gpt-6.1-terra'])
    assert.deepEqual(secondProject.calls.map(request => request.model), ['gpt-6.1-astra'])

    writeFileSync(join(firstProject.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, model: 'gpt-6.1-astra' } }))
    assert.equal((await firstProject.application.readSettings()).activation, 'invalidated')
    await assert.rejects(firstProject.application.submit({ nodeId: 'demo', requestId: 'model-config-change' }), /配置已变化/)
    assert.equal(firstProject.application.store.readOperation(first.id).model, 'claude:MiniMax-M3')
    assert.deepEqual(firstProject.application.store.readOperation(first.id).budget, first.budget)
    firstProject.git(['add', '.spec/spexcode.json']); firstProject.git(['commit', '-qm', 'authorize model configuration'])
    await firstProject.application.enable()
    const explicit = (await firstProject.application.submit({ nodeId: 'demo', requestId: 'fresh-explicit-override', model: 'gpt-6.1-terra' })).operation!
    assert.equal(explicit.model, 'gpt-6.1-terra')
    await firstProject.application.wait(explicit.id)
    assert.equal(firstProject.calls.at(-1)!.model, 'gpt-6.1-terra')
  } finally {
    await firstProject.application.stopService(); firstProject.cleanup()
    await secondProject.application.stopService(); secondProject.cleanup()
  }
})

for (const nativeDefault of [false, true]) test(`自动观察准入、固定工具描述和真实runner请求使用同一项目model ${nativeDefault ? '原生缺省' : '显式项目选择'}`, async () => {
  const model = nativeDefault ? 'claude:default' : 'claude:MiniMax-M3', f = await fixture(nativeDefault ? settings : { ...settings, model }, undefined, nativeDefault)
  try {
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    const initial = f.application.observationStatus().latestSnapshot!.id
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `automatic:${text}`\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'automatic model input'])
    await observeUntil(() => f.application.observationStatus().latestSnapshot?.id !== initial)
    await f.application.automaticControl('resume')
    await observeUntil(() => f.calls.length > 0)
    const operations = (await f.application.status()).operations
    assert.equal(operations.length, 1)
    const detail = await f.application.wait(operations[0].operation.id)
    assert.equal(detail.operation.model, model)
    assert.ok(f.calls.length > 0)
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, f.calls.length)
    assert.ok(f.calls.every(call => call.model === detail.operation.model))
    const toolsRef = join(f.temp, 'runtime', 'artifacts', `application-runtime-${contentHash(detail.operation.ingressKey)}.json`)
    const saved = JSON.parse(readFileSync(toolsRef, 'utf8'))
    assert.equal(saved.version, nativeDefault ? 'sync-tools-v3' : 'sync-tools-v2')
    assert.equal(saved.model, model)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-01 缺少可信配置明确拒绝，现有配置启用CAS且不修改版本化文件', async () => {
  const f = await fixture(undefined)
  try {
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), '{}')
    assert.equal((await f.application.readSettings()).configurationError?.code, 'sync_configuration_invalid')
    f.git(['add', '.spec/spexcode.json']); f.git(['commit', '-qm', 'invalid committed configuration'])
    await assert.rejects(f.application.enable(), /配置缺口/)
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: settings }))
    f.git(['add', '.spec/spexcode.json']); f.git(['commit', '-qm', 'trusted committed configuration'])
    const before = f.git(['rev-parse', 'HEAD']), bytes = readFileSync(join(f.root, '.spec', 'spexcode.json'))
    const state = await f.application.readSettings()
    await assert.rejects(f.application.enable('b'.repeat(64)), /摘要已过期/)
    assert.equal((await f.application.enable(state.configDigest!)).enabled, true)
    assert.deepEqual(readFileSync(join(f.root, '.spec', 'spexcode.json')), bytes)
    assert.equal(f.git(['rev-parse', 'HEAD']), before)
  } finally { f.cleanup() }
})

test('版本化sync.model接受精确字符串并拒绝空值或首尾空格', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, model: 'claude:MiniMax-M3' } }))
    assert.equal(readSyncSettings(await captureInputSnapshot(f.root)).settings.model, 'claude:MiniMax-M3')
    for (const model of ['', ' claude:MiniMax-M3', 'claude:MiniMax-M3 ']) {
      writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, model } }))
      const snapshot = await captureInputSnapshot(f.root)
      assert.throws(() => readSyncSettings(snapshot), /model|模型/)
    }
  } finally { f.cleanup() }
})

test('AC-APPLICATION-SCRATCH 可信版本化环境允许可选布尔 scratchExecutable，拒绝其他类型', async () => {
  const f = await fixture()
  try {
    for (const scratchExecutable of [undefined, false, true]) {
      const config: SyncSettings = structuredClone(settings)
      if (scratchExecutable !== undefined) config.verifications[0].environment.scratchExecutable = scratchExecutable
      writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: config }))
      const frozen = await captureInputSnapshot(f.root)
      assert.deepEqual(readSyncSettings(frozen).settings.verifications[0].environment, config.verifications[0].environment)
    }
    for (const scratchExecutable of ['true', 1, null]) {
      const config = structuredClone(settings)
      Object.assign(config.verifications[0].environment, { scratchExecutable })
      writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: config }))
      const frozen = await captureInputSnapshot(f.root)
      assert.throws(() => readSyncSettings(frozen), /scratchExecutable/)
    }
  } finally { f.cleanup() }
})

test('AC-APPLICATION-02 受控no-op不提交不派发，来源身份与body必须对应冻结输入', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const head = f.git(['rev-parse', 'HEAD'])
    assert.deepEqual(await f.application.submit({ nodeId: 'demo', requestId: 'no-op', patch: { startLine: 1, endLine: 1, original: '# Demo', replacement: '# Demo' } }), { changed: false, operation: null })
    assert.equal((await f.application.status()).operations.length, 0)
    assert.equal(f.git(['rev-parse', 'HEAD']), head)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'stale-patch', patch: { startLine: 1, endLine: 1, original: '# Older', replacement: '# Next' } }), /changed since/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'bad-origin', origin: 'external' as 'spec' }), /输入来源必须/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-03 受控编辑成为持久operation，重复幂等且真实失败可查询，不先提交Spec', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const head = f.git(['rev-parse', 'HEAD'])
    const request = { nodeId: 'demo', requestId: 'edit-1', patch: { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' } }
    const first = await f.application.submit(request)
    assert.ok(first.operation?.requestBlob)
    const detail = await f.application.wait(first.operation.id)
    assert.equal(detail.operation.phase, 'failed')
    assert.ok(detail.attempt?.failure?.message)
    assert.equal(detail.sourceSynced, false)
    assert.equal(detail.stale, false)
    assert.equal((await f.application.submit(request)).operation?.id, first.operation.id)
    await f.application.wait(first.operation.id)
    assert.equal((await f.application.status({ nodeId: 'demo' })).operations.length, 1)
    assert.equal(readFileSync(join(f.root, '.spec', 'demo', 'spec.md'), 'utf8'), source)
    assert.equal(f.git(['rev-parse', 'HEAD']), head)
    await assert.rejects(f.application.submit({ ...request, patch: { ...request.patch, replacement: '另一意图' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { f.cleanup() }
})

test('status复用本轮快照并让重试资格复用详情的闭包当前性', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'status-read-reuse', origin: 'initial' }); assert.ok(submitted.operation)
    await f.application.wait(submitted.operation.id)
    const counter = gitReadCounter(f.temp)
    try {
      const result = await f.application.status(), detail = result.operations[0]
      assert.equal(result.operations.length, 1, JSON.stringify(result.operations.map(item => ({ phase: item.operation.phase, stale: item.stale, sourceSynced: item.sourceSynced, retryEligible: item.retryEligibility.eligible }))))
      assert.ok(detail)
      assert.equal(detail.stale, false)
      assert.equal(detail.retryEligibility.eligible, true)
      const entries = counter.entries()
      assert.equal(entries.filter(entry => entry === 'capture').length, 2, 'status只采一次快照（双重observe各读取一次索引）')
      assert.equal(entries.filter(entry => entry.startsWith('tree:')).length, 9, '同一status保留其他证明读取，并仅计算一次闭包当前性')
    } finally { counter.restore() }
  } finally { f.cleanup() }
})

test('AC-APPLICATION-04 当前输入或可信配置变化令旧结果过期，暂停恢复不能使用旧输入', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const result = await f.application.submit({ nodeId: 'demo', requestId: 'run-1' }); assert.ok(result.operation)
    await f.application.wait(result.operation.id)
    await f.application.control(result.operation.id, 'pause')
    writeFileSync(join(f.root, 'src', 'demo.mjs'), 'export const demo = text => `${text}!`\n')
    assert.equal((await f.application.readOperation(result.operation.id)).stale, true)
    await assert.rejects(f.application.control(result.operation.id, 'resume'), /恢复输入已变化/)
    assert.equal((await f.application.readOperation(result.operation.id)).operation.control, 'pause')
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: { ...settings, budget: { ...settings.budget, maxCalls: 6 } } }))
    assert.equal((await f.application.readSettings()).enabled, false)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'new' }), /配置已变化/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-05 图影响和旧节点治理纳入共享叶，配置不能指定宿主fallback命令', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.root, '.spec', 'demo', 'spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
    mkdirSync(join(f.root, '.spec', 'other')); writeFileSync(join(f.root, '.spec', 'other', 'spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
    const plan = await buildSyncApplicationPlan(await captureInputSnapshot(f.root), 'demo')
    assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), ['demo', 'other'])
    assert.ok(plan.writePaths.includes('src'))
    assert.ok(plan.readPaths.includes('.spec/spexcode.json'))
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: { ...settings, verifications: [{ ...settings.verifications[0], definition: { ...settings.verifications[0].definition, command: ['npm', 'test'] } }] } }))
    const invalid = await captureInputSnapshot(f.root)
    assert.throws(() => readSyncSettings(invalid), /Docker Node/)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: settings.budget.timeoutMs + 1 } }))
    const invalidTimeout = await captureInputSnapshot(f.root)
    assert.throws(() => readSyncSettings(invalidTimeout), /不能超过/)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: 15000 } }))
    assert.equal(readSyncSettings(await captureInputSnapshot(f.root)).settings.callTimeoutMs, 15000)
  } finally { f.cleanup() }
})

test('unlimited配置精确接受无总cap，单次timeout独立且拒混合或无效形状', async () => {
  const f = await fixture()
  try {
    const config = (budget: unknown, callTimeoutMs?: number) => writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, budget, ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }) } }))
    config({ mode: 'unlimited' }, 1200000)
    assert.deepEqual(readSyncSettings(await captureInputSnapshot(f.root)).settings.budget, { mode: 'unlimited' })
    assert.equal(readSyncSettings(await captureInputSnapshot(f.root)).settings.callTimeoutMs, 1200000)
    for (const budget of [{ mode: 'unlimited', maxCalls: 64 }, { mode: 'unlimited', timeoutMs: 1 }, { mode: 'unlimited', ...settings.budget }, {}, { mode: 'other' }, { mode: null }]) {
      config(budget)
      const snapshot = await captureInputSnapshot(f.root)
      assert.throws(() => readSyncSettings(snapshot), /sync 配置缺口/)
    }
    for (const timeout of [0, -1, 1.5]) {
      config({ mode: 'unlimited' }, timeout)
      const snapshot = await captureInputSnapshot(f.root)
      assert.throws(() => readSyncSettings(snapshot), /sync 配置缺口/)
    }
    config(settings.budget)
    assert.deepEqual(readSyncSettings(await captureInputSnapshot(f.root)).settings.budget, settings.budget)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-07 两个并发相同请求归并同一操作和runtime，不重置预算或重复native', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'concurrent-1' }
    const [first, second] = await Promise.all([f.application.submit(request), f.application.submit(request)])
    assert.ok(first.operation); assert.equal(first.operation.id, second.operation?.id)
    const detail = await f.application.wait(first.operation.id)
    assert.equal((await f.application.status()).operations.length, 1)
    assert.equal(detail.operation.callsUsed, 1)
    assert.deepEqual(detail.operation.budget, settings.budget)
    const slots = readdirSync(join(f.temp, 'runtime/runtimes', contentHash(detail.operation.ingressKey)), { withFileTypes: true }).filter(entry => entry.isDirectory())
    assert.equal(slots.length, 1)
    assert.equal(detail.journals.length, 0)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-08 queued资料损坏有恢复诊断，同请求只恢复原runtime，已派发记录禁止重冻结', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'restore-1' }, submitted = await f.application.submit(request)
    assert.ok(submitted.operation)
    const failed = await f.application.wait(submitted.operation.id)
    f.application.store.requestControl(submitted.operation.id, 'pause'); f.application.store.requestControl(submitted.operation.id, 'run')
    const key = contentHash(failed.operation.ingressKey), descriptor = join(f.temp, 'runtime/artifacts', `application-runtime-${key}.json`), backup = join(f.temp, 'runtime/runtimes', key, 'tools.json')
    const original = readFileSync(descriptor)
    rmSync(descriptor)
    const unavailable = await f.application.readOperation(submitted.operation.id)
    assert.equal(unavailable.operation.phase, 'queued')
    assert.equal(unavailable.executionAvailability.status, 'recovery_required')
    assert.match(unavailable.executionAvailability.failure!.message, /ENOENT/)
    assert.throws(() => f.application.start(submitted.operation!.id), /ENOENT/)
    const replay = await f.application.submit(request)
    assert.equal(replay.operation?.id, submitted.operation.id)
    const recovered = await f.application.wait(submitted.operation.id)
    assert.deepEqual(readFileSync(descriptor), original)
    assert.equal(recovered.executionAvailability.status, 'ready')
    assert.equal(recovered.operation.deadlineAtMs, failed.operation.deadlineAtMs)
    assert.ok(recovered.operation.callsUsed >= failed.operation.callsUsed)
    rmSync(descriptor); rmSync(backup)
    await assert.rejects(f.application.submit(request), /禁止用当前 runtime 替换/)
    assert.equal((await f.application.readOperation(submitted.operation.id)).executionAvailability.status, 'recovery_required')
    assert.equal(readdirSync(join(f.temp, 'runtime/runtimes', key), { withFileTypes: true }).filter(entry => entry.isDirectory()).length, 1)
  } finally { f.cleanup() }
})

test('状态完整重读固定runtime，文件改变仍拒绝ready且不派发模型', async () => {
  const f = await fixture()
  try {
    await f.application.enable(); await f.application.automaticControl('pause')
    const operation = (await f.application.submit({ nodeId: 'demo', requestId: 'runtime-read-status' })).operation!
    const trustedRoot = join(f.temp, 'trusted-runtime'); mkdirSync(trustedRoot)
    for (let index = 0; index < 80; index++) writeFileSync(join(trustedRoot, `module-${index}.js`), `export const value = ${index}\n`)
    const path = join(f.temp, 'runtime/artifacts', `application-runtime-${contentHash(operation.ingressKey)}.json`)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.tools = { trustedRuntimeRoot: trustedRoot, toolEntry: join(trustedRoot, 'module-0.js'), canonicalHooksDir: trustedRoot }
    saved.runtimeDigest = contentHash(JSON.stringify(inspectTrustedRuntime(trustedRoot)))
    writeFileSync(path, JSON.stringify(saved))
    assert.equal((await f.application.status()).operations[0].executionAvailability.status, 'ready')
    writeFileSync(join(trustedRoot, 'module-79.js'), 'changed after the previous complete read\n')
    const changed = (await f.application.status()).operations[0]
    assert.equal(changed.executionAvailability.status, 'recovery_required')
    assert.match(changed.executionAvailability.failure!.message, /manifest 已变化/)
    await assert.rejects(f.application.automaticControl('resume'), /manifest 已变化/, 'dispatch retains the same fresh complete runtime gate')
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-09 显式单次调用上限来自operation冻结配置，live修改不改旧请求与总预算', async () => {
  let holdFirstCall = true
  const f = await fixture({ ...settings, callTimeoutMs: 10000 }, async request => {
    if (holdFirstCall) {
      holdFirstCall = false
      await new Promise<never>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('受控调用响应暂停')), { once: true }))
    }
    throw Object.assign(new Error('受控生成环境故障'), { code: 'unsupported' })
  })
  try {
    governDemoCode(f)
    await f.application.enable()
    const result = await f.application.submit({ nodeId: 'demo', requestId: 'call-timeout' }); assert.ok(result.operation)
    await observeUntil(() => f.calls.length === 1, 30000)
    assert.equal(f.calls[0].timeoutMs, 10000)
    const paused = await f.application.control(result.operation.id, 'pause')
    assert.equal(paused.operation.phase, 'paused')
    const first = await f.application.wait(result.operation.id)
    assert.equal(first.operation.phase, 'paused'); assert.equal(first.operation.callsUsed, 1)
    await f.application.control(result.operation.id, 'resume')
    const second = await f.application.wait(result.operation.id)
    assert.equal(second.operation.phase, 'failed')
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls[1].timeoutMs, 10000)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: 20000 } }))
    assert.equal(readSyncSettings(second.operation.input).settings.callTimeoutMs, 10000)
    assert.equal(second.operation.deadlineAtMs, first.operation.deadlineAtMs)
    assert.deepEqual(second.operation.budget, first.operation.budget)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'call-timeout' }), /配置已变化/)
    assert.equal(f.calls.length, 2, '失败的精确请求不能因配置变化再次派发')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-10 已启用后删除或损坏配置保持invalidated，不能降级为普通独立Spec提交', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.application.readSettings()).activation, 'disabled')
    assert.equal((await f.application.enable()).activation, 'enabled')
    const config = join(f.root, '.spec/spexcode.json')
    rmSync(config)
    const missing = await f.application.readSettings()
    assert.equal(missing.activation, 'invalidated'); assert.equal(missing.enabled, false)
    assert.equal(missing.configurationError?.code, 'sync_configuration_missing')
    writeFileSync(config, '{broken JSON')
    const malformed = await f.application.readSettings()
    assert.equal(malformed.activation, 'invalidated'); assert.equal(malformed.configurationError?.code, 'sync_configuration_invalid')
    writeFileSync(config, JSON.stringify({ sync: { ...settings, sourcePaths: ['../outside'] } }))
    assert.equal((await f.application.readSettings()).activation, 'invalidated')
    writeFileSync(config, JSON.stringify({ sync: settings }))
    assert.equal((await f.application.readSettings()).activation, 'enabled')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-11 raw-only initial先行为分析并真实入账，失败不重派且同键不同来源拒绝', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'initial-1', origin: 'initial' as const }
    const submitted = await f.application.submit(request); assert.ok(submitted.operation)
    const detail = await f.application.wait(submitted.operation.id)
    assert.equal(detail.operation.origin, 'initial')
    assert.equal(detail.operation.phase, 'failed')
    assert.ok(f.calls.length > 0)
    assert.ok(f.calls.every(call => call.purpose === 'code_behavior_analyze'))
    const firstCalls = f.calls.length
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, firstCalls)
    assert.equal((await f.application.submit(request)).operation?.id, submitted.operation.id)
    await f.application.wait(submitted.operation.id)
    assert.equal(f.calls.length, firstCalls, '同键重放不得再次派发失败的分区分析请求')
    await assert.rejects(f.application.submit({ ...request, origin: 'spec' }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { f.cleanup() }
})

async function linkedApplication(f: Awaited<ReturnType<typeof fixture>>, directory: string, onRun?: (request: ElaborationSessionRequest) => Promise<never>) {
  const root = join(f.temp, directory), calls: ElaborationSessionRequest[] = []
  f.git(['worktree', 'add', '-b', `node/${directory}`, root, 'HEAD'])
  const application = await SyncApplication.create(root, { protocol: f.protocol, runtimeDirectory: join(f.temp, `${directory}-runtime`), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); if (onRun) return onRun(request); throw Object.assign(new Error('受控环境故障'), { code: 'unsupported' }) } })
  retainHistoricalFrozenWorkflow(application)
  await application.enable()
  return { application, calls }
}
function holdNextAdmission(f: Awaited<ReturnType<typeof fixture>>) {
  const held: { mutex: FileMutex | null } = { mutex: null }
  const admit = f.application.store.admitAndEnqueue.bind(f.application.store)
  f.application.store.admitAndEnqueue = input => {
    const operation = admit(input), locks = join(realpathSync(f.temp), 'runtime/artifacts/.locks')
    mkdirSync(locks, { recursive: true, mode: 0o700 })
    held.mutex = claimFileMutex(join(locks, `${contentHash(operation.id)}.sqlite`)); assert.ok(held.mutex)
    f.application.store.admitAndEnqueue = admit
    return operation
  }
  return held
}

test('AC-APPLICATION-12 同仓库两个工作树沿真实FIFO，busy不自旋，结束自动接续另一来源', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } })
  governDemoCode(first)
  const later = await linkedApplication(first, 'later-source'), held = holdNextAdmission(first)
  const repositoryId = identifyWorktree(first.root).repositoryId
  try {
    await first.application.enable()
    const earlier = await first.application.submit({ nodeId: 'demo', requestId: 'fifo-earlier' }); assert.ok(earlier.operation)
    await first.application.wait(earlier.operation.id)
    const queued = await later.application.submit({ nodeId: 'demo', requestId: 'fifo-later' }); assert.ok(queued.operation)
    await first.application.wait(earlier.operation.id)
    assert.equal(first.application.store.nextQueued(repositoryId)?.id, earlier.operation.id)
    assert.equal(first.calls.length, 0); assert.equal(later.calls.length, 0)
    assert.equal((await later.application.wait(queued.operation.id)).operation.phase, 'queued')
    held.mutex!.release(); held.mutex = null
    first.application.start(earlier.operation.id)
    await later.application.wait(queued.operation.id)
    assert.equal(first.calls.length, 1); assert.equal(later.calls.length, 1)
    assert.equal(first.application.store.nextQueued(repositoryId), null)
    assert.equal((await later.application.readOperation(queued.operation.id)).operation.phase, 'failed')
  } finally { held.mutex?.release(); first.cleanup() }
})

test('AC-APPLICATION-13 已出队暂停恢复先等有效FIFO，前序完成后自动恢复且wait等待真实执行', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } })
  governDemoCode(first)
  let holdFirstCall = true
  const later = await linkedApplication(first, 'resume-source', async request => {
    if (holdFirstCall) {
      holdFirstCall = false
      await new Promise<never>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('受控调用响应暂停')), { once: true }))
    }
    throw Object.assign(new Error('受控环境故障'), { code: 'unsupported' })
  })
  const repositoryId = identifyWorktree(first.root).repositoryId
  const held = holdNextAdmission(first)
  try {
    await first.application.enable()
    const submitted = await later.application.submit({ nodeId: 'demo', requestId: 'resume-first' }); assert.ok(submitted.operation)
    await observeUntil(() => {
      const operation = later.application.store.readOperation(submitted.operation!.id)
      assert.notEqual(operation.phase, 'failed', JSON.stringify(later.application.store.listAttempts(operation.id).map(attempt => attempt.failure)))
      return later.calls.length === 1
    }, 30000)
    const paused = await later.application.control(submitted.operation.id, 'pause')
    assert.equal(paused.operation.phase, 'paused')
    const firstAttempt = await later.application.wait(submitted.operation.id)
    assert.equal(firstAttempt.operation.phase, 'paused'); assert.equal(firstAttempt.attempt?.number, 1)
    assert.equal(later.calls.length, 1)
    const earlier = await first.application.submit({ nodeId: 'demo', requestId: 'pending-before-resume' }); assert.ok(earlier.operation)
    await first.application.wait(earlier.operation.id)
    const resumed = await later.application.control(submitted.operation.id, 'resume')
    assert.equal(resumed.operation.phase, 'queued'); assert.equal(later.calls.length, 1)
    assert.equal(first.application.store.nextQueued(repositoryId)?.id, earlier.operation.id)
    held.mutex!.release(); held.mutex = null
    first.application.start(earlier.operation.id)
    const restored = await later.application.wait(submitted.operation.id)
    assert.equal(restored.operation.phase, 'failed'); assert.equal(restored.attempt?.number, 2)
    assert.equal(first.calls.length, 1); assert.equal(later.calls.length, 2)
    assert.equal(restored.operation.deadlineAtMs, firstAttempt.operation.deadlineAtMs)
    assert.equal(first.application.store.nextQueued(repositoryId), null)
  } finally { held.mutex?.release(); first.cleanup() }
})

test('AC-APPLICATION-14 不同仓库共享canonicalDB时分别派发，不执行另一仓库的FIFO头', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } }), second = await fixture()
  governDemoCode(first); governDemoCode(second)
  const held = holdNextAdmission(first), calls: ElaborationSessionRequest[] = []
  const other = await SyncApplication.create(second.root, { protocol: first.protocol, runtimeDirectory: join(second.temp, 'shared-runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); throw Object.assign(new Error('另一仓库受控故障'), { code: 'unsupported' }) } })
  retainHistoricalFrozenWorkflow(other)
  try {
    await first.application.enable(); await other.enable()
    const blocked = await first.application.submit({ nodeId: 'demo', requestId: 'blocked-repository' }); assert.ok(blocked.operation)
    await first.application.wait(blocked.operation.id)
    const submitted = await other.submit({ nodeId: 'demo', requestId: 'independent-repository' }); assert.ok(submitted.operation)
    assert.equal((await other.wait(submitted.operation.id)).operation.phase, 'failed')
    assert.equal(first.calls.length, 0); assert.equal(calls.length, 1)
    assert.equal(first.application.store.nextQueued(identifyWorktree(first.root).repositoryId)?.id, blocked.operation.id)
    assert.equal(first.application.store.nextQueued(identifyWorktree(second.root).repositoryId), null)
    held.mutex!.release(); held.mutex = null
    first.application.start(blocked.operation.id); await first.application.wait(blocked.operation.id)
  } finally { held.mutex?.release(); second.cleanup(); first.cleanup() }
})

test('AC-APPLICATION-15 仅显式retry建立关联新操作与新预算，普通重复及retry重放仍幂等', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'failed-original', origin: 'initial' }); assert.ok(submitted.operation)
    const original = await f.application.wait(submitted.operation.id)
    assert.equal(original.operation.phase, 'failed'); assert.equal(original.retryEligibility.eligible, true)
    const repeatedRequest = { nodeId: 'demo', requestId: 'automatic-repeat', origin: 'initial' as const }
    const repeated = await f.application.submit(repeatedRequest)
    assert.equal(repeated.operation?.id, original.operation.id)
    await f.application.wait(original.operation.id)
    const firstCallCount = f.calls.length
    const firstRequestKeys = new Set(f.calls.map(call => call.requestKey))
    assert.ok(firstCallCount > 0)
    assert.equal(firstRequestKeys.size, firstCallCount)
    assert.equal(original.operation.callsUsed, firstCallCount)
    assert.equal((await f.application.submit(repeatedRequest)).operation?.id, original.operation.id)
    await f.application.wait(original.operation.id)
    assert.equal(f.calls.length, firstCallCount, '普通重复不得新增分区调用')
    assert.deepEqual(new Set(f.calls.map(call => call.requestKey)), firstRequestKeys)
    const request = { nodeId: 'demo', requestId: 'explicit-retry', retryOf: original.operation.id }
    const retried = await f.application.submit(request); assert.ok(retried.operation)
    assert.notEqual(retried.operation.id, original.operation.id)
    const result = await f.application.wait(retried.operation.id)
    assert.equal(result.operation.retryOf, original.operation.id); assert.equal(result.operation.origin, 'initial')
    const retryRequests = f.calls.slice(firstCallCount)
    const retryRequestKeys = new Set(retryRequests.map(call => call.requestKey))
    assert.ok(retryRequests.length > 0)
    assert.equal(retryRequestKeys.size, retryRequests.length)
    assert.equal(result.operation.callsUsed, retryRequests.length); assert.deepEqual(result.operation.budget, original.operation.budget)
    assert.ok(result.operation.deadlineAtMs !== null && original.operation.deadlineAtMs !== null && result.operation.deadlineAtMs > original.operation.deadlineAtMs)
    assert.equal((await f.application.readOperation(original.operation.id)).operation.callsUsed, firstCallCount)
    assert.equal((await f.application.submit(request)).operation?.id, result.operation.id)
    await f.application.wait(result.operation.id)
    assert.equal(f.calls.length, firstCallCount + retryRequests.length, '精确retry重放不得新增分区调用')
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, f.calls.length)
    assert.equal((await f.application.status()).operations.length, 2)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-16 重试完整继承未落地正文意图，不能混入新patch或重放已变来源', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '重试必须保留这一段尚未落地的新正文。' }
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'saved-intent', patch }); assert.ok(submitted.operation)
    const original = await f.application.wait(submitted.operation.id)
    const request = { nodeId: 'demo', requestId: 'retry-saved-intent', retryOf: original.operation.id }
    await assert.rejects(f.application.submit({ ...request, patch }), /沿用原正文意图/)
    const retried = await f.application.submit(request); assert.ok(retried.operation)
    const result = await f.application.wait(retried.operation.id)
    assert.deepEqual(result.operation.requestBlob, original.operation.requestBlob)
    assert.deepEqual(result.operation.previousBaselinePair, original.operation.previousBaselinePair)
    const frozen = readFrozenBehaviorContext<{ composedFiles: [string, string][] }>(f.calls[1])
    assert.match(new Map(frozen.composedFiles).get('.spec/demo/spec.md')!, /尚未落地的新正文/)
    assert.equal(readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8'), source)
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `${text}!`\n')
    const stale = await f.application.readOperation(original.operation.id)
    assert.equal(stale.retryEligibility.eligible, false); assert.equal(stale.retryEligibility.reason?.code, 'sync_retry_stale')
    await assert.rejects(f.application.submit({ ...request, requestId: 'retry-after-change' }), /原输入已变化/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-17 queued不可借retry重置预算，无交付cancelled可明确重试并清理旧FIFO', async () => {
  const f = await fixture(), held = holdNextAdmission(f)
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'cancel-before-delivery' }); assert.ok(submitted.operation)
    const queued = await f.application.wait(submitted.operation.id)
    assert.equal(queued.operation.phase, 'queued'); assert.equal(queued.retryEligibility.eligible, false)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'retry-active', retryOf: submitted.operation.id }))
    const cancelled = await f.application.control(submitted.operation.id, 'cancel')
    assert.equal(cancelled.operation.phase, 'cancelled'); assert.equal(cancelled.retryEligibility.eligible, true)
    const retried = await f.application.submit({ nodeId: 'demo', requestId: 'retry-cancelled', retryOf: cancelled.operation.id }); assert.ok(retried.operation)
    const result = await f.application.wait(retried.operation.id)
    assert.equal(result.operation.retryOf, cancelled.operation.id); assert.equal(f.calls.length, 1)
    assert.equal(f.application.store.nextDispatch(identifyWorktree(f.root).repositoryId), null)
  } finally { held.mutex?.release(); f.cleanup() }
})

async function resourceFixture(options: { conflict?: boolean; callRequested?: boolean; invalidPlan?: boolean; priorReservedCalls?: number } = {}) {
  const f = await fixture()
  governDemoCode(f)
  let calls = 0
  const application = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => {
    calls++
    const operation = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)[0], attempt = f.application.store.readAttempt(operation.currentAttemptId!)
    const dispatch = attempt.dispatchPlans.find(plan => plan.key === request.requestKey)!
    const { signal: _signal, ...frozen } = request
    const requestDigest = contentHash(JSON.stringify(frozen)), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: null }
    const plan = { schemaVersion: 1, request: frozen, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: options.invalidPlan ? 'invalid-owned-session' : expectedSessionId, ...identity }
    const checkpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: options.callRequested ?? true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    for (let index = 0; index < (options.priorReservedCalls ?? 0); index++) f.application.store.reserveDispatch(fence, { key: `${request.requestKey}:prior-reservation:${index}`, purpose: request.purpose, requestDigest: contentHash(`prior-reservation-${index}`) })
    f.application.store.planResource(fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: operation.input.id, candidateDigest: null, planBlob: writeEvidence(operation.input.source.commonDir, plan), checkpointRef: writeEvidence(operation.input.source.commonDir, checkpoint) })
    if (options.conflict) f.application.store.recordFailure(fence, { code: 'input_changed', message: '受控来源冲突故障', kind: 'conflict', evidenceRefs: [] })
    throw Object.assign(new Error('受控创建结果未知'), { code: 'unsupported' })
  } })
  retainHistoricalFrozenWorkflow(application)
  return { ...f, application, modelCalls: (): number => calls }
}

test('AC-APPLICATION-STOPPED-01 stopWriter后recover仍仅结算原planned资源并保留六次预算预留与失败证据', async () => {
  const f = await resourceFixture({ callRequested: false, priorReservedCalls: 5 })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'stopped-resource-recovery' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    assert.equal(before.operation.callsUsed, 6); assert.equal(before.resources.length, 1); assert.equal(before.resources[0].phase, 'planned')
    const attempt = f.application.store.readAttempt(before.operation.currentAttemptId!), refs = structuredClone(attempt.checkpointRefs), failure = structuredClone(attempt.failure)
    const stopped = await f.application.stopWriter()
    assert.equal(stopped.control.control, 'pause')
    const recovered = await f.application.control(before.operation.id, 'recover')
    assert.deepEqual(recovered.operation, before.operation)
    assert.deepEqual(recovered.physicalControl, stopped.control)
    assert.equal(recovered.resources.length, 0); assert.equal(recovered.journals.length, 0)
    assert.equal(f.application.store.findResource(attempt.id, before.resources[0].plan.key)?.phase, 'removed')
    assert.deepEqual(f.application.store.readAttempt(attempt.id).failure, failure)
    assert.deepEqual(f.application.store.readAttempt(attempt.id).checkpointRefs, refs)
    assert.equal(f.application.store.listAttempts(before.operation.id).length, 1)
    f.application.start(before.operation.id)
    assert.equal(f.modelCalls(), 1, '六次为真实store预算预留；清理不能新增模型派发')
    assert.equal(f.application.observationStatus().health.watchOnline, false)
  } finally { f.cleanup() }
})

for (const stop of ['stopWriter', 'stopService'] as const) test(`AC-APPLICATION-STOPPED-02 ${stop}后queued无资源recover不能派发或恢复物理控制`, async () => {
  const f = await fixture(), held = holdNextAdmission(f)
  try {
    governDemoCode(f); await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'stopped-queued-recovery' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    held.mutex!.release(); held.mutex = null
    if (stop === 'stopWriter') await f.application.stopWriter()
    else await f.application.stopService()
    const stoppedControl = (await f.application.readOperation(before.operation.id)).physicalControl
    assert.equal(stoppedControl.control, stop === 'stopWriter' ? 'pause' : 'run')
    const recovered = await f.application.control(before.operation.id, 'recover')
    assert.deepEqual(recovered.operation, before.operation); assert.deepEqual(recovered.physicalControl, stoppedControl)
    assert.equal(recovered.operation.phase, 'queued'); assert.equal(recovered.attempt, null); assert.equal(f.calls.length, 0)
    f.application.start(before.operation.id)
    const afterStart = await f.application.wait(before.operation.id)
    assert.deepEqual(afterStart.operation, recovered.operation)
    assert.equal(afterStart.attempt, null); assert.equal(f.calls.length, 0); assert.equal(f.application.observationStatus().health.watchOnline, false)
  } finally { held.mutex?.release(); f.cleanup() }
})

test('AC-APPLICATION-STOPPED-03 stopped恢复仍拒错plan并保留planned与原业务失败', async () => {
  const f = await resourceFixture({ invalidPlan: true, callRequested: false })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'stopped-invalid-resource' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id), stopped = await f.application.stopWriter()
    await assert.rejects(f.application.control(before.operation.id, 'recover'), (error: unknown) => error instanceof SyncApplicationError && error.status === 409 && error.code === 'resource_recovery' && /native resource plan differs/.test(error.message))
    const after = await f.application.readOperation(before.operation.id)
    assert.deepEqual(after.operation, before.operation); assert.deepEqual(after.physicalControl, stopped.control)
    assert.equal(after.resources.length, 1); assert.equal(after.resources[0].phase, 'planned'); assert.equal(f.modelCalls(), 1)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-18 已停止操作仍有未结算资源时不能展示ready或借retry新预算', async () => {
  const f = await resourceFixture()
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'pending-native-resource' }); assert.ok(submitted.operation)
    const failed = await f.application.wait(submitted.operation.id)
    assert.equal(failed.operation.phase, 'failed'); assert.equal(failed.resources[0]?.phase, 'planned')
    assert.equal(failed.executionAvailability.status, 'recovery_required'); assert.equal(failed.executionAvailability.failure?.code, 'sync_resources_unsettled')
    assert.equal(failed.retryEligibility.eligible, false); assert.ok(failed.retryEligibility.reason?.code)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'retry-unknown-resource', retryOf: failed.operation.id }))
    const paused = await f.application.control(failed.operation.id, 'pause')
    assert.equal(paused.operation.phase, 'paused'); assert.equal(paused.executionAvailability.status, 'recovery_required')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-19 recover不派发queued任务，不改control/预算/输入或有效FIFO位置', async () => {
  const f = await fixture()
  governDemoCode(f)
  const held = holdNextAdmission(f)
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'recover-only-queued' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    held.mutex!.release(); held.mutex = null
    await f.application.control(before.operation.id, 'recover')
    const after = await f.application.wait(before.operation.id)
    assert.deepEqual(after.operation, before.operation)
    assert.equal(after.operation.phase, 'queued'); assert.equal(after.attempt, null); assert.equal(f.calls.length, 0)
    assert.equal(f.application.store.nextQueued(identifyWorktree(f.root).repositoryId)?.id, before.operation.id)
  } finally { held.mutex?.release(); f.cleanup() }
})

test('AC-APPLICATION-20 conflicted仍有资源不能ready；recover只结算已固定未派发资源并保留冲突', async () => {
  const f = await resourceFixture({ conflict: true, callRequested: false })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'conflict-with-resource' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    assert.equal(before.operation.phase, 'conflicted'); assert.equal(before.resources[0]?.phase, 'planned')
    assert.equal(before.executionAvailability.status, 'recovery_required'); assert.equal(before.executionAvailability.failure?.code, 'sync_resources_unsettled')
    // 来源和启用配置变化不阻止清理旧资源；恢复不能偷偷启用或推进新输入。
    writeFileSync(join(f.root, '.spec/spexcode.json'), '{broken JSON')
    await f.application.control(before.operation.id, 'recover')
    const after = await f.application.wait(before.operation.id)
    assert.deepEqual(after.operation, before.operation); assert.equal(after.operation.phase, 'conflicted')
    assert.equal(after.resources.length, 0)
    assert.equal(after.executionAvailability.status, 'recovery_required')
    assert.equal(after.executionAvailability.failure?.code, 'sync_delivery_evidence_invalid', '资源已清理，但无效配置使当前delivery证据不可判定')
    assert.equal(f.modelCalls(), 1); assert.equal(f.application.store.listAttempts(before.operation.id).length, 1)
    assert.equal((await f.application.readSettings()).activation, 'invalidated')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-21 recover具体协调失败返回可见409，资源与原业务结果仍保留', async () => {
  const f = await resourceFixture({ invalidPlan: true, callRequested: false })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'recover-invalid-binding' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    await assert.rejects(f.application.control(before.operation.id, 'recover'), (error: unknown) => error instanceof SyncApplicationError && error.status === 409 && error.code === 'resource_recovery' && /native resource plan differs/.test(error.message))
    const after = await f.application.readOperation(before.operation.id)
    assert.deepEqual(after.operation, before.operation)
    assert.equal(after.resources[0]?.phase, 'planned'); assert.equal(after.executionAvailability.status, 'recovery_required')
    assert.equal(f.modelCalls(), 1); assert.equal(f.application.store.listAttempts(before.operation.id).length, 1)
  } finally { f.cleanup() }
})

async function exportApplicationFixture(t: test.TestContext, choice?: 'keep_intent' | 'adopt_behavior' | 'new_rule', oraclePolicy: { legacyFilter: boolean; reviewConflict?: boolean } = { legacyFilter: false }, independentNode = false) {
  const temp = mkdtempSync(join(tmpdir(), 'sync-application-delivery-')), root = join(temp, 'source')
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  renameSync(join(root, '.spec/export'), join(root, '.spec/project'))
  const path = '.spec/project/export-contract/spec.md', original = readFileSync(join(root, path), 'utf8')
  const contract = parseContract({ nodeId: 'export-contract', path, source: original }).contract!
  const verify = contract.items.find(item => item.kind === 'VERIFY')!; assert.equal(verify.kind, 'VERIFY')
  const config: SyncSettings = { ...settings, nodeIds: ['export-contract'], sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['tests', 'package.json'], budget: { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300000 }, facts: [{ source: 'decision:EXPORT-POLICY', text: original }], mandatoryTests: [{ verificationId: verify.id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }], verifications: [{ definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: { ...settings.verifications[0].environment, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392' } }] }
  if (independentNode) {
    const other = original.replaceAll('export-contract', 'other-contract').replaceAll('EXPORT', 'OTHER').replaceAll('src/export.js', 'src/other.js').replaceAll('tests/export.test.mjs', 'tests/other.test.mjs')
    mkdirSync(join(root, '.spec/project/other-contract'))
    writeFileSync(join(root, '.spec/project/other-contract/spec.md'), other)
    cpSync(join(root, 'src/export.js'), join(root, 'src/other.js'))
    writeFileSync(join(root, 'tests/other.test.mjs'), readFileSync(join(root, 'tests/export.test.mjs'), 'utf8').replaceAll('EXPORT', 'OTHER').replaceAll('../src/export.js', '../src/other.js'))
    const otherContract = parseContract({ nodeId: 'other-contract', path: '.spec/project/other-contract/spec.md', source: other }).contract!
    const otherVerify = otherContract.items.find(item => item.kind === 'VERIFY')!; assert.equal(otherVerify.kind, 'VERIFY')
    config.nodeIds!.push('other-contract')
    config.facts.push({ source: 'decision:OTHER-POLICY', text: other })
    config.mandatoryTests.push({ verificationId: otherVerify.id, testPath: 'tests/other.test.mjs', testId: 'AC-OTHER-03' })
    config.verifications.push({ definition: { id: otherVerify.id, command: otherVerify.command, cwd: otherVerify.cwd, timeoutMs: otherVerify.timeoutMs }, environment: config.verifications[0].environment })
  }
  if (oraclePolicy.legacyFilter) {
    const oraclePath = join(root, 'tests/export.test.mjs')
    writeFileSync(oraclePath, `${readFileSync(oraclePath, 'utf8')}\ntest('ORACLE-FILTER-LEGACY', () => { const service = new ExportService(); for (const length of [9, 129]) assert.equal(service.submit('owner', 'legacy-' + length, 'x'.repeat(length)).filter.length, length); });\n`)
    config.mandatoryTests = [...config.mandatoryTests, { verificationId: verify.id, testPath: 'tests/export.test.mjs', testId: 'ORACLE-FILTER-LEGACY' }]
  }
  if (choice) config.verifications.push({ ...config.verifications[0], definition: { id: 'VERIFY-DECISION-01', command: ['node', '--test', 'generated-tests/decision.test.mjs'], cwd: '.', timeoutMs: 10000 } })
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: config }))
  const git = (args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git(['init', '-b', 'main']); git(['config', 'user.name', 'application fixture']); git(['config', 'user.email', 'application@example.invalid']); git(['add', '.']); git(['commit', '-m', 'fixture']); git(['switch', '-c', 'node/source'])
  execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init', '.', '--harness', 'none'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
  git(['add', '.']); git(['commit', '-m', 'adopt delivery'])
  const protocol = openProtocol(join(temp, 'canonical.sqlite'))
  let application: SyncApplication
  let calls = 0
  const nativeRequests: ElaborationSessionRequest[] = []
  const originalCode = readFileSync(join(root, 'src/export.js'), 'utf8')
  const limitCode = (limit: number | null): string => originalCode.replace("!filter.trim())", `!filter.trim()${limit === null ? '' : ` || filter.length > ${limit}`})`)
  if (choice) writeFileSync(join(root, 'src/export.js'), limitCode(8))
  t.after(async () => {
    await application.stopService()
    const evidenceRoot = process.env.SPEX_VERIFICATION_EVIDENCE_DIR
    const evidence = evidenceRoot ? join(evidenceRoot, `application-${contentHash(temp).slice(0, 12)}`) : null
    if (evidence) {
      mkdirSync(evidence, { recursive: true, mode: 0o700 })
      const identity = identifyWorktree(root)
      const operations = application.store.listOperations(identity.repositoryId, { sourceRoot: identity.canonicalRoot })
      writeFileSync(join(evidence, 'state.json'), JSON.stringify({ test: t.name, source: identity, observations: application.store.listObservations(identity), operations: operations.map(operation => ({ operation, attempts: application.store.listAttempts(operation.id), journals: application.store.listJournals(operation.id) })) }, null, 2))
    }
    protocol.close()
    if (evidence) {
      cpSync(join(temp, 'canonical.sqlite'), join(evidence, 'canonical.sqlite'))
      cpSync(join(root, '.git'), join(evidence, 'git'), { recursive: true })
    }
    const unlock = (directory: string): void => { chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name)) }
    unlock(temp); rmSync(temp, { recursive: true, force: true })
  })
  application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(temp, 'runtime'), runner: async request => {
    calls++; nativeRequests.push(request)
    const operation = application.store.listOperations(identifyWorktree(root).repositoryId, { sourceRoot: identifyWorktree(root).canonicalRoot }).find(operation => operation.currentAttemptId && application.store.readAttempt(operation.currentAttemptId).dispatchPlans.some(dispatch => dispatch.key === request.requestKey))!
    const plan = JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob!).toString('utf8')) as { intentNodeId: string; facts: { source: string; text: string }[]; decisionAuthorities: { paths: string[] }[] }
    const otherNode = plan.intentNodeId === 'other-contract', codePath = otherNode ? 'src/other.js' : 'src/export.js'
    const decisionFact = plan.facts.find(fact => fact.source.startsWith('decision:') && !fact.source.endsWith('-POLICY'))
    const limit = choice === 'keep_intent' ? null : choice === 'adopt_behavior' ? 8 : 128
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[]; oldSource: [string, string][]; newSource: [string, string][]; verifiedDelivery: [string, string][]; compositionEvidence: { conflicts: { path: string; delivery: { mode: '100644' | '100755' } | null }[] } | null }>(request)
      const paths = [...new Set([...frozen.changedPaths, ...(decisionFact ? plan.decisionAuthorities.flatMap(authority => authority.paths) : [])])]
      output = { changes: paths.map(changed => changed === codePath ? ({ kind: decisionFact ? 'allowed_change' : 'conflict', paths: [changed], affectedIds: ['RULE-EXPORT-02', 'AC-EXPORT-02'], ruleIds: ['RULE-EXPORT-02'], originalIntent: 'key与非空字符串filter必需，未授权filter长度上限；幂等政策保持', previousBehavior: '9字符非空filter可提交', sourceBehavior: 'filter长度超过8字符拒绝，8字符可提交；原权限与幂等保持', deliveryBehavior: '非空filter无长度上限', evidence: `冻结src/export.js#ExportService.submit 的filter.length > 8与RULE-EXPORT-02、AC-EXPORT-02逐项对照；${decisionFact?.text ?? '无上限授权'}`, counterexample: 'filter=123456789：原意接受但现源码invalid-request' }) : ({ kind: 'refactor', paths: [changed], affectedIds: [], ruleIds: [], originalIntent: '原业务契约与可信测试不变', previousBehavior: '原完整导出行为', sourceBehavior: '治理文本与上下文无新增业务变化', deliveryBehavior: '原业务义务保持', evidence: `已完整读取${changed}，长度边界冲突仅在${codePath}`, counterexample: '固定oracle验证原权限、幂等与状态转换' })), facts: decisionFact ? [decisionFact] : [], acceptanceChanges: decisionFact && choice !== 'keep_intent' ? [{ id: 'AC-EXPORT-02', ruleIds: ['RULE-EXPORT-02'], source: decisionFact.source, reason: `仅按所选裁决增加filter${limit}字符边界，保空输入、权限、幂等与结果义务` }] : [], newNodes: [], resolutions: [] }
      if (independentNode || !choice) output = { changes: paths.map(changed => ({ kind: 'refactor', paths: [changed], affectedIds: [], ruleIds: [], originalIntent: '固定导出规则与验收保持', previousBehavior: '固定ExportService完整行为', sourceBehavior: '仅添加测试指定注释，不改变业务执行', deliveryBehavior: '原完整业务与已生成注释保持', evidence: `真实冻结${changed}的业务语句保持，新增仅注释`, counterexample: '固定可信oracle仍验证权限、幂等和全部状态转换' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
      if (decisionFact) (output as { resolutions: unknown[] }).resolutions = (frozen.compositionEvidence?.conflicts ?? []).map(conflict => {
        const current = new Map(frozen.newSource).get(conflict.path)!, before = new Map(frozen.oldSource).get(conflict.path)!, delivery = new Map(frozen.verifiedDelivery).get(conflict.path)!
        assert.equal(current, before, '只有真实冻结作者字节未变才沿用完整partial交付，不能盲选覆盖新作者输入')
        assert.ok(delivery && conflict.delivery)
        if (conflict.path.endsWith('/spec.md')) {
          const sourceContract = parseContract({ nodeId: 'export-contract', path: conflict.path, source: current }).contract!
          const deliveryContract = parseContract({ nodeId: 'export-contract', path: conflict.path, source: delivery }).contract!
          assert.equal(parseParts(current)!.rawSource, parseParts(delivery)!.rawSource)
          assert.equal(contractBusinessProse(sourceContract.expandedSpec), contractBusinessProse(deliveryContract.expandedSpec))
          assert.deepEqual(sourceContract.items.map(item => item.id).sort(), deliveryContract.items.map(item => item.id).sort())
          for (const item of sourceContract.items) assert.ok(sameContractBusinessMeaning(item, deliveryContract.items.find(value => value.id === item.id)!))
        }
        return { path: conflict.path, content: delivery, mode: conflict.delivery.mode }
      })
      if (independentNode) (output as { resolutions: unknown[] }).resolutions = (frozen.compositionEvidence?.conflicts ?? []).map(conflict => {
        const current = new Map(frozen.newSource).get(conflict.path)!, before = new Map(frozen.oldSource).get(conflict.path)!, delivery = new Map(frozen.verifiedDelivery).get(conflict.path)!
        assert.equal(conflict.path, codePath)
        assert.equal(current, `// human offline ${codePath}\n${before}`, '补偿只整合夹具明确新增的作者注释，保留完整原代码')
        assert.equal(delivery, `${before}\n// application verified delivery\n`, '已交付完整正文只有受审生成注释，不猜测业务整合')
        assert.ok(conflict.delivery)
        return { path: conflict.path, content: `${current}\n// application verified delivery\n`, mode: conflict.delivery.mode }
      })
    } else if (request.purpose === 'code_behavior_review') {
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      const value = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: { changes: { id: string; paths: string[] }[] } }
      output = { inputDigest: request.inputDigest, analysisDigest: value.analysisDigest, verdict: 'accept', checkedPaths: [...new Set([...frozen.changedPaths, ...value.analysis.changes.flatMap(change => change.paths)])], checkedChangeIds: value.analysis.changes.map(change => change.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') {
      const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
        const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
        const value = (item as unknown as Record<string, ContractCell>)[key]
        return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
      })))])) as GeneratedTables
      if (choice && decisionFact) {
        if (choice !== 'keep_intent') {
          const rule = tables.RULE!.find(row => row.id === 'RULE-EXPORT-02')!
          rule.constraint = `${rule.constraint}；filter长度不得超过${limit}字符`; rule.source = decisionFact!.source
          const ac = tables.AC!.find(row => row.id === 'AC-EXPORT-02')!
          ac.assertion = `${ac.assertion}；filter长度${limit}字符接受，${limit! + 1}字符拒绝`; ac.source = decisionFact!.source
        }
        tables.AC!.push({ id: 'AC-DECISION-01', covers: ['RULE-EXPORT-01', 'RULE-EXPORT-02'], preconditions: '无任务与成功任务', action: '检验filter边界、空输入、幂等及非所有者下载', assertion: limit === null ? '8、9、128、129字符均接受；空输入拒绝、幂等与权限保持' : `${limit}字符接受，${limit + 1}字符拒绝；空输入拒绝、幂等与权限保持`, test: 'generated-tests/decision.test.mjs#AC-DECISION-01', command: 'VERIFY-DECISION-01', source: 'derived:RULE-EXPORT-02', 'depends-on': ['RULE-EXPORT-01', 'RULE-EXPORT-02'] })
        tables.VERIFY!.push({ id: 'VERIFY-DECISION-01', command: ['node', '--test', 'generated-tests/decision.test.mjs'], cwd: '.', 'timeout-ms': 10000 })
      }
      output = { version: 'elaboration-rows-v2', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(original).fm.title), description: '', code: contract.code, related: contract.related, prose: contractBusinessProse(parseParts(original)!.expandedSpec), tables, removeIds: [] }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定业务政策', affectedIds: ['REQ-EXPORT-01'] })) }
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else {
      const frozen = JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] } }
      if (request.purpose === 'code_generate') {
        const change = (path: string, content: string): unknown => { const entry = frozen.manifest.entries.find(entry => entry.path === path); return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, content, mode: null } }
        output = { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change(codePath, choice && decisionFact ? limitCode(limit) : `${new Map(frozen.files).get(codePath)}\n// application verified delivery\n`), ...(choice && decisionFact ? [change('generated-tests/decision.test.mjs', `import assert from 'node:assert/strict'; import test from 'node:test'; import { ExportService } from '../src/export.js'; test('AC-DECISION-01', () => { const service = new ExportService(); const limit = ${limit}; for (const length of [8,9,128,129]) { const submit = () => service.submit('owner', 'length-' + length, 'x'.repeat(length)); if (limit !== null && length > limit) assert.throws(submit, /invalid-request/); else assert.equal(submit().filter.length, length); } assert.throws(() => service.submit('owner', 'empty', ''), /invalid-request/); assert.throws(() => service.submit('', 'denied', 'active'), /forbidden/); const job = service.submit('owner', 'same', 'active'); assert.deepEqual(service.submit('owner', 'same', 'active'), job); assert.throws(() => service.submit('owner', 'same', 'all'), /idempotency-conflict/); service.dispatch(job.id, 'START', { attempt: 1 }); service.dispatch(job.id, 'COMPLETE', { attempt: 1, result: 'file.csv' }); assert.throws(() => service.dispatch(job.id, 'DOWNLOAD', { actor: 'other' }), /forbidden/); assert.equal(service.dispatch(job.id, 'DOWNLOAD', { actor: 'owner' }), 'file.csv'); });\n`)] : [])] }
      } else {
        const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as { inputId: string; candidate: { digest: string } }
        output = oraclePolicy.reviewConflict && decisionFact && choice !== 'keep_intent'
          ? { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'needs_input', checkedIds: frozen.readyIds, findings: [{ kind: 'missing_fact', affectedIds: ['RULE-EXPORT-02', 'AC-EXPORT-02'], ruleLocation: `oracle-policy:${decisionFact.source}`, codeLocation: 'tests/export.test.mjs#ORACLE-FILTER-LEGACY', evidence: `起始可信ORACLE-FILTER-LEGACY明确9/129字符必须接受；当前已批准规则filter最多${limit}字符，与该完整旧断言互斥`, counterexample: `长度${limit! + 1}：当前已批准意图要求拒绝，旧oracle要求接受`, message: '必须由可信owner发布与所选新规则相容的oracle版本；不能修回旧规则或跳过旧oracle' }] }
          : { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: frozen.readyIds, findings: [] }
      }
    }
    if (otherNode && request.purpose === 'elaboration_generate') output = JSON.parse(JSON.stringify(output).replaceAll('EXPORT', 'OTHER').replaceAll('export-contract', 'other-contract').replaceAll('src/export.js', 'src/other.js').replaceAll('tests/export.test.mjs', 'tests/other.test.mjs')) as unknown
    output = adaptElaborationNativeOutput(request, output)
    const dispatch = application.store.readAttempt(operation.currentAttemptId!).dispatchPlans.find(plan => plan.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `independent-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  retainHistoricalFrozenWorkflow(application)
  await application.enable()
  return { temp, root, path, original, originalCode, contract, git, application, nativeRequests, calls: (): number => calls }
}

for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) test(`AC-APPLICATION-P3-ORACLE-REAL ${choice} 起始不可改oracle旧9/129断言与真实裁决固定Docker命令`, { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await exportApplicationFixture(t, choice, { legacyFilter: true }), before = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), oracle = readFileSync(join(f.root, 'tests/export.test.mjs'))
  const submitted = await f.application.submit({ nodeId: 'export-contract', requestId: `oracle-real-conflict-${choice}`, origin: 'code' }); assert.ok(submitted.operation)
  const first = await f.application.wait(submitted.operation.id); assert.ok(first.decisionContext)
  const request = { operationId: first.operation.id, inputId: first.operation.input.id, analysisRef: first.decisionContext.analysisRef, findingIds: first.decisionContext.analysis.findings.map(finding => finding.id), requestId: `oracle-real-decision-${choice}`, decision: choice === 'new_rule' ? { choice, rule: 'filter长度不得超过128字符；其他原需求保持有效。' } : { choice } }
  const decision = await f.application.decide(request), result = await f.application.wait(decision.operation.id)
  const attempts = f.application.store.listAttempts(result.operation.id)
  const verifications = attempts.flatMap(attempt => readSyncCheckpoints(f.application.store, result.operation, attempt).json.map(({ value }) => value as VerificationResult)).filter(value => value.status && value.checkpoint?.config?.policy?.argv?.join(' ') === 'node --test tests/export.test.mjs').map(value => ({ status: value.status, argv: value.checkpoint!.config.policy.argv, exitCode: value.evidence?.exitCode, tests: value.evidence?.tests }))
  if (process.env.SPEX_ORACLE_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_ORACLE_EVIDENCE_DIR, `oracle-real-${choice}.json`), JSON.stringify({ choice, phase: result.operation.phase, callsUsed: result.operation.callsUsed, budget: result.operation.budget, oracleDigest: contentHash(oracle), sourceInputId: before.id, receiptIds: result.journals.flatMap(journal => journal.receipt ? [journal.receipt.id] : []), verifications }, null, 2))
  assert.equal(result.operation.phase, choice === 'keep_intent' ? 'workspace_synced' : 'budget_exhausted', JSON.stringify(result.attempt?.failure))
  assert.equal(result.journals.some(journal => journal.receipt), choice === 'keep_intent')
  assert.ok(verifications.some(value => value.status === (choice === 'keep_intent' ? 'passed' : 'failed')), JSON.stringify(verifications))
  for (const verification of verifications.filter(value => value.status === 'failed')) { assert.notEqual(verification.exitCode, 0); assert.ok(verification.tests!.some((test: { testId: string; status: string }) => test.testId === 'ORACLE-FILTER-LEGACY' && test.status === 'failed'), JSON.stringify(verification)) }
  assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), oracle); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal((await captureInputSnapshot(f.root)).id, before.id)
})

for (const choice of ['adopt_behavior', 'new_rule'] as const) test(`AC-APPLICATION-P3-ORACLE-PROTOCOL ${choice} 同一精确独审finding停止oracle政策互斥不授写权`, async t => {
  const f = await exportApplicationFixture(t, choice, { legacyFilter: true, reviewConflict: true }), before = await captureInputSnapshot(f.root), oracle = readFileSync(join(f.root, 'tests/export.test.mjs')), index = readFileSync(join(f.root, '.git/index'))
  const submitted = await f.application.submit({ nodeId: 'export-contract', requestId: `oracle-protocol-conflict-${choice}`, origin: 'code' }); assert.ok(submitted.operation)
  const first = await f.application.wait(submitted.operation.id); assert.ok(first.decisionContext)
  assert.equal(first.operation.previousBaselinePair, null)
  assert.ok(first.operation.baselineSelection!.bindings.every(binding => ('bytePair' in binding ? binding.bytePair : binding.intentPair) === null))
  assert.equal(first.attempt!.composedInput!.sourceInputId, first.operation.input.id)
  assert.equal(first.attempt!.composedInput!.contentDigest, first.decisionContext.analysis.composedDigest)
  const decision = await f.application.decide({ operationId: first.operation.id, inputId: first.operation.input.id, analysisRef: first.decisionContext.analysisRef, findingIds: first.decisionContext.analysis.findings.map(finding => finding.id), requestId: `oracle-protocol-decision-${choice}`, decision: choice === 'new_rule' ? { choice, rule: 'filter长度不得超过128字符；其他原需求保持有效。' } : { choice } })
  const result = await f.application.wait(decision.operation.id)
  const behaviorRequests = f.nativeRequests.filter(request => ['code_behavior_analyze', 'code_behavior_review'].includes(request.purpose) && request.prompt.includes('"origin":"decision"'))
  assert.equal(behaviorRequests.length, 2)
  for (const dispatch of behaviorRequests) {
    const frozen = readFrozenBehaviorContext<{ decision: { previousComposed: unknown }; verifiedDelivery: unknown[] }>(dispatch)
    assert.deepEqual(frozen.decision.previousComposed, first.attempt!.composedInput)
    assert.deepEqual(frozen.verifiedDelivery, [])
  }
  assert.equal(result.operation.phase, 'needs_input'); assert.equal(result.attempt?.failure?.code, 'oracle_policy_conflict')
  assert.equal(result.operation.callsUsed, 6); assert.equal(result.journals.length, 0); assert.equal(result.attempt?.verification, null)
  const diagnosis = JSON.parse(result.attempt!.failure!.message)
  assert.equal(diagnosis.conflicts[0].testId, 'ORACLE-FILTER-LEGACY'); assert.equal(diagnosis.conflicts[0].oracleDigest, contentHash(oracle))
  assert.equal(diagnosis.conflicts[0].decisionRef.sha256, result.operation.requestBlob!.sha256)
  assert.deepEqual(diagnosis.conflicts[0].verification.command, ['node', '--test', 'tests/export.test.mjs'])
  assert.ok(diagnosis.conflicts[0].counterexample.includes(choice === 'adopt_behavior' ? '9' : '129'))
  const calls = f.calls(); assert.equal((await f.application.wait(result.operation.id)).operation.phase, 'needs_input'); assert.equal(f.calls(), calls)
  assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), oracle); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index); assert.equal((await captureInputSnapshot(f.root)).id, before.id)
})

for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) test(`AC-APPLICATION-P3-DELIVERY ${choice} 公共裁决从真实已审冲突经Docker与普通hooks结算receipt`, { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
    const f = await exportApplicationFixture(t, choice), before = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), oracle = readFileSync(join(f.root, 'tests/export.test.mjs'))
    execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import { ExportService } from './src/export.js'; const service = new ExportService(); assert.equal(service.submit('owner','eight','12345678').filter.length,8); assert.throws(() => service.submit('owner','nine','123456789'), /invalid-request/);"], { cwd: f.root, stdio: 'pipe' })
    const submitted = await f.application.submit({ nodeId: 'export-contract', requestId: `external-eight-${choice}`, origin: 'code' }); assert.ok(submitted.operation)
    const conflicted = await f.application.wait(submitted.operation.id)
    assert.equal(conflicted.operation.phase, 'conflicted', JSON.stringify(conflicted.attempt?.failure))
    assert.ok(conflicted.decisionContext); assert.equal(conflicted.decisionContext.analysis.reviewPassed, true)
    assert.ok(conflicted.operation.baselineSelection, 'fresh code入口必须为真实P4 exact操作')
    assert.ok(conflicted.journals.some(journal => journal.status === 'settled' && journal.receipt), '未冲突部分必须已真实交付，不能只伪造partial heads')
    const settled = f.application.store.readBaselineSelection(conflicted.operation.input.source, conflicted.operation.baselineSelection.bindings.map(binding => binding.resource))
    assert.ok('selection' in settled)
    assert.notEqual(settled.selection.digest, conflicted.operation.baselineSelection.digest)
    const { analysisRef, analysis } = conflicted.decisionContext
    assert.equal(analysis.findings.length, 1)
    const finding = analysis.findings[0]
    assert.equal(finding.kind, 'conflict'); assert.deepEqual(finding.ruleIds, ['RULE-EXPORT-02']); assert.deepEqual(finding.affectedIds, ['AC-EXPORT-02', 'RULE-EXPORT-02'])
    assert.deepEqual(f.nativeRequests.slice(0, 2).map(request => request.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    const priorCalls = f.calls()
    const request = { operationId: submitted.operation.id, inputId: submitted.operation.input.id, analysisRef, findingIds: [finding.id], requestId: `decide-${choice}`, decision: choice === 'new_rule' ? { choice, rule: 'filter长度不得超过128字符；非空输入、所有者权限、幂等及其他原需求保持有效。' } : { choice } }
    const decision = await f.application.decide(request)
    assert.equal(decision.operation.input.id, conflicted.operation.input.id)
    assert.equal(decision.operation.baselineSelection?.digest, settled.selection.digest, '新decision沿同资源已实际结算heads，原analysis/input不变')
    assert.deepEqual(decision.operation.scope, conflicted.operation.scope)
    const delivered = await f.application.wait(decision.operation.id)
    assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify({ failure: delivered.attempt?.failure, blockedReason: delivered.operation.blockedReason, journals: delivered.journals }))
    assert.equal(delivered.attempt!.verification!.passed, true)
    const proof = JSON.parse(readEvidence(before.source.commonDir, delivered.attempt!.verification!.resultBlob).toString('utf8')) as VerificationResultBlob
    assert.deepEqual(proof.layers.map(layer => [layer.layer, layer.verdict]), [['V1', 'pass'], ['V2', 'pass'], ['V3', 'pass'], ['V4', 'pass']])
    const journal = delivered.journals[0]; assert.equal(journal.status, 'settled'); assert.ok(journal.receipt)
    const receipt = journal.receipt, entries = readTree(before.source.commonDir, receipt.actualTree), entry = entries.find(entry => entry.path === f.path)!
    const actual = readObject(before.source.commonDir, entry.oid).toString('utf8'), raw = parseParts(actual)!.rawSource!
    assert.equal(readFileSync(join(receipt.deliverySnapshot.source.canonicalRoot, f.path), 'utf8'), actual)
    const contract = parseContract({ nodeId: 'export-contract', path: f.path, source: actual }).contract!
    const rule = contract.items.find(item => item.id === 'RULE-EXPORT-02')!, ac = contract.items.find(item => item.id === 'AC-EXPORT-02')!
    const expectedLimit = choice === 'adopt_behavior' ? 8 : choice === 'new_rule' ? 128 : null
    assert.equal(raw, renderControlledDecisionRaw(parseParts(f.original)!.rawSource!, request, analysis))
    if (expectedLimit === null) { assert.equal(raw, parseParts(f.original)!.rawSource); assert.ok(sameContractBusinessMeaning(f.contract.items.find(item => item.id === rule.id)!, rule)); assert.ok(sameContractBusinessMeaning(f.contract.items.find(item => item.id === ac.id)!, ac)) }
    else { assert.match(raw, new RegExp(`(?:${expectedLimit}字符|超过${expectedLimit}字符)`)); assert.equal(rule.kind, 'RULE'); assert.match(rule.constraint, new RegExp(`${expectedLimit}字符`)); assert.equal(ac.kind, 'AC'); assert.match(ac.assertion, new RegExp(`${expectedLimit + 1}字符拒绝`)) }
    for (const originalItem of f.contract.items.filter(item => !['RULE-EXPORT-02', 'AC-EXPORT-02'].includes(item.id))) assert.ok(sameContractBusinessMeaning(originalItem, contract.items.find(item => item.id === originalItem.id)!), originalItem.id)
    const deliveryCode = readFileSync(join(receipt.deliverySnapshot.source.canonicalRoot, 'src/export.js'), 'utf8')
    assert.equal(deliveryCode.includes('filter.length > 8'), expectedLimit === 8); assert.equal(deliveryCode.includes('filter.length > 128'), expectedLimit === 128)
    assert.deepEqual(readFileSync(join(receipt.deliverySnapshot.source.canonicalRoot, 'tests/export.test.mjs')), oracle)
    assert.equal((await captureInputSnapshot(f.root)).id, before.id); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
    assert.equal(delivered.operation.callsUsed, 6); assert.equal(f.calls(), priorCalls + 6)
    const calls = f.calls(), commits = f.git(['rev-list', '--count', delivered.operation.deliveryPlan.branch])
    assert.equal((await f.application.decide(request)).operation.id, decision.operation.id)
    const alias = await f.application.decide({ ...request, requestId: `${request.requestId}-transport-after-receipt` })
    assert.equal(alias.operation.id, decision.operation.id)
    assert.equal(alias.operation.deadlineAtMs, decision.operation.deadlineAtMs)
    assert.deepEqual((await f.application.wait(decision.operation.id)).journals, delivered.journals)
    assert.equal(f.calls(), calls); assert.equal(f.git(['rev-list', '--count', delivered.operation.deliveryPlan.branch]), commits)
})

test('AC-APPLICATION-06 应用真实Docker及compiled hooks完整交付，completed重放沿原共同基线幂等', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 180000 }, async t => {
  const { temp, root, application, calls } = await exportApplicationFixture(t)
  const before = await captureInputSnapshot(root), request = { nodeId: 'export-contract', requestId: 'complete-replay', origin: 'initial' as const }
  const admitted = await application.submit(request); assert.ok(admitted.operation)
  const delivered = await application.wait(admitted.operation.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify({ failure: delivered.attempt?.failure, blockedReason: delivered.operation.blockedReason, journals: delivered.journals }))
  assert.ok(delivered.journals[0]?.receipt)
  assert.equal(delivered.sourceSynced, false); assert.equal(delivered.stale, false)
  assert.match(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8'), /application verified delivery/)
  assert.equal((await captureInputSnapshot(root)).id, before.id)
  const callCount = calls(), replay = await application.submit(request)
  assert.equal(replay.operation?.id, admitted.operation.id); assert.equal(calls(), callCount)
  assert.deepEqual((await application.readOperation(admitted.operation.id)).journals, delivered.journals)
  const key = contentHash(delivered.operation.ingressKey), descriptor = join(temp, 'runtime/artifacts', `application-runtime-${key}.json`)
  const frozenDescriptor = readFileSync(descriptor)
  rmSync(descriptor)
  assert.equal((await application.readOperation(admitted.operation.id)).executionAvailability.status, 'recovery_required')
  await application.submit(request)
  assert.deepEqual(readFileSync(descriptor), frozenDescriptor)
  assert.equal(calls(), callCount)
})


test('AC-APPLICATION-22 同受控编辑更换requestId仍归原failed预算，alias重放精确且只有retryOf开新预算', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const bytes = readFileSync(join(f.root, '.spec/demo/spec.md')), index = readFileSync(join(f.root, '.git/index')), head = f.git(['rev-parse', 'HEAD'])
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' }
    const first = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-A', patch }); assert.ok(first.operation)
    const original = (await f.application.wait(first.operation.id)).operation
    const second = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch }); assert.ok(second.operation)
    const replay = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch })
    assert.equal(second.operation.id, original.id); assert.equal(replay.operation?.id, original.id)
    await f.application.wait(original.id)
    assert.deepEqual((await f.application.readOperation(original.id)).operation, original)
    assert.equal(f.calls.length, 1); assert.equal((await f.application.status()).operations.length, 1)
    const ingress = f.application.store.findIngressReceipt(`application:${original.input.source.repositoryId}:${original.input.source.canonicalRoot}:ordinary-B`)!
    assert.notEqual(ingress.requestBlob?.sha256, original.requestBlob?.sha256)
    assert.ok(f.application.store.pinnedBlobRefs().some(ref => ref.sha256 === ingress.requestBlob?.sha256))
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch: { ...patch, reason: '不同用户授权意图' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch: { ...patch, replacement: '另一个正文' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    const retry = await f.application.submit({ nodeId: 'demo', requestId: 'explicit-retry', retryOf: original.id }); assert.ok(retry.operation)
    assert.notEqual(retry.operation.id, original.id); assert.deepEqual(retry.operation.requestBlob, original.requestBlob)
    await f.application.wait(retry.operation.id); assert.equal(f.calls.length, 2)
    const next = await f.application.submit({ nodeId: 'demo', requestId: 'new-patch', patch: { ...patch, replacement: '另一项真实用户编辑' } }); assert.ok(next.operation)
    assert.notEqual(next.operation.id, original.id); await f.application.wait(next.operation.id); assert.equal(f.calls.length, 3)
    const intent = await f.application.submit({ nodeId: 'demo', requestId: 'new-intent', patch: { ...patch, reason: '新的授权意图' } }); assert.ok(intent.operation)
    assert.notEqual(intent.operation.id, original.id); await f.application.wait(intent.operation.id); assert.equal(f.calls.length, 4)
    assert.deepEqual(readFileSync(join(f.root, '.spec/demo/spec.md')), bytes); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index); assert.equal(f.git(['rev-parse', 'HEAD']), head)
  } finally { f.cleanup() }
})


test('AC-APPLICATION-23 正式v6结构旧patch重开后换requestId及alias重放不产生新预算或模型调用', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.temp, 'legacy-v6.sqlite'))
  try {
    await f.application.enable()
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' }
    const accepted = await f.application.submit({ nodeId: 'demo', requestId: 'old-A', patch }); assert.ok(accepted.operation)
    const old = (await f.application.wait(accepted.operation.id)).operation
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 6))
    const address = syncCoordinatorAddress(old.input.source.repositoryId)
    legacy.initialize(address)
    const originalMessage = f.protocol.readMessages(address).find(message => message.messageId === old.dispatchMessageId)!
    const message = legacy.enqueue(address, { kind: originalMessage.kind, body: originalMessage.body, idempotencyKey: originalMessage.idempotencyKey })
    legacy.withTransaction(tx => tx.dequeue(address, message.messageId))
    for (const table of ['sync_operations', 'sync_attempts', 'sync_leases']) for (const row of f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))) {
      if (table === 'sync_operations') { const record = JSON.parse(String(row.record_json)); record.dispatchMessageId = message.messageId; row.record_json = JSON.stringify(record) }
      const columns = Object.keys(row).filter(column => column !== 'normalized_semantic_digest')
      legacy.withTransaction(tx => tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    }
    let newCalls = 0
    const reopened = await SyncApplication.create(f.root, { protocol: legacy, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async () => { newCalls++; throw new Error('旧受控请求不应再派发') } })
    retainHistoricalFrozenWorkflow(reopened)
    const second = await reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch }); assert.ok(second.operation)
    assert.equal(second.operation.id, old.id); assert.equal(second.operation.payloadDigest, old.payloadDigest)
    assert.equal(second.operation.callsUsed, old.callsUsed); assert.equal(second.operation.deadlineAtMs, old.deadlineAtMs)
    assert.deepEqual(second.operation.requestBlob, old.requestBlob)
    assert.equal((await reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch })).operation?.id, old.id)
    await reopened.wait(old.id); assert.equal(newCalls, 0); assert.equal(f.calls.length, 1)
    assert.equal((await reopened.status()).operations.length, 1)
    await assert.rejects(reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch: { ...patch, replacement: '不同原意' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { legacy.close(); f.cleanup() }
})


test('AC-APPLICATION-P3 code/combined手动接入与可信裁决冻结，旧原意和冲突保留且重复至多一次', async () => {
  for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) {
    const model = 'gpt-6.1-astra', f = await fixture({ ...settings, model })
    try {
      await f.application.enable()
      const starts: string[] = []
      f.application.start = id => { starts.push(id) }
      const code = (await f.application.submit({ nodeId: 'demo', requestId: 'code-input', origin: 'code' })).operation!
      assert.equal(code.origin, 'code')
      assert.equal(code.model, model)
      const first = (await f.application.submit({ nodeId: 'demo', requestId: 'combined-input', origin: 'combined' })).operation!
      assert.equal(first.origin, 'combined')
      assert.equal(first.model, model)
      f.application.store.ackDispatch(first.input.source.repositoryId, code.dispatchMessageId)
      const acknowledged = f.application.store.ackDispatch(first.input.source.repositoryId, first.dispatchMessageId)
      const claimed = f.application.store.claimQueuedAttempt({ operationId: first.id, source: first.input.source, scope: first.scope, leaseMs: 60000, expectedRevision: acknowledged.revision })
      const composed = composeAuthoredInput(first.input, first.baselineSelection!, { executionPaths: first.scope.paths, contextPaths: f.application['operationPlan'](first).readPaths }).composed!
      f.application.store.bindComposedInput(claimed.fence, composed)
      const analysis = { version: 'code-behavior-v1', inputId: first.input.id, baselinePairId: null, composedDigest: composed.contentDigest, baselineSelectionDigest: first.baselineSelection!.digest, readSetDigest: first.readSetDigest, policyDigest: first.policyDigest, inputDigest: first.input.contentDigest, reviewPassed: true, changes: [], findings: [{ id: 'conflict-1', kind: 'conflict', ruleIds: ['RULE-DEMO-01'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], originalIntent: '返回用户指定的文本。', sourceBehavior: '返回大写文本。', deliveryBehavior: '保留原文本。', counterexample: 'a → A', evidence: 'src/demo.mjs', decision: '是否允许改变大小写？' }, { id: 'gap-2', kind: 'coverage_gap', ruleIds: [], affectedIds: ['REQ-OTHER-1'], paths: ['src/other.mjs'], originalIntent: '独立规则', sourceBehavior: '未知规则', deliveryBehavior: '', counterexample: '', evidence: '', decision: '另一项事实' }], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [] }
      const analysisRef = writeEvidence(first.input.source.commonDir, analysis)
      const stageRef = writeEvidence(first.input.source.commonDir, { version: 'sync-stage-v1', operationId: first.id, attemptId: claimed.attempt.id, inputId: first.input.id, policyDigest: first.policyDigest, readSetDigest: first.readSetDigest, baselineSelectionRef: writeEvidence(first.input.source.commonDir, first.baselineSelection!), stage: 'analysis', resultRef: analysisRef })
      f.application.store.checkpoint(claimed.fence, analysisRef)
      f.application.store.checkpoint(claimed.fence, stageRef)
      f.application.store.recordFailure(claimed.fence, { code: 'business_conflict', message: '有具体业务分歧', kind: 'conflict', evidenceRefs: [analysisRef] })
      const request = { operationId: first.id, inputId: first.input.id, requestId: 'keep-1', analysisRef, findingIds: ['conflict-1'], decision: choice === 'new_rule' ? { choice, rule: '只改变 ASCII 字母大小写。' } : { choice } }
      await assert.rejects(f.application.decide({ ...request, analysisRef: writeEvidence(first.input.source.commonDir, { ...analysis, findings: [] }) }), /可信当前检查点/)
      await assert.rejects(f.application.decide({ ...request, findingIds: ['invented'] }), /真实存在/)
      await assert.rejects(f.application.decide({ ...request, inputId: 'stale' }), /旧分歧裁决/)
      const [keep, duplicate] = await Promise.all([f.application.decide(request), f.application.decide(request)])
      assert.equal(keep.operation.id, duplicate.operation.id)
      const alias = await f.application.decide({ ...request, requestId: 'same-choice-another-transport-id' })
      assert.equal(alias.operation.id, keep.operation.id)
      assert.equal(alias.operation.deadlineAtMs, keep.operation.deadlineAtMs)
      assert.equal(alias.operation.callsUsed, keep.operation.callsUsed)
      const twoFindings = await f.application.decide({ ...request, requestId: 'two-findings', findingIds: ['conflict-1', 'gap-2'] })
      const reordered = await f.application.decide({ ...request, requestId: 'two-findings-another-uuid', findingIds: ['gap-2', 'conflict-1'] })
      assert.equal(twoFindings.operation.id, reordered.operation.id)
      assert.equal(twoFindings.operation.deadlineAtMs, reordered.operation.deadlineAtMs)
      assert.equal(twoFindings.operation.callsUsed, reordered.operation.callsUsed)


      assert.equal(keep.operation.origin, 'decision')
      assert.equal(keep.operation.model, model)
      assert.equal(keep.operation.rootCauseId, first.rootCauseId)
      assert.ok(keep.operation.requestBlob)
      assert.equal(starts.filter(id => id === keep.operation.id).length, 1)
      await assert.rejects(f.application.decide({ ...request, decision: { choice: choice === 'adopt_behavior' ? 'keep_intent' : 'adopt_behavior' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
      const frozenPlan = JSON.parse(readEvidence(first.input.source.commonDir, keep.operation.planBlob!).toString('utf8'))
      assert.deepEqual(frozenPlan.decisionAuthorities, [{
        stableDecisionId: frozenPlan.facts.find((fact: { source: string }) => fact.source.startsWith('decision:')).source.slice('decision:'.length),
        requestRef: keep.operation.requestBlob, operationId: first.id, inputId: first.input.id, analysisRef,
        findingIds: ['conflict-1'], ruleIds: ['RULE-DEMO-01'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], decision: request.decision,
      }])
      if (choice !== 'keep_intent') {
        const raw = frozenPlan.targets.find((target: { nodeId: string }) => target.nodeId === 'demo').rawSource
        assert.match(raw, /返回用户指定的文本/)
        assert.match(raw, choice === 'new_rule' ? /ASCII/ : /返回大写/)
      }
      assert.equal(frozenPlan.facts.filter((fact: { source: string }) => fact.source.startsWith('decision:')).length, 1)
      const saved = JSON.parse(readEvidence(first.input.source.commonDir, keep.operation.requestBlob!).toString('utf8'))
      assert.deepEqual(saved.findingIds, ['conflict-1'])
      const history = await f.application.readOperation(first.id)
      assert.equal(history.operation.phase, 'superseded')
      assert.equal(history.decisionContext?.analysisRef.sha256, analysisRef.sha256)
      assert.equal(readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8'), source)
      writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => text.toUpperCase()\n')
      await assert.rejects(f.application.decide({ ...request, requestId: 'after-source-edit' }), /旧分歧裁决/)
    } finally { f.cleanup() }
  }
})

test('AC-APPLICATION-P3-PARTIAL 剩余裁决保留最新交付raw及原受控正文差量', async t => {
  for (const placement of ['separate', 'same-line', 'overlap-review'] as const) await t.test(placement, async () => {
  const f = await fixture()
  try {
    const path = '.spec/demo/spec.md'
    const authored = source.replace('返回用户指定的文本。', '返回用户指定的文本。\n\n未选义务：保持隔离。\n\n待修改事实：原文字节。')
    writeFileSync(join(f.root, path), authored)
    await f.application.enable(); f.application.start = () => {}
    const snapshot = await captureInputSnapshot(f.root)
    const prepared = await prepareSpecBodyEdit(f.root, 'demo', { startLine: 9, endLine: 9, original: '待修改事实：原文字节。', replacement: '待修改事实：必须保留本次作者输入。' })
    const request = prepareControlledRequest(snapshot, prepared, { kind: 'user_edit', requestId: 'legacy-partial-original', nodeId: 'demo', intent: '保留尚未落地的正文意图' })
    const admission = await prepareSyncAdmission(snapshot, await buildSyncApplicationPlan(snapshot, 'demo'), { ingressKey: 'legacy-partial-original', rootCauseId: 'legacy-partial-original', origin: 'combined', budget: settings.budget, managedRoot: f.application['managedRoot'], requestBlob: request.requestBlob! })
    f.application['prepareTools'](admission.ingressKey, null)
    const original = f.application.store.admitAndEnqueue(admission)
    assert.equal(original.baselineSelection, undefined, '本case保留明确P3历史入口，不将legacy pair伪装成P4 heads')
    const claim = f.application.store.claimAttempt({ operationId: original.id, source: original.input.source, scope: original.scope, leaseMs: 60000 })
    const composed = composeControlledRequest(original.input, composeAuthoredInput(original.input).composed!, original.requestBlob!).composed!
    f.application.store.bindComposedInput(claim.fence, composed)
    const analysis = { version: 'code-behavior-v1', inputId: original.input.id, baselinePairId: null, composedDigest: composed.contentDigest, readSetDigest: original.readSetDigest, policyDigest: original.policyDigest, inputDigest: original.input.contentDigest, reviewPassed: true, changes: [], findings: [{ id: 'remaining-B', kind: 'conflict', ruleIds: ['RULE-DEMO-B'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], originalIntent: '保持文本', sourceBehavior: '转换大小写', deliveryBehavior: '保持文本', counterexample: 'a → A', evidence: 'src/demo.mjs', decision: '选择B规则' }], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [] }
    const analysisRef = writeEvidence(original.input.source.commonDir, analysis)
    f.application.store.checkpoint(claim.fence, analysisRef)
    f.application.store.checkpoint(claim.fence, writeEvidence(original.input.source.commonDir, { version: 'sync-stage-v1', operationId: original.id, attemptId: claim.attempt.id, inputId: original.input.id, policyDigest: original.policyDigest, stage: 'analysis', resultRef: analysisRef }))
    f.application.store.recordFailure(claim.fence, { code: 'business_conflict', message: 'B待决', kind: 'conflict', evidenceRefs: [analysisRef] })
    writeFileSync(join(f.root, path), placement === 'separate' ? authored.replace('未选义务：保持隔离。', '未选义务：保持隔离。\n已结算规则A：保留此前接受的计数。') : authored.replace('待修改事实：原文字节。', placement === 'same-line' ? '待修改事实：原文字节。 已结算规则A：保留此前接受的计数。' : '待修改事实：此前接受的事实。 已结算规则A：保留此前接受的计数。'))
    const delivery = await captureInputSnapshot(f.root)
    writeFileSync(join(f.root, path), authored)
    const pair: BaselinePair = { id: 'partial-A', repositoryId: original.input.source.repositoryId, source: original.input.source, sourceInput: original.input, verifiedDelivery: delivery, coveredScope: original.scope, receiptId: 'verified-partial-A', settledAtMs: Date.now() }
    const journal: ApplyJournal = { id: 'fixture-partial-A', operationId: original.id, attemptId: claim.attempt.id, generation: original.generation, status: 'settled', steps: [], createdAtMs: pair.settledAtMs,
      plan: { effectKey: 'fixture-partial-A', payloadDigest: 'fixture', candidateDigest: 'fixture', verificationBlob: writeEvidence(original.input.source.commonDir, { fixture: true }), target: delivery.source, expectedTargetSnapshotId: delivery.id, expectedBaselinePairId: null, coveredScope: original.scope, files: [], planBlob: writeEvidence(original.input.source.commonDir, { fixture: true }) },
      receipt: { id: pair.receiptId, journalId: 'fixture-partial-A', effectKey: 'fixture-partial-A', actualTree: delivery.immutableTree, actualCommit: null, deliverySnapshot: delivery, evidenceRefs: [], completedAtMs: pair.settledAtMs } }
    f.protocol.withTransaction(tx => {
      tx.exec('INSERT INTO sync_apply_journals(id,operation_id,attempt_id,effect_key,payload_digest,status,receipt_id,record_json) VALUES(?,?,?,?,?,?,?,?)', journal.id, original.id, claim.attempt.id, journal.plan.effectKey, journal.plan.payloadDigest, journal.status, pair.receiptId, JSON.stringify(journal))
      const sourceKey = String(tx.query('SELECT source_key FROM sync_operations WHERE id=?', original.id)[0].source_key)
      tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', pair.id, pair.repositoryId, sourceKey, pair.receiptId, pair.settledAtMs, JSON.stringify(pair))
    })
    const result = await f.application.decide({ requestId: 'remaining-choice-B', operationId: original.id, inputId: original.input.id, analysisRef, findingIds: ['remaining-B'], decision: { choice: 'new_rule', rule: '规则B：仅转换ASCII字母。' } })
    const plan = JSON.parse(readEvidence(original.input.source.commonDir, result.operation.planBlob!).toString('utf8'))
    const raw = plan.targets.find((target: { nodeId: string }) => target.nodeId === 'demo').rawSource
    if (placement === 'overlap-review') {
      assert.equal(raw, undefined, '暂选作者正文不得固定为raw覆盖后续独审结果')
      const decisionRef = result.operation.requestBlob!
      const composition = composeControlledRequest(original.input, composeAuthoredInput(original.input, pair, { retainConflicts: true }).composed!, decisionRef, { retainConflicts: true }).composed!
      assert.ok(composition.compositionEvidenceBlob)
      const evidence = JSON.parse(readEvidence(original.input.source.commonDir, composition.compositionEvidenceBlob).toString('utf8'))
      assert.ok(evidence.conflicts.some((conflict: { path: string }) => conflict.path === path))
    } else {
      assert.match(raw, /已结算规则A：保留此前接受的计数/)
      assert.match(raw, /未选义务：保持隔离/)
      assert.match(raw, /待修改事实：必须保留本次作者输入/)
      assert.match(raw, /规则B：仅转换ASCII字母/)
    }
    assert.equal(result.operation.previousBaselinePair?.id, pair.id)
    assert.equal(readFileSync(join(f.root, path), 'utf8'), authored)
  } finally { f.cleanup() }
  })
})

async function observeUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { assert.ok(Date.now() < deadline, '后台同步观察超时'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
test('提交门禁：外部Spec/代码保存与git add不改变自动输入，提交后才观察HEAD字节', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `unsaved before enable:${text}`\n')
    writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('返回用户指定的文本。', '未提交初始原意。'))
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    const initial = f.application.observationStatus().latestSnapshot!
    assert.equal(initial.immutableTree, f.git(['rev-parse', 'HEAD^{tree}']).trim(), '首次纳管不读取已有未提交编辑')
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `committed:${text}`\n')
    writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('返回用户指定的文本。', '返回提交后的文本。'))
    await f.application['scanObservedInput']()
    assert.equal(f.application.observationStatus().latestSnapshot!.id, initial.id, '未提交保存不能成为自动输入')
    f.git(['add', '.'])
    await f.application['scanObservedInput']()
    assert.equal(f.application.observationStatus().latestSnapshot!.id, initial.id, 'git add不能成为自动输入')
    f.git(['commit', '-qm', 'external combined input'])
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `dirty:${text}`\n')
    await f.application['scanObservedInput']()
    const committed = f.application.observationStatus().latestSnapshot!
    assert.notEqual(committed.id, initial.id)
    assert.equal(committed.captureKind, 'commit')
    const entries = readTree(committed.source.commonDir, committed.immutableTree)
    assert.match(readObject(committed.source.commonDir, entries.find(entry => entry.path === 'src/demo.mjs')!.oid).toString(), /committed:/)
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('提交门禁：code、Spec、混合commit按已提交差量分类，同commit及重启不重复派发', async () => {
  const f = await fixture()
  try {
    governDemoCode(f)
    f.application['launch'] = () => {}
    const boundaries = new Map<string, { before: Awaited<ReturnType<typeof captureInputSnapshot>> | null; paths: readonly string[] }>()
    const freeze = f.application['freezeNodePlan'].bind(f.application)
    f.application['freezeNodePlan'] = async (snapshot, nodeId, reuse, direction, trigger) => {
      if (trigger) boundaries.set(snapshot.id, trigger)
      return freeze(snapshot, nodeId, reuse, direction, trigger)
    }
    await f.application.enable()
    await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    const initial = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)[0]
    assert.equal(initial.origin, 'initial'); assert.equal(initial.input.captureKind, 'commit')
    assert.equal(boundaries.get(initial.input.id)!.before, null)
    let previous = initial.input
    for (const [origin, message] of [['code', 'code only'], ['spec', 'spec only'], ['combined', 'both']] as const) {
      if (origin !== 'spec') writeFileSync(join(f.root, 'src/demo.mjs'), `export const demo = text => text // ${message}\n`)
      if (origin !== 'code') writeFileSync(join(f.root, '.spec/demo/spec.md'), readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8').replace('返回用户指定的文本。', `返回用户指定的文本。${message}`))
      f.git(['add', '.']); f.git(['commit', '-qm', message])
      writeFileSync(join(f.root, 'src/demo.mjs'), `export const demo = text => text // uncommitted after ${message}\n`)
      await f.application['scanObservedInput']()
      const head = f.git(['rev-parse', 'HEAD']).trim(), operation = f.application.store.listOperations(initial.input.source.repositoryId).find(item => item.input.headCommit === head)!
      assert.ok(operation, JSON.stringify(f.application.observationStatus().latest))
      assert.equal(operation.origin, origin)
      assert.equal(boundaries.get(operation.input.id)!.before!.id, previous.id, '边界沿上次真实接入快照')
      assert.equal((await f.application.readOperation(operation.id)).stale, false, '后来的dirty编辑不改变commit操作当前性')
      const count = f.application.store.listOperations(initial.input.source.repositoryId).length
      await f.application['scanObservedInput'](); assert.equal(f.application.store.listOperations(initial.input.source.repositoryId).length, count)
      f.git(['restore', 'src/demo.mjs'])
      previous = operation.input
    }
    const count = f.application.store.listOperations(initial.input.source.repositoryId).length
    await f.application.stopService(); await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    assert.equal(f.application.store.listOperations(initial.input.source.repositoryId).length, count)
    await f.application.stopService()
    writeFileSync(join(f.root, '.spec/demo/spec.md'), readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8') + '\n停机期间提交原意。\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'offline spec commit'])
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `offline:${text}`\n'); f.git(['add', '.']); f.git(['commit', '-qm', 'offline code commit'])
    writeFileSync(join(f.root, '.spec/demo/spec.md'), readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8') + '\n未提交保存不进入补偿。\n')
    await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    const compensated = f.application.store.listOperations(initial.input.source.repositoryId)[0]
    assert.equal(compensated.origin, 'combined'); assert.equal(compensated.input.headCommit, f.git(['rev-parse', 'HEAD']).trim())
    assert.equal(boundaries.get(compensated.input.id)!.before!.id, previous.id)
    assert.deepEqual(boundaries.get(compensated.input.id)!.paths, ['.spec/demo/spec.md', 'src/demo.mjs'])
    assert.notEqual(previous.immutableTree, f.git(['rev-parse', 'HEAD^' + '^{tree}']).trim(), '不能把累计边界猜成HEAD parent')
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('提交消费边界不排除当前已消费HEAD，采集身份或计划变化不取代待交付正文请求', async () => {
  const f = await fixture()
  try {
    governDemoCode(f)
    f.application['ownsObservation'] = () => true
    f.application.start = () => {}
    await f.application.enable()
    const initial = await captureInputSnapshot(f.root, { committed: true })
    await f.application['observeNode'](initial, 'demo')
    writeFileSync(join(f.root, '.spec/demo/spec.md'), readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8') + '\n已消费的交付说明。\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'fixture: consumed publication'])
    const consumed = await captureInputSnapshot(f.root, { committed: true }), frozen = await f.application['freezeNodePlan'](consumed, 'demo')
    // 仅投影既有消费记录的读边界，不登记receipt、基线head或业务验证通过。
    const pair: BaselinePair = { id: 'fixture-consumption-projection', source: consumed.source, repositoryId: consumed.source.repositoryId, sourceInput: consumed, verifiedDelivery: consumed, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-projection-only', settledAtMs: Date.now() }
    const { digest: _digest, ...body } = frozen.selection
    const selected = { ...body, bindings: body.bindings.map(binding => 'bytePair' in binding ? { ...binding, bytePair: pair } : binding) }
    const selection = { ...selected, digest: contentHash(JSON.stringify(selected, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
    const configRef = writeEvidence(consumed.source.commonDir, { fixture: 'consumed configuration' }), latestDifferenceDigest = writeEvidence(consumed.source.commonDir, { nodeId: 'demo', consumption: 'baseline' }).sha256
    f.application.store.recordObservation({ input: consumed, configRef, selection, latestDifferenceDigest }, { controlRevision: 0, selectionDigest: selection.digest })
    const current = await captureInputSnapshot(f.root)
    assert.notEqual(current.id, consumed.id)
    assert.equal(current.immutableTree, consumed.immutableTree)
    const edit = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定的文本，并拒绝换行。' }
    const pending = (await f.application.submit({ nodeId: 'demo', requestId: 'pending-ui-body', patch: edit })).operation!
    assert.ok(pending.requestBlob)
    const before = f.application['committedTrigger'](consumed, 'demo', frozen.plan)
    await f.application['observeNode'](consumed, 'demo')
    const after = f.application.store.readOperation(pending.id)
    assert.equal(after.phase, 'queued', '同源观察不能supersede尚未交付的UI正文请求')
    assert.equal(after.requestBlob?.sha256, pending.requestBlob!.sha256)
    assert.equal(before.origin, null, '已消费的同HEAD不再从旧initial重算Spec方向')
    assert.equal(before.commitTrigger.before?.id, consumed.id)
    assert.deepEqual(before.commitTrigger.paths, [])
    assert.equal(f.application.store.listOperations(consumed.source.repositoryId).length, 2)
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('提交消费边界在超过500次普通观察及重启后保留，后续code提交不夹带已消费Spec', async () => {
  const f = await fixture()
  try {
    governDemoCode(f)
    f.application['ownsObservation'] = () => true
    f.application.start = () => {}
    await f.application.enable()
    await f.application['observeNode'](await captureInputSnapshot(f.root, { committed: true }), 'demo')
    writeFileSync(join(f.root, '.spec/demo/spec.md'), readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8') + '\n已采纳的Spec正文。\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'fixture: consumed spec'])
    const consumed = await captureInputSnapshot(f.root, { committed: true }), frozen = await f.application['freezeNodePlan'](consumed, 'demo')
    const pair: BaselinePair = { id: 'fixture-history-projection', source: consumed.source, repositoryId: consumed.source.repositoryId, sourceInput: consumed, verifiedDelivery: consumed, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-projection-only', settledAtMs: Date.now() }
    const { digest: _digest, ...body } = frozen.selection
    const selected = { ...body, bindings: body.bindings.map(binding => 'bytePair' in binding ? { ...binding, bytePair: pair } : binding) }
    const selection = { ...selected, digest: contentHash(JSON.stringify(selected, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
    const configRef = writeEvidence(consumed.source.commonDir, { fixture: 'configuration' })
    f.application.store.recordObservation({ input: consumed, configRef, selection, latestDifferenceDigest: writeEvidence(consumed.source.commonDir, { nodeId: 'demo', consumption: 'baseline' }).sha256 }, { controlRevision: 0, selectionDigest: selection.digest })
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `${text}!`\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'real code-only commit'])
    const next = await captureInputSnapshot(f.root, { committed: true })
    const ordinary = { input: next, configRef, selection: null, latestDifferenceDigest: writeEvidence(next.source.commonDir, { nodeId: 'demo', policyDigest: 'changed metadata only' }).sha256 }
    for (let index = 0; index < 501; index++) f.application.store.recordObservation(ordinary, { controlRevision: 0, selectionDigest: null })
    assert.equal(f.application.store.listObservations(next.source, 500).every(observation => observation.input.id === next.id), true)
    const reopened = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime') })
    retainHistoricalFrozenWorkflow(reopened)
    try {
      const trigger = reopened['committedTrigger'](next, 'demo', frozen.plan)
      assert.equal(trigger.origin, 'code')
      assert.equal(trigger.commitTrigger.before?.id, consumed.id)
      assert.deepEqual(trigger.commitTrigger.paths, ['src/demo.mjs'])
    } finally { await reopened.stopService() }
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('提交消费边界仍准入真正的新文件、mode与删除，冻结未配对路径的真实存在性', async () => {
  const f = await fixture()
  try {
    governDemoCode(f)
    f.application['ownsObservation'] = () => true
    f.application.start = () => {}
    await f.application.enable()
    await f.application['observeNode'](await captureInputSnapshot(f.root, { committed: true }), 'demo')
    for (const action of ['new', 'mode', 'delete'] as const) {
      if (action === 'new') writeFileSync(join(f.root, 'src/new.mjs'), 'export const newValue = 1\n')
      else if (action === 'mode') chmodSync(join(f.root, 'src/new.mjs'), 0o755)
      else rmSync(join(f.root, 'src/new.mjs'))
      f.git(['add', '.']); f.git(['commit', '-qm', `real ${action} source`])
      const input = await captureInputSnapshot(f.root, { committed: true })
      await f.application['observeNode'](input, 'demo')
      const operation = f.application.store.listOperations(input.source.repositoryId).find(operation => operation.input.id === input.id)
      assert.ok(operation, `${action}不能因无bytehead被忽略`)
      assert.equal(operation.origin, 'code')
      const entry = readTree(input.source.commonDir, operation.input.immutableTree).find(entry => entry.path === 'src/new.mjs')
      assert.equal(entry?.mode, action === 'delete' ? undefined : action === 'mode' ? '100755' : '100644')
      const binding = operation.baselineSelection!.bindings.find(binding => binding.resource.kind === 'path' && binding.resource.path === 'src/new.mjs')
      assert.ok(binding && 'bytePair' in binding && binding.bytePair === null)
      const plan = JSON.parse(readEvidence(input.source.commonDir, operation.planBlob!).toString('utf8')) as { readPaths: string[] }
      assert.ok(plan.readPaths.includes('src/new.mjs'), '删除也保留真实前态路径和当前absence的只读冻结')
    }
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-P4-01 无浏览器暂停仍记录提交，恢复最新输入且重复失败不重开调用', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    const initial = f.application.observationStatus().latestSnapshot!.id
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `${text}!`\n')
    f.git(['add', '.']); f.git(['commit', '-qm', 'paused external code commit'])
    await observeUntil(() => f.application.observationStatus().latestSnapshot?.id !== initial)
    assert.equal(f.calls.length, 0)
    assert.equal(f.application.observationStatus().control.control, 'pause')
    assert.equal(f.application.observationStatus().latest?.operationId, null)
    await f.application.automaticControl('resume')
    await observeUntil(() => {
      if (f.calls.length > 0) return true
      const operations = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)
      for (const operation of operations) assert.notEqual(operation.phase, 'failed', JSON.stringify(f.application.store.listAttempts(operation.id).map(attempt => attempt.failure)))
      return false
    }, 30000)
    const operations = (await f.application.status()).operations
    assert.equal(operations.length, 1)
    const detail = await f.application.wait(operations[0].operation.id)
    assert.equal(detail.operation.input.id, f.application.observationStatus().latestSnapshot!.id)
    assert.equal(detail.operation.origin, 'initial', '从未接入的暂停观察不消费首次纳管边界')
    const firstCalls = f.calls.length
    assert.ok(firstCalls > 0)
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, firstCalls)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(f.calls.length, firstCalls)
    assert.equal((await f.application.status()).operations.length, 1)
  } finally { await f.application.stopService(); f.cleanup() }
})
test('AC-APPLICATION-P4-02 停机修改及外部Git提交启动补偿，离线状态不冒充监听在线', async () => {
  const f = await fixture()
  try {
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    const first = f.application.observationStatus().latestSnapshot!.id
    await f.application.stopService()
    assert.equal(f.application.observationStatus().health.watchOnline, false)
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `offline:${text}`\n')
    f.git(['add', 'src/demo.mjs']); f.git(['commit', '-qm', 'external offline commit'])
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    assert.notEqual(f.application.observationStatus().latestSnapshot!.id, first)
    assert.equal(f.application.observationStatus().latestSnapshot!.headCommit, f.git(['rev-parse', 'HEAD']).trim())
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})
test('AC-APPLICATION-P4-03 分支切换撤旧授权且物理暂停跨分支保留，显式重新启用才观察', async () => {
  const f = await fixture()
  try {
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 30, debounceMs: 5 })
    f.git(['switch', '-qc', 'new-branch'])
    await observeUntil(() => f.application.observationStatus().latestSnapshot?.source.branch.endsWith('new-branch') === true)
    assert.equal((await f.application.readSettings()).activation, 'invalidated')
    assert.equal(f.application.observationStatus().control.control, 'pause')
    assert.equal(f.calls.length, 0)
    await f.application.enable()
    assert.equal((await f.application.readSettings()).activation, 'enabled')
    assert.equal(f.application.observationStatus().latest?.input.source.branch.endsWith('new-branch'), true)
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-P4-04 nodeIds仅注册明确意图子树，新增raw纳入且无关节点未授权', async () => {
  const f = await fixture()
  try {
    cpSync(new URL('../../templates/spec/project/.plugins/', import.meta.url), join(f.root, '.spec/demo/.plugins'), { recursive: true })
    mkdirSync(join(f.root, '.spec/demo/child'), { recursive: true }); writeFileSync(join(f.root, '.spec/demo/child/spec.md'), source.replace('Demo', 'Child'))
    mkdirSync(join(f.root, '.spec/other'), { recursive: true }); writeFileSync(join(f.root, '.spec/other/spec.md'), source.replace('Demo', 'Other'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'register committed intent tree'])
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    assert.deepEqual(f.application.observationStatus().registeredNodes, ['demo'])
    assert.deepEqual(f.application.observationStatus().coverage.includedNodeIds.sort(), ['child', 'demo'])
    assert.deepEqual(f.application.observationStatus().coverage.excludedNodeIds, ['other'])
    assert.equal(f.application.observationStatus().coverage.totalNodeCount, 3)
    await assert.rejects(f.application.submit({ nodeId: 'other', requestId: 'unauthorized' }), /未在 sync.nodeIds 授权/)
    await assert.rejects(f.application.submit({ nodeId: 'session-fail', requestId: 'plugin-intent' }), /不存在 Spec 节点/)
    mkdirSync(join(f.root, '.spec/demo/new-raw'), { recursive: true }); writeFileSync(join(f.root, '.spec/demo/new-raw/spec.md'), source.replace('Demo', 'New'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'new committed raw intent'])
    await observeUntil(() => f.application.observationStatus().coverage.includedNodeIds.includes('new-raw'))
    assert.equal(f.application.observationStatus().registeredNodes.length, 1)
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})
test('AC-APPLICATION-P4-05 缺省node作用域只含真实治理授权源码，纯raw需要明确注册', async () => {
  const f = await fixture({ ...settings, nodeIds: undefined })
  try {
    await assert.rejects(f.application.enable(), /sync.nodeIds 明确登记/)
    writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
    cpSync(new URL('../../templates/spec/project/.plugins/', import.meta.url), join(f.root, '.spec/demo/.plugins'), { recursive: true })
    mkdirSync(join(f.root, '.spec/other'), { recursive: true }); writeFileSync(join(f.root, '.spec/other/spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - private/other.mjs'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'committed governed scope'])
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 10000 })
    assert.deepEqual(f.application.observationStatus().registeredNodes, ['demo'])
    assert.deepEqual(f.application.observationStatus().coverage.excludedNodeIds, ['other'])
    assert.equal(f.application.observationStatus().coverage.totalNodeCount, 2)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-P4-06 持久健康和最后差异可查询，缺失重建不会伪造快照或沿旧授权继续', async () => {
  const f = await fixture(), saved = join(f.temp, 'original-source')
  try {
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 40, debounceMs: 5 })
    const first = f.application.observationStatus()
    assert.equal(first.health.watchOnline, true)
    assert.equal(first.persistedHealth?.status, 'watching')
    assert.ok(first.latestDifference)
    const snapshotId = first.latestSnapshot!.id
    renameSync(f.root, saved)
    await observeUntil(() => f.application.observationStatus().health.status === 'missing')
    assert.equal(f.application.observationStatus().latestSnapshot!.id, snapshotId)
    assert.equal((await f.application.status()).settings.configurationError?.code, 'sync_source_missing')
    mkdirSync(f.root); f.git(['init', '-q', '-b', 'main'])
    await observeUntil(() => f.application.observationStatus().health.status === 'degraded')
    assert.ok(f.application.observationStatus().health.reason?.message)
    assert.equal(f.application.observationStatus().latestSnapshot!.id, snapshotId)
    assert.equal(f.application.observationStatus().health.watchOnline, false)
    assert.equal(f.calls.length, 0)
    await f.application.stopService()
    assert.equal(f.application.observationStatus().persistedHealth?.status, 'stopped')
    assert.equal(f.application.observationStatus().health.watchOnline, false)
  } finally { await f.application.stopService(); rmSync(saved, { recursive: true, force: true }); f.cleanup() }
})

test('AC-APPLICATION-P4-07 重新授权撤销旧意图，删除已注册根保留缺失范围与明确失败', async () => {
  const f = await fixture()
  try {
    mkdirSync(join(f.root, '.spec/other'), { recursive: true }); writeFileSync(join(f.root, '.spec/other/spec.md'), source.replace('Demo', 'Other'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'register committed intent tree'])
    await f.application.enable(); await f.application.automaticControl('pause')
    await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    assert.deepEqual(f.application.observationStatus().registeredNodes, ['demo'])
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, nodeIds: ['other'] } }))
    f.git(['add', '.']); f.git(['commit', '-qm', 'authorize other committed intent'])
    await f.application.enable()
    assert.deepEqual(f.application.observationStatus().registeredNodes, ['other'])
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'revoked' }), /未在 sync.nodeIds 授权/)
    rmSync(join(f.root, '.spec/other/spec.md'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'remove registered intent'])
    await observeUntil(() => f.application.observationStatus().coverage.missingNodeIds.includes('other'))
    await observeUntil(() => f.application.observationStatus().latest?.failure?.code === 'sync_node_unknown')
    assert.deepEqual(f.application.observationStatus().registeredNodes, ['other'])
    assert.equal(f.calls.length, 0)
  } finally { await f.application.stopService(); f.cleanup() }
})


test('AC-APPLICATION-P4-08 无浏览器真实Docker自动交付，补偿及scope外编辑不形成回声重跑', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await exportApplicationFixture(t)
  t.after(() => f.application.stopService())
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// human save before background startup\n`)
  f.git(['add', '.']); f.git(['commit', '-qm', 'external committed implementation'])
  const source = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), head = f.git(['rev-parse', 'HEAD'])
  const readonlyEntries = readTree(source.source.commonDir, source.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
  const admitted = (await f.application.status()).operations[0]?.operation
  assert.ok(admitted, '正式service启动扫描必须建立自动操作')
  const delivered = await f.application.wait(admitted.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify({ failure: delivered.attempt?.failure, blockedReason: delivered.operation.blockedReason, journals: delivered.journals }))
  assert.ok(delivered.journals[0]?.receipt)
  assert.equal(delivered.operation.input.captureKind, 'commit')
  assert.match(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8'), /human save before background startup/)
  assert.deepEqual(readTree(source.source.commonDir, delivered.journals[0].receipt.actualTree).filter(entry => !entry.path.startsWith('.spec/')), readonlyEntries)
  assert.equal(f.nativeRequests.some(request => request.purpose === 'code_generate'), false)
  assert.deepEqual(delivered.resources, [])
  assert.equal((await captureInputSnapshot(f.root)).id, source.id)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index); assert.equal(f.git(['rev-parse', 'HEAD']), head)
  const count = f.calls()
  writeFileSync(join(f.root, 'unrelated.txt'), 'scope外真实作者编辑\n')
  f.git(['add', '.']); f.git(['commit', '-qm', 'unrelated committed edit'])
  const observedHead = f.git(['rev-parse', 'HEAD']).trim()
  await observeUntil(() => f.application.observationStatus().latestSnapshot?.headCommit === observedHead, 30000)
  assert.equal((await f.application.readOperation(admitted.id)).stale, false)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(f.calls(), count)
  assert.equal((await f.application.status()).operations.length, 1)
})

test('AC-APPLICATION-P4-09 scope外变化不使查询重放重试过期，相关编辑仍明确拒绝', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'scoped-failure', origin: 'initial' as const }
    const admitted = await f.application.submit(request); assert.ok(admitted.operation)
    const original = await f.application.wait(admitted.operation.id)
    assert.equal(original.operation.phase, 'failed', JSON.stringify(original.attempt?.failure))
    writeFileSync(join(f.root, 'unrelated.txt'), '不属于该操作读取或写入闭包\n')
    assert.notEqual((await captureInputSnapshot(f.root)).id, original.operation.input.id)
    const current = await f.application.readOperation(original.operation.id)
    assert.equal(current.stale, false); assert.equal(current.retryEligibility.eligible, true)
    assert.equal((await f.application.submit(request)).operation?.id, original.operation.id)
    const retried = await f.application.submit({ nodeId: 'demo', requestId: 'scoped-retry', retryOf: original.operation.id })
    assert.ok(retried.operation); assert.equal(retried.operation.input.id, original.operation.input.id)
    await f.application.wait(retried.operation.id)
    writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('返回用户指定的文本。', '返回用户指定文本并添加后缀。'))
    const stale = await f.application.readOperation(retried.operation.id)
    assert.equal(stale.stale, true); assert.equal(stale.retryEligibility.eligible, false)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'stale-retry', retryOf: retried.operation.id }), /原输入已变化/)
  } finally { await f.application.stopService(); f.cleanup() }
})


test('AC-APPLICATION-P4-14 无生成字节差量时真实intent消费源码仍不形成回声', async t => {
  const f = await exportApplicationFixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// human comment requiring no code generation\n`)
  const input = await captureInputSnapshot(f.root), frozen = await f.application['freezeNodePlan'](input, 'export-contract')
  const pair: BaselinePair = { id: 'fixture-empty-generation', source: input.source, repositoryId: input.source.repositoryId, sourceInput: input, verifiedDelivery: input, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-empty-projection-only', settledAtMs: Date.now() }
  const { digest: _digest, ...payload } = frozen.selection
  const selected = { ...payload, bindings: payload.bindings.map(binding => 'intentPair' in binding ? { ...binding, intentPair: pair } : binding) }
  const selection = { ...selected, digest: contentHash(JSON.stringify(selected, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
  assert.equal(selection.bindings.every(binding => !('bytePair' in binding) || binding.bytePair === null), true)
  const composed = composeAuthoredInput(input, selection, { executionPaths: frozen.plan.executionScope!.paths, contextPaths: frozen.plan.readPaths }).composed!
  const evidence = readCompositionEvidence(input, composed, selection)
  assert.equal(evidence.artifacts.every(artifact => !artifact.changed), true)
  assert.equal(evidence.residualPaths.length, 0)
  assert.equal(f.application['observationChanges'](input, frozen.plan, selection, evidence).changed, false)
  assert.equal(f.calls(), 0, '真实Git投影不以假receipt登记权威')
})

test('AC-APPLICATION-P4-15 旧非null源码bytehead不重开已完整消费的同一输入', async t => {
  const f = await exportApplicationFixture(t), old = await captureInputSnapshot(f.root)
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// already consumed author source\n`)
  const input = await captureInputSnapshot(f.root), frozen = await f.application['freezeNodePlan'](input, 'export-contract')
  writeFileSync(join(f.root, f.path), `${f.original}\n本轮已读取作者源码，原业务规则保持。\n`)
  const delivery = await captureInputSnapshot(f.root)
  writeFileSync(join(f.root, f.path), f.original)
  const bytePair: BaselinePair = { id: 'fixture-old-byte', source: old.source, repositoryId: old.source.repositoryId, sourceInput: old, verifiedDelivery: old, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-old-byte-projection-only', settledAtMs: Date.now() }
  const intentPair: BaselinePair = { id: 'fixture-consumed-intent', source: input.source, repositoryId: input.source.repositoryId, sourceInput: input, verifiedDelivery: delivery, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-intent-projection-only', settledAtMs: Date.now() }
  const { digest: _digest, ...body } = frozen.selection
  const selected = { ...body, bindings: body.bindings.map(binding => 'intentPair' in binding ? { ...binding, intentPair } : binding.resource.path === 'src/export.js' ? { ...binding, bytePair } : binding) }
  const selection = { ...selected, digest: contentHash(JSON.stringify(selected, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
  const changes = async () => {
    const snapshot = await captureInputSnapshot(f.root), composed = composeAuthoredInput(snapshot, selection, { executionPaths: frozen.plan.executionScope!.paths, contextPaths: frozen.plan.readPaths, retainConflicts: true }).composed!
    const evidence = readCompositionEvidence(snapshot, composed, selection)
    return { evidence, difference: f.application['observationChanges'](snapshot, frozen.plan, selection, evidence) }
  }
  const unchanged = await changes()
  assert.ok(unchanged.evidence.paths.find(item => item.path === 'src/export.js')!.base)
  assert.ok(unchanged.evidence.intents.every(item => !item.changed))
  assert.equal(unchanged.difference.changed, false, '同一已消费源码不能因旧非null字节头重复自动准入')
  f.application['freezeNodePlan'] = async () => ({ plan: frozen.plan, selection })
  f.application['ownsObservation'] = () => true
  let dispatched = 0
  f.application.start = () => { dispatched++ }
  await f.application['observeNode'](input, 'export-contract')
  await f.application['observeNode'](input, 'export-contract')
  assert.equal(f.application.store.listOperations(input.source.repositoryId).length, 0)
  assert.equal(dispatched, 0)
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// new author source not consumed\n`)
  assert.equal((await changes()).difference.codeChanged, true)
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// already consumed author source\n`)
  writeFileSync(join(f.root, f.path), f.original.replace(parseParts(f.original)!.rawSource!, `${parseParts(f.original)!.rawSource!}\n新增原始义务。`))
  assert.equal((await changes()).difference.specChanged, true)
  assert.equal(f.calls(), 0, '只读投影不登记假receipt或调用模型')
})

test('AC-APPLICATION-P4-13 Spec无bytehead时按真实intent来源字节识别已消费与新原始意图', async t => {
  const f = await exportApplicationFixture(t)
  const before = await captureInputSnapshot(f.root)
  const frozen = await f.application['freezeNodePlan'](before, 'export-contract')
  writeFileSync(join(f.root, 'src/export.js'), `${f.originalCode}\n// fixture verified delivery\n`)
  const delivery = await captureInputSnapshot(f.root)
  writeFileSync(join(f.root, 'src/export.js'), f.originalCode)
  const pair: BaselinePair = { id: 'fixture-intent-consumption', source: before.source, repositoryId: before.source.repositoryId, sourceInput: before, verifiedDelivery: delivery, coveredScope: frozen.plan.executionScope!, receiptId: 'fixture-projection-only', settledAtMs: Date.now() }
  const { digest: _digest, ...payload } = frozen.selection
  const selectionPayload = { ...payload, bindings: payload.bindings.map(binding => 'intentPair' in binding ? { ...binding, intentPair: pair } : binding.resource.path === 'src/export.js' ? { ...binding, bytePair: pair } : binding) }
  const selection = { ...selectionPayload, digest: contentHash(JSON.stringify(selectionPayload, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
  const changes = async () => {
    const snapshot = await captureInputSnapshot(f.root)
    const composed = composeAuthoredInput(snapshot, selection, { executionPaths: frozen.plan.executionScope!.paths, contextPaths: frozen.plan.readPaths, retainConflicts: true }).composed!
    const evidence = readCompositionEvidence(snapshot, composed, selection)
    return { evidence, difference: f.application['observationChanges'](snapshot, frozen.plan, selection, evidence) }
  }
  const unchanged = await changes()
  assert.equal(unchanged.evidence.paths.find(path => path.path === f.path)?.base, null)
  assert.equal(unchanged.evidence.intents.every(intent => !intent.changed), true)
  assert.equal(unchanged.difference.changed, false)
  writeFileSync(join(f.root, f.path), f.original.replace(parseParts(f.original)!.rawSource!, `${parseParts(f.original)!.rawSource!}\n新增原始义务。`))
  assert.equal((await changes()).difference.changed, true, '只有raw变化也必须保留')
  writeFileSync(join(f.root, f.path), f.original.replaceAll('RULE-EXPORT-06', 'RULE-EXPORT-NEW'))
  assert.equal((await changes()).difference.changed, true, '旧ID退役不能因其他已消费ID被忽略')
  writeFileSync(join(f.root, f.path), f.original)
  renameSync(join(f.root, f.path), join(f.root, '.spec/project/export-contract/moved.md'))
  assert.equal((await changes()).difference.changed, true, '原owner消失必须保留')
  assert.equal(f.calls(), 0, '投影夹具不登记receipt或调用模型')
})

test('AC-APPLICATION-P4-12 同request不能换授权子节点，重新授权配置不能复用旧计划', async () => {
  const f = await fixture()
  try {
    mkdirSync(join(f.root, '.spec/demo/child'))
    writeFileSync(join(f.root, '.spec/demo/child/spec.md'), source.replace('Demo', 'Child'))
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'frozen-plan', origin: 'initial' as const }
    const admitted = await f.application.submit(request); assert.ok(admitted.operation)
    const original = await f.application.wait(admitted.operation.id)
    assert.equal(original.operation.phase, 'failed')
    const firstCalls = f.calls.length
    assert.ok(firstCalls > 0)
    await assert.rejects(f.application.submit({ ...request, nodeId: 'child' }), /SYNC_IDEMPOTENCY_CONFLICT/)
    assert.equal((await f.application.status()).operations.length, 1)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, budget: { ...settings.budget, maxCalls: 6 } } }))
    f.git(['add', '.']); f.git(['commit', '-qm', 'authorize committed budget'])
    await f.application.enable()
    const detail = await f.application.readOperation(original.operation.id)
    assert.equal(detail.retryEligibility.eligible, false)
    assert.equal(detail.retryEligibility.reason?.code, 'sync_configuration_changed')
    await assert.rejects(f.application.submit(request), /原操作的可信配置已变化/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'new-budget', retryOf: original.operation.id }), /原操作的可信配置已变化/)
    assert.equal(f.calls.length, firstCalls)
  } finally { await f.application.stopService(); f.cleanup() }
})

test('AC-APPLICATION-P4-10 活动native时物理暂停保operation控制，暂停编辑恢复先采用最新输入', async () => {
  let held = true
  const f = await fixture(settings, async request => {
    if (held) {
      held = false
      await new Promise<never>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('测试native已响应物理暂停')), { once: true }))
    }
    throw Object.assign(new Error('受控生成环境故障'), { code: 'unsupported' })
  })
  try {
    await f.application.enable(); await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
    await observeUntil(() => {
      if (f.calls.length > 0) return true
      const operations = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)
      for (const operation of operations) assert.notEqual(operation.phase, 'failed', JSON.stringify(f.application.store.listAttempts(operation.id).map(attempt => attempt.failure)))
      return false
    }, 30000)
    const active = (await f.application.status()).operations[0].operation
    await f.application.automaticControl('pause')
    await f.application.wait(active.id)
    assert.equal(f.application.store.readOperation(active.id).control, 'run')
    assert.equal((await f.application.readOperation(active.id)).physicalControl.control, 'pause')
    const first = f.application.observationStatus().latestSnapshot!.id, firstCalls = f.calls.length
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, firstCalls)
    writeFileSync(join(f.root, '.spec/demo/spec.md'), source.replace('返回用户指定的文本。', '返回用户指定的文本并记录确认。'))
    f.git(['add', '.']); f.git(['commit', '-qm', 'paused changed intent'])
    await observeUntil(() => f.application.observationStatus().latestSnapshot?.id !== first)
    const latest = f.application.observationStatus().latestSnapshot!.id
    assert.equal(f.calls.length, firstCalls)
    await f.application.automaticControl('resume')
    const newest = (await f.application.status()).operations.find(item => item.operation.input.id === latest)?.operation
    assert.ok(newest, '恢复应先准入最新冻结输入')
    await f.application.wait(newest.id)
    assert.ok(f.calls.length > firstCalls, JSON.stringify(f.application.store.listAttempts(newest.id).map(attempt => attempt.failure)))
    const resumedCalls = f.calls.length
    assert.equal(new Set(f.calls.map(call => call.requestKey)).size, resumedCalls)
    await f.application.wait(newest.id)
    assert.equal(f.calls.length, resumedCalls, '已失败的最新分区集合重放不重复派发')
    assert.equal(f.application.store.readOperation(active.id).input.id, first)
  } finally { await f.application.stopService(); f.cleanup() }
})


test('AC-APPLICATION-P4-11 两个独立节点保存及停机编辑补偿均真实交付，不夹带另一节点未消费输入', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await exportApplicationFixture(t, undefined, undefined, true)
  const paths = ['src/export.js', 'src/other.js']
  for (const path of paths) writeFileSync(join(f.root, path), `// human online ${path}\n${readFileSync(join(f.root, path), 'utf8')}`)
  f.git(['add', '.']); f.git(['commit', '-qm', 'online author inputs'])
  const before = await captureInputSnapshot(f.root), head = f.git(['rev-parse', 'HEAD']), index = readFileSync(join(f.root, '.git/index'))
  await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
  const admitted = (await f.application.status()).operations.map(item => item.operation)
  assert.equal(admitted.length, 2)
  const first = await Promise.all(admitted.map(operation => f.application.wait(operation.id)))
  for (const detail of first) {
    assert.equal(detail.operation.phase, 'workspace_synced', JSON.stringify({ failure: detail.attempt?.failure, blockedReason: detail.operation.blockedReason, journals: detail.journals }))
    assert.ok(detail.journals[0]?.receipt)
    const own = paths.find(path => detail.operation.scope.paths.includes(path))!
    assert.ok(own, '每个独立节点具有其实际授权源码范围')
    assert.equal(detail.operation.input.captureKind, 'commit')
    assert.match(readFileSync(join(detail.operation.deliveryPlan.canonicalRoot, own), 'utf8'), /human online/)
    assert.equal(readFileSync(join(detail.operation.deliveryPlan.canonicalRoot, own), 'utf8'), readFileSync(join(f.root, own), 'utf8'))
    assert.deepEqual(readTree(before.source.commonDir, detail.journals[0].receipt.actualTree).filter(entry => !entry.path.startsWith('.spec/')), readTree(before.source.commonDir, detail.attempt!.composedInput!.tree).filter(entry => !entry.path.startsWith('.spec/')))
  }
  const firstPublication = [...first].sort((a, b) => a.journals[0].receipt!.completedAtMs - b.journals[0].receipt!.completedAtMs)[0]
  const firstOther = paths.find(path => !firstPublication.operation.scope.paths.includes(path))!
  const firstOtherSpec = firstOther === 'src/export.js' ? f.path : '.spec/project/other-contract/spec.md'
  assert.deepEqual(readTree(before.source.commonDir, firstPublication.journals[0].receipt!.actualTree).find(entry => entry.path === firstOtherSpec), readTree(before.source.commonDir, before.immutableTree).find(entry => entry.path === firstOtherSpec))
  assert.equal(firstPublication.operation.deliveredScope.paths.includes(firstOtherSpec), false)
  assert.equal((await captureInputSnapshot(f.root)).id, before.id)
  await f.application.stopService()
  const count = f.calls()
  for (const path of paths) writeFileSync(join(f.root, path), `// human offline ${path}\n${readFileSync(join(f.root, path), 'utf8')}`)
  f.git(['add', '.']); f.git(['commit', '-qm', 'offline author inputs'])
  const latest = await captureInputSnapshot(f.root)
  assert.equal(f.calls(), count)
  await f.application.startService({ compensationMs: 10000, debounceMs: 5 })
  const successors = (await f.application.status()).operations.map(item => item.operation).filter(operation => !admitted.some(prior => prior.id === operation.id))
  assert.equal(successors.length, 2)
  const delivered = await Promise.all(successors.map(operation => f.application.wait(operation.id)))
  for (const detail of delivered) {
    assert.equal(detail.operation.phase, 'workspace_synced', JSON.stringify({ failure: detail.attempt?.failure, blockedReason: detail.operation.blockedReason, journals: detail.journals }))
    assert.ok(detail.journals[0]?.receipt)
    const own = paths.find(path => detail.operation.scope.paths.includes(path))!
    assert.match(readFileSync(join(detail.operation.deliveryPlan.canonicalRoot, own), 'utf8'), /human offline/)
    assert.match(readFileSync(join(detail.operation.deliveryPlan.canonicalRoot, own), 'utf8'), /human online/)
    assert.equal(readFileSync(join(detail.operation.deliveryPlan.canonicalRoot, own), 'utf8'), readFileSync(join(f.root, own), 'utf8'))
    assert.deepEqual(readTree(before.source.commonDir, detail.journals[0].receipt.actualTree).filter(entry => !entry.path.startsWith('.spec/')), readTree(before.source.commonDir, detail.attempt!.composedInput!.tree).filter(entry => !entry.path.startsWith('.spec/')))
  }
  const firstCompensation = [...delivered].sort((a, b) => a.journals[0].receipt!.completedAtMs - b.journals[0].receipt!.completedAtMs)[0]
  const unconsumedOther = paths.find(path => !firstCompensation.operation.scope.paths.includes(path))!
  const unconsumedOtherSpec = unconsumedOther === 'src/export.js' ? f.path : '.spec/project/other-contract/spec.md'
  const previousCanonical = [...first].sort((a, b) => b.journals[0].receipt!.completedAtMs - a.journals[0].receipt!.completedAtMs)[0].journals[0].receipt!.actualTree
  assert.deepEqual(readTree(before.source.commonDir, firstCompensation.journals[0].receipt!.actualTree).find(entry => entry.path === unconsumedOtherSpec), readTree(before.source.commonDir, previousCanonical).find(entry => entry.path === unconsumedOtherSpec))
  assert.equal(firstCompensation.operation.deliveredScope.paths.includes(unconsumedOtherSpec), false)
  assert.equal((await captureInputSnapshot(f.root)).id, latest.id)
  assert.equal(f.nativeRequests.some(request => request.purpose === 'code_generate'), false)
  assert.notEqual(f.git(['rev-parse', 'HEAD']), head); assert.notDeepEqual(readFileSync(join(f.root, '.git/index')), index)
})

function governDemoDependencies(f: Awaited<ReturnType<typeof fixture>>, related: readonly string[]): void {
  const fixtureRoot = 'spec-cli/test/fixtures/spec-sync/export-repo'
  const contractSource = readFileSync(join(fixtureRoot, '.spec/export/export-contract/spec.md'), 'utf8')
    .replaceAll('EXPORT', 'DEMO').replaceAll('export-contract', 'demo').replaceAll('src/export.js', 'src/demo.mjs').replaceAll('tests/export.test.mjs', 'tests/demo.test.mjs').replace(' | 10000 |', ' | 1000 |')
    .replace('code:\n', `related:\n${related.map(path => `  - ${path}`).join('\n')}\ncode:\n`)
  const parsed = parseContract({ nodeId: 'demo', path: '.spec/demo/spec.md', source: contractSource })
  assert.ok(parsed.contract); assert.deepEqual(parsed.findings, [])
  writeFileSync(join(f.root, '.spec/demo/spec.md'), contractSource)
  writeFileSync(join(f.root, 'src/demo.mjs'), readFileSync(join(fixtureRoot, 'src/export.js'), 'utf8'))
  writeFileSync(join(f.root, 'tests/demo.test.mjs'), readFileSync(join(fixtureRoot, 'tests/export.test.mjs'), 'utf8').replaceAll('EXPORT', 'DEMO').replaceAll('../src/export.js', '../src/demo.mjs'))
}

test('旧failed计划retry读集变更拒绝，fresh正式操作冻结owned只读闭包且依赖变化仍过期', async t => {
  for (const committed of [false, true]) await t.test(committed ? 'commit冻结HEAD' : 'observed冻结输入', async () => {
    const f = await fixture({ ...settings, sourcePaths: ['src/demo.mjs'] })
    try {
      f.application.start = () => {}
      const targetPath = '.spec/demo/spec.md', dependencyPath = 'src/cli.mjs', absentPath = 'src/missing-dependency.mjs'
      const dependency = 'export const cli = "frozen CLI body"\n'
      governDemoDependencies(f, [dependencyPath, absentPath, 'src/related/*.mjs', 'docs/'])
      assert.ok(parseContract({ nodeId: 'demo', path: targetPath, source: readFileSync(join(f.root, targetPath), 'utf8') }).contract?.related.includes(dependencyPath))
      writeFileSync(join(f.root, dependencyPath), dependency)
      f.git(['add', '.']); f.git(['commit', '-qm', 'fixture: owned related dependency'])
      await f.application.enable()
      mkdirSync(join(f.root, 'src/related'), { recursive: true })
      const snapshot = await captureInputSnapshot(f.root, { committed })
      const plan = await buildSyncApplicationPlan(snapshot, 'demo')
      // 历史计划在修复前已持久化：owned related存在于冻结树，但旧readPaths漏读。
      plan.readPaths = [targetPath, '.spec/spexcode.json', 'src/demo.mjs', 'tests/demo.test.mjs', 'package.json']
      const selected = f.application.store.readBaselineSelection(snapshot.source, await deriveSyncBaselineResources(snapshot, plan))
      assert.ok('selection' in selected)
      const baselineSelection = selected.selection
      assert.equal(baselineSelection.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === dependencyPath), false)
      const paths = [...new Set([...plan.readPaths, ...plan.executionScope.paths])].sort()
      const oldComposed = composeAuthoredInput(snapshot, baselineSelection, { retainConflicts: true, executionPaths: plan.executionScope.paths, contextPaths: paths }).composed!
      const entries = readTree(snapshot.source.commonDir, oldComposed.tree)
      const withinRead = (path: string): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
      const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
      const oldReadSetDigest = contentHash(canonical({ baseline: { selectionDigest: baselineSelection.digest }, compositionEvidence: oldComposed.compositionEvidenceBlob ?? null, declared: paths, entries: entries.filter(entry => withinRead(entry.path)), absent: paths.filter(path => !entries.some(entry => entry.path === path || entry.path.startsWith(`${path}/`))) }))
      const options = { ingressKey: 'historical-missing-owned-read', rootCauseId: 'historical-missing-owned-read', origin: 'spec' as const, budget: settings.budget, managedRoot: f.application['managedRoot'], baselineSelection }
      assert.ok(ownedObligationPaths(plan.targets, plan.executionScope.paths, new Map([[targetPath, readFileSync(join(f.root, targetPath), 'utf8')]]), readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => entry.path)).includes(dependencyPath))
      const currentAdmission = await prepareSyncAdmission(snapshot, plan, options)
      const historicalAdmission = { ...currentAdmission, readSetDigest: oldReadSetDigest, impactDigest: contentHash(canonical({ targets: plan.targets, scope: plan.executionScope, writePaths: [...new Set(plan.writePaths)].sort(), readSetDigest: oldReadSetDigest })) }
      f.application['prepareTools'](historicalAdmission.ingressKey, null)
      const admitted = f.application.store.admitAndEnqueue(historicalAdmission)
      const ack = f.application.store.ackDispatch(snapshot.source.repositoryId, admitted.dispatchMessageId)
      const claim = f.application.store.claimQueuedAttempt({ operationId: admitted.id, source: snapshot.source, scope: admitted.scope, expectedRevision: ack.revision, leaseMs: 60000 })
      f.application.store.bindComposedInput(claim.fence, oldComposed)
      f.application.store.recordFailure(claim.fence, { code: 'input_invalid', message: `模型读集合缺少契约引用的完整来源/验收文件: ${dependencyPath}`, kind: 'unsupported', evidenceRefs: [] })
      const original = f.application.store.readOperation(admitted.id)
      const detail = await f.application.readOperation(original.id)
      assert.equal(detail.stale, false); assert.equal(detail.retryEligibility.eligible, true)
      assert.notEqual(currentAdmission.readSetDigest, original.readSetDigest)
      const dispatchBefore = f.application.store.nextDispatch(snapshot.source.repositoryId)
      await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'owned-dependency-retry', retryOf: original.id }), /SYNC_RETRY_BINDING/)
      assert.deepEqual(f.application.store.nextDispatch(snapshot.source.repositoryId), dispatchBefore)
      assert.deepEqual(f.application.store.readOperation(original.id), original, '历史failed记录和原读证明不可补签')
      const retried = (await f.application.submit({ nodeId: 'demo', requestId: 'owned-dependency-fresh' })).operation!
      const freshPlan = f.application['operationPlan'](retried)
      assert.notEqual(retried.id, original.id); assert.equal(retried.retryOf, undefined)
      assert.notEqual(retried.readSetDigest, original.readSetDigest)
      assert.notEqual(retried.policyDigest, original.policyDigest, 'fresh正式操作冻结新的完整规划，不替旧retry重签')
      const freshAdmission = await prepareSyncAdmission(retried.input, freshPlan, { ...options, baselineSelection: retried.baselineSelection!, executionScope: retried.scope })
      assert.equal(retried.readSetDigest, freshAdmission.readSetDigest)
      assert.deepEqual(retried.scope, original.scope)
      assert.equal(retried.input.immutableTree, original.input.immutableTree); assert.equal(retried.input.headCommit, original.input.headCommit); assert.deepEqual(retried.input.source, original.input.source)
      assert.deepEqual(freshPlan.targets, plan.targets)
      assert.equal(retried.scope.paths.some(path => dependencyPath === path || dependencyPath.startsWith(`${path}/`)), false)
      const retained = f.application.store.readOperation(original.id)
      assert.equal(retained.phase, 'superseded', 'fresh操作沿既有生命周期取代旧failed操作')
      for (const key of ['input', 'planBlob', 'policyDigest', 'readSetDigest', 'baselineSelection', 'payloadDigest'] as const) assert.deepEqual(retained[key], original[key])
      const frozenDependency = readTree(snapshot.source.commonDir, retried.input.immutableTree).find(entry => entry.path === dependencyPath)!
      assert.equal(readObject(snapshot.source.commonDir, frozenDependency.oid).toString('utf8'), dependency)
      const retryAck = f.application.store.ackDispatch(snapshot.source.repositoryId, retried.dispatchMessageId)
      const retryClaim = f.application.store.claimQueuedAttempt({ operationId: retried.id, source: snapshot.source, scope: retried.scope, expectedRevision: retryAck.revision, leaseMs: 60000 })
      const derivedReadPaths = [...new Set([...freshPlan.readPaths, ...retried.scope.paths])].sort()
      const currentComposed = composeAuthoredInput(retried.input, retried.baselineSelection!, { retainConflicts: true, executionPaths: retried.scope.paths, contextPaths: derivedReadPaths }).composed!
      const retryAttempt = f.application.store.bindComposedInput(retryClaim.fence, currentComposed)
      assert.throws(() => assemblePublicationBase(f.application.store, retried, retryAttempt, currentComposed, paths), /read closure differs/)
      const publication = assemblePublicationBase(f.application.store, retried, retryAttempt, currentComposed, derivedReadPaths)
      const provenance = verifyPublicationBase(retried, retryAttempt, publication)
      assert.deepEqual(provenance.readPaths, derivedReadPaths)
      assert.equal(provenance.writePaths.includes(dependencyPath), false)
      f.application.store.startGeneration(retryClaim.fence)
      const frozenAttempt = f.application.store.bindPublicationBase(retryClaim.fence, publication)
      const readHeads = f.application.store.readPublicationHeads
      f.application.store.readPublicationHeads = () => assert.fail('恢复已冻结base不得读取新的publication frontier')
      try { assert.deepEqual(assemblePublicationBase(f.application.store, retried, frozenAttempt, currentComposed, derivedReadPaths), publication) }
      finally { f.application.store.readPublicationHeads = readHeads }
      assert.deepEqual(readTree(snapshot.source.commonDir, publication.parentTree).find(entry => entry.path === dependencyPath), frozenDependency)
      assert.equal(readTree(snapshot.source.commonDir, publication.parentTree).some(entry => entry.path === absentPath), false)
      const changedBytes = Buffer.from('forged readonly dependency\n')
      for (const changedPath of [dependencyPath, absentPath]) {
        const changedEntries = readTree(snapshot.source.commonDir, publication.composed.tree).filter(entry => entry.path !== changedPath)
        changedEntries.push({ path: changedPath, mode: '100644', oid: writeObject(snapshot.source.commonDir, changedBytes), digest: contentHash(changedBytes) })
        const tree = writeTree(snapshot.source.commonDir, changedEntries), forgedEntries = readTree(snapshot.source.commonDir, tree)
        const forgedComposed = { ...publication.composed, tree, manifestBlob: writeEvidence(snapshot.source.commonDir, { version: 1, entries: forgedEntries }), contentDigest: contentHash(JSON.stringify(forgedEntries)) }
        const forged = { ...publication, composed: forgedComposed, provenanceBlob: writeEvidence(snapshot.source.commonDir, { ...provenance, composed: forgedComposed }) }
        assert.throws(() => verifyPublicationBase(retried, retryAttempt, forged), /actual publication images differ/)
      }
      f.application.store.recordFailure(retryClaim.fence, { code: 'offline_fixture_complete', message: '仅验证冻结读取和发布保护，未派发模型', kind: 'unsupported', evidenceRefs: [] })
      const indexOnlyPath = 'src/related/index-only.mjs'
      writeFileSync(join(f.root, indexOnlyPath), 'export const indexOnly = true\n')
      f.git(['add', indexOnlyPath]); rmSync(join(f.root, indexOnlyPath))
      const currentOperationId = committed ? original.id : retried.id
      const indexOnly = await f.application.readOperation(currentOperationId)
      assert.equal(indexOnly.stale, !committed, 'observed须保护index-only新glob成员，commit仍只冻结HEAD')
      if (!committed) assert.equal(indexOnly.retryEligibility.eligible, false)
      f.git(['reset', '-q', 'HEAD', '--', indexOnlyPath])
      assert.equal((await f.application.readOperation(currentOperationId)).stale, false)
      writeFileSync(join(f.root, dependencyPath), 'export const cli = "later index body"\n')
      if (committed) {
        f.git(['add', dependencyPath])
        writeFileSync(join(f.root, dependencyPath), 'export const cli = "later WIP body"\n')
        const dirty = await f.application.readOperation(currentOperationId)
        assert.equal(dirty.stale, false, 'commit操作只比较HEAD，不把后来的index/WIP送进模型；superseded不改变读取当前性的判据')
        assert.equal(readObject(snapshot.source.commonDir, frozenDependency.oid).toString('utf8'), dependency)
        f.git(['commit', '-qm', 'fixture: real committed dependency change'])
      }
      const stale = await f.application.readOperation(currentOperationId)
      assert.equal(stale.stale, true); assert.equal(stale.retryEligibility.eligible, false)
      await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'changed-owned-dependency-retry', retryOf: retried.id }), /原输入已变化/)
      assert.equal(f.calls.length, 0)
    } finally { await f.application.stopService(); f.cleanup() }
  })
})

test('冻结snapshot的untracked related glob完整正文进入真实分派投影且不授写权', async () => {
  const f = await fixture({ ...settings, sourcePaths: ['src/demo.mjs'] })
  try {
    const targetPath = '.spec/demo/spec.md', dependencyPath = 'src/related/original.mjs'
    const body = 'export const original = "frozen untracked dependency"\n'
    governDemoDependencies(f, ['src/related/*.mjs'])
    f.git(['add', '.']); f.git(['commit', '-qm', 'fixture: owned glob dependency'])
    mkdirSync(join(f.root, 'src/related'), { recursive: true }); writeFileSync(join(f.root, dependencyPath), body)
    await f.application.enable()
    const snapshot = await captureInputSnapshot(f.root)
    const plan = await buildSyncApplicationPlan(snapshot, 'demo', undefined, { direction: 'combined' })
    plan.readPaths = [targetPath, '.spec/spexcode.json', 'src/demo.mjs', 'tests/demo.test.mjs', 'package.json']
    const selected = f.application.store.readBaselineSelection(snapshot.source, await deriveSyncBaselineResources(snapshot, plan))
    assert.ok('selection' in selected)
    assert.ok(parseContract({ nodeId: 'demo', path: targetPath, source: readFileSync(join(f.root, targetPath), 'utf8') }).contract?.related.includes('src/related/*.mjs'))
    const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey: 'untracked-owned-dependency', rootCauseId: 'untracked-owned-dependency', origin: 'combined', budget: settings.budget, managedRoot: f.application['managedRoot'], baselineSelection: selected.selection })
    f.application['prepareTools'](admission.ingressKey, null)
    const admitted = f.application.store.admitAndEnqueue(admission)
    f.application.start(admitted.id)
    const failed = await f.application.wait(admitted.id)
    assert.equal(failed.operation.phase, 'failed', JSON.stringify(failed.attempt?.failure))
    assert.equal(f.calls.length, 1, '必须跨过冻结读取门进入真实分派，而非因HEAD缺少untracked成员在模型前失败')
    const frozen = readFrozenBehaviorContext<{ composedFiles: [string, string][] }>(f.calls[0])
    assert.equal(new Map(frozen.composedFiles).get(dependencyPath), body)
    const composed = failed.attempt!.composedInput!, original = readTree(admitted.input.source.commonDir, admitted.input.immutableTree).find(entry => entry.path === dependencyPath)!
    assert.deepEqual(readTree(admitted.input.source.commonDir, composed.tree).find(entry => entry.path === dependencyPath), original)
    assert.equal(admitted.scope.paths.some(path => dependencyPath === path || dependencyPath.startsWith(`${path}/`)), false)
    assert.equal(readFileSync(join(f.root, dependencyPath), 'utf8'), body)
    assert.equal(f.git(['ls-files', '--', dependencyPath]), '')
  } finally { await f.application.stopService(); f.cleanup() }
})

test('新原生操作缺省优先Claude配置，重放和省略retry保持原请求选择', async () => {
  const f = await fixture(settings, undefined, true)
  try {
    await f.application.enable()
    await f.application.automaticControl('pause')
    const first = (await f.application.submit({ nodeId: 'demo', requestId: 'native-cli-default' })).operation!
    assert.equal(first.model, 'claude:default')
    assert.equal((JSON.parse(readEvidence(first.input.source.commonDir, first.planBlob!).toString()) as SyncCoordinatorPlan).agentWorkflow, 'native-worktree-v1')
    const saved = JSON.parse(readFileSync(join(f.temp, 'runtime', 'artifacts', `application-runtime-${contentHash(first.ingressKey)}.json`), 'utf8')) as { version: string; model: string }
    assert.deepEqual({ version: saved.version, model: saved.model }, { version: 'sync-tools-v3', model: 'claude:default' })
    assert.equal((await f.application.submit({ nodeId: 'demo', requestId: 'native-cli-default' })).operation!.id, first.id)
    await f.application.control(first.id, 'cancel')
    const retry = (await f.application.submit({ nodeId: 'demo', requestId: 'native-cli-default-retry', retryOf: first.id })).operation!
    assert.equal(retry.model, 'claude:default')
    assert.equal(retry.callsUsed, 0)
    assert.equal(f.calls.length, 0)
    await f.application.control(retry.id, 'cancel')
  } finally { await f.application.stopService(); f.cleanup() }
})

test('新操作默认冻结native worktree计划与v3工具，旧frozen模型不被静默执行', async () => {
  const f = await fixture({ ...settings, model: 'claude:MiniMax-M3.1-Flash' }, undefined, true)
  try {
    await f.application.enable()
    await f.application.automaticControl('pause')
    const operation = (await f.application.submit({ nodeId: 'demo', requestId: 'native-worktree-default' })).operation!
    const plan = JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob!).toString()) as { agentWorkflow?: string }
    assert.equal(plan.agentWorkflow, 'native-worktree-v1')
    const saved = JSON.parse(readFileSync(join(f.temp, 'runtime', 'artifacts', `application-runtime-${contentHash(operation.ingressKey)}.json`), 'utf8')) as { version: string; model: string; agentWorkflow: string }
    assert.deepEqual({ version: saved.version, model: saved.model, agentWorkflow: saved.agentWorkflow }, { version: 'sync-tools-v3', model: 'claude:MiniMax-M3.1-Flash', agentWorkflow: 'native-worktree-v1' })
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'unsupported-native-model', model: 'gpt-6.1-sol' }), { code: 'unsupported' })
    assert.equal(f.application.store.findOperationByIngressKey(`application:${operation.input.source.repositoryId}:${f.root}:unsupported-native-model`), null)
    await f.application.control(operation.id, 'cancel')
  } finally { await f.application.stopService(); f.cleanup() }
})
