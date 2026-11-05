import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contentHash, objectGit, readObject, readTree, writeObject, writeTree } from './snapshot.js'
import { importStageChanges, overlayStageTree, readStoppedPhysicalDraft, stageWorktree, verifyStageResult } from './stage-worktree.js'
import { nativeWorktreeResult } from '../native-worktree-runtime.js'
import { assertWorktreeSyncModel, DEFAULT_SYNC_MODEL, syncModel } from './model-selection.js'
import type { ElaborationSessionResult } from './elaboration-types.js'

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sync-stage-worktree-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'stage fixture'); git(root, 'config', 'user.email', 'stage@example.invalid')
  writeFileSync(join(root, 'source.mjs'), 'export const value = 1\n'); writeFileSync(join(root, 'oracle.test.mjs'), 'immutable oracle\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  return { root, commonDir: git(root, 'rev-parse', '--absolute-git-dir'), parent: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') }
}
function result(seed: ReturnType<typeof stageWorktree>, headCommit = seed.baseCommit, tree = seed.tree): ElaborationSessionResult {
  const output = { summary: '摘要声称的补丁不作为候选' }
  return { sessionId: 'session', threadId: 'thread', turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit, tree, worktreePath: '/historical/closed-worktree' } }
}

for (const kind of ['untracked', 'tracked', 'staged'] as const) test(`stopped physical draft只读保存工作区原bytes，不授clean交付 kind=${kind}`, t => {
  const f = fixture(t), ownerDigest = 'a'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{"type":"object"}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [{ path: path.replace('.json', '.schema.json'), source: schema }, { path: path.replace('.json', '.context.json'), source: '{"readonly":true}' }, ...(kind === 'tracked' ? [{ path, source: '{EARLIER' }] : [])]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit)
  const source = '{INVALID_JSON原文\n'; writeFileSync(join(f.root, path), source)
  if (kind === 'staged') { git(f.root, 'add', path); writeFileSync(join(f.root, path), source + '未暂存的最新正文') }
  const bytes = readFileSync(join(f.root, path)), index = readFileSync(join(f.root, '.git/index'))
  assert.throws(() => nativeWorktreeResult(f.root, seed), { code: 'native_worktree_result_invalid' })
  const material = readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding)!
  assert.equal(material.source, bytes.toString('utf8')); assert.equal(material.observedHeadCommit, seed.baseCommit)
  assert.equal(material.indexSha256, contentHash(index)); assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.deepEqual(readFileSync(join(f.root, path)), bytes); assert.equal(git(f.root, 'rev-parse', 'HEAD'), seed.baseCommit)
})

for (const defect of ['source', 'test', 'schema', 'context', 'absence', 'index', 'hidden-source', 'mode', 'symlink'] as const) test(`stopped physical draft不豁免其他文件/index对象与absence defect=${defect}`, t => {
  const f = fixture(t), ownerDigest = 'b'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [{ path: path.replace('.json', '.schema.json'), source: schema }, { path: path.replace('.json', '.context.json'), source: '{}' }]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit); writeFileSync(join(f.root, path), '{partial')
  const protectedPath = defect === 'test' ? 'oracle.test.mjs' : defect === 'schema' ? path.replace('.json', '.schema.json') : defect === 'context' ? path.replace('.json', '.context.json') : defect === 'absence' ? 'unexpected.test.mjs' : 'source.mjs'
  if (defect === 'mode') chmodSync(join(f.root, protectedPath), 0o755)
  else if (defect === 'symlink') { rmSync(join(f.root, path)); symlinkSync('source.mjs', join(f.root, path)) }
  else {
    const original = defect === 'index' ? readFileSync(join(f.root, protectedPath)) : undefined
    if (defect === 'hidden-source') git(f.root, 'update-index', '--assume-unchanged', protectedPath)
    writeFileSync(join(f.root, protectedPath), 'unauthorized')
    if (defect === 'index') { git(f.root, 'add', protectedPath); writeFileSync(join(f.root, protectedPath), original!) }
  }
  const index = readFileSync(join(f.root, '.git/index'))
  assert.throws(() => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), /越界变化/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
})

for (const mode of ['absent', 'seed-draft', 'hidden-source', 'index', 'ignored-draft', 'ignored-draft-symlink', 'parent-symlink', 'dirty-source', 'dirty-draft', 'committed-draft'] as const) test(`stopped worktree ignored-only no-material boundary: ${mode}`, t => {
  const f = fixture(t), ownerDigest = 'c'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{"type":"object"}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [
    { path: path.replace('.json', '.schema.json'), source: schema },
    { path: path.replace('.json', '.context.json'), source: '{"readonly":true}' },
    ...(mode === 'seed-draft' ? [{ path, source: '{"original":"immutable"}' }] : []),
  ]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit)
  writeFileSync(join(f.root, '.git/info/exclude'), `/runtime-cache/\n${mode.startsWith('ignored-draft') ? `/${path}\n` : mode === 'parent-symlink' ? '/.spex-sync-drafts\n' : ''}`)
  mkdirSync(join(f.root, 'runtime-cache'))
  writeFileSync(join(f.root, 'runtime-cache/retained'), 'ignored run cache')
  if (mode === 'hidden-source') git(f.root, 'update-index', '--assume-unchanged', 'source.mjs')
  if (mode === 'hidden-source' || mode === 'index' || mode === 'dirty-source') {
    writeFileSync(join(f.root, 'source.mjs'), 'unauthorized change\n')
    if (mode === 'index') { git(f.root, 'add', 'source.mjs'); writeFileSync(join(f.root, 'source.mjs'), 'export const value = 1\n') }
  }
  if (mode === 'ignored-draft' || mode === 'dirty-draft' || mode === 'committed-draft') writeFileSync(join(f.root, path), '{"unauthorized":"new"}')
  if (mode === 'ignored-draft-symlink') symlinkSync('../source.mjs', join(f.root, path))
  if (mode === 'parent-symlink') {
    git(f.root, 'update-index', '--assume-unchanged', path.replace('.json', '.schema.json'), path.replace('.json', '.context.json'))
    renameSync(join(f.root, '.spex-sync-drafts'), join(f.root, 'runtime-cache/drafts'))
    symlinkSync('runtime-cache/drafts', join(f.root, '.spex-sync-drafts'))
  }
  if (mode === 'committed-draft') { git(f.root, 'add', path); git(f.root, 'commit', '-m', 'real draft progress') }
  const ordinary = git(f.root, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  const strict = git(f.root, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored')
  const visibleChange = ['index', 'dirty-source', 'dirty-draft'].includes(mode)
  assert.equal(ordinary.length > 0, visibleChange)
  assert.equal(strict.split('\0').filter(Boolean).every(row => row.startsWith('!! ')), !visibleChange)
  const index = readFileSync(join(f.root, '.git/index'))
  const head = git(f.root, 'rev-parse', 'HEAD')
  if (mode === 'absent' || mode === 'seed-draft') assert.equal(readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), null)
  else assert.throws(() => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), /越界变化/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head)
})

test('精确阶段tree含受控raw/已审overlay并隔离后续index和WIP；同树同seed、异树不同身份', t => {
  const f = fixture(t), controlled = overlayStageTree(f.commonDir, f.tree, [{ path: 'spec.md', source: '真实受控raw\n' }])
  const seed = stageWorktree(f.commonDir, f.parent, controlled)
  writeFileSync(join(f.root, 'source.mjs'), 'later index\n'); git(f.root, 'add', 'source.mjs'); writeFileSync(join(f.root, 'source.mjs'), 'later WIP\n')
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.parent)
  assert.equal(git(f.root, 'show', `${seed.baseCommit}:spec.md`), '真实受控raw')
  assert.equal(git(f.root, 'show', `${seed.baseCommit}:source.mjs`), 'export const value = 1')
  assert.equal(git(f.root, 'show', '-s', '--format=%P', seed.baseCommit), f.parent)
  assert.equal(objectGit(f.commonDir, ['rev-parse', `refs/spex-sync/seeds/${seed.baseCommit}`]).toString().trim(), seed.baseCommit)
  assert.deepEqual(stageWorktree(f.commonDir, f.parent, controlled), seed)
  assert.notEqual(stageWorktree(f.commonDir, f.parent, f.tree).baseCommit, seed.baseCommit)
  assert.equal(verifyStageResult(f.commonDir, seed, result(seed)).tree, controlled)
})

test('actualdiff只从真实不可变对象导入；前摘要/mode取原树，冷恢复不要求历史WT存在', t => {
  const f = fixture(t), approved = overlayStageTree(f.commonDir, f.tree, [{ path: 'spec.md', source: '已审Spec\n' }]), seed = stageWorktree(f.commonDir, f.parent, approved, 'edit')
  const after = overlayStageTree(f.commonDir, approved, [{ path: 'source.mjs', source: 'export const value = 2\n' }])
  const head = stageWorktree(f.commonDir, seed.baseCommit, after).baseCommit, actual = result(seed, head, after)
  const imported = importStageChanges(f.commonDir, seed, actual, f.tree, [])
  const original = readTree(f.commonDir, f.tree).find(entry => entry.path === 'source.mjs')!
  assert.deepEqual(imported.changes, [{ path: 'source.mjs', beforeDigest: original.digest, beforeMode: original.mode, content: 'export const value = 2\n', mode: '100644' }])
  assert.equal(readObject(f.commonDir, readTree(f.commonDir, after).find(entry => entry.path === 'spec.md')!.oid).toString(), '已审Spec\n')
  assert.throws(() => importStageChanges(f.commonDir, seed, { ...actual, worktree: { ...actual.worktree!, baseTree: f.tree } }, f.tree, []), /固定seed/)
  assert.throws(() => importStageChanges(f.commonDir, seed, { ...actual, worktree: { ...actual.worktree!, tree: f.tree } }, f.tree, []), /真实HEAD tree/)
  assert.throws(() => verifyStageResult(f.commonDir, { ...seed, mode: 'read' }, actual), /只读阶段/)
})

test('真实diff的不可改oracle/host-private和非UTF8修改都拒绝', t => {
  const f = fixture(t), seed = stageWorktree(f.commonDir, f.parent, f.tree, 'edit')
  for (const path of ['oracle.test.mjs', '.env']) {
    const tree = overlayStageTree(f.commonDir, f.tree, [{ path, source: 'mutated\n' }]), head = stageWorktree(f.commonDir, seed.baseCommit, tree).baseCommit
    assert.throws(() => importStageChanges(f.commonDir, seed, result(seed, head, tree), f.tree, ['oracle.test.mjs']), /禁止路径/)
  }
  const entries = readTree(f.commonDir, f.tree).map(entry => entry.path === 'source.mjs' ? { ...entry, oid: writeObject(f.commonDir, Buffer.from([255, 254])), digest: contentHash(Buffer.from([255, 254])) } : entry)
  const binaryTree = writeTree(f.commonDir, entries), binaryHead = stageWorktree(f.commonDir, seed.baseCommit, binaryTree).baseCommit
  assert.throws(() => importStageChanges(f.commonDir, seed, result(seed, binaryHead, binaryTree), f.tree, []), /不是UTF8文本/)
})

test('新workflow明确选择真实CLI；旧缺省模型身份不变且不fallback', () => {
  assert.equal(syncModel({}), DEFAULT_SYNC_MODEL)
  assert.equal(syncModel({}, true), 'claude:default')
  assert.equal(syncModel({ model: 'zcode:team/model:preview' }, true), 'zcode:team/model:preview')
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:default'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('zcode:default'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:team/model:preview[1m]'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:MiniMax-M3.1-Flash'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('zcode:bigmodel-api/GLM-5.3-Flash'))
  assert.throws(() => assertWorktreeSyncModel(DEFAULT_SYNC_MODEL), { code: 'unsupported' })
})

test('native P1将已审祖先overlay和当前Spec候选分别绑定真实只读seed', async t => {
  const { cpSync, readFileSync } = await import('node:fs'), { captureInputSnapshot } = await import('./snapshot.js'), { elaborate, elaborationDigest } = await import('./elaboration.js'), { ELABORATION_BOUNDARIES } = await import('./elaboration-types.js'), { parseParts } = await import('@spexcode/spec-core/contracts')
  const f = fixture(t), path = '.spec/export/export-contract/spec.md'
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), f.root, { recursive: true })
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'business fixture')
  const snapshot = await captureInputSnapshot(f.root), source = readFileSync(join(f.root, path), 'utf8'), ancestor = '---\ntitle: 上层接口\n---\n## raw source\n已审祖先原意\n\n## expanded spec\n已审祖先接口\n', calls: { purpose: string; tree: string; source: string }[] = []
  const result = await elaborate({ root: f.root, base: snapshot.headCommit, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), historyInput: snapshot, requestKey: 'native-p1', intent: { nodeId: 'export-contract', rawSource: parseParts(source)!.rawSource! }, targets: [{ nodeId: 'export-contract', path, source, sourceDigest: elaborationDigest(source) }], context: [{ nodeId: 'ancestor', path: '.spec/ancestor/spec.md', source: ancestor }], files: new Map(), maxRepairs: 0, model: 'claude:MiniMax-M3.1-Flash' }, { runner: async request => {
    assert.ok(request.worktree); assert.equal(request.worktree.mode, 'read'); assert.doesNotMatch(request.prompt, /冻结业务输入|bodyRef|spex_read_frozen/)
    assert.equal(git(f.root, 'show', `${request.worktree.baseCommit}:.spec/ancestor/spec.md`), ancestor.trim())
    calls.push({ purpose: request.purpose, tree: request.worktree.tree, source: git(f.root, 'show', `${request.worktree.baseCommit}:${path}`) })
    const output = request.purpose === 'elaboration_generate' ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用已审导出契约边界', affectedIds: [] })) } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `p1-${calls.length}`, threadId: `p1-thread-${calls.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(result.reviewPassed, true, JSON.stringify({ failure: result.failure, rounds: result.rounds.map(round => round.findings) }))
  assert.deepEqual(calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal(calls[1].source, result.changes.find(change => change.path === path)!.source.trim())
})
