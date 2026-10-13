import { useEffect, useId, useState } from 'react'
import { fetchSyncContractReport } from './data.js'
import { useT } from './i18n/index.jsx'
import { hasContractNode, selectContractScope } from './syncContractModel.js'
import './SyncContractPanel.css'

const KINDS = ['REQ', 'FLOW', 'STEP', 'STATE', 'EVENT', 'TR', 'RULE', 'AC', 'GAP', 'VERIFY']
const LOCATION_FIELDS = new Set(['id', 'kind', 'nodeId', 'path', 'line', 'source'])
const displayValue = (value) => Array.isArray(value) ? value.join(', ') || '—' : String(value ?? '—')

function ContractItem({ item, coverage, t }) {
  return <details className="sync-contract-item" data-contract-item={item.id}>
    <summary><code>{item.id}</code>{coverage && <span className={`sync-coverage-${coverage.status}`}>{t(`syncContract.${coverage.status}`)}</span>}</summary>
    <p className="sync-contract-location"><code>{item.nodeId} · {item.path}:{item.line}</code></p>
    {item.source && <p><b>source</b> <code>{item.source.kind}: {item.source.ref}</code></p>}
    <dl>{Object.entries(item).filter(([key]) => !LOCATION_FIELDS.has(key)).map(([key, value]) =>
      <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl>
    {coverage && <dl className="sync-contract-bindings">{['acceptanceIds', 'code', 'tests', 'verifyIds', 'blockedBy'].map((field) =>
      <div key={field}><dt>{t(`syncContract.${field}`)}</dt><dd>{displayValue(coverage[field])}</dd></div>)}</dl>}
  </details>
}

export default function SyncContractPanel({ nodeId, stamp, targetTree = null, enabled = true }) {
  const t = useT()
  const labelId = useId()
  const [held, setHeld] = useState(null)
  const [scope, setScope] = useState(nodeId)
  const [retry, setRetry] = useState(0)
  const identity = `${nodeId}/${targetTree || ''}`
  const requestKey = `${identity}/${stamp ?? ''}/${retry}`
  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    fetchSyncContractReport(targetTree).then((report) => {
      if (active) setHeld({ identity, key: requestKey, report })
    }).catch((error) => {
      if (active) setHeld((previous) => ({ identity, key: requestKey, report: previous?.identity === identity ? previous.report : null, error: error.message }))
    })
    return () => { active = false }
  }, [enabled, identity, requestKey, targetTree])

  const current = held?.identity === identity ? held : null
  if (!current) return null // Legacy nodes never flash an empty contract surface while discovering their schema.
  if (current.error && !current.report) return <section className="sync-contract-panel" aria-label={t('syncContract.title')}>
    <p role="alert">{t('syncContract.readFailed', { error: current.error })}</p>
    <button type="button" onClick={() => setRetry((value) => value + 1)}>{t('syncContract.retry')}</button>
  </section>
  const report = current.report
  if (!hasContractNode(report, nodeId)) return null
  const selected = scope === '*' || report.contracts.some((contract) => contract.nodeId === scope) ? scope : nodeId
  const view = selectContractScope(report, selected)
  const bound = view.coverage.filter((item) => item.status === 'bound').length
  const missing = view.matrix.filter((cell) => cell.status === 'missing').length
  const coverageById = new Map(view.coverage.map((item) => [item.id, item]))

  return <section className="sync-contract-panel" aria-label={t('syncContract.title')} aria-busy={current.key !== requestKey} data-sync-contract-panel>
    <header><h2>{t('syncContract.title')}</h2><span className="sync-contract-verification">verification: {report.verification}</span></header>
    <p className="sync-contract-note">{t('syncContract.readOnly')}</p>
    {current.key !== requestKey && <p className="sync-contract-note">{t('syncContract.refreshing')}</p>}
    {current.error && <div role="alert"><p>{t('syncContract.readFailed', { error: current.error })}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{t('syncContract.retry')}</button></div>}
    <p className="sync-contract-location"><b>{t('syncContract.targetTree')}</b> <code>{report.targetTree}</code></p>
    <p className="sync-contract-location"><b>digest</b> <code>{report.digest}</code></p>
    <label className="sync-contract-scope" htmlFor={labelId}>{t('syncContract.scope')}
      <select id={labelId} value={selected} onChange={(event) => setScope(event.target.value)}>
        <option value="*">{t('syncContract.allNodes')}</option>
        {!report.contracts.some((contract) => contract.nodeId === nodeId) && <option value={nodeId}>{nodeId}</option>}
        {report.contracts.map((contract) => <option key={contract.nodeId} value={contract.nodeId}>{contract.nodeId}</option>)}
      </select>
    </label>
    <p>{t('syncContract.coverage', { bound, total: view.coverage.length, missing, cells: view.matrix.length })}</p>
    {KINDS.map((kind) => {
      const items = view.items.filter((item) => item.kind === kind)
      if (!items.length) return null
      return <details className="sync-contract-group" key={kind} open={['REQ', 'FLOW', 'STEP'].includes(kind)}>
        <summary>{kind} <span>{items.length}</span></summary>
        {items.map((item) => <ContractItem key={item.id} item={item} coverage={coverageById.get(item.id)} t={t} />)}
      </details>
    })}
    {view.matrix.length > 0 && <details className="sync-contract-group" open>
      <summary>{t('syncContract.matrix')} <span>{view.matrix.length}</span></summary>
      <div className="sync-contract-table" tabIndex={0} role="region" aria-label={t('syncContract.matrix')}>
        <table><thead><tr>{['object', 'state', 'event', 'disposition', 'acceptanceIds', 'status'].map((key) => <th scope="col" key={key}>{t(`syncContract.${key}`)}</th>)}</tr></thead>
          <tbody>{view.matrix.map((cell) => <tr key={`${cell.object}/${cell.stateId}/${cell.eventId}`} data-matrix-cell>
            <td>{cell.object}</td><td><code>{cell.stateId}</code></td><td><code>{cell.eventId}</code></td>
            <td>{cell.transitionIds.length ? cell.transitionIds.map((id) => {
              const transition = view.byId.get(id)
              return <p key={id}><code>{id}</code> · {transition.disposition}{transition.to && <> → <code>{transition.to}</code></>}{transition.reason && <> · {transition.reason}</>}</p>
            }) : '—'}</td><td>{displayValue(cell.acceptanceIds)}</td><td className={`sync-coverage-${cell.status}`}>{t(`syncContract.${cell.status}`)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>}
    {view.gaps.length > 0 && <details className="sync-contract-group" open>
      <summary>{t('syncContract.gaps')} <span>{view.gaps.length}</span></summary>
      {view.gaps.map((gap) => {
        const item = view.byId.get(gap.id)
        return <div key={gap.id} className="sync-contract-gap" data-contract-gap={gap.id}>
          <h3><code>{gap.id}</code> · {gap.kind}</h3>
          {item && <><p>{item.unknown}</p><p><b>{t('syncContract.evidence')}</b> {item.evidence}</p><p><b>{t('syncContract.decision')}</b> {item.decision}</p><p><b>source</b> <code>{item.source.kind}: {item.source.ref}</code></p></>}
          <p><b>{t('syncContract.affectedIds')}</b> <code>{displayValue(gap.affectedIds)}</code></p>
          <p><b>{t('syncContract.nodeIds')}</b> <code>{displayValue(gap.nodeIds)}</code></p>
        </div>
      })}
    </details>}
    <details className="sync-contract-group" open={view.findings.length > 0}>
      <summary>{t('syncContract.findings')} <span>{view.findings.length}</span></summary>
      {view.findings.length ? <ul>{view.findings.map((finding, index) => <li key={`${finding.code}/${finding.itemId}/${index}`}>
        <b className={`sync-finding-${finding.severity}`}>{finding.severity}</b> · <code>{finding.code}</code> · {finding.message}
        <p className="sync-contract-location"><code>{finding.path}{finding.line ? `:${finding.line}` : ''} · {finding.itemId} {displayValue(finding.relatedIds)}</code></p>
      </li>)}</ul> : <p>{t('syncContract.noFindings')}</p>}
    </details>
  </section>
}
