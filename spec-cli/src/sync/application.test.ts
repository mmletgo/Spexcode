import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openProtocol } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { SyncApplication } from './application.js'
import { buildSyncApplicationPlan } from './planning.js'
import { captureInputSnapshot } from './snapshot.js'
import { readSyncSettings } from './settings.js'
import type { SyncSettings } from './settings.js'
import type { ContractCell, GeneratedTables } from './elaboration-markdown.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationSessionRequest } from './elaboration-types.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { contentHash, identifyWorktree, writeEvidence } from './snapshot.js'
import { claimFileMutex } from './file-mutex.js'
import type { FileMutex } from './file-mutex.js'

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
    await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: 'code', origin: 'code' as 'spec' }), /当前入口接受 Spec/)
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

test('AC-APPLICATION-18 已停止操作仍有未结算资源时不能展示ready或借retry新预算', async () => {
  const f = await fixture()
  const application = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime'), tools: { trustedRuntimeRoot: '/missing-runtime', toolEntry: '/missing-runtime/cli.js', canonicalHooksDir: '/missing-runtime/hooks' }, runner: async request => {
    const operation = f.application.store.listOperations(identifyWorktree(f.root).repositoryId)[0], attempt = f.application.store.readAttempt(operation.currentAttemptId!)
    const dispatch = attempt.dispatchPlans.find(plan => plan.key === request.requestKey)!
    const { signal: _signal, ...frozen } = request
    const requestDigest = contentHash(JSON.stringify(frozen)), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, candidateDigest: null }
    const plan = { schemaVersion: 1, request: frozen, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    const checkpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
    f.application.store.planResource({ operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: operation.input.id, candidateDigest: null, planBlob: writeEvidence(operation.input.source.commonDir, plan), checkpointRef: writeEvidence(operation.input.source.commonDir, checkpoint) })
    throw Object.assign(new Error('受控创建结果未知'), { code: 'unsupported' })
  } })
  try {
    await application.enable()
    const submitted = await application.submit({ nodeId: 'demo', requestId: 'pending-native-resource' }); assert.ok(submitted.operation)
    const failed = await application.wait(submitted.operation.id)
    assert.equal(failed.operation.phase, 'failed'); assert.equal(failed.resources[0]?.phase, 'planned')
    assert.equal(failed.executionAvailability.status, 'recovery_required'); assert.equal(failed.executionAvailability.failure?.code, 'sync_resources_unsettled')
    assert.equal(failed.retryEligibility.eligible, false); assert.ok(failed.retryEligibility.reason?.code)
    await assert.rejects(application.submit({ nodeId: 'demo', requestId: 'retry-unknown-resource', retryOf: failed.operation.id }))
    const paused = await application.control(failed.operation.id, 'pause')
    assert.equal(paused.operation.phase, 'paused'); assert.equal(paused.executionAvailability.status, 'recovery_required')
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
