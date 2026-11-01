import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { isHostPrivatePath } from './candidate.js'
import { isUtf8Text } from './composition.js'
import { analyzeCodeBehavior, CODE_BEHAVIOR_REVIEW_SCHEMA, CODE_BEHAVIOR_SCHEMA, deriveBehaviorAuthorization, packBehaviorBodies, referenceCodeBehaviorMetadata, type FrozenBehaviorBody } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { adoptedDeliveryPaths, composeInputSnapshots, readCompositionEvidence, type IntentObject, type IntentResidual, type SelectedCompositionEvidence } from './composition.js'
import { prepareHistoryRequest } from './history-input.js'
import { buildSyncApplicationPlan } from './planning.js'
import { readFrozenContracts } from './frozen-contracts.js'
import type { ElaborationRunner } from './elaboration-types.js'
import type { BaselinePair, FrozenBaselineSelection } from './operation-types.js'
import { composeControlledRequest, controlledDecisionIdentity, prepareControlledDecision, prepareControlledRequest, renderControlledDecisionRaw } from './request-input.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { validateContractEvolution } from './contract-evolution.js'
import { parseContract, parseParts } from '@spexcode/spec-core/contracts'
import { canonicalContractFilterBindings, plantContractFilter } from '../contract-filter.js'
import { writeManagedBlock } from '../harness-shim.js'
import { composeAuthoredInput } from './author-input.js'
import { frozenBodyText, readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'
import type { BodyReference } from '../../test/frozen-behavior-context.js'
import type { CodeBehaviorAnalysis, CodeBehaviorKind } from './writeback-types.js'
import { FROZEN_READ_MAX_BYTES, prepareFrozenPrompt, proveFrozenReads, readFrozenManifest, readFrozenRange, verifyFrozenReadProof, type FrozenNativeItem } from '../frozen-context.js'

const fixturePath = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
async function fixture(t: test.TestContext, prepare?: (source: string) => string, extraFiles: Readonly<Record<string, string>> = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'sync-behavior-')), root = join(parent, 'source'), delivery = join(parent, 'delivery')
  mkdirSync(root); cpSync(fixturePath, root, { recursive: true }); if (prepare) { const path = join(root, '.spec/export/export-contract/spec.md'); writeFileSync(path, prepare(readFileSync(path, 'utf8'))) }
  for (const [path, text] of Object.entries(extraFiles)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'behavior fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
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
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
      const proposal = { changes: frozen.changedPaths.map(path => ({ kind, paths: [path], affectedIds: ['RULE-EXPORT-05', 'AC-EXPORT-01'], ruleIds: ['RULE-EXPORT-05'], originalIntent: '成功返回非空结果并发布一次', previousBehavior: '完成任务返回副本', sourceBehavior: '完成任务返回副本与可观察扩展信息', deliveryBehavior: '前次交付保留副本与明确原意', evidence: `完整冻结源码/调用测试 ${path}`, counterexample: '完成同一任务两次不得发布两次' })), facts: [], acceptanceChanges: [], newNodes: [], resolutions: [] }
      patch?.(proposal, frozen); output = proposal
    } else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: CodeBehaviorAnalysis }
      const frozen = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
      const review = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: frozen.changedPaths, checkedChangeIds: reviewed.analysis.changes.map(item => item.id), findings: [] }
      reviewPatch?.(review); output = review
    }
    return { sessionId: `session-${request.purpose}`, threadId: `thread-${request.purpose}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}

test('语义元数据复用同一bodyRef且逐字段无损，所有版本与集合引用真实进入必读计划和冷证明', async t => {
  const f = await fixture(t), baseline = (await f.input()).baseline!
  const path = '.spec/export/export-contract/spec.md', item = parseContract({ nodeId: 'export-contract', path, source: f.raw }).contract!.items[0]
  const entry = readTree(f.base.source.commonDir, f.base.immutableTree).find(entry => entry.path === path)!
  const before: IntentObject = { path, entry, item, semanticDigest: 'before', rawSource: '\uFEFF旧原意\r\n末尾\r\n', businessProse: '共同正文🙂\r\n'.repeat(120), codePaths: ['src/export.js'], testPaths: ['tests/export.test.mjs'] }
  const delivery: IntentObject = { ...before, semanticDigest: 'delivery', rawSource: null, businessProse: '交付正文\r\n' }
  const source: IntentObject = { ...before, semanticDigest: 'source', rawSource: '\uFEFF新原意\r\n', item: { ...item, line: item.line + 3 } }
  const residual: IntentResidual = { resource: { kind: 'contract', id: item.id }, pairId: baseline.id, before, delivery, source, adopted: false, changed: true, broadChange: false }
  const absent: IntentResidual = { ...residual, resource: { kind: 'contract', id: 'PENDING-OWNER' }, pairId: null, before: null, delivery: null, source: null }
  const evidence: SelectedCompositionEvidence = { version: 'selected-composition-v1', sourceInputId: f.base.id, baselineSelectionDigest: 'selection', executionPaths: [path], contextPaths: ['src/export.js'], paths: [], intents: [residual, absent], artifacts: [], residualPaths: [path], conflicts: [],
    controlledAuthorPatch: { requestBlob: { sha256: 'p'.repeat(64) }, before: entry, next: { ...entry, oid: 'c'.repeat(40) }, intents: [residual, absent, residual] },
    controlledAuthorGroup: { requestBlob: { sha256: 'g'.repeat(64) }, changes: [{ path, before: entry, next: null }, { path: 'restored', before: null, next: entry }], intents: [absent, residual] } }
  const baselineSelection: FrozenBaselineSelection = { version: 'sync-baseline-selection-v1', source: f.base.source, digest: 'selection', bindings: [
    { resource: { kind: 'path', path }, bytePair: baseline }, { resource: { kind: 'contract', id: item.id }, intentPair: baseline },
    { resource: { kind: 'flow', id: 'PENDING-OWNER' }, intentPair: null }, { resource: { kind: 'path', path: 'other' }, bytePair: { ...baseline, receiptId: 'different-content-with-the-same-id' } },
  ] }
  const original = { contractItems: { previous: [item], current: [source.item, item] }, compositionEvidence: evidence, baselinePair: baseline, baselineSelection,
    oldSource: [], newSource: [], authorBaseline: [], verifiedDelivery: [], composedFiles: [], controlledBeforeFiles: [], nonTextFiles: [], intentArtifactFiles: [], authorByteProjections: [] }
  const unchanged = JSON.stringify(original), bodies = new Map<string, FrozenBehaviorBody>()
  const referenced = referenceCodeBehaviorMetadata(original, text => {
    const bodyRef = contentHash(Buffer.from(text, 'utf8')); bodies.set(bodyRef, { bodyRef, text, required: true }); return { bodyRef }
  })
  const packed = { ...referenced, textEncoding: 'sha256-body-entry-v3', ...packBehaviorBodies([...bodies.values()]) }
  const { frozenEntries, ...wire } = packed, prompt = `冻结三方输入:\n${JSON.stringify(wire)}`, request = { prompt, frozenEntries }
  assert.equal(JSON.stringify(original), unchanged, '投影不能改动权威原对象')
  assert.deepEqual(readFrozenBehaviorContext(request), original)
  assert.deepEqual(Buffer.from((readFrozenBehaviorContext<typeof original>(request).compositionEvidence.intents[0].before!).rawSource!), Buffer.from(before.rawSource!))
  const bindings = referenced.baselineSelection!.bindings
  const firstPair = 'bytePair' in bindings[0] ? bindings[0].bytePair : null, samePair = 'intentPair' in bindings[1] ? bindings[1].intentPair : null, differentPair = 'bytePair' in bindings[3] ? bindings[3].bytePair : null
  assert.ok(firstPair && 'bodyRef' in firstPair && samePair && 'bodyRef' in samePair && differentPair && 'bodyRef' in differentPair)
  assert.equal(firstPair.bodyRef, samePair.bodyRef)
  assert.notEqual(firstPair.bodyRef, differentPair.bodyRef, '同业务ID不同内容必须保持不同引用')
  assert.deepEqual(referenced.compositionEvidence!.intents[1], absent)
  assert.equal(referenced.compositionEvidence!.intents[0].before!.bodyRef, referenced.compositionEvidence!.controlledAuthorPatch!.intents[2].before!.bodyRef)
  for (const locator of Object.values(wire.bodyIndex)) assert.equal(locator.required, true)
  const prepared = prepareFrozenPrompt({ root: f.root, requestKey: 'metadata-input', inputDigest: contentHash(prompt), prompt, frozenEntries, model: 'zcode:bigmodel-api/GLM-5.3-Flash' }, { directory: join(f.root, '..', 'metadata-frozen') })
  const ref = prepared.frozenContext!, manifest = readFrozenManifest(ref)
  assert.ok(manifest.entries.every(entry => entry.required))
  const catalog = JSON.parse(prepared.prompt.split('\n').at(-1)!) as { readBatches: { entryId: string; ranges: { startByte: number; endByte: number }[] }[] }
  const items: FrozenNativeItem[] = catalog.readBatches.flatMap(batch => batch.ranges.map(range => {
    const read = readFrozenRange(ref, { contextDigest: ref.contextDigest, entryId: batch.entryId, ...range })
    return { type: 'dynamicToolCall', id: `${batch.entryId}:${range.startByte}`, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true, arguments: read.arguments, contentItems: read.response.contentItems }
  }))
  const identity = { threadId: 'metadata-thread', turnId: 'metadata-turn' }, proof = proveFrozenReads(ref, identity, items)
  verifyFrozenReadProof(ref, proof, identity)
  assert.deepEqual(proof.coveredEntryIds, manifest.entries.map(entry => entry.id))
  assert.throws(() => proveFrozenReads(ref, identity, items.filter(item => (item.arguments as { entryId: string }).entryId === 'task')), /required frozen entry/)
  const corrupt = structuredClone(wire); corrupt.compositionEvidence!.intents[0].before!.bodyRef = '0'.repeat(64)
  assert.throws(() => readFrozenBehaviorContext({ ...request, prompt: `冻结三方输入:\n${JSON.stringify(corrupt)}` }), /缺少冻结正文引用/)
  assert.throws(() => readFrozenBehaviorContext({ ...request, frozenEntries: frozenEntries.map(entry => ({ ...entry, required: false })) }), /必读正文未登记/)
  assert.throws(() => packBehaviorBodies([{ bodyRef: '0'.repeat(64), text: 'changed', required: true }]), /内容引用不一致/)
  t.diagnostic(JSON.stringify({ logicalBytes: Buffer.byteLength(unchanged), taskBytes: Buffer.byteLength(prompt), requiredBytes: frozenEntries.reduce((n, entry) => n + (entry.kind === 'utf8' ? Buffer.byteLength(entry.text) : 0), 0), uniqueBodies: bodies.size, plannedReads: items.length }))
})

test('独审schema冻结正确摘要并明确accept不携带问题条目', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), f.source + '\n// unchanged behavior\n')
  const delegated = runner('refactor')
  const inputRefs: string[] = []
  let reviewed = false
  const result = await analyzeCodeBehavior(await f.input(), async request => {
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { baselinePair: BodyReference; bodyIndex: Record<string, { entryId: string; required: boolean }> }
    const locator = wire.bodyIndex[wire.baselinePair.bodyRef]
    assert.equal(locator.required, true)
    assert.equal(request.frozenEntries!.find(entry => entry.id === locator.entryId)!.required, true)
    inputRefs.push(wire.baselinePair.bodyRef)
    if (request.purpose === 'code_behavior_review') {
      reviewed = true
      const value = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string }
      const properties = request.schema.properties as Record<string, { enum?: string[]; description?: string }>
      assert.deepEqual(properties.inputDigest.enum, [request.inputDigest])
      assert.deepEqual(properties.analysisDigest.enum, [value.analysisDigest])
      assert.match(properties.findings.description!, /accept.*空数组/)
      assert.match(request.prompt, /accept.*findings.*空数组/)
    }
    return delegated(request)
  })
  assert.equal(reviewed, true)
  assert.equal(result.reviewPassed, true)
  assert.equal(inputRefs.length, 2); assert.equal(inputRefs[0], inputRefs[1], '分析与独审须分别收到同一完整必读语义投影')
})

test('未改可读正文不能因整体打包变为必读，仍按冻结原字节可选读取', async t => {
  const f = await fixture(t)
  const optional = '\uFEFFUNRELATED-FROZEN-BODY\n' + '不相关只读正文🙂\n'.repeat(60000)
  for (const root of [f.root, f.delivery]) {
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs/unrelated.txt'), optional)
    git(root, 'add', 'docs'); git(root, 'commit', '-m', 'seed unchanged readable context')
  }
  const before = await captureInputSnapshot(f.root), delivered = await captureInputSnapshot(f.delivery)
  const changedSource = f.source + '\n// changed-code-required\n'
  writeFileSync(join(f.root, 'src/export.js'), changedSource)
  const initial = await f.input(), baseline = { ...initial.baseline!, sourceInput: before, verifiedDelivery: delivered }
  const input = { ...initial, baseline, composed: composeInputSnapshots(initial.snapshot, baseline, { retainConflicts: true }).composed!, plan: { ...initial.plan, readPaths: [...initial.plan.readPaths, 'docs'] } }
  let captured = false
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    captured = true
    const prepared = prepareFrozenPrompt(request, { directory: join(f.root, '..', 'frozen-demand'), binding: { attemptId: 'demand-probe', policyDigest: input.policyDigest } })
    assert.ok(prepared.frozenContext)
    const ref = prepared.frozenContext, manifest = readFrozenManifest(ref)
    const requiredText: string[] = []
    for (const entry of manifest.entries.filter(entry => entry.required && entry.kind === 'utf8')) {
      for (let startByte = 0; startByte < entry.byteLength; startByte += FROZEN_READ_MAX_BYTES) {
        const result = readFrozenRange(ref, { contextDigest: ref.contextDigest, entryId: entry.id, startByte, endByte: Math.min(startByte + FROZEN_READ_MAX_BYTES, entry.byteLength) })
        requiredText.push((JSON.parse(result.response.contentItems[0].text) as { text: string }).text)
      }
    }
    assert.equal(requiredText.some(text => text.includes('UNRELATED-FROZEN-BODY')), false, '未改且未被契约引用的可读正文不应进入必读内容')
    assert.ok(requiredText.some(text => text.includes('changed-code-required')), '真实变更源码必须完整保留在必读内容')
    const optionalEntry = manifest.entries.find(entry => entry.id === contentHash(Buffer.from(optional, 'utf8')))
    assert.ok(optionalEntry, '可选正文必须仍完整存在于同一冻结清单')
    assert.equal(optionalEntry.required, false)
    writeFileSync(join(f.root, 'docs/unrelated.txt'), 'live bytes must not replace frozen data')
    const first = readFrozenRange(ref, { contextDigest: ref.contextDigest, entryId: optionalEntry.id, startByte: 0, endByte: Math.min(FROZEN_READ_MAX_BYTES, optionalEntry.byteLength) })
    assert.ok((JSON.parse(first.response.contentItems[0].text) as { text: string }).text.includes('UNRELATED-FROZEN-BODY'))
    throw new Error('frozen-demand-probe-complete')
  }), /frozen-demand-probe-complete/)
  assert.equal(captured, true)
})

test('第二份独立Git仓库按同一角色冻结删除、前后版本、中文BOM与同字节多角色', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'sync-behavior-role-')), root = join(parent, 'repo'), delivery = join(parent, 'delivery')
  mkdirSync(root); cpSync(fixturePath, root, { recursive: true })
  const deleted = '\uFEFF删除前的中文🙂\r\n', shared = 'shared-role-bytes\n', orphan = 'orphan unchanged test\n', changed = '\n// SECOND-REPO-CHANGED\n'
  const boundaryBOM = 'a'.repeat(FROZEN_READ_MAX_BYTES - 1) + '\uFEFF正文\r\n'
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'extra'))
  writeFileSync(join(root, 'docs/removed.txt'), deleted)
  writeFileSync(join(root, 'docs/boundary-bom.txt'), boundaryBOM)
  writeFileSync(join(root, 'docs/role-a.txt'), shared); writeFileSync(join(root, 'extra/role-b.txt'), shared)
  writeFileSync(join(root, 'tests/orphan.test.mjs'), orphan)
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'role fixture'); git(root, 'config', 'user.email', 'role@example.invalid'); git(root, 'add', '.'); git(root, 'commit', '-m', 'second repo base')
  git(root, 'switch', '-c', 'source'); git(root, 'worktree', 'add', '-b', 'delivery', delivery, 'HEAD')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const before = await captureInputSnapshot(root), delivered = await captureInputSnapshot(delivery)
  const source = readFileSync(join(root, 'src/export.js'), 'utf8')
  writeFileSync(join(root, 'src/export.js'), source + changed); rmSync(join(root, 'docs/removed.txt'))
  const raw = readFileSync(join(root, '.spec/export/export-contract/spec.md'), 'utf8')
  const snapshot = await captureInputSnapshot(root)
  const baseline: BaselinePair = { id: 'pair-second', repositoryId: snapshot.source.repositoryId, source: before.source, sourceInput: before, verifiedDelivery: delivered, coveredScope: { paths: ['src', '.spec', 'tests', 'docs', 'extra'], contractIds: [], flowIds: [] }, receiptId: 'receipt-second', settledAtMs: 1 }
  const composed = composeInputSnapshots(snapshot, baseline, { retainConflicts: true }).composed!
  const plan = { version: 'sync-coordinator-v1' as const, intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: '.spec/export/export-contract/spec.md' }], readPaths: ['src', '.spec', 'tests', 'docs', 'extra'], writePaths: ['src', '.spec', 'tests', 'docs', 'extra'], facts: [{ source: 'decision:EXPORT-POLICY', text: raw }], verifications: [], mandatoryTests: [{ verificationId: 'VERIFY-EXPORT-01', testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-01' }] }
  const input: CodeBehaviorInput = { snapshot, baseline, composed, readSetDigest: 'readset-second', policyDigest: 'policy-second', requestKey: 'behavior-second', timeoutMs: 10000, plan }
  const referenced = readFileSync(join(root, 'tests/export.test.mjs'), 'utf8')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const prepared = prepareFrozenPrompt(request, { directory: join(parent, 'frozen'), binding: { attemptId: 'second-attempt', policyDigest: input.policyDigest } })
    const manifest = readFrozenManifest(prepared.frozenContext!)
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { bodyIndex: Record<string, { required: boolean; entryId: string }>; oldSource: [string, BodyReference][]; newSource: [string, BodyReference][] }
    const entryFor = (text: string) => manifest.entries.find(entry => entry.id === wire.bodyIndex[contentHash(Buffer.from(text, 'utf8'))].entryId)
    const required = entryFor(source + changed), previous = entryFor(source), removed = entryFor(deleted), optional = entryFor(shared), unused = entryFor(orphan), testEntry = entryFor(referenced)
    assert.equal(required?.required, true); assert.equal(previous?.required, true)
    assert.notEqual(new Map(wire.newSource).get('src/export.js')?.bodyRef, new Map(wire.oldSource).get('src/export.js')?.bodyRef)
    assert.equal(removed?.required, true); assert.equal(removed!.label.includes('删除前的中文'), false)
    assert.equal(optional?.required, false); assert.equal(manifest.entries.filter(entry => entry.sha256 === optional!.sha256).length, 1)
    assert.equal(unused?.required, false); assert.equal(testEntry?.required, true)
    const oldShared = wire.oldSource.filter(([path]) => path === 'docs/role-a.txt' || path === 'extra/role-b.txt')
    assert.equal(oldShared.length, 2); assert.equal(oldShared[0][1].bodyRef, oldShared[1][1].bodyRef); assert.equal(wire.bodyIndex[oldShared[0][1].bodyRef].required, false)
    const deletedRef = contentHash(Buffer.from(deleted, 'utf8'))
    assert.equal(new Map(wire.oldSource).get('docs/removed.txt')?.bodyRef, deletedRef)
    assert.equal(wire.newSource.some(([path]) => path === 'docs/removed.txt'), false)
    assert.equal(frozenBodyText(request, deletedRef), deleted)
    const response = readFrozenRange(prepared.frozenContext!, { contextDigest: prepared.frozenContext!.contextDigest, entryId: removed!.id, startByte: 0, endByte: removed!.byteLength }).response
    assert.equal((JSON.parse((JSON.parse(response.contentItems[0].text) as { text: string }).text) as Record<string, string>)[deletedRef], deleted, '真实工具回包解码仍保留BOM与CRLF')
    const boundary = entryFor(boundaryBOM)!, chunks: string[] = []
    for (let startByte = 0; startByte < boundary.byteLength; startByte += FROZEN_READ_MAX_BYTES) chunks.push((JSON.parse(readFrozenRange(prepared.frozenContext!, { contextDigest: prepared.frozenContext!.contextDigest, entryId: boundary.id, startByte, endByte: Math.min(startByte + FROZEN_READ_MAX_BYTES, boundary.byteLength) }).response.contentItems[0].text) as { text: string }).text)
    assert.equal(JSON.parse(chunks.join('')), boundaryBOM, '每个对齐分段开头的BOM也须完整还原')
    assert.equal(request.prompt.includes(deleted), false); assert.equal(request.prompt.includes('SECOND-REPO-CHANGED'), false)
    assert.equal(prepared.frozenContext!.contextDigest.length, 64)
    throw new Error('second-repo-role-probe-complete')
  }), /second-repo-role-probe-complete/)
})

test('raw-only规格的精确、目录和glob引用保持必读，未改二进制按需保留完整对象', async t => {
  const f = await fixture(t), specPath = '.spec/export/linked-raw/spec.md'
  const raw = '---\ntitle: 原始引用\nstatus: active\ncode:\n  - docs/exact.txt#claim\nrelated:\n  - tests/stable/\n  - docs/glob/*.txt\n---\n# 原始引用\n\n## raw source\n\n保持引用的真实行为与测试。\n'
  const scalar = '---\ntitle: 标量引用\nstatus: active\ncode: docs/scalar.txt#claim\nrelated: tests/scalar/\n---\n# 标量引用\n\n## raw source\n\n保持标量路径引用。\n'
  const referenced = { 'docs/exact.txt': 'exact-reference\n', 'tests/stable/unchanged.test.mjs': 'directory-reference\n', 'docs/glob/readme.txt': 'glob-reference\n', 'docs/scalar.txt': 'scalar-code-reference\n', 'tests/scalar/unchanged.test.mjs': 'scalar-related-reference\n' }
  const binary = Buffer.alloc(600000, 0xff)
  for (const root of [f.root, f.delivery]) {
    mkdirSync(join(root, '.spec/export/linked-raw'), { recursive: true }); writeFileSync(join(root, specPath), raw)
    mkdirSync(join(root, '.spec/export/scalar-raw'), { recursive: true }); writeFileSync(join(root, '.spec/export/scalar-raw/spec.md'), scalar)
    for (const [path, text] of Object.entries(referenced)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
    mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'assets/unrelated.bin'), binary)
    git(root, 'add', '.'); git(root, 'commit', '-m', 'raw-only references and optional binary')
  }
  const before = await captureInputSnapshot(f.root), delivered = await captureInputSnapshot(f.delivery)
  writeFileSync(join(f.root, 'src/export.js'), f.source + '\n// raw-only demand probe\n')
  const initial = await f.input(), baseline = { ...initial.baseline!, sourceInput: before, verifiedDelivery: delivered }
  const input = { ...initial, baseline, composed: composeInputSnapshots(initial.snapshot, baseline, { retainConflicts: true }).composed!, plan: { ...initial.plan, readPaths: [...initial.plan.readPaths, 'docs', 'assets'] } }
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const prepared = prepareFrozenPrompt(request, { directory: join(f.root, '..', 'frozen-raw-only'), binding: { attemptId: 'raw-only-probe', policyDigest: input.policyDigest } })
    const ref = prepared.frozenContext!, manifest = readFrozenManifest(ref)
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1]) as { bodyIndex: Record<string, { entryId: string }>; nonTextFiles: { path: string; bodyRef: string; content?: string; encoding: string }[] }
    for (const text of [raw, scalar, ...Object.values(referenced)]) assert.equal(manifest.entries.find(entry => entry.id === wire.bodyIndex[contentHash(Buffer.from(text))].entryId)?.required, true, 'raw-only和其真实引用全文必读')
    assert.equal(new Set([raw, scalar, ...Object.values(referenced)].map(text => wire.bodyIndex[contentHash(Buffer.from(text))].entryId)).size, 1, '必读小正文共享一个运输entry，避免逐文件Native往返')
    const file = wire.nonTextFiles.find(file => file.path === 'assets/unrelated.bin')!
    assert.equal(file.encoding, 'base64'); assert.equal(file.content, undefined)
    const entry = manifest.entries.find(entry => entry.id === file.bodyRef)!
    assert.equal(entry.required, false)
    assert.ok(Buffer.byteLength(request.prompt) < binary.length, '未改二进制不能继续把必读元数据撑大')
    const chunks: string[] = []
    for (let startByte = 0; startByte < entry.byteLength; startByte += FROZEN_READ_MAX_BYTES) chunks.push((JSON.parse(readFrozenRange(ref, { contextDigest: ref.contextDigest, entryId: entry.id, startByte, endByte: Math.min(startByte + FROZEN_READ_MAX_BYTES, entry.byteLength) }).response.contentItems[0].text) as { text: string }).text)
    assert.deepEqual(Buffer.from(JSON.parse(chunks.join('')) as string, 'base64'), binary, '真实冻结工具完整还原非文本原字节')
    throw new Error('raw-only-demand-probe-complete')
  }), /raw-only-demand-probe-complete/)
})

test('未读可选正文被事实或checkedPaths引用时拒绝，完整读取后可通过', async t => {
  const f = await fixture(t), path = 'docs/optional.txt', optional = 'OPTIONAL-UNREAD-BODY\n'
  for (const root of [f.root, f.delivery]) {
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, path), optional)
    git(root, 'add', 'docs'); git(root, 'commit', '-m', 'optional readable body')
  }
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// optional-read-probe\n`)
  const before = await captureInputSnapshot(f.root), delivered = await captureInputSnapshot(f.delivery)
  const initial = await f.input(), baseline = { ...initial.baseline!, sourceInput: before, verifiedDelivery: delivered }
  const input = { ...initial, baseline, composed: composeInputSnapshots(initial.snapshot, baseline, { retainConflicts: true }).composed!, plan: { ...initial.plan, readPaths: [...initial.plan.readPaths, 'docs'] } }
  const entryId = contentHash(Buffer.from(optional, 'utf8'))
  const proofFor = (purpose: string, covered: string[]) => ({ contextDigest: 'a'.repeat(64), threadId: `thread-${purpose}`, turnId: 'turn-1', receipts: [], coveredEntryIds: covered, historyDigest: 'b'.repeat(64) })
  const fact = { source: `code:${path}#note`, text: '可选正文事实' }
  await assert.rejects(analyzeCodeBehavior(input, request => runner('refactor', proposal => { proposal.facts = [fact] })(request)), /可选正文未在该精确turn完整读取: docs\/optional\.txt/)
  await assert.rejects(analyzeCodeBehavior(input, request => runner('refactor', undefined, review => { review.checkedPaths = [...review.checkedPaths as string[], path] })(request)), /可选正文未在该精确turn完整读取: docs\/optional\.txt/)
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const result = await runner('refactor', undefined, review => { review.checkedPaths = [...review.checkedPaths as string[], path] })(request)
    return { ...result, frozenReadProof: proofFor('other-purpose', [entryId]) }
  }), /可选正文未在该精确turn完整读取: docs\/optional\.txt/)
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const result = await runner('refactor', proposal => { proposal.facts = [fact] })(request)
    return { ...result, frozenReadProof: proofFor(request.purpose, request.purpose === 'code_behavior_analyze' ? [entryId] : []) }
  }), /可选正文未在该精确turn完整读取: docs\/optional\.txt/, '分析已读不能代替独审重读其所批准事实')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    const result = await runner('refactor', undefined, review => { review.checkedPaths = [...review.checkedPaths as string[], path] })(request)
    return { ...result, frozenReadProof: proofFor(request.purpose, []) }
  }), /可选正文未在该精确turn完整读取: docs\/optional\.txt/)
  const accepted = await analyzeCodeBehavior(input, async request => {
    const result = await runner('refactor', proposal => { proposal.facts = [fact] }, review => { review.checkedPaths = [...new Set([...(review.checkedPaths as string[]), path])] })(request)
    return { ...result, frozenReadProof: proofFor(request.purpose, [entryId]) }
  })
  assert.equal(accepted.reviewPassed, true)
  assert.equal(accepted.facts.some(item => item.source === fact.source && item.text === fact.text), true)
})

test('分区changes仅报告真实changedPaths，可读事实和未来写目标不能混入proposal', async t => {
  const f = await fixture(t), prepared = await f.input(), path = '.spec/export/export-contract/spec.md', codePath = 'src/export.js'
  const input = { ...prepared, partition: { id: 'spec-only', changedPaths: [path], factSourcePaths: [codePath] } }
  const calls: string[] = []
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    calls.push(request.purpose)
    return runner('refactor', proposal => {
      proposal.changes = [...proposal.changes as object[], { ...(proposal.changes as object[])[0], paths: [codePath] }]
    })(request)
  }), error => {
    assert.equal((error as { code: string }).code, 'behavior_analysis_invalid')
    const diagnostic = JSON.parse((error as Error).message)
    assert.deepEqual(diagnostic.details, { partitionId: 'spec-only', expectedChangedPaths: [path], invalidPaths: [codePath] })
    assert.deepEqual(diagnostic.proposal.changes.map((change: { paths: string[] }) => change.paths), [[path], [codePath]])
    return true
  })
  assert.deepEqual(calls, ['code_behavior_analyze'], '错误内容应在独审前反馈，不能等聚合绑定失败')
  const fact = { source: `code:${codePath}#ExportService`, text: '已有源码提供导出行为事实。' }
  const accepted = await analyzeCodeBehavior(input, async request => {
    const result = await runner('refactor', proposal => { proposal.facts = [fact] }, review => { review.checkedPaths = [path, codePath] })(request)
    return { ...result, frozenReadProof: { contextDigest: 'a'.repeat(64), threadId: result.threadId, turnId: result.turnId, receipts: [], coveredEntryIds: [contentHash(Buffer.from(f.source))], historyDigest: 'b'.repeat(64) } }
  })
  assert.equal(accepted.reviewPassed, true); assert.deepEqual(accepted.facts, [fact])
  assert.deepEqual(accepted.changes.flatMap(change => change.paths), [path])
})

test('分区新增Code事实仅引用本区精确owner路径，共享只读测试留在change evidence', async t => {
  const f = await fixture(t), codePath = 'src/export.js', readonlyTestPath = 'tests/export.test.mjs'
  writeFileSync(join(f.root, codePath), `${f.source}\n// partition owner fact probe\n`)
  const prepared = await f.input(), factSourcePaths = [codePath]
  const input: CodeBehaviorInput = { ...prepared, partition: { id: 'owned-facts', changedPaths: [codePath], factSourcePaths } }
  const sharedTestFact = { source: `code:${readonlyTestPath}#fixture`, text: '共享只读测试中的fixture说明了所有状态路径。' }
  await assert.rejects(analyzeCodeBehavior(input, runner('refactor', proposal => { proposal.facts = [sharedTestFact] })), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error & { code?: string }).code, 'behavior_analysis_invalid')
    const diagnostic = JSON.parse(error.message) as { details: { paths: string[]; factSourcePaths: string[] } }
    assert.deepEqual(diagnostic.details.paths, [readonlyTestPath])
    assert.deepEqual(diagnostic.details.factSourcePaths, factSourcePaths)
    return true
  })

  const ownerFact = { source: `code:${codePath}#ExportService`, text: '本区ExportService对导出任务执行幂等提交。' }
  const owner = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ partition: { id: string; changedPaths: string[]; factSourcePaths: string[] } }>(request)
    assert.deepEqual(context.partition, { id: 'owned-facts', changedPaths: [codePath], factSourcePaths })
    return runner('refactor', (proposal, frozen) => {
      proposal.facts = [ownerFact]
      proposal.changes = (proposal.changes as Record<string, unknown>[]).map(change => ({
        ...change,
        evidence: `${String(change.evidence)}; 完整只读测试 ${readonlyTestPath}#AC-EXPORT-01 的断言作为调用边界证据。`,
      }))
      assert.ok(frozen.changedPaths.includes(codePath))
    })(request)
  })
  assert.equal(owner.reviewPassed, true)
  assert.deepEqual(owner.facts, [ownerFact])
  assert.match(owner.changes[0].evidence, new RegExp(`${readonlyTestPath}#AC-EXPORT-01`))

  await assert.rejects(analyzeCodeBehavior(input, runner('refactor', proposal => {
    proposal.facts = [ownerFact, { ...ownerFact, text: '同一anchor不能在本区声明另一份不同事实。' }]
  })), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal((error as Error & { code?: string }).code, 'behavior_analysis_invalid')
    const diagnostic = JSON.parse(error.message) as { message: string; details: { paths: string[]; factSourcePaths: string[] } }
    assert.match(diagnostic.message, /同一source不能提供不同text/)
    assert.deepEqual(diagnostic.details.paths, [codePath])
    assert.deepEqual(diagnostic.details.factSourcePaths, factSourcePaths)
    return true
  })

  const trustedFact = { source: sharedTestFact.source, text: '已有可信测试事实由原计划逐字提供。' }
  const trustedInput: CodeBehaviorInput = { ...input, plan: { ...input.plan, facts: [...input.plan.facts, trustedFact] } }
  const trusted = await analyzeCodeBehavior(trustedInput, runner('refactor', proposal => { proposal.facts = [trustedFact] }))
  assert.equal(trusted.reviewPassed, true)
  assert.deepEqual(trusted.facts, [trustedFact])
})

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
  const globalReviewSchema = structuredClone(CODE_BEHAVIOR_REVIEW_SCHEMA)
  await analyzeCodeBehavior(input, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ contractItems: { previous: { id: string; kind: string }[]; current: { id: string; kind: string }[] } }>(request)
      const expectedAcceptanceIds = [...new Set([...frozen.contractItems.previous, ...frozen.contractItems.current].filter(item => item.kind === 'AC').map(item => item.id))].sort()
      const properties = request.schema.properties as Record<string, { maxItems?: number; items?: { properties: Record<string, { enum?: string[] }> } }>
      const acceptanceChanges = properties.acceptanceChanges
      assert.deepEqual(acceptanceChanges.items!.properties.id.enum, expectedAcceptanceIds)
      assert.equal(acceptanceChanges.maxItems, undefined)
      assert.equal(properties.newNodes.maxItems, 0)
      assert.notEqual(request.schema, CODE_BEHAVIOR_SCHEMA)
      const sharedProperties = CODE_BEHAVIOR_SCHEMA.properties as Record<string, { maxItems?: number; items?: { properties: Record<string, { enum?: string[] }> } }>
      assert.equal(sharedProperties.newNodes.maxItems, undefined)
      assert.equal(sharedProperties.acceptanceChanges.items!.properties.id.enum, undefined)
    }
    else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string }
      const expected = structuredClone(globalReviewSchema)
      const properties = expected.properties as Record<string, unknown>
      properties.inputDigest = { type: 'string', minLength: 1, enum: [request.inputDigest] }
      properties.analysisDigest = { type: 'string', minLength: 1, enum: [reviewed.analysisDigest] }
      assert.notEqual(request.schema, CODE_BEHAVIOR_REVIEW_SCHEMA)
      assert.deepEqual(request.schema, expected)
      assert.deepEqual(CODE_BEHAVIOR_REVIEW_SCHEMA, globalReviewSchema)
    }
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as {
        textEncoding: string
        bodyIndex: Record<string, { entryId: string; kind: string; sha256: string; byteLength: number; contentByteLength: number; required: boolean }>
        intentArtifactFiles: { bodyRef: string; path: string; mode: string; oid: string; digest: string }[]
        oldSource: [string, BodyReference][]
        newSource: [string, BodyReference][]
        authorBaseline: [string, BodyReference][]
        verifiedDelivery: [string, BodyReference][]
        composedFiles: [string, BodyReference][]
        controlledBeforeFiles: [string, BodyReference][]
      }
      assert.equal(frozen.textEncoding, 'sha256-body-entry-v3')
      const encodedViews = ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles'].flatMap(key => frozen[key as keyof typeof frozen] as [string, BodyReference][])
      const bodyRefs = encodedViews.map(([, value]) => value.bodyRef)
      const duplicateBytes = [...new Set(bodyRefs)].reduce((total, bodyRef) => total + Math.max(0, bodyRefs.filter(candidate => candidate === bodyRef).length - 1) * Buffer.byteLength(frozenBodyText(request, bodyRef)), 0)
      const expandedViews = ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles'].map(key => [key, (frozen[key as keyof typeof frozen] as [string, BodyReference][]).map(([path, ref]) => [path, frozenBodyText(request, ref.bodyRef)])])
      const wireTextBytes = Buffer.byteLength(JSON.stringify({ views: encodedViews, bodyIndex: frozen.bodyIndex, intentArtifactFiles: frozen.intentArtifactFiles }))
      const logicalTextBytes = Buffer.byteLength(JSON.stringify({ views: expandedViews, intentArtifactFiles: [] }))
      t.diagnostic(JSON.stringify({ nativePurpose: request.purpose, textEncoding: frozen.textEncoding, viewEntries: bodyRefs.length, distinctBodies: new Set(bodyRefs).size, uniqueBodyBytes: Object.values(frozen.bodyIndex).reduce((sum, locator) => sum + locator.contentByteLength, 0), duplicateBytes, wireTextBytes, logicalTextBytes }))
      assert.ok([...new Set(bodyRefs)].every(bodyRef => Object.hasOwn(frozen.bodyIndex, bodyRef)))
      assert.ok(wireTextBytes < logicalTextBytes, '文本wire体积应随唯一正文数量增长，而非随视图重复次数增长')
      for (const [bodyRef, locator] of Object.entries(frozen.bodyIndex)) {
        const text = frozenBodyText(request, bodyRef)
        assert.equal(contentHash(Buffer.from(text, 'utf8')), bodyRef)
        const entry = request.frozenEntries!.find(entry => entry.id === locator.entryId)!
        assert.equal(entry.kind, 'utf8')
        if (entry.kind !== 'utf8') assert.fail('正文运输entry必须是UTF8')
        assert.equal(locator.kind, 'utf8')
        assert.equal(locator.sha256, contentHash(Buffer.from(entry.text)))
        assert.equal(locator.byteLength, Buffer.byteLength(entry.text))
        assert.equal(locator.contentByteLength, Buffer.byteLength(text))
        if (locator.contentByteLength > 24) assert.equal(request.prompt.includes(text), false)
      }
      assert.equal(frozen.intentArtifactFiles.length, 0)
      const expanded = readFrozenBehaviorContext<Record<string, unknown> & { changedPaths: string[]; oldSource: [string, string][]; newSource: [string, string][]; authorBaseline: [string, string][]; verifiedDelivery: [string, string][]; composedFiles: [string, string][]; controlledBeforeFiles: [string, string][]; intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; text: string }[] }>(request)
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
      assert.deepEqual(expanded.rawlessSpecPaths, [])
      assert.deepEqual(Object.keys(expanded).sort(), ['guidanceContractVersion', 'requiredChangedPaths', 'unownedSourcePaths', 'unownedSourcePathCount', 'rawlessSpecPaths', 'snapshotTree', 'readablePaths', 'contractItems', 'origin', 'decision', 'repairDiagnostics', 'inputId', 'baselinePair', 'baselineSelection', 'compositionEvidence', 'authorByteProjections', 'intentArtifactFiles', 'nonTextFiles', 'composed', 'readSetDigest', 'policyDigest', 'plan', 'changedPaths', 'authorChanges', 'adoptedDeliveryPaths', 'authorBaseline', 'oldSource', 'verifiedDelivery', 'newSource', 'composedFiles', 'controlledBeforeFiles'].sort())
    }
    return runner('refactor')(request)
  })
})

test('没有既有AC时schema不返回空enum，并从派发schema拒绝AC提案', async t => {
  const f = await fixture(t, source => {
    const start = source.indexOf('### AC\n')
    const end = source.indexOf('\n### VERIFY', start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    return `${source.slice(0, start)}### AC\n${source.slice(end)}`
  })
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// empty acceptance target schema probe\n`)
  let analysisCalls = 0
  let reviewCalls = 0
  await assert.rejects(analyzeCodeBehavior(await f.input(), async request => {
    if (request.purpose === 'code_behavior_analyze') {
      analysisCalls += 1
      const frozen = readFrozenBehaviorContext<{ contractItems: { previous: { id: string; kind: string }[]; current: { id: string; kind: string }[] } }>(request)
      assert.deepEqual([...frozen.contractItems.previous, ...frozen.contractItems.current].filter(item => item.kind === 'AC'), [])
      const properties = request.schema.properties as Record<string, { maxItems?: number; items: { properties: Record<string, { enum?: string[] }> } }>
      assert.equal(properties.acceptanceChanges.maxItems, 0)
      assert.equal(properties.acceptanceChanges.items.properties.id.enum, undefined)
      const output = {
        changes: [], facts: [],
        acceptanceChanges: [{ id: 'AC-VERIFY-TODO-01-LOAD/SAVE', ruleIds: ['RULE-EXPORT-05'], source: 'user:raw', reason: 'raw-only输入中捏造未来验收目标' }],
        newNodes: [], resolutions: [],
      }
      return { sessionId: 'schema-analysis', threadId: 'schema-analysis-thread', turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    reviewCalls += 1
    assert.fail('schema拒绝的proposal不能进入独审')
  }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'behavior_analysis_invalid')
    assert.match(error.message, /acceptanceChanges: 项数超过冻结目标数量/)
    return true
  })
  assert.equal(analysisCalls, 1)
  assert.equal(reviewCalls, 0)
})

test('验收目标schema包含previous-only与current-only的既有AC并集', async t => {
  const f = await fixture(t)
  const contractPath = '.spec/export/export-contract/spec.md'
  const currentContract = readFileSync(join(f.root, contractPath), 'utf8')
    .replace(/^\| AC-EXPORT-08 \|.*\n/m, '')
    .replace(/\n\n### VERIFY/, '\n| AC-EXPORT-09 | RULE-EXPORT-06 | FAILED | 重试结果 | ID保持 | tests/export.test.mjs#AC-EXPORT-09 | VERIFY-EXPORT-01 | derived:REQ-EXPORT-01 | REQ-EXPORT-01 |\n\n### VERIFY')
  writeFileSync(join(f.root, contractPath), currentContract)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// previous/current acceptance target probe\n`)
  await assert.rejects(analyzeCodeBehavior(await f.input(), async request => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    const frozen = readFrozenBehaviorContext<{ contractItems: { previous: { id: string; kind: string }[]; current: { id: string; kind: string }[] } }>(request)
    const previousAcceptanceIds = frozen.contractItems.previous.filter(item => item.kind === 'AC').map(item => item.id)
    const currentAcceptanceIds = frozen.contractItems.current.filter(item => item.kind === 'AC').map(item => item.id)
    assert.ok(previousAcceptanceIds.includes('AC-EXPORT-08'))
    assert.ok(!currentAcceptanceIds.includes('AC-EXPORT-08'))
    assert.ok(currentAcceptanceIds.includes('AC-EXPORT-09'))
    assert.ok(!previousAcceptanceIds.includes('AC-EXPORT-09'))
    const properties = request.schema.properties as Record<string, { items: { properties: Record<string, { enum?: string[] }> } }>
    assert.deepEqual(properties.acceptanceChanges.items.properties.id.enum, [...new Set([...previousAcceptanceIds, ...currentAcceptanceIds])].sort())
    const output = {
      changes: [], facts: [],
      acceptanceChanges: [{ id: 'AC-VERIFY-TODO-01-LOAD/SAVE', ruleIds: ['RULE-EXPORT-05'], source: 'user:raw', reason: '测试schema只接受实际既有AC身份' }],
      newNodes: [], resolutions: [],
    }
    return { sessionId: 'schema-analysis', threadId: 'schema-analysis-thread', turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'behavior_analysis_invalid', error.message)
    assert.match(error.message, /acceptanceChanges\[0\]\.id: 未满足枚举/)
    return true
  })
})

test('history受控before正文引用可还原且authorBaseline保留原冻结全文', async t => {
  const f = await fixture(t), path = 'src/export.js', before = f.source, controlledBefore = `\uFEFF${f.source}\n// history before 🙂\r\n`
  writeFileSync(join(f.root, path), controlledBefore); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'history feature body')
  const snapshot = await captureInputSnapshot(f.root), requestBlob = prepareHistoryRequest(snapshot, { requestId: 'dedup-history', nodeId: 'export-contract', operationId: 'dedup-history-op', receiptId: 'dedup-history-receipt', featureCommit: snapshot.headCommit })
  const composed = composeControlledRequest(snapshot, composeInputSnapshots(snapshot, null).composed!, requestBlob).composed!
  const prepared = await f.input(), input: CodeBehaviorInput = { ...prepared, snapshot, baseline: null, composed }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { textEncoding: string; bodyIndex: Record<string, { required: boolean }>; controlledBeforeFiles: [string, BodyReference][] }
    assert.equal(wire.textEncoding, 'sha256-body-entry-v3')
    const context = readFrozenBehaviorContext<{ changedPaths: string[]; authorBaseline: [string, string][]; oldSource: [string, string][]; newSource: [string, string][]; verifiedDelivery: [string, string][]; controlledBeforeFiles: [string, string][] }>(request)
    assert.ok(context.changedPaths.includes(path))
    assert.equal(new Map(context.controlledBeforeFiles).get(path), controlledBefore)
    assert.equal(new Map(context.authorBaseline).get(path), controlledBefore)
    assert.equal(new Map(context.oldSource).get(path), controlledBefore)
    assert.equal(new Map(context.verifiedDelivery).get(path), controlledBefore)
    assert.equal(new Map(context.newSource).get(path), before)
    const beforeRef = wire.controlledBeforeFiles.find(([candidate]) => candidate === path)![1].bodyRef
    assert.equal(frozenBodyText(request, beforeRef), controlledBefore)
    assert.equal(wire.bodyIndex[beforeRef].required, true)
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
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { bodyIndex: Record<string, { byteLength: number }>; authorByteProjections: { snapshotId: string; path: string; before: { path: string; mode: string; oid: string; digest: string; bodyRef: string }; after: { path: string; mode: string; oid: string; digest: string; bodyRef: string } }[] }
    const frozen = readFrozenBehaviorContext<{ newSource: [string, string][]; composedFiles: [string, string][]; compositionEvidence: { paths: { path: string; source: { oid: string } | null }[] }; authorByteProjections: { snapshotId: string; path: string; before: { path: string; mode: string; oid: string; digest: string; text: string }; after: { path: string; mode: string; oid: string; digest: string; text: string } }[] }>(request)
    assert.equal(new Map(frozen.newSource).get(path), rawText)
    assert.equal(new Map(frozen.composedFiles).get(path), cleanText)
    assert.equal(frozen.compositionEvidence.paths.find(item => item.path === path)!.source!.oid, projection.after.oid)
    assert.deepEqual(frozen.authorByteProjections, [{ snapshotId: snapshot.id, path, before: { ...projection.before, text: rawText }, after: { ...projection.after, text: cleanText } }])
    const projected = wire.authorByteProjections.find(item => item.snapshotId === snapshot.id && item.path === path)!
    for (const [wireEntry, expected] of [[projected.before, projection.before], [projected.after, projection.after]] as const) {
      assert.equal(wireEntry.bodyRef, contentHash(Buffer.from(expected.oid === projection.before.oid ? rawText : cleanText, 'utf8')))
      assert.equal(frozenBodyText(request, wireEntry.bodyRef), expected.oid === projection.before.oid ? rawText : cleanText)
      for (const key of ['path', 'mode', 'oid', 'digest'] as const) assert.equal(wireEntry[key], expected[key])
    }
    return runner('refactor', proposal => { proposal.changes = (proposal.changes as { affectedIds: string[]; ruleIds: string[] }[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] })) })(request)
  })
  assert.equal(analysis.reviewPassed, true)
  const excludedAnalysis = await analyzeCodeBehavior({ ...input, plan: { ...plan, readPaths: [specPath] } }, async request => {
    const frozen = readFrozenBehaviorContext<{ readablePaths: { path: string; snapshots: string[] }[]; newSource: [string, string][]; composedFiles: [string, string][]; authorByteProjections: unknown[] }>(request)
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
    const context = readFrozenBehaviorContext<NonTextContext & { requiredChangedPaths: string[]; unownedSourcePaths: string[] }>(request)
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

test('分区保留尚无owner的null意图资源，真实owner仍按读取路径投影', async t => {
  const f = await fixture(t), specPath = '.spec/export/export-contract/spec.md', absentPath = '.spec/export/future/spec.md'
  const foreignPath = '.spec/other/other-contract/spec.md'
  mkdirSync(join(f.root, '.spec/other/other-contract'), { recursive: true })
  writeFileSync(join(f.root, foreignPath), f.raw.replaceAll('EXPORT', 'OTHER').replaceAll('src/export.js', 'src/other.js').replaceAll('tests/export.test.mjs', 'tests/other.test.mjs'))
  git(f.root, 'add', foreignPath); git(f.root, 'commit', '-m', 'independent intent owner')
  const prepared = await f.input(), snapshot = prepared.snapshot, commonDir = snapshot.source.commonDir
  const paths = [specPath, absentPath, foreignPath, 'src/export.js', 'tests/export.test.mjs']
  const baselineSelection = freezeSelection(snapshot, [
    ...paths.map(path => ({ resource: { kind: 'path' as const, path }, bytePair: null })),
    ...['REQ-EXPORT-01', 'REQ-OTHER-01', 'REQ-FUTURE-01'].map(id => ({ resource: { kind: 'contract' as const, id }, intentPair: null })),
    { resource: { kind: 'flow', id: 'FLOW-FUTURE-01' }, intentPair: null },
  ])
  const composed = composeInputSnapshots(snapshot, baselineSelection, { executionPaths: [specPath, absentPath], contextPaths: ['src/export.js', 'tests/export.test.mjs'] }).composed!
  const originalEvidence = readEvidence(commonDir, composed.compositionEvidenceBlob!), originalSelection = JSON.stringify(baselineSelection)
  const originalIndex = readFileSync(join(f.root, '.git/index')), originalSource = readFileSync(join(f.root, 'src/export.js'))
  const evidence = readCompositionEvidence(snapshot, composed, baselineSelection)
  const uninitialized = evidence.intents.filter(item => ['REQ-FUTURE-01', 'FLOW-FUTURE-01'].includes(item.resource.id))
  assert.equal(uninitialized.length, 2)
  assert.ok(uninitialized.every(item => item.pairId === null && item.before === null && item.delivery === null && item.source === null))
  const readPaths = [specPath, absentPath, 'src/export.js', 'tests/export.test.mjs']
  const input: CodeBehaviorInput = { ...prepared, snapshot, baseline: null, baselineSelection, composed, partition: { id: 'local-owner', changedPaths: ['src/export.js'], factSourcePaths: ['src/export.js'] }, plan: { ...prepared.plan, readPaths } }
  const calls: string[] = []
  const analysis = await analyzeCodeBehavior(input, async request => {
    calls.push(request.purpose)
    const frozen = readFrozenBehaviorContext<{ compositionEvidence: typeof evidence; contractItems: { previous: { id: string }[]; current: { id: string }[] }; readablePaths: { path: string }[]; plan: CodeBehaviorInput['plan'] }>(request)
    assert.deepEqual(frozen.compositionEvidence.intents, evidence.intents.filter(item => item.resource.id !== 'REQ-OTHER-01'))
    assert.deepEqual(frozen.compositionEvidence.paths.find(item => item.path === absentPath), evidence.paths.find(item => item.path === absentPath))
    assert.ok([...frozen.contractItems.previous, ...frozen.contractItems.current].every(item => !item.id.includes('FUTURE')), '未初始化资源不冒充已存在契约')
    assert.ok(!frozen.readablePaths.some(item => item.path === absentPath || item.path === foreignPath), 'null资源不产生正文读取证明或区外读取权')
    assert.deepEqual(frozen.plan.writePaths, input.plan.writePaths)
    return runner('refactor')(request)
  })
  assert.equal(analysis.reviewPassed, true)
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])
  assert.equal(JSON.stringify(baselineSelection), originalSelection)
  assert.deepEqual(readEvidence(commonDir, composed.compositionEvidenceBlob!), originalEvidence)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), originalIndex)
  assert.deepEqual(readFileSync(join(f.root, 'src/export.js')), originalSource)
  assert.equal(existsSync(join(f.root, absentPath)), false)
  assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
})

test('真实paired空base仍删除HEAD差量基准，已commit新增测试不能被当作无pair跳过', async t => {
  const f = await fixture(t), path = 'tests/paired-addition.test.js'
  writeFileSync(join(f.root, path), 'export const pairedAddition = true;\n'); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'new test after verified pair')
  const prepared = await f.input(), baselineSelection = freezeSelection(prepared.snapshot, [{ resource: { kind: 'path', path }, bytePair: prepared.baseline }])
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: composeInputSnapshots(prepared.snapshot, baselineSelection).composed! }
  const analysis = await analyzeCodeBehavior(input, runner('refactor', (_proposal, frozen) => { assert.deepEqual(frozen.changedPaths, [path]) }))
  assert.equal(analysis.reviewPassed, true)
})

test('all-null裁决只从原完整独审composed图恢复所选AC范围，当前新连边与历史authority不扩权', async t => {
  const path = '.spec/export/export-contract/spec.md'
  const f = await fixture(t, source => source.replace('| AC-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-02,RULE-EXPORT-05 |', '| AC-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-05 |').replace('| AC-EXPORT-03 | RULE-EXPORT-01 |', '| AC-EXPORT-03 | RULE-EXPORT-01,RULE-EXPORT-02 |'))
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// external filter boundary difference\n`)
  const prepared = await f.input(), snapshot = prepared.snapshot, commonDir = snapshot.source.commonDir
  const baselineSelection = freezeSelection(snapshot, readTree(commonDir, snapshot.immutableTree).map(entry => ({ resource: { kind: 'path', path: entry.path }, bytePair: null })))
  const baseComposed = composeInputSnapshots(snapshot, baselineSelection).composed!
  const reviewedSpec = f.raw.replace('| AC-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-05 |', '| AC-EXPORT-02 | RULE-EXPORT-01,RULE-EXPORT-02,RULE-EXPORT-05 |').replace('| AC-EXPORT-03 | RULE-EXPORT-01,RULE-EXPORT-02 |', '| AC-EXPORT-03 | RULE-EXPORT-01 |')
  const edit = prepareControlledRequest(snapshot, { path, source: f.raw, next: reviewedSpec, changed: true, startLine: 1, endLine: 1 }, { kind: 'user_edit', requestId: 'original-reviewed-contract', nodeId: 'export-contract', intent: '原独审读取该完整受控契约' })
  assert.ok(edit.changed)
  const previousComposed = composeControlledRequest(snapshot, baseComposed, edit.requestBlob).composed!
  assert.notEqual(previousComposed.tree, snapshot.immutableTree)
  const selected = (proposal: Record<string, unknown>): void => { proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['RULE-EXPORT-02', 'AC-EXPORT-02'], ruleIds: ['RULE-EXPORT-02'] })) }
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection, composed: previousComposed }
  const previous = await analyzeCodeBehavior(input, runner('conflict', selected)), ref = writeEvidence(commonDir, previous)
  const request = { requestId: 'current-null-baseline-decision', operationId: 'original-reviewed-operation', inputId: snapshot.id, analysisRef: ref, findingIds: [previous.findings.find(finding => finding.paths.includes('src/export.js'))!.id], decision: { choice: 'new_rule' as const, rule: 'filter最多128字符，其余政策保持。' } }
  const requestBlob = prepareControlledDecision(snapshot, request), source = `decision:${controlledDecisionIdentity(request)}`, fact = { source, text: request.decision.rule }
  const current: CodeBehaviorInput = { ...input, composed: { ...baseComposed, requestBlob }, origin: 'decision', decision: { request, previous: { ref, analysis: previous }, previousComposed, previousReadPaths: input.plan.readPaths }, plan: { ...input.plan, facts: [...input.plan.facts, fact] } }
  const proposalFor = (id: string, proposalSource = source): ElaborationRunner => runner('allowed_change', proposal => {
    selected(proposal); proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: ['RULE-EXPORT-02', id] }))
    proposal.facts = [{ source: proposalSource, text: request.decision.rule }]
    proposal.acceptanceChanges = [{ id, ruleIds: ['RULE-EXPORT-02'], source: proposalSource, reason: '仅按精确所选filter政策更新验收' }]
  })
  const analysis = await analyzeCodeBehavior(current, async dispatch => {
    const frozen = readFrozenBehaviorContext<{ verifiedDelivery: unknown[]; contractItems: { previous: unknown[]; current: { id: string; covers?: string[] }[] } }>(dispatch)
    assert.deepEqual(frozen.verifiedDelivery, []); assert.deepEqual(frozen.contractItems.previous, [])
    assert.ok(frozen.contractItems.current.find(item => item.id === 'AC-EXPORT-03')!.covers!.includes('RULE-EXPORT-02'))
    return proposalFor('AC-EXPORT-02')(dispatch)
  })
  assert.equal(analysis.reviewPassed, true); assert.deepEqual(analysis.authorizedChanges.map(change => change.id), ['AC-EXPORT-02'])
  const projected = await analyzeCodeBehavior({ ...current, partition: { id: 'decision-local', changedPaths: analysis.changes.flatMap(change => change.paths), factSourcePaths: ['src/export.js'] } }, async dispatch => {
    const frozen = readFrozenBehaviorContext<{ decision: { previousComposed?: unknown; previousReadPaths?: string[] }; verifiedDelivery: unknown[] }>(dispatch)
    assert.deepEqual(frozen.decision.previousComposed, previousComposed)
    assert.deepEqual(frozen.decision.previousReadPaths, current.decision!.previousReadPaths)
    assert.deepEqual(frozen.verifiedDelivery, [])
    return proposalFor('AC-EXPORT-02')(dispatch)
  })
  assert.equal(projected.reviewPassed, true)

  const expandedSelection = freezeSelection(snapshot, [...baselineSelection.bindings, { resource: { kind: 'path', path: 'tests/future.test.mjs' }, bytePair: null }])
  const expandedComposed = composeControlledRequest(snapshot, composeInputSnapshots(snapshot, expandedSelection).composed!, edit.requestBlob).composed!
  assert.equal(expandedComposed.contentDigest, previousComposed.contentDigest); assert.notEqual(expandedComposed.baselineSelectionDigest, previousComposed.baselineSelectionDigest)
  assert.equal((await analyzeCodeBehavior({ ...current, decision: { ...current.decision!, previousComposed: expandedComposed } }, proposalFor('AC-EXPORT-02'))).reviewPassed, true)
  await assert.rejects(analyzeCodeBehavior(current, proposalFor('AC-EXPORT-03')), /所选裁决范围/)
  await assert.rejects(analyzeCodeBehavior({ ...current, decision: { ...current.decision!, previousComposed: undefined } }, proposalFor('AC-EXPORT-02')), /所选裁决范围/)
  await assert.rejects(analyzeCodeBehavior({ ...current, decision: { ...current.decision!, previousReadPaths: undefined } }, proposalFor('AC-EXPORT-02')), /所选裁决范围/)
  await assert.rejects(analyzeCodeBehavior({ ...current, decision: { ...current.decision!, previousReadPaths: ['src', 'tests'] } }, proposalFor('AC-EXPORT-02')), /所选裁决范围/)
  for (const previousComposed of [{ ...current.decision!.previousComposed!, sourceInputId: 'foreign-input' }, { ...current.decision!.previousComposed!, contentDigest: contentHash('foreign-analysis') }]) {
    await assert.rejects(analyzeCodeBehavior({ ...current, decision: { ...current.decision!, previousComposed } }, proposalFor('AC-EXPORT-02')), /原契约图未绑定/)
  }
  await assert.rejects(analyzeCodeBehavior({ ...current, decision: undefined, plan: { ...current.plan, decisionAuthorities: analysis.decisionAuthorities } }, proposalFor('AC-EXPORT-02')), /所选裁决范围/)
  await assert.rejects(analyzeCodeBehavior({ ...current, baseline: prepared.baseline, baselineSelection: undefined, composed: { ...prepared.composed, requestBlob } }, proposalFor('AC-EXPORT-02')), /所选裁决范围/)
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
    const context = readFrozenBehaviorContext<NonTextContext>(request)
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
    const wire = JSON.parse(request.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]) as { textEncoding: string; bodyIndex: Record<string, { required: boolean }>; intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; bodyRef: string }[] }
    assert.equal(wire.textEncoding, 'sha256-body-entry-v3')
    const context = readFrozenBehaviorContext<NonTextContext & { intentArtifactFiles: { path: string; mode: string; oid: string; digest: string; text: string }[] }>(request)
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
      assert.equal(frozenBodyText(request, file.bodyRef), expanded.text)
      assert.equal(wire.bodyIndex[file.bodyRef].required, true)
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
      const frozen = readFrozenBehaviorContext<typeof expected>(request)
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

test('raw-only v2同tree冻结角色共享单次完整读取且保留verifySnapshot校验', async t => {
  const f = await fixture(t), prepared = await f.input(), composed = composeInputSnapshots(prepared.snapshot, null).composed!
  const input: CodeBehaviorInput = {
    ...prepared, baseline: null, baselineSelection: undefined, composed, origin: 'initial',
    plan: { ...prepared.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', commitTrigger: { before: null, paths: [] }, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 1000000, maxParallel: 1 }, facts: [] },
  }
  const headTree = git(f.root, 'rev-parse', 'HEAD^{tree}')
  assert.equal(input.snapshot.immutableTree, headTree)
  assert.equal(input.snapshot.immutableTree, input.composed.tree)
  assert.equal(input.baseline, null)
  assert.equal(input.baselineSelection, undefined)
  const expected = readTree(input.snapshot.source.commonDir, input.snapshot.immutableTree)
    .filter(entry => input.plan.readPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)) && !isHostPrivatePath(entry.path) && entry.mode !== '120000')
    .flatMap(entry => {
      const bytes = readObject(input.snapshot.source.commonDir, entry.oid)
      return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : []
    })
  const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'), original = cp.execFileSync, calls: string[][] = [], purposes: string[] = []
  const stop = new Error('stopped at first Native dispatch')
  cp.execFileSync = ((...args: Parameters<typeof execFileSync>) => { if (args[0] === 'git') calls.push(args[1] as string[]); return Reflect.apply(original, cp, args) }) as typeof execFileSync
  syncBuiltinESMExports()
  try {
    await assert.rejects(analyzeCodeBehavior(input, async request => {
      purposes.push(request.purpose)
      assert.equal(request.purpose, 'code_behavior_analyze')
      const frozen = readFrozenBehaviorContext<{ oldSource: [string, string][]; newSource: [string, string][]; authorBaseline: [string, string][]; verifiedDelivery: [string, string][]; composedFiles: [string, string][]; controlledBeforeFiles: [string, string][] }>(request)
      assert.deepEqual(frozen.oldSource, expected)
      assert.deepEqual(frozen.newSource, expected)
      assert.deepEqual(frozen.authorBaseline, expected)
      assert.deepEqual(frozen.composedFiles, expected)
      assert.deepEqual(frozen.verifiedDelivery, [])
      assert.deepEqual(frozen.controlledBeforeFiles, [])
      throw stop
    }), error => error === stop)
  } finally { cp.execFileSync = original; syncBuiltinESMExports() }
  assert.deepEqual(purposes, ['code_behavior_analyze'], '在首个Native请求处停止，不构造伪分析结果')
  const treeReads = calls.filter(args => args.includes('ls-tree'))
  const objectBatches = calls.filter(args => args.includes('cat-file') && args.includes('--batch')).length
  t.diagnostic(JSON.stringify({ treeReads: treeReads.length, objectBatches }))
  assert.equal(treeReads.length, 3, '原有两次verifySnapshot各自完整校验，六个角色的相同树只再完整读取一次')
  assert.equal(objectBatches, 3, '相同tree的完整blob校验与读取仍只通过原batch机制执行')
})

test('行为分析按完整tree OID隔离角色并保留旧、新、交付及组合字节', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// distinct frozen source tree\n`)
  const input = await f.input(), baseline = input.baseline!
  const trees = [baseline.sourceInput.immutableTree, input.snapshot.immutableTree, baseline.verifiedDelivery.immutableTree, input.composed.tree]
  assert.notEqual(trees[0], trees[1])
  const expected = (tree: string): [string, string][] => readTree(input.snapshot.source.commonDir, tree)
    .filter(entry => input.plan.readPaths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)) && !isHostPrivatePath(entry.path) && entry.mode !== '120000')
    .flatMap(entry => {
      const bytes = readObject(input.snapshot.source.commonDir, entry.oid)
      return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : []
    })
  const expectedViews = { oldSource: expected(trees[0]), newSource: expected(trees[1]), verifiedDelivery: expected(trees[2]), composedFiles: expected(trees[3]) }
  const stop = new Error('stopped at first Native dispatch')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    const frozen = readFrozenBehaviorContext<typeof expectedViews>(request)
    for (const key of Object.keys(expectedViews) as (keyof typeof expectedViews)[]) assert.deepEqual(frozen[key], expectedViews[key])
    throw stop
  }), error => error === stop)
})

test('分析调用结束后缺失的同OID对象仍在下一次校验前失败且不派发Native', async t => {
  const f = await fixture(t), prepared = await f.input(), composed = composeInputSnapshots(prepared.snapshot, null).composed!
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection: undefined, composed, origin: 'initial' }
  let firstDispatches = 0
  const stop = new Error('stopped at first Native dispatch')
  await assert.rejects(analyzeCodeBehavior(input, async () => { firstDispatches++; throw stop }), error => error === stop)
  assert.equal(firstDispatches, 1)
  const oid = readTree(input.snapshot.source.commonDir, input.snapshot.immutableTree).find(entry => entry.path === 'src/export.js')!.oid
  const objectPath = join(input.snapshot.source.commonDir, 'objects', oid.slice(0, 2), oid.slice(2))
  assert.ok(existsSync(objectPath), 'fixture blob应为可移除的loose object')
  rmSync(objectPath)
  let nextDispatches = 0
  await assert.rejects(analyzeCodeBehavior(input, async () => { nextDispatches++; throw new Error('must not dispatch') }))
  assert.equal(nextDispatches, 0, '下一次调用必须重新执行原始snapshot/OID校验')
})

test('selection替换只改变对应冻结角色，不污染共享同tree的其他角色', async t => {
  const f = await fixture(t), path = 'src/export.js'
  writeFileSync(join(f.root, path), `${f.source}\n// committed source version\n`)
  git(f.root, 'add', path); git(f.root, 'commit', '-m', 'advance source after baseline')
  const prepared = await f.input(), selection = freezeSelection(prepared.snapshot, [{ resource: { kind: 'path', path }, bytePair: prepared.baseline }])
  const composed = composeInputSnapshots(prepared.snapshot, selection).composed!
  const input: CodeBehaviorInput = { ...prepared, baseline: null, baselineSelection: selection, composed, origin: 'initial' }
  assert.equal(input.snapshot.immutableTree, git(f.root, 'rev-parse', 'HEAD^{tree}'))
  assert.equal(input.snapshot.immutableTree, input.composed.tree)
  const stop = new Error('stopped at first Native dispatch')
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    assert.equal(request.purpose, 'code_behavior_analyze')
    const frozen = readFrozenBehaviorContext<{ oldSource: [string, string][]; newSource: [string, string][]; verifiedDelivery: [string, string][]; composedFiles: [string, string][] }>(request)
    assert.equal(new Map(frozen.oldSource).get(path), f.source, 'selection的base只替换oldSource角色')
    assert.equal(new Map(frozen.newSource).get(path), `${f.source}\n// committed source version\n`)
    assert.equal(new Map(frozen.composedFiles).get(path), `${f.source}\n// committed source version\n`)
    assert.equal(new Map(frozen.verifiedDelivery).get(path), f.source, 'verifiedDelivery仍使用其真实pair字节')
    throw stop
  }), error => error === stop)
})

test('分析及独审收到真实契约项正文，raw-only初始化不借未交付资源名虚构既有义务', async t => {
  const f = await fixture(t)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// refactor context\n`)
  const input = await f.input(), expected = await readFrozenContracts(f.root, new Map([
    ['.spec/export/export-contract/spec.md', f.raw],
  ])), calls: string[] = []
  const check: ElaborationRunner = async request => {
    const frozen = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request)
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
    const frozen = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request)
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
    const context = readFrozenBehaviorContext<{ contractItems: { previous: unknown[]; current: unknown[] } }>(request)
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

test('无raw的既有叶只保留原stub并将行为事实交给P1初始化', async t => {
  const f = await fixture(t), leafPath = '.spec/export/export-contract/legacy/spec.md', secondLeafPath = '.spec/export/export-contract/legacy-next/spec.md'
  const expandedOnlyLeafPath = '.spec/export/export-contract/legacy-expanded/spec.md', emptyRawLeafPath = '.spec/export/export-contract/legacy-empty-raw/spec.md'
  const legacyBody = '负责保留该叶的既有正文，后续细化时不复制上游raw。\n'
  const stubFrontmatter = '---\ntitle: Legacy leaf\nstatus: pending\ncode:\n  - src/export.js\n---\n'
  const stub = `${stubFrontmatter}${legacyBody}`
  const expandedOnlyStub = `${stubFrontmatter}## expanded spec\n\n${legacyBody}`
  const emptyRawStub = `${stubFrontmatter}## raw source\n\n## expanded spec\n\n${legacyBody}`
  const leafBodies = new Map([[leafPath, stub], [secondLeafPath, stub], [expandedOnlyLeafPath, expandedOnlyStub], [emptyRawLeafPath, emptyRawStub]])
  const leafPaths = [...leafBodies.keys()]
  const leafTargets = [
    { nodeId: 'legacy', path: leafPath },
    { nodeId: 'legacy-next', path: secondLeafPath },
    { nodeId: 'legacy-expanded', path: expandedOnlyLeafPath },
    { nodeId: 'legacy-empty-raw', path: emptyRawLeafPath },
  ]
  for (const root of [f.root, f.delivery]) {
    for (const [path, body] of leafBodies) {
      mkdirSync(join(root, path.split('/').slice(0, -1).join('/')), { recursive: true })
      writeFileSync(join(root, path), body)
    }
    git(root, 'add', ...leafPaths); git(root, 'commit', '-m', 'seed rawless legacy leaves')
  }
  const before = await captureInputSnapshot(f.root), delivered = await captureInputSnapshot(f.delivery)
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// code behavior trigger\n`)
  git(f.root, 'add', 'src/export.js'); git(f.root, 'commit', '-m', 'commit code behavior trigger')
  const snapshot = await captureInputSnapshot(f.root), seed = await f.input()
  const baseline: BaselinePair = {
    id: 'rawless-leaf-baseline', source: before.source, repositoryId: before.source.repositoryId,
    sourceInput: before, verifiedDelivery: delivered,
    coveredScope: { paths: ['.spec', 'src', 'tests'], contractIds: [], flowIds: [] },
    receiptId: 'rawless-leaf-receipt', settledAtMs: 1,
  }
  const plan: CodeBehaviorInput['plan'] = {
    ...seed.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', sourcePaths: ['src'],
    targets: [...seed.plan.targets, ...leafTargets],
    commitTrigger: { before, paths: [...leafPaths, 'src/export.js'] },
    partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 1000000, maxParallel: 1 },
  }
  const input: CodeBehaviorInput = {
    ...seed, snapshot, baseline,
    composed: composeInputSnapshots(snapshot, baseline, { retainConflicts: true }).composed!,
    plan, origin: 'code', partition: { id: 'legacy-leaf', changedPaths: [...leafPaths, 'src/export.js'], factSourcePaths: ['src/export.js'] },
  }
  const parentRaw = parseParts(f.raw)!.rawSource!
  const copiedParentRaw = `${stubFrontmatter}## raw source\n\n${parentRaw}\n\n## expanded spec\n\n${legacyBody}`
  const unchangedResolution = { path: leafPath, content: stub, mode: '100644' }
  const copiedResolution = { path: leafPath, content: copiedParentRaw, mode: '100644' }
  const deletedResolution = { path: leafPath, content: null, mode: null }
  const completeProposal = (proposal: Record<string, unknown>, changedPaths: string[]): void => {
    proposal.changes = changedPaths.map(path => ({
      kind: 'refactor', paths: [path], affectedIds: [], ruleIds: [],
      originalIntent: '保留根raw和既有叶stub的原有角色', previousBehavior: '既有rawless叶仅包含占位正文',
      sourceBehavior: 'src/export.js的现存行为已通过真实fact完整记录', deliveryBehavior: '保留现有叶字节且没有verified Spec raw',
      evidence: `完整冻结文件${path}及其实际来源`, counterexample: '复制上游raw会伪造叶节点的用户原意',
    }))
    proposal.facts = [{ source: 'code:src/export.js#ExportService', text: '现有ExportService行为及其完整测试事实作为P1细化依据。' }]
    proposal.acceptanceChanges = []; proposal.newNodes = []; proposal.resolutions = []
  }
  const accepted = await analyzeCodeBehavior(input, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ rawlessSpecPaths: string[]; changedPaths: string[] }>(request)
      assert.deepEqual(frozen.rawlessSpecPaths, leafPaths.sort())
      return runner('refactor', (proposal, context) => completeProposal(proposal, context.changedPaths))(request)
    }
    return runner('refactor')(request)
  })
  assert.equal(accepted.reviewPassed, true)
  assert.equal(accepted.resolutions.length, 0)
  assert.deepEqual(accepted.newNodes, [])
  assert.equal(accepted.facts[0].source, 'code:src/export.js#ExportService')
  for (const [path, body] of leafBodies) {
    assert.deepEqual(readFileSync(join(f.root, path)), Buffer.from(body))
    assert.deepEqual(readFileSync(join(f.delivery, path)), Buffer.from(body))
  }
  assert.equal(parseParts(stub)?.rawSource ?? null, null)
  assert.equal(parseParts(expandedOnlyStub)?.rawSource, '')
  assert.equal(parseParts(emptyRawStub)?.rawSource, '')

  const initialPlan: CodeBehaviorInput['plan'] = {
    ...plan, intentNodeId: 'legacy', targets: leafTargets,
    commitTrigger: { before: null, paths: [...leafPaths, 'src/export.js'] },
  }
  const initialInput: CodeBehaviorInput = {
    ...input, baseline: null, origin: 'initial', composed: composeInputSnapshots(snapshot, null).composed!, plan: initialPlan,
    partition: { id: 'first-rawless-leaves', changedPaths: [...leafPaths, 'src/export.js'], factSourcePaths: ['src/export.js'] },
  }
  const initial = await analyzeCodeBehavior(initialInput, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ rawlessSpecPaths: string[]; changedPaths: string[] }>(request)
      assert.deepEqual(frozen.rawlessSpecPaths, leafPaths.sort())
      const currentIntentPath = initialInput.plan.targets.find(target => target.nodeId === initialInput.plan.intentNodeId)?.path
      assert.ok(currentIntentPath && frozen.rawlessSpecPaths.includes(currentIntentPath))
      return runner('refactor', (proposal, context) => completeProposal(proposal, context.changedPaths))(request)
    }
    return runner('refactor')(request)
  })
  assert.equal(initial.reviewPassed, true)
  assert.equal(initial.resolutions.length, 0)
  assert.deepEqual(initial.newNodes, [])

  for (const resolution of [unchangedResolution, copiedResolution, deletedResolution]) await assert.rejects(analyzeCodeBehavior(input, async request => {
    if (request.purpose === 'code_behavior_analyze') return runner('refactor', (proposal, context) => {
      completeProposal(proposal, context.changedPaths)
      proposal.resolutions = [resolution]
    })(request)
    return runner('refactor')(request)
  }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /rawlessSpecPaths/)
    return true
  })
})

async function initialDiscovery(t: test.TestContext, raw: string) {
  const parentPath = '.spec/export/export-contract/spec.md', sourcePath = 'src/summary.js', testPath = 'tests/summary.test.mjs'
  const f = await fixture(t, () => `---\ntitle: 统计原意\nstatus: pending\n---\n\n## raw source\n\n${raw}\n`)
  writeFileSync(join(f.root, sourcePath), 'export const summarize = rows => rows.length;\n')
  writeFileSync(join(f.root, testPath), 'import test from "node:test"; import assert from "node:assert/strict"; import {summarize} from "../src/summary.js"; test("summary counts rows", () => assert.equal(summarize([{owner:"A"},{owner:"B"}]), 2));\n')
  git(f.root, 'add', sourcePath, testPath); git(f.root, 'commit', '-m', 'seed discovery behavior and complete test')
  const before = await f.input()
  const input: CodeBehaviorInput = { ...before, baseline: null, origin: 'initial', composed: composeInputSnapshots(before.snapshot, null).composed!,
    partition: { id: 'summary-discovery', changedPaths: [sourcePath, testPath], factSourcePaths: [sourcePath], authorizedParentSpecPaths: [parentPath] },
    plan: { ...before.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, intentNodeId: 'export-contract', targets: [{ nodeId: 'export-contract', path: parentPath }], readPaths: [parentPath, sourcePath, testPath], writePaths: ['.spec/export/export-contract'], sourcePaths: ['src'], facts: [] },
  }
  const model = (kind: CodeBehaviorKind): ElaborationRunner => runner(kind, proposal => {
    proposal.changes = (proposal.changes as { paths: string[] }[]).map(change => ({ ...change, kind: change.paths.includes(sourcePath) ? kind : 'refactor', affectedIds: [], ruleIds: [], originalIntent: raw, previousBehavior: '当前已有模块但尚未生成规格叶', sourceBehavior: 'summarize返回传入列表长度，不改变列表', deliveryBehavior: '无已验证交付', evidence: `${sourcePath}#summarize与${testPath}完整断言；当前尚无规格叶`, counterexample: kind === 'refactor' ? '列表含两项时返回2' : kind === 'conflict' ? '当前账号A收到A/B两项时仍统计2，违反只统计本账号的原意' : '跨账号计数的可见性政策未确定，决定A能否观测B的任务数量' }))
    proposal.newNodes = [{ codePath: sourcePath, parentNodeId: 'export-contract', basis: '已有统计行为由原始需求下的治理叶承接' }]
    proposal.facts = [{ source: `code:${sourcePath}#summarize`, text: '返回传入数组长度，不改变数组。' }]
  })
  return { f, input, model }
}

for (const previousVersion of [undefined, 'code-behavior-guidance-v2', 'code-behavior-guidance-v3']) test(`指导合同版本进入唯一摘要，旧accept ${previousVersion} 不得被缓存承接`, async t => {
  const { f, input, model } = await initialDiscovery(t, '统计传入列表的条目数量，不修改列表；从现有模块生成治理叶及规格。')
  let context = ''
  const first = await analyzeCodeBehavior({ ...input, requestKey: 'old-guidance' }, async request => {
    if (request.purpose === 'code_behavior_analyze') context = request.prompt.split('冻结三方输入:\n')[1]
    return model('coverage_gap')(request)
  })
  assert.equal(first.reviewPassed, true); assert.ok(first.findings.length)
  const legacyContext = JSON.parse(context) as Record<string, unknown>
  if (previousVersion === undefined) delete legacyContext.guidanceContractVersion
  else legacyContext.guidanceContractVersion = previousVersion
  const legacy = { ...first, inputDigest: contentHash(JSON.stringify(legacyContext)) }
  const ref = writeEvidence(input.snapshot.source.commonDir, legacy), before = readEvidence(input.snapshot.source.commonDir, ref)
  const calls: string[] = []
  const fresh = await analyzeCodeBehavior({ ...input, requestKey: 'new-guidance' }, async request => {
    calls.push(request.purpose)
    if (process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR, `guidance-current-${request.purpose}.prompt.txt`), request.prompt)
    const frozen = readFrozenBehaviorContext<{ guidanceContractVersion: string }>(request)
    assert.equal(frozen.guidanceContractVersion, 'code-behavior-guidance-v4')
    const instructions = request.prompt.slice(0, request.prompt.indexOf('冻结三方输入:\n'))
    assert.match(instructions, /尚未生成.*治理叶.*待生成工作/)
    assert.match(instructions, /coverage_gap.*重大业务事实.*可观察后果/)
    return model('refactor')(request)
  }, digest => digest === legacy.inputDigest ? legacy : null)
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'], '新指导必须实际重新生成并独审，不能复用旧accept false gap')
  assert.notEqual(fresh.inputDigest, legacy.inputDigest); assert.equal(fresh.reviewPassed, true); assert.deepEqual(fresh.findings, [])
  assert.equal(fresh.newNodes.length, 1); assert.equal(fresh.facts.length, 1)
  assert.equal(fresh.inputId, legacy.inputId); assert.equal(fresh.policyDigest, legacy.policyDigest); assert.equal(fresh.readSetDigest, legacy.readSetDigest)
  assert.deepEqual(readEvidence(input.snapshot.source.commonDir, ref), before, '旧finding/ref字节不能被改写或清除')
  if (process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR) {
    writeFileSync(join(process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR, 'guidance-versionless-context.json'), JSON.stringify(legacyContext))
    writeFileSync(join(process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR, 'guidance-legacy-checkpoint-fixture.json'), before)
    writeFileSync(join(process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR, 'guidance-current-analysis.json'), JSON.stringify(fresh))
  }
  const reused = await analyzeCodeBehavior(input, async () => assert.fail('同新指导摘要仍可沿既有accepted接缝承接'), digest => digest === fresh.inputDigest ? fresh : null)
  assert.deepEqual(reused, fresh); assert.equal((await captureInputSnapshot(f.root)).id, input.snapshot.id)
})

for (const kind of ['coverage_gap', 'conflict'] as const) test(`初始化指导保留真正${kind}，不能把业务发现清空为生成任务`, async t => {
  const raw = kind === 'coverage_gap' ? '给多账号统计任务数量，但跨账号可见性政策尚未确定。' : '统计时必须只返回当前账号自己的任务数量，不得暴露其他账号的任务数量。'
  const { input, model } = await initialDiscovery(t, raw)
  const analysis = await analyzeCodeBehavior(input, model(kind))
  assert.equal(analysis.reviewPassed, true)
  assert.ok(analysis.findings.some(finding => finding.kind === kind && !finding.affectedIds.length && finding.evidence && finding.counterexample.includes('账号')))
  assert.deepEqual(deriveBehaviorAuthorization(analysis, writeEvidence(input.snapshot.source.commonDir, analysis)), [])
})

for (const mode of ['empty', 'raw-suffix', 'raw-wording', 'raw-escape'] as const) test(`首次同字节raw父分区 ${mode} 不因覆盖任务重抄Spec且保原字节门禁`, async t => {
  const f = await fixture(t), path = '.spec/export/spec.md'
  const raw = '保持父命令接口和当前导出能力，输入路径如 C:\\data\\export，由既有子叶承接具体业务。'
  const source = `---\ntitle: 导出上层原意\nstatus: pending\n---\n\n## raw source\n\n${raw}\n`
  writeFileSync(join(f.root, path), source); git(f.root, 'add', path); git(f.root, 'commit', '-m', 'seed unchanged raw parent')
  const prepared = await f.input(), input: CodeBehaviorInput = { ...prepared, baseline: null, origin: 'initial', composed: composeInputSnapshots(prepared.snapshot, null).composed!,
    partition: { id: 'initial-raw-parent', changedPaths: [path], factSourcePaths: [] },
    plan: { ...prepared.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 1 }, intentNodeId: 'export', targets: [{ nodeId: 'export', path }], readPaths: [path, 'package.json'], writePaths: [path], sourcePaths: [], facts: [] },
  }
  const calls: { purpose: string; prompt: string }[] = []
  const run: ElaborationRunner = async request => {
    calls.push({ purpose: request.purpose, prompt: request.prompt })
    if (process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR) writeFileSync(join(process.env.SPEX_RAW_RESOLUTION_EVIDENCE_DIR, `${mode}-${request.purpose}.prompt.txt`), request.prompt)
    const frozen = readFrozenBehaviorContext<{ baselinePair: unknown; authorChanges: unknown[]; compositionEvidence?: { conflicts: unknown[] }; authorBaseline: [string, string][]; oldSource: [string, string][]; newSource: [string, string][]; composedFiles: [string, string][]; verifiedDelivery: [string, string][] }>(request)
    assert.equal(frozen.baselinePair, null); assert.deepEqual(frozen.authorChanges, []); assert.equal(frozen.compositionEvidence?.conflicts.length ?? 0, 0)
    for (const view of [frozen.authorBaseline, frozen.oldSource, frozen.newSource, frozen.composedFiles]) assert.equal(new Map(view).get(path), source)
    assert.deepEqual(frozen.verifiedDelivery, [])
    return runner('refactor', proposal => {
      proposal.changes = (proposal.changes as object[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] }))
      if (mode !== 'empty') proposal.resolutions = [{ path, mode: '100644', content: mode === 'raw-suffix' ? `${source}\n规格总览：现在展开全部业务。\n` : mode === 'raw-wording' ? source.replace('父命令接口', '父命令父接口') : source.replace('C:\\data', 'C:\\\\data') }]
    })(request)
  }
  if (mode === 'empty') {
    const analysis = await analyzeCodeBehavior(input, run)
    assert.equal(analysis.reviewPassed, true); assert.deepEqual(analysis.resolutions, []); assert.deepEqual(analysis.rawIntegrations, [])
    assert.deepEqual(calls.map(call => call.purpose), ['code_behavior_analyze', 'code_behavior_review'])
    for (const call of calls) {
      const instructions = call.prompt.slice(0, call.prompt.indexOf('冻结三方输入:\n'))
      assert.ok(!instructions.includes('双方相容时resolutions给完整整合正文'), '同字节首次纳管仍收到泛化的全文重抄任务')
      assert.match(instructions, /首次纳管.*覆盖任务/)
      assert.match(instructions, /resolutions:\[\]/)
      assert.match(instructions, /P1.*renderer.*raw/)
    }
    assert.equal(analysis.inputId, input.snapshot.id)
  } else {
    await assert.rejects(analyzeCodeBehavior(input, run), /raw整合越过实际作者\/交付编辑范围.*新增作者raw必须保持真实source原字节/)
    assert.deepEqual(calls.map(call => call.purpose), ['code_behavior_analyze'], '原raw误改仍须在独审前拒绝')
  }
  assert.equal(contentHash(parseParts(source)!.rawSource), contentHash(parseParts(readFileSync(join(f.root, path), 'utf8'))!.rawSource))
  assert.equal((await captureInputSnapshot(f.root)).id, input.snapshot.id)
})

test('纯父局部视图缺席不等于全树缺席，空业务源码候选禁止newNodes', async t => {
  const f = await fixture(t), parentPath = '.spec/export/spec.md', existingLeaf = '.spec/export/export-contract/spec.md'
  writeFileSync(join(f.root, parentPath), '---\ntitle: 导出上层原意\nstatus: pending\n---\n\n## raw source\n\n保持当前导出能力，由既有子叶承接具体业务。\n')
  git(f.root, 'add', parentPath); git(f.root, 'commit', '-m', 'seed pure parent intent')
  const before = await f.input(), input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, origin: 'initial',
    partition: { id: 'pure-parent', changedPaths: [parentPath], factSourcePaths: [] },
    plan: { ...before.plan, intentNodeId: 'export', targets: [{ nodeId: 'export', path: parentPath }], readPaths: [parentPath, 'package.json'], writePaths: [parentPath], sourcePaths: [], facts: [] },
  }
  assert.ok(readTree(input.snapshot.source.commonDir, input.snapshot.immutableTree).some(entry => entry.path === existingLeaf), '完整冻结Git树中真实子叶已存在')
  const calls: string[] = []
  const localRunner = (newCodePath?: string): ElaborationRunner => async request => {
    calls.push(request.purpose)
    const context = readFrozenBehaviorContext<{ partition: { id: string }; unownedSourcePaths: string[]; readablePaths: { path: string }[]; newSource: [string, string][]; plan: { sourcePaths: string[] }; contractItems: { previous: unknown[]; current: unknown[] } }>(request)
    assert.deepEqual(context.unownedSourcePaths, [])
    assert.deepEqual(context.plan.sourcePaths, [])
    assert.ok(!context.readablePaths.some(entry => entry.path === existingLeaf))
    assert.ok(!new Map(context.newSource).has(existingLeaf))
    assert.deepEqual(context.contractItems, { previous: [], current: [] })
    assert.match(request.prompt, /局部投影/)
    assert.match(request.prompt, /缺席.*不.*全树不存在/)
    assert.match(request.prompt, /读取完整性由工具\/程序记录/)
    assert.match(request.prompt, /不手工复述task\/body entry的hash、长度或读取区间/)
    if (request.purpose === 'code_behavior_analyze') {
      const newNodes = (request.schema.properties as Record<string, Record<string, unknown>>).newNodes
      assert.equal(newNodes.maxItems, 0, '纯父没有真实未治理业务源码，Native schema必须禁止新建叶')
      assert.ok(!JSON.stringify(newNodes).includes('"enum":[]'))
    }
    return runner('refactor', proposal => {
      proposal.changes = (proposal.changes as Record<string, unknown>[]).map(change => ({ ...change, affectedIds: [], ruleIds: [] }))
      proposal.newNodes = newCodePath ? [{ codePath: newCodePath, parentNodeId: 'export', basis: '不能从局部缺席推断全树没有该叶' }] : []
    })(request)
  }
  const accepted = await analyzeCodeBehavior(input, localRunner())
  assert.equal(accepted.reviewPassed, true)
  assert.deepEqual(accepted.newNodes, [])
  assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])
  for (const path of [existingLeaf, 'src/export.js', 'tests/export.test.mjs', parentPath]) {
    calls.length = 0
    await assert.rejects(analyzeCodeBehavior(input, localRunner(path)), (error: Error & { code: string }) => {
      assert.equal(error.code, 'behavior_analysis_invalid')
      assert.match(error.message, /newNodes/)
      return true
    })
    assert.deepEqual(calls, ['code_behavior_analyze'], '非法新归属在独审前拒绝')
  }
  await assert.rejects(analyzeCodeBehavior(input, runner('refactor', proposal => {
    proposal.changes = [{ ...(proposal.changes as object[])[0], paths: ['src/export.js'], affectedIds: [], ruleIds: [] }]
  })), /未完整读取的路径/, '局部schema限制不能放宽原读取门禁')
})

test('raw-only v2 code_to_spec只读源码可声明新叶，但Spec写入仍限原父目录和本分区候选', async t => {
  const f = await fixture(t), sourcePath = 'src/summary.js', otherSourcePath = 'src/other-partition.js', testPath = 'tests/summary.test.js', outsideSourcePath = 'vendor/summary.js'
  const parentPath = '.spec/export/export-contract/spec.md', otherParentPath = '.spec/export/unselected/spec.md'
  for (const [path, source] of [[sourcePath, 'export const summarize = rows => rows.length;\n'], [otherSourcePath, 'export const other = true;\n'], [testPath, 'assert.equal(1, 1);\n'], [outsideSourcePath, 'export const outside = true;\n']] as const) {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), source)
  }
  mkdirSync(join(f.root, otherParentPath, '..'), { recursive: true })
  writeFileSync(join(f.root, otherParentPath), '---\ntitle: 未选父节点\nstatus: pending\n---\n\n## raw source\n\n保留一个无关的真实上层意图。\n')
  git(f.root, 'add', sourcePath, otherSourcePath, testPath, outsideSourcePath, otherParentPath); git(f.root, 'commit', '-m', 'seed raw-only code behavior')
  const before = await f.input(), plan: CodeBehaviorInput['plan'] = {
    ...before.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', intentNodeId: 'export-contract',
    targets: [], readPaths: ['.spec', 'src', 'tests', 'vendor'], writePaths: [], sourcePaths: ['src'], executionScope: { paths: [parentPath], contractIds: [], flowIds: [] },
    commitTrigger: { before: null, paths: [sourcePath, testPath] }, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 1000000, maxParallel: 1 }, facts: [],
  }
  const partition: NonNullable<CodeBehaviorInput['partition']> = { id: 'raw-only-summary', changedPaths: [sourcePath, testPath], factSourcePaths: [sourcePath], authorizedParentSpecPaths: [parentPath] }
  const input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, plan, origin: 'initial', partition }
  const emptyRawParentPath = '.spec/export/no-raw-parent/spec.md'
  mkdirSync(join(f.root, emptyRawParentPath, '..'), { recursive: true })
  writeFileSync(join(f.root, emptyRawParentPath), '---\ntitle: 无raw父节点\nstatus: active\n---\n\n## expanded spec\n\n仅有扩展正文，没有上层原始需求。\n')
  git(f.root, 'add', emptyRawParentPath); git(f.root, 'commit', '-m', 'seed parent without raw intent')
  const refreshed = await f.input()
  const refreshedInput: CodeBehaviorInput = { ...input, snapshot: refreshed.snapshot, composed: composeInputSnapshots(refreshed.snapshot, null).composed! }
  const propose = (codePath: string, parentNodeId = 'export-contract', resolutionPath?: string) => runner('refactor', proposal => {
    proposal.newNodes = [{ codePath, parentNodeId, basis: '真实已读业务模块需要由原意根下唯一治理叶承接' }]
    if (resolutionPath) proposal.resolutions = [{ path: resolutionPath, content: 'must remain read only\n', mode: '100644' }]
  })
  let projectedSchema: unknown, analysisParents: unknown, reviewParents: unknown
  const accepted = await analyzeCodeBehavior(refreshedInput, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ newNodeParents?: { nodeId: string; path: string }[] }>(request)
      analysisParents = frozen.newNodeParents
      assert.match(request.prompt, /parentNodeId必须填写nodeId/)
      assert.match(request.prompt, /path仅用于定位/)
      const newNodes = (request.schema.properties as Record<string, { maxItems: number; items: { properties: { codePath: { enum: string[] }; parentNodeId: { enum?: string[] } } } }>).newNodes
      projectedSchema = structuredClone(newNodes)
      assert.equal(newNodes.maxItems, 1)
      assert.deepEqual(newNodes.items.properties.codePath.enum, [sourcePath])
      assert.deepEqual(newNodes.items.properties.parentNodeId.enum, ['export-contract'])
    } else if (request.purpose === 'code_behavior_review') {
      reviewParents = readFrozenBehaviorContext<{ newNodeParents?: { nodeId: string; path: string }[] }>(request).newNodeParents
      const stageInstructions = request.prompt.slice(0, request.prompt.indexOf('冻结三方输入:\n'))
      assert.match(stageInstructions, /newNodeProposals/)
      assert.match(stageInstructions, /analysis\.newNodes.*四字段/)
      assert.doesNotMatch(stageInstructions, /newNodes\.parentNodeId必须填写nodeId/)
      const payload = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysis: CodeBehaviorAnalysis; newNodeProposals: { codePath: string; parentNodeId: string; basis: string }[] }
      assert.deepEqual(payload.newNodeProposals, [{ codePath: sourcePath, parentNodeId: 'export-contract', basis: '真实已读业务模块需要由原意根下唯一治理叶承接' }])
      assert.deepEqual(Object.keys(payload.analysis.newNodes[0]).sort(), ['codePath', 'nodeId', 'path', 'rawSource'])
    }
    return propose(sourcePath)(request)
  })
  assert.equal(accepted.reviewPassed, true)
  assert.deepEqual(accepted.newNodes.map(node => node.codePath), [sourcePath])
  assert.ok(accepted.newNodes[0].path.startsWith('.spec/export/export-contract/'))
  assert.deepEqual(analysisParents, [{ nodeId: 'export-contract', path: parentPath }])
  assert.deepEqual(reviewParents, analysisParents)
  assert.deepEqual((projectedSchema as { items: { properties: { codePath: { enum: string[] } } } }).items.properties.codePath.enum, [sourcePath])

  const multiParentInput: CodeBehaviorInput = { ...refreshedInput, partition: { ...partition, authorizedParentSpecPaths: [parentPath, otherParentPath, emptyRawParentPath] } }
  const multiParent = await analyzeCodeBehavior(multiParentInput, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ newNodeParents?: { nodeId: string; path: string }[] }>(request)
      assert.deepEqual(frozen.newNodeParents, [
        { nodeId: 'export-contract', path: parentPath },
        { nodeId: 'unselected', path: otherParentPath },
      ])
      const newNodes = (request.schema.properties as Record<string, { items: { properties: { parentNodeId: { enum?: string[] } } } }>).newNodes
      assert.deepEqual(newNodes.items.properties.parentNodeId.enum, ['export-contract', 'unselected'])
    }
    return propose(sourcePath, 'unselected')(request)
  })
  assert.ok(multiParent.newNodes[0].path.startsWith('.spec/export/unselected/'))

  const unpartitionedInput: CodeBehaviorInput = { ...input, partition: undefined, plan: { ...plan, targets: [{ nodeId: 'export-contract', path: parentPath }], sourcePaths: [sourcePath], writePaths: ['.spec/export'] } }
  const unpartitioned = await analyzeCodeBehavior(unpartitionedInput, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const frozen = readFrozenBehaviorContext<{ requiredChangedPaths: string[]; unownedSourcePaths: string[]; newNodeParents?: { nodeId: string; path: string }[] }>(request)
      const newNodes = (request.schema.properties as Record<string, { maxItems: number; items: { properties: { codePath: { enum: string[] }; parentNodeId: { enum?: string[] } } } }>).newNodes
      assert.deepEqual(frozen.requiredChangedPaths, [sourcePath], 'unpartitioned raw-only discovery must not depend on source write permission')
      assert.deepEqual(frozen.unownedSourcePaths, [sourcePath])
      assert.deepEqual(frozen.newNodeParents, [{ nodeId: 'export-contract', path: parentPath }])
      assert.equal(newNodes.maxItems, 1)
      assert.deepEqual(newNodes.items.properties.codePath.enum, [sourcePath])
      assert.deepEqual(newNodes.items.properties.parentNodeId.enum, ['export-contract'])
    }
    return propose(sourcePath)(request)
  })
  assert.equal(unpartitioned.reviewPassed, true)
  assert.deepEqual(unpartitioned.newNodes.map(node => node.codePath), [sourcePath])

  for (const [codePath, parentNodeId] of [
    [otherSourcePath, 'export-contract'], [outsideSourcePath, 'export-contract'], [testPath, 'export-contract'], ['src/export.js', 'export-contract'],
    [sourcePath, 'unknown-parent'], [sourcePath, 'unselected'], [sourcePath, parentPath], [sourcePath, 'no-raw-parent'],
  ] as const) {
    await assert.rejects(analyzeCodeBehavior(refreshedInput, propose(codePath, parentNodeId)), /newNodes|上层需求|授权父Spec/)
  }
  await assert.rejects(analyzeCodeBehavior(refreshedInput, propose(sourcePath, 'export-contract', sourcePath)), /整合解决方案/)
  await assert.rejects(analyzeCodeBehavior(refreshedInput, propose(sourcePath, 'export-contract', testPath)), /整合解决方案/)
  await assert.rejects(analyzeCodeBehavior({ ...refreshedInput, partition: { ...partition, authorizedParentSpecPaths: [] } }, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const newNodes = (request.schema.properties as Record<string, { maxItems: number; items: { properties: { codePath: { enum?: string[] }; parentNodeId: { enum?: string[] } } } }>).newNodes
      assert.equal(newNodes.maxItems, 0)
      assert.ok(!JSON.stringify(newNodes).includes('"enum":[]'))
      assert.equal(newNodes.items.properties.parentNodeId.enum, undefined)
    }
    return propose(sourcePath)(request)
  }), /newNodes/)
})

test('raw-only v2独审对照当前原newNodeProposals与四字段解析叶，历史父失败不冒充本次提案', async t => {
  const f = await fixture(t), sourcePath = 'src/export-view.js', parentPath = '.spec/export/export-contract/spec.md'
  writeFileSync(join(f.root, sourcePath), 'export const exportView = rows => rows.filter(Boolean)\n')
  git(f.root, 'add', sourcePath); git(f.root, 'commit', '-m', 'seed unowned export view')
  const prepared = await f.input(), basis = '用户可以提交符合筛选条件的数据导出，任务完成后下载结果。'
  assert.ok(f.raw.includes(basis))
  const oldFailure = { code: 'behavior_analysis_invalid', message: JSON.stringify({ approved: false, message: '新无治理文件没有真实上层需求/授权业务源码', proposal: { newNodes: [{ codePath: 'src/old-export.js', parentNodeId: parentPath, basis: '旧尝试错误地把父路径当作nodeId' }] } }) }
  const plan: CodeBehaviorInput['plan'] = {
    ...prepared.plan, version: 'sync-coordinator-v2', direction: 'code_to_spec', intentNodeId: 'export-contract', targets: [],
    readPaths: ['.spec', 'src', 'tests'], writePaths: [], sourcePaths: ['src'], executionScope: { paths: [parentPath], contractIds: [], flowIds: [] },
    commitTrigger: { before: null, paths: [sourcePath] }, partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 1000000, maxParallel: 1 }, facts: [],
  }
  const partition: NonNullable<CodeBehaviorInput['partition']> = { id: 'review-stage-contract', changedPaths: [sourcePath], factSourcePaths: [sourcePath], authorizedParentSpecPaths: [parentPath] }
  const input: CodeBehaviorInput = {
    ...prepared, baseline: null, baselineSelection: undefined, composed: composeInputSnapshots(prepared.snapshot, null).composed!, plan, origin: 'initial', partition,
    repairDiagnostics: [oldFailure],
  }
  type ProposalNode = { codePath: string; parentNodeId: string; basis: string }
  type ReviewContext = {
    changedPaths: string[]; newSource: [string, string][]; oldSource: [string, string][]; composedFiles: [string, string][]
    readablePaths: { path: string; snapshots: string[] }[]; newNodeParents?: { nodeId: string; path: string }[]
    repairDiagnostics: { code: string; message: string }[]
  }
  type ReviewPayload = { analysisDigest: string; analysis: CodeBehaviorAnalysis; newNodeProposals?: ProposalNode[] }
  type ReviewOutput = { inputDigest: string; analysisDigest: string; verdict: 'accept' | 'repair'; checkedPaths: string[]; checkedChangeIds: string[]; findings: { message: string; evidence: string; counterexample: string }[] }
  const assessReviewStage = (request: Parameters<ElaborationRunner>[0], prefix: string, context: ReviewContext, payload: ReviewPayload): ReviewOutput => {
    const issues: string[] = []
    if (!prefix.includes('newNodeProposals') || !prefix.includes('analysis.newNodes')) issues.push('独审阶段输入缺少原提案与解析结果的阶段说明')
    if (prefix.includes('newNodes.parentNodeId必须填写nodeId')) issues.push('独审把提案字段误要求到解析后的analysis.newNodes')
    const proposals = payload.newNodeProposals
    if (!proposals) issues.push('独审未收到本次原proposal.newNodes')
    const proposalByCode = new Map((proposals ?? []).map(node => [node.codePath, node]))
    const resolvedByCode = new Map(payload.analysis.newNodes.map(node => [node.codePath, node]))
    if (proposalByCode.size !== resolvedByCode.size || proposalByCode.size !== (proposals?.length ?? 0)) issues.push('原提案与解析叶的codePath集合不唯一或不相等')
    const parents = context.newNodeParents ?? []
    for (const proposal of proposals ?? []) {
      const parent = parents.find(node => node.nodeId === proposal.parentNodeId)
      const resolved = resolvedByCode.get(proposal.codePath)
      if (!parent || !resolved) { issues.push(`未能绑定已授权父节点与解析叶: ${proposal.codePath}`); continue }
      const sources = [context.newSource, context.oldSource, context.composedFiles]
      const parentRaw = sources.flatMap(files => files.filter(([path]) => path === parent.path).map(([, text]) => text))[0]
      const code = sources.flatMap(files => files.filter(([path]) => path === proposal.codePath).map(([, text]) => text))[0]
      if (!parentRaw || !context.readablePaths.some(item => item.path === parent.path)) issues.push(`父节点raw未在授权读取范围内: ${parent.path}`)
      if (!code || !context.readablePaths.some(item => item.path === proposal.codePath)) issues.push(`源码全文未在授权读取范围内: ${proposal.codePath}`)
      if (parentRaw && !parentRaw.includes(proposal.basis)) issues.push(`原提案basis不受父raw支持: ${proposal.codePath}`)
      if (resolved.path !== `${posix.dirname(parent.path)}/${resolved.nodeId}/spec.md`) issues.push(`解析叶路径不在真实父目录下: ${resolved.path}`)
      if (resolved.rawSource !== `遵循 [[${parent.nodeId}]] 的原始需求，治理 ${proposal.codePath} 的对应职责；已有上层业务原意及未选义务继续有效。`) issues.push(`解析叶raw未引用同一父节点和源码职责: ${proposal.codePath}`)
      if (Object.keys(resolved).some(key => key === 'parentNodeId' || key === 'basis')) issues.push('持久解析叶错误携带了原提案字段')
    }
    if (context.repairDiagnostics.some(item => item.code === oldFailure.code && item.message === oldFailure.message) && proposals?.some(node => node.codePath === 'src/old-export.js')) issues.push('把repairDiagnostics里的旧提案误当成当前提案')
    const checkedPaths = [...new Set([...context.changedPaths, parentPath])]
    return {
      inputDigest: request.inputDigest, analysisDigest: payload.analysisDigest, verdict: issues.length ? 'repair' : 'accept',
      checkedPaths, checkedChangeIds: payload.analysis.changes.map(change => change.id),
      findings: issues.map(message => ({ message, evidence: '逐项检查当前newNodeProposals、冻结newNodeParents与持久解析叶字段', counterexample: '改变parentNodeId、codePath、叶路径或raw引用后不能保持同一授权父子关系' })),
    }
  }
  const dispatchWithReview = (proposalRunner: ElaborationRunner, reviewPrefixOverride?: string): { runner: ElaborationRunner; lastReview: () => { request: Parameters<ElaborationRunner>[0]; output: ReviewOutput } | undefined } => {
    let lastReview: { request: Parameters<ElaborationRunner>[0]; output: ReviewOutput } | undefined
    const run: ElaborationRunner = async request => {
      if (request.purpose === 'code_behavior_analyze') return proposalRunner(request)
      const boundary = request.prompt.indexOf('冻结三方输入:\n')
      const prefix = reviewPrefixOverride ?? request.prompt.slice(0, boundary)
      const context = readFrozenBehaviorContext<ReviewContext>(request)
      const payload = JSON.parse(request.prompt.split('待审分析:\n')[1]) as ReviewPayload
      const output = assessReviewStage(request, prefix, context, payload)
      lastReview = { request, output }
      return { sessionId: 'session-review-stage-contract', threadId: 'thread-review-stage-contract', turnId: 'turn-review', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    return { runner: run, lastReview: () => lastReview }
  }
  const propose = (newBasis: string) => runner('refactor', proposal => { proposal.newNodes = [{ codePath: sourcePath, parentNodeId: 'export-contract', basis: newBasis }] })
  const positive = dispatchWithReview(propose(basis))
  const analysis = await analyzeCodeBehavior(input, positive.runner)
  assert.equal(analysis.reviewPassed, true)
  assert.deepEqual(analysis.newNodes.map(node => node.codePath), [sourcePath])
  assert.deepEqual(Object.keys(analysis.newNodes[0]).sort(), ['codePath', 'nodeId', 'path', 'rawSource'])
  const acceptedReview = positive.lastReview()!
  assert.equal(acceptedReview.output.verdict, 'accept')
  assert.deepEqual(acceptedReview.output.checkedPaths.sort(), [parentPath, sourcePath])
  const currentPayload = JSON.parse(acceptedReview.request.prompt.split('待审分析:\n')[1]) as ReviewPayload
  assert.deepEqual(currentPayload.newNodeProposals, [{ codePath: sourcePath, parentNodeId: 'export-contract', basis }])
  assert.deepEqual(currentPayload.analysis.newNodes, analysis.newNodes)
  const stale = JSON.parse(input.repairDiagnostics![0].message) as { proposal: { newNodes: ProposalNode[] } }
  assert.equal(stale.proposal.newNodes[0].parentNodeId, parentPath)
  assert.notDeepEqual(currentPayload.newNodeProposals, stale.proposal.newNodes)
  const acceptedContext = readFrozenBehaviorContext<ReviewContext>(acceptedReview.request)
  assert.equal(acceptedContext.repairDiagnostics[0].message, oldFailure.message, '历史失败必须保留为数据，但独审只核本次原proposal')
  const prefix = acceptedReview.request.prompt.slice(0, acceptedReview.request.prompt.indexOf('冻结三方输入:\n'))
  assert.match(prefix, /newNodeProposals/)
  assert.doesNotMatch(prefix, /newNodes\.parentNodeId必须填写nodeId/)

  const legacyPayload = { ...currentPayload, newNodeProposals: undefined }
  const legacyReview = assessReviewStage(acceptedReview.request, '', acceptedContext, legacyPayload)
  assert.equal(legacyReview.verdict, 'repair', '缺原proposal或阶段指引必须形成具体repair，不能默认accept')
  assert.match(legacyReview.findings[0].message, /阶段输入缺少|未收到本次原proposal/)
  const mismatchedResolved = { ...currentPayload, analysis: { ...currentPayload.analysis, newNodes: [{ ...currentPayload.analysis.newNodes[0], path: '.spec/other/forged/spec.md' }] } }
  const ownershipRepair = assessReviewStage(acceptedReview.request, prefix, acceptedContext, mismatchedResolved)
  assert.equal(ownershipRepair.verdict, 'repair', '不能把builder的path解析结果当成免审证据')
  assert.match(ownershipRepair.findings[0].message, /解析叶路径/)

  const invalidCalls: string[] = []
  const invalidParentRunner = runner('refactor', proposal => { proposal.newNodes = [{ codePath: sourcePath, parentNodeId: parentPath, basis }] })
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    invalidCalls.push(request.purpose)
    return invalidParentRunner(request)
  }), error => (error as Error & { code?: string }).code === 'behavior_analysis_invalid')
  assert.deepEqual(invalidCalls, ['code_behavior_analyze'], '非法父ID在独审派发前拒绝')

  const badBasis = '原始raw允许任何用户下载任意任务结果并跳过所有权检查。'
  const repair = dispatchWithReview(propose(badBasis))
  let failedMessage = ''
  await assert.rejects(analyzeCodeBehavior(input, repair.runner), error => {
    failedMessage = (error as Error).message
    return (error as Error & { code?: string }).code === 'behavior_review_failed'
  })
  assert.match(failedMessage, /basis不受父raw支持/)
  assert.equal(repair.lastReview()!.output.verdict, 'repair', '独审发现basis越权仍拒绝整份分析')
})

test('冻结source角色只发现业务根，纯测试helper可读且旧计划保持writePaths发现语义', async t => {
  const f = await fixture(t), sourcePath = 'src/test_business.py', tests = ['tests/test_flow.py', 'tests/support.py']
  for (const path of [sourcePath, ...tests]) writeFileSync(join(f.root, path), 'def value():\n    return 1\n')
  writeFileSync(join(f.root, 'src/embedded.test.js'), 'export const fixture = 1\n')
  git(f.root, 'add', sourcePath, ...tests, 'src/embedded.test.js'); git(f.root, 'commit', '-m', 'seed source and pure tests')
  const before = await f.input(), input: CodeBehaviorInput = { ...before, baseline: null, composed: composeInputSnapshots(before.snapshot, null).composed!, plan: { ...before.plan, sourcePaths: ['src'] } }
  const analysis = await analyzeCodeBehavior(input, async request => {
    const context = readFrozenBehaviorContext<{ changedPaths: string[]; newSource: [string, string][] }>(request)
    assert.deepEqual(context.changedPaths, [sourcePath])
    if (request.purpose === 'code_behavior_analyze') {
      const schema = (request.schema.properties as { newNodes: { maxItems: number; items: { properties: { codePath: { enum: string[] } } } } }).newNodes
      assert.equal(schema.maxItems, 1)
      assert.deepEqual(schema.items.properties.codePath.enum, [sourcePath], '不含Spec、纯测试和已治理src/export.js')
    }
    assert.ok(tests.every(path => new Map(context.newSource).has(path)))
    return runner('allowed_change', proposal => { proposal.newNodes = [{ codePath: sourcePath, parentNodeId: 'export-contract', basis: '真实业务helper需要归属' }] })(request)
  })
  assert.deepEqual(analysis.newNodes.map(node => node.codePath), [sourcePath])
  await assert.rejects(analyzeCodeBehavior(input, runner('allowed_change', proposal => { proposal.newNodes = [sourcePath, tests[0]].map(codePath => ({ codePath, parentNodeId: 'export-contract', basis: '不能凭测试可写新增业务归属' })) })), /newNodes/)
  const restored = { ...input, plan: JSON.parse(JSON.stringify(before.plan)) as CodeBehaviorInput['plan'] }, stopped = new Error('captured legacy discovery')
  await assert.rejects(analyzeCodeBehavior(restored, async request => {
    const context = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
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
    const context = readFrozenBehaviorContext<{ changedPaths: string[] }>(request)
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
    const context = readFrozenBehaviorContext<NonTextContext>(request)
    const link = context.nonTextFiles.find(file => file.path === 'src/link')!
    assert.equal(link.kind, 'symlink'); assert.equal(link.mode, '120000'); assert.equal(link.content, 'export.js')
    assert.ok(!context.newSource.some(([path]) => path === 'src/link'))
    assert.equal(new Map(context.newSource).get(path), helper)
    assert.equal(request.prompt.includes(helper), false)
    assert.match(request.prompt, /cwd.*不是.*输入/)
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

for (const mode of ['readonly-unchanged', 'readonly-author', 'readonly-business', 'writable-new-basis'] as const) test(`AC变化依据可行性 ${mode} 复用来源变化且不以旧AC闭包限制新依据`, async t => {
  const parentPath = '.spec/export/spec.md'
  const parent = `---\ntitle: 共享政策\ncontract-schema: sync-v1\n---\n## raw source\n\n共享数据政策，保留未选义务。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| REQ-SHARED-01 | 共享数据约束 | user:raw | 保持字段 | 数据完整 | - |\n\n### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |\n| RULE-SHARED-01 | 共享字段 | 标题去首尾空白 | 原始要求 | export | user:raw | REQ-SHARED-01 |\n`
  const f = await fixture(t, source => source.replace('| AC-EXPORT-01 | ', '| AC-EXPORT-01 | RULE-SHARED-01,'), { [parentPath]: parent })
  writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// observable result detail\n`)
  if (mode === 'readonly-author') writeFileSync(join(f.root, parentPath), parent.replace('共享数据政策，保留未选义务。', '共享数据政策，保留未选义务；标题最长128字符。'))
  if (mode === 'readonly-business') writeFileSync(join(f.root, parentPath), parent.replace('标题去首尾空白 |', '标题去首尾空白且最长128字符 |'))
  const input = await f.input()
  input.plan.writePaths = ['src', '.spec/export/export-contract', 'tests']
  const basis = mode === 'readonly-author' ? 'REQ-SHARED-01' : mode === 'writable-new-basis' ? 'RULE-EXPORT-06' : 'RULE-SHARED-01'
  const calls: string[] = [], fake = runner('allowed_change', proposal => {
    proposal.changes = (proposal.changes as Record<string, unknown>[]).map(change => ({ ...change, affectedIds: ['AC-EXPORT-01', basis], ruleIds: [basis] }))
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: [basis], source: 'user:raw', reason: '只用本次实际变化依据，未变covers继续保留' }]
  })
  const run = () => analyzeCodeBehavior(input, request => { calls.push(request.purpose); return fake(request) })
  if (mode === 'readonly-unchanged') {
    await assert.rejects(run(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'behavior_analysis_invalid')
      const diagnostic = JSON.parse(error.message)
      assert.deepEqual(diagnostic.details.unchangedReadonlyBasis, [{ id: basis, nodeId: 'export', path: parentPath }])
      assert.deepEqual(diagnostic.proposal.acceptanceChanges[0].ruleIds, [basis])
      assert.equal(diagnostic.review, undefined)
      return true
    })
    assert.deepEqual(calls, ['code_behavior_analyze'], '不可实现的授权在独审/P1前拒绝')
  } else {
    const accepted = await run()
    assert.equal(accepted.reviewPassed, true)
    assert.deepEqual(calls, ['code_behavior_analyze', 'code_behavior_review'])
    assert.deepEqual(accepted.authorizedChanges[0].action === 'update_acceptance' && accepted.authorizedChanges[0].ruleIds, [basis])
  }
})

test('AC复合门禁逐项诊断未变规则与不绑定来源，不把多个allowed_change并集授权', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'src/export.js'), `${f.source}\n// result count extension\n`)
  const input = await f.input(), source = 'code:src/export.js#ExportService.dispatch'
  let dispatchedAcceptanceIds: string[] = []
  const unsupportedProposal = runner('allowed_change', proposal => {
    proposal.facts = [{ source, text: '只新增结果派生计数，不更改权限' }]
    proposal.acceptanceChanges = [{ id: 'AC-EXPORT-01', ruleIds: ['RULE-EXPORT-05', 'RULE-EXPORT-01'], source, reason: '原AC同时覆盖权限但本次权限未改变' }]
  })
  await assert.rejects(analyzeCodeBehavior(input, async request => {
    if (request.purpose === 'code_behavior_analyze') {
      const properties = request.schema.properties as Record<string, { items: { properties: Record<string, { enum?: string[] }> } }>
      dispatchedAcceptanceIds = properties.acceptanceChanges.items.properties.id.enum ?? []
    }
    return unsupportedProposal(request)
  }), (error: Error) => {
    const diagnostic = JSON.parse(error.message)
    assert.equal(diagnostic.details.targetKind, 'AC'); assert.equal(diagnostic.details.sourceBound, true)
    assert.deepEqual(diagnostic.details.allowedChanges[0].unsupportedRuleIds, ['RULE-EXPORT-01']); assert.equal(diagnostic.details.allowedChanges[0].missingAffectedId, null)
    assert.ok(diagnostic.proposal.acceptanceChanges); return true
  })
  assert.ok(dispatchedAcceptanceIds.includes('AC-EXPORT-01'), '合法既有目标进入schema，但运行时仍需完整规则授权')
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
  const analysis = await analyzeCodeBehavior(input, async request => {
    calls.push(request.prompt)
    const frozen = readFrozenBehaviorContext<{ oldSource: [string, string][]; newSource: [string, string][]; verifiedDelivery: [string, string][] }>(request)
    assert.equal(new Map(frozen.oldSource).get('src/export.js'), f.source)
    assert.match(new Map(frozen.newSource).get('src/export.js') ?? '', /observable: true/)
    assert.ok(request.prompt.includes('verifiedDelivery'))
    assert.ok(frozen.verifiedDelivery.some(([, text]) => text.includes('assert')))
    assert.equal(request.prompt.includes(f.source), false)
    return fake(request)
  })
  assert.equal(analysis.reviewPassed, true); assert.equal(analysis.baselinePairId, 'pair-verified')
  assert.equal(analysis.traces.length, 2); assert.notEqual(analysis.traces[0].sessionId, analysis.traces[1].sessionId)
  assert.equal(calls.length, 2)
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
    const context = readFrozenBehaviorContext<{ requiredChangedPaths: string[]; unownedSourcePaths: string[]; unownedSourcePathCount: number; snapshotTree: string; composed: { tree: string } }>(request)
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
    const context = readFrozenBehaviorContext<{ repairDiagnostics: { code: string; message: string }[]; requiredChangedPaths: string[]; unownedSourcePaths: string[]; unownedSourcePathCount: number }>(request)
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
