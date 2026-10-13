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
export const readSyncStatus = (nodeId, targetTree = null, signal) => syncRead(`status?${new URLSearchParams({ nodeId, limit: '8' })}`, targetTree, { signal, cache: 'no-store' })
export const enableSync = (configDigest, targetTree = null) => syncRead('settings', targetTree, post({ expectedConfigDigest: configDigest }))
export const runSync = (nodeId, requestId, targetTree = null, options = {}) => syncRead('run', targetTree, post({ nodeId, requestId, origin: options.origin || 'initial', ...(options.retryOf ? { retryOf: options.retryOf } : {}) }))
export const controlSync = (id, action, targetTree = null) => syncRead(`operations/${encodeURIComponent(id)}/${action}`, targetTree, post({}))
export const readSyncDiff = (id, path, kind, targetTree = null, signal) => syncRead(`operations/${encodeURIComponent(id)}/diff?${new URLSearchParams({ path, kind })}`, targetTree, { signal })
export const readSyncEvidence = (id, hash, targetTree = null, signal) => syncRead(`operations/${encodeURIComponent(id)}/evidence/${encodeURIComponent(hash)}`, targetTree, { signal })

// One user submission retains its identity across retries; a changed payload is a new submission.
export function requestIdentity(previous, payload, makeId = () => crypto.randomUUID()) {
  const encoded = JSON.stringify(payload)
  return previous?.payload === encoded ? previous : { payload: encoded, id: makeId() }
}

const COMPLETED = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced'])
const TERMINAL = new Set(['cancelled', 'superseded', 'failed', 'budget_exhausted', ...COMPLETED])
export function syncProjection(detail, activation) {
  const { operation, attempt, journals, stale, sourceSynced, executionAvailability } = detail
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
      ['id', 'kind', 'code', 'message', 'unknown', 'evidence', 'decision', 'affectedIds', 'nodeIds'].filter((field) => item[field] != null).map((field) => [field, item[field]])))
  }
  if (value.plan) result.plan = Object.fromEntries(['readPaths', 'writePaths', 'intentNodeId'].filter((field) => value.plan[field] != null).map((field) => [field, value.plan[field]]))
  if (value.failure) result.failure = { code: value.failure.code, message: value.failure.message }
  if (Array.isArray(value.changes)) result.changes = value.changes.map(({ path, nodeId, contentDigest }) => ({ path, nodeId, contentDigest }))
  if (Array.isArray(value.entries)) result.entries = value.entries.map(({ path, digest, mode, kind }) => ({ path, digest, mode, kind }))
  if (Array.isArray(value.files)) result.files = value.files.map(({ path, digest, mode, kind }) => ({ path, digest, mode, kind }))
  return result
}
