import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { deriveCrossFreezeProvenance } from './cross-freeze-provenance.js'
import { captureInputSnapshot, contentHash } from './snapshot.js'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-cross-freeze-')), root = join(directory, 'source')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const run = (cwd: string, args: string[], input?: string) => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args,
  ], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const git = (...args: string[]) => run(root, args)
  mkdirSync(root)
  git('init', '-q', '-b', 'main')
  git('config', 'core.fileMode', 'true')
  const write = (path: string, bytes: string | Buffer) => writeFileSync(join(root, path), bytes)
  const commit = () => { git('add', '-A'); return git('commit', '-qm', 'freeze', '--allow-empty') }
  const snapshot = (worktree = root) => captureInputSnapshot(worktree, { committed: true })
  write('owner.txt', 'stable partition read path\n')
  commit()
  return { directory, root, git, run, write, commit, snapshot }
}

test('captures complete changes outside the prior read set with exact paths, modes, object IDs and content', async t => {
  const f = fixture(t), unusual = '共享\t路径\n.txt'
  f.write(unusual, 'old shared behavior\n')
  f.write('removed.txt', 'removed behavior\n')
  f.write('executable.sh', '#!/bin/sh\n')
  f.commit()
  const previous = await captureInputSnapshot(f.root)
  f.write(unusual, 'changed shared behavior\n')
  f.write('added.txt', 'new global expectation\n')
  rmSync(join(f.root, 'removed.txt'))
  chmodSync(join(f.root, 'executable.sh'), 0o755)
  f.commit()
  const current = await f.snapshot()
  const provenance = deriveCrossFreezeProvenance(previous, current)
  assert.ok(provenance)
  assert.deepEqual(provenance.changes, [
    { path: 'added.txt', before: null, after: { mode: '100644', oid: f.git('rev-parse', 'HEAD:added.txt') } },
    { path: 'executable.sh', before: { mode: '100644', oid: f.git('rev-parse', 'HEAD:executable.sh') }, after: { mode: '100755', oid: f.git('rev-parse', 'HEAD:executable.sh') } },
    { path: 'removed.txt', before: { mode: '100644', oid: f.git('rev-parse', 'HEAD^:removed.txt') }, after: null },
    { path: unusual, before: { mode: '100644', oid: f.git('rev-parse', `HEAD^:${unusual}`) }, after: { mode: '100644', oid: f.git('rev-parse', `HEAD:${unusual}`) } },
  ])
  assert.match(provenance.patch, /-old shared behavior\n\+changed shared behavior/)
  assert.match(provenance.patch, /\+new global expectation/)
  assert.match(provenance.patch, /-removed behavior/)
  assert.match(provenance.patch, /old mode 100644\nnew mode 100755/)
  const { digest, ...body } = provenance
  assert.equal(digest, contentHash(JSON.stringify(body)))
  assert.deepEqual(provenance.previous, { inputId: previous.id, commit: previous.headCommit, tree: previous.immutableTree })
  assert.deepEqual(provenance.current, { inputId: current.id, commit: current.headCommit, tree: current.immutableTree })
  const review = join(f.directory, 'review')
  f.git('worktree', 'add', '--quiet', '--detach', review, previous.headCommit)
  f.run(review, ['apply', '--index', '-'], provenance.patch)
  assert.equal(f.run(review, ['write-tree']), current.immutableTree)
  f.write('owner.txt', 'later source state\n')
  f.commit()
  f.write('owner.txt', 'worktree state\n')
  assert.deepEqual(deriveCrossFreezeProvenance(previous, current), provenance)
})

test('requires two exact committed trees and a strict ancestor in the same canonical source', async t => {
  const f = fixture(t), previous = await f.snapshot()
  f.write('changed.txt', 'content\n')
  f.commit()
  const current = await f.snapshot()
  assert.equal(deriveCrossFreezeProvenance(current, previous), null)
  assert.equal(deriveCrossFreezeProvenance(current, current), null)
  assert.equal(deriveCrossFreezeProvenance(previous, { ...current, headCommit: 'HEAD' }), null)
  assert.equal(deriveCrossFreezeProvenance(previous, { ...current, immutableTree: previous.immutableTree, indexTree: previous.indexTree }), null)
  assert.throws(() => deriveCrossFreezeProvenance(previous, { ...current, id: 'f'.repeat(64) }), /快照身份摘要不匹配/)
  const clone = join(f.directory, 'clone'), linked = join(f.directory, 'linked')
  f.git('clone', '--quiet', f.root, clone)
  f.git('worktree', 'add', '-qb', 'linked', linked)
  assert.equal(deriveCrossFreezeProvenance(previous, await f.snapshot(clone)), null)
  assert.equal(deriveCrossFreezeProvenance(previous, await f.snapshot(linked)), null)
  f.git('checkout', '--orphan', 'unrelated')
  f.commit()
  f.git('checkout', 'main')
  f.git('reset', '--hard', 'unrelated')
  const disconnected = await f.snapshot()
  f.git('replace', '--graft', disconnected.headCommit, previous.headCommit)
  f.git('merge-base', '--is-ancestor', previous.headCommit, disconnected.headCommit)
  assert.equal(deriveCrossFreezeProvenance(previous, disconnected), null)
})

test('declines shallow history even when both commits are visible and declines local grafts', async t => {
  const f = fixture(t)
  f.commit()
  const previous = await f.snapshot()
  f.commit()
  const current = await f.snapshot()
  assert.ok(deriveCrossFreezeProvenance(previous, current))
  const shallow = join(f.directory, 'shallow')
  f.git('clone', '--quiet', '--no-local', '--depth=2', f.root, shallow)
  f.run(shallow, ['reset', '--hard', previous.headCommit])
  const shallowPrevious = await f.snapshot(shallow)
  f.run(shallow, ['reset', '--hard', current.headCommit])
  const shallowCurrent = await f.snapshot(shallow)
  f.run(shallow, ['merge-base', '--is-ancestor', shallowPrevious.headCommit, shallowCurrent.headCommit])
  assert.equal(deriveCrossFreezeProvenance(shallowPrevious, shallowCurrent), null)
  writeFileSync(join(current.source.commonDir, 'info', 'grafts'), `${current.headCommit} ${previous.headCommit}\n`)
  assert.equal(deriveCrossFreezeProvenance(previous, current), null)
})

test('retains binary delta bytes and declines evidence beyond the bound or with a private path', async t => {
  const f = fixture(t), previous = await f.snapshot()
  f.write('data.bin', Buffer.from([0, 255, 1, 2, 3]))
  f.commit()
  const binary = await f.snapshot()
  const evidence = deriveCrossFreezeProvenance(previous, binary)
  assert.ok(evidence)
  assert.match(evidence.patch, /GIT binary patch\nliteral 5/)
  assert.deepEqual(evidence.changes, [{ path: 'data.bin', before: null, after: { mode: '100644', oid: f.git('rev-parse', 'HEAD:data.bin') } }])
  f.write('large.txt', 'x'.repeat(1024 * 1024))
  f.commit()
  assert.equal(deriveCrossFreezeProvenance(binary, await f.snapshot()), null)
  f.git('reset', '--hard', binary.headCommit)
  f.write('.env', 'test fixture\n')
  f.commit()
  assert.equal(deriveCrossFreezeProvenance(binary, await f.snapshot()), null)
})

test('declines a plumbing-created empty directory even when the ordinary patch has file changes', async t => {
  const f = fixture(t), previous = await f.snapshot()
  const empty = f.run(f.root, ['mktree'], '')
  const changed = f.run(f.root, ['hash-object', '-w', '--stdin'], 'changed owner\n')
  const tree = f.run(f.root, ['mktree'], `040000 tree ${empty}\tempty\n100644 blob ${changed}\towner.txt\n`) // dead-words-ok: Git mktree record type.
  const commit = f.git('commit-tree', tree, '-p', previous.headCommit, '-m', 'empty directory')
  f.git('reset', '--hard', commit)
  assert.equal(deriveCrossFreezeProvenance(previous, await f.snapshot()), null)
})
