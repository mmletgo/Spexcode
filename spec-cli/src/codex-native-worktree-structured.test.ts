import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runtimeRoot, sessionRecordPath } from '@spexcode/spec-core'
import { codexHeadlessHarness } from './codex-harness.js'
import { assertCodexRejectedFinalSource, codexNativeWorktreeTurn, stopCodexNativeWorktreeTurn, type NativeCodexWorktreeState } from './codex-native-worktree-structured.js'
import { assertSessionStopSafe } from './host-resources.js'
import { nativeWorktreeResult } from './native-worktree-runtime.js'
import { initializeFreshSessionApplication } from './session-application.js'
import { rejectedFinalOutput, StructuredSessionError, type StructuredExecution } from './session-structured-policy.js'

const enabled = process.env.SPEXCODE_REAL_CODEX_WORKTREE_TEST === '1'
const model = 'gpt-5.4'
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function sendResponse(res: ServerResponse, item: Record<string, unknown>, n: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const response = { id: `resp_${n}`, object: 'response', created_at: 1, model, status: 'completed', output: [item],
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 17 } }
  for (const packet of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`event: ${packet.type}\ndata: ${JSON.stringify(packet)}\n\n`)
  res.end()
}

test('official Codex isolates read and edit, retains rejected output, reports quota and proves exact stop', { skip: !enabled, timeout: 90_000 }, async t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spex-codex-native-test-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const home = join(base, 'codex-home'), repo = join(base, 'repo'), realm = join(base, 'realm')
  mkdirSync(home); mkdirSync(repo)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous })
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0, 'test requires the installed Codex CLI')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'fixture.txt'), 'seed\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'seed')
  const baseCommit = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}')
  const worktree = (id: string): string => {
    const path = join(base, id)
    git(repo, 'worktree', 'add', '-q', '-b', `task-${id}`, path, baseCommit)
    return path
  }
  const readPath = worktree('read'), editPath = worktree('edit'), holdPath = worktree('hold'), sibling = worktree('sibling')
  const invalidPath = worktree('invalid'), quotaPath = worktree('quota')
  const hook = join(repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\ntest "$(cat fixture.txt)" = edited && echo hook-ran\n', { mode: 0o755 })
  type Mode = 'read' | 'edit' | 'hold' | 'invalid' | 'quota'
  let mode: Mode = 'read'
  let requests = 0
  let toolOutput = ''
  const endpointRequests: Array<Record<string, unknown>> = []
  let requestedHold!: () => void
  const holdStarted = new Promise<void>(resolve => { requestedHold = resolve })
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') { res.writeHead(404).end(); return }
    const data: Buffer[] = []
    for await (const chunk of req) data.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(data).toString()) as { input: Array<Record<string, unknown>> }
    requests++; endpointRequests.push(body)
    if (mode === 'hold') { requestedHold(); return }
    if (mode === 'quota') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Synthetic limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }))
      return
    }
    if (mode === 'invalid') {
      sendResponse(res, { id: `msg_${requests}`, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: '{"answer":7}', annotations: [] }] }, requests)
      return
    }
    const output = body.input.find(item => item.type === 'function_call_output')
    if (!output) {
      const workdir = mode === 'read' ? readPath : editPath
      const cmd = mode === 'read'
        ? 'cat fixture.txt; (printf changed > fixture.txt) 2>/dev/null || echo blocked'
        : [
          `printf 'edited\\n' > fixture.txt && git add fixture.txt && git commit -m edited`,
          `(touch ${JSON.stringify(join(sibling, 'outside.txt'))}) 2>/dev/null || echo outside-blocked`,
          `(git update-ref refs/heads/task-sibling HEAD) 2>/dev/null || echo branch-blocked`,
          `(git config test.forbidden true) 2>/dev/null || echo config-blocked`,
        ].join('; ')
      sendResponse(res, { id: `fc_${requests}`, type: 'function_call', status: 'completed', name: 'exec_command', call_id: `call_${mode}`,
        arguments: JSON.stringify({ cmd, workdir, yield_time_ms: 1000, max_output_tokens: 2000 }) }, requests)
      return
    }
    toolOutput = JSON.stringify(output.output)
    sendResponse(res, { id: `msg_${requests}`, type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: JSON.stringify({ answer: mode }), annotations: [] }] }, requests)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as { port: number }).port
  const mcpMarker = join(base, 'unexpected-mcp-start')
  writeFileSync(join(home, 'config.toml'), `model = "${model}"\nmodel_provider = "spex_fixture"\n[model_providers.spex_fixture]\nname = "Local test fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[mcp_servers."synthetic.unwanted"]\ncommand = "/usr/bin/touch"\nargs = [${JSON.stringify(mcpMarker)}]\n`)
  const setup = (run: Mode) => {
    const state: StructuredExecution & { codexNative?: NativeCodexWorktreeState } = { version: 6, policy: 'native-worktree-v1', nativeConfiguration: 'cli-config-v1',
      model: run === 'read' ? 'codex:default' : `codex:${model}`, timeoutMs: 20_000, schema, purpose: 'codex-test', inputDigest: sha(run),
      worktree: { baseCommit, tree, mode: run === 'edit' ? 'edit' : 'read' } }
    const controller = new AbortController()
    const callbacks = { onNative: async (stateUpdate: NativeCodexWorktreeState) => { state.codexNative = stateUpdate },
      onTurnStarting: async () => { state.turnStartRequested = true },
      onThread: async (id: string) => { state.threadId = id }, onTurn: async (id: string) => { state.turnId = id }, signal: controller.signal }
    return { state, callbacks, controller }
  }

  const read = setup('read')
  const reading = await codexNativeWorktreeTurn(realm, 'read', 'Read fixture.txt and report the requested object.', read.state, read.callbacks, readPath, 'default')
  assert.equal(reading.threadId, read.state.threadId); assert.equal(reading.turnId, read.state.turnId)
  assert.deepEqual(JSON.parse(reading.text), { answer: 'read' })
  assert.deepEqual(reading.nativeTokenUsage, { source: 'codex-turn-usage', totalInputTokens: 24, uncachedInputTokens: 20, cacheReadInputTokens: 4, outputTokens: 10, cacheWriteInputTokens: 0 })
  assert.match(toolOutput, /seed/); assert.match(toolOutput, /blocked/)
  assert.equal(nativeWorktreeResult(readPath, read.state.worktree!).headCommit, baseCommit)
  assert.equal(existsSync(join(home, 'sessions')), false, 'ephemeral Codex turn did not create a rollout')
  assert.equal(existsSync(join(home, 'history.jsonl')), false, 'native worktree turn did not write interactive history')
  assert.equal(existsSync(mcpMarker), false, 'configured MCP process remained disabled for the worktree turn')
  assert.equal(objectFormat(endpointRequests[0]).type, 'json_schema')
  const requestCount = requests
  const replayCallbacks = { onNative: async () => { assert.fail('replay must not spawn') }, onThread: async () => { assert.fail('replay must not create thread') },
    onTurn: async () => { assert.fail('replay must not dispatch') } }
  git(repo, 'worktree', 'remove', readPath)
  const state: typeof read.state = { ...read.state, state: 'completed', output: { answer: 'read' }, resultDigest: sha(reading.text),
    ...(reading.nativeTokenUsage ? { nativeTokenUsage: reading.nativeTokenUsage } : {}) }
  const sessionId = 'read'
  const record = { session: sessionId, harness: 'codex-headless', harnessSessionId: reading.threadId, structuredExecution: state }
  const application = initializeFreshSessionApplication()
  application.createSession({ sessionId, status: 'awaiting', proposal: 'nothing' })
  mkdirSync(join(runtimeRoot(), 'sessions', sessionId), { recursive: true })
  const runtimeRecord = {
    session_id: sessionId, governed: true, worktree_path: readPath, branch: 'task-read', status: 'awaiting', proposal: 'nothing',
    harness: record.harness, harness_session_id: record.harnessSessionId, launcher: record.harness, launch_cmd: 'codex', stopped: true,
    structured_execution: state, createdAt: Date.now(),
  }
  writeFileSync(sessionRecordPath(sessionId), JSON.stringify({ ...runtimeRecord, structured_execution: { ...state, state: 'running' } }))
  await assert.rejects(assertSessionStopSafe(sessionId, record), /exact ephemeral Codex worktree stop is unproven/)
  writeFileSync(sessionRecordPath(sessionId), JSON.stringify(runtimeRecord))
  assert.deepEqual(codexHeadlessHarness.sharedRuntimes?.(runtimeRoot(), record), [])
  assert.deepEqual(await codexHeadlessHarness.coldPreflight?.(record), { ok: true, alreadyCold: true })
  await assertSessionStopSafe(sessionId, record)
  assert.deepEqual(await codexHeadlessHarness.coldRuntime?.(record), { ok: true })
  assert.equal((await codexHeadlessHarness.coldPreflight?.({ ...record, session: 'other' }))?.ok, false)
  assert.equal((await codexHeadlessHarness.coldRetirementPreflight?.({ ...record, harnessSessionId: 'other' }))?.ok, false)
  assert.equal((await codexHeadlessHarness.coldRuntime?.({ ...record, structuredExecution: { ...state, state: 'running' } }))?.ok, false)
  assert.deepEqual(await codexNativeWorktreeTurn(realm, 'read', 'Read fixture.txt and report the requested object.', state, replayCallbacks, readPath), reading)
  assert.equal(requests, requestCount)
  await assert.rejects(codexNativeWorktreeTurn(realm, 'read', 'different prompt', state, replayCallbacks, readPath),
    (error: unknown) => error instanceof StructuredSessionError && error.code === 'stale_result')
  mode = 'edit'
  const edit = setup('edit')
  const editing = await codexNativeWorktreeTurn(realm, 'edit', 'Edit fixture.txt and commit.', edit.state, edit.callbacks, editPath, model)
  assert.deepEqual(JSON.parse(editing.text), { answer: 'edit' })
  assert.match(toolOutput, /outside-blocked/)
  assert.equal(existsSync(join(sibling, 'outside.txt')), false)
  assert.equal(readFileSync(join(editPath, 'fixture.txt'), 'utf8'), 'edited\n')
  assert.notEqual(nativeWorktreeResult(editPath, edit.state.worktree!).headCommit, baseCommit)
  assert.match(toolOutput, /hook-ran/)
  assert.match(toolOutput, /branch-blocked/)
  assert.match(toolOutput, /config-blocked/)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), baseCommit)
  assert.equal(git(sibling, 'rev-parse', 'HEAD'), baseCommit)

  mode = 'invalid'
  const invalid = setup('invalid')
  const invalidPrompt = 'Report the requested object.'
  await assert.rejects(codexNativeWorktreeTurn(realm, 'invalid', invalidPrompt, invalid.state, invalid.callbacks, invalidPath, model),
    (error: unknown) => error instanceof StructuredSessionError && error.code === 'structured_output_format_invalid'
      && error.threadId === invalid.state.threadId && error.turnId === invalid.state.turnId
      && error.rejectedOutput?.text === '{"answer":7}' && error.rejectedOutput?.sha256 === sha('{"answer":7}'))
  assert.ok(invalid.state.codexNative?.proofDigest)
  const invalidStop = await stopCodexNativeWorktreeTurn(invalid.state)
  assert.equal(invalidStop.nativeStopped, true)
  git(repo, 'worktree', 'remove', invalidPath)
  const rejected = { ...invalid.state, state: 'failed' as const, errorCode: 'structured_output_format_invalid' as const,
    cancellation: { reason: 'cancelled' as const, requestedAt: Date.now(), ...invalidStop },
    rejectedOutput: rejectedFinalOutput('{"answer":7}', invalidPrompt, invalid.state, { threadId: invalid.state.threadId!, turnId: invalid.state.turnId! }),
  }
  assertCodexRejectedFinalSource('invalid', invalidPrompt, rejected, invalidPath)
  assert.throws(() => assertCodexRejectedFinalSource('invalid', 'Another prompt', rejected, invalidPath), /terminal evidence differs/)

  mode = 'quota'
  const quota = setup('quota')
  await assert.rejects(codexNativeWorktreeTurn(realm, 'quota', 'Report the requested object.', quota.state, quota.callbacks, quotaPath, model),
    (error: unknown) => error instanceof StructuredSessionError && error.code === 'provider_quota_exhausted')
  assert.equal((await stopCodexNativeWorktreeTurn(quota.state)).nativeStopped, true)

  const proofPath = join(realm, 'read', 'settlement.json')
  const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as { final: { text: string } }
  proof.final.text = '{"answer":"tampered"}'
  rmSync(proofPath)
  writeFileSync(proofPath, JSON.stringify(proof))
  await assert.rejects(codexNativeWorktreeTurn(realm, 'read', 'Read fixture.txt and report the requested object.', state, replayCallbacks, readPath),
    (error: unknown) => error instanceof StructuredSessionError && error.code === 'stale_result')

  mode = 'hold'
  const hold = setup('hold')
  const running = codexNativeWorktreeTurn(realm, 'hold', 'Wait for the local test.', hold.state, hold.callbacks, holdPath, model)
  void running.catch(() => {})
  await holdStarted
  const mismatched = await stopCodexNativeWorktreeTurn({ ...hold.state, state: 'cancelling', turnId: 'wrong-turn' })
  assert.equal(mismatched.nativeStopped, false)
  const stopped = await stopCodexNativeWorktreeTurn({ ...hold.state, state: 'cancelling' })
  assert.equal(stopped.nativeStopped, true)
  assert.equal(stopped.acknowledged, true)
  assert.equal(stopped.turnId, hold.state.turnId)
  await assert.rejects(running, (error: unknown) => error instanceof StructuredSessionError && error.code === 'cancelled')
  await assert.rejects(codexNativeWorktreeTurn(realm, 'hold', 'Wait for the local test.', hold.state, replayCallbacks, holdPath, model),
    (error: unknown) => error instanceof StructuredSessionError && error.code === 'cancellation_pending')
})

function objectFormat(request: Record<string, unknown>): Record<string, unknown> {
  return (request.text as { format: Record<string, unknown> }).format
}
