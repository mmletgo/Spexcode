import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalContractFilterBindings, plantContractFilter } from '../contract-filter.js'
import { writeManagedBlock } from '../harness-shim.js'
import { composeAuthoredInput } from './author-input.js'
import { composeInputSnapshots } from './composition.js'
import { captureInputSnapshot, readEvidence, readObject, readTree } from './snapshot.js'
import type { BaselinePair, ComposedInputRef, InputSnapshot } from './operation-types.js'

function fixture(t: test.TestContext, filtered = true) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-author-input-')), root = join(directory, 'source')
  mkdirSync(root); t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Author fixture'); git('config', 'user.email', 'author@example.invalid')
  writeFileSync(join(root, 'AGENTS.md'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  git('add', '.'); git('commit', '-m', 'author seed')
  if (filtered) plantContractFilter(root, [{ file: 'AGENTS.md', content: 'managed context' }], canonicalContractFilterBindings(root))
  return { directory, root, git }
}
function text(snapshot: InputSnapshot, composed: ComposedInputRef, path = 'AGENTS.md'): string {
  const entry = readTree(snapshot.source.commonDir, composed.tree).find(entry => entry.path === path)!
  return readObject(snapshot.source.commonDir, entry.oid).toString()
}

test('canonical author projection preserves exact tails and source/index while physical snapshot retains managed bytes', async t => {
  const f = fixture(t), originalIndex = readFileSync(join(f.root, '.git/index'))
  for (const author of ['', '作者无末尾换行', '作者\n', '\n作者\n\n', '作者\n\n中段\n']) {
    writeFileSync(join(f.root, 'AGENTS.md'), author); writeManagedBlock(join(f.root, 'AGENTS.md'), 'managed generated context')
    const snapshot = await captureInputSnapshot(f.root), physical = readFileSync(join(f.root, 'AGENTS.md'))
    const ordinary = composeInputSnapshots(snapshot).composed!, result = composeAuthoredInput(snapshot).composed!
    assert.match(text(snapshot, ordinary), /spexcode:start/)
    assert.equal(text(snapshot, result), author)
    assert.equal(result.sourceInputId, snapshot.id)
    assert.equal(JSON.parse(readEvidence(snapshot.source.commonDir, result.authorProjectionBlob!).toString()).version, 'canonical-author-projection-v1')
    assert.deepEqual(readFileSync(join(f.root, '.git/index')), originalIndex)
    assert.deepEqual(readFileSync(join(f.root, 'AGENTS.md')), physical)
    assert.equal((await captureInputSnapshot(f.root)).id, snapshot.id)
  }
})

test('a project without a filter preserves literal marker prose unchanged', async t => {
  const f = fixture(t, false)
  writeManagedBlock(join(f.root, 'AGENTS.md'), 'author-owned example')
  const snapshot = await captureInputSnapshot(f.root), result = composeAuthoredInput(snapshot).composed!
  assert.equal(text(snapshot, result), readFileSync(join(f.root, 'AGENTS.md'), 'utf8'))
  assert.equal(result.authorProjectionBlob, undefined)
})

test('managed-only changes do not conflict with prior delivery; genuine author deltas still merge or conflict', async t => {
  const f = fixture(t), delivery = join(f.directory, 'delivery')
  writeManagedBlock(join(f.root, 'AGENTS.md'), 'old generated block')
  const first = await captureInputSnapshot(f.root)
  f.git('worktree', 'add', '-b', 'delivery', delivery, 'HEAD')
  writeFileSync(join(delivery, 'AGENTS.md'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nagent-eight\n')
  const delivered = await captureInputSnapshot(delivery)
  const prior: BaselinePair = { id: 'proven-pair', repositoryId: first.source.repositoryId, source: first.source, sourceInput: first, verifiedDelivery: delivered, coveredScope: { paths: ['AGENTS.md'], contractIds: [], flowIds: [] }, receiptId: 'fixture-receipt', settledAtMs: Date.now() }
  writeFileSync(join(f.root, 'AGENTS.md'), 'human-one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  writeManagedBlock(join(f.root, 'AGENTS.md'), 'new generated block')
  const next = await captureInputSnapshot(f.root), result = composeAuthoredInput(next, prior)
  assert.deepEqual(result.conflicts, [])
  assert.equal(text(next, result.composed!), 'human-one\ntwo\nthree\nfour\nfive\nsix\nseven\nagent-eight\n')
  writeFileSync(join(f.root, 'AGENTS.md'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\nhuman-eight\n')
  writeManagedBlock(join(f.root, 'AGENTS.md'), 'latest generated block')
  const conflicted = composeAuthoredInput(await captureInputSnapshot(f.root), prior)
  assert.equal(conflicted.composed, null); assert.equal(conflicted.conflicts[0].path, 'AGENTS.md')
})

test('unknown configured filter is refused without executing it; changed canonical metadata is not trusted', async t => {
  const f = fixture(t), marker = join(f.directory, 'marker'), snapshot = await captureInputSnapshot(f.root)
  const old = f.git('config', 'filter.spexcode.clean')
  f.git('config', 'filter.spexcode.clean', `sh -c 'touch "${marker}"'`)
  assert.throws(() => composeAuthoredInput(snapshot), /SYNC_AUTHOR_FILTER_UNSUPPORTED/)
  assert.equal(existsSync(marker), false)
  f.git('config', 'filter.spexcode.clean', old)
  writeFileSync(join(f.root, '.git/spexcode/contract-filter-bindings'), 'AGENTS.md\tother\tmarkers\n')
  assert.throws(() => composeAuthoredInput(snapshot), /SYNC_AUTHOR_FILTER_UNSUPPORTED/)
  assert.equal(existsSync(marker), false)
})
