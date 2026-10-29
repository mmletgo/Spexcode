import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { processStartToken } from '@spexcode/spec-core'
import { readFrozenRange, type FrozenContextRef } from './frozen-context.js'
import { StructuredSessionError } from './session-structured-policy.js'

const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { root: string; ref: FrozenContextRef }
const record = (value: unknown): void => appendFileSync(`${configuration.root}/mcp-public.jsonl`, `${JSON.stringify(value)}\n`, { mode: 0o600 })
record({ type: 'process', pid: process.pid, startToken: processStartToken(process.pid) })
process.once('exit', code => record({ type: 'exit', pid: process.pid, code }))
const tool = { name: 'spex_read_frozen', description: 'Read only immutable frozen context by exact identity and original byte range. Read each required entry completely. Each range is at most 65536 bytes; use original endByte for the next cursor. No live files, paths, shell or network are available.',
  inputSchema: { type: 'object', properties: { contextDigest: { type: 'string' }, entryId: { type: 'string' }, startByte: { type: 'integer', minimum: 0 }, endByte: { type: 'integer', minimum: 0 } }, required: ['contextDigest', 'entryId', 'startByte', 'endByte'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: { 'anthropic/maxResultSizeChars': 500000 } }
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const request = JSON.parse(line) as { jsonrpc: string; id?: string | number; method: string; params: { protocolVersion: string; name: string; arguments: { startByte: number; endByte: number } } }
  if (request.id === undefined) return
  record({ type: 'request', request })
  let result: unknown
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'spex-immutable-reader', version: '1' } }
  else if (request.method === 'tools/list') result = { tools: [tool] }
  else if (request.method === 'ping') result = {}
  else if (request.method === 'tools/call') {
    try {
      if (request.params.name !== tool.name || request.params.arguments.endByte - request.params.arguments.startByte > 65536) throw new StructuredSessionError('stale_result', 'Claude reader rejects foreign tools or a range above 65536 bytes')
      const response = readFrozenRange(configuration.ref, request.params.arguments).response
      if (response.contentItems.some(item => item.text.length > 500000)) throw new StructuredSessionError('stale_result', 'Claude reader response exceeds its fixed character bound')
      result = { content: response.contentItems.map(item => ({ type: 'text', text: item.text })) }
    } catch (error) {
      if (!(error instanceof StructuredSessionError)) throw error
      result = { isError: true, content: [{ type: 'text', text: error.message }] }
    }
  } else {
    const response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method unavailable' } }
    record({ type: 'response', response }); process.stdout.write(`${JSON.stringify(response)}\n`); return
  }
  const response = { jsonrpc: '2.0', id: request.id, result }
  record({ type: 'response', response }); process.stdout.write(`${JSON.stringify(response)}\n`)
})
lines.once('close', () => process.exit(0))
