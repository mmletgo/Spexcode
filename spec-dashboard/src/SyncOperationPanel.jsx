import { useEffect, useRef, useState } from 'react'
import { controlSync, enableSync, evidenceProjection, readSyncEvidence, readSyncStatus, requestIdentity, runSync, syncProjection } from './syncApplication.js'
import { useT } from './i18n/index.jsx'
import { useBoard, usePaneActive } from './workspace.jsx'
import { routeHash } from './route.js'
import { newTabAnchor } from './tabs.js'
import SyncOperationDiff from './SyncOperationDiff.jsx'

function EvidenceRead({ operationId, reference, targetTree, label, request = false }) {
  const t = useT()
  const active = usePaneActive()
  const [open, setOpen] = useState(request)
  const [held, setHeld] = useState(null)
  useEffect(() => {
    if (!open || !active) return undefined
    const controller = new AbortController()
    readSyncEvidence(operationId, reference.sha256, targetTree, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setHeld({ value: evidenceProjection(value), resultRef: value.resultRef }) })
      .catch((error) => { if (!controller.signal.aborted) setHeld({ error: `${error.code}: ${error.message}` }) })
    return () => controller.abort()
  }, [open, active, operationId, reference.sha256, targetTree])
  if (request) return <div className="sync-op-evidence" aria-label={label}>
    <h3>{label}</h3>
    <p className="sync-op-note">{t('syncOperation.requestNote')}</p>
    {held?.error ? <p role="alert">{held.error}</p> : !held ? <p>{t('common.loading')}</p> : <>
      <p>{held.value.origin.intent}</p>
      <SyncOperationDiff operationId={operationId} files={[{ path: held.value.path }]} targetTree={targetTree} kind="request" />
    </>}
  </div>
  return <details className="sync-op-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && held?.resultRef && <EvidenceRead operationId={operationId} reference={held.resultRef} targetTree={targetTree} label={t('syncOperation.stageResult')} />}
    {open && (held?.error ? <p role="alert">{held.error}</p> : held ? <pre>{JSON.stringify(held.value, null, 2)}</pre> : <p>{t('common.loading')}</p>)}
  </details>
}

function OperationEvidence({ detail, model, nodeId, nodePath, targetTree }) {
  const t = useT()
  const { operation, attempt, journals } = detail
  const currentHref = model.deliveryRoot && routeHash('spec', nodeId, { targetTree: model.deliveryRoot })
  const receiptCommit = model.receipt?.actualCommit
  const diffHref = receiptCommit && model.settledJournal.plan.files.some((file) => file.path === nodePath) && routeHash('spec', nodeId, { targetTree: model.deliveryRoot, version: receiptCommit, surface: 'diff' })
  return <>
    {operation.requestBlob && <EvidenceRead operationId={operation.id} reference={operation.requestBlob} targetTree={targetTree} label={t('syncOperation.requestTitle')} request />}
    {currentHref && <p className="sync-op-delivery">
      <span>{t(model.complete ? 'syncOperation.delivery' : 'syncOperation.publishedDelivery')}</span> <code>{model.deliveryRoot}</code>
      <a href={currentHref} onClick={(event) => newTabAnchor(event, currentHref)}>{t('syncOperation.readDelivery')}</a>
      {diffHref && <a href={diffHref} onClick={(event) => newTabAnchor(event, diffHref)}>{t('syncOperation.readDiff')}</a>}
    </p>}
    <details className="sync-op-details">
      <summary>{t('syncOperation.evidence')}</summary>
      <dl>
        <div><dt>{t('syncOperation.source')}</dt><dd><code>{model.sourceRoot}</code></dd></div>
        <div><dt>{t('syncOperation.sourceBranch')}</dt><dd>{operation.input.source.branch}</dd></div>
        <div><dt>{t('syncOperation.operation')}</dt><dd><code>{operation.id}</code></dd></div>
        <div><dt>{t('syncOperation.input')}</dt><dd><code>{operation.input.id}</code></dd></div>
        <div><dt>{t('syncOperation.readSet')}</dt><dd><code>{operation.readSetDigest}</code></dd></div>
        <div><dt>{t('syncOperation.paths')}</dt><dd>{operation.scope.paths.join(', ') || '—'}</dd></div>
        <div><dt>{t('syncOperation.ready')}</dt><dd>{operation.readyScope.contractIds.join(', ') || '—'}</dd></div>
        <div><dt>{t('syncOperation.blocked')}</dt><dd>{operation.blockedScope.contractIds.join(', ') || '—'}</dd></div>
        {attempt && <div><dt>{t('syncOperation.attempt')}</dt><dd>{attempt.number} · {attempt.status}</dd></div>}
        {attempt?.candidate && <div><dt>{t('syncOperation.candidate')}</dt><dd><code>{attempt.candidate.digest}</code></dd></div>}
        {attempt?.verification && <div><dt>{t('syncOperation.verification')}</dt><dd>{t(attempt.verification.passed ? 'syncOperation.passed' : 'syncOperation.failed')}</dd></div>}
        {model.receipt && <div><dt>{t('syncOperation.receipt')}</dt><dd><code>{model.receipt.id}</code></dd></div>}
      </dl>
      <EvidenceRead operationId={operation.id} reference={operation.input.manifestBlob} targetTree={targetTree} label={t('syncOperation.sourceManifest')} />
      {operation.planBlob && <EvidenceRead operationId={operation.id} reference={operation.planBlob} targetTree={targetTree} label={t('syncOperation.authorizedScope')} />}
      {operation.contractScopeExpansions?.map((item) => <EvidenceRead key={item.evidenceRef.sha256} operationId={operation.id} reference={item.evidenceRef} targetTree={targetTree} label={t('syncOperation.scopeEvidence')} />)}
      {attempt?.candidate && <SyncOperationDiff operationId={operation.id} candidateReference={attempt.candidate.actualDiffBlob} targetTree={targetTree} />}
      {attempt?.verification && <EvidenceRead key={attempt.verification.resultBlob.sha256} operationId={operation.id} reference={attempt.verification.resultBlob} targetTree={targetTree} label={t('syncOperation.verificationEvidence')} />}
      {attempt?.checkpointRefs.map((reference, index) => <EvidenceRead key={reference.sha256} operationId={operation.id} reference={reference} targetTree={targetTree} label={t('syncOperation.checkpoint', { n: index + 1 })} />)}
      {model.failure?.evidenceRefs?.map((reference) => <EvidenceRead key={reference.sha256} operationId={operation.id} reference={reference} targetTree={targetTree} label={t('syncOperation.failureEvidence')} />)}
      {journals.map((journal) => <details key={journal.id}><summary>{t('syncOperation.apply')} · {journal.status} · {journal.steps.filter((step) => step.status === 'completed').length}/{journal.steps.length}</summary>{journal.status === 'settled' && journal.receipt ? <SyncOperationDiff operationId={operation.id} files={journal.plan.files} targetTree={targetTree} kind="delivery" /> : <pre>{JSON.stringify(journal.plan.files, null, 2)}</pre>}</details>)}
    </details>
  </>
}

export default function SyncOperationPanel({ nodeId, nodePath, targetTree = null, refreshKey = 0, submittedOperation = null, onSettings }) {
  const t = useT()
  const active = usePaneActive()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  const { contentRevision = 0 } = useBoard()
  const [held, setHeld] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const busyRef = useRef(false)
  const runRequest = useRef(null)
  const identity = `${targetTree || ''}/${nodeId}`
  useEffect(() => {
    if (!active || !visible || busy) return undefined
    let live = true
    let timer
    let controller
    const read = async () => {
      controller = new AbortController()
      try {
        const value = await readSyncStatus(nodeId, targetTree, controller.signal)
        if (!live) return
        setHeld({ identity, value }); setError((previous) => previous?.kind === 'action' ? previous : null); onSettings?.(value.settings)
      } catch (failure) {
        if (live) setError({ identity, kind: 'read', code: failure.code || 'network-error', message: failure.message })
      } finally {
        if (live) timer = setTimeout(read, 3000)
      }
    }
    void read()
    return () => { live = false; clearTimeout(timer); controller?.abort() }
  }, [active, nodeId, targetTree, identity, refresh, refreshKey, onSettings, busy, visible])
  const current = held?.identity === identity ? held.value : null
  const currentError = error?.identity === identity ? error : null
  const recent = current?.operations[0]
  const detail = submittedOperation && (!recent || submittedOperation.createdAtMs > recent.operation.createdAtMs) ? { operation: submittedOperation, attempt: null, journals: [], resources: [], retryEligibility: { eligible: false }, stale: false, sourceSynced: false, executionAvailability: { status: 'ready' } } : recent || null
  const settings = current?.settings
  const model = detail && syncProjection(detail, settings?.activation)
  const retryPhase = detail && ['failed', 'budget_exhausted', 'cancelled'].includes(detail.operation.phase)
  const retryOf = retryPhase && model.canRetry ? detail.operation.id : null
  const perform = async (action) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(action); setError(null)
    try {
      if (action === 'enable') await enableSync(settings.configDigest, targetTree)
      else if (action === 'run') {
        runRequest.current = requestIdentity(runRequest.current, { nodeId, targetTree, contentRevision, configDigest: settings.configDigest, staleOf: detail?.stale ? detail.operation.id : null, retryOf })
        const result = await runSync(nodeId, runRequest.current.id, targetTree, retryOf ? { retryOf, origin: detail.operation.origin } : undefined)
        if (result.operation) setHeld({ identity, value: { settings, operations: [{ operation: result.operation, attempt: null, journals: [], resources: [], retryEligibility: { eligible: false }, stale: false, sourceSynced: false, executionAvailability: { status: 'ready' } }] } })
      } else {
        const value = await controlSync(detail.operation.id, action, targetTree)
        setHeld({ identity, value: { settings, operations: [value] } })
      }
      setRefresh((value) => value + 1)
    } catch (failure) { setError({ identity, kind: 'action', code: failure.code || 'network-error', message: failure.message }) }
    finally { busyRef.current = false; setBusy(null) }
  }
  const state = currentError ? 'read_error' : targetTree ? 'readonly' : model?.state || (settings?.activation === 'invalidated' ? 'invalidated' : settings?.enabled ? 'idle' : 'disabled')
  return <section className="sync-operation" aria-label={t('syncOperation.title')} data-sync-state={currentError ? 'read_error' : state}>
    <div className="sync-op-head">
      <h2>{t('syncOperation.title')}</h2>
      <span role="status" className={model?.complete && !currentError ? 'sync-op-complete' : undefined}>{currentError || current || detail ? t(`syncOperation.phase.${state}`) : t('common.loading')}</span>
      <div className="sync-op-actions">
        {settings?.configuration && !settings.enabled && !targetTree && <button type="button" disabled={!!busy} onClick={() => perform('enable')}>{t('syncOperation.enable')}</button>}
        {settings?.enabled && !targetTree && <button type="button" disabled={!!busy || (model && (retryPhase && !detail.stale ? !model.canRetry : !['idle', 'stale', 'source_synced', 'workspace_synced', 'superseded'].includes(model.state)))} onClick={() => perform('run')}>{t(retryPhase && !detail.stale ? 'syncOperation.retryRun' : 'syncOperation.run')}</button>}
        {!targetTree && model?.canPause && <button type="button" disabled={!!busy} onClick={() => perform('pause')}>{t('syncOperation.pause')}</button>}
        {!targetTree && model?.canResume && <button type="button" disabled={!!busy} onClick={() => perform('resume')}>{t('syncOperation.resume')}</button>}
        {!targetTree && model?.canCancel && <button type="button" disabled={!!busy} onClick={() => perform('cancel')}>{t('syncOperation.cancel')}</button>}
        {!targetTree && model?.canRecover && <button type="button" disabled={!!busy} onClick={() => perform('recover')}>{t('syncOperation.recover')}</button>}
      </div>
    </div>
    {currentError && <p className="sync-op-error" role="alert"><code>{currentError.code}</code> · {currentError.message} <button type="button" onClick={() => { setError(null); setRefresh((value) => value + 1) }}>{t('syncOperation.retry')}</button></p>}
    {settings && <p className="sync-op-source">{t(targetTree ? 'syncOperation.viewedTree' : 'syncOperation.source')} <code>{settings.input.canonicalRoot}</code></p>}
    {!targetTree && settings?.configurationError && <p className="sync-op-error" role="alert"><code>{settings.configurationError.code}</code> · {settings.configurationError.message}</p>}
    {!targetTree && settings && !settings.configuration && <p className="sync-op-note">{t('syncOperation.configure')}</p>}
    {!targetTree && settings && <p className="sync-op-note">{t('syncOperation.currentCapabilities')}</p>}
    {model?.failure && <p className="sync-op-error" role="alert"><code>{model.failure.code}</code> · {model.failure.message}</p>}
    {retryPhase && !detail.stale && detail.retryEligibility?.reason && <p className="sync-op-note"><code>{detail.retryEligibility.reason.code}</code> · {detail.retryEligibility.reason.message}</p>}
    {detail && <OperationEvidence key={detail.operation.id} detail={detail} model={model} nodeId={nodeId} nodePath={nodePath} targetTree={targetTree} />}
  </section>
}
