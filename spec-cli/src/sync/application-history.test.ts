import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyComponentMigrations, openProtocol } from '@spexcode/session-protocol'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { SyncApplication } from './application.js'
import { SYNC_COMPONENT, SYNC_MIGRATIONS, migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { composeAuthoredInput } from './author-input.js'
import { freezeCandidate } from './candidate.js'
import { deliverVerifiedAttempt } from './private-delivery.js'
import { captureInputSnapshot, contentHash, identifyWorktree, readObject, readTree, writeEvidence } from './snapshot.js'
import { prepareSyncAdmission } from './coordinator.js'
import { prepareHistoryRequest, readHistoryRequest, readReceiptHistoryRestorations } from './history-input.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ContractCell, GeneratedTables } from './elaboration-markdown.js'
import type { VerificationResultBlob } from './operation-types.js'
import type { SyncSettings } from './settings.js'
import { sessionIdForCreateKey } from '../sessions.js'

async function fixture(t: test.TestContext, mode: 'content' | 'move' | 'retire' = 'content') {
  const moveNode = mode === 'move', retireNode = mode === 'retire'
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sync-application-history-'))), root = join(temp, 'source')
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  renameSync(join(root, '.spec/export'), join(root, '.spec/project')); renameSync(join(root, 'tests'), join(root, 'generated-tests'))
  const path = '.spec/project/export-contract/spec.md', original = readFileSync(join(root, path), 'utf8').replaceAll('tests/export.test.mjs', 'generated-tests/export.test.mjs')
  writeFileSync(join(root, path), original)
  const childPath = '.spec/project/export-contract/summary-child/spec.md', childSource = `---
title: 导出计数
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循 [[export-contract]] 的导出反馈需求。

## expanded spec

适用域为成功行数组；计数是无状态同步读取，权限及外部副作用由上层导出流程处理，本辅助不派发状态事件。

### REQ

| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-SUMMARY-01 | 返回行数 | user:raw | 遵循导出反馈 | 返回rows.length | REQ-EXPORT-01 |

### FLOW

| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FLOW-SUMMARY-01 | REQ-SUMMARY-01 | 所有者 | 读取导出计数 | 已取得成功行数组 | STEP-SUMMARY-01 | END | derived:REQ-SUMMARY-01 | REQ-SUMMARY-01 |

### STEP

| id | flow | action | input | output | rules | next | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-SUMMARY-01 | FLOW-SUMMARY-01 | 读取计数 | 成功行数组 | 返回rows.length后结束 | RULE-SUMMARY-01 | END | derived:FLOW-SUMMARY-01 | RULE-SUMMARY-01 |

### RULE

| id | scope | constraint | basis | authority | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- |
| RULE-SUMMARY-01 | FLOW-SUMMARY-01,STEP-SUMMARY-01 | 输入域为成功行数组；空数组返回0，只读length且不写入，不产生异步或外部副作用 | 原成功行数组只读计数需求 | summary-child | derived:REQ-SUMMARY-01 | REQ-SUMMARY-01 |

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-SUMMARY-01,STEP-SUMMARY-01,RULE-SUMMARY-01 | 成功行数组 | 读取计数 | 返回rows.length、空数组0且输入不变 | generated-tests/export.test.mjs#AC-SUMMARY-01 | VERIFY-SUMMARY-01 | derived:REQ-SUMMARY-01 | REQ-SUMMARY-01 |

### VERIFY

| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-SUMMARY-01 | ["node","--test","generated-tests/export.test.mjs"] | . | 10000 |
`
  const retiredIds = ['summary-child', 'REQ-SUMMARY-01', 'FLOW-SUMMARY-01', 'STEP-SUMMARY-01', 'RULE-SUMMARY-01', 'AC-SUMMARY-01', 'VERIFY-SUMMARY-01']
  if (retireNode) {
    mkdirSync(join(root, childPath, '..'), { recursive: true }); writeFileSync(join(root, childPath), childSource)
    writeFileSync(join(root, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n')
    writeFileSync(join(root, 'generated-tests/export.test.mjs'), readFileSync(join(root, 'generated-tests/export.test.mjs'), 'utf8') + "\nimport { resultCount } from '../src/summary.js';\ntest('AC-SUMMARY-01 返回结果行数', () => { const rows = ['a', 'b']; assert.equal(resultCount(rows), 2); assert.equal(resultCount([]), 0); assert.deepEqual(rows, ['a', 'b']); });\n")
  }
  const contract = parseContract({ nodeId: 'export-contract', path, source: original }).contract!, verify = contract.items.find(item => item.kind === 'VERIFY')!
  assert.equal(verify.kind, 'VERIFY')
  const settings: SyncSettings = { version: 'sync-settings-v1', nodeIds: ['export-contract'], sourcePaths: ['src'], testPaths: ['generated-tests'], readPaths: ['package.json'], facts: [{ source: 'decision:EXPORT-POLICY', text: original }], mandatoryTests: [], budget: { maxAttempts: 3, maxCalls: 16, maxRepairs: 2, timeoutMs: 300000 }, verifications: [{ definition: { id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: { version: 'test-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', memoryBytes: 128 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 128 * 1024 } }] }
  if (retireNode) settings.verifications.push({ definition: { id: 'VERIFY-SUMMARY-01', command: [...verify.command], cwd: verify.cwd, timeoutMs: verify.timeoutMs }, environment: settings.verifications[0].environment })
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [], sync: settings }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'History application'); git('config', 'user.email', 'history@example.invalid'); git('add', '.'); git('commit', '-m', 'base')
  if (retireNode) {
    const snapshot = await captureInputSnapshot(root), files = new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).filter(entry => entry.mode !== '120000').map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const checked = await readFrozenContracts(root, files)
    assert.deepEqual(checked.findings.filter(issue => issue.severity === 'error'), [], '历史child种子必须先通过现有完整结构、引用、流程、映射与验收检查')
  }
  git('switch', '-c', 'node/source')
  execFileSync(process.execPath, [fileURLToPath(new URL('../../dist/cli.js', import.meta.url)), 'init', '.', '--harness', 'none'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
  git('add', '.'); git('commit', '-m', 'adopt')
  const protocol = openProtocol(join(temp, 'canonical.sqlite')), calls: string[] = []
  let application: SyncApplication
  application = await SyncApplication.create(root, { protocol, runtimeDirectory: join(temp, 'runtime'), runner: async request => {
    calls.push(request.purpose)
    const operation = application.store.listOperations(identifyWorktree(root).repositoryId).find(operation => operation.currentAttemptId && application.store.readAttempt(operation.currentAttemptId).dispatchPlans.some(dispatch => dispatch.key === request.requestKey))!
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const context = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { changedPaths: string[]; compositionEvidence: { conflicts: { path: string }[] } | null }
      output = { changes: context.changedPaths.map(path => ({ kind: context.compositionEvidence?.conflicts.some(conflict => conflict.path === path) ? 'conflict' : 'allowed_change', paths: [path], affectedIds: ['REQ-EXPORT-01'], ruleIds: ['REQ-EXPORT-01'], originalIntent: '按用户明确请求撤销标记交付，保留实际导出业务', previousBehavior: '完整导出业务及feature注释', sourceBehavior: '撤销本次原意和代码测试标记，后续注释保留', deliveryBehavior: '已采纳真实feature交付', evidence: `固定成组补偿和当前文件 ${path}`, counterexample: '后续注释仍在，导出状态及权限测试保持' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else if (request.purpose === 'code_behavior_review') {
      const value = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: { changes: { id: string; paths: string[] }[] } }
      output = { inputDigest: request.inputDigest, analysisDigest: value.analysisDigest, verdict: 'accept', checkedPaths: [...new Set(value.analysis.changes.flatMap(change => change.paths))], checkedChangeIds: value.analysis.changes.map(change => change.id), findings: [] }
    } else if (request.purpose === 'elaboration_generate') {
      const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
        const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
        return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]]
      })))])) as GeneratedTables
      const changes = [{ nodeId: 'export-contract', path, title: String(parseFrontmatter(original).fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(original)!.expandedSpec.split(/^### /m)[0], tables, removeIds: [] as string[] }]
      if (retireNode) {
        const child = parseContract({ nodeId: 'summary-child', path: childPath, source: childSource }).contract!
        const childTables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, child.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
          const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
          return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]]
        })))])) as GeneratedTables
        changes.push({ nodeId: 'summary-child', path: childPath, title: '导出计数', description: '', code: child.code, related: child.related, prose: parseParts(childSource)!.expandedSpec.split(/^### /m)[0], tables: childTables, removeIds: [] })
      }
      output = { version: 'elaboration-rows-v2', changes, applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定既有业务政策', affectedIds: ['REQ-EXPORT-01'] })) }
    } else if (request.purpose === 'elaboration_review') output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    else if (request.purpose === 'code_generate') {
      const frozen = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as { elaboratedSpecs: { path: string; source: string }[]; manifest: { entries: { path: string; digest: string; mode: string }[] } }
      output = { version: 'sync-files-v1', changes: frozen.elaboratedSpecs.map(spec => { const before = frozen.manifest.entries.find(entry => entry.path === spec.path); return { path: spec.path, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content: spec.source, mode: null } }) }
    } else {
      const frozen = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { readyIds: string[] }
      const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n实际完整候选')[0]) as { inputId: string; candidate: { digest: string } }
      output = { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: frozen.readyIds, findings: [] }
    }
    const dispatch = application.store.readAttempt(operation.currentAttemptId!).dispatchPlans.find(dispatch => dispatch.key === request.requestKey)!
    return { sessionId: sessionIdForCreateKey(dispatch.sessionCreateKey), threadId: `history-${request.requestKey}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  t.after(async () => {
    await application.stopService()
    const evidenceRoot = process.env.SPEX_VERIFICATION_EVIDENCE_DIR
    if (evidenceRoot) {
      const directory = join(evidenceRoot, `history-${contentHash(temp).slice(0, 12)}`), identity = identifyWorktree(root)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const operations = application.store.listOperations(identity.repositoryId, { sourceRoot: identity.canonicalRoot })
      writeFileSync(join(directory, 'state.json'), JSON.stringify({ test: t.name, source: identity, calls, operations: operations.map(operation => ({ operation, attempts: application.store.listAttempts(operation.id), journals: application.store.listJournals(operation.id) })) }, null, 2))
      await protocol.backupTo(join(directory, 'canonical.sqlite'))
      cpSync(join(root, '.git'), join(directory, 'git'), { recursive: true })
    }
    protocol.close()
    const unlock = (directory: string): void => { if (!existsSync(directory)) return; chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name)) }
    unlock(temp); rmSync(temp, { recursive: true, force: true })
  })
  await application.enable()
  const start = application.start.bind(application); application.start = () => {}
  const movedPath = '.spec/archive/export-contract/spec.md'
  let operation
  if (moveNode || retireNode) {
    const snapshot = await captureInputSnapshot(root), frozen = await application['freezeNodePlan'](snapshot, 'export-contract')
    if (moveNode) {
      frozen.plan.writePaths = [...frozen.plan.writePaths, movedPath]; frozen.plan.readPaths = [...frozen.plan.readPaths, movedPath]
      frozen.plan.executionScope = { ...frozen.plan.executionScope!, paths: [...frozen.plan.executionScope!.paths, movedPath].sort() }
    } else frozen.plan.executionScope = { ...frozen.plan.executionScope!, contractIds: [...frozen.plan.executionScope!.contractIds, 'summary-child', 'VERIFY-SUMMARY-01'].sort() }
    const selected = application.store.readBaselineSelection(snapshot.source, [...frozen.selection.bindings.map(binding => binding.resource), ...(moveNode ? [{ kind: 'path' as const, path: movedPath }] : [{ kind: 'contract' as const, id: 'summary-child' }, { kind: 'contract' as const, id: 'VERIFY-SUMMARY-01' }])]); assert.ok('selection' in selected)
    const admission = await prepareSyncAdmission(snapshot, frozen.plan, { ingressKey: 'seed-explicit-node-migration', rootCauseId: 'seed-explicit-node-migration', origin: 'combined', budget: settings.budget, managedRoot: application['managedRoot'], baselineSelection: selected.selection })
    application['prepareTools'](admission.ingressKey, null)
    operation = application.store.admitAndEnqueue(admission)
  } else operation = (await application.submit({ nodeId: 'export-contract', requestId: 'seed-completed-feature' })).operation!
  application.start = start
  const store = application.store, plan = application['operationPlan'](operation), ack = store.ackDispatch(operation.input.source.repositoryId, operation.dispatchMessageId)
  const claimed = store.claimQueuedAttempt({ operationId: operation.id, source: operation.input.source, scope: operation.scope, leaseMs: 300000, expectedRevision: ack.revision })
  const composed = composeAuthoredInput(operation.input, operation.baselineSelection, { executionPaths: operation.scope.paths, contextPaths: plan.readPaths }).composed!
  store.bindComposedInput(claimed.fence, composed); store.startGeneration(claimed.fence)
  const files = new Map(readTree(operation.input.source.commonDir, composed.tree).map(entry => [entry.path, entry]))
  const candidate = freezeCandidate(operation.input, { version: 'sync-files-v1', changes: [...(retireNode ? [childPath, 'src/summary.js'] : [path, ...(moveNode ? [movedPath] : []), 'src/export.js']), 'generated-tests/export.test.mjs'].map(file => {
    const before = files.get(file), text = readObject(operation.input.source.commonDir, (before ?? files.get(path)!).oid).toString('utf8')
    const content = retireNode ? file === 'generated-tests/export.test.mjs' ? text.replace("import { resultCount } from '../src/summary.js';\ntest('AC-SUMMARY-01 返回结果行数', () => { const rows = ['a', 'b']; assert.equal(resultCount(rows), 2); assert.equal(resultCount([]), 0); assert.deepEqual(rows, ['a', 'b']); });", "import { existsSync } from 'node:fs';\ntest('AC-SUMMARY-01 退役后不再发布计数模块', () => assert.equal(existsSync(new URL('../src/summary.js', import.meta.url)), false));") : null : moveNode && file === path ? null : file === path || file === movedPath ? text.replace('此输入是固定业务验收夹具', 'FEATURE-MARK 此输入是固定业务验收夹具') : `// FEATURE-MARK\n${text}`
    return { path: file, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content, ...(content === null ? { mode: null } : {}) }
  }) }, operation.scope, composed)
  store.freezeCandidate(claimed.fence, candidate)
  const evidence = writeEvidence(operation.input.source.commonDir, { fixture: '原已落地交付的明确受控前置；不是模型或完整产品验收证明' }), bindings = { inputId: operation.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, baselineSelectionDigest: operation.baselineSelection!.digest, environmentDigest: 'seed-fixture', contextDigest: 'seed-fixture' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.scope, ...(retireNode ? { retiredIds } : {}), layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
  store.recordVerification(claimed.fence, { ...bindings, passed: true, coveredScope: operation.scope, evidenceRefs: [evidence], resultBlob: writeEvidence(operation.input.source.commonDir, result) })
  const delivered = await deliverVerifiedAttempt(store, claimed.fence, { managedRoot: application['managedRoot'], tools: application['executionInputs'](operation).tools, beforeApply: async () => {} })
  git('merge', '--ff-only', operation.deliveryPlan.branch)
  git('switch', 'main'); git('merge', '--ff-only', 'node/source'); await application.enable()
  return { root, temp, git, application, protocol, original: delivered.operation, calls, path, movedPath, contract, childPath, childSource, retiredIds }
}

test('AC-SYNC-24 正式revert入口经同一协调器、真实Docker与新提交保留后续编辑', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await fixture(t), feature = f.application.store.listJournals(f.original.id).at(-1)!.receipt!.actualCommit!
  assert.equal((await f.application.readOperation(f.original.id)).canonicalSynced, true)
  f.git('switch', '-c', 'node/later')
  writeFileSync(join(f.root, 'src/export.js'), readFileSync(join(f.root, 'src/export.js'), 'utf8') + '\n// LATER-HUMAN-EDIT\n'); writeFileSync(join(f.root, 'unrelated.txt'), 'unrelated\n'); f.git('add', '.'); f.git('commit', '-m', 'later human work')
  f.git('switch', 'main'); f.git('merge', '--ff-only', 'node/later')
  const head = f.git('rev-parse', 'HEAD'), index = readFileSync(join(f.root, '.git/index'))
  const stale = await f.application.readOperation(f.original.id)
  assert.equal(stale.sourceSynced, false); assert.equal(stale.stale, true); assert.equal(stale.revertEligibility.eligible, true)
  const submitted = await f.application.revert({ operationId: f.original.id, requestId: 'revert-feature' }); assert.ok(submitted.operation)
  const request = readHistoryRequest(submitted.operation.input, submitted.operation.requestBlob!)
  assert.deepEqual(request.conflicts, []); assert.deepEqual(request.changes.map(change => change.path), [f.path, 'generated-tests/export.test.mjs', 'src/export.js'])
  const delivered = await f.application.wait(submitted.operation.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify(delivered.attempt?.failure))
  const receipt = delivered.journals.at(-1)!.receipt!
  assert.ok(receipt.actualCommit); assert.notEqual(receipt.actualCommit, feature)
  f.git('merge-base', '--is-ancestor', head, receipt.actualCommit!)
  const code = readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'src/export.js'), 'utf8')
  assert.match(code, /LATER-HUMAN-EDIT/); assert.doesNotMatch(code, /FEATURE-MARK/)
  assert.doesNotMatch(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, f.path), 'utf8'), /FEATURE-MARK/)
  assert.doesNotMatch(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'generated-tests/export.test.mjs'), 'utf8'), /FEATURE-MARK/)
  assert.equal(readFileSync(join(delivered.operation.deliveryPlan.canonicalRoot, 'unrelated.txt'), 'utf8'), 'unrelated\n')
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal((await f.application.revert({ operationId: f.original.id, requestId: 'revert-feature' })).operation?.id, submitted.operation.id)
  const alias = await f.application.revert({ operationId: f.original.id, requestId: 'same-revert-another-transport' })
  assert.equal(alias.operation?.id, submitted.operation.id)
  assert.equal(alias.operation?.callsUsed, delivered.operation.callsUsed)
  assert.equal(f.application.store.listJournals(submitted.operation.id).length, 1)
  assert.ok(f.calls.includes('code_behavior_analyze') && f.calls.includes('elaboration_generate') && f.calls.includes('code_generate'))
})

test('AC-SYNC-24 真正Git重叠进入同一业务冲突，无补偿提交且不覆盖人类编辑', { timeout: 180000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'src/export.js')
  writeFileSync(path, readFileSync(path, 'utf8').replace('// FEATURE-MARK', '// CURRENT-HUMAN-CHOICE'))
  const head = f.git('rev-parse', 'HEAD'), index = readFileSync(join(f.root, '.git/index')), current = readFileSync(path)
  const submitted = await f.application.revert({ operationId: f.original.id, requestId: 'overlapping-revert' }); assert.ok(submitted.operation)
  const request = readHistoryRequest(submitted.operation.input, submitted.operation.requestBlob!)
  assert.deepEqual(request.conflicts, ['src/export.js'])
  const result = await f.application.wait(submitted.operation.id)
  assert.equal(result.operation.phase, 'conflicted', JSON.stringify(result.attempt?.failure))
  assert.ok(result.decisionContext?.analysis.findings.some(finding => finding.kind === 'conflict'))
  assert.deepEqual(result.journals, []); assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.deepEqual(readFileSync(path), current); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
})

test('AC-SYNC-24 正式revert恢复历史Spec精确路径，真实rename保持节点与全部业务ID', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await fixture(t, 'move'), before = await captureInputSnapshot(f.root)
  assert.equal(existsSync(join(f.root, f.path)), false); assert.equal(existsSync(join(f.root, f.movedPath)), true)
  const current = await f.application['freezeNodePlan'](before, 'export-contract')
  assert.equal(current.plan.writePaths.some(path => f.path === path || f.path.startsWith(`${path}/`)), false)
  const submitted = await f.application.revert({ operationId: f.original.id, requestId: 'restore-node-path' }); assert.ok(submitted.operation)
  const delivered = await f.application.wait(submitted.operation.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify(delivered.attempt?.failure))
  const root = delivered.operation.deliveryPlan.canonicalRoot
  assert.equal(existsSync(join(root, f.movedPath)), false)
  const source = readFileSync(join(root, f.path), 'utf8'), contract = parseContract({ nodeId: 'export-contract', path: f.path, source }).contract!
  assert.deepEqual(contract.items.map(item => item.id).sort(), f.contract.items.map(item => item.id).sort())
  assert.equal(contract.nodeId, 'export-contract'); assert.equal((await captureInputSnapshot(f.root)).id, before.id)
  const plan = f.application['operationPlan'](delivered.operation)
  assert.ok(plan.writePaths.includes(f.path)); assert.equal(plan.writePaths.includes('.spec/project'), false)
  assert.deepEqual(plan.writePaths.filter(path => path === 'src' || path === 'generated-tests'), current.plan.writePaths.filter(path => path === 'src' || path === 'generated-tests'))
})

test('AC-SYNC-24 正式revert恢复同一已退役对象的Spec代码测试与原身份', { skip: process.env.SPEX_DOCKER_VERIFICATION_TEST !== '1', timeout: 600000 }, async t => {
  const f = await fixture(t, 'retire')
  f.git('switch', 'node/source'); await f.application.enable()
  const snapshot = await captureInputSnapshot(f.root), frozen = await f.application['freezeNodePlan'](snapshot, 'export-contract')
  assert.ok(frozen.plan.retiredIds?.includes('REQ-SUMMARY-01')); assert.ok(frozen.plan.retiredIds?.includes('AC-SUMMARY-01'))
  assert.equal(existsSync(join(f.root, f.childPath)), false); assert.equal(existsSync(join(f.root, 'src/summary.js')), false)
  const journals = f.application.store.listJournals(f.original.id), receipt = journals.at(-1)!.receipt!
  const identity = { requestId: 'verify-exact-restore-authority', operationId: f.original.id, nodeId: 'export-contract', receiptId: receipt.id, featureCommit: receipt.actualCommit! }
  const valid = prepareHistoryRequest(snapshot, identity)
  assert.deepEqual(readReceiptHistoryRestorations(snapshot, valid, f.original, journals).map(item => item.id).sort(), f.retiredIds.slice().sort())
  const wrongReceipt = prepareHistoryRequest(snapshot, { ...identity, receiptId: 'another-receipt' })
  assert.throws(() => readReceiptHistoryRestorations(snapshot, wrongReceipt, f.original, journals), /SYNC_RESTORE_BINDING/)
  const wrongOperation = prepareHistoryRequest(snapshot, { ...identity, operationId: 'another-operation' })
  assert.throws(() => readReceiptHistoryRestorations(snapshot, wrongOperation, f.original, journals), /SYNC_RESTORE_BINDING/)
  const submitted = await f.application.revert({ operationId: f.original.id, requestId: 'restore-retired-same-identity' }); assert.ok(submitted.operation)
  const request = readHistoryRequest(submitted.operation.input, submitted.operation.requestBlob!)
  assert.deepEqual(request.changes.map(change => change.path), [f.childPath, 'generated-tests/export.test.mjs', 'src/summary.js'])
  const delivered = await f.application.wait(submitted.operation.id)
  assert.equal(delivered.operation.phase, 'workspace_synced', JSON.stringify(delivered.attempt?.failure))
  const root = delivered.operation.deliveryPlan.canonicalRoot, source = readFileSync(join(root, f.childPath), 'utf8')
  const restored = parseContract({ nodeId: 'summary-child', path: f.childPath, source }).contract!
  assert.deepEqual(restored.items.map(item => item.id).sort(), f.retiredIds.filter(id => id !== 'summary-child').sort())
  assert.deepEqual(restored.code, ['src/summary.js#resultCount'])
  assert.equal(readFileSync(join(root, 'src/summary.js'), 'utf8'), 'export const resultCount = rows => rows.length;\n')
  assert.match(readFileSync(join(root, 'generated-tests/export.test.mjs'), 'utf8'), /AC-SUMMARY-01 返回结果行数/)
  const retiredPair = submitted.operation.baselineSelection!.bindings.find(binding => 'intentPair' in binding && binding.resource.id === 'AC-SUMMARY-01')!
  assert.ok('intentPair' in retiredPair && retiredPair.intentPair?.retiredIds?.includes('AC-SUMMARY-01'))
  const nodeHead = submitted.operation.baselineSelection!.bindings.find(binding => 'intentPair' in binding && binding.resource.id === 'summary-child')!
  assert.ok('intentPair' in nodeHead && nodeHead.intentPair?.retiredIds?.includes('summary-child'))
  assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
  f.git('merge', '--ff-only', delivered.journals.at(-1)!.receipt!.actualCommit!)
  writeFileSync(join(f.root, 'src/summary.js'), readFileSync(join(f.root, 'src/summary.js'), 'utf8') + '// NEXT-NORMAL-EDIT\n')
  const current = await f.application['freezeNodePlan'](await captureInputSnapshot(f.root), 'export-contract')
  assert.equal(current.plan.retiredIds?.includes('AC-SUMMARY-01'), false)
  assert.equal(current.plan.retiredIds?.includes('REQ-SUMMARY-01'), false)
  assert.equal(current.plan.retiredIds?.includes('summary-child'), false)
  assert.equal(current.plan.retiredIds?.includes('VERIFY-SUMMARY-01'), false)
  const restoredNodeHead = current.selection.bindings.find(binding => 'intentPair' in binding && binding.resource.id === 'summary-child')!
  assert.ok('intentPair' in restoredNodeHead && restoredNodeHead.intentPair?.receiptId === delivered.journals.at(-1)!.receipt!.id)
  const verifierHead = f.application.store.readBaselineSelection(current.selection.source, [{ kind: 'contract', id: 'VERIFY-SUMMARY-01' }]); assert.ok('selection' in verifierHead)
  assert.ok('intentPair' in verifierHead.selection.bindings[0] && verifierHead.selection.bindings[0].intentPair?.receiptId === delivered.journals.at(-1)!.receipt!.id, '完整Spec恢复必须推进原VERIFY当前head，不能留下旧retired tombstone')
  const next = await f.application.submit({ nodeId: 'export-contract', requestId: 'ordinary-edit-after-restoration' }); assert.ok(next.operation)
  const advanced = await f.application.wait(next.operation.id)
  assert.equal(advanced.operation.phase, 'workspace_synced', JSON.stringify(advanced.attempt?.failure))
  assert.match(readFileSync(join(advanced.operation.deliveryPlan.canonicalRoot, 'src/summary.js'), 'utf8'), /NEXT-NORMAL-EDIT/)
  assert.ok('intentPair' in retiredPair && retiredPair.intentPair?.retiredIds?.includes('AC-SUMMARY-01'), '旧immutable retirement审计不修改')
})

test('版本writer fencing：旧schema升级备份、future版本拒写且原会话数据保留', async t => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'sync-history-schema-'))), path = join(temp, 'session.sqlite'), protocol = openProtocol(path)
  t.after(() => { protocol.close(); rmSync(temp, { recursive: true, force: true }) })
  applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 10))
  protocol.withTransaction(tx => tx.initialize('old-session'))
  const backupPath = join(temp, 'v10.backup'); await migrateSyncStore(protocol, { backupPath }); assert.ok(existsSync(backupPath))
  assert.throws(() => applyComponentMigrations(protocol, SYNC_COMPONENT, SYNC_MIGRATIONS.slice(0, 11)), /schema generation 12; this build understands 11/)
  const store = new SyncStore(protocol)
  applyComponentMigrations(protocol, SYNC_COMPONENT, [...SYNC_MIGRATIONS, { version: SYNC_MIGRATIONS.length + 1, sql: 'SELECT 1;' }])
  assert.throws(() => store.listOperations('repo'), /SYNC_SCHEMA_UNSUPPORTED/)
  await assert.rejects(migrateSyncStore(protocol), /SYNC_SCHEMA_UNSUPPORTED/)
  assert.equal(protocol.withTransaction(tx => tx.query('SELECT session_id FROM protocol_sessions WHERE session_id=?', 'old-session')[0].session_id), 'old-session')
})

test('版本回退先暂停物理来源并停止writer，新进程保暂停且完整receipt不删除', { timeout: 120000 }, async t => {
  const f = await fixture(t), before = f.application.store.listJournals(f.original.id)
  f.application.start = () => {}
  const queued = await f.application.submit({ nodeId: 'export-contract', requestId: 'queued-before-stop' }); assert.ok(queued.operation)
  const result = await f.application.stopWriter()
  assert.equal(result.stopped, true); assert.equal(result.control.control, 'pause')
  assert.equal(f.application['observer'], null); assert.equal(f.application['running'].size, 0)
  assert.deepEqual(f.application.store.listJournals(f.original.id), before)
  assert.equal(f.calls.length, 0)
  const reopened = await SyncApplication.create(f.root, { protocol: f.protocol, runtimeDirectory: join(f.temp, 'runtime') })
  t.after(() => reopened.stopService())
  assert.equal(reopened.observationStatus().control.control, 'pause')
  reopened.start(queued.operation.id); await reopened.wait(queued.operation.id)
  assert.equal(reopened.store.readOperation(queued.operation.id).phase, 'queued')
  assert.deepEqual(reopened.store.listJournals(f.original.id), before)
})
