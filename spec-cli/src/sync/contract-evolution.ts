import { createHash } from 'node:crypto'
import { contractReferences } from '@spexcode/spec-core/contracts'
import type { ContractFinding, ContractItem } from '@spexcode/spec-core/contracts'
import type { AuthorizedContractChange, ElaborationFact } from './elaboration-types.js'
import type { FrozenContracts } from './frozen-contracts.js'
import type { CodeBehaviorEvidence, ContractNodeChange } from './writeback-types.js'

export type ContractEvolutionPolicy = {
  mode: 'preserve_business' | 'reelaborate'
  /** 实现诊断只允许扩展边界，不授予改写已接受业务的权限。 */
  preserveAcceptedItems?: boolean
  authorizedChanges: readonly AuthorizedContractChange[]
  nodeChanges: readonly ContractNodeChange[]
  retiredIds: readonly string[]
  /** 新叶原意及本轮调用者冻结的用户原意；移动节点仍必须沿用原字节。 */
  newNodeRawSources: ReadonlyMap<string, string>
  facts?: readonly ElaborationFact[]
  analysis?: CodeBehaviorEvidence
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

/** 验收演进必须引用当前冻结的独立行为分析，不能以生成器失败自批。 */
export function acceptanceAuthorizationErrors(change: Extract<AuthorizedContractChange, { action: 'update_acceptance' }>, before: FrozenContracts, policy: Pick<ContractEvolutionPolicy, 'analysis' | 'facts'>): string[] {
  const evidence = policy.analysis
  if (!evidence || change.analysisRef.sha256 !== evidence.ref.sha256 || hash(evidence.analysis) !== evidence.ref.sha256) return ['验收变更未绑定真实冻结分析']
  const analysis = evidence.analysis
  const builds = analysis.traces.filter(trace => trace.purpose === 'code_behavior_analyze')
  const reviews = analysis.traces.filter(trace => trace.purpose === 'code_behavior_review')
  if (!analysis.reviewPassed || builds.length !== 1 || reviews.length !== 1 || builds[0].sessionId === reviews[0].sessionId || builds[0].threadId === reviews[0].threadId || [...builds, ...reviews].some(trace => !trace.sessionId || !trace.threadId || !trace.turnId || !/^[a-f0-9]{64}$/.test(trace.resultDigest) || !/^[a-f0-9]{64}$/.test(trace.inputDigest)) || !analysis.inputDigest || !analysis.composedDigest || !analysis.readSetDigest || !analysis.policyDigest) return ['验收变更缺少独立审查和冻结输入绑定']
  if (analysis.findings.some(finding => finding.affectedIds.includes(change.id) || finding.affectedIds.some(id => change.ruleIds.includes(id)))) return ['验收或规则仍有未解决业务冲突或缺口']
  const authorized = analysis.authorizedChanges.some(item => item.action === 'update_acceptance' && item.id === change.id && item.source === change.source && item.reason === change.reason && same(item.ruleIds, change.ruleIds))
  if (!authorized || !analysis.changes.some(item => item.kind === 'allowed_change' && item.affectedIds.includes(change.id) && change.ruleIds.every(id => item.ruleIds.includes(id)) && item.evidence.trim())) return ['独立分析未确认该验收及规则变化']
  if (!change.ruleIds.length || new Set(change.ruleIds).size !== change.ruleIds.length || change.ruleIds.some(id => !/^(REQ|RULE|TR)-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) || before.graph.items.has(id) && !['REQ', 'RULE', 'TR'].includes(before.graph.items.get(id)!.kind))) return ['验收变更必须引用合法需求、规则或状态处置来源']
  if (change.source.startsWith('code:') && !analysis.facts.some(fact => fact.source === change.source && fact.text.trim())) return ['代码变更没有冻结行为来源']
  if (change.source.startsWith('decision:') && !(policy.facts ?? []).some(fact => fact.source === change.source && fact.text.trim())) return ['验收变更没有可信裁决来源']
  return []
}

/** 在旧新全图并集检查接受细化的授权边界；稳定项跨叶移动不等于删除。 */
export function validateContractEvolution(before: FrozenContracts, after: FrozenContracts, policy: ContractEvolutionPolicy): ContractFinding[] {
  const findings: ContractFinding[] = []
  const issue = (code: string, location: { path: string; nodeId?: string; id?: string }, message: string, itemId?: string): void => {
    findings.push({ code, severity: 'error', path: location.path, nodeId: location.nodeId ?? location.id!, message, ...(itemId ? { itemId } : {}) })
  }
  const authorizations = new Map(policy.authorizedChanges.map(change => [change.id, change]))
  if (authorizations.size !== policy.authorizedChanges.length && before.nodes.length) issue('contract_authorization_duplicate', before.nodes[0], '同一身份不能收到重复契约变更授权')
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
    if (change.action === 'update_acceptance') {
      for (const error of acceptanceAuthorizationErrors(change, before, policy)) issue('acceptance_update_unauthorized', item, error, item.id)
    } else if (change.source !== 'user:raw' && !(policy.facts ?? []).some(fact => fact.source === change.source && fact.source.startsWith('decision:') && fact.text.trim())) issue('contract_authorization_untrusted', item, '退役或验证政策只能由用户原意或可信裁决授权', item.id)
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
    const priorMeaning = contractBusinessMeaning(item)
    const nextMeaning = contractBusinessMeaning(next)
    if (item.kind === 'RULE' && next.kind === 'RULE') {
      const relocation = policy.nodeChanges.find(change => change.action === 'move' && change.from.nodeId === item.authority && change.to?.nodeId === next.authority)
      if (relocation) priorMeaning.authority = next.authority
    }
    if (same(priorMeaning, nextMeaning)) continue
    if (policy.mode === 'preserve_business' || policy.preserveAcceptedItems) issue(policy.preserveAcceptedItems ? 'refinement_accepted_meaning_changed' : 'refactor_business_meaning_changed', next, policy.preserveAcceptedItems ? '再细化诊断不能改写已接受业务字段' : '纯重构只允许实现与测试符号绑定变化', item.id)
    else if (item.kind === 'VERIFY' && authorization?.action !== 'update_verification') issue('verification_policy_changed', next, '验证命令、目录或预算变更缺少已确认依据', item.id)
    else if (item.kind === 'AC' && next.kind === 'AC') {
      if (authorization?.action !== 'update_acceptance') issue('acceptance_update_unauthorized', next, '验收语义变更必须有规则变化及独立分析授权', item.id)
      else {
        const sources = new Set<string>(), pending = [next.id]
        while (pending.length) {
          const id = pending.pop()!
          if (sources.has(id)) continue
          sources.add(id)
          const item = after.graph.items.get(id)
          if (item) pending.push(...contractReferences(item).filter(reference => ['source', 'depends-on', 'covers', 'rules', 'req'].includes(reference.field)).map(reference => reference.id))
        }
        if (!authorization.ruleIds.every(id => {
          const priorSource = before.graph.items.get(id), nextSource = after.graph.items.get(id)
          if (!nextSource || !['REQ', 'RULE', 'TR'].includes(nextSource.kind) || !sources.has(id)) return false
          const rawChanged = nextSource.kind === 'REQ' && before.nodes.find(node => node.path === priorSource?.path)?.rawSource !== after.nodes.find(node => node.path === nextSource.path)?.rawSource
          const authorChanged = authorization.source === 'user:raw' && policy.analysis?.analysis.authorChanges?.some(change => change.nodeId === nextSource.nodeId && change.path === nextSource.path && change.changedIds.includes(id) && change.afterRaw === after.nodes.find(node => node.path === nextSource.path)?.rawSource)
          return !priorSource || !same(contractBusinessMeaning(priorSource), contractBusinessMeaning(nextSource)) || rawChanged || authorChanged === true
        })) issue('acceptance_rule_unchanged', next, '验收更新必须追溯到实际变化的合法需求、规则或状态处置', item.id)
      }
    }
  }
  const retired = new Set([...policy.retiredIds, ...policy.authorizedChanges.filter(change => change.action === 'retire').map(change => change.id)])
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
    const line = lines[index], marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = null
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
