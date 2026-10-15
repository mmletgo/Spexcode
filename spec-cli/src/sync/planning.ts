import { posix } from 'node:path'
import { loadSpecs } from '@spexcode/spec-core'
import { contractImpact, contractReferences } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { BaselinePair, BaselineResource, FrozenBaselineSelection, InputSnapshot, SyncScope } from './operation-types.js'
import { verifyBaselineSelection } from './composition.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { readEvidence, readObject, readTree, verifySnapshot } from './snapshot.js'
import { controlledDecisionIdentity } from './request-input.js'
import { readDecisionAuthority } from './code-behavior.js'
import type { CodeBehaviorAnalysis, SyncDecisionInput } from './writeback-types.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'

/** 冻结契约影响与既有节点治理共同决定闭包；目录授权允许新自然语言需求创建实现。 */
export async function buildSyncApplicationPlan(snapshot: InputSnapshot, nodeId: string, baseline?: BaselinePair | FrozenBaselineSelection | null): Promise<SyncCoordinatorPlan & { executionScope: SyncScope }> {
  const selection = baseline && 'version' in baseline ? baseline : null
  if (selection) verifyBaselineSelection(snapshot, selection)
  const baselinePair = baseline && !('version' in baseline) ? baseline : null
  const pairs = selection ? [...new Map(selection.bindings.flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.id, pair] as const] : [] })).values()] : baselinePair ? [baselinePair] : []
  const { settings } = readSyncSettings(snapshot), entries = verifySnapshot(snapshot)
  const specEntries = entries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md'))
  const files = new Map(specEntries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const oldEntryMap = new Map((selection ? entries : baselinePair ? readTree(snapshot.source.commonDir, baselinePair.verifiedDelivery.immutableTree) : []).map(entry => [entry.path, entry]))
  for (const binding of selection?.bindings ?? []) if ('bytePair' in binding && binding.bytePair) { const entry = verifySnapshot(binding.bytePair.verifiedDelivery).find(entry => entry.path === binding.resource.path); if (entry) oldEntryMap.set(entry.path, entry); else oldEntryMap.delete(binding.resource.path) }
  const oldEntries = [...oldEntryMap.values()]
  const oldFiles = new Map(oldEntries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const oldFrozen = await readFrozenContracts(snapshot.source.canonicalRoot, oldFiles)
  const protectedGraphs = await Promise.all(pairs.map(pair => readFrozenContracts(snapshot.source.canonicalRoot, new Map(verifySnapshot(pair.verifiedDelivery).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')])))))
  const frozen = await readFrozenContracts(snapshot.source.canonicalRoot, files)
  const nodes = await loadSpecs(snapshot.source.canonicalRoot, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files: new Map([...files].filter(([path]) => path.startsWith('.spec/') && path.endsWith('/spec.md'))) } })
  const currentIntent = nodes.find(node => node.id === nodeId)
  const currentIntentIds = new Set(frozen.contracts.find(contract => contract.nodeId === currentIntent?.id)?.items.map(item => item.id) ?? [])
  const previousIntent = oldFrozen.nodes.find(node => node.id === nodeId) ?? oldFrozen.nodes.find(node => oldFrozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(item => currentIntentIds.has(item.id)))
  const intent = currentIntent ?? nodes.find(node => previousIntent && (oldFrozen.contracts.find(contract => contract.nodeId === previousIntent.id)?.items.some(item => frozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(next => next.id === item.id)) || previousIntent.rawSource === node.parts?.rawSource)) ?? nodes.filter(node => previousIntent && previousIntent.path.startsWith(`${posix.dirname(node.path)}/`) && node.parts?.rawSource).sort((a, b) => b.path.length - a.path.length)[0] ?? previousIntent
  if (!intent) throw new SyncApplicationError('sync_node_unknown', `不存在 Spec 节点 ${nodeId}`, 404)
  const currentImpact = contractImpact(frozen.graph, [nodeId, intent.id]), priorImpact = contractImpact(oldFrozen.graph, [nodeId, ...(previousIntent ? [previousIntent.id] : [])])
  const impacts = [currentImpact, priorImpact, ...protectedGraphs.map(previous => contractImpact(previous.graph, [nodeId, intent.id]))]
  const impact = { nodeIds: [...new Set(impacts.flatMap(item => item.nodeIds))], codePaths: [...new Set(impacts.flatMap(item => item.codePaths))], testPaths: [...new Set(impacts.flatMap(item => item.testPaths))] }
  const selected = new Set([nodeId, intent.id, ...impact.nodeIds, ...nodes.filter(node => node.path.startsWith(intent.path.slice(0, -'spec.md'.length))).map(node => node.id)])
  // 普通旧节点尚无 sync-v1 契约时仍按共同治理文件纳入其它权威叶。
  let changed = true
  while (changed) {
    changed = false
    const governed = new Set(nodes.filter(node => selected.has(node.id)).flatMap(node => node.code))
    for (const node of nodes) if (!selected.has(node.id) && node.code.some(path => governed.has(path))) { selected.add(node.id); changed = true }
  }
  const targets = nodes.filter(node => selected.has(node.id)).map(node => ({ nodeId: node.id, path: node.path }))
  const codePaths = [...new Set([...impact.codePaths, ...nodes.filter(node => selected.has(node.id)).flatMap(node => node.code)])]
  const priorTargets = oldFrozen.nodes.filter(node => selected.has(node.id) || impact.nodeIds.includes(node.id))
  const missingPrior = priorTargets.filter(node => !targets.some(target => target.nodeId === node.id || frozen.contracts.find(contract => contract.nodeId === target.nodeId)?.items.some(item => oldFrozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(previous => item.id === previous.id))))
  targets.push(...missingPrior.map(node => ({ nodeId: node.id, path: node.path, ...(node.rawSource ? { rawSource: node.rawSource } : {}) })))
  const writable = [...settings.sourcePaths, ...settings.testPaths]
  for (const path of [...codePaths, ...impact.testPaths]) if (!coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path)) throw new SyncApplicationError('sync_scope_unauthorized', `受影响文件未在可信授权中：${path}`)
  const decisionRefs = [...new Map(pairs.flatMap(pair => pair.decisionRefs ?? []).map(ref => [ref.sha256, ref])).values()]
  const retiredIds = [...new Set(pairs.flatMap(pair => pair.retiredIds ?? []))]
  const decisionFacts = decisionRefs.map(ref => {
    const request = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as SyncDecisionInput & { type: string }
    const analysis = JSON.parse(readEvidence(snapshot.source.commonDir, request.analysisRef).toString('utf8')) as CodeBehaviorAnalysis
    if (request.type !== 'sync.decision' || !analysis.reviewPassed || request.inputId !== analysis.inputId || request.findingIds.some(id => !analysis.findings.some(finding => finding.id === id))) throw new SyncApplicationError('sync_decision_history_invalid', '已结算裁决证据不匹配具体分析')
    const selectedFindings = analysis.findings.filter(finding => request.findingIds.includes(finding.id))
    return { source: `decision:${controlledDecisionIdentity(request)}`, text: JSON.stringify({ settledDecisionRef: ref, decision: request.decision, ruleIds: [...new Set(selectedFindings.flatMap(finding => finding.ruleIds))], findings: selectedFindings, supersession: '仅上述所选规则按用户裁决生效；原facts在这些规则上保留为历史，不得恢复旧规则；未选政策及VERIFY执行政策保持有效。' }) }
  })
  const selectedContractIds = new Set([...frozen.contracts, ...oldFrozen.contracts, ...protectedGraphs.flatMap(graph => graph.contracts)].filter(contract => selected.has(contract.nodeId)).flatMap(contract => contract.items.filter(item => item.kind !== 'VERIFY').map(item => item.id)))
  const readIds = new Set(selectedContractIds)
  const graphs = [frozen.graph, oldFrozen.graph, ...protectedGraphs.map(graph => graph.graph)]
  let expanded = true
  while (expanded) { expanded = false; for (const graph of graphs) for (const id of [...readIds]) { const item = graph.items.get(id); if (!item) continue; for (const ref of contractReferences(item)) if (graph.items.has(ref.id) && !readIds.has(ref.id)) { readIds.add(ref.id); expanded = true } } }
  const specReadPaths = new Set([...targets.map(target => target.path), ...priorTargets.map(target => target.path)])
  for (const graph of graphs) for (const id of readIds) { const item = graph.items.get(id); if (item) specReadPaths.add(item.path) }
  for (const node of [...nodes, ...oldFrozen.nodes]) if (targets.some(target => target.path.startsWith(`${posix.dirname(node.path)}/`))) specReadPaths.add(node.path)
  const executionScope: SyncScope = { paths: [...new Set([...targets.map(target => target.path), ...priorTargets.map(target => target.path), ...[...codePaths, ...impact.testPaths].filter(path => coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path))])].sort(), contractIds: [...selectedContractIds].filter(id => !graphs.some(graph => graph.items.get(id)?.kind === 'FLOW')).sort(), flowIds: [...selectedContractIds].filter(id => graphs.some(graph => graph.items.get(id)?.kind === 'FLOW')).sort() }
  return {
    executionScope,
    version: 'sync-coordinator-v1', intentNodeId: intent.id, targets,
    readPaths: [...new Set([...specReadPaths, '.spec/spexcode.json', ...settings.readPaths, ...codePaths, ...impact.testPaths, ...settings.mandatoryTests.map(test => test.testPath)])].sort(),
    writePaths: [...new Set([...targets.map(target => target.path), ...targets.map(target => posix.dirname(target.path)), ...priorTargets.map(target => target.path), ...writable])].sort(),
    facts: [...settings.facts, ...decisionFacts], decisionAuthorities: decisionRefs.map(ref => readDecisionAuthority(snapshot.source.commonDir, ref)), decisionRefs, retiredIds, verifications: settings.verifications, mandatoryTests: settings.mandatoryTests,
  }
}

/** 语义读取与保护对象按实际快照枚举；授权目录不是 lease，也不是已验证覆盖。 */
export async function deriveSyncBaselineResources(snapshot: InputSnapshot, plan: SyncCoordinatorPlan, baseline?: FrozenBaselineSelection | null): Promise<BaselineResource[]> {
  if (baseline) verifyBaselineSelection(snapshot, baseline)
  const snapshots = [snapshot, ...new Map((baseline?.bindings ?? []).flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.sourceInput.id, pair.sourceInput] as const, [pair.verifiedDelivery.id, pair.verifiedDelivery] as const] : [] })).values()]
  const paths = new Set<string>(['.spec/spexcode.json', ...plan.targets.map(target => target.path), ...plan.mandatoryTests.map(test => test.testPath)])
  const resources = new Map<string, BaselineResource>()
  const readable = (path: string): boolean => plan.readPaths.some(parent => path === parent || path.startsWith(`${parent}/`))
  for (const input of snapshots) {
    const entries = verifySnapshot(input).filter(entry => readable(entry.path))
    for (const entry of entries) paths.add(entry.path)
    const files = new Map(entries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const frozen = await readFrozenContracts(snapshot.source.canonicalRoot, files)
    for (const item of frozen.graph.items.values()) {
      if (item.kind === 'VERIFY') continue
      if (item.kind === 'FLOW') resources.set(`flow:${item.id}`, { kind: 'flow', id: item.id })
      else resources.set(`contract:${item.id}`, { kind: 'contract', id: item.id })
    }
  }
  // 精确已知的缺失文件/tombstone仍是读取对象，目录前缀不能假扮该对象。
  for (const binding of baseline?.bindings ?? []) if (binding.resource.kind === 'path' && readable(binding.resource.path)) paths.add(binding.resource.path)
  for (const path of paths) resources.set(`path:${path}`, { kind: 'path', path })
  return [...resources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, resource]) => resource)
}
