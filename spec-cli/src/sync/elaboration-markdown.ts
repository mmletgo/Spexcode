import { CONTRACT_COLUMNS, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractKind } from '@spexcode/spec-core/contracts'
import type { Applicability, ElaborationCandidate, ElaborationInput } from './elaboration-types.js'

export type ContractCell = string | string[] | boolean | number | null
export type GeneratedTables = Record<ContractKind, Record<string, ContractCell>[]>
export type GeneratedNode = { nodeId: string; path: string; title: string; description: string; code: string[]; related: string[]; prose: string; tables: GeneratedTables }
export type GeneratedElaboration = { version: 'elaboration-rows-v1'; changes: GeneratedNode[]; applicability: Applicability[] }

const markdownCell = (value: ContractCell, command = false): string => {
  const text = value === null ? '-' : Array.isArray(value) ? command ? JSON.stringify(value) : value.length ? value.join(',') : '-' : String(value)
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>')
}

/** 模型只产生临时业务行；固定语法、原意和版本绑定由程序回写唯一 Markdown 候选。 */
export function renderElaboration(input: ElaborationInput, generated: GeneratedElaboration, inputDigest: string): ElaborationCandidate {
  const changes = generated.changes.map(node => {
    const move = input.nodeChanges?.find(change => change.action === 'move' && change.to.nodeId === node.nodeId && change.to.path === node.path)
    const target = input.targets.find(target => move ? target.nodeId === move.from.nodeId && target.path === move.from.path : target.nodeId === node.nodeId && target.path === node.path)
    const original = target?.source ? parseFrontmatter(target.source).fm : {}
    const raw = move && target?.source ? parseParts(target.source)?.rawSource : node.nodeId === input.intent.nodeId ? input.intent.rawSource : target?.rawSource ?? (target?.source ? parseParts(target.source)?.rawSource : undefined) ?? input.intent.rawSource
    const fm = input.mode === 'preserve_business' && target?.source ? { ...original, code: node.code, related: node.related } : { ...original, title: node.title, desc: node.description, 'contract-schema': 'sync-v1', status: original.status || 'pending', code: node.code, related: node.related }
    const metadata = Object.entries(fm).filter(([_key, value]) => !Array.isArray(value) || value.length).map(([key, value]) => Array.isArray(value)
      ? `${key}:\n${value.map(item => `  - ${JSON.stringify(item)}`).join('\n')}`
      : `${key}: ${JSON.stringify(value)}`).join('\n')
    const tables = Object.entries(CONTRACT_COLUMNS).flatMap(([kind, columns]) => {
      const items = node.tables[kind as ContractKind]
      if (!items.length) return []
      const rows = items.map(row => `| ${columns.map(column => markdownCell(row[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
      return [`### ${kind}\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.join('\n')}`]
    }).join('\n\n')
    if (input.mode === 'preserve_business' && target?.source) {
      const parts = parseParts(target.source)!
      const fencedRanges: { start: number; end: number }[] = []
      let fence: { start: number; marker: string; length: number } | null = null, offset = 0
      for (const line of parts.expandedSpec.split('\n')) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (marker && !fence) fence = { start: offset, marker: marker[1][0], length: marker[1].length }
        else if (marker && fence && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
          fencedRanges.push({ start: fence.start, end: offset + line.length + 1 }); fence = null
        }
        offset += line.length + 1
      }
      if (fence) fencedRanges.push({ start: fence.start, end: parts.expandedSpec.length })
      const expanded = parts.expandedSpec.replace(/^(### (?:REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP|VERIFY)\s*\n)(?:[ \t]*\n)*(?:\|[^\n]*\n?)+/gm, (section: string, _heading: string, offset: number) => {
        if (fencedRanges.some(range => offset >= range.start && offset < range.end)) return section
        const kind = section.match(/^### (\w+)/)![1] as ContractKind
        const columns = CONTRACT_COLUMNS[kind]
        const rows = node.tables[kind].map(row => `| ${columns.map(column => markdownCell(row[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
        return `### ${kind}\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.join('\n')}\n`
      })
      return { nodeId: node.nodeId, path: node.path, beforeDigest: target.sourceDigest, source: `---\n${metadata}\n---\n${parseFrontmatter(target.source).body.replace(parts.expandedSpec, expanded)}` }
    }
    return { nodeId: node.nodeId, path: node.path, beforeDigest: target?.sourceDigest ?? null, source: `---\n${metadata}\n---\n# ${node.title}\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n${node.prose}\n\n${tables}\n` }
  })
  return { inputDigest, changes, applicability: generated.applicability, ...(input.nodeChanges?.length ? { nodeChanges: structuredClone([...input.nodeChanges]) } : {}) }
}
