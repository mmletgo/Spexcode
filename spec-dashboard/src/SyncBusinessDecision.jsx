import { useRef, useState } from 'react'
import { decideSync, requestIdentity } from './syncApplication.js'
import { useT } from './i18n/index.jsx'

export default function SyncBusinessDecision({ detail, targetTree, disabled, onSubmitted }) {
  const t = useT()
  const [selected, setSelected] = useState([])
  const [rule, setRule] = useState('')
  const [writingRule, setWritingRule] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const request = useRef(null)
  const busyRef = useRef(false)
  const { operation, decisionContext } = detail
  const pending = ['needs_input', 'conflicted'].includes(operation.phase) || !!operation.blockedReason
  const submit = async (choice) => {
    if (busyRef.current) return
    const payload = { operationId: operation.id, inputId: operation.input.id, analysisRef: decisionContext.analysisRef, findingIds: selected, decision: choice === 'new_rule' ? { choice, rule } : { choice } }
    request.current = requestIdentity(request.current, payload)
    busyRef.current = true; setBusy(true); setError(null)
    try { await decideSync(operation.id, { ...payload, requestId: request.current.id }, targetTree); onSubmitted() }
    catch (failure) { setError(`${failure.code}: ${failure.message}`) }
    finally { busyRef.current = false; setBusy(false) }
  }
  return <div className="sync-business-decision">
    <h3>{t('syncOperation.decision.title')}</h3>
    <p className="sync-op-note">{t('syncOperation.decision.note')}</p>
    <p>{t('syncOperation.decision.baseline')} <code>{operation.previousBaselinePair?.id || t('syncOperation.decision.noBaseline')}</code></p>
    {decisionContext.analysis.findings.map(finding => <fieldset key={finding.id}>
      <legend><label><input type="checkbox" checked={selected.includes(finding.id)} disabled={disabled || busy || !pending} onChange={event => setSelected(previous => event.target.checked ? [...previous, finding.id] : previous.filter(id => id !== finding.id))} /> {finding.id} · {t(`syncOperation.decision.${finding.kind}`)}</label></legend>
      <dl>
        <div><dt>{t('syncOperation.decision.intent')}</dt><dd>{finding.originalIntent}</dd></div>
        <div><dt>{t('syncOperation.decision.source')}</dt><dd>{finding.sourceBehavior}</dd></div>
        <div><dt>{t('syncOperation.decision.delivery')}</dt><dd>{finding.deliveryBehavior}</dd></div>
        <div><dt>{t('syncOperation.decision.affected')}</dt><dd>{[...new Set([...finding.ruleIds, ...finding.affectedIds])].join(', ')} · {finding.paths.join(', ')}</dd></div>
        <div><dt>{t('syncOperation.decision.counterexample')}</dt><dd>{finding.counterexample}</dd></div>
        <div><dt>{t('syncOperation.decision.evidence')}</dt><dd>{finding.evidence}</dd></div>
        <div><dt>{t('syncOperation.decision.question')}</dt><dd>{finding.decision}</dd></div>
      </dl>
    </fieldset>)}
    {pending && <div className="sync-op-actions">
      <button type="button" disabled={disabled || busy || !selected.length} onClick={() => submit('keep_intent')}>{t('syncOperation.decision.keep_intent')}</button>
      <button type="button" disabled={disabled || busy || !selected.length} onClick={() => submit('adopt_behavior')}>{t('syncOperation.decision.adopt_behavior')}</button>
      <button type="button" disabled={disabled || busy || !selected.length} aria-expanded={writingRule} onClick={() => setWritingRule(value => !value)}>{t('syncOperation.decision.new_rule')}</button>
    </div>}
    {pending && writingRule && <form onSubmit={event => { event.preventDefault(); void submit('new_rule') }}>
      <label>{t('syncOperation.decision.rule')}<textarea value={rule} disabled={disabled || busy} onChange={event => setRule(event.target.value)} required /></label>
      <button type="submit" disabled={disabled || busy || !selected.length || !rule.trim()}>{t('syncOperation.decision.submitRule')}</button>
    </form>}
    {error && <p className="sync-op-error" role="alert">{error}</p>}
  </div>
}
