import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionIdForCreateKey } from '../sessions.js'
import type { StructuredSessionRequest, StructuredSessionResult } from '../session-structured.js'
import type { StructuredExecution } from '../session-structured-policy.js'
import { createAttemptRunner, type AttemptRunnerOptions, type NativeRunCheckpoint, type NativeRunRecord } from './native-run.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef } from './operation-types.js'
import { SyncStore } from './store.js'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() > deadline) assert.fail('observable native state did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
function published(request: StructuredSessionRequest): NativeRunRecord {
  const execution: StructuredExecution = { version: 1, policy: 'codex-read-only-v1', schema: request.schema, inputDigest: request.inputDigest, purpose: request.purpose, timeoutMs: request.timeoutMs, ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}) }
  return { session: sessionIdForCreateKey(request.requestKey), status: 'queued', harnessSessionId: null, structuredExecution: execution, createRequestId: textHash(request.requestKey), createPayloadHash: hash({ prompt: request.prompt, parent: null, launcher: null, ...(request.base?.trim() ? { base: request.base.trim() } : {}), structuredExecution: execution }) }
}
function completed(record: NativeRunRecord): StructuredSessionResult {
  const output = { answer: 'verified output' }, threadId = record.structuredExecution!.threadId ?? 'actual-thread', turnId = record.structuredExecution!.turnId ?? 'actual-turn'
  record.status = 'awaiting'; record.harnessSessionId = threadId
  record.structuredExecution = { ...record.structuredExecution!, state: 'completed', threadId, turnId, output, resultDigest: hash(output) }
  return { sessionId: record.session, threadId, turnId, output, resultDigest: hash(output) }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-run-')), protocol = openProtocol(join(root, 'db.sqlite'))
  const cache = new Map<string, Buffer>()
  const blobIO = { put: (bytes: Buffer): BlobRef => { const sha256 = createHash('sha256').update(bytes).digest('hex'); cache.set(sha256, bytes); return { sha256 } }, read: (ref: BlobRef): Buffer => { const bytes = cache.get(ref.sha256); assert.ok(bytes); return bytes } }
  const manifestBlob = blobIO.put(Buffer.from('{"version":1,"entries":[]}'))
  await migrateSyncStore(protocol)
  const store = new SyncStore(protocol, { readBlob: blobIO.read })
  const source = { repositoryId: 'repo', commonDir: join(root, '.git'), canonicalRoot: root, gitDir: join(root, '.git'), branch: 'source', physicalFingerprint: 'physical-source' }
  const operation = store.admitAndEnqueue({ ingressKey: 'request', rootCauseId: 'cause', origin: 'spec', input: { id: 'source-input', source, headCommit: 'a'.repeat(40), immutableTree: 'b'.repeat(40), indexTree: 'b'.repeat(40), indexDigest: 'c'.repeat(64), manifestBlob, contentDigest: 'd'.repeat(64), capturedAtMs: Date.now() }, scope: { paths: ['src/a.ts'], contractIds: ['RULE-A'], flowIds: [] }, budget: { maxCalls: 4, maxAttempts: 4, maxRepairs: 2, timeoutMs: 60000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: join(root, 'delivery'), branch: 'delivery', baseCommit: 'a'.repeat(40) } })
  const claimed = store.claimAttempt({ operationId: operation.id, source, scope: operation.scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
  const request = { root, base: 'a'.repeat(40), prompt: 'Return the frozen answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, requestKey: 'generation-1', inputDigest: 'elaboration-input', purpose: 'generation', timeoutMs: 5000 }
  const records = new Map<string, NativeRunRecord>()
  const resource = () => store.findResource(claimed.attempt.id, request.requestKey)!
  const checkpoint = (): NativeRunCheckpoint => JSON.parse(blobIO.read(resource().checkpointRef).toString('utf8')) as NativeRunCheckpoint
  const runtimeBase = { readRecord: (id: string) => records.get(id) ?? null, cancel: async (): Promise<never> => { throw new Error('unexpected cancellation') } }
  const runner = (runtime: AttemptRunnerOptions['runtime']) => createAttemptRunner(store, claimed.fence, { runtime, blobIO, pollMs: 2 })
  return { root, store, claimed, request, records, resource, checkpoint, blobIO, cache, runtimeBase, runner, cleanup: () => { protocol.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('native intent precedes run, published queued session is created with unknown thread, result binds exact identity and replays', async () => {
  const f = await fixture()
  try {
    let calls = 0, finish: (value: StructuredSessionResult) => void = () => {}
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++
      assert.equal(f.resource().phase, 'planned')
      assert.equal(f.checkpoint().nativeCallRequested, true)
      assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
      const record = published(request); f.records.set(record.session, record)
      return new Promise<StructuredSessionResult>(resolve => { finish = resolve })
    } })
    const pending = run(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().nativeState, 'queued')
    assert.equal(f.checkpoint().session.threadId, null)
    const id = sessionIdForCreateKey(f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey)
    assert.equal(f.checkpoint().expectedSessionId, id)
    const record = f.records.get(id)!
    record.status = 'active'; record.harnessSessionId = 'actual-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'actual-thread', turnId: 'actual-turn', turnStartRequested: true }
    await waitUntil(() => f.store.readAttempt(f.claimed.attempt.id).currentSession?.turnId === 'actual-turn')
    assert.equal(f.checkpoint().nativeStarted, true)
    const result = completed(record); finish(result)
    assert.deepEqual(await pending, result)
    assert.equal(f.resource().phase, 'removed')
    assert.deepEqual(f.checkpoint().result, result)
    f.store.requestControl(f.claimed.operation.id, 'cancel')
    assert.deepEqual(await run(f.request), result)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.ok(f.records.has(id))
    const ref = f.resource().checkpointRef
    f.cache.set(ref.sha256, Buffer.from('{"tampered":true}'))
    await assert.rejects(run(f.request), /evidence blob digest is invalid/)
    assert.equal(calls, 1)
  } finally { f.cleanup() }
})

test('same key concurrent callers share one run and call budget; changed payload is refused', async () => {
  const f = await fixture()
  try {
    let calls = 0, finish: (value: StructuredSessionResult) => void = () => {}
    const run = f.runner({ ...f.runtimeBase, run: async request => { calls++; const record = published(request); f.records.set(record.session, record); return new Promise(resolve => { finish = resolve }) } })
    const first = run(f.request), second = run(f.request)
    await waitUntil(() => calls === 1)
    await assert.rejects(run({ ...f.request, prompt: 'different bytes' }), /key was reused/)
    finish(completed([...f.records.values()][0]))
    assert.deepEqual(await first, await second)
    await assert.rejects(run({ ...f.request, prompt: 'different bytes' }), /key was reused/)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('transport failure leaves live resource; same-key recovery rejoins existing native turn without a new turn or budget', async () => {
  const f = await fixture()
  try {
    let calls = 0, nativeStarts = 0
    const runtime: NonNullable<AttemptRunnerOptions['runtime']> = { ...f.runtimeBase, run: async request => {
      calls++
      const id = sessionIdForCreateKey(request.requestKey)
      let record = f.records.get(id)
      if (!record) { nativeStarts++; record = published(request); record.status = 'active'; record.harnessSessionId = 'retained-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'retained-thread', turnId: 'retained-turn', turnStartRequested: true }; f.records.set(id, record) }
      if (calls === 1) throw new Error('transport disconnected')
      return completed(record)
    } }
    await assert.rejects(f.runner(runtime)(f.request), /transport disconnected/)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.store.listRecoverableResources().length, 1)
    const result = await f.runner(runtime)(f.request)
    assert.equal(result.threadId, 'retained-thread')
    assert.equal(result.turnId, 'retained-turn')
    assert.equal(calls, 2)
    assert.equal(nativeStarts, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().phase, 'removed')
  } finally { f.cleanup() }
})

test('incorrect native result identity, hash or published request binding is never delivered or marked removed', async () => {
  for (const defect of ['session', 'thread', 'hash', 'record_payload'] as const) {
    const f = await fixture()
    try {
      const run = f.runner({ ...f.runtimeBase, run: async request => {
        const record = published(request), result = completed(record); f.records.set(record.session, record)
        if (defect === 'record_payload') record.createPayloadHash = 'wrong-request-hash'
        return { ...result, ...(defect === 'session' ? { sessionId: 'wrong-session' } : {}), ...(defect === 'thread' ? { threadId: 'wrong-thread' } : {}), ...(defect === 'hash' ? { resultDigest: 'wrong-output-hash' } : {}) }
      } })
      await assert.rejects(run(f.request), /invalid|differs/)
      assert.notEqual(f.resource().phase, 'removed')
      assert.equal(f.store.listRecoverableResources().length, 1)
    } finally { f.cleanup() }
  }
})

test('cancel acknowledgement loss still records durable exact stop proof after fence revocation without restoring business authority', async () => {
  const f = await fixture()
  try {
    let cancellations = 0
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async request => {
      const record = published(request); record.status = 'active'; record.harnessSessionId = 'thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread', turnId: 'turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true }))
    }, cancel: async id => {
      cancellations++; assert.equal(id, f.checkpoint().expectedSessionId)
      const record = f.records.get(id)!
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' } }
      throw new Error('cancel reply lost')
    } })
    const pending = run(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    f.store.requestControl(f.claimed.operation.id, 'cancel')
    await assert.rejects(pending, /cancel reply lost/)
    assert.equal(cancellations, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().stop?.nativeStopped, true)
    assert.equal(f.checkpoint().stop?.turnId, 'turn')
    assert.equal(f.store.readAttempt(f.claimed.attempt.id).status, 'superseded')
    assert.equal(f.store.readOperation(f.claimed.operation.id).phase, 'cancelled')
    assert.throws(() => f.store.reserveDispatch(f.claimed.fence, { key: 'new-call', purpose: 'generation', requestDigest: 'new' }), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})

test('unproven native cancellation keeps resource for restart and subsequent exact stop recovery never reruns native creation', async () => {
  const f = await fixture()
  try {
    let calls = 0, stops = 0
    const runtime: NonNullable<AttemptRunnerOptions['runtime']> = { readRecord: f.runtimeBase.readRecord, run: async request => {
      calls++; const record = published(request); record.status = 'active'; record.harnessSessionId = 'thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread', turnId: 'turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('local promise finished')), { once: true }))
    }, cancel: async id => {
      stops++; const record = f.records.get(id)!
      const proved = stops > 1
      record.structuredExecution = { ...record.structuredExecution!, state: proved ? 'cancelled' : 'cancelling', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: proved, acknowledged: true, nativeStatus: proved ? 'interrupted' : 'active' } }
      return { sessionId: id, state: proved ? 'cancelled' : 'cancelling', threadId: 'thread', turnId: 'turn', nativeStopped: proved, acknowledged: true, nativeStatus: proved ? 'interrupted' : 'active' }
    } }
    const pending = f.runner(runtime)(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, /not been proven/)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.store.listRecoverableResources().length, 1)
    await assert.rejects(f.runner(runtime)(f.request), /cancelled and exact stop settled/)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(calls, 1)
    assert.equal(stops, 2)
  } finally { f.cleanup() }
})

test('superseding source aborts only the old exact session and settles its resource without giving the old attempt write authority', async () => {
  const f = await fixture()
  try {
    let cancelledId: string | undefined
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async request => {
      const record = published(request); record.status = 'active'; record.harnessSessionId = 'old-thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'old-thread', turnId: 'old-turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('old observer aborted')), { once: true }))
    }, cancel: async id => {
      cancelledId = id
      const record = f.records.get(id)!
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' } }
      return { sessionId: id, state: 'cancelled', threadId: 'old-thread', turnId: 'old-turn', nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' }
    } })
    const pending = run(f.request)
    await waitUntil(() => f.resource()?.phase === 'created')
    const old = f.store.readOperation(f.claimed.operation.id)
    const next = f.store.admitAndEnqueue({ ...old, ingressKey: 'new-source', input: { ...old.input, id: 'new-source' } })
    await assert.rejects(pending, /cancelled and exact stop settled/)
    assert.equal(cancelledId, f.checkpoint().expectedSessionId)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.store.readOperation(old.id).phase, 'superseded')
    assert.equal(f.store.readOperation(next.id).phase, 'queued')
    assert.throws(() => f.store.bindSession(f.claimed.fence, f.request.requestKey, { sessionId: cancelledId!, threadId: 'new-thread', turnId: 'new-turn' }), /SYNC_FENCE_EXPIRED/)
  } finally { f.cleanup() }
})

test('terminal result persisted before removal survives a local failure and replays without another native call', async () => {
  const f = await fixture()
  try {
    let calls = 0, failRemoval = true
    const runtime = { ...f.runtimeBase, run: async (request: StructuredSessionRequest) => { calls++; const record = published(request); f.records.set(record.session, record); return completed(record) } }
    const blobIO = { ...f.blobIO, put: (bytes: Buffer): BlobRef => {
      const value = JSON.parse(bytes.toString('utf8')) as { phase?: string }
      if (failRemoval && value.phase === 'removed') { failRemoval = false; throw new Error('local crash before removed checkpoint') }
      return f.blobIO.put(bytes)
    } }
    await assert.rejects(createAttemptRunner(f.store, f.claimed.fence, { runtime, blobIO, pollMs: 2 })(f.request), /local crash/)
    assert.equal(f.resource().phase, 'terminal')
    const result = await f.runner(runtime)(f.request)
    assert.equal(result.resultDigest, hash(result.output))
    assert.equal(f.resource().phase, 'removed')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('resource binding takes the actual durable frozen candidate instead of assuming null', async () => {
  const f = await fixture()
  try {
    const input = f.store.readOperation(f.claimed.operation.id).input
    f.store.bindComposedInput(f.claimed.fence, { sourceInputId: input.id, previousBaselinePairId: null, tree: input.immutableTree, manifestBlob: input.manifestBlob, contentDigest: input.contentDigest })
    f.store.startGeneration(f.claimed.fence)
    f.store.freezeCandidate(f.claimed.fence, { sourceInputId: input.id, baseTree: input.immutableTree, tree: 'e'.repeat(40), digest: 'actual-frozen-candidate', manifestBlob: input.manifestBlob, actualDiffBlob: f.blobIO.put(Buffer.from('[]')), coveredScope: f.claimed.operation.scope })
    const run = f.runner({ ...f.runtimeBase, run: async request => { assert.equal(f.resource().plan.candidateDigest, 'actual-frozen-candidate'); const record = published(request); f.records.set(record.session, record); return completed(record) } })
    await run(f.request)
    assert.equal(f.checkpoint().candidateDigest, 'actual-frozen-candidate')
  } finally { f.cleanup() }
})

test('already aborted request proves notDispatched without creating or cancelling a session', async () => {
  const f = await fixture()
  try {
    const controller = new AbortController(); controller.abort()
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async () => { calls++; throw new Error('unexpected dispatch') } })
    await assert.rejects(run({ ...f.request, signal: controller.signal }), /cancelled before dispatch/)
    assert.equal(calls, 0)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().stop?.nativeStatus, 'notDispatched')
  } finally { f.cleanup() }
})
