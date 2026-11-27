import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { configuredSessionApplication } from '../session-application.js'
import { readRecord, writeRecord } from '../session-record.js'
import { StructuredSessionError, structuredExecutionPolicy } from '../session-structured-policy.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { readCodeBehaviorContext, type CodeBehaviorContinuation } from './code-behavior.js'
import { prepareSyncAdmission, runSyncOperation } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { CROSS_FREEZE_IMPACT_PURPOSE, type CrossFreezeImpactEvidence, type CrossFreezeImpactOutput } from './cross-freeze-impact-review.js'
import { migrateSyncStore } from './migrations.js'
import type { NativeRunCheckpoint } from './native-run.js'
import type { BlobRef, SyncAttempt } from './operation-types.js'
import { captureInputSnapshot, contentHash, readEvidence } from './snapshot.js'
import { readStageDraft } from './stage-worktree.js'
import { SyncStore, SyncStoreError } from './store.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const exportSpec = '.spec/export/export-contract/spec.md'
const importSpec = '.spec/export/import-contract/spec.md'
const importSource = 'src/import.js'
const importTest = 'tests/import.test.mjs'
const boundary = 'fixture reached P0 whole before P1'
const digest = (value: unknown): string => contentHash(JSON.stringify(value))

const scenarios = [
  { useBaseline: false, mainBranch: 'main', checkout: 'main' },
  { useBaseline: true, mainBranch: 'main', checkout: 'main' },
  { useBaseline: true, mainBranch: 'main', checkout: 'feature' },
  { useBaseline: true, mainBranch: 'stable', checkout: 'stable' },
] as const

for (const { useBaseline, mainBranch, checkout } of scenarios) test(`跨冻结正式 P0 configured=${mainBranch} checkout=${checkout} baseline=${useBaseline}`, async t => {
  const canonicalCheckout = mainBranch === checkout
  assert.ok(process.env.SPEXCODE_TEST_HOME, '必须通过 test-home 隔离正式会话夹具')
  assert.equal(process.env.SPEX_SESSION_DATABASE_PATH, join(process.env.SPEXCODE_TEST_HOME, 'sessions.sqlite'))
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-cross-freeze-coordinator-')))
  const root = join(parent, 'source'), managedRoot = join(parent, 'managed'), artifactRoot = join(parent, 'artifacts')
  cpSync(fixture, root, { recursive: true })
  mkdirSync(managedRoot, { mode: 0o700 })
  mkdirSync(artifactRoot, { mode: 0o700 })
  const previousCwd = process.cwd()
  let protocol = openProtocol(join(parent, 'sync.sqlite'))
  t.after(() => {
    process.chdir(previousCwd)
    protocol.close()
    rmSync(parent, { recursive: true, force: true })
  })
  await migrateSyncStore(protocol, { backupPath: join(parent, 'sync.backup') })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Native Fixture', '-c', 'user.email=fixture@example.invalid',
    '-C', cwd, ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text, 'utf8')
  }
  const renamed = (path: string) => readFileSync(join(root, path), 'utf8')
    .replaceAll('export-job', 'import-job').replaceAll('EXPORT', 'IMPORT').replaceAll('export-contract', 'import-contract')
    .replaceAll('src/export.js', importSource).replaceAll('tests/export.test.mjs', importTest)
  write(importSpec, renamed(exportSpec))
  write(importSource, 'export class ImportService {}\n')
  write(importTest, 'import assert from "node:assert/strict"\n')
  write('.spec/spexcode.json', JSON.stringify({ mainBranch, harnesses: [] }))
  git(root, 'init', '-q', '-b', mainBranch)
  const commit = (message: string) => {
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', message)
  }
  commit('old clean committed initial')
  if (!canonicalCheckout) git(root, 'switch', '-qc', checkout)
  process.chdir(root)
  const oldInput = await captureInputSnapshot(root, { committed: true }), commonDir = oldInput.source.commonDir
  assert.equal(oldInput.source.branch, `refs/heads/${checkout}`)
  const read = <T>(ref: BlobRef): T => JSON.parse(readEvidence(commonDir, ref).toString('utf8'))
  let store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const plan: SyncCoordinatorPlan = {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1',
    intentNodeId: 'export-contract', sourcePaths: ['src'], readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: exportSpec }, { nodeId: 'import-contract', path: importSpec }],
    facts: [], verifications: [], mandatoryTests: [],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 1 },
  }
  const admit = async (input: typeof oldInput, name: string) => {
    assert.equal(git(root, 'status', '--porcelain'), '')
    const executionScope = { paths: [exportSpec, importSpec, 'src/export.js', importSource], contractIds: [], flowIds: [] }
    const selected = useBaseline ? store.readBaselineSelection(input.source, executionScope.paths.map(path => ({ kind: 'path' as const, path }))) : undefined
    if (selected && !('selection' in selected)) assert.fail(selected.failure.message)
    const next = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, {
      ingressKey: name, rootCauseId: name, origin: 'initial', budget: { mode: 'unlimited' }, managedRoot, model: 'claude:default',
      ...(selected ? { baselineSelection: selected.selection, executionScope } : {}),
    }))
    return store.ackDispatch(input.source.repositoryId, next.dispatchMessageId)
  }
  const stages = (attempt: SyncAttempt) => new Map(attempt.checkpointRefs.flatMap(ref => {
    const wrapper = read<{ stage?: string; resultRef: BlobRef; readSetDigest?: string }>(ref)
    return wrapper.stage ? [[wrapper.stage, wrapper] as const] : []
  }))
  const calls: { freeze: string; purpose: string; owner: string; sessionId: string }[] = []
  let active = await admit(oldInput, 'old-initial')
  const options: SyncCoordinatorOptions = {
    plan, readCurrentPlan: () => plan, managedRoot, artifactRoot,
    tools: { trustedRuntimeRoot: parent, toolEntry: join(parent, 'unused'), canonicalHooksDir: join(parent, 'unused-hooks') },
    nativeExecution: { pollMs: 2, runtime: {
      readRecord, cancel: async () => assert.fail('夹具禁止真实会话控制'),
      run: async request => {
        const seed = request.worktree!
        const createKey = request.sessionCreateKey!, sessionId = sessionIdForCreateKey(createKey)
        const threadId = 'thread-' + sessionId, turnId = 'turn-' + sessionId
        const branch = 'codex/cross-freeze-fixture-' + sessionId, workspace = join(parent, sessionId)
        git(root, 'worktree', 'add', '-q', '-b', branch, workspace, seed.baseCommit)
        let owner: string, output: unknown
        if (request.purpose === CROSS_FREEZE_IMPACT_PURPOSE) {
          assert.equal(seed.mode, 'read')
          const materialPath = git(workspace, 'ls-files', '.spex-sync-drafts').split('\n').find(path => path.endsWith('/review.json'))!
          const material = JSON.parse(readFileSync(join(workspace, materialPath), 'utf8')) as
            CrossFreezeImpactEvidence['binding'] & { previous: { commit: string }; current: { commit: string }; changes: { path: string }[] }
          owner = material.owner
          assert.deepEqual(material.changes.map(change => change.path), [importSource, importTest])
          assert.match(readFileSync(join(workspace, dirname(materialPath), 'changes.diff'), 'utf8'), /H2 import dependency/)
          const affected = oldOwners.IMPORT === owner
          output = { inputDigest: request.inputDigest, verdict: affected ? 'affected' : 'reuse',
            history: { previousCommit: material.previous.commit, currentCommit: active.input.headCommit, evidence: importSource, reason: 'Compare frozen call paths for this contract.' },
            paths: material.changes.map(({ path }) => ({ path, verdict: affected ? 'affected' : 'reuse',
              evidence: 'Read the complete frozen path and surrounding calls: ' + path, reason: 'Import dependency changes are material to ImportService only.' })),
          } satisfies CrossFreezeImpactOutput
        } else {
          assert.ok(request.purpose === 'code_behavior_analyze' || request.purpose === 'code_behavior_review', request.purpose)
          const { task, pendingAnalysis } = readCodeBehaviorContext(request, commonDir)
          owner = (task.partition as { id: string }).id
          const paths = task.requiredChangedPaths as string[]
          const imports = paths.includes(importSource)
          const domain = imports ? 'IMPORT' : 'EXPORT'
          const rule = 'RULE-' + domain + '-05'
          const draft = pendingAnalysis ? {
            inputDigest: request.inputDigest, analysisDigest: pendingAnalysis.analysisDigest, verdict: 'accept',
            checkedPaths: paths, checkedChangeIds: pendingAnalysis.analysis.changes.map(change => change.id), findings: [],
          } : {
            changes: paths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [rule], ruleIds: [rule],
              originalIntent: '保留原业务', previousBehavior: '原业务行为', sourceBehavior: '现有重构不变更原业务语义',
              deliveryBehavior: '保留原交付行为', evidence: path, counterexample: '保留原任务权限和既有状态事件' })),
            facts: [], acceptanceChanges: [], newNodes: [], resolutions: [],
          }
          if (active.id === old.id) oldOwners[domain] = owner
          const draftPath = /草稿文件=([^\s；]+)/.exec(request.prompt)?.[1]
          assert.ok(draftPath)
          mkdirSync(dirname(join(workspace, draftPath)), { recursive: true })
          writeFileSync(join(workspace, draftPath), JSON.stringify(draft, null, 2) + '\n', 'utf8')
          git(workspace, 'add', draftPath)
          git(workspace, 'commit', '-qm', 'Native fixture draft')
          output = { summary: 'Native fixture committed its Git draft' }
        }
        calls.push({ freeze: active.id, purpose: request.purpose, owner, sessionId })
        const worktree = nativeWorktreeResult(workspace, seed), resultDigest = digest(output)
        const execution = structuredExecutionPolicy(request)
        configuredSessionApplication().createSession({ sessionId, status: 'awaiting' })
        writeRecord({ session: sessionId, governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch,
          title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null,
          createdAt: Date.now(), harness: 'claude', harnessSessionId: threadId, runtimeStartToken: null, status: 'awaiting',
          stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null,
          createRequestId: contentHash(createKey), createPayloadHash: digest({ prompt: nativeWorktreePrompt(request.prompt, seed), parent: null, launcher: null, base: seed.baseCommit, structuredExecution: execution }),
          structuredExecution: { ...execution, state: 'completed', threadId, turnId, output, resultDigest, resultWorktree: worktree },
        })
        return { sessionId, threadId, turnId, output, resultDigest, worktree }
      },
    } },
  }
  const old = active, oldOwners: Partial<Record<'EXPORT' | 'IMPORT', string>> = {}
  let interruptAfterImpact: string | undefined
  const impactWrites: string[] = []
  const runUntilP0 = async () => {
    const checkpoint = store.checkpoint.bind(store)
    store.checkpoint = (fence, ref) => {
      const saved = checkpoint(fence, ref)
      const stage = read<{ stage?: string }>(ref).stage
      if (stage === 'analysis') throw new StructuredSessionError('unsupported', boundary)
      if (stage?.endsWith(':cross-freeze-impact')) impactWrites.push(stage)
      if (stage && stage === interruptAfterImpact) throw new SyncStoreError('SYNC_FENCE_EXPIRED', 'fixture process stops after impact checkpoint')
      return saved
    }
    try { return await runSyncOperation(store, active.id, options) }
    finally { store.checkpoint = checkpoint }
  }
  const first = await runUntilP0()
  assert.equal(first.failure?.message, boundary, JSON.stringify(first.failure))
  assert.equal(first.operation.phase, 'failed')
  const { EXPORT: unaffected, IMPORT: affected } = oldOwners
  assert.ok(unaffected && affected && unaffected !== affected, JSON.stringify(calls))
  const [oldAttempt] = store.listAttempts(old.id)
  const oldStages = stages(oldAttempt)
  const oldContinuation = read<CodeBehaviorContinuation>(oldStages.get('partition:' + unaffected + ':analysis:continuation')!.resultRef)
  const original = read<CodeBehaviorAnalysis>(oldStages.get('partition:' + unaffected + ':analysis')!.resultRef)
  assert.ok(oldContinuation.readyAnalysis && oldContinuation.drafts.code_behavior_analyze)
  assert.equal(original.reviewPassed, true)
  assert.equal(store.readRetryEligibility(old.id).eligible, true)

  write(importSource, 'export class ImportService {} // H2 import dependency\n')
  write(importTest, readFileSync(join(root, importTest), 'utf8') + '// H2 test discovery assertion context\n')
  commit('new clean committed initial')
  const currentInput = await captureInputSnapshot(root, { committed: true })
  protocol.close()
  protocol = openProtocol(join(parent, 'sync.sqlite'))
  store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  active = await admit(currentInput, 'new-initial')
  assert.notEqual(active.input.headCommit, old.input.headCommit)
  assert.equal(active.input.source.branch, `refs/heads/${checkout}`)
  assert.equal(active.policyDigest, first.operation.policyDigest)
  assert.equal(active.retryOf, undefined)
  const before = { operation: store.readOperation(old.id), attempts: store.listAttempts(old.id) }
  assert.equal(before.operation.phase, 'superseded')
  assert.deepEqual(before.attempts, [{ ...oldAttempt, status: 'superseded' }])
  const impactKey = 'partition:' + unaffected + ':analysis:cross-freeze-impact'
  if (!useBaseline) {
    interruptAfterImpact = impactKey
    const interrupted = await runUntilP0()
    assert.equal(interrupted.status, 'recovery_required', JSON.stringify(interrupted.failure))
    assert.equal(interrupted.failure?.code, 'SYNC_FENCE_EXPIRED')
    assert.deepEqual(impactWrites.filter(stage => stage === impactKey), [impactKey])
    interruptAfterImpact = undefined
    protocol.close()
    protocol = openProtocol(join(parent, 'sync.sqlite'))
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  }
  const second = await runUntilP0()
  assert.equal(second.failure?.message, boundary, JSON.stringify(second.failure))
  assert.equal(second.operation.phase, 'failed')
  const attempts = store.listAttempts(active.id)
  assert.equal(attempts.length, 1)
  const [currentAttempt] = attempts, currentStages = stages(currentAttempt)
  const currentCalls = calls.filter(call => call.freeze === active.id)
  if (canonicalCheckout) {
    assert.deepEqual(currentCalls.filter(call => call.owner === unaffected).map(call => call.purpose), [CROSS_FREEZE_IMPACT_PURPOSE, 'code_behavior_review'])
    assert.deepEqual(currentCalls.filter(call => call.owner === affected).map(call => call.purpose), [CROSS_FREEZE_IMPACT_PURPOSE, 'code_behavior_analyze', 'code_behavior_review'])
    assert.ok(second.operation.crossFreezeBinding)
    const binding = read<{ canonicalBranch: string; oldOperationId: string }>(second.operation.crossFreezeBinding.ref)
    assert.equal(binding.canonicalBranch, `refs/heads/${mainBranch}`)
    assert.equal(binding.oldOperationId, old.id)
    const originalDraft = oldContinuation.drafts.code_behavior_analyze
    assert.ok(originalDraft)
    const reused = read<CodeBehaviorAnalysis>(currentStages.get('partition:' + unaffected + ':analysis')!.resultRef)
    const impactStage = currentStages.get(impactKey)!
    const newImpact = read<{ evidence: CrossFreezeImpactEvidence }>(impactStage.resultRef).evidence
    assert.deepEqual(reused.traces[0], original.traces[0])
    assert.equal(reused.traces[1].inputDigest, reused.inputDigest)
    assert.notEqual(reused.inputDigest, original.inputDigest)
    assert.notEqual(reused.traces[1].sessionId, original.traces[1].sessionId)
    assert.notEqual(reused.traces[1].sessionId, newImpact.trace.sessionId)
    assert.equal(reused.crossFreezeAuthor?.oldAttemptId, oldAttempt.id)
    assert.equal(reused.crossFreezeAuthor?.oldInputDigest, original.inputDigest)
    assert.deepEqual(reused.crossFreezeAuthor?.impactReviewRef, impactStage.resultRef)
    assert.deepEqual(impactWrites.filter(stage => stage === impactKey), [impactKey], '冷重启必须直接读取已认证的影响复核')
    assert.equal(impactStage.readSetDigest, second.operation.readSetDigest)
    assert.equal(newImpact.verdict, 'reuse')
    assert.deepEqual(newImpact.output.paths.map(path => path.path), [importSource, importTest])
    assert.equal(readEvidence(commonDir, newImpact.binding.prior.resultRef).toString('utf8'), readStageDraft(commonDir, originalDraft, originalDraft))
    assert.equal(newImpact.binding.prior.approvalRef?.sha256, oldStages.get('partition:' + unaffected + ':analysis')!.resultRef.sha256)
  } else {
    assert.deepEqual(currentCalls.map(call => call.purpose), [
      'code_behavior_analyze', 'code_behavior_review', 'code_behavior_analyze', 'code_behavior_review',
    ], '未配置的分支应按正常 P0 路径运行，不能派发跨冻结影响复核')
    assert.equal(first.operation.crossFreezeBinding, undefined)
    assert.equal(second.operation.crossFreezeBinding, undefined)
    assert.equal(currentStages.has(impactKey), false)
    assert.deepEqual(impactWrites, [])
    const local = read<CodeBehaviorAnalysis>(currentStages.get('partition:' + unaffected + ':analysis')!.resultRef)
    assert.equal(local.crossFreezeAuthor, undefined)
    assert.equal(local.reviewPassed, true)
    assert.notEqual(local.traces[0].sessionId, original.traces[0].sessionId)
  }
  assert.equal(read<CodeBehaviorAnalysis>(currentStages.get('partition:' + affected + ':analysis')!.resultRef).crossFreezeAuthor, undefined)
  assert.deepEqual(store.readOperation(old.id), before.operation)
  assert.deepEqual(store.listAttempts(old.id), before.attempts)
  for (const attempt of [oldAttempt, currentAttempt]) {
    const resources = store.listResources(attempt.id)
    assert.equal(resources.length, attempt.dispatchPlans.length)
    for (const resource of resources) {
      assert.equal(resource.phase, 'removed')
      const checkpoint = read<NativeRunCheckpoint>(resource.checkpointRef)
      assert.equal(checkpoint.status, 'completed')
      assert.ok(checkpoint.result?.worktree)
      assert.ok(readRecord(checkpoint.expectedSessionId)?.archived)
      assert.equal(existsSync(checkpoint.result.worktree.worktreePath), false)
    }
  }
  assert.equal(git(root, 'rev-parse', 'HEAD'), currentInput.headCommit)
  assert.equal(git(root, 'status', '--porcelain'), '')
})
