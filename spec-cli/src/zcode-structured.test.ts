import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartToken, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { freezeContext } from './frozen-context.js'
import { structuredExecutionPolicy } from './session-structured-policy.js'
import { assertZCodeModelSnapshot, decodeZCodeStructuredText, stopZCodeStructuredTurn, zcodeCapability, zcodeIdleObservation, zcodeNativeModel, zcodeNativeSelection, zcodeProofEvent, zcodeRuntimeConfiguration, zcodeStructuredPrompt, zcodeStructuredTurn, type ZCodeStructuredExecution } from './zcode-structured.js'

test('ZCode namespace requires both exact provider and model', () => {
  assert.deepEqual(zcodeNativeModel('zcode:bigmodel-api/GLM-5.3-Flash'), { providerId: 'bigmodel-api', modelId: 'GLM-5.3-Flash' })
  for (const value of [undefined, 'GLM-5.3-Flash', 'zcode:GLM-5.3-Flash', 'zcode:bigmodel-api/', 'zcode:p/default', 'zcode:p/latest', 'zcode:p/m/other', 'zcode:p/model (context)', 'zcode:p/m\n']) assert.throws(() => zcodeNativeModel(value), { code: 'unsupported' })
})

test('ZCode text transport only unwraps one exact JSON shell without repairing data', () => {
  const output = { value: '中文\n原文', list: [1, 2] }
  for (const raw of [JSON.stringify(output), ` \n\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n`]) assert.deepEqual(decodeZCodeStructuredText(raw), output)
  for (const raw of ['answer: {"value":1}', '```JSON\n{}\n```', '```json\n{}\n```\n```json\n{}\n```', '{} {}', '```json\n{"value":}\n```', '```json\n{}\n```\nprose']) assert.throws(() => decodeZCodeStructuredText(raw))
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
