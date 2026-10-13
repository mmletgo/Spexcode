import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openProtocol } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractCell, GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { prepareSyncAdmission, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { migrateSyncStore } from './migrations.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, readEvidence, writeEvidence } from './snapshot.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import { SyncStore } from './store.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { claimFileMutex } from './file-mutex.js'
import { guardControlledRequestPath, prepareControlledRequest } from './request-input.js'
import { prepareSpecBodyEdit } from '../spec-body-edit.js'

const contractPath = '.spec/project/export-contract/spec.md'
const fixturePath = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const original = readFileSync(new URL('.spec/export/export-contract/spec.md', fixturePath), 'utf8')
function rows(source: string, path = contractPath): GeneratedElaboration {
  const contract = parseContract({ nodeId: 'export-contract', path, source }).contract!
  const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
    const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
    const value = (item as unknown as Record<string, ContractCell>)[key]
    return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
  })))])) as GeneratedTables
  return { version: 'elaboration-rows-v1', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(source).fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(source)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定演示夹具的显式业务政策和原始范围', affectedIds: ['REQ-EXPORT-01'] })) }
}
type FrozenGenerationPrompt = { contracts: unknown[]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] }; files: [string, string][] }
const promptInput = (request: ElaborationSessionRequest): FrozenGenerationPrompt => JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as FrozenGenerationPrompt
function unlock(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) { chmodSync(join(root, entry.name), 0o700); unlock(join(root, entry.name)) }
  chmodSync(root, 0o700)
}
async function fixture(t: test.TestContext, budget = { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300_000 }, adopt = false, specSource = original, projectId = 'project', factsSource = specSource, planPatch: Partial<SyncCoordinatorPlan> = {}, controlledEdit?: { original: string; replacement: string; intent: string; testPath: string }) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-coordinator-'))), root = join(parent, 'source'), managedRoot = join(parent, 'managed'), artifactRoot = join(parent, 'artifacts')
  mkdirSync(root); mkdirSync(managedRoot, { mode: 0o700 }); mkdirSync(artifactRoot, { mode: 0o700 }); cpSync(fixturePath, root, { recursive: true })
  const targetPath = `.spec/${projectId}/export-contract/spec.md`
  if (projectId !== 'export') renameSync(join(root, '.spec/export'), join(root, `.spec/${projectId}`))
  writeFileSync(join(root, targetPath), specSource)
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [] }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'coordinator fixture'); git('config', 'user.email', 'coordinator@example.invalid'); git('add', '.'); git('commit', '-m', 'fixture')
  git('switch', '-c', 'node/source')
  if (adopt) {
    execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init', '.', '--harness', 'none'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
    git('add', '.'); git('commit', '-m', 'adopt explicit no-harness delivery')
  }
  const priorCommitCount = Number(git('rev-list', '--count', 'HEAD'))
  const sourcePath = join(root, 'src/export.js')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// staged user request\n`); git('add', 'src/export.js')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n// unstaged user request\n`)
  const input = await captureInputSnapshot(root), index = readFileSync(join(root, '.git/index')), bytes = readFileSync(sourcePath)
  const definition = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'VERIFY')!
  assert.equal(definition.kind, 'VERIFY')
  const plan: SyncCoordinatorPlan = { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: targetPath }], readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec', 'src'], facts: [{ source: 'decision:EXPORT-POLICY', text: factsSource }], verifications: [{ definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment: { version: 'trusted-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } }], mandatoryTests: [{ verificationId: definition.id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }] }
  Object.assign(plan, planPatch)
  let requestBlob
  if (controlledEdit) {
    plan.writePaths = [...plan.writePaths, controlledEdit.testPath]; plan.readPaths = [...plan.readPaths, controlledEdit.testPath]
    plan.verifications = [...plan.verifications, { ...plan.verifications[0], definition: { id: 'VERIFY-EXPORT-02', command: ['node', '--test', controlledEdit.testPath], cwd: '.', timeoutMs: 10000 } }]
    plan.facts = [...plan.facts, { source: 'decision:CONTROLLED-EDIT', text: controlledEdit.intent }]
    guardControlledRequestPath(input, targetPath)
    const lines = parseFrontmatter(readFileSync(join(root, targetPath), 'utf8')).body.trim().split('\n'), index = lines.indexOf(controlledEdit.original)
    assert.ok(index >= 0, '用户选中的原始正文行必须真实存在')
    const prepared = await prepareSpecBodyEdit(root, 'export-contract', { startLine: index + 1, endLine: index + 1, original: controlledEdit.original, replacement: controlledEdit.replacement })
    const request = prepareControlledRequest(input, prepared, { kind: 'user_edit', requestId: `controlled-${contentHash(controlledEdit.intent)}`, nodeId: 'export-contract', intent: controlledEdit.intent })
    assert.equal(request.changed, true); requestBlob = request.requestBlob!
  }
  const protocol = openProtocol(join(parent, 'sync.sqlite')); await migrateSyncStore(protocol, { backupPath: join(parent, 'db-backup') })
  let store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) })
  let operation = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: input.id, rootCauseId: input.id, origin: 'spec', budget, managedRoot, ...(requestBlob ? { requestBlob } : {}) }))
  const calls: ElaborationSessionRequest[] = []
  let transform: ((output: unknown, request: ElaborationSessionRequest) => unknown | Promise<unknown>) | undefined
  const run: ElaborationRunner = async request => {
    calls.push(request)
    let output: unknown
    if (request.purpose === 'elaboration_generate') output = rows(original, targetPath)
    else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), source = new Map(frozen.files).get('src/export.js')!
      const change = (path: string, content: string) => { const entry = frozen.manifest.entries.find(item => item.path === path)!; return { path, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content } }
      output = { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change('src/export.js', `${source}\n// independently reviewed generated implementation\n`)] }
    } else {
      const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n实际完整候选')[0]) as { inputId: string; candidate: { digest: string } }
      output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: promptInput(request).readyIds, findings: [] }
    }
    if (transform) output = await transform(output, request)
    const attempt = store.readAttempt(store.readOperation(operation.id).currentAttemptId!)
    const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `independent-thread-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const emptyTools = { trustedRuntimeRoot: join(parent, 'unset'), toolEntry: join(parent, 'unset/cli.js'), canonicalHooksDir: join(parent, 'unset/hooks') }
  const options: SyncCoordinatorOptions = { plan, readCurrentPlan: () => plan, managedRoot, artifactRoot, tools: emptyTools, runner: run, leaseMs: 30_000, heartbeatMs: 1000 }
  const realTools = async () => {
    const runtime = await freezeDeliveryRuntime(join(parent, 'runtime'))
    options.tools = { trustedRuntimeRoot: runtime.trustedRuntimeRoot, toolEntry: runtime.toolEntry, canonicalHooksDir: runtime.canonicalHooksDir, gitPath: '/usr/bin/git' }
    for (const name of readdirSync(runtime.canonicalHooksDir)) { copyFileSync(join(runtime.canonicalHooksDir, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755) }
    return runtime
  }
  let closed = false
  t.after(() => { if (!closed) protocol.close(); unlock(parent); rmSync(parent, { recursive: true, force: true }) })
  return { root, parent, managedRoot, artifactRoot, input, index, bytes, store, operation, plan, options, calls, git, priorCommitCount, realTools, closeForRestart: () => { protocol.close(); closed = true }, useStore: (next: SyncStore) => { store = next }, useOperation: (next: typeof operation) => { operation = next }, transform: (fn: typeof transform) => { transform = fn } }
}

test('可信目录授权/完整readset固定，同source不同policy不混，uncovered dirty和可改oracle拒绝', async t => {
  const f = await fixture(t)
  assert.equal(f.operation.policyDigest, syncPlanDigest(f.plan))
  assert.deepEqual(f.operation.scope.paths, ['.spec', 'src'])
  const options = { ingressKey: 'next', rootCauseId: 'next', origin: 'spec' as const, budget: f.operation.budget, managedRoot: f.managedRoot }
  await assert.rejects(prepareSyncAdmission(f.input, { ...f.plan, readPaths: ['.spec', 'tests'] }, options), /uncovered_source_change/)
  await assert.rejects(prepareSyncAdmission(f.input, { ...f.plan, writePaths: ['.spec', 'src', 'tests'] }, options), /oracle_binding/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('kernel mutex阻止同operation双编排，尚无native派发', async t => {
  const f = await fixture(t), locks = join(f.artifactRoot, '.locks'); mkdirSync(locks, { mode: 0o700 })
  const lock = claimFileMutex(join(locks, `${contentHash(f.operation.id)}.sqlite`))!
  try { assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'busy'); assert.equal(f.calls.length, 0) } finally { lock.release() }
})

test('缺planBlob的旧queued操作持久unsupported，不借当前计划猜恢复或派发', async t => {
  const f = await fixture(t)
  f.store.requestControl(f.operation.id, 'cancel'); f.store.discardDispatch(f.operation.id, f.operation.dispatchMessageId)
  const old = f.store.admitAndEnqueue({ ingressKey: 'legacy-planless', rootCauseId: 'legacy-planless', origin: 'spec', input: f.input, scope: f.operation.scope, budget: f.operation.budget, policyDigest: f.operation.policyDigest, impactDigest: f.operation.impactDigest, readSetDigest: f.operation.readSetDigest, delivery: null, deliveryPlan: f.operation.deliveryPlan })
  const result = await runSyncOperation(f.store, old.id, f.options)
  assert.equal(result.status, 'unsupported'); assert.equal(result.failure?.code, 'plan_missing')
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure!.code, 'plan_missing'); assert.equal(f.calls.length, 0)
})

test('真实V1/意图门禁拒绝弱化AC与命令，有限预算，不进入review/V3或业务交付', async t => {
  for (const mutation of ['assertion', 'command']) await t.test(mutation, async t => {
    const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 })
    f.transform((output, request) => {
      if (request.purpose !== 'code_generate') return output
      const value = output as { changes: { path: string; content: string }[] }
      const spec = value.changes.find(change => change.path === contractPath)!
      spec.content = mutation === 'assertion' ? spec.content.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限') : spec.content.replace('["node","--test","tests/export.test.mjs"]', '["node","-e","true"]')
      return value
    })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, 'budget_exhausted', JSON.stringify(result.failure))
    assert.equal(f.calls.filter(call => call.purpose === 'code_review').length, 0)
    for (const plan of f.store.readAttempt(result.operation.currentAttemptId!).dispatchPlans) if (plan.session) assert.deepEqual(Object.keys(plan.session).sort(), ['sessionId', 'threadId', 'turnId'])
    assert.ok(f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.validationFindings?.some((item: { code: string }) => item.code === 'generation-protected-meaning-changed' || item.code === 'generation-verification-unregistered')))
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
    assert.ok(f.store.pinnedBlobRefs().length > 3)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  })
})

test('租约heartbeat贯穿长调用，取消不派发下一阶段，重入不重复调用', async t => {
  const f = await fixture(t)
  f.options.leaseMs = 1500; f.options.heartbeatMs = 50
  f.transform(async (output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const expiry = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!).expiresAtMs
      await new Promise(resolve => setTimeout(resolve, 1800))
      assert.ok(f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!).expiresAtMs > expiry)
      f.store.requestControl(f.operation.id, 'cancel')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return output
  })
  const stopped = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(f.calls.length, 1)
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'cancelled')
  assert.equal(f.calls.length, 1); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

const docker = { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 240000 }
test('取消后的历史native未知创建回执保留资源与recovery_required，不假removed或重派发', async t => {
  const f = await fixture(t)
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 10000, expectedMessageId: f.operation.dispatchMessageId })
  const request = { root: f.root, base: f.input.headCommit, prompt: '固定资源恢复请求', schema: { type: 'object' }, requestKey: 'pending-created-native', inputDigest: contentHash('fixed-input'), purpose: 'elaboration_generate', timeoutMs: 10000 }
  const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const identity = { operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, candidateDigest: null }
  const plan: NativeRunPlan = { schemaVersion: 1, ...identity, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId }
  const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
  const plannedRef = writeEvidence(f.input.source.commonDir, checkpoint)
  const resource = f.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: plannedRef })
  const createdRef = writeEvidence(f.input.source.commonDir, { ...checkpoint, phase: 'created', nativeState: 'queued' })
  f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: plannedRef, checkpointRef: createdRef })
  f.store.requestControl(f.operation.id, 'cancel')
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'recovery_required'); assert.equal(result.operation.phase, 'cancelled')
  assert.equal(f.store.findResource(claimed.attempt.id, request.requestKey)!.phase, 'created')
  assert.equal(f.store.listRecoverableResources().length, 1); assert.equal(f.calls.length, 0)
})

test('真实Docker→真实固定CLI hooks→私有完整交付，source/index保留，receipt重入不重复native/commit', docker, async t => {
  const f = await fixture(t, undefined, true); await f.realTools()
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, attemptFailure: f.store.readAttempt(result.operation.currentAttemptId!).failure, commandEvidence: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => typeof value.status === 'number' || value.kind === 'private-delivery-prepare') }))
  assert.ok(result.receipt); assert.equal(f.calls.length, 4)
  assert.ok(readFileSync(join(result.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8').includes('independently reviewed'))
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  const replay = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.deepEqual(replay.receipt, result.receipt); assert.equal(f.calls.length, 4)
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  const automatic = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'new-automatic-ingress', rootCauseId: 'new-automatic-ingress', origin: result.operation.origin, budget: { ...result.operation.budget, maxCalls: 99 }, managedRoot: f.managedRoot, previousBaselinePair: f.store.readBaseline(f.input.source) })
  assert.notDeepEqual(automatic.deliveryPlan, result.operation.deliveryPlan)
  assert.notEqual(automatic.readSetDigest, result.operation.readSetDigest, '真实交付细化进入新composed读集合，但source未变')
  const unchanged = f.store.admitAndEnqueue(automatic)
  assert.equal(unchanged.id, result.operation.id); assert.equal(unchanged.callsUsed, 4); assert.equal(unchanged.budget.maxCalls, result.operation.budget.maxCalls)
  const aliasReplay = await prepareSyncAdmission(f.input, f.plan, { ingressKey: automatic.ingressKey, rootCauseId: automatic.rootCauseId, origin: unchanged.origin, budget: unchanged.budget, managedRoot: f.managedRoot, previousBaselinePair: unchanged.previousBaselinePair })
  assert.equal(f.store.admitAndEnqueue({ ...aliasReplay, deliveryPlan: unchanged.deliveryPlan }).id, unchanged.id)
  assert.equal(f.store.listOperations(f.input.source.repositoryId).length, 1); assert.equal(f.store.nextDispatch(f.input.source.repositoryId), null)
})

test('真实断言失败进入新attempt有限修复，保留失败输出，成功四层证据并同预算结算', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限'))
    }
    if (request.purpose !== 'code_generate') return output
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    if (attempt.number === 1) {
      const value = output as { changes: { path: string; content: string }[] }
      value.changes.find(change => change.path === 'src/export.js')!.content = value.changes.find(change => change.path === 'src/export.js')!.content.replace("if (!actor) throw new Error('forbidden');", "if (actor) throw new Error('forbidden');")
    } else assert.ok(request.prompt.includes('verification_failed'))
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(result.failure))
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).number, 2)
  assert.equal(result.operation.callsUsed, 6); assert.equal(p1Calls, 1); assert.equal(f.store.listRecoverableResources().length, 0)
  const inputs = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(inputs[0].contracts)), contentHash(JSON.stringify(inputs[1].contracts)))
  assert.deepEqual(inputs[0].elaboratedSpecs, inputs[1].elaboratedSpecs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('V4复采发现输入中途变化，无业务journal/commit，原staged index不变', docker, async t => {
  const f = await fixture(t); await f.realTools()
  f.transform((output, request) => { if (request.purpose === 'code_review') writeFileSync(join(f.root, 'src/export.js'), `${f.bytes.toString()}\n// new human edit during validation\n`); return output })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.failure?.code, 'input_changed')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('真实commit后DB未settle中断，恢复既有journal不重复生成/提交', docker, async t => {
  const f = await fixture(t); await f.realTools()
  const failed = await runSyncOperation(f.store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('actual commit crash') } } })
  assert.equal(failed.status, 'recovery_required', JSON.stringify(failed.failure))
  const commit = f.git('rev-parse', failed.operation.deliveryPlan.branch)
  const recovered = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(f.calls.length, 4); assert.equal(Number(f.git('rev-list', '--count', failed.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
})

test('GAP只阻重试业务分支，共享文件仍真实交付ready完整FLOW，receipt不含blocked IDs', docker, async t => {
  const gapSource = `${original}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-RETRY | missing_fact | 是否允许失败后重试 | RULE-EXPORT-06,TR-EXPORT-FAILED-RETRY,AC-EXPORT-08 | 用户未定义重试政策 | 明确重试权限及attempt身份 | user:raw | REQ-EXPORT-01 |\n`
  const f = await fixture(t, undefined, false, gapSource); await f.realTools()
  f.transform((output, request) => request.purpose === 'elaboration_generate' ? rows(gapSource) : request.purpose === 'elaboration_review' ? { verdict: 'needs_input', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'retry_policy', kind: 'missing_fact', message: '重试政策需要用户确认', affectedIds: ['RULE-EXPORT-06'], evidence: 'raw未明确失败后恢复政策', decision: '明确重试政策' }] } : output)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'needs_input', JSON.stringify({ failure: result.failure, stages: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => value.rounds || value.validationFindings).map(value => ({ status: value.status, failure: value.failure, findings: value.validationFindings ?? value.rounds.flatMap((round: { findings: unknown[] }) => round.findings), blocked: value.blockedStructureFindings })) })); assert.ok(result.receipt)
  assert.ok(result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-01'))
  assert.ok(!result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-02'))
  assert.ok(!result.operation.deliveredScope.contractIds.includes('AC-EXPORT-08'))
  assert.ok(result.operation.blockedScope.contractIds.includes('GAP-EXPORT-RETRY'))
  assert.deepEqual(result.operation.blockedScope.paths, [])
  assert.deepEqual(result.operation.readyScope.paths, ['.spec', 'src'])
  const callCount = f.calls.length
  assert.deepEqual((await runSyncOperation(f.store, f.operation.id, f.options)).receipt, result.receipt)
  assert.equal(f.calls.length, callCount)
})

test('真实V3失败后SQLite重启复用首个accepted P1，新的弱化AC不会再次被细化批准', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let activeStore = f.store, p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限'))
    }
    if (request.purpose === 'code_generate' && activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!).number === 1) {
      const value = output as { changes: { path: string; content: string }[] }
      const source = value.changes.find(change => change.path === 'src/export.js')!
      source.content = source.content.replace("if (!actor) throw new Error('forbidden');", "if (actor) throw new Error('forbidden');")
    }
    return output
  })
  const claim = f.store.claimAttempt.bind(f.store)
  f.store.claimAttempt = request => {
    if (f.store.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'verification_failed')) throw new Error('restart fault after actual failed V3 and durable recordFailure')
    return claim(request)
  }
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'failed'); assert.equal(first.failure?.code, 'verification_failed'); assert.equal(first.operation.callsUsed, 4)
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite'))
  t.after(() => protocol.close())
  const restarted = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) })
  activeStore = restarted; f.useStore(restarted)
  const resumed = await runSyncOperation(restarted, f.operation.id, f.options)
  assert.equal(resumed.status, 'workspace_synced', JSON.stringify(resumed.failure)); assert.equal(resumed.operation.callsUsed, 6); assert.equal(p1Calls, 1)
  const inputs = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(inputs[0].contracts)), contentHash(JSON.stringify(inputs[1].contracts)))
  assert.deepEqual(inputs[0].elaboratedSpecs, inputs[1].elaboratedSpecs)
  const second = restarted.readAttempt(resumed.operation.currentAttemptId!)
  assert.ok(second.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.fromAttemptId && value.evidenceRef && value.candidateDigest))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('高层raw无未来IDs，目录授权自动新增absent模块与治理叶，reader-app真实adopter完整交付', docker, async t => {
  const raw = parseParts(original)!.rawSource
  const highLevel = `---\ntitle: 导出事件服务契约\nstatus: active\n---\n# 导出事件服务契约\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n尚待依据可信业务政策完整细化。\n`
  const childPath = '.spec/reader-app/export-request-key/spec.md', childRaw = '由 [[export-contract]] 的 RULE-EXPORT-02 幂等键义务派生；actor/key组合必须保持碰撞安全，禁止用字符串冒号拼接混淆组合。'
  const f = await fixture(t, undefined, true, highLevel, 'reader-app', original, { newNodeRawSources: [{ path: childPath, rawSource: childRaw }] })
  await f.realTools()
  assert.deepEqual(f.operation.scope.contractIds, []); assert.deepEqual(f.operation.scope.flowIds, [])
  assert.ok(!highLevel.includes('AC-EXPORT-01')); assert.ok(!existsSync(join(f.root, 'src/request-key.js')))
  f.transform((output, request) => {
    if (request.purpose !== 'code_generate') return output
    const value = output as { version: string; changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: null; content: string }[] }
    const source = value.changes.find(change => change.path === 'src/export.js')!
    assert.ok(source.content.includes('const identity = JSON.stringify([actor, key]);'))
    source.content = `import { requestKey } from './request-key.js';\n${source.content.replace('const identity = JSON.stringify([actor, key]);', 'const identity = requestKey(actor, key);')}`
    value.changes.push({ path: 'src/request-key.js', beforeDigest: null, beforeMode: null, mode: null, content: 'export function requestKey(actor, key) { return JSON.stringify([actor, key]); }\n' })
    value.changes.push({ path: childPath, beforeDigest: null, beforeMode: null, mode: null, content: `---\ntitle: 导出请求幂等键\nstatus: active\ncode:\n  - src/request-key.js#requestKey\n---\n# 导出请求幂等键\n\n## raw source\n\n${childRaw}\n\n## expanded spec\n\n将actor与key作为JSON数组编码，使每个字符串组合具有无歧义身份。\n` })
    return value
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(result.failure)); assert.ok(result.receipt)
  assert.ok(result.operation.scope.contractIds.includes('REQ-EXPORT-01')); assert.ok(result.operation.scope.contractIds.includes('AC-EXPORT-08')); assert.ok(result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-02'))
  const delivery = result.operation.deliveryPlan.canonicalRoot
  assert.ok(readFileSync(join(delivery, 'src/request-key.js'), 'utf8').includes('JSON.stringify'))
  assert.ok(readFileSync(join(delivery, 'src/export.js'), 'utf8').includes('const identity = requestKey(actor, key);'))
  assert.equal(parseParts(readFileSync(join(delivery, childPath), 'utf8'))!.rawSource, childRaw)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  assert.equal(f.calls.length, 4); assert.equal(result.operation.planBlob!.sha256, result.operation.policyDigest)
  assert.ok(f.store.pinnedBlobRefs().some(ref => ref.sha256 === result.operation.policyDigest))
})

test('V4初次通过后准备期间再次编辑source，beforeApply保留typed冲突且未开始业务journal', docker, async t => {
  const f = await fixture(t); await f.realTools()
  let checks = 0
  f.options.readCurrentPlan = () => {
    checks++
    if (checks === 1) writeFileSync(join(f.root, 'src/export.js'), `${f.bytes.toString()}\n// actual user edit after first V4 observation\n`)
    return f.plan
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.failure?.code, 'input_changed')
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure?.kind, 'conflict')
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.ok(existsSync(join(result.operation.deliveryPlan.canonicalRoot, '.git')))
  assert.ok(!readFileSync(join(result.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8').includes('independently reviewed generated'))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const variant of ['raw', 'TR'] as const) test(`AC-SYNC-${variant === 'raw' ? '02' : '03'} 受控请求修改已有${variant}并更新实际AC/实现/测试，未受影响作者内容保留`, docker, async t => {
  const marker = '作者保留：下载权限与首次结果发布规则独立于本次编辑。'
  const source = original.replace('适用域：', `${marker}\n\n适用域：`), oldRaw = parseParts(source)!.rawSource, testPath = 'tests/controlled-request.test.mjs'
  const tr = source.split('\n').find(line => line.startsWith('| TR-EXPORT-FAILED-RETRY |'))!
  const intent = variant === 'raw' ? '筛选字符串最多128字符，超过128字符明确拒绝且不创建任务，原有输入边界保持。' : '失败后所有者重试时，在清除reason前保存lastFailureReason供后续诊断；ID和attempt隔离及原权限政策保持。'
  const originalLine = variant === 'raw' ? oldRaw : tr, replacement = variant === 'raw' ? `${oldRaw} ${intent}` : tr.replace('attempt加一并清除原因', 'attempt加一，lastFailureReason保存原reason后清除reason')
  const accepted = source.replace(originalLine, replacement)
    .replace(variant === 'raw' ? 'key与非空字符串filter必需' : '保持ID，attempt加一并清除失败原因', variant === 'raw' ? 'key与非空字符串filter必需且filter长度最多128字符' : '保持ID，attempt加一，lastFailureReason保存原reason后清除失败原因')
    .replace(variant === 'raw' ? '明确拒绝，状态不变' : 'ID保持、attempt增加，旧结果无效', variant === 'raw' ? '非法输入或filter超过128字符明确拒绝且不创建任务；空结果回调拒绝且状态不变' : 'ID保持、attempt增加，lastFailureReason保留重试前原因，reason清空，旧结果无效')
    .replace(variant === 'raw' ? 'tests/export.test.mjs#AC-EXPORT-02 | VERIFY-EXPORT-01' : 'tests/export.test.mjs#AC-EXPORT-08 | VERIFY-EXPORT-01', `${testPath}#AC-EXPORT-${variant === 'raw' ? '02' : '08'} | VERIFY-EXPORT-02`)
    .replace('| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |', `| VERIFY-EXPORT-01 | ["node","--test","tests/export.test.mjs"] | . | 10000 |\n| VERIFY-EXPORT-02 | ["node","--test","${testPath}"] | . | 10000 |`)
  const f = await fixture(t, undefined, true, source, 'reader-app', source, {}, { original: originalLine, replacement, intent, testPath }); await f.realTools()
  delete f.options.leaseMs
  const sourceSpecBytes = readFileSync(join(f.root, '.spec/reader-app/export-contract/spec.md')), oracleBytes = readFileSync(join(f.root, 'tests/export.test.mjs'))
  const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ExportService } from '../src/export.js';\n${variant === 'raw' ? `test('AC-EXPORT-02 原输入和结果边界及128字符限制', () => {\n const service = new ExportService();\n assert.throws(() => service.submit('', 'key', 'active'), /forbidden/);\n assert.throws(() => service.submit('owner', '', 'active'), /invalid-request/);\n assert.throws(() => service.submit('owner', 'key', ''), /invalid-request/);\n assert.throws(() => service.submit('owner', 'key', 'x'.repeat(129)), /invalid-request/);\n assert.equal(service.jobs.size, 0);\n const job = service.submit('owner', 'key', 'x'.repeat(128));\n assert.throws(() => service.dispatch(job.id, 'DOWNLOAD', {actor:'owner'}), /not-ready/);\n service.dispatch(job.id, 'START', {attempt:1});\n assert.throws(() => service.dispatch(job.id, 'COMPLETE', {attempt:1,result:''}), /invalid-result/);\n assert.throws(() => service.dispatch(job.id, 'FAIL', {attempt:1,reason:''}), /invalid-reason/);\n assert.equal(service.jobs.get(job.id).state, 'RUNNING');\n});` : `test('AC-EXPORT-08 重试保存失败诊断且旧attempt不能发布', () => {\n const service = new ExportService(), job = service.submit('owner','key','active');\n service.dispatch(job.id,'START',{attempt:1});\n service.dispatch(job.id,'FAIL',{attempt:1,reason:'source-unavailable'});\n const retried = service.dispatch(job.id,'RETRY',{actor:'owner'});\n assert.equal(retried.id,job.id); assert.equal(retried.attempt,2);\n assert.equal(retried.lastFailureReason,'source-unavailable'); assert.equal(retried.reason,null);\n service.dispatch(job.id,'COMPLETE',{attempt:1,result:'stale.csv'});\n assert.equal(service.jobs.get(job.id).state,'QUEUED');\n service.dispatch(job.id,'START',{attempt:2});\n service.dispatch(job.id,'COMPLETE',{attempt:2,result:'fresh.csv'});\n assert.equal(service.dispatch(job.id,'DOWNLOAD',{actor:'owner'}),'fresh.csv');\n});`}\n`
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') { assert.ok(request.prompt.includes(intent)); return rows(accepted, '.spec/reader-app/export-contract/spec.md') }
    if (request.purpose === 'code_generate') {
      const value = output as { changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: null; content: string }[] }, implementation = value.changes.find(change => change.path === 'src/export.js')!
      assert.ok(request.prompt.includes(variant === 'raw' ? 'filter长度最多128字符' : 'lastFailureReason保留重试前原因'))
      assert.ok(request.prompt.includes(variant === 'raw' ? '明确拒绝，状态不变' : 'ID保持、attempt增加，旧结果无效'), '旧AC作为独立审查对照而非锁住新意图')
      implementation.content = variant === 'raw' ? implementation.content.replace("!filter.trim())", "!filter.trim() || filter.length > 128)") : implementation.content.replace('job.reason = null;', 'job.lastFailureReason = job.reason;\n        job.reason = null;')
      value.changes.push({ path: testPath, beforeDigest: null, beforeMode: null, mode: null, content: testSource }); return value
    }
    if (request.purpose === 'code_review') { assert.ok(request.prompt.includes(intent)); assert.ok(request.prompt.includes(marker)); assert.ok(request.prompt.includes(testSource.split('\n')[3].split("'", 2)[1])) }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, phase: result.operation.phase, refs: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => value.rounds || value.validationFindings).map(value => ({ status: value.status, findings: value.validationFindings ?? value.rounds.flatMap((round: { findings: unknown[] }) => round.findings) })) }))
  assert.equal(result.operation.callsUsed, 4); assert.ok(result.operation.requestBlob); assert.equal(result.operation.input.id, f.input.id)
  assert.ok(result.operation.deliveredScope.contractIds.includes(`AC-EXPORT-${variant === 'raw' ? '02' : '08'}`))
  assert.equal(Number(f.git('rev-list', '--count', result.operation.deliveryPlan.branch)), f.priorCommitCount + 1)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  const deliveredSpec = f.git('show', `${result.receipt!.actualCommit}:.spec/reader-app/export-contract/spec.md`)
  assert.ok(deliveredSpec.includes(marker)); assert.ok(deliveredSpec.includes(replacement)); assert.ok(deliveredSpec.includes(variant === 'raw' ? 'filter长度最多128字符' : 'lastFailureReason保留重试前原因'))
  for (const id of ['RULE-EXPORT-01', 'AC-EXPORT-03', 'AC-EXPORT-07']) assert.equal(deliveredSpec.split('\n').find(line => line.startsWith(`| ${id} |`)), source.split('\n').find(line => line.startsWith(`| ${id} |`)))
  assert.equal(f.git('show', `${result.receipt!.actualCommit}:${testPath}`), testSource.trim())
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.spec/reader-app/export-contract/spec.md')), sourceSpecBytes); assert.deepEqual(readFileSync(join(f.root, 'tests/export.test.mjs')), oracleBytes)
  assert.equal(f.store.listRecoverableResources().length, 0)
  const verification = f.store.readAttempt(result.operation.currentAttemptId!).verification!
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, verification.resultBlob).toString()).layers.find((layer: { layer: string }) => layer.layer === 'V3').evidenceRefs.length, 2)
})

test('显式retryOf在SQLite重启后继承无未来IDs输入的accepted P1，新预算不授权再次细化AC', async t => {
  const raw = parseParts(original)!.rawSource, source = `---\ntitle: 导出事件服务契约\nstatus: active\n---\n# 导出事件服务契约\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n待细化。\n`
  const f = await fixture(t, undefined, false, source, 'project', original)
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') { p1Calls++; if (p1Calls > 1) return rows(original.replace('全部拒绝，原结果可由所有者下载', '无条件允许')) }
    if (request.purpose === 'code_generate') throw Object.assign(new Error('可观察的原生构建器不支持，尚未创建候选'), { code: 'unsupported' })
    return output
  })
  const failed = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(failed.operation.phase, 'failed'); assert.equal(failed.operation.callsUsed, 3); assert.equal(p1Calls, 1)
  assert.equal(f.store.readRetryEligibility(failed.operation.id).eligible, true)
  f.closeForRestart()
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const restarted = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(restarted)
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'explicit-user-retry', rootCauseId: 'explicit-user-retry', retryOf: failed.operation.id, origin: failed.operation.origin, budget: failed.operation.budget, managedRoot: f.managedRoot, previousBaselinePair: failed.operation.previousBaselinePair })
  assert.equal(admission.retryOf, failed.operation.id)
  const retry = restarted.admitAndEnqueue(admission); f.useOperation(retry)
  const repeated = await runSyncOperation(restarted, retry.id, f.options)
  assert.equal(repeated.operation.phase, 'failed'); assert.equal(repeated.operation.callsUsed, 1); assert.equal(p1Calls, 1)
  const generation = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(generation[0].contracts)), contentHash(JSON.stringify(generation[1].contracts)))
  assert.deepEqual(generation[0].elaboratedSpecs, generation[1].elaboratedSpecs)
  const current = restarted.readAttempt(repeated.operation.currentAttemptId!)
  assert.ok(current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.fromOperationId === failed.operation.id && value.fromAttemptId && value.evidenceRef))
  assert.equal(restarted.readOperation(failed.operation.id).callsUsed, 3); assert.equal(restarted.listJournals(retry.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})
