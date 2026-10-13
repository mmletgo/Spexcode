import { contractReferences, dependencyClosure } from './graph.js'
import type { Acceptance, BusinessItem, ContractCoverage, ContractGraph, ContractImpact, ContractItem, Transition } from './types.js'

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()
export const contractPath = (entry: string): string => entry.split('#')[0]
export function acceptanceBindings(graph: ContractGraph, item: BusinessItem): Acceptance[] {
  const covers = new Set([item.id, ...(item.kind === 'TR' ? item.rules : [])])
  if (item.kind === 'REQ') for (const id of dependencyClosure(graph, [item.id])) covers.add(id)
  if (item.kind === 'RULE') for (const candidate of graph.items.values()) {
    if (candidate.kind === 'TR' && candidate.rules.includes(item.id)) covers.add(candidate.id)
  }
  return [...graph.items.values()].filter((candidate): candidate is Acceptance => candidate.kind === 'AC' &&
    (candidate.id === item.id || candidate.covers.some((id) => covers.has(id))) &&
    graph.items.get(candidate.command)?.kind === 'VERIFY' && !!candidate.test && !!candidate.assertion)
}

export function projectContractCoverage(graph: ContractGraph): ContractCoverage {
  const gaps = [...graph.items.values()].filter((item) => item.kind === 'GAP').map((gap) => {
    const affectedIds = dependencyClosure(graph, gap.affects)
    return { id: gap.id, kind: gap.gapKind, affectedIds, nodeIds: sorted(affectedIds.flatMap((id) => graph.owners.get(id)?.nodeId ?? [])) }
  })
  const items = [...graph.items.values()].filter((item): item is BusinessItem => item.kind !== 'VERIFY').map((item) => {
    const bindings = acceptanceBindings(graph, item)
    const code = sorted([...(graph.owners.get(item.id)?.code ?? []), ...bindings.flatMap((ac) => graph.owners.get(ac.id)?.code ?? [])])
    return { id: item.id, kind: item.kind, nodeId: item.nodeId, status: bindings.length && code.length ? 'bound' as const : 'declared' as const,
      acceptanceIds: sorted(bindings.map((ac) => ac.id)), code: [...code], tests: sorted(bindings.map((ac) => ac.test)),
      verifyIds: sorted(bindings.map((ac) => ac.command)), blockedBy: gaps.filter((gap) => gap.affectedIds.includes(item.id)).map((gap) => gap.id).sort() }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const transitions = [...graph.items.values()].filter((item): item is Transition => item.kind === 'TR')
  const matrix: ContractCoverage['matrix'] = []
  for (const state of graph.items.values()) {
    if (state.kind !== 'STATE') continue
    for (const event of graph.items.values()) {
      if (event.kind !== 'EVENT' || event.object !== state.object) continue
      const matches = transitions.filter((tr) => tr.object === state.object && tr.from === state.id && tr.event === event.id)
      const acceptanceIds = sorted(matches.flatMap((tr) => acceptanceBindings(graph, tr).map((ac) => ac.id)))
      matrix.push({ object: state.object, stateId: state.id, eventId: event.id, transitionIds: sorted(matches.map((tr) => tr.id)), acceptanceIds,
        status: !matches.length ? 'missing' : matches.every((tr) => acceptanceBindings(graph, tr).length > 0) ? 'bound' : 'declared' })
    }
  }
  matrix.sort((a, b) => `${a.object}/${a.stateId}/${a.eventId}`.localeCompare(`${b.object}/${b.stateId}/${b.eventId}`))
  return { items, matrix, gaps }
}

export function contractImpact(graph: ContractGraph, changedIds: readonly string[]): ContractImpact {
  const selected = new Set<string>(), selectedNodes = new Set<string>()
  for (const id of changedIds) {
    if (graph.items.has(id)) selected.add(id)
    for (const contract of graph.contracts) if (contract.nodeId === id) {
      selectedNodes.add(id)
      for (const item of contract.items) selected.add(item.id)
    }
  }
  const reverse = new Map<string, Set<string>>()
  for (const item of graph.items.values()) for (const ref of contractReferences(item)) {
    const set = reverse.get(ref.id) ?? new Set<string>()
    set.add(item.id); reverse.set(ref.id, set)
  }
  // Include sibling governors of shared files, but never turn related context into governance.
  const queue = [...selected]
  for (let at = 0; at < queue.length; at++) {
    const item = graph.items.get(queue[at])!
    const owner = graph.owners.get(item.id)!
    selectedNodes.add(owner.nodeId)
    const more = [...reverse.get(item.id) ?? []]
    for (const contract of graph.contracts) if (contract.code.some((entry) => owner.code.some((ours) => contractPath(entry) === contractPath(ours)))) {
      selectedNodes.add(contract.nodeId)
      more.push(...contract.items.map((candidate) => candidate.id))
    }
    for (const id of more) if (!selected.has(id)) { selected.add(id); queue.push(id) }
  }
  const affected: ContractItem[] = [...selected].map((id) => graph.items.get(id)!)
  return { itemIds: sorted(selected), nodeIds: sorted(selectedNodes),
    codePaths: sorted(graph.contracts.filter((contract) => selectedNodes.has(contract.nodeId)).flatMap((contract) => contract.code.map(contractPath))),
    testPaths: sorted(affected.filter((item) => item.kind === 'AC').map((ac) => contractPath(ac.test))),
    verifyIds: sorted(affected.flatMap((item) => item.kind === 'VERIFY' ? [item.id] : item.kind === 'AC' ? [item.command] : [])) }
}
