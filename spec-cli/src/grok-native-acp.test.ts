import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { describe, test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { GrokAcpProtocolError, observeGrokNativeAcp, type GrokAcpTerminal } from './grok-native-acp.js'

const request = {
  sessionId: 'd203f8a3-763d-46e3-bc8a-243044dcbeaa',
  promptId: 'b4434113-6d98-4e72-850f-9528b8355974',
  cwd: '/worktree/原候选',
  prompt: 'Read the frozen candidate.\n中文原文\n',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
}
const identity = { sessionId: request.sessionId, requestId: request.promptId, cwd: request.cwd }
const initialized = { protocolVersion: 1, authMethods: [{ id: 'oauth' }, { id: 'cached_token' }] }
const created = { sessionId: request.sessionId, _meta: { currentWorkingDirectory: request.cwd } }
const meta = { sessionId: request.sessionId, requestId: request.promptId, modelId: 'requested-alias', usage: { modelUsage: { 'grok-4.7-build': { inputTokens: 2 } } } }
const result = { stopReason: 'end_turn', _meta: { ...meta, structuredOutput: { ok: true } } }
const frame = (packet: object): string => JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n'

function peer(t: TestContext, model?: string) {
  const stdout = new PassThrough(), stdin = new PassThrough()
  const lines = createInterface({ input: stdin, crlfDelay: Infinity })
  const received = lines[Symbol.asyncIterator]()
  const terminals: GrokAcpTerminal[] = []
  let markTerminal!: () => void
  const terminalSeen = new Promise<void>(resolve => { markTerminal = resolve })
  const observation = observeGrokNativeAcp(stdout, stdin, { ...request, model }, terminal => {
    assert.equal(stdin.writableEnded, true)
    terminals.push(terminal)
    markTerminal()
  })
  void observation.catch(() => {})
  t.after(() => { lines.close(); stdin.destroy(); stdout.destroy() })
  const next = async (): Promise<unknown> => JSON.parse((await received.next()).value as string) as unknown
  const write = (packet: object): void => { stdout.write(frame(packet)) }
  const response = (id: number, value: unknown): void => write({ id, result: value })
  return { stdout, stdin, next, write, response, terminalSeen, terminals, observation }
}

type Peer = ReturnType<typeof peer>

async function throughAuth(p: Peer): Promise<void> {
  assert.deepEqual(await p.next(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } })
  p.response(1, initialized)
  assert.deepEqual(await p.next(), { jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cached_token', _meta: { headless: true } } })
  p.response(2, {})
}

async function throughPrompt(p: Peer, model?: string): Promise<void> {
  await throughAuth(p)
  assert.deepEqual(await p.next(), {
    jsonrpc: '2.0', id: 3, method: 'session/new',
    params: { cwd: request.cwd, mcpServers: [], _meta: { sessionId: request.sessionId, ...(model ? { modelId: model } : {}) } },
  })
  p.write({ method: '_x.ai/session/setup', params: { sessionId: request.sessionId } })
  p.write({ method: '_x.ai/mcp/servers_updated', params: {} })
  p.write({ method: 'session/update', params: { sessionId: request.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } })
  p.response(3, created)
  assert.deepEqual(await p.next(), {
    jsonrpc: '2.0', id: 4, method: 'session/prompt',
    params: { sessionId: request.sessionId, prompt: [{ type: 'text', text: request.prompt }], _meta: { promptId: request.promptId, outputSchema: request.schema } },
  })
}

function update(value: object, _meta: object = { promptId: request.promptId }): object {
  return { method: 'session/update', params: { sessionId: request.sessionId, _meta, update: value } }
}

function assistantText(text: string): object {
  return update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

describe('Grok Build ACP stdio', { timeout: 5_000 }, () => {
  test('uses the frozen prompt, schema and identity, declines reverse calls and waits for real EOF', async t => {
    const p = peer(t, 'requested-alias')
    await throughPrompt(p, 'requested-alias')
    p.write({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: request.sessionId } })
    assert.deepEqual(await p.next(), { jsonrpc: '2.0', id: 'permission-1', result: { outcome: { outcome: 'cancelled' } } })
    p.write({ id: 1, method: 'fs/read_text_file', params: { sessionId: request.sessionId, path: '/unavailable' } })
    assert.deepEqual(await p.next(), { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Client method unavailable' } })
    p.write(assistantText('assistant prose'))
    p.write({ method: '_x.ai/session/prompt_complete', params: { sessionId: request.sessionId } })
    p.response(4, result)
    await p.terminalSeen
    let completed = false
    void p.observation.then(() => { completed = true })
    await setImmediate()
    assert.equal(completed, false)
    assert.equal(p.stdout.readableEnded, false)
    p.stdout.end()
    const terminal = { ...identity, kind: 'result', stopReason: 'end_turn', models: ['grok-4.7-build'], text: '', structuredOutput: { ok: true } }
    assert.deepEqual(await p.observation, terminal)
    assert.deepEqual(p.terminals, [terminal])
    assert.equal(p.stdout.readableEnded, true)
  })

  test('returns rejection text only from the final assistant message after tools when schema output is absent', async t => {
    const p = peer(t)
    await throughPrompt(p)
    p.write(assistantText('before a tool call'))
    p.write(update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1' }))
    p.write(assistantText('discarded while tool runs'))
    p.write(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1' }))
    const text = Buffer.from(frame(assistantText('还原')))
    const split = text.indexOf(Buffer.from('还')) + 1
    p.stdout.write(text.subarray(0, split))
    await setImmediate()
    p.stdout.write(text.subarray(split))
    p.write(assistantText('原文'))
    p.response(4, { stopReason: 'end_turn', _meta: meta })
    p.stdout.end()
    assert.deepEqual(await p.observation, { ...identity, kind: 'result', stopReason: 'end_turn', models: ['grok-4.7-build'], text: '还原原文' })
  })

  test('preserves native JSON null as a present output for downstream schema validation', async t => {
    const p = peer(t)
    await throughPrompt(p)
    p.response(4, { stopReason: 'end_turn', _meta: { ...meta, structuredOutput: null } })
    p.stdout.end()
    assert.deepEqual(await p.observation, { ...identity, kind: 'result', stopReason: 'end_turn', models: ['grok-4.7-build'], text: '', structuredOutput: null })
  })

  for (const [label, error, expected] of [
    ['the fixed vendor code and message', { code: -32003, message: 'Rate limited', data: { private: 'redact me' } }, { kind: 'rate_limited', rpcCode: -32003, message: 'Rate limited' }],
    ['an unrelated code with vendor text and a body claiming HTTP 429', { code: -32000, message: 'Rate limited', data: { status: 429 } }, { kind: 'prompt_error' }],
    ['the vendor code with a different message', { code: -32003, message: 'Rate limited: redact me' }, { kind: 'prompt_error' }],
  ] as const) {
    test(`settles a matching prompt RPC error with ${label}`, async t => {
      const p = peer(t)
      await throughPrompt(p)
      p.write({ id: 4, error })
      await p.terminalSeen
      assert.equal(p.stdout.readableEnded, false)
      p.stdout.end()
      assert.deepEqual(await p.observation, { ...identity, ...expected })
    })
  }

  test('uses an advertised local API-key method without sending credential material', async t => {
    const p = peer(t)
    await p.next()
    p.response(1, { protocolVersion: 1, authMethods: [{ id: 'xai.api_key' }] })
    assert.deepEqual(await p.next(), { jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'xai.api_key', _meta: { headless: true } } })
    p.response(2, {})
    await p.next()
    p.response(3, created)
    await p.next()
    p.response(4, result)
    p.stdout.end()
    assert.equal((await p.observation).kind, 'result')
  })

  test('requires advertised noninteractive native authentication before opening a session', async t => {
    const p = peer(t)
    await p.next()
    p.response(1, { protocolVersion: 1, authMethods: [{ id: 'oauth' }] })
    await assert.rejects(p.observation, /did not advertise protocol v1 with local noninteractive authentication/)
    assert.deepEqual(p.terminals, [])
  })

  test('rejects a quota-shaped authentication error as a handshake fault', async t => {
    const p = peer(t)
    await p.next()
    p.response(1, initialized)
    await p.next()
    p.write({ id: 2, error: { code: -32003, message: 'Rate limited' } })
    await assert.rejects(p.observation, /authenticate was rejected/)
    assert.deepEqual(p.terminals, [])
  })

  for (const [label, value] of [
    ['foreign session', { ...created, sessionId: 'other-session' }],
    ['different physical cwd', { ...created, _meta: { currentWorkingDirectory: '/wrong' } }],
  ] as const) {
    test(`rejects session/new with a ${label}`, async t => {
      const p = peer(t)
      await throughAuth(p)
      await p.next()
      p.response(3, value)
      await assert.rejects(p.observation, /different session or worktree/)
      assert.deepEqual(p.terminals, [])
    })
  }

  for (const [label, packet] of [
    ['a foreign JSON-RPC response', { id: '4', result }],
    ['a result and error in one response', { id: 4, result, error: { code: -32003, message: 'Rate limited' } }],
    ['foreign terminal session', { id: 4, result: { ...result, _meta: { ...meta, sessionId: 'other-session' } } }],
    ['foreign terminal request', { id: 4, result: { ...result, _meta: { ...meta, requestId: 'other-prompt' } } }],
    ['foreign turn update', update({ sessionUpdate: 'tool_call' }, { promptId: 'other-prompt' })],
    ['an update disguised as a request', { id: 'invalid', ...assistantText('invalid notification') }],
    ['missing terminal model usage', { id: 4, result: { ...result, _meta: { ...meta, usage: {} } } }],
    ['broken terminal metadata', { id: 4, result: { ...result, _meta: ['invalid metadata'] } }],
  ] as const) {
    test(`rejects ${label}`, async t => {
      const p = peer(t)
      await throughPrompt(p)
      p.write(packet)
      await assert.rejects(p.observation, GrokAcpProtocolError)
      assert.deepEqual(p.terminals, [])
    })
  }

  for (const [label, trailing] of [
    ['a repeated terminal', frame({ id: 4, result })],
    ['a late session update', frame(assistantText('too late'))],
    ['an unterminated final frame', frame({ method: '_x.ai/session/prompt_complete', params: {} }).trimEnd()],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28, 0x0a])],
  ] as const) {
    test(`rejects ${label} after the matching terminal`, async t => {
      const p = peer(t)
      await throughPrompt(p)
      p.response(4, result)
      await p.terminalSeen
      p.stdout.end(trailing)
      await assert.rejects(p.observation, GrokAcpProtocolError)
      assert.equal(p.terminals.length, 1)
    })
  }

  test('requires a terminal before EOF and an actual EOF instead of stdout close', async t => {
    const ended = peer(t)
    await throughPrompt(ended)
    ended.stdout.end()
    await assert.rejects(ended.observation, { code: 'missing_terminal' })
    const closed = peer(t)
    await throughPrompt(closed)
    closed.response(4, result)
    await closed.terminalSeen
    closed.stdout.destroy()
    await assert.rejects(closed.observation, { code: 'transport_error' })
    assert.equal(closed.stdout.readableEnded, false)
  })
})
