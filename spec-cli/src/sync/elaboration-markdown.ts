import { CONTRACT_COLUMNS, contractTableCells, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractItem, ContractKind } from '@spexcode/spec-core/contracts'
import type { Applicability, ElaborationCandidate, ElaborationInput } from './elaboration-types.js'

export type ContractCell = string | string[] | boolean | number | null
export type GeneratedTables = Record<ContractKind, Record<string, ContractCell>[]>
export type GeneratedNode = { nodeId: string; path: string; title: string; description: string; code: string[]; related: string[]; prose: string | null; tables: GeneratedTables; removeIds: string[] }
export type GeneratedElaboration = { version: 'elaboration-rows-v2'; changes: GeneratedNode[]; applicability: Applicability[] }

const markdownCell = (value: ContractCell, command = false): string => {
  const text = value === null ? '-' : value === '' ? '-' : Array.isArray(value) ? command ? JSON.stringify(value) : value.length ? value.join(',') : '-' : String(value)
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>')
}

const contractRow = (item: ContractItem): Record<string, ContractCell> => Object.fromEntries(CONTRACT_COLUMNS[item.kind].map(column => {
  const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
  const value = column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]
  return [column, value]
}))

/** 当前协议按冻结节点应用完整行更新；重复更新或不属于该节点的删除不能被合并掩盖。 */
export function elaborationPatchErrors(input: ElaborationInput, generated: GeneratedElaboration): string[] {
  return generated.changes.flatMap(node => {
    const move = input.nodeChanges?.find(change => change.action === 'move' && change.to.nodeId === node.nodeId && change.to.path === node.path)
    const target = input.targets.find(target => move ? target.nodeId === move.from.nodeId && target.path === move.from.path : target.nodeId === node.nodeId && target.path === node.path)
    const baseline = target?.source ? parseContract({ ...target, source: target.source }).contract : null
    const ids = new Set(baseline?.items.map(item => item.id) ?? [])
    const updates = new Set<string>(), removes = new Set<string>(), errors: string[] = []
    for (const rows of Object.values(node.tables)) for (const row of rows) {
      const id = String(row.id)
      if (updates.has(id)) errors.push(`${node.path}: 重复更新行 ${id}`)
      updates.add(id)
    }
    for (const id of node.removeIds) {
      if (removes.has(id)) errors.push(`${node.path}: 重复删除行 ${id}`)
      if (!ids.has(id)) errors.push(`${node.path}: 删除行不属于冻结节点 ${id}`)
      if (updates.has(id)) errors.push(`${node.path}: 同一节点不能同时删除和更新 ${id}`)
      removes.add(id)
    }
    return errors
  })
}

/** 模型只产生临时差量行；未列旧行与正文从冻结 Markdown 保留，最终仍是完整候选。 */
export function renderElaboration(input: ElaborationInput, generated: GeneratedElaboration, inputDigest: string): ElaborationCandidate {
  const errors = elaborationPatchErrors(input, generated)
  if (errors.length) throw new TypeError(errors.join('; '))
  const nodes = [...generated.changes]
  for (const target of input.targets) {
    const lifecycle = input.nodeChanges?.find(change => change.from.nodeId === target.nodeId && change.from.path === target.path)
    if (lifecycle?.action === 'retire') continue
    const identity = lifecycle?.action === 'move' ? lifecycle.to : target
    if (nodes.some(node => node.nodeId === identity.nodeId && node.path === identity.path)) continue
    const contract = target.source ? parseContract({ ...target, source: target.source }).contract : null
    if (!contract) continue
    const fm = parseFrontmatter(target.source!).fm
    nodes.push({ nodeId: identity.nodeId, path: identity.path, title: String(fm.title ?? ''), description: String(fm.desc ?? ''), code: contract.code, related: contract.related, prose: null, tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables, removeIds: [] })
  }
  const changes = nodes.map(node => {
    const move = input.nodeChanges?.find(change => change.action === 'move' && change.to.nodeId === node.nodeId && change.to.path === node.path)
    const target = input.targets.find(target => move ? target.nodeId === move.from.nodeId && target.path === move.from.path : target.nodeId === node.nodeId && target.path === node.path)
    const original = target?.source ? parseFrontmatter(target.source).fm : {}
    const parts = target?.source ? parseParts(target.source) : null
    const baseline = target?.source ? parseContract({ ...target, source: target.source }).contract : null
    const raw = move && target?.source ? parts?.rawSource : node.nodeId === input.intent.nodeId ? input.intent.rawSource : target?.rawSource ?? parts?.rawSource ?? input.intent.rawSource
    const fm = input.mode === 'preserve_business' && target?.source ? { ...original, code: node.code, related: node.related } : { ...original, title: node.title, desc: node.description, 'contract-schema': 'sync-v1', ...(!target?.source ? { status: 'pending' } : {}), code: node.code, related: node.related }
    const metadataEqual = Object.entries(fm).every(([key, value]) => JSON.stringify(value) === JSON.stringify((key === 'code' || key === 'related') && typeof original[key] === 'string' ? [original[key]] : original[key]) || Array.isArray(value) && !value.length && !original[key] || value === '' && original[key] === undefined)
    if (baseline && (node.prose === null || input.mode === 'preserve_business') && metadataEqual && raw === parts?.rawSource && !move && !node.removeIds.length && Object.values(node.tables).every(rows => !rows.length)) return { nodeId: node.nodeId, path: node.path, beforeDigest: target!.sourceDigest, source: target!.source! }
    const metadata = Object.entries(fm).filter(([_key, value]) => !Array.isArray(value) || value.length).map(([key, value]) => Array.isArray(value)
      ? `${key}:\n${value.map(item => `  - ${JSON.stringify(item)}`).join('\n')}`
      : `${key}: ${JSON.stringify(value)}`).join('\n')
    const sourceLines = target?.source?.replace(/\r\n?/g, '\n').split('\n') ?? []
    const removedIds = new Set(node.removeIds)
    const preserveExpanded = baseline && parts?.expandedSpec && (node.prose === null || input.mode === 'preserve_business')
    const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => {
      const updates = new Map(node.tables[kind as ContractKind].map(row => [String(row.id), row]))
      const rows: string[] = []
      const previous = baseline?.items.filter(item => item.kind === kind) ?? []
      const rowColumns = preserveExpanded && previous.length ? contractTableCells(sourceLines[previous[0].line! - 3]) : columns
      for (const item of previous) {
        if (removedIds.has(item.id)) continue
        let update = updates.get(item.id)
        const oldRow = contractRow(item)
        if (move?.action === 'move' && item.kind === 'RULE' && item.authority === move.from.nodeId && (!update || update.authority === move.from.nodeId)) update = { ...(update ?? oldRow), authority: move.to.nodeId }
        const unchanged = update && columns.every(column => JSON.stringify(oldRow[column]) === JSON.stringify(update![column]))
        rows.push(preserveExpanded && (!update || unchanged) ? sourceLines[item.line! - 1] : `| ${rowColumns.map(column => markdownCell((update ?? oldRow)[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
        updates.delete(item.id)
      }
      for (const row of updates.values()) rows.push(`| ${rowColumns.map(column => markdownCell(row[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
      return [kind, rows]
    })) as Record<ContractKind, string[]>
    const section = (kind: ContractKind): string => tables[kind].length ? `### ${kind}\n\n| ${CONTRACT_COLUMNS[kind].join(' | ')} |\n| ${CONTRACT_COLUMNS[kind].map(() => '---').join(' | ')} |\n${tables[kind].join('\n')}` : ''
    if (preserveExpanded) {
      const fencedRanges: { start: number; end: number }[] = []
      let fence: { start: number; marker: string; length: number } | null = null, offset = 0
      for (const line of parts!.expandedSpec.split('\n')) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (marker && !fence) fence = { start: offset, marker: marker[1][0], length: marker[1].length }
        else if (marker && fence && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
          fencedRanges.push({ start: fence.start, end: offset + line.length + 1 }); fence = null
        }
        offset += line.length + 1
      }
      if (fence) fencedRanges.push({ start: fence.start, end: parts!.expandedSpec.length })
      const seen = new Set<ContractKind>()
      let expanded = parts!.expandedSpec.replace(/^(###[ \t]+(?:REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP|VERIFY)[ \t]*\n)(?:[ \t]*\n)*(?:[ \t]*\|[^\n]*\n?)+/gm, (originalSection: string, _heading: string, offset: number) => {
        if (fencedRanges.some(range => offset >= range.start && offset < range.end)) return originalSection
        const kind = originalSection.match(/^###[ \t]+(\w+)/)![1] as ContractKind
        seen.add(kind)
        const originalRows = originalSection.trimEnd().split('\n')
        const firstRow = originalRows.findIndex(line => /^[ \t]*\|/.test(line))
        return tables[kind].length ? [...originalRows.slice(0, firstRow + 2), ...tables[kind]].join('\n') + (originalSection.endsWith('\n') ? '\n' : '') : ''
      })
      const added = (Object.keys(CONTRACT_COLUMNS) as ContractKind[]).filter(kind => !seen.has(kind) && tables[kind].length).map(section)
      if (added.length) expanded += `\n\n${added.join('\n\n')}`
      const normalized = target!.source!.replace(/\r\n?/g, '\n')
      const originalBody = parseFrontmatter(normalized).body
      const rawOffset = originalBody.indexOf(parts!.rawSource)
      const expandedOffset = originalBody.indexOf(parts!.expandedSpec, rawOffset + parts!.rawSource.length)
      let body = originalBody.slice(0, expandedOffset) + expanded + originalBody.slice(expandedOffset + parts!.expandedSpec.length)
      if (raw !== parts!.rawSource) body = body.slice(0, rawOffset) + raw! + body.slice(rawOffset + parts!.rawSource.length)
      let rendered = normalized.slice(0, normalized.length - originalBody.length) + body

      if (!metadataEqual) rendered = `---\n${metadata}\n---\n${parseFrontmatter(rendered).body}`
      return { nodeId: node.nodeId, path: node.path, beforeDigest: target!.sourceDigest, source: rendered === normalized ? target!.source! : target!.source!.includes('\r\n') ? rendered.replace(/\n/g, '\r\n') : rendered }
    }
    return { nodeId: node.nodeId, path: node.path, beforeDigest: target?.sourceDigest ?? null, source: `---\n${metadata}\n---\n# ${node.title}\n\n## raw source\n\n${raw}\n\n## expanded spec\n\n${node.prose ?? parts?.expandedSpec ?? ''}\n\n${(Object.keys(CONTRACT_COLUMNS) as ContractKind[]).map(section).filter(Boolean).join('\n\n')}\n` }
  })
  return { inputDigest, changes, applicability: generated.applicability, ...(input.nodeChanges?.length ? { nodeChanges: structuredClone([...input.nodeChanges]) } : {}) }
}
