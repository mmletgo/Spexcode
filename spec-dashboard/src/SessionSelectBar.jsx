import { useState } from 'react'
import { IconButton } from './icons.jsx'
import SessionCloseDialog from './SessionCloseDialog.jsx'
import { useCloseSession } from './SessionCloseProvider.jsx'
import { canControlSession } from './session.js'
import { useT } from './i18n/index.jsx'

export default function SessionSelectBar({ sessions, onCancel }) {
  const t = useT()
  const closeSession = useCloseSession()
  const [confirming, setConfirming] = useState(null)
  const closable = sessions.filter(canControlSession)
  return <>
    <div className="si-selbar">
      <span className="si-selcount">{t('sessionSelect.selected', { n: sessions.length })}</span>
      <IconButton icon="trash" size={14} className="si-selaction danger" label={t('sessionSelect.close')}
        disabled={!closable.length} onClick={() => setConfirming(closable)} />
      <IconButton icon="x" size={14} className="si-selaction" label={t('common.cancel')} onClick={onCancel} />
    </div>
    {confirming && <SessionCloseDialog count={confirming.length} onConfirm={() => {
      confirming.forEach((session) => { void closeSession(session) })
      onCancel()
    }} onClose={() => setConfirming(null)} />}
  </>
}
