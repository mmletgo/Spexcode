import { createHash } from 'node:crypto'
import { contractReferences, dependencyClosure, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractFinding, ContractItem } from '@spexcode/spec-core/contracts'
import type { AuthorizedContractChange, ElaborationFact } from './elaboration-types.js'
import type { FrozenContracts } from './frozen-contracts.js'
import type { CodeBehaviorEvidence, ContractNodeChange, SyncDecisionAuthority } from './writeback-types.js'

export type ContractEvolutionPolicy = {
  mode: 'preserve_business' | 'reelaborate'
  /** 实现诊断允许细节增补，不能改变已接受原意、验收和政策。 */
  preserveAcceptedItems?: boolean
  authorizedChanges: readonly AuthorizedContractChange[]
  nodeChanges: readonly ContractNodeChange[]
  retiredIds: readonly string[]
  /** 新叶原意及本轮调用者冻结的用户原意；移动节点仍必须沿用原字节。 */
  newNodeRawSources: ReadonlyMap<string, string>
  facts?: readonly ElaborationFact[]
  analysis?: CodeBehaviorEvidence
  decisionAuthorities?: readonly SyncDecisionAuthority[]
}
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')

/** 忽略文件定位及实现/测试符号绑定，保留完整业务意义。 */
export function contractBusinessMeaning(item: ContractItem): Record<string, unknown> {
  const { nodeId: _nodeId, path: _path, line: _line, ...meaning } = item
  if (item.kind === 'AC') delete (meaning as Record<string, unknown>).test
  if (item.kind !== 'VERIFY' && item.source.kind === 'code') (meaning as Record<string, unknown>).source = { kind: 'code' }
  return meaning
}

/** 规则的 canonical 权威随定义归属搬迁，其他业务字段仍逐项保护。 */
export function sameContractBusinessMeaning(before: ContractItem, after: ContractItem): boolean {
  const previous = contractBusinessMeaning(before), next = contractBusinessMeaning(after)
  if (before.kind === 'RULE' && after.kind === 'RULE') {
    if (before.authority !== before.nodeId || after.authority !== after.nodeId) return false
    if (before.path !== after.path) previous.authority = after.authority
  }
  return same(previous, next)
}

function reviewedAnalysisErrors(evidence: CodeBehaviorEvidence | undefined, expectedHash: string): string[] {
  if (!evidence || expectedHash !== evidence.ref.sha256 || hash(evidence.analysis) !== evidence.ref.sha256) return ['契约变更未绑定真实冻结分析']
  const analysis = evidence.analysis
  const builds = analysis.traces.filter(trace => trace.purpose === 'code_behavior_analyze')
  const reviews = analysis.traces.filter(trace => trace.purpose === 'code_behavior_review')
  if (!analysis.reviewPassed || builds.length !== 1 || reviews.length !== 1 || builds[0].sessionId === reviews[0].sessionId || builds[0].threadId === reviews[0].threadId || [...builds, ...reviews].some(trace => !trace.sessionId || !trace.threadId || !trace.turnId || !/^[a-f0-9]{64}$/.test(trace.resultDigest) || !/^[a-f0-9]{64}$/.test(trace.inputDigest)) || !analysis.inputDigest || !analysis.composedDigest || !analysis.readSetDigest || !analysis.policyDigest) return ['契约变更缺少独立审查和冻结输入绑定']
  return []
}

/** 裁决事实的文字不是授权；仅使用程序从真实请求和所选旧发现冻结的作用范围。 */
export function decisionAuthorizationErrors(source: string, ids: readonly string[], before: FrozenContracts, policy: Pick<ContractEvolutionPolicy, 'analysis' | 'decisionAuthorities'>): string[] {
  const authorities = policy.decisionAuthorities ?? policy.analysis?.analysis.decisionAuthorities ?? []
  const matching = authorities.filter(authority => source === `decision:${authority.stableDecisionId}`)
  if (matching.length !== 1) return ['裁决来源没有唯一可信结构化作用范围']
  const authority = matching[0]
  if (authority.decision.choice === 'keep_intent') return ['保留原意的裁决不能授权业务契约变更']
  const scope = new Set(dependencyClosure(before.graph, authority.ruleIds.length ? authority.ruleIds : authority.affectedIds))
  return ids.every(id => scope.has(id)) ? [] : ['契约目标或来源规则超出所选裁决作用范围']
}

type AuthorizationPolicy = Pick<ContractEvolutionPolicy, 'analysis' | 'facts' | 'decisionAuthorities'> & Partial<Pick<ContractEvolutionPolicy, 'newNodeRawSources'>>

function authoredSourceMatches(id: string, before: FrozenContracts, policy: AuthorizationPolicy): boolean {
  const item = before.graph.items.get(id), analysis = policy.analysis?.analysis
  if (!item || !analysis) return false
  const change = analysis.authorChanges?.find(entry => entry.path === item.path && entry.nodeId === item.nodeId && entry.changedIds.includes(id))
  if (!change || change.afterRaw === null) return false
  const expectedRaw = policy.newNodeRawSources?.get(item.path)?.trim() ?? before.nodes.find(node => node.path === item.path)!.rawSource
  if (change.afterRaw === expectedRaw) return true
  return analysis.rawIntegrations?.some(proof => proof.path === item.path && proof.sourceRaw === change.afterRaw && proof.expectedRaw === expectedRaw && analysis.resolutions.some(resolution => resolution.path === item.path && resolution.content !== null && parseParts(resolution.content)?.rawSource === proof.resolvedRaw)) === true
}

function acceptanceSources(frozen: FrozenContracts, id: string): Set<string> {
  const sources = new Set<string>(), pending = [id]
  while (pending.length) {
    const current = pending.pop()!
    if (sources.has(current)) continue
    sources.add(current)
    const item = frozen.graph.items.get(current)
    if (item) pending.push(...contractReferences(item).filter(reference => ['source', 'depends-on', 'covers', 'rules', 'req'].includes(reference.field)).map(reference => reference.id))
  }
  return sources
}

function independentlyAuthoredChange(change: AuthorizedContractChange, before: FrozenContracts, policy: AuthorizationPolicy): boolean {
  if (change.source !== 'user:raw' || !policy.analysis || reviewedAnalysisErrors(policy.analysis, policy.analysis.ref.sha256).length) return false
  if (change.action === 'update_acceptance') {
    if (acceptanceAuthorizationErrors(change, before, policy).length || !change.ruleIds.every(id => acceptanceSources(before, change.id).has(id))) return false
    if (change.ruleIds.every(id => authoredSourceMatches(id, before, policy))) return true
    return policy.analysis.analysis.changes.some(entry => {
      if (entry.kind !== 'allowed_change' || !entry.affectedIds.includes(change.id) || !change.ruleIds.every(id => entry.ruleIds.includes(id))) return false
      const authored = change.ruleIds.filter(id => authoredSourceMatches(id, before, policy)), scope = new Set(dependencyClosure(before.graph, authored))
      return authored.length > 0 && scope.has(change.id) && change.ruleIds.every(id => scope.has(id) && (authored.includes(id) || entry.affectedIds.includes(id)))
    })
  }
  if (change.action !== 'retire' || !change.analysisRef) return false
  const item = before.graph.items.get(change.id)!
  return policy.analysis.analysis.authorChanges?.some(entry => entry.path === item.path && entry.nodeId === item.nodeId && entry.beforeRaw !== null && entry.afterRaw === null && entry.changedIds.includes(item.id)) === true
}

/** 逐项退休有独审来源时核对整个删除证明；直接用户/计划授权仍保持明确来源门禁。 */
export function contractAuthorizationErrors(change: AuthorizedContractChange, before: FrozenContracts, policy: AuthorizationPolicy): string[] {
  const errors: string[] = change.action === 'update_acceptance' ? acceptanceAuthorizationErrors(change, before, policy) : []
  const analysis = policy.analysis?.analysis
  if (analysis?.decision && !independentlyAuthoredChange(change, before, policy)) {
    const authorities = policy.decisionAuthorities ?? analysis.decisionAuthorities ?? []
    const decision = analysis.decision
    const authority = authorities.find(item => item.requestRef.sha256 === decision.requestRef.sha256 && item.analysisRef.sha256 === decision.analysisRef.sha256 && item.findingIds.length === decision.findingIds.length && item.findingIds.every(id => decision.findingIds.includes(id)))
    if (!authority) errors.push('当前裁决未绑定真实所选发现的结构化作用范围')
    else errors.push(...decisionAuthorizationErrors(`decision:${authority.stableDecisionId}`, [change.id, ...change.action === 'update_acceptance' ? change.ruleIds : []], before, policy))
  }
  if (change.action === 'update_acceptance') return errors
  if (change.source !== 'user:raw') {
    if (!(policy.facts ?? []).some(fact => fact.source === change.source && fact.text.trim())) errors.push('退役或验证政策没有可信裁决事实')
    errors.push(...decisionAuthorizationErrors(change.source, [change.id], before, policy))
  }
  if (change.action === 'retire' && change.analysisRef) {
    errors.push(...reviewedAnalysisErrors(policy.analysis, change.analysisRef.sha256))
    if (!errors.length) {
      const analysis = policy.analysis!.analysis, item = before.graph.items.get(change.id)!
      if (!analysis.authorizedChanges.some(proposal => proposal.action === 'retire' && proposal.id === change.id && proposal.source === change.source && proposal.reason === change.reason) || !analysis.nodeChanges.some(node => node.action === 'retire' && node.from.path === item.path && node.from.nodeId === item.nodeId) || !analysis.resolutions.some(resolution => resolution.path === item.path && resolution.content === null) || !analysis.changes.some(entry => entry.kind === 'allowed_change' && entry.paths.includes(item.path))) errors.push('退役未绑定逐项提案、已审节点删除及真实删除候选')
      if (change.source === 'user:raw' && !analysis.authorChanges?.some(entry => entry.path === item.path && entry.nodeId === item.nodeId && entry.beforeRaw !== null && entry.afterRaw === null && entry.changedIds.includes(item.id))) errors.push('用户来源退役没有冻结的实际作者节点删除差量')
    }
  }
  return errors
}

/** 验收演进必须引用当前冻结的独立行为分析，不能以生成器失败自批。 */
export function acceptanceAuthorizationErrors(change: Extract<AuthorizedContractChange, { action: 'update_acceptance' }>, before: FrozenContracts, policy: Pick<ContractEvolutionPolicy, 'analysis' | 'facts' | 'decisionAuthorities'>): string[] {
  const evidence = policy.analysis
  const proofErrors = reviewedAnalysisErrors(evidence, change.analysisRef.sha256)
  if (proofErrors.length) return proofErrors
  const analysis = evidence!.analysis
  if (analysis.findings.some(finding => finding.affectedIds.includes(change.id) || finding.affectedIds.some(id => change.ruleIds.includes(id)))) return ['验收或规则仍有未解决业务冲突或缺口']
  const authorized = analysis.authorizedChanges.some(item => item.action === 'update_acceptance' && item.id === change.id && item.source === change.source && item.reason === change.reason && same(item.ruleIds, change.ruleIds))
  if (!authorized || !analysis.changes.some(item => item.kind === 'allowed_change' && item.affectedIds.includes(change.id) && change.ruleIds.every(id => item.ruleIds.includes(id)) && item.evidence.trim())) return ['独立分析未确认该验收及规则变化']
  if (!change.ruleIds.length || new Set(change.ruleIds).size !== change.ruleIds.length || change.ruleIds.some(id => !/^(REQ|RULE|TR)-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) || before.graph.items.has(id) && !['REQ', 'RULE', 'TR'].includes(before.graph.items.get(id)!.kind))) return ['验收变更必须引用合法需求、规则或状态处置来源']
  if (change.source.startsWith('code:') && !analysis.facts.some(fact => fact.source === change.source && fact.text.trim())) return ['代码变更没有冻结行为来源']
  if (change.source.startsWith('decision:') && !(policy.facts ?? []).some(fact => fact.source === change.source && fact.text.trim())) return ['验收变更没有可信裁决来源']
  return change.source.startsWith('decision:') ? decisionAuthorizationErrors(change.source, [change.id, ...change.ruleIds], before, policy) : []
}

/** 在旧新全图并集检查接受细化的授权边界；稳定项跨叶移动不等于删除。 */
export function validateContractEvolution(before: FrozenContracts, after: FrozenContracts, policy: ContractEvolutionPolicy): ContractFinding[] {
  const findings: ContractFinding[] = []
  const issue = (code: string, location: { path: string; nodeId?: string; id?: string }, message: string, itemId?: string): void => {
    findings.push({ code, severity: 'error', path: location.path, nodeId: location.nodeId ?? location.id!, message, ...(itemId ? { itemId } : {}) })
  }
  const authorizations = new Map(policy.authorizedChanges.map(change => [change.id, change]))
  if (authorizations.size !== policy.authorizedChanges.length && before.nodes.length) issue('contract_authorization_duplicate', before.nodes[0], '同一身份不能收到重复契约变更授权')
  const authorities = policy.decisionAuthorities ?? policy.analysis?.analysis.decisionAuthorities ?? []
  const decision = policy.analysis?.analysis.decision
  const current = decision ? authorities.find(authority => authority.requestRef.sha256 === decision.requestRef.sha256 && authority.analysisRef.sha256 === decision.analysisRef.sha256 && authority.findingIds.length === decision.findingIds.length && authority.findingIds.every(id => decision.findingIds.includes(id))) : undefined
  const currentSeeds = current ? current.ruleIds.length ? current.ruleIds : current.affectedIds : []
  const currentScope = new Set([...dependencyClosure(before.graph, currentSeeds), ...dependencyClosure(after.graph, currentSeeds).filter(id => !before.graph.items.has(id))])
  if (decision) for (const item of before.graph.items.values()) {
    const next = after.graph.items.get(item.id)
    if (next && sameContractBusinessMeaning(item, next)) continue
    if (item.kind !== 'VERIFY' && item.source.kind === 'code' && next && next.kind !== 'VERIFY' && next.source.kind === 'code') continue
    const authorization = authorizations.get(item.id)
    if (authorization && independentlyAuthoredChange(authorization, before, policy)) continue
    if (['RULE', 'TR'].includes(item.kind) && policy.authorizedChanges.some(change => change.action === 'update_acceptance' && change.ruleIds.includes(item.id) && independentlyAuthoredChange(change, before, policy))) continue
    if (next && !['AC', 'VERIFY'].includes(item.kind) && !reviewedAnalysisErrors(policy.analysis, policy.analysis!.ref.sha256).length && authoredSourceMatches(item.id, before, policy) && !policy.analysis!.analysis.findings.some(finding => finding.affectedIds.includes(item.id)) && policy.analysis!.analysis.changes.some(change => change.kind === 'allowed_change' && change.affectedIds.includes(item.id) && change.evidence.trim())) continue
    if (!current || reviewedAnalysisErrors(policy.analysis, policy.analysis!.ref.sha256).length || current.decision.choice === 'keep_intent' || !currentScope.has(item.id)) issue('decision_scope_exceeded', next ?? item, '当前裁决不能改变或退役未选义务，user:raw和旧decision事实不能扩大作用范围', item.id)
  }
  const moves = new Map<string, ContractNodeChange>()
  const destinations = new Set<string>()
  for (const change of policy.nodeChanges) {
    const node = before.nodes.find(node => node.path === change.from.path && node.id === change.from.nodeId)
    if (!node || moves.has(change.from.path) || !/^[a-f0-9]{64}$/.test(change.evidenceRef.sha256) || change.action === 'retire' && 'to' in change || change.action === 'move' && (!change.to || destinations.has(change.to.path))) {
      issue('node_change_invalid', change.from, '节点生命周期变更必须有唯一旧新定位和冻结证据'); continue
    }
    moves.set(node.path, change)
    if (change.action === 'move') destinations.add(change.to.path)
    if (after.nodes.some(next => next.path === node.path)) issue('node_change_not_applied', node, '迁移或退役后的旧节点仍存在')
    if (change.action === 'move') {
      const next = after.nodes.find(next => next.path === change.to!.path && next.id === change.to!.nodeId)
      if (!next || next.rawSource !== node.rawSource) issue('node_move_raw_changed', change.to!, '迁移必须使用规范节点身份并原样保留 raw')
    } else {
      const items = before.contracts.find(contract => contract.path === node.path)?.items ?? []
      if (!items.length || items.some(item => authorizations.get(item.id)?.action !== 'retire')) issue('node_retirement_unauthorized', node, '节点退役必须由逐项用户原意或可信裁决授权，不能删除 schema 逃避门禁')
    }
  }
  for (const node of before.nodes) {
    if (moves.has(node.path)) continue
    const next = after.nodes.find(next => next.path === node.path)
    if (!next) issue('protected_node_removed', node, '节点删除或迁移必须保留明确生命周期记录')
    else if (next.rawSource !== (policy.mode === 'preserve_business' || policy.preserveAcceptedItems ? node.rawSource : policy.newNodeRawSources.get(next.path)?.trim() ?? node.rawSource)) issue('raw_changed', next, '原意必须符合调用者冻结字节')
  }
  for (const node of after.nodes) if (!before.nodes.some(prior => prior.path === node.path) && !destinations.has(node.path) && node.rawSource !== policy.newNodeRawSources.get(node.path)?.trim()) issue('new_node_intent_unfrozen', node, '新增节点原意必须由调用者冻结')
  for (const contract of before.contracts) {
    const change = moves.get(contract.path)
    const expectedPath = change?.action === 'move' ? change.to!.path : contract.path
    if (change?.action !== 'retire' && !after.contracts.some(next => next.path === expectedPath)) issue('contract_schema_removed', contract, '启用契约节点不能删除 schema 退出检查')
    if ((policy.mode === 'preserve_business' || policy.preserveAcceptedItems) && change?.action !== 'retire') {
      const next = after.contracts.find(next => next.path === expectedPath)
      if (next && (policy.preserveAcceptedItems ? !contractBusinessProse(next.expandedSpec).includes(contractBusinessProse(contract.expandedSpec)) : contractBusinessProse(next.expandedSpec) !== contractBusinessProse(contract.expandedSpec))) issue(policy.preserveAcceptedItems ? 'refinement_accepted_prose_changed' : 'refactor_business_prose_changed', next, '既有 expanded 业务正文必须保留')
    }
  }
  for (const change of policy.authorizedChanges) {
    const item = before.graph.items.get(change.id)
    if (!item || !change.reason.trim() || change.action === 'update_verification' && item.kind !== 'VERIFY' || change.action === 'update_acceptance' && item.kind !== 'AC') {
      issue('contract_authorization_invalid', item ?? before.nodes[0] ?? after.nodes[0] ?? { path: '.spec', nodeId: change.id }, '契约变更必须引用既有身份、适用操作及非空依据', change.id); continue
    }
    for (const error of contractAuthorizationErrors(change, before, policy)) issue(change.action === 'update_acceptance' ? 'acceptance_update_unauthorized' : 'contract_authorization_untrusted', item, error, item.id)
    if (change.action === 'retire' && after.graph.items.has(change.id)) issue('retirement_not_applied', item, '已决定退役的身份仍存在', item.id)
  }
  if (policy.mode === 'preserve_business') for (const item of after.graph.items.values()) if (!before.graph.items.has(item.id)) issue('refactor_business_item_added', item, '纯重构不能新增业务契约项', item.id)
  for (const item of before.graph.items.values()) {
    const next = after.graph.items.get(item.id)
    const authorization = authorizations.get(item.id)
    if (!next || next.kind !== item.kind) {
      if (policy.mode === 'preserve_business' || policy.preserveAcceptedItems || authorization?.action !== 'retire') issue('protected_item_removed', item, '删除契约项必须有用户原意或可信裁决的退役依据', item.id)
      continue
    }
    if (sameContractBusinessMeaning(item, next)) continue
    if (!current && next.kind !== 'VERIFY' && next.source.kind === 'decision' && (authorities.some(authority => authority.stableDecisionId === next.source.ref) || item.kind === 'VERIFY' || item.source.kind !== 'decision' || item.source.ref !== next.source.ref)) for (const error of decisionAuthorizationErrors(`decision:${next.source.ref}`, [item.id], before, policy)) issue('decision_scope_exceeded', next, error, item.id)
    if (policy.mode === 'preserve_business' || policy.preserveAcceptedItems && ['REQ', 'AC', 'VERIFY', 'RULE'].includes(item.kind)) issue(policy.preserveAcceptedItems ? 'refinement_accepted_meaning_changed' : 'refactor_business_meaning_changed', next, policy.preserveAcceptedItems ? '再细化诊断不能改写已接受业务字段' : '纯重构只允许实现与测试符号绑定变化', item.id)
    else if (policy.preserveAcceptedItems && item.kind === 'TR' && next.kind === 'TR' && item.disposition !== 'not_applicable' && next.disposition === 'not_applicable') issue('refinement_accepted_disposition_removed', next, '已接受状态处置不能改为不适用逃避义务', item.id)
    else if (item.kind === 'VERIFY' && authorization?.action !== 'update_verification') issue('verification_policy_changed', next, '验证命令、目录或预算变更缺少已确认依据', item.id)
    else if (item.kind === 'AC' && next.kind === 'AC') {
      if (authorization?.action !== 'update_acceptance') issue('acceptance_update_unauthorized', next, '验收语义变更必须有规则变化及独立分析授权', item.id)
      else {
        const sources = acceptanceSources(after, next.id)
        if (!authorization.ruleIds.every(id => {
          const priorSource = before.graph.items.get(id), nextSource = after.graph.items.get(id)
          if (!nextSource || !['REQ', 'RULE', 'TR'].includes(nextSource.kind) || !sources.has(id)) return false
          const rawChanged = nextSource.kind === 'REQ' && before.nodes.find(node => node.path === priorSource?.path)?.rawSource !== after.nodes.find(node => node.path === nextSource.path)?.rawSource
          const authorChanged = authorization.source === 'user:raw' && authoredSourceMatches(id, before, { ...policy, newNodeRawSources: new Map(after.nodes.flatMap(node => node.rawSource === null ? [] : [[node.path, node.rawSource] as const])) })
          return !priorSource || !sameContractBusinessMeaning(priorSource, nextSource) || rawChanged || authorChanged === true
        })) issue('acceptance_rule_unchanged', next, '验收更新必须追溯到实际变化的合法需求、规则或状态处置', item.id)
      }
    }
  }
  const retired = new Set([...policy.retiredIds, ...policy.authorizedChanges.filter(change => change.action === 'retire').map(change => change.id), ...policy.nodeChanges.filter(change => change.action === 'retire').map(change => change.from.nodeId)])
  for (const id of retired) if (after.graph.items.has(id) || after.nodes.some(node => node.id === id)) issue('retired_id_reused', after.graph.items.get(id) ?? after.nodes.find(node => node.id === id)!, '不能复用历史退役身份', id)
  for (const item of after.graph.items.values()) {
    for (const reference of contractReferences(item)) if (retired.has(reference.id)) issue('retired_reference_remaining', item, `退役后引用必须清理: ${reference.id}`, item.id)
    if (item.kind === 'RULE' && policy.nodeChanges.some(change => change.action === 'retire' && change.from.nodeId === item.authority)) issue('retired_node_reference_remaining', item, '权威规则不能引用退役节点', item.id)
  }
  const retiredNodes = policy.nodeChanges.filter(change => change.action === 'retire').map(change => change.from.nodeId)
  for (const [path, source] of after.files) if (path.startsWith('.spec/') && path.endsWith('/spec.md')) for (const id of retiredNodes) if (source.includes(`[[${id}]]`)) {
    const node = after.nodes.find(node => node.path === path)
    issue('retired_node_reference_remaining', { path, nodeId: node?.id ?? id }, `节点退役后必须清理正文引用: ${id}`)
  }
  return findings
}

/** 去掉固定契约表语法，逐字核对仍由人维护的业务说明。 */
export function contractBusinessProse(source: string): string {
  const lines = source.split('\n'), prose: string[] = []
  let fence: { marker: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      prose.push(line); continue
    }
    if (!fence && /^### (?:REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP|VERIFY)[ \t]*$/.test(line)) {
      let cursor = index + 1
      while (cursor < lines.length && !lines[cursor].trim()) cursor++
      if (/^\|/.test(lines[cursor] ?? '')) {
        while (cursor < lines.length && /^\|/.test(lines[cursor])) cursor++
        index = cursor - 1; continue
      }
    }
    prose.push(line)
  }
  return prose.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
