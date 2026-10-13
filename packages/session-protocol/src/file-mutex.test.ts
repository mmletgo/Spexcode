import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimFileMutex, openProtocol } from './index.js'

test('实际连接独占，release后可重入，业务库与链接不充当锁', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-file-mutex-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'writer.sqlite'), first = claimFileMutex(path)!
  first.assertHeld(); assert.equal(claimFileMutex(path), null); first.assertHeld()
  first.release(); first.release(); assert.throws(() => first.assertHeld(), /released/)
  const second = claimFileMutex(path)!
  second.assertHeld(); second.release()
  const business = join(root, 'business.sqlite'), protocol = openProtocol(business)
  protocol.close(); assert.throws(() => claimFileMutex(business), /own rollback-journal/)
  symlinkSync(path, join(root, 'alias.sqlite'))
  assert.throws(() => claimFileMutex(join(root, 'alias.sqlite')), /regular file/)
})

test('跨进程争用与SIGKILL释放真实内核锁，无须删除锁文件', { timeout: 15000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-file-mutex-process-'))), path = join(root, 'writer.sqlite')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { claimFileMutex } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}; const lock=claimFileMutex(process.argv[1]); if(!lock) process.exit(2); lock.assertHeld(); console.log('held'); setInterval(()=>lock.assertHeld(),100);`, path], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }) })
  const output = await Promise.race([once(child.stdout!, 'data').then(([data]) => String(data)), once(child, 'exit').then(([code]) => { throw new Error(`lock child exited before acquisition: ${code}`) })])
  assert.equal(output.trim(), 'held'); assert.equal(claimFileMutex(path), null)
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit
  const recovered = claimFileMutex(path)!
  assert.ok(recovered); recovered.assertHeld(); recovered.release()
})

test('文件或父目录重建使旧lock失去授权，release不删除新所有者文件', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-file-mutex-identity-'))), owned = join(root, 'owned')
  mkdirSync(owned)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(owned, 'writer.sqlite'), lock = claimFileMutex(path)!
  renameSync(owned, join(root, 'previous')); mkdirSync(owned)
  const replacement = claimFileMutex(path)!
  assert.throws(() => lock.assertHeld(), /physical path changed/)
  lock.release(); replacement.assertHeld(); replacement.release()
})
