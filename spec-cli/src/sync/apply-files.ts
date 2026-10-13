import { randomUUID } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve, sep } from 'node:path'
import type { ApplyFilePlan, ApplyPlan, BlobRef, InputSnapshot, SyncAttempt, SyncOperation, WorktreeIdentity, WriteFence } from './operation-types.js'
import type { SyncStore } from './store.js'
import { actualTreeDiff, verifyCandidate } from './candidate.js'
import { captureInputSnapshot, contentHash, identifyWorktree, readEvidence, readObject, readTree, safeSymlinkTarget, validateRepositoryPath, verifySnapshot, writeEvidence } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

type PlanPayload = { version: 1; operationId: string; attemptId: string; inputId: string; source: WorktreeIdentity; currentTarget: Omit<InputSnapshot, 'capturedAtMs'>; candidateDigest: string; verificationBlob: BlobRef; expectedBaselinePairId: string | null; coveredScope: ApplyPlan['coveredScope']; files: ApplyFilePlan[] }
export class ApplyFilesError extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'ApplyFilesError' } }
function fail(code: string, message: string): never { throw new ApplyFilesError(code, message) }
const sameIdentity = (a: WorktreeIdentity, b: WorktreeIdentity): boolean => (['repositoryId', 'commonDir', 'canonicalRoot', 'gitDir', 'branch', 'physicalFingerprint'] as const).every(key => a[key] === b[key])
const pathCovered = (path: string, paths: string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))

/** 完整 target→candidate 差量绑定已验证来源；禁止凭落盘差量扩张验证范围。 */
export function prepareApplyPlan(operation: SyncOperation, attempt: SyncAttempt, currentTarget: InputSnapshot): ApplyPlan {
  if (!operation.delivery || !sameIdentity(operation.delivery, currentTarget.source) || operation.delivery.canonicalRoot === operation.input.source.canonicalRoot) fail('SYNC_PRIVATE_DELIVERY_REQUIRED', '必须是不同于外部来源的受控私有交付工作树')
  if (attempt.operationId !== operation.id || attempt.generation !== operation.generation || operation.currentAttemptId !== attempt.id || attempt.status !== 'verified' || !attempt.candidate || !attempt.verification?.passed) fail('SYNC_APPLY_NOT_VERIFIED', '当前尝试尚未完成验证')
  const candidate = attempt.candidate, verification = attempt.verification, commonDir = currentTarget.source.commonDir
  if (candidate.sourceInputId !== operation.input.id || verification.inputId !== operation.input.id || verification.candidateDigest !== candidate.digest || verification.policyDigest !== operation.policyDigest || verification.readSetDigest !== operation.readSetDigest || commonDir !== operation.input.source.commonDir) fail('SYNC_APPLY_BINDING', '验证、候选和原始来源绑定不一致')
  readEvidence(commonDir, verification.resultBlob)
  const files = actualTreeDiff(verifySnapshot(currentTarget), verifyCandidate(commonDir, candidate))
  if (files.some(file => !pathCovered(file.path, verification.coveredScope.paths))) fail('SYNC_APPLY_SCOPE', '完整交付差量超出实际验证范围')
  validateSourceLinks(attempt, files, commonDir, currentTarget.source.canonicalRoot)
  const { capturedAtMs: _captureTime, ...targetFacts } = currentTarget
  const payload: PlanPayload = { version: 1, operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, source: operation.input.source, currentTarget: targetFacts, candidateDigest: candidate.digest, verificationBlob: verification.resultBlob, expectedBaselinePairId: operation.previousBaselinePair?.id ?? null, coveredScope: verification.coveredScope, files }
  const payloadDigest = contentHash(JSON.stringify(payload)), effectKey = `sync-apply-${operation.id}-${attempt.id}-${payloadDigest}`
  return { effectKey, payloadDigest, candidateDigest: candidate.digest, verificationBlob: verification.resultBlob, target: currentTarget.source, expectedTargetSnapshotId: currentTarget.id, expectedBaselinePairId: payload.expectedBaselinePairId, coveredScope: verification.coveredScope, files, planBlob: writeEvidence(commonDir, payload) }
}
function validateSourceLinks(attempt: SyncAttempt, files: ApplyFilePlan[], commonDir: string, root: string): Map<string, string> {
  const links = files.filter(file => file.postMode === '120000'), resolved = new Map<string, string>()
  if (!links.length) return resolved
  if (!attempt.composedInput || !attempt.candidate) fail('SYNC_APPLY_LINK_SOURCE', '链接缺失组合输入来源')
  const source = new Map(readTree(commonDir, attempt.composedInput.tree).map(entry => [entry.path, entry]))
  const candidate = new Map(verifyCandidate(commonDir, attempt.candidate).map(entry => [entry.path, entry]))
  const modelDiff = JSON.parse(readEvidence(commonDir, attempt.candidate.actualDiffBlob).toString()) as ApplyFilePlan[]
  for (const link of links) {
    const entry = candidate.get(link.path)!, original = source.get(link.path)
    if (!original || original.mode !== entry.mode || original.oid !== entry.oid || original.digest !== entry.digest || modelDiff.some(change => change.path === link.path)) fail('SYNC_APPLY_LINK_SOURCE', link.path)
    let path = link.path
    const visited = new Set<string>()
    for (;;) {
      const parts = path.split('/')
      const linkedParent = parts.map((_part, index) => parts.slice(0, index + 1).join('/')).find(parent => candidate.get(parent)?.mode === '120000')
      if (!linkedParent) {
        if (!candidate.has(path) && ![...candidate.keys()].some(file => file.startsWith(`${path}/`))) fail('SYNC_APPLY_LINK_TARGET', link.path)
        resolved.set(link.path, path); break
      }
      if (visited.has(linkedParent)) fail('SYNC_APPLY_LINK_TARGET', `循环链接: ${link.path}`)
      visited.add(linkedParent)
      const bytes = readObject(commonDir, candidate.get(linkedParent)!.oid), target = bytes.toString()
      if (!Buffer.from(target).equals(bytes) || target.includes('\\') || target.includes('\0')) fail('SYNC_APPLY_LINK_TARGET', link.path)
      safeSymlinkTarget(root, linkedParent, target)
      path = posix.normalize(posix.join(posix.dirname(linkedParent), target, ...parts.slice(linkedParent.split('/').length)))
      validateRepositoryPath(path)
    }
  }
  return resolved
}
export type ApplyStagingIdentity = { rootDirectory: string; directory: string; physicalFingerprint: string; journalId: string; attemptId: string }
export type ApplyFilesOptions = {
  stagingDirectory: string
  /** 调用者必须用实际所有权记录/执行隔离保证独占，回调不得仅检查短暂无事件。 */
  assertExclusivePrivateDelivery: (target: WorktreeIdentity, staging: ApplyStagingIdentity) => void | Promise<void>
  afterStagingFileOpen?: (path: string, fd: number) => void
  afterFileWrite?: (path: string) => void | Promise<void>
  afterStepRecord?: (path: string) => void | Promise<void>
}
type ApplyStore = Pick<SyncStore, 'readJournal' | 'readOperation' | 'readAttempt' | 'recordApplyStep' | 'recordFailure'>
type DiskEntry = { kind: 'missing' | 'directory' | 'file' | 'symlink'; digest: string | null; mode: string | null }
function diskEntry(root: string, path: string, planned: ApplyFilePlan[], candidate: TreeEntry[]): DiskEntry {
  const pieces = path.split('/')
  for (let count = 1; count < pieces.length; count++) {
    const parent = pieces.slice(0, count).join('/')
    let stat
    try { stat = lstatSync(join(root, parent)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', digest: null, mode: null }; throw error }
    if (stat.isSymbolicLink()) {
      const ancestor = planned.find(file => file.path === parent), digest = contentHash(readlinkSync(join(root, parent), { encoding: 'buffer' }))
      const deletablePreimage = ancestor?.preMode === '120000' && ancestor.postDigest === null && ancestor.preDigest === digest
      const appliedPostimage = ancestor?.postMode === '120000' && ancestor.postDigest === digest && !candidate.some(entry => entry.path === path || entry.path.startsWith(`${path}/`))
      if (deletablePreimage || appliedPostimage) return { kind: 'missing', digest: null, mode: null }
      fail('SYNC_APPLY_PARENT_SYMLINK', parent)
    }
    if (!stat.isDirectory()) {
      if (planned.some(file => file.path === parent)) return { kind: 'missing', digest: null, mode: null }
      fail('SYNC_APPLY_PARENT_CONFLICT', parent)
    }
  }
  let stat
  try { stat = lstatSync(join(root, path)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', digest: null, mode: null }; throw error }
  if (stat.isDirectory()) return { kind: 'directory', digest: null, mode: null }
  if (!stat.isFile() && !stat.isSymbolicLink()) fail('SYNC_APPLY_FILE_UNSUPPORTED', path)
  const bytes = stat.isSymbolicLink() ? readlinkSync(join(root, path), { encoding: 'buffer' }) : readFileSync(join(root, path))
  return { kind: stat.isSymbolicLink() ? 'symlink' : 'file', digest: contentHash(bytes), mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644' }
}
function matches(state: DiskEntry, digest: string | null, mode: string | null, path: string, tree: TreeEntry[]): boolean {
  return state.digest === digest && state.mode === mode && (state.kind !== 'directory' || tree.some(entry => entry.path.startsWith(`${path}/`)))
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function ensureParents(root: string, path: string): void {
  const pieces = path.split('/')
  for (let count = 1; count < pieces.length; count++) {
    const absolute = join(root, ...pieces.slice(0, count))
    try { const stat = lstatSync(absolute); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SYNC_APPLY_PARENT_CONFLICT', pieces.slice(0, count).join('/')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; mkdirSync(absolute); syncDirectory(dirname(absolute)) }
  }
}
function directoryFiles(root: string, path: string): string[] {
  return readdirSync(join(root, path)).flatMap(name => { const child = `${path}/${name}`, stat = lstatSync(join(root, child)); return stat.isDirectory() && !stat.isSymbolicLink() ? directoryFiles(root, child) : [child] })
}
function removeEmptyDirectories(path: string): void {
  for (const name of readdirSync(path)) { const child = join(path, name), stat = lstatSync(child); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SYNC_APPLY_DIRECTORY_CONFLICT', path); removeEmptyDirectories(child) }
  rmdirSync(path); syncDirectory(dirname(path))
}
function stagingIdentity(directory: string, rootDirectory: string, journalId: string, attemptId: string): ApplyStagingIdentity {
  const stat = lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || directory !== resolve(directory) || realpathSync(directory) !== directory) fail('SYNC_APPLY_STAGING_INVALID', directory)
  return { rootDirectory, directory, physicalFingerprint: contentHash(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`), journalId, attemptId }
}
function replaceFile(root: string, file: ApplyFilePlan, entry: TreeEntry, commonDir: string, staging: string, options: ApplyFilesOptions): void {
  const absolute = join(root, file.path), temporary = join(staging, `${randomUUID()}.tmp`)
  ensureParents(root, file.path)
  try { if (lstatSync(absolute).isDirectory()) removeEmptyDirectories(absolute) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const bytes = readObject(commonDir, entry.oid)
  if (entry.mode === '120000') symlinkSync(bytes.toString(), temporary)
  else {
    const fd = openSync(temporary, 'wx', 0o600)
    try { options.afterStagingFileOpen?.(temporary, fd); writeFileSync(fd, bytes); fchmodSync(fd, file.postMode === '100755' ? 0o755 : 0o644); fsyncSync(fd) } finally { closeSync(fd) }
  }
  syncDirectory(staging)
  renameSync(temporary, absolute); syncDirectory(dirname(absolute)); syncDirectory(staging)
}

/** 仅完成已登记 journal 的私有逐文件单元；恢复保留第三方值，不自行提交、公开或结算 receipt。 */
export async function applyJournalFiles(store: ApplyStore, fence: WriteFence, journalId: string, options: ApplyFilesOptions): Promise<{ snapshot: InputSnapshot; evidenceRefs: BlobRef[]; replayedPaths: string[] }> {
  const journal = store.readJournal(journalId), operation = store.readOperation(journal.operationId), attempt = store.readAttempt(journal.attemptId), plan = journal.plan, commonDir = plan.target.commonDir
  const evidenceRefs: BlobRef[] = [], replayedPaths: string[] = []
  try {
    if (fence.operationId !== operation.id || fence.attemptId !== attempt.id || operation.currentAttemptId !== attempt.id || operation.generation !== fence.generation || fence.leaseToken !== attempt.leaseToken || fence.sourceFingerprint !== operation.input.source.physicalFingerprint || journal.generation !== fence.generation || attempt.status !== 'applying' || !attempt.candidate || !attempt.verification?.passed || journal.receipt || journal.status === 'settled') fail('SYNC_APPLY_JOURNAL_BINDING', journalId)
    if (!operation.delivery || !sameIdentity(operation.delivery, plan.target) || plan.target.canonicalRoot === operation.input.source.canonicalRoot) fail('SYNC_PRIVATE_DELIVERY_REQUIRED', '只允许协调器独占且尚未公开的私有交付树')
    const payload = JSON.parse(readEvidence(commonDir, plan.planBlob).toString()) as PlanPayload
    if (payload.version !== 1 || contentHash(JSON.stringify(payload)) !== plan.payloadDigest || payload.operationId !== operation.id || payload.attemptId !== attempt.id || payload.inputId !== operation.input.id || payload.currentTarget.id !== plan.expectedTargetSnapshotId || payload.candidateDigest !== attempt.candidate.digest || plan.candidateDigest !== attempt.candidate.digest || payload.verificationBlob.sha256 !== attempt.verification.resultBlob.sha256 || plan.verificationBlob.sha256 !== attempt.verification.resultBlob.sha256 || payload.expectedBaselinePairId !== plan.expectedBaselinePairId || JSON.stringify(payload.files) !== JSON.stringify(plan.files) || JSON.stringify(payload.coveredScope) !== JSON.stringify(plan.coveredScope)) fail('SYNC_APPLY_PLAN_BINDING', journalId)
    const before = verifySnapshot({ ...payload.currentTarget, capturedAtMs: 0 }), after = verifyCandidate(commonDir, attempt.candidate)
    if (JSON.stringify(actualTreeDiff(before, after)) !== JSON.stringify(plan.files)) fail('SYNC_APPLY_PLAN_DIFF', journalId)
    if (plan.files.some(file => !pathCovered(validateRepositoryPath(file.path), attempt.verification!.coveredScope.paths))) fail('SYNC_APPLY_SCOPE', '差量超出实际验证范围')
    const linkTargets = validateSourceLinks(attempt, plan.files, commonDir, plan.target.canonicalRoot)
    const root = plan.target.canonicalRoot, postEntries = new Map(after.map(entry => [entry.path, entry]))
    const stagingRoot = stagingIdentity(options.stagingDirectory, options.stagingDirectory, journalId, attempt.id)
    if ([operation.input.source.canonicalRoot, root].some(path => stagingRoot.directory === path || stagingRoot.directory.startsWith(`${path}${sep}`)) || lstatSync(stagingRoot.directory, { bigint: true }).dev !== lstatSync(root, { bigint: true }).dev) fail('SYNC_APPLY_STAGING_INVALID', '暂存必须位于来源和交付树之外且与交付树同filesystem')
    const assertAuthority = async (staging: ApplyStagingIdentity): Promise<void> => {
      await options.assertExclusivePrivateDelivery(plan.target, staging)
      if (!sameIdentity(identifyWorktree(root), plan.target)) fail('SYNC_APPLY_TARGET_REBUILT', root)
      if (lstatSync(staging.directory, { bigint: true }).dev !== lstatSync(root, { bigint: true }).dev) fail('SYNC_APPLY_STAGING_INVALID', '当前暂存与目标不在同filesystem')
      if (stagingIdentity(stagingRoot.directory, stagingRoot.directory, journalId, attempt.id).physicalFingerprint !== stagingRoot.physicalFingerprint || stagingIdentity(staging.directory, stagingRoot.directory, journalId, attempt.id).physicalFingerprint !== staging.physicalFingerprint) fail('SYNC_APPLY_STAGING_REBUILT', staging.directory)
    }
    await assertAuthority(stagingRoot)
    // 每次重入创建新 namespace；从不采用已有目录/链接或重用中断残片。
    const scratch = mkdtempSync(join(stagingRoot.directory, `journal-${contentHash(`${journalId}:${attempt.id}`).slice(0, 24)}-`))
    syncDirectory(stagingRoot.directory)
    const staging = stagingIdentity(scratch, stagingRoot.directory, journalId, attempt.id)
    await assertAuthority(staging)
    // 先检查所有 pre/post，不写第一份文件后才发现后面的第三方值。
    for (const file of plan.files) {
      const state = diskEntry(root, file.path, plan.files, after), completed = journal.steps.find(step => step.key === file.path)?.status === 'completed'
      if (!matches(state, file.postDigest, file.postMode, file.path, after) && (completed || !matches(state, file.preDigest, file.preMode, file.path, before))) fail('SYNC_APPLY_THIRD_PARTY', file.path)
      if (state.kind === 'directory' && file.postDigest !== null && directoryFiles(root, file.path).some(path => !plan.files.some(change => change.path === path && change.postDigest === null))) fail('SYNC_APPLY_DIRECTORY_CONFLICT', file.path)
    }
    const ordered = [...plan.files].sort((a, b) => Number(a.postDigest !== null) - Number(b.postDigest !== null) || Number(a.postMode === '120000') - Number(b.postMode === '120000') || (a.postDigest === null ? b.path.split('/').length - a.path.split('/').length : a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path))
    for (const file of ordered) {
      await assertAuthority(staging)
      const currentJournal = store.readJournal(journalId), step = currentJournal.steps.find(step => step.key === file.path)!
      // 写前由既有 finishing fence 检查 generation/租约；取消只停止后续阶段。
      store.recordApplyStep(fence, journalId, step)
      const state = diskEntry(root, file.path, plan.files, after)
      if (matches(state, file.postDigest, file.postMode, file.path, after)) replayedPaths.push(file.path)
      else {
        if (step.status === 'completed' || !matches(state, file.preDigest, file.preMode, file.path, before)) fail('SYNC_APPLY_THIRD_PARTY', file.path)
        if (file.postDigest === null) { unlinkSync(join(root, file.path)); syncDirectory(dirname(join(root, file.path))) }
        else replaceFile(root, file, postEntries.get(file.path)!, commonDir, staging.directory, options)
        await options.afterFileWrite?.(file.path)
      }
      await assertAuthority(staging)
      if (!matches(diskEntry(root, file.path, plan.files, after), file.postDigest, file.postMode, file.path, after)) fail('SYNC_APPLY_WRITE_MISMATCH', file.path)
      if (step.status !== 'completed') {
        const evidenceRef = writeEvidence(commonDir, { version: 1, journalId, path: file.path, digest: file.postDigest, mode: file.postMode })
        evidenceRefs.push(evidenceRef); store.recordApplyStep(fence, journalId, { key: file.path, status: 'completed', evidenceRef })
        await options.afterStepRecord?.(file.path)
      } else if (step.evidenceRef) evidenceRefs.push(step.evidenceRef)
    }
    await assertAuthority(staging)
    for (const [path, resolved] of linkTargets) if (realpathSync(join(root, path)) !== join(root, resolved)) fail('SYNC_APPLY_LINK_TARGET', path)
    const snapshot = await captureInputSnapshot(root)
    if (snapshot.immutableTree !== attempt.candidate.tree || snapshot.indexDigest !== payload.currentTarget.indexDigest || snapshot.headCommit !== payload.currentTarget.headCommit) fail('SYNC_APPLY_TARGET_MISMATCH', '完整交付树、index或HEAD不匹配冻结计划')
    evidenceRefs.push(writeEvidence(commonDir, { version: 1, journalId, actualTree: snapshot.immutableTree, manifestBlob: snapshot.manifestBlob, indexDigest: snapshot.indexDigest }))
    return { snapshot, evidenceRefs, replayedPaths }
  } catch (error) {
    const evidence = writeEvidence(commonDir, { version: 1, journalId, code: error instanceof ApplyFilesError ? error.code : 'SYNC_APPLY_IO_FAILURE', message: error instanceof Error ? error.message : String(error) })
    try { store.recordFailure(fence, { code: error instanceof ApplyFilesError ? error.code : 'SYNC_APPLY_IO_FAILURE', message: error instanceof Error ? error.message : String(error), kind: error instanceof ApplyFilesError ? 'conflict' : 'environment', evidenceRefs: [evidence] }) }
    catch (recordError) { throw new AggregateError([error, recordError], '应用失败且恢复记录无法结算') }
    throw error
  }
}
