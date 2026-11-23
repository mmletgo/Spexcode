import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { managedModel, type ManagedRoute } from '../llm-manager-route.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { rejectedFinalOutput } from '../session-structured-policy.js'
import { SyncApplication } from './application.js'
import type { SyncOperationDetail } from './application.js'
import { managedQuotaFailureRef, readManagedQuotaRetryRoute, readSyncCheckpoints, syncCheckpointArtifacts } from './checkpoint-evidence.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import type { DispatchPlan, SyncAttempt, SyncOperation, SyncResourceRecord } from './operation-types.js'
import { contentHash, writeEvidence } from './snapshot.js'
import type { SyncStore } from './store.js'
import { remoteVerificationEnvironment } from './verification-transport.js'

test('transport内联字节摘要不授CAS引用，真正BlobRef及扩展checkpoint仍保活并冷验', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-artifact-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const bytes = Buffer.from('真实命令输出\n'), inline = { bytes: bytes.length, sha256: contentHash(bytes), gzip: gzipSync(bytes).toString('base64') }
  const referenced = writeEvidence(commonDir, { approved: false }), nested = writeEvidence(commonDir, { checkpoint: true })
  const value = {
    transport: { closed: { effects: [{ receipt: { result: { stdout: inline, stderr: inline } } }] } },
    original: referenced,
    history: { ...nested, artifacts: [{ kind: 'json' as const, ref: referenced }] },
    diagnostic: { sha256: inline.sha256, description: '随对象保存的字节摘要' },
  }
  const resultRef = writeEvidence(commonDir, value), artifacts = syncCheckpointArtifacts(value, resultRef)
  assert.deepEqual(artifacts, [resultRef, referenced, nested].map(ref => ({ kind: 'json', ref })))
  const store = {} as SyncStore
  const operation = { id: 'operation', input: { id: 'input', source: { commonDir } }, policyDigest: 'policy' } as SyncOperation
  const attempt = { id: 'attempt', checkpointRefs: [{ ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: 'attempt', inputId: operation.input.id, policyDigest: operation.policyDigest, stage: 'verification', resultRef }), artifacts }] } as SyncAttempt
  assert.deepEqual(readSyncCheckpoints(store, operation, attempt).json.find(item => item.ref.sha256 === resultRef.sha256)?.value, value)
  unlinkSync(join(commonDir, 'spexcode/evidence', referenced.sha256))
  assert.throws(() => readSyncCheckpoints({} as SyncStore, operation, attempt), new RegExp(`缺失证据 ${referenced.sha256}`), '真实引用缺失不能被当成内联摘要忽略')
  writeFileSync(join(commonDir, 'spexcode/evidence', referenced.sha256), '被破坏的原件')
  assert.throws(() => readSyncCheckpoints(store, operation, attempt), new RegExp(`证据摘要不匹配 ${referenced.sha256}`), '命中JSON缓存仍须校验原CAS字节')
})

test('拒绝final仅保留原ref的raw角色并校验原文字节，不追索正文伪引用', () => {
  const text = JSON.stringify({ version: 'sync-stage-v1', ref: { sha256: 'a'.repeat(64) } })
  const packet = { ...rejectedFinalOutput(text, 'prompt', { inputDigest: 'input', schema: {}, purpose: 'elaboration_generate' }, { threadId: 'thread', turnId: 'turn' }), ref: { sha256: contentHash(text) } }
  const resultRef = { sha256: contentHash(JSON.stringify({ packet })) }
  assert.deepEqual(syncCheckpointArtifacts({ packet }, resultRef), [{ kind: 'json', ref: resultRef }, { kind: 'untrusted_final', ref: packet.ref }])
  const { ref: _ref, ...withoutRef } = packet
  assert.deepEqual(syncCheckpointArtifacts({ packet: withoutRef }, resultRef), [{ kind: 'json', ref: resultRef }])
  assert.throws(() => syncCheckpointArtifacts({ packet: { ...packet, text: text + '\n' } }, resultRef), { code: 'checkpoint_artifact_binding' })
  assert.throws(() => syncCheckpointArtifacts({ packet: { ...packet, ref: { sha256: 'b'.repeat(64) } } }, resultRef), { code: 'checkpoint_artifact_binding' })
})

test('正式readEvidence BFS跳过内联摘要，保留后续真实引用的可达性及缺失错误', async t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-evidence-bfs-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const bytes = Buffer.from('inline stdout'), inline = { bytes: bytes.length, sha256: contentHash(bytes), gzip: gzipSync(bytes).toString('base64') }
  const tail = { check: '真实JSON证据' }, tailRef = writeEvidence(commonDir, tail)
  const checkpointRef = writeEvidence(commonDir, { transport: { stdout: inline }, checkpoint: { ...tailRef, artifacts: [{ kind: 'json', ref: tailRef }] } })
  const operation = { id: 'operation', input: { source: { commonDir } } } as SyncOperation
  const app = { readOperation: async () => ({ operation, checkpointRef }) as unknown as SyncOperationDetail, store: { listAttempts: () => [] } } as unknown as SyncApplication
  assert.deepEqual(await SyncApplication.prototype.readEvidence.call(app, operation.id, tailRef), tail)
  await assert.rejects(SyncApplication.prototype.readEvidence.call(app, operation.id, { sha256: inline.sha256 }), { code: 'sync_evidence_unrelated' })
  unlinkSync(join(commonDir, 'spexcode/evidence', tailRef.sha256))
  await assert.rejects(SyncApplication.prototype.readEvidence.call(app, operation.id, tailRef), new RegExp(`缺失证据 ${tailRef.sha256}`))
})

test('内联日志保留原运输协议的字节长度和SHA校验', async () => {
  const bytes = Buffer.from('inline日志\n'), inline = { bytes: bytes.length, sha256: contentHash(bytes), gzip: gzipSync(bytes).toString('base64') }
  const encoded = { exitCode: 0, truncated: false, stdout: { ...inline }, stderr: inline }
  const { driver } = remoteVerificationEnvironment({ kind: 'ssh-docker-v1', sshAlias: 'fixture-only', privateRoot: '/fixture-only' }, { rpc: async () => encoded })
  assert.equal((await driver(['container', 'logs', 'fixture'], 1024)).stdout, bytes.toString('utf8'))
  encoded.stdout = { ...inline, sha256: 'b'.repeat(64) }
  await assert.rejects(driver(['container', 'logs', 'fixture'], 1024), /远端日志原始字节\/SHA不匹配/)
  encoded.stdout = { ...inline, bytes: bytes.length + 1 }
  await assert.rejects(driver(['container', 'logs', 'fixture'], 1024), /远端日志原始字节\/SHA不匹配/)
})


test('Manager正式额度重试只沿被采纳的唯一已结算派发游标', t => {
  const commonDir = mkdtempSync(join(tmpdir(), 'checkpoint-manager-quota-'))
  t.after(() => rmSync(commonDir, { recursive: true, force: true }))
  const preferred: ManagedRoute = { routeId: 'a'.repeat(64), vendor: 'claude', model: 'preferred', kind: 'anthropic-messages' }
  const fallback: ManagedRoute = { ...preferred, routeId: 'b'.repeat(64), model: 'fallback' }
  const operation = { id: 'operation', model: managedModel(fallback), input: { id: 'input', source: { commonDir } } } as SyncOperation
  const attempt: SyncAttempt = {
    id: 'attempt', operationId: operation.id, number: 3, generation: 3, dispatchKey: 'dispatch', sessionCreateKey: 'create',
    status: 'failed', currentSession: null, dispatchPlans: [], composedInput: null, candidate: null, verification: null,
    checkpointRefs: [], failure: { code: 'provider_quota_exhausted', message: 'quota', kind: 'unsupported', evidenceRefs: [] }, leaseToken: 'lease', expiresAtMs: 0,
  }
  const resources: SyncResourceRecord[] = []
  const store = {
    findResource: (_attemptId: string, key: string) => resources.find(resource => resource.plan.key === key),
    listResources: () => resources,
  } as unknown as SyncStore
  const add = (key: string, route: ManagedRoute, checkpointCode: 'failed' | 'provider_quota_exhausted') => {
    const sessionCreateKey = `sync-call-${key}`, expectedSessionId = sessionIdForCreateKey(sessionCreateKey)
    const model = managedModel(route)
    const request: NativeRunPlan['request'] = {
      requestKey: key, purpose: 'code_review', root: commonDir, inputDigest: 'input-digest', prompt: 'review',
      timeoutMs: null, schema: { type: 'object' }, model, worktree: { mode: 'read', baseCommit: 'commit', tree: 'tree' },
    }
    const requestDigest = contentHash(JSON.stringify(request))
    const identity = { schemaVersion: 1 as const, operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: null, requestDigest, expectedSessionId }
    const session = { sessionId: expectedSessionId, threadId: 'thread', turnId: 'turn' }
    const dispatch: DispatchPlan = { key, purpose: request.purpose, requestDigest, managedModel: model, session, sessionCreateKey }
    const checkpoint: NativeRunCheckpoint = {
      ...identity, phase: 'removed', status: 'failed', nativeState: 'failed', nativeCallRequested: true, nativeStarted: true, session,
      failure: { code: checkpointCode, message: 'quota' },
      stop: { ...session, state: 'failed', nativeStopped: true, acknowledged: true, nativeStatus: 'stopped' },
    }
    const ref = writeEvidence(commonDir, checkpoint)
    const plan = { ...identity, request, sessionCreateKey } satisfies NativeRunPlan
    resources.push({
      id: key, operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, phase: 'removed',
      plan: { key, kind: 'native_session', payloadDigest: requestDigest, inputId: operation.input.id, candidateDigest: null, planBlob: writeEvidence(commonDir, plan), checkpointRef: ref },
      checkpointRef: ref, checkpoints: [{ phase: 'removed', checkpointRef: ref }], createdAtMs: 0, updatedAtMs: 1,
    })
    attempt.dispatchPlans.push(dispatch)
    return { ref, dispatch }
  }
  assert.deepEqual(readManagedQuotaRetryRoute(store, operation, attempt), fallback, '旧准入可作历史游标')
  const unrelated = add('unrelated', fallback, 'failed')
  const actual = add('actual', preferred, 'provider_quota_exhausted')
  const next = add('other-quota', fallback, 'provider_quota_exhausted')
  assert.equal(readManagedQuotaRetryRoute(store, operation, attempt), undefined, '并发额度失败不能自行猜测采用哪个')
  assert.equal(managedQuotaFailureRef(store, operation, attempt, { code: 'provider_quota_exhausted', sessionId: unrelated.dispatch.session!.sessionId }), undefined)
  const ref = managedQuotaFailureRef(store, operation, attempt, { code: 'provider_quota_exhausted', sessionId: actual.dispatch.session!.sessionId })
  assert.deepEqual(ref, actual.ref)
  attempt.failure!.evidenceRefs = [unrelated.ref, actual.ref]
  assert.deepEqual(readManagedQuotaRetryRoute(store, operation, attempt), preferred, '采用派发实际模型')
  attempt.failure!.evidenceRefs.push(next.ref)
  assert.equal(readManagedQuotaRetryRoute(store, operation, attempt), undefined, '拒绝歧义游标')
  actual.dispatch.managedModel = operation.model
  attempt.failure!.evidenceRefs = [actual.ref]
  assert.equal(readManagedQuotaRetryRoute(store, operation, attempt), undefined, '路线必须与原生请求摘要对应')
})
