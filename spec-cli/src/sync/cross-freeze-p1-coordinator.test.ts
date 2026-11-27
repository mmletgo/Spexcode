import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { parseContract } from '@spexcode/spec-core/contracts'
import { nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { configuredSessionApplication } from '../session-application.js'
import { readRecord, writeRecord } from '../session-record.js'
import { StructuredSessionError, structuredExecutionPolicy } from '../session-structured-policy.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { readCodeBehaviorContext } from './code-behavior.js'
import { prepareSyncAdmission, runSyncOperation } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { CROSS_FREEZE_IMPACT_PURPOSE, type CrossFreezeImpactEvidence, type CrossFreezeImpactOutput } from './cross-freeze-impact-review.js'
import { ELABORATION_BOUNDARIES, type ElaborationResult } from './elaboration-types.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef, SyncAttempt } from './operation-types.js'
import { captureInputSnapshot, contentHash, readEvidence } from './snapshot.js'
import { readStageDraft } from './stage-worktree.js'
import { SyncStore, SyncStoreError } from './store.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const targetPath = '.spec/export/export-contract/spec.md'
const sourcePath = 'src/export.js'
const stopBeforeGeneration = 'fixture reached P1 whole before generation'
const oldReviewFailure = 'fixture old read-only reviewer stopped without a verdict'
const digest = (value: unknown): string => contentHash(JSON.stringify(value))

for (const oldApproved of [true, false]) test('跨冻结正式 P1 只承接原稿并执行当前独审 oldApproved=' + oldApproved, async t => {
  assert.ok(process.env.SPEXCODE_TEST_HOME, '正式会话夹具必须通过 test-home 隔离')
  assert.equal(process.env.SPEX_SESSION_DATABASE_PATH, join(process.env.SPEXCODE_TEST_HOME, 'sessions.sqlite'))
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
    const next = store.admitAndEnqueue(await prepareSyncAdmission(input, plan, {
      ingressKey: name, rootCauseId: name, origin: 'initial', budget: { maxAttempts: 1, maxCalls: 24, maxRepairs: 0, timeoutMs: 120_000 },
      managedRoot, model: 'claude:default',
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
          output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
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
  reopen()

  const second = await runUntilP1()
  assert.equal(second.failure?.message, stopBeforeGeneration, JSON.stringify(second.failure))
  const attempts = store.listAttempts(active.id)
  assert.equal(attempts.length, 1)
  const [attempt] = attempts, currentStages = stages(attempt)
  assert.deepEqual(currentCalls().map(call => call.impact ?? call.purpose), ['p0', 'code_behavior_review', 'p1', 'elaboration_review'])
  assert.ok(store.listResources(attempt.id).every(resource => resource.phase === 'removed'))
  assert.deepEqual(currentStages.get(localKey), approvedRef, '冷验保持精确当前 P1 审查的 resultRef')
  const current = read<ElaborationResult>(approvedRef)
  const round = current.rounds.at(-1)!
  const impactRef = currentStages.get(impactKey)!
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
