import { useEffect, useRef, useState } from 'react'
import { automaticControl, controlSync, enableSync, evidenceProjection, readSyncEvidence, readSyncStatus, requestIdentity, revertSync, runSync, stopSyncWriter, syncObserverProjection, syncProjection } from './syncApplication.js'
import { useT } from './i18n/index.jsx'
import { useBoard, usePaneActive } from './workspace.jsx'
import { routeHash } from './route.js'
import { newTabAnchor } from './tabs.js'
import SyncBusinessDecision from './SyncBusinessDecision.jsx'
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
      .then((value) => { if (!controller.signal.aborted) setHeld({ value: evidenceProjection(value), resultRef: value.resultRef, originalRequestBlob: value.originalRequestBlob }) })
      .catch((error) => { if (!controller.signal.aborted) setHeld({ error: `${error.code}: ${error.message}` }) })
    return () => controller.abort()
  }, [open, active, operationId, reference.sha256, targetTree])
  if (request) return <div className="sync-op-evidence" aria-label={label}>
    <h3>{label}</h3>
    <p className="sync-op-note">{t('syncOperation.requestNote')}</p>
    {held?.error ? <p role="alert">{held.error}</p> : !held ? <p>{t('common.loading')}</p> : <>
      {held.value.type === 'sync.decision' ? <><p>{t(`syncOperation.decision.${held.value.decision.choice}`)}</p>{held.value.decision.rule && <p>{held.value.decision.rule}</p>}<p>{held.value.findingIds.join(', ')}</p><code>{held.value.operationId}</code>{held.originalRequestBlob && <EvidenceRead operationId={operationId} reference={held.originalRequestBlob} targetTree={targetTree} label={t('syncOperation.originalRequest')} request />}</> : <><p>{held.value.origin.intent}</p><SyncOperationDiff operationId={operationId} files={[{ path: held.value.path }]} targetTree={targetTree} kind="request" /></>}
    </>}
  </div>
  return <details className="sync-op-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && held?.resultRef && <EvidenceRead operationId={operationId} reference={held.resultRef} targetTree={targetTree} label={t('syncOperation.stageResult')} />}
    {open && (held?.error ? <p role="alert">{held.error}</p> : held ? <pre>{JSON.stringify(held.value, null, 2)}</pre> : <p>{t('common.loading')}</p>)}
  </details>
}

function observerTime(value) {
  return value == null ? null : new Date(value).toLocaleString()
}

function OperationEvidence({ detail, model, nodeId, nodePath, targetTree, canRevert, busy, onRevert }) {
  const t = useT()
  const { operation, attempt, journals } = detail
  const currentHref = model.deliveryRoot && routeHash('spec', nodeId, { targetTree: model.deliveryRoot })
  const receiptCommit = model.receipt?.actualCommit
  const diffHref = receiptCommit && model.settledJournal.plan.files.some((file) => file.path === nodePath) && routeHash('spec', nodeId, { targetTree: model.deliveryRoot, version: receiptCommit, surface: 'diff' })
  return <>
    {operation.requestBlob && <EvidenceRead operationId={operation.id} reference={operation.requestBlob} targetTree={targetTree} label={t('syncOperation.requestTitle')} request />}
    {currentHref && <p className="sync-op-delivery">
      <span>{t(model.complete ? 'syncOperation.delivery' : 'syncOperation.publishedDelivery')}</span> <code>{model.deliveryRoot}</code>
      {model.receipt?.deliverySnapshot?.source?.branch && <span> · {t('syncOperation.deliveryBranch', { branch: model.receipt.deliverySnapshot.source.branch })}</span>}
      <a href={currentHref} onClick={(event) => newTabAnchor(event, currentHref)}>{t('syncOperation.readDelivery')}</a>
      {diffHref && <a href={diffHref} onClick={(event) => newTabAnchor(event, diffHref)}>{t('syncOperation.readDiff')}</a>}
    </p>}
    <details className="sync-op-details">
      <summary>{t('syncOperation.evidence')}</summary>
      <dl>
        <div><dt>{t('syncOperation.source')}</dt><dd><code>{model.sourceRoot}</code></dd></div>
        <div><dt>{t('syncOperation.sourceBranch')}</dt><dd>{operation.input.source.branch}</dd></div>
        <div><dt>{t('syncOperation.deliveryPlanBranch')}</dt><dd>{operation.deliveryPlan.branch}</dd></div>
        <div><dt>{t('syncOperation.operation')}</dt><dd><code>{operation.id}</code></dd></div>
        <div><dt>{t('syncOperation.input')}</dt><dd><code>{operation.input.id}</code></dd></div>
        <div><dt>{t('syncOperation.readSet')}</dt><dd><code>{operation.readSetDigest}</code></dd></div>
        <div><dt>{t('syncOperation.paths')}</dt><dd>{operation.scope.paths.join(', ') || '—'}</dd></div>
        <div><dt>{t('syncOperation.ready')}</dt><dd>{operation.readyScope.contractIds.join(', ') || '—'}</dd></div>
        <div><dt>{t('syncOperation.blocked')}</dt><dd>{operation.blockedScope.contractIds.join(', ') || '—'}</dd></div>
        {attempt && <div><dt>{t('syncOperation.attempt')}</dt><dd>{attempt.number} · {attempt.status}</dd></div>}
        {attempt?.candidate && <div><dt>{t('syncOperation.candidate')}</dt><dd><code>{attempt.candidate.digest}</code></dd></div>}
        {attempt?.verification && <div><dt>{t('syncOperation.verification')}</dt><dd>{t(attempt.verification.passed ? 'syncOperation.passed' : 'syncOperation.failed')}</dd></div>}
        {model.receipt && <>
          <div><dt>{t('syncOperation.receipt')}</dt><dd><code>{model.receipt.id}</code></dd></div>
          <div><dt>{t('syncOperation.actualDeliveryCommit')}</dt><dd>{model.receipt.deliverySnapshot.source.branch} · <code>{model.receipt.actualCommit || model.receipt.actualTree}</code></dd></div>
        </>}
      </dl>
      <EvidenceRead operationId={operation.id} reference={operation.input.manifestBlob} targetTree={targetTree} label={t('syncOperation.sourceManifest')} />
      {operation.planBlob && <EvidenceRead operationId={operation.id} reference={operation.planBlob} targetTree={targetTree} label={t('syncOperation.authorizedScope')} />}
      {operation.contractScopeExpansions?.map((item) => <EvidenceRead key={item.evidenceRef.sha256} operationId={operation.id} reference={item.evidenceRef} targetTree={targetTree} label={t('syncOperation.scopeEvidence')} />)}
      {attempt?.candidate && <SyncOperationDiff operationId={operation.id} candidateReference={attempt.candidate.actualDiffBlob} targetTree={targetTree} />}
      {attempt?.verification && <EvidenceRead key={attempt.verification.resultBlob.sha256} operationId={operation.id} reference={attempt.verification.resultBlob} targetTree={targetTree} label={t('syncOperation.verificationEvidence')} />}
      {attempt?.checkpointRefs.map((reference, index) => <EvidenceRead key={reference.sha256} operationId={operation.id} reference={reference} targetTree={targetTree} label={t('syncOperation.checkpoint', { n: index + 1 })} />)}
      {model.failure?.evidenceRefs?.map((reference) => <EvidenceRead key={reference.sha256} operationId={operation.id} reference={reference} targetTree={targetTree} label={t('syncOperation.failureEvidence')} />)}
      {journals.map((journal) => <details key={journal.id}><summary>{t('syncOperation.apply')} · {journal.status} · {journal.steps.filter((step) => step.status === 'completed').length}/{journal.steps.length}</summary>{journal.status === 'settled' && journal.receipt ? <SyncOperationDiff operationId={operation.id} files={journal.plan.files} targetTree={targetTree} kind="delivery" /> : <pre>{JSON.stringify(journal.plan.files, null, 2)}</pre>}</details>)}
      {!targetTree && model.receipt && <div className="sync-op-revert">
        <p className="sync-op-note">{t('syncOperation.revertNote')}</p>
        {canRevert
          ? <button type="button" disabled={busy} onClick={onRevert}>{t('syncOperation.revert')}</button>
          : detail.revertEligibility?.reason && <p className="sync-op-note"><code>{detail.revertEligibility.reason.code}</code> · {detail.revertEligibility.reason.message}</p>}
      </div>}
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
  const [selectedOperationId, setSelectedOperationId] = useState(null)
  const [writerStopped, setWriterStopped] = useState(false)
  const [notice, setNotice] = useState(null)
  const busyRef = useRef(false)
  const runRequest = useRef(null)
  const revertRequestIds = useRef(new Map())
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
        if (value.observation.health?.watchOnline === true) setWriterStopped(false)
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
  const observer = syncObserverProjection(
    currentError?.kind === 'read' ? null : current?.observation,
    currentError?.kind === 'read' ? null : current?.sources,
  )
  const recent = current?.operations[0]
  const detail = submittedOperation && (!recent || submittedOperation.createdAtMs > recent.operation.createdAtMs) ? { operation: submittedOperation, attempt: null, journals: [], resources: [], retryEligibility: { eligible: false }, decisionEligibility: { eligible: false }, stale: false, sourceSynced: false, executionAvailability: { status: 'ready' } } : current?.operations.find(item => item.operation.id === selectedOperationId) || recent || null
  const settings = current?.settings
  const model = detail && syncProjection(detail, settings?.activation)
  const retryPhase = detail && ['failed', 'budget_exhausted', 'cancelled'].includes(detail.operation.phase)
  const retryOf = retryPhase && model.canRetry ? detail.operation.id : null
  const perform = async (action) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(action); setError(null)
    try {
      if (action === 'enable') await enableSync(settings.configDigest, targetTree)
      else if (action === 'run' || action === 'code') {
        runRequest.current = requestIdentity(runRequest.current, { nodeId, targetTree, contentRevision, configDigest: settings.configDigest, staleOf: detail?.stale ? detail.operation.id : null, retryOf: action === 'run' ? retryOf : null, origin: action === 'code' ? 'code' : 'initial' })
        const result = await runSync(nodeId, runRequest.current.id, targetTree, action === 'code' ? { origin: 'code' } : retryOf ? { retryOf, origin: detail.operation.origin } : undefined)
        if (result.operation) setHeld({ identity, value: { settings, operations: [{ operation: result.operation, attempt: null, journals: [], resources: [], retryEligibility: { eligible: false }, decisionEligibility: { eligible: false }, stale: false, sourceSynced: false, executionAvailability: { status: 'ready' } }] } })
      } else {
        const value = await controlSync(detail.operation.id, action, targetTree)
        setHeld({ identity, value: { settings, operations: [value] } })
      }
      setRefresh((value) => value + 1)
    } catch (failure) { setError({ identity, kind: 'action', retry: { kind: 'operation', action }, code: failure.code || 'network-error', message: failure.message }) }
    finally { busyRef.current = false; setBusy(null) }
  }
  const performAutomatic = async (action) => {
    if (busyRef.current || targetTree || settings?.enabled !== true || !observer.control) return
    busyRef.current = true; setBusy(`automatic_${action}`); setError(null)
    try {
      const observation = await automaticControl(action, targetTree)
      setHeld(previous => {
        if (previous?.identity !== identity) return previous
        const sources = Array.isArray(previous.value.sources)
          ? previous.value.sources.map(source => source.source?.canonicalRoot === settings.input.canonicalRoot
            ? { ...source, control: observation.control }
            : source)
          : previous.value.sources
        return { ...previous, value: { ...previous.value, observation, sources } }
      })
      if (action === 'resume') setWriterStopped(false)
      setRefresh(value => value + 1)
    } catch (failure) {
      setError({ identity, kind: 'action', retry: { kind: 'automatic', action }, code: failure.code || 'network-error', message: failure.message })
    } finally { busyRef.current = false; setBusy(null) }
  }
  const performRevert = async (operationId) => {
    if (busyRef.current || targetTree || settings?.enabled !== true) return
    let request = revertRequestIds.current.get(operationId)
    if (!request) {
      request = requestIdentity(null, { operationId, nodeId })
      revertRequestIds.current.set(operationId, request)
    }
    busyRef.current = true; setBusy('revert'); setError(null); setNotice(null)
    try {
      const result = await revertSync(operationId, request.id)
      if (result.operation) setSelectedOperationId(result.operation.id)
      setNotice(result.changed ? 'revertSubmitted' : 'revertNoChanges')
      setRefresh(value => value + 1)
    } catch (failure) {
      setError({ identity, kind: 'action', retry: { kind: 'revert', operationId }, code: failure.code || 'network-error', message: failure.message })
    } finally { busyRef.current = false; setBusy(null) }
  }
  const performStopWriter = async () => {
    if (busyRef.current || targetTree || settings?.enabled !== true || currentError?.kind === 'read') return
    busyRef.current = true; setBusy('stop_writer'); setError(null); setNotice(null)
    try {
      const result = await stopSyncWriter()
      setHeld(previous => {
        if (previous?.identity !== identity) return previous
        const observation = previous.value.observation
          ? { ...previous.value.observation, control: result.control }
          : previous.value.observation
        const sources = Array.isArray(previous.value.sources)
          ? previous.value.sources.map(source => source.source?.canonicalRoot === settings.input.canonicalRoot
            ? { ...source, control: result.control }
            : source)
          : previous.value.sources
        return { ...previous, value: { ...previous.value, observation, sources } }
      })
      setWriterStopped(true)
      setRefresh(value => value + 1)
    } catch (failure) {
      setError({ identity, kind: 'action', retry: { kind: 'writer_stop' }, code: failure.code || 'network-error', message: failure.message })
    } finally { busyRef.current = false; setBusy(null) }
  }
  const state = currentError?.kind === 'read' ? 'read_error' : targetTree ? 'readonly' : model?.state || (settings?.activation === 'invalidated' ? 'invalidated' : settings?.enabled ? 'idle' : 'disabled')
  const currentErrorMessage = currentError?.code === 'sync_response_invalid'
    ? t('syncOperation.statusResponseInvalid')
    : currentError?.message
  return <section className="sync-operation" aria-label={t('syncOperation.title')} data-sync-state={state}>
    <div className="sync-op-head">
      <h2>{t('syncOperation.title')}</h2>
      <span role="status" className={model?.complete && !currentError ? 'sync-op-complete' : undefined}>{currentError || current || detail ? t(`syncOperation.phase.${state}`) : t('common.loading')}</span>
      <div className="sync-op-actions">
        {settings?.configuration && !settings.enabled && !targetTree && <button type="button" disabled={!!busy} onClick={() => perform('enable')}>{t('syncOperation.enable')}</button>}
        {settings?.enabled && !targetTree && <button type="button" disabled={!!busy || (model && (retryPhase && !detail.stale ? !model.canRetry : !['idle', 'stale', 'source_synced', 'workspace_synced', 'canonical_synced', 'superseded'].includes(model.state)))} onClick={() => perform('run')}>{t(retryPhase && !detail.stale ? 'syncOperation.retryRun' : 'syncOperation.run')}</button>}
        {settings?.enabled && !targetTree && <button type="button" disabled={!!busy || (model && !['idle', 'stale', 'source_synced', 'workspace_synced', 'canonical_synced', 'superseded'].includes(model.state))} onClick={() => perform('code')}>{t('syncOperation.runCode')}</button>}
        {!targetTree && model?.canPause && <button type="button" disabled={!!busy} onClick={() => perform('pause')}>{t('syncOperation.pause')}</button>}
        {!targetTree && model?.canResume && <button type="button" disabled={!!busy} onClick={() => perform('resume')}>{t('syncOperation.resume')}</button>}
        {!targetTree && model?.canCancel && <button type="button" disabled={!!busy} onClick={() => perform('cancel')}>{t('syncOperation.cancel')}</button>}
        {!targetTree && model?.canRecover && <button type="button" disabled={!!busy} onClick={() => perform('recover')}>{t('syncOperation.recover')}</button>}
      </div>
    </div>
    {currentError && <p className="sync-op-error" role="alert"><code>{currentError.code}</code> · {currentErrorMessage} <button type="button" disabled={!!busy} onClick={() => {
      if (currentError.retry?.kind === 'automatic' && !targetTree && settings?.enabled === true) void performAutomatic(currentError.retry.action)
      else if (currentError.retry?.kind === 'revert' && !targetTree && settings?.enabled === true) void performRevert(currentError.retry.operationId)
      else if (currentError.retry?.kind === 'writer_stop' && !targetTree && settings?.enabled === true) void performStopWriter()
      else if (currentError.retry?.kind === 'operation') void perform(currentError.retry.action)
      else { setError(null); setRefresh(value => value + 1) }
    }}>{t(currentError.retry && (currentError.retry.kind === 'operation'
      || currentError.retry.kind === 'revert' && !targetTree && settings?.enabled === true
      || currentError.retry.kind === 'writer_stop' && !targetTree && settings?.enabled === true
      || currentError.retry.kind === 'automatic' && !targetTree && settings?.enabled === true) ? 'syncOperation.retryAction' : 'syncOperation.retry')}</button></p>}
    {settings && <p className="sync-op-source">{t(targetTree ? 'syncOperation.viewedTree' : 'syncOperation.source')} <code>{settings.input.canonicalRoot}</code>{!targetTree && <span> · {t('syncOperation.sourceBranch')} <code>{settings.input.branch}</code></span>}</p>}
    {settings && !targetTree && <p className="sync-op-note">{t('syncOperation.configuredDeliveryRoot')} <code>{settings.deliveryRoot}</code></p>}
    {!targetTree && settings?.configurationError && <p className="sync-op-error" role="alert"><code>{settings.configurationError.code}</code> · {settings.configurationError.message}</p>}
    {!targetTree && settings && !settings.configuration && <p className="sync-op-note">{t('syncOperation.configure')}</p>}
    {!targetTree && settings && <p className="sync-op-note">{t('syncOperation.currentCapabilities')}</p>}
    {!targetTree && <section className="sync-op-observer" aria-label={t('syncOperation.observer.title')} data-observer-state={observer.healthStatus} data-automatic-control={observer.control || 'unavailable'}>
      <h3>{t('syncOperation.observer.title')}</h3>
      <p className="sync-op-observer-health"><span role="status" aria-live="polite">{!current && !currentError ? t('common.loading') : t(`syncOperation.observer.health.${observer.healthStatus}`)}</span>
        {current || currentError ? <> · {observer.healthStatus === 'unavailable' ? t('syncOperation.observer.scanUnavailable') : observer.lastScanAtMs == null ? t('syncOperation.observer.noScan') : <><span>{t('syncOperation.observer.lastScan')}</span> <time dateTime={new Date(observer.lastScanAtMs).toISOString()}>{observerTime(observer.lastScanAtMs)}</time></>}</> : null}
      </p>
      {observer.healthStatus === 'identity_unconfirmed' && <p className="sync-op-note">{t('syncOperation.observer.identityUnconfirmed')}</p>}
      {observer.reason && <div className="sync-op-note"><p>{observer.reason.message}</p><details><summary>{t('syncOperation.observer.diagnosticCode')}</summary><code>{observer.reason.code}</code></details></div>}
      {current && currentError?.kind !== 'read' && observer.healthStatus === 'unavailable' && <button type="button" disabled={!!busy} onClick={() => { setError(null); setRefresh(value => value + 1) }}>{t('syncOperation.retry')}</button>}
      <p className="sync-op-observer-control">{observer.control == null
        ? t('syncOperation.observer.controlUnavailable')
        : settings?.enabled !== true
          ? t('syncOperation.observer.automaticDisabled')
          : t(observer.control === 'pause' ? 'syncOperation.observer.automaticPaused' : 'syncOperation.observer.automaticReady')}</p>
      <p className="sync-op-note">{t(settings?.enabled === true ? 'syncOperation.observer.automaticNote' : 'syncOperation.observer.automaticDisabledNote')}</p>
      {settings?.enabled === true && observer.control && <div className="sync-op-actions">
        <button type="button" disabled={!!busy || currentError?.kind === 'read' || currentError?.retry?.kind === 'automatic'} onClick={() => performAutomatic(observer.control === 'pause' ? 'resume' : 'pause')}>
          {t(observer.control === 'pause' ? 'syncOperation.observer.resumeAutomatic' : 'syncOperation.observer.pauseAutomatic')}
        </button>
      </div>}
      {writerStopped && <p role="status" className="sync-op-note">{t('syncOperation.writerStopped')}</p>}
      {settings?.enabled === true && !writerStopped && observer.healthStatus !== 'offline' && <>
        <p className="sync-op-note">{t('syncOperation.writerStopNote')}</p>
        <div className="sync-op-actions">
          <button type="button" disabled={!!busy || currentError?.kind === 'read'} onClick={performStopWriter}>{t('syncOperation.stopWriter')}</button>
        </div>
      </>}
      <details className="sync-op-coverage">
        <summary>{observer.coverage
          ? t('syncOperation.observer.coverageSummary', { included: observer.coverage.includedNodeIds.length, total: observer.coverage.totalNodeCount })
          : t('syncOperation.observer.coverageUnavailable')}</summary>
        {observer.coverage && <dl>
          <div><dt>{t('syncOperation.observer.registeredRoots')}</dt><dd>{observer.registeredNodes?.join(', ') || t('syncOperation.observer.none')}</dd></div>
          <div><dt>{t('syncOperation.observer.included')}</dt><dd>{observer.coverage.includedNodeIds.length}/{observer.coverage.totalNodeCount} · {observer.coverage.includedNodeIds.join(', ') || t('syncOperation.observer.none')}</dd></div>
          <div><dt>{t('syncOperation.observer.readOnlyContext')}</dt><dd>{observer.coverage.contextNodeIds.length} · {observer.coverage.contextNodeIds.join(', ') || t('syncOperation.observer.none')}</dd></div>
          <div><dt>{t('syncOperation.observer.missing')}</dt><dd>{observer.coverage.missingNodeIds.length} · {observer.coverage.missingNodeIds.join(', ') || t('syncOperation.observer.none')}</dd></div>
          <div><dt>{t('syncOperation.observer.excluded')}</dt><dd>{observer.coverage.excludedNodeIds.length}/{observer.coverage.totalNodeCount} · {observer.coverage.excludedNodeIds.join(', ') || t('syncOperation.observer.none')}</dd></div>
        </dl>}
        {observer.coverage && <p className="sync-op-note">{t('syncOperation.observer.coverageNote')}</p>}
        {observer.baseline?.status === 'available' && <p>{t('syncOperation.observer.baselineSummary', {
          node: observer.baseline.nodeId || t('syncOperation.observer.unknownNode'),
          established: observer.baseline.establishedCount,
          total: observer.baseline.resourceCount,
          missing: observer.baseline.missingResources.length,
        })}{observer.baseline.missingResources.length > 0 && <> · {observer.baseline.missingResources.join(', ')}</>}</p>}
        {observer.baseline?.status === 'unavailable' && <p className="sync-op-note">{t('syncOperation.observer.baselineUnavailable', { node: observer.baseline.nodeId || t('syncOperation.observer.unknownNode') })}{observer.baseline.failure?.message ? ` · ${observer.baseline.failure.message}` : ''}</p>}
        {observer.latest && <p className="sync-op-note">{t('syncOperation.observer.latestOutcome', { outcome: t(`syncOperation.observer.outcome.${observer.latest.outcome}`) })}{observer.latest.reason?.message ? ` · ${observer.latest.reason.message}` : ''}</p>}
      </details>
      <details className="sync-op-sources">
        <summary>{observer.sources ? t('syncOperation.observer.sourcesSummary', { count: observer.sources.length }) : t('syncOperation.observer.sourcesUnavailable')}</summary>
        {observer.sources?.length === 0 && <p className="sync-op-note">{t('syncOperation.observer.noSources')}</p>}
        {observer.sources?.length > 0 && <ul>
          {observer.sources.map((source, index) => <li key={`${source.root || source.branch || ''}:${index}`}>
            <p className="sync-op-source"><code>{source.root || t('syncOperation.observer.unknownRoot')}</code>{source.branch && <> · {t('syncOperation.sourceBranch')} <code>{source.branch}</code></>}</p>
            <p className="sync-op-note">{t('syncOperation.observer.sourceStatus', { status: t(`syncOperation.observer.health.${source.healthStatus}`) })}
              {source.exists === false ? ` · ${t('syncOperation.observer.sourceMissing')}` : source.exists === true ? ` · ${t('syncOperation.observer.sourcePresent')}` : ''}
              {source.control ? ` · ${t(source.control === 'pause' ? 'syncOperation.observer.automaticPaused' : 'syncOperation.observer.automaticReady')}` : ''}
            </p>
            {source.registeredNodes && <p className="sync-op-note">{t('syncOperation.observer.registeredRoots')}: {source.registeredNodes.join(', ') || t('syncOperation.observer.none')}</p>}
            {source.latest && <p className="sync-op-note">{source.latest.observedAtMs == null ? t('syncOperation.observer.noObservation') : <>{t('syncOperation.observer.latestInputObservation')} <time dateTime={new Date(source.latest.observedAtMs).toISOString()}>{observerTime(source.latest.observedAtMs)}</time></>}{source.latest.outcome ? ` · ${t(`syncOperation.observer.outcome.${source.latest.outcome}`)}` : ''}{source.latest.reason?.message ? ` · ${source.latest.reason.message}` : ''}</p>}
            {!source.latest && <p className="sync-op-note">{t('syncOperation.observer.noObservation')}</p>}
          </li>)}
        </ul>}
      </details>
    </section>}
    {model?.sourceSynced && model?.canonicalSynced && <p className="sync-op-note">{t('syncOperation.sourceAccepted')}</p>}
    {current?.operations.length > 1 && <label className="sync-op-history">{t('syncOperation.history')} <select disabled={!!busy} value={detail.operation.id} onChange={event => { setSelectedOperationId(event.target.value); setNotice(null) }}>{current.operations.map(item => <option key={item.operation.id} value={item.operation.id}>{item.operation.origin} · {t(`syncOperation.phase.${item.operation.phase}`)} · {item.operation.id}</option>)}</select></label>}
    {notice && <p role="status" className="sync-op-note">{t(`syncOperation.${notice}`)}</p>}
    {model?.failure && <p className="sync-op-error" role="alert"><code>{model.failure.code}</code> · {model.failure.message}</p>}
    {retryPhase && !detail.stale && detail.retryEligibility?.reason && <p className="sync-op-note"><code>{detail.retryEligibility.reason.code}</code> · {detail.retryEligibility.reason.message}</p>}
    {detail?.decisionContext && <SyncBusinessDecision key={`decision:${detail.operation.id}`} detail={detail} targetTree={targetTree} disabled={!!busy || !!targetTree || !model.canDecide || !settings?.enabled} onSubmitted={() => setRefresh(value => value + 1)} />}
    {detail && <OperationEvidence key={`evidence:${detail.operation.id}`} detail={detail} model={model} nodeId={nodeId} nodePath={nodePath} targetTree={targetTree} canRevert={model.canRevert} busy={!!busy} onRevert={() => performRevert(detail.operation.id)} />}
  </section>
}
