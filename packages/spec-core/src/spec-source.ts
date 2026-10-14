export type FmValue = string | string[]

// A value wrapped in matching YAML quotes is that string: "…" takes \" and \\ escapes, '…' takes ''. Anything
// else — a lone or inner quote included — is kept verbatim, as the plain-scalar reading always did.
function yamlScalar(raw: string): string {
  const v = raw.trim()
  // the closing quote counts only when an even number of backslashes precede it
  if (v.length >= 2 && v.startsWith('"') && /(^|[^\\])(\\\\)*"$/.test(v.slice(1))) {
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

// line-based frontmatter: scalars are `key: value`; an empty key followed by `- item` lines is a list (e.g. `code:`).
export function parseFrontmatter(src: string) {
  const fm: Record<string, FmValue> = {}
  let body = src.replace(/\r\n?/g, '\n')
  const m = body.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (m) {
    let key: string | null = null
    for (const line of m[1].split('\n')) {
      const item = line.match(/^\s*-\s+(.*)$/)
      if (item && key) {
        if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key] as string] : []
        ;(fm[key] as string[]).push(yamlScalar(item[1]))
        continue
      }
      const i = line.indexOf(':')
      if (i > 0) { key = line.slice(0, i).trim(); fm[key] = yamlScalar(line.slice(i + 1)) }
    }
    body = m[2]
  }
  return { fm, body }
}

export type SpecParts = {
  rawSource: string
  expandedSpec: string
}
const PART_ALIASES: Record<string, 'rawSource' | 'expandedSpec'> = {
  'raw source': 'rawSource',
  'expanded spec': 'expandedSpec',
}
/** 可选回调复用本次围栏感知扫描，提供规范化换行后的真实段落内容行位置。 */
export function parseParts(body: string, onContentLine?: (part: keyof SpecParts, line: string, offset: number) => void): SpecParts | null {
  const acc = { rawSource: [] as string[], expandedSpec: [] as string[] }
  let cur: 'rawSource' | 'expandedSpec' | null = null
  let fenceMarker: string | null = null
  let fenceLength = 0
  let any = false, offset = 0
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const lineOffset = offset
    offset += line.length + 1
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    const wasInFence = fenceMarker !== null
    if (fence) {
      if (!fenceMarker) { fenceMarker = fence[1][0]; fenceLength = fence[1].length }
      else if (fence[1][0] === fenceMarker && fence[1].length >= fenceLength && !fence[2].trim()) fenceMarker = null
    }
    if (!wasInFence && !fence) {
      const h2 = line.match(/^##\s+(.+?)\s*$/)   // exactly two hashes — `###` won't match
      if (h2) {
        const key = PART_ALIASES[h2[1].trim().toLowerCase()]
        if (key) { cur = key; any = true; continue }
        // an unrecognized `## …` heading is just content of the current part — fall through.
      }
    }
    if (cur) { acc[cur].push(line); onContentLine?.(cur, line, lineOffset) }
  }
  if (!any) return null
  const t = (a: string[]) => a.join('\n').trim()
  return { rawSource: t(acc.rawSource), expandedSpec: t(acc.expandedSpec) }
}

