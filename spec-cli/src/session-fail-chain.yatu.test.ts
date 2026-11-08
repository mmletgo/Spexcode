// YATU for the FAILED-TURN CHAIN, end to end through the shipped artifacts.
//
// Every existing test of this path enters at `spex internal session-fail` or runs `fail.sh` against a fake
// `spex`. That leaves the part that actually broke in the field untested: the materialized shim, the
// dispatcher, the manifest, the real CLI, the compare-and-set, and the board projection, in one line. A
// session whose turn dies does NOT exit — its rendezvous listener keeps answering, so liveness stays online
// and the board paints `working` on an agent that is doing nothing. Only this chain corrects that, and the
// only honest way to know it still runs is to drive a real StopFailure into a real session's own worktree
// and read the board back over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fakeLauncher = join(packageRoot, 'test', 'fixtures', 'fake-claude')
const cliArgs = ['--import', import.meta.resolve('tsx'), join(packageRoot, 'src', 'cli.ts')]

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

const run = async (command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  input?: string
}): Promise<{ status: number | null; stdout: string; stderr: string }> => {
  // The shim may spawn a CLI handler; abort its owned group so the handler cannot outlive the fixture.
  const child = spawn(command, args, {
    cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
  const abort = () => signalGroup(child, 'SIGKILL')
  signal.addEventListener('abort', abort, { once: true })
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    child.stdin.end(options.input)
    if (signal.aborted) abort()
    const status = await closed
    signal.throwIfAborted()
    assert.equal(status, 0, 'fixture command must exit successfully')
    return { status, stdout, stderr }
  } catch (cause) {
    throw new Error(`fixture ${command} failed (exit=${child.exitCode}, signal=${child.signalCode}):\n${stderr}\n${stdout}`, { cause })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

const freePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port
    server.close(() => resolve(port))
  })
})

const waitFor = async <T>(read: (signal: AbortSignal) => Promise<T>, accept: (value: T) => boolean, label: string, parentSignal: AbortSignal, timeoutMs = 30_000): Promise<T> => {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
  let value: T | undefined
  try {
    for (;;) {
      signal.throwIfAborted()
      value = await read(signal)
      if (accept(value)) return value
      await delay(150, undefined, { signal })
    }
  } catch (cause) {
    throw new Error(`failed waiting for ${label}: ${JSON.stringify(value)}`, { cause })
  }
}

const json = async (base: string, path: string, init: RequestInit = {}): Promise<any> => {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000)
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal })
    const text = await response.text()
    try {
      return { status: response.status, body: JSON.parse(text) }
    } catch {
      return { status: response.status, body: null, text }
    }
  } catch (cause) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed`, { cause })
  }
}

test('a real StopFailure drives a live session to error through the shipped shim', { timeout: 180_000 }, async (t) => {
  const port = await freePort()
  const home = mkdtempSync(join(tmpdir(), 'spex-failchain-home-'))
  const project = mkdtempSync(join(tmpdir(), 'spex-failchain-project-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SPEXCODE_HOME: home,
    SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'),
    CODEX_HOME: join(home, 'codex-home'),
    SPEXCODE_TMUX: `spex-failchain-${process.pid}-${Date.now()}`,
    FAKE_HARNESS_INTERVAL_MS: '80',
  }
  delete env.SPEX_SESSION_CONFIG
  delete env.SPEXCODE_API_URL
  delete env.SPEXCODE_SESSION_ID
  const base = `http://127.0.0.1:${port}`
  let backend: ReturnType<typeof spawn> | undefined
  let backendClosed: Promise<void> | undefined
  let log = ''
  let id = ''
  let stage = 'fixture setup'
  t.after(async () => {
    const bodyStage = stage
    const errors: unknown[] = []
    let resourcesStopped = true
    try {
      stage = 'cleanup: session close'
      if (id) {
        const closed = await json(base, `/api/sessions/${id}/close`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
        assert.equal(closed.status, 200, JSON.stringify(closed))
      }
    } catch (error) {
      errors.push(error)
      t.diagnostic(`failed ${stage}: ${String(error)}`)
    }
    try {
      stage = 'cleanup: backend stop'
      if (backend && backendClosed) {
        signalGroup(backend, 'SIGTERM')
        const stopped = await Promise.race([
          backendClosed.then(() => true),
          delay(3_000, false, { ref: false }),
        ])
        if (!stopped) signalGroup(backend, 'SIGKILL')
        assert.equal(await Promise.race([
          backendClosed.then(() => true),
          delay(3_000, false, { ref: false }),
        ]), true, 'fixture backend must close after SIGKILL')
      }
    } catch (error) {
      resourcesStopped = false
      errors.push(error)
      t.diagnostic(`failed ${stage}: ${String(error)}`)
    }
    try {
      stage = 'cleanup: private tmux stop'
      const tmux = spawnSync('tmux', ['-L', env.SPEXCODE_TMUX!, 'kill-server'], {
        env, timeout: 5_000, killSignal: 'SIGKILL', encoding: 'utf8',
      })
      if (tmux.error) throw tmux.error
      assert.ok(tmux.status === 0 || (tmux.status === 1 && /no server running|No such file or directory/.test(tmux.stderr)), `fixture tmux cleanup failed: ${tmux.stderr}`)
    } catch (error) {
      resourcesStopped = false
      errors.push(error)
      t.diagnostic(`failed ${stage}: ${String(error)}`)
    }
    t.diagnostic(`body stage: ${bodyStage}; backend pid=${backend?.pid} exit=${backend?.exitCode} signal=${backend?.signalCode}`)
    if (bodyStage !== 'board verified' || errors.length || backend?.exitCode) t.diagnostic(`backend output:\n${log}`)
    if (resourcesStopped) {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
      t.diagnostic('cleanup complete: backend closed, private tmux stopped, fixture directories removed')
    }
    if (errors.length) throw new AggregateError(errors, 'StopFailure fixture cleanup failed')
  })
  mkdirSync(join(project, '.spec'), { recursive: true })
  writeFileSync(join(project, '.spec/spexcode.json'), JSON.stringify({
    harnesses: ['claude'],
    sessions: { launchers: { fake: { harness: 'claude', cmd: fakeLauncher } }, defaultLauncher: 'fake' },
  }, null, 2) + '\n')
  const setup = { cwd: project, env, signal: t.signal }
  await run('git', ['init', '-q', '-b', 'main'], setup)
  await run('git', ['config', 'user.email', 'fixture@example.test'], setup)
  await run('git', ['config', 'user.name', 'fixture'], setup)
  // a REAL `spex init`, not a hand-written spec.md: the core plugin nodes it seeds are what materialize
  // renders into each tree's hook manifest, and this chain is exactly the thing a hand-built fixture
  // cannot stand in for. A tree whose manifest carries no StopFailure line dispatches nothing and exits 0.
  stage = 'real init'
  await run(process.execPath, [...cliArgs, 'init', '.', '--harness', 'claude'], setup)
  await run('git', ['add', '-A'], setup)
  stage = 'fixture seed commit'
  await run('git', ['commit', '-qm', 'fixture seed', '--no-verify'], setup)

  stage = 'backend health'
  backend = spawn(process.execPath, [...cliArgs, 'serve', '--port', String(port)], {
    cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendClosed = new Promise((resolve) => {
    backend!.once('close', () => resolve())
  })
  backend.on('error', (error) => {
    log += `${error.stack}\n`
  })
  backend.stdout!.on('data', (chunk) => {
    log += chunk
  })
  backend.stderr!.on('data', (chunk) => {
    log += chunk
  })
  try {
    await waitFor(async (signal) => {
      try {
        return (await fetch(`${base}/health`, { signal })).status
      } catch (error) {
        signal.throwIfAborted()
        if (backend!.exitCode !== null || backend!.signalCode !== null) throw error
        return 0
      }
    }, (status) => status === 200, 'backend health', t.signal)

    stage = 'session create'
    const created = await json(base, '/api/sessions', {
      signal: t.signal,
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'failed turn chain', launcher: 'fake' }),
    })
    assert.equal(created.status, 201, JSON.stringify(created))
    id = created.body.id as string
    stage = 'session online'
    const online = await waitFor(async (signal) => (await json(base, `/api/sessions/${id}`, { signal })).body,
      (session: any) => session?.liveness === 'online', 'session online', t.signal)
    // `lifecycle` is the RECORD's status; `status` is the reconciled board projection. A live agent whose
    // turn has died keeps its listener, so liveness stays online and the projection reads `working` — which
    // is precisely the "stopped but still shows running" the human sees when this chain does not fire.
    assert.equal(online.lifecycle, 'active', JSON.stringify(online))
    assert.equal(online.status, 'working', JSON.stringify(online))

    // THE SHIPPED SHIM, not a hand-built command. If materialize stopped writing the tree's own settings —
    // the exact regression that silently disabled every nested Claude session's lifecycle hooks — there is
    // no command here to run and this fails before any payload is decoded.
    const worktree = online.path
    assert.ok(worktree && existsSync(worktree), `session worktree exists: ${worktree}`)
    const shimFile = join(worktree, '.claude', 'settings.json')
    assert.ok(existsSync(shimFile), 'the session worktree carries its own Claude shim')
    const shim = JSON.parse(readFileSync(shimFile, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const command = shim.hooks.StopFailure?.flatMap((entry) => entry.hooks.map((hook) => hook.command))
      .find((candidate) => candidate.includes('StopFailure'))
    assert.ok(command, `the shim binds StopFailure: ${JSON.stringify(shim.hooks && Object.keys(shim.hooks))}`)

    // A SUBAGENT's dead turn first: same event, same session id, plus the payload's own agent_id stamp.
    // It must change nothing — a helper the session spawned may not mark the session that spawned it dead.
    const fire = (payload: unknown) => run('bash', ['-c', command!], {
      cwd: worktree, input: JSON.stringify(payload), signal: t.signal,
      env: { ...env, CLAUDE_PROJECT_DIR: worktree, SPEXCODE_SESSION_ID: id },
    })
    stage = 'subagent StopFailure shim'
    const sub = await fire({ session_id: id, agent_id: 'agent_01', hook_event_name: 'StopFailure', error: 'api_error' })
    assert.equal(sub.status, 0, sub.stderr)
    await delay(400, undefined, { signal: t.signal })
    const afterSub = (await json(base, `/api/sessions/${id}`, { signal: t.signal })).body
    assert.equal(afterSub.lifecycle, 'active', `a subagent's failure must not mark the parent: ${JSON.stringify(afterSub)}`)

    // now the session's OWN failed turn
    stage = 'own StopFailure shim'
    const own = await fire({ session_id: id, hook_event_name: 'StopFailure', error: 'api_error', error_details: 'Invalid bearer token' })
    const trace = `rc=${own.status} stdout=${JSON.stringify(own.stdout)} stderr=${JSON.stringify(own.stderr)}`
    assert.equal(own.status, 0, trace)
    assert.doesNotMatch(own.stderr || '', /handler .* exited/, `the dispatcher reported a handler failure: ${trace}`)
    stage = 'canonical error projection'
    const errored = await waitFor(async (signal) => (await json(base, `/api/sessions/${id}`, { signal })).body,
      (session: any) => session?.lifecycle === 'error', `session reaches error (${trace})`, t.signal, 20_000)
    assert.equal(errored.lifecycle, 'error', JSON.stringify(errored))
    assert.equal(errored.status, 'error', `the projection stops painting a dead turn as working: ${JSON.stringify(errored)}`)

    // and the BOARD says so — the projection the human actually reads, not only the record.
    stage = 'board HTTP projection'
    const board = (await json(base, '/api/graph', { signal: t.signal })).body
    const row = (board.sessions as Array<{ id: string; status: string }>).find((candidate) => candidate.id === id)
    assert.equal(row?.status, 'error', `the board row carries the failure: ${JSON.stringify(row)}`)
    stage = 'board verified'
  } catch (error) {
    t.diagnostic(`failed body stage: ${stage}`)
    throw error
  }
})
