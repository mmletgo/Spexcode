import { createHash } from 'node:crypto'
import type { Contract } from './types.js'

export function contractDigest(contracts: readonly Contract[]): string {
  // Stable ordering removes collection-order variance; raw intent and expanded policy prose remain inputs.
  const normalized = contracts.map((contract) => ({ ...contract,
    code: [...contract.code].sort(), related: [...contract.related].sort(),
    items: contract.items.map(({ line: _line, ...item }) => item).sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.path.localeCompare(b.path))
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex')
}
