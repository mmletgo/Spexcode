import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { ApplyJournal, ApplyReceipt, BlobRef, DeliveryPlan, InputSnapshot, SyncOperation, WriteFence } from './operation-types.js'
import type { SyncStore } from './store.js'
import { applyJournalFiles, prepareApplyPlan } from './apply-files.js'
import { claimFileMutex } from './file-mutex.js'
import { captureInputSnapshot, contentHash, identifyWorktree, objectGit, readEvidence, writeEvidence } from './snapshot.js'
import { inspectTrustedHooksBinding, makeTrustedHookEnv, prepareTrustedHooksBinding } from './trusted-hooks.js'
import type { TrustedHooksBinding, TrustedHooksOptions } from './trusted-hooks.js'

export type DeliveryTools = Pick<TrustedHooksOptions, 'trustedRuntimeRoot' | 'toolEntry' | 'canonicalHooksDir' | 'nodePath' | 'gitPath'>
export type PrivateDeliveryOptions = {
  managedRoot: string; tools: DeliveryTools
  beforeApply: () => void | Promise<void>
  afterFileWrite?: (path: string) => void | Promise<void>
  afterCommit?: () => void | Promise<void>
  afterReceipt?: () => void | Promise<void>
}
type Owner = { version: 2; operationId: string; attemptId: string; inputId: string; plan: DeliveryPlan; parentIdentity: string; stagingIdentity: string; footprintIdentity: string; journalId: string | null; commitIntent: BlobRef | null; published: boolean }
type CommitIntent = { version: 1; journalId: string; effectKey: string; tree: string; parent: string; ref: string; message: string; unchanged: boolean; binding: TrustedHooksBinding }
export class PrivateDeliveryError extends Error { constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'PrivateDeliveryError' } }
function fail(code: string, message: string): never { throw new PrivateDeliveryError(code, message) }
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const within = (parent: string, child: string): boolean => child === parent || child.startsWith(`${parent}${sep}`)
function physical(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('SYNC_DELIVERY_DIRECTORY', '受管目录必须是 canonical 普通目录')
  return contentHash(`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`)
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function writeOwner(path: string, owner: Owner): void {
  const bytes = JSON.stringify(owner), temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path); syncDirectory(dirname(path))
}
function managedDirectory(root: string, input: InputSnapshot): string {
  if (resolve(root) !== root) fail('SYNC_DELIVERY_DIRECTORY', '受管根必须是绝对 canonical 路径')
  physical(root)
  if (within(input.source.canonicalRoot, root) || within(root, input.source.canonicalRoot)) fail('SYNC_DELIVERY_DIRECTORY', '受管根必须位于来源树之外')
  const stat = lstatSync(root)
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('SYNC_DELIVERY_DIRECTORY', '受管根必须由当前用户独占且权限为0700')
  return root
}

/** 接入前确定路径；真正创建由持有当前 attempt 的唯一交付者执行。 */
export function planPrivateDelivery(input: InputSnapshot, managedRoot: string, ingressKey: string): DeliveryPlan {
  managedDirectory(managedRoot, input)
  if (!ingressKey) fail('SYNC_DELIVERY_PLAN', '缺少稳定接入键')
  const key = contentHash(`${input.source.repositoryId}:${input.source.branch}:${ingressKey}`)
  return { canonicalRoot: join(managedRoot, key, 'worktree'), branch: `refs/heads/codex/sync-${key}`, baseCommit: input.headCommit }
}

/** 只把已证明的候选发布为受管完整工作树；真实 Git 结果是提交成功的判断依据。 */
export async function deliverVerifiedAttempt(store: SyncStore, fence: WriteFence, options: PrivateDeliveryOptions): Promise<{ operation: SyncOperation; receipt: ApplyReceipt }> {
  let operation = store.readOperation(fence.operationId)
  const attempt = store.readAttempt(fence.attemptId), candidate = attempt.candidate
  if (operation.currentAttemptId !== attempt.id || operation.generation !== fence.generation || attempt.leaseToken !== fence.leaseToken || operation.input.source.physicalFingerprint !== fence.sourceFingerprint || !candidate || !attempt.verification?.passed || !['verified', 'applying', 'settled'].includes(attempt.status)) fail('SYNC_DELIVERY_NOT_VERIFIED', '当前尝试无完整验证或已经失权')
  if (attempt.status === 'verified' && (operation.deadlineAtMs <= Date.now() || attempt.expiresAtMs <= Date.now())) fail('SYNC_DELIVERY_EXPIRED', '过期尝试不能开始新的交付准备')
  const managedRoot = managedDirectory(options.managedRoot, operation.input), root = operation.deliveryPlan.canonicalRoot, parent = dirname(root), staging = join(parent, 'staging'), footprint = join(parent, 'footprint'), ownerPath = join(parent, 'owner.json'), commonDir = operation.input.source.commonDir
  if (dirname(parent) !== managedRoot || root !== join(parent, 'worktree') || !operation.deliveryPlan.branch.startsWith('refs/heads/codex/sync-')) fail('SYNC_DELIVERY_PLAN', '交付计划不属于私有受管根')
  const locks = join(managedRoot, '.locks')
  mkdirSync(locks, { recursive: true, mode: 0o700 }); physical(locks)
  const lock = claimFileMutex(join(locks, `${contentHash(root)}.sqlite`))
  if (!lock) fail('SYNC_DELIVERY_BUSY', '另一进程正在结算该私有交付')
  let owner: Owner | undefined, journal: ApplyJournal | undefined
  const assertOwner = (): void => {
    lock.assertHeld()
    if (!owner || physical(parent) !== owner.parentIdentity || physical(staging) !== owner.stagingIdentity || physical(footprint) !== owner.footprintIdentity || !equal(JSON.parse(readFileSync(ownerPath, 'utf8')), owner)) fail('SYNC_DELIVERY_OWNERSHIP', '私有目录或所有权记录已改变')
    if (operation.delivery && !equal(identifyWorktree(root), operation.delivery)) fail('SYNC_DELIVERY_OWNERSHIP', '交付工作树物理身份已改变')
  }
  const git = (binding: TrustedHooksBinding, cwd: string, args: string[]): string => execFileSync(binding.gitPath, ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env: makeTrustedHookEnv(binding), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const trusted = (cwd: string, mode: 'prepare' | 'publish', tree: string): TrustedHooksBinding => {
    const config = { ...options.tools, operation: mode, expectedTree: tree, expectedParent: operation.deliveryPlan.baseCommit, expectedRef: operation.deliveryPlan.branch, privateFootprintDir: footprint }
    const result = prepareTrustedHooksBinding(cwd, config)
    if (result.status !== 'supported') fail('SYNC_DELIVERY_UNSUPPORTED', JSON.stringify(result.issues))
    return result.binding
  }
  try {
    if (existsSync(ownerPath)) {
      owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as Owner
      if (owner.version !== 2 || owner.operationId !== operation.id || owner.inputId !== operation.input.id || !equal(owner.plan, operation.deliveryPlan)) fail('SYNC_DELIVERY_OWNERSHIP', '交付路径已属于其他输入/计划')
      assertOwner()
      if (owner.attemptId !== attempt.id) {
        const previous = store.readAttempt(owner.attemptId)
        if (attempt.status !== 'verified' || operation.control !== 'run' || previous.operationId !== operation.id || !['failed', 'superseded'].includes(previous.status) || owner.journalId || owner.commitIntent || owner.published) fail('SYNC_DELIVERY_OWNERSHIP', '旧交付不能转移给新尝试')
        let observed: InputSnapshot | null = null
        if (existsSync(root)) {
          observed = await captureInputSnapshot(root)
          const baseTree = objectGit(commonDir, ['rev-parse', `${operation.deliveryPlan.baseCommit}^{tree}`]).toString().trim()
          if (observed.source.commonDir !== commonDir || observed.source.branch !== operation.deliveryPlan.branch || observed.headCommit !== operation.deliveryPlan.baseCommit || observed.immutableTree !== baseTree || observed.indexTree !== baseTree) fail('SYNC_DELIVERY_OWNERSHIP', '旧准备树已有非base内容，不能转移所有权')
        }
        const transfer = writeEvidence(commonDir, { version: 1, kind: 'private-delivery-transfer', previousOwner: owner, attemptId: attempt.id, observed })
        store.checkpoint(fence, transfer); assertOwner()
        owner = { ...owner, attemptId: attempt.id }; writeOwner(ownerPath, owner)
      }
    } else {
      if (operation.control !== 'run' || attempt.status !== 'verified') fail('SYNC_DELIVERY_STOPPED', '暂停或取消后不能新建交付')
      if (existsSync(parent)) fail('SYNC_DELIVERY_UNOWNED', '交付父目录已经存在但无所有权记录，不能采用；保留现场等待恢复或新的交付计划')
      const intent = writeEvidence(commonDir, { version: 1, kind: 'private-delivery-create', operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, plan: operation.deliveryPlan })
      store.checkpoint(fence, intent); lock.assertHeld()
      mkdirSync(parent, { mode: 0o700 }); syncDirectory(managedRoot)
      mkdirSync(staging, { mode: 0o700 }); mkdirSync(footprint, { mode: 0o700 })
      owner = { version: 2, operationId: operation.id, attemptId: attempt.id, inputId: operation.input.id, plan: operation.deliveryPlan, parentIdentity: physical(parent), stagingIdentity: physical(staging), footprintIdentity: physical(footprint), journalId: null, commitIntent: null, published: false }
      writeOwner(ownerPath, owner)
    }
    if (owner.journalId) journal = store.readJournal(owner.journalId)
    else journal = store.listRecoverable().find(item => item.operation.id === operation.id)?.journals.find(item => item.attemptId === attempt.id)
    if (owner.published && !journal?.receipt) fail('SYNC_DELIVERY_OWNERSHIP', '已公开目录缺失真实receipt')
    if (!operation.delivery) {
      if (operation.control !== 'run') fail('SYNC_DELIVERY_STOPPED', '暂停或取消后不开始新的Git准备')
      const baseTree = objectGit(commonDir, ['rev-parse', `${operation.deliveryPlan.baseCommit}^{tree}`]).toString().trim()
      const binding = trusted(operation.input.source.canonicalRoot, 'prepare', baseTree)
      if (!existsSync(join(root, '.git'))) {
        assertOwner()
        const ref = spawnSync(binding.gitPath, ['--no-replace-objects', '-C', operation.input.source.canonicalRoot, 'show-ref', '--verify', '--quiet', operation.deliveryPlan.branch], { env: makeTrustedHookEnv(binding) })
        if (ref.error) throw ref.error
        if (ref.status !== 0 && ref.status !== 1) fail('SYNC_DELIVERY_PREPARE_CONFLICT', '无法读取预定分支')
        const branchExists = ref.status === 0
        if (branchExists && git(binding, operation.input.source.canonicalRoot, ['rev-parse', '--verify', operation.deliveryPlan.branch]) !== operation.deliveryPlan.baseCommit) fail('SYNC_DELIVERY_PREPARE_CONFLICT', '预定分支已有其他提交')
        const args = branchExists ? ['worktree', 'add', root, operation.deliveryPlan.branch.slice(11)] : ['worktree', 'add', '-b', operation.deliveryPlan.branch.slice(11), root, operation.deliveryPlan.baseCommit]
        const created = spawnSync(binding.gitPath, ['--no-replace-objects', '-C', operation.input.source.canonicalRoot, ...args], { env: makeTrustedHookEnv(binding), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
        store.checkpoint(fence, writeEvidence(commonDir, { version: 1, kind: 'private-delivery-prepare', operationId: operation.id, attemptId: attempt.id, status: created.status, signal: created.signal, stdout: created.stdout, stderr: created.stderr, error: created.error?.message }))
        if (created.error) throw created.error
        if (created.status !== 0) fail('SYNC_DELIVERY_PREPARE_FAILED', 'Git准备未完整成功；实际ref/目录已保留，恢复须核对')
      }
      const identity = identifyWorktree(root)
      if (identity.commonDir !== commonDir || identity.branch !== operation.deliveryPlan.branch || git(binding, root, ['rev-parse', 'HEAD']) !== operation.deliveryPlan.baseCommit) fail('SYNC_DELIVERY_PREPARE_CONFLICT', '准备后的实际Git身份或base不匹配')
      operation = store.bindDelivery(fence, identity)
    }
    assertOwner()
    if (journal?.receipt) {
      const actual = await captureInputSnapshot(root)
      if (actual.id !== journal.receipt.deliverySnapshot.id) fail('SYNC_DELIVERY_PUBLISHED_CHANGED', '已交付版本已变化，必须登记为新输入')
      const settled = store.settleApply(journal.id, journal.receipt.id)
      owner = { ...owner, journalId: journal.id, published: true }; writeOwner(ownerPath, owner)
      return { operation: settled, receipt: journal.receipt }
    }
    if (!journal) {
      await options.beforeApply(); assertOwner()
      const current = await captureInputSnapshot(root)
      journal = store.beginApply(fence, prepareApplyPlan(store.readOperation(operation.id), store.readAttempt(attempt.id), current), current)
    }
    owner = { ...owner, journalId: journal.id }; writeOwner(ownerPath, owner)
    if (journal.steps.some(step => step.status !== 'completed')) {
      await applyJournalFiles(store, fence, journal.id, { stagingDirectory: staging, afterFileWrite: options.afterFileWrite, assertExclusivePrivateDelivery: (target, scratch) => {
        assertOwner()
        if (owner!.published || !equal(target, operation.delivery) || scratch.rootDirectory !== staging || scratch.journalId !== journal!.id || scratch.attemptId !== attempt.id || !within(staging, scratch.directory)) fail('SYNC_DELIVERY_OWNERSHIP', '文件单元不属于私有交付授权')
      } })
    }
    assertOwner()
    let intent: CommitIntent
    if (owner.commitIntent) intent = JSON.parse(readEvidence(commonDir, owner.commitIntent).toString()) as CommitIntent
    else {
      const binding = trusted(root, 'publish', candidate.tree)
      intent = { version: 1, journalId: journal.id, effectKey: journal.plan.effectKey, tree: candidate.tree, parent: operation.deliveryPlan.baseCommit, ref: operation.deliveryPlan.branch, message: `Synchronize verified Spec and implementation\n\nSpex-Sync-Effect: ${journal.plan.effectKey}\n`, unchanged: git(binding, root, ['rev-parse', `${operation.deliveryPlan.baseCommit}^{tree}`]) === candidate.tree, binding }
      const ref = writeEvidence(commonDir, intent); store.checkpoint(fence, ref)
      owner = { ...owner, commitIntent: ref }; writeOwner(ownerPath, owner)
    }
    if (intent.version !== 1 || intent.journalId !== journal.id || intent.effectKey !== journal.plan.effectKey || intent.tree !== candidate.tree || intent.parent !== operation.deliveryPlan.baseCommit || intent.ref !== operation.deliveryPlan.branch) fail('SYNC_DELIVERY_COMMIT_BINDING', '提交intent不属于已验证journal')
    const head = git(intent.binding, root, ['rev-parse', 'HEAD'])
    const parentTree = git(intent.binding, root, ['rev-parse', `${intent.parent}^{tree}`])
    if (intent.unchanged !== (parentTree === intent.tree)) fail('SYNC_DELIVERY_COMMIT_BINDING', 'no-op提交身份不匹配')
    if (head === intent.parent && !intent.unchanged) {
      if (inspectTrustedHooksBinding(root, intent.binding).status !== 'supported') fail('SYNC_DELIVERY_TOOL_CHANGED', '已登记工具/hooks身份改变')
      const actual = await captureInputSnapshot(root)
      if (actual.immutableTree !== candidate.tree || ![parentTree, intent.tree].includes(actual.indexTree)) fail('SYNC_DELIVERY_BEFORE_COMMIT', '实际文件或index不属于提交前后状态')
      store.checkpoint(fence, owner.commitIntent!)
      assertOwner(); git(intent.binding, root, ['read-tree', intent.tree])
      const committed = spawnSync(intent.binding.gitPath, ['--no-replace-objects', '-C', root, 'commit', '-F', '-'], { input: intent.message, env: makeTrustedHookEnv(intent.binding), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      const outcome = writeEvidence(commonDir, { version: 1, kind: 'private-delivery-commit', journalId: journal.id, status: committed.status, signal: committed.signal, stdout: committed.stdout, stderr: committed.stderr, error: committed.error?.message })
      store.checkpoint(fence, outcome)
      await options.afterCommit?.()
    }
    assertOwner()
    const commit = git(intent.binding, root, ['rev-parse', 'HEAD']), fact = git(intent.binding, root, ['show', '-s', '--format=%T%n%P%n%B', commit]).split('\n')
    if (fact[0] !== intent.tree || (intent.unchanged ? commit !== intent.parent : commit === intent.parent || fact[1] !== intent.parent || !fact.slice(2).includes(`Spex-Sync-Effect: ${intent.effectKey}`)) || git(intent.binding, root, ['symbolic-ref', 'HEAD']) !== intent.ref) fail('SYNC_DELIVERY_COMMIT_UNSETTLED', '实际Git结果尚未匹配冻结提交intent')
    const snapshot = await captureInputSnapshot(root)
    if (snapshot.immutableTree !== candidate.tree || snapshot.indexTree !== candidate.tree || snapshot.manifestBlob.sha256 !== candidate.manifestBlob.sha256) fail('SYNC_DELIVERY_AFTER_COMMIT', '提交后实际文件/index与验证候选不一致')
    const receipt: ApplyReceipt = { id: `receipt-${journal.id}`, journalId: journal.id, effectKey: journal.plan.effectKey, actualTree: candidate.tree, actualCommit: commit, deliverySnapshot: snapshot, evidenceRefs: [owner.commitIntent!, writeEvidence(commonDir, { version: 1, journalId: journal.id, commit, parent: intent.parent, tree: candidate.tree })], completedAtMs: Date.now() }
    store.recordReceipt(journal.id, receipt); await options.afterReceipt?.()
    const settled = store.settleApply(journal.id, receipt.id)
    owner = { ...owner, published: true }; writeOwner(ownerPath, owner)
    return { operation: settled, receipt }
  } catch (error) {
    const current = store.readAttempt(attempt.id)
    if (!['settled', 'failed', 'superseded'].includes(current.status) && (current.status === 'applying' || current.expiresAtMs > Date.now())) {
      const evidence = writeEvidence(commonDir, { version: 1, kind: 'private-delivery-failure', operationId: operation.id, attemptId: attempt.id, journalId: journal?.id ?? null, message: error instanceof Error ? error.message : String(error) })
      store.recordFailure(fence, { code: error instanceof PrivateDeliveryError ? error.code : 'SYNC_DELIVERY_IO', kind: error instanceof PrivateDeliveryError && error.code.includes('UNSUPPORTED') ? 'unsupported' : 'environment', message: error instanceof Error ? error.message : String(error), evidenceRefs: [evidence] })
    }
    throw error
  } finally { lock.release() }
}
