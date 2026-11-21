import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { managedModel, managedRoute, nativeModelValue } from '../llm-manager-route.js'
import { configuredSyncModel, readSyncModelSettings, resolveSyncModel } from './model-selection.js'

test('settings and operation selection share the authoritative Manager bridge', async t => {
  const original = process.env
  process.env = { ...original }
  t.after(() => { process.env = original })
  delete process.env.SPEX_LLM_MANAGER_PYTHON
  delete process.env.SPEX_LLM_MANAGER_CONFIG
  delete process.env.SPEX_LLM_MANAGER_SETTINGS_HTML
  const unmanaged = await readSyncModelSettings()
  assert.deepEqual(unmanaged.llmManager, { configured: false })
  assert.deepEqual(unmanaged.nativeVendors.map(({ id }) => id).sort(), ['claude', 'codex', 'cursor', 'grok', 'zcode'])

  const root = mkdtempSync(join(tmpdir(), 'spex-manager-settings-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const python = join(root, 'rpc'), config = join(root, 'config.json'), html = join(root, 'manager.html')
  const route = { routeId: 'a'.repeat(64), vendor: 'claude', model: 'fixture-model', kind: 'anthropic-messages' } as const
  writeFileSync(config, JSON.stringify({ ok: true, value: route }))
  writeFileSync(html, '<!doctype html><title>Manager fixture</title>')
  writeFileSync(python, '#!/bin/sh\n[ "$1" = "-I" ] && [ "$3" = "rpc" ] || exit 2\n[ -z "\${SPEX_LLM_MANAGER_TEST_ENV_TRAP+x}" ] || exit 2\n/bin/cat >/dev/null\n/bin/cat "$4"\n', { mode: 0o700 })
  Object.assign(process.env, { SPEX_LLM_MANAGER_PYTHON: python, SPEX_LLM_MANAGER_CONFIG: config, SPEX_LLM_MANAGER_SETTINGS_HTML: html, SPEX_LLM_MANAGER_TEST_ENV_TRAP: 'host-only' })

  assert.deepEqual((await readSyncModelSettings()).llmManager, {
    configured: true, authoritative: true, settingsPath: '/llm-manager/', selection: 'claude:fixture-model',
  })
  assert.equal(configuredSyncModel({ model: 'grok:default' }, true), 'llm-manager')
  assert.equal(await resolveSyncModel('llm-manager', true), managedModel(route))
  assert.deepEqual(managedRoute(managedModel(route)), route)
  assert.equal(nativeModelValue(managedModel(route), 'claude'), route.model)
  await assert.rejects(resolveSyncModel(managedModel(route), true), { code: 'sync_llm_manager_untrusted_route' })
  await assert.rejects(resolveSyncModel('grok:default', true), { code: 'sync_llm_manager_managed' })
})
