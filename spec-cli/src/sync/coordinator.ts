import { ELABORATION_BOUNDARIES, ELABORATION_GENERATION_GUIDANCE, ELABORATION_GENERATION_GUIDANCE_V1, ELABORATION_GENERATION_GUIDANCE_V2, ELABORATION_GENERATION_GUIDANCE_V3, ELABORATION_GENERATION_GUIDANCE_V4, partitionedElaborationCoverageMatches, type AnalysisOnlyPartitionEvidence, type ElaborationGenerationGuidance } from './elaboration-types.js'
import { finiteSyncBudget, syncDeadlineExpired } from './budget.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertWorktreeSyncModel, syncModel, syncModelBinding } from './model-selection.js'
import { setImmediate as yieldToControl, setTimeout as waitForPublication } from 'node:timers/promises'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dependencyClosure, parseContract, parseParts } from '@spexcode/spec-core/contracts'
import { parseCodeEntry, relationClaimsPath } from '@spexcode/spec-core'
import type { Contract, ContractFinding } from '@spexcode/spec-core/contracts'
import { candidateReviewError, candidateReviewLocationError } from './candidate-review.js'
import { actualTreeDiff, exportCandidate, isHostPrivatePath, verifyCandidate } from './candidate.js'
import type { CodeBehaviorCheckpoints, CodeBehaviorContinuation, CodeBehaviorMaterialRequest, CodeBehaviorPostGateReview } from './code-behavior.js'
import type { CrossFreezeSource } from './cross-freeze-source.js'
import { lockCrossFreezeSource } from './cross-freeze-binding.js'
import { frozenSyncCanonicalBranch } from './settings.js'
import { CROSS_FREEZE_IMPACT_PURPOSE, CrossFreezeImpactVerdictError, prepareCrossFreezeImpactReview, restoreCrossFreezeImpactReview, verifyCrossFreezeImpactReview, type CrossFreezeImpactEvidence, type CrossFreezeImpactReview } from './cross-freeze-impact-review.js'
import { analyzeCodeBehavior, authoredContractChanges, CODE_BEHAVIOR_DRAFT_COMMIT_MISSING, CODE_BEHAVIOR_FAILURE_STATUS, CODE_BEHAVIOR_GUIDANCE_VERSION, CODE_BEHAVIOR_REVIEW_COVERAGE_MISSING, LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION, codeBehaviorReviewSchema, codeBehaviorContinuationStatus, codeBehaviorDraftStatus, deriveBehaviorAuthorization, isCodeBehaviorContextTransport, readCodeBehaviorContext, type CodeBehaviorContextTransport, type CodeBehaviorCrossFreezeAuthor, type CodeBehaviorReviewReference } from './code-behavior.js'
import type { CodeBehaviorAnalysis, CodeBehaviorCrossFreezeAuthorProof, CodeBehaviorEvidence, SyncDecisionInput } from './writeback-types.js'
import { adoptedDeliveryPaths, baselineResourceKey, baselineSelectionDigest, extendsWithUninitializedResources, isUtf8Text, readCompositionEvidence, selectedRetiredIds, verifyBaselineSelection } from './composition.js'
import { readHistoryRequest, readReceiptHistoryRestorations } from './history-input.js'
import { p0ReviewDiagnosticMatches, p0ReviewDiagnosticRef, readP0ReviewDiagnostic, type P0ReviewChallengeRequest } from './behavior-review-challenge.js'
import { p1ReviewDiagnosticMarker, p1ReviewDiagnosticRef, readP1ReviewDiagnostic, type P1ReviewChallengeRequest } from './elaboration-review-challenge.js'
import { composeAuthoredInput } from './author-input.js'
import { elaborate, hasApprovedElaborationReview, elaborationGapRepairFindings, elaborationMaterialContext, freezeElaborationInput, gapBlockedFinding, incrementalDraftCommand, isParentInterfaceImplementationReviewRejection, matchesProviderDraftSeed, verifyElaborationDraftCache } from './elaboration.js'
import { outputErrors } from './elaboration-schema.js'
import type { ElaborationGapReviewCheckpoint, ElaborationGapReviewEvidence, ElaborationCrossFreezeAuthor, ElaborationInput, ElaborationResult, ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult, ElaborationTrace, ElaborationRepairSeed, ElaborationRepairDiagnostics, ElaborationDraft, ElaborationDraftMaterial, ReadonlySpecRepair } from './elaboration-types.js'
import { claimFileMutex } from './file-mutex.js'
import { authenticateNativeFailure, authenticateNativeRejectedFinal, authenticateUnstartedElaborationReview, checkpointStageSelection, composedBeforeNullExpansionMatches, findReviewHandoffParent, managedQuotaDispatch, managedQuotaFailureRef, readSyncCheckpoints, readSyncCheckpointStageIndex, retryOperationLineage, settledApprovalSource, syncCheckpointArtifacts, withCheckpointStageBasis } from './checkpoint-evidence.js'
import type { SyncCheckpointStageView } from './checkpoint-evidence.js'
import type { FileMutex } from './file-mutex.js'
import { checkGenerationContractIntent, isSyncSpecPath, readFrozenContracts } from './frozen-contracts.js'
import { historicalCoverageCheck } from './historical-coverage.js'
import { findWholeFileSourcePaths, isReadonlyCitationFailure } from './frozen-anchors.js'
import { decisionAuthorizationErrors, sameContractBusinessMeaning } from './contract-evolution.js'
import type { FrozenContracts, GenerationContractPolicy } from './frozen-contracts.js'
import { implementationGenerationDispatch, completeSyncPartitionPlan, analyzeSyncPartitions, elaborateSyncPartitions, generateSyncPartitions, inspectPartitionedElaborationGaps, partitionSealRepairOwners, analysisOnlyPartitionEvidence, P0ApprovalEvidenceError, IMPLEMENTATION_PLAN_SCHEMA } from './partition-execution.js'
import type { FileWriterPlan, PartitionCheckpoints, PartitionAnalysisFailure, PartitionAnalysisFailures, P0ApprovalCheck } from './partition-execution.js'
import { planSyncPartitions } from './partitioning.js'
import type { SyncPartitionPlan } from './partitioning.js'
import { contractOmissionBound, freezeGenerationInput, generationReviewRequest, generationStageTree, restoreGenerationInput, reviewError, verifyGenerationReviewDraft, runGeneration } from './generation.js'
import type { GenerationReadCache } from './generation.js'
import type { GenerationFinding, GenerationInput, GenerationResult, StoppedCandidateReviewDraft } from './generation-types.js'
import { captureStageDraft, overlayStageTree, readStageDraft, readStoppedPhysicalDraft, StageDraftCommitMissingError, stageWorktree, StoppedPhysicalDraftSidecarsError, StoppedPhysicalDraftStatusError, verifyStageResult, type StageDraftMaterialRequest, type StageWorktree } from './stage-worktree.js'
import { createAttemptRunner, hasSettledGrokP0ExitFailure, hasSettledNativeRpcFailure, hasSettledNativeTurnTransportFailure, matchesNativeDispatchModel, pinSyncNativeRequest } from './native-run.js'
import type { NativeRunCheckpoint, NativeRunPlan, NativeRunRecord } from './native-run.js'
import type { AdmitSyncInput, ApplyReceipt, BlobRef, CandidateRef, ComposedInputRef, FrozenBaselineSelection, InputSnapshot, P0ReviewChallenge, P1ReviewChallenge, SyncAttempt, SyncFailure, SyncOperation, SyncScope, SyncResourceRecord, VerificationResultBlob, WriteFence } from './operation-types.js'
import { deliverVerifiedAttempt, planPrivateDelivery } from './private-delivery.js'
import { assemblePublicationBase, verifyPublicationBase } from './publication-base.js'
import { obligationPaths, ownedObligationPaths } from './prior-context.js'
import { composeControlledRequest, readControlledChanges, readControlledDecision } from './request-input.js'
import { sessionIdForCreateKey, withArchivedStructuredWorktree } from '../sessions.js'
import { withoutSessionApplicationExecutionWake } from '../session-application.js'
import { assertFrozenBinding, readFrozenManifest, readFrozenRange } from '../frozen-context.js'
import { verifyStructuredFrozenReadProof } from '../structured-frozen-evidence.js'
import { assertClaudeStoppedDraftSource, isClaudeFailedAnalysisDraftSource, observeClaudeStoppedWorktreeFailure } from '../claude-structured.js'
import { assertGrokUnpublishedExitSource, GROK_NATIVE_EXIT_DEADLINE_FAILURE, isGrokNativeExitFailure } from '../grok-structured.js'
import { assertZCodeSettledProviderFailure, assertZCodeStoppedDraftSource, isZCodeEventsRpcTimeout, isZCodeProviderRejection, type ZCodeStructuredExecution } from '../zcode-structured.js'
import { NATIVE_PERIODIC_OBSERVATION_FAILURE, NATIVE_PROCESS_OBSERVATION_PENDING, nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { readRecord } from '../session-record.js'
import { structuredExecutionPolicy, StructuredSessionError } from '../session-structured-policy.js'
import { SettledSessionCreateTimeoutError } from '../session-structured.js'
import { canonicalSnapshotSource, captureInputSnapshot, contentHash, identifyRawWorktree, objectGit, readEvidence, readObject, readObjectBatch, readTree, validateRepositoryPath, verifySnapshot, visitObjectBatch, withReadonlySnapshotQuery, writeEvidence, writeEvidenceBytes } from './snapshot.js'
import type { SnapshotManifest, TreeEntry } from './snapshot.js'
import { SyncStoreError } from './store.js'
import type { SyncStore } from './store.js'
import { dockerVerificationDriver, parseVerificationReport, verificationExportDigest } from './verification-executor.js'
import type { VerificationRequest, VerificationResult } from './verification-executor-types.js'
import { planAcceptanceRuns } from './verification-plan.js'
import type { AcceptanceRun } from './verification-plan.js'
import { runAttemptVerification } from './verification-run.js'
import type { SyncAdmissionOptions, SyncCoordinatorOptions, SyncCoordinatorPlan, SyncCoordinatorResult } from './coordinator-types.js'

export class SyncCoordinatorError extends Error {
  constructor(readonly code: string, message: string, readonly evidenceRefs: BlobRef[] = []) { super(`${code}: ${message}`); this.name = 'SyncCoordinatorError' }
}
function fail(code: string, message: string, refs: BlobRef[] = []): never { throw new SyncCoordinatorError(code, message, refs) }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
export const syncPlanDigest = (plan: SyncCoordinatorPlan): string => contentHash(canonical(plan))
export const freezeSyncPlanEvidence = (commonDir: string, plan: SyncCoordinatorPlan): BlobRef => writeEvidence(commonDir, JSON.parse(canonical(plan)))
const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
const overlap = (a: string, b: string): boolean => within(a, [b]) || within(b, [a])
const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort()
const behaviorAnalysisRepairCodes = new Set(['behavior_analysis_invalid', 'behavior_author_evidence_invalid', 'behavior_review_failed', 'behavior_output_json', 'behavior_output_schema', 'cross_freeze_impact_review_retry', CODE_BEHAVIOR_REVIEW_COVERAGE_MISSING])
const structuredAnalysisRepairCodes = new Set(['structured_output_retries_exhausted', 'structured_output_format_invalid', 'native_worktree_result_invalid'])
const reviewFormatRepairCodes = new Set(['structured_output_retries_exhausted', 'structured_output_format_invalid'])
const completedReviewRepairCodes = new Set(['review_location_format'])
const analysisRepairDiagnosticCodes = new Set([...behaviorAnalysisRepairCodes, ...structuredAnalysisRepairCodes])
const nativeObservationFailures = new Set<string>([NATIVE_PROCESS_OBSERVATION_PENDING, ...Object.values(NATIVE_PERIODIC_OBSERVATION_FAILURE)])
const isNativeObservationFailure = (failure: Pick<SyncFailure, 'code' | 'message'> | null): boolean =>
  failure?.code === 'failed' && nativeObservationFailures.has(failure.message)
function requireSettledRpcSources(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, sources: readonly { status: string; failure: { code: string; message: string; sessionId?: string; threadId?: string; turnId?: string; requestKey?: string; inputDigest?: string } | null }[], evidenceRefs: BlobRef[]): void {
  if (!sources.some(source => source.failure?.code === 'native_rpc_timeout')) return
  const blocked = sources.find(source => source.failure?.code === 'cancellation_pending') ?? sources.find(source => ['unsupported', 'cancelled', 'conflict', 'needs_input'].includes(source.status))
  if (blocked) fail(blocked.failure?.code ?? 'unsupported', blocked.failure?.message ?? '并发分区仍有不可自动续修的结果', evidenceRefs)
  if (sources.some(source => source.failure?.code === 'native_rpc_timeout' && !hasSettledNativeRpcFailure(store, operation, attempt, source.failure))) fail('cancellation_pending', '原生RPC故障尚无本尝试的精确停止及资源结算证明', evidenceRefs)
}
const fenceFor = (operation: SyncOperation, attempt: SyncAttempt): WriteFence => ({ operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint })
type InputView = { composed: ComposedInputRef; manifest: SnapshotManifest; files: Map<string, string>; readPaths: readonly string[]; readSetDigest: string; frozen: FrozenContracts }

/** 退役与目标历史只读取各文件真实交付头，不把另一资源的整树作为作者基线。 */
function priorDeliveryFiles(operation: SyncOperation, view: InputView, readPaths: readonly string[], plan: SyncCoordinatorPlan): Map<string, string> {
  if (!operation.baselineSelection && !(plan.version === 'sync-coordinator-v2' && plan.commitTrigger?.before && !operation.previousBaselinePair)) return operation.previousBaselinePair
    ? new Map(readTree(operation.input.source.commonDir, operation.previousBaselinePair.verifiedDelivery.immutableTree).filter(entry => within(entry.path, readPaths) && entry.mode !== '120000').flatMap(entry => { const bytes = readObject(operation.input.source.commonDir, entry.oid); return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : [] }))
    : new Map(view.files)
  const files = new Map(view.files)
  for (const binding of operation.baselineSelection?.bindings ?? []) {
    if (!('bytePair' in binding) || !binding.bytePair || !binding.resource.path.startsWith('.spec/') || !binding.resource.path.endsWith('/spec.md')) continue
    const path = binding.resource.path, entry = readTree(operation.input.source.commonDir, binding.bytePair.verifiedDelivery.immutableTree).find(entry => entry.path === path)
    if (!entry) files.delete(path)
    else if (entry.mode !== '120000') files.set(path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8'))
  }
  if (plan.version === 'sync-coordinator-v2' && plan.commitTrigger?.before) {
    verifySnapshot(plan.commitTrigger.before)
    for (const entry of readTree(operation.input.source.commonDir, plan.commitTrigger.before.immutableTree)) if (!files.has(entry.path) && within(entry.path, readPaths) && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md') && entry.mode !== '120000' && !operation.baselineSelection?.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === entry.path && 'bytePair' in binding && binding.bytePair)) files.set(entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8'))
  }
  return files
}

/** 精确操作只因自身读取/写入闭包变化过期，原有冻结操作保留完整快照判据。 */
export async function isSyncInputCurrent(operation: SyncOperation, current: InputSnapshot, plan: SyncCoordinatorPlan, businessSelection = operation.baselineSelection): Promise<boolean> {
  if (canonical(operation.input.source) !== canonical(current.source)) return false
  if (!operation.baselineSelection) return operation.input.id === current.id
  const treeCache = new Map<string, ReturnType<typeof readTree>>()
  const view = await readInput(operation.input, plan, operation.previousBaselinePair, operation.requestBlob ?? undefined, businessSelection, operation.scope.paths, treeCache)
  const originalEntries = verifySnapshot(operation.input, treeCache), currentEntries = verifySnapshot(current)
  const rememberTree = (input: InputSnapshot, entries: ReturnType<typeof readTree>): void => { treeCache.set(`${input.source.commonDir}\0${input.immutableTree}`, entries) }
  const treeEntries = (input: InputSnapshot, tree: string): ReturnType<typeof readTree> => {
    return readTree(input.source.commonDir, tree, undefined, treeCache)
  }
  const headTree = (input: InputSnapshot): string => objectGit(input.source.commonDir, ['rev-parse', `${input.headCommit}^{tree}`]).toString().trim()
  rememberTree(operation.input, originalEntries); rememberTree(current, currentEntries)
  const inventory = [operation.input, current].flatMap(input => [input.immutableTree, input.indexTree, headTree(input)].flatMap(tree => treeEntries(input, tree).map(entry => entry.path)))
  const paths = unique([...view.readPaths, ...operation.scope.paths, ...ownedObligationPaths(plan.targets, operation.scope.paths, view.files, unique(inventory))])
  const readEntries = (input: InputSnapshot, tree: string): string => canonical(treeEntries(input, tree).filter(entry => within(entry.path, paths)))
  return readEntries(operation.input, operation.input.immutableTree) === readEntries(current, current.immutableTree)
    && readEntries(operation.input, operation.input.indexTree) === readEntries(current, current.indexTree)
    && readEntries(operation.input, headTree(operation.input)) === readEntries(current, headTree(current))
}

function frozenInputTexts(commonDir: string, entries: readonly TreeEntry[]): Map<string, string> {
  const texts = new Map<string, string>(), files = new Map<string, string>()
  visitObjectBatch(commonDir, entries.map(entry => entry.oid), (oid, bytes) => {
    if (isUtf8Text(bytes)) texts.set(oid, bytes.toString('utf8'))
  })
  for (const entry of entries) {
    const text = texts.get(entry.oid)
    if (entry.mode !== '120000' && text !== undefined) files.set(entry.path, text)
  }
  return files
}

async function readInput(input: InputSnapshot, plan: SyncCoordinatorPlan, previous?: SyncOperation['previousBaselinePair'], requestBlob?: BlobRef, selection?: FrozenBaselineSelection, executionPaths = plan.executionScope?.paths, treeCache = new Map<string, ReturnType<typeof readTree>>()): Promise<InputView> {
  if (!['sync-coordinator-v1', 'sync-coordinator-v2'].includes(plan.version) || !plan.targets.length || !plan.writePaths.length) fail('invalid_plan', '可信计划缺少版本、目标或写范围')
  for (const path of [...plan.readPaths, ...plan.writePaths, ...plan.targets.map(item => item.path), ...(plan.newNodeRawSources ?? []).map(item => item.path)]) {
    validateRepositoryPath(path)
    if (isHostPrivatePath(path)) fail('private_context', `可信读写集合包含宿主运行资料: ${path}`)
  }
  const sourceEntries = verifySnapshot(input, treeCache)
  if (plan.version === 'sync-coordinator-v2' && plan.commitTrigger) {
    for (const path of plan.commitTrigger.paths) validateRepositoryPath(path)
    if (plan.commitTrigger.before) {
      const before = plan.commitTrigger.before
      if (canonical(before.source) !== canonical(input.source)) fail('commit_trigger_binding', '提交前态不属于同一真实物理来源')
      const changed = actualTreeDiff(verifySnapshot(before, treeCache), verifySnapshot(input, treeCache)).map(change => change.path)
      if (canonical(unique(changed)) !== canonical(unique(plan.commitTrigger.paths))) fail('commit_trigger_binding', '累计提交路径与真实前后快照不一致')
    }
  }
  let readPaths = selection ? unique([...plan.readPaths, ...executionPaths ?? []]) : [...plan.readPaths]
  let composition = composeAuthoredInput(input, selection ?? previous ?? undefined, { retainConflicts: true, treeCache, ...(selection ? { executionPaths, contextPaths: readPaths } : {}) })
  if (!composition.composed) fail('composition_conflict', '人类输入与前次交付存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
  if (requestBlob) composition = composeControlledRequest(input, composition.composed, requestBlob, { retainConflicts: true, baselineSelection: selection })
  if (!composition.composed) fail('request_conflict', '用户受控差量与已交付细化存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
  let composed = composition.composed, entries = readTree(input.source.commonDir, composed.tree, undefined, treeCache)
  const targetEntries = plan.targets.flatMap(target => {
    const entry = entries.find(item => item.path === target.path)
    return entry && entry.mode !== '120000' ? [entry] : []
  })
  const targetSources = frozenInputTexts(input.source.commonDir, targetEntries)
  const completeReadPaths = unique([...readPaths, ...ownedObligationPaths(plan.targets, executionPaths, targetSources, unique([...entries, ...sourceEntries].map(entry => entry.path)))])
  for (const path of completeReadPaths) {
    validateRepositoryPath(path)
    if (isHostPrivatePath(path)) fail('private_context', `读集合包含宿主运行资料: ${path}`)
  }
  if (canonical(completeReadPaths) !== canonical(readPaths)) {
    readPaths = completeReadPaths
    composition = composeAuthoredInput(input, selection ?? previous ?? undefined, { retainConflicts: true, treeCache, ...(selection ? { executionPaths, contextPaths: readPaths } : {}) })
    if (!composition.composed) fail('composition_conflict', '人类输入与前次交付存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
    if (requestBlob) composition = composeControlledRequest(input, composition.composed, requestBlob, { retainConflicts: true, baselineSelection: selection })
    if (!composition.composed) fail('request_conflict', '用户受控差量与已交付细化存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
    composed = composition.composed; entries = readTree(input.source.commonDir, composed.tree, undefined, treeCache)
  }
  if (contentHash(JSON.stringify(entries)) !== composed.contentDigest || readEvidence(input.source.commonDir, composed.manifestBlob).toString() !== JSON.stringify({ version: 1, entries })) fail('composition_digest', '组合输入真实清单与引用不一致')
  const readEntries = entries.filter(entry => within(entry.path, readPaths))
  for (const entry of readEntries) if (isHostPrivatePath(entry.path)) fail('private_context', `读集合包含宿主运行资料: ${entry.path}`)
  const files = frozenInputTexts(input.source.commonDir, readEntries)
  for (const target of plan.targets) if (!within(target.path, plan.writePaths) || !within(target.path, plan.readPaths)) fail('target_scope', `目标必须在可信读写集合: ${target.path}`)
  const ids = new Set<string>()
  for (const test of plan.mandatoryTests) {
    validateRepositoryPath(test.testPath)
    if (!test.testId || ids.has(`${test.verificationId}:${test.testId}`) || !files.has(test.testPath) || plan.writePaths.some(path => overlap(path, test.testPath)) || !plan.verifications.some(item => item.definition.id === test.verificationId)) fail('oracle_binding', '独立测试必须唯一、已完整读取、不可模型写入且关联可信登记')
    ids.add(`${test.verificationId}:${test.testId}`)
  }
  const headTree = objectGit(input.source.commonDir, ['rev-parse', `${input.headCommit}^{tree}`]).toString().trim()
  const uncovered = actualTreeDiff(readTree(input.source.commonDir, headTree, undefined, treeCache), entries).filter(file => !within(file.path, readPaths) || !selection && !within(file.path, plan.writePaths))
  if (uncovered.length) fail('uncovered_source_change', `外部输入/前次交付差量不在可信影响范围: ${uncovered.map(file => file.path).join(', ')}`, [writeEvidence(input.source.commonDir, uncovered)])
  const readSetDigest = contentHash(canonical({ baseline: selection ? { selectionDigest: selection.digest } : previous ? { id: previous.id, sourceInput: previous.sourceInput.immutableTree, verifiedDelivery: previous.verifiedDelivery.immutableTree, coveredScope: previous.coveredScope } : null, compositionEvidence: composed.compositionEvidenceBlob ?? null, declared: unique(readPaths), entries: readEntries, absent: unique(readPaths.filter(path => !entries.some(entry => within(entry.path, [path])))) }))
  const frozen = await readFrozenContracts(input.source.canonicalRoot, files)
  return { composed, manifest: { version: 1, entries }, files, readPaths, readSetDigest, frozen }
}

/** 接入之前冻结真实读集合和派生输入，只返回既有协议接入结构，不改 source/index。 */
export async function prepareSyncAdmission(input: InputSnapshot, supplied: SyncCoordinatorPlan, options: SyncAdmissionOptions, businessSelection = options.baselineSelection): Promise<AdmitSyncInput> {
  if (supplied.agentWorkflow) assertWorktreeSyncModel(syncModel(options))
  if (options.recordUnverifiedCoverage && (!supplied.agentWorkflow || supplied.version !== 'sync-coordinator-v2' || supplied.direction !== 'code_to_spec' || !supplied.mandatoryTests.length || options.requestBlob || !['initial', 'code'].includes(options.origin))) fail('unverified_coverage_not_allowed', '记录未执行覆盖须为有可信保护测试的原生代码→规格操作')
  const plan = structuredClone(supplied), executionScope = options.executionScope ?? (options.baselineSelection ? plan.executionScope : undefined)
  if (options.baselineSelection && !executionScope) fail('execution_scope_missing', '精确基线接入必须冻结实际目标写入范围')
  const scope = executionScope ?? { paths: unique(plan.writePaths), contractIds: [], flowIds: [] }
  const view = await readInput(input, plan, options.previousBaselinePair, options.requestBlob, businessSelection, executionScope?.paths)
  return { ...syncModelBinding(options.model), ingressKey: options.ingressKey, rootCauseId: options.rootCauseId, origin: options.origin, budget: options.budget, input, ...(options.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), ...(options.automaticSourceAdoption ? { automaticSourceAdoption: options.automaticSourceAdoption } : {}), ...(options.requestBlob ? { requestBlob: options.requestBlob } : {}), ...(options.retryOf ? { retryOf: options.retryOf } : {}), ...(options.inheritRetryBudget ? { inheritRetryBudget: true } : {}), ...(options.baselineSelection ? { baselineSelection: options.baselineSelection } : {}), planBlob: freezeSyncPlanEvidence(input.source.commonDir, plan), scope, policyDigest: syncPlanDigest(plan), impactDigest: options.impactDigest ?? contentHash(canonical({ targets: plan.targets, ...(plan.executionScope ? { scope } : {}), writePaths: unique(plan.writePaths), readSetDigest: view.readSetDigest })), readSetDigest: view.readSetDigest, delivery: null, deliveryPlan: planPrivateDelivery(input, options.managedRoot, options.ingressKey), previousBaselinePair: options.previousBaselinePair ?? null }
}

type Stage = { version: 'sync-stage-v1'; operationId: string; attemptId: string; inputId: string; policyDigest: string; readSetDigest?: string; baselineSelectionRef?: BlobRef; guidanceContractVersion?: string; composedTree?: string; composedContentDigest?: string; stage: string; resultRef: BlobRef }
const behaviorAnalysisStage = (name: string): boolean => name === 'analysis' || name.startsWith('partition:') && name.endsWith(':analysis')
type FrozenAnalysisScope = { active: boolean; operationId: string; inputId: string; source: string; policyDigest: string; refs: Set<string>; candidateDigest?: string; inlineV1Repair?: true; handoffParents?: Map<string, SyncOperation>; readNativeRecord?: typeof readRecord; readIndex?: (attempt: SyncAttempt, owner?: SyncOperation) => SyncCheckpointStageView; selectionMatches?: Map<string, boolean> }
const frozenAnalysisScope = new AsyncLocalStorage<FrozenAnalysisScope>()
function inlineV1RepairScope(operation: SyncOperation): boolean {
  const scope = frozenAnalysisScope.getStore()
  return scope?.active === true && scope.inlineV1Repair === true && scope.operationId === operation.id
    && scope.inputId === operation.input.id && scope.source === canonical(operation.input.source) && scope.policyDigest === operation.policyDigest
}
function readStageCheckpoints(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, indexed = false): SyncCheckpointStageView {
  const scope = frozenAnalysisScope.getStore()
  return scope?.active && scope.readIndex ? scope.readIndex(attempt, operation) : indexed ? readSyncCheckpointStageIndex(store, operation, attempt) : readSyncCheckpoints(store, operation, attempt)
}
function behaviorGuidanceMatches(operation: SyncOperation, saved: Pick<Stage, 'guidanceContractVersion' | 'resultRef'>): boolean {
  if (saved.guidanceContractVersion === CODE_BEHAVIOR_GUIDANCE_VERSION) return true
  const scope = frozenAnalysisScope.getStore()
  return saved.guidanceContractVersion === LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION && !!scope?.active && !!scope.candidateDigest
    && (scope.operationId === operation.id || [...scope.handoffParents?.values() ?? []].some(parent => parent.id === operation.id)) && scope.inputId === operation.input.id && scope.source === canonical(operation.input.source) && scope.policyDigest === operation.policyDigest && scope.refs.has(saved.resultRef.sha256)
}
type SavedElaboration = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
type SavedGeneration = Omit<GenerationResult, 'candidateFiles'> & { p2SpecWritePaths?: string[] }
function stageSelectionMatches(store: SyncStore, operation: SyncOperation, saved: Stage, businessSelection?: FrozenBaselineSelection): boolean {
  if (!operation.baselineSelection) return true
  if (!saved.baselineSelectionRef || !saved.readSetDigest) return false
  const scope = frozenAnalysisScope.getStore(), cache = scope?.active ? scope.selectionMatches : undefined
  const key = cache && JSON.stringify([operation.id, operation.input.id, operation.readSetDigest, operation.baselineSelection.digest, saved.readSetDigest, saved.baselineSelectionRef.sha256, businessSelection?.digest])
  if (key && cache!.has(key)) return cache!.get(key)!
  const selected = JSON.parse(readEvidence(operation.input.source.commonDir, saved.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
  verifyBaselineSelection(operation.input, selected)
  const business = businessSelection ?? store.readBusinessBaselineSelection(operation.id)!
  const matches = selected.digest === business.digest
    ? saved.readSetDigest === operation.readSetDigest
    : extendsWithUninitializedResources(selected, business)
  if (key) cache!.set(key, matches)
  return matches
}
/** P1扩域与续审共用已审映射投影；related/source不产生实现写权。 */
function p1WritableReferences(contracts: readonly Contract[], changedPaths: ReadonlySet<string>, plan: SyncCoordinatorPlan): string[] {
  return contracts.filter(contract => changedPaths.has(contract.path)).flatMap(contract => [...contract.code.map(anchor => anchor.split('#')[0]), ...contract.items.filter(item => item.kind === 'AC').map(item => item.test.split('#')[0])]).filter(path => within(path, plan.writePaths) && !plan.mandatoryTests.some(oracle => overlap(path, oracle.testPath)))
}

function generationRepairInput(previous: SavedGeneration, issue?: SyncFailure): { previousOutput: unknown; diagnostics: { code: string; message: string }[] } {
  const findings = previous.partitionEvidence ? previous.partitionEvidence.flatMap(item => item.review.findings) : previous.review?.findings ?? []
  return { previousOutput: previous.output, diagnostics: [...(issue ? [{ code: issue.code, message: issue.message }] : []), ...previous.validationFindings.map(item => ({ code: item.code, message: item.message })), ...findings.map(item => ({ code: item.kind, message: JSON.stringify(item) }))] }
}
type Refinement = { prior: SavedElaboration; candidate: CandidateRef; candidateDigest: string; diagnostics: { code: string; message: string }[] }
type ReadonlyOwnerRepair = { kind?: 'candidate_review'; reviewEvidence?: { partitionId: string; resultRef: BlobRef }[]; fromAttemptId: string; generationRef: BlobRef; priorRef: BlobRef; planAttemptId: string; planRef: BlobRef; candidateDigest: string; findings: ContractFinding[]; allFindings: ContractFinding[]; owners: { key: string; partitionId: string; fromAttemptId: string; resultRef: BlobRef }[] }
/** 只阻止没有对应owner派发的同产物热循环；真实Agent尝试次数不受此门限制。 */
export function readonlySpecRepairStalled(repair: Pick<ReadonlyOwnerRepair, 'candidateDigest' | 'findings' | 'owners'>, candidateDigest: string | undefined, findings: readonly ContractFinding[], attempt: Pick<SyncAttempt, 'id' | 'dispatchPlans'>): boolean {
  return candidateDigest === repair.candidateDigest && canonical(findings.filter(item => item.severity === 'error')) === canonical(repair.findings) && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_') && repair.owners.some(owner => dispatch.key.startsWith(`sync:${attempt.id}:elaborate:partition:${owner.partitionId}:`)))
}
function stage<T>(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, name: string, usage: 'automatic' | 'evidence' = 'automatic', checkpoints: SyncCheckpointStageView = readStageCheckpoints(store, operation, attempt), matchesSelection = (value: Stage) => stageSelectionMatches(store, operation, value)): T | null {
  for (const { value: entry } of checkpoints.json) {
    const value = entry as Partial<Stage>
    if (value.version !== 'sync-stage-v1' || value.stage !== name) continue
    if (value.operationId !== operation.id || value.attemptId !== attempt.id || value.inputId !== operation.input.id || value.policyDigest !== operation.policyDigest || !value.resultRef) fail('stage_binding', '持久阶段身份不一致')
    if (!matchesSelection(value as Stage)) continue
    if (usage === 'automatic' && behaviorAnalysisStage(name) && !behaviorGuidanceMatches(operation, value as Stage)) return null
    if (checkpoints.raw.has(value.resultRef.sha256)) fail('stage_binding', '不可信拒稿不能成为阶段结果')
    const result = checkpoints.json.find(entry => entry.ref.sha256 === value.resultRef!.sha256)
    return result ? result.value as T : JSON.parse(readEvidence(operation.input.source.commonDir, value.resultRef).toString('utf8')) as T
  }
  return null
}
function reuseBehaviorDependentStages(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, checkpoints = readStageCheckpoints(store, operation, attempt, true)): boolean {
  const original = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', 'evidence', checkpoints)
  const challenges = readP0ReviewChallenges(store, operation)
  if (!behaviorChallengesAnswered(original, challenges)) return false
  if (original) requireChallengedWholeApproval(store, operation, attempt, original, challenges)
  return original?.guidanceContractVersion === undefined || original.guidanceContractVersion === CODE_BEHAVIOR_GUIDANCE_VERSION
    && stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', 'automatic', checkpoints) !== null
}
type ReadonlyRepairBinding = { readonlyOwnerRepair?: ReadonlyOwnerRepair; readonlyBaseRef?: BlobRef }
/** pending可以结束，已审返修的原始因果仍由同attempt最近完整原件负责。 */
function readonlyRepairBinding(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, checkpoints: SyncCheckpointStageView = readSyncCheckpointStageIndex(store, operation, attempt)): ReadonlyRepairBinding | null {
  for (const entry of checkpoints.json.filter(({ value }) => (value as Partial<Stage>).stage === 'repair-input')) {
    const input = stage<ReadonlyRepairBinding>(store, operation, attempt, 'repair-input', 'evidence', { ...checkpoints, json: [entry] })
    if (input?.readonlyOwnerRepair) return { readonlyOwnerRepair: input.readonlyOwnerRepair, ...(input.readonlyBaseRef ? { readonlyBaseRef: input.readonlyBaseRef } : {}) }
  }
  return null
}
type ElaborationComposedBinding = { composedTree: string; composedContentDigest: string }
function elaborationComposedBinding(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, result: SavedElaboration, composed: ComposedInputRef, checkpoints: SyncCheckpointStageView = readStageCheckpoints(store, operation, attempt)): ElaborationComposedBinding | null {
  const resultDigest = contentHash(JSON.stringify(result))
  const original = checkpoints.json.map(({ value }) => value as Partial<Stage>)
    .find(value => value.version === 'sync-stage-v1' && value.stage === 'elaboration' && value.operationId === operation.id && value.attemptId === attempt.id && value.inputId === operation.input.id && value.policyDigest === operation.policyDigest && value.resultRef?.sha256 === resultDigest && stageSelectionMatches(store, operation, value as Stage))
  return original?.composedTree === composed.tree && original.composedContentDigest === composed.contentDigest
    ? { composedTree: original.composedTree, composedContentDigest: original.composedContentDigest } : null
}
function elaborationRepairSeed(result: SavedElaboration | null, requestKey: string): ElaborationRepairSeed | undefined {
  const last = result?.rounds.at(-1)
  return result?.failure?.code === 'repair_budget_exhausted' && !last?.draft && last?.candidate && last.candidateDigest
    ? { settled: true, requestKey, inputDigest: result.inputDigest, candidateDigest: last.candidateDigest, output: last.output, candidate: last.candidate, findings: last.findings, review: last.review, traces: last.traces } : undefined
}

function partitionStage<T>(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, sourceSelection?: FrozenBaselineSelection, checkpoints: SyncCheckpointStageView = readStageCheckpoints(store, operation, attempt), selectionCheck?: { expectedRef: BlobRef; matches: (value: Stage) => boolean }, usage: 'automatic' | 'evidence' = 'automatic'): { result: T; resultRef: BlobRef } | null {
  const phaseSelection = checkpointStageSelection(operation)
  const result = stage<T>(store, operation, attempt, key, usage, checkpoints, selectionCheck?.matches ?? (phaseSelection ? value => stageSelectionMatches(store, operation, value, phaseSelection) : undefined))
  if (!result) return null
  const resultRef = writeEvidence(operation.input.source.commonDir, result)
  const original = checkpoints.json.map(({ value }) => value as Partial<Stage>)
    .find(value => value.version === 'sync-stage-v1' && value.stage === key && value.operationId === operation.id && value.attemptId === attempt.id && value.inputId === operation.input.id && value.policyDigest === operation.policyDigest && value.resultRef?.sha256 === resultRef.sha256)
  if (original?.readSetDigest !== operation.readSetDigest || operation.baselineSelection && original.baselineSelectionRef?.sha256 !== (selectionCheck?.expectedRef ?? writeEvidence(operation.input.source.commonDir, sourceSelection ?? phaseSelection ?? store.readBusinessBaselineSelection(operation.id))).sha256) return null
  return { result, resultRef }
}

/** 续修材料仍然未批准；原stage和Native身份由所属operation认证。 */
function retryDraftSources(store: SyncStore, operation: SyncOperation, attemptNumber: number, stageSelection?: FrozenBaselineSelection): { owner: SyncOperation; prior: SyncAttempt }[] {
  const sources: { owner: SyncOperation; prior: SyncAttempt }[] = []
  const selection = canonical(stageSelection ?? store.readBusinessBaselineSelection(operation.id))
  for (const owner of retryOperationLineage(store, operation)) {
    if (owner.readSetDigest !== operation.readSetDigest || canonical(owner.scope) !== canonical(operation.scope)) break
    const ownerSelection = owner.id === operation.id && stageSelection ? stageSelection : store.readBusinessBaselineSelection(owner.id)
    if (canonical(ownerSelection) !== selection) break
    sources.push(...store.listAttempts(owner.id).filter(prior => (owner.id !== operation.id || prior.number < attemptNumber) && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse().map(prior => ({ owner, prior })))
  }
  return sources
}
function reviewHandoffParent(store: SyncStore, operation: SyncOperation): SyncOperation | null {
  if (!operation.inheritRetryBudget) return null
  const active = frozenAnalysisScope.getStore()
  const cached = active?.handoffParents?.get(operation.id)
  if (cached) return cached
  const parent = findReviewHandoffParent(store, operation)
  if (!parent) fail('review_handoff_binding', '候选换模型交接缺少同源直接父操作、精确冻结授权、原预算族或正式结算')
  if (active?.active) { active.handoffParents ??= new Map(); active.handoffParents.set(operation.id, parent) }
  return parent
}

/** 返修接续只读原派发的输入，历史生成结果没有新的批准权。 */
function settledSealRepairRequest(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, dispatch: SyncAttempt['dispatchPlans'][number]) {
  const resource = store.findResource(attempt.id, dispatch.key)
  if (resource?.phase !== 'removed' || resource.operationId !== operation.id || resource.attemptId !== attempt.id || resource.generation !== attempt.generation
    || resource.plan.kind !== 'native_session' || resource.plan.key !== dispatch.key || resource.plan.inputId !== operation.input.id || resource.plan.payloadDigest !== dispatch.requestDigest) return null
  const commonDir = operation.input.source.commonDir
  const plan = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString('utf8')) as NativeRunCheckpoint
  const sessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const stopped = checkpoint.stop?.nativeStopped === true && checkpoint.stop.sessionId === sessionId
    && (checkpoint.stop.threadId ?? null) === checkpoint.session.threadId && (checkpoint.stop.turnId ?? null) === checkpoint.session.turnId
  const completed = checkpoint.status === 'completed' && checkpoint.nativeState === 'completed' && checkpoint.result?.sessionId === sessionId
    && checkpoint.result.threadId === checkpoint.session.threadId && checkpoint.result.turnId === checkpoint.session.turnId
  const settled = checkpoint.nativeCallRequested ? stopped || completed : stopped && !checkpoint.nativeStarted && checkpoint.stop?.nativeStatus === 'notDispatched'
  if ([plan, checkpoint].some(evidence => evidence.schemaVersion !== 1 || evidence.operationId !== operation.id || evidence.attemptId !== attempt.id || evidence.inputId !== operation.input.id
    || evidence.candidateDigest !== resource.plan.candidateDigest || evidence.requestDigest !== dispatch.requestDigest || evidence.expectedSessionId !== sessionId)
    || checkpoint.phase !== 'removed' || checkpoint.session.sessionId !== sessionId || !settled
    || dispatch.session && (dispatch.session.sessionId !== sessionId || dispatch.session.threadId && dispatch.session.threadId !== checkpoint.session.threadId || dispatch.session.turnId && dispatch.session.turnId !== checkpoint.session.turnId)
    || plan.sessionCreateKey !== dispatch.sessionCreateKey || plan.request.requestKey !== dispatch.key || plan.request.purpose !== dispatch.purpose || !matchesNativeDispatchModel(operation, dispatch, plan.request)
    || plan.request.frozenContext || plan.request.worktree?.mode !== (dispatch.purpose === 'elaboration_generate' ? 'edit' : 'read') || contentHash(JSON.stringify(plan.request)) !== dispatch.requestDigest) return null
  const task = plan.request.prompt.split('\n任务:\n', 2)[1]?.split('\n', 1)[0]
  return task ? (JSON.parse(task) as { repair?: Pick<ReadonlySpecRepair, 'kind' | 'generationRef' | 'acceptedRef' | 'candidateDigest' | 'findings'> & { owner: NonNullable<ElaborationResult['partitionBinding']> } }).repair ?? null : null
}

/** Git保活本身不证明模型完成；未认证的Native稿不能遮蔽更早合格原稿。 */
function authenticatedDraftResult(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, key: string, purpose: string, draft?: ElaborationDraft, readCompletedRecord?: (id: string) => NativeRunRecord | null): { result?: ElaborationSessionResult; request?: ElaborationSessionRequest } | null {
  const dispatch = prior.dispatchPlans.find(dispatch => dispatch.key === key && dispatch.purpose === purpose)
  if (!dispatch?.session?.threadId || !dispatch.session.turnId || dispatch.session.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) return null
  const resource = store.findResource(prior.id, key)
  let result: ElaborationSessionResult | null, request: ElaborationSessionRequest | undefined
  if (resource) {
    const native = JSON.parse(readEvidence(owner.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
    const checkpoint = JSON.parse(readEvidence(owner.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    const edit = draft !== undefined || readCompletedRecord !== undefined
    if (!edit && inlineV1RepairScope(owner)) {
      if (native.request.worktree || native.request.model !== syncModel(owner)) return null
    } else if (native.request.worktree?.mode !== (edit ? 'edit' : 'read') || native.request.frozenContext) return null
    if (!checkpoint.result || checkpoint.nativeState !== 'completed') {
      if (readCompletedRecord) return null
      const failure = checkpoint.failure, packet = failure?.rejectedOutput, witness = failure?.failedWorktree
      if (!draft || !failure || !witness || !reviewFormatRepairCodes.has(failure.code) || checkpoint.phase !== 'removed' || checkpoint.stop?.nativeStopped !== true) return null
      const identity = { ...failure, sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }
      const state = packet ? authenticateNativeRejectedFinal(store, owner, prior, key, identity, packet) : authenticateNativeFailure(store, owner, prior, key, identity).state
      if (!packet && !['structured_output_format_invalid', 'structured_output_retries_exhausted'].includes(failure.code) || canonical(state.failedWorktree) !== canonical(witness)) return null
      if (!packet && canonical(checkpoint.stop) !== canonical({ sessionId: checkpoint.session.sessionId, state: state.state, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation?.acknowledged, nativeStatus: state.cancellation?.nativeStatus, ...(state.cancellation?.error ? { error: state.cancellation.error } : {}) })) return null
      return state.cancellation?.nativeStopped === true && canonical({ baseCommit: witness.baseCommit, tree: witness.baseTree, mode: 'edit' }) === canonical(draft.seed) && witness.headCommit === draft.resultCommit && witness.tree === draft.resultTree ? {} : null
    }
    request = native.request
    const trace = { purpose, sessionId: dispatch.session.sessionId, threadId: dispatch.session.threadId, turnId: dispatch.session.turnId, inputDigest: request.inputDigest, resultDigest: checkpoint.result.resultDigest }
    result = completedNativeStageResult(store, owner, prior, request, trace, checkpoint.result.output, '', undefined, readCompletedRecord)
  } else {
    const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, owner, prior, `injected:${key}`)
    result = injected && injected.requestDigest === dispatch.requestDigest && canonical({ sessionId: injected.result.sessionId, threadId: injected.result.threadId, turnId: injected.result.turnId }) === canonical(dispatch.session) && injected.result.resultDigest === contentHash(JSON.stringify(injected.result.output)) ? injected.result : null
  }
  if (result && !draft) return { result, request }
  return result?.worktree && draft && canonical({ baseCommit: result.worktree.baseCommit, tree: result.worktree.baseTree, mode: 'edit' }) === canonical(draft.seed) && result.worktree.headCommit === draft.resultCommit && result.worktree.tree === draft.resultTree ? { result, request } : null
}

function elaborationReviewOrigin(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, result: SavedElaboration, allowSameOperation = false): { owner: SyncOperation; prior: SyncAttempt; result: SavedElaboration } | null {
  const diagnostics = result.repairDiagnostics, binding = result.partitionBinding
  if (!diagnostics || !owner.retryOf && !allowSameOperation) return null
  const key = binding ? `partition:${binding.partitionId}:elaboration` : 'elaboration'
  const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, owner, prior, `${key}:repair-diagnostics-provenance`)
  if (!provenance || canonical(provenance.resultRef) !== canonical(diagnostics.resultRef)) return null
  const selection = checkpointStageSelection(owner)
  const origin = retryDraftSources(store, owner, prior.number, selection).find(({ owner, prior }) => owner.id === provenance.fromOperationId && prior.id === provenance.fromAttemptId)
  if (!origin || origin.owner.id !== owner.id && !settledApprovalSource(store, origin.owner)) return null
  if (canonical(origin.prior.composedInput) !== canonical(prior.composedInput)
    && (!selection || !composedBeforeNullExpansionMatches(origin.prior.composedInput, prior.composedInput, selection.digest))) return null
  const original = partitionStage<SavedElaboration>(store, origin.owner, origin.prior, key)
  const suffix = binding ? `:partition:${binding.partitionId}` : ''
  if (!original || canonical(original.resultRef) !== canonical(provenance.resultRef)
    || diagnostics.requestKey !== `sync:${origin.prior.id}:elaborate${suffix}`
    || original.result.inputDigest !== result.inputDigest || diagnostics.inputDigest !== result.inputDigest
    || canonical(original.result.partitionBinding) !== canonical(binding)
    || !original.result.structurePassed || original.result.reviewPassed || original.result.phase === 'partitioned_final'
    || canonical(original.result.failure) !== canonical(diagnostics.failure)
    || canonical(original.result.rounds.at(-1)) !== canonical(diagnostics.round)) return null
  return { ...origin, result: original.result }
}

/** 续审沿正式检查点查原作者；新独审轮号和新执行路线不代替原生成。 */
function elaborationGenerationSource(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, round: ElaborationResult['rounds'][number], result: SavedElaboration): { owner: SyncOperation; attempt: SyncAttempt; key: string; request?: ElaborationSessionRequest } | null {
  const traces = round.traces.filter(trace => trace.purpose === 'elaboration_generate'), trace = traces[0]
  if (traces.length !== 1 || trace.resultDigest !== contentHash(JSON.stringify(round.output))) return null
  if (round.crossFreezeAuthor) return authenticateCrossFreezeP1Generation(store, owner, prior, result, round)
  for (;;) {
    for (const attempt of store.listAttempts(owner.id).filter(attempt => attempt.number <= prior.number)) {
      const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && canonical(dispatch.session) === canonical({ sessionId: trace.sessionId, threadId: trace.threadId, turnId: trace.turnId }))
      if (!dispatch) continue
      const authenticated = authenticatedDraftResult(store, owner, attempt, dispatch.key, 'elaboration_generate', round.draft)
      if (!authenticated?.result || authenticated.result.resultDigest !== trace.resultDigest || canonical(authenticated.result.output) !== canonical(round.output) || authenticated.request && authenticated.request.inputDigest !== trace.inputDigest) return null
      return { owner, attempt, key: dispatch.key, ...(authenticated.request ? { request: authenticated.request } : {}) }
    }
    const origin = elaborationReviewOrigin(store, owner, prior, result)
    const original = origin?.result.rounds.at(-1)
    if (!origin || !original?.candidate || !original.draft || original.candidateDigest !== round.candidateDigest
      || canonical(original.candidate) !== canonical(round.candidate) || canonical({ ...original.draft, errors: undefined }) !== canonical({ ...round.draft, errors: undefined })
      || canonical(original.traces.find(trace => trace.purpose === 'elaboration_generate')) !== canonical(trace)) return null
    owner = origin.owner
    prior = origin.prior
    result = origin.result
  }
}

function elaborationNativeInputDigest(inputDigest: string, { purpose, prompt, schema, worktree }: ElaborationSessionRequest): string {
  return contentHash(JSON.stringify({ inputDigest, purpose, prompt, schema, worktree }))
}

function assertStoppedEventsRpcDraft(prior: SyncAttempt, key: string, proof: ReturnType<typeof authenticateNativeFailure>): void {
  const { status, nativeState, failure, result, session } = proof.checkpoint
  if (!isZCodeEventsRpcTimeout(proof.state) || status !== 'failed' || nativeState !== 'failed' || failure?.code !== 'native_rpc_timeout' || failure.message !== proof.state.error || failure.failedWorktree || failure.rejectedOutput || result
    || proof.state.failedWorktree || proof.state.resultWorktree || proof.state.rejectedOutput || proof.state.output !== undefined || proof.state.resultDigest !== undefined) fail('stale_result', 'ZCode events RPC草稿缺少原typed失败和结算原件')
  if (!session.threadId || !session.turnId || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === key)?.session) !== canonical(session)
    || proof.record.harnessSessionId !== null && proof.record.harnessSessionId !== session.threadId) fail('stale_result', 'ZCode events RPC草稿缺少原完整派发与canonical Native身份')
}

function settledZCodeP0Cancellation(prior: SyncAttempt, resource: SyncResourceRecord, proof: ReturnType<typeof authenticateNativeFailure>): boolean {
  const { checkpoint, plan, record, state } = proof
  return plan.request.purpose === 'code_behavior_analyze' && plan.request.model?.startsWith('zcode:') === true
    && prior.status === 'superseded' && resource.generation === prior.generation && !proof.observedFailure
    && checkpoint.status === 'cancelled' && checkpoint.nativeState === 'cancelled'
    && checkpoint.nativeStarted === true && checkpoint.nativeCallRequested === true
    && !checkpoint.result && !checkpoint.failure && !checkpoint.creationTermination
    && checkpoint.stop?.nativeStatus === 'stopped' && checkpoint.stop.acknowledged === true && checkpoint.stop.error === undefined
    && state.state === 'cancelled' && state.errorCode === undefined
    && state.output === undefined && state.resultDigest === undefined && !state.failedWorktree && !state.resultWorktree && !state.rejectedOutput
    && record.harness === 'zcode' && !!checkpoint.session.threadId && !!checkpoint.session.turnId && record.harnessSessionId === checkpoint.session.threadId
    && canonical(prior.dispatchPlans.find(dispatch => dispatch.key === plan.request.requestKey)?.session) === canonical(checkpoint.session)
}

function assertUnpublishedGrokFailure(operation: SyncOperation, prior: SyncAttempt, resource: SyncResourceRecord, proof: ReturnType<typeof authenticateNativeFailure>): void {
  const { plan, checkpoint, record, state } = proof
  if (resource.generation !== prior.generation || plan.request.root !== operation.input.source.canonicalRoot || plan.request.base !== plan.request.worktree?.baseCommit
    || !checkpoint.nativeCallRequested || checkpoint.nativeStarted || checkpoint.status !== 'failed' || checkpoint.nativeState !== 'failed' || checkpoint.result || checkpoint.creationTermination
    || checkpoint.failure?.code !== 'failed' || checkpoint.failure.message !== state.error || checkpoint.failure.rejectedOutput || checkpoint.failure.failedWorktree
    || checkpoint.session.threadId !== null || checkpoint.session.turnId !== null
    || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === plan.request.requestKey)?.session) !== canonical(checkpoint.session)) fail('stale_result', 'Grok 来源缺少原正式未发布失败')
  if (record.harness !== 'grok-structured' || record.harnessSessionId !== null) fail('stale_result', 'Grok 来源的原生身份不匹配')
}

function assertStoppedArchiveTree(commonDir: string, sessionId: string, headCommit: string, tree: string): void {
  const archive = `refs/spex-archive/${sessionId}`
  if (objectGit(commonDir, ['rev-list', '--parents', '-n', '1', archive]).toString().trim().split(' ').slice(1).join(' ') !== headCommit
    || objectGit(commonDir, ['rev-parse', `${archive}^{tree}`]).toString().trim() !== tree) fail('stale_result', '已停会话归档与原 Git HEAD 或树不一致')
}

function settledElaborationReview(store: SyncStore, operation: SyncOperation, prior: SyncAttempt, ownerKey: string, result: SavedElaboration, round: ElaborationResult['rounds'][number], failure: NonNullable<ElaborationResult['failure']>, allowStoppedReview = false): ElaborationRepairDiagnostics['settledReview'] {
  const providerReview = result.status === 'unsupported' && isZCodeProviderRejection(failure)
  if ((!providerReview && result.status !== 'failed') || !result.structurePassed || result.reviewPassed || !round.draft || !round.candidate || round.review !== null || round.reviewOutput !== null) return
  const rejection = round.rejectedOutput, grokExit = !rejection && isGrokNativeExitFailure(failure)
  const formatWithoutPacket = !rejection && reviewFormatRepairCodes.has(failure.code)
  const stoppedReview = allowStoppedReview && !rejection && !grokExit && (failure.code === 'failed' || failure.code === 'cancellation_pending')
  const key = `${ownerKey}:${round.index}:elaboration_review`
  const quota = !rejection && failure.code === 'provider_quota_exhausted' ? managedQuotaDispatch(store, operation, prior, key) : undefined
  if (providerReview && rejection) return
  if (!rejection && !grokExit && failure.code === 'failed' && round.candidateDigest) {
    const unstarted = authenticateUnstartedElaborationReview(store, operation, prior, key, failure, round.candidateDigest)
    if (unstarted) {
      if (prior.dispatchPlans.some(dispatch => store.findResource(prior.id, dispatch.key)?.phase !== 'removed')) fail('review_retry_binding', '未启动独审仍有同轮未结算资源')
      return { ...boundElaborationReview(store, operation, prior, ownerKey, result, round, unstarted.request, undefined, unstarted.archivedSessionId), kind: 'unstarted' }
    }
  }
  if (!providerReview && !quota && !stoppedReview && (rejection ? !reviewFormatRepairCodes.has(failure.code) || rejection.purpose !== 'elaboration_review' || !rejection.ref || rejection.ownerRequestKey !== ownerKey || rejection.ownerInputDigest !== result.inputDigest : !grokExit && !formatWithoutPacket && (failure.code !== 'native_rpc_timeout' || !isZCodeEventsRpcTimeout({ state: 'failed', errorCode: failure.code, error: failure.message })))) return
  const resource = store.findResource(prior.id, key)
  if (!resource || resource.phase !== 'removed' || prior.dispatchPlans.some(dispatch => store.findResource(prior.id, dispatch.key)?.phase !== 'removed')) fail('review_retry_binding', '独审失败缺少原正式资源及结算证明')
  const proof = authenticateNativeFailure(store, operation, prior, key, failure, readRecord, true)
  const { plan, checkpoint, record, state } = proof, { request } = plan, { session } = checkpoint
  const nativeClaudeFormat = reviewFormatRepairCodes.has(failure.code) && request.model?.startsWith('claude:') && record.harness === 'claude-headless'
    && state.state === 'failed' && state.claudeNative?.sessionId === session.threadId && state.claudeNative.userUuid === session.turnId
  if (formatWithoutPacket && !nativeClaudeFormat) return
  if (stoppedReview || nativeClaudeFormat) {
    if (!proof.observedFailure && failure.code !== 'cancellation_pending' || checkpoint.stop?.nativeStopped !== true || !record.archived || request.worktree?.mode !== 'read'
      || stoppedReview && (state.state !== 'cancelled' || state.rejectedOutput)
      || nativeClaudeFormat && (checkpoint.stop.nativeStatus !== 'processGroupGone' || !!state.rejectedOutput !== !!rejection))
      fail('review_retry_binding', '独审缺少原失败观察、精确退出或只读归档')
    assertStoppedArchiveTree(operation.input.source.commonDir, record.session, request.worktree.baseCommit, request.worktree.tree)
  }
  if (grokExit) {
    if (request.worktree?.mode !== 'read' || !matchesAttemptNativeModel(operation, prior, request) || !request.model?.startsWith('grok:')
      || request.nativeConfiguration !== 'cli-config-v1' || !record.archived) fail('review_retry_binding', 'Grok 独审退出失败缺少原只读归档及冻结执行绑定')
    assertUnpublishedGrokFailure(operation, prior, resource, proof)
    assertGrokUnpublishedExitSource(record.session, nativeWorktreePrompt(request.prompt, request.worktree), state, record.worktreePath, 'elaboration_review')
    assertStoppedArchiveTree(operation.input.source.commonDir, record.session, request.worktree.baseCommit, request.worktree.tree)
  }
  if (rejection) authenticateElaborationReviewRejection(store, operation, prior, key, failure, rejection, checkpoint)
  const failedWorktree = state.failedWorktree
  if (failedWorktree || checkpoint.failure?.failedWorktree) {
    if ((!rejection && !nativeClaudeFormat) || !failedWorktree || request.worktree?.mode !== 'read'
      || canonical(failedWorktree) !== canonical(checkpoint.failure?.failedWorktree)
      || failedWorktree.worktreePath !== record.worktreePath) fail('review_retry_binding', '独审拒稿的只读Git见证与原失败记录不匹配')
    verifyStageResult(operation.input.source.commonDir, request.worktree, { worktree: failedWorktree })
  }
  const transportMatches = stoppedReview || nativeClaudeFormat || grokExit || (quota ? state.state === 'failed' && !state.rejectedOutput : rejection
    ? state.state === 'failed' && (request.model?.startsWith('zcode:') && record.harness === 'zcode' || request.model?.startsWith('claude:') && record.harness === 'claude'
      || request.model?.startsWith('grok:') && record.harness === 'grok-structured' && state.grokNative?.sessionId === session.threadId && state.grokNative?.turnId === session.turnId
      || request.model?.startsWith('cursor:') && record.harness === 'cursor-structured' && state.cursorNative?.sessionId === session.threadId && state.cursorNative?.requestId === session.turnId
      || request.model?.startsWith('codex:') && record.harness === 'codex-headless' && state.codexNative?.threadId === session.threadId && state.codexNative?.turnId === session.turnId)
    : request.model?.startsWith('zcode:') && (providerReview ? matchesAttemptNativeModel(operation, prior, request) : isZCodeEventsRpcTimeout(state)) && record.harness === 'zcode' && state.zcodeNative?.sessionId === session.threadId && state.zcodeNative.turnId === session.turnId && !state.rejectedOutput)
  const publishedIdentity = checkpoint.nativeStarted && !!session.threadId && !!session.turnId
  const terminalStatus = stoppedReview ? 'cancelled' : 'failed'
  const expectedFailure = stoppedReview ? undefined : { code: failure.code, message: failure.message, ...(rejection ? { rejectedOutput: checkpoint.failure?.rejectedOutput } : {}), ...(failedWorktree ? { failedWorktree } : {}) }
  if (resource.attemptId !== prior.id || resource.generation !== prior.generation || plan.schemaVersion !== 1 || checkpoint.schemaVersion !== 1
    || request.purpose !== 'elaboration_review' || request.worktree?.mode !== 'read' || !transportMatches || record.base !== request.base || record.forkCommit !== request.base
    || !checkpoint.nativeCallRequested || !grokExit && !publishedIdentity || checkpoint.status !== terminalStatus || checkpoint.nativeState !== terminalStatus
    || !quota && !stoppedReview && !nativeClaudeFormat && checkpoint.stop?.nativeStatus !== 'stopped' || checkpoint.result || checkpoint.creationTermination
    || checkpoint.candidateDigest !== null && checkpoint.candidateDigest !== round.candidateDigest
    || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === key)?.session) !== canonical(session)
    || canonical(checkpoint.failure) !== canonical(expectedFailure)
    || record.harnessSessionId !== session.threadId || state.resultWorktree || state.output !== undefined || state.resultDigest !== undefined) fail('review_retry_binding', '独审失败缺少同owner原只读请求及精确已结算的Native失败身份')
  if (providerReview) assertZCodeSettledProviderFailure(record.session, nativeWorktreePrompt(request.prompt, request.worktree), state as ZCodeStructuredExecution, record.worktreePath, 'elaboration_review')
  return boundElaborationReview(store, operation, prior, ownerKey, result, round, request, quota)
}

function authenticateElaborationReviewRejection(store: SyncStore, owner: SyncOperation, source: SyncAttempt, sourceKey: string, sourceFailure: NonNullable<ElaborationResult['failure']>, sourceRejection: NonNullable<ElaborationResult['rounds'][number]['rejectedOutput']>, original: NativeRunCheckpoint): void {
  const { ownerInputDigest: _ownerInputDigest, ownerRequestKey: _ownerRequestKey, ...packet } = sourceRejection
  const originalPacket = original.failure?.rejectedOutput
  if (!originalPacket || original.failure?.code !== sourceFailure.code || original.failure.message !== sourceFailure.message
    || canonical({ ...originalPacket, ref: undefined }) !== canonical({ ...packet, ref: undefined })) fail('review_retry_binding', '独审拒稿不匹配原正式失败')
  authenticateNativeRejectedFinal(store, owner, source, sourceKey, sourceFailure, packet)
}

function boundElaborationReview(store: SyncStore, operation: SyncOperation, prior: SyncAttempt, ownerKey: string, result: SavedElaboration, round: ElaborationResult['rounds'][number], request: NativeRunPlan['request'], quota?: ReturnType<typeof managedQuotaDispatch>, archivedSessionId?: string): NonNullable<ElaborationRepairDiagnostics['settledReview']> {
  if (!round.draft || !round.candidate || request.worktree?.mode !== 'read' || request.frozenContext || !matchesAttemptNativeModel(operation, prior, request)
    || request.inputDigest !== elaborationNativeInputDigest(result.inputDigest, request) || request.root !== operation.input.source.canonicalRoot
    || request.base !== request.worktree.baseCommit) fail('review_retry_binding', '独审失败缺少同owner原只读任务及冻结输入')
  if (archivedSessionId) assertStoppedArchiveTree(operation.input.source.commonDir, archivedSessionId, request.worktree.baseCommit, request.worktree.tree)
  const generation = elaborationGenerationSource(store, operation, prior, round, result)
  const generationOwner = generation && ownerKey.replace(`sync:${prior.id}:`, `sync:${generation.attempt.id}:`)
  if (!generation?.request || !generation.key.startsWith(`${generationOwner}:`) || generation.request.inputDigest !== elaborationNativeInputDigest(round.crossFreezeAuthor?.oldInputDigest ?? result.inputDigest, generation.request)
    || !matchesAttemptNativeModel(generation.owner, generation.attempt, generation.request)
    || generation.request.root !== request.root || generation.request.base !== round.draft.seed.baseCommit
    || store.findResource(generation.attempt.id, generation.key)?.generation !== generation.attempt.generation
    || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== result.candidateDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate))) fail('review_retry_binding', '独审失败缺少同owner原Native生成及其精确Git候选绑定')
  const boundReview = { prompt: request.prompt, schema: request.schema, worktree: request.worktree, ...(quota ? { reviewQuota: { route: quota.route, failedSessionId: quota.failedSessionId } } : {}) }
  let carrier = { owner: operation, prior, result }, diagnostics = result.repairDiagnostics
  while (diagnostics && !diagnostics.round.rejectedOutput) {
    const origin = elaborationReviewOrigin(store, carrier.owner, carrier.prior, carrier.result, true)
    const previous = origin?.result.rounds.at(-1)
    if (!origin || !previous || previous.candidateDigest !== round.candidateDigest
      || canonical(previous.traces[0]) !== canonical(round.traces[0])) break
    carrier = origin
    diagnostics = carrier.result.repairDiagnostics
  }
  const previousRound = diagnostics?.round, previous = previousRound?.rejectedOutput
  if (!diagnostics || !previousRound || previous?.purpose !== 'elaboration_review' || !previous.ref
    || previousRound.candidateDigest !== round.candidateDigest || canonical(previousRound.traces[0]) !== canonical(round.traces[0])) return boundReview
  const original = JSON.parse(readEvidence(operation.input.source.commonDir, diagnostics.resultRef).toString('utf8')) as SavedElaboration
  const source = store.readAttempt(previous.ownerRequestKey.split(':')[1])
  const sourceKey = `${previous.ownerRequestKey}:${previousRound.index}:elaboration_review`
  const sourceOwner = source.operationId === carrier.owner.id
    ? source.number < carrier.prior.number ? carrier.owner : null
    : elaborationReviewOrigin(store, carrier.owner, carrier.prior, carrier.result)?.owner
  if (sourceOwner?.id !== source.operationId || previous.ownerRequestKey !== ownerKey.replace(`sync:${prior.id}:`, `sync:${source.id}:`)
    || previous.ownerInputDigest !== result.inputDigest || original.inputDigest !== result.inputDigest
    || canonical(original.failure) !== canonical(diagnostics.failure) || canonical(original.rounds.at(-1)) !== canonical(previousRound)) fail('review_retry_binding', '旧独审附件缺少同候选原失败和精确来源')
  const authenticated = authenticateNativeFailure(store, sourceOwner, source, sourceKey, diagnostics.failure, readRecord, true)
  authenticateElaborationReviewRejection(store, sourceOwner, source, sourceKey, diagnostics.failure, previous, authenticated.checkpoint)
  return { ...boundReview, previousRejection: { sha256: previous.sha256, text: previous.text } }
}

/** P1业务扩域与原文件规划分别作证，完整scope必须精确等于两者的实际并集。 */
function reviewScopeProof(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, approved: SavedElaboration, generation: SavedGeneration, readIndex?: (source: SyncAttempt) => SyncCheckpointStageView): { p1: NonNullable<SyncOperation['contractScopeExpansions']>[number]; writerRef?: BlobRef; paths: string[] } | null {
  const commonDir = operation.input.source.commonDir, approvedRef = writeEvidence(commonDir, approved)
  const p1 = operation.contractScopeExpansions?.find(expansion => expansion.evidenceRef.sha256 === approvedRef.sha256)
  if (!p1 || !generation.candidate || !generation.fileWriterPlanRef) return null
  const filePlan = JSON.parse(readEvidence(commonDir, generation.fileWriterPlanRef).toString()) as FileWriterPlan
  const plan = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const originalPlan = stage<SyncPartitionPlan>(store, operation, origin, 'partition-plan', 'automatic', readIndex?.(origin))
  if (filePlan.version !== 'sync-file-writers-v1' || filePlan.writers.length !== filePlan.traces.length || !originalPlan || new Set(filePlan.writers.map(writer => writer.partitionId)).size !== filePlan.writers.length) return null
  for (const [index, writer] of filePlan.writers.entries()) {
    const trace = filePlan.traces[index]
    if (!originalPlan.partitions.some(partition => partition.id === writer.partitionId) || trace.purpose !== 'implementation_plan' || writer.paths.some(path => isHostPrivatePath(path) || path.startsWith('.spec/') || /[*?\[\]]/.test(path) || !within(path, plan.writePaths) || plan.mandatoryTests.some(test => overlap(path, test.testPath)))) return null
    let proven = false
    for (const source of store.listAttempts(operation.id).filter(attempt => attempt.number <= origin.number && ['failed', 'superseded', 'settled'].includes(attempt.status))) {
      const checkpoints = readIndex?.(source)
      const proposal = stage<{ paths: string[]; trace: ElaborationTrace }>(store, operation, source, `partition:${writer.partitionId}:implementation-plan`, 'automatic', checkpoints)
      if (!proposal || canonical(proposal.paths) !== canonical(writer.paths) || canonical(proposal.trace) !== canonical(trace)) continue
      const key = `sync:${source.id}:generation:partition:${writer.partitionId}:implementation_plan`
      const dispatch = source.dispatchPlans.find(item => item.key === key && item.purpose === 'implementation_plan' && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
      if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) continue
      const resource = store.findResource(source.id, key)
      if (resource) {
        const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
        const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
        const output = checkpoint.result?.output as { version?: string; paths?: string[] } | undefined
        if (!output || output.version !== 'sync-implementation-plan-v1' || !Array.isArray(output.paths) || canonical([...output.paths].sort()) !== canonical(writer.paths) || Object.keys(output).sort().join(',') !== 'paths,version' || !matchesNativeDispatchModel(operation, dispatch, native.request) || native.request.effort !== 'high' || native.request.root !== operation.input.source.canonicalRoot || canonical(native.request.schema) !== canonical(IMPLEMENTATION_PLAN_SCHEMA) || !completedNativeStageResult(store, operation, source, native.request, trace, output, generation.candidate.digest, checkpoints)) continue
      } else {
        const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, source, `injected:${key}`, 'automatic', checkpoints), output = injected?.result.output as { version?: string; paths?: string[] } | undefined
        if (!injected || injected.requestDigest !== dispatch.requestDigest || injected.result.sessionId !== trace.sessionId || injected.result.threadId !== trace.threadId || injected.result.turnId !== trace.turnId || injected.result.resultDigest !== trace.resultDigest || contentHash(JSON.stringify(output)) !== trace.resultDigest || !output || output.version !== 'sync-implementation-plan-v1' || !Array.isArray(output.paths) || canonical([...output.paths].sort()) !== canonical(writer.paths) || Object.keys(output).sort().join(',') !== 'paths,version') continue
      }
      proven = true; break
    }
    if (!proven) return null
  }
  const paths = unique(filePlan.writers.flatMap(writer => writer.paths)), initial = p1.paths ?? generation.candidate.coveredScope.paths
  const expected = paths.some(path => !within(path, initial)) ? unique([...initial, ...paths]) : initial
  if (canonical(expected) !== canonical(operation.scope.paths) || canonical(p1.contractIds) !== canonical(operation.scope.contractIds) || canonical(p1.flowIds) !== canonical(operation.scope.flowIds)) return null
  return { p1, ...(paths.length ? { writerRef: generation.fileWriterPlanRef } : {}), paths }
}

/** 同一已审P1的null扩域可保原计划；旧wrapper/readSet/digest原样保留。 */
function reviewPlanStage(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: 'partition-plan' | 'candidate-partition-plan', basis?: 'analysis_only_p1' | 'inline_v1_repair', readIndex?: (source: SyncAttempt) => SyncCheckpointStageView): { result: SyncPartitionPlan; resultRef: BlobRef } | null {
  const checkpoints = readIndex?.(attempt)
  const exact = partitionStage<SyncPartitionPlan>(store, operation, attempt, key, undefined, checkpoints)
  if (exact) return exact
  const result = stage<SyncPartitionPlan>(store, operation, attempt, key, 'automatic', checkpoints)
  const approved = stage<SavedElaboration>(store, operation, attempt, 'elaboration', 'automatic', checkpoints)
  const generation = partitionStage<SavedGeneration>(store, operation, attempt, 'generation', undefined, checkpoints)?.result
  const verified = generation?.candidateValidated && generation.candidate && !generation.validationFindings.some(finding => finding.severity === 'error')
  const p1Basis = key === 'partition-plan' && (basis === 'inline_v1_repair' || basis === 'analysis_only_p1' && approved?.analysisOnlyPartitions?.length)
  if (!result || !approved?.structurePassed || !approved.reviewPassed || approved.failure || !verified && !p1Basis || !operation.baselineSelection || !attempt.composedInput || !elaborationComposedBinding(store, operation, attempt, approved, attempt.composedInput, checkpoints)) return null
  const commonDir = operation.input.source.commonDir, resultRef = writeEvidence(commonDir, result), approvedRef = writeEvidence(commonDir, approved)
  const wrappers = (checkpoints ?? readSyncCheckpoints(store, operation, attempt)).json.map(({ value }) => value as Stage)
  const wrapper = wrappers.find(saved => saved.version === 'sync-stage-v1' && saved.stage === key && saved.resultRef?.sha256 === resultRef.sha256)
  const seal = wrappers.find(saved => saved.version === 'sync-stage-v1' && saved.stage === 'elaboration' && saved.resultRef?.sha256 === approvedRef.sha256)
  if (!wrapper?.readSetDigest || !wrapper.baselineSelectionRef || wrapper.readSetDigest !== seal?.readSetDigest || wrapper.baselineSelectionRef.sha256 !== seal.baselineSelectionRef?.sha256) return null
  const before = JSON.parse(readEvidence(commonDir, wrapper.baselineSelectionRef).toString()) as FrozenBaselineSelection
  const after = operation.baselineSelection
  if (!extendsWithUninitializedResources(before, after)) return null
  const plan = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const p1 = p1Basis && plan.version === 'sync-coordinator-v2' && plan.direction === 'code_to_spec'
    ? operation.contractScopeExpansions?.find(expansion => expansion.evidenceRef.sha256 === approvedRef.sha256) : undefined
  const p1ScopeMatches = p1 && canonical(p1.paths) === canonical(operation.scope.paths) && canonical(p1.contractIds) === canonical(operation.scope.contractIds) && canonical(p1.flowIds) === canonical(operation.scope.flowIds)
  const proof = (verified ? reviewScopeProof(store, operation, attempt, approved, generation!, readIndex) : null) ?? (p1ScopeMatches ? { p1, paths: [], writerRef: undefined } : null)
  if (!proof) return null
  let selectedDigest = before.digest
  for (const expansion of operation.contractScopeExpansions ?? []) {
    if (expansion.previousBaselineSelectionDigest !== selectedDigest || expansion.baselineSelectionDigest === selectedDigest) continue
    if (expansion.evidenceRef.sha256 !== approvedRef.sha256 && expansion.evidenceRef.sha256 !== proof.writerRef?.sha256) return null
    if (expansion.evidenceRef.sha256 === proof.writerRef?.sha256 && (canonical(expansion.paths) !== canonical(operation.scope.paths) || canonical(expansion.contractIds) !== canonical(proof.p1.contractIds) || canonical(expansion.flowIds) !== canonical(proof.p1.flowIds))) return null
    selectedDigest = expansion.baselineSelectionDigest!
    if (selectedDigest === after.digest) break
  }
  if (selectedDigest !== after.digest) return null
  const expansion = proof.p1
  const original = stage<SyncPartitionPlan>(store, operation, attempt, 'partition-plan', 'automatic', checkpoints)
  if (!original || !approved.partitionEvidence?.length || approved.partitionEvidence.some(owner => (JSON.parse(readEvidence(commonDir, owner.resultRef).toString()) as SavedElaboration).partitionBinding?.planDigest !== original.digest)) return null
  const contracts = approved.changes.flatMap(change => parseContract(change).contract ?? [])
  const additions = after.bindings.filter(binding => !before.bindings.some(prior => baselineResourceKey(prior) === baselineResourceKey(binding)))
  const p1Paths = new Set([...approved.changes.map(change => change.path), ...p1WritableReferences(contracts, new Set(approved.changes.map(change => change.path)), plan)])
  if (additions.some(binding => {
    const resource = binding.resource
    return resource.kind === 'path'
      ? !(expansion.paths?.includes(resource.path) && p1Paths.has(resource.path) || proof.paths.includes(resource.path)) || !within(resource.path, plan.writePaths) || plan.mandatoryTests.some(test => overlap(resource.path, test.testPath))
      : !expansion[resource.kind === 'flow' ? 'flowIds' : 'contractIds'].includes(resource.id) || !contracts.some(contract => contract.items.some(item => item.id === resource.id && (resource.kind === 'flow') === (item.kind === 'FLOW')))
  })) return null
  return { result, resultRef }
}

function partitionElaborationStage(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, binding: NonNullable<ElaborationResult['partitionBinding']>, inputDigest: string): { result: SavedElaboration; resultRef: BlobRef } | null {
  const source = partitionStage<SavedElaboration>(store, operation, attempt, key)
  return source && source.result.inputDigest === inputDigest && canonical(source.result.partitionBinding) === canonical(binding) ? source : null
}

/** 跨正式重试的批准仍属于原模型、Git生成和独立只读审查。 */
function authenticatedApprovedElaboration(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, result: SavedElaboration, options: { reviewInSourceAttempt?: boolean; allowDeferredImplementation?: boolean } = {}): boolean {
  const round = result.rounds.at(-1), review = round?.traces.find(trace => trace.purpose === 'elaboration_review')
  if (!round?.draft || !round.candidate || !review || round.traces.length !== 2 || !hasApprovedElaborationReview(result) || !options.allowDeferredImplementation && round.review?.verdict !== 'accept'
    || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || round.candidateDigest !== result.candidateDigest
    || canonical(round.review) !== canonical({ ...(round.reviewOutput as object), inputDigest: result.inputDigest, candidateDigest: result.candidateDigest })
    || ELABORATION_BOUNDARIES.some(boundary => !round.review!.checkedBoundaries.includes(boundary))) return false
  const reviewed = store.listAttempts(owner.id).filter(attempt => attempt.number <= prior.number).find(attempt => attempt.dispatchPlans.some(dispatch => dispatch.purpose === review.purpose && canonical(dispatch.session) === canonical({ sessionId: review.sessionId, threadId: review.threadId, turnId: review.turnId })))
  if (options.reviewInSourceAttempt && reviewed?.id !== prior.id) return false
  if (!reviewed && owner.retryOf && result.partitionBinding && result.rounds.some(item => item.crossFreezeAuthor)) {
    const key = `partition:${result.partitionBinding.partitionId}:elaboration`
    const local = partitionStage<SavedElaboration>(store, owner, prior, key)
    const provenance = partitionStage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, owner, prior, key + ':provenance')?.result
    if (!provenance || local?.resultRef.sha256 !== provenance.resultRef.sha256 || local.resultRef.sha256 !== contentHash(JSON.stringify(result))) return false
    for (const originalOwner of crossFreezeRetryOwners(store, owner)) {
      if (originalOwner.id === owner.id || originalOwner.id !== provenance.fromOperationId) continue
      const origin = store.listAttempts(originalOwner.id).find(item => item.id === provenance.fromAttemptId)
      if (!origin || !['failed', 'superseded', 'settled'].includes(origin.status) || canonical(origin.composedInput) !== canonical(prior.composedInput)) return false
      const original = partitionStage<SavedElaboration>(store, originalOwner, origin, key)
      return original?.resultRef.sha256 === local.resultRef.sha256 && authenticatedApprovedElaboration(store, originalOwner, origin, original.result, options)
    }
    return false
  }
  const generation = elaborationGenerationSource(store, owner, prior, round, result)
  const dispatch = reviewed?.dispatchPlans.find(dispatch => dispatch.purpose === review.purpose && dispatch.session?.sessionId === review.sessionId)
  const source = reviewed && dispatch ? authenticatedDraftResult(store, owner, reviewed, dispatch.key, review.purpose) : null
  if (!generation?.request || !source?.request || !source.result || source.request.inputDigest !== review.inputDigest || source.result.resultDigest !== review.resultDigest || canonical(source.result.output) !== canonical(round.reviewOutput)
    || round.traces.some(trace => trace.purpose === 'elaboration_generate' && (trace.sessionId === review.sessionId || trace.threadId === review.threadId))) return false
  if (result.rounds.some(item => item.crossFreezeAuthor) && (!store.findResource(reviewed!.id, dispatch!.key)
    || !completedNativeStageResult(store, owner, reviewed!, source.request, review, round.reviewOutput, round.candidateDigest!, undefined, readRecord))) return false
  for (const request of [generation.request, source.request]) {
    const inputDigest = request.purpose === 'elaboration_generate' ? round.crossFreezeAuthor?.oldInputDigest ?? result.inputDigest : result.inputDigest
    const expected = elaborationNativeInputDigest(inputDigest, request)
    const origin = request.purpose === 'elaboration_generate' ? generation.attempt : reviewed!
    const nativeOwner = request.purpose === 'elaboration_generate' ? generation.owner : owner
    if (!matchesAttemptNativeModel(nativeOwner, origin, request) || request.root !== owner.input.source.canonicalRoot || request.frozenContext || !request.worktree || request.base !== request.worktree.baseCommit
      || request.worktree.mode !== (request.purpose === 'elaboration_generate' ? 'edit' : 'read') || request.inputDigest !== expected
      || !request.requestKey.startsWith(`sync:${origin.id}:elaborate:partition:${result.partitionBinding!.partitionId}:`)) return false
  }
  return true
}

/** 复制的局部批准只能沿同一原件回到实际Native派发。 */
type ApprovedElaborationOrigin = NonNullable<ReturnType<typeof elaborationGenerationSource>> & { ownerId: string; approvalAttempt: SyncAttempt }
function elaborationDraftGenerationSource(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, key: string, source: { result: SavedElaboration; resultRef: BlobRef }, round: ElaborationResult['rounds'][number], sources: ReturnType<typeof retryDraftSources>, readCheckpoints: (owner: SyncOperation, prior: SyncAttempt) => SyncCheckpointStageView, basis?: { selection: FrozenBaselineSelection; recomposed: boolean; rebase?: (owner: SyncOperation, attempt: SyncAttempt, source: NonNullable<ReturnType<typeof readonlyLocalSource>>) => ApprovedElaborationOrigin | null }): ApprovedElaborationOrigin | null {
  const { result, resultRef } = source, binding = result.partitionBinding
  const direct = elaborationGenerationSource(store, owner, prior, round, result)
  if (direct) return { ...direct, ownerId: owner.id, approvalAttempt: prior }
  if (!binding || key !== 'partition:' + binding.partitionId + ':elaboration' || !result.structurePassed || !result.reviewPassed || result.failure || round !== result.rounds.at(-1)) return null
  let index = sources.findIndex(item => item.owner.id === owner.id && item.prior.id === prior.id)
  if (index < 0) return null
  let planRef: string | undefined, composition = prior.composedInput, recomposed = basis?.recomposed ?? false
  const selected = basis?.selection.digest ?? prior.baselineSelectionDigest
  for (;;) {
    const origin = sources[index], checkpoints = readCheckpoints(origin.owner, origin.prior)
    const plan = partitionStage<SyncPartitionPlan>(store, origin.owner, origin.prior, 'partition-plan', basis?.selection, checkpoints)
    const saved = partitionStage<SavedElaboration>(store, origin.owner, origin.prior, key, basis?.selection, checkpoints)
    const expandedSource = recomposed && origin.prior.id === prior.id
    const composed = origin.prior.composedInput
    const matches = expandedSource || (recomposed ? composedBeforeNullExpansionMatches(composed, composition, selected) : canonical(composed) === canonical(composition))
    if (!saved && basis?.rebase && origin.owner.id === owner.id && origin.prior.number < prior.number) {
      const local = stage<SavedElaboration>(store, origin.owner, origin.prior, key, 'evidence', checkpoints)
      const wrapper = checkpoints.json.map(({ value }) => value as Stage).find(value => value.stage === key && value.resultRef?.sha256 === resultRef.sha256)
      const originalPlan = stage<SyncPartitionPlan>(store, origin.owner, origin.prior, 'partition-plan', 'evidence', checkpoints)
      if (local && wrapper?.readSetDigest && wrapper.baselineSelectionRef && contentHash(JSON.stringify(local)) === resultRef.sha256
        && originalPlan?.digest === binding.planDigest && (!planRef || contentHash(JSON.stringify(originalPlan)) === planRef)) {
        const originalSelection = JSON.parse(readEvidence(owner.input.source.commonDir, wrapper.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
        if ((wrapper.readSetDigest !== origin.owner.readSetDigest || originalSelection.digest !== basis.selection.digest)
          && (canonical(composed) === canonical(composition) || composedBeforeNullExpansionMatches(composed, composition, originalSelection.digest))) {
          return basis.rebase(origin.owner, origin.prior, { result: local, resultRef, wrapper })
        }
      }
    }
    if (plan?.result.digest !== binding.planDigest || planRef && plan.resultRef.sha256 !== planRef || saved?.resultRef.sha256 !== resultRef.sha256
      || !matches || !expandedSource && origin.prior.baselineSelectionDigest !== selected
      || origin.owner.id !== owner.id && !settledApprovalSource(store, origin.owner)) return null
    if (!expandedSource) { composition = composed; recomposed = false }
    planRef = plan.resultRef.sha256
    const provenance = partitionStage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, origin.owner, origin.prior, key + ':provenance', basis?.selection, checkpoints)
    if (!provenance) {
      if (!authenticatedApprovedElaboration(store, origin.owner, origin.prior, result, { reviewInSourceAttempt: true })) return null
      const generation = elaborationGenerationSource(store, origin.owner, origin.prior, round, result)
      return generation && { ...generation, ownerId: origin.owner.id, approvalAttempt: origin.prior }
    }
    const next = sources.findIndex(item => item.owner.id === provenance.result.fromOperationId && item.prior.id === provenance.result.fromAttemptId)
    if (provenance.result.resultRef.sha256 !== resultRef.sha256 || next <= index) return null
    index = next
  }
}

/** 原source协议只沿同原件provenance读取，当前attempt的新tag不能给legacy补签。 */
function elaborationDraftTagged(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, result: SavedElaboration): boolean {
  const resultDigest = writeEvidence(operation.input.source.commonDir, result).sha256
  for (;;) {
    const provenance = stage<{ fromOperationId?: string; fromAttemptId: string; resultRef?: BlobRef; evidenceRef?: BlobRef }>(store, operation, attempt, key === 'elaboration' ? 'elaboration-provenance' : `${key}:provenance`)
    if (!provenance || (provenance.resultRef ?? provenance.evidenceRef)?.sha256 !== resultDigest) break
    operation = provenance.fromOperationId ? store.readOperation(provenance.fromOperationId) : operation
    attempt = store.readAttempt(provenance.fromAttemptId)
  }
  return stage<{ version: string }>(store, operation, attempt, 'elaboration-draft-protocol')?.version === 'elaboration-draft-v1'
}

/** 一次来源核验共享同一历史快照；只保留认证后的wrapper和对应的批准依据。 */
function readonlyElaborationHistory(store: SyncStore, operation: SyncOperation, readIndex = (attempt: SyncAttempt) => readSyncCheckpointStageIndex(store, operation, attempt)) {
  const attempts = store.listAttempts(operation.id), commonDir = operation.input.source.commonDir
  const indexes = new Map<string, SyncCheckpointStageView>(), selections = new Map<string, boolean>()
  const checkpoints = (attempt: SyncAttempt, owner = operation): SyncCheckpointStageView => {
    if (!indexes.has(attempt.id)) indexes.set(attempt.id, owner.id === operation.id ? readIndex(attempt) : readStageCheckpoints(store, owner, attempt, true))
    return indexes.get(attempt.id)!
  }
  const retrySources = new Map<string, ReturnType<typeof retryDraftSources>>()
  const inheritedSources = (owner: SyncOperation, attempt: SyncAttempt, selection: FrozenBaselineSelection) => {
    const key = JSON.stringify([owner.readSetDigest, selection.digest, attempt.number])
    if (!retrySources.has(key)) retrySources.set(key, retryDraftSources(store, owner, attempt.number + 1, selection))
    return retrySources.get(key)!
  }
  const matchesSelection = (wrapper: Stage): boolean => {
    const key = JSON.stringify({ readSetDigest: wrapper.readSetDigest, selectionRef: wrapper.baselineSelectionRef?.sha256 })
    if (!selections.has(key)) selections.set(key, stageSelectionMatches(store, operation, wrapper))
    return selections.get(key)!
  }
  const read = <T>(attempt: SyncAttempt, key: string): T | null => stage<T>(store, operation, attempt, key, 'automatic', checkpoints(attempt), matchesSelection)
  const binding = (ref: BlobRef, wrapper: Stage): string => JSON.stringify({ ownerRef: ref.sha256, readSetDigest: wrapper.readSetDigest, selectionRef: wrapper.baselineSelectionRef?.sha256 })
  const approvals = new Set<string>()
  let scannedApprovals = 0
  const approved = (ref: BlobRef, wrapper: Stage): boolean => {
    const key = binding(ref, wrapper)
    while (!approvals.has(key) && scannedApprovals < attempts.length) {
      const attempt = attempts[scannedApprovals++]
      const aggregate = read<SavedElaboration>(attempt, 'elaboration')
      if (!aggregate?.structurePassed || !aggregate.reviewPassed || !aggregate.partitionEvidence?.length) continue
      const aggregateRef = writeEvidence(commonDir, aggregate)
      for (const { value } of checkpoints(attempt).json) {
        const saved = value as Stage
        if (saved.stage !== 'elaboration' || saved.resultRef?.sha256 !== aggregateRef.sha256) continue
        for (const owner of aggregate.partitionEvidence) approvals.add(binding(owner.resultRef, saved))
      }
    }
    return approvals.has(key)
  }
  const approvedOwners = new Map<string, Set<string>>()
  const belongsTo = (ref: BlobRef, aggregateRef: BlobRef): boolean => {
    if (!approvedOwners.has(aggregateRef.sha256)) {
      const aggregate = JSON.parse(readEvidence(commonDir, aggregateRef).toString('utf8')) as SavedElaboration
      approvedOwners.set(aggregateRef.sha256, new Set(aggregate.structurePassed && aggregate.reviewPassed ? aggregate.partitionEvidence?.map(owner => owner.resultRef.sha256) : []))
    }
    return approvedOwners.get(aggregateRef.sha256)!.has(ref.sha256)
  }
  return { attempts, checkpoints, inheritedSources, read, approved, belongsTo }
}

/** null资源扩展沿原aggregate门禁；owner仍须逐字绑定其当时批准的同一readSet/selection。 */
function readonlyLocalSource(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, resultRef: BlobRef, aggregateRef: BlobRef, history: ReturnType<typeof readonlyElaborationHistory>): { result: SavedElaboration; resultRef: BlobRef; wrapper: Stage } | null {
  const result = history.read<SavedElaboration>(attempt, key), commonDir = operation.input.source.commonDir
  if (!result || writeEvidence(commonDir, result).sha256 !== resultRef.sha256) return null
  if (!history.belongsTo(resultRef, aggregateRef)) fail('readonly_spec_repair_binding', '只读owner原件不属于精确选择的已审aggregate')
  const checkpoints = history.checkpoints(attempt)
  const wrapper = checkpoints.json.map(({ value }) => value as Stage).find(value => value.stage === key && value.resultRef?.sha256 === resultRef.sha256)
  if (wrapper?.readSetDigest && history.approved(resultRef, wrapper)) return { result, resultRef, wrapper }
  // 失败的续修可以已复制兄弟结果，但复制所在的 readSet 不产生新的全树批准。
  const copied = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, operation, attempt, `${key}:provenance`, 'evidence', checkpoints)
  const origin = copied?.fromOperationId === operation.id && copied.resultRef.sha256 === resultRef.sha256
    ? history.attempts.find(item => item.id === copied.fromAttemptId && item.number < attempt.number && ['failed', 'superseded', 'settled'].includes(item.status)) : undefined
  const original = origin && canonical(origin.composedInput) === canonical(attempt.composedInput) ? history.read<SavedElaboration>(origin, key) : null
  if (original && writeEvidence(commonDir, original).sha256 === resultRef.sha256) return null
  fail('readonly_spec_repair_binding', '只读owner与精确已审aggregate的原readSet/selection不一致')
}

function readonlyReviewFindings(result: SavedGeneration, changes: SavedElaboration['changes'], writable: readonly string[]): ContractFinding[] {
  const contracts = changes.flatMap(change => parseContract(change).contract ?? []), items = contracts.flatMap(contract => contract.items)
  return (result.partitionEvidence ?? []).filter(evidence => evidence.review.verdict === 'repair').flatMap(evidence => evidence.review.findings).flatMap<ContractFinding>(finding => {
    const omission = finding.ruleLocation.startsWith('contract-omission:')
    if (omission && !contractOmissionBound(finding, contracts)) fail('readonly_spec_repair_binding', '契约遗漏未绑定同一已审owner及既有身份')
    const location = finding.ruleLocation.replace(/^contract(?:-omission)?:/, '')
    const prose = changes.filter(change => location.startsWith(`${change.path} — expanded spec `) && location.slice(`${change.path} — expanded spec `.length).trim())
    if (prose.length) {
      const target = prose[0]
      if (within(target.path, writable)) return []
      if (finding.kind !== 'repair' || prose.length !== 1 || !finding.affectedIds.length || finding.affectedIds.some(id => {
        const matches = items.filter(item => item.id === id)
        return matches.length !== 1 || matches[0].nodeId !== target.nodeId || matches[0].path !== target.path
      })) fail('readonly_spec_repair_binding', '只读正文诊断必须以实际候选路径及全部唯一同owner affectedIds绑定')
      return [{ code: 'candidate-review-repair', severity: 'error', nodeId: target.nodeId, path: target.path, relatedIds: finding.affectedIds, message: JSON.stringify(finding) }]
    }
    const [path, id, extra] = location.split('#'), matches = items.filter(item => item.path === path && item.id === id)
    if (within(path, writable)) return []
    if (finding.kind !== 'repair' || extra !== undefined || matches.length !== 1 || !finding.affectedIds.length || new Set(finding.affectedIds).size !== finding.affectedIds.length || finding.affectedIds.some(id => items.filter(item => item.id === id).length !== 1)) fail('readonly_spec_repair_binding', '只读独审诊断必须以实际候选路径/ID及affectedIds绑定唯一契约')
    return [{ code: omission ? 'candidate-review-contract-omission' : 'candidate-review-repair', severity: 'error', nodeId: matches[0].nodeId, path, itemId: id, relatedIds: finding.affectedIds, message: JSON.stringify(finding) }]
  })
}

type AcceptedReviewProvenance = { fromOperationId: string; fromAttemptId: string; resultRef: BlobRef; inputRef: BlobRef }
function acceptedReviewInput(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, resultRef: BlobRef, checkpoints?: SyncCheckpointStageView): GenerationInput | null {
  const provenance = partitionStage<AcceptedReviewProvenance>(store, operation, attempt, `${key}:provenance`, undefined, checkpoints)?.result
  if (!provenance || provenance.fromOperationId !== operation.id && provenance.fromOperationId !== reviewHandoffParent(store, operation)?.id || provenance.resultRef.sha256 !== resultRef.sha256 || !provenance.inputRef) return null
  const value = JSON.parse(readEvidence(operation.input.source.commonDir, provenance.inputRef).toString()) as ReturnType<typeof freezeGenerationInput>['inputEvidence']
  const requestKey = `sync:${attempt.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}`
  if (value.requestKey !== requestKey || value.snapshot.id !== operation.input.id || value.policy.digest !== operation.policyDigest) return null
  return restoreGenerationInput(value)
}

/** 原Native传输冻结由同一adapter接缝重建；缺席policy不追补，正文/schema/seed逐字核验。 */
export function nativeReviewRequestMatches(native: NativeRunPlan['request'], supplied: ElaborationSessionRequest, binding: { attemptId: string; policyDigest: string }): boolean {
  const { signal: _signal, ...value } = supplied
  const expected = pinSyncNativeRequest(value, native)
  structuredExecutionPolicy(native)
  if (!native.frozenContext) return canonical(native) === canonical(expected)
  assertFrozenBinding(native.frozenContext, { requestKey: expected.requestKey, inputDigest: expected.inputDigest, ...binding })
  const manifest = readFrozenManifest(native.frozenContext), task = manifest.entries[0]
  if (manifest.entries.length !== 1 || task.id !== 'task' || task.kind !== 'utf8' || !task.required || task.sha256 !== contentHash(expected.prompt) || task.byteLength !== Buffer.byteLength(expected.prompt)) return false
  readFrozenRange(native.frozenContext, { contextDigest: native.frozenContext.contextDigest, entryId: 'task', startByte: 0, endByte: 1 })
  const { frozenContext: _context, readerRuntime: _runtime, prompt: _prompt, ...transport } = native
  const { prompt: _expectedPrompt, ...parameters } = expected
  return canonical(transport) === canonical(parameters)
}

/** 冷验只取本次真实派发的模型；缺少派发的来源不能以当前组选路冒充。 */
function matchesAttemptNativeModel(operation: SyncOperation, attempt: SyncAttempt, request: ElaborationSessionRequest): boolean {
  const dispatch = attempt.dispatchPlans.find(item => item.key === request.requestKey && item.purpose === request.purpose)
  return !!dispatch && matchesNativeDispatchModel(operation, dispatch, request)
}

function matchesScheduledNativeReview(operation: SyncOperation, origin: SyncAttempt, dispatch: SyncAttempt['dispatchPlans'][number], native: NativeRunPlan['request'], request: ElaborationSessionRequest): boolean {
  if (dispatch.managedModel !== undefined && !matchesNativeDispatchModel(operation, dispatch, native)) return false
  const expected = dispatch.managedModel === undefined ? request : { ...request, model: dispatch.managedModel }
  return nativeReviewRequestMatches(native, expected, { attemptId: origin.id, policyDigest: operation.policyDigest })
}

/** 成功的builder与review共用原正式派发/Native结果冷验，不制造当前调用。 */
function completedNativeStageResult(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, request: ElaborationSessionRequest, trace: ElaborationTrace, output: unknown, candidateDigest: string, checkpoints?: SyncCheckpointStageView, readCompletedRecord?: (id: string) => NativeRunRecord | null): ElaborationSessionResult | null {
  const key = request.requestKey, commonDir = operation.input.source.commonDir
  const dispatch = origin.dispatchPlans.find(item => item.key === key && item.purpose === request.purpose && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
  if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || trace.purpose !== request.purpose || trace.inputDigest !== request.inputDigest || trace.resultDigest !== contentHash(JSON.stringify(output))) return null
  const { signal: _signal, ...payload } = request
  const resource = store.findResource(origin.id, key)
  if (!resource) {
    const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, origin, `injected:${key}`, 'automatic', checkpoints)
    return injected && injected.requestDigest === dispatch.requestDigest && contentHash(JSON.stringify(payload)) === dispatch.requestDigest && injected.result.sessionId === trace.sessionId && injected.result.threadId === trace.threadId && injected.result.turnId === trace.turnId && injected.result.resultDigest === trace.resultDigest && canonical(injected.result.output) === canonical(output) ? injected.result : null
  }
  const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  const inline = !request.worktree && inlineV1RepairScope(operation) && (request.purpose.startsWith('code_behavior_') || request.purpose.startsWith('elaboration_'))
  if (resource.operationId !== operation.id || resource.attemptId !== origin.id || resource.plan.kind !== 'native_session' || resource.plan.key !== key || resource.plan.inputId !== operation.input.id || resource.phase !== 'removed' || native.schemaVersion !== 1 || native.operationId !== operation.id || native.attemptId !== origin.id || native.inputId !== operation.input.id || native.candidateDigest !== resource.plan.candidateDigest || native.candidateDigest !== null && native.candidateDigest !== candidateDigest || checkpoint.operationId !== operation.id || checkpoint.attemptId !== origin.id || checkpoint.inputId !== operation.input.id || checkpoint.candidateDigest !== native.candidateDigest || checkpoint.expectedSessionId !== trace.sessionId || canonical(checkpoint.session) !== canonical(dispatch.session) || native.requestDigest !== dispatch.requestDigest || resource.plan.payloadDigest !== dispatch.requestDigest || contentHash(JSON.stringify(native.request)) !== dispatch.requestDigest || native.sessionCreateKey !== dispatch.sessionCreateKey || native.expectedSessionId !== trace.sessionId || native.request.requestKey !== key || native.request.inputDigest !== request.inputDigest || native.request.purpose !== request.purpose || checkpoint.status !== 'completed' || checkpoint.phase !== 'removed' || checkpoint.requestDigest !== dispatch.requestDigest || checkpoint.result?.resultDigest !== trace.resultDigest || checkpoint.result.sessionId !== trace.sessionId || checkpoint.result.threadId !== trace.threadId || checkpoint.result.turnId !== trace.turnId || canonical(checkpoint.result.output) !== canonical(output) || !(inline ? canonical(native.request) === canonical(request) : matchesScheduledNativeReview(operation, origin, dispatch, native.request, request))) return null
  if (inline && native.request.frozenContext) {
    const proof = checkpoint.result.frozenReadProof
    if (!proof) return null
    assertFrozenBinding(native.request.frozenContext, { requestKey: key, inputDigest: request.inputDigest, attemptId: origin.id, policyDigest: operation.policyDigest })
    verifyStructuredFrozenReadProof(native.request.frozenContext, proof, { threadId: trace.threadId, turnId: trace.turnId }, native.request.readerRuntime?.version === 2 ? native.request.readerRuntime.toolOutputTokenLimit : undefined, { output })
  }
  const scope = frozenAnalysisScope.getStore(), reader = readCompletedRecord ?? (scope?.active ? scope.readNativeRecord ?? (inline ? readRecord : undefined) : undefined)
  if (reader) {
    const record = reader(native.expectedSessionId), state = record?.structuredExecution, execution = structuredExecutionPolicy(native.request)
    const prompt = native.request.worktree ? nativeWorktreePrompt(native.request.prompt, native.request.worktree) : native.request.prompt, base = native.request.worktree?.baseCommit ?? native.request.base
    if (readCompletedRecord && (checkpoint.schemaVersion !== 1 || !checkpoint.nativeCallRequested || !checkpoint.nativeStarted
      || state?.version !== execution.version || state.policy !== execution.policy)) return null
    if (!record || !state || inline && canonical(state.frozenReadProof) !== canonical(checkpoint.result.frozenReadProof) || resource.generation !== origin.generation || checkpoint.nativeState !== 'completed' || checkpoint.failure || record.session !== native.expectedSessionId
      || record.createRequestId !== contentHash(native.sessionCreateKey) || record.createPayloadHash !== contentHash(JSON.stringify({ prompt, parent: null, launcher: null, ...(base?.trim() ? { base: base.trim() } : {}), structuredExecution: execution }))
      || canonical(structuredExecutionPolicy(state)) !== canonical(execution) || state.state !== 'completed' || state.threadId !== trace.threadId || state.turnId !== trace.turnId
      || record.harnessSessionId !== trace.threadId || state.resultDigest !== trace.resultDigest || canonical(state.output) !== canonical(output) || canonical(state.resultWorktree) !== canonical(checkpoint.result.worktree)) return null
  }
  return checkpoint.result
}

type BehaviorTaskRequest = CodeBehaviorMaterialRequest & Pick<ElaborationSessionRequest, 'inputDigest' | 'purpose'>

function behaviorMaterialTask(request: BehaviorTaskRequest, commonDir: string) {
  const { task, pendingAnalysis } = readCodeBehaviorContext(request, commonDir)
  const { repairDiagnostics: _diagnostics, postGateReview: _postGate, postGateReviewPolicy: _postGatePolicy, ...context } = task
  return { instructions: request.prompt.split('\n任务:\n')[0], body: canonical({ context, review: pendingAnalysis === undefined ? null : JSON.stringify(pendingAnalysis) }) }
}

/** 续修只接受当前完整指令或由当前冻结分区推导的旧事实说明前缀。 */
export function behaviorMaterialTaskMatches(original: BehaviorTaskRequest, current: BehaviorTaskRequest, commonDir: string): boolean {
  const previous = behaviorMaterialTask(original, commonDir), expected = behaviorMaterialTask(current, commonDir)
  return previous.body === expected.body && (previous.instructions === expected.instructions || previous.instructions === current.previousInstructions)
}

type BehaviorContinuationProvenance = { fromOperationId: string; fromAttemptId: string; resultRef: BlobRef; scopeDigest?: string }

function* behaviorContinuationLineage(store: SyncStore, operation: SyncOperation, scopeDigest: string, stageSelection?: FrozenBaselineSelection): Generator<SyncOperation> {
  const selection = stageSelection ?? store.readBusinessBaselineSelection(operation.id)
  for (const ancestor of retryOperationLineage(store, operation)) {
    if (ancestor.id === operation.id) continue
    if (!operation.planBlob || ancestor.planBlob?.sha256 !== operation.planBlob.sha256 || ancestor.impactDigest !== operation.impactDigest
      || ancestor.readSetDigest !== operation.readSetDigest || contentHash(canonical(ancestor.scope)) !== scopeDigest
      || canonical(ancestor.input) !== canonical(operation.input) || canonical(store.readBusinessBaselineSelection(ancestor.id)) !== canonical(selection)
      || !settledApprovalSource(store, ancestor)) return
    yield ancestor
  }
}

function previousBehaviorContinuation(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, selection?: FrozenBaselineSelection, readCheckpoints?: (attempt: SyncAttempt) => SyncCheckpointStageView) {
  const provenance = stage<BehaviorContinuationProvenance>(store, operation, origin, `${key}:continuation-provenance`, 'automatic', readCheckpoints?.(origin))
  if (!provenance) return null
  const crossOperation = provenance.fromOperationId !== operation.id
  let owner: SyncOperation | undefined = crossOperation ? undefined : operation
  if (crossOperation && provenance.scopeDigest) for (const ancestor of behaviorContinuationLineage(store, operation, provenance.scopeDigest, selection)) {
    if (ancestor.id === provenance.fromOperationId) { owner = ancestor; break }
  }
  if (!owner) return null
  const attempt = store.readAttempt(provenance.fromAttemptId)
  if (attempt.operationId !== owner.id || (!crossOperation && attempt.number >= origin.number) || !['failed', 'superseded', 'settled'].includes(attempt.status)) return null
  const source = partitionStage<CodeBehaviorContinuation>(store, owner, attempt, `${key}:continuation`, selection, readCheckpoints?.(attempt))
  if (!source || source.resultRef.sha256 !== provenance.resultRef.sha256) return null
  if (crossOperation) {
    const plan = key === 'analysis' ? null : partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan', selection, readCheckpoints?.(origin))
    if (key !== 'analysis' && (!plan || partitionStage<SyncPartitionPlan>(store, owner, attempt, 'partition-plan', selection, readCheckpoints?.(attempt))?.resultRef.sha256 !== plan.resultRef.sha256)) return null
    if (canonical(attempt.composedInput) !== canonical(origin.composedInput) || provenance.scopeDigest !== contentHash(canonical(operation.scope))) {
      const expanded = store.readOperation(operation.id)
      const after = expanded.baselineSelection
      if (!selection || !after || selection.digest === after.digest || origin.composedInput?.baselineSelectionDigest !== after.digest
        || !composedBeforeNullExpansionMatches(attempt.composedInput, origin.composedInput, selection.digest)
        || !plan || reviewPlanStage(store, expanded, origin, 'partition-plan', 'analysis_only_p1', readCheckpoints)?.resultRef.sha256 !== plan.resultRef.sha256) return null
    }
  }
  return { owner, attempt, continuation: source.result }
}

/** 续审analysis沿精确原件provenance回到实际Native提交；不借任意历史session授予已校验资格。 */
function behaviorTraceBinding(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, trace: ElaborationTrace, sourceSelection?: FrozenBaselineSelection, readCheckpoints?: (attempt: SyncAttempt) => SyncCheckpointStageView, bindModel = false, nativeOnly = false, readCompletedRecord?: (id: string) => NativeRunRecord | null): boolean {
  for (;;) {
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
    if (trace.purpose !== 'code_behavior_analyze' && trace.purpose !== 'code_behavior_review') return false
    const source = partitionStage<CodeBehaviorContinuation>(store, operation, origin, `${key}:continuation`, sourceSelection, readCheckpoints?.(origin)), ready = trace.purpose === 'code_behavior_analyze' ? source?.result.readyAnalysis : source?.result.reviewResult, draft = source?.result.drafts[trace.purpose]
    if (!ready || !draft || canonical(ready.trace) !== canonical(trace) || ready.draftOid !== draft.oid || ready.resultCommit !== draft.resultCommit || draft.sourceInputId !== operation.input.id) return false
    if (dispatch) {
      const request = JSON.parse(readEvidence(operation.input.source.commonDir, ready.requestRef).toString()) as ElaborationSessionRequest
      const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
      if (request.requestKey !== `sync:${origin.id}:analysis${suffix}:${trace.purpose}` || source!.result.inputDigest !== trace.inputDigest || bindModel && request.model !== syncModel(operation) || nativeOnly && !store.findResource(origin.id, request.requestKey)) return false
      const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId: key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length), purpose: trace.purpose }))
      readStageDraft(operation.input.source.commonDir, draft, { ownerDigest, sourceInputId: operation.input.id, schemaDigest: draft.schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
      const result = completedNativeStageResult(store, operation, origin, request, trace, ready.receipt, '', readCheckpoints?.(origin), readCompletedRecord)
      return !!result?.worktree && canonical({ baseCommit: result.worktree.baseCommit, tree: result.worktree.baseTree, mode: 'edit' }) === canonical(draft.seed) && result.worktree.headCommit === draft.resultCommit && result.worktree.tree === draft.resultTree
    }
    if (trace.purpose !== 'code_behavior_analyze') return false
    const previous = previousBehaviorContinuation(store, operation, origin, key, sourceSelection, readCheckpoints)
    if (!previous || canonical(previous.continuation.readyAnalysis) !== canonical(ready) || previous.continuation.inputDigest !== source!.result.inputDigest) return false
    if (previous.owner.id !== operation.id) {
      const originalDraft = previous.continuation.drafts.code_behavior_analyze
      if (!originalDraft || canonical(codeBehaviorDraftStatus(originalDraft)) !== canonical(codeBehaviorDraftStatus(draft))) return false
      bindModel = true
    }
    operation = previous.owner; origin = previous.attempt
  }
}

/** 业务repair清除ready后，原分析稿仍沿精确continuation来源认证；不继承祖先的推进状态。 */
function behaviorAnalysisDraftBinding(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, draft: ElaborationDraft, planDigest?: string, statusOnly = false): boolean {
  const partitionId = key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length)
  const suffix = partitionId === null ? '' : `:partition:${partitionId}`
  let bindModel = false
  for (;;) {
    const source = partitionStage<CodeBehaviorContinuation>(store, operation, origin, `${key}:continuation`)
    const saved = source?.result.drafts.code_behavior_analyze
    if (!source || !saved || canonical(statusOnly ? codeBehaviorDraftStatus(saved) : saved) !== canonical(statusOnly ? codeBehaviorDraftStatus(draft) : draft) || draft.sourceInputId !== operation.input.id || stage<{ version: string }>(store, operation, origin, 'behavior-draft-protocol')?.version !== 'code-behavior-draft-v1') return false
    if (planDigest && partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan')?.result.digest !== planDigest) return false
    const requestKey = `sync:${origin.id}:analysis${suffix}:code_behavior_analyze`
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.key === requestKey && dispatch.purpose === 'code_behavior_analyze')
    const trace = source.result.readyAnalysis?.trace
    if (dispatch && (trace || !source.result.reviewDiagnosticRef)) {
      return !!trace && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId && behaviorTraceBinding(store, operation, origin, key, trace, undefined, undefined, bindModel)
    }
    if (dispatch) {
      const author = authenticatedDraftResult(store, operation, origin, requestKey, 'code_behavior_analyze', saved)
      if (author?.result && author.request?.inputDigest === source.result.inputDigest && matchesNativeDispatchModel(operation, dispatch, author.request)) {
        const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId, purpose: 'code_behavior_analyze' }))
        readStageDraft(operation.input.source.commonDir, saved, { ownerDigest, sourceInputId: operation.input.id, schemaDigest: saved.schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
        return true
      }
    }
    const previous = previousBehaviorContinuation(store, operation, origin, key)
    if (!previous || previous.continuation.inputDigest !== source.result.inputDigest
      || previous.owner.id === operation.id && canonical(previous.attempt.composedInput) !== canonical(origin.composedInput)) return false
    if (previous.owner.id !== operation.id) bindModel = true
    operation = previous.owner; origin = previous.attempt
  }
}

/** 无新 Git 稿的中断继续持有上一份已认证复审稿。 */
function carriedChallengeReviewDraft(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, continuation: CodeBehaviorContinuation, draft: ElaborationDraft): boolean {
  const partitionId = key.slice('partition:'.length, -':analysis'.length)
  for (;;) {
    const previous = previousBehaviorContinuation(store, operation, origin, key)
    const original = previous?.continuation.drafts.code_behavior_review
    if (!previous || !original || previous.continuation.reviewDiagnosticRef?.sha256 !== continuation.reviewDiagnosticRef?.sha256
      || previous.continuation.inputDigest !== continuation.inputDigest || canonical(previous.attempt.composedInput) !== canonical(origin.composedInput)
      || canonical(codeBehaviorDraftStatus(original)) !== canonical(codeBehaviorDraftStatus(draft))) return false
    const requestKey = `sync:${previous.attempt.id}:analysis:partition:${partitionId}:code_behavior_review`
    if (authenticatedDraftResult(store, previous.owner, previous.attempt, requestKey, 'code_behavior_review', original)) return true
    operation = previous.owner; origin = previous.attempt
  }
}

/** 续审不伪造prepared记录；沿既有计划provenance回到真实builder所在attempt。 */
function generationBuilderSource(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan): { attempt: SyncAttempt; result: SavedGeneration } {
  for (;;) {
    const source = partitionStage<SavedGeneration>(store, operation, origin, key)
    if (source) return { attempt: origin, result: source.result }
    const provenance = partitionStage<{ fromAttemptId: string; resultRef: BlobRef }>(store, operation, origin, 'review-plan-provenance')?.result
    if (!provenance) fail('review_source_binding', '原候选缺少builder原件及真实续审provenance')
    const previous = store.readAttempt(provenance.fromAttemptId)
    const current = partitionStage<SavedGeneration>(store, operation, origin, 'generation')?.result
    const prior = previous.operationId === operation.id && previous.number < origin.number && ['failed', 'superseded', 'settled'].includes(previous.status) ? partitionStage<SavedGeneration>(store, operation, previous, 'generation')?.result : null
    const selected = prior && reviewPlanStage(store, operation, previous, 'partition-plan')
    const builders = (result: SavedGeneration): ElaborationTrace[] => result.traces.filter(trace => trace.purpose !== 'code_review')
    if (!current?.candidateValidated || !prior?.candidateValidated || canonical(current.candidate) !== canonical(candidate) || canonical(prior.candidate) !== canonical(candidate) || current.fileWriterPlanRef?.sha256 !== prior.fileWriterPlanRef?.sha256 || canonical(builders(current)) !== canonical(builders(prior)) || !selected || selected.resultRef.sha256 !== provenance.resultRef.sha256 || canonical(selected.result) !== canonical(plan)) fail('review_source_binding', 'builder来源链的候选/计划/真实trace或原文件计划已改变')
    origin = previous
  }
}

/** 同候选协议续审可承接合法repair原件；结论与批准资格始终分开。 */
function completedCandidateReviewSource(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, input: GenerationInput, readIndex?: (source: SyncAttempt) => SyncCheckpointStageView, retainRepair = false, cache?: GenerationReadCache): { result: SavedGeneration; resultRef: BlobRef; attempt: SyncAttempt; operation: SyncOperation } | null {
  if (input.model !== syncModel(operation)) return null
  if (attempt.operationId !== operation.id) {
    const parent = reviewHandoffParent(store, operation)
    if (parent?.id !== attempt.operationId) return null
    operation = parent; input = { ...input, model: syncModel(parent) }
  }
  const indexes = new Map<string, SyncCheckpointStageView>()
  readIndex ??= source => { let index = indexes.get(source.id); if (!index) { index = readSyncCheckpointStageIndex(store, operation, source); indexes.set(source.id, index) } return index }
  const selected = operation.baselineSelection
  if (selected && selected.digest !== baselineSelectionDigest(selected)) return null
  let origin = attempt, checkpoints = readIndex?.(origin), source = partitionStage<SavedGeneration>(store, operation, origin, key, undefined, checkpoints)
  while (source) {
    const result = source.result, trace = result.traces[0]
    const accepted = result.status === 'reviewed' && result.reviewPassed && result.review?.verdict === 'accept' && result.review.findings.length === 0
    const repaired = retainRepair && result.status === 'repair' && !result.reviewPassed && result.review?.verdict === 'repair' && result.review.findings.length > 0
    if (origin.operationId !== operation.id || !['failed', 'superseded', 'settled'].includes(origin.status) || !accepted && !repaired || !result.candidateValidated || result.failure || result.validationFindings.some(finding => finding.severity === 'error') || result.inputId !== operation.input.id || canonical(result.candidate) !== canonical(candidate) || !result.review || canonical(result.reviewOutput) !== canonical(result.review) || result.review.inputId !== operation.input.id || result.review.candidateDigest !== candidate.digest || result.traces.length !== 1 || trace.purpose !== 'code_review' || trace.inputDigest !== result.inputDigest || trace.resultDigest !== contentHash(JSON.stringify(result.reviewOutput))) return null
    const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration', 'automatic', checkpoints)
    const aggregate = partitionStage<SavedGeneration>(store, operation, origin, 'generation', undefined, checkpoints)?.result
    if (canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths) || approved && aggregate && !reviewScopeProof(store, operation, origin, approved, aggregate, readIndex)) return null
    const oldKey = `sync:${origin.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.key === oldKey && dispatch.purpose === 'code_review' && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
    if (!dispatch) {
      const provenance = partitionStage<AcceptedReviewProvenance>(store, operation, origin, `${key}:provenance`, undefined, checkpoints)?.result
      const carried = acceptedReviewInput(store, operation, origin, key, source.resultRef, checkpoints)
      if (!provenance || !carried || freezeGenerationInput({ ...carried, requestKey: input.requestKey }).inputDigest !== freezeGenerationInput(input).inputDigest) return null
      const prior = store.readAttempt(provenance.fromAttemptId)
      if (prior.operationId !== provenance.fromOperationId) return null
      if (prior.operationId === operation.id) {
        if (prior.number >= origin.number) return null
      } else {
        const parent = reviewHandoffParent(store, operation)
        if (provenance.fromOperationId !== parent?.id || prior.operationId !== parent.id) return null
        operation = parent; input = { ...input, model: syncModel(parent) }
      }
      origin = prior
      checkpoints = readIndex?.(origin)
      const previous = partitionStage<SavedGeneration>(store, operation, origin, key, undefined, checkpoints)
      if (previous?.resultRef.sha256 !== source.resultRef.sha256) return null
      source = previous; continue
    }
    if (trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || !trace.threadId || !trace.turnId || canonical(reviewPlanStage(store, operation, origin, 'candidate-partition-plan', undefined, readIndex)?.result) !== canonical(plan)) return null
    const sourceInput = { ...input, requestKey: oldKey.slice(0, -':code_review'.length) }
    const expected = generationReviewRequest(sourceInput, candidate, true, aggregate?.p2SpecWritePaths, cache)
    if (expected.request.inputDigest !== result.inputDigest || reviewError(sourceInput, result.review, expected.binding, undefined, aggregate?.p2SpecWritePaths)) return null
    const native = completedNativeStageResult(store, operation, origin, expected.request, trace, result.reviewOutput, candidate.digest, checkpoints)
    if (!native) return null
    verifyGenerationReviewDraft(operation.input.source.commonDir, expected.request, native, expected.draftBinding)
    return { ...source, attempt: origin, operation }
  }
  return null
}

/** 已接受缓存只承接原accept；业务repair原件不能借协议续审取得批准。 */
export function acceptedCandidateReviewSource(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, input: GenerationInput, readIndex?: (source: SyncAttempt) => SyncCheckpointStageView): { result: SavedGeneration; resultRef: BlobRef; attempt: SyncAttempt } | null {
  return completedCandidateReviewSource(store, operation, attempt, key, candidate, plan, input, readIndex)
}

/** 格式续审沿原正式Native失败取诊断；完整业务输入及原请求必须仍可逐字重建。 */
export function failedCandidateReviewSource(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, input?: GenerationInput, readIndex?: (source: SyncAttempt) => SyncCheckpointStageView, readNativeRecord?: typeof readRecord, cache?: GenerationReadCache): GenerationInput['reviewRepair'] | null {
  if (input && input.model !== syncModel(operation)) return null
  if (origin.operationId !== operation.id) {
    const parent = reviewHandoffParent(store, operation)
    if (parent?.id !== origin.operationId) return null
    operation = parent
    if (input) input = { ...input, model: syncModel(parent) }
  }
  const checkpointsAtEntry = readIndex?.(origin) ?? readSyncCheckpointStageIndex(store, operation, origin)
  readIndex ??= source => source.id === origin.id ? checkpointsAtEntry : readSyncCheckpointStageIndex(store, operation, source)
  const checkpoints = readIndex?.(origin), source = partitionStage<SavedGeneration>(store, operation, origin, key, undefined, checkpoints), result = source?.result
  if (!source || !result || !['failed', 'superseded', 'settled'].includes(origin.status) || !['repair', 'failed'].includes(result.status) || result.inputId !== operation.input.id || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths) || input && canonical(input.composed) !== canonical(origin.composedInput) || !result.candidateValidated || result.reviewPassed || result.validationFindings.some(finding => finding.severity === 'error') || canonical(result.candidate) !== canonical(candidate) || canonical(reviewPlanStage(store, operation, origin, 'candidate-partition-plan', undefined, readIndex)?.result) !== canonical(plan)) return null
  const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration', 'automatic', checkpoints)
  const aggregate = partitionStage<SavedGeneration>(store, operation, origin, 'generation', undefined, checkpoints)?.result
  if (!approved || !aggregate || !reviewScopeProof(store, operation, origin, approved, aggregate, readIndex)) return null
  const savedPlan = JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const writable = aggregate.p2SpecWritePaths ?? (savedPlan.version === 'sync-coordinator-v2' && savedPlan.direction === 'code_to_spec' ? [] : undefined)
  const completed = result.reviewOutput !== null
  if (completed) {
    const output = result.reviewOutput as NonNullable<GenerationResult['review']>
    if (!writable || result.failure && !completedReviewRepairCodes.has(result.failure.code) || result.review !== null && canonical(result.review) !== canonical(output)
      || candidateReviewError(output, { inputId: operation.input.id, candidateDigest: candidate.digest, requiredIds: [], actualIds: [], priorIds: [] })?.startsWith('评审 schema')
      || output.verdict !== 'repair' || !output.findings.some(finding => finding.ruleLocation.replace(/^contract:/, '').startsWith('.spec/'))) return null
    const entries = verifyCandidate(operation.input.source.commonDir, candidate).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md'))
    const blobs = readObjectBatch(operation.input.source.commonDir, entries.map(entry => entry.oid))
    const contracts = entries.flatMap(({ path, oid }) => parseContract({ nodeId: path.split('/').at(-2)!, path, source: blobs.get(oid)!.toString('utf8') }).contract ?? [])
    if (candidateReviewError(output, { inputId: operation.input.id, candidateDigest: candidate.digest, requiredIds: [], actualIds: contracts.flatMap(contract => contract.items.map(item => item.id)), priorIds: [] }) || candidateReviewLocationError(output, contracts, writable)?.code !== 'review_location_format') return null
  } else if (!reviewFormatRepairCodes.has(result.failure?.code ?? '') || result.review !== null) return null
  const requestKey = `sync:${origin.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`
  const resource = store.findResource(origin.id, requestKey)
  if (!resource || resource.phase !== 'removed' || resource.attemptId !== origin.id || resource.plan.key !== requestKey || resource.plan.inputId !== operation.input.id || !completed && (result.failure?.requestKey !== requestKey || result.failure.inputDigest !== result.inputDigest)) return null
  const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  if (native.request.purpose !== 'code_review' || native.request.inputDigest !== result.inputDigest) return null
  if (completed) {
    const trace = result.traces[0]
    if (checkpoint.nativeState !== 'completed' || checkpoint.failure || result.traces.length !== 1 || !trace || !completedNativeStageResult(store, operation, origin, native.request, trace, result.reviewOutput, candidate.digest, checkpoints)) return null
  } else {
    const packet = checkpoint.failure?.rejectedOutput
    if (!packet || !result.failure || native.request.purpose !== 'code_review' || native.request.inputDigest !== result.inputDigest || native.candidateDigest !== resource.plan.candidateDigest || native.candidateDigest !== null && native.candidateDigest !== candidate.digest || checkpoint.failure?.code !== result.failure.code || checkpoint.failure.message !== result.failure.message || checkpoint.phase !== 'removed' || checkpoint.nativeState !== 'failed' || checkpoint.stop?.nativeStopped !== true) return null
    const state = authenticateNativeRejectedFinal(store, operation, origin, requestKey, result.failure, packet, readNativeRecord)
    if (state.cancellation?.nativeStopped !== true || checkpoint.stop.nativeStatus !== state.cancellation.nativeStatus || checkpoint.requestDigest !== native.requestDigest || checkpoint.operationId !== operation.id || checkpoint.attemptId !== origin.id || checkpoint.inputId !== operation.input.id || checkpoint.expectedSessionId !== result.failure.sessionId || checkpoint.session.sessionId !== result.failure.sessionId || checkpoint.session.threadId !== result.failure.threadId || checkpoint.session.turnId !== result.failure.turnId) return null
  }
  if (input) {
    const savedInput = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, origin, `${key}:input`, undefined, checkpoints)?.result
    const previous = savedInput ? restoreGenerationInput(savedInput) : { ...input, requestKey: requestKey.slice(0, -':code_review'.length), reviewRepair: undefined }
    const base = { ...previous, requestKey: input.requestKey, reviewRepair: undefined }
    if (freezeGenerationInput(base).inputDigest !== freezeGenerationInput({ ...input, reviewRepair: undefined }).inputDigest) return null
    const expected = generationReviewRequest(previous, candidate, true, writable, cache).request
    const dispatch = origin.dispatchPlans.find(item => item.key === requestKey && item.purpose === 'code_review')
    if (!dispatch || !matchesScheduledNativeReview(operation, origin, dispatch, native.request, expected)) return null
  }
  return { resultRef: source.resultRef, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef }
}

/** 已结算的中断仅允许同候选补审，沿原失败与原生停止原件核对。 */
function stoppedCandidateReviewSource(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, readIndex: (source: SyncAttempt) => SyncCheckpointStageView, readNativeRecord = readRecord, cache?: GenerationReadCache) {
  if (origin.operationId !== operation.id || !['failed', 'superseded'].includes(origin.status)) return null
  const checkpoints = readIndex(origin), commonDir = operation.input.source.commonDir
  const source = partitionStage<SavedGeneration>(store, operation, origin, key, undefined, checkpoints), saved = source?.result
  const failure = saved?.failure
  if (!saved || failure?.code !== 'cancellation_pending' || saved.status !== 'failed' || saved.inputId !== operation.input.id
    || !saved.candidateValidated || saved.reviewPassed || saved.review !== null || saved.reviewOutput !== null || saved.traces.length
    || saved.validationFindings.some(item => item.severity === 'error') || canonical(saved.candidate) !== canonical(candidate)
    || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths) || canonical(reviewPlanStage(store, operation, origin, 'candidate-partition-plan', undefined, readIndex)?.result) !== canonical(plan)) return null
  const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration', 'automatic', checkpoints)
  const generation = partitionStage<SavedGeneration>(store, operation, origin, 'generation', undefined, checkpoints)?.result
  const inputEvidence = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, origin, `${key}:input`, undefined, checkpoints)?.result
  if (!approved || !generation || !inputEvidence || !reviewScopeProof(store, operation, origin, approved, generation, readIndex)) return null
  const input = restoreGenerationInput(inputEvidence)
  const requestKey = `sync:${origin.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`
  if (input.requestKey !== requestKey.slice(0, -':code_review'.length) || input.model !== syncModel(operation) || input.snapshot.id !== operation.input.id
    || canonical(input.snapshot.source) !== canonical(operation.input.source) || input.policy.digest !== operation.policyDigest
    || canonical(input.composed) !== canonical(origin.composedInput) || failure.requestKey !== requestKey || failure.inputDigest !== saved.inputDigest) return null
  const dispatch = origin.dispatchPlans.find(item => item.key === requestKey && item.purpose === 'code_review')
  const resource = store.findResource(origin.id, requestKey)
  if (!dispatch || !resource || resource.phase !== 'removed' || resource.operationId !== operation.id || resource.attemptId !== origin.id
    || resource.generation !== origin.generation || resource.plan.kind !== 'native_session' || resource.plan.key !== requestKey
    || resource.plan.inputId !== operation.input.id || resource.plan.payloadDigest !== dispatch.requestDigest) return null
  const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString('utf8')) as NativeRunCheckpoint
  const sessionId = sessionIdForCreateKey(dispatch.sessionCreateKey)
  const session = { sessionId, threadId: failure.threadId ?? null, turnId: failure.turnId ?? null }
  const matches = (evidence: NativeRunPlan | NativeRunCheckpoint): boolean => evidence.schemaVersion === 1 && evidence.operationId === operation.id
    && evidence.attemptId === origin.id && evidence.inputId === operation.input.id && evidence.candidateDigest === resource.plan.candidateDigest
    && (evidence.candidateDigest === null || evidence.candidateDigest === candidate.digest) && evidence.requestDigest === dispatch.requestDigest && evidence.expectedSessionId === sessionId
  if (!matches(native) || !matches(checkpoint) || !native.request.worktree || failure.sessionId !== sessionId
    || native.request.purpose !== 'code_review' || native.request.inputDigest !== saved.inputDigest || native.sessionCreateKey !== dispatch.sessionCreateKey
    || contentHash(JSON.stringify(native.request)) !== dispatch.requestDigest || canonical(dispatch.session) !== canonical(session)
    || checkpoint.phase !== 'removed' || checkpoint.status !== 'cancelled' || checkpoint.nativeState !== 'cancelled' || !checkpoint.nativeCallRequested
    || checkpoint.result || checkpoint.failure || checkpoint.creationTermination || canonical(checkpoint.session) !== canonical(session)
    || !resource.checkpoints.some(item => {
      if (item.phase !== 'created') return false
      const observed = JSON.parse(readEvidence(commonDir, item.checkpointRef).toString('utf8')) as NativeRunCheckpoint
      return matches(observed) && observed.phase === 'created' && observed.nativeState === 'cancelling' && observed.nativeCallRequested && canonical(observed.session) === canonical(session)
    })) return null
  const record = readNativeRecord(sessionId), state = record?.structuredExecution, stop = state?.cancellation
  const execution = structuredExecutionPolicy(native.request)
  const prompt = nativeWorktreePrompt(native.request.prompt, native.request.worktree), base = native.request.worktree.baseCommit
  if (!record || !state || record.session !== sessionId || record.createRequestId !== contentHash(native.sessionCreateKey)
    || record.createPayloadHash !== contentHash(JSON.stringify({ prompt, parent: null, launcher: null, base, structuredExecution: execution }))
    || canonical(structuredExecutionPolicy(state)) !== canonical(execution) || state.state !== 'cancelled' || state.error !== failure.message
    || (state.threadId ?? null) !== session.threadId || (state.turnId ?? null) !== session.turnId
    || record.harnessSessionId !== session.threadId || stop?.reason !== 'cancelled' || stop.nativeStopped !== true
    || state.output !== undefined || state.resultDigest !== undefined || state.resultWorktree || state.rejectedOutput || state.failedWorktree
    || canonical(checkpoint.stop) !== canonical({ sessionId, state: 'cancelled', threadId: state.threadId, turnId: state.turnId,
      nativeStopped: true, acknowledged: stop.acknowledged, nativeStatus: stop.nativeStatus, error: stop.error })) return null
  const policy = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString('utf8')) as SyncCoordinatorPlan
  const writable = generation.p2SpecWritePaths ?? (policy.version === 'sync-coordinator-v2' && policy.direction === 'code_to_spec' ? [] : undefined)
  const expected = generationReviewRequest(input, candidate, true, writable, cache)
  return matchesScheduledNativeReview(operation, origin, dispatch, native.request, expected.request)
    ? { input, record, seed: native.request.worktree, draftBinding: expected.draftBinding, resultRef: source!.resultRef, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef }
    : null
}

function settledCandidateReviewAttempt(attempt: SyncAttempt): boolean {
  return attempt.status === 'superseded' && attempt.failure === null
    || ['failed', 'superseded'].includes(attempt.status) && (attempt.failure?.kind === 'repairable' || attempt.failure?.code === 'cancellation_pending')
}

/** 失租约不补写旧失败；只有完整同候选审查及资源原件已结算才可接回业务诊断。 */
function* candidateReviewAuthentication(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, generation: SavedGeneration, readIndex: (source: SyncAttempt) => SyncCheckpointStageView, options?: { readNativeRecord?: typeof readRecord }): Generator<void, string[] | null> {
  if (!settledCandidateReviewAttempt(attempt) || !generation.candidateValidated || !generation.candidate || generation.reviewPassed || generation.validationFindings.some(finding => finding.severity === 'error')) return null
  const checkpoints = readIndex(attempt), candidate = generation.candidate
  const frozen = partitionStage<CandidateRef>(store, operation, attempt, 'partition:candidate', undefined, checkpoints)?.result
  const plan = reviewPlanStage(store, operation, attempt, 'candidate-partition-plan', undefined, readIndex)?.result
  const budget = stage<{ requiredKeys: string[] }>(store, operation, attempt, 'partition-generation-budget', 'automatic', checkpoints)
  if (!plan || !budget || canonical(frozen) !== canonical(candidate) || store.listResources(attempt.id).some(resource => resource.operationId !== operation.id || resource.attemptId !== attempt.id || resource.plan.inputId !== operation.input.id || resource.phase !== 'removed')) return null
  const prefix = `sync:${attempt.id}:generation:final:`
  const required = budget.requiredKeys.filter(key => key.startsWith(prefix) && key.endsWith(':code_review')).map(key => `partition:${key.slice(prefix.length, -':code_review'.length)}:candidate-review`)
  const actual = checkpoints.json.map(({ value }) => value as Stage).filter(value => value.stage?.endsWith(':candidate-review')).map(value => value.stage)
  if (!required.length || new Set(required).size !== required.length || canonical([...required].sort()) !== canonical([...actual].sort())) return null
  const incompleteKeys: string[] = [], cache: GenerationReadCache = { textByRepository: new Map() }
  for (const key of required) {
    const saved = partitionStage<SavedGeneration>(store, operation, attempt, key, undefined, checkpoints)!
    const original = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, attempt, `${key}:input`, undefined, checkpoints)?.result
    const input = original ? restoreGenerationInput(original) : acceptedReviewInput(store, operation, attempt, key, saved.resultRef, checkpoints)
    if (!(input && completedCandidateReviewSource(store, operation, attempt, key, candidate, plan, input, readIndex, true, cache))) {
      const source = saved.result.failure?.code === 'cancellation_pending'
        ? stoppedCandidateReviewSource(store, operation, attempt, key, candidate, plan, readIndex, options?.readNativeRecord, cache)
        : failedCandidateReviewSource(store, operation, attempt, key, candidate, plan, input ?? undefined, readIndex, options?.readNativeRecord, cache)
      if (!source) return null
      incompleteKeys.push(key)
    }
    yield
  }
  return incompleteKeys
}

function interruptedCandidateReviewComplete(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, generation: SavedGeneration, readIndex: (source: SyncAttempt) => SyncCheckpointStageView): boolean {
  if (attempt.status !== 'superseded' || attempt.failure !== null) return false
  return withReadonlySnapshotQuery(() => {
    const proof = candidateReviewAuthentication(store, operation, attempt, generation, readIndex)
    let step = proof.next()
    while (!step.done) step = proof.next()
    return step.value !== null
  })
}

/** 真实只读候选失败回到原P1写者；独审诊断不成为refinement或业务授权。 */
function readonlyRepairFromAttempt(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, readIndex?: (source: SyncAttempt) => SyncCheckpointStageView): ReadonlyOwnerRepair | null {
  if (attempt.operationId !== operation.id) fail('readonly_spec_repair_binding', '只读V1续修来源属于另一操作')
  const indexes = new Map<string, SyncCheckpointStageView>()
  readIndex ??= source => { let index = indexes.get(source.id); if (!index) { index = readSyncCheckpointStageIndex(store, operation, source); indexes.set(source.id, index) } return index }
  const checkpoints = readIndex(attempt)
  const saved = stage<SavedGeneration>(store, operation, attempt, 'generation', 'automatic', checkpoints)
  if (!saved) return null
  operation = readonlyRepairContext(store, operation, attempt, writeEvidence(operation.input.source.commonDir, saved), checkpoints)
  const generation = partitionStage<SavedGeneration>(store, operation, attempt, 'generation', operation.baselineSelection, checkpoints)
  let allFindings = generation?.result.validationFindings.filter(item => item.severity === 'error') ?? []
  const semantic = generation?.result.candidateValidated === true && ['repair', 'failed'].includes(generation.result.status) && !generation.result.reviewPassed && generation.result.partitionEvidence?.some(item => item.review.verdict === 'repair')
  if (!generation?.result.candidate || !semantic && (generation.result.candidateValidated || !allFindings.length || allFindings.some(item => !isReadonlyCitationFailure(item)))) return null
  if (semantic && generation.result.failure?.code === 'cancellation_pending') return null
  const plan = operation.planBlob ? JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob).toString('utf8')) as SyncCoordinatorPlan : null
  if (plan?.version !== 'sync-coordinator-v2') return null
  const writable = generation.result.p2SpecWritePaths ?? (plan.direction === 'code_to_spec' ? [] : null)
  if (!writable) fail('readonly_spec_repair_permissions_unknown', '旧mixed候选没有真实P2 Spec写权限投影，停止而不猜owner权限', [generation.resultRef])
  if (!semantic && allFindings.every(finding => within(finding.path, writable))) return null
  const approved = stage<SavedElaboration>(store, operation, attempt, 'elaboration', 'automatic', checkpoints)
  const prior = approved ? { result: approved, resultRef: writeEvidence(operation.input.source.commonDir, approved) } : null
  if (!prior?.result.structurePassed || !prior.result.reviewPassed || prior.result.failure || !prior.result.partitionEvidence?.length || !['failed', 'superseded', 'settled'].includes(attempt.status)) fail('readonly_spec_repair_binding', '只读V1诊断缺少同输入已审P1及已结算失败')
  const planDigests = new Set(prior.result.partitionEvidence.map(owner => (JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration).partitionBinding?.planDigest))
  const history = readonlyElaborationHistory(store, operation, readIndex)
  const origins = history.attempts.filter(item => item.number <= attempt.number)
  let planSource: { attemptId: string; ref: BlobRef } | undefined
  for (const origin of origins) {
    const approved = history.read<SavedElaboration>(origin, 'elaboration'), plan = history.read<SyncPartitionPlan>(origin, 'partition-plan')
    if (approved && plan && writeEvidence(operation.input.source.commonDir, approved).sha256 === prior.resultRef.sha256 && planDigests.size === 1 && planDigests.has(plan.digest)
      && (!approved.analysisOnlyPartitions || authenticatedMixedElaborationCoverage(store, operation, origin, plan, approved))) { planSource = { attemptId: origin.id, ref: writeEvidence(operation.input.source.commonDir, plan) }; break }
  }
  if (!planSource) fail('readonly_spec_repair_binding', '只读V1诊断缺少原已审全分区计划')
  const candidate = generation.result.candidate, commonDir = operation.input.source.commonDir
  if (candidate.sourceInputId !== operation.input.id) fail('readonly_spec_repair_binding', '只读V1诊断候选属于另一输入')
  const entries = new Map(verifyCandidate(commonDir, candidate).map(entry => [entry.path, entry]))
  if (semantic) {
    const plan = reviewPlanStage(store, operation, attempt, 'candidate-partition-plan', undefined, readIndex)?.result
    const formatKeys = checkpoints.json.map(({ value }) => value as Stage).filter(value => value.stage?.endsWith(':candidate-review')).flatMap(value => {
      const result = partitionStage<SavedGeneration>(store, operation, attempt, value.stage, undefined, checkpoints)?.result
      return result?.failure && (reviewFormatRepairCodes.has(result.failure.code) || completedReviewRepairCodes.has(result.failure.code)) ? [value.stage] : []
    })
    if (formatKeys.length) {
      if (!plan || formatKeys.some(key => !failedCandidateReviewSource(store, operation, attempt, key, candidate, plan, undefined, readIndex))) fail('readonly_spec_repair_binding', '未完成协议的候选审查缺少原Native格式续稿证明')
      return null
    }
    const contracts = prior.result.changes.flatMap(change => parseContract(change).contract ?? [])
    const invalid = generation.result.partitionEvidence!.filter(evidence => candidateReviewLocationError(evidence.review, contracts, writable)?.code === 'review_location_format')
    if (invalid.length) {
      if (!plan || invalid.some(evidence => !failedCandidateReviewSource(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, candidate, plan, undefined, readIndex))) fail('readonly_spec_repair_binding', '字段格式无效的历史独审缺少完整原Native成功认证，不能取得草稿续修权限')
      return null
    }
  }
  if (attempt.failure?.kind !== 'repairable' && !(semantic && interruptedCandidateReviewComplete(store, operation, attempt, generation.result, readIndex))) fail('readonly_spec_repair_binding', '只读诊断既无正式repairable失败，也无完整已结算的失租约候选审查原件')
  if (semantic && (prior.result.changes.every(change => within(change.path, writable)) || generation.result.partitionEvidence!.some(evidence => evidence.review.findings.some(finding => finding.ruleLocation.startsWith('contract-omission:') && within(finding.ruleLocation.slice('contract-omission:'.length).split('#')[0], writable))))) return null
  const reviewEvidence: NonNullable<ReadonlyOwnerRepair['reviewEvidence']> = []
  if (semantic) {
    allFindings = readonlyReviewFindings(generation.result, prior.result.changes, writable)
    const reviewPlan = reviewPlanStage(store, operation, attempt, 'candidate-partition-plan', undefined, readIndex)
    const cache: GenerationReadCache = { textByRepository: new Map() }
    for (const evidence of generation.result.partitionEvidence!) {
      const saved = partitionStage<SavedGeneration>(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, operation.baselineSelection, checkpoints)
      const result = saved?.result, trace = result?.traces.find(trace => trace.purpose === 'code_review')
      const currentDispatch = trace && attempt.dispatchPlans.some(dispatch => dispatch.purpose === 'code_review' && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
      const acceptedInput = !currentDispatch && saved && reviewPlan ? acceptedReviewInput(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, saved.resultRef, checkpoints) : null
      const acceptedSource = reviewPlan && acceptedInput && completedCandidateReviewSource(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, candidate, reviewPlan.result, acceptedInput, readIndex, true, cache)
      if (!result || result.failure || !result.candidateValidated || canonical(result.candidate) !== canonical(candidate) || canonical(result.review) !== canonical(evidence.review) || canonical(result.traces) !== canonical(evidence.traces) || !trace || trace.resultDigest !== contentHash(JSON.stringify(result.reviewOutput)) || canonical(result.reviewOutput) !== canonical(result.review) || trace.inputDigest !== result.inputDigest || !currentDispatch && !acceptedSource || !['accept', 'repair'].includes(evidence.review.verdict) || evidence.review.inputId !== operation.input.id || evidence.review.candidateDigest !== candidate.digest) fail('readonly_spec_repair_binding', '只读独审诊断缺少真实normalized review、完整候选及原dispatch绑定')
      if (evidence.review.verdict !== 'repair') continue
      reviewEvidence.push({ partitionId: evidence.partitionId, resultRef: saved.resultRef })
    }
  }
  const findings = allFindings.filter(finding => !within(finding.path, writable))
  if (!findings.length) return null
  const sources = prior.result.partitionEvidence.flatMap(owner => {
    const key = `partition:${owner.partitionId}:elaboration`
    for (const origin of origins.filter(item => ['failed', 'superseded', 'settled'].includes(item.status))) {
      const source = readonlyLocalSource(store, operation, origin, key, owner.resultRef, prior.resultRef, history)
      if (source?.resultRef.sha256 === owner.resultRef.sha256) return [{ owner: { key, partitionId: owner.partitionId, fromAttemptId: origin.id, resultRef: source.resultRef }, changes: source.result.changes }]
    }
    return []
  })
  if (sources.length !== prior.result.partitionEvidence.length) fail('readonly_spec_repair_binding', '已审aggregate的每个分区都必须保留真实批准source，不能转为其它owner fresh')
  const owners = new Map<string, ReadonlyOwnerRepair['owners'][number]>()
  for (const finding of new Map(findings.map(finding => [JSON.stringify([finding.nodeId, finding.path]), finding])).values()) {
    const change = prior.result.changes.find(change => change.nodeId === finding.nodeId && change.path === finding.path), entry = entries.get(finding.path)
    if (!change || !entry || entry.mode === '120000' || readObject(commonDir, entry.oid).toString('utf8') !== change.source) fail('readonly_spec_repair_binding', '只读V1诊断未绑定候选中的实际已审Spec路径')
    const matches = sources.filter(source => source.changes.some(item => item.nodeId === finding.nodeId && item.path === finding.path))
    if (matches.length !== 1) fail('readonly_spec_repair_binding', '只读V1诊断没有唯一已授权P1 owner')
    owners.set(matches[0].owner.key, matches[0].owner)
  }
  return { ...(semantic ? { kind: 'candidate_review' as const, reviewEvidence } : {}), fromAttemptId: attempt.id, generationRef: generation.resultRef, priorRef: prior.resultRef, planAttemptId: planSource.attemptId, planRef: planSource.ref, candidateDigest: candidate.digest, findings, allFindings, owners: [...owners.values()] }
}

function readonlyRepairContext(store: SyncStore, operation: SyncOperation, source: SyncAttempt, generationRef: BlobRef, checkpoints = readSyncCheckpointStageIndex(store, operation, source)): SyncOperation {
  let context = operation
  if (operation.baselineSelection) {
    const basis = checkpoints.json.map(({ value }) => value as Stage).find(saved => saved.version === 'sync-stage-v1' && saved.stage === 'generation' && saved.operationId === operation.id && saved.attemptId === source.id && saved.inputId === operation.input.id && saved.policyDigest === operation.policyDigest && saved.resultRef?.sha256 === generationRef.sha256)
    if (!basis?.readSetDigest || !basis.baselineSelectionRef || !stageSelectionMatches(store, operation, basis)) fail('readonly_spec_repair_binding', '只读续修原generation绑定不属于当前合法null资源扩展')
    const commonDir = operation.input.source.commonDir
    const selection = JSON.parse(readEvidence(commonDir, basis.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
    context = withCheckpointStageBasis(operation, basis.readSetDigest, selection)
    if (selection.digest !== operation.baselineSelection.digest) {
      const generation = JSON.parse(readEvidence(commonDir, generationRef).toString('utf8')) as SavedGeneration
      const covered = generation.candidate?.coveredScope
      const expansion = covered && operation.contractScopeExpansions?.find(item => item.baselineSelectionDigest === selection.digest
        && canonical(item.contractIds) === canonical(covered.contractIds) && canonical(item.flowIds) === canonical(covered.flowIds)
        && canonical(item.paths ?? covered.paths) === canonical(covered.paths))
      if (expansion) context = { ...context, scope: covered! }
    }
  }
  return context
}

/** 只恢复saved的relatedIds原始缺席；其余来源、字段及差异继续完整比较。 */
function readonlyRepairOriginalShape(derived: ReadonlyOwnerRepair | null, original: ReadonlyOwnerRepair): ReadonlyOwnerRepair | null {
  if (original.kind !== 'candidate_review' || !derived) return derived
  return { ...derived, ...Object.fromEntries((['findings', 'allFindings'] as const).map(key => [key, derived[key].map((finding, index) => {
    if (!original[key][index] || Object.hasOwn(original[key][index], 'relatedIds')) return finding
    const { relatedIds: _relatedIds, ...originalShape } = finding
    return originalShape
  })])) }
}

/** 原件完整冷验；只在derived对照中保留旧relatedIds缺席，不为历史冻结输入追补权限。 */
export function validateReadonlyRepair(store: SyncStore, operation: SyncOperation, repair: ReadonlyOwnerRepair): void {
  withReadonlySnapshotQuery(() => {
    const source = store.readAttempt(repair.fromAttemptId)
    const context = readonlyRepairContext(store, operation, source, repair.generationRef)
    const derived = readonlyRepairFromAttempt(store, context, source)
    const originalShape = readonlyRepairOriginalShape(derived, repair)
    if (source.operationId !== operation.id || canonical(originalShape) !== canonical(repair)) fail('readonly_spec_repair_binding', '只读V1续修来源、owner或原件绑定失配')
  })
}

function refinementGeneration(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, refinement: Refinement): SavedGeneration {
  const previous = store.listAttempts(operation.id).filter(prior => prior.number < attempt.number).reverse().map(prior => stage<SavedGeneration>(store, operation, prior, 'generation')).find(value => value?.candidate?.digest === refinement.candidateDigest)
  const findings = refinement.diagnostics.map(item => JSON.parse(item.message) as GenerationFinding)
  if (!previous?.review || previous.review.verdict !== 'repair' || canonical(previous.candidate) !== canonical(refinement.candidate) || findings.some(finding => !previous.review!.findings.some(actual => canonical(actual) === canonical(finding)))) fail('refinement_binding', '持久遗漏诊断缺少对应实际候选及完整独审原件')
  return previous
}

function inheritedReadonlyLocal(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, source: NonNullable<ReturnType<typeof readonlyLocalSource>>, round: ElaborationResult['rounds'][number], history: ReturnType<typeof readonlyElaborationHistory>, onMismatch?: (message: string) => void): ReturnType<typeof elaborationDraftGenerationSource> {
  const reject = (message: string): null => { onMismatch?.(message); return null }
  const { wrapper } = source, commonDir = operation.input.source.commonDir
  if (!operation.retryOf || !operation.baselineSelection || !wrapper.baselineSelectionRef || !wrapper.readSetDigest) return reject('原owner缺少正式retryOf或原selection/readSet')
  const selection = JSON.parse(readEvidence(commonDir, wrapper.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
  const composed = attempt.composedInput
  if (!composed || composed.baselineSelectionDigest !== attempt.baselineSelectionDigest) return reject('原owner组合输入与attempt选择不同')
  const recomposed = attempt.baselineSelectionDigest !== selection.digest
  let scope = operation.scope
  if (selection.digest !== operation.baselineSelection.digest) {
    if (operation.planBlob?.sha256 !== operation.policyDigest) return reject('原owner冻结政策摘要不同')
    const plan = JSON.parse(readEvidence(commonDir, operation.planBlob).toString('utf8')) as SyncCoordinatorPlan
    const expansion = operation.contractScopeExpansions?.find(item => item.previousBaselineSelectionDigest === selection.digest && item.baselineSelectionDigest === operation.baselineSelection!.digest)
    if (!plan.executionScope || !expansion || !extendsWithUninitializedResources(selection, operation.baselineSelection)
      || canonical(expansion.paths) !== canonical(scope.paths) || canonical(expansion.contractIds) !== canonical(scope.contractIds) || canonical(expansion.flowIds) !== canonical(scope.flowIds)) return reject('原owner的null扩域与当前授权范围不一致')
    if (recomposed) {
      const approved = history.read<SavedElaboration>(attempt, 'elaboration')
      if (attempt.baselineSelectionDigest !== operation.baselineSelection.digest || !approved?.structurePassed || !approved.reviewPassed || approved.failure
        || writeEvidence(commonDir, approved).sha256 !== expansion.evidenceRef.sha256
        || !approved.partitionEvidence?.some(owner => owner.partitionId === source.result.partitionBinding?.partitionId && owner.resultRef.sha256 === source.resultRef.sha256)
        || !elaborationComposedBinding(store, operation, attempt, approved, composed, history.checkpoints(attempt))) return reject('原owner没有同一次P1批准的组合扩域证明')
    }
    scope = { paths: unique(plan.executionScope.paths), contractIds: unique(plan.executionScope.contractIds), flowIds: unique(plan.executionScope.flowIds) }
  } else if (recomposed) return reject('原owner组合元数据与原选择不一致')
  const basis = { ...withCheckpointStageBasis(operation, wrapper.readSetDigest, selection), scope }
  const sources = history.inheritedSources(basis, attempt, selection)
  return elaborationDraftGenerationSource(store, basis, attempt, key, source, round, sources, (owner, prior) => history.checkpoints(prior, owner), {
    selection, recomposed,
    rebase: (owner, prior, original) => inheritedReadonlyLocal(store, store.readOperation(owner.id), prior, key, original, original.result.rounds.at(-1)!, history, onMismatch),
  }) ?? reject('原owner正式来源链或原Native生成/独审未通过')
}

function reviewedReadonlyLocalSource(store: SyncStore, operation: SyncOperation, sourceAttempt: SyncAttempt, key: string, resultRef: BlobRef, aggregateRef: BlobRef, afterAttemptNumber = 0, history = readonlyElaborationHistory(store, operation)): { result: SavedElaboration; owner: SyncOperation; approvalAttempt: SyncAttempt } {
  const source = readonlyLocalSource(store, operation, sourceAttempt, key, resultRef, aggregateRef, history)
  const prior = source?.result, round = prior?.rounds.at(-1)
  const generationTrace = round?.traces.find(trace => trace.purpose === 'elaboration_generate'), reviewTrace = round?.traces.find(trace => trace.purpose === 'elaboration_review')
  const reject = (message: string): never => fail('readonly_spec_repair_binding', `${key}: ${message}`)
  if (!source || !prior || !round || source.resultRef.sha256 !== resultRef.sha256) return reject('原owner缺少精确local结果或批准轮')
  if (!prior.structurePassed || !prior.reviewPassed || prior.failure || !hasApprovedElaborationReview(prior) || round.review!.inputDigest !== prior.inputDigest || round.review!.candidateDigest !== prior.candidateDigest) return reject('原owner独审未批准同一完整输入及候选')
  if (round.traces.length !== 2 || !generationTrace || !reviewTrace || generationTrace.sessionId === reviewTrace.sessionId || generationTrace.threadId === reviewTrace.threadId || generationTrace.resultDigest !== contentHash(JSON.stringify(round.output)) || reviewTrace.resultDigest !== contentHash(JSON.stringify(round.reviewOutput))) return reject('原owner生成/独审身份或输出摘要失配')
  const generated = elaborationGenerationSource(store, operation, sourceAttempt, round, prior)
  if (!generated && afterAttemptNumber === 0) {
    if (operation.inheritRetryBudget) {
      let carrier = sourceAttempt
      for (;;) {
        const provenance = history.read<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(carrier, `${key}:provenance`)
        if (!provenance || provenance.resultRef.sha256 !== resultRef.sha256) break
        const previous = store.readAttempt(provenance.fromAttemptId)
        if (previous.operationId === operation.id) {
          if (provenance.fromOperationId !== operation.id || previous.number >= carrier.number || !['failed', 'superseded', 'settled'].includes(previous.status)
            || !readonlyLocalSource(store, operation, previous, key, resultRef, aggregateRef, history)) return reject('交接P1的同操作引用不属于严格更早的原local')
          carrier = previous; continue
        }
        const parent = reviewHandoffParent(store, operation)
        if (provenance.fromOperationId !== parent?.id || previous.operationId !== parent.id || !['failed', 'superseded', 'settled'].includes(previous.status)) return reject('交接P1没有已结算的直接父操作来源')
        const original = stage<SavedElaboration>(store, parent, previous, 'elaboration')
        if (!original || !elaborationComposedBinding(store, parent, previous, original, sourceAttempt.composedInput!)
          || !original.partitionEvidence?.some(member => member.partitionId === prior.partitionBinding?.partitionId && member.resultRef.sha256 === resultRef.sha256)) return reject('交接P1原local不属于原组合及完整批准')
        const parentHistory = readonlyElaborationHistory(store, parent, attempt => readStageCheckpoints(store, parent, attempt, true))
        return reviewedReadonlyLocalSource(store, parent, previous, key, resultRef, writeEvidence(operation.input.source.commonDir, original), 0, parentHistory)
      }
    }
    let mismatch = '原owner缺少原Native生成身份'
    const inherited = inheritedReadonlyLocal(store, operation, sourceAttempt, key, source, round, history, message => { mismatch = message })
    if (inherited) return { result: prior, owner: store.readOperation(inherited.ownerId), approvalAttempt: inherited.approvalAttempt }
    return reject(mismatch)
  }
  if (!generated) return reject('当前诊断之后没有该owner的新生成')
  if (!history.attempts.some(attempt => attempt.number > afterAttemptNumber && attempt.dispatchPlans.some(dispatch => dispatch.purpose === reviewTrace.purpose && dispatch.session?.sessionId === reviewTrace.sessionId && dispatch.session.threadId === reviewTrace.threadId && dispatch.session.turnId === reviewTrace.turnId) && history.checkpoints(attempt).json.some(({ value }) => (value as Stage).stage === key && (value as Stage).resultRef?.sha256 === resultRef.sha256))) return reject('原owner完整批准没有对应真实独审dispatch')
  return { result: prior, owner: operation, approvalAttempt: sourceAttempt }
}

export function reviewedReadonlyLocal(store: SyncStore, operation: SyncOperation, sourceAttempt: SyncAttempt, key: string, resultRef: BlobRef, aggregateRef: BlobRef, afterAttemptNumber = 0, history = readonlyElaborationHistory(store, operation)): SavedElaboration {
  return reviewedReadonlyLocalSource(store, operation, sourceAttempt, key, resultRef, aggregateRef, afterAttemptNumber, history).result
}

type ApprovedElaborationSource = { result: SavedElaboration; attemptId: string; operationId: string; resultRef: BlobRef }
type ApprovedElaboration = ApprovedElaborationSource & { lineage: ApprovedElaborationSource[] }
function latestApprovedElaboration(store: SyncStore, operation: SyncOperation, attemptNumber: number): ApprovedElaboration | null {
  let ancestor: SyncOperation | null = operation
  while (ancestor) {
    if (ancestor.input.id !== operation.input.id || canonical(ancestor.input.source) !== canonical(operation.input.source) || ancestor.policyDigest !== operation.policyDigest || (ancestor.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null) || ancestor.origin !== operation.origin) fail('retry_provenance_binding', '重试链不能借用另一来源或原意的已接受契约')
    let selected: { result: SavedElaboration; attemptId: string } | undefined
    const lineage: ApprovedElaborationSource[] = []
    const history = readonlyElaborationHistory(store, ancestor)
    for (const prior of history.attempts.filter(item => ancestor!.id !== operation.id || item.number < attemptNumber)) {
      const approved = history.read<SavedElaboration>(prior, 'elaboration')
      if (!approved?.structurePassed || !approved.reviewPassed || !['complete', 'needs_input', 'conflict'].includes(approved.status)) continue
      const checkpoints = history.checkpoints(prior)
      if (!reuseBehaviorDependentStages(store, ancestor, prior, checkpoints)) continue
      if (!selected) { selected = { result: approved, attemptId: prior.id }; lineage.push({ ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, approved) }); continue }
      const readonlyInput = readonlyRepairBinding(store, ancestor, prior, checkpoints), readonlySupplement = readonlyInput?.readonlyOwnerRepair
      if (!readonlySupplement && checkpoints.json.some(({ value }) => (value as Partial<Stage>).stage?.endsWith(':readonly-repair-provenance'))) fail('readonly_spec_repair_binding', '已审只读返修whole缺少同attempt原始因果绑定')
      if (readonlySupplement && readonlyInput?.readonlyBaseRef && readonlyInput.readonlyBaseRef.sha256 !== writeEvidence(operation.input.source.commonDir, selected.result).sha256 && writeEvidence(operation.input.source.commonDir, approved).sha256 !== writeEvidence(operation.input.source.commonDir, selected.result).sha256) fail('readonly_spec_repair_binding', '只读装配base不是当前合法已审whole')
      if (readonlySupplement && (readonlyInput?.readonlyBaseRef ?? readonlySupplement.priorRef).sha256 === writeEvidence(operation.input.source.commonDir, selected.result).sha256) {
        validateReadonlyRepair(store, ancestor, readonlySupplement)
        if (!selected.result.partitionEvidence?.every(before => {
          const owner = readonlySupplement.owners.find(owner => owner.partitionId === before.partitionId && owner.resultRef.sha256 === before.resultRef.sha256), after = approved.partitionEvidence?.find(item => item.partitionId === before.partitionId)
          if (!owner) return after?.resultRef.sha256 === before.resultRef.sha256
          const response = after && (JSON.parse(readEvidence(operation.input.source.commonDir, after.resultRef).toString('utf8')) as SavedElaboration).readonlySpecRepair
          return after?.resultRef.sha256 !== before.resultRef.sha256 && response?.acceptedRef.sha256 === owner.resultRef.sha256 && response.generationRef.sha256 === readonlySupplement.generationRef.sha256
        })) fail('readonly_spec_repair_binding', '只读续修必须响应原source且保留未修owner的最新原件')
        selected = { result: approved, attemptId: prior.id }; lineage.push({ ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, approved) }); continue
      }
      const previousRef = writeEvidence(operation.input.source.commonDir, selected.result)
      const changedOwners = approved.partitionEvidence?.filter(owner => selected!.result.partitionEvidence?.some(before => before.partitionId === owner.partitionId && before.resultRef.sha256 !== owner.resultRef.sha256)) ?? []
      if (changedOwners.length && changedOwners.every(owner => (JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString()) as SavedElaboration).gapRepair)) {
        if (canonical(approved.partitionEvidence!.map(owner => owner.partitionId)) !== canonical(selected.result.partitionEvidence?.map(owner => owner.partitionId))) fail('candidate_gap_review_binding', 'GAP续稿不能改变原全图owner覆盖')
        for (const member of changedOwners) {
          const before = selected.result.partitionEvidence!.find(owner => owner.partitionId === member.partitionId)!
          const local = reviewedReadonlyLocal(store, ancestor, prior, `partition:${member.partitionId}:elaboration`, member.resultRef, writeEvidence(operation.input.source.commonDir, approved), 0, history)
          const marker = local.gapRepair!
          const provenance = history.read<{ fromAttemptId: string; reviewRef: BlobRef; resultRef: BlobRef }>(prior, `partition:${member.partitionId}:elaboration:gap-repair-provenance`)
          const origin = history.attempts.find(origin => origin.id === provenance?.fromAttemptId && origin.number < prior.number && ['failed', 'superseded', 'settled'].includes(origin.status))
          const proof = origin && history.read<ElaborationGapReviewCheckpoint>(origin, 'elaboration-gap-review')
          if (!proof || contentHash(JSON.stringify(proof)) !== marker.reviewRef.sha256 || proof.aggregateRef.sha256 !== previousRef.sha256 || marker.acceptedRef.sha256 !== before.resultRef.sha256
            || !proof.ownerRefs.some(owner => owner.partitionId === member.partitionId && owner.resultRef.sha256 === before.resultRef.sha256)
            || canonical(provenance) !== canonical({ fromAttemptId: origin!.id, resultRef: before.resultRef, reviewRef: marker.reviewRef })) fail('candidate_gap_review_binding', '新已审whole缺少同一GAP复核及原owner的续稿因果绑定')
        }
        selected = { result: approved, attemptId: prior.id }; lineage.push({ ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, approved) }); continue
      }
      const supplementation = history.read<{ refinement?: Refinement }>(prior, 'repair-input')?.refinement
      if (!supplementation || canonical(supplementation.prior) !== canonical(selected.result) || !supplementation.diagnostics.length) continue
      const findings = supplementation.diagnostics.map(item => JSON.parse(item.message) as GenerationFinding)
      const contracts = selected.result.changes.flatMap(change => parseContract({ nodeId: change.nodeId, path: change.path, source: change.source }).contract ?? [])
      if (!findings.every(finding => contractOmissionBound(finding, contracts))) continue
      refinementGeneration(store, ancestor, prior, supplementation)
      selected = { result: approved, attemptId: prior.id }; lineage.push({ ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, approved) })
    }
    if (selected) return { ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, selected.result), lineage }
    const parent: SyncOperation | null = ancestor.retryOf ? store.readOperation(ancestor.retryOf) : null
    ancestor = parent && !['workspace_synced', 'awaiting_landing'].includes(parent.phase) ? parent : null
  }
  return null
}

/** 只选择同一候选仍未由owner新P1处理的真实诊断；复审与基础设施失败均不结算它。 */
function pendingReadonlyRepair(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, approved: ApprovedElaboration | null): { repair: ReadonlyOwnerRepair; owners: ReadonlyOwnerRepair['owners'] } | null {
  if (!approved) return null
  const history = readonlyElaborationHistory(store, operation)
  const generations = history.attempts.filter(prior => prior.number < attempt.number).flatMap(prior => {
    const result = history.read<SavedGeneration>(prior, 'generation')
    return result?.candidate && reuseBehaviorDependentStages(store, operation, prior, history.checkpoints(prior)) ? [{ prior, result }] : []
  })
  const candidate = generations.at(-1)?.result.candidate
  if (!candidate) return null
  if (candidate.sourceInputId !== operation.input.id) fail('readonly_spec_repair_binding', '最新候选不属于当前冻结输入，不能清除待处理诊断')
  verifyCandidate(operation.input.source.commonDir, candidate)
  const candidateDigest = candidate.digest
  for (const { prior, result } of generations) {
    if (result.candidate?.digest !== candidateDigest || prior.failure?.kind !== 'repairable' && !(prior.status === 'superseded' && prior.failure === null) || !['failed', 'superseded', 'settled'].includes(prior.status)) continue
    const repair = readonlyRepairFromAttempt(store, operation, prior, history.checkpoints)
    if (!repair) continue
    const owners: ReadonlyOwnerRepair['owners'] = []
    for (const owner of repair.owners) {
      const response = approved.lineage.flatMap(base => {
        const saved = base.result.partitionEvidence?.find(item => item.partitionId === owner.partitionId && item.resultRef.sha256 !== owner.resultRef.sha256)
        const result = saved && JSON.parse(readEvidence(operation.input.source.commonDir, saved.resultRef).toString('utf8')) as SavedElaboration | undefined
        return saved && result?.readonlySpecRepair?.generationRef.sha256 === repair.generationRef.sha256 && result.readonlySpecRepair.acceptedRef.sha256 === owner.resultRef.sha256 ? [{ base, saved }] : []
      }).at(-1)
      if (response) {
        const origin = history.attempts.find(origin => origin.number > prior.number && readonlyLocalSource(store, operation, origin, owner.key, response.saved.resultRef, response.base.resultRef, history))
        if (!origin) fail('readonly_spec_repair_binding', '诊断结算缺少该owner的新P1来源')
        const reviewed = reviewedReadonlyLocal(store, operation, origin, owner.key, response.saved.resultRef, response.base.resultRef, prior.number, history)
        const original = JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration
        if (canonical(reviewed.partitionBinding) !== canonical(original.partitionBinding) || reviewed.readonlySpecRepair?.baseInputDigest !== (original.gapRepair?.baseInputDigest ?? original.readonlySpecRepair?.baseInputDigest ?? original.inputDigest)) fail('readonly_spec_repair_binding', '诊断结算改变了原owner完整输入绑定')
        continue
      }
      const current = approved.result.partitionEvidence?.find(item => item.partitionId === owner.partitionId)
      if (!current || current.resultRef.sha256 !== owner.resultRef.sha256) fail('readonly_spec_repair_binding', '待处理owner缺失或已换ref，不能以另一source响应清除诊断')
      owners.push(owner)
    }
    if (owners.length) return { repair, owners }
  }
  return null
}

function saveStage(store: SyncStore, fence: WriteFence, name: string, value: unknown, basis?: Pick<Stage, 'readSetDigest' | 'baselineSelectionRef'>, composition?: ElaborationComposedBinding): BlobRef {
  const operation = store.readOperation(fence.operationId), commonDir = operation.input.source.commonDir
  const resultRef = writeEvidence(commonDir, value)
  const artifacts = syncCheckpointArtifacts(value, resultRef)
  const bindings = basis ? { readSetDigest: basis.readSetDigest, baselineSelectionRef: basis.baselineSelectionRef } : operation.baselineSelection ? { readSetDigest: operation.readSetDigest, baselineSelectionRef: writeEvidence(commonDir, store.readBusinessBaselineSelection(operation.id)) } : {}
  const guidance = behaviorAnalysisStage(name) && (value as CodeBehaviorAnalysis).reviewPassed === true ? { guidanceContractVersion: (value as CodeBehaviorAnalysis).guidanceContractVersion ?? LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION } : {}
  if (bindings.baselineSelectionRef) artifacts.push({ kind: 'json', ref: bindings.baselineSelectionRef })
  store.checkpoint(fence, { ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: fence.attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest, ...bindings, ...guidance, ...composition, stage: name, resultRef } satisfies Stage), artifacts })
  return resultRef
}
function analysisStageBinding(store: SyncStore, operation: SyncOperation, analysis: CodeBehaviorAnalysis, readIndex: (attempt: SyncAttempt) => SyncCheckpointStageView = attempt => readStageCheckpoints(store, operation, attempt)): Stage | null {
  const digest = contentHash(JSON.stringify(analysis))
  for (const attempt of store.listAttempts(operation.id)) for (const { value } of readIndex(attempt).json) {
    const saved = value as Stage
    if (saved.version !== 'sync-stage-v1' || saved.stage !== 'analysis' || saved.operationId !== operation.id || saved.attemptId !== attempt.id || saved.inputId !== operation.input.id || saved.policyDigest !== operation.policyDigest || saved.resultRef?.sha256 !== digest) continue
    if (!operation.baselineSelection) return analysis.readSetDigest === operation.readSetDigest && analysis.baselinePairId === (operation.previousBaselinePair?.id ?? null) ? saved : null
    if (!stageSelectionMatches(store, operation, saved) || saved.readSetDigest !== analysis.readSetDigest || !saved.baselineSelectionRef) continue
    const selected = JSON.parse(readEvidence(operation.input.source.commonDir, saved.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
    if (analysis.baselineSelectionDigest === selected.digest && analysis.baselinePairId === null) return saved
  }
  return null
}
function behaviorCandidateDigest(analysis: CodeBehaviorAnalysis): string {
  const { reviewDiagnosticRef: _diagnostic, ...pending } = analysis
  return contentHash(JSON.stringify({ ...pending, traces: [], reviewPassed: false }))
}

/** 批准只来自原局部分析与独审，未生成旧whole也可认证。 */
function authenticateApprovedBehaviorPartition(store: SyncStore, source: SyncOperation, origin: SyncAttempt, key: string, local: CodeBehaviorAnalysis, changedPaths: readonly string[], selection: FrozenBaselineSelection | undefined, checkpoints: (attempt: SyncAttempt) => SyncCheckpointStageView, analysisSchemaDigest?: string, nativeOnly = false, authorization?: P0ReviewAuthorization, readCompletedRecord?: (id: string) => NativeRunRecord | null): boolean {
  const original = checkpoints(origin), commonDir = source.input.source.commonDir
  const { reviewDiagnosticRef } = local
  const analysisDigest = behaviorCandidateDigest(local)
  if (!local.reviewPassed || local.traces.length !== 2 || local.traces[0].purpose !== 'code_behavior_analyze' || local.traces[1].purpose !== 'code_behavior_review' || local.traces[0].sessionId === local.traces[1].sessionId || local.traces[0].threadId === local.traces[1].threadId) return false
  const authorizedDiagnostic = authorization?.challenge.version === 'p0-review-challenge-v2'
    ? readP0ReviewDiagnostic(authorization.operationId, commonDir, authorization.challenge) : undefined
  if (authorizedDiagnostic && reviewDiagnosticRef?.sha256 !== authorizedDiagnostic.ref.sha256) return false
  let reviewOutput: unknown, requiredCheckedPaths: readonly string[] | undefined
  if (stage<{ version: string }>(store, source, origin, 'behavior-draft-protocol', 'automatic', original)?.version === 'code-behavior-draft-v1') {
    const continuation = partitionStage<CodeBehaviorContinuation>(store, source, origin, `${key}:continuation`, selection, original)?.result
    if (local.crossFreezeAuthor ? !authenticateCrossFreezeP0Author(store, source, origin, key, local, changedPaths, continuation)
      || !behaviorTraceBinding(store, source, origin, key, local.traces[1], selection, checkpoints, true, true, readCompletedRecord ?? readRecord)
      : !local.traces.every(trace => behaviorTraceBinding(store, source, origin, key, trace, selection, checkpoints, true, nativeOnly || !!authorizedDiagnostic, readCompletedRecord))) return false
    const drafts = continuation?.drafts, draft = drafts?.code_behavior_review
    if (reviewDiagnosticRef) {
      const request = JSON.parse(readEvidence(commonDir, continuation!.reviewResult!.requestRef).toString('utf8')) as ElaborationSessionRequest
      const context = readCodeBehaviorContext(request, commonDir)
      const diagnostic = context.operatorReviewDiagnostic
      if (diagnostic?.ref.sha256 !== reviewDiagnosticRef.sha256 || context.pendingAnalysis?.analysisDigest !== analysisDigest
        || (authorizedDiagnostic ? canonical(diagnostic) !== canonical(authorizedDiagnostic) : !p0ReviewDiagnosticMatches(commonDir, diagnostic))) return false
      if (authorizedDiagnostic && (!context.requiredCheckedPaths || canonical(context.task.requiredChangedPaths) !== canonical(changedPaths))) return false
      requiredCheckedPaths = context.requiredCheckedPaths
    }
    if (!draft || analysisSchemaDigest !== undefined && !local.crossFreezeAuthor && drafts.code_behavior_analyze?.schemaDigest !== analysisSchemaDigest
      || (nativeOnly || local.crossFreezeAuthor || analysisSchemaDigest !== undefined || requiredCheckedPaths) && draft.schemaDigest !== contentHash(JSON.stringify(codeBehaviorReviewSchema(local.inputDigest, analysisDigest, requiredCheckedPaths)))) return false
    reviewOutput = JSON.parse(readStageDraft(commonDir, draft, draft))
  } else {
    if (analysisSchemaDigest !== undefined || nativeOnly || reviewDiagnosticRef) return false
    for (const trace of local.traces) {
      const requestKey = `sync:${origin.id}:analysis:partition:${key.slice('partition:'.length, -':analysis'.length)}:${trace.purpose}`
      const dispatch = origin.dispatchPlans.find(item => item.key === requestKey && item.purpose === trace.purpose && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
      if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) return false
      const resource = store.findResource(origin.id, requestKey)
      let result: ElaborationSessionResult | undefined
      if (resource) {
        const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan
        const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString('utf8')) as NativeRunCheckpoint
        if (!checkpoint.result || !matchesNativeDispatchModel(source, dispatch, native.request) || inlineV1RepairScope(source) && native.request.worktree !== undefined) return false
        result = completedNativeStageResult(store, source, origin, native.request, trace, checkpoint.result.output, '') ?? undefined
      } else {
        const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, source, origin, `injected:${requestKey}`, 'automatic', original)
        if (injected?.requestDigest !== dispatch.requestDigest) return false
        result = injected.result
      }
      if (!result || result.sessionId !== trace.sessionId || result.threadId !== trace.threadId || result.turnId !== trace.turnId || result.resultDigest !== trace.resultDigest || contentHash(JSON.stringify(result.output)) !== trace.resultDigest) return false
      if (trace.purpose === 'code_behavior_review') reviewOutput = result.output
    }
  }
  const review = reviewOutput as { inputDigest: string; analysisDigest: string; verdict: string; checkedPaths: string[]; checkedChangeIds: string[]; findings: unknown[] } | undefined
  return review?.verdict === 'accept' && review.inputDigest === local.inputDigest
    && review.analysisDigest === analysisDigest
    && Array.isArray(review.findings) && review.findings.length === 0 && Array.isArray(review.checkedPaths) && Array.isArray(review.checkedChangeIds) && new Set(review.checkedPaths).size === review.checkedPaths.length && changedPaths.every(path => review.checkedPaths.includes(path))
    && (!requiredCheckedPaths || requiredCheckedPaths.every(path => review.checkedPaths.includes(path)))
    && new Set(review.checkedChangeIds).size === review.checkedChangeIds.length && review.checkedChangeIds.length === local.changes.length && local.changes.every(change => review.checkedChangeIds.includes(change.id))
}

/** 同 owner 只受最近一次正式授权约束，所有祖先通过原 retryOf 链继承。 */
export function readP0ReviewChallenges(store: SyncStore, operation: SyncOperation) {
  const challenges = new Map<string, { operationId: string; challenge: P0ReviewChallenge }>()
  for (const source of retryOperationLineage(store, operation)) {
    for (const challenge of (source.p0ReviewChallenges ?? []).slice().reverse()) {
      if (challenge.version !== 'p0-review-challenge-v1' && challenge.version !== 'p0-review-challenge-v2') fail('sync_p0_challenge_binding', '持久复审授权版本不受支持')
      if (!challenges.has(challenge.partitionId)) challenges.set(challenge.partitionId, { operationId: source.id, challenge })
    }
  }
  return challenges
}

type P0ReviewChallenges = ReturnType<typeof readP0ReviewChallenges>
type P0ReviewAuthorization = NonNullable<ReturnType<P0ReviewChallenges['get']>>

function behaviorChallengesAnswered(analysis: CodeBehaviorAnalysis | null, challenges: P0ReviewChallenges): boolean {
  return [...challenges.values()].every(({ challenge }) => analysis?.partitionEvidence?.some(local =>
    local.partitionId === challenge.partitionId && local.analysis.reviewDiagnosticRef?.sha256 === challenge.diagnosticRef.sha256))
}

/** 阶段预检只读取真实冻结来源、已批准原件与曾有的 Native 派发。 */
export async function prepareP0ReviewChallenge(store: SyncStore, operation: SyncOperation, plan: SyncCoordinatorPlan, request: P0ReviewChallengeRequest & { evidencePaths: readonly string[] }): Promise<P0ReviewChallenge> {
  function reject(message: string): never { return fail('sync_p0_challenge_binding', message) }
  if (plan.version !== 'sync-coordinator-v2' || plan.agentWorkflow !== 'native-worktree-v1' || syncPlanDigest(plan) !== operation.policyDigest
    || !operation.baselineSelection || operation.revision !== request.expectedRevision || operation.input.id !== request.inputId) reject('复审须绑定当前 revision 与同一冻结原生分区输入和计划')
  if (operation.control !== 'pause' || operation.phase !== 'paused') fail('sync_p0_challenge_unsettled', '复审前须正式暂停并结算原操作')
  const commonDir = operation.input.source.commonDir, selection = store.readBusinessBaselineSelection(operation.id)
  const scopeDigest = contentHash(canonical(operation.scope))
  const view = await readInput(operation.input, plan, operation.previousBaselinePair, operation.requestBlob, selection, operation.scope.paths)
  if (view.readSetDigest !== operation.readSetDigest) reject('原冻结 P0 读集已变化')
  const key = `partition:${request.partitionId}:analysis`
  const sources = [operation, ...behaviorContinuationLineage(store, operation, scopeDigest)]
  const indexes = new Map<string, SyncCheckpointStageView>()
  const checkpoints = (attempt: SyncAttempt): SyncCheckpointStageView => {
    const saved = indexes.get(attempt.id) ?? readSyncCheckpointStageIndex(store, store.readOperation(attempt.operationId), attempt)
    indexes.set(attempt.id, saved)
    return saved
  }
  const currentChallenge = readP0ReviewChallenges(store, operation).get(request.partitionId)?.challenge
  let currentApproval: BlobRef | undefined
  for (const source of sources) for (const origin of store.listAttempts(source.id).reverse()) {
    if (!['failed', 'superseded', 'settled'].includes(origin.status) || canonical(origin.composedInput) !== canonical(view.composed)) continue
    const index = checkpoints(origin), local = partitionStage<CodeBehaviorAnalysis>(store, source, origin, key, selection, index)
    if (!local) continue
    currentApproval ??= local.resultRef
    if (currentApproval.sha256 !== request.analysisRef.sha256 || currentChallenge && local.result.reviewDiagnosticRef?.sha256 !== currentChallenge.diagnosticRef.sha256) reject('申请须匹配该 owner 当前有效的局部批准')
    if (local.resultRef.sha256 !== currentApproval.sha256) reject('没有当前局部批准的原 Native 生产者')
    const partitionPlan = partitionStage<SyncPartitionPlan>(store, source, origin, 'partition-plan', selection, index)
    const owner = partitionPlan?.result.partitions.find(partition => partition.id === request.partitionId)
    if (!owner || !partitionPlan || local.result.composedDigest !== view.composed.contentDigest || local.result.readSetDigest !== operation.readSetDigest
      || local.result.inputId !== operation.input.id || local.result.policyDigest !== operation.policyDigest) reject('局部批准与原计划、组合、读集或输入失配')
    if (stage<BehaviorContinuationProvenance>(store, source, origin, `${key}:provenance`, 'automatic', index)) continue
    const continuation = partitionStage<CodeBehaviorContinuation>(store, source, origin, `${key}:continuation`, selection, index)
    const protocol = stage<{ contextTransport?: CodeBehaviorContextTransport }>(store, source, origin, 'behavior-draft-protocol', 'automatic', index)
    if (protocol?.contextTransport !== 'git-json-v6' || !continuation?.result.reviewResult
      || !continuation.result.readyAnalysis && !continuation.result.crossFreezeAuthor
      || !authenticateApprovedBehaviorPartition(store, source, origin, key, local.result, owner.changedPaths, selection, checkpoints, undefined, true)) {
      reject('原局部批准缺少当前原生协议、独立审查或精确 Git 草稿')
    }
    const reviewRequest = JSON.parse(readEvidence(commonDir, continuation.result.reviewResult.requestRef).toString('utf8')) as ElaborationSessionRequest
    const reviewContext = readCodeBehaviorContext(reviewRequest, commonDir)
    const pendingAnalysis = reviewContext.pendingAnalysis
    if ((reviewContext.task.partition as { id: string }).id !== request.partitionId
      || !pendingAnalysis || pendingAnalysis.analysisDigest !== behaviorCandidateDigest(local.result)
      || pendingAnalysis.analysisDigest !== contentHash(JSON.stringify(pendingAnalysis.analysis))) reject('原独审未审此 owner 的待审原件')
    const approvalCheckpointRef = index.json.find(({ value }) => {
      const wrapper = value as Stage
      return wrapper.stage === key && wrapper.resultRef?.sha256 === local.resultRef.sha256
    })?.ref
    if (!approvalCheckpointRef) reject('局部批准没有原阶段引用')
    if (!reviewRequest.worktree) return reject('原待审候选没有冻结 Git 树')
    const readable = new Set(readTree(commonDir, reviewRequest.worktree.tree).map(entry => entry.path))
    const missing = request.evidencePaths.filter(path => !readable.has(path))
    if (missing.length) return reject(`复审证据不在原待审冻结 Git 树：${JSON.stringify(missing)}`)
    return { version: 'p0-review-challenge-v2', requestId: request.requestId, expectedRevision: request.expectedRevision, inputId: request.inputId, partitionId: request.partitionId,
      analysisRef: local.resultRef, diagnosticRef: p0ReviewDiagnosticRef(request), scopeDigest,
      origin: { operationId: source.id, attemptId: origin.id, approvalCheckpointRef, continuationRef: continuation.resultRef, partitionPlanRef: partitionPlan.resultRef, analysisDigest: pendingAnalysis.analysisDigest } }
  }
  return reject('指定分区没有当前已批准且可冷验的原生局部分析')
}

/** 核验待复审局部结果保留同一 Git 作者和已完成的独立只读拒绝。 */
function p1ChallengedReviewSource(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, result: SavedElaboration) {
  const round = result.rounds.at(-1), binding = result.partitionBinding
  const review = round?.traces.find(trace => trace.purpose === 'elaboration_review')
  const author = round?.traces.find(trace => trace.purpose === 'elaboration_generate')
  if (!binding || !round?.draft || !round.candidate || !review || !author || round.traces.length !== 2
    || result.status !== 'exhausted' || result.failure?.code !== 'repair_budget_exhausted'
    || !result.structurePassed || result.reviewPassed || round.review?.verdict !== 'repair'
    || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== result.candidateDigest
    || round.candidateDigest !== contentHash(JSON.stringify(round.candidate))
    || canonical(round.review) !== canonical({ ...(round.reviewOutput as object), inputDigest: result.inputDigest, candidateDigest: result.candidateDigest })
    || author.sessionId === review.sessionId || author.threadId === review.threadId) return null
  const dispatch = prior.dispatchPlans.find(item => item.purpose === review.purpose
    && canonical(item.session) === canonical({ sessionId: review.sessionId, threadId: review.threadId, turnId: review.turnId }))
  if (!dispatch) return null
  const scope = frozenAnalysisScope.getStore() ?? { active: true, operationId: owner.id, inputId: owner.input.id,
    source: canonical(owner.input.source), policyDigest: owner.policyDigest, refs: new Set<string>() }
  const { generation, reviewed } = frozenAnalysisScope.run({ ...scope, readNativeRecord: readRecord }, () => ({
    generation: elaborationGenerationSource(store, owner, prior, round, result),
    reviewed: authenticatedDraftResult(store, owner, prior, dispatch.key, review.purpose),
  }))
  if (!generation?.request || reviewed?.request?.worktree?.mode !== 'read' || !reviewed.result?.worktree
    || reviewed.result.worktree.headCommit !== reviewed.request.worktree.baseCommit || reviewed.result.worktree.tree !== reviewed.request.worktree.tree
    || reviewed.request.inputDigest !== review.inputDigest
    || reviewed.result.resultDigest !== review.resultDigest || canonical(reviewed.result.output) !== canonical(round.reviewOutput)) return null
  verifyStageResult(owner.input.source.commonDir, reviewed.request.worktree, reviewed.result)
  for (const request of [generation.request, reviewed.request]) {
    const isAuthor = request.purpose === 'elaboration_generate'
    const expectedDigest = isAuthor ? round.crossFreezeAuthor?.oldInputDigest ?? result.inputDigest : result.inputDigest
    const origin = isAuthor ? generation.attempt : prior
    if (!matchesAttemptNativeModel(isAuthor ? generation.owner : owner, origin, request)
      || request.root !== owner.input.source.canonicalRoot || request.frozenContext || !request.worktree
      || request.base !== request.worktree.baseCommit || request.worktree.mode !== (isAuthor ? 'edit' : 'read')
      || request.inputDigest !== elaborationNativeInputDigest(expectedDigest, request)
      || !request.requestKey.startsWith(`sync:${origin.id}:elaborate:partition:${binding.partitionId}:`)) return null
  }
  return { round, request: reviewed.request, failure: result.failure }
}

/** 复审授权绑定当前同源分区结果、原独审和候选，不运行模型或改变原稿。 */
export async function prepareP1ReviewChallenge(store: SyncStore, operation: SyncOperation, plan: SyncCoordinatorPlan, request: P1ReviewChallengeRequest): Promise<P1ReviewChallenge> {
  const reject = (message: string): never => fail('sync_p1_challenge_binding', message)
  if (plan.version !== 'sync-coordinator-v2' || plan.agentWorkflow !== 'native-worktree-v1'
    || syncPlanDigest(plan) !== operation.policyDigest || !operation.baselineSelection || operation.id !== request.operationId
    || operation.revision !== request.expectedRevision || operation.input.id !== request.inputId) return reject('复审须绑定当前操作、同一冻结原生分区输入和计划')
  if (operation.control !== 'pause' || operation.phase !== 'paused') fail('sync_p1_challenge_unsettled', '复审前须正式暂停并结算原操作')
  const commonDir = operation.input.source.commonDir, selection = store.readBusinessBaselineSelection(operation.id)
  const view = await readInput(operation.input, plan, operation.previousBaselinePair, operation.requestBlob, selection, operation.scope.paths)
  if (view.readSetDigest !== operation.readSetDigest) return reject('原冻结 P1 读集已变化')
  const key = `partition:${request.partitionId}:elaboration`
  for (const prior of store.listAttempts(operation.id).reverse()) {
    const index = readSyncCheckpointStageIndex(store, operation, prior)
    const local = partitionStage<SavedElaboration>(store, operation, prior, key, selection, index)
    if (!local) {
      if (prior.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${prior.id}:elaborate:partition:${request.partitionId}:`))) return reject('指定分区已有更新的派发，不能使用历史候选')
      continue
    }
    if (!['failed', 'superseded', 'settled'].includes(prior.status) || canonical(prior.composedInput) !== canonical(view.composed)
      || local.resultRef.sha256 !== request.resultRef.sha256 || local.result.candidateDigest !== request.candidateDigest
      || local.result.partitionBinding?.partitionId !== request.partitionId || local.result.phase === 'partitioned_final') return reject('申请须匹配该分区当前待复审的局部结果和候选')
    const partitionPlan = partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan', selection, index)
    if (!partitionPlan?.result.partitions.some(partition => partition.id === request.partitionId)) return reject('局部结果缺少原独审分区计划')
    const original = p1ChallengedReviewSource(store, operation, prior, local.result)
    if (!original?.request.worktree) return reject('局部结果缺少合法作者及已完成的独立只读拒绝')
    const existing = new Set(readTree(commonDir, original.request.worktree.tree).map(entry => entry.path))
    if (request.evidencePaths.some(path => !existing.has(path))) return reject('复审证据须在原独审冻结 Git 树')
    const reviewCheckpointRef = index.json.find(({ value }) => (value as Stage).stage === key && (value as Stage).resultRef?.sha256 === local.resultRef.sha256)?.ref
    if (!reviewCheckpointRef) return reject('局部结果缺少原检查点引用')
    return { version: 'p1-review-challenge-v1', requestId: request.requestId, expectedRevision: request.expectedRevision,
      inputId: request.inputId, partitionId: request.partitionId, resultRef: local.resultRef, candidateDigest: request.candidateDigest,
      diagnosticRef: p1ReviewDiagnosticRef(request), scopeDigest: contentHash(canonical(operation.scope)),
      origin: { operationId: operation.id, attemptId: prior.id, reviewCheckpointRef, partitionPlanRef: partitionPlan.resultRef } }
  }
  return reject('指定分区没有当前待复审的局部结果')
}

type ApprovalSourceLineage = { ancestors?: SyncOperation[]; settled: Set<string> }
type ApprovedBehaviorPartition = NonNullable<CodeBehaviorAnalysis['partitionEvidence']>[number]
type ApprovalSourceOptions = {
  expectedReadSetDigest: string; expectedComposedDigest: string
  frozenLegacy?: boolean; inline?: boolean; analysisSchemaDigest?: string; authorization?: P0ReviewAuthorization
}

function* approvedBehaviorPartitionSource(store: SyncStore, operation: SyncOperation, ownerOperation: SyncOperation, origin: SyncAttempt, planDigest: string, member: ApprovedBehaviorPartition, selection: FrozenBaselineSelection | undefined, checkpoints: (attempt: SyncAttempt) => SyncCheckpointStageView, lineage: ApprovalSourceLineage, options: ApprovalSourceOptions): Generator<void, string | SyncAttempt> {
  const { expectedReadSetDigest, expectedComposedDigest, frozenLegacy, inline, authorization } = options
  if (authorization?.challenge.version === 'p0-review-challenge-v2' && authorization.challenge.origin.partitionPlanRef.sha256 !== planDigest) {
    return `原P0 owner复审授权未绑定精确分区计划: ${member.partitionId}`
  }
  const key = `partition:${member.partitionId}:analysis`, usage = frozenLegacy ? 'evidence' : 'automatic'
  for (;;) {
    const original = checkpoints(origin)
    const oldPlan = partitionStage<SyncPartitionPlan>(store, ownerOperation, origin, 'partition-plan', selection, original)
    const local = partitionStage<CodeBehaviorAnalysis>(store, ownerOperation, origin, key, selection, original, undefined, usage)
    if (oldPlan?.resultRef.sha256 !== planDigest || local?.resultRef.sha256 !== member.analysisRef.sha256 || origin.composedInput?.contentDigest !== expectedComposedDigest) return `原P0 owner的计划、local或组合输入失配: ${member.partitionId}`
    if (frozenLegacy) {
      const wrapper = original.json.map(({ value }) => value as Stage).find(value => value.stage === key && value.resultRef?.sha256 === member.analysisRef.sha256)
      if (wrapper?.guidanceContractVersion !== LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION || local.result.guidanceContractVersion !== undefined
        || local.result.inputId !== operation.input.id || local.result.policyDigest !== operation.policyDigest || local.result.readSetDigest !== expectedReadSetDigest || local.result.composedDigest !== expectedComposedDigest) return `原P0 owner缺少原v4/v7及完整冻结输入: ${member.partitionId}`
    }
    const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, ownerOperation, origin, `${key}:provenance`, 'automatic', original)
    if (!provenance) {
      const protocol = frozenLegacy && stage<{ version: string; contextTransport?: CodeBehaviorContextTransport }>(store, ownerOperation, origin, 'behavior-draft-protocol', 'evidence', original)
      if (inline && protocol !== null) return `原inline P0 owner存在草稿协议: ${member.partitionId}`
      if (frozenLegacy && !inline && (!protocol || protocol.version !== 'code-behavior-draft-v1' || protocol.contextTransport !== 'git-json-v4')) return `原P0 owner真实生产者缺少原v4协议: ${member.partitionId}`
      break
    }
    if (provenance.resultRef.sha256 !== member.analysisRef.sha256) return `原P0 owner provenance改变local摘要: ${member.partitionId}`
    const previous = store.readAttempt(provenance.fromAttemptId)
    if (inline && (provenance.fromOperationId !== operation.id || previous.operationId !== operation.id))
      return `原inline P0 owner provenance必须属于同operation: ${member.partitionId}`
    if (previous.operationId !== provenance.fromOperationId || !['failed', 'superseded', 'settled'].includes(previous.status)) return `原P0 owner provenance未正式结算: ${member.partitionId}`
    if (previous.operationId === ownerOperation.id) {
      if (previous.number >= origin.number) return `原P0 owner provenance不是严格更早来源: ${member.partitionId}`
    } else {
      lineage.ancestors ??= [...retryOperationLineage(store, operation)]
      const currentPosition = lineage.ancestors.findIndex(candidate => candidate.id === ownerOperation.id), previousPosition = lineage.ancestors.findIndex(candidate => candidate.id === previous.operationId)
      if (currentPosition < 0 || previousPosition <= currentPosition) return `原P0 owner没有严格更早的正式retryOf来源: ${member.partitionId}`
      for (const ancestor of lineage.ancestors.slice(currentPosition + 1, previousPosition + 1)) {
        if (lineage.settled.has(ancestor.id)) continue
        if (!settledApprovalSource(store, ancestor) || frozenLegacy && (canonical(ancestor.input) !== canonical(operation.input) || ancestor.planBlob?.sha256 !== operation.planBlob?.sha256)) return `原P0 owner正式祖先未结算或冻结身份已改变: ${member.partitionId}`
        lineage.settled.add(ancestor.id)
        yield
      }
      const ancestor = lineage.ancestors[previousPosition]
      ownerOperation = withCheckpointStageBasis(ancestor, expectedReadSetDigest, selection)
    }
    origin = previous
  }
  if (!authenticateApprovedBehaviorPartition(store, ownerOperation, origin, key, member.analysis, member.changedPaths, selection, checkpoints, options?.analysisSchemaDigest, false, authorization)) return `原P0 owner分析或独审的Native/Git原件失配: ${member.partitionId}`
  return origin
}

/** 逐分区冷验原审批，历史文件仅作为尚待当前独审的作者材料。 */
function historicalBehaviorAuthor(store: SyncStore, source: CrossFreezeSource, partitionId: string, changedPaths: readonly string[]) {
  const old = source.operation, commonDir = old.input.source.commonDir
  if (readP0ReviewChallenges(store, old).has(partitionId)) return null
  const indexes = new Map<string, SyncCheckpointStageView>()
  const indexFor = (attempt: SyncAttempt): SyncCheckpointStageView => {
    const existing = indexes.get(attempt.id)
    if (existing) return existing
    const index = readSyncCheckpointStageIndex(store, attempt.operationId === old.id ? old : store.readOperation(attempt.operationId), attempt)
    indexes.set(attempt.id, index)
    return index
  }
  const key = `partition:${partitionId}:analysis`
  for (const attempt of [...source.attempts].reverse()) {
    const index = indexFor(attempt)
    const wrapper = index.json.map(({ value }) => value as Stage).find(value => value.version === 'sync-stage-v1' && value.stage === key)
    if (!wrapper) {
      const failed = stage<PartitionAnalysisFailures>(store, old, attempt, 'partition:analysis-failures', 'evidence', index, () => true)
      if (failed?.failures.some(failure => failure.partitionId === partitionId)) return null
      continue
    }
    const selection = wrapper.baselineSelectionRef
      ? JSON.parse(readEvidence(commonDir, wrapper.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection : undefined
    if (!wrapper.readSetDigest || !attempt.composedInput) return null
    const owner = withCheckpointStageBasis(old, wrapper.readSetDigest, selection)
    const plan = partitionStage<SyncPartitionPlan>(store, owner, attempt, 'partition-plan', selection, index)
    const local = partitionStage<CodeBehaviorAnalysis>(store, owner, attempt, key, selection, index)
    const partition = plan?.result.partitions.find(item => item.id === partitionId)
    if (!plan || !partition || !local?.result.reviewPassed || local.result.traces[1]?.purpose !== 'code_behavior_review'
        || local.result.guidanceContractVersion !== CODE_BEHAVIOR_GUIDANCE_VERSION
        || canonical([...partition.changedPaths].sort()) !== canonical([...changedPaths].sort())
        || local.result.inputId !== old.input.id || local.result.policyDigest !== old.policyDigest) return null
    const origin = finishApprovalProof(approvedBehaviorPartitionSource(store, old, owner, attempt, plan.resultRef.sha256,
      { partitionId, changedPaths: [...changedPaths], analysisRef: local.resultRef, analysis: local.result },
      selection, indexFor, { settled: new Set() }, { expectedReadSetDigest: wrapper.readSetDigest, expectedComposedDigest: attempt.composedInput.contentDigest }))
    if (typeof origin === 'string' || origin.operationId !== old.id || !source.attempts.some(item => item.id === origin.id)) return null
    const continuation = partitionStage<CodeBehaviorContinuation>(store, owner, origin, `${key}:continuation`, selection, indexFor(origin))?.result
    const draft = continuation?.drafts.code_behavior_analyze, ready = continuation?.readyAnalysis
    if (!draft || !ready || ready.draftOid !== draft.oid || ready.resultCommit !== draft.resultCommit || ready.trace.purpose !== 'code_behavior_analyze'
        || canonical(ready.trace) !== canonical(local.result.traces[0]) || draft.sourceInputId !== old.input.id
        || !authenticateApprovedBehaviorPartition(store, owner, origin, key, local.result, changedPaths, selection, indexFor, draft.schemaDigest, true, undefined, readRecord)) return null
    return { old, origin, draft, authorTrace: ready.trace, reviewTrace: local.result.traces[1], analysisRef: local.resultRef, analysis: local.result }
  }
  return null
}

type SavedCrossFreezeP0Impact = {
  version: 'cross-freeze-p0-impact-v1'
  sourceRef: BlobRef
  currentInputDigest: string
  checkedPaths: string[]
  worktree: StageWorktree
  timeoutMs: ElaborationSessionRequest['timeoutMs']
  evidence: CrossFreezeImpactEvidence
}

function authenticateCrossFreezeImpact(
  store: SyncStore, operation: SyncOperation, origin: SyncAttempt, prepared: CrossFreezeImpactReview,
  trace: ElaborationTrace, output: unknown, readRecordForResult: (id: string) => NativeRunRecord | null = readRecord,
): CrossFreezeImpactEvidence {
  const resource = store.findResource(origin.id, prepared.request.requestKey)
  const request = resource
    ? (JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan).request
    : prepared.request
  const result = completedNativeStageResult(store, operation, origin, prepared.request, trace, output, '',
    readSyncCheckpointStageIndex(store, operation, origin), resource ? readRecordForResult : undefined)
  if (!result) fail('cross_freeze_native_binding', '影响复核缺少本轮绑定的 Native 结算')
  return verifyCrossFreezeImpactReview(prepared, result, { request, result })
}

/** 影响复核失败仅在同一正式原件已经结算时进入同稿续审。 */
async function runCrossFreezeImpact(
  runner: ElaborationRunner, store: SyncStore, operation: SyncOperation, attemptId: string,
  prepared: CrossFreezeImpactReview, signal: AbortSignal, assertFence: () => void,
  recordRetry: (checkpointRef: BlobRef) => void, readNativeRecord: (id: string) => NativeRunRecord | null = readRecord,
): Promise<CrossFreezeImpactEvidence> {
  const key = prepared.request.requestKey
  let result: ElaborationSessionResult
  try { result = await runner({ ...prepared.request, signal }) }
  catch (error) {
    if (!(error instanceof StructuredSessionError) || !reviewFormatRepairCodes.has(error.code) || signal.aborted) throw error
    assertFence()
    const resource = store.findResource(attemptId, key)
    if (!resource || resource.phase !== 'removed' || !error.sessionId) throw error
    authenticateNativeFailure(store, operation, store.readAttempt(attemptId), key, {
      code: error.code, message: error.message, sessionId: error.sessionId, threadId: error.threadId, turnId: error.turnId,
    })
    recordRetry(resource.checkpointRef)
    return fail('cross_freeze_impact_review_retry', '影响复核格式失败，保留原 Git 稿并续同一材料的独审', [resource.checkpointRef])
  }
  const trace: ElaborationTrace = { purpose: prepared.request.purpose, sessionId: result.sessionId, threadId: result.threadId,
    turnId: result.turnId, resultDigest: result.resultDigest, inputDigest: prepared.request.inputDigest }
  assertFence()
  try { return authenticateCrossFreezeImpact(store, operation, store.readAttempt(attemptId), prepared, trace, result.output, readNativeRecord) }
  catch (error) {
    if (!(error instanceof CrossFreezeImpactVerdictError)) throw error
    const resource = store.findResource(attemptId, key)
    if (!resource || resource.phase !== 'removed') throw error
    recordRetry(resource.checkpointRef)
    return fail('cross_freeze_impact_review_retry', error.message, [resource.checkpointRef])
  }
}

type CrossFreezeImpactRetry = {
  version: 'cross-freeze-impact-retry-v1'
  sourceRef: BlobRef
  authorRef: BlobRef
  currentInputDigest: string
  checkpointRef: BlobRef
}

function matchesCrossFreezeImpactRetry(
  previous: CrossFreezeImpactRetry | null, sourceRef: BlobRef, authorRef: BlobRef, currentInputDigest: string,
): boolean {
  return previous?.version === 'cross-freeze-impact-retry-v1' && previous.sourceRef.sha256 === sourceRef.sha256
    && previous.authorRef.sha256 === authorRef.sha256 && previous.currentInputDigest === currentInputDigest
}

function readLockedCrossFreezeSource(store: SyncStore, operation: SyncOperation) {
  if (!operation.crossFreezeBinding) return null
  const selected = lockCrossFreezeSource(store, operation, {
    load: () => operation.crossFreezeBinding!.ref,
    save: () => fail('cross_freeze_binding', '冷验不得重新选择跨冻结来源'),
  })
  if (!selected.source || !selected.binding || !selected.bindingRef
    || operation.crossFreezeBinding.provenanceRef?.sha256 !== selected.binding.provenanceRef.sha256) return null
  return selected
}

function* crossFreezeRetryOwners(store: SyncStore, operation: SyncOperation): Generator<SyncOperation> {
  yield operation
  if (!operation.retryOf) return
  const selection = canonical(store.readBusinessBaselineSelection(operation.id))
  for (const owner of retryOperationLineage(store, operation)) {
    if (owner.id === operation.id) continue
    if (!settledApprovalSource(store, owner) || canonical(owner.input) !== canonical(operation.input)
      || owner.readSetDigest !== operation.readSetDigest || owner.planBlob?.sha256 !== operation.planBlob?.sha256
      || owner.impactDigest !== operation.impactDigest || canonical(owner.scope) !== canonical(operation.scope)
      || canonical(store.readBusinessBaselineSelection(owner.id)) !== selection) return
    yield owner
  }
}

function findLockedCrossFreezeSource(store: SyncStore, operation: SyncOperation, bindingRef: BlobRef) {
  for (const owner of crossFreezeRetryOwners(store, operation)) {
    if (owner.crossFreezeBinding?.ref.sha256 !== bindingRef.sha256) continue
    const selected = readLockedCrossFreezeSource(store, owner)
    if (selected) return { owner, selected }
  }
  return null
}

/** 只以原分区失败记录选取既有来源，不替正式重试重新挑选旧冻结。 */
function pendingCrossFreezeImpactSource(store: SyncStore, operation: SyncOperation, key: string, inputDigest: string, composed: ComposedInputRef) {
  if (!operation.retryOf) return null
  for (const owner of crossFreezeRetryOwners(store, operation)) {
    if (owner.id === operation.id) continue
    for (const prior of store.listAttempts(owner.id).reverse()) {
      if (!['failed', 'superseded', 'settled'].includes(prior.status) || canonical(prior.composedInput) !== canonical(composed)) continue
      const retry = partitionStage<CrossFreezeImpactRetry>(store, owner, prior, `${key}:cross-freeze-impact-retry`)?.result
      if (retry?.version !== 'cross-freeze-impact-retry-v1' || retry.currentInputDigest !== inputDigest) continue
      const locked = findLockedCrossFreezeSource(store, owner, retry.sourceRef)
      if (!locked) fail('cross_freeze_native_binding', '跨冻结影响续审缺少原正式来源绑定')
      return locked
    }
  }
  return null
}

function* crossFreezeImpactHistory(store: SyncStore, operation: SyncOperation, current: SyncAttempt, bindingOwner: SyncOperation) {
  const start = current.operationId === operation.id ? operation : store.readOperation(current.operationId)
  for (const owner of crossFreezeRetryOwners(store, start)) {
    for (const prior of store.listAttempts(owner.id).reverse()) {
      if (prior.operationId === current.operationId && prior.number > current.number
        || prior.id !== current.id && !['failed', 'superseded', 'settled'].includes(prior.status)) continue
      yield { owner, prior }
    }
    if (owner.id === bindingOwner.id) return
  }
}

/** 续审只消费原只读请求的已结算格式拒绝，不能把旧裁决改签为本轮影响复核。 */
function authenticateCrossFreezeImpactRetry(
  store: SyncStore, operation: SyncOperation, origin: SyncAttempt, retry: CrossFreezeImpactRetry,
  input: (timeout: ElaborationSessionRequest['timeoutMs']) => Parameters<typeof restoreCrossFreezeImpactReview>[0],
  readNativeRecord: (id: string) => NativeRunRecord | null = readRecord,
): void {
  const commonDir = operation.input.source.commonDir
  const resource = store.listResources(origin.id).find(resource => resource.checkpointRef.sha256 === retry.checkpointRef.sha256)
  const dispatch = origin.dispatchPlans.find(dispatch => dispatch.purpose === CROSS_FREEZE_IMPACT_PURPOSE && dispatch.key === resource?.plan.key)
  if (resource?.phase !== 'removed' || resource.operationId !== operation.id || resource.generation !== origin.generation || !dispatch)
    fail('cross_freeze_native_binding', '影响复核续审缺少原已移除 Native 资源')
  const { request } = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(commonDir, retry.checkpointRef).toString('utf8')) as NativeRunCheckpoint
  if (request.worktree?.mode !== 'read' || request.frozenContext || request.frozenEntries
      || checkpoint.phase !== 'removed' || !checkpoint.nativeCallRequested || !checkpoint.nativeStarted)
    fail('cross_freeze_native_binding', '影响复核续审缺少原已执行并结算的只读阶段')
  const prepared = restoreCrossFreezeImpactReview(input(request.timeoutMs), request.worktree)
  if (!matchesScheduledNativeReview(operation, origin, dispatch, request, prepared.request))
    fail('cross_freeze_native_binding', '影响复核续审的原请求和 Git 只读材料不匹配')
  if (checkpoint.result) {
    verifyStageResult(commonDir, prepared.request.worktree, checkpoint.result)
    const { sessionId, threadId, turnId, resultDigest, output } = checkpoint.result
    const trace = { purpose: CROSS_FREEZE_IMPACT_PURPOSE, sessionId, threadId, turnId, resultDigest, inputDigest: request.inputDigest }
    try { authenticateCrossFreezeImpact(store, operation, origin, prepared, trace, output, readNativeRecord) }
    catch (error) { if (error instanceof CrossFreezeImpactVerdictError) return; throw error }
    fail('cross_freeze_native_binding', '有效的原影响裁决不能作为格式拒绝续审')
  }
  const { failure, session, stop } = checkpoint
  if (!failure || !reviewFormatRepairCodes.has(failure.code) || stop?.nativeStopped !== true)
    fail('cross_freeze_native_binding', '影响复核格式拒绝缺少原生停止凭证')
  authenticateNativeFailure(store, operation, origin, request.requestKey, { code: failure.code, message: failure.message,
    sessionId: session.sessionId, threadId: session.threadId ?? undefined, turnId: session.turnId ?? undefined })
}

function crossFreezeP0ImpactInput(
  operation: SyncOperation, attemptId: string, source: CrossFreezeSource, partitionId: string,
  author: NonNullable<ReturnType<typeof historicalBehaviorAuthor>>, seed: StageWorktree,
  readPaths: readonly string[], timeoutMs: ElaborationSessionRequest['timeoutMs'], rawRef: BlobRef,
): Parameters<typeof prepareCrossFreezeImpactReview>[0] {
  return {
    operation, attemptId, source, owner: partitionId, stage: 'p0', seed, timeoutMs, readPaths,
    prior: { attemptId: author.origin.id, candidateDigest: rawRef.sha256, resultRef: rawRef, approvalRef: author.analysisRef,
      author: author.authorTrace, reviewer: author.reviewTrace },
  }
}

function crossFreezeP0AuthorProof(
  author: NonNullable<ReturnType<typeof historicalBehaviorAuthor>>,
  partitionId: string, bindingRef: BlobRef, impactReviewRef: BlobRef,
): CodeBehaviorCrossFreezeAuthorProof {
  return {
    version: 'code-behavior-cross-freeze-author-v1', oldOperationId: author.old.id, oldAttemptId: author.origin.id,
    oldPartitionId: partitionId, oldResultRef: author.analysisRef, oldInputId: author.old.input.id,
    oldInputDigest: author.authorTrace.inputDigest, bindingRef, impactReviewRef,
  }
}

function readCrossFreezeP0Impact(
  store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, currentInputDigest: string,
  selected: NonNullable<ReturnType<typeof readLockedCrossFreezeSource>>,
  author: NonNullable<ReturnType<typeof historicalBehaviorAuthor>>,
  readRecordForResult?: (id: string) => NativeRunRecord | null,
  index = readSyncCheckpointStageIndex(store, operation, origin),
) {
  const original = partitionStage<SavedCrossFreezeP0Impact>(store, operation, origin, `${key}:cross-freeze-impact`, undefined, index)
  if (!original || original.result.currentInputDigest !== currentInputDigest) return null
  const { evidence, worktree, sourceRef, checkedPaths, timeoutMs } = original.result
  const partition = partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan', undefined, index)?.result.partitions.find(item => item.id === evidence.binding.owner)
  if (original.result.version !== 'cross-freeze-p0-impact-v1' || sourceRef.sha256 !== selected.bindingRef.sha256
      || !partition || key !== `partition:${partition.id}:analysis` ||
      canonical([...partition.readPaths].sort()) !== canonical(checkedPaths)
      || evidence.binding.seed.tree !== origin.composedInput?.tree
      || !store.findResource(origin.id, evidence.requestKey))
    fail('cross_freeze_native_binding', '保留的影响复核缺少同一个分区来源、当前树或正式 Native 资源')
  const rawRef = { sha256: contentHash(readStageDraft(operation.input.source.commonDir, author.draft, author.draft)) }
  const input = crossFreezeP0ImpactInput(operation, origin.id, selected.source, partition.id, author, evidence.binding.seed, checkedPaths, timeoutMs, rawRef)
  const prepared = restoreCrossFreezeImpactReview(input, worktree)
  const actual = authenticateCrossFreezeImpact(store, operation, origin, prepared, evidence.trace, evidence.output, readRecordForResult)
  if (canonical(actual) !== canonical(evidence)) fail('cross_freeze_native_binding', '保留影响复核与原 Native 结论不同')
  return { ...original, proof: crossFreezeP0AuthorProof(author, partition.id, sourceRef, original.resultRef) }
}

function authenticateCrossFreezeP0Author(
  store: SyncStore, operation: SyncOperation, owner: SyncAttempt, key: string, local: CodeBehaviorAnalysis,
  changedPaths: readonly string[], continuation: CodeBehaviorContinuation | undefined,
): boolean {
  const marker = local.crossFreezeAuthor
  if (!marker || canonical(continuation?.crossFreezeAuthor) !== canonical(marker) || continuation?.readyAnalysis
    || local.traces[0]?.inputDigest !== marker.oldInputDigest) return false
  const locked = findLockedCrossFreezeSource(store, operation, marker.bindingRef)
  if (!locked) return false
  const author = historicalBehaviorAuthor(store, locked.selected.source, marker.oldPartitionId, changedPaths)
  if (!author || canonical(author.authorTrace) !== canonical(local.traces[0])) return false
  for (const { owner: source, prior } of crossFreezeImpactHistory(store, operation, owner, locked.owner)) {
    const impact = readCrossFreezeP0Impact(store, source, prior, key, local.inputDigest, locked.selected, author)
    if (impact?.resultRef.sha256 !== marker.impactReviewRef.sha256 || canonical(impact.proof) !== canonical(marker)) continue
    const currentReviewer = local.traces[1]
    return impact.result.evidence.verdict === 'reuse' && [author.reviewTrace, impact.result.evidence.trace].every(trace =>
      trace.sessionId !== currentReviewer.sessionId && trace.threadId !== currentReviewer.threadId && trace.turnId !== currentReviewer.turnId)
  }
  return false
}

function historicalElaborationAuthor(store: SyncStore, source: CrossFreezeSource, partitionId: string) {
  const old = source.operation, commonDir = old.input.source.commonDir, key = `partition:${partitionId}:elaboration`
  for (const attempt of [...source.attempts].reverse()) {
    const index = readSyncCheckpointStageIndex(store, old, attempt)
    const wrapper = [...index.json].reverse().map(({ value }) => value as Stage).find(value => value.version === 'sync-stage-v1' && value.stage === key)
    if (!wrapper) continue
    if (!wrapper.readSetDigest || !attempt.composedInput) return null
    const selection = wrapper.baselineSelectionRef
      ? JSON.parse(readEvidence(commonDir, wrapper.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection : undefined
    const bound = withCheckpointStageBasis(old, wrapper.readSetDigest, selection)
    const saved = partitionStage<SavedElaboration>(store, bound, attempt, key, selection, index)
    if (!saved) return null
    const { result, resultRef } = saved, round = result.rounds.at(-1)
    const partition = partitionStage<SyncPartitionPlan>(store, bound, attempt, 'partition-plan', selection, index)
    if (!partition || result.partitionBinding?.partitionId !== partitionId || result.partitionBinding.planDigest !== partition.result.digest
      || result.phase || !result.structurePassed || !round?.candidate || !round.draft || round.crossFreezeAuthor || round.draft.sourceInputId !== old.input.id
      || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== result.candidateDigest
      || contentHash(JSON.stringify(round.candidate)) !== round.candidateDigest || round.review?.verdict === 'repair') return null
    const trace = round.traces.find(item => item.purpose === 'elaboration_generate')
    const generation = trace && elaborationGenerationSource(store, bound, attempt, round, result)
    if (!trace || !generation?.request || generation.owner.id !== old.id
      || !source.attempts.some(item => item.id === generation.attempt.id)
      || generation.request.inputDigest !== elaborationNativeInputDigest(result.inputDigest, generation.request)
      || !authenticatedDraftResult(store, bound, generation.attempt, generation.key, trace.purpose, round.draft, readRecord)) return null
    const reviewer = round.traces.find(item => item.purpose === 'elaboration_review')
    if (result.reviewPassed ? !reviewer || !authenticatedApprovedElaboration(store, bound, attempt, result, { allowDeferredImplementation: true })
      : !!round.review || !!round.reviewOutput || !result.failure) return null
    return { old, result, resultRef, draft: round.draft, trace, receipt: round.output, reviewer, generation }
  }
  return null
}

type HistoricalElaborationAuthor = NonNullable<ReturnType<typeof historicalElaborationAuthor>>
type SavedCrossFreezeP1Impact = Omit<SavedCrossFreezeP0Impact, 'version'> & {
  version: 'cross-freeze-p1-impact-v1'
  composedDigest: string
}

function crossFreezeP1ImpactInput(
  operation: SyncOperation, attemptId: string, source: CrossFreezeSource, partitionId: string,
  author: HistoricalElaborationAuthor, seed: StageWorktree, readPaths: readonly string[],
  timeoutMs: ElaborationSessionRequest['timeoutMs'], rawRef: BlobRef,
): Parameters<typeof prepareCrossFreezeImpactReview>[0] {
  return {
    operation, attemptId, source, owner: partitionId, stage: 'p1', seed, timeoutMs, readPaths,
    prior: { attemptId: author.generation.attempt.id, candidateDigest: rawRef.sha256, resultRef: rawRef, author: author.trace,
      ...(author.result.reviewPassed && author.reviewer ? { approvalRef: author.resultRef, reviewer: author.reviewer } : {}) },
  }
}

function crossFreezeP1Author(
  author: HistoricalElaborationAuthor, evidence: CrossFreezeImpactEvidence, bindingRef: BlobRef, reviewRef: BlobRef,
): ElaborationCrossFreezeAuthor {
  return {
    draft: author.draft, trace: author.trace, receipt: author.receipt,
    proof: { version: 'elaboration-cross-freeze-author-v1', oldOperationId: author.old.id, oldAttemptId: author.generation.attempt.id,
      oldPartitionId: evidence.binding.owner, oldResultRef: author.resultRef, oldInputId: author.old.input.id, oldInputDigest: author.result.inputDigest,
      oldAuthorRequestDigest: author.trace.inputDigest, bindingRef, impactReviewRef: reviewRef },
    independentOf: [evidence.trace, ...(author.reviewer ? [author.reviewer] : [])],
  }
}

function readCrossFreezeP1Impact(
  store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, currentInputDigest: string,
  selected: NonNullable<ReturnType<typeof readLockedCrossFreezeSource>>, author: HistoricalElaborationAuthor,
  readRecordForResult?: (id: string) => NativeRunRecord | null,
) {
  const index = readSyncCheckpointStageIndex(store, operation, origin)
  const local = partitionStage<SavedCrossFreezeP1Impact>(store, operation, origin, `${key}:cross-freeze-impact`, undefined, index)
  if (!local || local.result.currentInputDigest !== currentInputDigest) return null
  const { composedDigest, evidence, worktree, sourceRef, checkedPaths, timeoutMs } = local.result
  const plan = partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan', undefined, index)
  const partition = plan?.result.partitions.find(item => item.id === evidence.binding.owner)
  if (local.result.version !== 'cross-freeze-p1-impact-v1' || sourceRef.sha256 !== selected.bindingRef.sha256
      || !partition || key !== `partition:${partition.id}:elaboration` || composedDigest !== origin.composedInput?.contentDigest
      || canonical([...partition.readPaths].sort()) !== canonical(checkedPaths) || !store.findResource(origin.id, evidence.requestKey))
    fail('cross_freeze_native_binding', '保留的 P1 影响复核缺少同一个分区、组合输入或正式 Native 资源')
  const raw = readStageDraft(operation.input.source.commonDir, author.draft, author.draft)
  const input = crossFreezeP1ImpactInput(operation, origin.id, selected.source, partition.id, author, evidence.binding.seed, checkedPaths,
    timeoutMs, { sha256: contentHash(raw) })
  const prepared = restoreCrossFreezeImpactReview(input, worktree)
  const actual = authenticateCrossFreezeImpact(store, operation, origin, prepared, evidence.trace, evidence.output, readRecordForResult)
  if (canonical(actual) !== canonical(evidence)) fail('cross_freeze_native_binding', '保留的 P1 影响结论与原 Native 结算不同')
  return { verdict: evidence.verdict, author: crossFreezeP1Author(author, evidence, sourceRef, local.resultRef) }
}

function authenticateCrossFreezeP1Generation(
  store: SyncStore, operation: SyncOperation, owner: SyncAttempt, result: SavedElaboration, round: ElaborationResult['rounds'][number],
): HistoricalElaborationAuthor['generation'] | null {
  const marker = round.crossFreezeAuthor!
  if (result.partitionBinding?.partitionId !== marker.oldPartitionId || !round.draft) return null
  const locked = findLockedCrossFreezeSource(store, operation, marker.bindingRef)
  if (!locked) return null
  const author = historicalElaborationAuthor(store, locked.selected.source, marker.oldPartitionId)
  if (!author || canonical(round.draft) !== canonical(author.draft) || canonical(round.output) !== canonical(author.receipt)
    || canonical(round.traces[0]) !== canonical(author.trace)) return null
  const key = `partition:${marker.oldPartitionId}:elaboration`
  for (const { owner: source, prior } of crossFreezeImpactHistory(store, operation, owner, locked.owner)) {
    const review = readCrossFreezeP1Impact(store, source, prior, key, result.inputDigest, locked.selected, author)
    if (review?.verdict !== 'reuse' || canonical(review.author.proof) !== canonical(marker)) continue
    const currentReviewer = round.traces.find(trace => trace.purpose === 'elaboration_review')
    if (currentReviewer && review.author.independentOf.some(trace => trace.sessionId === currentReviewer.sessionId || trace.threadId === currentReviewer.threadId)) return null
    return author.generation
  }
  return null
}

/** 同一判据逐owner核原冻结计划、P0与真实独审；旧指导仅供完整冻结候选认证。 */
function* approvedBehaviorPartitionAuthentication(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, plan: SyncPartitionPlan, evidence: CodeBehaviorEvidence, owners: readonly AnalysisOnlyPartitionEvidence[], options?: { frozenLegacy?: boolean; inlineV1Repair?: true; readIndex?: (attempt: SyncAttempt) => SyncCheckpointStageView }): Generator<void, boolean> {
  const frozenLegacy = options?.frozenLegacy || behaviorGuidanceMatches(operation, { guidanceContractVersion: LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION, resultRef: evidence.ref })
  const reject = (message: string): false => {
    if (frozenLegacy) fail('frozen_candidate_analysis_binding', message)
    return false
  }
  const history = new Map<string, SyncCheckpointStageView>()
  const readIndex = (origin: SyncAttempt): SyncCheckpointStageView => {
    const cached = history.get(origin.id) ?? (options?.readIndex ? options.readIndex(origin) : readStageCheckpoints(store, origin.operationId === operation.id ? operation : store.readOperation(origin.operationId), origin, true))
    history.set(origin.id, cached)
    return cached
  }
  const usage = frozenLegacy ? 'evidence' : 'automatic'
  const whole = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', usage, readIndex(attempt))
  const challenges = readP0ReviewChallenges(store, operation)
  if (!whole || !behaviorChallengesAnswered(whole, challenges) || contentHash(JSON.stringify(whole)) !== evidence.ref.sha256 || whole.inputId !== operation.input.id || whole.policyDigest !== operation.policyDigest || whole.composedDigest !== attempt.composedInput?.contentDigest) return reject('原P0 whole与本候选输入、政策或组合树失配')
  const basis = analysisStageBinding(store, operation, whole, readIndex)
  if (!basis || (frozenLegacy ? basis.guidanceContractVersion !== LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION || whole.guidanceContractVersion !== undefined : !behaviorGuidanceMatches(operation, basis))) return reject('原P0 whole缺少精确原指导、读集及基线wrapper')
  const p0 = store.readAttempt(basis.attemptId), commonDir = operation.input.source.commonDir
  const inline = options?.inlineV1Repair === true
  if (inline && p0.operationId !== operation.id) return reject('原inline P0 whole生产者必须属于同operation')
  if (p0.number > attempt.number || p0.composedInput?.contentDigest !== whole.composedDigest) return reject('原P0实际attempt不是同组合输入的更早来源')
  const inherited = stage<{ fromOperationId?: string; fromAttemptId: string; analysisRef: BlobRef }>(store, operation, p0, 'analysis-provenance', 'evidence', readIndex(p0))
  if (inline && inherited && ((inherited.fromOperationId ?? operation.id) !== operation.id || store.readAttempt(inherited.fromAttemptId).operationId !== operation.id))
    return reject('原inline P0 whole provenance必须属于同operation')
  if (inherited?.fromOperationId && inherited.fromOperationId !== operation.id) {
    const parent = reviewHandoffParent(store, operation), previous = store.readAttempt(inherited.fromAttemptId)
    if (parent?.id !== inherited.fromOperationId || previous.operationId !== parent.id || inherited.analysisRef.sha256 !== evidence.ref.sha256
      || !['failed', 'superseded', 'settled'].includes(previous.status) || previous.composedInput?.contentDigest !== whole.composedDigest) return reject('原P0全图引用缺少精确直接父候选来源')
    return yield* approvedBehaviorPartitionAuthentication(store, parent, previous, plan, evidence, owners, { ...options, readIndex })
  }
  const selection = basis.baselineSelectionRef ? JSON.parse(readEvidence(commonDir, basis.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection : undefined
  const source = withCheckpointStageBasis(operation, whole.readSetDigest, selection)
  const checkpoints = readIndex
  const planDigest = contentHash(JSON.stringify(plan))
  const lineage: ApprovalSourceLineage = { settled: new Set() }
  for (const owner of owners) {
    const member = whole.partitionEvidence?.find(item => item.partitionId === owner.partitionId)
    if (!member || member.analysisRef.sha256 !== owner.analysisRef.sha256 || owner.wholeAnalysisRef.sha256 !== evidence.ref.sha256 || contentHash(JSON.stringify(member.analysis)) !== member.analysisRef.sha256) return reject(`原P0 owner未绑定精确whole/local摘要: ${owner.partitionId}`)
    const proof = yield* approvedBehaviorPartitionSource(store, operation, source, p0, planDigest, member, selection, checkpoints, lineage, {
      expectedReadSetDigest: whole.readSetDigest, expectedComposedDigest: whole.composedDigest, frozenLegacy, inline, authorization: challenges.get(owner.partitionId),
    })
    if (typeof proof === 'string') return reject(proof)
    yield
  }
  return true
}

function finishApprovalProof<T>(proof: Generator<void, T>): T {
  let step = proof.next()
  while (!step.done) step = proof.next()
  return step.value
}

function requireChallengedWholeApproval(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, whole: CodeBehaviorAnalysis, challenges: P0ReviewChallenges): void {
  const required = [...challenges.values()].filter(({ challenge }) => challenge.version === 'p0-review-challenge-v2')
  if (!required.length) return
  const ref = { sha256: contentHash(JSON.stringify(whole)) }
  const plan = JSON.parse(readEvidence(operation.input.source.commonDir, required[0].challenge.origin.partitionPlanRef).toString('utf8')) as SyncPartitionPlan
  const owners = required.map(({ challenge }) => {
    const member = whole.partitionEvidence?.find(item => item.partitionId === challenge.partitionId && item.analysis.reviewDiagnosticRef?.sha256 === challenge.diagnosticRef.sha256)
    if (!member) return fail('sync_p0_challenge_binding', '全局P0缺少当前v2复审批准分区')
    return { partitionId: member.partitionId, analysisRef: member.analysisRef, wholeAnalysisRef: ref }
  })
  if (!withReadonlySnapshotQuery(() => finishApprovalProof(approvedBehaviorPartitionAuthentication(store, operation, attempt, plan, { ref, analysis: whole }, owners)))) {
    fail('sync_p0_challenge_binding', '全局P0复审批准缺少原精确分区、覆盖、schema或Native/Git证据')
  }
}

/** 复用完整分析时仍需当前跨冻结 owner 的正式独审和两次原件。 */
async function requireCrossFreezeWholeApproval(
  store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, plan: SyncPartitionPlan | null | undefined,
  evidence: CodeBehaviorEvidence, renew: () => Promise<void>,
): Promise<void> {
  const owners = evidence.analysis.partitionEvidence?.filter(owner => owner.analysis.crossFreezeAuthor)
    .map(owner => ({ partitionId: owner.partitionId, analysisRef: owner.analysisRef, wholeAnalysisRef: evidence.ref })) ?? []
  if (!owners.length) return
  if (!plan || evidence.analysis.partitionCoverage?.planDigest !== plan.digest) fail('cross_freeze_approval_binding', '跨冻结 P0 全图缺少原分区计划')
  const approved = await withReadonlySnapshotQuery(async () => {
    const proof = approvedBehaviorPartitionAuthentication(store, operation, attempt, plan, evidence, owners)
    let state = proof.next()
    while (!state.done) {
      await renew()
      state = proof.next()
    }
    return state.value
  })
  if (!approved) fail('cross_freeze_approval_binding', '跨冻结 P0 全图缺少原作者、影响复核或当前正式独审原件', [evidence.ref])
}

/** 续验完整候选前，再核 P1 局部正式独审及其跨冻结来源。 */
async function requireCrossFreezeElaborationApprovals(
  store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, approved: SavedElaboration, renew: () => Promise<void>,
): Promise<void> {
  const commonDir = operation.input.source.commonDir
  for (const member of approved.partitionEvidence ?? []) {
    await renew()
    const local = JSON.parse(readEvidence(commonDir, member.resultRef).toString('utf8')) as SavedElaboration
    if (local.rounds.some(round => round.crossFreezeAuthor) && !authenticatedApprovedElaboration(store, operation, attempt, local, { allowDeferredImplementation: true }))
      fail('cross_freeze_p1_approval_binding', `跨冻结 P1 续验缺少当前正式独审原件: ${member.partitionId}`, [member.resultRef])
  }
}

/** P0-only资格回到原冻结计划、P0 stage和每区真实独审，不依赖P1自报。 */
function authenticateAnalysisOnlyPartitions(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, plan: SyncPartitionPlan, evidence: CodeBehaviorEvidence, owners: readonly AnalysisOnlyPartitionEvidence[]): boolean {
  return finishApprovalProof(approvedBehaviorPartitionAuthentication(store, operation, attempt, plan, evidence, owners))
}

function authenticatedMixedElaborationCoverage(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, plan: SyncPartitionPlan, result: SavedElaboration): boolean {
  const owners = result.analysisOnlyPartitions, writers = result.partitionEvidence
  if (!owners?.length || !writers?.length || !partitionedElaborationCoverageMatches(plan.partitions.map(partition => partition.id), writers.map(owner => owner.partitionId), owners.map(owner => owner.partitionId))) return false
  const checkpoints = readStageCheckpoints(store, operation, origin), whole = stage<CodeBehaviorAnalysis>(store, operation, origin, 'analysis', 'automatic', checkpoints)
  if (!whole) return false
  const commonDir = operation.input.source.commonDir, evidence = { ref: { sha256: contentHash(JSON.stringify(whole)) }, analysis: whole }
  if (canonical(analysisOnlyPartitionEvidence(commonDir, plan, evidence)) !== canonical(owners) || !authenticateAnalysisOnlyPartitions(store, operation, origin, plan, evidence, owners)) return false
  return writers.every(owner => {
    const local = stage<SavedElaboration>(store, operation, origin, `partition:${owner.partitionId}:elaboration`, 'automatic', checkpoints)
    return local?.partitionBinding?.planDigest === plan.digest && local.partitionBinding.partitionId === owner.partitionId
      && local.structurePassed && local.reviewPassed && !local.failure && local.rounds.at(-1)?.review?.verdict === 'accept'
      && local.partitionBinding.analysisRef?.sha256 === evidence.ref.sha256 && contentHash(JSON.stringify(local)) === owner.resultRef.sha256
  })
}

type PriorCandidateAnalysis = { operationId: string; sourceAttemptId: string; candidateDigest: string; analysisRef: BlobRef; analysisRefs: string[] }
type FrozenCandidateAnalysis = PriorCandidateAnalysis & { formatReviewKeys: string[] }

/** 同operation原冻结候选专用冷验；沿原正式生产者核证，不补指导或启动模型。 */
export async function authenticateFrozenCandidateAnalysis(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, options: { renew?: () => Promise<void>; readNativeRecord?: typeof readRecord; includeCurrent?: true } = {}): Promise<FrozenCandidateAnalysis | null> {
  const proof = await authenticateCandidateAnalysis(store, operation, attempt, options)
  return proof && 'formatReviewKeys' in proof ? proof : null
}

async function authenticateCandidateAnalysis(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, options: { renew?: () => Promise<void>; readNativeRecord?: typeof readRecord; includeCurrent?: true; inlineV1Repair?: true }): Promise<FrozenCandidateAnalysis | PriorCandidateAnalysis | null> {
  const scope: FrozenAnalysisScope = { active: true, operationId: operation.id, inputId: operation.input.id, source: canonical(operation.input.source), policyDigest: operation.policyDigest, refs: new Set(), readNativeRecord: options.readNativeRecord ?? readRecord, selectionMatches: new Map() }
  return frozenAnalysisScope.run(scope, () => withReadonlySnapshotQuery(async () => {
    try {
      const indexes = new Map<string, SyncCheckpointStageView>()
      const readIndex = (origin: SyncAttempt, owner = origin.operationId === operation.id ? operation : store.readOperation(origin.operationId)): SyncCheckpointStageView => {
        const index = indexes.get(origin.id) ?? readSyncCheckpointStageIndex(store, owner, origin, scope.readNativeRecord)
        indexes.set(origin.id, index)
        return index
      }
      scope.readIndex = readIndex
      const checkpoints = readIndex(attempt), commonDir = operation.input.source.commonDir
      const generation = partitionStage<SavedGeneration>(store, operation, attempt, 'generation', undefined, checkpoints)?.result
      const whole = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', 'evidence', checkpoints)
      if (!generation?.candidate || !whole) return null
      const frozenLegacy = whole.guidanceContractVersion === undefined
      if (!frozenLegacy && (!options.includeCurrent || whole.guidanceContractVersion !== CODE_BEHAVIOR_GUIDANCE_VERSION)) return null
      const reject = (message: string): never => fail('frozen_candidate_analysis_binding', message)
      if (attempt.operationId !== operation.id || !settledCandidateReviewAttempt(attempt)
        || !operation.planBlob || operation.planBlob.sha256 !== operation.policyDigest || !attempt.composedInput) reject('旧P0恢复只接受同operation正式已结算的原候选')
      const policy = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString('utf8')) as SyncCoordinatorPlan
      if (syncPlanDigest(policy) !== operation.policyDigest || policy.version !== 'sync-coordinator-v2' || policy.direction !== 'code_to_spec') reject('旧P0候选缺少原code_to_spec冻结政策')
      const inline = options.inlineV1Repair === true
      if (inline) {
        if (!frozenLegacy || policy.agentWorkflow || generation.candidateValidated || generation.reviewPassed
          || generation.status !== 'repair' || attempt.failure?.kind !== 'repairable' || generation.partitionEvidence?.length
          || !generation.validationFindings.some(finding => finding.severity === 'error')
          || generation.validationFindings.some(finding => finding.severity === 'error' && !isReadonlyCitationFailure(finding))) return null
      } else if (frozenLegacy && !policy.agentWorkflow) return null
      const p1 = stage<SavedElaboration>(store, operation, attempt, 'elaboration', 'automatic', checkpoints)
      const planned = reviewPlanStage(store, operation, attempt, 'partition-plan', inline ? 'inline_v1_repair' : undefined, readIndex)
      const plan = planned?.result
      const candidate = generation.candidate, evidence = { ref: { sha256: contentHash(JSON.stringify(whole)) }, analysis: whole }
      if (!whole.reviewPassed || !whole.partitionEvidence?.length || !plan || whole.partitionCoverage?.planDigest !== plan.digest
        || canonical(whole.partitionEvidence.map(owner => owner.partitionId)) !== canonical(plan.partitions.map(owner => owner.id))
        || inline && (canonical(whole.partitionCoverage.partitionIds) !== canonical(plan.partitions.map(owner => owner.id))
          || whole.partitionEvidence.some((owner, index) => canonical(owner.changedPaths) !== canonical(plan.partitions[index].changedPaths)))) reject('旧P0各owner未完整对应同一原冻结计划')
      if (!p1?.structurePassed || !p1.reviewPassed || p1.failure || !['complete', 'needs_input', 'conflict'].includes(p1.status) || !p1.partitionEvidence?.length) reject('旧候选缺少原P1结构及独审批准')
      if (!elaborationComposedBinding(store, operation, attempt, p1!, attempt.composedInput!, checkpoints)) reject('原P1 wrapper与当前原组合树不一致')
      if ((!inline && (!generation.candidateValidated || generation.reviewPassed || generation.validationFindings.some(finding => finding.severity === 'error')))
        || candidate.sourceInputId !== operation.input.id || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths)
        || inline && canonical(candidate.coveredScope) !== canonical(operation.scope)) reject('实际冻结候选的原机械校验、输入或范围失配')
      if (inline) {
        const repair = readonlyRepairFromAttempt(store, operation, attempt, readIndex)
        if (!repair || repair.kind || repair.planRef.sha256 !== planned!.resultRef.sha256) reject('原inline V1诊断缺少同计划的精确只读返修证明')
      }
      const actual = verifyCandidate(commonDir, candidate), original = verifySnapshot(operation.input)
      if (actualTreeDiff(original, actual).some(change => !isSyncSpecPath(change.path))
        || p1!.changes.some(change => { const entry = actual.find(entry => entry.path === change.path); return !entry || entry.mode === '120000' || readObject(commonDir, entry.oid).toString('utf8') !== change.source })) reject('只读候选改变了source/tests或不等于原已审Spec')
      const composed = attempt.composedInput!, manifest = readTree(commonDir, composed.tree)
      if (composed.sourceInputId !== operation.input.id || contentHash(JSON.stringify(manifest)) !== composed.contentDigest
        || readEvidence(commonDir, composed.manifestBlob).toString('utf8') !== JSON.stringify({ version: 1, entries: manifest })) reject('原组合输入的Git清单与摘要失配')
      const renew = options.renew ?? yieldToControl
      if (inline) scope.inlineV1Repair = true
      const p0 = approvedBehaviorPartitionAuthentication(store, operation, attempt, plan!, evidence, whole.partitionEvidence!.map(owner => ({ partitionId: owner.partitionId, analysisRef: owner.analysisRef, wholeAnalysisRef: evidence.ref })), { frozenLegacy, inlineV1Repair: options.inlineV1Repair, readIndex })
      for (let step = p0.next(); ; step = p0.next()) {
        if (step.done) { if (!step.value) reject('原P0各owner分析、Git草稿或独审身份失配'); break }
        await renew()
      }
      scope.refs.add(evidence.ref.sha256)
      for (const owner of whole.partitionEvidence!) scope.refs.add(owner.analysisRef.sha256)
      scope.candidateDigest = candidate.digest
      if (!partitionedElaborationCoverageMatches(plan!.partitions.map(owner => owner.id), p1!.partitionEvidence!.map(owner => owner.partitionId), p1!.analysisOnlyPartitions?.map(owner => owner.partitionId) ?? [])
        || canonical(analysisOnlyPartitionEvidence(commonDir, plan!, evidence)) !== canonical(p1!.analysisOnlyPartitions ?? [])) reject('真实P1与仅分析P0未精确覆盖原计划')
      const history = readonlyElaborationHistory(store, operation, readIndex), aggregateRef = { sha256: contentHash(JSON.stringify(p1)) }
      for (const member of p1!.partitionEvidence!) {
        const key = `partition:${member.partitionId}:elaboration`
        const source = reviewedReadonlyLocalSource(store, operation, attempt, key, member.resultRef, aggregateRef, 0, history), local = source.result, round = local.rounds.at(-1)!
        if (!round.candidate || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || round.candidate.inputDigest !== local.inputDigest || local.candidateDigest !== round.candidateDigest
          || canonical(local.changes) !== canonical(round.candidate.changes.map(change => ({ ...change, contentDigest: contentHash(change.source) })))
          || local.partitionBinding?.planDigest !== plan!.digest || local.partitionBinding.analysisRef?.sha256 !== evidence.ref.sha256) reject(`原P1生成、Git候选或完整独审不匹配: ${member.partitionId}`)
        if (inline) {
          if (round.draft || !round.traces.every(trace => history.attempts.some(origin => {
            if (origin.number > attempt.number || !['failed', 'superseded', 'settled'].includes(origin.status)) return false
            const key = `sync:${origin.id}:elaborate:partition:${member.partitionId}:${round.index}:${trace.purpose}`
            const authenticated = authenticatedDraftResult(store, operation, origin, key, trace.purpose)
            const result = authenticated?.result
            if (authenticated?.request && authenticated.request.inputDigest !== trace.inputDigest) return false
            return result?.sessionId === trace.sessionId && result.threadId === trace.threadId && result.turnId === trace.turnId
              && result.resultDigest === trace.resultDigest && canonical(result.output) === canonical(trace.purpose === 'elaboration_review' ? round.reviewOutput : round.output)
          }))) reject(`原inline P1缺少同owner已结算生成或独审: ${member.partitionId}`)
        } else {
          if (!round.draft || !authenticatedApprovedElaboration(store, source.owner, source.approvalAttempt, local, { allowDeferredImplementation: local.phase === undefined })) reject(`原P1生成、Git候选或完整独审不匹配: ${member.partitionId}`)
          readStageDraft(commonDir, round.draft!, round.draft!)
        }
        await renew()
      }
      const proof = { operationId: operation.id, sourceAttemptId: attempt.id, candidateDigest: candidate.digest, analysisRef: evidence.ref, analysisRefs: [...scope.refs] }
      if (inline) return proof
      const p2 = candidateReviewAuthentication(store, operation, attempt, generation, readIndex, { readNativeRecord: scope.readNativeRecord })
      let step = p2.next()
      while (!step.done) { await renew(); step = p2.next() }
      const formatReviewKeys = step.value ?? reject('原候选缺少全部required独审结论及精确Native结算')
      return { ...proof, formatReviewKeys }
    } finally { scope.active = false; scope.refs.clear(); scope.selectionMatches?.clear(); delete scope.readIndex }
  }))
}

/** 查询与裁决复用同一真实阶段绑定，已审未来 null 资源扩展不篡改原分析原件。 */
export function readCurrentSyncAnalysis(store: SyncStore, operation: SyncOperation): CodeBehaviorEvidence | null {
  if (!operation.currentAttemptId) return null
  const attempt = store.readAttempt(operation.currentAttemptId), analysis = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', 'evidence')
  const challenges = readP0ReviewChallenges(store, operation)
  if (!analysis?.reviewPassed || !behaviorChallengesAnswered(analysis, challenges) || analysis.inputId !== operation.input.id || analysis.policyDigest !== operation.policyDigest || analysis.composedDigest !== attempt.composedInput?.contentDigest) return null
  const saved = analysisStageBinding(store, operation, analysis)
  if (!saved) return null
  requireChallengedWholeApproval(store, operation, attempt, analysis, challenges)
  return { ref: saved.resultRef, analysis }
}
function injectedRunner(store: SyncStore, fence: WriteFence, runner: ElaborationRunner): ElaborationRunner {
  return async request => {
    const { signal, ...payload } = request
    const requestDigest = contentHash(JSON.stringify(payload))
    const operation = store.readOperation(fence.operationId), attempt = store.readAttempt(fence.attemptId)
    const saved = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, attempt, `injected:${request.requestKey}`)
    const dispatch = store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    if (saved) { if (saved.requestDigest !== requestDigest) fail('dispatch_conflict', '测试接缝重入请求改变'); return saved.result }
    const result = await runner(request)
    if (signal?.aborted) fail('cancelled', '模型结果到达时已停止')
    if (result.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || !result.threadId || !result.turnId || contentHash(JSON.stringify(result.output)) !== result.resultDigest) fail('native_identity', '模型结果身份或摘要不匹配持久派发计划')
    store.bindSession(fence, request.requestKey, { sessionId: result.sessionId, threadId: result.threadId, turnId: result.turnId })
    saveStage(store, fence, `injected:${request.requestKey}`, { requestDigest, result })
    return result
  }
}
function safeArtifactRoot(root: string, operation: SyncOperation): void {
  const stat = lstatSync(root)
  if (resolve(root) !== root || realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || root === operation.input.source.canonicalRoot || root.startsWith(`${operation.input.source.canonicalRoot}${sep}`) || operation.input.source.canonicalRoot.startsWith(`${root}${sep}`)) fail('artifact_directory', 'artifactRoot必须是source外canonical、当前用户独占0700目录')
}
function findingKey(finding: ContractFinding): string { return canonical({ code: finding.code, path: finding.path, nodeId: finding.nodeId, itemId: finding.itemId ?? null, relatedIds: unique(finding.relatedIds ?? []) }) }
function unexecutedAcceptanceIds(elaboration: Pick<SavedElaboration, 'rounds' | 'partitionSeal'>): string[] {
  const findings = elaboration.partitionSeal?.findings ?? elaboration.rounds.at(-1)?.findings ?? []
  return unique(findings.flatMap(finding => finding.code === 'acceptance-not-executed' && finding.severity === 'warning' && finding.itemId ? [finding.itemId] : []))
}
export async function candidateContext(store: SyncStore, operation: SyncOperation, candidate: CandidateRef, elaboration?: Pick<SavedElaboration, 'rounds' | 'partitionSeal'>): Promise<FrozenContracts> {
  const files = new Map<string, string>()
  const entries = verifyCandidate(operation.input.source.commonDir, candidate)
  readTree(operation.input.source.commonDir, candidate.tree, (entry, bytes) => {
    if (entry.mode === '120000' || isHostPrivatePath(entry.path)) return
    if (isUtf8Text(bytes)) files.set(entry.path, bytes.toString('utf8'))
  })
  const reviewed = operation.recordUnverifiedCoverage && elaboration ? new Set(unexecutedAcceptanceIds(elaboration)) : undefined
  const plan = operation.planBlob ? JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob).toString('utf8')) as SyncCoordinatorPlan : null
  if (plan?.historicalCoverage && syncPlanDigest(plan) !== operation.policyDigest) fail('policy_binding', '历史覆盖证明未绑定原冻结计划')
  const historical = plan?.historicalCoverage ? historicalCoverageCheck(store, operation.input, operation.scope, plan.historicalCoverage, entries) : undefined
  return readFrozenContracts(operation.input.source.canonicalRoot, files, new Set(entries.map(entry => entry.path)), reviewed && (id => reviewed.has(id)), historical)
}
/** 完整结构上下文不授予新意图；真实Spec差量的未读前态只取候选基树。 */
export async function checkCandidateContractIntent(operation: SyncOperation, candidate: CandidateRef, accepted: FrozenContracts, frozen: FrozenContracts, policy: GenerationContractPolicy): Promise<ContractFinding[]> {
  const commonDir = operation.input.source.commonDir, entries = verifyCandidate(commonDir, candidate), base = readTree(commonDir, candidate.baseTree)
  const changed = new Set(actualTreeDiff(base, entries).filter(change => isSyncSpecPath(change.path)).map(change => change.path))
  const paths = new Set([...accepted.nodes.map(node => node.path), ...changed]), before = new Map(accepted.files)
  for (const entry of base) if (changed.has(entry.path) && !before.has(entry.path) && entry.mode !== '120000' && !isHostPrivatePath(entry.path)) {
    const bytes = readObject(commonDir, entry.oid)
    if (isUtf8Text(bytes)) before.set(entry.path, bytes.toString('utf8'))
  }
  const after = new Map([...frozen.files].filter(([path]) => !isSyncSpecPath(path) || paths.has(path)))
  return checkGenerationContractIntent(await readFrozenContracts(operation.input.source.canonicalRoot, before), await readFrozenContracts(operation.input.source.canonicalRoot, after), policy)
}
function acceptanceRuns(frozen: FrozenContracts, ready: SyncScope, plan: SyncCoordinatorPlan, retirement: { before: FrozenContracts; ids: string[] }, unexecutedContractIds?: readonly string[]): AcceptanceRun[] {
  const acIds = ready.contractIds.filter(id => frozen.graph.items.get(id)?.kind === 'AC')
  const retiringAc = retirement.ids.filter(id => retirement.before.graph.items.get(id)?.kind === 'AC')
  if (!acIds.length && !retiringAc.length && !(unexecutedContractIds?.length && plan.mandatoryTests.length)) fail('no_ready_acceptance', '没有可执行的ready或明确退役验收，不写半成品')
  const runs = acIds.length ? planAcceptanceRuns(frozen.graph, acIds, plan.verifications) : []
  if (retiringAc.length) for (const run of planAcceptanceRuns(retirement.before.graph, retiringAc, plan.verifications)) { const existing = runs.find(item => item.verificationId === run.verificationId); if (existing) { existing.bindings.push(...run.bindings); existing.policy.expectedTestIds = unique([...existing.policy.expectedTestIds, ...run.policy.expectedTestIds]) } else runs.push(run) }
  for (const mandatory of plan.mandatoryTests) {
    let run = runs.find(item => item.verificationId === mandatory.verificationId)
    if (!run) {
      const registered = plan.verifications.find(item => item.definition.id === mandatory.verificationId)!
      const verify = frozen.graph.items.get(mandatory.verificationId)
      if (verify ? verify.kind !== 'VERIFY' || canonical({ id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }) !== canonical(registered.definition) : !unexecutedContractIds) fail('oracle_verification', '独立测试政策未被真实候选准确登记')
      run = { verificationId: mandatory.verificationId, bindings: [], policy: { ...registered.environment, argv: [...registered.definition.command], cwd: registered.definition.cwd, timeoutMs: registered.definition.timeoutMs, expectedTestIds: [] } }; runs.push(run)
    }
    if (!run.policy.expectedTestIds.includes(mandatory.testId)) run.policy.expectedTestIds.push(mandatory.testId)
  }
  for (const run of runs) run.policy.expectedTestIds.sort()
  return runs.sort((a, b) => a.verificationId.localeCompare(b.verificationId))
}
function unexecutedCandidateIds(operation: SyncOperation, frozen: FrozenContracts, ready: SyncScope): string[] | undefined {
  if (!operation.recordUnverifiedCoverage) return undefined
  const ids = new Set(ready.contractIds)
  return unique(frozen.findings.flatMap(finding => finding.code === 'acceptance-not-executed' && finding.itemId && ids.has(finding.itemId) ? [finding.itemId] : []))
}
async function recoverResources(store: SyncStore, operation: SyncOperation, options: Pick<SyncCoordinatorOptions, 'recoveryOnly' | 'verificationDriver' | 'verificationTransport'> & { resourceRecoveryOnly?: true }, all: boolean): Promise<boolean> {
  const removedNative = store.listAttempts(operation.id).filter(attempt => all || attempt.id !== operation.currentAttemptId).flatMap(attempt =>
    store.listResources(attempt.id).filter(resource => resource.phase === 'removed' && resource.plan.kind === 'native_session').map(resource => ({ operation, attempt, resource })))
  for (const item of [...store.listRecoverableResources().filter(item => item.operation.id === operation.id && (all || item.attempt.id !== operation.currentAttemptId)), ...removedNative]) {
    const fence = fenceFor(item.operation, item.attempt), commonDir = operation.input.source.commonDir
    if (item.resource.plan.inputId !== operation.input.id) fail('resource_recovery', '既有resource不匹配原frozen input')
    if (item.resource.plan.kind === 'verification') {
      const request = JSON.parse(readEvidence(commonDir, item.resource.plan.planBlob).toString('utf8')) as Omit<VerificationRequest, 'previousCheckpoint'>
      if (item.resource.plan.key !== `verification:${request.runId}` || request.inputDigest !== operation.input.id || request.candidateDigest !== item.resource.plan.candidateDigest || contentHash(JSON.stringify(request)) !== item.resource.plan.payloadDigest) fail('resource_recovery', '既有verification计划不匹配原resource/runId/input/candidate')
      const driver = options.verificationDriver ?? dockerVerificationDriver
      const recovered = await runAttemptVerification(store, fence, { ...request, signal: AbortSignal.abort() }, { transport: options.verificationTransport, driver: options.recoveryOnly ? (args, maxBytes) => {
        if (args[0] === 'container' && ['create', 'start'].includes(args[1])) fail('resource_recovery', '只恢复既有容器，不新建或启动verification')
        return driver(args, maxBytes)
      } : driver })
      if (recovered.result.status === 'recovery_required' || store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') return false
    } else {
      const plan = JSON.parse(readEvidence(commonDir, item.resource.plan.planBlob).toString('utf8')) as NativeRunPlan
      const dispatch = item.attempt.dispatchPlans.find(dispatch => dispatch.key === item.resource.plan.key)
      if (!dispatch || plan.schemaVersion !== 1 || plan.operationId !== operation.id || plan.attemptId !== item.attempt.id || plan.inputId !== operation.input.id || plan.candidateDigest !== item.resource.plan.candidateDigest || plan.request.requestKey !== item.resource.plan.key || plan.requestDigest !== item.resource.plan.payloadDigest || contentHash(JSON.stringify(plan.request)) !== plan.requestDigest || dispatch.requestDigest !== plan.requestDigest || plan.sessionCreateKey !== dispatch.sessionCreateKey || plan.expectedSessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) fail('resource_recovery', 'native resource plan differs from frozen request: 既有Native计划不匹配原resource/dispatch/创建键与身份')
      if (item.resource.phase === 'removed' && !plan.request.worktree) continue
      try { await createAttemptRunner(store, fence, { resourceRecoveryOnly: options.resourceRecoveryOnly, retireSettledWorktrees: true })({ ...plan.request, signal: AbortSignal.abort() }) }
      catch (error) { if (store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') fail('resource_recovery', error instanceof Error ? error.message : String(error)) }
      if (store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') return false
    }
  }
  return true
}

export type SyncResourceRecoveryResult = { operationId: string; inputId: string; status: 'resources_recovered' | 'recovery_required' | 'busy'; resources: SyncResourceRecord[]; pendingJournalIds: string[]; failure?: { code: string; message: string } }

/** 只结算显式历史输入的owned资源；身份漂移不授予业务恢复或journal写入权。 */
export async function recoverSyncOperationResources(store: SyncStore, operationId: string, options: { root: string; inputId: string; artifactRoot: string; verificationDriver?: SyncCoordinatorOptions['verificationDriver']; verificationTransport?: SyncCoordinatorOptions['verificationTransport'] }): Promise<SyncResourceRecoveryResult> {
  const operation = store.readOperation(operationId), source = identifyRawWorktree(options.root)
  if (operation.input.id !== options.inputId) fail('resource_recovery_input', '资源清理必须明确匹配原frozen input ID')
  if (source.canonicalRoot !== operation.input.source.canonicalRoot || source.commonDir !== operation.input.source.commonDir) fail('resource_recovery_source', '资源清理不属于当前canonicalRoot/commonDir')
  const result = (status: SyncResourceRecoveryResult['status'], failure?: SyncResourceRecoveryResult['failure']): SyncResourceRecoveryResult => ({ operationId, inputId: operation.input.id, status, resources: store.listRecoverableResources().filter(item => item.operation.id === operationId).map(item => item.resource), pendingJournalIds: store.listJournals(operationId).filter(journal => journal.status !== 'settled').map(journal => journal.id), ...(failure ? { failure } : {}) })
  safeArtifactRoot(options.artifactRoot, operation)
  const locks = join(options.artifactRoot, '.locks')
  mkdirSync(locks, { recursive: true, mode: 0o700 }); safeArtifactRoot(locks, operation)
  const mutex = claimFileMutex(join(locks, `${contentHash(operationId)}.sqlite`))
  if (!mutex) return result('busy')
  try {
    return result(await withoutSessionApplicationExecutionWake(() => recoverResources(store, operation, { recoveryOnly: true, resourceRecoveryOnly: true, verificationDriver: options.verificationDriver, verificationTransport: options.verificationTransport }, true)) ? 'resources_recovered' : 'recovery_required')
  } catch (error) {
    return result('recovery_required', { code: error instanceof SyncCoordinatorError || error instanceof SyncStoreError ? error.code : 'resource_recovery', message: error instanceof Error ? error.message : String(error) })
  } finally { mutex.release() }
}

/** 正式重试只沿原失败链冷验已冻结候选；缺证据必须报错，不能退回模型重做。 */
async function verificationRetrySource(store: SyncStore, operation: SyncOperation, view: InputView, codeToSpec: boolean, renew: () => Promise<void>): Promise<{ operation: SyncOperation; attempt: SyncAttempt; generation: SavedGeneration; elaboration: SavedElaboration; analysis: CodeBehaviorEvidence; partitions: SyncPartitionPlan } | null> {
  if (!operation.retryOf) return null
  let owner = store.readOperation(operation.retryOf)
  if (syncModel(owner) !== syncModel(operation) || owner.recordUnverifiedCoverage !== operation.recordUnverifiedCoverage) return null
  let ancestor = owner, first = ancestor.currentAttemptId ? store.readAttempt(ancestor.currentAttemptId) : null
  const searched = new Set<string>()
  while (ancestor.retryOf && (!first?.candidate || ancestor.callsUsed === 0 && first.dispatchPlans.length === 0)) {
    if (!first?.candidate && first?.failure?.code === 'verification_unsupported') fail('candidate_retry_binding', '原验证失败缺少冻结候选，不能作为续验或重新生成')
    if (searched.has(ancestor.id)) fail('candidate_retry_binding', '正式续验来源链存在循环')
    searched.add(ancestor.id)
    ancestor = store.readOperation(ancestor.retryOf)
    first = ancestor.currentAttemptId ? store.readAttempt(ancestor.currentAttemptId) : null
  }
  if (syncModel(ancestor) !== syncModel(operation) || ancestor.recordUnverifiedCoverage !== operation.recordUnverifiedCoverage) return null
  if (first?.failure?.code !== 'verification_unsupported' && !(codeToSpec && first?.failure?.code === 'verification_failed')) return null
  function reject(message: string): never { return fail('candidate_retry_binding', message) }
  const candidate = first.candidate
  if (!candidate) reject('原验证失败缺少冻结候选，不能作为续验或重新生成')
  const seen = new Set<string>(), verificationSources: { operation: SyncOperation; attempt: SyncAttempt; executedFailure: boolean }[] = []
  for (;;) {
    if (seen.has(owner.id)) reject('正式续验来源链存在循环')
    seen.add(owner.id)
    if (owner.recordUnverifiedCoverage !== operation.recordUnverifiedCoverage) reject('正式候选续验必须保持原未执行覆盖选择')
    const prior = owner.currentAttemptId ? store.readAttempt(owner.currentAttemptId) : null
    const eligibility = store.readRetryEligibility(owner.id)
    const superseded = seen.size > 1 && owner.phase === 'superseded' && prior?.status === 'superseded'
    if (!eligibility.eligible && !(superseded && eligibility.reason!.code === 'SYNC_RETRY_PHASE')) reject(`原操作不能续验：${eligibility.reason!.code}：${eligibility.reason!.message}`)
    if (superseded && (store.sourceContinuityState(owner.input.source.commonDir).leasedOperationIds.includes(owner.id) || store.listRecoverableResources().some(item => item.operation.id === owner.id))) reject('原已superseded祖先仍有活租约或未结算资源')
    if (!superseded && (owner.phase !== 'failed' || prior?.status !== 'failed') || !prior || prior.operationId !== owner.id || !prior.failure || prior.verification || store.listJournals(owner.id).length || prior.candidate && canonical(prior.candidate) !== canonical(candidate)) reject('原验证失败、执行写权、资源或journal尚未完整结算')
    if (canonical(owner.input) !== canonical(operation.input) || syncModel(owner) !== syncModel(operation) || owner.origin !== operation.origin || (owner.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null) || owner.policyDigest !== operation.policyDigest || owner.planBlob?.sha256 !== operation.planBlob?.sha256 || owner.impactDigest !== operation.impactDigest || owner.readSetDigest !== operation.readSetDigest || canonical(owner.scope) !== canonical(operation.scope) || canonical(store.readBusinessBaselineSelection(owner.id)) !== canonical(store.readBusinessBaselineSelection(operation.id)) || (owner.previousBaselinePair?.id ?? null) !== (operation.previousBaselinePair?.id ?? null) || owner.deliveryPlan.baseCommit !== operation.deliveryPlan.baseCommit || canonical(prior.composedInput) !== canonical(view.composed)) reject('续验的来源、输入、原意、模型、政策、读集、scope或组合树已变化')
    if (canonical(owner.readyScope) !== canonical(candidate!.coveredScope) || owner.blockedScope.paths.length || owner.blockedScope.contractIds.length || owner.blockedScope.flowIds.length || owner.blockedReason || canonical(owner.readyScope) !== canonical(owner.scope)) reject('部分就绪或受阻候选不能取得完整续验资格')
    if (!prior.candidate) {
      const history = store.listAttempts(owner.id)
      if (!owner.retryOf || owner.callsUsed !== 0 || owner.delivery !== null || history.some(item => store.listResources(item.id).length) || !history.some(item => item.id === prior.id) || history.some(item => !['failed', 'superseded'].includes(item.status) || item.dispatchPlans.length || item.currentSession !== null || item.candidate !== null || item.verification !== null || item.publicationBase)) reject('候选认证失败后继已有调用、派发或副作用，不能跳过它复用祖先候选')
      owner = store.readOperation(owner.retryOf); continue
    }
    const generation = stage<SavedGeneration>(store, owner, prior, 'generation')
    const executedFailure = codeToSpec && prior.failure.code === 'verification_failed'
    if (executedFailure && prior.failure.kind !== 'repairable') reject('原V3失败分类与已执行测试不匹配')
    if (!generation) {
      const history = store.listAttempts(owner.id)
      if (!owner.retryOf || owner.callsUsed !== 0 || owner.delivery !== null || history.length !== 1 || history[0].id !== prior.id || prior.dispatchPlans.length || prior.currentSession !== null) reject('候选续验后继已有模型派发或不完整历史，不能跳过它复用祖先候选')
      if (prior.failure.code !== 'verification_unsupported') {
        verificationSources.push({ operation: owner, attempt: prior, executedFailure })
        owner = store.readOperation(owner.retryOf); continue
      }
    }
    if (executedFailure) verificationSources.push({ operation: owner, attempt: prior, executedFailure })
    else {
      if (prior.failure.code !== 'verification_unsupported' || prior.failure.kind !== 'unsupported') reject('原冻结候选没有V3前置unsupported失败，不能取得续验资格')
      const unsupported = readSyncCheckpoints(store, owner, prior).json.map(({ value }) => value as Stage).filter(value => value.version === 'sync-stage-v1' && value.stage?.startsWith('v3:') && value.operationId === owner.id && value.attemptId === prior.id && value.inputId === owner.input.id && value.policyDigest === owner.policyDigest && stageSelectionMatches(store, owner, value))
      if (unsupported.length !== 1 || !prior.failure.evidenceRefs.some(ref => ref.sha256 === unsupported[0].resultRef.sha256) || stage<VerificationResult>(store, owner, prior, unsupported[0].stage)?.status !== 'unsupported' || store.findResource(prior.id, `verification:${contentHash(`${prior.id}:${unsupported[0].stage.slice(3)}`)}`) || !generation && store.listResources(prior.id).length) reject('续验缺少原V3前置unsupported原件，或原验证已经登记资源')
    }
    if (!generation) { owner = store.readOperation(owner.retryOf!); continue }
    const elaboration = stage<SavedElaboration>(store, owner, prior, 'elaboration'), analysis = readCurrentSyncAnalysis(store, owner)
    const partitions = reviewPlanStage(store, owner, prior, 'candidate-partition-plan')?.result, originalPlan = reviewPlanStage(store, owner, prior, 'partition-plan')?.result
    if (generation.status !== 'reviewed' || !generation.reviewPassed || !generation.candidateValidated || generation.failure || generation.validationFindings.some(finding => finding.severity === 'error') || canonical(generation.candidate) !== canonical(candidate) || !elaboration?.structurePassed || !elaboration.reviewPassed || elaboration.status !== 'complete' || elaboration.failure || !elaborationComposedBinding(store, owner, prior, elaboration, view.composed) || !analysis || !partitions || !originalPlan || !generation.partitionEvidence?.length || !elaboration.partitionEvidence?.length || !analysis.analysis.partitionEvidence?.length) reject('续验需要完整P0、已审P1、V1及全部最终分区独审原件，旧缺席不补签')
    const guidance = analysis!.analysis.guidanceContractVersion
    if (guidance === 'code-behavior-guidance-v8') {
      if (analysisStageBinding(store, owner, analysis!.analysis)?.guidanceContractVersion !== guidance) reject('旧v8指导与原P0阶段原件失配')
      if (verificationSources.length || store.listResources(prior.id).some(resource => resource.plan.kind === 'verification')) reject('旧v8指导的候选来源链已有V3执行记录，不能按预检失败重新生成')
      verifyCandidate(owner.input.source.commonDir, candidate!)
      return null
    }
    const p0Owners = analysis!.analysis.partitionEvidence!.map(item => ({ partitionId: item.partitionId, analysisRef: item.analysisRef, wholeAnalysisRef: analysis!.ref }))
    if (!authenticateAnalysisOnlyPartitions(store, owner, prior, originalPlan!, analysis!, p0Owners)) reject('原P0分析与独审的Native/Git/schema或覆盖绑定失配')
    const p1 = elaboration!, p2 = generation, plan = partitions!
    const policy = JSON.parse(readEvidence(owner.input.source.commonDir, owner.planBlob!).toString()) as SyncCoordinatorPlan
    const specOnly = policy.version === 'sync-coordinator-v2' && policy.direction === 'code_to_spec'
    for (const trace of [...p1.rounds.flatMap(round => round.traces), ...p2.traces]) {
      const actual = store.listAttempts(owner.id).filter(attempt => attempt.number <= prior.number).find(attempt => attempt.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && canonical(dispatch.session) === canonical({ sessionId: trace.sessionId, threadId: trace.threadId, turnId: trace.turnId })))
      const dispatch = actual?.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId)
      if (!actual || !dispatch) reject('候选阶段缺少原实际Native派发身份')
      const resource = store.findResource(actual.id, dispatch.key)
      if (resource && !matchesNativeDispatchModel(owner, dispatch, (JSON.parse(readEvidence(owner.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan).request)) reject('原Native模型与正式派发所登记的路线不同')
    }
    if (!partitionedElaborationCoverageMatches(originalPlan!.partitions.map(item => item.id), p1.partitionEvidence!.map(item => item.partitionId), p1.analysisOnlyPartitions?.map(item => item.partitionId) ?? []) || p1.analysisOnlyPartitions?.length && !authenticatedMixedElaborationCoverage(store, owner, prior, originalPlan!, p1)) reject('原P1分区批准未完整覆盖同一冻结计划')
    for (const member of p1.partitionEvidence!) {
      await renew()
      const key = `partition:${member.partitionId}:elaboration`
      const local = reviewedReadonlyLocal(store, owner, prior, key, member.resultRef, writeEvidence(owner.input.source.commonDir, p1)), round = local.rounds.at(-1)!
      const trace = round.traces.find(trace => trace.purpose === 'elaboration_review')!
      const source = store.listAttempts(owner.id).find(attempt => attempt.number <= prior.number && attempt.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && canonical(dispatch.session) === canonical({ sessionId: trace.sessionId, threadId: trace.threadId, turnId: trace.turnId })))
      const dispatch = source?.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId)
      const result = source && dispatch ? authenticatedDraftResult(store, owner, source, dispatch.key, trace.purpose) : null
      if (!round.draft || !round.candidate || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || round.candidate.inputDigest !== local.inputDigest || local.candidateDigest !== round.candidateDigest || canonical(local.changes) !== canonical(round.candidate.changes.map(change => ({ ...change, contentDigest: contentHash(change.source) }))) || !result?.result || result.result.resultDigest !== trace.resultDigest || canonical(result.result.output) !== canonical(round.reviewOutput) || canonical(round.review) !== canonical({ ...(round.reviewOutput as object), inputDigest: local.inputDigest, candidateDigest: local.candidateDigest }) || !hasApprovedElaborationReview(local) || ELABORATION_BOUNDARIES.some(boundary => !round.review!.checkedBoundaries.includes(boundary))) reject('原P1候选、草稿渲染或完整独立审查绑定失配')
      readStageDraft(owner.input.source.commonDir, round.draft!, round.draft!)
    }
    const traces: ElaborationTrace[] = [], checked = new Set<string>(), reviewInputs: GenerationInput[] = []
    for (const member of p2.partitionEvidence!) {
      await renew()
      const key = `partition:${member.partitionId}:candidate-review`, savedInput = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, owner, prior, `${key}:input`), savedReview = partitionStage<SavedGeneration>(store, owner, prior, key)
      const input = savedInput ? restoreGenerationInput(savedInput.result) : savedReview ? acceptedReviewInput(store, owner, prior, key, savedReview.resultRef) : null
      if (!input) reject('最终独审缺少原完整冻结输入，不能猜测或重签')
      const reviewed = acceptedCandidateReviewSource(store, owner, prior, key, candidate!, plan, input)
      if (!reviewed || canonical(reviewed.result.review) !== canonical(member.review) || canonical(reviewed.result.traces) !== canonical(member.traces) || canonical(input.snapshot) !== canonical(owner.input) || input.policy.digest !== owner.policyDigest || input.model !== syncModel(owner) || canonical(input.composed) !== canonical(view.composed)) reject('最终独审的原输入、模型、候选、Native或覆盖绑定失配')
      reviewInputs.push(input)
      for (const id of member.review.checkedIds) checked.add(id)
      traces.push(...member.traces)
      if (!specOnly && !member.partitionId.startsWith('edge:')) {
        const builderKey = `partition:${member.partitionId}:generation`
        const builder = generationBuilderSource(store, owner, prior, builderKey, candidate!, originalPlan!)
        const priorBuilder = builder.result
        const { reviewRepair: _repair, ...builderInput } = input
        const replay = await runGeneration({ ...builderInput, requestKey: `sync:${builder.attempt.id}:generation:partition:${member.partitionId}` }, { prepareOnly: true, validateCandidate: async () => [], runner: async request => {
          const result = priorBuilder.traces.length === 1 && completedNativeStageResult(store, owner, builder.attempt, request, priorBuilder.traces[0], priorBuilder.output, candidate!.digest)
          if (!result) reject('原builder完整请求、Native或Git提交身份失配')
          return result!
        } })
        if (replay.status !== 'prepared' || replay.inputDigest !== priorBuilder.inputDigest || canonical(replay.preparedChanges) !== canonical(priorBuilder.preparedChanges)) reject('原builder真实Git差量、schema或写范围已变化')
      }
    }
    const acceptedFiles = new Map(view.files)
    for (const change of p1.nodeChanges ?? []) if (change.action === 'retire' || change.from.path !== change.to.path) acceptedFiles.delete(change.from.path)
    for (const change of p1.changes) acceptedFiles.set(change.path, change.source)
    const accepted = await readFrozenContracts(owner.input.source.canonicalRoot, acceptedFiles)
    // 集合复算用已审完整P1与全局ready；局部原件仅提供未参与集合选择的执行上下文。
    const dispatch = implementationGenerationDispatch({ ...reviewInputs[0], requestKey: `sync:${prior.id}:generation`, files: view.files, manifest: view.manifest, contracts: accepted.contracts, elaboratedSpecs: p1.changes.map(change => ({ path: change.path, source: change.source })), readyIds: [...owner.readyScope.contractIds, ...owner.readyScope.flowIds], blockedIds: [], retiredIds: p1.retiredIds, retiredOwners: [...new Map(reviewInputs.flatMap(input => input.retiredOwners ?? []).map(item => [item.id, item])).values()], nodeChanges: p1.nodeChanges, analysis: analysis!, analysisEvidence: undefined, readonlyContractPaths: undefined, allowedScope: owner.readyScope, mandatoryTests: policy.mandatoryTests }, plan, specOnly)
    const budget = partitionStage<{ requiredKeys: string[] }>(store, owner, prior, 'partition-generation-budget')?.result
    if (!budget || !Array.isArray(budget.requiredKeys) || canonical(budget.requiredKeys.filter(key => key.endsWith(':code_review')).sort()) !== canonical(dispatch.requiredKeys.filter(key => key.endsWith(':code_review')).sort()) || canonical(unique(p2.partitionEvidence!.map(member => member.partitionId))) !== canonical(unique(dispatch.reviews.map(review => review.id)))) reject('最终独审集合未精确覆盖原冻结派发计划的全部就绪local与依赖edge')
    if (new Set(p2.partitionEvidence!.map(item => item.partitionId)).size !== p2.partitionEvidence!.length || [...owner.readyScope.contractIds, ...owner.readyScope.flowIds].some(id => !checked.has(id)) || canonical(p2.traces.filter(trace => trace.purpose === 'code_review')) !== canonical(traces)) reject('最终独审缺少真实完整覆盖或身份并集')
    verifyCandidate(owner.input.source.commonDir, candidate!)
    if (verificationSources.length) {
      const historical = new Set([...(owner.previousBaselinePair?.retiredIds ?? []), ...(owner.baselineSelection ? selectedRetiredIds(store.readBusinessBaselineSelection(owner.id)!) : [])])
      const before = await readFrozenContracts(owner.input.source.canonicalRoot, priorDeliveryFiles({ ...owner, baselineSelection: store.readBusinessBaselineSelection(owner.id) }, view, [...policy.readPaths, ...owner.scope.paths], policy))
      const frozen = await candidateContext(store, owner, candidate, p1)
      const runs = acceptanceRuns(frozen, owner.readyScope, policy, { before, ids: p1.retiredIds.filter(id => !historical.has(id)) }, unexecutedCandidateIds(owner, frozen, owner.readyScope))
      for (const carrier of verificationSources) {
        await renew()
        const { operation: source, attempt, executedFailure } = carrier, commonDir = source.input.source.commonDir
        const exported = stage<{ path: string; digest: string }>(store, source, attempt, 'export')
        const intent = stage<{ path: string; tree: string; candidateDigest: string }>(store, source, attempt, 'export-intent')
        const resources = store.listResources(attempt.id).filter(resource => source.id !== owner.id || resource.plan.kind === 'verification')
        if (!resources.length || !exported || !intent || intent.path !== exported.path || intent.tree !== candidate.tree || intent.candidateDigest !== candidate.digest || exported.digest !== await verificationExportDigest(exported.path)) reject('候选续验后继缺少原冻结导出或真实已结算验收资源')
        const runOutcomes = new Map<string, VerificationResult['status']>()
        for (const resource of resources) {
          const run = runs.find(run => resource.plan.key === `verification:${contentHash(`${attempt.id}:${run.verificationId}`)}`)
          if (!run || resource.plan.kind !== 'verification' || resource.phase !== 'removed' || resource.operationId !== source.id || resource.attemptId !== attempt.id || resource.generation !== attempt.generation || resource.plan.inputId !== source.input.id || resource.plan.candidateDigest !== candidate.digest) reject('候选续验后继存在未知、未结算或绑定失配的验证资源')
          const request = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as Omit<VerificationRequest, 'previousCheckpoint'>
          if (request.runId !== contentHash(`${attempt.id}:${run.verificationId}`) || canonical(request.policy) !== canonical(run.policy) || request.candidateExportPath !== exported!.path || request.candidateExportDigest !== exported!.digest || contentHash(JSON.stringify(request)) !== resource.plan.payloadDigest) reject('候选续验后继原验证请求、政策或导出绑定失配')
          const recovered = await runAttemptVerification(store, fenceFor(source, attempt), request, { driver: async () => reject('只读冷验不得派发验证driver'), onCheckpointRecorded: async () => reject('只读冷验不得写入旧验证checkpoint') })
          const { checkpoint, evidence, status } = recovered.result
          const failedRun = executedFailure && status === 'failed'
          if (recovered.resourceId !== resource.id || !(status === 'passed' || failedRun) || !checkpoint || !evidence || checkpoint.notCreated || evidence.outcome !== status || !failedRun && evidence.exitCode !== 0 || evidence.logsTruncated || evidence.reportFormat !== 'node-test-events-v1' || evidence.runId !== request.runId || evidence.inputDigest !== source.input.id || evidence.candidateDigest !== candidate.digest || evidence.exportDigest !== exported!.digest || evidence.policyDigest !== checkpoint.policyDigest || evidence.configDigest !== checkpoint.configDigest || evidence.runnerDigest !== checkpoint.config.runnerDigest || evidence.containerId !== checkpoint.containerId || canonical(checkpoint.config.policy) !== canonical(run.policy)) reject('原真实验证回执缺失或内容绑定失配')
          const report = parseVerificationReport(evidence.stdout, run.policy.expectedTestIds)
          const reportPassed = report.reportComplete && !report.unmatchedTestIds.length && report.tests.every(test => test.status === 'passed')
          if (!failedRun && !reportPassed || report.reportTruncated || canonical(report.tests) !== canonical(evidence.tests) || canonical(report.unmatchedTestIds) !== canonical(evidence.unmatchedTestIds) || evidence.reportComplete !== report.reportComplete) reject('原业务测试报告与真实执行不一致')
          if (executedFailure) {
            const originalStage = partitionStage<VerificationResult>(store, source, attempt, `v3:${run.verificationId}`)
            if (!originalStage || canonical(originalStage.result) !== canonical(recovered.result) || failedRun && !attempt.failure!.evidenceRefs.some(ref => ref.sha256 === originalStage.resultRef.sha256)) reject('原V3阶段或正式失败没有绑定真实已结算报告')
          }
          runOutcomes.set(run.verificationId, status)
          const terminal = resource.checkpoints.filter(item => item.phase === 'terminal').map(item => JSON.parse(readEvidence(commonDir, item.checkpointRef).toString()) as NonNullable<typeof checkpoint>)
          if (!resource.checkpoints.some(item => item.phase === 'created') || !terminal.length || terminal.some(item => canonical(item.evidence) !== canonical(evidence) || item.configDigest !== checkpoint.configDigest || item.containerId !== checkpoint.containerId)) reject('候选续验后继缺少原真实created及terminal验证回执')
          if (checkpoint.version === 'verification-checkpoint-v2') {
            const transport = checkpoint.transport
            const closed = transport?.closed as { closed?: boolean; rebuildersDrained?: boolean; effects?: { receipt?: { effect: unknown; settled?: boolean; rejected?: string } }[]; fencedNotExecuted?: unknown[] } | undefined
            const cleanup = transport?.cleanup as { effect?: unknown; settled?: boolean; cleaned?: boolean } | undefined
            if (!transport || canonical(transport.plan) !== canonical(checkpoint.config.transport) || transport.attestation?.exportDigest !== exported!.digest || transport.attestation.runnerDigest !== checkpoint.config.runnerDigest || !closed?.closed || !closed.rebuildersDrained || !Array.isArray(closed.effects) || !Array.isArray(closed.fencedNotExecuted) || closed.fencedNotExecuted.length || !cleanup?.settled || !cleanup.cleaned || !transport.effects.some(effect => canonical(effect) === canonical(cleanup.effect)) || transport.effects.filter(effect => effect.kind !== 'cleanup').some(effect => !closed.effects!.some(item => item.receipt?.settled && !item.receipt.rejected && canonical(item.receipt.effect) === canonical(effect)))) reject('候选续验后继缺少原远端closed排空、完整effect或staging移除证明')
          }
        }
        if (executedFailure) {
          const failedIndex = runs.findIndex(run => runOutcomes.get(run.verificationId) === 'failed')
          if (failedIndex < 0 || runOutcomes.size !== failedIndex + 1 || runs.slice(0, failedIndex).some(run => runOutcomes.get(run.verificationId) !== 'passed')) reject('原V3未保留完整通过前序及唯一失败命令')
        }
      }
    }
    return { operation: owner, attempt: prior, generation: p2, elaboration: p1, analysis: analysis!, partitions: plan }
  }
}

/** 唯一应用编排入口；副作用恢复优先于新生成，四层真实证据通过后才发布。 */
export async function runSyncOperation(store: SyncStore, operationId: string, supplied: SyncCoordinatorOptions): Promise<SyncCoordinatorResult> {
  const operation = store.readOperation(operationId)
  const scope: FrozenAnalysisScope = { active: true, operationId, inputId: operation.input.id, source: canonical(operation.input.source), policyDigest: operation.policyDigest, refs: new Set(), ...(operation.inheritRetryBudget ? { readNativeRecord: readRecord } : {}) }
  return frozenAnalysisScope.run(scope, async () => {
    try { return await runSyncOperationInScope(store, operationId, supplied) }
    finally { scope.active = false; scope.refs.clear() }
  })
}

async function runSyncOperationInScope(store: SyncStore, operationId: string, supplied: SyncCoordinatorOptions): Promise<SyncCoordinatorResult> {
  const options = { ...supplied, plan: structuredClone(supplied.plan) }
  let statusOnlyAnalysisFailure: unknown
  let operation = store.readOperation(operationId)
  const model = syncModel(operation)
  safeArtifactRoot(options.artifactRoot, operation)
  const locks = join(options.artifactRoot, '.locks')
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  safeArtifactRoot(locks, operation)
  const mutex = claimFileMutex(join(locks, `${contentHash(operation.id)}.sqlite`))
  if (!mutex) return { status: 'busy', operation }
  let fence: WriteFence | undefined, timer: ReturnType<typeof setInterval> | undefined, repairContext: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } | undefined, seed: ElaborationRepairSeed | undefined, heartbeatFailure: SyncFailure | undefined, refinement: Refinement | undefined, readonlyOwnerRepair: ReadonlyOwnerRepair | undefined, readonlyBase: ApprovedElaboration | null = null, readonlyActiveOwners: ReadonlyOwnerRepair['owners'] = []
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let publicationMutex: FileMutex | null = null
  const leaseMs = options.leaseMs ?? 120_000, heartbeatMs = options.heartbeatMs ?? Math.min(5_000, Math.floor(leaseMs / 3))
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 3 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseMs) { mutex.release(); fail('lease_configuration', 'heartbeat必须是正整数且小于leaseMs') }
  const receipt = (): ApplyReceipt | undefined => store.listJournals(operationId).find(journal => journal.status === 'settled')?.receipt ?? undefined
  const current = (status?: SyncCoordinatorResult['status'], failure?: SyncFailure): SyncCoordinatorResult => { operation = store.readOperation(operationId); return { status: status ?? operation.phase, operation, ...(receipt() ? { receipt: receipt() } : {}), ...(failure ? { failure } : {}) } }
  const failure = (code: string, message: string, kind: SyncFailure['kind'], evidenceRefs: BlobRef[] = []): SyncFailure => ({ code, message, kind, evidenceRefs })
  const physicallyPaused = (): boolean => store.readPhysicalControl(operation.input.source).control === 'pause'
  const releasePublication = (): void => { publicationMutex?.release(); publicationMutex = null }
  const acquirePublication = async (finishing = false): Promise<void> => {
    const directory = join(options.artifactRoot, '.publication-locks')
    mkdirSync(directory, { recursive: true, mode: 0o700 }); safeArtifactRoot(directory, operation)
    while (!publicationMutex) {
      if (!finishing && (signal.aborted || physicallyPaused())) fail('controlled', '发布阶段已暂停或取消')
      if (!finishing && syncDeadlineExpired(operation.deadlineAtMs)) throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', '等待发布超过原总预算')
      publicationMutex = claimFileMutex(join(directory, `${contentHash(canonical(operation.input.source))}.sqlite`))
      if (!publicationMutex) await waitForPublication(25, undefined, finishing ? {} : { signal })
    }
    publicationMutex.assertHeld()
  }
  const v4 = async (): Promise<BlobRef> => {
    mutex.assertHeld()
    const snapshot = await captureInputSnapshot(operation.input.source.canonicalRoot, operation.input.captureKind === 'commit' ? { committed: true } : undefined)
    if (!await isSyncInputCurrent(operation, snapshot, options.plan, store.readBusinessBaselineSelection(operation.id))) fail('input_changed', '来源相关内容/index/HEAD或物理身份已改变', [writeEvidence(operation.input.source.commonDir, { expected: operation.input, actual: snapshot })])
    const plan = await options.readCurrentPlan()
    if (syncPlanDigest(plan) !== operation.policyDigest) fail('policy_changed', '当前可信政策与冻结操作不同')
    const view = await readInput(operation.baselineSelection ? operation.input : snapshot, plan, operation.previousBaselinePair, operation.requestBlob, store.readBusinessBaselineSelection(operation.id), operation.scope.paths)
    if (view.readSetDigest !== operation.readSetDigest) fail('readset_changed', '当前完整读取上下文已改变')
    const now = store.readOperation(operation.id), attempt = store.readAttempt(fence!.attemptId)
    if (now.control !== 'run' || physicallyPaused() || now.currentAttemptId !== attempt.id || attempt.expiresAtMs <= Date.now() || syncDeadlineExpired(now.deadlineAtMs) || signal.aborted) fail('controlled', '交付门禁已停止或过期')
    return writeEvidence(operation.input.source.commonDir, { version: 1, layer: 'V4', inputId: snapshot.id, source: snapshot.source, policyDigest: now.policyDigest, readSetDigest: view.readSetDigest, ...(now.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), checkedAtMs: Date.now() })
  }
  const beforeApply = async (): Promise<void> => {
    try { await v4() }
    catch (error) {
      const currentOperation = store.readOperation(operationId), attempt = store.readAttempt(fence!.attemptId)
      if (currentOperation.control === 'run' && currentOperation.currentAttemptId === attempt.id && attempt.status === 'verified' && attempt.expiresAtMs > Date.now()) {
        if (syncDeadlineExpired(currentOperation.deadlineAtMs)) store.recordBudgetExhaustion(operationId)
        else if (error instanceof SyncCoordinatorError && ['input_changed', 'policy_changed', 'readset_changed'].includes(error.code)) store.recordFailure(fence!, failure(error.code, error.message, 'conflict', error.evidenceRefs))
      }
      throw error
    }
  }
  const deliver = async (activeFence: WriteFence, recoveryOnly = false): Promise<{ operation: SyncOperation; receipt: ApplyReceipt }> => {
    for (;;) {
      const attempt = store.readAttempt(activeFence.attemptId)
      if (attempt.publicationBase) await acquirePublication(recoveryOnly || attempt.status === 'applying')
      try { return await deliverVerifiedAttempt(store, activeFence, { managedRoot: options.managedRoot, tools: options.tools, beforeApply: recoveryOnly ? async () => fail('recovery_apply_forbidden', '只恢复已开始journal，禁止新apply') : beforeApply, ...(!recoveryOnly ? options.deliveryHooks : {}) }) }
      catch (error) {
        releasePublication()
        if (!(error instanceof SyncStoreError) || error.code !== 'SYNC_PUBLICATION_BUSY') throw error
        await waitForPublication(25, undefined, { signal })
      }
    }
  }
  const verifyAndDeliver = async (activeAttempt: SyncAttempt, generated: SavedGeneration, elaboration: SavedElaboration, ready: SyncScope, retirementBefore: FrozenContracts, retiredIds: string[], view: InputView, partitions: SyncPartitionPlan | null, analysis: CodeBehaviorEvidence | undefined, restorations: readonly { id: string }[], hasDecision: boolean): Promise<SyncCoordinatorResult | undefined> => {
    const p1Evidence = writeEvidence(operation.input.source.commonDir, elaboration)
    const candidate = generated.candidate!
    const attempt = store.readAttempt(activeAttempt.id)
    if (attempt.publicationBase) await acquirePublication()
    if (!attempt.candidate) store.freezeCandidate(fence!, candidate)
    else if (canonical(attempt.candidate) !== canonical(candidate)) fail('candidate_binding', '已有候选不能替换')
    const frozenCandidate = await candidateContext(store, operation, candidate, elaboration)
    const unexecutedContractIds = unexecutedCandidateIds(operation, frozenCandidate, ready)
    const runs = acceptanceRuns(frozenCandidate, ready, options.plan, { before: retirementBefore, ids: retiredIds }, unexecutedContractIds)
    const candidateExportPath = join(options.artifactRoot, `export-${attempt.id}`), scratch = join(options.artifactRoot, `scratch-${attempt.id}`)
    let exported = stage<{ path: string; digest: string; exclusionBlob: BlobRef }>(store, operation, store.readAttempt(attempt.id), 'export')
    if (!exported) {
      saveStage(store, fence!, 'export-intent', { path: candidateExportPath, tree: candidate.tree, candidateDigest: candidate.digest })
      if (existsSync(candidateExportPath)) fail('export_recovery', 'export存在但没有完整证明，保留现场等待恢复')
      const exportResult = exportCandidate(operation.input.source.commonDir, candidate, candidateExportPath)
      exported = { path: exportResult.root, digest: await verificationExportDigest(exportResult.root), exclusionBlob: exportResult.exclusionBlob }
      saveStage(store, fence!, 'export', exported)
    }
    if (exported.path !== candidateExportPath || exported.digest !== await verificationExportDigest(candidateExportPath)) fail('export_changed', '候选readonly export已改变')
    mkdirSync(scratch, { recursive: true, mode: 0o700 }); safeArtifactRoot(scratch, operation)
    const v3Results: VerificationResult[] = []
    for (const run of runs) {
      const name = `v3:${run.verificationId}`
      let result = stage<VerificationResult>(store, operation, store.readAttempt(attempt.id), name)
      if (!result || result.status === 'recovery_required') {
        const verified = await runAttemptVerification(store, fence!, { runId: contentHash(`${attempt.id}:${run.verificationId}`), inputDigest: operation.input.id, candidateDigest: candidate.digest, candidateExportDigest: exported.digest, candidateExportPath, privateScratchRoot: scratch, policy: run.policy, signal }, { driver: options.verificationDriver, transport: options.verificationTransport })
        result = verified.result
        if (store.readOperation(operationId).control === 'run' && store.readOperation(operationId).currentAttemptId === attempt.id && !signal.aborted) saveStage(store, fence!, name, result)
      }
      v3Results.push(result)
      if (result.status !== 'passed') break
    }
    const failedV3 = v3Results.find(result => result.status !== 'passed')
    if (failedV3) {
      if (failedV3.status === 'recovery_required') return current('recovery_required')
      const ref = writeEvidence(operation.input.source.commonDir, failedV3)
      if (signal.aborted || failedV3.status === 'cancelled') fail('cancelled', failedV3.reason ?? '隔离运行已停止', [ref])
      const kind: SyncFailure['kind'] = failedV3.status === 'unsupported' ? 'unsupported' : 'repairable'
      const issue = failure(`verification_${failedV3.status}`, failedV3.reason ?? '真实隔离验收未通过', kind, [ref])
      store.recordFailure(fence!, issue)
      if (kind === 'unsupported') return current('unsupported', issue)
      if (options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec') return current(undefined, issue)
      repairContext = { previousOutput: generated.output, diagnostics: [{ code: issue.code, message: `${issue.message}\n${canonical(failedV3.evidence ?? {})}` }] }; return undefined
    }
    const v4Ref = await v4(), v1Ref = writeEvidence(operation.input.source.commonDir, { candidateDigest: candidate.digest, findings: generated.validationFindings, candidateValidated: generated.candidateValidated }), v2Ref = writeEvidence(operation.input.source.commonDir, { candidateDigest: candidate.digest, review: generated.review, traces: generated.traces, ...(generated.partitionEvidence ? { partitionEvidence: generated.partitionEvidence, fileWriterPlanRef: generated.fileWriterPlanRef, partitionPlanDigest: partitions?.digest, partitionCoverage: generated.partitionEvidence.filter(item => !item.partitionId.startsWith('edge:')).map(item => item.partitionId), dependencyCoverage: partitions?.dependencies.filter(edge => generated.partitionEvidence?.some(item => item.partitionId === `edge:${edge.from}:${edge.to}`)) } : {}) }), v3Refs = v3Results.map(result => writeEvidence(operation.input.source.commonDir, result))
    const bindings = { inputId: operation.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, ...(operation.baselineSelection ? { baselineSelectionDigest: operation.baselineSelection.digest } : {}), environmentDigest: contentHash(canonical(runs.map(run => run.policy))), contextDigest: contentHash(canonical({ readSetDigest: view.readSetDigest, baselineSelection: operation.baselineSelection ?? null, publicationBase: attempt.publicationBase ?? null, elaboration: p1Evidence, composed: view.composed, analysisRef: analysis?.ref ?? null, decisionRef: hasDecision ? operation.requestBlob : null })) }
    const result: VerificationResultBlob = { schemaVersion: 1, coveredScope: ready, retiredIds: unique(elaboration.retiredIds), restoredIds: restorations.map(change => change.id).sort(), decisionRefs: [...options.plan.decisionRefs ?? [], ...(hasDecision && operation.requestBlob ? [operation.requestBlob] : [])], ...bindings, ...(unexecutedContractIds ? { unexecutedContractIds } : {}), layers: [{ layer: 'V1', verdict: 'pass', evidenceRefs: [v1Ref] }, { layer: 'V2', verdict: 'pass', evidenceRefs: [v2Ref] }, { layer: 'V3', verdict: 'pass', evidenceRefs: v3Refs }, { layer: 'V4', verdict: 'pass', evidenceRefs: [v4Ref] }] }
    store.recordVerification(fence!, { ...bindings, passed: true, coveredScope: ready, evidenceRefs: [p1Evidence, v1Ref, v2Ref, ...v3Refs, v4Ref], resultBlob: writeEvidence(operation.input.source.commonDir, result) })
    const delivered = await deliver(fence!)
    return { status: delivered.operation.phase, ...delivered }
  }
  try {
    operation = store.readOperation(operationId)
    let attempt = operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId) : null
    if (options.recoveryOnly) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      const journals = store.listJournals(operationId).filter(journal => journal.status !== 'settled')
      for (const journal of journals) {
        if (!attempt || journal.attemptId !== attempt.id || !operation.delivery || attempt.status !== 'applying') fail('journal_recovery', '既定journal没有同attempt的已绑定交付写入单元')
        const delivered = await deliver(fenceFor(operation, attempt), true)
        operation = delivered.operation
      }
      return current()
    }
    if (physicallyPaused() && attempt?.status !== 'applying') {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      return current('paused')
    }
    if (attempt?.status === 'applying' || attempt?.status === 'verified') {
      fence = fenceFor(operation, attempt)
      if (attempt.status === 'verified' && (operation.control !== 'run' || attempt.expiresAtMs <= Date.now() || syncDeadlineExpired(operation.deadlineAtMs))) {
        if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      } else {
        if (attempt.status === 'verified') timer = setInterval(() => { try { store.renewLease(fence!, leaseMs) } catch (error) { heartbeatFailure = failure('lease_heartbeat', error instanceof Error ? error.message : String(error), 'environment'); controller.abort() } }, heartbeatMs)
        const delivered = await deliver(fence)
        return { status: delivered.operation.phase, ...delivered }
      }
    }
    const terminal = ['workspace_synced', 'canonical_synced', 'awaiting_landing', 'cancelled', 'superseded', 'paused', 'budget_exhausted']
    if (terminal.includes(operation.phase) || operation.control !== 'run' || attempt?.status === 'settled' || (attempt?.status === 'failed' && attempt.failure?.kind !== 'repairable')) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      const head = store.nextDispatch(operation.input.source.repositoryId)
      if (head?.operation.id === operation.id && (operation.control !== 'run' || terminal.includes(operation.phase))) store.discardDispatch(operation.id, head.messageId)
      return current()
    }
    for (;;) {
      releasePublication()
      mutex.assertHeld()
      operation = store.readOperation(operationId)
      attempt = operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId) : null
      if (timer && attempt && fence?.attemptId === attempt.id && ['failed', 'superseded', 'settled'].includes(attempt.status)) {
        clearInterval(timer); timer = undefined
      }
      if (physicallyPaused()) {
        if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
        return current('paused')
      }
      const active = attempt && !['failed', 'superseded', 'settled'].includes(attempt.status) && attempt.expiresAtMs > Date.now()
      if (!await recoverResources(store, operation, options, !active)) return current('recovery_required')
      if (!active) {
        if (attempt?.failure?.kind === 'repairable' && reuseBehaviorDependentStages(store, operation, attempt)) {
          refinement = stage<Refinement>(store, operation, attempt, 'refinement') ?? refinement
          const previous = stage<SavedGeneration>(store, operation, attempt, 'generation')
          if (previous) {
            repairContext = generationRepairInput(previous, attempt.failure)
          }
          else {
            const elaboration = stage<SavedElaboration>(store, operation, attempt, 'elaboration')
            seed = elaborationRepairSeed(elaboration, `sync:${attempt.id}:elaborate`)
          }
        }
        try {
          if (operation.baselineSelection && !operation.dispatchAcknowledged) return current('busy')
          const claim = { operationId, source: operation.input.source, scope: operation.scope, leaseMs }
          const claimed = operation.baselineSelection
            ? store.claimQueuedAttempt({ ...claim, expectedRevision: operation.revision, ...(operation.currentAttemptId ? { continuation: true } : {}) })
            : store.claimAttempt({ ...claim, ...(operation.currentAttemptId ? {} : { expectedMessageId: operation.dispatchMessageId }) })
          fence = claimed.fence; attempt = claimed.attempt; operation = claimed.operation
        } catch (error) {
          if (error instanceof SyncStoreError && error.code === 'SYNC_BUDGET_EXHAUSTED') { store.recordBudgetExhaustion(operationId); return current() }
          if (['PROTOCOL_CURSOR_INVALID', 'SYNC_DISPATCH_WAITING', 'SYNC_QUEUED_STALE', 'SYNC_LEASE_CONFLICT'].includes((error as { code?: string }).code ?? '')) return current('busy')
          if (error instanceof SyncStoreError && error.code === 'SYNC_PHYSICAL_PAUSED') return current('paused')
          throw error
        }
      } else fence = fenceFor(operation, attempt!)
      if (operation.baselineSelection && !await isSyncInputCurrent(operation, await captureInputSnapshot(operation.input.source.canonicalRoot, operation.input.captureKind === 'commit' ? { committed: true } : undefined), options.plan, store.readBusinessBaselineSelection(operation.id))) fail('input_changed', '派发前来源相关输入已改变')
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        try {
          mutex.assertHeld()
          const now = store.readOperation(operationId)
          if (now.control !== 'run' || physicallyPaused() || now.currentAttemptId !== fence!.attemptId || syncDeadlineExpired(now.deadlineAtMs)) controller.abort()
          else store.renewLease(fence!, leaseMs)
        } catch (error) { heartbeatFailure = failure('lease_heartbeat', error instanceof Error ? error.message : String(error), 'environment'); controller.abort() }
      }, heartbeatMs)
      operation = store.readOperation(operationId); attempt = store.readAttempt(fence.attemptId)
      if (!operation.planBlob) fail('plan_missing', '旧操作没有完整可信计划证据，不能猜测或借用另一份政策恢复')
      const legacy = frozenAnalysisScope.getStore()!
      legacy.refs.clear(); delete legacy.candidateDigest; delete legacy.inlineV1Repair
      const renewReadonlyRecovery = async (): Promise<void> => {
        store.renewLease(fence!, leaseMs); await yieldToControl()
        if (signal.aborted) fail('cancelled', '只读恢复认证已停止')
        store.renewLease(fence!, leaseMs)
      }
      const handoffParent = reviewHandoffParent(store, operation)
      let authenticatedCandidate: FrozenCandidateAnalysis | null = null
      if (handoffParent) {
        const prior = store.listAttempts(handoffParent.id).reverse().find(prior => ['failed', 'superseded'].includes(prior.status) && stage<SavedGeneration>(store, handoffParent, prior, 'generation')?.candidate)
        const proof = prior && await authenticateFrozenCandidateAnalysis(store, handoffParent, prior, { renew: renewReadonlyRecovery, includeCurrent: true })
        if (!proof) fail('review_handoff_binding', '显式模型交接需要当前指导或可冷验的原git-json-v4/v7，以及完整原P0/P1和未完成P2候选')
        authenticatedCandidate = proof
        legacy.candidateDigest = proof.candidateDigest
        for (const ref of proof.analysisRefs) legacy.refs.add(ref)
      }
      if (options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec') {
        for (const prior of store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded'].includes(prior.status)).reverse()) {
          const generated = stage<SavedGeneration>(store, operation, prior, 'generation')
          if (!generated) continue
          const priorAnalysis = authenticatedCandidate && stage<CodeBehaviorAnalysis>(store, operation, prior, 'analysis', 'evidence')
          if (priorAnalysis?.reviewPassed && priorAnalysis.inputId === operation.input.id && priorAnalysis.policyDigest === operation.policyDigest
            && priorAnalysis.composedDigest === prior.composedInput?.contentDigest
            && authenticatedCandidate!.analysisRef.sha256 === contentHash(JSON.stringify(priorAnalysis))
            && analysisStageBinding(store, operation, priorAnalysis)
            && generated.status === 'repair' && generated.candidate && !generated.candidateValidated && !generated.reviewPassed && prior.failure?.kind === 'repairable') {
            const errors = generated.validationFindings.filter(finding => finding.severity === 'error')
            const basis = errors.length && errors.every(isReadonlyCitationFailure) && readonlyRepairBinding(store, operation, prior)?.readonlyOwnerRepair
            if (basis) {
              validateReadonlyRepair(store, operation, basis)
              authenticatedCandidate = null
              break
            }
          }
          const inline = !options.plan.agentWorkflow
          const proof = await authenticateCandidateAnalysis(store, operation, prior, { renew: renewReadonlyRecovery, ...(inline ? { inlineV1Repair: true } : {}) })
          if (proof) {
            if ('formatReviewKeys' in proof) authenticatedCandidate = proof
            else legacy.inlineV1Repair = true
            legacy.candidateDigest = proof.candidateDigest
            for (const ref of proof.analysisRefs) legacy.refs.add(ref)
          }
          break
        }
      }
      const savedRepair = stage<{ repairContext?: typeof repairContext; seed?: ElaborationRepairSeed; refinement?: Refinement; readonlyOwnerRepair?: ReadonlyOwnerRepair }>(store, operation, attempt, 'repair-input')
      if (savedRepair) { repairContext = savedRepair.repairContext; seed = savedRepair.seed; refinement = savedRepair.refinement; readonlyOwnerRepair = savedRepair.readonlyOwnerRepair }
      const frozenReadonlyRepair = readonlyRepairBinding(store, operation, attempt)
      if (frozenReadonlyRepair?.readonlyOwnerRepair) validateReadonlyRepair(store, operation, frozenReadonlyRepair.readonlyOwnerRepair)
      readonlyBase = null; readonlyActiveOwners = []
      if (options.plan.version === 'sync-coordinator-v2') {
        readonlyBase = latestApprovedElaboration(store, operation, attempt.number + 1)
        await renewReadonlyRecovery()
        const pending = authenticatedCandidate?.operationId === operation.id && authenticatedCandidate.formatReviewKeys.length
          ? null : pendingReadonlyRepair(store, operation, attempt, readonlyBase)
        await renewReadonlyRecovery()
        const original = frozenReadonlyRepair?.readonlyOwnerRepair
        if (original && pending && canonical(readonlyRepairOriginalShape(pending.repair, original)) !== canonical(original)) fail('readonly_spec_repair_binding', '本attempt已冻结只读诊断与当前来源不一致，不能重签原请求')
        readonlyOwnerRepair = original && pending ? original : pending?.repair
        readonlyActiveOwners = pending?.owners ?? []
      }
      const repairInput = { repairContext, seed, refinement, ...(frozenReadonlyRepair ?? { readonlyOwnerRepair, ...(readonlyOwnerRepair && readonlyBase ? { readonlyBaseRef: readonlyBase.resultRef } : {}) }) }
      if (savedRepair ? canonical(savedRepair) !== canonical(repairInput) : repairContext || seed || refinement || readonlyOwnerRepair) saveStage(store, fence, 'repair-input', repairInput)
      if (refinement) {
        const findings = refinement.diagnostics.map(item => JSON.parse(item.message) as GenerationFinding)
        if (!findings.length || !refinement.prior.structurePassed || !refinement.prior.reviewPassed) fail('refinement_binding', '持久遗漏诊断必须保留已批准P1与具体发现')
        const contracts = refinement.prior.changes.flatMap(change => parseContract({ nodeId: change.nodeId, path: change.path, source: change.source }).contract ?? [])
        const previous = refinementGeneration(store, operation, attempt, refinement)
        if (!findings.every(finding => contractOmissionBound(finding, contracts))) {
          const legacy = findings.every(finding => {
            const [path, id, extra] = finding.ruleLocation.slice('contract:'.length).split('#')
            return finding.kind === 'repair' && finding.ruleLocation.startsWith('contract:') && extra === undefined && contracts.some(contract => contract.path === path && contract.items.some(item => item.id === id))
          })
          if (!legacy) fail('refinement_binding', '持久遗漏诊断未绑定已批准Spec路径、既有ID与affectedIds')
          repairContext = generationRepairInput(previous); refinement = undefined
        }
      }
      if (syncPlanDigest(options.plan) !== operation.policyDigest) fail('policy_binding', '提供的可信计划与operation.policyDigest不同')
      const restorations = options.plan.authorizedChanges?.filter(change => change.action === 'restore') ?? []
      const history = restorations.length && operation.requestBlob ? readHistoryRequest(operation.input, operation.requestBlob) : null
      const restored = history ? readReceiptHistoryRestorations(operation.input, operation.requestBlob!, store.readOperation(history.operationId), store.listJournals(history.operationId)) : []
      if (restorations.length) {
        if (operation.origin !== 'combined' || !history) fail('restore_binding', '恢复只能由正式固定成组撤销输入授权')
        if (restorations.some(change => change.history.inputId !== operation.input.id || change.history.requestBlob.sha256 !== operation.requestBlob!.sha256 || !restored.some(item => item.id === change.id))) fail('restore_binding', '恢复未绑定原已结算receipt及同一历史Spec对象')
      }
      let view = await readInput(operation.input, options.plan, operation.previousBaselinePair, operation.requestBlob, store.readBusinessBaselineSelection(operation.id), operation.scope.paths)
      if (view.readSetDigest !== operation.readSetDigest) fail('readset_binding', '冻结读集合与operation.readSetDigest不同')
      if (signal.aborted) fail('cancelled', '协调执行已停止')
      store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
      store.bindComposedInput(fence, view.composed)
      const retrySource = await verificationRetrySource(store, operation, view, options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec', async () => { store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs) })
      if (retrySource) {
        if (attempt.dispatchPlans.length) fail('candidate_retry_binding', '本次重试已有模型派发，不能把原候选当作其新生成或独审结果')
        const { elaboration, analysis, generation, partitions } = retrySource, source = retrySource.operation
        const renewProof = async () => { store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs) }
        await requireCrossFreezeWholeApproval(store, source, retrySource.attempt, partitions, analysis, renewProof)
        await requireCrossFreezeElaborationApprovals(store, source, retrySource.attempt, elaboration, renewProof)
        const files = new Map(view.files)
        for (const change of elaboration.nodeChanges ?? []) if (change.action === 'retire' || change.from.path !== change.to.path) files.delete(change.from.path)
        for (const change of elaboration.changes) files.set(change.path, change.source)
        const accepted = await readFrozenContracts(operation.input.source.canonicalRoot, files), candidate = generation.candidate!
        const frozen = await candidateContext(store, operation, candidate, elaboration)
        const findings = [...frozen.findings, ...await checkCandidateContractIntent(operation, candidate, accepted, frozen, { newNodeRawSources: new Map([...(options.plan.newNodeRawSources ?? []), ...analysis.analysis.newNodes].map(item => [item.path, item.rawSource])), verifications: options.plan.verifications.map(item => item.definition) })]
        for (const oracle of options.plan.mandatoryTests) if (frozen.files.get(oracle.testPath) !== view.files.get(oracle.testPath)) fail('candidate_retry_binding', '续验候选改变原独立oracle')
        if (findings.some(finding => finding.severity === 'error')) fail('candidate_retry_binding', '原冻结候选未通过本次机械V1', [writeEvidence(operation.input.source.commonDir, findings)])
        if (!attempt.candidate) {
          operation = store.startGeneration(fence, { readyScope: source.readyScope, blockedScope: source.blockedScope, blockedReason: source.blockedReason })
          if (retrySource.attempt.publicationBase) {
            await acquirePublication()
            const currentAttempt = store.readAttempt(attempt.id)
            const original = verifyPublicationBase(store, source, retrySource.attempt, retrySource.attempt.publicationBase)
            const base = assemblePublicationBase(store, operation, currentAttempt, view.composed, view.readPaths, original)
            const { operationId: _newOperation, attemptId: _newAttempt, parentCommit: _newMetadata, ...currentBase } = verifyPublicationBase(store, operation, currentAttempt, base)
            const { operationId: _oldOperation, attemptId: _oldAttempt, parentCommit: _oldMetadata, ...originalBase } = original
            if (canonical(currentBase) !== canonical(originalBase) || original.version === 'sync-publication-base-v2' && base.parentCommit !== original.parentCommit) fail('candidate_retry_binding', '原候选发布基树已变化，不能覆盖新发布')
            store.bindPublicationBase(fence, base)
          }
        }
        const historical = new Set([...(operation.previousBaselinePair?.retiredIds ?? []), ...(operation.baselineSelection ? selectedRetiredIds(store.readBusinessBaselineSelection(operation.id)!) : [])])
        const retiredIds = elaboration.retiredIds.filter(id => !historical.has(id))
        const before = await readFrozenContracts(operation.input.source.canonicalRoot, priorDeliveryFiles({ ...operation, baselineSelection: store.readBusinessBaselineSelection(operation.id) }, view, [...options.plan.readPaths, ...operation.scope.paths], options.plan))
        const delivered = await verifyAndDeliver(attempt, { ...generation, validationFindings: findings }, elaboration, source.readyScope, before, retiredIds, view, partitions, analysis, restorations, operation.origin === 'decision')
        if (delivered) return delivered
        return current()
      }
      const budget = finiteSyncBudget(operation.budget)
      const callTimeoutMs = budget === null ? null : options.callTimeoutMs ?? Math.min(120_000, budget.timeoutMs)
      const historicalStageIndexes = new Map<string, SyncCheckpointStageView>()
      const historyCheckpoints = (owner: SyncOperation, prior: SyncAttempt): SyncCheckpointStageView => {
        const checkpoints = historicalStageIndexes.get(prior.id) ?? readSyncCheckpointStageIndex(store, owner, prior)
        historicalStageIndexes.set(prior.id, checkpoints)
        return checkpoints
      }
      const reviewSources = store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse().map(prior => ({ owner: operation, prior }))
        .concat(handoffParent ? store.listAttempts(handoffParent.id).filter(prior => ['failed', 'superseded', 'settled'].includes(prior.status)).reverse().map(prior => ({ owner: handoffParent, prior })) : [])
        .filter(({ owner, prior }) => reuseBehaviorDependentStages(store, owner, prior, historyCheckpoints(owner, prior)))
      let reviewContinuation: { operation: SyncOperation; attempt: SyncAttempt; plan: SyncPartitionPlan; generation: SavedGeneration; failedReviewKeys: string[]; elaboration?: ApprovedElaborationSource } | undefined
      if (readonlyBase && !readonlyOwnerRepair && !refinement && options.plan.version === 'sync-coordinator-v2') {
        for (const { owner, prior } of reviewSources) {
          const checkpoints = historyCheckpoints(owner, prior)
          const readIndex = (source: SyncAttempt): SyncCheckpointStageView => historyCheckpoints(source.operationId === owner.id ? owner : store.readOperation(source.operationId), source)
          const generation = partitionStage<SavedGeneration>(store, owner, prior, 'generation', undefined, checkpoints)?.result
          if (!generation) continue
          const approved = stage<SavedElaboration>(store, owner, prior, 'elaboration', 'automatic', checkpoints)
          const originalPlan = reviewPlanStage(store, owner, prior, 'partition-plan', undefined, readIndex)?.result
          const candidatePlan = reviewPlanStage(store, owner, prior, 'candidate-partition-plan', undefined, readIndex)?.result
          const candidate = generation.candidate
          if (!candidate || !generation.candidateValidated || generation.reviewPassed || generation.validationFindings.some(finding => finding.severity === 'error') || !approved || !elaborationComposedBinding(store, owner, prior, approved, view.composed, checkpoints) || !originalPlan || !candidatePlan || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths)) break
          let failedReviewKeys = authenticatedCandidate?.operationId === owner.id && authenticatedCandidate.sourceAttemptId === prior.id && authenticatedCandidate.candidateDigest === candidate.digest
            ? authenticatedCandidate.formatReviewKeys : undefined
          if (!failedReviewKeys && (prior.status === 'superseded' && prior.failure === null || prior.failure?.code === 'cancellation_pending' || generation.failure?.code === 'cancellation_pending')) {
            const classified = await withReadonlySnapshotQuery(async () => {
              const proof = candidateReviewAuthentication(store, owner, prior, generation, readIndex)
              for (let step = proof.next(); ; step = proof.next()) {
                if (step.done) return step.value
                await renewReadonlyRecovery()
              }
            })
            failedReviewKeys = classified ?? fail('review_source_binding', '失租约候选缺少完整required outcomes或精确结算原件，不能从汇总猜测续审资格')
          }
          if (!failedReviewKeys) {
            const reviewKeys = checkpoints.json.map(({ value }) => value as Stage).filter(value => value.stage?.endsWith(':candidate-review')).map(value => value.stage)
            failedReviewKeys = await withReadonlySnapshotQuery(async () => {
              const keys: string[] = []
              for (const key of reviewKeys) {
                if (failedCandidateReviewSource(store, owner, prior, key, candidate, candidatePlan, undefined, readIndex)) keys.push(key)
                else {
                  const result = partitionStage<SavedGeneration>(store, owner, prior, key, undefined, checkpoints)?.result
                  if (!result?.review || !['accept', 'repair'].includes(result.review.verdict) || result.failure) return []
                }
                await renewReadonlyRecovery()
              }
              return keys
            })
          }
          if (!failedReviewKeys.length) break
          verifyCandidate(operation.input.source.commonDir, candidate)
          const approvedRef = writeEvidence(operation.input.source.commonDir, approved)
          let sourceElaboration: ApprovedElaborationSource | undefined
          if (approvedRef.sha256 !== readonlyBase.resultRef.sha256) {
            if (!approved.structurePassed || !approved.reviewPassed || approved.failure || !['complete', 'needs_input', 'conflict'].includes(approved.status) || !approved.partitionSeal?.passed || !approved.partitionEvidence?.length
              || !partitionedElaborationCoverageMatches(originalPlan.partitions.map(partition => partition.id), approved.partitionEvidence.map(member => member.partitionId), approved.analysisOnlyPartitions?.map(member => member.partitionId) ?? [])
              || approved.analysisOnlyPartitions?.length && !authenticatedMixedElaborationCoverage(store, owner, prior, originalPlan, approved)) fail('review_source_binding', '原候选缺少生成当时的完整P1封口及分区批准')
            const sourceHistory = readonlyElaborationHistory(store, owner, readIndex)
            for (const member of approved.partitionEvidence) {
              store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs)
              const source = reviewedReadonlyLocalSource(store, owner, prior, `partition:${member.partitionId}:elaboration`, member.resultRef, approvedRef, 0, sourceHistory), local = source.result
              if (local.partitionBinding?.planDigest !== originalPlan.digest || !authenticatedApprovedElaboration(store, source.owner, source.approvalAttempt, local, { allowDeferredImplementation: local.phase === undefined })) fail('review_source_binding', '原候选P1的Native生成、独审或完整冻结输入失配')
              readStageDraft(operation.input.source.commonDir, local.rounds.at(-1)!.draft!, local.rounds.at(-1)!.draft!)
            }
          }
          if (approvedRef.sha256 !== readonlyBase.resultRef.sha256 || owner.id !== operation.id) sourceElaboration = { result: approved, resultRef: approvedRef, operationId: owner.id, attemptId: prior.id }
          reviewContinuation = { operation: owner, attempt: prior, plan: originalPlan, generation, failedReviewKeys, ...(sourceElaboration ? { elaboration: sourceElaboration } : {}) }
          repairContext = stage<{ repairContext?: typeof repairContext }>(store, owner, prior, 'repair-input', 'automatic', checkpoints)?.repairContext
          saveStage(store, fence, 'repair-input', { ...repairInput, repairContext })
          break
        }
      }
      if (handoffParent && !reviewContinuation && !store.listAttempts(operation.id).some(prior => stage<SavedGeneration>(store, operation, prior, 'generation')?.candidate)) fail('review_handoff_binding', '显式交接未认证原候选的可续审分区，不能重做P0/P1')
      const runner = options.runner ? injectedRunner(store, fence, options.runner) : createAttemptRunner(store, fence, { retireSettledWorktrees: true, ...options.nativeExecution })
      if (options.plan.version === 'sync-coordinator-v2' && options.plan.agentWorkflow === 'native-worktree-v1'
          && operation.origin === 'initial' && !operation.retryOf && !operation.requestBlob && operation.input.captureKind === 'commit'
          && attempt.number === 1 && !attempt.dispatchPlans.length && !operation.crossFreezeBinding && !options.runner
          && operation.input.source.branch === frozenSyncCanonicalBranch(operation.input)) {
        const binding = lockCrossFreezeSource(store, operation, {
          load: () => store.readOperation(operation.id).crossFreezeBinding?.ref ?? null,
          save: ref => store.lockCrossFreezeBinding(fence!, ref),
        })
        if (!binding.binding) fail('cross_freeze_binding', `无法固定跨冻结来源（${binding.reason}）`)
        operation = store.readOperation(operation.id)
      }
      const crossFreezeSource = readLockedCrossFreezeSource(store, operation)
      const candidateHistoryCheckpoints = (prior: SyncAttempt): SyncCheckpointStageView => prior.id !== attempt!.id && ['failed', 'superseded', 'settled'].includes(prior.status)
        ? historyCheckpoints(prior.operationId === operation.id ? operation : store.readOperation(prior.operationId), prior) : readSyncCheckpointStageIndex(store, operation, prior)
      let readonlySourceHistory: ReturnType<typeof readonlyElaborationHistory> | undefined
      const readonlySources = () => {
        if (!readonlySourceHistory) {
          const owner = operation
          readonlySourceHistory = readonlyElaborationHistory(store, owner, prior => prior.id === attempt!.id ? readSyncCheckpointStageIndex(store, owner, prior) : historyCheckpoints(owner, prior))
        }
        return readonlySourceHistory
      }
      const readonlyAccepted = (key: string, binding: NonNullable<ElaborationResult['partitionBinding']>, inputDigest: string): SavedElaboration | null => {
        const base = reviewContinuation?.elaboration ?? readonlyBase
        if (!base || readonlyActiveOwners.some(owner => owner.key === key)) return null
        if (base.operationId !== operation.id && reviewContinuation?.operation.id !== base.operationId) return null
        const approved = base.result
        const expected = approved.partitionEvidence?.find(item => item.partitionId === binding.partitionId)
        if (!expected) return null
        const owner = base.operationId === operation.id ? operation : store.readOperation(base.operationId)
        const history = owner.id === operation.id ? readonlySources() : readonlyElaborationHistory(store, owner, prior => historyCheckpoints(owner, prior))
        for (const origin of history.attempts.filter(item => (owner.id !== operation.id || item.number < attempt!.number) && ['failed', 'superseded', 'settled'].includes(item.status)).reverse()) {
          const source = readonlyLocalSource(store, owner, origin, key, expected.resultRef, base.resultRef, history)
          if (!source || !source.result.structurePassed || !source.result.reviewPassed || source.result.failure || canonical(source.result.partitionBinding) !== canonical(binding) || (source.result.gapRepair?.baseInputDigest ?? source.result.readonlySpecRepair?.baseInputDigest ?? source.result.inputDigest) !== inputDigest) continue
          if (source.result.rounds.at(-1)?.review?.verdict !== 'accept'
            && (source.result.phase !== undefined || !authenticatedApprovedElaboration(store, owner, origin, source.result, { allowDeferredImplementation: true }))) continue
          saveStage(store, fence!, `${key}:provenance`, { fromOperationId: owner.id, fromAttemptId: origin.id, resultRef: source.resultRef })
          partitionCheckpoints.save(key, source.result)
          return source.result
        }
        if (reviewContinuation?.elaboration) fail('review_source_binding', '候选续审的原P1不匹配当前完整局部输入，不能回退或重新细化')
        return null
      }
      const priorElaborationInputMatches = (prior: SyncAttempt, binding?: NonNullable<ElaborationResult['partitionBinding']>, owner = operation, checkpoints?: SyncCheckpointStageView): boolean => {
        if (canonical(prior.composedInput) !== canonical(view.composed) || prior.baselineSelectionDigest !== operation.baselineSelection?.digest) return false
        if (binding) {
          const plan = partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)
          if (!plan || plan.result.digest !== binding.planDigest) return false
        }
        const priorAnalysis = stage<CodeBehaviorAnalysis>(store, owner, prior, 'analysis', 'automatic', checkpoints), analysisRef = binding?.analysisRef ?? analysis?.ref
        if (analysisRef ? !priorAnalysis || contentHash(JSON.stringify(priorAnalysis)) !== analysisRef.sha256 : priorAnalysis !== null) return false
        return true
      }
      const canSkipElaborationControlAttempt = (prior: SyncAttempt, saved: SavedElaboration | null, binding?: NonNullable<ElaborationResult['partitionBinding']>): boolean => {
        if (prior.status !== 'superseded' || prior.failure || !priorElaborationInputMatches(prior, binding)) return false
        return !saved || saved.status === 'cancelled' && !saved.rounds.some(round => round.review !== null || round.findings.some(issue => issue.severity === 'error'))
      }
      const canRecoverInterruptedElaborationResult = (prior: SyncAttempt, source: { result: SavedElaboration }, binding?: NonNullable<ElaborationResult['partitionBinding']>): boolean => {
        if (prior.status !== 'superseded' || prior.failure || !priorElaborationInputMatches(prior, binding)) return false
        const result = source.result, round = result.rounds.at(-1)
        if (elaborationRepairSeed(result, `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}`)) return true
        const runtimeFailure = result.status === 'failed' && result.candidateDigest === null && !!round && round.candidate === null && round.candidateDigest === null
          && structuredAnalysisRepairCodes.has(result.failure?.code ?? '')
        const structuralFailure = result.status === 'exhausted' && result.failure?.code === 'repair_budget_exhausted' && !!round
          && round.candidate === null && round.findings.some(issue => issue.severity === 'error')
        return runtimeFailure || structuralFailure
      }
      const loadElaborationRepairSeed = (key: string, inputDigest: string, binding?: NonNullable<ElaborationResult['partitionBinding']>): ElaborationRepairSeed | null => {
        for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse()) {
          if (!['failed', 'superseded', 'settled'].includes(prior.status)) return null
          const saved = stage<SavedElaboration>(store, operation, prior, key)
          const source = binding ? partitionElaborationStage(store, operation, prior, key, binding, inputDigest) : partitionStage<SavedElaboration>(store, operation, prior, key)
          if (saved && (!source || saved.inputDigest !== inputDigest || saved.phase === 'partitioned_final' || saved.reviewPassed)) return null
          if (prior.failure?.kind !== 'repairable') {
            if (source && canRecoverInterruptedElaborationResult(prior, source, binding)) {
              const seed = elaborationRepairSeed(source.result, `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}`)
              if (seed) {
                saveStage(store, fence!, `${key}:repair-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef, candidateDigest: seed.candidateDigest })
                return seed
              }
            }
            if (!canSkipElaborationControlAttempt(prior, saved, binding)) return null
            continue
          }
          if (!source) return null
          if (!priorElaborationInputMatches(prior, binding)) return null
          const result = source.result
          if (result.status === 'failed' && result.candidateDigest === null && result.rounds.length === 1
            && result.rounds.every(round => round.output === null && round.candidate === null && round.candidateDigest === null && !round.findings.length && round.reviewOutput === null && round.review === null && !round.traces.length)) continue
          if (result.status !== 'exhausted') return null
          const seed = elaborationRepairSeed(result, `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}`)
          if (!seed) return null
          saveStage(store, fence!, `${key}:repair-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef, candidateDigest: seed.candidateDigest })
          return seed
        }
        return null
      }
      const draftMaterialStage = (owner: SyncOperation, prior: SyncAttempt, key: string): { result: SavedElaboration; resultRef: BlobRef } | null => {
        const checkpoints = historyCheckpoints(owner, prior)
        const exact = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints)
        if (exact || !owner.baselineSelection || owner.id !== operation.id) return exact
        const result = stage<SavedElaboration>(store, owner, prior, key, 'automatic', checkpoints)
        return result ? { result, resultRef: writeEvidence(operation.input.source.commonDir, result) } : null
      }
      const loadElaborationDraft = (key: string, binding?: NonNullable<ElaborationResult['partitionBinding']>, schemaDigest?: string, repairInputDigest?: string): ElaborationDraft | null => {
        const sources = retryDraftSources(store, operation, attempt!.number)
        for (const { owner, prior } of sources) {
          const source = draftMaterialStage(owner, prior, key)
          if (!source || source.result.phase === 'partitioned_final' || source.result.partitionBinding?.partitionId !== binding?.partitionId) continue
          if (repairInputDigest !== undefined && source.result.inputDigest !== repairInputDigest) continue
          for (const round of [...source.result.rounds].reverse()) {
            const draft = round.draft
            if (!draft || owner.id !== operation.id && (!schemaDigest || draft.schemaDigest !== schemaDigest || binding && (source.result.partitionBinding?.planDigest !== binding.planDigest || partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, historyCheckpoints(owner, prior))?.result.digest !== binding.planDigest))) continue
            const generation = round.candidate
              ? elaborationDraftGenerationSource(store, owner, prior, key, source, round, sources, historyCheckpoints)
              : authenticatedDraftResult(store, owner, prior, `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}:${round.index}:elaboration_generate`, 'elaboration_generate', draft)
            if (round.candidate && !generation) fail('review_retry_binding', '已生成P1候选的原Native生成身份失配，不能回退为重新生成')
            if (!generation) continue
            // 字节只作未批准材料；完整inputDigest及accept仍由独立的缓存门核验。
            saveStage(store, fence!, `${key}:draft-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef, resultCommit: draft.resultCommit, oid: draft.oid })
            return owner.id === operation.id ? draft : { ...draft, errors: [...round.findings, ...draft.errors.filter(error => !round.findings.some(finding => finding.code === error.code && finding.message === error.message))] }
          }
        }
        return null
      }
      const assertMaterialFence = (): void => {
        const current = store.readOperation(operation.id), active = store.readAttempt(attempt!.id)
        if (signal.aborted || current.control !== 'run' || current.currentAttemptId !== active.id || current.generation !== fence!.generation || active.generation !== fence!.generation || active.leaseToken !== fence!.leaseToken || ['failed', 'superseded', 'settled'].includes(active.status) || active.expiresAtMs <= Date.now() || store.readPhysicalControl(current.input.source).control !== 'run') fail('cancelled', '新草稿材料观察已失去当前运行fence')
      }
      let materialCheckpoints: ReturnType<typeof readSyncCheckpoints> | undefined
      const loadElaborationDraftMaterial = async (key: string, binding?: NonNullable<ElaborationResult['partitionBinding']>, schemaDigest?: string, request?: StageDraftMaterialRequest): Promise<ElaborationDraftMaterial | null> => {
        const commonDir = operation.input.source.commonDir, provenanceKey = `${key}:stopped-git-material-provenance`
        const ownerSuffix = `elaborate${binding ? `:partition:${binding.partitionId}` : ''}`
        const ownerRequestKey = `sync:${attempt!.id}:${ownerSuffix}`
        let allowCommitted = false
        if (request?.allowStoppedGitDraft) {
          const saved = stage<{ sourceKind: string; approved: boolean; currentInputDigest: string; currentSeed: StageDraftMaterialRequest['worktree']; schemaDigest: string; draftSha256: string; materialRef: BlobRef }>(store, operation, attempt!, provenanceKey, 'automatic', materialCheckpoints ??= readSyncCheckpoints(store, operation, attempt!))
          if (saved) {
            const packet = JSON.parse(readEvidence(commonDir, saved.materialRef).toString('utf8')) as ElaborationDraftMaterial & { version: string; path: string }
            if (saved.sourceKind !== 'stopped_git_draft' || saved.approved !== false || saved.currentInputDigest !== request.inputDigest || canonical(saved.currentSeed) !== canonical(request.worktree) || saved.schemaDigest !== schemaDigest || schemaDigest !== request.binding.schemaDigest
              || packet.version !== 'stopped-git-draft-v1' || packet.path !== request.binding.path || packet.sourceKind !== 'stopped_git_draft' || typeof packet.source !== 'string' || contentHash(packet.source) !== saved.draftSha256) fail('draft_material_binding', '已冻结的P1提交草稿与本轮owner、seed或原材料摘要不匹配')
            return packet
          }
          allowCommitted = !attempt!.dispatchPlans.some(dispatch => dispatch.purpose === 'elaboration_generate' && dispatch.key.startsWith(`${ownerRequestKey}:`))
        }
        const sources = retryDraftSources(store, operation, attempt!.number), existingDraft = request?.existingDraft
        const identity = ({ errors: _errors, ...draft }: ElaborationDraft) => canonical(draft)
        const existingOrigin = existingDraft ? await (async () => {
          for (const { owner, prior } of sources) {
            await yieldToControl()
            assertMaterialFence()
            const source = draftMaterialStage(owner, prior, key)
            if (!source || source.result.partitionBinding?.partitionId !== binding?.partitionId) continue
            for (const round of [...source.result.rounds].reverse()) {
              if (!round.draft || identity(round.draft) !== identity(existingDraft)) continue
              const dispatchKey = `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}:${round.index}:elaboration_generate`
              const generation = round.candidate ? elaborationDraftGenerationSource(store, owner, prior, key, source, round, sources, historyCheckpoints) : authenticatedDraftResult(store, owner, prior, dispatchKey, 'elaboration_generate', round.draft) ? { attempt: prior, key: dispatchKey, ownerId: owner.id } : null
              if (!generation) continue
              const sourceIndex = sources.findIndex(item => item.owner.id === generation.ownerId && item.prior.id === generation.attempt.id), roundIndex = /:(\d+):elaboration_generate$/.exec(generation.key)?.[1]
              if (sourceIndex >= 0 && roundIndex !== undefined) return { sourceIndex, roundIndex: Number(roundIndex) }
            }
          }
          return null
        })() : null
        for (const [sourceIndex, { owner, prior }] of sources.entries()) {
          await yieldToControl()
          assertMaterialFence()
          const checkpoints = historyCheckpoints(owner, prior)
          const source = draftMaterialStage(owner, prior, key), round = source?.result.rounds.at(-1)
          if (!source || !round || source.result.phase === 'partitioned_final' || source.result.partitionBinding?.partitionId !== binding?.partitionId) continue
          if (existingDraft && (!existingOrigin || sourceIndex > existingOrigin.sourceIndex || sourceIndex === existingOrigin.sourceIndex && round.index <= existingOrigin.roundIndex)) continue
          if (request && schemaDigest === request.binding.schemaDigest && (!binding || source.result.partitionBinding?.planDigest === binding.planDigest && partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)?.result.digest === binding.planDigest) && !round.draft && (owner.id !== operation.id || priorElaborationInputMatches(prior, binding, operation, checkpoints))) {
            const requestKey = `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}:${round.index}:elaboration_generate`, resource = store.findResource(prior.id, requestKey)
            if (resource?.phase === 'removed' && resource.plan.inputId === operation.input.id) {
              const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
              const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
              const record = readRecord(native.expectedSessionId), state = record?.structuredExecution, zcode = native.request.model?.startsWith('zcode:') === true
              const stoppedTransport = zcode && state?.state === 'failed' && state.errorCode === 'native_turn_transport_failed'
              const completedEventsRpc = allowCommitted && zcode && !!state && isZCodeEventsRpcTimeout(state)
              const grok = native.request.model?.startsWith('grok:') === true
              const failure = source.result.failure
              const providerFailure = zcode && prior.failure?.kind === 'unsupported'
                && source.result.status === 'unsupported' && isZCodeProviderRejection(failure)
                && !source.result.structurePassed && !source.result.reviewPassed && source.result.candidateDigest === null
                && round.candidate === null && round.output === null && round.review === null && round.reviewOutput === null && !round.traces.length
              const providerRetry = zcode && owner.id === operation.retryOf && owner.currentAttemptId === prior.id
                && owner.phase === 'failed' && prior.status === 'failed' && model.split(':', 1)[0] !== native.request.model?.split(':', 1)[0]
                && owner.planBlob?.sha256 === operation.planBlob?.sha256 && owner.impactDigest === operation.impactDigest
                && canonical(owner.input) === canonical(operation.input) && priorElaborationInputMatches(prior, binding, owner, checkpoints)
                && settledApprovalSource(store, owner)
              const providerDraft = providerFailure && (providerRetry || owner.id === operation.id && prior.status === 'superseded')
              const priorGuidance = grok && allowCommitted ? stage<{ generationGuidance?: ElaborationGenerationGuidance }>(store, owner, prior, 'elaboration-draft-protocol', 'automatic', checkpoints)?.generationGuidance : undefined
              const grokDraft = grok && allowCommitted && !binding?.interfaceSeed && request.binding.sourceInputId === operation.input.id
                && record?.archived && state?.state === 'failed' && state.error === GROK_NATIVE_EXIT_DEADLINE_FAILURE
                && source.result.status === 'failed' && failure?.code === 'failed' && failure.message === state.error && failure.sessionId === native.expectedSessionId
                && (priorGuidance === ELABORATION_GENERATION_GUIDANCE_V2 || priorGuidance === ELABORATION_GENERATION_GUIDANCE_V3 || priorGuidance === ELABORATION_GENERATION_GUIDANCE_V4 || priorGuidance === ELABORATION_GENERATION_GUIDANCE)
                && canonical(source.result.partitionBinding) === canonical(binding) && priorElaborationInputMatches(prior, binding, owner, checkpoints)
                && (owner.id === operation.id || settledApprovalSource(store, owner))
                && native.request.inputDigest === elaborationNativeInputDigest(source.result.inputDigest, native.request)
              const otherStoppedDraft = state && (zcode || native.request.model?.startsWith('claude:')) && (state.state === 'cancelled' || zcode && state.state === 'failed')
                && (!state.errorCode || stoppedTransport || completedEventsRpc) && state.threadId && state.turnId
              const worktree = native.request.worktree
              const stoppedAuthor = native.request.purpose === 'elaboration_generate' && worktree?.mode === 'edit' && !native.request.frozenContext
                && state?.cancellation?.nativeStopped && !state.failedWorktree && !state.resultWorktree && !state.rejectedOutput
              if (providerDraft && !stoppedAuthor) fail('draft_material_binding', 'ZCode 原生成失败缺少精确作者请求或停止证明')
              if (stoppedAuthor && (providerDraft || grokDraft || otherStoppedDraft)) {
                const proof = authenticateNativeFailure(store, owner, prior, requestKey, providerDraft || grokDraft ? failure! : { code: completedEventsRpc ? 'native_rpc_timeout' : stoppedTransport ? 'native_turn_transport_failed' : 'failed', message: state.state === 'failed' ? state.error! : prior.failure?.message ?? '', sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, readRecord, true)
                if (providerDraft) {
                  const { session } = checkpoint
                  if (resource.generation !== prior.generation || native.schemaVersion !== 1 || checkpoint.schemaVersion !== 1
                    || request.binding.sourceInputId !== operation.input.id || source.result.inputDigest !== request.inputDigest || canonical(source.result.partitionBinding) !== canonical(binding)
                    || !matchesAttemptNativeModel(owner, prior, native.request) || native.request.root !== operation.input.source.canonicalRoot || native.request.base !== worktree.baseCommit
                    || proof.record.base !== native.request.base || proof.record.forkCommit !== native.request.base
                    || native.request.inputDigest !== elaborationNativeInputDigest(source.result.inputDigest, native.request)
                    || !matchesProviderDraftSeed(commonDir, worktree, `sync:${prior.id}:${ownerSuffix}`, request, ownerRequestKey)
                    || !checkpoint.nativeCallRequested || !checkpoint.nativeStarted || !session.threadId || !session.turnId
                    || checkpoint.status !== 'failed' || checkpoint.nativeState !== 'failed' || checkpoint.stop?.nativeStatus !== 'stopped' || checkpoint.result || checkpoint.creationTermination
                    || canonical(checkpoint.failure) !== canonical({ code: failure!.code, message: failure!.message })
                    || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === requestKey)?.session) !== canonical(session)
                    || proof.record.harness !== 'zcode' || proof.record.harnessSessionId !== session.threadId || proof.state.output !== undefined || proof.state.resultDigest !== undefined
                    || prior.dispatchPlans.some(dispatch => store.findResource(prior.id, dispatch.key)?.phase !== 'removed')) fail('draft_material_binding', 'ZCode 原生成失败缺少精确owner、seed、Native 派发或资源结算')
                  if (proof.record.archived) continue
                }
                if (grokDraft) assertUnpublishedGrokFailure(operation, prior, resource, proof)
                if (completedEventsRpc) assertStoppedEventsRpcDraft(prior, requestKey, proof)
                const context = elaborationMaterialContext(operation.input.source.commonDir, native.request, request)
                if (proof.record.base === worktree.baseCommit && proof.record.forkCommit === worktree.baseCommit && /草稿文件=([^\s；。]+)/.exec(native.request.prompt)?.[1] === request.binding.path && context) {
                  let skipSource = false
                  const material = await withArchivedStructuredWorktree(proof.record, (): ElaborationDraftMaterial | null => {
                    const prompt = nativeWorktreePrompt(native.request.prompt, worktree)
                    if (providerDraft) assertZCodeSettledProviderFailure(proof.record.session, prompt, proof.state as ZCodeStructuredExecution, proof.record.worktreePath, 'elaboration_generate', { crossProviderRetry: providerRetry })
                    const failed = providerDraft || (zcode ? assertZCodeStoppedDraftSource(prompt, (completedEventsRpc ? proof.state : state) as ZCodeStructuredExecution,
                      proof.record.worktreePath, providerRetry ? 'p1-cross-provider-retry' : undefined) : undefined)
                    if (zcode && failed === null) { skipSource = true; return null }
                    if (grokDraft) assertGrokUnpublishedExitSource(proof.record.session, prompt, state, proof.record.worktreePath, 'elaboration_generate')
                    else if (!zcode) assertClaudeStoppedDraftSource(prompt, state, proof.record.worktreePath)
                    assertMaterialFence()
                    store.assertWriteFence(fence!)
                    let physical: ReturnType<typeof readStoppedPhysicalDraft>
                    try {
                      physical = readStoppedPhysicalDraft(commonDir, proof.record.worktreePath, worktree, request.binding, {
                        allowCommitted: allowCommitted && !providerDraft,
                        allowUntrackedWithoutDraft: providerDraft,
                        observeRejectedSidecars: providerDraft && owner.id === operation.id,
                      })
                    } catch (error) {
                      if (!(error instanceof StoppedPhysicalDraftSidecarsError)) throw error
                      const { source, ...observation } = error.evidence
                      const draftRef = writeEvidence(commonDir, { version: 'stopped-physical-draft-v1', path: request.binding.path, source })
                      saveStage(store, fence!, `${key}:stopped-physical-material-rejection`, {
                        code: 'untracked_draft_sidecars', fromOperationId: owner.id, fromAttemptId: prior.id,
                        nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, draftRef, ...observation,
                      })
                      skipSource = true
                      return null
                    }
                    if (physical && (!(grokDraft || completedEventsRpc) || physical.committedOid)) {
                      if (providerDraft && (physical.observedHeadCommit !== worktree.baseCommit || physical.observedTree !== worktree.tree)) fail('draft_material_binding', 'ZCode 原生成物理草稿必须位于原 seed')
                      if (zcode && failed !== true) fail('stale_result', 'ZCode物理细化草稿没有原精确失败终态')
                      const errors = [...existingDraft?.errors ?? [], ...round.findings, ...source.result.failure ? [{ code: source.result.failure.code, message: source.result.failure.message }] : []]
                      if (physical.committedOid) {
                        if (grokDraft) {
                          assertStoppedArchiveTree(commonDir, proof.record.session, physical.observedHeadCommit, physical.observedTree)
                          assertMaterialFence()
                        }
                        const material = { source: physical.source, errors, diagnostics: context.diagnostics, sourceKind: 'stopped_git_draft' as const }
                        const materialRef = writeEvidence(commonDir, { version: 'stopped-git-draft-v1', path: request.binding.path, ...material })
                        saveStage(store, fence!, provenanceKey, { sourceKind: material.sourceKind, approved: false, observationKind: zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt: Date.now(), fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: grokDraft ? failure : prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), resultCommit: physical.observedHeadCommit, resultTree: physical.observedTree, oid: physical.committedOid, indexSha256: physical.indexSha256, readonlyOverlay: { previous: context.previousReadonlyOverlay, current: context.currentReadonlyOverlay }, materialRef, draftSha256: contentHash(physical.source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: request.inputDigest, currentSeed: request.worktree })
                        return material
                      }
                      const materialRef = writeEvidence(operation.input.source.commonDir, { version: 'stopped-physical-draft-v1', path: request.binding.path, source: physical.source })
                      saveStage(store, fence!, `${key}:stopped-physical-material-provenance`, { sourceKind: 'physical_draft', approved: false, observationKind: zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt: Date.now(), fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), observedHeadCommit: physical.observedHeadCommit, observedTree: physical.observedTree, indexSha256: physical.indexSha256, readonlyOverlay: { previous: context.previousReadonlyOverlay, current: context.currentReadonlyOverlay }, materialRef, draftSha256: contentHash(physical.source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: request.inputDigest })
                      return { source: physical.source, errors, diagnostics: context.diagnostics, sourceKind: 'physical_draft' }
                    }
                    return null
                  })
                  if (skipSource) continue
                  if (material) return material
                }
              }
            }
          }
          if (existingDraft || round.draft || stage<{ version: string }>(store, owner, prior, 'elaboration-draft-protocol', 'automatic', checkpoints)?.version === 'elaboration-draft-v1') continue
          const rejectedGeneration = round.rejectedOutput?.purpose === 'elaboration_generate' ? round.rejectedOutput : undefined
          const rejectedReview = round.rejectedOutput?.purpose === 'elaboration_review' ? round.rejectedOutput : undefined
          const version = (round.output as { version?: unknown } | null)?.version
          const text = rejectedGeneration?.text ?? (['elaboration-rows-v1', 'elaboration-rows-v2', 'elaboration-target-rows-v3'].includes(String(version)) ? JSON.stringify(round.output) : undefined)
          if (text === undefined) continue
          let nativeMaterial: { nativePlanRef: BlobRef; checkpointRef: BlobRef; sourceKind: 'native_output' | 'native_rejected' } | undefined
          if (owner.id !== operation.id) {
            if (!schemaDigest || binding && (source.result.partitionBinding?.planDigest !== binding.planDigest || partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)?.result.digest !== binding.planDigest)) continue
            const requestKey = `sync:${prior.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}:${round.index}:elaboration_generate`, resource = store.findResource(prior.id, requestKey)
            if (!resource) continue
            const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
            if (contentHash(JSON.stringify(native.request.schema)) !== schemaDigest || native.request.worktree?.mode !== 'read' || native.request.frozenContext || native.request.purpose !== 'elaboration_generate') continue
            if (rejectedGeneration) { if (!rejectedGeneration.ref) continue }
            else {
              const authenticated = authenticatedDraftResult(store, owner, prior, requestKey, 'elaboration_generate')
              if (!authenticated?.result || canonical(round.output) !== canonical(authenticated.result.output)) continue
            }
            nativeMaterial = { nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, sourceKind: rejectedGeneration ? 'native_rejected' : 'native_output' }
          }
          saveStage(store, fence!, `${key}:draft-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef, ...nativeMaterial })
          return { source: text, ...(owner.id !== operation.id && !rejectedGeneration ? { sourceKind: 'native_output' as const } : {}), errors: [...round.findings, ...(rejectedReview ? [{ code: 'elaboration_review_rejected_output', message: JSON.stringify({ ...rejectedReview, role: 'review_format_diagnostic' }) }] : []), ...round.review?.findings.map(({ code, message, evidence, decision }) => ({ code, message: `${message}; ${evidence}; ${decision}` })) ?? [], ...source.result.failure ? [{ code: source.result.failure.code, message: source.result.failure.message }] : []] }
        }
        return null
      }
      const renderedRepairAttempt = (prior: SyncAttempt): boolean => ['failed', 'superseded', 'settled'].includes(prior.status) && prior.failure?.kind === 'repairable' && canonical(prior.composedInput) === canonical(view.composed)
      // 同一原round既供P1完整定位，也供精确P0分类质疑；候选仍只是拒绝诊断。
      const renderedElaborationSource = (owner: SyncOperation, prior: SyncAttempt, key: string, checkpoints?: SyncCheckpointStageView, matchesFinding?: (finding: ContractFinding) => boolean): { result: SavedElaboration; resultRef: BlobRef; round: ElaborationResult['rounds'][number] } | null => {
        const source = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints), round = source?.result.rounds.at(-1)
        if (!source || source.result.reviewPassed || source.result.phase === 'partitioned_final' || source.result.status !== 'exhausted' || source.result.failure?.code !== 'repair_budget_exhausted' || !round?.candidate || !round.findings.some(finding => finding.severity === 'error' && (!matchesFinding || matchesFinding(finding)))) return null
        if (round.candidate.inputDigest !== source.result.inputDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate))) fail('review_retry_binding', '已生成P1候选的原输入或摘要失配，不能回退为重新生成')
        const generation = elaborationGenerationSource(store, owner, prior, round, source.result)
        if (!generation) fail('review_retry_binding', '已生成P1候选的原Native请求/结果绑定失配，不能回退为重新生成')
        if (owner.id !== operation.id && round.draft) {
          const binding = source.result.partitionBinding
          const taskLine = generation.request?.prompt.split('\n任务:\n')[1]?.split('\n', 1)[0]
          const task = taskLine && JSON.parse(taskLine) as Pick<import('./elaboration-types.js').ElaborationInput, 'targets' | 'partitionBinding'>
          if (generation.request && (!task || !Array.isArray(task.targets) || canonical(task.partitionBinding) !== canonical(binding))) fail('review_retry_binding', '原Native任务的P1分区或目标身份不匹配')
          const targets = task ? task.targets : binding ? partitions?.partitions.find(partition => partition.id === binding.partitionId)?.targets : options.plan.targets
          if (!targets) return null
          const ownerDigest = contentHash(JSON.stringify({ partitionId: binding?.partitionId ?? null, targets: targets.map(({ nodeId, path }) => ({ nodeId, path })) }))
          readStageDraft(operation.input.source.commonDir, round.draft, { ownerDigest, sourceInputId: operation.input.id, schemaDigest: round.draft.schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
        }
        return { ...source, round }
      }
      let formalElaborationReviewSources: ReturnType<typeof retryDraftSources> | undefined
      const loadElaborationRepairDiagnostics = (key: string, inputDigest: string, binding?: NonNullable<ElaborationResult['partitionBinding']>): ElaborationRepairDiagnostics | null => {
        const ownerSuffix = `elaborate${binding ? `:partition:${binding.partitionId}` : ''}`
        const hasOwnerGeneration = (origin: SyncAttempt): boolean => origin.dispatchPlans.some(dispatch => dispatch.purpose === 'elaboration_generate' && dispatch.key.startsWith(`sync:${origin.id}:${ownerSuffix}:`))
        const parentAttempt = binding?.interfaceSeed ? store.readAttempt(attempt!.id) : null
        const parentReviewScope = parentAttempt && stage<Pick<ElaborationInput, 'parentInterfaceReview'>>(store, operation, parentAttempt, 'elaboration-draft-protocol')?.parentInterfaceReview === 'scope-v2'
        let newerGeneration = hasOwnerGeneration(parentReviewScope ? parentAttempt : attempt!)
        let challenge = binding && key === `partition:${binding.partitionId}:elaboration`
          ? operation.p1ReviewChallenges?.slice().reverse().find(item => item.partitionId === binding.partitionId) : undefined
        const carriedGenerations = new Set<string | undefined>()
        const carriedQuotaRefs = new Set<string>()
        const rememberUnavailableQuota = (prior: SyncAttempt, result: SavedElaboration, owner = operation, checkpoints?: SyncCheckpointStageView): boolean => {
          const code = result.failure?.code, round = result.rounds.at(-1), diagnostics = result.repairDiagnostics
          if (code !== 'sync_llm_manager_no_review_successor' && code !== 'sync_llm_manager_review_route_unavailable') return false
          const author = round?.traces.find(trace => trace.purpose === 'elaboration_generate')
          if (result.status !== 'unsupported' || !result.structurePassed || result.reviewPassed || !round?.draft || !round.candidate || !author
            || diagnostics?.failure.code !== 'provider_quota_exhausted' || diagnostics.round.candidateDigest !== round.candidateDigest
            || canonical(diagnostics.round.candidate) !== canonical(round.candidate)
            || canonical(diagnostics.round.traces.find(trace => trace.purpose === 'elaboration_generate')) !== canonical(author)
            || prior.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${prior.id}:${ownerSuffix}:`))
            || !priorElaborationInputMatches(prior, binding, owner, checkpoints)) fail('review_retry_binding', 'Manager 后继不可用记录未保留精确的无派发候选')
          carriedGenerations.add(canonical(author))
          carriedQuotaRefs.add(diagnostics.resultRef.sha256)
          return true
        }
        for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse()) {
          if (!['failed', 'superseded', 'settled'].includes(prior.status)) return null
          const saved = stage<SavedElaboration>(store, operation, prior, key)
          const requestKey = `sync:${prior.id}:${ownerSuffix}`
          if (binding && !saved && prior.status === 'superseded' && prior.failure?.kind === 'unsupported'
            && !prior.dispatchPlans.some(dispatch => dispatch.key.startsWith(`${requestKey}:`))
            && priorElaborationInputMatches(prior, binding)
            && store.listResources(prior.id).every(resource => resource.phase === 'removed' && !resource.plan.key.startsWith(`${requestKey}:`))) continue
          const providerReview = !newerGeneration && prior.status === 'superseded'
            && prior.failure?.kind === 'unsupported' && isZCodeProviderRejection(prior.failure) && saved?.status === 'unsupported'
            && isZCodeProviderRejection(saved.failure) && saved.structurePassed && !saved.reviewPassed && saved.phase !== 'partitioned_final'
          const source = binding ? partitionElaborationStage(store, operation, prior, key, binding, inputDigest) : partitionStage<SavedElaboration>(store, operation, prior, key)
          if (challenge && (newerGeneration || hasOwnerGeneration(prior) && prior.id !== challenge.origin.attemptId)) challenge = undefined
          if (challenge && source && prior.id !== challenge.origin.attemptId && source.result.candidateDigest === challenge.candidateDigest) {
            if (source.result.failure?.code === 'p1_challenge_review_invalid'
              && source.result.repairDiagnostics?.resultRef.sha256 === challenge.resultRef.sha256) continue
            const repeated = p1ChallengedReviewSource(store, operation, prior, source.result)
            if (repeated?.request.prompt.includes(p1ReviewDiagnosticMarker(challenge.diagnosticRef))) challenge = undefined
          }
          if (challenge && prior.id === challenge.origin.attemptId) {
            const authorization = challenge
            const original = source && p1ChallengedReviewSource(store, operation, prior, source.result)
            if (!source || !original?.request.worktree || source.resultRef.sha256 !== authorization.resultRef.sha256
              || authorization.origin.operationId !== operation.id || authorization.inputId !== operation.input.id
              || authorization.scopeDigest !== contentHash(canonical(operation.scope))
              || authorization.candidateDigest !== original.round.candidateDigest || !priorElaborationInputMatches(prior, binding)
              || !prior.checkpointRefs.some(ref => ref.sha256 === authorization.origin.reviewCheckpointRef.sha256
                && ref.artifacts?.some(artifact => artifact.ref.sha256 === authorization.resultRef.sha256))
              || partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan')?.resultRef.sha256 !== authorization.origin.partitionPlanRef.sha256)
              fail('sync_p1_challenge_binding', '复审前原冻结分区、只读独审或候选已不匹配')
            const operatorDiagnostic = readP1ReviewDiagnostic(operation.input.source.commonDir, authorization, operation.id)
            saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            return { requestKey: `sync:${prior.id}:${ownerSuffix}`, inputDigest, resultRef: source.resultRef, failure: original.failure, round: original.round,
              settledReview: { kind: 'operator-challenge', prompt: original.request.prompt, schema: original.request.schema, worktree: original.request.worktree, operatorDiagnostic } }
          }
          if (providerReview && (!source || saved.inputDigest !== inputDigest || !priorElaborationInputMatches(prior, binding)))
            fail('review_retry_binding', 'ZCode 原独审失败不匹配当前冻结输入或owner')
          if (saved && (!source || saved.inputDigest !== inputDigest || saved.phase === 'partitioned_final' || saved.reviewPassed)) return null
          const failure = source?.result.failure, round = source?.result.rounds.at(-1)
          if (source && rememberUnavailableQuota(prior, source.result)) continue
          const rejectedReviewFormat = failure && reviewFormatRepairCodes.has(failure.code)
          const formatAfterSiblingStop = prior.status === 'superseded' && prior.failure?.kind === 'unsupported' && prior.failure.code === 'cancellation_pending'
            && !!binding && source?.result.structurePassed && !!round?.draft && !!round.candidate && rejectedReviewFormat
          const formatAfterAbort = formatAfterSiblingStop || prior.status === 'superseded' && prior.failure?.kind === 'unsupported'
            && prior.failure.code === 'coordinator_failed' && rejectedReviewFormat
          const managedReviewQuota = failure?.code === 'provider_quota_exhausted' && !!source?.result.structurePassed && !source.result.reviewPassed
          const interruptedReview = failure?.code === 'cancellation_pending' && source?.result.structurePassed
            && !source.result.reviewPassed && !round?.review && round?.reviewOutput === null && !round.rejectedOutput
          const unstartedReview = failure?.code === 'failed' && source?.result.structurePassed
            && !source.result.reviewPassed && round?.review === null && round.reviewOutput === null && !round.rejectedOutput
          if (!newerGeneration && source && round && failure
            && (!carriedGenerations.size || carriedGenerations.size === 1 && carriedGenerations.has(canonical(round.traces.find(trace => trace.purpose === 'elaboration_generate'))))
            && (providerReview || priorElaborationInputMatches(prior, binding) && (managedReviewQuota || interruptedReview || unstartedReview
              || (prior.failure?.kind === 'repairable' || prior.status === 'superseded' && !prior.failure || formatAfterAbort)
                && (failure.code === 'native_rpc_timeout' || reviewFormatRepairCodes.has(failure.code) || isGrokNativeExitFailure(failure))))) {
            let settledReview: ElaborationRepairDiagnostics['settledReview']
            try { settledReview = settledElaborationReview(store, operation, prior, requestKey, source.result, round, failure, interruptedReview) }
            catch (error) {
              const { code, syscall } = (error as NodeJS.ErrnoException | null) ?? {}
              const evidenceReadError = (syscall === 'open' || syscall === 'read')
                && ['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EIO', 'ELOOP'].includes(code ?? '')
              const evidenceError = error instanceof SyntaxError || error instanceof StructuredSessionError && error.code === 'stale_result'
                || ['checkpoint_artifact_binding', 'evidence_blob_missing', 'evidence_blob_mismatch'].includes(code ?? '') || evidenceReadError
              if ((!providerReview && !formatAfterSiblingStop) || !evidenceError) throw error
              fail('review_retry_binding', '原独审失败缺少精确只读派发、Git候选或已结算Native原件')
            }
            if (settledReview) {
              saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
              if (challenge && round.candidateDigest === challenge.candidateDigest && settledReview.prompt.includes(p1ReviewDiagnosticMarker(challenge.diagnosticRef)))
                settledReview.operatorDiagnostic = readP1ReviewDiagnostic(operation.input.source.commonDir, challenge, operation.id)
              return { requestKey, inputDigest, resultRef: source.resultRef, failure, round, settledReview }
            }
          }
          if (providerReview) fail('review_retry_binding', 'ZCode 原独审失败没有可认证的同候选结构及审查身份')
          if (!newerGeneration && formatAfterSiblingStop) fail('review_retry_binding', '分区原独审格式失败没有可认证的同候选停止及拒稿原件')
          const errors = round?.findings.filter(issue => issue.severity === 'error') ?? []
          const paused = prior.status === 'superseded' && !prior.failure
          const interruptedPartition = !!binding && ['failed', 'superseded'].includes(prior.status)
            && prior.failure?.code === 'cancellation_pending' && prior.failure.kind === 'unsupported'
            && (!carriedGenerations.size || carriedGenerations.size === 1 && carriedGenerations.has(canonical(round?.traces.find(trace => trace.purpose === 'elaboration_generate'))))
          const scopeFailure = (paused || interruptedPartition) && errors.length > 0 && errors.every(issue => issue.code === 'review_scope' || issue.code === 'review_binding')
          const parentBindingFailure = parentReviewScope && (paused || prior.failure?.kind === 'repairable')
            && (!carriedGenerations.size || carriedGenerations.size === 1 && carriedGenerations.has(canonical(round?.traces.find(trace => trace.purpose === 'elaboration_generate'))))
            && isParentInterfaceImplementationReviewRejection(round?.review, errors)
          if (!newerGeneration && source && round?.draft && failure && (scopeFailure || parentBindingFailure)
            && source.result.structurePassed && priorElaborationInputMatches(prior, binding)
            && !store.listResources(prior.id).some(resource => resource.phase !== 'removed')) {
            const scope = frozenAnalysisScope.getStore()!
            const reviewKey = `${requestKey}:${round.index}:elaboration_review`
            const review = frozenAnalysisScope.run({ ...scope, readNativeRecord: readRecord }, () => {
              if (!renderedElaborationSource(operation, prior, key)) return null
              return authenticatedDraftResult(store, operation, prior, reviewKey, 'elaboration_review')
            })
            const trace = round.traces.find(trace => trace.purpose === 'elaboration_review'), request = review?.request
            if (!round.review || !review?.result || !trace || trace.sessionId !== review.result.sessionId || trace.threadId !== review.result.threadId
              || trace.turnId !== review.result.turnId || trace.resultDigest !== review.result.resultDigest
              || interruptedPartition && request?.worktree?.mode !== 'read'
              || canonical(round.reviewOutput) !== canonical(review.result.output)
              || request && (trace.inputDigest !== request.inputDigest || request.inputDigest !== elaborationNativeInputDigest(inputDigest, request)
                || !matchesAttemptNativeModel(operation, prior, request) || request.root !== operation.input.source.canonicalRoot || request.base !== request.worktree?.baseCommit))
              fail('review_retry_binding', parentBindingFailure ? '父接口拒绝不匹配原只读请求、真实结果及追踪' : '暂停前被拒独审不匹配原只读请求、真实结果及追踪')
            let settledReview: ElaborationRepairDiagnostics['settledReview']
            if (parentBindingFailure) {
              if (!request || request.worktree?.mode !== 'read') fail('review_retry_binding', '父接口越界拒绝缺少原Native只读请求')
              const diagnostics = source.result.repairDiagnostics, previous = diagnostics?.round.rejectedOutput
              let previousRejection: NonNullable<ElaborationRepairDiagnostics['settledReview']>['previousRejection']
              if (diagnostics && previous?.purpose === 'elaboration_review'
                && request.prompt.includes(`.spex-sync-diagnostics/${previous.sha256}/elaboration-review-rejected.raw`)) {
                const previousAttempt = store.readAttempt(diagnostics.requestKey.split(':')[1])
                const origin = partitionElaborationStage(store, operation, previousAttempt, key, binding!, inputDigest)
                if (previousAttempt.number >= prior.number || !origin || origin.resultRef.sha256 !== diagnostics.resultRef.sha256
                  || diagnostics.requestKey !== requestKey.replace(`sync:${prior.id}:`, `sync:${previousAttempt.id}:`)
                  || diagnostics.inputDigest !== inputDigest || diagnostics.round.candidateDigest !== round.candidateDigest
                  || canonical(diagnostics.round.traces[0]) !== canonical(round.traces[0])
                  || canonical(diagnostics.failure) !== canonical(origin.result.failure)
                  || canonical(diagnostics.round) !== canonical(origin.result.rounds.at(-1))
                  || !settledElaborationReview(store, operation, previousAttempt, diagnostics.requestKey, origin.result, diagnostics.round, diagnostics.failure))
                  fail('review_retry_binding', '父接口原独审附件缺少同候选Native拒稿原件')
                previousRejection = { sha256: previous.sha256, text: previous.text }
              }
              settledReview = { kind: 'parent-implementation-binding', prompt: request.prompt, schema: request.schema, worktree: request.worktree, ...(previousRejection ? { previousRejection } : {}) }
            }
            saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            return { requestKey, inputDigest, resultRef: source.resultRef, failure, round, ...(settledReview ? { settledReview } : {}) }
          }
          if (prior.failure?.kind !== 'repairable') {
            if (source && canRecoverInterruptedElaborationResult(prior, source, binding)) {
              if (failure && round) {
                const runtimeFailure = source.result.status === 'failed' && source.result.candidateDigest === null && round.candidate === null && round.candidateDigest === null && structuredAnalysisRepairCodes.has(failure.code)
                const structuralFailure = source.result.status === 'exhausted' && failure.code === 'repair_budget_exhausted' && round.candidate === null && round.findings.some(issue => issue.severity === 'error')
                if (runtimeFailure || structuralFailure) {
                  saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
                  return { requestKey, inputDigest, resultRef: source.resultRef, failure, round }
                }
              }
            }
            if (!canSkipElaborationControlAttempt(prior, saved, binding)) return null
            newerGeneration ||= hasOwnerGeneration(prior)
            for (const item of saved?.rounds ?? []) {
              const generation = item.traces.find(trace => trace.purpose === 'elaboration_generate')
              if (generation || item.draft || item.candidate) carriedGenerations.add(canonical(generation))
            }
            continue
          }
          if (!source) return null
          if (!priorElaborationInputMatches(prior, binding)) return null
          if (!failure || !round) return null
          const runtimeFailure = source.result.status === 'failed' && structuredAnalysisRepairCodes.has(failure.code)
          const structuralFailure = source.result.status === 'exhausted' && failure.code === 'repair_budget_exhausted' && (round.candidate === null || renderedElaborationSource(operation, prior, key) !== null) && round.findings.some(issue => issue.severity === 'error')
          if (!runtimeFailure && !structuralFailure) return null
          saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          return { requestKey, inputDigest, resultRef: source.resultRef, failure, round }
        }
        if (!operation.retryOf || newerGeneration || carriedGenerations.size && !carriedQuotaRefs.size) return null
        const missingFormalReview = (): null => {
          if (carriedQuotaRefs.size) fail('review_retry_binding', 'Manager 后继不可用时保存的候选缺少原已结算额度失败')
          return null
        }
        formalElaborationReviewSources ??= retryDraftSources(store, operation, attempt!.number).filter(({ owner }) => owner.id !== operation.id)
        for (const { owner, prior } of formalElaborationReviewSources) {
          if (!settledApprovalSource(store, owner)) return missingFormalReview()
          const checkpoints = historyCheckpoints(owner, prior)
          const source = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints)
          if (!source) {
            if (hasOwnerGeneration(prior) || prior.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${prior.id}:${ownerSuffix}:`))) return missingFormalReview()
            continue
          }
          const { result } = source, round = result.rounds.at(-1), failure = result.failure
          if (result.inputDigest !== inputDigest || canonical(result.partitionBinding) !== canonical(binding)
            || !priorElaborationInputMatches(prior, binding, owner, checkpoints)) return missingFormalReview()
          if (rememberUnavailableQuota(prior, result, owner, checkpoints)) continue
          if (!round?.draft || !round.candidate || !result.structurePassed || result.reviewPassed || result.status !== 'failed' || !failure
            || !(reviewFormatRepairCodes.has(failure.code) || failure.code === 'provider_quota_exhausted' || failure.code === 'failed' || failure.code === 'cancellation_pending')) return missingFormalReview()
          if (carriedQuotaRefs.size && (failure.code !== 'provider_quota_exhausted' || carriedQuotaRefs.size !== 1 || !carriedQuotaRefs.has(source.resultRef.sha256)
            || carriedGenerations.size !== 1 || !carriedGenerations.has(canonical(round.traces.find(trace => trace.purpose === 'elaboration_generate'))))) return missingFormalReview()
          const requestKey = `sync:${prior.id}:${ownerSuffix}`
          const settledReview = settledElaborationReview(store, owner, prior, requestKey, result, round, failure, true)
          if (!settledReview) fail('review_retry_binding', '正式重试的P1原稿缺少精确已结算独审原件')
          saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          return { requestKey, inputDigest, resultRef: source.resultRef, failure, round, settledReview }
        }
        return missingFormalReview()
      }
      type SealRepairSource = { attempt: SyncAttempt; result: SavedElaboration; resultRef: BlobRef; locals: Map<string, { result: SavedElaboration; resultRef: BlobRef }>; owners: Map<string, ContractFinding[]> }
      const findSealRepairSource = async (): Promise<SealRepairSource | null> => {
        if (!partitions) return null
        const current = store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse().map(prior => ({ owner: operation, prior }))
        const ancestors = operation.retryOf ? retryDraftSources(store, operation, attempt!.number).filter(({ owner }) => owner.id !== operation.id) : []
        const suffix = ':elaboration:readonly-repair-provenance'
        const interrupted: { owner: SyncOperation; prior: SyncAttempt; checkpoints: SyncCheckpointStageView; anchors: SyncCheckpointStageView['json'] }[] = []
        for (const { owner, prior } of [...current, ...ancestors]) {
          await yieldToControl()
          assertMaterialFence()
          const crossOperation = owner.id !== operation.id, repairable = prior.failure?.kind === 'repairable' || prior.status === 'superseded' && !prior.failure
          if (!['failed', 'superseded', 'settled'].includes(prior.status) || crossOperation && !settledApprovalSource(store, owner)) return null
          if (!repairable && !crossOperation) return null
          if (prior.status === 'superseded' && !prior.failure && !prior.checkpointRefs.length && !prior.dispatchPlans.length && prior.composedInput === null && prior.candidate === null && prior.verification === null && prior.currentSession === null && prior.publicationBase === undefined && prior.baselineSelectionDigest === operation.baselineSelection?.digest) continue
          const checkpoints = historyCheckpoints(owner, prior)
          const plan = partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)
          if (!plan || canonical(plan.result) !== canonical(partitions) || !priorElaborationInputMatches(prior, { planDigest: partitions.digest, partitionId: '', ...(analysis ? { analysisRef: analysis.ref } : {}) }, owner, checkpoints)) return null
          const source = partitionStage<SavedElaboration>(store, owner, prior, 'elaboration', undefined, checkpoints)
          if (source?.result.structurePassed && source.result.reviewPassed && !source.result.failure) return null
          if (!source || source.result.failure?.code !== 'partition_final_seal_failed') {
            if (crossOperation) {
              const anchors = checkpoints.json.filter(({ value }) => (value as Stage).stage.startsWith('partition:') && (value as Stage).stage.endsWith(suffix))
              if (anchors.length) {
                if (prior.candidate || prior.verification || prior.publicationBase !== undefined
                  || !prior.dispatchPlans.length && (prior.currentSession || prior.failure?.code !== 'review_retry_binding' && !repairable))
                  fail('partition_final_seal_binding', '未结算或已有候选的全局seal返修不能继承')
                interrupted.push({ owner, prior, checkpoints, anchors })
                continue
              }
            }
            if (!repairable || interrupted.length || crossOperation && prior.dispatchPlans.length) return null
            continue
          }
          if (crossOperation && (prior.failure?.code !== 'partition_final_seal_failed' || !prior.failure.evidenceRefs.some(ref => ref.sha256 === source.resultRef.sha256))) fail('partition_final_seal_binding', '跨操作返修必须引用原正式失败的精确全局seal')
          const result = source.result, seal = result.partitionSeal
          if (result.phase !== 'partitioned_final' || result.structurePassed || !result.reviewPassed || !seal || seal.passed || result.candidateDigest !== seal.candidateDigest || !elaborationComposedBinding(store, owner, prior, result, view.composed, checkpoints)
            || seal.candidateDigest !== contentHash(JSON.stringify({ inputDigest: seal.inputDigest, changes: seal.changes, applicability: seal.applicability, nodeChanges: seal.nodeChanges }))) fail('partition_final_seal_binding', '全局seal诊断缺少原失败候选及精确组合树绑定')
          const locals = new Map<string, { result: SavedElaboration; resultRef: BlobRef }>()
          for (const member of result.partitionEvidence ?? []) {
            await yieldToControl()
            assertMaterialFence()
            const local = partitionStage<SavedElaboration>(store, owner, prior, `partition:${member.partitionId}:elaboration`, undefined, checkpoints)
            if (!local || local.resultRef.sha256 !== member.resultRef.sha256 || local.result.partitionBinding?.planDigest !== partitions.digest || local.result.partitionBinding.partitionId !== member.partitionId || !local.result.structurePassed || !local.result.reviewPassed || local.result.failure || local.result.rounds.at(-1)?.review?.verdict !== 'accept' || locals.has(member.partitionId)) fail('partition_final_seal_binding', '全局seal诊断缺少同计划真实已审局部原件')
            const round = local.result.rounds.at(-1)!
            if (!round.candidate || local.result.candidateDigest !== round.candidateDigest || round.review!.inputDigest !== local.result.inputDigest || round.review!.candidateDigest !== round.candidateDigest || round.candidate.inputDigest !== local.result.inputDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || round.candidate.changes.length !== local.result.changes.length || round.candidate.changes.some(change => !local.result.changes.some(saved => saved.nodeId === change.nodeId && saved.path === change.path && saved.beforeDigest === change.beforeDigest && saved.source === change.source))) fail('partition_final_seal_binding', '全局seal局部原件缺少真实候选与独审摘要绑定')
            locals.set(member.partitionId, local)
          }
          if (result.analysisOnlyPartitions ? !authenticatedMixedElaborationCoverage(store, owner, prior, partitions, result) : locals.size !== partitions.partitions.length || partitions.partitions.some(partition => !locals.has(partition.id))) fail('partition_final_seal_binding', '全局seal诊断没有完整分区来源')
          const owners = partitionSealRepairOwners(partitions, result, new Map([...locals].map(([id, local]) => [id, local.result])))
          if (!owners.size) fail('partition_final_seal_unroutable', '失败全局seal没有可反馈的真实error')
          for (const interruption of interrupted) {
            await yieldToControl()
            assertMaterialFence()
            const anchors = new Map<string, BlobRef>()
            for (const entry of interruption.anchors) {
              const key = (entry.value as Stage).stage, partitionId = key.slice('partition:'.length, -suffix.length)
              const saved = stage<{ fromOperationId?: string; fromAttemptId: string; resultRef: BlobRef; generationRef: BlobRef }>(store, interruption.owner, interruption.prior, key, 'automatic', { ...interruption.checkpoints, json: [entry] })
              if (!saved || (saved.fromOperationId ?? interruption.owner.id) !== owner.id || saved.fromAttemptId !== prior.id || saved.generationRef.sha256 !== source.resultRef.sha256
                || !owners.has(partitionId) || saved.resultRef.sha256 !== locals.get(partitionId)?.resultRef.sha256) fail('partition_final_seal_binding', '中断的全局seal返修缺少原候选和受影响owner的精确来源')
              anchors.set(partitionId, saved.resultRef)
            }
            for (const dispatch of interruption.prior.dispatchPlans) {
              const partitionId = dispatch.key.split(':')[4]
              const bound = anchors.get(partitionId)
              const request = bound && ['elaboration_generate', 'elaboration_review'].includes(dispatch.purpose)
                && dispatch.key.startsWith('sync:' + interruption.prior.id + ':elaborate:partition:' + partitionId + ':')
                ? settledSealRepairRequest(store, interruption.owner, interruption.prior, dispatch) : null
              if (!request || request.kind !== 'partition_seal' || canonical(request.owner) !== canonical(locals.get(partitionId)?.result.partitionBinding)
                || request.generationRef.sha256 !== source.resultRef.sha256 || request.acceptedRef.sha256 !== bound?.sha256 || request.candidateDigest !== seal.candidateDigest
                || canonical(request.findings) !== canonical(owners.get(partitionId))) fail('partition_final_seal_binding', '已派发的全局seal返修缺少精确Native请求及结算')
            }
          }
          return { attempt: prior, ...source, locals, owners }
        }
        return null
      }
      let sealRepairSource: ReturnType<typeof findSealRepairSource> | undefined
      const loadSealRepairSource = () => sealRepairSource ??= findSealRepairSource()
      const p0ReviewChallenges = readP0ReviewChallenges(store, operation)
      const challengeForKey = (key: string) => key === 'analysis' ? undefined : p0ReviewChallenges.get(key.slice('partition:'.length, -':analysis'.length))?.challenge
      let p0StatusOnly = false
      let behaviorDraftSources: ReturnType<typeof retryDraftSources> | undefined
      const readBehaviorDraftSources = () => behaviorDraftSources ??= retryDraftSources(store, operation, attempt!.number)
      const storedPartitionFailure = ({ error: _error, ...item }: PartitionAnalysisFailure) => p0StatusOnly ? { ...item, message: CODE_BEHAVIOR_FAILURE_STATUS } : item
      const loadBehaviorDraftMaterial = async (key: string, purpose: string, schemaDigest: string, inputDigest: string, request: CodeBehaviorMaterialRequest, planDigest?: string, existingDraft?: ElaborationDraft): Promise<ElaborationDraftMaterial | null> => {
        const commonDir = operation.input.source.commonDir
        const currentRequest = { ...request, inputDigest, purpose }
        const matchesMaterialTask = (original: BehaviorTaskRequest) => behaviorMaterialTaskMatches(original, currentRequest, commonDir)
        const partitionId = key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length)
        const suffix = partitionId === null ? '' : `:partition:${partitionId}`
        const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId, purpose }))
        const binding = { ownerDigest, sourceInputId: operation.input.id, schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` }
        const materialKey = `${key}:${purpose}:stopped-git-material-provenance`
        const ownerRequestKey = (attemptId: string) => `sync:${attemptId}:analysis${suffix}:${purpose}`
        const matchesSource = ({ owner, prior }: { owner: SyncOperation; prior: SyncAttempt }) =>
          (owner.id !== operation.id || (prior.baselineSelectionDigest ?? null) === (operation.baselineSelection?.digest ?? null))
          && canonical(prior.composedInput) === canonical(view.composed)
          && (!planDigest || partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan')?.result.digest === planDigest)
        const frozen = stage<{
          committedDraft?: ElaborationDraft; currentSeed?: StageDraftMaterialRequest['worktree']; currentInputDigest: string; draftSha256: string
          observationKind?: string; approved: boolean; fromOperationId: string; fromAttemptId: string; nativePlanRef: BlobRef
          checkpointRef: BlobRef; canonicalRecordSha256: string; originalInputDigest: string
        }>(store, operation, attempt!, materialKey)
        if (frozen?.committedDraft) {
          assertMaterialFence()
          if (frozen.currentInputDigest !== inputDigest || canonical(frozen.currentSeed) !== canonical(request.worktree) || frozen.committedDraft.sourceInputId !== binding.sourceInputId) fail('behavior_draft_material_binding', '已冻结的P0提交草稿与本轮owner、seed或输入不匹配')
          if (frozen.observationKind === 'zcode-cancelled') {
            const original = readBehaviorDraftSources().find(entry => entry.owner.id === operation.id && entry.owner.id === frozen.fromOperationId && entry.prior.id === frozen.fromAttemptId)
            const key = ownerRequestKey(frozen.fromAttemptId), resource = original && store.findResource(original.prior.id, key)
            if (frozen.approved !== false || !original || !matchesSource(original) || !resource || resource.phase !== 'removed'
              || canonical(resource.plan.planBlob) !== canonical(frozen.nativePlanRef) || canonical(resource.checkpointRef) !== canonical(frozen.checkpointRef))
              fail('behavior_draft_material_binding', '已冻结的ZCode取消稿缺少原owner和正式停止原件')
            const { session } = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
            const proof = authenticateNativeFailure(store, original.owner, original.prior, key, { code: 'failed', message: '', sessionId: session.sessionId, threadId: session.threadId ?? undefined, turnId: session.turnId ?? undefined }, readRecord, true)
            const native = proof.plan.request
            if (!settledZCodeP0Cancellation(original.prior, resource, proof) || !matchesAttemptNativeModel(original.owner, original.prior, native)
              || frozen.canonicalRecordSha256 !== contentHash(JSON.stringify(proof.record)) || frozen.originalInputDigest !== native.inputDigest
              || canonical(native.worktree) !== canonical(frozen.committedDraft.seed) || !matchesMaterialTask(native)
              || assertZCodeStoppedDraftSource(nativeWorktreePrompt(native.prompt, native.worktree!), proof.state as ZCodeStructuredExecution, proof.record.worktreePath, 'cancelled-commit') !== 'cancelled-commit')
              fail('behavior_draft_material_binding', '已冻结的ZCode取消稿失去原请求或公开取消证明')
            if (proof.record.archived) assertStoppedArchiveTree(commonDir, proof.record.session, frozen.committedDraft.resultCommit, frozen.committedDraft.resultTree)
            assertMaterialFence()
          }
          const source = readStageDraft(commonDir, frozen.committedDraft, binding)
          if (contentHash(source) !== frozen.draftSha256) fail('behavior_draft_material_binding', '已冻结的P0提交草稿与原字节摘要不匹配')
          return { source, errors: frozen.committedDraft.errors, sourceKind: 'git_draft' }
        }
        const physicalMaterialKey = `${key}:${purpose}:stopped-physical-material-provenance`
        const observedPhysical = purpose === 'code_behavior_analyze' ? stage<{
          sourceKind: string; approved: boolean; observationKind: string; fromOperationId: string; fromAttemptId: string
          nativePlanRef: BlobRef; checkpointRef: BlobRef; canonicalRecordSha256: string; materialRef: BlobRef; draftSha256: string
          schemaDigest: string; originalInputDigest: string; currentInputDigest: string
        }>(store, operation, attempt!, physicalMaterialKey) : null
        const observedClaude = observedPhysical?.observationKind === 'native-failure'
          && (JSON.parse(readEvidence(commonDir, observedPhysical.nativePlanRef).toString()) as NativeRunPlan).request.model?.startsWith('claude:')
          ? JSON.parse(readEvidence(commonDir, observedPhysical.checkpointRef).toString()) as NativeRunCheckpoint : null
        const frozenClaude = observedClaude?.status === 'failed' && observedClaude.nativeState === 'failed' && observedClaude.stop?.state === 'failed' ? observedPhysical : null
        const unreservedAnalysis = purpose === 'code_behavior_analyze' && !attempt!.dispatchPlans.some(dispatch => dispatch.key === ownerRequestKey(attempt!.id))
        const sources = readBehaviorDraftSources()
        const existingIndex = existingDraft && !frozenClaude ? sources.findIndex(({ owner, prior }) => {
          const saved = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`)?.result.drafts[purpose as keyof CodeBehaviorContinuation['drafts']]
          return !!saved && canonical(p0StatusOnly ? codeBehaviorDraftStatus(saved) : saved) === canonical(p0StatusOnly ? codeBehaviorDraftStatus(existingDraft) : existingDraft)
            && authenticatedDraftResult(store, owner, prior, `sync:${prior.id}:analysis${suffix}:${purpose}`, purpose, saved)
        }) : -1
        for (const [sourceIndex, { owner, prior }] of sources.entries()) {
          if (frozenClaude && (frozenClaude.fromOperationId !== owner.id || frozenClaude.fromAttemptId !== prior.id)) continue
          if (!frozenClaude && existingDraft && (existingIndex < 0 || sourceIndex >= existingIndex)) continue
          if (!matchesSource({ owner, prior })) continue
          const continuation = frozenClaude ? null : partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`)
          const challenge = challengeForKey(key)
          if (challenge && purpose === 'code_behavior_review' && continuation?.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256) continue
          const original = continuation?.result.readyAnalysis, draft = continuation?.result.drafts.code_behavior_analyze
          if (!existingDraft && purpose === 'code_behavior_analyze' && postGateReview.some(diagnostic => diagnostic.partitionId === (key === 'analysis' ? undefined : key.slice('partition:'.length, -':analysis'.length))) && original && draft && draft.schemaDigest === schemaDigest) {
            const previousRequest = JSON.parse(readEvidence(operation.input.source.commonDir, original.requestRef).toString('utf8')) as ElaborationSessionRequest
            if (!behaviorTraceBinding(store, owner, prior, key, original.trace) || !matchesMaterialTask(previousRequest)) fail('behavior_continuation_binding', '后置回审的分析草稿缺少精确原请求/Git来源')
            const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId: key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length), purpose }))
            const source = readStageDraft(operation.input.source.commonDir, draft, { ownerDigest, sourceInputId: operation.input.id, schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
            saveStage(store, fence!, `${key}:post-gate-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: continuation!.resultRef, requestRef: original.requestRef, resultCommit: draft.resultCommit, oid: draft.oid, originalInputDigest: continuation!.result.inputDigest, currentInputDigest: inputDigest })
            return { source, errors: draft.errors, sourceKind: 'git_draft' }
          }
          const materialDraft = continuation?.result.drafts[purpose as keyof CodeBehaviorContinuation['drafts']]
          if (!existingDraft && owner.id !== operation.id && materialDraft && materialDraft.schemaDigest === schemaDigest) {
            const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
            const authenticated = authenticatedDraftResult(store, owner, prior, `sync:${prior.id}:analysis${suffix}:${purpose}`, purpose, materialDraft)
            const carriedAnalysis = !authenticated && purpose === 'code_behavior_analyze' && behaviorAnalysisDraftBinding(store, owner, prior, key, materialDraft, planDigest, p0StatusOnly)
            if ((authenticated || carriedAnalysis) && (authenticated?.request ? matchesMaterialTask(authenticated.request) : continuation!.result.inputDigest === inputDigest)) {
              const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId: key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length), purpose }))
              const source = readStageDraft(operation.input.source.commonDir, materialDraft, { ownerDigest, sourceInputId: operation.input.id, schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
              const errors = [...materialDraft.errors], reviewedResult = !p0StatusOnly && purpose === 'code_behavior_analyze' && !continuation!.result.readyAnalysis ? continuation!.result.reviewResult : undefined
              if (reviewedResult) {
                if (!behaviorTraceBinding(store, owner, prior, key, reviewedResult.trace)) fail('behavior_review_material_binding', '业务续修诊断缺少原独审Native/Git身份')
                const reviewDraft = continuation!.result.drafts.code_behavior_review!, commonDir = operation.input.source.commonDir
                const reviewRequest = JSON.parse(readEvidence(commonDir, reviewedResult.requestRef).toString()) as ElaborationSessionRequest
                const review = JSON.parse(readObject(commonDir, reviewDraft.oid).toString()) as { inputDigest: string; analysisDigest: string; verdict: string; checkedPaths: string[]; checkedChangeIds: string[]; findings: unknown[] }
                const reviewSchema = readTree(commonDir, reviewDraft.seed.tree).find(entry => entry.path === reviewDraft.path.replace(/\.json$/, '.schema.json'))!
                const { pendingAnalysis: reviewed, task, requiredCheckedPaths, operatorReviewDiagnostic } = readCodeBehaviorContext(reviewRequest, commonDir)
                if (operatorReviewDiagnostic && !p0ReviewDiagnosticMatches(commonDir, operatorReviewDiagnostic)) fail('behavior_review_material_binding', '业务续修的复审证据不匹配原诊断')
                if (!reviewed) fail('behavior_review_material_binding', '业务续修缺少原完整待审分析')
                if (outputErrors(review, JSON.parse(readObject(commonDir, reviewSchema.oid).toString()) as Record<string, unknown>).length || reviewRequest.inputDigest !== continuation!.result.inputDigest || review.inputDigest !== inputDigest || reviewed.analysis.inputDigest !== inputDigest || review.analysisDigest !== reviewed.analysisDigest || reviewed.analysisDigest !== contentHash(JSON.stringify(reviewed.analysis))
                  || (requiredCheckedPaths ?? task.requiredChangedPaths as string[]).some(path => !review.checkedPaths.includes(path)) || new Set(review.checkedPaths).size !== review.checkedPaths.length || new Set(review.checkedChangeIds).size !== reviewed.analysis.changes.length || review.checkedChangeIds.some(id => !reviewed.analysis.changes.some(change => change.id === id))) fail('behavior_review_material_binding', '业务续修诊断未绑定原完整分析、schema或独审范围')
                if (review.verdict === 'repair' && review.findings.length) errors.push({ code: 'behavior_review_failed', message: JSON.stringify({ approved: false, review }) })
              }
              saveStage(store, fence!, `${key}:${purpose}:draft-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: continuation!.resultRef, resultCommit: materialDraft.resultCommit, oid: materialDraft.oid })
              return { source, errors, sourceKind: 'git_draft' }
            }
          }
          const requestKey = ownerRequestKey(prior.id), resource = store.findResource(prior.id, requestKey)
          if (!resource || resource.phase !== 'removed' || resource.plan.inputId !== operation.input.id) continue
          if (frozenClaude && (frozenClaude.nativePlanRef.sha256 !== resource.plan.planBlob.sha256 || frozenClaude.checkpointRef.sha256 !== resource.checkpointRef.sha256)) fail('behavior_draft_material_binding', '已冻结的Claude物理稿缺少精确原生资源引用')
          const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
          const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
          const grok = native.request.model?.startsWith('grok:') === true
          if (native.request.worktree?.mode === 'edit' && (grok || native.request.model?.startsWith('claude:') || native.request.model?.startsWith('zcode:')) && native.request.purpose === purpose && !native.request.frozenContext) {
            const record = readRecord(native.expectedSessionId), state = record?.structuredExecution
            const zcode = native.request.model?.startsWith('zcode:') === true
            const completedEventsRpc = zcode && !!state && isZCodeEventsRpcTimeout(state)
            const stoppedTransport = zcode && state?.state === 'failed' && state.errorCode === 'native_turn_transport_failed'
            if (!state || !state.cancellation?.nativeStopped) continue
            const claudeFailed = !zcode && !grok && purpose === 'code_behavior_analyze' && isClaudeFailedAnalysisDraftSource(state)
            if (claudeFailed && !unreservedAnalysis && !frozenClaude || frozenClaude && !claudeFailed) continue
            if (grok) {
              if (!unreservedAnalysis || !record?.archived || state.state !== 'failed' || state.error !== GROK_NATIVE_EXIT_DEADLINE_FAILURE
                || owner.id !== operation.id && !settledApprovalSource(store, owner)) continue
            } else if (state.state !== 'cancelled' && !(zcode && state.state === 'failed') && !claudeFailed || !(zcode ? state.zcodeNative : state.claudeNative) || !state.threadId || !state.turnId || !checkpoint.session.threadId || !checkpoint.session.turnId || state.failedWorktree || state.resultWorktree || state.rejectedOutput || state.errorCode && !completedEventsRpc && !stoppedTransport) continue
            const proof = authenticateNativeFailure(store, owner, prior, requestKey, { code: completedEventsRpc ? 'native_rpc_timeout' : stoppedTransport ? 'native_turn_transport_failed' : 'failed', message: state.state === 'failed' ? state.error! : prior.failure?.message ?? '', sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, readRecord, true)
            if (claudeFailed) {
              const { checkpoint: failed, record: original, state: originalState } = proof
              if (!isClaudeFailedAnalysisDraftSource(originalState) || failed.status !== 'failed' || failed.nativeState !== 'failed'
                || failed.stop?.nativeStatus !== 'processGroupGone' || failed.stop.acknowledged !== false || failed.stop.error !== undefined
                || !failed.nativeStarted || !failed.nativeCallRequested || failed.result || failed.creationTermination
                || proof.plan.request.root !== owner.input.source.canonicalRoot || proof.plan.request.base !== native.request.worktree.baseCommit
                || failed.failure?.code !== 'failed' || failed.failure.message !== originalState.error || failed.failure.failedWorktree || failed.failure.rejectedOutput
                || originalState.output !== undefined || originalState.resultDigest !== undefined || originalState.failedWorktree || originalState.resultWorktree || originalState.rejectedOutput
                || resource.generation !== prior.generation || original.harnessSessionId !== failed.session.threadId || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === requestKey)?.session) !== canonical(failed.session)) fail('stale_result', 'Claude P0物理草稿缺少原完整派发、失败与正式停止原件')
              if (original.archived) continue
            }
            if (grok) assertUnpublishedGrokFailure(operation, prior, resource, proof)
            if (completedEventsRpc) assertStoppedEventsRpcDraft(prior, requestKey, proof)
            const seedEntries = readTree(operation.input.source.commonDir, native.request.worktree.tree)
            const schema = seedEntries.find(entry => entry.path === binding.path.replace(/\.json$/, '.schema.json'))
            if (proof.record.base !== native.request.worktree.baseCommit || proof.record.forkCommit !== native.request.worktree.baseCommit || /草稿文件=([^\s；]+)/.exec(native.request.prompt)?.[1] !== binding.path || !schema || schema.mode !== '100644' || contentHash(readObject(operation.input.source.commonDir, schema.oid)) !== schemaDigest || !matchesMaterialTask(native.request)) continue
            const protectedEntries = (tree: string) => readTree(operation.input.source.commonDir, tree).filter(entry => entry.path !== binding.path && entry.path !== binding.path.replace(/\.json$/, '.schema.json') && entry.path !== binding.path.replace(/\.json$/, '.context.json'))
            if (!request.worktree || canonical(protectedEntries(native.request.worktree.tree)) !== canonical(protectedEntries(request.worktree.tree))) continue
            const allowUnpublishedCompletion = zcode && proof.observedFailure
              && checkpoint.status === 'cancelled' && checkpoint.nativeState === 'cancelled' && checkpoint.stop?.nativeStatus === 'stopped' && !checkpoint.result && !checkpoint.failure
              && proof.record.harnessSessionId === checkpoint.session.threadId && canonical(prior.dispatchPlans.find(dispatch => dispatch.key === requestKey)?.session) === canonical(checkpoint.session)
            const allowCancelledCommit = unreservedAnalysis && owner.id === operation.id && matchesAttemptNativeModel(operation, prior, native.request) && settledZCodeP0Cancellation(prior, resource, proof)
            if (grok || allowCancelledCommit) assertMaterialFence()
            const material = await withArchivedStructuredWorktree(proof.record, (): ElaborationDraftMaterial | null => {
              if (allowUnpublishedCompletion) assertMaterialFence()
              const prompt = nativeWorktreePrompt(native.request.prompt, native.request.worktree!)
              const zcodeSource = zcode ? assertZCodeStoppedDraftSource(prompt, proof.state as ZCodeStructuredExecution, proof.record.worktreePath,
                allowUnpublishedCompletion ? 'unpublished-completion' : allowCancelledCommit ? 'cancelled-commit' : undefined) : undefined
              if (zcodeSource === null) return null
              if (grok) assertGrokUnpublishedExitSource(proof.record.session, prompt, state, proof.record.worktreePath, 'code_behavior_analyze')
              else if (!zcode) assertClaudeStoppedDraftSource(prompt, proof.state, proof.record.worktreePath)
              assertMaterialFence()
              if (frozenClaude) {
                const packet = JSON.parse(readEvidence(commonDir, frozenClaude.materialRef).toString()) as { version: string; path: string; source: string }
                if (frozenClaude.sourceKind !== 'physical_draft' || frozenClaude.approved !== false
                  || frozenClaude.schemaDigest !== schemaDigest || frozenClaude.originalInputDigest !== native.request.inputDigest || frozenClaude.currentInputDigest !== inputDigest
                  || frozenClaude.canonicalRecordSha256 !== contentHash(JSON.stringify(proof.record))
                  || packet.version !== 'stopped-physical-draft-v1' || packet.path !== binding.path || typeof packet.source !== 'string' || contentHash(packet.source) !== frozenClaude.draftSha256)
                  fail('behavior_draft_material_binding', '已冻结的Claude物理稿与本轮owner、请求或原字节摘要不匹配')
                const context = readCodeBehaviorContext(native.request, commonDir)
                return { source: packet.source, errors: [...context.errors], repairDiagnostics: context.repairDiagnostics, sourceKind: 'physical_draft' }
              }
              let physical: ReturnType<typeof readStoppedPhysicalDraft>
              try {
                physical = completedEventsRpc ? null : readStoppedPhysicalDraft(commonDir, proof.record.worktreePath, native.request.worktree!, binding, { allowCommitted: unreservedAnalysis && !claudeFailed })
              } catch (error) {
                if (purpose !== 'code_behavior_review' || !(error instanceof StoppedPhysicalDraftStatusError)) throw error
                saveStage(store, fence!, `${key}:${purpose}:stopped-physical-material-rejection`, { reason: 'outside-owner-status', fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef })
                return null
              }
              if (grok && !physical?.committedOid) return null
              if (physical && !physical.committedOid) {
                if (zcodeSource === 'cancelled-commit') return null
                if (zcode && zcodeSource !== true) fail('stale_result', 'ZCode物理草稿没有原精确失败终态')
                const context = readCodeBehaviorContext(native.request, operation.input.source.commonDir)
                const materialRef = writeEvidence(operation.input.source.commonDir, { version: 'stopped-physical-draft-v1', path: binding.path, source: physical.source })
                saveStage(store, fence!, physicalMaterialKey, { sourceKind: 'physical_draft', approved: false, observationKind: zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt: Date.now(), fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: p0StatusOnly && prior.failure ? { code: prior.failure.code, kind: prior.failure.kind } : prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), observedHeadCommit: physical.observedHeadCommit, observedTree: physical.observedTree, indexSha256: physical.indexSha256, materialRef, draftSha256: contentHash(physical.source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest })
                return { source: physical.source, errors: [...context.errors], repairDiagnostics: context.repairDiagnostics, sourceKind: 'physical_draft' }
              }
              if (claudeFailed) return null
              const worktree = native.request.worktree!
              const witness = physical?.committedOid
                ? { baseCommit: worktree.baseCommit, baseTree: worktree.tree, headCommit: physical.observedHeadCommit, tree: physical.observedTree, worktreePath: proof.record.worktreePath }
                : nativeWorktreeResult(proof.record.worktreePath, worktree)
              if (witness.headCommit === native.request.worktree!.baseCommit || zcode && witness.tree === witness.baseTree) return null
              const cancelledCommit = zcodeSource === 'cancelled-commit'
              if (zcode && zcodeSource !== true && !(cancelledCommit && physical?.committedOid)) fail('stale_result', 'ZCode新Git材料没有原精确失败终态')
              if (grok || cancelledCommit && proof.record.archived) assertStoppedArchiveTree(commonDir, proof.record.session, witness.headCommit, witness.tree)
              if (grok || cancelledCommit) assertMaterialFence()
              const format = !zcode && !grok && proof.observedFailure ? observeClaudeStoppedWorktreeFailure(prompt, state, proof.record.worktreePath) : undefined
              const draft = captureStageDraft(operation.input.source.commonDir, native.request.worktree!, { worktree: witness }, binding)
              const source = readStageDraft(operation.input.source.commonDir, draft, binding), observedAt = Date.now()
              const context = completedEventsRpc ? readCodeBehaviorContext(native.request, operation.input.source.commonDir) : undefined
              const errors = context && [...context.errors]
              if (errors) {
                const rpc = { code: 'native_rpc_timeout', message: proof.state.error! }
                if (!errors.some(error => canonical(error) === canonical(rpc))) errors.push(rpc)
              }
              const materialErrors = p0StatusOnly ? [] : errors ?? (zcode || grok ? [...readCodeBehaviorContext(native.request, commonDir).errors] : format ? [{ code: format.code, message: format.message }] : [])
              saveStage(store, fence!, materialKey, { sourceKind: 'git_draft', approved: false, observationKind: cancelledCommit ? 'zcode-cancelled' : format ? 'missing-final' : zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt, fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: p0StatusOnly && prior.failure ? { code: prior.failure.code, kind: prior.failure.kind } : prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), resultCommit: draft.resultCommit, resultTree: draft.resultTree, oid: draft.oid, draftSha256: contentHash(source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest, ...(physical?.committedOid ? { committedDraft: { ...draft, errors: materialErrors }, currentSeed: request.worktree, indexSha256: physical.indexSha256 } : {}) })
              return { source, errors: materialErrors, ...(context ? { repairDiagnostics: context.repairDiagnostics } : {}), sourceKind: 'git_draft' }
            })
            if (material) return material
            continue
          }
          if (existingDraft || native.request.worktree?.mode !== 'read' || native.request.frozenContext) continue
          const wholeAnalysis = purpose === 'code_behavior_analyze' && key === 'analysis' ? stage<CodeBehaviorAnalysis>(store, owner, prior, key) : null
          if (wholeAnalysis && !analysisStageBinding(store, owner, wholeAnalysis)) continue
          const priorAnalysis = wholeAnalysis ? { result: wholeAnalysis, resultRef: writeEvidence(operation.input.source.commonDir, wholeAnalysis) } : purpose === 'code_behavior_analyze' ? partitionStage<CodeBehaviorAnalysis>(store, owner, prior, key) : null
          const trace = priorAnalysis?.result.traces.find(trace => trace.purpose === purpose), originalRequest = native.request
          if (priorAnalysis && trace && (owner.id !== operation.id || postGateReview.some(diagnostic => diagnostic.analysisRef.sha256 === priorAnalysis.resultRef.sha256)) && native.request.worktree?.mode === 'read' && contentHash(JSON.stringify(native.request.schema)) === schemaDigest && canonical(native.request.worktree) === canonical(request.worktree) && matchesMaterialTask(originalRequest) && checkpoint.result && completedNativeStageResult(store, owner, prior, originalRequest, trace, checkpoint.result.output, '')) {
            saveStage(store, fence!, `${key}:post-gate-native-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, analysisRef: priorAnalysis.resultRef, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest })
            return { source: JSON.stringify(checkpoint.result.output), errors: [], sourceKind: 'native_output' }
          }
          const failure = checkpoint.failure, packet = failure?.rejectedOutput
          if (!packet || !failure || !reviewFormatRepairCodes.has(failure.code) || native.request.purpose !== purpose || native.request.worktree?.mode !== 'read' || checkpoint.nativeState !== 'failed' || checkpoint.phase !== 'removed' || checkpoint.stop?.nativeStopped !== true) continue
          if (contentHash(JSON.stringify(native.request.schema)) !== schemaDigest || canonical(native.request.worktree) !== canonical(request.worktree) || !matchesMaterialTask(originalRequest)) continue
          const state = authenticateNativeRejectedFinal(store, owner, prior, requestKey, { ...failure, sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, packet)
          if (state.cancellation?.nativeStopped !== true || checkpoint.stop.nativeStatus !== state.cancellation.nativeStatus) continue
          saveStage(store, fence!, `${key}:${purpose}:native-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, rejectedSha256: packet.sha256, schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest })
          return { source: packet.text, errors: [{ code: failure.code, message: failure.message }] }
        }
        if (frozenClaude) fail('behavior_draft_material_binding', '已冻结的Claude物理稿缺少仍可认证的原owner和停止来源')
        return null
      }
      const replayBehaviorDraft: NonNullable<CodeBehaviorCheckpoints['replayDraft']> = (requestKey, purpose) => {
        const resource = store.findResource(fence!.attemptId, requestKey)
        if (resource?.phase !== 'removed') return null
        const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
        if (checkpoint.status !== 'completed') return null
        assertMaterialFence()
        const current = store.readAttempt(fence!.attemptId)
        const authenticated = authenticatedDraftResult(store, operation, current, requestKey, purpose, undefined, options.nativeExecution?.runtime?.readRecord ?? readRecord)
        const request = authenticated?.request, result = authenticated?.result
        if (!request || !result?.worktree || !matchesAttemptNativeModel(operation, current, request)) {
          fail('behavior_continuation_binding', 'P0 同次回放缺少可认证的原 Native 完成结果', [resource.checkpointRef])
        }
        return { request, result }
      }
      const loadBehaviorContinuation = (key: string, inputDigest: string, analysisSchemaDigest: string, planDigest?: string): CodeBehaviorContinuation | null => {
        const live = store.readAttempt(attempt!.id), challenge = challengeForKey(key)
        const answeredPostGate = challenge && postGateReview.some(diagnostic => diagnostic.partitionId === challenge.partitionId
          && diagnostic.analysis.reviewDiagnosticRef?.sha256 === challenge.diagnosticRef.sha256)
        const current = stage<CodeBehaviorContinuation>(store, operation, live, `${key}:continuation`)
        if (current) {
          if (challenge && current.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256) fail('sync_p0_challenge_binding', '当前 P0 续审缺少精确复审授权')
          if (current.inputDigest !== inputDigest) fail('behavior_continuation_binding', '当前P0草稿与完整业务输入不匹配')
          if (current.readyAnalysis && !behaviorTraceBinding(store, operation, live, key, current.readyAnalysis.trace)) fail('behavior_continuation_binding', '当前P0分析原件没有精确Native/Git来源证明')
          return current
        }
        const priorAttempts = store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status))
        for (const prior of priorAttempts.reverse()) {
          const source = partitionStage<CodeBehaviorContinuation>(store, operation, prior, `${key}:continuation`)
          if (!source || challenge && source.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256) continue
          if (source.result.inputDigest !== inputDigest || stage<{ version: string }>(store, operation, prior, 'behavior-draft-protocol')?.version !== 'code-behavior-draft-v1') {
            if (challenge && !answeredPostGate) fail('sync_p0_challenge_binding', '同 owner 的最新复审改变了冻结输入或原生协议')
            continue
          }
          if (planDigest && partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan')?.result.digest !== planDigest) {
            if (challenge && !answeredPostGate) fail('sync_p0_challenge_binding', '同 owner 的最新复审改变了冻结分区')
            continue
          }
          if (source.result.crossFreezeAuthorReviewRepair) return null
          const trace = source.result.readyAnalysis?.trace
          const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
          const invalidDraft = Object.entries(source.result.drafts).some(([purpose, draft]) => {
            if (purpose === 'code_behavior_analyze' && trace) return false
            if (authenticatedDraftResult(store, operation, prior, `sync:${prior.id}:analysis${suffix}:${purpose}`, purpose, draft)) return false
            if (purpose === 'code_behavior_analyze') return !behaviorAnalysisDraftBinding(store, operation, prior, key, draft, planDigest, p0StatusOnly)
            return !challenge || !carriedChallengeReviewDraft(store, operation, prior, key, source.result, draft)
          })
          if (invalidDraft) {
            if (challenge) fail('sync_p0_challenge_binding', '同 owner 的最新复审缺少认证草稿')
            continue
          }
          if (trace && !behaviorTraceBinding(store, operation, prior, key, trace)) fail('behavior_continuation_binding', 'P0已校验分析没有原生派发身份')
          saveStage(store, fence!, `${key}:continuation-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          const continuation = p0StatusOnly ? codeBehaviorContinuationStatus(source.result) : source.result
          saveStage(store, fence!, `${key}:continuation`, continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined)
          return continuation
        }
        if (answeredPostGate || !operation.retryOf && !challenge) return null
        const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
        if (live.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${live.id}:analysis${suffix}:code_behavior_`))) {
          if (challenge) fail('sync_p0_challenge_binding', '已派发的复审缺少同候选续审原件')
          return null
        }
        const previousCheckpoints = (prior: SyncAttempt) => historyCheckpoints(store.readOperation(prior.operationId), prior)
        const partitionPlanRef = partitions && contentHash(JSON.stringify(partitions)), scopeDigest = contentHash(canonical(operation.scope))
        for (const owner of behaviorContinuationLineage(store, operation, scopeDigest)) for (const prior of store.listAttempts(owner.id).reverse()) {
          if (!['failed', 'superseded', 'settled'].includes(prior.status) || canonical(prior.composedInput) !== canonical(view.composed)) continue
          const checkpoints = historyCheckpoints(owner, prior)
          if (planDigest && partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)?.resultRef.sha256 !== partitionPlanRef) continue
          const source = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`, undefined, checkpoints)
          if (challenge ? source?.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256
            : !source && !prior.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${prior.id}:analysis${suffix}:code_behavior_`))) continue
          const ready = source?.result.readyAnalysis, draft = source?.result.drafts.code_behavior_analyze
          if (source?.result.crossFreezeAuthor && !source.result.crossFreezeAuthorReviewRepair) {
            if (source.result.inputDigest !== inputDigest || source.result.version !== 'code-behavior-draft-v1')
              fail('behavior_continuation_binding', '正式重试的跨冻结原作者与当前输入不一致')
            assertMaterialFence()
            const continuation: CodeBehaviorContinuation = { version: source.result.version, inputDigest, drafts: {},
              crossFreezeAuthor: source.result.crossFreezeAuthor,
              ...(challenge ? { reviewDiagnosticRef: challenge.diagnosticRef, challengedAnalysisDigest: source.result.challengedAnalysisDigest } : {}) }
            saveStage(store, fence!, `${key}:continuation`, continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined)
            return continuation
          }
          if (!source || source.result.version !== 'code-behavior-draft-v1' || !draft || ready && draft.errors.length || draft.schemaDigest !== analysisSchemaDigest || source.result.inputDigest !== inputDigest
            || stage<{ version: string }>(store, owner, prior, 'behavior-draft-protocol', 'automatic', checkpoints)?.version !== 'code-behavior-draft-v1'
            || (ready ? !behaviorTraceBinding(store, owner, prior, key, ready.trace, undefined, previousCheckpoints, true, !!challenge)
              : !challenge || !authenticatedDraftResult(store, owner, prior, `sync:${prior.id}:analysis${suffix}:code_behavior_analyze`, 'code_behavior_analyze', draft)
                && !behaviorAnalysisDraftBinding(store, owner, prior, key, draft, planDigest, p0StatusOnly))) {
            if (challenge) fail('sync_p0_challenge_binding', '正式重试缺少原复审进度及对应原作者草稿')
            return null
          }
          assertMaterialFence()
          saveStage(store, fence!, `${key}:continuation-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef, scopeDigest } satisfies BehaviorContinuationProvenance)
          const continuation: CodeBehaviorContinuation = { version: source.result.version, inputDigest, drafts: { code_behavior_analyze: draft },
            ...(ready ? { readyAnalysis: ready } : {}),
            ...(challenge ? { reviewDiagnosticRef: challenge.diagnosticRef, ...(source.result.challengedAnalysisDigest ? { challengedAnalysisDigest: source.result.challengedAnalysisDigest } : {}) } : {}) }
          saveStage(store, fence!, `${key}:continuation`, continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined)
          return continuation
        }
        if (!challenge) return null
        const origin = store.readAttempt(challenge.origin.attemptId), owner = store.readOperation(challenge.origin.operationId)
        const original = historyCheckpoints(owner, origin)
        const source = partitionStage<CodeBehaviorContinuation>(store, owner, origin, `${key}:continuation`, undefined, original)
        const ready = source?.result.readyAnalysis, draft = source?.result.drafts.code_behavior_analyze
        const carried = source?.result.crossFreezeAuthor
        const priorApproval = carried && partitionStage<CodeBehaviorAnalysis>(store, owner, origin, key, undefined, original)
        const partition = partitions?.partitions.find(item => item.id === challenge.partitionId)
        const authorMatches = carried
          ? priorApproval && partition && priorApproval.resultRef.sha256 === challenge.analysisRef.sha256
            && authenticateApprovedBehaviorPartition(store, owner, origin, key, priorApproval.result, partition.changedPaths, undefined, previousCheckpoints, undefined, true)
          : ready && draft && !draft.errors.length && draft.schemaDigest === analysisSchemaDigest
            && behaviorTraceBinding(store, owner, origin, key, ready.trace, undefined, previousCheckpoints, true, true)
        if (!partitions || contentHash(JSON.stringify(partitions)) !== challenge.origin.partitionPlanRef.sha256 || scopeDigest !== challenge.scopeDigest
          || owner.id !== operation.id && ![...behaviorContinuationLineage(store, operation, scopeDigest)].some(ancestor => ancestor.id === owner.id)
          || origin.operationId !== owner.id || canonical(origin.composedInput) !== canonical(view.composed)
          || !original.json.some(item => item.ref.sha256 === challenge.origin.approvalCheckpointRef.sha256)
          || source?.resultRef.sha256 !== challenge.origin.continuationRef.sha256 || !authorMatches
          || source.result.inputDigest !== inputDigest) {
          fail('sync_p0_challenge_binding', '复审只能从授权的原计划、范围、Git 草稿及作者身份恢复')
        }
        assertMaterialFence()
        saveStage(store, fence!, `${key}:continuation-provenance`, { fromOperationId: owner.id, fromAttemptId: origin.id, resultRef: source.resultRef, scopeDigest } satisfies BehaviorContinuationProvenance)
        const continuation: CodeBehaviorContinuation = { version: source.result.version, inputDigest,
          ...(carried ? { drafts: {}, crossFreezeAuthor: carried } : { drafts: { code_behavior_analyze: draft! }, readyAnalysis: ready! }),
          reviewDiagnosticRef: challenge.diagnosticRef, challengedAnalysisDigest: challenge.origin.analysisDigest }
        saveStage(store, fence!, `${key}:continuation`, continuation)
        return continuation
      }
      const loadBehaviorReviewFeedback = (key: string, inputDigest: string, planDigest?: string): CodeBehaviorReviewReference | null => {
        assertMaterialFence()
        const sources = readBehaviorDraftSources(), challenge = challengeForKey(key)
        for (const { owner, prior } of sources) {
          if (canonical(prior.composedInput) !== canonical(view.composed)) continue
          const checkpoints = historyCheckpoints(owner, prior)
          const source = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`, undefined, checkpoints)
          if (!source || challenge && source.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256 || source.result.inputDigest !== inputDigest || planDigest && partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)?.result.digest !== planDigest) continue
          const review = source.result.reviewResult, draft = source.result.drafts.code_behavior_review
          if (!review || !draft) continue
          const { trace } = review
          if (!prior.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)) {
            const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, owner, prior, `${key}:continuation-provenance`, 'automatic', checkpoints)
            const origin = provenance && sources.find(candidate => candidate.owner.id === owner.id && candidate.prior.id === provenance.fromAttemptId && candidate.prior.number < prior.number)?.prior
            const original = origin && partitionStage<CodeBehaviorContinuation>(store, owner, origin, `${key}:continuation`, undefined, historyCheckpoints(owner, origin))
            const originalDraft = original?.result.drafts.code_behavior_review
            if (!provenance || provenance.fromOperationId !== owner.id || !original || original.resultRef.sha256 !== provenance.resultRef.sha256
              || original.result.inputDigest !== inputDigest || canonical(original.result.reviewResult) !== canonical(review)
              || !originalDraft || canonical(codeBehaviorDraftStatus(originalDraft)) !== canonical(codeBehaviorDraftStatus(draft))) fail('behavior_review_material_binding', '业务续修缺少原独审continuation来源')
            continue
          }
          if (trace.purpose !== 'code_behavior_review' || !behaviorTraceBinding(store, owner, prior, key, trace, undefined, item => historyCheckpoints(owner, item), owner.id !== operation.id)) fail('behavior_review_material_binding', '业务续修缺少原独审Native/Git身份')
          if (source.result.readyAnalysis || source.result.crossFreezeAuthor && !source.result.crossFreezeAuthorReviewRepair) return null
          const commonDir = owner.input.source.commonDir
          const output = JSON.parse(readObject(commonDir, draft.oid).toString()) as { verdict: string; findings: unknown[]; checkedPaths: string[]; checkedChangeIds: string[] }
          if (output.verdict !== 'repair' || !output.findings.length) return null
          const request = JSON.parse(readEvidence(commonDir, review.requestRef).toString()) as ElaborationSessionRequest
          const { pendingAnalysis, task, requiredCheckedPaths, operatorReviewDiagnostic } = readCodeBehaviorContext(request, commonDir)
          if (operatorReviewDiagnostic && !p0ReviewDiagnosticMatches(commonDir, operatorReviewDiagnostic)) fail('behavior_review_material_binding', '业务续修的复审证据不匹配原诊断')
          if (!pendingAnalysis || request.inputDigest !== inputDigest || pendingAnalysis.analysis.inputDigest !== inputDigest
            || pendingAnalysis.analysisDigest !== contentHash(JSON.stringify(pendingAnalysis.analysis))
            || outputErrors(output, codeBehaviorReviewSchema(inputDigest, pendingAnalysis.analysisDigest, requiredCheckedPaths)).length
            || (requiredCheckedPaths ?? task.requiredChangedPaths as string[]).some(path => !output.checkedPaths.includes(path))
            || new Set(output.checkedPaths).size !== output.checkedPaths.length
            || canonical(unique(output.checkedChangeIds)) !== canonical(unique(pendingAnalysis.analysis.changes.map(change => change.id)))
            || output.checkedChangeIds.length !== pendingAnalysis.analysis.changes.length) fail('behavior_review_material_binding', '业务续修未绑定原完整分析、schema或独审范围')
          return { commit: draft.resultCommit, path: draft.path }
        }
        return null
      }
      let approvalAncestors: ReturnType<typeof retryDraftSources> | undefined
      let elaborationApprovalSources: ReturnType<typeof retryDraftSources> | undefined
      const settledApprovalOperations = new Map<string, boolean>()
      const elaborationApprovalDiagnostics = new Map<string, Set<string>>()
      const loadAcceptedRetryElaboration = (key: string, binding: NonNullable<ElaborationResult['partitionBinding']>, inputDigest: string, interfaceSeed: boolean): SavedElaboration | null => {
        if (!operation.retryOf) return null
        elaborationApprovalSources ??= retryDraftSources(store, operation, attempt!.number)
        for (const { owner, prior } of elaborationApprovalSources) {
          if (owner.id !== operation.id) {
            if (!settledApprovalOperations.has(owner.id)) settledApprovalOperations.set(owner.id, settledApprovalSource(store, owner))
            if (!settledApprovalOperations.get(owner.id)) return null
          }
          if (canonical(prior.composedInput) !== canonical(view.composed)) continue
          const checkpoints = historyCheckpoints(owner, prior), plan = partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', undefined, checkpoints)
          if (plan?.result.digest !== binding.planDigest || canonical(plan.result) !== canonical(partitions)) continue
          if (stage<Refinement>(store, owner, prior, 'refinement', 'automatic', checkpoints) || stage<{ refinement?: Refinement }>(store, owner, prior, 'repair-input', 'automatic', checkpoints)?.refinement) return null
          if (!elaborationApprovalDiagnostics.has(prior.id)) {
            const pending = stage<ReadonlyRepairBinding>(store, owner, prior, 'repair-input', 'automatic', checkpoints)?.readonlyOwnerRepair
            const review = prior.failure?.kind === 'repairable' ? readonlyRepairFromAttempt(store, owner, prior) : null
            const affected = new Set([...(pending?.owners ?? []), ...(review?.owners ?? [])].map(owner => owner.partitionId))
            const aggregate = partitionStage<SavedElaboration>(store, owner, prior, 'elaboration', undefined, checkpoints)?.result
            if (aggregate?.failure?.code === 'partition_final_seal_failed' && aggregate.reviewPassed && aggregate.partitionSeal?.passed === false) {
              const locals = new Map((aggregate.partitionEvidence ?? []).map(member => [member.partitionId, JSON.parse(readEvidence(operation.input.source.commonDir, member.resultRef).toString()) as SavedElaboration]))
              for (const id of partitionSealRepairOwners(plan.result, aggregate, locals).keys()) affected.add(id)
            }
            elaborationApprovalDiagnostics.set(prior.id, affected)
          }
          if (elaborationApprovalDiagnostics.get(prior.id)!.has(binding.partitionId)) return null
          const source = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints)
          if (!source) continue
          const result = source.result, round = result.rounds.at(-1)
          if (!result.reviewPassed && (round?.candidate || round?.findings.some(finding => finding.severity === 'error') || result.readonlySpecRepair)) return null
          if (owner.id === operation.id) continue
          if (result.inputDigest !== inputDigest || canonical(result.partitionBinding) !== canonical(binding) || result.phase !== (interfaceSeed ? 'interface_seed' : undefined)
            || ![interfaceSeed ? 'interface_seed' : 'complete', 'needs_input', 'conflict'].includes(result.status)) continue
          if (!authenticatedApprovedElaboration(store, owner, prior, result)) {
            if (round?.review?.verdict === 'accept' && hasApprovedElaborationReview(result) && result.rounds.some(item => item.crossFreezeAuthor))
              fail('cross_freeze_p1_approval_binding', '正式重试的跨冻结 P1 祖先批准缺少原独审原件', [source.resultRef])
            continue
          }
          assertMaterialFence()
          saveStage(store, fence!, `${key}:provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          partitionCheckpoints.save(key, result)
          return result
        }
        return null
      }
      const loadCrossFreezeBehaviorAuthor: NonNullable<PartitionCheckpoints['loadCrossFreezeBehaviorAuthor']> = async (key, plan, partition, currentInputDigest, binding, existing) => {
        const locked = existing ? findLockedCrossFreezeSource(store, operation, existing.bindingRef)
          : crossFreezeSource ? { owner: operation, selected: crossFreezeSource }
            : pendingCrossFreezeImpactSource(store, operation, key, currentInputDigest, view.composed)
        if (!locked) return null
        const { owner: bindingOwner, selected } = locked
        assertMaterialFence()
        const author = historicalBehaviorAuthor(store, selected.source, partition.id, binding.changedPaths)
        if (!author && !existing && bindingOwner.id !== operation.id) fail('cross_freeze_native_binding', 'P0 影响续审缺少可核验的原 Git 作者')
        if (!author) return null
        const commonDir = operation.input.source.commonDir
        const current = store.readAttempt(fence!.attemptId), retryKey = `${key}:cross-freeze-impact-retry`
        let seed: StageWorktree | undefined, rawRef: BlobRef | undefined, retrying = false
        const impactInput = (owner: SyncOperation, prior: SyncAttempt, timeoutMs: ElaborationSessionRequest['timeoutMs']) =>
          crossFreezeP0ImpactInput(owner, prior.id, selected.source, partition.id, author,
            seed ??= stageWorktree(commonDir, operation.input.headCommit, view.composed.tree), partition.readPaths, timeoutMs,
            rawRef ??= writeEvidenceBytes(commonDir, Buffer.from(readStageDraft(commonDir, author.draft, author.draft), 'utf8')))
        for (const { owner, prior } of crossFreezeImpactHistory(store, operation, current, bindingOwner)) {
          await yieldToControl()
          assertMaterialFence()
          const index = readSyncCheckpointStageIndex(store, owner, prior)
          const retry = partitionStage<CrossFreezeImpactRetry>(store, owner, prior, retryKey, undefined, index)?.result
          if (!retrying && retry && retry.currentInputDigest === currentInputDigest) {
            if (!matchesCrossFreezeImpactRetry(retry, selected.bindingRef, author.analysisRef, currentInputDigest)
              || canonical(prior.composedInput) !== canonical(view.composed)) fail('cross_freeze_native_binding', 'P0 影响续审缺少同一冻结原稿或组合输入')
            authenticateCrossFreezeImpactRetry(store, owner, prior, retry, timeoutMs => impactInput(owner, prior, timeoutMs), options.nativeExecution?.runtime?.readRecord)
            retrying = true
          }
          if (stage(store, owner, prior, `${key}:cross-freeze-structure-rejection`, 'automatic', index)) return null
          const previous = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`, undefined, index)?.result
          if (previous?.inputDigest === currentInputDigest && previous.crossFreezeAuthorReviewRepair) return null
          const impact = readCrossFreezeP0Impact(store, owner, prior, key, currentInputDigest, selected, author, options.nativeExecution?.runtime?.readRecord, index)
          if (impact && (!existing || canonical(existing) === canonical(impact.proof))) return impact.result.evidence.verdict === 'reuse'
            ? { draft: author.draft, trace: author.authorTrace, proof: impact.proof, independentOf: [author.reviewTrace, impact.result.evidence.trace] } : null
        }
        if (existing || bindingOwner.id !== operation.id && !retrying) return null
        const sizing = stage<{ minimumCalls: number; remainingCalls: number | null }>(store, operation, current, 'partition-budget')
        if (budget && !retrying && (!sizing || sizing.remainingCalls === null || sizing.remainingCalls < sizing.minimumCalls + 2 * plan.partitions.length)) return null
        const prepared = prepareCrossFreezeImpactReview(impactInput(operation, current, callTimeoutMs))
        const evidence = await runCrossFreezeImpact(runner, store, operation, current.id, prepared, signal, assertMaterialFence,
          checkpointRef => { saveStage(store, fence!, retryKey, { version: 'cross-freeze-impact-retry-v1',
            sourceRef: selected.bindingRef, authorRef: author.analysisRef, currentInputDigest, checkpointRef } satisfies CrossFreezeImpactRetry) },
          options.nativeExecution?.runtime?.readRecord)
        const impactReviewRef = saveStage(store, fence!, `${key}:cross-freeze-impact`, {
          version: 'cross-freeze-p0-impact-v1', sourceRef: selected.bindingRef, currentInputDigest,
          checkedPaths: [...partition.readPaths].sort(), worktree: prepared.request.worktree, timeoutMs: callTimeoutMs, evidence,
        } satisfies SavedCrossFreezeP0Impact, operation.baselineSelection ? undefined : { readSetDigest: operation.readSetDigest })
        return evidence.verdict === 'reuse' ? {
          draft: author.draft, trace: author.authorTrace, proof: crossFreezeP0AuthorProof(author, partition.id, selected.bindingRef, impactReviewRef),
          independentOf: [author.reviewTrace, evidence.trace],
        } satisfies CodeBehaviorCrossFreezeAuthor : null
      }
      const loadCrossFreezeElaborationAuthor: NonNullable<PartitionCheckpoints['loadCrossFreezeElaborationAuthor']> = async (key, plan, partition, input, inputDigest, existing) => {
        if (!input.worktree || input.phase || input.refinement || input.gapRepair || input.readonlySpecRepair) return null
        const locked = existing ? findLockedCrossFreezeSource(store, operation, existing.bindingRef)
          : crossFreezeSource ? { owner: operation, selected: crossFreezeSource }
            : pendingCrossFreezeImpactSource(store, operation, key, inputDigest, view.composed)
        if (!locked) return null
        const { owner: bindingOwner, selected } = locked
        assertMaterialFence()
        const author = historicalElaborationAuthor(store, selected.source, partition.id)
        if (!author && !existing && bindingOwner.id !== operation.id) fail('cross_freeze_native_binding', 'P1 影响续审缺少可核验的原 Git 作者')
        if (!author) return null
        const current = store.readAttempt(fence!.attemptId), retryKey = `${key}:cross-freeze-impact-retry`
        const commonDir = operation.input.source.commonDir, { tree } = input.worktree
        let seed: StageWorktree | undefined, rawRef: BlobRef | undefined, retrying = false
        const impactInput = (owner: SyncOperation, prior: SyncAttempt, timeoutMs: ElaborationSessionRequest['timeoutMs']) =>
          crossFreezeP1ImpactInput(owner, prior.id, selected.source, partition.id, author,
            seed ??= stageWorktree(commonDir, operation.input.headCommit, overlayStageTree(commonDir, tree, input.context ?? [])), partition.readPaths, timeoutMs,
            rawRef ??= writeEvidenceBytes(commonDir, Buffer.from(readStageDraft(commonDir, author.draft, author.draft), 'utf8')))
        for (const { owner, prior } of crossFreezeImpactHistory(store, operation, current, bindingOwner)) {
          await yieldToControl()
          assertMaterialFence()
          const retry = partitionStage<CrossFreezeImpactRetry>(store, owner, prior, retryKey)?.result
          if (!retrying && retry && retry.currentInputDigest === inputDigest) {
            if (!matchesCrossFreezeImpactRetry(retry, selected.bindingRef, author.resultRef, inputDigest)
              || canonical(prior.composedInput) !== canonical(view.composed)) fail('cross_freeze_native_binding', 'P1 影响续审缺少同一冻结原稿或组合输入')
            authenticateCrossFreezeImpactRetry(store, owner, prior, retry, timeoutMs => impactInput(owner, prior, timeoutMs), options.nativeExecution?.runtime?.readRecord)
            retrying = true
          }
          const proof = readCrossFreezeP1Impact(store, owner, prior, key, inputDigest, selected, author, options.nativeExecution?.runtime?.readRecord)
          if (proof && (!existing || canonical(existing) === canonical(proof.author.proof))) return proof.verdict === 'reuse' ? proof.author : null
        }
        if (existing || bindingOwner.id !== operation.id && !retrying || tree !== view.composed.tree) return null
        const sizing = stage<{ minimumCalls: number; remainingCalls: number | null }>(store, operation, current, 'partition-budget')
        if (budget && !retrying && (!sizing || sizing.remainingCalls === null || sizing.remainingCalls < sizing.minimumCalls + 2 * plan.partitions.length)) return null
        const prepared = prepareCrossFreezeImpactReview(impactInput(operation, current, callTimeoutMs))
        const evidence = await runCrossFreezeImpact(runner, store, operation, current.id, prepared, signal, assertMaterialFence,
          checkpointRef => { saveStage(store, fence!, retryKey, { version: 'cross-freeze-impact-retry-v1',
            sourceRef: selected.bindingRef, authorRef: author.resultRef, currentInputDigest: inputDigest, checkpointRef } satisfies CrossFreezeImpactRetry) },
          options.nativeExecution?.runtime?.readRecord)
        const reviewRef = saveStage(store, fence!, `${key}:cross-freeze-impact`, {
          version: 'cross-freeze-p1-impact-v1', sourceRef: selected.bindingRef, currentInputDigest: inputDigest,
          composedDigest: view.composed.contentDigest, checkedPaths: [...partition.readPaths].sort(),
          worktree: prepared.request.worktree, timeoutMs: callTimeoutMs, evidence,
        } satisfies SavedCrossFreezeP1Impact, operation.baselineSelection ? undefined : { readSetDigest: operation.readSetDigest })
        return evidence.verdict === 'reuse' ? crossFreezeP1Author(author, evidence, selected.bindingRef, reviewRef) : null
      }
      const partitionCheckpoints: PartitionCheckpoints = {
        continueAfterSettledGrokExit: error => error instanceof StructuredSessionError
          && hasSettledGrokP0ExitFailure(store, operation, store.readAttempt(attempt!.id), error, 'native-session'),
        historicalCoverage: digest => {
          const proof = options.plan.historicalCoverage
          if (!proof || proof.digest !== digest) fail('historical_coverage_binding', '全图封口未绑定原历史覆盖证明')
          return historicalCoverageCheck(store, operation.input, operation.scope, proof, readTree(operation.input.source.commonDir, view.composed.tree))
        },
        load: <T>(key: string) => behaviorAnalysisStage(key) && challengeForKey(key)?.version === 'p0-review-challenge-v2'
          ? null : stage<T>(store, operation, store.readAttempt(attempt!.id), key),
        elaborationDraftTagged: (key, result) => elaborationDraftTagged(store, operation, store.readAttempt(attempt!.id), key, result),
        loadCompletedCandidateReview: (key, plan, input, candidate, builders, current, cache) => {
          if (signal.aborted) return null
          verifyCandidate(operation.input.source.commonDir, candidate, cache.trees)
          const currentAttempt = store.readAttempt(attempt!.id)
          const currentCheckpoints = current ? candidateHistoryCheckpoints(currentAttempt) : undefined
          const replayInput = (previous: GenerationInput | null): GenerationInput => {
            if (repairContext || readonlyOwnerRepair || refinement || input.repairContext || !previous?.repairContext) return input
            const previousDigest = freezeGenerationInput({ ...previous, requestKey: input.requestKey, repairContext: undefined }).inputDigest
            if (previousDigest !== freezeGenerationInput(input).inputDigest) return input
            return { ...input, repairContext: previous.repairContext }
          }
          const provenance = current ? stage<AcceptedReviewProvenance>(store, operation, currentAttempt, `${key}:provenance`, 'automatic', currentCheckpoints) : null
          if (current) {
            if (!provenance) {
              if (current.traces.every(trace => currentAttempt.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId))) return current
              fail('accepted_review_binding', '历史独审拷贝缺少完整当前输入及来源证明')
            }
            const local = partitionStage<SavedGeneration>(store, operation, currentAttempt, key, undefined, currentCheckpoints)
            const carried = local && acceptedReviewInput(store, operation, currentAttempt, key, local.resultRef, currentCheckpoints)
            const origin = store.readAttempt(provenance.fromAttemptId), expected = replayInput(carried)
            const source = carried && origin.operationId === provenance.fromOperationId && (origin.operationId !== operation.id || origin.number < currentAttempt.number) && completedCandidateReviewSource(store, operation, origin, key, candidate, plan, expected, candidateHistoryCheckpoints, !!reviewContinuation, cache)
            if (!carried || freezeGenerationInput(carried).inputDigest !== freezeGenerationInput(expected).inputDigest || !source || source.resultRef.sha256 !== provenance.resultRef.sha256 || canonical(source.result) !== canonical(current) || source.result.traces.some(trace => builders.some(builder => builder.sessionId === trace.sessionId || builder.threadId === trace.threadId))) fail('accepted_review_binding', '缓存独审原件缺少精确当前输入或原始请求/来源证明')
            return source.result
          }
          for (const { owner, prior } of reviewSources) {
            if (reviewContinuation?.failedReviewKeys.includes(key) && owner.id === reviewContinuation.operation.id && prior.number <= reviewContinuation.attempt.number) return null
            const checkpoints = candidateHistoryCheckpoints(prior), saved = partitionStage<SavedGeneration>(store, owner, prior, key, undefined, checkpoints)
            if (!saved) continue
            const original = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, owner, prior, `${key}:input`, undefined, checkpoints)?.result
            const previous = original ? restoreGenerationInput(original) : acceptedReviewInput(store, owner, prior, key, saved.resultRef, checkpoints)
            const expected = replayInput(previous && owner.id !== operation.id ? { ...previous, model } : previous)
            const source = completedCandidateReviewSource(store, operation, prior, key, candidate, plan, expected, candidateHistoryCheckpoints, !!reviewContinuation, cache)
            if (reviewContinuation?.attempt.id === prior.id && saved.result.review && !source) fail('accepted_review_binding', '同候选续审的合法verdict原件不能按当前完整输入及Native身份认证')
            if (!source || source.result.traces.some(trace => builders.some(builder => builder.sessionId === trace.sessionId || builder.threadId === trace.threadId))) continue
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: source.operation.id, fromAttemptId: source.attempt.id, resultRef: source.resultRef, inputRef: writeEvidence(operation.input.source.commonDir, freezeGenerationInput(expected).inputEvidence) })
            partitionCheckpoints.save(key, source.result)
            return source.result
          }
          return null
        },
        loadCandidateReviewRepair: async (key, plan, input, candidate, cache) => {
          if (!reviewContinuation) return null
          const origin = reviewContinuation.attempt
          const owner = reviewContinuation.operation
          const checkpoints = candidateHistoryCheckpoints(origin)
          const saved = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, owner, origin, `${key}:input`, undefined, checkpoints)?.result
          const accepted = !saved && partitionStage<SavedGeneration>(store, owner, origin, key, undefined, checkpoints)
          const previous = saved ? restoreGenerationInput(saved) : accepted ? acceptedReviewInput(store, owner, origin, key, accepted.resultRef, checkpoints) : null
          if (reviewContinuation.failedReviewKeys.includes(key)) {
            const stopped = stoppedCandidateReviewSource(store, owner, origin, key, candidate, plan, candidateHistoryCheckpoints, undefined, cache)
            if (stopped) {
              const carried = { ...input, reviewRepair: stopped.input.reviewRepair }
              if (freezeGenerationInput({ ...stopped.input, requestKey: input.requestKey, model }).inputDigest !== freezeGenerationInput(carried).inputDigest) fail('review_source_binding', '已停止独审的完整冻结输入已改变')
              const repair = stopped.input.reviewRepair
              const binding = stopped.draftBinding
              if (!repair || !binding || owner.id !== operation.id) return repair ?? null
              const current = store.readAttempt(attempt!.id)
              const frozen = stage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, current, `${key}:input`)
              const checkMaterial = (ref: BlobRef): StoppedCandidateReviewDraft => {
                const material = JSON.parse(readEvidence(operation.input.source.commonDir, ref).toString('utf8')) as StoppedCandidateReviewDraft
                if (material.version !== 'candidate-review-stopped-draft-v1' || material.fromOperationId !== owner.id || material.fromAttemptId !== origin.id
                  || material.sourceResultRef.sha256 !== stopped.resultRef.sha256 || material.nativePlanRef.sha256 !== stopped.nativePlanRef.sha256
                  || material.checkpointRef.sha256 !== stopped.checkpointRef.sha256 || canonical(material.draft.seed) !== canonical(stopped.seed)) fail('review_source_binding', '已停独审稿缺少同候选原始请求和停止身份')
                readStageDraft(operation.input.source.commonDir, material.draft, binding)
                return material
              }
              if (frozen) {
                const recovered = restoreGenerationInput(frozen), savedRepair = recovered.reviewRepair
                const base = (repair: NonNullable<GenerationInput['reviewRepair']>) => ({ resultRef: repair.resultRef, nativePlanRef: repair.nativePlanRef, checkpointRef: repair.checkpointRef })
                if (!savedRepair || canonical(base(savedRepair)) !== canonical(base(repair))
                  || freezeGenerationInput(recovered).inputDigest !== freezeGenerationInput({ ...input, reviewRepair: savedRepair }).inputDigest) fail('review_source_binding', '已冻结续审输入不能更换原稿')
                if (savedRepair.stoppedDraftRef?.sha256 !== repair.stoppedDraftRef?.sha256) checkMaterial(savedRepair.stoppedDraftRef ?? fail('review_source_binding', '已冻结续审缺少原提交稿引用'))
                return savedRepair
              }
              if (current.dispatchPlans.some(dispatch => dispatch.key === `${input.requestKey}:code_review`)) fail('review_source_binding', '已预留续审请求缺少原冻结输入')
              if (stopped.record.base !== stopped.seed.baseCommit || stopped.record.forkCommit !== stopped.seed.baseCommit) fail('review_source_binding', '已停止独审的工作树与原 Git seed 失配')
              const commonDir = operation.input.source.commonDir
              const material = await withArchivedStructuredWorktree(stopped.record, path => {
                assertMaterialFence()
                const observed = readStoppedPhysicalDraft(commonDir, path, stopped.seed, binding, { allowCommitted: true })
                if (!observed?.committedOid) return null
                assertMaterialFence()
                const draft = captureStageDraft(commonDir, stopped.seed, { worktree: { baseCommit: stopped.seed.baseCommit, baseTree: stopped.seed.tree,
                  headCommit: observed.observedHeadCommit, tree: observed.observedTree, worktreePath: path } }, binding)
                if (draft.oid !== observed.committedOid) fail('review_source_binding', '已停独审稿的提交内容改变')
                return { version: 'candidate-review-stopped-draft-v1', fromOperationId: owner.id, fromAttemptId: origin.id, sourceResultRef: stopped.resultRef,
                  nativePlanRef: stopped.nativePlanRef, checkpointRef: stopped.checkpointRef, draft, indexSha256: observed.indexSha256 } satisfies StoppedCandidateReviewDraft
              })
              return material ? { ...repair, stoppedDraftRef: writeEvidence(commonDir, material) } : repair
            }
          }
          if (previous?.reviewRepair) {
            const carried = { ...input, reviewRepair: previous.reviewRepair }
            if (freezeGenerationInput({ ...previous, requestKey: input.requestKey, model }).inputDigest === freezeGenerationInput(carried).inputDigest && completedCandidateReviewSource(store, operation, origin, key, candidate, plan, carried, candidateHistoryCheckpoints, true, cache)) return previous.reviewRepair
          }
          return failedCandidateReviewSource(store, operation, origin, key, candidate, plan, input, candidateHistoryCheckpoints, undefined, cache)
        },
        authenticateAnalysisOnly: (plan, evidence, owners) => authenticateAnalysisOnlyPartitions(store, operation, store.readAttempt(attempt!.id), plan, evidence, owners),
        loadBehaviorDraftMaterial: (key, planDigest, purpose, schemaDigest, inputDigest, request, existingDraft) => loadBehaviorDraftMaterial(key, purpose, schemaDigest, inputDigest, request, planDigest, existingDraft),
        replayBehaviorDraft,
        loadCrossFreezeBehaviorAuthor,
        loadBehaviorContinuation: (key, planDigest, inputDigest, analysisSchemaDigest) => loadBehaviorContinuation(key, inputDigest, analysisSchemaDigest, planDigest),
        loadBehaviorReviewFeedback: (key, planDigest, inputDigest) => loadBehaviorReviewFeedback(key, inputDigest, planDigest),
        auditP0Approvals: async plan => {
          const proofs = new Map<string, P0ApprovalCheck>()
          const current = store.readAttempt(attempt!.id)
          const planRef = contentHash(JSON.stringify(plan)), selection = store.readBusinessBaselineSelection(operation.id)
          const owners = new Set(plan.partitions.map(partition => partition.id))
          const lineage: ApprovalSourceLineage = { settled: new Set() }
          for (const owner of retryOperationLineage(store, operation)) {
            const attempts = store.listAttempts(owner.id).reverse()
              .filter(prior => prior.id === current.id || ['failed', 'superseded', 'settled'].includes(prior.status))
            for (const prior of attempts) {
              assertMaterialFence()
              await yieldToControl()
              assertMaterialFence()
              const index = prior.id === current.id ? readStageCheckpoints(store, operation, current, true) : historyCheckpoints(owner, prior)
              for (const { ref: checkpointRef, value } of index.json) {
                const wrapper = value as Stage
                const key = wrapper.stage
                if (typeof key !== 'string' || !key.startsWith('partition:') || !key.endsWith(':analysis')) continue
                const partitionId = key.slice('partition:'.length, -':analysis'.length)
                if (proofs.has(partitionId)) continue
                if (!owners.has(partitionId)) fail('p0_approval_evidence_invalid', '原P0审批分区不在当前冻结计划', [wrapper.resultRef])
                const source = { operationId: owner.id, attemptId: prior.id, checkpointRef, resultRef: wrapper.resultRef }
                proofs.set(partitionId, ({ inputDigest, binding }) => {
                  const blocked = (reason: string) => ({ status: 'blocked' as const, source, reason })
                  const analysis = stage<CodeBehaviorAnalysis>(store, owner, prior, key, 'evidence', index, () => true)
                  if (!analysis?.reviewPassed || analysis.inputId !== owner.input.id || analysis.policyDigest !== owner.policyDigest
                    || contentHash(JSON.stringify(analysis)) !== source.resultRef.sha256) return blocked('原审批缺少真实且精确绑定的结果')
                  const authorization = p0ReviewChallenges.get(partitionId)
                  if (authorization && analysis.reviewDiagnosticRef?.sha256 !== authorization.challenge.diagnosticRef.sha256)
                    return { status: 'invalidated', source, reason: 'p0_review_challenge', evidence: [authorization.challenge.diagnosticRef] }
                  const rendered = postGateReview.find(item => item.partitionId === partitionId && item.analysisRef.sha256 === source.resultRef.sha256)
                  if (rendered) return { status: 'invalidated', source, reason: 'post_gate_review', evidence: [rendered.resultRef] }
                  const guidance = analysis.guidanceContractVersion ?? LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION
                  if (wrapper.guidanceContractVersion !== guidance) return blocked('原审批的指导版本与结果不一致')
                  if (guidance === LEGACY_CODE_BEHAVIOR_GUIDANCE_VERSION || guidance === 'code-behavior-guidance-v8')
                    return { status: 'invalidated', source, reason: 'incompatible_behavior_guidance:' + guidance, evidence: [source.resultRef] }
                  if (guidance !== CODE_BEHAVIOR_GUIDANCE_VERSION || analysis.inputDigest !== inputDigest
                    || analysis.readSetDigest !== operation.readSetDigest || analysis.composedDigest !== view.composed.contentDigest
                    || canonical(prior.composedInput) !== canonical(view.composed)
                    || (owner.id !== operation.id && !settledApprovalSource(store, owner))) return blocked('冻结审批绑定变化且没有本区正式失效依据')
                  const checkpoints = (origin: SyncAttempt): SyncCheckpointStageView => origin.id === current.id ? index
                    : historyCheckpoints(origin.operationId === owner.id ? owner : store.readOperation(origin.operationId), origin)
                  const member = { partitionId, analysisRef: source.resultRef, analysis, changedPaths: [...binding.changedPaths] }
                  const proof = withReadonlySnapshotQuery(() => {
                    try {
                      return finishApprovalProof(approvedBehaviorPartitionSource(
                        store, operation, owner, prior, planRef, member, selection, checkpoints, lineage,
                        { expectedReadSetDigest: operation.readSetDigest, expectedComposedDigest: view.composed.contentDigest, analysisSchemaDigest: binding.analysisSchemaDigest, authorization },
                      ))
                    } catch (error) {
                      return error instanceof Error ? error.message : String(error)
                    }
                  })
                  if (typeof proof === 'string') return blocked(proof)
                  if (prior.id !== current.id) {
                    assertMaterialFence()
                    saveStage(store, fence!, key + ':provenance', { fromOperationId: proof.operationId, fromAttemptId: proof.id, resultRef: source.resultRef })
                  }
                  return { status: 'reused', source, analysis, authenticatedOrigin: { operationId: proof.operationId, attemptId: proof.id } }
                })
              }
            }
          }
          return proofs
        },
        loadAcceptedAnalysis: (key, plan, inputDigest, binding) => {
          const challenge = challengeForKey(key)
          const partitionId = key.slice('partition:'.length, -':analysis'.length)
          const authorization = challenge?.version === 'p0-review-challenge-v2' ? p0ReviewChallenges.get(partitionId) : undefined
          const current = store.readAttempt(attempt!.id)
          const history = store.listAttempts(operation.id).filter(item => item.number < current.number && ['failed', 'superseded', 'settled'].includes(item.status))
          for (const prior of authorization ? [current, ...history] : history) {
            const source = partitionStage<CodeBehaviorAnalysis>(store, operation, prior, key)
            if (!source || challenge && source.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256 || !source.result.reviewPassed || source.result.inputDigest !== inputDigest || source.result.inputId !== operation.input.id || source.result.policyDigest !== operation.policyDigest || source.result.readSetDigest !== operation.readSetDigest || source.result.composedDigest !== view.composed.contentDigest) continue
            if (authorization) {
              const selection = store.readBusinessBaselineSelection(operation.id)
              const currentIndex = prior.id === current.id ? readStageCheckpoints(store, operation, current, true) : undefined
              const checkpoints = (origin: SyncAttempt): SyncCheckpointStageView => origin.id === current.id && currentIndex ? currentIndex
                : historyCheckpoints(origin.operationId === operation.id ? operation : store.readOperation(origin.operationId), origin)
              const member = { partitionId, analysisRef: source.resultRef, analysis: source.result, changedPaths: [...binding.changedPaths] }
              const proof = withReadonlySnapshotQuery(() => finishApprovalProof(approvedBehaviorPartitionSource(store, operation, operation, prior, contentHash(JSON.stringify(plan)), member, selection, checkpoints,
                { settled: new Set() }, {
                  expectedReadSetDigest: operation.readSetDigest, expectedComposedDigest: view.composed.contentDigest, analysisSchemaDigest: binding.analysisSchemaDigest, authorization,
                })))
              if (typeof proof === 'string') fail('sync_p0_challenge_binding', proof)
            } else if (partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan')?.result.digest !== plan.digest || source.result.traces.length !== 2 || !source.result.traces.every(trace => stage<{ version: string }>(store, operation, prior, 'behavior-draft-protocol')?.version === 'code-behavior-draft-v1' ? behaviorTraceBinding(store, operation, prior, key, trace) : prior.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId))) continue
            if (prior.id === current.id) return source.result
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            partitionCheckpoints.save(key, source.result)
            return source.result
          }
          if (!operation.retryOf) return null
          approvalAncestors ??= retryDraftSources(store, operation, attempt!.number).filter(({ owner }) => owner.id !== operation.id && settledApprovalSource(store, owner))
          const planRef = contentHash(JSON.stringify(plan)), selection = store.readBusinessBaselineSelection(operation.id)
          for (const { owner, prior } of approvalAncestors) {
            if (canonical(prior.composedInput) !== canonical(view.composed)) continue
            const checkpoints = (origin: SyncAttempt): SyncCheckpointStageView => historyCheckpoints(origin.operationId === owner.id ? owner : store.readOperation(origin.operationId), origin)
            const original = checkpoints(prior), savedPlan = partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', selection, original)
            if (savedPlan?.resultRef.sha256 !== planRef) continue
            const source = partitionStage<CodeBehaviorAnalysis>(store, owner, prior, key, selection, original)
            if (!source || challenge && source.result.reviewDiagnosticRef?.sha256 !== challenge.diagnosticRef.sha256 || source.result.inputDigest !== inputDigest || source.result.inputId !== operation.input.id || source.result.policyDigest !== operation.policyDigest || source.result.readSetDigest !== operation.readSetDigest || source.result.composedDigest !== view.composed.contentDigest) continue
            if (!authenticateApprovedBehaviorPartition(store, owner, prior, key, source.result, binding.changedPaths, selection, checkpoints, binding.analysisSchemaDigest, false, authorization)) continue
            assertMaterialFence()
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            return source.result
          }
          return null
        },
        loadCrossFreezeElaborationAuthor,
        authenticateCrossFreezeElaboration: result => authenticatedApprovedElaboration(store, operation, store.readAttempt(attempt!.id), result, { allowDeferredImplementation: true }),
        loadAcceptedElaboration: (key, binding, inputDigest) => {
          const readonly = readonlyAccepted(key, binding, inputDigest)
          if (readonly) return readonly
          for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(item.status))) {
            const source = partitionElaborationStage(store, operation, prior, key, binding, inputDigest)
            if (!source || !source.result.structurePassed || !source.result.reviewPassed || source.result.failure || source.result.phase !== undefined || !['complete', 'needs_input', 'conflict'].includes(source.result.status)) continue
            const crossFreeze = source.result.rounds.some(round => round.crossFreezeAuthor)
            if ((crossFreeze || source.result.rounds.at(-1)?.review?.verdict !== 'accept')
              && !authenticatedApprovedElaboration(store, operation, prior, source.result, { allowDeferredImplementation: true })) {
              if (crossFreeze) fail('cross_freeze_p1_approval_binding', '跨冻结 P1 检查点缺少当前正式独审原件', [source.resultRef])
              continue
            }
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            partitionCheckpoints.save(key, source.result)
            return source.result
          }
          return loadAcceptedRetryElaboration(key, binding, inputDigest, false)
        },
        readonlyFactRepairSource: (key, repair) => {
          for (const origin of store.listAttempts(operation.id)) {
            const prior = stage<SavedElaboration>(store, operation, origin, key), round = prior?.rounds.at(-1)
            if (!prior || contentHash(JSON.stringify(prior)) !== repair.acceptedRef.sha256 || !prior.structurePassed || !prior.reviewPassed || prior.failure || prior.readonlySpecRepair?.kind !== 'candidate_review' || round?.review?.verdict !== 'accept') continue
            if (canonical(prior.changes) !== canonical(repair.changes) || prior.partitionBinding?.partitionId !== key.slice('partition:'.length, -':elaboration'.length)) fail('readonly_spec_repair_binding', '事实继承必须逐字绑定原acceptedRef的本owner完整changes')
            const generation = elaborationGenerationSource(store, operation, origin, round, prior)
            if (!generation) fail('readonly_spec_repair_binding', '事实继承缺少原已批准owner的真实generation来源')
            const protocol = stage<{ generationGuidance?: ElaborationGenerationGuidance }>(store, generation.owner, generation.attempt, 'elaboration-draft-protocol')
            return protocol?.generationGuidance === ELABORATION_GENERATION_GUIDANCE
          }
          return false
        },
        loadReadonlySpecRepair: async (key, binding, inputDigest, localInput) => {
          const owner = readonlyActiveOwners.find(owner => owner.key === key)
          if (!owner) return null
          const sourceAttempt = store.readAttempt(owner.fromAttemptId)
          const prior = reviewedReadonlyLocal(store, operation, sourceAttempt, key, owner.resultRef, readonlyOwnerRepair!.priorRef, 0, readonlySources()), round = prior.rounds.at(-1)!
          const protocol = stage<{ generationGuidance?: ElaborationGenerationGuidance }>(store, operation, sourceAttempt, 'elaboration-draft-protocol')
          const priorInput = { ...localInput, generationGuidance: protocol?.generationGuidance, ...(prior.gapRepair ? { gapRepair: prior.gapRepair } : {}) }
          if (canonical(prior.partitionBinding) !== canonical(binding) || (prior.readonlySpecRepair?.baseInputDigest ?? prior.inputDigest) !== freezeElaborationInput(priorInput).inputDigest) fail('readonly_spec_repair_binding', '只读owner原件不匹配当前完整局部输入')
          const ids = new Set(prior.changes.flatMap(change => parseContract(change).contract!.items.map(item => item.id)))
          const findings = readonlyOwnerRepair!.findings.filter(finding => prior.changes.some(change => change.nodeId === finding.nodeId && change.path === finding.path))
            .map(finding => localInput.generationGuidance === ELABORATION_GENERATION_GUIDANCE && finding.relatedIds ? { ...finding, relatedIds: finding.relatedIds.filter(id => ids.has(id)) } : finding)
          if (prior.changes.some(change => !within(change.path, options.plan.writePaths) || options.plan.mandatoryTests.some(test => overlap(change.path, test.testPath)))) fail('readonly_spec_repair_binding', '只读V1 owner目标越过冻结授权')
          const current = store.readAttempt(attempt!.id)
          const name = key + ':readonly-repair-provenance'
          const reserved = current.dispatchPlans.some(dispatch => dispatch.key.startsWith('sync:' + current.id + ':elaborate:partition:' + binding.partitionId + ':'))
          const sourcePaths = !readonlyOwnerRepair!.kind && findings.every(issue => issue.citation)
            ? findings.filter(issue => issue.code === 'anchor-dead' && issue.citation?.origin === 'source').map(issue => parseCodeEntry(issue.citation!.ref).path)
            : []
          const wholeFileSourcePaths = reserved
            ? stage<{ wholeFileSourcePaths?: string[] }>(store, operation, current, name)?.wholeFileSourcePaths
            : sourcePaths.length ? await findWholeFileSourcePaths(view.files, sourcePaths) : undefined
          assertMaterialFence()
          saveStage(store, fence!, name, { fromAttemptId: sourceAttempt.id, resultRef: owner.resultRef, generationRef: readonlyOwnerRepair!.generationRef,
            ...(wholeFileSourcePaths?.length ? { wholeFileSourcePaths } : {}) })
          const kind = findings.some(finding => finding.code === 'candidate-review-contract-omission') ? 'contract_omission' as const : readonlyOwnerRepair!.kind
          return { prior, priorInput, wholeFileSourcePaths, repair: { ...(kind ? { kind, reviewEvidence: readonlyOwnerRepair!.reviewEvidence } : findings.every(issue => issue.citation) ? { applicability: round.candidate!.applicability } : {}), baseInputDigest: inputDigest, candidateDigest: readonlyOwnerRepair!.candidateDigest, generationRef: readonlyOwnerRepair!.generationRef, acceptedRef: owner.resultRef, changes: prior.changes, output: round.output, review: round.review, findings } }
        },
        loadPartitionSealRepair: async (key, binding, inputDigest) => {
          const source = await loadSealRepairSource()
          assertMaterialFence()
          const local = source?.locals.get(binding.partitionId), findings = source?.owners.get(binding.partitionId)
          if (!source || !local || !findings) return null
          store.assertWriteFence(fence!)
          const prior = local.result, round = prior.rounds.at(-1)!
          if (canonical(prior.partitionBinding) !== canonical(binding) || (prior.gapRepair?.baseInputDigest ?? prior.readonlySpecRepair?.baseInputDigest ?? prior.inputDigest) !== inputDigest) return null
          if (prior.changes.some(change => !within(change.path, options.plan.writePaths) || options.plan.mandatoryTests.some(test => overlap(change.path, test.testPath)))) fail('partition_final_seal_binding', '全局seal返修owner越过原冻结写范围')
          const crossOperation = source.attempt.operationId !== operation.id
          const name = `${key}:readonly-repair-provenance`
          const provenance = { ...(crossOperation ? { fromOperationId: source.attempt.operationId } : {}), fromAttemptId: source.attempt.id, resultRef: local.resultRef, generationRef: source.resultRef }
          if (crossOperation) {
            const current = store.readAttempt(attempt!.id)
            if (current.dispatchPlans.some(dispatch => dispatch.key.startsWith(`sync:${current.id}:elaborate:partition:${binding.partitionId}:`))) {
              const saved = stage<typeof provenance>(store, operation, current, name, 'automatic', readSyncCheckpointStageIndex(store, operation, current))
              if (!saved) return null
              if (canonical(saved) !== canonical(provenance)) fail('partition_final_seal_binding', '已预留owner必须重放其原全局seal返修来源')
            }
          }
          saveStage(store, fence!, name, provenance)
          return { prior, repair: { kind: 'partition_seal', baseInputDigest: inputDigest, candidateDigest: source.result.candidateDigest!, generationRef: source.resultRef, acceptedRef: local.resultRef, changes: prior.changes, output: round.output, review: round.review, findings } }
        },
        loadGapRepair: async (key, binding, inputDigest) => {
          const source = await loadGapRepairSource()
          assertMaterialFence()
          const local = source?.locals.get(binding.partitionId)
          if (!source || !local || !elaborationGapRepairFindings(source.evidence, source.result).some(issue => local.result.changes.some(change => change.nodeId === issue.nodeId && change.path === issue.path))) return null
          const prior = local.result
          if (canonical(prior.partitionBinding) !== canonical(binding) || (prior.gapRepair?.baseInputDigest ?? prior.readonlySpecRepair?.baseInputDigest ?? prior.inputDigest) !== inputDigest) fail('candidate_gap_review_binding', '候选GAP续稿不能改变原owner完整输入')
          if (prior.changes.some(change => !within(change.path, options.plan.writePaths) || options.plan.mandatoryTests.some(test => overlap(change.path, test.testPath)))) fail('candidate_gap_review_binding', '候选GAP续稿越过原冻结写范围')
          const provenance = { fromAttemptId: source.attempt.id, resultRef: local.resultRef, reviewRef: source.reviewRef }
          saveStage(store, fence!, `${key}:gap-repair-provenance`, provenance)
          return { prior, repair: { reviewRef: source.reviewRef, acceptedRef: local.resultRef, baseInputDigest: inputDigest } }
        },
        loadAcceptedInterfaceSeed: (key, binding, inputDigest) => {
          const readonly = readonlyAccepted(key, binding, inputDigest)
          if (readonly) return readonly
          for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(item.status))) {
            const source = partitionElaborationStage(store, operation, prior, key, binding, inputDigest)
            if (!source) continue
            const { result: saved, resultRef } = source
            if (!saved.structurePassed || !saved.reviewPassed || saved.failure || saved.phase !== 'interface_seed' || !['interface_seed', 'needs_input', 'conflict'].includes(saved.status)
              || saved.rounds.at(-1)?.review?.verdict !== 'accept') continue
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef })
            partitionCheckpoints.save(key, saved)
            return saved
          }
          return loadAcceptedRetryElaboration(key, binding, inputDigest, true)
        },
        loadElaborationDraftMaterial: (key, binding, schemaDigest, request) => loadElaborationDraftMaterial(key, binding, schemaDigest, request),
        loadElaborationDraft: (key, binding, schemaDigest, repairInputDigest) => loadElaborationDraft(key, binding, schemaDigest, repairInputDigest),
        loadElaborationRepairDiagnostics: (key, binding, inputDigest) => loadElaborationRepairDiagnostics(key, inputDigest, binding),
        loadElaborationRepairSeed: (key, binding, inputDigest) => loadElaborationRepairSeed(key, inputDigest, binding),
        save: (key, value) => {
          const saved = p0StatusOnly && key === 'partition:analysis-failures' ? { ...(value as PartitionAnalysisFailures), failures: (value as PartitionAnalysisFailures).failures.map(storedPartitionFailure) } : value
          return saveStage(store, fence!, key, saved, !operation.baselineSelection && (key.startsWith('partition:') || key === 'partition-plan') ? { readSetDigest: operation.readSetDigest } : undefined)
        },
      }
      let partitions: SyncPartitionPlan | null = null
      let analysis: CodeBehaviorEvidence | undefined
      let decision: SyncDecisionInput | undefined
      if (operation.origin === 'decision' && operation.requestBlob) {
        const type = JSON.parse(readEvidence(operation.input.source.commonDir, operation.requestBlob).toString('utf8')) as { type?: string }
        if (type.type === 'sync.decision') decision = readControlledDecision(operation.input, operation.requestBlob)
      }
      const authorTree = operation.previousBaselinePair?.sourceInput.immutableTree ?? operation.input.immutableTree
      const authorFiles = new Map((operation.previousBaselinePair || operation.requestBlob ? readTree(operation.input.source.commonDir, authorTree) : []).filter(entry => entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md') && entry.mode !== '120000').map(entry => [entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8')]))
      const authorNewFiles = new Map((operation.previousBaselinePair || operation.requestBlob ? readTree(operation.input.source.commonDir, operation.input.immutableTree) : []).filter(entry => entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md') && entry.mode !== '120000').map(entry => [entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8')]))
      if (operation.requestBlob && !decision) for (const change of readControlledChanges(operation.input, operation.requestBlob)) {
        if (!change.path.startsWith('.spec/') || !change.path.endsWith('/spec.md')) continue
        if (change.next) authorNewFiles.set(change.path, readObject(operation.input.source.commonDir, change.next.oid).toString('utf8')); else authorNewFiles.delete(change.path)
      }
      const deliveredAuthorFiles = operation.previousBaselinePair ? new Map(readTree(operation.input.source.commonDir, operation.previousBaselinePair.verifiedDelivery.immutableTree).filter(entry => entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md') && entry.mode !== '120000').map(entry => [entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8')])) : authorFiles
      for (const path of adoptedDeliveryPaths(operation.input, operation.previousBaselinePair)) { const text = deliveredAuthorFiles.get(path); if (text === undefined) authorFiles.delete(path); else authorFiles.set(path, text) }
      const authoredContractChanged = operation.baselineSelection
        ? readCompositionEvidence(operation.input, view.composed, store.readBusinessBaselineSelection(operation.id)!)?.intents.some(intent => intent.changed) ?? false
        : authoredContractChanges(authorFiles, authorNewFiles, deliveredAuthorFiles, view.frozen.nodes).some(change => options.plan.targets.some(target => target.path === change.path))
      const baselineCodeChanged = Boolean(operation.previousBaselinePair && actualTreeDiff(readTree(operation.input.source.commonDir, authorTree), verifySnapshot(operation.input)).some(file => !file.path.startsWith('.spec/') && within(file.path, options.plan.writePaths)))
      const behaviorOrigin = options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec' || baselineCodeChanged || authoredContractChanged || ['code', 'combined', 'reconcile'].includes(operation.origin) || Boolean(view.composed.compositionEvidenceBlob) || Boolean(decision)
      if (options.plan.version === 'sync-coordinator-v2') {
        const plan = options.plan
        partitions = partitionCheckpoints.load<SyncPartitionPlan>('partition-plan')
        if (reviewContinuation && !partitions) {
          partitions = reviewContinuation.plan
          partitionCheckpoints.save('partition-plan', partitions)
          if (!reviewContinuation.generation.fileWriterPlanRef) fail('review_source_binding', '原已验证候选缺少真实file-writer-plan引用')
          partitionCheckpoints.save('file-writer-plan', JSON.parse(readEvidence(operation.input.source.commonDir, reviewContinuation.generation.fileWriterPlanRef).toString()))
          saveStage(store, fence, 'review-plan-provenance', { fromOperationId: reviewContinuation.operation.id, fromAttemptId: reviewContinuation.attempt.id, resultRef: writeEvidence(operation.input.source.commonDir, partitions) })
        }
        if (readonlyOwnerRepair) {
          const originalPlan = stage<SyncPartitionPlan>(store, operation, store.readAttempt(readonlyOwnerRepair.planAttemptId), 'partition-plan')
          if (!originalPlan || writeEvidence(operation.input.source.commonDir, originalPlan).sha256 !== readonlyOwnerRepair.planRef.sha256 || partitions && partitions.digest !== originalPlan.digest) fail('readonly_spec_repair_binding', '只读V1返修不能更换原已审partition计划')
          if (!partitions) { partitions = originalPlan; partitionCheckpoints.save('partition-plan', partitions); saveStage(store, fence, 'readonly-repair-plan-provenance', { fromAttemptId: readonlyOwnerRepair.planAttemptId, resultRef: readonlyOwnerRepair.planRef }) }
        }
        if (!partitions && options.plan.direction === 'code_to_spec' && readonlyBase?.operationId === operation.id && !readonlyOwnerRepair) {
          const origin = store.readAttempt(readonlyBase.attemptId)
          const mixed = readonlyBase.result.analysisOnlyPartitions
          const original = elaborationComposedBinding(store, operation, origin, readonlyBase.result, view.composed) && reviewPlanStage(store, operation, origin, 'partition-plan', mixed ? 'analysis_only_p1' : undefined)
          const owners = readonlyBase.result.partitionEvidence
          if (mixed && (!original || !authenticatedMixedElaborationCoverage(store, operation, origin, original.result, readonlyBase.result))) fail('readonly_spec_repair_binding', '只读V1复用缺少精确原P0及真实P1分区覆盖')
          if (original && (readonlyBase.result.analysisOnlyPartitions
            || owners?.length === original.result.partitions.length && owners.every(owner => original.result.partitions.some(partition => partition.id === owner.partitionId) && (JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString()) as SavedElaboration).partitionBinding?.planDigest === original.result.digest))) {
            partitions = original.result
            partitionCheckpoints.save('partition-plan', partitions)
          }
        }
        if (!partitions) {
          const sourceEntries = verifySnapshot(operation.input)
          const before = readTree(operation.input.source.commonDir, operation.previousBaselinePair?.sourceInput.immutableTree ?? plan.commitTrigger?.before?.immutableTree ?? operation.input.immutableTree)
          const delivery = readTree(operation.input.source.commonDir, operation.previousBaselinePair?.verifiedDelivery.immutableTree ?? operation.input.immutableTree)
          const compositionEvidence = operation.baselineSelection ? readCompositionEvidence(operation.input, view.composed, store.readBusinessBaselineSelection(operation.id)!) : null
          const residuals = compositionEvidence?.residualPaths ?? []
          const initialSources = operation.origin === 'initial' || plan.commitTrigger?.before === null ? sourceEntries.filter(entry => within(entry.path, plan.sourcePaths ?? [])).map(entry => entry.path) : []
          let changedPaths = unique([...(plan.commitTrigger?.before === null ? [] : plan.commitTrigger?.paths ?? []), ...residuals, ...initialSources, ...(operation.origin === 'initial' ? plan.targets.map(target => target.path) : []), ...actualTreeDiff(before, sourceEntries).map(file => file.path), ...actualTreeDiff(delivery, view.manifest.entries).map(file => file.path), ...(operation.requestBlob && !decision ? readControlledChanges(operation.input, operation.requestBlob).map(change => change.path) : [])]).filter(path => within(path, view.readPaths))
          if (plan.direction === 'spec_to_code') changedPaths = changedPaths.filter(path => path.startsWith('.spec/'))
          const historicalSnapshots = [...new Map([...(store.readBusinessBaselineSelection(operation.id)?.bindings.flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [pair.verifiedDelivery, pair.sourceInput] : [] }) ?? []), ...operation.previousBaselinePair ? [operation.previousBaselinePair.verifiedDelivery, operation.previousBaselinePair.sourceInput] : [], ...plan.commitTrigger?.before ? [plan.commitTrigger.before] : []].map(snapshot => [snapshot.immutableTree, snapshot])).values()]
          const governanceSources = new Map<string, string>(), governanceNodes = [...view.frozen.nodes]
          for (const snapshot of historicalSnapshots) {
            verifySnapshot(snapshot)
            const sources = new Map(readTree(operation.input.source.commonDir, snapshot.immutableTree).filter(entry => within(entry.path, view.readPaths) && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md') && entry.mode !== '120000').map(entry => [entry.path, readObject(operation.input.source.commonDir, entry.oid).toString('utf8')]))
            const historical = await readFrozenContracts(operation.input.source.canonicalRoot, sources)
            governanceNodes.push(...historical.nodes)
            for (const [path, text] of sources) if (!view.files.has(path) && !governanceSources.has(path)) governanceSources.set(path, text)
          }
          const byteVersions = new Map<string, Map<string, number>>()
          const trees = unique([operation.input.immutableTree, view.composed.tree, ...operation.previousBaselinePair ? [operation.previousBaselinePair.sourceInput.immutableTree, operation.previousBaselinePair.verifiedDelivery.immutableTree] : [], ...historicalSnapshots.map(snapshot => snapshot.immutableTree)])
          for (const tree of trees) readTree(operation.input.source.commonDir, tree, (entry, bytes) => { if (within(entry.path, view.readPaths)) { const versions = byteVersions.get(entry.path) ?? new Map<string, number>(); versions.set(entry.digest, bytes.length); byteVersions.set(entry.path, versions) } })
          for (const artifact of compositionEvidence?.artifacts ?? []) for (const entry of [artifact.before, artifact.delivery, artifact.source, artifact.authorBase]) if (entry && within(entry.path, view.readPaths)) { const versions = byteVersions.get(entry.path) ?? new Map<string, number>(); if (!versions.has(entry.digest)) versions.set(entry.digest, readObject(operation.input.source.commonDir, entry.oid).length); byteVersions.set(entry.path, versions) }
          partitions = planSyncPartitions({ plan: { ...plan, readPaths: [...view.readPaths] }, files: view.files, contracts: view.frozen.contracts, nodes: governanceNodes, governanceSources, changedPaths, maxReadBytes: plan.partitionPolicy.maxReadBytes, readByteSizes: new Map([...byteVersions].map(([path, versions]) => [path, [...versions.values()].reduce((sum, size) => sum + size, 0)])) })
          partitionCheckpoints.save('partition-plan', partitions)
          const hasPriorWork = Boolean(operation.retryOf) || store.listAttempts(operation.id).some(prior => prior.id !== attempt!.id)
          const minimumCalls = partitions.partitions.length * ((hasPriorWork ? 0 : (behaviorOrigin ? 2 : 0) + 2) + (plan.direction === 'code_to_spec' ? 1 : 2)) + partitions.dependencies.length
          const remainingCalls = budget ? budget.maxCalls - store.readBudgetUsage(operation.id).callsUsed : null
          partitionCheckpoints.save('partition-budget', { minimumCalls, remainingCalls, partitionCount: partitions.partitions.length, dependencyCount: partitions.dependencies.length, direction: plan.direction })
          if (remainingCalls !== null && remainingCalls < minimumCalls) fail('partition_budget_insufficient', `完整分区执行至少需要 ${minimumCalls} 次调用，剩余 ${remainingCalls} 次；保持原预算，需明确调整后新接入`, [writeEvidence(operation.input.source.commonDir, { partitionPlan: partitions, minimumCalls, remainingCalls })])
        }
      }
      const postGateReview: CodeBehaviorPostGateReview[] = []
      if (behaviorOrigin) {
        const owners = partitions?.partitions.map(partition => ({ partitionId: partition.id, key: `partition:${partition.id}:elaboration`, targets: partition.targets })) ?? [{ partitionId: undefined, key: 'elaboration', targets: undefined }]
        const ownerKeys = new Set(owners.map(owner => owner.key))
        const beforeFiles = priorDeliveryFiles({ ...operation, baselineSelection: store.readBusinessBaselineSelection(operation.id) }, view, [...options.plan.readPaths, ...operation.scope.paths], options.plan)
        const sources = retryDraftSources(store, operation, attempt!.number).filter(({ prior }) => renderedRepairAttempt(prior))
        const history = new Map<string, { owner: SyncOperation; prior: SyncAttempt; checkpoints: SyncCheckpointStageView; keys: Set<string> } | null>()
        for (const owner of owners) for (const sourceAttempt of sources) {
          let sourceView = history.get(sourceAttempt.prior.id)
          if (sourceView === undefined) {
            store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
            const sourceOwner = store.readOperation(sourceAttempt.owner.id), prior = store.readAttempt(sourceAttempt.prior.id)
            sourceView = null
            if (renderedRepairAttempt(prior)) {
              const checkpoints = readSyncCheckpointStageIndex(store, sourceOwner, prior), keys = new Set<string>()
              for (const { value } of checkpoints.json) {
                const entry = value as Partial<Stage> | null
                if (entry?.version === 'sync-stage-v1' && entry.stage && ownerKeys.has(entry.stage)) keys.add(entry.stage)
              }
              if (keys.size) sourceView = { owner: sourceOwner, prior, checkpoints, keys }
            }
            history.set(prior.id, sourceView)
          }
          if (!sourceView?.keys.has(owner.key)) continue
          const { owner: sourceOwner, prior, checkpoints } = sourceView
          store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
          const matchesFinding = (finding: ContractFinding): boolean => finding.code === 'refactor_business_meaning_changed' && !!finding.itemId && beforeFiles.has(finding.path) && (!owner.targets || owner.targets.some(target => target.path === finding.path && target.nodeId === finding.nodeId))
          const source = renderedElaborationSource(sourceOwner, prior, owner.key, checkpoints, matchesFinding)
          const approved = source && stage<CodeBehaviorAnalysis>(store, sourceOwner, prior, 'analysis', 'automatic', checkpoints)
          if (!source || !approved?.reviewPassed || !analysisStageBinding(store, sourceOwner, approved)) continue
          const local = owner.partitionId ? approved.partitionEvidence?.find(item => item.partitionId === owner.partitionId) : undefined
          if (owner.partitionId && (!local || partitionStage<SyncPartitionPlan>(store, sourceOwner, prior, 'partition-plan', undefined, checkpoints)?.result.digest !== partitions!.digest || source.result.partitionBinding?.planDigest !== partitions!.digest || source.result.partitionBinding?.partitionId !== owner.partitionId)) continue
          const original = local?.analysis ?? approved, analysisRef = local?.analysisRef ?? writeEvidence(operation.input.source.commonDir, approved)
          if (contentHash(JSON.stringify(original)) !== analysisRef.sha256 || !original.reviewPassed || original.inputId !== operation.input.id || original.policyDigest !== operation.policyDigest || original.composedDigest !== view.composed.contentDigest) continue
          if (owner.partitionId && source.result.partitionBinding?.analysisRef?.sha256 !== writeEvidence(operation.input.source.commonDir, approved).sha256) continue
          const findings = source.round.findings.flatMap(finding => {
            if (finding.severity !== 'error' || !finding.itemId || !matchesFinding(finding)) return []
            const beforeSource = beforeFiles.get(finding.path), candidate = source.round.candidate!.changes.find(change => change.path === finding.path && change.nodeId === finding.nodeId)
            if (!beforeSource || !candidate || candidate.beforeDigest !== contentHash(beforeSource)) return []
            const beforeContract = parseContract({ nodeId: finding.nodeId, path: finding.path, source: beforeSource }).contract
            const before = beforeContract?.items.find(item => item.id === finding.itemId), after = parseContract(candidate).contract?.items.find(item => item.id === finding.itemId)
            if (!before || !after || ['AC', 'VERIFY'].includes(before.kind)) return []
            const changedPaths = unique(original.changes.filter(change => change.kind === 'refactor' && change.affectedIds.includes(finding.itemId!)).flatMap(change => change.paths).filter(path => (!local || local.changedPaths.includes(path)) && (path === finding.path || beforeContract!.code.some(claim => relationClaimsPath(parseCodeEntry(claim).path, path)))))
            return changedPaths.length ? [{ finding, before, after, changedPaths }] : []
          })
          if (!findings.length) continue
          const changedPaths = unique(findings.flatMap(finding => finding.changedPaths)), oldTree = operation.previousBaselinePair?.sourceInput.immutableTree ?? (options.plan.version === 'sync-coordinator-v2' ? options.plan.commitTrigger?.before?.immutableTree : undefined) ?? objectGit(operation.input.source.commonDir, ['rev-parse', `${operation.input.headCommit}^{tree}`]).toString().trim()
          postGateReview.push({ ...(owner.partitionId ? { partitionId: owner.partitionId } : {}), analysisRef, analysis: original, resultRef: source.resultRef, candidateDigest: source.round.candidateDigest!, findings, codeDiff: objectGit(operation.input.source.commonDir, ['diff', '--no-ext-diff', '--no-textconv', oldTree, operation.input.immutableTree, '--', ...changedPaths]).toString('utf8') })
          break
        }
      }
      if (behaviorOrigin) {
        let previousDecisionAnalysis: CodeBehaviorEvidence | undefined
        let previousDecisionComposed: ComposedInputRef | undefined
        let previousDecisionReadPaths: readonly string[] | undefined
        const challenged = (value: CodeBehaviorAnalysis): boolean => !behaviorChallengesAnswered(value, p0ReviewChallenges) || postGateReview.some(diagnostic => [writeEvidence(operation.input.source.commonDir, value).sha256, ...value.partitionEvidence?.map(owner => owner.analysisRef.sha256) ?? []].includes(diagnostic.analysisRef.sha256))
        let approved = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis')
        if (approved && challenged(approved)) approved = null
        if (approved) requireChallengedWholeApproval(store, operation, attempt, approved, p0ReviewChallenges)
        if (!approved && reviewContinuation && reviewContinuation.operation.id !== operation.id) {
          const parent = reviewContinuation.operation, prior = reviewContinuation.attempt
          const original = stage<CodeBehaviorAnalysis>(store, parent, prior, 'analysis', 'evidence')
          const binding = original && analysisStageBinding(store, parent, original)
          if (!original?.reviewPassed || !binding || challenged(original) || original.composedDigest !== view.composed.contentDigest) fail('review_handoff_binding', '候选交接不能改写原P0或绕过新的业务质疑')
          requireChallengedWholeApproval(store, parent, prior, original, p0ReviewChallenges)
          approved = original
          saveStage(store, fence, 'analysis-provenance', { fromOperationId: parent.id, fromAttemptId: prior.id, analysisRef: writeEvidence(operation.input.source.commonDir, original), baselineSelectionRef: binding.baselineSelectionRef })
          saveStage(store, fence, 'analysis', original, binding)
        }
        if (!approved) for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse()) {
          store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
          const previous = stage<CodeBehaviorAnalysis>(store, operation, store.readAttempt(prior.id), 'analysis')
          const binding = previous ? analysisStageBinding(store, operation, previous) : null
          if (previous?.reviewPassed && !challenged(previous) && binding && previous.inputId === operation.input.id && previous.policyDigest === operation.policyDigest && previous.composedDigest === view.composed.contentDigest) {
            requireChallengedWholeApproval(store, operation, prior, previous, p0ReviewChallenges)
            approved = previous
            saveStage(store, fence, 'analysis-provenance', { fromAttemptId: prior.id, analysisRef: writeEvidence(operation.input.source.commonDir, previous), baselineSelectionRef: binding.baselineSelectionRef })
            saveStage(store, fence, 'analysis', approved, binding)
            break
          }
        }
        if (!approved) {
          if (decision) {
            const oldOperation = store.readOperation(decision.operationId)
            const bytes = readEvidence(operation.input.source.commonDir, decision.analysisRef)
            const previous = JSON.parse(bytes.toString('utf8')) as CodeBehaviorAnalysis
            const binding = analysisStageBinding(store, oldOperation, previous)
            const originalComposed = binding ? store.readAttempt(binding.attemptId).composedInput : null
            if (!binding || binding.resultRef.sha256 !== decision.analysisRef.sha256 || previous.policyDigest !== oldOperation.policyDigest || decision.inputId !== operation.input.id || oldOperation.input.id !== operation.input.id || previous.inputId !== operation.input.id || !previous.reviewPassed || decision.findingIds.some(id => !previous.findings.some(finding => finding.id === id)) || !originalComposed || originalComposed.sourceInputId !== previous.inputId || originalComposed.contentDigest !== previous.composedDigest) fail('decision_binding', '业务裁决未绑定真实已审分析、原输入及原组合契约图')
            previousDecisionAnalysis = { ref: decision.analysisRef, analysis: previous }
            previousDecisionComposed = originalComposed
            if (!oldOperation.planBlob) fail('decision_binding', '原已审分析缺少冻结计划')
            const originalPlan = JSON.parse(readEvidence(operation.input.source.commonDir, oldOperation.planBlob).toString('utf8')) as SyncCoordinatorPlan
            if (syncPlanDigest(originalPlan) !== previous.policyDigest) fail('decision_binding', '原已审分析与冻结计划政策不一致')
            const originalSelection = binding.baselineSelectionRef ? JSON.parse(readEvidence(operation.input.source.commonDir, binding.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection : undefined
            previousDecisionReadPaths = unique([...originalPlan.readPaths, ...originalSelection?.bindings.flatMap(binding => binding.resource.kind === 'path' ? [binding.resource.path] : []) ?? []])
          }
          let behaviorProtocol = stage<{ version: 'code-behavior-draft-v1'; contextTransport?: CodeBehaviorContextTransport; exactChangedPathsPreflight?: true; authorEvidencePreflight?: true; reviewCoveragePreflight?: true; reviewDuplicatePreflight?: true }>(store, operation, attempt, 'behavior-draft-protocol')
          if (behaviorProtocol && Object.hasOwn(behaviorProtocol, 'contextTransport') && !isCodeBehaviorContextTransport(behaviorProtocol.contextTransport)) fail('behavior_context_transport_unsupported', '持久P0 contextTransport字段存在但不受支持；仅字段缺席允许legacy运输')
          if (!behaviorProtocol && options.plan.agentWorkflow && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('code_behavior_'))) {
            behaviorProtocol = { version: 'code-behavior-draft-v1', contextTransport: 'git-json-v6', exactChangedPathsPreflight: true, authorEvidencePreflight: true, reviewCoveragePreflight: true, reviewDuplicatePreflight: true }
            saveStage(store, fence, 'behavior-draft-protocol', behaviorProtocol)
          }
          p0StatusOnly = behaviorProtocol?.contextTransport !== undefined && behaviorProtocol.contextTransport !== 'git-json-v1'
          const repairDiagnostics: NonNullable<import('./code-behavior.js').CodeBehaviorInput['repairDiagnostics']>[number][] = []
          if (!p0StatusOnly) {
            for (const sourceAttempt of retryDraftSources(store, operation, attempt!.number).reverse()) {
              store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
              const owner = store.readOperation(sourceAttempt.owner.id), prior = store.readAttempt(sourceAttempt.prior.id)
              if (partitions) {
                const saved = partitionStage<PartitionAnalysisFailures>(store, owner, prior, 'partition:analysis-failures')
                if (saved?.result.planDigest === partitions.digest) repairDiagnostics.push(...saved.result.failures.filter(({ code }) => analysisRepairDiagnosticCodes.has(code)).map(({ partitionId, code, message }) => ({ partitionId, code, message })))
              } else if (prior.failure?.kind === 'repairable' && analysisRepairDiagnosticCodes.has(prior.failure.code)) repairDiagnostics.push({ code: prior.failure.code, message: prior.failure.message })
            }
          }
          const draftProtocol = behaviorProtocol?.version
          if (p0ReviewChallenges.size && (!partitions || behaviorProtocol?.contextTransport !== 'git-json-v6'
            || [...p0ReviewChallenges.keys()].some(id => !partitions!.partitions.some(partition => partition.id === id)))) fail('sync_p0_challenge_binding', '当前冻结分区或原生 P0 协议不能响应复审')
          const operatorReviewDiagnostics = new Map([...p0ReviewChallenges].map(([partitionId, { operationId, challenge }]) =>
            [partitionId, readP0ReviewDiagnostic(operationId, operation.input.source.commonDir, challenge)]))
          try { const analysisInput: import('./code-behavior.js').CodeBehaviorInput = { ...(draftProtocol ? { draftProtocol } : {}), ...(behaviorProtocol?.contextTransport ? { contextTransport: behaviorProtocol.contextTransport } : {}), exactChangedPathsPreflight: behaviorProtocol?.exactChangedPathsPreflight, authorEvidencePreflight: behaviorProtocol?.authorEvidencePreflight, reviewCoveragePreflight: behaviorProtocol?.reviewCoveragePreflight, reviewDuplicatePreflight: behaviorProtocol?.reviewDuplicatePreflight, model, snapshot: operation.input, baseline: operation.previousBaselinePair, ...(operation.baselineSelection ? { baselineSelection: store.readBusinessBaselineSelection(operation.id) } : {}), composed: view.composed, readSetDigest: operation.readSetDigest, policyDigest: operation.policyDigest, plan: operation.baselineSelection ? { ...options.plan, readPaths: view.readPaths } : options.plan, requestKey: `sync:${attempt.id}:analysis`, timeoutMs: callTimeoutMs, signal, origin: operation.origin, ...(decision && previousDecisionAnalysis ? { decision: { request: decision, previous: previousDecisionAnalysis, previousComposed: previousDecisionComposed, previousReadPaths: previousDecisionReadPaths } } : {}), repairDiagnostics, postGateReview }; approved = partitions ? await analyzeSyncPartitions(analysisInput, partitions, options.plan.version === 'sync-coordinator-v2' ? options.plan.partitionPolicy.maxParallel : 1, runner, partitionCheckpoints, operatorReviewDiagnostics) : await analyzeCodeBehavior(analysisInput, runner, undefined, { replayDraft: replayBehaviorDraft, loadReviewFeedback: inputDigest => loadBehaviorReviewFeedback('analysis', inputDigest), loadMaterial: (purpose, schemaDigest, inputDigest, request, existingDraft) => loadBehaviorDraftMaterial('analysis', purpose, schemaDigest, inputDigest, request, undefined, existingDraft), load: (inputDigest, analysisSchemaDigest) => loadBehaviorContinuation('analysis', inputDigest, analysisSchemaDigest), save: continuation => { saveStage(store, fence!, 'analysis:continuation', continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined) } }) }
          catch (error) {
            if (error instanceof P0ApprovalEvidenceError) fail(error.code, error.message, [error.auditRef])
            const issue = error as { code?: string; message?: string }
            const partitionFailures = (error as { partitionFailures?: PartitionAnalysisFailure[] }).partitionFailures
            const errors = [error, ...partitionFailures?.map(item => item.error) ?? []]
            const currentAttempt = store.readAttempt(attempt!.id)
            const blocked = errors.find(item => !(behaviorAnalysisRepairCodes.has((item as { code?: string }).code ?? '')
              || item instanceof StageDraftCommitMissingError && (item as { code?: string }).code === CODE_BEHAVIOR_DRAFT_COMMIT_MISSING
              || item instanceof SettledSessionCreateTimeoutError
              || item instanceof StructuredSessionError && (structuredAnalysisRepairCodes.has(item.code)
                || hasSettledNativeRpcFailure(store, operation, currentAttempt, item)
                || hasSettledNativeTurnTransportFailure(store, operation, currentAttempt, item)
                || hasSettledGrokP0ExitFailure(store, operation, currentAttempt, item))))
            if (!signal.aborted && blocked instanceof StructuredSessionError && blocked.code === 'native_turn_transport_failed') fail('cancellation_pending', '原生turn传输故障尚无本尝试的精确停止及资源结算证明')
            if (blocked || signal.aborted) {
              const cause = blocked ?? error
              if (p0StatusOnly && cause instanceof SyntaxError) statusOnlyAnalysisFailure = cause
              throw cause
            }
            const message = p0StatusOnly ? CODE_BEHAVIOR_FAILURE_STATUS : issue.message
            const rejected = failure(issue.code!, message ?? String(error), 'repairable', [writeEvidence(operation.input.source.commonDir, { code: issue.code, message, ...(partitionFailures ? { partitionFailures: partitionFailures.map(storedPartitionFailure) } : {}), ...(error instanceof StructuredSessionError ? { sessionId: error.sessionId, threadId: error.threadId, turnId: error.turnId } : {}) })])
            store.recordFailure(fence, rejected); continue
          }
          saveStage(store, fence, 'analysis', approved)
        }
        const ref = writeEvidence(operation.input.source.commonDir, approved)
        if (!approved.reviewPassed || !behaviorChallengesAnswered(approved, p0ReviewChallenges) || !analysisStageBinding(store, operation, approved) || approved.inputId !== operation.input.id || approved.policyDigest !== operation.policyDigest || approved.composedDigest !== view.composed.contentDigest) fail('analysis_binding', '已审行为分析与冻结输入/基线/政策不一致')
        analysis = { ref, analysis: approved }
        await requireCrossFreezeWholeApproval(store, operation, store.readAttempt(attempt.id), partitions, analysis, async () => {
          store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs)
        })
        if (approved.findings.some(finding => finding.kind === 'conflict')) store.recordReviewedConflict(fence)
      }
      const effectiveFindings = analysis?.analysis.findings ?? []
      const unboundFindings = effectiveFindings.filter(finding => !finding.affectedIds.length)
      if (unboundFindings.length) {
        const issue = failure('unbound_behavior_finding', JSON.stringify({ message: '已审业务发现尚无既有契约ID可关联，需先明确该冲突或缺口', findings: unboundFindings }), effectiveFindings.some(finding => finding.kind === 'conflict') ? 'conflict' : 'missing_input', [analysis!.ref])
        store.recordFailure(fence, issue)
        return current(undefined, issue)
      }
      const deliveredFiles = priorDeliveryFiles({ ...operation, baselineSelection: store.readBusinessBaselineSelection(operation.id) }, view, [...options.plan.readPaths, ...operation.scope.paths], options.plan)
      const historyGroup = operation.baselineSelection && operation.requestBlob ? readCompositionEvidence(operation.input, view.composed, store.readBusinessBaselineSelection(operation.id)!).controlledAuthorGroup : undefined
      for (const change of historyGroup?.changes ?? []) {
        if (!change.path.startsWith('.spec/') || !change.path.endsWith('/spec.md')) continue
        const binding = store.readBusinessBaselineSelection(operation.id)!.bindings.find(binding => binding.resource.kind === 'path' && binding.resource.path === change.path)
        if (!binding || !('bytePair' in binding) || binding.bytePair) continue
        if (change.before) deliveredFiles.set(change.path, readObject(operation.input.source.commonDir, change.before.oid).toString('utf8')); else deliveredFiles.delete(change.path)
      }
      const historicalRetiredIds = unique([...(operation.previousBaselinePair?.retiredIds ?? []), ...(operation.baselineSelection ? selectedRetiredIds(store.readBusinessBaselineSelection(operation.id)!) : [])])
      const behaviorFacts = [...options.plan.facts, ...(analysis?.analysis.facts ?? []), ...effectiveFindings.map(finding => ({ source: `derived:${finding.ruleIds[0] ?? finding.affectedIds[0]}`, text: JSON.stringify(finding) }))]
      const nodeChanges = analysis?.analysis.nodeChanges.map(change => ({ ...change, evidenceRef: analysis.ref })) ?? []
      const moved = nodeChanges.filter(change => change.action === 'move')
      const behaviorTargets: SyncCoordinatorPlan['targets'][number][] = [...options.plan.targets.filter(target => !moved.some(change => change.to.path === target.path)), ...nodeChanges.map(change => ({ nodeId: change.from.nodeId, path: change.from.path })), ...(analysis?.analysis.newNodes.map(node => ({ nodeId: node.nodeId, path: node.path, rawSource: node.rawSource })) ?? [])]
      const behaviorAuthorization = [...options.plan.authorizedChanges ?? [], ...(analysis ? deriveBehaviorAuthorization(analysis.analysis, analysis.ref) : [])]
      const integratedRaw = new Map(analysis?.analysis.rawIntegrations?.map(proof => [proof.path, proof.expectedRaw]) ?? [])
      const effectiveIntentNodeId = moved.find(change => change.to.nodeId === options.plan.intentNodeId)?.from.nodeId ?? options.plan.intentNodeId
      const preserveBusiness = Boolean(analysis && !decision && !analysis.analysis.newNodes.length && !analysis.analysis.nodeChanges.some(change => change.action === 'retire') && analysis.analysis.changes.every(change => change.kind === 'refactor'))
      const makeElaborationInput = (draftProtocol?: 'elaboration-draft-v1'): import('./elaboration-types.js').ElaborationInput => {
        const intent = view.frozen.nodes.find(node => node.id === options.plan.intentNodeId)
        const intentTarget = options.plan.targets.find(target => target.nodeId === options.plan.intentNodeId)
        const rawSource = integratedRaw.get(intentTarget?.path ?? intent?.path ?? '') ?? intentTarget?.rawSource ?? intent?.rawSource
        if (!rawSource) fail('missing_intent', '冻结readset中没有明确raw原意')
        let targets = [...new Map(behaviorTargets.map(target => [target.path, target])).values()].map(target => {
          const lifecycle = nodeChanges.find(change => change.from.path === target.path)
          const useDelivery = Boolean(analysis || lifecycle || !view.files.has(target.path)) && deliveredFiles.has(target.path)
          const source = (useDelivery ? deliveredFiles : view.files).get(target.path) ?? null
          const restoration = restored.some(item => item.path === target.path), restoredBefore = history?.changes.find(change => change.path === target.path)?.before
          const targetSource = restoration ? restoredBefore ? readObject(operation.input.source.commonDir, restoredBefore.oid).toString('utf8') : null : source
          if (source !== null && !lifecycle && !useDelivery && view.frozen.nodes.find(node => node.path === target.path)?.id !== target.nodeId) fail('target_identity', '可信目标node/path与冻结解析结果不同')
          return { ...target, ...(integratedRaw.has(target.path) ? { rawSource: integratedRaw.get(target.path)! } : view.files.get(target.path) && !lifecycle ? { rawSource: target.rawSource ?? parseParts(view.files.get(target.path)!)?.rawSource } : {}), source: targetSource, sourceDigest: targetSource === null ? null : contentHash(targetSource) }
        })
        let refinementFiles = view.files
        if (refinement) {
          const priorFiles = new Map(view.files)
          for (const change of refinement.prior.changes) priorFiles.set(change.path, change.source)
          targets = targets.map(target => { const source = priorFiles.get(target.path) ?? target.source; return { ...target, source, sourceDigest: source === null ? null : contentHash(source) } })
          refinementFiles = new Map(readTree(operation.input.source.commonDir, refinement.candidate.tree).filter(entry => within(entry.path, options.plan.readPaths) && entry.mode !== '120000').flatMap(entry => { const bytes = readObject(operation.input.source.commonDir, entry.oid); return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')] as [string, string]] : [] }))
        }
        return { ...(draftProtocol ? { draftProtocol } : {}), ...(operation.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), ...(options.plan.agentWorkflow ? { worktree: stageWorktree(operation.input.source.commonDir, operation.input.headCommit, refinement?.candidate.tree ?? view.composed.tree) } : {}), root: operation.input.source.canonicalRoot, base: operation.input.headCommit, requestKey: `sync:${attempt!.id}:elaborate`, intent: { nodeId: effectiveIntentNodeId, rawSource }, targets, context: view.frozen.nodes.filter(node => !targets.some(target => target.path === node.path) && !moved.some(change => change.to.path === node.path)).map(node => ({ nodeId: node.id, path: node.path, source: view.files.get(node.path)! })), files: refinementFiles, facts: behaviorFacts, analysis, decisionAuthorities: analysis?.analysis.decisionAuthorities ?? options.plan.decisionAuthorities,  ...(refinement ? { refinement: { candidateDigest: refinement.candidateDigest, diagnostics: refinement.diagnostics } } : {}), mode: preserveBusiness ? 'preserve_business' : 'reelaborate', nodeChanges, verifications: options.plan.verifications.map(item => item.definition), ...(options.plan.contextVerifications ? { contextVerifications: options.plan.contextVerifications } : {}), ...(options.plan.historicalCoverage ? { historicalCoverageDigest: options.plan.historicalCoverage.digest } : {}), implementationWritePaths: options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec' ? [] : unique(options.plan.writePaths), readonlyTestPaths: unique(options.plan.mandatoryTests.map(test => test.testPath)), authorizedChanges: behaviorAuthorization, historyInput: operation.input, retiredIds: unique([...(options.plan.retiredIds ?? []), ...historicalRetiredIds]), maxRepairs: 0, maxCalls: 2, totalTimeoutMs: operation.deadlineAtMs === null ? null : operation.deadlineAtMs - Date.now(), timeoutMs: callTimeoutMs, signal, model, effort: 'high' as const }
      }
      const gapInput = (origin: SyncAttempt): ElaborationInput => {
        const protocol = stage<{ version: 'elaboration-draft-v1'; generationGuidance?: ElaborationGenerationGuidance }>(store, operation, origin, 'elaboration-draft-protocol')
        return { ...makeElaborationInput(protocol?.version), generationGuidance: protocol?.generationGuidance, requestKey: `sync:${origin.id}:elaborate` }
      }
      const gapAggregate = async (origin: SyncAttempt, aggregateRef: BlobRef) => {
        await yieldToControl(); assertMaterialFence()
        const checkpoints = candidateHistoryCheckpoints(origin)
        const source = partitionStage<SavedElaboration>(store, operation, origin, 'elaboration', undefined, checkpoints)
        const plan = partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan', undefined, checkpoints)
        if (!partitions || !source || source.resultRef.sha256 !== aggregateRef.sha256 || !plan || canonical(plan.result) !== canonical(partitions)
          || !elaborationComposedBinding(store, operation, origin, source.result, view.composed, checkpoints)
          || source.result.phase !== 'partitioned_final' || !source.result.structurePassed || !source.result.reviewPassed || source.result.failure || !source.result.partitionSeal?.passed
          || source.result.analysisOnlyPartitions?.length && !authenticatedMixedElaborationCoverage(store, operation, origin, partitions, source.result)) fail('candidate_gap_review_binding', '候选GAP复核缺少同一原计划及真实通过的全图封口')
        const locals = new Map<string, { result: SavedElaboration; resultRef: BlobRef }>()
        const history = readonlyElaborationHistory(store, operation, candidateHistoryCheckpoints)
        for (const member of source.result.partitionEvidence ?? []) {
          await yieldToControl(); assertMaterialFence()
          const key = `partition:${member.partitionId}:elaboration`
          const approved = reviewedReadonlyLocalSource(store, operation, origin, key, member.resultRef, source.resultRef, 0, history), local = approved.result
          const round = local.rounds.at(-1)!, trace = round.traces.find(trace => trace.purpose === 'elaboration_review')!
          const owners = approved.owner.id === operation.id ? history.attempts : store.listAttempts(approved.owner.id)
          const owner = owners.find(prior => prior.number <= approved.approvalAttempt.number && prior.dispatchPlans.some(dispatch => canonical(dispatch.session) === canonical({ sessionId: trace.sessionId, threadId: trace.threadId, turnId: trace.turnId })))
          const dispatch = owner?.dispatchPlans.find(dispatch => dispatch.session?.sessionId === trace.sessionId)
          const original = owner && dispatch ? authenticatedDraftResult(store, approved.owner, owner, dispatch.key, trace.purpose) : null
          if (!original?.result || original.result.resultDigest !== trace.resultDigest || canonical(original.result.output) !== canonical(round.reviewOutput)
            || !round.draft || !round.candidate || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || local.candidateDigest !== round.candidateDigest
            || canonical(local.changes) !== canonical(round.candidate.changes.map(change => ({ ...change, contentDigest: contentHash(change.source) })))) fail('candidate_gap_review_binding', '候选GAP复核缺少原owner Git候选及独立审查认证')
          readStageDraft(operation.input.source.commonDir, round.draft, round.draft)
          locals.set(member.partitionId, { result: local, resultRef: member.resultRef })
        }
        return { ...source, locals }
      }
      type GapReviewSource = Awaited<ReturnType<typeof gapAggregate>> & { attempt: SyncAttempt; evidence: ElaborationGapReviewEvidence; reviewRef: BlobRef; reviewTraces: ElaborationTrace[] }
      const replayGapReview = async (origin: SyncAttempt): Promise<GapReviewSource | null> => {
        const saved = partitionStage<ElaborationGapReviewCheckpoint>(store, operation, origin, 'elaboration-gap-review', undefined, candidateHistoryCheckpoints(origin))
        if (!saved) return null
        const source = await gapAggregate(origin, saved.result.aggregateRef)
        let previous: GapReviewSource | null = null
        if (saved.result.previousReviewRef) {
          const prior = store.listAttempts(operation.id).filter(prior => prior.number < origin.number && ['failed', 'superseded', 'settled'].includes(prior.status)).find(prior => partitionStage<ElaborationGapReviewCheckpoint>(store, operation, prior, 'elaboration-gap-review', undefined, candidateHistoryCheckpoints(prior))?.resultRef.sha256 === saved.result.previousReviewRef!.sha256)
          previous = prior ? await replayGapReview(prior) : null
          if (!previous || previous.evidence.review !== null) fail('candidate_gap_review_binding', 'GAP协议续审必须引用同operation严格较早的失败独审')
        }
        const resource = store.findResource(origin.id, saved.result.requestKey)
        const injected = !resource ? stage<{ result: ElaborationSessionResult }>(store, operation, origin, `injected:${saved.result.requestKey}`) : null
        const nativeRef = resource ? resource.checkpoints.some(item => item.checkpointRef.sha256 === saved.result.resultRef.sha256) || resource.checkpointRef.sha256 === saved.result.resultRef.sha256
          : injected && contentHash(JSON.stringify(injected)) === saved.result.resultRef.sha256
        if (!nativeRef) fail('candidate_gap_review_binding', '候选GAP复核没有原Native结果引用')
        const output = (JSON.parse(readEvidence(operation.input.source.commonDir, saved.result.resultRef).toString('utf8')) as { result: ElaborationSessionResult }).result.output
        const evidence = await inspectPartitionedElaborationGaps(gapInput(origin), partitions!, saved.result.aggregateRef, async request => {
          const result = completedNativeStageResult(store, operation, origin, request, saved.result.trace, output, saved.result.candidateDigest, candidateHistoryCheckpoints(origin))
          if (!result) fail('candidate_gap_review_binding', '候选GAP复核的完整只读请求、独立身份或正式Native结果失配')
          return result!
        }, view.composed, previous ? { ref: previous.reviewRef, evidence: previous.evidence, traces: previous.reviewTraces } : undefined, partitionCheckpoints)
        if (!evidence) fail('candidate_gap_review_binding', '原GAP复核不匹配当前候选资格')
        const { reviewOutput: _output, review: _review, findings: _findings, ...binding } = evidence!
        const { resultRef: _resultRef, ...original } = saved.result
        if (canonical(binding) !== canonical(original)) fail('candidate_gap_review_binding', '原GAP复核的输入、并集、GAP集合或trace失配')
        return { attempt: origin, ...source, evidence: evidence!, reviewRef: saved.resultRef, reviewTraces: [...previous?.reviewTraces ?? [], evidence!.trace] }
      }
      let gapRepairSource: ReturnType<typeof replayGapReview> | undefined
      const loadGapRepairSource = () => gapRepairSource ??= (async () => {
        if (reviewContinuation || !partitions || options.plan.version !== 'sync-coordinator-v2' || options.plan.direction !== 'code_to_spec' || !options.plan.agentWorkflow) return null
        for (const prior of store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse()) {
          const checkpoints = candidateHistoryCheckpoints(prior)
          const saved = partitionStage<ElaborationGapReviewCheckpoint>(store, operation, prior, 'elaboration-gap-review', undefined, checkpoints)
          if (!saved || readonlyBase && saved.result.aggregateRef.sha256 !== readonlyBase.resultRef.sha256 || !reuseBehaviorDependentStages(store, operation, prior, checkpoints)) continue
          const source = await replayGapReview(prior)
          if (source) return elaborationGapRepairFindings(source.evidence, source.result).length ? source : null
        }
        return null
      })()
      let cacheDraft: ElaborationDraft | undefined
      const reusableElaborationCache = (cached: SavedElaboration, tagged: boolean): boolean => {
        const draftProtocol = tagged || cached.rounds.some(round => round.draft) ? 'elaboration-draft-v1' : undefined
        const reusable = verifyElaborationDraftCache(makeElaborationInput(draftProtocol), cached, tagged)
        const draft = cached.rounds.at(-1)?.draft
        if (!reusable && !cacheDraft && draft) cacheDraft = { ...draft, errors: [...draft.errors, { code: 'rows_patch', message: '已审草稿超出本轮owner范围；恢复未受影响目标并重新独审' }] }
        return reusable
      }
      let elaboration = readonlyOwnerRepair ? null : stage<SavedElaboration>(store, operation, attempt, 'elaboration')
      if (elaboration && !elaborationComposedBinding(store, operation, attempt, elaboration, view.composed)) elaboration = null
      if (elaboration) {
        const tagged = elaborationDraftTagged(store, operation, attempt, 'elaboration', elaboration)
        if (partitions || !reusableElaborationCache(elaboration, tagged)) elaboration = null
      }
      if (!elaboration && !refinement && !readonlyOwnerRepair) {
        const selected = readonlyBase ?? latestApprovedElaboration(store, operation, attempt.number)
        const composition = selected && elaborationComposedBinding(store, store.readOperation(selected.operationId), store.readAttempt(selected.attemptId), selected.result, view.composed)
        const tagged = selected && elaborationDraftTagged(store, store.readOperation(selected.operationId), store.readAttempt(selected.attemptId), 'elaboration', selected.result)
        if (selected && composition && !partitions && reusableElaborationCache(selected.result, tagged ?? false)) {
          elaboration = selected.result
          saveStage(store, fence, 'elaboration-provenance', { operationId: operation.id, inputId: operation.input.id, policyDigest: operation.policyDigest, fromOperationId: selected.operationId, fromAttemptId: selected.attemptId, evidenceRef: selected.resultRef, candidateDigest: selected.result.candidateDigest })
          saveStage(store, fence, 'elaboration', selected.result, undefined, composition)
        }
      }
      if (!elaboration) {
        store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
        if (operation.phase === 'analyzing') store.startElaboration(fence)
        let protocol = stage<{ version: 'elaboration-draft-v1' } & Pick<ElaborationInput, 'incrementalDraft' | 'generationGuidance' | 'applicabilityGuidance' | 'reviewItemIdGuidance' | 'compactSealDiagnostics' | 'citationRepairDiagnostics' | 'defaultExportCitation' | 'sharedDraftDiagnostics' | 'draftRepairDisposition' | 'parentInterfaceReview' | 'propagateAuthoredParentScope'>>(store, operation, attempt, 'elaboration-draft-protocol')
        if (!protocol && options.plan.agentWorkflow && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_'))) {
          const approved = reviewContinuation?.elaboration
          const propagateAuthoredParentScope = approved
            ? stage<Pick<ElaborationInput, 'propagateAuthoredParentScope'>>(store, store.readOperation(approved.operationId), store.readAttempt(approved.attemptId), 'elaboration-draft-protocol')?.propagateAuthoredParentScope
            : options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'spec_to_code' ? true : undefined
          protocol = { version: 'elaboration-draft-v1', incrementalDraft: incrementalDraftCommand(), generationGuidance: ELABORATION_GENERATION_GUIDANCE, applicabilityGuidance: 'root-summary-v1', reviewItemIdGuidance: 'contract-item-ids-v1', compactSealDiagnostics: true, citationRepairDiagnostics: 'actionable-v1', defaultExportCitation: true, sharedDraftDiagnostics: true, draftRepairDisposition: true, parentInterfaceReview: 'scope-v2', ...(propagateAuthoredParentScope ? { propagateAuthoredParentScope } : {}) }
          saveStage(store, fence, 'elaboration-draft-protocol', protocol)
        }
        if (protocol && Object.hasOwn(protocol, 'generationGuidance') && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V1 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V2 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V3 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V4 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE) fail('elaboration_generation_guidance_unsupported', '持久P1生成提示版本不受支持；仅字段缺席允许原提示')
        if (protocol?.applicabilityGuidance !== undefined && protocol.applicabilityGuidance !== 'root-summary-v1') fail('elaboration_applicability_guidance_unsupported', '持久P1根级适用性提示版本不受支持')
        if (protocol?.reviewItemIdGuidance !== undefined && protocol.reviewItemIdGuidance !== 'contract-item-ids-v1') fail('elaboration_review_item_id_guidance_unsupported', '持久P1独审条目 ID 提示版本不受支持')
        const draftProtocol = protocol?.version
        const elaborationInput = { ...makeElaborationInput(draftProtocol), incrementalDraft: protocol?.incrementalDraft, generationGuidance: protocol?.generationGuidance, applicabilityGuidance: protocol?.applicabilityGuidance, reviewItemIdGuidance: protocol?.reviewItemIdGuidance, compactSealDiagnostics: protocol?.compactSealDiagnostics, citationRepairDiagnostics: protocol?.citationRepairDiagnostics, defaultExportCitation: protocol?.defaultExportCitation, sharedDraftDiagnostics: protocol?.sharedDraftDiagnostics, draftRepairDisposition: protocol?.draftRepairDisposition, parentInterfaceReview: protocol?.parentInterfaceReview, propagateAuthoredParentScope: protocol?.propagateAuthoredParentScope }
        const loadDraft = draftProtocol ? (schemaDigest: string): ElaborationDraft | null => {
          const draft = loadElaborationDraft('elaboration', undefined, schemaDigest)
          return draft && cacheDraft ? { ...draft, errors: [...draft.errors, ...cacheDraft.errors] } : draft
        } : undefined
        const maxParallel = options.plan.version === 'sync-coordinator-v2' ? options.plan.partitionPolicy.maxParallel : 1
        const previousElaboration = partitions && draftProtocol && maxParallel > 1 && attempt.number > 1
          ? store.listAttempts(operation.id).reverse().find(prior => prior.number < attempt!.number && prior.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_')))
          : undefined
        const serialRetry = previousElaboration?.status === 'superseded' && previousElaboration.failure?.kind === 'repairable'
          && (previousElaboration.failure.serialElaborationRetry || isNativeObservationFailure(previousElaboration.failure))
        let result: ElaborationResult
        try {
          result = partitions ? await elaborateSyncPartitions(elaborationInput, partitions, serialRetry ? 1 : maxParallel, partitionCheckpoints, runner, view.composed) : await elaborate(elaborationInput, { runner, draft: cacheDraft, loadDraft, loadDraftMaterial: draftProtocol ? (schemaDigest, request) => loadElaborationDraftMaterial('elaboration', undefined, schemaDigest, request) : undefined, seed: loadElaborationRepairSeed('elaboration', freezeElaborationInput(elaborationInput).inputDigest) ?? undefined, repairDiagnostics: loadElaborationRepairDiagnostics('elaboration', freezeElaborationInput(elaborationInput).inputDigest) ?? undefined })
        } catch (error) {
          if (!(error instanceof SyncCoordinatorError) || error.code !== 'cross_freeze_impact_review_retry' || signal.aborted) throw error
          store.recordFailure(fence, failure(error.code, error.message, 'repairable', error.evidenceRefs), true)
          continue
        }
        const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = result
        elaboration = compact; saveStage(store, fence, 'elaboration', compact, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined, { composedTree: view.composed.tree, composedContentDigest: view.composed.contentDigest })
      }
      if (!elaboration.structurePassed || !elaboration.reviewPassed) {
        if (['SYNC_BUDGET_EXHAUSTED', 'budget_exhausted'].includes(elaboration.failure?.code ?? '')) throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', elaboration.failure!.message)
        const unsupported = elaboration.status === 'unsupported', stopped = elaboration.status === 'cancelled' || signal.aborted
        const kind: SyncFailure['kind'] = unsupported ? 'unsupported' : elaboration.status === 'conflict' ? 'conflict' : elaboration.status === 'needs_input' ? 'missing_input' : 'repairable'
        const issue = failure(elaboration.failure?.code ?? 'elaboration_failed', elaboration.failure?.message ?? '细化结构或独立评审未通过', kind, [writeEvidence(operation.input.source.commonDir, elaboration)])
        const quotaRef = managedQuotaFailureRef(store, operation, store.readAttempt(attempt.id), elaboration.failure)
        if (quotaRef) issue.evidenceRefs.push(quotaRef)
        if (stopped) fail('cancelled', issue.message, issue.evidenceRefs)
        const failureSources = elaboration.partitionEvidence?.map(owner => JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration) ?? [elaboration]
        const failedAttempt = store.readAttempt(attempt.id)
        requireSettledRpcSources(store, operation, failedAttempt, failureSources, issue.evidenceRefs)
        if (elaboration.failure?.code === 'cancellation_pending') fail('cancellation_pending', issue.message, issue.evidenceRefs)
        if (partitions && options.plan.agentWorkflow && kind === 'repairable' && failureSources.some(source => isNativeObservationFailure(source.failure))) issue.serialElaborationRetry = true
        if (elaboration.failure?.code === 'partition_final_seal_failed') {
          const source = await loadSealRepairSource()
          assertMaterialFence()
          const { attempt: currentAttempt } = store.assertWriteFence(fence)
          const previous = source?.result ?? store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse().map(prior => stage<SavedElaboration>(store, operation, prior, 'elaboration')).find(result => result?.failure?.code === 'partition_final_seal_failed')
          const owners = source ? [...source.owners.keys()] : []
          if (previous?.candidateDigest === elaboration.candidateDigest && canonical(previous.partitionSeal!.findings.filter(finding => finding.severity === 'error')) === canonical(elaboration.partitionSeal!.findings.filter(finding => finding.severity === 'error')) && !currentAttempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_') && (!owners.length || owners.some(owner => dispatch.key.startsWith(`sync:${attempt!.id}:elaborate:partition:${owner}:`))))) fail('partition_final_seal_stalled', '同一全局候选和error没有对应owner新派发，停止缓存重播', issue.evidenceRefs)
        }
        const continueQuotaReview = kind === 'repairable' && failureSources.some(owner => owner.structurePassed && !owner.reviewPassed
          && owner.failure?.code === 'provider_quota_exhausted' && failedAttempt.dispatchPlans.some(dispatch => dispatch.purpose === 'elaboration_review'
            && dispatch.session?.sessionId === owner.failure?.sessionId && managedQuotaDispatch(store, operation, failedAttempt, dispatch.key)))
        store.recordFailure(fence, issue, continueQuotaReview)
        if (kind !== 'repairable') return current(unsupported ? 'unsupported' : undefined, issue)
        seed = elaborationRepairSeed(elaboration, `sync:${attempt.id}:elaborate`)
        continue
      }
      if (reviewContinuation?.elaboration && canonical(elaboration) !== canonical(reviewContinuation.elaboration.result)) fail('review_source_binding', '当前P1重新封口与原候选的实际批准原件不同')
      if (!reviewContinuation && partitions && options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec' && options.plan.agentWorkflow
        && elaboration.gaps.some(gap => gap.gapKind === 'missing_fact' && ['code', 'derived'].includes(gap.source.kind))) {
        const aggregateRef = writeEvidence(operation.input.source.commonDir, elaboration)
        let inspected: { evidence: ElaborationGapReviewEvidence; reviewRef: BlobRef } | null = null
        let previous: { ref: BlobRef; evidence: ElaborationGapReviewEvidence; traces: ElaborationTrace[] } | undefined
        for (const origin of store.listAttempts(operation.id).filter(origin => origin.id === attempt!.id || origin.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(origin.status)).reverse()) {
          const cached = partitionStage<ElaborationGapReviewCheckpoint>(store, operation, origin, 'elaboration-gap-review', undefined, candidateHistoryCheckpoints(origin))
          if (!cached || cached.result.aggregateRef.sha256 !== aggregateRef.sha256) continue
          const source = await replayGapReview(origin)
          if (!source) continue
          if (!source.evidence.review && origin.id !== attempt.id) { previous = { ref: source.reviewRef, evidence: source.evidence, traces: source.reviewTraces }; break }
          inspected = source
          if (origin.id !== attempt.id) saveStage(store, fence, 'elaboration-gap-review-provenance', { fromAttemptId: origin.id, reviewRef: source.reviewRef, aggregateRef })
          break
        }
        if (!inspected) {
          let resultRef: BlobRef | undefined
          const evidence = await inspectPartitionedElaborationGaps(gapInput(store.readAttempt(attempt.id)), partitions, aggregateRef, async request => {
            await gapAggregate(store.readAttempt(attempt!.id), aggregateRef)
            const result = await runner(request)
            assertMaterialFence()
            const origin = store.readAttempt(attempt!.id), resource = store.findResource(origin.id, request.requestKey)
            const injected = !resource ? stage<{ result: ElaborationSessionResult }>(store, operation, origin, `injected:${request.requestKey}`) : null
            resultRef = resource?.checkpointRef ?? (injected ? { sha256: contentHash(JSON.stringify(injected)) } : undefined)
            if (!resultRef) fail('candidate_gap_review_binding', '候选GAP复核没有正式原生结果原件')
            return result
          }, view.composed, previous, partitionCheckpoints)
          if (evidence) {
            const { reviewOutput: _output, review: _review, findings: _findings, ...binding } = evidence
            const checkpoint: ElaborationGapReviewCheckpoint = { ...binding, resultRef: resultRef! }
            inspected = { evidence, reviewRef: saveStage(store, fence, 'elaboration-gap-review', checkpoint, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined) }
          }
        }
        if (inspected) {
          if (!inspected.evidence.review) {
            store.recordFailure(fence, failure('candidate_gap_review_invalid', '候选GAP复核没有通过完整独审协议校验，原批准与GAP保持', 'repairable', [inspected.reviewRef]))
            continue
          }
          if (elaborationGapRepairFindings(inspected.evidence, elaboration).length) {
            store.recordFailure(fence, failure('candidate_gap_repair', '候选GAP需由原owner沿原事实续稿并重新独审', 'repairable', [aggregateRef, inspected.reviewRef]))
            continue
          }
        }
      }
      const acceptedFiles = new Map(view.files)
      seed = undefined; refinement = undefined
      for (const change of elaboration.nodeChanges ?? []) if (change.action === 'retire' || change.from.path !== change.to.path) acceptedFiles.delete(change.from.path)
      for (const change of elaboration.changes) acceptedFiles.set(change.path, change.source)
      const accepted = await readFrozenContracts(operation.input.source.canonicalRoot, acceptedFiles)
      if (partitions) {
        const saved = partitionCheckpoints.load<SyncPartitionPlan>('candidate-partition-plan')
        partitions = saved ?? completeSyncPartitionPlan(partitions, accepted.contracts, acceptedFiles, { writePaths: options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec' ? [] : options.plan.writePaths, readonlyPaths: options.plan.mandatoryTests.map(test => test.testPath) }, analysis)
        if (!saved) partitionCheckpoints.save('candidate-partition-plan', partitions)
      }
      const retiredIds = unique(elaboration.retiredIds.filter(id => !historicalRetiredIds.includes(id)))
      const retirementBefore = await readFrozenContracts(operation.input.source.canonicalRoot, deliveredFiles)
      const changedContractPaths = new Set(elaboration.changes.map(change => change.path))
      const ownedItems = [...accepted.graph.items.values()].filter(item => !operation.baselineSelection || changedContractPaths.has(item.path))
      const retiredFlows = retiredIds.filter(id => retirementBefore.graph.items.get(id)?.kind === 'FLOW')
      const retiredContracts = retiredIds.filter(id => !retiredFlows.includes(id))
      const restoredResourceIds = restored.filter(item => item.item === null || item.item.kind === 'VERIFY').map(item => item.id)
      const scopeIds = unique([...operation.scope.contractIds, ...retiredContracts, ...restoredResourceIds, ...ownedItems.filter(item => item.kind !== 'FLOW' && item.kind !== 'VERIFY').map(item => item.id)])
      const flowIds = unique([...operation.scope.flowIds, ...retiredFlows, ...ownedItems.filter(item => item.kind === 'FLOW').map(item => item.id)])
      const p1Evidence = writeEvidence(operation.input.source.commonDir, elaboration)
      if (!attempt.candidate && (!reviewContinuation || reviewContinuation.operation.id !== operation.id)) {
        const writableReferences = p1WritableReferences(accepted.contracts, changedContractPaths, options.plan)
        const paths = operation.baselineSelection ? unique([...operation.scope.paths, ...elaboration.changes.map(change => change.path), ...(elaboration.nodeChanges ?? []).flatMap(change => change.action === 'retire' ? [change.from.path] : [change.from.path, change.to.path]), ...writableReferences]) : undefined
        if (paths?.some(path => !within(path, options.plan.writePaths) || options.plan.mandatoryTests.some(oracle => overlap(path, oracle.testPath)))) fail('p1_write_scope', '已审细化引用的新增写路径超出冻结授权或涉及外部 oracle')
        operation = store.expandContractScope(fence, { contractIds: scopeIds, flowIds, ...(paths ? { paths } : {}) }, p1Evidence)
        if (operation.baselineSelection) {
          const previousView = view
          view = await readInput(operation.input, options.plan, operation.previousBaselinePair, operation.requestBlob, store.readBusinessBaselineSelection(operation.id), operation.scope.paths)
          store.bindComposedInput(fence, view.composed, { readSetDigest: view.readSetDigest })
          operation = store.readOperation(operation.id); attempt = store.readAttempt(attempt.id)
          if (previousView.composed.contentDigest !== view.composed.contentDigest || analysis && !analysisStageBinding(store, operation, analysis.analysis)) {
            store.recordFailure(fence, failure('scope_context_expanded', '已审作用域引入新的真实上下文，下一原预算尝试重新分析绑定', 'repairable', [p1Evidence]))
            continue
          }
        }
      }
      const behaviorBlocked = new Set(dependencyClosure(accepted.graph, effectiveFindings.flatMap(finding => finding.affectedIds)))
      const behaviorBlockedFlows = new Set([...accepted.graph.items.values()].filter(item => item.kind === 'FLOW' && item.steps.some(id => behaviorBlocked.has(id))).map(item => item.id))
      const ready: SyncScope = { paths: [...operation.scope.paths], contractIds: unique([...retiredContracts, ...restoredResourceIds, ...elaboration.readyIds.filter(id => scopeIds.includes(id) && accepted.graph.items.get(id)?.kind !== 'FLOW' && !behaviorBlocked.has(id))]), flowIds: unique([...retiredFlows, ...elaboration.readyFlowIds.filter(id => flowIds.includes(id) && !behaviorBlockedFlows.has(id))]) }
      const blocked: SyncScope = { paths: [], contractIds: scopeIds.filter(id => !ready.contractIds.includes(id)), flowIds: flowIds.filter(id => !ready.flowIds.includes(id)) }
      const implementationDiagnostics = elaboration.deferredImplementationFindings.filter(item => item.code === 'implementation-review').map(item => ({ code: item.code, message: JSON.stringify(item) }))
      if (implementationDiagnostics.length) repairContext = { previousOutput: repairContext?.previousOutput ?? null, diagnostics: [...(repairContext?.diagnostics ?? []), ...implementationDiagnostics] }
      const blockedReason = effectiveFindings.some(finding => finding.kind === 'conflict') || elaboration.status === 'conflict' ? 'conflicted' : elaboration.status === 'needs_input' || blocked.contractIds.length || blocked.flowIds.length ? 'needs_input' : null
      const unexecutedIds = operation.recordUnverifiedCoverage ? new Set(unexecutedAcceptanceIds(elaboration)) : undefined
      if (!ready.contractIds.some(id => unexecutedIds?.has(id) || accepted.graph.items.get(id)?.kind === 'AC' || retiredIds.includes(id) && retirementBefore.graph.items.get(id)?.kind === 'AC')) {
        const issue = failure('no_ready_acceptance', '业务缺口阻塞全部可执行验收，保留细化证据而不写半成品', blockedReason === 'conflicted' ? 'conflict' : 'missing_input', [p1Evidence])
        store.recordFailure(fence, issue); return current(undefined, issue)
      }
      let generated = stage<SavedGeneration>(store, operation, store.readAttempt(attempt.id), 'generation')
      if (!generated) {
        store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
        if (attempt.candidate) fail('candidate_stage_missing', '已有冻结候选没有完整独立生成证据，不能覆盖或重新生成')
        if (!partitions) store.startGeneration(fence, { readyScope: ready, blockedScope: blocked, blockedReason })
        const allowedGap = new Set([...elaboration.blockedStructureFindings, ...elaboration.rounds.flatMap(round => round.findings.filter(issue => ['unresolved-gap', 'unresolved-conflict'].includes(issue.code) && issue.itemId && accepted.graph.items.get(issue.itemId)?.kind === 'GAP'))].map(findingKey))
        const priorContext: NonNullable<import('./generation-types.js').GenerationInput['priorContext']>[number][] = []
        if (partitions && (retiredIds.length || (elaboration.nodeChanges ?? nodeChanges).length)) {
          const pairs = [...new Map([...(store.readBusinessBaselineSelection(operation.id)?.bindings.flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [pair] : [] }) ?? []), ...operation.previousBaselinePair ? [operation.previousBaselinePair] : []].map(pair => [pair.id, pair])).values()]
          const snapshots = [...new Map([...pairs.flatMap(pair => [{ snapshot: pair.sourceInput, role: 'source_before' as const, pairId: pair.id }, { snapshot: pair.verifiedDelivery, role: 'verified_delivery' as const, pairId: pair.id }]), ...options.plan.version === 'sync-coordinator-v2' && options.plan.commitTrigger?.before ? [{ snapshot: options.plan.commitTrigger.before, role: 'source_before' as const }] : []].map(context => [`${context.role}:${context.snapshot.id}`, context])).values()]
          const obligations = unique(retirementBefore.contracts.filter(contract => retiredIds.some(id => contract.items.some(item => item.id === id)) || (elaboration.nodeChanges ?? nodeChanges).some(change => change.from.path === contract.path)).flatMap(contract => [contract.path, ...contract.code.map(anchor => anchor.split('#')[0]), ...contract.related.map(anchor => anchor.split('#')[0]), ...contract.items.filter(item => item.kind === 'AC').map(item => item.test.split('#')[0]), ...contract.items.flatMap(item => item.kind !== 'VERIFY' && item.source.kind === 'code' ? [item.source.ref.split('#')[0]] : [])]))
          for (const context of snapshots) {
            verifySnapshot(context.snapshot)
            if (context.snapshot.source.commonDir !== operation.input.source.commonDir || context.role === 'source_before' && canonical(context.snapshot.source) !== canonical(operation.input.source)) fail('historical_context_binding', '历史来源不属于同一真实source/commonDir')
            const files = new Map<string, string>(), entries: SnapshotManifest['entries'] = [], objects: NonNullable<import('./generation-types.js').GenerationInput['priorContext']>[number]['objects'][number][] = []
            readTree(operation.input.source.commonDir, context.snapshot.immutableTree, (entry, bytes) => {
              if (isHostPrivatePath(entry.path)) return
              if (!options.plan.agentWorkflow && obligations.some(claim => relationClaimsPath(claim, entry.path)) && !within(entry.path, view.readPaths)) fail('historical_context_binding', `历史义务超出全局读取授权: ${entry.path}`)
              if (!within(entry.path, view.readPaths)) return
              entries.push(entry)
              if (entry.mode === '120000' || !isUtf8Text(bytes)) objects.push({ entry, kind: entry.mode === '120000' ? 'symlink' : 'binary', encoding: 'base64', content: bytes.toString('base64') })
              else files.set(entry.path, bytes.toString('utf8'))
            })
            priorContext.push({ ...context, entries, files, objects })
          }
        }
        const generationInput: import('./generation-types.js').GenerationInput = { ...(options.plan.agentWorkflow ? { nativeWorktree: true } : {}), ...(operation.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), root: operation.input.source.canonicalRoot, requestKey: `sync:${attempt.id}:generation`, snapshot: operation.input, composed: view.composed, manifest: view.manifest, files: view.files, contracts: accepted.contracts, elaboratedSpecs: elaboration.changes.map(change => ({ path: change.path, source: change.source })), readyIds: [...ready.contractIds, ...ready.flowIds].filter(id => !restoredResourceIds.includes(id)), blockedIds: [...blocked.contractIds, ...blocked.flowIds], retiredIds, ...(partitions ? { priorContext, retiredOwners: retiredIds.flatMap(id => { const item = retirementBefore.graph.items.get(id); return item ? [{ id, path: item.path }] : [] }) } : {}), intent: { nodeId: options.plan.intentNodeId, rawSource: (accepted.nodes.find(node => node.id === options.plan.intentNodeId) ?? retirementBefore.nodes.find(node => node.id === options.plan.intentNodeId))!.rawSource! }, facts: behaviorFacts, analysis, nodeChanges: elaboration.nodeChanges ?? nodeChanges, direction: decision && decision.decision.choice !== 'adopt_behavior' ? 'repair_to_intent' : preserveBusiness ? 'preserve_business' : analysis?.analysis.authorChanges?.length && !decision ? 'repair_to_intent' : analysis ? 'preserve_observed_behavior' : undefined, existingAcceptance: retirementBefore.contracts.flatMap(contract => contract.items.filter(item => item.kind === 'AC')), mandatoryTests: options.plan.mandatoryTests, verifications: options.plan.verifications.map(item => item.definition), repairContext, allowedScope: ready, policy: { version: options.plan.version, digest: operation.policyDigest }, timeoutMs: callTimeoutMs, signal, model, effort: 'high' as const }
        if (partitions && options.plan.version === 'sync-coordinator-v2') {
          const { requiredKeys, planningIds } = implementationGenerationDispatch(generationInput, partitions, options.plan.direction === 'code_to_spec')
          const dispatched = new Set(store.readAttempt(attempt.id).dispatchPlans.map(dispatch => dispatch.key))
          const mustRetry = new Set(reviewContinuation?.failedReviewKeys.map(key => `${generationInput.requestKey}:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`))
          const minimumCalls = requiredKeys.filter(key => (!reviewContinuation || mustRetry.has(key)) && !dispatched.has(key)).length, remainingCalls = budget ? budget.maxCalls - store.readBudgetUsage(operation.id).callsUsed : null
          partitionCheckpoints.save('partition-generation-budget', { minimumCalls, remainingCalls, implementationPlanningPartitions: planningIds, requiredKeys })
          if (remainingCalls !== null && minimumCalls > remainingCalls) fail('partition_budget_insufficient', `最终分区及精确文件规划至少还需要 ${minimumCalls} 次调用，剩余 ${remainingCalls} 次；保持原共享预算`, [writeEvidence(operation.input.source.commonDir, { minimumCalls, remainingCalls, requiredKeys })])
        }
        const generationOptions: import('./generation-types.js').GenerationOptions = { runner, protectedReadPaths: view.readPaths, ...(reviewContinuation ? { reviewCandidate: reviewContinuation.generation.candidate!, builderTraces: reviewContinuation.generation.traces.filter(trace => trace.purpose !== 'code_review') } : {}), ...(partitions ? { implementationPolicy: { writePaths: options.plan.writePaths, sourcePaths: options.plan.sourcePaths ?? [] }, beforePartitionGeneration: async (paths: readonly string[], evidenceRef: BlobRef) => {
          if (paths.some(path => !within(path, options.plan.writePaths) || options.plan.mandatoryTests.some(test => overlap(path, test.testPath)))) fail('implementation_plan_scope', '明确实现文件计划越过冻结授权或独立oracle')
          const additions = paths.filter(path => !within(path, operation.scope.paths))
          if (additions.length) {
            operation = store.expandContractScope(fence!, { paths: unique([...operation.scope.paths, ...additions]), contractIds: operation.scope.contractIds, flowIds: operation.scope.flowIds }, evidenceRef)
            const previousView = view
            view = await readInput(operation.input, options.plan, operation.previousBaselinePair, operation.requestBlob, store.readBusinessBaselineSelection(operation.id), operation.scope.paths)
            if (view.composed.contentDigest !== previousView.composed.contentDigest) fail('implementation_plan_context_changed', '实现文件规划引入了尚未独审的真实上下文')
            store.bindComposedInput(fence!, view.composed, { readSetDigest: view.readSetDigest })
            operation = store.readOperation(operation.id)
          }
          ready.paths = [...operation.scope.paths]
          if (store.readOperation(operation.id).phase !== 'generating') store.startGeneration(fence!, { readyScope: ready, blockedScope: blocked, blockedReason })
          return { scope: ready, composed: view.composed }
        } } : {}), ...(operation.baselineSelection ? { beforeFreezeCandidate: async () => {
          for (;;) {
            await acquirePublication()
            try {
              const latest = store.readOperation(operation.id), currentAttempt = store.readAttempt(fence!.attemptId)
              const inherited = operation.inheritRetryBudget && reviewContinuation
              if (inherited && !inherited.attempt.publicationBase) fail('review_handoff_binding', '候选交接缺少原发布parent及完整来源原件')
              const original = inherited ? verifyPublicationBase(store, inherited.operation, inherited.attempt, inherited.attempt.publicationBase!) : undefined
              const base = assemblePublicationBase(store, latest, currentAttempt, view.composed, view.readPaths, original)
              if (original) {
                const { operationId: _currentOperation, attemptId: _currentAttempt, parentCommit: _currentMetadata, ...current } = verifyPublicationBase(store, latest, currentAttempt, base)
                const { operationId: _originalOperation, attemptId: _originalAttempt, parentCommit: _originalMetadata, ...previous } = original
                if (canonical(current) !== canonical(previous) || (original.version === 'sync-publication-base-v2' || original.parentCommit === operation.input.headCommit) && base.parentCommit !== original.parentCommit) fail('review_handoff_binding', '候选交接的原发布parent、tree或逐路径来源已变化')
              }
              const bound = store.bindPublicationBase(fence!, base)
              saveStage(store, fence!, 'publication-base', base)
              return bound.publicationBase!.composed
  } catch (error) {
    releasePublication()
              if (!(error instanceof SyncStoreError) || error.code !== 'SYNC_PUBLICATION_BUSY' && !(error.code === 'SYNC_PUBLICATION_BASE_STALE' && !store.readAttempt(fence!.attemptId).publicationBase)) throw error
              await waitForPublication(25, undefined, { signal })
            }
          }
        } } : {}), validateCandidate: async candidate => {
          if (reviewContinuation && partitions && options.plan.version === 'sync-coordinator-v2' && options.plan.direction !== 'code_to_spec') {
            const source = reviewContinuation, writers = JSON.parse(readEvidence(operation.input.source.commonDir, source.generation.fileWriterPlanRef!).toString()) as FileWriterPlan
            const sourcePlan = { ...partitions, partitions: partitions.partitions.map(partition => { const paths = writers.writers.find(writer => writer.partitionId === partition.id)?.paths ?? []; return { ...partition, readPaths: unique([...partition.readPaths, ...paths]), writePaths: unique([...partition.writePaths, ...paths]) } }) }
            const currentInput = generationInput.nativeWorktree ? { ...generationInput, stageTree: generationStageTree(generationInput) } : generationInput
            for (const local of implementationGenerationDispatch(currentInput, sourcePlan, false).locals) {
              store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs)
              const builder = generationBuilderSource(store, operation, source.attempt, `partition:${local.partition.id}:generation`, candidate, source.plan), prior = builder.result
              if (prior.status !== 'prepared' || prior.failure || prior.traces.length !== 1 || !prior.preparedChanges) fail('review_source_binding', '原候选缺少对应builder真实prepared原件')
              const localInput = { ...local.input, requestKey: `sync:${builder.attempt.id}:generation:partition:${local.partition.id}` }
              const replay = await runGeneration(localInput, { prepareOnly: true, validateCandidate: async () => [], runner: async request => {
                const result = completedNativeStageResult(store, operation, builder.attempt, request, prior.traces[0], prior.output, candidate.digest)
                if (!result) fail('review_source_binding', '原builder Native/完整请求身份已改变')
                return result
              } })
              if (replay.status !== 'prepared' || !replay.preparedChanges || replay.inputDigest !== prior.inputDigest || canonical(replay.preparedChanges) !== canonical(prior.preparedChanges) || replay.preparedChanges.changes.some(change => !within(change.path, localInput.allowedScope.paths) || change.path.startsWith('.spec/') && !localInput.elaboratedSpecs.some(spec => spec.path === change.path) && !localInput.nodeChanges?.some(item => item.from.path === change.path || item.action === 'move' && item.to.path === change.path))) fail('review_source_binding', '原builder实际Git/schema/范围或prepared变化不匹配当前冻结输入')
            }
            await yieldToControl(); store.renewLease(fence!, leaseMs)
          }
          const frozen = await candidateContext(store, operation, candidate, elaboration)
          const inheritedGapFindings = new Set<string>()
          if (elaboration.partitionSeal?.passed) {
            const commonDir = operation.input.source.commonDir, base = readTree(commonDir, candidate.baseTree), entries = verifyCandidate(commonDir, candidate)
            const composedEntries = new Map(view.manifest.entries.map(entry => [entry.path, entry])), baseEntries = new Map(base.map(entry => [entry.path, entry])), candidateEntries = new Map(entries.map(entry => [entry.path, entry]))
            const inventory = unique([...composedEntries.keys(), ...baseEntries.keys(), ...candidateEntries.keys()])
            const readyIds = new Set([...ready.contractIds, ...ready.flowIds, ...ready.flowIds.flatMap(id => { const flow = frozen.graph.items.get(id); return flow?.kind === 'FLOW' ? flow.steps : [] })])
            const gaps = frozen.coverage.gaps.filter(gap => {
              const item = frozen.graph.items.get(gap.id)!, approved = elaboration.gaps.find(item => item.id === gap.id)
              if (!approved || !sameContractBusinessMeaning(approved, item) || [gap.id, ...gap.affectedIds].some(id => readyIds.has(id))) return false
              const owners = [gap.id, ...gap.affectedIds].map(id => frozen.graph.owners.get(id))
              if (owners.some(owner => !owner || accepted.nodes.some(node => node.path === owner.path))) return false
              return unique(owners.map(owner => owner!.path)).flatMap(path => obligationPaths(frozen.files.get(path)!, path, inventory, true)).every(path => canonical(composedEntries.get(path)) === canonical(baseEntries.get(path)) && canonical(baseEntries.get(path)) === canonical(candidateEntries.get(path)))
            })
            const coverage = { ...frozen.coverage, gaps }
            for (const issue of elaboration.partitionSeal.findings) if (issue.severity === 'error' && (['unresolved-gap', 'unresolved-conflict'].includes(issue.code) ? gaps.some(gap => gap.id === issue.itemId) : gapBlockedFinding(issue, coverage))) inheritedGapFindings.add(findingKey(issue))
          }
          const findings = frozen.findings.filter(issue => !(allowedGap.has(findingKey(issue)) && (!issue.itemId || blocked.contractIds.includes(issue.itemId) || blocked.flowIds.includes(issue.itemId))) && !inheritedGapFindings.has(findingKey(issue)))
          for (const gap of [...accepted.graph.items.values()].filter(item => item.kind === 'GAP')) {
            const next = frozen.graph.items.get(gap.id)
            const meaning = (item: typeof gap): unknown => ({ id: item.id, kind: item.kind, gapKind: item.gapKind, unknown: item.unknown, affects: item.affects, evidence: item.evidence, decision: item.decision, source: item.source, dependsOn: item.dependsOn })
            if (next?.kind !== 'GAP' || canonical(meaning(gap)) !== canonical(meaning(next))) findings.push({ code: 'generation-gap-changed', severity: 'error', path: gap.path, nodeId: gap.nodeId, itemId: gap.id, message: '生成阶段不能删除或改变已独立审查GAP及其精确阻塞范围' })
          }
          findings.push(...await checkCandidateContractIntent(operation, candidate, accepted, frozen, { newNodeRawSources: new Map([...(options.plan.newNodeRawSources ?? []), ...(analysis?.analysis.newNodes ?? [])].map(item => [item.path, item.rawSource])), verifications: options.plan.verifications.map(item => item.definition) }))
          for (const oracle of options.plan.mandatoryTests) if (frozen.files.get(oracle.testPath) !== view.files.get(oracle.testPath)) findings.push({ code: 'oracle_changed', severity: 'error', path: oracle.testPath, nodeId: options.plan.intentNodeId, message: '独立测试义务不得由模型改写' })
          return findings
        } }; const result = partitions ? await generateSyncPartitions(generationInput, partitions, options.plan.version === 'sync-coordinator-v2' ? options.plan.partitionPolicy.maxParallel : 1, options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec', generationOptions, partitionCheckpoints) : await runGeneration(generationInput, generationOptions)
        const { candidateFiles: _files, ...compact } = result
        generated = { ...compact, ...(partitions ? { p2SpecWritePaths: implementationGenerationDispatch(generationInput, partitions, options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec').specWritePaths } : {}) }; saveStage(store, fence, 'generation', generated)
      }
      if (generated.status !== 'reviewed' || !generated.candidate || !generated.candidateValidated || !generated.reviewPassed) {
        if (readonlyOwnerRepair && readonlySpecRepairStalled({ ...readonlyOwnerRepair, owners: readonlyActiveOwners, findings: readonlyOwnerRepair.allFindings }, generated.candidate?.digest, readonlyOwnerRepair.kind === 'candidate_review' && generated.status === 'repair' && generated.candidateValidated && !generated.failure ? readonlyReviewFindings(generated, elaboration.changes, generated.p2SpecWritePaths ?? []) : generated.validationFindings, store.readAttempt(attempt.id))) fail('readonly_spec_repair_stalled', '相同只读候选及V1失败没有对应owner的新Agent派发，停止零调用热重试', [readonlyOwnerRepair.generationRef])
        if (generated.failure?.code === 'SYNC_BUDGET_EXHAUSTED') throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', generated.failure.message)
        const oracleFindings = generated.review?.findings.filter(finding => finding.ruleLocation.startsWith('oracle-policy:')) ?? []
        const oracleErrors: string[] = [], oracleConflicts: unknown[] = []
        for (const finding of oracleFindings) {
          const source = finding.ruleLocation.slice('oracle-policy:'.length)
          const authorities = analysis?.analysis.decisionAuthorities?.filter(authority => authority.requestRef.sha256 === operation.requestBlob?.sha256 && source === `decision:${authority.stableDecisionId}`) ?? []
          const oracles = options.plan.mandatoryTests.filter(test => finding.codeLocation === `${test.testPath}#${test.testId}`)
          if (!decision || generated.review?.verdict !== 'needs_input' || finding.kind !== 'missing_fact' || authorities.length !== 1 || authorities[0].decision.choice === 'keep_intent' || oracles.length !== 1) { oracleErrors.push('oracle发现没有当前adopt/new_rule及精确不可变mandatory绑定'); continue }
          const authority = authorities[0], oracle = oracles[0], verification = options.plan.verifications.find(item => item.definition.id === oracle.verificationId)!
          oracleErrors.push(...decisionAuthorizationErrors(source, finding.affectedIds, retirementBefore, { analysis, decisionAuthorities: [authority] }))
          const ruleIds = finding.affectedIds.filter(id => {
            const before = retirementBefore.graph.items.get(id), after = accepted.graph.items.get(id)
            return before && after && ['RULE', 'TR'].includes(before.kind) && before.kind === after.kind && !sameContractBusinessMeaning(before, after)
          })
          if (!ruleIds.length) oracleErrors.push('oracle发现没有真实变更的适用RULE/TR')
          oracleConflicts.push({ decisionRef: authority.requestRef, stableDecisionId: authority.stableDecisionId, decision: authority.decision, ruleIds, verification: verification.definition, testPath: oracle.testPath, testId: oracle.testId, oracleDigest: contentHash(view.files.get(oracle.testPath)!), evidence: finding.evidence, counterexample: finding.counterexample, message: finding.message })
        }
        const oracleFailure = oracleErrors.length ? { code: 'review_invalid', message: JSON.stringify({ errors: oracleErrors, review: generated.review }) } : oracleConflicts.length ? { code: 'oracle_policy_conflict', message: JSON.stringify({ requiredAction: '由可信owner发布与所选新意图相容的oracle版本；当前oracle/固定命令仍有效且未通过，不得改回旧意图或自免检', conflicts: oracleConflicts, findings: generated.review!.findings }) } : null
        const kind: SyncFailure['kind'] = oracleErrors.length ? 'repairable' : generated.status === 'needs_input' ? 'missing_input' : generated.status === 'conflict' ? 'conflict' : generated.status === 'unsupported' || generated.failure?.code === 'input_invalid' ? 'unsupported' : 'repairable'
        const issue = failure(oracleFailure?.code ?? generated.failure?.code ?? 'generation_failed', oracleFailure?.message ?? generated.failure?.message ?? '实现候选或独立评审未通过', kind, [writeEvidence(operation.input.source.commonDir, generated)])
        const quotaRef = !oracleFailure && managedQuotaFailureRef(store, operation, store.readAttempt(attempt.id), generated.failure)
        if (quotaRef) issue.evidenceRefs.push(quotaRef)
        if (signal.aborted || generated.status === 'cancelled') fail('cancelled', issue.message, issue.evidenceRefs)
        const finishedAttempt = store.readAttempt(attempt.id), localResults: GenerationResult[] = []
        if (partitions) {
          const checkpoints = readSyncCheckpointStageIndex(store, operation, finishedAttempt)
          const keys = new Set(checkpoints.json.flatMap(({ value }) => {
            const key = (value as Stage).stage
            return key?.startsWith('partition:') && (key.endsWith(':generation') || key.endsWith(':candidate-review')) ? [key] : []
          }))
          const business = operation.baselineSelection ? store.readBusinessBaselineSelection(operation.id)! : undefined
          const selections = new Map<string, boolean>()
          const selectionCheck = business ? {
            expectedRef: writeEvidence(operation.input.source.commonDir, business),
            matches: (wrapper: Stage) => {
              const key = JSON.stringify([wrapper.readSetDigest, wrapper.baselineSelectionRef?.sha256])
              if (!selections.has(key)) selections.set(key, stageSelectionMatches(store, operation, wrapper, business))
              return selections.get(key)!
            },
          } : undefined
          for (const key of keys) {
            const source = partitionStage<GenerationResult>(store, operation, finishedAttempt, key, undefined, checkpoints, selectionCheck)
            if (source) localResults.push(source.result)
            await yieldToControl()
            if (signal.aborted) fail('cancelled', issue.message, issue.evidenceRefs)
          }
        }
        requireSettledRpcSources(store, operation, finishedAttempt, [generated, ...localResults], issue.evidenceRefs)
        if (generated.failure?.code === 'cancellation_pending') fail('cancellation_pending', issue.message, issue.evidenceRefs)
        if (kind === 'repairable' && generated.candidate && !nodeChanges.length) {
          const findings = generated.partitionEvidence ? generated.partitionEvidence.filter(item => item.review.verdict === 'repair').flatMap(item => item.review.findings) : generated.review?.verdict === 'repair' ? generated.review.findings : []
          const omissions = findings.filter(finding => contractOmissionBound(finding, accepted.contracts))
          const ownerRepair = partitions && generated.p2SpecWritePaths && omissions.every(finding => !within(finding.ruleLocation.slice('contract-omission:'.length).split('#')[0], generated.p2SpecWritePaths!))
          if (omissions.length && !ownerRepair) { refinement = { prior: elaboration, candidate: generated.candidate, candidateDigest: generated.candidate.digest, diagnostics: omissions.map(finding => ({ code: 'contract_boundary_omission', message: JSON.stringify(finding) })) }; saveStage(store, fence, 'refinement', refinement) }
        }
        store.recordFailure(fence, issue)
        if (kind !== 'repairable') return current(kind === 'unsupported' ? 'unsupported' : undefined, issue)
        repairContext = generationRepairInput(generated); continue
      }
      const delivered = await verifyAndDeliver(attempt, generated, elaboration, ready, retirementBefore, retiredIds, view, partitions, analysis, restorations, !!decision)
      if (delivered) return delivered
    }
  } catch (error) {
    if (options.recoveryOnly) return current('recovery_required', failure(error instanceof SyncCoordinatorError ? error.code : 'resource_recovery', error instanceof Error ? error.message : String(error), 'environment', error instanceof SyncCoordinatorError ? error.evidenceRefs : []))
    operation = store.readOperation(operationId)
    if (physicallyPaused()) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      if (store.listJournals(operationId).some(journal => journal.status !== 'settled')) return current('recovery_required')
      return current('paused')
    }
    if (operation.phase === 'recovery_required') return current('recovery_required', operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId).failure ?? undefined : undefined)
    if (error instanceof SyncCoordinatorError && error.code === 'resource_recovery') return current('recovery_required', { code: error.code, message: error.message, kind: 'environment', evidenceRefs: error.evidenceRefs })
    if (operation.control !== 'run' || signal.aborted) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      if (heartbeatFailure && operation.control === 'run') return current('recovery_required', heartbeatFailure)
      if (operation.control === 'run' && syncDeadlineExpired(operation.deadlineAtMs)) { store.recordBudgetExhaustion(operationId); return current() }
      if (operation.control === 'run') store.requestControl(operation.id, 'pause')
      return current()
    }
    const code = error instanceof SyncCoordinatorError || error instanceof SyncStoreError ? error.code : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'coordinator_failed'
    const refs = error instanceof SyncCoordinatorError ? [...error.evidenceRefs] : []
    const quotaRef = fence && code === 'provider_quota_exhausted' && error instanceof StructuredSessionError
      ? managedQuotaFailureRef(store, operation, store.readAttempt(fence.attemptId), error) : undefined
    if (quotaRef) refs.push(quotaRef)
    const settledRpc = !!fence && !signal.aborted && hasSettledNativeRpcFailure(store, operation, store.readAttempt(fence.attemptId), error as StructuredSessionError)
    const kind: SyncFailure['kind'] = settledRpc || code === 'cross_freeze_impact_review_retry' ? 'repairable' : code === 'SYNC_BUDGET_EXHAUSTED' ? 'budget' : ['input_changed', 'policy_changed', 'readset_changed', 'composition_conflict', 'request_conflict'].includes(code) ? 'conflict' : code === 'missing_intent' || code === 'no_ready_acceptance' ? 'missing_input' : code === 'export_recovery' || code === 'candidate_stage_missing' ? 'environment' : 'unsupported'
    const issue = failure(code, statusOnlyAnalysisFailure !== undefined && statusOnlyAnalysisFailure === error ? CODE_BEHAVIOR_FAILURE_STATUS : error instanceof Error ? error.message : String(error), kind, refs)
    if (code === 'SYNC_FENCE_EXPIRED') return current('recovery_required', issue)
    if (code === 'SYNC_BUDGET_EXHAUSTED') { store.recordBudgetExhaustion(operationId); return current(undefined, issue) }
    if (fence && operation.currentAttemptId === fence.attemptId && !['failed', 'superseded', 'settled'].includes(store.readAttempt(fence.attemptId).status)) {
      const attempt = store.readAttempt(fence.attemptId)
      if (attempt.expiresAtMs <= Date.now() && attempt.status !== 'applying') return current('recovery_required', issue)
      store.recordFailure(fence, issue)
    }
    return current(['export_recovery', 'candidate_stage_missing', 'cancellation_pending'].includes(code) || code === 'native_rpc_timeout' && !settledRpc ? 'recovery_required' : issue.kind === 'unsupported' ? 'unsupported' : undefined, issue)
  } finally { if (timer) clearInterval(timer); releasePublication(); mutex.release() }
}
