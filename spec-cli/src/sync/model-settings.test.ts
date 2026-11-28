import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadManagerNativeRuntime, reserveManagedRoute } from '../llm-manager-host.js'
import { managedModel, managedRoute, nativeModelValue } from '../llm-manager-route.js'
import { configuredSyncModel, readSyncModelSettings, resolveSyncModel } from './model-selection.js'

test('settings and operation selection share the authoritative Manager bridge', async t => {
  const original = process.env
  process.env = { ...original }
  t.after(() => { process.env = original })
  delete process.env.SPEX_LLM_MANAGER_PYTHON
  delete process.env.SPEX_LLM_MANAGER_CONFIG
  delete process.env.SPEX_LLM_MANAGER_SETTINGS_HTML
  process.env.SPEX_LLM_MANAGER_PYTHON = '/usr/bin/false'
  const unmanaged = await readSyncModelSettings()
  const runtime = await loadManagerNativeRuntime()
  assert.equal(runtime.nativeRuntimeVersion, 1)
  assert.equal(runtime.nativeAdapterContract, 7)
  for (const [vendor, method] of [
    ['grok', 'prepareGrokStructuredInvocation'],
    ['claude', 'prepareClaudeStructuredInvocation'],
    ['zcode', 'connectZCodeStructuredSession'],
    ['cursor', 'prepareCursorInvocation'],
    ['codex', 'prepareCodexWorktreeInvocation'],
  ] as const) {
    assert.equal(typeof (await runtime.loadNativeAdapter(vendor) as Record<string, unknown>)[method], 'function')
  }
  const codex = await runtime.loadNativeAdapter('codex') as {
    CodexPersistentAppServer: { prototype: Record<string, unknown> }
  }
  for (const method of ['listLegacyThreadRows', 'readLegacyColdTurn', 'mutateLegacyThread']) {
    assert.equal(typeof codex.CodexPersistentAppServer.prototype[method], 'function')
  }
  assert.deepEqual(unmanaged.llmManager, { configured: false })
  assert.deepEqual(unmanaged.nativeVendors.map(({ id }) => id).sort(), ['claude', 'codex', 'cursor', 'grok', 'zcode'])

  const root = mkdtempSync(join(tmpdir(), 'spex-manager-settings-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const python = join(root, 'rpc'), config = join(root, 'config.json'), html = join(root, 'manager.html')
  const route = { routeId: 'a'.repeat(64), vendor: 'claude', model: 'fixture-model', kind: 'anthropic-messages' } as const
  writeFileSync(config, JSON.stringify({ ok: true, value: route }))
  writeFileSync(html, '<!doctype html><title>Manager fixture</title>')
  const packagedEntry = new URL('../../llm-manager/native-runtime.mjs', import.meta.url).href
  const nativeEntry = join(root, 'native.mjs')
  writeFileSync(nativeEntry, `export * from ${JSON.stringify(packagedEntry)}
export const findNativeExecutable = vendor => vendor === 'grok' ? '/manager/grok' : undefined
`)
  writeFileSync(join(root, 'cursor-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(python, `#!${process.execPath}
const { readFileSync } = require('node:fs')
if (process.env.SPEX_LLM_MANAGER_TEST_ENV_TRAP || process.argv[2] !== '-I') process.exit(2)
if (process.argv[3] === '-m' && process.argv[4] === 'llm_manager.native_runtime') {
  process.stdout.write(JSON.stringify({version: 1, path: ${JSON.stringify(nativeEntry)}}))
} else if (process.argv[4] === 'rpc') {
  readFileSync(0)
  process.stdout.write(readFileSync(process.argv[5]))
} else process.exit(2)
`, { mode: 0o700 })
  Object.assign(process.env, { SPEX_LLM_MANAGER_PYTHON: python, SPEX_LLM_MANAGER_CONFIG: config, SPEX_LLM_MANAGER_SETTINGS_HTML: html, SPEX_LLM_MANAGER_TEST_ENV_TRAP: 'host-only', PATH: root })

  const managed = await readSyncModelSettings()
  assert.deepEqual(managed.nativeVendors.filter(vendor => vendor.installed).map(vendor => vendor.id), ['grok'])
  assert.deepEqual(managed.llmManager, {
    configured: true, authoritative: true, settingsPath: '/llm-manager/', selection: 'claude:fixture-model',
  })
  assert.equal(configuredSyncModel({ model: 'grok:default' }, true), 'llm-manager')
  assert.equal(await resolveSyncModel('llm-manager', true), managedModel(route))
  assert.deepEqual(managedRoute(managedModel(route)), route)
  assert.equal(nativeModelValue(managedModel(route), 'claude'), route.model)
  await assert.rejects(resolveSyncModel(managedModel(route), true), { code: 'sync_llm_manager_untrusted_route' })
  await assert.rejects(resolveSyncModel('grok:default', true), { code: 'sync_llm_manager_managed' })

  const oldNative = join(root, 'old-native.mjs'), oldPython = join(root, 'old-python')
  writeFileSync(oldNative, `export const nativeRuntimeVersion=1
export const nativeAdapterContract=6
export const findNativeExecutable = () => { throw new Error('must not probe the CLI') }
export const spawnGatedNativeProcess = findNativeExecutable
export const spawnNativeProcess = findNativeExecutable
export const loadNativeAdapter = findNativeExecutable
`)
  writeFileSync(oldPython, `#!${process.execPath}
if (process.argv[3] !== '-m' || process.argv[4] !== 'llm_manager.native_runtime') process.exit(3)
process.stdout.write(JSON.stringify({version:1,path:${JSON.stringify(oldNative)}}))
`, { mode: 0o700 })
  process.env.SPEX_LLM_MANAGER_PYTHON = oldPython
  await assert.rejects(resolveSyncModel('llm-manager', true), { code: 'llm_manager_native_incompatible' })
  await assert.rejects(reserveManagedRoute(route, 'existing-session', new AbortController().signal), { code: 'llm_manager_native_incompatible' })
  assert.ok((await readSyncModelSettings()).nativeVendors.every(({ installed }) => !installed))
})
