import test from 'node:test'
import assert from 'node:assert/strict'
import { structuredExecutionPolicy, structuredRealmRoot, type StructuredExecution } from './session-structured-policy.js'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { assertNativeWorktreeSeed, assertNativeWorktreeResult, nativeWorktreeResult, nativeWorktreePrompt, sampleNativeWorktreeProcesses, nativeWorktreeProcessesStopped } from './native-worktree-runtime.js'
import { claudeWorktreeArgs, claudeStructuredArgs, claudeStructuredTurn, stopClaudeStructuredTurn } from './claude-structured.js'
import { zcodeWorktreePermission, zcodeWorktreeConfiguration, zcodeRuntimeConfiguration, zcodeStructuredTurn, zcodeCapability, zcodeNativeSelection, type ZCodeStructuredExecution } from './zcode-structured.js'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const seed = { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'edit' as const }
const request = { schema: { type: 'object' }, inputDigest: 'input', purpose: 'worktree-test', timeoutMs: null, model: 'claude:MiniMax-M3.1-Flash', worktree: seed }
test('native worktree uses independent policy and native realm without frozen reader', () => {
  const execution = structuredExecutionPolicy(request)
  assert.equal(execution.version, 6)
  assert.equal(execution.policy, 'native-worktree-v1')
  assert.deepEqual((execution as StructuredExecution & { worktree: unknown }).worktree, seed)
  assert.equal(structuredRealmRoot(execution, '/runtime'), '/runtime/structured-native-worktree-v1/claude')
})


const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'spex-native-worktree-')), repo = join(root, 'repo'), path = join(root, 'worktree')
  mkdirSync(repo)
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(repo, args)
  writeFileSync(join(repo, 'value'), 'seed\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'seed'])
  const seed = { baseCommit: git(repo, ['rev-parse', 'HEAD']), tree: git(repo, ['rev-parse', 'HEAD^{tree}']), mode: 'edit' as const }
  git(repo, ['worktree', 'add', '-qb', 'candidate', path, seed.baseCommit])
  return { root, repo, path, seed, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('seed excludes live HEAD, index and WIP; edit result requires a real clean descendant commit with hooks', () => {
  const f = repoFixture()
  try {
    writeFileSync(join(f.repo, 'value'), 'later HEAD\n'); git(f.repo, ['commit', '-am', 'later'])
    writeFileSync(join(f.repo, 'value'), 'later index\n'); git(f.repo, ['add', 'value']); writeFileSync(join(f.repo, 'value'), 'later WIP\n')
    assertNativeWorktreeSeed(f.repo, f.seed)
    assert.equal(readFileSync(join(f.path, 'value'), 'utf8'), 'seed\n')
    assert.throws(() => assertNativeWorktreeSeed(f.repo, { ...f.seed, baseCommit: 'HEAD' }), /immutable/)
    assert.throws(() => assertNativeWorktreeSeed(f.repo, { ...f.seed, tree: git(f.repo, ['rev-parse', 'HEAD^{tree}']) }), /identity/)
    writeFileSync(join(f.path, 'value'), 'candidate\n')
    assert.throws(() => nativeWorktreeResult(f.path, f.seed), /clean/)
    git(f.path, ['add', 'value'])
    const hook = join(f.repo, '.git/hooks/pre-commit'), marker = join(f.root, 'hook-ran')
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\nexit 1\n`); chmodSync(hook, 0o755)
    assert.throws(() => git(f.path, ['commit', '-qm', 'blocked']))
    assert(existsSync(marker)); assert.throws(() => nativeWorktreeResult(f.path, f.seed), /clean/)
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`)
    git(f.path, ['commit', '-qm', 'candidate'])
    const result = nativeWorktreeResult(f.path, f.seed)
    assert.equal(result.tree, git(f.path, ['rev-parse', 'HEAD^{tree}'])); assert.notEqual(result.headCommit, f.seed.baseCommit)
    assertNativeWorktreeResult(f.repo, f.seed, result)
    assert.throws(() => assertNativeWorktreeResult(f.repo, f.seed, { ...result, tree: f.seed.tree }), /identity/)
    git(f.repo, ['worktree', 'remove', f.path])
    assertNativeWorktreeResult(f.repo, f.seed, result)
    assert.equal(existsSync(f.path), false, 'completed cold result does not recreate a closed worktree')
  } finally { f.close() }
})

test('read mode requires unchanged seed and a clean index/worktree', () => {
  const f = repoFixture(), seed = { ...f.seed, mode: 'read' as const }
  try {
    assert.equal(nativeWorktreeResult(f.path, seed).tree, seed.tree)
    writeFileSync(join(f.path, 'untracked'), 'review mutation')
    assert.throws(() => nativeWorktreeResult(f.path, seed), /clean/)
    git(f.path, ['add', '.']); git(f.path, ['commit', '-qm', 'review mutation'])
    assert.throws(() => nativeWorktreeResult(f.path, seed), { code: 'native_worktree_result_invalid', message: /changed/ })
  } finally { f.close() }
})

test('edit HEAD outside seed ancestry remains a typed Git result failure', () => {
  const f = repoFixture()
  try {
    git(f.path, ['checkout', '--orphan', 'unrelated']); git(f.path, ['add', '.']); git(f.path, ['commit', '-qm', 'unrelated root'])
    assert.equal(git(f.path, ['status', '--porcelain']), '')
    assert.throws(() => nativeWorktreeResult(f.path, f.seed), { code: 'native_worktree_result_invalid', message: /not a descendant/ })
  } finally { f.close() }
})

test('read Git alias probe is a typed invalid result and preserves the actual HEAD/index/worktree', () => {
  const f = repoFixture(), seed = { ...f.seed, mode: 'read' as const }, copy = join(f.root, 'copied-worktree')
  try {
    cpSync(f.path, copy, { recursive: true })
    writeFileSync(join(copy, 'probe'), 'experimental spec draft\n'); git(copy, ['add', 'probe']); git(copy, ['commit', '-qm', 'probe'])
    writeFileSync(join(copy, 'staged-probe'), 'uncommitted experiment\n'); git(copy, ['add', 'staged-probe'])
    const head = git(f.path, ['rev-parse', 'HEAD']), status = git(f.path, ['status', '--porcelain=v1', '--untracked-files=all'])
    const index = readFileSync(git(f.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
    assert.notEqual(head, seed.baseCommit); assert.match(status, /probe/)
    assert.throws(() => nativeWorktreeResult(f.path, seed), error => {
      assert.equal((error as { code: string }).code, 'native_worktree_result_invalid')
      const message = (error as Error).message
      for (const value of [seed.baseCommit, seed.tree, head, status, f.path]) assert(message.includes(value) || message.includes(JSON.stringify(value).slice(1, -1)), value)
      assert.match(message, /independent.*Git|独立.*Git/)
      return true
    })
    assert.equal(git(f.path, ['rev-parse', 'HEAD']), head); assert.equal(git(f.path, ['status', '--porcelain=v1', '--untracked-files=all']), status)
    assert.deepEqual(readFileSync(git(f.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])), index)
    assert.equal(readFileSync(join(copy, 'probe'), 'utf8'), 'experimental spec draft\n')
    assert.throws(() => assertNativeWorktreeSeed(f.path, { ...seed, tree: 'f'.repeat(40) }), { code: 'failed' })
    assert.throws(() => assertNativeWorktreeResult(f.repo, seed, { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: head, tree: git(f.path, ['rev-parse', 'HEAD^{tree}']), worktreePath: f.path }), { code: 'stale_result' })
  } finally { f.close() }
})

test('normal worktree capabilities and prompt remain distinct from the frozen reader', () => {
  const args = claudeWorktreeArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: { type: 'object' } })
  assert.equal(args.includes('--restricted'), false); assert.equal(args.includes('--tools'), false); assert.equal(args.includes('--allowedTools'), false)
  assert.equal(args.includes('--json-schema'), true)
  const readArgs = claudeWorktreeArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: {}, mode: 'read' })
  assert.equal(readArgs[readArgs.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Read', input: { file_path: '/any/context' } }, 'session', '/worktree', 'read'), 'allow')
  assert.equal(zcodeWorktreePermission({ sessionId: 'foreign', toolName: 'Bash' }, 'session', '/worktree', 'edit'), 'deny')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: 'src/file.ts' } }, 'session', '/worktree', 'read'), 'deny')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: 'src/file.ts' } }, 'session', '/worktree', 'edit'), 'allow')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: '../outside' } }, 'session', '/worktree', 'edit'), 'deny')
  const old = claudeStructuredArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: {}, mcpConfig: '/frozen' })
  assert(old.includes('--restricted')); assert(old.includes('--tools')); assert(old.includes('--allowedTools'))
  assert.equal((zcodeRuntimeConfiguration().features as { mcp: boolean }).mcp, true)
  assert.equal((zcodeWorktreeConfiguration().features as { mcp: boolean }).mcp, false)
  assert.equal(nativeWorktreePrompt('unchanged task', seed), nativeWorktreePrompt('unchanged task', seed))
  assert(nativeWorktreePrompt('unchanged task', seed).includes('git commit with hooks enabled'))
  for (const model of ['claude:MiniMax-M3.1-Flash', 'zcode:bigmodel-api/GLM-5.3-Flash']) for (const timeoutMs of [null, 1000]) {
    const policy = structuredExecutionPolicy({ ...request, model, timeoutMs })
    assert.equal(policy.version, 6); assert.equal(policy.frozenContext, undefined); assert.equal(policy.readerRuntime, undefined)
    assert.notEqual(hash(policy), hash(structuredExecutionPolicy({ ...request, model, timeoutMs, worktree: { ...seed, baseCommit: 'c'.repeat(40) } })))
  }
  assert.throws(() => structuredExecutionPolicy({ ...request, model: 'gpt-default' }), /explicit/)
})

async function deadProcess(root: string) {
  sampleNativeWorktreeProcesses({ root, receiptFile: join(root, 'process.json') })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  assert(child.pid)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve())), receiptFile = join(root, 'process.json')
  const identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
  writeFileSync(join(root, 'owned-processes.json'), JSON.stringify([{ pid: child.pid, startToken: identity.startToken.replace(/\s+/g, ' ') }]))
  process.kill(-child.pid, 'SIGTERM'); await exited
  return { pid: child.pid, receiptFile }
}
const noDispatch = { onThread: async (): Promise<void> => assert.fail('cold replay cannot create thread'), onTurn: async (): Promise<void> => assert.fail('cold replay cannot send turn'), onNative: async (): Promise<void> => assert.fail('cold replay cannot launch CLI') }

test('Claude worktree cold completion binds native user/model/exit and never borrows frozen proof', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native')
  mkdirSync(join(root, 'claude-home/projects/exact'), { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = nativeWorktreePrompt('read real files', { ...f.seed, mode: 'read' }), output = { ok: true }
    const policy = structuredExecutionPolicy({ ...request, schema: { type: 'object', required: ['ok'] }, worktree: { ...f.seed, mode: 'read' } })
    const native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', ...processIdentity }, execution: StructuredExecution = { ...policy, claudeNative: native, state: 'running' }
    const plan = { ...native, policyDigest: hash(policy), requestDigest: hash({ prompt, policy }), cliVersion: '2.1.309 (Claude Code)' }
    const echo = { uuid: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'launch.json': { cwd: f.path }, 'init.json': { session_id: 'session', model: 'MiniMax-M3.1-Flash', tools: ['Read', 'Bash', 'Edit', 'StructuredOutput'] }, 'user-echo.json': echo, 'result.json': { type: 'result', subtype: 'success', is_error: false, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: output }, 'exit.json': { code: 0, signal: null, stopped: true } })) writeFileSync(join(root, name), JSON.stringify(value))
    writeFileSync(join(root, 'claude-home/projects/exact/session.jsonl'), JSON.stringify({ type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: echo.message }) + '\n')
    const result = await claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path)
    assert.equal(result.frozenReadProof, undefined); assert.deepEqual(JSON.parse(result.text), output)
    const completed = { ...execution, state: 'completed' as const, threadId: 'session', turnId: 'user', output, resultDigest: hash(output) }
    git(f.repo, ['worktree', 'remove', f.path])
    const kill = process.kill; let historicalProbes = 0
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === processIdentity.pid && signal === 0) { historicalProbes++; return true }
      return kill(pid, signal)
    }) as typeof process.kill
    try {
      assert.deepEqual(await claudeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), result)
      assert.equal(historicalProbes, 0, 'completed replay must not consult an unrelated reused PID/PGID')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, { ...completed, state: 'running' }, noDispatch, f.path), { code: 'cancellation_pending' })
      assert(historicalProbes > 0, 'unsettled recovery must still consult the live native process identity')
    } finally { process.kill = kill }
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt + 'changed', completed, noDispatch, f.path), { code: 'stale_result' })
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: false }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
  } finally { f.close() }
})

test('ZCode worktree cold completion binds original send, model snapshot and exact terminal without MCP', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native'), runtime = join(root, 'runtime')
  mkdirSync(runtime, { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = 'Review normal worktree', output = { ok: true }, response = JSON.stringify(output)
    const policy = structuredExecutionPolicy({ ...request, model: 'zcode:bigmodel-api/GLM-5.3-Flash', effort: 'high', worktree: { ...f.seed, mode: 'read' } })
    const selection = zcodeNativeSelection(policy.model, policy.effort), nativePrompt = `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(policy.schema)}\n\n${prompt}`
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input', turnId: 'turn', ...processIdentity }
    const execution: ZCodeStructuredExecution = { ...policy, version: 6, policy: 'native-worktree-v1', zcodeNative: native, state: 'running', frozenReadProof: undefined }
    const modelSnapshot = { sessionId: 'session', model: selection.model, thoughtLevel: 'high' }
    const plan = { ...native, worktreeProcessBaseline: 1, queryId: 'query', runtime, workspace: f.path, ...selection, policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, modelSnapshotDigest: hash(modelSnapshot) }
    const events = [
      { type: 'turn.started', payload: { inputId: 'input', queryId: 'query', messageId: 'user' } },
      { type: 'session.updated', payload: { providerId: selection.model.providerId, modelId: selection.model.modelId, toolCount: 9 } },
      { type: 'tool.updated', payload: { kind: 'scheduled', toolName: 'Bash', toolCallId: 'normal' } },
      { type: 'turn.completed', payload: { inputId: 'input', resultType: 'success', response } },
    ].map((event, index) => ({ ...event, eventId: `event-${index}`, seq: index + 1, sessionId: 'session', turnId: 'turn' }))
    const messages = [
      { info: { id: 'user', sessionID: 'session', role: 'user', anchor: { turnId: 'turn' }, modelSelection: selection.model, semantics: { kind: 'user_prompt' } }, parts: [{ type: 'text', text: nativePrompt }] },
      { info: { id: 'final', sessionID: 'session', role: 'assistant', anchor: { turnId: 'turn' }, ...selection.model, semantics: { kind: 'assistant_response' } }, parts: [{ type: 'text', text: response }] },
    ]
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'model-snapshot.json': modelSnapshot, 'events.json': events, 'messages.json': messages, 'terminal.json': events.at(-1), 'exit.json': { code: 0, signal: null, stopped: true, idle: true, closed: true }, 'send.json': { sessionId: 'session', content: nativePrompt, inputId: 'input', modelSelection: selection.model } })) writeFileSync(join(root, name), JSON.stringify(value))
    const result = await zcodeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path)
    assert.deepEqual(JSON.parse(result.text), output); assert.equal(result.frozenReadProof, undefined)
    const completed = { ...execution, state: 'completed' as const, threadId: 'session', turnId: 'turn', output, resultDigest: hash(output) }
    git(f.repo, ['worktree', 'remove', f.path])
    const kill = process.kill; let historicalProbes = 0
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === processIdentity.pid && signal === 0) { historicalProbes++; return true }
      return kill(pid, signal)
    }) as typeof process.kill
    try {
      assert.deepEqual(await zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), result)
      assert.equal(historicalProbes, 0, 'completed replay must not consult an unrelated reused PID/PGID')
      await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, { ...completed, state: 'running' }, noDispatch, f.path), { code: 'cancellation_pending' })
      assert(historicalProbes > 0, 'unsettled recovery must still consult the live native process identity')
    } finally { process.kill = kill }
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, { ...completed, effort: undefined }, noDispatch, f.path), { code: 'stale_result' })
    writeFileSync(join(root, 'terminal.json'), JSON.stringify({ ...events.at(-1), turnId: 'foreign' }))
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
  } finally { f.close() }
})

test('unknown worktree process ownership cannot be declared stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-native-worktree-pending-')), root = join(directory, 'native')
  mkdirSync(root)
  try {
    const policy = structuredExecutionPolicy(request), native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', pid: process.pid, receiptFile: join(root, 'missing-receipt') }
    const execution = { ...policy, claudeNative: native, turnStartRequested: true }
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...native, policyDigest: hash(policy) }))
    const stop = await stopClaudeStructuredTurn(execution, 10)
    assert.equal(stop.nativeStopped, false); assert.match(stop.error ?? '', /unproven/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('real creation queue runs a fake native CLI in the exact seed worktree, commits edits and replays after close without dispatch', () => {
  const f = repoFixture(), bin = join(f.root, 'bin'), home = join(f.root, 'home'), count = join(f.root, 'dispatches.json'), runner = join(f.root, 'runner.mts')
  mkdirSync(bin); mkdirSync(home)
  try {
    // Discard this fixture's unused first candidate; production creates its own governed linked worktree.
    git(f.repo, ['worktree', 'remove', f.path])
    mkdirSync(join(f.repo, '.spec')); writeFileSync(join(f.repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    git(f.repo, ['add', '.spec']); git(f.repo, ['commit', '-qm', 'project'])
    const seed = { ...f.seed, baseCommit: git(f.repo, ['rev-parse', 'HEAD']), tree: git(f.repo, ['rev-parse', 'HEAD^{tree}']) }
    writeFileSync(join(f.repo, 'value'), 'later index'); git(f.repo, ['add', 'value']); writeFileSync(join(f.repo, 'value'), 'later WIP')
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline'),cp=require('node:child_process');
if(process.argv.includes('--version')){process.stdout.write('2.1.309 (Claude Code)\\n');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const prompt=user.message.content[0].text;
const rows=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];rows.push({cwd:process.cwd(),args:process.argv.slice(2),prompt});fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(rows));
const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
send({type:'system',subtype:'init',session_id:session,model,tools:['Read','Grep','Bash','Edit','StructuredOutput']});send(user);
if(prompt.startsWith('malformed')){const Ajv=require(${JSON.stringify(createRequire(import.meta.url).resolve('ajv'))}).default,validate=new Ajv({allErrors:true}).compile(JSON.parse(arg('--json-schema'))),input={items:{}};validate(input);const error='Output does not match required schema: '+validate.errors.map(item=>item.instancePath+': '+item.message).join(', '),rows=[{type:'api-request',sessionId:session,id:'request',params:{model}},{type:'assistant',sessionId:session,uuid:'schema-assistant',parentUuid:user.uuid,requestRef:'request',message:{role:'assistant',content:[{type:'tool_use',id:'schema-call',name:'StructuredOutput',input}]}},{type:'user',sessionId:session,uuid:'schema-error',parentUuid:'schema-assistant',promptId:'prompt-'+user.uuid,sourceToolAssistantUUID:'schema-assistant',message:{role:'user',content:[{type:'tool_result',tool_use_id:'schema-call',is_error:true,content:error}]}}];fs.appendFileSync(path.join(project,session+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');process.exitCode=1;send({type:'result',subtype:'error_max_structured_output_retries',is_error:true,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});return;}

if(prompt.startsWith('alias')){const copy=path.join(${JSON.stringify(f.root)},'alias-copy');fs.cpSync(process.cwd(),copy,{recursive:true});fs.writeFileSync(path.join(copy,'probe'),'draft');cp.execFileSync('git',['-C',copy,'add','probe']);cp.execFileSync('git',['-C',copy,'commit','-qm','experimental probe']);fs.writeFileSync(path.join(copy,'index-probe'),'staged');cp.execFileSync('git',['-C',copy,'add','index-probe'])}
if(prompt.startsWith('edit')||prompt.startsWith('dirty')){fs.writeFileSync('value','actual candidate\\n');if(!prompt.startsWith('dirty')){cp.execFileSync('git',['add','value']);cp.execFileSync('git',['commit','-qm','native candidate'])}}
send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'result',user_message_uuid:user.uuid,user_message_uuids:[user.uuid],structured_output:{ok:true}});
});
`)
    chmodSync(executable, 0o755)
    const structured = fileURLToPath(new URL('./session-structured.ts', import.meta.url)), records = fileURLToPath(new URL('./session-record.ts', import.meta.url))
    writeFileSync(runner, `import assert from 'node:assert/strict';import{readFileSync,renameSync,existsSync}from'node:fs';import{execFileSync}from'node:child_process';import{runStructuredSession,cancelStructuredSession}from${JSON.stringify(structured)};import{readRecord,writeRecord}from${JSON.stringify(records)};
const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim(),seed=${JSON.stringify(seed)},schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const make=(key,prompt,mode,timeoutMs)=>({root:process.cwd(),base:seed.baseCommit,requestKey:key,inputDigest:key,purpose:'real-queue-worktree',prompt,schema,timeoutMs,model:'claude:MiniMax-M3.1-Flash',worktree:{...seed,mode}});
const first=make('read','read '+'x'.repeat(70000),'read',10000),read=await runStructuredSession(first),record=readRecord(read.sessionId);
assert.equal(record.forkCommit,seed.baseCommit);assert.equal(record.base,seed.baseCommit);assert.equal(record.structuredExecution.frozenContext,undefined);assert.equal(record.structuredExecution.frozenReadProof,undefined);assert.equal(read.worktree.tree,seed.tree);assert.equal(readFileSync(read.worktree.worktreePath+'/value','utf8'),'seed\\n');
const nextSeed=git(['commit-tree',seed.tree,'-p',seed.baseCommit,'-m','other seed']);await assert.rejects(runStructuredSession({...first,base:nextSeed,worktree:{...first.worktree,baseCommit:nextSeed}}),{code:'key_reused'});
git(['worktree','remove',read.worktree.worktreePath]);assert.deepEqual(await runStructuredSession(first),read);
const stoppedRecord=readRecord(read.sessionId),receipt=stoppedRecord.structuredExecution.claudeNative.receiptFile;renameSync(receipt,receipt+'.held');writeRecord({...stoppedRecord,structuredExecution:{...stoppedRecord.structuredExecution,state:'running',output:undefined,resultDigest:undefined,resultWorktree:undefined}});
const pending=await cancelStructuredSession(read.sessionId,{timeoutMs:20});assert.equal(pending.nativeStopped,false);assert.equal(pending.state,'cancelling');
await assert.rejects(runStructuredSession(make('blocked','edit blocked','edit',500)),{code:'timeout'});assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);
renameSync(receipt+'.held',receipt);const restoredStop=await cancelStructuredSession(read.sessionId,{timeoutMs:1000});assert.equal(restoredStop.nativeStopped,true,JSON.stringify({restoredStop,unknown:JSON.parse(readFileSync(stoppedRecord.structuredExecution.claudeNative.root+'/unattributed-processes.json','utf8'))}));

const edit=await runStructuredSession(make('edit','edit candidate','edit',null));assert.notEqual(edit.worktree.headCommit,seed.baseCommit);assert.equal(git(['rev-parse',edit.worktree.headCommit+'^{tree}']),edit.worktree.tree);assert.equal(readRecord(edit.sessionId).structuredExecution.resultWorktree.tree,edit.worktree.tree);
const dirtyFailure=await runStructuredSession(make('dirty','dirty candidate','edit',10000)).then(()=>null,error=>error);const dirtyRecord=dirtyFailure?.sessionId&&readRecord(dirtyFailure.sessionId),unknownFile=dirtyRecord?.structuredExecution?.claudeNative?.root+'/unattributed-processes.json';assert.equal(dirtyFailure?.code,'native_worktree_result_invalid',JSON.stringify({code:dirtyFailure?.code,unknown:unknownFile&&existsSync(unknownFile)?JSON.parse(readFileSync(unknownFile,'utf8')):null}));
assert.equal(dirtyRecord.structuredExecution.errorCode,'native_worktree_result_invalid');assert.equal(dirtyRecord.structuredExecution.state,'failed');assert.equal(dirtyRecord.structuredExecution.output,undefined);assert.equal(dirtyRecord.structuredExecution.resultWorktree,undefined);assert.equal(existsSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json'),true);const beforeReplay=readFileSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json');await assert.rejects(runStructuredSession(make('dirty','dirty candidate','edit',10000)),{code:'native_worktree_result_invalid'});assert.deepEqual(readFileSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json'),beforeReplay);
const aliasRequest=make('alias','alias read experiment','read',null),aliasFailure=await runStructuredSession(aliasRequest).then(()=>null,error=>error),aliasRecord=readRecord(aliasFailure.sessionId);assert.equal(aliasFailure.code,'native_worktree_result_invalid');assert.equal(aliasRecord.structuredExecution.errorCode,aliasFailure.code);assert.equal(aliasRecord.structuredExecution.output,undefined);assert.equal(aliasRecord.structuredExecution.resultWorktree,undefined);assert.match(aliasFailure.message,/index-probe/);await assert.rejects(runStructuredSession(aliasRequest),{code:'native_worktree_result_invalid'});
for(const timeoutMs of [10000,null]){const malformed={...make('malformed-'+timeoutMs,'malformed output','read',timeoutMs),schema:{type:'object',properties:{items:{type:'array',maxItems:0}},required:['items'],additionalProperties:false}},failure=await runStructuredSession(malformed).then(()=>null,error=>error);assert.equal(failure?.code,'structured_output_retries_exhausted');assert.match(failure.message,/items.*must be array/);const record=readRecord(failure.sessionId);assert.equal(record.structuredExecution.errorCode,'structured_output_retries_exhausted');assert.equal(record.structuredExecution.output,undefined);assert.equal(record.structuredExecution.resultWorktree,undefined);await assert.rejects(runStructuredSession(malformed),{code:'structured_output_retries_exhausted'});assert.equal(existsSync(record.structuredExecution.claudeNative.root+'/completed.json'),false);}
const calls=JSON.parse(readFileSync(${JSON.stringify(count)},'utf8'));assert.equal(calls.length,6);assert.equal(calls[0].cwd,read.worktree.worktreePath);assert.equal(calls[1].cwd,edit.worktree.worktreePath);assert(calls[0].prompt.startsWith(first.prompt));assert.equal(calls.some(x=>x.args.includes('--restricted')||x.args.includes('--allowedTools')),false);process.exit(0);
`)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: f.repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), ANTHROPIC_BASE_URL: 'https://example.invalid', SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally { f.close() }
})

test('Claude terminal settlement and closed-stdin cancellation remain bounded with an unlimited model budget', () => {
  const f = repoFixture(), bin = join(f.root, 'lifecycle-bin'), runner = join(f.root, 'lifecycle.mjs'), count = join(f.root, 'lifecycle-dispatches.json')
  mkdirSync(bin)
  try {
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
if(process.argv.includes('--version')){console.log('2.1.309 (Claude Code)');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),root=path.dirname(process.env.CLAUDE_CONFIG_DIR),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const input=rl.createInterface({input:process.stdin});input.on('close',()=>fs.writeFileSync(path.join(root,'stdin-ended'),'true'));
input.on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const mode=user.message.content[0].text,project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');
const calls=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];calls.push(mode);fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(calls));
fs.mkdirSync(project,{recursive:true});const history=path.join(project,session+'.jsonl');fs.writeFileSync(history,JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
send({type:'system',subtype:'init',session_id:session,model,tools:['Read','Bash','StructuredOutput']});send(user);
if(mode==='ignore-term')process.on('SIGTERM',()=>fs.writeFileSync(path.join(root,'term-received'),'true'));
if(mode==='term-exit-zero'||mode==='hanging-exhausted-exit1')process.on('SIGTERM',()=>process.exit(mode==='term-exit-zero'?0:1));
if(mode==='esrch-race')setTimeout(()=>process.exit(0),500);
if(!mode.startsWith('natural'))setInterval(()=>{},1000);
if(mode.includes('exhausted')){const Ajv=require(${JSON.stringify(createRequire(import.meta.url).resolve('ajv'))}).default,validate=new Ajv({allErrors:true}).compile(JSON.parse(arg('--json-schema'))),value={items:{}};validate(value);const error='Output does not match required schema: '+validate.errors.map(e=>e.instancePath+': '+e.message).join(', ');fs.appendFileSync(history,[{type:'api-request',sessionId:session,id:'request',params:{model}},{type:'assistant',sessionId:session,uuid:'call-parent',parentUuid:user.uuid,requestRef:'request',message:{role:'assistant',content:[{type:'tool_use',id:'schema-call',name:'StructuredOutput',input:value}]}},{type:'user',sessionId:session,uuid:'schema-error',parentUuid:'call-parent',promptId:'prompt-'+user.uuid,sourceToolAssistantUUID:'call-parent',message:{role:'user',content:[{type:'tool_result',tool_use_id:'schema-call',is_error:true,content:error}]}}].map(x=>JSON.stringify(x)).join('\\n')+'\\n');process.exitCode=1;send({type:'result',subtype:'error_max_structured_output_retries',is_error:true,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});}
else send({type:'result',subtype:'success',is_error:false,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid],structured_output:{items:[]}});
});`)
    chmodSync(executable, 0o755)
    const modulePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url))
    writeFileSync(runner, String.raw`import assert from 'node:assert/strict';import{readFileSync,writeFileSync,existsSync,renameSync,chmodSync}from'node:fs';import{join}from'node:path';import{randomUUID,createHash}from'node:crypto';
import{claudeStructuredTurn,stopClaudeStructuredTurn}from${JSON.stringify(modulePath('./claude-structured.ts'))};import{structuredExecutionPolicy}from${JSON.stringify(modulePath('./session-structured-policy.ts'))};
const originalTimeout=globalThis.setTimeout,armed=[];globalThis.setTimeout=(callback,delay,...args)=>{if(delay===10000||delay===15000)armed.push(delay);return originalTimeout(callback,delay===10000?200:delay===15000?700:delay,...args)};
const sleep=ms=>new Promise(resolve=>originalTimeout(resolve,ms)),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),count=${JSON.stringify(count)},realm=${JSON.stringify(join(f.root, 'lifecycle-realm'))},workspace=${JSON.stringify(f.path)},seed=${JSON.stringify(f.seed)},schema={type:'object',properties:{items:{type:'array',maxItems:0}},required:['items'],additionalProperties:false};
const errors=[],originalKill=process.kill;
for(const mode of ['natural-success','natural-exhausted','hanging-exhausted','hanging-success','term-exit-zero','hanging-exhausted-exit1','esrch-race','cancel-closed','ignore-term','wrong-receipt']){
  const execution={...structuredExecutionPolicy({schema,inputDigest:mode,purpose:'lifecycle',timeoutMs:null,model:'claude:MiniMax-M3.1-Flash',worktree:{...seed,mode:'read'}}),state:'running'},id=randomUUID(),root=join(realm,id),controller=new AbortController(),start=armed.length;
  const callbacks={signal:controller.signal,onThread:async value=>{execution.threadId=value},onTurn:async value=>{execution.turnId=value},onTurnStarting:async()=>{execution.turnStartRequested=true},onNative:async value=>{execution.claudeNative=value}};
  const flight=claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace).then(value=>({value}),error=>({error}));
  try{
    const ready=Date.now()+2000;while(!existsSync(join(root,'stdin-ended'))&&Date.now()<ready)await sleep(10);assert(existsSync(join(root,'stdin-ended')),'stdin must have ended after the terminal result');
    if(mode==='wrong-receipt'){const path=execution.claudeNative.receiptFile,receipt=JSON.parse(readFileSync(path,'utf8'));renameSync(path,path+'.held');writeFileSync(path,JSON.stringify({...receipt,pid:process.pid}))}
    if(mode==='esrch-race')process.kill=(pid,signal)=>{if(pid===-execution.claudeNative.pid&&signal==='SIGTERM'){const error=new Error('simulated exit between verification and signal');error.code='ESRCH';throw error}return originalKill(pid,signal)};
    if(mode==='cancel-closed')controller.abort();
    if(mode==='ignore-term'){controller.abort();await stopClaudeStructuredTurn(execution,30);await sleep(30);await stopClaudeStructuredTurn(execution,30)}
    const outcome=await Promise.race([flight,sleep(1800).then(()=>{throw new Error('terminal/cancel flight exceeded test deadline')})]);
    if(mode==='natural-success'||mode==='esrch-race'){
      assert.deepEqual(JSON.parse(outcome.value.text),{items:[]});if(mode==='natural-success')assert.equal(existsSync(join(root,'terminal-stop.json')),false);else assert.equal(JSON.parse(readFileSync(join(root,'terminal-stop.json'),'utf8')).outcome,'gone');
      execution.state='completed';execution.output={items:[]};execution.resultDigest=hash(execution.output);renameSync(execution.claudeNative.receiptFile,execution.claudeNative.receiptFile+'.held');assert.deepEqual(await claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),outcome.value);
    }else if(mode==='hanging-exhausted-exit1'){assert.equal(outcome.error?.code,'stale_result');assert.equal(existsSync(join(root,'completed.json')),false);const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.code,1);assert.equal(exit.signal,null)
    }else if(mode.includes('exhausted')){
      assert.equal(outcome.error?.code,'structured_output_retries_exhausted');assert.match(outcome.error.message,/items.*must be array/);assert.equal(existsSync(join(root,'completed.json')),false);
      const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.stopped,true);assert.equal(exit.code,mode==='natural-exhausted'?1:null);assert.equal(exit.signal,mode==='natural-exhausted'?null:'SIGTERM');
      const dispatched=JSON.parse(readFileSync(count,'utf8')).length;execution.state='failed';await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:'structured_output_retries_exhausted'});assert.equal(JSON.parse(readFileSync(count,'utf8')).length,dispatched);
      if(mode==='hanging-exhausted'){
        for(const [name,fields] of [['terminal-stop-request.json',['sessionId','userUuid','pid','receiptDigest','requestDigest','resultDigest','signal','requestedAt']],['terminal-stop.json',['requestObservationDigest','outcome','version','observedAt']]]){
          const path=join(root,name),bytes=readFileSync(path),observed=JSON.parse(bytes);
          for(const field of fields){chmodSync(path,0o600);writeFileSync(path,JSON.stringify({...observed,[field]:'foreign'}));await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:'stale_result'})}
          chmodSync(path,0o600);writeFileSync(path,bytes);chmodSync(path,0o400);renameSync(path,path+'.held');await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:name==='terminal-stop.json'?'cancellation_pending':'stale_result'});renameSync(path+'.held',path);
        }
      }
    }else if(mode==='hanging-success'||mode==='term-exit-zero'){
      assert.equal(outcome.error?.code,'failed');assert.equal(existsSync(join(root,'completed.json')),false);const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.code,mode==='hanging-success'?null:0);assert.equal(exit.signal,mode==='hanging-success'?'SIGTERM':null);assert.equal(exit.stopped,true);execution.state='failed';await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),error=>['failed','stale_result'].includes(error.code));
    }else if(mode==='cancel-closed'){assert.equal(outcome.error?.code,'cancelled');assert.equal(JSON.parse(readFileSync(join(root,'exit.json'),'utf8')).signal,'SIGTERM')}
    else{
      assert.equal(outcome.error?.code,'cancellation_pending');assert.equal(existsSync(join(root,'exit.json')),false);assert.equal(existsSync(join(root,'completed.json')),false);process.kill(execution.claudeNative.pid,0);
      if(mode==='ignore-term'){assert(existsSync(join(root,'term-received')));assert.deepEqual(armed.slice(start),[10000,15000]);const stop=await stopClaudeStructuredTurn(execution,20);assert.equal(stop.nativeStopped,false)}
      else assert.equal(existsSync(join(root,'terminal-stop.json')),false,'wrong receipt must not authorize process termination');
    }
    console.log(JSON.stringify({mode,status:'passed',error:outcome.error?.code,armed:armed.slice(start)}));
  }catch(error){errors.push({mode,message:error.message})}
  finally{
    process.kill=originalKill;const native=execution.claudeNative;if(native?.receiptFile&&existsSync(native.receiptFile+'.held'))renameSync(native.receiptFile+'.held',native.receiptFile);
    if(native?.pid){try{process.kill(-native.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}}
    await Promise.race([flight,sleep(1000)]);
  }
}
assert.deepEqual(errors,[]);`)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: f.repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_BASE_URL: 'https://example.invalid', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    console.log(result.stdout)
  } finally { f.close() }
})


for (const taskScoped of [true, false]) test(taskScoped ? 'task cwd orphan stays pending after chdir without gaining kill authority' : 'external orphan and reused task PID do not block stop or replace original evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-native-orphan-')), root = join(directory, 'native'), workspace = join(directory, 'worktree'), outside = join(directory, 'outside')
  for (const path of [root, workspace, outside]) mkdirSync(path)
  const receiptFile = join(root, 'process.json'), daemonFile = join(directory, 'daemon.json'), plan = { root, workspace, receiptFile, pid: undefined as number | undefined }
  sampleNativeWorktreeProcesses(plan)
  const daemonSource = `const fs=require('node:fs');const publish=()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.on('SIGUSR1',()=>{process.chdir(process.argv[2]);publish()});publish();setInterval(()=>{},1000)`
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');process.stdin.once('data',()=>{spawn(process.execPath,['-e',process.argv[4],process.argv[1],process.argv[3]],{detached:true,stdio:'ignore',cwd:process.argv[2]}).unref();process.exit(0)});process.stdout.write('READY')`, daemonFile, taskScoped ? workspace : outside, outside, daemonSource], { cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  assert(leader.pid)
  const closed = new Promise<void>(resolve => leader.once('close', () => resolve()))
  let daemonPid: number | undefined
  try {
    await new Promise<void>(resolve => leader.stdout.once('data', () => resolve()))
    writeDetachedRuntimeReceipt(leader.pid, receiptFile); plan.pid = leader.pid
    sampleNativeWorktreeProcesses(plan); leader.stdin.end('GO'); await closed
    for (let retry = 0; !existsSync(daemonFile) && retry < 100; retry++) await new Promise(resolve => setTimeout(resolve, 10))
    daemonPid = (JSON.parse(readFileSync(daemonFile, 'utf8')) as { pid: number }).pid
    process.kill(daemonPid, 0)
    const oldUnknown = JSON.stringify([{ pid: daemonPid, ppid: 1, startToken: 'historical-other-identity' }]), oldExit = JSON.stringify({ code: 0, signal: null, stopped: false })
    writeFileSync(join(root, 'unknown-processes.json'), oldUnknown); writeFileSync(join(root, 'exit.json'), oldExit)
    if (!taskScoped) writeFileSync(join(root, 'task-related-processes.json'), JSON.stringify([{ pid: daemonPid, startToken: 'historical-other-identity', cwd: workspace, boundaryVersion: 2, observedAt: 1 }]))
    assert.equal((JSON.parse(readFileSync(join(root, 'owned-processes.json'), 'utf8')) as Array<{ pid: number }>).some(row => row.pid === daemonPid), false)
    assert.equal(nativeWorktreeProcessesStopped(plan), !taskScoped)
    assert.equal(nativeWorktreeProcessesStopped(plan, true), !taskScoped)
    process.kill(daemonPid, 0)
    assert.equal(readFileSync(join(root, 'unknown-processes.json'), 'utf8'), oldUnknown)
    assert.equal(readFileSync(join(root, 'exit.json'), 'utf8'), oldExit)
    if (taskScoped) {
      const legacyRoot = join(directory, 'legacy'); mkdirSync(join(legacyRoot, 'claude-home/projects/exact'), { recursive: true })
      for (const name of ['process.json', 'process-baseline.json', 'owned-processes.json']) writeFileSync(join(legacyRoot, name), readFileSync(join(root, name)))
      const prompt = 'Read the original worktree', policy = structuredExecutionPolicy(request), native = { version: 1 as const, root: legacyRoot, sessionId: 'legacy-session', userUuid: 'legacy-user', pid: leader.pid, receiptFile: join(legacyRoot, 'process.json') }
      const execution = { ...policy, state: 'running' as const, claudeNative: native }, message = { role: 'user', content: [{ type: 'text', text: prompt }] }
      const legacyPlan = { ...native, cliVersion: '2.1.309 (Claude Code)', requestDigest: hash({ prompt, policy }), policyDigest: hash(policy) }
      for (const [name, value] of Object.entries({ 'plan.json': legacyPlan, 'launch.json': { cwd: workspace }, 'init.json': { session_id: native.sessionId, model: 'MiniMax-M3.1-Flash', tools: ['Bash', 'StructuredOutput'] }, 'user-echo.json': { uuid: native.userUuid, session_id: native.sessionId, message }, 'result.json': { subtype: 'success', is_error: false, session_id: native.sessionId, user_message_uuid: native.userUuid, user_message_uuids: [native.userUuid], structured_output: { ok: true } }, 'exit.json': { code: 0, signal: null, stopped: false } })) writeFileSync(join(legacyRoot, name), JSON.stringify(value))
      writeFileSync(join(legacyRoot, 'claude-home/projects/exact/legacy-session.jsonl'), JSON.stringify({ type: 'user', sessionId: native.sessionId, uuid: native.userUuid, promptId: 'prompt', parentUuid: null, message }) + '\n')
      await assert.rejects(claudeStructuredTurn(directory, 'legacy', prompt, execution, noDispatch, workspace), { code: 'cancellation_pending' })
      assert.equal(readFileSync(join(legacyRoot, 'exit.json'), 'utf8'), JSON.stringify({ code: 0, signal: null, stopped: false }))
      const related = JSON.parse(readFileSync(join(root, 'task-related-processes.json'), 'utf8')) as Array<{ pid: number; startToken: string; cwd: string }>
      assert(related.some(row => row.pid === daemonPid && row.cwd === realpathSync(workspace)))
      process.kill(daemonPid, 'SIGUSR1')
      for (let retry = 0; retry < 100 && JSON.parse(readFileSync(daemonFile, 'utf8')).cwd !== realpathSync(outside); retry++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(JSON.parse(readFileSync(daemonFile, 'utf8')).cwd, realpathSync(outside))
      assert.equal(nativeWorktreeProcessesStopped(plan), false, 'positive task association remains sticky after chdir')
    } else {
      const diagnostic = JSON.parse(readFileSync(join(root, 'unattributed-processes.json'), 'utf8')) as Array<{ pid: number }>
      assert(diagnostic.some(row => row.pid === daemonPid))
    }
    const observations = readFileSync(join(root, 'process-stop-observations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { boundaryVersion: number; at: number; nativeStopped: boolean })
    assert(observations.length >= 2); assert(observations.every(row => row.boundaryVersion === 2 && row.at > 0))
    process.kill(-daemonPid, 'SIGTERM')
    for (let retry = 0; retry < 100; retry++) {
      try { process.kill(daemonPid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    daemonPid = undefined
    assert.equal(nativeWorktreeProcessesStopped(plan), true)
  } finally {
    if (daemonPid) { try { process.kill(-daemonPid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') } }
    if (leader.exitCode === null && leader.signalCode === null) {
      try { process.kill(-leader.pid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
    }
    await closed; rmSync(directory, { recursive: true, force: true })
  }
})
