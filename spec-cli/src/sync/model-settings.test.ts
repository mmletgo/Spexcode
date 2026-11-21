import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { readSyncModelSettings } from './model-selection.js'

test('Model settings reports native CLI and a local Claude API configuration page without reading providers', async t => {
  const originalEnv = process.env
  process.env = { ...originalEnv }
  t.after(() => { process.env = originalEnv })
  delete process.env.SPEX_LLM_MANAGER_PYTHON
  delete process.env.SPEX_LLM_MANAGER_CLI_CONFIG
  const calls: string[] = []
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`)
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/ui/' }).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end()
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  await once(server.listen(0, '127.0.0.1'), 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const setupUrl = `${origin}/ui/`
  process.env.SPEX_CLAUDE_API_SETTINGS_URL = setupUrl

  const view = await readSyncModelSettings()
  assert.deepEqual(view.claudeApi, { available: true, setupUrl })
  assert.deepEqual(view.llmManager, { configured: false })
  assert.deepEqual(view.nativeVendors.map(({ id }) => id).sort(), ['claude', 'cursor', 'grok', 'zcode'])
  assert.deepEqual(calls, ['HEAD /ui/'])

  process.env.SPEX_CLAUDE_API_SETTINGS_URL = `${origin}/redirect`
  assert.deepEqual((await readSyncModelSettings()).claudeApi, { available: false })
  assert.deepEqual(calls, ['HEAD /ui/', 'HEAD /redirect'])

  process.env.SPEX_CLAUDE_API_SETTINGS_URL = 'http://example.invalid:3456/ui/'
  assert.deepEqual((await readSyncModelSettings()).claudeApi, { available: false })
  assert.deepEqual(calls, ['HEAD /ui/', 'HEAD /redirect'])
})
