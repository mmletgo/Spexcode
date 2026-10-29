import test from 'node:test'
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartToken, verifyDetachedRuntime } from '@spexcode/spec-core'
import { codexStructuredTurn } from './codex-harness.js'
import { freezeContext, frozenContextPrompt, frozenReadOutputTokenLimit, verifyFrozenReadProof, type FrozenReadReceipt } from './frozen-context.js'
import { assertFrozenReaderRuntime, prepareFrozenReaderRuntime, structuredGeneration, structuredExecutionPolicy, structuredRealmRoot, prepareStructuredRealm } from './session-structured-policy.js'

const nativeEvidence = process.env.SPEX_FROZEN_NATIVE_TEST === '1'
  ? realpathSync(process.env.SPEX_FROZEN_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'spex-frozen-native-'))) : undefined

for (const byteLength of [262_144, 2 * 1024 * 1024 + 113]) test(`actual native Codex sees random interior content across ${byteLength} nonempty frozen bytes and recovers exact history`, { skip: process.env.SPEX_FROZEN_NATIVE_TEST !== '1', timeout: 300_000 }, async () => {
  const evidence = join(nativeEvidence!, `bytes-${byteLength}`); mkdirSync(evidence, { recursive: true, mode: 0o700 })
  const source = join(evidence, 'source'); mkdirSync(source, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init', '-q', source])
  const markers = { first: `FIRST_${randomUUID()}`, middle: `MIDDLE_${randomUUID()}`, last: `LAST_${randomUUID()}` }
  const prose = 'The immutable review report preserves complete observations and original decisions for every required record.\n'
  const bytes = Buffer.from(prose.repeat(Math.ceil(byteLength / Buffer.byteLength(prose)))).subarray(0, byteLength)
  const middleOffset = Math.floor(byteLength / 262_144 / 2) * 262_144 + randomInt(90_000, 170_000)
  bytes.write(markers.first, 0); bytes.write(markers.middle, middleOffset); bytes.write(markers.last, bytes.length - markers.last.length)
  if (byteLength > 1024 * 1024) bytes.write('’', 1024 * 1024 - 1)
  writeFileSync(join(evidence, 'expected.json'), JSON.stringify({ markers, middleOffset, byteLength }, null, 2))
  writeFileSync(join(source, 'task.txt'), bytes)
  const ref = freezeContext({ directory: join(evidence, 'frozen'), sourceRoot: source, binding: { requestKey: 'real-native-probe', inputDigest: 'immutable-native-probe' }, entries: [{ id: 'task', label: 'task.txt snapshot', kind: 'utf8', bytes }] })
  // The model receives only the old frozen bytes, while its cwd now contains contradictory live content.
  writeFileSync(join(source, 'task.txt'), 'LIVE_SOURCE_MUST_NOT_BE_READ')
  writeFileSync(join(source, 'host-secret.txt'), `HOST_ONLY_${randomUUID()}`)
  const schema = { type: 'object', properties: { first: { type: 'string' }, middle: { type: 'string' }, last: { type: 'string' } }, required: ['first', 'middle', 'last'], additionalProperties: false }
  const prompt = `Read ALL bytes of every required unique entry via spex_read_frozen in consecutive ranges of 262144 bytes except the last shorter range. Make no extra reads or subdivisions. Continue from the response original endByte, never decodedEndByte. Coverage is checked by code from actual native history. You have no shell, file tools, network or live source. Return exactly the FIRST_, MIDDLE_, LAST_ random markers from the frozen snapshot, as first/middle/last JSON strings; if a marker is absent from the replies visible to you, return an empty string for it.\n${frozenContextPrompt(ref)}`
  const readerRuntime = await prepareFrozenReaderRuntime(join(evidence, 'reader-policy'), ref)
  const execution = structuredExecutionPolicy({ schema, inputDigest: 'immutable-native-probe', purpose: 'actual-native-frozen-proof', timeoutMs: 240_000, effort: 'low', model: process.env.SPEX_FROZEN_NATIVE_MODEL ?? 'gpt-6.1-sol', frozenContext: ref, readerRuntime })
  const realm = structuredRealmRoot(execution, join(evidence, 'realm'))!
  const { endpoint } = await structuredGeneration(realm, readerRuntime)
  writeFileSync(join(evidence, 'runtime-identity.json'), JSON.stringify({ endpoint, readerRuntime, pid: Number(readFileSync(endpoint.pidFile, 'utf8').trim()), separateRealmRoot: realm, source }, null, 2))
  const receipts: FrozenReadReceipt[] = []
  let threadId = '', turnId = ''
  try {
    const result = await codexStructuredTurn(endpoint.socketPath, source, prompt, execution, {
      onThread: async id => { threadId = id; writeFileSync(join(evidence, 'thread.json'), JSON.stringify({ threadId })) },
      onTurn: async id => { turnId = id; writeFileSync(join(evidence, 'identity.json'), JSON.stringify({ threadId, turnId })) },
      onFrozenRead: async receipt => { receipts.push(receipt); writeFileSync(join(evidence, 'receipts.json'), JSON.stringify(receipts, null, 2)) },
    })
    writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
    assert.deepEqual(JSON.parse(result.text), markers)
    assert.equal(receipts.length, Math.ceil(byteLength / 262_144))
    assert.ok(result.frozenReadProof)
    assert.equal(result.frozenReadProof.version, 2)
    assert.deepEqual(result.frozenReadProof.coveredEntryIds, ['task'])
    assert.equal(readerRuntime.version, 2)
    if (readerRuntime.version !== 2) assert.fail('current Native must use the visible-output capability')
    verifyFrozenReadProof(ref, result.frozenReadProof, { threadId, turnId }, readerRuntime.toolOutputTokenLimit)
    const recovered = await codexStructuredTurn(endpoint.socketPath, source, prompt, { ...execution, threadId, turnId }, {
      onThread: async () => assert.fail('recovery cannot start another thread'), onTurn: async id => assert.equal(id, turnId), onFrozenRead: async () => assert.fail('completed recovery cannot repeat a tool call'),
    })
    assert.deepEqual(recovered, result)
    writeFileSync(join(evidence, 'recovery.json'), JSON.stringify({ identical: true, threadId, turnId, additionalCalls: 0, bytes: bytes.length, receipts: receipts.length, coveredEntryIds: result.frozenReadProof.coveredEntryIds }, null, 2))
    console.log(`Actual native frozen proof: ${bytes.length} bytes, ${receipts.length} actual tool calls, exact completed recovery, evidence=${evidence}`)
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
