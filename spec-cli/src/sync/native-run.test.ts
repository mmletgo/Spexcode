import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionIdForCreateKey, readSessionCreateTermination, type SessionCreateTermination } from '../sessions.js'
import { cancelStructuredSession, runStructuredSession, StructuredSessionError, type StructuredSessionRequest, type StructuredSessionResult } from '../session-structured.js'
import type { StructuredExecution } from '../session-structured-policy.js'
import { createAttemptRunner, type AttemptRunnerOptions, type NativeRunCheckpoint, type NativeRunRecord } from './native-run.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef } from './operation-types.js'
import { SyncStore } from './store.js'

const tsxImport = createRequire(import.meta.url).resolve('tsx/esm')
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
async function fixture(existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'native-run-')), protocol = openProtocol(join(root, 'db.sqlite'))
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
  return { root, store, claimed, request, records, resource, checkpoint, blobIO, cache, runtimeBase, runner, cleanup: () => { protocol.close(); if (!existingRoot) rmSync(root, { recursive: true, force: true }) } }
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


test('creation cancellation does not release unpublished resources before the create transaction ends', async () => {
  const f = await fixture()
  let finishCreation: () => void = () => {}
  try {
    let calls = 0, cancelled = false
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++
      return new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => { cancelled = true }, { once: true })
        finishCreation = () => reject(new Error('creation transaction still lacks an exact durable stop receipt'))
      })
    } })
    const input = { ...f.request, timeoutMs: 50 }
    const pending = run(input)
    await waitUntil(() => calls === 1)
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, /absence is not stop proof/)
    assert.equal(cancelled, true)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.store.listRecoverableResources().length, 1)
    finishCreation()
    await assert.rejects(f.runner({ ...f.runtimeBase, run: async () => { calls++; throw new Error('must not redispatch cancelled creation') } })(input), /absence is not stop proof/)
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { finishCreation(); f.cleanup() }
})


test('exact unpublished creation termination settles only after cleanup and replays without another call', async () => {
  const f = await fixture()
  try {
    let calls = 0, cancelled = false
    let termination: { version: 1; sessionId: string; requestDigest: string; payloadHash: string; code: 'session_create_cancelled'; phase: 'git-worktree'; nativeStopped: true; nativeStatus: 'notStarted'; cleanupComplete: true } | null = null
    const creationReceipt = { readCreateTermination: () => termination }
    const run = f.runner({ ...f.runtimeBase, ...creationReceipt, run: async request => {
      calls++
      const record = published(request)
      await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      assert.equal(f.resource().phase, 'planned', 'resource remains held while creation cleans up')
      termination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_cancelled', phase: 'git-worktree', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
      throw new StructuredSessionError('cancelled', 'session creation cancelled after exact cleanup')
    } })
    const pending = run(f.request)
    await waitUntil(() => calls === 1)
    f.store.requestControl(f.claimed.operation.id, 'pause')
    await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancelled')
    assert.equal(cancelled, true)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.checkpoint().stop?.nativeStatus, 'notStarted')
    assert.equal(f.records.size, 0)
    await assert.rejects(f.runner({ ...f.runtimeBase, ...creationReceipt, run: async () => { calls++; throw new Error('cancelled creation cannot be recreated') } })(f.request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})


for (const creationPhase of ['target-resolution', 'git-worktree', 'cleanup-failed'] as const) test(`real Git creation abort ${creationPhase} holds capacity through cleanup and restart reads exact termination without redispatch`, { timeout: 20_000 }, async () => {
  const childMode = process.env.SPEX_NATIVE_CREATE_PROOF_MODE
  if (childMode) {
    const f = await fixture(process.cwd())
    try {
      const request = { ...f.request, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
      let calls = 0, creationError: unknown
      const runtime = { run: async (input: StructuredSessionRequest) => { calls++; try { return await runStructuredSession(input) } catch (error) { creationError = error; throw error } }, cancel: cancelStructuredSession, readRecord: (await import('../session-record.js')).readRecord, readCreateTermination: readSessionCreateTermination }
      const run = f.runner(runtime)
      const pending = run(request)
      await waitUntil(() => existsSync(process.env.SPEX_NATIVE_CREATE_PROOF_TRACE!))
      assert.equal(f.resource().phase, 'planned')
      assert.equal(f.checkpoint().nativeCallRequested, true)
      assert.equal(f.checkpoint().nativeStarted, false)
      const createKey = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey
      assert.equal(readSessionCreateTermination(createKey), null)
      const waiterController = new AbortController()
      const waiter = (await import('../sessions.js')).sessionCreateRequest({ prompt: request.prompt, base: request.base }, { requestKey: createKey, signal: waiterController.signal, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      waiterController.abort()
      const waited = await waiter
      assert.equal(waited.status, 408)
      assert.equal(readSessionCreateTermination(createKey), null, 'a cancelled lock waiter cannot prove the admitted creator ended')
      assert.equal(f.resource().phase, 'planned')
      f.store.requestControl(f.claimed.operation.id, 'pause')
      if (creationPhase === 'cleanup-failed') {
        await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancellation_pending')
        assert.equal(readSessionCreateTermination(createKey), null)
        assert.equal(f.resource().phase, 'planned')
        assert.equal(f.store.listRecoverableResources().length, 1)
        assert.ok(creationError instanceof StructuredSessionError)
        assert.equal(creationError.code, 'failed')
        assert.match(creationError.message, /cleanup left residue/)
        await assert.rejects(run(request), error => error instanceof StructuredSessionError && error.code === 'cancellation_pending')
        assert.equal(calls, 1)
        console.log(JSON.stringify({ cleanupFailure: creationError.message, resource: f.resource().phase, nativeStarted: f.checkpoint().nativeStarted, calls }))
        return
      }
      await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancelled')
      const receipt = readSessionCreateTermination(createKey)
      assert.ok(receipt)
      assert.equal(receipt.cleanupComplete, true)
      assert.equal(receipt.phase, creationPhase)
      assert.equal(receipt.nativeStatus, 'notStarted')
      assert.equal(f.resource().phase, 'removed')
      assert.equal(runtime.readRecord(receipt.sessionId), null)
      assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).match(/^worktree /gm)?.length, 1)
      assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/codex', '--format=%(refname)'], { encoding: 'utf8' }).trim(), '')
      const terminated = await (await import('../sessions.js')).sessionCreateRequest({ prompt: request.prompt, base: request.base }, { requestKey: createKey, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      assert.notEqual(terminated.status, 201)
      if (terminated.status === 201) assert.fail('terminated creation published')
      assert.equal(terminated.code, 'session_create_cancelled')
      assert.equal(terminated.status, 408)
      const changed = await (await import('../sessions.js')).sessionCreateRequest({ prompt: 'different operation', base: request.base }, { requestKey: createKey, structuredExecution: published({ ...request, requestKey: createKey }).structuredExecution })
      assert.notEqual(changed.status, 201)
      if (changed.status === 201) assert.fail('changed creation published')
      assert.equal(changed.code, 'session_create_key_reused')
      const replayScript = `import{readSessionCreateTermination,sessionCreateRequest}from${JSON.stringify(fileURLToPath(new URL('../sessions.ts', import.meta.url)))};import{readFileSync,writeFileSync}from'node:fs';const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const before=readSessionCreateTermination(input.key);const result=await sessionCreateRequest(input.body,{requestKey:input.key,structuredExecution:input.execution});writeFileSync(process.argv[3],JSON.stringify({before,result}));process.exit();`
      const replayPath = join(process.cwd(), 'replay.mts'), inputPath = join(process.cwd(), 'replay-input.json'), outputPath = join(process.cwd(), 'replay-output.json')
      writeFileSync(replayPath, replayScript)
      writeFileSync(inputPath, JSON.stringify({ key: createKey, body: { prompt: request.prompt, base: request.base }, execution: published({ ...request, requestKey: createKey }).structuredExecution }))
      const replayed = spawnSync(process.execPath, ['--import', tsxImport, replayPath, inputPath, outputPath], { encoding: 'utf8', timeout: 5000, env: process.env })
      assert.equal(replayed.status, 0, replayed.stderr)
      const replay = JSON.parse(readFileSync(outputPath, 'utf8')) as { before: unknown; result: { status: number; code: string } }
      assert.deepEqual(replay.before, receipt)
      assert.equal(replay.result.status, 408)
      assert.equal(replay.result.code, 'session_create_cancelled')
      await assert.rejects(run(request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
      assert.equal(calls, 1)
      assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
      assert.equal(readFileSync(process.env.SPEX_NATIVE_CREATE_PROOF_TRACE!, 'utf8').trim().split('\n').length, 1)
      console.log(JSON.stringify({ creationTermination: receipt, resource: f.resource().phase, nativeStarted: f.checkpoint().nativeStarted, calls, callsUsed: f.store.readOperation(f.claimed.operation.id).callsUsed, replay: replay.result.code }))
    } finally { f.cleanup() }
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'native-real-create-')), repo = join(root, 'repo'), bin = join(root, 'bin'), trace = join(root, 'git-create-trace')
  try {
    mkdirSync(join(repo, '.spec'), { recursive: true }); mkdirSync(bin)
    writeFileSync(join(repo, '.spec', 'spexcode.json'), JSON.stringify({ mainBranch: 'main', branchPrefix: 'codex/', sessions: { maxActive: 1 } }))
    writeFileSync(join(repo, 'README'), 'creation cancellation fixture\n')
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'fixture']]) execFileSync('git', ['-C', repo, ...args])
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in *" worktree remove "*) if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = cleanup-failed ]; then printf 'controlled cleanup failure\\n' >&2; exit 17; else exec ${JSON.stringify(gitPath)} "$@"; fi ;; *" rev-parse --verify --quiet "*) if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = target-resolution ]; then printf 'target\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30; else exec ${JSON.stringify(gitPath)} "$@"; fi ;; *" worktree add "*) ${JSON.stringify(gitPath)} "$@" || exit $?; printf 'created\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30 ;; *) exec ${JSON.stringify(gitPath)} "$@" ;; esac
`)
    chmodSync(join(bin, 'git'), 0o755)
    const result = spawnSync(process.execPath, ['--import', tsxImport, '--test', '--test-name-pattern', `^real Git creation abort ${creationPhase}`, fileURLToPath(import.meta.url)], { cwd: repo, encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEX_SESSION_DATABASE_PATH: join(root, 'home', 'sessions.sqlite'), PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: join(root, 'home'), SPEX_NATIVE_CREATE_PROOF_MODE: 'child', SPEX_NATIVE_CREATE_PROOF_PHASE: creationPhase, SPEX_NATIVE_CREATE_PROOF_TRACE: trace } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /creationTermination|cleanupFailure/, 'the nested real Git fixture must actually execute')
    if (process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR) {
      mkdirSync(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, `native-create-${creationPhase}.log`), `${result.stdout}\n${result.stderr}`)
    }
    console.log(result.stdout.split('\n').find(line => line.includes('"creationTermination"') || line.includes('"cleanupFailure"')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('restart with an exact creation termination settles held resource without calling runtime even while its fence is valid', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('creation observer transport lost') } }
    await assert.rejects(f.runner(runtime)(f.request), /transport lost/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'target-resolution', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => error instanceof StructuredSessionError && error.code === 'timeout')
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().creationTermination?.code, 'session_create_timeout')
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

for (const defect of ['session', 'request', 'payload', 'cleanup', 'native', 'schema'] as const) test(`creation termination ${defect} mismatch cannot settle or dispatch`, async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('observer disconnected') } }
    await assert.rejects(f.runner(runtime)(f.request), /disconnected/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_cancelled', phase: 'git-worktree', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    if (defect === 'session') receipt.sessionId = 'other-session'
    if (defect === 'request') receipt.requestDigest = textHash('other-request')
    if (defect === 'payload') receipt.payloadHash = hash('other-payload')
    if (defect === 'cleanup') Object.assign(receipt, { cleanupComplete: false })
    if (defect === 'native') Object.assign(receipt, { nativeStopped: false })
    if (defect === 'schema') receipt.version = 2 as 1
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), /termination differs/)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})
