import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processStartToken } from '@spexcode/spec-core'
import { assertCursorRejectedFinalSource, cursorStructuredTurn, stopCursorStructuredTurn, type CursorStructuredExecution } from './cursor-structured.js'
import { nativeWorktreePrompt, nativeWorktreeResult } from './native-worktree-runtime.js'
import { StructuredSessionError, structuredExecutionPolicy } from './session-structured-policy.js'

const schema = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }
const finalText = '{"marker":"终态"}'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
type Scenario = 'edit' | 'edit-sticky' | 'external-exit' | 'read' | 'bad-json' | 'bad-schema' | 'duplicate-terminal' | 'wrong-id' | 'auth' | 'rpc-error' | 'cancel' | 'cancel-blocked' | 'read-wrong-mode' | 'read-mode-refused'

function fixture(t: TestContext, scenario: Scenario, model = 'cursor:default') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-cursor-fixture-')))
  const bin = join(root, 'bin'), cli = join(bin, 'cursor-agent'), source = join(root, 'source'), workspace = join(root, 'workspace'), realm = join(root, 'realm')
  const originalPath = process.env.PATH
  process.env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(bin); mkdirSync(source)
  const git = (...args: string[]): string => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.name', 'Cursor fixture'); git('config', 'user.email', 'cursor-fixture@example.invalid')
  writeFileSync(join(source, 'seed.txt'), 'immutable seed\n'); git('add', 'seed.txt'); git('commit', '-qm', 'seed')
  const worktree = { baseCommit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), mode: scenario.startsWith('read') ? 'read' as const : 'edit' as const }
  git('worktree', 'add', '--detach', '-q', workspace, worktree.baseCommit)
  writeFileSync(cli, String.raw`#!${process.execPath}
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { createInterface } = require('node:readline')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('cursor-test-version/any.1'); process.exit(0) }
const scenario = ${JSON.stringify(scenario)}
const cwd = process.cwd()
const root = dirname(process.env.TMPDIR)
const sessionId = randomUUID()
const edit = !scenario.startsWith('read')
assert.deepEqual(args.slice(0, 5), ['--workspace', cwd, '--sandbox', 'enabled', '--trust'])
assert.equal(args.at(-1), 'acp')
if (!edit) assert.deepEqual(args.slice(5, 7), ['--mode', 'ask'])
let promptId, pendingPermission
let currentModeId = 'agent'
if (scenario === 'edit-sticky') {
  setInterval(() => {}, 1000)
  process.once('SIGTERM', () => process.exit(143))
}
const send = packet => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n')
const update = (sessionUpdate, update, session = sessionId) => send({ method: 'session/update', params: { sessionId: session, update: { sessionUpdate, ...update } } })
const text = (value, session) => update('agent_message_chunk', { content: { type: 'text', text: value } }, session)
const reply = (id, result) => send({ id, result })
const finish = () => {
  const value = scenario === 'bad-json' ? '\x60\x60\x60json\n{}\n\x60\x60\x60' : scenario === 'bad-schema' ? '{"marker":1}' : ${JSON.stringify(finalText)}
  text('PRE_TOOL_CANARY')
  update('tool_call', { rawInput: 'TOOL_INPUT_CANARY' })
  text('TOOL_MESSAGE_CANARY')
  update('tool_call_update', { rawOutput: 'TOOL_OUTPUT_CANARY' })
  update('agent_thought_chunk', { content: { type: 'text', text: 'THOUGHT_CANARY' } })
  text(value.slice(0, 8))
  text('FOREIGN_SESSION_CANARY', 'some-other-session')
  text(value.slice(8))
  if (scenario === 'edit') update('config_option_update', { configOptions: [{ category: 'model', type: 'select', currentValue: 'fixture-current-model' }] })
  reply(scenario === 'wrong-id' ? 'some-other-request' : promptId, { stopReason: 'end_turn' })
  if (scenario === 'duplicate-terminal') reply(promptId, { stopReason: 'end_turn' })
  if (scenario === 'external-exit') setImmediate(() => process.exit(143))
}
const permission = (kind, path, expected, after) => {
  const id = 'permission-' + kind
  pendingPermission = { id, expected, after }
  send({ id, method: 'session/request_permission', params: {
    sessionId, toolCall: { kind, toolCallId: id, locations: [{ path }] },
    options: [{ kind: 'allow_once', optionId: 'fixture-allow' }, { kind: 'reject_once', optionId: 'fixture-reject' }],
  } })
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const packet = JSON.parse(line)
  assert.equal(packet.jsonrpc, '2.0')
  if (packet.method === 'initialize') {
    assert.equal(packet.params.protocolVersion, 1)
    assert.deepEqual(packet.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
    reply(packet.id, { protocolVersion: 1, authMethods: [{ id: 'cursor_login' }] })
  } else if (packet.method === 'session/new') {
    assert.deepEqual(packet.params, { cwd, mcpServers: [] })
    if (scenario === 'auth' || scenario === 'rpc-error') send({ id: packet.id, error: { code: -32000, message: scenario === 'auth' ? 'Authentication required.' : 'PRIVATE_RPC_ERROR_CANARY' } })
    else reply(packet.id, { sessionId, modes: { currentModeId, availableModes: [{ id: 'agent' }, ...(scenario === 'read-wrong-mode' ? [] : [{ id: 'ask' }])] }, models: scenario === 'edit' ? { currentModelId: 'fixture-initial-model' } : undefined })
  } else if (packet.method === 'session/set_mode') {
    assert.equal(edit, false)
    assert.deepEqual(packet.params, { sessionId, modeId: 'ask' })
    if (scenario === 'read-mode-refused') send({ id: packet.id, error: { code: -32602, message: 'mode refused' } })
    else {
      currentModeId = 'ask'
      reply(packet.id, {})
    }
  } else if (packet.method === 'session/prompt') {
    assert.equal(packet.params.sessionId, sessionId)
    assert.equal(promptId, undefined)
    assert.equal(currentModeId, edit ? 'agent' : 'ask')
    promptId = packet.id
    let descendant
    if (scenario === 'cancel') {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: dirname(dirname(root)), detached: true, stdio: 'ignore' })
      descendant = child.pid
      child.unref()
    }
    writeFileSync(join(root, 'fixture-started.json'), JSON.stringify({ args, promptId, sessionId, descendant, prompt: packet.params.prompt }), { flag: 'wx' })
    if (scenario === 'cancel' || scenario === 'cancel-blocked') return
    if (scenario === 'read') {
      assert.equal(readFileSync(join(cwd, 'seed.txt'), 'utf8'), 'immutable seed\n')
      permission('edit', join(cwd, 'seed.txt'), 'fixture-reject', () => permission('read', join(cwd, 'seed.txt'), 'fixture-allow', finish))
    } else if (['edit', 'edit-sticky', 'bad-json', 'bad-schema'].includes(scenario)) {
      permission('edit', join(cwd, 'draft.json'), 'fixture-allow', () => permission('execute', cwd, 'fixture-reject', () => {
        writeFileSync(join(cwd, 'draft.json'), ${JSON.stringify(finalText)})
        for (const command of [['add', 'draft.json'], ['commit', '-qm', 'fixture native draft']])
          execFileSync('git', command, { stdio: 'ignore' })
        finish()
      }))
    } else finish()
  } else if (packet.method === 'session/cancel') {
    assert.deepEqual(packet.params, { sessionId })
    assert.equal(packet.id, undefined)
    assert(promptId)
    writeFileSync(join(root, 'fixture-cancel.json'), JSON.stringify({ sessionId, promptId }), { flag: 'wx' })
    if (scenario === 'cancel') reply(promptId, { stopReason: 'cancelled' })
    if (scenario === 'cancel-blocked') {
      const wait = setInterval(() => {
        if (!existsSync(join(root, 'fixture-release'))) return
        clearInterval(wait)
        reply(promptId, { stopReason: 'cancelled' })
      }, 15)
    }
  } else if (pendingPermission && packet.id === pendingPermission.id) {
    const { expected, after } = pendingPermission
    pendingPermission = undefined
    assert.deepEqual(packet.result, { outcome: { outcome: 'selected', optionId: expected } })
    after()
  } else assert.fail('unexpected message')
})
`, { mode: 0o700 })

  const prompt = nativeWorktreePrompt('保留原始输入\n\n第二行 \t ', worktree)
  const dispatch = (id: string) => {
    const sessionRoot = join(realm, id)
    let state: CursorStructuredExecution = { ...structuredExecutionPolicy({ schema, model, nativeConfiguration: 'cli-config-v1', inputDigest: 'fixed-input', purpose: 'cursor-fixture', timeoutMs: null, worktree }), state: 'running' }
    const update = (change: Partial<CursorStructuredExecution>): void => { state = { ...state, ...change } }
    const callbacks: Parameters<typeof cursorStructuredTurn>[4] = {
      onNative: async cursorNative => update({ cursorNative }), onThread: async threadId => update({ threadId }),
      onTurn: async turnId => update({ turnId }), onTurnStarting: async () => update({ turnStartRequested: true }),
    }
    const run = (execution = state, nextCallbacks = callbacks, input = prompt, cwd = workspace) => cursorStructuredTurn(realm, id, input, execution, nextCallbacks, cwd)
    return { run, callbacks, state: () => state, update, sessionRoot, started: join(sessionRoot, 'fixture-started.json') }
  }
  return { ...dispatch('dispatch'), dispatch, git, cli, workspace, worktree, prompt }
}

const denyDispatch = async (): Promise<never> => assert.fail('original dispatch must not run a second time')
const replayCallbacks = { onNative: denyDispatch, onThread: denyDispatch, onTurn: denyDispatch, onTurnStarting: denyDispatch }

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await delay(25)
  assert(check(), 'isolated ACP fixture did not reach the expected phase')
}

test('Cursor ACP binds native session, exact client request, reported model and real Git draft', async t => {
  const f = fixture(t, 'edit', 'cursor:opaque/vendor +preview ')
  const result = await f.run()
  const invocation = readJson<{ args: string[]; promptId: string; sessionId: string; prompt: unknown }>(f.started)
  assert.deepEqual(invocation.args, ['--workspace', f.workspace, '--sandbox', 'enabled', '--trust', '--model', 'opaque/vendor +preview ', 'acp'])
  assert.deepEqual(invocation.prompt, [{ type: 'text', text: `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(schema)}\n\n${f.prompt}` }])
  assert.deepEqual(result, { threadId: invocation.sessionId, turnId: invocation.promptId, text: finalText })
  assert.equal(f.state().cursorNative?.sessionId, invocation.sessionId)
  assert.equal(f.state().cursorNative?.requestId, invocation.promptId)
  assert.equal(readJson<{ cliVersion: string }>(join(f.sessionRoot, 'plan.json')).cliVersion, 'cursor-test-version/any.1')
  assert.equal(readJson<{ reportedModel: string }>(join(f.sessionRoot, 'request.json')).reportedModel, 'fixture-initial-model')
  const output = readFileSync(join(f.sessionRoot, 'result.json'), 'utf8')
  assert.equal(JSON.parse(output).reportedModel, 'fixture-current-model')
  assert(!output.includes('CANARY'))
  const gitResult = nativeWorktreeResult(f.workspace, f.worktree)
  assert.notEqual(gitResult.headCommit, f.worktree.baseCommit)
  assert.equal(f.git('show', `${gitResult.headCommit}:draft.json`), finalText)
  assert.equal(f.git('rev-parse', 'HEAD'), f.worktree.baseCommit)

  f.update({ state: 'completed', output: JSON.parse(result.text), resultDigest: sha256(result.text), resultWorktree: gitResult })
  f.git('worktree', 'remove', f.workspace); renameSync(f.cli, f.cli + '.unavailable')
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
  await assert.rejects(f.run(f.state(), replayCallbacks, f.prompt + '\n'), { code: 'stale_result' })
  await assert.rejects(f.run({ ...f.state(), schema: { type: 'number' } }, replayCallbacks), { code: 'stale_result' })
  await assert.rejects(f.run({ ...f.state(), threadId: 'other-thread' }, replayCallbacks), { code: 'stale_result' })
  await assert.rejects(f.run({ ...f.state(), turnId: 'other-request' }, replayCallbacks), { code: 'stale_result' })
  await assert.rejects(f.run(f.state(), replayCallbacks, f.prompt, f.workspace + '-wrong'), { code: 'stale_result' })
  rmSync(join(f.sessionRoot, 'process-stop-observations.jsonl'))
  await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'stale_result' })
})

test('Cursor read mode preserves the exact Git seed and two dispatches use independent ACP sessions', async t => {
  const f = fixture(t, 'read')
  const first = await f.run(), second = await f.dispatch('second').run()
  assert.notEqual(first.threadId, second.threadId)
  assert.notEqual(first.turnId, second.turnId)
  assert.equal(first.text, finalText)
  assert.equal(second.text, finalText)
  assert.deepEqual(readJson<{ args: string[] }>(f.started).args, ['--workspace', f.workspace, '--sandbox', 'enabled', '--trust', '--mode', 'ask', 'acp'])
  assert.equal(readJson<{ reportedModel?: string }>(join(f.sessionRoot, 'result.json')).reportedModel, undefined)
  const gitResult = nativeWorktreeResult(f.workspace, f.worktree)
  assert.equal(gitResult.headCommit, f.worktree.baseCommit)
  assert.equal(gitResult.tree, f.worktree.tree)
})

test('Cursor binds intentional shutdown of a persistent ACP server to the exact successful terminal', async t => {
  const f = fixture(t, 'edit-sticky')
  const result = await f.run()
  const closePath = join(f.sessionRoot, 'close.json')
  const close = readFileSync(closePath, 'utf8')
  const settlement = readJson<{ closeDigest: string; exit: unknown }>(join(f.sessionRoot, 'settlement.json'))
  assert.deepEqual(settlement.exit, { code: 143, signal: null })
  assert.equal(settlement.closeDigest, sha256(close))
  assert.equal(JSON.parse(close).signal, 'SIGTERM')
  assert.equal(existsSync(join(f.sessionRoot, 'cancel.json')), false)
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
  rmSync(closePath)
  await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'stale_result' })
})

test('Cursor does not accept an external 143 exit with an otherwise valid terminal', async t => {
  const f = fixture(t, 'external-exit')
  await assert.rejects(f.run(), { code: 'failed', message: 'Cursor ACP prompt did not complete successfully' })
  assert.equal(existsSync(join(f.sessionRoot, 'close.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
})

for (const scenario of ['bad-json', 'bad-schema'] as const) {
  test(`Cursor ${scenario} leaves an authenticated rejected final and true Git draft for repair`, async t => {
    const f = fixture(t, scenario)
    await assert.rejects(f.run(), (error: unknown) => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, 'structured_output_format_invalid')
      assert.equal(error.threadId, f.state().threadId)
      assert.equal(error.turnId, f.state().turnId)
      assert(error.rejectedOutput)
      f.update({ state: 'failed', errorCode: error.code, rejectedOutput: error.rejectedOutput })
      return true
    })
    const stop = await stopCursorStructuredTurn(f.state())
    assert.deepEqual(stop, { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
    f.update({ cancellation: { ...stop, requestedAt: Date.now(), reason: 'cancelled' } })
    assertCursorRejectedFinalSource(f.prompt, f.state(), f.workspace)
    assert.notEqual(nativeWorktreeResult(f.workspace, f.worktree).headCommit, f.worktree.baseCommit)
    const outputPath = join(f.sessionRoot, 'result.json')
    const original = readJson<Record<string, unknown>>(outputPath)
    rmSync(outputPath)
    writeFileSync(outputPath, JSON.stringify({ ...original, text: finalText }))
    assert.throws(() => assertCursorRejectedFinalSource(f.prompt, f.state(), f.workspace), { code: 'stale_result' })
  })
}

for (const scenario of ['duplicate-terminal', 'wrong-id'] as const) {
  test(`Cursor rejects ${scenario} without dispatching a second prompt`, async t => {
    const f = fixture(t, scenario)
    await assert.rejects(f.run(), { code: 'cancellation_pending' })
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
    await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'cancellation_pending' })
    assert.equal((await stopCursorStructuredTurn(f.state())).nativeStopped, true)
  })
}

test('Cursor sends ACP cancel and proves an owned descendant outside its process group and worktree stopped', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'cancel')
  const controller = new AbortController()
  const rejected = assert.rejects(f.run(f.state(), { ...f.callbacks, signal: controller.signal }), { code: 'cancelled' })
  try {
    await until(() => existsSync(f.started))
    const invocation = readJson<{ sessionId: string; promptId: string; descendant: number }>(f.started)
    const descendantStart = processStartToken(invocation.descendant)
    assert(descendantStart)
    t.after(() => {
      if (processStartToken(invocation.descendant) === descendantStart) process.kill(-invocation.descendant, 'SIGTERM')
    })
    const owned = join(f.sessionRoot, 'owned-processes.json')
    await until(() => readJson<Array<{ pid: number }>>(owned).some(item => item.pid === invocation.descendant))
    assert(readJson<Array<{ pid: number; startToken: string }>>(owned).some(item => item.pid === invocation.descendant && item.startToken === descendantStart.replace(/\s+/g, ' ')))
    const native = f.state().cursorNative!
    const wrong = await stopCursorStructuredTurn({ ...f.state(), cursorNative: { ...native, pid: native.pid! + 1 } }, 100)
    assert.equal(wrong.nativeStopped, false)
    assert.equal(existsSync(join(f.sessionRoot, 'fixture-cancel.json')), false)
    controller.abort()
    await rejected
    assert.deepEqual(readJson(join(f.sessionRoot, 'fixture-cancel.json')), { sessionId: invocation.sessionId, promptId: invocation.promptId })
    assert.deepEqual(await stopCursorStructuredTurn(f.state()), { nativeStopped: true, acknowledged: true, nativeStatus: 'stopped' })
    assert.throws(() => process.kill(invocation.descendant, 0), { code: 'ESRCH' })
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  } finally {
    controller.abort()
    await rejected
  }
})

test('Cursor refuses to settle a live prompt before matching cancellation and process stop', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'cancel-blocked')
  const rejected = assert.rejects(f.run(), { code: 'cancelled' })
  const release = join(f.sessionRoot, 'fixture-release')
  try {
    await until(() => existsSync(f.started))
    const early = await stopCursorStructuredTurn({ ...f.state(), state: 'cancelling' }, 150)
    assert.equal(early.nativeStopped, false)
    assert.equal(early.acknowledged, false)
    await until(() => existsSync(join(f.sessionRoot, 'fixture-cancel.json')))
    assert.doesNotThrow(() => process.kill(f.state().cursorNative!.pid!, 0))
  } finally {
    writeFileSync(release, '')
    await rejected
  }
  assert.equal((await stopCursorStructuredTurn(f.state())).acknowledged, true)
})

test('Cursor stops before dispatch when cancelled while the prompt identity is being pinned', async t => {
  const f = fixture(t, 'edit')
  const controller = new AbortController()
  await assert.rejects(f.run(f.state(), { ...f.callbacks, signal: controller.signal, onTurn: async id => {
    await f.callbacks.onTurn(id)
    controller.abort()
  } }), { code: 'cancelled' })
  assert.equal(existsSync(f.started), false)
  assert.deepEqual(await stopCursorStructuredTurn(f.state()), { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
})

test('Cursor surfaces authentication requirement without raw RPC errors and refuses an unverified read mode', async t => {
  await t.test('authentication required', async t => {
    const f = fixture(t, 'auth')
    await assert.rejects(f.run(), { code: 'failed', message: 'Cursor CLI authentication is required' })
    assert.equal(existsSync(f.started), false)
    assert.equal((await stopCursorStructuredTurn(f.state())).nativeStopped, true)
  })
  await t.test('generic error code stays generic', async t => {
    const f = fixture(t, 'rpc-error')
    await assert.rejects(f.run(), { code: 'failed', message: 'Cursor ACP session could not be started' })
    assert.equal(existsSync(f.started), false)
    assert.equal((await stopCursorStructuredTurn(f.state())).nativeStopped, true)
  })
  await t.test('read mode mismatch', async t => {
    const f = fixture(t, 'read-wrong-mode')
    await assert.rejects(f.run(), { code: 'unsupported', message: 'Cursor ACP session does not advertise the ask mode' })
    assert.equal(existsSync(f.started), false)
    assert.equal((await stopCursorStructuredTurn(f.state())).nativeStopped, true)
  })
  await t.test('read mode switch refused', async t => {
    const f = fixture(t, 'read-mode-refused')
    await assert.rejects(f.run(), { code: 'failed', message: 'Cursor ACP session could not be started' })
    assert.equal(existsSync(f.started), false)
    assert.equal((await stopCursorStructuredTurn(f.state())).nativeStopped, true)
  })
})
