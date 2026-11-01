import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { frozenReadTool, freezeContext, proveFrozenReads, readFrozenManifest, readFrozenRange, type FrozenNativeItem } from './frozen-context.js'
import { decodeZCodeJsonText, proveZCodeFrozenReads, verifyZCodeFrozenReadProof, ZCODE_FROZEN_TOOL, type ZCodeFrozenWitness, type ZCodeNativeEvent } from './zcode-frozen-proof.js'

function fixture(options: { modelChange?: boolean; reasoningLevel?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-proof-'))
  const textBytes = Buffer.from('首' + '中'.repeat(4230) + '尾'), binary = Buffer.from(Array.from({ length: 19 }, (_, index) => index * 13 % 256))
  const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding: { requestKey: 'request', inputDigest: 'input' }, entries: [
    { id: 'large-text', label: 'synthetic unicode', kind: 'utf8', bytes: textBytes },
    { id: 'small-binary', label: 'synthetic binary', kind: 'binary', bytes: binary },
    { id: 'missing-entry', label: 'synthetic absence', kind: 'absent' },
  ] })
  const witness: ZCodeFrozenWitness = { version: 1, provider: 'zcode', cliVersion: '0.17.1', cliSha256: 'b'.repeat(64), providerId: 'bigmodel-api', modelId: 'GLM-5.3-Flash', sessionId: 'session', turnId: 'turn', inputId: 'input-id', prompt: 'read original frozen inputs', send: { sessionId: 'session', inputId: 'input-id', content: 'read original frozen inputs' }, messages: [], events: [], mcpHistory: { records: [], digest: '' } }
  const event = (type: string, payload: Record<string, unknown>): void => { witness.events.push({ eventId: `event-${witness.events.length}`, sessionId: 'session', turnId: 'turn', seq: witness.events.length + 1, type, payload }) }
  const part = (id: string, messageID: string, type: string, data: Record<string, unknown>) => ({ id, messageID, sessionID: 'session', type, ...data })
  if (options.modelChange) {
    const id = 'administrative-model-change'
    witness.messages.push({ info: { id, sessionID: 'session', role: 'assistant', parentID: id, time: { created: 1, completed: 1 },
      modelId: witness.modelId, providerId: witness.providerId, mode: 'build', planEnabled: true, agent: 'zcode-agent', path: { cwd: '/empty', root: '/empty' }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'completed',
      semantics: { origin: 'system', kind: 'timeline_event', uiVisibility: 'visible', providerVisibility: 'hidden', transcriptVisibility: 'visible' } },
      parts: [part('model-change-part', id, 'timeline', { timelineType: 'model_change', display: 'separator', status: 'completed', time: { start: 1, end: 1 },
        fromModel: { providerId: witness.providerId, modelId: witness.modelId, options: { reasoningLevel: 'high' }, label: `${witness.providerId}/${witness.modelId}` },
        toModel: { providerId: witness.providerId, modelId: witness.modelId, label: `${witness.providerId}/${witness.modelId}` } })] })
  }
  witness.messages.push({ info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 2 }, modelSelection: { providerId: witness.providerId, modelId: witness.modelId, ...(options.reasoningLevel ? { options: { reasoningLevel: options.reasoningLevel } } : {}) }, anchor: { turnId: 'turn', origin: 'realUser', sourceCommandId: 'command' }, semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' } }, parts: [part('user-text', 'user', 'text', { text: witness.prompt })] })
  for (const source of ['environment', 'model', 'runtime_mode', 'date']) {
    const metadata = { source, visibility: 'model-only', runtimeMessage: { source } }, id = `runtime-${source}`
    witness.messages.push({ info: { id, sessionID: 'session', role: 'user', synthetic: true, visibility: 'model-only', metadata,
      modelSelection: { providerId: witness.providerId, modelId: witness.modelId }, anchor: { turnId: 'turn', origin: 'synthetic' },
      semantics: { origin: 'agent_runtime', kind: 'system_reminder', source, uiVisibility: 'hidden', providerVisibility: 'visible', transcriptVisibility: 'hidden' } },
      parts: [part(`part-${id}`, id, 'text', { text: `synthetic ${source}`, synthetic: true, metadata })] })
  }
  event('turn.started', { turnNumber: 0, input: witness.prompt, messageId: 'user', inputId: 'input-id' })
  event('session.updated', { providerId: witness.providerId, modelId: witness.modelId, toolCount: 1, messageCount: 5, iteration: 0 })
  const toolParts: Record<string, unknown>[] = [], items: FrozenNativeItem[] = []
  for (const entry of readFrozenManifest(ref).entries) {
    for (let startByte = 0; entry.byteLength === 0 ? startByte === 0 : startByte < entry.byteLength;) {
      const args = { contextDigest: ref.contextDigest, entryId: entry.id, startByte, endByte: Math.min(startByte + 4096, entry.byteLength) }
      const callID = `call-${toolParts.length}`, read = readFrozenRange(ref, args), output = read.response.contentItems[0].text
      toolParts.push(part(`tool-${toolParts.length}`, 'assistant-tools', 'tool', { callID, tool: ZCODE_FROZEN_TOOL, state: { status: 'completed', input: args, output, metadata: { serialization: { truncated: false, originalBytes: Buffer.byteLength(output), returnedBytes: Buffer.byteLength(output) } } } }))
      items.push({ type: 'dynamicToolCall', id: callID, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true, arguments: args, contentItems: read.response.contentItems })
      event('tool.updated', { kind: 'scheduled', toolCallId: callID, assistantMessageId: 'assistant-tools', toolName: ZCODE_FROZEN_TOOL, inputByteLength: Buffer.byteLength(JSON.stringify(args)), inputOmitted: true, inputRef: 'model_stream' })
      if (entry.byteLength === 0) break
      startByte = args.endByte
    }
  }
  witness.messages.push({ info: { id: 'assistant-tools', sessionID: 'session', role: 'assistant', parentID: 'user', providerId: witness.providerId, modelId: witness.modelId, anchor: { turnId: 'turn' }, semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' } }, parts: toolParts })
  for (const part of toolParts) {
    const state = part.state as { output: string }, bytes = Buffer.byteLength(state.output)
    event('tool.updated', { kind: 'started', toolCallId: part.callID, toolName: ZCODE_FROZEN_TOOL })
    event('tool.updated', { kind: 'result', toolCallId: part.callID, result: { success: true, content: state.output, truncated: false, originalBytes: bytes, returnedBytes: bytes } })
  }
  event('tool.updated', { kind: 'batch', toolCallIds: toolParts.map(part => part.callID), successCount: toolParts.length, errorCount: 0 })
  event('session.updated', { providerId: witness.providerId, modelId: witness.modelId, toolCount: 1, messageCount: 12, iteration: 1 })
  witness.messages.push({ info: { id: 'assistant-final', sessionID: 'session', role: 'assistant', parentID: 'user', providerId: witness.providerId, modelId: witness.modelId, anchor: { turnId: 'turn' }, semantics: { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' } }, parts: [part('final-text', 'assistant-final', 'text', { text: '{"ok":true}' })] })
  Object.assign(finalMessage(witness).info.anchor as object, { historyRoundCount: 2, orderedMessageIds: witness.messages.filter(message => (message.info.semantics as Record<string, unknown>).providerVisibility === 'visible').map(message => message.info.id), boundaryMessageId: 'assistant-final', goalBoundary: { kind: 'none' } })
  event('turn.completed', { response: '{"ok":true}', inputId: 'input-id', resultType: 'success', toolCallCount: toolParts.length })
  witness.mcpHistory.records.push(
    { type: 'process', pid: 123, startToken: null },
    { type: 'request', request: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'zcode', version: witness.cliVersion } } } },
    { type: 'response', response: { jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 'spex-immutable-reader', version: '1' } } } },
    { type: 'request', request: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
    { type: 'response', response: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'spex_read_frozen', inputSchema: frozenReadTool.inputSchema }] } } },
  )
  for (const [index, part] of toolParts.entries()) {
    const state = part.state as Record<string, unknown>
    witness.mcpHistory.records.push(
      { type: 'request', request: { jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'spex_read_frozen', arguments: state.input, _meta: { session_id: 'session', turn_id: 'turn' } } } },
      { type: 'response', response: { jsonrpc: '2.0', id: index + 2, result: { content: [{ type: 'text', text: state.output }] } } },
    )
  }
  witness.mcpHistory.records.push({ type: 'exit', pid: 123, code: 0 })
  witness.mcpHistory.digest = createHash('sha256').update(JSON.stringify(witness.mcpHistory.records)).digest('hex')
  const identity = { threadId: 'session', turnId: 'turn', inputId: witness.inputId, prompt: witness.prompt }
  return { directory, ref, witness, identity, items, close: () => rmSync(directory, { recursive: true, force: true }) }
}
function toolMessage(witness: ZCodeFrozenWitness) { return witness.messages.find(message => message.info.role === 'assistant' && (message.info.semantics as Record<string, unknown>).kind === 'assistant_response')! }
function finalMessage(witness: ZCodeFrozenWitness) { return witness.messages.at(-1)! }
function tool(witness: ZCodeFrozenWitness) { return toolMessage(witness).parts[0] }
function state(witness: ZCodeFrozenWitness) { return tool(witness).state as Record<string, unknown> }
function event(witness: ZCodeFrozenWitness, kind: string): ZCodeNativeEvent { return witness.events.find(event => event.payload.kind === kind)! }

test('raw core six-read witness proves unicode/binary/absence and keeps the shared normalized history digest', () => {
  const f = fixture()
  try {
    const expected = proveFrozenReads(f.ref, f.identity, f.items), proof = proveZCodeFrozenReads(f.ref, f.witness)
    assert.equal(proof.version, 4); assert.equal(proof.receipts.length, 6)
    assert.equal(proof.historyDigest, expected.historyDigest)
    assert.deepEqual(proof.coveredEntryIds, ['large-text', 'small-binary', 'missing-entry'])
    const bytes = readFileSync(join(dirname(f.ref.manifestPath), 'histories', `zcode-witness-${proof.witnessDigest}`))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), proof.witnessDigest)
    assert.deepEqual(JSON.parse(bytes.toString()), f.witness, 'preserve the full raw witness, not only normalized items')
    verifyZCodeFrozenReadProof(f.ref, proof, f.identity, { providerId: f.witness.providerId, modelId: f.witness.modelId, cliVersion: f.witness.cliVersion, cliSha256: f.witness.cliSha256 })
  } finally { f.close() }
})

test('reject altered identity, declared DTO aliases, unknown tools and another user input', () => {
  const f = fixture()
  try {
    const corruptions: ((witness: ZCodeFrozenWitness) => void)[] = [
      w => { w.send.inputId = 'foreign' }, w => { w.send.content += 'extra' }, w => { w.cliSha256 = 'unknown' },
      w => { w.messages[0].info.sessionID = 'foreign' },
      w => { (w.messages[1].info.semantics as Record<string, unknown>).source = 'memory' },
      w => { (w.messages[1].info.anchor as Record<string, unknown>).turnId = 'foreign' },
      w => { w.messages[1].parts[0].synthetic = false },
      w => { w.messages[1].parts[0].metadata = { source: 'date' } },
      w => { w.messages.splice(1, 1) },
      w => { w.messages.push(structuredClone(w.messages[1])); w.messages.at(-1)!.info.id = 'duplicate-runtime' }, w => { w.messages[0].parts[0].text = 'foreign' },
      w => { toolMessage(w).info.id = undefined; toolMessage(w).info.messageId = 'assistant-tools' },
      w => { tool(w).callID = undefined; tool(w).callId = 'call-0' }, w => { tool(w).messageID = 'foreign' },
      w => { tool(w).sessionID = 'foreign' }, w => { tool(w).id = w.messages[0].parts[0].id },
      w => { tool(w).tool = 'Bash' }, w => { toolMessage(w).info.parentID = 'assistant-tools' },
      w => { w.messages.push(structuredClone(w.messages[0])); w.messages.at(-1)!.info.id = 'extra-user' },
      w => { w.events[0].payload.turnNumber = 1 }, w => { w.events[0].payload.messageId = 'foreign' }, w => { w.events[0].payload.inputId = 'foreign' },
      w => { event(w, 'scheduled').payload.assistantMessageId = 'foreign' },
      w => { event(w, 'scheduled').payload.input = { entryId: 'made-up' } },
      w => { event(w, 'result').turnId = 'foreign' }, w => { w.events[1].sessionId = 'foreign' },
      w => { w.events[1].payload.modelId = 'another-model' }, w => { w.events[1].payload.providerId = 'another-provider' },
      w => { w.events[1].payload.toolCount = 2 }, w => { event(w, 'batch').payload.toolName = 'Bash' }, w => { toolMessage(w).info.modelId = 'another-model' },
    ]
    for (const corrupt of corruptions) {
      const witness = structuredClone(f.witness); corrupt(witness)
      assert.throws(() => proveZCodeFrozenReads(f.ref, witness), { code: 'stale_result' })
    }
  } finally { f.close() }
})

test('reject missing native input, changed bytes, omitted or truncated output and incomplete coverage', () => {
  const f = fixture()
  try {
    const corruptions: ((witness: ZCodeFrozenWitness) => void)[] = [
      w => { delete state(w).input }, w => { state(w).status = 'running' }, w => { state(w).output += 'changed' },
      w => { (state(w).input as Record<string, unknown>).contextDigest = 'a'.repeat(64) },
      w => { state(w).metadata = { truncated: true } }, w => { (state(w).metadata as { serialization: Record<string, unknown> }).serialization.truncated = true }, w => { state(w).inputOmitted = true },
      w => { (event(w, 'result').payload.result as Record<string, unknown>).truncated = true },
      w => { (event(w, 'result').payload.result as Record<string, unknown>).content = 'omitted' },
      w => { (event(w, 'result').payload.result as Record<string, unknown>).returnedBytes = 1 },
      w => { (event(w, 'result').payload.result as Record<string, unknown>).success = false },
      w => { w.events.pop() }, w => { w.events.at(-1)!.payload.resultType = 'cancelled' },
      w => { w.events.at(-1)!.payload.inputId = 'foreign' }, w => { w.events.at(-1)!.payload.response = '{"other":true}' },
      w => { w.events = w.events.filter(e => e.payload.iteration !== 1) },
    ]
    for (const corrupt of corruptions) {
      const witness = structuredClone(f.witness); corrupt(witness)
      assert.throws(() => proveZCodeFrozenReads(f.ref, witness), { code: 'stale_result' })
    }
    const missing = structuredClone(f.witness), lastCall = toolMessage(missing).parts.pop()!.callID
    missing.events = missing.events.filter(e => e.payload.toolCallId !== lastCall && e.payload.kind !== 'batch')
    missing.events.at(-1)!.payload.toolCallCount = 5
    missing.events.find(e => e.payload.iteration === 1)!.payload.messageCount = 11
    missing.mcpHistory.records = missing.mcpHistory.records.filter(row => (row.request as Record<string, unknown> | undefined)?.id !== 7 && (row.response as Record<string, unknown> | undefined)?.id !== 7)
    missing.mcpHistory.digest = createHash('sha256').update(JSON.stringify(missing.mcpHistory.records)).digest('hex')
    assert.throws(() => proveZCodeFrozenReads(f.ref, missing), /required frozen entry/)
    const changed = structuredClone(f.witness), input = state(changed).input as Record<string, unknown>
    input.endByte = 4095
    const output = readFrozenRange(f.ref, input).response.contentItems[0].text
    state(changed).output = output
    const metadata = state(changed).metadata as { serialization: Record<string, unknown> }
    metadata.serialization = { truncated: false, originalBytes: Buffer.byteLength(output), returnedBytes: Buffer.byteLength(output) }
    Object.assign(event(changed, 'result').payload.result as object, { content: output, originalBytes: Buffer.byteLength(output), returnedBytes: Buffer.byteLength(output) })
    const response = changed.mcpHistory.records[6].response as Record<string, unknown>
    response.result = { content: [{ type: 'text', text: output }] }
    changed.mcpHistory.digest = createHash('sha256').update(JSON.stringify(changed.mcpHistory.records)).digest('hex')
    assert.throws(() => proveZCodeFrozenReads(f.ref, changed), /required frozen entry/)
  } finally { f.close() }
})

test('cold replay rereads witness and normalized bytes and never dispatches again', () => {
  const f = fixture()
  try {
    const proof = proveZCodeFrozenReads(f.ref, f.witness), historyRoot = join(dirname(f.ref.manifestPath), 'histories')
    const files = readdirSync(historyRoot), before = files.map(name => [name, readFileSync(join(historyRoot, name)).toString('hex')])
    for (let index = 0; index < 3; index++) verifyZCodeFrozenReadProof(f.ref, structuredClone(proof), f.identity)
    assert.deepEqual(readdirSync(historyRoot).map(name => [name, readFileSync(join(historyRoot, name)).toString('hex')]), before)
    for (const [key, value] of [['threadId', 'foreign'], ['turnId', 'foreign'], ['inputId', 'foreign'], ['prompt', 'foreign']] as const)
      assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, { ...f.identity, [key]: value }), { code: 'stale_result' })
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity, { providerId: f.witness.providerId, modelId: 'foreign' }), { code: 'stale_result' })
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, { ...proof, cliSha256: 'a'.repeat(64) }, f.identity), { code: 'stale_result' })
    for (const file of [`zcode-witness-${proof.witnessDigest}`, proof.historyDigest]) {
      const path = join(historyRoot, file), original = readFileSync(path)
      chmodSync(path, 0o600); writeFileSync(path, 'corrupt')
      assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity), { code: 'stale_result' })
      writeFileSync(path, original); chmodSync(path, 0o400)
    }
    const entry = readFrozenManifest(f.ref).entries[0], bytesPath = join(dirname(f.ref.manifestPath), 'bytes', entry.sha256)
    chmodSync(bytesPath, 0o600); writeFileSync(bytesPath, 'changed immutable source')
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity), { code: 'stale_result' })
  } finally { f.close() }
})


test('public MCP ledger must bind one exact reader surface and every native input/output without supplementation', () => {
  const f = fixture()
  try {
    const corruptions: ((witness: ZCodeFrozenWitness) => void)[] = [
      w => { w.mcpHistory.digest = 'a'.repeat(64) },
      w => { w.mcpHistory.records.pop(); w.mcpHistory.records.pop() },
      w => { (w.mcpHistory.records[5].request as Record<string, unknown>).method = 'unknown' },
      w => { const rpc = w.mcpHistory.records[5].request as { params: { name: string } }; rpc.params.name = 'Bash' },
      w => { const rpc = w.mcpHistory.records[5].request as { params: { _meta: { turn_id: string } } }; rpc.params._meta.turn_id = 'foreign' },
      w => { const rpc = w.mcpHistory.records[6].response as { result: { content: unknown } }; rpc.result.content = [{ type: 'text', text: 'changed' }] },
      w => { const rpc = w.mcpHistory.records[4].response as { result: { tools: unknown[] } }; rpc.result.tools.push({ name: 'Bash' }) },
      w => { w.mcpHistory.records.push(structuredClone(w.mcpHistory.records[5]), structuredClone(w.mcpHistory.records[6])) },
    ]
    for (const [index, corrupt] of corruptions.entries()) {
      const witness = structuredClone(f.witness); corrupt(witness)
      if (index > 0) witness.mcpHistory.digest = createHash('sha256').update(JSON.stringify(witness.mcpHistory.records)).digest('hex')
      assert.throws(() => proveZCodeFrozenReads(f.ref, witness), { code: 'stale_result' })
    }
  } finally { f.close() }
})

test('one complete JSON fence preserves native body and cold proof binds the entire parsed output', () => {
  const f = fixture()
  try {
    for (const raw of ['  {"ok":true} \n', ' \n```json\n{"ok":true}\n```\n ']) {
      const witness = structuredClone(f.witness)
      finalMessage(witness).parts[0].text = raw; witness.events.at(-1)!.payload.response = raw
      const proof = proveZCodeFrozenReads(f.ref, witness)
      verifyZCodeFrozenReadProof(f.ref, proof, f.identity, undefined, { output: { ok: true } })
      assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity, undefined, { output: { ok: false } }), { code: 'stale_result' })
    }
    assert.equal(decodeZCodeJsonText('```json\n  {"key":"value"} \n```'), '  {"key":"value"} ')
    for (const raw of ['prose {"ok":true}', '```json\n{"ok":true}\n```\nextra', '```json\n{}\n```\n```json\n{}\n```', '{"ok":true} {}']) {
      const witness = structuredClone(f.witness)
      finalMessage(witness).parts[0].text = raw; witness.events.at(-1)!.payload.response = raw
      const proof = proveZCodeFrozenReads(f.ref, witness)
      assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity, undefined, { output: { ok: true } }), { code: 'stale_result' })
    }
  } finally { f.close() }
})


test('terminal output cannot substitute JSON from an assistant before its frozen tool reads', () => {
  const f = fixture()
  try {
    const proof = proveZCodeFrozenReads(f.ref, f.witness), stale = structuredClone(f.witness), beforeRead = toolMessage(stale)
    beforeRead.parts.unshift({ id: 'pre-read-json', sessionID: stale.sessionId, messageID: beforeRead.info.id, type: 'text', text: '{"stale":true}' })
    stale.events.at(-1)!.payload.response = '{"stale":true}'
    assert.throws(() => proveZCodeFrozenReads(f.ref, stale), { code: 'stale_result' })
    const bytes = Buffer.from(JSON.stringify(stale)), witnessDigest = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(dirname(f.ref.manifestPath), 'histories', `zcode-witness-${witnessDigest}`), bytes, { mode: 0o400 })
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, { ...proof, witnessDigest }, f.identity, undefined, { output: { stale: true } }), { code: 'stale_result' })
  } finally { f.close() }
})

test('native tools cannot execute before the ModelRequest that generates their own assistant', () => {
  const f = fixture()
  try {
    const proof = proveZCodeFrozenReads(f.ref, f.witness), early = structuredClone(f.witness), first = toolMessage(early), last = finalMessage(early)
    for (const part of first.parts) { part.messageID = last.info.id; last.parts.push(part) }
    first.parts = []
    for (const event of early.events) if (event.payload.kind === 'scheduled') event.payload.assistantMessageId = last.info.id
    assert.throws(() => proveZCodeFrozenReads(f.ref, early), { code: 'stale_result' })
    const bytes = Buffer.from(JSON.stringify(early)), witnessDigest = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(dirname(f.ref.manifestPath), 'histories', `zcode-witness-${witnessDigest}`), bytes, { mode: 0o400 })
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, { ...proof, witnessDigest }, f.identity, undefined, { output: { ok: true } }), { code: 'stale_result' })
  } finally { f.close() }
})

test('the same JSON before and after the final native boundary remains valid', () => {
  const f = fixture()
  try {
    const prior = toolMessage(f.witness)
    prior.parts.unshift({ id: 'same-pre-read-json', sessionID: f.witness.sessionId, messageID: prior.info.id, type: 'text', text: '{"ok":true}' })
    const proof = proveZCodeFrozenReads(f.ref, f.witness)
    verifyZCodeFrozenReadProof(f.ref, proof, f.identity, undefined, { output: { ok: true } })
    assert.equal(proof.receipts.length, 6)
  } finally { f.close() }
})

test('final native anchor must close the complete raw ordered history with the exact boundary and round count', () => {
  const f = fixture()
  try {
    const corruptions: ((anchor: Record<string, unknown>) => void)[] = [
      anchor => { delete anchor.orderedMessageIds }, anchor => { delete anchor.boundaryMessageId }, anchor => { delete anchor.historyRoundCount },
      anchor => { anchor.boundaryMessageId = 'assistant-tools' }, anchor => { anchor.historyRoundCount = 1 },
      anchor => { (anchor.orderedMessageIds as string[]).pop() },
      anchor => { (anchor.orderedMessageIds as string[])[1] = 'user' },
      anchor => { (anchor.orderedMessageIds as string[])[1] = 'foreign' },
      anchor => { (anchor.orderedMessageIds as string[]).reverse() },
    ]
    for (const corrupt of corruptions) {
      const witness = structuredClone(f.witness); corrupt(finalMessage(witness).info.anchor as Record<string, unknown>)
      assert.throws(() => proveZCodeFrozenReads(f.ref, witness), { code: 'stale_result' })
    }
    const reordered = structuredClone(f.witness)
    reordered.messages.splice(1, 2, reordered.messages[2], reordered.messages[1])
    assert.throws(() => proveZCodeFrozenReads(f.ref, reordered), { code: 'stale_result' })
  } finally { f.close() }
})


test('pre-turn display-only model change stays in raw witness while the seven model-visible messages keep six reads', () => {
  const f = fixture({ modelChange: true, reasoningLevel: 'high' })
  try {
    const expected = proveFrozenReads(f.ref, f.identity, f.items), proof = proveZCodeFrozenReads(f.ref, f.witness)
    assert.equal(proof.historyDigest, expected.historyDigest)
    assert.equal(proof.receipts.length, 6)
    const saved = JSON.parse(readFileSync(join(dirname(f.ref.manifestPath), 'histories', `zcode-witness-${proof.witnessDigest}`), 'utf8')) as ZCodeFrozenWitness
    assert.equal(saved.messages.length, 8)
    assert.deepEqual(saved.messages[0], f.witness.messages[0])
    verifyZCodeFrozenReadProof(f.ref, proof, f.identity, { providerId: f.witness.providerId, modelId: f.witness.modelId, options: { reasoningLevel: 'high' } }, { output: { ok: true } })
    const differentDefault = structuredClone(f.witness)
    differentDefault.messages[0].parts[0].fromModel = { providerId: 'previous-provider', modelId: 'previous-model', label: 'Previous configured model' }
    proveZCodeFrozenReads(f.ref, differentDefault)
  } finally { f.close() }
})

test('unknown hidden messages, payloads, in-turn timelines and foreign model changes remain rejected', () => {
  const f = fixture({ modelChange: true })
  try {
    const corruptions: ((witness: ZCodeFrozenWitness) => void)[] = [
      w => { w.messages[0].info.anchor = { turnId: 'turn' } },
      w => { (w.messages[0].info.path as Record<string, unknown>).prompt = 'unknown payload' },
      w => { w.messages[0].info.modelId = 'foreign' },
      w => { (w.messages[0].info.semantics as Record<string, unknown>).kind = 'unknown' },
      w => { w.messages[0].parts[0].text = 'hidden injected text' },
      w => { w.messages[0].parts[0].tool = 'Bash' },
      w => { w.messages[0].parts[0].anchorMessageId = 'user' },
      w => { (w.messages[0].parts[0].toModel as Record<string, unknown>).modelId = 'foreign' },
      w => { (w.messages[0].parts[0].fromModel as Record<string, unknown>).prompt = 'injected' },
      w => { (w.messages[0].parts[0].fromModel as Record<string, unknown>).providerId = '' },
      w => { (w.messages[0].info.time as Record<string, unknown>).created = 3 },
      w => { w.messages.splice(1, 0, w.messages.shift()!) },
      w => { w.messages[0].parts.push({ id: 'hidden-text', sessionID: 'session', messageID: w.messages[0].info.id, type: 'text', text: 'injected' }) },
      w => { (w.messages[0].info.tokens as Record<string, unknown>).output = 1 },
    ]
    for (const corrupt of corruptions) {
      const witness = structuredClone(f.witness); corrupt(witness)
      assert.throws(() => proveZCodeFrozenReads(f.ref, witness), { code: 'stale_result' })
    }
  } finally { f.close() }
})

test('requested reasoning options and an explicit native send selection bind the original real user', () => {
  const f = fixture({ reasoningLevel: 'high' })
  try {
    const user = f.witness.messages.find(message => message.info.role === 'user' && message.info.synthetic !== true)!
    f.witness.send.modelSelection = structuredClone(user.info.modelSelection) as NonNullable<ZCodeFrozenWitness['send']['modelSelection']>
    const proof = proveZCodeFrozenReads(f.ref, f.witness), model = { providerId: f.witness.providerId, modelId: f.witness.modelId }
    verifyZCodeFrozenReadProof(f.ref, proof, f.identity, { ...model, options: { reasoningLevel: 'high' } })
    assert.throws(() => verifyZCodeFrozenReadProof(f.ref, proof, f.identity, { ...model, options: { reasoningLevel: 'max' } }), { code: 'stale_result' })
    f.witness.send.modelSelection.options = { reasoningLevel: 'max' }
    assert.throws(() => proveZCodeFrozenReads(f.ref, f.witness), { code: 'stale_result' })
    assert.equal(f.witness.messages.filter(message => message.info.synthetic === true).every(message => (message.info.modelSelection as Record<string, unknown>).options === undefined), true)
  } finally { f.close() }
})
