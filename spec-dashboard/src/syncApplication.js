import { apiFetch, readScopeUrl } from './data.js'

const syncRead = async (path, targetTree, init) => {
  const response = await apiFetch(readScopeUrl(`/api/sync/${path}`, targetTree), init)
  const text = await response.text()
  let body
  try { body = JSON.parse(text) }
  catch (failure) {
    if (response.ok) throw failure
    const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500) || response.statusText}`)
    error.code = 'http-error'
    throw error
  }
  if (!response.ok) {
    const error = new Error(body.error || `${response.status} ${response.statusText}`)
    error.code = body.code || 'http-error'
    throw error
  }
  return body
}
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const readSyncStatus = async (nodeId, targetTree = null, signal) => {
  const value = await syncRead(`status?${new URLSearchParams({ nodeId, limit: '8' })}`, targetTree, { signal, cache: 'no-store' })
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !value.settings || typeof value.settings !== 'object'
    || !value.settings.input || typeof value.settings.input !== 'object'
    || typeof value.settings.input.canonicalRoot !== 'string'
    || !Array.isArray(value.operations) || !value.operations.every(item => item?.operation)
    || !value.observation || typeof value.observation !== 'object'
    || !Array.isArray(value.sources)
    || !value.sources.every(source => source?.source && typeof source.source === 'object')) {
    const error = new Error('同步状态响应缺少必需的观察数据')
    error.code = 'sync_response_invalid'
    throw error
  }
  return value
}
export const enableSync = (configDigest, targetTree = null) => syncRead('settings', targetTree, post({ expectedConfigDigest: configDigest }))
export const automaticControl = (action, targetTree = null) => syncRead(`automatic/${action}`, targetTree, post({}))
export const runSync = (nodeId, requestId, targetTree = null, options = {}) => syncRead('run', targetTree, post({ nodeId, requestId, origin: options.origin || 'initial', ...(options.retryOf ? { retryOf: options.retryOf } : {}) }))
export const decideSync = (id, input, targetTree = null) => syncRead(`operations/${encodeURIComponent(id)}/decide`, targetTree, post(input))
export const controlSync = (id, action, targetTree = null) => syncRead(`operations/${encodeURIComponent(id)}/${action}`, targetTree, post({}))
export const readSyncDiff = (id, path, kind, targetTree = null, signal) => syncRead(`operations/${encodeURIComponent(id)}/diff?${new URLSearchParams({ path, kind })}`, targetTree, { signal })
export const readSyncEvidence = (id, hash, targetTree = null, signal) => syncRead(`operations/${encodeURIComponent(id)}/evidence/${encodeURIComponent(hash)}`, targetTree, { signal })

// This is a display projection of facts returned by the observer, not a second sync state machine.
export function syncObserverProjection(observation, sourceWorktrees = null) {
  const health = observation?.health ?? null
  const healthStatuses = ['offline', 'starting', 'watching', 'degraded', 'missing', 'invalidated']
  const identityUnconfirmed = health?.status === 'watching' && health.watchOnline !== true
  const healthStatus = !health || !healthStatuses.includes(health.status)
    ? 'unavailable'
    : identityUnconfirmed ? 'identity_unconfirmed' : health.status
  const coverageValue = observation?.coverage
  const coverage = Number.isFinite(health?.lastScanAtMs) && coverageValue
    && Array.isArray(coverageValue.includedNodeIds)
    && Array.isArray(coverageValue.contextNodeIds)
    && Array.isArray(coverageValue.missingNodeIds)
    && Array.isArray(coverageValue.excludedNodeIds)
    && Number.isInteger(coverageValue.totalNodeCount)
    ? coverageValue
    : null
  const controlValue = observation?.control?.control
  const control = controlValue === 'run' || controlValue === 'pause' ? controlValue : null
  const latest = observation?.latest ?? null
  const differenceNodeId = typeof observation?.latestDifference?.nodeId === 'string'
    ? observation.latestDifference.nodeId
    : null
  let baseline = null
  if (latest) {
    const bindings = latest.selection?.bindings
    if (!Array.isArray(bindings)) {
      baseline = { status: 'unavailable', nodeId: differenceNodeId, failure: latest.reason ?? latest.failure ?? null }
    } else {
      const missingResources = bindings.flatMap((binding) => {
        const pair = binding.resource.kind === 'path' ? binding.bytePair : binding.intentPair
        if (pair) return []
        const resource = binding.resource
        return [resource.kind === 'path' ? resource.path : `${resource.kind}:${resource.id}`]
      })
      baseline = {
        status: 'available',
        nodeId: differenceNodeId,
        resourceCount: bindings.length,
        establishedCount: bindings.length - missingResources.length,
        missingResources,
      }
    }
  }
  const sources = Array.isArray(sourceWorktrees) ? sourceWorktrees.map((source) => {
    const sourceHealth = source.health
    const sourceIdentityUnconfirmed = sourceHealth?.status === 'watching'
      && source.watchOnline !== true
    const sourceHealthStatus = source.exists === false
      ? 'missing'
      : sourceHealth?.status === 'stopped'
        ? 'offline'
      : !sourceHealth || !healthStatuses.includes(sourceHealth.status)
        ? 'unavailable'
        : sourceIdentityUnconfirmed ? 'identity_unconfirmed'
          : source.watchOnline === true && sourceHealth.status === 'watching' ? 'watching' : sourceHealth.status
    const sourceControl = source.control?.control
    return {
      root: typeof source.source?.canonicalRoot === 'string' ? source.source.canonicalRoot : null,
      branch: typeof source.source?.branch === 'string' ? source.source.branch : null,
      exists: source.exists === true ? true : source.exists === false ? false : null,
      healthStatus: sourceHealthStatus,
      control: sourceControl === 'run' || sourceControl === 'pause' ? sourceControl : null,
      registeredNodes: Array.isArray(source.registeredNodeIds) ? source.registeredNodeIds : null,
      latest: source.latest ? {
        observedAtMs: Number.isFinite(source.latest.observedAtMs) ? source.latest.observedAtMs : null,
        outcome: source.latest.outcome ?? null,
        reason: source.latest.reason ?? null,
      } : null,
    }
  }) : null
  return {
    healthStatus,
    watchOnline: health?.status === 'watching' && health.watchOnline === true,
    reason: health?.reason ?? null,
    lastScanAtMs: Number.isFinite(health?.lastScanAtMs) ? health.lastScanAtMs : null,
    control,
    coverage,
    registeredNodes: Array.isArray(observation?.registeredNodes) ? observation.registeredNodes : null,
    latest,
    baseline,
    sources,
  }
}

// One user submission retains its identity across retries; a changed payload is a new submission.
export function requestIdentity(previous, payload, makeId = () => crypto.randomUUID()) {
  const encoded = JSON.stringify(payload)
  return previous?.payload === encoded ? previous : { payload: encoded, id: makeId() }
}

const COMPLETED = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced'])
const TERMINAL = new Set(['cancelled', 'superseded', 'failed', 'budget_exhausted', ...COMPLETED])
export function syncProjection(detail, activation) {
  const { operation, attempt, journals, resources, stale, sourceSynced, executionAvailability } = detail
  const settled = journals.findLast((journal) => journal.status === 'settled' && journal.receipt
    && journal.generation === operation.generation && journal.attemptId === operation.currentAttemptId)
  const recovery = executionAvailability.status === 'recovery_required'
  const complete = !!settled && activation !== 'invalidated' && !stale && !recovery && COMPLETED.has(operation.phase)
  const state = recovery ? 'recovery_required' : activation === 'invalidated' ? 'invalidated' : stale ? 'stale'
    : complete ? sourceSynced ? 'source_synced' : 'workspace_synced'
      : COMPLETED.has(operation.phase) ? 'unsettled' : operation.phase
  return {
    state, complete, receipt: settled?.receipt || null, settledJournal: settled || null,
    deliveryRoot: settled?.receipt.deliverySnapshot.source.canonicalRoot || null,
    sourceRoot: operation.input.source.canonicalRoot,
    failure: recovery ? executionAvailability.failure : attempt?.failure,
    canRetry: !recovery && !stale && activation !== 'invalidated' && detail.retryEligibility?.eligible === true,
    canDecide: !recovery && !stale && activation !== 'invalidated' && detail.decisionEligibility.eligible,
    canRecover: recovery && (resources.length > 0 || journals.some((journal) => journal.status !== 'settled')),
    canPause: !recovery && !TERMINAL.has(operation.phase) && !['paused', 'pausing', 'cancelling'].includes(operation.phase),
    canResume: !recovery && operation.phase === 'paused',
    canCancel: !recovery && !TERMINAL.has(operation.phase) && !['cancelled', 'cancelling'].includes(operation.phase),
  }
}

// Evidence is read on demand and summarized as business diagnostics, never as an agent prompt dump.
export function evidenceProjection(value) {
  if (Array.isArray(value)) return value.map((item) => Object.fromEntries(['path', 'preDigest', 'postDigest', 'preMode', 'postMode'].filter((field) => item[field] != null).map((field) => [field, item[field]])))
  const result = {}
  for (const key of ['version', 'schemaVersion', 'status', 'verdict', 'structurePassed', 'reviewPassed', 'coveredScope', 'blockedIds', 'readyIds', 'blockedFlows', 'layers', 'readPaths', 'writePaths']) {
    if (value[key] != null) result[key] = value[key]
  }
  for (const key of ['gaps', 'findings', 'blockedStructureFindings', 'deferredImplementationFindings']) {
    if (Array.isArray(value[key])) result[key] = value[key].map((item) => Object.fromEntries(
      ['id', 'kind', 'code', 'message', 'unknown', 'evidence', 'decision', 'affectedIds', 'nodeIds', 'paths', 'originalIntent', 'sourceBehavior', 'deliveryBehavior', 'counterexample'].filter((field) => item[field] != null).map((field) => [field, item[field]])))
  }
  if (value.plan) result.plan = Object.fromEntries(['readPaths', 'writePaths', 'intentNodeId'].filter((field) => value.plan[field] != null).map((field) => [field, value.plan[field]]))
  if (value.type === 'sync.decision') { result.type = value.type; result.decision = value.decision; result.findingIds = value.findingIds; result.operationId = value.operationId }
  if (value.origin) result.origin = { kind: value.origin.kind, nodeId: value.origin.nodeId, intent: value.origin.intent }
  if (value.path) result.path = value.path
  if (value.failure) result.failure = { code: value.failure.code, message: value.failure.message }
  if (Array.isArray(value.changes)) result.changes = value.changes.map(({ path, nodeId, contentDigest }) => ({ path, nodeId, contentDigest }))
  if (Array.isArray(value.entries)) result.entries = value.entries.map(({ path, digest, mode, kind }) => ({ path, digest, mode, kind }))
  if (Array.isArray(value.files)) result.files = value.files.map(({ path, digest, mode, kind }) => ({ path, digest, mode, kind }))
  return result
}
