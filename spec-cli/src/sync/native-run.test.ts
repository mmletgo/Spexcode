import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionIdForCreateKey, readSessionCreateTermination, recoverSessionCreateTermination, type SessionCreateTermination } from '../sessions.js'
import { cancelStructuredSession, runStructuredSession, SettledSessionCreateTimeoutError, StructuredSessionError, type StructuredSessionRequest, type StructuredSessionResult } from '../session-structured.js'
import { structuredExecutionPolicy } from '../session-structured-policy.js'
import { freezeContext, proveFrozenReads, readFrozenManifest, readFrozenRange } from '../frozen-context.js'
import { createAttemptRunner, type AttemptRunnerOptions, type NativeRunCheckpoint, type NativeRunPlan, type NativeRunRecord } from './native-run.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef } from './operation-types.js'
import { SyncStore } from './store.js'

const tsxImport = createRequire(import.meta.url).resolve('tsx/esm')
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) { if (Date.now() > deadline) assert.fail('observable native state did not arrive'); await new Promise(resolve => setTimeout(resolve, 2)) }
}
function published(request: StructuredSessionRequest): NativeRunRecord {
  const execution = structuredExecutionPolicy(request), createKey = request.sessionCreateKey ?? request.requestKey
  return { session: sessionIdForCreateKey(createKey), status: 'queued', harnessSessionId: null, structuredExecution: execution, createRequestId: textHash(createKey), createPayloadHash: hash({ prompt: request.prompt, parent: null, launcher: null, ...(request.base?.trim() ? { base: request.base.trim() } : {}), structuredExecution: execution }) }
}
function completed(record: NativeRunRecord): StructuredSessionResult {
  const output = { answer: 'verified output' }, threadId = record.structuredExecution!.threadId ?? 'actual-thread', turnId = record.structuredExecution!.turnId ?? 'actual-turn'
  record.status = 'awaiting'; record.harnessSessionId = threadId
  record.structuredExecution = { ...record.structuredExecution!, state: 'completed', threadId, turnId, output, resultDigest: hash(output) }
  return { sessionId: record.session, threadId, turnId, output, resultDigest: hash(output) }
}
async function fixture(existingRoot?: string, model?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'native-run-')), protocol = openProtocol(join(root, 'db.sqlite'))
  const cache = new Map<string, Buffer>()
  const blobIO = { put: (bytes: Buffer): BlobRef => { const sha256 = createHash('sha256').update(bytes).digest('hex'); cache.set(sha256, bytes); return { sha256 } }, read: (ref: BlobRef): Buffer => { const bytes = cache.get(ref.sha256); assert.ok(bytes); return bytes } }
  const manifestBlob = blobIO.put(Buffer.from('{"version":1,"entries":[]}'))
  await migrateSyncStore(protocol)
  const store = new SyncStore(protocol, { readBlob: blobIO.read })
  const source = { repositoryId: 'repo', commonDir: join(root, '.git'), canonicalRoot: root, gitDir: join(root, '.git'), branch: 'source', physicalFingerprint: 'physical-source' }
  const operation = store.admitAndEnqueue({ ingressKey: 'request', rootCauseId: 'cause', origin: 'spec', ...(model ? { model } : {}), input: { id: 'source-input', source, headCommit: 'a'.repeat(40), immutableTree: 'b'.repeat(40), indexTree: 'b'.repeat(40), indexDigest: 'c'.repeat(64), manifestBlob, contentDigest: 'd'.repeat(64), capturedAtMs: Date.now() }, scope: { paths: ['src/a.ts'], contractIds: ['RULE-A'], flowIds: [] }, budget: { maxCalls: 4, maxAttempts: 4, maxRepairs: 2, timeoutMs: 60000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: join(root, 'delivery'), branch: 'delivery', baseCommit: 'a'.repeat(40) } })
  const claimed = store.claimAttempt({ operationId: operation.id, source, scope: operation.scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
  const request = { root, base: 'a'.repeat(40), prompt: 'Return the frozen answer', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, requestKey: 'generation-1', inputDigest: 'elaboration-input', purpose: 'generation', timeoutMs: 5000, ...(model ? { model, effort: 'high' as const } : {}) }
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
    await assert.rejects(run(f.request), /evidence object digest is invalid/)
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

test('frozen native dispatch preserves business binding, uses actual attempt/policy and verifies proof on removed replay', async () => {
  const f = await fixture(undefined, 'gpt-6.1-terra'), directory = mkdtempSync(join(tmpdir(), 'native-run-frozen-'))
  try {
    const frozenContext = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: f.request.requestKey, inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('frozen task') }] })
    let calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; assert.equal(request.requestKey, f.request.requestKey); assert.ok(request.sessionCreateKey)
      assert.equal(readFrozenManifest(request.frozenContext!).binding.attemptId, f.claimed.attempt.id)
      const record = published(request); f.records.set(record.session, record)
      const result = completed(record), args = { contextDigest: frozenContext.contextDigest, entryId: 'task', startByte: 0, endByte: 11 }
      const frozenReadProof = proveFrozenReads(frozenContext, { threadId: result.threadId, turnId: result.turnId }, [{ type: 'dynamicToolCall', id: 'controlled-call', namespace: null, tool: 'spex_read_frozen', arguments: args, status: 'completed', success: true, contentItems: readFrozenRange(frozenContext, args).response.contentItems }])
      record.structuredExecution!.frozenReadProof = frozenReadProof
      return { ...result, frozenReadProof }
    } })
    const request = { ...f.request, frozenContext }, result = await run(request)
    const plan = JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString()) as NativeRunPlan
    assert.equal(plan.request.model, 'gpt-6.1-terra'); assert.equal(plan.request.effort, 'high')
    assert.equal(plan.requestDigest, hash(plan.request)); assert.equal(f.records.get(result.sessionId)!.structuredExecution!.model, 'gpt-6.1-terra')
    await assert.rejects(run({ ...request, model: 'gpt-6-astra' }), /key was reused/)
    assert.equal(f.resource().phase, 'removed'); assert.equal(calls, 1)
    assert.deepEqual(await run(request), result); assert.equal(calls, 1)
    const bad = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: 'foreign', inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [] })
    await assert.rejects(run({ ...f.request, frozenContext: bad }), /requestKey/)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup(); rmSync(directory, { recursive: true, force: true }) }
})

for (const defect of ['claude-legacy', 'claude-model', 'zcode-provider', 'zcode-model'] as const) test(`v5/null ${defect} proof is refused live and on removed replay`, async () => {
  const model = defect.startsWith('claude') ? 'claude:MiniMax-M3.1-Flash' : 'zcode:bigmodel-api/GLM-5.3-Flash'
  const f = await fixture(undefined, model), directory = mkdtempSync(join(tmpdir(), 'native-v5-proof-'))
  try {
    const frozenContext = freezeContext({ directory, sourceRoot: f.root, binding: { requestKey: f.request.requestKey, inputDigest: f.request.inputDigest, attemptId: f.claimed.attempt.id, policyDigest: f.claimed.operation.policyDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('frozen task') }] })
    let calls = 0, bad: StructuredSessionResult | undefined
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; const record = published(request), result = completed(record); f.records.set(record.session, record)
      assert.equal(record.structuredExecution!.version, 5)
      const args = { contextDigest: frozenContext.contextDigest, entryId: 'task', startByte: 0, endByte: 11 }
      const coverage = proveFrozenReads(frozenContext, { threadId: result.threadId, turnId: result.turnId }, [{ type: 'dynamicToolCall', id: 'call', namespace: null, tool: 'spex_read_frozen', arguments: args, status: 'completed', success: true, contentItems: readFrozenRange(frozenContext, args).response.contentItems }])
      const frozenReadProof = defect === 'claude-legacy' ? coverage : defect === 'claude-model'
        ? { ...coverage, version: 3 as const, provider: 'claude-code' as const, promptId: 'prompt', model: 'foreign', cliVersion: '2.1.309', maxReadBytes: 65536 as const, maxResultSizeChars: 500000 as const }
        : { ...coverage, version: 4 as const, provider: 'zcode' as const, providerId: defect === 'zcode-provider' ? 'foreign' : 'bigmodel-api', modelId: defect === 'zcode-model' ? 'foreign' : 'GLM-5.3-Flash', cliVersion: '0.17.1', cliSha256: 'a'.repeat(64), inputId: 'input', promptDigest: 'b'.repeat(64), witnessDigest: 'c'.repeat(64) }
      bad = { ...result, frozenReadProof }; record.structuredExecution!.frozenReadProof = frozenReadProof
      return bad
    } })
    const request = { ...f.request, frozenContext, timeoutMs: null }, message = defect.startsWith('claude') ? /Claude result lacks its exact native provider\/model proof/ : /ZCode result lacks its exact native provider\/model proof/
    await assert.rejects(run(request), message)
    assert.notEqual(f.resource().phase, 'removed'); assert.equal(calls, 1)
    for (const phase of ['terminal', 'removed'] as const) {
      const current = f.resource(), checkpoint = { ...f.checkpoint(), phase, status: 'completed' as const, result: bad! }
      f.store.recordResourceCheckpoint(current.id, { operationId: checkpoint.operationId, attemptId: checkpoint.attemptId, inputId: checkpoint.inputId, candidateDigest: checkpoint.candidateDigest, phase, expectedCheckpointRef: current.checkpointRef, checkpointRef: f.blobIO.put(Buffer.from(JSON.stringify(checkpoint))) })
    }
    await assert.rejects(run(request), message); assert.equal(calls, 1)
  } finally { f.cleanup(); rmSync(directory, { recursive: true, force: true }) }
})

test('large native prompt freezes before reserveDispatch and reuses stable manifest on retry', async () => {
  const f = await fixture()
  try {
    const original = ' '.repeat(2 * 1024 * 1024) + 'frozen-tail'
    let first: StructuredSessionRequest | undefined, calls = 0
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++; assert.ok(request.frozenContext); assert.ok(request.prompt.length < 2048)
      assert.equal(request.inputDigest, f.request.inputDigest); assert.equal(request.requestKey, f.request.requestKey)
      const manifest = readFrozenManifest(request.frozenContext)
      assert.equal(manifest.entries[0].byteLength, Buffer.byteLength(original))
      assert.equal(manifest.binding.attemptId, f.claimed.attempt.id)
      if (first) assert.deepEqual({ ...request, signal: undefined }, { ...first, signal: undefined })
      else first = request
      const record = published(request); f.records.set(record.session, record)
      throw new Error('controlled unresolved native request')
    } })
    const request = { ...f.request, prompt: original }
    await assert.rejects(run(request), /controlled unresolved/)
    await assert.rejects(run(request), /controlled unresolved/)
    assert.equal(calls, 2); assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().phase, 'created')
  } finally { f.cleanup() }
})

test('pure JSON frozen entries bind the real attempt before dispatch and terminal replay does not call native again', async () => {
  const f = await fixture()
  try {
    const text = '\uFEFF原生计划正文'
    let calls = 0, preparedPrompt = ''
    const run = f.runner({ ...f.runtimeBase, run: async request => {
      calls++
      preparedPrompt = request.prompt
      assert.equal(request.frozenEntries, undefined)
      assert.ok(request.frozenContext)
      const manifest = readFrozenManifest(request.frozenContext)
      assert.equal(manifest.binding.attemptId, f.claimed.attempt.id)
      assert.equal(manifest.binding.policyDigest, f.claimed.operation.policyDigest)
      assert.equal(manifest.binding.requestKey, f.request.requestKey)
      assert.equal(manifest.binding.inputDigest, f.request.inputDigest)
      const entry = manifest.entries.find(item => item.sha256 === createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'))
      assert.equal(entry?.required, false)
      assert.equal(request.prompt.includes(text), false)
      const record = published(request); f.records.set(record.session, record)
      const result = completed(record)
      const frozenReadProof = proveFrozenReads(request.frozenContext, { threadId: result.threadId, turnId: result.turnId }, [])
      record.structuredExecution!.frozenReadProof = frozenReadProof
      return { ...result, frozenReadProof }
    } })
    const request = { ...f.request, frozenEntries: [{ id: 'note', label: 'optional note', required: false, kind: 'utf8' as const, text }] }
    const result = await run(request)
    const plan = JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString()) as NativeRunPlan
    assert.equal(plan.request.frozenEntries, undefined)
    assert.equal(JSON.stringify(plan.request).includes(text), false)
    assert.equal(plan.request.prompt, preparedPrompt)
    assert.equal(plan.requestDigest, hash(plan.request))
    assert.equal(f.resource().phase, 'removed'); assert.equal(calls, 1)
    assert.deepEqual(await run(request), result); assert.equal(calls, 1)
    assert.deepEqual(await run(plan.request), result); assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('exact legacy inline resource recovers after reader threshold change without rewriting its request or dispatch', async () => {
  const f = await fixture()
  try {
    const request = { ...f.request, prompt: 'x'.repeat(1_369_916) + '义'.repeat(82_260) + '尾部义' }, requestDigest = hash(request)
    assert.equal(request.prompt.length, 1_452_179); assert.equal(Buffer.byteLength(request.prompt), 1_616_705)
    const dispatch = f.store.reserveDispatch(f.claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    const record = published({ ...request, requestKey: dispatch.sessionCreateKey }), threadId = 'legacy-refused-first-thread'
    record.status = 'error'; record.harnessSessionId = threadId
    record.structuredExecution = { ...record.structuredExecution!, state: 'failed', threadId, turnStartRequested: true, error: 'legacy first turn refused' }
    f.records.set(record.session, record)
    const identity = { operationId: f.claimed.operation.id, attemptId: f.claimed.attempt.id, inputId: f.claimed.operation.input.id, candidateDigest: null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: record.session, ...identity }
    const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId: record.session, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'failed', session: { sessionId: record.session, threadId, turnId: null } }
    const put = (value: unknown) => f.blobIO.put(Buffer.from(JSON.stringify(value)))
    const resource = f.store.planResource(f.claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: identity.inputId, candidateDigest: null, planBlob: put(plan), checkpointRef: put(checkpoint) })
    f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: resource.checkpointRef, checkpointRef: put({ ...checkpoint, phase: 'created' }) })
    let calls = 0, stops = 0
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async () => { calls++; throw new Error('legacy recovery must not start native work') }, cancel: async id => {
      stops++; assert.equal(id, record.session)
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' } }
      return { sessionId: id, state: 'cancelled', threadId, nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' }
    } })
    const controller = new AbortController(); controller.abort()
    await assert.rejects(run({ ...request, signal: controller.signal }), /native execution cancelled and exact stop settled/)
    assert.equal(f.resource().phase, 'removed'); assert.equal(stops, 1); assert.equal(calls, 0)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
    assert.equal(f.resource().plan.payloadDigest, requestDigest)
    assert.deepEqual(JSON.parse(f.blobIO.read(f.resource().plan.planBlob).toString('utf8')), plan)
    await assert.rejects(run({ ...request, prompt: request.prompt + 'changed', signal: controller.signal }), /key was reused/)
    assert.equal(stops, 1); assert.equal(calls, 0); assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
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
  for (const defect of ['session', 'thread', 'hash', 'record_payload', 'record_model'] as const) {
    const f = await fixture()
    try {
      const run = f.runner({ ...f.runtimeBase, run: async request => {
        const record = published(request), result = completed(record); f.records.set(record.session, record)
        if (defect === 'record_payload') record.createPayloadHash = 'wrong-request-hash'
        if (defect === 'record_model') record.structuredExecution!.model = 'gpt-6-astra'
        return { ...result, ...(defect === 'session' ? { sessionId: 'wrong-session' } : {}), ...(defect === 'thread' ? { threadId: 'wrong-thread' } : {}), ...(defect === 'hash' ? { resultDigest: 'wrong-output-hash' } : {}) }
      } })
      await assert.rejects(run(f.request), /invalid|differs/)
      assert.notEqual(f.resource().phase, 'removed')
      assert.equal(f.store.listRecoverableResources().length, 1)
    } finally { f.cleanup() }
  }
})

for (const timeoutMs of [5000, null]) test(`cancel acknowledgement loss with timeout=${timeoutMs} still settles exact resources after fence revocation`, async () => {
  const f = await fixture()
  try {
    let cancellations = 0
    const run = f.runner({ readRecord: f.runtimeBase.readRecord, run: async request => {
      const record = published(request); record.status = 'active'; record.harnessSessionId = 'thread'; record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread', turnId: 'turn', turnStartRequested: true }; f.records.set(record.session, record)
      return new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true }))
    }, cancel: async (id, options) => {
      assert.equal(options?.timeoutMs, timeoutMs === null ? 15000 : timeoutMs)
      cancellations++; assert.equal(id, f.checkpoint().expectedSessionId)
      const record = f.records.get(id)!
      record.structuredExecution = { ...record.structuredExecution!, state: 'cancelled', cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: true, nativeStatus: 'interrupted' } }
      throw new Error('cancel reply lost')
    } })
    const pending = run({ ...f.request, timeoutMs })
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
    await assert.rejects(pending, /absence alone does not confirm stop/)
    assert.equal(cancelled, true)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(f.checkpoint().nativeStarted, false)
    assert.equal(f.store.listRecoverableResources().length, 1)
    finishCreation()
    await assert.rejects(f.runner({ ...f.runtimeBase, run: async () => { calls++; throw new Error('must not redispatch cancelled creation') } })(input), /absence alone does not confirm stop/)
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


for (const creationPhase of ['target-resolution', 'git-worktree', 'cleanup-failed', 'cleanup-interrupted', 'cleanup-rebuilt-path', 'cleanup-advanced-branch', 'published-concurrent'] as const) test(`real Git creation abort ${creationPhase} holds capacity through cleanup and restart reads exact termination without redispatch`, { timeout: 25_000 }, async () => {
  const childMode = process.env.SPEX_NATIVE_CREATE_PROOF_MODE
  if (childMode) {
    const f = await fixture(process.cwd())
    try {
      const request = { ...f.request, base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
      const sourceIndex = readFileSync(join(process.cwd(), '.git', 'index')), sourceReadme = readFileSync('README')
      const userPath = join(process.cwd(), 'user-worktree'), userReadme = readFileSync(join(userPath, 'README'))
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
      if (creationPhase.startsWith('cleanup-') || creationPhase === 'published-concurrent') {
        await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancellation_pending')
        await waitUntil(() => creationError !== undefined, 12_000)
        assert.equal(readSessionCreateTermination(createKey), null)
        assert.equal(f.resource().phase, 'planned')
        assert.equal(f.store.listRecoverableResources().length, 1)
        assert.ok(creationError instanceof StructuredSessionError)
        assert.equal(creationError.code, 'failed')
        assert.match(creationError.message, /cleanup left residue/)
        if (creationPhase === 'cleanup-interrupted') assert.match(creationError.message, /during branch delete \(cleanup deadline expired\)/)
        const record = published({ ...request, requestKey: createKey })
        const recoveryOptions = { prompt: request.prompt, payloadHash: record.createPayloadHash!, base: request.base, signal: AbortSignal.timeout(5000), structuredExecution: record.structuredExecution! }
        await assert.rejects(recoverSessionCreateTermination(createKey, { ...recoveryOptions, payloadHash: '0'.repeat(64) }), /does not match cancelled create request/)
        if (creationPhase === 'cleanup-failed') {
          await assert.rejects(recoverSessionCreateTermination(createKey, { ...recoveryOptions, structuredExecution: undefined }), /does not match cancelled create request/)
          process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = 'recovery'
          const { runtimeRoot } = await import('@spexcode/spec-core')
          const candidate = JSON.parse(readFileSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`), 'utf8')) as { path: string }
          assert.equal(dirname(candidate.path), join(realpathSync(runtimeRoot()), 'structured-worktrees'))
          const original = readFileSync(join(candidate.path, 'README'))
          for (const kind of ['unstaged', 'staged', 'untracked', 'ignored'] as const) {
            const userFile = join(candidate.path, kind === 'unstaged' || kind === 'staged' ? 'README' : `${kind}-user-data`)
            writeFileSync(userFile, `user ${kind} content\n`)
            if (kind === 'staged') execFileSync('git', ['-C', candidate.path, 'add', 'README'])
            if (kind === 'ignored') writeFileSync(join(process.cwd(), '.git', 'info', 'exclude'), 'ignored-user-data\n')
            await assert.rejects(recoverSessionCreateTermination(createKey, recoveryOptions), /preserving user edits/)
            assert.equal(readFileSync(userFile, 'utf8'), `user ${kind} content\n`)
            assert.equal(f.resource().phase, 'planned')
            assert.equal(readSessionCreateTermination(createKey), null)
            if (kind === 'unstaged' || kind === 'staged') {
              writeFileSync(userFile, original)
              execFileSync('git', ['-C', candidate.path, 'reset', '-q', request.base, '--', 'README'])
            } else rmSync(userFile)
          }
        }
        if (creationPhase === 'cleanup-rebuilt-path' || creationPhase === 'cleanup-advanced-branch') {
          const { runtimeRoot } = await import('@spexcode/spec-core')
          const candidate = JSON.parse(readFileSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`), 'utf8')) as { path: string; branch: string }
          const ref = `refs/heads/${candidate.branch}`
          const advanced = execFileSync('git', ['commit-tree', `${request.base}^{tree}`, '-p', request.base, '-m', 'concurrent user commit'], { encoding: 'utf8' }).trim()
          process.env.SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH = candidate.path
          process.env.SPEX_NATIVE_CREATE_PROOF_CANDIDATE_REF = ref
          process.env.SPEX_NATIVE_CREATE_PROOF_ADVANCED = advanced
          process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = creationPhase === 'cleanup-rebuilt-path' ? 'recovery-rebuilt-path' : 'recovery-advanced-branch'
          await assert.rejects(async () => {
            const result = await recoverSessionCreateTermination(createKey, recoveryOptions)
            console.log(JSON.stringify({ unexpectedRecovery: creationPhase, termination: result, rebuiltPathPreserved: existsSync(join(candidate.path, 'concurrent-user-data')), advancedBranchPreserved: execFileSync('git', ['for-each-ref', ref, '--format=%(objectname)'], { encoding: 'utf8' }).trim() === advanced }))
            return result
          }, /matching candidate recovery left residue/)
          assert.equal(readSessionCreateTermination(createKey), null)
          assert.equal(f.resource().phase, 'planned')
          assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
          assert.equal(calls, 1)
          assert.ok(existsSync(join(runtimeRoot(), '.session-create-candidates', `${record.session}.json`)))
          if (creationPhase === 'cleanup-rebuilt-path') {
            assert.equal(readFileSync(join(candidate.path, 'concurrent-user-data'), 'utf8'), 'concurrent user content\n')
            rmSync(candidate.path, { recursive: true })
          } else {
            assert.equal(execFileSync('git', ['rev-parse', '--verify', ref], { encoding: 'utf8' }).trim(), advanced)
            execFileSync('git', ['update-ref', ref, request.base, advanced])
            const hook = join(process.cwd(), '.git', 'hooks', 'reference-transaction')
            writeFileSync(hook, '#!/bin/sh\nif [ "$1" = committed ]; then cat >> "$SPEX_NATIVE_CREATE_PROOF_REF_TRACE"; fi\n')
            chmodSync(hook, 0o755)
          }
        }
        if (creationPhase === 'published-concurrent') {
          const { withRecordLock } = await import('../session-record.js')
          let unlock: () => void = () => {}, admitted: () => void = () => {}, settled = false
          const locked = new Promise<void>(resolve => { admitted = resolve })
          const publisher = withRecordLock(record.session, async () => { admitted(); await new Promise<void>(resolve => { unlock = resolve }); (await import('../session-application.js')).configuredSessionApplication().createSession({ sessionId: record.session, status: 'queued' }) })
          await locked
          const before = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
          const recovery = recoverSessionCreateTermination(createKey, recoveryOptions).then(value => { settled = true; return value })
          await new Promise<void>(resolve => setTimeout(resolve, 25))
          assert.equal(settled, false, 'recovery cannot overtake the creator publication fence')
          unlock(); await publisher
          assert.equal(await recovery, null, 'canonical publication without an envelope still refuses notStarted cleanup')
          assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }), before)
          assert.equal(readSessionCreateTermination(createKey), null)
          assert.equal(f.resource().phase, 'planned')
          assert.equal(calls, 1)
          console.log(JSON.stringify({ cleanupFailure: creationError.message, publishedPreserved: true, resource: f.resource().phase, calls }))
          return
        }
        process.env.SPEX_NATIVE_CREATE_PROOF_PHASE = 'recovery'
        await assert.rejects(createAttemptRunner(f.store, f.claimed.fence, { blobIO: f.blobIO, pollMs: 2 })(request), error => error instanceof StructuredSessionError && error.code === 'cancelled')
        assert.equal(calls, 1)
      }
      else await assert.rejects(pending, error => error instanceof StructuredSessionError && error.code === 'cancelled')
      const receipt = readSessionCreateTermination(createKey)
      assert.ok(receipt)
      assert.equal(receipt.cleanupComplete, true)
      assert.equal(receipt.phase, creationPhase.startsWith('cleanup-') ? 'cleanup' : creationPhase)
      assert.equal(receipt.nativeStatus, 'notStarted')
      if (creationPhase === 'cleanup-advanced-branch') assert.match(readFileSync(process.env.SPEX_NATIVE_CREATE_PROOF_REF_TRACE!, 'utf8'), new RegExp(`${request.base} 0+ refs/heads/codex/`), 'successful expected-old deletion must run the normal reference transaction hook')
      assert.equal(f.resource().phase, 'removed')
      assert.equal(runtime.readRecord(receipt.sessionId), null)
      assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' }).match(/^worktree /gm)?.length, 2)
      assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/codex', '--format=%(refname)'], { encoding: 'utf8' }).trim(), '')
      assert.deepEqual(readFileSync(join(process.cwd(), '.git', 'index')), sourceIndex)
      assert.deepEqual(readFileSync('README'), sourceReadme)
      assert.deepEqual(readFileSync(join(userPath, 'README')), userReadme)
      assert.equal(execFileSync('git', ['-C', userPath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), 'user-work')
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
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'user-work', join(repo, 'user-worktree')])
    writeFileSync(join(repo, 'README'), 'user staged input\n'); execFileSync('git', ['-C', repo, 'add', 'README'])
    writeFileSync(join(repo, 'README'), 'user unstaged input\n')
    writeFileSync(join(repo, 'user-worktree', 'README'), 'other user worktree input\n')
    const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in *" branch -D "*) ${JSON.stringify(gitPath)} "$@" || exit $?; if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = cleanup-interrupted ]; then sleep 30; fi ;; *" worktree remove "*) case "$SPEX_NATIVE_CREATE_PROOF_PHASE" in cleanup-failed|cleanup-rebuilt-path|cleanup-advanced-branch|published-concurrent) printf 'controlled cleanup failure\\n' >&2; exit 17 ;; recovery-rebuilt-path) ${JSON.stringify(gitPath)} "$@" || exit $?; mkdir -p "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH"; printf 'concurrent user content\\n' > "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_PATH/concurrent-user-data" ;; recovery-advanced-branch) ${JSON.stringify(gitPath)} "$@" || exit $?; exec ${JSON.stringify(gitPath)} update-ref "$SPEX_NATIVE_CREATE_PROOF_CANDIDATE_REF" "$SPEX_NATIVE_CREATE_PROOF_ADVANCED" ;; *) exec ${JSON.stringify(gitPath)} "$@" ;; esac ;; *" rev-parse --verify --quiet "*) if [ "$SPEX_NATIVE_CREATE_PROOF_PHASE" = target-resolution ]; then printf 'target\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30; else exec ${JSON.stringify(gitPath)} "$@"; fi ;; *" worktree add "*) ${JSON.stringify(gitPath)} "$@" || exit $?; printf 'created\\n' >> "$SPEX_NATIVE_CREATE_PROOF_TRACE"; sleep 30 ;; *) exec ${JSON.stringify(gitPath)} "$@" ;; esac
`)
    chmodSync(join(bin, 'git'), 0o755)
    const result = spawnSync(process.execPath, ['--import', tsxImport, '--test', '--test-name-pattern', `^real Git creation abort ${creationPhase}`, fileURLToPath(import.meta.url)], { cwd: repo, encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEX_SESSION_DATABASE_PATH: join(root, 'home', 'sessions.sqlite'), PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: join(root, 'home'), SPEX_NATIVE_CREATE_PROOF_MODE: 'child', SPEX_NATIVE_CREATE_PROOF_PHASE: creationPhase, SPEX_NATIVE_CREATE_PROOF_TRACE: trace, SPEX_NATIVE_CREATE_PROOF_REF_TRACE: join(root, 'ref-trace') } })
    if (process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR) {
      mkdirSync(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, { recursive: true })
      writeFileSync(join(process.env.SPEX_NATIVE_CREATE_EVIDENCE_DIR, `native-create-${creationPhase}.log`), `${result.stdout}\n${result.stderr}`)
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /creationTermination|cleanupFailure/, 'the nested real Git fixture must actually execute')
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
    const settledRunner = f.runner({ ...runtime, readCreateTermination: () => receipt })
    const assertSettledTimeout = (error: unknown): boolean => {
      assert.ok(error instanceof SettledSessionCreateTimeoutError)
      assert.equal(error.code, 'timeout')
      assert.deepEqual(error.termination, receipt)
      return true
    }
    await assert.rejects(settledRunner(f.request), assertSettledTimeout)
    await assert.rejects(settledRunner(f.request), assertSettledTimeout, 'removed replay retains the exact settled creation timeout subtype')
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'removed')
    assert.equal(f.checkpoint().creationTermination?.code, 'session_create_timeout')
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('timeout without an exact creation termination receipt is not classified as a settled retry', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new StructuredSessionError('timeout', 'creation observer timed out without a termination receipt') } }
    await assert.rejects(f.runner(runtime)(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error.code, 'timeout')
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'planned')
    assert.equal(f.checkpoint().nativeCallRequested, true)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('terminal create timeout checkpoint resumes terminal-to-removed with its exact subtype', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async () => { calls++; throw new Error('creation observer transport lost') } }
    await assert.rejects(f.runner(runtime)(f.request), /transport lost/)
    const key = f.store.readAttempt(f.claimed.attempt.id).dispatchPlans[0].sessionCreateKey, record = published({ ...f.request, requestKey: key })
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    const resource = f.resource(), checkpoint = f.checkpoint(), terminal: NativeRunCheckpoint = {
      ...checkpoint,
      phase: 'terminal',
      status: 'timeout',
      creationTermination: receipt,
      stop: { sessionId: record.session, state: 'timeout', nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' },
    }
    f.store.recordResourceCheckpoint(resource.id, {
      operationId: checkpoint.operationId, attemptId: checkpoint.attemptId, inputId: checkpoint.inputId, candidateDigest: checkpoint.candidateDigest,
      phase: 'terminal', expectedCheckpointRef: resource.checkpointRef, checkpointRef: f.blobIO.put(Buffer.from(JSON.stringify(terminal))),
    })
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof SettledSessionCreateTimeoutError)
      assert.deepEqual(error.termination, receipt)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'removed')
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
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      assert.match(error.message, /termination differs/)
      return true
    })
    assert.equal(f.resource().phase, 'planned')
    assert.equal(calls, 1)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('exact creation timeout cannot be retried as settled after native thread and turn have started', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const runtime = { ...f.runtimeBase, run: async (request: StructuredSessionRequest) => {
      calls++
      const record = published(request)
      record.status = 'active'
      record.harnessSessionId = 'thread-started'
      record.structuredExecution = { ...record.structuredExecution!, state: 'running', threadId: 'thread-started', turnId: 'turn-started', turnStartRequested: true }
      f.records.set(record.session, record)
      throw new Error('native transport lost after start')
    } }
    await assert.rejects(f.runner(runtime)(f.request), /native transport lost after start/)
    const record = [...f.records.values()][0]
    const receipt: SessionCreateTermination = { version: 1, sessionId: record.session, requestDigest: record.createRequestId!, payloadHash: record.createPayloadHash!, code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true }
    await assert.rejects(f.runner({ ...runtime, readCreateTermination: () => receipt })(f.request), error => {
      assert.ok(error instanceof StructuredSessionError)
      assert.equal(error.code, 'stale_result')
      assert.equal(error instanceof SettledSessionCreateTimeoutError, false)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(f.resource().phase, 'created')
    assert.equal(f.checkpoint().nativeStarted, true)
    assert.equal(f.store.readOperation(f.claimed.operation.id).callsUsed, 1)
  } finally { f.cleanup() }
})

test('worktree资源桥贯通真实创建/queue/fake CLI，prompt只规范一次，实际commit和冷重放绑定完整', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sync-native-worktree-bridge-')), root = join(directory, 'repo'), home = join(directory, 'home'), bin = join(directory, 'bin'), count = join(directory, 'dispatches.json')
  mkdirSync(root); mkdirSync(home); mkdirSync(bin)
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'bridge fixture'); git('config', 'user.email', 'bridge@example.invalid')
    mkdirSync(join(root, '.spec')); writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    writeFileSync(join(root, 'value'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed')
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline'),cp=require('node:child_process');
if(process.argv.includes('--version')){process.stdout.write('2.1.309 (Claude Code)\\n');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const prompt=user.message.content[0].text;
const calls=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];calls.push({prompt,cwd:process.cwd()});fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(calls));
const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
send({type:'system',subtype:'init',session_id:session,model,tools:['Read','Bash','Edit','StructuredOutput']});send(user);
if(prompt.startsWith('edit')){fs.writeFileSync('value','actual committed candidate\\n');cp.execFileSync('git',['add','value']);cp.execFileSync('git',['commit','-qm','native candidate'])}
send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'result',user_message_uuid:user.uuid,user_message_uuids:[user.uuid],structured_output:{answer:'actual native result'}});
});`)
    chmodSync(executable, 0o755)
    const modulePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url)), script = join(directory, 'runner.mts')
    writeFileSync(script, `import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
import{openProtocol}from'${createRequire(import.meta.url).resolve('@spexcode/session-protocol')}';import{configuredSessionApplication}from${JSON.stringify(modulePath('../session-application.ts'))};
import{migrateSyncStore}from${JSON.stringify(modulePath('./migrations.ts'))};import{SyncStore}from${JSON.stringify(modulePath('./store.ts'))};import{createAttemptRunner}from${JSON.stringify(modulePath('./native-run.ts'))};import{captureInputSnapshot,readEvidence}from${JSON.stringify(modulePath('./snapshot.ts'))};import{stageWorktree}from${JSON.stringify(modulePath('./stage-worktree.ts'))};import{nativeWorktreePrompt}from${JSON.stringify(modulePath('../native-worktree-runtime.ts'))};import{readRecord}from${JSON.stringify(modulePath('../session-record.ts'))};import{structuredExecutionPolicy}from${JSON.stringify(modulePath('../session-structured-policy.ts'))};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),git=args=>execFileSync('git',args,{encoding:'utf8'}).trim(),snapshot=await captureInputSnapshot(process.cwd(),{committed:true}),application=configuredSessionApplication(),protocol=openProtocol(process.env.SPEX_SESSION_DATABASE_PATH);await migrateSyncStore(protocol);const store=new SyncStore(protocol,{readBlob:ref=>readEvidence(snapshot.source.commonDir,ref)}),scope={paths:['value'],contractIds:[],flowIds:[]};
const operation=store.admitAndEnqueue({ingressKey:'bridge',rootCauseId:'bridge',origin:'spec',input:snapshot,scope,budget:{maxCalls:4,maxAttempts:2,maxRepairs:1,timeoutMs:60000},policyDigest:'policy',impactDigest:'impact',readSetDigest:'read',delivery:null,deliveryPlan:{canonicalRoot:process.cwd()+'/delivery',branch:'delivery',baseCommit:snapshot.headCommit}}),claim=store.claimAttempt({operationId:operation.id,source:snapshot.source,scope,leaseMs:30000,expectedMessageId:operation.dispatchMessageId}),seed=stageWorktree(snapshot.source.commonDir,snapshot.headCommit,snapshot.immutableTree,'edit'),request={root:process.cwd(),base:seed.baseCommit,worktree:seed,requestKey:'edit-bridge',inputDigest:'bound',purpose:'code_generate',prompt:'edit once',schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},timeoutMs:10000,model:'claude:MiniMax-M3.1-Flash',effort:'high'},runner=createAttemptRunner(store,claim.fence,{pollMs:2});
const result=await runner(request),record=readRecord(result.sessionId),expected=hash({prompt:nativeWorktreePrompt(request.prompt,seed),parent:null,launcher:null,base:seed.baseCommit,structuredExecution:structuredExecutionPolicy(request)});assert.equal(record.createPayloadHash,expected);assert.equal(result.frozenReadProof,undefined);assert.equal(record.structuredExecution.frozenContext,undefined);assert.equal(record.structuredExecution.resultWorktree.tree,result.worktree.tree);assert.notEqual(result.worktree.headCommit,seed.baseCommit);assert.equal(git(['show',result.worktree.headCommit+':value']),'actual committed candidate');assert.equal(store.findResource(claim.attempt.id,request.requestKey).phase,'removed');
const calls=JSON.parse(readFileSync(${JSON.stringify(count)},'utf8'));assert.equal(calls.length,1);assert.equal(calls[0].prompt,nativeWorktreePrompt(request.prompt,seed));assert.equal(calls[0].cwd,result.worktree.worktreePath);
git(['worktree','remove',result.worktree.worktreePath]);assert.deepEqual(await createAttemptRunner(store,claim.fence,{pollMs:2})(request),result);assert.equal(store.readOperation(operation.id).callsUsed,1);assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);await assert.rejects(runner({...request,prompt:'another task'}),{code:'key_reused'});protocol.close();process.exit(0);`)
    const result = spawnSync(process.execPath, ['--import', tsxImport, script], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), ANTHROPIC_BASE_URL: 'https://example.invalid', SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
