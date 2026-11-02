import assert from 'node:assert/strict'
import fs, { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { SyncApplication, registerSourceContinuity } from './application.js'
import { captureInputSnapshot, contentHash, identifyRawWorktree, identifyWorktree, readPhysicalFingerprint, readRawSource } from './snapshot.js'
import { readEnabledRecord, readRegistrationEvidence, sourceRegistrationLock, sourceRegistrationPath, type SourceStat } from './source-registration.js'
import { readSyncSettings } from './settings.js'

async function fixture(t: TestContext, canonical = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sync-continuity-'))), root = join(directory, 'source'), home = join(directory, 'home'), previousHome = process.env.SPEXCODE_HOME
  mkdirSync(join(root, '.spec/demo'), { recursive: true }); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests')); mkdirSync(home, { mode: 0o700 })
  process.env.SPEXCODE_HOME = home
  const settings = { version: 'sync-settings-v1', model: 'claude:MiniMax-M3.1-Flash', nodeIds: ['demo'], sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'], verifications: [{ definition: { id: 'VERIFY-DEMO-01', command: ['node', '--test', 'tests/demo.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }], mandatoryTests: [], facts: [], budget: { mode: 'unlimited' } }
  const config = join(root, '.spec/spexcode.json')
  writeFileSync(config, JSON.stringify({ sync: settings })); writeFileSync(join(root, '.spec/demo/spec.md'), '---\ntitle: Demo\nstatus: pending\n---\n# Demo\n\n## raw source\n\n返回文本。\n\n## expanded spec\n\n返回文本。\n')
  writeFileSync(join(root, 'src/value.mjs'), 'export const value = 1\n'); writeFileSync(join(root, 'tests/demo.test.mjs'), ''); writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const git = (args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'source']]) git(args)
  const database = join(directory, 'sessions.sqlite')
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli.ts', import.meta.url)), ...args], { cwd: root, env: { ...process.env, SPEX_SESSION_DATABASE_PATH: database, SPEXCODE_API_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 30000 })
  if (canonical) { const initialized = cli(['sync', 'resources', 'recover', 'not-an-operation', '--input-id', 'a'.repeat(64)]); assert.equal(initialized.status, 1); assert.match(initialized.stderr, /SYNC_OPERATION_UNKNOWN/) }
  const protocol = openProtocol(database), app = await SyncApplication.create(root, { protocol })
  await app.enable()
  const input = await captureInputSnapshot(root), raw = readRawSource(root), enabledPath = sourceRegistrationPath(raw.source.commonDir, root), enabled = readFileSync(enabledPath)
  const operation = app.store.admitAndEnqueue({ ingressKey: 'continuity', rootCauseId: 'continuity', origin: 'spec', input, scope: { paths: ['src/value.mjs'], contractIds: ['demo'], flowIds: [] }, budget: { mode: 'unlimited' }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { canonicalRoot: join(directory, 'delivery'), branch: 'delivery', baseCommit: input.headCommit } })
  const request = { operationId: operation.id, inputId: input.id, revision: operation.revision, enabledDigest: contentHash(enabled), previousDevices: { commonDir: raw.stats.commonDir.dev, root: raw.stats.root.dev, gitDir: raw.stats.gitDir.dev } }
  const changed = new Map<string, Partial<SourceStat>>(), original = fs.lstatSync
  t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: unknown) => {
    const stat = original(path, options as { bigint: true }), override = changed.get(String(path))
    if (!override) return stat
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, Object.fromEntries(Object.entries(override).map(([key, value]) => [key, typeof stat.dev === 'bigint' ? BigInt(value!) : Number(value)])))
  }) as typeof fs.lstatSync)
  syncBuiltinESMExports()
  const drift = (): void => { for (const path of [raw.source.commonDir, root, raw.source.gitDir]) changed.set(path, { dev: String(BigInt(raw.stats.root.dev) + 1n) }) }
  return { directory, root, git, cli, protocol, app, input, operation, request, enabledPath, enabled, raw, changed, drift, config, settings, register: () => registerSourceContinuity(root, request, { protocol }), cleanup: async () => { await app.stopService(); t.mock.restoreAll(); syncBuiltinESMExports(); protocol.close(); if (previousHome === undefined) delete process.env.SPEXCODE_HOME; else process.env.SPEXCODE_HOME = previousHome; rmSync(directory, { recursive: true, force: true }) } }
}

test('explicit dual-hash registration preserves history and projects one logical source, then repeats without new control', async t => {
  const f = await fixture(t)
  try {
    const original = JSON.stringify(f.app.store.readOperation(f.operation.id))
    f.drift()
    assert.notEqual(identifyWorktree(f.root).repositoryId, f.input.source.repositoryId)
    await assert.rejects(f.app.readOperation(f.operation.id), { code: 'sync_operation_wrong_source' })
    const result = await f.register()
    assert.equal(result.status, 'registered'); assert.equal(result.control.control, 'pause')
    assert.deepEqual(identifyWorktree(f.root), f.input.source)
    assert.equal(readPhysicalFingerprint(f.root, f.raw.source.gitDir, f.raw.source.commonDir), f.input.source.physicalFingerprint)
    assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
    assert.equal(JSON.stringify(f.app.store.readOperation(f.operation.id)), original)
    const registered = readEnabledRecord(f.enabledPath)!.record
    assert.equal(registered.version, 2)
    if (registered.version !== 2) assert.fail('v2 registration required')
    assert.deepEqual(readRegistrationEvidence(f.raw.source.commonDir, registered.continuity.previousRecordRef), f.enabled)
    assert.equal(contentHash(readRegistrationEvidence(f.raw.source.commonDir, result.proofRef)), result.proofRef.sha256)
    assert(!f.app.store.pinnedBlobRefs().some(ref => ref.sha256 === result.proofRef.sha256), 'private continuity CAS does not rely on DB-only general GC pins')
    const repeat = await f.register()
    assert.equal(repeat.status, 'already_registered'); assert.equal(repeat.control.revision, result.control.revision)
    assert.equal(f.app.store.readOperation(f.operation.id).callsUsed, 0)
  } finally { await f.cleanup() }
})

for (const defect of ['wrong-dev', 'one-hash', 'rebuilt', 'branch', 'config', 'record-cas', 'operation-cas', 'lock'] as const) test(`continuity rejects ${defect} before authorizing or pausing`, async t => {
  const f = await fixture(t)
  let mutex: ReturnType<typeof sourceRegistrationLock> | undefined
  try {
    f.drift()
    if (defect === 'wrong-dev') f.request.previousDevices = { commonDir: '0', root: '0', gitDir: '0' }
    if (defect === 'one-hash') f.request.previousDevices.root = String(BigInt(f.request.previousDevices.root) + 2n)
    if (defect === 'rebuilt') f.changed.set(f.root, { dev: String(BigInt(f.raw.stats.root.dev) + 1n), ino: String(BigInt(f.raw.stats.root.ino) + 1n) })
    if (defect === 'branch') f.git(['checkout', '-qb', 'moved'])
    if (defect === 'config') { writeFileSync(f.config, JSON.stringify({ sync: { ...f.settings, model: 'zcode:bigmodel-api/GLM-5.3-Flash' } })); f.git(['add', '.']); f.git(['commit', '-qm', 'configuration']) }
    if (defect === 'record-cas') f.request.enabledDigest = '0'.repeat(64)
    if (defect === 'operation-cas') f.request.revision++
    if (defect === 'lock') mutex = sourceRegistrationLock(f.raw.source.commonDir, f.root)
    await assert.rejects(f.register())
    assert.deepEqual(readFileSync(f.enabledPath), f.enabled)
    assert.equal(f.app.store.readPhysicalControl(f.input.source).control, 'run')
    assert.equal(f.app.store.readOperation(f.operation.id).callsUsed, 0)
  } finally { mutex?.release(); await f.cleanup() }
})

test('formal configuration and branch enable preserve physical proof while snapshots retain the actual branch', async t => {
  const f = await fixture(t)
  try {
    f.drift(); await f.register()
    const proof = readEnabledRecord(f.enabledPath)!.record
    f.git(['checkout', '-qb', 'authorized-next'])
    assert.equal(identifyWorktree(f.root).branch, 'refs/heads/authorized-next')
    await assert.rejects(f.app.readOperation(f.operation.id), { code: 'sync_operation_wrong_source' })
    writeFileSync(f.config, JSON.stringify({ sync: { ...f.settings, model: 'zcode:bigmodel-api/GLM-5.3-Flash' } })); f.git(['add', '.']); f.git(['commit', '-qm', 'config-only approved model'])
    const digest = readSyncSettings(await captureInputSnapshot(f.root, { committed: true })).configDigest
    const enabled = await f.app.enable(digest)
    assert.equal(enabled.enabled, true); assert.equal(enabled.configuration!.model, 'zcode:bigmodel-api/GLM-5.3-Flash')
    const updated = readEnabledRecord(f.enabledPath)!.record
    assert.equal(updated.version, 2)
    if (proof.version === 2 && updated.version === 2) assert.deepEqual(updated.continuity, proof.continuity)
    assert.equal((await captureInputSnapshot(f.root)).source.branch, 'refs/heads/authorized-next')
    assert.equal(f.app.store.readPhysicalControl(f.input.source).control, 'pause')
  } finally { await f.cleanup() }
})

test('common repository projection supports fresh managed roots but does not grant unproved old linked authority', async t => {
  const f = await fixture(t)
  try {
    const linked = join(f.directory, 'linked'); f.git(['worktree', 'add', '-qb', 'linked', linked])
    const old = await captureInputSnapshot(linked), linkedApp = await SyncApplication.create(linked, { protocol: f.protocol })
    const linkedOperation = f.app.store.admitAndEnqueue({ input: old, ingressKey: 'linked', rootCauseId: 'linked', origin: 'spec', scope: f.operation.scope, budget: f.operation.budget, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { ...f.operation.deliveryPlan, baseCommit: old.headCommit } })
    f.drift()
    for (const path of [linked, old.source.gitDir]) f.changed.set(path, { dev: String(BigInt(f.raw.stats.root.dev) + 1n) })
    await f.register()
    assert.equal(identifyWorktree(linked).repositoryId, f.input.source.repositoryId)
    assert.notEqual(identifyWorktree(linked).physicalFingerprint, old.source.physicalFingerprint)
    await assert.rejects(linkedApp.readOperation(linkedOperation.id), { code: 'sync_operation_wrong_source' })
    const managed = join(f.directory, 'managed'); f.git(['worktree', 'add', '-qb', 'managed', managed])
    const fresh = await captureInputSnapshot(managed)
    assert.equal(fresh.source.repositoryId, f.input.source.repositoryId)
    assert.equal(fresh.source.physicalFingerprint, identifyRawWorktree(managed).physicalFingerprint)
    assert.notEqual(fresh.source.physicalFingerprint, f.input.source.physicalFingerprint)
  } finally { await f.cleanup() }
})

test('invalid current witness fails closed for normal identity but raw resource-only construction remains available', async t => {
  const f = await fixture(t)
  try {
    f.drift(); await f.register()
    const current = readRawSource(f.root).stats.root
    for (const key of ['dev', 'ino', 'birthtimeNs'] as const) {
      f.changed.set(f.root, { dev: current.dev, [key]: String(BigInt(current[key]) + 1n) })
      assert.throws(() => identifyWorktree(f.root), { code: 'sync_source_continuity_changed' })
    }
    await assert.rejects(f.app.control(f.operation.id, 'resume'))
    assert.equal(identifyRawWorktree(f.root).canonicalRoot, f.root)
    const resourceOnly = await SyncApplication.createResourceRecovery(f.root, { protocol: f.protocol })
    assert.equal((await resourceOnly.recoverResources(f.operation.id, f.input.id)).status, 'resources_recovered')
    assert.equal(f.app.store.readOperation(f.operation.id).callsUsed, 0)
  } finally { await f.cleanup() }
})

test('foreign root and changed linked backlink cannot borrow a registered common identity', async t => {
  const f = await fixture(t)
  try {
    f.drift()
    const foreign = join(f.directory, 'foreign'); cpSync(f.root, foreign, { recursive: true })
    await assert.rejects(registerSourceContinuity(foreign, f.request, { protocol: f.protocol }))
    assert.deepEqual(readFileSync(f.enabledPath), f.enabled)
    await f.register()
    const linked = join(f.directory, 'bad-backlink'); f.git(['worktree', 'add', '-qb', 'bad-backlink', linked])
    const gitDir = identifyRawWorktree(linked).gitDir
    writeFileSync(join(gitDir, 'gitdir'), join(f.directory, 'not-the-source/.git'))
    assert.throws(() => identifyWorktree(linked), /registered worktree/)
    await assert.rejects(registerSourceContinuity(linked, f.request, { protocol: f.protocol }))
  } finally { await f.cleanup() }
})

test('another root raw namespace with a live lease blocks registration; expired running metadata alone does not', async t => {
  const f = await fixture(t)
  try {
    f.drift()
    const linked = join(f.directory, 'other'); f.git(['worktree', 'add', '-qb', 'other', linked])
    const other = await SyncApplication.create(linked, { protocol: f.protocol }); await other.enable()
    const input = await captureInputSnapshot(linked)
    const operation = other.store.admitAndEnqueue({ input, ingressKey: 'other-raw', rootCauseId: 'other-raw', origin: 'spec', scope: f.operation.scope, budget: { mode: 'unlimited' }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'read', delivery: null, deliveryPlan: { ...f.operation.deliveryPlan, baseCommit: input.headCommit } })
    other.store.claimAttempt({ operationId: operation.id, source: input.source, scope: operation.scope, leaseMs: 30000, expectedMessageId: operation.dispatchMessageId })
    const before = JSON.stringify(other.store.readOperation(operation.id)), state = other.store.sourceContinuityState(f.raw.source.commonDir)
    assert(state.activeAttemptIds.length); assert(state.leasedOperationIds.includes(operation.id))
    await assert.rejects(f.register(), { code: 'sync_continuity_not_quiescent' })
    assert.deepEqual(readFileSync(f.enabledPath), f.enabled)
    const afterExpiry = Date.now() + 60000; t.mock.method(Date, 'now', () => afterExpiry)
    assert.equal((await f.register()).status, 'registered')
    assert.equal(JSON.stringify(other.store.readOperation(operation.id)), before)
    assert.equal(other.store.readPhysicalControl(f.input.source).control, 'pause')
  } finally { await f.cleanup() }
})

test('formal offline CLI registers a fixture without HTTP, pauses original scope and rejects remote or misplaced flags', async t => {
  const f = await fixture(t, true)
  try {
    const original = JSON.stringify(f.app.store.readOperation(f.operation.id))
    const args = ['sync', 'source-continuity', f.operation.id, '--input-id', f.input.id, '--revision', String(f.request.revision), '--enabled-digest', f.request.enabledDigest, '--old-common-dev', f.request.previousDevices.commonDir, '--old-root-dev', f.request.previousDevices.root, '--old-git-dev', f.request.previousDevices.gitDir]
    const remote = f.cli([...args, '--api', 'http://127.0.0.1:1'])
    assert.equal(remote.status, 1); assert.match(remote.stderr, /离线/)
    const registered = f.cli(args)
    assert.equal(registered.status, 0, registered.stderr)
    assert.equal(JSON.parse(registered.stdout).status, 'registered'); assert.equal(JSON.parse(registered.stdout).control.control, 'pause')
    assert.equal(JSON.stringify(f.app.store.readOperation(f.operation.id)), original)
    assert.equal(JSON.parse(f.cli(args).stdout).status, 'already_registered')
    const misplaced = f.cli(['sync', 'enable', '--old-root-dev', '1'])
    assert.equal(misplaced.status, 1); assert.match(misplaced.stderr, /只用于/)
  } finally { await f.cleanup() }
})
