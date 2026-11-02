import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parseParts } from '@spexcode/spec-core/contracts'
import { StructuredSessionError, rejectedFinalOutput } from '../session-structured-policy.js'
import { nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { elaborate, elaborationDigest, verifyElaborationDraftCache } from './elaboration.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { captureInputSnapshot, contentHash, readObject, readTree, writeEvidence, writeObject, writeTree } from './snapshot.js'
import { captureStageDraft, overlayStageTree, readStageDraft, stageWorktree } from './stage-worktree.js'
import { syncCheckpointArtifacts } from './checkpoint-evidence.js'

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
const path = '.spec/export/export-contract/spec.md'
const rows = { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用已有冻结契约', affectedIds: [] })) }
const ancestorPath = '.spec/ancestor/spec.md'
const ancestor = (body: string): string => `---\ntitle: 上层接口\n---\n## raw source\n祖先原意\n\n## expanded spec\n${body}\n`

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sync-owner-draft-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  mkdirSync(dirname(join(root, ancestorPath)), { recursive: true }); writeFileSync(join(root, ancestorPath), ancestor('旧父接口'))
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'draft fixture'); git(root, 'config', 'user.email', 'draft@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  const snapshot = await captureInputSnapshot(root), commonDir = snapshot.source.commonDir, source = readFileSync(join(root, path), 'utf8')
  const input: ElaborationInput = { root, worktree: stageWorktree(commonDir, snapshot.headCommit, snapshot.immutableTree), historyInput: snapshot, draftProtocol: 'elaboration-draft-v1', requestKey: 'draft-round', intent: { nodeId: 'export-contract', rawSource: parseParts(source)!.rawSource! }, targets: [{ nodeId: 'export-contract', path, source, sourceDigest: elaborationDigest(source) }], context: [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('旧父接口') }], files: new Map(), maxRepairs: 1, implementationWritePaths: [] }
  const requests: ElaborationSessionRequest[] = [], workspaces: string[] = []
  const run = (generate: (request: ElaborationSessionRequest, workspace: string, draftPath: string) => string): ElaborationRunner => async request => {
    requests.push(request)
    const seed = request.worktree!
    assert.equal(seed.mode, request.purpose === 'elaboration_generate' ? 'edit' : 'read')
    const workspace = join(root, `wt-${requests.length}`); workspaces.push(workspace)
    git(root, 'worktree', 'add', '--detach', workspace, seed.baseCommit)
    if (request.purpose === 'elaboration_generate') {
      const draftPath = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
      assert.deepEqual(request.schema, { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] })
      const schemaPath = /草稿业务schema只读文件=([^；]+)/.exec(request.prompt)![1]
      assert.equal(JSON.parse(readFileSync(join(workspace, schemaPath), 'utf8')).type, 'object')
      assert.match(request.prompt, /禁止修改schema/)
      const text = generate(request, workspace, draftPath)
      mkdirSync(dirname(join(workspace, draftPath)), { recursive: true }); writeFileSync(join(workspace, draftPath), text)
      git(workspace, 'add', draftPath); git(workspace, 'commit', '--allow-empty', '-m', `draft ${requests.length}`)
    }
    const output = request.purpose === 'elaboration_generate' ? { summary: '已提交草稿' } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `draft-session-${requests.length}`, threadId: `draft-thread-${requests.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, seed) }
  }
  return { root, commonDir, snapshot, input, requests, workspaces, run }
}

for (const failure of ['syntax', 'schema'] as const) test(`P1真实Git草稿${failure}失败后原路径实际编辑，小回执不冒充业务JSON或Native失败`, async t => {
  const f = await fixture(t)
  const invalid = failure === 'syntax' ? `{"version":"elaboration-target-rows-v3",\n"changes": [ BROKEN 草稿${'x'.repeat(38_000)}\n` : JSON.stringify({ ...rows, applicability: 'INVALID_SCHEMA_BODY' })
  let generation = 0
  const result = await elaborate(f.input, { runner: f.run((request, workspace, draftPath) => {
    if (++generation === 2) {
      assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), invalid)
      assert.match(request.prompt, failure === 'syntax' ? /output_json/ : /output_schema/)
      assert.ok(!request.prompt.includes(invalid)); assert.ok(!request.prompt.includes('INVALID_SCHEMA_BODY'))
    }
    return generation === 1 ? invalid : JSON.stringify(rows)
  }) })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  const first = result.rounds[0], last = result.rounds[1]
  assert.equal(first.rejectedOutput, undefined); assert.deepEqual(first.output, { summary: '已提交草稿' }); assert.equal(first.candidate, null)
  assert.ok(first.findings.some(issue => issue.code === (failure === 'syntax' ? 'output_json' : 'output_schema')))
  assert.equal(readObject(f.commonDir, first.draft!.oid).toString('utf8'), invalid)
  assert.equal(git(f.root, 'rev-parse', `refs/spex-sync/drafts/${first.draft!.ownerDigest}/${first.draft!.resultCommit}`), first.draft!.resultCommit)
  assert.ok(!JSON.stringify(first).includes(invalid)); assert.equal(last.draft!.path, first.draft!.path)
  const checkpointRef = writeEvidence(f.commonDir, first)
  assert.deepEqual(syncCheckpointArtifacts(first, checkpointRef), [{ kind: 'json', ref: checkpointRef }])
  assert.deepEqual(readTree(f.commonDir, f.requests[2].worktree!.tree).filter(entry => entry.path.startsWith('.spex-sync-drafts/')), [])
  assert.ok(result.changes.every(change => change.path.startsWith('.spec/')))
  assert.deepEqual(readTree(f.commonDir, last.draft!.resultTree).filter(entry => !entry.path.startsWith('.spec/') && !entry.path.startsWith('.spex-sync-drafts/')), readTree(f.commonDir, f.snapshot.immutableTree).filter(entry => !entry.path.startsWith('.spec/')))
})

test('跨source/父上下文只迁移同owner草稿；新seed保留新父Spec、全部源码/tests对象与absence', async t => {
  const f = await fixture(t), invalid = '{ prior invalid draft, do not discard'
  const failed = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: f.run(() => invalid) })
  const oldDraft = structuredClone(failed.rounds[0].draft!), oldResult = JSON.stringify(failed)
  for (const workspace of f.workspaces) git(f.root, 'worktree', 'remove', workspace)
  writeFileSync(join(f.root, ancestorPath), ancestor('新父接口'))
  writeFileSync(join(f.root, 'src/new-source.mjs'), 'export const added = true\n'); chmodSync(join(f.root, 'src/new-source.mjs'), 0o755)
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'new frozen source and ancestor')
  const snapshot = await captureInputSnapshot(f.root)
  const nextInput = { ...f.input, requestKey: 'new-parent', historyInput: snapshot, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), context: [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('新父接口') }], maxRepairs: 0 }
  const next = await elaborate(nextInput, { draft: oldDraft, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), invalid)
    assert.equal(readFileSync(join(workspace, ancestorPath), 'utf8'), ancestor('新父接口'))
    assert.equal(readFileSync(join(workspace, 'src/new-source.mjs'), 'utf8'), 'export const added = true\n')
    assert.ok(!request.prompt.includes(invalid)); assert.match(request.prompt, /旧accept不继承/)
    return JSON.stringify(rows)
  }) })
  assert.equal(next.status, 'complete', JSON.stringify(next.failure)); assert.notEqual(next.inputDigest, failed.inputDigest)
  assert.equal(JSON.stringify(failed), oldResult); assert.equal(oldDraft.sourceInputId, f.snapshot.id); assert.equal(next.rounds[0].draft!.sourceInputId, snapshot.id)
  const resultTree = next.rounds[0].draft!.resultTree
  assert.equal(readTree(f.commonDir, resultTree).find(entry => entry.path === 'src/new-source.mjs')!.mode, '100755')
  assert.deepEqual(readTree(f.commonDir, resultTree).filter(entry => !entry.path.startsWith('.spex-sync-drafts/')), readTree(f.commonDir, snapshot.immutableTree))
  assert.equal(readStageDraft(f.commonDir, oldDraft, oldDraft), invalid)
})

test('历史失败原件仅复制为非权威草稿材料，不在prompt重答JSON、不改旧证据', async t => {
  const f = await fixture(t), source = '{ ORIGINAL_LEGACY_RAW_AND_NOT_AUTHORITY'
  const material = { source, errors: [{ code: 'structured_output_format_invalid', message: '原请求schema格式失败' }] }, original = JSON.stringify(material)
  const result = await elaborate({ ...f.input, maxRepairs: 0 }, { draftMaterial: material, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), source); assert.ok(!request.prompt.includes(source)); assert.match(request.prompt, /structured_output_format_invalid/)
    return JSON.stringify(rows)
  }) })
  assert.equal(result.status, 'complete'); assert.equal(JSON.stringify(material), original); assert.equal(result.repairDiagnostics, undefined)
})

test('草稿边界拒绝错owner/schema/path/ref/OID/seed以及Spec、源码、测试和其他owner修改', async t => {
  const f = await fixture(t), result = await elaborate(f.input, { runner: f.run(() => JSON.stringify(rows)) }), draft = result.rounds[0].draft!
  for (const patch of [{ ownerDigest: 'e'.repeat(64) }, { schemaDigest: 'e'.repeat(64) }, { path: '../escape.json' }, { resultCommit: 'e'.repeat(40) }, { oid: 'e'.repeat(40) }, { seed: { ...draft.seed, tree: draft.resultTree } }, { seed: { ...draft.seed, baseCommit: `refs/spex-sync/seeds/${draft.seed.baseCommit}` } }]) {
    assert.throws(() => readStageDraft(f.commonDir, { ...draft, ...patch }, draft))
  }
  for (const modified of [path, 'src/export.js', 'tests/export.test.mjs', draft.path.replace(/\.json$/, '.schema.json'), `.spex-sync-drafts/${'e'.repeat(64)}.json`]) {
    const seed = stageWorktree(f.commonDir, f.snapshot.headCommit, f.snapshot.immutableTree, 'edit')
    const tree = overlayStageTree(f.commonDir, seed.tree, [{ path: draft.path, source: '{}' }, { path: modified, source: 'unauthorized\n' }]), head = stageWorktree(f.commonDir, seed.baseCommit, tree).baseCommit
    assert.throws(() => captureStageDraft(f.commonDir, seed, { worktree: { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: head, tree, worktreePath: 'closed-worktree' } }, draft), /仅允许正常提交/)
  }
  assert.throws(() => overlayStageTree(f.commonDir, f.snapshot.immutableTree, [{ path: draft.path, source: '../outside', mode: '120000' }]), /普通文件/)
  const symlinkBytes = Buffer.from('../outside'), symlinkTree = writeTree(f.commonDir, [...readTree(f.commonDir, f.snapshot.immutableTree), { path: '.spex-sync-drafts', mode: '120000', oid: writeObject(f.commonDir, symlinkBytes), digest: contentHash(symlinkBytes) }])
  assert.throws(() => overlayStageTree(f.commonDir, symlinkTree, [{ path: draft.path, source: '{}' }]), /symlink/)
})


test('草稿业务schema合法但独审repair时继续原文件，审查错误不成为新事实或旧accept', async t => {
  const f = await fixture(t), firstText = JSON.stringify(rows)
  let generations = 0, reviews = 0
  const runner = f.run((request, workspace, draftPath) => {
    if (++generations === 2) {
      assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), firstText)
      assert.match(request.prompt, /draft-review-repair/); assert.ok(!request.prompt.includes(firstText))
    }
    return generations === 1 ? firstText : JSON.stringify({ ...rows, applicability: rows.applicability.map(item => ({ ...item, basis: '依据当前raw和冻结代码重新核实' })) })
  })
  const result = await elaborate(f.input, { runner: async request => {
    const native = await runner(request)
    if (request.purpose === 'elaboration_review' && ++reviews === 1) {
      const output = { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'draft-review-repair', kind: 'repair', message: '须重新核实当前边界依据', affectedIds: ['REQ-EXPORT-01'], evidence: '冻结代码和原意', decision: '核实并保留raw、原政策和只读范围' }] }
      return { ...native, output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    return native
  } })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.map(round => round.findings) }))
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review', 'elaboration_generate', 'elaboration_review'])
  assert.ok(result.rounds[0].draft!.errors.some(issue => issue.code === 'draft-review-repair'))
  assert.equal(result.rounds[0].review!.verdict, 'repair'); assert.equal(result.rounds[1].review!.verdict, 'accept')
  assert.notEqual(result.rounds[0].traces[0].sessionId, result.rounds[1].traces[1].sessionId)
})

test('分区checkpoint按owner承接草稿且跨父输入重派；当前局部accept缓存摘要失配仍拒绝', async t => {
  const { elaborateSyncPartitions } = await import('./partition-execution.js')
  const f = await fixture(t), paths = readTree(f.commonDir, f.snapshot.immutableTree).map(entry => entry.path)
  const plan: import('./partitioning.js').SyncPartitionPlan = { version: 'sync-partitions-v1', digest: 'draft-plan', expectedPaths: ['src/export.js'], dependencies: [], partitions: [{ id: 'draft-owner', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: paths, writePaths: [path], sourcePaths: ['src/export.js'], changedPaths: ['src/export.js'], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }] }
  let local: Omit<import('./elaboration-types.js').ElaborationResult, 'contracts' | 'graph' | 'coverage'> | undefined
  const save = (key: string, value: unknown) => { if (key === 'partition:draft-owner:elaboration') local = structuredClone(value) as NonNullable<typeof local>; return writeEvidence(f.commonDir, value) }
  const first = await elaborateSyncPartitions({ ...f.input, maxRepairs: 0 }, plan, 1, { load: () => null, save }, f.run(() => '{ invalid owner draft'))
  assert.equal(first.status, 'exhausted'); const draft = local!.rounds[0].draft!, priorDigest = local!.inputDigest
  let draftsLoaded = 0, acceptChecked = 0
  const secondInput = { ...f.input, requestKey: 'next-partition-attempt', context: [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('已审新祖先') }], maxRepairs: 0 }
  const second = await elaborateSyncPartitions(secondInput, plan, 1, { load: () => null, save,
    loadAcceptedElaboration: (_key, _binding, inputDigest) => { acceptChecked++; assert.notEqual(inputDigest, priorDigest); return null },
    loadElaborationDraft: (key, binding) => { draftsLoaded++; assert.equal(key, 'partition:draft-owner:elaboration'); assert.equal(binding.partitionId, 'draft-owner'); return draft },
  }, f.run((_request, workspace, draftPath) => { assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), '{ invalid owner draft'); assert.equal(readFileSync(join(workspace, ancestorPath), 'utf8'), ancestor('已审新祖先')); return JSON.stringify(rows) }))
  assert.equal(second.status, 'complete', JSON.stringify({ failure: second.failure, rounds: second.rounds.map(round => round.findings) })); assert.equal(draftsLoaded, 1); assert.equal(acceptChecked, 1)
  assert.equal(local!.rounds[0].draft!.ownerDigest, draft.ownerDigest)
  const calls = f.requests.length
  await assert.rejects(elaborateSyncPartitions({ ...secondInput, context: [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('再次变化') }] }, plan, 1, { load: <T>(key: string) => key === 'partition:draft-owner:elaboration' ? structuredClone(local) as T : null, save }, f.run(() => { throw new Error('不能派发') })), /当前完整局部输入/)
  assert.equal(f.requests.length, calls)
})

test('仅summary而无指定草稿的真实提交不能通过，也不伪造Native rejected final', async t => {
  const f = await fixture(t)
  const result = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: async request => {
    const workspace = join(f.root, 'uncommitted-summary')
    git(f.root, 'worktree', 'add', '--detach', workspace, request.worktree!.baseCommit)
    const output = { summary: '声称完成' }
    return { sessionId: 'summary-session', threadId: 'summary-thread', turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: nativeWorktreeResult(workspace, request.worktree!) }
  } })
  assert.equal(result.status, 'failed'); assert.match(result.failure!.message, /仅允许正常提交/)
  assert.equal(result.rounds[0].draft, undefined); assert.equal(result.rounds[0].rejectedOutput, undefined); assert.equal(result.rounds[0].candidate, null)
})


test('已有真实Git结果而小回执schema失败时保留非权威草稿，不伪造Native成功', async t => {
  const f = await fixture(t), text = JSON.stringify(rows), committed = f.run(() => text)
  const failed = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: async request => {
    const actual = await committed(request), output = { invalidReceipt: '小回执格式错误' }
    return { ...actual, output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(failed.status, 'failed'); assert.match(failed.failure!.message, /summary回执不符合schema/)
  assert.equal(failed.rounds[0].candidate, null); assert.equal(failed.rounds[0].rejectedOutput, undefined)
  const draft = failed.rounds[0].draft!
  assert.ok(draft, '已提交且具有精确失败Git见证的草稿不能丢失')
  assert.equal(readStageDraft(f.commonDir, draft, draft), text)
  const next = await elaborate({ ...f.input, requestKey: 'retry-invalid-receipt', maxRepairs: 0 }, { draft, runner: f.run((_request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), text)
    return JSON.stringify({ ...rows, applicability: rows.applicability.map(item => ({ ...item, basis: '保留原草稿并核实当前输入' })) })
  }) })
  assert.equal(next.status, 'complete'); assert.equal(failed.structurePassed, false); assert.equal(failed.reviewPassed, false)
})


test('已认证且停稳Native坏小回执附实际Git失败见证时，只保留草稿并在下一真实编辑续修', async t => {
  const f = await fixture(t), draftBytes = `{ actual business draft${'x'.repeat(38_000)}`, rejectedReceipt = 'BROKEN_SMALL_RECEIPT', committed = f.run(() => draftBytes)
  const failed = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: async request => {
    const actual = await committed(request)
    throw new StructuredSessionError('structured_output_format_invalid', '原Native小回执格式错误且已停稳', {
      sessionId: actual.sessionId, threadId: actual.threadId, turnId: actual.turnId, failedWorktree: actual.worktree,
      rejectedOutput: rejectedFinalOutput(rejectedReceipt, nativeWorktreePrompt(request.prompt, request.worktree!), request, actual),
    })
  } })
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure!.code, 'structured_output_format_invalid')
  assert.equal(failed.rounds[0].output, null); assert.equal(failed.rounds[0].candidate, null); assert.equal(failed.rounds[0].traces.length, 0)
  assert.equal(failed.rounds[0].rejectedOutput!.text, rejectedReceipt)
  const draft = failed.rounds[0].draft!
  assert.ok(draft, '已提交且具有精确失败Git见证的草稿不能丢失')
  assert.equal(readStageDraft(f.commonDir, draft, draft), draftBytes)
  const original = JSON.stringify(failed)
  const next = await elaborate({ ...f.input, requestKey: 'retry-native-failed-receipt', maxRepairs: 0 }, { draft, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), draftBytes)
    assert.match(request.prompt, /structured_output_format_invalid/); assert.ok(!request.prompt.includes(draftBytes)); assert.ok(!request.prompt.includes(rejectedReceipt))
    return JSON.stringify(rows)
  }) })
  assert.equal(next.status, 'complete'); assert.equal(JSON.stringify(failed), original)
  assert.equal(next.rounds[0].draft!.path, draft.path)
})

test('validation-only续修明确允许正常empty commit，hooks实跑且不制造业务diff', async t => {
  const f = await fixture(t), text = JSON.stringify(rows), committed = f.run(() => text)
  const hookPath = join(f.commonDir, 'hooks/pre-commit'), hookLog = join(f.commonDir, 'draft-validation-hook.log')
  writeFileSync(hookPath, '#!/bin/sh\nprintf "ran\\n" >> "$(git rev-parse --git-common-dir)/draft-validation-hook.log"\n'); chmodSync(hookPath, 0o755)
  const failed = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: async request => {
    const actual = await committed(request), output = { invalidReceipt: '只需修正小回执，业务稿合法' }
    return { ...actual, output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  const next = await elaborate({ ...f.input, requestKey: 'validation-only', maxRepairs: 0 }, { draft: failed.rounds[0].draft!, runner: f.run((request, workspace, draftPath) => {
    assert.match(request.prompt, /git commit --allow-empty/); assert.match(request.prompt, /hooks/); assert.match(request.prompt, /不要造业务diff/)
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), text)
    return text
  }) })
  assert.equal(next.status, 'complete', JSON.stringify(next.failure))
  const draft = next.rounds[0].draft!
  assert.notEqual(draft.resultCommit, draft.seed.baseCommit); assert.equal(draft.resultTree, draft.seed.tree)
  assert.equal(readFileSync(hookLog, 'utf8'), 'ran\nran\n')
})

test('tagged draft saved/accepted冷缓存重核Git及body候选绑定，历史坏稿不误当成功schema', async t => {
  const { elaborateSyncPartitions } = await import('./partition-execution.js')
  const f = await fixture(t), paths = readTree(f.commonDir, f.snapshot.immutableTree).map(entry => entry.path)
  const plan: import('./partitioning.js').SyncPartitionPlan = { version: 'sync-partitions-v1', digest: 'cache-draft-plan', expectedPaths: ['src/export.js'], dependencies: [], partitions: [{ id: 'draft-owner', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: paths, writePaths: [path], sourcePaths: ['src/export.js'], changedPaths: ['src/export.js'], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }] }
  type Local = Omit<import('./elaboration-types.js').ElaborationResult, 'contracts' | 'graph' | 'coverage'>
  let local: Local | undefined, generation = 0
  const key = 'partition:draft-owner:elaboration', save = (name: string, value: unknown) => { if (name === key) local = structuredClone(value) as Local; return writeEvidence(f.commonDir, value) }
  const first = await elaborateSyncPartitions(f.input, plan, 1, { load: () => null, save }, f.run(() => ++generation === 1 ? '{ historical syntax failure' : JSON.stringify(rows)))
  assert.equal(first.status, 'complete'); assert.equal(local!.rounds.length, 2)
  const approved = structuredClone(local!), calls = f.requests.length
  for (const workspace of f.workspaces) git(f.root, 'worktree', 'remove', workspace)
  const replay = (cached: Local, kind: 'saved' | 'accepted') => elaborateSyncPartitions(f.input, plan, 1, {
    load: <T>(name: string) => kind === 'saved' && name === key ? structuredClone(cached) as T : null,
    elaborationDraftTagged: () => true, // 原source首次生成前冻结的协议stage；不是当前input补签
    loadAcceptedElaboration: () => kind === 'accepted' ? structuredClone(cached) : null, save: (_name, value) => writeEvidence(f.commonDir, value),
  }, async () => { throw new Error('缓存验证不得重开模型') })
  for (const kind of ['saved', 'accepted'] as const) {
    assert.equal((await replay(approved, kind)).status, 'complete')
    for (const patch of ['owner', 'schema', 'source', 'oid', 'missing-draft', 'candidate'] as const) {
      const bad = structuredClone(approved), round = bad.rounds.at(-1)!
      if (patch === 'owner') round.draft!.ownerDigest = 'e'.repeat(64)
      if (patch === 'schema') round.draft!.schemaDigest = 'e'.repeat(64)
      if (patch === 'source') round.draft!.sourceInputId = 'e'.repeat(64)
      if (patch === 'oid') round.draft!.oid = 'e'.repeat(40)
      if (patch === 'missing-draft') for (const item of bad.rounds) delete item.draft
      if (patch === 'candidate') round.candidate!.changes[0].source += '\n伪造与Git正文不同的候选\n'
      await assert.rejects(replay(bad, kind), `${kind}/${patch}不能作为已审缓存通过`)
    }
    const draft = approved.rounds.at(-1)!.draft!, ref = `refs/spex-sync/drafts/${draft.ownerDigest}/${draft.resultCommit}`
    git(f.root, 'update-ref', '-d', ref)
    await assert.rejects(replay(approved, kind), `${kind}/缺失Git保活ref必须拒绝`)
    git(f.root, 'update-ref', ref, draft.resultCommit)
  }
  assert.equal(f.requests.length, calls)
})


test('当前新input tag不能给原legacy无draft接受结果补协议', async t => {
  const f = await fixture(t)
  const legacy = await elaborate({ ...f.input, draftProtocol: undefined, maxRepairs: 0 }, { runner: async request => {
    const output = request.purpose === 'elaboration_generate' ? rows : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: request.purpose, threadId: request.purpose, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(legacy.status, 'complete'); assert.equal(legacy.rounds[0].draft, undefined)
  assert.doesNotThrow(() => verifyElaborationDraftCache(f.input, legacy, false))
  assert.throws(() => verifyElaborationDraftCache(f.input, legacy, true), /当前完整局部输入/)
})
