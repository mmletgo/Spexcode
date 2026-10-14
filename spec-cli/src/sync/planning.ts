import { posix } from 'node:path'
import { loadSpecs } from '@spexcode/spec-core'
import { contractImpact } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { BaselinePair, InputSnapshot } from './operation-types.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { readEvidence, readObject, readTree, verifySnapshot } from './snapshot.js'
import { controlledDecisionIdentity } from './request-input.js'
import type { CodeBehaviorAnalysis, SyncDecisionInput } from './writeback-types.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'

/** 冻结契约影响与既有节点治理共同决定闭包；目录授权允许新自然语言需求创建实现。 */
export async function buildSyncApplicationPlan(snapshot: InputSnapshot, nodeId: string, baselinePair?: BaselinePair | null): Promise<SyncCoordinatorPlan> {
  const { settings } = readSyncSettings(snapshot), entries = verifySnapshot(snapshot)
  const specEntries = entries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md'))
  const files = new Map(specEntries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const oldEntries = baselinePair ? readTree(snapshot.source.commonDir, baselinePair.verifiedDelivery.immutableTree) : []
  const oldFiles = new Map(oldEntries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const oldFrozen = await readFrozenContracts(snapshot.source.canonicalRoot, oldFiles)
  const frozen = await readFrozenContracts(snapshot.source.canonicalRoot, files)
  const nodes = await loadSpecs(snapshot.source.canonicalRoot, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files: new Map([...files].filter(([path]) => path.startsWith('.spec/') && path.endsWith('/spec.md'))) } })
  const previousIntent = oldFrozen.nodes.find(node => node.id === nodeId)
  const intent = nodes.find(node => node.id === nodeId) ?? nodes.find(node => previousIntent && (oldFrozen.contracts.find(contract => contract.nodeId === nodeId)?.items.some(item => frozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(next => next.id === item.id)) || previousIntent.rawSource === node.parts?.rawSource)) ?? nodes.filter(node => previousIntent && previousIntent.path.startsWith(`${posix.dirname(node.path)}/`) && node.parts?.rawSource).sort((a, b) => b.path.length - a.path.length)[0]
  if (!intent) throw new SyncApplicationError('sync_node_unknown', `不存在 Spec 节点 ${nodeId}`, 404)
  const currentImpact = contractImpact(frozen.graph, [nodeId, intent.id]), priorImpact = contractImpact(oldFrozen.graph, [nodeId])
  const impact = { nodeIds: [...new Set([...currentImpact.nodeIds, ...priorImpact.nodeIds])], codePaths: [...new Set([...currentImpact.codePaths, ...priorImpact.codePaths])], testPaths: [...new Set([...currentImpact.testPaths, ...priorImpact.testPaths])] }
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
  const missingPrior = oldFrozen.nodes.filter(node => impact.nodeIds.includes(node.id) && !targets.some(target => target.nodeId === node.id || frozen.contracts.find(contract => contract.nodeId === target.nodeId)?.items.some(item => oldFrozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(previous => item.id === previous.id))))
  targets.push(...missingPrior.map(node => ({ nodeId: node.id, path: node.path })))
  const writable = [...settings.sourcePaths, ...settings.testPaths]
  for (const path of [...codePaths, ...impact.testPaths]) if (!coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path)) throw new SyncApplicationError('sync_scope_unauthorized', `受影响文件未在可信授权中：${path}`)
  const decisionFacts = (baselinePair?.decisionRefs ?? []).map(ref => {
    const request = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as SyncDecisionInput & { type: string }
    const analysis = JSON.parse(readEvidence(snapshot.source.commonDir, request.analysisRef).toString('utf8')) as CodeBehaviorAnalysis
    if (request.type !== 'sync.decision' || !analysis.reviewPassed || request.inputId !== analysis.inputId || request.findingIds.some(id => !analysis.findings.some(finding => finding.id === id))) throw new SyncApplicationError('sync_decision_history_invalid', '已结算裁决证据不匹配具体分析')
    const selectedFindings = analysis.findings.filter(finding => request.findingIds.includes(finding.id))
    return { source: `decision:${controlledDecisionIdentity(request)}`, text: JSON.stringify({ settledDecisionRef: ref, decision: request.decision, ruleIds: [...new Set(selectedFindings.flatMap(finding => finding.ruleIds))], findings: selectedFindings, supersession: '仅上述所选规则按用户裁决生效；原facts在这些规则上保留为历史，不得恢复旧规则；未选政策及VERIFY执行政策保持有效。' }) }
  })
  return {
    version: 'sync-coordinator-v1', intentNodeId: intent.id, targets,
    readPaths: [...new Set([...specEntries.map(entry => entry.path), ...oldFiles.keys(), '.spec/spexcode.json', ...writable, ...settings.readPaths, ...codePaths, ...impact.testPaths, ...settings.mandatoryTests.map(test => test.testPath)])].sort(),
    writePaths: [...new Set([...targets.map(target => target.path), ...targets.map(target => posix.dirname(target.path)), ...writable])].sort(),
    facts: [...settings.facts, ...decisionFacts], decisionRefs: baselinePair?.decisionRefs ?? [], retiredIds: baselinePair?.retiredIds ?? [], verifications: settings.verifications, mandatoryTests: settings.mandatoryTests,
  }
}
