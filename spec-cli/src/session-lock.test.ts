import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runtimeRoot } from '@spexcode/spec-core'

import { claimDeliveryLock, withDeliveryLocks } from './delivery-lock.js'
import { trySessionRecordLockSync, withSessionRecordLock } from './session-record-lock.js'

const isolatedHome = (): void => { process.env.SPEXCODE_HOME = mkdtempSync(join(tmpdir(), 'spex-lock-')) }

test('record lock excludes a second local writer and releases after the body', () => {
  isolatedHome()
  const release = trySessionRecordLockSync('lock-session')
  assert.ok(release)
  assert.equal(trySessionRecordLockSync('lock-session'), null)
  release!()
  assert.ok(trySessionRecordLockSync('lock-session'))
})

test('record lock releases when an async operation throws', async () => {
  isolatedHome()
  await assert.rejects(() => withSessionRecordLock('lock-session', async () => { throw new Error('boom') }), /boom/)
  assert.ok(trySessionRecordLockSync('lock-session'))
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
