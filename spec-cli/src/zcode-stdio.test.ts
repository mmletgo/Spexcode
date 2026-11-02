import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { zcodeProtocolLine } from './zcode-structured.js'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
function boundaryPacket(symbol: string) {
  const prefix = '{"id":1,"method":"session/send","params":{"content":"'
  const content = `${'x'.repeat(65535 - Buffer.byteLength(prefix))}${symbol}public-tail`
  return { id: 1, method: 'session/send', params: { content } }
}

for (const symbol of ['知', '🙂']) test(`ZCode SDK per-Buffer decoding preserves ${symbol} across the 64KiB boundary with ASCII JSON-RPC`, () => {
  const packet = boundaryPacket(symbol), bytes = Buffer.from(zcodeProtocolLine(packet))
  const chunks = [bytes.subarray(0, 65536), bytes.subarray(65536, 65537), bytes.subarray(65537)]
  // ZCode 0.17.1 ZCodeProtocolNdjsonConnection.onData uses this exact per-Buffer conversion.
  const decoded = JSON.parse(chunks.map(chunk => chunk.toString('utf8')).join('').trim()) as typeof packet
  assert.equal(sha(decoded.params.content), sha(packet.params.content))
  assert.equal(decoded.params.content.length, packet.params.content.length)
  assert(!decoded.params.content.includes('\ufffd'))
})

test('wire escaping preserves JSON semantics, keys, astral characters and existing escapes without changing saved input', () => {
  const packet = { id: '中文🙂', result: { '键': '知🙂\n\\u77e5"\ud800\u2028' } }, saved = JSON.stringify(packet)
  const wire = zcodeProtocolLine(packet)
  assert(/^[\x00-\x7f]*\n$/.test(wire))
  assert.deepEqual(JSON.parse(wire), packet)
  assert.equal(JSON.stringify(packet), saved)
  assert.equal(wire.split('\n').length, 2)
})

for (const symbol of ['知', '🙂']) test(`client readline incrementally decodes raw stdout ${symbol} across 64KiB and byte chunks`, async () => {
  const packet = boundaryPacket(symbol), bytes = Buffer.from(`${JSON.stringify(packet)}\n`), stdout = new PassThrough()
  const lines = createInterface({ input: stdout }), received = once(lines, 'line')
  stdout.write(bytes.subarray(0, 65536)); stdout.write(bytes.subarray(65536, 65537)); stdout.end(bytes.subarray(65537))
  const [line] = await received as [string]
  assert.deepEqual(JSON.parse(line), packet)
})
