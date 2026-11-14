import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { execFileSync, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertGrokRejectedFinalSource, grokNativeModel, grokStructuredTurn, stopGrokStructuredTurn, type GrokStructuredExecution } from './grok-structured.js'
import { NATIVE_PROCESS_OBSERVATION_LIMIT_MS, nativeWorktreePrompt, nativeWorktreeResult } from './native-worktree-runtime.js'
import { StructuredSessionError, structuredExecutionPolicy } from './session-structured-policy.js'

const schema = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }
const finalText = '{"marker":"终态"}'
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

type Scenario = 'success' | 'wrong-session' | 'wrong-cwd' | 'missing-request' | 'duplicate-terminal' | 'missing-terminal' | 'wrong-format' | 'bad-schema' | 'hang' | 'read' | 'periodic' | 'split-settlement-window' | 'cancel-during-settlement' | 'inherited-stdout' | 'inherited-stdout-trailing' | 'parent-awaits-owned-child' | 'parent-restarts-owned-child' | 'natural-child-shutdown' | 'short-lived-terminal-parent' | 'unowned-stdout' | 'terminal-exit-timeout' | 'terminal-timeout-unowned-stdout'

function fixture(t: TestContext, scenario: Scenario, model = 'grok:default', purpose = 'grok-fixture') {
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
const { execFileSync, spawn } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
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
if (scenario === 'split-settlement-window' || scenario === 'cancel-during-settlement') {
  const splitWindow = scenario === 'split-settlement-window'
  const descendantDelay = splitWindow ? 18000 : 4000
  const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + descendantDelay + ')'], { stdio: 'ignore' })
  descendant.unref()
  setTimeout(finish, 400)
  setTimeout(() => {}, splitWindow ? 13000 : 900)
} else if (scenario === 'unowned-stdout' || scenario === 'terminal-timeout-unowned-stdout') {
  const outside = dirname(dirname(cwd))
  const blockedExit = scenario === 'terminal-timeout-unowned-stdout'
  const childCode = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},Number(process.argv[2]));process.on('SIGTERM',()=>process.exit(0))"
  const args = [childCode, join(dirname(promptFile), 'descendant-ready'), blockedExit ? '45000' : '22000']
  const intermediaryCode = "const cp=require('node:child_process');cp.spawn(process.execPath,['-e',...process.argv.slice(1)],{detached:true,stdio:['ignore','inherit','ignore']}).unref();process.exit(0)"
  if (blockedExit) execFileSync(process.execPath, ['-e', intermediaryCode, ...args], { cwd: outside, stdio: ['ignore', 'inherit', 'ignore'] })
  else spawn(process.execPath, ['-e', ...args], { cwd: outside, detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref()
  finish()
  if (blockedExit) setTimeout(() => {}, 15_750)
} else if (scenario === 'terminal-exit-timeout') {
  process.on('SIGTERM', () => {})
  finish()
  setTimeout(() => {}, 15_750)
} else if (scenario === 'short-lived-terminal-parent') {
  const ready = join(dirname(promptFile), 'late-descendant-ready')
  const childCode = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},5000)"
  const parentCode = "const child=require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{cwd:process.argv[3],detached:true,stdio:'ignore'});child.unref();setTimeout(()=>{},1100)"
  finish()
  setTimeout(() => {
    spawn(process.execPath, ['-e', parentCode, childCode, ready, dirname(dirname(cwd))], { stdio: 'ignore' })
  }, 150)
  setTimeout(() => {}, 2200)
} else if (scenario === 'natural-child-shutdown') {
  const ready = join(dirname(promptFile), 'descendant-ready')
  const childCode = "const fs=require('node:fs');process.on('SIGTERM',()=>process.exit(143));fs.writeFileSync(process.argv[1],'ready');setTimeout(()=>{},2500)"
  const descendant = spawn(process.execPath, ['-e', childCode, ready], { stdio: ['ignore', 'inherit', 'ignore'] })
  descendant.once('exit', code => { process.exitCode = code === 0 ? 0 : 1 })
  const poll = setInterval(() => {
    if (!existsSync(ready)) return
    clearInterval(poll)
    finish()
  }, 20)
} else if (scenario === 'parent-awaits-owned-child' || scenario === 'parent-restarts-owned-child') {
  const ready = join(dirname(promptFile), 'descendant-ready')
  const childCode = "const {writeFileSync}=require('node:fs');const keep=setTimeout(()=>{},21000);process.on('SIGTERM',()=>clearTimeout(keep));writeFileSync(process.argv[1],String(process.pid))"
  const descendant = spawn(process.execPath, ['-e', childCode, ready], { stdio: ['ignore', 'inherit', 'ignore'] })
  if (scenario === 'parent-restarts-owned-child') descendant.once('exit', () => {
    spawn(process.execPath, ['-e', childCode, join(dirname(promptFile), 'late-descendant-ready')], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })
  })
  const poll = setInterval(() => {
    if (!existsSync(ready)) return
    clearInterval(poll)
    setTimeout(finish, 600)
  }, 20)
} else if (scenario === 'inherited-stdout' || scenario === 'inherited-stdout-trailing') {
  const childCode = "const {writeFileSync}=require('node:fs');const keep=setTimeout(()=>{},19000);process.on('SIGTERM',()=>{" +
    (scenario === 'inherited-stdout-trailing' ? "process.stdout.write('{\"type\":\"text\",\"data\":\"late\"}\\n');" : '') +
    "clearTimeout(keep)});writeFileSync(process.argv[1],'ready')"
  const ready = join(dirname(promptFile), 'descendant-ready')
  const descendant = spawn(process.execPath, ['-e', childCode, ready], { stdio: ['ignore', 'inherit', 'ignore'] })
  descendant.unref()
  const poll = setInterval(() => {
    if (!existsSync(ready)) return
    clearInterval(poll)
    setTimeout(finish, 600)
  }, 20)
} else if (scenario === 'periodic') {
  const poll = setInterval(() => {
    if (!existsSync(join(dirname(promptFile), 'fixture-release'))) return
    clearInterval(poll)
    finish()
  }, 20)
} else if (scenario !== 'hang') finish()
`, { mode: 0o700 })

  const prompt = nativeWorktreePrompt('保留原始输入\n\n第二行 \t ', worktree)
  let state: GrokStructuredExecution = { ...structuredExecutionPolicy({ schema, model, nativeConfiguration: 'cli-config-v1', inputDigest: 'fixed-input', purpose, timeoutMs: null, worktree }), state: 'running' }
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

function failCensus(t: TestContext, started: string, shouldFail: (ordinal: number) => boolean) {
  const originalSpawn = childProcess.spawn
  let count = 0
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: SpawnOptions) => {
    if (file === '/bin/ps' && existsSync(started) && shouldFail(++count)) return originalSpawn('/bin/sh', ['-c', 'exit 2'], options)
    return originalSpawn(file, args, options)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  return () => count
}

test('Grok recovers a transient census failure in the original live turn', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'periodic'), association = join(f.sessionRoot, 'task-related-processes.json')
  const probes = failCensus(t, f.started, ordinal => ordinal === 1)
  const flight = f.run().then(result => ({ result }), error => ({ error }))
  try {
    await waitForFixture(f.started)
    const baseline = statSync(association).mtimeMs, deadline = performance.now() + 4_000
    while ((probes() < 2 || statSync(association).mtimeMs === baseline) && performance.now() < deadline) await delay(20)
    assert(probes() >= 2)
  } finally {
    writeFileSync(join(f.sessionRoot, 'fixture-release'), '')
    await flight
  }
  const outcome = await flight
  if ('error' in outcome) throw outcome.error
  assert.equal(outcome.result.turnId, f.requestId)
  assert.deepEqual(await f.run(f.state(), replayCallbacks), outcome.result)
})

test('Grok settles a persistent census failure as failed after exact stop', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'periodic')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const probes = failCensus(t, f.started, () => {
    try { process.kill(f.state().grokNative!.pid!, 0); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  })
  const flight = f.run().then(result => ({ result }), error => ({ error }))
  try {
    await waitForFixture(f.started)
    const deadline = performance.now() + 4_000
    while (probes() < 2 && performance.now() < deadline) await delay(20)
    assert(probes() >= 2)
    t.mock.timers.tick(NATIVE_PROCESS_OBSERVATION_LIMIT_MS + 1)
    const outcome = await flight
    assert('error' in outcome && outcome.error instanceof StructuredSessionError)
    assert.equal(outcome.error.code, 'failed')
    const latest = readFileSync(join(f.sessionRoot, 'process-stop-observations.jsonl'), 'utf8').trimEnd().split('\n').at(-1)!
    assert.equal((JSON.parse(latest) as { nativeStopped: boolean }).nativeStopped, true)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  } finally {
    writeFileSync(join(f.sessionRoot, 'fixture-release'), '')
    await flight
  }
})

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

test('Grok gives a closed successful terminal a full independent process settlement window', { timeout: 30_000 }, async t => {
  const f = fixture(t, 'split-settlement-window')
  try {
    const result = await f.run()
    assert.equal(result.turnId, f.requestId)
    assert.equal(result.text, finalText)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), true)
  } finally {
    let stopped = await stopGrokStructuredTurn(f.state(), 5_000)
    if (!stopped.nativeStopped) {
      await delay(3_000)
      stopped = await stopGrokStructuredTurn(f.state(), 5_000)
    }
    assert.equal(stopped.nativeStopped, true)
  }
})

test('Grok settles a natural exit while a recorded descendant still holds stdout', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'inherited-stdout')
  const result = await f.run()
  assert.equal(result.text, finalText)
  const settlement = JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8'))
  assert.deepEqual(settlement.exit, { code: 0, signal: null })
  assert.equal((await stopGrokStructuredTurn(f.state(), 5_000)).nativeStopped, true)
})

test('Grok settles a successful terminal when its parent waits for a recorded child', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'parent-awaits-owned-child')
  try {
    const result = await f.run()
    assert.equal(result.text, finalText)
    assert.equal(result.turnId, f.requestId)
    const settlement = JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8'))
    assert.deepEqual(settlement.exit, { code: 0, signal: null })
  } finally {
    const pid = f.state().grokNative?.pid
    if (pid) {
      try { process.kill(pid, 0); await delay(6_000) }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
    }
    assert.equal((await stopGrokStructuredTurn(f.state(), 5_000)).nativeStopped, true)
  }
})

test('Grok records a briefly observable descendant during the shutdown grace period', { timeout: 12_000 }, async t => {
  const f = fixture(t, 'short-lived-terminal-parent')
  try {
    const result = await f.run()
    assert.equal(result.turnId, f.requestId)
    const pid = Number(readFileSync(join(f.sessionRoot, 'late-descendant-ready'), 'utf8'))
    const owned = JSON.parse(readFileSync(join(f.sessionRoot, 'owned-processes.json'), 'utf8')) as { pid: number }[]
    assert.ok(owned.some(identity => identity.pid === pid), 'the detached descendant was lost with its short-lived parent')
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    await delay(3_200)
  }
})

test('Grok leaves time for the original CLI to finish its own terminal shutdown', { timeout: 12_000 }, async t => {
  const f = fixture(t, 'natural-child-shutdown')
  const result = await f.run()
  assert.equal(result.turnId, f.requestId)
  assert.equal(result.text, finalText)
  const settlement = JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8'))
  assert.deepEqual(settlement.exit, { code: 0, signal: null })
})

test('Grok settles when the original CLI starts another owned child during terminal shutdown', { timeout: 26_000 }, async t => {
  const f = fixture(t, 'parent-restarts-owned-child')
  const result = await f.run().catch(async error => {
    await delay(7_000)
    throw error
  })
  assert.equal(result.turnId, f.requestId)
  assert.equal(result.text, finalText)
  const settlement = JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8'))
  assert.deepEqual(settlement.exit, { code: 0, signal: null })
  const latePid = Number(readFileSync(join(f.sessionRoot, 'late-descendant-ready'), 'utf8'))
  const owned = JSON.parse(readFileSync(join(f.sessionRoot, 'owned-processes.json'), 'utf8')) as { pid: number }[]
  assert.ok(owned.some(identity => identity.pid === latePid))
  assert.throws(() => process.kill(latePid, 0), { code: 'ESRCH' })
})

for (const externallyCancelled of [false, true]) {
  test(`Grok settles ${externallyCancelled ? 'external cancellation' : 'a failed native exit'} after the successful terminal window expires`, { timeout: 35_000 }, async t => {
    const f = fixture(t, 'terminal-exit-timeout'), controller = new AbortController()
    const flight = f.run(f.state(), { ...f.callbacks, signal: controller.signal })
    const rejected = assert.rejects(flight, externallyCancelled ? { code: 'cancelled' }
      : { code: 'failed', message: 'Grok native exit was not observed before the settlement deadline' })
    let abortTimer: NodeJS.Timeout | undefined
    try {
      await waitForFixture(f.started)
      if (externallyCancelled) abortTimer = setTimeout(() => controller.abort(), 15_400)
      await rejected
      assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
      assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
      const observations = readFileSync(join(f.sessionRoot, 'process-stop-observations.jsonl'), 'utf8').trim().split('\n')
      assert.equal(JSON.parse(observations.at(-1)!).nativeStopped, true)
    } finally {
      clearTimeout(abortTimer)
      await delay(900)
      assert.equal((await stopGrokStructuredTurn(f.state(), 5_000)).nativeStopped, true)
    }
  })
}

test('Grok rejects a late exit observed before the overdue timer callback', { timeout: 35_000 }, async t => {
  const f = fixture(t, 'terminal-exit-timeout')
  const flight = assert.rejects(f.run(), { code: 'failed', message: 'Grok native exit was not observed before the settlement deadline' })
  await waitForFixture(f.started)
  await delay(14_200)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
  await flight
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
})

test('Grok keeps the expired exit unsettled when an unowned writer holds stdout', { timeout: 40_000 }, async t => {
  const f = fixture(t, 'terminal-timeout-unowned-stdout')
  const ready = join(f.sessionRoot, 'descendant-ready')
  const rejected = assert.rejects(f.run(), { code: 'cancellation_pending' })
  await waitForFixture(ready)
  const pid = Number(readFileSync(ready, 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  try {
    await rejected
    assert.equal(process.kill(pid, 0), true)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  } finally {
    try { process.kill(-pid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
  }
})

test('Grok still rejects data after the terminal when an owned descendant closes stdout', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'inherited-stdout-trailing')
  await assert.rejects(f.run(), /invalid event or data after its terminal/)
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  assert.equal((await stopGrokStructuredTurn(f.state(), 5_000)).nativeStopped, true)
})

test('Grok withholds output if an unobserved detached process still holds stdout', { timeout: 25_000 }, async t => {
  const f = fixture(t, 'unowned-stdout')
  const ready = join(f.sessionRoot, 'descendant-ready')
  const flight = assert.rejects(f.run(), { code: 'cancellation_pending', message: 'Grok native stdout EOF was not observed within the settlement window' })
  await waitForFixture(ready)
  const pid = Number(readFileSync(ready, 'utf8'))
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  try {
    await flight
    assert.equal(process.kill(pid, 0), true)
    assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  } finally {
    try { process.kill(-pid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
  }
})

test('Grok cancellation during process settlement still suppresses the result', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'cancel-during-settlement')
  const controller = new AbortController()
  const rejected = assert.rejects(f.run(f.state(), { ...f.callbacks, signal: controller.signal }), { code: 'cancelled' })
  const observations = join(f.sessionRoot, 'process-stop-observations.jsonl')
  try {
    await waitForFixture(observations)
    const first = JSON.parse(readFileSync(observations, 'utf8').split('\n')[0]) as { nativeStopped: boolean }
    assert.equal(first.nativeStopped, false)
  } finally {
    controller.abort()
    await rejected
  }
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
})

test('Grok read uses native plan mode, removes plan exit and leaves the original seed clean', async t => {
  const f = fixture(t, 'read')
  const result = await f.run()
  assert.equal(result.text, finalText)
  const invocation = JSON.parse(readFileSync(f.started, 'utf8')) as { prompt: string }
  assert.match(invocation.prompt, /read_file, grep, and list_dir/)
  assert.match(invocation.prompt, /Do not use run_terminal_command to inspect checked-out files/)
  assert.match(invocation.prompt, /if the task explicitly requires inspecting a historical Git object/)
  const planPath = join(f.sessionRoot, 'plan.json'), originalPlan = readFileSync(planPath, 'utf8')
  assert.equal(JSON.parse(originalPlan).readGuidance, 'native-file-read-v2')
  assert.equal(nativeWorktreeResult(f.workspace, f.worktree).headCommit, f.worktree.baseCommit)
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
  rmSync(planPath)
  writeFileSync(planPath, JSON.stringify({ ...JSON.parse(originalPlan), readGuidance: 'direct-git-read-v1' }))
  await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'stale_result' })
})

for (const purpose of ['elaboration_review', 'code_review']) {
  test(`Grok preserves the required repository tools for ${purpose}`, async t => {
    const f = fixture(t, 'read', 'grok:default', purpose)
    const result = await f.run()
    assert.equal(result.text, finalText)
    assert.equal(JSON.parse(readFileSync(join(f.sessionRoot, 'plan.json'), 'utf8')).readGuidance, 'native-review-table-read-v4')
    const { prompt } = JSON.parse(readFileSync(f.started, 'utf8')) as { prompt: string }
    assert.match(prompt, /Interpret Markdown table cells before comparing code literals/)
    assert.match(prompt, /if the task explicitly requires inspecting a historical Git object/)
    assert.equal(nativeWorktreeResult(f.workspace, f.worktree).headCommit, f.worktree.baseCommit)
    assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
  })
}

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
