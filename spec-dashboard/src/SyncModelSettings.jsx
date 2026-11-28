import { useEffect, useState } from 'react'
import { apiUrl, PROJECT_ID, PROJECT_MACHINE_ID } from './project.js'

const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

export default function SyncModelSettings({ t }) {
  const [manager, setManager] = useState(undefined)
  const localConsole = !!PROJECT_ID && !PROJECT_MACHINE_ID && isLoopback(globalThis.location?.hostname)

  useEffect(() => {
    if (PROJECT_MACHINE_ID) return
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch(apiUrl('/api/sync/model-settings'), {
          signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' },
        })
        const status = response.ok ? await response.json() : null
        if (!controller.signal.aborted) setManager(status?.llmManager ?? null)
      } catch {
        if (!controller.signal.aborted) setManager(null)
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  if (PROJECT_MACHINE_ID) return <p className="set-hint" role="status">{t('settings.syncModelManagerLocal')}</p>
  if (manager === undefined) return <p className="set-hint" role="status">{t('settings.configLoading')}</p>
  if (manager === null) return <p className="set-hint" role="status">{t('settings.syncModelStatusFailed')}</p>
  if (manager.authoritative !== true) return <p className="set-hint" role="status">{t('settings.syncModelManagerRequired')}</p>

  return (
    <>
      <p className="set-hint set-section-copy" role="status">
        {typeof manager.selection === 'string'
          ? t('settings.syncModelManagerSelection', { model: manager.selection })
          : t('settings.syncModelManagerNoRoute')}
      </p>
      {localConsole && manager.settingsPath === '/llm-manager/'
        ? <a className="set-action" style={{ display: 'inline-flex', alignItems: 'center' }} href={manager.settingsPath}>
            {t('settings.syncModelManagerOpen')}
          </a>
        : <p className="set-hint" role="status">
            {t(localConsole ? 'settings.syncModelManagerUnavailable' : 'settings.syncModelManagerLocal')}
          </p>}
    </>
  )
}
