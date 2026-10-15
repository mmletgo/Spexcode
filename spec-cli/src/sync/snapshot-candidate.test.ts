import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { deflateSync } from 'node:zlib'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureInputSnapshot, contentHash, identifyWorktree, readEvidence, readObject, readTree, UnstableSnapshotError, verifySnapshot, writeObject, writeTree } from './snapshot.js'
import { composeInputSnapshots } from './composition.js'
import { exportCandidate, freezeCandidate, verifyCandidate } from './candidate.js'
import type { BaselinePair, InputSnapshot, SyncScope } from './operation-types.js'

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim()
function repo(t: test.TestContext, objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(join(tmpdir(), 'spex-sync-test-'))
  t.after(() => { const unlock = (path: string): void => { if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return; if (lstatSync(path).isDirectory()) { chmodSync(path, 0o755); for (const child of readdirSync(path)) unlock(join(path, child)) } }; unlock(root); rmSync(root, { recursive: true, force: true }) })
  git(root, 'init', '-b', 'main', `--object-format=${objectFormat}`); git(root, 'config', 'user.email', 'sync@example.invalid'); git(root, 'config', 'user.name', 'sync fixture')
  writeFileSync(join(root, 'file.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  return root
}
const scope = (...paths: string[]): SyncScope => ({ paths, contractIds: ['REQ-TEST'], flowIds: ['FLOW-TEST'] })
const files = (snapshot: InputSnapshot): Map<string, string> => new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString()]))
const change = (snapshot: InputSnapshot, path: string, content: string | null, mode?: '100644' | '100755'): object => { const entry = verifySnapshot(snapshot).find(entry => entry.path === path); return { path, beforeDigest: entry?.digest ?? null, beforeMode: entry?.mode ?? null, content, ...(mode ? { mode } : {}) } }
const pair = (sourceInput: InputSnapshot, verifiedDelivery: InputSnapshot): BaselinePair => ({ id: 'baseline-1', repositoryId: sourceInput.source.repositoryId, source: sourceInput.source, sourceInput, verifiedDelivery, receiptId: 'verified-receipt', coveredScope: scope('file.ts', 'generated.ts'), settledAtMs: Date.now() })

for (const format of ['sha1', 'sha256'] as const) {
  test(`${format} 真实批量对象保留二进制、UTF-8特殊路径、空文件与mode，每轮只启动一个写入和读取进程`, async t => {
    const root = repo(t, format), expected = new Map<string, Buffer>([['file.ts', readFileSync(join(root, 'file.ts'))]])
    for (let index = 0; index < 40; index++) {
      const path = `原字节 ${index}\t换\n行`, bytes = index === 0 ? Buffer.alloc(0) : Buffer.from([0, 10, 13, 255, index])
      writeFileSync(join(root, path), bytes); expected.set(path, bytes)
    }
    chmodSync(join(root, 'file.ts'), 0o755); symlinkSync('file.ts', join(root, 'link')); expected.set('link', Buffer.from('file.ts'))
    const indexBytes = readFileSync(join(root, '.git/index')), cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process'), original = cp.execFileSync
    const calls: string[][] = []
    cp.execFileSync = ((...args: Parameters<typeof execFileSync>) => { if (args[0] === 'git') calls.push(args[1] as string[]); return Reflect.apply(original, cp, args) }) as typeof execFileSync
    syncBuiltinESMExports()
    let snapshot: InputSnapshot
    try { snapshot = await captureInputSnapshot(root) }
    finally { cp.execFileSync = original; syncBuiltinESMExports() }
    assert.equal(calls.filter(args => args.includes('hash-object')).length, 2)
    assert.equal(calls.filter(args => args.includes('cat-file')).length, 2)
    assert.ok(calls.filter(args => args.includes('hash-object')).every(args => args.includes('--stdin-paths') && args.includes('--no-filters')))
    assert.deepEqual(readFileSync(join(root, '.git/index')), indexBytes)
    const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
    assert.deepEqual(entries.map(entry => entry.path), [...expected.keys()].sort())
    for (const entry of entries) {
      assert.equal(entry.oid.length, format === 'sha1' ? 40 : 64)
      assert.deepEqual(readObject(snapshot.source.commonDir, entry.oid), expected.get(entry.path))
      assert.equal(entry.digest, contentHash(expected.get(entry.path)!))
      assert.equal(entry.mode, entry.path === 'link' ? '120000' : entry.path === 'file.ts' ? '100755' : '100644')
    }
    assert.equal((await captureInputSnapshot(root)).id, snapshot.id)
  })

  test(`${format} 每次真实读回对象，拒绝missing与同OID路径下篡改而不复用缓存`, async t => {
    const root = repo(t, format), snapshot = await captureInputSnapshot(root), [entry] = readTree(snapshot.source.commonDir, snapshot.immutableTree)
    const path = join(snapshot.source.commonDir, 'objects', entry.oid.slice(0, 2), entry.oid.slice(2)), original = readFileSync(path), altered = Buffer.from('tampered\0\xff')
    chmodSync(path, 0o600); writeFileSync(path, deflateSync(Buffer.concat([Buffer.from(`blob ${altered.length}\0`), altered])))
    assert.throws(() => readTree(snapshot.source.commonDir, snapshot.immutableTree), /OID 不匹配/)
    assert.throws(() => readObject(snapshot.source.commonDir, entry.oid), /OID 不匹配/)
    writeFileSync(path, original); assert.deepEqual(readTree(snapshot.source.commonDir, snapshot.immutableTree), [entry])
    rmSync(path)
    assert.throws(() => readTree(snapshot.source.commonDir, snapshot.immutableTree), (error: unknown) => typeof (error as { status?: unknown }).status === 'number')
  })
}

test('缺失用户index和空树仍真实采集，批处理不创建用户index', async t => {
  const root = repo(t), index = join(root, '.git/index')
  rmSync(index)
  const input = await captureInputSnapshot(root)
  assert.equal(existsSync(index), false); assert.equal(input.indexDigest, contentHash(Buffer.alloc(0)))
  assert.equal(files(input).size, 1); assert.deepEqual(readTree(input.source.commonDir, input.indexTree), [])
  rmSync(join(root, 'file.ts'))
  const empty = await captureInputSnapshot(root)
  assert.equal(existsSync(index), false); assert.deepEqual(verifySnapshot(empty), [])
})

test('批量聚合超过128MiB仍分段成功，单个128MiB边界保持原读取容量与超限失败', t => {
  const root = repo(t), commonDir = join(root, '.git'), bytes = Buffer.alloc(65 * 1024 * 1024, 97)
  const first = { path: 'first', mode: '100644' as const, oid: writeObject(commonDir, bytes), digest: contentHash(bytes) }
  bytes[0] = 98
  const second = { path: 'second', mode: '100644' as const, oid: writeObject(commonDir, bytes), digest: contentHash(bytes) }
  assert.deepEqual(readTree(commonDir, writeTree(commonDir, [first, second])), [first, second])
  const boundary = Buffer.alloc(128 * 1024 * 1024, 99), entry = { path: 'boundary', mode: '100644' as const, oid: writeObject(commonDir, boundary), digest: contentHash(boundary) }
  assert.deepEqual(readTree(commonDir, writeTree(commonDir, [entry])), [entry])
  const over = Buffer.alloc(128 * 1024 * 1024 + 1, 100), overflow = { ...entry, oid: writeObject(commonDir, over), digest: contentHash(over) }
  assert.throws(() => readTree(commonDir, writeTree(commonDir, [overflow])), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOBUFS')
})

test('来源树没有ignore时，真实登记的嵌套会话worktree不成为作者输入或读取错误', async t => {
  const root = repo(t), before = await captureInputSnapshot(root), nested = join(root, '.worktrees/native-session')
  git(root, 'worktree', 'add', '-b', 'native-session', nested, 'HEAD')
  writeFileSync(join(nested, 'file.ts'), 'independent generated bytes\n')
  writeFileSync(join(nested, 'new.ts'), 'nested draft\n')
  assert.match(git(root, 'ls-files', '--others', '--exclude-standard'), /\.worktrees\/native-session\//)
  assert.equal((await captureInputSnapshot(root)).id, before.id)
  writeFileSync(join(root, 'author.ts'), 'outer author input\n')
  const updated = await captureInputSnapshot(root)
  assert.equal(files(updated).get('author.ts'), 'outer author input\n')
  assert.ok(![...files(updated).keys()].some(path => path.startsWith('.worktrees/')))
  assert.notEqual(updated.id, before.id)
  assert.equal(files(await captureInputSnapshot(nested)).get('new.ts'), 'nested draft\n')
})

test('真实采集保留 staged/unstaged/untracked 原字节与用户 index；稳定 ID 不含时间', async t => {
  const root = repo(t)
  writeFileSync(join(root, 'file.ts'), 'staged\n'); git(root, 'add', 'file.ts')
  writeFileSync(join(root, 'file.ts'), 'unstaged\n'); writeFileSync(join(root, 'new.ts'), 'new\r\n')
  const index = readFileSync(join(root, '.git/index')), first = await captureInputSnapshot(root), second = await captureInputSnapshot(root)
  assert.equal(first.id, second.id); assert.deepEqual(readFileSync(join(root, '.git/index')), index)
  assert.equal(files(first).get('file.ts'), 'unstaged\n'); assert.equal(files(first).get('new.ts'), 'new\r\n')
  assert.equal(git(root, 'show', `${first.indexTree}:file.ts`), 'staged')
  assert.equal(first.indexDigest, contentHash(index)); assert.equal(git(root, 'rev-parse', `refs/spex-sync/snapshots/${first.id}`), first.immutableTree)
})

test('并发保存与分支切换有界重试，拒绝混合快照；删除重建区分物理身份', async t => {
  const root = repo(t)
  const captured = await captureInputSnapshot(root, { onObservation: attempt => { if (attempt === 1) writeFileSync(join(root, 'file.ts'), 'latest\n') } })
  assert.equal(files(captured).get('file.ts'), 'latest\n')
  await assert.rejects(captureInputSnapshot(root, { maxAttempts: 2, onObservation: attempt => writeFileSync(join(root, 'file.ts'), `moving-${attempt}\n`) }), UnstableSnapshotError)
  const branch = await captureInputSnapshot(root, { onObservation: attempt => { if (attempt === 1) git(root, 'switch', '-c', 'next') } })
  assert.equal(branch.source.branch, 'refs/heads/next')
  const linked = join(root, 'linked'); git(root, 'worktree', 'add', '--detach', linked, 'HEAD')
  const identity = identifyWorktree(linked)
  await assert.rejects(captureInputSnapshot(linked, { maxAttempts: 1, onObservation: () => { git(root, 'worktree', 'remove', '--force', linked); git(root, 'worktree', 'add', '--detach', linked, 'HEAD') } }), UnstableSnapshotError)
  assert.notEqual(identifyWorktree(linked).physicalFingerprint, identity.physicalFingerprint)
})

test('元数据对象采集和pin不执行用户fsmonitor/reference hooks，GC保留快照对象', async t => {
  const root = repo(t), marker = join(root, 'hook-ran')
  const hook = join(root, '.git/hooks/reference-transaction')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(hook, 0o755)
  const monitor = join(root, '.git/hooks/fsmonitor-test')
  writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(monitor, 0o755); git(root, 'config', 'core.fsmonitor', monitor)
  writeFileSync(join(root, 'new.ts'), 'uncommitted but pinned\n')
  const snapshot = await captureInputSnapshot(root)
  assert.equal(existsSync(marker), false)
  git(root, '-c', 'core.fsmonitor=false', 'gc', '--prune=now')
  assert.equal(files(snapshot).get('new.ts'), 'uncommitted but pinned\n')
})

test('成对基线把source2差量叠delivery1，保留生成内容与同文件非重叠修改', async t => {
  const root = repo(t), source1 = await captureInputSnapshot(root), deliveryRoot = join(root, 'delivery')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD')
  writeFileSync(join(deliveryRoot, 'file.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\ngenerated-eight\n')
  writeFileSync(join(deliveryRoot, 'generated.ts'), 'agent generated\n')
  const delivery1 = await captureInputSnapshot(deliveryRoot)
  // delivery 目录并非输入的一部分。
  writeFileSync(join(root, '.git/info/exclude'), 'delivery/\n')
  writeFileSync(join(root, 'file.ts'), 'source-one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n')
  const source2 = await captureInputSnapshot(root), result = composeInputSnapshots(source2, pair(source1, delivery1))
  assert.deepEqual(result.conflicts, []); assert.ok(result.composed)
  const entries = readTree(source2.source.commonDir, result.composed.tree), mapped = new Map(entries.map(entry => [entry.path, readObject(source2.source.commonDir, entry.oid).toString()]))
  assert.equal(mapped.get('generated.ts'), 'agent generated\n'); assert.equal(mapped.get('file.ts'), 'source-one\ntwo\nthree\nfour\nfive\nsix\nseven\ngenerated-eight\n')
  assert.equal(result.composed.sourceInputId, source2.id); assert.equal(files(source2).get('file.ts')!.endsWith('eight\n'), true)
  const candidate = freezeCandidate(source2, { version: 'sync-files-v1', changes: [] }, scope('file.ts'), result.composed)
  assert.equal(candidate.tree, result.composed.tree)
  assert.throws(() => composeInputSnapshots(delivery1, pair(source1, delivery1)), /物理身份/)
  assert.equal(composeInputSnapshots(source2).composed!.previousBaselinePairId, null)
})

test('重叠、二进制和删除修改冲突保留base/source/delivery；新增/删除/mode差量不漏', async t => {
  const root = repo(t), source1 = await captureInputSnapshot(root), deliveryRoot = join(root, 'delivery')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD'); writeFileSync(join(root, '.git/info/exclude'), 'delivery/\n')
  writeFileSync(join(deliveryRoot, 'file.ts'), 'delivery\n'); const delivery = await captureInputSnapshot(deliveryRoot)
  writeFileSync(join(root, 'file.ts'), 'source\n'); const next = await captureInputSnapshot(root), result = composeInputSnapshots(next, pair(source1, delivery))
  assert.equal(result.composed, null); assert.equal(result.conflicts.length, 1)
  for (const side of ['base', 'source', 'delivery'] as const) assert.ok(result.conflicts[0][side]?.oid)
  assert.equal(readObject(next.source.commonDir, result.conflicts[0].source!.oid).toString(), 'source\n')
  writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2])); chmodSync(join(root, 'file.ts'), 0o755)
  const input = await captureInputSnapshot(root), frozen = freezeCandidate(input, { version: 'sync-files-v1', changes: [change(input, 'file.ts', 'source\n', '100644'), change(input, 'add.ts', 'added\n'), change(input, 'binary', null)] }, scope('file.ts', 'add.ts', 'binary'))
  const diff = JSON.parse(readEvidence(input.source.commonDir, frozen.actualDiffBlob).toString())
  assert.deepEqual(diff.map((file: { path: string }) => file.path), ['add.ts', 'binary', 'file.ts'])
  assert.equal(diff[2].preDigest, diff[2].postDigest); assert.equal(diff[2].preMode, '100755'); assert.equal(diff[2].postMode, '100644')
  assert.equal(diff[1].postDigest, null)
})

test('固定候选schema/CAS/路径/父symlink/完整diff范围门禁，未改binary和symlink保持', async t => {
  const root = repo(t); writeFileSync(join(root, 'binary'), Buffer.from([0, 1])); symlinkSync('file.ts', join(root, 'link'))
  const input = await captureInputSnapshot(root), build = (changes: object[], paths = ['file.ts']): void => { freezeCandidate(input, { version: 'sync-files-v1', changes }, scope(...paths)) }
  assert.throws(() => build([{ ...change(input, 'file.ts', 'changed'), beforeDigest: '0'.repeat(64) }]), /CAS/)
  assert.throws(() => build([change(input, 'file.ts', 'changed'), change(input, 'file.ts', 'changed')]), /重复/)
  for (const path of ['../outside', '/outside', '.git/config', 'a/../../outside', 'a\\b', 'nested/.GIT/hooks']) assert.throws(() => build([{ path, beforeDigest: null, beforeMode: null, content: 'x' }], [path]), /路径/)
  assert.throws(() => build([{ path: 'link/escape.ts', beforeDigest: null, beforeMode: null, content: 'x' }], ['link']), /父路径/)
  assert.throws(() => build([change(input, 'outside.ts', 'x')]), /越界/)
  assert.throws(() => build([change(input, 'binary', 'x')], ['binary']), /UTF-8/)
  const candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [change(input, 'file.ts', 'changed\n')] }, scope('file.ts'))
  const frozen = verifyCandidate(input.source.commonDir, candidate), prior = verifySnapshot(input)
  for (const path of ['binary', 'link']) assert.deepEqual(frozen.find(entry => entry.path === path), prior.find(entry => entry.path === path))
  writeFileSync(join(root, 'file.ts'), 'old attempt mutates again\n')
  assert.equal(readObject(input.source.commonDir, frozen.find(entry => entry.path === 'file.ts')!.oid).toString(), 'changed\n')
})

test('候选导出独立只读副本，保留业务auth模块，无.git/node_modules/宿主凭据且对应hash', async t => {
  const root = repo(t); mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/auth.ts'), 'export const auth = true\n')
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules/secret'), 'shared runtime'); writeFileSync(join(root, '.env'), 'host credential')
  symlinkSync('file.ts', join(root, 'link'))
  const input = await captureInputSnapshot(root), candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [] }, scope('file.ts'))
  const output = exportCandidate(input.source.commonDir, candidate, join(root, 'validation'))
  assert.deepEqual(output.excludedPaths, ['.env', 'node_modules/secret']); assert.equal(existsSync(join(output.root, '.git')), false); assert.equal(existsSync(join(output.root, 'node_modules')), false)
  for (const entry of verifyCandidate(input.source.commonDir, candidate).filter(entry => !output.excludedPaths.includes(entry.path))) {
    if (entry.mode === '120000') continue
    assert.equal(contentHash(readFileSync(join(output.root, entry.path))), entry.digest)
    assert.equal(lstatSync(join(output.root, entry.path)).mode & 0o222, 0)
  }
  assert.equal(readFileSync(join(output.root, 'src/auth.ts'), 'utf8'), 'export const auth = true\n')
  assert.throws(() => exportCandidate(input.source.commonDir, candidate, output.root), /必须为空/)
})

test('输入父symlink和导出越界symlink拒绝；证据篡改被真实SHA核对拒绝', async t => {
  const root = repo(t), outside = mkdtempSync(join(tmpdir(), 'spex-sync-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }))
  mkdirSync(join(root, 'parent')); writeFileSync(join(root, 'parent/tracked.ts'), 'tracked'); git(root, 'add', 'parent/tracked.ts'); git(root, 'commit', '-m', 'parent')
  rmSync(join(root, 'parent'), { recursive: true }); writeFileSync(join(outside, 'tracked.ts'), 'outside'); symlinkSync(outside, join(root, 'parent'))
  await assert.rejects(captureInputSnapshot(root), /父路径/)
  rmSync(join(root, 'parent')); symlinkSync(outside, join(root, 'external'))
  const input = await captureInputSnapshot(root), candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [] }, scope('file.ts'))
  assert.throws(() => exportCandidate(input.source.commonDir, candidate, join(root, 'unsafe-validation')), /符号链接越界/)
  writeFileSync(join(input.source.commonDir, 'spexcode/evidence', candidate.manifestBlob.sha256), 'tampered')
  assert.throws(() => verifyCandidate(input.source.commonDir, candidate), /证据摘要/)
})


test('split index 真实字节不变并能冻结 staged 树', async t => {
  const root = repo(t)
  writeFileSync(join(root, 'file.ts'), 'split staged\n'); git(root, 'add', 'file.ts'); git(root, 'update-index', '--split-index')
  const sharedPath = join(root, '.git', readdirSync(join(root, '.git')).find(name => name.startsWith('sharedindex.'))!), sharedStat = lstatSync(sharedPath, { bigint: true })
  const index = readFileSync(join(root, '.git/index')), snapshot = await captureInputSnapshot(root)
  assert.equal(lstatSync(sharedPath, { bigint: true }).mtimeNs, sharedStat.mtimeNs)
  assert.deepEqual(readFileSync(join(root, '.git/index')), index)
  assert.equal(git(root, 'show', `${snapshot.indexTree}:file.ts`), 'split staged')
})

test('来源新增删除移动与二进制三方分歧真实保存，不猜测文本', async t => {
  const root = repo(t)
  writeFileSync(join(root, 'binary'), Buffer.from([0, 1])); git(root, 'add', 'binary'); git(root, 'commit', '-m', 'binary base')
  const base = await captureInputSnapshot(root), deliveryRoot = join(root, 'delivery')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD'); writeFileSync(join(root, '.git/info/exclude'), 'delivery/\n')
  writeFileSync(join(deliveryRoot, 'generated.ts'), 'keep generated\n'); const delivered = await captureInputSnapshot(deliveryRoot)
  git(root, 'mv', 'file.ts', 'renamed.ts'); writeFileSync(join(root, 'new.ts'), 'new file\n'); chmodSync(join(root, 'renamed.ts'), 0o755)
  const next = await captureInputSnapshot(root), result = composeInputSnapshots(next, pair(base, delivered))
  assert.ok(result.composed); const entries = readTree(next.source.commonDir, result.composed.tree)
  assert.equal(entries.some(entry => entry.path === 'file.ts'), false); assert.equal(entries.find(entry => entry.path === 'renamed.ts')!.mode, '100755'); assert.ok(entries.find(entry => entry.path === 'generated.ts')); assert.ok(entries.find(entry => entry.path === 'new.ts'))
  writeFileSync(join(root, 'binary'), Buffer.from([0, 2])); writeFileSync(join(deliveryRoot, 'binary'), Buffer.from([0, 3]))
  const binaryPair = pair(base, await captureInputSnapshot(deliveryRoot)); binaryPair.coveredScope = scope('file.ts', 'generated.ts', 'binary')
  const binaryConflict = composeInputSnapshots(await captureInputSnapshot(root), binaryPair)
  assert.equal(binaryConflict.composed, null); const conflict = binaryConflict.conflicts.find(item => item.path === 'binary')!
  assert.deepEqual(readObject(next.source.commonDir, conflict.base!.oid), Buffer.from([0, 1])); assert.deepEqual(readObject(next.source.commonDir, conflict.source!.oid), Buffer.from([0, 2])); assert.deepEqual(readObject(next.source.commonDir, conflict.delivery!.oid), Buffer.from([0, 3]))
})


test('partial pair未覆盖blocked来源未再次编辑，下一轮仍保留输入而不冒充已交付', async t => {
  const root = repo(t), deliveryRoot = join(root, 'delivery')
  git(root, 'worktree', 'add', '-b', 'delivery', deliveryRoot, 'HEAD'); writeFileSync(join(root, '.git/info/exclude'), 'delivery/\n')
  writeFileSync(join(root, 'file.ts'), 'ready source\n'); writeFileSync(join(root, 'blocked.ts'), 'pending source never delivered\n')
  const source = await captureInputSnapshot(root)
  writeFileSync(join(deliveryRoot, 'file.ts'), 'ready delivered\n'); writeFileSync(join(deliveryRoot, 'generated.ts'), 'verified generated\n')
  const delivery = await captureInputSnapshot(deliveryRoot), partial = pair(source, delivery)
  partial.coveredScope = scope('file.ts', 'generated.ts')
  const next = await captureInputSnapshot(root); assert.equal(next.id, source.id)
  const result = composeInputSnapshots(next, partial); assert.ok(result.composed)
  const mapped = new Map(readTree(next.source.commonDir, result.composed.tree).map(entry => [entry.path, readObject(next.source.commonDir, entry.oid).toString()]))
  assert.equal(mapped.get('file.ts'), 'ready delivered\n'); assert.equal(mapped.get('generated.ts'), 'verified generated\n'); assert.equal(mapped.get('blocked.ts'), 'pending source never delivered\n')
  assert.equal(result.composed.previousBaselinePairId, partial.id)
})


test('linked worktree split index 保留原字节并读取对应独立index', async t => {
  const root = repo(t), linked = join(root, 'linked')
  git(root, 'worktree', 'add', '-b', 'linked', linked, 'HEAD')
  writeFileSync(join(linked, 'file.ts'), 'linked staged\n'); git(linked, 'add', 'file.ts'); git(linked, 'update-index', '--split-index')
  const identity = identifyWorktree(linked), sharedPath = join(identity.gitDir, readdirSync(identity.gitDir).find(name => name.startsWith('sharedindex.'))!), sharedStat = lstatSync(sharedPath, { bigint: true })
  const index = readFileSync(join(identity.gitDir, 'index')), snapshot = await captureInputSnapshot(linked)
  assert.equal(lstatSync(sharedPath, { bigint: true }).mtimeNs, sharedStat.mtimeNs)
  assert.deepEqual(readFileSync(join(identity.gitDir, 'index')), index)
  assert.equal(git(root, 'show', `${snapshot.indexTree}:file.ts`), 'linked staged')
})


test('外部修改file、Agent仅新增test：可信验证范围保留file，模型diff只记test', async t => {
  const root = repo(t)
  writeFileSync(join(root, 'file.ts'), 'external behavior input\n')
  const input = await captureInputSnapshot(root), candidate = freezeCandidate(input, { version: 'sync-files-v1', changes: [change(input, 'test.ts', 'generated test\n')] }, scope('file.ts', 'test.ts'))
  assert.equal(candidate.sourceInputId, input.id); assert.equal(candidate.baseTree, input.immutableTree)
  assert.deepEqual(candidate.coveredScope.paths, ['file.ts', 'test.ts'])
  const diff = JSON.parse(readEvidence(input.source.commonDir, candidate.actualDiffBlob).toString())
  assert.deepEqual(diff.map((file: { path: string }) => file.path), ['test.ts'])
  const entries = verifyCandidate(input.source.commonDir, candidate)
  assert.equal(readObject(input.source.commonDir, entries.find(entry => entry.path === 'file.ts')!.oid).toString(), 'external behavior input\n')
  const ref = { tree: candidate.tree, baseTree: candidate.baseTree, sourceInputId: candidate.sourceInputId, manifestBlob: candidate.manifestBlob, actualDiffBlob: candidate.actualDiffBlob, coveredScope: candidate.coveredScope }
  const forgedRef = { ...ref, coveredScope: scope('file.ts') }
  assert.throws(() => verifyCandidate(input.source.commonDir, { ...forgedRef, digest: contentHash(JSON.stringify(forgedRef)) }), /实际 diff/)
})

test('file↔directory替换保留原index字节与mtime，完整采集新普通文件而不误认submodule', async t => {
  const root = repo(t)
  mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder/old.ts'), 'old child\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'folder base')
  const indexPath = join(root, '.git/index'), originalIndex = readFileSync(indexPath), originalTime = lstatSync(indexPath, { bigint: true }).mtimeNs
  rmSync(join(root, 'file.ts')); mkdirSync(join(root, 'file.ts')); writeFileSync(join(root, 'file.ts/new.ts'), 'new child\n')
  rmSync(join(root, 'folder'), { recursive: true }); writeFileSync(join(root, 'folder'), 'now file\n')
  const snapshot = await captureInputSnapshot(root), mapped = files(snapshot)
  assert.equal(mapped.get('file.ts/new.ts'), 'new child\n'); assert.equal(mapped.get('folder'), 'now file\n'); assert.equal(mapped.has('file.ts'), false); assert.equal(mapped.has('folder/old.ts'), false)
  assert.deepEqual(readFileSync(indexPath), originalIndex); assert.equal(lstatSync(indexPath, { bigint: true }).mtimeNs, originalTime)
})

test('真实gitlink即使工作目录缺失仍明确拒绝，不能误当普通目录替换', async t => {
  const root = repo(t), head = git(root, 'rev-parse', 'HEAD')
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${head},submodule`)
  await assert.rejects(captureInputSnapshot(root), /submodule|gitlink/)
})
