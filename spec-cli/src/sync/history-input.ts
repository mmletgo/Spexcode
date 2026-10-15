import type { BlobRef, InputSnapshot, WorktreeIdentity } from './operation-types.js'
import { objectGit, readEvidence, readTree, verifySnapshot, writeEvidence, writeTree } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

export type HistoryChange = { path: string; before: TreeEntry | null; next: TreeEntry | null }
export type HistoryRequest = {
  schemaVersion: 1; type: 'sync.history'; action: 'revert'; inputId: string; source: WorktreeIdentity
  requestId: string; nodeId: string; operationId: string; receiptId: string
  featureCommit: string; parentCommit: string; requestTree: string
  changes: HistoryChange[]; conflicts: string[]; mergeOutput: string
}
export type HistoryRequestInput = Pick<HistoryRequest, 'requestId' | 'nodeId' | 'operationId' | 'receiptId' | 'featureCommit'>
const canonical = (value: unknown): string => JSON.stringify(value)
const same = (left: TreeEntry | undefined, right: TreeEntry | undefined): boolean => left?.oid === right?.oid && left?.mode === right?.mode

/** Git 的反向三方只产生对象；原工作树、index 和共享分支均不写入。 */
function reverseTree(snapshot: InputSnapshot, featureCommit: string, parentCommit: string): { tree: string; conflicts: string[]; output: string } {
  try {
    const drivers = objectGit(snapshot.source.commonDir, ['config', '--name-only', '--get-regexp', '^merge[.].*[.]driver$']).toString().trim()
    if (drivers) throw new Error('SYNC_HISTORY_MERGE_DRIVER_UNSUPPORTED: 补偿只使用 Git 内置三方，不能执行外部 merge driver')
  } catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  let output: Buffer, conflicted = false
  try { output = objectGit(snapshot.source.commonDir, ['-c', 'merge.renormalize=false', '-c', 'merge.default=text', 'merge-tree', '--write-tree', '-z', '--name-only', `--merge-base=${featureCommit}`, snapshot.immutableTree, parentCommit]) }
  catch (error) {
    const failure = error as { status?: number; stdout?: Buffer }
    if (failure.status !== 1 || !Buffer.isBuffer(failure.stdout)) throw error
    output = failure.stdout; conflicted = true
  }
  const fields = output.toString('utf8').split('\0'), tree = fields.shift()!
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new Error('SYNC_HISTORY_MERGE_INVALID: Git 未返回固定树')
  const boundary = fields.indexOf(''), conflicts = conflicted ? fields.slice(0, boundary < 0 ? fields.length : boundary) : []
  return { tree, conflicts: [...new Set(conflicts)].sort(), output: output.toString('base64') }
}

/** 以已采纳 feature 的真实 parent 为反向目标，保留后续非重叠编辑。 */
function buildHistoryRequest(snapshot: InputSnapshot, input: HistoryRequestInput): HistoryRequest {
  const commonDir = snapshot.source.commonDir, before = verifySnapshot(snapshot)
  if (![input.requestId, input.nodeId, input.operationId, input.receiptId].every(value => typeof value === 'string' && value.trim())) throw new Error('SYNC_HISTORY_INPUT_INVALID: 缺少请求或交付身份')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.featureCommit)) throw new Error('SYNC_HISTORY_INPUT_INVALID: feature 必须是固定 commit')
  objectGit(commonDir, ['merge-base', '--is-ancestor', input.featureCommit, snapshot.headCommit])
  const parents = objectGit(commonDir, ['show', '-s', '--format=%P', input.featureCommit]).toString().trim().split(' ').filter(Boolean)
  if (parents.length !== 1) throw new Error('SYNC_HISTORY_PARENT_UNSUPPORTED: 仅支持有唯一 parent 的真实交付提交')
  const parentCommit = parents[0], result = reverseTree(snapshot, input.featureCommit, parentCommit)
  const oldFiles = new Map(before.map(entry => [entry.path, entry])), newFiles = new Map(readTree(commonDir, result.tree).map(entry => [entry.path, entry]))
  if (result.conflicts.length) {
    const parentFiles = new Map(readTree(commonDir, objectGit(commonDir, ['rev-parse', `${parentCommit}^{tree}`]).toString().trim()).map(entry => [entry.path, entry]))
    for (const path of result.conflicts) { const entry = parentFiles.get(path); if (entry) newFiles.set(path, entry); else newFiles.delete(path) }
  }
  const requestTree = result.conflicts.length ? writeTree(commonDir, [...newFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) : result.tree
  const changes: HistoryChange[] = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().filter(path => !same(oldFiles.get(path), newFiles.get(path))).map(path => ({ path, before: oldFiles.get(path) ?? null, next: newFiles.get(path) ?? null }))
  return { schemaVersion: 1, type: 'sync.history', action: 'revert', inputId: snapshot.id, source: snapshot.source, requestId: input.requestId, nodeId: input.nodeId, operationId: input.operationId, receiptId: input.receiptId, featureCommit: input.featureCommit, parentCommit, requestTree, changes, conflicts: result.conflicts, mergeOutput: result.output }
}

/** 将完整补偿输入固定为 evidence 并保活其 Git 对象。 */
export function prepareHistoryRequest(snapshot: InputSnapshot, input: HistoryRequestInput): BlobRef {
  const commonDir = snapshot.source.commonDir, request = buildHistoryRequest(snapshot, input)
  const ref = writeEvidence(commonDir, request)
  objectGit(commonDir, ['update-ref', `refs/spex-sync/requests/${ref.sha256}`, request.requestTree])
  return ref
}

/** 重新运行同一 Git 三方并逐项核验，固定请求不信任调用者填写的变化清单。 */
export function readHistoryRequest(snapshot: InputSnapshot, ref: BlobRef): HistoryRequest {
  const request = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as HistoryRequest
  if (request.schemaVersion !== 1 || request.type !== 'sync.history' || request.action !== 'revert' || request.inputId !== snapshot.id || canonical(request.source) !== canonical(snapshot.source)) throw new Error('SYNC_HISTORY_BINDING: 请求不属于当前冻结输入')
  const expected = buildHistoryRequest(snapshot, request)
  if (canonical(request) !== canonical(expected)) throw new Error('SYNC_HISTORY_BINDING: 请求与真实反向三方不同')
  return request
}
