import test from 'node:test'
import assert from 'node:assert/strict'
import { automaticControl, decideSync, controlSync, enableSync, evidenceProjection, readSyncStatus, readSyncDiff, requestIdentity, revertSync, runSync, stopSyncWriter, syncObserverProjection, syncProjection } from './syncApplication.js'
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
const detail = { operation, attempt: null, journals: [settled], resources: [], retryEligibility: { eligible: false }, decisionEligibility: { eligible: false }, stale: false, sourceSynced: false, canonicalSynced: false, revertEligibility: { eligible: false, reason: { code: 'SYNC_REVERT_NOT_LANDED', message: 'The delivery has not landed' } }, executionAvailability: { status: 'ready' } }

test('early conflict evidence does not grant a decision before backend eligibility settles', () => {
  const inFlight = { ...detail, operation: { ...operation, phase: 'elaborating', blockedReason: 'conflicted' }, attempt: { status: 'running' }, journals: [], decisionEligibility: { eligible: false, reason: { code: 'SYNC_DECISION_ACTIVE', message: '当前细化仍在执行' } } }
  assert.equal(syncProjection(inFlight, 'enabled').canDecide, false)
  for (const phase of ['failed', 'budget_exhausted', 'conflicted', 'needs_input', 'superseded']) {
    const qualified = { ...inFlight, operation: { ...inFlight.operation, phase }, attempt: { status: 'failed' }, decisionEligibility: { eligible: true } }
    assert.equal(syncProjection(qualified, 'enabled').canDecide, true, phase)
    assert.equal(syncProjection({ ...qualified, stale: true }, 'enabled').canDecide, false)
    assert.equal(syncProjection({ ...qualified, executionAvailability: { status: 'recovery_required' } }, 'enabled').canDecide, false)
    assert.equal(syncProjection(qualified, 'invalidated').canDecide, false)
  }
})

test('only a settled current receipt projects delivery completion and its actual tree', () => {
  const view = syncProjection(detail)
  assert.equal(view.complete, true)
  assert.equal(view.state, 'workspace_synced')
  assert.equal(view.deliveryRoot, '/repo/published')
  assert.notEqual(view.deliveryRoot, operation.deliveryPlan.canonicalRoot)
  assert.equal(syncProjection({ ...detail, sourceSynced: true }).state, 'source_synced')
  const canonical = syncProjection({ ...detail, operation: { ...operation, phase: 'canonical_synced' }, sourceSynced: true, canonicalSynced: true })
  assert.equal(canonical.state, 'canonical_synced')
  assert.equal(canonical.canonicalSynced, true)
  assert.equal(canonical.sourceSynced, true)
})

test('grouped revert eligibility follows the backend and remains available for later source edits', () => {
  const eligible = { ...detail, stale: true, revertEligibility: { eligible: true } }
  assert.equal(syncProjection(eligible, 'enabled').canRevert, true)
  assert.equal(syncProjection({ ...eligible, executionAvailability: { status: 'recovery_required' } }, 'enabled').canRevert, false)
  assert.equal(syncProjection(eligible, 'invalidated').canRevert, false)
  assert.equal(syncProjection({ ...detail, revertEligibility: { eligible: false, reason: { code: 'SYNC_REVERT_NOT_LANDED', message: 'Not landed' } } }, 'enabled').canRevert, false)
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
    return new Response(JSON.stringify({ settings: { input: source }, operations: [], observation: {}, sources: [] }), { status: 200 })
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

test('automatic intake controls use the physical pause/resume API and preserve scoped errors', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url, 'http://test'), init })
    if (requests.length === 1) return new Response(JSON.stringify({ health: { status: 'watching', watchOnline: true }, control: { control: 'pause' } }), { status: 200 })
    return new Response(JSON.stringify({ code: 'SYNC_CONTROL_CONFLICT', error: 'Physical control changed' }), { status: 409 })
  }
  try {
    const result = await automaticControl('pause', '/source tree')
    assert.equal(result.control.control, 'pause')
    assert.equal(requests[0].url.pathname, '/api/sync/automatic/pause')
    assert.equal(requests[0].url.searchParams.get('targetTree'), '/source tree')
    assert.deepEqual(JSON.parse(requests[0].init.body), {})
    await assert.rejects(automaticControl('resume', '/source tree'), error => error.code === 'SYNC_CONTROL_CONFLICT' && error.message === 'Physical control changed')
    assert.equal(requests[1].url.pathname, '/api/sync/automatic/resume')
  } finally { globalThis.fetch = originalFetch }
})

test('revert and writer-stop transports preserve request identity, source scope, and response facts', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url, 'http://test'), init })
    if (requests.length === 1) return new Response(JSON.stringify({ code: 'SYNC_BUSY', error: 'Another request is pending' }), { status: 409 })
    if (requests.length === 2) return new Response(JSON.stringify({ changed: true, operation: { id: 'revert-op' } }), { status: 200 })
    return new Response(JSON.stringify({ stopped: true, control: { control: 'pause', revision: 4 }, operations: [detail] }), { status: 200 })
  }
  try {
    await assert.rejects(revertSync('operation one', 'stable-revert-id'), error => error.code === 'SYNC_BUSY')
    const result = await revertSync('operation one', 'stable-revert-id')
    assert.equal(result.operation.id, 'revert-op')
    assert.equal(requests[0].url.pathname, '/api/sync/operations/operation%20one/revert')
    assert.deepEqual(JSON.parse(requests[0].init.body), { requestId: 'stable-revert-id' })
    assert.deepEqual(JSON.parse(requests[1].init.body), { requestId: 'stable-revert-id' })

    const stopped = await stopSyncWriter('/source tree')
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.control.control, 'pause')
    assert.equal(requests[2].url.pathname, '/api/sync/stop-writer')
    assert.deepEqual(JSON.parse(requests[2].init.body), { targetTree: '/source tree' })
  } finally { globalThis.fetch = originalFetch }
})

test('incomplete status responses become retryable read errors instead of fake offline status', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ settings: { input: source }, operations: [] }), { status: 200 })
  try {
    await assert.rejects(readSyncStatus('alpha'), error => error.code === 'sync_response_invalid')
    globalThis.fetch = async () => new Response(JSON.stringify({ settings: { input: source }, operations: [{ operation }], observation: {}, sources: [] }), { status: 200 })
    await assert.rejects(readSyncStatus('alpha'), error => error.code === 'sync_response_invalid')
  } finally { globalThis.fetch = originalFetch }
})

test('observer projection distinguishes live health, physical control, project coverage, and the latest node baseline', () => {
  const sources = [
    { source: { canonicalRoot: '/repo/source', branch: 'feature' }, exists: true, watchOnline: true, health: { status: 'watching' }, control: { control: 'pause' }, registeredNodeIds: ['alpha'], latest: { observedAtMs: 88, outcome: 'admitted', reason: null } },
    { source: { canonicalRoot: '/repo/other', branch: 'other' }, exists: true, watchOnline: false, health: { status: 'watching' }, control: { control: 'run' }, registeredNodeIds: ['beta'], latest: null },
    { source: { canonicalRoot: '/repo/missing', branch: 'gone' }, exists: false, watchOnline: false, health: { status: 'stopped' }, control: { control: 'pause' }, registeredNodeIds: ['gone'], latest: null },
  ]
  const observation = {
    health: { status: 'watching', watchOnline: true, reason: null, lastScanAtMs: 123 },
    persistedHealth: { status: 'watching', updatedAtMs: 999 },
    control: { control: 'pause' },
    registeredNodes: ['alpha'],
    coverage: { includedNodeIds: ['alpha', 'child'], contextNodeIds: ['parent'], missingNodeIds: ['gone'], excludedNodeIds: ['parent', 'other'], totalNodeCount: 5 },
    latestDifference: { nodeId: 'alpha' },
    latest: {
      outcome: 'blocked', reason: { code: 'BASELINE_REVIEW', message: 'A decision is required' },
      selection: { bindings: [
        { resource: { kind: 'path', path: 'src/a.js' }, bytePair: { id: 'pair-a' } },
        { resource: { kind: 'contract', id: 'REQ-1' }, intentPair: null },
      ] },
    },
  }
  const projection = syncObserverProjection(observation, sources)
  assert.equal(projection.healthStatus, 'watching')
  assert.equal(projection.watchOnline, true)
  assert.equal(projection.lastScanAtMs, 123)
  assert.equal(projection.control, 'pause')
  assert.deepEqual(projection.coverage.includedNodeIds, ['alpha', 'child'])
  assert.equal(projection.coverage.totalNodeCount, 5)
  assert.equal(projection.baseline.nodeId, 'alpha')
  assert.equal(projection.baseline.establishedCount, 1)
  assert.deepEqual(projection.baseline.missingResources, ['contract:REQ-1'])
  assert.equal(projection.latest.reason.code, 'BASELINE_REVIEW')
  assert.equal(projection.sources[0].healthStatus, 'watching')
  assert.equal(projection.sources[0].control, 'pause')
  assert.equal(projection.sources[1].healthStatus, 'identity_unconfirmed')
  assert.equal(projection.sources[2].healthStatus, 'missing')
  assert.equal(projection.sources[2].exists, false)
})

test('persisted watching and identity mismatch never project an online observer or a scan timestamp', () => {
  const projection = syncObserverProjection({
    health: { status: 'watching', watchOnline: false, reason: null, lastScanAtMs: null },
    persistedHealth: { status: 'watching', updatedAtMs: 456 },
    control: { control: 'run' },
    coverage: { includedNodeIds: [], contextNodeIds: [], missingNodeIds: [], excludedNodeIds: [], totalNodeCount: 0 },
    latest: { selection: null, reason: { code: 'SYNC_BASELINE_UNKNOWN', message: 'Baseline could not be read' } },
  })
  assert.equal(projection.healthStatus, 'identity_unconfirmed')
  assert.equal(projection.watchOnline, false)
  assert.equal(projection.lastScanAtMs, null)
  assert.equal(projection.coverage, null)
  assert.equal(projection.baseline.status, 'unavailable')
  assert.equal(projection.baseline.failure.code, 'SYNC_BASELINE_UNKNOWN')

  assert.equal(syncObserverProjection(null).healthStatus, 'unavailable')
  assert.equal(syncObserverProjection(null).watchOnline, false)
  assert.equal(syncObserverProjection(null).control, null)
})

test('observer projection preserves offline, degraded, missing, and invalidated health without marking the watcher online', () => {
  for (const status of ['offline', 'degraded', 'missing', 'invalidated']) {
    const projection = syncObserverProjection({
      health: { status, watchOnline: false, reason: { code: `observer_${status}`, message: 'Observer state is not healthy' }, lastScanAtMs: null },
    })

    assert.equal(projection.healthStatus, status)
    assert.equal(projection.watchOnline, false)
    assert.equal(projection.lastScanAtMs, null)
    assert.equal(projection.reason.code, `observer_${status}`)
  }
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

test('plain-text service failures preserve HTTP status and a bounded diagnosis', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(`Internal Server Error ${'x'.repeat(600)}`, { status: 500 })
  try {
    await assert.rejects(readSyncStatus('alpha'), (error) => error.code === 'http-error'
      && error.message.startsWith('HTTP 500: Internal Server Error') && error.message.length === 510)
  } finally { globalThis.fetch = originalFetch }
})

test('explicit terminal retries preserve their operation intent and origin without supplying a new patch', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ changed: true, operation }), { status: 200 })
  }
  try {
    await runSync('alpha', 'new-retry-id', '/source', { retryOf: 'failed-op', origin: 'spec' })
    await runSync('alpha', 'latest-input-id', '/source')
    assert.deepEqual(requests[0], { nodeId: 'alpha', requestId: 'new-retry-id', origin: 'spec', retryOf: 'failed-op' })
    assert.equal('patch' in requests[0], false)
    assert.equal('retryOf' in requests[1], false)
  } finally { globalThis.fetch = originalFetch }
})

test('retry controls require actual application eligibility rather than a terminal phase guess', () => {
  const failed = { ...detail, operation: { ...operation, phase: 'failed' } }
  assert.equal(syncProjection(failed).canRetry, false)
  const eligible = { ...failed, retryEligibility: { eligible: true } }
  assert.equal(syncProjection(eligible).canRetry, true)
  assert.equal(syncProjection({ ...eligible, stale: true }).canRetry, false)
  assert.equal(syncProjection(eligible, 'invalidated').canRetry, false)
  assert.equal(syncProjection({ ...eligible, executionAvailability: { status: 'recovery_required' } }).canRetry, false)
  assert.equal(syncProjection({ ...failed, retryEligibility: { eligible: false, reason: { code: 'SYNC_RESOURCE_UNSETTLED', message: 'Resources not settled' } } }).canRetry, false)
})

test('recovery acts only on actual unsettled resources or journals, without retrying an operation', async () => {
  const recovery = { ...detail, executionAvailability: { status: 'recovery_required' } }
  assert.equal(syncProjection(recovery).canRecover, false)
  assert.equal(syncProjection({ ...recovery, resources: [{ phase: 'unknown' }] }).canRecover, true)
  assert.equal(syncProjection({ ...recovery, journals: [{ ...settled, status: 'recovery_required' }] }).canRecover, true)
  assert.equal(syncProjection({ ...detail, resources: [{ phase: 'unknown' }] }).canRecover, false)
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, init) => {
    request = { url, body: JSON.parse(init.body) }
    return new Response(JSON.stringify(recovery), { status: 200 })
  }
  try {
    await controlSync('recoverable-op', 'recover', '/source')
    assert.equal(request.url, '/api/sync/operations/recoverable-op/recover?targetTree=%2Fsource')
    assert.deepEqual(request.body, {})
  } finally { globalThis.fetch = originalFetch }
})

test('pending request evidence preserves user intent and its actual path without exposing object internals', () => {
  const request = evidenceProjection({ schemaVersion: 1, path: '.spec/alpha/spec.md', origin: { kind: 'user_edit', nodeId: 'alpha', requestId: 'request-id', intent: '把返回文本改为中文。' }, requestTree: 'private-tree', before: { oid: 'before' }, next: { oid: 'after' }, prompt: 'agent prompt' })
  assert.equal(request.origin.intent, '把返回文本改为中文。')
  assert.equal(request.path, '.spec/alpha/spec.md')
  assert.equal('requestTree' in request, false)
  assert.equal('prompt' in request, false)
})

test('requested body diffs preserve request kind and node path before any candidate exists', async () => {
  const originalFetch = globalThis.fetch
  let requested
  globalThis.fetch = async (url) => {
    requested = new URL(url, 'http://test')
    return new Response(JSON.stringify({ path: '.spec/alpha/spec.md', kind: 'request', baseTree: 'input', candidateTree: 'request', delivered: false, patch: '+中文需求' }), { status: 200 })
  }
  try {
    const value = await readSyncDiff('pending-op', '.spec/alpha/spec.md', 'request', '/source')
    assert.equal(requested.searchParams.get('kind'), 'request')
    assert.equal(requested.searchParams.get('targetTree'), '/source')
    assert.equal(value.delivered, false)
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


test('an invalidated activation cannot reuse an old settled receipt as current synchronization', () => {
  const view = syncProjection(detail, 'invalidated')
  assert.equal(view.complete, false)
  assert.equal(view.state, 'invalidated')
  assert.equal(view.deliveryRoot, '/repo/published')
})


test('business decision transport binds original input, analysis and selected findings without retry or body edits', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(url, 'http://test'), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ changed: true, operation }), { status: 200 })
  }
  try {
    const input = { requestId: 'stable-decision', inputId: 'original-input', analysisRef: { sha256: 'a'.repeat(64) }, findingIds: ['conflict-1'], decision: { choice: 'keep_intent' } }
    await decideSync('original operation', input, '/source')
    await decideSync('original operation', input, '/source')
    assert.equal(requests[0].url.pathname, '/api/sync/operations/original%20operation/decide')
    assert.equal(requests[0].url.searchParams.get('targetTree'), '/source')
    assert.deepEqual(requests[0].body, input)
    assert.deepEqual(requests[0].body, requests[1].body)
    assert.equal('retryOf' in requests[0].body, false)
    assert.equal('patch' in requests[0].body, false)
    const projected = evidenceProjection({ type: 'sync.decision', decision: { choice: 'new_rule', rule: '明确新规则' }, findingIds: ['conflict-1'], operationId: 'original', prompt: 'private' })
    assert.equal(projected.decision.rule, '明确新规则')
    assert.deepEqual(projected.findingIds, ['conflict-1'])
    assert.equal('prompt' in projected, false)
  } finally { globalThis.fetch = originalFetch }
})
