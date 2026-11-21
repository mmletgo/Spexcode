import { useEffect, useId, useState } from 'react'
import { apiUrl, PROJECT_ID, PROJECT_MACHINE_ID } from './project.js'
import { loadProjectConfig, saveProjectConfig } from './projects.js'

const vendors = ['claude', 'grok', 'zcode', 'cursor']
const managed = 'llm-manager'
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

function readConfig(receipt) {
  if (!receipt.ok) return { status: 'syncModelLoadFailed' }
  let config
  try { config = JSON.parse(receipt.content) } catch { return { status: 'configInvalid' } }
  if (!isObject(config)) return { status: 'configInvalid' }
  if (!Object.hasOwn(config, 'sync')) return { status: 'syncModelNotEnabled' }
  if (!isObject(config.sync) || config.sync.version !== 'sync-settings-v1'
    || (config.sync.model !== undefined && typeof config.sync.model !== 'string')) return { status: 'syncModelConfigInvalid' }
  return { config, revision: receipt.revision }
}

function claudeSetupLink(claudeApi) {
  if (claudeApi?.available !== true || typeof claudeApi.setupUrl !== 'string') return null
  try {
    const url = new URL(claudeApi.setupUrl)
    if (['http:', 'https:'].includes(url.protocol) && isLoopback(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash) return url.href
  } catch { return null }
  return null
}

export default function SyncModelSettings({ t, Row }) {
  const [snapshot, setSnapshot] = useState({ status: 'configLoading' })
  const [route, setRoute] = useState('')
  const [model, setModel] = useState('')
  const [capabilities, setCapabilities] = useState(undefined)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const routeId = useId(), modelId = useId(), modelHintId = useId()
  const localProject = !!PROJECT_ID && !PROJECT_MACHINE_ID
  const localBrowser = !PROJECT_MACHINE_ID && isLoopback(globalThis.location?.hostname)

  useEffect(() => {
    const controller = new AbortController()
    const readStatus = async (path) => {
      try {
        const result = await fetch(apiUrl(path), { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
        return result.ok ? await result.json() : null
      } catch { return null }
    }
    if (localProject) void Promise.all([loadProjectConfig(PROJECT_ID), readStatus('/api/sync/settings')]).then(([receipt, status]) => {
      if (controller.signal.aborted) return
      const loaded = readConfig(receipt)
      if (loaded.config && (status?.enabled !== true || status.activation !== 'enabled')) {
        setSnapshot({ status: status ? 'syncModelNotEnabled' : 'syncModelActivationFailed' })
        return
      }
      setSnapshot(loaded)
      const stored = loaded.config?.sync.model
      const vendor = typeof stored === 'string' ? stored.split(':', 1)[0] : ''
      setRoute(stored === managed || (vendors.includes(vendor) && stored.includes(':')) ? vendor : '')
      const exact = vendors.includes(vendor) ? stored.slice(vendor.length + 1) : ''
      setModel(exact === 'default' ? '' : exact)
    })
    void readStatus('/api/sync/model-settings').then((status) => {
      if (!controller.signal.aborted) setCapabilities(isObject(status) && Array.isArray(status.nativeVendors) ? status : null)
    })
    return () => controller.abort()
  }, [localProject, refresh])

  const native = vendors.includes(route)
  const validModel = !native || (model === model.trim() && !/[\r\n\0]/.test(model)
    && (route !== 'zcode' || !model || model === 'default' || (model.indexOf('/') > 0 && model.indexOf('/') < model.length - 1)))
  const selection = native ? `${route}:${model || 'default'}` : route
  const conflicted = message === 'syncModelConflict'
  const dirty = !!selection && selection !== snapshot.config?.sync.model
  const canSave = !!snapshot.config && dirty && validModel && !busy && !conflicted
  const detectedVendor = capabilities?.nativeVendors.find((vendor) => vendor?.id === route)
  const manager = capabilities?.llmManager
  const setupLink = localBrowser ? claudeSetupLink(capabilities?.claudeApi) : null

  const reload = () => {
    setSnapshot({ status: 'configLoading' })
    setCapabilities(undefined)
    setMessage('')
    setRefresh((current) => current + 1)
  }
  const save = async (event) => {
    event.preventDefault()
    if (!canSave) return
    setBusy(true)
    setMessage('')
    const config = { ...snapshot.config, sync: { ...snapshot.config.sync, model: selection } }
    const saved = await saveProjectConfig(PROJECT_ID, `${JSON.stringify(config, null, 2)}\n`, snapshot.revision)
    setBusy(false)
    if (!saved.ok) {
      setMessage(saved.status === 409 ? 'syncModelConflict' : 'configSaveFailed')
      return
    }
    const persisted = readConfig(saved)
    setSnapshot(persisted)
    setMessage(persisted.config?.sync.model === selection ? 'syncModelSaved' : 'syncModelLoadFailed')
  }

  return (
    <>
      <p className="set-hint set-section-copy">{t('settings.syncModelDescription')}</p>
      <form onSubmit={save}>
        {!localProject ? <p className="set-hint" role="status">{t(PROJECT_MACHINE_ID ? 'settings.syncModelRemote' : 'settings.syncModelNoProject')}</p>
          : snapshot.status ? <p className="set-hint" role="status">{t(`settings.${snapshot.status}`)}</p> : <>
            <Row label={t('settings.syncModelRoute')} htmlFor={routeId}>
              <div className="set-launcher-fields" style={{ display: 'contents' }}>
                <select id={routeId} value={route} disabled={busy || conflicted} style={{ width: 'min(100%, 24rem)' }}
                  onChange={(event) => { setRoute(event.target.value); setModel(''); setMessage('') }}>
                  <option value="" disabled>{t(snapshot.config.sync.model === undefined ? 'settings.syncModelUnpinned' : 'settings.syncModelPick')}</option>
                  <option value={managed}>{t('settings.syncModelManager')}</option>
                  {vendors.map((vendor) => <option key={vendor} value={vendor}>{t(`settings.syncVendor.${vendor}`)}</option>)}
                </select>
              </div>
            </Row>
            {native && <>
              <Row label={t('settings.syncModelExact')} htmlFor={modelId}>
                <div className="set-launcher-fields" style={{ display: 'contents' }}>
                  <input id={modelId} value={model} disabled={busy || conflicted} style={{ width: 'min(100%, 24rem)' }}
                    aria-invalid={!validModel} aria-describedby={modelHintId} autoComplete="off" spellCheck={false}
                    placeholder={t('settings.syncModelCliDefault')} onChange={(event) => { setModel(event.target.value); setMessage('') }} />
                </div>
              </Row>
              <p className="set-hint" id={modelHintId}>{t(!validModel ? 'settings.syncModelInvalid'
                : route === 'zcode' ? 'settings.syncModelZcodeHint' : 'settings.syncModelNativeHint')}</p>
              {detectedVendor?.installed === false && <p className="set-hint">{t('settings.syncModelCliMissing')}</p>}
            </>}
            {route === managed && capabilities && <p className="set-hint" role="status">{manager?.configured
              ? (typeof manager.selection === 'string' ? t('settings.syncModelManagerSelection', { model: manager.selection }) : t('settings.syncModelManagerNoRoute'))
              : t('settings.syncModelManagerMissing')}</p>}
          </>}
        <div className="set-config-actions">
          {snapshot.config && <button className="set-action" type="submit" disabled={!canSave}>{t(busy ? 'settings.configSaving' : 'settings.configSave')}</button>}
          <button className="set-action" type="button" disabled={busy} onClick={reload}>{t('settings.configReload')}</button>
          {message && <span className="set-hint" role={message === 'syncModelSaved' ? 'status' : 'alert'}>{t(`settings.${message}`)}</span>}
        </div>
      </form>
      <Row label={t('settings.claudeApi')}>
        {setupLink
          ? <a className="set-action" style={{ display: 'inline-flex', alignItems: 'center' }} href={setupLink} target="_blank" rel="noopener noreferrer">{t('settings.claudeApiOpen')}</a>
          : <span className="set-hint" role="status">{t(!localBrowser ? 'settings.claudeApiLocal'
            : capabilities === undefined ? 'settings.configLoading'
              : capabilities === null ? 'settings.syncModelStatusFailed' : 'settings.claudeApiUnavailable')}</span>}
      </Row>
      {setupLink && <p className="set-hint">{t('settings.claudeApiDescription')}</p>}
    </>
  )
}
