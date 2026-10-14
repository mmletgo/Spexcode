import { actualTreeDiff, isHostPrivatePath, verifyCandidate } from './candidate.js'
import type { ApplyJournal, SyncAttempt, SyncOperation } from './operation-types.js'
import { readControlledRequest } from './request-input.js'
import { objectGit, readTree, validateRepositoryPath } from './snapshot.js'

export class SyncDiffReadError extends Error {
  constructor(readonly status: 400 | 404 | 413, readonly code: string, message: string) { super(message) }
}
export type SyncDiffDetail = { operation: Pick<SyncOperation, 'input' | 'deliveryPlan' | 'requestBlob'>; attempt: Pick<SyncAttempt, 'candidate'> | null; journals: ApplyJournal[] }
export type SyncFileDiff = { path: string; kind: 'delivery' | 'candidate' | 'request'; baseTree: string; candidateTree: string; patch: string; delivered: boolean }

/** 按固定操作对象读取完整文件差量，候选与实际落地证据保持分离。 */
export function readSyncFileDiff(detail: SyncDiffDetail, path: string, kind = 'delivery'): SyncFileDiff {
  if (kind !== 'delivery' && kind !== 'candidate' && kind !== 'request') throw new SyncDiffReadError(400, 'SYNC_DIFF_KIND', '差异类型必须为 delivery、candidate 或 request')
  try { validateRepositoryPath(path) } catch { throw new SyncDiffReadError(400, 'SYNC_DIFF_PATH', '差异路径必须为合法仓库相对路径') }
  if (isHostPrivatePath(path)) throw new SyncDiffReadError(404, 'SYNC_DIFF_NOT_FOUND', '此操作没有可读取的文件差异')
  const commonDir = detail.operation.input.source.commonDir
  let baseTree: string, candidateTree: string, delivered = false
  if (kind === 'request') {
    if (!detail.operation.requestBlob) throw new SyncDiffReadError(404, 'SYNC_DIFF_NOT_READY', '此操作没有受控用户请求')
    const request = readControlledRequest(detail.operation.input, detail.operation.requestBlob)
    if (request.path !== path) throw new SyncDiffReadError(404, 'SYNC_DIFF_NOT_FOUND', '文件不在此用户请求差量中')
    baseTree = detail.operation.input.immutableTree; candidateTree = request.requestTree
  } else {
    const candidate = detail.attempt?.candidate
    if (!candidate) throw new SyncDiffReadError(404, 'SYNC_DIFF_NOT_READY', '此操作尚无已冻结候选')
    const entries = verifyCandidate(commonDir, candidate)
    baseTree = kind === 'candidate' ? candidate.baseTree : objectGit(commonDir, ['rev-parse', `${detail.operation.deliveryPlan.baseCommit}^{tree}`]).toString().trim()
    if (!actualTreeDiff(readTree(commonDir, baseTree), entries).some(file => file.path === path)) throw new SyncDiffReadError(404, 'SYNC_DIFF_NOT_FOUND', '文件不在此操作的实际差量中')
    candidateTree = candidate.tree
    delivered = detail.journals.some(journal => journal.status === 'settled' && journal.plan.candidateDigest === candidate.digest && journal.receipt?.actualTree === candidate.tree)
  }
  const bytes = objectGit(commonDir, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--full-index', baseTree, candidateTree, '--', `:(literal)${path}`])
  if (bytes.length > 2 * 1024 * 1024) throw new SyncDiffReadError(413, 'SYNC_DIFF_TOO_LARGE', '完整文件差异超过 2 MiB，请在交付工作树审阅')
  return { path, kind, baseTree, candidateTree, patch: bytes.toString('utf8'), delivered }
}
