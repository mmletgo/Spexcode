import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { prepareHistoryRequest, readHistoryRequest, readHistoryRestorations } from './history-input.js'
import { composeInputSnapshots, readCompositionEvidence, selectedRetiredIds } from './composition.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { contractAuthorizationErrors, validateContractEvolution } from './contract-evolution.js'
import type { AuthorizedContractChange } from './elaboration-types.js'
import { composeControlledRequest } from './request-input.js'
import type { BaselinePair, FrozenBaselineSelection } from './operation-types.js'

async function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-history-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'History test'); git('config', 'user.email', 'history@example.invalid')
  mkdirSync(join(root, '.spec/feature'), { recursive: true })
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`)
  writeFileSync(join(root, 'code.ts'), lines.join('\n') + '\n')
  writeFileSync(join(root, 'tests.ts'), 'old test\n'); writeFileSync(join(root, '.spec/feature/spec.md'), 'old spec and map\n')
  git('add', '.'); git('commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  lines[2] = 'feature line'
  writeFileSync(join(root, 'code.ts'), lines.join('\n') + '\n'); writeFileSync(join(root, 'tests.ts'), 'feature test\n')
  writeFileSync(join(root, '.spec/feature/spec.md'), 'feature spec and map\n')
  git('add', '.'); git('commit', '-m', 'feature')
  const featureCommit = git('rev-parse', 'HEAD')
  return { root, git, lines, base, featureCommit, input: { featureCommit, requestId: 'request', nodeId: 'feature', operationId: 'operation', receiptId: 'receipt' } }
}

test('真实Git反向三方成组保留历史、无关与同文件后续编辑，source/index不变', async t => {
  const f = await fixture(t)
  f.lines[25] = 'later human line'; writeFileSync(join(f.root, 'code.ts'), f.lines.join('\n') + '\n')
  writeFileSync(join(f.root, 'unrelated.txt'), 'later independent work\n'); f.git('add', '.'); f.git('commit', '-m', 'later')
  writeFileSync(join(f.root, 'unrelated.txt'), 'staged human\n'); f.git('add', 'unrelated.txt'); writeFileSync(join(f.root, 'unrelated.txt'), 'unstaged human\n')
  const snapshot = await captureInputSnapshot(f.root), index = readFileSync(join(f.root, '.git/index')), head = f.git('rev-parse', 'HEAD')
  const ref = prepareHistoryRequest(snapshot, f.input), request = readHistoryRequest(snapshot, ref)
  assert.deepEqual(request.conflicts, []); assert.equal(request.parentCommit, f.base)
  assert.deepEqual(request.changes.map(change => change.path), ['.spec/feature/spec.md', 'code.ts', 'tests.ts'])
  const files = new Map(readTree(snapshot.source.commonDir, request.requestTree).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString()]))
  assert.match(files.get('code.ts')!, /line 2\n/); assert.match(files.get('code.ts')!, /later human line/)
  assert.equal(files.get('tests.ts'), 'old test\n'); assert.equal(files.get('.spec/feature/spec.md'), 'old spec and map\n')
  assert.equal(files.get('unrelated.txt'), 'unstaged human\n')
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
  assert.throws(() => readHistoryRequest(snapshot, writeEvidence(snapshot.source.commonDir, { ...request, changes: request.changes.slice(1) })), /SYNC_HISTORY_BINDING/)
  assert.throws(() => readHistoryRequest(snapshot, writeEvidence(snapshot.source.commonDir, { ...request, unknownAuthority: 'claimed' })), /SYNC_HISTORY_BINDING/)
})

test('真实重叠保三方Git证据，不把冲突树当无冲突补偿', async t => {
  const f = await fixture(t)
  f.lines[2] = 'later conflicting human line'; writeFileSync(join(f.root, 'code.ts'), f.lines.join('\n') + '\n'); f.git('add', '.'); f.git('commit', '-m', 'later conflict')
  const snapshot = await captureInputSnapshot(f.root), ref = prepareHistoryRequest(snapshot, f.input), request = readHistoryRequest(snapshot, ref)
  assert.deepEqual(request.conflicts, ['code.ts']); assert.match(Buffer.from(request.mergeOutput, 'base64').toString(), /CONFLICT/)
  assert.match(readFileSync(join(f.root, 'code.ts'), 'utf8'), /later conflicting human line/)
  assert.equal(JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString()).type, 'sync.history')
})

test('Git原生rename语义保留节点新位置，旧输入及未采纳提交拒绝', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.root, '.spec/moved')); renameSync(join(f.root, '.spec/feature/spec.md'), join(f.root, '.spec/moved/spec.md'))
  f.git('add', '.'); f.git('commit', '-m', 'move node')
  const snapshot = await captureInputSnapshot(f.root), ref = prepareHistoryRequest(snapshot, f.input), request = readHistoryRequest(snapshot, ref)
  assert.deepEqual(request.conflicts, []); assert.ok(request.changes.some(change => change.path === '.spec/moved/spec.md'))
  const changed = { ...snapshot, id: 'different' }; assert.throws(() => readHistoryRequest(changed, ref), /SYNC_HISTORY_BINDING/)
  f.git('checkout', '-b', 'other', f.base); writeFileSync(join(f.root, 'other.txt'), 'other'); f.git('add', '.'); f.git('commit', '-m', 'other')
  assert.throws(() => prepareHistoryRequest(snapshot, { ...f.input, featureCommit: f.git('rev-parse', 'HEAD') }))
})

test('反向三方拒绝外部merge driver，不在宿主执行候选合并命令', async t => {
  const f = await fixture(t), marker = join(f.root, 'driver-executed')
  f.git('config', 'merge.unsafe.driver', `touch '${marker}'`)
  writeFileSync(join(f.root, '.gitattributes'), 'code.ts merge=unsafe\n')
  const snapshot = await captureInputSnapshot(f.root)
  assert.throws(() => prepareHistoryRequest(snapshot, f.input), /SYNC_HISTORY_MERGE_DRIVER_UNSUPPORTED/)
  assert.equal(existsSync(marker), false)
})

test('成组恢复已采纳tombstone仍核验真实恢复的ID对象，不因历史三方皆空遗漏', async t => {
  const f = await fixture(t), path = '.spec/feature/spec.md', id = 'REQ-HISTORY-01'
  writeFileSync(join(f.root, path), `---\ntitle: 历史对象\nstatus: active\ncontract-schema: sync-v1\ncode:\n  - code.ts\n---\n## raw source\n\n恢复同一个历史对象。\n\n## expanded spec\n\n### REQ\n\n| id | goal | source | constraints | success | depends-on |\n| --- | --- | --- | --- | --- | --- |\n| ${id} | 保留历史身份 | user:raw | 原业务对象 | 可追溯 | - |\n`)
  f.git('add', '.'); f.git('commit', '-m', 'identity before retirement')
  const sourceInput = await captureInputSnapshot(f.root)
  rmSync(join(f.root, path)); rmSync(join(f.root, 'code.ts')); f.git('add', '.'); f.git('commit', '-m', 'retire exact historical identity')
  const input = await captureInputSnapshot(f.root)
  const pair: BaselinePair = { id: 'retired-pair', repositoryId: input.source.repositoryId, source: input.source, sourceInput, verifiedDelivery: input, coveredScope: { paths: [path, 'code.ts'], contractIds: [id, 'feature'], flowIds: [] }, retiredIds: [id, 'feature'], receiptId: 'retired-receipt', settledAtMs: 1 }
  const body = { version: 'sync-baseline-selection-v1' as const, source: input.source, bindings: [{ resource: { kind: 'path' as const, path }, bytePair: pair }, { resource: { kind: 'path' as const, path: 'code.ts' }, bytePair: pair }, { resource: { kind: 'contract' as const, id }, intentPair: pair }, { resource: { kind: 'contract' as const, id: 'feature' }, intentPair: pair }] }
  const digest = contentHash(JSON.stringify(body, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value))
  const selection: FrozenBaselineSelection = { ...body, digest }, base = composeInputSnapshots(input, selection, { executionPaths: [path, 'code.ts'] }).composed!
  const request = prepareHistoryRequest(input, { ...f.input, featureCommit: input.headCommit }), composed = composeControlledRequest(input, base, request, { baselineSelection: selection }).composed!
  const evidence = readCompositionEvidence(input, composed, selection), intent = evidence.intents.find(item => item.resource.id === id)!
  assert.equal(intent.before, null); assert.equal(intent.delivery, null); assert.equal(intent.source?.item.id, id); assert.equal(intent.changed, true)
  assert.deepEqual(evidence.residualPaths, [path, 'code.ts'])
  assert.equal(evidence.artifacts.find(item => item.path === 'code.ts')!.delivery, null, '与当前input共用ID的真实旧delivery仍保已采纳删除，不能被request投影改写')
  const restored = readHistoryRestorations(input, request)
  assert.deepEqual(restored.map(item => item.id), [id, 'feature'])
  const before = await readFrozenContracts(f.root, new Map()), after = await readFrozenContracts(f.root, new Map([[path, restored[0].source]]))
  const policy = { mode: 'reelaborate' as const, authorizedChanges: [] as AuthorizedContractChange[], nodeChanges: [], retiredIds: [id, 'feature'], historyInput: input, newNodeRawSources: new Map([[path, '恢复同一个历史对象。']]) }
  assert.equal(validateContractEvolution(before, after, policy).filter(issue => issue.code === 'retired_id_reused').length, 2, '普通raw新节点与业务项复用退役身份仍拒绝')
  const authority: AuthorizedContractChange = { id, action: 'restore', source: 'user:raw', reason: '恢复同一历史对象', history: { inputId: input.id, requestBlob: request } }
  const nodeAuthority: AuthorizedContractChange = { ...authority, id: 'feature' }
  assert.deepEqual(contractAuthorizationErrors(authority, before, policy), [])
  assert.equal(validateContractEvolution(before, after, { ...policy, authorizedChanges: [authority, nodeAuthority] }).filter(issue => issue.code === 'retired_id_reused' || issue.code.startsWith('contract_restoration')).length, 0)
  const wrong = { ...authority, id: 'REQ-FOREIGN-01' }
  assert.notDeepEqual(contractAuthorizationErrors(wrong, before, policy), [])
  assert.notDeepEqual(contractAuthorizationErrors({ ...authority, history: undefined } as unknown as AuthorizedContractChange, before, policy), [])
  assert.notDeepEqual(contractAuthorizationErrors({ ...authority, source: 'code:fake#claim' } as unknown as AuthorizedContractChange, before, policy), [])
  const moved = new Map([['.spec/foreign/spec.md', restored[0].source]])
  assert.ok(validateContractEvolution(before, await readFrozenContracts(f.root, moved), { ...policy, authorizedChanges: [authority] }).some(issue => issue.code === 'contract_restoration_identity_changed'))
  const current = { ...pair, id: 'restored-head', retiredIds: [] }, currentSelection = { ...selection, bindings: [selection.bindings[0], { resource: { kind: 'contract' as const, id }, intentPair: current }, { resource: { kind: 'contract' as const, id: 'feature' }, intentPair: current }] }
  assert.deepEqual(selectedRetiredIds(currentSelection), [])
  const unrelated = { ...pair, id: 'unrelated-old-path', retiredIds: [...pair.retiredIds!, 'REQ-OTHER-01'] }
  const stillRetired = selectedRetiredIds({ ...currentSelection, bindings: [{ resource: { kind: 'path', path }, bytePair: unrelated }, ...currentSelection.bindings.slice(1)] })
  assert.deepEqual(stillRetired, ['REQ-OTHER-01'], 'A/node恢复不释放无关业务B的真实退役')
  const reusedB = await readFrozenContracts(f.root, new Map([[path, restored[0].source.replaceAll(id, 'REQ-OTHER-01')]]))
  assert.ok(validateContractEvolution(before, reusedB, { ...policy, retiredIds: stillRetired }).some(issue => issue.code === 'retired_id_reused' && issue.itemId === 'REQ-OTHER-01'))
  assert.deepEqual(pair.retiredIds, [id, 'feature'])
  writeFileSync(join(f.root, path), restored[0].source); writeFileSync(join(f.root, 'code.ts'), 'restored code\n'); f.git('add', '.'); f.git('commit', '-m', 'actual active object before move')
  const movedPath = '.spec/archive/feature/spec.md'
  mkdirSync(join(f.root, movedPath, '..'), { recursive: true }); renameSync(join(f.root, path), join(f.root, movedPath)); f.git('add', '.'); f.git('commit', '-m', 'move same active identity')
  const movedInput = await captureInputSnapshot(f.root), undoMove = prepareHistoryRequest(movedInput, { ...f.input, featureCommit: movedInput.headCommit })
  assert.deepEqual(readHistoryRestorations(movedInput, undoMove), [], '真实move中的全图现有身份不被误授restore')
})
