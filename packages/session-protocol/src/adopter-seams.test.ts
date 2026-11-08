import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyComponentMigrations, openProtocol, type ProtocolTransaction } from './index.js'

test('adopter claim and exact FIFO dequeue commit or roll back together', () => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-claim-'))
  const protocol = openProtocol(join(root, 'db.sqlite'))
  try {
    protocol.initialize('coordinator')
    protocol.withTransaction(tx => tx.exec('CREATE TABLE claims(id TEXT PRIMARY KEY) STRICT'))
    const first = protocol.enqueue('coordinator', { kind: 'adopter.control.v1', body: Buffer.from('one') })
    const second = protocol.enqueue('coordinator', { kind: 'adopter.control.v1', body: Buffer.from('two') })
    assert.throws(() => protocol.withTransaction(tx => {
      tx.exec('INSERT INTO claims VALUES(?)', 'wrong')
      tx.dequeue('coordinator', second.messageId)
    }), /FIFO head/)
    assert.equal(protocol.withTransaction(tx => tx.query('SELECT * FROM claims')).length, 0)
    assert.equal(protocol.listPending('coordinator').length, 2)
    protocol.withTransaction(tx => {
      tx.exec('INSERT INTO claims VALUES(?)', 'one')
      assert.equal(tx.dequeue('coordinator', first.messageId)?.messageId, first.messageId)
    })
    assert.equal(protocol.listPending('coordinator').length, 1)
  } finally { protocol.close(); rmSync(root, { recursive: true, force: true }) }
})

test('online backup is private from creation, preserves committed WAL bytes and opens independently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-backup-'))
  const protocol = openProtocol(join(root, 'db.sqlite'))
  try {
    protocol.initialize('coordinator')
    const message = protocol.enqueue('coordinator', { kind: 'adopter.control.v1', body: Buffer.from('durable') })
    const destination = join(root, 'backup.sqlite')
    const previousMask = process.umask(0)
    let creationMode: number | undefined
    try {
      const copying = protocol.backupTo(destination)
      creationMode = existsSync(destination) ? statSync(destination).mode & 0o777 : undefined
      await copying
    } finally { process.umask(previousMask) }
    assert.equal(creationMode, 0o600)
    assert.equal(statSync(destination).mode & 0o777, 0o600)
    const recovered = openProtocol(destination)
    try {
      assert.equal(recovered.listPending('coordinator')[0].messageId, message.messageId)
      assert.equal(recovered.withTransaction(tx => tx.query('PRAGMA integrity_check'))[0].integrity_check, 'ok')
    }
    finally { recovered.close() }
    const original = readFileSync(destination), mode = statSync(destination).mode
    await assert.rejects(protocol.backupTo(destination), { code: 'PROTOCOL_PATH_INVALID' })
    assert.deepEqual(readFileSync(destination), original)
    assert.equal(statSync(destination).mode, mode)
  } finally { protocol.close(); rmSync(root, { recursive: true, force: true }) }
})

test('checksummed synchronous migration callback initializes and routes atomically; failure and async callbacks roll back', () => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-migrate-route-')), protocol = openProtocol(join(root, 'db.sqlite'))
  try {
    protocol.initialize('old')
    const original = protocol.enqueue('old', { kind: 'adopter.control.v1', body: Buffer.from('durable') })
    const migration = (throws: boolean) => [{ version: 1, sql: 'CREATE TABLE route_pointer(message_id TEXT) STRICT;', afterApply: { key: 'route-v1', run(tx: ProtocolTransaction) {
      tx.initialize('new'); tx.dequeue('old', original.messageId)
      const routed = tx.enqueue('new', { kind: original.kind, body: original.body, idempotencyKey: 'stable-route' })
      tx.exec('INSERT INTO route_pointer VALUES(?)', routed.messageId)
      if (throws) throw new Error('callback-interrupted')
    } } }]
    assert.throws(() => applyComponentMigrations(protocol, 'route', migration(true)), /callback-interrupted/)
    assert.equal(protocol.listPending('old')[0].messageId, original.messageId)
    assert.equal(protocol.withTransaction(tx => tx.query("SELECT * FROM protocol_sessions WHERE session_id='new'")).length, 0)
    assert.equal(protocol.withTransaction(tx => tx.query("SELECT * FROM schema_migrations WHERE component='route'")).length, 0)
    assert.equal(applyComponentMigrations(protocol, 'route', migration(false)), 1)
    assert.equal(applyComponentMigrations(protocol, 'route', migration(false)), 1)
    assert.equal(protocol.listPending('new').length, 1); assert.equal(protocol.readMessages('old')[0].messageId, original.messageId)
    assert.throws(() => applyComponentMigrations(protocol, 'route', [{ ...migration(false)[0], afterApply: { ...migration(false)[0].afterApply, key: 'changed-v2' } }]), { code: 'PROTOCOL_SCHEMA_CHECKSUM_MISMATCH' })
    assert.throws(() => applyComponentMigrations(protocol, 'async-route', [{ version: 1, sql: 'SELECT 1;', afterApply: { key: 'async-v1', run: () => Promise.resolve() } }]), /synchronous/)
    assert.equal(protocol.withTransaction(tx => tx.query("SELECT * FROM schema_migrations WHERE component='async-route'")).length, 0)
  } finally { protocol.close(); rmSync(root, { recursive: true, force: true }) }
})
