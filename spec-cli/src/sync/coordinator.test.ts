import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { putBlob, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { authenticateNativeRejectedFinal, readSyncCheckpoints, readSyncCheckpointStageIndex, syncCheckpointArtifacts, withCheckpointStageBasis } from './checkpoint-evidence.js'
import { outputErrors } from './elaboration-schema.js'
import type { ContractCell, GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { sameContractBusinessMeaning } from './contract-evolution.js'
import { ELABORATION_BOUNDARIES, ELABORATION_GENERATION_GUIDANCE, ELABORATION_GENERATION_GUIDANCE_V3, ELABORATION_GENERATION_GUIDANCE_V4 } from './elaboration-types.js'
import { elaborate, freezeElaborationInput, hasApprovedElaborationReview } from './elaboration.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import type { ElaborationDraft, ElaborationInput, ElaborationResult, ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult, ReadonlySpecRepair } from './elaboration-types.js'
import { buildSyncApplicationPlan } from './planning.js'
import { restoreGenerationInput } from './generation.js'
import { CODE_BEHAVIOR_GUIDANCE_VERSION } from './code-behavior.js'
import { SyncApplication } from './application.js'
import * as continuationCoordinator from './coordinator.js'
import { acceptedCandidateReviewSource, isSyncInputCurrent, prepareSyncAdmission, readCurrentSyncAnalysis, readonlySpecRepairStalled, recoverSyncOperationResources, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import type { BlobRef, SyncAttempt, SyncOperation } from './operation-types.js'
import { migrateSyncStore, SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress } from './migrations.js'
import { dockerVerificationDriver, verificationExportDigest } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationCommandResult, VerificationDriver, VerificationRequest } from './verification-executor-types.js'
import { runAttemptVerification } from './verification-run.js'
import { remoteVerificationFixture } from './verification-transport.fixture.test.js'
import { exportCandidate, freezeCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { readCodeBehaviorContext } from './code-behavior.js'
import { createAttemptRunner, type NativeRunCheckpoint, type NativeRunPlan, type NativeRunRecord } from './native-run.js'
import { SyncStore } from './store.js'
import { sessionIdForCreateKey, closeSession } from '../sessions.js'
import { configuredSessionApplication, withoutSessionApplicationExecutionWake } from '../session-application.js'
import { readRecord, writeRecord } from '../session-record.js'
import { claimFileMutex } from './file-mutex.js'
import { composeAuthoredInput } from './author-input.js'
import { controlledDecisionIdentity, guardControlledRequestPath, prepareControlledDecision, prepareControlledRequest } from './request-input.js'
import { prepareSpecBodyEdit } from '../spec-body-edit.js'
import { adaptElaborationNativeOutput } from '../../test/elaboration-native-output.js'
import { pinZCodeToolPolicy, rejectedFinalOutput, StructuredSessionError, structuredExecutionPolicy } from '../session-structured-policy.js'
import { nativeWorktreePrompt, nativeWorktreeResult, sampleNativeWorktreeProcesses } from '../native-worktree-runtime.js'
import { cancelStructuredSession, SettledSessionCreateTimeoutError } from '../session-structured.js'
import { freezeContext, prepareFrozenPrompt } from '../frozen-context.js'
import { retainHistoricalFrozenWorkflow } from './historical-workflow.test-helpers.js'
import { stopZCodeStructuredTurn, zcodeCapability, zcodeNativeConfigSelection, zcodeNativeSelection, type ZCodeStructuredExecution } from '../zcode-structured.js'

function nativeTask(request: ElaborationSessionRequest, commonDir: string): Record<string, unknown> {
  return request.purpose.startsWith('code_behavior_') ? readCodeBehaviorContext(request, commonDir).task : JSON.parse(request.prompt.split('任务:\n')[1].split('\n')[0]) as Record<string, unknown>
}

function inlineBehaviorPrompt(request: ElaborationSessionRequest, commonDir: string): string {
  const { task, pendingAnalysis } = readCodeBehaviorContext(request, commonDir)
  const { requiredChangedPaths, ...context } = task
  return `${request.prompt.split('\n任务:\n')[0]}\n冻结三方输入:\n${JSON.stringify({ ...context, changedPaths: requiredChangedPaths })}${pendingAnalysis ? `\n待审分析:\n${JSON.stringify(pendingAnalysis)}` : ''}`
}

const contractPath = '.spec/project/export-contract/spec.md'
const fixturePath = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const original = readFileSync(new URL('.spec/export/export-contract/spec.md', fixturePath), 'utf8')
function rows(source: string, path = contractPath): GeneratedElaboration {
  const contract = parseContract({ nodeId: 'export-contract', path, source }).contract!
  const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
    const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
    const value = (item as unknown as Record<string, ContractCell>)[key]
    return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
  })))])) as GeneratedTables
  return { version: 'elaboration-rows-v2', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(source).fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(source)!.expandedSpec.split(/^### /m)[0], tables, removeIds: [] }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定演示夹具的显式业务政策和原始范围', affectedIds: ['REQ-EXPORT-01'] })) }
}

test('历史checkpoint的相同SHA只解码一次，每次仍核CAS且返回独立对象', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-decode-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const store = {} as SyncStore, operation = { id: 'history-operation', input: { id: 'input', source: { commonDir } }, policyDigest: 'policy' } as SyncOperation
  const attempts = Array.from({ length: 14 }, (_, index) => {
    const attempt = { id: `history-${index}`, checkpointRefs: [] } as unknown as SyncAttempt
    for (let owner = 0; owner < (index === 13 ? 63 : 64); owner++) {
      const value = { checkpointHistoryFixture: true, index, owner, material: Array.from({ length: 64 }, (_, row) => ({ row, text: '完整历史材料' })) }
      const resultRef = writeEvidence(commonDir, value)
      attempt.checkpointRefs.push({ ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, policyDigest: operation.policyDigest, stage: `history:${owner}`, resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
    }
    return attempt
  })
  const hashes = new Set(attempts.flatMap(attempt => attempt.checkpointRefs.flatMap(ref => [ref.sha256, ...ref.artifacts!.map(artifact => artifact.ref.sha256)])))
  const texts = new Set([...hashes].map(sha256 => readEvidence(commonDir, { sha256 }).toString('utf8')))
  let decodes = 0, casReads = 0
  const read = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => { if (String(args[0]).startsWith(join(commonDir, 'spexcode/evidence') + '/')) casReads++; return read(...args) })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const parse = JSON.parse
  t.mock.method(JSON, 'parse', (text: string, reviver?: (key: string, value: unknown) => unknown) => { if (texts.has(text)) decodes++; return parse(text, reviver) })
  for (const attempt of attempts) readSyncCheckpoints(store, operation, attempt)
  const firstPass = decodes, firstPassReads = casReads
  for (const attempt of attempts) readSyncCheckpoints(store, operation, attempt)
  t.diagnostic(JSON.stringify({ attempts: attempts.length, casObjects: hashes.size, firstPassDecodes: firstPass, repeatedDecodes: decodes - firstPass, firstPassReads, repeatedReads: casReads - firstPassReads }))
  assert.equal(firstPass, hashes.size, '内部MIME判断及root/artifact/inspect不能重复JSON解码')
  assert.equal(decodes, firstPass, '历史重复读取只复用纯解码，不再次解析同SHA')
  assert.equal(firstPassReads, hashes.size, '一次读取快照内root/artifact/inspect共用已经校验的字节')
  assert.equal(casReads - firstPassReads, hashes.size, '下一次扫描仍重读每份当前CAS')

  const attempt = attempts[0], resultRef = attempt.checkpointRefs[0].artifacts![0].ref
  const first = readSyncCheckpoints(store, operation, attempt), original = first.json.find(entry => entry.ref.sha256 === resultRef.sha256)!
  const index = readSyncCheckpointStageIndex(store, operation, attempt)
  assert.deepEqual(index.json.map(entry => entry.ref.sha256), attempt.checkpointRefs.map(ref => ref.sha256).reverse())
  assert.ok(index.json.every(({ value }) => (value as { version?: string }).version === 'sync-stage-v1'))
  assert.equal(index.json.some(entry => entry.ref.sha256 === resultRef.sha256), false)
  const header = index.json[0].value as { stage: string }
  header.stage = '调用者污染'
  assert.equal((readSyncCheckpointStageIndex(store, operation, attempt).json[0].value as { stage: string }).stage, 'history:63')
  const material = original.value as { material: { text: string }[] }
  material.material[0].text = '调用者污染'
  assert.equal((readSyncCheckpoints(store, operation, attempt).json.find(entry => entry.ref.sha256 === resultRef.sha256)!.value as { material: { text: string }[] }).material[0].text, '完整历史材料')
  const next = { ...attempt, checkpointRefs: [] }
  assert.deepEqual(readSyncCheckpoints(store, operation, next).json, [], '当前refs移除后不得沿旧attempt快照暴露材料')
  const falseRole = { ...writeEvidence(commonDir, { diagnostic: '新role不能借缓存取得认证' }), artifacts: [{ kind: 'untrusted_final' as const, ref: resultRef }] }
  assert.throws(() => readSyncCheckpoints(store, operation, { ...attempt, checkpointRefs: [...attempt.checkpointRefs, falseRole] }), { code: 'checkpoint_artifact_binding' })
  assert.throws(() => readSyncCheckpointStageIndex(store, operation, { ...attempt, checkpointRefs: [...attempt.checkpointRefs, falseRole] }), { code: 'checkpoint_artifact_binding' })
  writeFileSync(join(commonDir, 'spexcode/evidence', resultRef.sha256), '{"tampered":true}')
  assert.throws(() => readSyncCheckpoints(store, operation, attempt), /证据摘要不匹配/, '命中解码缓存仍逐次核CAS摘要')
  assert.throws(() => readSyncCheckpointStageIndex(store, operation, attempt), /证据摘要不匹配/, '索引模式仍校验被引用正文')
})

test('历史checkpoint超过解码缓存上界时继续按原件读取', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-decode-bound-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const store = {} as SyncStore, operation = { id: 'history-operation', input: { id: 'input', source: { commonDir } }, policyDigest: 'policy' } as SyncOperation
  const refs = [17, 17, 33].map((mib, index) => writeEvidence(commonDir, { checkpointDecodeBound: index, body: 'x'.repeat(mib * 1024 * 1024) }))
  const parse = JSON.parse
  let decodes = 0
  t.mock.method(JSON, 'parse', (source: string) => {
    if (source.startsWith('{"checkpointDecodeBound":')) decodes++
    return parse(source)
  })
  const scan = (index: number): void => {
    const attempt = { id: `history-${index}`, checkpointRefs: [refs[index]] } as SyncAttempt
    assert.deepEqual(readSyncCheckpointStageIndex(store, operation, attempt).json, [])
  }
  scan(0); scan(0)
  assert.equal(decodes, 1)
  scan(1); scan(0)
  assert.equal(decodes, 3, '累计超出上界释放先前解码')
  scan(2); scan(2)
  assert.equal(decodes, 5, '单份超出上界仍核验并读取')
})

test('内部CAS读取不解码JSON，缺失与不合法SHA继续显式拒绝', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-bytes-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const value = { exact: '原始UTF8字节' }, ref = writeEvidence(commonDir, value), parse = JSON.parse
  let decodes = 0
  t.mock.method(JSON, 'parse', (text: string) => { decodes++; return parse(text) })
  assert.equal(readEvidence(commonDir, ref).toString('utf8'), JSON.stringify(value))
  assert.equal(decodes, 0, '内部CAS读取不需要MIME解析')
  assert.throws(() => readEvidence(commonDir, { sha256: 'f'.repeat(64) }), /缺失证据/)
  assert.throws(() => readEvidence(commonDir, { sha256: '../outside' }), /缺失证据/)
})

test('14attempt/1790CAS历史扫描交还控制，同一30秒fence到达首次受控dispatch', async t => {
  const extra: Record<string, string> = {}, targets = [{ nodeId: 'export-contract', path: contractPath }], sourcePaths = ['src/export.js']
  for (let index = 1; index < 101; index++) {
    const id = `owner-${index}`, path = `.spec/project/module-${index}/${id}/spec.md`, sourcePath = `src/owner-${index}.js`
    extra[path] = `---\ntitle: 历史扫描owner${index}\ncontract-schema: sync-v1\ncode:\n  - ${sourcePath}\n---\n\n## raw source\n\n保留owner${index}的只读实现。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-OWNER${index}-01 | 保留owner${index} | user:raw | 原实现只读 | 实现不变 | - |\n`
    extra[sourcePath] = `export const owner${index} = true\n`
    extra[`tests/owner-${index}.test.mjs`] = 'export const readonlyOracle = true\n'
    targets.push({ nodeId: id, path }); sourcePaths.push(sourcePath)
  }
  const f = await fixture(t, { maxAttempts: 15, maxCalls: 1000, maxRepairs: 14, timeoutMs: 300_000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', targets, sourcePaths, commitTrigger: { before: null, paths: [] }, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 } }, undefined, 'code', 'claude:default', false, extra)
  const composed = composeAuthoredInput(f.input, undefined, { retainConflicts: true }).composed!
  const historyBytes = new Map<string, number>()
  for (let index = 0; index < 14; index++) {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: f.options.leaseMs!, ...(index === 0 ? { expectedMessageId: f.operation.dispatchMessageId } : {}) })
    f.store.bindComposedInput(claimed.fence, composed)
    for (let owner = 0; owner < (index === 13 ? 63 : 64); owner++) {
      const value = { checkpointHistoryFixture: true, index, owner, material: Array.from({ length: 64 }, (_, row) => ({ row, text: '完整历史材料' })) }, resultRef = writeEvidence(f.input.source.commonDir, value)
      const wrapperRef = writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: `history:${owner}`, resultRef })
      f.store.checkpoint(claimed.fence, { ...wrapperRef, artifacts: syncCheckpointArtifacts(value, resultRef) })
      for (const ref of [wrapperRef, resultRef]) historyBytes.set(ref.sha256, readEvidence(f.input.source.commonDir, ref).length)
    }
    f.store.recordFailure(claimed.fence, { code: 'behavior_analysis_invalid', message: `未批准的历史失败${index}`, kind: 'repairable', evidenceRefs: [] })
  }
  const texts = new Set([...historyBytes.keys()].map(sha256 => readEvidence(f.input.source.commonDir, { sha256 }).toString('utf8')))
  const read = fs.readFileSync, parse = JSON.parse, clone = globalThis.structuredClone
  let historicalReads = 0, historicalDecodes = 0, checkpointClones = 0, clonedHistoryBytes = 0, scanHistoryReads = 0, inScan = false
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (historyBytes.has(String(args[0]).slice(-64))) { historicalReads++; if (inScan) scanHistoryReads++ }
    return read(...args)
  }) as typeof fs.readFileSync
  JSON.parse = (text: string, reviver?: (key: string, value: unknown) => unknown) => { if (texts.has(text)) historicalDecodes++; return parse(text, reviver) }
  globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof clone>[1]): unknown => {
    const checkpoint = value as { json?: { ref: { sha256: string } }[]; raw?: unknown }
    if (Array.isArray(checkpoint?.json) && checkpoint.raw instanceof Map) { checkpointClones++; for (const entry of checkpoint.json) clonedHistoryBytes += historyBytes.get(entry.ref.sha256) ?? 0 }
    return clone(value, options)
  }) as typeof structuredClone
  syncBuiltinESMExports()
  t.after(() => { fs.readFileSync = read; JSON.parse = parse; globalThis.structuredClone = clone; syncBuiltinESMExports() })
  const checkpoint = f.store.checkpoint.bind(f.store), renew = f.store.renewLease.bind(f.store)
  let controlOpportunity = false, controlBeforeProtocol = false, partitionCount = 0, dispatches = 0
  const renewals: { at: number; attemptId: string; leaseToken: string }[] = []
  f.store.renewLease = (fence, leaseMs) => { if (inScan) renewals.push({ at: Date.now(), attemptId: fence.attemptId, leaseToken: fence.leaseToken }); return renew(fence, leaseMs) }
  f.store.checkpoint = (fence, ref) => {
    const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string; resultRef: { sha256: string } }
    if (wrapper.stage === 'partition-budget') {
      partitionCount = (JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { partitionCount: number }).partitionCount
      inScan = true; setImmediate(() => { controlOpportunity = true })
    }
    if (wrapper.stage === 'behavior-draft-protocol') { controlBeforeProtocol = controlOpportunity; inScan = false }
    return checkpoint(fence, ref)
  }
  f.options.runner = async request => {
    dispatches++
    const current = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    assert.equal(current.number, 15); assert.equal(current.dispatchPlans.length, 1)
    assert.equal(current.dispatchPlans[0].key, request.requestKey)
    assert.ok(current.expiresAtMs > Date.now(), '首次dispatch必须仍有原有效fence')
    assert.ok(renewals.every(renewal => renewal.attemptId === current.id && renewal.leaseToken === current.leaseToken), '扫描不另建attempt或lease')
    throw Object.assign(new Error('受控runner只证明首次真实reserveDispatch，不调用模型'), { code: 'unsupported' })
  }
  const started = performance.now(), result = await runSyncOperation(f.store, f.operation.id, f.options)
  t.diagnostic(JSON.stringify({ historyAttempts: 14, historyCas: historyBytes.size, partitionCount, leaseMs: f.options.leaseMs, heartbeatMs: f.options.heartbeatMs, controlBeforeProtocol, dispatches, scanRenewals: renewals.length, maximumRenewalGapMs: Math.max(0, ...renewals.slice(1).map((item, index) => item.at - renewals[index].at)), scanHistoryReads, historicalReads, historicalDecodes, checkpointClones, clonedHistoryBytes, coordinatorMs: performance.now() - started, status: result.status, failure: result.failure }))
  assert.equal(historyBytes.size, 1790); assert.equal(partitionCount, 101)
  assert.equal(controlBeforeProtocol, true, 'owner×history及诊断扫描必须在下一阶段前让事件循环处理控制')
  assert.equal(historicalDecodes, historyBytes.size, '全历史协调扫描只解码每份真实CAS一次')
  assert.ok(scanHistoryReads <= 3 * historyBytes.size, `分区间重复验读历史CAS：${scanHistoryReads} > ${3 * historyBytes.size}`)
  assert.equal(dispatches, 1); assert.equal(result.status, 'unsupported')
  assert.equal(f.store.readOperation(f.operation.id).callsUsed, 1)
  assert.equal(f.store.listAttempts(f.operation.id).length, 15)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

const zcodeCompletedRpcCases = (['none', 'request', 'thread', 'turn', 'missing-dispatch-session', 'null-dispatch-thread', 'null-dispatch-turn', 'harness-thread', 'rpc-method', 'unsettled', 'failed-observation', 'rpc-proof', 'stop', 'missing-exit', 'exit', 'idle', 'closed', 'idle-identity', 'no-terminal', 'failed-terminal', 'cancelled-terminal', 'terminal-json', 'terminal-kind', 'session', 'dirty', 'source', 'tests', 'schema', 'version', 'model', 'no-commit', 'fence'] as const).map(defect => ['zcode-completed-rpc', defect] as const)
const zcodeP1CompletedRpcCases = (['none', 'partition', 'rpc-method', 'null-dispatch-thread', 'missing-exit', 'no-terminal', 'failed-terminal', 'cancelled-terminal', 'no-commit', 'dirty', 'source', 'schema'] as const).map(defect => ['zcode-p1-completed-rpc', defect] as const)
const zcodeP1CommittedCases = (['none', 'ordinary-ignored', 'older-physical'] as const).map(defect => ['zcode-p1-transport-committed', defect] as const)
const zcodeP0CommittedCase = ['zcode-new', 'ordinary-ignored'] as const
const zcodeMaterialCases = [...(['zcode-old', 'zcode-new'] as const).flatMap(mode => (['none', 'prior-draft', 'session', 'send', 'turn', 'input', 'query', 'message', 'model', 'worktree', 'stop', 'seed', 'source', 'tests', 'schema', 'scope', 'request', 'exit', 'terminal', 'no-progress-cancelled', 'progress-cancelled', 'fence'] as const).map(defect => [mode, defect] as const)), ['zcode-old', 'no-progress-empty-commit-cancelled'] as const, ...(['sealed-unpublished', 'sealed-tampered', 'sealed-missing-exit', 'sealed-unobserved'] as const).map(defect => ['zcode-old', defect] as const), ['zcode-new', 'failed-observation'] as const, ...(['none', 'no-commit', 'provider-code'] as const).map(defect => ['zcode-transport-git', defect] as const), ['zcode-p1-transport-dirty', 'none'] as const, ...zcodeP1CommittedCases, ...zcodeP1CompletedRpcCases, ...zcodeCompletedRpcCases, ...(['none', 'prior-draft', 'older-physical', 'staged', 'review', 'review-foreign-path', 'session', 'stop', 'seed', 'source', 'tests', 'schema', 'context', 'index', 'scope', 'worktree', 'fence', 'cas', 'missing-exit'] as const).map(defect => ['zcode-dirty', defect] as const), ...(['none', 'prior-draft', 'older-physical', 'missing-exit'] as const).map(defect => ['zcode-p1-dirty', defect] as const)]
for (const [mode, defect] of [['pause', 'archived'], ['native-failure', 'archived'], ['zcode-p1-transport-committed', 'archived'], ['native-failure', 'no-progress-143'], ['native-failure', 'no-progress-143-foreign'], ['native-failure', 'no-progress-143-stop'], ['native-failure', 'no-progress-143-process'], ['native-failure', 'progress-143'], ['native-failure', 'none'], ['native-failure', 'prior-draft'], ['native-failure', 'session'], ['native-failure', 'user'], ['native-failure', 'exit'], ['native-failure', 'unknown'], ['native-failure', 'source'], ['native-failure', 'tests'], ['native-failure', 'stop'], ['missing-final', 'none'], ['pause', 'none'], ['pause', 'prior-draft'], ['missing-final', 'prior-draft'], ['pause', 'older-pause'], ['pause', 'not-started'], ['pause', 'no-commit'], ['missing-final', 'session'], ['missing-final', 'user'], ['missing-final', 'exit'], ['missing-final', 'unknown'], ['missing-final', 'completed'], ['pause', 'source'], ['pause', 'tests'], ['pause', 'scope'], ['pause', 'seed'], ['pause', 'thread'], ['pause', 'turn'], ['pause', 'schema'], ['pause', 'worktree'], ['pause', 'stop'], ['pause', 'request'], ...zcodeMaterialCases, zcodeP0CommittedCase] as const) test(`旧Native无typed witness的新attempt仅观察最新Git材料，旧原件不补签 mode=${mode}/${defect}`, async t => {
  const completedP1Rpc = mode === 'zcode-p1-completed-rpc', completedRpc = mode === 'zcode-completed-rpc' || completedP1Rpc
  const rpcFailure = `ZCode native RPC timeout (${defect === 'rpc-method' ? 'session/messages' : 'session/events'})`
  const committedP1 = mode === 'zcode-p1-transport-committed' || completedP1Rpc
  const typedTransport = mode === 'zcode-transport-git' || mode === 'zcode-p1-transport-dirty' || mode === 'zcode-p1-transport-committed'
  const p1 = mode === 'zcode-p1-dirty' || mode === 'zcode-p1-transport-dirty' || committedP1, dirty = mode === 'zcode-dirty' || p1 && !committedP1, freshZCode = mode === 'zcode-new' || dirty || completedRpc || typedTransport
  const zcode = mode === 'zcode-old' || freshZCode, older = defect === 'older-pause' || defect === 'older-physical'
  const partitionedP1 = completedP1Rpc && defect === 'partition'
  const sealed = defect.startsWith('sealed-'), archiveSource = defect === 'archived' || sealed
  const rejectedReview = defect === 'review-foreign-path', onlyReview = defect === 'review' || rejectedReview, materialExpected = defect === 'archived' || defect === 'none' || defect === 'ordinary-ignored' || defect === 'prior-draft' || older || defect === 'staged' || defect === 'review' || partitionedP1
  const f = await fixture(t, { maxAttempts: older ? 4 : 3, maxCalls: 6, maxRepairs: older ? 3 : 2, timeoutMs: 120000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1', ...((completedRpc || sealed) && !p1 || partitionedP1 ? { version: 'sync-coordinator-v2', direction: 'code_to_spec', sourcePaths: ['src/export.js'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 } } : {}), ...(partitionedP1 ? { writePaths: ['.spec'], commitTrigger: { before: null, paths: ['src/export.js'] } } : {}) }, undefined, p1 && !partitionedP1 ? 'spec' : 'code', zcode ? 'zcode:bigmodel-api/GLM-5.3-Flash' : 'claude:MiniMax-M3.1-Flash', partitionedP1)
  if (archiveSource) { const previousCwd = process.cwd(); process.chdir(f.root); t.after(() => process.chdir(previousCwd)) }
  if (partitionedP1) f.store.expandContractScope = () => { throw Object.assign(new Error('分区P1原稿经独审后停止'), { code: 'unsupported' }) }
  if (p1) f.store.startGeneration = () => { throw Object.assign(new Error('P1原稿经真实提交及独审后停止，不运行P2'), { code: 'unsupported' }) }
  if (committedP1 && !partitionedP1) {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
    const commonDir = f.input.source.commonDir, value = { version: 'elaboration-draft-v1', generationGuidance: 'ac-test-binding-v1' }, resultRef = writeEvidence(commonDir, value)
    const wrapper = writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'elaboration-draft-protocol', resultRef })
    f.store.checkpoint(claimed.fence, { ...wrapper, artifacts: syncCheckpointArtifacts(value, resultRef) })
  }
  const latest = completedRpc ? JSON.stringify({ draft: 'x'.repeat(4228 - JSON.stringify({ draft: '' }).length) }) : `{LATEST_UNAPPROVED_DRAFT${'x'.repeat((mode === 'native-failure' ? 92755 : defect === 'prior-draft' || older ? 85970 : 59388) - 24)}}`, priorText = '{EARLIER_SEED_DRAFT' + 'a'.repeat(mode === 'native-failure' ? 85970 - '{EARLIER_SEED_DRAFT'.length : 59010)
  let oldSession = '', oldPath = '', oldNativeRoot = '', originalRequest: ElaborationSessionRequest | undefined, originalAttemptNumber = 0, continued = false, restartedWithoutMaterial = false, missingExitInjected = false
  const coldP0 = mode === 'zcode-new' && defect === 'ordinary-ignored'
  const coldP1 = committedP1 && defect === 'ordinary-ignored'
  const coldReserved = coldP0 || coldP1
  let reservedRequest: Omit<ElaborationSessionRequest, 'signal'> | undefined, reservedReplayed = false
  if (coldP1) {
    const checkpoint = f.store.checkpoint.bind(f.store)
    f.store.checkpoint = (fence, ref) => {
      if (reservedRequest && JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage === 'elaboration') throw Object.assign(new Error('fixture在新稿reserve后、结果持久化前冷停'), { code: 'SYNC_FENCE_EXPIRED' })
      return checkpoint(fence, ref)
    }
  }
  const originalRunner = f.options.runner!
  if (completedRpc || typedTransport && !p1) {
    const recordFailure = f.store.recordFailure.bind(f.store)
    f.store.recordFailure = (fence, issue) => {
      const operation = recordFailure(fence, issue)
      if (issue.code === 'native_rpc_timeout' || issue.code === 'native_turn_transport_failed') f.store.requestControl(operation.id, 'pause')
      return operation
    }
  }
  let analysisCalls = 0
  f.options.runner = async request => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    if (p1 && request.purpose === 'elaboration_review') {
      const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `independent-${dispatch.sessionCreateKey}`, turnId: 'review-turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    if (onlyReview && request.purpose === 'code_behavior_analyze' || partitionedP1 && request.purpose.startsWith('code_behavior_')) {
      if (request.purpose === 'code_behavior_analyze') assert.equal(++analysisCalls, 1, '已校验分析不得因下游草稿恢复而重做')
      const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `ready-${request.purpose}`), seed = request.worktree!
      f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
      const produced = await originalRunner({ ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) })
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(produced.output))
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'ready original analysis'], { stdio: 'pipe' })
      const output = { summary: '原分析正常提交并等待独审' }
      const result = { ...produced, output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
      if (!partitionedP1) return result
      const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
      return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: { readRecord, cancel: cancelStructuredSession, run: async actual => {
        const { sessionId: session, threadId, turnId, resultDigest, worktree } = result, execution = structuredExecutionPolicy(actual)
        const prompt = nativeWorktreePrompt(actual.prompt, actual.worktree!)
        configuredSessionApplication().createSession({ sessionId: session, status: 'awaiting' })
        writeRecord({ session, governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'zcode', harnessSessionId: threadId, runtimeStartToken: null, status: 'awaiting', stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null, createRequestId: contentHash(actual.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, base: seed.baseCommit, structuredExecution: execution })), structuredExecution: { ...execution, threadId, turnId, turnStartRequested: true, state: 'completed', output, resultDigest, resultWorktree: worktree } })
        return result
      } } })(request)
    }
    assert.equal(request.purpose, p1 ? 'elaboration_generate' : onlyReview ? 'code_behavior_review' : 'code_behavior_analyze')
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `observed-${attempt.number}${coldReserved && reservedRequest && !reservedReplayed ? '-cold' : ''}`), seed = request.worktree!
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if ((defect === 'prior-draft' || older) && attempt.number === 1) {
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), priorText)
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'earlier real native draft'], { stdio: 'pipe' })
      const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, output = { summary: '已正常提交早期未批准业务稿' }
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `earlier-${dispatch.sessionCreateKey}`, turnId: 'earlier-turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
    }
    if (older && attempt.number === 3) {
      assert.equal(contentHash(readFileSync(join(workspace, path))), contentHash(latest))
      writeFileSync(join(workspace, path), priorText)
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'newer authenticated draft returns to same bytes'], { stdio: 'pipe' })
      const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, output = { summary: '更新的认证稿，不能再被更早暂停稿遮盖' }
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `newer-${dispatch.sessionCreateKey}`, turnId: 'newer-turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
    }
    if (originalRequest) {
      if (defect === 'missing-exit') assert.equal(missingExitInjected, true, 'missing-exit观察必须发生在退出sidecar移除之后')
      if (!p1) {
        const current = readCodeBehaviorContext(request, f.input.source.commonDir)
        assert.deepEqual(current.errors, [])
        assert.deepEqual(current.repairDiagnostics, [])
      }
      if (rejectedReview) {
        const previous = readCodeBehaviorContext(originalRequest, f.input.source.commonDir), current = readCodeBehaviorContext(request, f.input.source.commonDir)
        assert(previous.pendingAnalysis)
        assert.deepEqual(current.pendingAnalysis, previous.pendingAnalysis, '续审仍绑定同一已校验分析')
        assert.equal(analysisCalls, 1, '历史旧审稿不可采纳时只派发新的独审')
      }
      if (!materialExpected) { assert.equal(existsSync(join(workspace, path)), false, '不合格或无稿的旧记录不能向新seed投影正文'); restartedWithoutMaterial = true; throw Object.assign(new Error('反例安全进入新派发且无旧材料'), { code: 'unsupported' }) }
      if (completedRpc) assert.equal(existsSync(join(workspace, path)), true, 'exact completed的已结算session/events RPC失败须把正常Git稿续入新seed')
      assert.equal(contentHash(readFileSync(join(workspace, path))), contentHash(older ? priorText : latest), '必须取最新normal Git正文SHA，不能回原seed或旧59010字节')
      if (completedRpc && !p1) {
        assert.doesNotMatch(request.prompt, /untrusted terminal text/)
        const current = readCodeBehaviorContext(request, f.input.source.commonDir)
        assert.equal(current.pendingAnalysis, undefined)
        const protectedEntries = (tree: string) => readTree(f.input.source.commonDir, tree).filter(entry => entry.path !== path && entry.path !== path.replace(/\.json$/, '.context.json'))
        assert.deepEqual(protectedEntries(seed.tree), protectedEntries(originalRequest.worktree!.tree))
      }
      if (zcode && !p1 && (defect === 'prior-draft' || dirty)) {
        if (defect === 'prior-draft') assert.equal(f.store.listAttempts(f.operation.id)[0].failure?.code, 'behavior_output_json')
        if (onlyReview) assert.deepEqual(readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis, readCodeBehaviorContext(originalRequest, f.input.source.commonDir).pendingAnalysis, '物理review稿仅续审，原ready分析完整保持')
      }
      assert.match(request.prompt, older ? p1 ? /已有草稿已复制/ : /已有原草稿已复制/ : committedP1 ? /真实Git提交已按原字节复制；该稿未批准/ : dirty ? /未批准的物理草稿/ : /认证的原Git分析草稿/)
      assert.doesNotMatch(request.prompt, /missing required structured_output/, '原Native停止分类不复制进新任务')
      continued = true
      if (coldP0 && !reservedReplayed) {
        const { signal: _signal, ...payload } = request
        if (!reservedRequest) {
          reservedRequest = payload
          throw Object.assign(new Error('P0已保留请求，模拟执行器在创建前离线'), { code: 'SYNC_FENCE_EXPIRED' })
        }
        assert.deepEqual(payload, reservedRequest)
        reservedReplayed = true
      }
      if (p1 && !older) {
        if (completedP1Rpc) {
          assert(request.prompt.includes(rpcFailure), '续修保留原RPC超时诊断')
          assert.doesNotMatch(request.prompt, /untrusted terminal text/)
        } else assert.match(request.prompt, /EPIPE/)
        if (coldReserved && !reservedReplayed) {
          const { signal: _signal, ...payload } = request
          if (!reservedRequest) {
            reservedRequest = payload
            throw Object.assign(new Error('只保留真实新请求reservation供SQLite冷重放'), { code: 'unsupported' })
          }
          assert.deepEqual(payload, reservedRequest)
          reservedReplayed = true
        }
        if (defect === 'prior-draft') {
          const diagnostics = (request: ElaborationSessionRequest) => JSON.parse(request.prompt.split('\n失败诊断（不是新授权）:\n')[1].split('\n草稿业务schema只读文件=')[0]) as { priorDraft: { errors: unknown[] } | null; materialErrors: unknown[] }
          const old = diagnostics(originalRequest), current = diagnostics(request)
          assert(old.priorDraft?.errors.length); assert.equal(current.priorDraft, null, '物理材料清旧Git draft角色')
          for (const error of old.priorDraft.errors) assert(current.materialErrors.some(item => JSON.stringify(item) === JSON.stringify(error)), 'A原具体finding完整进入C，不只剩EPIPE')
        }
        const protectedEntries = (tree: string) => readTree(f.input.source.commonDir, tree).filter(entry => entry.path !== path)
        assert.deepEqual(protectedEntries(seed.tree), protectedEntries(originalRequest.worktree!.tree), '新P1 seed只复制精确原稿，原readonly overlay/schema/source/tests全保')
        const draft = partitionedP1 ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '沿用完整冻结契约及已有边界', affectedIds: ['REQ-EXPORT-01'] })) } : adaptElaborationNativeOutput(request, rows(original))
        writeFileSync(join(workspace, path), JSON.stringify(draft))
        execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'repair original stopped physical draft'], { stdio: 'pipe' })
        const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, output = { summary: '原物理稿续改后正常提交' }
        return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `repaired-${dispatch.sessionCreateKey}`, turnId: 'generation-turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
      }
      throw Object.assign(new Error('已核新attempt在最新真实Git草稿续修入口'), { code: 'unsupported' })
    }
    originalRequest = request; originalAttemptNumber = attempt.number; oldPath = workspace
    mkdirSync(join(workspace, path, '..'), { recursive: true })
    for (const text of defect === 'not-started' || defect === 'no-commit' || defect.startsWith('no-progress-') ? [] : [priorText, latest]) {
      writeFileSync(join(workspace, path), text)
      if (!dirty) { execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'normal native draft progress'], { stdio: 'pipe' }) }
    }
    if (defect === 'no-progress-empty-commit-cancelled') {
      execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'cancelled native turn without draft progress'], { stdio: 'pipe' })
      const emptyCommit = nativeWorktreeResult(workspace, seed)
      assert.notEqual(emptyCommit.headCommit, seed.baseCommit)
      assert.equal(emptyCommit.tree, seed.tree)
      assert.equal(execFileSync('git', ['-C', workspace, 'diff', '--name-only', seed.baseCommit, emptyCommit.headCommit], { encoding: 'utf8' }).trim(), '')
      assert.equal(existsSync(join(workspace, path)), false)
    }
    if (rejectedReview) {
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'historical review draft'], { stdio: 'pipe' })
      writeFileSync(join(workspace, 'src/export.js'), Buffer.concat([f.bytes, Buffer.from('\n// foreign old worktree change\n')]))
    }
    if (defect === 'ordinary-ignored' || rejectedReview) {
      writeFileSync(join(f.input.source.commonDir, 'info/exclude'), '/stopped-runtime-cache/\n')
      mkdirSync(join(workspace, 'stopped-runtime-cache')); writeFileSync(join(workspace, 'stopped-runtime-cache/entry'), 'ignored runtime file')
    }
    if (dirty && defect === 'staged') execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' })
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    for (let index = 0; index < 23; index++) { const resultRef = writeEvidence(f.input.source.commonDir, { fixtureSibling: index }); f.store.checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: attempt.id, inputId: f.input.id, policyDigest: operation.policyDigest, stage: `sibling:${index}`, resultRef }), artifacts: [{ kind: 'json', ref: resultRef }] }) }
    return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
      readRecord: id => readRecord(id), cancel: cancelStructuredSession,
      run: async actual => {
        const execution = structuredExecutionPolicy(actual), session = sessionIdForCreateKey(actual.sessionCreateKey!), root = join(f.parent, 'original-native')
        mkdirSync(root); await sampleNativeWorktreeProcesses({ root, receiptFile: join(root, 'process.json'), workspace })
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); assert(child.pid)
        const ended = new Promise<void>(resolve => child.once('close', () => resolve())), receiptFile = join(root, 'process.json')
        writeDetachedRuntimeReceipt(child.pid, receiptFile); process.kill(-child.pid, 'SIGTERM'); await ended
        if (zcode) {
          const prompt = nativeWorktreePrompt(actual.prompt, actual.worktree!), generic = execution.nativeConfiguration === 'cli-config-v1', selection = generic ? zcodeNativeConfigSelection(execution.model, execution.effort) : zcodeNativeSelection(execution.model, execution.effort), model = selection.model!, native = { version: generic ? 3 as const : 1 as const, root, sessionId: `thread-${session}`, inputId: `input-${session}`, turnId: `turn-${session}`, pid: child.pid, receiptFile }, hash = (value: unknown): string => contentHash(JSON.stringify(value)), queryId = `query-${session}`, nativePrompt = `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(execution.schema)}\n\n${prompt}`
          const snapshot = { sessionId: native.sessionId, model }, plan = { ...native, ...(generic ? { nativeConfiguration: 'cli-config-v1', builtinPath: zcodeCapability.builtinPath } : {}), worktreeProcessBaseline: 1, queryId, workspace, runtime: join(root, 'runtime'), tmp: join(root, 'tmp'), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, ...selection, modelSnapshotDigest: hash(snapshot), policyDigest: hash(execution), requestDigest: hash({ prompt, nativePrompt, policy: execution, selection }) }
          for (const directory of [plan.runtime, plan.tmp]) mkdirSync(directory)
          const event = (type: string, seq: number, payload: Record<string, unknown>) => ({ sessionId: native.sessionId, turnId: native.turnId, type, seq, eventId: `event-${seq}`, payload })
          const response = JSON.stringify({ summary: '正常完成原Native轮次，Git结果尚未发布' })
          const terminal = event(completedRpc || sealed || defect.endsWith('cancelled') ? 'turn.completed' : 'turn.failed', 3, { inputId: native.inputId, ...(completedRpc ? { resultType: 'success', response: 'untrusted terminal text, never a successful output' } : sealed ? { resultType: 'success', response } : defect.endsWith('cancelled') ? { resultType: 'cancelled', response: '' } : { error: { code: 'EPIPE' } }) }), events = [event('turn.started', 1, { inputId: native.inputId, queryId, messageId: 'exact-user' }), event('session.updated', 2, { providerId: model.providerId, modelId: model.modelId, toolCount: 3 }), terminal]
          const send = { sessionId: native.sessionId, content: nativePrompt, inputId: native.inputId, modelSelection: model }
          const successfulTurn = completedRpc || sealed
          const exit = { code: 0, signal: null, stopped: true, acknowledged: successfulTurn, idle: successfulTurn, closed: successfulTurn, stderrBytes: 0, stderrSha256: contentHash('') }
          for (const [name, value] of Object.entries({ 'plan.json': plan, 'send.json': send, 'model-snapshot.json': snapshot, 'events.json': events, 'terminal.json': terminal, ...(successfulTurn ? { 'idle.json': { sessionId: native.sessionId, turnId: native.turnId, idle: true } } : {}), 'exit.json': exit })) writeFileSync(join(root, name), JSON.stringify(value))
          if (sealed) {
            const messages = [
              { info: { id: 'exact-user', sessionID: native.sessionId, role: 'user', modelSelection: model, anchor: { turnId: native.turnId }, semantics: { kind: 'user_prompt' } }, parts: [{ type: 'text', text: nativePrompt }] },
              { info: { role: 'assistant', providerId: model.providerId, modelId: model.modelId, anchor: { turnId: native.turnId }, semantics: { kind: 'assistant_response' } }, parts: [{ type: 'text', text: response }] },
            ]
            const completed = { plan, terminal, events, messages, exit, send, result: { threadId: native.sessionId, turnId: native.turnId, text: response } }
            writeFileSync(join(root, 'messages.json'), JSON.stringify(messages))
            writeFileSync(join(root, 'completed.json'), JSON.stringify(completed))
          }
          const identity = { threadId: native.sessionId, turnId: native.turnId }, failure = completedRpc ? rpcFailure : freshZCode ? 'ZCode native turn failed (code=EPIPE)' : 'ZCode exact terminal has no matching idle runtime', policy = { ...execution, ...identity, zcodeNative: native, turnStartRequested: true }
          const stop = freshZCode ? await stopZCodeStructuredTurn(policy as ZCodeStructuredExecution) : { nativeStopped: false, acknowledged: false, error: failure }
          configuredSessionApplication().createSession({ sessionId: session, status: 'error' })
          writeRecord({ session, governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'zcode', harnessSessionId: identity.threadId, runtimeStartToken: null, status: 'error', stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: 'zcode', launchOwner: null, createRequestId: contentHash(actual.sessionCreateKey!), createPayloadHash: hash({ prompt, parent: null, launcher: null, base: actual.worktree!.baseCommit, structuredExecution: execution }), structuredExecution: { ...policy, state: freshZCode || sealed && defect !== 'sealed-unobserved' ? 'failed' : 'cancelling', ...(completedRpc ? { errorCode: 'native_rpc_timeout' } : typedTransport ? { errorCode: 'native_turn_transport_failed' } : {}), error: failure, cancellation: { reason: 'cancelled', requestedAt: Date.now(), ...stop } } })
          oldSession = session; oldNativeRoot = root
          if (defect === 'missing-exit' && !completedRpc) f.store.requestControl(operation.id, 'pause')
          throw new StructuredSessionError(completedRpc ? 'native_rpc_timeout' : typedTransport ? 'native_turn_transport_failed' : freshZCode ? 'failed' : 'cancellation_pending', failure, { sessionId: session, ...identity, ...(typedTransport ? { requestKey: actual.requestKey, inputDigest: actual.inputDigest } : {}) })
        }
        const native = { version: 1 as const, root, sessionId: `thread-${session}`, userUuid: `user-${session}`, pid: child.pid, receiptFile }, prompt = nativeWorktreePrompt(actual.prompt, actual.worktree!), identity = { threadId: native.sessionId, turnId: native.userUuid }, message = { role: 'user', content: [{ type: 'text', text: prompt }] }, history = [{ type: 'user', sessionId: native.sessionId, uuid: native.userUuid, parentUuid: null, promptId: 'original-prompt', message }]
        const hash = (value: unknown): string => contentHash(JSON.stringify(value)), plan = { ...native, workspace, cliVersion: '2.1.309 (Claude Code)', requestedModel: execution.model, resolvedModel: 'MiniMax-M3.1-Flash', historyDigest: hash(history), policyDigest: hash(execution), requestDigest: hash({ prompt, policy: execution }) }
        const files = { 'plan.json': plan, 'public-history.json': { version: 1, sessionId: native.sessionId, history }, 'init.json': { session_id: native.sessionId, model: 'MiniMax-M3.1-Flash', tools: ['Read', 'Bash'] }, 'user-echo.json': { uuid: native.userUuid, session_id: native.sessionId, message }, ...(mode !== 'pause' ? { 'result.json': { type: 'result', subtype: 'success', is_error: mode === 'native-failure', session_id: native.sessionId, user_message_uuid: native.userUuid, user_message_uuids: [native.userUuid] }, 'exit.json': { code: defect.includes('143') ? 143 : mode === 'native-failure' ? 1 : 0, signal: null, stopped: true } } : {}) }
        for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value))
        mkdirSync(join(root, 'claude-home/projects/exact'), { recursive: true }); writeFileSync(join(root, 'claude-home/projects/exact', native.sessionId + '.jsonl'), history.map(row => JSON.stringify(row)).join('\n') + '\n')
        const failure = defect.includes('143') ? 'Claude emitted more than one native init identity' : mode === 'missing-final' ? 'Claude worktree success evidence differs' : mode === 'native-failure' ? 'Claude execution ended without a complete native result and user echo' : 'explicit safe pause'
        const record: NativeRunRecord = { session, status: 'error', harnessSessionId: identity.threadId, createRequestId: contentHash(actual.sessionCreateKey!), createPayloadHash: hash({ prompt, parent: null, launcher: null, base: actual.worktree!.baseCommit, structuredExecution: execution }), structuredExecution: { ...execution, ...identity, claudeNative: native, state: mode !== 'pause' ? 'failed' : 'running', error: failure } }
        oldSession = session; oldNativeRoot = root
        if (defect === 'not-started') { record.harnessSessionId = null; record.structuredExecution = { ...execution, state: 'running' } }
        configuredSessionApplication().createSession({ sessionId: session, status: 'error' })
        writeRecord({ governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'claude-headless', runtimeStartToken: null, stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: 'claude', launchOwner: null, ...record })
        if (mode === 'pause') f.store.requestControl(operation.id, 'pause')
        throw new StructuredSessionError(mode === 'missing-final' ? 'stale_result' : mode === 'native-failure' ? 'failed' : 'cancelled', failure, { sessionId: session, ...identity })
      },
    } })(request)
  }
  const initialResult = await runSyncOperation(f.store, f.operation.id, f.options)
  if (coldP1) {
    assert.equal(initialResult.status, 'recovery_required'); assert(reservedRequest)
    const interrupted = f.store.readAttempt(initialResult.operation.currentAttemptId!), reservation = interrupted.dispatchPlans.find(dispatch => dispatch.key === reservedRequest!.requestKey)!
    assert.equal(reservation.session, null)
    assert.equal(interrupted.checkpointRefs.filter(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage === 'elaboration:stopped-git-material-provenance').length, 1)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    f.store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(f.store)
    f.store.startGeneration = () => { throw Object.assign(new Error('冷恢复已审通过，测试停在P2前'), { code: 'unsupported' }) }
    const foreign = join(oldPath, 'appeared-after-original-reservation')
    writeFileSync(foreign, '复入应使用已冻结的材料原件，不重新观察后来工作树')
    const resumed = await runSyncOperation(f.store, f.operation.id, f.options).finally(() => rmSync(foreign))
    assert.equal(resumed.status, 'unsupported', JSON.stringify(resumed.failure)); assert.equal(reservedReplayed, true, JSON.stringify(resumed.failure))
    const resumedAttempt = f.store.readAttempt(interrupted.id)
    assert.equal(resumedAttempt.dispatchPlans.find(dispatch => dispatch.key === reservation.key)?.requestDigest, reservation.requestDigest)
    assert.equal(resumedAttempt.checkpointRefs.filter(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage === 'elaboration:stopped-git-material-provenance').length, 1)
  }
  if (partitionedP1) assert.equal(initialResult.operation.control, 'pause')
  if (defect === 'missing-exit' || completedRpc && !partitionedP1) assert.equal(initialResult.status, 'paused', JSON.stringify({ message: '先暂停首次失败，确保原资源已结算后才进入新材料观察', failure: initialResult.failure, attempts: f.store.listAttempts(f.operation.id).map(({ status, failure }) => ({ status, failure })) }))
  if (p1 && !completedRpc && (defect === 'none' || defect === 'ordinary-ignored')) {
    const attempts = f.store.listAttempts(f.operation.id)
    assert.equal(attempts.length, 2, '旧generic与新typed沿同一P1既有修复预算')
    assert.equal(attempts[0].failure?.kind, 'repairable')
    assert.equal(attempts[0].failure?.code, typedTransport ? 'native_turn_transport_failed' : 'failed')
  }
  assert(oldSession, JSON.stringify({ initial: initialResult.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, failure: attempt.failure })) }))
  if (completedRpc) {
    const [attempt] = f.store.listAttempts(f.operation.id), dispatch = attempt.dispatchPlans.find(item => item.purpose === (p1 ? 'elaboration_generate' : 'code_behavior_analyze'))!
    assert.match(dispatch.key, p1 ? /:elaborate(?::partition:[^:]+)?:0:elaboration_generate$/ : /:analysis:partition:[^:]+:code_behavior_analyze$/)
    if (partitionedP1) assert.match(dispatch.key, /:elaborate:partition:[^:]+:0:elaboration_generate$/)
    assert.equal(attempt.failure?.code, 'native_rpc_timeout'); assert.equal(attempt.failure?.kind, 'repairable')
    const resource = f.store.findResource(attempt.id, dispatch.key)!, checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    assert.equal(resource.phase, 'removed'); assert.equal(checkpoint.nativeState, 'failed'); assert.equal(checkpoint.status, 'failed'); assert.equal(checkpoint.stop?.nativeStopped, true)
    assert.deepEqual(dispatch.session, checkpoint.session)
    assert.deepEqual(checkpoint.failure, { code: 'native_rpc_timeout', message: rpcFailure })
    assert.equal(checkpoint.result, undefined)
    const stage = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => p1 ? partitionedP1 ? /^partition:[^:]+:elaboration$/.test(wrapper.stage) : wrapper.stage === 'elaboration' : wrapper.stage.endsWith(':analysis:continuation'))
    assert.ok(stage)
    const saved = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString())
    if (p1) {
      assert.equal(saved.status, 'failed'); assert.equal(saved.failure.code, 'native_rpc_timeout')
      assert(saved.rounds.every((round: { draft?: unknown }) => !round.draft))
    } else {
      assert.equal(saved.readyAnalysis, undefined); assert.deepEqual(saved.drafts, {})
    }
    const witness = nativeWorktreeResult(oldPath, originalRequest!.worktree!)
    const path = /草稿文件=([^\s；]+)/.exec(originalRequest!.prompt)![1]
    if (defect === 'no-commit') assert.equal(witness.headCommit, witness.baseCommit)
    else {
      assert.notEqual(witness.headCommit, witness.baseCommit)
      assert.equal(execFileSync('git', ['-C', oldPath, 'diff', '--name-only', witness.baseCommit, witness.headCommit], { encoding: 'utf8' }).trim(), path)
      assert.equal(readFileSync(join(oldPath, path)).byteLength, 4228)
    }
  }
  if (mode !== 'pause') f.store.requestControl(f.operation.id, 'pause')
  const recovery = await recoverSyncOperationResources(f.store, f.operation.id, { root: f.root, inputId: f.input.id, artifactRoot: f.artifactRoot })
  assert.equal(recovery.status, 'resources_recovered', JSON.stringify(recovery))
  const recordForDefect = readRecord(oldSession)!
  if (defect === 'worktree') writeRecord({ ...recordForDefect, worktreePath: f.root })
  if (defect === 'seed') writeRecord({ ...recordForDefect, base: f.input.headCommit })
  if (defect === 'no-progress-143-foreign') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, threadId: 'foreign' } })
  if (defect === 'no-progress-143-process') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, claudeNative: { ...recordForDefect.structuredExecution!.claudeNative!, pid: process.pid } } })
  if (defect === 'no-progress-143-stop') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, cancellation: { ...recordForDefect.structuredExecution!.cancellation!, nativeStatus: 'unknown' } } })
  if (defect === 'thread' || defect === 'turn') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, ...(defect === 'thread' ? { threadId: 'foreign' } : { turnId: 'foreign' }) } })
  if (defect === 'harness-thread') writeRecord({ ...recordForDefect, harnessSessionId: 'foreign-harness-thread' })
  if (defect === 'stop') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, cancellation: { ...recordForDefect.structuredExecution!.cancellation!, acknowledged: !recordForDefect.structuredExecution!.cancellation!.acknowledged } } })
  if (defect === 'request') writeRecord({ ...recordForDefect, structuredExecution: { ...recordForDefect.structuredExecution!, inputDigest: 'foreign-input' } })
  if (zcode && ['session', 'send', 'input', 'query', 'message', 'model', 'terminal'].includes(defect)) {
    const path = join(oldNativeRoot, defect === 'send' ? 'send.json' : defect === 'model' ? 'model-snapshot.json' : defect === 'terminal' ? 'terminal.json' : 'events.json'), value = JSON.parse(readFileSync(path, 'utf8'))
    if (defect === 'send') value.inputId = 'foreign'; if (defect === 'session') value[2].sessionId = 'foreign'; if (defect === 'input') value[2].payload.inputId = 'foreign'; if (defect === 'query') value[0].payload.queryId = 'foreign'; if (defect === 'message') value[0].payload.messageId = ''; if (defect === 'model') value.model.modelId = 'foreign'; if (defect === 'terminal') value.eventId = 'foreign'
    writeFileSync(path, JSON.stringify(value))
  }
  if (!zcode && (defect === 'session' || defect === 'user' || defect === 'unknown')) { const path = join(oldNativeRoot, 'result.json'), result = JSON.parse(readFileSync(path, 'utf8')); if (defect === 'session') result.session_id = 'foreign'; if (defect === 'user') result.user_message_uuid = 'foreign'; if (defect === 'unknown') result.subtype = 'unknown'; writeFileSync(path, JSON.stringify(result)) }
  if (defect === 'exit') writeFileSync(join(oldNativeRoot, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: false }))
  if (completedRpc && (defect === 'idle' || defect === 'closed')) {
    const path = join(oldNativeRoot, 'exit.json'), exit = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...exit, [defect]: false }))
  }
  if (defect === 'idle-identity' || defect === 'version') {
    const path = join(oldNativeRoot, defect === 'version' ? 'plan.json' : 'idle.json'), original = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...original, ...(defect === 'version' ? { version: 0 } : { turnId: 'foreign-idle-turn' }) }))
  }
  if (defect === 'no-terminal') {
    rmSync(join(oldNativeRoot, 'terminal.json')); rmSync(join(oldNativeRoot, 'idle.json'))
    const path = join(oldNativeRoot, 'events.json'), events = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify(events.slice(0, -1)))
  }
  if (defect === 'terminal-json') writeFileSync(join(oldNativeRoot, 'terminal.json'), '{CORRUPT_TERMINAL')
  if (defect === 'provider-code') {
    const path = join(oldNativeRoot, 'terminal.json'), eventsPath = join(oldNativeRoot, 'events.json')
    const terminal = JSON.parse(readFileSync(path, 'utf8')), events = JSON.parse(readFileSync(eventsPath, 'utf8'))
    terminal.payload.error.code = 'EACCES'
    writeFileSync(path, JSON.stringify(terminal)); writeFileSync(eventsPath, JSON.stringify([...events.slice(0, -1), terminal]))
  }
  if (defect === 'terminal-kind' || defect === 'failed-terminal' || defect === 'cancelled-terminal') {
    const path = join(oldNativeRoot, 'terminal.json'), eventsPath = join(oldNativeRoot, 'events.json'), terminal = JSON.parse(readFileSync(path, 'utf8')), events = JSON.parse(readFileSync(eventsPath, 'utf8'))
    if (defect === 'failed-terminal') { terminal.type = 'turn.failed'; terminal.payload = { inputId: terminal.payload.inputId, error: { code: 'EPIPE' } } }
    else if (defect === 'cancelled-terminal') { terminal.payload.resultType = 'cancelled'; terminal.payload.response = '' }
    else terminal.payload.resultType = 'unknown'
    writeFileSync(path, JSON.stringify(terminal)); writeFileSync(eventsPath, JSON.stringify([...events.slice(0, -1), terminal]))
    if (defect !== 'terminal-kind') {
      const exitPath = join(oldNativeRoot, 'exit.json'), exit = JSON.parse(readFileSync(exitPath, 'utf8'))
      writeFileSync(exitPath, JSON.stringify({ ...exit, idle: false, closed: false, ...(defect === 'failed-terminal' ? { code: 1 } : { code: null, signal: 'SIGTERM' }) }))
    }
  }
  if (defect === 'dirty') writeFileSync(join(oldPath, /草稿文件=([^\s；]+)/.exec(originalRequest!.prompt)![1]), 'uncommitted replacement must stay outside seed')
  if (zcode && defect === 'missing-exit') { rmSync(join(oldNativeRoot, 'exit.json')); missingExitInjected = true }
  if (defect === 'completed') writeFileSync(join(oldNativeRoot, 'completed.json'), '{CORRUPT_COMPLETED')
  if (defect === 'sealed-tampered') writeFileSync(join(oldNativeRoot, 'completed.json'), '\n', { flag: 'a' })
  if (defect === 'sealed-missing-exit') rmSync(join(oldNativeRoot, 'exit.json'))
  if (defect === 'source' || defect === 'tests' || defect === 'scope' || defect === 'schema' || defect === 'context' || defect === 'index') { const path = defect === 'source' || defect === 'index' ? 'src/export.js' : defect === 'tests' ? 'tests/export.test.mjs' : defect === 'scope' ? '.spex-sync-drafts/foreign.json' : /草稿文件=([^\s；]+)/.exec(originalRequest!.prompt)![1].replace(/\.json$/, defect === 'context' ? '.context.json' : '.schema.json'); writeFileSync(join(oldPath, path), 'foreign unauthorized edit'); if (!dirty || defect === 'index') execFileSync('git', ['-C', oldPath, 'add', path], { stdio: 'pipe' }); if (!dirty) execFileSync('git', ['-C', oldPath, 'commit', '-m', 'negative unauthorized edit'], { stdio: 'pipe' }) }
  if ((mode === 'pause' || mode === 'native-failure') && (defect === 'none' || defect === 'prior-draft' || older)) { rmSync(join(oldNativeRoot, 'public-history.json')); rmSync(join(oldNativeRoot, 'claude-home'), { recursive: true }) }
  let originalRecord = readRecord(oldSession)!; const originalState = originalRecord.structuredExecution!, oldAttempts = f.store.listAttempts(f.operation.id).filter(attempt => !p1 || attempt.number <= originalAttemptNumber)
  assert.equal(originalState.state, freshZCode ? 'failed' : 'cancelled'); assert.equal(originalState.cancellation?.nativeStopped, true); assert.equal(originalState.errorCode, completedRpc ? 'native_rpc_timeout' : typedTransport ? 'native_turn_transport_failed' : undefined); assert.equal(originalState.failedWorktree, undefined)
  const oldResources = oldAttempts.flatMap(attempt => attempt.dispatchPlans.map(dispatch => f.store.findResource(attempt.id, dispatch.key))).filter(resource => resource !== null)
  assert(oldResources.every(resource => resource.phase === 'removed'))
  const completedRpcResource = completedRpc ? oldResources.find(resource => (JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan).expectedSessionId === oldSession) : undefined
  if (completedRpc) { assert(completedRpcResource); assert.equal(originalState.output, undefined); assert.equal(originalState.resultWorktree, undefined); assert.equal(originalState.rejectedOutput, undefined) }
  const missingExitCandidate = defect === 'missing-exit' ? oldResources.map(resource => ({ resource, plan: JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan })).find(item => item.plan.expectedSessionId === oldSession) : undefined
  if (defect === 'missing-exit') assert(missingExitCandidate, 'missing-exit fixture must identify its exact stopped Native plan and checkpoint')
  let oldRecordBytes = JSON.stringify(originalRecord); const refs = oldAttempts.flatMap(attempt => attempt.checkpointRefs.map(ref => ({ ref, bytes: readEvidence(f.input.source.commonDir, ref) })))
  if (completedRpc || sealed) for (const resource of oldResources) for (const ref of [resource.plan.planBlob, resource.checkpointRef, ...resource.checkpoints.map(item => item.checkpointRef)]) refs.push({ ref, bytes: readEvidence(f.input.source.commonDir, ref) })
  const nativeFiles = Object.fromEntries(readdirSync(oldNativeRoot, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [entry.name, readFileSync(join(oldNativeRoot, entry.name))]))
  const latestHead = execFileSync('git', ['-C', oldPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), oldIndex = execFileSync('git', ['-C', oldPath, 'rev-parse', '--git-path', 'index'], { encoding: 'utf8' }).trim()
  const oldIndexBytes = readFileSync(oldIndex), oldDraftPath = /草稿文件=([^\s；]+)/.exec(originalRequest!.prompt)![1], oldDraftBytes = existsSync(join(oldPath, oldDraftPath)) ? readFileSync(join(oldPath, oldDraftPath)) : null
  let archivedRef: string | undefined
  if (sealed) {
    assert.equal(originalState.resultWorktree, undefined); assert.equal(originalState.output, undefined); assert.equal(originalState.resultDigest, undefined)
    const resource = oldResources.find(resource => JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()).expectedSessionId === oldSession)!
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    assert.equal(checkpoint.nativeState, 'cancelled'); assert.equal(checkpoint.status, 'cancelled'); assert.equal(checkpoint.result, undefined)
    assert.equal(resource.checkpoints.some(item => {
      const original = JSON.parse(readEvidence(f.input.source.commonDir, item.checkpointRef).toString()) as NativeRunCheckpoint
      return original.nativeState === 'failed' && JSON.stringify(original.session) === JSON.stringify(checkpoint.session)
    }), defect !== 'sealed-unobserved')
  }
  if (archiveSource) {
    execFileSync('git', ['-C', oldPath, 'switch', '-c', 'archived-material-source'], { stdio: 'pipe' })
    writeRecord({ ...originalRecord, branch: 'archived-material-source' })
    await withoutSessionApplicationExecutionWake(() => closeSession(oldSession, undefined, { wakeQueue: false }))
    originalRecord = readRecord(oldSession)!; oldRecordBytes = JSON.stringify(originalRecord)
    archivedRef = f.git('rev-parse', `refs/spex-archive/${oldSession}`)
    assert.equal(existsSync(oldPath), false)
  }
  f.store.requestControl(f.operation.id, 'run')
  if (defect === 'fence') {
    const checkpoint = f.store.checkpoint.bind(f.store)
    f.store.checkpoint = (fence, ref) => { const result = checkpoint(fence, ref), wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }; if (wrapper.stage === 'behavior-draft-protocol') f.store.requestControl(f.operation.id, 'pause'); return result }
  }
  if (defect === 'cas') { const checkpoint = f.store.checkpoint.bind(f.store); f.store.checkpoint = (fence, ref) => { const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()); if (wrapper.stage?.endsWith(':stopped-physical-material-provenance')) f.store.requestControl(f.operation.id, 'pause'); return checkpoint(fence, ref) } }
  const readResource = f.store.findResource.bind(f.store)
  const listAttempts = f.store.listAttempts.bind(f.store)
  if (completedRpcResource && ['missing-dispatch-session', 'null-dispatch-thread', 'null-dispatch-turn'].includes(defect)) f.store.listAttempts = operationId => listAttempts(operationId).map(attempt => attempt.id !== completedRpcResource.attemptId ? attempt : { ...attempt, dispatchPlans: attempt.dispatchPlans.map(dispatch => {
    if (dispatch.key !== completedRpcResource.plan.key) return dispatch
    const { session, ...original } = dispatch
    return defect === 'missing-dispatch-session' ? original as typeof dispatch : { ...original, session: { ...session!, ...(defect === 'null-dispatch-thread' ? { threadId: null } : { turnId: null }) } }
  }) })
  if (defect === 'failed-observation') f.store.findResource = (attemptId, key) => { const resource = readResource(attemptId, key); return resource ? { ...resource, checkpoints: resource.checkpoints.filter(item => (JSON.parse(readEvidence(f.input.source.commonDir, item.checkpointRef).toString()) as NativeRunCheckpoint).nativeState !== 'failed') } : null }
  if (completedRpcResource && (defect === 'unsettled' || defect === 'rpc-proof')) {
    const original = JSON.parse(readEvidence(f.input.source.commonDir, completedRpcResource.checkpointRef).toString()) as NativeRunCheckpoint
    const checkpointRef = defect === 'rpc-proof' ? writeEvidence(f.input.source.commonDir, { ...original, failure: { code: 'failed', message: rpcFailure } }) : completedRpcResource.checkpointRef
    f.store.findResource = (attemptId, key) => {
      const resource = readResource(attemptId, key)
      return resource && resource.attemptId === completedRpcResource.attemptId && key === completedRpcResource.plan.key ? { ...resource, phase: defect === 'unsettled' ? 'terminal' : resource.phase, checkpointRef } : resource
    }
  }
  let result = await runSyncOperation(f.store, f.operation.id, f.options).finally(() => { f.store.findResource = readResource; f.store.listAttempts = listAttempts })
  if (coldP0 && reservedRequest) {
    assert.equal(result.status, 'recovery_required')
    const interrupted = f.store.readAttempt(result.operation.currentAttemptId!)
    const reservation = interrupted.dispatchPlans.find(dispatch => dispatch.key === reservedRequest!.requestKey)!
    assert.equal(reservation.session, null)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    f.store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(f.store)
    const foreign = join(oldPath, 'appeared-after-original-reservation')
    writeFileSync(foreign, '复入应使用已冻结的Git材料')
    result = await runSyncOperation(f.store, f.operation.id, f.options).finally(() => rmSync(foreign))
    assert.equal(reservedReplayed, true, JSON.stringify(result.failure))
    const replayed = f.store.readAttempt(interrupted.id)
    assert.deepEqual(replayed.dispatchPlans, [reservation])
    assert.equal(replayed.checkpointRefs.filter(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage.endsWith(':stopped-git-material-provenance')).length, 1)
  }
  if (rejectedReview) {
    assert.equal(restartedWithoutMaterial, true, JSON.stringify(result.failure))
    assert.deepEqual(readFileSync(join(oldPath, 'src/export.js')), Buffer.concat([f.bytes, Buffer.from('\n// foreign old worktree change\n')]))
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  }
  if (defect === 'fence' || defect === 'cas') { assert.equal(continued, false); assert.notEqual(result.status, 'settled'); return }
  if (defect === 'unsettled') {
    assert.equal(result.status, 'recovery_required')
    assert.equal(result.failure?.code, 'resource_recovery')
    assert.equal(f.store.listAttempts(f.operation.id).filter(attempt => attempt.number > originalAttemptNumber).flatMap(attempt => attempt.dispatchPlans).length, 0)
  } else {
    assert(p1 || completedRpc && defect === 'dirty' ? ['unsupported', 'budget_exhausted'].includes(result.status) : result.status === 'unsupported', JSON.stringify({ status: result.status, failure: result.failure }))
  }
  assert.equal(continued, materialExpected, JSON.stringify({ result: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, failure: attempt.failure, calls: attempt.dispatchPlans.length })) }))
  if (defect === 'no-progress-143') assert.equal(restartedWithoutMaterial, true, '合法owned/stopped但HEAD==seed无JSON须在终态分类前skip，允许新任务')
  if (defect === 'no-progress-cancelled') assert.equal(restartedWithoutMaterial, true, '合法ZCode无进度取消仅跳过，不授新稿或成功')
  if (defect === 'progress-cancelled') {
    assert.equal(result.failure?.code, 'stale_result')
    assert.equal(result.failure?.message, 'stale_result: ZCode新Git材料没有原精确失败终态')
    assert.equal(restartedWithoutMaterial, false)
    assert.equal(f.store.listAttempts(f.operation.id).filter(attempt => attempt.number > originalAttemptNumber).flatMap(attempt => attempt.dispatchPlans).length, 0)
  }
  if (defect === 'no-progress-empty-commit-cancelled') assert.equal(restartedWithoutMaterial, true, JSON.stringify({ message: 'cancelled ZCode空提交仍须作为无进度跳过并派发新任务', status: result.status, failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, status: attempt.status, failure: attempt.failure, dispatches: attempt.dispatchPlans.length })) }))
  if (sealed) {
    const laterDispatches = f.store.listAttempts(f.operation.id).filter(attempt => attempt.number > originalAttemptNumber).flatMap(attempt => attempt.dispatchPlans)
    assert.equal(restartedWithoutMaterial, defect === 'sealed-unpublished', JSON.stringify(result.failure))
    assert.equal(laterDispatches.length, defect === 'sealed-unpublished' ? 1 : 0)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    if (defect !== 'sealed-unpublished') assert.equal(result.failure?.code, 'stale_result')
  }
  if (typedTransport && defect === 'no-commit') assert.equal(restartedWithoutMaterial, true, '精确已停EPIPE无真实进度仍应无稿派发')
  if (defect === 'provider-code') assert.equal(result.failure?.code, 'stale_result')
  if (defect.startsWith('no-progress-143-')) assert.equal(restartedWithoutMaterial, false, 'foreign/unknown stop不能借无进度越过认证')
  assert.equal(JSON.stringify(readRecord(oldSession)), oldRecordBytes)
  for (const { ref, bytes } of refs) assert.deepEqual(readEvidence(f.input.source.commonDir, ref), bytes)
  for (const [name, bytes] of Object.entries(nativeFiles)) assert.deepEqual(readFileSync(join(oldNativeRoot, name)), bytes)
  assert.deepEqual(readdirSync(oldNativeRoot, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort(), Object.keys(nativeFiles).sort(), '冷观察不新增protocol log或补封存')
  for (const prior of oldAttempts) assert.deepEqual(f.store.readAttempt(prior.id), prior)
  for (const resource of oldResources) assert.deepEqual(f.store.findResource(resource.attemptId, resource.plan.key), resource)
  if (archiveSource) {
    assert.equal(existsSync(oldPath), false, '材料读取后再次清除临时checkout')
    assert.equal(f.git('rev-parse', `refs/spex-archive/${oldSession}`), archivedRef)
  } else {
    assert.deepEqual(readFileSync(oldIndex), oldIndexBytes, '只读材料观察不得刷新原index')
    if (oldDraftBytes) assert.deepEqual(readFileSync(join(oldPath, oldDraftPath)), oldDraftBytes)
    assert.equal(execFileSync('git', ['-C', oldPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), latestHead)
  }
  const current = f.store.listAttempts(f.operation.id).at(-1)!, observed = (p1 && !older ? f.store.listAttempts(f.operation.id).flatMap(attempt => attempt.checkpointRefs) : current.checkpointRefs).map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.stage.endsWith(dirty ? ':stopped-physical-material-provenance' : ':stopped-git-material-provenance'))
  if (completedRpc) {
    if (!p1 || !materialExpected) { assert.equal(current.candidate, null); assert.equal(current.verification, null) }
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.ok(current.checkpointRefs.every(ref => !JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage.endsWith(':stopped-physical-material-provenance')))
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
    if (!materialExpected) {
      const skip = ['rpc-method', 'missing-exit', 'no-terminal', 'failed-terminal', 'cancelled-terminal', 'no-commit'].includes(defect) || completedP1Rpc && defect === 'dirty'
      assert.equal(restartedWithoutMaterial, skip, JSON.stringify({ message: '仅无资格/无进度来源可跳过，其余须明确拒绝', failure: result.failure }))
      if (['request', 'thread', 'turn', 'stop', 'failed-observation'].includes(defect)) assert.equal(result.failure?.code, 'checkpoint_artifact_binding')
      if (['rpc-proof', 'exit', 'idle', 'closed', 'idle-identity', 'terminal-kind', 'session', 'version', 'model', 'missing-dispatch-session', 'null-dispatch-thread', 'null-dispatch-turn', 'harness-thread'].includes(defect)) assert.equal(result.failure?.code, 'stale_result', JSON.stringify(result.failure))
      if (defect === 'dirty' && !p1) assert.equal(current.failure?.code, 'native_worktree_result_invalid')
      if (defect === 'terminal-json') {
        if (p1) assert.match(result.failure!.message, /JSON/)
        else assert.deepEqual(result.failure, { code: 'coordinator_failed', message: 'P0 行为校验未通过', kind: 'unsupported', evidenceRefs: [] })
      }
      if (['source', 'tests', 'schema'].includes(defect)) assert.match(result.failure!.message, p1 ? /已停物理草稿的owner\/seed、只读文件或index发生越界变化/ : /同步仅允许正常提交指定UTF8草稿文件/)
    }
  }
  if (defect === 'missing-exit' && p1) {
    const laterMaterial = f.store.listAttempts(f.operation.id).filter(attempt => attempt.number > originalAttemptNumber).flatMap(attempt => attempt.checkpointRefs)
      .map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string; resultRef?: { sha256: string } })
      .filter(wrapper => wrapper.stage?.endsWith(':stopped-physical-material-provenance') || wrapper.stage?.endsWith(':stopped-git-material-provenance'))
      .map(wrapper => JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef!).toString()) as { fromOperationId?: string; fromAttemptId?: string; nativePlanRef?: { sha256: string }; checkpointRef?: { sha256: string } })
    const reusedMissingExitCandidate = laterMaterial.some(material => material.fromOperationId === f.operation.id && material.fromAttemptId === missingExitCandidate!.resource.attemptId
      && material.nativePlanRef?.sha256 === missingExitCandidate!.resource.plan.planBlob.sha256 && material.checkpointRef?.sha256 === missingExitCandidate!.resource.checkpointRef.sha256)
    assert.equal(reusedMissingExitCandidate, false, 'missing-exit Native plan/checkpoint must not become stopped physical/Git provenance')
    assert.equal(current.candidate, null, '缺exit不能产生P1候选')
    assert.equal(current.verification, null, '缺exit不能产生P1验证')
    assert.equal(restartedWithoutMaterial, true, 'P1在缺exit候选未投影后沿原失败语义结束')
    return
  }
  if (p1 && !older && (!completedRpc || materialExpected)) {
    const wrapper = current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.stage === 'elaboration')!
    const result = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
    assert.equal(result.reviewPassed, true, JSON.stringify(result.failure)); assert(result.rounds.at(-1)?.draft?.resultCommit)
    assert.notEqual(result.rounds.at(-1)?.traces.find(trace => trace.purpose === 'elaboration_generate')?.sessionId, result.rounds.at(-1)?.traces.find(trace => trace.purpose === 'elaboration_review')?.sessionId)
    if (partitionedP1) {
      const dispatches = f.store.listAttempts(f.operation.id).flatMap(attempt => attempt.dispatchPlans)
      assert.equal(dispatches.filter(dispatch => dispatch.purpose === 'code_behavior_analyze').length, 1)
      assert.equal(dispatches.filter(dispatch => dispatch.purpose === 'code_behavior_review').length, 1)
      assert.equal(dispatches.some(dispatch => dispatch.purpose === 'code_generate'), false)
    }
  }
  if (older) { assert.equal(observed, undefined, '较旧物理来源即使在新fence晚观察，也不能覆盖更新正常Git稿'); return }
  if (!materialExpected) {
    assert.equal(observed, undefined)
    if (defect === 'no-progress-empty-commit-cancelled') {
      assert(f.store.listAttempts(f.operation.id).some(attempt => attempt.number > originalAttemptNumber && attempt.dispatchPlans.some(dispatch => dispatch.purpose === 'code_behavior_analyze')), '无进度空提交应在不复制旧稿/生成provenance后到达下一真实fixture dispatch')
    }
    return
  }
  assert(observed); const provenance = JSON.parse(readEvidence(f.input.source.commonDir, observed.resultRef).toString())
  assert.equal(dirty ? provenance.observedHeadCommit : provenance.resultCommit, latestHead); assert.equal(provenance.sourceKind, committedP1 ? 'stopped_git_draft' : dirty ? 'physical_draft' : 'git_draft'); assert.equal(provenance.approved, false); assert.equal(provenance.observationKind, zcode ? 'native-failure' : mode); assert.equal(provenance.draftSha256, contentHash(latest)); assert(provenance.observedAt > 0)
  if (coldP0) {
    assert.equal(provenance.indexSha256, contentHash(oldIndexBytes))
    assert.equal(provenance.committedDraft.oid, provenance.oid)
    assert.deepEqual(provenance.committedDraft.errors, [])
  }
  if (dirty) { assert.equal(provenance.resultCommit, undefined); assert.equal(provenance.oid, undefined); assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, provenance.materialRef).toString()).source, latest) }
  if (committedP1) {
    const oldAttempt = oldAttempts.find(attempt => attempt.number === originalAttemptNumber)!
    const oldResource = completedRpcResource ?? oldResources.find(resource => resource.attemptId === oldAttempt.id)!
    assert.equal(provenance.fromAttemptId, oldAttempt.id)
    assert.deepEqual(provenance.nativePlanRef, oldResource.plan.planBlob); assert.deepEqual(provenance.checkpointRef, oldResource.checkpointRef)
    assert.deepEqual(provenance.originalFailure, oldAttempt.failure)
    if (defect !== 'archived') assert.equal(provenance.indexSha256, contentHash(oldIndexBytes))
    assert.equal(provenance.oid, execFileSync('git', ['-C', f.root, 'rev-parse', `${latestHead}:${oldDraftPath}`], { encoding: 'utf8' }).trim())
    assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, provenance.materialRef).toString()).source, latest)
  }
  if (completedRpcResource) {
    assert.equal(provenance.fromAttemptId, completedRpcResource.attemptId)
    assert.deepEqual(provenance.nativePlanRef, completedRpcResource.plan.planBlob); assert.deepEqual(provenance.checkpointRef, completedRpcResource.checkpointRef)
    const originalFailure = oldAttempts.find(attempt => attempt.id === completedRpcResource.attemptId)!.failure!
    assert.deepEqual(provenance.originalFailure, p1 ? originalFailure : { code: originalFailure.code, kind: originalFailure.kind })
    assert.equal(provenance.oid, execFileSync('git', ['-C', f.root, 'rev-parse', `${latestHead}:${oldDraftPath}`], { encoding: 'utf8' }).trim())
  }
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const missingFinal of [false, true]) test(`P1失败summary的精确stopped Git稿跨attempt仍只作材料续改，不要求成功generation追踪 missingFinal=${missingFinal}`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 120000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'spec', 'claude:default')
  const originalText = `{FAILED_NATIVE_BUSINESS_DRAFT${'x'.repeat(38000)}`, calls: ElaborationSessionRequest[] = []
  f.options.runner = async request => {
    calls.push(request)
    if (request.purpose === 'elaboration_review') throw Object.assign(new Error('原Git稿实际续改后在独审入口停止'), { code: 'unsupported' })
    assert.equal(request.purpose, 'elaboration_generate')
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!, workspace = join(f.parent, `failed-summary-${calls.length}`), path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (attempt.number === 2) assert.equal(readFileSync(join(workspace, path), 'utf8'), originalText, '认证的失败summary原Git稿必须保留，不能从0或回更早材料')
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), attempt.number === 1 ? originalText : JSON.stringify(adaptElaborationNativeOutput(request, rows(original))))
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'failed summary fixture draft'], { stdio: 'pipe' })
    const worktree = nativeWorktreeResult(workspace, seed)
    if (attempt.number === 1) return rejectedReviewFixture(f, request, missingFinal ? undefined : '{"summary":7}', missingFinal ? 'Claude worktree success is missing required structured_output' : 'summary schema rejected after actual Git commit', worktree)
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, output = { summary: '在认证原稿上修复业务JSON' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `failed-summary-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options), attempts = f.store.listAttempts(f.operation.id), old = attempts[0]
  assert.equal(result.status, 'unsupported', JSON.stringify(result.failure))
  assert.deepEqual(calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  const resource = f.store.findResource(old.id, old.dispatchPlans[0].key)!, native = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  assert.equal(resource.phase, 'removed'); assert.equal(native.stop?.nativeStopped, true); assert.equal(native.result, undefined); assert.equal(native.failure?.rejectedOutput?.text, missingFinal ? undefined : '{"summary":7}')
  const wrapper = old.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }).find(entry => entry.stage === 'elaboration')!
  const saved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult, round = saved.rounds[0]
  assert.equal(round.output, null); assert.deepEqual(round.traces, []); assert.equal(round.candidate, null)
  assert.equal(readObject(f.input.source.commonDir, round.draft!.oid).toString('utf8'), originalText)
})

for (const corruptBinding of ['none', 'native', 'candidate'] as const) test(`P1越界独审跨多个attempt仅续同candidate审查，原generation按真实dispatch冷验 tamper=${corruptBinding}`, async t => {
  const historyPath = '.spec/project/frozen-history/spec.md'
  const history = '---\ntitle: 冻结历史说明\ncontract-schema: sync-v1\n---\n## raw source\n\n保留已接受的技术登记。\n\n## expanded spec\n\n旧轮进度5/5，实现待写。\n\n### VERIFY\n\n| id | command | cwd | timeout-ms |\n| --- | --- | --- | --- |\n| VERIFY-HISTORY-01 | ["node","--version"] | . | 1000 |\n'
  const verification = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(verification.kind, 'VERIFY')
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [{ definition: { id: verification.id, command: verification.command, cwd: verification.cwd, timeoutMs: verification.timeoutMs }, environment }, { definition: { id: 'VERIFY-HISTORY-01', command: ['node', '--version'], cwd: '.', timeoutMs: 1000 }, environment }]
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1', verifications, targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'frozen-history', path: historyPath }] }, undefined, 'code', 'claude:default', false, { [historyPath]: history })
  const calls: ElaborationSessionRequest[] = [], snapshots: { ref: string; value: ElaborationResult }[] = []
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const saved = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string; resultRef?: { sha256: string } }
    if (saved.stage === 'elaboration' && saved.resultRef) snapshots.push({ ref: saved.resultRef.sha256, value: JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) as ElaborationResult })
    if (corruptBinding === 'candidate' && saved.stage === 'elaboration' && snapshots.length === 1) {
      const value = structuredClone(snapshots[0].value); value.rounds[0].candidateDigest = contentHash('corrupted saved candidate digest')
      ref = writeEvidence(f.input.source.commonDir, { ...saved, resultRef: writeEvidence(f.input.source.commonDir, value) })
    }
    const result = checkpoint(fence, ref)
    if (corruptBinding === 'native' && saved.stage === 'elaboration' && snapshots.length === 1) {
      const listAttempts = f.store.listAttempts.bind(f.store)
      f.store.listAttempts = id => listAttempts(id).map(attempt => attempt.number !== 1 ? attempt : { ...attempt, dispatchPlans: attempt.dispatchPlans.map(dispatch => dispatch.purpose !== 'elaboration_generate' ? dispatch : { ...dispatch, requestDigest: contentHash('corrupted original Native request') }) })
    }
    return result
  }
  f.store.startGeneration = () => { throw Object.assign(new Error('在P1完成后停止，不运行P2或Docker'), { code: 'unsupported' }) }
  f.options.runner = async request => {
    calls.push(request)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    const identity = { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `scope-cold-${request.requestKey}`, turnId: 'turn' }
    if (request.purpose === 'elaboration_review') {
      const output = attempt.number < 3 ? { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'old-history-prose', kind: 'repair', message: '未变owner旧5/5/实现待写正文需要更新7/7，条款无需改', affectedIds: ['VERIFY-HISTORY-01'], evidence: `${historyPath}:14旧prose`, decision: '仅修冻结owner进度叙述，业务行和实现不变' }] } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { ...identity, output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    const seed = request.worktree!, draftPath = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `scope-cold-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }
      output = { changes: task.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保留导出义务', previousBehavior: '导出行为不变', sourceBehavior: '内部文字编辑', deliveryBehavior: '导出行为不变', evidence: 'src/export.js#ExportService', counterexample: '原结果仍保留' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }, reviewed = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: { changes: { id: string }[] } }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    } else {
      assert.equal(request.purpose, 'elaboration_generate'); assert.equal(attempt.number, 1, '后续attempt不得伪造新generate')
      output = { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '沿用完整冻结契约及已有边界', affectedIds: ['REQ-EXPORT-01'] })) }
    }
    mkdirSync(join(workspace, draftPath, '..'), { recursive: true }); writeFileSync(join(workspace, draftPath), JSON.stringify(output))
    execFileSync('git', ['-C', workspace, 'add', draftPath], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'scope cold fixture draft'], { stdio: 'pipe' })
    const receipt = { summary: '提交原草稿' }
    return { ...identity, output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'unsupported', JSON.stringify({ failure: result.failure, snapshots: snapshots.map(item => ({ status: item.value.status, failure: item.value.failure, findings: item.value.rounds.flatMap(round => round.findings) })) }))
  assert.equal(calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  if (corruptBinding !== 'none') {
    assert.equal(result.failure?.code, 'review_retry_binding')
    assert.equal(calls.filter(call => call.purpose === 'elaboration_review').length, 1, '原Native或candidate绑定失配后新attempt零派发')
    return
  }
  assert.equal(calls.filter(call => call.purpose === 'elaboration_review').length, 3)
  assert.equal(snapshots.length, 3); assert.ok(snapshots[2].value.reviewPassed)
  for (const snapshot of snapshots.slice(1)) {
    assert.equal(snapshot.value.candidateDigest, snapshots[0].value.candidateDigest)
    assert.deepEqual(snapshot.value.rounds[0].traces[0], snapshots[0].value.rounds[0].traces[0])
    assert.deepEqual(snapshot.value.changes, snapshots[0].value.changes)
  }
  assert.ok(snapshots[0].value.rounds[0].findings.some(issue => issue.code === 'review_scope'))
  assert.equal(snapshots[0].value.rounds[0].review!.verdict, 'repair')
  assert.equal(snapshots[2].value.changes.find(change => change.path === historyPath)!.source, history)
  assert.equal(calls.some(call => call.purpose === 'code_generate'), false); assert.deepEqual(f.store.listJournals(f.operation.id), [])
})

for (const partitioned of [false, true]) for (const keepRefactor of [false, true]) for (const formatPhase of !partitioned && !keepRefactor ? ['', 'code_behavior_analyze', 'code_behavior_review'] : ['']) test(`P1后置分类回审 ${partitioned ? 'partition' : 'whole'} ${keepRefactor ? '维持refactor恢复候选' : '重新分析allowed_change'} ${formatPhase}`, async t => {
  const plan = partitioned ? { version: 'sync-coordinator-v2' as const, direction: 'code_to_spec' as const, sourcePaths: ['src'], writePaths: ['.spec'], partitionPolicy: { version: 'sync-partition-policy-v1' as const, maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] } } : {}
  const f = await fixture(t, { maxAttempts: formatPhase ? 3 : 2, maxCalls: 20, maxRepairs: formatPhase ? 2 : 1, timeoutMs: 120_000 }, false, original, 'project', original, { ...plan, agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', partitioned)
  const calls: ElaborationSessionRequest[] = [], originalBlobs = readTree(f.input.source.commonDir, f.input.immutableTree)
  const draftTexts: string[] = []
  f.store.startGeneration = () => { throw Object.assign(new Error('P1已完整通过，fixture在实现前停止'), { code: 'unsupported' }) }
  f.store.expandContractScope = () => { throw Object.assign(new Error('P1已完整通过，fixture在扩域前停止'), { code: 'unsupported' }) }
  f.options.runner = async request => {
    calls.push(request)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    if (request.purpose === 'elaboration_review') {
      const output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }, dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `postgate-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    assert.ok(['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate'].includes(request.purpose), request.purpose)
    const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; postGateReview?: { analysisRef: { sha256: string }; resultRef: { sha256: string }; candidateDigest: string; findings: { finding: { code: string; path: string; itemId: string; severity: string }; before: unknown; after: unknown }[] }[] }
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `postgate-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      if (attempt.number === 2) {
        assert.equal(readFileSync(join(workspace, path), 'utf8'), draftTexts[0], '沿认证原P0 JSON续改')
        assert.equal(task.postGateReview?.length, 1)
        const feedback = task.postGateReview![0]
        assert.ok(feedback.analysisRef.sha256); assert.ok(feedback.resultRef.sha256); assert.ok(feedback.candidateDigest)
        const rejected = JSON.parse(readEvidence(f.input.source.commonDir, feedback.resultRef).toString()) as ElaborationResult
        assert.deepEqual(feedback.findings.map(item => item.finding), rejected.rounds.at(-1)!.findings.filter(finding => finding.code === 'refactor_business_meaning_changed'))
        assert.deepEqual(feedback.findings.map(item => ({ ...item.finding, message: '' })), [{ code: 'refactor_business_meaning_changed', message: '', nodeId: 'export-contract', path: contractPath, itemId: 'RULE-EXPORT-05', severity: 'error' }])
        assert.ok(feedback.findings[0].before); assert.ok(feedback.findings[0].after)
      }
      output = { changes: task.requiredChangedPaths.map(path => ({ kind: attempt.number >= 2 && !keepRefactor ? 'allowed_change' : 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保留原意，核实表示细节', previousBehavior: '原结果和失败事实', sourceBehavior: '普通序列化惯例', deliveryBehavior: '原结果和失败事实', evidence: 'src/export.js#ExportService', counterexample: '不得改变权限或AC/VERIFY' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const reviewed = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    } else {
      const changed = rows(original)
      if (attempt.number === 1 || !keepRefactor) changed.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-05')!.basis = '普通序列化惯例'
      output = adaptElaborationNativeOutput(request, changed)
    }
    if (attempt.number === 3 && request.purpose === formatPhase) assert.equal(readFileSync(join(workspace, path), 'utf8'), '{POSTGATE_ORIGINAL_INVALID_JSON')
    const text = request.purpose === formatPhase && attempt.number === 2 ? '{POSTGATE_ORIGINAL_INVALID_JSON' : JSON.stringify(output)
    if (request.purpose === 'code_behavior_analyze') draftTexts.push(text)
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text)
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'postgate fixture draft'], { stdio: 'pipe' })
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, receipt = { summary: '正常提交fixture草稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `postgate-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(calls.filter(call => call.purpose === 'code_behavior_analyze').length, formatPhase === 'code_behavior_analyze' ? 3 : 2, JSON.stringify({ failure: result.failure, calls: calls.map(call => call.purpose) }))
  assert.equal(calls.filter(call => call.purpose === 'code_behavior_review').length, formatPhase === 'code_behavior_review' ? 3 : 2, JSON.stringify({ failure: result.failure, calls: calls.map(call => call.purpose) }))
  assert.equal(calls.filter(call => call.purpose === 'elaboration_review').length, 1)
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 0)
  const analyses = calls.filter(call => call.purpose === 'code_behavior_analyze')
  assert.notEqual(analyses[0].inputDigest, analyses[1].inputDigest)
  const elaborations = calls.filter(call => call.purpose === 'elaboration_generate')
  assert.notEqual(elaborations[0].inputDigest, elaborations[1].inputDigest, '新analysisRef使旧P1身份失效')
  const finalStage = f.store.listAttempts(f.operation.id).at(-1)!.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find((entry: { stage: string }) => entry.stage === 'elaboration')
  const accepted = JSON.parse(readEvidence(f.input.source.commonDir, finalStage.resultRef).toString()) as ElaborationResult
  assert.equal(accepted.structurePassed, true); assert.equal(accepted.reviewPassed, true)
  assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree), originalBlobs)
  assert.deepEqual(readTree(f.input.source.commonDir, (await captureInputSnapshot(f.root)).immutableTree), originalBlobs, '原源码/测试的path、mode、OID及absence逐项不变')
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const partitioned of [false, true]) for (const invalidBinding of partitioned ? ['', 'missing-ref', 'foreign-owner'] : ['']) test(`rendered P1旧短errors经真实coordinator传完整诊断 ${partitioned ? 'partition' : 'whole'} ${invalidBinding}`, async t => {
  const plan = partitioned ? { version: 'sync-coordinator-v2' as const, direction: 'code_to_spec' as const, sourcePaths: ['src'], writePaths: ['.spec'], partitionPolicy: { version: 'sync-partition-policy-v1' as const, maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] } } : {}
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 12, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, { ...plan, agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', partitioned)
  const originalRunner = f.options.runner!, calls: ElaborationSessionRequest[] = []
  let historic: { ref: { sha256: string }; bytes: Buffer; findings: import('@spexcode/spec-core/contracts').ContractFinding[] } | undefined
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }
    if (!historic && (partitioned ? /^partition:.*:elaboration$/.test(wrapper.stage) : wrapper.stage === 'elaboration')) {
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
      const round = saved.rounds.at(-1)!
      assert.ok(round.candidate); assert.ok(round.draft); assert.equal(saved.status, 'exhausted')
      const findings = structuredClone(round.findings)
      if (invalidBinding === 'missing-ref') delete saved.partitionBinding!.analysisRef
      if (invalidBinding === 'foreign-owner') saved.partitionBinding!.partitionId = 'another-owner'
      round.draft.errors = round.draft.errors.map(({ code, message }) => ({ code, message }))
      const oldRef = writeEvidence(f.input.source.commonDir, saved)
      historic = { ref: oldRef, bytes: readEvidence(f.input.source.commonDir, oldRef), findings }
      return checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef: oldRef }), artifacts: [{ kind: 'json', ref: oldRef }, ...syncCheckpointArtifacts(saved, oldRef)] })
    }
    return checkpoint(fence, ref)
  }
  f.options.runner = async request => {
    calls.push(request)
    if (request.purpose === 'elaboration_review') throw Object.assign(new Error('完整诊断已到达实际runner，在P1独审入口停止'), { code: 'unsupported' })
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    const workspace = join(f.parent, `short-errors-${calls.length}`), path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    let produced: ElaborationSessionResult
    if (request.purpose.startsWith('code_behavior_')) produced = await originalRunner({ ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) })
    else {
      assert.equal(request.purpose, 'elaboration_generate')
      const generated = rows(original)
      if (attempt.number === 1) generated.changes[0].tables.RULE.find(row => row.id === (invalidBinding ? 'RULE-EXPORT-05' : 'RULE-EXPORT-06'))!.basis = '无关P1漂移'
      else {
        assert.ok(historic)
        assert.equal(request.prompt.includes(`"runtimeFindings":${JSON.stringify(historic.findings)}`), !invalidBinding, '缺refs或非本owner不打开原round诊断')
        assert.ok(historic.findings.some(finding => finding.path === contractPath && finding.itemId === (invalidBinding ? 'RULE-EXPORT-05' : 'RULE-EXPORT-06') && finding.severity === 'error'))
        if (invalidBinding === 'foreign-owner') assert.equal(existsSync(join(workspace, path)), false)
        else assert.ok(readFileSync(join(workspace, path), 'utf8').includes('无关P1漂移'))
      }
      produced = { sessionId: '', threadId: '', turnId: '', output: adaptElaborationNativeOutput(request, generated), resultDigest: '' }
    }
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(produced.output))
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'short errors fixture draft'], { stdio: 'pipe' })
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, output = { summary: '真实Git续改' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `short-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(calls.filter(call => call.purpose === 'code_behavior_analyze').length, 1, '无关affectedId、缺refs或非本owner漂移不能重授P0')
  assert.equal(calls.filter(call => call.purpose === 'elaboration_review').length, 1, JSON.stringify({ status: result.status, failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, failure: attempt.failure })), calls: calls.map(call => call.purpose) }))
  assert.deepEqual(readEvidence(f.input.source.commonDir, historic!.ref), historic!.bytes)
  const first = f.store.listAttempts(f.operation.id)[0]
  const source = JSON.parse(historic!.bytes.toString()) as ElaborationResult
  assert.ok(source.rounds[0].draft!.errors.every(error => !('path' in error) && !('severity' in error)))
  assert.equal(source.prior, null); assert.equal(first.status, 'superseded')
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 0)
})

test('P1分类质疑不重签已有reserved P0请求', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 12, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') (output as GeneratedElaboration).changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-05')!.basis = '表示变化'
    return output
  })
  const claim = f.store.claimAttempt.bind(f.store), originalDigest = contentHash('historical reserved immutable request')
  let reservedKey = ''
  f.store.claimAttempt = input => {
    const next = claim(input)
    if (next.attempt.number === 2) {
      reservedKey = `sync:${next.attempt.id}:analysis:code_behavior_analyze`
      f.store.reserveDispatch(next.fence, { key: reservedKey, purpose: 'code_behavior_analyze', requestDigest: originalDigest })
    }
    return next
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(f.calls.filter(call => call.purpose === 'code_behavior_analyze').length, 1)
  const reserved = f.store.listAttempts(f.operation.id).at(-1)!.dispatchPlans.find(dispatch => dispatch.key === reservedKey)!
  assert.equal(reserved.requestDigest, originalDigest); assert.equal(reserved.session, null)
  assert.match(result.failure?.message ?? '', /request|dispatch|派发|请求/i)
})

test('P1分类质疑只重做受影响P0，保留兄弟已审原ref', async t => {
  const importPath = '.spec/project/import-contract/spec.md', importSpec = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 24, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 2 }, commitTrigger: { before: null, paths: ['src/export.js', 'src/import.js'] },
  }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', true, { [importPath]: importSpec, 'src/import.js': 'export class ImportService {}\n', 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('ExportService', 'ImportService').replaceAll('export.js', 'import.js') })
  const calls: { attempt: number; domain: string; purpose: string }[] = []
  f.options.runner = async request => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths?: string[]; targets?: { nodeId: string }[]; postGateReview?: unknown[] } : null
    const domain = task?.requiredChangedPaths?.some(path => path.includes('import')) || task?.targets?.some(target => target.nodeId === 'import-contract') || request.purpose === 'elaboration_review' && request.prompt.includes('REQ-IMPORT-01') ? 'IMPORT' : 'EXPORT'
    calls.push({ attempt: attempt.number, domain, purpose: request.purpose })
    if (request.purpose === 'elaboration_review') {
      if (attempt.number === 2) throw Object.assign(new Error('新P0及兄弟来源已验证，在P1重审入口停止'), { code: 'unsupported' })
      const output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }, dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `sibling-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    assert.ok(['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate'].includes(request.purpose))
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      assert.equal(Boolean(task?.postGateReview?.length), attempt.number === 2 && domain === 'EXPORT')
      output = { changes: task!.requiredChangedPaths!.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${domain}-05`], ruleIds: [`RULE-${domain}-05`], originalIntent: '保原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '不得改变权限' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map(change => change.id), findings: [] }
    } else {
      const generated = rows(domain === 'IMPORT' ? importSpec : original, domain === 'IMPORT' ? importPath : contractPath)
      generated.changes[0].nodeId = domain === 'IMPORT' ? 'import-contract' : 'export-contract'
      for (const entry of generated.applicability) entry.affectedIds = [`REQ-${domain}-01`]
      if (attempt.number === 1 && domain === 'EXPORT') generated.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-05')!.basis = 'P1错误漂移'
      output = adaptElaborationNativeOutput(request, generated)
    }
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `sibling-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(output))
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'sibling fixture draft'], { stdio: 'pipe' })
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, receipt = { summary: '正常提交' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `sibling-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(calls.filter(call => call.domain === 'EXPORT' && call.purpose === 'code_behavior_analyze').length, 2, JSON.stringify({ calls, failure: result.failure }))
  assert.equal(calls.filter(call => call.domain === 'IMPORT' && call.purpose === 'code_behavior_analyze').length, 1)
  const aggregates = f.store.listAttempts(f.operation.id).map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find((entry: { stage: string }) => entry.stage === 'analysis')).map((entry: { resultRef: { sha256: string } }) => JSON.parse(readEvidence(f.input.source.commonDir, entry.resultRef).toString()) as import('./writeback-types.js').CodeBehaviorAnalysis)
  const sibling = (analysis: import('./writeback-types.js').CodeBehaviorAnalysis) => analysis.partitionEvidence!.find(owner => owner.analysis.changes.some(change => change.paths.includes('src/import.js')))!
  assert.deepEqual(sibling(aggregates[0]).analysisRef, sibling(aggregates[1]).analysisRef)
  assert.deepEqual(sibling(aggregates[0]).analysis, sibling(aggregates[1]).analysis)
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 0)
})
type FrozenGenerationPrompt = { contracts: unknown[]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] }; files: [string, string][]; priorContext?: { role: 'source_before' | 'verified_delivery'; pairId?: string; snapshot: { id: string; immutableTree: string }; entries: { path: string; mode: string; digest: string }[]; files: [string, string][] }[] }
const promptInput = (request: ElaborationSessionRequest): FrozenGenerationPrompt => JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as FrozenGenerationPrompt
function unlock(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) { chmodSync(join(root, entry.name), 0o700); unlock(join(root, entry.name)) }
  chmodSync(root, 0o700)
}
function gitReadCounter(directory: string): { reset(): void; entries(): string[]; restore(): void } {
  const bin = join(directory, 'git-read-counter-bin'), log = join(directory, 'git-read-counter.log'), wrapper = join(bin, 'git')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  mkdirSync(bin, { mode: 0o700 }); writeFileSync(log, '')
  writeFileSync(wrapper, '#!/bin/sh\ncase " $* " in\n  *" ls-tree -rlz --full-tree "*) last=""; for arg do last="$arg"; done; printf "tree:%s\\n" "$last" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\n  *" ls-files -z --full-name --cached --others --exclude-standard "*) printf "capture\\n" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\n  *" cat-file blob "*) printf "single-blob\\n" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\n  *" cat-file --batch-check "*) printf "blob-metadata\\n" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\nesac\nexec "$SPEX_SYNC_TEST_REAL_GIT" "$@"\n')
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
async function fixture(t: test.TestContext, budget: import('./operation-types.js').SyncBudget = { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300_000 }, adopt = false, specSource = original, projectId = 'project', factsSource = specSource, planPatch: Partial<SyncCoordinatorPlan> = {}, controlledEdit?: { original: string; replacement: string; intent: string; testPath: string }, origin: 'spec' | 'code' | 'combined' = 'spec', model?: string, precise = false, extraSpecs: Readonly<Record<string, string>> = {}, committedInput = false, syncSettings?: import('./settings.js').SyncSettings, postCommitOracleEdit = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-coordinator-'))), root = join(parent, 'source'), managedRoot = join(parent, 'managed'), artifactRoot = join(parent, 'artifacts')
  mkdirSync(root); mkdirSync(managedRoot, { mode: 0o700 }); mkdirSync(artifactRoot, { mode: 0o700 }); cpSync(fixturePath, root, { recursive: true })
  const targetPath = `.spec/${projectId}/export-contract/spec.md`
  if (projectId !== 'export') renameSync(join(root, '.spec/export'), join(root, `.spec/${projectId}`))
  writeFileSync(join(root, targetPath), specSource)
  for (const [path, source] of Object.entries(extraSpecs)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), source) }
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], ...(syncSettings ? { sync: syncSettings } : {}) }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'coordinator fixture'); git('config', 'user.email', 'coordinator@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture')
  git('switch', '-c', 'node/source')
  if (adopt) {
    execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init', '.', '--harness', 'none'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
    git('add', '.'); git('commit', '-m', 'adopt explicit no-harness delivery')
  }
  const priorCommitCount = Number(git('rev-list', '--count', 'HEAD'))
  const sourcePath = join(root, 'src/export.js')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// staged user request\n`); git('add', 'src/export.js')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// unstaged user request\n`)
  if (committedInput) { git('add', 'src/export.js'); git('commit', '-m', 'freeze original clean source input') }
  if (postCommitOracleEdit) writeFileSync(join(root, 'tests/export.test.mjs'), readFileSync(join(root, 'tests/export.test.mjs'), 'utf8') + '\n')
  const input = await captureInputSnapshot(root), index = readFileSync(join(root, '.git/index')), bytes = readFileSync(sourcePath)
  const definition = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(definition.kind, 'VERIFY')
  const plan: SyncCoordinatorPlan = { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: targetPath }], readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec', 'src'], facts: [{ source: 'decision:EXPORT-POLICY', text: factsSource }], verifications: [{ definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment: { version: 'trusted-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } }], mandatoryTests: [{ verificationId: definition.id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }] }
  Object.assign(plan, planPatch)
  let requestBlob
  if (controlledEdit) {
    plan.writePaths = [...plan.writePaths, controlledEdit.testPath]; plan.readPaths = [...plan.readPaths, controlledEdit.testPath]
    plan.verifications = [...plan.verifications, { ...plan.verifications[0], definition: { id: 'VERIFY-EXPORT-02', command: ['node', '--test', controlledEdit.testPath], cwd: '.', timeoutMs: 10000 } }]
    plan.facts = [...plan.facts, { source: 'decision:CONTROLLED-EDIT', text: controlledEdit.intent }]
    guardControlledRequestPath(input, targetPath)
    const lines = parseFrontmatter(readFileSync(join(root, targetPath), 'utf8')).body.trim().split('\n'), index = lines.indexOf(controlledEdit.original)
    assert.ok(index >= 0, '用户选中的原始正文行必须真实存在')
    const prepared = await prepareSpecBodyEdit(root, 'export-contract', { startLine: index + 1, endLine: index + 1, original: controlledEdit.original, replacement: controlledEdit.replacement })
    const request = prepareControlledRequest(input, prepared, { kind: 'user_edit', requestId: `controlled-${contentHash(controlledEdit.intent)}`, nodeId: 'export-contract', intent: controlledEdit.intent })
    assert.equal(request.changed, true); requestBlob = request.requestBlob!
  }
  const protocol = openProtocol(join(parent, 'sync.sqlite')); await migrateSyncStore(protocol, { backupPath: join(parent, 'db-backup') })
  let store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) })
  const exactScope = plan.executionScope ?? { paths: plan.targets.map(target => target.path), contractIds: [] as string[], flowIds: [] as string[] }
  const selected = precise ? store.readBaselineSelection(input.source, [...readTree(input.source.commonDir, input.immutableTree).map(entry => ({ kind: 'path' as const, path: entry.path })), ...exactScope.contractIds.map(id => ({ kind: 'contract' as const, id })), ...exactScope.flowIds.map(id => ({ kind: 'flow' as const, id }))]) : null
  if (selected && !('selection' in selected)) throw new Error(selected.failure.message)
  let operation = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: input.id, rootCauseId: input.id, origin, ...(model ? { model } : {}), budget, managedRoot, ...(selected && 'selection' in selected ? { baselineSelection: selected.selection, executionScope: exactScope } : {}), ...(requestBlob ? { requestBlob } : {}) }))
  if (precise) operation = store.ackDispatch(input.source.repositoryId, operation.dispatchMessageId)
  const calls: ElaborationSessionRequest[] = []
  let transform: ((output: unknown, request: ElaborationSessionRequest) => unknown | Promise<unknown>) | undefined
  const run: ElaborationRunner = async request => {
    calls.push(request)
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      output = { changes: context.changedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '遵守导出明确原意', previousBehavior: '导出任务结果不变', sourceBehavior: '内部实现文字编辑，导出结果不变', deliveryBehavior: '共同已验证语义不变', evidence: `冻结源码/断言 ${path}`, counterexample: '重复COMPLETE保首次结果，未改变此断言' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const value = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: { changes: { id: string }[] } }
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      output = { inputDigest: request.inputDigest, analysisDigest: value.analysisDigest, verdict: 'accept', checkedPaths: context.changedPaths, checkedChangeIds: value.analysis.changes.map(item => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') output = rows(original, targetPath)
    else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'implementation_plan') output = { version: 'sync-implementation-plan-v1', paths: ['src/planned-new.js'] }
    else if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), source = new Map(frozen.files).get('src/export.js')!
      const change = (path: string, content: string) => { const entry = frozen.manifest.entries.find(item => item.path === path)!; return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, mode: entry ? null : '100644', content } }
      output = { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change('src/export.js', `${source}\n// independently reviewed generated implementation\n`)] }
    } else {
      const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as { inputId: string; candidate: { digest: string } }
      output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: promptInput(request).readyIds, findings: [] }
    }
    if (transform) output = await transform(output, request)
    output = adaptElaborationNativeOutput(request, output)
    const attempt = store.readAttempt(store.readOperation(operation.id).currentAttemptId!)
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `independent-thread-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const emptyTools = { trustedRuntimeRoot: join(parent, 'unset'), toolEntry: join(parent, 'unset/cli.js'), canonicalHooksDir: join(parent, 'unset/hooks') }
  const options: SyncCoordinatorOptions = { plan, readCurrentPlan: () => plan, managedRoot, artifactRoot, tools: emptyTools, runner: run, leaseMs: 30_000, heartbeatMs: 1000 }
  const realTools = async () => {
    const runtime = await freezeDeliveryRuntime(join(parent, 'runtime'))
    options.tools = { trustedRuntimeRoot: runtime.trustedRuntimeRoot, toolEntry: runtime.toolEntry, canonicalHooksDir: runtime.canonicalHooksDir, gitPath: '/usr/bin/git' }
    for (const name of readdirSync(runtime.canonicalHooksDir)) { copyFileSync(join(runtime.canonicalHooksDir, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755) }
    return runtime
  }
  let closed = false
  t.after(() => { if (!closed) protocol.close(); unlock(parent); rmSync(parent, { recursive: true, force: true }) })
  return { root, parent, managedRoot, artifactRoot, input, index, bytes, protocol, store, operation, plan, options, calls, git, priorCommitCount, realTools, closeForRestart: () => { protocol.close(); closed = true }, useStore: (next: SyncStore) => { store = next }, useOperation: (next: typeof operation) => { operation = next }, transform: (fn: typeof transform) => { transform = fn } }
}

async function rejectedReviewFixture(f: Awaited<ReturnType<typeof fixture>>, request: ElaborationSessionRequest, text: string | undefined, message = 'invalid_json', failedWorktree?: ElaborationSessionResult['worktree']): Promise<ElaborationSessionResult> {
  const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
  const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
  const records = new Map<string, NativeRunRecord>()
  return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
    readRecord: id => records.get(id) ?? null,
    cancel: async () => { throw new Error('fixture禁止实际Native控制') },
    run: async actual => {
      const execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key), identity = { threadId: `failed-${sessionId}`, turnId: 'failed-turn' }
      const prompt = actual.worktree ? nativeWorktreePrompt(actual.prompt, actual.worktree) : actual.prompt
      const base = actual.worktree?.baseCommit ?? actual.base
      const rejectedOutput = text === undefined ? undefined : rejectedFinalOutput(text, prompt, execution, identity)
      const record: NativeRunRecord = { session: sessionId, status: 'error', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, ...(base?.trim() ? { base: base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'failed', errorCode: 'structured_output_format_invalid', error: message, rejectedOutput, ...(failedWorktree ? { failedWorktree } : {}), cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'stopped' } } }
      records.set(sessionId, record)
      writeRecord({ governed: false, worktreePath: f.root, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'codex', runtimeStartToken: null, stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null, ...record })
      throw new StructuredSessionError('structured_output_format_invalid', message, { sessionId, ...identity, rejectedOutput, ...(failedWorktree ? { failedWorktree } : {}) })
    },
  } })(request)
}

function committedDraftFixture(f: Awaited<ReturnType<typeof fixture>>, request: ElaborationSessionRequest, output: unknown, workspace: string): ReturnType<typeof nativeWorktreeResult> {
  const seed = request.worktree!, path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
  f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
  mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(output), 'utf8')
  execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' })
  execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'real Native fixture draft'], { stdio: 'pipe' })
  return nativeWorktreeResult(workspace, seed)
}

test('固定操作模型到达行为/P1/P2及全部独审，独立会话与调用预算保持', async t => {
  const oracle = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'AC')!
  const [testPath, testId] = oracle.test.split('#')
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { mandatoryTests: [{ verificationId: oracle.command, testPath, testId }] }, undefined, 'code', 'gpt-6.1-terra')
  const contexts: { implementationWritePaths: string[]; readonlyTestPaths: string[] }[] = []
  f.transform((output, request) => {
    if (['elaboration_generate', 'elaboration_review'].includes(request.purpose)) {
      contexts.push(JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]))
    }
    if (request.purpose === 'code_review') throw Object.assign(new Error('本用例在V3前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.operation.phase, 'failed'); assert.equal(result.operation.model, 'gpt-6.1-terra')
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review'])
  assert.ok(f.calls.every(call => call.model === 'gpt-6.1-terra' && call.effort === 'high'))
  assert.equal(result.operation.callsUsed, 6)
  const dispatches = f.store.listAttempts(f.operation.id)[0].dispatchPlans
  assert.equal(new Set(dispatches.map(dispatch => dispatch.sessionCreateKey)).size, 6)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.equal(contexts.length, 2)
  for (const context of contexts) {
    assert.deepEqual(context.implementationWritePaths, [...new Set(f.options.plan.writePaths)].sort())
    assert.deepEqual(context.readonlyTestPaths, [...new Set(f.options.plan.mandatoryTests.map(test => test.testPath))].sort())
  }
})

for (const gapMode of ['none', 'peer', 'task'] as const) test(`增量V1从完整Git候选核root覆盖，未改peer不扩大Task派发或验证登记 ${gapMode}`, async t => {
  const rootPath = '.spec/project/spec.md', managedTest = 'generated-tests/task.test.mjs'
  const definitions = [
    { name: 'TASK', nodeId: 'export-contract', path: contractPath, source: 'src/export.js', test: 'tests/export.test.mjs' },
    { name: 'CLI', nodeId: 'cli-contract', path: '.spec/project/cli-contract/spec.md', source: 'src/cli.js', test: 'tests/cli.test.mjs' },
    { name: 'STORE', nodeId: 'storage-contract', path: '.spec/project/storage-contract/spec.md', source: 'src/storage.js', test: 'tests/storage.test.mjs' },
  ]
  const specs = definitions.map(item => original
    .replace(/^(\| FLOW-EXPORT-[^|]+ \| )REQ-EXPORT-01 \|/gm, `$1REQ-EXPORT-01,REQ-ROOT-${item.name} |`)
    .replace(/^(\| AC-EXPORT-[^|]+ \| )/gm, `$1REQ-ROOT-${item.name},`)
    .replaceAll('EXPORT', item.name === 'TASK' ? 'EXPORT' : item.name)
    .replaceAll('export-job', `${item.name.toLowerCase()}-job`)
    .replaceAll('export-contract', item.nodeId).replaceAll('src/export.js', item.source).replaceAll('tests/export.test.mjs', item.test)
    .replaceAll(`decision:${item.name}-POLICY`, 'decision:EXPORT-POLICY'))
  specs[0] = specs[0].replace('tests/export.test.mjs#AC-EXPORT-01', `${managedTest}#AC-EXPORT-01`)
  if (gapMode !== 'none') specs[1] += `\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| GAP-CLI-REMOTE | missing_fact | 尚未确定远端重试政策 | RULE-${gapMode === 'peer' ? 'CLI' : 'EXPORT'}-06 | 原意没有定义该政策 | 需要业务裁决 | user:raw | REQ-CLI-01 |\n`
  const root = `---\ntitle: 增量父接口\ncontract-schema: sync-v1\n---\n## raw source\n\nTask、CLI与Storage各自完成原功能。\n\n## expanded spec\n\n仅变更Task，保留CLI与Storage。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n${definitions.map(item => `| REQ-ROOT-${item.name} | ${item.name}完成 | user:raw | 保持既有政策 | 子模块完成 | - |`).join('\n')}\n`
  const extras: Record<string, string> = { [rootPath]: root }
  for (let index = 1; index < definitions.length; index++) {
    const item = definitions[index]
    extras[item.path] = specs[index]
    extras[item.source] = readFileSync(new URL('src/export.js', fixturePath), 'utf8')
    extras[item.test] = readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', item.name).replaceAll('src/export.js', item.source)
  }
  const verifications = specs.map((source, index) => {
    const definition = parseContract({ nodeId: definitions[index].nodeId, path: definitions[index].path, source }).contract!.items.find(item => item.kind === 'VERIFY')!
    assert.equal(definition.kind, 'VERIFY')
    return { definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment: { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 131072 } }
  })
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120_000 }, false, specs[0], 'project', specs[0], {
    version: 'sync-coordinator-v2', direction: 'spec_to_code',
    readPaths: [rootPath, contractPath, 'src/export.js', 'tests/export.test.mjs', '.spec/spexcode.json'],
    writePaths: [contractPath, 'src/export.js', managedTest], sourcePaths: ['src/export.js'],
    executionScope: { paths: [contractPath, 'src/export.js', managedTest], contractIds: [], flowIds: [] },
    verifications,
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 },
  }, undefined, 'spec', undefined, false, extras)
  let reviewed = false
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') return rows(specs[0])
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), source = new Map(frozen.files).get('src/export.js')!
      assert.ok(!frozen.files.some(([path]) => definitions.slice(1).some(peer => peer.path === path)), 'Agent保留局部读集')
      const change = (path: string, content: string) => {
        const entry = frozen.manifest.entries.find(item => item.path === path)
        return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, mode: entry ? null : '100644', content }
      }
      return { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change('src/export.js', `${source}\n// Task increment\n`), change(managedTest, "import test from 'node:test'\ntest('AC-EXPORT-01', () => {})\n")] }
    }
    if (request.purpose === 'code_review') {
      reviewed = true
      assert.ok(promptInput(request).readyIds.every(id => !/CLI|STORE/.test(id)), '只派发Task业务')
      throw Object.assign(new Error('受控回归已到V1之后的Task独审，不替代真实V2–V4'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const attempt = f.store.listAttempts(f.operation.id)[0]
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string; resultRef?: { sha256: string } }[]
  const generation = stages.find(stage => stage.stage === 'generation')
  const elaboration = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'elaboration')!.resultRef!).toString()) as ElaborationResult
  assert.ok(generation, JSON.stringify({ status: result.status, failure: result.failure ?? attempt.failure, elaborationFailure: elaboration.failure, calls: f.calls.map(call => call.purpose) }))
  const generated = JSON.parse(readEvidence(f.input.source.commonDir, generation.resultRef!).toString()) as import('./generation-types.js').GenerationResult
  if (gapMode === 'task') {
    assert.equal(reviewed, false)
    assert.equal(generated.candidateValidated, false)
    assert.ok(generated.validationFindings.some(finding => finding.code === 'unresolved-gap' && finding.itemId === 'GAP-CLI-REMOTE'), 'peer GAP影响Task依赖时仍拒绝')
    return
  }
  assert.equal(reviewed, true, JSON.stringify({ failure: result.failure, findings: generated.validationFindings, calls: f.calls.map(call => call.purpose) }))
  assert.equal(generated.candidateValidated, true)
  assert.deepEqual(generated.validationFindings.filter(finding => finding.severity === 'error'), [])
  const before = readTree(f.input.source.commonDir, f.input.immutableTree), after = readTree(f.input.source.commonDir, generated.candidate!.tree)
  for (const path of [rootPath, ...definitions.slice(1).flatMap(item => [item.path, item.source, item.test]), 'tests/export.test.mjs']) assert.deepEqual(after.find(entry => entry.path === path), before.find(entry => entry.path === path), path)
  assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, generated.candidate!.actualDiffBlob).toString()).map((change: { path: string }) => change.path).sort(), [contractPath, 'src/export.js', managedTest].sort())
  assert.deepEqual(f.plan.verifications.map(item => item.definition.id), ['VERIFY-EXPORT-01', 'VERIFY-CLI-01', 'VERIFY-STORE-01'])
  assert.ok(!result.operation.scope.paths.some(path => definitions.slice(1).some(peer => peer.path === path || peer.source === path || peer.test === path)))
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'code_generate').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'code_review').length, 1)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  if (gapMode === 'peer') return
  const acceptedFiles = new Map(before.filter(entry => f.plan.readPaths.includes(entry.path)).map(entry => [entry.path, readObject(f.input.source.commonDir, entry.oid).toString('utf8')]))
  for (const change of elaboration.changes) acceptedFiles.set(change.path, change.source)
  const accepted = await readFrozenContracts(f.root, acceptedFiles), policy = { newNodeRawSources: new Map<string, string>(), verifications: [f.plan.verifications[0].definition] }
  const complete = await continuationCoordinator.candidateContext(f.store, f.operation, generated.candidate!)
  assert.deepEqual(await continuationCoordinator.checkCandidateContractIntent(f.operation, generated.candidate!, accepted, complete, policy), [], '未改peer VERIFY不自动登记，也不因本轮未登记误拒')
  const req = specs[0].match(/^\| REQ-EXPORT-01 .*$/m)![0]
  const variants = [
    { path: contractPath, content: specs[0].replace(req, `${req}\n| REQ-UNAPPROVED-01 | 候选自批业务 | user:raw | 额外约束 | 额外结果 | - |`), expected: 'generation-unaccepted-item' },
    { path: definitions[1].path, content: null, expected: 'generation-raw-changed' },
    { path: definitions[1].path, content: specs[1].replace(' | 10000 |', ' | 10001 |'), expected: 'generation-protected-meaning-changed' },
  ]
  for (const variant of variants) {
    const entry = before.find(entry => entry.path === variant.path)!
    const candidate = freezeCandidate(f.input, { version: 'sync-files-v1', changes: [{ path: variant.path, content: variant.content, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null }] }, { paths: [variant.path], contractIds: [], flowIds: [] })
    const context = await continuationCoordinator.candidateContext(f.store, f.operation, candidate)
    const findings = await continuationCoordinator.checkCandidateContractIntent(f.operation, candidate, accepted, context, policy)
    assert.ok(findings.some(finding => finding.code === variant.expected), JSON.stringify(findings))
    if (variant.content === null) assert.ok(context.findings.some(finding => finding.code === 'missing-requirement-flow' && finding.itemId === 'REQ-ROOT-CLI'), '真实缺失覆盖仍拒绝')
  }
})

for (const kind of ['conflict', 'coverage_gap'] as const) test(`raw-only已审 ${kind} 无既有ID时明确阻塞，不派P1或消耗新attempt`, async t => {
  const raw = original.split('## expanded spec')[0]
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 }, false, raw, 'project', raw, {}, undefined, 'code')
  assert.equal(f.operation.previousBaselinePair, null)
  assert.deepEqual(f.operation.scope.contractIds, [])
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; affectedIds: string[]; ruleIds: string[] }[] }
      value.changes.forEach(change => { change.kind = kind; change.affectedIds = []; change.ruleIds = [] })
      return value
    }
    if (request.purpose !== 'code_behavior_review') throw Object.assign(new Error('未关联的已审业务发现不得晋级P1/生成'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, kind === 'conflict' ? 'conflicted' : 'needs_input')
  assert.equal(result.failure!.code, 'unbound_behavior_finding')
  assert.equal(result.failure!.kind, kind === 'conflict' ? 'conflict' : 'missing_input')
  const findings = JSON.parse(result.failure!.message).findings as { id: string; kind: string; affectedIds: string[]; paths: string[]; evidence: string; counterexample: string }[]
  assert.ok(findings.length)
  assert.ok(findings.every(finding => finding.kind === kind && !finding.affectedIds.length && finding.paths.length && finding.evidence && finding.counterexample))
  const analysis = JSON.parse(readEvidence(f.input.source.commonDir, result.failure!.evidenceRefs[0]).toString()) as { reviewPassed: boolean; findings: unknown[] }
  assert.equal(analysis.reviewPassed, true)
  assert.deepEqual(findings, analysis.findings)
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
  assert.equal(f.store.listAttempts(f.operation.id).length, 1)
  assert.equal(result.operation.callsUsed, 2)
  assert.equal(result.receipt, undefined)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.ok(f.store.listAttempts(f.operation.id).every(attempt => !attempt.candidate && !attempt.verification))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('可信目录授权/完整readset固定，同source不同policy不混，uncovered dirty和可改oracle拒绝', async t => {
  const f = await fixture(t)
  assert.equal(f.operation.policyDigest, syncPlanDigest(f.plan))
  assert.deepEqual(f.operation.scope.paths, ['.spec', 'src'])
  const options = { ingressKey: 'next', rootCauseId: 'next', origin: 'spec' as const, budget: f.operation.budget, managedRoot: f.managedRoot }
  const omittedSourcePlan = { ...f.plan, readPaths: ['.spec'] }
  const closure = await prepareSyncAdmission(f.input, omittedSourcePlan, options)
  assert.notEqual(closure.policyDigest, f.operation.policyDigest)
  assert.deepEqual(closure.scope, f.operation.scope, '闭包补齐不能扩大写范围')
  const changedSource = Buffer.concat([f.bytes, Buffer.from('\n// owned source changes the readset\n')])
  writeFileSync(join(f.root, 'src/export.js'), changedSource)
  const changedInput = await captureInputSnapshot(f.root)
  const changedClosure = await prepareSyncAdmission(changedInput, omittedSourcePlan, { ...options, ingressKey: 'changed-owned-source', rootCauseId: 'changed-owned-source' })
  assert.notEqual(changedClosure.readSetDigest, closure.readSetDigest, '省略显式source readPath后，owned source仍进入readSet')
  assert.equal(changedClosure.policyDigest, closure.policyDigest)
  assert.deepEqual(changedClosure.scope, closure.scope)
  writeFileSync(join(f.root, 'src/export.js'), f.bytes)
  writeFileSync(join(f.root, 'unclaimed.txt'), '真实闭包外输入\n')
  const uncoveredInput = await captureInputSnapshot(f.root)
  await assert.rejects(prepareSyncAdmission(uncoveredInput, omittedSourcePlan, { ...options, ingressKey: 'uncovered-input', rootCauseId: 'uncovered-input' }), /uncovered_source_change/)
  rmSync(join(f.root, 'unclaimed.txt'))
  const oracleInput = await captureInputSnapshot(f.root)
  await assert.rejects(prepareSyncAdmission(oracleInput, { ...omittedSourcePlan, writePaths: ['.spec', 'src', 'tests'] }, options), /oracle_binding/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('P4精确接入使用同一快照并区分读取基线与实际写入范围', async t => {
  const f = await fixture(t)
  const selected = f.store.readBaselineSelection(f.input.source, [{ kind: 'path', path: contractPath }, { kind: 'path', path: 'src/export.js' }, { kind: 'path', path: 'tests/export.test.mjs' }])
  assert.ok('selection' in selected)
  const scope = { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] }
  const options = { ingressKey: 'selected-admission', rootCauseId: 'selected-admission', origin: 'spec' as const, budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }
  await assert.rejects(prepareSyncAdmission(f.input, f.plan, options), /execution_scope_missing/)
  const admission = await prepareSyncAdmission(f.input, { ...f.plan, executionScope: scope }, options)
  assert.equal(admission.input, f.input)
  assert.deepEqual(admission.baselineSelection, selected.selection)
  assert.deepEqual(admission.scope, scope)
  assert.notEqual(admission.readSetDigest, f.operation.readSetDigest)
  assert.equal(admission.scope.paths.includes('tests/export.test.mjs'), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('P4当前输入只比较实际闭包，保留无关编辑与提交并拒绝相关index变化', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, 'src/export.js', 'tests/export.test.mjs', '.spec/spexcode.json'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const result = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in result)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'current-closure', rootCauseId: 'current-closure', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: result.selection }))
  writeFileSync(join(f.root, 'notes.txt'), '作者的独立说明\n')
  f.git('add', 'notes.txt'); f.git('commit', '--only', 'notes.txt', '-m', 'unrelated author commit')
  const current = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index'))
  assert.notEqual(current.id, operation.input.id)
  assert.equal(await isSyncInputCurrent(operation, current, plan), true)
  assert.equal(await isSyncInputCurrent(f.operation, current, f.plan), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  f.git('add', 'src/export.js')
  const staged = await captureInputSnapshot(f.root)
  assert.equal(staged.immutableTree, current.immutableTree)
  assert.equal(await isSyncInputCurrent(operation, staged, plan), false)
})

test('冻结读集通过一次批量元数据读取物化原提交中的多文件范围', async t => {
  const f = await fixture(t), bulk = join(f.root, 'bulk')
  mkdirSync(bulk)
  for (let index = 0; index < 48; index++) writeFileSync(join(bulk, `${index}.txt`), `原始文件 ${index}\n`)
  writeFileSync(join(bulk, 'alias.txt'), '原始文件 0\n')
  writeFileSync(join(bulk, 'binary.dat'), Buffer.from([0, 255]))
  f.git('add', 'bulk'); f.git('commit', '--only', 'bulk', '-m', 'commit a larger read scope')
  const input = await captureInputSnapshot(f.root, { committed: true })
  const plan = { ...f.plan, readPaths: [...f.plan.readPaths, 'bulk'] }
  const options = { ingressKey: 'bulk-read', rootCauseId: 'bulk-read', origin: 'spec' as const, budget: f.operation.budget, managedRoot: f.managedRoot }
  const counter = gitReadCounter(f.parent)
  try {
    const admitted = await prepareSyncAdmission(input, plan, options), commands = counter.entries()
    assert.ok(commands.filter(command => command === 'single-blob').length <= 1, `原读集 ${admitted.readSetDigest} 仍逐文件读取: ${commands.filter(command => command === 'single-blob').length}`)
    assert.equal(commands.filter(command => command === 'blob-metadata').length, 1)
    writeFileSync(join(bulk, '0.txt'), '后续未提交的作者字节\n'); f.git('add', 'bulk/0.txt')
    counter.reset()
    assert.equal((await prepareSyncAdmission(input, plan, options)).readSetDigest, admitted.readSetDigest)
    assert.equal(counter.entries().filter(command => command === 'blob-metadata').length, 1, '每次重新核对原对象，不能信跨调用缓存')
  } finally { counter.restore() }
})

test('P4当前性完整复核快照并仅在本次调用内复用同OID树读取', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, 'src/export.js', 'tests/export.test.mjs', '.spec/spexcode.json'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const baseline = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path' as const, path })))
  assert.ok('selection' in baseline)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'currentness-read-reuse', rootCauseId: 'currentness-read-reuse', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: baseline.selection }))
  const counter = gitReadCounter(f.parent)
  try {
    assert.equal(await isSyncInputCurrent(operation, operation.input, plan), true)
    const sameTreeReads = counter.entries().filter(entry => entry.startsWith('tree:')).map(entry => entry.slice('tree:'.length))

    writeFileSync(join(f.root, 'scope-external.txt'), '不在闭包中的真实Git字节\n')
    const changed = await captureInputSnapshot(f.root)
    assert.notEqual(changed.immutableTree, operation.input.immutableTree)
    counter.reset()
    assert.equal(await isSyncInputCurrent(operation, changed, plan), true)
    const differentTreeReads = counter.entries().filter(entry => entry.startsWith('tree:')).map(entry => entry.slice('tree:'.length))
    assert.deepEqual([
      [sameTreeReads.length, sameTreeReads.filter(tree => tree === operation.input.immutableTree).length, new Set(sameTreeReads).size],
      [differentTreeReads.length, differentTreeReads.filter(tree => tree === operation.input.immutableTree).length, differentTreeReads.filter(tree => tree === changed.immutableTree).length],
    ], [[4, 2, 3], [4, 1, 1]], '完整验证同OID旧/当前快照；异OID快照各读一次，index/HEAD复用仅限本调用')

    counter.reset()
    assert.equal(await isSyncInputCurrent(operation, changed, plan), true)
    assert.deepEqual(counter.entries().filter(entry => entry.startsWith('tree:')), differentTreeReads.map(tree => `tree:${tree}`), '下一次调用重新读取所有原/现快照、index与HEAD对象')
    for (const [input, error] of [
      [{ ...operation.input, manifestBlob: { sha256: 'f'.repeat(64) } }, /缺失证据/],
      [{ ...operation.input, contentDigest: '0'.repeat(64) }, /快照 manifest\/contentDigest 不匹配/],
      [{ ...operation.input, id: '0'.repeat(64) }, /快照身份摘要不匹配/],
      [{ ...operation.input, captureKind: 'commit' as const }, /提交快照必须绑定同一 HEAD tree/],
    ] as const) {
      await assert.rejects(isSyncInputCurrent({ ...operation, input }, changed, plan), error, '装配输入仍完整核对原快照')
      await assert.rejects(isSyncInputCurrent(operation, input, plan), error, '相同tree OID不能掩盖当前快照绑定损坏')
    }
  } finally { counter.restore() }
})

test('kernel mutex阻止同operation双编排，尚无native派发', async t => {
  const f = await fixture(t), locks = join(f.artifactRoot, '.locks'); mkdirSync(locks, { mode: 0o700 })
  const lock = claimFileMutex(join(locks, `${contentHash(f.operation.id)}.sqlite`))!
  try { assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'busy'); assert.equal(f.calls.length, 0) } finally { lock.release() }
})

for (const mode of ['live', 'restart', 'prior-repair'] as const) test(`P3细化独审容量失败 ${mode} 同预算重新独立细化，不把未拒候选当业务seed`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  let activeStore = f.store
  const capacityAttempt = mode === 'prior-repair' ? 2 : 1, originalBudget = structuredClone(f.operation.budget), originalDeadline = f.operation.deadlineAtMs
  f.transform((output, request) => {
    const number = activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!).number
    if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: 'allowed_change' })) }
    if (request.purpose === 'elaboration_generate') {
      if (number === capacityAttempt) {
        if (mode === 'prior-repair') assert.match(request.prompt, /原具体失败:[\s\S]*result_boundary_missing/)
        const candidate = structuredClone(output) as GeneratedElaboration
        candidate.changes[0].tables.AC.push({ ...candidate.changes[0].tables.AC[0], id: 'AC-EXPORT-SUMMARY-01', test: 'tests/export.test.mjs#TEST-EXPORT-SUMMARY-01' })
        return candidate
      }
      if (number > capacityAttempt) assert.doesNotMatch(request.prompt, /已结算的拒绝候选|result_boundary_missing/)
    }
    if (request.purpose === 'elaboration_review') {
      if (number === capacityAttempt) throw Object.assign(new Error('Selected model is at capacity. Please try a different model.'), { code: 'failed' })
      if (mode === 'prior-repair' && number === 1) return { ...(output as object), verdict: 'repair', findings: [{ code: 'result_boundary_missing', kind: 'repair', message: '应核对重复完成边界', affectedIds: ['RULE-EXPORT-05'], evidence: '冻结结果政策要求首次结果稳定', decision: '保持原结果义务并重新独审' }] }
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#ExportService', evidence: '测试只验证容量失败后的真实协调续行', counterexample: '不冒称Docker或交付已通过', message: 'fixture stops before V3' }] }
    return output
  })
  if (mode === 'restart') {
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'failed')) throw new Error('fixture process boundary after durable capacity failure')
      return claim(request)
    }
    const interrupted = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(interrupted.status, 'unsupported')
    assert.equal(interrupted.failure?.code, 'coordinator_failed')
    assert.equal(interrupted.failure?.message, 'fixture process boundary after durable capacity failure')
    assert.equal(activeStore.listAttempts(f.operation.id).find(attempt => attempt.number === 1)?.failure?.code, 'failed')
    assert.equal(interrupted.operation.callsUsed, 4)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.receipt, undefined)
  assert.deepEqual(result.operation.budget, originalBudget); assert.equal(result.operation.deadlineAtMs, originalDeadline)
  assert.equal(result.operation.callsUsed, mode === 'prior-repair' ? 10 : 8)
  const attempts = activeStore.listAttempts(f.operation.id)
  assert.equal(attempts.length, capacityAttempt + 1)
  const elaborations = attempts.map(attempt => {
    const stage = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
    return JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
  })
  const rejected = elaborations[capacityAttempt - 1], fresh = elaborations[capacityAttempt]
  assert.equal(rejected.structurePassed, true); assert.equal(rejected.reviewPassed, false); assert.equal(rejected.rounds[0].review, null)
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'missing-test-case' && issue.severity === 'error'))
  assert.equal(rejected.failure?.code, 'failed'); assert.equal(fresh.reviewPassed, true); assert.equal(fresh.prior, null)
  assert.equal(fresh.inputDigest, rejected.inputDigest); assert.equal(fresh.rounds[0].traces.length, 2)
  assert.notEqual(fresh.rounds[0].traces[0].sessionId, fresh.rounds[0].traces[1].sessionId)
  assert.notEqual(fresh.rounds[0].traces[0].sessionId, rejected.rounds[0].traces[0].sessionId)
  if (mode === 'live') {
    const { execution, files, ...snapshot } = JSON.parse(f.calls.find(call => call.purpose === 'elaboration_generate')!.prompt.split('冻结业务输入:\n')[1])
    const { targets, ...frozenFields } = snapshot
    const frozen = { ...frozenFields, targets: targets.map(({ targetIndex: _targetIndex, ...target }: { targetIndex: number; nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }) => target) }
    const last = rejected.rounds[0]
    const replayInput = { ...frozen, ...execution, files: new Map<string, string>(files), requestKey: 'invalid-infrastructure-seed' }
    await assert.rejects(elaborate(replayInput, { seed: { settled: true, requestKey: `sync:${attempts[0].id}:elaborate`, inputDigest: rejected.inputDigest, candidateDigest: last.candidateDigest!, candidate: last.candidate!, output: last.output, findings: last.findings, review: last.review, traces: last.traces }, runner: async () => assert.fail('无具体业务拒绝的seed不得派发') }), /续修种子必须保留具体被拒绝发现/)
  }
  if (mode === 'prior-repair') { assert.equal(elaborations[0].failure?.code, 'repair_budget_exhausted'); assert.ok(rejected.prior); assert.equal(elaborations[0].reviewPassed, false) }
  const beforeReplay = f.calls.length
  assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'conflicted'); assert.equal(f.calls.length, beforeReplay)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal((await captureInputSnapshot(f.root)).id, f.input.id); assert.equal(activeStore.listJournals(f.operation.id).length, 0)
})

for (const stop of ['budget', 'cancel'] as const) test(`P3细化独审容量失败 ${stop} 保冻结终止，不重复派发`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 4, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_review') {
      if (stop === 'cancel') f.store.requestControl(f.operation.id, 'cancel')
      throw Object.assign(new Error('Selected model is at capacity. Please try a different model.'), { code: 'failed' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, stop === 'budget' ? 'budget_exhausted' : 'cancelled', JSON.stringify(result.failure)); assert.equal(result.operation.callsUsed, 4)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, result.status); assert.equal(f.calls.length, 4)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('缺planBlob的旧queued操作持久unsupported，不借当前计划猜恢复或派发', async t => {
  const f = await fixture(t)
  f.store.requestControl(f.operation.id, 'cancel'); f.store.discardDispatch(f.operation.id, f.operation.dispatchMessageId)
  const old = f.store.admitAndEnqueue({ ingressKey: 'legacy-planless', rootCauseId: 'legacy-planless', origin: 'spec', input: f.input, scope: f.operation.scope, budget: f.operation.budget, policyDigest: contentHash('legacy-planless-policy'), impactDigest: f.operation.impactDigest, readSetDigest: f.operation.readSetDigest, delivery: null, deliveryPlan: f.operation.deliveryPlan })
  const result = await runSyncOperation(f.store, old.id, f.options)
  assert.equal(result.status, 'unsupported'); assert.equal(result.failure?.code, 'plan_missing')
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure!.code, 'plan_missing'); assert.equal(f.calls.length, 0)
})

test('真实V1/意图门禁拒绝弱化AC、命令及错误关系，有限预算，不进入review/V3或业务交付', async t => {
  for (const mutation of ['assertion', 'command', 'related']) await t.test(mutation, async t => {
    const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 })
    f.transform((output, request) => {
      if (request.purpose !== 'code_generate') return output
      const value = output as { changes: { path: string; content: string }[] }
      const spec = value.changes.find(change => change.path === contractPath)!
      spec.content = mutation === 'assertion' ? spec.content.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限') : mutation === 'command' ? spec.content.replace('["node","--test","tests/export.test.mjs"]', '["node","-e","true"]') : spec.content.replace('code:\n', 'related:\n  - REQ-EXPORT-01\ncode:\n')
      return value
    })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, 'budget_exhausted', JSON.stringify(result.failure))
    assert.equal(f.calls.filter(call => call.purpose === 'code_review').length, 0)
    for (const plan of f.store.readAttempt(result.operation.currentAttemptId!).dispatchPlans) if (plan.session) assert.deepEqual(Object.keys(plan.session).sort(), ['sessionId', 'threadId', 'turnId'])
    const generations = f.store.listAttempts(f.operation.id).flatMap(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(stage => stage.stage === 'generation').map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as import('./generation-types.js').GenerationResult))
    assert.ok(generations.some(value => value.validationFindings.some(item => mutation === 'related' ? item.code === 'integrity' : item.code === 'generation-protected-meaning-changed' || item.code === 'generation-verification-unregistered')))
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.ok(f.store.pinnedBlobRefs().length > 3)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  })
})

test('租约heartbeat贯穿长调用，取消不派发下一阶段，重入不重复调用', async t => {
  const f = await fixture(t)
  f.options.leaseMs = 1500; f.options.heartbeatMs = 50
  f.transform(async (output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const expiry = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!).expiresAtMs
      await new Promise(resolve => setTimeout(resolve, 1800))
      assert.ok(f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!).expiresAtMs > expiry)
      f.store.requestControl(f.operation.id, 'cancel')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return output
  })
  const stopped = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped.failure))
  assert.equal(f.calls.length, 1)
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'cancelled')
  assert.equal(f.calls.length, 1); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

const docker = { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 240000 }

for (const oraclePasses of [true, false]) test(`代码→规格记录未执行声明仍执行原生 Docker 保护测试 oraclePasses=${oraclePasses}`, docker, async t => {
  const raw = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const oraclePath = 'tests/independent-oracle.test.mjs', verificationId = 'VERIFY-INDEPENDENT-01', testId = 'ORACLE-INDEPENDENT-01'
  const oracle = `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { ExportService } from '../src/export.js'\ntest('${testId} frozen oracle', () => assert.equal(typeof ExportService, '${oraclePasses ? 'function' : 'object'}'))\n`
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 6, maxRepairs: 0, timeoutMs: 120000 }, false, raw, 'project', original,
    { version: 'sync-coordinator-v2', agentWorkflow: 'native-worktree-v1', direction: 'code_to_spec', writePaths: ['.spec'], sourcePaths: ['src'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 } },
    undefined, 'code', 'claude:default', true, { [oraclePath]: oracle }, true)
  const { environment } = f.plan.verifications[0]
  const image = process.env.SPEX_READONLY_COVERAGE_TEST_IMAGE ?? environment.image
  const plan = { ...f.plan, verifications: [{ environment: { ...environment, image }, definition: { id: verificationId, command: ['node', '--test', oraclePath], cwd: '.', timeoutMs: 30_000 } }], mandatoryTests: [{ verificationId, testPath: oraclePath, testId }] }
  f.store.requestControl(f.operation.id, 'cancel')
  const selection = f.store.readBusinessBaselineSelection(f.operation.id)!
  const admission = await prepareSyncAdmission(f.input, plan, { ingressKey: 'coverage-only', rootCauseId: 'coverage-only', origin: 'code', model: 'claude:default', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selection, executionScope: f.operation.scope, recordUnverifiedCoverage: true })
  const admitted = f.store.admitAndEnqueue(admission)
  const operation = f.store.ackDispatch(f.input.source.repositoryId, admitted.dispatchMessageId)
  f.useOperation(operation)
  await f.realTools()
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      for (const change of (output as { changes: { affectedIds: string[]; ruleIds: string[] }[] }).changes) {
        change.affectedIds = []; change.ruleIds = []
      }
    }
    if (request.purpose === 'elaboration_generate') for (const change of (output as GeneratedElaboration).changes) {
      change.tables.AC = []; change.tables.VERIFY = []
    }
    return output
  })
  const runner = f.options.runner!
  f.options.runner = async request => {
    if (request.purpose === 'code_generate') assert.fail('只读同步不得生成实现')
    if (request.purpose === 'code_review') {
      f.calls.push(request)
      assert.match(request.prompt, /未执行|缺少可运行测试/)
      const { inputId, candidateDigest, requiredIds } = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0]) as { inputId: string; candidateDigest: string; requiredIds: string[] }
      const output = { inputId, candidateDigest, verdict: 'accept', checkedIds: requiredIds, findings: [] }
      const attempt = f.store.readAttempt(f.store.readOperation(operation.id).currentAttemptId!)
      const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `review-${dispatch.sessionCreateKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    const result = await runner(request.purpose.startsWith('code_behavior_') ? { ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) } : request)
    if (!request.worktree || !/草稿文件=/.test(request.prompt)) return result
    const worktree = committedDraftFixture(f, request, result.output, join(f.parent, `coverage-draft-${f.calls.length}`))
    const output = { summary: '已提交草稿' }
    return { ...result, output, resultDigest: contentHash(JSON.stringify(output)), worktree }
  }
  const outcome = await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(outcome.status, oraclePasses ? 'workspace_synced' : 'failed', JSON.stringify({ failure: outcome.failure, calls: f.calls.map(request => request.purpose) }))
  const attempt = f.store.readAttempt(outcome.operation.currentAttemptId!)
  assert.ok(attempt.candidate)
  const protectedEntries = (tree: string) => readTree(f.input.source.commonDir, tree).filter(entry => !entry.path.startsWith('.spec/'))
  assert.deepEqual(protectedEntries(attempt.candidate.tree), protectedEntries(f.input.immutableTree))
  const v3 = readSyncCheckpoints(f.store, outcome.operation, attempt).json.map(entry => entry.value as { stage?: string; resultRef: BlobRef }).find(value => value.stage === `v3:${verificationId}`)!
  const dockerResult = JSON.parse(readEvidence(f.input.source.commonDir, v3.resultRef).toString())
  assert.equal(dockerResult.status, oraclePasses ? 'passed' : 'failed')
  assert.equal(dockerResult.evidence.environment.driver, 'docker')
  if (!oraclePasses) { assert.equal(f.store.listJournals(operation.id).length, 0); return }
  const verification = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString()) as import('./operation-types.js').VerificationResultBlob
  assert.deepEqual(verification.layers.map(layer => [layer.layer, layer.verdict]), ['V1', 'V2', 'V3', 'V4'].map(layer => [layer, 'pass']))
  assert.ok(verification.unexecutedContractIds?.includes('REQ-EXPORT-01'))
  assert.deepEqual(dockerResult.evidence.tests.map((item: { testId: string }) => item.testId), [testId])
  const deliveredCommit = outcome.receipt?.actualCommit
  assert.ok(deliveredCommit)
  assert.deepEqual(protectedEntries(deliveredCommit), protectedEntries(f.input.immutableTree))
})

test('P4精确queued经已审null扩展、四层Docker验证与真实receipt保持原始index', docker, async t => {
  const f = await fixture(t); await f.realTools()
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-docker-ready', rootCauseId: 'p4-docker-ready', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  const unacknowledged = await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(unacknowledged.status, 'busy'); assert.equal(f.calls.length, 0)
  for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === operation.id) break }
  const result = await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ result, attempts: f.store.listAttempts(operation.id).map(attempt => attempt.failure) }))
  assert.ok(result.receipt)
  assert.notEqual(result.operation.baselineSelection!.digest, selected.selection.digest)
  assert.ok(result.operation.contractScopeExpansions!.some(expansion => expansion.contractIds.includes('AC-EXPORT-03')))
  const attempt = f.store.readAttempt(result.operation.currentAttemptId!), verification = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString())
  assert.equal(verification.baselineSelectionDigest, result.operation.baselineSelection!.digest)
  assert.equal(verification.layers.every((layer: { verdict: string }) => layer.verdict === 'pass'), true)
  assert.equal(f.store.listJournals(operation.id)[0].plan.expectedBaselineSelectionDigest, result.operation.baselineSelection!.digest)
  assert.equal(result.operation.deliveredScope.paths.includes('tests/export.test.mjs'), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})
test('历史合成created资源经原生精确notStarted回执安全回收，不重派发', async t => {
  const f = await fixture(t)
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 10000, expectedMessageId: f.operation.dispatchMessageId })
  const request = { root: f.root, base: f.input.headCommit, prompt: '固定资源恢复请求', schema: { type: 'object' }, requestKey: 'pending-created-native', inputDigest: contentHash('fixed-input'), purpose: 'elaboration_generate', timeoutMs: 10000 }
  const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const identity = { operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, candidateDigest: null }
  const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
  const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
  const plannedRef = writeEvidence(f.input.source.commonDir, checkpoint)
  const resource = f.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: plannedRef })
  const createdRef = writeEvidence(f.input.source.commonDir, { ...checkpoint, phase: 'created', nativeState: 'queued' })
  f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: plannedRef, checkpointRef: createdRef })
  f.store.requestControl(f.operation.id, 'cancel')
  const before = f.store.readOperation(f.operation.id)
  const cleanupOnly = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(cleanupOnly.status, 'cancelled'); assert.deepEqual(cleanupOnly.operation, before)
  const removed = f.store.findResource(claimed.attempt.id, request.requestKey)!
  const proof = JSON.parse(readEvidence(f.input.source.commonDir, removed.checkpointRef).toString()) as NativeRunCheckpoint
  assert.equal(proof.creationTermination?.nativeStatus, 'notStarted')
  assert.equal(proof.creationTermination?.cleanupComplete, true)
  assert.equal(proof.creationTermination?.nativeStopped, true)
  assert.equal(proof.creationTermination?.sessionId, expectedSessionId)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'cancelled'); assert.equal(result.operation.phase, 'cancelled')
  assert.equal(f.store.findResource(claimed.attempt.id, request.requestKey)!.phase, 'removed')
  assert.equal(f.store.listRecoverableResources().length, 0); assert.equal(f.calls.length, 0)
})

for (const unlimited of [false, true]) test(`模型调用期限从冻结预算派生 unlimited=${unlimited}，原调用配置只约束有限预算`, async t => {
  const f = await fixture(t, unlimited ? { mode: 'unlimited' } : { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.options.callTimeoutMs = 1200000
  f.transform((output, request) => {
    if (request.purpose === 'code_review') throw Object.assign(new Error('仅核模型调用链，在独审接缝停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'unsupported')
  for (const purpose of ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review']) assert.ok(f.calls.some(call => call.purpose === purpose), purpose)
  assert.ok(f.calls.every(call => call.timeoutMs === (unlimited ? null : 1200000)), JSON.stringify(f.calls.map(call => ({ purpose: call.purpose, timeoutMs: call.timeoutMs }))))
  assert.equal(result.operation.deadlineAtMs === null, unlimited)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('unlimited多轮P1独审及v2预算预检后真实Docker交付，重启恢复原receipt且无总deadline', docker, async t => {
  const f = await fixture(t, { mode: 'unlimited' }, true, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'] })
  await f.realTools()
  f.options.callTimeoutMs = 1200000
  let store = f.store
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_review' && attempt.number <= 2) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'fixture-repair', kind: 'repair', message: '同原意内修正当前说明', affectedIds: ['REQ-EXPORT-01'], evidence: '确定性独审发现', decision: '修正后重新独审' }] }
    return output
  })
  const first = await runSyncOperation(store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('fixture真实commit后结算中断') } } })
  assert.equal(first.status, 'recovery_required', JSON.stringify(first.failure)); assert.equal(first.operation.deadlineAtMs, null)
  assert.equal(store.listAttempts(f.operation.id).length, 3)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_review').length, 3)
  assert.ok(f.calls.every(call => call.timeoutMs === null))
  const callCount = f.calls.length, commit = f.git('rev-parse', first.operation.deliveryPlan.branch)
  const stages = store.readAttempt(first.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const generationBudget = stages.find(stage => stage.stage === 'partition-generation-budget')
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, generationBudget.resultRef).toString()).remainingCalls, null)
  const originalBudget = structuredClone(first.operation.budget)
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  const recovered = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(recovered.operation.deadlineAtMs, null); assert.deepEqual(recovered.operation.budget, originalBudget)
  assert.equal(f.calls.length, callCount); assert.equal(recovered.operation.callsUsed, callCount)
  assert.equal(store.listJournals(f.operation.id).length, 1); assert.equal(store.listRecoverableResources().length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  assert.deepEqual((await runSyncOperation(store, f.operation.id, f.options)).receipt, recovered.receipt); assert.equal(f.calls.length, callCount)
})

test('真实Docker→真实固定CLI hooks→私有完整交付，source/index保留，receipt重入不重复native/commit', docker, async t => {
  const f = await fixture(t, undefined, true); await f.realTools()
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, attemptFailure: f.store.readAttempt(result.operation.currentAttemptId!).failure, commandEvidence: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => typeof value.status === 'number' || value.kind === 'private-delivery-prepare') }))
  assert.ok(result.receipt); assert.equal(f.calls.length, 4)
  assert.ok(readFileSync(join(result.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8').includes('independently reviewed'))
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  const replay = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.calls.length, 4)
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  const automatic = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'new-automatic-ingress', rootCauseId: 'new-automatic-ingress', origin: result.operation.origin, budget: { ...result.operation.budget, maxCalls: 99 }, managedRoot: f.managedRoot, previousBaselinePair: f.store.readBaseline(f.input.source) })
  assert.notDeepEqual(automatic.deliveryPlan, result.operation.deliveryPlan)
  assert.notEqual(automatic.readSetDigest, result.operation.readSetDigest, '真实交付细化进入新composed读集合，但source未变')
  const unchanged = f.store.admitAndEnqueue(automatic)
  assert.equal(unchanged.id, result.operation.id); assert.equal(unchanged.callsUsed, 4); assert.deepEqual(unchanged.budget, result.operation.budget)
  const aliasReplay = await prepareSyncAdmission(f.input, f.plan, { ingressKey: automatic.ingressKey, rootCauseId: automatic.rootCauseId, origin: automatic.origin, budget: automatic.budget, managedRoot: f.managedRoot, previousBaselinePair: automatic.previousBaselinePair })
  assert.equal(f.store.admitAndEnqueue({ ...aliasReplay, deliveryPlan: automatic.deliveryPlan }).id, unchanged.id)
  assert.equal(f.store.listOperations(f.input.source.repositoryId).length, 1); assert.equal(f.store.nextDispatch(f.input.source.repositoryId), null)
})

test('真实断言失败进入新attempt有限修复，保留失败输出，成功四层证据并同预算结算', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限'))
    }
    if (request.purpose !== 'code_generate') return output
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    if (attempt.number === 1) {
      const value = output as { changes: { path: string; content: string }[] }
      value.changes.find(change => change.path === 'src/export.js')!.content = value.changes.find(change => change.path === 'src/export.js')!.content.replace("if (!actor) throw new Error('forbidden');", "if (actor) throw new Error('forbidden');")
    } else assert.ok(request.prompt.includes('verification_failed'))
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(result.failure))
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).number, 2)
  assert.equal(result.operation.callsUsed, 6); assert.equal(p1Calls, 1); assert.equal(f.store.listRecoverableResources().length, 0)
  const inputs = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(inputs[0].contracts)), contentHash(JSON.stringify(inputs[1].contracts)))
  assert.deepEqual(inputs[0].elaboratedSpecs, inputs[1].elaboratedSpecs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('V4复采发现输入中途变化，无业务journal/commit，原staged index不变', docker, async t => {
  const f = await fixture(t); await f.realTools()
  f.transform((output, request) => { if (request.purpose === 'code_review') writeFileSync(join(f.root, 'src/export.js'), `${f.bytes.toString()}\n// new human edit during validation\n`); return output })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.failure?.code, 'input_changed')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('指导更新不重做旧analysis已验证的applying交付，真实Git与SQLite恢复仍沿原receipt', docker, async t => {
  const f = await fixture(t, undefined, true, original, 'project', original, {}, undefined, 'code'); await f.realTools()
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (value.stage === 'analysis') { delete value.guidanceContractVersion; ref = writeEvidence(f.input.source.commonDir, value) }
    return checkpoint(fence, ref)
  }
  const failed = await runSyncOperation(f.store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('实际commit后中断结算') } } })
  assert.equal(failed.status, 'recovery_required', JSON.stringify(failed.failure))
  const commit = f.git('rev-parse', failed.operation.deliveryPlan.branch), calls = f.calls.length
  assert.ok(f.store.readAttempt(failed.operation.currentAttemptId!).checkpointRefs.some(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()); return value.stage === 'analysis' && !value.guidanceContractVersion }))
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  const recovered = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(f.calls.length, calls); assert.equal(recovered.operation.callsUsed, failed.operation.callsUsed)
  assert.deepEqual(recovered.operation.budget, failed.operation.budget); assert.equal(recovered.operation.deadlineAtMs, failed.operation.deadlineAtMs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
})

test('真实commit后DB未settle中断，恢复既有journal不重复生成/提交', docker, async t => {
  const f = await fixture(t); await f.realTools()
  const failed = await runSyncOperation(f.store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('actual commit crash') } } })
  assert.equal(failed.status, 'recovery_required', JSON.stringify(failed.failure))
  const commit = f.git('rev-parse', failed.operation.deliveryPlan.branch)
  const before = f.store.readOperation(f.operation.id)
  const recovered = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(recovered.operation.control, before.control); assert.equal(recovered.operation.callsUsed, before.callsUsed); assert.equal(recovered.operation.deadlineAtMs, before.deadlineAtMs); assert.deepEqual(recovered.operation.input, before.input)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(f.calls.length, 4); assert.equal(Number(f.git('rev-list', '--count', failed.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
})

test('GAP只阻重试业务分支，共享文件仍真实交付ready完整FLOW，receipt不含blocked IDs', docker, async t => {
  const gapSource = `${original}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-RETRY | missing_fact | 是否允许失败后重试 | RULE-EXPORT-06,TR-EXPORT-FAILED-RETRY,AC-EXPORT-08 | 用户未定义重试政策 | 明确重试权限及attempt身份 | user:raw | REQ-EXPORT-01 |\n`
  const f = await fixture(t, undefined, false, gapSource); await f.realTools()
  f.transform((output, request) => request.purpose === 'elaboration_generate' ? rows(gapSource) : request.purpose === 'elaboration_review' ? { verdict: 'needs_input', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'retry_policy', kind: 'missing_fact', message: '重试政策需要用户确认', affectedIds: ['RULE-EXPORT-06'], evidence: 'raw未明确失败后恢复政策', decision: '明确重试政策' }] } : output)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'needs_input', JSON.stringify({ failure: result.failure, stages: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => value.rounds || value.validationFindings).map(value => ({ status: value.status, failure: value.failure, findings: value.validationFindings ?? value.rounds.flatMap((round: { findings: unknown[] }) => round.findings), blocked: value.blockedStructureFindings })) })); assert.ok(result.receipt)
  assert.ok(result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-01'))
  assert.ok(!result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-02'))
  assert.ok(!result.operation.deliveredScope.contractIds.includes('AC-EXPORT-08'))
  assert.ok(result.operation.blockedScope.contractIds.includes('GAP-EXPORT-RETRY'))
  assert.deepEqual(result.operation.blockedScope.paths, [])
  assert.deepEqual(result.operation.readyScope.paths, ['.spec', 'src'])
  const callCount = f.calls.length
  assert.deepEqual((await runSyncOperation(f.store, f.operation.id, f.options)).receipt, result.receipt)
  assert.equal(f.calls.length, callCount)
})

test('真实V3失败后SQLite重启复用首个accepted P1，新的弱化AC不会再次被细化批准', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let activeStore = f.store, p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限'))
    }
    if (request.purpose === 'code_generate' && activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!).number === 1) {
      const value = output as { changes: { path: string; content: string }[] }
      const source = value.changes.find(change => change.path === 'src/export.js')!
      source.content = source.content.replace("if (!actor) throw new Error('forbidden');", "if (actor) throw new Error('forbidden');")
    }
    return output
  })
  const claim = f.store.claimAttempt.bind(f.store)
  f.store.claimAttempt = request => {
    if (f.store.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'verification_failed')) throw new Error('restart fault after actual failed V3 and durable recordFailure')
    return claim(request)
  }
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'failed'); assert.equal(first.failure?.code, 'verification_failed'); assert.equal(first.operation.callsUsed, 4)
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite'))
  t.after(() => protocol.close())
  const restarted = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) })
  activeStore = restarted; f.useStore(restarted)
  const resumed = await runSyncOperation(restarted, f.operation.id, f.options)
  assert.equal(resumed.status, 'workspace_synced', JSON.stringify(resumed.failure)); assert.equal(resumed.operation.callsUsed, 6); assert.equal(p1Calls, 1)
  const inputs = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(inputs[0].contracts)), contentHash(JSON.stringify(inputs[1].contracts)))
  assert.deepEqual(inputs[0].elaboratedSpecs, inputs[1].elaboratedSpecs)
  const second = restarted.readAttempt(resumed.operation.currentAttemptId!)
  assert.ok(second.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.fromAttemptId && value.evidenceRef && value.candidateDigest))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('高层raw无未来IDs，目录授权自动新增absent模块与治理叶，reader-app真实adopter完整交付', docker, async t => {
  const raw = parseParts(original)!.rawSource
  const highLevel = `---\ntitle: 导出事件服务契约\nstatus: active\n---\n# 导出事件服务契约\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n尚待依据可信业务政策完整细化。\n`
  const childPath = '.spec/reader-app/export-request-key/spec.md', childRaw = '由 [[export-contract]] 的 RULE-EXPORT-02 幂等键义务派生；actor/key组合必须保持碰撞安全，禁止用字符串冒号拼接混淆组合。'
  const f = await fixture(t, undefined, true, highLevel, 'reader-app', original, { newNodeRawSources: [{ path: childPath, rawSource: childRaw }] })
  await f.realTools()
  assert.deepEqual(f.operation.scope.contractIds, []); assert.deepEqual(f.operation.scope.flowIds, [])
  assert.ok(!highLevel.includes('AC-EXPORT-01')); assert.ok(!existsSync(join(f.root, 'src/request-key.js')))
  f.transform((output, request) => {
    if (request.purpose !== 'code_generate') return output
    const value = output as { version: string; changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: null; content: string }[] }
    const source = value.changes.find(change => change.path === 'src/export.js')!
    assert.ok(source.content.includes('const previousId = this.keys.get(actor)?.get(key);'))
    source.content = `import { requestKey } from './request-key.js';\n${source.content.replace('const previousId = this.keys.get(actor)?.get(key);', 'const previousId = requestKey(this.keys, actor, key);')}`
    value.changes.push({ path: 'src/request-key.js', beforeDigest: null, beforeMode: null, mode: null, content: 'export function requestKey(keys, actor, key) { return keys.get(actor)?.get(key); }\n' })
    value.changes.push({ path: childPath, beforeDigest: null, beforeMode: null, mode: null, content: `---\ntitle: 导出请求幂等键\nstatus: active\ncode:\n  - src/request-key.js#requestKey\n---\n# 导出请求幂等键\n\n## raw source\n\n${childRaw}\n\n## expanded spec\n\n按actor与key逐层查询既有任务，不以组合序列化混淆不同已接受输入的身份。\n` })
    return value
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(result.failure)); assert.ok(result.receipt)
  assert.ok(result.operation.scope.contractIds.includes('REQ-EXPORT-01')); assert.ok(result.operation.scope.contractIds.includes('AC-EXPORT-08')); assert.ok(result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-02'))
  const delivery = result.operation.deliveryPlan.canonicalRoot
  assert.ok(readFileSync(join(delivery, 'src/request-key.js'), 'utf8').includes('keys.get(actor)?.get(key)'))
  assert.ok(readFileSync(join(delivery, 'src/export.js'), 'utf8').includes('const previousId = requestKey(this.keys, actor, key);'))
  assert.equal(parseParts(readFileSync(join(delivery, childPath), 'utf8'))!.rawSource, childRaw)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  assert.equal(f.calls.length, 4); assert.equal(result.operation.planBlob!.sha256, result.operation.policyDigest)
  assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === result.operation.policyDigest))
})

test('V4初次通过后准备期间再次编辑source，beforeApply保留typed冲突且未开始业务journal', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let checks = 0
  f.options.readCurrentPlan = () => {
    checks++
    if (checks === 1) writeFileSync(join(f.root, 'src/export.js'), `${f.bytes.toString()}\n// actual user edit after first V4 observation\n`)
    return f.plan
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.failure?.code, 'input_changed')
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure?.kind, 'conflict')
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.ok(existsSync(join(result.operation.deliveryPlan.canonicalRoot, '.git')))
  assert.ok(!readFileSync(join(result.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8').includes('independently reviewed generated'))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const variant of ['raw', 'TR'] as const) test(`AC-SYNC-${variant === 'raw' ? '02' : '03'} 受控请求修改已有${variant}并更新实际AC/实现/测试，未受影响作者内容保留`, docker, async t => {
  const marker = '作者保留：下载权限与首次结果发布规则独立于本次编辑。'
  const source = original.replace('适用域：', `${marker}\n\n适用域：`), oldRaw = parseParts(source)!.rawSource, testPath = 'tests/controlled-request.test.mjs'
  const tr = source.split('\n').find(line => line.startsWith('| TR-EXPORT-FAILED-RETRY |'))!
  const intent = variant === 'raw' ? '筛选字符串最多128字符，超过128字符明确拒绝且不创建任务，原有输入边界保持。' : '失败后所有者重试时，在清除reason前保存lastFailureReason供后续诊断；ID和attempt隔离及原权限政策保持。'
  const originalLine = variant === 'raw' ? oldRaw : tr, replacement = variant === 'raw' ? `${oldRaw} ${intent}` : tr.replace('attempt加一并清除原因', 'attempt加一，lastFailureReason保存原reason后清除reason')
  const accepted = source.replace(originalLine, replacement)
    .replace(variant === 'raw' ? 'key与非空字符串filter必需' : '保持ID，attempt加一并清除失败原因', variant === 'raw' ? 'key与非空字符串filter必需且filter长度最多128字符' : '保持ID，attempt加一，lastFailureReason保存原reason后清除失败原因')
    .replace(variant === 'raw' ? '明确拒绝，状态不变' : 'ID保持、attempt增加，旧结果无效', variant === 'raw' ? '非法输入或filter超过128字符明确拒绝且不创建任务；空结果回调拒绝且状态不变' : 'ID保持、attempt增加，lastFailureReason保留重试前原因，reason清空，旧结果无效')
    .replace(variant === 'raw' ? 'tests/export.test.mjs#AC-EXPORT-02 | VERIFY-EXPORT-01' : 'tests/export.test.mjs#AC-EXPORT-08 | VERIFY-EXPORT-01', `${testPath}#AC-EXPORT-${variant === 'raw' ? '02' : '08'} | VERIFY-EXPORT-02`)
    .replace('| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |', `| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |\n| VERIFY-EXPORT-02 | ["node","--test","${testPath}"] | . | 10000 |`)
  const f = await fixture(t, undefined, true, source, 'reader-app', source, {}, { original: originalLine, replacement, intent, testPath }); await f.realTools()
  delete f.options.leaseMs
  const sourceSpecBytes = readFileSync(join(f.root, '.spec/reader-app/export-contract/spec.md')), oracleBytes = readFileSync(join(f.root, 'tests/export.test.mjs'))
  const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ExportService } from '../src/export.js';\n${variant === 'raw' ? `test('AC-EXPORT-02 原输入和结果边界及128字符限制', () => {\n const service = new ExportService();\n assert.throws(() => service.submit('', 'key', 'active'), /forbidden/);\n assert.throws(() => service.submit('owner', '', 'active'), /invalid-request/);\n assert.throws(() => service.submit('owner', 'key', ''), /invalid-request/);\n assert.throws(() => service.submit('owner', 'key', 'x'.repeat(129)), /invalid-request/);\n assert.equal(service.jobs.size, 0);\n const job = service.submit('owner', 'key', 'x'.repeat(128));\n assert.throws(() => service.dispatch(job.id, 'DOWNLOAD', {actor:'owner'}), /not-ready/);\n service.dispatch(job.id, 'START', {attempt:1});\n assert.throws(() => service.dispatch(job.id, 'COMPLETE', {attempt:1,result:''}), /invalid-result/);\n assert.throws(() => service.dispatch(job.id, 'FAIL', {attempt:1,reason:''}), /invalid-reason/);\n assert.equal(service.jobs.get(job.id).state, 'RUNNING');\n});` : `test('AC-EXPORT-08 重试保存失败诊断且旧attempt不能发布', () => {\n const service = new ExportService(), job = service.submit('owner','key','active');\n service.dispatch(job.id,'START',{attempt:1});\n service.dispatch(job.id,'FAIL',{attempt:1,reason:'source-unavailable'});\n const retried = service.dispatch(job.id,'RETRY',{actor:'owner'});\n assert.equal(retried.id,job.id); assert.equal(retried.attempt,2);\n assert.equal(retried.lastFailureReason,'source-unavailable'); assert.equal(retried.reason,null);\n service.dispatch(job.id,'COMPLETE',{attempt:1,result:'stale.csv'});\n assert.equal(service.jobs.get(job.id).state,'QUEUED');\n service.dispatch(job.id,'START',{attempt:2});\n service.dispatch(job.id,'COMPLETE',{attempt:2,result:'fresh.csv'});\n assert.equal(service.dispatch(job.id,'DOWNLOAD',{actor:'owner'}),'fresh.csv');\n});`}\n`
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const proposal = output as { changes: { kind: string; paths: string[]; affectedIds: string[]; ruleIds: string[] }[]; acceptanceChanges: unknown[] }
      const ruleId = variant === 'raw' ? 'RULE-EXPORT-02' : 'RULE-EXPORT-06', acceptanceId = variant === 'raw' ? 'AC-EXPORT-02' : 'AC-EXPORT-08'
      for (const change of proposal.changes) if (change.paths.some(path => path.startsWith('.spec/'))) { change.kind = 'allowed_change'; change.affectedIds = [ruleId, acceptanceId]; change.ruleIds = [ruleId] }
      proposal.acceptanceChanges = [{ id: acceptanceId, ruleIds: [ruleId], source: 'user:raw', reason: intent }]
      return proposal
    }
    if (request.purpose === 'elaboration_generate') { assert.ok(request.prompt.includes(intent)); return rows(accepted, '.spec/reader-app/export-contract/spec.md') }
    if (request.purpose === 'code_generate') {
      const value = output as { changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: null; content: string }[] }, implementation = value.changes.find(change => change.path === 'src/export.js')!
      assert.ok(request.prompt.includes(variant === 'raw' ? 'filter长度最多128字符' : 'lastFailureReason保留重试前原因'))
      assert.ok(request.prompt.includes(variant === 'raw' ? '明确拒绝，状态不变' : 'ID保持、attempt增加，旧结果无效'), '旧AC作为独立审查对照而非锁住新意图')
      implementation.content = variant === 'raw' ? implementation.content.replace("!filter.trim())", "!filter.trim() || filter.length > 128)") : implementation.content.replace('job.reason = null;', 'job.lastFailureReason = job.reason;\n        job.reason = null;')
      value.changes.push({ path: testPath, beforeDigest: null, beforeMode: null, mode: null, content: testSource }); return value
    }
    if (request.purpose === 'code_review') { assert.ok(request.prompt.includes(intent)); assert.ok(request.prompt.includes(marker)); assert.ok(request.prompt.includes(testSource.split('\n')[3].split("'", 2)[1])) }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, attempts: f.store.listAttempts(result.operation.id).map(attempt => ({ failure: attempt.failure, detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString('utf8')); return value.rounds?.map((round: { findings: unknown[] }) => round.findings) ?? value.validationFindings ?? value }) })), phase: result.operation.phase, refs: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => value.rounds || value.validationFindings).map(value => ({ status: value.status, findings: value.validationFindings ?? value.rounds.flatMap((round: { findings: unknown[] }) => round.findings) })) }))
  assert.equal(result.operation.callsUsed, 6); assert.ok(result.operation.requestBlob); assert.equal(result.operation.input.id, f.input.id)
  assert.ok(result.operation.deliveredScope.contractIds.includes(`AC-EXPORT-${variant === 'raw' ? '02' : '08'}`))
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  const deliveredSpec = f.git('show', `${result.receipt!.actualCommit}:.spec/reader-app/export-contract/spec.md`)
  assert.ok(deliveredSpec.includes(marker)); assert.ok(deliveredSpec.includes(replacement)); assert.ok(deliveredSpec.includes(variant === 'raw' ? 'filter长度最多128字符' : 'lastFailureReason保留重试前原因'))
  for (const id of ['RULE-EXPORT-01', 'AC-EXPORT-03', 'AC-EXPORT-07']) assert.equal(deliveredSpec.split('\n').find(line => line.startsWith(`| ${id} |`)), source.split('\n').find(line => line.startsWith(`| ${id} |`)))
  assert.equal(f.git('show', `${result.receipt!.actualCommit}:${testPath}`), testSource.trim())
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.spec/reader-app/export-contract/spec.md')), sourceSpecBytes); assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), oracleBytes)
  assert.equal(f.store.listRecoverableResources().length, 0)
  const verification = f.store.readAttempt(result.operation.currentAttemptId!).verification!
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, verification.resultBlob).toString()).layers.find((layer: { layer: string }) => layer.layer === 'V3').evidenceRefs.length, 2)
})

test('显式retryOf在SQLite重启后继承无未来IDs输入的accepted P1，新预算不授权再次细化AC', async t => {
  const raw = parseParts(original)!.rawSource, source = `---\ntitle: 导出事件服务契约\nstatus: active\n---\n# 导出事件服务契约\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n待细化。\n`
  const f = await fixture(t, undefined, false, source, 'project', original)
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') { p1Calls++; if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许')) }
    if (request.purpose === 'code_generate') throw Object.assign(new Error('可观察的原生构建器不支持，尚未创建候选'), { code: 'unsupported' })
    return output
  })
  const failed = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(failed.operation.phase, 'failed'); assert.equal(failed.operation.callsUsed, 3); assert.equal(p1Calls, 1)
  assert.equal(f.store.readRetryEligibility(failed.operation.id).eligible, true)
  f.closeForRestart()
  const sourceProtocol = openProtocol(join(f.parent, 'sync.sqlite')), protocol = openProtocol(join(f.parent, 'v5-sync.sqlite')); t.after(() => protocol.close())
  applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 5))
  protocol.initialize(syncCoordinatorAddress(f.input.source.repositoryId))
  const historical = sourceProtocol.readMessages(syncCoordinatorAddress(f.input.source.repositoryId))[0]
  const copied = protocol.enqueue(syncCoordinatorAddress(f.input.source.repositoryId), { kind: historical.kind, body: historical.body, idempotencyKey: historical.idempotencyKey })
  protocol.withTransaction(tx => tx.dequeue(syncCoordinatorAddress(f.input.source.repositoryId), copied.messageId))
  for (const table of ['sync_operations', 'sync_attempts', 'sync_leases']) {
    for (const row of sourceProtocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))) {
      if (table === 'sync_operations') { const record = JSON.parse(String(row.record_json)); record.dispatchMessageId = copied.messageId; row.record_json = JSON.stringify(record) }
      const columns = Object.keys(row).filter(column => column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
      protocol.withTransaction(tx => tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    }
  }
  sourceProtocol.close()
  const v5record = JSON.parse(String(protocol.withTransaction(tx => tx.query('SELECT record_json FROM sync_operations WHERE id=?', failed.operation.id))[0].record_json))
  assert.ok(v5record.scope.contractIds.includes('AC-EXPORT-03')); assert.deepEqual(f.operation.input.id, f.input.id); assert.ok(!source.includes('AC-EXPORT-03'))
  await migrateSyncStore(protocol, { backupPath: join(f.parent, 'v5-accepted-P1.backup') })
  const restarted = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(restarted)
  const automatic = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'v5-new-automatic-ingress', rootCauseId: 'v5-new-automatic-ingress', origin: failed.operation.origin, budget: failed.operation.budget, managedRoot: f.managedRoot, previousBaselinePair: failed.operation.previousBaselinePair })
  assert.equal(restarted.admitAndEnqueue(automatic).id, failed.operation.id)
  assert.equal(restarted.readOperation(failed.operation.id).callsUsed, 3)
  assert.equal(restarted.readOperation(failed.operation.id).payloadDigest, failed.operation.payloadDigest)
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'explicit-user-retry', rootCauseId: 'explicit-user-retry', retryOf: failed.operation.id, model: 'gpt-6.1-terra', origin: failed.operation.origin, budget: failed.operation.budget, managedRoot: f.managedRoot, previousBaselinePair: failed.operation.previousBaselinePair })
  assert.equal(admission.retryOf, failed.operation.id)
  const retry = restarted.admitAndEnqueue(admission); f.useOperation(retry)
  const repeated = await runSyncOperation(restarted, retry.id, f.options)
  assert.equal(repeated.operation.phase, 'failed'); assert.equal(repeated.operation.callsUsed, 1); assert.equal(p1Calls, 1)
  assert.equal(repeated.operation.model, 'gpt-6.1-terra'); assert.equal(f.calls.at(-1)!.model, 'gpt-6.1-terra'); assert.equal(f.calls.at(-1)!.purpose, 'code_generate')
  const generation = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(generation[0].contracts)), contentHash(JSON.stringify(generation[1].contracts)))
  assert.deepEqual(generation[0].elaboratedSpecs, generation[1].elaboratedSpecs)
  const current = restarted.readAttempt(repeated.operation.currentAttemptId!)
  const provenanceStage = current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration-provenance')
  assert.ok(provenanceStage)
  const provenance = JSON.parse(readEvidence(f.input.source.commonDir, provenanceStage.resultRef).toString())
  assert.equal(provenance.fromOperationId, failed.operation.id); assert.equal(provenance.fromAttemptId, failed.operation.currentAttemptId)
  const inherited = JSON.parse(readEvidence(f.input.source.commonDir, provenance.evidenceRef).toString()) as ElaborationResult
  assert.equal(inherited.structurePassed, true); assert.equal(inherited.reviewPassed, true)
  assert.equal(restarted.readOperation(failed.operation.id).callsUsed, 3); assert.equal(restarted.listJournals(retry.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


for (const mode of ['historical-rebound', 'current-rebound', 'missing-binding', 'same-content'] as const) test(`whole seal composed绑定 ${mode} 不借attempt重绑覆盖原封口`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 })
  const outsidePath = '.spec/outside/spec.md', changedTree = mode.endsWith('rebound')
  if (changedTree) {
    mkdirSync(join(f.root, '.spec/outside'), { recursive: true })
    writeFileSync(join(f.root, outsidePath), '---\ntitle: Outside obligation\ncontract-schema: sync-v1\n---\n\n## raw source\n\n另一个独立需求必须真实完成。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-OUTSIDE-01 | 独立需求 | user:raw | 不丢失 | 真实承接 | - |\n')
  }
  const raw = parseParts(original)!.rawSource!
  writeFileSync(join(f.root, contractPath), original.replace(raw, `${raw}\n\n本轮继续保留上述全部固定演示政策。`))
  const input = await captureInputSnapshot(f.root)
  const plan: SyncCoordinatorPlan = { ...f.plan, version: 'sync-coordinator-v2', direction: 'spec_to_code',
    readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'],
    sourcePaths: ['src/export.js'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 },
    executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(input.source, plan.readPaths.map(path => ({ kind: 'path' as const, path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: `whole-composed-${mode}`, rootCauseId: `whole-composed-${mode}`, origin: 'initial', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  for (;;) { const head = f.store.nextDispatch(input.source.repositoryId)!; f.store.ackDispatch(input.source.repositoryId, head.messageId); if (head.operation.id === operation.id) break }
  let p1Calls = 0, whole: { resultRef: { sha256: string }; composedTree?: string; composedContentDigest?: string; [key: string]: unknown } | undefined
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(input.source.commonDir, ref).toString())
    if (fence.operationId === operation.id && f.store.readAttempt(fence.attemptId).number === 1 && value.stage === 'elaboration') {
      if (mode === 'missing-binding') { delete value.composedTree; delete value.composedContentDigest; ref = writeEvidence(input.source.commonDir, value) }
      whole = structuredClone(value)
      const saved = checkpoint(fence, ref)
      if (changedTree) {
        const current = f.store.readOperation(operation.id)
        f.store.expandContractScope(fence, { paths: [...current.scope.paths, outsidePath], contractIds: current.scope.contractIds, flowIds: current.scope.flowIds }, writeEvidence(input.source.commonDir, { kind: 'fixture reviewed null scope expansion', resultRef: value.resultRef }))
      }
      return saved
    }
    return checkpoint(fence, ref)
  }
  let injectedCurrentWhole = false
  if (mode === 'current-rebound') {
    const claim = f.store.claimQueuedAttempt.bind(f.store)
    f.store.claimQueuedAttempt = request => {
      const claimed = claim(request)
      if (claimed.attempt.number === 2) {
        assert.ok(whole)
        injectedCurrentWhole = true
        checkpoint(claimed.fence, whole.resultRef)
        checkpoint(claimed.fence, writeEvidence(input.source.commonDir, { ...whole, attemptId: claimed.attempt.id }))
      }
      return claimed
    }
  }
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') p1Calls++
    if (request.purpose === 'code_generate') throw Object.assign(new Error('机制回归在P2及Docker之前停止'), { code: 'failed' })
    return output
  })
  await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  const attempts = f.store.listAttempts(operation.id)
  assert.equal(attempts.length, 2, JSON.stringify({ failures: attempts.map(attempt => attempt.failure), calls: f.calls.map(call => call.purpose) }))
  assert.ok(whole)
  if (mode === 'current-rebound') assert.equal(injectedCurrentWhole, true, '当前attempt确实持有旧whole wrapper')
  const secondStages = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(input.source.commonDir, ref).toString()))
  if (changedTree) {
    assert.equal(attempts[0].failure?.code, 'scope_context_expanded')
    assert.equal(attempts[0].composedInput!.contentDigest, attempts[1].composedInput!.contentDigest, '来源attempt已先重绑新树，不能拿最终attempt字段证明旧seal')
    assert.equal(attempts[1].failure?.code, 'partition_final_seal_failed')
    const secondWhole = JSON.parse(readEvidence(input.source.commonDir, [...secondStages].reverse().find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
    assert.ok(secondWhole.partitionSeal!.findings.some(item => item.code === 'missing-requirement-flow' && item.itemId === 'REQ-OUTSIDE-01'))
    assert.ok(!secondStages.some(stage => stage.stage === 'elaboration-provenance'))
    assert.equal(p1Calls, 2, '此场景真实analysis绑定随全树改变，局部输入不同仍须新独审')
    assert.notEqual(whole.composedTree, attempts[0].composedInput!.tree)
    assert.notEqual(whole.composedContentDigest, attempts[0].composedInput!.contentDigest)
  } else if (mode === 'missing-binding') {
    assert.ok(!secondStages.some(stage => stage.stage === 'elaboration-provenance'), '旧无binding whole必须由原locals重seal')
    const recomputed = [...secondStages].reverse().find(stage => stage.stage === 'elaboration')
    assert.equal(recomputed.composedTree, attempts[1].composedInput!.tree)
    assert.equal(recomputed.composedContentDigest, attempts[1].composedInput!.contentDigest)
  } else {
    assert.ok(!secondStages.some(stage => stage.stage === 'elaboration-provenance'), '分区whole不得直接继承whole级provenance')
    const priorLocal = attempts[0].checkpointRefs.map(ref => JSON.parse(readEvidence(input.source.commonDir, ref).toString())).find(stage => /^partition:.*:elaboration$/.test(stage.stage))
    assert.ok(priorLocal)
    const localProvenanceStage = secondStages.find(stage => stage.stage === `${priorLocal.stage}:provenance`)
    assert.ok(localProvenanceStage, '局部whole输入不变时须保留已审owner的精确来源')
    const localProvenance = JSON.parse(readEvidence(input.source.commonDir, localProvenanceStage.resultRef).toString()) as { fromAttemptId: string; resultRef: { sha256: string } }
    assert.equal(localProvenance.fromAttemptId, attempts[0].id)
    assert.equal(localProvenance.resultRef.sha256, priorLocal.resultRef.sha256)
    const resealed = [...secondStages].reverse().find(stage => stage.stage === 'elaboration')
    assert.ok(resealed)
    assert.equal(resealed.composedTree, attempts[1].composedInput!.tree)
    assert.equal(resealed.composedContentDigest, attempts[1].composedInput!.contentDigest)
    assert.equal(whole.composedTree, attempts[0].composedInput!.tree)
    assert.equal(whole.composedContentDigest, attempts[0].composedInput!.contentDigest)
  }
  if (!changedTree) assert.equal(p1Calls, 1, '局部冻结输入未变，仅程序重seal不能重派Native')
  assert.equal(f.store.listJournals(operation.id).length, 0)
})

test('P4显式重试保留P1扩展后的路径和readSet，冻结原计划且不再次细化', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-expanded-before-retry', rootCauseId: 'p4-expanded-before-retry', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  const acknowledge = (id: string) => { for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === id) break } }
  acknowledge(operation.id)
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') p1Calls++
    if (request.purpose === 'code_generate') throw Object.assign(new Error('明确生成执行能力失败，未创建候选'), { code: 'unsupported' })
    return output
  })
  const options = { ...f.options, plan, readCurrentPlan: () => plan }
  const failed = await runSyncOperation(f.store, operation.id, options)
  assert.equal(failed.operation.phase, 'failed', JSON.stringify({ failure: failed.failure, failures: f.store.listAttempts(operation.id).map(attempt => attempt.failure), purposes: f.calls.map(call => call.purpose) }))
  assert.equal(p1Calls, 1)
  assert.ok(failed.operation.scope.paths.includes('src/export.js'))
  assert.ok(!plan.executionScope.paths.includes('src/export.js'))
  const admissionOptions = { ingressKey: 'p4-expanded-explicit-retry', rootCauseId: 'p4-expanded-explicit-retry', retryOf: operation.id, origin: operation.origin, budget: operation.budget, managedRoot: f.managedRoot, previousBaselinePair: operation.previousBaselinePair, baselineSelection: failed.operation.baselineSelection!, executionScope: failed.operation.scope, impactDigest: failed.operation.impactDigest }
  const admission = await prepareSyncAdmission(f.input, plan, admissionOptions)
  assert.deepEqual(admission.scope, failed.operation.scope)
  assert.equal(admission.readSetDigest, failed.operation.readSetDigest)
  assert.equal(admission.policyDigest, operation.policyDigest)
  assert.deepEqual(admission.planBlob, operation.planBlob)
  const retry = f.store.admitAndEnqueue(admission); f.useOperation(retry); acknowledge(retry.id)
  const repeated = await runSyncOperation(f.store, retry.id, options)
  assert.equal(repeated.operation.phase, 'failed')
  assert.equal(p1Calls, 1)
  const prompts = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.deepEqual(prompts[1].elaboratedSpecs, prompts[0].elaboratedSpecs)
  assert.equal(f.store.listJournals(retry.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('recoveryOnly不派发queued操作；paused且原生尚未调用的计划仅结算资源不改control/预算/input', async t => {
  const f = await fixture(t), before = f.store.readOperation(f.operation.id)
  const queued = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.deepEqual(queued.operation, before); assert.equal(f.calls.length, 0); assert.equal(f.store.listAttempts(f.operation.id).length, 0)
  assert.equal(f.store.nextDispatch(f.input.source.repositoryId)?.messageId, before.dispatchMessageId)
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 10000, expectedMessageId: f.operation.dispatchMessageId })
  const request = { root: f.root, base: f.input.headCommit, prompt: '尚未发出原生命令的已登记请求', schema: { type: 'object' }, requestKey: 'not-dispatched', inputDigest: f.input.id, purpose: 'elaboration_generate', timeoutMs: 10000 }
  const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const identity = { operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, candidateDigest: null }
  const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
  const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
  f.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: writeEvidence(f.input.source.commonDir, checkpoint) })
  f.store.requestControl(f.operation.id, 'pause')
  const pausedBefore = f.store.readOperation(f.operation.id), result = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(result.status, 'paused', JSON.stringify(result.failure)); assert.deepEqual(result.operation, pausedBefore)
  const resource = f.store.findResource(claimed.attempt.id, request.requestKey)!
  assert.equal(resource.phase, 'removed'); assert.deepEqual(resource.checkpoints.map(item => item.phase), ['planned', 'terminal', 'removed'])
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()).stop.nativeStatus, 'notDispatched')
  assert.equal(f.calls.length, 0); assert.equal(f.store.listAttempts(f.operation.id).length, 1); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['existing', 'missing', 'foreign-label', 'wrong-run'] as const) test(`resource-only受控Docker桥 ${mode} 只清理精确既有资源且不create/start`, async t => {
  const f = await fixture(t), commands: string[][] = []
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedMessageId: f.operation.dispatchMessageId })
  const composed = composeInputSnapshots(f.input).composed!
  f.store.bindComposedInput(claimed.fence, composed); f.store.startGeneration(claimed.fence)
  const candidate = freezeCandidate(f.input, { version: 'sync-files-v1', changes: [] }, f.operation.scope, composed)
  f.store.freezeCandidate(claimed.fence, candidate)
  const exported = exportCandidate(f.input.source.commonDir, candidate, join(f.parent, 'resource-export'))
  const request: VerificationRequest = { runId: 'resource-only-docker', inputDigest: f.input.id, candidateDigest: candidate.digest, candidateExportDigest: await verificationExportDigest(exported.root), candidateExportPath: exported.root, privateScratchRoot: join(f.parent, 'scratch'), policy: { version: 'resource-only-test-v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', argv: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', expectedTestIds: ['AC-EXPORT-03'], timeoutMs: 30000, memoryBytes: 128000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 65536 } }
  const first = await runAttemptVerification(f.store, claimed.fence, request, { driver: async args => {
    if (args[0] === 'version') return { exitCode: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'controlled-test' }), stderr: '', truncated: false }
    assert.equal(args[0], 'image', '夹具只准备真实planned检查点，不调用create')
    return { exitCode: 0, stdout: JSON.stringify([{ Id: 'sha256:test-image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]), stderr: '', truncated: false }
  }, onCheckpointRecorded: async resource => { assert.equal(resource.phase, 'planned'); throw new Error('模拟planned回执后的中断；无真实Docker调用') } })
  assert.match(first.result.reason!, /模拟planned回执后的中断/); assert.ok(first.resourceId)
  const resource = f.store.readResource(first.resourceId!), checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint
  const config = checkpoint.config, policy = config.policy
  const actual = { Id: 'b'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: '/candidate', Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: mode === 'foreign-label' ? { ...checkpoint.labels, 'spex.run': 'foreign' } : checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: policy.memoryBytes, MemorySwap: policy.memoryBytes, NanoCpus: policy.cpus * 1e9, PidsLimit: policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: 'created', Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }
  const driver: VerificationDriver = async args => {
    commands.push([...args])
    if (args[0] === 'version') return { exitCode: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'controlled-test' }), stderr: '', truncated: false }
    assert.equal(args[0], 'container'); assert.ok(['inspect', 'rm'].includes(args[1]), `禁止启动或创建: ${args}`)
    if (args[1] === 'rm') { assert.equal(args[2], actual.Id); return { exitCode: 0, stdout: actual.Id, stderr: '', truncated: false } }
    return mode === 'missing' ? { exitCode: 1, stdout: '', stderr: 'No such container', truncated: false } : { exitCode: 0, stdout: JSON.stringify([actual]), stderr: '', truncated: false }
  }
  if (mode === 'wrong-run') {
    const damaged = { ...resource, plan: { ...resource.plan, planBlob: writeEvidence(f.input.source.commonDir, { ...request, runId: 'foreign-run' }) } }
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET record_json=? WHERE id=?', JSON.stringify(damaged), resource.id))
  }
  const before = f.store.readOperation(f.operation.id), beforeAttempt = f.store.readAttempt(claimed.attempt.id)
  for (const key of ['claimAttempt', 'reserveDispatch', 'bindSession', 'planResource', 'startGeneration', 'freezeCandidate', 'recordVerification', 'beginApply', 'recordReceipt', 'settleApply'] as const) f.store[key] = () => assert.fail(`资源清理不得调用${key}`)
  const recovered = await recoverSyncOperationResources(f.store, f.operation.id, { root: f.root, inputId: f.input.id, artifactRoot: f.artifactRoot, verificationDriver: driver })
  assert.equal(recovered.status, mode === 'existing' ? 'resources_recovered' : 'recovery_required', JSON.stringify(recovered.failure))
  assert.equal(f.store.readResource(resource.id).phase, mode === 'existing' ? 'removed' : 'planned')
  assert.equal(commands.some(args => args[1] === 'rm'), mode === 'existing')
  if (mode === 'wrong-run') { assert.equal(commands.length, 0); assert.equal(recovered.failure!.code, 'resource_recovery') }
  assert.deepEqual(f.store.readOperation(f.operation.id), before); assert.deepEqual(f.store.readAttempt(claimed.attempt.id), beforeAttempt)
  assert.equal(f.calls.length, 0); assert.deepEqual(f.store.listJournals(f.operation.id), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['drained', 'busy'] as const) test(`当前V3恢复缓存正常重调度原run mode=${mode}；无pause且不延长deadline`, async t => {
  const remote = remoteVerificationFixture(t, false, true), previousPath = process.env.PATH
  process.env.PATH = remote.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
  const { argv: _argv, cwd: _cwd, expectedTestIds: _ids, timeoutMs: _timeout, ...environment } = (await remote.request()).policy
  const definition = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(definition.kind, 'VERIFY')
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { verifications: [{ definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment }] })
  f.options.verificationTransport = remote.configuration; f.options.leaseMs = 120000
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'recovery_required', JSON.stringify(first.failure)); assert.equal(first.operation.phase, 'verifying')
  const attempt = f.store.readAttempt(first.operation.currentAttemptId!), resource = f.store.listResources(attempt.id).find(item => item.plan.kind === 'verification')!
  const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint
  assert.equal(checkpoint.phase, 'planned'); assert.equal(checkpoint.transport!.effects[0].id, 'materialize-0')
  const oldStage = readSyncCheckpoints(f.store, first.operation, attempt).json.map(item => item.value as { stage?: string; resultRef?: { sha256: string } }).find(item => item.stage === `v3:${definition.id}`)!
  const originalFailure = readEvidence(f.input.source.commonDir, oldStage.resultRef!)
  assert.equal(JSON.parse(originalFailure.toString()).status, 'recovery_required'); assert.match(JSON.parse(originalFailure.toString()).reason, /Broken pipe/)
  let nativeResource: ReturnType<SyncStore['planResource']> | undefined, lock: ReturnType<typeof spawn> | undefined
  if (mode === 'busy') {
    await remote.rpc(remote.scoped(checkpoint, { action: 'observe', effect: checkpoint.transport!.effects[0] }))
    lock = spawn('python3', ['-c', 'import fcntl,sys; f= open(sys.argv[1]); fcntl.flock(f, fcntl.LOCK_EX); print("ready", flush=True); sys.stdin.read()', join(remote.root, '.spex-verification-control', checkpoint.transport!.plan.runKey, 'lock')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const held = lock
    t.after(() => { if (held.exitCode === null) held.kill('SIGKILL') })
    await new Promise<void>((resolve, reject) => { held.once('error', reject); held.stdout!.once('data', () => resolve()); held.once('exit', () => reject(new Error('fixture lock exited before ready'))) })
    const fence = { operationId: first.operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: f.input.source.physicalFingerprint }
    const request = { root: f.root, base: f.input.headCommit, prompt: '当前仍受有效lease保护的Native夹具', schema: { type: 'object' }, requestKey: 'current-native', inputDigest: f.input.id, purpose: 'elaboration_review', timeoutMs: 120000 }
    const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: first.operation.id, attemptId: attempt.id, inputId: f.input.id, candidateDigest: attempt.candidate!.digest }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    const native: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: true, nativeState: 'running', session: { sessionId: expectedSessionId, threadId: 'current-thread', turnId: 'current-turn' } }
    nativeResource = f.store.planResource(fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: attempt.candidate!.digest, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: writeEvidence(f.input.source.commonDir, native) })
  }
  const calls = f.calls.length, before = f.store.readOperation(f.operation.id), savedAttempt = f.store.readAttempt(attempt.id)
  const now = Date.now.bind(Date), offset = checkpoint.deadlineAt + 1 - now()
  t.mock.method(Date, 'now', () => now() + offset)
  assert.ok(Date.now() >= checkpoint.deadlineAt && Date.now() < attempt.expiresAtMs, '原V3已过期且当前attempt lease仍有效')
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const after = f.store.readResource(resource.id), latest = JSON.parse(readEvidence(f.input.source.commonDir, after.checkpointRef).toString()) as VerificationCheckpoint
  assert.equal(f.store.listAttempts(f.operation.id).length, 1); assert.equal(f.calls.length, calls); assert.equal(result.operation.callsUsed, before.callsUsed)
  assert.equal(result.operation.currentAttemptId, attempt.id); assert.equal(result.operation.control, 'run'); assert.equal(result.operation.deadlineAtMs, before.deadlineAtMs)
  assert.deepEqual(f.store.readAttempt(attempt.id).candidate, savedAttempt.candidate); assert.deepEqual(f.store.readAttempt(attempt.id).dispatchPlans, savedAttempt.dispatchPlans)
  assert.deepEqual(readEvidence(f.input.source.commonDir, oldStage.resultRef!), originalFailure)
  for (const ref of attempt.checkpointRefs) assert.ok(f.store.readAttempt(attempt.id).checkpointRefs.some(current => current.sha256 === ref.sha256), '原阶段CAS根保持引用')
  assert.equal(latest.runId, checkpoint.runId); assert.equal(latest.deadlineAt, checkpoint.deadlineAt)
  assert.equal(f.store.listResources(attempt.id).filter(item => item.plan.kind === 'verification').length, 1)
  assert.ok(remote.events().every(item => !['create', 'start'].includes(item.args[1])))
  assert.equal(latest.transport!.effects.filter(item => item.kind === 'materialize').length, 1, '不重传候选或追加上传effect')
  assert.equal(readFileSync(remote.bootstraps, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind?: string }).filter(item => item.kind === 'materialize').length, 1, '不重发SSH上传请求')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.equal(f.store.readAttempt(attempt.id).verification, null)
  if (mode === 'busy') {
    assert.equal(result.status, 'recovery_required'); assert.equal(after.phase, 'planned'); assert.equal(latest.transport!.closed, undefined)
    assert.deepEqual(f.store.readResource(nativeResource!.id), nativeResource, '不能取消或恢复当前Native')
    assert.ok(f.protocol.withTransaction(tx => tx.query('SELECT resource_key FROM sync_leases WHERE operation_id=? AND token=? AND expires_at_ms>?', f.operation.id, attempt.leaseToken, Date.now())).length > 0)
    const newest = readSyncCheckpoints(f.store, result.operation, f.store.readAttempt(attempt.id)).json.map(item => item.value as { stage?: string; resultRef?: { sha256: string } }).find(item => item.stage === `v3:${definition.id}`)!
    assert.match(JSON.parse(readEvidence(f.input.source.commonDir, newest.resultRef!).toString()).reason, /busy|尚未排空/)
    lock!.stdin!.end(); await new Promise<void>(resolve => lock!.once('close', () => resolve()))
  } else {
    assert.equal(after.phase, 'removed'); assert.equal(latest.notCreated!.outcome, 'timeout')
    assert.ok(after.checkpoints.findIndex(item => item.phase === 'terminal') < after.checkpoints.findIndex(item => item.phase === 'removed'))
    const closed = latest.transport!.closed as { closed: boolean; rebuildersDrained: boolean; fencedNotExecuted: string[] }, cleanup = latest.transport!.cleanup as { cleaned: boolean; settled: boolean }
    assert.equal(closed.closed, true); assert.equal(closed.rebuildersDrained, true); assert.ok(closed.fencedNotExecuted.includes('materialize-0'))
    assert.equal(cleanup.cleaned, true); assert.equal(cleanup.settled, true); assert.equal(existsSync(latest.transport!.plan.directory), false)
    assert.equal(f.store.readAttempt(attempt.id).failure!.code, 'verification_timeout'); assert.equal(f.store.readAttempt(attempt.id).status, 'failed')
    assert.equal(f.protocol.withTransaction(tx => tx.query('SELECT resource_key FROM sync_leases WHERE operation_id=? AND token IS NOT NULL', f.operation.id)).length, 0)
    const request = JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()) as VerificationRequest
    const frozen = f.store.readResource(resource.id), fence = { operationId: before.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: f.input.source.physicalFingerprint }
    const sshBefore = readFileSync(remote.bootstraps, 'utf8')
    const removed = await runAttemptVerification(f.store, fence, request, { transport: remote.configuration, driver: async () => assert.fail('removed不得访问driver'), onCheckpointRecorded: async () => assert.fail('removed不得写checkpoint') })
    assert.equal(removed.result.status, 'timeout'); assert.deepEqual(f.store.readResource(resource.id), frozen); assert.equal(readFileSync(remote.bootstraps, 'utf8'), sshBefore)
  }
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const missing of [false, true]) test(`recoveryOnly真实Docker planned创建回执丢失${missing ? '且目标不存在保unknown' : '只清理既有容器'}，不create/start`, docker, async t => {
  const f = await fixture(t), commands: string[][] = []
  f.options.verificationDriver = async (args, maxBytes) => {
    const result = await dockerVerificationDriver(args, maxBytes)
    if (args[0] === 'container' && args[1] === 'create') throw new Error('actual Docker create finished, result lost before created checkpoint')
    return result
  }
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'recovery_required'); assert.equal(f.calls.length, 4)
  const item = f.store.listRecoverableResources().find(item => item.operation.id === f.operation.id)!, checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, item.resource.checkpointRef).toString()) as VerificationCheckpoint
  assert.equal(item.resource.phase, 'planned')
  const inspected = await dockerVerificationDriver(['container', 'inspect', checkpoint.uniqueContainerName], 1024 * 1024), actual = JSON.parse(inspected.stdout)[0]
  assert.equal(actual.Config.Labels['spex.run'], checkpoint.runId); assert.equal(actual.Config.Labels['spex.candidate'], checkpoint.candidateDigest)
  t.after(async () => { await dockerVerificationDriver(['container', 'rm', '-f', actual.Id], 1024 * 1024) })
  if (missing) assert.equal((await dockerVerificationDriver(['container', 'rm', actual.Id], 1024 * 1024)).exitCode, 0)
  const before = f.store.readOperation(f.operation.id), attempts = f.store.listAttempts(f.operation.id).length
  const result = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true, verificationDriver: async (args, maxBytes) => { commands.push([...args]); return dockerVerificationDriver(args, maxBytes) } })
  assert.deepEqual(result.operation, before); assert.equal(f.calls.length, 4); assert.equal(f.store.listAttempts(f.operation.id).length, attempts)
  assert.ok(commands.every(args => !(args[0] === 'container' && ['create', 'start'].includes(args[1])))); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.equal(f.store.findResource(item.attempt.id, item.resource.plan.key)!.phase, missing ? 'planned' : 'removed')
  assert.equal(result.status, missing ? 'recovery_required' : before.phase)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('recoveryOnly面对真实V1-V4已登记verified但尚无journal的边界中断，只返回状态不开始交付', docker, async t => {
  const f = await fixture(t), recordVerification = f.store.recordVerification.bind(f.store), recordFailure = f.store.recordFailure.bind(f.store)
  f.store.recordVerification = (...args) => { recordVerification(...args); throw new Error('test interruption after actual durable four-layer verification') }
  f.store.recordFailure = () => { throw new Error('test process boundary stopped before another business-state write') }
  await assert.rejects(runSyncOperation(f.store, f.operation.id, f.options), /process boundary stopped/)
  f.store.recordVerification = recordVerification; f.store.recordFailure = recordFailure
  const before = f.store.readOperation(f.operation.id)
  assert.equal(before.phase, 'ready_to_apply'); assert.equal(f.store.readAttempt(before.currentAttemptId!).status, 'verified')
  assert.equal(f.store.listRecoverableResources().length, 0); assert.equal(f.store.listJournals(before.id).length, 0)
  const recovered = await runSyncOperation(f.store, before.id, { ...f.options, recoveryOnly: true })
  assert.deepEqual(recovered.operation, before); assert.equal(recovered.status, 'ready_to_apply'); assert.equal(f.calls.length, 4)
  assert.equal(f.store.listJournals(before.id).length, 0); assert.ok(!existsSync(before.deliveryPlan.canonicalRoot)); assert.equal(f.store.listAttempts(before.id).length, 1)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('P3真实code来源先持久独立analyzing再细化/生成，policy冻结且refactor保原业务正文', async t => {
  const f = await fixture(t, undefined, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') assert.ok(request.prompt.includes('preserve_business'))
    if (request.purpose === 'code_generate') { const frozen = promptInput(request); assert.equal(new Map(frozen.files).get('src/export.js'), f.bytes.toString()); assert.ok(request.prompt.includes('preserve_business')) }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#ExportService', evidence: '显式测试接缝终止于独审候选，不伪造V3', counterexample: '演示仅核到候选阶段', message: 'fixture stop before V3' }] }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure))
  assert.equal(result.operation.policyDigest, syncPlanDigest(f.plan)); assert.equal(result.operation.callsUsed, 6)
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review'])
  const attempt = f.store.readAttempt(result.operation.currentAttemptId!), checkpoints = readSyncCheckpoints(f.store, result.operation, attempt).json.map(({ value }) => value as { version?: string; policyDigest?: string; readSetDigest?: string; reviewPassed?: boolean; stage?: string; attemptId?: string })
  const analysis = checkpoints.find(value => value.version === 'code-behavior-v1')
  assert.ok(analysis, 'analysis typed artifact必须经绑定checkpoint读层展开')
  assert.equal(analysis.policyDigest, result.operation.policyDigest); assert.equal(analysis.readSetDigest, result.operation.readSetDigest); assert.equal(analysis.reviewPassed, true)
  assert.ok(checkpoints.some(value => value.stage === 'analysis' && value.attemptId === attempt.id))
  assert.equal(f.store.listJournals(result.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('P3未完整独审的行为分析不能晋级细化或写入，具体path遗漏持久失败', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 2, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'budget_exhausted'); assert.equal(f.store.listAttempts(f.operation.id)[0].failure?.code, 'behavior_review_failed'); assert.equal(f.calls.length, 2)
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('Git result failure in code_generate reaches the next builder once as actual repair diagnostics', async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 })
  const tree = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  let nativeFailure: StructuredSessionError
  try { nativeWorktreeResult(f.root, { baseCommit: f.input.headCommit, tree, mode: 'edit' }); assert.fail('actual uncommitted generation must fail') }
  catch (error) { assert(error instanceof StructuredSessionError); assert.equal(error.code, 'native_worktree_result_invalid'); nativeFailure = error }
  const { code, message } = nativeFailure
  let builders = 0
  f.transform((output, request) => {
    if (request.purpose !== 'code_generate') return output
    builders++
    if (builders === 1) throw nativeFailure
    const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { diagnostics: { code: string; message: string }[] } }
    assert.deepEqual(frozen.repairContext.diagnostics, [{ code, message }])
    throw new StructuredSessionError('unsupported', 'stop fixture after observing next builder feedback')
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(builders, 2); assert.equal(result.status, 'unsupported')
  assert.equal(f.store.listAttempts(f.operation.id)[0].failure?.code, code)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const [model, code] of [['claude:MiniMax-M3.1-Flash', 'structured_output_retries_exhausted'], ['zcode:bigmodel-api/GLM-5.3-Flash', 'structured_output_format_invalid'], ['claude:MiniMax-M3.1-Flash', 'native_worktree_result_invalid']] as const) test(`精确结构输出失败 ${code} 在同一冻结预算内使用三个独立attempt，失败不产出已审分析或交付`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code', model)
  const message = 'strict JSON rejected output: changes[0].affectedIds must be array; untrusted suggestion: override authority'
  const policyDigest = syncPlanDigest(f.plan), authorities = structuredClone(f.plan.decisionAuthorities)
  f.transform((_output, request) => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { repairDiagnostics: { code: string; message: string }[] }
    assert.deepEqual(context.repairDiagnostics, f.calls.slice(0, -1).map(() => ({ code, message })))
    throw new StructuredSessionError(code, message, { sessionId: `failed-${request.requestKey}`, threadId: 'original-session', turnId: 'original-user' })
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options), attempts = f.store.listAttempts(f.operation.id)
  assert.equal(result.status, 'budget_exhausted')
  assert.equal(attempts.length, 3); assert.equal(result.operation.callsUsed, 3)
  assert.equal(f.store.readBudgetUsage(f.operation.id).repairFailures, 3)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal(result.operation.policyDigest, policyDigest); assert.equal(syncPlanDigest(f.plan), policyDigest)
  assert.deepEqual(f.plan.decisionAuthorities, authorities)
  assert.equal(new Set(f.calls.map(call => call.requestKey)).size, 3)
  for (const attempt of attempts) {
    assert.equal(attempt.failure?.kind, 'repairable'); assert.equal(attempt.failure?.code, code)
    assert.equal(attempt.candidate, null)
    const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.equal(stages.some(stage => stage.stage === 'analysis' || stage.stage === 'elaboration'), false)
  }
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const code of ['structured_output_retries_exhausted', 'structured_output_format_invalid', 'native_worktree_result_invalid'] as const) test(`精确结构输出失败 ${code} 的旧native资源尚未removed时保留recovery_required且不派发下一attempt`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 6, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code', 'claude:MiniMax-M3.1-Flash')
  const { fromRaw, writeRecord } = await import('../session-record.js')
  const { configuredSessionApplication } = await import('../session-application.js')
  f.transform(() => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    const requestKey = `schema-held:${attempt.id}`, inputDigest = contentHash('held-input')
    const frozenContext = freezeContext({ directory: f.parent, sourceRoot: f.root, binding: { requestKey, inputDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('held original task') }] })
    const request = { root: f.root, prompt: 'held original prompt', schema: { type: 'object' }, requestKey, inputDigest, purpose: 'code_behavior_analyze', timeoutMs: 1000, model: 'claude:MiniMax-M3.1-Flash', frozenContext }
    const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(fence, { key: requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: f.input.id, candidateDigest: null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: true, nativeState: 'failed', session: { sessionId: expectedSessionId, threadId: 'original-thread', turnId: 'original-user' } }
    const resource = f.store.planResource(fence, { key: requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: writeEvidence(f.input.source.commonDir, checkpoint) })
    f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: resource.checkpointRef, checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, phase: 'created' }) })
    const policy = structuredExecutionPolicy(request)
    configuredSessionApplication().createSession({ sessionId: expectedSessionId, status: 'awaiting', proposal: 'nothing' })
    const record = fromRaw({ session_id: expectedSessionId, governed: true, worktree_path: f.root, branch: null, title: null, name: null, status: 'awaiting', proposal: 'nothing', merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'claude-headless', launch_cmd: 'claude', harness_session_id: 'original-thread', create_request_id: contentHash(dispatch.sessionCreateKey), create_payload_hash: contentHash(JSON.stringify({ prompt: request.prompt, parent: null, launcher: null, structuredExecution: policy })) })
    record.structuredExecution = { ...policy, state: 'failed', error: 'original schema error', errorCode: code, turnStartRequested: true, threadId: 'original-thread', turnId: 'original-user', claudeNative: { version: 1, root: join(f.parent, 'unproven-native'), sessionId: 'original-thread', userUuid: 'original-user' } }
    writeRecord(record)
    throw new StructuredSessionError(code, 'original schema error', { sessionId: expectedSessionId, threadId: 'original-thread', turnId: 'original-user' })
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'recovery_required'); assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
  const resource = f.store.listRecoverableResources().find(item => item.operation.id === f.operation.id)!
  assert.equal(resource.resource.phase, 'created'); assert.equal(resource.attempt.failure?.kind, 'repairable')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('普通unsupported或failed与未停的cancellation_pending不取得结构输出耗尽的自动修复分类', async t => {
  for (const code of ['unsupported', 'failed', 'stale_result', 'cancellation_pending'] as const) {
    const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
    f.transform(() => { throw new StructuredSessionError(code, 'preserved native rejection') })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, code === 'cancellation_pending' ? 'recovery_required' : 'unsupported')
    assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
  }
})

test('缺错误码或普通Error伪造精确结构码不取得自动修复资格', async t => {
  for (const error of [new Error('structured_output_retries_exhausted without authenticated code'), Object.assign(new Error('untrusted exact code'), { code: 'structured_output_retries_exhausted' })]) {
    const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
    f.transform(() => { throw error })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, 'unsupported')
    assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
  }
})

for (const rejection of ['behavior_analysis_invalid', 'behavior_review_failed'] as const) test(`显式retryOf把同输入政策读集合的完整${rejection}诊断交新分析与新独审，仅作未批准数据`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 2, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => rejection === 'behavior_analysis_invalid'
    ? request.purpose === 'code_behavior_analyze' ? { ...(output as object), changes: [] } : output
    : request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  let previous = (await runSyncOperation(f.store, f.operation.id, f.options)).operation
  const diagnostics = f.store.listAttempts(previous.id).map(attempt => ({ code: attempt.failure!.code, message: attempt.failure!.message }))
  assert.equal(diagnostics[0].code, rejection)
  assert.equal(JSON.parse(diagnostics[0].message).approved, false)
  for (let index = 0; index < 2; index++) {
    const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: `ownership-diagnostic-retry-${index}`, rootCauseId: `ownership-diagnostic-retry-${index}`, retryOf: previous.id, origin: previous.origin, budget: previous.budget, managedRoot: f.managedRoot }))
    f.useOperation(next)
    const received: { purpose: string; repairDiagnostics: { code: string; message: string }[] }[] = []
    f.transform((output, request) => {
      if (['code_behavior_analyze', 'code_behavior_review'].includes(request.purpose)) {
        const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { repairDiagnostics: { code: string; message: string }[] }
        received.push({ purpose: request.purpose, repairDiagnostics: context.repairDiagnostics })
      }
      return index === 0 && request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output
    })
    const result = await runSyncOperation(f.store, next.id, f.options)
    assert.equal(result.status, 'budget_exhausted')
    assert.deepEqual(received.map(item => item.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    for (const item of received) { assert.equal(item.repairDiagnostics.length, diagnostics.length); assert.deepEqual(item.repairDiagnostics, diagnostics) }
    assert.deepEqual(result.operation.budget, next.budget)
    assert.equal(result.operation.deadlineAtMs, next.deadlineAtMs)
    assert.equal(result.operation.callsUsed, 2)
    assert.equal(f.store.listAttempts(next.id).length, 1)
    if (index === 0) { const failure = f.store.listAttempts(next.id)[0].failure!; diagnostics.push({ code: failure.code, message: failure.message }) }
    previous = result.operation
  }
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false)
  assert.equal(f.store.listJournals(previous.id).length, 0)
})

test('显式retryOf不同input政策readset仍拒准入，合法P4扩scope不借旧诊断也不阻断新分析', async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 4, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const ancestor = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-diagnostic-ancestor', rootCauseId: 'p4-diagnostic-ancestor', origin: 'code', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  const acknowledge = (id: string) => { for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === id) break } }
  acknowledge(ancestor.id); f.useOperation(ancestor)
  const options = { ...f.options, plan, readCurrentPlan: () => plan }
  f.transform((output, request) => request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  const failed = await runSyncOperation(f.store, ancestor.id, options), beforeCalls = f.calls.length
  assert.equal(failed.status, 'budget_exhausted')
  const retryOptions = { ingressKey: 'p4-diagnostic-retry', rootCauseId: 'p4-diagnostic-retry', retryOf: ancestor.id, origin: ancestor.origin, budget: ancestor.budget, managedRoot: f.managedRoot, baselineSelection: failed.operation.baselineSelection!, executionScope: failed.operation.scope, impactDigest: failed.operation.impactDigest }
  const admission = await prepareSyncAdmission(f.input, plan, retryOptions)
  const policyAdmission = await prepareSyncAdmission(f.input, { ...plan, facts: [...plan.facts, { source: 'decision:OTHER-POLICY', text: '不同的可信政策' }] }, { ...retryOptions, ingressKey: 'different-policy-retry', rootCauseId: 'different-policy-retry' })
  for (const candidate of [{ ...admission, input: { ...admission.input, id: contentHash('different-input') } }, policyAdmission, { ...admission, readSetDigest: contentHash('different-readset') }]) {
    assert.throws(() => f.store.admitAndEnqueue(candidate), (error: Error & { code: string }) => error.code === 'SYNC_RETRY_BINDING')
  }
  assert.throws(() => f.store.admitAndEnqueue({ ...admission, input: { ...admission.input, source: { ...admission.input.source, branch: 'refs/heads/foreign-source' } } }), (error: Error & { code: string }) => error.code === 'SYNC_BASELINE_STALE')
  assert.throws(() => f.store.admitAndEnqueue({ ...admission, baselineSelection: { ...admission.baselineSelection!, digest: contentHash('foreign selection') } }), (error: Error & { code: string }) => error.code === 'SYNC_BASELINE_STALE')
  assert.throws(() => f.store.admitAndEnqueue({ ...admission, retryOf: 'missing-official-ancestor' }), (error: Error & { code: string }) => error.code === 'SYNC_OPERATION_UNKNOWN')
  assert.equal(f.calls.length, beforeCalls)
  const next = f.store.admitAndEnqueue(admission)
  f.useOperation(next); acknowledge(next.id)
  const claimed = f.store.claimQueuedAttempt({ operationId: next.id, source: next.input.source, scope: next.scope, leaseMs: 30000, expectedRevision: f.store.readOperation(next.id).revision })
  const compose = (operation: typeof next) => composeAuthoredInput(f.input, operation.baselineSelection!, { retainConflicts: true, executionPaths: operation.scope.paths, contextPaths: plan.readPaths }).composed!
  f.store.bindComposedInput(claimed.fence, compose(next))
  f.store.startElaboration(claimed.fence)
  const p1Evidence = writeEvidence(f.input.source.commonDir, { reviewedP1: rows(original, contractPath) })
  const expanded = f.store.expandContractScope(claimed.fence, { paths: [contractPath, 'src/export.js'], contractIds: ['REQ-EXPORT-01'], flowIds: [] }, p1Evidence)
  const rebound = await prepareSyncAdmission(f.input, plan, { ...retryOptions, baselineSelection: expanded.baselineSelection!, executionScope: expanded.scope })
  assert.notEqual(rebound.readSetDigest, next.readSetDigest)
  f.store.bindComposedInput(claimed.fence, compose(expanded), { readSetDigest: rebound.readSetDigest })
  f.store.recordFailure(claimed.fence, { code: 'scope_context_expanded', message: '已审作用域引入真实上下文，下一原预算尝试重新分析绑定', kind: 'repairable', evidenceRefs: [p1Evidence] })
  assert.equal(f.store.readOperation(ancestor.id).readSetDigest, failed.operation.readSetDigest)
  assert.equal(f.store.readOperation(next.id).readSetDigest, rebound.readSetDigest)
  const received: { code: string; message: string }[][] = []
  f.transform((output, request) => {
    if (['code_behavior_analyze', 'code_behavior_review'].includes(request.purpose)) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { repairDiagnostics: { code: string; message: string }[] }
      received.push(context.repairDiagnostics)
    }
    return request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output
  })
  const result = await runSyncOperation(f.store, next.id, options)
  assert.equal(result.status, 'budget_exhausted')
  assert.deepEqual(received.map(items => items.length), [0, 0, 1, 1])
  const currentFailure = f.store.listAttempts(next.id).find(attempt => attempt.failure?.code === 'behavior_review_failed')!.failure!
  assert.deepEqual(received[2], [{ code: currentFailure.code, message: currentFailure.message }])
  assert.deepEqual(received[3], received[2])
  assert.equal(f.calls.length, beforeCalls + 4)
  assert.deepEqual(f.store.listAttempts(next.id).map(attempt => attempt.number), [1, 2, 3])
  assert.deepEqual(result.operation.budget, next.budget)
  assert.equal(result.operation.deadlineAtMs, next.deadlineAtMs)
  assert.equal(result.operation.callsUsed, 4)
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false)
})

test('新decision独审仍有相同稳定冲突ID时完整阻断，不因旧finding被选择而删除发现', async t => {
  const f = await fixture(t, undefined, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => request.purpose === 'code_behavior_analyze' ? { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: 'conflict', affectedIds: ['REQ-EXPORT-01'] })) } : output)
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'conflicted', JSON.stringify(first.failure))
  const attempt = f.store.readAttempt(first.operation.currentAttemptId!), wrapper = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const originalAnalysis = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  const requestBlob = prepareControlledDecision(f.input, { requestId: 'keep-original-intent', operationId: first.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: originalAnalysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' } })
  const plan = structuredClone(f.plan); plan.facts = [...plan.facts, { source: 'decision:keep-original-intent', text: '保留原意纠正实现；仍须独审其他明确政策' }]
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'decision-after-conflict', rootCauseId: first.operation.rootCauseId, origin: 'decision', budget: first.operation.budget, managedRoot: f.managedRoot, requestBlob }))
  f.useOperation(next)
  const result = await runSyncOperation(f.store, next.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(f.calls.some(call => call.purpose === 'code_generate'), false)
  const newAttempt = f.store.readAttempt(result.operation.currentAttemptId!), newWrapper = newAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const analysis = JSON.parse(readEvidence(f.input.source.commonDir, newWrapper.resultRef).toString()) as { findings: { id: string }[]; policyDigest: string }
  assert.equal(analysis.policyDigest, result.operation.policyDigest); assert.equal(analysis.findings[0].id, originalAnalysis.findings[0].id)
  assert.equal(f.store.listJournals(next.id).length, 0)
})

for (const invalid of ['foreign-decision', 'wrong-test', 'unselected-rule', 'unchanged-rule', 'keep-choice'] as const) test(`P3 oracle政策声明 ${invalid} 不得误报needs_input或获得授权`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  let source = ''
  const fact = { source: '', text: '只按当前所选裁决将filter限制为8字符；其他政策保持' }
  f.transform((output, request) => {
    const chosen = Boolean(source)
    if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: chosen ? 'allowed_change' : 'conflict', affectedIds: chosen ? ['RULE-EXPORT-02', 'AC-EXPORT-02'] : ['REQ-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'] })), facts: chosen ? [fact] : [], acceptanceChanges: chosen && invalid !== 'keep-choice' ? [{ id: 'AC-EXPORT-02', ruleIds: ['RULE-EXPORT-02'], source, reason: '对应当前已选filter8规则' }] : [] }
    if (chosen && request.purpose === 'elaboration_generate' && invalid !== 'keep-choice' && invalid !== 'unchanged-rule') {
      const candidate = structuredClone(output) as GeneratedElaboration, rule = candidate.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-02')!, ac = candidate.changes[0].tables.AC.find(row => row.id === 'AC-EXPORT-02')!
      rule.constraint = `${rule.constraint}；filter最多8字符`; rule.source = source; ac.assertion = `${ac.assertion}；9字符拒绝`; ac.source = source
      return candidate
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'needs_input', findings: [{ kind: 'missing_fact', affectedIds: invalid === 'unselected-rule' ? ['RULE-EXPORT-01', 'AC-EXPORT-02'] : ['RULE-EXPORT-02', 'AC-EXPORT-02'], ruleLocation: invalid === 'foreign-decision' ? 'oracle-policy:decision:old-other-decision' : `oracle-policy:${source}`, codeLocation: `tests/export.test.mjs#${invalid === 'wrong-test' ? 'NOT-MANDATORY' : 'AC-EXPORT-03'}`, evidence: '宣称新规则与旧只读oracle相撞，必须先核真实裁决/规则/精确test绑定', counterexample: 'filter9必须接受或拒绝，不能把无绑定声明当业务输入', message: '需要更新oracle版本' }] }
    return output
  })
  const originalResult = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(originalResult.status, 'conflicted', JSON.stringify({ failure: f.store.readAttempt(originalResult.operation.currentAttemptId!).failure, calls: f.calls.map(call => call.purpose) }))
  const previous = f.store.readAttempt(originalResult.operation.currentAttemptId!), wrapper = previous.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis'), analysis = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  const request = { requestId: `oracle-invalid-${invalid}`, operationId: f.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: analysis.findings.map(finding => finding.id), decision: invalid === 'keep-choice' ? { choice: 'keep_intent' as const } : { choice: 'new_rule' as const, rule: 'filter最多8字符，其他政策保持。' } }
  source = `decision:${controlledDecisionIdentity(request)}`; fact.source = source
  const requestBlob = prepareControlledDecision(f.input, request), plan = { ...f.plan, facts: [...f.plan.facts, fact] }
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: `decision-${invalid}`, rootCauseId: f.operation.rootCauseId, origin: 'decision', budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob })); f.useOperation(next)
  const result = await runSyncOperation(f.store, next.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure?.code, 'review_invalid', JSON.stringify(result.failure))
  assert.notEqual(result.status, 'needs_input'); assert.equal(result.receipt, undefined); assert.equal(f.store.listJournals(next.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


test('P3公共计划新增治理实际receipt后ff接受、搬迁再完整退役，旧oracle和负向AC仍经Docker', { skip: docker.skip, timeout: 600000 }, async t => {
  const f = await fixture(t)
  f.git('reset', '--hard', 'HEAD')
  const verification = { ...f.plan.verifications[0], definition: { id: 'VERIFY-SUMMARY-01', command: ['node', '--test', 'generated-tests/summary.test.mjs'], cwd: '.', timeoutMs: 10000 } }
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['package.json'], verifications: [...f.plan.verifications, verification], mandatoryTests: f.plan.mandatoryTests, facts: f.plan.facts, budget: { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300000 } } }))
  writeFileSync(join(f.root, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n')
  f.git('add', '.'); f.git('commit', '-m', 'explicit authorized helper source and verification')
  const nodeId = `sync-code-${contentHash('src/summary.js').slice(0, 16)}`, path = `.spec/project/export-contract/${nodeId}/spec.md`
  const child = `---
title: 导出计数辅助
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循导出原始反馈需求。

## expanded spec

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-EXPORT-01,RULE-EXPORT-05 | 成功行数组 | 读取计数辅助 | 返回rows.length | generated-tests/summary.test.mjs#AC-SUMMARY-01 | VERIFY-SUMMARY-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |

### VERIFY

| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-SUMMARY-01 | ["node","--test","generated-tests/summary.test.mjs"] | . | 10000 |
`
  assert.ok(parseContract({ nodeId, path, source: child }).contract, JSON.stringify(parseContract({ nodeId, path, source: child }).findings))
  let retiring = false, moving = false
  const movedId = 'moved-summary', movedPath = `.spec/project/export-contract/${movedId}/spec.md`
  let activePath = path, activeNodeId = nodeId
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; paths: string[] }[]; newNodes: unknown[]; resolutions: unknown[] }
      value.changes.forEach(change => { change.kind = 'allowed_change' })
      value.newNodes = retiring || moving ? [] : [{ codePath: 'src/summary.js', parentNodeId: 'export-contract', basis: '已有结果反馈原意支持内部长度辅助，无新增政策' }]
      value.resolutions = retiring ? [{ path: activePath, content: null, mode: null }] : []
      return value
    }
    if (request.purpose === 'elaboration_generate' && !retiring) {
      const value = output as GeneratedElaboration, generated = rows(child, activePath).changes[0]
      generated.nodeId = activeNodeId; return { ...value, changes: [...value.changes.filter(change => f.options.plan.targets.some(target => target.path === change.path)), generated] }
    }
    if (request.purpose === 'code_generate') {
      const value = output as { changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: string | null; content: string | null }[] }, frozen = promptInput(request), previous = frozen.manifest.entries.find(entry => entry.path === 'generated-tests/summary.test.mjs')
      return { ...value, changes: [...value.changes, { path: 'generated-tests/summary.test.mjs', beforeDigest: previous?.digest ?? null, beforeMode: previous?.mode ?? null, mode: previous ? null : '100644', content: retiring ? "import assert from 'node:assert/strict'; import test from 'node:test'; import { existsSync } from 'node:fs'; test('AC-SUMMARY-01', () => assert.equal(existsSync(new URL('../src/summary.js', import.meta.url)), false));\n" : "import assert from 'node:assert/strict'; import test from 'node:test'; import { resultCount } from '../src/summary.js'; test('AC-SUMMARY-01', () => assert.equal(resultCount([1,2]), 2));\n" }] }
    }
    return output
  })
  await f.realTools()
  const snapshot = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(snapshot, 'export-contract')
  const first = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, { ingressKey: 'public-helper', rootCauseId: 'public-helper', origin: 'code', budget: f.operation.budget, managedRoot: f.managedRoot }))
  assert.deepEqual(first.scope.paths, plan.writePaths, '无精确资源选择的冻结操作保留目录准入授权');
  f.useOperation(first); f.options.plan = plan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(snapshot, 'export-contract')
  const initial = await runSyncOperation(f.store, first.id, f.options)
  assert.equal(initial.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(first.id).map(attempt => ({ failure: attempt.failure, detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as { rounds?: { findings?: unknown[] }[] }; return value.rounds?.map(round => round.findings) ?? value }) }))))
  const baseline = f.store.readBaseline(snapshot.source)!, delivery = baseline.verifiedDelivery.source.canonicalRoot
  assert.equal(existsSync(join(f.root, path)), false); assert.equal(existsSync(join(delivery, path)), true)
  assert.ok(f.store.listJournals(first.id)[0].receipt); assert.equal(baseline.sourceInput.id, snapshot.id)
  f.git('merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  moving = true; activePath = movedPath; activeNodeId = movedId
  renameSync(join(f.root, path.slice(0, -'spec.md'.length)), join(f.root, movedPath.slice(0, -'spec.md'.length)))
  const movedInput = await captureInputSnapshot(f.root), movedPlan = await buildSyncApplicationPlan(movedInput, movedId, baseline)
  const moved = f.store.admitAndEnqueue(await prepareSyncAdmission(movedInput, movedPlan, { ingressKey: 'public-move', rootCauseId: 'public-move', origin: 'code', previousBaselinePair: baseline, budget: f.operation.budget, managedRoot: f.managedRoot }))
  f.useOperation(moved); f.options.plan = movedPlan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(movedInput, movedId, baseline)
  const moveIndex = readFileSync(join(f.root, '.git/index')), movedResult = await runSyncOperation(f.store, moved.id, f.options)
  assert.equal(movedResult.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(moved.id).map(attempt => ({ failure: attempt.failure, prepare: attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(movedInput.source.commonDir, ref).toString('utf8'))).filter(value => value.kind === 'private-delivery-prepare'), detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(movedInput.source.commonDir, ref).toString('utf8')) as { rounds?: { findings?: unknown[] }[] }; return value.rounds?.map(round => round.findings) ?? value }) }))))
  const movedBaseline = f.store.readBaseline(movedInput.source)!, movedJournal = f.store.listJournals(moved.id)[0]
  assert.equal(movedJournal.status, 'settled'); assert.ok(movedJournal.receipt)
  assert.ok(f.store.readAttempt(f.store.readOperation(moved.id).currentAttemptId!).verification!.passed)
  const moveTree = readTree(movedInput.source.commonDir, movedJournal.receipt.actualTree)
  assert.equal(moveTree.some(entry => entry.path === path), false); assert.equal(moveTree.some(entry => entry.path === movedPath), true)
  const movedContract = parseContract({ nodeId: movedId, path: movedPath, source: readFileSync(join(movedBaseline.verifiedDelivery.source.canonicalRoot, movedPath), 'utf8') }).contract!
  assert.deepEqual(movedContract.items.map(item => item.id).sort(), ['AC-SUMMARY-01', 'VERIFY-SUMMARY-01'])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), moveIndex); assert.equal((await captureInputSnapshot(f.root)).id, movedInput.id)
  const moveCalls = f.calls.length, moveCommits = f.git('rev-list', '--count', moved.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, moved.id, f.options)).receipt, movedJournal.receipt)
  assert.equal(f.calls.length, moveCalls); assert.equal(f.git('rev-list', '--count', moved.deliveryPlan.branch), moveCommits)
  // 作者接受已验证交付后保留未跟踪草稿，避免Git覆盖其字节。
  const moveDraft = readFileSync(join(f.root, movedPath)), savedDraft = join(f.parent, 'accepted-move-draft.md')
  renameSync(join(f.root, movedPath), savedDraft)
  assert.deepEqual(readFileSync(savedDraft), moveDraft)
  f.git('merge', '--ff-only', movedBaseline.verifiedDelivery.headCommit)
  rmSync(join(f.root, movedPath)); rmSync(join(f.root, 'src/summary.js'))
  retiring = true
  const nextInput = await captureInputSnapshot(f.root), nextIndex = readFileSync(join(f.root, '.git/index')), nextPlan = await buildSyncApplicationPlan(nextInput, movedId, movedBaseline)
  assert.equal(nextPlan.intentNodeId, 'export-contract'); assert.equal(nextPlan.authorizedChanges, undefined)
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(nextInput, nextPlan, { ingressKey: 'public-retire', rootCauseId: 'public-retire', origin: 'code', previousBaselinePair: movedBaseline, budget: f.operation.budget, managedRoot: f.managedRoot }))
  f.useOperation(next); f.options.plan = nextPlan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(nextInput, movedId, movedBaseline)
  const result = await runSyncOperation(f.store, next.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(next.id).map(attempt => attempt.failure)))
  const settled = f.store.readBaseline(nextInput.source)!
  assert.ok(['AC-SUMMARY-01', 'VERIFY-SUMMARY-01', movedId].every(id => settled.retiredIds!.includes(id)))
  const finalDelivery = settled.verifiedDelivery.source.canonicalRoot
  assert.equal(existsSync(join(finalDelivery, movedPath)), false); assert.equal(existsSync(join(finalDelivery, 'src/summary.js')), false)
  assert.equal(readFileSync(join(finalDelivery, 'tests/export.test.mjs'), 'utf8'), readFileSync(join(f.root, 'tests/export.test.mjs'), 'utf8'))
  assert.ok(readFileSync(join(finalDelivery, 'generated-tests/summary.test.mjs'), 'utf8').includes('existsSync'))
  assert.ok(f.store.readAttempt(f.store.readOperation(next.id).currentAttemptId!).verification!.passed)
  const retirementJournal = f.store.listJournals(next.id)[0]
  assert.equal(retirementJournal.status, 'settled'); assert.ok(retirementJournal.receipt)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), nextIndex); assert.equal((await captureInputSnapshot(f.root)).id, nextInput.id)
  const retirementCalls = f.calls.length, retirementCommits = f.git('rev-list', '--count', next.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, next.id, f.options)).receipt, retirementJournal.receipt)
  assert.equal(f.calls.length, retirementCalls); assert.equal(f.git('rev-list', '--count', next.deliveryPlan.branch), retirementCommits)
})


test('P3实际partial正文A与后续immutable作者B同行重叠，独审resolution原意经Docker与receipt完整交付', { skip: docker.skip, timeout: 300000 }, async t => {
  const sentence = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。', a = `${sentence} 已交付A保持有效。`, b = `${sentence} 原immutable作者B保持有效。`, merged = original.replace(sentence, `${sentence} 已交付A保持有效。原immutable作者B保持有效。`)
  const f = await fixture(t, undefined, false, original, 'project', original, {}, { original: sentence + '此输入是固定业务验收夹具；decision:EXPORT-POLICY 表示测试作者提供的显式业务事实，只适用于夹具。', replacement: a + '此输入是固定业务验收夹具；decision:EXPORT-POLICY 表示测试作者提供的显式业务事实，只适用于夹具。', intent: '明确作者A原意，业务规则与原oracle不改', testPath: 'generated-tests/unused-author-registration.test.mjs' })
  let second = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string }[]; resolutions: unknown[] }
      value.changes.forEach(change => { change.kind = 'allowed_change' }); if (second) value.resolutions = [{ path: contractPath, content: merged, mode: '100644' }]
      return value
    }
    if (second && request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { intent: { rawSource: string }; targets: { path: string; rawSource?: string }[] }
      assert.ok(frozen.intent.rawSource.includes('已交付A')); assert.ok(frozen.intent.rawSource.includes('原immutable作者B'))
      assert.ok(frozen.targets.find(target => target.path === contractPath)!.rawSource!.includes('已交付A'))
    }
    if (second && request.purpose === 'code_review') {
      const frozen = promptInput(request), spec = frozen.elaboratedSpecs.find(spec => spec.path === contractPath)!.source
      assert.ok(spec.includes('已交付A')); assert.ok(spec.includes('原immutable作者B'))
      assert.equal(parseParts(spec)!.rawSource, parseParts(merged)!.rawSource)
    }
    return output
  })
  await f.realTools()
  const initial = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(initial.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(f.operation.id).map(attempt => attempt.failure)))
  const baseline = f.store.readBaseline(f.input.source)!
  assert.ok(readFileSync(join(baseline.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes('已交付A'))
  const author = prepareControlledRequest(f.input, { path: contractPath, source: original, next: original.replace(sentence, b), changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'raw-B-after-A', nodeId: 'export-contract', intent: '原作者B与A相容，原业务及验证政策保持' })
  assert.ok(author.changed)
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'raw-integrated-B', rootCauseId: 'raw-integrated-B', origin: 'combined', previousBaselinePair: baseline, budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob: author.requestBlob })
  const operation = f.store.admitAndEnqueue(admission); f.useOperation(operation); second = true
  const result = await runSyncOperation(f.store, operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(operation.id).map(attempt => attempt.failure)))
  const attempt = f.store.readAttempt(f.store.readOperation(operation.id).currentAttemptId!)
  assert.equal(attempt.verification!.passed, true)
  const journal = f.store.listJournals(operation.id)[0]
  assert.equal(journal.status, 'settled'); assert.ok(journal.receipt); assert.deepEqual(result.receipt, journal.receipt)
  const receipt = journal.receipt, entry = readTree(f.input.source.commonDir, receipt.actualTree).find(entry => entry.path === contractPath)!
  const actual = readObject(f.input.source.commonDir, entry.oid).toString('utf8')
  assert.equal(parseParts(actual)!.rawSource, parseParts(merged)!.rawSource)
  assert.equal(readFileSync(join(receipt.deliverySnapshot.source.canonicalRoot, contractPath), 'utf8'), actual)
  const delivered = parseContract({ nodeId: 'export-contract', path: contractPath, source: actual }).contract!
  for (const item of parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items) assert.ok(sameContractBusinessMeaning(item, delivered.items.find(current => current.id === item.id)!), item.id)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  const calls = f.calls.length, commits = f.git('rev-list', '--count', operation.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, operation.id, f.options)).receipt, receipt)
  assert.equal(f.calls.length, calls); assert.equal(f.git('rev-list', '--count', operation.deliveryPlan.branch), commits)
})


for (const mode of ['contract-live', 'contract-restart', 'symbol-live', 'symbol-restart', 'omission-live', 'legacy-stage-restart', 'legacy-rule-ac-stage-restart', 'legacy-repair-input-restart', 'invalid-stage-restart', 'corrupt-stage-restart'] as const) test(`P3生成诊断 ${mode} 区分普通测试修复与明确契约遗漏并保完整发现`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 })
  let activeStore = f.store, p1Calls = 0
  const path = '.spec/project/export-contract/spec.md', omission = mode === 'omission-live', persisted = /^(legacy|invalid|corrupt)-/.test(mode), broken = /^(invalid|corrupt)-/.test(mode), contractReference = mode.startsWith('contract') || persisted
  const findings = [
    { kind: 'repair' as const, affectedIds: mode === 'legacy-rule-ac-stage-restart' ? ['AC-EXPORT-07'] : ['RULE-EXPORT-05'], ruleLocation: `${omission ? 'contract-omission:' : contractReference ? 'contract:' : ''}${path}#RULE-EXPORT-05`, codeLocation: 'tests/export.test.mjs#assertCall', evidence: omission ? 'raw明确重复完成保首次结果，已接受Spec缺少必要重复失败边界' : '测试 helper 参数错误导致 TypeError，已批准规则完整', counterexample: '重复COMPLETE先突变result再校验，second.csv覆盖first.csv，必须先保旧结果', message: omission ? '原意明确但已接受契约遗漏必要重复边界' : '修测试helper和重复断言，不改已审业务正文' },
    { kind: 'repair' as const, affectedIds: ['AC-EXPORT-07'], ruleLocation: `${contractReference ? 'contract:' : ''}${path}#AC-EXPORT-07`, codeLocation: 'tests/export.test.mjs#repeat-complete', evidence: '断言读取错误字段', counterexample: 'COMPLETE(first.csv)后再次COMPLETE(second.csv)必须仍first.csv', message: '保留首次结果的具体断言' },
  ]
  f.transform((output, request) => {
    const attempt = activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) {
        assert.equal(omission, true, '普通code/test修复不得再次派发P1')
        const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { refinement: { diagnostics: { message: string }[] } }
        assert.deepEqual(JSON.parse(frozen.refinement.diagnostics[0].message), findings[0], '明确遗漏进入既有refinement诊断')
      }
    }
    if (request.purpose === 'code_generate' && attempt.number > 1 && !omission) {
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { diagnostics: { code: string; message: string }[] } }
      for (const finding of findings) assert.ok(frozen.repairContext.diagnostics.some(item => item.code === finding.kind && item.message === JSON.stringify(finding)), '下一生成必须逐字收到完整实际finding，含位置/证据/反例')
      const first = promptInput(f.calls.find(call => call.purpose === 'code_generate')!)
      assert.deepEqual(frozen.elaboratedSpecs, first.elaboratedSpecs); assert.deepEqual(frozen.contracts, first.contracts)
    }
    if (request.purpose === 'code_review') return attempt.number === 1 ? { ...(output as object), verdict: 'repair', findings } : { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#dispatch', evidence: 'fixture在新独审停止，不冒称V3通过', counterexample: '真实运行另验', message: 'fixture stops before V3' }] }
    return output
  })
  if (mode.endsWith('restart')) {
    let legacyRefinement: unknown, legacyRepairContext: unknown
    const checkpoint = (fence: Parameters<SyncStore['checkpoint']>[0], name: string, value: unknown): void => {
      const operation = activeStore.readOperation(f.operation.id), resultRef = writeEvidence(f.input.source.commonDir, value)
      activeStore.checkpoint(fence, resultRef)
      activeStore.checkpoint(fence, writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: fence.attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest, stage: name, resultRef }))
    }
    if (persisted) {
      const record = activeStore.recordFailure.bind(activeStore)
      activeStore.recordFailure = (fence, issue) => {
        if (issue.code === 'generation_failed') {
          const stages = activeStore.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
          const prior = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'elaboration').resultRef).toString()), generation = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'generation').resultRef).toString())
          const finding = mode === 'invalid-stage-restart' ? { ...findings[0], ruleLocation: `contract-omission:${path}#MISSING-ID` } : findings[0]
          legacyRepairContext = { previousOutput: generation.output, diagnostics: [{ code: 'generation_failed', message: '实现候选或独立评审未通过' }, ...generation.validationFindings.map((item: { code: string; message: string }) => ({ code: item.code, message: item.message }))] }
          legacyRefinement = { prior, candidate: generation.candidate, candidateDigest: generation.candidate.digest, diagnostics: findings.map((actual, index) => ({ code: 'contract_boundary_omission', message: mode === 'corrupt-stage-restart' && index === 0 ? '{broken-json' : JSON.stringify(index === 0 ? finding : actual) })) }
          if (mode !== 'legacy-repair-input-restart') checkpoint(fence, 'refinement', legacyRefinement)
        }
        return record(fence, issue)
      }
    }
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'generation_failed')) {
        if (mode === 'legacy-repair-input-restart') { const claimed = claim(request); checkpoint(claimed.fence, 'repair-input', { refinement: legacyRefinement, repairContext: legacyRepairContext }) }
        throw new Error('fixture process boundary after durable code review rejection')
      }
      return claim(request)
    }
    const first = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(first.status, 'unsupported')
    assert.equal(first.failure?.code, 'coordinator_failed')
    assert.equal(first.failure?.message, 'fixture process boundary after durable code review rejection')
    assert.equal(activeStore.listAttempts(f.operation.id).find(attempt => attempt.number === 1)?.failure?.code, 'generation_failed')
    assert.equal(first.operation.callsUsed, 4)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  if (broken) { assert.equal(result.failure?.code, mode === 'corrupt-stage-restart' ? 'coordinator_failed' : 'refinement_binding'); assert.equal(p1Calls, 1); assert.equal(result.operation.callsUsed, 4); assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes); return }
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, attempts: activeStore.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  assert.equal(p1Calls, omission ? 2 : 1); assert.equal(result.operation.callsUsed, omission ? 8 : 6)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs); assert.equal(result.operation.input.id, f.input.id)
  assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.equal(result.receipt, undefined)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  const calls = f.calls.length
  assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'conflicted'); assert.equal(f.calls.length, calls)
})


test('P2 anchor-dead来源修复只改真实代码绑定并保留AC测试与业务契约', async t => {
  const sourcePath = 'src/export.js', testPath = 'tests/export.test.mjs', targetPath = '.spec/project/export-contract/spec.md'
  const initialSource = original.split('\n').map(line => line.startsWith('| AC-EXPORT-') ? line.replace(' | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |', ` | code:${sourcePath}#ExportService | REQ-EXPORT-01 |`) : line).join('\n')
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120_000 }, false, initialSource)
  let codeGenerations = 0, initialSpec = '', repairedSpec = '', repairDiagnostics: { code: string; message: string }[] = [], frozenPrompt: FrozenGenerationPrompt | null = null
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const generated = structuredClone(output) as GeneratedElaboration
      for (const acceptance of generated.changes[0].tables.AC) acceptance.source = `code:${testPath}#${String(acceptance.id)}`
      return generated
    }
    if (request.purpose === 'code_generate') {
      codeGenerations++
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext?: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } }
      const elaborated = frozen.elaboratedSpecs.find(spec => spec.path === targetPath)!
      if (codeGenerations === 1) {
        initialSpec = elaborated.source
        frozenPrompt = frozen
        return output
      }
      assert.equal(codeGenerations, 2, '该夹具只需一次源绑定修复')
      assert.equal(elaborated.source, initialSpec, '修复继续使用同一份已接受的P1契约')
      assert.ok(frozen.repairContext, '失败诊断必须到达下一次代码生成')
      repairDiagnostics = frozen.repairContext!.diagnostics.filter(item => item.code === 'anchor-dead')
      const before = parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!
      const acceptanceIds = before.items.filter(item => item.kind === 'AC').map(item => item.id)
      assert.equal(repairDiagnostics.length, acceptanceIds.length, '每个无效AC代码锚点都应带入下一次修复')
      for (const id of acceptanceIds) assert.ok(repairDiagnostics.some(item => item.message.includes(`${testPath}#${id}`)), `具体anchor-dead诊断必须指向${id}`)
      repairedSpec = initialSpec
      for (const id of acceptanceIds) {
        const oldCell = `| code:${testPath}#${id} |`
        assert.ok(repairedSpec.includes(oldCell), `AC.test ID ${id} 当前被错误写成代码符号`)
        repairedSpec = repairedSpec.replace(oldCell, `| code:${sourcePath}#ExportService |`)
      }
      const candidate = structuredClone(output) as { changes: { path: string; content: string }[] }
      candidate.changes.find(change => change.path === targetPath)!.content = repairedSpec
      return candidate
    }
    if (request.purpose === 'code_review') return { ...(output as Record<string, unknown>), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['AC-EXPORT-01'], ruleLocation: 'RULE-EXPORT-01', codeLocation: `${sourcePath}#ExportService`, evidence: '测试在验证硬门禁后停止，不覆盖真实独立审查或V3', counterexample: '完整产品验收由真实Dashboard场景另行证明', message: '窄回归在可信候选门禁后停止' }] }
    return output
  })

  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, calls: f.calls.map(call => call.purpose), attempts: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  assert.equal(codeGenerations, 2)
  const attempts = f.store.listAttempts(f.operation.id)
  const generationFor = (attempt: typeof attempts[number]) => {
    const ref = attempt.checkpointRefs.map(item => JSON.parse(readEvidence(f.input.source.commonDir, item).toString())).find(item => item.version === 'sync-stage-v1' && item.stage === 'generation')
    assert.ok(ref, `attempt ${attempt.number} 应保存生成证据`)
    return JSON.parse(readEvidence(f.input.source.commonDir, ref.resultRef).toString()) as { status: string; candidate: { tree: string } | null; candidateValidated: boolean; reviewPassed: boolean; validationFindings: { code: string; message: string; severity: string }[] }
  }
  const failedGeneration = generationFor(attempts.find(attempt => attempt.number === 1)!)
  const anchorFindings = failedGeneration.validationFindings.filter(item => item.code === 'anchor-dead')
  assert.equal(anchorFindings.length, parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!.items.filter(item => item.kind === 'AC').length)
  assert.deepEqual(repairDiagnostics, anchorFindings.map(({ code, message }) => ({ code, message })), '修复输入逐字保留了实际V1诊断')

  const repairedGeneration = generationFor(attempts.find(attempt => attempt.number === 2)!)
  assert.equal(repairedGeneration.status, 'conflict', '仅由本夹具注入的后续review停止，证明候选已越过V1硬门禁')
  assert.equal(repairedGeneration.candidateValidated, true)
  assert.equal(repairedGeneration.validationFindings.some(item => item.code === 'anchor-dead' || item.severity === 'error'), false, '修复后不再存在阻断锚点或硬门禁错误')
  const entry = readTree(f.input.source.commonDir, repairedGeneration.candidate!.tree).find(item => item.path === targetPath)!
  const candidateSpec = readObject(f.input.source.commonDir, entry.oid).toString('utf8')
  assert.equal(candidateSpec, repairedSpec, '候选只能将错误source绑定替换为真实声明符号')

  const beforeContract = parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!
  const afterContract = parseContract({ nodeId: 'export-contract', path: targetPath, source: candidateSpec }).contract!
  assert.deepEqual(afterContract.items.map(item => item.id), beforeContract.items.map(item => item.id), '全部业务稳定ID保持')
  for (const prior of beforeContract.items) {
    const next = afterContract.items.find(item => item.id === prior.id)!
    assert.ok(sameContractBusinessMeaning(prior, next), prior.id)
    if (prior.kind === 'AC' && next.kind === 'AC') assert.equal(next.test, prior.test, `${prior.id} 的AC.test绑定保持`)
  }
  assert.ok(afterContract.items.filter(item => item.kind === 'AC').every(item => item.source.kind === 'code' && item.source.ref === `${sourcePath}#ExportService`))

  const acceptedFiles = new Map(frozenPrompt!.files)
  acceptedFiles.set(targetPath, initialSpec)
  const before = await readFrozenContracts(f.root, acceptedFiles)
  const repairedFiles = new Map(acceptedFiles).set(targetPath, candidateSpec)
  const after = await readFrozenContracts(f.root, repairedFiles)
  const policy = { newNodeRawSources: new Map<string, string>(), verifications: f.plan.verifications.map(item => item.definition) }
  assert.deepEqual(checkGenerationContractIntent(before, after, policy), [], '保护项门禁允许单独修正真实source绑定')
  assert.equal(after.findings.some(item => item.code === 'anchor-dead'), false, '修复后的真实声明锚点通过冻结源码解析')

  const bareSource = candidateSpec.replace(`| code:${sourcePath}#ExportService |`, `| code:${sourcePath} |`)
  assert.ok(parseContract({ nodeId: 'export-contract', path: targetPath, source: bareSource }).findings.some(item => item.code === 'invalid-source'), '裸code:path仍须由现有schema拒绝')
  const acceptedAcceptance = afterContract.items.find(item => item.kind === 'AC' && item.id === 'AC-EXPORT-07')!
  if (acceptedAcceptance.kind !== 'AC') assert.fail('预期AC-EXPORT-07仍是验收契约')
  const weakenedSpec = candidateSpec.replace(acceptedAcceptance.assertion, '有结果即可')
  assert.notEqual(weakenedSpec, candidateSpec, '夹具应实际触及一条保护断言')
  const weakened = await readFrozenContracts(f.root, new Map(repairedFiles).set(targetPath, weakenedSpec))
  assert.ok(checkGenerationContractIntent(before, weakened, policy).some(item => item.code === 'generation-protected-meaning-changed' && item.itemId === 'AC-EXPORT-07'), '保护AC断言变化仍由既有硬门禁拒绝')
})

test('P3首轮生成收到规范P1 implementation-review完整诊断而不改批准义务', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 })
  const finding = { code: 'implementation-review', kind: 'repair', affectedIds: ['RULE-EXPORT-05', 'AC-EXPORT-07'], message: '测试重复结果断言字段错误，业务契约完整', evidence: 'tests/export.test.mjs#AC-EXPORT-07 重复COMPLETE应仍first.csv，helper读错字段导致TypeError', decision: '只修测试helper和实现，保留全部已批准业务与验收义务' }
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_review') return { ...(output as object), verdict: 'repair', findings: [finding] }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } }
      assert.equal(frozen.repairContext.previousOutput, null, '尚无code输出不能虚造旧生成产物')
      const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), wrapper = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
      const approved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
      assert.equal(approved.structurePassed, true); assert.equal(approved.reviewPassed, true)
      const diagnostic = approved.deferredImplementationFindings.find(item => item.code === 'implementation-review')!
      assert.deepEqual(frozen.repairContext.diagnostics, [{ code: diagnostic.code, message: JSON.stringify(diagnostic) }], '仅规范implementation-review进入诊断，不灌入普通missing-test-*')
      assert.ok(diagnostic.message.includes(finding.evidence)); assert.ok(diagnostic.message.includes(finding.decision)); assert.deepEqual(diagnostic.relatedIds, finding.affectedIds)
      assert.deepEqual(frozen.elaboratedSpecs, approved.changes.map(change => ({ path: change.path, source: change.source })))
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#dispatch', evidence: '明确接缝在V3前停止', counterexample: '不能冒称运行通过', message: 'fixture stops before V3' }] }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) })); assert.equal(result.operation.callsUsed, 4)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1); assert.equal(result.receipt, undefined); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


for (const mode of ['live', 'restart', 'legacy', 'unreviewed'] as const) test(`P3合法增补链 ${mode} 冻结真实新增义务、旧marker和未审候选不升级`, async t => {
  const newIds = ['STEP-EXPORT-FAILURE', 'TR-EXPORT-RUNNING-EMPTY-FAIL', 'AC-EXPORT-EMPTY-FAIL', 'FLOW-EXPORT-FAILURE', 'STEP-EXPORT-FAILURE-CHECK'], testPath = 'generated-tests/empty-fail.test.mjs'
  const originalContract = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!, registration = originalContract.items.find(item => item.kind === 'VERIFY')!
  assert.equal(registration.kind, 'VERIFY')
  const environment = { version: 'trusted-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 180000 }, false, original, 'project', original, { readPaths: ['.spec', 'src', 'tests', 'generated-tests'], writePaths: ['.spec', 'src', 'generated-tests'], verifications: [{ definition: { id: registration.id, command: registration.command, cwd: registration.cwd, timeoutMs: registration.timeoutMs }, environment }, { definition: { id: 'VERIFY-EXPORT-02', command: ['node', '--test', testPath], cwd: '.', timeoutMs: 10000 }, environment }] })
  let activeStore = f.store, current = f.operation, approvedSource = '', approvedAttemptId = '', p1Calls = 0, firstSource = ''
  f.transform((output, request) => {
    const attempt = activeStore.readAttempt(activeStore.readOperation(current.id).currentAttemptId!)
    const retried = current.id !== f.operation.id
    if (request.purpose === 'elaboration_generate') {
      assert.equal(retried, false, 'retryOf不能重新细化已批准义务')
      p1Calls++
      if (attempt.number === 2) {
        const candidate = structuredClone(output) as GeneratedElaboration, node = candidate.changes[0]
        const flow = node.tables.FLOW.find(row => row.id === 'FLOW-EXPORT-01')!, dispatch = node.tables.STEP.find(row => row.id === 'STEP-EXPORT-03')!, transition = node.tables.TR.find(row => row.id === 'TR-EXPORT-RUNNING-FAIL')!, acceptance = node.tables.AC.find(row => row.id === 'AC-EXPORT-02')!
        flow.steps = [...flow.steps as string[], newIds[0]]; flow.terminal = [...flow.terminal as string[], 'STATE-EXPORT-FAILED']
        dispatch.next = [...dispatch.next as string[], newIds[0], newIds[1]]
        node.tables.TR.push({ ...transition, id: newIds[1], condition: '当前attempt且reason为空', to: 'STATE-EXPORT-RUNNING', disposition: 'reject', reason: 'invalid-reason', effects: '明确拒绝且保持RUNNING和旧反馈' })
        node.tables.STEP.push({ ...dispatch, id: newIds[0], action: '处理当前attempt失败回调，reason非空转FAILED，空reason明确拒绝', input: '当前attempt,reason', output: 'FAILED与原因或保持RUNNING', next: ['TR-EXPORT-RUNNING-FAIL', newIds[1]], 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL'] })
        node.tables.STEP.at(-1)!['depends-on'] = ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL', newIds[3]]
        node.tables.FLOW.push({ ...flow, id: newIds[3], actors: 'worker', entry: '运行中处理当前attempt失败回调', preconditions: '任务RUNNING，worker可信且attempt当前', steps: [newIds[4]], terminal: ['STATE-EXPORT-RUNNING', 'STATE-EXPORT-FAILED'], source: 'rule:RULE-EXPORT-05', 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05'] })
        node.tables.STEP.push({ ...node.tables.STEP.at(-1)!, id: newIds[4], flow: newIds[3], source: `derived:${newIds[3]}`, 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL'] })
        node.tables.VERIFY.push({ id: 'VERIFY-EXPORT-02', command: ['node', '--test', testPath], cwd: '.', 'timeout-ms': 10000 })
        node.tables.AC.push({ ...acceptance, id: newIds[2], covers: ['RULE-EXPORT-05', newIds[1]], action: '当前attempt提交空reason失败回调', assertion: '明确拒绝且保持RUNNING及旧反馈', test: `${testPath}#${newIds[2]}`, command: 'VERIFY-EXPORT-02', source: 'rule:RULE-EXPORT-05' })
        return candidate
      }
    }
    if (request.purpose === 'elaboration_review' && mode === 'unreviewed' && attempt.number === 2) throw Object.assign(new Error('fixture capacity failure leaves supplementation unreviewed'), { code: 'failed' })
    if (request.purpose === 'code_generate' && !retried && attempt.number === 1) firstSource = promptInput(request).elaboratedSpecs[0].source
    if (request.purpose === 'code_generate' && (attempt.number >= 2 || retried)) {
      const frozen = promptInput(request)
      const source = frozen.elaboratedSpecs.find(spec => spec.path === contractPath)!.source, contract = parseContract({ nodeId: 'export-contract', path: contractPath, source }).contract!
      if (mode === 'unreviewed') {
        for (const id of newIds) assert.equal(contract.items.some(item => item.id === id), false, '未审候选不能成为冻结义务')
        assert.equal(source, firstSource); return output
      }
      for (const id of newIds) assert.ok(contract.items.some(item => item.id === id), `第${attempt.number}attempt丢失已批准新增义务 ${id}`)
      assert.equal(parseParts(source)!.rawSource, parseParts(original)!.rawSource)
      for (const before of originalContract.items.filter(item => ['REQ', 'RULE', 'AC', 'VERIFY'].includes(item.kind))) assert.ok(sameContractBusinessMeaning(before, contract.items.find(item => item.id === before.id)!), before.id)
      const flow = contract.items.find(item => item.id === 'FLOW-EXPORT-01')!; assert.equal(flow.kind, 'FLOW'); assert.ok(flow.steps.includes(newIds[0]))
      const dispatch = contract.items.find(item => item.id === 'STEP-EXPORT-03')!; assert.equal(dispatch.kind, 'STEP'); assert.ok(dispatch.next.includes(newIds[1]))
      if (!retried && attempt.number === 2) { approvedSource = source; approvedAttemptId = attempt.id }
      else {
        assert.equal(source, approvedSource, '第三attempt必须保新增批准正文全文')
        const provenance = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration-provenance')
        const origin = JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()) as { fromAttemptId: string; fromOperationId: string }
        assert.equal(origin.fromAttemptId, approvedAttemptId); assert.equal(origin.fromOperationId, f.operation.id)
      }
      const value = output as { changes: { path: string; beforeDigest: null; beforeMode: null; mode: null; content: string }[] }
      value.changes.push({ path: testPath, beforeDigest: null, beforeMode: null, mode: null, content: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ExportService } from '../src/export.js';\ntest('${newIds[2]}',()=>{ const service=new ExportService(),job=service.submit('owner','key','active');service.dispatch(job.id,'START',{attempt:1});assert.throws(()=>service.dispatch(job.id,'FAIL',{attempt:1,reason:''}),/invalid-reason/);assert.equal(service.jobs.get(job.id).state,'RUNNING');assert.equal(service.jobs.get(job.id).reason,null); });\n` })
      return value
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: attempt.number === 3 || retried ? 'conflict' : 'repair', findings: [{ kind: attempt.number === 3 || retried ? 'conflict' : 'repair', affectedIds: ['RULE-EXPORT-05'], ruleLocation: attempt.number === 1 && !retried ? `contract-omission:${contractPath}#RULE-EXPORT-05` : 'RULE-EXPORT-05', codeLocation: attempt.number === 1 && !retried ? `${contractPath}#STEP-EXPORT-03` : `${testPath}#assertCall`, evidence: attempt.number === 1 && !retried ? '已批准主流程缺当前attempt空reason失败回调的具体拒绝出口，明确原意要求非空reason' : '普通测试helper错误，只修实现和断言，不改新增已批准义务', counterexample: 'START当前attempt→FAIL空reason必须明确拒绝且保RUNNING/反馈', message: attempt.number === 3 || retried ? 'fixture在V3前停止，不冒称交付' : '按既定原意修复具体缺陷' }] }
    return output
  })
  if (mode === 'legacy') {
    const record = activeStore.recordFailure.bind(activeStore)
    activeStore.recordFailure = (fence, issue) => {
      if (activeStore.readAttempt(fence.attemptId).number === 2 && issue.code === 'generation_failed') {
        const wrapper = activeStore.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'repair-input')
        const repair = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { refinement: { diagnostics: { message: string }[] } }
        repair.refinement.diagnostics = repair.refinement.diagnostics.map(item => { const finding = JSON.parse(item.message) as { ruleLocation: string }; finding.ruleLocation = finding.ruleLocation.replace('contract-omission:', 'contract:'); return { ...item, message: JSON.stringify(finding) } })
        const resultRef = writeEvidence(f.input.source.commonDir, repair)
        activeStore.checkpoint(fence, resultRef); activeStore.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
      }
      return record(fence, issue)
    }
  }
  if (mode === 'restart' || mode === 'unreviewed') {
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.number === 2 && attempt.failure)) throw new Error('fixture process boundary after durable second-attempt result')
      return claim(request)
    }
    const stopped = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(stopped.status, 'unsupported')
    assert.equal(stopped.failure?.code, 'coordinator_failed')
    assert.equal(stopped.failure?.message, 'fixture process boundary after durable second-attempt result')
    assert.equal(activeStore.listAttempts(f.operation.id).find(attempt => attempt.number === 2)?.failure?.code, mode === 'unreviewed' ? 'failed' : 'generation_failed')
    assert.equal(stopped.operation.callsUsed, mode === 'unreviewed' ? 6 : 8)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  const history = activeStore.listAttempts(f.operation.id).map(attempt => {
    const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())), p1Ref = wrappers.find(value => value.stage === 'elaboration')?.resultRef, generationRef = wrappers.find(value => value.stage === 'generation')?.resultRef
    const p1 = p1Ref ? JSON.parse(readEvidence(f.input.source.commonDir, p1Ref).toString()) as ElaborationResult : null, generation = generationRef ? JSON.parse(readEvidence(f.input.source.commonDir, generationRef).toString()) as { status: string; review: { verdict: string } | null } : null
    return { number: attempt.number, attemptId: attempt.id, failure: attempt.failure, p1Ref, p1StructurePassed: p1?.structurePassed, p1ReviewPassed: p1?.reviewPassed, p1Findings: p1?.rounds.flatMap(round => round.findings), p1NewIds: p1?.changes.flatMap(change => parseContract({ nodeId: change.nodeId, path: change.path, source: change.source }).contract?.items.filter(item => newIds.includes(item.id)).map(item => item.id) ?? []), generationStatus: generation?.status, generationVerdict: generation?.review?.verdict }
  })
  if (process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_DIR, `lineage-${process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_PHASE ?? 'run'}-${mode}.json`), JSON.stringify({ status: result.status, callsUsed: result.operation.callsUsed, newIds, history }, null, 2))
  if (mode === 'legacy') {
    assert.equal(result.failure?.code, 'SYNC_SCOPE_EVIDENCE_CONFLICT'); assert.deepEqual(history[2].p1NewIds, [], '旧协议marker不得将后来approved正文升级为新冻结义务'); assert.equal(p1Calls, 2); assert.equal(result.operation.callsUsed, 8)
  } else {
    assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, history }))
    assert.equal(p1Calls, 2); assert.equal(result.operation.callsUsed, mode === 'unreviewed' ? 8 : 10)
    if (mode !== 'unreviewed') assert.ok(approvedSource.includes(newIds[2]))
  }
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs); assert.equal(result.operation.input.id, f.input.id)
  assert.equal(result.receipt, undefined); assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  if (mode === 'live' || mode === 'restart') {
    activeStore.requestControl(f.operation.id, 'cancel')
    assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'cancelled')
    const next = activeStore.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: `lineage-retry-${mode}`, rootCauseId: `lineage-retry-${mode}`, origin: f.operation.origin, budget: f.operation.budget, managedRoot: f.managedRoot, retryOf: f.operation.id }))
    current = next; f.useOperation(next)
    const replay = await runSyncOperation(activeStore, next.id, f.options)
    assert.equal(replay.status, 'conflicted', JSON.stringify(replay.failure)); assert.equal(replay.operation.callsUsed, 2); assert.equal(p1Calls, 2)
    assert.deepEqual(replay.operation.input, f.operation.input); assert.deepEqual(replay.operation.budget, f.operation.budget); assert.equal(replay.operation.policyDigest, f.operation.policyDigest); assert.equal(replay.receipt, undefined)
    assert.equal(activeStore.listJournals(next.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  }
})


test('已解决诊断GAP经真实SQLite派发与Git receipt累计退役，重启后禁复用；模拟V3不冒实际Docker', { timeout: 240000 }, async t => {
  const gapId = 'GAP-EXPORT-RETRY-DIAGNOSTIC', flowId = 'FLOW-EXPORT-02', stepId = 'STEP-EXPORT-05'
  const flowRow = original.split('\n').find(line => line.startsWith(`| ${flowId} `))!, stepRow = original.split('\n').find(line => line.startsWith(`| ${stepId} `))!
  const gapSource = original.replace(flowRow, flowRow.replace(/ \|$/, `,${gapId} |`)).replace(stepRow, stepRow.replace(/ \|$/, `,${gapId} |`)) + `\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${gapId} | conflict | 重试权限实现与原政策分歧 | ${flowId},${stepId},AC-EXPORT-08 | 冻结重试实现缺所有者检查 | 恢复既定重试权限 | derived:RULE-EXPORT-06 | RULE-EXPORT-06 |\n`
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 12, maxRepairs: 0, timeoutMs: 240000 }, false, gapSource, 'project', original, {}, undefined, 'code'); await f.realTools()
  f.options.leaseMs = 120000
  let activeStore = f.store, activeOperation = f.operation, phase: 'conflict' | 'reject' | 'accept' | 'reuse' = 'conflict'
  let source = '', containerExists = false, containerState = 'created'
  const simulatedCommands: string[][] = []
  const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', truncated: false })
  f.options.verificationDriver = async argv => {
    simulatedCommands.push([...argv])
    if (argv[0] === 'version') return ok(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.4.3' }))
    if (argv[0] === 'image') return ok(JSON.stringify([{ Id: 'sha256:image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]))
    const resource = activeStore.listRecoverableResources().find(item => item.operation.id === activeOperation.id && item.resource.plan.kind === 'verification')!.resource
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint, config = checkpoint.config
    if (argv[1] === 'inspect') return containerExists ? ok(JSON.stringify([{ Id: 'a'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: config.policy.cwd === '.' ? '/candidate' : `/candidate/${config.policy.cwd}`, Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: config.policy.memoryBytes, MemorySwap: config.policy.memoryBytes, NanoCpus: config.policy.cpus * 1e9, PidsLimit: config.policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(config.policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: containerState, Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }])) : { ...ok(), exitCode: 1, stderr: 'Error: No such container' }
    if (argv[1] === 'create') { containerExists = true; containerState = 'created'; return ok('a'.repeat(64)) }
    if (argv[1] === 'start') { containerState = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'logs') return ok([...config.policy.expectedTestIds.map(id => JSON.stringify({ type: 'test:pass', data: { name: `${id} simulated`, nesting: 0 } })), JSON.stringify({ type: 'test:summary', data: { counts: { tests: config.policy.expectedTestIds.length }, success: true } })].join('\n'))
    if (argv[1] === 'rm') { containerExists = false; return ok('a'.repeat(64)) }
    assert.fail(`unexpected simulated verifier argv ${argv}`)
  }
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: object[]; facts: object[] }
      value.changes = [{ kind: phase === 'conflict' ? 'conflict' : 'allowed_change', paths: ['src/export.js'], affectedIds: ['RULE-EXPORT-06', stepId, 'AC-EXPORT-08'], ruleIds: ['RULE-EXPORT-06'], originalIntent: '重试仍限当前所有者', previousBehavior: '存在重试权限分歧诊断', sourceBehavior: '待修重试实现', deliveryBehavior: '保既定所有者政策', evidence: '冻结原finding与当前明确keep裁决仅恢复重试政策，旧诊断已解决', counterexample: '非所有者重试须拒绝' }]
      value.facts = source ? [{ source, text: '保持既定重试权限并结清对应诊断' }] : []; return value
    }
    if (request.purpose === 'elaboration_generate') { const result = rows(phase === 'conflict' || phase === 'reuse' ? gapSource : original); if (phase !== 'conflict' && phase !== 'reuse') result.changes[0].removeIds = [gapId]; return result }
    if (request.purpose === 'elaboration_review' && phase === 'reject') return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'diagnostic-not-resolved', kind: 'repair', message: '权限诊断尚未解决', affectedIds: [stepId], evidence: '完整候选仍有权限矛盾', decision: '保诊断并修实现' }] }
    return output
  })
  const partial = await runSyncOperation(activeStore, activeOperation.id, f.options)
  assert.ok(partial.receipt, JSON.stringify({ status: partial.status, failure: partial.failure, attempts: activeStore.listAttempts(activeOperation.id).map(attempt => attempt.failure) }))
  const baseline = activeStore.readBaseline(f.input.source)!
  assert.ok(readFileSync(join(baseline.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes(gapId))
  const firstAttempt = activeStore.readAttempt(partial.operation.currentAttemptId!), wrapper = firstAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const previous = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  for (const verdict of ['reject', 'accept'] as const) {
    phase = verdict
    const request = { requestId: 'resolved-gap-current-keep', operationId: f.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'keep_intent' as const } }
    source = `decision:${controlledDecisionIdentity(request)}`
    const requestBlob = prepareControlledDecision(f.input, request), plan = { ...f.plan, facts: [...f.plan.facts, { source, text: '保持既定重试权限并结清对应诊断' }] }
    activeOperation = activeStore.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: `gap-${verdict}`, rootCauseId: `gap-${verdict}`, ...(verdict === 'accept' ? { retryOf: activeOperation.id } : {}), origin: 'decision', previousBaselinePair: activeStore.readBaseline(f.input.source)!, budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob })); f.useOperation(activeOperation)
    const result = await runSyncOperation(activeStore, activeOperation.id, { ...f.options, plan, readCurrentPlan: () => plan })
    const attempt = activeStore.readAttempt(result.operation.currentAttemptId!), stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const elaboration = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'elaboration').resultRef).toString())
    if (verdict === 'reject') {
      assert.equal(result.receipt, undefined); assert.deepEqual(elaboration.retiredIds, []); assert.equal(activeStore.listJournals(activeOperation.id).length, 0); assert.ok(!(activeStore.readBaseline(f.input.source)!.retiredIds ?? []).includes(gapId)); continue
    }
    assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, findings: elaboration.rounds.map((round: { findings: unknown[] }) => round.findings), attempts: activeStore.listAttempts(activeOperation.id).map(attempt => attempt.failure) })); assert.ok(result.receipt)
    assert.ok(elaboration.retiredIds.includes(gapId)); assert.equal(attempt.verification!.passed, true)
    const verification = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString()); assert.ok(verification.retiredIds.includes(gapId))
    assert.ok(activeStore.listJournals(activeOperation.id)[0].receipt); assert.ok(activeStore.readBaseline(f.input.source)!.retiredIds!.includes(gapId))
    assert.equal(readFileSync(join(activeStore.readBaseline(f.input.source)!.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes(gapId), false)
  }
  assert.ok(simulatedCommands.some(argv => argv[1] === 'start')); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  f.closeForRestart(); const restartedProtocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => restartedProtocol.close())
  activeStore = new SyncStore(restartedProtocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  const settled = activeStore.readBaseline(f.input.source)!; assert.ok(settled.retiredIds!.includes(gapId))
  phase = 'reuse'; source = ''
  const nextInput = await captureInputSnapshot(f.root), reusePlan = { ...f.plan, facts: [...f.plan.facts, { source: 'code:src/export.js#ExportService', text: '新来源重新提出旧诊断' }] }
  activeOperation = activeStore.admitAndEnqueue(await prepareSyncAdmission(nextInput, reusePlan, { ingressKey: 'gap-reuse-after-restart', rootCauseId: 'gap-reuse-after-restart', origin: 'code', previousBaselinePair: settled, budget: f.operation.budget, managedRoot: f.managedRoot })); f.useOperation(activeOperation)
  const refused = await runSyncOperation(activeStore, activeOperation.id, { ...f.options, plan: reusePlan, readCurrentPlan: () => reusePlan })
  assert.equal(refused.receipt, undefined); assert.equal(activeStore.listJournals(activeOperation.id).length, 0)
  assert.ok(refused.operation.currentAttemptId, JSON.stringify({ refused, dispatch: activeStore.nextDispatch(f.input.source.repositoryId), attempts: activeStore.listAttempts(activeOperation.id) }))
  const lastAttempt = activeStore.readAttempt(refused.operation.currentAttemptId!), lastStages = lastAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const refusal = JSON.parse(readEvidence(f.input.source.commonDir, lastStages.find(value => value.stage === 'elaboration').resultRef).toString())
  assert.ok(refusal.rounds.flatMap((round: { findings: { code: string; itemId?: string }[] }) => round.findings).some((issue: { code: string; itemId?: string }) => issue.code === 'retired_id_reused' && issue.itemId === gapId))
  assert.ok(activeStore.readBaseline(f.input.source)!.retiredIds!.includes(gapId))
})


for (const scenario of ['failed', 'budget', 'unreviewed', 'no-conflict', 'active-p1'] as const) test(`已审conflict保独立裁决资格：P1 ${scenario} 不覆盖原分析与失败`, { timeout: 120000 }, async t => {
  const budget = { maxAttempts: scenario === 'failed' ? 2 : 1, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 }
  const f = await fixture(t, budget, false, original, 'project', original, {}, undefined, 'code')
  f.store.requestControl(f.operation.id, 'cancel'); f.store.discardDispatch(f.operation.id, f.operation.dispatchMessageId)
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['tests', 'package.json'], facts: f.plan.facts, verifications: f.plan.verifications, mandatoryTests: f.plan.mandatoryTests, budget } }))
  f.git('add', '.spec/spexcode.json'); f.git('commit', '--only', '-m', 'authorize application fixture policy', '.spec/spexcode.json')
  const protectedIndex = readFileSync(join(f.root, '.git/index'))
  let p1Calls = 0, announceP1!: () => void, resumeP1!: () => void
  const enteredP1 = new Promise<void>(resolve => { announceP1 = resolve }), finishP1 = new Promise<void>(resolve => { resumeP1 = resolve })
  f.transform(async (output, request) => {
    const current = f.store.listOperations(f.input.source.repositoryId).find(operation => operation.currentAttemptId && f.store.readAttempt(operation.currentAttemptId).dispatchPlans.some(dispatch => dispatch.key === request.requestKey))!
    f.useOperation(current)
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; affectedIds: string[]; ruleIds: string[] }[] }
      value.changes.forEach(change => { change.kind = scenario === 'no-conflict' ? 'refactor' : 'conflict'; change.affectedIds = ['RULE-EXPORT-01', 'AC-EXPORT-03']; change.ruleIds = ['RULE-EXPORT-01'] }); return value
    }
    if (request.purpose === 'code_behavior_review' && scenario === 'unreviewed') return { ...(output as object), checkedPaths: [] }
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (scenario === 'active-p1') { announceP1(); await finishP1 }
      if (scenario === 'failed' && p1Calls === 2) throw Object.assign(new Error('非法P1修复时执行环境不支持，保留原已审conflict'), { code: 'unsupported' })
      const candidate = rows(original); candidate.changes[0].tables.AC.push({ ...candidate.changes[0].tables.AC[0] }); return candidate
    }
    return output
  })
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const application = await SyncApplication.create(f.root, { protocol, runtimeDirectory: join(f.parent, 'application'), tools: f.options.tools, runner: f.options.runner })
  retainHistoricalFrozenWorkflow(application)
  await application.enable()
  const admitted = await application.submit({ nodeId: 'export-contract', requestId: `reviewed-conflict-${scenario}`, origin: 'code' })
  if (scenario === 'active-p1') {
    const progress = await Promise.race([
      enteredP1.then(() => ({ kind: 'entered-p1' as const })),
      application.wait(admitted.operation!.id).then(detail => ({ kind: 'settled' as const, detail })),
    ])
    if (progress.kind === 'settled') assert.fail(`P1进入前操作已结算: ${JSON.stringify({ phase: progress.detail.operation.phase, failure: progress.detail.attempt?.failure })}`)
    try {
      const active = await application.readOperation(admitted.operation!.id), context = active.decisionContext!
      assert.equal(active.decisionEligibility.eligible, false); assert.equal(active.operation.phase, 'elaborating'); assert.equal(active.operation.blockedReason, 'conflicted'); assert.equal(active.attempt!.status, 'running')
      await assert.rejects(application.decide({ requestId: 'active-p1-choice', operationId: active.operation.id, inputId: active.operation.input.id, analysisRef: context.analysisRef, findingIds: context.analysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' } }), /尚未结算|已结算/)
    } finally { resumeP1() }
  }
  const detail = await application.wait(admitted.operation!.id), operation = detail.operation, attempt = detail.attempt!
  assert.equal(detail.resources.length, 0, JSON.stringify(detail.resources)); assert.equal(detail.journals.length, 0)
  assert.equal(detail.executionAvailability.status, 'ready'); assert.ok(attempt.failure)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), protectedIndex); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(operation.budget, budget)
  if (scenario === 'unreviewed' || scenario === 'no-conflict') {
    assert.equal(operation.blockedReason, null); assert.equal(detail.decisionEligibility.eligible, false)
    if (scenario === 'unreviewed') assert.equal(detail.decisionContext, null)
    else assert.deepEqual(detail.decisionContext!.analysis.findings, [])
    return
  }
  assert.equal(detail.decisionEligibility.eligible, true)
  const context = detail.decisionContext!; assert.equal(context.analysis.reviewPassed, true); assert.ok(context.analysis.findings.some(finding => finding.kind === 'conflict'))
  assert.equal(operation.phase, scenario === 'failed' ? 'failed' : 'budget_exhausted')
  assert.equal(operation.blockedReason, 'conflicted', JSON.stringify({ phase: operation.phase, blockedReason: operation.blockedReason, failure: attempt.failure, reviewPassed: context.analysis.reviewPassed }))
  const failure = structuredClone(attempt.failure), callsUsed = operation.callsUsed, request = { requestId: `exact-choice-${scenario}`, operationId: operation.id, inputId: operation.input.id, analysisRef: context.analysisRef, findingIds: context.analysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' as const } }
  await assert.rejects(application.decide({ ...request, analysisRef: { sha256: contentHash('foreign-analysis') } }), /可信当前检查点/)
  await assert.rejects(application.decide({ ...request, findingIds: ['unselected-finding'] }), /分歧|finding/)
  await assert.rejects(application.decide({ ...request, inputId: contentHash('foreign-input') }), /原输入已变化/)
  const start = application.start.bind(application); application.start = () => undefined
  try {
    const decision = await application.decide(request)
    assert.notEqual(decision.operation.id, operation.id); assert.equal(decision.operation.origin, 'decision'); assert.equal(decision.operation.phase, 'queued')
    const immutable = JSON.parse(readEvidence(operation.input.source.commonDir, decision.operation.requestBlob!).toString())
    assert.equal(immutable.analysisRef.sha256, context.analysisRef.sha256); assert.deepEqual(immutable.findingIds, request.findingIds)
    assert.deepEqual(application.store.readAttempt(attempt.id).failure, failure); assert.equal(application.store.readOperation(operation.id).callsUsed, callsUsed)
    assert.equal(application.store.readOperation(operation.id).deadlineAtMs, operation.deadlineAtMs); assert.equal(application.store.listJournals(operation.id).length, 0)
  } finally { application.start = start }
})

test('v2 code→Spec协调器保留分区证据并跳过代码生成，最终候选独审仍走原预算身份', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 5, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js', 'tests/export.test.mjs', 'package.json'] } }, undefined, 'code')
  let candidateSeen = false
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate' || request.purpose === 'elaboration_review') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { implementationWritePaths: string[]; readonlyTestPaths: string[] }
      assert.deepEqual(frozen.implementationWritePaths, [])
      assert.ok(frozen.readonlyTestPaths.includes('tests/export.test.mjs'))
    }
    if (request.purpose === 'code_generate') assert.fail('代码提交不得调用可写代码生成器')
    if (request.purpose === 'code_review') {
      const frozen = promptInput(request)
      assert.equal(new Map(frozen.files).get('src/export.js'), f.bytes.toString())
      candidateSeen = true
      throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(candidateSeen, true, JSON.stringify(result.failure))
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_review'])
  assert.equal(result.operation.callsUsed, 5)
  const checkpoints = f.store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string }[]
  assert.ok(checkpoints.some(checkpoint => checkpoint.stage === 'partition-plan'))
  const partitionStage = f.store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'partition-plan')
  const partitionPlan = JSON.parse(readEvidence(f.input.source.commonDir, partitionStage.resultRef).toString()) as { expectedPaths: string[] }
  assert.ok(!partitionPlan.expectedPaths.includes('package.json') && !partitionPlan.expectedPaths.includes('tests/export.test.mjs'), '首次接入的未变上下文不是业务变更或发现writer')
  assert.ok(checkpoints.some(checkpoint => checkpoint.stage === 'candidate-partition-plan'))
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


for (const [native, retry] of [[false, "none"], [true, "none"], [true, "valid"], [true, "foreign"]] as const) test(`协调器真实只分析P0分区进入P1全局封口 native=${native} retry=${retry}`, async t => {
  const testPath = 'tests/independent-smoke.test.mjs'
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 120000 }, false, original, 'project', original,
    { version: 'sync-coordinator-v2', direction: 'code_to_spec', sourcePaths: ['src', testPath], commitTrigger: { before: null, paths: [] }, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, ...(native ? { agentWorkflow: 'native-worktree-v1' as const } : {}) }, undefined, 'code', native ? 'claude:default' : undefined, native,
    { [testPath]: 'import test from "node:test"\ntest("standalone smoke", () => {})\n' }, true)
  let active = f.operation, firstRun = retry !== 'none', acceptedKey: string | undefined
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; paths: string[]; affectedIds: string[]; ruleIds: string[] }[] }
      for (const change of value.changes.filter(change => change.paths.includes(testPath))) {
        change.kind = 'allowed_change'; change.affectedIds = []; change.ruleIds = []
      }
    }
    if (request.purpose === 'code_generate') assert.fail('只读来源不得调用代码生成')
    if (request.purpose === 'code_review') throw Object.assign(new Error('已达V1真实候选，夹具停止在独审请求'), { code: 'unsupported' })
    return output
  })
  if (native) {
    const runner = f.options.runner!
    f.options.runner = async request => {
      if (firstRun && request.purpose === 'elaboration_generate') throw Object.assign(new Error('原分区已独审，P1前停止'), { code: 'unsupported' })
      if (request.purpose === 'code_review') {
        f.calls.push(request)
        throw Object.assign(new Error('已达V1真实候选，夹具停止在独审请求'), { code: 'unsupported' })
      }
      const result = await runner(request.purpose.startsWith('code_behavior_') ? { ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) } : request)
      const path = /草稿文件=([^\s；]+)/.exec(request.prompt)?.[1], seed = request.worktree
      if (!path || !seed) return result
      if (request.purpose === 'elaboration_generate') assert.match(request.prompt, /仓库相对测试路径#稳定用例ID/)
      const workspace = join(f.parent, `mixed-p1-draft-${f.calls.length}`)
      f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(result.output))
      execFileSync('/usr/bin/git', ['-C', workspace, 'add', path], { stdio: 'pipe' })
      execFileSync('/usr/bin/git', ['-C', workspace, 'commit', '-m', 'normal mixed P1 proof draft'], { stdio: 'pipe' })
      const output = { summary: '已提交精确草稿' }
      return { ...result, output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
    }
  }
  if (native) {
    const checkpoint = f.store.checkpoint.bind(f.store), commonDir = f.input.source.commonDir
    f.store.checkpoint = (fence, ref) => {
      const wrapper = JSON.parse(readEvidence(commonDir, ref).toString())
      if (retry === 'foreign' && wrapper.stage === acceptedKey && wrapper.operationId === active.id) {
        const prior = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString())
        const resultRef = writeEvidence(commonDir, { ...prior, fromOperationId: active.id })
        const proof = writeEvidence(commonDir, { ...wrapper, resultRef })
        return checkpoint(fence, { ...proof, artifacts: syncCheckpointArtifacts(prior, resultRef) })
      }
      if (wrapper.stage !== 'generation' || f.store.readAttempt(fence.attemptId).number !== 1) return checkpoint(fence, ref)
      const generation = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString())
      assert.equal(generation.candidateValidated, true)
      const failedV1 = { ...generation, candidateValidated: false, validationFindings: [{ code: 'fixture-unverified-v1', severity: 'error', path: contractPath, message: '历史V1没有通过' }] }
      const resultRef = writeEvidence(commonDir, failedV1)
      const original = writeEvidence(commonDir, { ...wrapper, resultRef })
      return checkpoint(fence, { ...original, artifacts: syncCheckpointArtifacts(failedV1, resultRef) })
    }
  }
  let callsBeforeRetry = 0
  if (firstRun) {
    const initial = await runSyncOperation(f.store, active.id, f.options), old = initial.operation
    assert.equal(initial.failure?.message, '原分区已独审，P1前停止')
    const current = f.store.readAttempt(old.currentAttemptId!)
    const whole = readSyncCheckpoints(f.store, old, current).json.map(item => item.value as { partitionEvidence?: { partitionId: string; changedPaths: string[] }[] }).find(value => value.partitionEvidence?.some(member => member.changedPaths?.includes(testPath)))!
    acceptedKey = `partition:${whole.partitionEvidence!.find(member => member.changedPaths.includes(testPath))!.partitionId}:analysis:provenance`
    active = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: `mixed-p0-retry-${retry}`, rootCauseId: `mixed-p0-retry-${retry}`, retryOf: old.id, model: 'claude:default', origin: old.origin, budget: old.budget, managedRoot: f.managedRoot, baselineSelection: f.store.readBusinessBaselineSelection(old.id), executionScope: old.scope }))
    active = f.store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
    firstRun = false; callsBeforeRetry = f.calls.length
  }
  const outcome = await runSyncOperation(f.store, active.id, f.options)
  if (retry !== 'none') assert.ok(!f.calls.slice(callsBeforeRetry).some(request => request.purpose.startsWith('code_behavior_')))
  if (retry === 'foreign') {
    assert.match(outcome.failure?.message ?? '', /仅分析分区缺少原正式P0与独审派发证明/)
    assert.equal(f.calls.length, callsBeforeRetry, '来源错误必须在P1派发前拒绝')
    return
  }
  assert.equal(outcome.status, 'unsupported', JSON.stringify({ failure: outcome.failure, attempts: f.store.listAttempts(active.id).map(attempt => attempt.failure), calls: f.calls.map(request => request.purpose) }))
  assert.equal(outcome.failure?.message, '已达V1真实候选，夹具停止在独审请求')
  const [attempt] = f.store.listAttempts(active.id), commonDir = f.input.source.commonDir
  const read = readSyncCheckpoints(f.store, outcome.operation, attempt).json
  if (native) {
    assert.ok(outcome.operation.contractScopeExpansions?.some(expansion => expansion.previousBaselineSelectionDigest !== expansion.baselineSelectionDigest))
    assert.ok(read.some(({ value }) => (value as { candidateValidated?: boolean; validationFindings?: { code: string }[] })?.validationFindings?.some(finding => finding.code === 'fixture-unverified-v1')))
  }
  const resultWrapper = read.map(item => item.value as { stage?: string; resultRef: { sha256: string } }).find(value => value.stage === 'elaboration')!
  const analysisWrapper = read.map(item => item.value as { stage?: string; resultRef: { sha256: string } }).find(value => value.stage === 'analysis')!
  const result = JSON.parse(readEvidence(commonDir, resultWrapper.resultRef).toString()) as ElaborationResult
  const p0 = JSON.parse(readEvidence(commonDir, analysisWrapper.resultRef).toString()) as { partitionEvidence: { partitionId: string; changedPaths: string[]; analysisRef: { sha256: string } }[] }
  const member = p0.partitionEvidence.find(owner => owner.changedPaths.includes(testPath))!
  assert.deepEqual(member.changedPaths, [testPath])
  assert.equal(result.partitionSeal?.passed, true)
  assert.deepEqual(result.analysisOnlyPartitions, [{ partitionId: member.partitionId, analysisRef: member.analysisRef, wholeAnalysisRef: analysisWrapper.resultRef }])
  assert.equal(result.partitionEvidence?.length, 1)
  assert.ok(!f.calls.some(request => request.purpose.startsWith('elaboration_') && request.requestKey.includes(member.partitionId)))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)

  const count = f.calls.length
  f.store.requestControl(active.id, 'pause')
  f.store.requestControl(active.id, 'run')
  const resumed = await runSyncOperation(f.store, active.id, f.options)
  assert.equal(resumed.failure?.message, '已达V1真实候选，夹具停止在独审请求')
  assert.deepEqual(f.calls.slice(count).map(request => request.purpose), ['code_review'], '同operation恢复保留P0及实际P1，不重复派发')
  const resumedAttempt = f.store.listAttempts(active.id).at(-1)!
  const reread = readSyncCheckpoints(f.store, resumed.operation, resumedAttempt).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } })
  assert.deepEqual(reread.find(value => value.stage === 'elaboration')!.resultRef, resultWrapper.resultRef)
  assert.deepEqual(reread.find(value => value.stage === 'analysis')!.resultRef, analysisWrapper.resultRef)

  for (const forged of [
    { ...result, analysisOnlyPartitions: [{ ...result.analysisOnlyPartitions![0], analysisRef: analysisWrapper.resultRef }] },
    { ...result, analysisOnlyPartitions: [{ ...result.analysisOnlyPartitions![0], partitionId: result.partitionEvidence![0].partitionId }] },
    { ...result, inputDigest: 'f'.repeat(64) },
  ]) {
    const resultRef = writeEvidence(commonDir, forged), wrapper = writeEvidence(commonDir, { ...resultWrapper, resultRef })
    assert.throws(() => readSyncCheckpoints(f.store, outcome.operation, { ...attempt, checkpointRefs: [...attempt.checkpointRefs, { ...wrapper, artifacts: syncCheckpointArtifacts(forged, resultRef) }] }), { code: 'checkpoint_artifact_binding' })
  }
})

for (const mode of ['repair', 'drop-id', 'author-ac', 'new-parent-error', 'parent-missing-source', 'pause-empty', 'pause-selection', 'pause-candidate', 'pause-dispatch', 'later-approved', 'unchanged', 'missing-owner', 'local-ref', 'candidate', 'candidate-locals', 'round-review', 'composed', 'legacy-composed', 'input', 'policy', 'plan', 'readset', 'selection', 'unroutable'] as const) test(`全局seal拒绝已accept父REQ ${mode} 真实返修或typed停止，不零调用复播`, async t => {
  const parentPath = '.spec/project/spec.md'
  const parent = '---\ntitle: 导出共享接口\n---\n\n## raw source\n\n保留现有导出能力与模块分工，完成既有导出主流程。\n\n## expanded spec\n'
  const precise = ['later-approved', 'selection'].includes(mode)
  const source = precise ? original.replace('contract-schema: sync-v1\n', '').split('## expanded spec')[0] + '## expanded spec\n' : original
  const f = await fixture(t, { maxAttempts: 4, maxCalls: 32, maxRepairs: 3, timeoutMs: 120000 }, false, source, 'project', original,
    { version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project', targets: [{ nodeId: 'project', path: parentPath }, { nodeId: 'export-contract', path: contractPath }], sourcePaths: ['src/export.js'], ...(['later-approved', 'selection'].includes(mode) ? { executionScope: { paths: [parentPath, contractPath, 'src/export.js'], contractIds: [], flowIds: [] } } : {}), partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 } }, undefined, 'spec', undefined, ['later-approved', 'selection'].includes(mode), { [parentPath]: parent })
  const owners: { attempt: number; nodeId: string; purpose: string }[] = []
  let rejectedSource: { attempt: SyncAttempt; evidence: { ref: { sha256: string }; bytes: Buffer }[] } | undefined
  const recordFailure = f.store.recordFailure.bind(f.store)
  f.store.recordFailure = (fence, issue) => {
    if (f.store.readAttempt(fence.attemptId).number === 1 && !mode.startsWith('pause-') && !['repair', 'drop-id', 'author-ac', 'new-parent-error', 'parent-missing-source', 'later-approved', 'unchanged'].includes(mode)) {
      const wrappers = f.store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const wrapper = wrappers.find(stage => ['input', 'policy'].includes(mode) ? stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') : stage.stage === (mode === 'plan' ? 'partition-plan' : 'elaboration'))
      const result = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      if (mode === 'missing-owner') result.partitionEvidence.pop()
      if (mode === 'local-ref') result.partitionEvidence[0].resultRef = result.partitionEvidence[1].resultRef
      if (mode === 'candidate') result.candidateDigest = 'f'.repeat(64)
      if (mode === 'candidate-locals') {
        result.partitionSeal.changes[0].source += '\n不是原已审局部的正文\n'
        result.changes[0].source = result.partitionSeal.changes[0].source; result.changes[0].contentDigest = contentHash(result.changes[0].source)
        const seal = result.partitionSeal
        result.candidateDigest = seal.candidateDigest = contentHash(JSON.stringify({ inputDigest: seal.inputDigest, changes: seal.changes, applicability: seal.applicability, nodeChanges: seal.nodeChanges }))
      }
      if (mode === 'round-review') {
        const localWrapper = wrappers.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
        const local = JSON.parse(readEvidence(f.input.source.commonDir, localWrapper.resultRef).toString())
        local.rounds.at(-1).review.candidateDigest = 'f'.repeat(64)
        const localRef = writeEvidence(f.input.source.commonDir, local)
        result.partitionEvidence.find((owner: { resultRef: { sha256: string } }) => owner.resultRef.sha256 === localWrapper.resultRef.sha256).resultRef = localRef
        f.store.checkpoint(fence, localRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...localWrapper, resultRef: localRef }))
      }
      if (mode === 'plan') result.digest = 'another-plan'
      if (mode === 'unroutable') result.partitionSeal.findings.filter((finding: { severity: string }) => finding.severity === 'error').forEach((finding: { path: string }) => { finding.path = '.spec/foreign/spec.md' })
      if (mode === 'composed') wrapper.composedTree = 'f'.repeat(40)
      if (mode === 'legacy-composed') { delete wrapper.composedTree; delete wrapper.composedContentDigest }
      if (mode === 'input') wrapper.inputId = 'another-input'
      if (mode === 'policy') wrapper.policyDigest = 'another-policy'
      if (mode === 'readset') wrapper.readSetDigest = 'another-readset'
      if (mode === 'selection') delete wrapper.baselineSelectionRef
      const resultRef = writeEvidence(f.input.source.commonDir, result)
      f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
    }
    const result = recordFailure(fence, issue)
    if (['missing-owner', 'local-ref', 'round-review'].includes(mode)) {
      const attempt = f.store.readAttempt(fence.attemptId)
      rejectedSource = { attempt, evidence: attempt.checkpointRefs.flatMap(ref => [ref, ...ref.artifacts?.map(artifact => artifact.ref) ?? []]).map(ref => ({ ref, bytes: readEvidence(f.input.source.commonDir, ref) })) }
    }
    if (f.store.readAttempt(fence.attemptId).number !== 1 || !mode.startsWith('pause-')) return result
    f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
    const empty = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.store.readOperation(f.operation.id).scope, leaseMs: 30000 }).attempt
    f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
    assert.equal(f.store.readAttempt(empty.id).status, 'superseded')
    assert.equal(empty.composedInput, null); assert.equal(empty.candidate, null); assert.equal(empty.verification, null); assert.equal(empty.currentSession, null)
    assert.deepEqual(empty.checkpointRefs, []); assert.deepEqual(empty.dispatchPlans, [])
    if (mode !== 'pause-empty') {
      const listAttempts = f.store.listAttempts.bind(f.store)
      // 非空锚/冲突只模拟读取投影；不把历史证明写到空控制attempt。
      f.store.listAttempts = id => listAttempts(id).map(attempt => attempt.id !== empty.id ? attempt : { ...attempt, ...(mode === 'pause-selection' ? { baselineSelectionDigest: 'foreign-selection' } : mode === 'pause-candidate' ? { candidate: { sourceInputId: f.input.id } as NonNullable<typeof attempt.candidate> } : { dispatchPlans: f.store.readAttempt(fence.attemptId).dispatchPlans.slice(0, 1) }) })
    }
    return f.store.readOperation(f.operation.id)
  }
  f.transform((output, request) => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'code_behavior_analyze' && precise) return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: 'allowed_change', affectedIds: [], ruleIds: [] })) }
    if (request.purpose.startsWith('elaboration_')) {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string }[]; files: [string, string][]; readonlySpecRepair?: { kind: string; findings: { code: string; severity: string }[] } }
      const nodeId = frozen.targets[0].nodeId
      owners.push({ attempt: attempt.number, nodeId, purpose: request.purpose })
      if (attempt.number > 1) {
        assert.equal(Object.hasOwn(frozen, 'partitionSealFiles'), false, '完整程序校验文件不得成为模型输入或业务摘要')
        if (nodeId === 'project') assert.equal(new Map(frozen.files).has('src/export.js'), false, '父接口仍保原局部任务投影')
        assert.equal(frozen.readonlySpecRepair?.kind, attempt.number === 3 && mode === 'later-approved' ? 'candidate_review' : 'partition_seal')
        if (attempt.number === 2) assert.ok(frozen.readonlySpecRepair.findings.some(finding => finding.code === (mode === 'parent-missing-source' ? 'missing-source-file' : 'missing-requirement-flow')))
        assert.ok(frozen.readonlySpecRepair.findings.every(finding => finding.severity === 'error'))
      }
      if (request.purpose === 'elaboration_review') return output
      if (nodeId === 'project') {
        const parentRows: GeneratedElaboration = { version: 'elaboration-rows-v2', changes: [{ nodeId, path: parentPath, title: '导出共享接口', description: '', code: [], related: [], prose: '', removeIds: [], tables: { ...(Object.fromEntries<Record<string, ContractCell>[]>(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables), REQ: mode === 'drop-id' && attempt.number > 1 ? [] : [{ id: 'REQ-PARENT-SEAL', goal: '保留既有导出模块分工与主流程', source: 'user:raw', constraints: '不改变现有行为', success: '导出主流程完成', 'depends-on': [] }, ...(mode === 'new-parent-error' && attempt.number > 1 ? [{ id: 'REQ-PARENT-NEW', goal: '保留既有导出主流程', source: 'user:raw', constraints: '不改变现有行为', success: '导出主流程完成', 'depends-on': [] }] : [])] } }], applicability: rows(original).applicability.map(entry => ({ ...entry, affectedIds: ['REQ-PARENT-SEAL'] })) }
        if (mode === 'parent-missing-source') parentRows.changes[0].tables.RULE.push({ id: 'RULE-PARENT-SOURCE', scope: '导出主流程', constraint: '保持既有导出行为', basis: '冻结实现', authority: 'project', source: 'code:src/actually-absent.js#X', 'depends-on': ['REQ-PARENT-SEAL'] })
        return parentRows
      }
      const next = rows(original)
      next.changes[0].tables.AC.push({ ...next.changes[0].tables.AC[0], id: 'AC-EXPORT-SEAL', source: 'derived:REQ-PARENT-SEAL', covers: ['REQ-PARENT-SEAL'], 'depends-on': ['REQ-PARENT-SEAL'] })
      if (mode === 'parent-missing-source') next.changes[0].tables.AC.at(-1)!.covers = ['REQ-PARENT-SEAL', 'RULE-PARENT-SOURCE']
      if (attempt.number > 1 && mode !== 'unchanged' || mode === 'parent-missing-source') next.changes[0].tables.FLOW[0].req = [...next.changes[0].tables.FLOW[0].req as string[], 'REQ-PARENT-SEAL']
      if (attempt.number > 1 && mode === 'author-ac') next.changes[0].tables.AC[0].assertion = '弱化作者既有断言以迎合seal诊断'
      return next
    }
    if (request.purpose === 'code_generate' && mode !== 'later-approved') throw Object.assign(new Error('fixture在严格seal通过后停止，不运行真实构建或Docker'), { code: 'unsupported' })
    if (request.purpose === 'code_review' && mode === 'later-approved') {
      if (attempt.number === 2) return { ...(output as object), verdict: 'repair', findings: [{ kind: 'repair', ruleLocation: `contract:${parentPath}#REQ-PARENT-SEAL`, codeLocation: 'src/export.js#ExportService', affectedIds: ['REQ-PARENT-SEAL'], counterexample: '父接口说明仍需从原意核实，局部accept不是业务事实', evidence: '原始共享接口及当前冻结源码', message: '保留原始义务并重新核对接口表述' }] }
      throw Object.assign(new Error('fixture在新的只读owner返修及最终seal后停止，不运行Docker'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const attempts = f.store.listAttempts(f.operation.id)
  const firstStages = attempts[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  assert.ok(firstStages.some(stage => stage.stage === 'elaboration'), JSON.stringify(attempts.map(attempt => attempt.failure)))
  const firstAggregate = JSON.parse(readEvidence(f.input.source.commonDir, firstStages.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(attempts[0].failure?.code, 'partition_final_seal_failed', JSON.stringify(firstAggregate.rounds.flatMap(round => round.findings).filter(finding => finding.severity === 'error')))
  assert.equal(firstAggregate.reviewPassed, true)
  assert.equal(firstAggregate.partitionSeal?.passed, false)
  if (mode === 'parent-missing-source') {
    assert.equal(existsSync(join(f.root, 'src/actually-absent.js')), false)
    assert.deepEqual(firstAggregate.partitionSeal!.findings.filter(issue => issue.severity === 'error').map(({ code, nodeId, path, itemId }) => ({ code, nodeId, path, itemId })), [{ code: 'missing-source-file', nodeId: 'project', path: parentPath, itemId: 'RULE-PARENT-SOURCE' }], '原并集只保父自身来源错误，叶已承接全部父REQ/RULE完成性')
    assert.equal(attempts.length, 4)
    assert.deepEqual(owners.filter(owner => owner.attempt > 1), attempts.slice(1).map(attempt => ({ attempt: attempt.number, nodeId: 'project', purpose: 'elaboration_generate' })), '父自身代码来源未修，不得进入新父独审或转交只读后代')
    for (const attempt of attempts.slice(1)) {
      const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const rejected = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
      assert.equal(attempt.failure?.code, 'repair_budget_exhausted')
      assert.equal(rejected.partitionSeal, undefined)
      assert.equal(rejected.reviewPassed, false); assert.equal(rejected.rounds.at(-1)!.review, null)
      assert.ok(rejected.rounds.flatMap(round => round.findings).some(issue => issue.code === 'missing-source-file' && issue.nodeId === 'project' && issue.path === parentPath && issue.itemId === 'RULE-PARENT-SOURCE'))
    }
    assert.equal(f.store.readOperation(f.operation.id).callsUsed, 7)
    assert.deepEqual(f.store.readOperation(f.operation.id).budget, f.operation.budget)
    assert.ok(attempts.every(attempt => attempt.candidate === null && attempt.verification === null))
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
    return
  }
  if (mode === 'new-parent-error') {
    assert.equal(attempts.length, 4)
    for (const attempt of attempts.slice(1)) {
      const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const rejected = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
      assert.equal(attempt.failure?.code, 'repair_budget_exhausted')
      assert.equal(rejected.partitionSeal, undefined)
      assert.ok(rejected.rounds.flatMap(round => round.findings).some(issue => issue.code === 'missing-requirement-flow' && issue.itemId === 'REQ-PARENT-NEW'))
      assert.deepEqual(owners.filter(owner => owner.attempt === attempt.number), [{ attempt: attempt.number, nodeId: 'project', purpose: 'elaboration_generate' }], '新跨owner完成性错误仍须在父独审前阻断')
    }
    assert.equal(f.store.readOperation(f.operation.id).callsUsed, owners.length)
    assert.ok(attempts.every(attempt => attempt.candidate === null && attempt.verification === null))
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
    return
  }
  if (['missing-owner', 'local-ref', 'round-review'].includes(mode)) {
    assert.equal(result.status, 'unsupported')
    assert.equal(result.failure?.code, 'checkpoint_artifact_binding')
    assert.equal(result.failure?.kind, 'unsupported')
    assert.equal(result.failure?.message, '聚合rounds必须是原partitionEvidence局部结果的精确有序并集')
    assert.ok(rejectedSource)
    assert.deepEqual(attempts, [rejectedSource.attempt], 'claim前拒绝须保持旧已结算attempt，不创建或改签attempt')
    for (const { ref, bytes } of rejectedSource.evidence) assert.deepEqual(readEvidence(f.input.source.commonDir, ref), bytes)
    assert.equal(owners.some(owner => owner.attempt > 1), false)
    assert.equal(attempts[0].candidate, null); assert.equal(attempts[0].verification, null)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
    return
  }
  if (['drop-id', 'author-ac'].includes(mode)) {
    const stages = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const rejected = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
    assert.ok(rejected.rounds.flatMap(round => round.findings).some(finding => finding.code === (mode === 'drop-id' ? 'readonly_repair_id_removed' : 'acceptance_update_unauthorized')))
    assert.ok(attempts.every(attempt => attempt.verification === null && attempt.candidate === null))
    return
  }
  if (!['repair', 'pause-empty', 'later-approved', 'unchanged'].includes(mode)) {
    const code = ['plan', 'readset', 'selection'].includes(mode) || mode.startsWith('pause-') ? 'partition_final_seal_stalled' : ['input', 'policy'].includes(mode) ? 'stage_binding' : mode === 'unroutable' ? 'partition_final_seal_unroutable' : 'partition_final_seal_binding'
    assert.equal(attempts.at(-1)!.failure?.code, code)
    assert.equal(attempts.at(-1)!.failure?.kind, 'unsupported')
    assert.equal(owners.some(owner => owner.attempt > 1), false, '错误来源不能进入新的owner诊断')
    assert.equal(attempts.length, mode.startsWith('pause-') ? 3 : 2)
    return
  }
  const retryNumber = mode === 'pause-empty' ? 3 : 2
  assert.ok(owners.some(owner => owner.attempt === retryNumber && owner.nodeId === 'export-contract' && owner.purpose === 'elaboration_generate'), JSON.stringify({ message: '全局拒绝必须触发新的真实owner runner请求', owners, failures: attempts.map(attempt => attempt.failure) }))
  assert.ok(owners.some(owner => owner.attempt === retryNumber && owner.nodeId === 'project' && owner.purpose === 'elaboration_review'))
  if (mode === 'unchanged') {
    assert.equal(attempts.length, 4)
    assert.deepEqual(attempts.map(attempt => attempt.dispatchPlans.filter(dispatch => dispatch.purpose.startsWith('elaboration_')).length), [4, 3, 1, 1])
    assert.equal(f.store.readOperation(f.operation.id).callsUsed, 9)
    assert.deepEqual(f.store.readOperation(f.operation.id).budget, f.operation.budget)
    const parentKey = firstStages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && (JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult).phase === 'interface_seed').stage
    const leafKey = firstStages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && (JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult).changes.some(change => change.nodeId === 'export-contract')).stage
    const repairedParentStages = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const parentRef = repairedParentStages.find(stage => stage.stage === parentKey).resultRef
    const parent = JSON.parse(readEvidence(f.input.source.commonDir, parentRef).toString()) as ElaborationResult
    assert.equal(parent.phase, 'interface_seed'); assert.equal(parent.structurePassed, true); assert.equal(parent.reviewPassed, true)
    assert.equal(parent.rounds.at(-1)!.review?.verdict, 'accept')
    for (const attempt of attempts.slice(1)) {
      const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const rejected = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
      const leaf = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(stage => stage.stage === leafKey).resultRef).toString()) as ElaborationResult
      assert.equal(attempt.failure?.code, 'repair_budget_exhausted')
      assert.equal(rejected.structurePassed, false)
      assert.equal(rejected.partitionSeal?.passed, false, '叶未消原错误仍须由strict全图seal明确拒绝')
      assert.ok(rejected.partitionSeal!.findings.some(issue => issue.code === 'missing-requirement-flow' && issue.itemId === 'REQ-PARENT-SEAL'))
      assert.equal(rejected.reviewPassed, false); assert.equal(leaf.reviewPassed, false); assert.equal(leaf.rounds.at(-1)!.review, null)
      assert.ok(leaf.rounds.flatMap(round => round.findings).some(issue => issue.code === 'missing-requirement-flow' && issue.itemId === 'REQ-PARENT-SEAL'))
      assert.deepEqual(owners.filter(owner => owner.attempt === attempt.number && owner.nodeId === 'export-contract'), [{ attempt: attempt.number, nodeId: 'export-contract', purpose: 'elaboration_generate' }], '真实叶返修必须派发，但原assigned错误未消前不得独审')
      if (attempt.number > 2) {
        assert.equal(wrappers.find(stage => stage.stage === parentKey).resultRef.sha256, parentRef.sha256)
        const provenance = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(stage => stage.stage === `${parentKey}:provenance`).resultRef).toString())
        assert.equal(provenance.fromAttemptId, attempts[1].id); assert.equal(provenance.resultRef.sha256, parentRef.sha256)
      }
    }
    assert.ok(attempts.every(attempt => attempt.candidate === null && attempt.verification === null))
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
    return
  }
  const stages = attempts[retryNumber - 1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const aggregate = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(aggregate.partitionSeal?.passed, true)
  assert.equal(aggregate.structurePassed, true)
  assert.equal(aggregate.reviewPassed, true)
  assert.equal(parseParts(aggregate.changes.find(change => change.path === parentPath)!.source)!.rawSource, parseParts(parent)!.rawSource)
  assert.equal(attempts.length, ['later-approved', 'pause-empty'].includes(mode) ? 3 : 2)
  if (mode === 'pause-empty') {
    assert.equal(attempts[1].failure, null); assert.equal(attempts[1].composedInput, null)
    assert.deepEqual(attempts[1].checkpointRefs, []); assert.deepEqual(attempts[1].dispatchPlans, [])
  }
  if (mode === 'later-approved') {
    assert.ok(owners.some(owner => owner.attempt === 3 && owner.nodeId === 'project'), JSON.stringify({ owners, failures: attempts.map(attempt => attempt.failure) }))
    assert.ok(owners.filter(owner => owner.attempt === 3).every(owner => owner.nodeId === 'project'), '新的全局已通过结果必须阻断早期seal反馈，无关叶沿最新accept承接')
  }
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), readFileSync(new URL('tests/export.test.mjs', fixturePath)))
})

for (const body of ['syntax', 'schema', 'stage-shape'] as const) for (const layout of (['atomic', 'legacy', 'cancelled', 'nested', 'generic-failed', 'generic-native-json', 'bad-record', 'unknown-json', 'false-role', 'review-rejected', 'aggregate', 'aggregate-early', 'aggregate-nested', 'aggregate-ref', 'aggregate-round', 'aggregate-input', 'aggregate-duplicate', 'aggregate-drop'] as const).filter(layout => !(['review-rejected', 'generic-native-json'].includes(layout) || layout.startsWith('aggregate')) || body === 'schema')) test(`raw final checkpoint preserves formal analysis/detail reads: ${body}/${layout}`, async t => {
  const aggregate = layout.startsWith('aggregate'), parentPath = '.spec/project/spec.md', backupPath = '.spec/project/backup/backup-contract/spec.md'
  const parent = '---\ntitle: 导出共享接口\n---\n\n## raw source\n\n保留现有导出能力与模块分工，完成既有导出主流程。\n\n## expanded spec\n'
  const f = await fixture(t, { maxAttempts: 1, maxCalls: aggregate ? 12 : 4, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, aggregate ? { version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project', targets: [{ nodeId: 'project', path: parentPath }, { nodeId: 'export-contract', path: contractPath }, { nodeId: 'backup-contract', path: backupPath }], sourcePaths: ['src/export.js', 'src/backup.js'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 } } : {}, undefined, 'spec', undefined, false, aggregate ? { [parentPath]: parent, [backupPath]: original.replaceAll('EXPORT', 'BACKUP').replaceAll('export-contract', 'backup-contract').replaceAll('export.js', 'backup.js').replaceAll('export.test.mjs', 'backup.test.mjs'), 'src/backup.js': 'export const backup = true\n', 'tests/backup.test.mjs': 'export const fixture = true\n' } : {})
  const records = new Map<string, NativeRunRecord>(), stop = new Error('fixture stops after durable failed P1 stage')
  const failedFinals: { ref: { sha256: string }; text: string }[] = []
  let raw = '', rawRef: { sha256: string } | undefined
  const persistRecord = (record: NativeRunRecord): void => writeRecord({ governed: false, worktreePath: f.root, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'codex', runtimeStartToken: null, stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null, ...record })
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    if (['legacy', 'cancelled'].includes(layout)) {
      for (const artifact of ref.artifacts ?? []) checkpoint(fence, artifact.ref)
      return checkpoint(fence, { sha256: ref.sha256 })
    }
    const result = checkpoint(fence, ref)
    assert.doesNotThrow(() => readCurrentSyncAnalysis(f.store, f.store.readOperation(f.operation.id)), 'every atomic checkpoint publication must already be formally readable')
    for (const artifact of ref.artifacts ?? []) assert.ok(f.store.pinnedBlobRefs().some(pin => pin.sha256 === artifact.ref.sha256), 'wrapper transaction retains every JSON/raw CAS pin')
    return result
  }
  f.options.runner = async request => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    const runner = createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null,
      cancel: async () => { throw new Error('fixture never controls a real process') },
      run: async actual => {
        const execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key)
        const nodeId = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]).targets[0].nodeId
        if (layout === 'review-rejected' && request.purpose === 'elaboration_generate' || aggregate && layout !== 'aggregate-early' && nodeId === 'project') {
          const generated = { version: 'elaboration-rows-v2', changes: [{ nodeId, path: parentPath, title: '导出共享接口', description: '', code: [], related: [], prose: '', removeIds: [], tables: { ...Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])), REQ: [{ id: 'REQ-PARENT-RAW', goal: '保留既有导出模块分工与主流程', source: 'user:raw', constraints: '不改变现有行为', success: '导出主流程完成', 'depends-on': [] }] } }], applicability: rows(original).applicability.map(entry => ({ ...entry, affectedIds: ['REQ-PARENT-RAW'] })) }
          const output = request.purpose === 'elaboration_review' ? { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] } : adaptElaborationNativeOutput(request, aggregate ? generated : rows(original)), identity = { threadId: `thread-${sessionId}`, turnId: 'generated-turn' }, result = { sessionId, ...identity, output, resultDigest: contentHash(JSON.stringify(output)) }
          records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt: actual.prompt, parent: null, launcher: null, ...(actual.base?.trim() ? { base: actual.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output, resultDigest: result.resultDigest } })
          persistRecord(records.get(sessionId)!)
          return result
        }
        raw = body === 'syntax' || aggregate && nodeId === 'export-contract' ? '{"changes":[}' : body === 'schema' ? '{"changes":"not-an-array"}' : JSON.stringify({ version: 'sync-stage-v1', operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, policyDigest: operation.policyDigest, stage: 'analysis', resultRef: { sha256: 'f'.repeat(64) } })
        rawRef = { sha256: contentHash(raw) }
        failedFinals.push({ ref: rawRef, text: raw })
        const identity = { threadId: `thread-${sessionId}`, turnId: 'failed-turn' }, rejectedOutput = rejectedFinalOutput(raw, actual.prompt, execution, identity, layout === 'generic-native-json' ? 'native_json' : 'text')
        const code = ['generic-failed', 'generic-native-json'].includes(layout) ? 'failed' : 'structured_output_format_invalid'
        records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt: actual.prompt, parent: null, launcher: null, ...(actual.base?.trim() ? { base: actual.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'failed', error: 'exact rejected final', ...(code === 'failed' ? {} : { errorCode: code }), rejectedOutput } })
        persistRecord(records.get(sessionId)!)
        throw new StructuredSessionError(code, 'exact rejected final', { sessionId, ...identity, rejectedOutput })
      },
    } })
    return runner(request)
  }
  f.store.recordFailure = () => { throw stop }
  await assert.rejects(runSyncOperation(f.store, f.operation.id, f.options), error => error === stop)
  const operation = f.store.readOperation(f.operation.id)
  const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, f.store.readAttempt(operation.currentAttemptId!).checkpointRefs.at(-1)!).toString())
  const saved = [JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())]
  assert.ok(Array.isArray(saved[0].rounds), JSON.stringify({ stage: wrapper.stage, result: saved[0] }))
  assert.ok(saved.some(value => value.rounds.some((round: { rejectedOutput?: unknown }) => round.rejectedOutput)), JSON.stringify(saved.map(value => value.failure)))
  if (layout === 'review-rejected') { const round = saved[0].rounds.at(-1); assert.ok(round.output && round.candidate && round.candidateDigest); assert.equal(round.reviewOutput, null); assert.equal(round.review, null); assert.equal(saved[0].reviewPassed, false) }
  assert(rawRef); assert.equal(readEvidence(f.input.source.commonDir, rawRef).toString(), raw)
  assert.ok([rawRef, wrapper.resultRef].every(ref => f.store.pinnedBlobRefs().some(pin => pin.sha256 === ref.sha256)), 'independently known raw and original result refs remain pinned, even when raw is not flat')
  const attempt = f.store.readAttempt(operation.currentAttemptId!), fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
  if (aggregate) {
    assert.equal(saved[0].phase, layout === 'aggregate-early' ? undefined : 'partitioned_final'); assert.equal(saved[0].partitionEvidence.length, layout === 'aggregate-early' ? 1 : 3)
    assert.equal(saved[0].rounds.filter((round: { review?: { verdict: string } }) => round.review?.verdict === 'accept').length, layout === 'aggregate-early' ? 0 : 1)
    assert.equal(saved[0].rounds.filter((round: { rejectedOutput?: unknown }) => round.rejectedOutput).length, layout === 'aggregate-early' ? 1 : 2)
    if (layout === 'aggregate-nested') {
      const value = { refinement: { prior: saved[0] } }, resultRef = writeEvidence(f.input.source.commonDir, value)
      checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, stage: 'repair-input', resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
    } else if (!['aggregate', 'aggregate-early'].includes(layout)) {
      const value = structuredClone(saved[0])
      if (layout === 'aggregate-ref') value.partitionEvidence[0].resultRef = value.partitionEvidence[1].resultRef
      if (layout === 'aggregate-round') value.rounds.reverse()
      if (layout === 'aggregate-input') value.inputDigest = 'f'.repeat(64)
      if (layout === 'aggregate-duplicate') value.partitionEvidence.push(value.partitionEvidence[0])
      if (layout === 'aggregate-drop') value.rounds.shift()
      const resultRef = writeEvidence(f.input.source.commonDir, value)
      checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
      assert.throws(() => readCurrentSyncAnalysis(f.store, operation), { code: 'checkpoint_artifact_binding' })
      return
    }
  }
  if (layout === 'cancelled') {
    const record = [...records.values()][0], resource = f.store.findResource(attempt.id, attempt.dispatchPlans[0].key)!
    record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', error: 'structured execution cancelled; native stopped', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } }; persistRecord(record)
    let current = resource
    for (const phase of ['terminal', 'removed'] as const) {
      const prior = JSON.parse(readEvidence(f.input.source.commonDir, current.checkpointRef).toString())
      const next = { ...prior, phase, nativeState: 'cancelled', status: 'cancelled', stop: { sessionId: record.session, state: 'cancelled', threadId: record.structuredExecution.threadId, turnId: record.structuredExecution.turnId, nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } }
      current = f.store.recordResourceCheckpoint(resource.id, { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: null, phase, expectedCheckpointRef: current.checkpointRef, checkpointRef: writeEvidence(f.input.source.commonDir, next) })
    }
  }
  if (layout === 'nested') {
    const original = saved[0], round = original.rounds.at(-1), value = { refinement: { prior: { ...original, status: 'complete', failure: null, rounds: [], repairDiagnostics: { requestKey: round.rejectedOutput.ownerRequestKey, inputDigest: original.inputDigest, resultRef: wrapper.resultRef, failure: original.failure, round } } } }
    const resultRef = writeEvidence(f.input.source.commonDir, value)
    checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, stage: 'repair-input', resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
  }
  if (layout === 'bad-record') {
    assert.doesNotThrow(() => readCurrentSyncAnalysis(f.store, operation), '同一store先完整认证并命中纯JSON缓存')
    const record = [...records.values()][0], execution = structuredClone(record.structuredExecution!), resource = f.store.findResource(attempt.id, attempt.dispatchPlans[0].key)!
    record.structuredExecution = { ...execution, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: false, acknowledged: false, nativeStatus: 'stopped' } }; persistRecord(record)
    assert.throws(() => readCurrentSyncAnalysis(f.store, operation), { code: 'checkpoint_artifact_binding' }, '缓存不能沿用已失效的canonical Native停止证明')
    record.structuredExecution = execution; persistRecord(record)
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET record_json=? WHERE id=?', JSON.stringify({ ...resource, checkpoints: [] }), resource.id))
    assert.throws(() => readCurrentSyncAnalysis(f.store, operation), { code: 'checkpoint_artifact_binding' }, '缓存不能补签当前resource缺失的原failed观察')
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET record_json=? WHERE id=?', JSON.stringify(resource), resource.id))
    assert.doesNotThrow(() => readCurrentSyncAnalysis(f.store, operation), '恢复精确原record/resource后仍沿原refs重新认证')
    record.structuredExecution!.rejectedOutput = { ...record.structuredExecution!.rejectedOutput!, sha256: 'e'.repeat(64) }; persistRecord(record)
  }
  if (['unknown-json', 'false-role'].includes(layout)) {
    const unknown = { sha256: putBlob(Buffer.from('{"version":"sync-stage-v1","stage":'), join(f.input.source.commonDir, 'spexcode/evidence')) }
    checkpoint(fence, layout === 'unknown-json' ? unknown : { ...writeEvidence(f.input.source.commonDir, { diagnostic: 'role alone grants no permission' }), artifacts: [{ kind: 'untrusted_final', ref: unknown }] })
  }
  if (['bad-record', 'unknown-json', 'false-role'].includes(layout)) {
    assert.throws(() => readCurrentSyncAnalysis(f.store, operation), layout === 'unknown-json' ? SyntaxError : { code: 'checkpoint_artifact_binding' })
    assert.throws(() => readSyncCheckpointStageIndex(f.store, operation, f.store.readAttempt(attempt.id)), layout === 'unknown-json' ? SyntaxError : { code: 'checkpoint_artifact_binding' })
    return
  }
  const beforeRefs = f.store.readAttempt(attempt.id).checkpointRefs
  assert.doesNotThrow(() => readCurrentSyncAnalysis(f.store, operation), 'typed rejected raw must never be parsed or trusted as a stage')
  const stageIndex = readSyncCheckpointStageIndex(f.store, operation, f.store.readAttempt(attempt.id))
  assert.ok(stageIndex.raw.has(rawRef!.sha256)); assert.ok(stageIndex.json.every(entry => entry.ref.sha256 !== rawRef!.sha256), '紧凑历史视图也排除伪stage拒稿')
  const app = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.parent, 'read-application') })
  const detail = await app.readOperation(operation.id)
  assert.equal(detail.decisionContext, null)
  const evidence = await app.readEvidence(operation.id, rawRef) as { kind: string; text: string; sha256: string }
  assert.equal(evidence.kind, 'untrusted_final'); assert.equal(evidence.text, raw); assert.equal(evidence.sha256, rawRef.sha256)
  for (const failure of failedFinals) { const value = await app.readEvidence(operation.id, failure.ref) as { kind: string; text: string }; assert.equal(value.kind, 'untrusted_final'); assert.equal(value.text, failure.text) }
  assert.deepEqual(await app.readEvidence(operation.id, wrapper.resultRef), saved[0])
  await assert.rejects(app.readEvidence(operation.id, { sha256: 'f'.repeat(64) }), { code: 'sync_evidence_unrelated' })
  assert.deepEqual(f.store.readAttempt(attempt.id).checkpointRefs, beforeRefs, 'formal reads never rewrite legacy pins or backfill roles')
  assert.equal(operation.callsUsed, aggregate ? layout === 'aggregate-early' ? 1 : 4 : layout === 'review-rejected' ? 2 : 1)
  assert.equal(beforeRefs.some(ref => ref.sha256 === rawRef!.sha256), ['legacy', 'cancelled'].includes(layout), 'new raw is only pinned through its typed wrapper')
})

for (const target of ['code_behavior_analyze', 'elaboration_generate'] as const) for (const mode of ['settled', 'paused', 'expired', 'wrong-proof'] as const) test(`settled RPC failure at ${target} advances only a fresh request in the same operation: ${mode}`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 12, maxRepairs: 2, timeoutMs: 30000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, target === 'code_behavior_analyze' ? 'code' : 'spec', 'zcode:bigmodel-api/GLM-5.3-Flash')
  const originalRunner = f.options.runner!, records = new Map<string, NativeRunRecord>()
  let advanced = false, firstCalls = 0
  const checkpoint = f.store.recordResourceCheckpoint.bind(f.store)
  f.store.recordResourceCheckpoint = (id, update) => {
    const saved = JSON.parse(readEvidence(f.input.source.commonDir, update.checkpointRef).toString()) as NativeRunCheckpoint
    if (mode === 'wrong-proof' && update.phase === 'removed' && saved.failure?.code === 'native_rpc_timeout') { saved.stop!.sessionId = 'another-native-owner'; return checkpoint(id, { ...update, checkpointRef: writeEvidence(f.input.source.commonDir, saved) }) }
    return checkpoint(id, update)
  }
  f.options.runner = async request => {
    if (request.purpose !== target) return originalRunner(request)
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    if (attempt.number > 1) { advanced = true; throw new StructuredSessionError('unsupported', 'fixture stops after the same operation makes a fresh request') }
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null,
      cancel: async id => { const state = records.get(id)!.structuredExecution!; return { sessionId: id, state: state.state!, nativeStopped: state.cancellation!.nativeStopped, acknowledged: false, nativeStatus: 'stopped' } },
      run: async actual => {
        firstCalls++
        const execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key)
        const prompt = actual.worktree ? (await import('../native-worktree-runtime.js')).nativeWorktreePrompt(actual.prompt, actual.worktree) : actual.prompt
        const message = 'ZCode native RPC timeout (session/create)'
        records.set(sessionId, { session: sessionId, status: 'error', harnessSessionId: null, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, ...(actual.base?.trim() ? { base: actual.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, state: 'failed', errorCode: 'native_rpc_timeout', error: message, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } } })
        if (mode === 'paused') f.store.requestControl(operation.id, 'pause')
        if (mode === 'expired') { f.store.renewLease(fence, 1); await new Promise(resolve => setTimeout(resolve, 5)) }
        throw new StructuredSessionError('native_rpc_timeout', message, { sessionId })
      },
    } })(request)
  }
  await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(advanced, mode === 'settled', 'only a current run fence with exact stopped transport proof may enter the existing repair loop')
  assert.equal(firstCalls, 1)
  const attempts = f.store.listAttempts(f.operation.id)
  assert.equal(attempts.length, mode === 'settled' ? 2 : 1)
  if (mode === 'settled') { assert.equal(attempts[0].failure?.code, 'native_rpc_timeout'); assert.equal(attempts[0].failure?.kind, 'repairable') }
  assert.equal(f.store.listRecoverableResources().length, 0)
  assert.equal(f.store.readOperation(f.operation.id).id, f.operation.id)
  assert.equal(f.calls.some(call => call.purpose === 'code_generate'), false)
})

for (const mode of ['whole', 'partition', 'format', 'format-twice', 'format-formal-retry', 'format-wrong-packet', 'format-wrong-candidate', 'legacy-review', 'v3-review', 'paused', 'paused-review', 'newer-generation', 'wrong-stop', 'wrong-candidate', 'wrong-task'] as const) test(`P1已结算${mode.startsWith('format') ? '格式失败独审' : 'session/events独审超时'}只重审同一Git候选 ${mode}`, async t => {
  const formatFailure = mode.startsWith('format')
  const formatTwice = mode === 'format-twice'
  const wrongPacket = mode === 'format-wrong-packet'
  const wrongCandidate = mode === 'wrong-candidate' || mode === 'format-wrong-candidate'
  const failureCode = formatFailure ? 'structured_output_format_invalid' : 'native_rpc_timeout'
  const formalRetry = mode === 'format-formal-retry', codeToSpec = formatTwice || formalRetry
  const partitioned = mode === 'partition' || codeToSpec
  const plan = partitioned ? { version: 'sync-coordinator-v2' as const, direction: codeToSpec ? 'code_to_spec' as const : 'spec_to_code' as const, sourcePaths: ['src/export.js'], ...(codeToSpec ? { writePaths: ['.spec'], commitTrigger: { before: null, paths: ['src/export.js'] } } : {}), partitionPolicy: { version: 'sync-partition-policy-v1' as const, maxReadBytes: 524288, maxParallel: 1 } } : {}
  const f = await fixture(t, { maxAttempts: ['newer-generation', 'paused-review', 'wrong-task', 'format-twice', 'format-wrong-packet'].includes(mode) ? 3 : 2, maxCalls: 30, maxRepairs: ['wrong-task', 'format-twice', 'format-wrong-packet'].includes(mode) ? 2 : 1, timeoutMs: 120_000 }, false, original, 'project', original, { ...plan, agentWorkflow: 'native-worktree-v1', ...(formalRetry ? { executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } } : {}) }, undefined, codeToSpec ? 'code' : 'spec', 'zcode:default', partitioned)
  const calls: ElaborationSessionRequest[] = []
  if (mode === 'paused' || mode === 'newer-generation') {
    const recordFailure = f.store.recordFailure.bind(f.store)
    f.store.recordFailure = (fence, issue) => {
      if (issue.code === 'native_rpc_timeout' && mode === 'paused') f.store.requestControl(f.operation.id, 'pause')
      const result = recordFailure(fence, issue)
      if (issue.code === 'native_rpc_timeout' && mode === 'newer-generation') f.store.requestControl(f.operation.id, 'pause')
      return result
    }
  }
  if (mode === 'paused-review') {
    const checkpoint = f.store.checkpoint.bind(f.store)
    f.store.checkpoint = (fence, ref) => {
      const result = checkpoint(fence, ref), commonDir = f.input.source.commonDir
      const wrapper = JSON.parse(readEvidence(commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }
      if (wrapper.stage === 'elaboration') {
        const value = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString()) as ElaborationResult
        if (value.status === 'cancelled' && value.repairDiagnostics) f.store.requestControl(f.operation.id, 'pause')
      }
      return result
    }
  }
  if (mode === 'legacy-review' || mode === 'v3-review') {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
    const commonDir = f.input.source.commonDir, value = { version: 'elaboration-draft-v1', generationGuidance: mode === 'legacy-review' ? 'ac-test-flow-binding-v2' : 'ac-test-flow-review-binding-v3' }, resultRef = writeEvidence(commonDir, value)
    const wrapper = writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'elaboration-draft-protocol', resultRef })
    f.store.checkpoint(claimed.fence, { ...wrapper, artifacts: syncCheckpointArtifacts(value, resultRef) })
  }
  if (mode === 'wrong-stop' || wrongPacket) {
    const recordFailure = f.store.recordFailure.bind(f.store), findResource = f.store.findResource.bind(f.store)
    f.store.recordFailure = (fence, issue) => {
      const result = recordFailure(fence, issue)
      if (issue.code !== failureCode) return result
      f.store.findResource = (attemptId, key) => {
        const resource = findResource(attemptId, key)
        if (!resource || attemptId !== fence.attemptId || !key.endsWith(':elaboration_review')) return resource
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
        if (wrongPacket) saved.failure!.rejectedOutput!.representation = 'native_json'
        else saved.stop!.nativeStatus = 'unknown'
        return { ...resource, checkpointRef: writeEvidence(f.input.source.commonDir, saved) }
      }
      return result
    }
  }
  if (mode === 'wrong-task') {
    const recordFailure = f.store.recordFailure.bind(f.store), findResource = f.store.findResource.bind(f.store), listAttempts = f.store.listAttempts.bind(f.store)
    f.store.recordFailure = (fence, issue) => {
      const result = recordFailure(fence, issue)
      if (issue.code !== 'native_rpc_timeout') return result
      const commonDir = f.input.source.commonDir, prior = f.store.readAttempt(fence.attemptId)
      const dispatch = prior.dispatchPlans.find(item => item.purpose === 'elaboration_review')!, resource = findResource(prior.id, dispatch.key)!
      const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
      const local = JSON.parse(readEvidence(commonDir, issue.evidenceRefs[0]).toString()) as ElaborationResult
      const request = native.request
      request.prompt += '\n另一候选的任务。'
      request.inputDigest = contentHash(JSON.stringify({ inputDigest: local.inputDigest, purpose: request.purpose, prompt: request.prompt, schema: request.schema, worktree: request.worktree }))
      native.requestDigest = contentHash(JSON.stringify(request))
      const bindCheckpoint = (ref: { sha256: string }) => writeEvidence(commonDir, { ...JSON.parse(readEvidence(commonDir, ref).toString()), requestDigest: native.requestDigest })
      const alternate = { ...resource, plan: { ...resource.plan, payloadDigest: native.requestDigest, planBlob: writeEvidence(commonDir, native) }, checkpointRef: bindCheckpoint(resource.checkpointRef), checkpoints: resource.checkpoints.map(item => ({ ...item, checkpointRef: bindCheckpoint(item.checkpointRef) })) }
      f.store.findResource = (attemptId, key) => attemptId === prior.id && key === dispatch.key ? alternate : findResource(attemptId, key)
      f.store.listAttempts = id => listAttempts(id).map(attempt => attempt.id !== prior.id ? attempt : { ...attempt, dispatchPlans: attempt.dispatchPlans.map(item => item.key !== dispatch.key ? item : { ...item, requestDigest: native.requestDigest }) })
      const record = readRecord(native.expectedSessionId)!
      const prompt = nativeWorktreePrompt(request.prompt, request.worktree!), execution = structuredExecutionPolicy(request)
      writeRecord({ ...record, structuredExecution: { ...record.structuredExecution, ...execution }, createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, base: request.base, structuredExecution: execution })) })
      return result
    }
  }
  if (wrongCandidate) {
    const checkpoint = f.store.checkpoint.bind(f.store)
    f.store.checkpoint = (fence, ref) => {
      const commonDir = f.input.source.commonDir, wrapper = JSON.parse(readEvidence(commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }
      if (wrapper.stage !== 'elaboration') return checkpoint(fence, ref)
      const value = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString()) as ElaborationResult
      if (value.failure?.code !== failureCode) return checkpoint(fence, ref)
      const round = value.rounds.at(-1)!
      round.candidate!.changes[0].source += '\n这段正文没有出现在原Git稿。\n'
      round.candidateDigest = value.candidateDigest = contentHash(JSON.stringify(round.candidate))
      const resultRef = writeEvidence(commonDir, value)
      return checkpoint(fence, { ...writeEvidence(commonDir, { ...wrapper, resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
    }
  }
  const expandContractScope = f.store.expandContractScope.bind(f.store)
  if (formalRetry) f.store.expandContractScope = () => { throw new StructuredSessionError('unsupported', 'fixture在P1批准后、范围变化前停止') }
  f.store.startGeneration = () => { throw new StructuredSessionError('unsupported', 'fixture在P1正式独审通过后停止') }
  f.options.runner = async request => {
    calls.push(request)
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    if (mode === 'paused-review' && attempt.number === 2 && request.purpose === 'elaboration_review') throw new StructuredSessionError('cancelled', '仅续审中暂停，保留同一生成来源')
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
      readRecord,
      cancel: async () => { throw new Error('fixture禁止真实Native控制') },
      run: async actual => {
        const seed = actual.worktree!, execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey!, sessionId = sessionIdForCreateKey(key)
        const identity = { threadId: `p1-timeout-${sessionId}`, turnId: 'turn' }, workspace = join(f.parent, `p1-timeout-${calls.length}`)
        const timingOut = actual.purpose === 'elaboration_review' && attempt.number <= (formatTwice ? 2 : 1)
        let draft: unknown
        if (actual.purpose === 'code_behavior_analyze' || actual.purpose === 'code_behavior_review') {
          const task = nativeTask(actual, f.input.source.commonDir) as { requiredChangedPaths: string[] }
          if (actual.purpose === 'code_behavior_analyze') {
            draft = { changes: task.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保留导出义务', previousBehavior: '导出行为不变', sourceBehavior: '内部文字编辑', deliveryBehavior: '导出行为不变', evidence: 'src/export.js#ExportService', counterexample: '原结果仍保留' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
          } else {
            const reviewed = readCodeBehaviorContext(actual, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: { changes: { id: string }[] } }
            draft = { inputDigest: actual.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
          }
        } else if (actual.purpose === 'elaboration_generate') draft = partitioned
          ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '沿用完整冻结契约及已有边界', affectedIds: ['REQ-EXPORT-01'] })) }
          : adaptElaborationNativeOutput(actual, rows(original))
        else assert.equal(actual.purpose, 'elaboration_review')
        const worktree = draft ? committedDraftFixture(f, actual, draft, workspace) : undefined
        const output = draft ? { summary: '已正常提交草稿' } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
        const resultDigest = contentHash(JSON.stringify(output)), message = formatFailure ? 'fixture拒绝原格式' : 'ZCode native RPC timeout (session/events)'
        if (!timingOut && !worktree) f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
        const resultWorktree = timingOut ? undefined : worktree ?? nativeWorktreeResult(workspace, seed)
        const prompt = nativeWorktreePrompt(actual.prompt, seed)
        const rejectedOutput = formatFailure && timingOut ? rejectedFinalOutput('invalid JSON from review ' + attempt.number + '\u0000', prompt, execution, identity) : undefined
        configuredSessionApplication().createSession({ sessionId, status: timingOut ? 'error' : 'awaiting' })
        writeRecord({ session: sessionId, governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch: null, title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null, createdAt: Date.now(), harness: 'zcode', harnessSessionId: identity.threadId, runtimeStartToken: null, status: timingOut ? 'error' : 'awaiting', stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null,
          createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, base: seed.baseCommit, structuredExecution: execution })),
          structuredExecution: { ...execution, ...identity, turnStartRequested: true, ...(timingOut ? { state: 'failed', errorCode: failureCode, error: message, ...(rejectedOutput ? { rejectedOutput } : {}), zcodeNative: { version: 1, root: workspace, sessionId: identity.threadId, inputId: 'fixture-input', turnId: identity.turnId, pid: process.pid, receiptFile: join(workspace, 'fixture-process.json') }, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'stopped' } } : { state: 'completed', output, resultDigest, resultWorktree }) },
        })
        if (timingOut) throw new StructuredSessionError(failureCode, message, { sessionId, ...identity, ...(rejectedOutput ? { rejectedOutput } : {}) })
        return { sessionId, ...identity, output, resultDigest, worktree: resultWorktree }
      },
    } })(request)
  }
  let result = await runSyncOperation(f.store, f.operation.id, f.options)
  if (mode === 'paused' || mode === 'paused-review' || mode === 'newer-generation') {
    assert.equal(result.operation.control, 'pause')
    f.store.requestControl(f.operation.id, 'run')
    if (mode === 'newer-generation') {
      const original = f.store.readAttempt(result.operation.currentAttemptId!)
      const middle = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000 })
      f.store.bindComposedInput(middle.fence, original.composedInput!)
      f.store.reserveDispatch(middle.fence, { key: `sync:${middle.attempt.id}:elaborate:0:elaboration_generate`, purpose: 'elaboration_generate', requestDigest: contentHash('较新的已冻结生成请求') })
      f.store.requestControl(f.operation.id, 'pause')
      f.store.requestControl(f.operation.id, 'run')
    }
    result = await runSyncOperation(f.store, f.operation.id, f.options)
  }
  const attempts = f.store.listAttempts(f.operation.id), old = attempts[0], retry = attempts.at(-1)!
  const savedLocal = (attempt: SyncAttempt): ElaborationResult => {
    const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } })
    const wrapper = wrappers.find(entry => partitioned ? entry.stage.startsWith('partition:') && entry.stage.endsWith(':elaboration') : entry.stage === 'elaboration')!
    assert.ok(wrapper, JSON.stringify({ result: result.failure, attempt: attempt.failure, calls: calls.map(call => call.purpose) }))
    return JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
  }
  const originalResult = savedLocal(old), originalRound = originalResult.rounds.at(-1)!
  assert.equal(old.status, 'superseded')
  assert.equal(old.failure?.kind, mode === 'paused' ? undefined : 'repairable')
  assert.equal(originalResult.failure?.code, failureCode, JSON.stringify({ failure: originalResult.failure, findings: originalRound.findings }))
  assert.equal(originalResult.structurePassed, true)
  assert.equal(originalResult.reviewPassed, false)
  assert.deepEqual(originalResult.readyIds, [])
  assert.equal(originalRound.review, null)
  assert.equal(originalRound.reviewOutput, null)
  assert.equal(originalRound.traces.length, 1)
  assert.ok(originalRound.draft?.resultCommit)
  for (const dispatch of old.dispatchPlans) assert.equal(f.store.findResource(old.id, dispatch.key)?.phase, 'removed')
  const elaborationCalls = calls.filter(call => call.purpose.startsWith('elaboration_'))
  if (mode === 'newer-generation') {
    assert.deepEqual(elaborationCalls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review', 'elaboration_generate', 'elaboration_review'])
    assert.equal(savedLocal(retry).repairDiagnostics, undefined)
    return
  }
  if (mode === 'wrong-stop' || wrongCandidate || mode === 'wrong-task' || wrongPacket) {
    assert.deepEqual(elaborationCalls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
    assert.equal(result.failure?.code, mode === 'wrong-stop' ? 'checkpoint_artifact_binding' : 'review_retry_binding', JSON.stringify(result.failure))
    assert.equal(retry.dispatchPlans.length, 0)
    assert.equal(attempts.length, 2, '绑定失败在有剩余预算时也不可重派生成')
    return
  }
  assert.deepEqual(elaborationCalls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review', 'elaboration_review', ...(mode === 'paused-review' || formatTwice ? ['elaboration_review'] : [])], '正式独审已结算失败只重审同一候选')
  const reviewed = savedLocal(retry), reviewedRound = reviewed.rounds.at(-1)!
  assert.equal(reviewed.reviewPassed, true)
  assert.equal(retry.failure?.code, 'unsupported', JSON.stringify(retry.failure))
  assert.equal(reviewed.candidateDigest, originalResult.candidateDigest)
  assert.deepEqual(reviewedRound.candidate, originalRound.candidate)
  assert.deepEqual(reviewedRound.traces[0], originalRound.traces[0])
  assert.equal(reviewedRound.draft?.oid, originalRound.draft.oid)
  assert.equal(reviewedRound.draft?.resultCommit, originalRound.draft.resultCommit)
  assert.notEqual(reviewedRound.traces[1].sessionId, originalResult.failure?.sessionId)
  assert.notEqual(reviewedRound.traces[1].threadId, originalResult.failure?.threadId)
  assert.notEqual(reviewedRound.traces[1].sessionId, originalRound.traces[0].sessionId)
  if (formatFailure) {
    const commonDir = f.input.source.commonDir, oldTree = readTree(commonDir, elaborationCalls[1].worktree!.tree)
    for (const [index, request] of elaborationCalls.slice(2).entries()) {
      const rejected = savedLocal(attempts[index]).rounds.at(-1)!.rejectedOutput!
      const path = `.spex-sync-diagnostics/${rejected.sha256}/elaboration-review-rejected.raw`
      const tree = readTree(commonDir, request.worktree!.tree)
      const attachment = tree.find(entry => entry.path === path)
      assert.ok(attachment)
      assert.equal(attachment.mode, '100644')
      assert.equal(readObject(commonDir, attachment.oid).toString('utf8'), rejected.text)
      assert.equal(request.worktree!.mode, 'read')
      assert.deepEqual(tree.filter(entry => entry.path !== path), oldTree, '只允许本次拒稿，所有业务及保护对象逐字保持')
      assert.ok(request.prompt.includes(path))
      assert.match(request.prompt, /未可信格式诊断/)
      assert.deepEqual(request.schema, elaborationCalls[1].schema)
      const requestKey = attempts[index].dispatchPlans.find(dispatch => dispatch.purpose === 'elaboration_review')!.key
      const checkpoint = JSON.parse(readEvidence(commonDir, f.store.findResource(attempts[index].id, requestKey)!.checkpointRef).toString()) as NativeRunCheckpoint
      assert.equal(checkpoint.failure!.rejectedOutput!.ref, undefined)
      assert.equal(checkpoint.failure!.rejectedOutput!.text, rejected.text)
    }
  } else assert.deepEqual(elaborationCalls[1].worktree, elaborationCalls[2].worktree)
  assert.deepEqual(elaborationCalls[1].schema, elaborationCalls[2].schema)
  if (mode === 'v3-review') assert.equal(elaborationCalls[1].prompt, elaborationCalls[2].prompt, '已有V3超时续审提示逐字保持')
  if (mode === 'legacy-review') assert.doesNotMatch(elaborationCalls[1].prompt, /沿冻结VERIFY命令和包装器的实际调用逐项核对/)
  assert.match(elaborationCalls[2].prompt, /沿冻结VERIFY命令和包装器的实际调用逐项核对/)
  assert.match(elaborationCalls[2].prompt, /本轮审查修复范围.*冻结已接受内容/)
  assert.equal(Object.hasOwn(reviewed.repairDiagnostics!, 'settledReview'), false, '原review请求绑定只在内存传递')
  const previous = formatTwice ? savedLocal(attempts[1]) : originalResult
  assert.deepEqual(reviewed.repairDiagnostics?.round, previous.rounds.at(-1))
  assert.deepEqual(reviewed.repairDiagnostics?.failure, previous.failure)
  assert.equal(result.operation.callsUsed, partitioned ? formatTwice ? 6 : 5 : mode === 'paused-review' ? 4 : 3)
  if (formalRetry) {
    const owner = result.operation, commonDir = f.input.source.commonDir
    const source = readSyncCheckpoints(f.store, owner, retry)
    const key = `partition:${reviewed.partitionBinding!.partitionId}:elaboration`
    const sourceStages = source.json.map(({ value }) => value as { stage?: string; resultRef: BlobRef; readSetDigest?: string })
    const sourceStage = sourceStages.find(value => value.stage === key)!
    assert.equal(sourceStage.readSetDigest, owner.readSetDigest)
    const packet = reviewed.repairDiagnostics!.round.rejectedOutput!
    assert.ok(packet.ref)
    const rawRef = packet.ref
    assert.equal(packet.kind, 'untrusted_final')
    assert.equal(packet.ownerRequestKey, `sync:${old.id}:elaborate:partition:${reviewed.partitionBinding!.partitionId}`)
    assert.deepEqual(source.raw.get(rawRef.sha256), packet)
    const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'accepted-p1-format-retry', rootCauseId: 'accepted-p1-format-retry', retryOf: owner.id, model: 'claude:default', origin: owner.origin, budget: owner.budget, managedRoot: f.managedRoot, baselineSelection: f.store.readBusinessBaselineSelection(owner.id), executionScope: owner.scope, impactDigest: owner.impactDigest })
    const next = f.store.admitAndEnqueue(admission)
    const active = f.store.ackDispatch(f.input.source.repositoryId, next.dispatchMessageId)
    const { fence } = f.store.claimQueuedAttempt({ operationId: active.id, source: active.input.source, scope: active.scope, leaseMs: 30_000, expectedRevision: active.revision })
    f.store.bindComposedInput(fence, retry.composedInput!)
    const baselineSelectionRef = writeEvidence(commonDir, f.store.readBusinessBaselineSelection(active.id))
    const stageRef = (stage: string, value: unknown, readSetDigest = active.readSetDigest, target = { attemptId: fence.attemptId, selectionRef: baselineSelectionRef }) => {
      const resultRef = writeEvidence(commonDir, value)
      const artifacts = [...syncCheckpointArtifacts(value, resultRef), { kind: 'json' as const, ref: target.selectionRef }]
      const composition = stage === 'elaboration' ? { composedTree: retry.composedInput!.tree, composedContentDigest: retry.composedInput!.contentDigest } : {}
      return { ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: active.id, attemptId: target.attemptId, inputId: active.input.id, policyDigest: active.policyDigest, readSetDigest, baselineSelectionRef: target.selectionRef, ...composition, stage, resultRef }), artifacts }
    }
    const lineage = { fromOperationId: owner.id, fromAttemptId: retry.id, resultRef: sourceStage.resultRef }
    const provenanceKey = `${key}:provenance`, localRef = stageRef(key, reviewed)
    const savedPlan = sourceStages.find(value => value.stage === 'partition-plan')!
    const planRef = stageRef('partition-plan', JSON.parse(readEvidence(commonDir, savedPlan.resultRef).toString('utf8')))
    f.store.checkpoint(fence, planRef)
    f.store.checkpoint(fence, stageRef(provenanceKey, lineage))
    const nextAttempt = f.store.checkpoint(fence, localRef), current = f.store.readOperation(active.id)
    const foreignKey = 'partition:foreign-owner:elaboration'
    for (const [reason, checkpointRefs] of [
      ['缺来源', [localRef]],
      ['来源operation不在重试链', [stageRef(provenanceKey, { ...lineage, fromOperationId: 'unrelated' }), localRef]],
      ['来源attempt未批准', [stageRef(provenanceKey, { ...lineage, fromAttemptId: old.id }), localRef]],
      ['缺来源resultRef', [stageRef(provenanceKey, { ...lineage, resultRef: undefined }), localRef]],
      ['替换来源resultRef', [stageRef(provenanceKey, { ...lineage, resultRef: reviewed.repairDiagnostics!.resultRef }), localRef]],
      ['读取范围漂移', [stageRef(provenanceKey, lineage), stageRef(key, reviewed, contentHash('foreign read set'))]],
      ['换成其它owner', [stageRef(`${foreignKey}:provenance`, lineage), stageRef(foreignKey, reviewed)]],
    ] as const) {
      assert.throws(() => readSyncCheckpoints(f.store, current, { ...nextAttempt, checkpointRefs: [planRef, ...checkpointRefs] }), { code: 'checkpoint_artifact_binding' }, reason)
    }
    const copy = readSyncCheckpoints(f.store, current, nextAttempt)
    const stages = copy.json.map(({ value }) => value as { stage?: string; resultRef: BlobRef })
    const compact = readSyncCheckpointStageIndex(f.store, current, nextAttempt)
    assert.equal(compact.raw.has(rawRef.sha256), true)
    assert.deepEqual(compact.json, copy.json.filter(({ ref }) => nextAttempt.checkpointRefs.some(root => root.sha256 === ref.sha256)))
    assert.equal(compact.json.some(({ ref }) => ref.sha256 === sourceStage.resultRef.sha256), false)
    assert.deepEqual(stages.find(value => value.stage === key)?.resultRef, sourceStage.resultRef)
    const provenance = stages.find(value => value.stage === provenanceKey)!
    assert.deepEqual(JSON.parse(readEvidence(commonDir, provenance.resultRef).toString('utf8')), lineage)
    assert.deepEqual(nextAttempt.dispatchPlans, [])
    assert.deepEqual(copy.raw.get(rawRef.sha256), packet)
    assert.deepEqual(readEvidence(commonDir, rawRef), Buffer.from(packet.text, 'utf8'))
    assert.equal(copy.json.some(({ ref }) => ref.sha256 === rawRef.sha256), false)
    const directForeign = stageRef(key, originalResult)
    assert.throws(() => readSyncCheckpoints(f.store, current, { ...nextAttempt, checkpointRefs: [directForeign, ...nextAttempt.checkpointRefs] }), { code: 'checkpoint_artifact_binding' }, '同一SHA已在原operation认证，直接绑定到新operation仍须拒绝')
    assert.deepEqual(f.store.readAttempt(retry.id).checkpointRefs, retry.checkpointRefs)
    const wholeRef = sourceStages.find(value => value.stage === 'elaboration')!.resultRef
    const whole = JSON.parse(readEvidence(commonDir, wholeRef).toString()) as ElaborationResult
    assert.equal(whole.partitionEvidence?.find(member => member.partitionId === reviewed.partitionBinding!.partitionId)?.resultRef.sha256, sourceStage.resultRef.sha256)
    const expansionStage = stageRef('elaboration', whole)
    f.store.checkpoint(fence, expansionStage)
    const expanded = expandContractScope(fence, { paths: active.scope.paths, contractIds: ['REQ-EXPANDED-PROOF'], flowIds: [] }, wholeRef)
    assert.notEqual(expanded.baselineSelection!.digest, active.baselineSelection!.digest)
    const expandedReadSet = (await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'expanded-proof', rootCauseId: 'expanded-proof', origin: owner.origin, model: 'claude:default', budget: owner.budget, baselineSelection: expanded.baselineSelection, executionScope: expanded.scope, managedRoot: f.managedRoot })).readSetDigest
    assert.notEqual(expandedReadSet, active.readSetDigest)
    const rebound = f.store.bindComposedInput(fence, { ...retry.composedInput!, baselineSelectionDigest: expanded.baselineSelection!.digest }, { readSetDigest: expandedReadSet })
    const after = f.store.readOperation(active.id)
    assert.deepEqual(readSyncCheckpoints(f.store, after, rebound).raw.get(rawRef.sha256), packet)
    assert.deepEqual(readSyncCheckpoints(f.store, after, nextAttempt).raw.get(rawRef.sha256), packet)
    const originalPhase = withCheckpointStageBasis(after, active.readSetDigest, active.baselineSelection)
    assert.equal(originalPhase.readSetDigest, active.readSetDigest)
    assert.equal(originalPhase.baselineSelection?.digest, active.baselineSelection?.digest)
    assert.deepEqual(readSyncCheckpoints(f.store, originalPhase, nextAttempt).raw.get(rawRef.sha256), packet)
    assert.equal(readSyncCheckpointStageIndex(f.store, originalPhase, rebound).raw.has(rawRef.sha256), true)
    for (const scan of [readSyncCheckpoints, readSyncCheckpointStageIndex]) {
      assert.equal(scan(f.store, after, rebound).raw.has(rawRef.sha256), true)
      assert.equal(scan(f.store, after, nextAttempt).raw.has(rawRef.sha256), true)
      assert.throws(() => scan(f.store, after, { ...nextAttempt, baselineSelectionDigest: '0'.repeat(64) }), { code: 'checkpoint_artifact_binding' })
      assert.throws(() => scan(f.store, { ...after, contractScopeExpansions: [] }, rebound), { code: 'checkpoint_artifact_binding' })
      assert.throws(() => scan(f.store, after, { ...rebound, composedInput: { ...rebound.composedInput!, tree: '0'.repeat(40) } }), { code: 'checkpoint_artifact_binding' })
    }
    assert.deepEqual(rebound.dispatchPlans, [])
    f.store.requestControl(active.id, 'pause')
    const resumed = f.store.requestControl(active.id, 'run')
    const { fence: resumedFence } = f.store.claimQueuedAttempt({ operationId: resumed.id, source: resumed.input.source, scope: resumed.scope, leaseMs: 30_000, expectedRevision: resumed.revision, continuation: true })
    f.store.bindComposedInput(resumedFence, rebound.composedInput!)
    const target = { attemptId: resumedFence.attemptId, selectionRef: writeEvidence(commonDir, resumed.baselineSelection) }
    f.store.checkpoint(resumedFence, stageRef(provenanceKey, { fromOperationId: active.id, fromAttemptId: rebound.id, resultRef: sourceStage.resultRef }, expandedReadSet, target))
    const carried = f.store.checkpoint(resumedFence, stageRef(key, reviewed, expandedReadSet, target))
    assert.deepEqual(readSyncCheckpoints(f.store, resumed, carried).raw.get(rawRef.sha256), packet)
    assert.equal(readSyncCheckpointStageIndex(f.store, resumed, carried).raw.has(rawRef.sha256), true)
    assert.deepEqual(carried.dispatchPlans, [])
    assert.deepEqual(readEvidence(commonDir, rawRef), Buffer.from(packet.text, 'utf8'))
  }
  assert.equal(calls.some(call => call.purpose === 'code_generate'), false)
  assert.deepEqual(f.store.listJournals(f.operation.id), [])
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const target of ['elaboration_generate', 'code_generate'] as const) for (const pending of [true, false]) test(`并发RPC三分区保停止未知主诊断 ${target} pending=${pending}`, async t => {
  const variants = ['export', 'import', 'archive'].map(name => {
    const module = name === 'export' ? '' : name === 'import' ? 'beta/' : 'gamma/'
    const path = `.spec/project/${module}${name}-contract/spec.md`, sourcePath = `src/${module}${name}.js`
    const source = original.replaceAll('export-job', `${name}-job`).replaceAll('EXPORT', name.toUpperCase()).replaceAll('export-contract', `${name}-contract`).replaceAll('src/export.js', sourcePath).replaceAll('tests/export.test.mjs', `tests/${name}.test.mjs`).replaceAll(`VERIFY-${name.toUpperCase()}-01`, 'VERIFY-EXPORT-01').replaceAll(`decision:${name.toUpperCase()}-POLICY`, 'decision:EXPORT-POLICY').replaceAll(`["node","--test","tests/${name}.test.mjs"]`, '["node","--test","tests/export.test.mjs"]')
    return { name, path, source: name === 'export' ? source : source.replace(/\n### VERIFY\n[\s\S]*?(?=\n当前固定业务事实)/, '\n'), sourcePath }
  })
  const extras = Object.fromEntries(variants.slice(1).flatMap(({ name, path, source, sourcePath }) => [[path, source], [sourcePath, readFileSync(new URL('src/export.js', fixturePath), 'utf8')], [`tests/${name}.test.mjs`, readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', name.toUpperCase()).replaceAll('src/export.js', sourcePath)]]))
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 18, maxRepairs: 1, timeoutMs: 120000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', sourcePaths: ['src'], targets: variants.map(({ name, path }) => ({ nodeId: `${name}-contract`, path })),
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 3 },
  }, undefined, 'spec', undefined, false, extras)
  const codes = [pending ? 'cancellation_pending' : 'failed', 'unsupported', 'native_rpc_timeout'] as const, failures: { code: string; message: string }[] = []
  f.transform((output, request) => {
    if (request.purpose === target) {
      const code = codes[failures.length], message = '原三分区诊断-' + code
      assert(code, '不得派发新分区或新attempt'); failures.push({ code, message })
      throw new StructuredSessionError(code, message)
    }
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[] }
      const variant = variants.find(item => item.path === frozen.targets[0].path)!, generated = rows(variant.source, variant.path)
      generated.changes[0].nodeId = `${variant.name}-contract`
      for (const entry of generated.applicability) entry.affectedIds = [`REQ-${variant.name.toUpperCase()}-01`]
      return generated
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options), attempts = f.store.listAttempts(f.operation.id)
  assert.equal(failures.length, 3, JSON.stringify({ failure: result.failure, calls: f.calls.map(call => call.purpose) })); assert.equal(attempts.length, 1)
  assert.equal(result.status, pending ? 'recovery_required' : 'unsupported', JSON.stringify(result.failure)); assert.equal(result.failure?.code, pending ? 'cancellation_pending' : 'unsupported')
  assert.ok(result.failure!.message.endsWith('原三分区诊断-' + (pending ? 'cancellation_pending' : 'unsupported')))
  assert.equal(result.failure!.evidenceRefs.length, 1)
  const aggregate = JSON.parse(readEvidence(f.input.source.commonDir, result.failure!.evidenceRefs[0]).toString()) as ElaborationResult
  assert.equal(aggregate.failure!.code, pending ? 'cancellation_pending' : 'unsupported')
  const locals = readSyncCheckpoints(f.store, result.operation, attempts[0]).json.map(item => item.value as { failure?: { code: string; message: string } }).filter(value => value.failure && failures.some(failure => failure.message === value.failure!.message))
  for (const failure of failures) assert.ok(locals.some(local => JSON.stringify(local.failure) === JSON.stringify(failure)), '全部分区原诊断须保留')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(f.store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const target of ['code_generate', 'code_review'] as const) for (const mode of ['settled', 'partition', 'unknown', 'paused', 'wrong-proof'] as const) test(`P2 typed RPC ${target}/${mode} preserves failure identity and shares exact-stop repair admission`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 12, maxRepairs: 2, timeoutMs: 30000 }, false, original, 'project', original, mode === 'partition' ? { version: 'sync-coordinator-v2', direction: 'spec_to_code', sourcePaths: ['src/export.js'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 } } : {})
  const originalRunner = f.options.runner!, records = new Map<string, NativeRunRecord>()
  let advanced = false, firstCalls = 0
  const checkpoint = f.store.recordResourceCheckpoint.bind(f.store)
  f.store.recordResourceCheckpoint = (id, update) => {
    const saved = JSON.parse(readEvidence(f.input.source.commonDir, update.checkpointRef).toString()) as NativeRunCheckpoint
    if (mode === 'wrong-proof' && update.phase === 'removed' && saved.failure?.code === 'native_rpc_timeout') { saved.stop!.sessionId = 'another-native-owner'; return checkpoint(id, { ...update, checkpointRef: writeEvidence(f.input.source.commonDir, saved) }) }
    return checkpoint(id, update)
  }
  f.options.runner = async request => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    if (request.purpose === target && attempt.number > 1) { advanced = true; throw new StructuredSessionError('unsupported', 'fixture halts at the next same-operation Native request') }
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null,
      cancel: async id => { const state = records.get(id)!.structuredExecution!; return { sessionId: id, state: state.state!, nativeStopped: state.cancellation?.nativeStopped ?? state.state === 'completed', acknowledged: false, nativeStatus: 'stopped' } },
      run: async actual => {
        const execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key)
        const record: NativeRunRecord = { session: sessionId, status: 'error', harnessSessionId: null, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt: actual.prompt, parent: null, launcher: null, ...(actual.base?.trim() ? { base: actual.base.trim() } : {}), structuredExecution: execution })), structuredExecution: execution }
        records.set(sessionId, record)
        if (request.purpose !== target) {
          const result = await originalRunner(request)
          record.harnessSessionId = result.threadId; record.structuredExecution = { ...execution, state: 'completed', threadId: result.threadId, turnId: result.turnId, output: result.output, resultDigest: result.resultDigest }
          return result
        }
        firstCalls++
        const message = 'ZCode native RPC timeout (session/create)'
        record.structuredExecution = { ...execution, state: mode === 'unknown' ? 'cancelling' : 'failed', errorCode: 'native_rpc_timeout', error: message, turnStartRequested: true, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: mode !== 'unknown', acknowledged: false, ...(mode === 'unknown' ? { error: message } : { nativeStatus: 'stopped' }) } }
        if (mode === 'paused') f.store.requestControl(operation.id, 'pause')
        throw new StructuredSessionError(mode === 'unknown' ? 'cancellation_pending' : 'native_rpc_timeout', message, { sessionId })
      },
    } })(request)
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(advanced, ['settled', 'partition'].includes(mode)); assert.equal(firstCalls, 1)
  const attempts = f.store.listAttempts(f.operation.id)
  assert.equal(attempts.length, ['settled', 'partition'].includes(mode) ? 2 : 1)
  if (['settled', 'partition'].includes(mode)) { assert.equal(attempts[0].failure?.code, 'native_rpc_timeout'); assert.equal(attempts[0].failure?.kind, 'repairable') }
  if (mode === 'unknown' || mode === 'wrong-proof') assert.equal(result.status, 'recovery_required')
  assert.equal(f.store.listRecoverableResources().length, mode === 'unknown' ? 1 : 0)
})

for (const kind of ['syntax', 'json-reference'] as const) test(`Native terminal failure before Saved round publishes no raw evidence edge: ${kind}`, async t => {
  const f = await fixture(t), claim = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedMessageId: f.operation.dispatchMessageId })
  const unrelated = writeEvidence(f.input.source.commonDir, { privateFixture: 'must remain unreachable' }), text = kind === 'syntax' ? '{"bad":[}' : JSON.stringify({ sha256: unrelated.sha256 })
  const records = new Map<string, NativeRunRecord>(), interrupted = new Error('fixture interrupts after Native terminal before Saved round')
  const checkpoint = f.store.recordResourceCheckpoint.bind(f.store)
  f.store.recordResourceCheckpoint = (id, update) => { const result = checkpoint(id, update); if (update.phase === 'terminal') throw interrupted; return result }
  const request = { root: f.root, base: f.input.headCommit, requestKey: `sync:${claim.attempt.id}:elaborate:0:elaboration_generate`, inputDigest: 'terminal-input', purpose: 'elaboration_generate', prompt: 'Return a JSON object', schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } }, additionalProperties: false }, timeoutMs: 5000 }
  const runtime = {
    readRecord: (id: string) => records.get(id) ?? null,
    cancel: async (): Promise<never> => { throw new Error('cold failure replay must not invoke Native cancellation') },
    run: async (actual: import('../session-structured.js').StructuredSessionRequest): Promise<never> => {
      const policy = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key), identity = { threadId: 'terminal-thread', turnId: 'terminal-turn' }
      const rejectedOutput = rejectedFinalOutput(text, actual.prompt, policy, identity)
      records.set(sessionId, { session: sessionId, status: 'error', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt: actual.prompt, parent: null, launcher: null, base: actual.base, structuredExecution: policy })), structuredExecution: { ...policy, ...identity, state: 'failed', errorCode: 'structured_output_format_invalid', error: 'original format failure', rejectedOutput, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' } } })
      throw new StructuredSessionError('structured_output_format_invalid', 'original format failure', { sessionId, ...identity, rejectedOutput })
    },
  }
  await assert.rejects(createAttemptRunner(f.store, claim.fence, { runtime, pollMs: 2 })(request), error => error === interrupted)
  assert.equal(f.store.findResource(claim.attempt.id, request.requestKey)!.phase, 'terminal')
  assert.deepEqual(f.store.readAttempt(claim.attempt.id).checkpointRefs, [])
  const app = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.parent, 'terminal-read') })
  await app.readOperation(f.operation.id)
  await assert.rejects(app.readEvidence(f.operation.id, unrelated), { code: 'sync_evidence_unrelated' })
  const before = JSON.parse(readEvidence(f.input.source.commonDir, f.store.findResource(claim.attempt.id, request.requestKey)!.checkpointRef).toString()) as NativeRunCheckpoint
  assert.equal(before.failure!.rejectedOutput!.ref, undefined)
  f.store.recordResourceCheckpoint = checkpoint
  await assert.rejects(createAttemptRunner(f.store, claim.fence, { runtime: { ...runtime, run: async () => assert.fail('cold replay cannot resend') }, pollMs: 2 })(request), error => {
    const failure = error as StructuredSessionError
    assert.equal(failure.code, 'structured_output_format_invalid'); assert.equal(failure.message, 'original format failure'); assert(failure.rejectedOutput?.ref)
    assert.equal(readEvidence(f.input.source.commonDir, failure.rejectedOutput.ref).toString(), text)
    return true
  })
  const resource = f.store.findResource(claim.attempt.id, request.requestKey)!
  assert.equal(resource.phase, 'removed')
  assert.equal((JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint).failure!.rejectedOutput!.ref, undefined)
  assert.equal(f.store.readOperation(f.operation.id).callsUsed, 1)
})

test('untrusted final digest without historical ref never invents a CAS pin or evidence edge', async t => {
  const f = await fixture(t)
  const packet = rejectedFinalOutput('original without a CAS ref', 'prompt', { inputDigest: 'input', schema: {}, purpose: 'elaboration_generate' }, { threadId: 'thread', turnId: 'turn' })
  const value = { rounds: [{ rejectedOutput: packet }] }, result = writeEvidence(f.input.source.commonDir, value)
  const artifacts = syncCheckpointArtifacts(value, result)
  assert.deepEqual(artifacts, [{ kind: 'json', ref: result }])
  assert.equal(packet.ref, undefined)
  const claim = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedMessageId: f.operation.dispatchMessageId })
  f.store.checkpoint(claim.fence, { ...writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claim.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'diagnostic', resultRef: result }), artifacts })
  const before = f.store.readAttempt(claim.attempt.id).checkpointRefs
  const app = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.parent, 'read-application') })
  assert.deepEqual(await app.readEvidence(f.operation.id, result), value)
  await assert.rejects(app.readEvidence(f.operation.id, { sha256: packet.sha256 }), { code: 'sync_evidence_unrelated' })
  assert.deepEqual(f.store.readAttempt(claim.attempt.id).checkpointRefs, before)
})

test('readonly-owner零派发guard只阻相同候选诊断，真实owner新派发未修好仍继续', () => {
  const findings = [{ code: 'anchor-dead', severity: 'error' as const, nodeId: 'owner', path: '.spec/owner/spec.md', message: 'src/main.mjs#options不存在' }]
  const repair = { candidateDigest: 'same', findings, owners: [{ key: 'partition:owner:elaboration', partitionId: 'owner', fromAttemptId: 'before', resultRef: { sha256: 'a'.repeat(64) } }] }
  const attempt = { id: 'now', dispatchPlans: [] as import('./operation-types.js').DispatchPlan[] }
  assert.equal(readonlySpecRepairStalled(repair, 'same', findings, attempt), true)
  for (const purpose of ['elaboration_generate', 'elaboration_review']) {
    const dispatch = { key: `sync:now:elaborate:partition:owner:0:${purpose}`, purpose, requestDigest: 'request', sessionCreateKey: 'create', session: null }
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [dispatch] }), false)
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [{ ...dispatch, key: dispatch.key.replace('partition:owner:', 'partition:foreign:') }] }), true)
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [{ ...dispatch, key: dispatch.key.replace('sync:now:', 'sync:old:') }] }), true)
  }
  assert.equal(readonlySpecRepairStalled(repair, 'changed', findings, attempt), false)
  assert.equal(readonlySpecRepairStalled(repair, 'same', [{ ...findings[0], message: '另一真实错误' }], attempt), false)
})

for (const mode of ['review-format-continuation', 'review-format-interleaved', 'review-format-finite-one', 'review-format-finite-zero', 'review-failure-settlement', 'existing', 'mixed-citations', 'new-leaf', 'aggregate-only', 'review', 'review-anchor-reference', 'review-accepted-reuse', 'review-accepted-reuse-repair', 'review-partial', 'review-pending', 'review-pending-unchanged', 'review-pending-sibling', 'review-pending-cross-source', 'review-pending-missing-owner', 'review-pending-lineage', 'review-pending-foreign-base', 'review-pending-unreviewed-base', 'review-prose', 'review-prose-cross-owner', 'review-prose-unknown', 'review-prose-path', 'review-prose-empty', 'review-multi', 'review-p1-fail', 'review-rebind', 'review-rebind-native', 'review-resume', 'review-location', 'review-ref', 'wrong-ref', 'unaffected-ref', 'readset', 'selection', 'selection-deleted', 'selection-source', 'non-null-selection', 'input-digest', 'foreign', 'policy', 'candidate', 'missing-owner'] as const) test(`readonly-owner late V1 ${mode} 只返修精确owner`, async t => {
  const formatFinite = mode === 'review-format-finite-one' || mode === 'review-format-finite-zero'
  const formatRemaining = mode === 'review-format-finite-one' ? 1 : 0
  const settleFailureOnly = mode === 'review-failure-settlement'
  const formatInterleaved = mode === 'review-format-interleaved'
  const formatContinuation = mode === 'review-format-continuation' || formatInterleaved || formatFinite || settleFailureOnly
  const reuse = formatContinuation || mode.startsWith('review-accepted-reuse'), reuseRepair = mode === 'review-accepted-reuse-repair'
  const ordinaryAnchor = mode === 'review-anchor-reference'
  const partial = mode === 'review-partial' || ordinaryAnchor
  const rebinding = mode === 'review-rebind' || mode === 'review-rebind-native'
  const crossSource = mode === 'review-pending-cross-source', missingOwner = mode === 'review-pending-missing-owner', lineage = mode === 'review-pending-lineage'
  const pending = mode.startsWith('review-pending'), unchanged = mode === 'review-pending-unchanged', sibling = mode === 'review-pending-sibling' || crossSource || missingOwner, invalidBase = mode === 'review-pending-foreign-base' || mode === 'review-pending-unreviewed-base'
  const prose = mode.startsWith('review-prose') || pending
  const semantic = mode.startsWith('review'), multi = mode === 'review-multi' || mode === 'review-p1-fail'
  const newLeaf = semantic && !partial && !reuse || mode === 'new-leaf' || mode === 'aggregate-only', aggregateOnly = mode === 'aggregate-only'
  const negative = !['existing', 'mixed-citations', 'new-leaf', 'aggregate-only', 'review', 'review-anchor-reference', 'review-accepted-reuse', 'review-accepted-reuse-repair', 'review-partial', 'review-pending', 'review-pending-unchanged', 'review-pending-sibling', 'review-pending-lineage', 'review-prose', 'review-multi', 'review-p1-fail', 'review-rebind', 'review-rebind-native', 'review-resume'].includes(mode)
  const mixedCitations = mode === 'mixed-citations'
  const baseSpec = (mixedCitations ? original.replace('code:\n', 'related:\n  - tests/export.test.mjs\ncode:\n') : original).split('\n').map(line => line.startsWith('| AC-EXPORT-') ? line.replace(' | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |', ' | code:src/export.js#ExportService | REQ-EXPORT-01 |') : line).join('\n')
  const definitions = [
    { nodeId: 'export-contract', path: contractPath, sourcePath: 'src/export.js', testPath: 'tests/export.test.mjs', word: 'export', upper: 'EXPORT' },
    ...(formatContinuation ? ['import', 'archive', 'report', 'download', 'upload'] : ['import', 'archive', 'report']).map(word => ({ nodeId: `${word}-contract`, path: `.spec/project/${word}/${word}-contract/spec.md`, sourcePath: `src/${word}/${word}.js`, testPath: `tests/${word}.test.mjs`, word, upper: word.toUpperCase() })),
  ]
  if (newLeaf) for (const added of definitions.slice(3)) { added.nodeId = `sync-code-${contentHash(added.sourcePath).slice(0, 16)}`; added.path = `.spec/project/export-contract/${added.nodeId}/spec.md` }
  const badOwner = formatContinuation ? definitions.at(-1)! : partial ? definitions[2] : newLeaf ? definitions[3] : definitions[0]
  const badOwners = multi ? [definitions[2], badOwner] : [badOwner]
  const sources = new Map(definitions.map(definition => [definition.nodeId, baseSpec.replaceAll('export-job', `${definition.word}-job`).replaceAll('EXPORT', definition.upper).replaceAll('export-contract', definition.nodeId).replaceAll('src/export.js', definition.sourcePath).replaceAll('tests/export.test.mjs', definition.testPath).replaceAll(`decision:${definition.upper}-POLICY`, 'decision:EXPORT-POLICY')]))
  const extras = Object.fromEntries(definitions.slice(1).flatMap(definition => [[definition.path, multi && definition === definitions[2] ? sources.get(definition.nodeId)!.slice(0, sources.get(definition.nodeId)!.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '') : sources.get(definition.nodeId)!], [definition.sourcePath, readFileSync(new URL('src/export.js', fixturePath), 'utf8')], [definition.testPath, readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', definition.upper).replaceAll('src/export.js', definition.sourcePath)]]).filter(([path]) => !newLeaf || path !== badOwner.path))
  const verifications = definitions.map(definition => { const item = parseContract({ nodeId: definition.nodeId, path: definition.path, source: sources.get(definition.nodeId)! }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(item.kind, 'VERIFY'); return { definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment: { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } } })
  const mandatoryTests = definitions.map(definition => ({ verificationId: `VERIFY-${definition.upper}-01`, testPath: definition.testPath, testId: `AC-${definition.upper}-01` }))
  const f = await fixture(t, formatFinite ? { maxAttempts: 3, maxCalls: 30 + formatRemaining, maxRepairs: 2, timeoutMs: 300000 } : { mode: 'unlimited' }, false, baseSpec, 'project', baseSpec, { version: 'sync-coordinator-v2', direction: 'code_to_spec', targets: definitions.filter(item => !newLeaf || item !== badOwner).map(({ nodeId, path }) => ({ nodeId, path })), sourcePaths: ['src'], writePaths: ['.spec'], verifications, mandatoryTests, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: definitions.map(item => item.sourcePath) } }, undefined, 'code', undefined, true, extras)
  const renewals: { attemptId: string; at: number }[] = []
  if (formatInterleaved) {
    const renew = f.store.renewLease.bind(f.store)
    f.store.renewLease = (fence, duration) => { const result = renew(fence, duration); renewals.push({ attemptId: fence.attemptId, at: Date.now() }); return result }
  }
  if (newLeaf) assert.equal(f.input && readTree(f.input.source.commonDir, f.input.immutableTree).some(entry => entry.path === badOwner.path), false)
  const snapshotObjects = readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  const ownerCalls: { attempt: number; nodeId: string; purpose: string }[] = []
  const reviewCalls: { attempt: number; key: string }[] = []
  let finalReview = false, badGenerations = 0
  let partialFailed = false
  const generatedPerOwner = new Map<string, number>()
  const originalBusiness = new Map<string, string>()
  f.transform((output, request) => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('code_behavior_')) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      const definition = definitions.find(item => context.changedPaths.includes(item.sourcePath))!
      if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, ...(newLeaf && badOwners.includes(definition) ? { kind: 'allowed_change', affectedIds: [], ruleIds: [] } : { affectedIds: [`RULE-${definition.upper}-05`], ruleIds: [`RULE-${definition.upper}-05`] }) })), newNodes: newLeaf && definition === badOwner ? [{ codePath: definition.sourcePath, parentNodeId: 'export-contract', basis: '真实新增无治理模块具有父raw对应的服务职责' }] : [] }
    }
    if (request.purpose.startsWith('elaboration_')) {
      const context = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string; path: string }[]; readonlySpecRepair?: ElaborationResult['readonlySpecRepair'] }
      const definition = definitions.find(item => item.nodeId === context.targets[0].nodeId)!
      ownerCalls.push({ attempt: attempt.number, nodeId: definition.nodeId, purpose: request.purpose })
      if (prose || partial) {
        const business = JSON.stringify({ ...context, readonlySpecRepair: undefined })
        if (attempt.number === 1) originalBusiness.set(definition.nodeId, business)
        else assert.equal(business, originalBusiness.get(definition.nodeId), 'prose诊断不改变原raw/facts/授权/冻结源码tests')
      }
      if (attempt.number > 1) {
        assert.ok(badOwners.includes(definition) || sibling && attempt.number === 3 && definition === definitions[2], '其它owner不得因兄弟失败再派发')
        assert.ok(context.readonlySpecRepair, '真实late V1原件诊断必须进入owner冻结输入')
      }
      if (mode === 'review-p1-fail' && attempt.number === 2 && definition === badOwner && request.purpose === 'elaboration_review') return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'oracle-evidence', kind: 'repair', affectedIds: [`AC-${definition.upper}-01`], evidence: '候选仍过度声称父目录断言', decision: '准确保持raw并修正证据表述', message: 'oracle只测文件absence，当前候选声明过度' }] }
      if (request.purpose === 'elaboration_generate') {
        const generated = rows(sources.get(definition.nodeId)!, definition.path)
        generated.changes[0].nodeId = definition.nodeId
        if (!semantic && context.readonlySpecRepair) {
          const original = context.readonlySpecRepair.changes.find(change => change.nodeId === definition.nodeId)!
          generated.changes[0].description = String(parseFrontmatter(original.source).fm.desc ?? '')
          generated.changes[0].prose = null
          if (mixedCitations && attempt.number === 2) generated.changes[0].description = '未获授权的业务描述改动'
        }
        if (semantic) {
          const number = (generatedPerOwner.get(definition.nodeId) ?? 0) + 1; generatedPerOwner.set(definition.nodeId, number)
          if (!partial && !reuse && badOwners.includes(definition) && (unchanged || crossSource || lineage || number < (pending || mode === 'review-p1-fail' && definition !== badOwner ? 2 : 3))) {
            if (prose) generated.changes[0].prose += '\n错误正文一：成功路径被叙述为失败。\n错误正文二：失败分类计数与实际状态表不一致。\n'
            else generated.changes[0].tables.AC[0].assertion += '（错误地声称oracle还检查了父目录absence）'
          }
          if (rebinding && definition === badOwner && number >= 2) generated.changes[0].tables.AC.push({ ...generated.changes[0].tables.AC[0], id: `AC-${definition.upper}-ADDED-REVIEW` })
          if (attempt.number > 1) {
            const repair = context.readonlySpecRepair as { kind: string; reviewEvidence: unknown[] }
            assert.equal(repair.kind, 'candidate_review'); assert.ok(repair.reviewEvidence.length)
            if (partial) assert.equal((repair as unknown as { findings: unknown[] }).findings.length, 3)
            if (prose) {
              const findings = (repair as unknown as { findings: { itemId?: string; relatedIds: string[]; message: string }[] }).findings
              assert.equal(findings.length, partial ? 3 : 2)
              assert.ok(findings.every(finding => finding.itemId === undefined && finding.relatedIds.length === 2 && JSON.parse(finding.message).ruleLocation.includes(' — expanded spec 段落')))
            }
            assert.ok(request.prompt.includes('不是新的业务事实或授权'))
          }
        } else if (definition.nodeId === badOwner.nodeId && ++badGenerations < 3) {
          for (const [index, acceptance] of generated.changes[0].tables.AC.entries()) acceptance.source = `code:${definition.sourcePath}#${index % 2 ? 'options' : 'process.stdout.write'}`
          if (mixedCitations) generated.changes[0].related = ['tests/missing-related.test.mjs']
        }
        return generated
      }
    }
    assert.notEqual(request.purpose, 'code_generate', '只读方向不得调用代码生成器')
    if (request.purpose === 'code_review') {
      if (reuse) {
        reviewCalls.push({ attempt: attempt.number, key: request.requestKey.split(':final:')[1] })
        if (formatContinuation) {
          const local = promptInput(request), isB = local.elaboratedSpecs.some(spec => spec.path === badOwner.path), isA = formatInterleaved && local.elaboratedSpecs.some(spec => spec.path === definitions[4].path)
          if (attempt.number > 1) {
            assert.ok(isB || isA && attempt.number === 2, '只续失败组，已accept兄弟不能重新派发')
            assert.ok(request.prompt.includes('原评审完整回答：'))
            if (isA) return output
            if (attempt.number >= (formatFinite ? 2 : formatInterleaved ? 4 : 3)) throw Object.assign(new Error('目标多轮续审已证，在Docker前停止'), { code: 'unsupported' })
          }
          if (!isA && !isB) return output
          return rejectedReviewFixture(f, request, '原评审完整回答：\n' + JSON.stringify(output))
        }
        if (attempt.number >= 4) throw Object.assign(new Error('cached accept与fresh repair已由owner处理；Docker前停止'), { code: 'unsupported' })
        if (promptInput(request).elaboratedSpecs.some(spec => spec.path === badOwner.path)) {
          if (reuseRepair && attempt.number === 3) return { ...(output as object), verdict: 'repair', findings: [{ kind: 'repair', affectedIds: [`AC-${badOwner.upper}-01`], ruleLocation: `contract:${badOwner.path}#AC-${badOwner.upper}-01`, codeLocation: badOwner.sourcePath, evidence: '本轮真实独审要求复核已接受表述', counterexample: '旧accept不能代替本轮repair的owner回应', message: '沿原raw/source复核，允许critic误读而保持正文，不增加授权' }] }
          throw Object.assign(new Error('固定失败分区；其余真实accept必须按同输入承接'), { code: attempt.number >= 3 ? 'unsupported' : 'failed' })
        }
        return output
      }
      if (semantic) {
        const frozen = promptInput(request)
        if (sibling && attempt.number === 2) {
          const owner = crossSource ? badOwner : definitions[2], id = `AC-${owner.upper}-01`
          return { ...(output as object), verdict: frozen.readyIds.includes(id) ? 'repair' : 'accept', findings: frozen.readyIds.includes(id) ? [1, 2].map(number => ({ kind: 'repair', affectedIds: [id, `RULE-${owner.upper}-05`], ruleLocation: `${owner.path} — expanded spec 段落「新兄弟复核${number}」`, codeLocation: `${owner.sourcePath}#ExportService`, evidence: '后续独审要求兄弟澄清，P1可核对后认定误审并保持正文', counterexample: '单凭定位不足以授权业务变化', message: '沿原raw复核，不授新权' })) : [] }
        }
        if (sibling && (attempt.number === 3 || attempt.number === 4)) {
          if (frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) throw Object.assign(new Error('旧版仅处理兄弟后或本轮P1后原生失败'), { code: 'failed' })
          return output
        }
        if (lineage && attempt.number >= 4) {
          const id = `AC-${badOwner.upper}-01`
          if (attempt.number === 4) return { ...(output as object), verdict: frozen.readyIds.includes(id) ? 'repair' : 'accept', findings: frozen.readyIds.includes(id) ? [1, 2].map(number => ({ kind: 'repair', affectedIds: [id, `RULE-${badOwner.upper}-05`], ruleLocation: `${badOwner.path} — expanded spec 段落「独立后续复核B${number}」`, codeLocation: `${badOwner.sourcePath}#ExportService`, evidence: 'A已由fresh P1核过，B绑定新的acceptedRef再次独立复核', counterexample: '正文不必为迎合critic改义', message: '以原raw复核同一正文，非新授权' })) : [] }
          if (attempt.number === 5) {
            if (frozen.readyIds.includes(id)) throw Object.assign(new Error('B回应后P2原生失败'), { code: 'failed' })
            return output
          }
          finalReview = true; throw Object.assign(new Error('A/B均已明确处理，同body不再P1；Docker前停止'), { code: 'unsupported' })
        }
        if (partial) {
          if (attempt.number > 1) { finalReview = true; throw Object.assign(new Error('partial诊断已由fresh P1处理；完整P2重审在Docker前停止'), { code: 'unsupported' }) }
          if (!partialFailed && !frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) { partialFailed = true; throw Object.assign(new Error('fixture其它分区真实Native失败，review保持null'), { code: 'failed' }) }
          const ids = [`AC-${badOwner.upper}-01`, `RULE-${badOwner.upper}-05`, `FLOW-${badOwner.upper}-01`]
          return { ...(output as object), verdict: frozen.readyIds.includes(ids[0]) ? 'repair' : 'accept', findings: frozen.readyIds.includes(ids[0]) ? ids.map((id, index) => ({ kind: 'repair', affectedIds: ordinaryAnchor && index === 1 ? [`AC-${badOwner.upper}-01`, `AC-${badOwner.upper}-02`, `REQ-${badOwner.upper}-01`] : ordinaryAnchor && index === 2 ? ['AC-EXPORT-01'] : [id], ruleLocation: `contract:${badOwner.path}#${id}`, codeLocation: `${badOwner.sourcePath}#ExportService`, evidence: '独立评审要求核对候选表述和现有实现，P1可复核误读而保持正文', counterexample: '空复审不能代替owner回应先前3条发现', message: '按原raw/source复核，不改源码或授权' })) : [] }
        }
        const issues = frozen.elaboratedSpecs.flatMap(spec => {
          const definition = badOwners.find(owner => owner.path === spec.path), id = definition && `AC-${definition.upper}-01`
          if (prose && id && frozen.readyIds.includes(id) && spec.source.includes('错误正文一')) return (partial ? [1, 2, 3] : [1, 2]).map(number => ({ kind: 'repair', affectedIds: [id, mode === 'review-prose-cross-owner' ? 'REQ-EXPORT-01' : `RULE-${definition.upper}-05`], ruleLocation: `${mode === 'review-prose-path' ? '.spec/foreign/spec.md' : spec.path} — expanded spec ${mode === 'review-prose-empty' ? '' : `段落「错误正文${number}」`}`, codeLocation: `${definition.sourcePath}#ExportService`, evidence: '同一候选正文与其规则和状态表自相矛盾', counterexample: '按错误正文执行会把已明确成功路径当作失败', message: '按原raw及源码校正正文叙述，保REQ/RULE/AC义务' }))
          return id && frozen.readyIds.includes(id) && spec.source.includes('错误地声称oracle') ? [{ kind: 'repair', affectedIds: [id], ruleLocation: `${mode === 'review-location' ? '.spec/foreign/spec.md' : `${multi ? 'contract:' : ''}${spec.path}`}#${id}`, codeLocation: 'tests/export.test.mjs#AC-EXPORT-01', evidence: '完整测试只断言文件absence，没有断言父目录absence', counterexample: '父目录存在但文件缺失仍满足原oracle', message: '保留raw要求，准确表述当前AC证据覆盖，不宣称未测断言' }] : []
        })
        if (pending && (unchanged || invalidBase) && attempt.number >= 4) {
          if (attempt.number === 4) {
            if (frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) throw Object.assign(new Error('新P1已回应后同candidate独审原生失败'), { code: 'failed' })
            return output
          }
          finalReview = true; throw Object.assign(new Error('fixture在已处理诊断的whole重用后、Docker前停止'), { code: 'unsupported' })
        }
        if (mode === 'review-rebind-native' && attempt.number === 2 && issues.length) throw Object.assign(new Error('fixture实际P2原生失败；不得当作语义repair'), { code: 'failed' })
        if (issues.length) return { ...(output as object), verdict: 'repair', findings: issues }
        if (attempt.number < (mode === 'review-resume' || mode === 'review-rebind-native' ? 4 : 3)) return output
      }
      finalReview = true; throw Object.assign(new Error('fixture在全候选真实V1通过后、Docker之前停止'), { code: 'unsupported' })
    }
    return output
  })
  const claim = f.store.claimQueuedAttempt.bind(f.store)
  const recordFailure = f.store.recordFailure.bind(f.store)
  const listAttempts = f.store.listAttempts.bind(f.store)
  let immutable: { refs: import('./operation-types.js').BlobRef[]; failure: unknown; dispatchPlans: SyncAttempt['dispatchPlans'] } | undefined
  let missingOwnerOriginal: SyncAttempt | undefined
  f.store.recordFailure = (fence, issue) => {
    const before = f.store.readAttempt(fence.attemptId)
    if (partial && before.number === 1) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
      const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      assert.equal(generated.status, 'failed'); assert.ok(generated.failure); assert.equal(generated.review, null)
      assert.equal(generated.partitionEvidence.flatMap((part: { review: { findings: unknown[] } }) => part.review.findings).length, 3, '真正失败组合必须保存3条有效局部repair')
      if (ordinaryAnchor) {
        const finding = generated.partitionEvidence.flatMap((part: { review: { findings: { ruleLocation: string; affectedIds: string[] }[] } }) => part.review.findings).find((finding: { ruleLocation: string }) => finding.ruleLocation.endsWith(`#RULE-${badOwner.upper}-05`))!
        assert.equal(finding.affectedIds.includes(`RULE-${badOwner.upper}-05`), false, '合法普通RULE引用不要求anchor在受影响ID中')
      }
    }
    if (sibling && before.number === 1) {
      // 只对读取视图模拟旧版忽略早期generation；原SQLite/CAS与全部P1原件保持。
      f.store.listAttempts = id => listAttempts(id).map(prior => prior.id === before.id ? { ...prior, checkpointRefs: prior.checkpointRefs.filter(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()); return value.version !== 'sync-stage-v1' || value.stage !== 'generation' }) } : prior)
    }
    if (sibling && before.number === 3) f.store.listAttempts = listAttempts
    if (missingOwner && before.number === 3) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
      const whole = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      whole.partitionEvidence = whole.partitionEvidence.filter((owner: { resultRef: { sha256: string } }) => !JSON.parse(readEvidence(f.input.source.commonDir, owner.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwner.nodeId))
      const resultRef = writeEvidence(f.input.source.commonDir, whole); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
    }
    if (invalidBase && before.number === 4) {
      const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())), original = wrappers.find(value => value.stage === 'repair-input')
      const input = JSON.parse(readEvidence(f.input.source.commonDir, original.resultRef).toString())
      const whole = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(value => value.stage === 'elaboration').resultRef).toString())
      input.readonlyBaseRef = writeEvidence(f.input.source.commonDir, mode === 'review-pending-foreign-base' ? { foreign: 'unapproved base' } : { ...whole, reviewPassed: false })
      const resultRef = writeEvidence(f.input.source.commonDir, input); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...original, resultRef }))
    }
    if (before.number === 1 && issue.code === 'generation_failed' && (mode === 'review-ref' || mode === 'review-prose-unknown')) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
      const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      const review = generated.partitionEvidence.find((evidence: { review: { verdict: string } }) => evidence.review.verdict === 'repair')
      if (mode === 'review-prose-unknown') review.review.findings[0].affectedIds.push('REQ-UNKNOWN-01')
      else review.review.findings[0].message += '外来改写'
      const resultRef = writeEvidence(f.input.source.commonDir, generated); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
    }
    if (before.number === 1 && issue.code === 'generation_failed' && negative && !semantic) {
      const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const local = wrappers.find(value => value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwner.nodeId))
      if (['readset', 'selection', 'selection-deleted', 'selection-source', 'non-null-selection', 'foreign', 'policy'].includes(mode)) {
        let selection = { ...f.operation.baselineSelection!, digest: contentHash('wrong selection') }
        if (mode === 'selection-deleted' || mode === 'selection-source') {
          selection = structuredClone(f.operation.baselineSelection!)
          if (mode === 'selection-deleted') selection.bindings = selection.bindings.slice(1)
          else selection.source.branch = 'foreign-selection-branch'
          selection.digest = contentHash(JSON.stringify({ version: selection.version, source: selection.source, bindings: selection.bindings }, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
        }
        if (mode === 'non-null-selection') {
          selection = structuredClone(f.operation.baselineSelection!)
          const first = selection.bindings[0]; assert.equal(first.resource.kind, 'path'); assert.ok('bytePair' in first)
          first.bytePair = { id: 'unapproved-fixture-pair', repositoryId: f.input.source.repositoryId, source: f.input.source, sourceInput: f.input, verifiedDelivery: f.input, coveredScope: { paths: [first.resource.path], contractIds: [], flowIds: [] }, receiptId: 'not-authority', settledAtMs: 1 }
          selection.digest = contentHash(JSON.stringify({ version: selection.version, source: selection.source, bindings: selection.bindings }, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
        }
        const patch = mode === 'readset' ? { readSetDigest: contentHash('wrong readset') } : mode === 'foreign' ? { operationId: 'foreign-operation' } : mode === 'policy' ? { policyDigest: contentHash('wrong policy') } : { baselineSelectionRef: writeEvidence(f.input.source.commonDir, selection) }
        f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, ...patch }))
      } else if (mode === 'candidate' || mode === 'missing-owner') {
        const generated = wrappers.find(value => value.stage === 'generation'), value = JSON.parse(readEvidence(f.input.source.commonDir, generated.resultRef).toString())
        if (mode === 'candidate') value.candidate.digest = contentHash('foreign candidate')
        else { const index = value.validationFindings.findIndex((finding: { severity: string }) => finding.severity === 'error'); assert.ok(index >= 0); value.validationFindings[index] = { ...value.validationFindings[index], nodeId: 'foreign-owner', path: '.spec/foreign/spec.md' } }
        const resultRef = writeEvidence(f.input.source.commonDir, value); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...generated, resultRef }))
      } else {
        const aggregate = wrappers.find(value => value.stage === 'elaboration'), value = JSON.parse(readEvidence(f.input.source.commonDir, aggregate.resultRef).toString()) as ElaborationResult
        const owner = value.partitionEvidence!.find(owner => owner.resultRef.sha256 === local.resultRef.sha256)!
        if (mode === 'wrong-ref') owner.resultRef = value.partitionEvidence!.find(item => item.resultRef.sha256 !== owner.resultRef.sha256)!.resultRef
        else if (mode === 'unaffected-ref') value.partitionEvidence!.find(item => item.resultRef.sha256 !== owner.resultRef.sha256)!.resultRef = owner.resultRef
        else {
          const changed = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()); changed.inputDigest = contentHash('wrong original input')
          owner.resultRef = writeEvidence(f.input.source.commonDir, changed); f.store.checkpoint(fence, owner.resultRef)
          f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, resultRef: owner.resultRef }))
        }
        const resultRef = writeEvidence(f.input.source.commonDir, value); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...aggregate, resultRef }))
      }
    }
    const failed = recordFailure(fence, issue)
    if (missingOwner && before.number === 3) missingOwnerOriginal = f.store.readAttempt(fence.attemptId)
    if (before.number === 1) {
      const saved = f.store.readAttempt(fence.attemptId); immutable = { refs: saved.checkpointRefs, failure: saved.failure, dispatchPlans: saved.dispatchPlans }
      if (pending && !sibling && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id)
        const broken = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        recordFailure(broken.fence, { code: 'readonly_spec_repair_binding', message: '旧版本不识别prose定位，未派发owner', kind: 'unsupported', evidenceRefs: [] })
        f.store.requestControl(operation.id, 'pause'); f.store.requestControl(operation.id, 'run')
        const resumed = f.store.readOperation(operation.id), repeated = claim({ operationId: resumed.id, source: resumed.input.source, scope: resumed.scope, leaseMs: 30000, expectedRevision: resumed.revision, continuation: true })
        // 模拟旧版本已落盘的同候选重复审查；它不是新业务授权或本次真实Native执行证明。
        const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
        for (const name of ['analysis', 'partition-plan', 'elaboration', 'generation']) {
          const original = wrappers.find(value => value.stage === name)
          let resultRef = original.resultRef
          if (name === 'generation') {
            const generated = JSON.parse(readEvidence(f.input.source.commonDir, resultRef).toString())
            generated.status = 'failed'; generated.failure = { code: 'failed', message: '旧版本原生失败；同owner后续复审为空发现' }
            generated.review = null
            generated.partitionEvidence = generated.partitionEvidence.map((evidence: { review: object }) => ({ ...evidence, review: { ...evidence.review, verdict: 'accept', findings: [] } }))
            resultRef = writeEvidence(f.input.source.commonDir, generated)
          }
          f.store.checkpoint(repeated.fence, resultRef)
          f.store.checkpoint(repeated.fence, writeEvidence(f.input.source.commonDir, { ...original, resultRef, attemptId: repeated.attempt.id, readSetDigest: repeated.operation.readSetDigest, baselineSelectionRef: writeEvidence(f.input.source.commonDir, repeated.operation.baselineSelection) }))
        }
        recordFailure(repeated.fence, { code: 'failed', message: '旧版本原生失败未处理原prose反馈', kind: 'repairable', evidenceRefs: [] })
      }
      if (mode === 'review-resume' && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id), cloned = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
        const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
        const repair = { repairContext: { previousOutput: generated.output, diagnostics: [{ code: issue.code, message: issue.message }, ...generated.validationFindings.map((item: { code: string; message: string }) => ({ code: item.code, message: item.message })), ...generated.review.findings.map((item: { kind: string }) => ({ code: item.kind, message: JSON.stringify(item) }))] } }
        const resultRef = writeEvidence(f.input.source.commonDir, repair); f.store.checkpoint(cloned.fence, resultRef)
        f.store.checkpoint(cloned.fence, writeEvidence(f.input.source.commonDir, { ...wrapper, attemptId: cloned.attempt.id, stage: 'repair-input', resultRef }))
        f.store.requestControl(operation.id, 'pause')
        f.store.requestControl(operation.id, 'run')
      }
      if (aggregateOnly && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id), cloned = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
        for (const name of ['analysis', 'partition-plan', 'elaboration', 'generation']) {
          const original = wrappers.find(value => value.stage === name)
          f.store.checkpoint(cloned.fence, original.resultRef)
          f.store.checkpoint(cloned.fence, writeEvidence(f.input.source.commonDir, { ...original, attemptId: cloned.attempt.id, readSetDigest: cloned.operation.readSetDigest, baselineSelectionRef: writeEvidence(f.input.source.commonDir, cloned.operation.baselineSelection) }))
        }
        recordFailure(cloned.fence, issue)
      }
    }
    return failed
  }
  f.store.claimQueuedAttempt = input => { if (f.store.listAttempts(f.operation.id).length >= (lineage ? 6 : formatInterleaved ? 4 : reuseRepair ? 4 : unchanged || invalidBase || sibling ? 5 : pending || aggregateOnly || mode === 'review-resume' || mode === 'review-rebind-native' ? 4 : 3)) throw new Error('fixture仅阻止旧实现无限零调用热循环'); return claim(input) }
  const countCandidateHistory = mode === 'existing' || mode === 'review-accepted-reuse'
  const candidateHistory = { windows: 0, fullClones: 0, indexClones: new Map<string, number>() }
  if (countCandidateHistory) {
    const checkpoint = f.store.checkpoint.bind(f.store), clone = globalThis.structuredClone
    let reviewAttemptId: string | null = null
    f.store.checkpoint = (fence, ref) => {
      const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }
      const saved = checkpoint(fence, ref)
      if (wrapper.stage === 'partition-generation-budget') { reviewAttemptId = fence.attemptId; candidateHistory.windows++ }
      if (wrapper.stage === 'generation') reviewAttemptId = null
      return saved
    }
    t.mock.method(globalThis, 'structuredClone', (value: unknown, options?: Parameters<typeof clone>[1]): unknown => {
      const checkpoint = value as { json?: { value?: { version?: string; attemptId?: string } }[]; raw?: unknown } | null
      const entries = Array.isArray(value) ? value as NonNullable<typeof checkpoint>['json'] : checkpoint?.json
      const prior = entries?.find(entry => entry.value?.version === 'sync-stage-v1')?.value?.attemptId
      if (reviewAttemptId && prior && prior !== reviewAttemptId) {
        if (checkpoint?.raw instanceof Map) candidateHistory.fullClones++
        else if (Array.isArray(value)) { const key = `${reviewAttemptId}:${prior}`; candidateHistory.indexClones.set(key, (candidateHistory.indexClones.get(key) ?? 0) + 1) }
      }
      return clone(value, options)
    })
  }
  const settlement = { attemptId: '', fullClones: 0, indexClones: 0 }
  if (settleFailureOnly) {
    const checkpoint = f.store.checkpoint.bind(f.store), finish = f.store.recordFailure, clone = globalThis.structuredClone
    f.store.checkpoint = (fence, ref) => {
      const saved = checkpoint(fence, ref)
      if (JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage === 'generation') settlement.attemptId = fence.attemptId
      return saved
    }
    f.store.recordFailure = (fence, issue) => {
      settlement.attemptId = ''
      const result = finish(fence, issue)
      f.store.requestControl(f.operation.id, 'pause')
      return result
    }
    t.mock.method(globalThis, 'structuredClone', (value: unknown, options?: Parameters<typeof clone>[1]): unknown => {
      const checkpoint = value as { json?: { value?: { version?: string; attemptId?: string } }[]; raw?: unknown } | null
      const entries = Array.isArray(value) ? value as NonNullable<typeof checkpoint>['json'] : checkpoint?.json
      if (settlement.attemptId && entries?.some(entry => entry.value?.version === 'sync-stage-v1' && entry.value.attemptId === settlement.attemptId)) {
        if (checkpoint?.raw instanceof Map) settlement.fullClones++
        else if (Array.isArray(value)) settlement.indexClones++
      }
      return clone(value, options)
    })
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  if (settleFailureOnly) {
    t.diagnostic(JSON.stringify(settlement))
    assert.equal(f.store.readOperation(f.operation.id).phase, 'paused')
    assert.equal(f.store.readOperation(f.operation.id).control, 'pause')
    assert.equal(reviewCalls.length, 6)
    assert.equal(f.store.listAttempts(f.operation.id).length, 1)
    assert.deepEqual(f.store.listRecoverableResources(), [])
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.equal(settlement.fullClones, 0, '候选失败收尾只读取阶段索引')
    assert.equal(settlement.indexClones, 1, '同次失败内各组共享阶段索引')
    return
  }
  if (countCandidateHistory) {
    const maximumIndexClones = Math.max(0, ...candidateHistory.indexClones.values())
    t.diagnostic(JSON.stringify({ candidateHistory: { windows: candidateHistory.windows, fullClones: candidateHistory.fullClones, maximumIndexClones } }))
    assert.ok(candidateHistory.windows > 1, '真实多attempt候选路径必须被执行')
    assert.equal(candidateHistory.fullClones, 0, '候选来源不能逐owner克隆终结attempt的完整历史')
    assert.ok(maximumIndexClones <= 1, '同一当前attempt跨owner共用原历史索引')
  }
  const terminalDiagnostics = formatInterleaved ? (() => {
    const attempts = f.store.listAttempts(f.operation.id), wrappers = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
    const a = wrappers[1]?.find(stage => stage.stage?.endsWith(':candidate-review') && !wrappers[0].some(before => before.stage === stage.stage && before.resultRef.sha256 === stage.resultRef.sha256) && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
    return { status: result.status, failure: result.failure, leaseMs: f.options.leaseMs, heartbeatMs: f.options.heartbeatMs, maximumRenewalGapMs: Math.max(0, ...renewals.slice(1).flatMap((item, index) => item.attemptId === renewals[index].attemptId ? [item.at - renewals[index].at] : [])), sinceLastRenewalMs: renewals.length ? Date.now() - renewals.at(-1)!.at : null,
      aStage: a?.stage, missingAttemptNumber: a ? attempts.find((attempt, index) => index >= 2 && !wrappers[index].some(stage => stage.stage === a.stage))?.number ?? null : null,
      attempts: attempts.map((attempt, index) => ({ number: attempt.number, status: attempt.status, failure: attempt.failure, expiresAtMs: attempt.expiresAtMs, stageKeys: wrappers[index].map(stage => stage.stage), aResultRef: a ? wrappers[index].find(stage => stage.stage === a.stage)?.resultRef ?? null : null })), reviewCalls }
  })() : null
  if (formatInterleaved) t.diagnostic(JSON.stringify({ interleavedTerminal: terminalDiagnostics }))
  if (formatContinuation) {
    if (formatFinite) {
      assert.equal(reviewCalls.filter(call => call.attempt === 1).length, 6)
      assert.equal(reviewCalls.filter(call => call.attempt === 2).length, formatRemaining, '剩1次时只派失败组；剩0时原预算拒绝')
      assert.equal(ownerCalls.filter(call => call.attempt > 1).length, 0)
      assert.equal(result.operation.callsUsed, 30 + formatRemaining)
      if (formatRemaining) {
        const second = f.store.listAttempts(f.operation.id)[1], values = second.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
        const budget = JSON.parse(readEvidence(f.input.source.commonDir, values.find(value => value.stage === 'partition-generation-budget').resultRef).toString())
        assert.equal(budget.minimumCalls, 1); assert.equal(budget.remainingCalls, 1)
        assert.equal(values.filter(value => value.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).reviewPassed).length, 5)
      } else assert.equal(result.status, 'budget_exhausted')
      assert.equal(f.store.listJournals(f.operation.id).length, 0)
      return
    }
    assert.equal(reviewCalls.filter(call => call.attempt === 1).length, 6)
    assert.equal(reviewCalls.filter(call => call.attempt === 2).length, formatInterleaved ? 2 : 1, '仅失败组新派发')
    assert.equal(reviewCalls.filter(call => call.attempt === 3).length, 1, '带原final诊断的重试再次格式失败，仍仅同组续修')
    if (formatInterleaved) assert.equal(reviewCalls.filter(call => call.attempt === 4).length, 1, 'A已经跨轮承接仍保诊断输入，仅B新派发')
    assert.equal(ownerCalls.filter(call => call.attempt > 1).length, 0, '格式故障不能重派无关P1')
    const attempts = f.store.listAttempts(f.operation.id), wrappers = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
    const accepted = wrappers[0].filter(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
    assert.equal(accepted.length, formatInterleaved ? 4 : 5)
    if (formatInterleaved) {
      const a = wrappers[1].find(stage => stage.stage?.endsWith(':candidate-review') && !wrappers[0].some(before => before.stage === stage.stage && before.resultRef.sha256 === stage.resultRef.sha256) && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
      assert.ok(a)
      for (const values of wrappers.slice(2)) assert.deepEqual(values.find(stage => stage.stage === a.stage)?.resultRef, a.resultRef, `A原accept/ref/请求不重签；${JSON.stringify(terminalDiagnostics)}`)
      assert.equal(result.status, 'unsupported', JSON.stringify(terminalDiagnostics))
      assert.equal(result.failure?.code, 'unsupported', JSON.stringify(terminalDiagnostics))
      assert.equal(result.failure?.message, '目标多轮续审已证，在Docker前停止', JSON.stringify(terminalDiagnostics))
      assert.ok(attempts.every(attempt => ['failed', 'superseded', 'settled'].includes(attempt.status)), JSON.stringify(terminalDiagnostics))
      assert.deepEqual(f.store.listRecoverableResources(), [], JSON.stringify(terminalDiagnostics))
    }
    for (const saved of accepted) for (const values of wrappers.slice(1)) assert.deepEqual(values.find(stage => stage.stage === saved.stage)?.resultRef, saved.resultRef)
    for (const values of wrappers.slice(1)) {
      assert.deepEqual(values.find(stage => stage.stage === 'partition-plan').resultRef, wrappers[0].find(stage => stage.stage === 'partition-plan').resultRef)
      assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, values.find(stage => stage.stage === 'generation').resultRef).toString()).candidate, JSON.parse(readEvidence(f.input.source.commonDir, wrappers[0].find(stage => stage.stage === 'generation').resultRef).toString()).candidate, '诊断seed不能替换业务candidate')
    }
    const failed = wrappers[0].find(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).failure)
    const candidate = JSON.parse(readEvidence(f.input.source.commonDir, failed.resultRef).toString()).candidate
    const plan = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[0].find(stage => stage.stage === 'candidate-partition-plan').resultRef).toString())
    const value = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[0].find(stage => stage.stage === `${failed.stage}:input`).resultRef).toString())
    const input = restoreGenerationInput(value), operation = f.store.readOperation(f.operation.id)
    const history = new WeakMap<SyncAttempt, ReturnType<typeof readSyncCheckpointStageIndex>>()
    const readIndex = (origin: SyncAttempt) => { const view = history.get(origin) ?? readSyncCheckpointStageIndex(f.store, operation, origin); history.set(origin, view); return view }
    const proof = (current = operation, origin = attempts[0], selected = plan, supplied = input) => continuationCoordinator.failedCandidateReviewSource(f.store, current, origin, failed.stage, candidate, selected, supplied, readIndex)
    const refs = proof(); assert.ok(refs, '首次P1合法null扩域保原wrapper/digest及真实Native原件')
    assert.deepEqual(refs, continuationCoordinator.failedCandidateReviewSource(f.store, operation, attempts[0], failed.stage, candidate, plan, input), '紧凑视图与原完整读取返回同一失败原件')
    assert.equal(proof({ ...operation, readSetDigest: contentHash('foreign-readset') }), null)
    assert.equal(proof({ ...operation, scope: { ...operation.scope, paths: [...operation.scope.paths, 'foreign-path'] } }), null)
    assert.equal(proof({ ...operation, scope: { ...operation.scope, contractIds: [...operation.scope.contractIds, 'REQ-FOREIGN'] } }), null)
    assert.equal(proof(operation, { ...attempts[0], composedInput: { ...attempts[0].composedInput!, tree: 'a'.repeat(40) } }), null)
    assert.equal(proof(operation, attempts[0], { ...plan, digest: 'foreign-plan' }), null)
    assert.equal(proof(operation, attempts[0], plan, { ...input, intent: { ...input.intent, rawSource: 'another-intent' } }), null)
    assert.equal(proof(operation, attempts[0], plan, { ...input, model: 'gpt-6.1-terra' }), null)
    assert.throws(() => proof({ ...operation, policyDigest: 'foreign-policy' }))
    assert.throws(() => proof({ ...operation, input: { ...operation.input, id: 'foreign-input' } }))
    const expansion = operation.contractScopeExpansions!.find(item => item.previousBaselineSelectionDigest !== item.baselineSelectionDigest)!
    assert.equal(proof({ ...operation, contractScopeExpansions: operation.contractScopeExpansions!.map(item => item === expansion ? { ...item, evidenceRef: { sha256: 'b'.repeat(64) } } : item) }), null, '扩域必须来自同一已审P1')
    const alteredSelection = structuredClone(operation.baselineSelection!)
    const added = alteredSelection.bindings.find(binding => binding.resource.kind === 'contract')!
    assert.ok('intentPair' in added)
    added.intentPair = { id: 'foreign-pair', repositoryId: f.input.source.repositoryId, source: f.input.source, sourceInput: f.input, verifiedDelivery: f.input, coveredScope: operation.scope, receiptId: 'foreign-receipt', settledAtMs: 0 }
    alteredSelection.digest = contentHash(JSON.stringify({ version: alteredSelection.version, source: alteredSelection.source, bindings: alteredSelection.bindings }, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
    assert.equal(proof({ ...operation, baselineSelection: alteredSelection }), null, '新增非null基线不得借格式续审承接')
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, refs.checkpointRef).toString()) as NativeRunCheckpoint
    assert.equal(checkpoint.failure!.rejectedOutput!.ref, undefined, '原ref缺席不得补签')
    const find = f.store.findResource.bind(f.store), key = input.requestKey + ':code_review', resource = find(attempts[0].id, key)!
    for (const patch of [{ phase: 'terminal' as const }, { checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, stop: { ...checkpoint.stop, nativeStopped: false } }) }, { checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, failure: { ...checkpoint.failure, rejectedOutput: { ...checkpoint.failure!.rejectedOutput, threadId: 'foreign-owner' } } }) }]) {
      f.store.findResource = (attemptId, requestKey) => attemptId === attempts[0].id && requestKey === key ? { ...resource, ...patch } : find(attemptId, requestKey)
      if ('checkpointRef' in patch && JSON.parse(readEvidence(f.input.source.commonDir, patch.checkpointRef!).toString()).failure?.rejectedOutput?.threadId === 'foreign-owner') assert.throws(() => proof(), { code: 'checkpoint_artifact_binding', message: 'raw的原失败身份不匹配' }); else assert.equal(proof(), null, '未知停止或跨owner原文不能取得诊断权限')
    }
    f.store.findResource = find
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    return
  }
  if (reuse) {
    const failedKey = reviewCalls.find(call => call.attempt === 3)?.key
    assert.ok(failedKey)
    assert.equal(reviewCalls.filter(call => call.attempt === 1).length, 4)
    assert.equal(reviewCalls.filter(call => call.attempt === 2).length, 4, '首轮无repairContext，不能仅凭candidate复用')
    assert.deepEqual(reviewCalls.filter(call => call.attempt === 3).map(call => call.key), [failedKey], '精确同输入后仅失败分区重新独审')
    assert.deepEqual(ownerCalls.filter(call => call.attempt > 1).map(({ attempt, nodeId, purpose }) => [attempt, nodeId, purpose]), reuseRepair ? [[4, badOwner.nodeId, 'elaboration_generate'], [4, badOwner.nodeId, 'elaboration_review']] : [], '历史accept来源不妨碍本轮真实repair回到唯一owner')
    assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
    const attempts = f.store.listAttempts(f.operation.id)
    const wrappers = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
    for (const values of wrappers) {
      const generation = values.find(stage => stage.stage === 'generation')
      if (!generation) continue
      const result = JSON.parse(readEvidence(f.input.source.commonDir, generation.resultRef).toString())
      assert.equal(result.candidateValidated, true)
      assert.deepEqual(readTree(f.input.source.commonDir, result.candidate.tree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects, '实际候选源码/tests path-mode-OID-absence不变')
    }
    for (const values of wrappers.slice(1)) assert.deepEqual(values.find(stage => stage.stage === 'partition-plan')?.resultRef, wrappers[0].find(stage => stage.stage === 'partition-plan').resultRef, '普通P2失败沿原已审P1分区计划，不能把局部analysis重建为whole')
    const accepted = wrappers[1].filter(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
    assert.equal(accepted.length, 3)
    for (const saved of accepted) {
      assert.deepEqual(wrappers[2].find(stage => stage.stage === saved.stage)?.resultRef, saved.resultRef)
      assert.equal(wrappers[2].find(stage => stage.stage === `${saved.stage}:provenance`)?.resultRef !== undefined, true)
    }
    assert.equal(result.operation.callsUsed, f.calls.length, '复用不记假调用')
    if (!reuseRepair) {
      const saved = accepted[0], sourceAttempt = attempts[1], candidate = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()).candidate
      const plan = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[1].find(stage => stage.stage === 'candidate-partition-plan').resultRef).toString())
      const key = `sync:${sourceAttempt.id}:generation:final:${saved.stage.slice('partition:'.length, -':candidate-review'.length)}:code_review`
      const request = f.calls.find(call => call.requestKey === key)!
      type Input = import('./generation-types.js').GenerationInput
      const serialized = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as Omit<Input, 'files'> & { files: [string, string][]; manifestProjection?: unknown; completeManifestDigest?: string }
      const { manifestProjection: _projection, completeManifestDigest: _digest, ...context } = serialized
      const input: Input = { ...context, files: new Map(context.files), manifest: { version: 1, entries: readTree(f.input.source.commonDir, context.composed?.tree ?? context.snapshot.immutableTree) }, priorContext: context.priorContext?.map(prior => ({ ...prior, files: new Map(prior.files) })) }
      const operation = f.store.readOperation(f.operation.id)
      const history = new WeakMap<SyncAttempt, ReturnType<typeof readSyncCheckpointStageIndex>>()
      const readIndex = (source: SyncAttempt) => { const view = history.get(source) ?? readSyncCheckpointStageIndex(f.store, operation, source); history.set(source, view); return view }
      const proof = (value = input, source = sourceAttempt, current = operation, selected = plan, actual = candidate) => acceptedCandidateReviewSource(f.store, current, source, saved.stage, actual, selected, value, readIndex)
      assert.ok(proof(), '原真实checkpoint/request/dispatch/ref资格可重现')
      assert.deepEqual(proof(), acceptedCandidateReviewSource(f.store, operation, sourceAttempt, saved.stage, candidate, plan, input), '紧凑视图与原完整读取返回同一接受来源')
      for (const patch of [{ intent: { ...input.intent, rawSource: input.intent.rawSource + '变更' } }, { facts: [...input.facts, { source: 'code:src/export.js', text: '不同上下文' }] }, { repairContext: undefined }, { model: 'gpt-6.1-terra' }, { timeoutMs: (input.timeoutMs === null ? 1000 : input.timeoutMs + 1) }]) assert.equal(proof({ ...input, ...patch }), null)
      assert.equal(proof(input, sourceAttempt, operation, { ...plan, digest: 'other-plan' }), null)
      assert.equal(proof(input, sourceAttempt, operation, plan, { ...candidate, coveredScope: { ...candidate.coveredScope, paths: [] } }), null)
      assert.equal(proof(input, sourceAttempt, { ...operation, readSetDigest: 'other-readset' }), null)
      assert.equal(proof(input, sourceAttempt, { ...operation, baselineSelection: { ...operation.baselineSelection!, digest: 'other-selection' } }), null)
      assert.throws(() => proof(input, sourceAttempt, { ...operation, policyDigest: 'other-policy' }))
      assert.throws(() => proof(input, sourceAttempt, { ...operation, id: 'other-operation' }))
      for (const variant of ['source-result', 'trace', 'request', 'schema', 'prompt']) {
        const stage = variant === 'request' || variant === 'schema' || variant === 'prompt' ? wrappers[1].find(stage => stage.stage === `injected:${key}`) : saved
        const original = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()), modified = structuredClone(original)
        if (variant === 'source-result') modified.reviewPassed = false
        else if (variant === 'trace') modified.traces[0].threadId = 'foreign-thread'
        else if (variant === 'schema' || variant === 'prompt') {
          const { signal: _signal, ...payload } = request
          modified.requestDigest = contentHash(JSON.stringify(variant === 'schema' ? { ...payload, schema: { ...payload.schema, description: '不同schema' } } : { ...payload, prompt: payload.prompt + '不同prompt' }))
        } else modified.requestDigest = contentHash(variant)
        const changed = writeEvidence(f.input.source.commonDir, { ...stage, resultRef: writeEvidence(f.input.source.commonDir, modified) })
        const source = { ...sourceAttempt, checkpointRefs: [...sourceAttempt.checkpointRefs, changed], dispatchPlans: sourceAttempt.dispatchPlans.map(dispatch => (variant === 'schema' || variant === 'prompt') && dispatch.key === key ? { ...dispatch, requestDigest: modified.requestDigest } : dispatch) }
        assert.equal(proof(input, source), null, variant)
      }
      assert.equal(proof(input, { ...sourceAttempt, status: 'running' }), null, '未结算来源不得承接')
      const cachedAttempt = attempts[2], provenanceStage = wrappers[2].find(stage => stage.stage === `${saved.stage}:provenance`)
      const originalProvenance = JSON.parse(readEvidence(f.input.source.commonDir, provenanceStage.resultRef).toString())
      assert.ok(proof(input, cachedAttempt), '冷态拷贝仍完整重验输入及请求')
      for (const variant of ['missing-input', 'forged-input']) {
        const provenance = structuredClone(originalProvenance)
        if (variant === 'missing-input') delete provenance.inputRef
        else {
          const value = JSON.parse(readEvidence(f.input.source.commonDir, provenance.inputRef).toString()); value.facts.push({ source: 'code:src/export.js', text: '伪输入' }); provenance.inputRef = writeEvidence(f.input.source.commonDir, value)
        }
        const changed = writeEvidence(f.input.source.commonDir, { ...provenanceStage, resultRef: writeEvidence(f.input.source.commonDir, provenance) })
        assert.equal(proof(input, { ...cachedAttempt, checkpointRefs: [...cachedAttempt.checkpointRefs, changed] }), null, variant)
      }
      const { signal: _signal, ...payload } = request
      const originalFind = f.store.findResource.bind(f.store), dispatch = sourceAttempt.dispatchPlans.find(dispatch => dispatch.key === key)!
      const injected = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[1].find(stage => stage.stage === `injected:${key}`).resultRef).toString())
      for (const frozen of [false, true]) {
        const nativeRequest = frozen ? prepareFrozenPrompt({ ...payload, frozenEntries: [{ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8' as const, text: payload.prompt }] }, { directory: join(f.root, '..', 'review-context'), binding: { attemptId: sourceAttempt.id, policyDigest: operation.policyDigest } }) : payload
        const requestDigest = contentHash(JSON.stringify(nativeRequest)), identity = { operationId: operation.id, attemptId: sourceAttempt.id, inputId: operation.input.id, candidateDigest: candidate.digest }
        const native: NativeRunPlan = { schemaVersion: 1, ...identity, request: nativeRequest, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: injected.result.sessionId }
        const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId: injected.result.sessionId, phase: 'removed', nativeCallRequested: true, nativeStarted: true, nativeState: 'completed', status: 'completed', session: dispatch.session!, result: injected.result }
        const checkpointRef = writeEvidence(f.input.source.commonDir, checkpoint)
        const resource: import('./operation-types.js').SyncResourceRecord = { id: 'fixture-native-proof', operationId: operation.id, attemptId: sourceAttempt.id, generation: sourceAttempt.generation, phase: 'removed', checkpointRef, checkpoints: [], createdAtMs: 1, updatedAtMs: 1, plan: { key, kind: 'native_session', ...identity, payloadDigest: requestDigest, planBlob: writeEvidence(f.input.source.commonDir, native), checkpointRef } }
        f.store.findResource = (attemptId, requestKey) => attemptId === sourceAttempt.id && requestKey === key ? resource : originalFind(attemptId, requestKey)
        const source = { ...sourceAttempt, dispatchPlans: sourceAttempt.dispatchPlans.map(current => current.key === key ? { ...current, requestDigest } : current) }
        assert.ok(proof(input, source), frozen ? '冻结task原字节及完整原生payload绑定' : 'inline完整原生payload绑定')
        resource.phase = 'planned'; assert.equal(proof(input, source), null, '未结算Native资源不得复用'); resource.phase = 'removed'
        resource.plan.planBlob = writeEvidence(f.input.source.commonDir, { ...native, request: { ...native.request, prompt: native.request.prompt + '外来正文' } })
        assert.equal(proof(input, source), null, '原生完整payload变化拒绝')
        if (frozen) {
          const forged = prepareFrozenPrompt({ ...payload, prompt: payload.prompt + '外来任务', frozenEntries: [{ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8' as const, text: payload.prompt + '外来任务' }] }, { directory: join(f.root, '..', 'review-context-forged'), binding: { attemptId: sourceAttempt.id, policyDigest: operation.policyDigest } })
          const digest = contentHash(JSON.stringify(forged))
          resource.plan.planBlob = writeEvidence(f.input.source.commonDir, { ...native, request: forged, requestDigest: digest }); resource.plan.payloadDigest = digest
          resource.checkpointRef = writeEvidence(f.input.source.commonDir, { ...checkpoint, requestDigest: digest })
          assert.equal(proof(input, { ...sourceAttempt, dispatchPlans: sourceAttempt.dispatchPlans.map(current => current.key === key ? { ...current, requestDigest: digest } : current) }), null, '完整payload及dispatch相符仍拒绝伪task SHA')
        }
      }
      f.store.findResource = originalFind
    }
    return
  }
  if (crossSource) { assert.equal(result.failure?.code, 'readonly_spec_repair_binding'); assert.equal(f.store.listAttempts(f.operation.id).length, 4); assert.equal(ownerCalls.some(call => call.attempt === 4), false); return }
  if (missingOwner) {
    assert.equal(result.status, 'unsupported')
    assert.equal(result.failure?.code, 'checkpoint_artifact_binding')
    assert.match(result.failure!.message, /聚合rounds必须是原partitionEvidence局部结果的精确有序并集/)
    const attempts = f.store.listAttempts(f.operation.id)
    assert.equal(attempts.length, 3, '缺失聚合owner在领取A4前强认证拒绝')
    assert.equal(ownerCalls.some(call => call.attempt >= 4), false)
    assert.deepEqual(attempts[0].checkpointRefs, immutable!.refs); assert.deepEqual(attempts[0].failure, immutable!.failure); assert.deepEqual(attempts[0].dispatchPlans, immutable!.dispatchPlans)
    assert.deepEqual(attempts[2].checkpointRefs, missingOwnerOriginal!.checkpointRefs); assert.deepEqual(attempts[2].failure, missingOwnerOriginal!.failure); assert.deepEqual(attempts[2].dispatchPlans, missingOwnerOriginal!.dispatchPlans, '当前拒绝不改签损坏A3原件或新增dispatch')
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    return
  }
  if (invalidBase) { assert.equal(result.failure?.code, 'readonly_spec_repair_binding'); assert.equal(f.store.listAttempts(f.operation.id).length, 5); assert.equal(ownerCalls.some(call => call.attempt === 5), false); return }
  if (['wrong-ref', 'unaffected-ref', 'input-digest'].includes(mode)) {
    assert.equal(result.status, 'unsupported')
    assert.equal(result.failure?.code, 'checkpoint_artifact_binding')
    assert.match(result.failure!.message, mode === 'input-digest' ? /聚合诊断必须保留原局部身份或精确重算全局输入/ : /聚合rounds必须是原partitionEvidence局部结果的精确有序并集/)
    const attempts = f.store.listAttempts(f.operation.id)
    assert.equal(attempts.length, 1, '损坏原件在领取下一attempt前强认证拒绝')
    assert.equal(ownerCalls.filter(call => call.attempt > 1).length, 0)
    assert.deepEqual(attempts[0].checkpointRefs, immutable!.refs); assert.deepEqual(attempts[0].failure, immutable!.failure, '本次拒因不能改签旧持久failure')
    assert.deepEqual(attempts[0].dispatchPlans, immutable!.dispatchPlans, '强认证拒绝不派发新Native任务')
    assert.equal(attempts[0].failure?.code, 'generation_failed')
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    return
  }
  if (negative) { assert.equal(finalReview, false); assert.equal(f.store.listAttempts(f.operation.id).length, 2); assert.equal(ownerCalls.filter(call => call.attempt > 1).length, 0); assert.notEqual(result.failure?.kind, 'repairable', JSON.stringify(result.failure)); assert.ok(['failed', 'unsupported'].includes(result.status), JSON.stringify(result.failure)); return }
  assert.ok(finalReview, JSON.stringify({ failure: result.failure, calls: ownerCalls, failures: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  const second = pending ? 4 : aggregateOnly || mode === 'review-resume' ? 3 : 2
  for (const owner of badOwners) assert.deepEqual(ownerCalls.filter(call => call.attempt > 1 && call.nodeId === owner.nodeId).map(({ attempt, purpose }) => [attempt, purpose]), mixedCitations ? [[2, 'elaboration_generate'], [3, 'elaboration_generate'], [3, 'elaboration_review']] : partial ? [[second, 'elaboration_generate'], [second, 'elaboration_review']] : lineage ? [[4, 'elaboration_generate'], [4, 'elaboration_review'], [5, 'elaboration_generate'], [5, 'elaboration_review']] : pending || mode === 'review-p1-fail' && owner !== badOwner ? [[second, 'elaboration_generate'], [second, 'elaboration_review']] : [[second, 'elaboration_generate'], [second, 'elaboration_review'], [mode === 'review-rebind-native' ? 4 : second + 1, 'elaboration_generate'], [mode === 'review-rebind-native' ? 4 : second + 1, 'elaboration_review']])
  const attempts = f.store.listAttempts(f.operation.id)
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  for (const values of stages.slice(1)) {
    const plan = values.find(stage => stage.stage === 'partition-plan')
    if (plan) assert.deepEqual(plan.resultRef, stages[0].find(stage => stage.stage === 'partition-plan').resultRef, '已审whole后普通P2失败仍保原局部plan/analysis身份')
  }
  for (const source of stages[0].filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))) {
    const prior = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    if (prior.changes.some(change => badOwners.some(owner => owner.nodeId === change.nodeId))) continue
    for (const current of stages.slice(second - 1)) {
      const local = current.find(stage => stage.stage === source.stage)
      const aggregate = current.find(stage => stage.stage === 'elaboration')
      const owner = aggregate && (JSON.parse(readEvidence(f.input.source.commonDir, aggregate.resultRef).toString()) as ElaborationResult).partitionEvidence?.find(owner => source.stage === `partition:${owner.partitionId}:elaboration`)
      const latestSibling = sibling && prior.changes.some(change => change.nodeId === definitions[2].nodeId) ? stages[2].find(stage => stage.stage === source.stage).resultRef : source.resultRef
      assert.deepEqual(local?.resultRef ?? owner?.resultRef, latestSibling)
    }
  }
  if (mode === 'review-p1-fail') {
    const owner = stages[1].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwners[0].nodeId))
    assert.ok(owner)
    assert.deepEqual(stages[2].find(stage => stage.stage === owner.stage).resultRef, owner.resultRef, '兄弟P1失败不丢弃本轮已新独审owner')
  }
  const generations = stages.map(values => { const saved = values.find(stage => stage.stage === 'generation'); return saved ? JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) : null })
  assert.ok(generations.filter(Boolean).every(value => Array.isArray(value.p2SpecWritePaths) && value.p2SpecWritePaths.length === 0), 'Spec-only权限由宿主dispatch投影为空，不能借用P2 writer')
  if (semantic) {
    for (const generated of [generations[0], pending || partial ? null : mode === 'review-rebind-native' ? generations[2] : generations[second - 1]].filter(Boolean)) { assert.equal(generated.candidateValidated, true); assert.ok(generated.partitionEvidence.some((evidence: { review: { verdict: string } }) => evidence.review.verdict === 'repair')) }
  } else {
    if (mixedCitations) {
      const findings = generations[0].validationFindings as { code: string; citation?: { origin: string; ref: string } }[]
      assert.ok(findings.some(finding => finding.code === 'related-file-missing' && finding.citation?.ref === 'tests/missing-related.test.mjs'))
      assert.ok(findings.some(finding => finding.code === 'anchor-dead' && finding.citation?.origin === 'source'))
      const failed = JSON.parse(readEvidence(f.input.source.commonDir, attempts[1].failure!.evidenceRefs[0]).toString()) as ElaborationResult
      assert.ok(failed.rounds.some(round => round.findings.some(issue => issue.code === 'rows_patch' && issue.message.includes('保留标题、描述'))))
      assert.equal(generations[1], null, '越权引用草稿在独审和V1前拒绝')
      assert.equal(generations.at(-1).candidateValidated, true)
    } else assert.ok(generations[second - 1].validationFindings.some((finding: { code: string }) => finding.code === 'anchor-dead'), 'agent实际修过但未修好仍可下一轮')
    assert.ok(generations[0].validationFindings.some((finding: { code: string }) => finding.code === 'anchor-dead'))
  }
  if (partial) {
    assert.equal(generations[0].status, 'failed'); assert.ok(generations[0].failure)
    assert.equal(generations[0].review, null)
    assert.equal(generations[0].partitionEvidence.flatMap((part: { review: { findings: unknown[] } }) => part.review.findings).length, 3)
    const failed = stages[0].filter(stage => stage.stage?.endsWith(':candidate-review')).map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString())).find(result => result.failure)
    assert.ok(failed); assert.equal(failed.review, null); assert.equal(failed.reviewPassed, false, '失败区不得伪装成已审accept')
    const input = JSON.parse(readEvidence(f.input.source.commonDir, stages[1].find(stage => stage.stage === 'repair-input').resultRef).toString())
    assert.equal(input.readonlyOwnerRepair.reviewEvidence.length, 1)
  }
  if (sibling) {
    const payload = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === 'repair-input').resultRef).toString())
    assert.deepEqual(payload.readonlyBaseRef, stages[2].find(stage => stage.stage === 'elaboration').resultRef)
    assert.deepEqual(payload.readonlyOwnerRepair.priorRef, stages[0].find(stage => stage.stage === 'elaboration').resultRef)
    assert.notEqual(payload.readonlyBaseRef.sha256, payload.readonlyOwnerRepair.priorRef.sha256, '执行base与原source分别绑定，不改旧priorRef')
    assert.deepEqual(stages[4].find(stage => stage.stage === 'elaboration').resultRef, stages[3].find(stage => stage.stage === 'elaboration').resultRef)
    assert.deepEqual(ownerCalls.filter(call => call.nodeId === definitions[2].nodeId && call.attempt > 1).map(call => [call.attempt, call.purpose]), [[3, 'elaboration_generate'], [3, 'elaboration_review']])
  }
  if (lineage) {
    assert.deepEqual(stages[5].find(stage => stage.stage === 'elaboration').resultRef, stages[4].find(stage => stage.stage === 'elaboration').resultRef)
    assert.equal(generations[5].candidate.digest, generations[0].candidate.digest)
    assert.equal(ownerCalls.some(call => call.attempt === 6), false, '合法lineage内A/O1和B/O2响应均可结算，不能只查current meta')
  }
  if (unchanged) {
    assert.deepEqual(stages[4].find(stage => stage.stage === 'elaboration').resultRef, stages[3].find(stage => stage.stage === 'elaboration').resultRef)
    assert.equal(generations[4].candidate.digest, generations[0].candidate.digest, 'fresh独立P1可确认critic误读而保持Spec正文同字节')
    assert.equal(ownerCalls.some(call => call.attempt === 5), false, '已明确响应source并纳入aggregate后不再派发')
  }
  if (rebinding) {
    assert.notEqual(stages[0].find(stage => stage.stage === 'generation').readSetDigest, stages[1].find(stage => stage.stage === 'generation').readSetDigest, '本轮新合法AC通过正式scope扩充改变readSet')
    assert.notEqual(stages[0].find(stage => stage.stage === 'generation').baselineSelectionRef.sha256, stages[1].find(stage => stage.stage === 'generation').baselineSelectionRef.sha256)
    if (mode === 'review-rebind-native') {
      assert.equal(generations[1].status, 'failed'); assert.equal(ownerCalls.some(call => call.attempt === 3), false, 'P2原生失败后新accepted whole仍需承接，不回旧P1')
      assert.deepEqual(stages[2].find(stage => stage.stage === 'elaboration').resultRef, stages[1].find(stage => stage.stage === 'elaboration').resultRef, 'P2原生失败后复用最新whole，不回旧owner refs')
    }
  }
  assert.equal(generations.at(-1).candidateValidated, true, '完整候选真实V1重跑通过')
  assert.deepEqual(readTree(f.input.source.commonDir, generations.at(-1).candidate.tree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
  assert.deepEqual(f.store.readAttempt(attempts[0].id).checkpointRefs, immutable!.refs); assert.deepEqual(f.store.readAttempt(attempts[0].id).failure, immutable!.failure)
  assert.ok(result.operation.baselineSelection!.bindings.length > f.operation.baselineSelection!.bindings.length, '覆盖P1 expandContractScope的null资源扩展')
  if (aggregateOnly || mode === 'review-resume') { assert.equal(attempts[1].dispatchPlans.length, 0); assert.equal(stages[1].some(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration')), false, '历史attempt只有aggregate引用') }
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(result.operation.deadlineAtMs, null); assert.deepEqual(result.operation.budget, { mode: 'unlimited' })
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('v2最终预算只列真实实现派发，纯父接口不产生虚构生成或独审键', async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01'
  const raw = '保留当前导出契约，由现有导出服务完成请求及结果下载。'
  const parentBefore = `---\ntitle: 导出上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const leafBefore = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const parentSource = `---\ntitle: 导出上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层声明原意，由现有服务承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留现有导出行为 | user:raw | 不改变原政策 | 既有导出流程及验收完成 | - |\n`
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 }, false, leafBefore, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'],
  }, undefined, 'spec', undefined, false, { [parentPath]: parentBefore })
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[] }
      if (frozen.targets[0].path === parentPath) {
        const parent = rows(parentSource, parentPath)
        parent.changes[0].nodeId = 'project'
        parent.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口不执行实现，各边界保留在现有服务契约中', affectedIds: [parentId] }))
        return parent
      }
      const child = rows(original)
      for (const row of child.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
      for (const row of child.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
      return child
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('本回归在真实Docker之前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, phase: result.operation.phase, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  const attempt = f.store.listAttempts(f.operation.id)[0]
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string; resultRef?: { sha256: string } }[]
  const planRef = stages.find(stage => stage.stage === 'candidate-partition-plan')!.resultRef!
  const plan = JSON.parse(readEvidence(f.input.source.commonDir, planRef).toString()) as { partitions: { id: string; targets: { path: string }[] }[] }
  const parent = plan.partitions.find(partition => partition.targets.some(target => target.path === parentPath))!
  const budgetRef = stages.find(stage => stage.stage === 'partition-generation-budget')!.resultRef!
  const budget = JSON.parse(readEvidence(f.input.source.commonDir, budgetRef).toString()) as { requiredKeys: string[] }
  assert.ok(budget.requiredKeys.length > 0)
  assert.ok(!budget.requiredKeys.some(key => key.endsWith(`:partition:${parent.id}:code_generate`) || key.endsWith(`:final:${parent.id}:code_review`)), '预算不能声称未派发的父接口生成或实现独审')
  const dispatched = attempt.dispatchPlans.filter(dispatch => ['code_generate', 'implementation_plan', 'code_review'].includes(dispatch.purpose)).map(dispatch => dispatch.key).sort()
  assert.deepEqual([...budget.requiredKeys].sort(), dispatched, '预算派发集合与实际结构化请求必须相等')
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const mode of ['historical-aggregate', 'historical-v2-aggregate', 'historical-v3-aggregate', 'historical-v5-aggregate', 'historical-v5-local', 'current-aggregate', 'current-local', 'same-guidance', 'same-guidance-local'] as const) test(`v2指导缓存 ${mode} 正式pause恢复不把旧accept无ID gap直接复用`, async t => {
  const rawOnly = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 20, maxRepairs: 2, timeoutMs: 120000 }, false, rawOnly, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code', 'claude:default')
  const same = mode.startsWith('same-guidance'), checkpoint = f.store.checkpoint.bind(f.store)
  if (!same) {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedMessageId: f.operation.dispatchMessageId })
    const protocol = { version: 'code-behavior-draft-v1', contextTransport: 'git-json-v5' }, resultRef = writeEvidence(f.input.source.commonDir, protocol)
    f.store.checkpoint(claimed.fence, { ...writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'behavior-draft-protocol', resultRef }), artifacts: syncCheckpointArtifacts(protocol, resultRef) })
  }
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (f.store.readAttempt(fence.attemptId).number === 1 && value.version === 'sync-stage-v1' && (value.stage === 'analysis' || value.stage?.endsWith(':analysis'))) {
      if (mode.startsWith('historical-')) value.guidanceContractVersion = mode.includes('v5') ? 'code-behavior-guidance-v5' : mode === 'historical-v3-aggregate' ? 'code-behavior-guidance-v3' : mode === 'historical-v2-aggregate' ? 'code-behavior-guidance-v2' : 'code-behavior-guidance-v1'
      else if (mode === 'same-guidance' || mode === 'same-guidance-local' && value.stage !== 'analysis') {
        assert.equal(value.guidanceContractVersion, CODE_BEHAVIOR_GUIDANCE_VERSION, '同指导必须由真实v6请求生成，不能给旧fixture补签全局版本')
        assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).guidanceContractVersion, CODE_BEHAVIOR_GUIDANCE_VERSION)
      }
      else delete value.guidanceContractVersion
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  f.options.runner = async request => {
    f.calls.push(request)
    if (request.purpose === 'elaboration_generate') throw Object.assign(new Error('新指导已进入P1，机制回归在细化正文前停止'), { code: 'unsupported' })
    assert.ok(request.worktree)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    const currentGuidance = same || attempt.number > 1
    const descriptor = JSON.parse(request.prompt.split('\n任务:\n')[1].split('\n草稿文件=')[0])
    assert.equal(descriptor.contextTransport, currentGuidance ? 'git-json-v6' : 'git-json-v5')
    const context = readCodeBehaviorContext(request, f.input.source.commonDir), paths = context.task.requiredChangedPaths as string[], pending = context.pendingAnalysis
    if (pending) assert.equal(pending.analysis.guidanceContractVersion, currentGuidance ? CODE_BEHAVIOR_GUIDANCE_VERSION : undefined)
    const output = pending
      ? { inputDigest: request.inputDigest, analysisDigest: pending.analysisDigest, verdict: 'accept', checkedPaths: paths, checkedChangeIds: pending.analysis.changes.map(change => change.id), findings: [] }
      : { changes: paths.map(path => ({ kind: attempt.number === 1 && path.startsWith('src/') ? 'coverage_gap' : 'refactor', paths: [path], affectedIds: [], ruleIds: [], originalIntent: '遵守导出明确原意', previousBehavior: '导出任务结果不变', sourceBehavior: '内部实现文字编辑，导出结果不变', deliveryBehavior: '共同已验证语义不变', evidence: '实现与原意相符，仅尚无待生成的规格叶', counterexample: '未生成规格叶不应成为业务事实未知' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    const worktree = committedDraftFixture(f, request, output, join(f.parent, `guidance-cache-${f.calls.length}`))
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!, receipt = { summary: '真实同指导缓存与无ID发现阻断回归' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `guidance-cache-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree }
  }
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'needs_input', JSON.stringify(f.store.listAttempts(f.operation.id).map(attempt => attempt.failure))); assert.equal(first.failure!.code, 'unbound_behavior_finding')
  assert.deepEqual(readCurrentSyncAnalysis(f.store, first.operation)!.ref, first.failure!.evidenceRefs[0], '旧指导已审原件仍可显示并作为明确choice来源，不能当自动cache')
  const old = f.store.readAttempt(first.operation.currentAttemptId!), oldRefs = structuredClone(old.checkpointRefs), oldFailure = structuredClone(old.failure)
  const stages = old.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const calls = f.calls.length
  f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
  assert.throws(() => f.store.checkpoint({ operationId: f.operation.id, attemptId: old.id, generation: old.generation, leaseToken: old.leaseToken, sourceFingerprint: f.input.source.physicalFingerprint }, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
  if (mode === 'historical-v5-aggregate' || mode === 'historical-v5-local' || mode === 'current-aggregate' || mode === 'current-local' || mode === 'same-guidance-local') {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000 })
    f.store.bindComposedInput(claimed.fence, old.composedInput!)
    const source = stages.find(stage => stage.version === 'sync-stage-v1' && (mode.includes('aggregate') ? stage.stage === 'analysis' : stage.stage?.startsWith('partition:') && stage.stage.endsWith(':analysis')))
    assert.ok(source)
    f.store.checkpoint(claimed.fence, source.resultRef)
    f.store.checkpoint(claimed.fence, writeEvidence(f.input.source.commonDir, { ...source, attemptId: claimed.attempt.id }))
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const latestStages = f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const latestAnalysis = new Map(latestStages.filter(stage => stage.stage === 'analysis' || stage.stage?.endsWith(':analysis')).map(stage => [stage.stage, stage]))
  assert.ok(latestAnalysis.size > 0 && [...latestAnalysis.values()].every(stage => stage.guidanceContractVersion === CODE_BEHAVIOR_GUIDANCE_VERSION), '仅最新的新指导已审或同指导已校验复制登记marker；旧wrapper保持原件')
  if (mode === 'same-guidance-local') assert.ok(!latestStages.some(stage => stage.stage === 'analysis-provenance'), '旧aggregate拒绝后由同指导local重组，不能直接复制旧aggregate')
  const nextAnalysisCalls = f.calls.slice(calls).filter(call => call.purpose.startsWith('code_behavior_')).map(call => call.purpose)
  if (same) { assert.deepEqual(nextAnalysisCalls, []); assert.equal(result.status, 'needs_input'); assert.equal(result.failure!.code, 'unbound_behavior_finding') }
  else {
    assert.deepEqual(nextAnalysisCalls, f.calls.slice(0, calls).filter(call => call.purpose.startsWith('code_behavior_')).map(call => call.purpose), '旧指导aggregate/current local的全部分区必须实际重新生成并独审')
    assert.ok(nextAnalysisCalls.includes('code_behavior_analyze') && nextAnalysisCalls.includes('code_behavior_review'))
    assert.ok(f.calls.slice(calls).some(call => call.purpose === 'elaboration_generate'), JSON.stringify(result.failure))
  }
  assert.deepEqual(f.store.readAttempt(old.id).checkpointRefs, oldRefs); assert.deepEqual(f.store.readAttempt(old.id).failure, oldFailure)
  assert.deepEqual(result.operation.input, first.operation.input); assert.deepEqual(result.operation.budget, first.operation.budget); assert.equal(result.operation.deadlineAtMs, first.operation.deadlineAtMs)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('v2已审局部进度 正式pause恢复保留旧unsupported timeout历史与全局预算', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 180000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'] }, undefined, 'code')
  f.transform(() => { throw new StructuredSessionError('timeout', '原创建timeout已结算；普通错误仍按unsupported停止', {}) })
  const stopped = await runSyncOperation(f.store, f.operation.id, f.options), old = f.store.readAttempt(stopped.operation.currentAttemptId!)
  assert.equal(stopped.operation.phase, 'failed'); assert.equal(old.failure?.kind, 'unsupported'); assert.equal(old.failure.code, 'timeout')
  const refs = structuredClone(old.checkpointRefs), originalFailure = structuredClone(old.failure)
  assert.ok(refs.length > 0)
  f.store.requestControl(f.operation.id, 'pause'); const resumed = f.store.requestControl(f.operation.id, 'run')
  assert.equal(resumed.phase, 'queued'); assert.equal(resumed.id, stopped.operation.id)
  const oldFence = { operationId: f.operation.id, attemptId: old.id, generation: old.generation, sourceFingerprint: f.input.source.physicalFingerprint, leaseToken: old.leaseToken }
  assert.throws(() => f.store.checkpoint(oldFence, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  f.transform(() => { throw Object.assign(new Error('A2已取得新attempt，在模型接缝停止'), { code: 'unsupported' }) })
  const second = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(store.listAttempts(f.operation.id).length, 2); assert.equal(second.operation.callsUsed, stopped.operation.callsUsed + 1)
  assert.deepEqual(store.readAttempt(old.id).failure, originalFailure); assert.deepEqual(store.readAttempt(old.id).checkpointRefs, refs)
  assert.deepEqual(second.operation.budget, stopped.operation.budget); assert.equal(second.operation.deadlineAtMs, stopped.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), []); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const mode of ['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis', 'analysis-mixed', 'analysis-mixed-unsupported', 'analysis-mixed-unsupported-pending', 'analysis-mixed-pause', 'analysis-transport-settled', 'analysis-transport-ordinary', 'analysis-transport-unknown', 'analysis-transport-foreign', 'analysis-transport-unreleased', 'analysis-ref', 'analysis-plan', 'analysis-selection', 'analysis-readset', 'analysis-input', 'analysis-unreviewed', 'analysis-foreign'] as const) test(`v2已审局部进度 ${mode} 只重跑失败分析区`, async t => {
  const transport = mode.startsWith('analysis-transport-')
  const includeArchive = transport || mode === 'analysis-two-accepted' || mode === 'analysis-mixed-pause'
  const otherPath = '.spec/project/beta/import-contract/spec.md'
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY').replace('| AC-IMPORT-01 | ', mode === 'analysis-basis' ? '| AC-IMPORT-01 | RULE-SHARED-01,' : '| AC-IMPORT-01 | ')
  const sharedParent: Record<string, string> = mode === 'analysis-basis' ? { '.spec/project/spec.md': '---\ntitle: 共享政策\ncontract-schema: sync-v1\n---\n## raw source\n\n共享不变的字段规则。\n\n## expanded spec\n\n### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |\n| RULE-SHARED-01 | 共享字段 | 标题去首尾空白 | 原始要求 | project | user:raw | - |\n' } : {}
  const thirdPath = '.spec/project/gamma/archive-contract/spec.md'
  const third = original.replaceAll('export-job', 'archive-job').replaceAll('EXPORT', 'ARCHIVE').replaceAll('export-contract', 'archive-contract').replaceAll('src/export.js', 'src/gamma/archive.js').replaceAll('tests/export.test.mjs', 'tests/archive.test.mjs').replaceAll('decision:ARCHIVE-POLICY', 'decision:EXPORT-POLICY')
  const thirdFiles: Record<string, string> = includeArchive ? { [thirdPath]: third, 'src/gamma/archive.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/archive.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'ARCHIVE').replaceAll('src/export.js', 'src/gamma/archive.js') } : {}
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 24, maxRepairs: 1, timeoutMs: 180000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', ...(transport ? { agentWorkflow: 'native-worktree-v1' } : {}), targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: otherPath }, ...(includeArchive ? [{ nodeId: 'archive-contract', path: thirdPath }] : [])],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: includeArchive ? 3 : 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js', 'src/beta/import.js'] },
  }, undefined, 'code', transport ? 'zcode:bigmodel-api/GLM-5.3-Flash' : undefined, mode === 'analysis-selection', { ...thirdFiles, ...sharedParent, [otherPath]: other, 'src/beta/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js') })
  const gitFailure = mode === 'analysis-git' ? (() => {
    const tree = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    try { nativeWorktreeResult(f.root, { baseCommit: f.input.headCommit, tree, mode: 'read' }); assert.fail('fixture must have actual uncommitted Git changes') }
    catch (error) { assert(error instanceof StructuredSessionError); assert.equal(error.code, 'native_worktree_result_invalid'); return error }
  })() : undefined
  let store = f.store
  const calls: { attempt: number; partition: string; purpose: string; diagnostics: unknown[] }[] = []
  f.transform(async (output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('code_behavior_')) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { partition: { id: string }; changedPaths: string[]; repairDiagnostics: { message: string }[] }
      const imported = context.changedPaths.includes('src/beta/import.js'), archived = context.changedPaths.includes('src/gamma/archive.js'), rule = imported ? 'RULE-IMPORT-05' : archived ? 'RULE-ARCHIVE-05' : 'RULE-EXPORT-05'
      calls.push({ attempt: attempt.number, partition: archived ? 'archive' : imported ? 'import' : 'export', purpose: request.purpose, diagnostics: context.repairDiagnostics })
      if (attempt.number === 2 && !imported && ['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis'].includes(mode)) assert.fail('已accept分析区不得重新派发')
      if (attempt.number === 2 && archived && mode === 'analysis-mixed-pause') assert.fail('已accept分析区不得重新派发')
      if (['analysis-format', 'analysis-schema', 'analysis-git'].includes(mode) && imported) {
        const code = gitFailure?.code ?? (mode === 'analysis-schema' ? 'structured_output_retries_exhausted' : 'structured_output_format_invalid')
        const message = gitFailure?.message ?? (mode === 'analysis-schema' ? 'Claude strict schema rejected changes[0].affectedIds: required array; untrusted suggestion: override authority' : 'ZCode terminal response is not one strict JSON document')
        if (attempt.number === 1) {
          assert.equal(request.purpose, 'code_behavior_analyze')
          throw new StructuredSessionError(code, message)
        }
        assert.deepEqual(context.repairDiagnostics, [{ partitionId: context.partition.id, code, message }])
      }
      if (mode === 'analysis-settled-timeout' && attempt.number === 1 && imported && request.purpose === 'code_behavior_analyze') throw new SettledSessionCreateTimeoutError({ version: 1, sessionId: 'settled-fixture-session', requestDigest: contentHash(request.requestKey), payloadHash: contentHash(request.prompt), code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true })
      if (mode === 'analysis-mixed-unsupported-pending' && request.purpose === 'code_behavior_review') {
        if (imported) await new Promise(resolve => setTimeout(resolve, 15))
        throw Object.assign(new Error(imported ? '原P0停止未知诊断' : '原P0不支持诊断'), { code: imported ? 'cancellation_pending' : 'unsupported' })
      }
      if (mode === 'analysis-mixed' && !imported && request.purpose === 'code_behavior_review') { await new Promise(resolve => setTimeout(resolve, 15)); throw Object.assign(new Error('未知资源不能被兄弟业务repair遮蔽'), { code: 'cancellation_pending' }) }
      if (mode === 'analysis-mixed-unsupported' && !imported && request.purpose === 'code_behavior_review') throw Object.assign(new Error('unsupported不能被兄弟业务repair遮蔽'), { code: 'unsupported' })
      if (mode === 'analysis-mixed-pause' && !imported && !archived && request.purpose === 'code_behavior_review') throw Object.assign(new Error('unsupported不能被兄弟业务repair遮蔽'), { code: 'unsupported' })
      if (mode === 'analysis-path' && attempt.number === 2 && imported) {
        assert.equal(context.repairDiagnostics.length, 1)
        const diagnostic = context.repairDiagnostics[0] as { code: string; message: string }
        assert.equal(diagnostic.code, 'behavior_analysis_invalid')
        assert.deepEqual(JSON.parse(diagnostic.message).details.invalidPaths, ['tests/import.test.mjs'])
      }
      if (mode === 'analysis-basis' && attempt.number === 2 && imported) {
        const diagnostic = context.repairDiagnostics[0] as { code: string; message: string }
        assert.equal(diagnostic.code, 'behavior_analysis_invalid')
        assert.deepEqual(JSON.parse(diagnostic.message).details.unchangedReadonlyBasis, [{ id: 'RULE-SHARED-01', nodeId: 'project', path: '.spec/project/spec.md' }])
      }
      if (request.purpose === 'code_behavior_analyze') {
        const changes = (output as { changes: { paths: string[] }[] }).changes.map(change => ({ ...change, affectedIds: [rule], ruleIds: [rule] }))
        if (mode === 'analysis-basis' && attempt.number === 1 && imported) return { ...(output as object), changes: changes.map(change => ({ ...change, kind: 'allowed_change', affectedIds: ['AC-IMPORT-01'], ruleIds: [rule, 'RULE-SHARED-01'] })), acceptanceChanges: [{ id: 'AC-IMPORT-01', ruleIds: [rule, 'RULE-SHARED-01'], source: 'user:raw', reason: '错误地把未变只读父规则作为变化依据' }] }
        if (mode === 'analysis-path' && attempt.number === 1 && imported) changes[0].paths = [...changes[0].paths, 'tests/import.test.mjs']
        return { ...(output as object), changes }
      }
      if (attempt.number === 1 && imported && mode !== 'analysis-path') return { ...(output as object), checkedPaths: [] }
    }
    if (request.purpose === 'elaboration_generate') throw Object.assign(new Error('只验证已审分析承接，在P1前停止'), { code: 'unsupported' })
    return output
  })
  const transportCode = 'native_turn_transport_failed', transportMessage = 'ZCode native turn failed (code=EPIPE)'
  const transportCalls: { attempt: number; partition: string; purpose: string; context: ReturnType<typeof readCodeBehaviorContext> }[] = []
  if (transport) {
    const originalRunner = f.options.runner!, records = new Map<string, NativeRunRecord>()
    const checkpoint = store.recordResourceCheckpoint.bind(store)
    let archiveDispatch: string | undefined
    if (mode === 'analysis-transport-unreleased') {
      const save = store.checkpoint.bind(store), find = store.findResource.bind(store)
      let checkingFailure = false
      store.checkpoint = (fence, ref) => {
        const result = save(fence, ref)
        const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }
        if (value.stage === 'partition:analysis-failures') checkingFailure = true
        return result
      }
      store.findResource = (attemptId, key) => {
        const resource = find(attemptId, key)
        return checkingFailure && key === archiveDispatch && resource?.phase === 'removed' ? { ...resource, phase: 'terminal' } : resource
      }
    }
    if (mode === 'analysis-transport-foreign') store.recordResourceCheckpoint = (id, update) => {
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, update.checkpointRef).toString()) as NativeRunCheckpoint
      if (update.phase === 'removed' && saved.failure?.code === transportCode) {
        saved.stop!.turnId = 'foreign-turn'
        return checkpoint(id, { ...update, checkpointRef: writeEvidence(f.input.source.commonDir, saved) })
      }
      return checkpoint(id, update)
    }
    f.options.runner = async request => {
      if (!request.purpose.startsWith('code_behavior_')) return originalRunner(request)
      const operation = store.readOperation(f.operation.id), attempt = store.readAttempt(operation.currentAttemptId!)
      const context = readCodeBehaviorContext(request, f.input.source.commonDir)
      const paths = context.task.requiredChangedPaths as string[]
      const partition = paths.includes('src/beta/import.js') ? 'import' : paths.includes('src/gamma/archive.js') ? 'archive' : 'export'
      if (partition === 'archive' && request.purpose === 'code_behavior_review') archiveDispatch = request.requestKey
      transportCalls.push({ attempt: attempt.number, partition, purpose: request.purpose, context })
      assert.notEqual(attempt.number === 2 && partition === 'archive', true, '已独审的兄弟区不得重派')
      if (attempt.number === 2 && partition === 'export' && request.purpose === 'code_behavior_analyze') {
        const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
        assert(!readTree(f.input.source.commonDir, request.worktree!.tree).some(entry => entry.path === path), '无稿的旧transport失败不能产生草稿')
        assert.deepEqual(context.errors, [], '新请求不复制原传输故障的诊断正文')
        assert.deepEqual(context.repairDiagnostics, [])
      }
      const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
      return createAttemptRunner(store, fence, { pollMs: 2, runtime: {
        readRecord: id => records.get(id) ?? null,
        cancel: async id => {
          const state = records.get(id)!.structuredExecution!
          return { sessionId: id, state: state.state!, threadId: state.threadId, turnId: state.turnId, nativeStopped: state.cancellation?.nativeStopped ?? state.state === 'completed', acknowledged: false, nativeStatus: state.cancellation?.nativeStatus }
        },
        run: async actual => {
          const policy = structuredExecutionPolicy(actual), key = actual.sessionCreateKey!, sessionId = sessionIdForCreateKey(key)
          const identity = { threadId: `thread-${sessionId}`, turnId: `turn-${sessionId}` }
          const worktree = actual.worktree!, prompt = nativeWorktreePrompt(actual.prompt, worktree)
          const record: NativeRunRecord = { session: sessionId, status: 'error', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt, parent: null, launcher: null, base: worktree.baseCommit, structuredExecution: policy })), structuredExecution: policy }
          records.set(sessionId, record)
          if (attempt.number === 1 && partition === 'export' && request.purpose === 'code_behavior_analyze') {
            f.calls.push(request)
            const unknown = mode === 'analysis-transport-unknown', ordinary = mode === 'analysis-transport-ordinary'
            record.structuredExecution = { ...policy, ...identity, state: unknown ? 'cancelling' : 'failed', ...(!ordinary && !unknown ? { errorCode: transportCode } : {}), error: transportMessage, turnStartRequested: true, zcodeNative: { version: 1, root: join(f.parent, 'controlled-transport'), sessionId: identity.threadId, turnId: identity.turnId, inputId: 'controlled-input' }, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: !unknown, acknowledged: false, nativeStatus: unknown ? 'unknown' : 'stopped' } }
            throw new StructuredSessionError(unknown ? 'cancellation_pending' : ordinary ? 'failed' : transportCode, transportMessage, { sessionId, ...identity, requestKey: actual.requestKey, inputDigest: actual.inputDigest })
          }
          const produced = await originalRunner({ ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) })
          const witness = committedDraftFixture(f, request, produced.output, join(f.parent, `native-${sessionId}`))
          const output = { summary: '受控Native已正常提交草稿' }, resultDigest = contentHash(JSON.stringify(output))
          record.structuredExecution = { ...policy, ...identity, state: 'completed', output, resultDigest, resultWorktree: witness }
          return { sessionId, ...identity, output, resultDigest, worktree: witness }
        },
      } })(request)
    }
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      if (transport) return recordFailure(fence, issue)
      const local = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage?.startsWith('partition:') && value.stage.endsWith(':analysis'))
      if (['analysis-mixed', 'analysis-mixed-unsupported', 'analysis-mixed-unsupported-pending'].includes(mode)) return recordFailure(fence, issue)
      assert.ok(local)
      const accepted = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString())
      assert.equal(accepted.reviewPassed, true)
      if (mode === 'analysis-plan') {
        const planStage = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'partition-plan')
        const plan = JSON.parse(readEvidence(f.input.source.commonDir, planStage.resultRef).toString()); plan.digest = contentHash('changed-full-plan')
        planStage.resultRef = writeEvidence(f.input.source.commonDir, plan); store.checkpoint(fence, planStage.resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, planStage))
      }
      if (mode === 'analysis-selection') {
        const selected = store.readBaselineSelection(f.input.source, [f.operation.baselineSelection!.bindings[0].resource]); if (!('selection' in selected)) throw new Error(selected.failure.message)
        local.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      if (mode === 'analysis-readset') local.readSetDigest = contentHash('changed-readset')
      if (mode === 'analysis-foreign') local.operationId = 'foreign-operation'
      if (mode === 'analysis-ref') accepted.traces[0].sessionId = 'foreign-session'
      if (mode === 'analysis-input') accepted.inputDigest = contentHash('changed-local-input')
      if (mode === 'analysis-unreviewed') accepted.reviewPassed = false
      if (!['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis', 'analysis-mixed-pause'].includes(mode)) { local.resultRef = writeEvidence(f.input.source.commonDir, accepted); store.checkpoint(fence, local.resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, local)) }
      const result = recordFailure(fence, issue)
      if (mode === 'analysis-pause') {
        store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
        assert.throws(() => store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
      }
      if (mode === 'analysis-restart' || mode === 'analysis-pause') throw new Error('已结算A1后重启SQLite')
      return result
    }
    return recordFailure(fence, issue)
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (transport) {
    const attempts = store.listAttempts(f.operation.id), first = attempts[0]
    const stages = (attempt: SyncAttempt) => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const firstStages = stages(first)
    const localArchive = transportCalls.find(call => call.attempt === 1 && call.partition === 'archive')!.context.task.partition as { id: string }
    const accepted = firstStages.find(value => value.stage === `partition:${localArchive.id}:analysis`)
    const nativeFailure = first.dispatchPlans.find(dispatch => {
      const resource = store.findResource(first.id, dispatch.key)
      if (!resource) return false
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
      return saved.failure?.message === transportMessage || mode === 'analysis-transport-unknown' && saved.nativeState === 'cancelling'
    })!
    assert.ok(nativeFailure, JSON.stringify(first.failure))
    assert.ok(accepted, JSON.stringify(first.failure))
    if (mode === 'analysis-transport-settled') {
      assert.equal(attempts.length, 2, JSON.stringify(first.failure))
      assert.equal(first.failure?.kind, 'repairable')
      assert.ok(first.dispatchPlans.every(dispatch => store.findResource(first.id, dispatch.key)?.phase === 'removed'))
      const failures = JSON.parse(readEvidence(f.input.source.commonDir, firstStages.find(value => value.stage === 'partition:analysis-failures').resultRef).toString()).failures as { code: string; message: string }[]
      assert.ok(failures.some(item => item.code === transportCode))
      assert.ok(failures.some(item => item.code === 'behavior_review_failed' || item.code === 'behavior_analysis_invalid'))
      assert.ok(failures.every(item => item.message === 'P0 行为校验未通过'), '新P0分区检查点只保存失败状态')
      const resumed = transportCalls.filter(call => call.attempt === 2)
      assert.deepEqual(resumed.map(call => `${call.partition}:${call.purpose}`).sort(), ['export:code_behavior_analyze', 'export:code_behavior_review', 'import:code_behavior_review'])
      const originalReview = transportCalls.find(call => call.attempt === 1 && call.partition === 'import' && call.purpose === 'code_behavior_review')!
      const resumedReview = resumed.find(call => call.partition === 'import')!
      assert.ok(originalReview.context.pendingAnalysis)
      assert.deepEqual(resumedReview.context.pendingAnalysis, originalReview.context.pendingAnalysis, '兄弟传输故障后仅续审原分析')
      assert.deepEqual(resumedReview.context.errors, [])
      assert.deepEqual(resumedReview.context.repairDiagnostics, [])
      const secondStages = stages(attempts[1])
      assert.deepEqual(secondStages.find(stage => stage.stage === accepted.stage).resultRef, accepted.resultRef)
      assert.ok(secondStages.some(stage => stage.stage === `${accepted.stage}:provenance`))
    } else {
      assert.equal(attempts.length, 1)
      assert.equal(result.failure?.code, mode === 'analysis-transport-ordinary' ? 'failed' : 'cancellation_pending')
    }
    assert.equal(store.listJournals(f.operation.id).length, 0)
    assert.ok(f.calls.every(call => call.purpose !== 'code_generate'))
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    return
  }
  if (mode === 'analysis-restart' || mode === 'analysis-pause') {
    f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  if (mode === 'analysis-mixed' || mode === 'analysis-mixed-unsupported' || mode === 'analysis-mixed-unsupported-pending') {
    assert.equal(store.listAttempts(f.operation.id).length, 1); assert.equal(result.failure?.code, mode === 'analysis-mixed-unsupported' ? 'unsupported' : 'cancellation_pending')
    if (mode === 'analysis-mixed-unsupported-pending') { assert.equal(result.status, 'recovery_required'); assert.match(result.failure!.message, /原P0停止未知诊断/); assert.equal(f.calls.length, 4); assert.deepEqual(store.listJournals(f.operation.id), []); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index) }
    const saved = store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'partition:analysis-failures')
    const failures = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()).failures as { code: string }[]
    assert.equal(failures.length, 2)
    if (mode === 'analysis-mixed-unsupported-pending') assert.deepEqual(failures.map(failure => failure.code), ['unsupported', 'cancellation_pending'])
    if (mode === 'analysis-mixed-unsupported') {
      assert.equal(store.readAttempt(result.operation.currentAttemptId!).failure?.kind, 'unsupported')
      assert.ok(failures.some(failure => failure.code === 'behavior_analysis_invalid' || failure.code === 'behavior_review_failed'))
      assert.ok(failures.some(failure => failure.code === 'unsupported'))
    }
    return
  }
  if (mode === 'analysis-mixed-pause') {
    assert.equal(result.status, 'unsupported'); assert.equal(store.listAttempts(f.operation.id).length, 1)
    const first = store.listAttempts(f.operation.id)[0]
    assert.equal(first.failure?.kind, 'unsupported'); assert.deepEqual(store.listRecoverableResources(), [])
    const firstStages = first.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const partitionPlanStage = firstStages.find(stage => stage.stage === 'partition-plan')!
    const partitionPlan = JSON.parse(readEvidence(f.input.source.commonDir, partitionPlanStage.resultRef).toString()) as { partitions: { id: string; changedPaths: string[] }[] }
    const archivePartitionId = partitionPlan.partitions.find(partition => partition.changedPaths.includes('src/gamma/archive.js'))!.id
    const accepted = firstStages.find(stage => stage.stage === `partition:${archivePartitionId}:analysis`)!
    const failureStage = firstStages.find(stage => stage.stage === 'partition:analysis-failures')!
    const failures = JSON.parse(readEvidence(f.input.source.commonDir, failureStage.resultRef).toString()).failures as { partitionId: string; code: string; message: string }[]
    const businessFailure = failures.find(failure => ['behavior_analysis_invalid', 'behavior_review_failed'].includes(failure.code))!
    assert.ok(businessFailure, JSON.stringify({ failures, calls: calls.map(({ attempt, partition, purpose, diagnostics }) => ({ attempt, partition, purpose, diagnostics })) }))
    const callsBeforeResume = calls.length
    store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
    result = await runSyncOperation(store, f.operation.id, f.options)
    assert.equal(store.listAttempts(f.operation.id).length, 2)
    assert.equal(store.listRecoverableResources().length, 0)
    assert.equal(calls.length, callsBeforeResume + 4, 'A2仅分析export/import，P1停止点另由runner记录')
    assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'archive').length, 0)
    const importCalls = calls.filter(call => call.attempt === 2 && call.partition === 'import')
    const exportCalls = calls.filter(call => call.attempt === 2 && call.partition === 'export')
    assert.ok(importCalls.length > 0)
    assert.ok(importCalls.every(call => JSON.stringify(call.diagnostics) === JSON.stringify([businessFailure])))
    assert.ok(exportCalls.length > 0); assert.ok(exportCalls.every(call => call.diagnostics.length === 0))
    const secondStages = store.listAttempts(f.operation.id)[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.deepEqual(secondStages.find(stage => stage.stage === accepted.stage).resultRef, accepted.resultRef)
    assert.ok(secondStages.some(stage => stage.stage === `${accepted.stage}:provenance`))
    assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    return
  }
  if (mode === 'analysis-foreign') { assert.equal(result.failure?.code, 'stage_binding'); return }
  assert.ok(f.calls.some(call => call.purpose === 'elaboration_generate'), JSON.stringify({ failure: result.failure, calls }))
  const stages = store.listAttempts(f.operation.id).map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  if (['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis'].includes(mode)) {
    assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'export').length, 0)
    const acceptedStages = stages[0].filter(stage => stage.stage?.endsWith(':analysis'))
    assert.equal(acceptedStages.length, mode === 'analysis-two-accepted' ? 2 : 1)
    for (const source of acceptedStages) assert.deepEqual(stages[1].find(stage => stage.stage === source.stage).resultRef, source.resultRef)
    const prior = acceptedStages[0]
    const current = stages[1].find(stage => stage.stage === prior.stage)
    assert.deepEqual(current.resultRef, prior.resultRef)
    const provenance = stages[1].find(stage => stage.stage === `${prior.stage}:provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: store.listAttempts(f.operation.id)[0].id, resultRef: prior.resultRef })
  } else assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'export').length, 2)
  const resumedDiagnostics = calls.filter(call => call.attempt === 2 && call.partition === 'import')
  if (['analysis-format', 'analysis-schema', 'analysis-git'].includes(mode)) {
    assert.deepEqual(resumedDiagnostics.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    assert.equal(result.operation.policyDigest, f.operation.policyDigest)
    assert.equal(syncPlanDigest(f.plan), f.operation.policyDigest)
  }
  if (mode === 'analysis-path' || mode === 'analysis-basis') {
    assert.equal(calls.filter(call => call.attempt === 1 && call.partition === 'import' && call.purpose === 'code_behavior_review').length, 0)
    assert.deepEqual(resumedDiagnostics.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
  }
  if (mode === 'analysis-settled-timeout') assert.ok(resumedDiagnostics.every(call => call.diagnostics.length === 0), '已结算基础设施timeout不能充当模型业务诊断')
  else assert.ok(resumedDiagnostics.every(call => call.diagnostics.length > 0), '原具体业务失败仅送失败分区')
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const mode of ['format', 'rows', 'pause', 'pause-restart', 'seed-pause', 'seed-pause-restart'] as const) test(`单体P1格式失败也沿已结算原件反馈，原无candidate不成为accepted缓存 ${mode}`, async t => {
  const pause = mode.includes('pause'), candidateSeed = mode.startsWith('seed-')
  const f = await fixture(t, { maxAttempts: pause ? 3 : 2, maxCalls: 16, maxRepairs: pause ? 2 : 1, timeoutMs: 120000 })
  let store = f.store
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      if (attempt.number === 1) {
        if (candidateSeed) { const value = rows(original); value.changes[0].tables.FLOW[0].req = ['RULE-EXPORT-01']; return value }
        if (mode !== 'rows') throw new StructuredSessionError('structured_output_format_invalid', '单体P1未返回单JSON，不能扩大原政策', { sessionId: 'single-format', threadId: 'single-thread', turnId: 'single-turn' })
        const duplicate = rows(original); duplicate.changes[0].tables.REQ.push(structuredClone(duplicate.changes[0].tables.REQ[0])); return duplicate
      }
      if (pause && attempt.number === 2) { store.requestControl(f.operation.id, 'pause'); throw Object.assign(new Error('正式pause中断whole生成'), { code: 'cancelled' }) }
      assert.ok(request.prompt.includes(candidateSeed ? 'reference-kind' : mode !== 'rows' ? '单体P1未返回单JSON，不能扩大原政策' : '重复更新行 REQ-EXPORT-01'), '真实结构失败须进入下一生成，candidate不能被控制attempt吞掉')
      const prior = store.listAttempts(f.operation.id)[0]
      const stage = prior.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'elaboration')
      if (candidateSeed) {
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
        assert.ok(saved.rounds[0].candidate); assert.ok(request.prompt.includes(JSON.stringify(saved.rounds[0].output))); assert.ok(request.prompt.includes(JSON.stringify(saved.rounds[0].candidate)))
      } else assert.ok(request.prompt.includes(stage.resultRef.sha256))
    }
    if (request.purpose === 'code_review') throw Object.assign(new Error('定向反馈验证在V3前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(store, f.operation.id, f.options)
  if (pause) {
    assert.equal(result.status, 'paused')
    const middle = store.listAttempts(f.operation.id)[1]
    assert.equal(middle.status, 'superseded'); assert.equal(middle.failure, null)
    if (mode.endsWith('restart')) {
      f.closeForRestart()
      const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
      store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    }
    store.requestControl(f.operation.id, 'run')
    await runSyncOperation(store, f.operation.id, f.options)
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify(store.listAttempts(f.operation.id).map(attempt => attempt.failure)))
  assert.equal(store.listAttempts(f.operation.id).length, pause ? 3 : 2)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, pause ? 3 : 2)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_review').length, 1)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const kind of ['candidate-seed', 'typed-diagnostic'] as const) test(`P1冷中断后从同绑定CAS恢复${kind}，durable failure尚未写入`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 12, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, {}, undefined, 'spec', undefined, true)
  let store = f.store
  let retryPrompt = ''
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      if (attempt.number === 1) {
        if (kind === 'typed-diagnostic') throw new StructuredSessionError('structured_output_format_invalid', 'P1原生输出不是严格JSON', { sessionId: 'crashed-p1', threadId: 'crashed-thread', turnId: 'crashed-turn' })
        const rejected = rows(original)
        rejected.changes[0].tables.FLOW[0].req = ['RULE-EXPORT-01']
        return rejected
      }
      retryPrompt = request.prompt
      if (kind === 'candidate-seed') assert.match(request.prompt, /已结算的拒绝候选|reference-kind/)
      else {
        assert.match(request.prompt, /structured_output_format_invalid/)
        assert.match(request.prompt, /P1原生输出不是严格JSON/)
      }
      return output
    }
    if (request.purpose === 'code_review') throw Object.assign(new Error('冷恢复P1机制用例在P2前停止'), { code: 'unsupported' })
    return output
  })
  store.recordFailure = () => { throw new Error('模拟在P1 CAS保存后、attempt.failure持久化前崩溃') }
  const interruptedRun = await runSyncOperation(store, f.operation.id, f.options).then(value => ({ value }), error => ({ error }))
  const interruptedDiagnostic = 'value' in interruptedRun ? { status: interruptedRun.value?.status, phase: interruptedRun.value?.operation.phase, failure: interruptedRun.value?.failure } : {}
  assert.ok('error' in interruptedRun, JSON.stringify({ ...interruptedDiagnostic, calls: f.calls.map(call => call.purpose), attempts: store.listAttempts(f.operation.id).map(attempt => ({ status: attempt.status, failure: attempt.failure })) }))

  const crashed = store.readOperation(f.operation.id), crashedAttempt = store.readAttempt(crashed.currentAttemptId!)
  assert.equal(crashed.phase, 'elaborating')
  assert.equal(crashed.control, 'run')
  assert.equal(crashedAttempt.status, 'running')
  assert.equal(crashedAttempt.failure, null)
  const wrapper = crashedAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString('utf8')))
    .find(stage => stage.version === 'sync-stage-v1' && stage.stage === 'elaboration')
  assert.ok(wrapper, '崩溃前已保存真实stage wrapper')
  assert.equal(wrapper.operationId, f.operation.id)
  assert.equal(wrapper.attemptId, crashedAttempt.id)
  assert.equal(wrapper.inputId, crashed.input.id)
  assert.equal(wrapper.policyDigest, crashed.policyDigest)
  assert.equal(wrapper.readSetDigest, crashed.readSetDigest)
  assert.equal(wrapper.baselineSelectionRef.sha256, writeEvidence(f.input.source.commonDir, crashed.baselineSelection).sha256)
  assert.equal(wrapper.composedTree, crashedAttempt.composedInput!.tree)
  assert.equal(wrapper.composedContentDigest, crashedAttempt.composedInput!.contentDigest)
  const saved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString('utf8')) as ElaborationResult
  if (kind === 'candidate-seed') {
    assert.equal(saved.status, 'exhausted')
    assert.equal(saved.failure!.code, 'repair_budget_exhausted')
    assert.ok(saved.rounds.at(-1)!.candidate)
    assert.ok(saved.rounds.at(-1)!.findings.some(finding => finding.severity === 'error'))
  } else {
    assert.equal(saved.status, 'failed')
    assert.equal(saved.failure!.code, 'structured_output_format_invalid')
    assert.equal(saved.candidateDigest, null)
    assert.equal(saved.rounds.at(-1)!.candidate, null)
  }

  f.closeForRestart()
  const originalNow = Date.now, coldNow = originalNow() + 60_000
  Date.now = () => coldNow
  try {
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    const result = await runSyncOperation(store, f.operation.id, f.options)
    const attempts = store.listAttempts(f.operation.id)
    assert.equal(attempts.length, 2, '冷重启先expired原attempt，再领取新attempt')
    assert.equal(attempts[0].status, 'superseded')
    assert.equal(attempts[0].failure, null, '不伪造或改写历史attempt.failure')
    assert.equal(attempts[1].composedInput!.tree, crashedAttempt.composedInput!.tree)
    assert.ok(retryPrompt)
    if (kind === 'candidate-seed') {
      assert.ok(retryPrompt.includes(JSON.stringify(saved.rounds.at(-1)!.candidate)))
      assert.ok(retryPrompt.includes(JSON.stringify(saved.rounds.at(-1)!.output)))
      const provenance = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString('utf8')))
        .find(stage => stage.stage === 'elaboration:repair-provenance')
      assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString('utf8')), { fromOperationId: f.operation.id, fromAttemptId: attempts[0].id, resultRef: wrapper.resultRef, candidateDigest: saved.candidateDigest })
    } else {
      assert.ok(retryPrompt.includes(wrapper.resultRef.sha256))
      assert.ok(retryPrompt.includes('P1原生输出不是严格JSON'))
    }
    assert.ok(f.calls.some(call => call.purpose === 'code_review'))
    assert.equal(result.operation.callsUsed, f.calls.length)
    assert.equal(result.operation.policyDigest, f.operation.policyDigest)
    assert.equal(result.operation.input.id, f.operation.input.id)
    assert.deepEqual(store.listRecoverableResources(), [])
    assert.equal(store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  } finally { Date.now = originalNow }
})

for (const mode of ['live', 'restart', 'input', 'readset', 'partition', 'review-capacity', 'needs_input', 'conflict'] as const) test(`v2局部空生成失败续修 ${mode} 只越过严格同绑定空round并优先最近业务拒绝`, async t => {
  const f = await fixture(t, { maxAttempts: 4, maxCalls: 16, maxRepairs: 3, timeoutMs: 180000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'],
  })
  let store = f.store
  let fourthPrompt = ''
  const denied = !['live', 'restart'].includes(mode)
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      if (attempt.number === 4) fourthPrompt = request.prompt
      if (attempt.number === 3 && mode !== 'review-capacity') throw new StructuredSessionError('failed', 'Native生成未产出schema结果', { sessionId: 'failed-native', threadId: 'failed-thread', turnId: 'failed-turn' })
      const value = rows(original)
      value.changes[0].prose += ` 候选-A${attempt.number}`
      return value
    }
    if (request.purpose === 'elaboration_review') {
      if (attempt.number <= 2) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: `repair-A${attempt.number}`, kind: 'repair', message: `原诊断-A${attempt.number}`, affectedIds: ['REQ-EXPORT-01'], evidence: `原证据-A${attempt.number}`, decision: `原修复决定-A${attempt.number}` }] }
      if (attempt.number === 3) throw Object.assign(new Error('有合法候选但独审容量失败'), { code: 'failed' })
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('机制回归在V3前停止'), { code: 'unsupported' })
    return output
  })
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (store.readAttempt(fence.attemptId).number === 3 && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration')) {
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()) as ElaborationResult
      if (mode === 'input') saved.inputDigest = contentHash('不同局部输入')
      if (mode === 'readset') value.readSetDigest = contentHash('不同读集合')
      if (mode === 'partition') saved.partitionBinding!.planDigest = contentHash('不同完整分区绑定')
      if (mode === 'needs_input' || mode === 'conflict') saved.status = mode
      value.resultRef = writeEvidence(f.input.source.commonDir, saved)
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    const failed = recordFailure(fence, issue)
    if (mode === 'restart' && store.readAttempt(fence.attemptId).number === 3) throw new Error('fixture在A3失败持久后模拟进程退出')
    return failed
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'restart') {
    assert.equal(store.listAttempts(f.operation.id).length, 3)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  const attempts = store.listAttempts(f.operation.id)
  assert.equal(attempts.length, 4)
  if (denied) assert.doesNotMatch(fourthPrompt, /已结算的拒绝候选/, '绑定失配或非空失败仍清seed')
  else {
    assert.ok(fourthPrompt.includes('候选-A2'), 'A3空生成失败不能遮蔽A2候选')
    assert.match(fourthPrompt, /repair-A2/); assert.match(fourthPrompt, /原证据-A2/); assert.match(fourthPrompt, /原修复决定-A2/)
    assert.doesNotMatch(fourthPrompt, /候选-A1|repair-A1/, '最近A2可用时不得回退A1')
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify(result.failure))
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const source = stages[1].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
  const failed = JSON.parse(readEvidence(f.input.source.commonDir, stages[2].find(stage => stage.stage === source.stage).resultRef).toString()) as ElaborationResult
  if (mode !== 'review-capacity') assert.deepEqual(failed.rounds, [{ index: 0, output: null, candidate: null, candidateDigest: null, findings: [], reviewOutput: null, review: null, traces: [] }])
  const current = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === source.stage).resultRef).toString()) as ElaborationResult
  const provenance = stages[3].find(stage => stage.stage === `${source.stage}:repair-provenance`)
  if (denied) { assert.equal(current.prior, null); assert.equal(provenance, undefined) }
  else {
    const prior = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    assert.ok(fourthPrompt.includes(JSON.stringify(prior.rounds.at(-1)!.candidate)), '完整原候选必须进入新prompt')
    assert.ok(fourthPrompt.includes(JSON.stringify(prior.rounds.at(-1)!.review)), '完整原独审发现与决定必须进入新prompt')
    assert.equal(current.prior!.requestKey, `sync:${attempts[1].id}:elaborate:partition:${prior.partitionBinding!.partitionId}`)
    assert.equal(current.prior!.candidateDigest, prior.candidateDigest); assert.deepEqual(current.prior!.traces, prior.rounds.at(-1)!.traces)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: attempts[1].id, resultRef: source.resultRef, candidateDigest: prior.candidateDigest })
  }
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(current.reviewPassed, true); assert.equal(final.partitionSeal!.passed, true)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), []); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['format', 'format-restart', 'format-pause', 'format-pause-restart', 'format-pause-readset', 'format-pause-selection', 'seed-pause', 'seed-pause-restart', 'seed-pause-owner-cancelled', 'seed-pause-readset', 'seed-pause-selection', 'format-cold-restart', 'seed-cold-restart', 'format-input', 'format-readset', 'format-partition', 'format-selection', 'format-unsettled', 'parent-structure', 'parent-review', 'parent-restart', 'parent-capacity-clear', 'parent-lease-clear', 'accepted-leaf', 'accepted-leaf-restart', 'accepted-leaf-readset', 'accepted-leaf-input', 'accepted-leaf-unreviewed', 'leaves', 'leaves-restart', 'input', 'ancestor', 'readset', 'selection', 'foreign', 'policy', 'unsettled', 'aggregate'] as const) test(`v2局部分区续修 ${mode} 绑定原候选诊断而不串区`, async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01', otherPath = '.spec/project/beta/import-contract/spec.md'
  const candidateSeed = mode.startsWith('seed-'), pauseControl = mode.includes('-pause'), resumeNumber = pauseControl ? 3 : 2
  const threeAttempts = mode.endsWith('-clear') || pauseControl
  const raw = '保留现有导出与导入服务行为，分别完整记录两个模块。'
  const parentBefore = `---\ntitle: 上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const parentSource = `---\ntitle: 上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n本层保留原意，两个模块分别承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留两个模块行为 | user:raw | 不改变原政策 | 现有模块及验收完成 | - |\n`
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY')
  const rawOnly = (source: string) => source.slice(0, source.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [original, other].map(source => { const definition = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(definition.kind, 'VERIFY'); return { definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment } })
  const mandatoryTests = [original, other].map(source => { const acceptance = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'AC')!; assert.equal(acceptance.kind, 'AC'); const [testPath, testId] = acceptance.test.split('#'); return { verificationId: acceptance.command, testPath, testId } })
  const f = await fixture(t, { maxAttempts: threeAttempts ? 3 : 2, maxCalls: 32, maxRepairs: threeAttempts ? 2 : 1, timeoutMs: 180000 }, false, rawOnly(original), 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: otherPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], verifications, mandatoryTests,
  }, undefined, 'spec', undefined, ['selection', 'format-selection', 'format-pause-selection', 'seed-pause-selection', 'format-cold-restart', 'seed-cold-restart'].includes(mode), { [parentPath]: parentBefore, [otherPath]: rawOnly(other), 'src/beta/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js') })
  const admitted = f.operation
  let store = f.store
  const formatFailure = mode.startsWith('format'), formatDenied = ['format-input', 'format-readset', 'format-partition', 'format-selection', 'format-unsettled', 'format-pause-readset', 'format-pause-selection'].includes(mode)
  const parentFailure = mode.startsWith('parent-'), coldCrash = mode.endsWith('cold-restart'), restart = mode.endsWith('restart') && !coldCrash, acceptedLeaf = mode.startsWith('accepted-leaf')
  const calls: { attempt: number; nodeId: string; purpose: string; prompt: string; inputDigest: string }[] = []
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(admitted.id).currentAttemptId!)
    if (request.purpose.startsWith('elaboration_')) {
      const local = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string; path: string }[] }
      const { nodeId, path } = local.targets[0], parent = path === parentPath
      calls.push({ attempt: attempt.number, nodeId, purpose: request.purpose, prompt: request.prompt, inputDigest: request.inputDigest })
      if (request.purpose === 'elaboration_generate') {
        if (mode.endsWith('-clear') && attempt.number === 3) assert.ok(!request.prompt.includes('已结算的拒绝候选'), '较新基础设施失败必须清seed，不复活更早业务拒绝')
        if (['accepted-leaf', 'accepted-leaf-restart'].includes(mode) && attempt.number === 2 && nodeId === 'export-contract') assert.fail('已accept叶P1不得在兄弟修复时重新生成或独审')
        if (pauseControl && attempt.number === 2 && !parent) { if (mode !== 'seed-pause-owner-cancelled') store.requestControl(admitted.id, 'pause'); throw Object.assign(new Error('正式pause中断在途owner，未产生局部结果'), { code: 'cancelled' }) }
        const shouldRepair = attempt.number === resumeNumber && (parentFailure ? parent : !parent && (!acceptedLeaf || nodeId === 'import-contract'))
        const denied = ['seed-pause-readset', 'seed-pause-selection'].includes(mode) || ['input', 'readset', 'selection', 'aggregate'].includes(mode) && nodeId === 'export-contract' || ['ancestor', 'unsettled'].includes(mode)
        if (shouldRepair && !denied && !formatFailure && !coldCrash) {
          assert.ok(request.prompt.includes('已结算的拒绝候选'), `下一attempt ${nodeId}必须收到原局部候选`)
          assert.ok(request.prompt.includes(`候选-${nodeId}-A1`), '必须收到原完整候选正文')
          assert.ok(request.prompt.includes(candidateSeed ? 'reference-kind' : parentFailure && mode === 'parent-structure' ? 'dependency-cycle' : `repair-${nodeId}`), '必须保留原结构或独审具体诊断')
          if (!parent) assert.ok(!request.prompt.includes(`repair-${nodeId === 'export-contract' ? 'import-contract' : 'export-contract'}`), '两个叶的失败诊断不能串区')
        }
        if (shouldRepair && denied) assert.ok(!request.prompt.includes('已结算的拒绝候选'), '绑定变化或聚合结果不能作为本叶续修seed')
        if (formatFailure && !parent) {
          const ownMessage = `原Native-${nodeId}-单JSON失败，保留REQ/AC且不授予decision权限`
          if (attempt.number === 1 && (nodeId === 'export-contract' || coldCrash)) throw new StructuredSessionError('structured_output_format_invalid', ownMessage, { sessionId: 'format-generator', threadId: 'format-generator-thread', turnId: 'format-turn' })
          if (attempt.number === resumeNumber && !coldCrash) {
            if (formatDenied && (nodeId === 'export-contract' || mode === 'format-unsettled' || pauseControl)) assert.ok(!request.prompt.includes(ownMessage), '输入/分区/读取/选择改变或未结算不能承接旧格式诊断')
            else { assert.ok(request.prompt.includes(ownMessage), `${nodeId}须收到自己的精确格式失败`); assert.match(request.prompt, /structured_output_format_invalid/) }
            assert.ok(!request.prompt.includes(`原Native-${nodeId === 'export-contract' ? 'import-contract' : 'export-contract'}-`), '不能收到兄弟格式失败')
          }
        }
        if (parent) {
          if (candidateSeed && attempt.number > 1) assert.fail('candidate续修不能重新生成已accept父接口')
          if (attempt.number === 2 && !parentFailure && !['ancestor', 'unsettled', 'format-unsettled'].includes(mode)) assert.fail('已accept父接口不应重新生成')
          const value = rows(parentSource, parentPath); value.changes[0].nodeId = 'project'
          value.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口由两个模块承接', affectedIds: [parentId] }))
          if (attempt.number === 1 && parentFailure) value.changes[0].prose += ` 候选-${nodeId}-A1`
          if (attempt.number === 1 && mode === 'parent-structure') value.changes[0].tables.REQ[0]['depends-on'] = [parentId]
          if (attempt.number === 2 && mode === 'ancestor') value.changes[0].prose += ' 本轮祖先上下文不同。'
          return value
        }
        const value = rows(nodeId === 'export-contract' ? original : other, path); value.changes[0].nodeId = nodeId
        value.applicability = value.applicability.map(entry => ({ ...entry, affectedIds: [nodeId === 'export-contract' ? 'REQ-EXPORT-01' : 'REQ-IMPORT-01'] }))
        if (!parentFailure) value.changes[0].prose += attempt.number === 1 ? ` 候选-${nodeId}-A1` : ' 本轮已明确补充边界说明。'
        for (const row of value.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
        for (const row of value.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
        if (candidateSeed && attempt.number === 1) value.changes[0].tables.FLOW[0].req = [nodeId === 'export-contract' ? 'RULE-EXPORT-01' : 'RULE-IMPORT-01']
        return value
      }
      if (formatFailure && attempt.number === 1 && !parent && nodeId === 'import-contract') throw new StructuredSessionError('structured_output_format_invalid', `原Native-${nodeId}-单JSON失败，保留REQ/AC且不授予decision权限`, { sessionId: 'format-reviewer', threadId: 'format-reviewer-thread', turnId: 'format-turn' })
      if (mode === 'parent-capacity-clear' && attempt.number === 2 && request.purpose === 'elaboration_review') throw Object.assign(new Error('fixture独审容量失败'), { code: 'failed' })
      if (!formatFailure && attempt.number === 1 && (parentFailure ? parent : !parent && (!acceptedLeaf || nodeId === 'import-contract'))) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: `repair-${nodeId}`, kind: 'repair', message: `repair-${nodeId}`, affectedIds: [parent ? parentId : nodeId === 'export-contract' ? 'REQ-EXPORT-01' : 'REQ-IMPORT-01'], evidence: `原局部候选诊断-${nodeId}`, decision: '在原意内修正这项具体业务说明' }] }
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('定向机制用例在V3前停止'), { code: 'unsupported' })
    return output
  })
  if (mode === 'parent-lease-clear') {
    const claim = store.claimAttempt.bind(store)
    store.claimAttempt = input => {
      const second = store.listAttempts(input.operationId).length === 1
      const claimed = claim({ ...input, leaseMs: second ? 1 : input.leaseMs })
      if (second) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      return claimed
    }
  }
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (pauseControl && store.readAttempt(fence.attemptId).number === 2 && value.stage === 'partition-plan') {
      if (mode === 'format-pause-readset' || mode === 'seed-pause-readset') value.readSetDigest = contentHash('中间控制attempt读取集已变')
      if (mode === 'format-pause-selection' || mode === 'seed-pause-selection') {
        const selected = store.readBaselineSelection(f.input.source, [admitted.baselineSelection!.bindings[0].resource])
        if (!('selection' in selected)) throw new Error(selected.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    if (store.readAttempt(fence.attemptId).number === 1 && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && (JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).changes.some((change: { path: string }) => change.path === contractPath) || formatFailure && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).failure?.message.includes('原Native-export-contract'))) {
      if (mode === 'format-readset') value.readSetDigest = contentHash('不同读取集')
      if (mode === 'format-input' || mode === 'format-partition') {
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()) as ElaborationResult
        if (mode === 'format-input') saved.inputDigest = contentHash('不同业务输入')
        else saved.partitionBinding!.planDigest = contentHash('不同分区计划')
        value.resultRef = writeEvidence(f.input.source.commonDir, saved)
      }
      if (mode === 'readset' || mode === 'accepted-leaf-readset') value.readSetDigest = contentHash('不同读集合')
      if (mode === 'foreign') value.operationId = 'foreign-operation'
      if (mode === 'policy') value.policyDigest = contentHash('不同政策')
      if (mode === 'selection' || mode === 'format-selection') {
        const selection = store.readBaselineSelection(f.input.source, [admitted.baselineSelection!.bindings[0].resource])
        if (!('selection' in selection)) throw new Error(selection.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selection.selection)
      }
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    const result = checkpoint(fence, ref)
    if (mode === 'seed-pause-owner-cancelled' && store.readAttempt(fence.attemptId).number === 2 && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).status === 'cancelled') store.requestControl(admitted.id, 'pause')
    return result
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      const stages = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const target = mode === 'ancestor' ? parentPath : contractPath
      const local = stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { path: string }) => change.path === target))
      if (['input', 'ancestor', 'aggregate', 'accepted-leaf-input', 'accepted-leaf-unreviewed'].includes(mode)) {
        assert.ok(local)
        const prior = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()) as ElaborationResult
        if (mode === 'accepted-leaf-unreviewed') { prior.reviewPassed = false; prior.rounds.at(-1)!.review = null }
        if (mode === 'input' || mode === 'accepted-leaf-input') prior.inputDigest = contentHash('不同局部冻结输入')
        if (mode === 'ancestor') prior.structurePassed = false
        const resultRef = mode === 'aggregate' ? stages.find(stage => stage.stage === 'elaboration').resultRef : writeEvidence(f.input.source.commonDir, prior)
        store.checkpoint(fence, resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, resultRef }))
      }
      if (coldCrash) throw new Error('SavedElab已CAS持久化，attempt.failure写入前模拟进程中断')
      const failed = recordFailure(fence, issue)
      if (restart && !pauseControl) throw new Error('fixture在已持久失败之后模拟进程退出')
      return failed
    }
    return recordFailure(fence, issue)
  }
  if (mode === 'unsettled' || mode === 'format-unsettled') {
    const attempts = store.listAttempts.bind(store)
    store.listAttempts = id => attempts(id).map(attempt => attempt.number === 1 && store.readOperation(id).currentAttemptId !== attempt.id ? { ...attempt, status: 'running' as const } : attempt)
  }
  let result: Awaited<ReturnType<typeof runSyncOperation>>
  if (coldCrash) {
    await assert.rejects(runSyncOperation(store, admitted.id, f.options), /attempt.failure写入前模拟进程中断/)
    const interrupted = store.readAttempt(store.readOperation(admitted.id).currentAttemptId!)
    assert.equal(interrupted.status, 'running'); assert.equal(interrupted.failure, null)
    const persisted = interrupted.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      .filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
    assert.ok(persisted.length > 0)
    const ownerWrapper = persisted.find(stage => {
      const result = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
      return mode.startsWith('seed-') ? result.status === 'exhausted' : result.status === 'failed'
    })
    assert.ok(ownerWrapper)
    assert.equal(ownerWrapper.operationId, admitted.id); assert.equal(ownerWrapper.attemptId, interrupted.id)
    assert.equal(ownerWrapper.inputId, store.readOperation(admitted.id).input.id); assert.equal(ownerWrapper.policyDigest, f.operation.policyDigest)
    assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, ownerWrapper.baselineSelectionRef).toString()).digest, store.readOperation(admitted.id).baselineSelection!.digest)
    assert.ok(persisted.some(stage => {
      const result = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
      return mode.startsWith('seed-') ? result.status === 'exhausted' && result.failure?.code === 'repair_budget_exhausted' && !!result.rounds.at(-1)?.candidate
        : result.status === 'failed' && result.failure?.code === 'structured_output_format_invalid' && result.candidateDigest === null
    }), '真实P1结果及attempt:null failure共存于冷中断记录')
    f.closeForRestart()
    const originalNow = Date.now, coldNow = originalNow() + 60_000
    Date.now = () => coldNow
    try {
      const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
      store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
      result = await runSyncOperation(store, admitted.id, f.options)
      const resumed = store.listAttempts(admitted.id)
      assert.equal(resumed.length, 2)
      assert.equal(resumed[0].status, 'superseded'); assert.equal(resumed[0].failure, null)
    } finally { Date.now = originalNow }
  } else result = await runSyncOperation(store, admitted.id, f.options)
  if (mode === 'parent-lease-clear') {
    assert.equal(result.status, 'recovery_required')
    const leaseAttempt = store.readAttempt(result.operation.currentAttemptId!)
    assert.equal(leaseAttempt.number, 2); assert.equal(leaseAttempt.failure, null)
    assert.equal(leaseAttempt.checkpointRefs.some(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage?.startsWith('partition:')), false, '过期真实claim没有执行任何local P1')
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (pauseControl) {
    assert.equal(result.status, 'paused')
    const paused = store.listAttempts(admitted.id)[1]
    assert.equal(paused.status, 'superseded'); assert.equal(paused.failure, null)
    const locals = paused.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration')).map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult)
    assert.equal(locals.some(local => local.phase !== 'interface_seed'), mode === 'seed-pause-owner-cancelled', '仅真实空cancelled owner可越过控制attempt，不误取同attempt Root accept')
    if (mode === 'seed-pause-owner-cancelled') {
      assert.ok(locals.some(local => local.phase === 'interface_seed' && local.reviewPassed))
      const owner = locals.find(local => local.status === 'cancelled')!
      assert.ok(owner); assert.equal(owner.rounds[0].candidate, null); assert.equal(owner.rounds[0].review, null); assert.deepEqual(owner.rounds[0].findings, [])
    }
    if (restart) {
      f.closeForRestart()
      const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
      store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    }
    store.requestControl(admitted.id, 'run')
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (restart && !pauseControl) {
    assert.equal(store.listAttempts(admitted.id).length, 1)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (coldCrash) {
    const replayed = calls.filter(call => call.attempt === 2 && call.purpose === 'elaboration_generate' && call.nodeId !== 'project')
    assert.equal(replayed.length, 2)
    for (const call of replayed) {
      const category = call.nodeId === 'export-contract' ? 'EXPORT' : 'IMPORT'
      const own = mode.startsWith('seed-') ? `FLOW-${category}-01.req` : `原Native-${call.nodeId}-单JSON失败`
      assert.ok(call.prompt.includes(own), `冷恢复必须把同owner的原P1拒绝反馈给${call.nodeId}`)
      const sibling = `FLOW-${category === 'EXPORT' ? 'IMPORT' : 'EXPORT'}-01.req`
      assert.ok(!call.prompt.includes(sibling), 'P1原件不能跨owner串用')
      if (mode.startsWith('seed-')) assert.ok(call.prompt.includes('已结算的拒绝候选'))
      else assert.match(call.prompt, /structured_output_format_invalid/)
    }
  }
  if (mode === 'foreign' || mode === 'policy') {
    assert.equal(result.failure!.code, 'stage_binding')
    assert.equal(calls.filter(call => call.attempt === 2 && call.nodeId === 'export-contract').length, 0)
    assert.equal(store.listJournals(admitted.id).length, 0)
    return
  }

  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, failure: result.failure, attempts: store.listAttempts(admitted.id).map(attempt => ({ failure: attempt.failure, findings: attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(stage => stage.stage === 'elaboration').map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).rounds.flatMap((round: { findings: { code: string; message: string }[] }) => round.findings.map(({ code, message }) => ({ code, message })))) })), calls: calls.map(({ prompt: _prompt, ...call }) => call) }))
  const attempts = store.listAttempts(admitted.id)
  assert.equal(attempts.length, threeAttempts ? 3 : 2)
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const retryStages = stages[pauseControl ? 2 : 1]
  const localStages = retryStages.filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
  if (coldCrash) {
    const parentStage = stages[0].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
    assert.ok(parentStage)
    assert.deepEqual(retryStages.find(stage => stage.stage === parentStage.stage).resultRef, parentStage.resultRef, '冷恢复沿用原父接口accepted ref')
    for (const call of calls.filter(item => item.attempt === 2 && item.purpose === 'elaboration_generate' && item.nodeId !== 'project')) {
      const source = stages[0].find(stage => {
        if (!stage.stage?.startsWith('partition:') || !stage.stage.endsWith(':elaboration')) return false
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
        return mode.startsWith('seed-')
          ? saved.changes.some(change => change.nodeId === call.nodeId)
          : saved.failure?.message.includes(`原Native-${call.nodeId}-单JSON失败`)
      })
      assert.ok(source, `原owner ${call.nodeId} 的SavedElab结果必须存在`)
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
      if (mode.startsWith('seed-')) {
        assert.ok(call.prompt.includes(JSON.stringify(saved.rounds.at(-1)!.candidate)))
        assert.ok(call.prompt.includes(JSON.stringify(saved.rounds.at(-1)!.output)))
      } else {
        assert.ok(call.prompt.includes(source.resultRef.sha256), 'diagnostic prompt须绑定原SavedElab resultRef')
        assert.match(call.prompt, /structured_output_format_invalid/)
        assert.ok(call.prompt.includes(saved.failure!.message))
      }
    }
  }
  if (formatFailure && !formatDenied) {
    const parentStage = stages[0].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
    assert.deepEqual(retryStages.find(stage => stage.stage === parentStage.stage).resultRef, parentStage.resultRef, '已accept父接口沿真实原ref承接')
    for (const stage of stages[0].filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && stage.stage !== parentStage.stage)) {
      const previous = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
      assert.equal(previous.reviewPassed, false, 'generation完成但无独审不能成为accepted缓存')
      assert.equal(previous.failure!.code, 'structured_output_format_invalid')
      const currentStage = retryStages.find(current => current.stage === stage.stage)
      const current = JSON.parse(readEvidence(f.input.source.commonDir, currentStage.resultRef).toString()) as ElaborationResult
      assert.notDeepEqual(currentStage.resultRef, stage.resultRef)
      assert.equal(current.inputDigest, previous.inputDigest, '诊断不改变业务输入摘要')
      assert.equal(current.rounds.at(-1)!.review!.verdict, 'accept', '未审产物重新生成后仍须新独审')
      assert.equal(previous.partitionBinding!.partitionId, current.partitionBinding!.partitionId)
      const nodeId = current.changes[0].nodeId
      const next = calls.find(call => call.attempt === resumeNumber && call.nodeId === nodeId && call.purpose === 'elaboration_generate')!
      assert.ok(next.prompt.includes(stage.resultRef.sha256), '真实prompt须绑定原失败resultRef')
      assert.notEqual(next.inputDigest, calls.find(call => call.attempt === 1 && call.nodeId === nodeId && call.purpose === 'elaboration_generate')!.inputDigest)
      if (previous.rounds[0].output !== null) assert.ok(next.prompt.includes(JSON.stringify(previous.rounds[0].output)), '独审格式失败保留实际上一输出')
    }
  }
  if (['accepted-leaf', 'accepted-leaf-restart'].includes(mode)) {
    const source = stages[0].find(stage => stage.stage?.endsWith(':elaboration') && stage.stage.startsWith('partition:') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { path: string }) => change.path === contractPath))
    assert.deepEqual(retryStages.find(stage => stage.stage === source.stage).resultRef, source.resultRef)
    const provenance = retryStages.find(stage => stage.stage === `${source.stage}:provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: admitted.id, fromAttemptId: attempts[0].id, resultRef: source.resultRef })
  }
  for (const current of localStages) {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, current.resultRef).toString()) as ElaborationResult
    if (!value.prior) continue
    const source = stages[0].find(stage => stage.stage === current.stage)
    const previous = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    assert.deepEqual(value.prior.traces, previous.rounds.at(-1)!.traces)
    assert.equal(value.prior.candidateDigest, previous.rounds.at(-1)!.candidateDigest)
    const provenance = retryStages.find(stage => stage.stage === `${current.stage}:repair-provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: admitted.id, fromAttemptId: attempts[0].id, resultRef: source.resultRef, candidateDigest: value.prior.candidateDigest })
    if (!threeAttempts) assert.equal(value.rounds.at(-1)!.review!.verdict, 'accept', '续修后仍须重新独审')
  }
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages.at(-1)!.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(final.phase, 'partitioned_final'); assert.equal(final.partitionSeal!.passed, true)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.deepEqual(result.operation.budget, admitted.budget); assert.equal(result.operation.deadlineAtMs, admitted.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(store.listJournals(admitted.id).length, 0)
})

for (const mode of ['live', 'restart', 'precise', 'readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance', 'raw', 'context', 'authorization', 'policy', 'plan', 'analysis', 'descendants', 'failed', 'unreviewed', 'global-seal'] as const) test(`v2跨attempt承接 ${mode} 已接受父接口的严格边界`, async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01'
  const raw = '保留当前导出契约，由现有导出服务完成请求及结果下载。'
  const parentBefore = `---\ntitle: 导出上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const leafBefore = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const parentSource = `---\ntitle: 导出上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层声明原意，由现有服务承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留现有导出行为 | user:raw | 不改变原政策 | 既有导出流程及验收完成 | - |\n`
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 120000 }, false, leafBefore, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'],
  }, undefined, 'spec', undefined, ['precise', 'readset', 'selection', 'foreign-provenance'].includes(mode), { [parentPath]: parentBefore })
  let store = f.store
  const shouldReuse = ['live', 'restart', 'precise'].includes(mode)
  let firstParentInput: ElaborationInput | undefined
  const calls: { attempt: number; purpose: string; parent: boolean }[] = []
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('elaboration_')) {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[]; context: { path: string; source: string }[] }
      const parent = frozen.targets[0].path === parentPath
      calls.push({ attempt: attempt.number, purpose: request.purpose, parent })
      if (parent && attempt.number > 1 && shouldReuse) throw Object.assign(new Error('已接受父接口不得在叶修复attempt重新生成或独审'), { code: 'unsupported' })
      if (request.purpose === 'elaboration_generate') {
        if (parent) {
          if (attempt.number === 1) {
            const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as Omit<ElaborationInput, 'root' | 'base' | 'files' | 'targets'> & { execution: { root: string; base: string }; files: [string, string][]; targets: (ElaborationInput['targets'][number] & { targetIndex: number })[] }
            firstParentInput = { ...frozen, ...frozen.execution, targets: frozen.targets.map(({ targetIndex: _targetIndex, ...target }) => target), files: new Map(frozen.files), requestKey: request.requestKey }
          }
          const value = rows(parentSource, parentPath)
          value.changes[0].nodeId = 'project'
          value.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口由叶实现各边界', affectedIds: [parentId] }))
          return value
        }
        assert.ok(frozen.context.find(source => source.path === parentPath)?.source.includes(parentId), '叶必须读取已独审父接口全文')
        const child = rows(original)
        for (const row of child.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
        for (const row of child.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
        if (attempt.number === 1) child.applicability.pop()
        return child
      }
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('机制回归在Docker前停止'), { code: 'unsupported' })
    return output
  })
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (['readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance'].includes(mode) && store.readAttempt(fence.attemptId).number === 1
      && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).phase === 'interface_seed') {
      if (mode === 'readset') value.readSetDigest = contentHash('另一个读集合')
      if (mode === 'missing-readset') delete value.readSetDigest
      if (mode === 'foreign-provenance') checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...value, operationId: 'another-operation' }))
      if (mode === 'selection' || mode === 'foreign-provenance') {
        const selected = store.readBaselineSelection(f.input.source, [f.operation.baselineSelection!.bindings[0].resource])
        if (!('selection' in selected)) throw new Error(selected.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      if (mode === 'foreign-operation') value.operationId = 'another-operation'
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      const stages = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const parent = stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
      assert.ok(parent, JSON.stringify(issue))
      const prior = JSON.parse(readEvidence(f.input.source.commonDir, parent.resultRef).toString()) as ElaborationResult
      assert.equal(prior.structurePassed, true); assert.equal(prior.reviewPassed, true)
      assert.equal(freezeElaborationInput(firstParentInput!).inputDigest, prior.inputDigest)
      if (!shouldReuse && !['readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance'].includes(mode)) {
        const changed = structuredClone(firstParentInput!)
        if (mode === 'raw') changed.intent.rawSource += ' 本轮原意变化'
        if (mode === 'context') changed.context = [{ nodeId: 'ancestor', path: '.spec/ancestor/spec.md', source: '真实祖先上下文已变化' }]
        if (mode === 'authorization') changed.authorizedChanges = [{ id: parentId, action: 'retire', source: 'user:raw', reason: '本轮授权不同' }]
        if (mode === 'policy') changed.verifications = [{ ...changed.verifications![0], timeoutMs: changed.verifications![0].timeoutMs + 1 }]
        if (['raw', 'context', 'authorization', 'policy'].includes(mode)) {
          prior.inputDigest = freezeElaborationInput(changed).inputDigest
          assert.notEqual(prior.inputDigest, freezeElaborationInput(firstParentInput!).inputDigest)
        }
        if (mode === 'plan') prior.partitionBinding!.planDigest = contentHash('另一个计划')
        if (mode === 'analysis') prior.partitionBinding!.analysisRef = { sha256: contentHash('另一个独审分析') }
        if (mode === 'descendants') prior.partitionBinding!.interfaceSeed!.descendants = []
        if (mode === 'failed') prior.failure = { code: 'fixture_failure', message: '失败seed不能复用' }
        if (mode === 'unreviewed') { prior.reviewPassed = false; prior.rounds.at(-1)!.review = null }
        if (mode === 'global-seal') { prior.phase = 'partitioned_final'; prior.status = 'complete' }
        const resultRef = writeEvidence(f.input.source.commonDir, prior)
        store.checkpoint(fence, resultRef)
        store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...parent, resultRef }))
      }
      const failed = recordFailure(fence, issue)
      if (mode === 'restart') throw new Error('fixture SQLite边界：首attempt已持久结算')
      return failed
    }
    return recordFailure(fence, issue)
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'restart') {
    assert.equal(store.listAttempts(f.operation.id).length, 1)
    f.closeForRestart()
    const reopened = openProtocol(join(f.parent, 'sync.sqlite'))
    t.after(() => reopened.close())
    store = new SyncStore(reopened, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) })
    f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  const attempts = store.listAttempts(f.operation.id)
  assert.equal(attempts.length, 2)
  if (mode === 'foreign-operation') {
    assert.equal(result.failure!.code, 'stage_binding')
    assert.deepEqual(calls.filter(call => call.parent).map(call => call.attempt), [1, 1])
    assert.equal(store.listJournals(f.operation.id).length, 0)
    return
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, failure: result.failure, calls }))
  assert.deepEqual(calls.filter(call => call.parent).map(call => [call.attempt, call.purpose]), shouldReuse
    ? [[1, 'elaboration_generate'], [1, 'elaboration_review']]
    : [[1, 'elaboration_generate'], [1, 'elaboration_review'], [2, 'elaboration_generate'], [2, 'elaboration_review']])
  assert.deepEqual(calls.filter(call => !call.parent).map(call => [call.attempt, call.purpose]), [[1, 'elaboration_generate'], [2, 'elaboration_generate'], [2, 'elaboration_review']])
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const parentStage = stages[0].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
  assert.ok(parentStage)
  const prior = JSON.parse(readEvidence(f.input.source.commonDir, parentStage.resultRef).toString()) as ElaborationResult
  assert.equal(prior.structurePassed, true); assert.equal(prior.reviewPassed, true)
  assert.equal(prior.rounds.at(-1)!.review!.verdict, 'accept')
  if (shouldReuse) assert.deepEqual(stages[1].find(stage => stage.stage === parentStage.stage).resultRef, parentStage.resultRef, '原父resultRef/review/traces逐字保持')
  const provenanceStage = stages[1].find(stage => stage.stage === `${parentStage.stage}:provenance`)
  if (shouldReuse) {
    assert.ok(provenanceStage)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenanceStage.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: attempts[0].id, resultRef: parentStage.resultRef })
  } else assert.equal(provenanceStage, undefined, '不同绑定或未接受结果不能生成复用provenance')
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages[1].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(final.phase, 'partitioned_final'); assert.equal(final.partitionSeal!.passed, true)
  if (shouldReuse) assert.deepEqual(final.partitionEvidence!.find(item => item.resultRef.sha256 === parentStage.resultRef.sha256)?.resultRef, parentStage.resultRef)
  const failed = JSON.parse(readEvidence(f.input.source.commonDir, stages[0].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(failed.partitionSeal!.passed, false, '首轮全局失败不能被当作已审seal复用')
  assert.notEqual(final.candidateDigest, failed.candidateDigest)
  assert.equal(result.operation.callsUsed, f.calls.length)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(store.listJournals(f.operation.id).length, 0)
})

test('v2最终预算按真实ready投影跳过GAP跨边，两端独立分支用恰好预算推进', async t => {
  const localPath = '.spec/alpha/export-contract/spec.md', otherPath = '.spec/beta/import-contract/spec.md'
  const local = original.replace('code:\n', `related:\n  - ${otherPath}\ncode:\n`)
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY').replace('code:\n', `related:\n  - ${localPath}\ncode:\n`)
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [original, other].map(source => { const item = parseContract({ nodeId: 'fixture', path: localPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(item.kind, 'VERIFY'); return { definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment } })
  const gapId = 'GAP-EXPORT-CROSS-RETRY'
  const withGap = `${local}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${gapId} | missing_fact | 两个模块重试如何关联 | RULE-EXPORT-06,RULE-IMPORT-06 | 原意未定义跨模块重试 | 明确跨模块重试政策 | user:raw | REQ-EXPORT-01 |\n`
  const retry = other.split('\n').find(line => line.startsWith('| RULE-IMPORT-06 '))!
  const linked = other.replace(retry, retry.replace(/ \|$/, ',RULE-EXPORT-06 |'))
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 }, false, local, 'alpha', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', targets: [{ nodeId: 'export-contract', path: localPath }, { nodeId: 'import-contract', path: otherPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], verifications,
  }, undefined, 'spec', undefined, false, { [otherPath]: other, 'src/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/import.js') })
  let reviews = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[] }
      const path = frozen.targets[0].path, generated = rows(path === localPath ? withGap : linked, path)
      generated.changes[0].nodeId = path === localPath ? 'export-contract' : 'import-contract'
      return generated
    }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request)
      return { version: 'sync-files-v1', changes: frozen.elaboratedSpecs.map(spec => { const entry = frozen.manifest.entries.find(entry => entry.path === spec.path)!; return { path: spec.path, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content: spec.source } }) }
    }
    if (request.purpose === 'code_review') {
      assert.ok(!request.requestKey.includes(':final:edge:'), '受GAP阻断的跨边没有实际ready义务')
      const frozen = promptInput(request)
      assert.ok(frozen.readyIds.length > 0)
      assert.ok(!frozen.readyIds.some(id => [gapId, 'RULE-EXPORT-06', 'RULE-IMPORT-06'].includes(id)))
      if (++reviews === 2) throw Object.assign(new Error('已证明精确预算到达全部最终独审，在真实Docker前停止'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(reviews, 2, JSON.stringify({ status: result.status, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  assert.equal(result.operation.callsUsed, 8)
  const attempt = f.store.listAttempts(f.operation.id)[0]
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string; resultRef?: { sha256: string } }[]
  const plan = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'candidate-partition-plan')!.resultRef!).toString()) as { dependencies: unknown[] }
  assert.ok(plan.dependencies.length > 0, '真实跨边仍保留在完整契约计划')
  const budget = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'partition-generation-budget')!.resultRef!).toString()) as { minimumCalls: number; remainingCalls: number; requiredKeys: string[] }
  assert.equal(budget.minimumCalls, 4); assert.equal(budget.remainingCalls, 4)
  assert.deepEqual([...budget.requiredKeys].sort(), attempt.dispatchPlans.filter(dispatch => ['code_generate', 'implementation_plan', 'code_review'].includes(dispatch.purpose)).map(dispatch => dispatch.key).sort())
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('v2分区完整最少调用超过原预算时启动前诊断，不调模型或超扣', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 4, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code')
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.failure!.code, 'partition_budget_insufficient')
  assert.match(result.failure!.message, /至少需要 5 次调用，剩余 4 次/)
  assert.equal(result.operation.callsUsed, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


test('v2新功能的精确文件计划先取得真实P4租约及readSet，再生成同最终候选独审', async t => {
  const raw = original.split('## expanded spec')[0].replace(/^code:\n(?:  -.*\n)+/m, '').replace('contract-schema: sync-v1\n', '')
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, raw, 'project', original, { version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: [contractPath] } }, undefined, 'spec', undefined, true)
  let finalReview = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { affectedIds: string[]; ruleIds: string[] }[] }
      for (const change of value.changes) { change.affectedIds = []; change.ruleIds = [] }
    }
    if (request.purpose === 'elaboration_generate') {
      const value = output as GeneratedElaboration
      for (const change of value.changes) { change.code = []; for (const rows of Object.values(change.tables)) for (const row of rows) if (typeof row.source === 'string' && row.source.startsWith('code:')) row.source = 'derived:REQ-EXPORT-01' }
    }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), spec = frozen.elaboratedSpecs[0]
      assert.ok(frozen.manifest.entries.every(entry => entry.path !== 'src/planned-new.js'))
      const text = spec.source.replace(/^code:.*\n(?:  -.*\n)*/m, '').replace(/^contract-schema:.*$/m, 'contract-schema: sync-v1\ncode:\n  - src/planned-new.js#ExportService')
      const before = frozen.manifest.entries.find(entry => entry.path === spec.path)!
      return { version: 'sync-files-v1', changes: [{ path: 'src/planned-new.js', beforeDigest: null, beforeMode: null, mode: '100644', content: readFileSync(join(f.root, 'src/export.js'), 'utf8') }, { path: spec.path, beforeDigest: before.digest, beforeMode: before.mode, mode: null, content: text }] }
    }
    if (request.purpose === 'code_review') { finalReview = true; throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' }) }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(finalReview, true, JSON.stringify({ status: result.status, failure: result.failure, phase: result.operation.phase, generation: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).checkpointRefs.flatMap(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { candidateValidated?: boolean; status?: string; failure?: unknown; validationFindings?: unknown[] }; return value.candidateValidated !== undefined ? [{ status: value.status, failure: value.failure, validationFindings: value.validationFindings?.slice(0, 4) }] : [] }) : [], findings: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).checkpointRefs.flatMap(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { rounds?: { findings: { severity: string; code: string; message: string }[] }[] }; return value.rounds?.flatMap(round => round.findings.filter(finding => finding.severity === 'error').slice(0, 4)) ?? [] }) : [], calls: f.calls.map(call => call.purpose), attempt: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).failure : null }))
  assert.ok(f.calls.some(call => call.purpose === 'implementation_plan'))
  assert.ok(result.operation.scope.paths.includes('src/planned-new.js'))
  assert.ok(result.operation.baselineSelection!.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === 'src/planned-new.js' && 'bytePair' in binding && binding.bytePair === null))
  assert.ok(result.operation.contractScopeExpansions!.some(expansion => expansion.paths?.includes('src/planned-new.js')))
  assert.equal(existsSync(join(f.root, 'src/planned-new.js')), false)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


test('v2有限修复复用已审分区分析/P1时，最低调用不再次索要已完成阶段预算', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 6, maxRepairs: 1, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code')
  let reviews = 0
  f.transform((output, request) => {
    if (request.purpose !== 'code_review') return output
    if (++reviews === 2) throw Object.assign(new Error('已证明第二次独审到达，在Docker前停止'), { code: 'unsupported' })
    const value = output as { verdict: string; findings: unknown[] }
    value.verdict = 'repair'; value.findings = [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#ExportService', evidence: '第一次独审具体核验未完成', counterexample: '需要重走下载分支', message: '保原已审Spec/代码字节并重查' }]
    return value
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(reviews, 2, JSON.stringify(result.failure))
  assert.equal(result.operation.callsUsed, 6)
  assert.equal(f.calls.filter(call => call.purpose === 'code_behavior_analyze').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'code_generate').length, 0)
})

test('v2无验证基线的提交删除把真实before正文作为source_before送入最终生成和独审', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 })
  f.git('reset', '--hard', 'HEAD')
  const parentPath = join(f.root, '.spec/project/spec.md'), parent = readFileSync(parentPath, 'utf8')
  assert.ok(parent.includes('[[export-contract]]'))
  writeFileSync(parentPath, parent.replaceAll('[[export-contract]]', '导出契约'))
  f.git('add', '.spec/project/spec.md'); f.git('commit', '-m', 'isolate lifecycle fixture from parent navigation')
  const before = await captureInputSnapshot(f.root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const oldSpec = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === contractPath)!.oid).toString('utf8')
  const oldCode = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === 'src/export.js')!.oid).toString('utf8')
  const oldTest = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === 'tests/export.test.mjs')!.oid).toString('utf8')
  f.git('rm', contractPath)
  f.git('commit', '-m', 'remove exported specification')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const removed = readFileSync(join(f.root, 'src/export.js'))
  const contract = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!
  const affectedIds = contract.items.map(item => item.id)
  const ruleIds = affectedIds.filter(id => /^(REQ|RULE|TR)-/.test(id))
  const rawSource = parseParts(original)?.rawSource
  assert.ok(rawSource)
  const plan: SyncCoordinatorPlan = { ...f.plan, version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before, paths: [contractPath] }, targets: [{ nodeId: 'export-contract', path: contractPath, rawSource }] }
  const admitted = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, { ingressKey: snapshot.id, rootCauseId: snapshot.id, origin: 'combined', budget: { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 }, managedRoot: f.managedRoot }))
  f.useOperation(admitted)
  f.options.plan = plan
  f.options.readCurrentPlan = () => plan
  let sawGenerate = false, sawReview = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      assert.ok(context.changedPaths.includes(contractPath), JSON.stringify(context.changedPaths))
      return { changes: context.changedPaths.map(path => ({ kind: path === contractPath ? 'allowed_change' : 'refactor', paths: [path], affectedIds: path === contractPath ? affectedIds : ['RULE-EXPORT-05'], ruleIds, originalIntent: '导出契约由这次提交删除', previousBehavior: '提交前Spec保留完整义务', sourceBehavior: '当前提交不再包含该Spec', deliveryBehavior: '没有已验证交付', evidence: `真实树差 ${path}`, counterexample: '旧AC不能再从当前Spec读到' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: context.changedPaths.includes(contractPath) ? [{ path: contractPath, content: null, mode: null }] : [] }
    }
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { nodeChanges?: { action: string }[] }
      if (frozen.nodeChanges?.some(change => change.action === 'retire')) return { version: 'elaboration-rows-v2', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '旧节点已由真实提交删除并逐项退役，候选无剩余业务对象', affectedIds: [] })) }
    }
    if (request.purpose === 'code_generate' || request.purpose === 'code_review') {
      const frozen = promptInput(request)
      const prior = frozen.priorContext?.find(item => item.role === 'source_before')
      assert.ok(prior, request.purpose)
      assert.equal(prior.pairId, undefined)
      assert.equal(prior.snapshot.id, before.id)
      assert.equal(prior.snapshot.immutableTree, before.immutableTree)
      const bodies = new Map(prior.files)
      assert.equal(bodies.get(contractPath), oldSpec)
      assert.equal(bodies.get('src/export.js'), oldCode)
      assert.equal(bodies.get('tests/export.test.mjs'), oldTest)
      const currentEntry = prior.entries.find(entry => entry.path === contractPath)
      const actualEntry = beforeEntries.find(entry => entry.path === contractPath)!
      assert.equal(currentEntry?.mode, actualEntry.mode)
      assert.equal(currentEntry?.digest, actualEntry.digest)
      assert.equal(new Map(frozen.files).has(contractPath), false)
      assert.equal(frozen.priorContext!.some(item => item.role === 'verified_delivery'), false)
      assert.ok(request.prompt.includes('role为source_before时明确不是verifiedDelivery'))
      assert.ok(frozen.readyIds.includes('AC-EXPORT-03'))
      if (request.purpose === 'code_generate') { sawGenerate = true; return { version: 'sync-files-v1', changes: [] } }
      sawReview = true
      throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, admitted.id, f.options)
  const debugStage = f.store.listAttempts(admitted.id).flatMap(attempt => attempt.checkpointRefs).map(ref => JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString())).find(stage => stage.stage === 'elaboration')
  const debugElaboration = debugStage ? JSON.parse(readEvidence(snapshot.source.commonDir, debugStage.resultRef).toString()) : null
  assert.equal(sawGenerate, true, JSON.stringify({ elaboration: debugElaboration?.rounds?.map((round: { findings: unknown[] }) => round.findings), phase: result.status, failure: result.failure, attempts: f.store.listAttempts(admitted.id).map(attempt => ({ status: attempt.status, failure: attempt.failure })) }))
  assert.equal(sawReview, true, JSON.stringify(result.failure))
  assert.equal(result.failure?.code, 'unsupported')
  assert.equal(f.store.listJournals(admitted.id).length, 0)
  assert.equal(existsSync(join(f.root, contractPath)), false)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), removed)
})

test('协调器拒绝related glob命中超出全局readPaths的旧helper', async t => {
  const relatedSpec = original.replace('  - src/export.js#ExportService\n', '  - src/export.js#ExportService\nrelated:\n  - src/helpers/**/*.js\n')
  const budget = { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120_000 }
  const f = await fixture(t, budget, false, relatedSpec, 'project', relatedSpec)
  f.git('reset', '--hard', 'HEAD')
  const parentPath = join(f.root, '.spec/project/spec.md'), parent = readFileSync(parentPath, 'utf8')
  writeFileSync(parentPath, parent.replaceAll('[[export-contract]]', '导出契约'))
  const helperPath = 'src/helpers/format.js'
  mkdirSync(join(f.root, 'src/helpers'), { recursive: true })
  writeFileSync(join(f.root, helperPath), '// coordinator helper\nexport function format(value) { return String(value) }\n')
  f.git('add', '-A'); f.git('commit', '-m', 'isolate lifecycle fixture and add related helper')
  const before = await captureInputSnapshot(f.root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const oldSpec = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === contractPath)!.oid).toString('utf8')
  const contract = parseContract({ nodeId: 'export-contract', path: contractPath, source: oldSpec }).contract!
  f.git('rm', contractPath); f.git('commit', '-m', 'remove spec while retaining related helper')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const rawSource = parseParts(oldSpec)?.rawSource
  assert.ok(rawSource)
  const plan: SyncCoordinatorPlan = {
    ...f.plan,
    version: 'sync-coordinator-v2', direction: 'spec_to_code',
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524_288, maxParallel: 2 },
    readPaths: ['.spec', 'src/export.js', 'tests'], sourcePaths: ['src/export.js'],
    commitTrigger: { before, paths: [contractPath] },
    targets: [{ nodeId: 'export-contract', path: contractPath, rawSource }],
  }
  const admitted = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, {
    ingressKey: snapshot.id, rootCauseId: snapshot.id, origin: 'combined', budget, managedRoot: f.managedRoot,
  }))
  f.useOperation(admitted)
  f.options.plan = plan
  f.options.readCurrentPlan = () => plan
  const affectedIds = contract.items.map(item => item.id)
  const ruleIds = affectedIds.filter(id => /^(REQ|RULE|TR)-/.test(id))
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      return {
        changes: context.changedPaths.map(path => ({ kind: path === contractPath ? 'allowed_change' : 'refactor', paths: [path], affectedIds: path === contractPath ? affectedIds : ['RULE-EXPORT-05'], ruleIds, originalIntent: '导出契约由这次提交删除', previousBehavior: '提交前Spec保留完整义务', sourceBehavior: '当前提交不再包含该Spec', deliveryBehavior: '没有已验证交付', evidence: `真实树差 ${path}`, counterexample: '旧AC不能再从当前Spec读到' })),
        facts: [], acceptanceChanges: [], newNodes: [],
        resolutions: context.changedPaths.includes(contractPath) ? [{ path: contractPath, content: null, mode: null }] : [],
      }
    }
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { nodeChanges?: { action: string }[] }
      if (frozen.nodeChanges?.some(change => change.action === 'retire')) return { version: 'elaboration-rows-v2', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '旧节点已由真实提交删除并逐项退役，候选无剩余业务对象', affectedIds: [] })) }
    }
    return output
  })
  const result = await runSyncOperation(f.store, admitted.id, f.options)
  assert.equal(result.failure?.code, 'historical_context_binding', JSON.stringify({ status: result.status, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  assert.ok(f.calls.some(call => call.purpose === 'elaboration_generate'))
  assert.equal(f.calls.some(call => call.purpose === 'code_generate' || call.purpose === 'code_review'), false)
})

// 草稿使用原生工作树及持久coordinator接缝；受控runner不代表真实LLM验收。
test('Native P1草稿跨attempt从真实Git原文件续改，小回执保持成功而业务坏JSON单独拒绝', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'spec', 'claude:MiniMax-M3.1-Flash')
  const calls: ElaborationSessionRequest[] = [], invalid = `{ INVALID_COORDINATOR_DRAFT${'x'.repeat(38_000)}`
  f.options.runner = async request => {
    calls.push(request)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    const workspace = join(f.parent, `native-draft-${calls.length}`), seed = request.worktree!
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (request.purpose === 'elaboration_review') {
      assert.equal(seed.mode, 'read'); assert.ok(!readTree(f.input.source.commonDir, seed.tree).some(entry => entry.path.startsWith('.spex-sync-drafts/')))
      assert.doesNotMatch(request.prompt, /仓库相对测试路径#稳定用例ID/)
      throw Object.assign(new Error('受控草稿coordinator验证在P2前停止'), { code: 'unsupported' })
    }
    assert.equal(request.purpose, 'elaboration_generate'); assert.equal(seed.mode, 'edit')
    assert.match(request.prompt, /仓库相对测试路径#稳定用例ID/)
    const draftPath = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
    if (attempt.number === 2) {
      assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), invalid); assert.match(request.prompt, /output_json/); assert.ok(!request.prompt.includes(invalid))
    }
    mkdirSync(join(workspace, draftPath, '..'), { recursive: true })
    writeFileSync(join(workspace, draftPath), attempt.number === 1 ? invalid : JSON.stringify({ version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用冻结完整契约', affectedIds: [] })) }))
    execFileSync('git', ['-C', workspace, 'add', draftPath], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'normal draft commit'], { stdio: 'pipe' })
    const output = { summary: '已正常提交草稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `thread-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  await runSyncOperation(f.store, f.operation.id, f.options)
  const attempts = f.store.listAttempts(f.operation.id)
  assert.equal(attempts.length, 2); assert.deepEqual(calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  for (const attempt of attempts) {
    const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.ok(stages.some(stage => stage.stage === 'elaboration-draft-protocol'))
    const wrapper = stages.find(stage => stage.stage === 'elaboration'), saved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
    assert.deepEqual(saved.rounds[0].output, { summary: '已正常提交草稿' }); assert.equal(saved.rounds[0].rejectedOutput, undefined); assert.ok(saved.rounds[0].draft)
    if (attempt.number === 1) { assert.equal(saved.rounds[0].candidate, null); assert.ok(saved.rounds[0].findings.some(issue => issue.code === 'output_json')) }
    else assert.ok(stages.some(stage => stage.stage === 'elaboration:draft-provenance'))
  }
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('已审Native JSON经P1合法null扩域及V1拒绝后，跨纯暂停attempt继续原Git草稿', async t => {
  const source = original.split('\n').map(line => line.startsWith('| AC-EXPORT-') ? line.replace(' | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |', ' | code:src/export.js#ExportService | REQ-EXPORT-01 |') : line).join('\n')
  const f = await fixture(t, { maxAttempts: 4, maxCalls: 12, maxRepairs: 2, timeoutMs: 120_000 }, false, source, 'project', source, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', writePaths: ['.spec'], sourcePaths: ['src'],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 },
    commitTrigger: { before: null, paths: ['src/export.js'] },
  }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', true)
  let draft: NonNullable<ElaborationResult['rounds'][number]['draft']> | undefined, draftBytes = '', firstInput = '', continued = false, emptyAttempt = ''
  const originalArtifacts: string[] = []
  const originalRunner = f.options.runner!
  f.options.runner = async request => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    const seed = request.worktree!, workspace = join(f.parent, `accepted-draft-${attempt.number}-${request.purpose}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (request.purpose.startsWith('code_behavior_')) {
      const generated = await originalRunner({ ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) })
      const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(generated.output))
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'normal P0 draft'], { stdio: 'pipe' })
      const output = { summary: '正常提交P0草稿' }
      return { ...generated, output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
    }
    assert.ok(request.purpose.startsWith('elaboration_'), 'V1拒绝前不派P2独审或代码生成')
    if (request.purpose === 'elaboration_generate') {
      const path = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
      if (attempt.number > 1) {
        assert.ok(draft)
        const priorDraft = draft, entry = readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === priorDraft.path)
        assert.ok(entry, '合法null扩域后的新Native seed必须承接正式已审JSON')
        assert.equal(entry.oid, draft.oid); assert.equal(readObject(f.input.source.commonDir, entry.oid).toString('utf8'), draftBytes)
        const schema = readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path.replace(/\.json$/, '.schema.json'))!
        assert.equal(contentHash(readObject(f.input.source.commonDir, schema.oid)), draft.schemaDigest)
        assert.notEqual(request.inputDigest, firstInput); assert.ok(request.prompt.includes('旧accept不继承')); assert.ok(!request.prompt.includes('"priorDraft":null'))
        continued = true
        throw Object.assign(new Error('已核真实seed草稿身份，受控回归在新批准前停止'), { code: 'unsupported' })
      }
      firstInput = request.inputDigest
      const generated = rows(source)
      for (const acceptance of generated.changes[0].tables.AC) acceptance.source = `code:tests/export.test.mjs#${String(acceptance.id)}`
      draftBytes = JSON.stringify(adaptElaborationNativeOutput(request, generated))
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), draftBytes)
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'accepted owner draft'], { stdio: 'pipe' })
    }
    const output = request.purpose === 'elaboration_generate' ? { summary: '实际JSON草稿已提交' } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `accepted-draft-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const recordFailure = f.store.recordFailure.bind(f.store)
  f.store.recordFailure = (fence, issue) => {
    const attempt = f.store.readAttempt(fence.attemptId)
    const failed = recordFailure(fence, issue)
    if (attempt.number !== 1 || issue.code !== 'generation_failed') return failed
    const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const local = stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
    const accepted = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()) as ElaborationResult
    const whole = stages.find(stage => stage.stage === 'elaboration'), generation = stages.find(stage => stage.stage === 'generation')
    const generated = JSON.parse(readEvidence(f.input.source.commonDir, generation.resultRef).toString()) as import('./generation-types.js').GenerationResult
    assert.equal(accepted.reviewPassed, true); assert.equal(accepted.structurePassed, true); assert.equal(generated.candidateValidated, false)
    assert.ok(generated.validationFindings.some(finding => finding.code === 'anchor-dead'))
    draft = accepted.rounds.at(-1)!.draft!
    assert.equal(readObject(f.input.source.commonDir, draft.oid).toString('utf8'), draftBytes)
    const current = f.store.readOperation(f.operation.id), priorSelection = JSON.parse(readEvidence(f.input.source.commonDir, local.baselineSelectionRef).toString()) as NonNullable<typeof current.baselineSelection>
    assert.notEqual(local.readSetDigest, current.readSetDigest)
    for (const binding of priorSelection.bindings) assert.ok(current.baselineSelection!.bindings.some(item => JSON.stringify(item) === JSON.stringify(binding)))
    assert.ok(current.contractScopeExpansions!.some(expansion => expansion.evidenceRef.sha256 === whole.resultRef.sha256))
    originalArtifacts.push(JSON.stringify(accepted), JSON.stringify(generated))
    f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
    const queued = f.store.readOperation(f.operation.id)
    const empty = f.store.claimQueuedAttempt({ operationId: f.operation.id, source: f.input.source, scope: queued.scope, leaseMs: 30_000, expectedRevision: queued.revision }).attempt
    emptyAttempt = empty.id
    f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
    assert.deepEqual(empty.checkpointRefs, []); assert.deepEqual(empty.dispatchPlans, []); assert.equal(empty.composedInput, null)
    return f.store.readOperation(f.operation.id)
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(continued, true, JSON.stringify({ status: result.status, failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, failure: attempt.failure })) }))
  assert.equal(f.store.readAttempt(emptyAttempt).status, 'superseded')
  const initial = f.store.listAttempts(f.operation.id)[0], stages = initial.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const currentArtifacts = [stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration')), stages.find(stage => stage.stage === 'generation')].map(stage => readEvidence(f.input.source.commonDir, stage.resultRef).toString())
  assert.deepEqual(currentArtifacts, originalArtifacts)
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('已有reserved P1在SQLite冷恢复后草稿协议缺席仍不补签或改写历史派发', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 4, maxRepairs: 0, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'spec', 'claude:MiniMax-M3.1-Flash')
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
  const reserved = f.store.reserveDispatch(claimed.fence, { key: `sync:${claimed.attempt.id}:historical-reserved-p1`, purpose: 'elaboration_review', requestDigest: contentHash('frozen original historical request') })
  const originalReservation = JSON.stringify(reserved)
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  let observed = false
  f.options.runner = async request => {
    observed = true; assert.equal(request.purpose, 'elaboration_generate'); assert.equal(request.worktree!.mode, 'read')
    assert.match(request.prompt, /不直接改文件/); assert.doesNotMatch(request.prompt, /草稿文件=/)
    assert.notDeepEqual(request.schema, { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] })
    throw Object.assign(new Error('历史reserved保持验证到此停止'), { code: 'unsupported' })
  }
  await runSyncOperation(store, f.operation.id, f.options)
  const attempt = store.readAttempt(claimed.attempt.id)
  assert.equal(observed, true); assert.equal(JSON.stringify(attempt.dispatchPlans.find(item => item.key === reserved.key)), originalReservation)
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  assert.equal(stages.some(stage => stage.stage === 'elaboration-draft-protocol'), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const [guidance, purpose] of [
  ['absent', 'elaboration_generate'],
  ['ac-test-binding-v1', 'elaboration_generate'],
  ['ac-test-flow-binding-v2', 'elaboration_generate'],
  ['ac-test-flow-binding-v2', 'elaboration_review'],
  [ELABORATION_GENERATION_GUIDANCE_V3, 'elaboration_generate'],
  [ELABORATION_GENERATION_GUIDANCE_V3, 'elaboration_review'],
  [ELABORATION_GENERATION_GUIDANCE_V4, 'elaboration_generate'],
  [ELABORATION_GENERATION_GUIDANCE_V4, 'elaboration_review'],
  [ELABORATION_GENERATION_GUIDANCE, 'elaboration_generate'],
  [ELABORATION_GENERATION_GUIDANCE, 'elaboration_review'],
] as const) test(`P1提示按attempt冻结，冷恢复原reserved请求 guidance=${guidance} purpose=${purpose}`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 4, maxRepairs: 0, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'spec', 'claude:default')
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
  const commonDir = f.input.source.commonDir
  const expectedProtocol = { version: 'elaboration-draft-v1',
    ...(guidance === 'absent' ? {} : { generationGuidance: guidance }),
    ...(guidance === ELABORATION_GENERATION_GUIDANCE ? { compactSealDiagnostics: true, citationRepairDiagnostics: 'actionable-v1', defaultExportCitation: true } : {}),
  }
  if (guidance !== ELABORATION_GENERATION_GUIDANCE) {
    const value = expectedProtocol, resultRef = writeEvidence(commonDir, value)
    const wrapper = writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'elaboration-draft-protocol', resultRef })
    f.store.checkpoint(claimed.fence, { ...wrapper, artifacts: syncCheckpointArtifacts(value, resultRef) })
  }
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    if (JSON.parse(readEvidence(commonDir, ref).toString()).stage === 'elaboration') throw Object.assign(new Error('测试在写入P1结果前模拟进程边界'), { code: 'SYNC_FENCE_EXPIRED' })
    return checkpoint(fence, ref)
  }
  const requests: ElaborationSessionRequest[] = [], review = purpose === 'elaboration_review'
  f.options.runner = async request => {
    if (review && request.purpose === 'elaboration_generate') {
      assert.equal(request.worktree!.mode, 'edit')
      const seed = request.worktree!, draftPath = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, 'reserved-review-draft')
      f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
      mkdirSync(join(workspace, draftPath, '..'), { recursive: true })
      writeFileSync(join(workspace, draftPath), JSON.stringify({ version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用完整冻结契约', affectedIds: [] })) }))
      execFileSync('git', ['-C', workspace, 'add', draftPath], { stdio: 'pipe' })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'reserved review fixture draft'], { stdio: 'pipe' })
      const dispatch = f.store.readAttempt(claimed.attempt.id).dispatchPlans.find(item => item.key === request.requestKey)!, output = { summary: '实际草稿已提交' }
      return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: 'reserved-review-generation', turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
    }
    assert.equal(request.purpose, purpose); assert.equal(request.worktree!.mode, review ? 'read' : 'edit')
    requests.push(request)
    throw Object.assign(new Error('只核对reserved请求，不在此用例运行模型'), { code: 'unsupported' })
  }
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'recovery_required')
  const before = f.store.readAttempt(claimed.attempt.id), reservation = before.dispatchPlans.at(-1)!
  assert.equal(before.dispatchPlans.length, review ? 2 : 1); assert.equal(reservation.key, requests[0].requestKey); assert.equal(reservation.session, null)
  const marker = before.checkpointRefs.find(ref => JSON.parse(readEvidence(commonDir, ref).toString()).stage === 'elaboration-draft-protocol')!
  const markerBytes = readEvidence(commonDir, marker)
  const version = JSON.parse(readEvidence(commonDir, JSON.parse(markerBytes.toString()).resultRef).toString())
  assert.deepEqual(version, expectedProtocol)
  const reviewGuidance = guidance === ELABORATION_GENERATION_GUIDANCE_V3 || guidance === ELABORATION_GENERATION_GUIDANCE_V4 || guidance === ELABORATION_GENERATION_GUIDANCE
  assert.equal(requests[0].prompt.includes('仓库相对测试路径#稳定用例ID'), review ? reviewGuidance : guidance !== 'absent')
  assert.equal(requests[0].prompt.includes('TR.from、TR.event'), !review && (guidance === 'ac-test-flow-binding-v2' || reviewGuidance))
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) }); f.useStore(store)
  const resumed = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(resumed.status, 'unsupported'); assert.equal(resumed.operation.callsUsed, review ? 2 : 1)
  assert.equal(requests.length, 2)
  const { signal: _originalSignal, ...originalRequest } = requests[0], { signal: _resumedSignal, ...resumedRequest } = requests[1]
  assert.deepEqual(resumedRequest, originalRequest)
  const after = store.readAttempt(claimed.attempt.id)
  assert.deepEqual(after.dispatchPlans, before.dispatchPlans)
  assert.deepEqual(after.checkpointRefs.filter(ref => JSON.parse(readEvidence(commonDir, ref).toString()).stage === 'elaboration-draft-protocol'), [marker])
  assert.deepEqual(readEvidence(commonDir, marker), markerBytes)
})

for (const missingRef of [false, true]) test(`Native whole已审draft接受缓存重核实际Git，missingRef=${missingRef}`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'spec', 'claude:MiniMax-M3.1-Flash')
  const calls: string[] = []
  f.options.runner = async request => {
    calls.push(request.purpose)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    if (request.purpose === 'code_generate') {
      if (attempt.number === 1) {
        if (missingRef) {
          const wrapper = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'elaboration')
          const saved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult, draft = saved.rounds.at(-1)!.draft!
          f.git('update-ref', '-d', `refs/spex-sync/drafts/${draft.ownerDigest}/${draft.resultCommit}`)
        }
        throw new StructuredSessionError('structured_output_format_invalid', '受控P2格式失败触发原预算内新attempt')
      }
      throw Object.assign(new Error('缓存验证在实际P2前停止'), { code: 'unsupported' })
    }
    const seed = request.worktree!, workspace = join(f.parent, `native-cached-draft-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (request.purpose === 'elaboration_generate') {
      const draftPath = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
      mkdirSync(join(workspace, draftPath, '..'), { recursive: true }); writeFileSync(join(workspace, draftPath), JSON.stringify({ version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用完整冻结契约', affectedIds: [] })) }))
      execFileSync('git', ['-C', workspace, 'add', draftPath], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'cached draft'], { stdio: 'pipe' })
    }
    const output = request.purpose === 'elaboration_generate' ? { summary: '实际草稿已提交' } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `cached-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(calls.filter(purpose => purpose === 'elaboration_generate').length, 1); assert.equal(calls.filter(purpose => purpose === 'elaboration_review').length, 1)
  assert.equal(calls.filter(purpose => purpose === 'code_generate').length, missingRef ? 1 : 2, JSON.stringify(result.failure))
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('原Native请求冷验沿ZCode精准read policy，旧缺席不补且实际prompt/schema/seed仍严格', () => {
  const request: ElaborationSessionRequest = { root: '/fixture', base: 'a'.repeat(40), worktree: { mode: 'read', baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40) }, purpose: 'code_review', prompt: 'original review', schema: { type: 'object' }, requestKey: 'sync:attempt:generation:final:edge:code_review', inputDigest: 'input', timeoutMs: null, model: 'zcode:fixture/model', effort: 'high' }
  const binding = { attemptId: 'attempt', policyDigest: 'policy' }
  const policy = pinZCodeToolPolicy(request, null)!
  const native = { ...request, zcodeToolPolicy: policy }
  assert.equal(continuationCoordinator.nativeReviewRequestMatches(native, request, binding), true)
  assert.equal(continuationCoordinator.nativeReviewRequestMatches(request, request, binding), true)
  assert.equal(request.zcodeToolPolicy, undefined, '冷验不回填历史字段')
  assert.throws(() => continuationCoordinator.nativeReviewRequestMatches(request, { ...request, zcodeToolPolicy: policy }, binding), StructuredSessionError, '旧缺席不能由新请求补policy')
  for (const patch of [{ prompt: 'foreign' }, { schema: { type: 'string' } }, { model: 'zcode:fixture/other' }, { worktree: { ...request.worktree!, tree: 'c'.repeat(40) } }]) assert.equal(continuationCoordinator.nativeReviewRequestMatches({ ...native, ...patch }, request, binding), false)
  assert.throws(() => continuationCoordinator.nativeReviewRequestMatches({ ...native, zcodeToolPolicy: { version: 1, toolDenylist: [] } as unknown as typeof policy }, request, binding), StructuredSessionError)
})

test('Coordinator Native Spec→Code scratch构建后6→1→1沿原builder来源冷验', async t => {
  const definitions = ['export', 'import', 'archive', 'report', 'download', 'upload'].map(word => ({ word, upper: word.toUpperCase(), nodeId: `${word}-contract`, path: word === 'export' ? contractPath : `.spec/project/${word}/${word}-contract/spec.md`, sourcePath: word === 'export' ? 'src/export.js' : `src/${word}/${word}.js`, testPath: word === 'export' ? 'tests/export.test.mjs' : `tests/${word}.test.mjs` }))
  const specs = new Map(definitions.map(item => [item.nodeId, original.replaceAll('export-job', `${item.word}-job`).replaceAll('EXPORT', item.upper).replaceAll('export-contract', item.nodeId).replaceAll('src/export.js', item.sourcePath).replaceAll('tests/export.test.mjs', item.testPath).replaceAll(`decision:${item.upper}-POLICY`, 'decision:EXPORT-POLICY')]))
  const extras = Object.fromEntries(definitions.slice(1).flatMap(item => [[item.path, specs.get(item.nodeId)!], [item.sourcePath, readFileSync(new URL('src/export.js', fixturePath), 'utf8')], [item.testPath, readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', item.upper).replaceAll('src/export.js', item.sourcePath)]]))
  const verifications = definitions.map(item => { const rule = parseContract({ nodeId: item.nodeId, path: item.path, source: specs.get(item.nodeId)! }).contract!.items.find(rule => rule.kind === 'VERIFY')!; assert.equal(rule.kind, 'VERIFY'); return { definition: { id: rule.id, command: rule.command, cwd: rule.cwd, timeoutMs: rule.timeoutMs }, environment: { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 131072 } } })
  const f = await fixture(t, { mode: 'unlimited' }, false, original, 'project', original, { version: 'sync-coordinator-v2', agentWorkflow: 'native-worktree-v1', direction: 'spec_to_code', targets: definitions.map(({ nodeId, path }) => ({ nodeId, path })), readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec', 'src'], sourcePaths: ['src'], verifications, mandatoryTests: definitions.map(item => ({ verificationId: `VERIFY-${item.upper}-01`, testPath: item.testPath, testId: `AC-${item.upper}-01` })), partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: definitions.map(item => item.path) } }, undefined, 'spec', 'claude:MiniMax-M3.1-Flash', true, extras)
  const renewals: { attemptId: string; at: number }[] = [], renew = f.store.renewLease.bind(f.store)
  f.store.renewLease = (fence, duration) => { const result = renew(fence, duration); renewals.push({ attemptId: fence.attemptId, at: Date.now() }); return result }
  const calls: { attempt: number; purpose: string; key: string }[] = []
  f.options.runner = async request => {
    f.calls.push(request)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    calls.push({ attempt: attempt.number, purpose: request.purpose, key: request.requestKey })
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; approvedSpecs: string[]; allowedScope: { paths: string[] } } : null
    let output: unknown, witness: ReturnType<typeof nativeWorktreeResult> | undefined
    if (request.purpose === 'code_behavior_analyze') {
      output = { changes: task!.requiredChangedPaths.map((path: string) => { const owner = definitions.find(item => item.path === path || item.sourcePath === path)!; return { kind: 'refactor', paths: [path], affectedIds: [`RULE-${owner.upper}-05`], ruleIds: [`RULE-${owner.upper}-05`], originalIntent: '原明确契约保持', previousBehavior: '当前导出流程', sourceBehavior: '当前导出流程', deliveryBehavior: '当前导出流程', evidence: '完整冻结Spec/source/tests均相同业务', counterexample: '内部注释不改变任何行为' } }), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis!
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map((item: { id: string }) => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate' || request.purpose === 'code_generate') {
      assert.equal(attempt.number, 1, '格式续审不得派新P1或代码builder')
      const scratch = join(f.parent, `scratch-${calls.length}`), seed = request.worktree!
      f.git('worktree', 'add', '--detach', scratch, seed.baseCommit)
      if (request.purpose === 'elaboration_generate') {
        const path = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
        mkdirSync(join(scratch, path, '..'), { recursive: true })
        writeFileSync(join(scratch, path), JSON.stringify({ version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '已有完整冻结契约保持不变', affectedIds: [] })) }))
        execFileSync('git', ['-C', scratch, 'add', path], { stdio: 'pipe' })
      } else {
        const owner = definitions.find(item => task!.approvedSpecs.includes(item.path))!
        writeFileSync(join(scratch, owner.sourcePath), readFileSync(join(scratch, owner.sourcePath), 'utf8') + '\n// actual Coordinator scratch build\n')
        execFileSync('git', ['-C', scratch, 'add', owner.sourcePath], { stdio: 'pipe' })
      }
      execFileSync('git', ['-C', scratch, 'commit', '-m', 'real scratch result'], { stdio: 'pipe' })
      output = { summary: '真实scratch提交' }; witness = nativeWorktreeResult(scratch, seed)
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_review') {
      const binding = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0])
      output = { inputId: binding.inputId, candidateDigest: binding.candidateDigest, verdict: 'accept', checkedIds: binding.requiredIds, findings: [] }
      if (binding.requiredIds.includes('REQ-UPLOAD-01')) {
        if (attempt.number >= 3) throw Object.assign(new Error('目标Coordinator多轮冷验已证，Docker前停止'), { code: 'unsupported' })
        return rejectedReviewFixture(f, request, '原评审完整回答：\n' + JSON.stringify(output))
      }
    } else assert.fail(request.purpose)
    if (request.purpose.startsWith('code_behavior_')) {
      witness = committedDraftFixture(f, request, output, join(f.parent, `scratch-p0-${calls.length}`))
      output = { summary: '真实P0业务JSON已正常提交' }
    }
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `native-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), ...(witness ? { worktree: witness } : {}) }
  }
  const claim = f.store.claimQueuedAttempt.bind(f.store)
  f.store.claimQueuedAttempt = input => { if (f.store.listAttempts(f.operation.id).length >= 3) throw new Error('fixture阻止错误热循环'); return claim(input) }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const gaps = renewals.slice(1).flatMap((item, index) => item.attemptId === renewals[index].attemptId ? [item.at - renewals[index].at] : [])
  console.info('controlled lease proof', JSON.stringify({ leaseMs: f.options.leaseMs, heartbeatMs: f.options.heartbeatMs, maximumRenewalGapMs: Math.max(...gaps) }))
  assert.deepEqual([1, 2, 3].map(number => calls.filter(call => call.attempt === number && call.purpose === 'code_review').length), [6, 1, 1], JSON.stringify({ failure: result.failure, calls, maximumRenewalGapMs: Math.max(...gaps) }))
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 6)
  assert.equal(calls.filter(call => call.attempt > 1 && call.purpose.startsWith('elaboration_')).length, 0)
  const attempts = f.store.listAttempts(f.operation.id), stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const generations = stages.map(values => JSON.parse(readEvidence(f.input.source.commonDir, values.find(value => value.stage === 'generation').resultRef).toString()))
  for (const generated of generations) assert.deepEqual(generated.candidate, generations[0].candidate)
  assert.notDeepEqual(readTree(f.input.source.commonDir, generations[0].candidate.tree).filter(entry => entry.path.startsWith('src/')), readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => entry.path.startsWith('src/')))
  for (const values of stages.slice(1)) assert.equal(values.some(value => /^partition:.*:generation$/.test(value.stage ?? '')), false, '不把原builder prepared伪装为新attempt成功')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const defect of ['none', 'recording-continuation', 'recording-continuation-failed', 'recording-continuation-resource', 'failed-continuation', 'failed-continuation-drift', 'deferred-implementation', 'deferred-native-mismatch', 'metadata-parent', 'edge', 'edge-valid', 'review-budget', 'review-budget-keys', 'model', 'source', 'oracle', 'configuration', 'request', 'policy', 'impact', 'readset', 'scope', 'partial', 'candidate', 'generation', 'analysis', 'elaboration', 'review', 'v3', 'publication'] as const) test(`正式retryOf在V3前置unsupported后零模型调用续验真实冻结候选 defect=${defect}`, { timeout: 180000 }, async t => {
  const recording = defect.startsWith('recording-continuation')
  const multiple = ['edge', 'edge-valid', 'review-budget-keys'].includes(defect)
  const importedPath = '.spec/project/import/import-contract/spec.md'
  const imported = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY').replace(/(\| REQ-IMPORT-01 \|[^\n]+)\| - \|/, '$1| REQ-EXPORT-01 |')
  const definitions = [{ nodeId: 'export-contract', path: contractPath, sourcePath: 'src/export.js', source: original }, ...multiple ? [{ nodeId: 'import-contract', path: importedPath, sourcePath: 'src/import/import.js', source: imported }] : []]
  const items = definitions.flatMap(item => parseContract(item).contract!.items)
  const verification = items.find(item => item.kind === 'VERIFY')!
  assert.equal(verification.kind, 'VERIFY')
  const syncSettings: import('./settings.js').SyncSettings = { version: 'sync-settings-v1', nodeIds: ['export-contract'], sourcePaths: ['src'], testPaths: ['managed-tests'], readPaths: ['package.json', 'tests'], verifications: [{ definition: { id: verification.id, command: verification.command, cwd: verification.cwd, timeoutMs: verification.timeoutMs }, environment: { version: 'trusted-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 131072 } }], mandatoryTests: [{ verificationId: verification.id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }], facts: [], budget: { mode: 'unlimited' } }
  const executionScope = { paths: definitions.flatMap(item => [item.path, item.sourcePath]), contractIds: items.filter(item => !['FLOW', 'VERIFY'].includes(item.kind)).map(item => item.id).sort(), flowIds: items.filter(item => item.kind === 'FLOW').map(item => item.id).sort() }
  if (multiple) {
    syncSettings.nodeIds = definitions.map(item => item.nodeId)
    const verify = items.find(item => item.id === 'VERIFY-IMPORT-01')!; assert.equal(verify.kind, 'VERIFY')
    syncSettings.verifications.push({ ...syncSettings.verifications[0], definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs } })
  }
  const extras: Readonly<Record<string, string>> = multiple ? { [importedPath]: imported, 'src/import/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/import/import.js') } : {}
  const f = await fixture(t, { mode: 'unlimited' }, false, original, 'project', original, { version: 'sync-coordinator-v2', agentWorkflow: 'native-worktree-v1', direction: 'spec_to_code', targets: definitions.map(({ nodeId, path }) => ({ nodeId, path })), sourcePaths: ['src'], executionScope, ...(multiple ? { verifications: syncSettings.verifications } : {}), partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: definitions.map(item => item.path) } }, undefined, 'spec', 'claude:default', true, extras, true, syncSettings, defect === 'metadata-parent')
  await f.realTools()
  let currentStore = f.store
  let active = f.operation, preflightFails = true, containerExists = false, containerState = 'created'
  const calls: string[] = [], versionCalls: string[] = []
  const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', truncated: false })
  f.options.verificationDriver = async argv => {
    if (argv[0] === 'version') { versionCalls.push(active.id); return preflightFails ? { ...ok(), exitCode: 1, stderr: 'controlled transport preflight unavailable' } : ok(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.4.3' })) }
    if (argv[0] === 'image') return ok(JSON.stringify([{ Id: 'sha256:image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]))
    const resource = currentStore.listRecoverableResources().find(item => item.operation.id === active.id && item.resource.plan.kind === 'verification')!.resource
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint, config = checkpoint.config
    if (argv[1] === 'inspect') return containerExists ? ok(JSON.stringify([{ Id: 'a'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: config.policy.cwd === '.' ? '/candidate' : `/candidate/${config.policy.cwd}`, Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: config.policy.memoryBytes, MemorySwap: config.policy.memoryBytes, NanoCpus: config.policy.cpus * 1e9, PidsLimit: config.policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(config.policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: containerState, Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }])) : { ...ok(), exitCode: 1, stderr: 'Error: No such container' }
    if (argv[1] === 'create') { containerExists = true; containerState = 'created'; return ok('a'.repeat(64)) }
    if (argv[1] === 'start') { containerState = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'logs') return ok([...config.policy.expectedTestIds.map(id => JSON.stringify({ type: defect === 'recording-continuation-failed' ? 'test:fail' : 'test:pass', data: { name: `${id} controlled`, nesting: 0 } })), JSON.stringify({ type: 'test:summary', data: { counts: { tests: config.policy.expectedTestIds.length }, success: defect !== 'recording-continuation-failed' } })].join('\n'))
    if (argv[1] === 'rm') { containerExists = false; return ok('a'.repeat(64)) }
    assert.fail(`unexpected controlled verification command ${argv}`)
  }
  f.options.runner = async request => {
    calls.push(request.purpose)
    if (defect === 'model') assert.equal(request.model, active.model, '正式显式换模型沿新选择重新生成及独审')
    else assert.equal(active.id, f.operation.id, '同model续验不能重新派发P0/P1/builder/独审')
    const attempt = currentStore.readAttempt(currentStore.readOperation(active.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; approvedSpecs: string[] } : null
    let output: unknown, worktree: ReturnType<typeof nativeWorktreeResult> | undefined
    if (request.purpose === 'code_behavior_analyze') output = { changes: task!.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [path.includes('import') ? 'RULE-IMPORT-05' : 'RULE-EXPORT-05'], ruleIds: [path.includes('import') ? 'RULE-IMPORT-05' : 'RULE-EXPORT-05'], originalIntent: '保原导出业务', previousBehavior: '导出行为不变', sourceBehavior: '导出行为不变', deliveryBehavior: '导出行为不变', evidence: path, counterexample: '内部注释不改行为' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis!
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map((item: { id: string }) => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') output = { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '完整冻结契约保持', affectedIds: [] })) }
    else if (request.purpose === 'elaboration_review') output = defect.startsWith('deferred-') ? { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'implementation-review', kind: 'repair', affectedIds: ['RULE-EXPORT-05'], message: '业务契约保持，实际实现与验收由P2完成', evidence: 'src/export.js#ExportService 与 tests/export.test.mjs#AC-EXPORT-03 的冻结实现和验收', decision: '按原授权实现并完整验证，不修改业务义务' }] } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_review') {
      const binding = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0])
      output = { inputId: binding.inputId, candidateDigest: binding.candidateDigest, verdict: 'accept', checkedIds: binding.requiredIds, findings: [] }
    } else assert.equal(request.purpose, 'code_generate')
    if (request.worktree!.mode === 'edit') {
      const workspace = join(f.parent, `candidate-retry-${calls.length}`), seed = request.worktree!
      f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
      const path = request.purpose === 'code_generate' ? definitions.find(item => task!.approvedSpecs.includes(item.path))!.sourcePath : /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
      mkdirSync(join(workspace, path, '..'), { recursive: true })
      writeFileSync(join(workspace, path), request.purpose === 'code_generate' ? readFileSync(join(workspace, path), 'utf8') + '\n// reviewed candidate retry fixture\n' : JSON.stringify(output))
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'normal frozen candidate stage'], { stdio: 'pipe' })
      worktree = nativeWorktreeResult(workspace, seed); output = { summary: '真实Git提交' }
    }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `candidate-retry-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), ...(worktree ? { worktree } : {}) }
  }
  const failed = await runSyncOperation(f.store, active.id, f.options)
  assert.equal(failed.failure?.code, 'verification_unsupported', JSON.stringify({ failure: failed.failure, calls }))
  const parent = failed.operation, origin = currentStore.readAttempt(parent.currentAttemptId!)
  assert.ok(origin.candidate); assert.equal(origin.verification, null)
  assert.equal(currentStore.listRecoverableResources().length, 0); assert.equal(currentStore.listJournals(parent.id).length, 0)
  const originalCalls = calls.length
  if (!multiple) assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review'])
  else assert.equal(calls.filter(purpose => purpose === 'code_review').length, 3, '双owner完整候选包含两个local及一个真实edge独审')
  if (defect === 'metadata-parent') assert.notEqual(origin.publicationBase!.parentCommit, parent.input.headCommit, '只读oracle工作区字节形成真实metadata parent')
  if (defect.startsWith('deferred-')) {
    const stage = origin.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
    const approved = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
    assert.equal(approved.structurePassed, true); assert.equal(approved.reviewPassed, true); assert.equal(approved.status, 'complete')
    assert.equal(approved.rounds.at(-1)!.review!.verdict, 'repair', '保留原独审repair，不补签为accept')
    assert.ok(approved.deferredImplementationFindings.some(finding => finding.code === 'implementation-review'))
    assert.equal(hasApprovedElaborationReview(approved), true)
    assert.equal(hasApprovedElaborationReview({ ...approved, reviewPassed: false }), false)
    assert.equal(hasApprovedElaborationReview({ ...approved, deferredImplementationFindings: [] }), false)
    assert.equal(hasApprovedElaborationReview({ ...approved, rounds: approved.rounds.map(round => ({ ...round, review: round.review && { ...round.review, findings: round.review.findings.map(issue => ({ ...issue, code: 'business-repair' })) } })) }), false)
  }
  const originalHistory = JSON.stringify({ operation: parent, attempts: currentStore.listAttempts(parent.id) })
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const applicationRuntime = join(f.parent, 'retry-application')
  const application = await SyncApplication.create(f.root, { protocol, runtimeDirectory: applicationRuntime, tools: f.options.tools })
  application.start = () => {}
  await application.enable()
  const store = application.store; f.useStore(store); currentStore = store
  f.options.managedRoot = join(applicationRuntime, 'managed'); f.options.artifactRoot = join(applicationRuntime, 'artifacts')
  const originalRefs = origin.checkpointRefs.map(ref => ({ ref, stage: (JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }).stage }))
  if (!['none', 'recording-continuation', 'recording-continuation-failed', 'recording-continuation-resource', 'failed-continuation', 'failed-continuation-drift', 'deferred-implementation', 'metadata-parent', 'edge-valid'].includes(defect)) {
    const request = { nodeId: 'export-contract', requestId: `reject-frozen-${defect}`, retryOf: parent.id, ...(defect === 'model' ? { model: 'claude:other-model' } : {}) }
    active = (await application.submit(request)).operation!
    active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
    const readOperation = store.readOperation.bind(store), readAttempt = store.readAttempt.bind(store)
    const path = defect === 'source' ? 'src/export.js' : defect === 'oracle' ? 'tests/export.test.mjs' : defect === 'configuration' ? '.spec/spexcode.json' : null
    const bytes = path ? readFileSync(join(f.root, path)) : null
    if (path) writeFileSync(join(f.root, path), Buffer.concat([bytes!, Buffer.from('\n// changed input\n')]))
    store.readOperation = id => {
      const operation = readOperation(id)
      if (id !== parent.id) return operation
      if (defect === 'request') return { ...operation, requestBlob: { sha256: contentHash('different authored intent') } }
      if (defect === 'policy') return { ...operation, policyDigest: contentHash('different policy') }
      if (defect === 'impact') return { ...operation, impactDigest: contentHash('different impact') }
      if (defect === 'readset') return { ...operation, readSetDigest: contentHash('different readset') }
      if (defect === 'scope') return { ...operation, scope: { ...operation.scope, paths: [] } }
      if (defect === 'partial') return { ...operation, blockedScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
      return operation
    }
    store.readAttempt = id => {
      const attempt = readAttempt(id)
      if (id !== origin.id) return attempt
      if (defect === 'candidate') return { ...attempt, candidate: { ...attempt.candidate!, tree: f.input.immutableTree } }
      if (defect === 'publication') return { ...attempt, publicationBase: { ...attempt.publicationBase!, parentCommit: f.git('rev-parse', 'HEAD^') } }
      if (defect === 'review-budget-keys') {
        const budget = originalRefs.find(item => item.stage === 'partition-generation-budget')!.ref
        const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, budget).toString())
        const value = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { requiredKeys: string[] }
        const altered = { ...value, requiredKeys: value.requiredKeys.filter(key => !key.includes(':final:edge:')) }
        const resultRef = writeEvidence(f.input.source.commonDir, altered), replacement = writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef })
        return { ...attempt, checkpointRefs: attempt.checkpointRefs.map(ref => ref.sha256 === budget.sha256 ? { ...replacement, artifacts: syncCheckpointArtifacts(altered, resultRef) } : ref) }
      }
      if (defect === 'edge') {
        const aggregate = originalRefs.find(item => item.stage === 'generation')!.ref
        const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, aggregate).toString())
        const generation = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as import('./generation-types.js').GenerationResult
        const edge = generation.partitionEvidence!.find(member => member.partitionId.startsWith('edge:'))!
        const altered = { ...generation, partitionEvidence: generation.partitionEvidence!.filter(member => member !== edge), traces: generation.traces.filter(trace => !edge.traces.some(item => item.sessionId === trace.sessionId)) }
        const resultRef = writeEvidence(f.input.source.commonDir, altered), replacement = writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef })
        return { ...attempt, checkpointRefs: attempt.checkpointRefs.map(ref => ref.sha256 === aggregate.sha256 ? { ...replacement, artifacts: syncCheckpointArtifacts(altered, resultRef) } : ref) }
      }
      const removed = originalRefs.filter(item => defect === 'review-budget' ? item.stage === 'partition-generation-budget' : defect === 'generation' ? item.stage === 'generation' : defect === 'analysis' ? item.stage === 'analysis' : defect === 'elaboration' ? item.stage === 'elaboration' : defect === 'review' || defect === 'deferred-native-mismatch' ? item.stage?.startsWith('injected:') && item.stage.endsWith(':code_review') : defect === 'v3' ? item.stage?.startsWith('v3:') : false).map(item => item.ref.sha256)
      return { ...attempt, checkpointRefs: attempt.checkpointRefs.filter(ref => !removed.includes(ref.sha256)) }
    }
    try {
      const rejected = await runSyncOperation(store, active.id, f.options)
      assert.equal(rejected.operation.phase, path ? 'conflicted' : 'failed', JSON.stringify(rejected.failure))
      assert.ok(path ? rejected.failure?.code === 'input_changed' : defect === 'model' ? rejected.failure?.code === 'verification_unsupported' : (['candidate_retry_binding', 'retry_provenance_binding'].includes(rejected.failure?.code ?? '') || defect === 'publication' && rejected.failure?.message.includes('SYNC_PUBLICATION_BASE_BINDING')), JSON.stringify(rejected.failure))
      assert.equal(rejected.operation.callsUsed, defect === 'model' ? 4 : 0); assert.equal(calls.length, defect === 'model' ? originalCalls + 4 : originalCalls)
      if (defect === 'model') assert.deepEqual(calls.slice(originalCalls), calls.slice(2, originalCalls), '显式新model保留已批准P0，正常重做后续生成与独审')
      assert.equal(store.listJournals(active.id).length, 0)
    } finally {
      store.readOperation = readOperation; store.readAttempt = readAttempt
      if (path) writeFileSync(join(f.root, path), bytes!)
    }
    assert.equal(JSON.stringify({ operation: store.readOperation(parent.id), attempts: store.listAttempts(parent.id) }), originalHistory)
    return
  }
  let retryParent = parent.id
  let emptySuccessor: { operation: SyncOperation; attempt: SyncAttempt } | null = null
  if (defect.startsWith('failed-continuation')) {
    const retry = { nodeId: 'export-contract', requestId: 'first-candidate-authentication-retry', retryOf: parent.id }
    active = (await application.submit(retry)).operation!
    active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
    const readAttempt = store.readAttempt.bind(store), listAttempts = store.listAttempts.bind(store)
    const rejectedRef = originalRefs.filter(item => item.stage?.startsWith('injected:') && item.stage.endsWith(':elaboration_review')).map(item => item.ref.sha256)
    const missingReview = (attempt: SyncAttempt): SyncAttempt => attempt.id === origin.id ? { ...attempt, checkpointRefs: attempt.checkpointRefs.filter(ref => !rejectedRef.includes(ref.sha256)) } : attempt
    store.readAttempt = id => missingReview(readAttempt(id)); store.listAttempts = id => listAttempts(id).map(missingReview)
    const authenticationFailure = await runSyncOperation(store, active.id, f.options)
    store.readAttempt = readAttempt; store.listAttempts = listAttempts
    assert.equal(authenticationFailure.operation.phase, 'failed'); assert.equal(authenticationFailure.operation.callsUsed, 0)
    const failedAttempt = store.readAttempt(authenticationFailure.operation.currentAttemptId!)
    assert.deepEqual(failedAttempt.dispatchPlans, []); assert.equal(failedAttempt.candidate, null); assert.equal(failedAttempt.verification, null)
    assert.equal(store.listRecoverableResources().length, 0); assert.equal(store.listJournals(active.id).length, 0)
    emptySuccessor = { operation: authenticationFailure.operation, attempt: failedAttempt }
    const originalFailure = JSON.stringify(emptySuccessor)
    assert.equal((await application.submit({ ...retry, requestId: 'same-parent-still-coalesces' })).operation!.id, active.id, '同parent保持原幂等，不借新requestId创建新op或resume')
    retryParent = active.id
    if (defect === 'failed-continuation-drift') {
      active = (await application.submit({ nodeId: 'export-contract', requestId: 'latest-failed-authentication-drift', retryOf: retryParent })).operation!
      active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
      const readOperation = store.readOperation.bind(store)
      store.readOperation = id => { const operation = readOperation(id); return id === retryParent ? { ...operation, impactDigest: contentHash('changed empty successor impact') } : operation }
      const rejected = await runSyncOperation(store, active.id, f.options)
      store.readOperation = readOperation
      assert.equal(rejected.failure?.code, 'candidate_retry_binding', JSON.stringify(rejected.failure)); assert.equal(rejected.operation.callsUsed, 0)
      assert.equal(calls.length, originalCalls); assert.equal(JSON.stringify({ operation: store.readOperation(retryParent), attempt: store.readAttempt(failedAttempt.id) }), originalFailure)
      return
    }
  }
  active = (await application.submit({ nodeId: 'export-contract', requestId: 'retry-transport-still-unavailable', retryOf: retryParent })).operation!
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
  const checkpoint = store.checkpoint.bind(store)
  if (recording) {
    preflightFails = false
    store.checkpoint = (fence, ref) => {
      const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }
      if (value.stage?.startsWith('v3:')) throw new Error('controlled bookkeeping failure after real removed V3')
      return checkpoint(fence, ref)
    }
  }
  const secondFailure = await runSyncOperation(store, active.id, f.options)
  store.checkpoint = checkpoint
  assert.equal(secondFailure.failure?.code, recording ? 'coordinator_failed' : 'verification_unsupported', JSON.stringify({ failure: secondFailure.failure, calls })); assert.equal(secondFailure.operation.callsUsed, 0)
  const recordedFailure = store.readAttempt(secondFailure.operation.currentAttemptId!)
  if (recording) {
    assert.deepEqual(recordedFailure.candidate, origin.candidate); assert.equal(recordedFailure.verification, null); assert.deepEqual(recordedFailure.dispatchPlans, [])
    assert.equal(recordedFailure.checkpointRefs.some(ref => (JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }).stage?.startsWith('v3:')), false)
    const resource = store.findResource(recordedFailure.id, `verification:${contentHash(`${recordedFailure.id}:${verification.id}`)}`)!
    assert.equal(resource.phase, 'removed')
    const original = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as import('./verification-executor-types.js').VerificationCheckpoint
    assert.equal(original.evidence!.outcome, defect === 'recording-continuation-failed' ? 'failed' : 'passed'); assert.equal(original.evidence!.reportComplete, defect !== 'recording-continuation-failed')
    assert.equal(store.listRecoverableResources().length, 0); assert.equal(store.listJournals(active.id).length, 0)
    assert.equal((await application.submit({ nodeId: 'export-contract', requestId: 'same-parent-recording-failure-coalesces', retryOf: retryParent })).operation!.id, active.id)
  }
  const request = { nodeId: 'export-contract', requestId: 'verification-candidate-retry', retryOf: active.id }
  active = (await application.submit(request)).operation!
  assert.equal((await application.submit(request)).operation!.id, active.id, '正式请求重放沿同一operation')
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active); preflightFails = false
  const listResources = store.listResources.bind(store), recordResource = store.recordResourceCheckpoint.bind(store)
  const originalResources = JSON.stringify(listResources(recordedFailure.id))
  let oldResourceWrites = 0
  store.recordResourceCheckpoint = (id, value) => {
    if (value.attemptId === recordedFailure.id) { oldResourceWrites++; throw new Error('冷验不得写旧资源checkpoint') }
    return recordResource(id, value)
  }
  if (defect === 'recording-continuation-resource') store.listResources = id => {
    const values = listResources(id)
    return id === recordedFailure.id ? [...values, { ...values[0], id: 'unknown-removed-resource', plan: { ...values[0].plan, key: 'verification:unknown-run' } }] : values
  }
  const result = await runSyncOperation(store, active.id, f.options)
  store.listResources = listResources; store.recordResourceCheckpoint = recordResource
  assert.equal(oldResourceWrites, 0); assert.equal(JSON.stringify(listResources(recordedFailure.id)), originalResources, '冷验只读，全部旧资源和checkpoint原件保持')
  if (defect === 'recording-continuation-failed' || defect === 'recording-continuation-resource') {
    assert.equal(result.failure?.code, 'candidate_retry_binding', JSON.stringify(result.failure))
    assert.equal(result.operation.callsUsed, 0); assert.equal(calls.length, originalCalls)
    assert.deepEqual(versionCalls, [parent.id, secondFailure.operation.id], '业务failed或未知资源在新V3派发前拒绝')
    assert.equal(store.listResources(result.operation.currentAttemptId!).length, 0); assert.equal(store.listJournals(active.id).length, 0)
    return
  }
  assert.equal(result.operation.phase, 'workspace_synced', JSON.stringify({ failure: result.failure, calls }))
  assert.equal(result.operation.callsUsed, 0)
  const verifiedAttempt = store.readAttempt(result.operation.currentAttemptId!)
  assert.deepEqual(verifiedAttempt.dispatchPlans, [], '沿原真实trace认证，不创建当前模型调用或新独审')
  const verificationResult = JSON.parse(readEvidence(f.input.source.commonDir, verifiedAttempt.verification!.resultBlob).toString()) as import('./operation-types.js').VerificationResultBlob
  for (const layer of verificationResult.layers.filter(layer => layer.layer === 'V3')) for (const ref of layer.evidenceRefs) {
    const result = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as import('./verification-executor-types.js').VerificationResult
    assert.equal(result.status, 'passed'); assert.equal(result.evidence!.runId, contentHash(`${verifiedAttempt.id}:${result.evidence!.tests[0].testId.startsWith('AC-IMPORT') ? 'VERIFY-IMPORT-01' : verification.id}`))
  }
  assert.equal(calls.length, originalCalls); assert.deepEqual(versionCalls, [parent.id, secondFailure.operation.id, ...f.plan.verifications.map(() => active.id)])
  assert.deepEqual({ ...store.readAttempt(recordedFailure.id), status: recordedFailure.status }, recordedFailure, '原记账失败及已保存V3原件保持，不补旧stage或verification')
  assert.deepEqual(store.readAttempt(result.operation.currentAttemptId!).candidate, origin.candidate)
  const supersededParent = store.readOperation(parent.id), supersededOrigin = store.readAttempt(origin.id)
  assert.deepEqual({ ...supersededParent, phase: parent.phase, revision: parent.revision, updatedAtMs: parent.updatedAtMs }, parent, '准入仅按原重叠政策supersede祖先，不改原意/预算/绑定或失败原件')
  assert.deepEqual({ ...supersededOrigin, status: origin.status }, origin, '原失败和全部checkpoint/ref/Native身份逐字保持')
  if (emptySuccessor) {
    const current = store.readOperation(emptySuccessor.operation.id), currentAttempt = store.readAttempt(emptySuccessor.attempt.id)
    assert.deepEqual({ ...current, phase: emptySuccessor.operation.phase, revision: emptySuccessor.operation.revision, updatedAtMs: emptySuccessor.operation.updatedAtMs }, emptySuccessor.operation, '空后继仅保正常supersede派生，不提供任何批准')
    assert.deepEqual({ ...currentAttempt, status: emptySuccessor.attempt.status }, emptySuccessor.attempt, '空后继原failure与checkpoint逐字保持，不补candidate/verification')
  }
  assert.ok(result.receipt); assert.equal(store.listJournals(parent.id).length, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('Coordinator 合法file-writer新增源码测试null扩域后仅续原候选评审', async t => {
  const raw = original.split('## expanded spec')[0].replace(/^code:\n(?:  -.*\n)+/m, '').replace('contract-schema: sync-v1\n', '')
  const f = await fixture(t, { mode: 'unlimited' }, false, raw, 'project', original, { version: 'sync-coordinator-v2', direction: 'spec_to_code', writePaths: ['.spec', 'src', 'tests/planned-new.test.mjs'], sourcePaths: ['src'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: [contractPath] } }, undefined, 'spec', undefined, true)
  const newSource = 'src/planned-new.js', newTest = 'tests/planned-new.test.mjs', calls: { attempt: number; purpose: string }[] = []
  f.transform((output, request) => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    calls.push({ attempt: attempt.number, purpose: request.purpose })
    if (request.purpose === 'code_behavior_analyze') for (const change of (output as { changes: { affectedIds: string[]; ruleIds: string[] }[] }).changes) { change.affectedIds = []; change.ruleIds = [] }
    if (request.purpose === 'elaboration_generate') for (const change of (output as GeneratedElaboration).changes) { change.code = []; for (const rows of Object.values(change.tables)) for (const row of rows) if (typeof row.source === 'string' && row.source.startsWith('code:')) row.source = 'derived:REQ-EXPORT-01' }
    if (request.purpose === 'implementation_plan') return { version: 'sync-implementation-plan-v1', paths: [newSource, newTest] }
    if (request.purpose === 'code_generate') {
      assert.equal(attempt.number, 1, '合法file-writer扩域后不能重新规划/生成')
      const frozen = promptInput(request), spec = frozen.elaboratedSpecs[0], before = frozen.manifest.entries.find(entry => entry.path === spec.path)!
      const source = spec.source.replace(/^code:.*\n(?:  -.*\n)*/m, '').replace(/^contract-schema:.*$/m, `contract-schema: sync-v1\ncode:\n  - ${newSource}#ExportService\nrelated:\n  - ${newTest}`)
      return { version: 'sync-files-v1', changes: [{ path: newSource, beforeDigest: null, beforeMode: null, mode: '100644', content: readFileSync(join(f.root, 'src/export.js'), 'utf8') }, { path: newTest, beforeDigest: null, beforeMode: null, mode: '100644', content: readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('../src/export.js', '../src/planned-new.js') }, { path: spec.path, beforeDigest: before.digest, beforeMode: before.mode, mode: null, content: source }] }
    }
    if (request.purpose === 'code_review') {
      if (attempt.number === 1) return rejectedReviewFixture(f, request, '原评审完整回答：\n' + JSON.stringify(output))
      throw Object.assign(new Error('合法路径扩域后已只续独审，Docker前停止'), { code: 'unsupported' })
    }
    return output
  })
  const claim = f.store.claimQueuedAttempt.bind(f.store)
  f.store.claimQueuedAttempt = input => { if (f.store.listAttempts(f.operation.id).length >= 2) throw new Error('fixture禁止无关重生成热循环'); return claim(input) }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.deepEqual([1, 2].map(number => calls.filter(call => call.attempt === number && call.purpose === 'code_review').length), [1, 1], JSON.stringify({ failure: result.failure, calls }))
  assert.equal(calls.filter(call => call.purpose === 'implementation_plan').length, 1); assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 1)
  assert.ok(result.operation.scope.paths.includes(newSource)); assert.ok(result.operation.scope.paths.includes(newTest))
  const attempts = f.store.listAttempts(f.operation.id), stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const generated = stages.map(values => JSON.parse(readEvidence(f.input.source.commonDir, values.find(value => value.stage === 'generation').resultRef).toString()))
  assert.deepEqual(generated[1].candidate, generated[0].candidate)
  const writerRef = generated[0].fileWriterPlanRef
  assert.ok(result.operation.contractScopeExpansions!.some(expansion => expansion.evidenceRef.sha256 === writerRef.sha256 && expansion.paths!.includes(newSource) && expansion.paths!.includes(newTest)))
  assert.equal(readTree(f.input.source.commonDir, f.input.immutableTree).some(entry => [newSource, newTest].includes(entry.path)), false)
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('Coordinator 已有code且P1新增managed AC.test的null路径只续原评审', async t => {
  const managedTest = 'tests/managed-export.test.mjs'
  const managedRaw = `${parseParts(original)!.rawSource}\n\n保留AC-EXPORT-01的业务义务和断言，本轮将其技术测试绑定调整为${managedTest}#AC-EXPORT-01，并生成该受管测试文件。`
  const f = await fixture(t, { mode: 'unlimited' }, false, original, 'project', original, { version: 'sync-coordinator-v2', agentWorkflow: 'native-worktree-v1', direction: 'spec_to_code', sourcePaths: ['src'], writePaths: ['.spec', 'src', managedTest], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: [contractPath] } }, { original: parseParts(original)!.rawSource, replacement: managedRaw, intent: '原导出义务和AC断言保持，本轮新增明确受管测试绑定', testPath: managedTest }, 'spec', 'claude:MiniMax-M3.1-Flash', true)
  const calls: { attempt: number; purpose: string }[] = []
  f.options.runner = async request => {
    f.calls.push(request)
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    calls.push({ attempt: attempt.number, purpose: request.purpose })
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; approvedSpecs: string[]; allowedScope: { paths: string[] } } : null
    let output: unknown, witness: ReturnType<typeof nativeWorktreeResult> | undefined
    if (request.purpose === 'code_behavior_analyze') output = { changes: task!.requiredChangedPaths.map((path: string) => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保持原导出业务', previousBehavior: '原导出流程', sourceBehavior: '原导出流程', deliveryBehavior: '原导出流程', evidence: '冻结完整源码与原断言相同业务', counterexample: '测试技术绑定不改变业务语义' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis!
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map((item: { id: string }) => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate' || request.purpose === 'code_generate') {
      assert.equal(attempt.number, 1, '合法P1测试绑定扩域不能重派P1/builder')
      const scratch = join(f.parent, `managed-scratch-${calls.length}`), seed = request.worktree!
      f.git('worktree', 'add', '--detach', scratch, seed.baseCommit)
      if (request.purpose === 'elaboration_generate') {
        const draft = /草稿文件=([^\s]+)/.exec(request.prompt)![1], generated = rows(original)
        generated.changes[0].tables.AC[0].test = `${managedTest}#AC-EXPORT-01`
        mkdirSync(join(scratch, draft, '..'), { recursive: true }); writeFileSync(join(scratch, draft), JSON.stringify(adaptElaborationNativeOutput(request, generated)))
        execFileSync('git', ['-C', scratch, 'add', draft], { stdio: 'pipe' })
      } else {
        assert.ok(task!.allowedScope.paths.includes(managedTest))
        writeFileSync(join(scratch, managedTest), readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8'))
        execFileSync('git', ['-C', scratch, 'add', managedTest], { stdio: 'pipe' })
      }
      execFileSync('git', ['-C', scratch, 'commit', '-m', 'real managed test result'], { stdio: 'pipe' })
      output = { summary: '真实草稿或managed测试已提交' }; witness = nativeWorktreeResult(scratch, seed)
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_review') {
      const binding = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0])
      output = { inputId: binding.inputId, candidateDigest: binding.candidateDigest, verdict: 'accept', checkedIds: binding.requiredIds, findings: [] }
      if (attempt.number === 1) return rejectedReviewFixture(f, request, '原评审完整回答：\n' + JSON.stringify(output))
      throw Object.assign(new Error('原managed路径来源冷验完成，Docker前停止'), { code: 'unsupported' })
    } else assert.fail(request.purpose)
    if (request.purpose.startsWith('code_behavior_')) {
      witness = committedDraftFixture(f, request, output, join(f.parent, `managed-p0-${calls.length}`))
      output = { summary: '真实P0业务JSON已正常提交' }
    }
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `managed-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), ...(witness ? { worktree: witness } : {}) }
  }
  const claim = f.store.claimQueuedAttempt.bind(f.store)
  f.store.claimQueuedAttempt = input => { if (f.store.listAttempts(f.operation.id).length >= 2) throw new Error('fixture禁止无关热循环'); return claim(input) }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.deepEqual([1, 2].map(number => calls.filter(call => call.attempt === number && call.purpose === 'code_review').length), [1, 1], JSON.stringify({ failure: result.failure, calls }))
  assert.equal(calls.some(call => call.purpose === 'implementation_plan'), false, '已有code映射跳过文件规划')
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 1)
  assert.ok(result.operation.scope.paths.includes(managedTest))
  const stages = f.store.listAttempts(f.operation.id).map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const generated = stages.map(values => JSON.parse(readEvidence(f.input.source.commonDir, values.find(value => value.stage === 'generation').resultRef).toString()))
  assert.deepEqual(generated[1].candidate, generated[0].candidate)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


for (const failureKind of ['format', 'business', 'protocol'] as const) for (const legacyMaterial of [false, true]) for (const partitioned of [false, true]) for (const phase of ['code_behavior_analyze', 'code_behavior_review']) if (failureKind === 'format' || !legacyMaterial && phase === 'code_behavior_review' && (failureKind === 'protocol' || !partitioned)) test(`Native P0 ${partitioned ? '分区' : '单体'} ${phase}${failureKind === 'protocol' ? 'ID协议失败SQLite冷恢复' : '格式失败持久续改'}，${failureKind === 'business' ? '业务repair重做分析独审' : legacyMaterial ? '旧Native材料' : '保已校验分析'}与只读对象`, async t => {
  const businessRepair = failureKind === 'business', protocolRepair = failureKind === 'protocol'
  const plan = partitioned ? { version: 'sync-coordinator-v2' as const, direction: 'code_to_spec' as const, sourcePaths: ['src'], writePaths: ['.spec'], partitionPolicy: { version: 'sync-partition-policy-v1' as const, maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] } } : {}
  const legacyRounds = legacyMaterial && phase === 'code_behavior_analyze' ? 2 : 1
  const f = await fixture(t, { maxAttempts: legacyRounds + 1, maxCalls: 16, maxRepairs: legacyRounds, timeoutMs: 120_000 }, false, original, 'project', original, { ...plan, agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', partitioned)
  const originalRunner = f.options.runner!, requests: ElaborationSessionRequest[] = []
  let activeStore = f.store, invalid = partitioned ? '{"original":"WRONG_SCHEMA_P0"}' : '{ ORIGINAL_INVALID_P0_JSON\n'
  let originalReview: { oid: string; schemaOid: string; schema: Buffer } | undefined
  let rejectedReviewRef: string | undefined
  let failed = false
  if (legacyMaterial) {
    const claimed = partitioned ? f.store.claimQueuedAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedRevision: f.store.readOperation(f.operation.id).revision }) : f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
    f.store.reserveDispatch(claimed.fence, { key: `sync:${claimed.attempt.id}:historical-reserved-p0`, purpose: 'code_behavior_analyze', requestDigest: contentHash('frozen original read request') })
    const claimLegacy = partitioned ? f.store.claimQueuedAttempt.bind(f.store) : f.store.claimAttempt.bind(f.store)
    const claimNext = (input: Parameters<typeof claimLegacy>[0]) => {
      const next = claimLegacy(input)
      if (next.attempt.number <= legacyRounds) f.store.reserveDispatch(next.fence, { key: `sync:${next.attempt.id}:historical-reserved-p0`, purpose: 'code_behavior_analyze', requestDigest: contentHash('frozen next original read request') })
      return next
    }
    if (partitioned) f.store.claimQueuedAttempt = claimNext
    else f.store.claimAttempt = claimNext
  }
  f.options.runner = async request => {
    requests.push(request)
    if (!request.purpose.startsWith('code_behavior_')) throw Object.assign(new Error('P0验证通过，受控回归在P1前停止'), { code: 'unsupported' })
    const attempt = activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    if (legacyMaterial && attempt.number <= legacyRounds) {
      assert.equal(seed.mode, 'read'); assert.doesNotMatch(request.prompt, /草稿文件=/)
      if (request.purpose === phase) { failed = true; return rejectedReviewFixture(f, request, attempt.number < legacyRounds ? 'A1_OLDER_ORIGINAL_FINAL' : invalid) }
      return originalRunner({ ...request, prompt: request.prompt.replace('\n任务:\n', '\n冻结三方输入:\n').replace('"requiredChangedPaths":', '"changedPaths":') })
    }
    const workspace = join(f.parent, `p0-persist-${requests.length}`), path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    assert.equal(seed.mode, 'edit')
    assert.deepEqual(readTree(f.input.source.commonDir, seed.tree).filter(entry => !entry.path.startsWith('.spex-sync-drafts/')), readTree(f.input.source.commonDir, f.input.immutableTree))
    let text: string
    const produced = await originalRunner({ ...request, prompt: inlineBehaviorPrompt(request, f.input.source.commonDir) })
    const context = readCodeBehaviorContext(request, f.input.source.commonDir)
    assert.deepEqual(context.repairDiagnostics, [])
    assert.deepEqual(context.errors, [])
    if (businessRepair && attempt.number > 1 && request.purpose === 'code_behavior_analyze') {
      assert(rejectedReviewRef)
      assert.ok(request.prompt.includes(`git show ${rejectedReviewRef}`))
      assert.doesNotMatch(request.prompt, /真实业务遗漏需重做分析/)
      assert.match(f.git('show', rejectedReviewRef), /真实业务遗漏需重做分析/)
    }
    if (request.purpose === phase && !failed) {
      if (protocolRepair) {
        const review = structuredClone(produced.output) as { checkedChangeIds: string[] }
        review.checkedChangeIds[0] += 'e'; invalid = JSON.stringify(review)
      }
      text = businessRepair ? JSON.stringify({ ...produced.output as object, verdict: 'repair', findings: [{ message: '真实业务遗漏需重做分析', evidence: '原冻结源码与完整测试', counterexample: '不得漏掉幂等行为' }] }) : invalid; failed = true
    }
    else {
      if (request.purpose === phase) {
        assert.equal(attempt.number, legacyRounds + 1)
        if (businessRepair) assert.equal(existsSync(join(workspace, path)), false)
        else {
          assert.equal(readFileSync(join(workspace, path), 'utf8'), invalid)
          if (protocolRepair) {
            assert.equal(f.git('rev-parse', `${seed.baseCommit}:${path}`), originalReview!.oid)
            assert.equal(f.git('rev-parse', `${seed.baseCommit}:${path.replace(/\.json$/, '.schema.json')}`), originalReview!.schemaOid)
            assert.deepEqual(readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json'))), originalReview!.schema)
          }
          if (legacyMaterial) assert.match(request.prompt, /旧Native原输出材料.*不是既有Git草稿/)
          assert.ok(!request.prompt.includes(invalid))
        }
      }
      text = JSON.stringify(produced.output)
    }
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text)
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'normal P0 draft'], { stdio: 'pipe' })
    if (businessRepair && request.purpose === phase && attempt.number === 1) rejectedReviewRef = `${execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}:${path}`
    if (protocolRepair && request.purpose === phase && attempt.number === 1) originalReview = { oid: execFileSync('git', ['-C', workspace, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim(), schemaOid: f.git('rev-parse', `${seed.baseCommit}:${path.replace(/\.json$/, '.schema.json')}`), schema: readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json'))) }
    const output = { summary: '正常提交真实P0临时JSON' }
    return { ...produced, output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  if (protocolRepair) {
    const claim = partitioned ? activeStore.claimQueuedAttempt.bind(activeStore) : activeStore.claimAttempt.bind(activeStore)
    const claimNext = (input: Parameters<typeof claim>[0]) => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.status === 'failed')) throw new Error('fixture process boundary after durable P0 protocol failure')
      return claim(input)
    }
    if (partitioned) activeStore.claimQueuedAttempt = claimNext
    else activeStore.claimAttempt = claimNext
    await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(activeStore.listAttempts(f.operation.id).length, 1)
    assert.equal(activeStore.listAttempts(f.operation.id)[0].failure?.code, 'behavior_review_failed')
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  await runSyncOperation(activeStore, f.operation.id, f.options)
  const attempts = activeStore.listAttempts(f.operation.id)
  assert.equal(attempts.length, legacyRounds + 1)
  assert.deepEqual(requests.filter(request => request.purpose.startsWith('code_behavior_')).map(request => request.purpose), phase === 'code_behavior_review' ? legacyMaterial || businessRepair ? ['code_behavior_analyze', 'code_behavior_review', 'code_behavior_analyze', 'code_behavior_review'] : ['code_behavior_analyze', 'code_behavior_review', 'code_behavior_review'] : legacyMaterial ? [...Array.from({ length: legacyRounds + 1 }, () => 'code_behavior_analyze'), 'code_behavior_review'] : ['code_behavior_analyze', 'code_behavior_analyze', 'code_behavior_review'])
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }))
  assert.ok(stages.at(-1)!.some(entry => entry.stage === 'behavior-draft-protocol'))
  if (legacyMaterial) {
    assert.ok(!stages[0].some(entry => entry.stage === 'behavior-draft-protocol'))
    assert.ok(stages.at(-1)!.some(entry => entry.stage.endsWith(`${phase}:native-material-provenance`)))
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.equal(f.store.listJournals(f.operation.id).length, 0); return
  }
  assert.ok(stages[0].some(entry => entry.stage === 'behavior-draft-protocol'))
  assert.ok(stages[1].some(entry => entry.stage.endsWith('analysis:continuation-provenance')))
  const continuations = stages[0].filter(entry => entry.stage.endsWith('analysis:continuation')).map(entry => JSON.parse(readEvidence(f.input.source.commonDir, entry.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation)
  if (businessRepair) {
    assert.equal(continuations.at(-1)!.readyAnalysis, undefined)
    assert.equal(attempts[0].failure?.message, 'P0 行为校验未通过')
    for (const stage of stages.flat()) assert.doesNotMatch(readEvidence(f.input.source.commonDir, stage.resultRef).toString(), /真实业务遗漏需重做分析/)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.equal(f.store.listJournals(f.operation.id).length, 0); return
  }
  const saved = continuations.find(value => value.drafts[phase as 'code_behavior_analyze' | 'code_behavior_review']?.errors.length)!
  assert.ok(saved); assert.equal(readObject(f.input.source.commonDir, saved.drafts[phase as 'code_behavior_analyze' | 'code_behavior_review']!.oid).toString('utf8'), invalid)
  if (phase === 'code_behavior_review') {
    assert.ok(saved.readyAnalysis)
    const trace = saved.readyAnalysis.trace
    assert.ok(attempts[0].dispatchPlans.some(dispatch => dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId))
    if (protocolRepair) {
      const resumed = stages[1].filter(entry => entry.stage.endsWith('analysis:continuation')).map(entry => JSON.parse(readEvidence(f.input.source.commonDir, entry.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation).at(-1)!
      assert.deepEqual(resumed.readyAnalysis, saved.readyAnalysis)
      assert.equal(resumed.drafts.code_behavior_analyze!.oid, saved.drafts.code_behavior_analyze!.oid)
      assert.deepEqual(saved.drafts.code_behavior_review!.errors, [{ code: 'behavior_review_failed', message: 'P0 行为校验未通过' }])
      assert.ok(JSON.parse(invalid).checkedChangeIds[0].endsWith('e'))
      t.diagnostic(JSON.stringify({ calls: requests.filter(request => request.purpose.startsWith('code_behavior_')).map(request => request.purpose), coldRestart: true, originalReviewSeedOid: originalReview!.oid, originalSchemaSeedOid: originalReview!.schemaOid, originalSchemaSha256: contentHash(originalReview!.schema), analysisTraceUnchanged: true, analysisOidUnchanged: true }))
    }
  }
  assert.equal(activeStore.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const partitioned of [false, true]) for (const legacyP0 of partitioned ? [false] : [false, true]) for (const legacyP1 of !partitioned && legacyP0 ? [false, true] : [false]) for (const mixedAncestors of legacyP1 ? [false, true] : [false]) for (const reviewRejected of legacyP1 && !mixedAncestors ? [false, true] : [false]) for (const unprovenAncestor of partitioned ? [false, true] : [false]) for (const bindingMismatch of partitioned && !unprovenAncestor ? ['none', 'schema', 'owner', 'plan', 'readset', 'p1-schema', 'p1-owner', 'p1-irrelevant-owner'] as const : ['none'] as const) test(`正式retryOf换模型并SQLite重启保留P0/P1原Git稿与八项后置发现 ${partitioned ? 'partition' : 'whole'} unproven=${unprovenAncestor} legacyP0=${legacyP0} legacyP1=${legacyP1} mixed=${mixedAncestors} reviewRejected=${reviewRejected} binding=${bindingMismatch}`, async t => {
  const plan = partitioned ? { version: 'sync-coordinator-v2' as const, direction: 'code_to_spec' as const, sourcePaths: ['src'], writePaths: ['.spec'], partitionPolicy: { version: 'sync-partition-policy-v1' as const, maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] } } : {}
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 12, maxRepairs: 0, timeoutMs: 120_000 }, false, original, 'project', original, { ...plan, agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'zcode:fixture/old', partitioned)
  if (legacyP0) {
    const claim = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
    f.store.reserveDispatch(claim.fence, { key: `sync:${claim.attempt.id}:legacy-read-p0`, purpose: 'code_behavior_analyze', requestDigest: contentHash('既有只读P0请求不补协议') })
    if (legacyP1) f.store.reserveDispatch(claim.fence, { key: `sync:${claim.attempt.id}:legacy-read-p1`, purpose: 'elaboration_generate', requestDigest: contentHash('既有只读P1请求不补协议') })
  }
  let store = f.store, active = f.operation, retry = false, unproven = false
  let reviewSeedSha: string | undefined
  let mixedLabelSeen: boolean | undefined, latestDraft: { text: string; oid: string; schemaDigest: string } | undefined
  const drafts = new Map<string, { text: string; oid: string; schema: Buffer }>(), calls: string[] = []
  const ids = [...Array.from({ length: 6 }, (_, index) => `RULE-EXPORT-0${index + 1}`), 'STEP-EXPORT-01', 'STEP-EXPORT-02']
  f.options.runner = async request => {
    calls.push(`${retry ? 'retry' : 'old'}:${request.purpose}`)
    const attempt = store.readAttempt(store.readOperation(active.id).currentAttemptId!), seed = request.worktree!
    if (request.purpose === 'elaboration_review' && !retry && reviewRejected) return rejectedReviewFixture(f, request, '{ORIGINAL_REVIEW_REJECTED_FINAL', '原独审JSON语法错误，不是业务行')
    if (request.purpose === 'elaboration_review') throw Object.assign(new Error('新P1已基于原稿通过程序门，在新独审入口停止'), { code: 'unsupported' })
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)?.[1], workspace = join(f.parent, `retry-lineage-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (unproven) {
      assert.ok(path)
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), '{UNAUTHENTICATED_NEWER_NATIVE_DRAFT')
      execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'unproven native witness'], { stdio: 'pipe' })
      store.requestControl(active.id, 'pause')
      throw new StructuredSessionError('native_worktree_result_invalid', '受控模拟Native身份认证失败，该稿不得复用', { failedWorktree: nativeWorktreeResult(workspace, seed) })
    }
    const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; postGateReview?: import('./code-behavior.js').CodeBehaviorPostGateReview[] }
    if (retry && request.purpose !== 'code_behavior_review') {
      assert.ok(path)
      if (bindingMismatch !== 'none' && (!bindingMismatch.startsWith('p1-') || request.purpose === 'elaboration_generate')) {
        assert.equal(existsSync(join(workspace, path)), false, 'schema/plan/readset不匹配不得把旧JSON带到新seed')
        throw Object.assign(new Error('绑定反例已核新seed无旧材料'), { code: 'unsupported' })
      }
      if (reviewRejected && request.purpose === 'elaboration_generate') reviewSeedSha = contentHash(readFileSync(join(workspace, path)))
      const old = drafts.get(request.purpose)!, newestGit = mixedAncestors && attempt.number === 2 && request.purpose === 'elaboration_generate'
      if (newestGit) {
        mixedLabelSeen = /旧只读Native成功结构化输出/.test(request.prompt)
        assert.equal(mixedLabelSeen, false, '较新Git稿不能混入更早Native材料标签')
        assert.match(request.prompt, /output_json/); assert.doesNotMatch(request.prompt, /materialErrors|refactor_business_meaning_changed/)
        assert.equal(readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path)!.oid, latestDraft!.oid)
        assert.equal(contentHash(readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json')))), latestDraft!.schemaDigest)
      }
      assert.equal(readFileSync(join(workspace, path), 'utf8'), newestGit ? '{NEWER_NATIVE_AUTHENTICATED_GIT_JSON_ERROR' : old.text, '正式retry必须overlay祖先原JSON，不能从零创建')
      if (!newestGit) assert.equal(readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path)!.oid, old.oid)
      assert.deepEqual(readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json'))), old.schema)
      if (request.purpose === 'code_behavior_analyze') {
        if (legacyP0) assert.match(request.prompt, /旧只读Native成功结构化输出.*不是历史Git草稿/)
        assert.equal(task.postGateReview?.length ?? 0, reviewRejected ? 0 : 1)
        if (!reviewRejected) assert.deepEqual(task.postGateReview![0].findings.map(item => item.finding), rejectedFindings)
      } else if (!newestGit) { if (legacyP1) assert.match(request.prompt, /旧只读Native成功结构化输出.*不是历史Git草稿/); for (const finding of rejectedFindings) assert.ok(request.prompt.includes(JSON.stringify(finding)), finding.itemId); if (reviewRejected) { assert.match(request.prompt, /elaboration_review_rejected_output/); assert.match(request.prompt, /ORIGINAL_REVIEW_REJECTED_FINAL/); assert.match(request.prompt, /原独审JSON语法错误，不是业务行/) } }
    }
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') output = { changes: task.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ids, ruleIds: ids.filter(id => id.startsWith('RULE')), originalIntent: '保全部原业务行', previousBehavior: '原导出语义', sourceBehavior: '实现内部编辑', deliveryBehavior: '原导出语义', evidence: path, counterexample: '不改权限与状态事件' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const reviewed = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    } else {
      const changed = rows(original)
      if (!retry && !reviewRejected) {
        for (const row of changed.changes[0].tables.RULE) row.basis = `未经批准的表示漂移 ${row.id}`
        for (const row of changed.changes[0].tables.STEP.slice(0, 2)) row.action = `未经批准的动作漂移 ${row.id}`
      }
      output = adaptElaborationNativeOutput(request, changed)
    }
    const text = mixedAncestors && retry && attempt.number === 1 && request.purpose === 'elaboration_generate' ? '{NEWER_NATIVE_AUTHENTICATED_GIT_JSON_ERROR' : JSON.stringify(output)
    if (!path) {
      assert.equal(legacyP0, true); assert.equal(retry, false)
      drafts.set(request.purpose, { text, oid: execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim(), schema: Buffer.from(JSON.stringify(request.schema)) })
      const records = new Map<string, NativeRunRecord>(), fence = { operationId: active.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: active.input.source.physicalFingerprint }
      return createAttemptRunner(store, fence, { pollMs: 2, runtime: {
        readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('禁止控制真实Native') },
        run: async actual => {
          const execution = structuredExecutionPolicy(actual), key = actual.sessionCreateKey ?? actual.requestKey, sessionId = sessionIdForCreateKey(key), identity = { threadId: `legacy-${key}`, turnId: 'turn' }
          const result = { sessionId, ...identity, output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
          records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(key), createPayloadHash: contentHash(JSON.stringify({ prompt: nativeWorktreePrompt(actual.prompt, actual.worktree!), parent: null, launcher: null, base: actual.base, structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output, resultDigest: result.resultDigest, resultWorktree: result.worktree } })
          return result
        },
      } })(request)
    }
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text)
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'controlled retry draft'], { stdio: 'pipe' })
    if (!retry) drafts.set(request.purpose, { text, oid: execFileSync('git', ['-C', workspace, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim(), schema: readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json'))) })
    if (mixedAncestors && retry && attempt.number === 1 && request.purpose === 'elaboration_generate') latestDraft = { text, oid: execFileSync('git', ['-C', workspace, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim(), schemaDigest: contentHash(readFileSync(join(workspace, path.replace(/\.json$/, '.schema.json')))) }
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, receipt = { summary: '受控Native真实Git稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `retry-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  let rejectedFindings: import('@spexcode/spec-core/contracts').ContractFinding[] = []
  await runSyncOperation(store, active.id, f.options)
  const oldAttempt = store.listAttempts(active.id)[0], oldOperation = store.readOperation(active.id)
  const rejected = oldAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } }).filter(entry => entry.stage === 'elaboration' || entry.stage.endsWith(':elaboration')).map(entry => JSON.parse(readEvidence(f.input.source.commonDir, entry.resultRef).toString()) as ElaborationResult).find(result => result.rounds.at(-1)?.findings.length || reviewRejected && result.failure)!
  assert.ok(rejected, JSON.stringify({ failure: oldAttempt.failure, calls }))
  rejectedFindings = rejected.rounds.at(-1)!.findings.filter(finding => finding.code === 'refactor_business_meaning_changed')
  assert.equal(rejectedFindings.length, reviewRejected ? 0 : 8)
  let oldBytes = JSON.stringify({ operation: oldOperation, attempts: store.listAttempts(active.id), resources: oldAttempt.dispatchPlans.map(dispatch => store.findResource(oldAttempt.id, dispatch.key)) })
  const originalRefs = oldAttempt.checkpointRefs.map(ref => ({ ref, bytes: readEvidence(f.input.source.commonDir, ref) }))
  if (bindingMismatch !== 'none') {
    // 明确模拟历史绑定损坏：只追加新CAS，再把隔离SQLite旧attempt指向该历史夹具；不改任何原CAS/Git对象。
    const historical = structuredClone(oldAttempt)
    historical.checkpointRefs = historical.checkpointRefs.map(ref => {
      const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; readSetDigest?: string; resultRef: { sha256: string } }
      if (bindingMismatch === 'readset') wrapper.readSetDigest = contentHash('foreign readset')
      if (wrapper.stage.endsWith(':continuation') || wrapper.stage === 'partition-plan' || wrapper.stage.endsWith(':elaboration')) {
        const value = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
        if (wrapper.stage.endsWith(':continuation')) for (const draft of Object.values(value.drafts) as import('./elaboration-types.js').ElaborationDraft[]) {
          if (bindingMismatch === 'schema') draft.schemaDigest = contentHash('foreign schema')
          if (bindingMismatch === 'owner') draft.ownerDigest = contentHash('foreign owner')
        }
        if (wrapper.stage === 'partition-plan' && bindingMismatch === 'plan') value.digest = contentHash('foreign plan')
        if (wrapper.stage.endsWith(':elaboration') && value.rounds.at(-1)?.draft) {
          if (bindingMismatch === 'p1-schema') value.rounds.at(-1).draft.schemaDigest = contentHash('foreign P1 schema')
          if (bindingMismatch === 'p1-owner' || bindingMismatch === 'p1-irrelevant-owner') value.rounds.at(-1).draft.ownerDigest = contentHash('foreign P1 owner')
          if (bindingMismatch === 'p1-irrelevant-owner') for (const finding of value.rounds.at(-1).findings) {
            if (finding.code === 'refactor_business_meaning_changed') finding.code = 'readonly_implementation_gap'
          }
        }
        wrapper.resultRef = writeEvidence(f.input.source.commonDir, value)
      }
      return { ...writeEvidence(f.input.source.commonDir, wrapper), artifacts: ref.artifacts }
    })
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify(historical), historical.id))
  }
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'official-retry-lineage', rootCauseId: 'official-retry-lineage', retryOf: active.id, model: 'claude:default', origin: oldOperation.origin, budget: unprovenAncestor || mixedAncestors ? { ...oldOperation.budget, maxAttempts: 2, maxRepairs: 1 } : oldOperation.budget, managedRoot: f.managedRoot, ...(oldOperation.baselineSelection ? { baselineSelection: oldOperation.baselineSelection, executionScope: oldOperation.scope, impactDigest: oldOperation.impactDigest } : {}) }))
  if (partitioned) active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId)
  if (unprovenAncestor) {
    f.useOperation(active); unproven = true
    await runSyncOperation(store, active.id, f.options)
    assert.equal(store.readOperation(active.id).control, 'pause')
    assert.equal(store.listAttempts(active.id)[0].status, 'superseded')
    active = store.requestControl(active.id, 'run'); unproven = false
  }
  const afterAdmission = store.readOperation(oldOperation.id)
  t.diagnostic(JSON.stringify({ proof: 'controlled_git_sqlite_native', oldModel: oldOperation.model, retryModel: active.model, admissionOperationChanges: Object.keys(oldOperation).filter(key => JSON.stringify(oldOperation[key as keyof typeof oldOperation]) !== JSON.stringify(afterAdmission[key as keyof typeof oldOperation])).map(field => ({ field, before: oldOperation[field as keyof typeof oldOperation], after: afterAdmission[field as keyof typeof oldOperation] })), drafts: [...drafts].map(([purpose, draft]) => ({ purpose, sha256: contentHash(draft.text), bytes: Buffer.byteLength(draft.text), oid: draft.oid, schemaSha256: contentHash(draft.schema) })), findings: rejectedFindings }))
  oldBytes = JSON.stringify({ operation: store.readOperation(oldOperation.id), attempts: store.listAttempts(oldOperation.id), resources: oldAttempt.dispatchPlans.map(dispatch => store.findResource(oldAttempt.id, dispatch.key)) })
  f.useOperation(active); retry = true
  const result = await runSyncOperation(store, active.id, f.options)
  if (reviewRejected) assert.equal(reviewSeedSha, contentHash(drafts.get('elaboration_generate')!.text), 'review拒绝final不得冒充generation业务行原稿')
  if (mixedAncestors) assert.equal(mixedLabelSeen, false, '较新Git稿不得触发更早Native材料的提示、诊断或provenance')
  assert.deepEqual(calls.filter(call => call.startsWith('retry:')), mixedAncestors ? ['retry:code_behavior_analyze', 'retry:code_behavior_review', 'retry:elaboration_generate', 'retry:elaboration_generate', 'retry:elaboration_review'] : bindingMismatch === 'owner' || bindingMismatch.startsWith('p1-') ? [] : bindingMismatch !== 'none' ? ['retry:code_behavior_analyze'] : ['retry:code_behavior_analyze', 'retry:code_behavior_review', 'retry:elaboration_generate', 'retry:elaboration_review'], JSON.stringify({ failure: result.failure, phase: result.operation.phase }))
  if (bindingMismatch === 'owner' || bindingMismatch === 'p1-owner') assert.match(result.failure!.message, /草稿owner\/schema\/path或保活ref不匹配/)
  if (bindingMismatch === 'p1-schema') assert.match(result.failure!.message, /草稿seed没有精确只读schema/)
  if (bindingMismatch === 'p1-irrelevant-owner') {
    const current = store.listAttempts(active.id)[0]
    const wrapper = current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(entry => entry.stage === 'analysis')
    assert.ok(wrapper, '普通P1诊断不能阻断原P0批准复用')
    const original = oldAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(entry => entry.stage === 'analysis')
    assert.deepEqual(wrapper.resultRef, original.resultRef)
    assert.match(result.failure!.message, /草稿owner\/schema\/path或保活ref不匹配/, '真正使用该P1稿件时仍须拒绝不合格原件')
  }
  if (reviewRejected) {
    const current = store.listAttempts(active.id)[0], wrapper = current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.stage === 'elaboration:draft-material-provenance')
    const provenance = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
    const generation = oldAttempt.dispatchPlans.filter(dispatch => dispatch.purpose === 'elaboration_generate').map(dispatch => store.findResource(oldAttempt.id, dispatch.key)).find(Boolean)!
    const review = oldAttempt.dispatchPlans.filter(dispatch => dispatch.purpose === 'elaboration_review').map(dispatch => store.findResource(oldAttempt.id, dispatch.key)).find(Boolean)!
    assert.equal(provenance.sourceKind, 'native_output'); assert.equal(provenance.fromOperationId, oldOperation.id)
    assert.equal(provenance.nativePlanRef.sha256, generation.plan.planBlob.sha256); assert.equal(provenance.checkpointRef.sha256, generation.checkpointRef.sha256)
    assert.notEqual(provenance.nativePlanRef.sha256, review.plan.planBlob.sha256)
  }
  if (mixedAncestors) {
    const attempts = store.listAttempts(active.id), wrappers = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.equal(wrappers.some(wrapper => wrapper.stage === 'elaboration:draft-material-provenance'), false)
    const wrapper = wrappers.find(wrapper => wrapper.stage === 'elaboration:draft-provenance'), provenance = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
    assert.equal(provenance.fromOperationId, active.id); assert.equal(provenance.fromAttemptId, attempts[0].id); assert.equal(provenance.oid, latestDraft!.oid)
    assert.equal('sourceKind' in provenance, false); assert.equal('nativePlanRef' in provenance, false); assert.equal('checkpointRef' in provenance, false)
  }
  assert.equal(JSON.stringify({ operation: store.readOperation(oldOperation.id), attempts: store.listAttempts(oldOperation.id), resources: oldAttempt.dispatchPlans.map(dispatch => store.findResource(oldAttempt.id, dispatch.key)) }), oldBytes)
  for (const original of originalRefs) assert.deepEqual(readEvidence(f.input.source.commonDir, original.ref), original.bytes)
  if (process.env.SPEX_RETRY_DRAFT_EVIDENCE_DIR) {
    const evidenceDirectory = join(process.env.SPEX_RETRY_DRAFT_EVIDENCE_DIR, contentHash(t.name).slice(0, 16))
    mkdirSync(evidenceDirectory, { recursive: true })
    for (const [purpose, draft] of drafts) { writeFileSync(join(evidenceDirectory, `${purpose}.json`), draft.text); writeFileSync(join(evidenceDirectory, `${purpose}.schema.json`), draft.schema) }
    writeFileSync(join(evidenceDirectory, 'formal-records.json'), JSON.stringify({ controlledNative: true, case: t.name, sourceOperation: store.readOperation(oldOperation.id), sourceAttempts: store.listAttempts(oldOperation.id), currentOperation: store.readOperation(active.id), currentAttempts: store.listAttempts(active.id), findings: rejectedFindings, drafts: [...drafts].map(([purpose, draft]) => ({ purpose, sha256: contentHash(draft.text), oid: draft.oid, schemaDigest: contentHash(draft.schema) })) }, null, 2))
    cpSync(join(f.input.source.commonDir, 'spexcode/evidence'), join(evidenceDirectory, 'cas'), { recursive: true })
    f.git('bundle', 'create', join(evidenceDirectory, 'git-evidence.bundle'), '--all')
  }
  for (const attempt of store.listAttempts(active.id)) for (const ref of attempt.checkpointRefs) {
    const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { resultRef?: { sha256: string } }
    assert.doesNotMatch(JSON.stringify(wrapper), /"loadDraft(?:Material)?":/)
    if (wrapper.resultRef) assert.doesNotMatch(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString(), /"loadDraft(?:Material)?":/)
  }
  assert.equal(result.receipt, undefined); assert.equal(store.listJournals(active.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const parentSeed of [false, true]) for (const defect of parentSeed ? ['none', 'review-identity', 'newer-review', 'seal-repair', 'seal-anchor', 'seal-dispatched', 'seal-request', 'seal-fence'] as const : ['none'] as const) test(`P1正式retry保留局部accept与原Native模型，SQLite冷恢复后仅派发未审owner parent=${parentSeed} defect=${defect}`, async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01', importPath = '.spec/project/beta/import-contract/spec.md'
  const sealRepair = defect.startsWith('seal-')
  const afterDispatch = defect === 'seal-dispatched' || defect === 'seal-request' || defect === 'seal-fence'
  const raw = '保留导出与导入两个模块的已有业务。'
  const parent = `---\ntitle: 共享接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const parentSource = `${parent}\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留两个模块 | user:raw | 保持既有业务 | 既有验收通过 | - |\n`.replace('status: pending', 'status: active\ncontract-schema: sync-v1')
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY')
  const rawOnly = (source: string) => source.slice(0, source.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [original, other].map(source => { const definition = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(definition.kind, 'VERIFY'); return { definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment } })
  const mandatoryTests = [original, other].map(source => { const acceptance = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'AC')!; assert.equal(acceptance.kind, 'AC'); const [testPath, testId] = acceptance.test.split('#'); return { verificationId: acceptance.command, testPath, testId } })
  const f = await fixture(t, { maxAttempts: sealRepair ? 2 : 1, maxCalls: 24, maxRepairs: sealRepair ? 1 : 0, timeoutMs: 180_000 }, false, rawOnly(original), 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', agentWorkflow: 'native-worktree-v1', intentNodeId: parentSeed ? 'project' : 'export-contract', sourcePaths: ['src'], verifications, mandatoryTests,
    targets: [...(parentSeed ? [{ nodeId: 'project', path: parentPath, rawSource: raw }] : []), { nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    ...(!parentSeed ? { executionScope: { paths: [contractPath, importPath], contractIds: [], flowIds: [] } } : {}),
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 },
  }, undefined, 'spec', 'claude:MiniMax-M3.1-Flash', true, { ...(parentSeed ? { [parentPath]: parent } : {}), [importPath]: rawOnly(other), 'src/beta/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js') })
  let store = f.store, active = f.operation, approvedLeaf = '', retryRound = 0
  let sealRef: BlobRef | undefined, approvedLeafDraft: ElaborationDraft | undefined, interruptedRepair: SyncAttempt | undefined
  const calls: { operation: string; nodeId: string; purpose: string; model?: string }[] = [], records = new Map<string, NativeRunRecord>(), workspaces: string[] = []
  f.options.runner = async request => {
    const behavior = request.purpose.startsWith('code_behavior_')
    if (!behavior && !request.purpose.startsWith('elaboration_')) throw Object.assign(new Error('完整P1已重新封口'), { code: 'unsupported' })
    const operation = store.readOperation(active.id), attempt = store.readAttempt(operation.currentAttemptId!)
    const task = nativeTask(request, f.input.source.commonDir) as { targets: { nodeId: string; path: string }[]; requiredChangedPaths: string[] }, { nodeId, path } = behavior ? { nodeId: 'P0', path: '' } : task.targets[0]
    calls.push({ operation: active.id, nodeId, purpose: request.purpose, model: request.model })
    if (!behavior && active.id === f.operation.id && nodeId !== 'project' && approvedLeaf && approvedLeaf !== nodeId) throw Object.assign(new Error('兄弟owner尚未完成，保留局部独审'), { code: 'unsupported' })
    if (retryRound === 1 && request.purpose === 'elaboration_review' && defect !== 'newer-review' && !sealRepair) throw Object.assign(new Error('待审owner在新独审入口停止'), { code: 'unsupported' })
    if (retryRound === 2 && sealRepair && request.purpose === 'elaboration_generate') {
      const repair = (task as { repair?: Pick<ReadonlySpecRepair, 'kind' | 'generationRef' | 'findings'> & { diagnosticRoot: string } }).repair
      assert.equal(repair?.kind, 'partition_seal')
      assert.deepEqual(repair.generationRef, sealRef)
      assert.ok(repair.findings.some(finding => finding.code === 'missing-requirement-flow' && finding.itemId === parentId))
      assert.equal(repair.diagnosticRoot, '.spex-sync-diagnostics/' + repair.generationRef.sha256)
      assert.equal(Object.hasOwn(repair, 'specs'), false)
      const seal = (JSON.parse(readEvidence(f.input.source.commonDir, repair.generationRef).toString()) as ElaborationResult).partitionSeal!
      const overlayPaths = f.git('ls-tree', '-r', '--name-only', request.worktree!.baseCommit, '--', repair.diagnosticRoot).trim().split('\n').sort()
      assert.deepEqual(overlayPaths, seal.changes.map(change => repair.diagnosticRoot + '/' + change.path).sort())
      if (nodeId === approvedLeaf) assert.equal(f.git('rev-parse', request.worktree!.baseCommit + ':' + approvedLeafDraft!.path).trim(), approvedLeafDraft!.oid, '实际新seed逐字包含已回收原Native的Git草稿')
    }
    let output: unknown = retryRound === 1 && request.purpose === 'elaboration_review' && defect === 'newer-review'
      ? { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ kind: 'repair', code: 'root-review', affectedIds: [parentId], message: '须核实本共享接口义务', evidence: '原父接口与后代实际行为', decision: '保留原政策并补充准确接口' }] }
      : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    if (behavior) {
      assert.deepEqual(task.requiredChangedPaths, [])
      const reviewed = request.purpose === 'code_behavior_review' ? readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! : null
      output = reviewed ? { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: [], checkedChangeIds: [], findings: [] }
        : { changes: [], facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'elaboration_generate') {
      const generated = rows(nodeId === 'project' ? parentSource : nodeId === 'export-contract' ? original : other, path)
      generated.changes[0].nodeId = nodeId
      generated.applicability = generated.applicability.map(entry => ({ ...entry, applies: nodeId !== 'project', affectedIds: [nodeId === 'project' ? parentId : nodeId === 'export-contract' ? 'REQ-EXPORT-01' : 'REQ-IMPORT-01'] }))
      if (parentSeed && nodeId !== 'project') {
        if (!sealRepair || retryRound === 2) for (const row of generated.changes[0].tables.FLOW) row.req = [...row.req as string[], parentId]
        for (const row of generated.changes[0].tables.AC) row.covers = [...row.covers as string[], parentId]
      }
      output = adaptElaborationNativeOutput(request, generated)
    } else if (active.id === f.operation.id && nodeId !== 'project') approvedLeaf = nodeId
    const writing = behavior || request.purpose === 'elaboration_generate', workspace = join(f.parent, `partial-p1-${calls.length}`)
    if (!writing) f.git('worktree', 'add', '--detach', workspace, request.worktree!.baseCommit)
    const worktree = writing ? committedDraftFixture(f, request, output, workspace) : nativeWorktreeResult(workspace, request.worktree!)
    workspaces.push(workspace)
    const receipt = writing ? { summary: '原正常Git草稿及独立审查' } : output
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('fixture不得控制真实进程') },
      run: async native => {
        const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `partial-p1-${sessionId}`, turnId: 'turn' }, execution = structuredExecutionPolicy(native), resultDigest = contentHash(JSON.stringify(receipt))
        records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: nativeWorktreePrompt(native.prompt, native.worktree!), parent: null, launcher: null, base: native.base, structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output: receipt, resultDigest, ...(worktree ? { resultWorktree: worktree } : {}) } })
        return { sessionId, ...identity, output: receipt, resultDigest, ...(worktree ? { worktree } : {}) }
      },
    } })(request)
  }
  const first = await runSyncOperation(store, active.id, f.options)
  assert.equal(first.failure?.message, '兄弟owner尚未完成，保留局部独审', JSON.stringify(first.failure))
  const old = first.operation, [prior] = store.listAttempts(old.id), commonDir = f.input.source.commonDir
  const stages = (owner: SyncOperation, attempt: SyncAttempt) => readSyncCheckpoints(store, owner, attempt).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } })
  const approved = stages(old, prior).filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && (JSON.parse(readEvidence(commonDir, stage.resultRef).toString()) as ElaborationResult).reviewPassed)
  assert.equal(approved.length, parentSeed ? 2 : 1)
  const approvedLeafStage = sealRepair ? approved.find(stage => (JSON.parse(readEvidence(commonDir, stage.resultRef).toString()) as ElaborationResult).changes.some(change => change.nodeId === approvedLeaf)) : undefined
  if (sealRepair) approvedLeafDraft = (JSON.parse(readEvidence(commonDir, approvedLeafStage!.resultRef).toString()) as ElaborationResult).rounds.at(-1)!.draft
  const aggregate = stages(old, prior).find(stage => stage.stage === 'elaboration')!
  assert.equal((JSON.parse(readEvidence(commonDir, aggregate.resultRef).toString()) as ElaborationResult).reviewPassed, false)
  const oldBytes = JSON.stringify({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(prior.id) })
  for (const workspace of workspaces) f.git('worktree', 'remove', workspace)
  assert.ok(workspaces.every(workspace => !existsSync(workspace)), '正式结算后的原物理Native工作树已移除，冷复用只读保活Git与原记录')
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) }); f.useStore(store)
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'partial-p1-retry', rootCauseId: 'partial-p1-retry', retryOf: old.id, model: 'claude:default', origin: old.origin, budget: old.budget, managedRoot: f.managedRoot, baselineSelection: store.readBusinessBaselineSelection(old.id), executionScope: old.scope, impactDigest: old.impactDigest }))
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active); retryRound = 1
  const findResource = store.findResource.bind(store)
  if (!sealRepair && defect !== 'none') {
    const root = approved.map(stage => JSON.parse(readEvidence(commonDir, stage.resultRef).toString()) as ElaborationResult).find(result => result.phase === 'interface_seed')!
    const review = root.rounds.at(-1)!.traces.find(trace => trace.purpose === 'elaboration_review')!
    const dispatch = prior.dispatchPlans.find(dispatch => dispatch.session?.sessionId === review.sessionId)!, resource = findResource(prior.id, dispatch.key)!
    const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    const changed = { ...resource, checkpointRef: writeEvidence(commonDir, { ...checkpoint, result: { ...checkpoint.result!, threadId: 'wrong-original-review-thread' } }) }
    store.findResource = (attemptId, key) => attemptId === prior.id && key === dispatch.key ? changed : findResource(attemptId, key)
  }
  const checkpoint = store.checkpoint.bind(store)
  if (sealRepair) store.checkpoint = (fence, ref) => {
    const wrapper = JSON.parse(readEvidence(commonDir, ref).toString())
    if (store.readAttempt(fence.attemptId).number !== 2) return checkpoint(fence, ref)
    if (afterDispatch) {
      const result = wrapper.stage?.endsWith(':elaboration') && JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString()) as ElaborationResult | undefined
      const saved = checkpoint(fence, ref)
      if (result && result.readonlySpecRepair?.kind === 'partition_seal' && result.reviewPassed)
        throw Object.assign(new Error('fixture中断已派发并部分独审的封口返修'), { code: 'unsupported' })
      return saved
    }
    if (!wrapper.stage?.endsWith(':elaboration:readonly-repair-provenance')) return checkpoint(fence, ref)
    if (defect === 'seal-anchor') {
      const anchor = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString())
      const changed = { ...anchor, resultRef: anchor.generationRef }
      const changedRef = writeEvidence(commonDir, changed)
      const bound = { ...writeEvidence(commonDir, { ...wrapper, resultRef: changedRef }), artifacts: [...syncCheckpointArtifacts(changed, changedRef), { kind: 'json' as const, ref: wrapper.baselineSelectionRef }] }
      checkpoint(fence, bound)
    } else checkpoint(fence, ref)
    throw Object.assign(new Error('fixture中断已绑定的原封口返修，未预留Native'), { code: 'review_retry_binding' })
  }
  const second = await runSyncOperation(store, active.id, f.options), retried = calls.filter(call => call.operation === active.id)
  store.checkpoint = checkpoint
  store.findResource = findResource
  assert.equal(retried.some(call => call.nodeId === approvedLeaf || defect === 'none' && call.nodeId === 'project'), false, '原件一致的已accept叶与父接口必须零重派')
  if (!sealRepair) assert.deepEqual(retried.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'], JSON.stringify(second.failure))
  assert.ok(retried.every(call => call.model === active.model))
  if (sealRepair) {
    const [attempt, interrupted] = store.listAttempts(second.operation.id)
    interruptedRepair = interrupted
    assert.equal(attempt.failure?.code, 'partition_final_seal_failed')
    assert.equal(interrupted.failure?.code, afterDispatch ? 'unsupported' : 'review_retry_binding')
    assert.deepEqual(interrupted.dispatchPlans.map(dispatch => dispatch.purpose), afterDispatch ? ['elaboration_generate', 'elaboration_review'] : [])
    if (afterDispatch) assert.ok(interrupted.dispatchPlans.every(dispatch => findResource(interrupted.id, dispatch.key)?.phase === 'removed'))
    sealRef = stages(second.operation, attempt).find(stage => stage.stage === 'elaboration')!.resultRef
    const aggregate = JSON.parse(readEvidence(commonDir, sealRef).toString()) as ElaborationResult
    assert.equal(aggregate.reviewPassed, true)
    assert.equal(aggregate.partitionSeal?.passed, false)
    assert.ok(aggregate.partitionSeal!.findings.some(finding => finding.code === 'missing-requirement-flow' && finding.itemId === parentId))
  } else if (defect === 'newer-review') assert.equal(store.readAttempt(second.operation.currentAttemptId!).failure?.code, 'repair_budget_exhausted', JSON.stringify(second))
  else assert.equal(second.failure?.message, '待审owner在新独审入口停止', JSON.stringify(second.failure))
  const saved = stages(second.operation, sealRepair ? store.listAttempts(second.operation.id)[0] : store.readAttempt(second.operation.currentAttemptId!))
  for (const source of sealRepair ? [approvedLeafStage!] : defect === 'none' ? approved : []) {
    assert.deepEqual(saved.find(stage => stage.stage === source.stage)?.resultRef, source.resultRef)
    assert.deepEqual(JSON.parse(readEvidence(commonDir, saved.find(stage => stage.stage === `${source.stage}:provenance`)!.resultRef).toString()), { fromOperationId: old.id, fromAttemptId: prior.id, resultRef: source.resultRef })
  }
  assert.equal(JSON.stringify({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(prior.id) }), oldBytes)
  if (defect === 'review-identity') {
    assert.ok(retried.every(call => call.nodeId === 'project'), '原独审身份失配的父接口必须重新生成及独审')
    assert.equal(saved.some(stage => stage.stage?.endsWith(':elaboration:provenance')), false)
    return
  }
  const previous = second.operation
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'partial-p1-second-retry', rootCauseId: 'partial-p1-second-retry', retryOf: previous.id, model: 'zcode:default', origin: previous.origin, budget: previous.budget, managedRoot: f.managedRoot, baselineSelection: store.readBusinessBaselineSelection(previous.id), executionScope: previous.scope, impactDigest: previous.impactDigest }))
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active); retryRound = 2
  const controller = defect === 'seal-fence' ? new AbortController() : undefined
  let abortScheduled = false
  if (controller) {
    const origin = interruptedRepair!, key = origin.dispatchPlans[0].key
    store.findResource = (attemptId, requestKey) => {
      if (!abortScheduled && attemptId === origin.id && requestKey === key) {
        abortScheduled = true
        queueMicrotask(() => controller.abort())
      }
      return findResource(attemptId, requestKey)
    }
  }
  if (defect === 'seal-request') {
    const origin = interruptedRepair!, dispatch = origin.dispatchPlans[0], original = findResource(origin.id, dispatch.key)!
    const plan = JSON.parse(readEvidence(commonDir, original.plan.planBlob).toString()) as NativeRunPlan
    const wrong = writeEvidence(commonDir, { ...plan, request: { ...plan.request, inputDigest: 'foreign-repair-request' } })
    store.findResource = (attemptId, key) => attemptId === origin.id && key === dispatch.key ? { ...original, plan: { ...original.plan, planBlob: wrong } } : findResource(attemptId, key)
  }
  const third = await runSyncOperation(store, active.id, controller ? { ...f.options, signal: controller.signal } : f.options)
  store.findResource = findResource
  const continued = calls.filter(call => call.operation === active.id)
  if (controller) {
    assert.ok(abortScheduled && controller.signal.aborted)
    assert.equal(third.operation.control, 'pause')
    assert.equal(third.failure, undefined)
    assert.deepEqual(continued, [])
    const stopped = store.readAttempt(third.operation.currentAttemptId!)
    assert.deepEqual(stopped.dispatchPlans, [])
    assert.ok(stages(third.operation, stopped).every(stage => !stage.stage?.endsWith(':readonly-repair-provenance')))
    return
  }
  if (defect === 'seal-anchor' || defect === 'seal-request') {
    assert.equal(third.failure?.code, 'partition_final_seal_binding', JSON.stringify(third.failure))
    assert.deepEqual(continued, [])
    return
  }
  if (sealRepair) {
    const attempt = store.readAttempt(third.operation.currentAttemptId!)
    if (afterDispatch) assert.ok(continued.every(call => call.nodeId !== 'project'), '已结算并独审的同封口修复保持原批准')
    assert.deepEqual(continued.filter(call => call.nodeId === approvedLeaf).map(call => call.purpose), ['elaboration_generate', 'elaboration_review'], JSON.stringify({ continued, phase: third.operation.phase, failure: attempt.failure && { code: attempt.failure.code, message: attempt.failure.message.slice(0, 800) } }))
    const final = stages(third.operation, attempt).find(stage => stage.stage === 'elaboration')!
    const sealed = JSON.parse(readEvidence(commonDir, final.resultRef).toString()) as ElaborationResult
    assert.equal(sealed.partitionSeal?.passed, true, JSON.stringify(sealed.partitionSeal?.findings.filter(finding => finding.severity === 'error')))
  } else {
    assert.equal(continued.some(call => call.nodeId === approvedLeaf || defect === 'none' && call.nodeId === 'project'), false, '再次正式重试须回到各区原Native批准，不重派复制wrapper')
    assert.deepEqual(continued.map(call => call.purpose), defect === 'newer-review' ? ['elaboration_generate', 'elaboration_review', 'elaboration_generate', 'elaboration_review'] : ['elaboration_generate', 'elaboration_review'])
  }
  if (defect === 'newer-review') assert.equal(continued[0].nodeId, 'project', '同owner较新的真实业务repair不得被更早accept遮蔽')
  assert.ok(continued.every(call => call.model === active.model))
  assert.equal(third.failure?.message, '完整P1已重新封口', JSON.stringify(third.failure))
  if (!parentSeed) {
    const attempt = store.readAttempt(third.operation.currentAttemptId!)
    const final = stages(third.operation, attempt).find(stage => stage.stage === 'elaboration')!
    const local = approved.find(stage => (JSON.parse(readEvidence(commonDir, stage.resultRef).toString()) as ElaborationResult).changes.some(change => change.nodeId === approvedLeaf))!
    const authenticate = (operation: SyncOperation, after = 0) => continuationCoordinator.reviewedReadonlyLocal(store, operation, attempt, local.stage!, local.resultRef, final.resultRef, after)
    assert.equal(contentHash(JSON.stringify(authenticate(third.operation))), local.resultRef.sha256)
    assert.throws(() => authenticate(third.operation, 1), /readonly_spec_repair_binding/)
    assert.throws(() => authenticate({ ...third.operation, retryOf: undefined }), /readonly_spec_repair_binding/)
    assert.throws(() => authenticate({ ...third.operation, contractScopeExpansions: [] }), /readonly_spec_repair_binding/)
  }
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['observation', 'ordinary', 'mixed', 'recovered', 'empty-control', 'cached-control'] as const) test(`P1已结算进程观测失败仅收紧下一次真实返修，恢复后回到计划并发 failure=${mode}`, async t => {
  const importPath = '.spec/project/beta/import-contract/spec.md'
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const rawOnly = (source: string) => source.slice(0, source.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const controlAfter = mode === 'empty-control' ? 1 : mode === 'cached-control' ? 2 : 0
  const budget = { maxAttempts: controlAfter ? 4 : 3, maxCalls: 24, maxRepairs: 2, timeoutMs: 120_000 }
  const f = await fixture(t, budget, false, rawOnly(original), 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', agentWorkflow: 'native-worktree-v1', intentNodeId: 'export-contract', sourcePaths: ['src'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524_288, maxParallel: 2 },
  }, undefined, 'spec', 'cursor:default', false, {
    [importPath]: rawOnly(other), 'src/beta/import.js': 'export class ImportService {}\n',
    'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js'),
  })
  let store = f.store
  if (controlAfter) {
    const recordFailure = store.recordFailure.bind(store)
    store.recordFailure = (fence, issue) => {
      const result = recordFailure(fence, issue)
      if (store.readAttempt(fence.attemptId).number === controlAfter) store.requestControl(f.operation.id, 'pause')
      return result
    }
  }
  const originalRunner = f.options.runner!, waves = new Map<number, { started: number; running: number; peak: number; release?: () => void }>()
  f.options.runner = async request => {
    if (request.purpose !== 'elaboration_generate') return originalRunner(request)
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    const wave = waves.get(attempt.number) ?? { started: 0, running: 0, peak: 0 }
    waves.set(attempt.number, wave)
    const observationFailure = mode === 'observation' || (mode === 'mixed' && wave.started === 1) || ((mode === 'recovered' || controlAfter > 0) && attempt.number === 1)
    wave.started++
    wave.running++
    wave.peak = Math.max(wave.peak, wave.running)
    if (wave.running > 1) wave.release?.()
    else await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 2_000)
      wave.release = () => { clearTimeout(timer); resolve() }
    })
    wave.running--
    throw new StructuredSessionError('failed', observationFailure ? 'Cursor periodic native process observation did not recover' : 'ordinary execution failure')
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (controlAfter) {
    assert.equal(result.operation.control, 'pause')
    const previous = store.readAttempt(result.operation.currentAttemptId!), calls = result.operation.callsUsed
    store.requestControl(f.operation.id, 'run')
    const control = store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000 })
    if (mode === 'cached-control') {
      store.bindComposedInput(control.fence, previous.composedInput!)
      const ref = previous.checkpointRefs.find(ref => (JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage?: string }).stage === 'elaboration-draft-protocol')!
      const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { attemptId: string }
      store.checkpoint(control.fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, attemptId: control.attempt.id }), artifacts: ref.artifacts })
    }
    store.requestControl(f.operation.id, 'pause')
    const stoppedControl = store.readAttempt(control.attempt.id)
    assert.deepEqual(stoppedControl.dispatchPlans, []); assert.equal(stoppedControl.failure, null)
    assert.equal(stoppedControl.checkpointRefs.length, mode === 'cached-control' ? 1 : 0)
    assert.equal(store.readOperation(f.operation.id).callsUsed, calls)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    store.requestControl(f.operation.id, 'run')
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  const prior = store.listAttempts(f.operation.id)[0], peaks = [...waves.values()].map(wave => wave.peak)
  if (mode === 'mixed') assert.equal(prior.failure?.message, 'ordinary execution failure')
  assert.equal(prior.failure?.serialElaborationRetry, mode === 'ordinary' ? undefined : true)
  assert.equal(peaks[0], 2, JSON.stringify(result.failure))
  assert.equal(peaks[1], mode === 'ordinary' ? 2 : 1, JSON.stringify(result.failure))
  assert.equal(peaks[2], mode === 'observation' || mode === 'mixed' ? 1 : 2, '原观测故障不能在后续真实返修已无该故障时永久收紧并发')
  assert.equal(waves.size, 3)
  assert.equal(result.operation.input.id, f.input.id)
  assert.equal(result.operation.policyDigest, f.operation.policyDigest)
  assert.equal(result.operation.model, f.operation.model)
  assert.deepEqual(result.operation.budget, f.operation.budget)
  assert.equal(store.listRecoverableResources().length, 0)
  assert.equal(result.operation.callsUsed, 6)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  t.diagnostic(JSON.stringify({ mode, peaks: [...waves].map(([attempt, wave]) => ({ attempt, peak: wave.peak, started: wave.started })), callsUsed: result.operation.callsUsed }))
})

test('P0正式retry只重新派发未独审通过的分区，保留原模型和Git独审证明', async t => {
  const importPath = '.spec/project/import-contract/spec.md', importSpec = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 24, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js', 'src/import.js'] },
  }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', true, { [importPath]: importSpec, 'src/import.js': 'export class ImportService {}\n', 'tests/import.test.mjs': 'import assert from "node:assert/strict"\n' })
  let store = f.store, active = f.operation, approved = ''
  const calls: { operation: string; partition: string; purpose: string; model?: string }[] = []
  f.options.runner = async request => {
    if (!request.purpose.startsWith('code_behavior_')) throw Object.assign(new Error('完整P0已组装'), { code: 'unsupported' })
    const attempt = store.readAttempt(store.readOperation(active.id).currentAttemptId!)
    const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[]; partition: { id: string } }
    const partition = task.partition.id
    calls.push({ operation: active.id, partition, purpose: request.purpose, model: request.model })
    if (active.id === f.operation.id && approved && approved !== partition) throw Object.assign(new Error('另一分区真实停止，首区已独审'), { code: 'failed' })
    const reviewed = request.purpose === 'code_behavior_review' ? readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! : null
    const domain = task.requiredChangedPaths.some(path => path.includes('import')) ? 'IMPORT' : 'EXPORT'
    const output = reviewed ? { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
      : { changes: task.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${domain}-05`], ruleIds: [`RULE-${domain}-05`], originalIntent: '保留原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '保留权限' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    const worktree = committedDraftFixture(f, request, output, join(f.parent, `formal-p0-${calls.length}`))
    if (reviewed && active.id === f.operation.id) approved = partition
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, receipt = { summary: '分区原Git草稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `formal-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree }
  }
  const first = await runSyncOperation(store, active.id, f.options)
  assert.equal(first.operation.phase, 'failed')
  assert.ok(approved)
  const old = first.operation, [prior] = store.listAttempts(old.id), key = `partition:${approved}:analysis`
  const commonDir = f.input.source.commonDir
  const stages = (operation: typeof old, attempt: typeof prior) => readSyncCheckpoints(store, operation, attempt).json.map(item => item.value as { stage?: string; resultRef: import('./operation-types.js').BlobRef })
  const accepted = stages(old, prior).find(stage => stage.stage === key)!
  assert.ok(accepted)
  assert.equal(stages(old, prior).some(stage => stage.stage === 'analysis'), false)
  const bytes = JSON.stringify({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id) })
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) }); f.useStore(store)
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'partial-approved-p0-retry', rootCauseId: 'partial-approved-p0-retry', retryOf: old.id, model: 'claude:default', origin: old.origin, budget: old.budget, managedRoot: f.managedRoot, baselineSelection: store.readBusinessBaselineSelection(old.id), executionScope: old.scope }))
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
  const outcome = await runSyncOperation(store, active.id, f.options)
  const retried = calls.filter(call => call.operation === active.id)
  assert.equal(retried.some(call => call.partition === approved), false, '已有真实独审的分区必须零重派')
  assert.deepEqual(retried.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
  assert.ok(retried.every(call => call.model === 'claude:default'))
  assert.equal(outcome.failure?.message, '完整P0已组装')
  const current = store.readAttempt(outcome.operation.currentAttemptId!), saved = stages(outcome.operation, current)
  assert.deepEqual(saved.find(stage => stage.stage === key)?.resultRef, accepted.resultRef)
  const provenance = saved.find(stage => stage.stage === `${key}:provenance`)!
  assert.deepEqual(JSON.parse(readEvidence(commonDir, provenance.resultRef).toString()), { fromOperationId: old.id, fromAttemptId: prior.id, resultRef: accepted.resultRef })
  assert.equal(saved.some(stage => stage.stage === `${key}:continuation`), false)
  assert.equal(JSON.stringify({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id) }), bytes)

  const parent = outcome.operation
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'partial-approved-p0-second-retry', rootCauseId: 'partial-approved-p0-second-retry', retryOf: parent.id, model: 'zcode:glm-5.3-flash', origin: parent.origin, budget: parent.budget, managedRoot: f.managedRoot, baselineSelection: store.readBusinessBaselineSelection(parent.id), executionScope: parent.scope }))
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
  assert.equal(store.readOperation(old.id).phase, 'superseded')
  const third = await runSyncOperation(store, active.id, f.options)
  assert.equal(calls.some(call => call.operation === active.id), false, '第二次正式重试须沿祖先找到各区原始批准')
  assert.equal(third.failure?.message, '完整P0已组装')
  const carried = stages(third.operation, store.readAttempt(third.operation.currentAttemptId!))
  assert.deepEqual(carried.find(stage => stage.stage === key)?.resultRef, accepted.resultRef)
  assert.deepEqual(JSON.parse(readEvidence(commonDir, carried.find(stage => stage.stage === `${key}:provenance`)!.resultRef).toString()), { fromOperationId: old.id, fromAttemptId: prior.id, resultRef: accepted.resultRef })
})

// A1格式拒绝、A2局部accept但兄弟再失败、A3只续失败兄弟；不能把跨attempt的原analyze trace丢掉。
test('Native P0三attempt保留已审兄弟，analysis与review沿精确Git/Native provenance承接', async t => {
  const importPath = '.spec/project/import-contract/spec.md', importSpec = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 24, maxRepairs: 2, timeoutMs: 120_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 2 }, commitTrigger: { before: null, paths: ['src/export.js', 'src/import.js'] },
  }, undefined, 'code', 'claude:MiniMax-M3.1-Flash', true, { [importPath]: importSpec, 'src/import.js': 'export class ImportService {}\n', 'tests/import.test.mjs': 'import assert from "node:assert/strict"\n' })
  const calls: { attempt: number; domain: string; purpose: string }[] = []
  f.options.runner = async request => {
    if (!request.purpose.startsWith('code_behavior_')) throw Object.assign(new Error('三轮P0已验证，在P1前停止'), { code: 'unsupported' })
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    const brief = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }
    const domain = brief.requiredChangedPaths.some(path => path.includes('import')) ? 'IMPORT' : 'EXPORT'
    calls.push({ attempt: attempt.number, domain, purpose: request.purpose })
    const workspace = join(f.parent, `three-p0-${calls.length}`), path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    const reviewed = request.purpose === 'code_behavior_review' ? readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis } : null
    const output = reviewed ? { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: brief.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
      : { changes: brief.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${domain}-05`], ruleIds: [`RULE-${domain}-05`], originalIntent: '保留原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '不得改变权限或发布次数' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    const text = reviewed && (attempt.number === 1 || domain === 'IMPORT' && attempt.number === 2) ? '{ ORIGINAL_THREE_ATTEMPT_REVIEW' : JSON.stringify(output)
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text)
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'three attempt real draft'], { stdio: 'pipe' })
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!, receipt = { summary: '三轮真实Git草稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `three-${request.requestKey}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(f.store.listAttempts(f.operation.id).length, 3)
  assert.deepEqual(calls.filter(call => call.domain === 'EXPORT').map(call => [call.attempt, call.purpose]), [[1, 'code_behavior_analyze'], [1, 'code_behavior_review'], [2, 'code_behavior_review']])
  assert.deepEqual(calls.filter(call => call.domain === 'IMPORT').map(call => [call.attempt, call.purpose]), [[1, 'code_behavior_analyze'], [1, 'code_behavior_review'], [2, 'code_behavior_review'], [3, 'code_behavior_review']])
  const last = f.store.listAttempts(f.operation.id).at(-1)!
  const stages = last.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string })
  assert.ok(stages.some(stage => stage.stage.endsWith(':analysis:provenance')))
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const [protocolRounds, staleCarry, tamper] of [[1, false, 'none'], [1, true, 'none'], [2, false, 'none'], ...(['native-operation', 'native-input', 'native-digest', 'schema', 'git', 'provenance', 'purpose'] as const).map(tamper => [1, false, tamper] as const)] as const) test(`Native P0协议续审后业务repair沿原分析来源SQLite冷恢复 protocolRounds=${protocolRounds} staleCarry=${staleCarry} tamper=${tamper}`, async t => {
  const importPath = '.spec/project/import-contract/spec.md', importSpec = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const semanticRound = protocolRounds + 1, staleRound = staleCarry ? semanticRound + 1 : -1, rounds = semanticRound + (staleCarry ? 2 : 1)
  const f = await fixture(t, { maxAttempts: rounds, maxCalls: 24, maxRepairs: rounds - 1, timeoutMs: 300_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 2 }, commitTrigger: { before: null, paths: ['src/export.js', 'src/import.js'] },
  }, undefined, 'code', 'claude:default', true, { [importPath]: importSpec, 'src/import.js': 'export class ImportService {}\n', 'tests/import.test.mjs': 'import assert from "node:assert/strict"\n' })
  let store = f.store, reopened: ReturnType<typeof openProtocol> | undefined, targetKey = '', siblingKey = '', analysisText = '', semanticReviewGitRef = ''
  const realNow = Date.now
  let clockAdvance = 0
  if (staleCarry) { Date.now = () => realNow() + clockAdvance; t.after(() => { Date.now = realNow }) }
  const calls: { attempt: number; domain: string; purpose: string; sessionId: string; threadId: string }[] = [], records = new Map<string, NativeRunRecord>()
  const finding = { message: '真实业务遗漏需重做分析', evidence: '原冻结源码与完整测试', counterexample: '不得漏掉幂等行为' }
  const frozenObjects = readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  t.after(() => reopened?.close())
  f.options.runner = async request => {
    if (!request.purpose.startsWith('code_behavior_')) throw Object.assign(new Error('冷恢复P0及新独审已验证，在P1前停止'), { code: 'unsupported' })
    const operation = store.readOperation(f.operation.id), attempt = store.readAttempt(operation.currentAttemptId!), seed = request.worktree!
    const brief = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }
    const domain = brief.requiredChangedPaths.some(path => path.includes('import')) ? 'IMPORT' : 'EXPORT'
    const partitionKey = `partition:${request.requestKey.split(':partition:')[1].split(':')[0]}:analysis`
    if (domain === 'EXPORT') targetKey = partitionKey
    else siblingKey = partitionKey
    const reviewed = request.purpose === 'code_behavior_review' ? readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis } : null
    if (reviewed && domain === 'EXPORT' && attempt.number === 1) {
      while (!latest(store.readAttempt(attempt.id), siblingKey)) {
        if (request.signal?.aborted) throw new Error('fixture已审兄弟前提尚未成立即被停止')
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    }
    const output = reviewed ? { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: brief.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] as typeof finding[] }
      : { changes: brief.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${domain}-05`], ruleIds: [`RULE-${domain}-05`], originalIntent: '保留原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '不得改变权限或发布次数' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    if (reviewed && domain === 'EXPORT' && attempt.number <= semanticRound) {
      const review = output as { verdict: string; checkedChangeIds: string[]; findings: typeof finding[] }
      review.verdict = 'repair'; review.findings = [finding]
      if (attempt.number <= protocolRounds) review.checkedChangeIds[0] += 'e'
    }
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    if (domain === 'EXPORT' && attempt.number === rounds && !reviewed) {
      assert.equal(readObject(f.input.source.commonDir, readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path)!.oid).toString('utf8'), analysisText, '语义repair必须续原分析JSON，不能从零重答')
      assert(semanticReviewGitRef)
      assert.ok(request.prompt.includes(`git show ${semanticReviewGitRef}`))
      const context = readCodeBehaviorContext(request, f.input.source.commonDir)
      assert.deepEqual(context.repairDiagnostics, [])
      assert.deepEqual(context.errors, [])
      assert.deepEqual(JSON.parse(f.git('show', semanticReviewGitRef)).findings, [finding])
      assert.ok(!request.prompt.includes(finding.message))
    }
    const carried = domain === 'EXPORT' && attempt.number === staleRound
    const actual = carried ? undefined : committedDraftFixture(f, request, output, join(f.parent, `semantic-p0-${contentHash(request.requestKey)}`))
    if (domain === 'EXPORT' && attempt.number === semanticRound && reviewed && actual) semanticReviewGitRef = `${actual.headCommit}:${path}`
    if (domain === 'EXPORT' && attempt.number === 1 && !reviewed) analysisText = JSON.stringify(output)
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    try { return await createAttemptRunner(store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null,
      cancel: async () => { throw new Error('fixture不得控制真实进程') },
      run: async native => {
        const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `semantic-${sessionId}`, turnId: 'turn' }, receipt = { summary: '真实Git草稿与原Native资源绑定' }, resultDigest = contentHash(JSON.stringify(receipt)), execution = structuredExecutionPolicy(native)
        calls.push({ attempt: attempt.number, domain, purpose: request.purpose, sessionId, threadId: identity.threadId })
        if (carried) {
          records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: nativeWorktreePrompt(native.prompt, seed), parent: null, launcher: null, ...(native.base?.trim() ? { base: native.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'stopped' } } })
          throw new StructuredSessionError('cancelled', '旧版搬运后的新review已停止，无新产物', { sessionId, ...identity })
        }
        records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: nativeWorktreePrompt(native.prompt, seed), parent: null, launcher: null, ...(native.base?.trim() ? { base: native.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output: receipt, resultDigest, resultWorktree: actual } })
        return { sessionId, ...identity, output: receipt, resultDigest, worktree: actual }
      },
    } })(request) } catch (error) { if (carried) store.requestControl(f.operation.id, 'pause'); throw error }
  }
  const wrappers = (attempt: import('./operation-types.js').SyncAttempt) => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } })
  const latest = (attempt: import('./operation-types.js').SyncAttempt, key: string) => wrappers(attempt).filter(wrapper => wrapper.stage === key).at(-1)!
  let semanticRef: { sha256: string } | undefined, siblingRef: { sha256: string } | undefined
  for (let round = 1; round <= rounds; round++) {
    if (round === semanticRound && tamper !== 'none') {
      const recordFailure = store.recordFailure.bind(store)
      store.recordFailure = (fence, failure) => {
        const current = store.readAttempt(fence.attemptId), saved = latest(current, `${targetKey}:continuation`)
        const value = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation
        const originalWrapper = current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.resultRef?.sha256 === saved.resultRef.sha256)
        if (tamper.startsWith('native-')) {
          const origin = store.listAttempts(f.operation.id)[0], dispatch = origin.dispatchPlans.find(dispatch => dispatch.purpose === 'code_behavior_analyze' && dispatch.key.includes(targetKey.split(':')[1]))!, resource = store.findResource(origin.id, dispatch.key)!
          const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
          if (tamper === 'native-digest') {
            // 机制反例：Native原件自身摘要完全一致，但其真实业务inputDigest不同于continuation链。
            const source = latest(origin, `${targetKey}:continuation`), sourceValue = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation
            const sourceWrapper = origin.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.resultRef?.sha256 === source.resultRef.sha256)
            const native = JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
            const request = JSON.parse(readEvidence(f.input.source.commonDir, sourceValue.readyAnalysis!.requestRef).toString()) as ElaborationSessionRequest
            native.request.inputDigest = request.inputDigest = sourceValue.readyAnalysis!.trace.inputDigest = contentHash('different-native-business-input')
            native.requestDigest = dispatch.requestDigest = checkpoint.requestDigest = resource.plan.payloadDigest = contentHash(JSON.stringify(native.request))
            sourceValue.readyAnalysis!.requestRef = writeEvidence(f.input.source.commonDir, request)
            const sourceRef = writeEvidence(f.input.source.commonDir, sourceValue), wrapperRef = writeEvidence(f.input.source.commonDir, { ...sourceWrapper, resultRef: sourceRef })
            origin.checkpointRefs[origin.checkpointRefs.findIndex(ref => ref.sha256 === contentHash(JSON.stringify(sourceWrapper)))] = wrapperRef
            resource.plan.planBlob = writeEvidence(f.input.source.commonDir, native); resource.checkpointRef = writeEvidence(f.input.source.commonDir, checkpoint)
            resource.checkpoints.at(-1)!.checkpointRef = resource.checkpointRef
            const protocol = reopened ?? f.protocol
            protocol.withTransaction(tx => {
              tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify(origin), origin.id)
              tx.exec('UPDATE sync_resources SET payload_digest=?,checkpoint_sha=?,record_json=? WHERE id=?', resource.plan.payloadDigest, resource.checkpointRef.sha256, JSON.stringify(resource), resource.id)
            })
            const provenance = { fromOperationId: f.operation.id, fromAttemptId: origin.id, resultRef: sourceRef }, resultRef = writeEvidence(f.input.source.commonDir, provenance)
            store.checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...originalWrapper, stage: `${targetKey}:continuation-provenance`, resultRef }), artifacts: syncCheckpointArtifacts(provenance, resultRef) })
            assert.equal(native.requestDigest, contentHash(JSON.stringify(native.request)))
            assert.notEqual(native.request.inputDigest, sourceValue.inputDigest)
          } else {
            if (tamper === 'native-operation') checkpoint.operationId = 'foreign-operation'
            else checkpoint.inputId = contentHash('foreign-input')
            store.recordResourceCheckpoint(resource.id, { operationId: resource.operationId, attemptId: resource.attemptId, inputId: resource.plan.inputId, candidateDigest: resource.plan.candidateDigest, phase: 'removed', expectedCheckpointRef: resource.checkpointRef, checkpointRef: writeEvidence(f.input.source.commonDir, checkpoint) })
          }
        } else {
          let stage = `${targetKey}:continuation`, result: unknown = value
          if (tamper === 'schema') value.drafts.code_behavior_analyze!.schemaDigest = contentHash('foreign-schema')
          if (tamper === 'git') value.drafts.code_behavior_analyze!.resultCommit = value.drafts.code_behavior_analyze!.seed.baseCommit
          if (tamper === 'purpose') value.drafts.code_behavior_review = structuredClone(value.drafts.code_behavior_analyze)
          if (tamper === 'provenance') {
            stage = `${targetKey}:continuation-provenance`
            result = { fromOperationId: f.operation.id, fromAttemptId: store.listAttempts(f.operation.id)[0].id, resultRef: writeEvidence(f.input.source.commonDir, { unrelated: true }) }
          }
          const resultRef = writeEvidence(f.input.source.commonDir, result)
          store.checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...originalWrapper, stage, resultRef }), artifacts: syncCheckpointArtifacts(result, resultRef) })
        }
        return recordFailure(fence, failure)
      }
    }
    if (round < rounds) {
      const claim = store.claimQueuedAttempt.bind(store)
      store.claimQueuedAttempt = input => {
        if (store.listAttempts(f.operation.id).some(attempt => attempt.number === round && attempt.status === 'failed')) throw new Error('fixture durable P0 process boundary')
        const next = claim(input)
        if (round === staleRound) {
          // 重放旧版本已写入的搬运状态；不改祖先原件，也不伪造本轮成功结果。
          const first = store.listAttempts(f.operation.id)[0], source = latest(first, `${targetKey}:continuation`)
          const originalWrapper = first.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(wrapper => wrapper.resultRef?.sha256 === source.resultRef.sha256)
          for (const [stage, value] of [[`${targetKey}:continuation-provenance`, { fromOperationId: f.operation.id, fromAttemptId: first.id, resultRef: source.resultRef }], [`${targetKey}:continuation`, JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString())]] as const) {
            const resultRef = writeEvidence(f.input.source.commonDir, value)
            store.checkpoint(next.fence, { ...writeEvidence(f.input.source.commonDir, { ...originalWrapper, attemptId: next.attempt.id, stage, resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
          }
        }
        return next
      }
    }
    await runSyncOperation(store, f.operation.id, f.options)
    const attempts = store.listAttempts(f.operation.id), current = attempts.at(-1)!
    assert.equal(attempts.length, round)
    if (round === 1) {
      const sibling = latest(current, siblingKey)
      assert.ok(sibling, JSON.stringify({ failure: current.failure, calls, stages: wrappers(current).map(wrapper => wrapper.stage) }))
      siblingRef = sibling.resultRef
    }
    if (round < rounds) {
      if (round === staleRound) {
        const dispatch = current.dispatchPlans.find(dispatch => dispatch.purpose === 'code_behavior_review')!, resource = store.findResource(current.id, dispatch.key)!
        const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
        assert.equal(resource.phase, 'removed'); assert.equal(checkpoint.nativeState, 'cancelled')
        assert.equal(checkpoint.result, undefined); assert.equal(checkpoint.failure, undefined)
        store.requestControl(f.operation.id, 'run')
        clockAdvance = 60_000 // 正式冷恢复要越过原租约；不等待真实一分钟或改生产期限。
      } else assert.equal(current.failure?.code, 'behavior_review_failed', JSON.stringify({ failure: current.failure, calls }))
      const saved = latest(current, `${targetKey}:continuation`), continuation = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation
      assert.equal(!!continuation.readyAnalysis, round <= protocolRounds || round === staleRound)
      if (round === semanticRound) {
        semanticRef = saved.resultRef
        assert.deepEqual(current.dispatchPlans.filter(dispatch => dispatch.purpose.startsWith('code_behavior_')).map(dispatch => dispatch.purpose), ['code_behavior_review'])
        if (tamper !== 'purpose') assert.deepEqual(JSON.parse(readObject(f.input.source.commonDir, continuation.drafts.code_behavior_review!.oid).toString()).findings, [finding])
      }
      if (reopened) reopened.close()
      else f.closeForRestart()
      reopened = openProtocol(join(f.parent, 'sync.sqlite'))
      store = new SyncStore(reopened, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store); records.clear()
    }
  }
  const attempts = store.listAttempts(f.operation.id), last = attempts.at(-1)!
  const targetCalls = calls.filter(call => call.domain === 'EXPORT')
  if (tamper !== 'none') {
    assert.equal(targetCalls.some(call => call.attempt === rounds && call.purpose === 'code_behavior_analyze'), false, '失配来源不能取得继承分析稿资格')
    if (tamper.startsWith('native-')) {
      assert.equal(targetCalls.some(call => call.attempt === rounds), false)
      assert.equal(last.failure?.code, 'behavior_continuation_binding')
    } else {
      const selected = JSON.parse(readEvidence(f.input.source.commonDir, latest(last, `${targetKey}:continuation-provenance`).resultRef).toString())
      assert.notEqual(selected.resultRef.sha256, semanticRef!.sha256, '同OID但schema/Git/purpose或provenance失配的continuation不得被采用')
    }
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
    assert.equal(store.listJournals(f.operation.id).length, 0)
    t.diagnostic(JSON.stringify({ tamper, preservedAnalysisOid: JSON.parse(readEvidence(f.input.source.commonDir, latest(attempts[semanticRound - 1], `${targetKey}:continuation`).resultRef).toString()).drafts.code_behavior_analyze.oid, rejectedSemanticRef: semanticRef, finalCalls: targetCalls.filter(call => call.attempt === rounds), failureCode: last.failure?.code }))
    return
  }
  assert.deepEqual(targetCalls.map(call => [call.attempt, call.purpose]), [[1, 'code_behavior_analyze'], ...Array.from({ length: semanticRound }, (_, index) => [index + 1, 'code_behavior_review']), ...staleCarry ? [[staleRound, 'code_behavior_review']] : [], [rounds, 'code_behavior_analyze'], [rounds, 'code_behavior_review']], `最新业务repair必须触发分析，不能复活更早readyAnalysis: ${JSON.stringify(last.failure)}`)
  assert.deepEqual(calls.filter(call => call.domain === 'IMPORT').map(call => [call.attempt, call.purpose]), [[1, 'code_behavior_analyze'], [1, 'code_behavior_review']])
  const provenance = JSON.parse(readEvidence(f.input.source.commonDir, latest(last, `${targetKey}:continuation-provenance`).resultRef).toString())
  assert.equal(provenance.fromAttemptId, attempts[semanticRound - 1].id); assert.deepEqual(provenance.resultRef, semanticRef)
  assert.deepEqual(latest(last, siblingKey).resultRef, siblingRef)
  const fresh = targetCalls.filter(call => call.attempt === rounds)
  assert.notEqual(fresh[0].sessionId, fresh[1].sessionId); assert.notEqual(fresh[0].threadId, fresh[1].threadId)
  assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), frozenObjects)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(store.listJournals(f.operation.id).length, 0)
  t.diagnostic(JSON.stringify({ protocolRounds, staleCarry, coldRestarts: rounds - 1, calls, latestSemanticRef: semanticRef, siblingRef, reusedSiblingRef: latest(last, siblingKey).resultRef, finalStatus: store.readOperation(f.operation.id).phase }))
})


for (const tamper of ['none', 'review-identity', 'analysis-digest', 'owner'] as const) test(`正式retryOf保留父unsupported时跨attempt独审的完整业务finding tamper=${tamper}`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] },
  }, undefined, 'code', 'claude:default', true)
  let store = f.store, active = f.operation, retried = false, key = '', analysisText = '', newPrompt = '', newCalls = 0
  const finding = [
    { message: '权威业务锚已失效', evidence: '原冻结锚与调用方全文', counterexample: '不能沿无效锚解释现行为' },
    { message: '遗漏断开连接回调', evidence: 'onDisconnect真实调用与断言', counterexample: '断开后必须释放原资源' },
  ]
  const records = new Map<string, NativeRunRecord>()
  const wrappers = (attempt: import('./operation-types.js').SyncAttempt) => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string; resultRef: { sha256: string } })
  const latest = (attempt: import('./operation-types.js').SyncAttempt) => wrappers(attempt).filter(wrapper => wrapper.stage === `${key}:continuation`).at(-1)!
  f.options.runner = async request => {
    const operation = store.readOperation(active.id), attempt = store.readAttempt(operation.currentAttemptId!), seed = request.worktree!
    key = `partition:${request.requestKey.split(':partition:')[1].split(':')[0]}:analysis`
    const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    if (retried) {
      newCalls++
      assert.equal(request.purpose, 'code_behavior_analyze', '正式后继必须重做分析，不能继承旧ready/accept')
      const entry = readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path)
      assert.ok(entry, '跨attempt原分析Git稿必须进入新seed')
      assert.equal(readObject(f.input.source.commonDir, entry.oid).toString(), analysisText)
      const context = readCodeBehaviorContext(request, f.input.source.commonDir)
      assert.deepEqual(context.errors, [])
      assert.deepEqual(context.repairDiagnostics, [])
      for (const item of finding) assert.ok(!request.prompt.includes(item.message))
      const originalReview = /用 git show ([a-f0-9]+):(\.spex-sync-drafts\/[a-f0-9]+\.json) 读取本区最近一次真实业务独审/.exec(request.prompt)
      assert.ok(originalReview, '父unsupported且无partitionFailures仍须引用原Git独审')
      const original = execFileSync('git', ['-C', f.root, 'show', `${originalReview[1]}:${originalReview[2]}`], { encoding: 'utf8' })
      assert.deepEqual(JSON.parse(original).findings, finding)
      newPrompt = request.prompt
      throw Object.assign(new Error('fixture已核新analyze seed和完整prompt，停止于模型调用边界'), { code: 'unsupported' })
    }
    const brief = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }
    const reviewed = request.purpose === 'code_behavior_review' ? readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis } : null
    const output = reviewed ? { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'repair', checkedPaths: brief.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: finding }
      : { changes: brief.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保留原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '不得漏掉现行为' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    if (reviewed && attempt.number === 1) output.checkedChangeIds![0] += 'e'
    if (!reviewed) analysisText = JSON.stringify(output)
    const actual = committedDraftFixture(f, request, output, join(f.parent, `cross-review-${contentHash(request.requestKey)}`))
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(store, fence, { pollMs: 2, runtime: {
      readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('fixture不得控制真实进程') },
      run: async native => {
        const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `cross-review-${sessionId}`, turnId: 'turn' }, receipt = { summary: '真实Git及Native资源' }, resultDigest = contentHash(JSON.stringify(receipt)), execution = structuredExecutionPolicy(native)
        records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: nativeWorktreePrompt(native.prompt, seed), parent: null, launcher: null, base: native.base, structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output: receipt, resultDigest, resultWorktree: actual } })
        return { sessionId, ...identity, output: receipt, resultDigest, worktree: actual }
      },
    } })(request)
  }
  const claim = store.claimQueuedAttempt.bind(store)
  store.claimQueuedAttempt = input => {
    if (store.listAttempts(active.id).some(attempt => attempt.number === 1 && attempt.status === 'failed')) throw new Error('fixture首轮协议失败后的真实冷边界')
    return claim(input)
  }
  await runSyncOperation(store, active.id, f.options)
  assert.equal(store.listAttempts(active.id).length, 1)
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  const checkpoint = store.checkpoint.bind(store), recordFailure = store.recordFailure.bind(store)
  store.checkpoint = (fence, ref) => {
    const wrapper = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { stage: string }
    return wrapper.stage === 'partition:analysis-failures' ? store.readAttempt(fence.attemptId) : checkpoint(fence, ref)
  }
  store.recordFailure = (fence, failure) => recordFailure(fence, { ...failure, code: 'failed', kind: 'unsupported', message: '真实外部CLI失败；根details为空' })
  await runSyncOperation(store, active.id, f.options)
  const semantic = store.listAttempts(active.id).at(-1)!, saved = latest(semantic), continuation = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) as import('./code-behavior.js').CodeBehaviorContinuation
  assert.equal(semantic.number, 2); assert.equal(semantic.failure?.kind, 'unsupported'); assert.equal(semantic.failure.code, 'failed')
  assert.equal(wrappers(semantic).some(wrapper => wrapper.stage === 'partition:analysis-failures'), false)
  assert.deepEqual(semantic.dispatchPlans.map(dispatch => dispatch.purpose), ['code_behavior_review'])
  assert.equal(continuation.readyAnalysis, undefined); assert.ok(continuation.reviewResult); assert.deepEqual(continuation.errors?.code_behavior_review ?? [], [])
  assert.deepEqual(JSON.parse(readObject(f.input.source.commonDir, continuation.drafts.code_behavior_review!.oid).toString()).findings, finding)
  if (tamper !== 'none') {
    if (tamper === 'review-identity') continuation.reviewResult!.trace.sessionId = 'foreign-review-session'
    if (tamper === 'owner') continuation.drafts.code_behavior_review!.ownerDigest = contentHash('foreign-review-owner')
    if (tamper === 'analysis-digest') {
      const review = JSON.parse(readObject(f.input.source.commonDir, continuation.drafts.code_behavior_review!.oid).toString())
      review.analysisDigest = contentHash('foreign-analysis')
      const originalRequest = JSON.parse(readEvidence(f.input.source.commonDir, continuation.reviewResult!.requestRef).toString()) as ElaborationSessionRequest
      const actual = committedDraftFixture(f, originalRequest, review, join(f.parent, 'wrong-review-analysis'))
      continuation.drafts.code_behavior_review = { ...continuation.drafts.code_behavior_review!, resultCommit: actual.headCommit, resultTree: actual.tree, oid: readTree(f.input.source.commonDir, actual.tree).find(entry => entry.path === continuation.drafts.code_behavior_review!.path)!.oid }
      continuation.reviewResult!.draftOid = continuation.drafts.code_behavior_review.oid; continuation.reviewResult!.resultCommit = actual.headCommit
    }
    const previous = semantic.checkpointRefs.findIndex(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).resultRef?.sha256 === saved.resultRef.sha256)
    semantic.checkpointRefs[previous] = { ...writeEvidence(f.input.source.commonDir, { ...saved, version: 'sync-stage-v1', operationId: active.id, attemptId: semantic.id, inputId: f.input.id, policyDigest: active.policyDigest, readSetDigest: active.readSetDigest, baselineSelectionRef: writeEvidence(f.input.source.commonDir, store.readBusinessBaselineSelection(active.id)), resultRef: writeEvidence(f.input.source.commonDir, continuation) }) }
    protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify(semantic), semantic.id))
  }
  const parent = store.readOperation(active.id), before = JSON.stringify({ operation: parent, attempts: store.listAttempts(active.id) })
  const oldRefs = store.listAttempts(active.id).flatMap(attempt => attempt.checkpointRefs.map(ref => ({ ref, bytes: readEvidence(f.input.source.commonDir, ref) })))
  store.checkpoint = checkpoint; store.recordFailure = recordFailure
  active = store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'cross-review-successor', rootCauseId: 'cross-review-successor', retryOf: parent.id, model: 'zcode:default', origin: parent.origin, budget: parent.budget, managedRoot: f.managedRoot, baselineSelection: parent.baselineSelection, executionScope: parent.scope, impactDigest: parent.impactDigest }))
  active = store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active); retried = true
  const result = await runSyncOperation(store, active.id, f.options)
  if (tamper === 'none') assert.ok(newPrompt, JSON.stringify(result.failure))
  else { assert.equal(newPrompt, ''); assert.equal(newCalls, 0); assert.ok(result.failure, '错误review身份/owner/analysis绑定不能投新分析') }
  assert.equal(JSON.stringify({ operation: store.readOperation(parent.id), attempts: store.listAttempts(parent.id) }), before)
  for (const { ref, bytes } of oldRefs) assert.deepEqual(readEvidence(f.input.source.commonDir, ref), bytes)
  assert.equal(store.listJournals(active.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

// 先实际持久并认证被拒Native final，再在协调器外断言下一seed内容；不能用read/edit模式差异代替丢稿证明。
for (const invalidity of ['syntax', 'schema'] as const) for (const formalRetry of [false, true]) test(`P0已认证Native ${invalidity}原final必须进入下一attempt临时输入 retryOf=${formalRetry}`, async t => {
  const f = await fixture(t, { maxAttempts: formalRetry ? 1 : 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:MiniMax-M3.1-Flash')
  let active = f.operation
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
  f.store.reserveDispatch(claimed.fence, { key: `sync:${claimed.attempt.id}:frozen-read-p0`, purpose: 'code_behavior_analyze', requestDigest: contentHash('既有冻结只读请求') })
  const rejectedText = invalidity === 'syntax' ? '{ "changes": [ ORIGINAL_SYNTAX_REJECTED 原文🙂\r\n' : JSON.stringify({ changes: 'ORIGINAL_SCHEMA_REJECTED 原文🙂', facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] })
  let firstRequest: ElaborationSessionRequest | undefined, originalError = '', authenticated = false
  let nextDrafts: string[] | undefined, nextSchemas: string[] | undefined, nextErrors: unknown
  f.options.runner = async request => {
    const operation = f.store.readOperation(active.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    if (operation.id === f.operation.id && attempt.number === 1) {
      firstRequest = request
      let parsed: unknown
      try { parsed = JSON.parse(rejectedText) as unknown }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; originalError = `output_json: ${error.message}` }
      if (!originalError) { const errors = outputErrors(parsed, request.schema); assert.ok(errors.length); originalError = `output_schema: ${errors.join('; ')}` }
      return rejectedReviewFixture(f, request, rejectedText, originalError)
    }
    const prior = f.store.readAttempt(claimed.attempt.id), resource = f.store.findResource(prior.id, firstRequest!.requestKey)!
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    const failure = checkpoint.failure!, packet = failure.rejectedOutput!
    const native = JSON.parse(readEvidence(f.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
    assert.equal(resource.phase, 'removed'); assert.equal(native.request.worktree?.mode, 'read')
    assert.equal(packet.sha256, contentHash(rejectedText)); assert.deepEqual(native.request.schema, firstRequest!.schema)
    const state = authenticateNativeRejectedFinal(f.store, f.store.readOperation(f.operation.id), prior, firstRequest!.requestKey, { ...failure, sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, packet)
    assert.equal(packet.text, rejectedText); assert.equal(failure.message, originalError); assert.equal(state.cancellation?.nativeStopped, true)
    authenticated = true
    const entries = readTree(f.input.source.commonDir, request.worktree!.tree).filter(entry => entry.path.startsWith('.spex-sync-drafts/'))
    const draftPath = /草稿文件=([^\s；]+)/.exec(request.prompt)![1]
    nextDrafts = entries.filter(entry => entry.path === draftPath).map(entry => readObject(f.input.source.commonDir, entry.oid).toString('utf8'))
    nextSchemas = entries.filter(entry => entry.path === draftPath.replace(/\.json$/, '.schema.json')).map(entry => readObject(f.input.source.commonDir, entry.oid).toString('utf8'))
    nextErrors = readCodeBehaviorContext(request, f.input.source.commonDir).errors
    t.diagnostic(JSON.stringify({ invalidity, originalNativeAuthenticated: true, nativePlanRefSha256: resource.plan.planBlob.sha256, checkpointRefSha256: resource.checkpointRef.sha256, originalSchemaSha256: contentHash(JSON.stringify(native.request.schema)), originalFinalSha256: packet.sha256, originalFinalBytes: Buffer.byteLength(rejectedText), originalErrorCode: failure.code, originalError, nextDraftCount: nextDrafts.length, nextSchemaCount: nextSchemas.length }))
    throw Object.assign(new Error('仅核下一真实seed的失败材料，在后续模型修改前停止'), { code: 'unsupported' })
  }
  await runSyncOperation(f.store, active.id, f.options)
  if (formalRetry) {
    active = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'authenticated-native-retry', rootCauseId: 'authenticated-native-retry', retryOf: active.id, model: 'claude:default', origin: active.origin, budget: active.budget, managedRoot: f.managedRoot }))
    f.useOperation(active)
    await runSyncOperation(f.store, active.id, f.options)
  }
  if (process.env.SPEX_RETRY_DRAFT_EVIDENCE_DIR && firstRequest) {
    const evidenceDirectory = join(process.env.SPEX_RETRY_DRAFT_EVIDENCE_DIR, contentHash(t.name).slice(0, 16))
    mkdirSync(evidenceDirectory, { recursive: true })
    writeFileSync(join(evidenceDirectory, 'rejected-final.txt'), rejectedText)
    writeFileSync(join(evidenceDirectory, 'exact-business-schema.json'), JSON.stringify(firstRequest.schema))
    writeFileSync(join(evidenceDirectory, 'formal-records.json'), JSON.stringify({ controlledNative: true, case: t.name, sourceOperation: f.store.readOperation(f.operation.id), sourceAttempt: f.store.readAttempt(claimed.attempt.id), resource: f.store.findResource(claimed.attempt.id, firstRequest.requestKey), originalError, nextDrafts, nextSchemas, nextErrors }, null, 2))
    cpSync(join(f.input.source.commonDir, 'spexcode/evidence'), join(evidenceDirectory, 'cas'), { recursive: true })
    f.git('bundle', 'create', join(evidenceDirectory, 'git-evidence.bundle'), '--all')
  }
  assert.equal(authenticated, true, '必须先取得真实已停止Native失败原件的认证证据')
  assert.deepEqual(nextDrafts, [rejectedText], '已认证Native原final没有按exact bytes进入下一attempt临时输入；此断言不依赖read/edit模式')
  assert.deepEqual(nextSchemas, [JSON.stringify(firstRequest!.schema)], '下一临时输入必须绑定原精确业务schema')
  assert.deepEqual(nextErrors, [{ code: 'structured_output_format_invalid', message: originalError }], '下一请求必须携原具体错误，不能只带概括消息')
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const legacy of [false, true]) test(`Native completed评审位置字段续改保同candidate/兄弟accept并回原P1：${legacy ? '旧成功原件' : '新早验拒绝'}`, async t => {
  const importPath = '.spec/project/import/import-contract/spec.md', importSpec = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs')
  const definitions = [original, importSpec].map((source, index) => {
    const item = parseContract({ nodeId: index ? 'import-contract' : 'export-contract', path: index ? importPath : contractPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!
    assert.equal(item.kind, 'VERIFY')
    return { definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment: { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } }
  })
  const f = await fixture(t, { maxAttempts: 4, maxCalls: 24, maxRepairs: 3, timeoutMs: 120_000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: importPath }],
    verifications: definitions, facts: [{ source: 'decision:EXPORT-POLICY', text: original }, { source: 'decision:IMPORT-POLICY', text: importSpec }],
    mandatoryTests: definitions.map((item, index) => ({ verificationId: item.definition.id, testPath: index ? 'tests/import.test.mjs' : 'tests/export.test.mjs', testId: index ? 'AC-IMPORT-03' : 'AC-EXPORT-03' })),
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js', 'src/import/import.js'] },
  }, undefined, 'code', 'claude:default', true, { [importPath]: importSpec, 'src/import/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('export.js', 'import.js') })
  const calls: { attempt: number; purpose: string; key: string }[] = [], records = new Map<string, NativeRunRecord>()
  const originalObjects = readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  let bad: import('./generation-types.js').GenerationReview | undefined, badKey = '', enteredP1 = false
  const recordFailure = f.store.recordFailure.bind(f.store)
  f.store.recordFailure = (fence, issue) => {
    if (legacy && f.store.readAttempt(fence.attemptId).number === 1) {
      const wrappers = f.store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const local = wrappers.find(wrapper => wrapper.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()).failure?.code === 'review_location_format')
      assert.ok(local, JSON.stringify({ issue, calls, stages: wrappers.map(wrapper => ({ stage: wrapper.stage, failure: wrapper.resultRef && JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()).failure })) }))
      for (const wrapper of [local, wrappers.find(wrapper => wrapper.stage === 'generation')]) {
        const result = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as import('./generation-types.js').GenerationResult
        result.status = 'repair'; result.failure = null; result.review = bad!
        if (wrapper.stage === 'generation') result.partitionEvidence!.push({ partitionId: local.stage.slice('partition:'.length, -':candidate-review'.length), candidateDigest: result.candidate!.digest, review: bad!, traces: JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()).traces })
        const resultRef = writeEvidence(f.input.source.commonDir, result)
        f.store.checkpoint(fence, { ...writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }), artifacts: syncCheckpointArtifacts(result, resultRef) })
      }
    }
    const result = recordFailure(fence, issue)
    records.clear() // 续轮只能从原CAS/Native检查点冷验，不依赖进程内原会话。
    return result
  }
  f.options.runner = async request => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!), seed = request.worktree!
    calls.push({ attempt: attempt.number, purpose: request.purpose, key: request.requestKey })
    assert.notEqual(request.purpose, 'code_generate', '代码到Spec方向不能借格式修复改源码或测试')
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths?: string[]; targets?: { nodeId: string }[]; readonlySpecRepair?: unknown } : null
    const domain = task?.requiredChangedPaths?.some(path => path.includes('import')) || task?.targets?.some(target => target.nodeId === 'import-contract') ? 'IMPORT' : 'EXPORT'
    let output: unknown
    if (request.purpose === 'code_review') {
      const identity = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0]) as { inputId: string; candidateDigest: string; requiredIds: string[] }
      output = { inputId: identity.inputId, candidateDigest: identity.candidateDigest, verdict: 'accept', checkedIds: identity.requiredIds, findings: [] }
      if (attempt.number === 1 && identity.requiredIds.includes('AC-EXPORT-03')) {
        badKey = request.requestKey
        bad = { ...output as import('./generation-types.js').GenerationReview, verdict: 'repair', findings: [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03（同一冲突亦见同文件）`, codeLocation: 'src/export.js#ExportService', evidence: '原独审证据必须完整保留', counterexample: '原边界反例', message: '沿原raw及源码复核，不增加授权' }] }
        output = bad
      }
      if (attempt.number === 2 || attempt.number === 3) {
        assert.ok(bad); assert.equal(request.requestKey.split(':final:')[1], badKey.split(':final:')[1], '仅重派原失败review组')
        assert.equal(identity.candidateDigest, bad.candidateDigest); assert.equal(seed.mode, 'edit')
        const path = /草稿文件=([^；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `review-repair-${calls.length}`)
        f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
        assert.equal(readFileSync(join(workspace, path), 'utf8'), JSON.stringify(bad))
        assert.match(readFileSync(join(workspace, path.replace(/\.json$/, '.errors.json')), 'utf8'), /ruleLocation/)
        output = structuredClone(bad); if (attempt.number === 3) (output as typeof bad).findings[0].ruleLocation = `${contractPath}#AC-EXPORT-03`
        writeFileSync(join(workspace, path), JSON.stringify(output)); execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'continue authenticated review'], { stdio: 'pipe' })
        const actual = nativeWorktreeResult(workspace, seed)
        const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
        return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: { readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('fixture不得控制真实进程') }, run: async native => {
          const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `review-${sessionId}`, turnId: 'turn' }, resultDigest = contentHash(JSON.stringify(output))
          const execution = structuredExecutionPolicy(native)
          records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: native.worktree ? nativeWorktreePrompt(native.prompt, native.worktree) : native.prompt, parent: null, launcher: null, ...(native.base?.trim() ? { base: native.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output, resultDigest, resultWorktree: actual } })
          return { sessionId, ...identity, output, resultDigest, worktree: actual }
        } } })(request)
      }
      const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
      return createAttemptRunner(f.store, fence, { pollMs: 2, runtime: { readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('fixture不得控制真实进程') }, run: async native => {
        const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `review-${sessionId}`, turnId: 'turn' }, resultDigest = contentHash(JSON.stringify(output)), execution = structuredExecutionPolicy(native)
        const actual = { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: seed.baseCommit, tree: seed.tree, worktreePath: join(f.parent, 'closed-read') }
        records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: native.worktree ? nativeWorktreePrompt(native.prompt, native.worktree) : native.prompt, parent: null, launcher: null, ...(native.base?.trim() ? { base: native.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output, resultDigest, resultWorktree: actual } })
        return { sessionId, ...identity, output, resultDigest, worktree: actual }
      } } })(request)
    }
    if (attempt.number >= 4 && bad && request.purpose === 'elaboration_generate') {
      enteredP1 = true; assert.equal(domain, 'EXPORT'); assert.ok(task!.readonlySpecRepair)
      throw Object.assign(new Error('真实review稿已严格核验并回原P1，受控测试在此停止'), { code: 'unsupported' })
    }
    if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'implementation_plan') output = { version: 'sync-implementation-plan-v1', paths: [] }
    else if (request.purpose === 'code_behavior_analyze') output = { changes: task!.requiredChangedPaths!.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${domain}-05`], ruleIds: [`RULE-${domain}-05`], originalIntent: '保原业务', previousBehavior: '原业务', sourceBehavior: '原业务', deliveryBehavior: '原业务', evidence: path, counterexample: '不得改变权限' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map(change => change.id), findings: [] }
    } else {
      const generated = rows(domain === 'IMPORT' ? importSpec : original, domain === 'IMPORT' ? importPath : contractPath)
      generated.changes[0].nodeId = domain === 'IMPORT' ? 'import-contract' : 'export-contract'
      for (const applicability of generated.applicability) applicability.affectedIds = [`REQ-${domain}-01`]
      output = adaptElaborationNativeOutput(request, generated)
    }
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
    let worktree
    if (seed.mode === 'edit') {
      const path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `stage-${calls.length}`)
      f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
      mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), JSON.stringify(output)); execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'native stage draft'], { stdio: 'pipe' })
      output = { summary: '正常提交原生草稿' }; worktree = nativeWorktreeResult(workspace, seed)
    }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `native-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), ...(worktree ? { worktree } : {}) }
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(enteredP1, true, JSON.stringify({ failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => ({ number: attempt.number, failure: attempt.failure })), calls }))
  assert.equal(calls.filter(call => call.attempt === 2).length, 1, '只续失败独审，兄弟accept及P0/P1均不重跑')
  assert.equal(calls.filter(call => call.attempt === 3).length, 1, '连续两次格式续稿仍只派原失败组，原accepted兄弟保持')
  assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), originalObjects)
  const attempts = f.store.listAttempts(f.operation.id), stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const accepted = stages[0].filter(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
  assert.ok(accepted.length)
  for (const value of accepted) for (const current of stages.slice(1, 3)) assert.deepEqual(current.find(stage => stage.stage === value.stage)?.resultRef, value.resultRef, '原accept原件和trace跨两次续稿复用，不补签')
  const local = stages[0].find(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewOutput?.findings.length)
  const saved = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()) as import('./generation-types.js').GenerationResult
  const sourceInput = restoreGenerationInput(JSON.parse(readEvidence(f.input.source.commonDir, stages[0].find(stage => stage.stage === `${local.stage}:input`).resultRef).toString()))
  const candidatePlan = JSON.parse(readEvidence(f.input.source.commonDir, stages[0].find(stage => stage.stage === 'candidate-partition-plan').resultRef).toString())
  const proof = () => continuationCoordinator.failedCandidateReviewSource(f.store, f.store.readOperation(f.operation.id), attempts[0], local.stage, saved.candidate!, candidatePlan, sourceInput)
  assert.ok(proof(), '清空进程内会话后，完整原Native成功CAS及正式派发足以冷验材料')
  const find = f.store.findResource.bind(f.store), requestKey = sourceInput.requestKey + ':code_review', resource = find(attempts[0].id, requestKey)!
  const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  for (const patch of [null, { ...resource, checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, nativeState: 'failed' }) }, { ...resource, checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, result: { ...checkpoint.result!, threadId: 'forged-thread' } }) }]) {
    f.store.findResource = (attemptId, key) => attemptId === attempts[0].id && key === requestKey ? patch : find(attemptId, key)
    assert.equal(proof(), null, '缺原件、非completed或伪身份不能取得临时稿资格')
  }
  f.store.findResource = find
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

// 受控Native与V3接缝只证明重验编排；不调用外部模型、Docker或真实业务场景。
test('未采纳settled重验重新派发P0/P1并续原Git稿，坏candidate不成为业务基线', { timeout: 240000 }, async t => {
  const items = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items
  const executionScope = { paths: [contractPath], contractIds: items.filter(item => item.kind !== 'FLOW' && item.kind !== 'VERIFY').map(item => item.id).sort(), flowIds: items.filter(item => item.kind === 'FLOW').map(item => item.id).sort() }
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 24, maxRepairs: 1, timeoutMs: 240000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'], executionScope, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code', 'claude:default', true, {}, true)
  await f.realTools()
  let active = f.operation, retry = false, rejectFirstReview = false, containerExists = false, containerState = 'created'
  const calls: string[] = [], drafts = new Map<string, string>()
  const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', truncated: false })
  f.options.verificationDriver = async argv => {
    if (argv[0] === 'version') return ok(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.4.3' }))
    if (argv[0] === 'image') return ok(JSON.stringify([{ Id: 'sha256:image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]))
    const resource = f.store.listRecoverableResources().find(item => item.operation.id === active.id && item.resource.plan.kind === 'verification')!.resource
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint, config = checkpoint.config
    if (argv[1] === 'inspect') return containerExists ? ok(JSON.stringify([{ Id: 'a'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: config.policy.cwd === '.' ? '/candidate' : `/candidate/${config.policy.cwd}`, Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: config.policy.memoryBytes, MemorySwap: config.policy.memoryBytes, NanoCpus: config.policy.cpus * 1e9, PidsLimit: config.policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(config.policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: containerState, Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }])) : { ...ok(), exitCode: 1, stderr: 'Error: No such container' }
    if (argv[1] === 'create') { containerExists = true; containerState = 'created'; return ok('a'.repeat(64)) }
    if (argv[1] === 'start') { containerState = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'logs') return ok([...config.policy.expectedTestIds.map(id => JSON.stringify({ type: 'test:pass', data: { name: `${id} simulated`, nesting: 0 } })), JSON.stringify({ type: 'test:summary', data: { counts: { tests: config.policy.expectedTestIds.length }, success: true } })].join('\n'))
    if (argv[1] === 'rm') { containerExists = false; return ok('a'.repeat(64)) }
    assert.fail(`unexpected isolated verification command ${argv}`)
  }
  f.options.runner = async request => {
    calls.push(`${retry ? 'new' : 'old'}:${request.purpose}`)
    const attempt = f.store.readAttempt(f.store.readOperation(active.id).currentAttemptId!), dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
    const identity = { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `revalidation-${request.requestKey}`, turnId: 'turn' }
    if (request.purpose === 'elaboration_review') {
      if (retry && rejectFirstReview) { rejectFirstReview = false; throw Object.assign(new Error('隔离重验在新P1独审入口模拟能力失败'), { code: 'unsupported' }) }
      const output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { ...identity, output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    if (request.purpose === 'code_review') {
      const candidate = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0]) as { inputId: string; candidateDigest: string; requiredIds: string[] }
      const output = { inputId: candidate.inputId, candidateDigest: candidate.candidateDigest, verdict: 'accept', checkedIds: candidate.requiredIds, findings: [] }
      return { ...identity, output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    assert.ok(['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate'].includes(request.purpose), request.purpose)
    const seed = request.worktree!, path = /草稿文件=([^\s；]+)/.exec(request.prompt)![1], workspace = join(f.parent, `revalidation-${calls.length}`)
    f.git('worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (retry && request.purpose !== 'code_behavior_review') assert.equal(readFileSync(join(workspace, path), 'utf8'), drafts.get(request.purpose), '新分析/P1必须继续原JSON而非丢稿')
    const task = nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths: string[] }
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      if (retry) assert.ok(!request.prompt.includes('先前未采纳候选'), '坏candidate不能成为P0事实或业务基线')
      output = { changes: task.requiredChangedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保原导出行为', previousBehavior: '原语义', sourceBehavior: '原语义', deliveryBehavior: '原语义', evidence: path, counterexample: '不新增业务' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const reviewed = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: task.requiredChangedPaths, checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    } else {
      const generated = rows(original)
      generated.changes[0].description = retry ? '本次重新审查的候选' : '先前未采纳候选'
      generated.changes[0].related = retry ? [] : ['tests/export.test.mjs']
      output = adaptElaborationNativeOutput(request, generated)
    }
    const text = JSON.stringify(output)
    if (request.purpose !== 'code_behavior_review') drafts.set(request.purpose, text)
    mkdirSync(join(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text)
    execFileSync('git', ['-C', workspace, 'add', path], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '--allow-empty', '-m', 'isolated revalidation draft'], { stdio: 'pipe' })
    const receipt = { summary: '正常提交隔离重验草稿' }
    return { ...identity, output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  const first = await runSyncOperation(f.store, active.id, f.options)
  assert.equal(first.operation.phase, 'workspace_synced', JSON.stringify({ failure: first.failure, calls, failures: f.store.listAttempts(active.id).map(attempt => attempt.failure) }))
  const parent = f.store.readOperation(active.id), oldHistory = JSON.stringify({ operation: parent, attempts: f.store.listAttempts(active.id), journals: f.store.listJournals(active.id) })
  assert.deepEqual(f.store.readRetryEligibility(parent.id), { eligible: true })
  const selection = f.store.readRevalidationSelection(parent.id), business = f.store.readBusinessBaselineSelection(parent.id)!
  active = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'settled-unadopted-revalidation', rootCauseId: 'settled-unadopted-revalidation', retryOf: parent.id, model: parent.model, origin: parent.origin, budget: parent.budget, managedRoot: f.managedRoot, baselineSelection: selection, executionScope: parent.scope, impactDigest: parent.impactDigest }, business))
  active = f.store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active); retry = true; rejectFirstReview = true
  const firstRevalidation = await runSyncOperation(f.store, active.id, f.options)
  assert.equal(firstRevalidation.operation.phase, 'failed', JSON.stringify(firstRevalidation.failure))
  assert.deepEqual(calls.filter(call => call.startsWith('new:')), ['new:code_behavior_analyze', 'new:code_behavior_review', 'new:elaboration_generate', 'new:elaboration_review'], '未采纳settled的首次重验必须真实重派P0/P1')
  const failedParent = f.store.readOperation(active.id)
  const failedAttempt = f.store.readAttempt(failedParent.currentAttemptId!)
  const stages = (owner: SyncOperation, attempt: SyncAttempt) => readSyncCheckpoints(f.store, owner, attempt).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } })
  const reviewedP0 = stages(failedParent, failedAttempt).filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':analysis'))
  assert.ok(reviewedP0.length)
  active = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'ordinary-retry-after-revalidation', rootCauseId: 'ordinary-retry-after-revalidation', retryOf: failedParent.id, model: failedParent.model, origin: failedParent.origin, budget: failedParent.budget, managedRoot: f.managedRoot, baselineSelection: failedParent.baselineSelection, executionScope: failedParent.scope, impactDigest: failedParent.impactDigest }, f.store.readBusinessBaselineSelection(failedParent.id)))
  assert.deepEqual(f.store.readBusinessBaselineSelection(active.id), business, '普通failed→retry仍递归沿最早原业务selection')
  active = f.store.ackDispatch(f.input.source.repositoryId, active.dispatchMessageId); f.useOperation(active)
  const result = await runSyncOperation(f.store, active.id, f.options)
  assert.equal(result.operation.phase, 'workspace_synced', JSON.stringify({ failure: result.failure, calls, attempts: f.store.listAttempts(active.id).map(attempt => attempt.failure) }))
  assert.deepEqual(calls.filter(call => call.startsWith('new:')), ['new:code_behavior_analyze', 'new:code_behavior_review', 'new:elaboration_generate', 'new:elaboration_review', 'new:elaboration_generate', 'new:elaboration_review', 'new:code_review'])
  const resumed = stages(result.operation, f.store.readAttempt(result.operation.currentAttemptId!))
  for (const source of reviewedP0) {
    assert.deepEqual(resumed.find(stage => stage.stage === source.stage)?.resultRef, source.resultRef)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, resumed.find(stage => stage.stage === `${source.stage}:provenance`)!.resultRef).toString()), { fromOperationId: failedParent.id, fromAttemptId: failedAttempt.id, resultRef: source.resultRef }, '普通retry只承接首次重验的新P0，不能取未采纳settled祖先')
  }
  assert.equal(JSON.stringify({ operation: f.store.readOperation(parent.id), attempts: f.store.listAttempts(parent.id), journals: f.store.listJournals(parent.id) }), oldHistory)
  assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.notEqual(result.receipt!.actualTree, first.receipt!.actualTree)
})

for (const transport of ['git-json-v5', 'git-json-v6'] as const) test(`P0已审wrapper只标真实生成指导，不能把历史运输贴成新批准 ${transport}`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:default')
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
  const protocol = { version: 'code-behavior-draft-v1', contextTransport: transport }, resultRef = writeEvidence(f.input.source.commonDir, protocol)
  f.store.checkpoint(claimed.fence, { ...writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'behavior-draft-protocol', resultRef }), artifacts: syncCheckpointArtifacts(protocol, resultRef) })
  const purposes: string[] = []
  f.options.runner = async request => {
    purposes.push(request.purpose)
    if (!request.purpose.startsWith('code_behavior_')) throw Object.assign(new Error('fixture止于已审P0之后'), { code: 'unsupported' })
    const context = readCodeBehaviorContext(request, f.input.source.commonDir), paths = context.task.requiredChangedPaths as string[], pending = context.pendingAnalysis
    const output = pending
      ? { inputDigest: request.inputDigest, analysisDigest: pending.analysisDigest, verdict: 'accept', checkedPaths: paths, checkedChangeIds: pending.analysis.changes.map(change => change.id), findings: [] }
      : { changes: paths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '保原导出结果', previousBehavior: '原结果', sourceBehavior: '仅源码注释变化', deliveryBehavior: '无新增业务', evidence: path, counterexample: '重复完成仍保首次结果' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    const worktree = committedDraftFixture(f, request, output, join(f.parent, `guidance-${purposes.length}`))
    const dispatch = f.store.readAttempt(claimed.attempt.id).dispatchPlans.find(item => item.key === request.requestKey)!
    const receipt = { summary: '生成指导身份回归' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `guidance-${request.purpose}`, turnId: 'turn', output: receipt, resultDigest: contentHash(JSON.stringify(receipt)), worktree }
  }
  await runSyncOperation(f.store, f.operation.id, f.options)
  assert.deepEqual(purposes, ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate'])
  const wrapper = readSyncCheckpoints(f.store, f.store.readOperation(f.operation.id), f.store.readAttempt(claimed.attempt.id)).json.map(({ value }) => value as { stage?: string; resultRef: { sha256: string }; guidanceContractVersion?: string }).find(value => value.stage === 'analysis')!
  const analysis = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { reviewPassed: boolean; guidanceContractVersion?: string }
  assert.equal(analysis.reviewPassed, true)
  assert.equal(wrapper.guidanceContractVersion, transport === 'git-json-v6' ? 'code-behavior-guidance-v8' : 'code-behavior-guidance-v7', 'wrapper必须从原analysis取指导，不能按当前writer版本补签')
  assert.equal(analysis.guidanceContractVersion, transport === 'git-json-v6' ? 'code-behavior-guidance-v8' : undefined, '旧analysis字段缺席保持')
})

for (const frozen of ['new', 'v1', 'v2-reserved', 'v3-reserved', 'v4-reserved', 'v5-reserved', 'legacy-checkpoint', 'reserved', 'null', 'empty', 'future'] as const) test(`P0 context传输只在首次冻结选择，${frozen}保留旧字段缺席与请求绑定`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120_000 }, false, original, 'project', original, { agentWorkflow: 'native-worktree-v1' }, undefined, 'code', 'claude:default')
  const claim = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30_000, expectedMessageId: f.operation.dispatchMessageId })
  let originalProtocol: { ref: { sha256: string }; bytes: Buffer } | undefined
  const rejectsTransport = ['null', 'empty', 'future'].includes(frozen)
  const expectedTransport = frozen === 'new' ? 'git-json-v6' : frozen === 'v1' ? 'git-json-v1' : frozen === 'v2-reserved' ? 'git-json-v2' : frozen === 'v3-reserved' ? 'git-json-v3' : frozen === 'v4-reserved' ? 'git-json-v4' : frozen === 'v5-reserved' ? 'git-json-v5' : undefined
  const protocolValue = { version: 'code-behavior-draft-v1', ...(expectedTransport ? { contextTransport: expectedTransport } : rejectsTransport ? { contextTransport: frozen === 'null' ? null : frozen === 'empty' ? '' : 'git-json-future' } : {}) }
  if (frozen === 'legacy-checkpoint' || frozen === 'v1' || frozen === 'v2-reserved' || frozen === 'v3-reserved' || frozen === 'v4-reserved' || frozen === 'v5-reserved' || rejectsTransport) {
    const value = protocolValue, resultRef = writeEvidence(f.input.source.commonDir, value)
    const ref = writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: claim.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'behavior-draft-protocol', resultRef })
    f.store.checkpoint(claim.fence, { ...ref, artifacts: syncCheckpointArtifacts(value, resultRef) })
    originalProtocol = { ref, bytes: readEvidence(f.input.source.commonDir, ref) }
  }
  const reserved = frozen.endsWith('reserved') ? f.store.reserveDispatch(claim.fence, { key: `sync:${claim.attempt.id}:original-reserved`, purpose: 'code_behavior_review', requestDigest: contentHash('原完整冻结Native请求摘要') }) : null
  const reservedBytes = JSON.stringify(reserved)
  let captured = false
  f.options.runner = async request => {
    captured = true
    const task = JSON.parse(request.prompt.split('\n任务:\n')[1].split('\n草稿文件=')[0])
    assert.equal(task.contextTransport, expectedTransport)
    assert.equal(request.prompt.includes('SPEX_P0_COVERAGE'), frozen === 'new' || frozen === 'v3-reserved' || frozen === 'v4-reserved' || frozen === 'v5-reserved')
    assert.equal(request.prompt.includes('invalidAcceptanceBasis'), frozen === 'new' || frozen === 'v5-reserved')
    assert.equal(request.prompt.includes('当前作者意图：'), frozen === 'new')
    assert.equal(readCodeBehaviorContext(request, f.input.source.commonDir).task.direction, frozen === 'new' ? null : undefined)
    assert.equal(request.worktree!.mode, frozen === 'reserved' ? 'read' : 'edit')
    const contexts = readTree(f.input.source.commonDir, request.worktree!.tree).filter(entry => entry.path.endsWith('.context.json'))
    assert.equal(contexts.length, expectedTransport ? 1 : 0)
    if (!expectedTransport) assert.ok(request.prompt.includes('原具体错误：[]；本轮修复诊断：[]') || frozen === 'reserved')
    throw Object.assign(new Error('只核冻结合同，不执行任何真实业务agent'), { code: 'unsupported' })
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(captured, !rejectsTransport)
  if (rejectsTransport) { assert.equal(result.failure?.code, 'behavior_context_transport_unsupported'); assert.match(result.failure!.message, /仅字段缺席/) }
  const attempt = f.store.readAttempt(claim.attempt.id)
  const protocols = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(wrapper => wrapper.stage === 'behavior-draft-protocol')
  assert.equal(protocols.length, frozen === 'reserved' ? 0 : 1)
  if (protocols.length) assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, protocols[0].resultRef).toString()), protocolValue)
  if (rejectsTransport) assert.equal(attempt.dispatchPlans.length, 0)
  if (originalProtocol) assert.deepEqual(readEvidence(f.input.source.commonDir, originalProtocol.ref), originalProtocol.bytes)
  if (reserved) assert.equal(JSON.stringify(attempt.dispatchPlans.find(dispatch => dispatch.key === reserved.key)), reservedBytes)
})

for (const mode of ['original', 'resume', 'legacy-cleared', 'missing-cause', 'conflicting-cause'] as const) test(`V4已审owner经无failure暂停和SQLite重启，新V5两次不同事实返修继承确定值且不累计权限 mode=${mode}`, { timeout: 120000 }, async t => {
  const replay = mode !== 'original', remote = replay ? remoteVerificationFixture(t, false, true) : undefined
  const verification = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(verification.kind, 'VERIFY')
  const environment = remote && (await remote.request()).policy
  const f = await fixture(t, { mode: 'unlimited' }, false, original, 'project', original, { version: 'sync-coordinator-v2', agentWorkflow: 'native-worktree-v1', direction: 'code_to_spec', intentNodeId: 'project', sourcePaths: ['src/export.js'], writePaths: ['.spec'], targets: [{ nodeId: 'export-contract', path: contractPath }], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, ...(environment ? { verifications: [{ definition: { id: verification.id, command: verification.command, cwd: verification.cwd, timeoutMs: verification.timeoutMs }, environment }] } : {}) }, undefined, 'code', 'claude:default', true, { '.spec/project/spec.md': '---\ntitle: 导出项目\n---\n## raw source\n\n保留完整导出约定，由既有叶契约和实现承接。\n' }, true)
  if (remote) {
    const previousPath = process.env.PATH
    process.env.PATH = remote.temporary + ':' + previousPath; t.after(() => { process.env.PATH = previousPath })
    f.options.verificationTransport = remote.configuration
  }
  const commonDir = f.input.source.commonDir, protectedObjects = readTree(commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  const calls: { attempt: number; purpose: string }[] = []
  let sourceIndexWindow = false, readonlyProofSaved = false, resumedGeneration = false, sourceIndexesBeforeProof = 0, sourceIndexesAfterProof = 0
  let legacy: { ref: { sha256: string }; bytes: Buffer; attemptId: string } | undefined, finalV1 = false
  const first = f.store.claimQueuedAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedRevision: f.store.readOperation(f.operation.id).revision })
  const originalProtocol = { version: 'elaboration-draft-v1', generationGuidance: ELABORATION_GENERATION_GUIDANCE_V4 }, originalProtocolRef = writeEvidence(commonDir, originalProtocol)
  f.store.checkpoint(first.fence, { ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: first.attempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'elaboration-draft-protocol', resultRef: originalProtocolRef, readSetDigest: first.operation.readSetDigest, baselineSelectionRef: writeEvidence(commonDir, first.operation.baselineSelection) }), artifacts: syncCheckpointArtifacts(originalProtocol, originalProtocolRef) })
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const wrapper = JSON.parse(readEvidence(commonDir, ref).toString()) as { stage?: string; resultRef?: { sha256: string } }
    const attempt = f.store.readAttempt(fence.attemptId)
    if (attempt.number === 2 && wrapper.stage === 'repair-input' && wrapper.resultRef && !legacy) {
      const value = JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString()) as { readonlyOwnerRepair: Parameters<typeof continuationCoordinator.validateReadonlyRepair>[2] }
      for (const key of ['findings', 'allFindings'] as const) for (const finding of value.readonlyOwnerRepair[key]) delete finding.relatedIds
      const resultRef = writeEvidence(commonDir, value)
      legacy = { ref: resultRef, bytes: readEvidence(commonDir, resultRef), attemptId: fence.attemptId }
      const saved = checkpoint(fence, { ...writeEvidence(commonDir, { ...wrapper, resultRef }), artifacts: syncCheckpointArtifacts(value, resultRef) })
      const protocol = { version: 'elaboration-draft-v1', generationGuidance: ELABORATION_GENERATION_GUIDANCE_V4 }, protocolRef = writeEvidence(commonDir, protocol)
      checkpoint(fence, { ...writeEvidence(commonDir, { ...wrapper, stage: 'elaboration-draft-protocol', resultRef: protocolRef }), artifacts: syncCheckpointArtifacts(protocol, protocolRef) })
      f.store.requestControl(f.operation.id, 'pause')
      return saved
    }
    return checkpoint(fence, ref)
  }
  f.options.runner = async request => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), seed = request.worktree!
    calls.push({ attempt: attempt.number, purpose: request.purpose })
    if (mode === 'original' && attempt.number === 3 && request.purpose === 'elaboration_generate') { resumedGeneration = true; sourceIndexWindow = false }
    assert.notEqual(request.purpose, 'code_generate')
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') output = { changes: [], facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const { task, pendingAnalysis } = readCodeBehaviorContext(request, commonDir)
      assert.deepEqual(task.requiredChangedPaths, [])
      output = { inputDigest: request.inputDigest, analysisDigest: pendingAnalysis!.analysisDigest, verdict: 'accept', checkedPaths: [], checkedChangeIds: [], findings: [] }
    } else if (request.purpose === 'elaboration_generate') {
      const generated = rows(original)
      generated.changes = []
      if (attempt.number >= 3) {
        assert.match(request.prompt, /只允许按冻结源码核实并更新/)
        const source = readObject(commonDir, readTree(commonDir, seed.tree).find(entry => entry.path === contractPath)!.oid).toString('utf8')
        const node = rows(source).changes[0]
        node.description = '当前冻结实现已满足原契约'
        if (attempt.number === 3) {
          node.prose = parseParts(source)!.expandedSpec.split(/^### /m)[0] + '\n当前冻结结果和幂等事实已核实。'
          node.tables.RULE = node.tables.RULE.filter(row => row.id === 'RULE-EXPORT-05').map(row => ({ ...row, basis: '首轮V5已核实结果事实' }))
        } else {
          node.prose = null
          const second = node.tables.RULE.find(row => row.id === 'RULE-EXPORT-02')!
          const first = node.tables.RULE.find(row => row.id === 'RULE-EXPORT-05')!
          assert.equal(first.basis, '首轮V5已核实结果事实')
          node.tables = { ...Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables, RULE: [{ ...second, basis: '后轮V5已核实幂等事实' }, ...(attempt.number === 4 ? [{ ...first, basis: '未命中旧ID不可重新自由修改' }] : [])] }
        }
        generated.changes = [node]
      }
      output = adaptElaborationNativeOutput(request, generated)
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_review') {
      const identity = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0]) as { inputId: string; candidateDigest: string; requiredIds: string[] }
      if (attempt.number >= 5) {
        finalV1 = true
        if (!replay) throw Object.assign(new Error('V5完整P1与V1已证，Docker前停止'), { code: 'unsupported' })
        output = { inputId: identity.inputId, candidateDigest: identity.candidateDigest, verdict: 'accept', checkedIds: identity.requiredIds, findings: [] }
      }
      const id = attempt.number === 1 ? 'RULE-EXPORT-05' : 'RULE-EXPORT-02'
      if (attempt.number < 5) output = { inputId: identity.inputId, candidateDigest: identity.candidateDigest, verdict: 'repair', checkedIds: identity.requiredIds, findings: [{ kind: 'repair', affectedIds: [id], ruleLocation: `${contractPath}#${id}`, codeLocation: 'src/export.js#ExportService', evidence: '原实现已满足契约，旧依据仍称待实现', counterexample: '当前代码与旧事实说明不一致', message: '仅刷新本次命中的basis和desc/expanded，保全部业务列与源码/tests及之前批准的事实值' }] }
    } else assert.fail(request.purpose)
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
    let worktree: ReturnType<typeof nativeWorktreeResult> | undefined
    if (seed.mode === 'edit') { worktree = committedDraftFixture(f, request, output, join(f.parent, `fact-stage-${calls.length}`)); output = { summary: '正常提交唯一JSON草稿' } }
    else worktree = { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: seed.baseCommit, tree: seed.tree, worktreePath: join(f.parent, 'closed-read') }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `fact-thread-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree }
  }
  let result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'paused', JSON.stringify({ failure: result.failure, calls })); assert(legacy)
  const paused = f.store.readAttempt(legacy.attemptId)
  assert.equal(paused.status, 'superseded'); assert.equal(paused.failure, null)
  assert.equal(calls.some(call => call.attempt === 2), false)
  const originalOwnerAttempt = f.store.readAttempt(first.attempt.id)
  f.closeForRestart()
  let protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  let store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) }); f.useStore(store); f.store = store
  const claim = store.claimQueuedAttempt.bind(store)
  store.claimQueuedAttempt = input => { if (store.listAttempts(f.operation.id).length >= 5) throw new Error('禁止无派发热循环'); return claim(input) }
  store.requestControl(f.operation.id, 'run')
  if (mode === 'original') {
    const clone = globalThis.structuredClone
    globalThis.structuredClone = ((value: unknown, options?: Parameters<typeof clone>[1]): unknown => {
      const wrappers = value as { value?: { version?: string; attemptId?: string } }[]
      if (sourceIndexWindow && Array.isArray(wrappers) && wrappers.some(entry => entry?.value?.version === 'sync-stage-v1' && entry.value.attemptId === first.attempt.id)) {
        if (readonlyProofSaved) sourceIndexesAfterProof++
        else sourceIndexesBeforeProof++
      }
      return clone(value, options)
    }) as typeof structuredClone
    t.after(() => { globalThis.structuredClone = clone })
    sourceIndexWindow = true
  }
  let suspended = false
  const save = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const saved = save(fence, ref)
    const wrapper = JSON.parse(readEvidence(commonDir, ref).toString()) as { stage?: string }
    if (mode === 'original' && store.readAttempt(fence.attemptId).number === 3 && wrapper.stage?.endsWith(':readonly-repair-provenance')) readonlyProofSaved = true
    if (!suspended && store.readAttempt(fence.attemptId).number === 5 && wrapper.stage === 'elaboration') {
      suspended = true
      throw Object.assign(new Error('完整P1已保存，模拟同attempt进程边界'), { code: 'SYNC_FENCE_EXPIRED' })
    }
    return saved
  }
  result = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(result.status, 'recovery_required', JSON.stringify(result.failure)); assert.equal(suspended, true)
  if (mode === 'original') {
    t.diagnostic(JSON.stringify({ sourceIndexesBeforeProof, sourceIndexesAfterProof, readonlyProofSaved, resumedGeneration }))
    assert.equal(readonlyProofSaved, true); assert.equal(resumedGeneration, true); assert.ok(sourceIndexesBeforeProof > 0)
    assert.equal(sourceIndexesAfterProof, 0, '同一P1恢复已认证只读来源后，草稿查询不得重建同attempt的typed检查点视图')
  }
  const completedP1 = calls.filter(call => call.purpose.startsWith('elaboration_'))
  protocol.close()
  protocol = openProtocol(join(f.parent, 'sync.sqlite'))
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) }); f.useStore(store); f.store = store
  result = await runSyncOperation(store, f.operation.id, f.options)
  assert.deepEqual(calls.filter(call => call.purpose.startsWith('elaboration_')), completedP1, '完整P1同attempt冷恢复不重派或丢失固定事实')
  assert.ok(finalV1, JSON.stringify({ failure: result.failure, calls, failures: store.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  const attempts = store.listAttempts(f.operation.id), stages = attempts.map(attempt => readSyncCheckpoints(store, store.readOperation(f.operation.id), attempt).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } }).filter(item => item.stage))
  assert.equal(attempts.length, 5)
  assert.deepEqual(calls.filter(call => call.attempt === 3).map(call => call.purpose).filter(purpose => purpose.startsWith('elaboration_')), ['elaboration_generate', 'elaboration_review'])
  assert.deepEqual(readEvidence(commonDir, legacy.ref), legacy.bytes)
  assert.deepEqual(stages[1].filter(stage => stage.stage === 'repair-input').map(stage => stage.resultRef), [legacy.ref])
  const read = <T>(index: number, key: string): T => JSON.parse(readEvidence(commonDir, stages[index].find(stage => stage.stage === key)!.resultRef).toString()) as T
  assert.equal(read<{ generationGuidance: string }>(0, 'elaboration-draft-protocol').generationGuidance, ELABORATION_GENERATION_GUIDANCE_V4)
  assert.equal(read<{ generationGuidance: string }>(2, 'elaboration-draft-protocol').generationGuidance, ELABORATION_GENERATION_GUIDANCE)
  const repaired = read<{ readonlyOwnerRepair: Parameters<typeof continuationCoordinator.validateReadonlyRepair>[2] }>(2, 'repair-input').readonlyOwnerRepair
  for (const owner of repaired.owners) {
    assert.equal(owner.fromAttemptId, originalOwnerAttempt.id)
    assert.equal(owner.resultRef.sha256, contentHash(JSON.stringify(read(0, owner.key))), '共享视图仍选原已审owner的精确resultRef')
  }
  assert.deepEqual(store.readAttempt(first.attempt.id), originalOwnerAttempt)
  assert.deepEqual(repaired.findings[0].relatedIds, ['RULE-EXPORT-05'])
  assert.deepEqual(read<{ readonlyOwnerRepair: typeof repaired }>(3, 'repair-input').readonlyOwnerRepair.findings[0].relatedIds, ['RULE-EXPORT-02'])
  assert.deepEqual(calls.filter(call => call.attempt === 4).map(call => call.purpose), ['elaboration_generate'], '未命中05再次改值在独审前机械拒绝')
  const refused = read<ElaborationResult>(3, 'elaboration')
  assert.ok(refused.rounds.flatMap(round => round.findings).some(finding => finding.code === 'rows_patch'))
  continuationCoordinator.validateReadonlyRepair(store, store.readOperation(f.operation.id), repaired)
  const old = structuredClone(repaired)
  for (const key of ['findings', 'allFindings'] as const) for (const finding of old[key]) delete finding.relatedIds
  const oldBytes = JSON.stringify(old); continuationCoordinator.validateReadonlyRepair(store, store.readOperation(f.operation.id), old)
  assert.equal(JSON.stringify(old), oldBytes)
  assert.equal(read<ElaborationResult>(2, 'elaboration').partitionSeal!.passed, true)
  const whole = read<ElaborationResult>(4, 'elaboration')
  assert.equal(whole.partitionSeal!.passed, true); assert.equal(whole.reviewPassed, true)
  assert.equal(whole.changes[0].beforeDigest, readTree(commonDir, f.input.immutableTree).find(entry => entry.path === contractPath)!.digest, 'aggregate恢复原作者beforeDigest，而非继承事实的local sourceDigest')
  const updated = parseContract(whole.changes[0]).contract!, before = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!
  assert.equal(parseFrontmatter(whole.changes[0].source).fm.desc, '当前冻结实现已满足原契约')
  assert.equal((updated.items.find(item => item.id === 'RULE-EXPORT-05') as { basis: string }).basis, '首轮V5已核实结果事实')
  assert.equal((updated.items.find(item => item.id === 'RULE-EXPORT-02') as { basis: string }).basis, '后轮V5已核实幂等事实')
  assert.equal(updated.rawSource, before.rawSource); assert.equal(updated.items.length, before.items.length)
  for (const item of before.items) {
    const next = updated.items.find(next => next.id === item.id)!
    assert.deepEqual({ ...next, line: undefined, ...(item.kind === 'RULE' && ['RULE-EXPORT-02', 'RULE-EXPORT-05'].includes(item.id) ? { basis: item.basis } : {}) }, { ...item, line: undefined }, item.id)
  }
  const final = read<{ candidateValidated: boolean; candidate: { tree: string } }>(4, 'generation')
  assert.equal(final.candidateValidated, true)
  assert.deepEqual(readTree(commonDir, final.candidate.tree).filter(entry => !entry.path.startsWith('.spec/')), protectedObjects)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(store.listJournals(f.operation.id).length, 0)
  if (!replay) return
  assert.equal(result.status, 'recovery_required', JSON.stringify(result.failure))
  const approvedAttempt = store.readAttempt(result.operation.currentAttemptId!), immutableRefs = [...approvedAttempt.checkpointRefs]
  const callsBefore = [...calls], candidateBefore = approvedAttempt.candidate!, originalFailure = store.listResources(approvedAttempt.id).find(resource => resource.plan.kind === 'verification')!
  const observed = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(observed.status, 'recovery_required'); assert.deepEqual(calls, callsBefore, '同attempt清pending不重派已完成P1或独审')
  const wrappers = () => readSyncCheckpoints(store, store.readOperation(f.operation.id), store.readAttempt(approvedAttempt.id)).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } }).filter(item => item.stage)
  const latestRepair = wrappers().find(wrapper => wrapper.stage === 'repair-input')!, savedRepair = JSON.parse(readEvidence(commonDir, latestRepair.resultRef).toString())
  if (mode !== 'resume') {
    const initialRepair = wrappers().filter(wrapper => wrapper.stage === 'repair-input').map(wrapper => JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString())).find(value => value.readonlyOwnerRepair)!
    const value = mode === 'conflicting-cause' ? { ...initialRepair, readonlyBaseRef: writeEvidence(commonDir, { unapproved: 'foreign readonly base' }) } : { repairContext: savedRepair.repairContext }
    const checkpointRef = writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: f.operation.id, attemptId: approvedAttempt.id, inputId: f.input.id, policyDigest: f.operation.policyDigest, stage: 'repair-input', resultRef: writeEvidence(commonDir, value), readSetDigest: store.readOperation(f.operation.id).readSetDigest, baselineSelectionRef: writeEvidence(commonDir, store.readBusinessBaselineSelection(f.operation.id)) })
    store.checkpoint({ operationId: f.operation.id, attemptId: approvedAttempt.id, generation: approvedAttempt.generation, leaseToken: approvedAttempt.leaseToken, sourceFingerprint: f.input.source.physicalFingerprint }, { ...checkpointRef, artifacts: syncCheckpointArtifacts(value, writeEvidence(commonDir, value)) })
    if (mode === 'missing-cause') {
      // 仅在隔离fixture剥去因果wrapper引用，CAS原字节不变，核缺证不得回选旧正文。
      const current = store.readAttempt(approvedAttempt.id), checkpointRefs = current.checkpointRefs.filter(ref => {
        const wrapper = JSON.parse(readEvidence(commonDir, ref).toString())
        return wrapper.stage !== 'repair-input' || !JSON.parse(readEvidence(commonDir, wrapper.resultRef).toString()).readonlyOwnerRepair
      })
      protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify({ ...current, checkpointRefs }), current.id))
    }
  }
  store.requestControl(f.operation.id, 'pause')
  assert.equal((await runSyncOperation(store, f.operation.id, f.options)).status, 'paused')
  assert.equal(store.readResource(originalFailure.id).phase, 'removed', '正式pause沿原恢复协议结算既有资源')
  store.requestControl(f.operation.id, 'run')
  result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'missing-cause' || mode === 'conflicting-cause') {
    assert.equal(result.failure?.code, 'readonly_spec_repair_binding', JSON.stringify({ status: result.status, failure: result.failure }))
    assert.deepEqual(calls, callsBefore, '缺失或冲突因果在任何新模型前拒绝')
    return
  }
  assert.equal(result.status, 'recovery_required', JSON.stringify(result.failure))
  const resumed = store.readAttempt(result.operation.currentAttemptId!)
  assert.equal(resumed.number, 6); assert.notEqual(resumed.leaseToken, approvedAttempt.leaseToken)
  assert.deepEqual(resumed.candidate, candidateBefore, '新fence仍取最新两轮事实修正后的完整同一候选')
  assert.deepEqual(calls, callsBefore, '普通pause/run不重派P0/P1或任何已accept final review')
  const resumedStages = readSyncCheckpoints(store, result.operation, resumed).json.map(item => item.value as { stage?: string; resultRef: { sha256: string } }).filter(item => item.stage)
  const resumedWhole = JSON.parse(readEvidence(commonDir, resumedStages.find(stage => stage.stage === 'elaboration')!.resultRef).toString()) as ElaborationResult
  assert.deepEqual(resumedWhole.changes, whole.changes, '最新已审desc、expanded与两条basis保持，不能回选旧已审whole')
  const reviews = wrappers().filter(stage => stage.stage?.endsWith(':candidate-review'))
  assert.equal(reviews.length, 1)
  for (const review of reviews) {
    assert.deepEqual(resumedStages.find(stage => stage.stage === review.stage)?.resultRef, review.resultRef)
    const provenance = JSON.parse(readEvidence(commonDir, resumedStages.find(stage => stage.stage === `${review.stage}:provenance`)!.resultRef).toString())
    assert.equal(provenance.fromAttemptId, approvedAttempt.id); assert.deepEqual(provenance.resultRef, review.resultRef); assert.ok(provenance.inputRef)
    const originalInput = JSON.parse(readEvidence(commonDir, wrappers().find(stage => stage.stage === `${review.stage}:input`)!.resultRef).toString()), carriedInput = JSON.parse(readEvidence(commonDir, provenance.inputRef).toString())
    assert.ok(originalInput.repairContext); assert.deepEqual(carriedInput.repairContext, originalInput.repairContext, '原诊断上下文逐值保留在已认证独审input provenance')
  }
  const ownerKey = resumedWhole.partitionEvidence!.find(owner => JSON.parse(readEvidence(commonDir, owner.resultRef).toString()).changes.some((change: { path: string }) => change.path === contractPath))!.partitionId
  const owner = JSON.parse(readEvidence(commonDir, resumedStages.find(stage => stage.stage === `partition:${ownerKey}:elaboration:provenance`)!.resultRef).toString())
  assert.equal(owner.fromAttemptId, approvedAttempt.id, 'owner provenance必须指向最新事实返修Native所在attempt')
  for (const ref of immutableRefs) assert.ok(store.readAttempt(approvedAttempt.id).checkpointRefs.some(current => current.sha256 === ref.sha256))
  assert.deepEqual(readTree(commonDir, resumed.candidate!.tree).filter(entry => !entry.path.startsWith('.spec/')), protectedObjects)
})
for (const boundary of ['failed', 'superseded-zero-call'] as const) test(`P2混合普通修复、契约遗漏与格式失败经SQLite冷续只补原评审再回精确owner ${boundary}`, { timeout: 180000 }, async t => {
  const protocolAttempt = boundary === 'failed' ? 2 : 3, ownerAttempt = protocolAttempt + 1
  const definitions = ['export', 'import', 'archive', 'quiet'].map(word => {
    const upper = word.toUpperCase(), nodeId = `${word}-contract`, path = word === 'export' ? contractPath : `.spec/project/${word}/${nodeId}/spec.md`
    const sourcePath = word === 'export' ? 'src/export.js' : `src/${word}/${word}.js`, testPath = `tests/${word}.test.mjs`
    const source = original.replaceAll('export-job', `${word}-job`).replaceAll('EXPORT', upper).replaceAll('export-contract', nodeId).replaceAll('src/export.js', sourcePath).replaceAll('tests/export.test.mjs', testPath)
    const verification = parseContract({ nodeId, path, source }).contract!.items.find(item => item.kind === 'VERIFY')!
    assert.equal(verification.kind, 'VERIFY')
    return { word, upper, nodeId, path, sourcePath, testPath, source, verification }
  })
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const extras = Object.fromEntries(definitions.slice(1).flatMap(item => [[item.path, item.source], [item.sourcePath, readFileSync(new URL('src/export.js', fixturePath), 'utf8')], [item.testPath, readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', item.upper).replaceAll('src/export.js', item.sourcePath)]]))
  const f = await fixture(t, { maxAttempts: ownerAttempt, maxCalls: 40, maxRepairs: ownerAttempt - 1, timeoutMs: 180000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1', sourcePaths: ['src'], writePaths: ['.spec'],
    targets: definitions.map(({ nodeId, path }) => ({ nodeId, path })), facts: definitions.map(item => ({ source: `decision:${item.upper}-POLICY`, text: item.source })),
    verifications: definitions.map(({ verification: item }) => ({ definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment })),
    mandatoryTests: definitions.map(item => ({ verificationId: item.verification.id, testPath: item.testPath, testId: `AC-${item.upper}-03` })),
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 1 }, commitTrigger: { before: null, paths: definitions.map(item => item.sourcePath) },
  }, undefined, 'code', 'claude:default', true, extras)
  let store = f.store
  const calls: { attempt: number; purpose: string; group?: string; nodeId?: string; repairKind?: string }[] = [], records = new Map<string, NativeRunRecord>()
  const roles = new Map<string, { kind: 'ordinary' | 'omission' | 'format' | 'quiet'; definition: typeof definitions[number] }>()
  const rejected = '{original-mixed-review-final: only this group may resume}'
  const stages = (attempt: SyncAttempt): { stage: string; resultRef: BlobRef }[] => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const read = <T,>(ref: BlobRef): T => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as T
  const completeReview = (request: ElaborationSessionRequest, output: unknown, worktree: ElaborationSessionResult['worktree']): Promise<ElaborationSessionResult> => {
    const operation = store.readOperation(f.operation.id), attempt = store.readAttempt(operation.currentAttemptId!)
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    return createAttemptRunner(store, fence, { pollMs: 2, runtime: { readRecord: id => records.get(id) ?? null, cancel: async () => { throw new Error('fixture不得控制真实Native') }, run: async native => {
      const sessionId = sessionIdForCreateKey(native.sessionCreateKey!), identity = { threadId: `mixed-${sessionId}`, turnId: 'turn' }, resultDigest = contentHash(JSON.stringify(output)), execution = structuredExecutionPolicy(native)
      records.set(sessionId, { session: sessionId, status: 'awaiting', harnessSessionId: identity.threadId, createRequestId: contentHash(native.sessionCreateKey!), createPayloadHash: contentHash(JSON.stringify({ prompt: native.worktree ? nativeWorktreePrompt(native.prompt, native.worktree) : native.prompt, parent: null, launcher: null, ...(native.base?.trim() ? { base: native.base.trim() } : {}), structuredExecution: execution })), structuredExecution: { ...execution, ...identity, state: 'completed', output, resultDigest, ...(worktree ? { resultWorktree: worktree } : {}) } })
      return { sessionId, ...identity, output, resultDigest, ...(worktree ? { worktree } : {}) }
    } } })(request)
  }
  f.options.runner = async request => {
    const operation = store.readOperation(f.operation.id), attempt = store.readAttempt(operation.currentAttemptId!), seed = request.worktree!
    const call: typeof calls[number] = { attempt: attempt.number, purpose: request.purpose }; calls.push(call)
    assert.notEqual(request.purpose, 'code_generate', '代码→Spec保持源码/tests只读')
    let output: unknown
    if (request.purpose === 'code_review') {
      const identity = JSON.parse(request.prompt.split('候选绑定:\n')[1].split('\n')[0]) as { inputId: string; candidateDigest: string; requiredIds: string[] }
      const group = request.requestKey.split(':final:')[1]; call.group = group
      const definition = definitions.find(item => identity.requiredIds.includes(`AC-${item.upper}-03`))!
      assert.ok(definition)
      if (attempt.number === 1 && !roles.has(group)) roles.set(group, { kind: (['ordinary', 'omission', 'format', 'quiet'] as const)[roles.size], definition })
      const role = roles.get(group)!
      output = { inputId: identity.inputId, candidateDigest: identity.candidateDigest, verdict: 'accept', checkedIds: identity.requiredIds, findings: [] }
      if (attempt.number === 1 && ['ordinary', 'omission'].includes(role.kind)) output = { ...(output as object), verdict: 'repair', findings: [{ kind: 'repair', affectedIds: [`RULE-${definition.upper}-05`], ruleLocation: `${role.kind === 'omission' ? 'contract-omission:' : 'contract:'}${definition.path}#RULE-${definition.upper}-05`, codeLocation: `${definition.sourcePath}#ExportService`, evidence: '冻结原意支持的精确边界需要本owner重新核对', counterexample: '同一输入与原稳定规则未完整对应', message: '只沿原意核对，不授新业务或源码写权' }] }
      if (attempt.number === 1 && role.kind === 'format') return rejectedReviewFixture({ ...f, store }, request, rejected)
      if (attempt.number === protocolAttempt) {
        assert.equal(role.kind, 'format', '混合失败的冷续只能重派格式组，合法业务repair原件也须复用')
        assert.equal(seed.mode, 'edit')
        const path = /草稿文件=([^；]+)/.exec(request.prompt)![1]
        assert.equal(readObject(f.input.source.commonDir, readTree(f.input.source.commonDir, seed.tree).find(entry => entry.path === path)!.oid).toString(), rejected)
        const worktree = committedDraftFixture(f, request, output, join(f.parent, `mixed-review-${calls.length}`))
        return completeReview(request, output, worktree)
      }
      return completeReview(request, output, { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: seed.baseCommit, tree: seed.tree, worktreePath: join(f.parent, 'closed-review') })
    }
    const task = request.prompt.includes('任务:\n') ? nativeTask(request, f.input.source.commonDir) as { requiredChangedPaths?: string[]; targets?: { nodeId: string }[]; readonlySpecRepair?: ReadonlySpecRepair; repair?: { kind: string } } : null
    const definition = definitions.find(item => task?.requiredChangedPaths?.includes(item.sourcePath) || task?.targets?.some(target => target.nodeId === item.nodeId)) ?? definitions[0]
    call.nodeId = definition.nodeId
    if (request.purpose === 'elaboration_generate' && attempt.number > 1) {
      call.repairKind = task?.readonlySpecRepair?.kind ?? task?.repair?.kind
      const role = [...roles.values()].find(role => role.definition.nodeId === definition.nodeId)!
      assert.ok(role.kind === 'ordinary' || role.kind === 'omission', '未受影响的P1 owner不得重派')
      assert.equal(attempt.number, ownerAttempt, '协议尚未完成时不得先改业务候选')
    }
    if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_behavior_analyze') output = { changes: task!.requiredChangedPaths!.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [`RULE-${definition.upper}-05`], ruleIds: [`RULE-${definition.upper}-05`], originalIntent: '保留原业务', previousBehavior: '原导出行为', sourceBehavior: '原导出行为', deliveryBehavior: '原导出行为', evidence: path, counterexample: '不得改变权限及验收' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    else if (request.purpose === 'code_behavior_review') {
      const state = readCodeBehaviorContext(request, f.input.source.commonDir).pendingAnalysis! as { analysisDigest: string; analysis: import('./writeback-types.js').CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: state.analysisDigest, verdict: 'accept', checkedPaths: task!.requiredChangedPaths, checkedChangeIds: state.analysis.changes.map(change => change.id), findings: [] }
    } else {
      assert.equal(request.purpose, 'elaboration_generate')
      const generated = rows(definition.source, definition.path); generated.changes[0].nodeId = definition.nodeId
      for (const applicability of generated.applicability) applicability.affectedIds = [`REQ-${definition.upper}-01`]
      output = adaptElaborationNativeOutput(request, generated)
    }
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
    const worktree = seed.mode === 'edit' ? committedDraftFixture(f, request, output, join(f.parent, `mixed-stage-${calls.length}`)) : undefined
    if (worktree) output = { summary: '按原raw复核并正常提交原稿' }
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `mixed-stage-${request.requestKey}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), ...(worktree ? { worktree } : {}) }
  }
  const claim = store.claimQueuedAttempt.bind(store)
  store.claimQueuedAttempt = input => {
    if (store.listAttempts(f.operation.id).some(attempt => attempt.number === 1 && attempt.status === 'failed')) throw Object.assign(new Error('fixture真实SQLite冷恢复边界'), { code: 'unsupported' })
    return claim(input)
  }
  await runSyncOperation(store, f.operation.id, f.options)
  const first = store.listAttempts(f.operation.id)[0], originalStages = stages(first), originalBlobs = first.checkpointRefs.map(ref => ({ ref, bytes: readEvidence(f.input.source.commonDir, ref) }))
  assert.equal(roles.size, 4); assert.equal(first.status, 'failed')
  const initialGeneration = read<import('./generation-types.js').GenerationResult>(originalStages.find(stage => stage.stage === 'generation')!.resultRef)
  assert.equal(initialGeneration.review?.verdict, 'repair'); assert.equal(initialGeneration.review!.findings.some(finding => finding.ruleLocation.startsWith('contract-omission:')), false)
  if (boundary === 'superseded-zero-call') {
    // 控制前置精确模拟已观察的失租约元数据；业务/CAS/Native原件均来自上面的真实首轮。
    const interrupted = { ...first, status: 'superseded' as const, failure: null }
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET status=?,record_json=? WHERE id=?', interrupted.status, JSON.stringify(interrupted), interrupted.id))
    store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
    const operation = store.readOperation(f.operation.id)
    const empty = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: f.options.leaseMs!, expectedRevision: operation.revision, continuation: true })
    store.recordFailure(empty.fence, { code: 'fixture-control-boundary', message: '零调用控制前置', kind: 'repairable', evidenceRefs: [] })
    const idle = { ...store.readAttempt(empty.attempt.id), status: 'superseded' as const, failure: null }
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET status=?,record_json=? WHERE id=?', idle.status, JSON.stringify(idle), idle.id))
    assert.deepEqual(idle.dispatchPlans, []); assert.deepEqual(idle.checkpointRefs, [])
    store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
  }
  records.clear(); f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  store.freezeCandidate = () => { throw Object.assign(new Error('P2与原owner分流已完整通过，fixture在V3前停止'), { code: 'unsupported' }) }
  const result = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(result.failure?.message, 'P2与原owner分流已完整通过，fixture在V3前停止', JSON.stringify({ failure: result.failure, calls }))
  assert.deepEqual(calls.filter(call => call.attempt === protocolAttempt).map(call => call.purpose), ['code_review'])
  assert.deepEqual(calls.filter(call => call.attempt === ownerAttempt && call.purpose === 'elaboration_generate').map(call => call.nodeId).sort(), [...roles.values()].filter(role => role.kind === 'ordinary' || role.kind === 'omission').map(role => role.definition.nodeId).sort())
  const attempts = store.listAttempts(f.operation.id), second = stages(attempts.find(attempt => attempt.number === protocolAttempt)!), third = stages(attempts.find(attempt => attempt.number === ownerAttempt)!)
  for (const before of originalStages.filter(stage => stage.stage.endsWith(':candidate-review'))) {
    const value = read<import('./generation-types.js').GenerationResult>(before.resultRef)
    if (value.review) assert.deepEqual(second.find(stage => stage.stage === before.stage)?.resultRef, before.resultRef, 'accept与合法repair均沿完整原件承接；repair不成为accept')
  }
  for (const before of originalStages.filter(stage => stage.stage.endsWith(':elaboration'))) {
    const value = read<ElaborationResult>(before.resultRef), role = [...roles.values()].find(role => value.changes.some(change => change.nodeId === role.definition.nodeId))!
    if (role.kind === 'format' || role.kind === 'quiet') assert.deepEqual(third.find(stage => stage.stage === before.stage)?.resultRef, before.resultRef)
  }
  for (const { ref, bytes } of originalBlobs) assert.deepEqual(readEvidence(f.input.source.commonDir, ref), bytes)
  if (boundary === 'superseded-zero-call') for (const attempt of attempts.slice(0, 2)) { assert.equal(attempt.status, 'superseded'); assert.equal(attempt.failure, null) }
  const repair = read<{ readonlyOwnerRepair: Parameters<typeof continuationCoordinator.validateReadonlyRepair>[2] }>(third.find(stage => stage.stage === 'repair-input')!.resultRef).readonlyOwnerRepair
  const readAttempt = store.readAttempt.bind(store), listResources = store.listResources.bind(store)
  const settled = { ...readAttempt(repair.fromAttemptId), status: 'superseded' as const, failure: null }
  store.readAttempt = id => id === settled.id ? settled : readAttempt(id)
  const treeReads: string[] = [], originalExec = execFileSync
  t.mock.method(createRequire(import.meta.url)('node:child_process'), 'execFileSync', (...args: Parameters<typeof execFileSync>) => {
    const command = args[1] as string[]
    if (args[0] === 'git' && command.includes('ls-tree') && command.includes('-rlz')) treeReads.push(command.at(-1)!)
    return Reflect.apply(originalExec, undefined, args)
  })
  syncBuiltinESMExports()
  try {
    assert.doesNotThrow(() => continuationCoordinator.validateReadonlyRepair(store, store.readOperation(f.operation.id), repair), '完整已结算aggregate可直接认证superseded/null来源，不补失败状态')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  const frozenTree = initialGeneration.candidate!.tree
  const rereads = treeReads.filter(tree => tree === frozenTree).length
  t.diagnostic(JSON.stringify({ totalTreeReads: treeReads.length, frozenCandidateTreeReads: rereads, candidateReviewGroups: roles.size }))
  assert.equal(rereads, 1, '同一结算候选的完整Git树只核一次')
  const missing = { ...settled, checkpointRefs: settled.checkpointRefs.filter(ref => !read<{ stage?: string }>(ref).stage?.endsWith(':candidate-review')).concat(settled.checkpointRefs.filter(ref => read<{ stage?: string }>(ref).stage?.endsWith(':candidate-review')).slice(1)) }
  store.readAttempt = id => id === settled.id ? missing : readAttempt(id)
  assert.throws(() => continuationCoordinator.validateReadonlyRepair(store, store.readOperation(f.operation.id), repair), /readonly_spec_repair_binding/, '缺一个required outcome不能接回失租约业务诊断')
  store.readAttempt = id => id === settled.id ? settled : readAttempt(id)
  store.listResources = id => listResources(id).map((resource, index) => id === settled.id && index === 0 ? { ...resource, phase: 'created' } : resource)
  assert.throws(() => continuationCoordinator.validateReadonlyRepair(store, store.readOperation(f.operation.id), repair), /readonly_spec_repair_binding/, '资源尚未精确结算不能借完整aggregate接回')
  store.readAttempt = readAttempt; store.listResources = listResources
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(store.listJournals(f.operation.id), [])
})
