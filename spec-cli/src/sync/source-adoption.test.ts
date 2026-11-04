import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { openProtocol } from '@spexcode/session-protocol'
import { SyncApplication } from './application.js'
import { prepareSyncAdmission } from './coordinator.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { captureInputSnapshot, contentHash, readEvidence, readTree, verifySnapshot, writeEvidence } from './snapshot.js'
import { composeInputSnapshots } from './composition.js'
import { freezeCandidate } from './candidate.js'
import { deliverVerifiedAttempt } from './private-delivery.js'
import type { ApplyJournal, SyncAttempt, SyncOperation, VerificationResultBlob } from './operation-types.js'
import type { SyncSettings } from './settings.js'
import { claimFileMutex } from './file-mutex.js'
import { fastForwardSource, prepareSourceAdoption } from './source-adoption.js'

const settings: SyncSettings = {
  version: 'sync-settings-v1', nodeIds: ['demo'], sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'],
  verifications: [{ definition: { id: 'VERIFY-DEMO-01', command: ['node', '--test', 'tests/demo.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }],
  mandatoryTests: [], facts: [], budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 30000 },
}
async function fixture(t: test.TestContext, options: { branch?: string; gitFailureAfterMerge?: boolean; activeResource?: boolean; exactSelection?: boolean } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'spex-source-adoption-'))), root = join(temp, 'source'), runtime = join(temp, 'trusted'), appRuntime = join(temp, 'application')
  mkdirSync(join(root, '.spec/demo'), { recursive: true }); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, '.spec/demo/spec.md'), '---\ntitle: Demo\nstatus: pending\n---\n# Demo\n\n## raw source\n\n返回指定文本。\n\n## expanded spec\n\n待细化。\n')
  if (options.exactSelection) writeFileSync(join(root, '.spec/demo/spec.md'), readFileSync(join(root, '.spec/demo/spec.md'), 'utf8').replace('status: pending', 'status: pending\ncode:\n  - src/demo.mjs'))
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ sync: settings }))
  writeFileSync(join(root, 'src/demo.mjs'), 'export const demo = text => text\n')
  writeFileSync(join(root, 'tests/demo.test.mjs'), "import test from 'node:test'; test('DEMO-01', () => {})\n")
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', options.branch ?? 'main'); git('config', 'user.name', 'Adoption test'); git('config', 'user.email', 'adoption@example.invalid'); git('add', '.'); git('commit', '-qm', 'base')
  mkdirSync(join(runtime, 'dist/sync'), { recursive: true }); mkdirSync(join(runtime, 'templates/hooks'), { recursive: true })
  const canonical = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
  for (const name of readdirSync(canonical)) {
    let body = readFileSync(join(canonical, name), 'utf8')
    if (name === 'post-merge') body = body.replace('\n', `\nprintf '%s:%s:%s\\n' "\${SPEXCODE_SYNC_HOOK_MODE:-normal}" "\${SPEXCODE_SKIP_LINT:-clear}" "\${SPEXCODE_DEFER_FOOTPRINT_REFRESH:-clear}" >> '${join(temp, 'hook-trace')}'\n`)
    writeFileSync(join(runtime, 'templates/hooks', name), body)
    writeFileSync(join(root, '.git/hooks', name), body); chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  copyFileSync(fileURLToPath(new URL('../../dist/sync/trusted-footprint.js', import.meta.url)), join(runtime, 'dist/sync/trusted-footprint.js'))
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  writeFileSync(join(runtime, 'dist/cli.js'), "if(process.argv[2]==='internal'&&process.argv[3]==='trunk') console.log('main');\n")
  const gitPath = options.gitFailureAfterMerge ? join(temp, 'git') : '/usr/bin/git'
  if (options.gitFailureAfterMerge) { writeFileSync(gitPath, '#!/bin/sh\n/usr/bin/git "$@"\nresult=$?\nfor arg do if [ "$arg" = merge ] && [ "$result" = 0 ]; then exit 17; fi; done\nexit "$result"\n'); chmodSync(gitPath, 0o755) }
  const tools = { trustedRuntimeRoot: runtime, toolEntry: join(runtime, 'dist/cli.js'), canonicalHooksDir: join(runtime, 'templates/hooks'), gitPath }
  const protocol = openProtocol(join(temp, 'sessions.sqlite'))
  t.after(() => { protocol.close(); rmSync(temp, { recursive: true, force: true }) })
  const application = await SyncApplication.create(root, { protocol, runtimeDirectory: appRuntime, tools })
  await application.enable()
  const input = await captureInputSnapshot(root), plan = await buildSyncApplicationPlan(input, 'demo')
  const selected = options.exactSelection ? application.store.readBaselineSelection(input.source, await deriveSyncBaselineResources(input, plan)) : null
  assert.ok(!selected || 'selection' in selected)
  const selection = selected && 'selection' in selected ? selected.selection : undefined
  const operation = application.store.admitAndEnqueue(await prepareSyncAdmission(input, plan, { ingressKey: `adopt:${input.id}`, rootCauseId: 'adopt', origin: 'initial', budget: settings.budget, managedRoot: join(appRuntime, 'managed'), ...(selection ? { baselineSelection: selection } : {}) }))
  writeFileSync(join(appRuntime, 'artifacts', `application-runtime-${contentHash(operation.ingressKey)}.json`), JSON.stringify({ version: 'sync-tools-v1', tools, runtimeDigest: null }))
  const acknowledged = selection ? application.store.ackDispatch(input.source.repositoryId, operation.dispatchMessageId) : null
  const claimed = acknowledged ? application.store.claimQueuedAttempt({ operationId: operation.id, source: input.source, scope: operation.scope, leaseMs: 30000, expectedRevision: acknowledged.revision }) : application.store.claimAttempt({ operationId: operation.id, source: input.source, scope: operation.scope, leaseMs: 30000 })
  const composed = composeInputSnapshots(input, selection, { executionPaths: operation.scope.paths, contextPaths: plan.readPaths }).composed!
  application.store.bindComposedInput(claimed.fence, composed); application.store.startGeneration(claimed.fence)
  const entry = verifySnapshot(input).find(file => file.path === 'src/demo.mjs')!
  const candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [{ path: entry.path, beforeDigest: entry.digest, beforeMode: entry.mode, content: 'export const demo = text => `${text}!`\n' }] }, operation.scope, composed)
  application.store.freezeCandidate(claimed.fence, candidate)
  const evidence = writeEvidence(input.source.commonDir, { fixture: '受控的四层前置证据；此测试只验证真实Git交付和采纳，不代替模型/Docker产品验收' })
  const bindings = { inputId: input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, ...(selection ? { baselineSelectionDigest: selection.digest } : {}), environmentDigest: 'fixture', contextDigest: 'fixture' }
  const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
  application.store.recordVerification(claimed.fence, { ...bindings, passed: true, coveredScope: operation.scope, evidenceRefs: [evidence], resultBlob: writeEvidence(input.source.commonDir, result) })
  if (options.activeResource) application.store.planResource(claimed.fence, { key: 'unsettled-verification', kind: 'verification', inputId: input.id, candidateDigest: candidate.digest, payloadDigest: 'fixture-resource', planBlob: evidence, checkpointRef: evidence })
  const delivery = await deliverVerifiedAttempt(application.store, claimed.fence, { managedRoot: join(appRuntime, 'managed'), tools, beforeApply: () => {} })
  const journal = application.store.listJournals(operation.id)[0]
  const replace = (table: 'sync_operations' | 'sync_attempts' | 'sync_apply_journals', record: SyncOperation | SyncAttempt | ApplyJournal): void => { protocol.withTransaction(tx => { tx.exec(`UPDATE ${table} SET record_json=? WHERE id=?`, JSON.stringify(record), record.id) }) }
  return { temp, root, appRuntime, runtime, application, input, operation: delivery.operation, receipt: delivery.receipt, journal, git, tools, replace, protocol, plan }
}

test('未采纳的完整settled交付可沿正式retryOf建立新操作，原历史和来源保持', { timeout: 90000 }, async t => {
  const f = await fixture(t, { exactSelection: true })
  f.application.start = () => {}
  const original = f.application.store.readOperation(f.operation.id), journals = f.application.store.listJournals(original.id), attempts = f.application.store.listAttempts(original.id)
  const head = f.git('rev-parse', 'HEAD'), index = readFileSync(join(f.root, '.git/index'))
  const detail = await f.application.readOperation(original.id)
  assert.deepEqual(detail.retryEligibility, { eligible: true })
  const request = { nodeId: 'demo', requestId: 'revalidate-unadopted', retryOf: original.id }
  const retried = (await f.application.submit(request)).operation!
  assert.notEqual(retried.id, original.id)
  assert.equal(retried.retryOf, original.id)
  assert.equal(retried.input.id, original.input.id)
  assert.equal(retried.readSetDigest, original.readSetDigest)
  assert.notEqual(retried.baselineSelection!.digest, original.baselineSelection!.digest)
  assert.equal((await f.application.submit(request)).operation!.id, retried.id)
  assert.deepEqual(f.application.store.readOperation(original.id), original)
  assert.deepEqual(f.application.store.listJournals(original.id), journals)
  assert.deepEqual(f.application.store.listAttempts(original.id), attempts)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  const acknowledged = f.application.store.ackDispatch(f.input.source.repositoryId, retried.dispatchMessageId)
  const claimed = f.application.store.claimQueuedAttempt({ operationId: retried.id, source: retried.input.source, scope: retried.scope, leaseMs: 30000, expectedRevision: acknowledged.revision })
  const business = f.application.store.readBusinessBaselineSelection(retried.id)!
  assert.deepEqual(business, original.baselineSelection)
  const composed = composeInputSnapshots(retried.input, business, { executionPaths: retried.scope.paths, contextPaths: f.plan.readPaths }).composed!
  f.application.store.bindComposedInput(claimed.fence, composed)
  assert.equal(f.application.store.readAttempt(claimed.attempt.id).baselineSelectionDigest, retried.baselineSelection!.digest)
  assert.equal(f.application.store.readAttempt(claimed.attempt.id).composedInput!.baselineSelectionDigest, original.baselineSelection!.digest)
  assert.equal(composed.tree, original.input.immutableTree, '旧未采纳candidate不能成为新业务组合输入')
  f.protocol.withTransaction(tx => tx.exec('DELETE FROM sync_baseline_heads WHERE source_key=(SELECT source_key FROM sync_operations WHERE id=?)', original.id))
  assert.equal((await f.application.submit(request)).operation!.id, retried.id, '精确请求重放不因之后资源头变化再开操作或预算')
})

for (const mode of ['adopted', 'dirty', 'index', 'head', 'partial', 'receipt', 'resource', 'foreign-head', 'scope', 'readset', 'unwritten-head'] as const) test(`未采纳正式重验拒绝 ${mode} 并保留旧交付与来源`, { timeout: 90000 }, async t => {
  const f = await fixture(t, { exactSelection: true, activeResource: mode === 'resource' })
  f.application.start = () => {}
  if (mode === 'adopted') f.git('merge', '--ff-only', f.receipt.actualCommit!)
  if (mode === 'dirty' || mode === 'index') {
    writeFileSync(join(f.root, 'src/demo.mjs'), 'human edit\n')
    if (mode === 'index') f.git('add', 'src/demo.mjs')
  }
  if (mode === 'head') f.git('commit', '--allow-empty', '-m', 'human head advanced')
  if (mode === 'partial') f.replace('sync_operations', { ...f.operation, deliveredScope: { paths: [], contractIds: [], flowIds: [] } })
  if (mode === 'receipt') f.replace('sync_apply_journals', { ...f.journal, receipt: null })
  if (mode === 'scope') f.replace('sync_operations', { ...f.operation, scope: { paths: [], contractIds: [], flowIds: [] } })
  if (mode === 'readset') f.replace('sync_operations', { ...f.operation, readSetDigest: contentHash('篡改父原读集') })
  if (mode === 'unwritten-head') f.protocol.withTransaction(tx => tx.exec("INSERT INTO sync_baseline_heads(source_key,resource_key,pair_id,legacy_reason) SELECT source_key,'path:package.json',?,NULL FROM sync_operations WHERE id=? ON CONFLICT(source_key,resource_key) DO UPDATE SET pair_id=excluded.pair_id", `baseline-${f.journal.id}`, f.operation.id))
  if (mode === 'foreign-head') {
    const selected = f.application.store.readBaselineSelection(f.input.source, f.operation.baselineSelection!.bindings.map(binding => binding.resource))
    assert.ok('selection' in selected)
    const operation = f.application.store.admitAndEnqueue(await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'third-party-delivery', rootCauseId: 'third-party-delivery', origin: 'spec', budget: settings.budget, managedRoot: join(f.appRuntime, 'managed'), baselineSelection: selected.selection, executionScope: f.operation.scope }))
    const queued = f.application.store.ackDispatch(f.input.source.repositoryId, operation.dispatchMessageId)
    const claimed = f.application.store.claimQueuedAttempt({ operationId: operation.id, source: f.input.source, scope: operation.scope, expectedRevision: queued.revision, leaseMs: 30000 })
    const composed = composeInputSnapshots(f.input, selected.selection, { executionPaths: operation.scope.paths, contextPaths: f.plan.readPaths }).composed!
    f.application.store.bindComposedInput(claimed.fence, composed); f.application.store.startGeneration(claimed.fence)
    const entry = readTree(f.input.source.commonDir, composed.tree).find(entry => entry.path === 'src/demo.mjs')!
    const candidate = freezeCandidate(f.input, { version: 'sync-files-v1', changes: [{ path: entry.path, beforeDigest: entry.digest, beforeMode: entry.mode, content: 'export const demo = text => `other:${text}`\n' }] }, operation.scope, composed)
    f.application.store.freezeCandidate(claimed.fence, candidate)
    const evidence = writeEvidence(f.input.source.commonDir, { fixture: '第三方真实Git交付；四层结果为受控接缝' })
    const bindings = { inputId: f.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, baselineSelectionDigest: selected.selection.digest, environmentDigest: 'fixture', contextDigest: 'fixture' }
    const result: VerificationResultBlob = { schemaVersion: 1, ...bindings, coveredScope: operation.scope, layers: (['V1', 'V2', 'V3', 'V4'] as const).map(layer => ({ layer, verdict: 'pass', evidenceRefs: [evidence] })) }
    f.application.store.recordVerification(claimed.fence, { ...bindings, passed: true, coveredScope: operation.scope, evidenceRefs: [evidence], resultBlob: writeEvidence(f.input.source.commonDir, result) })
    await deliverVerifiedAttempt(f.application.store, claimed.fence, { managedRoot: join(f.appRuntime, 'managed'), tools: f.tools, beforeApply: () => {} })
  }
  const before = JSON.stringify({ operation: f.application.store.readOperation(f.operation.id), journals: f.application.store.listJournals(f.operation.id), attempts: f.application.store.listAttempts(f.operation.id) }), head = f.git('rev-parse', 'HEAD'), index = readFileSync(join(f.root, '.git/index'))
  const eligibility = f.application.store.readRetryEligibility(f.operation.id)
  assert.equal(eligibility.eligible, false, JSON.stringify(eligibility))
  if (mode === 'foreign-head' || mode === 'unwritten-head') assert.equal(eligibility.reason?.code, 'SYNC_RETRY_BASELINE_CHANGED')
  await assert.rejects(f.application.submit({ nodeId: 'demo', requestId: `refuse-${mode}`, retryOf: f.operation.id }))
  assert.equal(JSON.stringify({ operation: f.application.store.readOperation(f.operation.id), journals: f.application.store.listJournals(f.operation.id), attempts: f.application.store.listAttempts(f.operation.id) }), before)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
})

test('未采纳重验事务复核父revision和预算，显式模型选择沿既有幂等规则', { timeout: 90000 }, async t => {
  const f = await fixture(t, { exactSelection: true }), parent = f.application.store.readOperation(f.operation.id)
  const selection = f.application.store.readRevalidationSelection(parent.id)
  const admission = await prepareSyncAdmission(f.input, f.plan, { ingressKey: 'revalidation-cas', rootCauseId: 'revalidation-cas', retryOf: parent.id, model: parent.model, origin: parent.origin, budget: parent.budget, managedRoot: join(f.appRuntime, 'managed'), baselineSelection: selection, executionScope: parent.scope, impactDigest: parent.impactDigest }, f.application.store.readBusinessBaselineSelection(parent.id))
  assert.throws(() => f.application.store.admitAndEnqueue({ ...admission, budget: { mode: 'unlimited' } }), /SYNC_RETRY_BINDING/)
  const listJournals = f.application.store.listJournals.bind(f.application.store)
  f.application.store.listJournals = id => {
    const journals = listJournals(id)
    if (id === parent.id) f.replace('sync_operations', { ...parent, revision: parent.revision + 1 })
    return journals
  }
  assert.throws(() => f.application.store.admitAndEnqueue(admission), /SYNC_RETRY_REVALIDATION_REQUIRED/)
  assert.equal(f.application.store.findOperationByIngressKey(admission.ingressKey), null)
  assert.deepEqual(listJournals(parent.id), [f.journal])
  assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit)
  f.application.store.listJournals = listJournals
  f.replace('sync_operations', parent)
  const modelAdmission = { ...admission, ingressKey: 'explicit-model-revalidation', rootCauseId: 'explicit-model-revalidation', model: 'claude:opaque-cli-model' }
  const modelRetry = f.application.store.admitAndEnqueue(modelAdmission)
  assert.equal(modelRetry.model, modelAdmission.model)
  assert.throws(() => f.application.store.admitAndEnqueue({ ...modelAdmission, model: 'claude:different-requested-model' }), /SYNC_IDEMPOTENCY_CONFLICT/)
})

test('AC-ADOPT-01 服务采纳真实settled提交，正常hooks执行，主分支投影只读且重复幂等', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  const before = await f.application.readOperation(f.operation.id)
  assert.equal(before.sourceSynced, false); assert.equal(before.canonicalSynced, false)
  assert.equal(typeof f.application.adopt, 'function', '已验证交付必须有共享应用采纳入口')
  assert.deepEqual(before.adoptionEligibility, { eligible: true })
  const adopted = await f.application.adopt(f.operation.id)
  assert.equal(f.git('rev-parse', 'HEAD'), f.receipt.actualCommit)
  assert.equal(adopted.sourceSynced, true); assert.equal(adopted.canonicalSynced, true); assert.equal(adopted.operation.phase, 'canonical_synced')
  assert.equal(f.application.store.readOperation(f.operation.id).phase, 'workspace_synced')
  assert.equal(readFileSync(join(f.temp, 'hook-trace'), 'utf8'), 'normal:clear:clear\n')
  writeFileSync(join(f.root, '.git/hooks/extra.sample'), 'non-executable hook sample after adoption\n')
  assert.equal((await f.application.adopt(f.operation.id)).canonicalSynced, true)
  assert.equal(readFileSync(join(f.temp, 'hook-trace'), 'utf8'), 'normal:clear:clear\n')
  assert.equal(f.git('rev-list', '--count', 'HEAD'), '2')
})

async function rejectedUnchanged(f: Awaited<ReturnType<typeof fixture>>, code: string): Promise<void> {
  const before = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), refs = f.git('show-ref')
  const detail = await f.application.readOperation(f.operation.id)
  assert.equal(detail.adoptionEligibility.eligible, false)
  if (detail.adoptionEligibility.eligible) assert.fail('expected refused adoption')
  assert.equal(detail.adoptionEligibility.reason.code, code, detail.adoptionEligibility.reason.message)
  await assert.rejects(f.application.adopt(f.operation.id), error => (error as { code: string }).code === code)
  assert.equal((await captureInputSnapshot(f.root)).id, before.id)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal(f.git('show-ref'), refs)
}

test('AC-ADOPT-02 暂存、未暂存与未跟踪修改均拒绝并完整保留', { timeout: 90000 }, async t => {
  const f = await fixture(t), path = join(f.root, 'src/demo.mjs'), original = readFileSync(path)
  writeFileSync(path, 'human staged\n'); f.git('add', 'src/demo.mjs')
  await rejectedUnchanged(f, 'sync_adoption_source_dirty')
  f.git('reset', '-q', 'HEAD', '--', 'src/demo.mjs')
  await rejectedUnchanged(f, 'sync_adoption_source_dirty')
  writeFileSync(path, original); writeFileSync(join(f.root, 'human-untracked.txt'), 'preserve me\n')
  await rejectedUnchanged(f, 'sync_adoption_source_dirty')
})

test('AC-ADOPT-03 原分支分叉拒绝，feature快进只投影source采纳', { timeout: 90000 }, async t => {
  const f = await fixture(t, { branch: 'feature' })
  writeFileSync(join(f.root, 'other.txt'), 'independent source commit\n'); f.git('add', 'other.txt'); f.git('commit', '-qm', 'source diverged')
  await rejectedUnchanged(f, 'sync_adoption_not_fast_forward')
  const clean = await fixture(t, { branch: 'feature' }), adopted = await clean.application.adopt(clean.operation.id)
  assert.equal(adopted.sourceSynced, true); assert.equal(adopted.canonicalSynced, false); assert.equal(adopted.operation.phase, 'workspace_synced')
})

test('AC-ADOPT-04 缺失四层验证、伪造receipt与不完整journal都不得采纳', { timeout: 120000 }, async t => {
  const f = await fixture(t), attempt = f.application.store.readAttempt(f.operation.currentAttemptId!)
  const result = JSON.parse(readEvidence(f.input.source.commonDir, attempt.verification!.resultBlob).toString('utf8')) as VerificationResultBlob
  f.replace('sync_attempts', { ...attempt, verification: { ...attempt.verification!, resultBlob: writeEvidence(f.input.source.commonDir, { ...result, layers: result.layers.filter(layer => layer.layer !== 'V4') }) } })
  await rejectedUnchanged(f, 'sync_adoption_verification_invalid')
  f.replace('sync_attempts', attempt)
  f.replace('sync_apply_journals', { ...f.journal, receipt: { ...f.receipt, actualCommit: f.input.headCommit } })
  await rejectedUnchanged(f, 'sync_adoption_receipt_invalid')
  f.replace('sync_apply_journals', { ...f.journal, plan: { ...f.journal.plan, candidateDigest: 'forged' } })
  await rejectedUnchanged(f, 'sync_adoption_plan_invalid')
  f.replace('sync_apply_journals', { ...f.journal, receipt: null })
  await rejectedUnchanged(f, 'sync_adoption_not_settled')
})

test('AC-ADOPT-05 当前配置或原分支改变撤销采纳授权，partial范围拒绝', { timeout: 90000 }, async t => {
  const f = await fixture(t), config = join(f.root, '.spec/spexcode.json'), original = readFileSync(config)
  writeFileSync(config, JSON.stringify({ sync: { ...settings, facts: [{ source: 'user', text: '新的授权' }] } }))
  await rejectedUnchanged(f, 'sync_configuration_changed')
  writeFileSync(config, original)
  f.replace('sync_operations', { ...f.operation, blockedScope: { paths: [], contractIds: ['UNRESOLVED'], flowIds: [] } })
  await rejectedUnchanged(f, 'sync_adoption_incomplete')
  f.replace('sync_operations', f.operation)
  f.git('checkout', '-b', 'changed-source-identity')
  const snapshot = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), refs = f.git('show-ref')
  await assert.rejects(f.application.readOperation(f.operation.id), { code: 'sync_operation_wrong_source', status: 404 })
  await assert.rejects(f.application.adopt(f.operation.id), { code: 'sync_operation_wrong_source', status: 404 })
  assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal(f.git('show-ref'), refs)
})

test('AC-ADOPT-06 与协调器相同来源发布锁互斥，未结算资源阻塞采纳', { timeout: 90000 }, async t => {
  const f = await fixture(t), canonical = JSON.stringify(f.input.source, Object.keys(f.input.source).sort()), directory = join(f.appRuntime, 'artifacts/.publication-locks')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const mutex = claimFileMutex(join(directory, `${contentHash(canonical)}.sqlite`)); assert.ok(mutex)
  try { await assert.rejects(f.application.adopt(f.operation.id), error => (error as { code: string }).code === 'sync_adoption_busy') }
  finally { mutex.release() }
  assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit)
  const active = await fixture(t, { activeResource: true })
  await rejectedUnchanged(active, 'sync_resources_unsettled')
})

test('AC-ADOPT-07 Git报错但ref已前进时诚实诊断，读取仍按真实采纳投影', { timeout: 90000 }, async t => {
  const f = await fixture(t, { gitFailureAfterMerge: true })
  await assert.rejects(f.application.adopt(f.operation.id), error => {
    assert.equal((error as { code: string }).code, 'sync_adoption_git_failed')
    assert.match((error as Error).message, /退出 17.*HEAD 已变为/)
    return true
  })
  assert.equal(f.git('rev-parse', 'HEAD'), f.receipt.actualCommit)
  const detail = await f.application.readOperation(f.operation.id)
  assert.equal(detail.sourceSynced, true); assert.equal(detail.canonicalSynced, true)
  assert.equal(f.application.store.readOperation(f.operation.id).phase, 'workspace_synced')
})

test('AC-ADOPT-08 最终Git边界拒绝preflight后的切支与HEAD改变，不写其他分支', { timeout: 90000 }, async t => {
  const f = await fixture(t, { branch: 'feature' })
  const plan = prepareSourceAdoption(f.application.store, f.operation, await captureInputSnapshot(f.root), { tools: f.tools, canonicalBranch: 'refs/heads/main', readPaths: ['package.json'] })
  f.git('checkout', '-b', 'another-branch')
  assert.throws(() => fastForwardSource(plan), error => (error as { code: string }).code === 'sync_source_changed')
  assert.equal(f.git('rev-parse', 'HEAD'), f.input.headCommit); assert.equal(f.git('rev-parse', 'feature'), f.input.headCommit)
  f.git('checkout', 'feature')
  writeFileSync(join(f.root, 'new-source.txt'), 'new source head\n'); f.git('add', 'new-source.txt'); f.git('commit', '-qm', 'source advanced')
  const head = f.git('rev-parse', 'HEAD')
  assert.throws(() => fastForwardSource(plan), error => (error as { code: string }).code === 'sync_source_changed')
  assert.equal(f.git('rev-parse', 'HEAD'), head)
  assert.equal(f.git('rev-parse', 'another-branch'), f.input.headCommit)
})

test('AC-ADOPT-09 交付后的hooks目录footprint变化拒绝采纳并保留原树', { timeout: 90000 }, async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, '.git/hooks/extra.sample'), 'non-executable hook sample\n')
  await rejectedUnchanged(f, 'sync_adoption_hooks_changed')
})
