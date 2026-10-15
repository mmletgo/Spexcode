import { createHash } from 'node:crypto'
import type { SyncOperation, SyncDispatchEnvelope } from './operation-types.js'
import { applyComponentMigrations, type ComponentMigration, type SessionProtocol } from '@spexcode/session-protocol'

export const SYNC_COMPONENT = 'spec-sync'
export const SYNC_COORDINATOR_ADDRESS = 'spec-sync-coordinator'
export const syncCoordinatorAddress = (repositoryId: string): string => `spec-sync-coordinator-${createHash('sha256').update(repositoryId).digest('hex')}`
export const syncSemanticDigest = (input: Pick<SyncOperation, 'input' | 'origin' | 'requestBlob' | 'policyDigest' | 'scope' | 'retryOf' | 'baselineSelection'>): string => createHash('sha256').update(JSON.stringify({ inputId: input.input.id, source: input.input.source, origin: input.origin, requestBlob: input.requestBlob?.sha256 ?? null, policyDigest: input.policyDigest, paths: [...new Set(input.scope.paths)].sort(), ...(input.baselineSelection ? { baselineSelectionDigest: input.baselineSelection.digest, contractIds: [...new Set(input.scope.contractIds)].sort(), flowIds: [...new Set(input.scope.flowIds)].sort() } : {}), retryOf: input.retryOf ?? null }, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
export const SYNC_MIGRATIONS: readonly ComponentMigration[] = [{ version: 1, sql: `
CREATE TABLE sync_operations (
 id TEXT PRIMARY KEY, ingress_key TEXT NOT NULL UNIQUE, ingress_aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(ingress_aliases_json)), payload_digest TEXT NOT NULL UNIQUE,
 repository_id TEXT NOT NULL, source_key TEXT NOT NULL, source_root TEXT NOT NULL,
 generation INTEGER NOT NULL, phase TEXT NOT NULL, control TEXT NOT NULL,
 current_attempt_id TEXT, updated_at_ms INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX sync_operations_recovery ON sync_operations(phase,updated_at_ms);
CREATE INDEX sync_operations_source ON sync_operations(repository_id,source_root,generation);
CREATE TABLE sync_attempts (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES sync_operations(id), number INTEGER NOT NULL,
 generation INTEGER NOT NULL, dispatch_key TEXT NOT NULL UNIQUE, session_create_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 UNIQUE(operation_id,number)
) STRICT;
CREATE INDEX sync_attempts_recovery ON sync_attempts(status,expires_at_ms);
CREATE TABLE sync_leases (
 repository_id TEXT NOT NULL, resource_key TEXT NOT NULL, generation INTEGER NOT NULL,
 token TEXT, operation_id TEXT REFERENCES sync_operations(id), attempt_id TEXT REFERENCES sync_attempts(id),
 expires_at_ms INTEGER, PRIMARY KEY(repository_id,resource_key)
) STRICT;
CREATE INDEX sync_leases_owner ON sync_leases(token);
CREATE TABLE sync_apply_journals (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES sync_operations(id), attempt_id TEXT NOT NULL REFERENCES sync_attempts(id),
 effect_key TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL, status TEXT NOT NULL,
 receipt_id TEXT UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX sync_apply_journals_recovery ON sync_apply_journals(status);
CREATE TABLE sync_baseline_pairs (
 id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, source_key TEXT NOT NULL,
 receipt_id TEXT NOT NULL REFERENCES sync_apply_journals(receipt_id), settled_at_ms INTEGER NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX sync_baseline_pairs_source ON sync_baseline_pairs(repository_id,source_key,settled_at_ms);
` }, { version: 2, sql: `
CREATE TABLE sync_resources (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES sync_operations(id),
 attempt_id TEXT NOT NULL REFERENCES sync_attempts(id), generation INTEGER NOT NULL,
 resource_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('verification','native_session')),
 input_id TEXT NOT NULL, candidate_digest TEXT, payload_digest TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('planned','created','terminal','removed')),
 checkpoint_sha TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(attempt_id,resource_key)
) STRICT;
CREATE INDEX sync_resources_recovery ON sync_resources(operation_id,attempt_id) WHERE phase!='removed';
` }, { version: 3, sql: 'SELECT 1; -- requestBlob is an optional immutable user-input reference in operation record_json; old writers must refuse this component version.' }, { version: 4, sql: 'SELECT 1; -- planBlob pins the immutable policy bytes in operation record_json; old writers must refuse this component version.' }, { version: 5, sql: 'SELECT 1; -- origin participates in admission identity; dispatch is routed to repository-scoped protocol addresses.', afterApply: { key: 'spec-sync-repository-dispatch-v1', run(tx) {
  const pending = tx.query('SELECT message_id,kind,body,headers_json,sender_session_id,protocol_version FROM protocol_messages WHERE target_session_id=? AND dequeued_at_ms IS NULL ORDER BY enqueue_seq', SYNC_COORDINATOR_ADDRESS)
  for (const row of pending) {
    const envelope = JSON.parse(Buffer.from(row.body as Uint8Array).toString('utf8')) as SyncDispatchEnvelope
    const stored = tx.query('SELECT repository_id,record_json FROM sync_operations WHERE id=?', envelope.operationId)[0]
    if (!stored) throw new Error('SYNC_DISPATCH_BINDING: legacy operation missing')
    const operation = JSON.parse(String(stored.record_json)) as SyncOperation
    if (row.kind !== 'sync.dispatch.v1' || envelope.version !== 1 || envelope.type !== 'sync.dispatch' || operation.dispatchMessageId !== row.message_id || envelope.inputId !== operation.input.id || stored.repository_id !== operation.input.source.repositoryId) throw new Error('SYNC_DISPATCH_BINDING: legacy dispatch differs from operation')
    const address = syncCoordinatorAddress(operation.input.source.repositoryId)
    tx.initialize(address)
    tx.dequeue(SYNC_COORDINATOR_ADDRESS, String(row.message_id))
    const migrated = tx.enqueue(address, { kind: String(row.kind), body: row.body as Uint8Array, headers: JSON.parse(String(row.headers_json)) as Record<string,string>, senderSessionId: row.sender_session_id === null ? null : String(row.sender_session_id), protocolVersion: Number(row.protocol_version), idempotencyKey: `sync-route-v5-${row.message_id}` })
    operation.dispatchMessageId = migrated.messageId; operation.revision++
    tx.exec('UPDATE sync_operations SET record_json=? WHERE id=?', JSON.stringify(operation), operation.id)
  }
} } }, { version: 6, sql: `ALTER TABLE sync_operations ADD COLUMN semantic_digest TEXT;
CREATE INDEX sync_operations_semantic ON sync_operations(semantic_digest);`, afterApply: { key: 'spec-sync-semantic-admission-v1', run(tx) {
  for (const row of tx.query('SELECT id,record_json FROM sync_operations')) {
    const operation = JSON.parse(String(row.record_json)) as SyncOperation
    tx.exec('UPDATE sync_operations SET semantic_digest=? WHERE id=?', syncSemanticDigest(operation), operation.id)
  }
} } }, { version: 7, sql: `ALTER TABLE sync_operations ADD COLUMN normalized_semantic_digest TEXT;
CREATE INDEX sync_operations_normalized_semantic ON sync_operations(normalized_semantic_digest);
CREATE TABLE sync_ingress_receipts (
 ingress_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES sync_operations(id),
 payload_digest TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;` }, { version: 8, sql: 'SELECT 1; -- P3 behavior authorization, scoped decision history and retired IDs require this writer generation; old writers must refuse.' }, { version: 9, sql: 'SELECT 1; -- P3 exact structured decision authority and stable post-settlement decision identity require this writer generation.' }, { version: 10, sql: `
CREATE TABLE sync_observer_health (scope_key TEXT PRIMARY KEY, record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT;
CREATE TABLE sync_physical_controls (scope_key TEXT PRIMARY KEY, record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT;
CREATE TABLE sync_baseline_heads (source_key TEXT NOT NULL, resource_key TEXT NOT NULL, pair_id TEXT REFERENCES sync_baseline_pairs(id), legacy_reason TEXT, PRIMARY KEY(source_key,resource_key)) STRICT;
CREATE TABLE sync_observations (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, operation_id TEXT REFERENCES sync_operations(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT;
`, afterApply: { key: 'spec-sync-resource-frontier-v1', run(tx) {
  const pairs = tx.query('SELECT record_json FROM sync_baseline_pairs').map(row => JSON.parse(String(row.record_json)) as import('./operation-types.js').BaselinePair)
  const journals = tx.query('SELECT record_json FROM sync_apply_journals').map(row => JSON.parse(String(row.record_json)) as import('./operation-types.js').ApplyJournal)
  const operations = tx.query('SELECT record_json FROM sync_operations').map(row => JSON.parse(String(row.record_json)) as SyncOperation)
  for (const journal of journals) {
    const attempt = tx.query('SELECT operation_id,generation FROM sync_attempts WHERE id=?', journal.attemptId)[0]
    if (!attempt || attempt.operation_id !== journal.operationId || Number(attempt.generation) !== journal.generation || !operations.some(operation => operation.id === journal.operationId)) throw new Error('SYNC_MIGRATION_RECOVERY_INVALID: frozen journal has no matching operation/attempt generation')
  }
  const stable = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)).digest('hex')
  const pairById = new Map(pairs.map(pair => [pair.id, pair]))
  const operationById = new Map(operations.map(operation => [operation.id, operation]))
  const settledByReceipt = new Map(journals.flatMap(journal => journal.status === 'settled' && journal.receipt ? [[journal.receipt.id, journal] as const] : []))
  const causalScopes = (pair: typeof pairs[number]): import('./operation-types.js').SyncScope[] => {
    const sourceKey = stable(pair.source), scopes: import('./operation-types.js').SyncScope[] = [], seen = new Set<string>()
    const visit = (current: typeof pair): void => {
      if (seen.has(current.id) || stable(current.source) !== sourceKey) return
      seen.add(current.id)
      const journal = settledByReceipt.get(current.receiptId)
      if (!journal) return
      const operation = operationById.get(journal.operationId)!
      scopes.push(current.coveredScope, operation.scope)
      const prior = operation.previousBaselinePair ? pairById.get(operation.previousBaselinePair.id) : undefined
      if (prior) for (const ancestor of pairs) if (ancestor.receiptId === prior.receiptId && stable(ancestor.source) === sourceKey) visit(ancestor)
    }
    visit(pair)
    return scopes
  }
  const uncertain = new Map<string, { sourceKey: string; resourceKey: string; reason: string }>()
  const groups = new Map<string, { sourceKey: string; resourceKey: string; pairs: typeof pairs }>()
  for (const pair of pairs) {
    const journal = journals.find(item => item.receipt?.id === pair.receiptId && item.status === 'settled')
    const sourceKey = stable(pair.source)
    if (!journal) {
      for (const resourceKey of [...pair.coveredScope.paths.map(path => `path:${path}`), ...pair.coveredScope.contractIds.map(id => `contract:${id}`), ...pair.coveredScope.flowIds.map(id => `flow:${id}`)]) uncertain.set(`${sourceKey}:${resourceKey}`, { sourceKey, resourceKey, reason: 'P3 history has no settled journal proving actual resource delivery' })
      continue
    }
    const kindScopes = causalScopes(pair)
    const retiredKeys = (pair.retiredIds ?? []).filter(id => !operations.find(item => item.id === journal.operationId)?.previousBaselinePair?.retiredIds?.includes(id)).flatMap(id => {
      const keys = [...(kindScopes.some(scope => scope.flowIds.includes(id)) ? [`flow:${id}`] : []), ...(kindScopes.some(scope => scope.contractIds.includes(id)) ? [`contract:${id}`] : [])]
      if (keys.length) return keys
      for (const resourceKey of [`flow:${id}`, `contract:${id}`]) uncertain.set(`${sourceKey}:${resourceKey}`, { sourceKey, resourceKey, reason: 'P3 retirement kind has no covered scope evidence' })
      return []
    })
    const keys = [...journal.plan.files.map(file => `path:${file.path}`), ...pair.coveredScope.contractIds.map(id => `contract:${id}`), ...pair.coveredScope.flowIds.map(id => `flow:${id}`), ...retiredKeys]
    for (const resourceKey of new Set(keys)) {
      const key = `${sourceKey}:${resourceKey}`, group = groups.get(key) ?? { sourceKey, resourceKey, pairs: [] }
      group.pairs.push(pair); groups.set(key, group)
    }
  }
  const predecessors = (pair: typeof pairs[number]): string[] => {
    const journal = journals.find(item => item.receipt?.id === pair.receiptId), operation = operations.find(item => item.id === journal?.operationId)
    const prior = operation?.previousBaselinePair?.id
    return prior ? [prior] : []
  }
  const follows = (later: typeof pairs[number], earlier: typeof pairs[number], seen = new Set<string>()): boolean => {
    if (seen.has(later.id)) return false
    seen.add(later.id)
    for (const id of predecessors(later)) {
      const prior = pairs.find(item => item.id === id)
      if (id === earlier.id || prior?.receiptId === earlier.receiptId || prior && follows(prior, earlier, seen)) return true
    }
    return false
  }
  for (const group of groups.values()) {
    const candidates = group.pairs.filter(pair => !group.pairs.some(other => other.id !== pair.id && follows(other, pair)))
    const receiptGroups = new Map<string, typeof pairs>()
    for (const pair of candidates) receiptGroups.set(pair.receiptId, [...(receiptGroups.get(pair.receiptId) ?? []), pair])
    const byReceipt = [...receiptGroups.values()].flatMap(group => {
      if (group.length === 1) return group
      const publication = group.filter(pair => pair.sourceInput.id === pair.verifiedDelivery.id && stable(pair.source) === stable(pair.verifiedDelivery.source))
      return publication.length === 1 ? publication : group
    })
    tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,?,?)', group.sourceKey, group.resourceKey, byReceipt.length === 1 ? byReceipt[0].id : null, byReceipt.length === 1 ? null : 'P3 frontier order cannot be proven by frozen predecessor chain')
  }
  for (const entry of uncertain.values()) tx.exec('INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) VALUES(?,?,NULL,?) ON CONFLICT(source_key,resource_key) DO UPDATE SET legacy_reason=excluded.legacy_reason', entry.sourceKey, entry.resourceKey, entry.reason)
} } }, { version: 11, sql: 'SELECT 1; -- Grouped immutable history requests require this writer generation; old writers must refuse without discarding request authority.' }, { version: 12, sql: 'SELECT 1; -- Exact historical identity restoration and current per-ID retirement heads require this writer generation.' }]

/** 升级前以 SQLite online backup 保存一致性旧库；迁移本身由组件事务执行。 */
export async function migrateSyncStore(protocol: SessionProtocol, options: { backupPath?: string } = {}): Promise<number> {
  const version = protocol.withTransaction(tx => Number(tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT)[0].version ?? 0))
  if (version > SYNC_MIGRATIONS.length) throw new Error(`SYNC_SCHEMA_UNSUPPORTED: generation ${version}`)
  if (version < SYNC_MIGRATIONS.length) {
    await protocol.backupTo(options.backupPath ?? `${protocol.databasePath}.spec-sync-v${version}-${Date.now()}.backup`)
  }
  return applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS)
}
