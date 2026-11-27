import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { managedModel, type ManagedRoute } from '../llm-manager-route.js'
import { nativeWorktreePrompt } from '../native-worktree-runtime.js'
import { structuredExecutionPolicy } from '../session-structured-policy.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { lockCrossFreezeSource } from './cross-freeze-binding.js'
import { CROSS_FREEZE_IMPACT_PURPOSE, prepareCrossFreezeImpactReview, restoreCrossFreezeImpactReview, verifyCrossFreezeImpactReview, type CrossFreezeImpactOutput } from './cross-freeze-impact-review.js'
import type { ElaborationSessionResult } from './elaboration-types.js'
import { migrateSyncStore } from './migrations.js'
import { createAttemptRunner, type NativeRunCheckpoint, type NativeRunPlan, type NativeRunRecord } from './native-run.js'
import type { InputSnapshot } from './operation-types.js'
import { captureInputSnapshot, contentHash, readEvidence, writeEvidence } from './snapshot.js'
import { overlayStageTree, stageWorktree } from './stage-worktree.js'
import { SyncStore } from './store.js'

const anchor = { routeId: '1'.repeat(64), vendor: 'claude', model: 'fixture-review-anchor', kind: 'cli' } satisfies ManagedRoute
const managedReviewer = { ...anchor, routeId: '2'.repeat(64), model: 'fixture-review' } satisfies ManagedRoute
const hash = (value: unknown): string => contentHash(JSON.stringify(value))
const spec = '.spec/demo/spec.md'
const shared = '共享\t路径\n.mjs'
const older = 'OLD_SOURCE_FIXTURE'
const newer = 'NEW_SOURCE_FIXTURE'

async function fixture(t: TestContext, changed = true) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-cross-freeze-impact-')), root = join(directory, 'source')
  mkdirSync(join(root, '.spec', 'demo'), { recursive: true })
  const protocol = openProtocol(join(directory, 'sync.sqlite'))
  t.after(() => { protocol.close(); rmSync(directory, { recursive: true, force: true }) })
  await migrateSyncStore(protocol, { backupPath: join(directory, 'initial.backup') })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trimEnd()
  const write = (path: string, text: string) => writeFileSync(join(root, path), text)
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'freeze', '--allow-empty') }
  git('init', '-q', '-b', 'main')
  git('config', 'core.fileMode', 'true')
  write(spec, '# Demo\n\n## raw source\n\nPreserve current behavior.\n\n## expanded spec\n\nCurrent fixture.\n')
  write(shared, `export const shared = '${older}'\n`)
  write('removed.mjs', 'export function registerFormerTest() {}\n')
  write('discover.sh', '#!/bin/sh\n')
  commit()
  const previous = await captureInputSnapshot(root, { committed: true }), commonDir = previous.source.commonDir
  const put = (value: unknown) => writeEvidence(commonDir, value)
  const store = new SyncStore(protocol, { readBlob: ref => readEvidence(commonDir, ref) })
  const scope = { paths: [spec], contractIds: [], flowIds: [] }
  const planBlob = put({ version: 'sync-coordinator-v2', intentNodeId: 'demo', targets: [{ nodeId: 'demo', path: spec }] })
  const admit = (input: InputSnapshot, name: string) => store.admitAndEnqueue({
    origin: 'initial', rootCauseId: name, ingressKey: name, input, scope, planBlob, policyDigest: planBlob.sha256,
    readSetDigest: 'fixture-read', impactDigest: 'fixture-impact', budget: { mode: 'unlimited' }, delivery: null, model: managedModel(anchor),
    deliveryPlan: { canonicalRoot: input.source.canonicalRoot, branch: input.source.branch, baseCommit: input.headCommit },
  })
  const claim = (operation: ReturnType<typeof admit>) => store.claimAttempt({ operationId: operation.id, source: operation.input.source, scope, leaseMs: 60_000 })
  const from = claim(admit(previous, 'old'))
  store.bindComposedInput(from.fence, { sourceInputId: previous.id, previousBaselinePairId: null, tree: previous.immutableTree, manifestBlob: previous.manifestBlob, contentDigest: previous.contentDigest })
  store.checkpoint(from.fence, put({ operationId: from.operation.id, attemptId: from.attempt.id }))
  store.recordFailure(from.fence, { code: 'fixture_failure', message: 'settled', kind: 'unsupported', evidenceRefs: [] })
  if (changed) {
    write(shared, `export const shared = '${newer}'\n`)
    rmSync(join(root, 'removed.mjs'))
    write('registered.test.mjs', 'export function registerNextTest() {}\n')
    chmodSync(join(root, 'discover.sh'), 0o755)
  }
  commit()
  const admitted = admit(await captureInputSnapshot(root, { committed: true }), 'current')
  const locked = lockCrossFreezeSource(store, admitted, { load: () => null, save: ref => ref })
  assert.ok(locked.source, 'fixture sources must satisfy the actual lock')
  const current = claim(admitted)
  const author = { sessionId: 'old-author', threadId: 'old-author-thread', turnId: 'old-author-turn' }
  const reviewer = { sessionId: 'old-review', threadId: 'old-review-thread', turnId: 'old-review-turn' }
  const candidate = { changes: [{ path: spec, source: 'original authored contents' }] }
  const approval = { candidateDigest: hash(candidate), verdict: 'accept', reviewer }
  const tree = overlayStageTree(commonDir, admitted.input.immutableTree, [{ path: 'current-parent-context.txt', source: 'Existing current stage context.' }])
  const input = {
    operation: current.operation, attemptId: current.attempt.id, source: locked.source, owner: 'demo-partition', stage: 'p1' as const,
    prior: { attemptId: from.attempt.id, candidateDigest: hash(candidate), resultRef: put(candidate), approvalRef: put(approval), author, reviewer },
    seed: stageWorktree(commonDir, admitted.input.headCommit, tree), timeoutMs: null, readPaths: [spec],
  }
  return { input, store, current, root, git, candidate, approval }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
type Prepared = ReturnType<typeof prepareCrossFreezeImpactReview>

function outputFor(f: Fixture, prepared: Prepared): CrossFreezeImpactOutput {
  const { previous, current } = f.input.source.provenance
  return {
    inputDigest: prepared.request.inputDigest, verdict: 'reuse',
    history: { previousCommit: previous.commit, currentCommit: current.commit, evidence: `${spec} has the same raw source and author change`, reason: 'The same read-only contract governs the fixture owner.' },
    paths: prepared.changedPaths.map(path => ({ path, verdict: 'reuse', evidence: `Observed the recorded mode or content for ${path}`, reason: 'The owner module never leads to this fixture path.' })),
  }
}

function nativeResult(f: Fixture, prepared: Prepared, output: unknown = outputFor(f, prepared)): ElaborationSessionResult {
  const { baseCommit, tree } = prepared.request.worktree
  return { sessionId: 'new-review', threadId: 'new-review-thread', turnId: 'new-review-turn', output, resultDigest: hash(output),
    worktree: { baseCommit, baseTree: tree, headCommit: baseCommit, tree, worktreePath: join(f.root, 'review-checkout') } }
}

test('readonly Manager runner freezes original refs and every changed object in the actual current stage', async t => {
  const f = await fixture(t), prepared = prepareCrossFreezeImpactReview(f.input), { request } = prepared
  const files = f.git('ls-tree', '-r', '--name-only', request.worktree.tree, '.spex-sync-drafts').split('\n')
  assert.equal(files.length, 4)
  const show = (name: string) => f.git('show', `${request.worktree.tree}:${files.find(path => path.endsWith(`/${name}`))}`)
  const material = JSON.parse(show('review.json'))
  assert.deepEqual(material.changes, f.input.source.provenance.changes)
  assert.deepEqual(material.readPaths, [spec])
  assert.equal(material.provenanceDigest, f.input.source.provenance.digest)
  assert.deepEqual(material.previous, f.input.source.provenance.previous)
  assert.deepEqual(material.current, f.input.source.provenance.current)
  assert.equal(show('candidate.json'), JSON.stringify(f.candidate))
  assert.equal(show('approval.json'), JSON.stringify(f.approval))
  assert.equal(show('changes.diff'), f.input.source.provenance.patch.trimEnd())
  assert.match(show('changes.diff'), /OLD_SOURCE_FIXTURE[\s\S]*NEW_SOURCE_FIXTURE/)
  assert.match(show('changes.diff'), /old mode 100644\nnew mode 100755/)
  assert.deepEqual(prepared.changedPaths, ['discover.sh', 'registered.test.mjs', 'removed.mjs', shared])
  assert.equal(f.git('show', `${request.worktree.tree}:current-parent-context.txt`), 'Existing current stage context.')
  assert.equal(f.git('status', '--short'), '')
  assert.doesNotMatch(JSON.stringify(request), /OLD_SOURCE_FIXTURE|NEW_SOURCE_FIXTURE|registerFormerTest|registered\.test\.mjs/u)
  assert.deepEqual(prepareCrossFreezeImpactReview(f.input).request, request)
  const beforeRefs = f.git('for-each-ref', 'refs/spex-sync/seeds')
  const restored = restoreCrossFreezeImpactReview(f.input, request.worktree)
  assert.deepEqual(restored.request, request)
  assert.throws(() => restoreCrossFreezeImpactReview({ ...f.input, readPaths: [shared] }, request.worktree), /不匹配原材料/)
  assert.throws(() => restoreCrossFreezeImpactReview(f.input, { ...request.worktree, mode: 'edit' }), /没有原阶段证据提交/)
  assert.equal(f.git('for-each-ref', 'refs/spex-sync/seeds'), beforeRefs)

  const reviewCheckout = join(f.root, '..', 'review-checkout')
  f.git('worktree', 'add', '-q', '--detach', reviewCheckout, request.worktree.baseCommit)
  assert.equal(readFileSync(join(reviewCheckout, files.find(path => path.endsWith('/changes.diff'))!), 'utf8'), f.input.source.provenance.patch)
  let record: NativeRunRecord | undefined
  const runner = createAttemptRunner(f.store, f.current.fence, {
    resolveManagedRoute: async route => { assert.deepEqual(route, anchor); return managedReviewer },
    runtime: {
      run: async supplied => {
        assert.equal(supplied.model, managedModel(managedReviewer))
        assert.equal(supplied.worktree?.mode, 'read')
        const createKey = supplied.sessionCreateKey!, execution = structuredExecutionPolicy(supplied)
        const output = outputFor(f, prepared)
        const fixtureResult = nativeResult(f, prepared, output)
        const result = { ...fixtureResult, sessionId: sessionIdForCreateKey(createKey), worktree: { ...fixtureResult.worktree!, worktreePath: reviewCheckout } }
        record = { session: result.sessionId, status: 'awaiting', harnessSessionId: result.threadId, worktreePath: reviewCheckout, createRequestId: contentHash(createKey),
          createPayloadHash: hash({ prompt: nativeWorktreePrompt(supplied.prompt, request.worktree), parent: null, launcher: null, base: request.base, structuredExecution: execution }),
          structuredExecution: { ...execution, state: 'completed', threadId: result.threadId, turnId: result.turnId, output, resultDigest: result.resultDigest, resultWorktree: result.worktree } }
        return result
      },
      cancel: async () => assert.fail('successful read unexpectedly cancelled'),
      readRecord: id => record?.session === id ? record : null,
    },
  })
  const result = await runner(request)
  const resource = f.store.findResource(f.current.attempt.id, request.requestKey)
  const dispatch = f.store.readAttempt(f.current.attempt.id).dispatchPlans.find(dispatch => dispatch.key === request.requestKey)
  assert.ok(resource && dispatch)
  assert.equal(resource.phase, 'removed')
  assert.equal(dispatch.purpose, CROSS_FREEZE_IMPACT_PURPOSE)
  const read = (ref: Parameters<typeof readEvidence>[1]) => JSON.parse(readEvidence(prepared.commonDir, ref).toString('utf8'))
  const plan: NativeRunPlan = read(resource.plan.planBlob), checkpoint: NativeRunCheckpoint = read(resource.checkpointRef)
  assert.equal(plan.requestDigest, dispatch.requestDigest)
  assert.deepEqual(checkpoint.session, dispatch.session)
  assert.ok(checkpoint.result)
  const evidence = verifyCrossFreezeImpactReview(prepared, result, { request: plan.request, result: checkpoint.result })
  assert.equal(evidence.verdict, 'reuse')
  assert.equal(evidence.trace.resultDigest, record?.structuredExecution?.resultDigest)
  assert.equal(evidence.binding.prior.operationId, f.input.source.operation.id)
  assert.equal(f.store.readOperation(f.input.source.operation.id).revision, f.input.source.operation.revision)
})

test('requires exact path coverage and independent canonical result even outside the old read set', async t => {
  const f = await fixture(t), prepared = prepareCrossFreezeImpactReview(f.input), { request } = prepared
  const output = outputFor(f, prepared), canonical = nativeResult(f, prepared, output)
  const verify = (result: ElaborationSessionResult, saved = result) => verifyCrossFreezeImpactReview(prepared, result, { request, result: saved })
  const paths = output.paths.map(path => path.path === 'registered.test.mjs'
    ? { ...path, verdict: 'affected' as const, evidence: 'registerNextTest adds a case to this owner through test discovery.', reason: 'The original approval covered only the former cases.' }
    : path)
  assert.equal(verify(nativeResult(f, prepared, { ...output, paths, verdict: 'affected' })).verdict, 'affected')
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, paths })), /结论矛盾/)
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, paths: paths.slice(1) })), /schema/)
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, paths: [...paths.slice(1), paths[1]] })), /逐项覆盖/)
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, paths: [{ ...paths[0], path: spec }, ...paths.slice(1)] })), /逐项覆盖/)
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, history: { ...output.history, reason: '  ' } })), /schema/)
  assert.throws(() => verify(nativeResult(f, prepared, { ...output, inputDigest: 'different-freeze' })), /schema/)
  assert.throws(() => verify({ ...canonical, resultDigest: 'invalid' }), /实际结果/)
  assert.throws(() => verify({ ...canonical, sessionId: 'impostor' }, canonical), /实际结果/)
  assert.throws(() => verify({ ...canonical, worktree: undefined }), /固定seed/)
  assert.throws(() => verifyCrossFreezeImpactReview(prepared, canonical, { request: { ...request, timeoutMs: 500 }, result: canonical }), /Native 派发/)
  for (const origin of [f.input.prior.author, f.input.prior.reviewer]) {
    assert.throws(() => verify({ ...canonical, sessionId: origin.sessionId }), /独立 Native/)
    assert.throws(() => verify({ ...canonical, threadId: origin.threadId }), /独立 Native/)
    assert.throws(() => verify({ ...canonical, turnId: origin.turnId }), /独立 Native/)
  }
})

test('empty delta still requires exact history and cannot move the request to another stage, owner, or input', async t => {
  const f = await fixture(t, false), prepared = prepareCrossFreezeImpactReview(f.input), { request } = prepared
  assert.deepEqual(prepared.changedPaths, [])
  assert.notEqual(f.input.source.provenance.previous.commit, f.input.source.provenance.current.commit)
  const output = outputFor(f, prepared), result = nativeResult(f, prepared, output)
  assert.equal(verifyCrossFreezeImpactReview(prepared, result, { request, result }).verdict, 'reuse')
  const noHistory = nativeResult(f, prepared, { inputDigest: request.inputDigest, verdict: 'reuse', paths: [] })
  assert.throws(() => verifyCrossFreezeImpactReview(prepared, noHistory, { request, result: noHistory }), /schema/)
  const sameHistory = nativeResult(f, prepared, { ...output, history: { ...output.history, previousCommit: output.history.currentCommit } })
  assert.throws(() => verifyCrossFreezeImpactReview(prepared, sameHistory, { request, result: sameHistory }), /schema/)
  for (const update of [{ owner: 'sibling' }, { stage: 'p0' as const }, { attemptId: 'sibling-attempt' }, { prior: { ...f.input.prior, candidateDigest: 'a'.repeat(64) } }]) {
    const other = prepareCrossFreezeImpactReview({ ...f.input, ...update })
    assert.notEqual(other.request.inputDigest, request.inputDigest)
    assert.throws(() => verifyCrossFreezeImpactReview(other, result, { request, result }), /Native 派发/)
  }
  const { previous } = f.input.source.provenance
  assert.throws(() => prepareCrossFreezeImpactReview({ ...f.input, seed: { baseCommit: previous.commit, tree: previous.tree, mode: 'read' } }), /当前冻结/)
  assert.throws(() => prepareCrossFreezeImpactReview({ ...f.input, prior: { ...f.input.prior, attemptId: 'unrelated-old-attempt' } }), /双冻结来源/)
  assert.throws(() => prepareCrossFreezeImpactReview({ ...f.input, source: { ...f.input.source, provenance: { ...f.input.source.provenance, digest: 'a'.repeat(64) } } }), /双冻结来源/)
})
