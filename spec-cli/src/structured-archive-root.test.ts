import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeRoot, sessionRecordPath } from '@spexcode/spec-core'
import { codexGenerationSocketPath, type CodexGenerationEndpoint } from './codex-runtime-generations.js'
import { codexHarness } from './codex-harness.js'
import { processStartToken, spawnDetachedRuntime } from './runtime-ownership.js'
import type { StructuredExecution } from './session-structured-policy.js'
import { assertSessionStopSafe } from './host-resources.js'
import { initializeFreshSessionApplication } from './session-application.js'

const v1Execution = (threadId?: string): StructuredExecution => ({
  version: 1,
  policy: 'codex-read-only-v1',
  schema: { type: 'object' },
  inputDigest: 'fixed-input',
  purpose: 'archive route regression',
  timeoutMs: 1000,
  ...(threadId ? { threadId } : {}),
})

const v2Execution = (threadId?: string): StructuredExecution => ({
  version: 2,
  policy: 'codex-frozen-read-only-v2',
  schema: { type: 'object' },
  inputDigest: 'fixed-input',
  purpose: 'archive route regression',
  timeoutMs: 1000,
  frozenContext: { version: 1, contextDigest: 'context-digest', manifestPath: '/fixture/manifest.json' },
  readerRuntime: { version: 1, cliVersion: 'codex-cli 0.160.0', catalogDigest: 'a'.repeat(64), catalogPath: '/fixture/catalog.json' },
  ...(threadId ? { threadId } : {}),
})

async function writeGoneBinding(controlRoot: string, sessionId: string, threadId: string): Promise<CodexGenerationEndpoint> {
  const generationId = `detached-v3-${sessionId}`
  const generationDir = join(controlRoot, 'codex-app-server-generations', generationId)
  const endpoint: CodexGenerationEndpoint = {
    id: generationId,
    pidFile: join(generationDir, 'pid'),
    receiptFile: join(generationDir, 'detached.json'),
    logFile: join(generationDir, 'app-server.log'),
    socketPath: codexGenerationSocketPath(controlRoot, generationId, join(controlRoot, 'sockets')),
  }
  mkdirSync(generationDir, { recursive: true })
  const identity = spawnDetachedRuntime({
    cwd: generationDir,
    logFile: endpoint.logFile,
    pidFile: endpoint.pidFile,
    receiptFile: endpoint.receiptFile,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  })
  process.kill(identity.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 100 && processStartToken(identity.pid) === identity.startToken; attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  assert.notEqual(processStartToken(identity.pid), identity.startToken, 'fixture generation process is positively gone')
  writeFileSync(join(controlRoot, 'codex-app-server-generations.json'), `${JSON.stringify({
    version: 3,
    revision: 1,
    current: generationId,
    pending: null,
    generations: { [generationId]: { state: 'current', endpoint } },
    bindings: { [sessionId]: { generationId, threadId } },
  })}\n`)
  return endpoint
}

test('structured Codex close routes v1 and v2 records to their exact control realm', { concurrency: false }, async () => {
  const previousHome = process.env.SPEXCODE_HOME
  const previousSocketDir = process.env.SPEXCODE_CODEX_SOCKET_DIR
  const home = mkdtempSync(join(tmpdir(), 'spex-structured-archive-route-'))
  process.env.SPEXCODE_HOME = home
  process.env.SPEXCODE_CODEX_SOCKET_DIR = join(home, 'sockets')
  try {
    for (const [sessionId, makeExecution] of [['structured-v1', v1Execution], ['structured-v2', v2Execution]] as const) {
      const threadId = `${sessionId}-thread`
      const execution = makeExecution(threadId)
      const runtime = execution.policy === 'codex-read-only-v1'
        ? join(runtimeRoot(), 'structured-read-only-v1')
        : join(runtimeRoot(), 'structured-frozen-read-only-v2', execution.readerRuntime!.catalogDigest)
      const controlRoot = join(runtime, 'control')
      const record = { session: sessionId, harnessSessionId: threadId, worktreePath: '/fixture/worktree', structuredExecution: execution }

      const endpoint = await writeGoneBinding(controlRoot, sessionId, threadId)
      assert.equal(codexHarness.targetDescriptorKey?.(record), `codex-app-server:${endpoint.id}`)
      assert.ok(codexHarness.sharedRuntimes?.(runtimeRoot(), record)?.some((descriptor) => descriptor.key === `codex-app-server:${endpoint.id}`))
      assert.deepEqual(await codexHarness.coldPreflight?.(record), { ok: true, alreadyCold: true })
      assert.deepEqual(await codexHarness.coldRuntime?.(record), { ok: true })
    }

    const ordinaryId = 'ordinary-session', ordinaryThread = 'ordinary-thread'
    const ordinaryEndpoint = await writeGoneBinding(runtimeRoot(), ordinaryId, ordinaryThread)
    const ordinary = { session: ordinaryId, harnessSessionId: ordinaryThread, worktreePath: '/fixture/worktree' }
    assert.equal(codexHarness.targetDescriptorKey?.(ordinary), `codex-app-server:${ordinaryEndpoint.id}`)
    assert.deepEqual(await codexHarness.coldPreflight?.(ordinary), { ok: true, alreadyCold: true })

    const wrongId = 'structured-wrong-binding', expectedThread = `${wrongId}-thread`
    const wrongRoot = join(runtimeRoot(), 'structured-read-only-v1', 'control')
    await writeGoneBinding(wrongRoot, wrongId, 'different-thread')
    const wrong = { session: wrongId, harnessSessionId: expectedThread, worktreePath: '/fixture/worktree', structuredExecution: v1Execution(expectedThread) }
    const wrongResult = await codexHarness.coldPreflight?.(wrong)
    assert.equal(wrongResult?.ok, false)
    if (wrongResult && !wrongResult.ok) assert.match(wrongResult.reason, /exact Codex generation binding/)

    const missingId = 'structured-canonical-only', missingThread = `${missingId}-thread`
    await writeGoneBinding(runtimeRoot(), missingId, missingThread)
    rmSync(join(wrongRoot, 'codex-app-server-generations.json'), { force: true })
    const missing = { session: missingId, harnessSessionId: missingThread, worktreePath: '/fixture/worktree', structuredExecution: v1Execution(missingThread) }
    assert.equal(codexHarness.targetDescriptorKey?.(missing), null, 'an empty structured ledger cannot fall through to the canonical legacy endpoint')
    const missingResult = await codexHarness.coldPreflight?.(missing)
    assert.equal(missingResult?.ok, false, 'a canonical binding cannot stand in for the missing structured realm binding')
    if (missingResult && !missingResult.ok) assert.match(missingResult.reason, /exact Codex generation binding/)
    for (const result of [
      await codexHarness.coldRetirementPreflight?.(missing),
      await codexHarness.coldRuntime?.(missing),
      await codexHarness.restoreRuntime?.(missing),
    ]) {
      assert.equal(result?.ok, false)
      if (result && !result.ok) assert.match(result.reason, /exact Codex generation binding/)
    }
  } finally {
    if (previousHome === undefined) delete process.env.SPEXCODE_HOME
    else process.env.SPEXCODE_HOME = previousHome
    if (previousSocketDir === undefined) delete process.env.SPEXCODE_CODEX_SOCKET_DIR
    else process.env.SPEXCODE_CODEX_SOCKET_DIR = previousSocketDir
    rmSync(home, { recursive: true, force: true })
  }
})

test('structured live target reaches its own shared-runtime stop guard', { concurrency: false }, async () => {
  const previousHome = process.env.SPEXCODE_HOME
  const previousDatabasePath = process.env.SPEX_SESSION_DATABASE_PATH
  const previousSocketDir = process.env.SPEXCODE_CODEX_SOCKET_DIR
  const home = mkdtempSync(join(tmpdir(), 'spex-structured-live-stop-'))
  process.env.SPEXCODE_HOME = home
  process.env.SPEX_SESSION_DATABASE_PATH = join(home, 'sessions.sqlite')
  process.env.SPEXCODE_CODEX_SOCKET_DIR = join(home, 'sockets')
  const sessionId = 'structured-live-target'
  const threadId = 'structured-live-thread'
  const execution = v1Execution(threadId)
  const controlRoot = join(runtimeRoot(), 'structured-read-only-v1', 'control')
  const generationId = `detached-v3-${sessionId}`
  const generationDir = join(controlRoot, 'codex-app-server-generations', generationId)
  const endpoint: CodexGenerationEndpoint = {
    id: generationId,
    pidFile: join(generationDir, 'pid'),
    receiptFile: join(generationDir, 'detached.json'),
    logFile: join(generationDir, 'app-server.log'),
    socketPath: codexGenerationSocketPath(controlRoot, generationId, join(controlRoot, 'sockets')),
  }
  mkdirSync(generationDir, { recursive: true })
  const identity = spawnDetachedRuntime({
    cwd: generationDir,
    logFile: endpoint.logFile,
    pidFile: endpoint.pidFile,
    receiptFile: endpoint.receiptFile,
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
  })
  try {
    const application = initializeFreshSessionApplication()
    const recordPath = sessionRecordPath(sessionId)
    mkdirSync(join(runtimeRoot(), 'sessions', sessionId), { recursive: true })
    writeFileSync(recordPath, `${JSON.stringify({
      session_id: sessionId,
      governed: true,
      worktree_path: '/fixture/worktree',
      branch: 'node/structured-live-target',
      title: null,
      name: null,
      parent: null,
      status: 'awaiting',
      proposal: 'nothing',
      merges: 0,
      note: null,
      sortkey: null,
      createdAt: Date.now(),
      harness: 'codex-headless',
      harness_session_id: threadId,
      structured_execution: execution,
      stopped: false,
      archived: false,
      launcher: 'codex',
      launch_cmd: 'codex',
    })}\n`)
    application.createSession({ sessionId, status: 'awaiting', proposal: 'nothing' })
    writeFileSync(join(controlRoot, 'codex-app-server-generations.json'), `${JSON.stringify({
      version: 3,
      revision: 1,
      current: generationId,
      pending: null,
      generations: { [generationId]: { state: 'current', endpoint } },
      bindings: { [sessionId]: { generationId, threadId } },
    })}\n`)

    await assert.rejects(
      () => assertSessionStopSafe(sessionId, { session: sessionId, harness: 'codex-headless' }),
      /target thread structured-live-thread is unknown: Codex shared app-server generation is unproven/,
      'the live structured generation is the descriptor whose mutation guard blocks stopping',
    )
    assert.equal(processStartToken(identity.pid), identity.startToken, 'the shared generation remains alive after the guard refuses')
  } finally {
    if (processStartToken(identity.pid) === identity.startToken) {
      try { process.kill(identity.pid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      for (let attempt = 0; attempt < 50 && processStartToken(identity.pid) === identity.startToken; attempt++)
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    if (previousHome === undefined) delete process.env.SPEXCODE_HOME
    else process.env.SPEXCODE_HOME = previousHome
    if (previousDatabasePath === undefined) delete process.env.SPEX_SESSION_DATABASE_PATH
    else process.env.SPEX_SESSION_DATABASE_PATH = previousDatabasePath
    if (previousSocketDir === undefined) delete process.env.SPEXCODE_CODEX_SOCKET_DIR
    else process.env.SPEXCODE_CODEX_SOCKET_DIR = previousSocketDir
    rmSync(home, { recursive: true, force: true })
  }
})
