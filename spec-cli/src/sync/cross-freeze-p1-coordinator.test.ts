import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { sessionRecordPath } from '@spexcode/spec-core'
import { parseContract } from '@spexcode/spec-core/contracts'
import { nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { configuredSessionApplication } from '../session-application.js'
import { readRecord, writeRecord } from '../session-record.js'
import { StructuredSessionError, structuredExecutionPolicy } from '../session-structured-policy.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { readCodeBehaviorContext } from './code-behavior.js'
import { prepareP1ReviewChallenge, prepareSyncAdmission, runSyncOperation } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { CROSS_FREEZE_IMPACT_PURPOSE, type CrossFreezeImpactEvidence, type CrossFreezeImpactOutput } from './cross-freeze-impact-review.js'
import { p1ReviewDiagnosticEvidence, p1ReviewDiagnosticMarker } from './elaboration-review-challenge.js'
import { ELABORATION_BOUNDARIES, type ElaborationResult } from './elaboration-types.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef, P1ReviewChallenge, SyncAttempt } from './operation-types.js'
import { captureInputSnapshot, contentHash, readEvidence, writeEvidence } from './snapshot.js'
import { readStageDraft } from './stage-worktree.js'
import { SyncStore, SyncStoreError } from './store.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const targetPath = '.spec/export/export-contract/spec.md'
const sourcePath = 'src/export.js'
const stopBeforeGeneration = 'fixture reached P1 whole before generation'
const oldReviewFailure = 'fixture old read-only reviewer stopped without a verdict'
const digest = (value: unknown): string => contentHash(JSON.stringify(value))

for (const mode of ['old-approved', 'old-unapproved', 'current-reviewer-absent', 'prior-attempt-reviewer-present', 'prior-attempt-reviewer-absent', 'operator-challenge'] as const) test('跨冻结正式 P1 复用与冷验 ' + mode, async t => {
  const oldApproved = mode !== 'old-unapproved', operatorChallenge = mode === 'operator-challenge'
  const acrossAttempt = mode.startsWith('prior-attempt-') || operatorChallenge
  const testHome = process.env.SPEXCODE_TEST_HOME
  assert.ok(testHome, '正式会话夹具必须通过 test-home 隔离')
  assert.equal(process.env.SPEX_SESSION_DATABASE_PATH, join(testHome, 'sessions.sqlite'))
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sync-cross-freeze-p1-coordinator-')))
  const root = join(parent, 'source'), managedRoot = join(parent, 'managed'), artifactRoot = join(parent, 'artifacts')
  cpSync(fixture, root, { recursive: true })
  mkdirSync(managedRoot, { mode: 0o700 })
  mkdirSync(artifactRoot, { mode: 0o700 })
  const previousCwd = process.cwd(), dbPath = join(parent, 'sync.sqlite')
  let protocol = openProtocol(dbPath)
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
  const commit = (message: string) => {
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', message)
    assert.equal(git(root, 'status', '--porcelain'), '')
  }
  writeFileSync(join(root, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', harnesses: [] }), 'utf8')
  git(root, 'init', '-q', '-b', 'main')
  commit('old clean committed initial')
  process.chdir(root)
  const oldInput = await captureInputSnapshot(root, { committed: true }), commonDir = oldInput.source.commonDir
  const read = <T>(ref: BlobRef): T => JSON.parse(readEvidence(commonDir, ref).toString('utf8'))
  let store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const reopen = () => {
    protocol.close()
    protocol = openProtocol(dbPath)
    store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  }
  const targetSource = readFileSync(join(root, targetPath), 'utf8')
  const contract = parseContract({ nodeId: 'export-contract', path: targetPath, source: targetSource }).contract!
  const environment = { version: 'trusted-test-v1', image: 'node@sha256:' + 'a'.repeat(64), platform: 'linux/arm64',
    memoryBytes: 10_000_000, cpus: 1, pidsLimit: 64, scratchBytes: 1_000_000, logBytes: 100_000 } as const
  const verifications = contract.items.filter(item => item.kind === 'VERIFY')
    .map(({ id, command, cwd, timeoutMs }) => ({ definition: { id, command, cwd, timeoutMs }, environment }))
  const plan: SyncCoordinatorPlan = {
    version: 'sync-coordinator-v2', direction: 'code_to_spec', agentWorkflow: 'native-worktree-v1',
    intentNodeId: 'export-contract', sourcePaths: [sourcePath], readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec'],
    targets: [{ nodeId: 'export-contract', path: targetPath }], facts: [{ source: 'decision:EXPORT-POLICY', text: targetSource }], verifications, mandatoryTests: [],
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 32768, maxParallel: 1 },
  }
  const admit = async (input: typeof oldInput, name: string) => {
    const executionScope = { paths: [targetPath, sourcePath], contractIds: [], flowIds: [] }
    const selected = operatorChallenge ? store.readBaselineSelection(input.source, executionScope.paths.map(path => ({ kind: 'path' as const, path }))) : undefined
    if (selected && !('selection' in selected)) assert.fail(selected.failure.message)
    const next = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, {
      ingressKey: name, rootCauseId: name, origin: 'initial', budget: { maxAttempts: acrossAttempt ? 2 : 1, maxCalls: 24, maxRepairs: 0, timeoutMs: 120_000 },
      managedRoot, model: 'claude:default', ...(selected ? { baselineSelection: selected.selection, executionScope } : {}),
    }))
    assert.equal(next.retryOf, undefined)
    return store.ackDispatch(input.source.repositoryId, next.dispatchMessageId)
  }
  const stages = (attempt: SyncAttempt) => new Map(attempt.checkpointRefs.flatMap(ref => {
    const wrapper = read<{ stage?: string; resultRef: BlobRef }>(ref)
    return wrapper.stage ? [[wrapper.stage, wrapper.resultRef] as const] : []
  }))
  const calls: { operationId: string; purpose: string; sessionId: string; impact?: 'p0' | 'p1' }[] = []
  const old = await admit(oldInput, 'p1-old-initial')
  let active = old
  let challenge: P1ReviewChallenge | undefined
  let rejectedReviewSeed: { baseCommit: string; tree: string; mode: 'read' } | undefined
  const options: SyncCoordinatorOptions = {
    plan, readCurrentPlan: () => plan, managedRoot, artifactRoot,
    tools: { trustedRuntimeRoot: parent, toolEntry: join(parent, 'unused'), canonicalHooksDir: join(parent, 'unused-hooks') },
    nativeExecution: { pollMs: 2, runtime: {
      readRecord, cancel: async () => assert.fail('夹具禁止真实会话控制'),
      run: async request => {
        const seed = request.worktree!, createKey = request.sessionCreateKey!, sessionId = sessionIdForCreateKey(createKey)
        const threadId = 'thread-' + sessionId, turnId = 'turn-' + sessionId, branch = 'codex/cross-freeze-p1-fixture-' + sessionId
        const workspace = join(parent, sessionId)
        git(root, 'worktree', 'add', '-q', '-b', branch, workspace, seed.baseCommit)
        let output: unknown, draft: unknown, impact: 'p0' | 'p1' | undefined
        if (request.purpose === CROSS_FREEZE_IMPACT_PURPOSE) {
          assert.equal(seed.mode, 'read')
          const materialPath = git(workspace, 'ls-files', '.spex-sync-drafts').split('\n').find(path => path.endsWith('/review.json'))!
          const material = JSON.parse(readFileSync(join(workspace, materialPath), 'utf8')) as CrossFreezeImpactEvidence['binding']
            & { previous: { commit: string }; current: { commit: string }; changes: { path: string }[]; approvalFile: string | null }
          impact = material.stage
          assert.deepEqual(material.changes.map(change => change.path), [sourcePath])
          assert.match(readFileSync(join(workspace, dirname(materialPath), 'changes.diff'), 'utf8'), /H2 comment only/)
          assert.equal(material.previous.commit, oldInput.headCommit)
          assert.equal(material.current.commit, active.input.headCommit)
          if (impact === 'p1') {
            const originalRows = JSON.parse(readFileSync(join(workspace, dirname(materialPath), 'candidate.json'), 'utf8')) as { version: string }
            assert.equal(originalRows.version, 'elaboration-target-rows-v3')
            assert.equal(material.approvalFile !== null, oldApproved)
            if (material.approvalFile) {
              const originalApproval = JSON.parse(readFileSync(join(workspace, dirname(materialPath), material.approvalFile), 'utf8')) as ElaborationResult
              assert.equal(originalApproval.structurePassed, true)
              assert.equal(originalApproval.reviewPassed, true)
            }
          }
          output = { inputDigest: request.inputDigest, verdict: 'reuse',
            history: { previousCommit: material.previous.commit, currentCommit: material.current.commit, evidence: sourcePath, reason: 'ExportService behavior is unchanged.' },
            paths: material.changes.map(({ path }) => ({ path, verdict: 'reuse', evidence: path + '#ExportService', reason: 'Only a source comment changed.' })),
          } satisfies CrossFreezeImpactOutput
        } else if (request.purpose.startsWith('code_behavior_')) {
          const { task, pendingAnalysis } = readCodeBehaviorContext(request, commonDir)
          const paths = task.requiredChangedPaths as string[], rule = 'RULE-EXPORT-05'
          draft = pendingAnalysis ? {
            inputDigest: request.inputDigest, analysisDigest: pendingAnalysis.analysisDigest, verdict: 'accept',
            checkedPaths: paths, checkedChangeIds: pendingAnalysis.analysis.changes.map(change => change.id), findings: [],
          } : { changes: paths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [rule], ruleIds: [rule],
            originalIntent: '保留原业务', previousBehavior: '保留权限、异步状态和交付行为', sourceBehavior: '现有重构不变更原业务语义',
            deliveryBehavior: '保留原交付行为', evidence: path, counterexample: '保留原任务权限和既有状态事件' })),
          facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
        } else if (request.purpose === 'elaboration_generate') {
          draft = { version: 'elaboration-target-rows-v3', changes: [],
            applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '现有冻结契约逐值保留', affectedIds: [] })) }
        } else {
          assert.equal(request.purpose, 'elaboration_review')
          assert.equal(seed.mode, 'read')
          assert.equal(readFileSync(join(workspace, targetPath), 'utf8'), targetSource)
          if (active.id !== old.id) assert.match(readFileSync(join(workspace, sourcePath), 'utf8'), /H2 comment only/)
          if (operatorChallenge && active.id !== old.id && !challenge) {
            rejectedReviewSeed = { ...seed, mode: 'read' }
            output = { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{
              code: 'verify-test-reference', kind: 'repair', affectedIds: ['REQ-EXPORT-01'], message: '复查验收的测试引用',
              evidence: 'tests/export.test.mjs 与候选契约', decision: '核对原绑定',
            }] }
          } else {
            if (challenge) {
              assert.match(request.prompt, new RegExp(p1ReviewDiagnosticMarker(challenge.diagnosticRef)))
              assert.deepEqual(seed, rejectedReviewSeed, '正式复审必须读取原候选的同一 Git 树')
            }
            output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
          }
        }
        if (draft) {
          assert.equal(seed.mode, 'edit')
          const draftPath = /草稿文件=([^\s；]+)/.exec(request.prompt)?.[1]
          assert.ok(draftPath)
          mkdirSync(dirname(join(workspace, draftPath)), { recursive: true })
          writeFileSync(join(workspace, draftPath), JSON.stringify(draft, null, 2) + '\n', 'utf8')
          git(workspace, 'add', draftPath)
          git(workspace, 'commit', '-qm', 'Native P1 fixture draft')
          output = { summary: 'Native fixture committed its Git draft' }
        }
        calls.push({ operationId: active.id, purpose: request.purpose, sessionId, ...(impact ? { impact } : {}) })
        const worktree = nativeWorktreeResult(workspace, seed), resultDigest = digest(output)
        const execution = structuredExecutionPolicy(request)
        const fails = active.id === old.id && !oldApproved && request.purpose === 'elaboration_review'
        configuredSessionApplication().createSession({ sessionId, status: 'awaiting' })
        writeRecord({ session: sessionId, governed: true, worktreePath: workspace, base: seed.baseCommit, forkCommit: seed.baseCommit, branch,
          title: null, name: null, parent: null, issues: [], issue: null, proposal: null, merges: 0, note: null, sortKey: null,
          createdAt: Date.now(), harness: 'claude', harnessSessionId: threadId, runtimeStartToken: null, status: 'awaiting',
          stopped: false, archived: false, closedAt: null, launcher: null, launchCmd: null, launchOwner: null,
          createRequestId: contentHash(createKey), createPayloadHash: digest({ prompt: nativeWorktreePrompt(request.prompt, seed), parent: null, launcher: null, base: seed.baseCommit, structuredExecution: execution }),
          structuredExecution: fails ? { ...execution, state: 'failed', threadId, turnId,
            errorCode: 'native_rpc_timeout', error: oldReviewFailure,
            cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' },
          } : { ...execution, state: 'completed', threadId, turnId, output, resultDigest, resultWorktree: worktree },
        })
        if (fails) throw new StructuredSessionError('native_rpc_timeout', oldReviewFailure, { sessionId, threadId, turnId })
        return { sessionId, threadId, turnId, output, resultDigest, worktree }
      },
    } },
  }
  let interruptAfter: string | undefined
  const runUntilP1 = async () => {
    const checkpoint = store.checkpoint.bind(store)
    store.checkpoint = (fence, ref) => {
      const saved = checkpoint(fence, ref), stage = read<{ stage?: string }>(ref).stage
      if (stage && stage === interruptAfter) throw new SyncStoreError('SYNC_FENCE_EXPIRED', 'fixture exits after saving ' + stage)
      if (stage === 'elaboration') throw new StructuredSessionError('unsupported', stopBeforeGeneration)
      return saved
    }
    try { return await runSyncOperation(store, active.id, options) }
    finally { store.checkpoint = checkpoint }
  }
  const first = await runUntilP1()
  assert.equal(first.failure?.message, stopBeforeGeneration, JSON.stringify({ failure: first.failure, calls, stages: [...stages(store.listAttempts(old.id)[0]).keys()] }))
  assert.equal(first.operation.phase, 'failed')
  assert.deepEqual(calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review', 'elaboration_generate', 'elaboration_review'])
  const [oldAttempt] = store.listAttempts(old.id), oldStages = stages(oldAttempt)
  const oldStage = [...oldStages].find(([key]) => /^partition:[^:]+:elaboration$/.test(key))
  assert.ok(oldStage)
  const [localKey, oldRef] = oldStage, original = read<ElaborationResult>(oldRef), oldRound = original.rounds.at(-1)!
  assert.equal(original.structurePassed, true)
  assert.equal(original.reviewPassed, oldApproved)
  assert.ok(oldRound.draft)
  assert.ok(oldApproved ? oldRound.review?.verdict === 'accept' : oldRound.review === null && oldRound.reviewOutput === null)
  assert.ok(store.listResources(oldAttempt.id).every(resource => resource.phase === 'removed'))
  assert.equal(store.readRetryEligibility(old.id).eligible, true)
  const oldDraft = readStageDraft(commonDir, oldRound.draft, oldRound.draft)

  writeFileSync(join(root, sourcePath), readFileSync(join(root, sourcePath), 'utf8') + '\n// H2 comment only\n', 'utf8')
  commit('new clean committed initial')
  const currentInput = await captureInputSnapshot(root, { committed: true })
  reopen()
  active = await admit(currentInput, 'p1-current-initial')
  const oldBefore = { operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(oldAttempt.id) }
  assert.equal(oldBefore.operation.phase, 'superseded')
  const currentCalls = () => calls.filter(call => call.operationId === active.id)
  const impactKey = localKey + ':cross-freeze-impact'
  interruptAfter = impactKey
  const interrupted = await runUntilP1()
  assert.equal(interrupted.status, 'recovery_required', JSON.stringify(interrupted.failure))
  assert.equal(interrupted.failure?.code, 'SYNC_FENCE_EXPIRED')
  assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1'])
  assert.ok(stages(store.listAttempts(active.id)[0]).has(impactKey))
  interruptAfter = localKey
  reopen()

  const approvalInterrupted = await runUntilP1()
  assert.equal(approvalInterrupted.status, 'recovery_required', JSON.stringify(approvalInterrupted.failure))
  assert.equal(approvalInterrupted.failure?.code, 'SYNC_FENCE_EXPIRED')
  assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1', 'elaboration_review'])
  const approvedRef = stages(store.listAttempts(active.id)[0]).get(localKey)
  assert.ok(approvedRef)
  interruptAfter = undefined
  if (acrossAttempt) assert.equal(store.requestControl(active.id, 'pause').phase, 'paused')
  if (acrossAttempt && !operatorChallenge) assert.equal(store.requestControl(active.id, 'run').phase, 'queued')
  reopen()

  const current = read<ElaborationResult>(approvedRef)
  const round = current.rounds.at(-1)!
  if (operatorChallenge) {
    const paused = store.readOperation(active.id)
    assert.equal(current.structurePassed, true)
    assert.equal(current.reviewPassed, false)
    assert.equal(current.failure?.code, 'repair_budget_exhausted')
    assert.equal(round.review?.verdict, 'repair')
    assert.equal(round.crossFreezeAuthor?.oldInputDigest, original.inputDigest)
    assert.notEqual(current.inputDigest, round.crossFreezeAuthor?.oldInputDigest)
    assert.deepEqual(round.traces[0], oldRound.traces[0])
    assert.ok(round.traces[1] && rejectedReviewSeed)
    const reviewerRecord = readRecord(round.traces[1].sessionId)
    const reviewed = reviewerRecord?.structuredExecution
    assert.ok(reviewerRecord && reviewed?.state === 'completed' && reviewed.resultWorktree)
    const origin = store.listAttempts(active.id)[0]
    assert.ok(store.listResources(origin.id).every(resource => resource.phase === 'removed'))
    assert.ok(current.partitionBinding && current.candidateDigest)
    const request = { operationId: active.id, requestId: 'cross-freeze-p1-operator-fixture',
      expectedRevision: paused.revision, inputId: currentInput.id, partitionId: current.partitionBinding.partitionId,
      resultRef: approvedRef, candidateDigest: current.candidateDigest, diagnostic: '追溯冻结测试及原有验收字段',
      evidencePaths: ['tests/export.test.mjs'],
    }
    const previous = readEvidence(commonDir, approvedRef)
    challenge = await prepareP1ReviewChallenge(store, paused, plan, request)
    assert.equal(challenge.origin.attemptId, origin.id)
    assert.deepEqual(challenge.resultRef, approvedRef)
    await assert.rejects(prepareP1ReviewChallenge(store, paused, plan, { ...request, evidencePaths: ['missing-proof.js'] }), /复审证据须在原独审冻结 Git 树/)
    try {
      writeRecord({ ...reviewerRecord, structuredExecution: { ...reviewed, resultWorktree: { ...reviewed.resultWorktree, tree: oldRound.draft.resultTree } } })
      await assert.rejects(prepareP1ReviewChallenge(store, paused, plan, request), /局部结果缺少合法作者及已完成的独立只读拒绝/)
    } finally {
      writeRecord(reviewerRecord)
    }
    assert.deepEqual(writeEvidence(commonDir, p1ReviewDiagnosticEvidence(request)), challenge.diagnosticRef)
    store.authorizeP1ReviewChallenge(active.id, challenge)
    assert.equal(store.requestControl(active.id, 'run').phase, 'queued')
    reopen()
    const resumed = await runUntilP1()
    assert.equal(resumed.failure?.message, stopBeforeGeneration, JSON.stringify(resumed.failure))
    assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1', 'elaboration_review', 'elaboration_review'])
    const [first, next] = store.listAttempts(active.id)
    assert.ok(next)
    assert.deepEqual(stages(first).get(localKey), approvedRef)
    assert.deepEqual(readEvidence(commonDir, approvedRef), previous)
    assert.ok(store.listResources(next.id).every(resource => resource.phase === 'removed'))
    const nextResult = read<ElaborationResult>(stages(next).get(localKey)!), nextRound = nextResult.rounds.at(-1)!
    assert.equal(nextResult.reviewPassed, true)
    assert.equal(nextResult.candidateDigest, current.candidateDigest)
    assert.deepEqual(nextRound.draft, round.draft)
    assert.deepEqual(nextRound.output, round.output)
    assert.deepEqual(nextRound.traces[0], round.traces[0])
    assert.deepEqual(nextRound.crossFreezeAuthor, round.crossFreezeAuthor)
    assert.notEqual(nextRound.traces[1].sessionId, round.traces[1].sessionId)
    assert.deepEqual({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(oldAttempt.id) }, oldBefore)
    assert.equal(git(root, 'status', '--porcelain'), '')
    return
  }
  if (mode === 'current-reviewer-absent' || mode === 'prior-attempt-reviewer-absent') {
    const reviewer = round.traces.find(trace => trace.purpose === 'elaboration_review')!
    assert.ok(reviewer && round.crossFreezeAuthor)
    const reviewerPath = realpathSync(sessionRecordPath(reviewer.sessionId)), backup = join(parent, 'current-reviewer.runtime.json')
    assert.ok(reviewerPath.startsWith(realpathSync(testHome) + sep), '只修改此 test-home 内的实际 reviewer 原件')
    assert.equal(readRecord(reviewer.sessionId)?.structuredExecution?.state, 'completed')
    const savedBytes = readFileSync(reviewerPath)
    const before = store.listAttempts(active.id)[0], beforeStages = stages(before)
    const impactRef = beforeStages.get(impactKey)!
    const evidenceRefs = [approvedRef, oldRef, impactRef]
    const evidenceBefore = evidenceRefs.map(ref => readEvidence(commonDir, ref))
    renameSync(reviewerPath, backup)
    try {
      assert.equal(readRecord(reviewer.sessionId)?.structuredExecution, undefined)
      assert.equal(readRecord(round.traces[0].sessionId)?.structuredExecution?.state, 'completed')
      const rejected = await runUntilP1()
      assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1', 'elaboration_review'])
      const recoveredAttempts = store.listAttempts(active.id)
      assert.equal(recoveredAttempts.length, acrossAttempt ? 2 : 1, JSON.stringify(rejected.failure))
      const resumedStages = stages(recoveredAttempts.at(-1)!)
      assert.equal(resumedStages.has('elaboration'), false, '缺少当前 reviewer 原件时不得进入 P1 全树封口')
      assert.equal(rejected.failure?.code, 'cross_freeze_p1_approval_binding', JSON.stringify(rejected.failure))
      if (acrossAttempt) {
        assert.equal(resumedStages.has(localKey), false, '新 attempt 不得保存缺原件的当前已审候选')
        assert.equal(resumedStages.has(localKey + ':provenance'), false, '新 attempt 不得登记缺原件的当前审批来源')
      }
      const originalStages = stages(recoveredAttempts[0])
      assert.deepEqual(originalStages.get(localKey), approvedRef)
      assert.deepEqual(originalStages.get(impactKey), impactRef)
      assert.deepEqual(evidenceRefs.map(ref => readEvidence(commonDir, ref)), evidenceBefore)
      assert.deepEqual({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(oldAttempt.id) }, oldBefore)
    } finally {
      renameSync(backup, reviewerPath)
      assert.deepEqual(readFileSync(reviewerPath), savedBytes)
    }
    return
  }

  const second = await runUntilP1()
  assert.equal(second.failure?.message, stopBeforeGeneration, JSON.stringify(second.failure))
  const attempts = store.listAttempts(active.id)
  assert.equal(attempts.length, acrossAttempt ? 2 : 1, JSON.stringify(second.failure))
  const attempt = attempts.at(-1)!, currentStages = stages(attempt)
  assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1', 'elaboration_review'])
  assert.ok(attempts.every(item => store.listResources(item.id).every(resource => resource.phase === 'removed')))
  assert.deepEqual(currentStages.get(localKey), approvedRef, '冷验保持精确当前 P1 审查的 resultRef')
  const impactRef = stages(attempts[0]).get(impactKey)!
  const impact = read<{ evidence: CrossFreezeImpactEvidence }>(impactRef).evidence
  assert.equal(current.structurePassed, true); assert.equal(current.reviewPassed, true)
  assert.equal(round.crossFreezeAuthor?.oldInputId, old.input.id)
  assert.equal(round.crossFreezeAuthor?.oldOperationId, old.id)
  assert.equal(round.crossFreezeAuthor?.oldAttemptId, oldAttempt.id)
  assert.deepEqual(round.crossFreezeAuthor?.oldResultRef, oldRef)
  assert.deepEqual(round.crossFreezeAuthor?.impactReviewRef, impactRef)
  assert.deepEqual(round.draft, oldRound.draft)
  assert.deepEqual(round.output, oldRound.output)
  assert.deepEqual(round.traces[0], oldRound.traces[0])
  assert.equal(impact.verdict, 'reuse')
  assert.notEqual(current.inputDigest, original.inputDigest)
  assert.notEqual(round.traces[1].sessionId, oldRound.traces[0].sessionId)
  assert.notEqual(round.traces[1].sessionId, impact.trace.sessionId)
  assert.equal(round.review?.inputDigest, current.inputDigest)
  assert.equal(round.review?.candidateDigest, current.candidateDigest)
  assert.equal(readStageDraft(commonDir, round.draft!, oldRound.draft), oldDraft)
  assert.deepEqual(read<ElaborationResult>(oldRef), original)
  assert.deepEqual({ operation: store.readOperation(old.id), attempts: store.listAttempts(old.id), resources: store.listResources(oldAttempt.id) }, oldBefore)
  assert.equal(git(root, 'rev-parse', 'HEAD'), currentInput.headCommit)
  assert.equal(git(root, 'status', '--porcelain'), '')
})
