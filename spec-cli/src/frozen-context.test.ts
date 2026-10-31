import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertFrozenBinding, freezeContext, frozenContextPrompt, frozenReadOutputTokenLimit, frozenReadTool, frozenVisibleOutputs, persistFrozenRead, prepareFrozenPrompt, proveFrozenReads, readFrozenManifest, readFrozenRange, verifyFrozenReadProof, claudeMessageDigest, readClaudePublicHistory, readClaudeApiSourceMetadata, FROZEN_READ_MAX_BYTES, type FrozenContextInput, type FrozenNativeItem, type FrozenVisibleOutput } from './frozen-context.js'

const binding = { requestKey: 'exact-request', inputDigest: 'exact-input' }
function fixture(entries: FrozenContextInput[] = [{ id: 'a', label: 'frozen source', kind: 'utf8', bytes: Buffer.from('首abc尾') }]) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-frozen-test-'))
  const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding, entries })
  const args = (startByte: number, endByte: number, entryId = 'a') => ({ contextDigest: ref.contextDigest, entryId, startByte, endByte })
  const item = (start: number, end: number, id: string, entryId = 'a'): FrozenNativeItem => ({ type: 'dynamicToolCall', id, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true, arguments: args(start, end, entryId), contentItems: readFrozenRange(ref, args(start, end, entryId)).response.contentItems })
  return { ref, directory, args, item, close: () => rmSync(directory, { recursive: true, force: true }) }
}
const identity = { threadId: 'exact-thread', turnId: 'exact-turn' }

test('已停source索引只重建精确输出上限续行，原公开投影与hash不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-claude-source-recovery-'))
  try {
    const text = 'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.'
    const original = { role: 'user', content: [{ type: 'text', text: 'original' }] }, recovery = { role: 'user', content: text }, normalized = { role: 'user', content: [{ type: 'text', text }] }
    const rows = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: original },
      { type: 'api-request-shape', sessionId: 'session', shapeHash: 'a'.repeat(64), shape: { tools: [] } },
      { type: 'api-request', sessionId: 'session', id: 'request', shapeHash: 'a'.repeat(64), keep: 0, tail: [claudeMessageDigest(original)], params: { model: 'model' } },
      { type: 'assistant', sessionId: 'session', uuid: 'interrupted', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [], stop_reason: 'max_tokens' } },
      { type: 'user', sessionId: 'session', uuid: 'recovery', parentUuid: 'interrupted', promptId: 'prompt', isMeta: true, turnCompanion: true, message: recovery },
      { type: 'api-request', sessionId: 'session', id: 'next', shapeHash: 'a'.repeat(64), base: 'request', keep: 1, tail: [claudeMessageDigest(normalized)], params: { model: 'model' } },
    ]
    const path = join(directory, 'history.jsonl'), bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    writeFileSync(path, bytes)
    const before = JSON.stringify(readClaudePublicHistory(path, 'session'))
    assert.deepEqual(readClaudeApiSourceMetadata(path, 'session', 'model').get('next')!.messages.get(claudeMessageDigest(normalized))!.sourceUuids, ['recovery'])
    assert.equal(JSON.stringify(readClaudePublicHistory(path, 'session')), before)
    assert.equal(readFileSync(path, 'utf8'), bytes)
    for (const invalid of [{ ...rows[4], promptId: 'foreign' }, { ...rows[4], message: { role: 'user', content: text + ' ' } }, { ...rows[4], sourceToolAssistantUUID: 'interrupted' }]) {
      writeFileSync(path, [...rows.slice(0, 4), invalid, rows[5]].map(row => JSON.stringify(row)).join('\n') + '\n')
      assert.throws(() => readClaudeApiSourceMetadata(path, 'session', 'model'), { code: 'stale_result' })
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('model-visible frozen proof rejects inner-only coverage, cropped or wrapped replies and history budget borrowing', () => {
  const f = fixture()
  try {
    const item = f.item(0, 9, 'inner'), text = readFrozenRange(f.ref, f.args(0, 9)).response.contentItems[0].text
    const limit = frozenReadOutputTokenLimit(f.ref), historyTokenLimit = Math.ceil(limit * 1.2)
    const outer: FrozenVisibleOutput = { callId: 'outer', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text }], historyTokenLimit }
    const legacy = proveFrozenReads(f.ref, identity, [item])
    const proof = proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [outer] })
    assert.equal(proof.version, 2)
    assert.equal(proof.historyDigest, legacy.historyDigest, 'original native history bytes remain unchanged')
    const arrayEvidence = readFileSync(join(dirname(f.ref.manifestPath), 'histories', proof.visibilityDigest))
    const legacyArrayBytes = Buffer.from(JSON.stringify({ ...identity, toolOutputTokenLimit: limit, outputs: [outer] }), 'utf8')
    assert.deepEqual(arrayEvidence, legacyArrayBytes, 'an existing input_text array proof keeps its original visibility bytes')
    assert.equal(createHash('sha256').update(arrayEvidence).digest('hex'), proof.visibilityDigest)
    verifyFrozenReadProof(f.ref, proof, identity, limit)
    verifyFrozenReadProof(f.ref, legacy, identity)
    assert.throws(() => verifyFrozenReadProof(f.ref, legacy, identity, limit), /requires.*v2/)
    for (const displayed of [text.slice(0, 60), JSON.stringify(text), 'Read all 9 bytes']) {
      assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [{ ...outer, output: [{ type: 'input_text', text: displayed }] }] }), /not returned verbatim/)
    }
    const stringProof = proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [{ ...outer, output: text }] })
    assert.equal(stringProof.version, 2)
    const stringEvidence = readFileSync(join(dirname(f.ref.manifestPath), 'histories', stringProof.visibilityDigest), 'utf8')
    assert.deepEqual(JSON.parse(stringEvidence).outputs, [{ ...outer, output: text }], 'a raw text output keeps its native string shape in the visibility CAS')
    verifyFrozenReadProof(f.ref, stringProof, identity, limit)
    persistFrozenRead(f.ref, { ...identity, callId: 'local-only-receipt' }, f.args(0, 9))
    assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [{ ...outer, output: 'Script running with cell ID cell-1' }] }), /not returned verbatim/, 'a status string and saved local response cannot replace a visible full response')
    assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [{ ...outer, output: 'x'.repeat(historyTokenLimit * 4 + 1) }] }), /actual fixed history budget/, 'raw string bytes consume the same outer budget')
    assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [
      { ...outer, callId: 'large-budget-other-call', historyTokenLimit: historyTokenLimit + 10000, output: [] },
      { ...outer, historyTokenLimit: 1 },
    ] }), /actual fixed history budget/)
    assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: limit, outputs: [{ ...outer, output: [{ type: 'input_text', text: 'x'.repeat(historyTokenLimit * 4) }, { type: 'input_text', text }] }] }), /actual fixed history budget/, 'headers and every other outer item consume the same budget')
    const restored = JSON.parse(JSON.stringify(proof))
    restored.version = undefined
    assert.throws(() => verifyFrozenReadProof(f.ref, restored, identity, limit), /requires.*v2/)
  } finally { f.close() }
})

test('visible exec and wait history pairs exact call outputs within explicit native turn boundaries', () => {
  const record = (type: string, payload: unknown, metadata?: unknown) => JSON.stringify({ type, payload, ...(metadata ? { metadata } : {}) }) + '\n'
  const call = (id: string) => record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id })
  const waitCall = (id: string) => record('response_item', { type: 'function_call', name: 'wait', call_id: id })
  const output = (id: string, text: string, limit = 12000) => record('response_item', { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }] }, { fallback_token_limit_override: limit })
  const stringOutput = (id: string, text: string, limit = 12000) => record('response_item', { type: 'custom_tool_call_output', call_id: id, output: text }, { fallback_token_limit_override: limit })
  const waitOutput = (id: string, text: string, limit = 12000) => record('response_item', { type: 'function_call_output', call_id: id, output: text }, { fallback_token_limit_override: limit })
  const start = (id: string) => record('turn_context', { turn_id: id })
  const done = (id: string) => record('event_msg', { type: 'task_complete', turn_id: id })
  const native = start('other') + call('foreign') + output('foreign', 'foreign-full-body') + done('other') + start('target') + call('owned') + stringOutput('owned', 'Script running with cell ID cell-1') + done('target')
  assert.deepEqual(frozenVisibleOutputs(native, 'target'), [{ callId: 'owned', output: 'Script running with cell ID cell-1', historyTokenLimit: 12000 }])
  assert.deepEqual(frozenVisibleOutputs(start('target') + waitCall('waiting') + waitOutput('waiting', 'resumed output') + done('target'), 'target'), [{ callId: 'waiting', output: 'resumed output', historyTokenLimit: 12000 }])
  assert.deepEqual(frozenVisibleOutputs(start('target') + call('owned') + output('owned', 'actual-body') + done('target'), 'target'), [{ callId: 'owned', output: [{ type: 'input_text', text: 'actual-body' }], historyTokenLimit: 12000 }])
  assert.throws(() => frozenVisibleOutputs(start('target') + output('foreign', 'body') + done('target'), 'target'), /exact exec\/wait call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + done('target'), 'target'), /without its output/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + output('owned', 'body') + output('owned', 'body') + done('target'), 'target'), /exact exec\/wait call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + waitOutput('owned', 'body') + done('target'), 'target'), /exact exec\/wait call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + record('response_item', { type: 'function_call', name: 'foreign', call_id: 'foreign' }) + waitOutput('foreign', 'body') + done('target'), 'target'), /invalid or repeated host call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + record('response_item', { type: 'custom_tool_call_output', call_id: 'owned', output: [{ type: 'image', data: 'hidden' }] }, { fallback_token_limit_override: 12000 }) + done('target'), 'target'), /exact exec\/wait call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + record('response_item', { type: 'custom_tool_call_output', call_id: 'owned', output: [{ type: 'unknown', text: 'hidden' }] }, { fallback_token_limit_override: 12000 }) + done('target'), 'target'), /exact exec\/wait call/)
  assert.throws(() => frozenVisibleOutputs(start('target') + call('owned') + output('owned', 'body'), 'target'), /not persisted.*completed/)
})

test('a foreign turn string cannot lend a frozen response to a visible running-cell marker', () => {
  const f = fixture()
  try {
    const args = f.args(0, 9), item = f.item(0, 9, 'inner')
    const sourceText = readFrozenRange(f.ref, args).response.contentItems[0].text
    const record = (type: string, payload: unknown, metadata?: unknown) => JSON.stringify({ type, payload, ...(metadata ? { metadata } : {}) }) + '\n'
    const call = (id: string) => record('response_item', { type: 'custom_tool_call', name: 'exec', call_id: id })
    const output = (id: string, text: string) => record('response_item', { type: 'custom_tool_call_output', call_id: id, output: text }, { fallback_token_limit_override: 12_000 })
    const start = (turnId: string) => record('turn_context', { turn_id: turnId })
    const done = (turnId: string) => record('event_msg', { type: 'task_complete', turn_id: turnId })
    const rollout = start('foreign-turn') + call('foreign-call') + output('foreign-call', sourceText) + done('foreign-turn')
      + start(identity.turnId) + call('exact-call') + output('exact-call', 'Script running with cell ID cell-1') + done(identity.turnId)
    const outputs = frozenVisibleOutputs(rollout, identity.turnId)
    assert.deepEqual(outputs.map(outer => outer.output), ['Script running with cell ID cell-1'])
    assert.throws(() => proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit: frozenReadOutputTokenLimit(f.ref), outputs }), /not returned verbatim/)
  } finally { f.close() }
})

test('frozen manifest binds request and immutable bytes without exposing control paths to the model', () => {
  const f = fixture()
  try {
    assertFrozenBinding(f.ref, binding)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, requestKey: 'foreign' }), /requestKey/)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, inputDigest: 'foreign' }), /inputDigest/)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, attemptId: 'invented' }), /attemptId/)
    assert.equal(frozenContextPrompt(f.ref).includes(f.directory), false)
    const index = JSON.parse(frozenContextPrompt(f.ref)) as { toolOutputTokenLimit: number; execMaxOutputTokens: number; readBatches: { entryId: string; ranges: { startByte: number; endByte: number }[] }[] }
    assert.equal(index.toolOutputTokenLimit, frozenReadOutputTokenLimit(f.ref))
    assert.equal(index.execMaxOutputTokens, Math.ceil(index.toolOutputTokenLimit * 1.2))
    assert.deepEqual(index.readBatches, [{ entryId: 'a', ranges: [{ startByte: 0, endByte: 9 }] }])
    const read = readFrozenRange(f.ref, f.args(0, 3))
    assert.equal(JSON.parse(read.response.contentItems[0].text).text, '首')
    const persisted = persistFrozenRead(f.ref, { ...identity, callId: 'native-call' }, f.args(0, 9))
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(f.ref.manifestPath), 'responses', persisted.receipt.responseDigest), 'utf8')), persisted.response)
    assert.equal(JSON.parse(readFrozenRange(f.ref, f.args(1, 3)).response.contentItems[0].text).text, '首')
    assert.throws(() => readFrozenRange(f.ref, { ...f.args(0, 3), path: '/etc/passwd' }), /argument shape/)
    assert.throws(() => readFrozenRange(f.ref, { ...f.args(0, 3), contextDigest: 'wrong' }), /identity/)
    assert.throws(() => readFrozenRange(f.ref, f.args(0, 10)), /range/)
    assert.throws(() => readFrozenRange(f.ref, f.args(0, 3, 'foreign')), /entry/)
  } finally { f.close() }
})

test('UTF8 byte cuts expand only decoding while exact requested ranges and legacy response hashes stay fixed', () => {
  const original = '甲🙂乙🌍丙', bytes = Buffer.from(original, 'utf8')
  const f = fixture([{ id: 'a', label: 'frozen source', kind: 'utf8', bytes }])
  const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
  const boundaries = [0]
  for (const character of original) boundaries.push(boundaries.at(-1)! + Buffer.byteLength(character))
  try {
    for (let startByte = 0; startByte < bytes.length; startByte++) for (let endByte = startByte + 1; endByte <= bytes.length; endByte++) {
      const args = f.args(startByte, endByte), actual = readFrozenRange(f.ref, args)
      const decoded = JSON.parse(actual.response.contentItems[0].text) as { text: string; startByte: number; endByte: number; rangeSha256: string; decodedStartByte?: number; decodedEndByte?: number }
      const expectedStart = boundaries.filter(value => value <= startByte).at(-1)!, expectedEnd = boundaries.find(value => value >= endByte)!
      assert.deepEqual(actual.arguments, args)
      assert.equal(decoded.startByte, startByte); assert.equal(decoded.endByte, endByte)
      assert.equal(decoded.rangeSha256, sha(bytes.subarray(startByte, endByte)))
      assert.equal(decoded.text, bytes.subarray(expectedStart, expectedEnd).toString('utf8'))
      assert.ok(startByte - expectedStart <= 3 && expectedEnd - endByte <= 3)
      if (expectedStart === startByte && expectedEnd === endByte) {
        assert.equal(Object.hasOwn(decoded, 'decodedStartByte'), false); assert.equal(Object.hasOwn(decoded, 'decodedEndByte'), false)
        const text = JSON.stringify({ ...args, kind: 'utf8', sha256: sha(bytes), byteLength: bytes.length, rangeSha256: sha(bytes.subarray(startByte, endByte)), text: bytes.subarray(startByte, endByte).toString('utf8') })
        const legacy = { contentItems: [{ type: 'inputText', text }], success: true }
        assert.equal(JSON.stringify(actual.response), JSON.stringify(legacy), 'aligned persisted response remains byte-for-byte identical')
        assert.equal(persistFrozenRead(f.ref, { ...identity, callId: `legacy-${startByte}-${endByte}` }, args).receipt.responseDigest, sha(JSON.stringify(legacy)))
      } else {
        assert.equal(decoded.decodedStartByte, expectedStart); assert.equal(decoded.decodedEndByte, expectedEnd)
      }
    }
    for (let cut = 1; cut < bytes.length; cut++) {
      const proof = proveFrozenReads(f.ref, identity, [f.item(0, cut, 'left'), f.item(cut, bytes.length, 'right')])
      assert.deepEqual(proof.coveredEntryIds, ['a']); verifyFrozenReadProof(f.ref, proof, identity)
    }
    const everyByte = Array.from({ length: bytes.length }, (_, index) => f.item(index, index + 1, `byte-${index}`))
    assert.deepEqual(proveFrozenReads(f.ref, identity, everyByte).coveredEntryIds, ['a'])
    assert.throws(() => proveFrozenReads(f.ref, identity, everyByte.filter((_, index) => index !== 1)), /not completely read/, 'overlapping decoded text cannot conceal a missing requested byte')
  } finally { f.close() }
})

test('expanded UTF8 reads retain BOM codepoints while aligned legacy decoding stays byte-identical', () => {
  const original = '\uFEFF甲🙂', bytes = Buffer.from(original, 'utf8')
  const f = fixture([{ id: 'a', label: 'frozen source', kind: 'utf8', bytes }])
  try {
    const cut = JSON.parse(readFrozenRange(f.ref, f.args(1, 2)).response.contentItems[0].text) as { text: string; decodedStartByte: number; decodedEndByte: number }
    assert.equal(cut.text, '\uFEFF', 'an expanded BOM codepoint must not disappear during decoding')
    assert.equal(cut.decodedStartByte, 0); assert.equal(cut.decodedEndByte, 3)
    assert.equal(JSON.parse(readFrozenRange(f.ref, f.args(1, 8)).response.contentItems[0].text).text, original)
    const args = f.args(0, bytes.length), sha = createHash('sha256').update(bytes).digest('hex')
    const text = JSON.stringify({ ...args, kind: 'utf8', sha256: sha, byteLength: bytes.length, rangeSha256: sha, text: '甲🙂' })
    const legacy = { contentItems: [{ type: 'inputText', text }], success: true }
    assert.equal(JSON.stringify(readFrozenRange(f.ref, args).response), JSON.stringify(legacy))
    assert.equal(persistFrozenRead(f.ref, { ...identity, callId: 'legacy-bom' }, args).receipt.responseDigest, createHash('sha256').update(JSON.stringify(legacy)).digest('hex'))
  } finally { f.close() }
})

test('frozen output budget contains worst JSON escapes, expanded UTF8, binary and actual long entry identities', () => {
  const longId = '"\\\u0000🙂'.repeat(20_000)
  const f = fixture([
    { id: longId, label: 'escaped controls', kind: 'utf8', bytes: Buffer.alloc(FROZEN_READ_MAX_BYTES + 6) },
    { id: 'utf8', label: 'expanded characters', kind: 'utf8', bytes: Buffer.from('🙂'.repeat(FROZEN_READ_MAX_BYTES / 4 + 2)) },
    { id: 'binary', label: 'binary', kind: 'binary', bytes: Buffer.alloc(FROZEN_READ_MAX_BYTES + 1, 0xff) },
    { id: 'absent', label: 'absent', kind: 'absent' },
  ])
  try {
    const limit = frozenReadOutputTokenLimit(f.ref)
    for (const [entryId, start, end] of [[longId, 0, FROZEN_READ_MAX_BYTES], ['utf8', 1, FROZEN_READ_MAX_BYTES + 1], ['binary', 0, FROZEN_READ_MAX_BYTES], ['absent', 0, 0]] as const) {
      const text = readFrozenRange(f.ref, f.args(start, end, entryId)).response.contentItems[0].text
      assert.ok(Math.ceil(Buffer.byteLength(text) / 4) <= limit, 'Codex must retain every complete inputText before its additional allowance')
    }
    const short = fixture([{ id: 'task', label: 'short', kind: 'utf8', bytes: Buffer.from('short') }])
    try { assert.ok(frozenReadOutputTokenLimit(short.ref) < limit, 'the budget follows actual frozen metadata instead of an arbitrary identity cap') }
    finally { short.close() }
  } finally { f.close() }
})

test('frozen read batches pair only within the unchanged history budget and preserve unique required coverage', () => {
  const bytes = Buffer.from('x'.repeat(FROZEN_READ_MAX_BYTES * 2 + 13))
  const f = fixture([
    { id: 'required', label: 'large required source', kind: 'utf8', bytes },
    { id: 'required-alias', label: 'same required bytes', kind: 'utf8', bytes },
    { id: 'optional', label: 'optional source', kind: 'utf8', bytes: Buffer.from('optional bytes'), required: false },
    { id: 'absent', label: 'absent source', kind: 'absent' },
  ])
  try {
    const index = JSON.parse(frozenContextPrompt(f.ref)) as { toolOutputTokenLimit: number; execMaxOutputTokens: number; readBatches: { entryId: string; ranges: { startByte: number; endByte: number }[] }[] }
    assert.equal(index.toolOutputTokenLimit, frozenReadOutputTokenLimit(f.ref))
    assert.equal(index.execMaxOutputTokens, Math.ceil(index.toolOutputTokenLimit * 1.2))
    assert.deepEqual(index.readBatches.map(batch => batch.entryId), ['required', 'required', 'absent'])
    assert.deepEqual(index.readBatches.map(batch => batch.ranges.length), [2, 1, 1])
    let call = 0
    const items: FrozenNativeItem[] = []
    for (const batch of index.readBatches) {
      assert.ok(batch.ranges.length <= 2)
      let cost = 0
      for (let index = 0; index < batch.ranges.length; index++) {
        const range = batch.ranges[index]!
        const text = readFrozenRange(f.ref, f.args(range.startByte, range.endByte, batch.entryId)).response.contentItems[0].text
        cost += Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
        items.push(f.item(range.startByte, range.endByte, `planned-${call++}`, batch.entryId))
        if (index > 0) assert.equal(batch.ranges[index - 1]!.endByte, range.startByte, 'paired requested ranges are adjacent')
        assert.ok(range.endByte - range.startByte <= FROZEN_READ_MAX_BYTES)
      }
      assert.ok(cost <= index.toolOutputTokenLimit)
    }
    assert.equal(JSON.parse(readFrozenRange(f.ref, f.args(0, 1, 'optional')).response.contentItems[0].text).text, 'o', 'optional entries remain readable on demand')
    const proof = proveFrozenReads(f.ref, identity, items)
    assert.deepEqual(proof.coveredEntryIds, ['required', 'required-alias', 'absent'])
    verifyFrozenReadProof(f.ref, proof, identity)
  } finally { f.close() }
})

test('frozen read plan falls back to a single range when paired actual replies exceed the current budget', () => {
  const entryId = 'i'.repeat(FROZEN_READ_MAX_BYTES * 4 + 4096)
  const f = fixture([{ id: entryId, label: 'large identity', kind: 'utf8', bytes: Buffer.alloc(FROZEN_READ_MAX_BYTES * 2, 0x78) }])
  try {
    const index = JSON.parse(frozenContextPrompt(f.ref)) as { toolOutputTokenLimit: number; readBatches: { entryId: string; ranges: { startByte: number; endByte: number }[] }[] }
    assert.equal(index.readBatches.length, 2)
    assert.deepEqual(index.readBatches.map(batch => batch.ranges.length), [1, 1])
    const pairCost = index.readBatches.reduce((sum, batch) => {
      const range = batch.ranges[0]!
      const text = readFrozenRange(f.ref, f.args(range.startByte, range.endByte, batch.entryId)).response.contentItems[0].text
      return sum + Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
    }, 0)
    assert.ok(pairCost > index.toolOutputTokenLimit, 'the two actual serialized responses cannot share one batch')
  } finally { f.close() }
})

test('UTF8 display end is never the next requested cursor at the real one-MiB cut', () => {
  const bytes = Buffer.from('x'.repeat(1_048_575) + '’尾')
  const f = fixture([{ id: 'a', label: 'cursor regression', kind: 'utf8', bytes }])
  try {
    const prefix = [0, 262_144, 524_288, 786_432].map(start => f.item(start, start + FROZEN_READ_MAX_BYTES, `prefix-${start}`))
    const reply = JSON.parse((prefix.at(-1)!.contentItems as { text: string }[])[0].text) as { endByte: number; decodedEndByte: number }
    assert.equal(reply.endByte, 1_048_576); assert.equal(reply.decodedEndByte, 1_048_578)
    assert.throws(() => proveFrozenReads(f.ref, identity, [...prefix, f.item(reply.decodedEndByte, bytes.length, 'wrong-cursor')]), /not completely read/)
    assert.deepEqual(proveFrozenReads(f.ref, identity, [...prefix, f.item(reply.endByte, bytes.length, 'original-cursor')]).coveredEntryIds, ['a'])
    assert.match(frozenReadTool.description, /original endByte/)
    assert.match(frozenReadTool.description, /never cursors/)
  } finally { f.close() }
})

test('literal truncation warnings remain source data and saved visible proof tampering is rejected', () => {
  const f = fixture([{ id: 'a', label: 'literal warning text', kind: 'utf8', bytes: Buffer.from('Warning: truncated output is a literal source sentence.') }])
  try {
    const length = readFrozenManifest(f.ref).entries[0].byteLength, item = f.item(0, length, 'read')
    const text = (item.contentItems as { text: string }[])[0].text, toolOutputTokenLimit = frozenReadOutputTokenLimit(f.ref)
    const outer: FrozenVisibleOutput = { callId: 'exec', historyTokenLimit: Math.ceil(toolOutputTokenLimit * 1.2), output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text }] }
    const legacy = proveFrozenReads(f.ref, identity, [item]), legacyBytes = JSON.stringify(legacy)
    const proof = proveFrozenReads(f.ref, identity, [item], { toolOutputTokenLimit, outputs: [outer] })
    assert.equal(proof.version, 2)
    verifyFrozenReadProof(f.ref, proof, identity)
    assert.equal(JSON.stringify(proveFrozenReads(f.ref, identity, [item])), legacyBytes)
    assert.equal(proof.version, 2)
    if (proof.version !== 2) assert.fail('visible proof must carry its version')
    const path = join(dirname(f.ref.manifestPath), 'histories', proof.visibilityDigest)
    chmodSync(path, 0o600); writeFileSync(path, 'tampered public output')
    assert.throws(() => verifyFrozenReadProof(f.ref, proof, identity), /visible.*digest/)
  } finally { f.close() }
})

test('coverage merges duplicate and out-of-order intervals but refuses gaps, false results and duplicate call identities', () => {
  const f = fixture()
  try {
    const items = [f.item(6, 9, 'tail'), f.item(0, 6, 'head'), f.item(0, 3, 'duplicate-range')]
    const proof = proveFrozenReads(f.ref, identity, items)
    assert.deepEqual(proof.coveredEntryIds, ['a'])
    assert.equal(proof.receipts.length, 3)
    verifyFrozenReadProof(f.ref, proof, identity)
    assert.throws(() => verifyFrozenReadProof(f.ref, { ...proof, coveredEntryIds: [] }, identity), /coverage differs/)
    assert.throws(() => verifyFrozenReadProof(f.ref, proof, { ...identity, turnId: 'foreign-turn' }), /exact context\/thread\/turn/)
    assert.throws(() => proveFrozenReads(f.ref, identity, [items[0], items[2]]), /not completely read/)
    assert.throws(() => proveFrozenReads(f.ref, identity, [...items, items[0]]), /invalid, pending or foreign/)
    assert.throws(() => proveFrozenReads(f.ref, identity, [{ ...f.item(0, 9, 'call'), contentItems: [{ type: 'inputText', text: 'claimed read' }] }]), /result bytes/)
    for (const change of [{ status: 'inProgress' }, { success: false }, { tool: 'shell' }, { namespace: 'foreign' }])
      assert.throws(() => proveFrozenReads(f.ref, identity, [{ ...f.item(0, 9, 'call'), ...change }]), /invalid, pending or foreign/)
  } finally { f.close() }
})

test('identical bytes deduplicate storage and logical coverage while binary and absence stay explicit', () => {
  const f = fixture([
    { id: 'a', label: 'first', kind: 'utf8', bytes: Buffer.from('same') },
    { id: 'alias', label: 'same bytes different logical source', kind: 'utf8', bytes: Buffer.from('same') },
    { id: 'binary', label: 'binary', kind: 'binary', bytes: Buffer.from([0xff, 0x00]) },
    { id: 'absent', label: 'absent', kind: 'absent' },
  ])
  try {
    assert.equal(readdirSync(join(dirname(f.ref.manifestPath), 'bytes')).length, 3)
    assert.equal(JSON.parse(readFrozenRange(f.ref, f.args(0, 2, 'binary')).response.contentItems[0].text).base64, '/wA=')
    assert.equal(JSON.parse(readFrozenRange(f.ref, f.args(0, 0, 'absent')).response.contentItems[0].text).absent, true)
    const proof = proveFrozenReads(f.ref, identity, [f.item(0, 4, 'same'), f.item(0, 2, 'bin', 'binary'), f.item(0, 0, 'abs', 'absent')])
    assert.deepEqual(proof.coveredEntryIds, ['a', 'alias', 'binary', 'absent'])
    assert.throws(() => proveFrozenReads(f.ref, identity, [f.item(0, 4, 'same'), f.item(0, 2, 'bin', 'binary')]), /absent/)
  } finally { f.close() }
})

test('modified manifest, byte blobs and response evidence are rejected', () => {
  for (const kind of ['manifest', 'bytes', 'response']) {
    const f = fixture()
    try {
      const receipt = persistFrozenRead(f.ref, { ...identity, callId: 'c' }, f.args(0, 9)).receipt
      const path = kind === 'manifest' ? f.ref.manifestPath : kind === 'bytes' ? join(dirname(f.ref.manifestPath), 'bytes', readFrozenManifest(f.ref).entries[0].sha256) : join(dirname(f.ref.manifestPath), 'responses', receipt.responseDigest)
      chmodSync(path, 0o600); writeFileSync(path, 'tampered')
      assert.throws(() => kind === 'manifest' ? readFrozenManifest(f.ref) : persistFrozenRead(f.ref, { ...identity, callId: 'c' }, f.args(0, 9)), /digest|modified/)
    } finally { f.close() }
  }
})

test('frozen storage refuses source directories and invalid UTF-8 inputs', () => {
  assert.throws(() => freezeContext({ directory: process.cwd(), sourceRoot: process.cwd(), binding, entries: [] }), /outside the source tree/)
  const f = fixture()
  try { assert.throws(() => freezeContext({ directory: f.directory, sourceRoot: process.cwd(), binding, entries: [{ id: 'x', label: 'invalid', kind: 'utf8', bytes: Buffer.from([0xff]) }] }), /encoded data/) }
  finally { f.close() }
})

test('large prompt preparation is lossless, stable before hashing and leaves small v1 requests untouched', () => {
  const f = fixture()
  try {
    const small = { root: process.cwd(), prompt: 'small task', ...binding }
    assert.equal(prepareFrozenPrompt(small, { directory: f.directory }), small)
    const request = { ...small, prompt: ' '.repeat(2 * 1024 * 1024) + '尾部原意' }
    const options = { directory: f.directory, binding: { attemptId: 'real-attempt', policyDigest: 'real-policy' } }
    const first = prepareFrozenPrompt(request, options), second = prepareFrozenPrompt(request, options)
    assert.deepEqual(first, second)
    assert.equal(first.inputDigest, request.inputDigest)
    assert.equal(first.requestKey, request.requestKey)
    assert.ok(first.frozenContext)
    assert.ok(first.prompt.length < 2048)
    assert.match(first.prompt, /original endByte, never decodedEndByte/)
    assert.equal(first.prompt.includes(f.directory), false)
    const entry = readFrozenManifest(first.frozenContext).entries[0]
    assert.equal(entry.byteLength, Buffer.byteLength(request.prompt))
    assert.equal(readFileSync(join(dirname(first.frozenContext.manifestPath), 'bytes', entry.sha256), 'utf8'), request.prompt)
    assert.equal(prepareFrozenPrompt(first, options), first)
    assert.throws(() => prepareFrozenPrompt(first, { ...options, binding: { ...options.binding, attemptId: 'foreign' } }), /attemptId/)
  } finally { f.close() }
})

test('one-to-two MiB prompts use lossless reader below native string limit with complete byte coverage', () => {
  const f = fixture()
  try {
    const original = 'x'.repeat(1_369_916) + '义'.repeat(82_260) + '尾部义', bytes = Buffer.from(original, 'utf8')
    assert.equal(original.length, 1_452_179); assert.equal(bytes.length, 1_616_705)
    assert.ok(original.length > 1_048_576 && bytes.length < 2 * 1024 * 1024)
    const prepared = prepareFrozenPrompt({ root: process.cwd(), prompt: original, ...binding }, { directory: f.directory })
    assert.ok(prepared.frozenContext, '1–2MiB正文必须走reader而不能继续超过原生字符串上限')
    assert.ok(prepared.prompt.length < 2048)
    const manifest = readFrozenManifest(prepared.frozenContext), entry = manifest.entries[0]
    assert.equal(entry.byteLength, bytes.length)
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(readFileSync(join(dirname(prepared.frozenContext.manifestPath), 'bytes', entry.sha256)), bytes)
    const items: FrozenNativeItem[] = [], chunks: string[] = []
    for (let startByte = 0; startByte < bytes.length;) {
      let endByte = Math.min(bytes.length, startByte + FROZEN_READ_MAX_BYTES)
      while (endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) endByte--
      const args = { contextDigest: prepared.frozenContext.contextDigest, entryId: entry.id, startByte, endByte }
      const response = readFrozenRange(prepared.frozenContext, args).response
      chunks.push((JSON.parse(response.contentItems[0].text) as { text: string }).text)
      items.push({ type: 'dynamicToolCall', id: `range-${startByte}`, namespace: null, tool: 'spex_read_frozen', arguments: args, status: 'completed', success: true, contentItems: response.contentItems })
      startByte = endByte
    }
    assert.equal(chunks.join(''), original)
    const proof = proveFrozenReads(prepared.frozenContext, identity, items)
    assert.deepEqual(proof.coveredEntryIds, [entry.id])
    verifyFrozenReadProof(prepared.frozenContext, proof, identity)
    assert.throws(() => proveFrozenReads(prepared.frozenContext!, identity, items.slice(0, -1)), /not completely read/)
    const boundary = { root: process.cwd(), prompt: 'x'.repeat(512 * 1024), ...binding }
    assert.equal(prepareFrozenPrompt(boundary, { directory: f.directory }), boundary)
    assert.ok(prepareFrozenPrompt({ ...boundary, prompt: boundary.prompt + 'x' }, { directory: f.directory }).frozenContext)
  } finally { f.close() }
})

test('pure JSON frozen entries survive a JSON copy, keep roles, and do not rewrite an existing ref', () => {
  const f = fixture([])
  try {
    const small = { root: process.cwd(), prompt: 'small task', ...binding }
    assert.equal(prepareFrozenPrompt(small, { directory: f.directory }), small)
    const text = '\uFEFF中文条目', binary = Buffer.from([0xff, 0x00, 0xfe])
    const request = { ...small, frozenEntries: [
      { id: 'text', label: 'text role', required: true, kind: 'utf8' as const, text },
      { id: 'bin', label: 'binary role', required: false, kind: 'binary' as const, base64: binary.toString('base64') },
      { id: 'gone', label: 'absent role', required: false, kind: 'absent' as const },
    ] }
    const copied = JSON.parse(JSON.stringify(request)) as typeof request
    const options = { directory: f.directory, binding: { attemptId: 'real-attempt', policyDigest: 'real-policy' } }
    const prepared = prepareFrozenPrompt(copied, options)
    assert.equal('frozenEntries' in prepared, false)
    assert.equal(prepared.inputDigest, request.inputDigest)
    assert.equal(prepared.requestKey, request.requestKey)
    assert.equal(prepared.prompt.includes(text), false)
    const manifest = readFrozenManifest(prepared.frozenContext!)
    assert.equal(manifest.binding.attemptId, 'real-attempt')
    assert.equal(manifest.binding.policyDigest, 'real-policy')
    const utf8 = manifest.entries.find(entry => entry.id === 'text')!, bin = manifest.entries.find(entry => entry.id === 'bin')!, absent = manifest.entries.find(entry => entry.id === 'gone')!
    assert.equal(utf8.required, true); assert.equal(bin.required, false); assert.equal(absent.required, false)
    assert.equal(readFileSync(join(dirname(prepared.frozenContext!.manifestPath), 'bytes', utf8.sha256), 'utf8'), text)
    assert.deepEqual(readFileSync(join(dirname(prepared.frozenContext!.manifestPath), 'bytes', bin.sha256)), binary)
    assert.equal(prepareFrozenPrompt(prepared, options), prepared)
    const reused = prepareFrozenPrompt({ ...prepared, prompt: 'rewritten' }, options)
    assert.equal(reused.frozenContext!.contextDigest, prepared.frozenContext!.contextDigest)
    assert.equal(readFileSync(join(dirname(prepared.frozenContext!.manifestPath), 'bytes', utf8.sha256), 'utf8'), text)
  } finally { f.close() }
})
