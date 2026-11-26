import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const playwrightPath = process.env.SPEXCODE_PLAYWRIGHT_PATH
if (!playwrightPath) throw new Error('SPEXCODE_PLAYWRIGHT_PATH must point at playwright/index.mjs')
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const origin = 'http://127.0.0.1:38149'
const managerPath = '/llm-manager/'
const managerHtml = process.env.SPEX_LLM_MANAGER_SETTINGS_HTML
const browser = await chromium.launch({ executablePath: process.env.SPEXCODE_CHROMIUM_PATH || '/snap/bin/chromium' })

try {
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const writes = []
  let configReads = 0
  let activationReads = 0
  const managerWrites = []
  const group = { id: 'spec-sync', label: 'Sync fixture', fallback_group_id: null, fallback_when: 'never' }
  let providers = []
  let scheduleTimezone = null
  let config = {
    dashboard: { title: 'Fixture' },
    sync: { version: 'sync-settings-v1', model: 'claude:default', budget: { maxCalls: 3 }, facts: [{ source: 'fixture', text: 'preserve' }] },
    sessions: { launchers: { review: { harness: 'claude', cmd: 'fixture' } } },
  }
  let revision = 'one'
  let enabled = true
  let llmManager = { configured: false }
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/projects/fixture/config') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON()
        writes.push(body)
        if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: 'changed' } })
        config = JSON.parse(body.content)
        revision += '-saved'
      } else configReads += 1
      return route.fulfill({ json: { content: JSON.stringify(config), revision } })
    }
    if (url.pathname.endsWith('/api/sync/model-settings')) {
      return route.fulfill({ json: {
        nativeVendors: [{ id: 'claude', installed: true }, { id: 'grok', installed: false }, { id: 'zcode', installed: true },
          { id: 'cursor', installed: true }, { id: 'codex', installed: true }],
        llmManager,
      } })
    }
    if (url.pathname.endsWith('/api/graph')) return route.fulfill({ json: { nodes: [], edges: [], sessions: [] } })
    if (url.pathname.endsWith('/api/settings')) return route.fulfill({ json: {} })
    if (url.pathname.endsWith('/api/sync/settings')) {
      activationReads += 1
      return route.fulfill({ json: { enabled, activation: enabled ? 'enabled' : 'disabled' } })
    }
    if (managerHtml && url.pathname === managerPath) {
      return route.fulfill({ path: managerHtml, contentType: 'text/html; charset=utf-8' })
    }
    if (managerHtml && url.pathname === '/llm-manager/settings') {
      assert.equal(request.method(), 'POST')
      const body = request.postDataJSON()
      switch (body.op) {
        case 'catalog': return route.fulfill({ json: { catalog: [group], providerCapabilities: {} } })
        case 'get_schedule_timezone': return route.fulfill({ json: { timezone: scheduleTimezone } })
        case 'set_schedule_timezone': {
          managerWrites.push(body)
          scheduleTimezone = body.timezone
          return route.fulfill({ json: { timezone: scheduleTimezone } })
        }
        case 'list_groups': return route.fulfill({ json: { groups: [{ ...group, members: [] }] } })
        case 'list_providers': return route.fulfill({ json: { providers } })
        case 'status': return route.fulfill({ json: { breakers: [], leases: [] } })
        case 'query_usage': return route.fulfill({ json: {
          start: '2026-11-20T00:00:00Z', end: '2026-11-21T00:00:00Z', call_count: 0, probe_count: 0,
          input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, unreported_count: 0, slices: [],
        } })
        case 'save_provider': {
          managerWrites.push(body)
          const provider = { ...body.input.provider, timezone: scheduleTimezone ?? 'UTC', id: 'fixture-provider', version: 1, keys: [] }
          providers = [provider]
          return route.fulfill({ json: provider })
        }
        default: return route.fulfill({ status: 400, json: { detail: 'unexpected_fixture_operation' } })
      }
    }
    if (url.pathname.endsWith('/p/fixture/')) return route.fulfill({ path: join(dist, 'index.html') })
    const asset = /\/assets\/([^/]+)$/.exec(url.pathname)
    if (asset) return route.fulfill({ path: join(dist, 'assets', asset[1]) })
    return route.fulfill({ status: 404, json: { error: 'fixture route absent' } })
  })
  await page.goto(origin + '/p/fixture/#/settings')
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sync model', exact: true }) })
  const route = panel.getByRole('combobox', { name: 'Execution route' })
  const model = panel.getByRole('textbox', { name: 'Model ID' })
  const save = panel.getByRole('button', { name: 'Save changes' })
  const reload = panel.getByRole('button', { name: 'Reload' })
  const managerLink = panel.getByRole('link', { name: 'Open LLM Manager settings' })
  await route.waitFor()
  assert.equal(await route.inputValue(), 'claude')
  assert.deepEqual(await route.locator('option').evaluateAll((options) => options.map((entry) => entry.value)), ['', 'claude', 'grok', 'zcode', 'cursor', 'codex'])
  assert.equal(await managerLink.count(), 0)
  if (process.env.SPEX_SYNC_MODEL_SCREENSHOT) await panel.screenshot({ path: process.env.SPEX_SYNC_MODEL_SCREENSHOT })

  await route.selectOption('grok')
  await panel.getByText('This host did not detect that CLI.').waitFor()
  await route.selectOption('zcode')
  await model.fill('bad')
  assert.equal(await model.getAttribute('aria-invalid'), 'true')
  assert.equal(await save.isDisabled(), true)
  await model.clear()
  await save.click()
  await panel.getByText('Saved to project config. Commit the change', { exact: false }).waitFor()
  assert.equal(config.sync.model, 'zcode:default')
  assert.equal(writes[0].revision, 'one')
  assert.equal(config.dashboard.title, 'Fixture')
  assert.deepEqual(config.sessions.launchers, { review: { harness: 'claude', cmd: 'fixture' } })
  assert.deepEqual(config.sync.facts, [{ source: 'fixture', text: 'preserve' }])
  assert.equal(config.sync.budget.maxCalls, 3)

  config.sync.budget.maxCalls = 8
  revision = 'external'
  await model.fill('provider/exact:variant')
  await save.click()
  await panel.getByRole('alert').getByText('The project configuration changed. Reload before saving.').waitFor()
  assert.equal(await save.isDisabled(), true)
  assert.equal(config.sync.model, 'zcode:default')
  assert.equal(config.sync.budget.maxCalls, 8)
  await reload.click()
  await model.waitFor()
  assert.equal(await model.inputValue(), '')
  await model.fill('provider/exact:variant')
  await save.click()
  await panel.getByText('Saved to project config. Commit the change', { exact: false }).waitFor()
  assert.equal(writes.at(-1).revision, 'external')
  assert.equal(config.sync.model, 'zcode:provider/exact:variant')
  assert.equal(config.sync.budget.maxCalls, 8)

  enabled = false
  await reload.click()
  await panel.getByText('Set up sync for this project before choosing a model.').waitFor()
  assert.equal(await save.count(), 0)
  delete config.sync
  enabled = true
  await reload.click()
  await panel.getByText('Set up sync for this project before choosing a model.').waitFor()
  assert.equal(await save.count(), 0)
  assert.equal(writes.length, 3)

  const localConfigReads = configReads
  await page.goto(origin + '/m/other/p/fixture/#/settings')
  await panel.getByText('Open this project on its host to change its sync model.').waitFor()
  assert.equal(await route.count(), 0)
  assert.equal(await managerLink.count(), 0)
  assert.equal(configReads, localConfigReads)

  config.sync = { version: 'sync-settings-v1', model: 'claude:default' }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/p/fixture/#/settings')
  await model.waitFor()
  assert.equal(await route.inputValue(), 'claude')
  assert.equal(await model.inputValue(), '')
  assert.equal(await panel.evaluate((section) => section.scrollWidth <= section.clientWidth), true)
  if (process.env.SPEX_SYNC_MODEL_MOBILE_SCREENSHOT) await panel.screenshot({ path: process.env.SPEX_SYNC_MODEL_MOBILE_SCREENSHOT })
  llmManager = { authoritative: true }
  const nativeActivationReads = activationReads
  await page.reload()
  await panel.getByText('The host feature group has no ready route.').waitFor()
  await panel.getByText('The LLM Manager settings page is not installed on this host.').waitFor()
  assert.equal(await managerLink.count(), 0)
  assert.equal(await route.count(), 0)
  assert.equal(await save.count(), 0)
  assert.equal(await reload.count(), 0)

  llmManager = { authoritative: true, selection: 'Fixture model', settingsPath: managerPath }
  await page.reload()
  await panel.getByText('Host selection: Fixture model').waitFor()
  assert.equal(await managerLink.getAttribute('href'), managerPath)
  assert.equal(await panel.evaluate((section) => section.scrollWidth <= section.clientWidth), true)
  assert.equal(await route.count(), 0)
  assert.equal(activationReads, nativeActivationReads)
  assert.equal(writes.length, 3)

  if (managerHtml) {
    await managerLink.click()
    await page.waitForURL(origin + managerPath)
    await page.getByRole('heading', { name: 'Provider 配置库' }).waitFor()
    await page.getByRole('heading', { name: 'Sync fixture' }).waitFor()
    await page.getByText('暂无 Provider 配置').waitFor()
    const timezone = page.getByRole('combobox', { name: '全局时区' })
    const saveTimezone = page.getByRole('button', { name: '保存时区' })
    await timezone.selectOption('Asia/Singapore')
    await saveTimezone.click()
    await page.getByText('已保存调度时区').waitFor()
    assert.deepEqual(managerWrites[0], { op: 'set_schedule_timezone', timezone: 'Asia/Singapore' })
    await page.reload()
    await timezone.locator('option[value="Asia/Singapore"]:checked').waitFor({ state: 'attached' })
    assert.equal(await timezone.inputValue(), 'Asia/Singapore')
    if (process.env.SPEX_SYNC_MANAGER_SCREENSHOT) {
      await page.screenshot({ path: process.env.SPEX_SYNC_MANAGER_SCREENSHOT, fullPage: true })
    }
    await page.getByRole('button', { name: '新增配置' }).click()
    const form = page.getByRole('dialog', { name: '新增配置' })
    assert.equal(await form.getByRole('textbox', { name: '时区', exact: true }).count(), 0)
    await form.getByRole('textbox', { name: '名称', exact: true }).fill('Provider fixture')
    await form.getByRole('textbox', { name: 'Base URL' }).fill('https://fixture.invalid/v1')
    await form.getByRole('button', { name: '保存配置' }).click()
    await page.getByText('Provider 已保存').waitFor()
    assert.equal(managerWrites.length, 2)
    assert.equal(managerWrites[1].input.mode, 'create')
    assert.equal(managerWrites[1].input.provider.name, 'Provider fixture')
    assert.equal(Object.hasOwn(managerWrites[1].input.provider, 'timezone'), false)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  assert.deepEqual(pageErrors, [])
  console.log('Sync model browser proof passed: native revision CAS, disabled project scopes, and the authoritative settings entry.')
} finally {
  await browser.close()
}
