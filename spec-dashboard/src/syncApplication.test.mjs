import test from 'node:test'
import assert from 'node:assert/strict'
import { controlSync, enableSync, evidenceProjection, readSyncStatus, readSyncDiff, requestIdentity, runSync, syncProjection } from './syncApplication.js'
import { apiFetch, postSpecBody } from './data.js'

/** @type {import('../../spec-cli/src/sync/operation-types.ts').WorktreeIdentity} */
const source = { repositoryId: 'repo', commonDir: '/repo/.git', canonicalRoot: '/repo/source', gitDir: '/repo/.git/worktrees/source', branch: 'source', physicalFingerprint: 'source-fingerprint' }
/** @type {import('../../spec-cli/src/sync/operation-types.ts').InputSnapshot} */
const input = { id: 'input', source, headCommit: 'head', immutableTree: 'tree', indexTree: 'tree', indexDigest: 'index', manifestBlob: { sha256: 'manifest' }, contentDigest: 'content', capturedAtMs: 1 }
const scope = { paths: ['.spec/alpha/spec.md'], contractIds: ['REQ-1'], flowIds: [] }
/** @type {import('../../spec-cli/src/sync/operation-types.ts').SyncOperation} */
const operation = { id: 'op', ingressKey: 'ingress', payloadDigest: 'payload', rootCauseId: 'root', origin: 'spec', generation: 1, revision: 1, phase: 'workspace_synced', control: 'run', input, previousBaselinePair: null, scope, readyScope: scope, blockedScope: { paths: [], contractIds: [], flowIds: [] }, deliveredScope: scope, blockedReason: null, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'readset', budget: { maxAttempts: 3, maxCalls: 6, maxRepairs: 2, timeoutMs: 1000 }, callsUsed: 1, deadlineAtMs: 1001, currentAttemptId: 'attempt', dispatchMessageId: 'dispatch', delivery: null, deliveryPlan: { canonicalRoot: '/repo/private', branch: 'delivery', baseCommit: 'head' }, createdAtMs: 1, updatedAtMs: 2 }
const receipt = { id: 'receipt', deliverySnapshot: { ...input, source: { ...source, canonicalRoot: '/repo/published' } } }
const settled = { status: 'settled', receipt, generation: 1, attemptId: 'attempt' }
const detail = { operation, attempt: null, journals: [settled], stale: false, sourceSynced: false, executionAvailability: { status: 'ready' } }

test('only a settled current receipt projects delivery completion and its actual tree', () => {
  const view = syncProjection(detail)
  assert.equal(view.complete, true)
  assert.equal(view.state, 'workspace_synced')
  assert.equal(view.deliveryRoot, '/repo/published')
  assert.notEqual(view.deliveryRoot, operation.deliveryPlan.canonicalRoot)
  assert.equal(syncProjection({ ...detail, sourceSynced: true }).state, 'source_synced')
})

test('stale, blocked, failed and recovery results never project synchronized', () => {
  for (const phase of ['failed', 'needs_input', 'conflicted', 'budget_exhausted', 'queued', 'applying', 'cancelled']) {
    const view = syncProjection({ ...detail, operation: { ...operation, phase } })
    assert.equal(view.complete, false, phase)
    assert.equal(view.state, phase)
  }
  assert.equal(syncProjection({ ...detail, stale: true }).state, 'stale')
  assert.equal(syncProjection({ ...detail, stale: true }).complete, false)
  const recovery = { status: 'recovery_required', failure: { code: 'MISSING_RUNTIME', message: 'Pinned runtime missing' } }
  assert.equal(syncProjection({ ...detail, executionAvailability: recovery }).state, 'recovery_required')
  assert.equal(syncProjection({ ...detail, executionAvailability: recovery }).complete, false)
})

test('unsettled and previous-attempt private deliveries provide no document door', () => {
  for (const journal of [{ ...settled, status: 'completed' }, { ...settled, generation: 0 }, { ...settled, attemptId: 'old' }, { ...settled, receipt: null }]) {
    const view = syncProjection({ ...detail, journals: [journal] })
    assert.equal(view.complete, false)
    assert.equal(view.deliveryRoot, null)
    assert.equal(view.state, 'unsettled')
  }
})

test('pause, resume and cancel availability follows real phase and recovery constraints', () => {
  const queued = syncProjection({ ...detail, operation: { ...operation, phase: 'queued' }, journals: [] })
  assert.equal(queued.canPause, true)
  assert.equal(queued.canCancel, true)
  assert.equal(queued.canResume, false)
  const paused = syncProjection({ ...detail, operation: { ...operation, phase: 'paused' } })
  assert.equal(paused.canResume, true)
  assert.equal(paused.canPause, false)
  const failed = syncProjection({ ...detail, operation: { ...operation, phase: 'failed' } })
  assert.equal(failed.canResume, false)
  assert.equal(failed.canCancel, false)
  const recovery = syncProjection({ ...detail, executionAvailability: { status: 'recovery_required' } })
  assert.equal(recovery.canResume, false)
  assert.equal(recovery.canPause, false)
  assert.equal(recovery.canCancel, false)
})

test('one unchanged user payload reuses identity across retries, while new text creates a new identity', () => {
  let generated = 0
  const makeId = () => `request-${++generated}`
  const first = requestIdentity(null, { original: 'before', replacement: 'after' }, makeId)
  assert.equal(requestIdentity(first, { original: 'before', replacement: 'after' }, makeId), first)
  const changed = requestIdentity(first, { original: 'before', replacement: 'new text' }, makeId)
  assert.notEqual(first.id, changed.id)
  assert.equal(generated, 2)
})

test('evidence projection shows gaps, verification and actual file deltas without agent prompts', () => {
  const value = evidenceProjection({ status: 'needs_input', gaps: [{ id: 'GAP-1', unknown: 'Who may approve?', evidence: 'No decision recorded', decision: 'Select role', affectedIds: ['REQ-1'] }], prompt: 'private agent prompt', output: { source: 'generated spec' }, rounds: [{ prompt: 'another prompt' }] })
  assert.equal(value.gaps[0].id, 'GAP-1')
  assert.equal(value.gaps[0].decision, 'Select role')
  assert.equal(JSON.stringify(value).includes('prompt'), false)
  assert.deepEqual(evidenceProjection([{ path: 'src/result.js', preDigest: 'a', postDigest: 'b', preMode: '100644', postMode: '100644' }]), [{ path: 'src/result.js', preDigest: 'a', postDigest: 'b', preMode: '100644', postMode: '100644' }])
})

test('transport preserves selected tree, configuration precondition and stable run request identity', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url, 'http://test'), init })
    return new Response(JSON.stringify({ operations: [] }), { status: 200 })
  }
  try {
    await readSyncStatus('node & one', '/delivery')
    await enableSync('current-config', '/delivery')
    await runSync('node & one', 'stable-id', '/delivery')
    await runSync('node & one', 'stable-id', '/delivery')
    await controlSync('operation one', 'pause', '/delivery')
    for (const request of requests) assert.equal(request.url.searchParams.get('targetTree'), '/delivery')
    assert.equal(requests[0].url.searchParams.get('nodeId'), 'node & one')
    assert.deepEqual(JSON.parse(requests[1].init.body), { expectedConfigDigest: 'current-config' })
    assert.equal(requests[2].init.body, requests[3].init.body)
    assert.equal(requests[4].url.pathname, '/api/sync/operations/operation%20one/pause')
  } finally { globalThis.fetch = originalFetch }
})

test('save retries retain their idempotency header and return a sync receipt without fabricating a commit', async () => {
  const originalFetch = globalThis.fetch
  const headers = []
  globalThis.fetch = async (_url, init) => {
    headers.push(init.headers)
    if (headers.length === 1) return new Response(JSON.stringify({ code: 'SYNC_BUSY', error: 'Another request is pending' }), { status: 409 })
    return new Response(JSON.stringify({ ok: true, changed: true, commit: null, syncOperation: operation }), { status: 200 })
  }
  try {
    const patch = { startLine: 1, endLine: 1, original: 'before', replacement: 'after' }
    await assert.rejects(postSpecBody('alpha', patch, 'save-id'), (error) => error.code === 'SYNC_BUSY')
    const result = await postSpecBody('alpha', patch, 'save-id')
    assert.equal(headers[0]['idempotency-key'], 'save-id')
    assert.equal(headers[1]['idempotency-key'], 'save-id')
    assert.equal(result.commit, null)
    assert.equal(result.syncOperation.id, 'op')
  } finally { globalThis.fetch = originalFetch }
})

test('structured API failures surface their own code and aborted status reads are not retried', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'SYNC_CONFIG_MISSING', error: 'No project configuration' }), { status: 409 })
  try { await assert.rejects(enableSync(null), (error) => error.code === 'SYNC_CONFIG_MISSING' && error.message === 'No project configuration') }
  finally { globalThis.fetch = originalFetch }
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => { calls++; throw new globalThis.DOMException('Aborted', 'AbortError') }
  try {
    await assert.rejects(apiFetch('/api/sync/status', { signal: controller.signal }), /Aborted/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = originalFetch }
})


test('candidate and delivered code/test diffs preserve scope and show oversized-read failures', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(new URL(url, 'http://test'))
    if (requests.length === 2) return new Response(JSON.stringify({ code: 'SYNC_DIFF_TOO_LARGE', error: 'Diff exceeds 2 MiB' }), { status: 413 })
    return new Response(JSON.stringify({ path: 'src/result.test.js', kind: 'candidate', baseTree: 'composed', candidateTree: 'candidate', patch: '+test' }), { status: 200 })
  }
  try {
    const result = await readSyncDiff('op', 'src/result.test.js', 'candidate', '/delivery')
    assert.equal(result.patch, '+test')
    assert.equal(requests[0].searchParams.get('kind'), 'candidate')
    assert.equal(requests[0].searchParams.get('path'), 'src/result.test.js')
    assert.equal(requests[0].searchParams.get('targetTree'), '/delivery')
    await assert.rejects(readSyncDiff('op', 'src/result.test.js', 'delivery', '/delivery'), (error) => error.code === 'SYNC_DIFF_TOO_LARGE' && error.message.includes('2 MiB'))
    assert.equal(requests.length, 2)
  } finally { globalThis.fetch = originalFetch }
})
