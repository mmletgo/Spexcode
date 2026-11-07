import { parseRelation } from '@spexcode/spec-core'
import { ownerNodesForPath } from './governance-owners.js'
import { CONTRACT_COLUMNS, contractTableCells, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractItem, ContractKind, Verification } from '@spexcode/spec-core/contracts'
import type { Applicability, ElaborationCandidate, ElaborationInput, ElaborationTarget, ReadonlySpecRepair } from './elaboration-types.js'
import { ELABORATION_GENERATION_GUIDANCE } from './elaboration-types.js'
import { contractBusinessProse } from './contract-evolution.js'

export type ContractCell = string | string[] | boolean | number | null
export type GeneratedTables = Record<ContractKind, Record<string, ContractCell>[]>
export type GeneratedNode = { nodeId: string; path: string; title: string; description: string; code: string[]; related: string[]; prose: string | null; tables: GeneratedTables; removeIds: string[] }
export type GeneratedElaboration = { version: 'elaboration-rows-v2' | 'elaboration-target-rows-v3'; changes: GeneratedNode[]; applicability: Applicability[] }
export type GeneratedTargetElaboration = { version: 'elaboration-target-rows-v3'; changes: (Omit<GeneratedNode, 'path' | 'nodeId'> & { targetIndex: number })[]; applicability: Applicability[] }

/** 可写定位由冻结目标和明确生命周期唯一派生，不由模型重复填写。 */
export function elaborationTargetBindings(input: ElaborationInput): { targetIndex: number; nodeId: string; path: string; required: boolean }[] {
  return input.targets.flatMap((target, targetIndex) => {
    const lifecycle = input.nodeChanges?.find(change => change.from.nodeId === target.nodeId && change.from.path === target.path)
    if (lifecycle?.action === 'retire') return []
    const identity = lifecycle?.action === 'move' ? lifecycle.to : target
    return [{ targetIndex, nodeId: identity.nodeId, path: identity.path, required: !(target.source && parseContract({ ...target, source: target.source }).contract) }]
  })
}

/** 只补入程序拥有的路径；原生输出和追踪摘要仍保存原来的业务行对象。 */
export function bindElaborationTargets(input: ElaborationInput, output: GeneratedTargetElaboration): GeneratedElaboration {
  const targets = new Map(elaborationTargetBindings(input).map(target => [target.targetIndex, target]))
  return { ...output, changes: output.changes.map(({ targetIndex, ...node }) => {
    const target = targets.get(targetIndex)
    if (!target) throw new TypeError('细化输出包含未冻结或已退役目标: ' + targetIndex)
    return { ...node, nodeId: target.nodeId, path: target.path }
  }) }
}

const markdownCell = (value: ContractCell, command = false): string => {
  const text = value === null ? '-' : value === '' ? '-' : Array.isArray(value) ? command ? JSON.stringify(value) : value.length ? value.join(',') : '-' : String(value)
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>')
}

const contractRow = (item: ContractItem): Record<string, ContractCell> => Object.fromEntries(CONTRACT_COLUMNS[item.kind].map(column => {
  const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
  const value = column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : (item as unknown as Record<string, ContractCell>)[key]
  return [column, value]
}))

/** 本轮影响归属由范围检查、渲染及独审共用，不把目标列表当作业务授权。 */
export function targetHasCurrentChanges(input: ElaborationInput, target: ElaborationTarget): boolean {
  if (!input.analysis || !target.source) return true
  const contract = parseContract({ ...target, source: target.source }).contract
  if (!contract || !contract.items.length) return true
  const ids = new Set(contract.items.map(item => item.id)), analysis = input.analysis.analysis
  const raw = target.nodeId === input.intent.nodeId ? input.intent.rawSource : target.rawSource
  if (input.nodeChanges?.some(change => change.from.nodeId === target.nodeId && change.from.path === target.path)
    || input.authorizedChanges?.some(change => ids.has(change.id))
    || analysis.authorChanges?.some(change => change.nodeId === target.nodeId && change.path === target.path)
    || raw !== undefined && raw !== parseParts(target.source)?.rawSource) return true
  return analysis.changes.some(change => [...change.affectedIds, ...change.ruleIds].some(id => ids.has(id))
    || change.paths.some(path => ownerNodesForPath(path, [contract], [{ id: target.nodeId, path: target.path, code: parseRelation(contract.code, 'code').entries }]).has(target.nodeId)))
}

/** 只消费已认证独审的结构化affected IDs；外owner仅作证据，未知或缺席绑定不授事实修正权。 */
export function readonlyFactRepairIds(input: ElaborationInput, target: ElaborationTarget, repair: ReadonlySpecRepair | undefined = input.readonlySpecRepair): Set<string> {
  const ids = new Set<string>()
  if (input.generationGuidance !== ELABORATION_GENERATION_GUIDANCE || input.phase === 'interface_seed' || repair?.kind !== 'candidate_review' || !repair.reviewEvidence?.length || input.implementationWritePaths?.length !== 0 || !input.analysis || !target.source || targetHasCurrentChanges(input, target)) return ids
  const items = [...input.targets, ...input.context ?? []].flatMap(source => source.source ? parseContract({ ...source, source: source.source }).contract?.items ?? [] : [])
  for (const finding of repair.findings) {
    if (finding.nodeId !== target.nodeId || finding.path !== target.path || finding.code !== 'candidate-review-repair' || finding.severity !== 'error') continue
    if (!finding.relatedIds?.length || new Set(finding.relatedIds).size !== finding.relatedIds.length || finding.relatedIds.some(id => items.filter(item => item.id === id).length !== 1)) continue
    for (const id of finding.relatedIds) if (items.some(item => item.id === id && item.nodeId === target.nodeId && item.path === target.path)) ids.add(id)
  }
  return ids
}

/** 显式等价差量也沿用整个冻结文件，不因重渲染改变正文及技术表的位置。 */
export function unchangedTargetOutput(target: ElaborationTarget, node: GeneratedNode, factRepairIds: ReadonlySet<string> = new Set()): boolean {
  if (!target.source) return false
  const contract = parseContract({ ...target, source: target.source }).contract
  if (!contract || node.removeIds.length) return false
  const original = parseFrontmatter(target.source), expanded = parseParts(target.source)?.expandedSpec ?? original.body
  const same = (before: unknown, after: unknown): boolean => JSON.stringify(before) === JSON.stringify(after)
  return node.title === String(original.fm.title ?? '') && (factRepairIds.size > 0 || node.description === String(original.fm.desc ?? ''))
    && same(node.code, contract.code) && same(node.related, contract.related)
    && (factRepairIds.size > 0 || node.prose === null || node.prose.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() === contractBusinessProse(expanded.replace(/\r\n?/g, '\n')))
    && Object.entries(node.tables).every(([kind, rows]) => rows.every(row => {
      const previous = contract.items.find(item => item.kind === kind && item.id === row.id)
      return previous && CONTRACT_COLUMNS[previous.kind].every(column => previous.kind === 'RULE' && column === 'basis' && factRepairIds.has(previous.id) || same(contractRow(previous)[column], row[column]))
    }))
}

/** 完整候选重核同一事实差量，保护raw、全部业务列、绑定、元数据及稳定身份。 */
export function readonlyFactRepairPreservesTarget(target: ElaborationTarget, source: string, ids: ReadonlySet<string>): boolean {
  if (!ids.size || !target.source) return false
  const previous = parseContract({ ...target, source: target.source }).contract, next = parseContract({ ...target, source }).contract
  if (!previous || !next || previous.items.length !== next.items.length || previous.rawSource !== next.rawSource) return false
  const metadata = (text: string): unknown => Object.entries(parseFrontmatter(text).fm).filter(([key]) => key !== 'desc').map(([key, value]) => [key, (key === 'code' || key === 'related') && typeof value === 'string' ? [value] : value])
  if (JSON.stringify(metadata(target.source)) !== JSON.stringify(metadata(source))) return false
  const fm = parseFrontmatter(source).fm
  return unchangedTargetOutput(target, { nodeId: target.nodeId, path: target.path, title: String(fm.title ?? ''), description: String(fm.desc ?? ''), code: next.code, related: next.related, prose: null, removeIds: [], tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, next.items.filter(item => item.kind === kind).map(contractRow)])) as GeneratedTables }, ids)
}

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

/** 与业务差量共用真实表定位；围栏中的示例始终逐字保留。 */
function mapContractTables(source: string, replace: (kind: ContractKind, section: string, offset: number) => string): string {
  const fencedRanges: { start: number; end: number }[] = []
  let fence: { start: number; marker: string; length: number } | null = null, offset = 0
  for (const line of source.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (marker && !fence) fence = { start: offset, marker: marker[1][0], length: marker[1].length }
    else if (marker && fence && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) {
      fencedRanges.push({ start: fence.start, end: offset + line.length + 1 }); fence = null
    }
    offset += line.length + 1
  }
  if (fence) fencedRanges.push({ start: fence.start, end: source.length })
  return source.replace(/^(###[ \t]+(?:REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP|VERIFY)[ \t]*\n)(?:[ \t]*\n)*(?:[ \t]*\|[^\n]*\n?)+/gm, (section: string, _heading: string, offset: number) => {
    if (fencedRanges.some(range => offset >= range.start && offset < range.end)) return section
    return replace(section.match(/^###[ \t]+(\w+)/)![1] as ContractKind, section, offset)
  })
}

/** 只定位真实 expanded 中的技术表，原意及围栏示例不进入投影。 */
function mapVerificationTables(source: string, replace: (section: string) => string): string {
  const expanded = new Set<number>()
  parseParts(source, (part, _line, offset) => { if (part === 'expandedSpec') expanded.add(offset) })
  return mapContractTables(source, (kind, section, offset) => kind === 'VERIFY' && expanded.has(offset) ? replace(section) : section)
}

/** 去除且仅去除技术表；用于逐字证明技术投影未触碰任何其余正文。 */
export function withoutVerificationTables(source: string): string {
  const projected = mapVerificationTables(source.replace(/\r\n?/g, '\n'), () => '')
  return source.includes('\r\n') ? projected.replace(/\n/g, '\r\n') : projected
}

/** 只替换受审正文的 VERIFY 表；冻结登记提供定义，绝不重渲染业务或元数据。 */
export function projectVerificationTable(source: string, rows: readonly Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>[]): string {
  const columns = CONTRACT_COLUMNS.VERIFY
  const table = rows.length ? `### VERIFY\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${[row.id, markdownCell(row.command, true), markdownCell(row.cwd), row.timeoutMs].join(' | ')} |`).join('\n')}\n` : ''
  const normalized = source.replace(/\r\n?/g, '\n')
  if (source !== normalized && source !== normalized.replace(/\n/g, '\r\n')) throw new TypeError('VERIFY投影无法证明混合换行的非技术字节不变')
  let written = false
  let projected = mapVerificationTables(normalized, () => { const replacement = written ? '' : table; written = true; return replacement })
  if (!written && rows.length) {
    let insertion: number | undefined
    parseParts(normalized, (part, line, offset) => { if (part === 'expandedSpec' && line.trim() && insertion === undefined) insertion = offset })
    if (insertion === undefined) throw new TypeError('VERIFY投影缺少受审expanded正文')
    projected = normalized.slice(0, insertion) + table + normalized.slice(insertion)
  }
  const result = source.includes('\r\n') ? projected.replace(/\n/g, '\r\n') : projected
  if (withoutVerificationTables(source) !== withoutVerificationTables(result)) throw new TypeError('VERIFY投影改变了技术表以外的源码字节')
  return result
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
    const factRepair = target ? readonlyFactRepairIds(input, target).size > 0 : false
    const original = target?.source ? parseFrontmatter(target.source).fm : {}
    const originalParts = target?.source ? parseParts(target.source) : null
    const legacyBody = target?.source && !originalParts ? parseFrontmatter(target.source).body : null
    const normalizedSource = target?.source?.replace(/\r\n?/g, '\n') ?? null
    const renderingSource = normalizedSource !== null && legacyBody !== null ? `${normalizedSource.slice(0, normalizedSource.length - legacyBody.length)}## expanded spec\n\n${legacyBody}` : normalizedSource
    const parts = renderingSource ? parseParts(renderingSource) : null
    const baseline = target && renderingSource ? parseContract({ ...target, source: renderingSource }).contract : null
    const programVerificationUpdates = input.phase === 'interface_seed' ? (input.verifications ?? []).filter(policy => baseline?.items.some(item => item.kind === 'VERIFY' && item.id === policy.id) && input.authorizedChanges?.some(change => change.id === policy.id && change.action === 'update_verification')) : []
    const raw = (move && target?.source ? originalParts?.rawSource : node.nodeId === input.intent.nodeId ? input.intent.rawSource : target?.rawSource || originalParts?.rawSource) || null
    const fm = input.mode === 'preserve_business' && target?.source ? { ...original, ...(factRepair ? { desc: node.description } : {}), 'contract-schema': 'sync-v1', code: node.code, related: node.related } : { ...original, title: node.title, desc: node.description, 'contract-schema': 'sync-v1', ...(!target?.source ? { status: 'pending' } : {}), code: node.code, related: node.related }
    if (target && unchangedTargetOutput(target, node) && raw === (parts?.rawSource || null) && !move && !programVerificationUpdates.length) return { nodeId: node.nodeId, path: node.path, beforeDigest: target.sourceDigest, source: target.source! }
    const metadataEqual = Object.entries(fm).every(([key, value]) => JSON.stringify(value) === JSON.stringify((key === 'code' || key === 'related') && typeof original[key] === 'string' ? [original[key]] : original[key]) || Array.isArray(value) && !value.length && !original[key] || value === '' && original[key] === undefined)
    if (baseline && (node.prose === null || input.mode === 'preserve_business' && !factRepair) && metadataEqual && raw === (parts?.rawSource || null) && !move && !programVerificationUpdates.length && !node.removeIds.length && Object.values(node.tables).every(rows => !rows.length)) return { nodeId: node.nodeId, path: node.path, beforeDigest: target!.sourceDigest, source: target!.source! }
    const metadata = Object.entries(fm).filter(([_key, value]) => !Array.isArray(value) || value.length).map(([key, value]) => Array.isArray(value)
      ? `${key}:\n${value.map(item => `  - ${JSON.stringify(item)}`).join('\n')}`
      : `${key}: ${JSON.stringify(value)}`).join('\n')
    const sourceLines = renderingSource?.split('\n') ?? []
    const removedIds = new Set(node.removeIds)
    const replaceFactProse = factRepair && node.prose !== null
    const preserveExpanded = parts !== null && (legacyBody !== null || node.prose === null || input.mode === 'preserve_business' || factRepair)
    const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => {
      const updates = new Map(node.tables[kind as ContractKind].map(row => [String(row.id), row]))
      const rows: string[] = []
      const previous = baseline?.items.filter(item => item.kind === kind) ?? []
      if (kind === 'VERIFY') for (const policy of programVerificationUpdates) updates.set(policy.id, { id: policy.id, command: policy.command, cwd: policy.cwd, 'timeout-ms': policy.timeoutMs })
      const rowColumns = preserveExpanded && !replaceFactProse && previous.length ? contractTableCells(sourceLines[previous[0].line! - 3]) : columns
      for (const item of previous) {
        if (removedIds.has(item.id)) continue
        let update = updates.get(item.id)
        const oldRow = contractRow(item)
        if (move?.action === 'move' && item.kind === 'RULE' && item.authority === move.from.nodeId && (!update || update.authority === move.from.nodeId)) update = { ...(update ?? oldRow), authority: move.to.nodeId }
        const unchanged = update && columns.every(column => JSON.stringify(oldRow[column]) === JSON.stringify(update![column]))
        rows.push(preserveExpanded && !replaceFactProse && (!update || unchanged) ? sourceLines[item.line! - 1] : `| ${rowColumns.map(column => markdownCell((update ?? oldRow)[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
        updates.delete(item.id)
      }
      for (const row of updates.values()) rows.push(`| ${rowColumns.map(column => markdownCell(row[column], kind === 'VERIFY' && column === 'command')).join(' | ')} |`)
      return [kind, rows]
    })) as Record<ContractKind, string[]>
    const section = (kind: ContractKind): string => tables[kind].length ? `### ${kind}\n\n| ${CONTRACT_COLUMNS[kind].join(' | ')} |\n| ${CONTRACT_COLUMNS[kind].map(() => '---').join(' | ')} |\n${tables[kind].join('\n')}` : ''
    if (preserveExpanded) {
      const seen = new Set<ContractKind>()
      let expanded = replaceFactProse ? `${node.prose}\n\n${(Object.keys(CONTRACT_COLUMNS) as ContractKind[]).map(section).filter(Boolean).join('\n\n')}` : mapContractTables(parts!.expandedSpec, (kind, originalSection) => {
        seen.add(kind)
        const originalRows = originalSection.trimEnd().split('\n')
        const firstRow = originalRows.findIndex(line => /^[ \t]*\|/.test(line))
        return tables[kind].length ? [...originalRows.slice(0, firstRow + 2), ...tables[kind]].join('\n') + (originalSection.endsWith('\n') ? '\n' : '') : ''
      })
      const added = (Object.keys(CONTRACT_COLUMNS) as ContractKind[]).filter(kind => !seen.has(kind) && tables[kind].length).map(section)
      if (!replaceFactProse && added.length) expanded += `\n\n${added.join('\n\n')}`
      if (!replaceFactProse && node.prose && (!baseline && !parts!.expandedSpec.includes(node.prose.trim()) || legacyBody !== null && input.mode !== 'preserve_business')) expanded += `\n\n${node.prose}`
      const normalized = renderingSource!
      const originalBody = parseFrontmatter(normalized).body
      const ranges: Record<'rawSource' | 'expandedSpec', { start: number; end: number }[]> = { rawSource: [], expandedSpec: [] }
      parseParts(originalBody, (part, line, offset) => {
        const previous = ranges[part].at(-1)
        if (previous && previous.end + 1 === offset) previous.end = offset + line.length
        else ranges[part].push({ start: offset, end: offset + line.length })
      })
      const edits: { start: number; end: number; text: string }[] = []
      for (const [part, replacement] of [['rawSource', raw ?? ''], ['expandedSpec', expanded]] as const) {
        if (replacement === parts![part]) continue
        let written = false
        for (const range of ranges[part]) {
          const content = originalBody.slice(range.start, range.end)
          if (!content.trim()) continue
          const start = range.start + content.length - content.trimStart().length
          const end = range.end - (content.length - content.trimEnd().length)
          edits.push({ start, end, text: written ? '' : replacement })
          written = true
        }
        if (!written) {
          if (ranges[part].length) edits.push({ start: ranges[part][0].start, end: ranges[part][0].start, text: replacement })
          else {
            const expandedStart = ranges.expandedSpec[0]?.start
            const start = part === 'rawSource' ? expandedStart === undefined ? 0 : originalBody.lastIndexOf('\n', expandedStart - 2) + 1 : originalBody.length
            edits.push({ start, end: start, text: `${part === 'rawSource' ? '' : '\n\n'}## ${part === 'rawSource' ? 'raw source' : 'expanded spec'}\n\n${replacement}\n\n` })
          }
        }
      }
      let body = originalBody
      for (const edit of edits.sort((left, right) => right.start - left.start)) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end)
      let rendered = normalized.slice(0, normalized.length - originalBody.length) + body

      if (!metadataEqual) rendered = `---\n${metadata}\n---\n${parseFrontmatter(rendered).body}`
      return { nodeId: node.nodeId, path: node.path, beforeDigest: target!.sourceDigest, source: rendered === normalized && legacyBody === null ? target!.source! : target!.source!.includes('\r\n') ? rendered.replace(/\n/g, '\r\n') : rendered }
    }
    const prose = legacyBody === null ? node.prose ?? parts?.expandedSpec ?? '' : `${legacyBody}\n${node.prose ?? ''}`
    const rendered = `---\n${metadata}\n---\n# ${node.title}\n\n${raw === null ? '' : `## raw source\n\n${raw}\n\n`}## expanded spec\n\n${prose}\n\n${(Object.keys(CONTRACT_COLUMNS) as ContractKind[]).map(section).filter(Boolean).join('\n\n')}\n`
    return { nodeId: node.nodeId, path: node.path, beforeDigest: target?.sourceDigest ?? null, source: target?.source?.includes('\r\n') ? rendered.replace(/\n/g, '\r\n') : rendered }
  })
  return { inputDigest, changes, applicability: generated.applicability, ...(input.nodeChanges?.length ? { nodeChanges: structuredClone([...input.nodeChanges]) } : {}) }
}
