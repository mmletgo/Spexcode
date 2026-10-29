import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { processStartToken, verifyDetachedRuntime } from '@spexcode/spec-core'
import { codexStructuredTurn } from './codex-harness.js'
import { freezeContext, frozenContextPrompt, frozenReadOutputTokenLimit, prepareFrozenPrompt, readFrozenRange, verifyFrozenReadProof, FROZEN_READ_MAX_BYTES, type FrozenReadReceipt } from './frozen-context.js'
import { assertFrozenReaderRuntime, prepareFrozenReaderRuntime, structuredGeneration, structuredExecutionPolicy, structuredRealmRoot, prepareStructuredRealm } from './session-structured-policy.js'

const nativeEvidence = process.env.SPEX_FROZEN_NATIVE_TEST === '1'
  ? realpathSync(process.env.SPEX_FROZEN_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'spex-frozen-native-'))) : undefined

test('actual native multi-entry preparation reads required and requested optional bytes with BOM and exact recovery', { skip: process.env.SPEX_FROZEN_NATIVE_TEST !== '1', timeout: 300_000 }, async () => {
  const evidence = join(nativeEvidence!, 'multi-entry'); mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const source = join(evidence, 'source'); mkdirSync(source, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', source])
  const required = `REQUIRED_${randomUUID()}`, optional = `OPTIONAL_${randomUUID()}`
  const middle = `MIDDLE_${randomUUID()}`, last = `LAST_${randomUUID()}`
  const repeated = Buffer.from('Immutable required source observation.\n'.repeat(60000)).subarray(0, 2 * 1024 * 1024)
  repeated.write(middle, 1024 * 1024 + randomInt(90000, 170000))
  const requiredGroup = JSON.stringify({ 'required-source': required, 'large-mandatory-source': repeated.toString('utf8'), 'last-required-source': last })
  const expected = { required, optional, bom: true, middle, last }
  const request = { root: source, requestKey: 'native-multi-entry', inputDigest: 'native-multi-entry-input',
    prompt: 'Read every required entry by the index readBatches. Also read entry optional-used completely. Do not read optional-unused. Entry required is one JSON object grouping mandatory source strings by bodyRef; optional-used is a JSON-encoded string. Decode once, preserving BOM. Return the REQUIRED_ marker under required-source as required, OPTIONAL_ marker as optional, MIDDLE_ random marker inside large-mandatory-source as middle, LAST_ marker as last, and bom=true only if optional-used starts with U+FEFF. Use one exec per read batch, each tool result printed verbatim in a separate text item, and execMaxOutputTokens from the index for exec/wait. No shell or live files. Return only the structured JSON.',
    frozenEntries: [
      { id: 'required', label: 'changed source group', required: true, kind: 'utf8' as const, text: requiredGroup },
      { id: 'optional-used', label: 'requested related data', required: false, kind: 'utf8' as const, text: JSON.stringify(`\uFEFF中文🙂\r\n${optional}`).replace(/\uFEFF/g, '\\uFEFF') },
      { id: 'optional-unused', label: 'unrelated authorized data', required: false, kind: 'utf8' as const, text: JSON.stringify('UNUSED_MUST_NOT_BE_REQUIRED\n'.repeat(80000)) },
    ] }
  const prepared = prepareFrozenPrompt(request, { directory: join(evidence, 'frozen'), binding: { policyDigest: 'native-multi-entry-policy', attemptId: 'native-multi-entry-attempt' } })
  assert.equal('frozenEntries' in prepared, false)
  const ref = prepared.frozenContext!, readerRuntime = await prepareFrozenReaderRuntime(join(evidence, 'reader-policy'), ref)
  const schema = { type: 'object', properties: { required: { type: 'string' }, optional: { type: 'string' }, bom: { type: 'boolean' }, middle: { type: 'string' }, last: { type: 'string' } }, required: ['required', 'optional', 'bom', 'middle', 'last'], additionalProperties: false }
  const execution = structuredExecutionPolicy({ schema, inputDigest: request.inputDigest, purpose: 'actual-native-multi-entry', timeoutMs: 240_000, effort: 'low', model: process.env.SPEX_FROZEN_NATIVE_MODEL ?? 'gpt-6.1-sol', frozenContext: ref, readerRuntime })
  const realm = structuredRealmRoot(execution, join(evidence, 'realm'))!, { endpoint } = await structuredGeneration(realm, readerRuntime)
  writeFileSync(join(evidence, 'request.json'), JSON.stringify({ source, expected, frozenContext: ref, prompt: prepared.prompt, execution }, null, 2))
  writeFileSync(join(source, 'optional-used.txt'), 'CONTRADICTORY_LIVE_BYTES')
  let threadId = '', turnId = ''
  const receipts: FrozenReadReceipt[] = []
  try {
    const result = await codexStructuredTurn(endpoint.socketPath, source, prepared.prompt, execution, {
      onThread: async id => { threadId = id }, onTurn: async id => { turnId = id }, onFrozenRead: async receipt => { receipts.push(receipt) },
    })
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    assert.deepEqual(JSON.parse(result.text), expected)
    const proof = result.frozenReadProof!
    assert.equal(proof.version, 2)
    assert.deepEqual(proof.coveredEntryIds, ['required', 'optional-used'])
    verifyFrozenReadProof(ref, proof, { threadId, turnId }, readerRuntime.version === 2 ? readerRuntime.toolOutputTokenLimit : undefined)
    assert.equal(receipts.length, Math.ceil(Buffer.byteLength(requiredGroup) / FROZEN_READ_MAX_BYTES) + 1)
    assert.equal(receipts.some(receipt => receipt.arguments.entryId === 'optional-unused'), false)
    const recovered = await codexStructuredTurn(endpoint.socketPath, source, prepared.prompt, { ...execution, threadId, turnId }, {
      onThread: async () => assert.fail('recovery must not create another thread'), onTurn: async id => assert.equal(id, turnId), onFrozenRead: async () => assert.fail('recovery must not repeat reads'),
    })
    assert.deepEqual(recovered, result)
    writeFileSync(join(evidence, 'verified.json'), JSON.stringify({ expected, result, receipts, requiredEntries: ['required'], requiredGroupBytes: Buffer.byteLength(requiredGroup), unusedOptionalBytes: Buffer.byteLength(request.frozenEntries[2].text), exactRecovery: true, additionalCalls: 0 }, null, 2))
  } catch (error) {
    writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), threadId, turnId }, null, 2))
    throw error
  } finally {
    const pid = Number(readFileSync(endpoint.pidFile, 'utf8').trim()), receipt = verifyDetachedRuntime(pid, endpoint.receiptFile)
    assert.ok(receipt.ok, 'isolated test daemon identity must be proven before cleanup')
    assert.equal(processStartToken(pid), receipt.identity.startToken)
    process.kill(pid, 'SIGTERM')
  }
})

for (const byteLength of [FROZEN_READ_MAX_BYTES, 2 * FROZEN_READ_MAX_BYTES, 2 * 1024 * 1024 + 113]) test(`actual native Codex sees random interior content across ${byteLength} nonempty frozen bytes and recovers exact history`, { skip: process.env.SPEX_FROZEN_NATIVE_TEST !== '1', timeout: 300_000 }, async () => {
  const forceYield = byteLength === 2 * FROZEN_READ_MAX_BYTES
  const evidence = join(nativeEvidence!, `bytes-${byteLength}`); mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const source = join(evidence, 'source'); mkdirSync(source, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', source])
  const markers = { first: `FIRST_${randomUUID()}`, middle: `MIDDLE_${randomUUID()}`, last: `LAST_${randomUUID()}` }
  const prose = 'The immutable review report preserves complete observations and original decisions for every required record.\n'
  const bytes = Buffer.from(prose.repeat(Math.ceil(byteLength / Buffer.byteLength(prose)))).subarray(0, byteLength)
  const middleOffset = Math.floor(byteLength / FROZEN_READ_MAX_BYTES / 2) * FROZEN_READ_MAX_BYTES + randomInt(90_000, 170_000)
  bytes.write(markers.first, 0); bytes.write(markers.middle, middleOffset); bytes.write(markers.last, bytes.length - markers.last.length)
  if (byteLength > 1024 * 1024) bytes.write('’', 1024 * 1024 - 1)
  writeFileSync(join(evidence, 'expected.json'), JSON.stringify({ markers, middleOffset, byteLength, forceYield }, null, 2))
  writeFileSync(join(source, 'task.txt'), bytes)
  const ref = freezeContext({ directory: join(evidence, 'frozen'), sourceRoot: source, binding: { requestKey: 'real-native-probe', inputDigest: 'immutable-native-probe' }, entries: [{ id: 'task', label: 'task.txt snapshot', kind: 'utf8', bytes }] })
  const indexText = frozenContextPrompt(ref)
  const index = JSON.parse(indexText) as { toolOutputTokenLimit: number; execMaxOutputTokens: number; readBatches: { entryId: string; ranges: { startByte: number; endByte: number }[] }[] }
  // The model receives only the old frozen bytes, while its cwd now contains contradictory live content.
  writeFileSync(join(source, 'task.txt'), 'LIVE_SOURCE_MUST_NOT_BE_READ')
  writeFileSync(join(source, 'host-secret.txt'), `HOST_ONLY_${randomUUID()}`)
  const schema = { type: 'object', properties: { first: { type: 'string' }, middle: { type: 'string' }, last: { type: 'string' } }, required: ['first', 'middle', 'last'], additionalProperties: false }
  const prompt = `Read every required unique entry following the index readBatches exactly. Use one exec per planned batch with first-line // @exec: {"yield_time_ms": 10000, "max_output_tokens": execMaxOutputTokens}, call each listed range in order, and print each returned string unchanged with a separate text(await tools.spex_read_frozen(...)) call. Make no extra reads, subdivisions, joins, or wrappers. If exec returns Script running with cell ID, call wait({cell_id, yield_time_ms: 10000, max_tokens: execMaxOutputTokens}) and repeat with the same cell_id while still running. Do not reread or advance until the wait output is completed; the running marker is not source text. Continue from each response original endByte, never decodedEndByte. Coverage is checked by code from actual native history. You have no shell, file tools, network or live source. Return exactly the FIRST_, MIDDLE_, LAST_ random markers from the frozen snapshot, as first/middle/last JSON strings; if a marker is absent from the replies visible to you, return an empty string for it.\n${indexText}`
  const readerRuntime = await prepareFrozenReaderRuntime(join(evidence, 'reader-policy'), ref)
  const execution = structuredExecutionPolicy({ schema, inputDigest: 'immutable-native-probe', purpose: 'actual-native-frozen-proof', timeoutMs: 240_000, effort: 'low', model: process.env.SPEX_FROZEN_NATIVE_MODEL ?? 'gpt-6.1-sol', frozenContext: ref, readerRuntime })
  assert.equal(index.toolOutputTokenLimit, frozenReadOutputTokenLimit(ref))
  if (readerRuntime.version !== 2) assert.fail('native test requires the fixed v2 reader runtime')
  assert.equal(readerRuntime.toolOutputTokenLimit, index.toolOutputTokenLimit)
  assert.equal(index.execMaxOutputTokens, Math.ceil(index.toolOutputTokenLimit * 1.2))
  if (forceYield) {
    assert.equal(index.readBatches.length, 1)
    assert.deepEqual(index.readBatches[0]!.ranges, [{ startByte: 0, endByte: FROZEN_READ_MAX_BYTES }, { startByte: FROZEN_READ_MAX_BYTES, endByte: byteLength }])
  }
  const realm = structuredRealmRoot(execution, join(evidence, 'realm'))!
  const { endpoint } = await structuredGeneration(realm, readerRuntime)
  writeFileSync(join(evidence, 'runtime-identity.json'), JSON.stringify({ endpoint, readerRuntime, pid: Number(readFileSync(endpoint.pidFile, 'utf8').trim()), separateRealmRoot: realm, source }, null, 2))
  const receipts: FrozenReadReceipt[] = []
  let threadId = '', turnId = ''
  try {
    assert.match(readFileSync(join(realm, 'config/config.toml'), 'utf8'), new RegExp(`tool_output_token_limit\\s*=\\s*${index.toolOutputTokenLimit}`))
    const result = await codexStructuredTurn(endpoint.socketPath, source, prompt, execution, {
      onThread: async id => { threadId = id; writeFileSync(join(evidence, 'thread.json'), JSON.stringify({ threadId })) },
      onTurn: async id => { turnId = id; writeFileSync(join(evidence, 'identity.json'), JSON.stringify({ threadId, turnId })) },
      onFrozenRead: async receipt => {
        receipts.push(receipt); writeFileSync(join(evidence, 'receipts.json'), JSON.stringify(receipts, null, 2))
        if (forceYield && receipts.length === 1) {
          writeFileSync(join(evidence, 'yield.json'), JSON.stringify({ delayMs: 13_000, cellStatus: 'Script running with cell ID expected' }, null, 2))
          await new Promise(resolve => setTimeout(resolve, 13_000))
        }
      },
    })
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    assert.deepEqual(JSON.parse(result.text), markers)
    assert.equal(receipts.length, index.readBatches.reduce((count, batch) => count + batch.ranges.length, 0))
    assert.equal(receipts.length, Math.ceil(byteLength / FROZEN_READ_MAX_BYTES))
    const proof = result.frozenReadProof
    if (!proof || proof.version !== 2) assert.fail('current Native must use the visible-output capability')
    assert.deepEqual(proof.coveredEntryIds, ['task'])
    verifyFrozenReadProof(ref, proof, { threadId, turnId }, readerRuntime.toolOutputTokenLimit)
    const responseDirectory = join(dirname(ref.manifestPath), 'responses')
    const responseTexts = new Set<string>()
    for (const receipt of receipts) {
      const responseBytes = readFileSync(join(responseDirectory, receipt.responseDigest))
      assert.equal(createHash('sha256').update(responseBytes).digest('hex'), receipt.responseDigest)
      const response = JSON.parse(responseBytes.toString('utf8')) as ReturnType<typeof readFrozenRange>['response']
      assert.deepEqual(response, readFrozenRange(ref, receipt.arguments).response)
      responseTexts.add(response.contentItems[0]!.text)
    }
    const visible = JSON.parse(readFileSync(join(dirname(ref.manifestPath), 'histories', proof.visibilityDigest), 'utf8')) as { toolOutputTokenLimit: number; outputs: { historyTokenLimit: number; output: string | { type: string; text: string }[] }[] }
    assert.equal(visible.toolOutputTokenLimit, index.toolOutputTokenLimit)
    assert.equal(visible.outputs.length, forceYield ? 2 : Math.ceil(receipts.length / 2))
    if (byteLength === 2 * 1024 * 1024 + 113) assert.equal(visible.outputs.length, 5)
    const visibleTexts = new Set(visible.outputs.flatMap(output => typeof output.output === 'string' ? [output.output] : output.output.map(item => item.text)))
    for (const responseText of responseTexts) assert.ok(visibleTexts.has(responseText), 'every complete inner reply appears as a separate outer text item')
    for (const output of visible.outputs) assert.equal(output.historyTokenLimit, index.execMaxOutputTokens)
    if (forceYield) {
      const running = visible.outputs[0]!, completed = visible.outputs[1]!
      assert.equal(typeof running.output, 'string')
      if (typeof running.output !== 'string') assert.fail('a forced exec yield must remain a raw text string')
      assert.match(running.output, /Script running with cell ID/)
      assert.ok(Array.isArray(completed.output), 'the completed wait keeps its multiple text items as an array')
      if (!Array.isArray(completed.output)) assert.fail('the completed wait must expose structured text items')
      assert.equal(completed.output.filter(item => responseTexts.has(item.text)).length, 2, 'both full inner replies arrive together in one completed wait output')
      const sessions = join(realm, 'data/codex-home/sessions')
      const rolloutPath = readdirSync(sessions, { recursive: true, encoding: 'utf8' }).find(path => path.endsWith('.jsonl') && readFileSync(join(sessions, path), 'utf8').includes(`"session_id":"${threadId}"`))
      if (!rolloutPath) assert.fail('the isolated exact thread rollout must be available for wait argument verification')
      let currentTurn = ''
      const waitCalls = readFileSync(join(sessions, rolloutPath), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string; name?: string; call_id?: string; arguments?: string } }).filter(record => {
        const payload = record.payload
        if (record.type === 'turn_context' || record.type === 'event_msg' && payload?.type === 'task_started') currentTurn = payload?.turn_id ?? ''
        const ownsWait = currentTurn === turnId && record.type === 'response_item' && payload?.type === 'function_call' && payload.name === 'wait'
        if (record.type === 'event_msg' && payload?.type === 'task_complete' && payload.turn_id === turnId) currentTurn = ''
        return ownsWait
      })
      assert.equal(waitCalls.length, 1)
      const waitArguments = JSON.parse(waitCalls[0]!.payload!.arguments!) as { cell_id: string; yield_time_ms: number; max_tokens: number }
      const cellId = /Script running with cell ID ([^\n]+)/.exec(running.output)![1]!
      assert.deepEqual(waitArguments, { cell_id: cellId, yield_time_ms: 10_000, max_tokens: index.execMaxOutputTokens })
      writeFileSync(join(evidence, 'yield.json'), JSON.stringify({ delayMs: 13_000, runningMarkerPreserved: true, completedWaitOutputCount: completed.output.length, pairedInnerReplies: 2, historyTokenLimit: completed.historyTokenLimit }, null, 2))
    }
    const recovered = await codexStructuredTurn(endpoint.socketPath, source, prompt, { ...execution, threadId, turnId }, {
      onThread: async () => assert.fail('recovery cannot start another thread'), onTurn: async id => assert.equal(id, turnId), onFrozenRead: async () => assert.fail('completed recovery cannot repeat a tool call'),
    })
    assert.deepEqual(recovered, result)
    writeFileSync(join(evidence, 'recovery.json'), JSON.stringify({ identical: true, threadId, turnId, additionalCalls: 0, bytes: bytes.length, innerCalls: receipts.length, outerCalls: visible.outputs.length, forcedYield: forceYield, coveredEntryIds: proof.coveredEntryIds }, null, 2))
    console.log(`Actual native frozen proof: ${bytes.length} bytes, ${receipts.length} inner reads in ${visible.outputs.length} outer calls, forcedYield=${forceYield}, exact completed recovery, evidence=${evidence}`)
  } catch (error) {
    writeFileSync(join(evidence, 'failure.json'), JSON.stringify({ message: error instanceof Error ? error.message : String(error), threadId, turnId }, null, 2))
    throw error
  } finally {
    // This realm was created exclusively by this test, never the product's shared native realm.
    const pid = Number(readFileSync(endpoint.pidFile, 'utf8').trim()), receipt = verifyDetachedRuntime(pid, endpoint.receiptFile)
    assert.ok(receipt.ok, 'isolated test daemon identity must be proven before cleanup')
    assert.equal(processStartToken(pid), receipt.identity.startToken)
    process.kill(pid, 'SIGTERM')
  }
})

test('frozen native capability identity rejects changed CLI, catalog digest and catalog bytes', { skip: process.env.SPEX_FROZEN_NATIVE_TEST !== '1' }, async () => {
  const evidence = nativeEvidence!
  const source = join(evidence, 'capability-source'); mkdirSync(source, { recursive: true, mode: 0o700 })
  const ref = freezeContext({ directory: join(evidence, 'capability-frozen'), sourceRoot: source, binding: { requestKey: 'capability', inputDigest: 'capability' }, entries: [{ id: 'task', label: 'capability', kind: 'utf8', bytes: Buffer.from('native capability') }] })
  const runtime = await prepareFrozenReaderRuntime(join(evidence, 'reader-policy'), ref)
  assert.equal(runtime.version, 2)
  assert.deepEqual(await prepareFrozenReaderRuntime(join(evidence, 'reader-policy'), ref), runtime)
  if (runtime.version !== 2) assert.fail('new frozen reader must bind its output budget')
  assert.throws(() => assertFrozenReaderRuntime({ ...runtime, toolOutputTokenLimit: runtime.toolOutputTokenLimit + 1 }, undefined, frozenReadOutputTokenLimit(ref)), /identity differs/)
  const legacy = { version: 1 as const, cliVersion: runtime.cliVersion, catalogDigest: runtime.catalogDigest, catalogPath: runtime.catalogPath }
  assertFrozenReaderRuntime(legacy)
  const policy = structuredExecutionPolicy({ schema: { type: 'object' }, inputDigest: 'capability', purpose: 'capability', timeoutMs: 1000, frozenContext: ref, readerRuntime: runtime })
  const oldPolicy = { ...policy, readerRuntime: legacy }
  assert.notEqual(JSON.stringify(policy), JSON.stringify(oldPolicy))
  assert.notEqual(structuredRealmRoot(policy, evidence), structuredRealmRoot(oldPolicy, evidence))
  const oldRealm = structuredRealmRoot(oldPolicy, evidence)!
  prepareStructuredRealm(oldRealm, legacy)
  const oldConfig = readFileSync(join(oldRealm, 'config/config.toml'), 'utf8')
  assert.equal(oldConfig.includes('tool_output_token_limit'), false)
  prepareStructuredRealm(oldRealm, legacy)
  assert.equal(readFileSync(join(oldRealm, 'config/config.toml'), 'utf8'), oldConfig)
  assert.throws(() => assertFrozenReaderRuntime({ ...runtime, cliVersion: 'unverified-cli' }), /identity differs/)
  assert.throws(() => assertFrozenReaderRuntime({ ...runtime, catalogDigest: '0'.repeat(64) }), /identity differs/)
  assert.throws(() => assertFrozenReaderRuntime(runtime, 'unregistered-fallback-model'), /absent from/)
  const directory = mkdtempSync(join(tmpdir(), 'spex-reader-catalog-tamper-')), catalogPath = join(directory, 'catalog.json')
  try {
    writeFileSync(catalogPath, readFileSync(runtime.catalogPath)); assertFrozenReaderRuntime({ ...runtime, catalogPath })
    writeFileSync(catalogPath, '{"models":[]}')
    assert.throws(() => assertFrozenReaderRuntime({ ...runtime, catalogPath }), /identity differs/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
