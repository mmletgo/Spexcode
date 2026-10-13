import type { Contract, ContractFinding, ContractGraph, ContractItem, ContractKind, ContractReference } from './types.js'

const BUSINESS: ContractKind[] = ['REQ', 'FLOW', 'STEP', 'STATE', 'EVENT', 'TR', 'RULE', 'AC', 'GAP']
export function contractReferences(item: ContractItem): ContractReference[] {
  const refs: ContractReference[] = []
  const add = (field: string, ids: string | readonly string[] | null, kinds: ContractKind[]): void => {
    for (const id of typeof ids === 'string' ? [ids] : ids ?? []) if (id !== 'END') refs.push({ field, id, kinds })
  }
  if (item.kind !== 'VERIFY') {
    add('depends-on', item.dependsOn, BUSINESS)
    if (['derived', 'rule'].includes(item.source.kind) || item.source.kind === 'user' && item.source.ref !== 'raw') {
      add('source', item.source.ref, item.source.kind === 'rule' ? ['RULE'] : item.source.kind === 'user' ? ['REQ'] : BUSINESS)
    }
  }
  switch (item.kind) {
    case 'FLOW': add('req', item.req, ['REQ']); add('steps', item.steps, ['STEP']); add('terminal', item.terminal, ['STATE']); break
    case 'STEP': add('flow', item.flow, ['FLOW']); add('rules', item.rules, ['RULE']); add('next', item.next, ['STEP', 'TR', 'STATE']); break
    case 'TR': add('from', item.from, ['STATE']); add('event', item.event, ['EVENT']); add('to', item.to, ['STATE']); add('rules', item.rules, ['RULE']); break
    case 'AC': add('covers', item.covers, BUSINESS); add('command', item.command, ['VERIFY']); break
    case 'GAP': add('affects', item.affects, BUSINESS); break
  }
  return refs
}

export function buildContractGraph(contracts: readonly Contract[]): ContractGraph {
  const items = new Map<string, ContractItem>(), owners = new Map<string, Contract>()
  const dependencies = new Map<string, string[]>(), dependents = new Map<string, string[]>()
  const findings: ContractFinding[] = []
  const nodes = new Set<string>()
  for (const contract of contracts) {
    if (nodes.has(contract.nodeId)) findings.push({ code: 'duplicate-node', severity: 'error', nodeId: contract.nodeId, path: contract.path, message: `节点 ${contract.nodeId} 在同步范围重复` })
    nodes.add(contract.nodeId)
    for (const item of contract.items) {
      if (items.has(item.id)) {
        findings.push({ code: 'duplicate-id', severity: 'error', nodeId: contract.nodeId, path: contract.path, line: item.line, itemId: item.id, message: `${item.id} 必须在同步范围全局唯一` })
        continue
      }
      items.set(item.id, item); owners.set(item.id, contract)
      const deps = item.kind === 'VERIFY' ? [] : [...new Set([...item.dependsOn,
        ...(['rule', 'derived'].includes(item.source.kind) || item.source.kind === 'user' && item.source.ref !== 'raw' ? [item.source.ref] : [])])]
      dependencies.set(item.id, deps)
      for (const id of deps) {
        const consumers = dependents.get(id) ?? []
        consumers.push(item.id); dependents.set(id, consumers)
      }
    }
  }
  return { contracts: [...contracts], items, owners, dependencies, dependents, findings }
}

export function dependencyClosure(graph: ContractGraph, ids: readonly string[]): string[] {
  // Ownership/navigation edges are deliberately excluded: a retry GAP must not block a successful flow.
  const seen = new Set(ids), queue = [...ids]
  const consumers = new Map<string, Set<string>>()
  for (const item of graph.items.values()) {
    for (const ref of contractReferences(item)) {
      if (!['depends-on', 'source', 'rules', 'covers'].includes(ref.field)) continue
      const set = consumers.get(ref.id) ?? new Set<string>()
      set.add(item.id); consumers.set(ref.id, set)
    }
  }
  for (let at = 0; at < queue.length; at++) for (const id of consumers.get(queue[at]) ?? []) {
    if (!seen.has(id)) { seen.add(id); queue.push(id) }
  }
  return [...seen].sort()
}
