import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyComponentMigrations, openProtocol, type SqlParam } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractCell, GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { sameContractBusinessMeaning } from './contract-evolution.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import { elaborate } from './elaboration.js'
import type { ElaborationResult, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { buildSyncApplicationPlan } from './planning.js'
import { SyncApplication } from './application.js'
import { isSyncInputCurrent, prepareSyncAdmission, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { migrateSyncStore, SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress } from './migrations.js'
import { dockerVerificationDriver } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationCommandResult } from './verification-executor-types.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import { SyncStore } from './store.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { claimFileMutex } from './file-mutex.js'
import { controlledDecisionIdentity, guardControlledRequestPath, prepareControlledDecision, prepareControlledRequest } from './request-input.js'
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
  return { version: 'elaboration-rows-v2', changes: [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(source).fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(source)!.expandedSpec.split(/^### /m)[0], tables, removeIds: [] }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定演示夹具的显式业务政策和原始范围', affectedIds: ['REQ-EXPORT-01'] })) }
}
type FrozenGenerationPrompt = { contracts: unknown[]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] }; files: [string, string][] }
const promptInput = (request: ElaborationSessionRequest): FrozenGenerationPrompt => JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as FrozenGenerationPrompt
function unlock(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) { chmodSync(join(root, entry.name), 0o700); unlock(join(root, entry.name)) }
  chmodSync(root, 0o700)
}
async function fixture(t: test.TestContext, budget = { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300_000 }, adopt = false, specSource = original, projectId = 'project', factsSource = specSource, planPatch: Partial<SyncCoordinatorPlan> = {}, controlledEdit?: { original: string; replacement: string; intent: string; testPath: string }, origin: 'spec' | 'code' | 'combined' = 'spec') {
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
  let operation = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: input.id, rootCauseId: input.id, origin, budget, managedRoot, ...(requestBlob ? { requestBlob } : {}) }))
  const calls: ElaborationSessionRequest[] = []
  let transform: ((output: unknown, request: ElaborationSessionRequest) => unknown | Promise<unknown>) | undefined
  const run: ElaborationRunner = async request => {
    calls.push(request)
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      output = { changes: context.changedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: ['RULE-EXPORT-05'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '遵守导出明确原意', previousBehavior: '导出任务结果不变', sourceBehavior: '内部实现文字编辑，导出结果不变', deliveryBehavior: '共同已验证语义不变', evidence: `冻结源码/断言 ${path}`, counterexample: '重复COMPLETE保首次结果，未改变此断言' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const value = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: { changes: { id: string }[] } }
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      output = { inputDigest: request.inputDigest, analysisDigest: value.analysisDigest, verdict: 'accept', checkedPaths: context.changedPaths, checkedChangeIds: value.analysis.changes.map(item => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') output = rows(original, targetPath)
    else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), source = new Map(frozen.files).get('src/export.js')!
      const change = (path: string, content: string) => { const entry = frozen.manifest.entries.find(item => item.path === path)!; return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, mode: entry ? null : '100644', content } }
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

test('P4精确接入使用同一快照并区分读取基线与实际写入范围', async t => {
  const f = await fixture(t)
  const selected = f.store.readBaselineSelection(f.input.source, [{ kind: 'path', path: contractPath }, { kind: 'path', path: 'src/export.js' }, { kind: 'path', path: 'tests/export.test.mjs' }])
  assert.ok('selection' in selected)
  const scope = { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] }
  const options = { ingressKey: 'selected-admission', rootCauseId: 'selected-admission', origin: 'spec' as const, budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }
  await assert.rejects(prepareSyncAdmission(f.input, f.plan, options), /execution_scope_missing/)
  const admission = await prepareSyncAdmission(f.input, { ...f.plan, executionScope: scope }, options)
  assert.equal(admission.input, f.input)
  assert.deepEqual(admission.baselineSelection, selected.selection)
  assert.deepEqual(admission.scope, scope)
  assert.notEqual(admission.readSetDigest, f.operation.readSetDigest)
  assert.equal(admission.scope.paths.includes('tests/export.test.mjs'), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('P4当前输入只比较实际闭包，保留无关编辑与提交并拒绝相关index变化', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, 'src/export.js', 'tests/export.test.mjs', '.spec/spexcode.json'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const result = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in result)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'current-closure', rootCauseId: 'current-closure', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: result.selection }))
  writeFileSync(join(f.root, 'notes.txt'), '作者的独立说明\n')
  f.git('add', 'notes.txt'); f.git('commit', '--only', 'notes.txt', '-m', 'unrelated author commit')
  const current = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index'))
  assert.notEqual(current.id, operation.input.id)
  assert.equal(await isSyncInputCurrent(operation, current, plan), true)
  assert.equal(await isSyncInputCurrent(f.operation, current, f.plan), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  f.git('add', 'src/export.js')
  const staged = await captureInputSnapshot(f.root)
  assert.equal(staged.immutableTree, current.immutableTree)
  assert.equal(await isSyncInputCurrent(operation, staged, plan), false)
})

test('kernel mutex阻止同operation双编排，尚无native派发', async t => {
  const f = await fixture(t), locks = join(f.artifactRoot, '.locks'); mkdirSync(locks, { mode: 0o700 })
  const lock = claimFileMutex(join(locks, `${contentHash(f.operation.id)}.sqlite`))!
  try { assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'busy'); assert.equal(f.calls.length, 0) } finally { lock.release() }
})

for (const mode of ['live', 'restart', 'prior-repair'] as const) test(`P3细化独审容量失败 ${mode} 同预算重新独立细化，不把未拒候选当业务seed`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  let activeStore = f.store
  const capacityAttempt = mode === 'prior-repair' ? 2 : 1, originalBudget = structuredClone(f.operation.budget), originalDeadline = f.operation.deadlineAtMs
  f.transform((output, request) => {
    const number = activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!).number
    if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: 'allowed_change' })) }
    if (request.purpose === 'elaboration_generate') {
      if (number === capacityAttempt) {
        if (mode === 'prior-repair') assert.match(request.prompt, /原具体失败:[\s\S]*result_boundary_missing/)
        const candidate = structuredClone(output) as GeneratedElaboration
        candidate.changes[0].tables.AC.push({ ...candidate.changes[0].tables.AC[0], id: 'AC-EXPORT-SUMMARY-01', test: 'tests/export.test.mjs#TEST-EXPORT-SUMMARY-01' })
        return candidate
      }
      if (number > capacityAttempt) assert.doesNotMatch(request.prompt, /已结算的拒绝候选|result_boundary_missing/)
    }
    if (request.purpose === 'elaboration_review') {
      if (number === capacityAttempt) throw Object.assign(new Error('Selected model is at capacity. Please try a different model.'), { code: 'failed' })
      if (mode === 'prior-repair' && number === 1) return { ...(output as object), verdict: 'repair', findings: [{ code: 'result_boundary_missing', kind: 'repair', message: '应核对重复完成边界', affectedIds: ['RULE-EXPORT-05'], evidence: '冻结结果政策要求首次结果稳定', decision: '保持原结果义务并重新独审' }] }
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#ExportService', evidence: '测试只验证容量失败后的真实协调续行', counterexample: '不冒称Docker或交付已通过', message: 'fixture stops before V3' }] }
    return output
  })
  if (mode === 'restart') {
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'failed')) throw new Error('fixture process boundary after durable capacity failure')
      return claim(request)
    }
    const interrupted = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.failure?.code, 'failed'); assert.equal(interrupted.operation.callsUsed, 4)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(result.receipt, undefined)
  assert.deepEqual(result.operation.budget, originalBudget); assert.equal(result.operation.deadlineAtMs, originalDeadline)
  assert.equal(result.operation.callsUsed, mode === 'prior-repair' ? 10 : 8)
  const attempts = activeStore.listAttempts(f.operation.id)
  assert.equal(attempts.length, capacityAttempt + 1)
  const elaborations = attempts.map(attempt => {
    const stage = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
    return JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
  })
  const rejected = elaborations[capacityAttempt - 1], fresh = elaborations[capacityAttempt]
  assert.equal(rejected.structurePassed, true); assert.equal(rejected.reviewPassed, false); assert.equal(rejected.rounds[0].review, null)
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'missing-test-case' && issue.severity === 'error'))
  assert.equal(rejected.failure?.code, 'failed'); assert.equal(fresh.reviewPassed, true); assert.equal(fresh.prior, null)
  assert.equal(fresh.inputDigest, rejected.inputDigest); assert.equal(fresh.rounds[0].traces.length, 2)
  assert.notEqual(fresh.rounds[0].traces[0].sessionId, fresh.rounds[0].traces[1].sessionId)
  assert.notEqual(fresh.rounds[0].traces[0].sessionId, rejected.rounds[0].traces[0].sessionId)
  if (mode === 'live') {
    const { execution, files, ...frozen } = JSON.parse(f.calls.find(call => call.purpose === 'elaboration_generate')!.prompt.split('冻结业务输入:\n')[1])
    const last = rejected.rounds[0]
    await assert.rejects(elaborate({ ...frozen, ...execution, files: new Map<string, string>(files), requestKey: 'invalid-infrastructure-seed' }, { seed: { settled: true, requestKey: `sync:${attempts[0].id}:elaborate`, inputDigest: rejected.inputDigest, candidateDigest: last.candidateDigest!, candidate: last.candidate!, output: last.output, findings: last.findings, review: last.review, traces: last.traces }, runner: async () => assert.fail('无具体业务拒绝的seed不得派发') }), /续修种子必须保留具体被拒绝发现/)
  }
  if (mode === 'prior-repair') { assert.equal(elaborations[0].failure?.code, 'repair_budget_exhausted'); assert.ok(rejected.prior); assert.equal(elaborations[0].reviewPassed, false) }
  const beforeReplay = f.calls.length
  assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'conflicted'); assert.equal(f.calls.length, beforeReplay)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal((await captureInputSnapshot(f.root)).id, f.input.id); assert.equal(activeStore.listJournals(f.operation.id).length, 0)
})

for (const stop of ['budget', 'cancel'] as const) test(`P3细化独审容量失败 ${stop} 保冻结终止，不重复派发`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 4, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_review') {
      if (stop === 'cancel') f.store.requestControl(f.operation.id, 'cancel')
      throw Object.assign(new Error('Selected model is at capacity. Please try a different model.'), { code: 'failed' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, stop === 'budget' ? 'budget_exhausted' : 'cancelled', JSON.stringify(result.failure)); assert.equal(result.operation.callsUsed, 4)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, result.status); assert.equal(f.calls.length, 4)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('缺planBlob的旧queued操作持久unsupported，不借当前计划猜恢复或派发', async t => {
  const f = await fixture(t)
  f.store.requestControl(f.operation.id, 'cancel'); f.store.discardDispatch(f.operation.id, f.operation.dispatchMessageId)
  const old = f.store.admitAndEnqueue({ ingressKey: 'legacy-planless', rootCauseId: 'legacy-planless', origin: 'spec', input: f.input, scope: f.operation.scope, budget: f.operation.budget, policyDigest: contentHash('legacy-planless-policy'), impactDigest: f.operation.impactDigest, readSetDigest: f.operation.readSetDigest, delivery: null, deliveryPlan: f.operation.deliveryPlan })
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
  assert.equal(stopped.status, 'cancelled', JSON.stringify(stopped.failure))
  assert.equal(f.calls.length, 1)
  assert.equal((await runSyncOperation(f.store, f.operation.id, f.options)).status, 'cancelled')
  assert.equal(f.calls.length, 1); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

const docker = { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 240000 }

test('P4精确queued经已审null扩展、四层Docker验证与真实receipt保持原始index', docker, async t => {
  const f = await fixture(t); await f.realTools()
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-docker-ready', rootCauseId: 'p4-docker-ready', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  const unacknowledged = await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(unacknowledged.status, 'busy'); assert.equal(f.calls.length, 0)
  for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === operation.id) break }
  const result = await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ result, attempts: f.store.listAttempts(operation.id).map(attempt => attempt.failure) }))
  assert.ok(result.receipt)
  assert.notEqual(result.operation.baselineSelection!.digest, selected.selection.digest)
  assert.ok(result.operation.contractScopeExpansions!.some(expansion => expansion.contractIds.includes('AC-EXPORT-03')))
  const attempt = f.store.readAttempt(result.operation.currentAttemptId!), verification = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString())
  assert.equal(verification.baselineSelectionDigest, result.operation.baselineSelection!.digest)
  assert.equal(verification.layers.every((layer: { verdict: string }) => layer.verdict === 'pass'), true)
  assert.equal(f.store.listJournals(operation.id)[0].plan.expectedBaselineSelectionDigest, result.operation.baselineSelection!.digest)
  assert.equal(result.operation.deliveredScope.paths.includes('tests/export.test.mjs'), false)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})
test('取消后的历史native未知创建回执保留资源与recovery_required，不假removed或重派发', async t => {
  const f = await fixture(t)
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 10000, expectedMessageId: f.operation.dispatchMessageId })
  const request = { root: f.root, base: f.input.headCommit, prompt: '固定资源恢复请求', schema: { type: 'object' }, requestKey: 'pending-created-native', inputDigest: contentHash('fixed-input'), purpose: 'elaboration_generate', timeoutMs: 10000 }
  const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const identity = { operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, candidateDigest: null }
  const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
  const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
  const plannedRef = writeEvidence(f.input.source.commonDir, checkpoint)
  const resource = f.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: plannedRef })
  const createdRef = writeEvidence(f.input.source.commonDir, { ...checkpoint, phase: 'created', nativeState: 'queued' })
  f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: plannedRef, checkpointRef: createdRef })
  f.store.requestControl(f.operation.id, 'cancel')
  const before = f.store.readOperation(f.operation.id)
  const cleanupOnly = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(cleanupOnly.status, 'recovery_required'); assert.deepEqual(cleanupOnly.operation, before)
  assert.ok(cleanupOnly.failure?.message.includes('creation may be in progress'))
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
  const before = f.store.readOperation(f.operation.id)
  const recovered = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(recovered.operation.control, before.control); assert.equal(recovered.operation.callsUsed, before.callsUsed); assert.equal(recovered.operation.deadlineAtMs, before.deadlineAtMs); assert.deepEqual(recovered.operation.input, before.input)
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
    assert.ok(source.content.includes('const previousId = this.keys.get(actor)?.get(key);'))
    source.content = `import { requestKey } from './request-key.js';\n${source.content.replace('const previousId = this.keys.get(actor)?.get(key);', 'const previousId = requestKey(this.keys, actor, key);')}`
    value.changes.push({ path: 'src/request-key.js', beforeDigest: null, beforeMode: null, mode: null, content: 'export function requestKey(keys, actor, key) { return keys.get(actor)?.get(key); }\n' })
    value.changes.push({ path: childPath, beforeDigest: null, beforeMode: null, mode: null, content: `---\ntitle: 导出请求幂等键\nstatus: active\ncode:\n  - src/request-key.js#requestKey\n---\n# 导出请求幂等键\n\n## raw source\n\n${childRaw}\n\n## expanded spec\n\n按actor与key逐层查询既有任务，不以组合序列化混淆不同已接受输入的身份。\n` })
    return value
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(result.failure)); assert.ok(result.receipt)
  assert.ok(result.operation.scope.contractIds.includes('REQ-EXPORT-01')); assert.ok(result.operation.scope.contractIds.includes('AC-EXPORT-08')); assert.ok(result.operation.deliveredScope.flowIds.includes('FLOW-EXPORT-02'))
  const delivery = result.operation.deliveryPlan.canonicalRoot
  assert.ok(readFileSync(join(delivery, 'src/request-key.js'), 'utf8').includes('keys.get(actor)?.get(key)'))
  assert.ok(readFileSync(join(delivery, 'src/export.js'), 'utf8').includes('const previousId = requestKey(this.keys, actor, key);'))
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
    if (request.purpose === 'code_behavior_analyze') {
      const proposal = output as { changes: { kind: string; paths: string[]; affectedIds: string[]; ruleIds: string[] }[]; acceptanceChanges: unknown[] }
      const ruleId = variant === 'raw' ? 'RULE-EXPORT-02' : 'RULE-EXPORT-06', acceptanceId = variant === 'raw' ? 'AC-EXPORT-02' : 'AC-EXPORT-08'
      for (const change of proposal.changes) if (change.paths.some(path => path.startsWith('.spec/'))) { change.kind = 'allowed_change'; change.affectedIds = [ruleId, acceptanceId]; change.ruleIds = [ruleId] }
      proposal.acceptanceChanges = [{ id: acceptanceId, ruleIds: [ruleId], source: 'user:raw', reason: intent }]
      return proposal
    }
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
  assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, attempts: f.store.listAttempts(result.operation.id).map(attempt => ({ failure: attempt.failure, detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString('utf8')); return value.rounds?.map((round: { findings: unknown[] }) => round.findings) ?? value.validationFindings ?? value }) })), phase: result.operation.phase, refs: f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(value => value.rounds || value.validationFindings).map(value => ({ status: value.status, findings: value.validationFindings ?? value.rounds.flatMap((round: { findings: unknown[] }) => round.findings) })) }))
  assert.equal(result.operation.callsUsed, 6); assert.ok(result.operation.requestBlob); assert.equal(result.operation.input.id, f.input.id)
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
  const sourceProtocol = openProtocol(join(f.parent, 'sync.sqlite')), protocol = openProtocol(join(f.parent, 'v5-sync.sqlite')); t.after(() => protocol.close())
  applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 5))
  protocol.initialize(syncCoordinatorAddress(f.input.source.repositoryId))
  const historical = sourceProtocol.readMessages(syncCoordinatorAddress(f.input.source.repositoryId))[0]
  const copied = protocol.enqueue(syncCoordinatorAddress(f.input.source.repositoryId), { kind: historical.kind, body: historical.body, idempotencyKey: historical.idempotencyKey })
  protocol.withTransaction(tx => tx.dequeue(syncCoordinatorAddress(f.input.source.repositoryId), copied.messageId))
  for (const table of ['sync_operations', 'sync_attempts', 'sync_leases']) {
    for (const row of sourceProtocol.withTransaction(tx => tx.query(`SELECT * FROM ${table}`))) {
      if (table === 'sync_operations') { const record = JSON.parse(String(row.record_json)); record.dispatchMessageId = copied.messageId; row.record_json = JSON.stringify(record) }
      const columns = Object.keys(row).filter(column => column !== 'semantic_digest' && column !== 'normalized_semantic_digest')
      protocol.withTransaction(tx => tx.exec(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, ...columns.map(column => row[column]) as SqlParam[]))
    }
  }
  sourceProtocol.close()
  const v5record = JSON.parse(String(protocol.withTransaction(tx => tx.query('SELECT record_json FROM sync_operations WHERE id=?', failed.operation.id))[0].record_json))
  assert.ok(v5record.scope.contractIds.includes('AC-EXPORT-03')); assert.deepEqual(f.operation.input.id, f.input.id); assert.ok(!source.includes('AC-EXPORT-03'))
  await migrateSyncStore(protocol, { backupPath: join(f.parent, 'v5-accepted-P1.backup') })
  const restarted = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(restarted)
  const automatic = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'v5-new-automatic-ingress', rootCauseId: 'v5-new-automatic-ingress', origin: failed.operation.origin, budget: failed.operation.budget, managedRoot: f.managedRoot, previousBaselinePair: failed.operation.previousBaselinePair })
  assert.equal(restarted.admitAndEnqueue(automatic).id, failed.operation.id)
  assert.equal(restarted.readOperation(failed.operation.id).callsUsed, 3)
  assert.equal(restarted.readOperation(failed.operation.id).payloadDigest, failed.operation.payloadDigest)
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

test('P4显式重试保留P1扩展后的路径和readSet，冻结原计划且不再次细化', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-expanded-before-retry', rootCauseId: 'p4-expanded-before-retry', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  const acknowledge = (id: string) => { for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === id) break } }
  acknowledge(operation.id)
  let p1Calls = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') p1Calls++
    if (request.purpose === 'code_generate') throw Object.assign(new Error('明确生成执行能力失败，未创建候选'), { code: 'unsupported' })
    return output
  })
  const options = { ...f.options, plan, readCurrentPlan: () => plan }
  const failed = await runSyncOperation(f.store, operation.id, options)
  assert.equal(failed.operation.phase, 'failed', JSON.stringify({ failure: failed.failure, failures: f.store.listAttempts(operation.id).map(attempt => attempt.failure), purposes: f.calls.map(call => call.purpose) }))
  assert.equal(p1Calls, 1)
  assert.ok(failed.operation.scope.paths.includes('src/export.js'))
  assert.ok(!plan.executionScope.paths.includes('src/export.js'))
  const admissionOptions = { ingressKey: 'p4-expanded-explicit-retry', rootCauseId: 'p4-expanded-explicit-retry', retryOf: operation.id, origin: operation.origin, budget: operation.budget, managedRoot: f.managedRoot, previousBaselinePair: operation.previousBaselinePair, baselineSelection: failed.operation.baselineSelection!, executionScope: failed.operation.scope, impactDigest: failed.operation.impactDigest }
  const admission = await prepareSyncAdmission(f.input, plan, admissionOptions)
  assert.deepEqual(admission.scope, failed.operation.scope)
  assert.equal(admission.readSetDigest, failed.operation.readSetDigest)
  assert.equal(admission.policyDigest, operation.policyDigest)
  assert.deepEqual(admission.planBlob, operation.planBlob)
  const retry = f.store.admitAndEnqueue(admission); f.useOperation(retry); acknowledge(retry.id)
  const repeated = await runSyncOperation(f.store, retry.id, options)
  assert.equal(repeated.operation.phase, 'failed')
  assert.equal(p1Calls, 1)
  const prompts = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.deepEqual(prompts[1].elaboratedSpecs, prompts[0].elaboratedSpecs)
  assert.equal(f.store.listJournals(retry.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('recoveryOnly不派发queued操作；paused且原生尚未调用的计划仅结算资源不改control/预算/input', async t => {
  const f = await fixture(t), before = f.store.readOperation(f.operation.id)
  const queued = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.deepEqual(queued.operation, before); assert.equal(f.calls.length, 0); assert.equal(f.store.listAttempts(f.operation.id).length, 0)
  assert.equal(f.store.nextDispatch(f.input.source.repositoryId)?.messageId, before.dispatchMessageId)
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 10000, expectedMessageId: f.operation.dispatchMessageId })
  const request = { root: f.root, base: f.input.headCommit, prompt: '尚未发出原生命令的已登记请求', schema: { type: 'object' }, requestKey: 'not-dispatched', inputDigest: f.input.id, purpose: 'elaboration_generate', timeoutMs: 10000 }
  const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(claimed.fence, { key: request.requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const identity = { operationId: f.operation.id, attemptId: claimed.attempt.id, inputId: f.input.id, candidateDigest: null }
  const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
  const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: false, nativeStarted: false, nativeState: 'unpublished', session: { sessionId: expectedSessionId, threadId: null, turnId: null } }
  f.store.planResource(claimed.fence, { key: request.requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: writeEvidence(f.input.source.commonDir, checkpoint) })
  f.store.requestControl(f.operation.id, 'pause')
  const pausedBefore = f.store.readOperation(f.operation.id), result = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true })
  assert.equal(result.status, 'paused', JSON.stringify(result.failure)); assert.deepEqual(result.operation, pausedBefore)
  const resource = f.store.findResource(claimed.attempt.id, request.requestKey)!
  assert.equal(resource.phase, 'removed'); assert.deepEqual(resource.checkpoints.map(item => item.phase), ['planned', 'terminal', 'removed'])
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()).stop.nativeStatus, 'notDispatched')
  assert.equal(f.calls.length, 0); assert.equal(f.store.listAttempts(f.operation.id).length, 1); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const missing of [false, true]) test(`recoveryOnly真实Docker planned创建回执丢失${missing ? '且目标不存在保unknown' : '只清理既有容器'}，不create/start`, docker, async t => {
  const f = await fixture(t), commands: string[][] = []
  f.options.verificationDriver = async (args, maxBytes) => {
    const result = await dockerVerificationDriver(args, maxBytes)
    if (args[0] === 'container' && args[1] === 'create') throw new Error('actual Docker create finished, result lost before created checkpoint')
    return result
  }
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'recovery_required'); assert.equal(f.calls.length, 4)
  const item = f.store.listRecoverableResources().find(item => item.operation.id === f.operation.id)!, checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, item.resource.checkpointRef).toString()) as VerificationCheckpoint
  assert.equal(item.resource.phase, 'planned')
  const inspected = await dockerVerificationDriver(['container', 'inspect', checkpoint.uniqueContainerName], 1024 * 1024), actual = JSON.parse(inspected.stdout)[0]
  assert.equal(actual.Config.Labels['spex.run'], checkpoint.runId); assert.equal(actual.Config.Labels['spex.candidate'], checkpoint.candidateDigest)
  t.after(async () => { await dockerVerificationDriver(['container', 'rm', '-f', actual.Id], 1024 * 1024) })
  if (missing) assert.equal((await dockerVerificationDriver(['container', 'rm', actual.Id], 1024 * 1024)).exitCode, 0)
  const before = f.store.readOperation(f.operation.id), attempts = f.store.listAttempts(f.operation.id).length
  const result = await runSyncOperation(f.store, f.operation.id, { ...f.options, recoveryOnly: true, verificationDriver: async (args, maxBytes) => { commands.push([...args]); return dockerVerificationDriver(args, maxBytes) } })
  assert.deepEqual(result.operation, before); assert.equal(f.calls.length, 4); assert.equal(f.store.listAttempts(f.operation.id).length, attempts)
  assert.ok(commands.every(args => !(args[0] === 'container' && ['create', 'start'].includes(args[1])))); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.equal(f.store.findResource(item.attempt.id, item.resource.plan.key)!.phase, missing ? 'planned' : 'removed')
  assert.equal(result.status, missing ? 'recovery_required' : before.phase)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('recoveryOnly面对真实V1-V4已登记verified但尚无journal的边界中断，只返回状态不开始交付', docker, async t => {
  const f = await fixture(t), recordVerification = f.store.recordVerification.bind(f.store), recordFailure = f.store.recordFailure.bind(f.store)
  f.store.recordVerification = (...args) => { recordVerification(...args); throw new Error('test interruption after actual durable four-layer verification') }
  f.store.recordFailure = () => { throw new Error('test process boundary stopped before another business-state write') }
  await assert.rejects(runSyncOperation(f.store, f.operation.id, f.options), /process boundary stopped/)
  f.store.recordVerification = recordVerification; f.store.recordFailure = recordFailure
  const before = f.store.readOperation(f.operation.id)
  assert.equal(before.phase, 'ready_to_apply'); assert.equal(f.store.readAttempt(before.currentAttemptId!).status, 'verified')
  assert.equal(f.store.listRecoverableResources().length, 0); assert.equal(f.store.listJournals(before.id).length, 0)
  const recovered = await runSyncOperation(f.store, before.id, { ...f.options, recoveryOnly: true })
  assert.deepEqual(recovered.operation, before); assert.equal(recovered.status, 'ready_to_apply'); assert.equal(f.calls.length, 4)
  assert.equal(f.store.listJournals(before.id).length, 0); assert.ok(!existsSync(before.deliveryPlan.canonicalRoot)); assert.equal(f.store.listAttempts(before.id).length, 1)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('P3真实code来源先持久独立analyzing再细化/生成，policy冻结且refactor保原业务正文', async t => {
  const f = await fixture(t, undefined, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') assert.ok(request.prompt.includes('preserve_business'))
    if (request.purpose === 'code_generate') { const frozen = promptInput(request); assert.equal(new Map(frozen.files).get('src/export.js'), f.bytes.toString()); assert.ok(request.prompt.includes('preserve_business')) }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#ExportService', evidence: '显式测试接缝终止于独审候选，不伪造V3', counterexample: '演示仅核到候选阶段', message: 'fixture stop before V3' }] }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure))
  assert.equal(result.operation.policyDigest, syncPlanDigest(f.plan)); assert.equal(result.operation.callsUsed, 6)
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review'])
  const attempt = f.store.readAttempt(result.operation.currentAttemptId!), checkpoints = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const analysis = checkpoints.find(value => value.version === 'code-behavior-v1')
  assert.equal(analysis.policyDigest, result.operation.policyDigest); assert.equal(analysis.readSetDigest, result.operation.readSetDigest); assert.equal(analysis.reviewPassed, true)
  assert.ok(checkpoints.some(value => value.stage === 'analysis' && value.attemptId === attempt.id))
  assert.equal(f.store.listJournals(result.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('P3未完整独审的行为分析不能晋级细化或写入，具体path遗漏持久失败', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 2, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'budget_exhausted'); assert.equal(f.store.listAttempts(f.operation.id)[0].failure?.code, 'behavior_review_failed'); assert.equal(f.calls.length, 2)
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('新decision独审仍有相同稳定冲突ID时完整阻断，不因旧finding被选择而删除发现', async t => {
  const f = await fixture(t, undefined, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => request.purpose === 'code_behavior_analyze' ? { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: 'conflict', affectedIds: ['REQ-EXPORT-01'] })) } : output)
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'conflicted', JSON.stringify(first.failure))
  const attempt = f.store.readAttempt(first.operation.currentAttemptId!), wrapper = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const originalAnalysis = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  const requestBlob = prepareControlledDecision(f.input, { requestId: 'keep-original-intent', operationId: first.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: originalAnalysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' } })
  const plan = structuredClone(f.plan); plan.facts = [...plan.facts, { source: 'decision:keep-original-intent', text: '保留原意纠正实现；仍须独审其他明确政策' }]
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'decision-after-conflict', rootCauseId: first.operation.rootCauseId, origin: 'decision', budget: first.operation.budget, managedRoot: f.managedRoot, requestBlob }))
  f.useOperation(next)
  const result = await runSyncOperation(f.store, next.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(result.status, 'conflicted', JSON.stringify(result.failure)); assert.equal(f.calls.some(call => call.purpose === 'code_generate'), false)
  const newAttempt = f.store.readAttempt(result.operation.currentAttemptId!), newWrapper = newAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const analysis = JSON.parse(readEvidence(f.input.source.commonDir, newWrapper.resultRef).toString()) as { findings: { id: string }[]; policyDigest: string }
  assert.equal(analysis.policyDigest, result.operation.policyDigest); assert.equal(analysis.findings[0].id, originalAnalysis.findings[0].id)
  assert.equal(f.store.listJournals(next.id).length, 0)
})

for (const invalid of ['foreign-decision', 'wrong-test', 'unselected-rule', 'unchanged-rule', 'keep-choice'] as const) test(`P3 oracle政策声明 ${invalid} 不得误报needs_input或获得授权`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  let source = ''
  const fact = { source: '', text: '只按当前所选裁决将filter限制为8字符；其他政策保持' }
  f.transform((output, request) => {
    const chosen = Boolean(source)
    if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, kind: chosen ? 'allowed_change' : 'conflict', affectedIds: chosen ? ['RULE-EXPORT-02', 'AC-EXPORT-02'] : ['REQ-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'] })), facts: chosen ? [fact] : [], acceptanceChanges: chosen && invalid !== 'keep-choice' ? [{ id: 'AC-EXPORT-02', ruleIds: ['RULE-EXPORT-02'], source, reason: '对应当前已选filter8规则' }] : [] }
    if (chosen && request.purpose === 'elaboration_generate' && invalid !== 'keep-choice' && invalid !== 'unchanged-rule') {
      const candidate = structuredClone(output) as GeneratedElaboration, rule = candidate.changes[0].tables.RULE.find(row => row.id === 'RULE-EXPORT-02')!, ac = candidate.changes[0].tables.AC.find(row => row.id === 'AC-EXPORT-02')!
      rule.constraint = `${rule.constraint}；filter最多8字符`; rule.source = source; ac.assertion = `${ac.assertion}；9字符拒绝`; ac.source = source
      return candidate
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'needs_input', findings: [{ kind: 'missing_fact', affectedIds: invalid === 'unselected-rule' ? ['RULE-EXPORT-01', 'AC-EXPORT-02'] : ['RULE-EXPORT-02', 'AC-EXPORT-02'], ruleLocation: invalid === 'foreign-decision' ? 'oracle-policy:decision:old-other-decision' : `oracle-policy:${source}`, codeLocation: `tests/export.test.mjs#${invalid === 'wrong-test' ? 'NOT-MANDATORY' : 'AC-EXPORT-03'}`, evidence: '宣称新规则与旧只读oracle相撞，必须先核真实裁决/规则/精确test绑定', counterexample: 'filter9必须接受或拒绝，不能把无绑定声明当业务输入', message: '需要更新oracle版本' }] }
    return output
  })
  const originalResult = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(originalResult.status, 'conflicted', JSON.stringify({ failure: f.store.readAttempt(originalResult.operation.currentAttemptId!).failure, calls: f.calls.map(call => call.purpose) }))
  const previous = f.store.readAttempt(originalResult.operation.currentAttemptId!), wrapper = previous.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis'), analysis = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  const request = { requestId: `oracle-invalid-${invalid}`, operationId: f.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: analysis.findings.map(finding => finding.id), decision: invalid === 'keep-choice' ? { choice: 'keep_intent' as const } : { choice: 'new_rule' as const, rule: 'filter最多8字符，其他政策保持。' } }
  source = `decision:${controlledDecisionIdentity(request)}`; fact.source = source
  const requestBlob = prepareControlledDecision(f.input, request), plan = { ...f.plan, facts: [...f.plan.facts, fact] }
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: `decision-${invalid}`, rootCauseId: f.operation.rootCauseId, origin: 'decision', budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob })); f.useOperation(next)
  const result = await runSyncOperation(f.store, next.id, { ...f.options, plan, readCurrentPlan: () => plan })
  assert.equal(f.store.readAttempt(result.operation.currentAttemptId!).failure?.code, 'review_invalid', JSON.stringify(result.failure))
  assert.notEqual(result.status, 'needs_input'); assert.equal(result.receipt, undefined); assert.equal(f.store.listJournals(next.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


test('P3公共计划新增治理实际receipt后ff接受、搬迁再完整退役，旧oracle和负向AC仍经Docker', { skip: docker.skip, timeout: 600000 }, async t => {
  const f = await fixture(t)
  f.git('reset', '--hard', 'HEAD')
  const verification = { ...f.plan.verifications[0], definition: { id: 'VERIFY-SUMMARY-01', command: ['node', '--test', 'generated-tests/summary.test.mjs'], cwd: '.', timeoutMs: 10000 } }
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['package.json'], verifications: [...f.plan.verifications, verification], mandatoryTests: f.plan.mandatoryTests, facts: f.plan.facts, budget: { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300000 } } }))
  writeFileSync(join(f.root, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n')
  f.git('add', '.'); f.git('commit', '-m', 'explicit authorized helper source and verification')
  const nodeId = `sync-code-${contentHash('src/summary.js').slice(0, 16)}`, path = `.spec/project/export-contract/${nodeId}/spec.md`
  const child = `---
title: 导出计数辅助
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循导出原始反馈需求。

## expanded spec

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-EXPORT-01,RULE-EXPORT-05 | 成功行数组 | 读取计数辅助 | 返回rows.length | generated-tests/summary.test.mjs#AC-SUMMARY-01 | VERIFY-SUMMARY-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |

### VERIFY

| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-SUMMARY-01 | ["node","--test","generated-tests/summary.test.mjs"] | . | 10000 |
`
  assert.ok(parseContract({ nodeId, path, source: child }).contract, JSON.stringify(parseContract({ nodeId, path, source: child }).findings))
  let retiring = false, moving = false
  const movedId = 'moved-summary', movedPath = `.spec/project/export-contract/${movedId}/spec.md`
  let activePath = path, activeNodeId = nodeId
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; paths: string[] }[]; newNodes: unknown[]; resolutions: unknown[] }
      value.changes.forEach(change => { change.kind = 'allowed_change' })
      value.newNodes = retiring || moving ? [] : [{ codePath: 'src/summary.js', parentNodeId: 'export-contract', basis: '已有结果反馈原意支持内部长度辅助，无新增政策' }]
      value.resolutions = retiring ? [{ path: activePath, content: null, mode: null }] : []
      return value
    }
    if (request.purpose === 'elaboration_generate' && !retiring) {
      const value = output as GeneratedElaboration, generated = rows(child, activePath).changes[0]
      generated.nodeId = activeNodeId; return { ...value, changes: [...value.changes.filter(change => f.options.plan.targets.some(target => target.path === change.path)), generated] }
    }
    if (request.purpose === 'code_generate') {
      const value = output as { changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode: string | null; content: string | null }[] }, frozen = promptInput(request), previous = frozen.manifest.entries.find(entry => entry.path === 'generated-tests/summary.test.mjs')
      return { ...value, changes: [...value.changes, { path: 'generated-tests/summary.test.mjs', beforeDigest: previous?.digest ?? null, beforeMode: previous?.mode ?? null, mode: previous ? null : '100644', content: retiring ? "import assert from 'node:assert/strict'; import test from 'node:test'; import { existsSync } from 'node:fs'; test('AC-SUMMARY-01', () => assert.equal(existsSync(new URL('../src/summary.js', import.meta.url)), false));\n" : "import assert from 'node:assert/strict'; import test from 'node:test'; import { resultCount } from '../src/summary.js'; test('AC-SUMMARY-01', () => assert.equal(resultCount([1,2]), 2));\n" }] }
    }
    return output
  })
  await f.realTools()
  const snapshot = await captureInputSnapshot(f.root), plan = await buildSyncApplicationPlan(snapshot, 'export-contract')
  const first = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, { ingressKey: 'public-helper', rootCauseId: 'public-helper', origin: 'code', budget: f.operation.budget, managedRoot: f.managedRoot }))
  assert.deepEqual(first.scope.paths, plan.writePaths, '无精确资源选择的冻结操作保留目录准入授权');
  f.useOperation(first); f.options.plan = plan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(snapshot, 'export-contract')
  const initial = await runSyncOperation(f.store, first.id, f.options)
  assert.equal(initial.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(first.id).map(attempt => ({ failure: attempt.failure, detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as { rounds?: { findings?: unknown[] }[] }; return value.rounds?.map(round => round.findings) ?? value }) }))))
  const baseline = f.store.readBaseline(snapshot.source)!, delivery = baseline.verifiedDelivery.source.canonicalRoot
  assert.equal(existsSync(join(f.root, path)), false); assert.equal(existsSync(join(delivery, path)), true)
  assert.ok(f.store.listJournals(first.id)[0].receipt); assert.equal(baseline.sourceInput.id, snapshot.id)
  f.git('merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  moving = true; activePath = movedPath; activeNodeId = movedId
  renameSync(join(f.root, path.slice(0, -'spec.md'.length)), join(f.root, movedPath.slice(0, -'spec.md'.length)))
  const movedInput = await captureInputSnapshot(f.root), movedPlan = await buildSyncApplicationPlan(movedInput, movedId, baseline)
  const moved = f.store.admitAndEnqueue(await prepareSyncAdmission(movedInput, movedPlan, { ingressKey: 'public-move', rootCauseId: 'public-move', origin: 'code', previousBaselinePair: baseline, budget: f.operation.budget, managedRoot: f.managedRoot }))
  f.useOperation(moved); f.options.plan = movedPlan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(movedInput, movedId, baseline)
  const moveIndex = readFileSync(join(f.root, '.git/index')), movedResult = await runSyncOperation(f.store, moved.id, f.options)
  assert.equal(movedResult.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(moved.id).map(attempt => ({ failure: attempt.failure, prepare: attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(movedInput.source.commonDir, ref).toString('utf8'))).filter(value => value.kind === 'private-delivery-prepare'), detail: attempt.failure?.evidenceRefs.map(ref => { const value = JSON.parse(readEvidence(movedInput.source.commonDir, ref).toString('utf8')) as { rounds?: { findings?: unknown[] }[] }; return value.rounds?.map(round => round.findings) ?? value }) }))))
  const movedBaseline = f.store.readBaseline(movedInput.source)!, movedJournal = f.store.listJournals(moved.id)[0]
  assert.equal(movedJournal.status, 'settled'); assert.ok(movedJournal.receipt)
  assert.ok(f.store.readAttempt(f.store.readOperation(moved.id).currentAttemptId!).verification!.passed)
  const moveTree = readTree(movedInput.source.commonDir, movedJournal.receipt.actualTree)
  assert.equal(moveTree.some(entry => entry.path === path), false); assert.equal(moveTree.some(entry => entry.path === movedPath), true)
  const movedContract = parseContract({ nodeId: movedId, path: movedPath, source: readFileSync(join(movedBaseline.verifiedDelivery.source.canonicalRoot, movedPath), 'utf8') }).contract!
  assert.deepEqual(movedContract.items.map(item => item.id).sort(), ['AC-SUMMARY-01', 'VERIFY-SUMMARY-01'])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), moveIndex); assert.equal((await captureInputSnapshot(f.root)).id, movedInput.id)
  const moveCalls = f.calls.length, moveCommits = f.git('rev-list', '--count', moved.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, moved.id, f.options)).receipt, movedJournal.receipt)
  assert.equal(f.calls.length, moveCalls); assert.equal(f.git('rev-list', '--count', moved.deliveryPlan.branch), moveCommits)
  // 作者接受已验证交付后保留未跟踪草稿，避免Git覆盖其字节。
  const moveDraft = readFileSync(join(f.root, movedPath)), savedDraft = join(f.parent, 'accepted-move-draft.md')
  renameSync(join(f.root, movedPath), savedDraft)
  assert.deepEqual(readFileSync(savedDraft), moveDraft)
  f.git('merge', '--ff-only', movedBaseline.verifiedDelivery.headCommit)
  rmSync(join(f.root, movedPath)); rmSync(join(f.root, 'src/summary.js'))
  retiring = true
  const nextInput = await captureInputSnapshot(f.root), nextIndex = readFileSync(join(f.root, '.git/index')), nextPlan = await buildSyncApplicationPlan(nextInput, movedId, movedBaseline)
  assert.equal(nextPlan.intentNodeId, 'export-contract'); assert.equal(nextPlan.authorizedChanges, undefined)
  const next = f.store.admitAndEnqueue(await prepareSyncAdmission(nextInput, nextPlan, { ingressKey: 'public-retire', rootCauseId: 'public-retire', origin: 'code', previousBaselinePair: movedBaseline, budget: f.operation.budget, managedRoot: f.managedRoot }))
  f.useOperation(next); f.options.plan = nextPlan; f.options.readCurrentPlan = () => buildSyncApplicationPlan(nextInput, movedId, movedBaseline)
  const result = await runSyncOperation(f.store, next.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(next.id).map(attempt => attempt.failure)))
  const settled = f.store.readBaseline(nextInput.source)!
  assert.ok(['AC-SUMMARY-01', 'VERIFY-SUMMARY-01', movedId].every(id => settled.retiredIds!.includes(id)))
  const finalDelivery = settled.verifiedDelivery.source.canonicalRoot
  assert.equal(existsSync(join(finalDelivery, movedPath)), false); assert.equal(existsSync(join(finalDelivery, 'src/summary.js')), false)
  assert.equal(readFileSync(join(finalDelivery, 'tests/export.test.mjs'), 'utf8'), readFileSync(join(f.root, 'tests/export.test.mjs'), 'utf8'))
  assert.ok(readFileSync(join(finalDelivery, 'generated-tests/summary.test.mjs'), 'utf8').includes('existsSync'))
  assert.ok(f.store.readAttempt(f.store.readOperation(next.id).currentAttemptId!).verification!.passed)
  const retirementJournal = f.store.listJournals(next.id)[0]
  assert.equal(retirementJournal.status, 'settled'); assert.ok(retirementJournal.receipt)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), nextIndex); assert.equal((await captureInputSnapshot(f.root)).id, nextInput.id)
  const retirementCalls = f.calls.length, retirementCommits = f.git('rev-list', '--count', next.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, next.id, f.options)).receipt, retirementJournal.receipt)
  assert.equal(f.calls.length, retirementCalls); assert.equal(f.git('rev-list', '--count', next.deliveryPlan.branch), retirementCommits)
})


test('P3实际partial正文A与后续immutable作者B同行重叠，独审resolution原意经Docker与receipt完整交付', { skip: docker.skip, timeout: 300000 }, async t => {
  const sentence = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。', a = `${sentence} 已交付A保持有效。`, b = `${sentence} 原immutable作者B保持有效。`, merged = original.replace(sentence, `${sentence} 已交付A保持有效。原immutable作者B保持有效。`)
  const f = await fixture(t, undefined, false, original, 'project', original, {}, { original: sentence + '此输入是固定业务验收夹具；decision:EXPORT-POLICY 表示测试作者提供的显式业务事实，只适用于夹具。', replacement: a + '此输入是固定业务验收夹具；decision:EXPORT-POLICY 表示测试作者提供的显式业务事实，只适用于夹具。', intent: '明确作者A原意，业务规则与原oracle不改', testPath: 'generated-tests/unused-author-registration.test.mjs' })
  let second = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string }[]; resolutions: unknown[] }
      value.changes.forEach(change => { change.kind = 'allowed_change' }); if (second) value.resolutions = [{ path: contractPath, content: merged, mode: '100644' }]
      return value
    }
    if (second && request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { intent: { rawSource: string }; targets: { path: string; rawSource?: string }[] }
      assert.ok(frozen.intent.rawSource.includes('已交付A')); assert.ok(frozen.intent.rawSource.includes('原immutable作者B'))
      assert.ok(frozen.targets.find(target => target.path === contractPath)!.rawSource!.includes('已交付A'))
    }
    if (second && request.purpose === 'code_review') {
      const frozen = promptInput(request), spec = frozen.elaboratedSpecs.find(spec => spec.path === contractPath)!.source
      assert.ok(spec.includes('已交付A')); assert.ok(spec.includes('原immutable作者B'))
      assert.equal(parseParts(spec)!.rawSource, parseParts(merged)!.rawSource)
    }
    return output
  })
  await f.realTools()
  const initial = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(initial.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(f.operation.id).map(attempt => attempt.failure)))
  const baseline = f.store.readBaseline(f.input.source)!
  assert.ok(readFileSync(join(baseline.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes('已交付A'))
  const author = prepareControlledRequest(f.input, { path: contractPath, source: original, next: original.replace(sentence, b), changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'raw-B-after-A', nodeId: 'export-contract', intent: '原作者B与A相容，原业务及验证政策保持' })
  assert.ok(author.changed)
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'raw-integrated-B', rootCauseId: 'raw-integrated-B', origin: 'combined', previousBaselinePair: baseline, budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob: author.requestBlob })
  const operation = f.store.admitAndEnqueue(admission); f.useOperation(operation); second = true
  const result = await runSyncOperation(f.store, operation.id, f.options)
  assert.equal(result.status, 'workspace_synced', JSON.stringify(f.store.listAttempts(operation.id).map(attempt => attempt.failure)))
  const attempt = f.store.readAttempt(f.store.readOperation(operation.id).currentAttemptId!)
  assert.equal(attempt.verification!.passed, true)
  const journal = f.store.listJournals(operation.id)[0]
  assert.equal(journal.status, 'settled'); assert.ok(journal.receipt); assert.deepEqual(result.receipt, journal.receipt)
  const receipt = journal.receipt, entry = readTree(f.input.source.commonDir, receipt.actualTree).find(entry => entry.path === contractPath)!
  const actual = readObject(f.input.source.commonDir, entry.oid).toString('utf8')
  assert.equal(parseParts(actual)!.rawSource, parseParts(merged)!.rawSource)
  assert.equal(readFileSync(join(receipt.deliverySnapshot.source.canonicalRoot, contractPath), 'utf8'), actual)
  const delivered = parseContract({ nodeId: 'export-contract', path: contractPath, source: actual }).contract!
  for (const item of parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items) assert.ok(sameContractBusinessMeaning(item, delivered.items.find(current => current.id === item.id)!), item.id)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  const calls = f.calls.length, commits = f.git('rev-list', '--count', operation.deliveryPlan.branch)
  assert.deepEqual((await runSyncOperation(f.store, operation.id, f.options)).receipt, receipt)
  assert.equal(f.calls.length, calls); assert.equal(f.git('rev-list', '--count', operation.deliveryPlan.branch), commits)
})


for (const mode of ['contract-live', 'contract-restart', 'symbol-live', 'symbol-restart', 'omission-live', 'legacy-stage-restart', 'legacy-rule-ac-stage-restart', 'legacy-repair-input-restart', 'invalid-stage-restart', 'corrupt-stage-restart'] as const) test(`P3生成诊断 ${mode} 区分普通测试修复与明确契约遗漏并保完整发现`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 })
  let activeStore = f.store, p1Calls = 0
  const path = '.spec/project/export-contract/spec.md', omission = mode === 'omission-live', persisted = /^(legacy|invalid|corrupt)-/.test(mode), broken = /^(invalid|corrupt)-/.test(mode), contractReference = mode.startsWith('contract') || persisted
  const findings = [
    { kind: 'repair' as const, affectedIds: mode === 'legacy-rule-ac-stage-restart' ? ['AC-EXPORT-07'] : ['RULE-EXPORT-05'], ruleLocation: `${omission ? 'contract-omission:' : contractReference ? 'contract:' : ''}${path}#RULE-EXPORT-05`, codeLocation: 'tests/export.test.mjs#assertCall', evidence: omission ? 'raw明确重复完成保首次结果，已接受Spec缺少必要重复失败边界' : '测试 helper 参数错误导致 TypeError，已批准规则完整', counterexample: '重复COMPLETE先突变result再校验，second.csv覆盖first.csv，必须先保旧结果', message: omission ? '原意明确但已接受契约遗漏必要重复边界' : '修测试helper和重复断言，不改已审业务正文' },
    { kind: 'repair' as const, affectedIds: ['AC-EXPORT-07'], ruleLocation: `${contractReference ? 'contract:' : ''}${path}#AC-EXPORT-07`, codeLocation: 'tests/export.test.mjs#repeat-complete', evidence: '断言读取错误字段', counterexample: 'COMPLETE(first.csv)后再次COMPLETE(second.csv)必须仍first.csv', message: '保留首次结果的具体断言' },
  ]
  f.transform((output, request) => {
    const attempt = activeStore.readAttempt(activeStore.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (p1Calls > 1) {
        assert.equal(omission, true, '普通code/test修复不得再次派发P1')
        const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { refinement: { diagnostics: { message: string }[] } }
        assert.deepEqual(JSON.parse(frozen.refinement.diagnostics[0].message), findings[0], '明确遗漏进入既有refinement诊断')
      }
    }
    if (request.purpose === 'code_generate' && attempt.number > 1 && !omission) {
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { diagnostics: { code: string; message: string }[] } }
      for (const finding of findings) assert.ok(frozen.repairContext.diagnostics.some(item => item.code === finding.kind && item.message === JSON.stringify(finding)), '下一生成必须逐字收到完整实际finding，含位置/证据/反例')
      const first = promptInput(f.calls.find(call => call.purpose === 'code_generate')!)
      assert.deepEqual(frozen.elaboratedSpecs, first.elaboratedSpecs); assert.deepEqual(frozen.contracts, first.contracts)
    }
    if (request.purpose === 'code_review') return attempt.number === 1 ? { ...(output as object), verdict: 'repair', findings } : { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#dispatch', evidence: 'fixture在新独审停止，不冒称V3通过', counterexample: '真实运行另验', message: 'fixture stops before V3' }] }
    return output
  })
  if (mode.endsWith('restart')) {
    let legacyRefinement: unknown, legacyRepairContext: unknown
    const checkpoint = (fence: Parameters<SyncStore['checkpoint']>[0], name: string, value: unknown): void => {
      const operation = activeStore.readOperation(f.operation.id), resultRef = writeEvidence(f.input.source.commonDir, value)
      activeStore.checkpoint(fence, resultRef)
      activeStore.checkpoint(fence, writeEvidence(f.input.source.commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: fence.attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest, stage: name, resultRef }))
    }
    if (persisted) {
      const record = activeStore.recordFailure.bind(activeStore)
      activeStore.recordFailure = (fence, issue) => {
        if (issue.code === 'generation_failed') {
          const stages = activeStore.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
          const prior = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'elaboration').resultRef).toString()), generation = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'generation').resultRef).toString())
          const finding = mode === 'invalid-stage-restart' ? { ...findings[0], ruleLocation: `contract-omission:${path}#MISSING-ID` } : findings[0]
          legacyRepairContext = { previousOutput: generation.output, diagnostics: [{ code: 'generation_failed', message: '实现候选或独立评审未通过' }, ...generation.validationFindings.map((item: { code: string; message: string }) => ({ code: item.code, message: item.message }))] }
          legacyRefinement = { prior, candidate: generation.candidate, candidateDigest: generation.candidate.digest, diagnostics: findings.map((actual, index) => ({ code: 'contract_boundary_omission', message: mode === 'corrupt-stage-restart' && index === 0 ? '{broken-json' : JSON.stringify(index === 0 ? finding : actual) })) }
          if (mode !== 'legacy-repair-input-restart') checkpoint(fence, 'refinement', legacyRefinement)
        }
        return record(fence, issue)
      }
    }
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.failure?.code === 'generation_failed')) {
        if (mode === 'legacy-repair-input-restart') { const claimed = claim(request); checkpoint(claimed.fence, 'repair-input', { refinement: legacyRefinement, repairContext: legacyRepairContext }) }
        throw new Error('fixture process boundary after durable code review rejection')
      }
      return claim(request)
    }
    const first = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(first.status, mode === 'legacy-repair-input-restart' ? 'unsupported' : 'failed'); assert.equal(first.operation.callsUsed, 4)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  if (broken) { assert.equal(result.failure?.code, mode === 'corrupt-stage-restart' ? 'coordinator_failed' : 'refinement_binding'); assert.equal(p1Calls, 1); assert.equal(result.operation.callsUsed, 4); assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes); return }
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, attempts: activeStore.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  assert.equal(p1Calls, omission ? 2 : 1); assert.equal(result.operation.callsUsed, omission ? 8 : 6)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs); assert.equal(result.operation.input.id, f.input.id)
  assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.equal(result.receipt, undefined)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  const calls = f.calls.length
  assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'conflicted'); assert.equal(f.calls.length, calls)
})


test('P3首轮生成收到规范P1 implementation-review完整诊断而不改批准义务', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 })
  const finding = { code: 'implementation-review', kind: 'repair', affectedIds: ['RULE-EXPORT-05', 'AC-EXPORT-07'], message: '测试重复结果断言字段错误，业务契约完整', evidence: 'tests/export.test.mjs#AC-EXPORT-07 重复COMPLETE应仍first.csv，helper读错字段导致TypeError', decision: '只修测试helper和实现，保留全部已批准业务与验收义务' }
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_review') return { ...(output as object), verdict: 'repair', findings: [finding] }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } }
      assert.equal(frozen.repairContext.previousOutput, null, '尚无code输出不能虚造旧生成产物')
      const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!), wrapper = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
      const approved = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as ElaborationResult
      assert.equal(approved.structurePassed, true); assert.equal(approved.reviewPassed, true)
      const diagnostic = approved.deferredImplementationFindings.find(item => item.code === 'implementation-review')!
      assert.deepEqual(frozen.repairContext.diagnostics, [{ code: diagnostic.code, message: JSON.stringify(diagnostic) }], '仅规范implementation-review进入诊断，不灌入普通missing-test-*')
      assert.ok(diagnostic.message.includes(finding.evidence)); assert.ok(diagnostic.message.includes(finding.decision)); assert.deepEqual(diagnostic.relatedIds, finding.affectedIds)
      assert.deepEqual(frozen.elaboratedSpecs, approved.changes.map(change => ({ path: change.path, source: change.source })))
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['RULE-EXPORT-05'], ruleLocation: 'RULE-EXPORT-05', codeLocation: 'src/export.js#dispatch', evidence: '明确接缝在V3前停止', counterexample: '不能冒称运行通过', message: 'fixture stops before V3' }] }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, attempts: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) })); assert.equal(result.operation.callsUsed, 4)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1); assert.equal(result.receipt, undefined); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


for (const mode of ['live', 'restart', 'legacy', 'unreviewed'] as const) test(`P3合法增补链 ${mode} 冻结真实新增义务、旧marker和未审候选不升级`, async t => {
  const newIds = ['STEP-EXPORT-FAILURE', 'TR-EXPORT-RUNNING-EMPTY-FAIL', 'AC-EXPORT-EMPTY-FAIL', 'FLOW-EXPORT-FAILURE', 'STEP-EXPORT-FAILURE-CHECK'], testPath = 'generated-tests/empty-fail.test.mjs'
  const originalContract = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!, registration = originalContract.items.find(item => item.kind === 'VERIFY')!
  assert.equal(registration.kind, 'VERIFY')
  const environment = { version: 'trusted-test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 180000 }, false, original, 'project', original, { readPaths: ['.spec', 'src', 'tests', 'generated-tests'], writePaths: ['.spec', 'src', 'generated-tests'], verifications: [{ definition: { id: registration.id, command: registration.command, cwd: registration.cwd, timeoutMs: registration.timeoutMs }, environment }, { definition: { id: 'VERIFY-EXPORT-02', command: ['node', '--test', testPath], cwd: '.', timeoutMs: 10000 }, environment }] })
  let activeStore = f.store, current = f.operation, approvedSource = '', approvedAttemptId = '', p1Calls = 0, firstSource = ''
  f.transform((output, request) => {
    const attempt = activeStore.readAttempt(activeStore.readOperation(current.id).currentAttemptId!)
    const retried = current.id !== f.operation.id
    if (request.purpose === 'elaboration_generate') {
      assert.equal(retried, false, 'retryOf不能重新细化已批准义务')
      p1Calls++
      if (attempt.number === 2) {
        const candidate = structuredClone(output) as GeneratedElaboration, node = candidate.changes[0]
        const flow = node.tables.FLOW.find(row => row.id === 'FLOW-EXPORT-01')!, dispatch = node.tables.STEP.find(row => row.id === 'STEP-EXPORT-03')!, transition = node.tables.TR.find(row => row.id === 'TR-EXPORT-RUNNING-FAIL')!, acceptance = node.tables.AC.find(row => row.id === 'AC-EXPORT-02')!
        flow.steps = [...flow.steps as string[], newIds[0]]; flow.terminal = [...flow.terminal as string[], 'STATE-EXPORT-FAILED']
        dispatch.next = [...dispatch.next as string[], newIds[0], newIds[1]]
        node.tables.TR.push({ ...transition, id: newIds[1], condition: '当前attempt且reason为空', to: 'STATE-EXPORT-RUNNING', disposition: 'reject', reason: 'invalid-reason', effects: '明确拒绝且保持RUNNING和旧反馈' })
        node.tables.STEP.push({ ...dispatch, id: newIds[0], action: '处理当前attempt失败回调，reason非空转FAILED，空reason明确拒绝', input: '当前attempt,reason', output: 'FAILED与原因或保持RUNNING', next: ['TR-EXPORT-RUNNING-FAIL', newIds[1]], 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL'] })
        node.tables.STEP.at(-1)!['depends-on'] = ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL', newIds[3]]
        node.tables.FLOW.push({ ...flow, id: newIds[3], actors: 'worker', entry: '运行中处理当前attempt失败回调', preconditions: '任务RUNNING，worker可信且attempt当前', steps: [newIds[4]], terminal: ['STATE-EXPORT-RUNNING', 'STATE-EXPORT-FAILED'], source: 'rule:RULE-EXPORT-05', 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05'] })
        node.tables.STEP.push({ ...node.tables.STEP.at(-1)!, id: newIds[4], flow: newIds[3], source: `derived:${newIds[3]}`, 'depends-on': ['RULE-EXPORT-03', 'RULE-EXPORT-05', 'EVENT-EXPORT-FAIL'] })
        node.tables.VERIFY.push({ id: 'VERIFY-EXPORT-02', command: ['node', '--test', testPath], cwd: '.', 'timeout-ms': 10000 })
        node.tables.AC.push({ ...acceptance, id: newIds[2], covers: ['RULE-EXPORT-05', newIds[1]], action: '当前attempt提交空reason失败回调', assertion: '明确拒绝且保持RUNNING及旧反馈', test: `${testPath}#${newIds[2]}`, command: 'VERIFY-EXPORT-02', source: 'rule:RULE-EXPORT-05' })
        return candidate
      }
    }
    if (request.purpose === 'elaboration_review' && mode === 'unreviewed' && attempt.number === 2) throw Object.assign(new Error('fixture capacity failure leaves supplementation unreviewed'), { code: 'failed' })
    if (request.purpose === 'code_generate' && !retried && attempt.number === 1) firstSource = promptInput(request).elaboratedSpecs[0].source
    if (request.purpose === 'code_generate' && (attempt.number >= 2 || retried)) {
      const frozen = promptInput(request)
      const source = frozen.elaboratedSpecs.find(spec => spec.path === contractPath)!.source, contract = parseContract({ nodeId: 'export-contract', path: contractPath, source }).contract!
      if (mode === 'unreviewed') {
        for (const id of newIds) assert.equal(contract.items.some(item => item.id === id), false, '未审候选不能成为冻结义务')
        assert.equal(source, firstSource); return output
      }
      for (const id of newIds) assert.ok(contract.items.some(item => item.id === id), `第${attempt.number}attempt丢失已批准新增义务 ${id}`)
      assert.equal(parseParts(source)!.rawSource, parseParts(original)!.rawSource)
      for (const before of originalContract.items.filter(item => ['REQ', 'RULE', 'AC', 'VERIFY'].includes(item.kind))) assert.ok(sameContractBusinessMeaning(before, contract.items.find(item => item.id === before.id)!), before.id)
      const flow = contract.items.find(item => item.id === 'FLOW-EXPORT-01')!; assert.equal(flow.kind, 'FLOW'); assert.ok(flow.steps.includes(newIds[0]))
      const dispatch = contract.items.find(item => item.id === 'STEP-EXPORT-03')!; assert.equal(dispatch.kind, 'STEP'); assert.ok(dispatch.next.includes(newIds[1]))
      if (!retried && attempt.number === 2) { approvedSource = source; approvedAttemptId = attempt.id }
      else {
        assert.equal(source, approvedSource, '第三attempt必须保新增批准正文全文')
        const provenance = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration-provenance')
        const origin = JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()) as { fromAttemptId: string; fromOperationId: string }
        assert.equal(origin.fromAttemptId, approvedAttemptId); assert.equal(origin.fromOperationId, f.operation.id)
      }
      const value = output as { changes: { path: string; beforeDigest: null; beforeMode: null; mode: null; content: string }[] }
      value.changes.push({ path: testPath, beforeDigest: null, beforeMode: null, mode: null, content: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ExportService } from '../src/export.js';\ntest('${newIds[2]}',()=>{ const service=new ExportService(),job=service.submit('owner','key','active');service.dispatch(job.id,'START',{attempt:1});assert.throws(()=>service.dispatch(job.id,'FAIL',{attempt:1,reason:''}),/invalid-reason/);assert.equal(service.jobs.get(job.id).state,'RUNNING');assert.equal(service.jobs.get(job.id).reason,null); });\n` })
      return value
    }
    if (request.purpose === 'code_review') return { ...(output as object), verdict: attempt.number === 3 || retried ? 'conflict' : 'repair', findings: [{ kind: attempt.number === 3 || retried ? 'conflict' : 'repair', affectedIds: ['RULE-EXPORT-05'], ruleLocation: attempt.number === 1 && !retried ? `contract-omission:${contractPath}#RULE-EXPORT-05` : 'RULE-EXPORT-05', codeLocation: attempt.number === 1 && !retried ? `${contractPath}#STEP-EXPORT-03` : `${testPath}#assertCall`, evidence: attempt.number === 1 && !retried ? '已批准主流程缺当前attempt空reason失败回调的具体拒绝出口，明确原意要求非空reason' : '普通测试helper错误，只修实现和断言，不改新增已批准义务', counterexample: 'START当前attempt→FAIL空reason必须明确拒绝且保RUNNING/反馈', message: attempt.number === 3 || retried ? 'fixture在V3前停止，不冒称交付' : '按既定原意修复具体缺陷' }] }
    return output
  })
  if (mode === 'legacy') {
    const record = activeStore.recordFailure.bind(activeStore)
    activeStore.recordFailure = (fence, issue) => {
      if (activeStore.readAttempt(fence.attemptId).number === 2 && issue.code === 'generation_failed') {
        const wrapper = activeStore.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'repair-input')
        const repair = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { refinement: { diagnostics: { message: string }[] } }
        repair.refinement.diagnostics = repair.refinement.diagnostics.map(item => { const finding = JSON.parse(item.message) as { ruleLocation: string }; finding.ruleLocation = finding.ruleLocation.replace('contract-omission:', 'contract:'); return { ...item, message: JSON.stringify(finding) } })
        const resultRef = writeEvidence(f.input.source.commonDir, repair)
        activeStore.checkpoint(fence, resultRef); activeStore.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
      }
      return record(fence, issue)
    }
  }
  if (mode === 'restart' || mode === 'unreviewed') {
    const claim = activeStore.claimAttempt.bind(activeStore)
    activeStore.claimAttempt = request => {
      if (activeStore.listAttempts(f.operation.id).some(attempt => attempt.number === 2 && attempt.failure)) throw new Error('fixture process boundary after durable second-attempt result')
      return claim(request)
    }
    const stopped = await runSyncOperation(activeStore, f.operation.id, f.options)
    assert.equal(stopped.status, 'failed'); assert.equal(stopped.operation.callsUsed, mode === 'unreviewed' ? 6 : 8)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    activeStore = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  }
  const result = await runSyncOperation(activeStore, f.operation.id, f.options)
  const history = activeStore.listAttempts(f.operation.id).map(attempt => {
    const wrappers = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())), p1Ref = wrappers.find(value => value.stage === 'elaboration')?.resultRef, generationRef = wrappers.find(value => value.stage === 'generation')?.resultRef
    const p1 = p1Ref ? JSON.parse(readEvidence(f.input.source.commonDir, p1Ref).toString()) as ElaborationResult : null, generation = generationRef ? JSON.parse(readEvidence(f.input.source.commonDir, generationRef).toString()) as { status: string; review: { verdict: string } | null } : null
    return { number: attempt.number, attemptId: attempt.id, failure: attempt.failure, p1Ref, p1StructurePassed: p1?.structurePassed, p1ReviewPassed: p1?.reviewPassed, p1Findings: p1?.rounds.flatMap(round => round.findings), p1NewIds: p1?.changes.flatMap(change => parseContract({ nodeId: change.nodeId, path: change.path, source: change.source }).contract?.items.filter(item => newIds.includes(item.id)).map(item => item.id) ?? []), generationStatus: generation?.status, generationVerdict: generation?.review?.verdict }
  })
  if (process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_DIR, `lineage-${process.env.SPEX_REFINEMENT_LINEAGE_EVIDENCE_PHASE ?? 'run'}-${mode}.json`), JSON.stringify({ status: result.status, callsUsed: result.operation.callsUsed, newIds, history }, null, 2))
  if (mode === 'legacy') {
    assert.equal(result.failure?.code, 'SYNC_SCOPE_EVIDENCE_CONFLICT'); assert.deepEqual(history[2].p1NewIds, [], '旧协议marker不得将后来approved正文升级为新冻结义务'); assert.equal(p1Calls, 2); assert.equal(result.operation.callsUsed, 8)
  } else {
    assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, history }))
    assert.equal(p1Calls, 2); assert.equal(result.operation.callsUsed, mode === 'unreviewed' ? 8 : 10)
    if (mode !== 'unreviewed') assert.ok(approvedSource.includes(newIds[2]))
  }
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs); assert.equal(result.operation.input.id, f.input.id)
  assert.equal(result.receipt, undefined); assert.equal(activeStore.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  if (mode === 'live' || mode === 'restart') {
    activeStore.requestControl(f.operation.id, 'cancel')
    assert.equal((await runSyncOperation(activeStore, f.operation.id, f.options)).status, 'cancelled')
    const next = activeStore.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: `lineage-retry-${mode}`, rootCauseId: `lineage-retry-${mode}`, origin: f.operation.origin, budget: f.operation.budget, managedRoot: f.managedRoot, retryOf: f.operation.id }))
    current = next; f.useOperation(next)
    const replay = await runSyncOperation(activeStore, next.id, f.options)
    assert.equal(replay.status, 'conflicted', JSON.stringify(replay.failure)); assert.equal(replay.operation.callsUsed, 2); assert.equal(p1Calls, 2)
    assert.deepEqual(replay.operation.input, f.operation.input); assert.deepEqual(replay.operation.budget, f.operation.budget); assert.equal(replay.operation.policyDigest, f.operation.policyDigest); assert.equal(replay.receipt, undefined)
    assert.equal(activeStore.listJournals(next.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  }
})


test('已解决诊断GAP经真实SQLite派发与Git receipt累计退役，重启后禁复用；模拟V3不冒实际Docker', { timeout: 240000 }, async t => {
  const gapId = 'GAP-EXPORT-RETRY-DIAGNOSTIC', flowId = 'FLOW-EXPORT-02', stepId = 'STEP-EXPORT-05'
  const flowRow = original.split('\n').find(line => line.startsWith(`| ${flowId} `))!, stepRow = original.split('\n').find(line => line.startsWith(`| ${stepId} `))!
  const gapSource = original.replace(flowRow, flowRow.replace(/ \|$/, `,${gapId} |`)).replace(stepRow, stepRow.replace(/ \|$/, `,${gapId} |`)) + `\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${gapId} | conflict | 重试权限实现与原政策分歧 | ${flowId},${stepId},AC-EXPORT-08 | 冻结重试实现缺所有者检查 | 恢复既定重试权限 | derived:RULE-EXPORT-06 | RULE-EXPORT-06 |\n`
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 12, maxRepairs: 0, timeoutMs: 240000 }, false, gapSource, 'project', original, {}, undefined, 'code'); await f.realTools()
  f.options.leaseMs = 120000
  let activeStore = f.store, activeOperation = f.operation, phase: 'conflict' | 'reject' | 'accept' | 'reuse' = 'conflict'
  let source = '', containerExists = false, containerState = 'created'
  const simulatedCommands: string[][] = []
  const ok = (stdout = ''): VerificationCommandResult => ({ exitCode: 0, stdout, stderr: '', truncated: false })
  f.options.verificationDriver = async argv => {
    simulatedCommands.push([...argv])
    if (argv[0] === 'version') return ok(JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: '29.4.3' }))
    if (argv[0] === 'image') return ok(JSON.stringify([{ Id: 'sha256:image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]))
    const resource = activeStore.listRecoverableResources().find(item => item.operation.id === activeOperation.id && item.resource.plan.kind === 'verification')!.resource
    const checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint, config = checkpoint.config
    if (argv[1] === 'inspect') return containerExists ? ok(JSON.stringify([{ Id: 'a'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: config.policy.cwd === '.' ? '/candidate' : `/candidate/${config.policy.cwd}`, Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: config.policy.memoryBytes, MemorySwap: config.policy.memoryBytes, NanoCpus: config.policy.cpus * 1e9, PidsLimit: config.policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(config.policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: containerState, Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }])) : { ...ok(), exitCode: 1, stderr: 'Error: No such container' }
    if (argv[1] === 'create') { containerExists = true; containerState = 'created'; return ok('a'.repeat(64)) }
    if (argv[1] === 'start') { containerState = 'exited'; return ok('a'.repeat(64)) }
    if (argv[1] === 'logs') return ok([...config.policy.expectedTestIds.map(id => JSON.stringify({ type: 'test:pass', data: { name: `${id} simulated`, nesting: 0 } })), JSON.stringify({ type: 'test:summary', data: { counts: { tests: config.policy.expectedTestIds.length }, success: true } })].join('\n'))
    if (argv[1] === 'rm') { containerExists = false; return ok('a'.repeat(64)) }
    assert.fail(`unexpected simulated verifier argv ${argv}`)
  }
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: object[]; facts: object[] }
      value.changes = [{ kind: phase === 'conflict' ? 'conflict' : 'allowed_change', paths: ['src/export.js'], affectedIds: ['RULE-EXPORT-06', stepId, 'AC-EXPORT-08'], ruleIds: ['RULE-EXPORT-06'], originalIntent: '重试仍限当前所有者', previousBehavior: '存在重试权限分歧诊断', sourceBehavior: '待修重试实现', deliveryBehavior: '保既定所有者政策', evidence: '冻结原finding与当前明确keep裁决仅恢复重试政策，旧诊断已解决', counterexample: '非所有者重试须拒绝' }]
      value.facts = source ? [{ source, text: '保持既定重试权限并结清对应诊断' }] : []; return value
    }
    if (request.purpose === 'elaboration_generate') { const result = rows(phase === 'conflict' || phase === 'reuse' ? gapSource : original); if (phase !== 'conflict' && phase !== 'reuse') result.changes[0].removeIds = [gapId]; return result }
    if (request.purpose === 'elaboration_review' && phase === 'reject') return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'diagnostic-not-resolved', kind: 'repair', message: '权限诊断尚未解决', affectedIds: [stepId], evidence: '完整候选仍有权限矛盾', decision: '保诊断并修实现' }] }
    return output
  })
  const partial = await runSyncOperation(activeStore, activeOperation.id, f.options)
  assert.ok(partial.receipt, JSON.stringify({ status: partial.status, failure: partial.failure, attempts: activeStore.listAttempts(activeOperation.id).map(attempt => attempt.failure) }))
  const baseline = activeStore.readBaseline(f.input.source)!
  assert.ok(readFileSync(join(baseline.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes(gapId))
  const firstAttempt = activeStore.readAttempt(partial.operation.currentAttemptId!), wrapper = firstAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'analysis')
  const previous = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString()) as { findings: { id: string }[] }
  for (const verdict of ['reject', 'accept'] as const) {
    phase = verdict
    const request = { requestId: 'resolved-gap-current-keep', operationId: f.operation.id, inputId: f.input.id, analysisRef: wrapper.resultRef, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'keep_intent' as const } }
    source = `decision:${controlledDecisionIdentity(request)}`
    const requestBlob = prepareControlledDecision(f.input, request), plan = { ...f.plan, facts: [...f.plan.facts, { source, text: '保持既定重试权限并结清对应诊断' }] }
    activeOperation = activeStore.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: `gap-${verdict}`, rootCauseId: `gap-${verdict}`, ...(verdict === 'accept' ? { retryOf: activeOperation.id } : {}), origin: 'decision', previousBaselinePair: activeStore.readBaseline(f.input.source)!, budget: f.operation.budget, managedRoot: f.managedRoot, requestBlob })); f.useOperation(activeOperation)
    const result = await runSyncOperation(activeStore, activeOperation.id, { ...f.options, plan, readCurrentPlan: () => plan })
    const attempt = activeStore.readAttempt(result.operation.currentAttemptId!), stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const elaboration = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(value => value.stage === 'elaboration').resultRef).toString())
    if (verdict === 'reject') {
      assert.equal(result.receipt, undefined); assert.deepEqual(elaboration.retiredIds, []); assert.equal(activeStore.listJournals(activeOperation.id).length, 0); assert.ok(!(activeStore.readBaseline(f.input.source)!.retiredIds ?? []).includes(gapId)); continue
    }
    assert.equal(result.status, 'workspace_synced', JSON.stringify({ failure: result.failure, findings: elaboration.rounds.map((round: { findings: unknown[] }) => round.findings), attempts: activeStore.listAttempts(activeOperation.id).map(attempt => attempt.failure) })); assert.ok(result.receipt)
    assert.ok(elaboration.retiredIds.includes(gapId)); assert.equal(attempt.verification!.passed, true)
    const verification = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString()); assert.ok(verification.retiredIds.includes(gapId))
    assert.ok(activeStore.listJournals(activeOperation.id)[0].receipt); assert.ok(activeStore.readBaseline(f.input.source)!.retiredIds!.includes(gapId))
    assert.equal(readFileSync(join(activeStore.readBaseline(f.input.source)!.verifiedDelivery.source.canonicalRoot, contractPath), 'utf8').includes(gapId), false)
  }
  assert.ok(simulatedCommands.some(argv => argv[1] === 'start')); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  f.closeForRestart(); const restartedProtocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => restartedProtocol.close())
  activeStore = new SyncStore(restartedProtocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(activeStore)
  const settled = activeStore.readBaseline(f.input.source)!; assert.ok(settled.retiredIds!.includes(gapId))
  phase = 'reuse'; source = ''
  const nextInput = await captureInputSnapshot(f.root), reusePlan = { ...f.plan, facts: [...f.plan.facts, { source: 'code:src/export.js#ExportService', text: '新来源重新提出旧诊断' }] }
  activeOperation = activeStore.admitAndEnqueue(await prepareSyncAdmission(nextInput, reusePlan, { ingressKey: 'gap-reuse-after-restart', rootCauseId: 'gap-reuse-after-restart', origin: 'code', previousBaselinePair: settled, budget: f.operation.budget, managedRoot: f.managedRoot })); f.useOperation(activeOperation)
  const refused = await runSyncOperation(activeStore, activeOperation.id, { ...f.options, plan: reusePlan, readCurrentPlan: () => reusePlan })
  assert.equal(refused.receipt, undefined); assert.equal(activeStore.listJournals(activeOperation.id).length, 0)
  assert.ok(refused.operation.currentAttemptId, JSON.stringify({ refused, dispatch: activeStore.nextDispatch(f.input.source.repositoryId), attempts: activeStore.listAttempts(activeOperation.id) }))
  const lastAttempt = activeStore.readAttempt(refused.operation.currentAttemptId!), lastStages = lastAttempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const refusal = JSON.parse(readEvidence(f.input.source.commonDir, lastStages.find(value => value.stage === 'elaboration').resultRef).toString())
  assert.ok(refusal.rounds.flatMap((round: { findings: { code: string; itemId?: string }[] }) => round.findings).some((issue: { code: string; itemId?: string }) => issue.code === 'retired_id_reused' && issue.itemId === gapId))
  assert.ok(activeStore.readBaseline(f.input.source)!.retiredIds!.includes(gapId))
})


for (const scenario of ['failed', 'budget', 'unreviewed', 'no-conflict', 'active-p1'] as const) test(`已审conflict保独立裁决资格：P1 ${scenario} 不覆盖原分析与失败`, { timeout: 120000 }, async t => {
  const budget = { maxAttempts: scenario === 'failed' ? 2 : 1, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 }
  const f = await fixture(t, budget, false, original, 'project', original, {}, undefined, 'code')
  f.store.requestControl(f.operation.id, 'cancel'); f.store.discardDispatch(f.operation.id, f.operation.dispatchMessageId)
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['tests', 'package.json'], facts: f.plan.facts, verifications: f.plan.verifications, mandatoryTests: f.plan.mandatoryTests, budget } }))
  f.git('add', '.spec/spexcode.json'); f.git('commit', '--only', '-m', 'authorize application fixture policy', '.spec/spexcode.json')
  const protectedIndex = readFileSync(join(f.root, '.git/index'))
  let p1Calls = 0, announceP1!: () => void, resumeP1!: () => void
  const enteredP1 = new Promise<void>(resolve => { announceP1 = resolve }), finishP1 = new Promise<void>(resolve => { resumeP1 = resolve })
  f.transform(async (output, request) => {
    const current = f.store.listOperations(f.input.source.repositoryId).find(operation => operation.currentAttemptId && f.store.readAttempt(operation.currentAttemptId).dispatchPlans.some(dispatch => dispatch.key === request.requestKey))!
    f.useOperation(current)
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; affectedIds: string[]; ruleIds: string[] }[] }
      value.changes.forEach(change => { change.kind = scenario === 'no-conflict' ? 'refactor' : 'conflict'; change.affectedIds = ['RULE-EXPORT-01', 'AC-EXPORT-03']; change.ruleIds = ['RULE-EXPORT-01'] }); return value
    }
    if (request.purpose === 'code_behavior_review' && scenario === 'unreviewed') return { ...(output as object), checkedPaths: [] }
    if (request.purpose === 'elaboration_generate') {
      p1Calls++
      if (scenario === 'active-p1') { announceP1(); await finishP1 }
      if (scenario === 'failed' && p1Calls === 2) throw Object.assign(new Error('非法P1修复时执行环境不支持，保留原已审conflict'), { code: 'unsupported' })
      const candidate = rows(original); candidate.changes[0].tables.AC.push({ ...candidate.changes[0].tables.AC[0] }); return candidate
    }
    return output
  })
  const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const application = await SyncApplication.create(f.root, { protocol, runtimeDirectory: join(f.parent, 'application'), tools: f.options.tools, runner: f.options.runner })
  await application.enable()
  const admitted = await application.submit({ nodeId: 'export-contract', requestId: `reviewed-conflict-${scenario}`, origin: 'code' })
  if (scenario === 'active-p1') {
    await enteredP1
    try {
      const active = await application.readOperation(admitted.operation!.id), context = active.decisionContext!
      assert.equal(active.decisionEligibility.eligible, false); assert.equal(active.operation.phase, 'elaborating'); assert.equal(active.operation.blockedReason, 'conflicted'); assert.equal(active.attempt!.status, 'running')
      await assert.rejects(application.decide({ requestId: 'active-p1-choice', operationId: active.operation.id, inputId: active.operation.input.id, analysisRef: context.analysisRef, findingIds: context.analysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' } }), /尚未结算|已结算/)
    } finally { resumeP1() }
  }
  const detail = await application.wait(admitted.operation!.id), operation = detail.operation, attempt = detail.attempt!
  assert.equal(detail.resources.length, 0, JSON.stringify(detail.resources)); assert.equal(detail.journals.length, 0)
  assert.equal(detail.executionAvailability.status, 'ready'); assert.ok(attempt.failure)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), protectedIndex); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(operation.budget, budget)
  if (scenario === 'unreviewed' || scenario === 'no-conflict') {
    assert.equal(operation.blockedReason, null); assert.equal(detail.decisionEligibility.eligible, false)
    if (scenario === 'unreviewed') assert.equal(detail.decisionContext, null)
    else assert.deepEqual(detail.decisionContext!.analysis.findings, [])
    return
  }
  assert.equal(detail.decisionEligibility.eligible, true)
  const context = detail.decisionContext!; assert.equal(context.analysis.reviewPassed, true); assert.ok(context.analysis.findings.some(finding => finding.kind === 'conflict'))
  assert.equal(operation.phase, scenario === 'failed' ? 'failed' : 'budget_exhausted')
  assert.equal(operation.blockedReason, 'conflicted', JSON.stringify({ phase: operation.phase, blockedReason: operation.blockedReason, failure: attempt.failure, reviewPassed: context.analysis.reviewPassed }))
  const failure = structuredClone(attempt.failure), callsUsed = operation.callsUsed, request = { requestId: `exact-choice-${scenario}`, operationId: operation.id, inputId: operation.input.id, analysisRef: context.analysisRef, findingIds: context.analysis.findings.map(finding => finding.id), decision: { choice: 'keep_intent' as const } }
  await assert.rejects(application.decide({ ...request, analysisRef: { sha256: contentHash('foreign-analysis') } }), /可信当前检查点/)
  await assert.rejects(application.decide({ ...request, findingIds: ['unselected-finding'] }), /分歧|finding/)
  await assert.rejects(application.decide({ ...request, inputId: contentHash('foreign-input') }), /原输入已变化/)
  const start = application.start.bind(application); application.start = () => undefined
  try {
    const decision = await application.decide(request)
    assert.notEqual(decision.operation.id, operation.id); assert.equal(decision.operation.origin, 'decision'); assert.equal(decision.operation.phase, 'queued')
    const immutable = JSON.parse(readEvidence(operation.input.source.commonDir, decision.operation.requestBlob!).toString())
    assert.equal(immutable.analysisRef.sha256, context.analysisRef.sha256); assert.deepEqual(immutable.findingIds, request.findingIds)
    assert.deepEqual(application.store.readAttempt(attempt.id).failure, failure); assert.equal(application.store.readOperation(operation.id).callsUsed, callsUsed)
    assert.equal(application.store.readOperation(operation.id).deadlineAtMs, operation.deadlineAtMs); assert.equal(application.store.listJournals(operation.id).length, 0)
  } finally { application.start = start }
})
