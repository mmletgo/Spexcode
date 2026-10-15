import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureInputSnapshot } from './snapshot.js'
import { readSyncLandingStatus } from './landing-status.js'
import type { ApplyJournal } from './operation-types.js'

test('真实FF采纳按当前闭包证明完成，无关提交保有效，feature分支不伪报主分支', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-landing-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Landing test'); git('config', 'user.email', 'landing@example.invalid')
  writeFileSync(join(root, 'code.ts'), 'base\n'); writeFileSync(join(root, 'config.json'), '{}\n'); git('add', '.'); git('commit', '-m', 'base')
  const input = await captureInputSnapshot(root)
  git('checkout', '-b', 'delivery'); writeFileSync(join(root, 'code.ts'), 'verified\n'); git('add', '.'); git('commit', '-m', 'delivery')
  const delivery = await captureInputSnapshot(root), scope = { paths: ['code.ts'], contractIds: ['REQ'], flowIds: [] }
  const operation = { input, phase: 'workspace_synced', blockedReason: null, blockedScope: { paths: [], contractIds: [], flowIds: [] }, scope, deliveredScope: scope } satisfies Parameters<typeof readSyncLandingStatus>[0]
  const journals = [{ status: 'settled', receipt: { actualCommit: delivery.headCommit, actualTree: delivery.immutableTree, deliverySnapshot: delivery } }] as ApplyJournal[]
  const options = { canonicalBranch: 'refs/heads/main', readPaths: ['config.json'] }
  assert.deepEqual(readSyncLandingStatus(operation, delivery, journals, options), { sourceSynced: true, canonicalSynced: false, actualCommit: delivery.headCommit, phase: 'workspace_synced' })
  git('checkout', 'main')
  assert.equal(readSyncLandingStatus(operation, await captureInputSnapshot(root), journals, options).sourceSynced, false)
  git('merge', '--ff-only', 'delivery')
  let current = await captureInputSnapshot(root)
  assert.notEqual(current.id, input.id)
  assert.equal(readSyncLandingStatus(operation, current, journals, options).phase, 'canonical_synced')
  writeFileSync(join(root, 'unrelated.txt'), 'later\n'); git('add', '.'); git('commit', '-m', 'unrelated')
  current = await captureInputSnapshot(root)
  assert.equal(readSyncLandingStatus(operation, current, journals, options).canonicalSynced, true)
  writeFileSync(join(root, 'code.ts'), 'later pending edit\n')
  assert.equal(readSyncLandingStatus(operation, await captureInputSnapshot(root), journals, options).sourceSynced, false)
  git('checkout', '--', 'code.ts'); writeFileSync(join(root, 'config.json'), '{"changed":true}\n'); git('add', 'config.json'); git('checkout', '--', 'config.json')
  assert.equal(readSyncLandingStatus(operation, await captureInputSnapshot(root), journals, options).sourceSynced, false)
  assert.equal(readSyncLandingStatus(operation, current, [{ ...journals[0], status: 'completed' }], options).sourceSynced, false)
  assert.equal(readSyncLandingStatus({ ...operation, blockedReason: 'conflicted' }, current, journals, options).sourceSynced, false)
})
