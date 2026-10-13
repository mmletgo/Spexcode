import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freezeCandidate } from './candidate.js'
import { readSyncFileDiff, SyncDiffReadError, type SyncDiffDetail } from './diff-read.js'
import { prepareControlledRequest } from './request-input.js'
import { captureInputSnapshot, readTree } from './snapshot.js'

async function fixture(t: test.TestContext): Promise<{ root: string; detail: SyncDiffDetail }> {
  const root = mkdtempSync(join(tmpdir(), 'spex-sync-diff-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim()
  git('init', '-b', 'main'); git('config', 'user.email', 'diff@example.invalid'); git('config', 'user.name', 'diff test')
  mkdirSync(join(root, 'test')); writeFileSync(join(root, 'test/a [one].test.ts'), 'base\n'); writeFileSync(join(root, 'unchanged'), 'keep\n')
  mkdirSync(join(root, '.spec/fixture/intent'), { recursive: true })
  writeFileSync(join(root, '.spec/fixture/intent/spec.md'), '---\ntitle: intent\n---\n# Intent\nOriginal requirement.\n')
  git('add', '.'); git('commit', '-m', 'base')
  writeFileSync(join(root, 'author.ts'), 'author input\n')
  const input = await captureInputSnapshot(root), before = readTree(input.source.commonDir, input.immutableTree).find(entry => entry.path === 'test/a [one].test.ts')!
  const candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [
    { path: before.path, beforeDigest: before.digest, beforeMode: before.mode, content: 'generated test\n' },
    { path: '.env', beforeDigest: null, beforeMode: null, content: 'private\n' },
    { path: 'big.ts', beforeDigest: null, beforeMode: null, content: 'x'.repeat(2 * 1024 * 1024) },
  ] }, { paths: ['test', '.env', 'big.ts'], contractIds: [], flowIds: [] })
  return { root, detail: { operation: { input, deliveryPlan: { baseCommit: input.headCommit, branch: 'delivery', canonicalRoot: join(root, 'delivery') } }, attempt: { candidate }, journals: [] } }
}

test('真实固定Git差异包含测试文件并区分作者输入；literal路径和只读属性', async t => {
  const { root, detail } = await fixture(t), index = readFileSync(join(root, '.git/index'))
  const result = readSyncFileDiff(detail, 'test/a [one].test.ts', 'candidate')
  assert.match(result.patch, /\+generated test/); assert.match(result.patch, /-base/); assert.equal(result.delivered, false)
  assert.match(readSyncFileDiff(detail, 'author.ts').patch, /\+author input/)
  assert.throws(() => readSyncFileDiff(detail, 'author.ts', 'candidate'), { status: 404 })
  writeFileSync(join(root, 'test/a [one].test.ts'), 'changed after freeze\n')
  assert.equal(readSyncFileDiff(detail, 'test/a [one].test.ts', 'candidate').patch, result.patch)
  assert.deepEqual(readFileSync(join(root, '.git/index')), index)
  assert.equal(readFileSync(join(root, 'test/a [one].test.ts'), 'utf8'), 'changed after freeze\n')
})

test('拒绝操作外路径、认证文件、路径表达式、未知类型、损坏候选和超大差异', async t => {
  const { detail } = await fixture(t)
  for (const path of ['unchanged', '.env', 'test/*.test.ts']) assert.throws(() => readSyncFileDiff(detail, path), { status: 404 })
  for (const path of ['../x', '/tmp/x', '.git/config', '']) assert.throws(() => readSyncFileDiff(detail, path), { status: 400 })
  assert.throws(() => readSyncFileDiff(detail, 'author.ts', 'bogus'), { status: 400 })
  assert.throws(() => readSyncFileDiff(detail, 'big.ts'), { status: 413 })
  assert.throws(() => readSyncFileDiff({ ...detail, attempt: null }, 'author.ts'), SyncDiffReadError)
  assert.throws(() => readSyncFileDiff({ ...detail, attempt: { candidate: { ...detail.attempt!.candidate!, digest: '0'.repeat(64) } } }, 'author.ts'), /摘要/)
})

test('候选尚未生成时完整展示用户请求，来源删除后历史请求仍可读且不冒充已交付', async t => {
  const { root, detail } = await fixture(t), path = '.spec/fixture/intent/spec.md'
  const source = readFileSync(join(root, path), 'utf8'), next = source.replace('Original requirement.', 'Require cancellation before publication.')
  const request = prepareControlledRequest(detail.operation.input, { path, source, next, changed: true, startLine: 2, endLine: 2 }, { kind: 'user_edit', requestId: 'request-diff', nodeId: 'intent', intent: 'Update cancellation rule' })
  assert.equal(request.changed, true)
  const pending: SyncDiffDetail = { ...detail, operation: { ...detail.operation, requestBlob: request.requestBlob! }, attempt: null }
  const index = readFileSync(join(root, '.git/index')), result = readSyncFileDiff(pending, path, 'request')
  assert.match(result.patch, /-Original requirement\./); assert.match(result.patch, /\+Require cancellation before publication\./)
  assert.equal(result.kind, 'request'); assert.equal(result.delivered, false)
  assert.equal(readFileSync(join(root, path), 'utf8'), source)
  rmSync(join(root, path))
  assert.equal(readSyncFileDiff(pending, path, 'request').patch, result.patch)
  assert.deepEqual(readFileSync(join(root, '.git/index')), index)
  assert.throws(() => readSyncFileDiff(pending, 'author.ts', 'request'), { status: 404 })
  assert.throws(() => readSyncFileDiff(detail, path, 'request'), { status: 404 })
})
