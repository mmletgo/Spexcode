import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from './index.js'

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

test('online backup preserves committed WAL bytes and opens independently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-backup-'))
  const protocol = openProtocol(join(root, 'db.sqlite'))
  try {
    protocol.initialize('coordinator')
    const message = protocol.enqueue('coordinator', { kind: 'adopter.control.v1', body: Buffer.from('durable') })
    await protocol.backupTo(join(root, 'backup.sqlite'))
    const recovered = openProtocol(join(root, 'backup.sqlite'))
    try { assert.equal(recovered.listPending('coordinator')[0].messageId, message.messageId) }
    finally { recovered.close() }
    await assert.rejects(protocol.backupTo(join(root, 'backup.sqlite')), /new file/)
  } finally { protocol.close(); rmSync(root, { recursive: true, force: true }) }
})
