import { parseFrontmatter, parseParts } from '../spec-source.js'
import type { ContractItem, ContractKind, ContractSource, ParseContractInput, ParseContractResult } from './types.js'

export const CONTRACT_COLUMNS: Record<ContractKind, readonly string[]> = {
  REQ: ['id', 'goal', 'source', 'constraints', 'success', 'depends-on'],
  FLOW: ['id', 'req', 'actors', 'entry', 'preconditions', 'steps', 'terminal', 'source', 'depends-on'],
  STEP: ['id', 'flow', 'action', 'input', 'output', 'rules', 'next', 'source', 'depends-on'],
  STATE: ['id', 'object', 'meaning', 'initial', 'terminal', 'feedback', 'source', 'depends-on'],
  EVENT: ['id', 'object', 'origin', 'trigger', 'input', 'source', 'depends-on'],
  TR: ['id', 'object', 'from', 'event', 'condition', 'to', 'disposition', 'reason', 'effects', 'rules', 'source', 'depends-on'],
  RULE: ['id', 'scope', 'constraint', 'basis', 'authority', 'source', 'depends-on'],
  AC: ['id', 'covers', 'preconditions', 'action', 'assertion', 'test', 'command', 'source', 'depends-on'],
  GAP: ['id', 'kind', 'unknown', 'affects', 'evidence', 'decision', 'source', 'depends-on'],
  VERIFY: ['id', 'command', 'cwd', 'timeout-ms'],
}
const OPTIONAL = new Set(['depends-on', 'constraints', 'preconditions', 'input', 'output', 'rules', 'effects', 'to'])
const REF_COLUMNS = new Set(['req', 'steps', 'rules', 'covers', 'depends-on', 'affects'])
export const contractIds = (value: string): string[] => value === '-' ? [] : value.split(',').map((v) => v.trim())
export const isRepositoryPath = (value: string, allowRoot = false): boolean =>
  (allowRoot && value === '.') || (!!value && !/^[\/\\]|^[A-Za-z]:|[\0\r\n*?]/.test(value) && !value.split(/[\/\\]/).some((part) => !part || part === '..' || part === '.'))

// Markdown table separators inside escaped text or a matched code span belong to the cell.
export function contractTableCells(line: string): string[] {
  const cells: string[] = []
  let cell = '', codeLength = 0
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '\\' && i + 1 < line.length) {
      if (codeLength && line[i + 1] !== '|') { cell += char; continue }
      const next = line[++i]
      cell += next === '|' || next === '\\' || next === '`' ? next : `\\${next}`
    } else if (char === '`') {
      let end = i + 1
      while (line[end] === '`') end++
      const length = end - i
      if (!codeLength && line.indexOf('`'.repeat(length), end) >= 0) codeLength = length
      else if (codeLength === length) codeLength = 0
      cell += line.slice(i, end)
      i = end - 1
    } else if (char === '|' && !codeLength) { cells.push(cell.trim()); cell = '' }
    else cell += char
  }
  cells.push(cell.trim())
  if (!cells[0]) cells.shift()
  if (!cells.at(-1)) cells.pop()
  return cells.map((value) => {
    const wrapped = value.match(/^(`+)([\s\S]*?)\1$/)
    return wrapped ? wrapped[2].trim() : value
  })
}

export function parseContract(input: ParseContractInput): ParseContractResult {
  const { fm, body } = parseFrontmatter(input.source)
  const findings: ParseContractResult['findings'] = []
  const fail = (code: string, message: string, line?: number, itemId?: string): void => {
    findings.push({ code, severity: 'error', nodeId: input.nodeId, path: input.path, line, itemId, message })
  }
  if (fm['contract-schema'] === undefined) return { contract: null, findings }
  if (fm['contract-schema'] !== 'sync-v1') {
    fail('unsupported-schema', 'contract-schema 必须是 sync-v1')
    return { contract: null, findings }
  }
  const parts = parseParts(body)
  const normalized = input.source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const items: ContractItem[] = []
  let expanded = false, fenceMarker: string | null = null, fenceLength = 0
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (!fenceMarker) { fenceMarker = fence[1][0]; fenceLength = fence[1].length }
      else if (fence[1][0] === fenceMarker && fence[1].length >= fenceLength && !fence[2].trim()) fenceMarker = null
      continue
    }
    if (fenceMarker) continue
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2 && ['raw source', 'expanded spec'].includes(h2[1].toLowerCase())) expanded = h2[1].toLowerCase() === 'expanded spec'
    if (!expanded) continue
    const heading = line.match(/^###\s+(REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP|VERIFY)\s*$/)
    if (!heading) continue
    const kind = heading[1] as ContractKind
    if (seen.has(kind)) fail('duplicate-table', `${kind} 表重复`, i + 1)
    seen.add(kind)
    let at = i + 1
    while (at < lines.length && !lines[at].trim()) at++
    const header = contractTableCells(lines[at] ?? '')
    const columns = CONTRACT_COLUMNS[kind]
    if (header.length !== columns.length || new Set(header).size !== header.length || columns.some((c) => !header.includes(c))) {
      fail('table-header', `${kind} 表必须包含固定完整列：${columns.join(', ')}`, at + 1)
      continue
    }
    const delimiter = contractTableCells(lines[at + 1] ?? '')
    if (delimiter.length !== header.length || delimiter.some((c) => !/^:?-{3,}:?$/.test(c))) {
      fail('table-delimiter', `${kind} 表缺少 Markdown 分隔行`, at + 2)
      continue
    }
    at += 2
    let count = 0
    while (at < lines.length && /^\s*\|/.test(lines[at])) {
      const rowLine = at + 1
      const cells = contractTableCells(lines[at++])
      count++
      if (cells.length !== header.length) { fail('table-row', `${kind} 行列数与表头不一致`, rowLine); continue }
      const row = Object.fromEntries(header.map((name, index) => [name, cells[index]]))
      const before = findings.length
      const id = row.id
      if (!new RegExp(`^${kind}-[A-Z0-9]+(?:-[A-Z0-9]+)+$`).test(id)) fail('invalid-id', `非法 ${kind} ID：${id}`, rowLine, id)
      for (const [column, value] of Object.entries(row)) {
        if (!value || (value === '-' && !OPTIONAL.has(column))) fail('required-value', `${id}.${column} 不能为空`, rowLine, id)
      }
      const location = { nodeId: input.nodeId, path: input.path, line: rowLine }
      const fields: Record<string, unknown> = { ...location, kind, id }
      if (kind !== 'VERIFY') {
        const source = row.source.match(/^(user|decision|rule|derived|code):(.+)$/)
        if (!source || (source[1] === 'user' && source[2] !== 'raw' && !/^REQ-[A-Z0-9-]+$/.test(source[2])) ||
          (source[1] === 'rule' && !/^RULE-[A-Z0-9-]+$/.test(source[2])) ||
          (source[1] === 'derived' && !/^(REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP)-[A-Z0-9-]+$/.test(source[2])) ||
          (source[1] === 'code' && (!source[2].includes('#') || !isRepositoryPath(source[2].split('#')[0]) || !source[2].split('#')[1]))) {
          fail('invalid-source', `${id} 来源格式不合法`, rowLine, id)
        } else fields.source = { kind: source[1], ref: source[2] } as ContractSource
      }
      for (const [name, value] of Object.entries(row)) {
        if (name === 'id' || name === 'source') continue
        const key = name === 'depends-on' ? 'dependsOn' : name === 'timeout-ms' ? 'timeoutMs' : name === 'kind' ? 'gapKind' : name
        if (REF_COLUMNS.has(name)) fields[key] = contractIds(value)
        else if (name === 'initial' || name === 'terminal' && kind === 'STATE') {
          if (value !== 'true' && value !== 'false') fail('invalid-boolean', `${id}.${name} 必须是 true/false`, rowLine, id)
          fields[key] = value === 'true'
        } else if (name === 'next' || name === 'terminal' && kind === 'FLOW') fields[key] = value === 'END' ? 'END' : contractIds(value)
        else if (name === 'to') fields[key] = value === '-' ? null : value
        else if (name === 'command' && kind === 'VERIFY') {
          try {
            const argv: unknown = JSON.parse(value)
            if (!Array.isArray(argv) || !argv.length || argv.some((v) => typeof v !== 'string' || !v || /[\0\r\n]/.test(v))) fail('invalid-command', `${id}.command 必须是非空 JSON argv 字符串数组`, rowLine, id)
            else if (/^(?:sh|bash|zsh|fish|dash|ksh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(argv[0].split(/[\/\\]/).at(-1)!)) fail('shell-command', `${id}.command 必须直接调用工具，不能调用 shell`, rowLine, id)
            else fields.command = argv
          } catch { fail('invalid-command', `${id}.command 必须是 JSON argv 数组`, rowLine, id) }
        } else if (name === 'timeout-ms') {
          if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('invalid-timeout', `${id}.timeout-ms 必须是正整数`, rowLine, id)
          fields.timeoutMs = Number(value)
        } else fields[key] = value === '-' ? '' : value
      }
      if (kind === 'VERIFY' && !isRepositoryPath(row.cwd, true)) fail('invalid-cwd', `${id}.cwd 必须是仓库内相对目录`, rowLine, id)
      if (kind === 'AC') {
        const hash = row.test.lastIndexOf('#')
        if (hash < 1 || !isRepositoryPath(row.test.slice(0, hash)) || !/^[A-Z][A-Z0-9-]+$/.test(row.test.slice(hash + 1))) fail('invalid-test-binding', `${id}.test 必须绑定测试路径#稳定用例ID`, rowLine, id)
      }
      if (kind === 'TR' && !['transition', 'reject', 'idempotent', 'not_applicable'].includes(row.disposition)) fail('invalid-disposition', `${id} 处置类型无效`, rowLine, id)
      if (kind === 'GAP' && !['missing_fact', 'conflict'].includes(row.kind)) fail('invalid-gap-kind', `${id} GAP 类型无效`, rowLine, id)
      if (findings.length === before) items.push(fields as ContractItem)
    }
    if (!count) fail('empty-table', `${kind} 表不能没有业务行`, at + 1)
    i = at - 1
  }
  const list = (v: string | string[] | undefined): string[] => Array.isArray(v) ? [...v] : v ? [v] : []
  const code = list(fm.code), related = list(fm.related)
  for (const entry of code) {
    if (!isRepositoryPath(entry.split('#')[0]) || entry.includes('#') && !entry.split('#')[1]) fail('invalid-code-binding', `非法治理锚点：${entry}`)
  }
  if (new Set(code.map((entry) => entry.split('#')[0])).size > 1) fail('multiple-governed-files', '一个契约节点最多治理一个代码文件；跨文件职责须拆为子节点')
  return { contract: findings.length ? null : { schema: 'sync-v1', nodeId: input.nodeId, path: input.path, rawSource: parts?.rawSource ?? body.trim(), expandedSpec: parts?.expandedSpec ?? '', code, related, items }, findings }
}
