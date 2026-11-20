import { useEffect, useMemo, useState } from 'react'
import { TranscriptView } from '@spexcode/transcript-ui'
import { loadSessionTranscript } from './data.js'
import { DashboardTranscriptUi } from './Transcript.jsx'
import { SessionFilesContext } from './fileRefs.js'
import { IconButton } from './icons.jsx'
import { useT } from './i18n/index.jsx'

const PAGE_MS = 30 * 60 * 1000
const latestWindow = () => {
  const to = (Math.floor(Date.now() / PAGE_MS) + 1) * PAGE_MS
  return { from: to - PAGE_MS, to }
}

export default function ExternalSessionConversation({ session, active = true, tabs = false }) {
  const t = useT()
  const [range, setRange] = useState(latestWindow)
  const [result, setResult] = useState(null)
  const files = useMemo(() => ({ sessionId: session.id, files: session.files || [], tabs }), [session.id, session.files, tabs])
  useEffect(() => {
    if (!active) return
    let cancelled = false
    loadSessionTranscript(session.id, range.from, range.to).then((answer) => {
      if (!cancelled) setResult({ ...answer, range })
    }).catch((error) => {
      if (!cancelled) setResult({ ok: false, error: error.message, range })
    })
    return () => { cancelled = true }
  }, [active, session.id, range])
  const shift = (delta) => setRange({ from: range.from + delta * PAGE_MS, to: range.to + delta * PAGE_MS })
  return (
    <SessionFilesContext.Provider value={files}>
      <DashboardTranscriptUi>
        <div className="tl-chat">
          <div className="m-timeline" data-reading-surface>
            <div className="m-col">
              <div className="external-transcript-controls">
                <span>{t('session.externalReadOnly')}</span>
                <IconButton className="si-command-tool" size={14} icon="chevron-left" label={t('session.externalEarlier')} onClick={() => shift(-1)} />
                <time dateTime={new Date(range.from).toISOString()}>{new Date(range.from).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</time>
                <IconButton className="si-command-tool" size={14} icon="chevron-right" label={t('session.externalLater')} disabled={range.to >= Date.now()} onClick={() => shift(1)} />
                <IconButton className="si-command-tool" size={14} icon="rotate-ccw" label={t('session.externalLatest')} onClick={() => setRange(latestWindow())} />
              </div>
              {result?.range !== range
                ? <div className="m-empty">{t('common.loading')}</div>
                : result.ok ? <TranscriptView data={result.data} /> : <div className="m-empty" role="status">{result.error}</div>}
            </div>
          </div>
        </div>
      </DashboardTranscriptUi>
    </SessionFilesContext.Provider>
  )
}
