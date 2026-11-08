import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { removeOwnedTree } from '@spexcode/spec-core'

test('removing private and read-only trees never expands group or other permissions', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'spex-owned-tree-'))
  const sessions = join(root, 'sessions'), snapshot = join(sessions, 'snapshot'), shared = join(root, 'shared')
  fs.mkdirSync(snapshot, { recursive: true })
  fs.mkdirSync(shared)
  fs.writeFileSync(join(snapshot, 'runtime.js'), 'frozen runtime\n')
  fs.chmodSync(sessions, 0o700)
  fs.chmodSync(snapshot, 0o500)
  fs.chmodSync(shared, 0o750)
  const directories = [root, sessions, snapshot, shared]
  const originalAccess = new Map(directories.map(path => [path, fs.statSync(path).mode & 0o077]))
  const observed: { path: string; access: number }[] = []
  const chmod = fs.chmodSync
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    for (const directory of directories) if (fs.existsSync(directory)) chmod(directory, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  })
  t.mock.method(fs, 'chmodSync', (path: fs.PathLike, mode: fs.Mode): void => {
    chmod(path, mode)
    observed.push({ path: String(path), access: fs.statSync(path).mode & 0o077 })
  })
  syncBuiltinESMExports()

  removeOwnedTree(root)

  assert.equal(fs.existsSync(root), false, 'the read-only snapshot is actually removed')
  assert.ok(observed.length > 0, 'permission repair was observed during removal')
  for (const change of observed) {
    assert.equal(change.access, originalAccess.get(change.path), `${change.path}: group and other access stays unchanged during cleanup`)
  }
})
