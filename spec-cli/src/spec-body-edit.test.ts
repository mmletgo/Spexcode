import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { specContent } from '@spexcode/spec-core'
import { editSpecBody, prepareSpecBodyEdit, readSpecBodyEdit, SpecBodyEditError } from './spec-body-edit.js'

// Every refusal below happens BEFORE a byte is written, which is why these can run against the live spec
// tree: the point of the endpoint's preconditions is that a request that cannot be honoured never touches
// the file. The write half is proved through the product, where a commit is the evidence.

const NODE = 'spec-body-edit'

test('a request without an honest line range or both texts is refused before anything is read', () => {
  const bad = [
    {},
    { startLine: 0, endLine: 3, original: '', replacement: '' },
    { startLine: 4, endLine: 3, original: '', replacement: '' },
    { startLine: 1.5, endLine: 3, original: '', replacement: '' },
  ]
  for (const body of bad) assert.throws(() => readSpecBodyEdit(body), SpecBodyEditError)
  assert.throws(() => readSpecBodyEdit({ startLine: 1, endLine: 2, original: 'x' }), /original, replacement/)
  assert.throws(() => readSpecBodyEdit({ startLine: 1, endLine: 2, replacement: 'x' }), /original, replacement/)
  assert.deepEqual(readSpecBodyEdit({ startLine: 1, endLine: 2, original: 'a', replacement: 'b', reason: '  why  ' }),
    { startLine: 1, endLine: 2, original: 'a', replacement: 'b', reason: 'why' })
  // an empty reason is no reason, not an empty line in the commit message
  assert.deepEqual(readSpecBodyEdit({ startLine: 1, endLine: 1, original: 'a', replacement: 'b', reason: '   ' }),
    { startLine: 1, endLine: 1, original: 'a', replacement: 'b' })
})

test('an id that is not a node has no body to edit', async () => {
  await assert.rejects(
    editSpecBody('no-such-node-at-all', { startLine: 1, endLine: 1, original: '', replacement: 'x' }),
    (e: unknown) => e instanceof SpecBodyEditError && e.status === 404 && e.code === 'no-node',
  )
})

test('a region whose text no longer matches is a refusal that reports what is actually there', async () => {
  const content = specContent(NODE)
  assert.ok(content, `${NODE} must be a real node for this test to mean anything`)
  await assert.rejects(
    editSpecBody(NODE, { startLine: 1, endLine: 1, original: 'this is not what line 1 says', replacement: 'x' }),
    (e: unknown) => {
      assert.ok(e instanceof SpecBodyEditError)
      assert.equal(e.status, 409)
      assert.equal(e.code, 'stale-region')
      // the collision is legible: the caller gets the line it collided with, not just a verdict
      assert.equal(e.detail?.current, content!.body.split('\n')[0])
      return true
    },
  )
})

test('a range that runs past the end of the body is refused, never clamped', async () => {
  const content = specContent(NODE)
  assert.ok(content)
  const lines = content!.body.split('\n').length
  await assert.rejects(
    editSpecBody(NODE, { startLine: lines, endLine: lines + 5, original: '', replacement: 'x' }),
    (e: unknown) => e instanceof SpecBodyEditError && e.status === 409 && e.code === 'stale-region'
      && e.detail?.bodyLines === lines,
  )
})

test('replacing a region with the identical text writes nothing and commits nothing', async () => {
  const content = specContent(NODE)
  assert.ok(content)
  const first = content!.body.split('\n')[0]
  const result = await editSpecBody(NODE, { startLine: 1, endLine: 1, original: first, replacement: first })
  assert.equal(result.changed, false)
  assert.equal(result.commit, null)
  assert.match(result.path, /^\.spec\/.*\/spec\.md$/)
})


const preparationPath = '.spec/product/body-node/spec.md'
const fixtureSource = (title: string): string => `---\ntitle: fixture\nstatus: active\n---\n\n  # ${title}\n\n## raw source\n\nOriginal text.\n\n## expanded spec\n\nExpanded text.\n  \n`
function preparationWorktrees(t: { after: (callback: () => void) => void }): { root: string; other: string; source: string; otherSource: string } {
  const directory = mkdtempSync(join(tmpdir(), 'spex-body-prepare-'))
  const root = join(directory, 'main')
  const other = join(directory, 'other')
  mkdirSync(join(root, '.spec/product/body-node'), { recursive: true })
  const source = fixtureSource('Main text')
  const otherSource = fixtureSource('Other text')
  writeFileSync(join(root, preparationPath), source)
  const git = (...argv: string[]): void => { execFileSync('git', ['-C', root, ...argv], { stdio: 'pipe' }) }
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  git('add', '.')
  git('commit', '-m', 'fixture')
  git('worktree', 'add', '-b', 'other', other)
  writeFileSync(join(other, preparationPath), otherSource)
  execFileSync('git', ['-C', other, 'add', '--', preparationPath])
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { root, other, source, otherSource }
}
function preparationGitState(root: string): { head: string; index: Buffer; diff: string; staged: string } {
  const git = (...argv: string[]): string => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8' })
  const indexPath = git('rev-parse', '--git-path', 'index').trim()
  return { head: git('rev-parse', 'HEAD'), index: readFileSync(isAbsolute(indexPath) ? indexPath : join(root, indexPath)), diff: git('diff', '--no-ext-diff'), staged: git('diff', '--cached', '--no-ext-diff') }
}

test('prepare 用显式 root 隔离同 ID 的两个真实 worktree，保留完整 prefix/suffix 且不改文件/index/HEAD', async t => {
  const fixture = preparationWorktrees(t)
  const beforeMain = preparationGitState(fixture.root)
  const beforeOther = preparationGitState(fixture.other)
  const [main, other] = await Promise.all([
    prepareSpecBodyEdit(fixture.root, 'body-node', { startLine: 1, endLine: 1, original: '# Main text', replacement: '# Main changed\nSecond line' }),
    prepareSpecBodyEdit(fixture.other, 'body-node', { startLine: 1, endLine: 1, original: '# Other text', replacement: '# Other changed' }),
  ])
  assert.deepEqual(main, { path: preparationPath, source: fixture.source, next: fixture.source.replace('# Main text', '# Main changed\nSecond line'), changed: true, startLine: 1, endLine: 2 })
  assert.equal(other.source, fixture.otherSource)
  assert.equal(other.next, fixture.otherSource.replace('# Other text', '# Other changed'))
  assert.equal(readFileSync(join(fixture.root, preparationPath), 'utf8'), fixture.source)
  assert.equal(readFileSync(join(fixture.other, preparationPath), 'utf8'), fixture.otherSource)
  assert.deepEqual(preparationGitState(fixture.root), beforeMain)
  assert.deepEqual(preparationGitState(fixture.other), beforeOther)
})

test('prepare 在对应 root 核对原文及过期范围，拒绝后所有 Git 和文件状态原样', async t => {
  const fixture = preparationWorktrees(t)
  const before = preparationGitState(fixture.other)
  await assert.rejects(prepareSpecBodyEdit(fixture.other, 'body-node', { startLine: 1, endLine: 1, original: '# Main text', replacement: 'wrong root' }), (error: unknown) => {
    assert.ok(error instanceof SpecBodyEditError)
    assert.equal(error.code, 'stale-region')
    assert.equal(error.detail?.current, '# Other text')
    return true
  })
  await assert.rejects(prepareSpecBodyEdit(fixture.other, 'body-node', { startLine: 1, endLine: 999, original: '', replacement: 'past end' }), (error: unknown) => error instanceof SpecBodyEditError && error.code === 'stale-region')
  await assert.rejects(prepareSpecBodyEdit(fixture.other, 'missing-node', { startLine: 1, endLine: 1, original: '', replacement: 'missing' }), (error: unknown) => error instanceof SpecBodyEditError && error.code === 'no-node')
  assert.deepEqual(preparationGitState(fixture.other), before)
  assert.equal(readFileSync(join(fixture.other, preparationPath), 'utf8'), fixture.otherSource)
})

test('prepare 相同文字明确 no-op，即使目标有 staged change 也只准备不提交', async t => {
  const fixture = preparationWorktrees(t)
  const before = preparationGitState(fixture.other)
  const result = await prepareSpecBodyEdit(fixture.other, 'body-node', { startLine: 1, endLine: 1, original: '# Other text', replacement: '# Other text' })
  assert.equal(result.changed, false)
  assert.equal(result.source, result.next)
  assert.deepEqual(preparationGitState(fixture.other), before)
})


function runFixtureBodyEdit(root: string): { ok?: boolean; changed?: boolean; commit?: string; code?: string; message?: string } {
  const script = `import { editSpecBody } from ${JSON.stringify(new URL('./spec-body-edit.ts', import.meta.url).href)};
    try { console.log(JSON.stringify(await editSpecBody('body-node', {startLine:1,endLine:1,original:'# Main text',replacement:'# Committed text'}))); }
    catch (error) { console.log(JSON.stringify({code:error.code,message:error.message})); }`
  return JSON.parse(execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8' }))
}

test('纯 Spec 编辑仍真实提交目标文件、保留其他 staged 内容并执行 hook', t => {
  const fixture = preparationWorktrees(t)
  const marker = join(fixture.root, '.git/hook-ran')
  const hook = join(fixture.root, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\n[ "$SPEXCODE_ALLOW_MAIN" = "1" ] || exit 1\nprintf called > "$(git rev-parse --git-dir)/hook-ran"\n')
  chmodSync(hook, 0o755)
  writeFileSync(join(fixture.root, 'other.txt'), 'unrelated staged work')
  execFileSync('git', ['-C', fixture.root, 'add', '--', 'other.txt'])
  const result = runFixtureBodyEdit(fixture.root)
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.match(result.commit!, /^[a-f0-9]{40}$/)
  assert.equal(readFileSync(marker, 'utf8'), 'called')
  assert.equal(readFileSync(join(fixture.root, preparationPath), 'utf8'), fixture.source.replace('# Main text', '# Committed text'))
  const committedPaths = execFileSync('git', ['-C', fixture.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(committedPaths, preparationPath)
  assert.equal(execFileSync('git', ['-C', fixture.root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim(), 'other.txt')
  assert.match(execFileSync('git', ['-C', fixture.root, 'log', '-1', '--format=%B'], { encoding: 'utf8' }), /Session: human/)
})

test('纯 Spec 提交被 hook 拒绝仍恢复原文与 index、HEAD，返回真实拒绝原因', t => {
  const fixture = preparationWorktrees(t)
  const before = preparationGitState(fixture.root)
  const hook = join(fixture.root, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nprintf "fixture policy refusal\\n" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const result = runFixtureBodyEdit(fixture.root)
  assert.equal(result.code, 'commit-refused')
  assert.match(result.message!, /fixture policy refusal/)
  assert.equal(readFileSync(join(fixture.root, preparationPath), 'utf8'), fixture.source)
  const after = preparationGitState(fixture.root)
  assert.equal(after.head, before.head)
  assert.equal(after.diff, before.diff)
  assert.equal(after.staged, before.staged)
})
