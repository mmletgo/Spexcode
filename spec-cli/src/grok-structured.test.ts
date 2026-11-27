import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { execFileSync, type SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertGrokRejectedFinalSource, grokNativeModel, grokStructuredTurn, stopGrokStructuredTurn, type GrokStructuredExecution } from './grok-structured.js'
import { managedModel } from './llm-manager-route.js'
import { NATIVE_PROCESS_OBSERVATION_LIMIT_MS, nativeWorktreePrompt, nativeWorktreeResult } from './native-worktree-runtime.js'
import { StructuredSessionError, structuredExecutionPolicy } from './session-structured-policy.js'

const schema = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }
const finalText = '{"marker":"终态"}'
const nativeSchemaText = '{"marker":"TEXT_CANARY"}'
const nativeSchemaValue = { marker: '原生终态' }
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

type Scenario = 'startup-error' | 'success' | 'wrong-session' | 'wrong-cwd' | 'missing-request' | 'duplicate-terminal' | 'missing-terminal' | 'wrong-format' | 'bad-schema' | 'hang' | 'read' | 'periodic' | 'split-settlement-window' | 'cancel-during-settlement' | 'inherited-stdout' | 'inherited-stdout-trailing' | 'parent-awaits-owned-child' | 'parent-restarts-owned-child' | 'mcp-transport-reconnect' | 'natural-child-shutdown' | 'short-lived-terminal-parent' | 'unowned-stdout' | 'terminal-exit-timeout' | 'terminal-timeout-unowned-stdout'
  | 'native-schema-success' | 'native-schema-trailing' | 'native-schema-missing' | 'native-schema-mismatch'
  | 'acp-success' | 'acp-missing' | 'acp-quota' | 'acp-startup-quota' | 'acp-startup-delayed-quota' | 'acp-auth-quota' | 'acp-auth-stderr-quota' | 'acp-prompt-stderr-quota' | 'acp-signal'

function fixture(t: TestContext, scenario: Scenario, model = 'grok:default', purpose = 'grok-fixture', stderrChunks: readonly string[] = []) {
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
const scenario = ${JSON.stringify(scenario)}
const nativeSchema = scenario.startsWith('native-schema-')
const acp = scenario.startsWith('acp-')
if (args[0] === '--version') { console.log(nativeSchema ? 'grok 1.0.92 (fixture) [stable]' : 'grok 1.0.77 (fixture) [stable]'); process.exit(0) }
if (args[0] === '--help') {
  console.log('Options:\n    --output-format <FORMAT>')
  if (nativeSchema) console.log('    --json-schema <SCHEMA>  JSON Schema for structured output')
  process.exit(0)
}
if (args.join(' ') === '--no-auto-update agent --help') {
  if (acp || scenario === 'read') console.log('  stdio     Run the agent over stdio\n      --no-leader')
  process.exit(0)
}
if (acp) {
  assert.deepEqual(args, ['--no-auto-update', '--permission-mode', 'bypassPermissions', 'agent', '--no-leader', 'stdio'])
  const input = require('node:readline').createInterface({ input: process.stdin })
  const send = packet => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n')
  let sessionId
  input.on('line', line => {
    const { id, method, params } = JSON.parse(line)
    const reply = result => send({ id, result })
    const quota = () => send({ id, error: { code: -32003, message: 'Rate limited' } })
    const stderrQuota = () => process.stderr.write('HTTP 429: rate limited\n', () => process.exit(1))
    if (method === 'initialize') {
      if (scenario === 'acp-startup-quota') stderrQuota()
      else if (scenario === 'acp-startup-delayed-quota') process.stderr.write('HTTP 429: rate limited\n', () => {
        process.stdout.end()
        setTimeout(() => process.exit(1), 1000)
      })
      else reply({ protocolVersion: 1, authMethods: [{ id: 'cached_token' }] })
    } else if (method === 'authenticate') {
      assert.equal(params.methodId, 'cached_token')
      if (scenario === 'acp-auth-quota') quota()
      else if (scenario === 'acp-auth-stderr-quota') stderrQuota()
      else reply({})
    } else if (method === 'session/new') {
      assert.equal(params.cwd, process.cwd())
      sessionId = params._meta.sessionId
      assert.match(sessionId, /^[0-9a-f-]{36}$/)
      if (scenario === 'acp-success') assert.equal(params._meta.modelId, 'grok-4.7-build')
      reply({ sessionId, _meta: { currentWorkingDirectory: process.cwd() } })
    } else if (method === 'session/prompt') {
      assert.equal(params.sessionId, sessionId)
      const requestId = params._meta.promptId
      assert.match(requestId, /^[0-9a-f-]{36}$/)
      assert.deepEqual(params._meta.outputSchema, ${JSON.stringify(schema)})
      writeFileSync(join(process.env.TMPDIR, '..', 'fixture-started.json'), JSON.stringify({ args, requestId, prompt: params.prompt[0].text, traceUpload: process.env.GROK_TELEMETRY_TRACE_UPLOAD }), { flag: 'wx' })
      if (scenario === 'acp-quota') {
        quota()
        return
      }
      if (scenario === 'acp-prompt-stderr-quota') {
        stderrQuota()
        return
      }
      writeFileSync('draft.json', ${JSON.stringify(finalText)})
      for (const argv of [['add', 'draft.json'], ['commit', '-qm', 'native ACP draft']]) execFileSync('git', argv, { stdio: 'ignore' })
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ${JSON.stringify(nativeSchemaText)} } } } })
      reply({ stopReason: 'end_turn', _meta: { sessionId, requestId, usage: { modelUsage: { 'grok-4.7-build': { inputTokens: 100 } } },
        ...(scenario === 'acp-missing' ? {} : { structuredOutput: ${JSON.stringify(nativeSchemaValue)} }) } })
    }
  })
  if (scenario === 'acp-signal') input.on('close', () => process.kill(process.pid, 'SIGTERM'))
  return
}
const option = key => args[args.indexOf(key) + 1]
const cwd = option('--cwd'), sessionId = option('--session-id'), promptFile = option('--prompt-file')
assert.equal(option('--output-format'), 'streaming-json')
assert.equal(option('--permission-mode'), scenario === 'read' ? 'plan' : 'bypassPermissions')
if (scenario === 'read') {
  assert.equal(option('--disallowed-tools'), 'enter_plan_mode,exit_plan_mode')
  assert.equal(process.env.GROK_TELEMETRY_TRACE_UPLOAD, 'false')
}
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
  const text = nativeSchema ? ${JSON.stringify(nativeSchemaText)}
    : scenario === 'wrong-format' ? '\x60\x60\x60json\n{}\n\x60\x60\x60' : scenario === 'bad-schema' ? '{"marker":1}' : ${JSON.stringify(finalText)}
  emit({ type: 'text', data: 'PRE_TOOL_CANARY' })
  emit({ type: 'tool_call', rawInput: 'RAW_TOOL_INPUT_CANARY' })
  emit({ type: 'text', data: 'IN_TOOL_CANARY' })
  emit({ type: 'tool_call_update', rawOutput: 'RAW_TOOL_OUTPUT_CANARY' })
  emit({ type: 'thought', data: 'THOUGHT_CANARY' })
  emit({ type: 'text', data: text.slice(0, 9) })
  emit({ type: 'text', data: text.slice(9) })
  emit({ type: 'usage', signature: 'SIGNATURE_CANARY' })
  if (nativeSchema && scenario !== 'native-schema-missing') {
    terminal.structuredOutput = scenario === 'native-schema-mismatch' ? null : ${JSON.stringify(nativeSchemaValue)}
  }
  if (scenario === 'native-schema-success') {
    const line = Buffer.from(JSON.stringify(terminal) + '\n')
    const split = line.indexOf(Buffer.from('原')) + 1
    process.stdout.write(line.subarray(0, split), () => setTimeout(() => process.stdout.write(line.subarray(split)), 30))
    return
  }
  if (scenario !== 'missing-terminal') emit(terminal)
  if (scenario === 'duplicate-terminal') emit(terminal)
  if (scenario === 'native-schema-trailing') emit({ type: 'text', data: 'LATE_TEXT_CANARY' })
}
if (nativeSchema || ['success', 'wrong-format', 'bad-schema'].includes(scenario)) {
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
} else if (scenario === 'parent-awaits-owned-child' || scenario === 'parent-restarts-owned-child' || scenario === 'mcp-transport-reconnect') {
  const ready = join(dirname(promptFile), 'descendant-ready')
  const childCode = "const {writeFileSync}=require('node:fs');const keep=setTimeout(()=>{},21000);process.on('SIGTERM',()=>clearTimeout(keep));writeFileSync(process.argv[1],String(process.pid))"
  const descendant = spawn(process.execPath, ['-e', childCode, ready], { stdio: ['ignore', 'inherit', 'ignore'] })
  if (scenario === 'parent-restarts-owned-child') descendant.once('exit', () => {
    spawn(process.execPath, ['-e', childCode, join(dirname(promptFile), 'late-descendant-ready')], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })
  })
  if (scenario === 'mcp-transport-reconnect' && process.env.GROK_MCP_AUTO_RESTART !== '0') {
    const reconnect = () => {
      spawn(process.execPath, ['-e', childCode, join(dirname(promptFile), 'mcp-reconnected')], { stdio: ['ignore', 'inherit', 'ignore'] }).once('exit', reconnect)
    }
    descendant.once('exit', reconnect)
  }
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
} else if (scenario !== 'hang') {
  const chunks = ${JSON.stringify(stderrChunks)}
  function writeStderr(index) {
    if (index < chunks.length) {
      process.stderr.write(chunks[index], () => setTimeout(writeStderr, 10, index + 1))
      return
    }
    if (scenario === 'startup-error') { process.exitCode = 1; return }
    if (scenario === 'missing-terminal' && chunks.length) process.exitCode = 1
    finish()
  }
  writeStderr(0)
}
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
  const f = fixture(t, 'success', 'grok:default', 'grok-fixture', ['HTTP 429: usage balance exhausted\n'])
  const warn = t.mock.method(console, 'warn', () => {})
  const result = await f.run()
  assert.deepEqual(result, { threadId: f.state().grokNative?.sessionId, turnId: f.requestId, text: finalText })
  assert.deepEqual(JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8')).exit, { code: 0, signal: null })
  assert.equal(warn.mock.callCount(), 0)
  assert.equal(existsSync(join(f.sessionRoot, 'missing-terminal-diagnostic.json')), false)
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

test('Grok native schema uses the split terminal value and replays it without the CLI', async t => {
  const f = fixture(t, 'native-schema-success', 'grok:grok-4.7-build')
  const result = await f.run()
  assert.equal(result.threadId, f.state().grokNative?.sessionId)
  assert.equal(result.turnId, f.requestId)
  assert.deepEqual(JSON.parse(result.text), nativeSchemaValue)
  const { args } = JSON.parse(readFileSync(f.started, 'utf8')) as { args: string[] }
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-json')
  assert.equal(args[args.indexOf('--model') + 1], 'grok-4.7-build')
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify(schema))
  assert.equal(JSON.parse(readFileSync(join(f.sessionRoot, 'plan.json'), 'utf8')).structuredOutput, 'native-schema-v1')
  assert.deepEqual(JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8')).exit, { code: 0, signal: null })

  const gitResult = nativeWorktreeResult(f.workspace, f.worktree)
  assert.notEqual(gitResult.headCommit, f.worktree.baseCommit)
  assert.equal(f.git('show', `${gitResult.headCommit}:draft.json`), finalText)
  f.update({ state: 'completed', output: JSON.parse(result.text), resultDigest: sha256(result.text), resultWorktree: gitResult })
  f.git('worktree', 'remove', f.workspace)
  renameSync(f.cli, f.cli + '.unavailable')
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
})

test('Grok ACP edits bind the original Git result and replay after natural zero and EOF', async t => {
  const f = fixture(t, 'acp-success', 'grok:grok-4.7-build')
  const result = await f.run()
  const plan = JSON.parse(readFileSync(join(f.sessionRoot, 'plan.json'), 'utf8'))
  const start = JSON.parse(readFileSync(f.started, 'utf8'))
  assert.equal(start.prompt, readFileSync(join(f.sessionRoot, 'prompt.txt'), 'utf8'))
  assert.equal(start.traceUpload, process.env.GROK_TELEMETRY_TRACE_UPLOAD)
  assert.deepEqual(plan.acp, { version: 1, promptId: start.requestId })
  assert.equal(result.threadId, plan.sessionId)
  assert.equal(result.turnId, plan.acp.promptId)
  assert.deepEqual(JSON.parse(result.text), nativeSchemaValue)
  const stored = JSON.parse(readFileSync(join(f.sessionRoot, 'result.json'), 'utf8'))
  assert.deepEqual(stored.terminal.models, ['grok-4.7-build'])
  assert.deepEqual(JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8')).exit, { code: 0, signal: null })
  const git = nativeWorktreeResult(f.workspace, f.worktree)
  assert.notEqual(git.headCommit, f.worktree.baseCommit)
  assert.equal(f.git('show', `${git.headCommit}:draft.json`), finalText)
  f.update({ state: 'completed', output: JSON.parse(result.text), resultDigest: sha256(result.text), resultWorktree: git })
  f.git('worktree', 'remove', f.workspace)
  renameSync(f.cli, f.cli + '.unavailable')
  assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
})

test('Grok ACP preserves a matching missing-schema result for authentic rejected-draft repair', async t => {
  const f = fixture(t, 'acp-missing')
  await assert.rejects(f.run(), error => {
    assert(error instanceof StructuredSessionError)
    assert.equal(error.code, 'structured_output_format_invalid')
    assert.equal(error.rejectedOutput?.representation, 'text')
    assert.equal(error.rejectedOutput?.text, nativeSchemaText)
    f.update({ rejectedOutput: error.rejectedOutput, errorCode: error.code })
    return true
  })
  const stop = await stopGrokStructuredTurn(f.state())
  assert.equal(stop.nativeStopped, true)
  f.update({ state: 'failed', cancellation: { reason: 'cancelled', requestedAt: Date.now(), ...stop }, failedWorktree: nativeWorktreeResult(f.workspace, f.worktree) })
  renameSync(f.cli, f.cli + '.unavailable')
  assertGrokRejectedFinalSource(f.prompt, f.state(), f.workspace)
})

const managedGrok = managedModel({ routeId: 'a'.repeat(64), vendor: 'grok', model: 'default', kind: 'cli' })

test('Grok ACP reports the bound native prompt quota after exact natural settlement', async t => {
  const f = fixture(t, 'acp-quota', managedGrok)
  await assert.rejects(f.run(), { code: 'provider_quota_exhausted' })
  const proof = JSON.parse(readFileSync(join(f.sessionRoot, 'acp-rate-limit-diagnostic.json'), 'utf8'))
  const plan = JSON.parse(readFileSync(join(f.sessionRoot, 'plan.json'), 'utf8'))
  assert.equal(proof.sessionId, plan.sessionId)
  assert.equal(proof.requestId, plan.acp.promptId)
  assert.equal(proof.rpcCode, -32003)
  assert.deepEqual(proof.exit, { code: 0, signal: null })
  assert.equal(proof.stdoutEnded, true)
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
})

for (const scenario of ['acp-startup-quota', 'acp-startup-delayed-quota'] as const) test(`Grok ACP ${scenario} keeps the settled nonzero CLI stderr quota path`, async t => {
  const f = fixture(t, scenario, managedGrok)
  await assert.rejects(f.run(), { code: 'provider_quota_exhausted' })
  const proof = JSON.parse(readFileSync(join(f.sessionRoot, 'missing-terminal-diagnostic.json'), 'utf8'))
  assert.deepEqual(proof.exit, { code: 1, signal: null })
  assert.deepEqual(proof.stderr.httpStatuses, [429])
  assert.equal(proof.stderr.ended, true)
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
})

for (const scenario of ['acp-auth-quota', 'acp-auth-stderr-quota', 'acp-prompt-stderr-quota', 'acp-signal'] as const) {
  test(`Grok ACP rejects ${scenario} without publishing a result or manager quota`, async t => {
    const f = fixture(t, scenario, managedGrok)
    await assert.rejects(f.run(), error => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, 'failed')
      return true
    })
    assert.equal(f.state().turnId, undefined)
    assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
    assert.equal(existsSync(join(f.sessionRoot, 'acp-rate-limit-diagnostic.json')), false)
    assert.equal((await stopGrokStructuredTurn(f.state())).nativeStopped, true)
  })
}

test('Grok native schema rejects another event after the original terminal', async t => {
  const f = fixture(t, 'native-schema-trailing')
  await assert.rejects(f.run(), { code: 'cancellation_pending' })
  assert.equal(f.state().turnId, undefined)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.deepEqual(await stopGrokStructuredTurn(f.state()), { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
})

for (const [scenario, representation, rejectedText] of [
  ['native-schema-missing', 'text', nativeSchemaText],
  ['native-schema-mismatch', 'native_json', 'null'],
] as const) {
  test(`Grok native schema binds ${scenario} evidence to the exact stopped draft`, async t => {
    const f = fixture(t, scenario)
    await assert.rejects(f.run(), error => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, 'structured_output_format_invalid')
      assert.equal(error.threadId, f.state().threadId)
      assert.equal(error.turnId, f.requestId)
      assert.equal(error.rejectedOutput?.inputDigest, 'fixed-input')
      assert.equal(error.rejectedOutput?.representation, representation)
      assert.equal(error.rejectedOutput?.text, rejectedText)
      f.update({ rejectedOutput: error.rejectedOutput, errorCode: error.code })
      return true
    })
    const stop = await stopGrokStructuredTurn(f.state())
    assert.equal(stop.nativeStopped, true)
    f.update({ state: 'failed', cancellation: { reason: 'cancelled', requestedAt: Date.now(), ...stop }, failedWorktree: nativeWorktreeResult(f.workspace, f.worktree) })
    renameSync(f.cli, f.cli + '.unavailable')
    assertGrokRejectedFinalSource(f.prompt, f.state(), f.workspace)
    assert.throws(() => assertGrokRejectedFinalSource(f.prompt + '\n', f.state(), f.workspace), { code: 'stale_result' })
  })
}

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

test('Grok settles the owned MCP transport without reconnecting during terminal shutdown', { timeout: 35_000 }, async t => {
  const previous = process.env.GROK_MCP_AUTO_RESTART
  process.env.GROK_MCP_AUTO_RESTART = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.GROK_MCP_AUTO_RESTART
    else process.env.GROK_MCP_AUTO_RESTART = previous
  })
  const f = fixture(t, 'mcp-transport-reconnect')
  const result = await f.run()
  assert.equal(result.turnId, f.requestId)
  assert.equal(result.text, finalText)
  assert.equal(existsSync(join(f.sessionRoot, 'mcp-reconnected')), false)
  assert.equal(process.env.GROK_MCP_AUTO_RESTART, '1')
  const settlement = JSON.parse(readFileSync(join(f.sessionRoot, 'settlement.json'), 'utf8'))
  assert.deepEqual(settlement.exit, { code: 0, signal: null })
})

for (const externallyCancelled of [false, true]) {
  test(`Grok settles ${externallyCancelled ? 'external cancellation' : 'a failed native exit'} after the successful terminal window expires`, { timeout: 35_000 }, async t => {
    const f = fixture(t, 'terminal-exit-timeout'), controller = new AbortController()
    const warn = t.mock.method(console, 'warn', () => {})
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
      assert.equal(warn.mock.callCount(), 1)
      const [label, payload] = warn.mock.calls[0]!.arguments
      assert.equal(label, 'spex grok native exit deadline')
      assert.doesNotMatch(payload, /CANARY|保留原始输入|终态|fixture-native-model|--prompt-file/)
      const diagnostic = JSON.parse(payload)
      assert.equal(diagnostic.decision.exitObserved, false)
      assert.equal(diagnostic.decision.exitCode, null)
      assert.equal(diagnostic.decision.signalCode, null)
      assert.equal(diagnostic.decision.stdoutEnded, false)
      assert.equal(diagnostic.stderr, 'metadata-only')
      assert.ok(diagnostic.terminalAtMs <= diagnostic.deadlineAtMs)
      assert.ok(typeof diagnostic.timerFiredAtMs === 'number' && diagnostic.timerFiredAtMs <= diagnostic.decision.atMs)
      assert.equal(diagnostic.timerLatenessMs, Math.max(0, diagnostic.timerFiredAtMs - diagnostic.deadlineAtMs))
      assert.ok(diagnostic.exitAtMs > diagnostic.decision.atMs)
      assert.equal(diagnostic.cleanup.processGroupStopped, true)
      assert.equal(diagnostic.cleanup.stdoutEnded, true)
      assert.equal(diagnostic.cleanup.settled, true)
    } finally {
      clearTimeout(abortTimer)
      await delay(900)
      assert.equal((await stopGrokStructuredTurn(f.state(), 5_000)).nativeStopped, true)
    }
  })
}

test('Grok rejects a late exit while the overdue timer callback is deferred', { timeout: 35_000 }, async t => {
  const f = fixture(t, 'terminal-exit-timeout')
  const warn = t.mock.method(console, 'warn', () => {})
  const schedule = globalThis.setTimeout
  let deferred = false
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 15_000 || deferred) return schedule(callback, ms, ...args)
    deferred = true
    return schedule(callback, 60_000, ...args)
  })
  await assert.rejects(f.run(), { code: 'failed', message: 'Grok native exit was not observed before the settlement deadline' })
  assert.equal(deferred, true)
  assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
  assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  assert.equal(warn.mock.callCount(), 1)
  const [label, payload] = warn.mock.calls[0]!.arguments
  assert.equal(label, 'spex grok native exit deadline')
  const diagnostic = JSON.parse(payload)
  assert.equal(diagnostic.decision.exitObserved, true)
  assert.equal(diagnostic.decision.exitCode, 0)
  assert.ok(diagnostic.exitAtMs > diagnostic.deadlineAtMs)
  assert.ok(typeof diagnostic.decision.exitOverdueMs === 'number' && diagnostic.decision.exitOverdueMs >= 0)
  assert.equal(diagnostic.timerFiredAtMs, null)
  assert.equal(diagnostic.timerLatenessMs, null)
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

for (const purpose of ['code_behavior_analyze', 'code_behavior_review']) {
  test(`Grok keeps frozen business evidence distinct from draft HEAD for ${purpose}`, async t => {
    const f = fixture(t, 'success', 'grok:default', purpose)
    const result = await f.run()
    const planPath = join(f.sessionRoot, 'plan.json')
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { readGuidance?: string }
    const invocation = JSON.parse(readFileSync(f.started, 'utf8')) as { args: string[]; prompt: string }
    assert.equal(plan.readGuidance, 'native-behavior-evidence-v5')
    assert.match(invocation.prompt, /current and previous business behavior.*frozen source and historical role objects/)
    assert.match(invocation.prompt, /Do not cite the current worktree HEAD.*as business evidence/)
    assert.match(invocation.prompt, /reject incorrect frozen-object or code claims/)
    assert.ok(invocation.args.includes('bypassPermissions'))
    assert.deepEqual(await f.run(f.state(), replayCallbacks), result)
    rmSync(planPath)
    writeFileSync(planPath, JSON.stringify({ ...plan, readGuidance: undefined }))
    await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'stale_result' })
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

const stderrPadding = ' \t'.repeat(2_000)
for (const [label, chunks, statuses, exhausted, oversizedLine] of [
  ['empty', [], [], false, false],
  ['split HTTP and quota evidence', ['Error: HT', 'TP 429: usage balance exhausted\n', 'Authorization: Bearer FAKE_SECRET_CANARY\n', 'HTTP/1.1 503 Service Unavailable\r\n'], [429, 503], true, false],
  ['oversized and credential-shaped lines', ['x'.repeat(12_000) + ' HTTP 429\n', 'Authorization: Bearer FAKE_SECRET_CANARY HTTP 429\n', 'Error: usage balance exhausted? no\n', 'HTTP status: 402'], [402], false, true],
  ['padded nonmatches and strict HTTP separators', [
    'HTTP status' + stderrPadding + 'other\nHTTP 401' + stderrPadding + 'Other message\n',
    'HTTP status  code 429\nHTTP status:429\nHTTP/2.2 429\nHTTP/3.0 status code' + stderrPadding + '=\t503\n',
    'Error: HTTP/2 error' + stderrPadding + '402 : usage balance exhausted? no\n',
  ], [401, 402, 503], false, false],
] as const) {
  test(`Grok records safe missing-terminal stderr diagnostics for ${label}`, async t => {
    const f = fixture(t, 'missing-terminal', 'grok:default', 'grok-fixture', chunks)
    await assert.rejects(f.run(), { code: 'cancellation_pending', message: 'Grok native stream closed without its original terminal' })
    const root = f.sessionRoot
    const read = (name: string): string => readFileSync(join(root, name), 'utf8')
    const observedStop = read('process-stop-observations.jsonl').trimEnd().split('\n').at(-1)!
    assert.equal(JSON.parse(observedStop).nativeStopped, true)
    const saved = read('missing-terminal-diagnostic.json')
    assert.ok(!/Authorization|FAKE_SECRET_CANARY/.test(saved))
    assert.deepEqual(JSON.parse(saved), {
      version: 1,
      launchDigest: sha256(read('launch.json')),
      planDigest: sha256(read('plan.json')),
      stopDigest: sha256(observedStop),
      exit: { code: chunks.length ? 1 : 0, signal: null },
      stderr: {
        bytes: Buffer.byteLength(chunks.join('')),
        sha256: sha256(chunks.join('')),
        ended: true,
        oversizedLine,
        readError: false,
        httpStatuses: statuses,
        usageBalanceExhausted: exhausted,
      },
    })
    assert.equal(statSync(join(root, 'missing-terminal-diagnostic.json')).mode & 0o777, 0o400)
    assert.equal(f.state().turnId, undefined)
    assert.equal(existsSync(join(root, 'result.json')), false)
    assert.equal(existsSync(join(root, 'settlement.json')), false)
  })
}

for (const [label, chunks, startupErrors, oversizedLine] of [
  ['known argument and split OS errors', [
    "error: unexpected argument '--session-id' found\n",
    'Error: Permission denied (os error ', '13)\n',
    'Error: No such file or directory (os error 2)\n',
    "error: unexpected argument '--session-id' found\n",
  ], [
    { kind: 'unexpected_argument', flag: '--session-id' },
    { kind: 'os_error', errno: 'EACCES' },
    { kind: 'os_error', errno: 'ENOENT' },
  ], false],
  ['private and unknown lines', [
    'Authorization: Bearer FAKE_STARTUP_SECRET\napi_key=FAKE_STARTUP_SECRET\n',
    'Error: /private/FAKE_STARTUP_SECRET: Permission denied (os error 13)\n',
    'Error: https://example.invalid/?key=FAKE_STARTUP_SECRET\n',
    '{"error":"Error: Permission denied (os error 13)","key":"FAKE_STARTUP_SECRET"}\n',
    "error: unexpected argument '--api-key' found\n",
    "error: unexpected argument '--model' found\n",
    "error: unexpected argument 'FAKE_STARTUP_SECRET' found\n",
  ], [], false],
  ['confusable and non-complete templates', [
    "prefix error: unexpected argument '--session-id' found\n",
    "error: unexpected argument '--session-id' found FAKE_STARTUP_SECRET\n",
    "ｅrror: unexpected argument '--session-id' found\n",
    "error: unexpected argument '--session-id' found\u2028\n",
    "error: unexpected argu\nment '--session-id' found\n",
    "\x1b[31merror: unexpected argument '--session-id' found\x1b[0m\n",
    'Error: Permission denied (os error 13) trailing\n',
    'Error: Permission denied (os error 130)\n',
  ], [], false],
  ['oversized split lines never become templates', [
    "error: unexpected argument '--session-id' found", ' '.repeat(5_000), '\n',
    'x'.repeat(5_000), 'Error: Permission denied (os error 13)\n',
    ' '.repeat(5_000), 'Error: No such file or directory (os error 2)',
  ], [], true],
] as const) {
  test(`Grok startup stderr projects only safe fixed reasons for ${label}`, async t => {
    const f = fixture(t, 'startup-error', 'grok:default', 'grok-fixture', chunks)
    await assert.rejects(f.run(), { code: 'cancellation_pending', message: 'Grok native stream closed without its original terminal' })
    const raw = readFileSync(join(f.sessionRoot, 'missing-terminal-diagnostic.json'), 'utf8')
    const diagnostic = JSON.parse(raw)
    assert.deepEqual(diagnostic.exit, { code: 1, signal: null })
    assert.deepEqual(diagnostic.stderr, {
      bytes: Buffer.byteLength(chunks.join('')),
      sha256: sha256(chunks.join('')),
      ended: true, oversizedLine, readError: false,
      httpStatuses: [], usageBalanceExhausted: false,
      ...(startupErrors.length ? { startupErrors } : {}),
    })
    assert.ok(!/FAKE_STARTUP_SECRET|Bearer|api_key|https:|private/.test(raw))
    assert.equal(statSync(join(f.sessionRoot, 'missing-terminal-diagnostic.json')).mode & 0o777, 0o400)
    assert.equal(f.state().turnId, undefined)
    assert.equal(existsSync(join(f.sessionRoot, 'result.json')), false)
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
    await assert.rejects(f.run(f.state(), replayCallbacks), { code: 'cancellation_pending' })
  })
}

test('Grok preserves missing-terminal failure only for expected diagnostic I/O or evidence faults', async t => {
  for (const [label, injected, isFileIO] of [
    ['filesystem denial', Object.assign(new Error('fixture rename denied'), { code: 'EACCES', errno: -13, syscall: 'rename' }), true],
    ['unexpected failure with a code', Object.assign(new Error('fixture unexpected failure'), { code: 'ERR_INVALID_ARG_TYPE' }), false],
  ] as const) await t.test(label, async subtest => {
    const f = fixture(subtest, 'missing-terminal')
    const originalRename = fs.renameSync
    subtest.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (to === join(f.sessionRoot, 'missing-terminal-diagnostic.json')) throw injected
      originalRename(from, to)
    })
    const warn = subtest.mock.method(console, 'warn', () => {})
    syncBuiltinESMExports()
    subtest.after(() => { subtest.mock.restoreAll(); syncBuiltinESMExports() })
    if (isFileIO) {
      await assert.rejects(f.run(), { code: 'cancellation_pending', message: 'Grok native stream closed without its original terminal' })
      assert.deepEqual(warn.mock.calls.map(call => call.arguments), [['spex grok native missing-terminal diagnostic unavailable']])
    } else {
      await assert.rejects(f.run(), error => error === injected)
      assert.equal(warn.mock.callCount(), 0)
    }
    assert.equal(existsSync(join(f.sessionRoot, 'settlement.json')), false)
  })
})

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
