import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertGrokRejectedFinalSource, grokNativeModel, grokStructuredTurn, stopGrokStructuredTurn, type GrokStructuredExecution } from './grok-structured.js'
import { nativeWorktreePrompt, nativeWorktreeResult } from './native-worktree-runtime.js'
import { StructuredSessionError, structuredExecutionPolicy } from './session-structured-policy.js'

const schema = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }
const finalText = '{"marker":"终态"}'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

type Scenario = 'success' | 'wrong-session' | 'wrong-cwd' | 'missing-request' | 'duplicate-terminal' | 'missing-terminal' | 'wrong-format' | 'bad-schema' | 'hang' | 'read'

function fixture(t: TestContext, scenario: Scenario, model = 'grok:default') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-grok-fixture-')))
  const bin = join(root, 'bin'), cli = join(bin, 'grok'), source = join(root, 'source'), workspace = join(root, 'workspace')
  const realm = join(root, 'realm'), sessionRoot = join(realm, 'dispatch'), started = join(sessionRoot, 'fixture-started.json')
  const path = process.env.PATH
  process.env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter)
  t.after(() => {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(bin); mkdirSync(source)
  const git = (...args: string[]): string => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.name', 'Grok fixture'); git('config', 'user.email', 'grok-fixture@example.invalid')
  writeFileSync(join(source, 'seed.txt'), 'immutable seed\n'); git('add', 'seed.txt'); git('commit', '-qm', 'seed')
  const worktree = { baseCommit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), mode: scenario === 'read' ? 'read' as const : 'edit' as const }
  git('worktree', 'add', '--detach', '-q', workspace, worktree.baseCommit)
  const requestId = randomUUID()
  writeFileSync(cli, String.raw`#!${process.execPath}
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('grok 1.0.77 (fixture) [stable]'); process.exit(0) }
const scenario = ${JSON.stringify(scenario)}
const [cwdFlag, cwd, sessionFlag, sessionId, promptFlag, promptFile, outputFlag, outputFormat, ...extra] = args
assert.deepEqual([cwdFlag, sessionFlag, promptFlag, outputFlag, outputFormat], ['--cwd', '--session-id', '--prompt-file', '--output-format', 'streaming-json'])
if (scenario === 'read') assert.deepEqual(extra, ['--permission-mode', 'plan', '--disallowed-tools', 'enter_plan_mode,exit_plan_mode'])
else assert.deepEqual(extra.slice(0, 2), ['--permission-mode', 'bypassPermissions'])
assert.equal(cwd, process.cwd())
assert.match(sessionId, /^[0-9a-f-]{36}$/)
assert.equal(process.env.TMPDIR, join(dirname(promptFile), 'tmp'))
const emit = packet => process.stdout.write(JSON.stringify(packet) + '\n')
const terminal = {
  type: 'end', stopReason: 'end_turn', sessionId: scenario === 'wrong-session' ? 'other-session' : sessionId,
  requestId: scenario === 'missing-request' ? undefined : ${JSON.stringify(requestId)},
  cwd: scenario === 'wrong-cwd' ? dirname(cwd) : cwd,
  modelUsage: { 'fixture-native-model': { inputTokens: 100, outputTokens: 20 } },
}
function finish() {
  const text = scenario === 'wrong-format' ? '\x60\x60\x60json\n{}\n\x60\x60\x60' : scenario === 'bad-schema' ? '{"marker":1}' : ${JSON.stringify(finalText)}
  emit({ type: 'text', data: 'PRE_TOOL_CANARY' })
  emit({ type: 'tool_call', rawInput: 'RAW_TOOL_INPUT_CANARY' })
  emit({ type: 'text', data: 'IN_TOOL_CANARY' })
  emit({ type: 'tool_call_update', rawOutput: 'RAW_TOOL_OUTPUT_CANARY' })
  emit({ type: 'thought', data: 'THOUGHT_CANARY' })
  emit({ type: 'text', data: text.slice(0, 9) })
  emit({ type: 'text', data: text.slice(9) })
  emit({ type: 'usage', signature: 'SIGNATURE_CANARY' })
  if (scenario !== 'missing-terminal') emit(terminal)
  if (scenario === 'duplicate-terminal') emit(terminal)
}
if (['success', 'wrong-format', 'bad-schema'].includes(scenario)) {
  writeFileSync(join(cwd, 'draft.json'), ${JSON.stringify(finalText)})
  for (const argv of [['add', 'draft.json'], ['commit', '-qm', 'native draft']]) execFileSync('git', argv, { stdio: 'ignore' })
}
if (scenario === 'hang') {
  const stay = setInterval(() => {}, 1_000)
  process.once('SIGTERM', () => { clearInterval(stay); finish() })
}
writeFileSync(join(dirname(promptFile), 'fixture-started.json'), JSON.stringify({ args, prompt: readFileSync(promptFile, 'utf8') }), { flag: 'wx' })
if (scenario !== 'hang') finish()
`, { mode: 0o700 })

  const prompt = nativeWorktreePrompt('保留原始输入\n\n第二行 \t ', worktree)
  let state: GrokStructuredExecution = { ...structuredExecutionPolicy({ schema, model, nativeConfiguration: 'cli-config-v1', inputDigest: 'fixed-input', purpose: 'grok-fixture', timeoutMs: null, worktree }), state: 'running' }
  const update = (change: Partial<GrokStructuredExecution>): void => { state = { ...state, ...change } }
  const callbacks: Parameters<typeof grokStructuredTurn>[4] = {
    onThread: async threadId => update({ threadId }), onTurn: async turnId => update({ turnId }),
    onTurnStarting: async () => update({ turnStartRequested: true }), onNative: async grokNative => update({ grokNative }),
  }
  const run = (execution = state, nextCallbacks = callbacks, input = prompt, cwd = workspace) => grokStructuredTurn(realm, 'dispatch', input, execution, nextCallbacks, cwd)
  return { git, cli, workspace, sessionRoot, started, worktree, requestId, prompt, callbacks, run, update, state: () => state }
}

const denyDispatch = async (): Promise<never> => assert.fail('original dispatch must not run a second time')
const replayCallbacks = { onNative: denyDispatch, onThread: denyDispatch, onTurn: denyDispatch, onTurnStarting: denyDispatch }

async function waitForFixture(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path) && Date.now() < deadline) await delay(25)
  assert(existsSync(path), 'the isolated fixture CLI did not launch')
}

test('Grok default uses native config, explicit alias bytes are preserved and blank names are rejected', () => {
  assert.equal(grokNativeModel('grok:default'), undefined)
  assert.equal(grokNativeModel('grok:vendor/model+preview'), 'vendor/model+preview')
  assert.throws(() => grokNativeModel('grok: '), { code: 'unsupported' })
})

test('Grok runs once in the exact worktree and replays original result and stop evidence after close', async t => {
  const f = fixture(t, 'success')
  const result = await f.run()
  assert.deepEqual(result, { threadId: f.state().grokNative?.sessionId, turnId: f.requestId, text: finalText })
  assert.equal(f.state().grokNative?.turnId, f.requestId)
  const invocation = JSON.parse(readFileSync(f.started, 'utf8')) as { args: string[]; prompt: string }
  assert.deepEqual(invocation.args, ['--cwd', f.workspace, '--session-id', result.threadId, '--prompt-file', join(f.sessionRoot, 'prompt.txt'), '--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions'])
  assert.equal(invocation.prompt, `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(schema)}\n\n${f.prompt}`)
  assert.equal(JSON.parse(readFileSync(join(f.sessionRoot, 'plan.json'), 'utf8')).cliVersion, 'grok 1.0.77 (fixture) [stable]')
  const saved = readFileSync(join(f.sessionRoot, 'result.json'), 'utf8')
  assert(!saved.includes('CANARY'))
  assert.deepEqual(JSON.parse(saved).terminal.models, ['fixture-native-model'])
  const gitResult = nativeWorktreeResult(f.workspace, f.worktree)
  assert.notEqual(gitResult.headCommit, f.worktree.baseCommit)
  assert.equal(f.git('show', `${gitResult.headCommit}:draft.json`), finalText)

  f.update({ state: 'completed', output: JSON.parse(result.text), resultDigest: sha256(result.text), resultWorktree: gitResult })
  f.git('worktree', 'remove', f.workspace); renameSync(f.cli, f.cli + '.unavailable')
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
  await assert.rejects(f.run(f.state(), replayCallbacks, f.prompt + '\n'), { code: 'stale_result' })
  await assert.rejects(f.run({ ...f.state(), schema: { type: 'number' } }, replayCallbacks), { code: 'stale_result' })
  await assert.rejects(f.run(f.state(), replayCallbacks, f.prompt, f.workspace + '-wrong'), { code: 'stale_result' })
  rmSync(join(f.sessionRoot, 'process-stop-observations.jsonl'))
  await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'stale_result' })
})

test('Grok read uses native plan mode, removes plan exit and leaves the original seed clean', async t => {
  const f = fixture(t, 'read')
  const result = await f.run()
  assert.equal(result.text, finalText)
  assert.equal(nativeWorktreeResult(f.workspace, f.worktree).headCommit, f.worktree.baseCommit)
})

for (const scenario of ['wrong-session', 'wrong-cwd', 'missing-request', 'duplicate-terminal', 'missing-terminal'] as const) {
  test(`Grok cannot certify or rerun a ${scenario} stream`, async t => {
    const f = fixture(t, scenario)
    await assert.rejects(f.run(), { code: 'cancellation_pending' })
    assert.equal(f.state().turnId, undefined)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
    await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'cancellation_pending' })
    assert.deepEqual(await stopGrokStructuredTurn(f.state()), { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
  })
}

for (const scenario of ['wrong-format', 'bad-schema'] as const) {
  test(`Grok binds ${scenario} output and its stopped Git draft to the exact request`, async t => {
    const f = fixture(t, scenario, 'grok:vendor/model+preview')
    await assert.rejects(f.run(), error => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, 'structured_output_format_invalid')
      assert.equal(error.threadId, f.state().threadId)
      assert.equal(error.turnId, f.requestId)
      assert.equal(error.rejectedOutput?.inputDigest, 'fixed-input')
      f.update({ rejectedOutput: error.rejectedOutput, errorCode: error.code })
      return true
    })
    const stop = await stopGrokStructuredTurn(f.state())
    assert.equal(stop.nativeStopped, true)
    f.update({ state: 'failed', cancellation: { reason: 'cancelled', requestedAt: Date.now(), ...stop }, failedWorktree: nativeWorktreeResult(f.workspace, f.worktree) })
    assertGrokRejectedFinalSource(f.prompt, f.state(), f.workspace)
    assert.throws(() => assertGrokRejectedFinalSource(f.prompt + '\n', f.state(), f.workspace), { code: 'stale_result' })
    const args = (JSON.parse(readFileSync(f.started, 'utf8')) as { args: string[] }).args
    assert.deepEqual(args.slice(-2), ['--model', 'vendor/model+preview'])
  })
}

test('Grok cannot read its prompt before the detached launch is published', async t => {
  const f = fixture(t, 'success'), controller = new AbortController()
  let seen!: () => void, release!: () => void
  const launchReady = new Promise<void>(resolve => { seen = resolve }), launchReleased = new Promise<void>(resolve => { release = resolve })
  const flight = f.run(f.state(), { ...f.callbacks, signal: controller.signal, onNative: async native => {
    await f.callbacks.onNative(native)
    if (native.pid) { seen(); await launchReleased }
  } })
  const rejected = assert.rejects(flight, { code: 'cancelled' })
  try {
    await Promise.race([launchReady, flight.then(() => assert.fail('launch completed before its receipt'))])
    assert.equal(f.state().turnStartRequested, true)
    assert.equal(existsSync(f.started), false)
  } finally { controller.abort(); release(); await rejected }
  assert.equal(existsSync(f.started), false)
  assert.equal((await stopGrokStructuredTurn(f.state())).nativeStopped, true)
})

test('Grok only stops the original process and rejects an exit-zero terminal emitted during cancellation', async t => {
  const f = fixture(t, 'hang'), controller = new AbortController()
  const flight = f.run(f.state(), { ...f.callbacks, signal: controller.signal })
  const rejected = assert.rejects(flight, { code: 'cancelled' })
  try {
    await Promise.race([waitForFixture(f.started), flight.then(() => assert.fail('fixture exited before cancellation'))])
    const native = f.state().grokNative!
    const wrong = await stopGrokStructuredTurn({ ...f.state(), grokNative: { ...native, receiptFile: native.receiptFile + '.wrong' } }, 100)
    assert.equal(wrong.nativeStopped, false)
    process.kill(native.pid!, 0)
    assert.equal((await stopGrokStructuredTurn({ ...f.state(), state: 'cancelling' })).nativeStopped, true)
    await rejected
    assert.equal(f.state().turnId, undefined)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  } finally { controller.abort(); await rejected }
})
