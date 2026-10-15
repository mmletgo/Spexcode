import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { ApplyJournal, ApplyPlan, ApplyReceipt, InputSnapshot, SyncOperation, SyncScope, VerificationResultBlob, WorktreeIdentity } from './operation-types.js'
import type { SyncStore } from './store.js'
import type { DeliveryTools } from './private-delivery.js'
import { actualTreeDiff, verifyCandidate } from './candidate.js'
import { contentHash, identifyWorktree, objectGit, readEvidence, verifySnapshot } from './snapshot.js'
import { prepareTrustedHooksBinding, inspectTrustedHooksBinding, makeTrustedHookEnv, type TrustedHooksBinding } from './trusted-hooks.js'
import { readSyncLandingStatus } from './landing-status.js'
import { SyncApplicationError } from './settings.js'

type ApplyPayload = { version: number; operationId: string; attemptId: string; inputId: string; source: WorktreeIdentity; currentTarget: Omit<InputSnapshot, 'capturedAtMs'>; candidateDigest: string; verificationBlob: { sha256: string }; expectedBaselinePairId: string | null; expectedBaselineSelectionDigest?: string; publicationBaseRef?: { sha256: string }; coveredScope: SyncScope; files: ApplyPlan['files'] }
type CommitIntent = { version: number; journalId: string; effectKey: string; tree: string; parent: string; ref: string; unchanged: boolean; binding: TrustedHooksBinding }
export type SourceAdoptionPlan = { source: WorktreeIdentity; headCommit: string; actualCommit: string; actualTree: string; alreadyAdopted: boolean; binding: TrustedHooksBinding }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
function fail(code: string, message: string): never { throw new SyncApplicationError(code, message) }
const covers = (outer: SyncScope, inner: SyncScope): boolean => inner.paths.every(path => outer.paths.some(parent => path === parent || path.startsWith(`${parent}/`))) && inner.contractIds.every(id => outer.contractIds.includes(id)) && inner.flowIds.every(id => outer.flowIds.includes(id))
const hasScope = (scope: SyncScope): boolean => !!(scope.paths.length || scope.contractIds.length || scope.flowIds.length)
const identity = (source: WorktreeIdentity): string => JSON.stringify(source, Object.keys(source).sort())
const gitText = (commonDir: string, args: string[]): string => objectGit(commonDir, args).toString().trim()
const ancestor = (commonDir: string, before: string, after: string): boolean => {
  try { objectGit(commonDir, ['merge-base', '--is-ancestor', before, after]); return true }
  catch (error) { if ((error as { status?: number }).status === 1) return false; throw error }
}

/** 未完成操作在读取固定 runtime 和完整证据前即可给出同一资格拒因。 */
export function assertSourceAdoptionComplete(operation: SyncOperation): void {
  if (operation.control !== 'run' || !['workspace_synced', 'awaiting_landing', 'canonical_synced'].includes(operation.phase) || operation.blockedReason || hasScope(operation.blockedScope) || !covers(operation.deliveredScope, operation.scope)) fail('sync_adoption_incomplete', '仅完整且无未决范围的已结算交付可采纳')
}

/** 与协调器的来源发布使用同一锁地址；采纳不会与同来源的新交付交错。 */
export function sourceAdoptionMutexPath(artifactRoot: string, source: WorktreeIdentity): string {
  return join(artifactRoot, '.publication-locks', `${contentHash(identity(source))}.sqlite`)
}

/** 读取既有已结算证明，不创建交付计划、验证、receipt 或新提交。 */
function settledReceipt(store: SyncStore, operation: SyncOperation, journal: ApplyJournal): { receipt: ApplyReceipt; intent: CommitIntent } {
  const commonDir = operation.input.source.commonDir, attempt = store.readAttempt(journal.attemptId), candidate = attempt.candidate, verification = attempt.verification, receipt = journal.receipt, plan = journal.plan
  if (journal.operationId !== operation.id || attempt.operationId !== operation.id || journal.generation !== attempt.generation || attempt.status !== 'settled' || journal.status !== 'settled' || !receipt || !candidate || !verification?.passed || !attempt.composedInput || journal.steps.some(step => step.status !== 'completed' || !step.evidenceRef)) fail('sync_adoption_not_settled', '交付缺少完整的已结算尝试、文件步骤或验证')
  const after = verifyCandidate(commonDir, candidate)
  verifySnapshot(receipt.deliverySnapshot)
  const result = JSON.parse(readEvidence(commonDir, verification.resultBlob).toString('utf8')) as VerificationResultBlob
  const bindingKeys = ['inputId', 'candidateDigest', 'policyDigest', 'readSetDigest', 'baselineSelectionDigest', 'environmentDigest', 'contextDigest'] as const
  if (verification.inputId !== operation.input.id || verification.candidateDigest !== candidate.digest || verification.policyDigest !== operation.policyDigest || verification.readSetDigest !== operation.readSetDigest || candidate.sourceInputId !== operation.input.id || candidate.baseTree !== (attempt.publicationBase?.composed ?? attempt.composedInput).tree || verification.baselineSelectionDigest !== operation.baselineSelection?.digest || result.schemaVersion !== 1 || bindingKeys.some(key => result[key] !== verification[key]) || !same(result.coveredScope, verification.coveredScope) || !covers(candidate.coveredScope, verification.coveredScope) || result.layers.length !== 4 || !['V1', 'V2', 'V3', 'V4'].every(layer => result.layers.filter(entry => entry.layer === layer).length === 1) || result.layers.some(layer => layer.verdict !== 'pass' || !layer.evidenceRefs.length)) fail('sync_adoption_verification_invalid', '四层验证及候选、输入、政策或作用域绑定不完整')
  for (const ref of [...verification.evidenceRefs, ...result.layers.flatMap(layer => layer.evidenceRefs), ...receipt.evidenceRefs, ...journal.steps.map(step => step.evidenceRef!)]) readEvidence(commonDir, ref)
  const payload = JSON.parse(readEvidence(commonDir, plan.planBlob).toString('utf8')) as ApplyPayload
  const before = verifySnapshot({ ...payload.currentTarget, capturedAtMs: 0 })
  if (payload.version !== 1 || contentHash(JSON.stringify(payload)) !== plan.payloadDigest || payload.operationId !== operation.id || payload.attemptId !== attempt.id || payload.inputId !== operation.input.id || !same(payload.source, operation.input.source) || payload.currentTarget.id !== plan.expectedTargetSnapshotId || !same(payload.currentTarget.source, plan.target) || !same(plan.target, operation.delivery) || payload.candidateDigest !== candidate.digest || plan.candidateDigest !== candidate.digest || payload.verificationBlob.sha256 !== verification.resultBlob.sha256 || plan.verificationBlob.sha256 !== verification.resultBlob.sha256 || !same(payload.files, plan.files) || !same(actualTreeDiff(before, after), plan.files) || !same(payload.coveredScope, plan.coveredScope) || !covers(verification.coveredScope, plan.coveredScope) || payload.expectedBaselinePairId !== plan.expectedBaselinePairId || plan.expectedBaselinePairId !== (operation.previousBaselinePair?.id ?? null) || payload.expectedBaselineSelectionDigest !== plan.expectedBaselineSelectionDigest || plan.expectedBaselineSelectionDigest !== operation.baselineSelection?.digest || !same(payload.publicationBaseRef, plan.publicationBaseRef) || !same(plan.publicationBaseRef, attempt.publicationBase?.provenanceBlob) || plan.effectKey !== `sync-apply-${operation.id}-${attempt.id}-${plan.payloadDigest}`) fail('sync_adoption_plan_invalid', '已结算交付计划与真实候选差量、输入或验证绑定不一致')
  const parent = attempt.publicationBase?.parentCommit ?? operation.deliveryPlan.baseCommit, snapshot = receipt.deliverySnapshot, commit = receipt.actualCommit
  if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || receipt.id !== `receipt-${journal.id}` || receipt.journalId !== journal.id || receipt.effectKey !== plan.effectKey || receipt.actualTree !== candidate.tree || snapshot.headCommit !== commit || snapshot.immutableTree !== candidate.tree || snapshot.indexTree !== candidate.tree || snapshot.manifestBlob.sha256 !== candidate.manifestBlob.sha256 || !same(snapshot.source, plan.target) || plan.target.canonicalRoot !== operation.deliveryPlan.canonicalRoot || plan.target.branch !== operation.deliveryPlan.branch || plan.target.commonDir !== commonDir || payload.currentTarget.headCommit !== parent || gitText(commonDir, ['rev-parse', `${commit}^{tree}`]) !== candidate.tree) fail('sync_adoption_receipt_invalid', 'receipt 不是该私有交付的实际已验证提交和完整树')
  const evidence = receipt.evidenceRefs.map(ref => JSON.parse(readEvidence(commonDir, ref).toString('utf8')) as Record<string, unknown>)
  const intent = evidence.find(value => value.journalId === journal.id && value.effectKey === plan.effectKey) as CommitIntent | undefined
  const unchanged = gitText(commonDir, ['rev-parse', `${parent}^{tree}`]) === candidate.tree
  if (!intent || intent.version !== 1 || intent.tree !== candidate.tree || intent.parent !== parent || intent.ref !== operation.deliveryPlan.branch || intent.unchanged !== unchanged || intent.binding.root !== plan.target.canonicalRoot || intent.binding.expectedTree !== candidate.tree || intent.binding.expectedParent !== parent || intent.binding.expectedRef !== plan.target.branch || !evidence.some(value => value.version === 1 && value.journalId === journal.id && value.commit === commit && value.parent === parent && value.tree === candidate.tree) || (unchanged ? commit !== parent : gitText(commonDir, ['show', '-s', '--format=%P', commit]) !== parent || !gitText(commonDir, ['show', '-s', '--format=%B', commit]).split('\n').includes(`Spex-Sync-Effect: ${plan.effectKey}`))) fail('sync_adoption_commit_invalid', '实际提交不符合原交付 commit intent、parent 和 effect')
  return { receipt, intent }
}

/** 应用详情与执行共用的采纳判据；所有来源业务文件、index 和 ref 保持只读。 */
export function prepareSourceAdoption(store: SyncStore, operation: SyncOperation, snapshot: InputSnapshot, options: { tools: DeliveryTools; canonicalBranch: string; readPaths: readonly string[] }): SourceAdoptionPlan {
  assertSourceAdoptionComplete(operation)
  if (identity(operation.input.source) !== identity(snapshot.source) || identity(identifyWorktree(snapshot.source.canonicalRoot)) !== identity(snapshot.source)) fail('sync_source_changed', '原输入工作树的物理身份、仓库或分支已变化')
  if (store.readPhysicalControl(operation.input.source).control !== 'run') fail('sync_source_paused', '原输入工作树已暂停写入，请先恢复')
  const headTree = gitText(snapshot.source.commonDir, ['rev-parse', `${snapshot.headCommit}^{tree}`])
  verifySnapshot(snapshot)
  if (snapshot.indexTree !== headTree || snapshot.immutableTree !== headTree) fail('sync_adoption_source_dirty', '原输入工作树有暂存、未暂存或未跟踪修改，请先提交或清理')
  const sameSource = (other: SyncOperation): boolean => identity(other.input.source) === identity(operation.input.source)
  if (store.listRecoverableResources().some(item => sameSource(item.operation)) || store.listRecoverable().some(item => sameSource(item.operation) && item.journals.some(journal => journal.status !== 'settled'))) fail('sync_resources_unsettled', '同一来源仍有未结算资源或交付日志，请先恢复')
  const journals = store.listJournals(operation.id)
  if (!journals.length || journals[journals.length - 1].attemptId !== operation.currentAttemptId) fail('sync_adoption_not_settled', '当前尝试缺少真实已结算交付')
  const deliveries = journals.map(journal => settledReceipt(store, operation, journal)), latest = deliveries[deliveries.length - 1]
  const deliveredScope = journals.reduce<SyncScope>((scope, journal) => ({ paths: [...scope.paths, ...journal.plan.coveredScope.paths], contractIds: [...scope.contractIds, ...journal.plan.coveredScope.contractIds], flowIds: [...scope.flowIds, ...journal.plan.coveredScope.flowIds] }), { paths: [], contractIds: [], flowIds: [] })
  if (!covers(deliveredScope, operation.scope)) fail('sync_adoption_incomplete', '实际已结算交付未覆盖完整操作范围')
  const commit = latest.receipt.actualCommit!, alreadyAdopted = readSyncLandingStatus(operation, snapshot, journals, options).sourceSynced
  if (!alreadyAdopted && !ancestor(snapshot.source.commonDir, snapshot.headCommit, commit)) fail('sync_adoption_not_fast_forward', '原输入工作树与交付已分叉或有后续相关提交，无法快进采纳')
  const footprint = latest.intent.binding.footprintPolicy.privateDirectory
  if (footprint.path !== join(dirname(operation.deliveryPlan.canonicalRoot), 'footprint')) fail('sync_adoption_hooks_unavailable', '交付缺少原可信 footprint 目录')
  const inspected = prepareTrustedHooksBinding(snapshot.source.canonicalRoot, { ...options.tools, privateFootprintDir: footprint.path, operation: 'publish', expectedTree: latest.receipt.actualTree, expectedParent: snapshot.headCommit, expectedRef: snapshot.source.branch })
  if (inspected.status !== 'supported') fail('sync_adoption_hooks_unavailable', '原工作树的 canonical hooks、可信工具或执行配置无法证明，请检查现有 hooks 和固定 runtime')
  if (!same(inspected.binding.footprintPolicy.privateDirectory, footprint)) fail('sync_adoption_hooks_unavailable', '交付 footprint 物理身份已改变')
  const toolKeys = ['nodePath', 'nodeDigest', 'gitPath', 'gitDigest', 'toolEntry', 'toolDigest', 'trustedRuntimeRoot', 'runtimeDigest', 'canonicalHooksDir', 'hooksDir', 'hookDigests'] as const
  if (toolKeys.some(key => !same(inspected.binding[key], latest.intent.binding[key])) || inspected.binding.footprintPolicy.configurationDigest !== latest.intent.binding.footprintPolicy.configurationDigest) fail('sync_adoption_hooks_changed', '交付时固定的工具、hooks 或执行配置已经变化')
  return { source: snapshot.source, headCommit: snapshot.headCommit, actualCommit: commit, actualTree: latest.receipt.actualTree, alreadyAdopted, binding: inspected.binding }
}

/** 持有来源锁并重检后执行普通 fast-forward；不启用私有发布模式或绕过 Git hooks。 */
export function fastForwardSource(plan: SourceAdoptionPlan): void {
  if (plan.alreadyAdopted) return
  if (inspectTrustedHooksBinding(plan.source.canonicalRoot, plan.binding).status !== 'supported') fail('sync_adoption_hooks_changed', '采纳前 hooks、可信工具或执行配置发生变化')
  const env = makeTrustedHookEnv(plan.binding)
  for (const key of Object.keys(env)) if (key.startsWith('SPEXCODE_SYNC_')) delete env[key]
  env.PATH = `${dirname(plan.binding.nodePath)}:${env.PATH}`
  const args = ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', plan.source.canonicalRoot]
  const branch = spawnSync(plan.binding.gitPath, [...args, 'symbolic-ref', '--quiet', 'HEAD'], { env, encoding: 'utf8' })
  const head = spawnSync(plan.binding.gitPath, [...args, 'rev-parse', '--verify', 'HEAD'], { env, encoding: 'utf8' })
  if (branch.error || head.error || branch.status !== 0 || head.status !== 0 || branch.stdout.trim() !== plan.source.branch || head.stdout.trim() !== plan.headCommit) fail('sync_source_changed', '采纳前当前分支或 HEAD 已变化，请重新读取资格')
  const result = spawnSync(plan.binding.gitPath, [...args, 'merge', '--ff-only', '--no-edit', '--no-autostash', plan.actualCommit], { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const actualHead = gitText(plan.source.commonDir, ['rev-parse', plan.source.branch])
  if (result.error || result.status !== 0) fail('sync_adoption_git_failed', `Git 快进未完整成功（退出 ${result.status ?? result.signal ?? '启动失败'}）；${actualHead === plan.headCommit ? '当前 HEAD 未前进，仍须检查工作文件和 index' : `当前 HEAD 已变为 ${actualHead}，请重新读取实际采纳状态`}`)
  if (actualHead !== plan.actualCommit) fail('sync_adoption_result_changed', `采纳后实际 HEAD 为 ${actualHead}，与 receipt 提交不一致，请读取当前状态`)
  if (identity(identifyWorktree(plan.source.canonicalRoot)) !== identity(plan.source)) fail('sync_adoption_result_changed', 'Git 快进后原工作树身份或分支已经变化，请读取当前状态')
}
