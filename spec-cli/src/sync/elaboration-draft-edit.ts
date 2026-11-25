import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter } from '@spexcode/spec-core/contracts'
import type { ContractFinding, ContractKind } from '@spexcode/spec-core/contracts'
import { draftVerificationOwnershipMatches, inspectElaborationDraftEdit, withDraftVerificationRows } from './elaboration.js'
import { elaborationTargetBindings } from './elaboration-markdown.js'
import type { ContractCell, GeneratedTables, GeneratedTargetElaboration } from './elaboration-markdown.js'
import { ELABORATION_SCHEMA, elaborationSchema, outputErrors } from './elaboration-schema.js'
import type { Applicability, ElaborationInput } from './elaboration-types.js'
import { claimFileMutex } from './file-mutex.js'
import { contentHash, identifyRawWorktree, objectGit, sourceGit } from './snapshot.js'
import { stageDraftEditorPath } from './stage-worktree.js'
import type { StageDraftBinding } from './stage-worktree.js'

type DraftPlan = { version: 'incremental-elaboration-draft-v1'; inputDigest: string; binding: StageDraftBinding; input: ElaborationInput }
type DraftNode = GeneratedTargetElaboration['changes'][number]
type RowKind = Exclude<ContractKind, 'VERIFY'>
type Edit = Pick<DraftNode, 'targetIndex'> & Partial<Omit<DraftNode, 'targetIndex' | 'tables'>> & {
  put?: { kind: RowKind; row: Record<string, ContractCell> }[]
  drop?: string[]
}
type Batch = { revision: string | null; changes?: Edit[]; applicability?: Applicability[]; replaceMalformed?: boolean }

const properties = ELABORATION_SCHEMA.properties as Record<string, Record<string, unknown>>
const nodeFields = (properties.changes.items as { properties: Record<string, unknown> }).properties
const rowFields = (nodeFields.tables as { properties: Record<ContractKind, { items: Record<string, unknown> }> }).properties
const rowKinds = (Object.keys(rowFields) as ContractKind[]).filter((kind): kind is RowKind => kind !== 'VERIFY')
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const revisions = { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }
const idList = { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 64 }
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

const edits = {
  targetIndex: nodeFields.targetIndex, title: nodeFields.title, description: nodeFields.description,
  code: nodeFields.code, related: nodeFields.related, prose: nodeFields.prose, removeIds: nodeFields.removeIds, drop: idList,
}
const batchSchema = (rowShape: Record<string, unknown>) => object({
  revision: revisions,
  replaceMalformed: { type: 'boolean' },
  changes: { type: 'array', maxItems: 16, items: object({
    ...edits, put: { type: 'array', maxItems: 64, items: rowShape },
  }, ['targetIndex']) },
  applicability: { type: 'array', maxItems: 10, items: properties.applicability.items },
}, ['revision'])
const batchEnvelope = batchSchema(object({ kind: { enum: rowKinds }, row: { type: 'object' } }, ['kind', 'row']))
export const draftEditSchema = batchSchema({ anyOf: rowKinds.map(kind => object({
  kind: { enum: [kind] }, row: rowFields[kind].items,
}, ['kind', 'row'])) })
export const draftInspectSchema = object({
  ids: { type: 'array', maxItems: 64, items: object({
    targetIndex: nodeFields.targetIndex, kind: { enum: rowKinds },
    key: { type: 'string', pattern: '^[A-Z0-9]+(?:-[A-Z0-9]+)*$' },
  }, ['targetIndex', 'kind', 'key']) },
})
type Reservation = { targetIndex: number; kind: RowKind; key: string }

const rejectionsDuringEdit = new Set([
  'duplicate-id', 'reference-kind', 'dangling-reference', 'transition-object', 'missing-source-file',
  'unverified_new_code_anchor', 'verification_registration_mismatch', 'verification_reference_unregistered',
  'protected_item_removed', 'retired_id_reused', 'verification_policy_changed', 'acceptance_update_unauthorized',
])
const emptyDraft = (): GeneratedTargetElaboration => ({ version: 'elaboration-target-rows-v3', changes: [], applicability: [] })
const issueKey = (issue: ContractFinding): string => JSON.stringify([issue.code, issue.path, issue.itemId, issue.relatedIds, issue.message])
const reportFindings = (findings: ContractFinding[]) => ({ diagnosticCount: findings.length, diagnostics: findings.slice(0, 32) })

function initialNode(input: ElaborationInput, index: number): DraftNode {
  const target = input.targets[index]
  const fm = target.source ? parseFrontmatter(target.source).fm : {}
  const relation = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  return { targetIndex: index, title: String(fm.title ?? target.nodeId), description: String(fm.desc ?? ''), code: relation(fm.code),
    related: relation(fm.related), prose: null, removeIds: [], tables: Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables }
}

function mergeBatch(input: ElaborationInput, draft: GeneratedTargetElaboration, batch: Batch): GeneratedTargetElaboration {
  const output = structuredClone(draft)
  const bindings = new Set(elaborationTargetBindings(input).map(target => target.targetIndex))
  const targets = new Set<number>()
  const boundaries = new Set<Applicability['boundary']>()
  for (const { targetIndex, put, drop, ...metadata } of batch.changes ?? []) {
    if (!bindings.has(targetIndex) || targets.has(targetIndex)) throw new TypeError(`目标不存在、已退役或在本批重复: ${targetIndex}`)
    targets.add(targetIndex)
    if (metadata.removeIds?.some(id => id.startsWith('VERIFY-'))) throw new TypeError('VERIFY只接受冻结政策变更')
    const node = output.changes.find(target => target.targetIndex === targetIndex) ?? initialNode(input, targetIndex)
    if (!output.changes.includes(node)) output.changes.push(node)
    Object.assign(node, metadata)
    const edited = new Set<string>()
    for (const id of drop ?? []) {
      const kind = rowKinds.find(kind => node.tables[kind].some(row => row.id === id))
      if (!kind || edited.has(id)) throw new TypeError(`仅可丢弃实际存在且本批未改过的草稿行: ${id}`)
      edited.add(id)
      node.tables[kind] = node.tables[kind].filter(row => row.id !== id)
    }
    for (const { kind, row } of put ?? []) {
      const id = String(row.id)
      if (edited.has(id)) throw new TypeError(`本批重复修改同一行: ${id}`)
      edited.add(id)
      const index = node.tables[kind].findIndex(previous => previous.id === id)
      if (index < 0) node.tables[kind].push(row)
      else node.tables[kind][index] = row
    }
  }
  for (const boundary of batch.applicability ?? []) {
    if (boundaries.has(boundary.boundary)) throw new TypeError(`本批重复修改适用性边界: ${boundary.boundary}`)
    boundaries.add(boundary.boundary)
    const index = output.applicability.findIndex(previous => previous.boundary === boundary.boundary)
    if (index < 0) output.applicability.push(boundary)
    else output.applicability[index] = boundary
  }
  return withDraftVerificationRows(input, output)
}

/** 在固定P1工作树处理结构化小批提交，写入对象与原草稿协议一致。 */
export function executeDraftEdit(root: string, seed: string, owner: string, action: 'inspect' | 'apply' | 'check', payload: unknown = {}): Record<string, unknown> {
  if (!commitPattern.test(seed) || !/^[a-f0-9]{64}$/.test(owner)) throw new TypeError('草稿需要冻结seed和owner')
  const source = identifyRawWorktree(root), git = (...args: string[]) => objectGit(source.commonDir, args).toString('utf8').trim()
  if (source.gitDir === source.commonDir || git('rev-parse', '--verify', `refs/spex-sync/seeds/${seed}`) !== seed) throw new Error('草稿操作只接受已保活的阶段工作树')
  objectGit(source.commonDir, ['merge-base', '--is-ancestor', seed, sourceGit(source.canonicalRoot, ['rev-parse', 'HEAD']).toString().trim()])
  const path = `.spex-sync-drafts/${owner}.json`
  const plan = JSON.parse(git('show', `${seed}:${stageDraftEditorPath({ path })}`)) as DraftPlan
  const { input, inputDigest, binding } = plan
  if (plan.version !== 'incremental-elaboration-draft-v1' || binding.path !== path || binding.ownerDigest !== owner
      || !input.historyInput || input.historyInput.source.commonDir !== source.commonDir || source.canonicalRoot === input.root
      || contentHash(objectGit(source.commonDir, ['show', `${seed}:${path.replace(/\.json$/, '.schema.json')}`])) !== binding.schemaDigest) {
    throw new Error('草稿工作树、冻结schema或owner不匹配')
  }
  const file = join(source.canonicalRoot, path)
  if (!lstatSync(dirname(file)).isDirectory()) throw new Error('草稿目录必须是真实目录')
  const lock = action === 'apply' ? claimFileMutex(join(source.gitDir, 'spex-elaboration-draft.sqlite')) : undefined
  if (lock === null) return { ok: false, errors: ['另一个草稿批次正在写入，先重新读取草稿摘要'] }
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat && !stat.isFile()) throw new Error('草稿必须是普通文件')
    const bytes = stat ? readFileSync(file) : null, revision = bytes === null ? null : contentHash(bytes)
    let draft: unknown = emptyDraft()
    let parseError: string | undefined
    if (bytes) {
      try { draft = JSON.parse(bytes.toString('utf8')) as unknown }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        parseError = error.message
      }
    }
    const draftSchema = elaborationSchema(input)
    delete (draftSchema.properties as typeof properties).applicability.minItems
    const shapeErrors = parseError ? [parseError] : outputErrors(draft, draftSchema)
    if (action === 'check') {
      if (bytes === null) return { ok: false, revision, errors: ['先用 apply 保存第一批草稿'] }
      if (shapeErrors.length) return { ok: false, revision, errors: shapeErrors }
      if (!draftVerificationOwnershipMatches(input, draft as GeneratedTargetElaboration)) {
        return { ok: false, revision, errors: ['先用 apply 保存由冻结登记派生的共享VERIFY'] }
      }
      const ready = inspectElaborationDraftEdit(input, draft, inputDigest)
      return { ok: !ready.errors.length && !ready.blocking.length, revision, errors: ready.errors, ...reportFindings(ready.blocking) }
    }
    const prior = shapeErrors.length ? { errors: shapeErrors, blocking: [] } : inspectElaborationDraftEdit(input, draft, inputDigest, true)
    if (action === 'inspect') {
      const errors = outputErrors(payload, draftInspectSchema)
      if (errors.length) return { ok: false, revision, errors }
      const targets = elaborationTargetBindings(input)
      const reservations = (payload as { ids?: Reservation[] }).ids ?? []
      if (reservations.some(row => !targets.some(target => target.targetIndex === row.targetIndex))) return { ok: false, revision, errors: ['不能为非冻结目标分配ID'] }
      const ids = reservations.map(({ targetIndex, kind, key }) => ({ targetIndex, kind, key,
        id: `${kind}-${key}-${contentHash(JSON.stringify([owner, targetIndex, kind, key])).slice(0, 16).toUpperCase()}`,
      }))
      const references = new Map([...input.targets, ...input.context ?? []].flatMap(target => target.source
        ? parseContract({ ...target, source: target.source }).contract?.items.map(({ id, kind }) => [id, { id, kind, path: target.path }] as const) ?? []
        : []))
      if (!shapeErrors.length) for (const node of (draft as GeneratedTargetElaboration).changes) {
        for (const id of node.removeIds) references.delete(id)
        const target = targets.find(target => target.targetIndex === node.targetIndex)
        if (!target) continue
        for (const kind of rowKinds) for (const row of node.tables[kind]) {
          const id = String(row.id)
          references.set(id, { id, kind, path: target.path })
        }
      }
      return { ok: true, path, revision, targets, ids, references: [...references.values()],
        verifications: input.verifications?.map(({ id }) => id) ?? [], schemas: { inspect: draftInspectSchema, apply: draftEditSchema },
        errors: prior.errors, ...reportFindings(prior.blocking) }
    }
    const errors = outputErrors(payload, batchEnvelope)
    if (errors.length) return { ok: false, revision, errors }
    const batch = payload as Batch
    for (const [index, change] of (batch.changes ?? []).entries()) for (const [rowIndex, { kind, row }] of (change.put ?? []).entries()) {
      errors.push(...outputErrors(row, rowFields[kind].items, `$.changes[${index}].put[${rowIndex}].row`))
    }
    if (errors.length) return { ok: false, revision, errors }
    if (batch.revision !== revision) return { ok: false, revision, errors: ['草稿已变化，重新 inspect 后再提交'] }
    if (shapeErrors.length && !batch.replaceMalformed) return { ok: false, revision, errors: shapeErrors }
    if (batch.replaceMalformed && !shapeErrors.length) return { ok: false, revision, errors: ['只有格式损坏的原稿才允许显式重新开始'] }
    let next: GeneratedTargetElaboration
    try { next = mergeBatch(input, shapeErrors.length ? emptyDraft() : draft as GeneratedTargetElaboration, batch) }
    catch (error) {
      if (!(error instanceof TypeError)) throw error
      return { ok: false, revision, errors: [error.message] }
    }
    const checked = inspectElaborationDraftEdit(input, next, inputDigest, true)
    const existing = new Set(prior.blocking.map(issueKey))
    const rejected = checked.blocking.filter(issue => rejectionsDuringEdit.has(issue.code) && !existing.has(issueKey(issue)))
    if (checked.errors.length || rejected.length) return { ok: false, revision, errors: checked.errors, ...reportFindings(rejected) }
    const encoded = JSON.stringify(next, null, 2) + '\n'
    const temporary = mkdtempSync(join(dirname(file), '.edit-'))
    try {
      const pending = join(temporary, 'draft')
      writeFileSync(pending, encoded, { mode: 0o600, flag: 'wx' })
      lock!.assertHeld()
      renameSync(pending, file)
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    return { ok: true, revision: contentHash(encoded), ...reportFindings(checked.blocking) }
  } finally {
    lock?.release()
  }
}

/** MCP与命令行共用同一草稿写入和校验边界。 */
export async function serveDraftEditor(root: string, seed: string, owner: string): Promise<void> {
  const tools = [
    { name: 'inspect', description: '读取冻结目标、可选引用、草稿当前版本，可按目标和业务键生成稳定ID。', inputSchema: draftInspectSchema },
    { name: 'apply', description: '原子提交一小批带类型的业务行和适用性。', inputSchema: draftEditSchema },
    { name: 'check', description: '使用正式P1校验器检查当前草稿是否可以进入独审。', inputSchema: object({}) },
  ]
  for await (const line of createInterface({ input: process.stdin })) {
    let request: { id?: string | number | null; method?: string; params?: { name?: string; arguments?: unknown } }
    const send = (id: unknown, value: object): void => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...value }) + '\n') }
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { send(null, { error: { code: -32600, message: 'Invalid request' } }); continue }
      request = parsed
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      send(null, { error: { code: -32700, message: 'Parse error' } }); continue
    }
    if (request.id === undefined) continue
    if (request.method === 'initialize') send(request.id, { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spex-elaboration-draft', version: '1' } } })
    else if (request.method === 'tools/list') send(request.id, { result: { tools } })
    else if (request.method === 'ping') send(request.id, { result: {} })
    else if (request.method === 'tools/call') {
      const action = request.params?.name
      if (action !== 'inspect' && action !== 'apply' && action !== 'check') { send(request.id, { error: { code: -32602, message: 'Unknown tool' } }); continue }
      const args = request.params?.arguments ?? {}
      const errors = action === 'check' ? outputErrors(args, object({})) : []
      const result = errors.length ? { ok: false, errors } : executeDraftEdit(root, seed, owner, action, args)
      send(request.id, { result: { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } })
    } else send(request.id, { error: { code: -32601, message: 'Unknown method' } })
  }
}
