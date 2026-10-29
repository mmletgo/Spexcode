import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { claudeStructuredTurn, stopClaudeStructuredTurn } from './claude-structured.js'
import { prepareFrozenPrompt, readFrozenManifest, readFrozenRange, verifyFrozenReadProof } from './frozen-context.js'
import { structuredExecutionPolicy, type StructuredExecution } from './session-structured-policy.js'

const enabled = process.env.SPEX_CLAUDE_NATIVE_TEST === '1'
const evidence = process.env.SPEX_CLAUDE_EVIDENCE_DIR
const schema = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }

for (const kind of ['small', 'worst-controls'] as const) test(`actual Claude ${kind} reads immutable bytes and replays completed proof with zero new CLI turn`, { skip: !enabled, timeout: 300000 }, async () => {
  assert(evidence)
  const root = join(evidence, kind), source = join(root, 'source')
  mkdirSync(source, { recursive: true, mode: 0o700 })
  let marker = `PUBLIC_${randomUUID().replaceAll('-', '')}`
  const prefix = kind === 'small' ? 'p'.repeat(60000) : Array.from({ length: 65536 - marker.length - 20 }, (_, index) => String.fromCharCode(index % 32)).join('')
  let text = `${prefix}\nEND_MARKER=${marker}\n`
  const checkpointPath = join(root, 'checkpoint.json')
  const previous = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as StructuredExecution : undefined
  if (previous) {
    const entry = readFrozenManifest(previous.frozenContext!).entries.find(entry => entry.id === 'payload')!
    text = (JSON.parse(readFrozenRange(previous.frozenContext!, { contextDigest: previous.frozenContext!.contextDigest, entryId: entry.id, startByte: 0, endByte: entry.byteLength }).response.contentItems[0].text) as { text: string }).text
    marker = /END_MARKER=(PUBLIC_[a-z0-9]+)/.exec(text)![1]
  }
  const request = { root: source, model: process.env.SPEX_CLAUDE_NATIVE_MODEL ?? 'claude:MiniMax-M3', prompt: 'Read all required entries completely. Entry payload contains public filler and a labelled END_MARKER. Return its exact END_MARKER value in marker. Do not infer it.', requestKey: `native-${kind}`, inputDigest: `native-${kind}`, purpose: 'native-proof', timeoutMs: 240000, schema, frozenEntries: [{ id: 'payload', label: 'public synthetic payload', kind: 'utf8' as const, text }] }
  const prepared = prepareFrozenPrompt(request, { directory: join(root, 'frozen') })
  let execution: StructuredExecution = previous ?? structuredExecutionPolicy(prepared)
  assert.deepEqual(structuredExecutionPolicy(execution), structuredExecutionPolicy(prepared))
  const realm = join(root, 'realm'), id = 'native'
  const callbacks = { onThread: async (threadId: string) => { execution = { ...execution, threadId } }, onTurn: async (turnId: string) => { execution = { ...execution, turnId } },
    onTurnStarting: async () => { execution = { ...execution, turnStartRequested: true } }, onNative: async (claudeNative: NonNullable<StructuredExecution['claudeNative']>) => { execution = { ...execution, claudeNative }; writeFileSync(join(root, 'checkpoint.json'), JSON.stringify(execution)) } }
  const result = await claudeStructuredTurn(realm, id, prepared.prompt, execution, callbacks)
  assert.deepEqual(JSON.parse(result.text), { marker })
  assert.equal(result.frozenReadProof.version, 3)
  assert.deepEqual(result.frozenReadProof.coveredEntryIds, ['task', 'payload'])
  verifyFrozenReadProof(prepared.frozenContext!, result.frozenReadProof, { threadId: result.threadId, turnId: result.turnId })
  execution = { ...execution, state: 'completed', output: JSON.parse(result.text) as unknown, resultDigest: createHash('sha256').update(result.text).digest('hex'), frozenReadProof: result.frozenReadProof }
  const history = readFileSync(join(realm, id, 'completed.json'))
  unlinkSync(join(realm, id, 'completed.json'))
  const recovered = await claudeStructuredTurn(realm, id, prepared.prompt, execution, { onThread: async () => assert.fail('partial completion cannot launch'), onTurn: async () => assert.fail('partial completion cannot append a turn'), onNative: async () => assert.fail('partial completion cannot dispatch') })
  assert.deepEqual(recovered, result)
  const replay = await claudeStructuredTurn(realm, id, prepared.prompt, execution, { onThread: async () => assert.fail('replay cannot launch'), onTurn: async () => assert.fail('replay cannot create a new user turn'), onNative: async () => assert.fail('replay cannot dispatch') })
  assert.deepEqual(replay, result)
  assert.deepEqual(readFileSync(join(realm, id, 'completed.json')), history)
  writeFileSync(join(root, 'verified.json'), JSON.stringify({ marker, payloadBytes: Buffer.byteLength(text), result, execution, replayAdditionalCalls: 0 }, null, 2))
})

test('actual Claude uses canonical creation/queue, completed replay and exact cancellation with isolated database', { skip: !enabled, timeout: 120000 }, () => {
  assert(evidence)
  const root = join(evidence, 'queue-proof'), repo = join(root, 'repo'), home = join(root, 'home')
  mkdirSync(join(repo, '.spec'), { recursive: true, mode: 0o700 }); mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
  writeFileSync(join(repo, 'README'), 'Public synthetic Claude queue fixture.\n')
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'public fixture']]) execFileSync('git', ['-C', repo, ...args])
  const source = fileURLToPath(new URL('./session-structured.ts', import.meta.url)), records = fileURLToPath(new URL('./session-record.ts', import.meta.url)), sessions = fileURLToPath(new URL('./sessions.ts', import.meta.url))
  const marker = `PUBLIC_${randomUUID().replaceAll('-', '')}`, runner = join(root, 'queue.mts')
  writeFileSync(runner, `import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';
import{runStructuredSession,cancelStructuredSession}from ${JSON.stringify(source)};import{readRecord}from ${JSON.stringify(records)};import{sessionIdForCreateKey}from ${JSON.stringify(sessions)};
const schema=${JSON.stringify(schema)},model=${JSON.stringify(process.env.SPEX_CLAUDE_NATIVE_MODEL ?? 'claude:MiniMax-M3')};
const request={root:process.cwd(),requestKey:'claude-real-queue',inputDigest:'claude-real-queue',purpose:'native-queue-proof',timeoutMs:60000,model,schema,prompt:'Read all entries completely. Return the public marker from payload.',frozenEntries:[{id:'payload',label:'public payload',kind:'utf8',text:${JSON.stringify(marker)}}]};
const result=await runStructuredSession(request);assert.deepEqual(result.output,{marker:${JSON.stringify(marker)}});const state=readRecord(result.sessionId).structuredExecution;assert.equal(state.state,'completed');assert.equal(state.policy,'claude-frozen-read-only-v1');
const replay=await runStructuredSession(request);assert.deepEqual(replay,result);
const controller=new AbortController(),key='claude-real-cancel',pending=runStructuredSession({...request,requestKey:key,inputDigest:key,frozenEntries:[],prompt:'Read the task completely and return marker=public after checking every requirement.',signal:controller.signal}).then(result=>({result}),error=>({code:error.code}));
const id=sessionIdForCreateKey(key),deadline=Date.now()+30000;while(!readRecord(id)?.structuredExecution?.turnId){if(Date.now()>deadline)throw new Error('exact native user never appeared');await new Promise(r=>setTimeout(r,20));}controller.abort();const outcome=await pending;assert.equal(outcome.code,'cancelled');const stop=await cancelStructuredSession(id);assert(stop.nativeStopped);assert(stop.acknowledged);assert.equal(readRecord(id).structuredExecution.state,'cancelled');
writeFileSync(${JSON.stringify(join(root, 'verified.json'))},JSON.stringify({result,replay,stop,completedState:state,cancelledState:readRecord(id).structuredExecution,replayAdditionalCalls:0},null,2));console.log(JSON.stringify({completed:result.sessionId,cancelled:id,stop}));process.exit();\n`)
  const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: repo, encoding: 'utf8', timeout: 100000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_SESSION_ID: undefined } })
  writeFileSync(join(root, 'stdout.txt'), result.stdout); writeFileSync(join(root, 'stderr.txt'), result.stderr)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('actual Claude exact user cancellation confirms interrupt and native/MCP process-group stop', { skip: !enabled, timeout: 60000 }, async () => {
  assert(evidence)
  const root = join(evidence, 'cancel-proof'), source = join(root, 'source')
  mkdirSync(source, { recursive: true, mode: 0o700 })
  const prepared = prepareFrozenPrompt({ root: source, model: process.env.SPEX_CLAUDE_NATIVE_MODEL ?? 'claude:MiniMax-M3', prompt: 'Read the task and then return marker=public after carefully checking all requirements.', schema, requestKey: 'cancel', inputDigest: 'cancel', purpose: 'native-cancel', timeoutMs: 30000 }, { directory: join(root, 'frozen') })
  let execution = structuredExecutionPolicy(prepared)
  const controller = new AbortController()
  const task = claudeStructuredTurn(join(root, 'realm'), 'native', prepared.prompt, execution, { signal: controller.signal,
    onThread: async threadId => { execution = { ...execution, threadId } }, onTurn: async turnId => { execution = { ...execution, turnId }; controller.abort() },
    onTurnStarting: async () => { execution = { ...execution, turnStartRequested: true } }, onNative: async claudeNative => { execution = { ...execution, claudeNative } } })
  await assert.rejects(task, error => (error as { code: string }).code === 'cancelled')
  const stop = await stopClaudeStructuredTurn(execution)
  assert(stop.nativeStopped)
  assert(stop.acknowledged)
  writeFileSync(join(root, 'verified.json'), JSON.stringify({ stop, execution }, null, 2))
})
