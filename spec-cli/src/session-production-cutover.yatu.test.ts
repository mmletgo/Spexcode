import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { migrateJsonSessionRecords, openProjectSessionApplication } from '@spexcode/session-application'

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
  try { await exited } finally { clearTimeout(timer) }
}

for (const mode of ['available', 'occupied', 'redirect', 'malformed-json'] as const) test(`YATU cutover matrix: ten distinct stories through the backend HTTP and migration CLI surfaces (${mode} port)`, { timeout: 180_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'spex-session-cutover-http-'))
  const project = join(fixture, 'project')
  const home = join(fixture, 'home')
  const bin = join(fixture, 'bin')
  const databasePath = join(home, 'sessions.sqlite')
  mkdirSync(join(project, '.spec', 'project'), { recursive: true }); mkdirSync(home); mkdirSync(bin)
  writeFileSync(join(project, '.spec', 'project', 'spec.md'), '---\ntitle: fixture\nstatus: active\n---\n# fixture\n')
  writeFileSync(join(project, '.spec/spexcode.json'), '{"harnesses":["claude"]}\n')
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\n[ "$1" = "-V" ] && { echo "tmux 3.4"; exit 0; }\nexit 1\n'); chmodSync(join(bin, 'tmux'), 0o755)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project }); execFileSync('git', ['config', 'user.email', 'yatu@example.test'], { cwd: project }); execFileSync('git', ['config', 'user.name', 'YATU'], { cwd: project }); execFileSync('git', ['add', '.'], { cwd: project }); execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: project })
  // the test worker pins the canonical database beside its own home; this fixture owns a different home
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ''}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: databasePath }
  const records = join(fixture, 'legacy')
  mkdirSync(join(records, 'migrated'), { recursive: true })
  writeFileSync(join(records, 'migrated', 'session.json'), JSON.stringify({ session_id: 'migrated', status: 'active', parent: null, createdAt: 1 }))
  const firstMigration = migrateJsonSessionRecords({ databasePath, recordsRoot: records, locality: () => {} })
  const secondMigration = migrateJsonSessionRecords({ databasePath, recordsRoot: records, locality: () => {} })
  assert.equal(firstMigration.replayed, false)
  assert.equal(secondMigration.replayed, true)
  const seed = openProjectSessionApplication({ databasePath, locality: () => {} })
  for (const id of ['parent', 'child', 'parent2', 'watch1', 'watch2', 'batch', 'batchw', 'pub', 'pubw', 'a', 'aw', 'b', 'bw']) seed.createSession({ sessionId: id })
  seed.transitionSession('child', { parentSessionId: 'parent' }); seed.close()
  // The owning backend discovers governed watcher records from the runtime store before it reconciles
  // canonical event cursors. The old direct-recipient route needed no envelope, but the current cutover
  // contract does, so keep this HTTP fixture shaped like a real adopted project.
  const runtimeSessions = join(home, 'projects', project.replace(/[/.]/g, '-'), 'sessions')
  for (const id of ['parent', 'child', 'parent2', 'watch1', 'watch2', 'batch', 'batchw', 'pub', 'pubw', 'a', 'aw', 'b', 'bw']) {
    const dir = join(runtimeSessions, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'runtime.json'), `${JSON.stringify({
      session_id: id, governed: true, worktree_path: project, branch: 'main', title: id, name: '',
      harness: 'claude', harness_session_id: '', stopped: false, archived: false,
    })}\n`)
  }
  let backend: ChildProcess | null = null
  let base: string | null = null
  let occupiedPort: number | undefined
  let occupiedStarts = 0
  const foreignRequests: string[] = []
  let foreignProbes = 0
  const foreign = mode !== 'available' ? createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') { response.end('ok'); return }
    if (request.method === 'GET' && request.url === '/api/instance') {
      foreignProbes++
      if (mode === 'redirect') {
        response.writeHead(302, { location: '/readiness-redirect-trap' }).end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(mode === 'malformed-json'
        ? (foreignProbes % 2 === 1 ? '' : '{"pid":')
        : JSON.stringify({ instanceId: 'other-fixture', pid: process.pid, root: project }))
      return
    }
    foreignRequests.push(`${request.method} ${request.url}`)
    response.writeHead(409).end()
  }) : undefined
  const indexPath = join(process.cwd(), 'src/index.ts')
  const stopBackend = async () => {
    base = null
    if (backend) await stop(backend)
  }
  const start = async (label: string): Promise<void> => {
    const deadline = Date.now() + 30_000
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      const port = (attempt === 0 ? occupiedPort : undefined) ?? await freePort()
      const address = `127.0.0.1:${port}`, instanceId = randomUUID()
      const child = backend = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), indexPath], {
        cwd: project, env: { ...env, PORT: String(port), SPEXCODE_INSTANCE_ID: instanceId }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let closed = false, log = ''
      child.once('close', () => { closed = true })
      child.stdout?.on('data', chunk => { log += String(chunk) })
      child.stderr?.on('data', chunk => { log += String(chunk) })
      for (;;) {
        if (closed) {
          if (log.includes(`listen EADDRINUSE: address already in use ${address}`)) {
            if (port === occupiedPort) occupiedStarts++
            break
          }
          throw new Error(`${label}: backend exited before readiness (entry=${indexPath}, cwd=${project}, exit=${child.exitCode}, signal=${child.signalCode ?? 'none'}, output=${log || '<empty>'})`)
        }
        const instance = await fetch(`http://${address}/api/instance`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
          .then(async response => {
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null
            try { return await response.json() as { pid: number; instanceId: string | null; root: string } }
            catch (error) { if (error instanceof SyntaxError) return null; throw error }
          }).catch((error: unknown) => {
            const code = (error as { cause?: { code?: string } }).cause?.code
            if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || error instanceof DOMException && error.name === 'TimeoutError') return null
            throw error
          })
        if (instance && instance.pid === child.pid) {
          assert.equal(instance.instanceId, instanceId, `${label}: unexpected backend instance`)
          assert.equal(realpathSync(instance.root), realpathSync(project), `${label}: unexpected backend project`)
          base = `http://${address}`
          return
        }
        if (Date.now() >= deadline) throw new Error(`${label}: backend readiness timeout (entry=${indexPath}, cwd=${project}, pid=${child.pid}, exit=${child.exitCode ?? 'running'}, signal=${child.signalCode ?? 'none'}, output=${log || '<empty>'})`)
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    }
    throw new Error(`${label}: fixture could not acquire a loopback port after address conflicts`)
  }
  const request = async (path: string, init?: RequestInit): Promise<any> => {
    assert.ok(base && backend && backend.exitCode === null && backend.signalCode === null, 'fixture backend is not ready')
    const response = await fetch(base + path, init); const text = await response.text()
    if (!response.ok) throw new Error(`${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }
  const post = (path: string, body: unknown) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const dequeueWhenReady = async (path: string): Promise<any> => {
    const deadline = Date.now() + 5_000
    for (;;) {
      const message = await post(path, { namespace: 'spex-governed' })
      if (message) return message
      if (Date.now() >= deadline) throw new Error(`timed out waiting for a queued message at ${path}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const results: Array<{ name: string; passed: boolean; error?: string }> = []
  const story = async (name: string, body: () => Promise<void>) => { try { await body(); results.push({ name, passed: true }) } catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }) } }
  try {
    if (foreign) {
      await new Promise<void>((resolve, reject) => foreign.listen(0, '127.0.0.1', resolve).once('error', reject))
      const address = foreign.address()
      assert.ok(address && typeof address === 'object')
      occupiedPort = address.port
    }
    await start('backend')
    await story('parent-child', async () => { const replay = await request('/api/session-runtime/child/replay'); assert.equal(replay.parentSessionId, 'parent') })
    await story('multiple-watchers', async () => { await post('/api/session-runtime/child/watch', { watcherSessionId: 'watch1' }); await post('/api/session-runtime/child/watch', { watcherSessionId: 'watch2' }) })
    await story('reparent', async () => { await post('/api/session-runtime/child/state', { parentSessionId: 'parent2', reason: 'http-reparent' }); assert.equal((await request('/api/session-runtime/child/replay')).parentSessionId, 'parent2') })
    await story('state-transition-replay', async () => { await post('/api/session-runtime/child/state', { status: 'active' }); await post('/api/session-runtime/child/state', { status: 'awaiting' }); assert.equal((await request('/api/session-runtime/child/replay')).status, 'awaiting') })
    await story('restart', async () => { await stopBackend(); await start('restart'); assert.equal((await request('/api/session-runtime/child/replay')).status, 'awaiting') })
    await story('generation-fencing', async () => { const first = await post('/api/session-runtime/watch1/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'w1', nativeStartToken: 'one' }); await post('/api/session-runtime/watch1/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'w1', nativeStartToken: 'two', expectedGeneration: first.bindingGeneration }); await assert.rejects(() => post('/api/session-runtime/watch1/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'w1', nativeStartToken: 'three', expectedGeneration: first.bindingGeneration })) })
    await story('ordered-batch-delivery', async () => { await post('/api/session-runtime/batch/watch', { watcherSessionId: 'batchw' }); await post('/api/session-runtime/batch/state', { status: 'active' }); await post('/api/session-runtime/batch/state', { status: 'awaiting' }); await post('/api/session-runtime/batchw/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'batchw', nativeStartToken: 'one' }); const one = await dequeueWhenReady('/api/session-runtime/batchw/dequeue'); const two = await dequeueWhenReady('/api/session-runtime/batchw/dequeue'); assert.ok(one.enqueueSeq < two.enqueueSeq) })
    await story('publish-before-after-watch', async () => { await post('/api/session-runtime/pub/publish', { kind: 'before', body: 'before' }); await post('/api/session-runtime/pub/watch', { watcherSessionId: 'pubw' }); await post('/api/session-runtime/pub/publish', { kind: 'after', body: 'after' }); await post('/api/session-runtime/pubw/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'pubw', nativeStartToken: 'one' }); const message = await post('/api/session-runtime/pubw/dequeue', { namespace: 'spex-governed' }); assert.equal(message.kind, 'after') })
    await story('independent-session-pairs', async () => { await post('/api/session-runtime/a/watch', { watcherSessionId: 'aw' }); await post('/api/session-runtime/b/watch', { watcherSessionId: 'bw' }); await post('/api/session-runtime/a/publish', { kind: 'pair-a', body: 'a' }); await post('/api/session-runtime/aw/bind', { namespace: 'spex-governed', runtimeKind: 'yatu', nativeSessionId: 'aw', nativeStartToken: 'one' }); const message = await post('/api/session-runtime/aw/dequeue', { namespace: 'spex-governed' }); assert.equal(message.kind, 'pair-a') })
    await story('one-time-migration-marker', async () => {
      assert.equal(secondMigration.markerPath, join(home, 'sessions.sqlite.json-migration.json'))
      assert.equal(secondMigration.backupRoot, join(home, 'sessions.sqlite.json-migration-backup'))
      const replay = await request('/api/session-runtime/migrated/replay')
      assert.deepEqual(replay, { sessionId: 'migrated', status: 'active', proposal: null, note: null, parentSessionId: null, updatedAtMs: 1 })
      const events = await request('/api/session-runtime/migrated/events')
      assert.equal(events.length, 1)
      assert.equal(events[0].type, 'session.state.changed.v1')
    })
    console.log(JSON.stringify({ mode, scenarios: results, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length }, null, 2))
    if (foreign) {
      assert.equal(occupiedStarts, 2, 'both starts encounter the intentionally occupied port')
      assert.ok(foreignProbes >= 2, 'the readiness client observed the competing listener')
      assert.deepEqual(foreignRequests, [], 'matrix operations must never reach the other listener')
    }
    assert.equal(results.length, 10); assert.equal(results.filter(result => !result.passed).length, 0)
  } finally {
    try { await stopBackend() }
    finally {
      try { if (foreign?.listening) await new Promise<void>((resolve, reject) => foreign.close(error => error ? reject(error) : resolve())) }
      finally { rmSync(fixture, { recursive: true, force: true }) }
    }
  }
})
