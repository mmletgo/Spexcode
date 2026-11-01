import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareFrozenPrompt, readFrozenManifest } from './frozen-context.js'
import { structuredExecutionPolicy, structuredRealmRoot } from './session-structured-policy.js'

const request = {
  root: process.cwd(), prompt: 'Read the original requirements and return the exact object.',
  schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
  requestKey: 'zcode-routing', inputDigest: 'original-input', purpose: 'test', timeoutMs: 1000,
  model: 'zcode:bigmodel-api/GLM-5.3-Flash',
}

test('ZCode固定命名空间冻结完整task并选择独立v4 realm，不进入Codex读取计划', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-route-'))
  try {
    const prepared = prepareFrozenPrompt({ ...request, frozenEntries: [{ id: 'module', label: 'Module', kind: 'utf8' as const, text: 'x'.repeat(9000) }] }, { directory })
    assert.ok(prepared.frozenContext)
    const manifest = readFrozenManifest(prepared.frozenContext)
    assert.deepEqual(manifest.entries.map(entry => entry.id), ['task', 'module'])
    assert.equal(manifest.entries[0].byteLength, Buffer.byteLength(request.prompt))
    const index = JSON.parse(prepared.prompt.split('\n').at(-1)!) as { maxReadBytes: number; execMaxOutputTokens?: number; readBatches: Array<{ ranges: Array<{ startByte: number; endByte: number }> }> }
    assert.equal(index.maxReadBytes, 4096)
    assert.equal(index.execMaxOutputTokens, undefined)
    assert.ok(index.readBatches.every(batch => batch.ranges.every(range => range.endByte - range.startByte <= 4096)))
    assert.ok(!prepared.prompt.includes('StructuredOutput'))
    const policy = structuredExecutionPolicy(prepared)
    assert.equal(policy.version, 4)
    assert.equal(policy.policy, 'zcode-frozen-read-only-v1')
    assert.equal(policy.readerRuntime, undefined)
    assert.equal(structuredRealmRoot(policy, directory), join(directory, 'structured-zcode-read-only-v1'))
    assert.equal(prepareFrozenPrompt(prepared, { directory }), prepared)
  } finally { rmSync(directory, { recursive: true }) }
})

test('小ZCode prompt仍须真正冻结，既有Claude和Codex策略保持原版本', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-zcode-small-'))
  try {
    const prepared = prepareFrozenPrompt(request, { directory })
    assert.ok(prepared.frozenContext)
    assert.equal(readFrozenManifest(prepared.frozenContext).entries[0].id, 'task')
    assert.equal(structuredExecutionPolicy({ ...request, model: 'claude:MiniMax-M3.1-Flash' }).version, 3)
    assert.equal(structuredExecutionPolicy({ ...request, model: undefined }).version, 1)
    assert.equal(structuredRealmRoot({ ...structuredExecutionPolicy(prepared), readerRuntime: { version: 1, cliVersion: '0.160.0', catalogDigest: 'a'.repeat(64), catalogPath: '/unused' } }, directory), null)
  } finally { rmSync(directory, { recursive: true }) }
})
