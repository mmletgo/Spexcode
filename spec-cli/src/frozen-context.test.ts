import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertFrozenBinding, freezeContext, frozenContextPrompt, persistFrozenRead, prepareFrozenPrompt, proveFrozenReads, readFrozenManifest, readFrozenRange, verifyFrozenReadProof, FROZEN_READ_MAX_BYTES, type FrozenContextInput, type FrozenNativeItem } from './frozen-context.js'

const binding = { requestKey: 'exact-request', inputDigest: 'exact-input' }
function fixture(entries: FrozenContextInput[] = [{ id: 'a', label: 'frozen source', kind: 'utf8', bytes: Buffer.from('首abc尾') }]) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-frozen-test-'))
  const ref = freezeContext({ directory, sourceRoot: process.cwd(), binding, entries })
  const args = (startByte: number, endByte: number, entryId = 'a') => ({ contextDigest: ref.contextDigest, entryId, startByte, endByte })
  const item = (start: number, end: number, id: string, entryId = 'a'): FrozenNativeItem => ({ type: 'dynamicToolCall', id, tool: 'spex_read_frozen', namespace: null, status: 'completed', success: true, arguments: args(start, end, entryId), contentItems: readFrozenRange(ref, args(start, end, entryId)).response.contentItems })
  return { ref, directory, args, item, close: () => rmSync(directory, { recursive: true, force: true }) }
}
const identity = { threadId: 'exact-thread', turnId: 'exact-turn' }

test('frozen manifest binds request and immutable bytes without exposing control paths to the model', () => {
  const f = fixture()
  try {
    assertFrozenBinding(f.ref, binding)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, requestKey: 'foreign' }), /requestKey/)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, inputDigest: 'foreign' }), /inputDigest/)
    assert.throws(() => assertFrozenBinding(f.ref, { ...binding, attemptId: 'invented' }), /attemptId/)
    assert.equal(frozenContextPrompt(f.ref).includes(f.directory), false)
    const read = readFrozenRange(f.ref, f.args(0, 3))
    assert.equal(JSON.parse(read.response.contentItems[0].text).text, '首')
    const persisted = persistFrozenRead(f.ref, { ...identity, callId: 'native-call' }, f.args(0, 9))
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(f.ref.manifestPath), 'responses', persisted.receipt.responseDigest), 'utf8')), persisted.response)
    assert.throws(() => readFrozenRange(f.ref, f.args(1, 3)), /encoded data/)
    assert.throws(() => readFrozenRange(f.ref, { ...f.args(0, 3), path: '/etc/passwd' }), /argument shape/)
    assert.throws(() => readFrozenRange(f.ref, { ...f.args(0, 3), contextDigest: 'wrong' }), /identity/)
    assert.throws(() => readFrozenRange(f.ref, f.args(0, 10)), /range/)
    assert.throws(() => readFrozenRange(f.ref, f.args(0, 3, 'foreign')), /entry/)
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
