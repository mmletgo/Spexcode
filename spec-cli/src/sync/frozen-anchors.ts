import { blobShaForContent, extractCachedBlob, extractorFor, extractors, extOf, parseCodeEntry, parseRelation, resolveSelectors } from '@spexcode/spec-core'
import type { CachedExtraction, Extractor, Unit } from '@spexcode/spec-core'
import type { ContractFinding, ContractGraph } from '@spexcode/spec-core/contracts'

export type FrozenAnchorEvidence = {
  nodeId: string; path: string; declarationPath: string; line?: number; itemId?: string
  origin: 'code' | 'related' | 'source'; selector: string | null; unit: Unit | null
}
export type FrozenAnchorResult = { findings: ContractFinding[]; anchors: FrozenAnchorEvidence[] }

export function isReadonlyCitationFailure(finding: ContractFinding): boolean {
  return finding.severity === 'error' && (finding.code === 'anchor-dead' || Boolean(finding.citation) &&
    ['anchor-ambiguous', 'anchor-parse-error', 'anchor-file-missing', 'anchor-selector-required', 'related-file-missing'].includes(finding.code))
}

function frozenFileExtraction(files: ReadonlyMap<string, string>, paths: readonly string[], registry: Extractor[]) {
  const frozenFiles = new Map(paths.map(path => [path, files.get(path)]))
  const parsedFiles = new Map<string, CachedExtraction>()
  const readiness = new Map<Extractor, true | string>()
  return async (path: string): Promise<{ units: Unit[] } | { code: string; message: string }> => {
    const source = frozenFiles.get(path)
    if (source === undefined) return { code: 'anchor-file-missing', message: `冻结候选缺少锚点文件 ${path}` }
    const extractor = extractorFor(registry, extOf(path))
    if (!extractor) return { code: 'anchor-language-unsupported', message: `${path} 没有指定的可信语言解析器` }
    if (!readiness.has(extractor)) readiness.set(extractor, await extractor.ready())
    if (readiness.get(extractor) !== true) return { code: 'anchor-extractor-unavailable', message: `${extractor.id} 不可用：${readiness.get(extractor)}` }
    if (!parsedFiles.has(path)) parsedFiles.set(path, await extractCachedBlob(source, path, extractor, blobShaForContent(source)))
    const parsed = parsedFiles.get(path)!
    return 'error' in parsed ? { code: 'anchor-parse-error', message: `${path} 无法解析：${parsed.error}` } : parsed
  }
}

export async function findWholeFileSourcePaths(files: ReadonlyMap<string, string>, paths: readonly string[], registry: Extractor[] = extractors('')): Promise<string[]> {
  const candidates = [...new Set(paths)].sort()
  const extract = frozenFileExtraction(files, candidates, registry)
  const eligible: string[] = []
  for (const path of candidates) {
    const parsed = await extract(path)
    if ('units' in parsed && parsed.units.length === 0) eligible.push(path)
  }
  return eligible
}

/** 只解析冻结文本；使用工具自身的语言注册表，不加载候选工作区的可执行依赖。 */
export async function validateFrozenAnchors(graph: ContractGraph, files: ReadonlyMap<string, string>, registry: Extractor[] = extractors('')): Promise<FrozenAnchorResult> {
  const findings: ContractFinding[] = [], anchors: FrozenAnchorEvidence[] = []
  const report = (query: Omit<FrozenAnchorEvidence, 'unit'>, code: string, message: string, severity: 'error' | 'warning' = 'error'): void => {
    const ref = query.selector === null ? query.path : `${query.path}#${query.selector}`
    findings.push({ code, severity, nodeId: query.nodeId, path: query.declarationPath, line: query.line, itemId: query.itemId, citation: { origin: query.origin, ref }, message })
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
      queries.push({ nodeId: contract.nodeId, declarationPath: contract.path, line: item.line, itemId: item.id, path: entry.anchor === null ? item.source.ref : entry.path, selector: entry.anchor, origin: 'source' })
    }
  }
  const extract = frozenFileExtraction(files, queries.map(query => query.path), registry)
  for (const query of queries) {
    const evidence: FrozenAnchorEvidence = { ...query, unit: null }
    anchors.push(evidence)
    const parsed = await extract(query.path)
    if ('code' in parsed) { report(query, parsed.code, parsed.message); continue }
    if (query.selector === null) {
      if (parsed.units.length) report(query, 'anchor-selector-required', `${query.path} 含命名声明，代码来源必须使用 ${query.path}#符号`)
      continue
    }
    const verdict = resolveSelectors(parsed.units, [query.selector])[0]
    if ('dead' in verdict) {
      const alternatives = [...new Set(parsed.units.map(unit => unit.name).filter(name => name.endsWith(`.${query.selector}`)))].slice(0, 5)
      report(query, 'anchor-dead', `${query.path}#${query.selector} 不存在于冻结候选${alternatives.length ? `；同一文件中的限定名备选 ${alternatives.join(', ')}` : ''}`)
    }
    else if ('ambiguous' in verdict) report(query, 'anchor-ambiguous', `${query.path}#${query.selector} 匹配 ${verdict.ambiguous} 个符号`)
    else {
      evidence.unit = verdict.ok
      if (verdict.ok.typeOnly) report(query, 'anchor-type-only', `${query.path}#${query.selector} 是类型符号，不证明业务行为`, 'warning')
    }
  }
  return { findings, anchors }
}
