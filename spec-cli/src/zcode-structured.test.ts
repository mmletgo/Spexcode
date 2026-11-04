import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartToken, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { freezeContext, frozenReadTool, readFrozenRange } from './frozen-context.js'
import { ZCODE_FROZEN_TOOL, type ZCodeFrozenWitness, type ZCodeNativeEvent } from './zcode-frozen-evidence.js'
import { structuredExecutionPolicy } from './session-structured-policy.js'
import { assertZCodeModelSnapshot, decodeZCodeStructuredText, stopZCodeStructuredTurn, zcodeCapability, zcodeIdleObservation, zcodeNativeConfigModel, zcodeNativeConfigSelection, zcodeNativeModel, zcodeNativeSelection, zcodeProofEvent, zcodeRuntimeConfiguration, zcodeStructuredPrompt, zcodeStructuredTurn, type ZCodeStructuredExecution } from './zcode-structured.js'

test('ZCode namespace requires both exact provider and model', () => {
  assert.deepEqual(zcodeNativeModel('zcode:bigmodel-api/GLM-5.3-Flash'), { providerId: 'bigmodel-api', modelId: 'GLM-5.3-Flash' })
  for (const value of [undefined, 'GLM-5.3-Flash', 'zcode:GLM-5.3-Flash', 'zcode:bigmodel-api/', 'zcode:p/default', 'zcode:p/latest', 'zcode:p/m/other', 'zcode:p/model (context)', 'zcode:p/m\n']) assert.throws(() => zcodeNativeModel(value), { code: 'unsupported' })
})

test('ZCode text transport only unwraps one exact JSON shell without repairing data', () => {
  const output = { value: '中文\n原文', list: [1, 2] }
  for (const raw of [JSON.stringify(output), ` \n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n`]) assert.deepEqual(decodeZCodeStructuredText(raw), output)
  for (const raw of ['answer: {"value":1}', '```JSON\n{}\n```', '```json\n{}\n```\n```json\n{}\n```', '{} {}', '```json\n{"value":}\n```', '```json\n{}\n```\nprose']) assert.throws(() => decodeZCodeStructuredText(raw), { code: 'structured_output_format_invalid' })
})

test('large strict JSON syntax failures retain only safe parser category and numeric location', () => {
  const raw = `{\n"payload":"${'x'.repeat(13200)}PRIVATE_DIAGNOSTIC_CANARY"\n"next":1\n}`, position = raw.indexOf('"next"')
  for (const text of [raw, `\`\`\`json\n${raw}\n\`\`\``]) assert.throws(() => decodeZCodeStructuredText(text), error => {
    const failure = error as { code: string; message: string }
    assert.equal(failure.code, 'structured_output_format_invalid')
    for (const value of ['"category":"expected_property_delimiter"', `"position":${position}`, '"line":3', '"column":1']) assert(failure.message.includes(value), value)
    assert(!failure.message.includes('PRIVATE_DIAGNOSTIC_CANARY'))
    assert(!failure.message.includes('payload'))
    return true
  })
  for (const raw of ['PRIVATE_DIAGNOSTIC_CANARY', '{"value":']) assert.throws(() => decodeZCodeStructuredText(raw), error => {
    assert(!(error as Error).message.includes('PRIVATE_DIAGNOSTIC_CANARY'))
    return true
  })
})

for (const mode of ['frozen', 'worktree', 'unknown-plan', 'wrong-receipt', 'legacy', 'user-cancel'] as const) test(`RPC timeout with an exactly stopped Native automatically settles failure without a model send: ${mode}`, async () => {
  const { runtimeRoot, sessionArtifactPath } = await import('@spexcode/spec-core')
  const { sessionIdForCreateKey } = await import('./sessions.js')
  const { fromRaw, writeRecord, readRecord } = await import('./session-record.js')
  const { configuredSessionApplication } = await import('./session-application.js')
  const { runStructuredSession, cancelStructuredSession } = await import('./session-structured.js')
  const { nativeWorktreePrompt, sampleNativeWorktreeProcesses } = await import('./native-worktree-runtime.js')
  const worktree = mode === 'worktree'
  const directory = mkdtempSync(join(tmpdir(), 'spex-native-rpc-stop-')), requestKey = `native-rpc-stop-${mode}-${process.pid}`, id = sessionIdForCreateKey(requestKey)
  const root = join(runtimeRoot(), worktree ? 'structured-native-worktree-v1/zcode' : 'structured-zcode-read-only-v1', id), runtime = join(root, 'runtime'), workspace = join(directory, 'workspace'), tmp = join(directory, 'tmp')
  for (const path of [runtime, workspace, tmp]) mkdirSync(path, { recursive: true })
  const ownedPlan = { root, runtime, workspace, tmp, receiptFile: join(root, 'process.json') }
  if (worktree) sampleNativeWorktreeProcesses(ownedPlan)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace, detached: true, stdio: 'ignore' })
  assert(child.pid)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), prompt = 'Return one JSON object.', message = 'ZCode native RPC timeout (session/create)'
    const frozenContext = freezeContext({ directory: join(directory, 'frozen'), sourceRoot: process.cwd(), binding: { requestKey, inputDigest: 'rpc-input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public task') }] })
    const seed = { baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), mode: 'read' as const }
    const request = { root: process.cwd(), prompt, requestKey, schema: { type: 'object' }, inputDigest: 'rpc-input', purpose: 'rpc-stop', timeoutMs: 1000, model: 'zcode:bigmodel-api/GLM-5.3-Flash', ...(worktree ? { base: seed.baseCommit, worktree: seed, zcodeToolPolicy: { version: 1 as const, toolDenylist: ['ExitPlanMode'] as const } } : { frozenContext }) }
    const policy = structuredExecutionPolicy(request), receiptFile = join(root, 'process.json'), identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
    const native = { version: worktree ? 2 as const : 1 as const, root, sessionId: 'rpc-native', inputId: 'rpc-input', pid: child.pid, receiptFile }
    const plan = { ...ownedPlan, ...native, ...(worktree ? { worktreeProcessBaseline: 1, toolDenylist: policy.zcodeToolPolicy!.toolDenylist } : {}), policyDigest: hash(policy), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, model: zcodeNativeModel(policy.model) }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan)); writeFileSync(join(root, 'owned-processes.json'), JSON.stringify([{ pid: child.pid, startToken: identity.startToken.replace(/\s+/g, ' ') }]))
    process.kill(-child.pid, 'SIGTERM'); await exited
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: true, acknowledged: false, idle: false, closed: false, stderrBytes: 0, stderrSha256: createHash('sha256').update('').digest('hex') }))
    configuredSessionApplication().createSession({ sessionId: id, status: 'error' })
    const launchPrompt = worktree ? nativeWorktreePrompt(prompt, seed) : prompt
    const record = fromRaw({ session_id: id, governed: true, worktree_path: workspace, branch: null, title: null, name: null, status: 'error', proposal: null, merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'zcode', launch_cmd: 'zcode', create_request_id: createHash('sha256').update(requestKey).digest('hex'), create_payload_hash: hash({ prompt: launchPrompt, parent: null, launcher: null, ...(worktree ? { base: seed.baseCommit } : {}), structuredExecution: policy }) })
    record.structuredExecution = { ...policy, state: 'cancelling', turnStartRequested: true, zcodeNative: native, ...(mode === 'legacy' ? {} : { errorCode: 'native_rpc_timeout' as const }), error: message, cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: false, acknowledged: false, error: message } }
    writeRecord(record)
    const launch = sessionArtifactPath(id, 'launch'); mkdirSync(join(launch, '..'), { recursive: true }); writeFileSync(launch, launchPrompt)
    if (mode === 'unknown-plan' || mode === 'wrong-receipt' || mode === 'legacy') {
      const planBytes = readFileSync(join(root, 'plan.json')), receiptBytes = readFileSync(receiptFile)
      if (mode === 'unknown-plan') writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...plan, sessionId: 'wrong-native-owner' }))
      if (mode === 'wrong-receipt') writeFileSync(receiptFile, JSON.stringify({ ...JSON.parse(receiptBytes.toString()), processGroupId: child.pid + 1 }))
      await assert.rejects(runStructuredSession(request), { code: 'cancellation_pending' })
      const pending = readRecord(id)!.structuredExecution!; assert.equal(pending.state, 'cancelling'); assert.equal(pending.cancellation?.nativeStopped, false); assert.equal(pending.error, message)
      if (mode === 'legacy') { assert.equal(pending.errorCode, undefined); return }
      writeFileSync(join(root, 'plan.json'), planBytes); writeFileSync(receiptFile, receiptBytes)
    }
    if (mode === 'user-cancel') {
      assert.equal((await cancelStructuredSession(id, { reason: 'cancelled' })).state, 'cancelled')
      await assert.rejects(runStructuredSession(request), { code: 'cancelled' }); assert.equal(readRecord(id)!.structuredExecution!.state, 'cancelled'); return
    }
    for (let replay = 0; replay < 2; replay++) await assert.rejects(runStructuredSession(request), error => {
      assert.equal((error as { code: string }).code, 'native_rpc_timeout'); assert.equal((error as Error).message, message); return true
    })
    const state = readRecord(id)!.structuredExecution!
    assert.equal(state.state, 'failed'); assert.equal(state.error, message); assert.equal(state.errorCode, 'native_rpc_timeout')
    assert.equal(state.cancellation?.nativeStopped, true); assert.equal(state.cancellation?.acknowledged, false); assert.equal(state.cancellation?.nativeStatus, 'stopped')
    assert.equal(state.output, undefined); assert.equal(state.resultDigest, undefined); assert.equal(state.rejectedOutput, undefined)
    assert.equal(existsSync(join(root, 'send.json')), false); assert.equal(existsSync(join(root, 'terminal.json')), false)
    assert.deepEqual(structuredExecutionPolicy(state), policy)
    const before = JSON.stringify(state)
    assert.equal((await cancelStructuredSession(id, { settleFailure: true })).state, 'failed')
    assert.equal(JSON.stringify(readRecord(id)!.structuredExecution), before, 'duplicate stop cannot rewrite the original failure or stop proof')
    if (worktree) assert.equal(existsSync(join(root, 'process-stop-observations.jsonl')), true)
  } finally {
    if (processStartToken(child.pid)) { process.kill(-child.pid, 'SIGTERM'); await exited }
    rmSync(directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  }
})

for (const timeoutMs of [1000, null]) test(`ZCode strict JSON failure with timeout=${timeoutMs} requires complete native proof and preserves durable identity`, async t => {
  const { runtimeRoot, sessionArtifactPath } = await import('@spexcode/spec-core')
  const { sessionIdForCreateKey } = await import('./sessions.js')
  const { fromRaw, writeRecord, readRecord } = await import('./session-record.js')
  const { configuredSessionApplication } = await import('./session-application.js')
  const { executeQueuedStructuredSession, runStructuredSession } = await import('./session-structured.js')
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-format-')), requestKey = `zcode-format-failure-${timeoutMs}`, id = sessionIdForCreateKey(requestKey)
  const root = join(runtimeRoot(), 'structured-zcode-read-only-v1', id), runtime = join(root, 'runtime')
  mkdirSync(join(runtime, 'frozen-mcp'), { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  assert(child.pid)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  try {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'), prompt = 'Return one JSON object.'
    const ref = freezeContext({ directory: join(directory, 'frozen'), sourceRoot: process.cwd(), binding: { requestKey, inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public task') }] })
    const policy = structuredExecutionPolicy({ schema: { type: 'object' }, inputDigest: 'input', purpose: 'format-failure', timeoutMs, model: 'zcode:bigmodel-api/GLM-5.3-Flash', frozenContext: ref })
    const receiptFile = join(root, 'process.json'), identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input', turnId: 'turn', pid: child.pid, receiptFile }
    const nativePrompt = zcodeStructuredPrompt(prompt, policy.schema), modelSnapshot = { sessionId: native.sessionId, model: zcodeNativeModel(policy.model) }
    const plan = { ...native, runtime, policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection: zcodeNativeSelection(policy.model) }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, model: zcodeNativeModel(policy.model), modelSnapshotDigest: hash(modelSnapshot) }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan)); writeFileSync(join(root, 'model-snapshot.json'), JSON.stringify(modelSnapshot))
    writeFileSync(join(root, 'send.json'), JSON.stringify({ sessionId: native.sessionId, content: nativePrompt, inputId: native.inputId, modelSelection: plan.model }))
    const response = 'Analysis is complete:\n{"answer":"exact"}', args = { contextDigest: ref.contextDigest, entryId: 'task', startByte: 0, endByte: Buffer.byteLength('public task') }
    const output = readFrozenRange(ref, args).response.contentItems[0].text, bytes = Buffer.byteLength(output)
    const part = (messageID: string, type: string, data: Record<string, unknown>) => ({ id: `part-${messageID}`, sessionID: native.sessionId, messageID, type, ...data })
    const semantics = { origin: 'agent_runtime', kind: 'assistant_response', uiVisibility: 'visible', providerVisibility: 'visible', transcriptVisibility: 'visible' }
    const messages: ZCodeFrozenWitness['messages'] = [
      { info: { id: 'user', sessionID: native.sessionId, role: 'user', modelSelection: plan.model, anchor: { turnId: native.turnId, origin: 'realUser', sourceCommandId: 'send' }, semantics: { ...semantics, origin: 'real_user', kind: 'user_prompt' } }, parts: [part('user', 'text', { text: nativePrompt })] },
      { info: { id: 'reader', sessionID: native.sessionId, role: 'assistant', parentID: 'user', ...plan.model, anchor: { turnId: native.turnId }, semantics }, parts: [part('reader', 'tool', { callID: 'call', tool: ZCODE_FROZEN_TOOL, state: { status: 'completed', input: args, output, metadata: { serialization: { truncated: false, originalBytes: bytes, returnedBytes: bytes } } } })] },
      { info: { id: 'final', sessionID: native.sessionId, role: 'assistant', parentID: 'user', ...plan.model, anchor: { turnId: native.turnId, boundaryMessageId: 'final', historyRoundCount: 2, orderedMessageIds: ['user', 'reader', 'final'] }, semantics }, parts: [part('final', 'text', { text: response })] },
    ]
    const events: ZCodeNativeEvent[] = [
      { type: 'turn.started', payload: { turnNumber: 0, input: nativePrompt, messageId: 'user', inputId: native.inputId } },
      { type: 'session.updated', payload: { ...plan.model, toolCount: 1, messageCount: 1, iteration: 0 } },
      { type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'call', assistantMessageId: 'reader', toolName: ZCODE_FROZEN_TOOL, input: args } },
      { type: 'tool.updated', payload: { kind: 'started', toolCallId: 'call', toolName: ZCODE_FROZEN_TOOL } },
      { type: 'tool.updated', payload: { kind: 'result', toolCallId: 'call', toolName: ZCODE_FROZEN_TOOL, result: { success: true, content: output, truncated: false, originalBytes: bytes, returnedBytes: bytes } } },
      { type: 'session.updated', payload: { ...plan.model, toolCount: 1, messageCount: 3, iteration: 1 } },
      { type: 'turn.completed', payload: { inputId: native.inputId, resultType: 'success', response, toolCallCount: 1 } },
    ].map((event, index) => ({ ...event, eventId: `event-${index}`, seq: index + 1, sessionId: native.sessionId, turnId: native.turnId }))
    const records = [
      { type: 'request', request: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'zcode', version: zcodeCapability.cliVersion } } } },
      { type: 'response', response: { jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 'spex-immutable-reader' } } } },
      { type: 'request', request: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
      { type: 'response', response: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'spex_read_frozen', inputSchema: frozenReadTool.inputSchema }] } } },
      { type: 'request', request: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spex_read_frozen', arguments: args, _meta: { session_id: native.sessionId, turn_id: native.turnId } } } },
      { type: 'response', response: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: output }] } } },
    ]
    const mcpPath = join(runtime, 'frozen-mcp', 'mcp-public.jsonl')
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(events.at(-1)))
    writeFileSync(join(root, 'events.json'), JSON.stringify(events)); writeFileSync(join(root, 'messages.json'), JSON.stringify(messages))
    writeFileSync(mcpPath, records.map(row => JSON.stringify(row)).join('\n') + '\n')
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: true, idle: true, closed: true }))
    writeFileSync(join(root, 'owned-processes.json'), JSON.stringify([{ pid: child.pid, startToken: identity.startToken.replace(/\s+/g, ' ') }]))
    process.kill(-child.pid, 'SIGTERM'); await exited
    const execution: ZCodeStructuredExecution = { ...policy, version: timeoutMs === null ? 5 : 4, policy: 'zcode-frozen-read-only-v1', turnStartRequested: true, zcodeNative: native, frozenReadProof: undefined }
    const callbacks = { onThread: async () => assert.fail('no thread'), onTurn: async () => assert.fail('no turn'), onNative: async () => assert.fail('no native') }
    const unreadMessages = structuredClone(messages), unreadEvents = structuredClone(events).filter(event => event.type !== 'tool.updated')
    unreadMessages[1].parts = []; unreadEvents[2].payload.messageCount = 2; unreadEvents[2].payload.iteration = 0; unreadEvents.at(-1)!.payload.toolCallCount = 0
    const foreignEvents = structuredClone(events); foreignEvents[1].payload.toolCount = 2
    for (const scenario of [
      { name: 'malformed JSON plus missing native messages', messages: [], events, records },
      { name: 'malformed JSON plus missing MCP handshake', messages, events, records: [] },
      { name: 'malformed JSON plus foreign tool surface', messages, events: foreignEvents, records },
      { name: 'malformed JSON plus incomplete required reads', messages: unreadMessages, events: unreadEvents, records: records.slice(0, 4) },
    ]) await t.test(scenario.name, async () => {
      writeFileSync(join(root, 'messages.json'), JSON.stringify(scenario.messages)); writeFileSync(join(root, 'events.json'), JSON.stringify(scenario.events))
      writeFileSync(join(root, 'terminal.json'), JSON.stringify(scenario.events.at(-1)))
      writeFileSync(mcpPath, scenario.records.map(row => JSON.stringify(row)).join('\n') + '\n')
      await assert.rejects(zcodeStructuredTurn(join(root, '..'), id, prompt, execution, callbacks), { code: 'stale_result' })
    })
    writeFileSync(join(root, 'messages.json'), JSON.stringify(messages)); writeFileSync(join(root, 'events.json'), JSON.stringify(events))
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(events.at(-1)))
    writeFileSync(mcpPath, records.map(row => JSON.stringify(row)).join('\n') + '\n')
    configuredSessionApplication().createSession({ sessionId: id, status: 'awaiting', proposal: 'nothing' })
    const record = fromRaw({ session_id: id, governed: true, worktree_path: process.cwd(), branch: null, title: null, name: null, status: 'awaiting', proposal: 'nothing', merges: 0, note: null, sortkey: null, createdAt: 1, stopped: false, archived: false, harness: 'zcode', launch_cmd: 'zcode', create_request_id: createHash('sha256').update(requestKey).digest('hex'), create_payload_hash: hash({ prompt, parent: null, launcher: null, structuredExecution: policy }) })
    record.structuredExecution = { ...policy, state: 'running', threadId: native.sessionId, turnId: native.turnId, turnStartRequested: true, zcodeNative: native }
    record.harnessSessionId = native.sessionId; writeRecord(record)
    const launch = sessionArtifactPath(id, 'launch'); mkdirSync(join(launch, '..'), { recursive: true }); writeFileSync(launch, prompt)
    assert.equal(await executeQueuedStructuredSession(id), 'failed')
    const failed = readRecord(id)!
    assert.equal(failed.structuredExecution?.errorCode, 'structured_output_format_invalid')
    assert.equal(failed.structuredExecution?.output, undefined); assert.equal(failed.structuredExecution?.frozenReadProof, undefined)
    const request = { root: process.cwd(), prompt, requestKey, ...policy }
    for (let replay = 0; replay < 2; replay++) await assert.rejects(runStructuredSession(request), { code: 'structured_output_format_invalid', sessionId: id, threadId: native.sessionId, turnId: native.turnId })
    writeRecord({ ...failed, structuredExecution: { ...failed.structuredExecution!, errorCode: undefined } })
    await assert.rejects(runStructuredSession(request), { code: 'failed' })
    assert.equal(existsSync(join(root, 'completed.json')), false); assert.equal(existsSync(join(root, 'witness.json')), false)
    const validMessages = structuredClone(messages), validEvents = structuredClone(events)
    validMessages.at(-1)!.parts[0].text = '{}'; validEvents.at(-1)!.payload.response = '{}'
    writeFileSync(join(root, 'messages.json'), JSON.stringify(validMessages)); writeFileSync(join(root, 'events.json'), JSON.stringify(validEvents))
    await assert.rejects(zcodeStructuredTurn(join(root, '..'), id, prompt, execution, callbacks), { code: 'stale_result' })
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(validEvents.at(-1)))
    const completed = await zcodeStructuredTurn(join(root, '..'), id, prompt, execution, callbacks)
    assert.equal(completed.text, '{}')
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(events.at(-1)))
    await assert.rejects(zcodeStructuredTurn(join(root, '..'), id, prompt, execution, callbacks), { code: 'stale_result' })

  } finally {
    if (processStartToken(child.pid)) { process.kill(-child.pid, 'SIGTERM'); await exited }
    rmSync(root, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true })
  }
})

test('one deterministic native input carries the exact schema and the original business bytes', () => {
  const prompt = '原业务正文\r\n保持最后空格  ', schema = { type: 'object', properties: { 未提示字段: { type: 'string', enum: ['a\nb'] } }, required: ['未提示字段'], additionalProperties: false }
  const native = zcodeStructuredPrompt(prompt, schema), json = JSON.stringify(schema)
  assert.equal(native, zcodeStructuredPrompt(prompt, schema))
  assert.equal(native.split(json).length, 2)
  assert(native.endsWith(`\n\n${prompt}`))
  assert(!prompt.includes('未提示字段'))
  assert(native.includes('read-only control'))
  assert.notEqual(native, zcodeStructuredPrompt(prompt, { ...schema, additionalProperties: true }))
})

test('verified GLM high effort uses both native fields and requires the real settings selection', () => {
  const selection = zcodeNativeSelection('zcode:bigmodel-api/GLM-5.3-Flash', 'high')
  assert.deepEqual(selection, { model: { providerId: 'bigmodel-api', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } }, thoughtLevel: 'high' })
  assert.deepEqual(zcodeNativeSelection('zcode:bigmodel-api/GLM-5.3-Flash'), { model: zcodeNativeModel('zcode:bigmodel-api/GLM-5.3-Flash') })
  for (const effort of ['minimal', 'low', 'medium', 'xhigh'] as const) assert.throws(() => zcodeNativeSelection('zcode:bigmodel-api/GLM-5.3-Flash', effort), { code: 'unsupported' })
  assert.throws(() => zcodeNativeSelection('zcode:other/GLM-5.3-Flash', 'high'), { code: 'unsupported' })
  const snapshot = { session: { sessionId: 'session', model: zcodeNativeModel('zcode:bigmodel-api/GLM-5.3-Flash') }, settings: { model: { current: selection.model, available: ['unrelated display metadata'] }, thoughtLevel: { current: 'high', available: [{ label: 'high', value: 'high' }], defaultLevel: 'max', enabled: true } } }
  assert.doesNotThrow(() => assertZCodeModelSnapshot(snapshot, selection))
  for (const corrupt of [
    () => ({ ...snapshot, settings: { ...snapshot.settings, model: { current: { ...selection.model, options: { reasoningLevel: 'max' } } } } }),
    () => ({ ...snapshot, settings: { ...snapshot.settings, model: { current: { providerId: 'other', modelId: selection.model.modelId, options: selection.model.options } } } }),
    () => ({ ...snapshot, settings: { ...snapshot.settings, model: { current: { ...selection.model, options: { ...selection.model.options, unknownCapability: true } } } } }),
    () => ({ ...snapshot, settings: { ...snapshot.settings, thoughtLevel: { ...snapshot.settings.thoughtLevel, current: 'max' } } }),
    () => ({ ...snapshot, settings: { ...snapshot.settings, thoughtLevel: { ...snapshot.settings.thoughtLevel, available: [] } } }),
  ]) assert.throws(() => assertZCodeModelSnapshot(corrupt(), selection), { code: 'unsupported' })
})

test('cli-config-v1 forwards opaque provider/model and effort to SDK readback', () => {
  const route = 'zcode:anthropic/claude-sonnet-4:custom+context'
  const model = { providerId: 'anthropic', modelId: 'claude-sonnet-4:custom+context' }
  assert.deepEqual(zcodeNativeConfigModel(route), model)
  assert.equal(zcodeNativeConfigModel('zcode:default'), undefined)
  assert.deepEqual(zcodeNativeConfigSelection('zcode:default', 'high'), { thoughtLevel: 'high' })
  const selection = zcodeNativeConfigSelection(route, 'xhigh')
  assert.deepEqual(selection, { model: { ...model, options: { reasoningLevel: 'xhigh' } }, thoughtLevel: 'xhigh' })
  const snapshot = { session: { sessionId: 'session', model }, settings: { model: { current: { ...selection.model!, options: { reasoningLevel: 'xhigh', providerOption: 'preserved' } } }, thoughtLevel: { current: 'xhigh', available: [{ label: 'Extra high', value: 'xhigh' }] } } }
  assert.doesNotThrow(() => assertZCodeModelSnapshot(snapshot, selection, true))
  const wrongModel = { ...snapshot, settings: { ...snapshot.settings, model: { current: { ...snapshot.settings.model.current, options: { reasoningLevel: 'high' } } } } }
  const wrongEffort = { ...snapshot, settings: { ...snapshot.settings, thoughtLevel: { ...snapshot.settings.thoughtLevel, current: 'high' } } }
  assert.throws(() => assertZCodeModelSnapshot(wrongModel, selection, true), { code: 'unsupported' })
  assert.throws(() => assertZCodeModelSnapshot(wrongEffort, selection, true), { code: 'unsupported' })
})

for (const profile of ['cli-config-v1-explicit', 'cli-config-v1-default', 'legacy-v2'] as const) test(`ZCode completed cold replay binds its original runtime identity and model selection: ${profile}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-runtime-snapshot-')), realm = join(directory, 'realm'), root = join(realm, 'native')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  try {
    const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const generic = profile !== 'legacy-v2', defaultModel = profile === 'cli-config-v1-default'
    const modelRoute = defaultModel ? 'zcode:default' : generic ? 'zcode:anthropic/claude-sonnet-4:custom+context' : 'zcode:bigmodel-api/GLM-5.3-Flash'
    const effort = profile === 'cli-config-v1-explicit' ? 'xhigh' as const : profile === 'legacy-v2' ? 'high' as const : undefined
    const zcodeToolPolicy = profile === 'legacy-v2' ? { version: 1 as const, toolDenylist: ['ExitPlanMode'] as const } : undefined
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, prompt = 'Return the completed response.'
    const worktree = { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: profile === 'legacy-v2' ? 'read' as const : 'edit' as const }
    const policy = structuredExecutionPolicy({ schema, inputDigest: 'snapshot-input', purpose: 'runtime-snapshot', timeoutMs: 1000, model: modelRoute, ...(effort ? { effort } : {}), worktree, ...(zcodeToolPolicy ? { zcodeToolPolicy } : {}), ...(generic ? { nativeConfiguration: 'cli-config-v1' as const } : {}) })
    const requested = generic ? zcodeNativeConfigSelection(modelRoute, effort) : zcodeNativeSelection(modelRoute, effort)
    const selectedModel = defaultModel ? { providerId: 'configured-provider', modelId: 'configured-default', options: { reasoningLevel: 'medium', providerOption: 'retained' } }
      : generic ? { ...requested.model!, options: { ...(requested.model!.options ?? {}), providerOption: 'retained' } } : requested.model!
    const sessionId = 'snapshot-session', inputId = 'snapshot-input-id', turnId = 'snapshot-turn', queryId = 'snapshot-query', runtime = join(root, 'runtime'), workspace = join(directory, 'worktree'), tmp = join(directory, 'tmp')
    const native = { version: generic ? 3 as const : 2 as const, root, sessionId, inputId, turnId }
    const execution: ZCodeStructuredExecution = { ...policy, version: 6, policy: 'native-worktree-v1', ...(generic ? { nativeConfiguration: 'cli-config-v1' as const } : {}), zcodeNative: native, state: 'completed', threadId: sessionId, turnId, output: { ok: true }, resultDigest: hash({ ok: true }), frozenReadProof: undefined }
    const nativePrompt = `${zcodeToolPolicy ? 'This read-only turn must return the complete schema JSON. Do not request plan approval or call ExitPlanMode.\n' : ''}Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(schema)}\n\n${prompt}`
    const modelSnapshot = { sessionId, model: selectedModel, ...(requested.thoughtLevel ? { thoughtLevel: requested.thoughtLevel } : {}) }
    const plan = { ...native, ...(generic ? { nativeConfiguration: 'cli-config-v1' as const } : {}), worktreeProcessBaseline: 1 as const, ...(zcodeToolPolicy ? { toolDenylist: zcodeToolPolicy.toolDenylist } : {}), queryId, runtime, tmp, workspace, receiptFile: join(root, 'process.json'), model: selectedModel, ...(requested.thoughtLevel ? { thoughtLevel: requested.thoughtLevel } : {}), policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection: requested, ...(zcodeToolPolicy ? { toolDenylist: zcodeToolPolicy.toolDenylist } : {}) }), cliPath: '/fixture/zcode', cliVersion: generic ? '99.4.1' : '0.16.9', cliSha256: generic ? 'c'.repeat(64) : 'a'.repeat(64), ...(generic ? { builtinPath: zcodeCapability.builtinPath, builtinSha256: 'd'.repeat(64) } : { builtinSha256: 'b'.repeat(64) }), modelSnapshotDigest: hash(modelSnapshot) }
    const response = JSON.stringify({ ok: true })
    const events = [
      { type: 'turn.started', payload: { inputId, queryId, messageId: 'snapshot-user' } },
      { type: 'session.updated', payload: { providerId: selectedModel.providerId, modelId: selectedModel.modelId, toolCount: 5 } },
      { type: 'turn.completed', payload: { inputId, resultType: 'success', response } },
    ].map((event, index) => ({ ...event, eventId: `snapshot-event-${index}`, seq: index + 1, sessionId, turnId }))
    const terminal = events.at(-1)!
    const messages = [
      { info: { id: 'snapshot-user', sessionID: sessionId, role: 'user', modelSelection: selectedModel, anchor: { turnId }, semantics: { kind: 'user_prompt' } }, parts: [{ type: 'text', text: nativePrompt }] },
      { info: { id: 'snapshot-final', sessionID: sessionId, role: 'assistant', providerId: selectedModel.providerId, modelId: selectedModel.modelId, anchor: { turnId }, semantics: { kind: 'assistant_response' } }, parts: [{ type: 'text', text: response }] },
    ]
    const send = { sessionId, content: nativePrompt, inputId, modelSelection: selectedModel, ...(plan.version >= 2 ? { toolDenylist: plan.toolDenylist } : {}) }
    const exit = { code: 0, signal: null, stopped: true, acknowledged: true, idle: true, closed: true, stderrBytes: 0, stderrSha256: 'e'.repeat(64) }
    const output = { ok: true }, result = { threadId: sessionId, turnId, text: JSON.stringify(output) }
    const completed = { plan, terminal, events, messages, exit, send, result }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'model-snapshot.json': modelSnapshot, 'events.json': events, 'messages.json': messages, 'terminal.json': terminal, 'exit.json': exit, 'send.json': send, 'completed.json': completed })) writeFileSync(join(root, name), JSON.stringify(value))
    const callbacks = { onThread: async () => assert.fail('cold replay must not create a session'), onTurn: async () => assert.fail('cold replay must not send a turn'), onNative: async () => assert.fail('cold replay must not start a CLI') }
    const replay = await zcodeStructuredTurn(realm, 'native', prompt, execution, callbacks, workspace)
    assert.deepEqual(replay, result)
    assert.equal(replay.frozenReadProof, undefined)
    const planBytes = readFileSync(join(root, 'plan.json'))
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...plan, cliSha256: 'f'.repeat(64) }))
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, execution, callbacks, workspace), { code: 'stale_result' })
    writeFileSync(join(root, 'plan.json'), planBytes)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('safe event projection keeps the original proof object and never reads transport headers', () => {
  const base = { sessionId: 'session', turnId: 'turn', seq: 1, eventId: 'event', type: 'session.updated' }
  const safe = { ...base, payload: { toolCount: 1, providerId: 'bigmodel-api', modelId: 'GLM-5.3-Flash', iteration: 0 } }
  assert.equal(zcodeProofEvent(safe), safe)
  const transport = { ...base, payload: { get requestHeaders(): never { throw new Error('headers must never be read') } } }
  assert.equal(zcodeProofEvent(transport), undefined)
  assert.equal(zcodeProofEvent({ ...base, type: 'unknown', payload: transport.payload }), undefined)
  assert.throws(() => zcodeProofEvent({ ...safe, payload: { ...safe.payload, requestHeaders: 'forbidden' } }), { code: 'stale_result' })
  const terminal = { ...base, type: 'turn.completed', payload: { resultType: 'success', response: '{}' } }
  assert.equal(zcodeProofEvent(terminal), terminal)
})

test('fixed ZCode configuration closes plugins, hooks, memory, subagents and instruction discovery', () => {
  assert.deepEqual(zcodeRuntimeConfiguration(), { features: { mcp: true, subagent: false, memory: false, skill: false }, mcp: { servers: {} }, plugins: { enabled: false, dirs: [], enabledPlugins: {}, extraKnownMarketplaces: {}, options: {}, suppressedBuiltins: [] }, hooks: { enabled: false, events: {} }, skills: { enabled: false, includeInstructions: false, roots: [] } })
  assert.equal(zcodeCapability.cliVersion, '0.17.1')
  assert.match(zcodeCapability.cliSha256, /^[a-f0-9]{64}$/)
})

test('unstarted and unproven ZCode cancellation do not invent stop authority', async () => {
  const execution = { version: 4, policy: 'zcode-frozen-read-only-v1', schema: {}, purpose: 'test', inputDigest: 'test', timeoutMs: 1000, model: 'zcode:bigmodel-api/GLM-5.3-Flash' } satisfies ZCodeStructuredExecution
  assert.deepEqual(await stopZCodeStructuredTurn(execution), { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' })
  assert.equal((await stopZCodeStructuredTurn({ ...execution, turnStartRequested: true })).nativeStopped, false)
})

test('completed native turn may remain the projection history pointer while real activity is idle', () => {
  const snapshot = { session: { sessionId: 'session', status: 'idle' }, runtime: { pendingRequestIds: [] }, projection: { currentTurnId: 'turn', status: 'idle', pendingPermissions: [], activeToolCalls: [{ toolCallId: 'reader', toolName: zcodeCapability.tool, status: 'completed' }] } }
  Object.defineProperty(snapshot, 'transport', { get: () => { throw new Error('transport payload must not be read') } })
  const state = zcodeIdleObservation(snapshot, { sessionId: 'session', turnId: 'turn' })
  assert.equal(state.idle, true)
  assert.equal(state.observed.currentTurnId, 'turn')
  assert.deepEqual(state.observed.activeToolCalls, snapshot.projection.activeToolCalls)
  for (const changed of [
    { ...snapshot, session: { sessionId: 'other', status: 'idle' } },
    { ...snapshot, session: { sessionId: 'session', status: 'running' } },
    { ...snapshot, runtime: { ...snapshot.runtime, activeTurnId: 'turn', activeTurnKind: 'regular' } },
    { ...snapshot, runtime: { pendingRequestIds: ['pending'] } },
    { ...snapshot, projection: { ...snapshot.projection, currentTurnId: 'other' } },
    { ...snapshot, projection: { ...snapshot.projection, pendingPermissions: [{ requestId: 'pending' }] } },
    ...['pending', 'running', 'unknown'].map(status => ({ ...snapshot, projection: { ...snapshot.projection, activeToolCalls: [{ ...snapshot.projection.activeToolCalls[0], status }] } })),
  ]) assert.equal(zcodeIdleObservation(changed, { sessionId: 'session', turnId: 'turn' }).idle, false)
})

test('cold ZCode cancellation verifies the original group and null-token MCP through host observation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-stop-')), root = join(directory, 'native'), runtime = join(root, 'runtime')
  mkdirSync(join(runtime, 'frozen-mcp'), { recursive: true })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const reader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  assert(child.pid); assert(reader.pid)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  const readerExited = new Promise<void>(resolve => reader.once('close', () => resolve()))
  try {
    const receiptFile = join(root, 'process.json'), identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const ref = freezeContext({ directory: join(directory, 'frozen'), sourceRoot: process.cwd(), binding: { requestKey: 'stop', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public task') }] })
    const policy = { ...structuredExecutionPolicy({ schema: { type: 'object' }, inputDigest: 'input', purpose: 'stop', timeoutMs: 1000, model: 'zcode:bigmodel-api/GLM-5.3-Flash', frozenContext: ref }), version: 4 as const, policy: 'zcode-frozen-read-only-v1' as const, frozenReadProof: undefined }
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input', pid: child.pid, receiptFile }
    const execution: ZCodeStructuredExecution = { ...policy, zcodeNative: native, turnStartRequested: true }
    const plan = { ...native, policyDigest: hash(policy), requestDigest: hash({ prompt: 'fixed prompt', nativePrompt: zcodeStructuredPrompt('fixed prompt', policy.schema), policy, selection: zcodeNativeSelection(execution.model) }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, model: zcodeNativeModel(execution.model), runtime, receiptFile }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan))
    const readerStart = processStartToken(reader.pid)
    assert(readerStart)
    writeFileSync(join(root, 'owned-processes.json'), JSON.stringify([{ pid: child.pid, startToken: identity.startToken.replace(/\s+/g, ' ') }, { pid: reader.pid, startToken: readerStart.replace(/\s+/g, ' ') }]))
    writeFileSync(join(runtime, 'frozen-mcp/mcp-public.jsonl'), JSON.stringify({ type: 'process', pid: reader.pid, startToken: null }) + '\n')
    const refused = await stopZCodeStructuredTurn({ ...execution, purpose: 'another policy' }, 20)
    assert.equal(refused.nativeStopped, false)
    assert.equal(processStartToken(child.pid), identity.startToken)
    await assert.rejects(zcodeStructuredTurn(directory, 'native', 'fixed prompt', execution, { onThread: async () => assert.fail('no new thread'), onTurn: async () => assert.fail('no new turn'), onNative: async () => assert.fail('no new native') }), { code: 'cancellation_pending' })
    process.kill(-child.pid, 'SIGTERM'); await exited
    assert.equal(processStartToken(reader.pid), readerStart, 'leader exit does not prove a separate MCP process stopped')
    assert.deepEqual(await stopZCodeStructuredTurn(execution, 3000), { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
    await readerExited
    const before = readFileSync(join(root, 'plan.json'))
    assert.deepEqual(await stopZCodeStructuredTurn(execution, 20), { nativeStopped: true, acknowledged: false, nativeStatus: 'stopped' })
    assert.deepEqual(readFileSync(join(root, 'plan.json')), before)
  } finally {
    if (processStartToken(child.pid)) { process.kill(-child.pid, 'SIGTERM'); await exited }
    if (processStartToken(reader.pid)) { process.kill(-reader.pid, 'SIGTERM'); await readerExited }
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an existing native dispatch cannot be resumed with another send or new process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-existing-'))
  try {
    const ref = freezeContext({ directory: join(directory, 'frozen'), sourceRoot: process.cwd(), binding: { requestKey: 'existing', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('public task') }] })
    const execution: ZCodeStructuredExecution = { version: 4, policy: 'zcode-frozen-read-only-v1', schema: {}, purpose: 'existing', inputDigest: 'input', timeoutMs: 1000, model: 'zcode:bigmodel-api/GLM-5.3-Flash', frozenContext: ref, turnStartRequested: true }
    await assert.rejects(zcodeStructuredTurn(directory, 'native', 'original prompt', execution, { onThread: async () => assert.fail('no thread'), onTurn: async () => assert.fail('no turn'), onNative: async () => assert.fail('no native') }), { code: 'cancellation_pending' })
    assert.equal(existsSync(join(directory, 'native')), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('cold replay binds schema and the exact original native send before reading any completion cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-prompt-')), root = join(directory, 'native')
  mkdirSync(root)
  try {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const schema = { type: 'object', properties: { onlyInSchema: { type: 'string' } }, required: ['onlyInSchema'], additionalProperties: false }, prompt = 'Read the opaque value and return the required response.'
    const ref = freezeContext({ directory: join(directory, 'frozen'), sourceRoot: process.cwd(), binding: { requestKey: 'prompt-binding', inputDigest: 'input' }, entries: [{ id: 'task', label: 'task', kind: 'utf8', bytes: Buffer.from('unchanged frozen task') }] })
    const policy = { ...structuredExecutionPolicy({ schema, inputDigest: 'input', purpose: 'prompt-binding', timeoutMs: 1000, model: 'zcode:bigmodel-api/GLM-5.3-Flash', frozenContext: ref }), version: 4 as const, policy: 'zcode-frozen-read-only-v1' as const, frozenReadProof: undefined }
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input' }, execution: ZCodeStructuredExecution = { ...policy, zcodeNative: native, turnStartRequested: true }
    const nativePrompt = zcodeStructuredPrompt(prompt, schema), send = { sessionId: native.sessionId, content: nativePrompt, inputId: native.inputId, modelSelection: zcodeNativeModel(execution.model) }, modelSnapshot = { sessionId: native.sessionId, model: zcodeNativeModel(execution.model) }
    const plan = { ...native, policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection: zcodeNativeSelection(execution.model) }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, model: zcodeNativeModel(execution.model), receiptFile: join(root, 'process.json'), modelSnapshotDigest: hash(modelSnapshot) }
    writeFileSync(join(root, 'plan.json'), JSON.stringify(plan)); writeFileSync(join(root, 'model-snapshot.json'), JSON.stringify(modelSnapshot)); writeFileSync(join(root, 'send.json'), JSON.stringify(send))
    const fixedManifest = readFileSync(ref.manifestPath), callbacks = { onThread: async () => assert.fail('no new thread'), onTurn: async () => assert.fail('no new turn'), onNative: async () => assert.fail('no new native') }
    assert((JSON.parse(readFileSync(join(root, 'send.json'), 'utf8')) as { content: string }).content.includes(JSON.stringify(schema)))
    await assert.rejects(zcodeStructuredTurn(directory, 'native', prompt, execution, callbacks), { code: 'cancellation_pending' })
    writeFileSync(join(root, 'completed.json'), 'must not be read before fixed input validation')
    await assert.rejects(zcodeStructuredTurn(directory, 'native', prompt, { ...execution, schema: { ...schema, additionalProperties: true } }, callbacks), { code: 'stale_result' })
    await assert.rejects(zcodeStructuredTurn(directory, 'native', prompt + ' changed', execution, callbacks), { code: 'stale_result' })
    for (const content of [prompt, nativePrompt + '\nchanged', zcodeStructuredPrompt(prompt, { type: 'string' })]) {
      writeFileSync(join(root, 'send.json'), JSON.stringify({ ...send, content }))
      await assert.rejects(zcodeStructuredTurn(directory, 'native', prompt, execution, callbacks), { code: 'stale_result' })
    }
    writeFileSync(join(root, 'send.json'), JSON.stringify({ ...send, modelSelection: { ...send.modelSelection, modelId: 'another-model' } }))
    await assert.rejects(zcodeStructuredTurn(directory, 'native', prompt, execution, callbacks), { code: 'stale_result' })
    assert.deepEqual(readFileSync(ref.manifestPath), fixedManifest)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
