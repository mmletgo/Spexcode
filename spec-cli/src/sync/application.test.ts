import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress } from './migrations.js'
import { SyncApplication } from './application.js'
import { buildSyncApplicationPlan } from './planning.js'
import { captureInputSnapshot } from './snapshot.js'
import { readSyncSettings, SyncApplicationError } from './settings.js'
import type { SyncSettings } from './settings.js'
import type { ContractCell, GeneratedTables } from './elaboration-markdown.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationSessionRequest } from './elaboration-types.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { contentHash, identifyWorktree, writeEvidence, readEvidence } from './snapshot.js'
import { claimFileMutex } from './file-mutex.js'
import type { FileMutex } from './file-mutex.js'
import { composeAuthoredInput } from './author-input.js'
import { composeControlledRequest } from './request-input.js'
import type { ApplyJournal, BaselinePair } from './operation-types.js'

const settings: SyncSettings = {
  version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'],
  verifications: [{ definition: { id: 'VERIFY-DEMO-01', command: ['node', '--test', 'tests/demo.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }],
  mandatoryTests: [], facts: [], budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 30000 },
}
const source = '---\ntitle: Demo\nstatus: pending\n---\n# Demo\n\n## raw source\n\n返回用户指定的文本。\n\n## expanded spec\n\n待细化。\n'
async function fixture(config: unknown = settings) {
  const temp = mkdtempSync(join(tmpdir(), 'sync-application-')), root = join(temp, 'source')
  mkdirSync(join(root, '.spec', 'demo'), { recursive: true }); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, '.spec', 'demo', 'spec.md'), source)
  writeFileSync(join(root, '.spec', 'spexcode.json'), JSON.stringify({ sync: config }))
  writeFileSync(join(root, 'src', 'demo.mjs'), 'export const demo = text => text\n')
  writeFileSync(join(root, 'tests', 'demo.test.mjs'), "import test from 'node:test'; test('DEMO-01', () => {})\n")
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const git = (args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['add', '.']); git(['commit', '-qm', 'fixture'])
  const protocol = openProtocol(join(temp, 'sessions.sqlite'))
  const calls: ElaborationSessionRequest[] = []
  const application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); throw Object.assign(new Error('受控生成环境故障'), { code: 'unsupported' }) } })
  return { temp, root, git, protocol, application, calls, cleanup: (): void => { protocol.close(); rmSync(temp, { recursive: true, force: true }) } }
}

test('AC-APPLICATION-01 缺少可信配置明确拒绝，现有配置启用CAS且不修改版本化文件', async () => {
  const f = await fixture(undefined)
  try {
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), '{}')
    assert.equal((await f.application.readSettings()).configurationError?.code, 'sync_configuration_invalid')
    await assert.rejects(f.application.enable(), /配置缺口/)
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: settings }))
    const before = f.git(['rev-parse', 'HEAD']), bytes = readFileSync(join(f.root, '.spec', 'spexcode.json'))
    const state = await f.application.readSettings()
    await assert.rejects(f.application.enable('b'.repeat(64)), /摘要已过期/)
    assert.equal((await f.application.enable(state.configDigest!)).enabled, true)
    assert.deepEqual(readFileSync(join(f.root, '.spec', 'spexcode.json')), bytes)
    assert.equal(f.git(['rev-parse', 'HEAD']), before)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-02 受控no-op不提交不派发，来源身份与body必须对应冻结输入', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const head = f.git(['rev-parse', 'HEAD'])
    assert.deepEqual(await f.application.submit({ nodeId: 'demo', requestId: 'no-op', patch: { startLine: 1, endLine: 1, original: '# Demo', replacement: '# Demo' } }), { changed: false, operation: null })
    assert.equal((await f.application.status()).operations.length, 0)
    assert.equal(f.git(['rev-parse', 'HEAD']), head)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'stale-patch', patch: { startLine: 1, endLine: 1, original: '# Older', replacement: '# Next' } }), /changed since/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'bad-origin', origin: 'external' as 'spec' }), /输入来源必须/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-03 受控编辑成为持久operation，重复幂等且真实失败可查询，不先提交Spec', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const head = f.git(['rev-parse', 'HEAD'])
    const request = { nodeId: 'demo', requestId: 'edit-1', patch: { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' } }
    const first = await f.application.submit(request)
    assert.ok(first.operation?.requestBlob)
    const detail = await f.application.wait(first.operation.id)
    assert.equal(detail.operation.phase, 'failed')
    assert.ok(detail.attempt?.failure?.message)
    assert.equal(detail.sourceSynced, false)
    assert.equal(detail.stale, false)
    assert.equal((await f.application.submit(request)).operation?.id, first.operation.id)
    await f.application.wait(first.operation.id)
    assert.equal((await f.application.status({ nodeId: 'demo' })).operations.length, 1)
    assert.equal(readFileSync(join(f.root, '.spec', 'demo', 'spec.md'), 'utf8'), source)
    assert.equal(f.git(['rev-parse', 'HEAD']), head)
    await assert.rejects(f.application.submit({ ...request, patch: { ...request.patch, replacement: '另一意图' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-04 当前输入或可信配置变化令旧结果过期，暂停恢复不能使用旧输入', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const result = await f.application.submit({ nodeId: 'demo', requestId: 'run-1' }); assert.ok(result.operation)
    await f.application.wait(result.operation.id)
    await f.application.control(result.operation.id, 'pause')
    writeFileSync(join(f.root, 'src', 'demo.mjs'), 'export const demo = text => `${text}!`\n')
    assert.equal((await f.application.readOperation(result.operation.id)).stale, true)
    await assert.rejects(f.application.control(result.operation.id, 'resume'), /恢复输入已变化/)
    assert.equal((await f.application.readOperation(result.operation.id)).operation.control, 'pause')
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: { ...settings, budget: { ...settings.budget, maxCalls: 6 } } }))
    assert.equal((await f.application.readSettings()).enabled, false)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'new' }), /配置已变化/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-05 图影响和旧节点治理纳入共享叶，配置不能指定宿主fallback命令', async () => {
  const f = await fixture()
  try {
    writeFileSync(join(f.root, '.spec', 'demo', 'spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
    mkdirSync(join(f.root, '.spec', 'other')); writeFileSync(join(f.root, '.spec', 'other', 'spec.md'), source.replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
    const plan = await buildSyncApplicationPlan(await captureInputSnapshot(f.root), 'demo')
    assert.deepEqual(plan.targets.map(target => target.nodeId).sort(), ['demo', 'other'])
    assert.ok(plan.writePaths.includes('src'))
    assert.ok(plan.readPaths.includes('.spec/spexcode.json'))
    writeFileSync(join(f.root, '.spec', 'spexcode.json'), JSON.stringify({ sync: { ...settings, verifications: [{ ...settings.verifications[0], definition: { ...settings.verifications[0].definition, command: ['npm', 'test'] } }] } }))
    const invalid = await captureInputSnapshot(f.root)
    assert.throws(() => readSyncSettings(invalid), /Docker Node/)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: settings.budget.timeoutMs + 1 } }))
    const invalidTimeout = await captureInputSnapshot(f.root)
    assert.throws(() => readSyncSettings(invalidTimeout), /不能超过/)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: 15000 } }))
    assert.equal(readSyncSettings(await captureInputSnapshot(f.root)).settings.callTimeoutMs, 15000)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-07 两个并发相同请求归并同一操作和runtime，不重置预算或重复native', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'concurrent-1' }
    const [first, second] = await Promise.all([f.application.submit(request), f.application.submit(request)])
    assert.ok(first.operation); assert.equal(first.operation.id, second.operation?.id)
    const detail = await f.application.wait(first.operation.id)
    assert.equal((await f.application.status()).operations.length, 1)
    assert.equal(detail.operation.callsUsed, 1)
    assert.deepEqual(detail.operation.budget, settings.budget)
    const slots = readdirSync(join(f.temp, 'runtime/runtimes', contentHash(detail.operation.ingressKey)), { withFileTypes: true }).filter(entry => entry.isDirectory())
    assert.equal(slots.length, 1)
    assert.equal(detail.journals.length, 0)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-08 queued资料损坏有恢复诊断，同请求只恢复原runtime，已派发记录禁止重冻结', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'restore-1' }, submitted = await f.application.submit(request)
    assert.ok(submitted.operation)
    const failed = await f.application.wait(submitted.operation.id)
    f.application.store.requestControl(submitted.operation.id, 'pause'); f.application.store.requestControl(submitted.operation.id, 'run')
    const key = contentHash(failed.operation.ingressKey), descriptor = join(f.temp, 'runtime/artifacts', `application-runtime-${key}.json`), backup = join(f.temp, 'runtime/runtimes', key, 'tools.json')
    const original = readFileSync(descriptor)
    rmSync(descriptor)
    const unavailable = await f.application.readOperation(submitted.operation.id)
    assert.equal(unavailable.operation.phase, 'queued')
    assert.equal(unavailable.executionAvailability.status, 'recovery_required')
    assert.match(unavailable.executionAvailability.failure!.message, /ENOENT/)
    assert.throws(() => f.application.start(submitted.operation!.id), /ENOENT/)
    const replay = await f.application.submit(request)
    assert.equal(replay.operation?.id, submitted.operation.id)
    const recovered = await f.application.wait(submitted.operation.id)
    assert.deepEqual(readFileSync(descriptor), original)
    assert.equal(recovered.executionAvailability.status, 'ready')
    assert.equal(recovered.operation.deadlineAtMs, failed.operation.deadlineAtMs)
    assert.ok(recovered.operation.callsUsed >= failed.operation.callsUsed)
    rmSync(descriptor); rmSync(backup)
    await assert.rejects(f.application.submit(request), /禁止用当前 runtime 替换/)
    assert.equal((await f.application.readOperation(submitted.operation.id)).executionAvailability.status, 'recovery_required')
    assert.equal(readdirSync(join(f.temp, 'runtime/runtimes', key), { withFileTypes: true }).filter(entry => entry.isDirectory()).length, 1)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-09 显式单次调用上限来自operation冻结配置，live修改不改旧请求与总预算', async () => {
  const f = await fixture({ ...settings, callTimeoutMs: 10000 })
  try {
    await f.application.enable()
    const result = await f.application.submit({ nodeId: 'demo', requestId: 'call-timeout' }); assert.ok(result.operation)
    const first = await f.application.wait(result.operation.id)
    assert.equal(f.calls[0].timeoutMs, 10000)
    writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ sync: { ...settings, callTimeoutMs: 20000 } }))
    assert.equal(readSyncSettings(first.operation.input).settings.callTimeoutMs, 10000)
    f.application.store.requestControl(first.operation.id, 'pause'); f.application.store.requestControl(first.operation.id, 'run')
    f.application.start(first.operation.id)
    const second = await f.application.wait(first.operation.id)
    assert.equal(f.calls[1].timeoutMs, 10000)
    assert.equal(second.operation.deadlineAtMs, first.operation.deadlineAtMs)
    assert.equal(second.operation.budget.timeoutMs, first.operation.budget.timeoutMs)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-10 已启用后删除或损坏配置保持invalidated，不能降级为普通独立Spec提交', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.application.readSettings()).activation, 'disabled')
    assert.equal((await f.application.enable()).activation, 'enabled')
    const config = join(f.root, '.spec/spexcode.json')
    rmSync(config)
    const missing = await f.application.readSettings()
    assert.equal(missing.activation, 'invalidated'); assert.equal(missing.enabled, false)
    assert.equal(missing.configurationError?.code, 'sync_configuration_missing')
    writeFileSync(config, '{broken JSON')
    const malformed = await f.application.readSettings()
    assert.equal(malformed.activation, 'invalidated'); assert.equal(malformed.configurationError?.code, 'sync_configuration_invalid')
    writeFileSync(config, JSON.stringify({ sync: { ...settings, sourcePaths: ['../outside'] } }))
    assert.equal((await f.application.readSettings()).activation, 'invalidated')
    writeFileSync(config, JSON.stringify({ sync: settings }))
    assert.equal((await f.application.readSettings()).activation, 'enabled')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-11 initial来源真实入账并执行Spec业务管线，同键不同来源拒绝', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const request = { nodeId: 'demo', requestId: 'initial-1', origin: 'initial' as const }
    const submitted = await f.application.submit(request); assert.ok(submitted.operation)
    const detail = await f.application.wait(submitted.operation.id)
    assert.equal(detail.operation.origin, 'initial')
    assert.equal(f.calls[0]?.purpose, 'elaboration_generate')
    assert.equal((await f.application.submit(request)).operation?.id, submitted.operation.id)
    await f.application.wait(submitted.operation.id)
    await assert.rejects(f.application.submit({ ...request, origin: 'spec' }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { f.cleanup() }
})

async function linkedApplication(f: Awaited<ReturnType<typeof fixture>>, directory: string) {
  const root = join(f.temp, directory), calls: ElaborationSessionRequest[] = []
  f.git(['worktree', 'add', '-b', `node/${directory}`, root, 'HEAD'])
  const application = await SyncApplication.create(root, { protocol: f.protocol, runtimeDirectory: join(f.temp, `${directory}-runtime`), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); throw Object.assign(new Error('受控环境故障'), { code: 'unsupported' }) } })
  await application.enable()
  return { application, calls }
}
function holdNextAdmission(f: Awaited<ReturnType<typeof fixture>>) {
  const held: { mutex: FileMutex | null } = { mutex: null }
  const admit = f.application.store.admitAndEnqueue.bind(f.application.store)
  f.application.store.admitAndEnqueue = input => {
    const operation = admit(input), locks = join(realpathSync(f.temp), 'runtime/artifacts/.locks')
    mkdirSync(locks, { recursive: true, mode: 0o700 })
    held.mutex = claimFileMutex(join(locks, `${contentHash(operation.id)}.sqlite`)); assert.ok(held.mutex)
    f.application.store.admitAndEnqueue = admit
    return operation
  }
  return held
}

test('AC-APPLICATION-12 同仓库两个工作树沿真实FIFO，busy不自旋，结束自动接续另一来源', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } })
  const later = await linkedApplication(first, 'later-source'), held = holdNextAdmission(first)
  const repositoryId = identifyWorktree(first.root).repositoryId
  try {
    await first.application.enable()
    const earlier = await first.application.submit({ nodeId: 'demo', requestId: 'fifo-earlier' }); assert.ok(earlier.operation)
    await first.application.wait(earlier.operation.id)
    const queued = await later.application.submit({ nodeId: 'demo', requestId: 'fifo-later' }); assert.ok(queued.operation)
    await first.application.wait(earlier.operation.id)
    assert.equal(first.application.store.nextDispatch(repositoryId)?.operation.id, earlier.operation.id)
    assert.equal(first.calls.length, 0); assert.equal(later.calls.length, 0)
    assert.equal((await later.application.wait(queued.operation.id)).operation.phase, 'queued')
    held.mutex!.release(); held.mutex = null
    first.application.start(earlier.operation.id)
    await later.application.wait(queued.operation.id)
    assert.equal(first.calls.length, 1); assert.equal(later.calls.length, 1)
    assert.equal(first.application.store.nextDispatch(repositoryId), null)
    assert.equal((await later.application.readOperation(queued.operation.id)).operation.phase, 'failed')
  } finally { held.mutex?.release(); first.cleanup() }
})

test('AC-APPLICATION-13 已出队暂停恢复先等有效FIFO，前序完成后自动恢复且wait等待真实执行', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } })
  const later = await linkedApplication(first, 'resume-source')
  const repositoryId = identifyWorktree(first.root).repositoryId
  const held = holdNextAdmission(first)
  try {
    await first.application.enable()
    const submitted = await later.application.submit({ nodeId: 'demo', requestId: 'resume-first' }); assert.ok(submitted.operation)
    const failed = await later.application.wait(submitted.operation.id)
    assert.equal(failed.operation.phase, 'failed'); assert.equal(later.calls.length, 1)
    await later.application.control(submitted.operation.id, 'pause')
    const earlier = await first.application.submit({ nodeId: 'demo', requestId: 'pending-before-resume' }); assert.ok(earlier.operation)
    await first.application.wait(earlier.operation.id)
    const resumed = await later.application.control(submitted.operation.id, 'resume')
    assert.equal(resumed.operation.phase, 'queued'); assert.equal(later.calls.length, 1)
    assert.equal(first.application.store.nextDispatch(repositoryId)?.operation.id, earlier.operation.id)
    held.mutex!.release(); held.mutex = null
    first.application.start(earlier.operation.id)
    const restored = await later.application.wait(submitted.operation.id)
    assert.equal(restored.operation.phase, 'failed'); assert.equal(restored.attempt?.number, 2)
    assert.equal(first.calls.length, 1); assert.equal(later.calls.length, 2)
    assert.equal(restored.operation.deadlineAtMs, failed.operation.deadlineAtMs)
    assert.equal(first.application.store.nextDispatch(repositoryId), null)
  } finally { held.mutex?.release(); first.cleanup() }
})

test('AC-APPLICATION-14 不同仓库共享canonicalDB时分别派发，不执行另一仓库的FIFO头', async () => {
  const first = await fixture({ ...settings, budget: { ...settings.budget, timeoutMs: 120000 } }), second = await fixture()
  const held = holdNextAdmission(first), calls: ElaborationSessionRequest[] = []
  const other = await SyncApplication.create(second.root, { protocol: first.protocol, runtimeDirectory: join(second.temp, 'shared-runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => { calls.push(request); throw Object.assign(new Error('另一仓库受控故障'), { code: 'unsupported' }) } })
  try {
    await first.application.enable(); await other.enable()
    const blocked = await first.application.submit({ nodeId: 'demo', requestId: 'blocked-repository' }); assert.ok(blocked.operation)
    await first.application.wait(blocked.operation.id)
    const submitted = await other.submit({ nodeId: 'demo', requestId: 'independent-repository' }); assert.ok(submitted.operation)
    assert.equal((await other.wait(submitted.operation.id)).operation.phase, 'failed')
    assert.equal(first.calls.length, 0); assert.equal(calls.length, 1)
    assert.equal(first.application.store.nextDispatch(identifyWorktree(first.root).repositoryId)?.operation.id, blocked.operation.id)
    assert.equal(first.application.store.nextDispatch(identifyWorktree(second.root).repositoryId), null)
    held.mutex!.release(); held.mutex = null
    first.application.start(blocked.operation.id); await first.application.wait(blocked.operation.id)
  } finally { held.mutex?.release(); second.cleanup(); first.cleanup() }
})

test('AC-APPLICATION-15 仅显式retry建立关联新操作与新预算，普通重复及retry重放仍幂等', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'failed-original', origin: 'initial' }); assert.ok(submitted.operation)
    const original = await f.application.wait(submitted.operation.id)
    assert.equal(original.operation.phase, 'failed'); assert.equal(original.retryEligibility.eligible, true)
    const repeatedRequest = { nodeId: 'demo', requestId: 'automatic-repeat', origin: 'initial' as const }
    const repeated = await f.application.submit(repeatedRequest)
    assert.equal(repeated.operation?.id, original.operation.id)
    await f.application.wait(original.operation.id)
    assert.equal((await f.application.submit(repeatedRequest)).operation?.id, original.operation.id)
    await f.application.wait(original.operation.id)
    const request = { nodeId: 'demo', requestId: 'explicit-retry', retryOf: original.operation.id }
    const retried = await f.application.submit(request); assert.ok(retried.operation)
    assert.notEqual(retried.operation.id, original.operation.id)
    const result = await f.application.wait(retried.operation.id)
    assert.equal(result.operation.retryOf, original.operation.id); assert.equal(result.operation.origin, 'initial')
    assert.equal(result.operation.callsUsed, 1); assert.deepEqual(result.operation.budget, original.operation.budget)
    assert.ok(result.operation.deadlineAtMs > original.operation.deadlineAtMs)
    assert.equal((await f.application.readOperation(original.operation.id)).operation.callsUsed, 1)
    assert.equal((await f.application.submit(request)).operation?.id, result.operation.id)
    await f.application.wait(result.operation.id)
    assert.equal(f.calls.length, 2); assert.equal((await f.application.status()).operations.length, 2)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-16 重试完整继承未落地正文意图，不能混入新patch或重放已变来源', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '重试必须保留这一段尚未落地的新正文。' }
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'saved-intent', patch }); assert.ok(submitted.operation)
    const original = await f.application.wait(submitted.operation.id)
    const request = { nodeId: 'demo', requestId: 'retry-saved-intent', retryOf: original.operation.id }
    await assert.rejects(f.application.submit({ ...request, patch }), /沿用原正文意图/)
    const retried = await f.application.submit(request); assert.ok(retried.operation)
    const result = await f.application.wait(retried.operation.id)
    assert.deepEqual(result.operation.requestBlob, original.operation.requestBlob)
    assert.deepEqual(result.operation.previousBaselinePair, original.operation.previousBaselinePair)
    assert.match(f.calls[1].prompt, /尚未落地的新正文/)
    assert.equal(readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8'), source)
    writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => `${text}!`\n')
    const stale = await f.application.readOperation(original.operation.id)
    assert.equal(stale.retryEligibility.eligible, false); assert.equal(stale.retryEligibility.reason?.code, 'sync_retry_stale')
    await assert.rejects(f.application.submit({ ...request, requestId: 'retry-after-change' }), /原输入已变化/)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-17 queued不可借retry重置预算，无交付cancelled可明确重试并清理旧FIFO', async () => {
  const f = await fixture(), held = holdNextAdmission(f)
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'cancel-before-delivery' }); assert.ok(submitted.operation)
    const queued = await f.application.wait(submitted.operation.id)
    assert.equal(queued.operation.phase, 'queued'); assert.equal(queued.retryEligibility.eligible, false)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'retry-active', retryOf: submitted.operation.id }))
    const cancelled = await f.application.control(submitted.operation.id, 'cancel')
    assert.equal(cancelled.operation.phase, 'cancelled'); assert.equal(cancelled.retryEligibility.eligible, true)
    const retried = await f.application.submit({ nodeId: 'demo', requestId: 'retry-cancelled', retryOf: cancelled.operation.id }); assert.ok(retried.operation)
    const result = await f.application.wait(retried.operation.id)
    assert.equal(result.operation.retryOf, cancelled.operation.id); assert.equal(f.calls.length, 1)
    assert.equal(f.application.store.nextDispatch(identifyWorktree(f.root).repositoryId), null)
  } finally { held.mutex?.release(); f.cleanup() }
})

async function resourceFixture(options: { conflict?: boolean; callRequested?: boolean; invalidPlan?: boolean } = {}) {
  const f = await fixture()
  let calls = 0
  const application = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => {
    calls++
    const operation = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)[0], attempt = f.application.store.readAttempt(operation.currentAttemptId!)
    const dispatch = attempt.dispatchPlans.find(plan => plan.key === request.requestKey)!
    const { signal: _signal, ...frozen } = request
    const requestDigest = contentHash(JSON.stringify(frozen)), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: null }
    const plan = { schemaVersion: 1, request: frozen, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: options.invalidPlan ? 'invalid-owned-session' : expectedSessionId, ...identity }
    const checkpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: options.callRequested ?? true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    f.application.store.planResource(fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: operation.input.id, candidateDigest: null, planBlob: writeEvidence(operation.input.source.commonDir, plan), checkpointRef: writeEvidence(operation.input.source.commonDir, checkpoint) })
    if (options.conflict) f.application.store.recordFailure(fence, { code: 'input_changed', message: '受控来源冲突故障', kind: 'conflict', evidenceRefs: [] })
    throw Object.assign(new Error('受控创建结果未知'), { code: 'unsupported' })
  } })
  return { ...f, application, modelCalls: (): number => calls }
}

test('AC-APPLICATION-18 已停止操作仍有未结算资源时不能展示ready或借retry新预算', async () => {
  const f = await resourceFixture()
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'pending-native-resource' }); assert.ok(submitted.operation)
    const failed = await f.application.wait(submitted.operation.id)
    assert.equal(failed.operation.phase, 'failed'); assert.equal(failed.resources[0]?.phase, 'planned')
    assert.equal(failed.executionAvailability.status, 'recovery_required'); assert.equal(failed.executionAvailability.failure?.code, 'sync_resources_unsettled')
    assert.equal(failed.retryEligibility.eligible, false); assert.ok(failed.retryEligibility.reason?.code)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'retry-unknown-resource', retryOf: failed.operation.id }))
    const paused = await f.application.control(failed.operation.id, 'pause')
    assert.equal(paused.operation.phase, 'paused'); assert.equal(paused.executionAvailability.status, 'recovery_required')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-19 recover不派发queued任务，不改control/预算/输入或出队有效消息', async () => {
  const f = await fixture(), held = holdNextAdmission(f)
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'recover-only-queued' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    held.mutex!.release(); held.mutex = null
    await f.application.control(before.operation.id, 'recover')
    const after = await f.application.wait(before.operation.id)
    assert.deepEqual(after.operation, before.operation)
    assert.equal(after.operation.phase, 'queued'); assert.equal(after.attempt, null); assert.equal(f.calls.length, 0)
    assert.equal(f.application.store.nextDispatch(identifyWorktree(f.root).repositoryId)?.operation.id, before.operation.id)
  } finally { held.mutex?.release(); f.cleanup() }
})

test('AC-APPLICATION-20 conflicted仍有资源不能ready；recover只结算已固定未派发资源并保留冲突', async () => {
  const f = await resourceFixture({ conflict: true, callRequested: false })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'conflict-with-resource' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    assert.equal(before.operation.phase, 'conflicted'); assert.equal(before.resources[0]?.phase, 'planned')
    assert.equal(before.executionAvailability.status, 'recovery_required'); assert.equal(before.executionAvailability.failure?.code, 'sync_resources_unsettled')
    // 来源和启用配置变化不阻止清理旧资源；恢复不能偷偷启用或推进新输入。
    writeFileSync(join(f.root, '.spec/spexcode.json'), '{broken JSON')
    await f.application.control(before.operation.id, 'recover')
    const after = await f.application.wait(before.operation.id)
    assert.deepEqual(after.operation, before.operation); assert.equal(after.operation.phase, 'conflicted')
    assert.equal(after.resources.length, 0); assert.equal(after.executionAvailability.status, 'ready')
    assert.equal(f.modelCalls(), 1); assert.equal(f.application.store.listAttempts(before.operation.id).length, 1)
    assert.equal((await f.application.readSettings()).activation, 'invalidated')
  } finally { f.cleanup() }
})

test('AC-APPLICATION-21 recover具体协调失败返回可见409，资源与原业务结果仍保留', async () => {
  const f = await resourceFixture({ invalidPlan: true, callRequested: false })
  try {
    await f.application.enable()
    const submitted = await f.application.submit({ nodeId: 'demo', requestId: 'recover-invalid-binding' }); assert.ok(submitted.operation)
    const before = await f.application.wait(submitted.operation.id)
    await assert.rejects(f.application.control(before.operation.id, 'recover'), (error: unknown) => error instanceof SyncApplicationError && error.status === 409 && error.code === 'resource_recovery' && /native resource plan differs/.test(error.message))
    const after = await f.application.readOperation(before.operation.id)
    assert.deepEqual(after.operation, before.operation)
    assert.equal(after.resources[0]?.phase, 'planned'); assert.equal(after.executionAvailability.status, 'recovery_required')
    assert.equal(f.modelCalls(), 1); assert.equal(f.application.store.listAttempts(before.operation.id).length, 1)
  } finally { f.cleanup() }
})

test('AC-APPLICATION-06 应用真实Docker及compiled hooks完整交付，completed重放沿原共同基线幂等', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 180000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'sync-application-delivery-')), root = join(temp, 'source')
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  renameSync(join(root, '.spec/export'), join(root, '.spec/project'))
  const path = '.spec/project/export-contract/spec.md', original = readFileSync(join(root, path), 'utf8')
  const contract = parseContract({ nodeId: 'export-contract', path, source: original }).contract!
  const verify = contract.items.find(item => item.kind === 'VERIFY')!; assert.equal(verify.kind, 'VERIFY')
  const config: SyncSettings = { ...settings, sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['tests', 'package.json'], budget: { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300000 }, facts: [{ source: 'decision:EXPORT-POLICY', text: original }], mandatoryTests: [{ verificationId: verify.id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }], verifications: [{ definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: { ...settings.verifications[0].environment, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392' } }] }
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: config }))
  const git = (args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git(['init', '-b', 'main']); git(['config', 'user.name', 'application fixture']); git(['config', 'user.email', 'application@example.invalid']); git(['add', '.']); git(['commit', '-m', 'fixture']); git(['switch', '-c', 'node/source'])
  execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init', '.', '--harness', 'none'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
  git(['add', '.']); git(['commit', '-m', 'adopt delivery'])
  const protocol = openProtocol(join(temp, 'canonical.sqlite'))
  let application: SyncApplication
  let calls = 0
  t.after(() => {
    protocol.close()
    const unlock = (directory: string): void => { chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name)) }
    unlock(temp); rmSync(temp, { recursive: true, force: true })
  })
  application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(temp, 'runtime'), runner: async request => {
    calls++
    let output: unknown
    if (request.purpose === 'elaboration_generate') {
      const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
        const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
        const value = (item as unknown as Record<string, ContractCell>)[key]
        return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
      })))])) as GeneratedTables
      output = { version: 'elaboration-rows-v1', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(original).fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(original)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定业务政策', affectedIds: ['REQ-EXPORT-01'] })) }
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else {
      const frozen = JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] } }
      if (request.purpose === 'code_generate') {
        const change = (path: string, content: string): unknown => { const entry = frozen.manifest.entries.find(entry => entry.path === path)!; return { path, beforeDigest: entry.digest, beforeMode: entry.mode, content, mode: null } }
        output = { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change('src/export.js', `${new Map(frozen.files).get('src/export.js')}\n// application verified delivery\n`)] }
      } else {
        const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n实际完整候选')[0]) as { inputId: string; candidate: { digest: string } }
        output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: frozen.readyIds, findings: [] }
      }
    }
    const operation = application.store.listOperations(identifyWorktree(root).repositoryId, { sourceRoot: identifyWorktree(root).canonicalRoot })[0]
    const dispatch = application.store.readAttempt(operation.currentAttemptId!).dispatchPlans.find(plan => plan.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `independent-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  await application.enable()
  const before = await captureInputSnapshot(root), request = { nodeId: 'export-contract', requestId: 'complete-replay', origin: 'initial' as const }
  const admitted = await application.submit(request); assert.ok(admitted.operation)
  const delivered = await application.wait(admitted.operation.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify(delivered.attempt?.failure))
  assert.ok(delivered.journals[0]?.receipt)
  assert.equal(delivered.sourceSynced, false); assert.equal(delivered.stale, false)
  assert.match(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8'), /application verified delivery/)
  assert.equal((await captureInputSnapshot(root)).id, before.id)
  const callCount = calls, replay = await application.submit(request)
  assert.equal(replay.operation?.id, admitted.operation.id); assert.equal(calls, callCount)
  assert.deepEqual((await application.readOperation(admitted.operation.id)).journals, delivered.journals)
  const key = contentHash(delivered.operation.ingressKey), descriptor = join(temp, 'runtime/artifacts', `application-runtime-${key}.json`)
  const frozenDescriptor = readFileSync(descriptor)
  rmSync(descriptor)
  assert.equal((await application.readOperation(admitted.operation.id)).executionAvailability.status, 'recovery_required')
  await application.submit(request)
  assert.deepEqual(readFileSync(descriptor), frozenDescriptor)
  assert.equal(calls, callCount)
})


test('AC-APPLICATION-22 同受控编辑更换requestId仍归原failed预算，alias重放精确且只有retryOf开新预算', async () => {
  const f = await fixture()
  try {
    await f.application.enable()
    const bytes = readFileSync(join(f.root, '.spec/demo/spec.md')), index = readFileSync(join(f.root, '.git/index')), head = f.git(['rev-parse', 'HEAD'])
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' }
    const first = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-A', patch }); assert.ok(first.operation)
    const original = (await f.application.wait(first.operation.id)).operation
    const second = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch }); assert.ok(second.operation)
    const replay = await f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch })
    assert.equal(second.operation.id, original.id); assert.equal(replay.operation?.id, original.id)
    await f.application.wait(original.id)
    assert.deepEqual((await f.application.readOperation(original.id)).operation, original)
    assert.equal(f.calls.length, 1); assert.equal((await f.application.status()).operations.length, 1)
    const ingress = f.application.store.findIngressReceipt(`application:${original.input.source.repositoryId}:${original.input.source.canonicalRoot}:ordinary-B`)!
    assert.notEqual(ingress.requestBlob?.sha256, original.requestBlob?.sha256)
    assert.ok(f.application.store.pinnedBlobRefs().some(ref => ref.sha256 === ingress.requestBlob?.sha256))
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch: { ...patch, reason: '不同用户授权意图' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'ordinary-B', patch: { ...patch, replacement: '另一个正文' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
    const retry = await f.application.submit({ nodeId: 'demo', requestId: 'explicit-retry', retryOf: original.id }); assert.ok(retry.operation)
    assert.notEqual(retry.operation.id, original.id); assert.deepEqual(retry.operation.requestBlob, original.requestBlob)
    await f.application.wait(retry.operation.id); assert.equal(f.calls.length, 2)
    const next = await f.application.submit({ nodeId: 'demo', requestId: 'new-patch', patch: { ...patch, replacement: '另一项真实用户编辑' } }); assert.ok(next.operation)
    assert.notEqual(next.operation.id, original.id); await f.application.wait(next.operation.id); assert.equal(f.calls.length, 3)
    const intent = await f.application.submit({ nodeId: 'demo', requestId: 'new-intent', patch: { ...patch, reason: '新的授权意图' } }); assert.ok(intent.operation)
    assert.notEqual(intent.operation.id, original.id); await f.application.wait(intent.operation.id); assert.equal(f.calls.length, 4)
    assert.deepEqual(readFileSync(join(f.root, '.spec/demo/spec.md')), bytes); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index); assert.equal(f.git(['rev-parse', 'HEAD']), head)
  } finally { f.cleanup() }
})


test('AC-APPLICATION-23 正式v6结构旧patch重开后换requestId及alias重放不产生新预算或模型调用', async () => {
  const f = await fixture(), legacy = openProtocol(join(f.temp, 'legacy-v6.sqlite'))
  try {
    await f.application.enable()
    const patch = { startLine: 5, endLine: 5, original: '返回用户指定的文本。', replacement: '返回用户指定文本，并保留空文本。' }
    const accepted = await f.application.submit({ nodeId: 'demo', requestId: 'old-A', patch }); assert.ok(accepted.operation)
    const old = (await f.application.wait(accepted.operation.id)).operation
    applyComponentMigrations(legacy, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 6))
    const address = syncCoordinatorAddress(old.input.source.repositoryId)
    legacy.initialize(address)
    const originalMessage = f.protocol.readMessages(address).find(message => message.messageId === old.dispatchMessageId)!
    const message = legacy.enqueue(address, { kind: originalMessage.kind, body: originalMessage.body, idempotencyKey: originalMessage.idempotencyKey })
    legacy.withTransaction(tx => tx.dequeue(address, message.messageId))
    for (const table of ['sync_operations', 'sync_attempts', 'sync_leases']) for (const row of f.protocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))) {
      if (table === 'sync_operations') { const record = JSON.parse(String(row.record_json)); record.dispatchMessageId = message.messageId; row.record_json = JSON.stringify(record) }
      const columns = Object.keys(row).filter(column => column !== 'normalized_semantic_digest')
      legacy.withTransaction(tx => tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    }
    let newCalls = 0
    const reopened = await SyncApplication.create(f.root, { protocol: legacy, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async () => { newCalls++; throw new Error('旧受控请求不应再派发') } })
    const second = await reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch }); assert.ok(second.operation)
    assert.equal(second.operation.id, old.id); assert.equal(second.operation.payloadDigest, old.payloadDigest)
    assert.equal(second.operation.callsUsed, old.callsUsed); assert.equal(second.operation.deadlineAtMs, old.deadlineAtMs)
    assert.deepEqual(second.operation.requestBlob, old.requestBlob)
    assert.equal((await reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch })).operation?.id, old.id)
    await reopened.wait(old.id); assert.equal(newCalls, 0); assert.equal(f.calls.length, 1)
    assert.equal((await reopened.status()).operations.length, 1)
    await assert.rejects(reopened.submit({ nodeId: 'demo', requestId: 'new-B', patch: { ...patch, replacement: '不同原意' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
  } finally { legacy.close(); f.cleanup() }
})


test('AC-APPLICATION-P3 code/combined手动接入与可信裁决冻结，旧原意和冲突保留且重复至多一次', async () => {
  for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) {
    const f = await fixture()
    try {
      await f.application.enable()
      const starts: string[] = []
      f.application.start = id => { starts.push(id) }
      const code = (await f.application.submit({ nodeId: 'demo', requestId: 'code-input', origin: 'code' })).operation!
      assert.equal(code.origin, 'code')
      const first = (await f.application.submit({ nodeId: 'demo', requestId: 'combined-input', origin: 'combined' })).operation!
      assert.equal(first.origin, 'combined')
      const claimed = f.application.store.claimAttempt({ operationId: first.id, source: first.input.source, scope: first.scope, leaseMs: 60000 })
      const analysis = { version: 'code-behavior-v1', inputId: first.input.id, baselinePairId: null, composedDigest: 'composed', readSetDigest: first.readSetDigest, policyDigest: first.policyDigest, inputDigest: first.input.contentDigest, reviewPassed: true, changes: [], findings: [{ id: 'conflict-1', kind: 'conflict', ruleIds: ['RULE-DEMO-01'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], originalIntent: '返回用户指定的文本。', sourceBehavior: '返回大写文本。', deliveryBehavior: '保留原文本。', counterexample: 'a → A', evidence: 'src/demo.mjs', decision: '是否允许改变大小写？' }, { id: 'gap-2', kind: 'coverage_gap', ruleIds: [], affectedIds: ['REQ-OTHER-1'], paths: ['src/other.mjs'], originalIntent: '独立规则', sourceBehavior: '未知规则', deliveryBehavior: '', counterexample: '', evidence: '', decision: '另一项事实' }], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [] }
      const analysisRef = writeEvidence(first.input.source.commonDir, analysis)
      const stageRef = writeEvidence(first.input.source.commonDir, { version: 'sync-stage-v1', operationId: first.id, attemptId: claimed.attempt.id, inputId: first.input.id, policyDigest: first.policyDigest, stage: 'analysis', resultRef: analysisRef })
      f.application.store.checkpoint(claimed.fence, analysisRef)
      f.application.store.checkpoint(claimed.fence, stageRef)
      f.application.store.recordFailure(claimed.fence, { code: 'business_conflict', message: '有具体业务分歧', kind: 'conflict', evidenceRefs: [analysisRef] })
      const request = { operationId: first.id, inputId: first.input.id, requestId: 'keep-1', analysisRef, findingIds: ['conflict-1'], decision: choice === 'new_rule' ? { choice, rule: '只改变 ASCII 字母大小写。' } : { choice } }
      await assert.rejects(f.application.decide({ ...request, analysisRef: writeEvidence(first.input.source.commonDir, { ...analysis, findings: [] }) }), /可信当前检查点/)
      await assert.rejects(f.application.decide({ ...request, findingIds: ['invented'] }), /真实存在/)
      await assert.rejects(f.application.decide({ ...request, inputId: 'stale' }), /旧分歧裁决/)
      const [keep, duplicate] = await Promise.all([f.application.decide(request), f.application.decide(request)])
      assert.equal(keep.operation.id, duplicate.operation.id)
      const alias = await f.application.decide({ ...request, requestId: 'same-choice-another-transport-id' })
      assert.equal(alias.operation.id, keep.operation.id)
      assert.equal(alias.operation.deadlineAtMs, keep.operation.deadlineAtMs)
      assert.equal(alias.operation.callsUsed, keep.operation.callsUsed)
      const twoFindings = await f.application.decide({ ...request, requestId: 'two-findings', findingIds: ['conflict-1', 'gap-2'] })
      const reordered = await f.application.decide({ ...request, requestId: 'two-findings-another-uuid', findingIds: ['gap-2', 'conflict-1'] })
      assert.equal(twoFindings.operation.id, reordered.operation.id)
      assert.equal(twoFindings.operation.deadlineAtMs, reordered.operation.deadlineAtMs)
      assert.equal(twoFindings.operation.callsUsed, reordered.operation.callsUsed)


      assert.equal(keep.operation.origin, 'decision')
      assert.equal(keep.operation.rootCauseId, first.rootCauseId)
      assert.ok(keep.operation.requestBlob)
      assert.equal(starts.filter(id => id === keep.operation.id).length, 1)
      await assert.rejects(f.application.decide({ ...request, decision: { choice: choice === 'adopt_behavior' ? 'keep_intent' : 'adopt_behavior' } }), /SYNC_IDEMPOTENCY_CONFLICT/)
      const frozenPlan = JSON.parse(readEvidence(first.input.source.commonDir, keep.operation.planBlob!).toString('utf8'))
      assert.deepEqual(frozenPlan.decisionAuthorities, [{
        stableDecisionId: frozenPlan.facts.find((fact: { source: string }) => fact.source.startsWith('decision:')).source.slice('decision:'.length),
        requestRef: keep.operation.requestBlob, operationId: first.id, inputId: first.input.id, analysisRef,
        findingIds: ['conflict-1'], ruleIds: ['RULE-DEMO-01'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], decision: request.decision,
      }])
      if (choice !== 'keep_intent') {
        const raw = frozenPlan.targets.find((target: { nodeId: string }) => target.nodeId === 'demo').rawSource
        assert.match(raw, /返回用户指定的文本/)
        assert.match(raw, choice === 'new_rule' ? /ASCII/ : /返回大写/)
      }
      assert.equal(frozenPlan.facts.filter((fact: { source: string }) => fact.source.startsWith('decision:')).length, 1)
      const saved = JSON.parse(readEvidence(first.input.source.commonDir, keep.operation.requestBlob!).toString('utf8'))
      assert.deepEqual(saved.findingIds, ['conflict-1'])
      const history = await f.application.readOperation(first.id)
      assert.equal(history.operation.phase, 'superseded')
      assert.equal(history.decisionContext?.analysisRef.sha256, analysisRef.sha256)
      assert.equal(readFileSync(join(f.root, '.spec/demo/spec.md'), 'utf8'), source)
      writeFileSync(join(f.root, 'src/demo.mjs'), 'export const demo = text => text.toUpperCase()\n')
      await assert.rejects(f.application.decide({ ...request, requestId: 'after-source-edit' }), /旧分歧裁决/)
    } finally { f.cleanup() }
  }
})

test('AC-APPLICATION-P3-PARTIAL 剩余裁决保留最新交付raw及原受控正文差量', async t => {
  for (const placement of ['separate', 'same-line', 'overlap-review'] as const) await t.test(placement, async () => {
  const f = await fixture()
  try {
    const path = '.spec/demo/spec.md'
    const authored = source.replace('返回用户指定的文本。', '返回用户指定的文本。\n\n未选义务：保持隔离。\n\n待修改事实：原文字节。')
    writeFileSync(join(f.root, path), authored)
    await f.application.enable(); f.application.start = () => {}
    const original = (await f.application.submit({ nodeId: 'demo', requestId: 'partial-original', origin: 'combined', patch: { startLine: 9, endLine: 9, original: '待修改事实：原文字节。', replacement: '待修改事实：必须保留本次作者输入。' } })).operation!
    const claim = f.application.store.claimAttempt({ operationId: original.id, source: original.input.source, scope: original.scope, leaseMs: 60000 })
    const composed = composeControlledRequest(original.input, composeAuthoredInput(original.input).composed!, original.requestBlob!).composed!
    f.application.store.bindComposedInput(claim.fence, composed)
    const analysis = { version: 'code-behavior-v1', inputId: original.input.id, baselinePairId: null, composedDigest: composed.contentDigest, readSetDigest: original.readSetDigest, policyDigest: original.policyDigest, inputDigest: original.input.contentDigest, reviewPassed: true, changes: [], findings: [{ id: 'remaining-B', kind: 'conflict', ruleIds: ['RULE-DEMO-B'], affectedIds: ['REQ-DEMO-1'], paths: ['src/demo.mjs'], originalIntent: '保持文本', sourceBehavior: '转换大小写', deliveryBehavior: '保持文本', counterexample: 'a → A', evidence: 'src/demo.mjs', decision: '选择B规则' }], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [] }
    const analysisRef = writeEvidence(original.input.source.commonDir, analysis)
    f.application.store.checkpoint(claim.fence, analysisRef)
    f.application.store.checkpoint(claim.fence, writeEvidence(original.input.source.commonDir, { version: 'sync-stage-v1', operationId: original.id, attemptId: claim.attempt.id, inputId: original.input.id, policyDigest: original.policyDigest, stage: 'analysis', resultRef: analysisRef }))
    f.application.store.recordFailure(claim.fence, { code: 'business_conflict', message: 'B待决', kind: 'conflict', evidenceRefs: [analysisRef] })
    writeFileSync(join(f.root, path), placement === 'separate' ? authored.replace('未选义务：保持隔离。', '未选义务：保持隔离。\n已结算规则A：保留此前接受的计数。') : authored.replace('待修改事实：原文字节。', placement === 'same-line' ? '待修改事实：原文字节。 已结算规则A：保留此前接受的计数。' : '待修改事实：此前接受的事实。 已结算规则A：保留此前接受的计数。'))
    const delivery = await captureInputSnapshot(f.root)
    writeFileSync(join(f.root, path), authored)
    const pair: BaselinePair = { id: 'partial-A', repositoryId: original.input.source.repositoryId, source: original.input.source, sourceInput: original.input, verifiedDelivery: delivery, coveredScope: original.scope, receiptId: 'verified-partial-A', settledAtMs: Date.now() }
    const journal: ApplyJournal = { id: 'fixture-partial-A', operationId: original.id, attemptId: claim.attempt.id, generation: original.generation, status: 'settled', steps: [], createdAtMs: pair.settledAtMs,
      plan: { effectKey: 'fixture-partial-A', payloadDigest: 'fixture', candidateDigest: 'fixture', verificationBlob: writeEvidence(original.input.source.commonDir, { fixture: true }), target: delivery.source, expectedTargetSnapshotId: delivery.id, expectedBaselinePairId: null, coveredScope: original.scope, files: [], planBlob: writeEvidence(original.input.source.commonDir, { fixture: true }) },
      receipt: { id: pair.receiptId, journalId: 'fixture-partial-A', effectKey: 'fixture-partial-A', actualTree: delivery.immutableTree, actualCommit: null, deliverySnapshot: delivery, evidenceRefs: [], completedAtMs: pair.settledAtMs } }
    f.protocol.withTransaction(tx => {
      tx.exec('INSERT INTO sync_apply_journals(id,operation_id,attempt_id,effect_key,payload_digest,status,receipt_id,record_json) VALUES(?,?,?,?,?,?,?,?)', journal.id, original.id, claim.attempt.id, journal.plan.effectKey, journal.plan.payloadDigest, journal.status, pair.receiptId, JSON.stringify(journal))
      const sourceKey = String(tx.query('SELECT source_key FROM sync_operations WHERE id=?', original.id)[0].source_key)
      tx.exec('INSERT INTO sync_baseline_pairs(id,repository_id,source_key,receipt_id,settled_at_ms,record_json) VALUES(?,?,?,?,?,?)', pair.id, pair.repositoryId, sourceKey, pair.receiptId, pair.settledAtMs, JSON.stringify(pair))
    })
    const result = await f.application.decide({ requestId: 'remaining-choice-B', operationId: original.id, inputId: original.input.id, analysisRef, findingIds: ['remaining-B'], decision: { choice: 'new_rule', rule: '规则B：仅转换ASCII字母。' } })
    const plan = JSON.parse(readEvidence(original.input.source.commonDir, result.operation.planBlob!).toString('utf8'))
    const raw = plan.targets.find((target: { nodeId: string }) => target.nodeId === 'demo').rawSource
    if (placement === 'overlap-review') {
      assert.equal(raw, undefined, '暂选作者正文不得固定为raw覆盖后续独审结果')
      const decisionRef = result.operation.requestBlob!
      const composition = composeControlledRequest(original.input, composeAuthoredInput(original.input, pair, { retainConflicts: true }).composed!, decisionRef, { retainConflicts: true }).composed!
      assert.ok(composition.compositionEvidenceBlob)
      const evidence = JSON.parse(readEvidence(original.input.source.commonDir, composition.compositionEvidenceBlob).toString('utf8'))
      assert.ok(evidence.conflicts.some((conflict: { path: string }) => conflict.path === path))
    } else {
      assert.match(raw, /已结算规则A：保留此前接受的计数/)
      assert.match(raw, /未选义务：保持隔离/)
      assert.match(raw, /待修改事实：必须保留本次作者输入/)
      assert.match(raw, /规则B：仅转换ASCII字母/)
    }
    assert.equal(result.operation.previousBaselinePair?.id, pair.id)
    assert.equal(readFileSync(join(f.root, path), 'utf8'), authored)
  } finally { f.cleanup() }
  })
})
