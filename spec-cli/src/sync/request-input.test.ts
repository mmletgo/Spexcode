import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openProtocol } from '@spexcode/session-protocol'
import { prepareSpecBodyEdit } from '../spec-body-edit.js'
import { composeInputSnapshots } from './composition.js'
import { migrateSyncStore } from './migrations.js'
import type { AdmitSyncInput, BaselinePair, BlobRef, ComposedInputRef, InputSnapshot } from './operation-types.js'
import { composeControlledRequest, guardControlledRequestPath, prepareControlledRequest, prepareControlledDecision, readControlledDecision, validateControlledRequest } from './request-input.js'
import { captureInputSnapshot, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { SyncStore } from './store.js'

const path = '.spec/product/body-node/spec.md'
const source = '---\ntitle: Fixture\nstatus: active\n---\n\n# Product\n\n## raw source\n\nUser rule.\n\nSeparate paragraph.\n\nAnother paragraph.\n\n## expanded spec\n\nOriginal expansion.\n'
const origin = { kind: 'user_edit' as const, requestId: 'user-request-1', nodeId: 'body-node', intent: '修改用户原始规则' }
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim()
function fixture(t: test.TestContext): { directory: string; root: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sync-request-')), root = join(directory, 'source')
  mkdirSync(join(root, '.spec/product/body-node'), { recursive: true })
  writeFileSync(join(root, path), source)
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'request@example.invalid'); git(root, 'config', 'user.name', 'request fixture')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, root }
}
const state = (root: string): object => ({ source: readFileSync(join(root, path)), index: readFileSync(join(root, '.git/index')), head: git(root, 'rev-parse', 'HEAD'), staged: git(root, 'diff', '--cached'), diff: git(root, 'diff') })
async function prepare(snapshot: InputSnapshot, replacement = 'Next user rule.', original = 'User rule.') {
  guardControlledRequestPath(snapshot, path)
  const prepared = await prepareSpecBodyEdit(snapshot.source.canonicalRoot, 'body-node', { startLine: 5, endLine: 5, original, replacement })
  return { prepared, result: prepareControlledRequest(snapshot, prepared, origin) }
}
function requestRef(result: Awaited<ReturnType<typeof prepare>>): BlobRef {
  assert.equal(result.result.changed, true)
  assert.ok(result.result.requestBlob)
  return result.result.requestBlob
}
const content = (snapshot: InputSnapshot, composed: ComposedInputRef, file = path): string => readObject(snapshot.source.commonDir, readTree(snapshot.source.commonDir, composed.tree).find(entry => entry.path === file)!.oid).toString('utf8')
async function priorComposition(snapshot: InputSnapshot, directory: string, text: string): Promise<ComposedInputRef> {
  const deliveryRoot = join(directory, 'delivery')
  git(snapshot.source.canonicalRoot, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD')
  writeFileSync(join(deliveryRoot, path), text)
  writeFileSync(join(deliveryRoot, 'generated.ts'), 'agent generated\n')
  const verifiedDelivery = await captureInputSnapshot(deliveryRoot)
  const pair: BaselinePair = { id: 'prior-pair', repositoryId: snapshot.source.repositoryId, source: snapshot.source, sourceInput: snapshot, verifiedDelivery, receiptId: 'prior-verified-receipt', settledAtMs: 1, coveredScope: { paths: [path, 'generated.ts'], contractIds: ['body-node'], flowIds: [] } }
  const composed = composeInputSnapshots(snapshot, pair).composed
  assert.ok(composed)
  return composed
}

test('真实准备/验证/组合保留 source/index/HEAD，两个编辑独立且 no-op 不产请求', async t => {
  const { root } = fixture(t), snapshot = await captureInputSnapshot(root), before = state(root)
  const first = requestRef(await prepare(snapshot)), second = requestRef(await prepare(snapshot, 'Other user rule.'))
  const request = validateControlledRequest(snapshot, first)
  assert.equal(request.inputId, snapshot.id); assert.equal(request.origin.nodeId, 'body-node')
  assert.equal(readObject(snapshot.source.commonDir, request.before.oid).toString(), source)
  assert.equal(readObject(snapshot.source.commonDir, request.next.oid).toString(), source.replace('User rule.', 'Next user rule.'))
  const base = composeInputSnapshots(snapshot).composed!
  const a = composeControlledRequest(snapshot, base, first).composed!, b = composeControlledRequest(snapshot, base, second).composed!
  assert.notEqual(first.sha256, second.sha256); assert.notEqual(a.tree, b.tree)
  assert.equal(content(snapshot, a), source.replace('User rule.', 'Next user rule.'))
  assert.equal(content(snapshot, b), source.replace('User rule.', 'Other user rule.'))
  assert.deepEqual(composeControlledRequest(snapshot, a, first).composed, a)
  assert.throws(() => composeControlledRequest(snapshot, a, second), /另一受控请求/)
  assert.deepEqual((await prepare(snapshot, 'User rule.')).result, { changed: false, requestBlob: null })
  assert.equal(git(root, 'rev-parse', `refs/spex-sync/requests/${first.sha256}`), request.requestTree)
  git(root, 'gc', '--prune=now')
  assert.equal(validateControlledRequest(snapshot, first).next.oid, request.next.oid)
  assert.deepEqual(state(root), before)
})

test('用户 raw 差量叠加 prior delivery，expanded 与独立生成文件仍保留', async t => {
  const { root, directory } = fixture(t), snapshot = await captureInputSnapshot(root), before = state(root)
  const prior = await priorComposition(snapshot, directory, source.replace('Original expansion.', 'Agent expanded details.'))
  const result = composeControlledRequest(snapshot, prior, requestRef(await prepare(snapshot)))
  assert.deepEqual(result.conflicts, []); assert.ok(result.composed)
  assert.equal(content(snapshot, result.composed), source.replace('Original expansion.', 'Agent expanded details.').replace('User rule.', 'Next user rule.'))
  assert.equal(content(snapshot, result.composed, 'generated.ts'), 'agent generated\n')
  assert.equal(result.composed.sourceInputId, snapshot.id); assert.equal(result.composed.previousBaselinePairId, 'prior-pair')
  assert.deepEqual(state(root), before)
})

test('重叠用户与 Agent 编辑返回真实三方证据，不生成接受结果', async t => {
  const { root, directory } = fixture(t), snapshot = await captureInputSnapshot(root)
  const prior = await priorComposition(snapshot, directory, source.replace('User rule.', 'Agent rule.'))
  const ref = requestRef(await prepare(snapshot)), result = composeControlledRequest(snapshot, prior, ref)
  assert.equal(result.composed, null); assert.equal(result.conflicts.length, 1)
  const conflict = result.conflicts[0]
  assert.equal(conflict.path, path)
  for (const [side, rule] of [['base', 'User rule.'], ['source', 'Next user rule.'], ['delivery', 'Agent rule.']] as const) {
    assert.ok(conflict[side]); assert.match(readObject(snapshot.source.commonDir, conflict[side]!.oid).toString(), new RegExp(rule))
  }
})

test('已知路径 guard 在旧 prepare 前拒文件/父 symlink、非 Spec 路径与错误物理 root', async t => {
  const { root, directory } = fixture(t), snapshot = await captureInputSnapshot(root), outside = join(directory, 'outside')
  writeFileSync(outside, 'outside bytes must not be read')
  rmSync(join(root, path)); symlinkSync(outside, join(root, path))
  assert.throws(() => guardControlledRequestPath(snapshot, path), /symlink/)
  rmSync(join(root, '.spec/product/body-node'), { recursive: true }); symlinkSync(directory, join(root, '.spec/product/body-node'))
  assert.throws(() => guardControlledRequestPath(snapshot, path), /symlink/)
  for (const unsafe of ['../outside', '.git/config', 'file.ts']) assert.throws(() => guardControlledRequestPath(snapshot, unsafe), /路径|正文/)
  assert.throws(() => guardControlledRequestPath({ ...snapshot, source: { ...snapshot.source, physicalFingerprint: 'different' } }, path), /物理身份/)
  assert.equal(readFileSync(outside, 'utf8'), 'outside bytes must not be read')
})

test('原文/frontmatter/request hash/input/next/tree/manifest 错误均拒绝，新 source 不重放旧请求', async t => {
  const { root } = fixture(t), snapshot = await captureInputSnapshot(root), prepared = await prepare(snapshot), ref = requestRef(prepared)
  assert.throws(() => prepareControlledRequest(snapshot, { ...prepared.prepared, source: source.replace('User rule.', 'Stale rule.') }, origin), /原 bytes/)
  assert.throws(() => prepareControlledRequest(snapshot, { ...prepared.prepared, next: prepared.prepared.next.replace('title: Fixture', 'title: Edited') }, origin), /frontmatter/)
  assert.throws(() => validateControlledRequest(snapshot, { sha256: '0'.repeat(64) }), /blob|证据/)
  const request = validateControlledRequest(snapshot, ref), commonDir = snapshot.source.commonDir
  assert.throws(() => validateControlledRequest(snapshot, writeEvidence(commonDir, { ...request, inputId: 'other' })), /input/)
  assert.throws(() => validateControlledRequest(snapshot, writeEvidence(commonDir, { ...request, next: { ...request.next, digest: '0'.repeat(64) } })), /next digest/)
  assert.throws(() => validateControlledRequest(snapshot, writeEvidence(commonDir, { ...request, requestTree: snapshot.immutableTree })), /requestTree/)
  const composed = composeInputSnapshots(snapshot).composed!
  assert.throws(() => composeControlledRequest(snapshot, { ...composed, manifestBlob: writeEvidence(commonDir, { version: 1, entries: [] }) }, ref), /manifest/)
  writeFileSync(join(root, path), source.replace('User rule.', 'Actually saved rule.'))
  const nextSnapshot = await captureInputSnapshot(root)
  assert.notEqual(nextSnapshot.id, snapshot.id)
  assert.throws(() => validateControlledRequest(nextSnapshot, ref), /input/)
})

test('请求 evidence 真实被篡改时 SHA256 拒绝，未把错误正文解释为新请求', async t => {
  const { root } = fixture(t), snapshot = await captureInputSnapshot(root), ref = requestRef(await prepare(snapshot))
  const evidencePath = join(snapshot.source.commonDir, 'spexcode', 'evidence', ref.sha256)
  const original = readFileSync(evidencePath)
  writeFileSync(evidencePath, Buffer.concat([original, Buffer.from('\n')]))
  assert.throws(() => validateControlledRequest(snapshot, ref), /摘要|hash/)
  writeFileSync(evidencePath, original)
  assert.equal(validateControlledRequest(snapshot, ref).inputId, snapshot.id)
})

test('真实 SQLite 拒 operation/composed 请求错绑并在重启后保留正确绑定', async t => {
  const { root, directory } = fixture(t), snapshot = await captureInputSnapshot(root)
  const first = requestRef(await prepare(snapshot)), second = requestRef(await prepare(snapshot, 'Other user rule.'))
  const base = composeInputSnapshots(snapshot).composed!, composed = composeControlledRequest(snapshot, base, first).composed!
  const db = join(directory, 'sync.sqlite'), protocol = openProtocol(db)
  await migrateSyncStore(protocol)
  const options = { readBlob: (ref: BlobRef) => readEvidence(snapshot.source.commonDir, ref) }, store = new SyncStore(protocol, options)
  const input: AdmitSyncInput = { input: snapshot, requestBlob: first, ingressKey: 'request-1', rootCauseId: 'user-1', origin: 'spec', scope: { paths: [path], contractIds: ['body-node'], flowIds: [] }, budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 100000 }, policyDigest: 'policy', impactDigest: 'impact', readSetDigest: 'readset', delivery: null, deliveryPlan: { canonicalRoot: root, branch: snapshot.source.branch, baseCommit: snapshot.headCommit } }
  try {
    const op = store.admitAndEnqueue(input), claimed = store.claimAttempt({ operationId: op.id, source: snapshot.source, scope: input.scope, leaseMs: 100000, expectedMessageId: op.dispatchMessageId })
    assert.throws(() => store.bindComposedInput(claimed.fence, base), /SYNC_COMPOSITION_BINDING/)
    assert.throws(() => store.bindComposedInput(claimed.fence, { ...composed, requestBlob: second }), /SYNC_COMPOSITION_BINDING/)
    store.bindComposedInput(claimed.fence, composed)
    assert.ok(store.pinnedBlobRefs().some(ref => ref.sha256 === first.sha256))
    const reopened = openProtocol(db)
    try { assert.deepEqual(new SyncStore(reopened, options).readAttempt(claimed.attempt.id).composedInput, composed) } finally { reopened.close() }
    store.requestControl(op.id, 'cancel')
    const requestless = store.admitAndEnqueue({ ...input, ingressKey: 'requestless', requestBlob: undefined })
    const automatic = store.claimAttempt({ operationId: requestless.id, source: snapshot.source, scope: input.scope, leaseMs: 100000 })
    assert.throws(() => store.bindComposedInput(automatic.fence, composed), /SYNC_COMPOSITION_BINDING/)
    store.bindComposedInput(automatic.fence, base)
  } finally { protocol.close() }
})


test('业务裁决无正文差量仍冻结请求，只绑定所选分析与当前输入', async t => {
  const { root } = fixture(t), snapshot = await captureInputSnapshot(root), before = state(root)
  const input = { requestId: 'decision-1', operationId: 'original-op', inputId: snapshot.id, analysisRef: { sha256: 'a'.repeat(64) }, findingIds: ['finding-1'], decision: { choice: 'keep_intent' as const } }
  const ref = prepareControlledDecision(snapshot, input)
  assert.deepEqual(readControlledDecision(snapshot, ref), { ...input, schemaVersion: 1, type: 'sync.decision', source: snapshot.source })
  assert.deepEqual(ref, prepareControlledDecision(snapshot, input))
  const composed = (await composeInputSnapshots(snapshot)).composed!
  const result = composeControlledRequest(snapshot, composed, ref)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.composed, { ...composed, requestBlob: ref })
  assert.deepEqual(state(root), before)
  assert.throws(() => readControlledDecision({ ...snapshot, id: 'stale' }, ref), /input/)
  assert.throws(() => prepareControlledDecision(snapshot, { ...input, findingIds: [] }), /分歧/)
  assert.throws(() => prepareControlledDecision(snapshot, { ...input, findingIds: ['finding-1', 'finding-1'] }), /分歧/)
  assert.throws(() => prepareControlledDecision(snapshot, { ...input, decision: { choice: 'new_rule', rule: ' ' } }), /新规则/)
  const next = prepareControlledDecision(snapshot, { ...input, decision: { choice: 'new_rule', rule: '明确采用新的限制。' } })
  assert.notEqual(next.sha256, ref.sha256)
  assert.equal(readControlledDecision(snapshot, next).decision.choice, 'new_rule')
})


test('裁决继承原受控正文差量，不丢尚未落地的用户需求', async t => {
  const { root } = fixture(t), snapshot = await captureInputSnapshot(root), patchRef = requestRef(await prepare(snapshot))
  const decision = prepareControlledDecision(snapshot, { requestId: 'decision-patch', operationId: 'combined-op', inputId: snapshot.id, analysisRef: { sha256: 'b'.repeat(64) }, findingIds: ['conflict-1'], decision: { choice: 'keep_intent' } }, patchRef)
  const composed = composeInputSnapshots(snapshot).composed!
  const result = composeControlledRequest(snapshot, composed, decision)
  assert.ok(result.composed)
  assert.match(content(snapshot, result.composed), /Next user rule/)
  assert.equal(result.composed.requestBlob?.sha256, decision.sha256)
  assert.deepEqual(composeControlledRequest(snapshot, result.composed, decision).composed, result.composed)
  assert.throws(() => prepareControlledDecision(snapshot, readControlledDecision(snapshot, decision), decision), /来源绑定|来源|before/)
})
