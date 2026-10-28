import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isHostPrivatePath } from './candidate.js'
import { isUtf8Text } from './composition.js'
import { analyzeCodeBehavior, CODE_BEHAVIOR_REVIEW_SCHEMA, CODE_BEHAVIOR_SCHEMA, deriveBehaviorAuthorization } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { adoptedDeliveryPaths, composeInputSnapshots, readCompositionEvidence } from './composition.js'
import { prepareHistoryRequest } from './history-input.js'
import { buildSyncApplicationPlan } from './planning.js'
import { readFrozenContracts } from './frozen-contracts.js'
import type { ElaborationRunner } from './elaboration-types.js'
import type { BaselinePair, FrozenBaselineSelection } from './operation-types.js'
import { composeControlledRequest, controlledDecisionIdentity, prepareControlledDecision, prepareControlledRequest, renderControlledDecisionRaw } from './request-input.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { validateContractEvolution } from './contract-evolution.js'
import { parseParts } from '@spexcode/spec-core/contracts'
import { canonicalContractFilterBindings, plantContractFilter } from '../contract-filter.js'
import { writeManagedBlock } from '../harness-shim.js'
import { composeAuthoredInput } from './author-input.js'
import { readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'
import type { BodyReference } from '../../test/frozen-behavior-context.js'
import type { CodeBehaviorAnalysis, CodeBehaviorKind } from './writeback-types.js'

const fixturePath = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
async function fixture(t: test.TestContext, prepare?: (source: string) => string) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-behavior-')), root = join(parent, 'source'), delivery = join(parent, 'delivery')
  mkdirSync(root); cpSync(fixturePath, root, { recursive: true }); if (prepare) { const path = join(root, '.spec/export/export-contract/spec.md'); writeFileSync(path, prepare(readFileSync(path, 'utf8'))) } git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'behavior fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  git(root, 'switch', '-c', 'source'); git(root, 'worktree', 'add', '-b', 'delivery', delivery, 'HEAD')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const base = await captureInputSnapshot(root), raw = readFileSync(join(root, '.spec/export/export-contract/spec.md'), 'utf8')
  const source = readFileSync(join(root, 'src/export.js'), 'utf8')
  const pair = async (): Promise<BaselinePair> => ({ id: 'pair-verified', repositoryId: base.source.repositoryId, source: base.source, sourceInput: base, verifiedDelivery: await captureInputSnapshot(delivery), coveredScope: { paths: ['src', '.spec', 'tests'], contractIds: [], flowIds: [] }, receiptId: 'receipt-real-fixture', settledAtMs: 1 })
  const input = async (): Promise<CodeBehaviorInput> => {
    const snapshot = await captureInputSnapshot(root), baseline = await pair(), composed = composeInputSnapshots(snapshot, baseline, { retainConflicts: true }).composed!
    return { snapshot, baseline, composed, readSetDigest: 'readset-frozen', policyDigest: 'policy-frozen', requestKey: 'behavior-test', timeoutMs: 10000, plan: { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: '.spec/export/export-contract/spec.md' }], readPaths: ['src', '.spec', 'tests'], writePaths: ['src', '.spec', 'tests'], facts: [{ source: 'decision:EXPORT-POLICY', text: raw }], verifications: [], mandatoryTests: [] } }
  }
  return { root, delivery, base, raw, source, input }
}
function runner(kind: CodeBehaviorKind, patch?: (proposal: Record<string, unknown>, frozen: { changedPaths: string[] }) => void, reviewPatch?: (review: Record<string, unknown>) => void): ElaborationRunner {
  return async request => {
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request.prompt)
      const proposal = { changes: frozen.changedPaths.map(path => ({ kind, paths: [path], affectedIds: ['RULE-EXPORT-05', 'AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '成功返回非空结果并发布一次', previousBehavior: '完成任务返回副本', sourceBehavior: '完成任务返回副本与可观察扩展信息', deliveryBehavior: '前次交付保留副本与明确原意', evidence: `完整冻结源码/调用测试 ${path}`, counterexample: '完成同一任务两次不得发布两次' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
      patch?.(proposal, frozen); output = proposal
    } else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: CodeBehaviorAnalysis }
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request.prompt)
      const review = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: frozen.changedPaths, checkedChangeIds: reviewed.analysis.changes.map(item => item.id), findings: [] }
      reviewPatch?.(review); output = review
    }
    return { sessionId: `session-${request.purpose}`, threadId: `thread-${request.purpose}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}

function freezeSelection(snapshot: CodeBehaviorInput['snapshot'], bindings: FrozenBaselineSelection['bindings']): FrozenBaselineSelection {
  const body = { version: 'sync-baseline-selection-v1' as const, source: snapshot.source, bindings }
  return { ...body, digest: contentHash(JSON.stringify(body, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
}
type NonTextContext = { changedPaths: string[]; oldSource: [string, string][]; verifiedDelivery: [string, string][]; newSource: [string, string][]; readablePaths: { path: string; snapshots: string[] }[]; nonTextFiles: { path: string; mode: string; oid: string; digest: string; kind: string; encoding: string; content: string; snapshots: string[] }[] }
test('真实runner的冻结三方JSON共享正文引用且逐字段还原旧输入', async t => {
  const f = await fixture(t), docs = join(f.root, 'docs'), deliveredDocs = join(f.delivery, 'docs')
  mkdirSync(docs); mkdirSync(deliveredDocs)
  const utf8Path = 'docs/utf8.txt', emptyPath = 'docs/empty.txt', deletedPath = 'docs/deleted.txt', modePath = 'docs/mode-only.txt'
  const beforeText = '\uFEFF中文🙂🚀\r\n第二行\r\n', afterText = '\uFEFF修改后🛰️\r\n第二行\r\n', deletedText = '删除文件中文\r\n', modeText = 'mode metadata stays the same\n'
  for (const [path, text] of [[utf8Path, beforeText], [emptyPath, ''], [deletedPath, deletedText], [modePath, modeText]]) {
    writeFileSync(join(f.root, path), text); writeFileSync(join(f.delivery, path), text)
  }
  git(f.root, 'add', 'docs'); git(f.root, 'commit', '-m', 'seed text dedup fixtures')
  git(f.delivery, 'add', 'docs'); git(f.delivery, 'commit', '-m', 'seed text dedup fixtures')
  const before = await captureInputSnapshot(f.root), delivered = await captureInputSnapshot(f.delivery)
  writeFileSync(join(f.root, utf8Path), afterText); rmSync(join(f.root, deletedPath)); chmodSync(join(f.root, modePath), 0o755)
  const prepared = await f.input(), baseline: BaselinePair = { ...prepared.baseline!, sourceInput: before, verifiedDelivery: delivered, coveredScope: { paths: ['.spec', 'src', 'tests', 'docs'], contractIds: ['REQ-EXPORT-01'], flowIds: [] } }
  const input: CodeBehaviorInput = { ...prepared, baseline, composed: composeInputSnapshots(prepared.snapshot, baseline, { retainConflicts: true }).composed!, plan: { ...prepared.plan, readPaths: [...prepared.plan.readPaths, 'docs'] } }
  const expectedTextView = (tree: string): [string, string][] => readTree(input.snapshot.source.commonDir, tree)
    .filter(entry => input.plan.readPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)) && !isHostPrivatePath(entry.path) && entry.mode !== '120000')
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .flatMap(entry => {
      const bytes = readObject(input.snapshot.source.commonDir, entry.oid)
      return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : []
    })
  const expectedOld = expectedTextView(baseline.sourceInput.immutableTree), expectedNew = expectedTextView(input.snapshot.immutableTree)
  const expectedDelivery = expectedTextView(baseline.verifiedDelivery.immutableTree), expectedComposed = expectedTextView(input.composed.tree)
  await analyzeCodeBehavior(input, async request => {
    assert.deepEqual(request.schema, request.purpose === 'code_behavior_analyze' ? CODE_BEHAVIOR_SCHEMA : CODE_BEHAVIOR_REVIEW_SCHEMA)
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as {
        textEncoding: string
        textBodies: Record<string, string>
        intentArtifactFiles: { bodyRef: string; path: string; mode: string; oid: string; digest: string }[]
        oldSource: [string, BodyReference][]
        newSource: [string, BodyReference][]
        authorBaseline: [string, BodyReference][]
        verifiedDelivery: [string, BodyReference][]
        composedFiles: [string, BodyReference][]
        controlledBeforeFiles: [string, BodyReference][]
      }
      assert.equal(frozen.textEncoding, 'sha256-body-ref-v1')
      const encodedViews = ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles'].flatMap(key => frozen[key as keyof typeof frozen] as [string, BodyReference][])
      const bodyRefs = encodedViews.map(([, value]) => value.bodyRef)
      const duplicateBytes = [...new Set(bodyRefs)].reduce((total, bodyRef) => total + Math.max(0, bodyRefs.filter(candidate => candidate === bodyRef).length - 1) * Buffer.byteLength(frozen.textBodies[bodyRef]), 0)
      const expandedViews = ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles'].map(key => [key, (frozen[key as keyof typeof frozen] as [string, BodyReference][]).map(([path, ref]) => [path, frozen.textBodies[ref.bodyRef]])])
      const wireTextBytes = Buffer.byteLength(JSON.stringify({ views: encodedViews, textBodies: frozen.textBodies, intentArtifactFiles: frozen.intentArtifactFiles }))
      const logicalTextBytes = Buffer.byteLength(JSON.stringify({ views: expandedViews, intentArtifactFiles: [] }))
      t.diagnostic(JSON.stringify({ nativePurpose: request.purpose, textEncoding: frozen.textEncoding, viewEntries: bodyRefs.length, distinctBodies: new Set(bodyRefs).size, uniqueBodyBytes: Object.values(frozen.textBodies).reduce((sum, text) => sum + Buffer.byteLength(text), 0), duplicateBytes, wireTextBytes, logicalTextBytes }))
      assert.deepEqual(Object.keys(frozen.textBodies).sort(), [...new Set(bodyRefs)].sort())
      assert.ok(wireTextBytes < logicalTextBytes, '文本wire体积应随唯一正文数量增长，而非随视图重复次数增长')
      for (const [bodyRef, text] of Object.entries(frozen.textBodies)) assert.equal(contentHash(Buffer.from(text, 'utf8')), bodyRef)
      assert.equal(frozen.intentArtifactFiles.length, 0)
      const expanded = readFrozenBehaviorContext<Record<string, unknown> & { changedPaths: string[]; oldSource: [string, string][]; newSource: [string, string][]; authorBaseline: [string, string][]; verifiedDelivery: [string, string][]; composedFiles: [string, string][]; controlledBeforeFiles: [string, string][]; intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; text: string }[] }>(request.prompt)
      assert.deepEqual(expanded.oldSource, expectedOld)
      assert.deepEqual(expanded.newSource, expectedNew)
      assert.deepEqual(expanded.authorBaseline, expectedOld)
      assert.deepEqual(expanded.verifiedDelivery, expectedDelivery)
      assert.deepEqual(expanded.composedFiles, expectedComposed)
      assert.deepEqual(expanded.controlledBeforeFiles, [])
      assert.deepEqual(expanded.intentArtifactFiles, [])
      assert.equal(new Map(expanded.oldSource).get(utf8Path), beforeText)
      assert.equal(new Map(expanded.newSource).get(utf8Path), afterText)
      assert.equal(new Map(expanded.oldSource).get(deletedPath), deletedText)
      assert.equal(new Map(expanded.newSource).has(deletedPath), false)
      assert.equal(new Map(expanded.oldSource).get(emptyPath), '')
      assert.equal(new Map(expanded.newSource).get(modePath), modeText)
      assert.ok(expanded.changedPaths.includes(modePath))
      assert.equal(readTree(input.snapshot.source.commonDir, before.immutableTree).find(entry => entry.path === modePath)!.mode, '100644')
      assert.equal(readTree(input.snapshot.source.commonDir, input.snapshot.immutableTree).find(entry => entry.path === modePath)!.mode, '100755')
      assert.ok(duplicateBytes > 0, '同一正文在多个视图仍应只存一份并由多处引用')
      assert.deepEqual(Object.keys(expanded).sort(), ['requiredChangedPaths', 'unownedSourcePaths', 'unownedSourcePathCount', 'snapshotTree', 'readablePaths', 'contractItems', 'origin', 'decision', 'repairDiagnostics', 'inputId', 'baselinePair', 'baselineSelection', 'compositionEvidence', 'authorByteProjections', 'intentArtifactFiles', 'nonTextFiles', 'composed', 'readSetDigest', 'policyDigest', 'plan', 'changedPaths', 'authorChanges', 'adoptedDeliveryPaths', 'authorBaseline', 'oldSource', 'verifiedDelivery', 'newSource', 'composedFiles', 'controlledBeforeFiles'].sort())
    }
    return runner('refactor')(request)
  })
})

test('history受控before正文引用可还原且authorBaseline保留原冻结全文', async t => {
  const f = await fixture(t), path = 'src/export.js', before = f.source, controlledBefore = `\uFEFF${f.source}\n// history before 🙂\r\n`
  writeFileSync(join(f.root, path), controlledBefore); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'history feature body')
  const snapshot = await captureInputSnapshot(f.root), requestBlob = prepareHistoryRequest(snapshot, { requestId: 'dedup-history', nodeId: 'export-contract', operationId: 'dedup-history-op', receiptId: 'dedup-history-receipt', featureCommit: snapshot.headCommit })
  const composed = composeControlledRequest(snapshot, composeInputSnapshots(snapshot, null).composed!, requestBlob).composed!
  const prepared = await f.input(), input: CodeBehaviorInput = { ...prepared, snapshot, baseline: null, composed }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { textEncoding: string; textBodies: Record<string, string>; controlledBeforeFiles: [string, BodyReference][] }
    assert.equal(wire.textEncoding, 'sha256-body-ref-v1')
    const context = readFrozenBehaviorContext<{ changedPaths: string[]; authorBaseline: [string, string][]; oldSource: [string, string][]; newSource: [string, string][]; verifiedDelivery: [string, string][]; controlledBeforeFiles: [string, string][] }>(request.prompt)
    assert.ok(context.changedPaths.includes(path))
    assert.equal(new Map(context.controlledBeforeFiles).get(path), controlledBefore)
    assert.equal(new Map(context.authorBaseline).get(path), controlledBefore)
    assert.equal(new Map(context.oldSource).get(path), controlledBefore)
    assert.equal(new Map(context.verifiedDelivery).get(path), controlledBefore)
    assert.equal(new Map(context.newSource).get(path), before)
    const beforeRef = wire.controlledBeforeFiles.find(([candidate]) => candidate === path)![1].bodyRef
    assert.equal(wire.textBodies[beforeRef], controlledBefore)
    return runner('refactor')(request)
  })
  assert.equal(analysis.reviewPassed, true)
})

test('canonical author-clean projection补足原始快照与clean OID全文关系且不改index或候选', async t => {
  const f = await fixture(t), path = 'AGENTS.md', specPath = '.spec/export/export-contract/spec.md', authorText = '作者保留中文与emoji 🙂 的原始说明。\n'
  writeFileSync(join(f.root, path), '作者已有上下文。\n'); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'seed canonical author projection')
  plantContractFilter(f.root, [{ file: path, content: 'managed context' }], canonicalContractFilterBindings(f.root))
  writeFileSync(join(f.root, path), authorText); writeManagedBlock(join(f.root, path), 'managed generated context')
  const snapshot = await captureInputSnapshot(f.root), indexPath = join(f.root, '.git/index'), indexBefore = readFileSync(indexPath), physicalBefore = readFileSync(join(f.root, path))
  const selection = freezeSelection(snapshot, [{ resource: { kind: 'path', path }, bytePair: null }, { resource: { kind: 'path', path: specPath }, bytePair: null }]), authoredComposed = composeAuthoredInput(snapshot, selection).composed!
  const controlledEdit = prepareControlledRequest(snapshot, { path: specPath, source: f.raw, next: f.raw.replace('适用域：', '受控作者补充。适用域：'), changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'canonical-projection-wrapper', nodeId: 'export-contract', intent: '保留同次作者原文' })
  const composed = composeControlledRequest(snapshot, authoredComposed, controlledEdit.requestBlob!, { retainConflicts: true }).composed!
  const commonDir = snapshot.source.commonDir, projectionBlob = JSON.parse(readEvidence(commonDir, composed.authorProjectionBlob!).toString('utf8')) as { version: string; priorProjection: { sha256: string } }
  assert.equal(projectionBlob.version, 'selected-author-projection-v1')
  assert.equal(projectionBlob.priorProjection.sha256, authoredComposed.authorProjectionBlob!.sha256)
  const canonicalProjectionBlob = JSON.parse(readEvidence(commonDir, authoredComposed.authorProjectionBlob!).toString('utf8')) as { version: string; projections: { snapshotId: string; changes: { path: string; before: { path: string; mode: string; oid: string; digest: string }; after: { path: string; mode: string; oid: string; digest: string } }[] }[] }
  assert.equal(canonicalProjectionBlob.version, 'canonical-author-projection-v1')
  const projection = canonicalProjectionBlob.projections.find(item => item.snapshotId === snapshot.id)!.changes.find(change => change.path === path)!
  const rawEntry = readTree(commonDir, snapshot.immutableTree).find(entry => entry.path === path)!, cleanEntry = readTree(commonDir, composed.tree).find(entry => entry.path === path)!
  assert.equal(projection.before.oid, rawEntry.oid); assert.equal(projection.after.oid, cleanEntry.oid)
  const rawText = readObject(commonDir, projection.before.oid).toString('utf8'), cleanText = readObject(commonDir, projection.after.oid).toString('utf8')
  assert.equal(rawText, physicalBefore.toString('utf8')); assert.equal(cleanText, authorText)
  assert.equal(projection.before.digest, contentHash(Buffer.from(rawText, 'utf8'))); assert.equal(projection.after.digest, contentHash(Buffer.from(cleanText, 'utf8')))
  const plan: CodeBehaviorInput['plan'] = { version: 'sync-coordinator-v1', intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: specPath }], readPaths: [path, specPath], writePaths: [path, specPath], facts: [], verifications: [], mandatoryTests: [] }
  const input: CodeBehaviorInput = { snapshot, baseline: null, baselineSelection: selection, composed, readSetDigest: 'canonical-projection-read', policyDigest: 'canonical-projection-policy', requestKey: 'canonical-projection-dedup', timeoutMs: 10000, plan }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { textBodies: Record<string, string>; authorByteProjections: { snapshotId: string; path: string; before: { path: string; mode: string; oid: string; digest: string; bodyRef: string }; after: { path: string; mode: string; oid: string; digest: string; bodyRef: string } }[] }
    const frozen = readFrozenBehaviorContext<{ newSource: [string, string][]; composedFiles: [string, string][]; compositionEvidence: { paths: { path: string; source: { oid: string } | null }[] }; authorByteProjections: { snapshotId: string; path: string; before: { path: string; mode: string; oid: string; digest: string; text: string }; after: { path: string; mode: string; oid: string; digest: string; text: string } }[] }>(request.prompt)
    assert.equal(new Map(frozen.newSource).get(path), rawText)
    assert.equal(new Map(frozen.composedFiles).get(path), cleanText)
    assert.equal(frozen.compositionEvidence.paths.find(item => item.path === path)!.source!.oid, projection.after.oid)
    assert.deepEqual(frozen.authorByteProjections, [{ snapshotId: snapshot.id, path, before: { ...projection.before, text: rawText }, after: { ...projection.after, text: cleanText } }])
    const projected = wire.authorByteProjections.find(item => item.snapshotId === snapshot.id && item.path === path)!
    for (const [wireEntry, expected] of [[projected.before, projection.before], [projected.after, projection.after]] as const) {
      assert.equal(wireEntry.bodyRef, contentHash(Buffer.from(expected.oid === projection.before.oid ? rawText : cleanText, 'utf8')))
      assert.equal(wire.textBodies[wireEntry.bodyRef], expected.oid === projection.before.oid ? rawText : cleanText)
      for (const key of ['path', 'mode', 'oid', 'digest'] as const) assert.equal(wireEntry[key], expected[key])
    }
    return runner('refactor', proposal => { proposal.changes = (proposal.changes as { affectedIds: string[]; ruleIds: string[] }[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })(request)
  })
  assert.equal(analysis.reviewPassed, true)
  const excludedAnalysis = await analyzeCodeBehavior({ ...input, plan: { ...plan, readPaths: [specPath] } }, async request => {
    const frozen = readFrozenBehaviorContext<{ readablePaths: { path: string; snapshots: string[] }[]; newSource: [string, string][]; composedFiles: [string, string][]; authorByteProjections: unknown[] }>(request.prompt)
    assert.deepEqual(frozen.authorByteProjections, [])
    assert.ok(!frozen.readablePaths.some(item => item.path === path), 'readPaths排除AGENTS时不能增加该路径的正文读取授权')
    assert.ok(!frozen.newSource.some(([candidate]) => candidate === path))
    assert.ok(!frozen.composedFiles.some(([candidate]) => candidate === path))
    return runner('refactor', proposal => { proposal.changes = (proposal.changes as { affectedIds: string[]; ruleIds: string[] }[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })(request)
  })
  assert.equal(excludedAnalysis.reviewPassed, true)
  assert.equal(composed.tree, input.composed.tree)
  assert.deepEqual(readFileSync(indexPath), indexBefore)
  assert.deepEqual(readFileSync(join(f.root, path)), physicalBefore)
  assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
  assert.equal(readTree(commonDir, input.composed.tree).find(entry => entry.path === path)!.oid, projection.after.oid)
})

test('精确all-null选择保留HEAD差量基准，只读上下文不造新增且真实增删改与未治理源码仍完整受审', async t => {
  const f = await fixture(t), unowned = 'src/view.js', unchanged = ['docs/history/accepted.md', 'package-lock.json']
  mkdirSync(join(f.root, 'docs/history'), { recursive: true })
  for (const path of [...unchanged, 'docs/changed.md', 'docs/deleted.md']) writeFileSync(join(f.root, path), `committed ${path}\n`)
  writeFileSync(join(f.root, unowned), 'export const view = job => ({ id: job.id });\n')
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'existing readonly context and unowned source')
  writeFileSync(join(f.root, 'docs/changed.md'), 'real author modification\n'); writeFileSync(join(f.root, 'docs/added.md'), 'real author addition\n'); rmSync(join(f.root, 'docs/deleted.md'))
  const prepared = await f.input(), commonDir = prepared.snapshot.source.commonDir
  const paths = [...new Set([...readTree(commonDir, git(f.root, 'rev-parse', 'HEAD^{tree}')), ...readTree(commonDir, prepared.snapshot.immutableTree)].map(entry => entry.path))].sort()
  const baselineSelection = freezeSelection(prepared.snapshot, paths.map(path => ({ resource: { kind: 'path', path }, bytePair: null })))
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: composeInputSnapshots(prepared.snapshot, baselineSelection, { executionPaths: paths.filter(path => !path.startsWith('docs/') && path !== 'package-lock.json'), contextPaths: ['docs', 'package-lock.json'] }).composed!, plan: { ...prepared.plan, readPaths: [...prepared.plan.readPaths, 'docs', 'package-lock.json'], sourcePaths: ['src'] } }
  const changed = ['docs/added.md', 'docs/changed.md', 'docs/deleted.md', unowned], native = runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: unowned, parentNodeId: 'export-contract', basis: '导出任务的可见反馈模块' }] })
  const analysis = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<NonTextContext & { requiredChangedPaths: string[]; unownedSourcePaths: string[] }>(request.prompt)
    assert.deepEqual(context.changedPaths, changed); assert.deepEqual(context.requiredChangedPaths, changed); assert.deepEqual(context.unownedSourcePaths, [unowned])
    assert.ok(unchanged.every(path => context.newSource.some(([candidate]) => candidate === path) && !context.changedPaths.includes(path)))
    assert.equal(new Map(context.oldSource).get('docs/deleted.md'), 'committed docs/deleted.md\n')
    assert.ok(context.readablePaths.some(item => item.path === 'docs/deleted.md' && item.snapshots.includes('oldSource')))
    assert.deepEqual(context.verifiedDelivery, [])
    return native(request)
  })
  assert.equal(analysis.reviewPassed, true); assert.deepEqual(analysis.newNodes.map(node => node.codePath), [unowned])
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change')), /无治理代码未创建真实归属或具体GAP: src\/view.js/)
  const gap = await analyzeCodeBehavior(input, runner('coverage_gap'))
  assert.equal(gap.reviewPassed, true); assert.deepEqual(gap.newNodes, []); assert.ok(gap.findings.some(finding => finding.paths.includes(unowned)))
})

test('真实paired空base仍删除HEAD差量基准，已commit新增测试不能被当作无pair跳过', async t => {
  const f = await fixture(t), path = 'tests/paired-addition.test.js'
  writeFileSync(join(f.root, path), 'export const pairedAddition = true;\n'); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'new test after verified pair')
  const prepared = await f.input(), baselineSelection = freezeSelection(prepared.snapshot, [{ resource: { kind: 'path', path }, bytePair: prepared.baseline }])
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: composeInputSnapshots(prepared.snapshot, baselineSelection).composed! }
  const analysis = await analyzeCodeBehavior(input, runner('refactor', (_proposal, frozen) => { assert.deepEqual(frozen.changedPaths, [path]) }))
  assert.equal(analysis.reviewPassed, true)
})

test('精确all-null冷启动的binary和symlink具有完整可读字节，不能仅靠元数据通过独审', async t => {
  const f = await fixture(t, source => source.split('## expanded spec')[0]), bytes = Buffer.from([137, 80, 78, 71, 0, 255]), target = '../../host-secret.txt'
  mkdirSync(join(f.root, 'assets')); writeFileSync(join(f.root, 'assets/image.png'), bytes); writeFileSync(join(f.root, 'assets/vendor.whl'), bytes)
  chmodSync(join(f.root, 'assets/vendor.whl'), 0o755); writeFileSync(join(f.root, 'assets/.env'), 'DO_NOT_EXPOSE_PRIVATE_BYTES')
  writeFileSync(join(f.root, '../host-secret.txt'), 'DO_NOT_FOLLOW_LINK_TARGET'); symlinkSync(target, join(f.root, 'assets/CLAUDE.md'))
  assert.equal(readFileSync(join(f.root, 'assets', target), 'utf8'), 'DO_NOT_FOLLOW_LINK_TARGET')
  git(f.root, 'add', 'assets/.env'); git(f.root, 'commit', '-m', 'seed private context only')
  const prepared = await f.input(), entries = readTree(prepared.snapshot.source.commonDir, prepared.snapshot.immutableTree)
  const baselineSelection = freezeSelection(prepared.snapshot, entries.filter(entry => !isHostPrivatePath(entry.path)).map(entry => ({ resource: { kind: 'path', path: entry.path }, bytePair: null })))
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: composeInputSnapshots(prepared.snapshot, baselineSelection).composed!, plan: { ...prepared.plan, readPaths: [...prepared.plan.readPaths, 'assets'], sourcePaths: ['src'], facts: [] } }
  const contexts: NonTextContext[] = [], native = runner('refactor', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })
  const analysis = await analyzeCodeBehavior(input, async request => {
    assert.ok(!request.prompt.includes('DO_NOT_EXPOSE_PRIVATE_BYTES') && !request.prompt.includes('DO_NOT_FOLLOW_LINK_TARGET'))
    const context = readFrozenBehaviorContext<NonTextContext>(request.prompt)
    contexts.push(context)
    return native(request)
  })
  assert.equal(analysis.reviewPassed, true); assert.equal(contexts.length, 2)
  for (const context of contexts) {
    assert.ok(!context.oldSource.some(([path]) => path.startsWith('assets/'))); assert.deepEqual(context.verifiedDelivery, [])
    for (const path of ['assets/image.png', 'assets/vendor.whl', 'assets/CLAUDE.md']) {
      assert.ok(context.changedPaths.includes(path) && context.readablePaths.some(item => item.path === path && item.snapshots.includes('nonTextFiles.newSource')))
      const file = context.nonTextFiles.find(item => item.path === path)!, entry = entries.find(item => item.path === path)!
      for (const key of ['mode', 'oid', 'digest'] as const) assert.equal(file[key], entry[key])
      assert.deepEqual(file.snapshots, ['newSource', 'composedFiles'])
      assert.equal(file.kind, path.endsWith('CLAUDE.md') ? 'symlink' : 'binary')
      assert.deepEqual(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'), path.endsWith('CLAUDE.md') ? Buffer.from(target) : bytes)
    }
    assert.ok(!context.newSource.some(([path]) => path.startsWith('assets/')))
  }
  await assert.rejects(analyzeCodeBehavior(input, runner('refactor', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) }, review => { review.checkedPaths = (review.checkedPaths as string[]).filter(path => path !== 'assets/image.png') })), /missingPaths.*assets\/image.png/)
  await assert.rejects(analyzeCodeBehavior(input, runner('refactor', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) }, review => { (review.checkedPaths as string[]).push('assets/.env') })), /未完整读取的路径/)
})

test('真实非文本变化和删除保持三方与intent artifact字节身份，语义未知仍保留GAP', async t => {
  const f = await fixture(t, source => source.replace('src/export.js#ExportService', 'assets/image.png')), oldBytes = Buffer.from([0, 1, 255]), newBytes = Buffer.from([0, 2, 255])
  mkdirSync(join(f.root, 'assets')); writeFileSync(join(f.root, 'assets/image.png'), oldBytes); writeFileSync(join(f.root, 'assets/vendor.whl'), oldBytes); symlinkSync('old-target', join(f.root, 'assets/CLAUDE.md'))
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'baseline nontext objects')
  const before = await captureInputSnapshot(f.root)
  writeFileSync(join(f.root, 'assets/image.png'), newBytes); rmSync(join(f.root, 'assets/vendor.whl')); rmSync(join(f.root, 'assets/CLAUDE.md')); symlinkSync('new-target', join(f.root, 'assets/CLAUDE.md'))
  const prepared = await f.input(), pair = { ...prepared.baseline!, sourceInput: before, verifiedDelivery: before, coveredScope: { paths: ['.spec', 'src', 'tests', 'assets'], contractIds: ['REQ-EXPORT-01'], flowIds: [] } }
  const baselineSelection = freezeSelection(prepared.snapshot, [...readTree(before.source.commonDir, before.immutableTree).filter(entry => pair.coveredScope.paths.some(path => entry.path === path || entry.path.startsWith(`${path}/`))).map(entry => ({ resource: { kind: 'path' as const, path: entry.path }, bytePair: pair })), { resource: { kind: 'contract', id: 'REQ-EXPORT-01' }, intentPair: pair }])
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: composeInputSnapshots(prepared.snapshot, baselineSelection, { retainConflicts: true }).composed!, plan: { ...prepared.plan, readPaths: [...prepared.plan.readPaths, 'assets'], sourcePaths: ['assets'] } }
  const evidence = readCompositionEvidence(input.snapshot, input.composed, input.baselineSelection!)
  const analysis = await analyzeCodeBehavior(input, async request => {
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { textEncoding: string; textBodies: Record<string, string>; intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; bodyRef: string }[] }
    assert.equal(wire.textEncoding, 'sha256-body-ref-v1')
    const context = readFrozenBehaviorContext<NonTextContext & { intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; text: string }[] }>(request.prompt)
    assert.deepEqual(context.changedPaths, ['assets/CLAUDE.md', 'assets/image.png', 'assets/vendor.whl'])
    const expectedArtifacts = new Map((evidence.artifacts ?? []).flatMap(item => [item.before, item.delivery, item.source, item.authorBase].filter((entry): entry is NonNullable<typeof entry> => !!entry))
      .filter(entry => input.plan.readPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)) && !isHostPrivatePath(entry.path))
      .map(entry => [`${entry.path}:${entry.mode}:${entry.oid}`, entry] as const))
    const expectedTextMetadata = [...expectedArtifacts.values()].filter(entry => entry.mode !== '120000' && isUtf8Text(readObject(input.snapshot.source.commonDir, entry.oid)))
      .map(({ path, mode, oid, digest }) => ({ path, mode, oid, digest })).sort((left, right) => `${left.path}:${left.mode}:${left.oid}`.localeCompare(`${right.path}:${right.mode}:${right.oid}`))
    const actualTextMetadata = context.intentArtifactFiles.map(({ text: _text, ...entry }) => entry)
      .sort((left, right) => `${left.path}:${left.mode}:${left.oid}`.localeCompare(`${right.path}:${right.mode}:${right.oid}`))
    assert.ok(context.intentArtifactFiles.length)
    assert.deepEqual(actualTextMetadata, expectedTextMetadata)
    assert.equal(wire.intentArtifactFiles.length, context.intentArtifactFiles.length)
    for (const file of wire.intentArtifactFiles) {
      const expanded = context.intentArtifactFiles.find(item => item.path === file.path && item.mode === file.mode && item.oid === file.oid)!
      assert.equal(file.bodyRef, contentHash(Buffer.from(expanded.text, 'utf8')))
      assert.equal(wire.textBodies[file.bodyRef], expanded.text)
      assert.equal(expanded.digest, contentHash(Buffer.from(expanded.text, 'utf8')))
    }
    const images = context.nonTextFiles.filter(file => file.path === 'assets/image.png')
    assert.equal(images.length, 2)
    for (const file of images) {
      const bytes = Buffer.from(file.content, 'base64')
      assert.equal(file.digest, contentHash(bytes)); assert.ok(file.snapshots.includes('intentArtifactFiles'))
      assert.ok(file.snapshots.includes(bytes.equals(oldBytes) ? 'oldSource' : 'newSource'))
    }
    const removed = context.nonTextFiles.find(file => file.path === 'assets/vendor.whl')!
    assert.ok(removed.snapshots.includes('oldSource') && !removed.snapshots.includes('newSource') && !removed.snapshots.includes('composedFiles'))
    assert.ok(![...context.oldSource, ...context.newSource, ...context.verifiedDelivery].some(([path]) => path.startsWith('assets/')))
    return runner('coverage_gap', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, evidence: '完整对象字节可核对，但raw依赖的图片和wheel含义仍待明确' })) })(request)
  })
  assert.equal(analysis.reviewPassed, true); assert.equal(analysis.findings.length, 3); assert.ok(analysis.findings.every(finding => finding.kind === 'coverage_gap'))
  assert.deepEqual(deriveBehaviorAuthorization(analysis, writeEvidence(input.snapshot.source.commonDir, analysis)), [])
})

test('较大冻结树全文与逐对象参考逐字相同，行为上下文不逐blob启动Git', async t => {
  const f = await fixture(t), contextRoot = join(f.root, 'context')
  mkdirSync(contextRoot)
  for (let index = 0; index < 256; index++) writeFileSync(join(contextRoot, index === 2 ? '原字节\t换\n行.txt' : `frozen ${index}.txt`), index === 0 ? '' : `冻结正文 ${index}\r\n${'逐字保留'.repeat(100)}\n`)
  chmodSync(join(contextRoot, 'frozen 1.txt'), 0o755)
  writeFileSync(join(contextRoot, 'binary'), Buffer.from([0, 10, 255])); writeFileSync(join(contextRoot, 'invalid-utf8'), Buffer.from([255]))
  writeFileSync(join(contextRoot, '.env'), 'PRIVATE=not-model-context\n'); symlinkSync('frozen 1.txt', join(contextRoot, 'link'))
  mkdirSync(join(f.root, 'outside')); writeFileSync(join(f.root, 'outside/secret.txt'), 'unauthorized body\n')
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'seed repeated frozen context')
  const before = await captureInputSnapshot(f.root)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// actual external change\n`)
  const prepared = await f.input(), baseline = { ...prepared.baseline!, sourceInput: before, verifiedDelivery: before }
  const input = { ...prepared, baseline, composed: composeInputSnapshots(prepared.snapshot, baseline).composed!, plan: { ...prepared.plan, readPaths: [...prepared.plan.readPaths, 'context'] } }
  const reference = (tree: string): [string, string][] => readTree(before.source.commonDir, tree).filter(entry => input.plan.readPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)) && entry.mode !== '120000' && !isHostPrivatePath(entry.path)).flatMap(entry => {
    const bytes = readObject(before.source.commonDir, entry.oid)
    return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : []
  })
  const expected = { oldSource: reference(before.immutableTree), newSource: reference(input.snapshot.immutableTree), verifiedDelivery: reference(before.immutableTree), composedFiles: reference(input.composed.tree) }
  assert.equal(expected.newSource.filter(([path]) => path.startsWith('context/')).length, 256)
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'), original = cp.execFileSync, calls: string[][] = []
  cp.execFileSync = ((...args: Parameters<typeof execFileSync>) => { if (args[0] === 'git') calls.push(args[1] as string[]); return Reflect.apply(original, cp, args) }) as typeof execFileSync
  syncBuiltinESMExports()
  const started = performance.now(), purposes: string[] = []
  try {
    assert.equal((await analyzeCodeBehavior(input, async request => {
      const frozen = readFrozenBehaviorContext<typeof expected>(request.prompt)
      for (const key of ['oldSource', 'newSource', 'verifiedDelivery', 'composedFiles'] as const) assert.deepEqual(frozen[key], expected[key])
      purposes.push(request.purpose)
      return runner('refactor')(request)
    })).reviewPassed, true)
  } finally { cp.execFileSync = original; syncBuiltinESMExports() }
  assert.deepEqual(purposes, ['code_behavior_analyze', 'code_behavior_review'])
  const catFile = calls.filter(args => args.includes('cat-file')), single = catFile.filter(args => args.includes('blob'))
  t.diagnostic(JSON.stringify({ textFilesPerView: expected.newSource.length, textBytesDigest: contentHash(JSON.stringify(expected)), gitProcesses: calls.length, catFileProcesses: catFile.length, singleBlobProcesses: single.length, elapsedMs: Math.round(performance.now() - started) }))
  assert.equal(single.length, 0, '冻结树已经批量校验过blob，不应再为每篇正文启动单对象读取')
  assert.ok(catFile.length < 24, 'Git进程次数应随冻结视图批次而非文件数增长')
})

test('分析及独审收到真实契约项正文，raw-only初始化不借未交付资源名虚构既有义务', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// refactor context\n`)
  const input = await f.input(), expected = await readFrozenContracts(f.root, new Map([
    ['.spec/export/export-contract/spec.md', f.raw],
  ])), calls: string[] = []
  const check: ElaborationRunner = async request => {
    const frozen = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request.prompt)
    assert.deepEqual(frozen.contractItems.previous, [...expected.graph.items.values()])
    assert.deepEqual(frozen.contractItems.current, [...expected.graph.items.values()])
    calls.push(request.purpose)
    return runner('refactor')(request)
  }
  assert.equal((await analyzeCodeBehavior(input, check)).reviewPassed, true)
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])

  const highLevel = await fixture(t, source => source.split('## expanded spec')[0])
  writeFileSync(join(highLevel.root, 'src/export.js'), `${highLevel.source}\n// initial source\n`)
  const baseInput = await highLevel.input(), initial: CodeBehaviorInput = {
    ...baseInput, baseline: null, origin: 'initial',
    composed: composeInputSnapshots(baseInput.snapshot, null).composed!,
    plan: { ...baseInput.plan, facts: [] },
  }
  const bootstrapCalls: string[] = []
  assert.equal((await analyzeCodeBehavior(initial, async request => {
    const frozen = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request.prompt)
    assert.deepEqual(frozen.contractItems, { previous: [], current: [] })
    assert.match(request.prompt, /raw-only.*尚无.*稳定.*ID/)
    assert.match(request.prompt, /未通过P1结构检查或独审.*候选.*不.*既有.*义务/)
    bootstrapCalls.push(request.purpose)
    return runner('allowed_change', proposal => {
      proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] }))
    })(request)
  })).reviewPassed, true)
  assert.deepEqual(bootstrapCalls, ['code_behavior_analyze', 'code_behavior_review'])
})

for (const kind of ['conflict', 'coverage_gap'] as const) test(`raw-only bootstrap 的真实 ${kind} 以空既有ID进入独审并保留完整发现`, async t => {
  const f = await fixture(t, source => source.split('## expanded spec')[0])
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// bootstrap behavior\n`)
  const before = await f.input(), calls: string[] = []
  const input: CodeBehaviorInput = { ...before, baseline: null, origin: 'initial', composed: composeInputSnapshots(before.snapshot, null).composed!, plan: { ...before.plan, facts: [] } }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request.prompt)
    assert.deepEqual(context.contractItems, { previous: [], current: [] })
    calls.push(request.purpose)
    return runner(kind, proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })(request)
  })
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])
  assert.equal(analysis.reviewPassed, true)
  assert.ok(analysis.findings.length)
  assert.ok(analysis.changes.every(change => change.kind === kind && !change.affectedIds.length && !change.ruleIds.length))
  assert.ok(analysis.findings.every(finding => finding.kind === kind && !finding.affectedIds.length && !finding.ruleIds.length && finding.paths.length && finding.originalIntent && finding.evidence && finding.counterexample))
  assert.deepEqual(deriveBehaviorAuthorization(analysis, writeEvidence(input.snapshot.source.commonDir, analysis)), [])
})

test('raw-only空关联不豁免既有基线、稳定ID、非法路径或虚构ID', async t => {
  const raw = await fixture(t, source => source.split('## expanded spec')[0]), structured = await fixture(t)
  for (const f of [raw, structured]) writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// changed behavior\n`)
  const rawBefore = await raw.input(), structuredBefore = await structured.input()
  const bootstrap: CodeBehaviorInput = { ...rawBefore, baseline: null, origin: 'initial', composed: composeInputSnapshots(rawBefore.snapshot, null).composed!, plan: { ...rawBefore.plan, facts: [] } }
  const selectionBody = { version: 'sync-baseline-selection-v1' as const, source: rawBefore.snapshot.source, bindings: [{ resource: { kind: 'path' as const, path: 'src/export.js' }, bytePair: rawBefore.baseline }] }
  const baselineSelection: FrozenBaselineSelection = { ...selectionBody, digest: contentHash(JSON.stringify(selectionBody, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
  const selected: CodeBehaviorInput = { ...bootstrap, baselineSelection, composed: composeInputSnapshots(rawBefore.snapshot, baselineSelection, { retainConflicts: true }).composed! }
  const emptyBody = { ...selectionBody, bindings: selectionBody.bindings.map(binding => ({ ...binding, bytePair: null })) }
  const emptySelection: FrozenBaselineSelection = { ...emptyBody, digest: contentHash(JSON.stringify(emptyBody, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)) }
  const selectedBootstrap: CodeBehaviorInput = { ...bootstrap, origin: 'reconcile', baselineSelection: emptySelection, composed: composeInputSnapshots(rawBefore.snapshot, emptySelection).composed! }
  assert.equal((await analyzeCodeBehavior(selectedBootstrap, runner('conflict', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) }))).reviewPassed, true)
  writeFileSync(join(structured.root, '.spec/export/export-contract/spec.md'), structured.raw.split('## expanded spec')[0])
  const erased = await structured.input(), oldIdsOnly: CodeBehaviorInput = { ...erased, baseline: null, composed: composeInputSnapshots(erased.snapshot, null).composed! }
  writeFileSync(join(raw.root, '.spec/export/export-contract/spec.md'), structured.raw)
  const added = await raw.input(), currentIdsOnly: CodeBehaviorInput = { ...added, baseline: null, composed: composeInputSnapshots(added.snapshot, null).composed! }
  for (const input of [rawBefore, selected, structuredBefore, oldIdsOnly, currentIdsOnly, { ...structuredBefore, baseline: null, composed: composeInputSnapshots(structuredBefore.snapshot, null).composed! }]) {
    for (const kind of ['conflict', 'coverage_gap'] as const) await assert.rejects(analyzeCodeBehavior(input, runner(kind, proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })), /必须指明阻塞的既有意图\/规则ID/)
  }
  for (const mutation of [{ paths: ['../outside'] }, { paths: ['outside/file.js'] }, { affectedIds: ['RULE-FUTURE-01'] }, { ruleIds: ['RULE-FUTURE-01'] }]) {
    await assert.rejects(analyzeCodeBehavior(bootstrap, runner('conflict', proposal => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [], ...mutation })) })), /不合法仓库路径|未完整读取的路径|不存在的契约ID|必须指明阻塞的既有意图\/规则ID/)
  }
})

test('冻结source角色只发现业务根，纯测试helper可读且旧计划保持writePaths发现语义', async t => {
  const f = await fixture(t), sourcePath = 'src/test_business.py', tests = ['tests/test_flow.py', 'tests/support.py']
  for (const path of [sourcePath, ...tests]) writeFileSync(join(f.root, path), 'def value():\n    return 1\n')
  writeFileSync(join(f.root, 'src/embedded.test.js'), 'export const fixture = 1\n')
  git(f.root, 'add', sourcePath, ...tests, 'src/embedded.test.js'); git(f.root, 'commit', '-m', 'seed source and pure tests')
  const before = await f.input(), input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, plan: { ...before.plan, sourcePaths: ['src'] } }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ changedPaths: string[]; newSource: [string, string][] }>(request.prompt)
    assert.deepEqual(context.changedPaths, [sourcePath])
    assert.ok(tests.every(path => new Map(context.newSource).has(path)))
    return runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: sourcePath, parentNodeId: 'export-contract', basis: '真实业务helper需要归属' }] })(request)
  })
  assert.deepEqual(analysis.newNodes.map(node => node.codePath), [sourcePath])
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [sourcePath, tests[0]].map(codePath => ({ codePath, parentNodeId: 'export-contract', basis: '不能凭测试可写新增业务归属' })) })), /授权业务源码/)
  const restored = { ...input, plan: JSON.parse(JSON.stringify(before.plan)) as CodeBehaviorInput['plan'] }, stopped = new Error('captured legacy discovery')
  await assert.rejects(analyzeCodeBehavior(restored, async request => {
    const context = readFrozenBehaviorContext<{ changedPaths: string[] }>(request.prompt)
    assert.deepEqual(context.changedPaths, [sourcePath, ...tests].sort())
    throw stopped
  }), error => error === stopped)
})

test('真实测试改动仍经分析和独审，不要求创建业务治理叶', async t => {
  const f = await fixture(t), path = 'tests/support.py'
  writeFileSync(join(f.root, path), 'def fixture_value():\n    return 1\n'); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'seed test helper')
  writeFileSync(join(f.root, path), 'def fixture_value():\n    return 2\n')
  const before = await f.input(), input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, plan: { ...before.plan, sourcePaths: ['src'] } }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ changedPaths: string[] }>(request.prompt)
    assert.deepEqual(context.changedPaths, [path])
    return runner('allowed_change')(request)
  })
  assert.equal(analysis.reviewPassed, true)
  assert.deepEqual(analysis.newNodes, [])
  const legacy = { ...input, plan: JSON.parse(JSON.stringify(before.plan)) as CodeBehaviorInput['plan'] }
  await assert.rejects(analyzeCodeBehavior(legacy, runner('allowed_change')), /无治理代码未创建真实归属/)
})

test('目录授权helper与删除文件保完整全文，链接仅声明对象字节且目录metadata不可读', async t => {
  const f = await fixture(t), path = 'src/export-summary.js', helper = 'export const resultCount = rows => rows === null ? null : rows.length;\n'
  writeFileSync(join(f.root, path), helper); rmSync(join(f.root, 'tests/export.test.mjs')); symlinkSync('export.js', join(f.root, 'src/link'))
  const input = await f.input(), fake = runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: path, parentNodeId: 'export-contract', basis: '实际结果反馈需要派生计数' }] })
  const prompts: string[] = []
  assert.equal((await analyzeCodeBehavior(input, async request => {
    prompts.push(request.prompt)
    const manifest = JSON.parse(request.prompt.split('冻结读取清单:\n')[1].split('\n分析要求:')[0]) as { requiredChangedPaths: string[]; readablePaths: { path: string; snapshots: string[] }[] }
    assert.ok(request.prompt.indexOf('冻结读取清单:') < request.prompt.indexOf('分析要求:'))
    assert.deepEqual(manifest.requiredChangedPaths, ['src/export-summary.js', 'src/link', 'tests/export.test.mjs'])
    assert.deepEqual(manifest.readablePaths.find(item => item.path === path)!.snapshots, ['newSource', 'composedFiles'])
    assert.deepEqual(manifest.readablePaths.find(item => item.path === 'tests/export.test.mjs')!.snapshots, ['oldSource', 'verifiedDelivery'])
    assert.ok(!manifest.readablePaths.some(item => item.path === 'src'))
    assert.ok(manifest.readablePaths.find(item => item.path === 'src/link')!.snapshots.every(snapshot => snapshot.startsWith('nonTextFiles.')))
    const context = readFrozenBehaviorContext<NonTextContext>(request.prompt)
    const link = context.nonTextFiles.find(file => file.path === 'src/link')!
    assert.equal(link.kind, 'symlink'); assert.equal(link.mode, '120000'); assert.equal(link.content, 'export.js')
    assert.ok(!context.newSource.some(([path]) => path === 'src/link'))
    assert.ok(request.prompt.includes(JSON.stringify(helper))); assert.match(request.prompt, /cwd.*不是.*输入/)
    return fake(request)
  })).reviewPassed, true)
  assert.equal(prompts.length, 2)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: path, parentNodeId: 'export-contract', basis: '实际派生计数' }] }, review => { (review.checkedPaths as string[]).push('src') })), /未完整读取的路径/)
  rmSync(join(f.root, 'src/link'))
  assert.equal((await analyzeCodeBehavior(await f.input(), fake)).reviewPassed, true)
  assert.equal(git(f.root, 'ls-tree', 'HEAD', path), '')
})

test('漏helper的accept具体拒绝并携完整前轮proposal与未批准analysis供新独审逐项修复', async t => {
  const f = await fixture(t), path = 'src/export-summary.js', helper = 'export const resultCount = rows => rows === null ? null : rows.length;\n'
  writeFileSync(join(f.root, path), helper); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// uses resultCount\n`)
  const input = await f.input(), propose = (proposal: Record<string, unknown>): void => { proposal.newNodes = [{ codePath: path, parentNodeId: 'export-contract', basis: '实际结果反馈需要派生计数' }]; proposal.facts = [{ source: `code:${path}#resultCount`, text: '保存结果数组长度，尚无结果为null' }] }
  let rejected: { code: string; message: string } | undefined
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', propose, review => { review.checkedPaths = ['src/export.js'] })), (error: Error & { code: string }) => {
    const diagnostic = JSON.parse(error.message) as { approved: boolean; details: { missingPaths: string[] }; proposal: { facts: object[] }; analysis: CodeBehaviorAnalysis; review: { verdict: string } }
    assert.equal(error.code, 'behavior_review_failed'); assert.equal(diagnostic.approved, false)
    assert.deepEqual(diagnostic.details.missingPaths, [path]); assert.equal(diagnostic.review.verdict, 'accept')
    assert.deepEqual(diagnostic.proposal.facts, [{ source: `code:${path}#resultCount`, text: '保存结果数组长度，尚无结果为null' }])
    assert.equal(diagnostic.analysis.reviewPassed, false)
    assert.throws(() => deriveBehaviorAuthorization(diagnostic.analysis, writeEvidence(input.snapshot.source.commonDir, diagnostic.analysis)), /已冻结独审证据对象/)
    rejected = { code: error.code, message: error.message }; return true
  })
  const fake = runner('allowed_change', propose)
  const repaired = await analyzeCodeBehavior({ ...input, repairDiagnostics: [rejected!] }, async request => {
    const context = request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]
    const frozen = JSON.parse(context) as { repairDiagnostics: { code: string; message: string }[]; readSetDigest: string; policyDigest: string }
    assert.deepEqual(frozen.repairDiagnostics, [rejected]); assert.equal(request.inputDigest, contentHash(context))
    assert.equal(frozen.policyDigest, input.policyDigest); assert.equal(frozen.readSetDigest, input.readSetDigest); assert.equal(request.timeoutMs, input.timeoutMs)
    return fake(request)
  })
  assert.equal(repaired.reviewPassed, true); assert.notEqual(repaired.inputDigest, JSON.parse(rejected!.message).analysis.inputDigest)
  const finding = { message: '缺少完成计数边界', evidence: '两个保存结果需计数2', counterexample: '旧断言期望null' }
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', propose, review => { review.checkedPaths = ['src/export.js']; review.verdict = 'repair'; review.findings = [finding] })), (error: Error) => {
    const diagnostic = JSON.parse(error.message)
    assert.deepEqual(diagnostic.details.missingPaths, [path]); assert.deepEqual(diagnostic.details.findings, [finding]); assert.deepEqual(diagnostic.review.findings, [finding]); return true
  })
  await assert.rejects(analyzeCodeBehavior({ ...input, repairDiagnostics: [{ code: 'behavior_review_failed', message: JSON.stringify({ approved: true, analysis: repaired, review: { verdict: 'accept' } }) }] }, runner('allowed_change', propose, review => { review.inputDigest = 'old-approved-input'; review.analysisDigest = 'old-approved-analysis'; review.checkedChangeIds = ['unknown-change'] })), (error: Error) => {
    const diagnostic = JSON.parse(error.message)
    assert.deepEqual(diagnostic.details.identityMismatch, ['inputDigest', 'analysisDigest']); assert.deepEqual(diagnostic.details.unknownChangeIds, ['unknown-change'])
    assert.equal(diagnostic.details.missingChangeIds.length, 2); assert.equal(diagnostic.approved, false); return true
  })
})

test('AC复合门禁逐项诊断未变规则与不绑定来源，不把多个allowed_change并集授权', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// result count extension\n`)
  const input = await f.input(), source = 'code:src/export.js#ExportService.dispatch'
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.facts = [{ source, text: '只新增结果派生计数，不更改权限' }]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05', 'RULE-EXPORT-01'], source, reason: '原AC同时覆盖权限但本次权限未改变' }]
  })), (error: Error) => {
    const diagnostic = JSON.parse(error.message)
    assert.equal(diagnostic.details.targetKind, 'AC'); assert.equal(diagnostic.details.sourceBound, true)
    assert.deepEqual(diagnostic.details.allowedChanges[0].unsupportedRuleIds, ['RULE-EXPORT-01']); assert.equal(diagnostic.details.allowedChanges[0].missingAffectedId, null)
    assert.ok(diagnostic.proposal.acceptanceChanges); return true
  })
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    const changes = proposal.changes as Record<string, unknown>[]
    proposal.changes = [changes[0], { ...changes[0], ruleIds: ['RULE-EXPORT-01'], evidence: '独立权限变化' }]
    proposal.facts = [{ source, text: '两个不同变化不能合并成一个AC批准' }]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05', 'RULE-EXPORT-01'], source, reason: '尝试跨不同change拼接授权' }]
  })), /没有合法已审规则变化/)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source, reason: '省略来源事实' }] })), (error: Error) => {
    assert.equal(JSON.parse(error.message).details.sourceBound, false); return true
  })
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    (proposal.changes as { affectedIds: string[] }[])[0].affectedIds = ['RULE-EXPORT-05']
    proposal.facts = [{ source, text: '依据完整，但change没有目标AC' }]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source, reason: '目标AC未列在同次具体变化' }]
  })), (error: Error) => { assert.equal(JSON.parse(error.message).details.allowedChanges[0].missingAffectedId, 'AC-EXPORT-01'); return true })
  const approved = await analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.facts = [{ source, text: '只新增结果派生计数，原AC其他义务仍保留' }]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source, reason: '只绑定本次改变的结果规则，保原其他covers义务' }]
  }))
  assert.equal(approved.authorizedChanges[0].id, 'AC-EXPORT-01')
  const diagnostic = { code: 'behavior_review_failed', message: `完整诊断开始${'x'.repeat(2 * 1024 * 1024)}完整诊断结束` }, calls: string[] = []
  await analyzeCodeBehavior({ ...input, repairDiagnostics: [diagnostic] }, async request => {
    calls.push(request.purpose)
    assert.ok(Buffer.byteLength(request.prompt) > 2 * 1024 * 1024)
    assert.ok(request.prompt.includes(JSON.stringify(diagnostic)), request.purpose)
    return runner('allowed_change')(request)
  })
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])
})

test('真实三方Git对象进入独立行为分析，允许外部行为证据先冻结再派生AC授权', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, observable: true };'))
  const input = await f.input(), calls: string[] = [], fake = runner('allowed_change', proposal => { proposal.facts = [{ source: 'code:src/export.js#ExportService.dispatch', text: '完成视图保留结果并附加observable:true' }]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source: 'code:src/export.js#ExportService.dispatch', reason: '更新已允许输出的可观察细节，不删旧断言' }] })
  const analysis = await analyzeCodeBehavior(input, async request => { calls.push(request.prompt); return fake(request) })
  assert.equal(analysis.reviewPassed, true); assert.equal(analysis.baselinePairId, 'pair-verified')
  assert.equal(analysis.traces.length, 2); assert.notEqual(analysis.traces[0].sessionId, analysis.traces[1].sessionId)
  assert.ok(calls.every(prompt => prompt.includes(JSON.stringify(f.source)) && prompt.includes('observable: true') && prompt.includes('verifiedDelivery') && prompt.includes('assert')))
  const ref = writeEvidence(input.snapshot.source.commonDir, analysis), auth = deriveBehaviorAuthorization(analysis, ref)
  assert.equal(auth[0].action, 'update_acceptance'); assert.deepEqual(auth[0].action === 'update_acceptance' && auth[0].analysisRef, ref)
  assert.deepEqual(JSON.parse(readEvidence(input.snapshot.source.commonDir, ref).toString()), analysis)
  assert.throws(() => deriveBehaviorAuthorization(analysis, { sha256: 'f'.repeat(64) }), /已冻结独审证据对象/)
})

test('文本冲突先保留三方对象，不因git重叠判业务冲突；相容解决方案由独审核对', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.delivery, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, priorDelivery: true };'))
  writeFileSync(join(f.root, 'src/export.js'), f.source.replace('return { ...job };', 'return { ...job, newSource: true };'))
  const input = await f.input()
  assert.ok(input.composed.compositionEvidenceBlob)
  const overlaps = JSON.parse(readEvidence(input.snapshot.source.commonDir, input.composed.compositionEvidenceBlob!).toString()) as { conflicts: unknown[] }
  assert.equal(overlaps.conflicts.length, 1)
  assert.equal(composeInputSnapshots(input.snapshot, input.baseline!).composed, null)
  const content = f.source.replace('return { ...job };', 'return { ...job, priorDelivery: true, newSource: true };')
  const analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.resolutions = [{ path: 'src/export.js', content, mode: '100644' }] }))
  assert.equal(analysis.findings.length, 0); assert.equal(analysis.resolutions[0].content, content)
  const entry = readTree(input.snapshot.source.commonDir, input.composed.tree).find(item => item.path === 'src/export.js')!
  assert.ok(readObject(input.snapshot.source.commonDir, entry.oid).toString().includes('newSource: true'))
  assert.ok(readFileSync(join(f.delivery, 'src/export.js'), 'utf8').includes('priorDelivery: true'))
})

test('重构只分类映射，不生成业务授权；冲突与GAP保留具体规则/路径/原意/反例稳定ID', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// internal refactor\n`)
  const input = await f.input(), refactor = await analyzeCodeBehavior(input, runner('refactor'))
  assert.deepEqual(refactor.authorizedChanges, []); assert.deepEqual(refactor.findings, [])
  for (const kind of ['conflict', 'coverage_gap'] as const) {
    const first = await analyzeCodeBehavior(input, runner(kind)), second = await analyzeCodeBehavior(input, runner(kind))
    assert.equal(first.findings[0].id, second.findings[0].id); assert.equal(first.findings[0].kind, kind)
    assert.deepEqual(first.findings[0].ruleIds, ['RULE-EXPORT-05']); assert.ok(first.findings[0].originalIntent && first.findings[0].sourceBehavior && first.findings[0].deliveryBehavior && first.findings[0].counterexample)
  }
})

test('独审不完整/不独立、遗漏外部路径、自授权删除与弱化验收均不产出授权', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// new source\n`)
  const input = await f.input()
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.changes = [] })), /遗漏/)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', undefined, review => { review.checkedPaths = [] })), /独审未接受/)
  await assert.rejects(analyzeCodeBehavior(input, async request => { const result = await runner('refactor')(request); return { ...result, sessionId: 'same' } }), /独立会话/)
  await assert.rejects(analyzeCodeBehavior(input, runner('conflict', proposal => { proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05'], source: 'user:raw', reason: '通过删除错误原始验收变绿' }] })), /没有合法已审规则变化/)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.facts = [{ source: 'decision:SELF-APPROVED', text: '自批允许所有人下载' }] })), /没有冻结代码来源/)
})

test('独审路径错误仍把同次业务遗漏与反例交给下一轮修复，不丢失诊断或产生授权', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// observable extension\n`)
  const input = await f.input(), finding = { message: '遗漏成功分支的计数验收', evidence: '成功视图沿用运行中计数期望', counterexample: '完成返回2而完整期望仍为null' }
  input.plan.readPaths = ['src', 'tests', '.spec/export/spec.md', '.spec/export/export-contract/spec.md']
  let rejected: { code: string; message: string } | undefined
  for (const path of ['.spec/export/.plugins', '../outside']) await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', undefined, review => { review.checkedPaths = ['src/export.js', path]; review.verdict = 'repair'; review.findings = [finding] })), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'behavior_analysis_invalid'); assert.match(error.message, /未完整读取的路径|不合法仓库路径/)
    assert.deepEqual(JSON.parse(error.message).review.findings, [finding]); rejected = { code: error.code!, message: error.message }; return true
  })
  const fake = runner('refactor')
  await analyzeCodeBehavior({ ...input, repairDiagnostics: [rejected!] }, async request => { assert.ok(request.prompt.includes(finding.counterexample)); return fake(request) })
})

test('发送前明确列出已commit未治理源码子集，空初始化文件仍需真实归属', async t => {
  const f = await fixture(t), paths = ['src/__init__.py', 'src/view.js']
  writeFileSync(join(f.root, paths[0]), '')
  writeFileSync(join(f.root, paths[1]), 'export const view = job => ({ id: job.id });\n')
  git(f.root, 'add', ...paths); git(f.root, 'commit', '-m', 'existing unowned implementation')
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// authored implementation comment\n`)
  const before = await f.input(), input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, plan: { ...before.plan, sourcePaths: ['src'] } }
  const captured = new Error('frozen ownership input captured')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ requiredChangedPaths: string[]; unownedSourcePaths: string[]; unownedSourcePathCount: number; snapshotTree: string; composed: { tree: string } }>(request.prompt)
    assert.deepEqual(context.unownedSourcePaths, paths)
    assert.equal(context.unownedSourcePathCount, 2)
    assert.ok(context.requiredChangedPaths.includes('src/export.js'))
    assert.equal(context.snapshotTree, input.snapshot.immutableTree)
    assert.equal(context.composed.tree, input.composed.tree)
    assert.match(request.prompt, /已存在.*已commit.*未治理/)
    assert.match(request.prompt, /分组allowed_change不是治理/)
    assert.match(request.prompt, /手工重抄.*反转义/)
    throw captured
  }), error => error === captured)
})

test('归属拒绝一次列全缺失路径和数量，完整newNodes或具体GAP仍沿原门禁', async t => {
  const f = await fixture(t), paths = ['src/__init__.py', 'src/view.js']
  writeFileSync(join(f.root, paths[0]), '')
  writeFileSync(join(f.root, paths[1]), 'export const view = job => ({ id: job.id });\n')
  const input = await f.input()
  let rejected: { code: string; message: string } | undefined
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = [{ ...(proposal.changes as object[])[0], paths }]
  })), (error: Error & { code: string }) => {
    const diagnostic = JSON.parse(error.message) as { approved: boolean; message: string; details: { missingCodePaths: string[]; missingCodePathCount: number }; proposal: { newNodes: object[] } }
    assert.equal(error.code, 'behavior_analysis_invalid')
    assert.equal(diagnostic.approved, false)
    assert.equal(diagnostic.message, `无治理代码未创建真实归属或具体GAP: ${paths[0]}`)
    assert.deepEqual(diagnostic.details.missingCodePaths, paths)
    assert.equal(diagnostic.details.missingCodePathCount, paths.length)
    assert.deepEqual(diagnostic.proposal.newNodes, [])
    rejected = { code: error.code, message: error.message }
    return true
  })
  const complete = runner('allowed_change', proposal => {
    proposal.newNodes = paths.map(codePath => ({ codePath, parentNodeId: 'export-contract', basis: '真实导出任务的对应模块职责' }))
  })
  const repaired = await analyzeCodeBehavior({ ...input, repairDiagnostics: [rejected!] }, async request => {
    const context = readFrozenBehaviorContext<{ repairDiagnostics: { code: string; message: string }[]; requiredChangedPaths: string[]; unownedSourcePaths: string[]; unownedSourcePathCount: number }>(request.prompt)
    assert.deepEqual(context.repairDiagnostics, [rejected])
    assert.deepEqual(context.requiredChangedPaths, paths)
    assert.deepEqual(context.unownedSourcePaths, paths)
    assert.equal(context.unownedSourcePathCount, paths.length)
    return complete(request)
  })
  assert.equal(repaired.reviewPassed, true)
  assert.deepEqual(repaired.newNodes.map(node => node.codePath), paths)
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.newNodes = [{ codePath: paths[1], parentNodeId: 'export-contract', basis: '导出任务可见反馈' }]
  })), (error: Error) => {
    const diagnostic = JSON.parse(error.message) as { details: { missingCodePaths: string[]; missingCodePathCount: number } }
    assert.deepEqual(diagnostic.details.missingCodePaths, [paths[0]])
    assert.equal(diagnostic.details.missingCodePathCount, 1)
    return true
  })
  const gap = await analyzeCodeBehavior(input, runner('coverage_gap'))
  assert.equal(gap.reviewPassed, true)
  assert.deepEqual(gap.newNodes, [])
  assert.deepEqual(gap.findings.flatMap(item => item.paths).sort(), paths)
})

test('无治理新增实现自动定位真实上层并生成唯一叶身份；未知上层不能略过', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/view.js'), 'export const view = job => ({ id: job.id });\n')
  const input = await f.input(), analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: 'src/view.js', parentNodeId: 'export-contract', basis: '导出任务可见反馈属于明确raw' }] }))
  assert.equal(analysis.newNodes.length, 1); assert.match(analysis.newNodes[0].path, /^\.spec\/export\/export-contract\/sync-code-/)
  assert.ok(analysis.newNodes[0].rawSource.includes('[[export-contract]]')); assert.equal(analysis.newNodes[0].codePath, 'src/view.js')
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: 'src/view.js', parentNodeId: 'unknown', basis: '猜测目标' }] })), /没有真实上层需求/)
})

test('共同基线区分前次交付接受回声与真实新raw，已交付详细规则不升为user:raw', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  const delivered = f.raw.replace('成功需非空result、发布一次', '成功需非空result、发布一次并返回额外可观察字段')
  writeFileSync(join(f.delivery, path), delivered); writeFileSync(join(f.root, path), delivered)
  const echo = await analyzeCodeBehavior(await f.input(), runner('refactor'))
  assert.deepEqual(echo.authorChanges, [])
  writeFileSync(join(f.root, path), f.raw.replace('用户可以提交符合筛选条件的数据导出，任务完成后下载结果。', '用户可以提交符合筛选条件的数据导出，任务完成后下载结果并看到明确的计数。'))
  const changed = await analyzeCodeBehavior(await f.input(), runner('allowed_change'))
  assert.equal(changed.authorChanges!.length, 1); assert.ok(changed.authorChanges![0].changedIds.includes('REQ-EXPORT-01'))
  assert.equal(changed.authorChanges![0].changedIds.includes('RULE-EXPORT-05'), false)
})

test('结构化所选retry裁决不能借decision或user:raw来源更改无关幂等RULE/AC', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external behavior\n`)
  const input = await f.input(), previous = await analyzeCodeBehavior(input, runner('conflict', proposal => { proposal.changes = (proposal.changes as { paths: string[] }[]).map(change => ({ ...change, kind: 'conflict', affectedIds: ['RULE-EXPORT-06'], ruleIds: ['RULE-EXPORT-06'], originalIntent: '明确失败后所有者重试', previousBehavior: '保持ID并增加attempt', sourceBehavior: '外部重试规则待裁决', deliveryBehavior: '原明确重试规则', evidence: '重试分支冻结差异', counterexample: '失败后重复RETRY应保持隔离' })) }))
  const ref = writeEvidence(input.snapshot.source.commonDir, previous)
  const request = { requestId: 'retry-only', operationId: 'original-operation', inputId: input.snapshot.id, analysisRef: ref, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'new_rule' as const, rule: '失败后仅允许重试两次' } }
  input.composed.requestBlob = prepareControlledDecision(input.snapshot, request); input.decision = { request, previous: { ref, analysis: previous } }; input.origin = 'decision'
  const source = `decision:${controlledDecisionIdentity(request)}`
  const fact = { source, text: '只变更失败重试次数，幂等、权限和其他规则保持' }
  input.plan.facts = [...input.plan.facts, fact]
  for (const authorizationSource of [source, 'user:raw']) await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-02'] }))
    proposal.facts = [fact]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-02'], source: authorizationSource, reason: '借重试裁决更改幂等政策' }]
  })), /所选裁决范围/)
  const scoped = await analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['AC-EXPORT-08'], ruleIds: ['RULE-EXPORT-06'] }))
    proposal.facts = [fact]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-08', ruleIds: ['RULE-EXPORT-06'], source, reason: '仅对应明确的失败重试新规则' }]
  }))
  assert.equal(scoped.authorizedChanges[0].id, 'AC-EXPORT-08'); assert.deepEqual(scoped.decisionAuthorities![0].ruleIds, ['RULE-EXPORT-06'])
})


test('公共计划识别已交付新增叶ff采纳后的move/完整delete，未采纳缺失不退役', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/summary-child/spec.md'
  const config = { sync: { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['package.json'], facts: [], mandatoryTests: [], budget: { maxAttempts: 2, maxCalls: 8, maxRepairs: 1, timeoutMs: 30000 }, verifications: [{ definition: { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.test.mjs', 'tests/summary.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }] } }
  writeFileSync(join(f.root, '.spec/spexcode.json'), JSON.stringify(config)); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'trusted sync settings'); git(f.delivery, 'merge', '--ff-only', git(f.root, 'rev-parse', 'HEAD'))
  const before = await captureInputSnapshot(f.root)
  const child = `---
title: 导出计数
status: active
contract-schema: sync-v1
code:
  - src/summary.js#resultCount
---
## raw source

遵循 [[export-contract]] 的导出反馈需求。

## expanded spec

### REQ

| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-SUMMARY-01 | 返回行数 | user:raw | 遵循导出反馈 | 返回rows.length | REQ-EXPORT-01 |

### AC

| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SUMMARY-01 | REQ-SUMMARY-01 | 成功行数组 | 读取计数 | 返回rows.length | tests/summary.test.mjs#AC-SUMMARY-01 | VERIFY-EXPORT-01 | derived:REQ-SUMMARY-01 | REQ-SUMMARY-01 |
`
  mkdirSync(join(f.delivery, path, '..'), { recursive: true }); writeFileSync(join(f.delivery, path), child)
  writeFileSync(join(f.delivery, 'src/summary.js'), 'export const resultCount = rows => rows.length;\n'); writeFileSync(join(f.delivery, 'tests/summary.test.mjs'), '// accepted helper acceptance\n')
  git(f.delivery, 'add', '.'); git(f.delivery, 'commit', '-m', 'verified delivery introduces helper governance')
  const baseline: BaselinePair = { id: 'actual-delivery-pair', repositoryId: before.source.repositoryId, source: before.source, sourceInput: before, verifiedDelivery: await captureInputSnapshot(f.delivery), coveredScope: { paths: ['src', '.spec', 'tests'], contractIds: ['REQ-SUMMARY-01', 'AC-SUMMARY-01'], flowIds: [] }, receiptId: 'helper-receipt', settledAtMs: 1 }
  const unaccepted = composeInputSnapshots(before, baseline).composed!
  assert.ok(readTree(before.source.commonDir, unaccepted.tree).some(entry => entry.path === path)); assert.equal(adoptedDeliveryPaths(before, baseline).has(path), false)
  git(f.root, 'merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  const movedPath = '.spec/export/summary-moved/spec.md'
  mkdirSync(join(f.root, movedPath, '..'), { recursive: true }); writeFileSync(join(f.root, movedPath), child); rmSync(join(f.root, path))
  let snapshot = await captureInputSnapshot(f.root), composed = composeInputSnapshots(snapshot, baseline).composed!
  assert.equal(readTree(snapshot.source.commonDir, composed.tree).some(entry => entry.path === path), false)
  let plan = await buildSyncApplicationPlan(snapshot, 'summary-child', baseline)
  let analysis = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-move', policyDigest: 'policy-move', requestKey: 'public-move', timeoutMs: 10000 }, runner('refactor'))
  assert.deepEqual(analysis.nodeChanges, [{ action: 'move', from: { nodeId: 'summary-child', path }, to: { nodeId: 'summary-moved', path: movedPath } }]); assert.deepEqual(analysis.authorizedChanges, [])
  rmSync(join(f.root, movedPath)); rmSync(join(f.root, 'src/summary.js'))
  snapshot = await captureInputSnapshot(f.root); composed = composeInputSnapshots(snapshot, baseline).composed!
  plan = await buildSyncApplicationPlan(snapshot, 'summary-child', baseline)
  assert.equal(plan.intentNodeId, 'export-contract'); assert.ok(plan.targets.some(target => target.path === path)); assert.deepEqual(plan.authorizedChanges, undefined)
  analysis = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-retire', policyDigest: 'policy-retire', requestKey: 'public-retire', timeoutMs: 10000 }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: null, mode: null }] }))
  assert.equal(analysis.findings.length, 0, JSON.stringify(analysis)); assert.deepEqual(analysis.nodeChanges, [{ action: 'retire', from: { nodeId: 'summary-child', path } }]); assert.deepEqual(analysis.authorizedChanges.map(change => [change.id, change.action, change.source]), [['REQ-SUMMARY-01', 'retire', 'user:raw'], ['AC-SUMMARY-01', 'retire', 'user:raw']])
  const explicitlyAuthorized = await analyzeCodeBehavior({ snapshot, composed, baseline, plan: { ...plan, authorizedChanges: analysis.authorizedChanges.filter(change => change.action === 'retire') }, readSetDigest: 'readset-explicit-retire', policyDigest: 'policy-explicit-retire', requestKey: 'explicit-retire', timeoutMs: 10000 }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: null, mode: null }] }))
  assert.deepEqual(explicitlyAuthorized.nodeChanges, analysis.nodeChanges)
  assert.deepEqual(explicitlyAuthorized.authorizedChanges, [], '真实删除仍独审，但原计划已有的精确退役不派生第二份同ID授权')
  const ref = writeEvidence(snapshot.source.commonDir, analysis); assert.ok(deriveBehaviorAuthorization(analysis, ref).every(change => change.analysisRef?.sha256 === ref.sha256))
  assert.ok(analysis.authorChanges!.some(change => change.path === path && change.afterRaw === null))
  const unresolved = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-retire-conflict', policyDigest: 'policy-retire-conflict', requestKey: 'retire-conflict', timeoutMs: 10000 }, runner('refactor'))
  const unresolvedRef = writeEvidence(snapshot.source.commonDir, unresolved), finding = unresolved.findings.find(item => item.paths.includes(path))!
  assert.ok(finding); assert.deepEqual(finding.ruleIds, [])
  for (const choice of ['keep_intent', 'adopt_behavior', 'new_rule'] as const) {
    const request = { requestId: `retire-${choice}`, operationId: 'real-retire-parent', inputId: snapshot.id, analysisRef: unresolvedRef, findingIds: [finding.id], decision: choice === 'new_rule' ? { choice, rule: '退役计数辅助，保留导出主流程和旧验证命令' } : { choice } }
    const requestBlob = prepareControlledDecision(snapshot, request)
    const selected = await analyzeCodeBehavior({ snapshot, composed: { ...composed, requestBlob }, baseline, plan, readSetDigest: `readset-${choice}`, policyDigest: `policy-${choice}`, requestKey: `retire-${choice}`, timeoutMs: 10000, decision: { request, previous: { ref: unresolvedRef, analysis: unresolved } } }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: choice === 'keep_intent' ? child : null, mode: choice === 'keep_intent' ? '100644' : null }] }))
    assert.equal(selected.findings.length, 0, JSON.stringify(selected.findings)); assert.equal(selected.nodeChanges.some(item => item.action === 'retire'), choice !== 'keep_intent')
    if (choice !== 'keep_intent') assert.ok(selected.authorizedChanges.every(item => item.source === `decision:${controlledDecisionIdentity(request)}`))
  }

  writeFileSync(join(f.root, 'src/export.js'), f.source.replace("if (job.state !== 'FAILED')", "if (job.state !== 'FAILED' && job.state !== 'CANCELLED')"))
  const independentSnapshot = await captureInputSnapshot(f.root), independentComposed = composeInputSnapshots(independentSnapshot, baseline).composed!, independentPlan = await buildSyncApplicationPlan(independentSnapshot, 'summary-child', baseline)
  const independentRunner = (unresolved: boolean): ElaborationRunner => runner('allowed_change', (proposal, frozen) => {
    proposal.changes = frozen.changedPaths.map(changed => ({ kind: unresolved && changed === 'src/export.js' ? 'conflict' : 'allowed_change', paths: [changed], affectedIds: changed === 'src/export.js' ? ['RULE-EXPORT-06', 'AC-EXPORT-08'] : ['REQ-SUMMARY-01', 'AC-SUMMARY-01'], ruleIds: changed === 'src/export.js' ? ['RULE-EXPORT-06'] : [], originalIntent: '独立作者删除计数A，重试B只保明确意图', previousBehavior: '计数A存在且只有FAILED重试', sourceBehavior: '作者明确删除A，代码另扩大重试B', deliveryBehavior: '保上次已验证计数与重试政策', evidence: `冻结独立删除/重试路径 ${changed}`, counterexample: 'B保原意不应复活用户已删A' }))
    proposal.resolutions = [{ path, content: null, mode: null }]
  })
  const independentInput = { snapshot: independentSnapshot, composed: independentComposed, baseline, plan: independentPlan, readSetDigest: 'readset-independent-A-B', policyDigest: 'policy-independent-A-B', requestKey: 'independent-A-B', timeoutMs: 10000 }
  const originalAnalysis = await analyzeCodeBehavior(independentInput, independentRunner(true)), originalRef = writeEvidence(independentSnapshot.source.commonDir, originalAnalysis), selectedB = originalAnalysis.findings.find(finding => finding.ruleIds.includes('RULE-EXPORT-06'))!
  const current = { requestId: 'B-does-not-block-author-A', operationId: 'independent-A-B-op', inputId: independentSnapshot.id, analysisRef: originalRef, findingIds: [selectedB.id], decision: { choice: 'keep_intent' as const } }, currentRef = prepareControlledDecision(independentSnapshot, current)
  const concurrent = await analyzeCodeBehavior({ ...independentInput, composed: { ...independentComposed, requestBlob: currentRef }, origin: 'decision', decision: { request: current, previous: { ref: originalRef, analysis: originalAnalysis } } }, independentRunner(false))
  assert.equal(concurrent.findings.length, 0); assert.ok(concurrent.nodeChanges.some(change => change.action === 'retire' && change.from.path === path)); assert.ok(concurrent.authorizedChanges.every(change => change.source === 'user:raw'))
  rmSync(join(f.root, '.spec/export/export-contract'), { recursive: true })
  const empty = await captureInputSnapshot(f.root), finalPlan = await buildSyncApplicationPlan(empty, 'export-contract', baseline)
  assert.equal(finalPlan.intentNodeId, 'export-contract'); assert.ok(finalPlan.targets.some(target => target.path === '.spec/export/export-contract/spec.md' && target.rawSource))
  const frozen = await readFrozenContracts(f.root, new Map(readTree(snapshot.source.commonDir, composed.tree).filter(entry => entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')])))
  assert.ok(frozen.graph.items.has('AC-EXPORT-01'))
})


test('已ff接受交付删除后重建相同源码仍是真新差量，未接受的原source不复活删除', async t => {
  const f = await fixture(t), path = 'src/export.js'
  git(f.delivery, 'rm', path); git(f.delivery, 'commit', '-m', 'verified delivery removes obsolete implementation path')
  const before = await captureInputSnapshot(f.root), baseline = (await f.input()).baseline!
  assert.equal(adoptedDeliveryPaths(before, baseline).has(path), false)
  assert.equal(readTree(before.source.commonDir, composeInputSnapshots(before, baseline).composed!.tree).some(entry => entry.path === path), false)
  git(f.root, 'merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  mkdirSync(join(f.root, 'src'), { recursive: true }); writeFileSync(join(f.root, path), f.source)
  const rebuilt = await captureInputSnapshot(f.root), result = composeInputSnapshots(rebuilt, baseline)
  assert.equal(adoptedDeliveryPaths(rebuilt, baseline).has(path), true); assert.equal(result.conflicts.length, 0)
  const entry = readTree(rebuilt.source.commonDir, result.composed!.tree).find(item => item.path === path)!
  assert.equal(readObject(rebuilt.source.commonDir, entry.oid).toString('utf8'), f.source)
})


test('原immutable作者patch与已交付同一raw行真正重叠由独审整合，choice说明不冒作者字节', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md', old = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。'
  const a = f.raw.replace(old, `${old} 已交付A保持有效。`), b = f.raw.replace(old, `${old} 原immutable作者B保持有效。`), merged = f.raw.replace(old, `${old} 已交付A保持有效。原immutable作者B保持有效。`)
  writeFileSync(join(f.delivery, path), a)
  const original = await f.input(), author = prepareControlledRequest(original.snapshot, { path, source: f.raw, next: b, changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'original-author-B', nodeId: 'export-contract', intent: '原作者B只影响结果反馈' })
  assert.ok(author.changed)
  const conflictInput = { ...original, composed: composeControlledRequest(original.snapshot, original.composed, author.requestBlob, { retainConflicts: true }).composed! }
  assert.ok(conflictInput.composed.compositionEvidenceBlob)
  const previous = await analyzeCodeBehavior(conflictInput, runner('conflict')), previousRef = writeEvidence(original.snapshot.source.commonDir, previous)
  const request = { requestId: 'only-B-choice', operationId: 'original-partial-operation', inputId: original.snapshot.id, analysisRef: previousRef, findingIds: [previous.findings.find(finding => finding.paths.includes(path))!.id], decision: { choice: 'new_rule' as const, rule: 'B采用明确新反馈，未选A和验证义务保持' } }
  const requestBlob = prepareControlledDecision(original.snapshot, request, author.requestBlob), composed = composeControlledRequest(original.snapshot, original.composed, requestBlob, { retainConflicts: true }).composed!
  const analysis = await analyzeCodeBehavior({ ...original, composed, origin: 'decision', decision: { request, previous: { ref: previousRef, analysis: previous } } }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: merged, mode: '100644' }] }))
  const proof = analysis.rawIntegrations![0]
  assert.equal(proof.sourceRaw, parseParts(b)!.rawSource); assert.equal(proof.deliveryRaw, parseParts(a)!.rawSource); assert.equal(proof.resolvedRaw, parseParts(merged)!.rawSource)
  assert.equal(proof.expectedRaw, renderControlledDecisionRaw(parseParts(merged)!.rawSource!, request, previous))
  assert.ok(proof.expectedRaw.includes('已交付A')); assert.ok(proof.expectedRaw.includes('原immutable作者B')); assert.ok(proof.expectedRaw.includes('B采用明确新反馈'))
  assert.equal(analysis.authorChanges!.find(change => change.path === path)!.afterRaw, parseParts(b)!.rawSource)
  assert.notEqual(analysis.authorChanges![0].afterRaw, proof.expectedRaw)
  writeFileSync(join(f.root, path), f.raw.replace('适用域：', '实现说明。适用域：'))
  const codeOnly = await f.input()
  writeFileSync(join(f.delivery, path), f.raw)
  const noOverlap = { ...codeOnly, baseline: (await f.input()).baseline, composed: (await f.input()).composed }
  await assert.rejects(analyzeCodeBehavior(noOverlap, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: merged, mode: '100644' }] })), /raw整合越过实际作者/)
})


test('combined真实raw-only作者种子映射具体RULE02及AC02，独立裁决B不能扩无关C', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  writeFileSync(join(f.root, 'src/export.js'), f.source.replace("if (job.state !== 'FAILED')", "if (job.state !== 'FAILED' && job.state !== 'CANCELLED')"))
  const input = await f.input(), raw = f.raw.replace('用户可以提交符合筛选条件的数据导出，任务完成后下载结果。', '用户可以提交符合筛选条件的数据导出，filter最多128字符，任务完成后下载结果；权限等其余规则不变。')
  const author = prepareControlledRequest(input.snapshot, { path, source: f.raw, next: raw, changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'filter-128-author', nodeId: 'export-contract', intent: 'filter最多128，独立重试分歧另裁决' })
  assert.ok(author.changed)
  const composed = composeControlledRequest(input.snapshot, input.composed, author.requestBlob, { retainConflicts: true }).composed!
  const mapped = (proposal: Record<string, unknown>, frozen: { changedPaths: string[] }, unresolved: boolean): void => {
    proposal.changes = frozen.changedPaths.map(changed => ({ kind: unresolved && changed === 'src/export.js' ? 'conflict' : 'allowed_change', paths: [changed], affectedIds: changed === path ? ['RULE-EXPORT-02', 'AC-EXPORT-02'] : ['RULE-EXPORT-06', 'AC-EXPORT-08'], ruleIds: changed === path ? ['REQ-EXPORT-01', 'RULE-EXPORT-02'] : ['RULE-EXPORT-06'], originalIntent: '参数明确边界和所有者失败重试分别处理', previousBehavior: '参数无128上界，只有FAILED重试', sourceBehavior: '作者明确128边界，代码引入另一重试变化', deliveryBehavior: '保原权限和幂等约束', evidence: `冻结真实作者raw/旧RULE/源码 ${changed}`, counterexample: '129字符拒绝；未选幂等键不得变化' }))
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-02', ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-02'], source: 'user:raw', reason: '原immutable raw明确filter128，独审具体派生RULE02与AC02，不授权其它规则' }]
  }
  const previous = await analyzeCodeBehavior({ ...input, composed, origin: 'combined' }, runner('allowed_change', (proposal, frozen) => mapped(proposal, frozen, true))), ref = writeEvidence(input.snapshot.source.commonDir, previous)
  const finding = previous.findings.find(item => item.ruleIds.includes('RULE-EXPORT-06'))!
  assert.ok(finding)
  const request = { requestId: 'only-retry-B', operationId: 'combined-filter-and-retry', inputId: input.snapshot.id, analysisRef: ref, findingIds: [finding.id], decision: { choice: 'keep_intent' as const } }, requestBlob = prepareControlledDecision(input.snapshot, request, author.requestBlob)
  const finalComposed = composeControlledRequest(input.snapshot, input.composed, requestBlob, { retainConflicts: true }).composed!
  const analysis = await analyzeCodeBehavior({ ...input, composed: finalComposed, origin: 'decision', decision: { request, previous: { ref, analysis: previous } } }, runner('allowed_change', (proposal, frozen) => mapped(proposal, frozen, false)))
  assert.deepEqual(analysis.authorChanges![0].changedIds, ['REQ-EXPORT-01'])
  assert.deepEqual(analysis.decisionAuthorities![0].ruleIds, ['RULE-EXPORT-06'])
  const analysisRef = writeEvidence(input.snapshot.source.commonDir, analysis), authorization = deriveBehaviorAuthorization(analysis, analysisRef)[0]
  assert.equal(authorization.id, 'AC-EXPORT-02'); assert.deepEqual(authorization.action === 'update_acceptance' && authorization.ruleIds, ['REQ-EXPORT-01', 'RULE-EXPORT-02'])
  const beforeFiles = new Map(readTree(input.snapshot.source.commonDir, input.baseline!.verifiedDelivery.immutableTree).map(entry => [entry.path, readObject(input.snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const before = await readFrozenContracts(f.root, beforeFiles)
  const updated = raw.replace('key与非空字符串filter必需；', 'key与非空字符串filter必需，filter最多128字符；').replace('明确拒绝，状态不变 | tests/export.test.mjs#AC-EXPORT-02', '非法输入/129字符明确拒绝，状态不变 | tests/export.test.mjs#AC-EXPORT-02')
  const afterFiles = new Map(beforeFiles); afterFiles.set(path, updated)
  const after = await readFrozenContracts(f.root, afterFiles), policy = { mode: 'reelaborate' as const, authorizedChanges: deriveBehaviorAuthorization(analysis, analysisRef), nodeChanges: [], retiredIds: [], newNodeRawSources: new Map([[path, parseParts(updated)!.rawSource!]]), facts: input.plan.facts, analysis: { ref: analysisRef, analysis }, decisionAuthorities: analysis.decisionAuthorities }
  assert.deepEqual(validateContractEvolution(before, after, policy).filter(issue => issue.severity === 'error'), [])
  afterFiles.set(path, updated.replace('成功需非空result、发布一次；失败需非空reason；重复完成保留首次结果', '失败不需要reason，允许无结果成功'))
  const unrelated = await readFrozenContracts(f.root, afterFiles)
  assert.ok(validateContractEvolution(before, unrelated, policy).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-05'))

  await assert.rejects(analyzeCodeBehavior({ ...input, composed: finalComposed, origin: 'decision', decision: { request, previous: { ref, analysis: previous } } }, runner('allowed_change', (proposal, frozen) => { mapped(proposal, frozen, false); (proposal.acceptanceChanges as { ruleIds: string[] }[])[0].ruleIds = ['RULE-EXPORT-02'] })), /所选裁决范围/)
})


test('ff接受完整P2生成后仅源码小改，真实changedPaths排除已接受Spec和测试回声', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  git(f.root, 'rm', 'src/export.js', 'tests/export.test.mjs')
  writeFileSync(join(f.root, path), `---\ntitle: 导出契约原始输入\nstatus: pending\n---\n## raw source\n\n${parseParts(f.raw)!.rawSource}\n`)
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'pre-P2 author intent without generated implementation')
  git(f.delivery, 'merge', '--ff-only', git(f.root, 'rev-parse', 'HEAD'))
  const before = await captureInputSnapshot(f.root)
  mkdirSync(join(f.delivery, 'src'), { recursive: true }); mkdirSync(join(f.delivery, 'tests'), { recursive: true }); writeFileSync(join(f.delivery, 'src/export.js'), f.source); writeFileSync(join(f.delivery, path), f.raw)
  writeFileSync(join(f.delivery, 'tests/export.test.mjs'), readFileSync(new URL('tests/export.test.mjs', fixturePath), 'utf8'))
  git(f.delivery, 'add', '.'); git(f.delivery, 'commit', '-m', 'complete verified P2 implementation contracts and tests')
  const baseline: BaselinePair = { id: 'complete-p2-verified', repositoryId: before.source.repositoryId, source: before.source, sourceInput: before, verifiedDelivery: await captureInputSnapshot(f.delivery), coveredScope: { paths: ['src', '.spec', 'tests'], contractIds: [], flowIds: [] }, receiptId: 'complete-p2-receipt', settledAtMs: 1 }
  git(f.root, 'merge', '--ff-only', baseline.verifiedDelivery.headCommit)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// behavior preserving implementation edit\n`)
  const snapshot = await captureInputSnapshot(f.root), composed = composeInputSnapshots(snapshot, baseline).composed!, plan = (await f.input()).plan
  let checked = false
  const analysis = await analyzeCodeBehavior({ snapshot, composed, baseline, plan, readSetDigest: 'readset-ff-delta', policyDigest: 'policy-ff-delta', requestKey: 'ff-source-delta', timeoutMs: 10000 }, runner('refactor', (_proposal, frozen) => { checked = true; assert.deepEqual(frozen.changedPaths, ['src/export.js']) }))
  assert.equal(checked, true); assert.deepEqual(analysis.authorChanges, []); assert.equal(analysis.changes.length, 1); assert.equal(analysis.changes[0].kind, 'refactor')
})


test('未选代码keep裁决不能改写无作者差量raw；真实重叠也不能丢双方未改权限C', async t => {
  const f = await fixture(t, source => source.replace('此输入是固定业务验收夹具；', '任何下载均须当前所有者权限。此输入是固定业务验收夹具；'))
  const path = '.spec/export/export-contract/spec.md', originalRaw = parseParts(f.raw)!.rawSource!
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external delta\n`)
  writeFileSync(join(f.root, path), f.raw.replace('适用域：', '实现说明。适用域：'))
  const input = await f.input()
  const scope = (proposal: Record<string, unknown>): void => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['RULE-EXPORT-06'], ruleIds: ['RULE-EXPORT-06'] })) }
  const previous = await analyzeCodeBehavior(input, runner('conflict', scope)), ref = writeEvidence(input.snapshot.source.commonDir, previous)
  assert.deepEqual(previous.authorChanges, [])
  const request = { requestId: 'raw-scope-attack', operationId: 'previous', inputId: input.snapshot.id, analysisRef: ref, findingIds: [previous.findings.find(item => item.paths.includes('src/export.js'))!.id], decision: { choice: 'keep_intent' as const } }
  input.composed.requestBlob = prepareControlledDecision(input.snapshot, request); input.decision = { request, previous: { ref, analysis: previous } }; input.origin = 'decision'
  const malicious = f.raw.replace(originalRaw, '以后任何人均可下载任何导出结果，无须所有者权限。')
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { scope(proposal); proposal.resolutions = [{ path, content: malicious, mode: '100644' }] })), /raw整合越过实际作者\/交付编辑范围/)

  const a = f.raw.replace('符合筛选条件的数据导出', 'filter最多128字符的数据导出'), b = f.raw.replace('任务完成后下载结果', '任务完成后下载结果并显示完成时间')
  writeFileSync(join(f.root, path), a); writeFileSync(join(f.delivery, path), b)
  const overlap = await f.input(); assert.ok(overlap.composed.compositionEvidenceBlob)
  const compatible = f.raw.replace('符合筛选条件的数据导出', 'filter最多128字符的数据导出').replace('任务完成后下载结果', '任务完成后下载结果并显示完成时间')
  const changedC = compatible.replace('任何下载均须当前所有者权限。', '任何人均可下载任何导出结果，不要求当前所有者。')
  await assert.rejects(analyzeCodeBehavior({ ...overlap, origin: 'combined' }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: changedC, mode: '100644' }] })), /raw整合越过实际作者\/交付编辑范围/)
  const accepted = await analyzeCodeBehavior({ ...overlap, origin: 'combined' }, runner('allowed_change', proposal => { proposal.resolutions = [{ path, content: compatible, mode: '100644' }] }))
  assert.equal(accepted.rawIntegrations![0].resolvedRaw, parseParts(compatible)!.rawSource); assert.ok(accepted.rawIntegrations![0].expectedRaw.includes('任何下载均须当前所有者权限。'))
})


test('真实不可变裁决同步所选共享REQ，来源或未选流程不能冒充政策变化', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external permission difference\n`)
  const input = await f.input(), previous = await analyzeCodeBehavior(input, runner('conflict', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01', 'STEP-EXPORT-04', 'AC-EXPORT-03'], ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'] }))
  }))
  const ref = writeEvidence(input.snapshot.source.commonDir, previous), request = { requestId: 'selected-download-permission', operationId: 'original-permission-conflict', inputId: input.snapshot.id, analysisRef: ref, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'new_rule' as const, rule: '成功结果允许非所有者下载；提交、取消、重试、筛选与其他政策保持。' } }
  input.composed.requestBlob = prepareControlledDecision(input.snapshot, request); input.decision = { request, previous: { ref, analysis: previous } }; input.origin = 'decision'
  const source = `decision:${controlledDecisionIdentity(request)}`, fact = { source, text: request.decision.rule }; input.plan.facts = [...input.plan.facts, fact]
  const analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01', 'STEP-EXPORT-04', 'AC-EXPORT-03'], ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'] })); proposal.facts = [fact]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-03', ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'], source, reason: '共享需求与所选权限规则同时反映具体下载例外，未选义务保持' }]
  }))
  const analysisRef = writeEvidence(input.snapshot.source.commonDir, analysis), beforeFiles = new Map(readTree(input.snapshot.source.commonDir, input.baseline!.verifiedDelivery.immutableTree).map(entry => [entry.path, readObject(input.snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const before = await readFrozenContracts(f.root, beforeFiles), req = before.graph.items.get('REQ-EXPORT-01')!, rule = before.graph.items.get('RULE-EXPORT-01')!
  assert.equal(req.kind, 'REQ'); assert.equal(rule.kind, 'RULE')
  const reqRow = f.raw.split('\n').find(line => line.startsWith('| REQ-EXPORT-01 '))!, ruleRow = f.raw.split('\n').find(line => line.startsWith('| RULE-EXPORT-01 '))!
  const updatedReq = reqRow.replace(req.goal, '提交筛选数据导出，成功结果允许非所有者下载，其他政策保持').replace('user:raw', source)
  const sourceOnlyRule = ruleRow.replace('decision:EXPORT-POLICY', source), updatedRule = sourceOnlyRule.replace(rule.constraint, '非空actor可提交；CANCEL/RETRY仍必须是当前所有者；SUCCEEDED结果可由非所有者下载，其他状态继续拒绝')
  const updated = f.raw.replace(reqRow, updatedReq).replace(ruleRow, updatedRule).replace('全部拒绝，原结果可由所有者下载', '非所有者可下载成功结果，取消和重试仍拒绝')
  const selectedPolicy = { mode: 'reelaborate' as const, authorizedChanges: deriveBehaviorAuthorization(analysis, analysisRef), nodeChanges: [], retiredIds: [], newNodeRawSources: new Map(), facts: input.plan.facts, analysis: { ref: analysisRef, analysis }, decisionAuthorities: analysis.decisionAuthorities }
  const validate = async (source: string, override = selectedPolicy) => { const next = new Map(beforeFiles); next.set(path, source); return validateContractEvolution(before, await readFrozenContracts(f.root, next), override) }
  assert.deepEqual(await validate(updated), [])
  const unrelatedRule = before.graph.items.get('RULE-EXPORT-02')!; assert.equal(unrelatedRule.kind, 'RULE')
  const unrelatedRow = f.raw.split('\n').find(line => line.startsWith('| RULE-EXPORT-02 '))!
  const bypass = f.raw.replace(reqRow, updatedReq).replace(ruleRow, sourceOnlyRule).replace(unrelatedRow, unrelatedRow.replace(unrelatedRule.constraint, '任意空filter也可提交，不检查幂等组合').replace('decision:EXPORT-POLICY', source))
  const bypassIssues = await validate(bypass)
  assert.ok(bypassIssues.some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id), 'mixed原finding中的REQ仍必须有实质政策见证')
  assert.ok(bypassIssues.some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === unrelatedRule.id), 'mixed原finding中的REQ不能扩权未选RULE02')
  const keepRequest = { ...request, requestId: 'keep-original-permission', decision: { choice: 'keep_intent' as const } }, keepRef = prepareControlledDecision(input.snapshot, keepRequest), keepSource = `decision:${controlledDecisionIdentity(keepRequest)}`, keepFact = { source: keepSource, text: '保持原权限，修复外部实现' }
  await assert.rejects(analyzeCodeBehavior({ ...input, composed: { ...input.composed, requestBlob: keepRef }, decision: { request: keepRequest, previous: { ref, analysis: previous } }, plan: { ...input.plan, facts: [...input.plan.facts, keepFact] } }, runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01', 'AC-EXPORT-03'], ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'] })); proposal.facts = [keepFact]; proposal.acceptanceChanges = [{ id: 'AC-EXPORT-03', ruleIds: ['REQ-EXPORT-01', 'RULE-EXPORT-01'], source: keepSource, reason: '试图把keep当作权限变更' }]
  })), /所选裁决范围/)
  const foreign = { ...request, requestId: 'foreign-choice', decision: { choice: 'new_rule' as const, rule: '另一选择允许非所有者取消' } }, foreignRef = prepareControlledDecision(input.snapshot, foreign)
  await assert.rejects(analyzeCodeBehavior({ ...input, composed: { ...input.composed, requestBlob: foreignRef } }, runner('allowed_change')), /不能借用另一选择或原分析/)
  const missingWitness = structuredClone(selectedPolicy); missingWitness.analysis.analysis.changes[0].affectedIds = missingWitness.analysis.analysis.changes[0].affectedIds.filter(id => id !== req.id); missingWitness.analysis.ref = { sha256: contentHash(JSON.stringify(missingWitness.analysis.analysis)) }; missingWitness.authorizedChanges = deriveBehaviorAuthorization(missingWitness.analysis.analysis, missingWitness.analysis.ref)
  assert.ok((await validate(updated, missingWitness)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id), '同一allowed_change缺少REQ不能借别的变化拼授权')
  assert.ok((await validate(updated.replace(updatedRule, sourceOnlyRule))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id), '只换规则来源不能授权REQ改义')
  assert.ok((await validate(updated.replace(updatedReq, updatedReq.replace(source, 'decision:EXPORT-POLICY')))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id), '旧裁决文字不授当前REQ权限')
  const stale = structuredClone(selectedPolicy); stale.analysis.analysis.decision!.requestRef = { sha256: contentHash('foreign-decision') }; stale.analysis.ref = { sha256: contentHash(JSON.stringify(stale.analysis.analysis)) }
  assert.ok((await validate(updated, stale)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
  const keep = structuredClone(selectedPolicy); keep.decisionAuthorities![0].decision = { choice: 'keep_intent' }; keep.analysis.analysis.decisionAuthorities = keep.decisionAuthorities; keep.analysis.ref = { sha256: contentHash(JSON.stringify(keep.analysis.analysis)) }
  assert.ok((await validate(updated, keep)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
  assert.ok((await validate(updated.replace('key与非空字符串filter必需；', '允许空filter；'))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === 'RULE-EXPORT-02'))
  const flow = before.graph.items.get('FLOW-EXPORT-02')!; assert.equal(flow.kind, 'FLOW')
  assert.ok((await validate(updated.replace(flow.entry, '任何人可以重试别人的失败任务'))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === flow.id))
})


test('真实REQ-only裁决保留明确需求入口与有限旧政策见证，不能从父需求扩未选义务', async t => {
  const f = await fixture(t), path = '.spec/export/export-contract/spec.md'
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external requirement difference\n`)
  for (const [policyWitness, emptyRuleIds] of [[false, false], [true, false], [false, true], [true, true]]) {
    const input = await f.input(), affectedIds = policyWitness ? ['REQ-EXPORT-01', 'RULE-EXPORT-01'] : ['REQ-EXPORT-01']
    const previous = await analyzeCodeBehavior(input, runner('conflict', proposal => {
      proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds, ruleIds: emptyRuleIds ? [] : ['REQ-EXPORT-01'] }))
    }))
    const ref = writeEvidence(input.snapshot.source.commonDir, previous), request = { requestId: `requirement-only-${policyWitness}-${emptyRuleIds}`, operationId: 'original-requirement-conflict', inputId: input.snapshot.id, analysisRef: ref, findingIds: previous.findings.map(finding => finding.id), decision: { choice: 'new_rule' as const, rule: policyWitness ? '仅成功下载允许非所有者，其他操作保持。' : '明确导出结果包含筛选数据，详细规则保持。' } }
    input.composed.requestBlob = prepareControlledDecision(input.snapshot, request); input.decision = { request, previous: { ref, analysis: previous } }; input.origin = 'decision'
    const source = `decision:${controlledDecisionIdentity(request)}`, fact = { source, text: request.decision.rule }; input.plan.facts = [...input.plan.facts, fact]
    const analysis = await analyzeCodeBehavior(input, runner('allowed_change', proposal => {
      proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds, ruleIds: policyWitness ? ['REQ-EXPORT-01', 'RULE-EXPORT-01'] : ['REQ-EXPORT-01'] })); proposal.facts = [fact]
    }))
    const analysisRef = writeEvidence(input.snapshot.source.commonDir, analysis), beforeFiles = new Map(readTree(input.snapshot.source.commonDir, input.baseline!.verifiedDelivery.immutableTree).map(entry => [entry.path, readObject(input.snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const before = await readFrozenContracts(f.root, beforeFiles), req = before.graph.items.get('REQ-EXPORT-01')!, rule = before.graph.items.get('RULE-EXPORT-01')!, unrelated = before.graph.items.get('RULE-EXPORT-02')!
    assert.equal(req.kind, 'REQ'); assert.equal(rule.kind, 'RULE'); assert.equal(unrelated.kind, 'RULE')
    const reqRow = f.raw.split('\n').find(line => line.startsWith('| REQ-EXPORT-01 '))!, ruleRow = f.raw.split('\n').find(line => line.startsWith('| RULE-EXPORT-01 '))!, unrelatedRow = f.raw.split('\n').find(line => line.startsWith('| RULE-EXPORT-02 '))!
    const updatedReq = reqRow.replace(req.goal, request.decision.rule).replace('user:raw', source), sourceOnlyRule = ruleRow.replace('decision:EXPORT-POLICY', source)
    const updatedRule = sourceOnlyRule.replace(rule.constraint, 'SUCCEEDED允许非所有者下载，取消和重试仍限所有者')
    const candidate = f.raw.replace(reqRow, updatedReq).replace(ruleRow, policyWitness ? updatedRule : ruleRow)
    const selectedPolicy = { mode: 'reelaborate' as const, authorizedChanges: [], nodeChanges: [], retiredIds: [], newNodeRawSources: new Map(), facts: input.plan.facts, analysis: { ref: analysisRef, analysis }, decisionAuthorities: analysis.decisionAuthorities }
    const validate = async (text: string, override = selectedPolicy) => { const next = new Map(beforeFiles); next.set(path, text); return validateContractEvolution(before, await readFrozenContracts(f.root, next), override) }
    assert.deepEqual(await validate(candidate), [], policyWitness ? 'REQ-only可用原affected旧RULE的实质政策见证' : '没有所选/受影响RULE时明确REQ可独立演进')
    const unrelatedChange = candidate.replace(unrelatedRow, unrelatedRow.replace(unrelated.constraint, '任意空filter也可提交').replace('decision:EXPORT-POLICY', source))
    assert.ok((await validate(unrelatedChange)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === unrelated.id))
    assert.ok((await validate(candidate.replace(updatedReq, updatedReq.replace(source, 'decision:EXPORT-POLICY')))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
    const missingChange = structuredClone(selectedPolicy); missingChange.analysis.analysis.changes[0].affectedIds = []; missingChange.analysis.ref = { sha256: contentHash(JSON.stringify(missingChange.analysis.analysis)) }
    assert.ok((await validate(candidate, missingChange)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
    if (policyWitness) {
      assert.ok((await validate(candidate.replace(updatedRule, sourceOnlyRule))).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
      const omittedRule = structuredClone(selectedPolicy); omittedRule.analysis.analysis.changes[0].ruleIds = ['REQ-EXPORT-01']; omittedRule.analysis.ref = { sha256: contentHash(JSON.stringify(omittedRule.analysis.analysis)) }
      assert.ok((await validate(candidate, omittedRule)).some(issue => issue.code === 'decision_scope_exceeded' && issue.itemId === req.id))
    }
  }
})
