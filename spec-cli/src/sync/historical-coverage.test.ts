import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { parseContract, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractFinding } from '@spexcode/spec-core/contracts'
import { SyncApplication } from './application.js'
import { freezeCandidate, verifyCandidate } from './candidate.js'
import { composeInputSnapshots } from './composition.js'
import { candidateContext, syncPlanDigest } from './coordinator.js'
import { analyzeCodeBehavior } from './code-behavior.js'
import { freezeHistoricalCoverage, historicalCoverageCheck } from './historical-coverage.js'
import { elaborate, sealPartitionedElaboration } from './elaboration.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { elaborateSyncPartitions } from './partition-execution.js'
import { planSyncPartitions } from './partitioning.js'
import { retainHistoricalFrozenWorkflow } from './historical-workflow.test-helpers.js'
import { readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { deliverVerifiedAttempt } from './private-delivery.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, verifySnapshot, writeEvidence } from './snapshot.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationResult } from './elaboration-types.js'
import type { InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import type { SyncSettings } from './settings.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { ElaborationSessionRequest } from './elaboration-types.js'
import type { VerificationResult } from './verification-executor-types.js'

// 初始化四层报告是受控前置；Git/SQLite/采纳/规划/V1真实执行，后续Docker只由专用用例证明。
const rootSpec = '.spec/project/spec.md'
const oldSpec = '.spec/project/export/export-contract/spec.md'
const nextSpec = '.spec/project/other/other-contract/spec.md'
const dependencySpec = '.spec/project/dependency/dependency-contract/spec.md'
const unexecutedId = 'RULE-EXPORT-99'

const filesOf = (snapshot: InputSnapshot): Map<string, string> => new Map(verifySnapshot(snapshot)
  .filter(entry => entry.mode !== '120000')
  .map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))

async function fixture(t: test.TestContext, missingOldAcceptance = true, reportIds?: string[] | null, options: { owners?: number; multipleUnexecuted?: boolean; image?: string; parent?: string; preserve?: boolean } = {}) {
  const parent = options.parent ?? realpathSync(mkdtempSync(join(tmpdir(), 'spex-historical-coverage-')))
  const root = join(parent, 'source'), runtime = join(parent, 'trusted'), appRoot = join(parent, 'application')
  for (const path of [oldSpec, nextSpec, dependencySpec, 'src/export.js', 'tests/export.test.mjs', 'support/stable.txt']) mkdirSync(join(root, path, '..'), { recursive: true })
  const originalRoot = fileURLToPath(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url))
  const original = readFileSync(join(originalRoot, '.spec/export/export-contract/spec.md'), 'utf8')
  const originalCode = readFileSync(join(originalRoot, 'src/export.js'), 'utf8')
  const originalTests = readFileSync(join(originalRoot, 'tests/export.test.mjs'), 'utf8')
  const rule = '| RULE-EXPORT-99 | 列表序列化 | 返回输入列表的JSON字符串 | 当前源码事实，尚无对应测试 | export-contract | code:src/export.js#serializeTasks | REQ-EXPORT-01,REQ-DEPENDENCY-01 |\n'
  let old = original.replace('\n\n### FLOW', `\n${rule}\n### FLOW`).replace('code:\n', 'related:\n  - support/\ncode:\n')
  let oldTests = originalTests
  if (!missingOldAcceptance) {
    const ac = '| AC-EXPORT-99 | RULE-EXPORT-99 | 输入任务列表 | 序列化列表 | 返回精确JSON字符串 | tests/export.test.mjs#AC-EXPORT-99 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |\n'
    old = old.replace('\n\n### VERIFY', `\n${ac}\n### VERIFY`)
    oldTests = oldTests.replace("import { ExportService }", "import { ExportService, serializeTasks }") + "\ntest('AC-EXPORT-99 serializes tasks', () => assert.equal(serializeTasks([1]), '[1]'));\n"
  }
  const other = original.replaceAll('EXPORT', 'OTHER').replaceAll('export-contract', 'other-contract').replaceAll('export-job', 'other-job').replaceAll('export.js', 'other.js').replaceAll('export.test.mjs', 'other.test.mjs')
  const dependency = original.replaceAll('EXPORT', 'DEPENDENCY').replaceAll('export-contract', 'dependency-contract').replaceAll('export-job', 'dependency-job').replaceAll('export.js', 'dependency.js').replaceAll('export.test.mjs', 'dependency.test.mjs')
  const specs = new Map([[oldSpec, old], [nextSpec, other], [dependencySpec, dependency]])
  const unexecutedIds = new Set(missingOldAcceptance ? [unexecutedId] : [])
  for (let index = specs.size; index < (options.owners ?? 3); index++) {
    const domain = `cost${String(index).padStart(2, '0')}`, path = `.spec/project/${domain}/${domain}-contract/spec.md`
    mkdirSync(join(root, path, '..'), { recursive: true })
    specs.set(path, original.replaceAll('EXPORT', domain.toUpperCase()).replaceAll('export-contract', `${domain}-contract`).replaceAll('export-job', `${domain}-job`).replaceAll('export.js', `${domain}.js`).replaceAll('export.test.mjs', `${domain}.test.mjs`))
    writeFileSync(join(root, `src/${domain}.js`), originalCode)
    writeFileSync(join(root, `tests/${domain}.test.mjs`), originalTests.replaceAll('EXPORT', domain.toUpperCase()).replaceAll('export.js', `${domain}.js`))
  }
  if (options.multipleUnexecuted) for (const [path, source] of specs) {
    if (path === nextSpec) continue
    const owner = path.split('/').at(-2)!, contract = parseContract({ nodeId: owner, path, source }).contract!
    const requirement = contract.items.find(item => item.kind === 'REQ')!.id, domain = requirement.split('-')[1]
    const rows = Array.from({ length: path === oldSpec ? 1 : 2 }, (_, index) => {
      const id = `RULE-${domain}-HISTORY-${String(index + 1).padStart(2, '0')}`
      unexecutedIds.add(id)
      return `| ${id} | 导出结果 | 完成结果只发布一次 | 已明确记录尚未执行的既有义务 | ${owner} | code:${contract.code[0].split('#')[0]}#ExportService | ${requirement} |`
    })
    specs.set(path, source.replace('\n\n### FLOW', `\n${rows.join('\n')}\n\n### FLOW`))
  }
  writeFileSync(join(root, rootSpec), '---\ntitle: 独立业务初始化\nstatus: active\n---\n## raw source\n两个独立业务保持已审契约，后续按实际源码变化局部同步。\n')
  for (const [path, source] of specs) writeFileSync(join(root, path), source)
  writeFileSync(join(root, 'src/export.js'), `${originalCode}\nexport const serializeTasks = tasks => JSON.stringify(tasks);\n`)
  writeFileSync(join(root, 'src/other.js'), originalCode)
  writeFileSync(join(root, 'src/dependency.js'), originalCode)
  writeFileSync(join(root, 'tests/export.test.mjs'), oldTests)
  writeFileSync(join(root, 'tests/other.test.mjs'), originalTests.replaceAll('EXPORT', 'OTHER').replaceAll('export.js', 'other.js'))
  writeFileSync(join(root, 'tests/dependency.test.mjs'), originalTests.replaceAll('EXPORT', 'DEPENDENCY').replaceAll('export.js', 'dependency.js'))
  writeFileSync(join(root, 'support/stable.txt'), '原相关文件\n')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const settings: SyncSettings = {
    version: 'sync-settings-v1', nodeIds: ['project'], sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['package.json'], facts: [],
    budget: { mode: 'unlimited' },
    verifications: [...specs].map(([path, source]) => {
      const verify = parseContract({ nodeId: path.split('/').at(-2)!, path, source }).contract!.items.find(item => item.kind === 'VERIFY')!
      assert.equal(verify.kind, 'VERIFY')
      return { definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: { version: 'v1', image: options.image ?? `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }
    }),
    mandatoryTests: [{ verificationId: 'VERIFY-EXPORT-01', testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }, { verificationId: 'VERIFY-OTHER-01', testPath: 'tests/other.test.mjs', testId: 'AC-OTHER-03' }],
  }
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sync: settings }))
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'PR5 isolated fixture'); git('config', 'user.email', 'pr5@example.invalid'); git('add', '.'); git('commit', '-qm', 'author input with independent obligations')
  mkdirSync(join(runtime, 'dist/sync'), { recursive: true }); mkdirSync(join(runtime, 'templates/hooks'), { recursive: true })
  const hooks = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
  for (const name of readdirSync(hooks)) {
    copyFileSync(join(hooks, name), join(runtime, 'templates/hooks', name)); copyFileSync(join(hooks, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  copyFileSync(fileURLToPath(new URL('../../dist/sync/trusted-footprint.js', import.meta.url)), join(runtime, 'dist/sync/trusted-footprint.js'))
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  writeFileSync(join(runtime, 'dist/cli.js'), "if(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n")
  const tools = { trustedRuntimeRoot: runtime, toolEntry: join(runtime, 'dist/cli.js'), canonicalHooksDir: join(runtime, 'templates/hooks'), gitPath: '/usr/bin/git' }
  const protocol = openProtocol(join(parent, 'sessions.sqlite'))
  const application = await SyncApplication.create(root, { protocol, runtimeDirectory: appRoot, tools })
  t.after(async () => {
    await application.stopService(); protocol.close()
    if (options.preserve) return
    const directories = [parent]
    for (const directory of directories) {
      chmodSync(directory, 0o700)
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) directories.push(join(directory, entry.name))
    }
    rmSync(parent, { recursive: true, force: true })
  })
  const dispatches: string[] = []
  application.start = id => { dispatches.push(id) }
  await application.enable()
  const queued = (await application.submit({ nodeId: 'project', requestId: 'explicit-coverage-initial', origin: 'initial', committed: true, recordUnverifiedCoverage: true })).operation!
  assert.equal(queued.recordUnverifiedCoverage, true)
  const initialPlan = application['operationPlan'](queued)
  assert.equal(initialPlan.version, 'sync-coordinator-v2'); assert.equal(initialPlan.direction, 'code_to_spec')
  const operation = application.store.ackDispatch(queued.input.source.repositoryId, queued.dispatchMessageId)
  const claim = application.store.claimQueuedAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 120000, expectedRevision: operation.revision })
  const composed = composeInputSnapshots(operation.input, operation.baselineSelection).composed!
  application.store.bindComposedInput(claim.fence, composed); application.store.startGeneration(claim.fence)
  const resourceRef = writeEvidence(operation.input.source.commonDir, { fixture: '从未创建外部进程的受控资源，正式terminal/removed前置' })
  let resource = application.store.planResource(claim.fence, { key: 'historical-resource', kind: 'native_session', inputId: operation.input.id, candidateDigest: null, payloadDigest: resourceRef.sha256, planBlob: resourceRef, checkpointRef: resourceRef })
  for (const phase of ['terminal', 'removed'] as const) resource = application.store.recordResourceCheckpoint(resource.id, { operationId: operation.id, attemptId: claim.attempt.id, inputId: operation.input.id, candidateDigest: null, phase, expectedCheckpointRef: resource.checkpointRef, checkpointRef: writeEvidence(operation.input.source.commonDir, { phase, neverCreated: true }) })
  const entries = verifySnapshot(operation.input)
  const candidate = freezeCandidate(operation.input, { version: 'sync-files-v1', changes: [rootSpec, ...specs.keys()].map(path => {
    const entry = entries.find(item => item.path === path)!
    return { path, beforeDigest: entry.digest, beforeMode: entry.mode, content: readObject(operation.input.source.commonDir, entry.oid).toString('utf8') + '\n初始化规格独审前置夹具。\n' }
  }) }, operation.scope, composed)
  const initialFrozen = await readFrozenContracts(root, new Map(verifyCandidate(operation.input.source.commonDir, candidate).map(entry => [entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8')])), new Set(entries.map(entry => entry.path)), id => unexecutedIds.has(id))
  assert.deepEqual(initialFrozen.findings.filter(issue => issue.severity === 'error'), [], '受控前置必须先通过真实完整结构检查')
  const warnings = initialFrozen.findings.filter(issue => issue.code === 'acceptance-not-executed')
  assert.deepEqual(warnings.map(issue => issue.itemId).sort(), [...unexecutedIds].sort())
  const elaboration: Pick<ElaborationResult, 'rounds'> = { rounds: [{ index: 1, output: null, candidate: null, candidateDigest: candidate.digest, findings: warnings, reviewOutput: null, review: null, traces: [] }] }
  assert.deepEqual((await candidateContext(application.store, operation, candidate, elaboration)).findings.filter(issue => issue.severity === 'error'), [])
  application.store.freezeCandidate(claim.fence, candidate)
  const prerequisite = writeEvidence(operation.input.source.commonDir, { fixture: '受控V1-V4前置；真实执行Git、SQLite、采纳、局部计划和V1，不执行Native/Docker或声称产品全通过' })
  const bindings = { inputId: operation.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, baselineSelectionDigest: operation.baselineSelection!.digest, environmentDigest: 'controlled-fixture', contextDigest: 'controlled-fixture' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.scope, ...(reportIds === null ? {} : { unexecutedContractIds: reportIds ?? warnings.map(issue => issue.itemId!) }), layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [prerequisite] })) }
  const reportRef = writeEvidence(operation.input.source.commonDir, result)
  application.store.recordVerification(claim.fence, { ...bindings, passed: true, coveredScope: operation.scope, evidenceRefs: [prerequisite], resultBlob: reportRef })
  const delivered = await deliverVerifiedAttempt(application.store, claim.fence, { managedRoot: join(appRoot, 'managed'), tools, beforeApply: () => {} })
  const journal = application.store.listJournals(operation.id)[0]
  assert.equal(journal.status, 'settled')
  assert.deepEqual(journal.plan.files.map(file => file.path).sort(), [rootSpec, ...specs.keys()].sort())
  const adopted = await application.adopt(operation.id)
  assert.equal(adopted.sourceSynced, true); assert.equal(adopted.canonicalSynced, true)
  assert.deepEqual(adopted.unexecutedContractIds, result.unexecutedContractIds ?? [])
  assert.equal(git('rev-parse', 'HEAD'), delivered.receipt.actualCommit)
  const before = await captureInputSnapshot(root, { committed: true })
  const heads = application.store.readBaselineSelection(before.source, application.store.listBaselineResources(before.source)); assert.ok('selection' in heads)
  assert.equal(heads.selection.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === 'src/export.js'), false, '只读初始化不能制造代码byte head')
  return { parent, root, git, application, protocol, operation: delivered.operation, reportRef, report: result, journal, before, dispatches, settings, resource, tools, unexecutedIds, ownerPaths: [...specs.keys()] }
}

async function independentCommit(f: Awaited<ReturnType<typeof fixture>>) {
  f.application['ownsObservation'] = () => true
  await f.application['scanObservedInput']()
  assert.equal(f.application.store.listOperations(f.before.source.repositoryId).length, 1, '先消费采纳收据，不产生回声')
  f.git('switch', '-c', 'author-increment')
  writeFileSync(join(f.root, 'src/other.js'), readFileSync(join(f.root, 'src/other.js'), 'utf8') + '\n// independent formatting-only change\n')
  f.git('add', 'src/other.js'); f.git('commit', '-qm', 'independent external code commit')
  f.git('switch', 'main'); f.git('merge', '--ff-only', 'author-increment')
  await f.application['scanObservedInput']()
  const next = f.application.store.listOperations(f.before.source.repositoryId).find(operation => operation.id !== f.operation.id)!
  assert.ok(next, JSON.stringify(f.application.observationStatus().latest))
  const plan = f.application['operationPlan'](next)
  assert.deepEqual(plan.targets.map(target => target.nodeId), ['other-contract'])
  assert.equal(plan.readPaths.includes(oldSpec), false)
  assert.equal(next.scope.contractIds.includes(unexecutedId), false)
  assert.equal(next.origin, 'code'); assert.equal(next.recordUnverifiedCoverage, undefined)
  const composed = composeInputSnapshots(next.input, next.baselineSelection, { executionPaths: next.scope.paths, contextPaths: plan.readPaths }).composed!
  const candidate = freezeCandidate(next.input, { version: 'sync-files-v1', changes: [] }, next.scope, composed)
  const fullFiles = filesOf(next.input), global = await readFrozenContracts(f.root, fullFiles)
  const targets = plan.targets.map(target => ({ ...target, source: fullFiles.get(target.path)!, sourceDigest: contentHash(fullFiles.get(target.path)!) }))
  const sealInput: ElaborationInput = {
    root: f.root, base: next.input.headCommit, requestKey: 'historical-coverage-seal',
    intent: { nodeId: 'project', rawSource: parseParts(fullFiles.get(rootSpec)!)!.rawSource }, targets,
    context: global.nodes.filter(node => !targets.some(target => target.path === node.path)).map(node => ({ nodeId: node.id, path: node.path, source: fullFiles.get(node.path)! })),
    files: fullFiles, verifications: plan.verifications.map(item => item.definition), contextVerifications: plan.contextVerifications,
    ...(plan.historicalCoverage ? { historicalCoverageDigest: plan.historicalCoverage.digest } : {}),
    implementationWritePaths: [], readonlyTestPaths: plan.mandatoryTests.map(item => item.testPath), mode: 'preserve_business', maxCalls: 2, maxRepairs: 0,
  }
  const changes = targets.map(target => ({ nodeId: target.nodeId, path: target.path, beforeDigest: target.sourceDigest, source: target.source }))
  const applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '保留已审原契约，只验证精确历史覆盖资格', affectedIds: [] }))
  return { ...f, next, plan, composed, candidate, fullFiles, sealInput, changes, applicability }
}

for (const missingOldAcceptance of [true, false]) test(`历史已采纳未执行覆盖保留为warning且不扩本次范围 missing=${missingOldAcceptance}`, { timeout: 180000 }, async t => {
  const f = await independentCommit(await fixture(t, missingOldAcceptance)), proof = f.plan.historicalCoverage
  assert.equal(Boolean(proof), missingOldAcceptance)
  if (proof) {
    assert.deepEqual(Object.keys(proof).sort(), ['digest', 'inputId', 'proofs', 'version'])
    assert.equal(proof.inputId, f.next.input.id); assert.equal(proof.proofs.length, 1)
    assert.deepEqual(Object.keys(proof.proofs[0]).sort(), ['contractIds', 'pairId', 'receiptId', 'verificationRef'])
    assert.deepEqual(proof.proofs[0].contractIds, [unexecutedId])
    assert.deepEqual(proof.proofs[0].verificationRef, f.reportRef)
    assert.equal(proof.proofs[0].receiptId, f.journal.receipt!.id)
  }
  assert.deepEqual(f.plan.verifications.map(item => item.definition.id), ['VERIFY-OTHER-01'])
  assert.deepEqual(f.plan.mandatoryTests.map(item => item.testId), ['AC-OTHER-03'])
  const frozen = await candidateContext(f.application.store, f.next, f.candidate)
  assert.deepEqual(frozen.findings.filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(frozen.findings.filter(issue => issue.code === 'acceptance-not-executed').map(issue => issue.itemId), missingOldAcceptance ? [unexecutedId] : [])
  const historical = proof ? historicalCoverageCheck(f.application.store, f.next.input, f.next.scope, proof, readTree(f.next.input.source.commonDir, f.composed.tree)) : undefined
  const sealed = sealPartitionedElaboration(f.sealInput, f.changes, f.applicability, [], new Map(), historical)
  assert.deepEqual(sealed.seal.findings.filter(issue => issue.severity === 'error'), [])
  assert.equal(sealed.seal.passed, true)
  if (proof) {
    const scopedFiles = new Map([...f.fullFiles].filter(([path]) => f.plan.readPaths.some(root => path === root || path.startsWith(`${root}/`))))
    const scoped = await readFrozenContracts(f.root, scopedFiles)
    const partitions = planSyncPartitions({ plan: f.plan, files: scopedFiles, contracts: scoped.contracts, nodes: scoped.nodes, changedPaths: ['src/other.js'] })
    let calls = 0, coldSeals = 0
    const partitioned = await elaborateSyncPartitions({ ...f.sealInput, context: f.sealInput.context?.filter(item => scopedFiles.has(item.path)), files: scopedFiles, historyInput: f.next.input }, partitions, 1, {
      load: () => null, save: (_key, value) => writeEvidence(f.next.input.source.commonDir, value),
      historicalCoverage: digest => { assert.equal(digest, proof.digest); coldSeals++; return historical! },
    }, async request => {
      calls++
      assert.equal(request.prompt.includes('historicalCoverage'), false); assert.equal(request.prompt.includes('contextVerifications'), false)
      const output = request.purpose === 'elaboration_generate'
        ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '本区保持完整已审业务契约', affectedIds: ['REQ-OTHER-01'] })) }
        : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { sessionId: `historical-partition-${calls}`, threadId: `historical-partition-${calls}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    }, f.composed)
    assert.equal(partitioned.structurePassed, true, JSON.stringify(partitioned.partitionSeal?.findings))
    assert.equal(partitioned.reviewPassed, true); assert.equal(partitioned.partitionSeal?.passed, true)
    assert.equal(calls, 2); assert.equal(coldSeals, 1)
    assert.deepEqual(partitioned.changes.map(change => change.path), [nextSpec])
    assert.ok(partitioned.partitionSeal?.findings.some(issue => issue.code === 'acceptance-not-executed' && issue.itemId === unexecutedId))
  }
  for (const path of [oldSpec, dependencySpec, 'src/export.js', 'src/dependency.js', 'tests/export.test.mjs', 'tests/dependency.test.mjs', 'support/stable.txt']) {
    assert.deepEqual(verifyCandidate(f.next.input.source.commonDir, f.candidate).find(entry => entry.path === path), verifySnapshot(f.before).find(entry => entry.path === path), path)
  }
  assert.deepEqual(f.application.store.listJournals(f.operation.id), [f.journal])
  assert.deepEqual(JSON.parse(readEvidence(f.next.input.source.commonDir, f.reportRef).toString('utf8')), f.report)
  assert.equal(f.application.store.readOperation(f.next.id).currentAttemptId, null, '该证明不启动模型、V3或声称新执行过历史验收')
  t.diagnostic(JSON.stringify({ historicalWarningIds: frozen.findings.filter(issue => issue.code === 'acceptance-not-executed').map(issue => issue.itemId), currentVerificationIds: f.plan.verifications.map(item => item.definition.id), currentMandatoryIds: f.plan.mandatoryTests.map(item => item.testId), sealPassed: sealed.seal.passed }))
})

test('历史覆盖冷验不读取live heads，旧计划缺席与当前scope保持严格，P0/P1不泄漏程序授信', { timeout: 180000 }, async t => {
  const f = await independentCommit(await fixture(t)), store = f.application.store, proof = f.plan.historicalCoverage!
  const beforePlan = readEvidence(f.next.input.source.commonDir, f.next.planBlob!), beforeOperation = store.readOperation(f.next.id)
  const readHeads = store.readBaselineSelection.bind(store), listHeads = store.listBaselineResources.bind(store)
  store.readBaselineSelection = () => assert.fail('冻结后不得读取live heads')
  store.listBaselineResources = () => assert.fail('冻结后不得枚举live heads')
  assert.deepEqual((await candidateContext(store, f.next, f.candidate)).findings.filter(issue => issue.severity === 'error'), [])
  store.readBaselineSelection = readHeads; store.listBaselineResources = listHeads
  const selection = store.readBaselineSelection(f.next.input.source, store.listBaselineResources(f.next.input.source)); assert.ok('selection' in selection)
  for (const scope of [{ ...f.next.scope, contractIds: [...f.next.scope.contractIds, unexecutedId] }, { ...f.next.scope, paths: [...f.next.scope.paths, oldSpec] }]) {
    assert.equal(await freezeHistoricalCoverage(store, f.next.input, scope, selection.selection), undefined)
    const context = await candidateContext(store, { ...f.next, scope }, f.candidate)
    assert.ok(context.findings.some(issue => issue.code === 'missing-acceptance' && issue.itemId === unexecutedId))
  }
  const { historicalCoverage: _proof, ...legacyPlan } = f.plan
  const legacy = { ...f.next, planBlob: writeEvidence(f.next.input.source.commonDir, legacyPlan), policyDigest: syncPlanDigest(legacyPlan) }
  assert.ok((await candidateContext(store, legacy, f.candidate)).findings.some(issue => issue.code === 'missing-acceptance' && issue.itemId === unexecutedId))
  assert.throws(() => sealPartitionedElaboration(f.sealInput, f.changes, f.applicability), /缺少可信原件核验/)
  assert.throws(() => historicalCoverageCheck(store, f.next.input, f.next.scope, { ...proof, digest: '0'.repeat(64) }, verifySnapshot(f.next.input)), { code: 'historical_coverage_binding' })
  await assert.rejects(candidateContext(store, { ...f.next, policyDigest: 'different-plan' }, f.candidate), { code: 'policy_binding' })
  let p0 = 0
  const p1Prompts: string[] = []
  await assert.rejects(analyzeCodeBehavior({ snapshot: f.next.input, baseline: null, baselineSelection: f.next.baselineSelection, composed: f.composed, readSetDigest: f.next.readSetDigest, policyDigest: f.next.policyDigest, plan: f.plan, requestKey: 'historical-coverage-prompt', timeoutMs: 10000 }, async request => {
    p0++; assert.equal(request.prompt.includes('historicalCoverage'), false); assert.equal(request.prompt.includes(proof.digest), false)
    throw new Error('历史覆盖P0提示检查到此停止')
  }), /历史覆盖P0提示检查到此停止/)
  await elaborate(f.sealInput, { runner: async request => {
    p1Prompts.push(request.prompt)
    throw new Error('历史覆盖P1提示检查到此停止')
  } })
  assert.equal(p0, 1); assert.equal(p1Prompts.length, 1)
  assert.equal(p1Prompts[0].includes('historicalCoverage'), false); assert.equal(p1Prompts[0].includes(proof.digest), false)
  assert.deepEqual(readEvidence(f.next.input.source.commonDir, f.next.planBlob!), beforePlan)
  assert.deepEqual(store.readOperation(f.next.id), beforeOperation)
})

test('历史覆盖只承接原ID，owner、源码、测试、跨owner依赖、mode与absence变化均恢复严格门', { timeout: 180000 }, async t => {
  const f = await independentCommit(await fixture(t)), store = f.application.store
  const entries = verifySnapshot(f.next.input), commonDir = f.next.input.source.commonDir
  const mutations = [
    { label: 'owner业务改变', path: oldSpec, content: f.fullFiles.get(oldSpec)!.replace('返回输入列表的JSON字符串', '返回排序后的JSON字符串') },
    { label: 'owner来源改变', path: oldSpec, content: f.fullFiles.get(oldSpec)!.replace('code:src/export.js#serializeTasks', 'code:src/export.js#ExportService') },
    { label: 'owner纯正文改变', path: oldSpec, content: f.fullFiles.get(oldSpec)! + '\n新的解释正文。\n' },
    { label: '源码字节改变', path: 'src/export.js', content: f.fullFiles.get('src/export.js')! + '\n// source changed\n' },
    { label: '源码mode改变', path: 'src/export.js', content: f.fullFiles.get('src/export.js')!, mode: '100755' as const },
    { label: '测试改变', path: 'tests/export.test.mjs', content: f.fullFiles.get('tests/export.test.mjs')! + '\n// test changed\n' },
    { label: '跨owner依赖源码改变', path: 'src/dependency.js', content: f.fullFiles.get('src/dependency.js')! + '\n// dependency changed\n' },
    { label: '跨owner依赖Spec改变', path: dependencySpec, content: f.fullFiles.get(dependencySpec)! + '\n依赖声明更新。\n' },
    { label: '相关目录新增原缺席路径', path: 'support/new.txt', content: 'new obligation\n' },
    { label: '相关文件删除', path: 'support/stable.txt', content: null },
  ]
  for (const mutation of mutations) await t.test(mutation.label, async () => {
    const before = entries.find(entry => entry.path === mutation.path)
    const candidate = freezeCandidate(f.next.input, { version: 'sync-files-v1', changes: [{ path: mutation.path, content: mutation.content, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, mode: mutation.mode }] }, { ...f.next.scope, paths: [...f.next.scope.paths, mutation.path] }, f.composed)
    const frozen = await candidateContext(store, f.next, candidate)
    assert.ok(frozen.findings.some(issue => issue.code === 'missing-acceptance' && issue.itemId === unexecutedId), JSON.stringify(frozen.findings))
    assert.equal(frozen.findings.some(issue => issue.code === 'acceptance-not-executed' && issue.itemId === unexecutedId), false)
  })
  const newId = 'RULE-OTHER-99', other = f.fullFiles.get(nextSpec)!
  const added = other.replace('\n\n### FLOW', `\n| ${newId} | 当前新增义务 | 新义务必须有当前验收 | 新增业务 | other-contract | user:raw | REQ-OTHER-01 |\n\n### FLOW`)
  const before = entries.find(entry => entry.path === nextSpec)!
  const candidate = freezeCandidate(f.next.input, { version: 'sync-files-v1', changes: [{ path: nextSpec, content: added, beforeDigest: before.digest, beforeMode: before.mode }] }, f.next.scope, f.composed)
  const context = await candidateContext(store, f.next, candidate)
  assert.ok(context.findings.some(issue => issue.code === 'missing-acceptance' && issue.itemId === newId))
  assert.ok(context.findings.some(issue => issue.code === 'acceptance-not-executed' && issue.itemId === unexecutedId))
  const badFiles = new Map(f.fullFiles)
  badFiles.set(nextSpec, other.replace('STEP-OTHER-01,STEP-OTHER-02', 'STEP-UNKNOWN-01,STEP-OTHER-02'))
  const bad = await readFrozenContracts(f.root, badFiles, undefined, undefined, historicalCoverageCheck(store, f.next.input, f.next.scope, f.plan.historicalCoverage!, readTree(commonDir, f.composed.tree)))
  assert.ok(bad.findings.some(issue => issue.severity === 'error' && issue.code !== 'missing-acceptance'), JSON.stringify(bad.findings))
  assert.ok(bad.findings.some(issue => issue.code === 'acceptance-not-executed' && issue.itemId === unexecutedId))
  assert.deepEqual(store.listJournals(f.operation.id), [f.journal])
  assert.deepEqual(JSON.parse(readEvidence(commonDir, f.reportRef).toString('utf8')), f.report)
})

test('历史覆盖缺原授信、报告ID、精确来源或真实采纳均不获资格；坏原件明确拒绝', { timeout: 180000 }, async t => {
  const f = await independentCommit(await fixture(t)), store = f.application.store, commonDir = f.next.input.source.commonDir
  const proof = f.plan.historicalCoverage!, record = proof.proofs[0], pair = store.readBaselinePair(record.pairId)
  const originalOperation = store.readOperation(f.operation.id), originalAttempt = store.readAttempt(f.journal.attemptId)
  const selection = store.readBaselineSelection(f.next.input.source, store.listBaselineResources(f.next.input.source)); assert.ok('selection' in selection)
  const check = () => candidateContext(store, f.next, f.candidate)
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_operations SET record_json=? WHERE id=?', JSON.stringify({ ...originalOperation, recordUnverifiedCoverage: undefined }), f.operation.id))
  assert.equal(await freezeHistoricalCoverage(store, f.next.input, f.next.scope, selection.selection), undefined)
  await assert.rejects(check(), { code: 'historical_coverage_binding' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_operations SET record_json=? WHERE id=?', JSON.stringify(originalOperation), f.operation.id))
  const noIds = writeEvidence(commonDir, { ...f.report, unexecutedContractIds: [] })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify({ ...originalAttempt, verification: { ...originalAttempt.verification, resultBlob: noIds } }), originalAttempt.id))
  await assert.rejects(check(), { code: 'sync_adoption_plan_invalid' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_attempts SET record_json=? WHERE id=?', JSON.stringify(originalAttempt), originalAttempt.id))
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_baseline_pairs SET record_json=? WHERE id=?', JSON.stringify({ ...pair, source: { ...pair.source, branch: 'refs/heads/foreign' } }), pair.id))
  await assert.rejects(check(), { code: 'historical_coverage_binding' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_baseline_pairs SET record_json=? WHERE id=?', JSON.stringify(pair), pair.id))
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET phase=?,record_json=? WHERE id=?', 'created', JSON.stringify({ ...f.resource, phase: 'created' }), f.resource.id))
  await assert.rejects(check(), { code: 'historical_coverage_binding' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_resources SET phase=?,record_json=? WHERE id=?', 'removed', JSON.stringify(f.resource), f.resource.id))
  f.git('switch', '-c', 'unadopted-source', originalOperation.input.headCommit)
  f.git('restore', `--source=${f.next.input.headCommit}`, '--staged', '--worktree', '.')
  f.git('commit', '-qm', 'same tree without adopting the receipt')
  f.git('branch', '-f', 'main', 'HEAD')
  f.git('switch', 'main')
  const unadopted = await captureInputSnapshot(f.root, { committed: true })
  assert.equal(unadopted.immutableTree, f.next.input.immutableTree); assert.deepEqual(unadopted.source, f.next.input.source)
  assert.throws(() => f.git('merge-base', '--is-ancestor', f.journal.receipt!.actualCommit!, unadopted.headCommit))
  assert.equal(await freezeHistoricalCoverage(store, unadopted, f.next.scope, selection.selection), undefined, '源码相同但正式receipt不在冻结HEAD祖先链仍不授信')
  f.git('switch', 'unadopted-source'); f.git('branch', '-f', 'main', f.next.input.headCommit); f.git('switch', 'main')
  const wrongRef = { ...proof, proofs: [{ ...record, verificationRef: writeEvidence(commonDir, { unrelated: true }) }] }
  assert.throws(() => historicalCoverageCheck(store, f.next.input, f.next.scope, wrongRef, verifySnapshot(f.next.input)), { code: 'historical_coverage_binding' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_apply_journals SET record_json=? WHERE id=?', JSON.stringify({ ...f.journal, receipt: { ...f.journal.receipt, actualCommit: originalOperation.input.headCommit } }), f.journal.id))
  await assert.rejects(check(), { code: 'sync_adoption_receipt_invalid' })
  f.protocol.withTransaction(tx => tx.exec('UPDATE sync_apply_journals SET record_json=? WHERE id=?', JSON.stringify(f.journal), f.journal.id))
  assert.deepEqual((await check()).findings.filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(store.readOperation(f.operation.id), originalOperation)
  assert.deepEqual(store.readAttempt(originalAttempt.id), originalAttempt)
  assert.deepEqual(store.readBaselinePair(pair.id), pair)
})

for (const ids of [[], null]) test(`已结算报告未列明历史ID时不能从当前缺口或旧标志推断授信 ids=${JSON.stringify(ids)}`, { timeout: 180000 }, async t => {
  if (ids === null) {
    await assert.rejects(fixture(t, true, null), { code: 'SYNC_VERIFICATION_BINDING' })
    return
  }
  const f = await independentCommit(await fixture(t, true, ids))
  assert.equal(f.plan.historicalCoverage, undefined)
  const frozen = await candidateContext(f.application.store, f.next, f.candidate)
  assert.ok(frozen.findings.some(issue => issue.code === 'missing-acceptance' && issue.itemId === unexecutedId))
  assert.equal(frozen.findings.some(issue => issue.code === 'acceptance-not-executed'), false)
})

test('历史覆盖相同owner增加旧ID不重复读取原件，55-owner同树计数可冷重放', { timeout: 600000 }, async t => {
  const profileRoot = process.env.SPEX_HISTORICAL_COVERAGE_PROFILE
  type Profile = { root: string; parent: string; operationId: string; ownerPaths: string[]; tools: Awaited<ReturnType<typeof fixture>>['tools']; input?: InputSnapshot }
  let application: SyncApplication, profile: Profile
  if (profileRoot && existsSync(join(profileRoot, 'sessions.sqlite'))) {
    const root = join(profileRoot, 'source'), runtime = join(profileRoot, 'trusted'), protocol = openProtocol(join(profileRoot, 'sessions.sqlite'))
    const tools = { trustedRuntimeRoot: runtime, toolEntry: join(runtime, 'dist/cli.js'), canonicalHooksDir: join(runtime, 'templates/hooks'), gitPath: '/usr/bin/git' }
    application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(profileRoot, 'application'), tools })
    t.after(async () => { await application.stopService(); protocol.close() })
    if (existsSync(join(profileRoot, 'fixture.json'))) profile = JSON.parse(readFileSync(join(profileRoot, 'fixture.json'), 'utf8')) as Profile
    else {
      const input = await captureInputSnapshot(root, { committed: true })
      const operation = application.store.findOperationByIngressKey(`application:${input.source.repositoryId}:${root}:explicit-coverage-initial`)!
      assert.equal(operation.phase, 'workspace_synced')
      execFileSync('/usr/bin/git', ['-C', root, 'merge-base', '--is-ancestor', application.store.listJournals(operation.id).at(-1)!.receipt!.actualCommit!, input.headCommit], { stdio: 'pipe' })
      profile = { root, parent: profileRoot, operationId: operation.id, ownerPaths: verifySnapshot(input).filter(entry => entry.path.endsWith('/spec.md') && entry.path !== rootSpec).map(entry => entry.path), tools, input }
      writeFileSync(join(profileRoot, 'fixture.json'), JSON.stringify(profile))
    }
  } else {
    if (profileRoot) mkdirSync(profileRoot, { recursive: true })
    const f = await fixture(t, true, undefined, { owners: profileRoot ? 55 : 3, multipleUnexecuted: true, ...(profileRoot ? { parent: profileRoot, preserve: true } : {}) })
    application = f.application
    profile = { root: f.root, parent: f.parent, operationId: f.operation.id, ownerPaths: f.ownerPaths, tools: f.tools, input: f.before }
    if (profileRoot) writeFileSync(join(profileRoot, 'fixture.json'), JSON.stringify(profile))
  }
  const store = application.store, operation = store.readOperation(profile.operationId), input = profile.input!
  const report = JSON.parse(readEvidence(input.source.commonDir, store.readAttempt(operation.currentAttemptId!).verification!.resultBlob).toString('utf8')) as VerificationResultBlob
  const files = filesOf(input), frozen = await readFrozenContracts(profile.root, files)
  const selected = frozen.contracts.find(contract => contract.path === nextSpec)!
  const scope: SyncScope = { paths: [nextSpec], contractIds: selected.items.filter(item => !['FLOW', 'VERIFY'].includes(item.kind)).map(item => item.id), flowIds: selected.items.filter(item => item.kind === 'FLOW').map(item => item.id) }
  const oldIds = report.unexecutedContractIds!, onePerOwner = new Map<string, string>()
  for (const id of oldIds) { const path = frozen.graph.items.get(id)!.path; if (!onePerOwner.has(path)) onePerOwner.set(path, id) }
  assert.equal(oldIds.length, onePerOwner.size * 2)
  assert.equal(profile.ownerPaths.length, profileRoot ? 55 : 3)
  const full = store.readBaselineSelection(input.source, oldIds.map(id => ({ kind: 'contract' as const, id }))); assert.ok('selection' in full)
  const one = store.readBaselineSelection(input.source, [...onePerOwner.values()].map(id => ({ kind: 'contract' as const, id }))); assert.ok('selection' in one)
  const entries = verifySnapshot(input), inventory = new Set(entries.map(entry => entry.path))
  const ownerOids = new Set(entries.filter(entry => onePerOwner.has(entry.path)).map(entry => entry.oid))
  const modes = ['freeze-one', 'freeze-all', 'candidate-one', 'candidate-all'] as const
  const counts = Object.fromEntries(modes.map(mode => [mode, { gitProcesses: 0, ownerBlobReads: 0, pairReads: 0 }])) as Record<typeof modes[number], { gitProcesses: number; ownerBlobReads: number; pairReads: number }>
  const proofs = new Map<string, NonNullable<SyncCoordinatorPlan['historicalCoverage']>>()
  const findings = new Map<string, unknown>()
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'), execute = cp.execFileSync, readPair = store.readBaselinePair.bind(store)
  let mode: typeof modes[number] = 'freeze-one'
  cp.execFileSync = ((...args: Parameters<typeof execFileSync>) => {
    if (args[0] === 'git') {
      counts[mode].gitProcesses++
      const command = args[1] as string[]
      if (command.includes('cat-file') && command.includes('blob') && ownerOids.has(command.at(-1)!)) counts[mode].ownerBlobReads++
    }
    return Reflect.apply(execute, cp, args)
  }) as typeof execFileSync
  syncBuiltinESMExports()
  store.readBaselinePair = id => { counts[mode].pairReads++; return readPair(id) }
  const previousPhase = process.env.SPEX_HISTORICAL_COVERAGE_PROFILE_PHASE
  try {
    for (mode of modes) {
      if (profileRoot) process.env.SPEX_HISTORICAL_COVERAGE_PROFILE_PHASE = mode
      const shape = mode.endsWith('all') ? 'all' : 'one'
      if (mode.startsWith('freeze')) proofs.set(shape, (await freezeHistoricalCoverage(store, input, scope, shape === 'all' ? full.selection : one.selection))!)
      else {
        const checked = await readFrozenContracts(profile.root, files, inventory, undefined, historicalCoverageCheck(store, input, scope, proofs.get(shape)!, entries))
        findings.set(shape, checked.findings)
        assert.deepEqual(checked.findings.filter(issue => issue.code === 'acceptance-not-executed').map(issue => issue.itemId).sort(), (shape === 'all' ? oldIds : [...onePerOwner.values()]).sort())
      }
    }
  } finally {
    cp.execFileSync = execute; syncBuiltinESMExports(); store.readBaselinePair = readPair
    if (previousPhase === undefined) delete process.env.SPEX_HISTORICAL_COVERAGE_PROFILE_PHASE; else process.env.SPEX_HISTORICAL_COVERAGE_PROFILE_PHASE = previousPhase
  }
  const result = { inputId: input.id, inputTree: input.immutableTree, owners: profile.ownerPaths.length, historicalOwners: onePerOwner.size, historicalIds: oldIds.length, counts, proofs: Object.fromEntries(proofs), findings: Object.fromEntries(findings) }
  if (profileRoot) writeFileSync(join(profileRoot, `${process.env.SPEX_HISTORICAL_COVERAGE_PROFILE_LABEL ?? 'latest'}.json`), JSON.stringify(result, null, 2))
  t.diagnostic(JSON.stringify({ owners: result.owners, historicalIds: result.historicalIds, counts }))
  assert.deepEqual(proofs.get('all')!.proofs.flatMap(proof => proof.contractIds).sort(), [...oldIds].sort())
  assert.equal(counts['freeze-all'].pairReads, counts['freeze-one'].pairReads)
  assert.equal(counts['candidate-all'].pairReads, counts['candidate-one'].pairReads)
  assert.equal(counts['freeze-all'].ownerBlobReads, counts['freeze-one'].ownerBlobReads, '同owner新增旧ID不应重读/解析原owner')
  assert.equal(counts['candidate-all'].ownerBlobReads, counts['candidate-one'].ownerBlobReads, '完整候选不应按ID重复原件读取')
})

test('真实应用与Docker新receipt不传播历史未执行覆盖，原pair、heads与旧报告保持', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const initial = await fixture(t, true, undefined, { image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392' })
  retainHistoricalFrozenWorkflow(initial.application)
  const f = await independentCommit(initial), store = f.application.store, commonDir = f.next.input.source.commonDir
  const proof = f.plan.historicalCoverage!.proofs[0], pair = store.readBaselinePair(proof.pairId)
  const resources = [{ kind: 'contract' as const, id: unexecutedId }, ...[oldSpec, 'src/export.js', 'tests/export.test.mjs'].map(path => ({ kind: 'path' as const, path }))]
  const heads = store.readBaselineSelection(f.next.input.source, resources); assert.ok('selection' in heads)
  const calls: ElaborationSessionRequest[] = []
  f.application['options'].runner = async request => {
    calls.push(request)
    assert.equal(request.prompt.includes('historicalCoverage'), false)
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
      assert.deepEqual(frozen.changedPaths, ['src/other.js'])
      output = { changes: frozen.changedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [], ruleIds: [], originalIntent: '原导出业务和验收保持', previousBehavior: '原完整导出行为', sourceBehavior: '仅增加固定作者注释', deliveryBehavior: '原已审业务保持', evidence: `实际冻结 ${path} 只增加注释`, counterexample: '原权限、幂等、状态和结果断言继续执行' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
      const analyzed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: { changes: { id: string }[] } }
      output = { inputDigest: request.inputDigest, analysisDigest: analyzed.analysisDigest, verdict: 'accept', checkedPaths: frozen.changedPaths, checkedChangeIds: analyzed.analysis.changes.map(item => item.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') output = { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '沿用本区已审原业务，历史义务不授新跳测权', affectedIds: ['REQ-OTHER-01'] })) }
    else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_review') {
      const frozen = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { readyIds: string[] }
      const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as { inputId: string; candidate: { digest: string } }
      assert.equal(frozen.readyIds.includes(unexecutedId), false)
      output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: frozen.readyIds, findings: [] }
    } else assert.fail(`只读写回不应派发 ${request.purpose}`)
    const operation = store.readOperation(f.next.id), dispatch = store.readAttempt(operation.currentAttemptId!).dispatchPlans.find(plan => plan.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `historical-joint-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  f.application.start = SyncApplication.prototype.start.bind(f.application)
  f.application.start(f.next.id)
  const delivered = await f.application.wait(f.next.id)
  assert.ok(['workspace_synced', 'canonical_synced'].includes(delivered.operation.phase), JSON.stringify({ phase: delivered.operation.phase, failure: delivered.attempt?.failure }))
  const nextReport = JSON.parse(readEvidence(commonDir, delivered.attempt!.verification!.resultBlob).toString('utf8')) as VerificationResultBlob
  assert.equal(nextReport.unexecutedContractIds, undefined)
  assert.equal(nextReport.coveredScope.contractIds.includes(unexecutedId), false)
  const newReceipt = delivered.journals.at(-1)!.receipt!
  assert.notEqual(newReceipt.id, f.journal.receipt!.id)
  const v3 = nextReport.layers.find(layer => layer.layer === 'V3')!.evidenceRefs.map(ref => JSON.parse(readEvidence(commonDir, ref).toString('utf8')) as VerificationResult)
  assert.equal(v3.length, 1)
  assert.ok(v3[0].evidence!.tests.length > 0)
  assert.ok(v3[0].evidence!.tests.every(item => item.status === 'passed' && item.testId.startsWith('AC-OTHER-')))
  const adopted = await f.application.adopt(f.next.id)
  assert.equal(adopted.sourceSynced, true); assert.equal(adopted.canonicalSynced, true)
  assert.deepEqual(store.readBaselineSelection(f.next.input.source, resources), heads)
  assert.deepEqual(store.readBaselinePair(pair.id), pair)
  assert.deepEqual(store.listJournals(f.operation.id), [f.journal])
  assert.deepEqual(JSON.parse(readEvidence(commonDir, f.reportRef).toString('utf8')), f.report)
  assert.deepEqual((await f.application.readOperation(f.operation.id)).unexecutedContractIds, f.report.unexecutedContractIds)
  assert.deepEqual(adopted.unexecutedContractIds ?? [], [])
  const v1 = JSON.parse(readEvidence(commonDir, nextReport.layers.find(layer => layer.layer === 'V1')!.evidenceRefs[0]).toString('utf8')) as { findings: ContractFinding[] }
  const p1 = JSON.parse(readEvidence(commonDir, delivered.attempt!.verification!.evidenceRefs[0]).toString('utf8')) as Pick<ElaborationResult, 'partitionSeal'>
  const warning = v1.findings.find(finding => finding.code === 'acceptance-not-executed' && finding.itemId === unexecutedId)!
  t.diagnostic(JSON.stringify({ originalReceipt: f.journal.receipt!.id, newReceipt: newReceipt.id, originalPair: pair.id, originalHeadsUnchanged: true, originalUnexecutedIds: f.report.unexecutedContractIds, currentUnexecutedIds: nextReport.unexecutedContractIds ?? null, currentTests: v3[0].evidence!.tests.map(item => item.testId), historicalWarning: warning, calls: calls.map(request => request.purpose) }))
  assert.ok(warning, '正式V1必须保留精确历史未执行warning')
  assert.equal(warning.severity, 'warning'); assert.match(warning.message, /历史上未执行/)
  assert.ok(p1.partitionSeal!.findings.some(finding => finding.code === 'acceptance-not-executed' && finding.itemId === unexecutedId && finding.message.includes('历史上未执行')))
})
