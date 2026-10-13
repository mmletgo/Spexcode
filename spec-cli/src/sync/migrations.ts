import { applyComponentMigrations, type ComponentMigration, type SessionProtocol } from '@spexcode/session-protocol'

export const SYNC_COMPONENT = 'spec-sync'
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
` }, { version: 3, sql: 'SELECT 1; -- requestBlob is an optional immutable user-input reference in operation record_json; old writers must refuse this component version.' }, { version: 4, sql: 'SELECT 1; -- planBlob pins the immutable policy bytes in operation record_json; old writers must refuse this component version.' }]

/** 升级前以 SQLite online backup 保存一致性旧库；迁移本身由组件事务执行。 */
export async function migrateSyncStore(protocol: SessionProtocol, options: { backupPath?: string } = {}): Promise<number> {
  const version = protocol.withTransaction(tx => Number(tx.query('SELECT MAX(version) AS version FROM schema_migrations WHERE component=?', SYNC_COMPONENT)[0].version ?? 0))
  if (version > SYNC_MIGRATIONS.length) throw new Error(`SYNC_SCHEMA_UNSUPPORTED: generation ${version}`)
  if (version < SYNC_MIGRATIONS.length) {
    await protocol.backupTo(options.backupPath ?? `${protocol.databasePath}.spec-sync-v${version}-${Date.now()}.backup`)
  }
  return applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS)
}
