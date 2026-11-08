import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildContractGraph, CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { StructuredSessionError, rejectedFinalOutput } from '../session-structured-policy.js'
import { nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { elaborate, elaborationMaterialContext, elaborationDigest, freezeElaborationInput, sealPartitionedElaboration, verifyElaborationDraftCache } from './elaboration.js'
import { ELABORATION_BOUNDARIES, ELABORATION_GENERATION_GUIDANCE } from './elaboration-types.js'
import type { ElaborationInput, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence, writeObject, writeTree } from './snapshot.js'
import { captureStageDraft, overlayStageTree, readStageDraft, readStoppedPhysicalDraft, stageWorktree } from './stage-worktree.js'
import { syncCheckpointArtifacts } from './checkpoint-evidence.js'
import { freezeCandidate } from './candidate.js'
import { bindElaborationTargets, projectVerificationTable, renderElaboration } from './elaboration-markdown.js'
import { elaborateSyncPartitions } from './partition-execution.js'
import type { PartitionCheckpoints } from './partition-execution.js'
import type { ElaborationResult, ReadonlySpecRepair } from './elaboration-types.js'
import type { GeneratedTargetElaboration, ContractCell } from './elaboration-markdown.js'
import type { SyncPartitionPlan } from './partitioning.js'
import type { CodeBehaviorAnalysis, CodeBehaviorEvidence } from './writeback-types.js'

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
      assert.match(request.prompt, /Native final与业务草稿JSON是两份不同内容.*形式为\{"summary":"简短处理摘要"\}.*final前后不附说明.*Markdown代码围栏/s)
      const draftPath = /草稿文件=([^\s]+)/.exec(request.prompt)![1]
      assert.deepEqual(request.schema, { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] })
      const schemaPath = /\n草稿业务schema只读文件=([^；]+)/.exec(request.prompt)![1]
      const businessSchema = JSON.parse(readFileSync(join(workspace, schemaPath), 'utf8')) as Record<string, unknown>
      const businessProperties = businessSchema.properties as Record<string, unknown>
      assert.deepEqual(Object.keys(businessProperties).sort(), ['applicability', 'changes', 'version'])
      assert.deepEqual(businessProperties.version, { enum: ['elaboration-target-rows-v3'] }, '只读sidecar保留原业务行schema')
      assert.notDeepEqual(request.schema, businessSchema, 'Native final使用独立的summary回执schema')
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

test('Native P1续修AC.test坏稿只用真实已有测试ID和可信VERIFY', async t => {
  const f = await fixture(t)
  const invalid = draftRows(f.input.targets[0].source!), acceptance = invalid.changes[0].tables.AC
  acceptance[0].test = 'tests/export.test.mjs'
  acceptance[1].test = 'tests/export.test.mjs::test_export'
  acceptance[2].test = 'tests/export.test.mjs#重复导出保留首次结果'
  const invalidSource = JSON.stringify(invalid)
  const failed = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: f.run(request => {
    assert.doesNotMatch(request.prompt, /AC\.test.*仓库相对测试路径#稳定用例ID/)
    assert.doesNotMatch(request.prompt, /登记JSON本身不是契约行/)
    return invalidSource
  }) })
  const oldDraft = failed.rounds[0].draft!
  assert.equal(failed.reviewPassed, false)
  assert.deepEqual(failed.rounds[0].findings.filter(issue => issue.code === 'invalid-test-binding').map(issue => issue.itemId), acceptance.slice(0, 3).map(row => row.id))
  assert.equal(readStageDraft(f.commonDir, oldDraft, oldDraft), invalidSource)
  const nextInput = { ...f.input, requestKey: 'ac-test-binding-repair', generationGuidance: 'ac-test-binding-v1' as const }
  const repaired = await elaborate(nextInput, { draft: oldDraft, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), invalidSource)
    assert.match(request.prompt, /invalid-test-binding/)
    assert.match(request.prompt, /AC\.test.*仓库相对测试路径#稳定用例ID/)
    assert.match(request.prompt, /AC\.command.*可信登记.*VERIFY/)
    assert.match(request.prompt, /禁止裸路径、pytest `::`、自然语言.*伪造ID/)
    assert.match(request.prompt, /包装测试只有实际声明稳定ID、确实运行并覆盖本条断言才可引用/)
    assert.doesNotMatch(request.prompt, /登记JSON本身不是契约行/)
    assert.match(request.prompt, /源码与全部测试只读/)
    return JSON.stringify(draftRows(f.input.targets[0].source!))
  }) })
  assert.equal(repaired.status, 'complete', JSON.stringify(repaired.failure))
  assert.equal(repaired.inputDigest, failed.inputDigest)
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  assert.equal(repaired.rounds[0].draft!.schemaDigest, oldDraft.schemaDigest)
  assert.equal(readStageDraft(f.commonDir, oldDraft, oldDraft), invalidSource)
  assert.deepEqual(readTree(f.commonDir, repaired.rounds[0].draft!.resultTree).filter(entry => !entry.path.startsWith('.spex-sync-drafts/')), readTree(f.commonDir, repaired.rounds[0].draft!.seed.tree).filter(entry => !entry.path.startsWith('.spex-sync-drafts/')))
  const forged = draftRows(f.input.targets[0].source!)
  forged.changes[0].tables.AC[0].test = 'tests/export.test.mjs#AC-NOT-DECLARED-01'
  const unverified = await elaborate({ ...nextInput, requestKey: 'forged-test-id', maxRepairs: 0 }, { runner: f.run(() => JSON.stringify(forged)) })
  assert.equal(unverified.reviewPassed, false)
  assert.ok(unverified.rounds[0].findings.some(issue => issue.code === 'readonly_implementation_gap' && issue.message.includes('AC-NOT-DECLARED-01')))
  assert.equal(f.requests.at(-1)!.purpose, 'elaboration_generate')
})

test('Native P1续修状态事件和无状态END坏稿，保留实际Git草稿与拒因', async t => {
  const f = await fixture(t), valid = draftRows(f.input.targets[0].source!), invalid = structuredClone(valid)
  const tables = invalid.changes[0].tables
  tables.STATE.find(row => row.initial === false)!.object = '无对应事件和初态的误归属对象'
  tables.FLOW[0].terminal = 'END'
  tables.STEP.find(row => row.flow === tables.FLOW[0].id)!.rules = []
  const invalidSource = JSON.stringify(invalid)
  const oldInput = { ...f.input, generationGuidance: 'ac-test-binding-v1' as const, maxRepairs: 0 }
  const failed = await elaborate(oldInput, { runner: f.run(request => {
    assert.match(request.prompt, /仓库相对测试路径#稳定用例ID/)
    assert.ok(!request.prompt.includes('TR.from、TR.event'))
    assert.ok(!request.prompt.includes('每个业务REQ至少由一个主FLOW.req直接覆盖。'))
    return invalidSource
  }) })
  const oldDraft = failed.rounds[0].draft!
  const errorCodes = ['transition-object', 'missing-object-event', 'missing-initial-state', 'missing-stateless-rationale', 'incomplete-stateless-step']
  for (const code of errorCodes) assert.ok(oldDraft.errors.some(issue => issue.code === code), code)
  assert.equal(failed.reviewPassed, false)
  assert.equal(readStageDraft(f.commonDir, oldDraft, oldDraft), invalidSource)
  const nextInput = { ...oldInput, requestKey: 'flow-binding-repair', generationGuidance: 'ac-test-flow-binding-v2' as const }
  const repaired = await elaborate(nextInput, { draft: oldDraft, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), invalidSource)
    for (const code of errorCodes) assert.ok(request.prompt.includes(code), code)
    assert.ok(request.prompt.includes('TR.from、TR.event'))
    assert.ok(request.prompt.includes('STEP.input、STEP.output'))
    assert.ok(request.prompt.includes('不虚构状态'))
    assert.ok(request.prompt.includes('仓库相对测试路径#稳定用例ID'))
    assert.ok(request.prompt.includes('每个业务REQ至少由一个主FLOW.req直接覆盖。'))
    assert.doesNotMatch(request.prompt, /登记JSON本身不是契约行/)
    return JSON.stringify(valid)
  }) })
  assert.equal(repaired.status, 'complete', JSON.stringify(repaired.failure))
  assert.equal(repaired.inputDigest, failed.inputDigest)
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  assert.ok(!f.requests[2].prompt.includes('TR.from、TR.event'))
  assert.doesNotMatch(f.requests[2].prompt, /包装测试只有实际声明稳定ID/)
  assert.equal(repaired.rounds[0].draft!.schemaDigest, oldDraft.schemaDigest)
  assert.equal(readStageDraft(f.commonDir, oldDraft, oldDraft), invalidSource)
})

test('Native完整P1独审逐项核对冻结VERIFY实际执行并覆盖AC断言', async t => {
  const f = await fixture(t)
  const result = await elaborate({ ...f.input, generationGuidance: ELABORATION_GENERATION_GUIDANCE }, { runner: f.run(() => JSON.stringify(rows)) })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.match(f.requests[0].prompt, /包装测试只有实际声明稳定ID、确实运行并覆盖本条断言才可引用/)
  assert.match(f.requests[0].prompt, /TR.from、TR.event/)
  assert.match(f.requests[1].prompt, /包装测试只有实际声明稳定ID、确实运行并覆盖本条断言才可引用/)
  assert.match(f.requests[1].prompt, /沿冻结VERIFY命令和包装器的实际调用逐项核对.*P1提出普通repair，不改文件/)
  assert.match(f.requests[1].prompt, /只读实现范围下不派发P2/)
  assert.doesNotMatch(f.requests[1].prompt, /TR.from、TR.event/)
})

for (const inherited of [false, true]) test(`Native完整P1的VERIFY冻结登记按只读父接口决定是否声明 inherited=${inherited}`, async t => {
  const f = await fixture(t), [target] = f.input.targets
  const verification = { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', timeoutMs: 10000 }
  const source = projectVerificationTable(target.source!, [])
  const parent = inherited ? projectVerificationTable(ancestor('旧父接口').replace('title: 上层接口\n', 'title: 上层接口\ncontract-schema: sync-v1\n'), [verification]) : ancestor('旧父接口')
  writeFileSync(join(f.root, path), source); writeFileSync(join(f.root, ancestorPath), parent)
  git(f.root, 'add', path, ancestorPath); git(f.root, 'commit', '-m', 'freeze VERIFY registration fixture')
  const snapshot = await captureInputSnapshot(f.root)
  const input: ElaborationInput = { ...f.input, generationGuidance: ELABORATION_GENERATION_GUIDANCE, historyInput: snapshot, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), targets: [{ ...target, source, sourceDigest: elaborationDigest(source) }], context: [{ nodeId: 'ancestor', path: ancestorPath, source: parent }], verifications: [verification], maxRepairs: 0 }
  const result = await elaborate(input, { runner: f.run((request, workspace) => {
    const task = JSON.parse(request.prompt.split('\n任务:\n')[1].split('\n')[0])
    assert.deepEqual(task.verifications, [verification])
    assert.equal(readFileSync(join(workspace, path), 'utf8'), source)
    assert.equal(readFileSync(join(workspace, ancestorPath), 'utf8'), parent)
    const draft = draftRows(source), [leaf] = draft.changes
    assert.equal(leaf.tables.VERIFY.length, 0)
    assert.ok(leaf.tables.AC.length > 0 && leaf.tables.AC.every(ac => ac.command === verification.id))
    if (!inherited && request.prompt.includes('须从精确冻结登记新增该VERIFY定义')) {
      leaf.tables.VERIFY = draftRows(target.source!).changes[0].tables.VERIFY
    }
    return JSON.stringify(draft)
  }) })
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds[0].findings.find(issue => issue.code === 'dangling-reference') ?? result.failure))
  assert.match(f.requests[0].prompt, /只读context已有该ID时直接引用，不得在本target重复定义.*登记JSON本身不是契约行/)
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.doesNotMatch(f.requests[1].prompt, /须从精确冻结登记新增该VERIFY定义/)
  assert.deepEqual(result.contracts.flatMap(contract => contract.items.flatMap(item => item.kind === 'VERIFY' ? [[contract.path, item.id, item.command, item.cwd, item.timeoutMs]] : [])), [[inherited ? ancestorPath : path, verification.id, verification.command, verification.cwd, verification.timeoutMs]])
  assert.equal(result.runtimeVerification, 'not_run')
})

test('Native完整P1在共享VERIFY由重复变为缺失后，只给原Git稿一个合法技术归属', async t => {
  const f = await fixture(t), [target] = f.input.targets
  const peerPath = '.spec/export/peer-contract/spec.md'
  const verification = { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', timeoutMs: 10000 }
  const source = projectVerificationTable(target.source!, [])
  const peer = source.replaceAll('export-job', 'peer-job').replaceAll('export-contract', 'peer-contract').replaceAll('EXPORT', 'PEER').replaceAll('VERIFY-PEER-01', verification.id).replaceAll('tests/export.test.mjs', 'tests/peer.test.mjs')
  mkdirSync(dirname(join(f.root, peerPath)), { recursive: true })
  writeFileSync(join(f.root, path), source); writeFileSync(join(f.root, peerPath), peer)
  writeFileSync(join(f.root, 'tests/peer.test.mjs'), readFileSync(join(f.root, 'tests/export.test.mjs'), 'utf8').replaceAll('EXPORT', 'PEER'))
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'freeze two targets for shared verification repair')
  const snapshot = await captureInputSnapshot(f.root)
  const input: ElaborationInput = { ...f.input, historyInput: snapshot, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree),
    targets: [{ ...target, source, sourceDigest: elaborationDigest(source) }, { nodeId: 'peer-contract', path: peerPath, source: peer, sourceDigest: elaborationDigest(peer) }],
    files: new Map(readTree(f.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(f.commonDir, entry.oid).toString('utf8')])), verifications: [verification], maxRepairs: 0,
  }
  const broken = draftRows(source)
  broken.changes.push({ ...draftRows(peer).changes[0], targetIndex: 1 })
  const repeated = structuredClone(broken), verifyRows = draftRows(target.source!).changes[0].tables.VERIFY
  for (const leaf of repeated.changes) leaf.tables.VERIFY = verifyRows
  const historical = { ...input, generationGuidance: 'ac-test-flow-review-binding-v3' } as const
  const duplicate = await elaborate(historical, { runner: f.run(() => JSON.stringify(repeated)) })
  assert.equal(duplicate.status, 'exhausted')
  assert.ok(duplicate.rounds[0].findings.some(issue => issue.code === 'duplicate-id' && issue.itemId === verification.id))
  const missing = await elaborate({ ...historical, requestKey: 'shared-verify-deleted' }, { draft: duplicate.rounds[0].draft, runner: f.run((request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), JSON.stringify(repeated))
    assert.doesNotMatch(request.prompt, /共享VERIFY返修/)
    return JSON.stringify(broken)
  }) })
  assert.equal(missing.status, 'exhausted')
  const prior = missing.rounds[0].draft!
  assert.ok(prior.errors.some(issue => issue.code === 'dangling-reference' && issue.relatedIds?.includes(verification.id)))
  assert.ok(prior.errors.some(issue => issue.code === 'missing-acceptance'))
  const repairInput: ElaborationInput = { ...input, generationGuidance: ELABORATION_GENERATION_GUIDANCE, requestKey: 'shared-verify-repaired' }
  let firstRequest: Omit<ElaborationSessionRequest, 'signal'> | undefined
  const interrupted = await elaborate(repairInput, { draft: prior, runner: async ({ signal: _signal, ...request }) => {
    firstRequest = request
    throw Object.assign(new Error('在相同请求重建前中止'), { code: 'fixture_stop' })
  } })
  assert.equal(interrupted.failure?.code, 'fixture_stop')
  const repaired = await elaborate(repairInput, { draft: prior, runner: f.run(({ signal: _signal, ...request }, workspace, draftPath) => {
    assert.deepEqual(request, firstRequest, '同一冻结输入和旧Git稿重建完整带提示请求')
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), JSON.stringify(broken))
    const hint = request.prompt.split('\n').filter(line => line.startsWith('共享VERIFY返修'))
    assert.equal(hint.length, 1, '共有验证定义的失败需要一个明确位置')
    assert.match(hint[0], /VERIFY-EXPORT-01.*targetIndex=0/)
    assert.doesNotMatch(hint[0], /targetIndex=1/)
    const diagnostics = request.prompt.split('\n失败诊断（不是新授权）:\n')[1].split('\n草稿业务schema只读文件=')[0]
    assert.equal(JSON.stringify(JSON.parse(diagnostics).priorDraft.errors), JSON.stringify(prior.errors))
    const next = structuredClone(broken)
    next.changes[0].tables.VERIFY = verifyRows
    return JSON.stringify(next)
  }) })
  assert.equal(repaired.status, 'complete', JSON.stringify(repaired.failure))
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_generate', 'elaboration_generate', 'elaboration_review'])
  assert.equal(readStageDraft(f.commonDir, prior, prior), JSON.stringify(broken))
  assert.deepEqual(repaired.contracts.flatMap(contract => contract.items.filter(item => item.kind === 'VERIFY').map(item => [contract.path, item.id])), [[path, verification.id]])
  assert.equal(repaired.runtimeVerification, 'not_run')
})

for (const mode of ['frozen', 'readonly', 'unchanged', 'preserve', 'interface', 'unrelated', 'fresh'] as const) test(`Native共享VERIFY返修遵守冻结归属和目标写范围 mode=${mode}`, async t => {
  const f = await fixture(t), [target] = f.input.targets
  const verification = { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', timeoutMs: 10000 }
  const { id } = verification
  const noVerify = projectVerificationTable(target.source!, [])
  const readonlyParent = projectVerificationTable(ancestor('旧父接口').replace('title: 上层接口\n', 'title: 上层接口\ncontract-schema: sync-v1\n'), [verification])
  const sha = contentHash('current unaffected verification analysis')
  const analysis: CodeBehaviorAnalysis = { version: 'code-behavior-v1', inputId: f.snapshot.id, baselinePairId: null, composedDigest: sha, readSetDigest: sha, policyDigest: sha, inputDigest: sha, changes: [], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [], reviewPassed: true }
  const input: ElaborationInput = { ...f.input, generationGuidance: ELABORATION_GENERATION_GUIDANCE, verifications: [verification], maxRepairs: 0,
    ...(mode === 'frozen' ? { targets: [{ nodeId: 'new-contract', path: '.spec/new-contract/spec.md', rawSource: '新目标', source: null, sourceDigest: null }, target] } : {}),
    ...(mode === 'readonly' ? { targets: [{ ...target, source: noVerify, sourceDigest: elaborationDigest(noVerify) }], context: [{ nodeId: 'ancestor', path: ancestorPath, source: readonlyParent }] } : {}),
    ...(mode === 'preserve' ? { mode: 'preserve_business', targets: [{ ...target, source: noVerify, sourceDigest: elaborationDigest(noVerify) }] } : {}),
    ...(mode === 'unchanged' ? { analysis: { analysis, ref: { sha256: contentHash(JSON.stringify(analysis)) } } } : {}),
    ...(mode === 'interface' ? { phase: 'interface_seed', intent: { nodeId: 'ancestor', rawSource: '祖先原意' }, targets: f.input.context!.map(parent => ({ ...parent, sourceDigest: elaborationDigest(parent.source) })), context: [] } : {}),
  }
  const errors = mode === 'unrelated' ? [{ code: 'missing-acceptance', message: `引用 ${id} 的其他诊断` }] : [{ code: 'duplicate-id', itemId: id, message: `${id} 必须在同步范围全局唯一` }]
  const result = await elaborate(input, { ...(mode === 'fresh' ? {} : { draftMaterial: { source: JSON.stringify(rows), errors } }), runner: async request => {
    assert.equal(request.purpose, 'elaboration_generate')
    const hints = request.prompt.split('\n').filter(line => line.startsWith('共享VERIFY返修'))
    if (mode === 'frozen') {
      assert.equal(hints.length, 1)
      assert.match(hints[0], /VERIFY-EXPORT-01.*targetIndex=1/)
    } else if (mode === 'readonly') {
      assert.equal(hints.length, 1)
      assert.ok(hints[0].includes(ancestorPath))
      assert.doesNotMatch(hints[0], /targetIndex=/)
    } else {
      assert.equal(hints.length, 0)
    }
    throw Object.assign(new Error('只核对生成提示'), { code: 'fixture_stop' })
  } })
  assert.equal(result.failure?.code, 'fixture_stop', JSON.stringify(result.failure))
})

for (const missing of ['case', 'files'] as const) test(`Native完整P1把原授权的待实现诊断交给P2，V3实测前不算既有覆盖 missing=${missing}`, async t => {
  const f = await fixture(t), testPath = 'tests/export.test.mjs'
  const [target] = f.input.targets, sourcePath = 'src/export.js'
  const source = missing === 'files' ? target.source!.replace(`code:\n  - ${sourcePath}#ExportService\n`, '') : target.source!
  if (missing === 'files') {
    rmSync(join(f.root, testPath)); rmSync(join(f.root, sourcePath))
    writeFileSync(join(f.root, path), source)
  } else {
    const frozenTests = readFileSync(join(f.root, testPath), 'utf8').replace("test('AC-EXPORT-03 ", "test('AC-EXPORT-OTHER ")
    writeFileSync(join(f.root, testPath), frozenTests)
  }
  git(f.root, 'add', '-A'); git(f.root, 'commit', '-m', 'freeze pending acceptance')
  const snapshot = await captureInputSnapshot(f.root)
  const base = f.run(() => JSON.stringify(rows))
  const result = await elaborate({ ...f.input, targets: [{ ...target, source, sourceDigest: elaborationDigest(source) }], generationGuidance: ELABORATION_GENERATION_GUIDANCE, historyInput: snapshot, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), implementationWritePaths: missing === 'files' ? [sourcePath, testPath] : [testPath], maxRepairs: 0 }, { runner: async request => {
    const native = await base(request)
    if (request.purpose !== 'elaboration_review') return native
    assert.match(request.prompt, /原授权可写范围.*冻结VERIFY.*原结构诊断交P2，由V3实测/)
    assert.match(request.prompt, /仅在有可绑定的真实冻结证据.*另报implementation-review/)
    assert.match(request.prompt, /待实现不算既有覆盖/)
    return native
  } })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.equal(result.reviewPassed, true)
  assert.deepEqual([...new Set(result.deferredImplementationFindings.map(issue => issue.code))].sort(), missing === 'files' ? ['missing-implementation', 'missing-test-file'] : ['missing-test-case'])
  assert.deepEqual(result.rounds[0].review!.findings, [])
  assert.equal(result.runtimeVerification, 'not_run')
  assert.deepEqual(f.requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
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

test('草稿续修保留同码同文的具体finding定位和严重级别，历史短错误不改写', async t => {
  const f = await fixture(t), invalid = draftRows(f.input.targets[0].source!)
  invalid.changes[0].tables.REQ[0].goal = '擅自改变导出业务目标'
  invalid.changes[0].tables.RULE[0].constraint = '擅自改变提交权限'
  const input = { ...f.input, mode: 'preserve_business' as const, maxRepairs: 0 }
  const failed = await elaborate(input, { runner: f.run(() => JSON.stringify(invalid)) })
  const checkpoint = JSON.parse(readEvidence(f.commonDir, writeEvidence(f.commonDir, failed.rounds[0])).toString()) as ElaborationResult['rounds'][number]
  const concrete = checkpoint.findings.filter(issue => issue.code === 'refactor_business_meaning_changed')
  assert.ok(concrete.length >= 2, JSON.stringify(checkpoint.findings))
  assert.equal(new Set(concrete.map(issue => issue.message)).size, 1)
  assert.ok(new Set(concrete.map(issue => issue.itemId)).size >= 2)
  assert.deepEqual(checkpoint.draft!.errors, checkpoint.findings, '保存原finding，不丢path/itemId/severity')
  const legacyDraft = { ...structuredClone(checkpoint.draft!), errors: checkpoint.findings.map(({ code, message }) => ({ code, message })) }
  const legacyBytes = JSON.stringify(legacyDraft), inputDigest = failed.inputDigest
  const restored = await elaborate({ ...input, requestKey: 'diagnostic-next-attempt' }, {
    draft: legacyDraft,
    repairDiagnostics: { requestKey: input.requestKey, inputDigest, resultRef: writeEvidence(f.commonDir, failed), failure: failed.failure!, round: checkpoint },
    runner: f.run((request, workspace, draftPath) => {
      assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), JSON.stringify(invalid))
      assert.ok(request.prompt.includes(`"runtimeFindings":${JSON.stringify(checkpoint.findings)}`), '实际prompt携原轮完整定位')
      assert.ok(request.prompt.includes(`"errors":${JSON.stringify(legacyDraft.errors)}`), '历史短错误仍原样缺席定位')
      return JSON.stringify(rows)
    }),
  })
  assert.equal(restored.status, 'complete', JSON.stringify(restored.failure))
  assert.equal(JSON.stringify(legacyDraft), legacyBytes)
  assert.deepEqual(f.requests.slice(1).map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('草稿边界拒绝错owner/schema/path/ref/OID/seed以及Spec、源码、测试和其他owner修改', async t => {
  const f = await fixture(t), result = await elaborate(f.input, { runner: f.run(() => JSON.stringify(rows)) }), draft = result.rounds[0].draft!
  for (const patch of [{ ownerDigest: 'e'.repeat(64) }, { schemaDigest: 'e'.repeat(64) }, { path: '../escape.json' }, { resultCommit: 'e'.repeat(40) }, { oid: 'e'.repeat(40) }, { seed: { ...draft.seed, tree: draft.resultTree } }, { seed: { ...draft.seed, baseCommit: `refs/spex-sync/seeds/${draft.seed.baseCommit}` } }]) {
    assert.throws(() => readStageDraft(f.commonDir, { ...draft, ...patch }, draft))
  }
  for (const modified of [path, 'src/export.js', 'tests/export.test.mjs', draft.path.replace(/\.json$/, '.schema.json'), `.spex-sync-drafts/${'e'.repeat(64)}.json`, `.spex-sync-diagnostics/${'e'.repeat(64)}/${path}`]) {
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

test('冻结owner的非法repair跨请求只续独审，原Git稿和候选不变，取消不派发', async t => {
  const f = await fixture(t), sha = contentHash('current unaffected analysis')
  const analysis: CodeBehaviorAnalysis = { version: 'code-behavior-v1', inputId: f.snapshot.id, baselinePairId: null, composedDigest: sha, readSetDigest: sha, policyDigest: sha, inputDigest: sha, changes: [], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [], reviewPassed: true }
  const input = { ...f.input, maxRepairs: 0, analysis: { analysis, ref: { sha256: contentHash(JSON.stringify(analysis)) } } }
  const rawReview = { verdict: 'repair', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [{ code: 'arbitrary-history-prose', kind: 'repair', message: '旧轮实现待写和5/5进度文案不符合冻结实现7/7；业务行不必修改', affectedIds: ['RULE-EXPORT-01'], evidence: `${path}:3及:26旧desc/prose`, decision: '仅改未变owner的desc/prose和运行计数，业务行保留' }] }
  const base = f.run(() => JSON.stringify(rows))
  const failed = await elaborate(input, { runner: async request => {
    const result = await base(request)
    return request.purpose === 'elaboration_review' ? { ...result, output: rawReview, resultDigest: contentHash(JSON.stringify(rawReview)) } : result
  } })
  assert.equal(failed.status, 'exhausted'); assert.equal(failed.structurePassed, true); assert.equal(failed.reviewPassed, false)
  const original = JSON.stringify(failed), round = failed.rounds[0], draft = structuredClone(round.draft!), draftText = readStageDraft(f.commonDir, draft, draft)
  const repairDiagnostics = { requestKey: input.requestKey, inputDigest: failed.inputDigest, resultRef: writeEvidence(f.commonDir, failed), failure: failed.failure!, round }
  const cancelled = await elaborate({ ...input, requestKey: 'scope-review-cancelled', signal: AbortSignal.abort() }, { draft, repairDiagnostics, runner: async () => assert.fail('取消后不得派发') })
  assert.equal(cancelled.status, 'cancelled')
  for (const patch of [{ schemaDigest: 'e'.repeat(64) }, { oid: 'e'.repeat(40) }]) {
    await assert.rejects(elaborate({ ...input, requestKey: 'scope-review-corrupt' }, { draft: { ...draft, ...patch }, repairDiagnostics, runner: async () => assert.fail('损坏原稿不得派发') }))
  }
  await assert.rejects(elaborate({ ...input, requestKey: 'scope-review-corrupt-source' }, { draft, repairDiagnostics: { ...repairDiagnostics, round: { ...round, draft: { ...draft, sourceInputId: 'foreign-input' } } }, runner: async () => assert.fail('异source生成资格不得派发') }), /source input/)
  for (const corrupt of ['generation-trace', 'candidate-digest', 'review-output'] as const) {
    const bad = structuredClone(repairDiagnostics)
    if (corrupt === 'generation-trace') bad.round.traces[0].resultDigest = 'e'.repeat(64)
    else if (corrupt === 'candidate-digest') bad.round.candidateDigest = 'e'.repeat(64)
    else bad.round.reviewOutput = { ...rawReview, findings: [] }
    await assert.rejects(elaborate({ ...input, requestKey: `scope-review-${corrupt}` }, { draft, repairDiagnostics: bad, runner: async () => assert.fail('身份摘要损坏不得fallback生成') }), { code: 'review_retry_binding' })
  }
  await assert.rejects(elaborate({ ...input, requestKey: 'scope-review-new-analysis', analysis: { ...input.analysis, ref: { sha256: 'e'.repeat(64) } } }, { draft, repairDiagnostics, runner: async () => assert.fail('异分析不得派发') }), /同一业务输入/)
  const before = f.requests.length
  const restored = await elaborate({ ...input, requestKey: 'scope-review-fresh', generationGuidance: ELABORATION_GENERATION_GUIDANCE }, { draft, repairDiagnostics, loadDraftMaterial: () => assert.fail('合法候选只续独审，不读物理材料覆盖'), runner: f.run(() => assert.fail('同一合法Git稿不得重新生成')) })
  assert.equal(restored.status, 'complete', JSON.stringify(restored.failure))
  assert.deepEqual(f.requests.slice(before).map(request => request.purpose), ['elaboration_review'])
  assert.match(f.requests.at(-1)!.prompt, /review_scope/); assert.ok(f.requests.at(-1)!.prompt.includes(JSON.stringify(rawReview)))
  assert.match(f.requests.at(-1)!.prompt, /包装测试只有实际声明稳定ID、确实运行并覆盖本条断言才可引用/)
  assert.deepEqual(f.requests.at(-1)!.schema, f.requests[1].schema)
  assert.deepEqual(restored.rounds[0].traces[0], round.traces[0]); assert.deepEqual(restored.rounds[0].draft, { ...draft, errors: restored.rounds[0].findings })
  assert.equal(restored.candidateDigest, failed.candidateDigest); assert.deepEqual(restored.changes, failed.changes)
  assert.equal(readStageDraft(f.commonDir, draft, draft), draftText); assert.equal(JSON.stringify(failed), original)
  const reviewEntries = readTree(f.commonDir, f.requests.at(-1)!.worktree!.tree)
  assert.deepEqual(reviewEntries.filter(entry => !entry.path.startsWith('.spec/')), readTree(f.commonDir, f.snapshot.immutableTree).filter(entry => !entry.path.startsWith('.spec/')), '源码/tests全部path/mode/OID与absence保持')
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


for (const kind of ['saved', 'accepted'] as const) test(`${kind}旧ready缓存按原local空analysis失效，兄弟全局REQ影响不扩权且真实Git原稿继续修`, async t => {
  const f = await fixture(t), source = f.input.targets[0].source!
  const analysis: CodeBehaviorAnalysis = { version: 'code-behavior-v1', inputId: f.snapshot.id, baselinePairId: null, composedDigest: 'a'.repeat(64), readSetDigest: 'a'.repeat(64), policyDigest: 'a'.repeat(64), inputDigest: 'a'.repeat(64), changes: [], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], traces: [], reviewPassed: true }
  const localAnalysis: CodeBehaviorEvidence = { ref: writeEvidence(f.commonDir, analysis), analysis }, partitionId = 'scope-cache-owner', planDigest = contentHash('scope-cache-plan')
  const combined = { ...analysis, changes: [{ id: 'sibling-change', kind: 'allowed_change' as const, paths: ['src/sibling.js'], affectedIds: ['REQ-EXPORT-01'], ruleIds: ['REQ-EXPORT-01'], originalIntent: '兄弟承接祖先要求', previousBehavior: '旧兄弟行为', sourceBehavior: '当前兄弟行为', deliveryBehavior: '当前兄弟行为', evidence: '兄弟变化不授权此owner文案', counterexample: '本owner没有代码变化' }], partitionEvidence: [{ partitionId, changedPaths: [], analysisRef: localAnalysis.ref, analysis }] }
  f.input.analysis = { analysis: combined, ref: writeEvidence(f.commonDir, combined) }
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', digest: planDigest, expectedPaths: [], dependencies: [], partitions: [{ id: partitionId, intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: readTree(f.commonDir, f.snapshot.immutableTree).map(entry => entry.path), writePaths: [path], sourcePaths: ['src/export.js'], changedPaths: [], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }] }
  type Local = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
  const key = `partition:${partitionId}:elaboration`, output = draftRows(source)
  output.changes[0].title = '旧版本已接受但本区未受影响的标题'
  const bytes = JSON.stringify(output)
  let captured: Local | undefined
  await elaborateSyncPartitions(f.input, plan, 1, { load: () => null, save: (name, value) => { if (name === key) captured = structuredClone(value) as Local; return writeEvidence(f.commonDir, value) } }, f.run(() => bytes))
  assert.ok(captured); assert.equal(captured.reviewPassed, false)
  const localInput: ElaborationInput = { ...f.input, analysis: localAnalysis, partitionBinding: { planDigest, partitionId, analysisRef: f.input.analysis.ref }, validationScope: 'partition_local', authorizedChanges: [] }
  assert.equal(freezeElaborationInput(localInput).inputDigest, captured.inputDigest)
  const candidate = renderElaboration(localInput, bindElaborationTargets(localInput, output), captured.inputDigest), candidateDigest = contentHash(JSON.stringify(candidate))
  // 旧版本已审回执是显式测试夹具；真实Git稿、schema及渲染身份仍逐项绑定，生产不改历史原件。
  const old: Local = { ...captured, status: 'complete', structurePassed: true, reviewPassed: true, candidateDigest, changes: candidate.changes.map(change => ({ ...change, contentDigest: contentHash(change.source) })), rounds: [{ ...captured.rounds[0], findings: [], candidate, candidateDigest, draft: { ...captured.rounds[0].draft!, errors: [] }, reviewOutput: { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }, review: { inputDigest: captured.inputDigest, candidateDigest, verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] } }] }
  const original = JSON.stringify(old), draft = old.rounds[0].draft!
  assert.equal(readStageDraft(f.commonDir, draft, draft), bytes)
  assert.equal(sealPartitionedElaboration(f.input, old.changes, candidate.applicability).seal.passed, true, '全局兄弟影响不能代替本区缓存资格')
  let resumed = 0
  const result = await elaborateSyncPartitions(f.input, plan, 1, {
    load: <T>(name: string) => kind === 'saved' && name === key ? structuredClone(old) as T : null,
    loadAcceptedElaboration: () => kind === 'accepted' ? structuredClone(old) : null,
    loadElaborationDraft: kind === 'accepted' ? () => structuredClone(draft) : undefined,
    elaborationDraftTagged: () => true,
    save: (_name, value) => writeEvidence(f.commonDir, value),
  }, f.run((request, workspace, draftPath) => {
    resumed++
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), bytes, '不能丢弃已认证旧稿从零开始')
    assert.match(request.prompt, /rows_patch/)
    return JSON.stringify(rows)
  }))
  assert.equal(resumed, 1, '不合格旧ready必须重开生成及新独审')
  assert.equal(result.status, 'complete', JSON.stringify(result.failure))
  assert.equal(result.changes[0].source, source)
  assert.deepEqual(f.requests.slice(-2).map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal(verifyElaborationDraftCache(localInput, old, true), false)
  assert.equal(JSON.stringify(old), original); assert.equal(readStageDraft(f.commonDir, draft, draft), bytes)
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


function draftRows(source: string): GeneratedTargetElaboration {
  const contract = parseContract({ nodeId: source.includes('REQ-PEER-01') ? 'peer-contract' : 'export-contract', path, source }).contract!, fm = parseFrontmatter(source).fm
  return { ...rows, version: 'elaboration-target-rows-v3', changes: [{ targetIndex: 0, title: String(fm.title), description: '', code: [...contract.code], related: [...contract.related], prose: null, removeIds: [],
    tables: Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, contract.items.filter(item => item.kind === kind).map(item => Object.fromEntries(columns.map(column => {
      const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
      return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]]
    })))])) as GeneratedTargetElaboration['changes'][number]['tables'],
  }] }
}

async function reviewedDetailFixture(t: test.TestContext, scope: 'whole' | 'partition' = 'whole') {
  const f = await fixture(t)
  const before = f.input.targets[0].source!.replace('QUEUED或既有任务；错误退出', 'QUEUED且新任务attempt=0或既有任务；错误退出')
  const input: ElaborationInput = { ...f.input, targets: [{ ...f.input.targets[0], source: before, sourceDigest: contentHash(before) }], worktree: stageWorktree(f.commonDir, f.snapshot.headCommit, overlayStageTree(f.commonDir, f.snapshot.immutableTree, [{ path, source: before }])), maxRepairs: 0, authorizedChanges: [], ...(scope === 'partition' ? { partitionBinding: { planDigest: contentHash('controlled detail partition plan'), partitionId: 'detail-owner' }, validationScope: 'partition_local' } : {}) }
  const corrected = draftRows(before)
  corrected.changes[0].tables.STEP.find(row => row.id === 'STEP-EXPORT-01')!.output = 'QUEUED且新任务attempt=1或既有任务；错误退出'
  const drifted = structuredClone(corrected)
  for (const row of drifted.changes[0].tables.RULE.slice(0, 6)) row.constraint += '；无关历史漂移'
  drifted.changes[0].tables.REQ[0].goal += '；无关历史漂移'
  const rejected = await elaborate({ ...input, mode: 'preserve_business' }, { runner: f.run(() => JSON.stringify(drifted)) })
  assert.equal(rejected.status, 'exhausted')
  assert.equal(rejected.rounds[0].findings.filter(issue => issue.code === 'refactor_business_meaning_changed').length, 8)
  const sha = contentHash('controlled reviewed P0 detail')
  const analysis: CodeBehaviorEvidence['analysis'] = { version: 'code-behavior-v1', inputId: f.snapshot.id, baselinePairId: null, composedDigest: f.snapshot.id, readSetDigest: sha, policyDigest: sha, inputDigest: sha,
    changes: [{ id: 'current-reviewed-attempt-detail', kind: 'allowed_change', paths: ['src/export.js'], affectedIds: ['STEP-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'], originalIntent: input.intent.rawSource, previousBehavior: '旧Spec记新任务attempt=0', sourceBehavior: 'src/export.js#ExportService.submit创建新任务attempt=1', deliveryBehavior: '同步该非冲突实现明细，其他权限、状态和验收保持', evidence: '冻结源码const job含attempt: 1；非用户政策变化，无AC或退役动作', counterexample: '复制旧诊断回滚为attempt=0将与当前源码不符' }],
    findings: [], facts: [{ source: 'code:src/export.js#ExportService', text: '新任务attempt=1' }], authorizedChanges: [], nodeChanges: [], newNodes: [], resolutions: [], authorChanges: [],
    traces: ['code_behavior_analyze', 'code_behavior_review'].map((purpose, index) => ({ purpose, sessionId: `controlled-analysis-${index}`, threadId: `controlled-analysis-thread-${index}`, turnId: 'turn', resultDigest: sha, inputDigest: sha })), reviewPassed: true }
  return { ...f, input: { ...input, mode: 'reelaborate' as const, facts: analysis.facts }, corrected, rejected, evidence: { ref: writeEvidence(f.commonDir, analysis), analysis } }
}

for (const scope of ['whole', 'partition'] as const) test(`Native P1当前受审analysis完整同入${scope}生成与独审，空特殊授权不遮盖非冲突明细`, async t => {
  const f = await reviewedDetailFixture(t, scope), original = JSON.stringify(f.rejected), draft = f.rejected.rounds[0].draft!
  const local = f.evidence, planDigest = contentHash('controlled detail partition plan')
  const combined = { ...local.analysis, partitionCoverage: { planDigest, partitionIds: ['detail-owner'], changedPaths: ['src/export.js'] }, partitionEvidence: [{ partitionId: 'detail-owner', changedPaths: ['src/export.js'], analysisRef: local.ref, analysis: local.analysis }] }
  const analysis = scope === 'whole' ? local : { ref: writeEvidence(f.commonDir, combined), analysis: combined }
  const input = { ...f.input, requestKey: `current-analysis-${scope}`, analysis }
  const callStart = f.requests.length, runner = f.run((_request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), readStageDraft(f.commonDir, draft, draft))
    return JSON.stringify(f.corrected)
  })
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', digest: planDigest, expectedPaths: ['src/export.js'], dependencies: [], partitions: [{ id: 'detail-owner', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: readTree(f.commonDir, f.snapshot.immutableTree).map(entry => entry.path), writePaths: [path], sourcePaths: ['src/export.js'], changedPaths: ['src/export.js'], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }] }
  const result = scope === 'whole'
    ? await elaborate(input, { draft, runner })
    : await elaborateSyncPartitions(input, plan, 1, { load: () => null, save: (_key, value) => writeEvidence(f.commonDir, value), loadElaborationDraft: () => draft }, runner)
  const requests = f.requests.slice(callStart)
  const evidenceDir = process.env.SPEX_NATIVE_ANALYSIS_BRIEF_EVIDENCE_DIR
  if (evidenceDir) writeFileSync(join(evidenceDir, `${scope}.json`), JSON.stringify({ controlledNative: true, scope, analysis, local, oldResult: f.rejected, originalDraft: readStageDraft(f.commonDir, draft, draft), requests, result }, null, 2))
  assert.equal(result.status, 'complete', JSON.stringify(result.rounds.map(round => round.findings)))
  assert.deepEqual(requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  for (const request of requests) {
    const task = JSON.parse(request.prompt.split('\n任务:\n')[1].split('\n')[0])
    assert.deepEqual(task.analysis, local, '生成与独审必须收到当前真实受审分析ref和完整正文，不只authorChanges或facts')
    assert.equal(task.authorChanges, undefined, '原authorChanges仅在完整analysis内出现，不另造重复投影')
    assert.deepEqual(task.targets, [{ targetIndex: 0, nodeId: 'export-contract', path }])
    assert.equal(task.mode, 'reelaborate'); assert.deepEqual(task.authorizedChanges, [])
    assert.deepEqual(task.partitionBinding, scope === 'whole' ? undefined : { planDigest, partitionId: 'detail-owner', analysisRef: analysis.ref })
    assert.match(request.prompt, /authorizedChanges.*特殊动作/)
    assert.match(request.prompt, /历史.*诊断.*当前.*分类/)
  }
  assert.ok(requests[0].prompt.includes(`"errors":${JSON.stringify(draft.errors)}`), '原8处历史finding逐项保持')
  const before = parseContract({ nodeId: 'export-contract', path, source: f.input.targets[0].source! }).contract!
  const after = result.contracts.find(contract => contract.nodeId === 'export-contract')!
  assert.equal(after.items.find(item => item.id === 'STEP-EXPORT-01')!.kind, 'STEP')
  assert.equal((after.items.find(item => item.id === 'STEP-EXPORT-01') as { output: string }).output, 'QUEUED且新任务attempt=1或既有任务；错误退出')
  assert.deepEqual(after.items.filter(item => item.id !== 'STEP-EXPORT-01'), before.items.filter(item => item.id !== 'STEP-EXPORT-01'))
  assert.equal(JSON.stringify(f.rejected), original); assert.deepEqual(analysis.analysis.authorizedChanges, [])
})

test('Native当前analysis可见不授予纯refactor、AC、VERIFY或退役越权', async t => {
  const f = await reviewedDetailFixture(t)
  for (const change of ['refactor', 'acceptance', 'verification', 'retire'] as const) {
    const output = structuredClone(f.corrected)
    if (change === 'acceptance') output.changes[0].tables.AC[0].assertion += '；越权改变既有验收'
    if (change === 'verification') output.changes[0].tables.VERIFY[0].command = ['node', '--version']
    if (change === 'retire') { output.changes[0].tables.AC.shift(); output.changes[0].removeIds = ['AC-EXPORT-01'] }
    const calls = f.requests.length
    const result = await elaborate({ ...f.input, requestKey: `no-extra-authorization-${change}`, analysis: f.evidence, mode: change === 'refactor' ? 'preserve_business' : 'reelaborate' }, { runner: f.run(() => JSON.stringify(output)) })
    assert.equal(result.reviewPassed, false)
    assert.ok(result.rounds[0].findings.some(issue => issue.code === ({ refactor: 'refactor_business_meaning_changed', acceptance: 'acceptance_update_unauthorized', verification: 'verification_policy_changed', retire: 'protected_item_removed' })[change]), JSON.stringify(result.rounds[0].findings))
    assert.deepEqual(f.requests.slice(calls).map(request => request.purpose), ['elaboration_generate'])
  }
})

test('Native P1无analysis时不宣称已有受审分类', async t => {
  const f = await fixture(t)
  const result = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: f.run(() => JSON.stringify(rows)) })
  assert.equal(result.status, 'complete')
  for (const request of f.requests) {
    assert.equal(JSON.parse(request.prompt.split('\n任务:\n')[1].split('\n')[0]).analysis, undefined)
    assert.doesNotMatch(request.prompt, /任务analysis为本轮冻结受审P0分析/)
  }
})

async function sealFixture(t: test.TestContext, sharedVerification = false, redundantGeneratedAcceptance = false) {
  const f = await fixture(t), peerPath = '.spec/export/peer-contract/spec.md'
  const original = f.input.targets[0].source!, peer = original.replaceAll('export-job', 'peer-job').replaceAll('export-contract', 'peer-contract').replaceAll('EXPORT', 'PEER').replaceAll('tests/export.test.mjs', 'tests/peer.test.mjs')
  const sources = new Map([[path, original], [peerPath, sharedVerification ? peer.replaceAll('VERIFY-PEER-01', 'VERIFY-EXPORT-01').replace('["node","--test","tests/peer.test.mjs"]', '["node","--test","tests/export.test.mjs"]') : peer]])
  for (const [specPath, source] of sources) {
    mkdirSync(dirname(join(f.root, specPath)), { recursive: true })
    writeFileSync(join(f.root, specPath), source.replace(/^\| FLOW-[^\n]*-01 \|[^\n]*\n/m, '').replace(sharedVerification && specPath === peerPath ? /### VERIFY\n\n(?:[^\n]*\n){3}/ : /$^/, ''))
  }
  writeFileSync(join(f.root, 'tests/peer.test.mjs'), readFileSync(join(f.root, 'tests/export.test.mjs'), 'utf8').replaceAll('EXPORT', 'PEER'))
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'freeze author rows before new flows')
  const snapshot = await captureInputSnapshot(f.root), files = new Map(readTree(f.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(f.commonDir, entry.oid).toString('utf8')]))
  const input: ElaborationInput = { ...f.input, requestKey: 'global-seal', historyInput: snapshot, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), intent: { nodeId: 'ancestor', rawSource: '祖先原意' },
    ...(sharedVerification ? { facts: [{ source: 'decision:EXPORT-POLICY', text: original }, { source: 'decision:PEER-POLICY', text: peer }], verifications: [{ id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs'], cwd: '.', timeoutMs: 10000 }] } : {}),
    targets: [...sources].map(([specPath]) => ({ nodeId: specPath === path ? 'export-contract' : 'peer-contract', path: specPath, source: files.get(specPath)!, sourceDigest: contentHash(files.get(specPath)!) })), files, maxRepairs: 0,
  }
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', digest: 'two-owner-seal', expectedPaths: ['src/export.js'], dependencies: [], partitions: input.targets.map(target => ({ id: target.nodeId, intentNodeId: 'ancestor', targets: [{ nodeId: target.nodeId, path: target.path }], readPaths: [target.path, ancestorPath, 'src/export.js', `tests/${target.nodeId === 'export-contract' ? 'export' : 'peer'}.test.mjs`], writePaths: [target.path], sourcePaths: ['src/export.js'], changedPaths: ['src/export.js'], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] })) }
  const saved = new Map<string, ElaborationResult>(), refs = new Map<string, ReturnType<typeof writeEvidence>>()
  const save: PartitionCheckpoints['save'] = (key, value) => { const ref = writeEvidence(f.commonDir, value); saved.set(key, structuredClone(value) as ElaborationResult); refs.set(key, ref); return ref }
  const candidateSource = (specPath: string) => {
    const source = sources.get(specPath)!.replaceAll(specPath === path ? 'FLOW-EXPORT-01' : 'FLOW-PEER-01', 'FLOW-SHARED-01')
    return redundantGeneratedAcceptance && specPath === peerPath ? source.replace('\n\n### VERIFY', `\n${[1, 2].map(index => `| AC-PEER-NEW-0${index} | REQ-PEER-01,FLOW-SHARED-01 | 当前合法请求 | 完成原流程 | 原义务全部完成 | tests/peer.test.mjs#AC-PEER-01 | VERIFY-PEER-01 | derived:REQ-PEER-01 | REQ-PEER-01,FLOW-SHARED-01 |`).join('\n')}\n\n### VERIFY`) : source
  }
  const initial = await elaborateSyncPartitions(input, plan, 1, { load: () => null, save }, f.run(request => JSON.stringify(draftRows(candidateSource(request.prompt.includes('"nodeId":"peer-contract"') ? peerPath : path)))))
  assert.equal(initial.failure?.code, 'partition_final_seal_failed', JSON.stringify({ failure: initial.failure, locals: [...saved].map(([key, value]) => ({ key, failure: value.failure, findings: value.rounds?.flatMap(round => round.findings) })) }))
  assert.ok([...saved.values()].filter(local => local.partitionBinding).every(local => local.structurePassed && local.reviewPassed))
  assert.ok(initial.partitionSeal!.findings.some(issue => issue.code === 'duplicate-id' && issue.path === peerPath && issue.itemId === 'FLOW-SHARED-01'))
  const key = 'partition:peer-contract:elaboration', prior = saved.get(key)!, generationRef = writeEvidence(f.commonDir, initial)
  const repair: ReadonlySpecRepair = { kind: 'partition_seal', baseInputDigest: prior.inputDigest, candidateDigest: initial.candidateDigest!, generationRef, acceptedRef: refs.get(key)!, changes: prior.changes, output: prior.rounds.at(-1)!.output, review: prior.rounds.at(-1)!.review, findings: initial.partitionSeal!.findings.filter(issue => issue.severity === 'error' && issue.path === peerPath) }
  const checkpoints: PartitionCheckpoints = { load: <T>(name: string) => saved.has(name) ? structuredClone(saved.get(name)) as T : null, save,
    loadPartitionSealRepair: name => name === key ? { prior, repair } : null,
  }
  const repaired = candidateSource(peerPath).replaceAll('FLOW-SHARED-01', 'FLOW-PEER-REPAIRED-01')
  return { ...f, input, plan, initial, prior, repair, checkpoints, saved, peerPath, sources, repaired, key }
}

test('全局seal返修的生成与独审均读取同一跨owner原件、完整定位和只读诊断seed', async t => {
  const f = await sealFixture(t), callsBefore = f.requests.length
  const hook = join(f.root, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nif git grep -q FLOW-SHARED-01 HEAD -- .spec; then exit 41; fi\n'); chmodSync(hook, 0o755)
  const result = await elaborateSyncPartitions({ ...f.input, requestKey: 'repair-visible' }, f.plan, 1, f.checkpoints, async request => {
    assert.match(request.prompt, /跨owner全局封口/)
    assert.ok(request.prompt.includes('"kind":"partition_seal"'))
    assert.ok(request.prompt.includes(f.repair.generationRef.sha256)); assert.ok(request.prompt.includes(f.repair.acceptedRef.sha256))
    for (const issue of f.repair.findings) for (const field of ['code', 'nodeId', 'path', 'itemId'] as const) assert.ok(request.prompt.includes(String(issue[field])))
    const seed = new Map(readTree(f.commonDir, request.worktree!.tree).map(entry => [entry.path, readObject(f.commonDir, entry.oid).toString('utf8')]))
    const diagnostics = [...seed].filter(([name]) => name.startsWith('.spex-sync-diagnostics/'))
    assert.equal(diagnostics.length, 2)
    assert.ok(diagnostics.some(([name, body]) => name.endsWith(path) && body.includes('FLOW-SHARED-01')))
    assert.ok(diagnostics.some(([name, body]) => name.endsWith(f.peerPath) && body.includes(request.purpose === 'elaboration_review' ? 'FLOW-PEER-REPAIRED-01' : 'FLOW-SHARED-01')))
    assert.equal(seed.get(path), f.input.targets[0].source, '失败peer/owner候选不能升格为作者基线')
    if (request.purpose === 'elaboration_generate') assert.equal(seed.get(f.peerPath), f.input.targets[1].source, '正常commit hooks继续面对原Spec，失败并集只在只读诊断目录')
    assert.deepEqual(readTree(f.commonDir, request.worktree!.tree).filter(entry => entry.path.startsWith('src/') || entry.path.startsWith('tests/')), readTree(f.commonDir, f.input.historyInput!.immutableTree).filter(entry => entry.path.startsWith('src/') || entry.path.startsWith('tests/')))
    assert.ok(!request.prompt.includes('30项状态和拒绝均符合契约')); assert.ok(request.prompt.length < 16000)
    return f.run(() => JSON.stringify(draftRows(f.repaired)))(request)
  })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  assert.deepEqual(f.requests.slice(callsBefore).map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
})

test('仅本owner本轮新提议duplicate ID一致改名通过，原错误重放不能局部accept', async t => {
  const f = await sealFixture(t)
  const result = await elaborateSyncPartitions({ ...f.input, requestKey: 'repair-rename' }, f.plan, 1, f.checkpoints, f.run(() => JSON.stringify(draftRows(f.repaired))))
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  const seal = sealPartitionedElaboration(f.input, result.changes, result.partitionSeal!.applicability)
  assert.equal(seal.seal.passed, true, JSON.stringify(seal.seal.findings))
  assert.equal(result.changes.find(change => change.path === path)!.source, f.initial.changes.find(change => change.path === path)!.source)
})


test('全局返修负向：不更名、删义务、旧作者身份、错引用与peer占名均不得进入新独审', async t => {
  const f = await sealFixture(t), initialSaved = structuredClone([...f.saved])
  const priorSource = f.prior.changes[0].source
  const cases: [string, string, string[]][] = [
    ['原稿重放', priorSource, []],
    ['直接删除冲突行并借peer同ID承接', priorSource.replace(/^\| FLOW-SHARED-01 \|[^\n]*\n/m, ''), []],
    ['删本轮无关义务', f.repaired, ['REQ-PEER-01']],
    ['作者已采纳FLOW更名', f.repaired.replaceAll('FLOW-PEER-02', 'FLOW-PEER-AUTHOR-RENAMED'), ['FLOW-PEER-02']],
    ['作者AC弱化', f.repaired.replace('全部拒绝，原结果可由所有者下载', '部分拒绝即可'), []],
    ['作者VERIFY弱化', f.repaired.replace('10000 |', '1000 |'), []],
    ['新增不存在的源码治理', f.repaired.replaceAll('src/export.js', 'src/missing-export.js'), []],
    ['仅FLOW改名未更新STEP', f.repaired.replaceAll('| FLOW-PEER-REPAIRED-01 | 校验', '| FLOW-SHARED-01 | 校验'), []],
    ['抢兄弟稳定ID', f.repaired.replaceAll('FLOW-PEER-REPAIRED-01', 'FLOW-EXPORT-02'), []],
    ['同kind更名却删除流程义务', f.repaired.replace('提交请求', '跳过提交'), []],
  ]
  for (const [name, source, removeIds] of cases) await t.test(name, async () => {
    f.saved.clear(); for (const [key, value] of initialSaved) f.saved.set(key, structuredClone(value))
    const callsBefore = f.requests.length, output = draftRows(source); output.changes[0].removeIds = removeIds
    for (const kind of Object.keys(CONTRACT_COLUMNS) as (keyof typeof CONTRACT_COLUMNS)[]) output.changes[0].tables[kind] = output.changes[0].tables[kind].filter(row => !removeIds.includes(String(row.id)))
    const result = await elaborateSyncPartitions({ ...f.input, requestKey: name }, f.plan, 1, f.checkpoints, f.run(() => JSON.stringify(output)))
    assert.equal(result.reviewPassed, false, name)
    assert.ok(result.rounds.some(round => round.findings.some(issue => issue.severity === 'error')), name)
    if (name === '新增不存在的源码治理') assert.ok(result.rounds.some(round => round.findings.some(issue => issue.code === 'missing-governed-file' && issue.path === f.peerPath)))
    assert.deepEqual(f.requests.slice(callsBefore).map(request => request.purpose), ['elaboration_generate'], name)
  })
  await t.test('非duplicate或非本owner真实finding不给临时ID改名资格', async () => {
    f.saved.clear(); for (const [key, value] of initialSaved) f.saved.set(key, structuredClone(value))
    const repair = { ...f.repair, findings: f.repair.findings.filter(issue => issue.code !== 'duplicate-id') }
    assert.ok(repair.findings.length)
    const result = await elaborateSyncPartitions(f.input, f.plan, 1, { ...f.checkpoints, loadPartitionSealRepair: key => key === f.key ? { prior: f.prior, repair } : null }, f.run(() => JSON.stringify(draftRows(f.repaired))))
    assert.equal(result.reviewPassed, false)
    assert.ok(result.rounds.some(round => round.findings.some(issue => issue.code === 'readonly_repair_id_removed')))
  })
  await t.test('未绑定ref、篡改error定位或跨上下文旧accept均零派发拒绝', async () => {
    const calls = f.requests.length
    for (const repair of [{ ...f.repair, candidateDigest: 'e'.repeat(64) }, { ...f.repair, acceptedRef: f.repair.generationRef }, { ...f.repair, findings: f.repair.findings.map(issue => ({ ...issue, nodeId: 'export-contract', path })) }]) {
      f.saved.clear(); for (const [key, value] of initialSaved) f.saved.set(key, structuredClone(value))
      await assert.rejects(elaborateSyncPartitions(f.input, f.plan, 1, { ...f.checkpoints, loadPartitionSealRepair: key => key === f.key ? { prior: f.prior, repair } : null }, f.run(() => { throw new Error('不可派发') })), /全局seal诊断/)
    }
    f.saved.clear(); for (const [key, value] of initialSaved) f.saved.set(key, structuredClone(value))
    await assert.rejects(elaborateSyncPartitions({ ...f.input, context: [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('上下文已变化') }] }, f.plan, 1, f.checkpoints, f.run(() => { throw new Error('不可派发') })), /当前完整局部输入|完整局部输入\/source/)
    assert.equal(f.requests.length, calls)
  })
})


test('全局返修保留已证明的共享VERIFY归属投影，正常新FLOW更名不被技术重复重阻', async t => {
  const f = await sealFixture(t, true), originalSaved = structuredClone([...f.saved])
  assert.ok(!parseContract(f.initial.partitionSeal!.changes.find(change => change.path === f.peerPath)!).contract!.items.some(item => item.kind === 'VERIFY'))
  assert.ok(parseContract(f.prior.changes[0]).contract!.items.some(item => item.kind === 'VERIFY'))
  const native = f.run(() => JSON.stringify(draftRows(f.repaired)))
  const result = await elaborateSyncPartitions({ ...f.input, requestKey: 'repair-shared-verify' }, f.plan, 1, f.checkpoints, async request => {
    if (request.purpose === 'elaboration_review') {
      const specs = readTree(f.commonDir, request.worktree!.tree).filter(entry => entry.path.startsWith('.spex-sync-diagnostics/')).map(entry => ({ nodeId: entry.path.endsWith(f.peerPath) ? 'peer-contract' : 'export-contract', path: entry.path.endsWith(f.peerPath) ? f.peerPath : path, source: readObject(f.commonDir, entry.oid).toString('utf8') }))
      const contracts = specs.flatMap(spec => parseContract(spec).contract ?? [])
      assert.equal(contracts.flatMap(contract => contract.items.filter(item => item.kind === 'VERIFY')).length, 1, '独审看到的并集必须与程序检查的VERIFY技术投影相同')
      const graph = buildContractGraph(contracts)
      assert.ok(!graph.findings.some(issue => issue.code === 'duplicate-id'))
      assert.equal(graph.owners.get('VERIFY-EXPORT-01')!.path, path, '不重选VERIFY原owner')
    }
    return native(request)
  })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  assert.equal(result.partitionSeal!.passed, true)
  assert.ok(!parseContract(result.changes.find(change => change.path === f.peerPath)!).contract!.items.some(item => item.kind === 'VERIFY'))
  assert.ok(parseContract(f.saved.get(f.key)!.changes[0]).contract!.items.some(item => item.kind === 'VERIFY'), '原新独审本区原件继续保留，只有全局技术投影改变physical owner')
  for (const change of ['漂移定义', '删除义务', '新增未登记'] as const) await t.test(`投影不能掩盖${change}`, async () => {
    f.saved.clear(); for (const [key, value] of originalSaved) f.saved.set(key, structuredClone(value))
    const output = draftRows(f.repaired)
    if (change === '漂移定义') output.changes[0].tables.VERIFY[0].command = ['node', '--version']
    else if (change === '删除义务') output.changes[0].tables.VERIFY = []
    else output.changes[0].tables.VERIFY.push({ id: 'VERIFY-UNREGISTERED-01', command: ['node', '--version'], cwd: '.', 'timeout-ms': 10000 })
    const calls = f.requests.length
    const rejected = await elaborateSyncPartitions({ ...f.input, requestKey: change }, f.plan, 1, f.checkpoints, f.run(() => JSON.stringify(output)))
    assert.equal(rejected.reviewPassed, false)
    assert.ok(rejected.rounds.some(round => round.findings.some(issue => ['verification_registration_mismatch', 'readonly_repair_id_removed'].includes(issue.code))))
    assert.deepEqual(f.requests.slice(calls).map(request => request.purpose), ['elaboration_generate'])
  })
})


test('临时ID更名须保留每一本区typed引用，不能借新生成冗余AC覆盖删除其中引用', async t => {
  const f = await sealFixture(t, false, true), output = draftRows(f.repaired), originalSaved = structuredClone([...f.saved])
  const accepted = await elaborateSyncPartitions({ ...f.input, requestKey: 'preserve-generated-acceptance-reference' }, f.plan, 1, f.checkpoints, f.run(() => JSON.stringify(output)))
  assert.equal(accepted.status, 'complete')
  f.saved.clear(); for (const [key, value] of originalSaved) f.saved.set(key, structuredClone(value))
  const acceptance = output.changes[0].tables.AC.find(row => row.id === 'AC-PEER-NEW-01')!
  acceptance.covers = ['REQ-PEER-01']; acceptance['depends-on'] = ['REQ-PEER-01']
  const calls = f.requests.length
  const rejected = await elaborateSyncPartitions({ ...f.input, requestKey: 'drop-generated-acceptance-reference' }, f.plan, 1, f.checkpoints, f.run(() => JSON.stringify(output)))
  assert.equal(rejected.reviewPassed, false, '另一AC仍覆盖FLOW不能替代原本区引用边的保留')
  assert.ok(rejected.rounds.some(round => round.findings.some(issue => issue.code === 'readonly_repair_id_removed' && issue.itemId === 'AC-PEER-NEW-01')))
  assert.deepEqual(f.requests.slice(calls).map(request => request.purpose), ['elaboration_generate'])
})


test('无draftProtocol的旧全局返修保持read/fullrows提示，不补sidecar或新brief', async t => {
  const f = await sealFixture(t), target = f.input.targets[1], requests: ElaborationSessionRequest[] = []
  const input: ElaborationInput = { ...f.input, requestKey: 'legacy-global-repair', targets: [target], partitionBinding: f.prior.partitionBinding, validationScope: 'partition_local', readonlySpecRepair: f.repair, draftProtocol: undefined }
  const result = await elaborate(input, { runner: async request => {
    requests.push(request)
    assert.equal(request.worktree!.mode, 'read')
    assert.ok(!request.prompt.includes('"diagnosticPath"')); assert.ok(!request.prompt.includes('renameableIds'))
    assert.ok(!readTree(f.commonDir, request.worktree!.tree).some(entry => entry.path.startsWith('.spex-sync-diagnostics/')))
    if (request.purpose === 'elaboration_generate') assert.match(request.prompt, /真实全局封口error与已审局部原件/)
    const output = request.purpose === 'elaboration_generate' ? draftRows(f.repaired) : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `legacy-${requests.length}`, threadId: `legacy-thread-${requests.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  assert.deepEqual(requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
})

async function anchorRepairFixture(t: test.TestContext) {
  const f = await fixture(t), ids = ['STEP-EXPORT-01', 'STEP-EXPORT-02', 'STEP-EXPORT-03']
  const original = f.input.targets[0].source!
  const source = original.split('\n').map(line => ids.some(id => line.startsWith(`| ${id} |`)) ? line.replace('derived:FLOW-EXPORT-01', 'code:src/export.js#permitted') : line).join('\n')
  const accepted = await elaborate({ ...f.input, maxRepairs: 0 }, { runner: f.run(() => JSON.stringify(draftRows(source))) })
  assert.equal(accepted.status, 'complete')
  const baseline = accepted.changes[0].source, parsed = parseContract(accepted.changes[0]).contract!
  const findings = ids.map(id => ({ code: 'anchor-dead', severity: 'error' as const, nodeId: 'export-contract', path, line: parsed.items.find(item => item.id === id)!.line, itemId: id, relatedIds: ['FLOW-EXPORT-01'], message: 'src/export.js#permitted 不存在于冻结候选' }))
  const repair: ReadonlySpecRepair = { baseInputDigest: accepted.inputDigest, candidateDigest: accepted.candidateDigest!, generationRef: writeEvidence(f.commonDir, { fixture: 'readonly V1 anchor failure', findings }), acceptedRef: writeEvidence(f.commonDir, accepted), changes: accepted.changes, output: accepted.rounds[0].output, review: accepted.rounds[0].review, findings }
  const input: ElaborationInput = { ...f.input, requestKey: 'readonly-anchor-repair', targets: [{ nodeId: 'export-contract', path, source: baseline, sourceDigest: contentHash(baseline) }], worktree: stageWorktree(f.commonDir, f.snapshot.headCommit, overlayStageTree(f.commonDir, f.snapshot.immutableTree, [{ path, source: baseline }])), readonlySpecRepair: repair, mode: 'reelaborate', maxRepairs: 0, authorizedChanges: [] }
  const corrected = draftRows(baseline.replaceAll('src/export.js#permitted', 'src/export.js#ExportService'))
  const bad = structuredClone(corrected); bad.changes[0].prose = '重新概括全部业务说明，省略原来详细依据。'; bad.changes[0].tables.RULE[0].basis = '顺带改写已接受的规则依据'
  const badText = JSON.stringify(bad), failed = await elaborate(input, { runner: f.run(() => badText) })
  assert.equal(failed.status, 'exhausted')
  for (const code of ['refinement_accepted_prose_changed', 'refinement_accepted_meaning_changed']) assert.ok(failed.rounds[0].findings.some(issue => issue.code === code))
  const draft = failed.rounds[0].draft!
  assert.equal(readStageDraft(f.commonDir, draft, draft), badText)
  return { ...f, input, repair, baseline, corrected, badText, draft, failed }
}

test('P1物理材料跨新父与新旧诊断精确overlay，原seed仍完整冷验且source/tests不豁免', async t => {
  const f = await anchorRepairFixture(t), source = '{ ORIGINAL_UNCOMMITTED_EPIPE\n', before = f.requests.length
  const richError = { code: 'program-diagnostic', message: '字符串中含\n任务:\n[]、\n草稿业务schema只读文件=、\\与"引号"', severity: 'error' as const, nodeId: 'export-contract', path, line: 17, itemId: 'STEP-EXPORT-01' }
  const failed = await elaborate({ ...f.input, requestKey: 'physical-old-parent' }, { draft: { ...f.draft, errors: [...f.draft.errors, richError] }, runner: f.run((_request, workspace, draftPath) => {
    mkdirSync(dirname(join(workspace, draftPath)), { recursive: true }); writeFileSync(join(workspace, draftPath), source)
    throw new StructuredSessionError('failed', 'controlled EPIPE')
  }) })
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure?.code, 'failed'); assert.equal(failed.rounds[0].draft, undefined)
  const oldRequest = f.requests[before], oldWorkspace = f.workspaces[before], originalRequest = JSON.stringify(oldRequest)
  const indexPath = git(oldWorkspace, 'rev-parse', '--git-path', 'index'), index = readFileSync(indexPath)
  const context = [{ nodeId: 'ancestor', path: ancestorPath, source: ancestor('已审新父接口') }]
  const accepted = await elaborate({ ...f.input, readonlySpecRepair: undefined, context, requestKey: 'new-parent-accepted' }, { runner: f.run(() => JSON.stringify(draftRows(f.baseline))) })
  assert.equal(accepted.status, 'complete')
  const repair = { ...f.repair, baseInputDigest: accepted.inputDigest, candidateDigest: accepted.candidateDigest!, acceptedRef: writeEvidence(f.commonDir, accepted), changes: accepted.changes, output: accepted.rounds[0].output, review: accepted.rounds[0].review }
  let originalDiagnostics: Record<string, unknown> | undefined, projections: { previous: string[]; current: string[] } | undefined
  const result = await elaborate({ ...f.input, context, readonlySpecRepair: repair, requestKey: 'new-parent-physical' }, {
    loadDraftMaterial: (_schema, current) => {
      assert(current)
      const binding = elaborationMaterialContext(f.commonDir, oldRequest, current)
      assert(binding, '新父/精确诊断overlay变化不应清空合法旧物理材料')
      originalDiagnostics = binding.diagnostics
      assert((binding.diagnostics.priorDraft as { errors: unknown[] }).errors.some(error => JSON.stringify(error) === JSON.stringify(richError)))
      projections = { previous: binding.previousReadonlyOverlay.map(entry => entry.path), current: binding.currentReadonlyOverlay.map(entry => entry.path) }
      for (const prompt of [oldRequest.prompt + '\nambiguous suffix', oldRequest.prompt.replace('\n失败诊断（不是新授权）:', '\nwrong marker'), oldRequest.prompt.replace('\n草稿业务schema只读文件=', '\nwrong schema marker=')]) assert.throws(() => elaborationMaterialContext(f.commonDir, { ...oldRequest, prompt }, current), /精确程序任务/)
      for (const path of ['src/export.js', 'tests/export.test.mjs', '.spec/unauthorized/spec.md']) {
        const tree = overlayStageTree(f.commonDir, current.worktree.tree, [{ path, source: 'unauthorized' }]), worktree = stageWorktree(f.commonDir, f.snapshot.headCommit, tree, 'edit')
        assert.equal(elaborationMaterialContext(f.commonDir, oldRequest, { ...current, worktree }), null, '只排精确可信overlay，其他Spec/source/tests仍拒绝')
      }
      const physical = readStoppedPhysicalDraft(f.commonDir, oldWorkspace, oldRequest.worktree!, current.binding)!
      assert.equal(physical.source, source)
      return { source: physical.source, errors: f.draft.errors, diagnostics: binding.diagnostics, sourceKind: 'physical_draft' }
    }, runner: f.run((request, workspace, draftPath) => {
      assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), source)
      assert.equal(readFileSync(join(workspace, ancestorPath), 'utf8'), context[0].source)
      assert.equal(readFileSync(join(workspace, `.spex-sync-diagnostics/${repair.acceptedRef.sha256}/${path}`), 'utf8'), f.baseline)
      const diagnostic = JSON.parse(request.prompt.split('\n失败诊断（不是新授权）:\n')[1].split('\n草稿业务schema只读文件=')[0])
      assert.deepEqual(diagnostic.materialDiagnostics, originalDiagnostics, 'B原冻结诊断完整进入新请求，不仅保EPIPE')
      assert.deepEqual(readTree(f.commonDir, request.worktree!.tree).filter(entry => !entry.path.startsWith('.spec/') && !entry.path.startsWith('.spex-sync-')), readTree(f.commonDir, f.input.worktree!.tree).filter(entry => !entry.path.startsWith('.spec/')))
      return JSON.stringify(f.corrected)
    }),
  })
  assert.equal(result.status, 'complete', JSON.stringify(result.failure)); assert.equal(result.reviewPassed, true)
  assert(projections!.previous.includes(`.spex-sync-diagnostics/${f.repair.acceptedRef.sha256}/${path}`)); assert(projections!.current.includes(`.spex-sync-diagnostics/${repair.acceptedRef.sha256}/${path}`))
  assert.notEqual(f.repair.acceptedRef.sha256, repair.acceptedRef.sha256)
  assert.equal(JSON.stringify(oldRequest), originalRequest); assert.deepEqual(readFileSync(indexPath), index)
  assert.equal(readFileSync(join(oldWorkspace, /草稿文件=([^\s]+)/.exec(oldRequest.prompt)![1]), 'utf8'), source)
})

for (const purpose of ['elaboration_generate', 'elaboration_review']) test(`V1锚点返修${purpose}保留完整任务与真实baseline，坏草稿自行恢复而不改旧证据`, async t => {
  const f = await anchorRepairFixture(t), prior = JSON.stringify(f.draft), requestsBefore = f.requests.length
  const native = f.run((_request, workspace, draftPath) => {
    assert.equal(readFileSync(join(workspace, draftPath), 'utf8'), f.badText)
    return JSON.stringify(f.corrected)
  })
  const result = await elaborate({ ...f.input, requestKey: `continue-${purpose}` }, { draft: f.draft, runner: async request => {
    if (request.purpose === purpose) {
      const task = JSON.parse(request.prompt.split('任务:\n')[1].split(request.purpose === 'elaboration_generate' ? '\n失败诊断' : '\n候选范围')[0]) as { repair?: { kind: string; acceptedRef: { sha256: string }; generationRef: { sha256: string }; findings: typeof f.repair.findings; baselines: { nodeId: string; path: string; baselineSpecPath: string }[] } }
      assert.equal(task.repair?.kind, 'readonly_v1_anchor', '必须明确是V1定位返修，不能只交相同code/message或reelaborate模式')
      assert.deepEqual(task.repair.findings, f.repair.findings)
      assert.deepEqual(task.repair.acceptedRef, f.repair.acceptedRef); assert.deepEqual(task.repair.generationRef, f.repair.generationRef)
      assert.match(request.prompt, /仅修.*code.*选择器/); assert.match(request.prompt, /prose/); assert.match(request.prompt, /RULE/); assert.match(request.prompt, /basis/)
      const baseline = task.repair.baselines.find(spec => spec.nodeId === 'export-contract' && spec.path === path)!
      assert.equal(baseline.baselineSpecPath, `.spex-sync-diagnostics/${f.repair.acceptedRef.sha256}/${path}`)
      const entries = readTree(f.commonDir, request.worktree!.tree), entry = entries.find(entry => entry.path === baseline.baselineSpecPath)!
      assert.equal(readObject(f.commonDir, entry.oid).toString('utf8'), f.baseline, '独审候选overlay不能替掉已接受正文副本')
      const actual = entries.find(entry => entry.path === path)!
      assert.equal(readObject(f.commonDir, actual.oid).toString('utf8').includes('src/export.js#permitted'), purpose === 'elaboration_generate')
      assert.deepEqual(entries.filter(entry => entry.path.startsWith('src/') || entry.path.startsWith('tests/')), readTree(f.commonDir, f.snapshot.immutableTree).filter(entry => entry.path.startsWith('src/') || entry.path.startsWith('tests/')))
      assert.ok(!request.prompt.includes(f.baseline)); assert.ok(!request.prompt.includes(f.badText)); assert.ok(request.prompt.length < 14000)
    }
    return native(request)
  } })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  assert.deepEqual(f.requests.slice(requestsBefore).map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal(JSON.stringify(f.draft), prior); assert.equal(readStageDraft(f.commonDir, f.draft, f.draft), f.badText)
  assert.equal(result.changes[0].source, f.baseline.replaceAll('src/export.js#permitted', 'src/export.js#ExportService'))
})


test('V1 baseline只绑定原acceptedRef及本owner正文，legacy不补新brief或副本', async t => {
  const f = await anchorRepairFixture(t), calls = f.requests.length
  const mismatched = { ...f.repair, changes: f.repair.changes.map(change => ({ ...change, source: change.source + '\n伪造baseline\n' })) }
  await assert.rejects(elaborate({ ...f.input, readonlySpecRepair: mismatched }, { runner: f.run(() => { throw new Error('不可派发') }) }), /baseline必须匹配原已接受owner正文/)
  const foreign = f.repair.changes.map(change => ({ ...change, nodeId: 'foreign-owner', path: '.spec/foreign-owner/spec.md' }))
  await assert.rejects(elaborate({ ...f.input, readonlySpecRepair: { ...f.repair, changes: foreign, acceptedRef: writeEvidence(f.commonDir, { changes: foreign }) } }, { runner: f.run(() => { throw new Error('不可派发') }) }), /baseline必须匹配原已接受owner正文/)
  assert.equal(f.requests.length, calls)
  const requests: ElaborationSessionRequest[] = []
  const legacy = await elaborate({ ...f.input, requestKey: 'legacy-v1-anchor', draftProtocol: undefined }, { runner: async request => {
    requests.push(request)
    assert.equal(request.worktree!.mode, 'read'); assert.ok(!request.prompt.includes('baselineSpecPath'))
    assert.ok(!readTree(f.commonDir, request.worktree!.tree).some(entry => entry.path.startsWith('.spex-sync-diagnostics/')))
    if (request.purpose === 'elaboration_generate') assert.match(request.prompt, /真实只读全候选V1诊断/)
    const output = request.purpose === 'elaboration_generate' ? f.corrected : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `legacy-v1-${requests.length}`, threadId: `legacy-v1-thread-${requests.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(legacy.status, 'complete'); assert.deepEqual(requests.map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
})


test('V1真实caller区分投影seed与完整accepted target，VERIFY剔表不误拒baseline guard', async t => {
  const f = await anchorRepairFixture(t), originalEntry = readTree(f.commonDir, f.snapshot.immutableTree).find(entry => entry.path === path)!, original = readObject(f.commonDir, originalEntry.oid).toString('utf8')
  const input: ElaborationInput = { ...f.input, requestKey: 'v1-caller-original', readonlySpecRepair: undefined, targets: [{ nodeId: 'export-contract', path, source: original, sourceDigest: originalEntry.digest }], worktree: stageWorktree(f.commonDir, f.snapshot.headCommit, f.snapshot.immutableTree) }
  const paths = readTree(f.commonDir, f.snapshot.immutableTree).map(entry => entry.path)
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', digest: 'v1-caller-plan', expectedPaths: ['src/export.js'], dependencies: [], partitions: [{ id: 'owner', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path }], readPaths: paths, writePaths: [path], sourcePaths: ['src/export.js'], changedPaths: ['src/export.js'], contextNodeIds: ['ancestor'], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }] }
  let local: Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'> | undefined
  const save: PartitionCheckpoints['save'] = (key, value) => { if (key === 'partition:owner:elaboration') local = structuredClone(value) as NonNullable<typeof local>; return writeEvidence(f.commonDir, value) }
  const first = await elaborateSyncPartitions(input, plan, 1, { load: () => null, save }, f.run(() => JSON.stringify(draftRows(f.baseline))))
  assert.equal(first.status, 'complete')
  const prior = local!, baseline = prior.changes[0].source, projected = projectVerificationTable(baseline, [])
  assert.notEqual(projected, baseline)
  const candidate = freezeCandidate(f.snapshot, { version: 'sync-files-v1', changes: [{ path, beforeDigest: originalEntry.digest, beforeMode: originalEntry.mode, content: projected }] }, { paths: [path], contractIds: [], flowIds: [] })
  const acceptedRef = writeEvidence(f.commonDir, prior), generationRef = writeEvidence(f.commonDir, { candidate })
  const repair: ReadonlySpecRepair = { ...f.repair, candidateDigest: candidate.digest, acceptedRef, generationRef, changes: prior.changes, output: prior.rounds.at(-1)!.output, review: prior.rounds.at(-1)!.review }
  const native = f.run(() => JSON.stringify(f.corrected)), calls = f.requests.length
  const result = await elaborateSyncPartitions({ ...input, requestKey: 'v1-caller-repair' }, plan, 1, { load: () => null, save,
    loadReadonlySpecRepair: (_key, _binding, inputDigest) => ({ prior, repair: { ...repair, baseInputDigest: inputDigest } }),
  }, async request => {
    const task = JSON.parse(request.prompt.split('任务:\n')[1].split(request.purpose === 'elaboration_generate' ? '\n失败诊断' : '\n候选范围')[0]) as { repair: { baselines: { baselineSpecPath: string }[] } }
    const entries = readTree(f.commonDir, request.worktree!.tree), baselineEntry = entries.find(entry => entry.path === task.repair.baselines[0].baselineSpecPath)!
    assert.equal(readObject(f.commonDir, baselineEntry.oid).toString('utf8'), baseline)
    if (request.purpose === 'elaboration_generate') {
      const physical = readObject(f.commonDir, entries.find(entry => entry.path === path)!.oid).toString('utf8')
      assert.equal(physical, projected); assert.ok(!parseContract({ nodeId: 'export-contract', path, source: physical }).contract!.items.some(item => item.kind === 'VERIFY'))
    }
    return native(request)
  })
  assert.equal(result.status, 'complete', JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings) }))
  assert.deepEqual(f.requests.slice(calls).map(request => request.purpose), ['elaboration_generate', 'elaboration_review'])
})
