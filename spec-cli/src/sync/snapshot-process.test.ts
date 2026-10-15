import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { captureInputSnapshot, contentHash, readObject, readTree, writeObject, writeTree } from './snapshot.js'

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
const git = (root: string, ...args: string[]): string => execFileSync(realGit, ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, timeout: 5000 }).toString().trim()
function fixture(t: test.TestContext, format: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(join(tmpdir(), 'spex-sync-process-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-q', '-b', 'main', `--object-format=${format}`)
  git(root, 'config', 'user.name', 'snapshot fixture'); git(root, 'config', 'user.email', 'snapshot@example.invalid')
  writeFileSync(join(root, 'source'), 'source\n'); git(root, 'add', 'source'); git(root, 'commit', '-qm', 'base')
  return root
}

type Trace = { args: string[]; regular: boolean; mode: number; size: number; ownedPath?: string; directoryMode?: number; objects?: { path: string; mode: number; directoryMode: number; bytes: string }[] }
function shim(t: test.TestContext): { bin: string; trace: string } {
  const bin = mkdtempSync(join(tmpdir(), 'spex-sync-git-shim-')), trace = join(bin, 'trace')
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const args = process.argv.slice(2), stat = fs.fstatSync(0);
const record = { args, regular: stat.isFile(), mode: stat.mode & 0o777, size: stat.size };
if (args.includes('--stdin') || args.includes('--index-info') || args.includes('--stdin-paths') || args.includes('--batch')) {
  if (!record.regular) { process.stderr.write('stdin must be owned regular file\\n'); process.exit(31); }
  for (const name of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('spex-sync-git-input-'))) {
    const directory = path.join(os.tmpdir(), name), input = path.join(directory, 'input');
    if (fs.existsSync(input) && fs.statSync(input).ino === stat.ino && fs.statSync(input).dev === stat.dev) {
      record.ownedPath = input; record.directoryMode = fs.statSync(directory).mode & 0o777;
    }
  }
  if (args.includes('--stdin-paths')) record.objects = fs.readFileSync(record.ownedPath, 'utf8').trim().split('\\n').map(name => {
    const object = path.resolve(name);
    return { path: object, mode: fs.statSync(object).mode & 0o777, directoryMode: fs.statSync(path.dirname(object)).mode & 0o777, bytes: fs.readFileSync(object).toString('base64') };
  });
}
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(record) + '\\n');
const requested = process.env.SPEX_SNAPSHOT_SHIM_FAILURE, failure = requested?.startsWith('batch-') ? args.includes('--stdin-paths') ? requested.slice(6) : undefined : requested;
if (failure === 'exit') { process.stderr.write('controlled Git failure\\n'); process.exit(37); }
if (failure === 'timeout') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else { const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); if (result.error) throw result.error; process.exit(result.status); }
`)
  chmodSync(join(bin, 'git'), 0o755)
  return { bin, trace }
}
const traces = (path: string): Trace[] => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Trace)

test('生产快照及batch stdin仅用私有普通文件，真实Git原字节写入且读对象不再hash stdin', async t => {
  const root = fixture(t), wrapper = shim(t), priorPath = process.env.PATH, priorTmp = process.env.TMPDIR, indexPath = join(root, '.git/index'), beforeIndex = readFileSync(indexPath)
  writeFileSync(join(root, 'empty'), Buffer.alloc(0)); writeFileSync(join(root, 'binary'), Buffer.from([0, 255, 128, 1]))
  const beforeSource = readFileSync(join(root, 'source'))
  process.env.PATH = `${wrapper.bin}:${priorPath}`
  process.env.TMPDIR = wrapper.bin
  try {
    assert.equal(readObject(join(root, '.git'), writeObject(join(root, '.git'), Buffer.alloc(0))).length, 0)
    const snapshot = await captureInputSnapshot(root), entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
    assert.deepEqual(readObject(snapshot.source.commonDir, entries.find(entry => entry.path === 'binary')!.oid), Buffer.from([0, 255, 128, 1]))
    assert.equal(readObject(snapshot.source.commonDir, entries.find(entry => entry.path === 'empty')!.oid).length, 0)
  } finally { process.env.PATH = priorPath; if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp }
  const calls = traces(wrapper.trace), inputs = calls.filter(call => call.args.includes('--stdin') || call.args.includes('--index-info') || call.args.includes('--stdin-paths') || call.args.includes('--batch'))
  assert.ok(inputs.some(call => call.args.includes('hash-object') && call.size === 0))
  assert.ok(inputs.some(call => call.args.includes('update-index')))
  for (const call of inputs) {
    assert.equal(call.regular, true); assert.equal(call.mode, 0o600); assert.equal(call.directoryMode, 0o700)
    assert.ok(call.ownedPath); assert.equal(existsSync(call.ownedPath), false)
  }
  assert.ok(calls.some(call => call.args.includes('cat-file')))
  assert.equal(calls.some(call => call.args.includes('hash-object') && !call.args.includes('-w')), false)
  const batches = calls.filter(call => call.args.includes('--stdin-paths'))
  assert.equal(batches.length, 2)
  for (const call of batches) {
    assert.deepEqual(call.objects!.map(object => object.bytes).sort(), [beforeSource, Buffer.alloc(0), Buffer.from([0, 255, 128, 1])].map(bytes => bytes.toString('base64')).sort())
    for (const object of call.objects!) {
      assert.equal(object.mode, 0o600); assert.equal(object.directoryMode, 0o700); assert.equal(existsSync(object.path), false)
    }
  }
  assert.ok(calls.filter(call => !inputs.includes(call)).every(call => !call.regular))
  assert.deepEqual(readFileSync(indexPath), beforeIndex); assert.deepEqual(readFileSync(join(root, 'source')), beforeSource)
})

for (const format of ['sha1', 'sha256'] as const) test(`真实${format}空/二进制/非UTF8 blob完整OID校验，损坏或错误OID拒绝`, async t => {
  const root = fixture(t, format), commonDir = join(root, '.git'), indexPath = join(commonDir, 'index'), originalIndex = readFileSync(indexPath)
  const contents = [Buffer.alloc(0), Buffer.from('中文\r\n'), Buffer.from([0, 255, 254, 128, 1]), Buffer.alloc(128 * 1024, 255)]
  const entries = contents.map((bytes, i) => {
    const path = `blob-${i}`
    writeFileSync(join(root, path), bytes)
    const expectedOid = git(root, 'hash-object', '-w', path), oid = writeObject(commonDir, bytes)
    assert.equal(oid, expectedOid); assert.equal(oid.length, format === 'sha1' ? 40 : 64)
    assert.deepEqual(readObject(commonDir, oid), bytes)
    return { path, mode: '100644' as const, oid, digest: contentHash(bytes) }
  })
  assert.deepEqual(readTree(commonDir, writeTree(commonDir, entries)), entries)
  const snapshot = await captureInputSnapshot(root)
  for (const entry of entries) assert.equal(readTree(commonDir, snapshot.immutableTree).find(item => item.path === entry.path)!.oid, entry.oid)
  assert.deepEqual(readFileSync(indexPath), originalIndex)
  assert.throws(() => readObject(commonDir, '0'.repeat(format === 'sha1' ? 40 : 64)))
  const oid = entries[1].oid, objectPath = join(commonDir, 'objects', oid.slice(0, 2), oid.slice(2))
  chmodSync(objectPath, 0o600); writeFileSync(objectPath, deflateSync(Buffer.from('blob 5\0wrong')))
  assert.throws(() => readObject(commonDir, oid), /Git blob OID 不匹配/)
})

for (const failure of ['exit', 'timeout'] as const) test(`外部Git ${failure}错误透传且输入fd和owned临时目录清理`, t => {
  const root = fixture(t), wrapper = shim(t), commonDir = join(root, '.git'), index = readFileSync(join(commonDir, 'index'))
  const script = `
import assert from 'node:assert/strict';
import { closeSync, openSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { objectGit, writeObject, identifyWorktree, captureInputSnapshot } from ${JSON.stringify(new URL('./snapshot.ts', import.meta.url).href)};
const inputs = () => readdirSync(tmpdir()).filter(name => name.startsWith('spex-sync-git-input-') || name.startsWith('spex-sync-objects-')).sort();
const before = inputs();
const nextFd = () => { const fd = openSync('/dev/null', 'r'); closeSync(fd); return fd; };
const beforeFd = nextFd();
for (const run of [() => writeObject(${JSON.stringify(commonDir)}, Buffer.alloc(0)), () => objectGit(${JSON.stringify(commonDir)}, ['update-index', '-z', '--index-info'], Buffer.from('record')), () => objectGit(${JSON.stringify(commonDir)}, ['cat-file', '--batch'], Buffer.from('0'.repeat(40) + '\\n')), () => objectGit(${JSON.stringify(commonDir)}, ['rev-parse', 'HEAD']), () => identifyWorktree(${JSON.stringify(root)})]) {
  assert.throws(run, error => ${failure === 'exit' ? "error.status === 37 && /controlled Git failure/.test(error.stderr.toString())" : "error.code === 'ETIMEDOUT' && error.signal === 'SIGKILL'"});
  assert.deepEqual(inputs(), before);
  assert.equal(nextFd(), beforeFd);
}
process.env.SPEX_SNAPSHOT_SHIM_FAILURE = 'batch-${failure}';
await assert.rejects(captureInputSnapshot(${JSON.stringify(root)}, { maxAttempts: 1 }), error => ${failure === 'exit' ? "error.name === 'UnstableSnapshotError' && error.cause.status === 37 && /controlled Git failure/.test(error.cause.stderr.toString())" : "error.code === 'ETIMEDOUT' && error.signal === 'SIGKILL'"});
assert.deepEqual(inputs(), before); assert.equal(nextFd(), beforeFd);
`
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: wrapper.bin, PATH: `${wrapper.bin}:${process.env.PATH}`, SPEX_SNAPSHOT_SHIM_FAILURE: failure, SPEXCODE_GIT_TIMEOUT_MS: '1000' }, encoding: 'utf8', timeout: 12000 })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  for (const call of traces(wrapper.trace).filter(call => call.ownedPath)) assert.equal(existsSync(call.ownedPath!), false)
  assert.deepEqual(readFileSync(join(commonDir, 'index')), index)
  assert.equal(git(root, 'status', '--porcelain'), '')
})
