import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartToken } from '@spexcode/spec-core'
import { codexStructuredTurn } from './codex-harness.js'
import { prepareStructuredRealm, structuredObserverState, StructuredSessionError, StructuredSessionTransportError, type StructuredExecution } from './session-structured-policy.js'

type Rpc = { id?: number; method: string; params: Record<string, unknown> }
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }
const execution = (extra: Partial<StructuredExecution> = {}): StructuredExecution => ({ version: 1, policy: 'codex-read-only-v1', schema, inputDigest: 'immutable-input', purpose: 'test', timeoutMs: 2000, ...extra })
const finalTurn = (id = 'turn-exact', status = 'completed') => ({ id, status, items: [
  { type: 'userMessage', content: [{ type: 'text', text: 'pinned prompt' }] },
  { type: 'agentMessage', phase: 'commentary', text: 'not a result' },
  { type: 'agentMessage', phase: 'final_answer', text: '{"answer":"exact"}' },
] })
async function fixture(handler: (request: Rpc, send: (value: unknown) => void, socket: Socket) => unknown): Promise<{ path: string; close(): Promise<void>; calls: Rpc[] }> {
  const root = mkdtempSync(join(tmpdir(), 'spex-structured-rpc-')); const path = join(root, 'rpc.sock'); const calls: Rpc[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0), upgraded = false
    const send = (value: unknown): void => {
      const payload = Buffer.from(JSON.stringify(value)); const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
      socket.write(Buffer.concat([header, payload]))
    }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        buffer = buffer.subarray(end + 4); upgraded = true
      }
      while (buffer.length >= 2) {
        const masked = !!(buffer[1] & 128); let length = buffer[1] & 127, offset = 2
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
        const start = offset + (masked ? 4 : 0); if (buffer.length < start + length) return
        const payload = Buffer.from(buffer.subarray(start, start + length)); if (masked) for (let index = 0; index < length; index++) payload[index] ^= buffer[offset + index % 4]
        buffer = buffer.subarray(start + length)
        const request = JSON.parse(payload.toString()) as Rpc; calls.push(request)
        if (request.id === undefined) continue
        const response = handler(request, send, socket)
        if (response !== undefined) send({ id: request.id, result: response })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return { path, calls, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) } }
}
const safePrelude = (request: Rpc): unknown => {
  if (request.method === 'initialize') return {}
  if (request.method === 'config/read') return { config: { sandbox_mode: 'read-only', approval_policy: 'never', features: { apps: false, plugins: false, hooks: false, shell_tool: false, code_mode: false, code_mode_host: false }, mcp_servers: {} } }
  if (request.method === 'hooks/list') return { data: [{ hooks: [], errors: [] }] }
  if (request.method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
  if (request.method === 'thread/start') return { thread: { id: 'thread-exact', turns: [] } }
  return undefined
}
const callbacks = { onThread: async (_id: string): Promise<void> => {}, onTurn: async (_id: string): Promise<void> => {} }

test('structured first-turn subscription captures early completion and never selects foreign or old final answers', async () => {
  const identities: string[] = []
  const f = await fixture((request, send) => {
    if (request.method === 'turn/start') {
      assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly' }); assert.deepEqual(request.params.outputSchema, schema)
      send({ method: 'turn/completed', params: { threadId: 'foreign', turn: finalTurn() } })
      send({ method: 'turn/completed', params: { threadId: 'thread-exact', turn: finalTurn() } })
      return { turn: { id: 'turn-exact' } }
    }
    if (request.method === 'thread/read') return { thread: { id: 'thread-exact', turns: [finalTurn(), { ...finalTurn('old-turn'), items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"answer":"wrong"}' }] }] } }
    return safePrelude(request)
  })
  try {
    const result = await codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution(), { onThread: async (id) => { identities.push(id) }, onTurn: async (id) => { identities.push(id) } })
    assert.deepEqual(result, { threadId: 'thread-exact', turnId: 'turn-exact', text: '{"answer":"exact"}' })
    assert.deepEqual(identities, ['thread-exact', 'turn-exact'])
    assert.equal(f.calls.some((call) => call.method === 'turn/steer'), false)
  } finally { await f.close() }
})

for (const status of ['failed', 'interrupted']) test(`structured ${status} turn cannot become completed output`, async () => {
  const f = await fixture((request, send) => {
    if (request.method === 'turn/start') { send({ method: 'turn/completed', params: { threadId: 'thread-exact', turn: finalTurn('turn-exact', status) } }); return { turn: { id: 'turn-exact' } } }
    if (request.method === 'thread/read') return { thread: { id: 'thread-exact', turns: [finalTurn('turn-exact', status)] } }
    return safePrelude(request)
  })
  try { await assert.rejects(codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution(), callbacks), (error: unknown) => error instanceof StructuredSessionError && error.code === (status === 'interrupted' ? 'cancelled' : 'failed')) }
  finally { await f.close() }
})

for (const mode of ['cancel', 'timeout']) test(`structured ${mode} detaches its observer without claiming native settlement`, async () => {
  const controller = new AbortController()
  const f = await fixture((request) => request.method === 'turn/start' ? { turn: { id: 'turn-exact' } } : safePrelude(request))
  try {
    await assert.rejects(codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution({ timeoutMs: mode === 'timeout' ? 80 : 2000 }), { ...callbacks, signal: controller.signal, onTurn: async () => { if (mode === 'cancel') controller.abort() } }), (error: unknown) => error instanceof StructuredSessionError && error.code === (mode === 'cancel' ? 'cancelled' : 'timeout'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(f.calls.some((request) => request.method === 'turn/interrupt'), false, 'native cancellation is owned by the durable session control seam')
  } finally { await f.close() }
})

test('structured recovery reuses exact persisted thread/turn without launching another turn', async () => {
  const f = await fixture((request) => {
    if (request.method === 'thread/resume' || request.method === 'thread/read') return { thread: { id: 'thread-exact', turns: [finalTurn(), finalTurn('old')] } }
    return safePrelude(request)
  })
  try {
    const result = await codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution({ threadId: 'thread-exact', turnId: 'turn-exact' }), callbacks)
    assert.equal(result.turnId, 'turn-exact'); assert.equal(f.calls.some((call) => call.method === 'turn/start'), false)
  } finally { await f.close() }
})

test('lost turn acceptance is recoverable only for the sole turn with pinned user input', async () => {
  const f = await fixture((request) => {
    if (request.method === 'thread/resume' || request.method === 'thread/read') return { thread: { id: 'thread-exact', turns: [finalTurn()] } }
    return safePrelude(request)
  })
  try {
    const result = await codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution({ threadId: 'thread-exact' }), callbacks)
    assert.equal(result.turnId, 'turn-exact'); assert.equal(f.calls.some((call) => call.method === 'turn/start'), false)
    await assert.rejects(codexStructuredTurn(f.path, '/fixture', 'different prompt', execution({ threadId: 'thread-exact' }), callbacks), (error: unknown) => error instanceof StructuredSessionError && error.code === 'stale_result')
  } finally { await f.close() }
})

for (const mode of ['reset', 'websocket-close']) test(`structured ${mode} preserves exact accepted native identities for recovery`, async () => {
  const ids: string[] = []
  const f = await fixture((request, _send, socket) => {
    if (request.method === 'turn/start') { setTimeout(() => { if (mode === 'reset') socket.destroy(); else socket.write(Buffer.from([0x88, 0])) }, 20); return { turn: { id: 'turn-exact' } } }
    return safePrelude(request)
  })
  try {
    await assert.rejects(codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution(), { onThread: async (id) => { ids.push(id) }, onTurn: async (id) => { ids.push(id) } }), (error: unknown) => error instanceof StructuredSessionTransportError)
    assert.deepEqual(ids, ['thread-exact', 'turn-exact'])
  } finally { await f.close() }
})

for (const unsafe of ['config', 'hooks', 'mcp']) test(`structured ${unsafe} preflight refuses external writing capabilities before thread creation`, async () => {
  const f = await fixture((request) => {
    if (unsafe === 'config' && request.method === 'config/read') return { config: { sandbox_mode: 'danger-full-access' } }
    if (unsafe === 'hooks' && request.method === 'hooks/list') return { data: [{ hooks: [{ command: 'write-files' }], errors: [] }] }
    if (unsafe === 'mcp' && request.method === 'mcpServerStatus/list') return { data: [{ name: 'write-server' }] }
    return safePrelude(request)
  })
  try { await assert.rejects(codexStructuredTurn(f.path, '/fixture', 'pinned prompt', execution(), callbacks), (error: unknown) => error instanceof StructuredSessionError && error.code === 'unsupported'); assert.equal(f.calls.some((call) => call.method === 'thread/start'), false) }
  finally { await f.close() }
})

test('outer runtime realm permits rollout writes and rejects source/config writes', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-structured-policy-')))
  try {
    prepareStructuredRealm(join(root, 'realm'))
    const protectedFile = join(root, 'source'); writeFileSync(protectedFile, 'original')
    const inside = join(root, 'realm/data/probe'); mkdirSync(inside)
    const config = join(root, 'realm/data/codex-home/config.toml')
    execFileSync('/usr/bin/sandbox-exec', ['-f', join(root, 'realm/policy.sb'), '/bin/sh', '-c', 'printf allowed > "$1/result"; printf forbidden > "$2" 2>/dev/null; rm "$3" 2>/dev/null; test -f "$1/result"', 'probe', inside, protectedFile, config], { stdio: 'ignore' })
    assert.equal(readFileSync(protectedFile, 'utf8'), 'original'); assert.ok(readFileSync(config, 'utf8').includes('sandbox_mode = "read-only"'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('structured completed receipts replay one session and bind policy/schema/input in the create key', { skip: process.platform !== 'darwin' }, async () => {
  const { createHash } = await import('node:crypto')
  const { sessionCreateRequest, sessionIdForCreateKey } = await import('./sessions.js')
  const { fromRaw, writeRecord, readRecord } = await import('./session-record.js')
  const { configuredSessionApplication } = await import('./session-application.js')
  const { runStructuredSession } = await import('./session-structured.js')
  const requestKey = `structured-replay-${process.pid}`
  const id = sessionIdForCreateKey(requestKey)
  const prompt = 'pinned structured input @parent:must-not-be-a-directive'
  const policy = execution()
  const output = { answer: 'exact' }
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
  configuredSessionApplication().createSession({ sessionId: id, status: 'awaiting', proposal: 'nothing' })
  const rec = fromRaw({ session_id: id, governed: true, worktree_path: process.cwd(), branch: null,
    title: null, name: null, status: 'awaiting', proposal: 'nothing', merges: 0, note: null, sortkey: null,
    createdAt: 1, stopped: false, archived: false, harness: 'codex-headless', launch_cmd: 'codex',
    create_request_id: sha(requestKey), create_payload_hash: sha(JSON.stringify({ prompt, parent: null, launcher: null, structuredExecution: policy })) })
  rec.structuredExecution = { ...policy, state: 'completed', threadId: 'thread-exact', turnId: 'turn-exact', output, resultDigest: sha(JSON.stringify(output)) }
  rec.harnessSessionId = 'thread-exact'; writeRecord(rec)
  const request = { root: process.cwd(), prompt, schema, requestKey, inputDigest: policy.inputDigest, purpose: policy.purpose, timeoutMs: policy.timeoutMs }
  const first = await runStructuredSession(request)
  assert.deepEqual(await runStructuredSession(request), first)
  assert.equal(first.sessionId, id)
  assert.equal(readRecord(id)?.structuredExecution?.policy, 'codex-read-only-v1')
  await assert.rejects(runStructuredSession({ ...request, schema: { type: 'object', properties: {} } }), (error: unknown) => error instanceof StructuredSessionError && error.code === 'key_reused')
  writeRecord({ ...rec, structuredExecution: { ...rec.structuredExecution, inputDigest: 'old-input' } })
  await assert.rejects(runStructuredSession(request), (error: unknown) => error instanceof StructuredSessionError && error.code === 'stale_result' && error.sessionId === id && error.threadId === 'thread-exact' && error.turnId === 'turn-exact')
  writeRecord({ ...rec, structuredExecution: { ...rec.structuredExecution, resultDigest: 'corrupt-result' } })
  await assert.rejects(runStructuredSession(request), (error: unknown) => error instanceof StructuredSessionError && error.code === 'stale_result')
  const publicAttempt = await sessionCreateRequest({ prompt: 'input', structuredExecution: policy })
  assert.equal(publicAttempt.status, 400)
})


test('structured observer ownership distinguishes live, released, replaced and unproven identities', () => {
  const startToken = processStartToken(process.pid)!
  assert.ok(startToken)
  assert.equal(structuredObserverState(execution({ state: 'running', observer: { pid: process.pid, startToken } })), 'live')
  assert.equal(structuredObserverState(execution({ state: 'running', observer: null })), 'gone')
  assert.equal(structuredObserverState(execution({ state: 'running', observer: { pid: process.pid, startToken: 'previous-process-start' } })), 'gone')
  assert.equal(structuredObserverState(execution({ state: 'running' })), 'unproven')
  assert.equal(structuredObserverState(execution({ state: 'running', observer: { pid: process.pid, startToken: '' } })), 'unproven')
})
