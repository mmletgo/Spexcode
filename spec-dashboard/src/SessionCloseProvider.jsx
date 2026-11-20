import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { apiFetch } from './data.js'
import { canControlSession, sessionHeadline } from './session.js'
import { useBoard, useBoardApi } from './workspace.jsx'
import { useTransientNotice } from './TransientNotice.jsx'
import { useT } from './i18n/index.jsx'

const CloseApi = createContext(null)
const CloseState = createContext(new Map())

export function SessionCloseProvider({ children }) {
  const { sessions } = useBoard()
  const { reload } = useBoardApi()
  const { notify, dismiss } = useTransientNotice()
  const t = useT()
  const requests = useRef(new Map())
  const [snapshot, setSnapshot] = useState(requests.current)
  const publish = useCallback(() => setSnapshot(new Map(requests.current)), [])

  const closeSession = useCallback(async (session) => {
    if (!canControlSession(session)) return
    const { id } = session
    const previous = requests.current.get(id)
    if (previous?.phase === 'pending') return
    if (previous?.notice) dismiss(previous.notice)
    requests.current.set(id, { phase: 'pending' })
    publish()
    try {
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' })
      const body = await response.json()
      if (!response.ok || body?.ok !== true) throw new Error(body?.error || `session close unconfirmed (HTTP ${response.status})`)
      requests.current.delete(id)
      publish()
      notify(`${sessionHeadline(session)} · ${t('sessionWindow.closeSucceeded')}`, { kind: 'success' })
      reload()
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      const notice = notify(`${sessionHeadline(session)} · ${t('sessionWindow.closeFailed')}: ${error} · ${t('sessionWindow.closeRetry')}`, {
        kind: 'error', duration: 0, onClick: () => { void closeSession(session) },
      })
      requests.current.set(id, { phase: 'failed', error, notice })
      publish()
    }
  }, [dismiss, notify, publish, reload, t])

  // An archive published elsewhere retires a stale retry callback as well as its row marker.
  useEffect(() => {
    const present = new Set(sessions.filter((session) => !session.archived).map((session) => session.id))
    let changed = false
    for (const [id, request] of requests.current) {
      if (request.phase !== 'failed' || present.has(id)) continue
      dismiss(request.notice)
      requests.current.delete(id)
      changed = true
    }
    if (changed) publish()
  }, [sessions, snapshot, dismiss, publish])

  return <CloseApi.Provider value={closeSession}><CloseState.Provider value={snapshot}>{children}</CloseState.Provider></CloseApi.Provider>
}

export const useCloseSession = () => useContext(CloseApi)
export const useSessionCloseState = (id) => useContext(CloseState).get(id)
