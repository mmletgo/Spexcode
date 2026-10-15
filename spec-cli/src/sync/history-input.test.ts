import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureInputSnapshot, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { prepareHistoryRequest, readHistoryRequest } from './history-input.js'

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
