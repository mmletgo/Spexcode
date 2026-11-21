import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const playwrightPath = process.env.SPEXCODE_PLAYWRIGHT_PATH
if (!playwrightPath) throw new Error('SPEXCODE_PLAYWRIGHT_PATH must point at playwright/index.mjs')
const { chromium } = await import(pathToFileURL(playwrightPath).href)
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const origin = 'http://127.0.0.1:38149'
const setupUrl = 'http://127.0.0.1:3456/ui/'
const browser = await chromium.launch({ executablePath: process.env.SPEXCODE_CHROMIUM_PATH || '/snap/bin/chromium' })

try {
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const writes = []
  let configReads = 0
  let config = {
    dashboard: { title: 'Fixture' },
    sync: { version: 'sync-settings-v1', model: 'llm-manager', budget: { maxCalls: 3 }, facts: [{ source: 'fixture', text: 'preserve' }] },
    sessions: { launchers: { review: { harness: 'claude', cmd: 'fixture' } } },
  }
  let revision = 'one'
  let enabled = true
  let claudeApi = { available: true, setupUrl }
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
        nativeVendors: [{ id: 'claude', installed: true }, { id: 'grok', installed: false }, { id: 'zcode', installed: true }, { id: 'cursor', installed: true }],
        llmManager: { configured: true, selection: 'claude:default' },
        claudeApi,
      } })
    }
    if (url.pathname.endsWith('/api/graph')) return route.fulfill({ json: { nodes: [], edges: [], sessions: [] } })
    if (url.pathname.endsWith('/api/settings')) return route.fulfill({ json: {} })
    if (url.pathname.endsWith('/api/sync/settings')) return route.fulfill({ json: { enabled, activation: enabled ? 'enabled' : 'disabled' } })
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
  const router = panel.getByRole('link', { name: 'Configure API' })
  await route.waitFor()
  assert.equal(await route.inputValue(), 'llm-manager')
  assert.deepEqual(await route.locator('option').evaluateAll((options) => options.map((entry) => entry.value)), ['', 'llm-manager', 'claude', 'grok', 'zcode', 'cursor'])
  await panel.getByText('Host selection: claude:default').waitFor()
  assert.equal(await router.getAttribute('href'), setupUrl)
  assert.equal(await router.getAttribute('rel'), 'noopener noreferrer')
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
  assert.equal(await router.getAttribute('href'), setupUrl)
  delete config.sync
  enabled = true
  claudeApi = { available: true, setupUrl: 'https://foreign.invalid/ui/' }
  await reload.click()
  await panel.getByText('Set up sync for this project before choosing a model.').waitFor()
  await panel.getByText('The local Claude Code Router setup page is unavailable.').waitFor()
  assert.equal(await save.count(), 0)
  assert.equal(await router.count(), 0)
  assert.equal(writes.length, 3)

  const localConfigReads = configReads
  claudeApi = { available: true, setupUrl }
  await page.goto(origin + '/m/other/p/fixture/#/settings')
  await panel.getByText('Open this project on its host to change its sync model.').waitFor()
  await panel.getByText('Open Settings on this machine to access its local Router.').waitFor()
  assert.equal(await route.count(), 0)
  assert.equal(configReads, localConfigReads)

  config.sync = { version: 'sync-settings-v1', model: 'claude:default' }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/p/fixture/#/settings')
  await model.waitFor()
  await router.waitFor()
  assert.equal(await route.inputValue(), 'claude')
  assert.equal(await model.inputValue(), '')
  assert.equal(await panel.evaluate((section) => section.scrollWidth <= section.clientWidth), true)
  if (process.env.SPEX_SYNC_MODEL_MOBILE_SCREENSHOT) await panel.screenshot({ path: process.env.SPEX_SYNC_MODEL_MOBILE_SCREENSHOT })
  assert.deepEqual(pageErrors, [])
  console.log('Sync model browser proof passed: native routes, verified Router link, revision CAS, conflicts, and disabled project scopes.')
} finally {
  await browser.close()
}
