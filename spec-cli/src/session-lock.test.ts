import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runtimeRoot } from '@spexcode/spec-core'

import { claimDeliveryLock, withDeliveryLocks } from './delivery-lock.js'
import { trySessionRecordLockSync, withSessionRecordLock, withSessionRecordLockSync } from './session-record-lock.js'

const isolatedHome = (): void => { process.env.SPEXCODE_HOME = mkdtempSync(join(tmpdir(), 'spex-lock-')) }

test('record lock excludes a second local writer and releases after the body', () => {
  isolatedHome()
  const release = trySessionRecordLockSync('lock-session')
  assert.ok(release)
  assert.equal(trySessionRecordLockSync('lock-session'), null)
  assert.throws(() => withSessionRecordLockSync('lock-session', () => assert.fail('must stay fenced')), /transaction lock is busy/)
  release!()
  assert.ok(trySessionRecordLockSync('lock-session'))
})

test('record lock releases when an async operation throws', async () => {
  isolatedHome()
  await assert.rejects(() => withSessionRecordLock('lock-session', async () => { throw new Error('boom') }), /boom/)
  assert.ok(trySessionRecordLockSync('lock-session'))
})

test('record lock wait remains bounded and an already cancelled caller never acquires', async () => {
  isolatedHome()
  const release = trySessionRecordLockSync('lock-session')!
  const now = Date.now
  let clock = now()
  Date.now = () => { clock += 30_001; return clock }
  try {
    await assert.rejects(() => withSessionRecordLock('lock-session', async () => assert.fail('must stay fenced')), /timed out waiting for transaction lock/)
  } finally { Date.now = now; release() }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => withSessionRecordLock('lock-session', async () => assert.fail('must stay cancelled'), controller.signal), { name: 'AbortError' })
  assert.equal(existsSync(join(runtimeRoot(), '.session-record-locks', 'lock-session.lock')), false)
})

test('a stale release cannot remove a later record lock owner', () => {
  isolatedHome()
  const staleRelease = trySessionRecordLockSync('lock-session')!
  staleRelease()
  const currentRelease = trySessionRecordLockSync('lock-session')!
  try {
    staleRelease()
    assert.equal(trySessionRecordLockSync('lock-session'), null)
  } finally { currentRelease() }
})

for (const format of ['legacy', 'directory']) test(`two dead-owner reclaimers cannot remove a newly published owner (${format})`, { timeout: 15_000 }, async () => {
  isolatedHome()
  const fixture = mkdtempSync(join(tmpdir(), 'spex-lock-reclaim-'))
  const lock = join(runtimeRoot(), '.session-record-locks', 'reclaim.lock')
  mkdirSync(join(runtimeRoot(), '.session-record-locks'), { recursive: true })
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(dead, 'exit')
  if (format === 'legacy') writeFileSync(lock, String(dead.pid))
  else {
    mkdirSync(lock)
    writeFileSync(join(lock, `${dead.pid}-${randomUUID()}`), '')
  }
  const children: ReturnType<typeof spawn>[] = []
  const start = (id: string) => {
    const script = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { withSessionRecordLock } from ${JSON.stringify(fileURLToPath(new URL('./session-record-lock.ts', import.meta.url)))};
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid === ${dead.pid} && signal === 0) {
          writeFileSync(${JSON.stringify(join(fixture, `${id}-observed`))}, 'observed old owner');
          while (!existsSync(${JSON.stringify(join(fixture, `${id}-probe`))}))
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        } else if (signal === 0) writeFileSync(${JSON.stringify(join(fixture, `${id}-busy`))}, 'observed current owner');
        return kill(pid, signal);
      };
      await withSessionRecordLock('reclaim', async () => {
        writeFileSync(${JSON.stringify(join(fixture, `${id}-entered`))}, 'entered');
        await new Promise(resolve => process.stdin.once('data', resolve));
      });
    `
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
      env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    let errors = ''
    child.stderr!.setEncoding('utf8').on('data', chunk => { errors += chunk })
    const done = once(child, 'exit').then(([code, signal]) => { assert.equal(code, 0, `${id} exited with ${signal}: ${errors}`) })
    return { child, done }
  }
  const waitFor = async (...names: string[]) => {
    const deadline = Date.now() + 5_000
    while (!names.some(name => existsSync(join(fixture, name)))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${names.join(' or ')}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  let completions: Promise<void>[] = []
  try {
    const a = start('a'), b = start('b')
    completions = [a.done, b.done]
    // Both processes have captured the same exited PID before either can reclaim it.
    await Promise.all([waitFor('a-observed'), waitFor('b-observed')])
    writeFileSync(join(fixture, 'a-probe'), 'continue')
    await waitFor('a-entered')
    writeFileSync(join(fixture, 'b-probe'), 'continue')
    await waitFor('b-entered', 'b-busy')
    assert.equal(existsSync(join(fixture, 'b-entered')), false, 'the second reclaimer must not overlap the new live holder')
    a.child.stdin!.end('release')
    await waitFor('b-entered')
    b.child.stdin!.end('release')
    await Promise.all(completions)
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled(completions)
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('a release paused before rmdir cannot remove a replacement nonempty directory', () => {
  isolatedHome()
  const lock = join(runtimeRoot(), '.session-record-locks', 'lock-session.lock')
  const release = trySessionRecordLockSync('lock-session')!
  const rmdir = fs.rmdirSync
  const replacement: { release: (() => void) | null } = { release: null }
  fs.rmdirSync = path => {
    if (path === lock) {
      fs.rmdirSync = rmdir
      syncBuiltinESMExports()
      replacement.release = trySessionRecordLockSync('lock-session')
      assert.ok(replacement.release, 'the complete replacement can atomically replace an ownerless directory')
    }
    return rmdir(path)
  }
  syncBuiltinESMExports()
  try {
    release()
    assert.equal(trySessionRecordLockSync('lock-session'), null)
  } finally {
    fs.rmdirSync = rmdir
    syncBuiltinESMExports()
    replacement.release?.()
  }
})

test('record acquisition preserves live legacy and unknown lock states, and cancellation leaves no claim', async () => {
  isolatedHome()
  const parent = join(runtimeRoot(), '.session-record-locks')
  const lock = join(parent, 'lock-session.lock')
  mkdirSync(parent, { recursive: true })
  for (const state of ['live legacy', 'empty legacy', 'invalid legacy', 'unknown directory', 'symlink']) {
    if (state === 'unknown directory') { mkdirSync(lock); writeFileSync(join(lock, 'unknown-owner'), 'retain') }
    else if (state === 'symlink') symlinkSync(join(parent, 'missing-target'), lock)
    else writeFileSync(lock, state === 'live legacy' ? String(process.pid) : state === 'empty legacy' ? '' : 'unprovable')
    const before = fs.lstatSync(lock).isDirectory() ? readdirSync(lock) : fs.lstatSync(lock).isSymbolicLink() ? fs.readlinkSync(lock) : readFileSync(lock, 'utf8')
    assert.equal(trySessionRecordLockSync('lock-session'), null, `${state} remains nonblocking busy`)
    await assert.rejects(() => withSessionRecordLock('lock-session', async () => assert.fail('must stay fenced'), AbortSignal.timeout(40)), { name: 'AbortError' })
    const after = fs.lstatSync(lock).isDirectory() ? readdirSync(lock) : fs.lstatSync(lock).isSymbolicLink() ? fs.readlinkSync(lock) : readFileSync(lock, 'utf8')
    assert.deepEqual(after, before, `${state} is preserved`)
    assert.deepEqual(readdirSync(parent), ['lock-session.lock'], 'cancelled attempts remove their own unpublished claims')
    rmSync(lock, { recursive: true, force: true })
  }
})

test('EPERM and unknown process-probe errors do not prove an owner dead', async () => {
  isolatedHome()
  const lock = join(runtimeRoot(), '.session-record-locks', 'lock-session.lock')
  mkdirSync(join(runtimeRoot(), '.session-record-locks'), { recursive: true })
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(dead, 'exit')
  writeFileSync(lock, String(dead.pid))
  const kill = process.kill
  try {
    for (const code of ['EPERM', 'EACCES', 'EIO']) {
      process.kill = (pid, signal) => {
        if (pid === dead.pid && signal === 0) throw Object.assign(new Error('unprovable owner'), { code })
        return kill(pid, signal)
      }
      await assert.rejects(() => withSessionRecordLock('lock-session', async () => assert.fail('must stay fenced'), AbortSignal.timeout(40)), { name: 'AbortError' })
      assert.equal(readFileSync(lock, 'utf8'), String(dead.pid))
    }
  } finally { process.kill = kill }
})

test('an EPERM rename collision remains busy, while an unrelated rename denial is surfaced', async () => {
  isolatedHome()
  const lock = join(runtimeRoot(), '.session-record-locks', 'lock-session.lock')
  const release = trySessionRecordLockSync('lock-session')!
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === lock) throw Object.assign(new Error('rename denied'), { code: 'EPERM' })
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try {
    assert.equal(trySessionRecordLockSync('lock-session'), null)
    await assert.rejects(() => withSessionRecordLock('lock-session', async () => assert.fail('must stay fenced'), AbortSignal.timeout(40)), { name: 'AbortError' })
    release()
    assert.throws(() => trySessionRecordLockSync('lock-session'), /rename denied/)
  } finally {
    fs.renameSync = rename
    syncBuiltinESMExports()
    release()
  }
})

for (const phase of ['publication', 'reclamation']) test(`a process crash during ${phase} leaves no false live owner`, { timeout: 10_000 }, async () => {
  isolatedHome()
  const fixture = mkdtempSync(join(tmpdir(), 'spex-lock-crash-'))
  const ready = join(fixture, 'ready')
  const lock = join(runtimeRoot(), '.session-record-locks', 'crash.lock')
  mkdirSync(join(runtimeRoot(), '.session-record-locks'), { recursive: true })
  if (phase === 'reclamation') {
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await once(dead, 'exit')
    mkdirSync(lock)
    writeFileSync(join(lock, `${dead.pid}-${randomUUID()}`), '')
  }
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { withSessionRecordLock } from ${JSON.stringify(fileURLToPath(new URL('./session-record-lock.ts', import.meta.url)))};
    const method = ${JSON.stringify(phase === 'publication' ? 'renameSync' : 'rmdirSync')};
    const original = fs[method];
    fs[method] = (...args) => {
      if (args[${phase === 'publication' ? 1 : 0}] === ${JSON.stringify(lock)}) {
        fs.writeFileSync(${JSON.stringify(ready)}, 'at crash boundary');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return original(...args);
    };
    syncBuiltinESMExports();
    await withSessionRecordLock('crash', async () => { throw new Error('must be killed before ownership'); });
  `
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const done = once(child, 'exit')
  let errors = ''
  child.stderr!.setEncoding('utf8').on('data', chunk => { errors += chunk })
  try {
    const deadline = Date.now() + 5_000
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error(`timed out at ${phase}: ${errors}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    child.kill('SIGKILL')
    const [, signal] = await done
    assert.equal(signal, 'SIGKILL')
    if (phase === 'reclamation') assert.deepEqual(readdirSync(lock), [], 'the crashed reclaimer left only an ownerless directory')
    else assert.equal(existsSync(lock), false, 'an incomplete unpublished claim is never the active lock')
    await withSessionRecordLock('crash', async () => { assert.equal(readdirSync(lock).length, 1) })
    assert.equal(existsSync(lock), false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('worktree registry fence crosses processes, linked checkouts and homes while other repositories progress', { timeout: 15_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'spex-registry-lock-'))
  const project = join(fixture, 'project'), sibling = join(fixture, 'sibling'), other = join(fixture, 'other'), alias = join(fixture, 'alias')
  const trace = join(fixture, 'trace')
  for (const root of [project, other]) {
    mkdirSync(root)
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', root, '-c', 'user.name=lock-fixture', '-c', 'user.email=lock@example.test', 'commit', '-qm', 'fixture', '--allow-empty'])
  }
  execFileSync('git', ['-C', project, 'worktree', 'add', '-qb', 'sibling', sibling])
  symlinkSync(project, alias, 'dir')
  const children: ReturnType<typeof spawn>[] = []
  const start = (id: string, cwd: string, hold = false, abort = false) => {
    const script = `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { withWorktreeRegistryLock } from ${JSON.stringify(fileURLToPath(new URL('./session-record-lock.ts', import.meta.url)))};
      writeFileSync(${JSON.stringify(join(fixture, `${id}-started`))}, 'started');
      try {
        await withWorktreeRegistryLock(async () => {
          appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`${id} enter\n`)});
          writeFileSync(${JSON.stringify(join(fixture, `${id}-entered`))}, 'entered');
          ${hold ? "await new Promise(resolve => process.stdin.once('data', resolve));" : ''}
          appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(`${id} leave\n`)});
        }, ${abort ? 'AbortSignal.timeout(100)' : 'undefined'});
      } catch (error) {
        if (${abort} && error.name === 'AbortError') writeFileSync(${JSON.stringify(join(fixture, `${id}-aborted`))}, 'aborted');
        else throw error;
      }
    `
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
      cwd, env: { ...process.env, SPEXCODE_HOME: join(fixture, `${id}-home`) }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    let errors = ''
    child.stderr!.setEncoding('utf8').on('data', chunk => { errors += chunk })
    const done = once(child, 'exit').then(([code, signal]) => { assert.equal(code, 0, `${id} exited with ${signal}: ${errors}`) })
    return { child, done }
  }
  const waitForFile = async (name: string) => {
    const deadline = Date.now() + 5_000
    while (!existsSync(join(fixture, name))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    const holder = start('holder', project, true)
    await waitForFile('holder-entered')
    const waiter = start('waiter', sibling)
    await waitForFile('waiter-started')
    const independent = start('other', other)
    await independent.done
    assert.equal(existsSync(join(fixture, 'waiter-entered')), false, 'a different home and candidate cannot enter the shared physical registry')
    const cancelled = start('cancelled', alias, false, true)
    await cancelled.done
    assert.equal(existsSync(join(fixture, 'cancelled-aborted')), true, 'registry acquisition honors cancellation')
    holder.child.stdin!.end('release')
    await Promise.all([holder.done, waiter.done])
    const events = readFileSync(trace, 'utf8').trim().split('\n')
    assert.ok(events.indexOf('other leave') < events.indexOf('holder leave'), 'a different repository completes while this holder is still running')
    assert.ok(events.indexOf('holder leave') < events.indexOf('waiter enter'))

    const dead = start('dead', alias, true)
    // This holder is intentionally killed, so consume its expected nonzero-exit assertion separately.
    const deadResult = dead.done.catch(error => error)
    await waitForFile('dead-entered')
    dead.child.kill('SIGKILL')
    assert.ok(await deadResult instanceof Error)
    await start('reclaimed', sibling).done
    assert.equal(existsSync(join(fixture, 'reclaimed-entered')), true, 'the same filesystem primitive reclaims a dead owner')
    assert.equal(existsSync(join(project, '.git', 'spex-worktree-registry.lock')), false)
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')))
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('a delivery claim never waits: a live holder answers null, a dead holder is reclaimed', async () => {
  isolatedHome()
  const release = claimDeliveryLock('claimed')
  assert.ok(release)
  assert.equal(claimDeliveryLock('claimed'), null)
  release!()
  const lock = join(runtimeRoot(), '.delivery-locks', 'claimed.lock')
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  try {
    writeFileSync(lock, String(holder.pid))
    const started = Date.now()
    assert.equal(claimDeliveryLock('claimed'), null, 'another live process holds the queue')
    assert.ok(Date.now() - started < 1_000)
  } finally {
    holder.kill()
    await once(holder, 'exit')
  }
  const reclaimed = claimDeliveryLock('claimed')
  assert.ok(reclaimed, 'the lock of a process that is gone is taken over')
  reclaimed!()
})

test('delivery locks acquire ids in sorted unique order and release on failure', async () => {
  isolatedHome()
  const seen: string[] = []
  await withDeliveryLocks(['b', 'a', 'b'], async () => { seen.push('body') })
  assert.deepEqual(seen, ['body'])
  await assert.rejects(() => withDeliveryLocks(['a'], async () => { throw new Error('delivery boom') }), /delivery boom/)
  await withDeliveryLocks(['a'], async () => { seen.push('reused') })
  assert.deepEqual(seen, ['body', 'reused'])
})
