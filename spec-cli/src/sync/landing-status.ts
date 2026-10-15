import type { ApplyJournal, InputSnapshot, SyncOperation } from './operation-types.js'
import { objectGit, readTree, verifySnapshot } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

export type SyncLandingStatus = { sourceSynced: boolean; canonicalSynced: boolean; actualCommit: string | null; phase: SyncOperation['phase'] }
const same = (left: TreeEntry | undefined, right: TreeEntry | undefined): boolean => left?.oid === right?.oid && left?.mode === right?.mode
const covers = (scope: string, path: string): boolean => scope === path || path.startsWith(`${scope}/`)

/** 从已结算交付与当前 Git/工作文件读取采纳事实；不写持久业务阶段。 */
export function readSyncLandingStatus(operation: SyncOperation, snapshot: InputSnapshot, journals: readonly ApplyJournal[], options: { canonicalBranch: string; readPaths: readonly string[] }): SyncLandingStatus {
  const empty: SyncLandingStatus = { sourceSynced: false, canonicalSynced: false, actualCommit: null, phase: operation.phase }
  if (operation.blockedReason || operation.blockedScope.paths.length || operation.blockedScope.contractIds.length || operation.blockedScope.flowIds.length || !journals.length || journals.some(journal => journal.status !== 'settled' || !journal.receipt)) return empty
  if (operation.input.source.repositoryId !== snapshot.source.repositoryId || operation.input.source.canonicalRoot !== snapshot.source.canonicalRoot || operation.input.source.physicalFingerprint !== snapshot.source.physicalFingerprint) return empty
  if (operation.scope.contractIds.some(id => !operation.deliveredScope.contractIds.includes(id)) || operation.scope.flowIds.some(id => !operation.deliveredScope.flowIds.includes(id)) || operation.scope.paths.some(path => !operation.deliveredScope.paths.some(scope => covers(scope, path)))) return empty
  const receipt = journals[journals.length - 1].receipt!, commit = receipt.actualCommit, commonDir = snapshot.source.commonDir
  if (!commit || receipt.deliverySnapshot.headCommit !== commit || receipt.deliverySnapshot.immutableTree !== receipt.actualTree || receipt.deliverySnapshot.source.repositoryId !== snapshot.source.repositoryId) return empty
  if (objectGit(commonDir, ['rev-parse', `${commit}^{tree}`]).toString().trim() !== receipt.actualTree) throw new Error('SYNC_LANDING_BINDING: receipt commit/tree 不一致')
  try { objectGit(commonDir, ['merge-base', '--is-ancestor', commit, snapshot.headCommit]) }
  catch (error) { if ((error as { status?: number }).status === 1) return empty; throw error }
  const delivered = new Map(verifySnapshot(receipt.deliverySnapshot).map(entry => [entry.path, entry]))
  const working = new Map(verifySnapshot(snapshot).map(entry => [entry.path, entry]))
  const index = new Map(readTree(commonDir, snapshot.indexTree).map(entry => [entry.path, entry]))
  const head = new Map(readTree(commonDir, objectGit(commonDir, ['rev-parse', `${snapshot.headCommit}^{tree}`]).toString().trim()).map(entry => [entry.path, entry]))
  const scopes = [...operation.scope.paths, ...options.readPaths], paths = [...new Set([...delivered.keys(), ...working.keys(), ...index.keys(), ...head.keys()])].filter(path => scopes.some(scope => covers(scope, path)))
  if (paths.some(path => !same(delivered.get(path), working.get(path)) || !same(delivered.get(path), index.get(path)) || !same(delivered.get(path), head.get(path)))) return { ...empty, actualCommit: commit }
  const canonicalSynced = snapshot.source.branch === options.canonicalBranch
  return { sourceSynced: true, canonicalSynced, actualCommit: commit, phase: canonicalSynced ? 'canonical_synced' : operation.phase }
}
