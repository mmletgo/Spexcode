import { blobShaForContent, extractCachedBlob, extractorFor, extractors, extOf, parseCodeEntry, parseRelation, resolveSelectors } from '@spexcode/spec-core'
import type { CachedExtraction, Extractor, Unit } from '@spexcode/spec-core'
import type { ContractFinding, ContractGraph } from '@spexcode/spec-core/contracts'

export type FrozenAnchorEvidence = {
  nodeId: string; path: string; declarationPath: string; line?: number; itemId?: string
  origin: 'code' | 'related' | 'source'; selector: string; unit: Unit | null
}
export type FrozenAnchorResult = { findings: ContractFinding[]; anchors: FrozenAnchorEvidence[] }

/** 只解析冻结文本；使用工具自身的语言注册表，不加载候选工作区的可执行依赖。 */
export async function validateFrozenAnchors(graph: ContractGraph, files: ReadonlyMap<string, string>, registry: Extractor[] = extractors('')): Promise<FrozenAnchorResult> {
  const frozenFiles = new Map(files)
  const findings: ContractFinding[] = [], anchors: FrozenAnchorEvidence[] = []
  const report = (query: Omit<FrozenAnchorEvidence, 'unit'>, code: string, message: string, severity: 'error' | 'warning' = 'error'): void => {
    findings.push({ code, severity, nodeId: query.nodeId, path: query.declarationPath, line: query.line, itemId: query.itemId, message })
  }
  const queries: Omit<FrozenAnchorEvidence, 'unit'>[] = []
  for (const contract of graph.contracts) {
    for (const origin of ['code', 'related'] as const) {
      const parsed = parseRelation(contract[origin], origin)
      for (const message of parsed.problems) findings.push({ code: 'anchor-declaration', severity: 'error', nodeId: contract.nodeId, path: contract.path, message })
      for (const entry of parsed.entries) for (const selector of entry.selectors)
        queries.push({ nodeId: contract.nodeId, declarationPath: contract.path, path: entry.path, selector, origin })
    }
    for (const item of contract.items) if (item.kind !== 'VERIFY' && item.source.kind === 'code') {
      const entry = parseCodeEntry(item.source.ref)
      if (entry.anchor) queries.push({ nodeId: contract.nodeId, declarationPath: contract.path, line: item.line, itemId: item.id, path: entry.path, selector: entry.anchor, origin: 'source' })
    }
  }
  const parsedFiles = new Map<string, CachedExtraction>()
  const readiness = new Map<Extractor, true | string>()
  for (const query of queries) {
    const evidence: FrozenAnchorEvidence = { ...query, unit: null }
    anchors.push(evidence)
    const source = frozenFiles.get(query.path)
    if (source === undefined) { report(query, 'anchor-file-missing', `冻结候选缺少锚点文件 ${query.path}`); continue }
    const extractor = extractorFor(registry, extOf(query.path))
    if (!extractor) { report(query, 'anchor-language-unsupported', `${query.path} 没有指定的可信语言解析器`); continue }
    if (!readiness.has(extractor)) readiness.set(extractor, await extractor.ready())
    if (readiness.get(extractor) !== true) { report(query, 'anchor-extractor-unavailable', `${extractor.id} 不可用：${readiness.get(extractor)}`); continue }
    if (!parsedFiles.has(query.path)) parsedFiles.set(query.path, await extractCachedBlob(source, query.path, extractor, blobShaForContent(source)))
    const parsed = parsedFiles.get(query.path)!
    if ('error' in parsed) { report(query, 'anchor-parse-error', `${query.path} 无法解析：${parsed.error}`); continue }
    const verdict = resolveSelectors(parsed.units, [query.selector])[0]
    if ('dead' in verdict) report(query, 'anchor-dead', `${query.path}#${query.selector} 不存在于冻结候选`)
    else if ('ambiguous' in verdict) report(query, 'anchor-ambiguous', `${query.path}#${query.selector} 匹配 ${verdict.ambiguous} 个符号`)
    else {
      evidence.unit = verdict.ok
      if (verdict.ok.typeOnly) report(query, 'anchor-type-only', `${query.path}#${query.selector} 是类型符号，不证明业务行为`, 'warning')
    }
  }
  return { findings, anchors }
}
