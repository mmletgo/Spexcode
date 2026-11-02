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
import { elaborate, freezeElaborationInput } from './elaboration.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import type { ElaborationInput, ElaborationResult, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { buildSyncApplicationPlan } from './planning.js'
import { CODE_BEHAVIOR_GUIDANCE_VERSION } from './code-behavior.js'
import { SyncApplication } from './application.js'
import { acceptedCandidateReviewSource, isSyncInputCurrent, prepareSyncAdmission, readCurrentSyncAnalysis, readonlySpecRepairStalled, recoverSyncOperationResources, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { migrateSyncStore, SYNC_COMPONENT, SYNC_MIGRATIONS, syncCoordinatorAddress } from './migrations.js'
import { dockerVerificationDriver, verificationExportDigest } from './verification-executor.js'
import type { VerificationCheckpoint, VerificationCommandResult, VerificationDriver, VerificationRequest } from './verification-executor-types.js'
import { runAttemptVerification } from './verification-run.js'
import { exportCandidate, freezeCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import { SyncStore } from './store.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { claimFileMutex } from './file-mutex.js'
import { composeAuthoredInput } from './author-input.js'
import { controlledDecisionIdentity, guardControlledRequestPath, prepareControlledDecision, prepareControlledRequest } from './request-input.js'
import { prepareSpecBodyEdit } from '../spec-body-edit.js'
import { adaptElaborationNativeOutput } from '../../test/elaboration-native-output.js'
import { StructuredSessionError, structuredExecutionPolicy } from '../session-structured-policy.js'
import { nativeWorktreeResult } from '../native-worktree-runtime.js'
import { SettledSessionCreateTimeoutError } from '../session-structured.js'
import { freezeContext, prepareFrozenPrompt } from '../frozen-context.js'

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
type FrozenGenerationPrompt = { contracts: unknown[]; readyIds: string[]; elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] }; files: [string, string][]; priorContext?: { role: 'source_before' | 'verified_delivery'; pairId?: string; snapshot: { id: string; immutableTree: string }; entries: { path: string; mode: string; digest: string }[]; files: [string, string][] }[] }
const promptInput = (request: ElaborationSessionRequest): FrozenGenerationPrompt => JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as FrozenGenerationPrompt
function unlock(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) { chmodSync(join(root, entry.name), 0o700); unlock(join(root, entry.name)) }
  chmodSync(root, 0o700)
}
function gitReadCounter(directory: string): { reset(): void; entries(): string[]; restore(): void } {
  const bin = join(directory, 'git-read-counter-bin'), log = join(directory, 'git-read-counter.log'), wrapper = join(bin, 'git')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  mkdirSync(bin, { mode: 0o700 }); writeFileSync(log, '')
  writeFileSync(wrapper, '#!/bin/sh\ncase " $* " in\n  *" ls-tree -rlz --full-tree "*) last=""; for arg do last="$arg"; done; printf "tree:%s\\n" "$last" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\n  *" ls-files -z --full-name --cached --others --exclude-standard "*) printf "capture\\n" >> "$SPEX_SYNC_TEST_GIT_COUNTER" ;;\nesac\nexec "$SPEX_SYNC_TEST_REAL_GIT" "$@"\n')
  chmodSync(wrapper, 0o700)
  const oldPath = process.env.PATH, oldCounter = process.env.SPEX_SYNC_TEST_GIT_COUNTER, oldRealGit = process.env.SPEX_SYNC_TEST_REAL_GIT
  process.env.PATH = `${bin}:${oldPath ?? ''}`; process.env.SPEX_SYNC_TEST_GIT_COUNTER = log; process.env.SPEX_SYNC_TEST_REAL_GIT = realGit
  return {
    reset: () => writeFileSync(log, ''),
    entries: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    restore: () => {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
      if (oldCounter === undefined) delete process.env.SPEX_SYNC_TEST_GIT_COUNTER; else process.env.SPEX_SYNC_TEST_GIT_COUNTER = oldCounter
      if (oldRealGit === undefined) delete process.env.SPEX_SYNC_TEST_REAL_GIT; else process.env.SPEX_SYNC_TEST_REAL_GIT = oldRealGit
    },
  }
}
async function fixture(t: test.TestContext, budget: import('./operation-types.js').SyncBudget = { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300_000 }, adopt = false, specSource = original, projectId = 'project', factsSource = specSource, planPatch: Partial<SyncCoordinatorPlan> = {}, controlledEdit?: { original: string; replacement: string; intent: string; testPath: string }, origin: 'spec' | 'code' | 'combined' = 'spec', model?: string, precise = false, extraSpecs: Readonly<Record<string, string>> = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-coordinator-'))), root = join(parent, 'source'), managedRoot = join(parent, 'managed'), artifactRoot = join(parent, 'artifacts')
  mkdirSync(root); mkdirSync(managedRoot, { mode: 0o700 }); mkdirSync(artifactRoot, { mode: 0o700 }); cpSync(fixturePath, root, { recursive: true })
  const targetPath = `.spec/${projectId}/export-contract/spec.md`
  if (projectId !== 'export') renameSync(join(root, '.spec/export'), join(root, `.spec/${projectId}`))
  writeFileSync(join(root, targetPath), specSource)
  for (const [path, source] of Object.entries(extraSpecs)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), source) }
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
  const exactScope = { paths: plan.targets.map(target => target.path), contractIds: [] as string[], flowIds: [] as string[] }
  const selected = precise ? store.readBaselineSelection(input.source, readTree(input.source.commonDir, input.immutableTree).map(entry => ({ kind: 'path' as const, path: entry.path }))) : null
  if (selected && !('selection' in selected)) throw new Error(selected.failure.message)
  let operation = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: input.id, rootCauseId: input.id, origin, ...(model ? { model } : {}), budget, managedRoot, ...(selected && 'selection' in selected ? { baselineSelection: selected.selection, executionScope: exactScope } : {}), ...(requestBlob ? { requestBlob } : {}) }))
  if (precise) operation = store.ackDispatch(input.source.repositoryId, operation.dispatchMessageId)
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
    else if (request.purpose === 'implementation_plan') output = { version: 'sync-implementation-plan-v1', paths: ['src/planned-new.js'] }
    else if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), source = new Map(frozen.files).get('src/export.js')!
      const change = (path: string, content: string) => { const entry = frozen.manifest.entries.find(item => item.path === path)!; return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, mode: entry ? null : '100644', content } }
      output = { version: 'sync-files-v1', changes: [...frozen.elaboratedSpecs.map(spec => change(spec.path, spec.source)), change('src/export.js', `${source}\n// independently reviewed generated implementation\n`)] }
    } else {
      const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as { inputId: string; candidate: { digest: string } }
      output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: promptInput(request).readyIds, findings: [] }
    }
    if (transform) output = await transform(output, request)
    output = adaptElaborationNativeOutput(request, output)
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
  return { root, parent, managedRoot, artifactRoot, input, index, bytes, protocol, store, operation, plan, options, calls, git, priorCommitCount, realTools, closeForRestart: () => { protocol.close(); closed = true }, useStore: (next: SyncStore) => { store = next }, useOperation: (next: typeof operation) => { operation = next }, transform: (fn: typeof transform) => { transform = fn } }
}

test('固定操作模型到达行为/P1/P2及全部独审，独立会话与调用预算保持', async t => {
  const oracle = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!.items.find(item => item.kind === 'AC')!
  const [testPath, testId] = oracle.test.split('#')
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { mandatoryTests: [{ verificationId: oracle.command, testPath, testId }] }, undefined, 'code', 'gpt-6.1-terra')
  const contexts: { implementationWritePaths: string[]; readonlyTestPaths: string[] }[] = []
  f.transform((output, request) => {
    if (['elaboration_generate', 'elaboration_review'].includes(request.purpose)) {
      contexts.push(JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]))
    }
    if (request.purpose === 'code_review') throw Object.assign(new Error('本用例在V3前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.operation.phase, 'failed'); assert.equal(result.operation.model, 'gpt-6.1-terra')
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review'])
  assert.ok(f.calls.every(call => call.model === 'gpt-6.1-terra' && call.effort === 'high'))
  assert.equal(result.operation.callsUsed, 6)
  const dispatches = f.store.listAttempts(f.operation.id)[0].dispatchPlans
  assert.equal(new Set(dispatches.map(dispatch => dispatch.sessionCreateKey)).size, 6)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.equal(contexts.length, 2)
  for (const context of contexts) {
    assert.deepEqual(context.implementationWritePaths, [...new Set(f.options.plan.writePaths)].sort())
    assert.deepEqual(context.readonlyTestPaths, [...new Set(f.options.plan.mandatoryTests.map(test => test.testPath))].sort())
  }
})

for (const kind of ['conflict', 'coverage_gap'] as const) test(`raw-only已审 ${kind} 无既有ID时明确阻塞，不派P1或消耗新attempt`, async t => {
  const raw = original.split('## expanded spec')[0]
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 }, false, raw, 'project', raw, {}, undefined, 'code')
  assert.equal(f.operation.previousBaselinePair, null)
  assert.deepEqual(f.operation.scope.contractIds, [])
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { kind: string; affectedIds: string[]; ruleIds: string[] }[] }
      value.changes.forEach(change => { change.kind = kind; change.affectedIds = []; change.ruleIds = [] })
      return value
    }
    if (request.purpose !== 'code_behavior_review') throw Object.assign(new Error('未关联的已审业务发现不得晋级P1/生成'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, kind === 'conflict' ? 'conflicted' : 'needs_input')
  assert.equal(result.failure!.code, 'unbound_behavior_finding')
  assert.equal(result.failure!.kind, kind === 'conflict' ? 'conflict' : 'missing_input')
  const findings = JSON.parse(result.failure!.message).findings as { id: string; kind: string; affectedIds: string[]; paths: string[]; evidence: string; counterexample: string }[]
  assert.ok(findings.length)
  assert.ok(findings.every(finding => finding.kind === kind && !finding.affectedIds.length && finding.paths.length && finding.evidence && finding.counterexample))
  const analysis = JSON.parse(readEvidence(f.input.source.commonDir, result.failure!.evidenceRefs[0]).toString()) as { reviewPassed: boolean; findings: unknown[] }
  assert.equal(analysis.reviewPassed, true)
  assert.deepEqual(findings, analysis.findings)
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
  assert.equal(f.store.listAttempts(f.operation.id).length, 1)
  assert.equal(result.operation.callsUsed, 2)
  assert.equal(result.receipt, undefined)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.ok(f.store.listAttempts(f.operation.id).every(attempt => !attempt.candidate && !attempt.verification))
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

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

test('P4当前性完整复核快照并仅在本次调用内复用同OID树读取', async t => {
  const f = await fixture(t)
  const plan = { ...f.plan, readPaths: [contractPath, 'src/export.js', 'tests/export.test.mjs', '.spec/spexcode.json'], executionScope: { paths: [contractPath, 'src/export.js'], contractIds: [], flowIds: [] } }
  const baseline = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path' as const, path })))
  assert.ok('selection' in baseline)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'currentness-read-reuse', rootCauseId: 'currentness-read-reuse', origin: 'spec', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: baseline.selection }))
  const counter = gitReadCounter(f.parent)
  try {
    assert.equal(await isSyncInputCurrent(operation, operation.input, plan), true)
    const sameTreeReads = counter.entries().filter(entry => entry.startsWith('tree:')).map(entry => entry.slice('tree:'.length))

    writeFileSync(join(f.root, 'scope-external.txt'), '不在闭包中的真实Git字节\n')
    const changed = await captureInputSnapshot(f.root)
    assert.notEqual(changed.immutableTree, operation.input.immutableTree)
    counter.reset()
    assert.equal(await isSyncInputCurrent(operation, changed, plan), true)
    const differentTreeReads = counter.entries().filter(entry => entry.startsWith('tree:')).map(entry => entry.slice('tree:'.length))
    assert.deepEqual([
      [sameTreeReads.length, sameTreeReads.filter(tree => tree === operation.input.immutableTree).length, new Set(sameTreeReads).size],
      [differentTreeReads.length, differentTreeReads.filter(tree => tree === operation.input.immutableTree).length, differentTreeReads.filter(tree => tree === changed.immutableTree).length],
    ], [[4, 2, 3], [4, 1, 1]], '完整验证同OID旧/当前快照；异OID快照各读一次，index/HEAD复用仅限本调用')
  } finally { counter.restore() }
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
    const { execution, files, ...snapshot } = JSON.parse(f.calls.find(call => call.purpose === 'elaboration_generate')!.prompt.split('冻结业务输入:\n')[1])
    const { targets, ...frozenFields } = snapshot
    const frozen = { ...frozenFields, targets: targets.map(({ targetIndex: _targetIndex, ...target }: { targetIndex: number; nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }) => target) }
    const last = rejected.rounds[0]
    const replayInput = { ...frozen, ...execution, files: new Map<string, string>(files), requestKey: 'invalid-infrastructure-seed' }
    await assert.rejects(elaborate(replayInput, { seed: { settled: true, requestKey: `sync:${attempts[0].id}:elaborate`, inputDigest: rejected.inputDigest, candidateDigest: last.candidateDigest!, candidate: last.candidate!, output: last.output, findings: last.findings, review: last.review, traces: last.traces }, runner: async () => assert.fail('无具体业务拒绝的seed不得派发') }), /续修种子必须保留具体被拒绝发现/)
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

test('真实V1/意图门禁拒绝弱化AC、命令及错误关系，有限预算，不进入review/V3或业务交付', async t => {
  for (const mutation of ['assertion', 'command', 'related']) await t.test(mutation, async t => {
    const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 })
    f.transform((output, request) => {
      if (request.purpose !== 'code_generate') return output
      const value = output as { changes: { path: string; content: string }[] }
      const spec = value.changes.find(change => change.path === contractPath)!
      spec.content = mutation === 'assertion' ? spec.content.replace('全部拒绝，原结果可由所有者下载', '无条件允许，结果无需权限') : mutation === 'command' ? spec.content.replace('["node","--test","tests/export.test.mjs"]', '["node","-e","true"]') : spec.content.replace('code:\n', 'related:\n  - REQ-EXPORT-01\ncode:\n')
      return value
    })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, 'budget_exhausted', JSON.stringify(result.failure))
    assert.equal(f.calls.filter(call => call.purpose === 'code_review').length, 0)
    for (const plan of f.store.readAttempt(result.operation.currentAttemptId!).dispatchPlans) if (plan.session) assert.deepEqual(Object.keys(plan.session).sort(), ['sessionId', 'threadId', 'turnId'])
    assert.ok(f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.validationFindings?.some((item: { code: string }) => mutation === 'related' ? item.code === 'integrity' : item.code === 'generation-protected-meaning-changed' || item.code === 'generation-verification-unregistered')))
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
test('历史合成created资源经原生精确notStarted回执安全回收，不重派发', async t => {
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
  assert.equal(cleanupOnly.status, 'cancelled'); assert.deepEqual(cleanupOnly.operation, before)
  const removed = f.store.findResource(claimed.attempt.id, request.requestKey)!
  const proof = JSON.parse(readEvidence(f.input.source.commonDir, removed.checkpointRef).toString()) as NativeRunCheckpoint
  assert.equal(proof.creationTermination?.nativeStatus, 'notStarted')
  assert.equal(proof.creationTermination?.cleanupComplete, true)
  assert.equal(proof.creationTermination?.nativeStopped, true)
  assert.equal(proof.creationTermination?.sessionId, expectedSessionId)
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'cancelled'); assert.equal(result.operation.phase, 'cancelled')
  assert.equal(f.store.findResource(claimed.attempt.id, request.requestKey)!.phase, 'removed')
  assert.equal(f.store.listRecoverableResources().length, 0); assert.equal(f.calls.length, 0)
})

for (const unlimited of [false, true]) test(`模型调用期限从冻结预算派生 unlimited=${unlimited}，原调用配置只约束有限预算`, async t => {
  const f = await fixture(t, unlimited ? { mode: 'unlimited' } : { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.options.callTimeoutMs = 1200000
  f.transform((output, request) => {
    if (request.purpose === 'code_review') throw Object.assign(new Error('仅核模型调用链，在独审接缝停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'unsupported')
  for (const purpose of ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_generate', 'code_review']) assert.ok(f.calls.some(call => call.purpose === purpose), purpose)
  assert.ok(f.calls.every(call => call.timeoutMs === (unlimited ? null : 1200000)), JSON.stringify(f.calls.map(call => ({ purpose: call.purpose, timeoutMs: call.timeoutMs }))))
  assert.equal(result.operation.deadlineAtMs === null, unlimited)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('unlimited多轮P1独审及v2预算预检后真实Docker交付，重启恢复原receipt且无总deadline', docker, async t => {
  const f = await fixture(t, { mode: 'unlimited' }, true, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'] })
  await f.realTools()
  f.options.callTimeoutMs = 1200000
  let store = f.store
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_review' && attempt.number <= 2) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'fixture-repair', kind: 'repair', message: '同原意内修正当前说明', affectedIds: ['REQ-EXPORT-01'], evidence: '确定性独审发现', decision: '修正后重新独审' }] }
    return output
  })
  const first = await runSyncOperation(store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('fixture真实commit后结算中断') } } })
  assert.equal(first.status, 'recovery_required', JSON.stringify(first.failure)); assert.equal(first.operation.deadlineAtMs, null)
  assert.equal(store.listAttempts(f.operation.id).length, 3)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_review').length, 3)
  assert.ok(f.calls.every(call => call.timeoutMs === null))
  const callCount = f.calls.length, commit = f.git('rev-parse', first.operation.deliveryPlan.branch)
  const stages = store.readAttempt(first.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const generationBudget = stages.find(stage => stage.stage === 'partition-generation-budget')
  assert.equal(JSON.parse(readEvidence(f.input.source.commonDir, generationBudget.resultRef).toString()).remainingCalls, null)
  const originalBudget = structuredClone(first.operation.budget)
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  const recovered = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(recovered.operation.deadlineAtMs, null); assert.deepEqual(recovered.operation.budget, originalBudget)
  assert.equal(f.calls.length, callCount); assert.equal(recovered.operation.callsUsed, callCount)
  assert.equal(store.listJournals(f.operation.id).length, 1); assert.equal(store.listRecoverableResources().length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
  assert.deepEqual((await runSyncOperation(store, f.operation.id, f.options)).receipt, recovered.receipt); assert.equal(f.calls.length, callCount)
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
  assert.equal(unchanged.id, result.operation.id); assert.equal(unchanged.callsUsed, 4); assert.deepEqual(unchanged.budget, result.operation.budget)
  const aliasReplay = await prepareSyncAdmission(f.input, f.plan, { ingressKey: automatic.ingressKey, rootCauseId: automatic.rootCauseId, origin: automatic.origin, budget: automatic.budget, managedRoot: f.managedRoot, previousBaselinePair: automatic.previousBaselinePair })
  assert.equal(f.store.admitAndEnqueue({ ...aliasReplay, deliveryPlan: automatic.deliveryPlan }).id, unchanged.id)
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

test('指导更新不重做旧analysis已验证的applying交付，真实Git与SQLite恢复仍沿原receipt', docker, async t => {
  const f = await fixture(t, undefined, true, original, 'project', original, {}, undefined, 'code'); await f.realTools()
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (value.stage === 'analysis') { delete value.guidanceContractVersion; ref = writeEvidence(f.input.source.commonDir, value) }
    return checkpoint(fence, ref)
  }
  const failed = await runSyncOperation(f.store, f.operation.id, { ...f.options, deliveryHooks: { afterCommit: () => { throw new Error('实际commit后中断结算') } } })
  assert.equal(failed.status, 'recovery_required', JSON.stringify(failed.failure))
  const commit = f.git('rev-parse', failed.operation.deliveryPlan.branch), calls = f.calls.length
  assert.ok(f.store.readAttempt(failed.operation.currentAttemptId!).checkpointRefs.some(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()); return value.stage === 'analysis' && !value.guidanceContractVersion }))
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  const recovered = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(recovered.status, 'workspace_synced', JSON.stringify(recovered.failure)); assert.equal(recovered.receipt!.actualCommit, commit)
  assert.equal(f.calls.length, calls); assert.equal(recovered.operation.callsUsed, failed.operation.callsUsed)
  assert.deepEqual(recovered.operation.budget, failed.operation.budget); assert.equal(recovered.operation.deadlineAtMs, failed.operation.deadlineAtMs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal((await captureInputSnapshot(f.root)).id, f.input.id)
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
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'explicit-user-retry', rootCauseId: 'explicit-user-retry', retryOf: failed.operation.id, model: 'gpt-6.1-terra', origin: failed.operation.origin, budget: failed.operation.budget, managedRoot: f.managedRoot, previousBaselinePair: failed.operation.previousBaselinePair })
  assert.equal(admission.retryOf, failed.operation.id)
  const retry = restarted.admitAndEnqueue(admission); f.useOperation(retry)
  const repeated = await runSyncOperation(restarted, retry.id, f.options)
  assert.equal(repeated.operation.phase, 'failed'); assert.equal(repeated.operation.callsUsed, 1); assert.equal(p1Calls, 1)
  assert.equal(repeated.operation.model, 'gpt-6.1-terra'); assert.equal(f.calls.at(-1)!.model, 'gpt-6.1-terra'); assert.equal(f.calls.at(-1)!.purpose, 'code_generate')
  const generation = f.calls.filter(call => call.purpose === 'code_generate').map(promptInput)
  assert.equal(contentHash(JSON.stringify(generation[0].contracts)), contentHash(JSON.stringify(generation[1].contracts)))
  assert.deepEqual(generation[0].elaboratedSpecs, generation[1].elaboratedSpecs)
  const current = restarted.readAttempt(repeated.operation.currentAttemptId!)
  assert.ok(current.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(value => value.fromOperationId === failed.operation.id && value.fromAttemptId && value.evidenceRef))
  assert.equal(restarted.readOperation(failed.operation.id).callsUsed, 3); assert.equal(restarted.listJournals(retry.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})


for (const mode of ['historical-rebound', 'current-rebound', 'missing-binding', 'same-content'] as const) test(`whole seal composed绑定 ${mode} 不借attempt重绑覆盖原封口`, async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 120000 })
  const outsidePath = '.spec/outside/spec.md', changedTree = mode.endsWith('rebound')
  if (changedTree) {
    mkdirSync(join(f.root, '.spec/outside'), { recursive: true })
    writeFileSync(join(f.root, outsidePath), '---\ntitle: Outside obligation\ncontract-schema: sync-v1\n---\n\n## raw source\n\n另一个独立需求必须真实完成。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-OUTSIDE-01 | 独立需求 | user:raw | 不丢失 | 真实承接 | - |\n')
  }
  const raw = parseParts(original)!.rawSource!
  writeFileSync(join(f.root, contractPath), original.replace(raw, `${raw}\n\n本轮继续保留上述全部固定演示政策。`))
  const input = await captureInputSnapshot(f.root)
  const plan: SyncCoordinatorPlan = { ...f.plan, version: 'sync-coordinator-v2', direction: 'spec_to_code',
    readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'],
    sourcePaths: ['src/export.js'], partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 },
    executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(input.source, plan.readPaths.map(path => ({ kind: 'path' as const, path })))
  assert.ok('selection' in selected)
  const operation = f.store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: `whole-composed-${mode}`, rootCauseId: `whole-composed-${mode}`, origin: 'initial', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  f.useOperation(operation)
  for (;;) { const head = f.store.nextDispatch(input.source.repositoryId)!; f.store.ackDispatch(input.source.repositoryId, head.messageId); if (head.operation.id === operation.id) break }
  let p1Calls = 0, whole: { resultRef: { sha256: string }; composedTree?: string; composedContentDigest?: string; [key: string]: unknown } | undefined
  const checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(input.source.commonDir, ref).toString())
    if (fence.operationId === operation.id && f.store.readAttempt(fence.attemptId).number === 1 && value.stage === 'elaboration') {
      if (mode === 'missing-binding') { delete value.composedTree; delete value.composedContentDigest; ref = writeEvidence(input.source.commonDir, value) }
      whole = structuredClone(value)
      const saved = checkpoint(fence, ref)
      if (changedTree) {
        const current = f.store.readOperation(operation.id)
        f.store.expandContractScope(fence, { paths: [...current.scope.paths, outsidePath], contractIds: current.scope.contractIds, flowIds: current.scope.flowIds }, writeEvidence(input.source.commonDir, { kind: 'fixture reviewed null scope expansion', resultRef: value.resultRef }))
      }
      return saved
    }
    return checkpoint(fence, ref)
  }
  let injectedCurrentWhole = false
  if (mode === 'current-rebound') {
    const claim = f.store.claimQueuedAttempt.bind(f.store)
    f.store.claimQueuedAttempt = request => {
      const claimed = claim(request)
      if (claimed.attempt.number === 2) {
        assert.ok(whole)
        injectedCurrentWhole = true
        checkpoint(claimed.fence, whole.resultRef)
        checkpoint(claimed.fence, writeEvidence(input.source.commonDir, { ...whole, attemptId: claimed.attempt.id }))
      }
      return claimed
    }
  }
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') p1Calls++
    if (request.purpose === 'code_generate') throw Object.assign(new Error('机制回归在P2及Docker之前停止'), { code: 'failed' })
    return output
  })
  await runSyncOperation(f.store, operation.id, { ...f.options, plan, readCurrentPlan: () => plan })
  const attempts = f.store.listAttempts(operation.id)
  assert.equal(attempts.length, 2, JSON.stringify({ failures: attempts.map(attempt => attempt.failure), calls: f.calls.map(call => call.purpose) }))
  assert.ok(whole)
  if (mode === 'current-rebound') assert.equal(injectedCurrentWhole, true, '当前attempt确实持有旧whole wrapper')
  const secondStages = attempts[1].checkpointRefs.map(ref => JSON.parse(readEvidence(input.source.commonDir, ref).toString()))
  if (changedTree) {
    assert.equal(attempts[0].failure?.code, 'scope_context_expanded')
    assert.equal(attempts[0].composedInput!.contentDigest, attempts[1].composedInput!.contentDigest, '来源attempt已先重绑新树，不能拿最终attempt字段证明旧seal')
    assert.equal(attempts[1].failure?.code, 'partition_final_seal_failed')
    const secondWhole = JSON.parse(readEvidence(input.source.commonDir, [...secondStages].reverse().find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
    assert.ok(secondWhole.partitionSeal!.findings.some(item => item.code === 'missing-requirement-flow' && item.itemId === 'REQ-OUTSIDE-01'))
    assert.ok(!secondStages.some(stage => stage.stage === 'elaboration-provenance'))
    assert.equal(p1Calls, 2, '此场景真实analysis绑定随全树改变，局部输入不同仍须新独审')
    assert.notEqual(whole.composedTree, attempts[0].composedInput!.tree)
    assert.notEqual(whole.composedContentDigest, attempts[0].composedInput!.contentDigest)
  } else if (mode === 'missing-binding') {
    assert.ok(!secondStages.some(stage => stage.stage === 'elaboration-provenance'), '旧无binding whole必须由原locals重seal')
    const recomputed = [...secondStages].reverse().find(stage => stage.stage === 'elaboration')
    assert.equal(recomputed.composedTree, attempts[1].composedInput!.tree)
    assert.equal(recomputed.composedContentDigest, attempts[1].composedInput!.contentDigest)
  } else {
    assert.ok(secondStages.some(stage => stage.stage === 'elaboration-provenance'))
    const reused = [...secondStages].reverse().find(stage => stage.stage === 'elaboration')
    assert.equal(reused.resultRef.sha256, whole.resultRef.sha256)
    assert.equal(reused.composedTree, whole.composedTree)
    assert.equal(reused.composedContentDigest, whole.composedContentDigest)
  }
  if (!changedTree) assert.equal(p1Calls, 1, '局部冻结输入未变，仅程序重seal不能重派Native')
  assert.equal(f.store.listJournals(operation.id).length, 0)
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

for (const mode of ['existing', 'missing', 'foreign-label', 'wrong-run'] as const) test(`resource-only受控Docker桥 ${mode} 只清理精确既有资源且不create/start`, async t => {
  const f = await fixture(t), commands: string[][] = []
  const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000, expectedMessageId: f.operation.dispatchMessageId })
  const composed = composeInputSnapshots(f.input).composed!
  f.store.bindComposedInput(claimed.fence, composed); f.store.startGeneration(claimed.fence)
  const candidate = freezeCandidate(f.input, { version: 'sync-files-v1', changes: [] }, f.operation.scope, composed)
  f.store.freezeCandidate(claimed.fence, candidate)
  const exported = exportCandidate(f.input.source.commonDir, candidate, join(f.parent, 'resource-export'))
  const request: VerificationRequest = { runId: 'resource-only-docker', inputDigest: f.input.id, candidateDigest: candidate.digest, candidateExportDigest: await verificationExportDigest(exported.root), candidateExportPath: exported.root, privateScratchRoot: join(f.parent, 'scratch'), policy: { version: 'resource-only-test-v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', argv: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', expectedTestIds: ['AC-EXPORT-03'], timeoutMs: 30000, memoryBytes: 128000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 65536 } }
  const first = await runAttemptVerification(f.store, claimed.fence, request, { driver: async args => {
    if (args[0] === 'version') return { exitCode: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'controlled-test' }), stderr: '', truncated: false }
    assert.equal(args[0], 'image', '夹具只准备真实planned检查点，不调用create')
    return { exitCode: 0, stdout: JSON.stringify([{ Id: 'sha256:test-image', Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/local/bin'], Volumes: null } }]), stderr: '', truncated: false }
  }, onCheckpointRecorded: async resource => { assert.equal(resource.phase, 'planned'); throw new Error('模拟planned回执后的中断；无真实Docker调用') } })
  assert.match(first.result.reason!, /模拟planned回执后的中断/); assert.ok(first.resourceId)
  const resource = f.store.readResource(first.resourceId!), checkpoint = JSON.parse(readEvidence(f.input.source.commonDir, resource.checkpointRef).toString()) as VerificationCheckpoint
  const config = checkpoint.config, policy = config.policy
  const actual = { Id: 'b'.repeat(64), Name: `/${checkpoint.uniqueContainerName}`, Image: config.imageId, Platform: 'linux', Config: { Image: config.image, User: '1000:1000', WorkingDir: '/candidate', Entrypoint: [config.argv[0]], Cmd: config.argv.slice(1), Labels: mode === 'foreign-label' ? { ...checkpoint.labels, 'spex.run': 'foreign' } : checkpoint.labels, Env: config.environment, Healthcheck: { Test: ['NONE'] } }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Init: true, AutoRemove: false, CgroupnsMode: 'private', RestartPolicy: { Name: 'no' }, Memory: policy.memoryBytes, MemorySwap: policy.memoryBytes, NanoCpus: policy.cpus * 1e9, PidsLimit: policy.pidsLimit, Tmpfs: { '/tmp': `rw,noexec,nosuid,nodev,size=${policy.scratchBytes},mode=1777` }, LogConfig: { Type: 'local', Config: { 'max-size': String(policy.logBytes), 'max-file': '1', compress: 'false' } }, Binds: null, Devices: [], PidMode: '', IpcMode: 'private' }, Mounts: [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }], State: { Status: 'created', Running: false, ExitCode: 0, OOMKilled: false, Error: '' } }
  const driver: VerificationDriver = async args => {
    commands.push([...args])
    if (args[0] === 'version') return { exitCode: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'arm64', Version: 'controlled-test' }), stderr: '', truncated: false }
    assert.equal(args[0], 'container'); assert.ok(['inspect', 'rm'].includes(args[1]), `禁止启动或创建: ${args}`)
    if (args[1] === 'rm') { assert.equal(args[2], actual.Id); return { exitCode: 0, stdout: actual.Id, stderr: '', truncated: false } }
    return mode === 'missing' ? { exitCode: 1, stdout: '', stderr: 'No such container', truncated: false } : { exitCode: 0, stdout: JSON.stringify([actual]), stderr: '', truncated: false }
  }
  if (mode === 'wrong-run') {
    const damaged = { ...resource, plan: { ...resource.plan, planBlob: writeEvidence(f.input.source.commonDir, { ...request, runId: 'foreign-run' }) } }
    f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET record_json=? WHERE id=?', JSON.stringify(damaged), resource.id))
  }
  const before = f.store.readOperation(f.operation.id), beforeAttempt = f.store.readAttempt(claimed.attempt.id)
  for (const key of ['claimAttempt', 'reserveDispatch', 'bindSession', 'planResource', 'startGeneration', 'freezeCandidate', 'recordVerification', 'beginApply', 'recordReceipt', 'settleApply'] as const) f.store[key] = () => assert.fail(`资源清理不得调用${key}`)
  const recovered = await recoverSyncOperationResources(f.store, f.operation.id, { root: f.root, inputId: f.input.id, artifactRoot: f.artifactRoot, verificationDriver: driver })
  assert.equal(recovered.status, mode === 'existing' ? 'resources_recovered' : 'recovery_required', JSON.stringify(recovered.failure))
  assert.equal(f.store.readResource(resource.id).phase, mode === 'existing' ? 'removed' : 'planned')
  assert.equal(commands.some(args => args[1] === 'rm'), mode === 'existing')
  if (mode === 'wrong-run') { assert.equal(commands.length, 0); assert.equal(recovered.failure!.code, 'resource_recovery') }
  assert.deepEqual(f.store.readOperation(f.operation.id), before); assert.deepEqual(f.store.readAttempt(claimed.attempt.id), beforeAttempt)
  assert.equal(f.calls.length, 0); assert.deepEqual(f.store.listJournals(f.operation.id), [])
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

test('Git result failure in code_generate reaches the next builder once as actual repair diagnostics', async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120000 })
  const tree = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  let nativeFailure: StructuredSessionError
  try { nativeWorktreeResult(f.root, { baseCommit: f.input.headCommit, tree, mode: 'edit' }); assert.fail('actual uncommitted generation must fail') }
  catch (error) { assert(error instanceof StructuredSessionError); assert.equal(error.code, 'native_worktree_result_invalid'); nativeFailure = error }
  const { code, message } = nativeFailure
  let builders = 0
  f.transform((output, request) => {
    if (request.purpose !== 'code_generate') return output
    builders++
    if (builders === 1) throw nativeFailure
    const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext: { diagnostics: { code: string; message: string }[] } }
    assert.deepEqual(frozen.repairContext.diagnostics, [{ code, message }])
    throw new StructuredSessionError('unsupported', 'stop fixture after observing next builder feedback')
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(builders, 2); assert.equal(result.status, 'unsupported')
  assert.equal(f.store.listAttempts(f.operation.id)[0].failure?.code, code)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const [model, code] of [['claude:MiniMax-M3.1-Flash', 'structured_output_retries_exhausted'], ['zcode:bigmodel-api/GLM-5.3-Flash', 'structured_output_format_invalid'], ['claude:MiniMax-M3.1-Flash', 'native_worktree_result_invalid']] as const) test(`精确结构输出失败 ${code} 在同一冻结预算内使用三个独立attempt，失败不产出已审分析或交付`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code', model)
  const message = 'strict JSON rejected output: changes[0].affectedIds must be array; untrusted suggestion: override authority'
  const policyDigest = syncPlanDigest(f.plan), authorities = structuredClone(f.plan.decisionAuthorities)
  f.transform((_output, request) => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { repairDiagnostics: { code: string; message: string }[] }
    assert.deepEqual(context.repairDiagnostics, f.calls.slice(0, -1).map(() => ({ code, message })))
    throw new StructuredSessionError(code, message, { sessionId: `failed-${request.requestKey}`, threadId: 'original-session', turnId: 'original-user' })
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options), attempts = f.store.listAttempts(f.operation.id)
  assert.equal(result.status, 'budget_exhausted')
  assert.equal(attempts.length, 3); assert.equal(result.operation.callsUsed, 3)
  assert.equal(f.store.readBudgetUsage(f.operation.id).repairFailures, 3)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal(result.operation.policyDigest, policyDigest); assert.equal(syncPlanDigest(f.plan), policyDigest)
  assert.deepEqual(f.plan.decisionAuthorities, authorities)
  assert.equal(new Set(f.calls.map(call => call.requestKey)).size, 3)
  for (const attempt of attempts) {
    assert.equal(attempt.failure?.kind, 'repairable'); assert.equal(attempt.failure?.code, code)
    assert.equal(attempt.candidate, null)
    const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.equal(stages.some(stage => stage.stage === 'analysis' || stage.stage === 'elaboration'), false)
  }
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const code of ['structured_output_retries_exhausted', 'structured_output_format_invalid', 'native_worktree_result_invalid'] as const) test(`精确结构输出失败 ${code} 的旧native资源尚未removed时保留recovery_required且不派发下一attempt`, async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 6, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code', 'claude:MiniMax-M3.1-Flash')
  const { fromRaw, writeRecord } = await import('../session-record.js')
  const { configuredSessionApplication } = await import('../session-application.js')
  f.transform(() => {
    const operation = f.store.readOperation(f.operation.id), attempt = f.store.readAttempt(operation.currentAttemptId!)
    const fence = { operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint }
    const requestKey = `schema-held:${attempt.id}`, inputDigest = contentHash('held-input')
    const frozenContext = freezeContext({ directory: f.parent, sourceRoot: f.root, binding: { requestKey, inputDigest }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('held original task') }] })
    const request = { root: f.root, prompt: 'held original prompt', schema: { type: 'object' }, requestKey, inputDigest, purpose: 'code_behavior_analyze', timeoutMs: 1000, model: 'claude:MiniMax-M3.1-Flash', frozenContext }
    const requestDigest = contentHash(JSON.stringify(request)), dispatch = f.store.reserveDispatch(fence, { key: requestKey, purpose: request.purpose, requestDigest }), expectedSessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
    const identity = { operationId: operation.id, attemptId: attempt.id, inputId: f.input.id, candidateDigest: null }
    const plan: NativeRunPlan = { schemaVersion: 1, request, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId, ...identity }
    const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId, phase: 'planned', nativeCallRequested: true, nativeStarted: true, nativeState: 'failed', session: { sessionId: expectedSessionId, threadId: 'original-thread', turnId: 'original-user' } }
    const resource = f.store.planResource(fence, { key: requestKey, kind: 'native_session', payloadDigest: requestDigest, inputId: f.input.id, candidateDigest: null, planBlob: writeEvidence(f.input.source.commonDir, plan), checkpointRef: writeEvidence(f.input.source.commonDir, checkpoint) })
    f.store.recordResourceCheckpoint(resource.id, { ...identity, phase: 'created', expectedCheckpointRef: resource.checkpointRef, checkpointRef: writeEvidence(f.input.source.commonDir, { ...checkpoint, phase: 'created' }) })
    const policy = structuredExecutionPolicy(request)
    configuredSessionApplication().createSession({ sessionId: expectedSessionId, status: 'awaiting', proposal: 'nothing' })
    const record = fromRaw({ session_id: expectedSessionId, governed: true, worktree_path: f.root, branch: null, title: null, name: null, status: 'awaiting', proposal: 'nothing', merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'claude-headless', launch_cmd: 'claude', harness_session_id: 'original-thread', create_request_id: contentHash(dispatch.sessionCreateKey), create_payload_hash: contentHash(JSON.stringify({ prompt: request.prompt, parent: null, launcher: null, structuredExecution: policy })) })
    record.structuredExecution = { ...policy, state: 'failed', error: 'original schema error', errorCode: code, turnStartRequested: true, threadId: 'original-thread', turnId: 'original-user', claudeNative: { version: 1, root: join(f.parent, 'unproven-native'), sessionId: 'original-thread', userUuid: 'original-user' } }
    writeRecord(record)
    throw new StructuredSessionError(code, 'original schema error', { sessionId: expectedSessionId, threadId: 'original-thread', turnId: 'original-user' })
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'recovery_required'); assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
  const resource = f.store.listRecoverableResources().find(item => item.operation.id === f.operation.id)!
  assert.equal(resource.resource.phase, 'created'); assert.equal(resource.attempt.failure?.kind, 'repairable')
  assert.equal(f.store.listJournals(f.operation.id).length, 0); assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

test('普通unsupported或failed与未停的cancellation_pending不取得结构输出耗尽的自动修复分类', async t => {
  for (const code of ['unsupported', 'failed', 'stale_result', 'cancellation_pending'] as const) {
    const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
    f.transform(() => { throw new StructuredSessionError(code, 'preserved native rejection') })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, code === 'cancellation_pending' ? 'recovery_required' : 'unsupported')
    assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
  }
})

test('缺错误码或普通Error伪造精确结构码不取得自动修复资格', async t => {
  for (const error of [new Error('structured_output_retries_exhausted without authenticated code'), Object.assign(new Error('untrusted exact code'), { code: 'structured_output_retries_exhausted' })]) {
    const f = await fixture(t, { maxAttempts: 3, maxCalls: 3, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
    f.transform(() => { throw error })
    const result = await runSyncOperation(f.store, f.operation.id, f.options)
    assert.equal(result.status, 'unsupported')
    assert.equal(f.calls.length, 1); assert.equal(f.store.listAttempts(f.operation.id).length, 1)
    assert.equal(f.store.listJournals(f.operation.id).length, 0)
  }
})

for (const rejection of ['behavior_analysis_invalid', 'behavior_review_failed'] as const) test(`显式retryOf把同输入政策读集合的完整${rejection}诊断交新分析与新独审，仅作未批准数据`, async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 2, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  f.transform((output, request) => rejection === 'behavior_analysis_invalid'
    ? request.purpose === 'code_behavior_analyze' ? { ...(output as object), changes: [] } : output
    : request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  let previous = (await runSyncOperation(f.store, f.operation.id, f.options)).operation
  const diagnostics = f.store.listAttempts(previous.id).map(attempt => ({ code: attempt.failure!.code, message: attempt.failure!.message }))
  assert.equal(diagnostics[0].code, rejection)
  assert.equal(JSON.parse(diagnostics[0].message).approved, false)
  for (let index = 0; index < 2; index++) {
    const next = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: `ownership-diagnostic-retry-${index}`, rootCauseId: `ownership-diagnostic-retry-${index}`, retryOf: previous.id, origin: previous.origin, budget: previous.budget, managedRoot: f.managedRoot }))
    f.useOperation(next)
    const received: { purpose: string; repairDiagnostics: { code: string; message: string }[] }[] = []
    f.transform((output, request) => {
      if (['code_behavior_analyze', 'code_behavior_review'].includes(request.purpose)) {
        const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { repairDiagnostics: { code: string; message: string }[] }
        received.push({ purpose: request.purpose, repairDiagnostics: context.repairDiagnostics })
      }
      return index === 0 && request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output
    })
    const result = await runSyncOperation(f.store, next.id, f.options)
    assert.equal(result.status, 'budget_exhausted')
    assert.deepEqual(received.map(item => item.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    for (const item of received) { assert.equal(item.repairDiagnostics.length, diagnostics.length); assert.deepEqual(item.repairDiagnostics, diagnostics) }
    assert.deepEqual(result.operation.budget, next.budget)
    assert.equal(result.operation.deadlineAtMs, next.deadlineAtMs)
    assert.equal(result.operation.callsUsed, 2)
    assert.equal(f.store.listAttempts(next.id).length, 1)
    if (index === 0) { const failure = f.store.listAttempts(next.id)[0].failure!; diagnostics.push({ code: failure.code, message: failure.message }) }
    previous = result.operation
  }
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false)
  assert.equal(f.store.listJournals(previous.id).length, 0)
})

test('显式retryOf不同input政策readset仍拒准入，合法P4扩scope不借旧诊断也不阻断新分析', async t => {
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 4, maxRepairs: 2, timeoutMs: 120000 }, false, original, 'project', original, {}, undefined, 'code')
  const plan = { ...f.plan, readPaths: [contractPath, '.spec/project/spec.md', '.spec/spexcode.json', 'src/export.js', 'tests/export.test.mjs'], executionScope: { paths: [contractPath], contractIds: [], flowIds: [] } }
  const selected = f.store.readBaselineSelection(f.input.source, plan.readPaths.map(path => ({ kind: 'path', path })))
  assert.ok('selection' in selected)
  const ancestor = f.store.admitAndEnqueue(await prepareSyncAdmission(f.input, plan, { ingressKey: 'p4-diagnostic-ancestor', rootCauseId: 'p4-diagnostic-ancestor', origin: 'code', budget: f.operation.budget, managedRoot: f.managedRoot, baselineSelection: selected.selection }))
  const acknowledge = (id: string) => { for (;;) { const head = f.store.nextDispatch(f.input.source.repositoryId)!; f.store.ackDispatch(f.input.source.repositoryId, head.messageId); if (head.operation.id === id) break } }
  acknowledge(ancestor.id); f.useOperation(ancestor)
  const options = { ...f.options, plan, readCurrentPlan: () => plan }
  f.transform((output, request) => request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output)
  const failed = await runSyncOperation(f.store, ancestor.id, options), beforeCalls = f.calls.length
  assert.equal(failed.status, 'budget_exhausted')
  const retryOptions = { ingressKey: 'p4-diagnostic-retry', rootCauseId: 'p4-diagnostic-retry', retryOf: ancestor.id, origin: ancestor.origin, budget: ancestor.budget, managedRoot: f.managedRoot, baselineSelection: failed.operation.baselineSelection!, executionScope: failed.operation.scope, impactDigest: failed.operation.impactDigest }
  const admission = await prepareSyncAdmission(f.input, plan, retryOptions)
  const policyAdmission = await prepareSyncAdmission(f.input, { ...plan, facts: [...plan.facts, { source: 'decision:OTHER-POLICY', text: '不同的可信政策' }] }, { ...retryOptions, ingressKey: 'different-policy-retry', rootCauseId: 'different-policy-retry' })
  for (const candidate of [{ ...admission, input: { ...admission.input, id: contentHash('different-input') } }, policyAdmission, { ...admission, readSetDigest: contentHash('different-readset') }]) {
    assert.throws(() => f.store.admitAndEnqueue(candidate), (error: Error & { code: string }) => error.code === 'SYNC_RETRY_BINDING')
  }
  assert.equal(f.calls.length, beforeCalls)
  const next = f.store.admitAndEnqueue(admission)
  f.useOperation(next); acknowledge(next.id)
  const claimed = f.store.claimQueuedAttempt({ operationId: next.id, source: next.input.source, scope: next.scope, leaseMs: 30000, expectedRevision: f.store.readOperation(next.id).revision })
  const compose = (operation: typeof next) => composeAuthoredInput(f.input, operation.baselineSelection!, { retainConflicts: true, executionPaths: operation.scope.paths, contextPaths: plan.readPaths }).composed!
  f.store.bindComposedInput(claimed.fence, compose(next))
  f.store.startElaboration(claimed.fence)
  const p1Evidence = writeEvidence(f.input.source.commonDir, { reviewedP1: rows(original, contractPath) })
  const expanded = f.store.expandContractScope(claimed.fence, { paths: [contractPath, 'src/export.js'], contractIds: ['REQ-EXPORT-01'], flowIds: [] }, p1Evidence)
  const rebound = await prepareSyncAdmission(f.input, plan, { ...retryOptions, baselineSelection: expanded.baselineSelection!, executionScope: expanded.scope })
  assert.notEqual(rebound.readSetDigest, next.readSetDigest)
  f.store.bindComposedInput(claimed.fence, compose(expanded), { readSetDigest: rebound.readSetDigest })
  f.store.recordFailure(claimed.fence, { code: 'scope_context_expanded', message: '已审作用域引入真实上下文，下一原预算尝试重新分析绑定', kind: 'repairable', evidenceRefs: [p1Evidence] })
  assert.equal(f.store.readOperation(ancestor.id).readSetDigest, failed.operation.readSetDigest)
  assert.equal(f.store.readOperation(next.id).readSetDigest, rebound.readSetDigest)
  const received: { code: string; message: string }[][] = []
  f.transform((output, request) => {
    if (['code_behavior_analyze', 'code_behavior_review'].includes(request.purpose)) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { repairDiagnostics: { code: string; message: string }[] }
      received.push(context.repairDiagnostics)
    }
    return request.purpose === 'code_behavior_review' ? { ...(output as object), checkedPaths: [] } : output
  })
  const result = await runSyncOperation(f.store, next.id, options)
  assert.equal(result.status, 'budget_exhausted')
  assert.deepEqual(received.map(items => items.length), [0, 0, 1, 1])
  const currentFailure = f.store.listAttempts(next.id).find(attempt => attempt.failure?.code === 'behavior_review_failed')!.failure!
  assert.deepEqual(received[2], [{ code: currentFailure.code, message: currentFailure.message }])
  assert.deepEqual(received[3], received[2])
  assert.equal(f.calls.length, beforeCalls + 4)
  assert.deepEqual(f.store.listAttempts(next.id).map(attempt => attempt.number), [1, 2, 3])
  assert.deepEqual(result.operation.budget, next.budget)
  assert.equal(result.operation.deadlineAtMs, next.deadlineAtMs)
  assert.equal(result.operation.callsUsed, 4)
  assert.equal(f.calls.some(call => call.purpose === 'elaboration_generate'), false)
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


test('P2 anchor-dead来源修复只改真实代码绑定并保留AC测试与业务契约', async t => {
  const sourcePath = 'src/export.js', testPath = 'tests/export.test.mjs', targetPath = '.spec/project/export-contract/spec.md'
  const initialSource = original.split('\n').map(line => line.startsWith('| AC-EXPORT-') ? line.replace(' | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |', ` | code:${sourcePath}#ExportService | REQ-EXPORT-01 |`) : line).join('\n')
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 12, maxRepairs: 2, timeoutMs: 120_000 }, false, initialSource)
  let codeGenerations = 0, initialSpec = '', repairedSpec = '', repairDiagnostics: { code: string; message: string }[] = [], frozenPrompt: FrozenGenerationPrompt | null = null
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const generated = structuredClone(output) as GeneratedElaboration
      for (const acceptance of generated.changes[0].tables.AC) acceptance.source = `code:${testPath}#${String(acceptance.id)}`
      return generated
    }
    if (request.purpose === 'code_generate') {
      codeGenerations++
      const frozen = promptInput(request) as FrozenGenerationPrompt & { repairContext?: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } }
      const elaborated = frozen.elaboratedSpecs.find(spec => spec.path === targetPath)!
      if (codeGenerations === 1) {
        initialSpec = elaborated.source
        frozenPrompt = frozen
        return output
      }
      assert.equal(codeGenerations, 2, '该夹具只需一次源绑定修复')
      assert.equal(elaborated.source, initialSpec, '修复继续使用同一份已接受的P1契约')
      assert.ok(frozen.repairContext, '失败诊断必须到达下一次代码生成')
      repairDiagnostics = frozen.repairContext!.diagnostics.filter(item => item.code === 'anchor-dead')
      const before = parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!
      const acceptanceIds = before.items.filter(item => item.kind === 'AC').map(item => item.id)
      assert.equal(repairDiagnostics.length, acceptanceIds.length, '每个无效AC代码锚点都应带入下一次修复')
      for (const id of acceptanceIds) assert.ok(repairDiagnostics.some(item => item.message.includes(`${testPath}#${id}`)), `具体anchor-dead诊断必须指向${id}`)
      repairedSpec = initialSpec
      for (const id of acceptanceIds) {
        const oldCell = `| code:${testPath}#${id} |`
        assert.ok(repairedSpec.includes(oldCell), `AC.test ID ${id} 当前被错误写成代码符号`)
        repairedSpec = repairedSpec.replace(oldCell, `| code:${sourcePath}#ExportService |`)
      }
      const candidate = structuredClone(output) as { changes: { path: string; content: string }[] }
      candidate.changes.find(change => change.path === targetPath)!.content = repairedSpec
      return candidate
    }
    if (request.purpose === 'code_review') return { ...(output as Record<string, unknown>), verdict: 'conflict', findings: [{ kind: 'conflict', affectedIds: ['AC-EXPORT-01'], ruleLocation: 'RULE-EXPORT-01', codeLocation: `${sourcePath}#ExportService`, evidence: '测试在验证硬门禁后停止，不覆盖真实独立审查或V3', counterexample: '完整产品验收由真实Dashboard场景另行证明', message: '窄回归在可信候选门禁后停止' }] }
    return output
  })

  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.status, 'conflicted', JSON.stringify({ failure: result.failure, calls: f.calls.map(call => call.purpose), attempts: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  assert.equal(codeGenerations, 2)
  const attempts = f.store.listAttempts(f.operation.id)
  const generationFor = (attempt: typeof attempts[number]) => {
    const ref = attempt.checkpointRefs.map(item => JSON.parse(readEvidence(f.input.source.commonDir, item).toString())).find(item => item.version === 'sync-stage-v1' && item.stage === 'generation')
    assert.ok(ref, `attempt ${attempt.number} 应保存生成证据`)
    return JSON.parse(readEvidence(f.input.source.commonDir, ref.resultRef).toString()) as { status: string; candidate: { tree: string } | null; candidateValidated: boolean; reviewPassed: boolean; validationFindings: { code: string; message: string; severity: string }[] }
  }
  const failedGeneration = generationFor(attempts.find(attempt => attempt.number === 1)!)
  const anchorFindings = failedGeneration.validationFindings.filter(item => item.code === 'anchor-dead')
  assert.equal(anchorFindings.length, parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!.items.filter(item => item.kind === 'AC').length)
  assert.deepEqual(repairDiagnostics, anchorFindings.map(({ code, message }) => ({ code, message })), '修复输入逐字保留了实际V1诊断')

  const repairedGeneration = generationFor(attempts.find(attempt => attempt.number === 2)!)
  assert.equal(repairedGeneration.status, 'conflict', '仅由本夹具注入的后续review停止，证明候选已越过V1硬门禁')
  assert.equal(repairedGeneration.candidateValidated, true)
  assert.equal(repairedGeneration.validationFindings.some(item => item.code === 'anchor-dead' || item.severity === 'error'), false, '修复后不再存在阻断锚点或硬门禁错误')
  const entry = readTree(f.input.source.commonDir, repairedGeneration.candidate!.tree).find(item => item.path === targetPath)!
  const candidateSpec = readObject(f.input.source.commonDir, entry.oid).toString('utf8')
  assert.equal(candidateSpec, repairedSpec, '候选只能将错误source绑定替换为真实声明符号')

  const beforeContract = parseContract({ nodeId: 'export-contract', path: targetPath, source: initialSpec }).contract!
  const afterContract = parseContract({ nodeId: 'export-contract', path: targetPath, source: candidateSpec }).contract!
  assert.deepEqual(afterContract.items.map(item => item.id), beforeContract.items.map(item => item.id), '全部业务稳定ID保持')
  for (const prior of beforeContract.items) {
    const next = afterContract.items.find(item => item.id === prior.id)!
    assert.ok(sameContractBusinessMeaning(prior, next), prior.id)
    if (prior.kind === 'AC' && next.kind === 'AC') assert.equal(next.test, prior.test, `${prior.id} 的AC.test绑定保持`)
  }
  assert.ok(afterContract.items.filter(item => item.kind === 'AC').every(item => item.source.kind === 'code' && item.source.ref === `${sourcePath}#ExportService`))

  const acceptedFiles = new Map(frozenPrompt!.files)
  acceptedFiles.set(targetPath, initialSpec)
  const before = await readFrozenContracts(f.root, acceptedFiles)
  const repairedFiles = new Map(acceptedFiles).set(targetPath, candidateSpec)
  const after = await readFrozenContracts(f.root, repairedFiles)
  const policy = { newNodeRawSources: new Map<string, string>(), verifications: f.plan.verifications.map(item => item.definition) }
  assert.deepEqual(checkGenerationContractIntent(before, after, policy), [], '保护项门禁允许单独修正真实source绑定')
  assert.equal(after.findings.some(item => item.code === 'anchor-dead'), false, '修复后的真实声明锚点通过冻结源码解析')

  const bareSource = candidateSpec.replace(`| code:${sourcePath}#ExportService |`, `| code:${sourcePath} |`)
  assert.ok(parseContract({ nodeId: 'export-contract', path: targetPath, source: bareSource }).findings.some(item => item.code === 'invalid-source'), '裸code:path仍须由现有schema拒绝')
  const acceptedAcceptance = afterContract.items.find(item => item.kind === 'AC' && item.id === 'AC-EXPORT-07')!
  if (acceptedAcceptance.kind !== 'AC') assert.fail('预期AC-EXPORT-07仍是验收契约')
  const weakenedSpec = candidateSpec.replace(acceptedAcceptance.assertion, '有结果即可')
  assert.notEqual(weakenedSpec, candidateSpec, '夹具应实际触及一条保护断言')
  const weakened = await readFrozenContracts(f.root, new Map(repairedFiles).set(targetPath, weakenedSpec))
  assert.ok(checkGenerationContractIntent(before, weakened, policy).some(item => item.code === 'generation-protected-meaning-changed' && item.itemId === 'AC-EXPORT-07'), '保护AC断言变化仍由既有硬门禁拒绝')
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

test('v2 code→Spec协调器保留分区证据并跳过代码生成，最终候选独审仍走原预算身份', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 5, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js', 'tests/export.test.mjs', 'package.json'] } }, undefined, 'code')
  let candidateSeen = false
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate' || request.purpose === 'elaboration_review') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { implementationWritePaths: string[]; readonlyTestPaths: string[] }
      assert.deepEqual(frozen.implementationWritePaths, [])
      assert.ok(frozen.readonlyTestPaths.includes('tests/export.test.mjs'))
    }
    if (request.purpose === 'code_generate') assert.fail('代码提交不得调用可写代码生成器')
    if (request.purpose === 'code_review') {
      const frozen = promptInput(request)
      assert.equal(new Map(frozen.files).get('src/export.js'), f.bytes.toString())
      candidateSeen = true
      throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(candidateSeen, true, JSON.stringify(result.failure))
  assert.deepEqual(f.calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review', 'code_review'])
  assert.equal(result.operation.callsUsed, 5)
  const checkpoints = f.store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string }[]
  assert.ok(checkpoints.some(checkpoint => checkpoint.stage === 'partition-plan'))
  const partitionStage = f.store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'partition-plan')
  const partitionPlan = JSON.parse(readEvidence(f.input.source.commonDir, partitionStage.resultRef).toString()) as { expectedPaths: string[] }
  assert.ok(!partitionPlan.expectedPaths.includes('package.json') && !partitionPlan.expectedPaths.includes('tests/export.test.mjs'), '首次接入的未变上下文不是业务变更或发现writer')
  assert.ok(checkpoints.some(checkpoint => checkpoint.stage === 'candidate-partition-plan'))
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('readonly-owner零派发guard只阻相同候选诊断，真实owner新派发未修好仍继续', () => {
  const findings = [{ code: 'anchor-dead', severity: 'error' as const, nodeId: 'owner', path: '.spec/owner/spec.md', message: 'src/main.mjs#options不存在' }]
  const repair = { candidateDigest: 'same', findings, owners: [{ key: 'partition:owner:elaboration', partitionId: 'owner', fromAttemptId: 'before', resultRef: { sha256: 'a'.repeat(64) } }] }
  const attempt = { id: 'now', dispatchPlans: [] as import('./operation-types.js').DispatchPlan[] }
  assert.equal(readonlySpecRepairStalled(repair, 'same', findings, attempt), true)
  for (const purpose of ['elaboration_generate', 'elaboration_review']) {
    const dispatch = { key: `sync:now:elaborate:partition:owner:0:${purpose}`, purpose, requestDigest: 'request', sessionCreateKey: 'create', session: null }
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [dispatch] }), false)
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [{ ...dispatch, key: dispatch.key.replace('partition:owner:', 'partition:foreign:') }] }), true)
    assert.equal(readonlySpecRepairStalled(repair, 'same', findings, { ...attempt, dispatchPlans: [{ ...dispatch, key: dispatch.key.replace('sync:now:', 'sync:old:') }] }), true)
  }
  assert.equal(readonlySpecRepairStalled(repair, 'changed', findings, attempt), false)
  assert.equal(readonlySpecRepairStalled(repair, 'same', [{ ...findings[0], message: '另一真实错误' }], attempt), false)
})

for (const mode of ['existing', 'new-leaf', 'aggregate-only', 'review', 'review-anchor-reference', 'review-accepted-reuse', 'review-accepted-reuse-repair', 'review-partial', 'review-pending', 'review-pending-unchanged', 'review-pending-sibling', 'review-pending-cross-source', 'review-pending-missing-owner', 'review-pending-lineage', 'review-pending-foreign-base', 'review-pending-unreviewed-base', 'review-prose', 'review-prose-cross-owner', 'review-prose-unknown', 'review-prose-path', 'review-prose-empty', 'review-multi', 'review-p1-fail', 'review-rebind', 'review-rebind-native', 'review-resume', 'review-location', 'review-ref', 'wrong-ref', 'unaffected-ref', 'readset', 'selection', 'selection-deleted', 'selection-source', 'non-null-selection', 'input-digest', 'foreign', 'policy', 'candidate', 'missing-owner'] as const) test(`readonly-owner late V1 ${mode} 只返修精确owner`, async t => {
  const reuse = mode.startsWith('review-accepted-reuse'), reuseRepair = mode === 'review-accepted-reuse-repair'
  const ordinaryAnchor = mode === 'review-anchor-reference'
  const partial = mode === 'review-partial' || ordinaryAnchor
  const rebinding = mode === 'review-rebind' || mode === 'review-rebind-native'
  const crossSource = mode === 'review-pending-cross-source', missingOwner = mode === 'review-pending-missing-owner', lineage = mode === 'review-pending-lineage'
  const pending = mode.startsWith('review-pending'), unchanged = mode === 'review-pending-unchanged', sibling = mode === 'review-pending-sibling' || crossSource || missingOwner, invalidBase = mode === 'review-pending-foreign-base' || mode === 'review-pending-unreviewed-base'
  const prose = mode.startsWith('review-prose') || pending
  const semantic = mode.startsWith('review'), multi = mode === 'review-multi' || mode === 'review-p1-fail'
  const newLeaf = semantic && !partial && !reuse || mode === 'new-leaf' || mode === 'aggregate-only', aggregateOnly = mode === 'aggregate-only'
  const negative = !['existing', 'new-leaf', 'aggregate-only', 'review', 'review-anchor-reference', 'review-accepted-reuse', 'review-accepted-reuse-repair', 'review-partial', 'review-pending', 'review-pending-unchanged', 'review-pending-sibling', 'review-pending-lineage', 'review-prose', 'review-multi', 'review-p1-fail', 'review-rebind', 'review-rebind-native', 'review-resume'].includes(mode)
  const baseSpec = original.split('\n').map(line => line.startsWith('| AC-EXPORT-') ? line.replace(' | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |', ' | code:src/export.js#ExportService | REQ-EXPORT-01 |') : line).join('\n')
  const definitions = [
    { nodeId: 'export-contract', path: contractPath, sourcePath: 'src/export.js', testPath: 'tests/export.test.mjs', word: 'export', upper: 'EXPORT' },
    ...['import', 'archive', 'report'].map(word => ({ nodeId: `${word}-contract`, path: `.spec/project/${word}/${word}-contract/spec.md`, sourcePath: `src/${word}/${word}.js`, testPath: `tests/${word}.test.mjs`, word, upper: word.toUpperCase() })),
  ]
  if (newLeaf) for (const added of definitions.slice(3)) { added.nodeId = `sync-code-${contentHash(added.sourcePath).slice(0, 16)}`; added.path = `.spec/project/export-contract/${added.nodeId}/spec.md` }
  const badOwner = partial ? definitions[2] : newLeaf ? definitions[3] : definitions[0]
  const badOwners = multi ? [definitions[2], badOwner] : [badOwner]
  const sources = new Map(definitions.map(definition => [definition.nodeId, baseSpec.replaceAll('export-job', `${definition.word}-job`).replaceAll('EXPORT', definition.upper).replaceAll('export-contract', definition.nodeId).replaceAll('src/export.js', definition.sourcePath).replaceAll('tests/export.test.mjs', definition.testPath).replaceAll(`decision:${definition.upper}-POLICY`, 'decision:EXPORT-POLICY')]))
  const extras = Object.fromEntries(definitions.slice(1).flatMap(definition => [[definition.path, multi && definition === definitions[2] ? sources.get(definition.nodeId)!.slice(0, sources.get(definition.nodeId)!.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '') : sources.get(definition.nodeId)!], [definition.sourcePath, readFileSync(new URL('src/export.js', fixturePath), 'utf8')], [definition.testPath, readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', definition.upper).replaceAll('src/export.js', definition.sourcePath)]]).filter(([path]) => !newLeaf || path !== badOwner.path))
  const verifications = definitions.map(definition => { const item = parseContract({ nodeId: definition.nodeId, path: definition.path, source: sources.get(definition.nodeId)! }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(item.kind, 'VERIFY'); return { definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment: { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } } })
  const mandatoryTests = definitions.map(definition => ({ verificationId: `VERIFY-${definition.upper}-01`, testPath: definition.testPath, testId: `AC-${definition.upper}-01` }))
  const f = await fixture(t, { mode: 'unlimited' }, false, baseSpec, 'project', baseSpec, { version: 'sync-coordinator-v2', direction: 'code_to_spec', targets: definitions.filter(item => !newLeaf || item !== badOwner).map(({ nodeId, path }) => ({ nodeId, path })), sourcePaths: ['src'], writePaths: ['.spec'], verifications, mandatoryTests, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, commitTrigger: { before: null, paths: definitions.map(item => item.sourcePath) } }, undefined, 'code', undefined, true, extras)
  if (newLeaf) assert.equal(f.input && readTree(f.input.source.commonDir, f.input.immutableTree).some(entry => entry.path === badOwner.path), false)
  const snapshotObjects = readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/'))
  const ownerCalls: { attempt: number; nodeId: string; purpose: string }[] = []
  const reviewCalls: { attempt: number; key: string }[] = []
  let finalReview = false, badGenerations = 0
  let partialFailed = false
  const generatedPerOwner = new Map<string, number>()
  const originalBusiness = new Map<string, string>()
  f.transform((output, request) => {
    const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('code_behavior_')) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { changedPaths: string[] }
      const definition = definitions.find(item => context.changedPaths.includes(item.sourcePath))!
      if (request.purpose === 'code_behavior_analyze') return { ...(output as object), changes: (output as { changes: object[] }).changes.map(change => ({ ...change, ...(newLeaf && badOwners.includes(definition) ? { kind: 'allowed_change', affectedIds: [], ruleIds: [] } : { affectedIds: [`RULE-${definition.upper}-05`], ruleIds: [`RULE-${definition.upper}-05`] }) })), newNodes: newLeaf && definition === badOwner ? [{ codePath: definition.sourcePath, parentNodeId: 'export-contract', basis: '真实新增无治理模块具有父raw对应的服务职责' }] : [] }
    }
    if (request.purpose.startsWith('elaboration_')) {
      const context = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string; path: string }[]; readonlySpecRepair?: unknown }
      const definition = definitions.find(item => item.nodeId === context.targets[0].nodeId)!
      ownerCalls.push({ attempt: attempt.number, nodeId: definition.nodeId, purpose: request.purpose })
      if (prose || partial) {
        const business = JSON.stringify({ ...context, readonlySpecRepair: undefined })
        if (attempt.number === 1) originalBusiness.set(definition.nodeId, business)
        else assert.equal(business, originalBusiness.get(definition.nodeId), 'prose诊断不改变原raw/facts/授权/冻结源码tests')
      }
      if (attempt.number > 1) {
        assert.ok(badOwners.includes(definition) || sibling && attempt.number === 3 && definition === definitions[2], '其它owner不得因兄弟失败再派发')
        assert.ok(context.readonlySpecRepair, '真实late V1原件诊断必须进入owner冻结输入')
      }
      if (mode === 'review-p1-fail' && attempt.number === 2 && definition === badOwner && request.purpose === 'elaboration_review') return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'oracle-evidence', kind: 'repair', affectedIds: [`AC-${definition.upper}-01`], evidence: '候选仍过度声称父目录断言', decision: '准确保持raw并修正证据表述', message: 'oracle只测文件absence，当前候选声明过度' }] }
      if (request.purpose === 'elaboration_generate') {
        const generated = rows(sources.get(definition.nodeId)!, definition.path)
        generated.changes[0].nodeId = definition.nodeId
        if (semantic) {
          const number = (generatedPerOwner.get(definition.nodeId) ?? 0) + 1; generatedPerOwner.set(definition.nodeId, number)
          if (!partial && !reuse && badOwners.includes(definition) && (unchanged || crossSource || lineage || number < (pending || mode === 'review-p1-fail' && definition !== badOwner ? 2 : 3))) {
            if (prose) generated.changes[0].prose += '\n错误正文一：成功路径被叙述为失败。\n错误正文二：失败分类计数与实际状态表不一致。\n'
            else generated.changes[0].tables.AC[0].assertion += '（错误地声称oracle还检查了父目录absence）'
          }
          if (rebinding && definition === badOwner && number >= 2) generated.changes[0].tables.AC.push({ ...generated.changes[0].tables.AC[0], id: `AC-${definition.upper}-ADDED-REVIEW` })
          if (attempt.number > 1) {
            const repair = context.readonlySpecRepair as { kind: string; reviewEvidence: unknown[] }
            assert.equal(repair.kind, 'candidate_review'); assert.ok(repair.reviewEvidence.length)
            if (partial) assert.equal((repair as unknown as { findings: unknown[] }).findings.length, 3)
            if (prose) {
              const findings = (repair as unknown as { findings: { itemId?: string; relatedIds: string[]; message: string }[] }).findings
              assert.equal(findings.length, partial ? 3 : 2)
              assert.ok(findings.every(finding => finding.itemId === undefined && finding.relatedIds.length === 2 && JSON.parse(finding.message).ruleLocation.includes(' — expanded spec 段落')))
            }
            assert.ok(request.prompt.includes('不是新的业务事实或授权'))
          }
        } else if (definition.nodeId === badOwner.nodeId && ++badGenerations < 3) for (const [index, acceptance] of generated.changes[0].tables.AC.entries()) acceptance.source = `code:${definition.sourcePath}#${index % 2 ? 'options' : 'process.stdout.write'}`
        return generated
      }
    }
    assert.notEqual(request.purpose, 'code_generate', '只读方向不得调用代码生成器')
    if (request.purpose === 'code_review') {
      if (reuse) {
        reviewCalls.push({ attempt: attempt.number, key: request.requestKey.split(':final:')[1] })
        if (attempt.number >= 4) throw Object.assign(new Error('cached accept与fresh repair已由owner处理；Docker前停止'), { code: 'unsupported' })
        if (promptInput(request).elaboratedSpecs.some(spec => spec.path === badOwner.path)) {
          if (reuseRepair && attempt.number === 3) return { ...(output as object), verdict: 'repair', findings: [{ kind: 'repair', affectedIds: [`AC-${badOwner.upper}-01`], ruleLocation: `contract:${badOwner.path}#AC-${badOwner.upper}-01`, codeLocation: badOwner.sourcePath, evidence: '本轮真实独审要求复核已接受表述', counterexample: '旧accept不能代替本轮repair的owner回应', message: '沿原raw/source复核，允许critic误读而保持正文，不增加授权' }] }
          throw Object.assign(new Error('固定失败分区；其余真实accept必须按同输入承接'), { code: attempt.number >= 3 ? 'unsupported' : 'failed' })
        }
        return output
      }
      if (semantic) {
        const frozen = promptInput(request)
        if (sibling && attempt.number === 2) {
          const owner = crossSource ? badOwner : definitions[2], id = `AC-${owner.upper}-01`
          return { ...(output as object), verdict: frozen.readyIds.includes(id) ? 'repair' : 'accept', findings: frozen.readyIds.includes(id) ? [1, 2].map(number => ({ kind: 'repair', affectedIds: [id, `RULE-${owner.upper}-05`], ruleLocation: `${owner.path} — expanded spec 段落「新兄弟复核${number}」`, codeLocation: `${owner.sourcePath}#ExportService`, evidence: '后续独审要求兄弟澄清，P1可核对后认定误审并保持正文', counterexample: '单凭定位不足以授权业务变化', message: '沿原raw复核，不授新权' })) : [] }
        }
        if (sibling && (attempt.number === 3 || attempt.number === 4)) {
          if (frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) throw Object.assign(new Error('旧版仅处理兄弟后或本轮P1后原生失败'), { code: 'failed' })
          return output
        }
        if (lineage && attempt.number >= 4) {
          const id = `AC-${badOwner.upper}-01`
          if (attempt.number === 4) return { ...(output as object), verdict: frozen.readyIds.includes(id) ? 'repair' : 'accept', findings: frozen.readyIds.includes(id) ? [1, 2].map(number => ({ kind: 'repair', affectedIds: [id, `RULE-${badOwner.upper}-05`], ruleLocation: `${badOwner.path} — expanded spec 段落「独立后续复核B${number}」`, codeLocation: `${badOwner.sourcePath}#ExportService`, evidence: 'A已由fresh P1核过，B绑定新的acceptedRef再次独立复核', counterexample: '正文不必为迎合critic改义', message: '以原raw复核同一正文，非新授权' })) : [] }
          if (attempt.number === 5) {
            if (frozen.readyIds.includes(id)) throw Object.assign(new Error('B回应后P2原生失败'), { code: 'failed' })
            return output
          }
          finalReview = true; throw Object.assign(new Error('A/B均已明确处理，同body不再P1；Docker前停止'), { code: 'unsupported' })
        }
        if (partial) {
          if (attempt.number > 1) { finalReview = true; throw Object.assign(new Error('partial诊断已由fresh P1处理；完整P2重审在Docker前停止'), { code: 'unsupported' }) }
          if (!partialFailed && !frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) { partialFailed = true; throw Object.assign(new Error('fixture其它分区真实Native失败，review保持null'), { code: 'failed' }) }
          const ids = [`AC-${badOwner.upper}-01`, `RULE-${badOwner.upper}-05`, `FLOW-${badOwner.upper}-01`]
          return { ...(output as object), verdict: frozen.readyIds.includes(ids[0]) ? 'repair' : 'accept', findings: frozen.readyIds.includes(ids[0]) ? ids.map((id, index) => ({ kind: 'repair', affectedIds: ordinaryAnchor && index === 1 ? [`AC-${badOwner.upper}-01`, `AC-${badOwner.upper}-02`, `REQ-${badOwner.upper}-01`] : ordinaryAnchor && index === 2 ? ['AC-EXPORT-01'] : [id], ruleLocation: `contract:${badOwner.path}#${id}`, codeLocation: `${badOwner.sourcePath}#ExportService`, evidence: '独立评审要求核对候选表述和现有实现，P1可复核误读而保持正文', counterexample: '空复审不能代替owner回应先前3条发现', message: '按原raw/source复核，不改源码或授权' })) : [] }
        }
        const issues = frozen.elaboratedSpecs.flatMap(spec => {
          const definition = badOwners.find(owner => owner.path === spec.path), id = definition && `AC-${definition.upper}-01`
          if (prose && id && frozen.readyIds.includes(id) && spec.source.includes('错误正文一')) return (partial ? [1, 2, 3] : [1, 2]).map(number => ({ kind: 'repair', affectedIds: [id, mode === 'review-prose-cross-owner' ? 'REQ-EXPORT-01' : `RULE-${definition.upper}-05`], ruleLocation: `${mode === 'review-prose-path' ? '.spec/foreign/spec.md' : spec.path} — expanded spec ${mode === 'review-prose-empty' ? '' : `段落「错误正文${number}」`}`, codeLocation: `${definition.sourcePath}#ExportService`, evidence: '同一候选正文与其规则和状态表自相矛盾', counterexample: '按错误正文执行会把已明确成功路径当作失败', message: '按原raw及源码校正正文叙述，保REQ/RULE/AC义务' }))
          return id && frozen.readyIds.includes(id) && spec.source.includes('错误地声称oracle') ? [{ kind: 'repair', affectedIds: [id], ruleLocation: `${mode === 'review-location' ? '.spec/foreign/spec.md' : `${multi ? 'contract:' : ''}${spec.path}`}#${id}`, codeLocation: 'tests/export.test.mjs#AC-EXPORT-01', evidence: '完整测试只断言文件absence，没有断言父目录absence', counterexample: '父目录存在但文件缺失仍满足原oracle', message: '保留raw要求，准确表述当前AC证据覆盖，不宣称未测断言' }] : []
        })
        if (pending && (unchanged || invalidBase) && attempt.number >= 4) {
          if (attempt.number === 4) {
            if (frozen.elaboratedSpecs.some(spec => spec.path === badOwner.path)) throw Object.assign(new Error('新P1已回应后同candidate独审原生失败'), { code: 'failed' })
            return output
          }
          finalReview = true; throw Object.assign(new Error('fixture在已处理诊断的whole重用后、Docker前停止'), { code: 'unsupported' })
        }
        if (mode === 'review-rebind-native' && attempt.number === 2 && issues.length) throw Object.assign(new Error('fixture实际P2原生失败；不得当作语义repair'), { code: 'failed' })
        if (issues.length) return { ...(output as object), verdict: 'repair', findings: issues }
        if (attempt.number < (mode === 'review-resume' || mode === 'review-rebind-native' ? 4 : 3)) return output
      }
      finalReview = true; throw Object.assign(new Error('fixture在全候选真实V1通过后、Docker之前停止'), { code: 'unsupported' })
    }
    return output
  })
  const claim = f.store.claimQueuedAttempt.bind(f.store)
  const recordFailure = f.store.recordFailure.bind(f.store)
  const listAttempts = f.store.listAttempts.bind(f.store)
  let immutable: { refs: import('./operation-types.js').BlobRef[]; failure: unknown } | undefined
  f.store.recordFailure = (fence, issue) => {
    const before = f.store.readAttempt(fence.attemptId)
    if (partial && before.number === 1) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
      const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      assert.equal(generated.status, 'failed'); assert.ok(generated.failure); assert.equal(generated.review, null)
      assert.equal(generated.partitionEvidence.flatMap((part: { review: { findings: unknown[] } }) => part.review.findings).length, 3, '真正失败组合必须保存3条有效局部repair')
      if (ordinaryAnchor) {
        const finding = generated.partitionEvidence.flatMap((part: { review: { findings: { ruleLocation: string; affectedIds: string[] }[] } }) => part.review.findings).find((finding: { ruleLocation: string }) => finding.ruleLocation.endsWith(`#RULE-${badOwner.upper}-05`))!
        assert.equal(finding.affectedIds.includes(`RULE-${badOwner.upper}-05`), false, '合法普通RULE引用不要求anchor在受影响ID中')
      }
    }
    if (sibling && before.number === 1) {
      // 只对读取视图模拟旧版忽略早期generation；原SQLite/CAS与全部P1原件保持。
      f.store.listAttempts = id => listAttempts(id).map(prior => prior.id === before.id ? { ...prior, checkpointRefs: prior.checkpointRefs.filter(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()); return value.version !== 'sync-stage-v1' || value.stage !== 'generation' }) } : prior)
    }
    if (sibling && before.number === 3) f.store.listAttempts = listAttempts
    if (missingOwner && before.number === 3) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'elaboration')
      const whole = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      whole.partitionEvidence = whole.partitionEvidence.filter((owner: { resultRef: { sha256: string } }) => !JSON.parse(readEvidence(f.input.source.commonDir, owner.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwner.nodeId))
      const resultRef = writeEvidence(f.input.source.commonDir, whole); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
    }
    if (invalidBase && before.number === 4) {
      const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())), original = wrappers.find(value => value.stage === 'repair-input')
      const input = JSON.parse(readEvidence(f.input.source.commonDir, original.resultRef).toString())
      const whole = JSON.parse(readEvidence(f.input.source.commonDir, wrappers.find(value => value.stage === 'elaboration').resultRef).toString())
      input.readonlyBaseRef = writeEvidence(f.input.source.commonDir, mode === 'review-pending-foreign-base' ? { foreign: 'unapproved base' } : { ...whole, reviewPassed: false })
      const resultRef = writeEvidence(f.input.source.commonDir, input); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...original, resultRef }))
    }
    if (before.number === 1 && issue.code === 'generation_failed' && (mode === 'review-ref' || mode === 'review-prose-unknown')) {
      const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
      const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
      const review = generated.partitionEvidence.find((evidence: { review: { verdict: string } }) => evidence.review.verdict === 'repair')
      if (mode === 'review-prose-unknown') review.review.findings[0].affectedIds.push('REQ-UNKNOWN-01')
      else review.review.findings[0].message += '外来改写'
      const resultRef = writeEvidence(f.input.source.commonDir, generated); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...wrapper, resultRef }))
    }
    if (before.number === 1 && issue.code === 'generation_failed' && negative && !semantic) {
      const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const local = wrappers.find(value => value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwner.nodeId))
      if (['readset', 'selection', 'selection-deleted', 'selection-source', 'non-null-selection', 'foreign', 'policy'].includes(mode)) {
        let selection = { ...f.operation.baselineSelection!, digest: contentHash('wrong selection') }
        if (mode === 'selection-deleted' || mode === 'selection-source') {
          selection = structuredClone(f.operation.baselineSelection!)
          if (mode === 'selection-deleted') selection.bindings = selection.bindings.slice(1)
          else selection.source.branch = 'foreign-selection-branch'
          selection.digest = contentHash(JSON.stringify({ version: selection.version, source: selection.source, bindings: selection.bindings }, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
        }
        if (mode === 'non-null-selection') {
          selection = structuredClone(f.operation.baselineSelection!)
          const first = selection.bindings[0]; assert.equal(first.resource.kind, 'path'); assert.ok('bytePair' in first)
          first.bytePair = { id: 'unapproved-fixture-pair', repositoryId: f.input.source.repositoryId, source: f.input.source, sourceInput: f.input, verifiedDelivery: f.input, coveredScope: { paths: [first.resource.path], contractIds: [], flowIds: [] }, receiptId: 'not-authority', settledAtMs: 1 }
          selection.digest = contentHash(JSON.stringify({ version: selection.version, source: selection.source, bindings: selection.bindings }, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
        }
        const patch = mode === 'readset' ? { readSetDigest: contentHash('wrong readset') } : mode === 'foreign' ? { operationId: 'foreign-operation' } : mode === 'policy' ? { policyDigest: contentHash('wrong policy') } : { baselineSelectionRef: writeEvidence(f.input.source.commonDir, selection) }
        f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, ...patch }))
      } else if (mode === 'candidate' || mode === 'missing-owner') {
        const generated = wrappers.find(value => value.stage === 'generation'), value = JSON.parse(readEvidence(f.input.source.commonDir, generated.resultRef).toString())
        if (mode === 'candidate') value.candidate.digest = contentHash('foreign candidate')
        else { const index = value.validationFindings.findIndex((finding: { severity: string }) => finding.severity === 'error'); assert.ok(index >= 0); value.validationFindings[index] = { ...value.validationFindings[index], nodeId: 'foreign-owner', path: '.spec/foreign/spec.md' } }
        const resultRef = writeEvidence(f.input.source.commonDir, value); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...generated, resultRef }))
      } else {
        const aggregate = wrappers.find(value => value.stage === 'elaboration'), value = JSON.parse(readEvidence(f.input.source.commonDir, aggregate.resultRef).toString()) as ElaborationResult
        const owner = value.partitionEvidence!.find(owner => owner.resultRef.sha256 === local.resultRef.sha256)!
        if (mode === 'wrong-ref') owner.resultRef = value.partitionEvidence!.find(item => item.resultRef.sha256 !== owner.resultRef.sha256)!.resultRef
        else if (mode === 'unaffected-ref') value.partitionEvidence!.find(item => item.resultRef.sha256 !== owner.resultRef.sha256)!.resultRef = owner.resultRef
        else {
          const changed = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()); changed.inputDigest = contentHash('wrong original input')
          owner.resultRef = writeEvidence(f.input.source.commonDir, changed); f.store.checkpoint(fence, owner.resultRef)
          f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, resultRef: owner.resultRef }))
        }
        const resultRef = writeEvidence(f.input.source.commonDir, value); f.store.checkpoint(fence, resultRef); f.store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...aggregate, resultRef }))
      }
    }
    const failed = recordFailure(fence, issue)
    if (before.number === 1) {
      const saved = f.store.readAttempt(fence.attemptId); immutable = { refs: saved.checkpointRefs, failure: saved.failure }
      if (pending && !sibling && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id)
        const broken = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        recordFailure(broken.fence, { code: 'readonly_spec_repair_binding', message: '旧版本不识别prose定位，未派发owner', kind: 'unsupported', evidenceRefs: [] })
        f.store.requestControl(operation.id, 'pause'); f.store.requestControl(operation.id, 'run')
        const resumed = f.store.readOperation(operation.id), repeated = claim({ operationId: resumed.id, source: resumed.input.source, scope: resumed.scope, leaseMs: 30000, expectedRevision: resumed.revision, continuation: true })
        // 模拟旧版本已落盘的同候选重复审查；它不是新业务授权或本次真实Native执行证明。
        const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
        for (const name of ['analysis', 'partition-plan', 'elaboration', 'generation']) {
          const original = wrappers.find(value => value.stage === name)
          let resultRef = original.resultRef
          if (name === 'generation') {
            const generated = JSON.parse(readEvidence(f.input.source.commonDir, resultRef).toString())
            generated.status = 'failed'; generated.failure = { code: 'failed', message: '旧版本原生失败；同owner后续复审为空发现' }
            generated.review = null
            generated.partitionEvidence = generated.partitionEvidence.map((evidence: { review: object }) => ({ ...evidence, review: { ...evidence.review, verdict: 'accept', findings: [] } }))
            resultRef = writeEvidence(f.input.source.commonDir, generated)
          }
          f.store.checkpoint(repeated.fence, resultRef)
          f.store.checkpoint(repeated.fence, writeEvidence(f.input.source.commonDir, { ...original, resultRef, attemptId: repeated.attempt.id, readSetDigest: repeated.operation.readSetDigest, baselineSelectionRef: writeEvidence(f.input.source.commonDir, repeated.operation.baselineSelection) }))
        }
        recordFailure(repeated.fence, { code: 'failed', message: '旧版本原生失败未处理原prose反馈', kind: 'repairable', evidenceRefs: [] })
      }
      if (mode === 'review-resume' && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id), cloned = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        const wrapper = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage === 'generation')
        const generated = JSON.parse(readEvidence(f.input.source.commonDir, wrapper.resultRef).toString())
        const repair = { repairContext: { previousOutput: generated.output, diagnostics: [{ code: issue.code, message: issue.message }, ...generated.validationFindings.map((item: { code: string; message: string }) => ({ code: item.code, message: item.message })), ...generated.review.findings.map((item: { kind: string }) => ({ code: item.kind, message: JSON.stringify(item) }))] } }
        const resultRef = writeEvidence(f.input.source.commonDir, repair); f.store.checkpoint(cloned.fence, resultRef)
        f.store.checkpoint(cloned.fence, writeEvidence(f.input.source.commonDir, { ...wrapper, attemptId: cloned.attempt.id, stage: 'repair-input', resultRef }))
        f.store.requestControl(operation.id, 'pause')
        f.store.requestControl(operation.id, 'run')
      }
      if (aggregateOnly && issue.code === 'generation_failed') {
        const operation = f.store.readOperation(f.operation.id), cloned = claim({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: operation.revision, continuation: true })
        const wrappers = before.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
        for (const name of ['analysis', 'partition-plan', 'elaboration', 'generation']) {
          const original = wrappers.find(value => value.stage === name)
          f.store.checkpoint(cloned.fence, original.resultRef)
          f.store.checkpoint(cloned.fence, writeEvidence(f.input.source.commonDir, { ...original, attemptId: cloned.attempt.id, readSetDigest: cloned.operation.readSetDigest, baselineSelectionRef: writeEvidence(f.input.source.commonDir, cloned.operation.baselineSelection) }))
        }
        recordFailure(cloned.fence, issue)
      }
    }
    return failed
  }
  f.store.claimQueuedAttempt = input => { if (f.store.listAttempts(f.operation.id).length >= (lineage ? 6 : reuseRepair ? 4 : unchanged || invalidBase || sibling ? 5 : pending || aggregateOnly || mode === 'review-resume' || mode === 'review-rebind-native' ? 4 : 3)) throw new Error('fixture仅阻止旧实现无限零调用热循环'); return claim(input) }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  if (reuse) {
    const failedKey = reviewCalls.find(call => call.attempt === 3)?.key
    assert.ok(failedKey)
    assert.equal(reviewCalls.filter(call => call.attempt === 1).length, 4)
    assert.equal(reviewCalls.filter(call => call.attempt === 2).length, 4, '首轮无repairContext，不能仅凭candidate复用')
    assert.deepEqual(reviewCalls.filter(call => call.attempt === 3).map(call => call.key), [failedKey], '精确同输入后仅失败分区重新独审')
    assert.deepEqual(ownerCalls.filter(call => call.attempt > 1).map(({ attempt, nodeId, purpose }) => [attempt, nodeId, purpose]), reuseRepair ? [[4, badOwner.nodeId, 'elaboration_generate'], [4, badOwner.nodeId, 'elaboration_review']] : [], '历史accept来源不妨碍本轮真实repair回到唯一owner')
    assert.deepEqual(readTree(f.input.source.commonDir, f.input.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
    const attempts = f.store.listAttempts(f.operation.id)
    const wrappers = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
    for (const values of wrappers) {
      const generation = values.find(stage => stage.stage === 'generation')
      if (!generation) continue
      const result = JSON.parse(readEvidence(f.input.source.commonDir, generation.resultRef).toString())
      assert.equal(result.candidateValidated, true)
      assert.deepEqual(readTree(f.input.source.commonDir, result.candidate.tree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects, '实际候选源码/tests path-mode-OID-absence不变')
    }
    const accepted = wrappers[1].filter(stage => stage.stage?.endsWith(':candidate-review') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).reviewPassed)
    assert.equal(accepted.length, 3)
    for (const saved of accepted) {
      assert.deepEqual(wrappers[2].find(stage => stage.stage === saved.stage)?.resultRef, saved.resultRef)
      assert.equal(wrappers[2].find(stage => stage.stage === `${saved.stage}:provenance`)?.resultRef !== undefined, true)
    }
    assert.equal(result.operation.callsUsed, f.calls.length, '复用不记假调用')
    if (!reuseRepair) {
      const saved = accepted[0], sourceAttempt = attempts[1], candidate = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()).candidate
      const plan = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[1].find(stage => stage.stage === 'candidate-partition-plan').resultRef).toString())
      const key = `sync:${sourceAttempt.id}:generation:final:${saved.stage.slice('partition:'.length, -':candidate-review'.length)}:code_review`
      const request = f.calls.find(call => call.requestKey === key)!
      type Input = import('./generation-types.js').GenerationInput
      const serialized = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as Omit<Input, 'files'> & { files: [string, string][]; manifestProjection?: unknown; completeManifestDigest?: string }
      const { manifestProjection: _projection, completeManifestDigest: _digest, ...context } = serialized
      const input: Input = { ...context, files: new Map(context.files), manifest: { version: 1, entries: readTree(f.input.source.commonDir, context.composed?.tree ?? context.snapshot.immutableTree) }, priorContext: context.priorContext?.map(prior => ({ ...prior, files: new Map(prior.files) })) }
      const operation = f.store.readOperation(f.operation.id)
      const proof = (value = input, source = sourceAttempt, current = operation, selected = plan, actual = candidate) => acceptedCandidateReviewSource(f.store, current, source, saved.stage, actual, selected, value)
      assert.ok(proof(), '原真实checkpoint/request/dispatch/ref资格可重现')
      for (const patch of [{ intent: { ...input.intent, rawSource: input.intent.rawSource + '变更' } }, { facts: [...input.facts, { source: 'code:src/export.js', text: '不同上下文' }] }, { repairContext: undefined }, { model: 'gpt-6.1-terra' }, { timeoutMs: (input.timeoutMs === null ? 1000 : input.timeoutMs + 1) }]) assert.equal(proof({ ...input, ...patch }), null)
      assert.equal(proof(input, sourceAttempt, operation, { ...plan, digest: 'other-plan' }), null)
      assert.equal(proof(input, sourceAttempt, operation, plan, { ...candidate, coveredScope: { ...candidate.coveredScope, paths: [] } }), null)
      assert.equal(proof(input, sourceAttempt, { ...operation, readSetDigest: 'other-readset' }), null)
      assert.equal(proof(input, sourceAttempt, { ...operation, baselineSelection: { ...operation.baselineSelection!, digest: 'other-selection' } }), null)
      assert.throws(() => proof(input, sourceAttempt, { ...operation, policyDigest: 'other-policy' }))
      assert.throws(() => proof(input, sourceAttempt, { ...operation, id: 'other-operation' }))
      for (const variant of ['source-result', 'trace', 'request', 'schema', 'prompt']) {
        const stage = variant === 'request' || variant === 'schema' || variant === 'prompt' ? wrappers[1].find(stage => stage.stage === `injected:${key}`) : saved
        const original = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()), modified = structuredClone(original)
        if (variant === 'source-result') modified.reviewPassed = false
        else if (variant === 'trace') modified.traces[0].threadId = 'foreign-thread'
        else if (variant === 'schema' || variant === 'prompt') {
          const { signal: _signal, ...payload } = request
          modified.requestDigest = contentHash(JSON.stringify(variant === 'schema' ? { ...payload, schema: { ...payload.schema, description: '不同schema' } } : { ...payload, prompt: payload.prompt + '不同prompt' }))
        } else modified.requestDigest = contentHash(variant)
        const changed = writeEvidence(f.input.source.commonDir, { ...stage, resultRef: writeEvidence(f.input.source.commonDir, modified) })
        const source = { ...sourceAttempt, checkpointRefs: [...sourceAttempt.checkpointRefs, changed], dispatchPlans: sourceAttempt.dispatchPlans.map(dispatch => (variant === 'schema' || variant === 'prompt') && dispatch.key === key ? { ...dispatch, requestDigest: modified.requestDigest } : dispatch) }
        assert.equal(proof(input, source), null, variant)
      }
      assert.equal(proof(input, { ...sourceAttempt, status: 'running' }), null, '未结算来源不得承接')
      const cachedAttempt = attempts[2], provenanceStage = wrappers[2].find(stage => stage.stage === `${saved.stage}:provenance`)
      const originalProvenance = JSON.parse(readEvidence(f.input.source.commonDir, provenanceStage.resultRef).toString())
      assert.ok(proof(input, cachedAttempt), '冷态拷贝仍完整重验输入及请求')
      for (const variant of ['missing-input', 'forged-input']) {
        const provenance = structuredClone(originalProvenance)
        if (variant === 'missing-input') delete provenance.inputRef
        else {
          const value = JSON.parse(readEvidence(f.input.source.commonDir, provenance.inputRef).toString()); value.facts.push({ source: 'code:src/export.js', text: '伪输入' }); provenance.inputRef = writeEvidence(f.input.source.commonDir, value)
        }
        const changed = writeEvidence(f.input.source.commonDir, { ...provenanceStage, resultRef: writeEvidence(f.input.source.commonDir, provenance) })
        assert.equal(proof(input, { ...cachedAttempt, checkpointRefs: [...cachedAttempt.checkpointRefs, changed] }), null, variant)
      }
      const { signal: _signal, ...payload } = request
      const originalFind = f.store.findResource.bind(f.store), dispatch = sourceAttempt.dispatchPlans.find(dispatch => dispatch.key === key)!
      const injected = JSON.parse(readEvidence(f.input.source.commonDir, wrappers[1].find(stage => stage.stage === `injected:${key}`).resultRef).toString())
      for (const frozen of [false, true]) {
        const nativeRequest = frozen ? prepareFrozenPrompt({ ...payload, frozenEntries: [{ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8' as const, text: payload.prompt }] }, { directory: join(f.root, '..', 'review-context'), binding: { attemptId: sourceAttempt.id, policyDigest: operation.policyDigest } }) : payload
        const requestDigest = contentHash(JSON.stringify(nativeRequest)), identity = { operationId: operation.id, attemptId: sourceAttempt.id, inputId: operation.input.id, candidateDigest: candidate.digest }
        const native: NativeRunPlan = { schemaVersion: 1, ...identity, request: nativeRequest, requestDigest, sessionCreateKey: dispatch.sessionCreateKey, expectedSessionId: injected.result.sessionId }
        const checkpoint: NativeRunCheckpoint = { schemaVersion: 1, ...identity, requestDigest, expectedSessionId: injected.result.sessionId, phase: 'removed', nativeCallRequested: true, nativeStarted: true, nativeState: 'completed', status: 'completed', session: dispatch.session!, result: injected.result }
        const checkpointRef = writeEvidence(f.input.source.commonDir, checkpoint)
        const resource: import('./operation-types.js').SyncResourceRecord = { id: 'fixture-native-proof', operationId: operation.id, attemptId: sourceAttempt.id, generation: sourceAttempt.generation, phase: 'removed', checkpointRef, checkpoints: [], createdAtMs: 1, updatedAtMs: 1, plan: { key, kind: 'native_session', ...identity, payloadDigest: requestDigest, planBlob: writeEvidence(f.input.source.commonDir, native), checkpointRef } }
        f.store.findResource = (attemptId, requestKey) => attemptId === sourceAttempt.id && requestKey === key ? resource : originalFind(attemptId, requestKey)
        const source = { ...sourceAttempt, dispatchPlans: sourceAttempt.dispatchPlans.map(current => current.key === key ? { ...current, requestDigest } : current) }
        assert.ok(proof(input, source), frozen ? '冻结task原字节及完整原生payload绑定' : 'inline完整原生payload绑定')
        resource.phase = 'planned'; assert.equal(proof(input, source), null, '未结算Native资源不得复用'); resource.phase = 'removed'
        resource.plan.planBlob = writeEvidence(f.input.source.commonDir, { ...native, request: { ...native.request, prompt: native.request.prompt + '外来正文' } })
        assert.equal(proof(input, source), null, '原生完整payload变化拒绝')
        if (frozen) {
          const forged = prepareFrozenPrompt({ ...payload, prompt: payload.prompt + '外来任务', frozenEntries: [{ id: 'task', label: 'Complete original task and frozen context', kind: 'utf8' as const, text: payload.prompt + '外来任务' }] }, { directory: join(f.root, '..', 'review-context-forged'), binding: { attemptId: sourceAttempt.id, policyDigest: operation.policyDigest } })
          const digest = contentHash(JSON.stringify(forged))
          resource.plan.planBlob = writeEvidence(f.input.source.commonDir, { ...native, request: forged, requestDigest: digest }); resource.plan.payloadDigest = digest
          resource.checkpointRef = writeEvidence(f.input.source.commonDir, { ...checkpoint, requestDigest: digest })
          assert.equal(proof(input, { ...sourceAttempt, dispatchPlans: sourceAttempt.dispatchPlans.map(current => current.key === key ? { ...current, requestDigest: digest } : current) }), null, '完整payload及dispatch相符仍拒绝伪task SHA')
        }
      }
      f.store.findResource = originalFind
    }
    return
  }
  if (crossSource || missingOwner) { assert.equal(result.failure?.code, 'readonly_spec_repair_binding'); assert.equal(f.store.listAttempts(f.operation.id).length, 4); assert.equal(ownerCalls.some(call => call.attempt === 4), false); return }
  if (invalidBase) { assert.equal(result.failure?.code, 'readonly_spec_repair_binding'); assert.equal(f.store.listAttempts(f.operation.id).length, 5); assert.equal(ownerCalls.some(call => call.attempt === 5), false); return }
  if (negative) { assert.equal(finalReview, false); assert.equal(f.store.listAttempts(f.operation.id).length, 2); assert.equal(ownerCalls.filter(call => call.attempt > 1).length, 0); assert.notEqual(result.failure?.kind, 'repairable', JSON.stringify(result.failure)); assert.ok(['failed', 'unsupported'].includes(result.status), JSON.stringify(result.failure)); return }
  assert.ok(finalReview, JSON.stringify({ failure: result.failure, calls: ownerCalls, failures: f.store.listAttempts(f.operation.id).map(attempt => attempt.failure) }))
  const second = pending ? 4 : aggregateOnly || mode === 'review-resume' ? 3 : 2
  for (const owner of badOwners) assert.deepEqual(ownerCalls.filter(call => call.attempt > 1 && call.nodeId === owner.nodeId).map(({ attempt, purpose }) => [attempt, purpose]), partial ? [[second, 'elaboration_generate'], [second, 'elaboration_review']] : lineage ? [[4, 'elaboration_generate'], [4, 'elaboration_review'], [5, 'elaboration_generate'], [5, 'elaboration_review']] : pending || mode === 'review-p1-fail' && owner !== badOwner ? [[second, 'elaboration_generate'], [second, 'elaboration_review']] : [[second, 'elaboration_generate'], [second, 'elaboration_review'], [mode === 'review-rebind-native' ? 4 : second + 1, 'elaboration_generate'], [mode === 'review-rebind-native' ? 4 : second + 1, 'elaboration_review']])
  const attempts = f.store.listAttempts(f.operation.id)
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  for (const source of stages[0].filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))) {
    const prior = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    if (prior.changes.some(change => badOwners.some(owner => owner.nodeId === change.nodeId))) continue
    for (const current of stages.slice(second - 1)) {
      const local = current.find(stage => stage.stage === source.stage)
      const aggregate = current.find(stage => stage.stage === 'elaboration')
      const owner = aggregate && (JSON.parse(readEvidence(f.input.source.commonDir, aggregate.resultRef).toString()) as ElaborationResult).partitionEvidence?.find(owner => source.stage === `partition:${owner.partitionId}:elaboration`)
      const latestSibling = sibling && prior.changes.some(change => change.nodeId === definitions[2].nodeId) ? stages[2].find(stage => stage.stage === source.stage).resultRef : source.resultRef
      assert.deepEqual(local?.resultRef ?? owner?.resultRef, latestSibling)
    }
  }
  if (mode === 'review-p1-fail') {
    const owner = stages[1].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { nodeId: string }) => change.nodeId === badOwners[0].nodeId))
    assert.ok(owner)
    assert.deepEqual(stages[2].find(stage => stage.stage === owner.stage).resultRef, owner.resultRef, '兄弟P1失败不丢弃本轮已新独审owner')
  }
  const generations = stages.map(values => { const saved = values.find(stage => stage.stage === 'generation'); return saved ? JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()) : null })
  assert.ok(generations.filter(Boolean).every(value => Array.isArray(value.p2SpecWritePaths) && value.p2SpecWritePaths.length === 0), 'Spec-only权限由宿主dispatch投影为空，不能借用P2 writer')
  if (semantic) {
    for (const generated of [generations[0], pending || partial ? null : mode === 'review-rebind-native' ? generations[2] : generations[second - 1]].filter(Boolean)) { assert.equal(generated.candidateValidated, true); assert.ok(generated.partitionEvidence.some((evidence: { review: { verdict: string } }) => evidence.review.verdict === 'repair')) }
  } else {
    assert.ok(generations[0].validationFindings.some((finding: { code: string }) => finding.code === 'anchor-dead'))
    assert.ok(generations[second - 1].validationFindings.some((finding: { code: string }) => finding.code === 'anchor-dead'), 'agent实际修过但未修好仍可下一轮')
  }
  if (partial) {
    assert.equal(generations[0].status, 'failed'); assert.ok(generations[0].failure)
    assert.equal(generations[0].review, null)
    assert.equal(generations[0].partitionEvidence.flatMap((part: { review: { findings: unknown[] } }) => part.review.findings).length, 3)
    const failed = stages[0].filter(stage => stage.stage?.endsWith(':candidate-review')).map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString())).find(result => result.failure)
    assert.ok(failed); assert.equal(failed.review, null); assert.equal(failed.reviewPassed, false, '失败区不得伪装成已审accept')
    const input = JSON.parse(readEvidence(f.input.source.commonDir, stages[1].find(stage => stage.stage === 'repair-input').resultRef).toString())
    assert.equal(input.readonlyOwnerRepair.reviewEvidence.length, 1)
  }
  if (sibling) {
    const payload = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === 'repair-input').resultRef).toString())
    assert.deepEqual(payload.readonlyBaseRef, stages[2].find(stage => stage.stage === 'elaboration').resultRef)
    assert.deepEqual(payload.readonlyOwnerRepair.priorRef, stages[0].find(stage => stage.stage === 'elaboration').resultRef)
    assert.notEqual(payload.readonlyBaseRef.sha256, payload.readonlyOwnerRepair.priorRef.sha256, '执行base与原source分别绑定，不改旧priorRef')
    assert.deepEqual(stages[4].find(stage => stage.stage === 'elaboration').resultRef, stages[3].find(stage => stage.stage === 'elaboration').resultRef)
    assert.deepEqual(ownerCalls.filter(call => call.nodeId === definitions[2].nodeId && call.attempt > 1).map(call => [call.attempt, call.purpose]), [[3, 'elaboration_generate'], [3, 'elaboration_review']])
  }
  if (lineage) {
    assert.deepEqual(stages[5].find(stage => stage.stage === 'elaboration').resultRef, stages[4].find(stage => stage.stage === 'elaboration').resultRef)
    assert.equal(generations[5].candidate.digest, generations[0].candidate.digest)
    assert.equal(ownerCalls.some(call => call.attempt === 6), false, '合法lineage内A/O1和B/O2响应均可结算，不能只查current meta')
  }
  if (unchanged) {
    assert.deepEqual(stages[4].find(stage => stage.stage === 'elaboration').resultRef, stages[3].find(stage => stage.stage === 'elaboration').resultRef)
    assert.equal(generations[4].candidate.digest, generations[0].candidate.digest, 'fresh独立P1可确认critic误读而保持Spec正文同字节')
    assert.equal(ownerCalls.some(call => call.attempt === 5), false, '已明确响应source并纳入aggregate后不再派发')
  }
  if (rebinding) {
    assert.notEqual(stages[0].find(stage => stage.stage === 'generation').readSetDigest, stages[1].find(stage => stage.stage === 'generation').readSetDigest, '本轮新合法AC通过正式scope扩充改变readSet')
    assert.notEqual(stages[0].find(stage => stage.stage === 'generation').baselineSelectionRef.sha256, stages[1].find(stage => stage.stage === 'generation').baselineSelectionRef.sha256)
    if (mode === 'review-rebind-native') {
      assert.equal(generations[1].status, 'failed'); assert.equal(ownerCalls.some(call => call.attempt === 3), false, 'P2原生失败后新accepted whole仍需承接，不回旧P1')
      assert.deepEqual(stages[2].find(stage => stage.stage === 'elaboration').resultRef, stages[1].find(stage => stage.stage === 'elaboration').resultRef, 'P2原生失败后复用最新whole，不回旧owner refs')
    }
  }
  assert.equal(generations.at(-1).candidateValidated, true, '完整候选真实V1重跑通过')
  assert.deepEqual(readTree(f.input.source.commonDir, generations.at(-1).candidate.tree).filter(entry => !entry.path.startsWith('.spec/')), snapshotObjects)
  assert.deepEqual(f.store.readAttempt(attempts[0].id).checkpointRefs, immutable!.refs); assert.deepEqual(f.store.readAttempt(attempts[0].id).failure, immutable!.failure)
  assert.ok(result.operation.baselineSelection!.bindings.length > f.operation.baselineSelection!.bindings.length, '覆盖P1 expandContractScope的null资源扩展')
  if (aggregateOnly || mode === 'review-resume') { assert.equal(attempts[1].dispatchPlans.length, 0); assert.equal(stages[1].some(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration')), false, '历史attempt只有aggregate引用') }
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(result.operation.deadlineAtMs, null); assert.deepEqual(result.operation.budget, { mode: 'unlimited' })
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('v2最终预算只列真实实现派发，纯父接口不产生虚构生成或独审键', async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01'
  const raw = '保留当前导出契约，由现有导出服务完成请求及结果下载。'
  const parentBefore = `---\ntitle: 导出上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const leafBefore = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const parentSource = `---\ntitle: 导出上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层声明原意，由现有服务承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留现有导出行为 | user:raw | 不改变原政策 | 既有导出流程及验收完成 | - |\n`
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 }, false, leafBefore, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'],
  }, undefined, 'spec', undefined, false, { [parentPath]: parentBefore })
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[] }
      if (frozen.targets[0].path === parentPath) {
        const parent = rows(parentSource, parentPath)
        parent.changes[0].nodeId = 'project'
        parent.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口不执行实现，各边界保留在现有服务契约中', affectedIds: [parentId] }))
        return parent
      }
      const child = rows(original)
      for (const row of child.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
      for (const row of child.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
      return child
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('本回归在真实Docker之前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, phase: result.operation.phase, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  const attempt = f.store.listAttempts(f.operation.id)[0]
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string; resultRef?: { sha256: string } }[]
  const planRef = stages.find(stage => stage.stage === 'candidate-partition-plan')!.resultRef!
  const plan = JSON.parse(readEvidence(f.input.source.commonDir, planRef).toString()) as { partitions: { id: string; targets: { path: string }[] }[] }
  const parent = plan.partitions.find(partition => partition.targets.some(target => target.path === parentPath))!
  const budgetRef = stages.find(stage => stage.stage === 'partition-generation-budget')!.resultRef!
  const budget = JSON.parse(readEvidence(f.input.source.commonDir, budgetRef).toString()) as { requiredKeys: string[] }
  assert.ok(budget.requiredKeys.length > 0)
  assert.ok(!budget.requiredKeys.some(key => key.endsWith(`:partition:${parent.id}:code_generate`) || key.endsWith(`:final:${parent.id}:code_review`)), '预算不能声称未派发的父接口生成或实现独审')
  const dispatched = attempt.dispatchPlans.filter(dispatch => ['code_generate', 'implementation_plan', 'code_review'].includes(dispatch.purpose)).map(dispatch => dispatch.key).sort()
  assert.deepEqual([...budget.requiredKeys].sort(), dispatched, '预算派发集合与实际结构化请求必须相等')
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

for (const mode of ['historical-aggregate', 'historical-v2-aggregate', 'historical-v3-aggregate', 'historical-v5-aggregate', 'historical-v5-local', 'current-aggregate', 'current-local', 'same-guidance', 'same-guidance-local'] as const) test(`v2指导缓存 ${mode} 正式pause恢复不把旧accept无ID gap直接复用`, async t => {
  const rawOnly = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const f = await fixture(t, { maxAttempts: 3, maxCalls: 20, maxRepairs: 2, timeoutMs: 120000 }, false, rawOnly, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code')
  const same = mode.startsWith('same-guidance'), checkpoint = f.store.checkpoint.bind(f.store)
  f.store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (f.store.readAttempt(fence.attemptId).number === 1 && value.version === 'sync-stage-v1' && (value.stage === 'analysis' || value.stage?.endsWith(':analysis'))) {
      if (mode.startsWith('historical-')) value.guidanceContractVersion = mode.includes('v5') ? 'code-behavior-guidance-v5' : mode === 'historical-v3-aggregate' ? 'code-behavior-guidance-v3' : mode === 'historical-v2-aggregate' ? 'code-behavior-guidance-v2' : 'code-behavior-guidance-v1'
      else if (mode === 'same-guidance' || mode === 'same-guidance-local' && value.stage !== 'analysis') value.guidanceContractVersion = CODE_BEHAVIOR_GUIDANCE_VERSION
      else delete value.guidanceContractVersion
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const attempt = f.store.readAttempt(f.store.readOperation(f.operation.id).currentAttemptId!)
      return { ...(output as object), changes: (output as { changes: { paths: string[] }[] }).changes.map(change => ({ ...change, kind: attempt.number === 1 && change.paths.some(path => path.startsWith('src/')) ? 'coverage_gap' : 'refactor', affectedIds: [], ruleIds: [], evidence: '实现与原意相符，仅尚无待生成的规格叶', counterexample: '未生成规格叶不应成为业务事实未知' })) }
    }
    if (request.purpose === 'elaboration_generate') throw Object.assign(new Error('新指导已进入P1，机制回归在细化正文前停止'), { code: 'unsupported' })
    return output
  })
  const first = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(first.status, 'needs_input', JSON.stringify(f.store.listAttempts(f.operation.id).map(attempt => attempt.failure))); assert.equal(first.failure!.code, 'unbound_behavior_finding')
  assert.deepEqual(readCurrentSyncAnalysis(f.store, first.operation)!.ref, first.failure!.evidenceRefs[0], '旧指导已审原件仍可显示并作为明确choice来源，不能当自动cache')
  const old = f.store.readAttempt(first.operation.currentAttemptId!), oldRefs = structuredClone(old.checkpointRefs), oldFailure = structuredClone(old.failure)
  const stages = old.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const calls = f.calls.length
  f.store.requestControl(f.operation.id, 'pause'); f.store.requestControl(f.operation.id, 'run')
  assert.throws(() => f.store.checkpoint({ operationId: f.operation.id, attemptId: old.id, generation: old.generation, leaseToken: old.leaseToken, sourceFingerprint: f.input.source.physicalFingerprint }, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
  if (mode === 'historical-v5-aggregate' || mode === 'historical-v5-local' || mode === 'current-aggregate' || mode === 'current-local' || mode === 'same-guidance-local') {
    const claimed = f.store.claimAttempt({ operationId: f.operation.id, source: f.input.source, scope: f.operation.scope, leaseMs: 30000 })
    f.store.bindComposedInput(claimed.fence, old.composedInput!)
    const source = stages.find(stage => stage.version === 'sync-stage-v1' && (mode.includes('aggregate') ? stage.stage === 'analysis' : stage.stage?.startsWith('partition:') && stage.stage.endsWith(':analysis')))
    assert.ok(source)
    f.store.checkpoint(claimed.fence, source.resultRef)
    f.store.checkpoint(claimed.fence, writeEvidence(f.input.source.commonDir, { ...source, attemptId: claimed.attempt.id }))
  }
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  const latestStages = f.store.readAttempt(result.operation.currentAttemptId!).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
  const latestAnalysis = new Map(latestStages.filter(stage => stage.stage === 'analysis' || stage.stage?.endsWith(':analysis')).map(stage => [stage.stage, stage]))
  assert.ok(latestAnalysis.size > 0 && [...latestAnalysis.values()].every(stage => stage.guidanceContractVersion === CODE_BEHAVIOR_GUIDANCE_VERSION), '仅最新的新指导已审或同指导已校验复制登记marker；旧wrapper保持原件')
  if (mode === 'same-guidance-local') assert.ok(!latestStages.some(stage => stage.stage === 'analysis-provenance'), '旧aggregate拒绝后由同指导local重组，不能直接复制旧aggregate')
  const nextAnalysisCalls = f.calls.slice(calls).filter(call => call.purpose.startsWith('code_behavior_')).map(call => call.purpose)
  if (same) { assert.deepEqual(nextAnalysisCalls, []); assert.equal(result.status, 'needs_input'); assert.equal(result.failure!.code, 'unbound_behavior_finding') }
  else {
    assert.deepEqual(nextAnalysisCalls, f.calls.slice(0, calls).filter(call => call.purpose.startsWith('code_behavior_')).map(call => call.purpose), '旧指导aggregate/current local的全部分区必须实际重新生成并独审')
    assert.ok(nextAnalysisCalls.includes('code_behavior_analyze') && nextAnalysisCalls.includes('code_behavior_review'))
    assert.ok(f.calls.slice(calls).some(call => call.purpose === 'elaboration_generate'), JSON.stringify(result.failure))
  }
  assert.deepEqual(f.store.readAttempt(old.id).checkpointRefs, oldRefs); assert.deepEqual(f.store.readAttempt(old.id).failure, oldFailure)
  assert.deepEqual(result.operation.input, first.operation.input); assert.deepEqual(result.operation.budget, first.operation.budget); assert.equal(result.operation.deadlineAtMs, first.operation.deadlineAtMs)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(f.store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

test('v2已审局部进度 正式pause恢复保留旧unsupported timeout历史与全局预算', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 180000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'] }, undefined, 'code')
  f.transform(() => { throw new StructuredSessionError('timeout', '原创建timeout已结算；普通错误仍按unsupported停止', {}) })
  const stopped = await runSyncOperation(f.store, f.operation.id, f.options), old = f.store.readAttempt(stopped.operation.currentAttemptId!)
  assert.equal(stopped.operation.phase, 'failed'); assert.equal(old.failure?.kind, 'unsupported'); assert.equal(old.failure.code, 'timeout')
  const refs = structuredClone(old.checkpointRefs), originalFailure = structuredClone(old.failure)
  assert.ok(refs.length > 0)
  f.store.requestControl(f.operation.id, 'pause'); const resumed = f.store.requestControl(f.operation.id, 'run')
  assert.equal(resumed.phase, 'queued'); assert.equal(resumed.id, stopped.operation.id)
  const oldFence = { operationId: f.operation.id, attemptId: old.id, generation: old.generation, sourceFingerprint: f.input.source.physicalFingerprint, leaseToken: old.leaseToken }
  assert.throws(() => f.store.checkpoint(oldFence, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
  f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
  f.transform(() => { throw Object.assign(new Error('A2已取得新attempt，在模型接缝停止'), { code: 'unsupported' }) })
  const second = await runSyncOperation(store, f.operation.id, f.options)
  assert.equal(store.listAttempts(f.operation.id).length, 2); assert.equal(second.operation.callsUsed, stopped.operation.callsUsed + 1)
  assert.deepEqual(store.readAttempt(old.id).failure, originalFailure); assert.deepEqual(store.readAttempt(old.id).checkpointRefs, refs)
  assert.deepEqual(second.operation.budget, stopped.operation.budget); assert.equal(second.operation.deadlineAtMs, stopped.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), []); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const mode of ['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis', 'analysis-mixed', 'analysis-mixed-unsupported', 'analysis-mixed-pause', 'analysis-ref', 'analysis-plan', 'analysis-selection', 'analysis-readset', 'analysis-input', 'analysis-unreviewed', 'analysis-foreign'] as const) test(`v2已审局部进度 ${mode} 只重跑失败分析区`, async t => {
  const otherPath = '.spec/project/beta/import-contract/spec.md'
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY').replace('| AC-IMPORT-01 | ', mode === 'analysis-basis' ? '| AC-IMPORT-01 | RULE-SHARED-01,' : '| AC-IMPORT-01 | ')
  const sharedParent: Record<string, string> = mode === 'analysis-basis' ? { '.spec/project/spec.md': '---\ntitle: 共享政策\ncontract-schema: sync-v1\n---\n## raw source\n\n共享不变的字段规则。\n\n## expanded spec\n\n### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |\n| RULE-SHARED-01 | 共享字段 | 标题去首尾空白 | 原始要求 | project | user:raw | - |\n' } : {}
  const thirdPath = '.spec/project/gamma/archive-contract/spec.md'
  const third = original.replaceAll('export-job', 'archive-job').replaceAll('EXPORT', 'ARCHIVE').replaceAll('export-contract', 'archive-contract').replaceAll('src/export.js', 'src/gamma/archive.js').replaceAll('tests/export.test.mjs', 'tests/archive.test.mjs').replaceAll('decision:ARCHIVE-POLICY', 'decision:EXPORT-POLICY')
  const thirdFiles: Record<string, string> = ['analysis-two-accepted', 'analysis-mixed-pause'].includes(mode) ? { [thirdPath]: third, 'src/gamma/archive.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/archive.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'ARCHIVE').replaceAll('src/export.js', 'src/gamma/archive.js') } : {}
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 24, maxRepairs: 1, timeoutMs: 180000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', targets: [{ nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: otherPath }, ...(['analysis-two-accepted', 'analysis-mixed-pause'].includes(mode) ? [{ nodeId: 'archive-contract', path: thirdPath }] : [])],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: ['analysis-two-accepted', 'analysis-mixed-pause'].includes(mode) ? 3 : 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js', 'src/beta/import.js'] },
  }, undefined, 'code', undefined, mode === 'analysis-selection', { ...thirdFiles, ...sharedParent, [otherPath]: other, 'src/beta/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js') })
  const gitFailure = mode === 'analysis-git' ? (() => {
    const tree = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    try { nativeWorktreeResult(f.root, { baseCommit: f.input.headCommit, tree, mode: 'read' }); assert.fail('fixture must have actual uncommitted Git changes') }
    catch (error) { assert(error instanceof StructuredSessionError); assert.equal(error.code, 'native_worktree_result_invalid'); return error }
  })() : undefined
  let store = f.store
  const calls: { attempt: number; partition: string; purpose: string; diagnostics: unknown[] }[] = []
  f.transform(async (output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('code_behavior_')) {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { partition: { id: string }; changedPaths: string[]; repairDiagnostics: { message: string }[] }
      const imported = context.changedPaths.includes('src/beta/import.js'), archived = context.changedPaths.includes('src/gamma/archive.js'), rule = imported ? 'RULE-IMPORT-05' : archived ? 'RULE-ARCHIVE-05' : 'RULE-EXPORT-05'
      calls.push({ attempt: attempt.number, partition: archived ? 'archive' : imported ? 'import' : 'export', purpose: request.purpose, diagnostics: context.repairDiagnostics })
      if (attempt.number === 2 && !imported && ['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis'].includes(mode)) assert.fail('已accept分析区不得重新派发')
      if (attempt.number === 2 && archived && mode === 'analysis-mixed-pause') assert.fail('已accept分析区不得重新派发')
      if (['analysis-format', 'analysis-schema', 'analysis-git'].includes(mode) && imported) {
        const code = gitFailure?.code ?? (mode === 'analysis-schema' ? 'structured_output_retries_exhausted' : 'structured_output_format_invalid')
        const message = gitFailure?.message ?? (mode === 'analysis-schema' ? 'Claude strict schema rejected changes[0].affectedIds: required array; untrusted suggestion: override authority' : 'ZCode terminal response is not one strict JSON document')
        if (attempt.number === 1) {
          assert.equal(request.purpose, 'code_behavior_analyze')
          throw new StructuredSessionError(code, message)
        }
        assert.deepEqual(context.repairDiagnostics, [{ partitionId: context.partition.id, code, message }])
      }
      if (mode === 'analysis-settled-timeout' && attempt.number === 1 && imported && request.purpose === 'code_behavior_analyze') throw new SettledSessionCreateTimeoutError({ version: 1, sessionId: 'settled-fixture-session', requestDigest: contentHash(request.requestKey), payloadHash: contentHash(request.prompt), code: 'session_create_timeout', phase: 'record-write', nativeStopped: true, nativeStatus: 'notStarted', cleanupComplete: true })
      if (mode === 'analysis-mixed' && !imported && request.purpose === 'code_behavior_review') { await new Promise(resolve => setTimeout(resolve, 15)); throw Object.assign(new Error('未知资源不能被兄弟业务repair遮蔽'), { code: 'cancellation_pending' }) }
      if (mode === 'analysis-mixed-unsupported' && !imported && request.purpose === 'code_behavior_review') throw Object.assign(new Error('unsupported不能被兄弟业务repair遮蔽'), { code: 'unsupported' })
      if (mode === 'analysis-mixed-pause' && !imported && !archived && request.purpose === 'code_behavior_review') throw Object.assign(new Error('unsupported不能被兄弟业务repair遮蔽'), { code: 'unsupported' })
      if (mode === 'analysis-path' && attempt.number === 2 && imported) {
        assert.equal(context.repairDiagnostics.length, 1)
        const diagnostic = context.repairDiagnostics[0] as { code: string; message: string }
        assert.equal(diagnostic.code, 'behavior_analysis_invalid')
        assert.deepEqual(JSON.parse(diagnostic.message).details.invalidPaths, ['tests/import.test.mjs'])
      }
      if (mode === 'analysis-basis' && attempt.number === 2 && imported) {
        const diagnostic = context.repairDiagnostics[0] as { code: string; message: string }
        assert.equal(diagnostic.code, 'behavior_analysis_invalid')
        assert.deepEqual(JSON.parse(diagnostic.message).details.unchangedReadonlyBasis, [{ id: 'RULE-SHARED-01', nodeId: 'project', path: '.spec/project/spec.md' }])
      }
      if (request.purpose === 'code_behavior_analyze') {
        const changes = (output as { changes: { paths: string[] }[] }).changes.map(change => ({ ...change, affectedIds: [rule], ruleIds: [rule] }))
        if (mode === 'analysis-basis' && attempt.number === 1 && imported) return { ...(output as object), changes: changes.map(change => ({ ...change, kind: 'allowed_change', affectedIds: ['AC-IMPORT-01'], ruleIds: [rule, 'RULE-SHARED-01'] })), acceptanceChanges: [{ id: 'AC-IMPORT-01', ruleIds: [rule, 'RULE-SHARED-01'], source: 'user:raw', reason: '错误地把未变只读父规则作为变化依据' }] }
        if (mode === 'analysis-path' && attempt.number === 1 && imported) changes[0].paths = [...changes[0].paths, 'tests/import.test.mjs']
        return { ...(output as object), changes }
      }
      if (attempt.number === 1 && imported && mode !== 'analysis-path') return { ...(output as object), checkedPaths: [] }
    }
    if (request.purpose === 'elaboration_generate') throw Object.assign(new Error('只验证已审分析承接，在P1前停止'), { code: 'unsupported' })
    return output
  })
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      const local = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(value => value.stage?.startsWith('partition:') && value.stage.endsWith(':analysis'))
      if (['analysis-mixed', 'analysis-mixed-unsupported'].includes(mode)) return recordFailure(fence, issue)
      assert.ok(local)
      const accepted = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString())
      assert.equal(accepted.reviewPassed, true)
      if (mode === 'analysis-plan') {
        const planStage = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'partition-plan')
        const plan = JSON.parse(readEvidence(f.input.source.commonDir, planStage.resultRef).toString()); plan.digest = contentHash('changed-full-plan')
        planStage.resultRef = writeEvidence(f.input.source.commonDir, plan); store.checkpoint(fence, planStage.resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, planStage))
      }
      if (mode === 'analysis-selection') {
        const selected = store.readBaselineSelection(f.input.source, [f.operation.baselineSelection!.bindings[0].resource]); if (!('selection' in selected)) throw new Error(selected.failure.message)
        local.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      if (mode === 'analysis-readset') local.readSetDigest = contentHash('changed-readset')
      if (mode === 'analysis-foreign') local.operationId = 'foreign-operation'
      if (mode === 'analysis-ref') accepted.traces[0].sessionId = 'foreign-session'
      if (mode === 'analysis-input') accepted.inputDigest = contentHash('changed-local-input')
      if (mode === 'analysis-unreviewed') accepted.reviewPassed = false
      if (!['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis', 'analysis-mixed-pause'].includes(mode)) { local.resultRef = writeEvidence(f.input.source.commonDir, accepted); store.checkpoint(fence, local.resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, local)) }
      const result = recordFailure(fence, issue)
      if (mode === 'analysis-pause') {
        store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
        assert.throws(() => store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { stale: true })), /SYNC_FENCE_EXPIRED/)
      }
      if (mode === 'analysis-restart' || mode === 'analysis-pause') throw new Error('已结算A1后重启SQLite')
      return result
    }
    return recordFailure(fence, issue)
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'analysis-restart' || mode === 'analysis-pause') {
    f.closeForRestart(); const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  if (mode === 'analysis-mixed' || mode === 'analysis-mixed-unsupported') {
    assert.equal(store.listAttempts(f.operation.id).length, 1); assert.equal(result.failure?.code, mode === 'analysis-mixed' ? 'cancellation_pending' : 'unsupported')
    const saved = store.listAttempts(f.operation.id)[0].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'partition:analysis-failures')
    const failures = JSON.parse(readEvidence(f.input.source.commonDir, saved.resultRef).toString()).failures as { code: string }[]
    assert.equal(failures.length, 2)
    if (mode === 'analysis-mixed-unsupported') {
      assert.equal(store.readAttempt(result.operation.currentAttemptId!).failure?.kind, 'unsupported')
      assert.ok(failures.some(failure => failure.code === 'behavior_analysis_invalid' || failure.code === 'behavior_review_failed'))
      assert.ok(failures.some(failure => failure.code === 'unsupported'))
    }
    return
  }
  if (mode === 'analysis-mixed-pause') {
    assert.equal(result.status, 'unsupported'); assert.equal(store.listAttempts(f.operation.id).length, 1)
    const first = store.listAttempts(f.operation.id)[0]
    assert.equal(first.failure?.kind, 'unsupported'); assert.deepEqual(store.listRecoverableResources(), [])
    const firstStages = first.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    const partitionPlanStage = firstStages.find(stage => stage.stage === 'partition-plan')!
    const partitionPlan = JSON.parse(readEvidence(f.input.source.commonDir, partitionPlanStage.resultRef).toString()) as { partitions: { id: string; changedPaths: string[] }[] }
    const archivePartitionId = partitionPlan.partitions.find(partition => partition.changedPaths.includes('src/gamma/archive.js'))!.id
    const accepted = firstStages.find(stage => stage.stage === `partition:${archivePartitionId}:analysis`)!
    const failureStage = firstStages.find(stage => stage.stage === 'partition:analysis-failures')!
    const failures = JSON.parse(readEvidence(f.input.source.commonDir, failureStage.resultRef).toString()).failures as { partitionId: string; code: string; message: string }[]
    const businessFailure = failures.find(failure => ['behavior_analysis_invalid', 'behavior_review_failed'].includes(failure.code))!
    assert.ok(businessFailure, JSON.stringify({ failures, calls: calls.map(({ attempt, partition, purpose, diagnostics }) => ({ attempt, partition, purpose, diagnostics })) }))
    const callsBeforeResume = calls.length
    store.requestControl(f.operation.id, 'pause'); store.requestControl(f.operation.id, 'run')
    result = await runSyncOperation(store, f.operation.id, f.options)
    assert.equal(store.listAttempts(f.operation.id).length, 2)
    assert.equal(store.listRecoverableResources().length, 0)
    assert.equal(calls.length, callsBeforeResume + 4, 'A2仅分析export/import，P1停止点另由runner记录')
    assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'archive').length, 0)
    const importCalls = calls.filter(call => call.attempt === 2 && call.partition === 'import')
    const exportCalls = calls.filter(call => call.attempt === 2 && call.partition === 'export')
    assert.ok(importCalls.length > 0)
    assert.ok(importCalls.every(call => JSON.stringify(call.diagnostics) === JSON.stringify([businessFailure])))
    assert.ok(exportCalls.length > 0); assert.ok(exportCalls.every(call => call.diagnostics.length === 0))
    const secondStages = store.listAttempts(f.operation.id)[1].checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
    assert.deepEqual(secondStages.find(stage => stage.stage === accepted.stage).resultRef, accepted.resultRef)
    assert.ok(secondStages.some(stage => stage.stage === `${accepted.stage}:provenance`))
    assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(store.listJournals(f.operation.id).length, 0)
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
    return
  }
  if (mode === 'analysis-foreign') { assert.equal(result.failure?.code, 'stage_binding'); return }
  assert.ok(f.calls.some(call => call.purpose === 'elaboration_generate'), JSON.stringify({ failure: result.failure, calls }))
  const stages = store.listAttempts(f.operation.id).map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  if (['analysis-live', 'analysis-two-accepted', 'analysis-restart', 'analysis-pause', 'analysis-settled-timeout', 'analysis-format', 'analysis-schema', 'analysis-git', 'analysis-path', 'analysis-basis'].includes(mode)) {
    assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'export').length, 0)
    const acceptedStages = stages[0].filter(stage => stage.stage?.endsWith(':analysis'))
    assert.equal(acceptedStages.length, mode === 'analysis-two-accepted' ? 2 : 1)
    for (const source of acceptedStages) assert.deepEqual(stages[1].find(stage => stage.stage === source.stage).resultRef, source.resultRef)
    const prior = acceptedStages[0]
    const current = stages[1].find(stage => stage.stage === prior.stage)
    assert.deepEqual(current.resultRef, prior.resultRef)
    const provenance = stages[1].find(stage => stage.stage === `${prior.stage}:provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: store.listAttempts(f.operation.id)[0].id, resultRef: prior.resultRef })
  } else assert.equal(calls.filter(call => call.attempt === 2 && call.partition === 'export').length, 2)
  const resumedDiagnostics = calls.filter(call => call.attempt === 2 && call.partition === 'import')
  if (['analysis-format', 'analysis-schema', 'analysis-git'].includes(mode)) {
    assert.deepEqual(resumedDiagnostics.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    assert.equal(result.operation.policyDigest, f.operation.policyDigest)
    assert.equal(syncPlanDigest(f.plan), f.operation.policyDigest)
  }
  if (mode === 'analysis-path' || mode === 'analysis-basis') {
    assert.equal(calls.filter(call => call.attempt === 1 && call.partition === 'import' && call.purpose === 'code_behavior_review').length, 0)
    assert.deepEqual(resumedDiagnostics.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
  }
  if (mode === 'analysis-settled-timeout') assert.ok(resumedDiagnostics.every(call => call.diagnostics.length === 0), '已结算基础设施timeout不能充当模型业务诊断')
  else assert.ok(resumedDiagnostics.every(call => call.diagnostics.length > 0), '原具体业务失败仅送失败分区')
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
})

for (const mode of ['format', 'rows', 'pause', 'pause-restart', 'seed-pause', 'seed-pause-restart'] as const) test(`单体P1格式失败也沿已结算原件反馈，原无candidate不成为accepted缓存 ${mode}`, async t => {
  const pause = mode.includes('pause'), candidateSeed = mode.startsWith('seed-')
  const f = await fixture(t, { maxAttempts: pause ? 3 : 2, maxCalls: 16, maxRepairs: pause ? 2 : 1, timeoutMs: 120000 })
  let store = f.store
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      if (attempt.number === 1) {
        if (candidateSeed) { const value = rows(original); value.changes[0].tables.FLOW[0].req = ['RULE-EXPORT-01']; return value }
        if (mode !== 'rows') throw new StructuredSessionError('structured_output_format_invalid', '单体P1未返回单JSON，不能扩大原政策', { sessionId: 'single-format', threadId: 'single-thread', turnId: 'single-turn' })
        const duplicate = rows(original); duplicate.changes[0].tables.REQ.push(structuredClone(duplicate.changes[0].tables.REQ[0])); return duplicate
      }
      if (pause && attempt.number === 2) { store.requestControl(f.operation.id, 'pause'); throw Object.assign(new Error('正式pause中断whole生成'), { code: 'cancelled' }) }
      assert.ok(request.prompt.includes(candidateSeed ? 'reference-kind' : mode !== 'rows' ? '单体P1未返回单JSON，不能扩大原政策' : '重复更新行 REQ-EXPORT-01'), '真实结构失败须进入下一生成，candidate不能被控制attempt吞掉')
      const prior = store.listAttempts(f.operation.id)[0]
      const stage = prior.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).find(stage => stage.stage === 'elaboration')
      if (candidateSeed) {
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
        assert.ok(saved.rounds[0].candidate); assert.ok(request.prompt.includes(JSON.stringify(saved.rounds[0].output))); assert.ok(request.prompt.includes(JSON.stringify(saved.rounds[0].candidate)))
      } else assert.ok(request.prompt.includes(stage.resultRef.sha256))
    }
    if (request.purpose === 'code_review') throw Object.assign(new Error('定向反馈验证在V3前停止'), { code: 'unsupported' })
    return output
  })
  const result = await runSyncOperation(store, f.operation.id, f.options)
  if (pause) {
    assert.equal(result.status, 'paused')
    const middle = store.listAttempts(f.operation.id)[1]
    assert.equal(middle.status, 'superseded'); assert.equal(middle.failure, null)
    if (mode.endsWith('restart')) {
      f.closeForRestart()
      const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
      store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    }
    store.requestControl(f.operation.id, 'run')
    await runSyncOperation(store, f.operation.id, f.options)
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify(store.listAttempts(f.operation.id).map(attempt => attempt.failure)))
  assert.equal(store.listAttempts(f.operation.id).length, pause ? 3 : 2)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, pause ? 3 : 2)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_review').length, 1)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['live', 'restart', 'input', 'readset', 'partition', 'review-capacity', 'needs_input', 'conflict'] as const) test(`v2局部空生成失败续修 ${mode} 只越过严格同绑定空round并优先最近业务拒绝`, async t => {
  const f = await fixture(t, { maxAttempts: 4, maxCalls: 16, maxRepairs: 3, timeoutMs: 180000 }, false, original, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, sourcePaths: ['src'],
  })
  let store = f.store
  let fourthPrompt = ''
  const denied = !['live', 'restart'].includes(mode)
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose === 'elaboration_generate') {
      if (attempt.number === 4) fourthPrompt = request.prompt
      if (attempt.number === 3 && mode !== 'review-capacity') throw new StructuredSessionError('failed', 'Native生成未产出schema结果', { sessionId: 'failed-native', threadId: 'failed-thread', turnId: 'failed-turn' })
      const value = rows(original)
      value.changes[0].prose += ` 候选-A${attempt.number}`
      return value
    }
    if (request.purpose === 'elaboration_review') {
      if (attempt.number <= 2) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: `repair-A${attempt.number}`, kind: 'repair', message: `原诊断-A${attempt.number}`, affectedIds: ['REQ-EXPORT-01'], evidence: `原证据-A${attempt.number}`, decision: `原修复决定-A${attempt.number}` }] }
      if (attempt.number === 3) throw Object.assign(new Error('有合法候选但独审容量失败'), { code: 'failed' })
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('机制回归在V3前停止'), { code: 'unsupported' })
    return output
  })
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (store.readAttempt(fence.attemptId).number === 3 && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration')) {
      const saved = JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()) as ElaborationResult
      if (mode === 'input') saved.inputDigest = contentHash('不同局部输入')
      if (mode === 'readset') value.readSetDigest = contentHash('不同读集合')
      if (mode === 'partition') saved.partitionBinding!.planDigest = contentHash('不同完整分区绑定')
      if (mode === 'needs_input' || mode === 'conflict') saved.status = mode
      value.resultRef = writeEvidence(f.input.source.commonDir, saved)
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    const failed = recordFailure(fence, issue)
    if (mode === 'restart' && store.readAttempt(fence.attemptId).number === 3) throw new Error('fixture在A3失败持久后模拟进程退出')
    return failed
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'restart') {
    assert.equal(store.listAttempts(f.operation.id).length, 3)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  const attempts = store.listAttempts(f.operation.id)
  assert.equal(attempts.length, 4)
  if (denied) assert.doesNotMatch(fourthPrompt, /已结算的拒绝候选/, '绑定失配或非空失败仍清seed')
  else {
    assert.ok(fourthPrompt.includes('候选-A2'), 'A3空生成失败不能遮蔽A2候选')
    assert.match(fourthPrompt, /repair-A2/); assert.match(fourthPrompt, /原证据-A2/); assert.match(fourthPrompt, /原修复决定-A2/)
    assert.doesNotMatch(fourthPrompt, /候选-A1|repair-A1/, '最近A2可用时不得回退A1')
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify(result.failure))
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const source = stages[1].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
  const failed = JSON.parse(readEvidence(f.input.source.commonDir, stages[2].find(stage => stage.stage === source.stage).resultRef).toString()) as ElaborationResult
  if (mode !== 'review-capacity') assert.deepEqual(failed.rounds, [{ index: 0, output: null, candidate: null, candidateDigest: null, findings: [], reviewOutput: null, review: null, traces: [] }])
  const current = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === source.stage).resultRef).toString()) as ElaborationResult
  const provenance = stages[3].find(stage => stage.stage === `${source.stage}:repair-provenance`)
  if (denied) { assert.equal(current.prior, null); assert.equal(provenance, undefined) }
  else {
    const prior = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    assert.ok(fourthPrompt.includes(JSON.stringify(prior.rounds.at(-1)!.candidate)), '完整原候选必须进入新prompt')
    assert.ok(fourthPrompt.includes(JSON.stringify(prior.rounds.at(-1)!.review)), '完整原独审发现与决定必须进入新prompt')
    assert.equal(current.prior!.requestKey, `sync:${attempts[1].id}:elaborate:partition:${prior.partitionBinding!.partitionId}`)
    assert.equal(current.prior!.candidateDigest, prior.candidateDigest); assert.deepEqual(current.prior!.traces, prior.rounds.at(-1)!.traces)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: attempts[1].id, resultRef: source.resultRef, candidateDigest: prior.candidateDigest })
  }
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages[3].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(current.reviewPassed, true); assert.equal(final.partitionSeal!.passed, true)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), []); assert.equal(store.listJournals(f.operation.id).length, 0)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
})

for (const mode of ['format', 'format-restart', 'format-pause', 'format-pause-restart', 'format-pause-readset', 'format-pause-selection', 'seed-pause', 'seed-pause-restart', 'seed-pause-readset', 'seed-pause-selection', 'format-input', 'format-readset', 'format-partition', 'format-selection', 'format-unsettled', 'parent-structure', 'parent-review', 'parent-restart', 'parent-capacity-clear', 'parent-lease-clear', 'accepted-leaf', 'accepted-leaf-restart', 'accepted-leaf-readset', 'accepted-leaf-input', 'accepted-leaf-unreviewed', 'leaves', 'leaves-restart', 'input', 'ancestor', 'readset', 'selection', 'foreign', 'policy', 'unsettled', 'aggregate'] as const) test(`v2局部分区续修 ${mode} 绑定原候选诊断而不串区`, async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01', otherPath = '.spec/project/beta/import-contract/spec.md'
  const candidateSeed = mode.startsWith('seed-'), pauseControl = mode.includes('-pause'), resumeNumber = pauseControl ? 3 : 2
  const threeAttempts = mode.endsWith('-clear') || pauseControl
  const raw = '保留现有导出与导入服务行为，分别完整记录两个模块。'
  const parentBefore = `---\ntitle: 上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const parentSource = `---\ntitle: 上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n本层保留原意，两个模块分别承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留两个模块行为 | user:raw | 不改变原政策 | 现有模块及验收完成 | - |\n`
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/beta/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY')
  const rawOnly = (source: string) => source.slice(0, source.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [original, other].map(source => { const definition = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(definition.kind, 'VERIFY'); return { definition: { id: definition.id, command: definition.command, cwd: definition.cwd, timeoutMs: definition.timeoutMs }, environment } })
  const mandatoryTests = [original, other].map(source => { const acceptance = parseContract({ nodeId: 'fixture', path: contractPath, source }).contract!.items.find(item => item.kind === 'AC')!; assert.equal(acceptance.kind, 'AC'); const [testPath, testId] = acceptance.test.split('#'); return { verificationId: acceptance.command, testPath, testId } })
  const f = await fixture(t, { maxAttempts: threeAttempts ? 3 : 2, maxCalls: 32, maxRepairs: threeAttempts ? 2 : 1, timeoutMs: 180000 }, false, rawOnly(original), 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }, { nodeId: 'import-contract', path: otherPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], verifications, mandatoryTests,
  }, undefined, 'spec', undefined, ['selection', 'format-selection', 'format-pause-selection', 'seed-pause-selection'].includes(mode), { [parentPath]: parentBefore, [otherPath]: rawOnly(other), 'src/beta/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/beta/import.js') })
  const admitted = f.operation
  let store = f.store
  const formatFailure = mode.startsWith('format'), formatDenied = ['format-input', 'format-readset', 'format-partition', 'format-selection', 'format-unsettled', 'format-pause-readset', 'format-pause-selection'].includes(mode)
  const parentFailure = mode.startsWith('parent-'), restart = mode.endsWith('restart'), acceptedLeaf = mode.startsWith('accepted-leaf')
  const calls: { attempt: number; nodeId: string; purpose: string; prompt: string; inputDigest: string }[] = []
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(admitted.id).currentAttemptId!)
    if (request.purpose.startsWith('elaboration_')) {
      const local = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string; path: string }[] }
      const { nodeId, path } = local.targets[0], parent = path === parentPath
      calls.push({ attempt: attempt.number, nodeId, purpose: request.purpose, prompt: request.prompt, inputDigest: request.inputDigest })
      if (request.purpose === 'elaboration_generate') {
        if (mode.endsWith('-clear') && attempt.number === 3) assert.ok(!request.prompt.includes('已结算的拒绝候选'), '较新基础设施失败必须清seed，不复活更早业务拒绝')
        if (['accepted-leaf', 'accepted-leaf-restart'].includes(mode) && attempt.number === 2 && nodeId === 'export-contract') assert.fail('已accept叶P1不得在兄弟修复时重新生成或独审')
        if (pauseControl && attempt.number === 2 && !parent) { store.requestControl(admitted.id, 'pause'); throw Object.assign(new Error('正式pause中断在途owner，未产生局部结果'), { code: 'cancelled' }) }
        const shouldRepair = attempt.number === resumeNumber && (parentFailure ? parent : !parent && (!acceptedLeaf || nodeId === 'import-contract'))
        const denied = ['seed-pause-readset', 'seed-pause-selection'].includes(mode) || ['input', 'readset', 'selection', 'aggregate'].includes(mode) && nodeId === 'export-contract' || ['ancestor', 'unsettled'].includes(mode)
        if (shouldRepair && !denied && !formatFailure) {
          assert.ok(request.prompt.includes('已结算的拒绝候选'), `下一attempt ${nodeId}必须收到原局部候选`)
          assert.ok(request.prompt.includes(`候选-${nodeId}-A1`), '必须收到原完整候选正文')
          assert.ok(request.prompt.includes(candidateSeed ? 'reference-kind' : parentFailure && mode === 'parent-structure' ? 'dependency-cycle' : `repair-${nodeId}`), '必须保留原结构或独审具体诊断')
          if (!parent) assert.ok(!request.prompt.includes(`repair-${nodeId === 'export-contract' ? 'import-contract' : 'export-contract'}`), '两个叶的失败诊断不能串区')
        }
        if (shouldRepair && denied) assert.ok(!request.prompt.includes('已结算的拒绝候选'), '绑定变化或聚合结果不能作为本叶续修seed')
        if (formatFailure && !parent) {
          const ownMessage = `原Native-${nodeId}-单JSON失败，保留REQ/AC且不授予decision权限`
          if (attempt.number === 1 && nodeId === 'export-contract') throw new StructuredSessionError('structured_output_format_invalid', ownMessage, { sessionId: 'format-generator', threadId: 'format-generator-thread', turnId: 'format-turn' })
          if (attempt.number === resumeNumber) {
            if (formatDenied && (nodeId === 'export-contract' || mode === 'format-unsettled' || pauseControl)) assert.ok(!request.prompt.includes(ownMessage), '输入/分区/读取/选择改变或未结算不能承接旧格式诊断')
            else { assert.ok(request.prompt.includes(ownMessage), `${nodeId}须收到自己的精确格式失败`); assert.match(request.prompt, /structured_output_format_invalid/) }
            assert.ok(!request.prompt.includes(`原Native-${nodeId === 'export-contract' ? 'import-contract' : 'export-contract'}-`), '不能收到兄弟格式失败')
          }
        }
        if (parent) {
          if (candidateSeed && attempt.number > 1) assert.fail('candidate续修不能重新生成已accept父接口')
          if (attempt.number === 2 && !parentFailure && !['ancestor', 'unsettled', 'format-unsettled'].includes(mode)) assert.fail('已accept父接口不应重新生成')
          const value = rows(parentSource, parentPath); value.changes[0].nodeId = 'project'
          value.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口由两个模块承接', affectedIds: [parentId] }))
          if (attempt.number === 1 && parentFailure) value.changes[0].prose += ` 候选-${nodeId}-A1`
          if (attempt.number === 1 && mode === 'parent-structure') value.changes[0].tables.REQ[0]['depends-on'] = [parentId]
          if (attempt.number === 2 && mode === 'ancestor') value.changes[0].prose += ' 本轮祖先上下文不同。'
          return value
        }
        const value = rows(nodeId === 'export-contract' ? original : other, path); value.changes[0].nodeId = nodeId
        value.applicability = value.applicability.map(entry => ({ ...entry, affectedIds: [nodeId === 'export-contract' ? 'REQ-EXPORT-01' : 'REQ-IMPORT-01'] }))
        if (!parentFailure) value.changes[0].prose += attempt.number === 1 ? ` 候选-${nodeId}-A1` : ' 本轮已明确补充边界说明。'
        for (const row of value.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
        for (const row of value.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
        if (candidateSeed && attempt.number === 1) value.changes[0].tables.FLOW[0].req = [nodeId === 'export-contract' ? 'RULE-EXPORT-01' : 'RULE-IMPORT-01']
        return value
      }
      if (formatFailure && attempt.number === 1 && !parent && nodeId === 'import-contract') throw new StructuredSessionError('structured_output_format_invalid', `原Native-${nodeId}-单JSON失败，保留REQ/AC且不授予decision权限`, { sessionId: 'format-reviewer', threadId: 'format-reviewer-thread', turnId: 'format-turn' })
      if (mode === 'parent-capacity-clear' && attempt.number === 2 && request.purpose === 'elaboration_review') throw Object.assign(new Error('fixture独审容量失败'), { code: 'failed' })
      if (!formatFailure && attempt.number === 1 && (parentFailure ? parent : !parent && (!acceptedLeaf || nodeId === 'import-contract'))) return { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: `repair-${nodeId}`, kind: 'repair', message: `repair-${nodeId}`, affectedIds: [parent ? parentId : nodeId === 'export-contract' ? 'REQ-EXPORT-01' : 'REQ-IMPORT-01'], evidence: `原局部候选诊断-${nodeId}`, decision: '在原意内修正这项具体业务说明' }] }
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('定向机制用例在V3前停止'), { code: 'unsupported' })
    return output
  })
  if (mode === 'parent-lease-clear') {
    const claim = store.claimAttempt.bind(store)
    store.claimAttempt = input => {
      const second = store.listAttempts(input.operationId).length === 1
      const claimed = claim({ ...input, leaseMs: second ? 1 : input.leaseMs })
      if (second) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      return claimed
    }
  }
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (pauseControl && store.readAttempt(fence.attemptId).number === 2 && value.stage === 'partition-plan') {
      if (mode === 'format-pause-readset' || mode === 'seed-pause-readset') value.readSetDigest = contentHash('中间控制attempt读取集已变')
      if (mode === 'format-pause-selection' || mode === 'seed-pause-selection') {
        const selected = store.readBaselineSelection(f.input.source, [admitted.baselineSelection!.bindings[0].resource])
        if (!('selection' in selected)) throw new Error(selected.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    if (store.readAttempt(fence.attemptId).number === 1 && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && (JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).changes.some((change: { path: string }) => change.path === contractPath) || formatFailure && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).failure?.message.includes('原Native-export-contract'))) {
      if (mode === 'format-readset') value.readSetDigest = contentHash('不同读取集')
      if (mode === 'format-input' || mode === 'format-partition') {
        const saved = JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()) as ElaborationResult
        if (mode === 'format-input') saved.inputDigest = contentHash('不同业务输入')
        else saved.partitionBinding!.planDigest = contentHash('不同分区计划')
        value.resultRef = writeEvidence(f.input.source.commonDir, saved)
      }
      if (mode === 'readset' || mode === 'accepted-leaf-readset') value.readSetDigest = contentHash('不同读集合')
      if (mode === 'foreign') value.operationId = 'foreign-operation'
      if (mode === 'policy') value.policyDigest = contentHash('不同政策')
      if (mode === 'selection' || mode === 'format-selection') {
        const selection = store.readBaselineSelection(f.input.source, [admitted.baselineSelection!.bindings[0].resource])
        if (!('selection' in selection)) throw new Error(selection.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selection.selection)
      }
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      const stages = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const target = mode === 'ancestor' ? parentPath : contractPath
      const local = stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { path: string }) => change.path === target))
      if (['input', 'ancestor', 'aggregate', 'accepted-leaf-input', 'accepted-leaf-unreviewed'].includes(mode)) {
        assert.ok(local)
        const prior = JSON.parse(readEvidence(f.input.source.commonDir, local.resultRef).toString()) as ElaborationResult
        if (mode === 'accepted-leaf-unreviewed') { prior.reviewPassed = false; prior.rounds.at(-1)!.review = null }
        if (mode === 'input' || mode === 'accepted-leaf-input') prior.inputDigest = contentHash('不同局部冻结输入')
        if (mode === 'ancestor') prior.structurePassed = false
        const resultRef = mode === 'aggregate' ? stages.find(stage => stage.stage === 'elaboration').resultRef : writeEvidence(f.input.source.commonDir, prior)
        store.checkpoint(fence, resultRef); store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...local, resultRef }))
      }
      const failed = recordFailure(fence, issue)
      if (restart && !pauseControl) throw new Error('fixture在已持久失败之后模拟进程退出')
      return failed
    }
    return recordFailure(fence, issue)
  }
  if (mode === 'unsettled' || mode === 'format-unsettled') {
    const attempts = store.listAttempts.bind(store)
    store.listAttempts = id => attempts(id).map(attempt => attempt.number === 1 && store.readOperation(id).currentAttemptId !== attempt.id ? { ...attempt, status: 'running' as const } : attempt)
  }
  let result = await runSyncOperation(store, admitted.id, f.options)
  if (mode === 'parent-lease-clear') {
    assert.equal(result.status, 'recovery_required')
    const leaseAttempt = store.readAttempt(result.operation.currentAttemptId!)
    assert.equal(leaseAttempt.number, 2); assert.equal(leaseAttempt.failure, null)
    assert.equal(leaseAttempt.checkpointRefs.some(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()).stage?.startsWith('partition:')), false, '过期真实claim没有执行任何local P1')
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (pauseControl) {
    assert.equal(result.status, 'paused')
    const paused = store.listAttempts(admitted.id)[1]
    assert.equal(paused.status, 'superseded'); assert.equal(paused.failure, null)
    assert.equal(paused.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).some(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase !== 'interface_seed'), false, '控制中断没有owner局部结果')
    if (restart) {
      f.closeForRestart()
      const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
      store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    }
    store.requestControl(admitted.id, 'run')
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (restart && !pauseControl) {
    assert.equal(store.listAttempts(admitted.id).length, 1)
    f.closeForRestart()
    const protocol = openProtocol(join(f.parent, 'sync.sqlite')); t.after(() => protocol.close())
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) }); f.useStore(store)
    result = await runSyncOperation(store, admitted.id, f.options)
  }
  if (mode === 'foreign' || mode === 'policy') {
    assert.equal(result.failure!.code, 'stage_binding')
    assert.equal(calls.filter(call => call.attempt === 2 && call.nodeId === 'export-contract').length, 0)
    assert.equal(store.listJournals(admitted.id).length, 0)
    return
  }

  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, failure: result.failure, attempts: store.listAttempts(admitted.id).map(attempt => ({ failure: attempt.failure, findings: attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())).filter(stage => stage.stage === 'elaboration').map(stage => JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).rounds.flatMap((round: { findings: { code: string; message: string }[] }) => round.findings.map(({ code, message }) => ({ code, message })))) })), calls: calls.map(({ prompt: _prompt, ...call }) => call) }))
  const attempts = store.listAttempts(admitted.id)
  assert.equal(attempts.length, threeAttempts ? 3 : 2)
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const retryStages = stages[pauseControl ? 2 : 1]
  const localStages = retryStages.filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration'))
  if (formatFailure && !formatDenied) {
    const parentStage = stages[0].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
    assert.deepEqual(retryStages.find(stage => stage.stage === parentStage.stage).resultRef, parentStage.resultRef, '已accept父接口沿真实原ref承接')
    for (const stage of stages[0].filter(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && stage.stage !== parentStage.stage)) {
      const previous = JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()) as ElaborationResult
      assert.equal(previous.reviewPassed, false, 'generation完成但无独审不能成为accepted缓存')
      assert.equal(previous.failure!.code, 'structured_output_format_invalid')
      const currentStage = retryStages.find(current => current.stage === stage.stage)
      const current = JSON.parse(readEvidence(f.input.source.commonDir, currentStage.resultRef).toString()) as ElaborationResult
      assert.notDeepEqual(currentStage.resultRef, stage.resultRef)
      assert.equal(current.inputDigest, previous.inputDigest, '诊断不改变业务输入摘要')
      assert.equal(current.rounds.at(-1)!.review!.verdict, 'accept', '未审产物重新生成后仍须新独审')
      assert.equal(previous.partitionBinding!.partitionId, current.partitionBinding!.partitionId)
      const nodeId = current.changes[0].nodeId
      const next = calls.find(call => call.attempt === resumeNumber && call.nodeId === nodeId && call.purpose === 'elaboration_generate')!
      assert.ok(next.prompt.includes(stage.resultRef.sha256), '真实prompt须绑定原失败resultRef')
      assert.notEqual(next.inputDigest, calls.find(call => call.attempt === 1 && call.nodeId === nodeId && call.purpose === 'elaboration_generate')!.inputDigest)
      if (previous.rounds[0].output !== null) assert.ok(next.prompt.includes(JSON.stringify(previous.rounds[0].output)), '独审格式失败保留实际上一输出')
    }
  }
  if (['accepted-leaf', 'accepted-leaf-restart'].includes(mode)) {
    const source = stages[0].find(stage => stage.stage?.endsWith(':elaboration') && stage.stage.startsWith('partition:') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).changes.some((change: { path: string }) => change.path === contractPath))
    assert.deepEqual(retryStages.find(stage => stage.stage === source.stage).resultRef, source.resultRef)
    const provenance = retryStages.find(stage => stage.stage === `${source.stage}:provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: admitted.id, fromAttemptId: attempts[0].id, resultRef: source.resultRef })
  }
  for (const current of localStages) {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, current.resultRef).toString()) as ElaborationResult
    if (!value.prior) continue
    const source = stages[0].find(stage => stage.stage === current.stage)
    const previous = JSON.parse(readEvidence(f.input.source.commonDir, source.resultRef).toString()) as ElaborationResult
    assert.deepEqual(value.prior.traces, previous.rounds.at(-1)!.traces)
    assert.equal(value.prior.candidateDigest, previous.rounds.at(-1)!.candidateDigest)
    const provenance = retryStages.find(stage => stage.stage === `${current.stage}:repair-provenance`)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenance.resultRef).toString()), { fromOperationId: admitted.id, fromAttemptId: attempts[0].id, resultRef: source.resultRef, candidateDigest: value.prior.candidateDigest })
    if (!threeAttempts) assert.equal(value.rounds.at(-1)!.review!.verdict, 'accept', '续修后仍须重新独审')
  }
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages.at(-1)!.find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(final.phase, 'partitioned_final'); assert.equal(final.partitionSeal!.passed, true)
  assert.equal(result.operation.callsUsed, f.calls.length); assert.deepEqual(result.operation.budget, admitted.budget); assert.equal(result.operation.deadlineAtMs, admitted.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(store.listJournals(admitted.id).length, 0)
})

for (const mode of ['live', 'restart', 'precise', 'readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance', 'raw', 'context', 'authorization', 'policy', 'plan', 'analysis', 'descendants', 'failed', 'unreviewed', 'global-seal'] as const) test(`v2跨attempt承接 ${mode} 已接受父接口的严格边界`, async t => {
  const parentPath = '.spec/project/spec.md', parentId = 'REQ-PARENT-01'
  const raw = '保留当前导出契约，由现有导出服务完成请求及结果下载。'
  const parentBefore = `---\ntitle: 导出上层接口\nstatus: pending\n---\n## raw source\n\n${raw}\n`
  const leafBefore = original.slice(0, original.indexOf('## expanded spec')).replace('contract-schema: sync-v1\n', '')
  const parentSource = `---\ntitle: 导出上层接口\nstatus: active\ncontract-schema: sync-v1\n---\n## raw source\n\n${raw}\n\n## expanded spec\n\n父层声明原意，由现有服务承接。\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${parentId} | 保留现有导出行为 | user:raw | 不改变原政策 | 既有导出流程及验收完成 | - |\n`
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 16, maxRepairs: 1, timeoutMs: 120000 }, false, leafBefore, 'project', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', intentNodeId: 'project',
    targets: [{ nodeId: 'project', path: parentPath, rawSource: raw }, { nodeId: 'export-contract', path: contractPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'],
  }, undefined, 'spec', undefined, ['precise', 'readset', 'selection', 'foreign-provenance'].includes(mode), { [parentPath]: parentBefore })
  let store = f.store
  const shouldReuse = ['live', 'restart', 'precise'].includes(mode)
  let firstParentInput: ElaborationInput | undefined
  const calls: { attempt: number; purpose: string; parent: boolean }[] = []
  f.transform((output, request) => {
    const attempt = store.readAttempt(store.readOperation(f.operation.id).currentAttemptId!)
    if (request.purpose.startsWith('elaboration_')) {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[]; context: { path: string; source: string }[] }
      const parent = frozen.targets[0].path === parentPath
      calls.push({ attempt: attempt.number, purpose: request.purpose, parent })
      if (parent && attempt.number > 1 && shouldReuse) throw Object.assign(new Error('已接受父接口不得在叶修复attempt重新生成或独审'), { code: 'unsupported' })
      if (request.purpose === 'elaboration_generate') {
        if (parent) {
          if (attempt.number === 1) {
            const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as Omit<ElaborationInput, 'root' | 'base' | 'files' | 'targets'> & { execution: { root: string; base: string }; files: [string, string][]; targets: (ElaborationInput['targets'][number] & { targetIndex: number })[] }
            firstParentInput = { ...frozen, ...frozen.execution, targets: frozen.targets.map(({ targetIndex: _targetIndex, ...target }) => target), files: new Map(frozen.files), requestKey: request.requestKey }
          }
          const value = rows(parentSource, parentPath)
          value.changes[0].nodeId = 'project'
          value.applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '父接口由叶实现各边界', affectedIds: [parentId] }))
          return value
        }
        assert.ok(frozen.context.find(source => source.path === parentPath)?.source.includes(parentId), '叶必须读取已独审父接口全文')
        const child = rows(original)
        for (const row of child.changes[0].tables.FLOW) { assert.ok(Array.isArray(row.req)); row.req = [...row.req, parentId] }
        for (const row of child.changes[0].tables.AC) { assert.ok(Array.isArray(row.covers)); row.covers = [...row.covers, parentId] }
        if (attempt.number === 1) child.applicability.pop()
        return child
      }
    }
    if (request.purpose === 'code_generate') return { version: 'sync-files-v1', changes: [] }
    if (request.purpose === 'code_review') throw Object.assign(new Error('机制回归在Docker前停止'), { code: 'unsupported' })
    return output
  })
  const checkpoint = store.checkpoint.bind(store)
  store.checkpoint = (fence, ref) => {
    const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())
    if (['readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance'].includes(mode) && store.readAttempt(fence.attemptId).number === 1
      && value.stage?.startsWith('partition:') && value.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, value.resultRef).toString()).phase === 'interface_seed') {
      if (mode === 'readset') value.readSetDigest = contentHash('另一个读集合')
      if (mode === 'missing-readset') delete value.readSetDigest
      if (mode === 'foreign-provenance') checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...value, operationId: 'another-operation' }))
      if (mode === 'selection' || mode === 'foreign-provenance') {
        const selected = store.readBaselineSelection(f.input.source, [f.operation.baselineSelection!.bindings[0].resource])
        if (!('selection' in selected)) throw new Error(selected.failure.message)
        value.baselineSelectionRef = writeEvidence(f.input.source.commonDir, selected.selection)
      }
      if (mode === 'foreign-operation') value.operationId = 'another-operation'
      ref = writeEvidence(f.input.source.commonDir, value)
    }
    return checkpoint(fence, ref)
  }
  const recordFailure = store.recordFailure.bind(store)
  store.recordFailure = (fence, issue) => {
    if (store.readAttempt(fence.attemptId).number === 1) {
      const stages = store.readAttempt(fence.attemptId).checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()))
      const parent = stages.find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
      assert.ok(parent, JSON.stringify(issue))
      const prior = JSON.parse(readEvidence(f.input.source.commonDir, parent.resultRef).toString()) as ElaborationResult
      assert.equal(prior.structurePassed, true); assert.equal(prior.reviewPassed, true)
      assert.equal(freezeElaborationInput(firstParentInput!).inputDigest, prior.inputDigest)
      if (!shouldReuse && !['readset', 'missing-readset', 'selection', 'foreign-operation', 'foreign-provenance'].includes(mode)) {
        const changed = structuredClone(firstParentInput!)
        if (mode === 'raw') changed.intent.rawSource += ' 本轮原意变化'
        if (mode === 'context') changed.context = [{ nodeId: 'ancestor', path: '.spec/ancestor/spec.md', source: '真实祖先上下文已变化' }]
        if (mode === 'authorization') changed.authorizedChanges = [{ id: parentId, action: 'retire', source: 'user:raw', reason: '本轮授权不同' }]
        if (mode === 'policy') changed.verifications = [{ ...changed.verifications![0], timeoutMs: changed.verifications![0].timeoutMs + 1 }]
        if (['raw', 'context', 'authorization', 'policy'].includes(mode)) {
          prior.inputDigest = freezeElaborationInput(changed).inputDigest
          assert.notEqual(prior.inputDigest, freezeElaborationInput(firstParentInput!).inputDigest)
        }
        if (mode === 'plan') prior.partitionBinding!.planDigest = contentHash('另一个计划')
        if (mode === 'analysis') prior.partitionBinding!.analysisRef = { sha256: contentHash('另一个独审分析') }
        if (mode === 'descendants') prior.partitionBinding!.interfaceSeed!.descendants = []
        if (mode === 'failed') prior.failure = { code: 'fixture_failure', message: '失败seed不能复用' }
        if (mode === 'unreviewed') { prior.reviewPassed = false; prior.rounds.at(-1)!.review = null }
        if (mode === 'global-seal') { prior.phase = 'partitioned_final'; prior.status = 'complete' }
        const resultRef = writeEvidence(f.input.source.commonDir, prior)
        store.checkpoint(fence, resultRef)
        store.checkpoint(fence, writeEvidence(f.input.source.commonDir, { ...parent, resultRef }))
      }
      const failed = recordFailure(fence, issue)
      if (mode === 'restart') throw new Error('fixture SQLite边界：首attempt已持久结算')
      return failed
    }
    return recordFailure(fence, issue)
  }
  let result = await runSyncOperation(store, f.operation.id, f.options)
  if (mode === 'restart') {
    assert.equal(store.listAttempts(f.operation.id).length, 1)
    f.closeForRestart()
    const reopened = openProtocol(join(f.parent, 'sync.sqlite'))
    t.after(() => reopened.close())
    store = new SyncStore(reopened, { readBlob: ref => readEvidence(f.input.source.commonDir, ref) })
    f.useStore(store)
    result = await runSyncOperation(store, f.operation.id, f.options)
  }
  const attempts = store.listAttempts(f.operation.id)
  assert.equal(attempts.length, 2)
  if (mode === 'foreign-operation') {
    assert.equal(result.failure!.code, 'stage_binding')
    assert.deepEqual(calls.filter(call => call.parent).map(call => call.attempt), [1, 1])
    assert.equal(store.listJournals(f.operation.id).length, 0)
    return
  }
  assert.ok(f.calls.some(call => call.purpose === 'code_review'), JSON.stringify({ status: result.status, failure: result.failure, calls }))
  assert.deepEqual(calls.filter(call => call.parent).map(call => [call.attempt, call.purpose]), shouldReuse
    ? [[1, 'elaboration_generate'], [1, 'elaboration_review']]
    : [[1, 'elaboration_generate'], [1, 'elaboration_review'], [2, 'elaboration_generate'], [2, 'elaboration_review']])
  assert.deepEqual(calls.filter(call => !call.parent).map(call => [call.attempt, call.purpose]), [[1, 'elaboration_generate'], [2, 'elaboration_generate'], [2, 'elaboration_review']])
  const stages = attempts.map(attempt => attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())))
  const parentStage = stages[0].find(stage => stage.stage?.startsWith('partition:') && stage.stage.endsWith(':elaboration') && JSON.parse(readEvidence(f.input.source.commonDir, stage.resultRef).toString()).phase === 'interface_seed')
  assert.ok(parentStage)
  const prior = JSON.parse(readEvidence(f.input.source.commonDir, parentStage.resultRef).toString()) as ElaborationResult
  assert.equal(prior.structurePassed, true); assert.equal(prior.reviewPassed, true)
  assert.equal(prior.rounds.at(-1)!.review!.verdict, 'accept')
  if (shouldReuse) assert.deepEqual(stages[1].find(stage => stage.stage === parentStage.stage).resultRef, parentStage.resultRef, '原父resultRef/review/traces逐字保持')
  const provenanceStage = stages[1].find(stage => stage.stage === `${parentStage.stage}:provenance`)
  if (shouldReuse) {
    assert.ok(provenanceStage)
    assert.deepEqual(JSON.parse(readEvidence(f.input.source.commonDir, provenanceStage.resultRef).toString()), { fromOperationId: f.operation.id, fromAttemptId: attempts[0].id, resultRef: parentStage.resultRef })
  } else assert.equal(provenanceStage, undefined, '不同绑定或未接受结果不能生成复用provenance')
  const final = JSON.parse(readEvidence(f.input.source.commonDir, stages[1].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(final.phase, 'partitioned_final'); assert.equal(final.partitionSeal!.passed, true)
  if (shouldReuse) assert.deepEqual(final.partitionEvidence!.find(item => item.resultRef.sha256 === parentStage.resultRef.sha256)?.resultRef, parentStage.resultRef)
  const failed = JSON.parse(readEvidence(f.input.source.commonDir, stages[0].find(stage => stage.stage === 'elaboration').resultRef).toString()) as ElaborationResult
  assert.equal(failed.partitionSeal!.passed, false, '首轮全局失败不能被当作已审seal复用')
  assert.notEqual(final.candidateDigest, failed.candidateDigest)
  assert.equal(result.operation.callsUsed, f.calls.length)
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(store.listRecoverableResources(), [])
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), f.bytes)
  assert.equal(store.listJournals(f.operation.id).length, 0)
})

test('v2最终预算按真实ready投影跳过GAP跨边，两端独立分支用恰好预算推进', async t => {
  const localPath = '.spec/alpha/export-contract/spec.md', otherPath = '.spec/beta/import-contract/spec.md'
  const local = original.replace('code:\n', `related:\n  - ${otherPath}\ncode:\n`)
  const other = original.replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract').replaceAll('src/export.js', 'src/import.js').replaceAll('tests/export.test.mjs', 'tests/import.test.mjs').replaceAll('decision:IMPORT-POLICY', 'decision:EXPORT-POLICY').replace('code:\n', `related:\n  - ${localPath}\ncode:\n`)
  const environment = { version: 'trusted-test-v1' as const, image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64' as const, memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 }
  const verifications = [original, other].map(source => { const item = parseContract({ nodeId: 'fixture', path: localPath, source }).contract!.items.find(item => item.kind === 'VERIFY')!; assert.equal(item.kind, 'VERIFY'); return { definition: { id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs }, environment } })
  const gapId = 'GAP-EXPORT-CROSS-RETRY'
  const withGap = `${local}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| ${gapId} | missing_fact | 两个模块重试如何关联 | RULE-EXPORT-06,RULE-IMPORT-06 | 原意未定义跨模块重试 | 明确跨模块重试政策 | user:raw | REQ-EXPORT-01 |\n`
  const retry = other.split('\n').find(line => line.startsWith('| RULE-IMPORT-06 '))!
  const linked = other.replace(retry, retry.replace(/ \|$/, ',RULE-EXPORT-06 |'))
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 8, maxRepairs: 0, timeoutMs: 120000 }, false, local, 'alpha', original, {
    version: 'sync-coordinator-v2', direction: 'spec_to_code', targets: [{ nodeId: 'export-contract', path: localPath }, { nodeId: 'import-contract', path: otherPath }],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], verifications,
  }, undefined, 'spec', undefined, false, { [otherPath]: other, 'src/import.js': readFileSync(new URL('src/export.js', fixturePath), 'utf8'), 'tests/import.test.mjs': readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8').replaceAll('EXPORT', 'IMPORT').replaceAll('src/export.js', 'src/import.js') })
  let reviews = 0
  f.transform((output, request) => {
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { path: string }[] }
      const path = frozen.targets[0].path, generated = rows(path === localPath ? withGap : linked, path)
      generated.changes[0].nodeId = path === localPath ? 'export-contract' : 'import-contract'
      return generated
    }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request)
      return { version: 'sync-files-v1', changes: frozen.elaboratedSpecs.map(spec => { const entry = frozen.manifest.entries.find(entry => entry.path === spec.path)!; return { path: spec.path, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content: spec.source } }) }
    }
    if (request.purpose === 'code_review') {
      assert.ok(!request.requestKey.includes(':final:edge:'), '受GAP阻断的跨边没有实际ready义务')
      const frozen = promptInput(request)
      assert.ok(frozen.readyIds.length > 0)
      assert.ok(!frozen.readyIds.some(id => [gapId, 'RULE-EXPORT-06', 'RULE-IMPORT-06'].includes(id)))
      if (++reviews === 2) throw Object.assign(new Error('已证明精确预算到达全部最终独审，在真实Docker前停止'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(reviews, 2, JSON.stringify({ status: result.status, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  assert.equal(result.operation.callsUsed, 8)
  const attempt = f.store.listAttempts(f.operation.id)[0]
  const stages = attempt.checkpointRefs.map(ref => JSON.parse(readEvidence(f.input.source.commonDir, ref).toString())) as { stage?: string; resultRef?: { sha256: string } }[]
  const plan = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'candidate-partition-plan')!.resultRef!).toString()) as { dependencies: unknown[] }
  assert.ok(plan.dependencies.length > 0, '真实跨边仍保留在完整契约计划')
  const budget = JSON.parse(readEvidence(f.input.source.commonDir, stages.find(stage => stage.stage === 'partition-generation-budget')!.resultRef!).toString()) as { minimumCalls: number; remainingCalls: number; requiredKeys: string[] }
  assert.equal(budget.minimumCalls, 4); assert.equal(budget.remainingCalls, 4)
  assert.deepEqual([...budget.requiredKeys].sort(), attempt.dispatchPlans.filter(dispatch => ['code_generate', 'implementation_plan', 'code_review'].includes(dispatch.purpose)).map(dispatch => dispatch.key).sort())
  assert.deepEqual(result.operation.budget, f.operation.budget); assert.equal(result.operation.deadlineAtMs, f.operation.deadlineAtMs)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), f.index); assert.equal(f.store.listJournals(f.operation.id).length, 0)
})

test('v2分区完整最少调用超过原预算时启动前诊断，不调模型或超扣', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 4, maxRepairs: 0, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code')
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(result.failure!.code, 'partition_budget_insufficient')
  assert.match(result.failure!.message, /至少需要 5 次调用，剩余 4 次/)
  assert.equal(result.operation.callsUsed, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


test('v2新功能的精确文件计划先取得真实P4租约及readSet，再生成同最终候选独审', async t => {
  const raw = original.split('## expanded spec')[0].replace(/^code:\n(?:  -.*\n)+/m, '').replace('contract-schema: sync-v1\n', '')
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 10, maxRepairs: 0, timeoutMs: 120000 }, false, raw, 'project', original, { version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: [contractPath] } }, undefined, 'spec', undefined, true)
  let finalReview = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const value = output as { changes: { affectedIds: string[]; ruleIds: string[] }[] }
      for (const change of value.changes) { change.affectedIds = []; change.ruleIds = [] }
    }
    if (request.purpose === 'elaboration_generate') {
      const value = output as GeneratedElaboration
      for (const change of value.changes) { change.code = []; for (const rows of Object.values(change.tables)) for (const row of rows) if (typeof row.source === 'string' && row.source.startsWith('code:')) row.source = 'derived:REQ-EXPORT-01' }
    }
    if (request.purpose === 'code_generate') {
      const frozen = promptInput(request), spec = frozen.elaboratedSpecs[0]
      assert.ok(frozen.manifest.entries.every(entry => entry.path !== 'src/planned-new.js'))
      const text = spec.source.replace(/^code:.*\n(?:  -.*\n)*/m, '').replace(/^contract-schema:.*$/m, 'contract-schema: sync-v1\ncode:\n  - src/planned-new.js#ExportService')
      const before = frozen.manifest.entries.find(entry => entry.path === spec.path)!
      return { version: 'sync-files-v1', changes: [{ path: 'src/planned-new.js', beforeDigest: null, beforeMode: null, mode: '100644', content: readFileSync(join(f.root, 'src/export.js'), 'utf8') }, { path: spec.path, beforeDigest: before.digest, beforeMode: before.mode, mode: null, content: text }] }
    }
    if (request.purpose === 'code_review') { finalReview = true; throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' }) }
    return output
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(finalReview, true, JSON.stringify({ status: result.status, failure: result.failure, phase: result.operation.phase, generation: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).checkpointRefs.flatMap(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { candidateValidated?: boolean; status?: string; failure?: unknown; validationFindings?: unknown[] }; return value.candidateValidated !== undefined ? [{ status: value.status, failure: value.failure, validationFindings: value.validationFindings?.slice(0, 4) }] : [] }) : [], findings: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).checkpointRefs.flatMap(ref => { const value = JSON.parse(readEvidence(f.input.source.commonDir, ref).toString()) as { rounds?: { findings: { severity: string; code: string; message: string }[] }[] }; return value.rounds?.flatMap(round => round.findings.filter(finding => finding.severity === 'error').slice(0, 4)) ?? [] }) : [], calls: f.calls.map(call => call.purpose), attempt: result.operation.currentAttemptId ? f.store.readAttempt(result.operation.currentAttemptId).failure : null }))
  assert.ok(f.calls.some(call => call.purpose === 'implementation_plan'))
  assert.ok(result.operation.scope.paths.includes('src/planned-new.js'))
  assert.ok(result.operation.baselineSelection!.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === 'src/planned-new.js' && 'bytePair' in binding && binding.bytePair === null))
  assert.ok(result.operation.contractScopeExpansions!.some(expansion => expansion.paths?.includes('src/planned-new.js')))
  assert.equal(existsSync(join(f.root, 'src/planned-new.js')), false)
  assert.equal(f.store.listJournals(f.operation.id).length, 0)
})


test('v2有限修复复用已审分区分析/P1时，最低调用不再次索要已完成阶段预算', async t => {
  const f = await fixture(t, { maxAttempts: 2, maxCalls: 6, maxRepairs: 1, timeoutMs: 120000 }, false, original, 'project', original, { version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before: null, paths: ['src/export.js'] } }, undefined, 'code')
  let reviews = 0
  f.transform((output, request) => {
    if (request.purpose !== 'code_review') return output
    if (++reviews === 2) throw Object.assign(new Error('已证明第二次独审到达，在Docker前停止'), { code: 'unsupported' })
    const value = output as { verdict: string; findings: unknown[] }
    value.verdict = 'repair'; value.findings = [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#ExportService', evidence: '第一次独审具体核验未完成', counterexample: '需要重走下载分支', message: '保原已审Spec/代码字节并重查' }]
    return value
  })
  const result = await runSyncOperation(f.store, f.operation.id, f.options)
  assert.equal(reviews, 2, JSON.stringify(result.failure))
  assert.equal(result.operation.callsUsed, 6)
  assert.equal(f.calls.filter(call => call.purpose === 'code_behavior_analyze').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'elaboration_generate').length, 1)
  assert.equal(f.calls.filter(call => call.purpose === 'code_generate').length, 0)
})

test('v2无验证基线的提交删除把真实before正文作为source_before送入最终生成和独审', async t => {
  const f = await fixture(t, { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 })
  f.git('reset', '--hard', 'HEAD')
  const parentPath = join(f.root, '.spec/project/spec.md'), parent = readFileSync(parentPath, 'utf8')
  assert.ok(parent.includes('[[export-contract]]'))
  writeFileSync(parentPath, parent.replaceAll('[[export-contract]]', '导出契约'))
  f.git('add', '.spec/project/spec.md'); f.git('commit', '-m', 'isolate lifecycle fixture from parent navigation')
  const before = await captureInputSnapshot(f.root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const oldSpec = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === contractPath)!.oid).toString('utf8')
  const oldCode = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === 'src/export.js')!.oid).toString('utf8')
  const oldTest = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === 'tests/export.test.mjs')!.oid).toString('utf8')
  f.git('rm', contractPath)
  f.git('commit', '-m', 'remove exported specification')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const removed = readFileSync(join(f.root, 'src/export.js'))
  const contract = parseContract({ nodeId: 'export-contract', path: contractPath, source: original }).contract!
  const affectedIds = contract.items.map(item => item.id)
  const ruleIds = affectedIds.filter(id => /^(REQ|RULE|TR)-/.test(id))
  const rawSource = parseParts(original)?.rawSource
  assert.ok(rawSource)
  const plan: SyncCoordinatorPlan = { ...f.plan, version: 'sync-coordinator-v2', direction: 'spec_to_code', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 }, sourcePaths: ['src'], commitTrigger: { before, paths: [contractPath] }, targets: [{ nodeId: 'export-contract', path: contractPath, rawSource }] }
  const admitted = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, { ingressKey: snapshot.id, rootCauseId: snapshot.id, origin: 'combined', budget: { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120000 }, managedRoot: f.managedRoot }))
  f.useOperation(admitted)
  f.options.plan = plan
  f.options.readCurrentPlan = () => plan
  let sawGenerate = false, sawReview = false
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      assert.ok(context.changedPaths.includes(contractPath), JSON.stringify(context.changedPaths))
      return { changes: context.changedPaths.map(path => ({ kind: path === contractPath ? 'allowed_change' : 'refactor', paths: [path], affectedIds: path === contractPath ? affectedIds : ['RULE-EXPORT-05'], ruleIds, originalIntent: '导出契约由这次提交删除', previousBehavior: '提交前Spec保留完整义务', sourceBehavior: '当前提交不再包含该Spec', deliveryBehavior: '没有已验证交付', evidence: `真实树差 ${path}`, counterexample: '旧AC不能再从当前Spec读到' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: context.changedPaths.includes(contractPath) ? [{ path: contractPath, content: null, mode: null }] : [] }
    }
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { nodeChanges?: { action: string }[] }
      if (frozen.nodeChanges?.some(change => change.action === 'retire')) return { version: 'elaboration-rows-v2', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '旧节点已由真实提交删除并逐项退役，候选无剩余业务对象', affectedIds: [] })) }
    }
    if (request.purpose === 'code_generate' || request.purpose === 'code_review') {
      const frozen = promptInput(request)
      const prior = frozen.priorContext?.find(item => item.role === 'source_before')
      assert.ok(prior, request.purpose)
      assert.equal(prior.pairId, undefined)
      assert.equal(prior.snapshot.id, before.id)
      assert.equal(prior.snapshot.immutableTree, before.immutableTree)
      const bodies = new Map(prior.files)
      assert.equal(bodies.get(contractPath), oldSpec)
      assert.equal(bodies.get('src/export.js'), oldCode)
      assert.equal(bodies.get('tests/export.test.mjs'), oldTest)
      const currentEntry = prior.entries.find(entry => entry.path === contractPath)
      const actualEntry = beforeEntries.find(entry => entry.path === contractPath)!
      assert.equal(currentEntry?.mode, actualEntry.mode)
      assert.equal(currentEntry?.digest, actualEntry.digest)
      assert.equal(new Map(frozen.files).has(contractPath), false)
      assert.equal(frozen.priorContext!.some(item => item.role === 'verified_delivery'), false)
      assert.ok(request.prompt.includes('role为source_before时明确不是verifiedDelivery'))
      assert.ok(frozen.readyIds.includes('AC-EXPORT-03'))
      if (request.purpose === 'code_generate') { sawGenerate = true; return { version: 'sync-files-v1', changes: [] } }
      sawReview = true
      throw Object.assign(new Error('在真实Docker之前停止测试'), { code: 'unsupported' })
    }
    return output
  })
  const result = await runSyncOperation(f.store, admitted.id, f.options)
  const debugStage = f.store.listAttempts(admitted.id).flatMap(attempt => attempt.checkpointRefs).map(ref => JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString())).find(stage => stage.stage === 'elaboration')
  const debugElaboration = debugStage ? JSON.parse(readEvidence(snapshot.source.commonDir, debugStage.resultRef).toString()) : null
  assert.equal(sawGenerate, true, JSON.stringify({ elaboration: debugElaboration?.rounds?.map((round: { findings: unknown[] }) => round.findings), phase: result.status, failure: result.failure, attempts: f.store.listAttempts(admitted.id).map(attempt => ({ status: attempt.status, failure: attempt.failure })) }))
  assert.equal(sawReview, true, JSON.stringify(result.failure))
  assert.equal(result.failure?.code, 'unsupported')
  assert.equal(f.store.listJournals(admitted.id).length, 0)
  assert.equal(existsSync(join(f.root, contractPath)), false)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), removed)
})

test('协调器拒绝related glob命中超出全局readPaths的旧helper', async t => {
  const relatedSpec = original.replace('  - src/export.js#ExportService\n', '  - src/export.js#ExportService\nrelated:\n  - src/helpers/**/*.js\n')
  const budget = { maxAttempts: 1, maxCalls: 16, maxRepairs: 0, timeoutMs: 120_000 }
  const f = await fixture(t, budget, false, relatedSpec, 'project', relatedSpec)
  f.git('reset', '--hard', 'HEAD')
  const parentPath = join(f.root, '.spec/project/spec.md'), parent = readFileSync(parentPath, 'utf8')
  writeFileSync(parentPath, parent.replaceAll('[[export-contract]]', '导出契约'))
  const helperPath = 'src/helpers/format.js'
  mkdirSync(join(f.root, 'src/helpers'), { recursive: true })
  writeFileSync(join(f.root, helperPath), '// coordinator helper\nexport function format(value) { return String(value) }\n')
  f.git('add', '-A'); f.git('commit', '-m', 'isolate lifecycle fixture and add related helper')
  const before = await captureInputSnapshot(f.root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const oldSpec = readObject(before.source.commonDir, beforeEntries.find(entry => entry.path === contractPath)!.oid).toString('utf8')
  const contract = parseContract({ nodeId: 'export-contract', path: contractPath, source: oldSpec }).contract!
  f.git('rm', contractPath); f.git('commit', '-m', 'remove spec while retaining related helper')
  const snapshot = await captureInputSnapshot(f.root, { committed: true })
  const rawSource = parseParts(oldSpec)?.rawSource
  assert.ok(rawSource)
  const plan: SyncCoordinatorPlan = {
    ...f.plan,
    version: 'sync-coordinator-v2', direction: 'spec_to_code',
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524_288, maxParallel: 2 },
    readPaths: ['.spec', 'src/export.js', 'tests'], sourcePaths: ['src/export.js'],
    commitTrigger: { before, paths: [contractPath] },
    targets: [{ nodeId: 'export-contract', path: contractPath, rawSource }],
  }
  const admitted = f.store.admitAndEnqueue(await prepareSyncAdmission(snapshot, plan, {
    ingressKey: snapshot.id, rootCauseId: snapshot.id, origin: 'combined', budget, managedRoot: f.managedRoot,
  }))
  f.useOperation(admitted)
  f.options.plan = plan
  f.options.readCurrentPlan = () => plan
  const affectedIds = contract.items.map(item => item.id)
  const ruleIds = affectedIds.filter(id => /^(REQ|RULE|TR)-/.test(id))
  f.transform((output, request) => {
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[] }
      return {
        changes: context.changedPaths.map(path => ({ kind: path === contractPath ? 'allowed_change' : 'refactor', paths: [path], affectedIds: path === contractPath ? affectedIds : ['RULE-EXPORT-05'], ruleIds, originalIntent: '导出契约由这次提交删除', previousBehavior: '提交前Spec保留完整义务', sourceBehavior: '当前提交不再包含该Spec', deliveryBehavior: '没有已验证交付', evidence: `真实树差 ${path}`, counterexample: '旧AC不能再从当前Spec读到' })),
        facts: [], acceptanceChanges: [], newNodes: [],
        resolutions: context.changedPaths.includes(contractPath) ? [{ path: contractPath, content: null, mode: null }] : [],
      }
    }
    if (request.purpose === 'elaboration_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { nodeChanges?: { action: string }[] }
      if (frozen.nodeChanges?.some(change => change.action === 'retire')) return { version: 'elaboration-rows-v2', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '旧节点已由真实提交删除并逐项退役，候选无剩余业务对象', affectedIds: [] })) }
    }
    return output
  })
  const result = await runSyncOperation(f.store, admitted.id, f.options)
  assert.equal(result.failure?.code, 'historical_context_binding', JSON.stringify({ status: result.status, failure: result.failure, calls: f.calls.map(call => call.purpose) }))
  assert.ok(f.calls.some(call => call.purpose === 'elaboration_generate'))
  assert.equal(f.calls.some(call => call.purpose === 'code_generate' || call.purpose === 'code_review'), false)
})
