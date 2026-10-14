import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { SyncDecisionInput } from './writeback-types.js'
import type { PreparedSpecBodyEdit } from '../spec-body-edit.js'
import { isUtf8Text, mergeText } from './composition.js'
import type { CompositionConflict } from './composition.js'
import type { BlobRef, ComposedInputRef, InputSnapshot, WorktreeIdentity } from './operation-types.js'
import { contentHash, identifyWorktree, objectGit, readEvidence, readObject, readTree, validateRepositoryPath, verifySnapshot, writeEvidence, writeObject, writeTree } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

export type ControlledRequestOrigin = { kind: 'user_edit' | 'user_decision'; requestId: string; nodeId: string; intent: string }
export type ControlledRequest = {
  schemaVersion: 1; inputId: string; source: WorktreeIdentity; path: string
  before: TreeEntry; next: TreeEntry; requestTree: string; origin: ControlledRequestOrigin
}
export type ControlledDecision = SyncDecisionInput & { schemaVersion: 1; type: 'sync.decision'; source: WorktreeIdentity; originalRequestBlob?: BlobRef }
export type PreparedControlledRequest = { changed: false; requestBlob: null } | { changed: true; requestBlob: BlobRef }

/** 业务裁决身份不含运输请求键；同选择的重放不能重开预算。 */
export function controlledDecisionIdentity(input: SyncDecisionInput): string {
  return contentHash(JSON.stringify({ operationId: input.operationId, inputId: input.inputId, analysisRef: input.analysisRef.sha256, findingIds: [...input.findingIds].sort(), decision: input.decision.choice === 'new_rule' ? { choice: input.decision.choice, rule: input.decision.rule } : { choice: input.decision.choice } }))
}
/** 用户裁决是独立输入，即使保持原需求没有正文差量也必须保留。 */
export function prepareControlledDecision(snapshot: InputSnapshot, input: SyncDecisionInput, originalRequestBlob?: BlobRef): BlobRef {
  const request: ControlledDecision = { schemaVersion: 1, type: 'sync.decision', requestId: input.requestId, operationId: input.operationId, inputId: input.inputId, analysisRef: input.analysisRef, findingIds: input.findingIds, decision: input.decision, source: snapshot.source, ...(originalRequestBlob ? { originalRequestBlob } : {}) }
  checkDecision(snapshot, request)
  return writeEvidence(snapshot.source.commonDir, request)
}
function checkDecision(snapshot: InputSnapshot, request: ControlledDecision): void {
  if (!request || request.schemaVersion !== 1 || request.type !== 'sync.decision' || request.inputId !== snapshot.id || JSON.stringify(request.source) !== JSON.stringify(snapshot.source)) throw new Error('裁决请求 schema/input/来源绑定不一致')
  if (![request.requestId, request.operationId].every(value => typeof value === 'string' && value.trim()) || !/^[a-f0-9]{64}$/.test(request.analysisRef?.sha256 ?? '') || !Array.isArray(request.findingIds) || !request.findingIds.length || !request.findingIds.every(id => typeof id === 'string' && id.trim()) || new Set(request.findingIds).size !== request.findingIds.length) throw new Error('裁决请求缺少有效分析或具体分歧身份')
  if (request.originalRequestBlob) readControlledRequest(snapshot, request.originalRequestBlob)
  if (!request.decision || !['keep_intent', 'adopt_behavior', 'new_rule'].includes(request.decision.choice) || request.decision.choice === 'new_rule' && (typeof request.decision.rule !== 'string' || !request.decision.rule.trim())) throw new Error('裁决请求缺少明确选择或新规则')
}
/** 读取固定裁决，并核原输入；分析可信归属由应用和协调器从原操作证据核验。 */
export function readControlledDecision(snapshot: InputSnapshot, ref: BlobRef): ControlledDecision {
  const request = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as ControlledDecision
  checkDecision(snapshot, request)
  return request
}
/** 在旧编辑准备函数读取正文前核已知路径；只观察路径元数据，不跟随任何 symlink。 */
export function guardControlledRequestPath(snapshot: InputSnapshot, path: string): void {
  validateRepositoryPath(path)
  if (!/^\.spec\/.+\/spec\.md$/.test(path)) throw new Error('受控请求仅支持 .spec 节点正文路径')
  if (JSON.stringify(identifyWorktree(snapshot.source.canonicalRoot)) !== JSON.stringify(snapshot.source)) throw new Error('受控请求来源物理身份已变化')
  const segments = path.split('/')
  for (let index = 0; index < segments.length; index++) {
    const stat = lstatSync(join(snapshot.source.canonicalRoot, ...segments.slice(0, index + 1)))
    if (stat.isSymbolicLink()) throw new Error('受控请求路径含 symlink，禁止跟随读取')
    if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('受控请求父路径或文件类型错误')
  }
}

function checkOrigin(origin: ControlledRequestOrigin): void {
  if (!origin || !['user_edit', 'user_decision'].includes(origin.kind) || ![origin.requestId, origin.nodeId, origin.intent].every(value => typeof value === 'string' && value.trim().length > 0)) throw new Error('受控请求缺少用户原意来源或节点身份')
}
function checkBody(before: Buffer, next: Buffer): void {
  if (![before, next].every(isUtf8Text)) throw new Error('受控请求正文必须为 UTF-8 文本')
  const header = (bytes: Buffer): string | undefined => /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(bytes.toString('utf8'))?.[1]
  if (!header(before) || header(before) !== header(next)) throw new Error('受控请求不能修改 Spec frontmatter')
}
const sameEntry = (a: TreeEntry | undefined, b: TreeEntry): boolean => !!a && a.path === b.path && a.mode === b.mode && a.oid === b.oid && a.digest === b.digest

/** 将真实 readonly 准备结果冻结为用户请求；源码正文仍只保存在 Git 对象中。 */
export function prepareControlledRequest(snapshot: InputSnapshot, prepared: Readonly<PreparedSpecBodyEdit>, origin: ControlledRequestOrigin): PreparedControlledRequest {
  guardControlledRequestPath(snapshot, prepared.path)
  checkOrigin(origin)
  const entries = verifySnapshot(snapshot), before = entries.find(entry => entry.path === prepared.path)
  if (!before || before.mode === '120000') throw new Error('受控请求原文件不在冻结来源中或为 symlink')
  const bytes = Buffer.from(prepared.source), nextBytes = Buffer.from(prepared.next), commonDir = snapshot.source.commonDir
  if (contentHash(bytes) !== before.digest || !bytes.equals(readObject(commonDir, before.oid))) throw new Error('受控请求原 bytes/digest 与冻结来源不一致')
  checkBody(bytes, nextBytes)
  if (prepared.changed !== !bytes.equals(nextBytes)) throw new Error('受控请求 changed 与实际字节差量不一致')
  if (!prepared.changed) return { changed: false, requestBlob: null }
  const next: TreeEntry = { ...before, oid: writeObject(commonDir, nextBytes), digest: contentHash(nextBytes) }
  const requestTree = writeTree(commonDir, entries.map(entry => entry.path === before.path ? next : entry))
  const request: ControlledRequest = { schemaVersion: 1, inputId: snapshot.id, source: snapshot.source, path: before.path, before, next, requestTree, origin }
  const requestBlob = writeEvidence(commonDir, request)
  objectGit(commonDir, ['update-ref', `refs/spex-sync/requests/${requestBlob.sha256}`, requestTree])
  return { changed: true, requestBlob }
}

/** 从固定对象读取完整用户请求；历史展示不依赖当前来源路径是否仍存在。 */
export function readControlledRequest(snapshot: InputSnapshot, requestBlob: BlobRef): ControlledRequest {
  const commonDir = snapshot.source.commonDir
  const request = JSON.parse(readEvidence(commonDir, requestBlob).toString('utf8')) as ControlledRequest
  if (request.schemaVersion !== 1 || request.inputId !== snapshot.id || JSON.stringify(request.source) !== JSON.stringify(snapshot.source)) throw new Error('受控请求 schema/input/来源绑定不一致')
  checkOrigin(request.origin)
  const entries = verifySnapshot(snapshot), before = entries.find(entry => entry.path === request.path)
  if (!before || before.mode === '120000' || !request.before || !sameEntry(before, request.before)) throw new Error('受控请求 before 与冻结来源不一致')
  if (!request.next || request.next.path !== before.path || request.next.mode !== before.mode) throw new Error('受控请求 next 路径或 mode 不一致')
  const nextBytes = readObject(commonDir, request.next.oid)
  if (contentHash(nextBytes) !== request.next.digest) throw new Error('受控请求 next digest 不一致')
  const original = readObject(commonDir, before.oid)
  checkBody(original, nextBytes)
  if (original.equals(nextBytes)) throw new Error('受控请求没有字节差量，应使用 no-op')
  if (JSON.stringify(readTree(commonDir, request.requestTree)) !== JSON.stringify(entries.map(entry => entry.path === before.path ? request.next : entry))) throw new Error('受控请求 requestTree 与用户差量不一致')
  return request
}

/** 写入前另核当前来源物理身份和路径；新 input 不能自动重放旧请求。 */
export function validateControlledRequest(snapshot: InputSnapshot, requestBlob: BlobRef): ControlledRequest {
  const request = readControlledRequest(snapshot, requestBlob)
  guardControlledRequestPath(snapshot, request.path)
  return request
}

/** 以真实来源为 base 叠加用户差量，保留已组合细化；冲突返回三方 Git 对象证据。 */
export function composeControlledRequest(snapshot: InputSnapshot, composed: ComposedInputRef, requestBlob: BlobRef): { composed: ComposedInputRef | null; conflicts: CompositionConflict[] } {
  const commonDir = snapshot.source.commonDir
  const saved = JSON.parse(readEvidence(commonDir, requestBlob).toString('utf8')) as { type?: string }
  const decision = saved.type === 'sync.decision' ? readControlledDecision(snapshot, requestBlob) : null
  const request = decision ? null : validateControlledRequest(snapshot, requestBlob)
  if (composed.sourceInputId !== snapshot.id) throw new Error('组合输入与受控请求 input 绑定不一致')
  const entries = readTree(commonDir, composed.tree)
  if (contentHash(JSON.stringify(entries)) !== composed.contentDigest || !readEvidence(commonDir, composed.manifestBlob).equals(Buffer.from(JSON.stringify({ version: 1, entries })))) throw new Error('受控请求组合 manifest/contentDigest 不一致')
  if (composed.requestBlob) {
    if (composed.requestBlob.sha256 !== requestBlob.sha256) throw new Error('组合输入已绑定另一受控请求')
    return { composed, conflicts: [] }
  }
  if (decision) {
    if (!decision.originalRequestBlob) return { composed: { ...composed, requestBlob }, conflicts: [] }
    const result = composeControlledRequest(snapshot, composed, decision.originalRequestBlob)
    return result.composed ? { composed: { ...result.composed, requestBlob }, conflicts: [] } : result
  }
  if (!request) throw new Error('受控请求不合法')
  const delivery = entries.find(entry => entry.path === request.path)
  let next: TreeEntry | undefined
  if (sameEntry(delivery, request.before) || sameEntry(delivery, request.next)) next = request.next
  else if (delivery && delivery.mode !== '120000') {
    const merged = mergeText(commonDir, delivery, request.before, request.next)
    if (merged) next = { ...delivery, oid: writeObject(commonDir, merged), digest: contentHash(merged) }
  }
  if (!next) return { composed: null, conflicts: [{ path: request.path, base: request.before, source: request.next, delivery: delivery ?? null }] }
  const resultEntries = entries.map(entry => entry.path === request.path ? next! : entry), tree = writeTree(commonDir, resultEntries)
  const manifestBlob = writeEvidence(commonDir, { version: 1, entries: resultEntries }), contentDigest = contentHash(JSON.stringify(resultEntries))
  objectGit(commonDir, ['update-ref', `refs/spex-sync/compositions/${tree}`, tree])
  return { composed: { ...composed, tree, manifestBlob, contentDigest, requestBlob }, conflicts: [] }
}
