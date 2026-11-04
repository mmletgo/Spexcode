import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freezeContext, readFrozenManifest } from './frozen-context.js'
import { verifyZCodeFrozenReadProof } from './zcode-frozen-evidence.js'
import { stopZCodeStructuredTurn, zcodeNativeSelection, zcodeStructuredPrompt, zcodeStructuredTurn, type ZCodeStructuredExecution } from './zcode-structured.js'

const enabled = process.env.SPEX_ZCODE_NATIVE_TEST === '1'
const evidence = process.env.SPEX_ZCODE_EVIDENCE_DIR

test('actual isolated ZCode reads public frozen bytes and replays the exact completion without another send', { skip: !enabled, timeout: 300000 }, async () => {
  assert(evidence, 'SPEX_ZCODE_EVIDENCE_DIR is required for a deliberate one-turn native run')
  const root = join(evidence, 'zcode-native'), source = join(root, 'source'), realm = join(root, 'realm')
  mkdirSync(source, { recursive: true, mode: 0o700 })
  assert(!existsSync(join(realm, 'native/plan.json')), 'the explicit native test permits one fresh send only')
  const marker = `PUBLIC_${randomUUID().replaceAll('-', '')}`
  const task = 'Read every required frozen entry completely through mcp__frozen__spex_read_frozen, including the task. Return the opaque payload value using the structured output contract.'
  const ref = freezeContext({ directory: join(root, 'frozen'), sourceRoot: source, binding: { requestKey: 'zcode-native', inputDigest: 'zcode-native' }, entries: [{ id: 'task', label: 'public task', kind: 'utf8', bytes: Buffer.from(task) }, { id: 'payload', label: 'public opaque value', kind: 'utf8', bytes: Buffer.from(`opaqueValue=${marker}\n`) }] })
  const manifest = readFrozenManifest(ref), prompt = `${task}\nFrozen manifest: ${JSON.stringify(manifest)}\nRead each required entry at startByte=0 and endByte=its byteLength using contextDigest=${ref.contextDigest}.`
  let execution: ZCodeStructuredExecution = { version: 4, policy: 'zcode-frozen-read-only-v1', schema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }, inputDigest: 'zcode-native', purpose: 'zcode-native', timeoutMs: 240000, model: process.env.SPEX_ZCODE_NATIVE_MODEL ?? 'zcode:bigmodel-api/GLM-5.3-Flash', effort: 'high', frozenContext: ref }
  const persist = (change: Partial<ZCodeStructuredExecution>): void => { execution = { ...execution, ...change }; writeFileSync(join(root, 'checkpoint.json'), JSON.stringify(execution), { mode: 0o600 }) }
  try {
    const result = await zcodeStructuredTurn(realm, 'native', prompt, execution, { onThread: async threadId => persist({ threadId }), onTurn: async turnId => persist({ turnId }), onTurnStarting: async () => persist({ turnStartRequested: true }), onNative: async zcodeNative => persist({ zcodeNative }) })
    const output = JSON.parse(result.text) as unknown
    assert.deepEqual(output, { marker })
    const nativePrompt = zcodeStructuredPrompt(prompt, execution.schema)
    assert(!prompt.includes('marker'))
    verifyZCodeFrozenReadProof(ref, result.frozenReadProof, { threadId: result.threadId, turnId: result.turnId, inputId: execution.zcodeNative!.inputId, prompt: nativePrompt }, zcodeNativeSelection(execution.model, execution.effort).model, { output })
    persist({ state: 'completed', output, resultDigest: createHash('sha256').update(result.text).digest('hex'), frozenReadProof: result.frozenReadProof })
    const nativeRoot = join(realm, 'native'), before = readFileSync(join(nativeRoot, 'send.json'))
    const send = JSON.parse(before.toString('utf8')) as { content: string; modelSelection: unknown }
    assert.equal(send.content, nativePrompt); assert(send.content.includes(JSON.stringify(execution.schema)))
    assert.deepEqual(send.modelSelection, zcodeNativeSelection(execution.model, execution.effort).model)
    const replay = await zcodeStructuredTurn(realm, 'native', prompt, execution, { onThread: async () => assert.fail('no replay thread'), onTurn: async () => assert.fail('no replay turn'), onNative: async () => assert.fail('no replay SDK') })
    assert.deepEqual(replay, result); assert.deepEqual(readFileSync(join(nativeRoot, 'send.json')), before)
    for (const request of [{ prompt: prompt + ' changed', execution }, { prompt, execution: { ...execution, schema: { type: 'object' } } }]) await assert.rejects(zcodeStructuredTurn(realm, 'native', request.prompt, request.execution, { onThread: async () => assert.fail('no tampered replay thread'), onTurn: async () => assert.fail('no tampered replay turn'), onNative: async () => assert.fail('no tampered replay SDK') }), { code: 'stale_result' })
    writeFileSync(join(root, 'verified.json'), JSON.stringify({ result, replayAdditionalSends: 0, frozenReadProofPassed: true }), { mode: 0o600 })
  } catch (error) {
    const stop = await stopZCodeStructuredTurn(execution)
    writeFileSync(join(root, 'failure.json'), JSON.stringify({ code: (error as { code?: string }).code, message: (error as Error).message, stop }), { mode: 0o600 })
    throw error
  }
})
