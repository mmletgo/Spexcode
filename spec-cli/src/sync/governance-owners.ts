import { parseCodeEntry, relationClaimsPath } from '@spexcode/spec-core'
import type { RelationEntry } from '@spexcode/spec-core'
import type { Contract } from '@spexcode/spec-core/contracts'

/** 当前及历史冻结治理共用同一 owner 判定，related 不授予归属。 */
export function ownerNodesForPath(path: string, contracts: readonly Contract[], governanceNodes: Iterable<{ id: string; path: string; code: RelationEntry[] }>): Set<string> {
  const owners = new Set<string>()
  for (const node of governanceNodes) if (node.path === path || node.code.some(entry => relationClaimsPath(entry.path, path))) owners.add(node.id)
  for (const contract of contracts) {
    for (const item of contract.items) {
      if (item.kind === 'VERIFY') continue
      if (item.source.kind === 'code' && relationClaimsPath(parseCodeEntry(item.source.ref).path, path)) owners.add(contract.nodeId)
      if (item.kind === 'AC' && relationClaimsPath(parseCodeEntry(item.test).path, path)) owners.add(contract.nodeId)
    }
  }
  return owners
}
