import { useEffect, useState } from 'react'
import { DiffEvidence } from './NodeView.jsx'
import { usePaneActive } from './workspace.jsx'
import { useT } from './i18n/index.jsx'
import { readSyncDiff, readSyncEvidence } from './syncApplication.js'

const DIFF_LABELS = { candidate: 'syncOperation.candidateDiff', delivery: 'syncOperation.deliveryDiff', request: 'syncOperation.requestDiff' }

function FileDiff({ operationId, path, kind, targetTree }) {
  const t = useT()
  const active = usePaneActive()
  const [open, setOpen] = useState(false)
  const [held, setHeld] = useState(null)
  useEffect(() => {
    if (!open || !active) return undefined
    const controller = new AbortController()
    readSyncDiff(operationId, path, kind, targetTree, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setHeld(value) })
      .catch((error) => { if (!controller.signal.aborted) setHeld({ error: `${error.code || 'network-error'}: ${error.message}` }) })
    return () => controller.abort()
  }, [open, active, operationId, path, kind, targetTree])
  return <details className="sync-op-file-diff" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><code>{path}</code></summary>
    {open && <figure>{held?.patch && !/^@@ /m.test(held.patch)
      ? <><figcaption className="ev-difflabel">{t(DIFF_LABELS[kind])}</figcaption><pre className="ev-diff">{held.patch}</pre></>
      : <DiffEvidence diff={held} label={t(DIFF_LABELS[kind])} />}</figure>}
  </details>
}

export default function SyncOperationDiff({ operationId, files = null, candidateReference = null, kind = 'candidate', targetTree = null }) {
  const t = useT()
  const active = usePaneActive()
  const [open, setOpen] = useState(false)
  const [held, setHeld] = useState(null)
  useEffect(() => {
    if (files || !open || !active) return undefined
    const controller = new AbortController()
    readSyncEvidence(operationId, candidateReference.sha256, targetTree, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setHeld({ files: value }) })
      .catch((error) => { if (!controller.signal.aborted) setHeld({ error: `${error.code || 'network-error'}: ${error.message}` }) })
    return () => controller.abort()
  }, [files, open, active, operationId, candidateReference?.sha256, targetTree])
  const current = files || held?.files
  return <details className="sync-op-diff-list" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t(kind === 'request' ? 'syncOperation.requestReview' : kind === 'candidate' ? 'syncOperation.candidateReview' : 'syncOperation.deliveryReview')}</summary>
    {open && <>
      <p className="sync-op-note">{t(kind === 'request' ? 'syncOperation.requestOnly' : kind === 'candidate' ? 'syncOperation.candidateOnly' : 'syncOperation.deliveryFull')}</p>
      {held?.error ? <p className="sync-op-error" role="alert">{held.error}</p> : !current ? <p>{t('common.loading')}</p>
        : current.map((file) => <FileDiff key={file.path} operationId={operationId} path={file.path} kind={kind} targetTree={targetTree} />)}
    </>}
  </details>
}
