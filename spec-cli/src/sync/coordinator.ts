import { ELABORATION_BOUNDARIES, ELABORATION_GENERATION_GUIDANCE, ELABORATION_GENERATION_GUIDANCE_V1, ELABORATION_GENERATION_GUIDANCE_V2, ELABORATION_GENERATION_GUIDANCE_V3, ELABORATION_GENERATION_GUIDANCE_V4, partitionedElaborationCoverageMatches, type AnalysisOnlyPartitionEvidence, type ElaborationGenerationGuidance } from './elaboration-types.js'
import { finiteSyncBudget, syncDeadlineExpired } from './budget.js'
import { assertWorktreeSyncModel, syncModel, syncModelBinding } from './model-selection.js'
import { setImmediate as yieldToControl, setTimeout as waitForPublication } from 'node:timers/promises'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dependencyClosure, parseContract, parseParts } from '@spexcode/spec-core/contracts'
import { parseCodeEntry, relationClaimsPath } from '@spexcode/spec-core'
import type { Contract, ContractFinding } from '@spexcode/spec-core/contracts'
import { candidateReviewError, candidateReviewLocationError } from './candidate-review.js'
import { actualTreeDiff, exportCandidate, isHostPrivatePath, verifyCandidate } from './candidate.js'
import type { CodeBehaviorContinuation, CodeBehaviorMaterialRequest, CodeBehaviorPostGateReview } from './code-behavior.js'
import { analyzeCodeBehavior, authoredContractChanges, CODE_BEHAVIOR_FAILURE_STATUS, CODE_BEHAVIOR_GUIDANCE_VERSION, codeBehaviorReviewSchema, codeBehaviorContinuationStatus, codeBehaviorDraftStatus, deriveBehaviorAuthorization, isCodeBehaviorContextTransport, readCodeBehaviorContext, type CodeBehaviorContextTransport, type CodeBehaviorReviewReference } from './code-behavior.js'
import type { CodeBehaviorAnalysis, CodeBehaviorEvidence, SyncDecisionInput } from './writeback-types.js'
import { adoptedDeliveryPaths, baselineResourceKey, extendsWithUninitializedResources, isUtf8Text, readCompositionEvidence, selectedRetiredIds, verifyBaselineSelection } from './composition.js'
import { readHistoryRequest, readReceiptHistoryRestorations } from './history-input.js'
import { composeAuthoredInput } from './author-input.js'
import { elaborate, hasApprovedElaborationReview, elaborationMaterialContext, freezeElaborationInput, gapBlockedFinding, verifyElaborationDraftCache } from './elaboration.js'
import { outputErrors } from './elaboration-schema.js'
import type { ElaborationResult, ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult, ElaborationTrace, ElaborationRepairSeed, ElaborationRepairDiagnostics, ElaborationDraft, ElaborationDraftMaterial, ReadonlySpecRepair } from './elaboration-types.js'
import { claimFileMutex } from './file-mutex.js'
import { authenticateNativeFailure, authenticateNativeRejectedFinal, readSyncCheckpoints, readSyncCheckpointStageIndex, retryOperationLineage, syncCheckpointArtifacts, withCheckpointStageBasis } from './checkpoint-evidence.js'
import type { SyncCheckpointStageView } from './checkpoint-evidence.js'
import type { FileMutex } from './file-mutex.js'
import { checkGenerationContractIntent, isSyncSpecPath, readFrozenContracts } from './frozen-contracts.js'
import { decisionAuthorizationErrors, sameContractBusinessMeaning } from './contract-evolution.js'
import type { FrozenContracts, GenerationContractPolicy } from './frozen-contracts.js'
import { implementationGenerationDispatch, completeSyncPartitionPlan, analyzeSyncPartitions, elaborateSyncPartitions, generateSyncPartitions, partitionSealRepairOwners, analysisOnlyPartitionEvidence, IMPLEMENTATION_PLAN_SCHEMA } from './partition-execution.js'
import type { FileWriterPlan, PartitionCheckpoints, PartitionAnalysisFailure, PartitionAnalysisFailures } from './partition-execution.js'
import { planSyncPartitions } from './partitioning.js'
import type { SyncPartitionPlan } from './partitioning.js'
import { contractOmissionBound, freezeGenerationInput, generationReviewRequest, generationStageTree, restoreGenerationInput, reviewError, verifyGenerationReviewDraft, runGeneration } from './generation.js'
import type { GenerationFinding, GenerationInput, GenerationResult } from './generation-types.js'
import { captureStageDraft, readStageDraft, readStoppedPhysicalDraft, stageWorktree, StoppedPhysicalDraftStatusError, type StageDraftMaterialRequest } from './stage-worktree.js'
import { createAttemptRunner, hasSettledNativeRpcFailure, hasSettledNativeTurnTransportFailure, pinSyncNativeRequest } from './native-run.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import type { AdmitSyncInput, ApplyReceipt, BlobRef, CandidateRef, ComposedInputRef, FrozenBaselineSelection, InputSnapshot, SyncAttempt, SyncFailure, SyncOperation, SyncScope, SyncResourceRecord, VerificationResultBlob, WriteFence } from './operation-types.js'
import { deliverVerifiedAttempt, planPrivateDelivery } from './private-delivery.js'
import { assemblePublicationBase, verifyPublicationBase } from './publication-base.js'
import { obligationPaths, ownedObligationPaths } from './prior-context.js'
import { composeControlledRequest, readControlledChanges, readControlledDecision } from './request-input.js'
import { sessionIdForCreateKey, withArchivedStructuredWorktree } from '../sessions.js'
import { withoutSessionApplicationExecutionWake } from '../session-application.js'
import { assertFrozenBinding, readFrozenManifest, readFrozenRange } from '../frozen-context.js'
import { assertClaudeStoppedDraftSource, observeClaudeStoppedWorktreeFailure } from '../claude-structured.js'
import { assertZCodeStoppedDraftSource, isZCodeEventsRpcTimeout, type ZCodeStructuredExecution } from '../zcode-structured.js'
import { NATIVE_PERIODIC_OBSERVATION_FAILURE, NATIVE_PROCESS_OBSERVATION_PENDING, nativeWorktreePrompt, nativeWorktreeResult } from '../native-worktree-runtime.js'
import { readRecord } from '../session-record.js'
import { structuredExecutionPolicy, StructuredSessionError } from '../session-structured-policy.js'
import { SettledSessionCreateTimeoutError } from '../session-structured.js'
import { canonicalSnapshotSource, captureInputSnapshot, contentHash, identifyRawWorktree, objectGit, readEvidence, readObject, readTree, validateRepositoryPath, verifySnapshot, visitObjectBatch, writeEvidence } from './snapshot.js'
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
const behaviorAnalysisRepairCodes = new Set(['behavior_analysis_invalid', 'behavior_review_failed', 'behavior_output_json', 'behavior_output_schema'])
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
  return { ...syncModelBinding(options.model), ingressKey: options.ingressKey, rootCauseId: options.rootCauseId, origin: options.origin, budget: options.budget, input, ...(options.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), ...(options.requestBlob ? { requestBlob: options.requestBlob } : {}), ...(options.retryOf ? { retryOf: options.retryOf } : {}), ...(options.baselineSelection ? { baselineSelection: options.baselineSelection } : {}), planBlob: freezeSyncPlanEvidence(input.source.commonDir, plan), scope, policyDigest: syncPlanDigest(plan), impactDigest: options.impactDigest ?? contentHash(canonical({ targets: plan.targets, ...(plan.executionScope ? { scope } : {}), writePaths: unique(plan.writePaths), readSetDigest: view.readSetDigest })), readSetDigest: view.readSetDigest, delivery: null, deliveryPlan: planPrivateDelivery(input, options.managedRoot, options.ingressKey), previousBaselinePair: options.previousBaselinePair ?? null }
}

type Stage = { version: 'sync-stage-v1'; operationId: string; attemptId: string; inputId: string; policyDigest: string; readSetDigest?: string; baselineSelectionRef?: BlobRef; guidanceContractVersion?: string; composedTree?: string; composedContentDigest?: string; stage: string; resultRef: BlobRef }
const behaviorAnalysisStage = (name: string): boolean => name === 'analysis' || name.startsWith('partition:') && name.endsWith(':analysis')
type SavedElaboration = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
type SavedGeneration = Omit<GenerationResult, 'candidateFiles'> & { p2SpecWritePaths?: string[] }
function stageSelectionMatches(store: SyncStore, operation: SyncOperation, saved: Stage): boolean {
  if (!operation.baselineSelection) return true
  if (!saved.baselineSelectionRef || !saved.readSetDigest) return false
  const selected = JSON.parse(readEvidence(operation.input.source.commonDir, saved.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
  verifyBaselineSelection(operation.input, selected)
  const business = store.readBusinessBaselineSelection(operation.id)!
  return selected.digest === business.digest
    ? saved.readSetDigest === operation.readSetDigest
    : extendsWithUninitializedResources(selected, business)
}
/** P1扩域与续审共用已审映射投影；related/source不产生实现写权。 */
function p1WritableReferences(contracts: readonly Contract[], changedPaths: ReadonlySet<string>, plan: SyncCoordinatorPlan): string[] {
  return contracts.filter(contract => changedPaths.has(contract.path)).flatMap(contract => [...contract.code.map(anchor => anchor.split('#')[0]), ...contract.items.filter(item => item.kind === 'AC').map(item => item.test.split('#')[0])]).filter(path => within(path, plan.writePaths) && !plan.mandatoryTests.some(oracle => overlap(path, oracle.testPath)))
}

function generationRepairInput(previous: SavedGeneration, issue?: SyncFailure): { previousOutput: unknown; diagnostics: { code: string; message: string }[] } {
  return { previousOutput: previous.output, diagnostics: [...(issue ? [{ code: issue.code, message: issue.message }] : []), ...previous.validationFindings.map(item => ({ code: item.code, message: item.message })), ...(previous.review?.findings.map(item => ({ code: item.kind, message: JSON.stringify(item) })) ?? [])] }
}
type Refinement = { prior: SavedElaboration; candidate: CandidateRef; candidateDigest: string; diagnostics: { code: string; message: string }[] }
type ReadonlyOwnerRepair = { kind?: 'candidate_review'; reviewEvidence?: { partitionId: string; resultRef: BlobRef }[]; fromAttemptId: string; generationRef: BlobRef; priorRef: BlobRef; planAttemptId: string; planRef: BlobRef; candidateDigest: string; findings: ContractFinding[]; allFindings: ContractFinding[]; owners: { key: string; partitionId: string; fromAttemptId: string; resultRef: BlobRef }[] }
/** 只阻止没有对应owner派发的同产物热循环；真实Agent尝试次数不受此门限制。 */
export function readonlySpecRepairStalled(repair: Pick<ReadonlyOwnerRepair, 'candidateDigest' | 'findings' | 'owners'>, candidateDigest: string | undefined, findings: readonly ContractFinding[], attempt: Pick<SyncAttempt, 'id' | 'dispatchPlans'>): boolean {
  return candidateDigest === repair.candidateDigest && canonical(findings.filter(item => item.severity === 'error')) === canonical(repair.findings) && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_') && repair.owners.some(owner => dispatch.key.startsWith(`sync:${attempt.id}:elaborate:partition:${owner.partitionId}:`)))
}
function stage<T>(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, name: string, usage: 'automatic' | 'evidence' = 'automatic', checkpoints: SyncCheckpointStageView = readSyncCheckpoints(store, operation, attempt)): T | null {
  for (const { value: entry } of checkpoints.json) {
    const value = entry as Partial<Stage>
    if (value.version !== 'sync-stage-v1' || value.stage !== name) continue
    if (value.operationId !== operation.id || value.attemptId !== attempt.id || value.inputId !== operation.input.id || value.policyDigest !== operation.policyDigest || !value.resultRef) fail('stage_binding', '持久阶段身份不一致')
    if (!stageSelectionMatches(store, operation, value as Stage)) continue
    if (usage === 'automatic' && behaviorAnalysisStage(name) && value.guidanceContractVersion !== CODE_BEHAVIOR_GUIDANCE_VERSION) return null
    if (checkpoints.raw.has(value.resultRef.sha256)) fail('stage_binding', '不可信拒稿不能成为阶段结果')
    const result = checkpoints.json.find(entry => entry.ref.sha256 === value.resultRef!.sha256)
    return result ? result.value as T : JSON.parse(readEvidence(operation.input.source.commonDir, value.resultRef).toString('utf8')) as T
  }
  return null
}
type ReadonlyRepairBinding = { readonlyOwnerRepair?: ReadonlyOwnerRepair; readonlyBaseRef?: BlobRef }
/** pending可以结束，已审返修的原始因果仍由同attempt最近完整原件负责。 */
function readonlyRepairBinding(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt): ReadonlyRepairBinding | null {
  const checkpoints = readSyncCheckpoints(store, operation, attempt)
  for (const entry of checkpoints.json.filter(({ value }) => (value as Partial<Stage>).stage === 'repair-input')) {
    const input = stage<ReadonlyRepairBinding>(store, operation, attempt, 'repair-input', 'evidence', { ...checkpoints, json: [entry] })
    if (input?.readonlyOwnerRepair) return { readonlyOwnerRepair: input.readonlyOwnerRepair, ...(input.readonlyBaseRef ? { readonlyBaseRef: input.readonlyBaseRef } : {}) }
  }
  return null
}
type ElaborationComposedBinding = { composedTree: string; composedContentDigest: string }
function elaborationComposedBinding(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, result: SavedElaboration, composed: ComposedInputRef, checkpoints: SyncCheckpointStageView = readSyncCheckpoints(store, operation, attempt)): ElaborationComposedBinding | null {
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

function partitionStage<T>(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, sourceSelection?: FrozenBaselineSelection, checkpoints: SyncCheckpointStageView = readSyncCheckpoints(store, operation, attempt)): { result: T; resultRef: BlobRef } | null {
  const result = stage<T>(store, operation, attempt, key, 'automatic', checkpoints)
  if (!result) return null
  const resultRef = writeEvidence(operation.input.source.commonDir, result)
  const original = checkpoints.json.map(({ value }) => value as Partial<Stage>)
    .find(value => value.version === 'sync-stage-v1' && value.stage === key && value.operationId === operation.id && value.attemptId === attempt.id && value.inputId === operation.input.id && value.policyDigest === operation.policyDigest && value.resultRef?.sha256 === resultRef.sha256)
  if (original?.readSetDigest !== operation.readSetDigest || operation.baselineSelection && original.baselineSelectionRef?.sha256 !== writeEvidence(operation.input.source.commonDir, sourceSelection ?? store.readBusinessBaselineSelection(operation.id)).sha256) return null
  return { result, resultRef }
}

/** 续修材料仍然未批准；原stage和Native身份由所属operation认证。 */
function retryDraftSources(store: SyncStore, operation: SyncOperation, attemptNumber: number): { owner: SyncOperation; prior: SyncAttempt }[] {
  const sources: { owner: SyncOperation; prior: SyncAttempt }[] = []
  const selection = canonical(store.readBusinessBaselineSelection(operation.id))
  for (const owner of retryOperationLineage(store, operation)) {
    if (owner.readSetDigest !== operation.readSetDigest || canonical(store.readBusinessBaselineSelection(owner.id)) !== selection || canonical(owner.scope) !== canonical(operation.scope)) break
    sources.push(...store.listAttempts(owner.id).filter(prior => (owner.id !== operation.id || prior.number < attemptNumber) && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse().map(prior => ({ owner, prior })))
  }
  return sources
}
function settledApprovalSource(store: SyncStore, source: SyncOperation): boolean {
  if (source.phase !== 'superseded') return ['failed', 'budget_exhausted', 'cancelled'].includes(source.phase) && store.readRetryEligibility(source.id).eligible
  // 正式重试的更早祖先可被新准入替代，原已结算的独审证据仍有来源。
  return !!source.currentAttemptId
    && store.listAttempts(source.id).every(attempt => ['failed', 'superseded', 'settled'].includes(attempt.status))
    && !store.sourceContinuityState(source.input.source.commonDir).leasedOperationIds.includes(source.id)
    && !store.listRecoverableResources().some(item => item.operation.id === source.id)
    && store.listJournals(source.id).every(journal => journal.status === 'settled')
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
    || plan.sessionCreateKey !== dispatch.sessionCreateKey || plan.request.requestKey !== dispatch.key || plan.request.purpose !== dispatch.purpose || plan.request.model !== syncModel(operation)
    || plan.request.frozenContext || plan.request.worktree?.mode !== (dispatch.purpose === 'elaboration_generate' ? 'edit' : 'read') || contentHash(JSON.stringify(plan.request)) !== dispatch.requestDigest) return null
  const task = plan.request.prompt.split('\n任务:\n', 2)[1]?.split('\n', 1)[0]
  return task ? (JSON.parse(task) as { repair?: Pick<ReadonlySpecRepair, 'kind' | 'generationRef' | 'acceptedRef' | 'candidateDigest' | 'findings'> & { owner: NonNullable<ElaborationResult['partitionBinding']> } }).repair ?? null : null
}

/** Git保活本身不证明模型完成；未认证的Native稿不能遮蔽更早合格原稿。 */
function authenticatedDraftResult(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, key: string, purpose: string, draft?: ElaborationDraft): { result?: ElaborationSessionResult; request?: ElaborationSessionRequest } | null {
  const dispatch = prior.dispatchPlans.find(dispatch => dispatch.key === key && dispatch.purpose === purpose)
  if (!dispatch?.session?.threadId || !dispatch.session.turnId || dispatch.session.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) return null
  const resource = store.findResource(prior.id, key)
  let result: ElaborationSessionResult | null, request: ElaborationSessionRequest | undefined
  if (resource) {
    const native = JSON.parse(readEvidence(owner.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
    const checkpoint = JSON.parse(readEvidence(owner.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
    if (native.request.worktree?.mode !== (draft ? 'edit' : 'read') || native.request.frozenContext) return null
    if (!checkpoint.result || checkpoint.nativeState !== 'completed') {
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
    result = completedNativeStageResult(store, owner, prior, request, trace, checkpoint.result.output, '')
  } else {
    const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, owner, prior, `injected:${key}`)
    result = injected && injected.requestDigest === dispatch.requestDigest && canonical({ sessionId: injected.result.sessionId, threadId: injected.result.threadId, turnId: injected.result.turnId }) === canonical(dispatch.session) && injected.result.resultDigest === contentHash(JSON.stringify(injected.result.output)) ? injected.result : null
  }
  if (result && !draft) return { result, request }
  return result?.worktree && draft && canonical({ baseCommit: result.worktree.baseCommit, tree: result.worktree.baseTree, mode: 'edit' }) === canonical(draft.seed) && result.worktree.headCommit === draft.resultCommit && result.worktree.tree === draft.resultTree ? { result, request } : null
}

/** 续审保留原生成身份；从真实dispatch定位其原请求，不用新review轮号虚构generate。 */
function elaborationGenerationSource(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, round: ElaborationResult['rounds'][number]): { attempt: SyncAttempt; key: string; request?: ElaborationSessionRequest } | null {
  const traces = round.traces.filter(trace => trace.purpose === 'elaboration_generate'), trace = traces[0]
  if (traces.length !== 1 || trace.resultDigest !== contentHash(JSON.stringify(round.output))) return null
  for (const attempt of store.listAttempts(owner.id).filter(attempt => attempt.number <= prior.number)) {
    const dispatch = attempt.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && canonical(dispatch.session) === canonical({ sessionId: trace.sessionId, threadId: trace.threadId, turnId: trace.turnId }))
    if (!dispatch) continue
    const authenticated = authenticatedDraftResult(store, owner, attempt, dispatch.key, 'elaboration_generate', round.draft)
    if (!authenticated?.result || authenticated.result.resultDigest !== trace.resultDigest || canonical(authenticated.result.output) !== canonical(round.output) || authenticated.request && authenticated.request.inputDigest !== trace.inputDigest) return null
    return { attempt, key: dispatch.key, ...(authenticated.request ? { request: authenticated.request } : {}) }
  }
  return null
}

function assertStoppedEventsRpcDraft(prior: SyncAttempt, key: string, proof: ReturnType<typeof authenticateNativeFailure>): void {
  const { status, nativeState, failure, result, session } = proof.checkpoint
  if (!isZCodeEventsRpcTimeout(proof.state) || status !== 'failed' || nativeState !== 'failed' || failure?.code !== 'native_rpc_timeout' || failure.message !== proof.state.error || failure.failedWorktree || failure.rejectedOutput || result
    || proof.state.failedWorktree || proof.state.resultWorktree || proof.state.rejectedOutput || proof.state.output !== undefined || proof.state.resultDigest !== undefined) fail('stale_result', 'ZCode events RPC草稿缺少原typed失败和结算原件')
  if (!session.threadId || !session.turnId || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === key)?.session) !== canonical(session)
    || proof.record.harnessSessionId !== null && proof.record.harnessSessionId !== session.threadId) fail('stale_result', 'ZCode events RPC草稿缺少原完整派发与canonical Native身份')
}

function settledElaborationReview(store: SyncStore, operation: SyncOperation, prior: SyncAttempt, ownerKey: string, result: SavedElaboration, round: ElaborationResult['rounds'][number], failure: NonNullable<ElaborationResult['failure']>): ElaborationRepairDiagnostics['settledReview'] {
  if (result.status !== 'failed' || !result.structurePassed || result.reviewPassed || !round.draft || !round.candidate || round.review !== null || round.reviewOutput !== null) return
  const rejection = round.rejectedOutput
  if (rejection ? !reviewFormatRepairCodes.has(failure.code) || rejection.purpose !== 'elaboration_review' || !rejection.ref || rejection.ownerRequestKey !== ownerKey || rejection.ownerInputDigest !== result.inputDigest : failure.code !== 'native_rpc_timeout' || !isZCodeEventsRpcTimeout({ state: 'failed', errorCode: failure.code, error: failure.message })) return
  const key = `${ownerKey}:${round.index}:elaboration_review`
  const resource = store.findResource(prior.id, key)
  if (!resource || resource.phase !== 'removed' || prior.dispatchPlans.some(dispatch => store.findResource(prior.id, dispatch.key)?.phase !== 'removed')) fail('review_retry_binding', '独审失败缺少原正式资源及结算证明')
  const { plan, checkpoint, record, state } = authenticateNativeFailure(store, operation, prior, key, failure, readRecord, true)
  const { request } = plan, { session } = checkpoint
  const authenticateRejection = (source: SyncAttempt, sourceKey: string, sourceFailure: typeof failure, sourceRejection: NonNullable<typeof rejection>, original: NativeRunCheckpoint): void => {
    const { ownerInputDigest: _ownerInputDigest, ownerRequestKey: _ownerRequestKey, ...packet } = sourceRejection
    const originalPacket = original.failure?.rejectedOutput
    if (!originalPacket || original.failure?.code !== sourceFailure.code || original.failure.message !== sourceFailure.message
      || canonical({ ...originalPacket, ref: undefined }) !== canonical({ ...packet, ref: undefined })) fail('review_retry_binding', '独审拒稿不匹配原正式失败')
    authenticateNativeRejectedFinal(store, operation, source, sourceKey, sourceFailure, packet)
  }
  if (rejection) authenticateRejection(prior, key, failure, rejection, checkpoint)
  const transportMatches = rejection
    ? state.state === 'failed' && (request.model?.startsWith('zcode:') && record.harness === 'zcode' || request.model?.startsWith('claude:') && record.harness === 'claude'
      || request.model?.startsWith('grok:') && record.harness === 'grok-structured' && state.grokNative?.sessionId === session.threadId && state.grokNative?.turnId === session.turnId
      || request.model?.startsWith('cursor:') && record.harness === 'cursor-structured' && state.cursorNative?.sessionId === session.threadId && state.cursorNative?.requestId === session.turnId)
    : request.model?.startsWith('zcode:') && isZCodeEventsRpcTimeout(state) && record.harness === 'zcode' && state.zcodeNative?.sessionId === session.threadId && state.zcodeNative.turnId === session.turnId && !state.rejectedOutput
  const boundInput = ({ purpose, prompt, schema, worktree }: ElaborationSessionRequest): string => contentHash(JSON.stringify({ inputDigest: result.inputDigest, purpose, prompt, schema, worktree }))
  if (resource.attemptId !== prior.id || resource.generation !== prior.generation || plan.schemaVersion !== 1 || checkpoint.schemaVersion !== 1
    || request.purpose !== 'elaboration_review' || request.worktree?.mode !== 'read' || request.frozenContext || !transportMatches || request.inputDigest !== boundInput(request)
    || request.root !== operation.input.source.canonicalRoot || request.base !== request.worktree.baseCommit || record.base !== request.base || record.forkCommit !== request.base
    || !checkpoint.nativeCallRequested || !checkpoint.nativeStarted || checkpoint.status !== 'failed' || checkpoint.nativeState !== 'failed' || checkpoint.stop?.nativeStatus !== 'stopped' || checkpoint.result || checkpoint.creationTermination
    || checkpoint.candidateDigest !== null && checkpoint.candidateDigest !== round.candidateDigest
    || !session.threadId || !session.turnId || canonical(prior.dispatchPlans.find(dispatch => dispatch.key === key)?.session) !== canonical(session)
    || canonical(checkpoint.failure) !== canonical({ code: failure.code, message: failure.message, ...(rejection ? { rejectedOutput: checkpoint.failure?.rejectedOutput } : {}) })
    || record.harnessSessionId !== session.threadId || state.failedWorktree || state.resultWorktree || state.output !== undefined || state.resultDigest !== undefined) fail('review_retry_binding', '独审失败缺少同owner原只读请求及精确已结算的Native失败身份')
  const generation = elaborationGenerationSource(store, operation, prior, round)
  const generationOwner = generation && ownerKey.replace(`sync:${prior.id}:`, `sync:${generation.attempt.id}:`)
  if (!generation?.request || !generation.key.startsWith(`${generationOwner}:`) || generation.request.inputDigest !== boundInput(generation.request)
    || generation.request.root !== request.root || generation.request.base !== round.draft.seed.baseCommit
    || store.findResource(generation.attempt.id, generation.key)?.generation !== generation.attempt.generation
    || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== result.candidateDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate))) fail('review_retry_binding', '独审失败缺少同owner原Native生成及其精确Git候选绑定')
  const boundReview = { prompt: request.prompt, schema: request.schema, worktree: request.worktree }
  const diagnostics = result.repairDiagnostics, previousRound = diagnostics?.round, previous = previousRound?.rejectedOutput
  if (!diagnostics || !previousRound || previous?.purpose !== 'elaboration_review' || !previous.ref
    || previousRound.candidateDigest !== round.candidateDigest || canonical(previousRound.traces[0]) !== canonical(round.traces[0])) return boundReview
  const original = JSON.parse(readEvidence(operation.input.source.commonDir, diagnostics.resultRef).toString('utf8')) as SavedElaboration
  const source = store.readAttempt(previous.ownerRequestKey.split(':')[1])
  const sourceKey = `${previous.ownerRequestKey}:${previousRound.index}:elaboration_review`
  if (source.number >= prior.number || previous.ownerRequestKey !== ownerKey.replace(`sync:${prior.id}:`, `sync:${source.id}:`)
    || previous.ownerInputDigest !== result.inputDigest || original.inputDigest !== result.inputDigest
    || canonical(original.failure) !== canonical(diagnostics.failure) || canonical(original.rounds.at(-1)) !== canonical(previousRound)) fail('review_retry_binding', '旧独审附件缺少同候选原失败和精确来源')
  const authenticated = authenticateNativeFailure(store, operation, source, sourceKey, diagnostics.failure, readRecord, true)
  authenticateRejection(source, sourceKey, diagnostics.failure, previous, authenticated.checkpoint)
  return { ...boundReview, previousRejection: { sha256: previous.sha256, text: previous.text } }
}

/** P1业务扩域与原文件规划分别作证，完整scope必须精确等于两者的实际并集。 */
function reviewScopeProof(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, approved: SavedElaboration, generation: SavedGeneration): { p1: NonNullable<SyncOperation['contractScopeExpansions']>[number]; writerRef?: BlobRef; paths: string[] } | null {
  const commonDir = operation.input.source.commonDir, approvedRef = writeEvidence(commonDir, approved)
  const p1 = operation.contractScopeExpansions?.find(expansion => expansion.evidenceRef.sha256 === approvedRef.sha256)
  if (!p1 || !generation.candidate || !generation.fileWriterPlanRef) return null
  const filePlan = JSON.parse(readEvidence(commonDir, generation.fileWriterPlanRef).toString()) as FileWriterPlan
  const plan = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const originalPlan = stage<SyncPartitionPlan>(store, operation, origin, 'partition-plan')
  if (filePlan.version !== 'sync-file-writers-v1' || filePlan.writers.length !== filePlan.traces.length || !originalPlan || new Set(filePlan.writers.map(writer => writer.partitionId)).size !== filePlan.writers.length) return null
  for (const [index, writer] of filePlan.writers.entries()) {
    const trace = filePlan.traces[index]
    if (!originalPlan.partitions.some(partition => partition.id === writer.partitionId) || trace.purpose !== 'implementation_plan' || writer.paths.some(path => isHostPrivatePath(path) || path.startsWith('.spec/') || /[*?\[\]]/.test(path) || !within(path, plan.writePaths) || plan.mandatoryTests.some(test => overlap(path, test.testPath)))) return null
    let proven = false
    for (const source of store.listAttempts(operation.id).filter(attempt => attempt.number <= origin.number && ['failed', 'superseded', 'settled'].includes(attempt.status))) {
      const proposal = stage<{ paths: string[]; trace: ElaborationTrace }>(store, operation, source, `partition:${writer.partitionId}:implementation-plan`)
      if (!proposal || canonical(proposal.paths) !== canonical(writer.paths) || canonical(proposal.trace) !== canonical(trace)) continue
      const key = `sync:${source.id}:generation:partition:${writer.partitionId}:implementation_plan`
      const dispatch = source.dispatchPlans.find(item => item.key === key && item.purpose === 'implementation_plan' && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
      if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) continue
      const resource = store.findResource(source.id, key)
      if (resource) {
        const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
        const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
        const output = checkpoint.result?.output as { version?: string; paths?: string[] } | undefined
        if (!output || output.version !== 'sync-implementation-plan-v1' || !Array.isArray(output.paths) || canonical([...output.paths].sort()) !== canonical(writer.paths) || Object.keys(output).sort().join(',') !== 'paths,version' || native.request.model !== syncModel(operation) || native.request.effort !== 'high' || native.request.root !== operation.input.source.canonicalRoot || canonical(native.request.schema) !== canonical(IMPLEMENTATION_PLAN_SCHEMA) || !completedNativeStageResult(store, operation, source, native.request, trace, output, generation.candidate.digest)) continue
      } else {
        const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, source, `injected:${key}`), output = injected?.result.output as { version?: string; paths?: string[] } | undefined
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
function reviewPlanStage(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: 'partition-plan' | 'candidate-partition-plan', basis?: 'analysis_only_p1'): { result: SyncPartitionPlan; resultRef: BlobRef } | null {
  const exact = partitionStage<SyncPartitionPlan>(store, operation, attempt, key)
  if (exact) return exact
  const result = stage<SyncPartitionPlan>(store, operation, attempt, key)
  const approved = stage<SavedElaboration>(store, operation, attempt, 'elaboration')
  const generation = partitionStage<SavedGeneration>(store, operation, attempt, 'generation')?.result
  const verified = generation?.candidateValidated && generation.candidate && !generation.validationFindings.some(finding => finding.severity === 'error')
  const mixedP1 = basis === 'analysis_only_p1' && key === 'partition-plan' && approved?.analysisOnlyPartitions?.length
  if (!result || !approved?.structurePassed || !approved.reviewPassed || approved.failure || !verified && !mixedP1 || !operation.baselineSelection || !attempt.composedInput || !elaborationComposedBinding(store, operation, attempt, approved, attempt.composedInput)) return null
  const commonDir = operation.input.source.commonDir, resultRef = writeEvidence(commonDir, result), approvedRef = writeEvidence(commonDir, approved)
  const wrappers = readSyncCheckpoints(store, operation, attempt).json.map(({ value }) => value as Stage)
  const wrapper = wrappers.find(saved => saved.version === 'sync-stage-v1' && saved.stage === key && saved.resultRef?.sha256 === resultRef.sha256)
  const seal = wrappers.find(saved => saved.version === 'sync-stage-v1' && saved.stage === 'elaboration' && saved.resultRef?.sha256 === approvedRef.sha256)
  if (!wrapper?.readSetDigest || !wrapper.baselineSelectionRef || wrapper.readSetDigest !== seal?.readSetDigest || wrapper.baselineSelectionRef.sha256 !== seal.baselineSelectionRef?.sha256) return null
  const before = JSON.parse(readEvidence(commonDir, wrapper.baselineSelectionRef).toString()) as FrozenBaselineSelection
  const after = operation.baselineSelection
  if (!extendsWithUninitializedResources(before, after)) return null
  const plan = JSON.parse(readEvidence(commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const p1 = mixedP1 && plan.version === 'sync-coordinator-v2' && plan.direction === 'code_to_spec'
    ? operation.contractScopeExpansions?.find(expansion => expansion.evidenceRef.sha256 === approvedRef.sha256) : undefined
  const p1ScopeMatches = p1 && canonical(p1.paths) === canonical(operation.scope.paths) && canonical(p1.contractIds) === canonical(operation.scope.contractIds) && canonical(p1.flowIds) === canonical(operation.scope.flowIds)
  const proof = (verified ? reviewScopeProof(store, operation, attempt, approved, generation!) : null) ?? (p1ScopeMatches ? { p1, paths: [], writerRef: undefined } : null)
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
  const original = stage<SyncPartitionPlan>(store, operation, attempt, 'partition-plan')
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
function authenticatedApprovedElaboration(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, result: SavedElaboration, reviewInSourceAttempt = false): boolean {
  const round = result.rounds.at(-1), review = round?.traces.find(trace => trace.purpose === 'elaboration_review')
  if (!round?.draft || !round.candidate || !review || round.traces.length !== 2 || !hasApprovedElaborationReview(result) || round.review?.verdict !== 'accept'
    || round.candidate.inputDigest !== result.inputDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate)) || round.candidateDigest !== result.candidateDigest
    || canonical(round.review) !== canonical({ ...(round.reviewOutput as object), inputDigest: result.inputDigest, candidateDigest: result.candidateDigest })
    || ELABORATION_BOUNDARIES.some(boundary => !round.review!.checkedBoundaries.includes(boundary))) return false
  const generation = elaborationGenerationSource(store, owner, prior, round)
  const reviewed = store.listAttempts(owner.id).filter(attempt => attempt.number <= prior.number).find(attempt => attempt.dispatchPlans.some(dispatch => dispatch.purpose === review.purpose && canonical(dispatch.session) === canonical({ sessionId: review.sessionId, threadId: review.threadId, turnId: review.turnId })))
  if (reviewInSourceAttempt && reviewed?.id !== prior.id) return false
  const dispatch = reviewed?.dispatchPlans.find(dispatch => dispatch.purpose === review.purpose && dispatch.session?.sessionId === review.sessionId)
  const source = reviewed && dispatch ? authenticatedDraftResult(store, owner, reviewed, dispatch.key, review.purpose) : null
  if (!generation?.request || !source?.request || !source.result || source.request.inputDigest !== review.inputDigest || source.result.resultDigest !== review.resultDigest || canonical(source.result.output) !== canonical(round.reviewOutput)
    || round.traces.some(trace => trace.purpose === 'elaboration_generate' && (trace.sessionId === review.sessionId || trace.threadId === review.threadId))) return false
  for (const request of [generation.request, source.request]) {
    const expected = contentHash(JSON.stringify({ inputDigest: result.inputDigest, purpose: request.purpose, prompt: request.prompt, schema: request.schema, worktree: request.worktree }))
    const origin = request.purpose === 'elaboration_generate' ? generation.attempt : reviewed!
    if (request.model !== syncModel(owner) || request.root !== owner.input.source.canonicalRoot || request.frozenContext || !request.worktree || request.base !== request.worktree.baseCommit
      || request.worktree.mode !== (request.purpose === 'elaboration_generate' ? 'edit' : 'read') || request.inputDigest !== expected
      || !request.requestKey.startsWith(`sync:${origin.id}:elaborate:partition:${result.partitionBinding!.partitionId}:`)) return false
  }
  return true
}

/** 复制的局部批准只能沿同一原件回到实际Native派发。 */
function elaborationDraftGenerationSource(store: SyncStore, owner: SyncOperation, prior: SyncAttempt, key: string, source: { result: SavedElaboration; resultRef: BlobRef }, round: ElaborationResult['rounds'][number], sources: ReturnType<typeof retryDraftSources>, readCheckpoints: (owner: SyncOperation, prior: SyncAttempt) => SyncCheckpointStageView) {
  const direct = elaborationGenerationSource(store, owner, prior, round)
  if (direct) return { ...direct, ownerId: owner.id }
  const { result, resultRef } = source, binding = result.partitionBinding
  if (!binding || key !== 'partition:' + binding.partitionId + ':elaboration' || !result.structurePassed || !result.reviewPassed || result.failure || round !== result.rounds.at(-1)) return null
  let index = sources.findIndex(item => item.owner.id === owner.id && item.prior.id === prior.id)
  if (index < 0) return null
  let planRef: string | undefined
  for (;;) {
    const origin = sources[index], checkpoints = readCheckpoints(origin.owner, origin.prior)
    const plan = partitionStage<SyncPartitionPlan>(store, origin.owner, origin.prior, 'partition-plan', undefined, checkpoints)
    const saved = partitionStage<SavedElaboration>(store, origin.owner, origin.prior, key, undefined, checkpoints)
    if (plan?.result.digest !== binding.planDigest || planRef && plan.resultRef.sha256 !== planRef || saved?.resultRef.sha256 !== resultRef.sha256
      || canonical(origin.prior.composedInput) !== canonical(prior.composedInput) || origin.prior.baselineSelectionDigest !== prior.baselineSelectionDigest
      || origin.owner.id !== owner.id && !settledApprovalSource(store, origin.owner)) return null
    planRef = plan.resultRef.sha256
    const provenance = partitionStage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, origin.owner, origin.prior, key + ':provenance', undefined, checkpoints)
    if (!provenance) {
      if (!authenticatedApprovedElaboration(store, origin.owner, origin.prior, result, true)) return null
      const generation = elaborationGenerationSource(store, origin.owner, origin.prior, round)
      return generation && { ...generation, ownerId: origin.owner.id }
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

/** null资源扩展沿原aggregate门禁；owner仍须逐字绑定其当时批准的同一readSet/selection。 */
function readonlyLocalSource(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, resultRef: BlobRef, aggregateRef: BlobRef): { result: SavedElaboration; resultRef: BlobRef } | null {
  const result = stage<SavedElaboration>(store, operation, attempt, key), commonDir = operation.input.source.commonDir
  if (!result || writeEvidence(commonDir, result).sha256 !== resultRef.sha256) return null
  const selectedAggregate = JSON.parse(readEvidence(commonDir, aggregateRef).toString('utf8')) as SavedElaboration
  if (!selectedAggregate.structurePassed || !selectedAggregate.reviewPassed || !selectedAggregate.partitionEvidence?.some(owner => owner.resultRef.sha256 === resultRef.sha256)) fail('readonly_spec_repair_binding', '只读owner原件不属于精确选择的已审aggregate')
  const wrapper = readSyncCheckpoints(store, operation, attempt).json.map(({ value }) => value as Stage).find(value => value.stage === key && value.resultRef?.sha256 === resultRef.sha256)
  if (!wrapper?.readSetDigest || !store.listAttempts(operation.id).some(approved => {
    const aggregate = stage<SavedElaboration>(store, operation, approved, 'elaboration')
    return aggregate?.structurePassed && aggregate.reviewPassed && aggregate.partitionEvidence?.some(owner => owner.resultRef.sha256 === resultRef.sha256) && readSyncCheckpoints(store, operation, approved).json.some(({ value }) => {
      const saved = value as Stage
      return saved.version === 'sync-stage-v1' && saved.stage === 'elaboration' && saved.resultRef?.sha256 === writeEvidence(commonDir, aggregate).sha256 && saved.readSetDigest === wrapper.readSetDigest && saved.baselineSelectionRef?.sha256 === wrapper.baselineSelectionRef?.sha256
    })
  })) fail('readonly_spec_repair_binding', '只读owner与精确已审aggregate的原readSet/selection不一致')
  return { result, resultRef }
}

function readonlyReviewFindings(result: SavedGeneration, changes: SavedElaboration['changes'], writable: readonly string[]): ContractFinding[] {
  const items = changes.flatMap(change => parseContract({ nodeId: change.nodeId, path: change.path, source: change.source }).contract?.items ?? [])
  return (result.partitionEvidence ?? []).filter(evidence => evidence.review.verdict === 'repair').flatMap(evidence => evidence.review.findings).flatMap<ContractFinding>(finding => {
    const location = finding.ruleLocation.replace(/^contract:/, '')
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
    return [{ code: 'candidate-review-repair', severity: 'error', nodeId: matches[0].nodeId, path, itemId: id, relatedIds: finding.affectedIds, message: JSON.stringify(finding) }]
  })
}

type AcceptedReviewProvenance = { fromOperationId: string; fromAttemptId: string; resultRef: BlobRef; inputRef: BlobRef }
function acceptedReviewInput(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, resultRef: BlobRef): GenerationInput | null {
  const provenance = partitionStage<AcceptedReviewProvenance>(store, operation, attempt, `${key}:provenance`)?.result
  if (provenance?.fromOperationId !== operation.id || provenance.resultRef.sha256 !== resultRef.sha256 || !provenance.inputRef) return null
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

/** 成功的builder与review共用原正式派发/Native结果冷验，不制造当前调用。 */
function completedNativeStageResult(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, request: ElaborationSessionRequest, trace: ElaborationTrace, output: unknown, candidateDigest: string): ElaborationSessionResult | null {
  const key = request.requestKey, commonDir = operation.input.source.commonDir
  const dispatch = origin.dispatchPlans.find(item => item.key === key && item.purpose === request.purpose && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
  if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || trace.purpose !== request.purpose || trace.inputDigest !== request.inputDigest || trace.resultDigest !== contentHash(JSON.stringify(output))) return null
  const { signal: _signal, ...payload } = request
  const resource = store.findResource(origin.id, key)
  if (!resource) {
    const injected = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, origin, `injected:${key}`)
    return injected && injected.requestDigest === dispatch.requestDigest && contentHash(JSON.stringify(payload)) === dispatch.requestDigest && injected.result.sessionId === trace.sessionId && injected.result.threadId === trace.threadId && injected.result.turnId === trace.turnId && injected.result.resultDigest === trace.resultDigest && canonical(injected.result.output) === canonical(output) ? injected.result : null
  }
  const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  if (resource.operationId !== operation.id || resource.attemptId !== origin.id || resource.plan.kind !== 'native_session' || resource.plan.key !== key || resource.plan.inputId !== operation.input.id || resource.phase !== 'removed' || native.schemaVersion !== 1 || native.operationId !== operation.id || native.attemptId !== origin.id || native.inputId !== operation.input.id || native.candidateDigest !== resource.plan.candidateDigest || native.candidateDigest !== null && native.candidateDigest !== candidateDigest || checkpoint.operationId !== operation.id || checkpoint.attemptId !== origin.id || checkpoint.inputId !== operation.input.id || checkpoint.candidateDigest !== native.candidateDigest || checkpoint.expectedSessionId !== trace.sessionId || canonical(checkpoint.session) !== canonical(dispatch.session) || native.requestDigest !== dispatch.requestDigest || resource.plan.payloadDigest !== dispatch.requestDigest || contentHash(JSON.stringify(native.request)) !== dispatch.requestDigest || native.sessionCreateKey !== dispatch.sessionCreateKey || native.expectedSessionId !== trace.sessionId || native.request.requestKey !== key || native.request.inputDigest !== request.inputDigest || native.request.purpose !== request.purpose || checkpoint.status !== 'completed' || checkpoint.phase !== 'removed' || checkpoint.requestDigest !== dispatch.requestDigest || checkpoint.result?.resultDigest !== trace.resultDigest || checkpoint.result.sessionId !== trace.sessionId || checkpoint.result.threadId !== trace.threadId || checkpoint.result.turnId !== trace.turnId || canonical(checkpoint.result.output) !== canonical(output) || !nativeReviewRequestMatches(native.request, request, { attemptId: origin.id, policyDigest: operation.policyDigest })) return null
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

/** 续审analysis沿精确原件provenance回到实际Native提交；不借任意历史session授予已校验资格。 */
function behaviorTraceBinding(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, trace: ElaborationTrace, sourceSelection?: FrozenBaselineSelection, readCheckpoints?: (attempt: SyncAttempt) => SyncCheckpointStageView, bindModel = false): boolean {
  for (;;) {
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
    if (trace.purpose !== 'code_behavior_analyze' && trace.purpose !== 'code_behavior_review') return false
    const source = partitionStage<CodeBehaviorContinuation>(store, operation, origin, `${key}:continuation`, sourceSelection, readCheckpoints?.(origin)), ready = trace.purpose === 'code_behavior_analyze' ? source?.result.readyAnalysis : source?.result.reviewResult, draft = source?.result.drafts[trace.purpose]
    if (!ready || !draft || canonical(ready.trace) !== canonical(trace) || ready.draftOid !== draft.oid || ready.resultCommit !== draft.resultCommit || draft.sourceInputId !== operation.input.id) return false
    if (dispatch) {
      const request = JSON.parse(readEvidence(operation.input.source.commonDir, ready.requestRef).toString()) as ElaborationSessionRequest
      const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
      if (request.requestKey !== `sync:${origin.id}:analysis${suffix}:${trace.purpose}` || source!.result.inputDigest !== trace.inputDigest || bindModel && request.model !== syncModel(operation)) return false
      const ownerDigest = contentHash(JSON.stringify({ version: 'code-behavior-draft-v1', source: canonicalSnapshotSource(operation.input.source), partitionId: key === 'analysis' ? null : key.slice('partition:'.length, -':analysis'.length), purpose: trace.purpose }))
      readStageDraft(operation.input.source.commonDir, draft, { ownerDigest, sourceInputId: operation.input.id, schemaDigest: draft.schemaDigest, path: `.spex-sync-drafts/${ownerDigest}.json` })
      const result = completedNativeStageResult(store, operation, origin, request, trace, ready.receipt, '')
      return !!result?.worktree && canonical({ baseCommit: result.worktree.baseCommit, tree: result.worktree.baseTree, mode: 'edit' }) === canonical(draft.seed) && result.worktree.headCommit === draft.resultCommit && result.worktree.tree === draft.resultTree
    }
    if (trace.purpose !== 'code_behavior_analyze') return false
    const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, operation, origin, `${key}:continuation-provenance`, 'automatic', readCheckpoints?.(origin))
    if (!provenance || provenance.fromOperationId !== operation.id) return false
    const previous = store.readAttempt(provenance.fromAttemptId)
    if (previous.operationId !== operation.id || previous.number >= origin.number || !['failed', 'superseded', 'settled'].includes(previous.status)) return false
    const prior = partitionStage<CodeBehaviorContinuation>(store, operation, previous, `${key}:continuation`, sourceSelection, readCheckpoints?.(previous))
    if (!prior || prior.resultRef.sha256 !== provenance.resultRef.sha256 || canonical(prior.result.readyAnalysis) !== canonical(ready) || prior.result.inputDigest !== source!.result.inputDigest) return false
    origin = previous
  }
}

/** 业务repair清除ready后，原分析稿仍沿精确continuation来源认证；不继承祖先的推进状态。 */
function behaviorAnalysisDraftBinding(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, draft: ElaborationDraft, planDigest?: string, statusOnly = false): boolean {
  const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
  for (;;) {
    const source = partitionStage<CodeBehaviorContinuation>(store, operation, origin, `${key}:continuation`)
    const saved = source?.result.drafts.code_behavior_analyze
    if (!source || !saved || canonical(statusOnly ? codeBehaviorDraftStatus(saved) : saved) !== canonical(statusOnly ? codeBehaviorDraftStatus(draft) : draft) || draft.sourceInputId !== operation.input.id || stage<{ version: string }>(store, operation, origin, 'behavior-draft-protocol')?.version !== 'code-behavior-draft-v1') return false
    if (planDigest && partitionStage<SyncPartitionPlan>(store, operation, origin, 'partition-plan')?.result.digest !== planDigest) return false
    const requestKey = `sync:${origin.id}:analysis${suffix}:code_behavior_analyze`
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.key === requestKey && dispatch.purpose === 'code_behavior_analyze')
    if (dispatch) {
      const trace = source.result.readyAnalysis?.trace
      return !!trace && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId && behaviorTraceBinding(store, operation, origin, key, trace)
    }
    const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, operation, origin, `${key}:continuation-provenance`)
    if (!provenance || provenance.fromOperationId !== operation.id) return false
    const previous = store.readAttempt(provenance.fromAttemptId)
    if (previous.operationId !== operation.id || previous.number >= origin.number || !['failed', 'superseded', 'settled'].includes(previous.status) || canonical(previous.composedInput) !== canonical(origin.composedInput)) return false
    const prior = partitionStage<CodeBehaviorContinuation>(store, operation, previous, `${key}:continuation`)
    if (!prior || prior.resultRef.sha256 !== provenance.resultRef.sha256 || prior.result.inputDigest !== source.result.inputDigest) return false
    origin = previous
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

/** 沿原检查点追到真正派发的accept；拷贝不创造新会话或修改旧摘要。 */
export function acceptedCandidateReviewSource(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, input: GenerationInput): { result: SavedGeneration; resultRef: BlobRef; attempt: SyncAttempt } | null {
  const selected = operation.baselineSelection
  if (selected && selected.digest !== contentHash(canonical({ version: selected.version, source: selected.source, bindings: selected.bindings }))) return null
  let origin = attempt, source = partitionStage<SavedGeneration>(store, operation, origin, key)
  while (source) {
    const result = source.result, trace = result.traces[0]
    if (origin.operationId !== operation.id || !['failed', 'superseded', 'settled'].includes(origin.status) || result.status !== 'reviewed' || !result.candidateValidated || !result.reviewPassed || result.failure || result.validationFindings.some(finding => finding.severity === 'error') || result.inputId !== operation.input.id || canonical(result.candidate) !== canonical(candidate) || result.review?.verdict !== 'accept' || result.review.findings.length || canonical(result.reviewOutput) !== canonical(result.review) || result.review.inputId !== operation.input.id || result.review.candidateDigest !== candidate.digest || result.traces.length !== 1 || trace.purpose !== 'code_review' || trace.inputDigest !== result.inputDigest || trace.resultDigest !== contentHash(JSON.stringify(result.reviewOutput))) return null
    const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration')
    const aggregate = partitionStage<SavedGeneration>(store, operation, origin, 'generation')?.result
    if (canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths) || approved && aggregate && !reviewScopeProof(store, operation, origin, approved, aggregate)) return null
    const oldKey = `sync:${origin.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`
    const dispatch = origin.dispatchPlans.find(dispatch => dispatch.key === oldKey && dispatch.purpose === 'code_review' && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
    if (!dispatch) {
      const provenance = partitionStage<AcceptedReviewProvenance>(store, operation, origin, `${key}:provenance`)?.result
      const carried = acceptedReviewInput(store, operation, origin, key, source.resultRef)
      if (!provenance || !carried || freezeGenerationInput({ ...carried, requestKey: input.requestKey }).inputDigest !== freezeGenerationInput(input).inputDigest) return null
      const prior = store.readAttempt(provenance.fromAttemptId)
      if (prior.operationId !== operation.id || prior.number >= origin.number) return null
      origin = prior
      const previous = partitionStage<SavedGeneration>(store, operation, origin, key)
      if (previous?.resultRef.sha256 !== source.resultRef.sha256) return null
      source = previous; continue
    }
    if (trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || !trace.threadId || !trace.turnId || canonical(reviewPlanStage(store, operation, origin, 'candidate-partition-plan')?.result) !== canonical(plan)) return null
    const sourceInput = { ...input, requestKey: oldKey.slice(0, -':code_review'.length) }
    const expected = generationReviewRequest(sourceInput, candidate, true, aggregate?.p2SpecWritePaths)
    if (expected.request.inputDigest !== result.inputDigest || reviewError(sourceInput, result.review, expected.binding, undefined, aggregate?.p2SpecWritePaths)) return null
    const native = completedNativeStageResult(store, operation, origin, expected.request, trace, result.reviewOutput, candidate.digest)
    if (!native) return null
    verifyGenerationReviewDraft(operation.input.source.commonDir, expected.request, native, expected.draftBinding)
    return { ...source, attempt: origin }
  }
  return null
}

/** 格式续审沿原正式Native失败取诊断；完整业务输入及原请求必须仍可逐字重建。 */
export function failedCandidateReviewSource(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, candidate: CandidateRef, plan: SyncPartitionPlan, input?: GenerationInput): GenerationInput['reviewRepair'] | null {
  const source = partitionStage<SavedGeneration>(store, operation, origin, key), result = source?.result
  if (!source || !result || !['failed', 'superseded', 'settled'].includes(origin.status) || !['repair', 'failed'].includes(result.status) || result.inputId !== operation.input.id || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths) || input && canonical(input.composed) !== canonical(origin.composedInput) || !result.candidateValidated || result.reviewPassed || result.validationFindings.some(finding => finding.severity === 'error') || canonical(result.candidate) !== canonical(candidate) || canonical(reviewPlanStage(store, operation, origin, 'candidate-partition-plan')?.result) !== canonical(plan)) return null
  const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration')
  const aggregate = partitionStage<SavedGeneration>(store, operation, origin, 'generation')?.result
  if (!approved || !aggregate || !reviewScopeProof(store, operation, origin, approved, aggregate)) return null
  const savedPlan = JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob!).toString()) as SyncCoordinatorPlan
  const writable = aggregate.p2SpecWritePaths ?? (savedPlan.version === 'sync-coordinator-v2' && savedPlan.direction === 'code_to_spec' ? [] : undefined)
  const completed = result.reviewOutput !== null
  if (completed) {
    const contracts = verifyCandidate(operation.input.source.commonDir, candidate).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).flatMap(entry => parseContract({ nodeId: entry.path.split('/').at(-2)!, path: entry.path, source: readObject(operation.input.source.commonDir, entry.oid).toString('utf8') }).contract ?? [])
    if (!writable) return null
    if (candidateReviewError(result.reviewOutput, { inputId: operation.input.id, candidateDigest: candidate.digest, requiredIds: [], actualIds: contracts.flatMap(contract => contract.items.map(item => item.id)), priorIds: [] }) || candidateReviewLocationError(result.reviewOutput as NonNullable<GenerationResult['review']>, contracts, writable)?.code !== 'review_location_format' || result.failure && !completedReviewRepairCodes.has(result.failure.code) || result.review !== null && canonical(result.review) !== canonical(result.reviewOutput)) return null
  } else if (!reviewFormatRepairCodes.has(result.failure?.code ?? '') || result.review !== null) return null
  const requestKey = `sync:${origin.id}:generation:final:${key.slice('partition:'.length, -':candidate-review'.length)}:code_review`
  const resource = store.findResource(origin.id, requestKey)
  if (!resource || resource.phase !== 'removed' || resource.attemptId !== origin.id || resource.plan.key !== requestKey || resource.plan.inputId !== operation.input.id || !completed && (result.failure?.requestKey !== requestKey || result.failure.inputDigest !== result.inputDigest)) return null
  const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
  const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
  if (native.request.purpose !== 'code_review' || native.request.inputDigest !== result.inputDigest) return null
  if (completed) {
    const trace = result.traces[0]
    if (checkpoint.nativeState !== 'completed' || checkpoint.failure || result.traces.length !== 1 || !trace || !completedNativeStageResult(store, operation, origin, native.request, trace, result.reviewOutput, candidate.digest)) return null
  } else {
    const packet = checkpoint.failure?.rejectedOutput
    if (!packet || !result.failure || native.request.purpose !== 'code_review' || native.request.inputDigest !== result.inputDigest || native.candidateDigest !== resource.plan.candidateDigest || native.candidateDigest !== null && native.candidateDigest !== candidate.digest || checkpoint.failure?.code !== result.failure.code || checkpoint.failure.message !== result.failure.message || checkpoint.phase !== 'removed' || checkpoint.nativeState !== 'failed' || checkpoint.stop?.nativeStopped !== true) return null
    const state = authenticateNativeRejectedFinal(store, operation, origin, requestKey, result.failure, packet)
    if (state.cancellation?.nativeStopped !== true || checkpoint.stop.nativeStatus !== state.cancellation.nativeStatus || checkpoint.requestDigest !== native.requestDigest || checkpoint.operationId !== operation.id || checkpoint.attemptId !== origin.id || checkpoint.inputId !== operation.input.id || checkpoint.expectedSessionId !== result.failure.sessionId || checkpoint.session.sessionId !== result.failure.sessionId || checkpoint.session.threadId !== result.failure.threadId || checkpoint.session.turnId !== result.failure.turnId) return null
  }
  if (input) {
    const savedInput = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, origin, `${key}:input`)?.result
    const previous = savedInput ? restoreGenerationInput(savedInput) : { ...input, requestKey: requestKey.slice(0, -':code_review'.length), reviewRepair: undefined }
    const base = { ...previous, requestKey: input.requestKey, reviewRepair: undefined }
    if (freezeGenerationInput(base).inputDigest !== freezeGenerationInput({ ...input, reviewRepair: undefined }).inputDigest) return null
    const expected = generationReviewRequest(previous, candidate, true, writable).request
    if (!nativeReviewRequestMatches(native.request, expected, { attemptId: origin.id, policyDigest: operation.policyDigest })) return null
  }
  return { resultRef: source.resultRef, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef }
}

/** 真实只读候选失败回到原P1写者；独审诊断不成为refinement或业务授权。 */
function readonlyRepairFromAttempt(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt): ReadonlyOwnerRepair | null {
  const saved = stage<SavedGeneration>(store, operation, attempt, 'generation')
  if (!saved) return null
  operation = readonlyRepairContext(store, operation, attempt, writeEvidence(operation.input.source.commonDir, saved))
  const generation = partitionStage<SavedGeneration>(store, operation, attempt, 'generation', operation.baselineSelection)
  let allFindings = generation?.result.validationFindings.filter(item => item.severity === 'error') ?? []
  const semantic = generation?.result.candidateValidated === true && ['repair', 'failed'].includes(generation.result.status) && !generation.result.reviewPassed && generation.result.partitionEvidence?.some(item => item.review.verdict === 'repair')
  if (!generation?.result.candidate || !semantic && (generation.result.candidateValidated || !allFindings.length || allFindings.some(item => item.code !== 'anchor-dead'))) return null
  const plan = operation.planBlob ? JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob).toString('utf8')) as SyncCoordinatorPlan : null
  if (plan?.version !== 'sync-coordinator-v2') return null
  const writable = generation.result.p2SpecWritePaths ?? (plan.direction === 'code_to_spec' ? [] : null)
  if (!writable) fail('readonly_spec_repair_permissions_unknown', '旧mixed候选没有真实P2 Spec写权限投影，停止而不猜owner权限', [generation.resultRef])
  if (!semantic && allFindings.every(finding => within(finding.path, writable))) return null
  const approved = stage<SavedElaboration>(store, operation, attempt, 'elaboration')
  const prior = approved ? { result: approved, resultRef: writeEvidence(operation.input.source.commonDir, approved) } : null
  if (!prior?.result.structurePassed || !prior.result.reviewPassed || prior.result.failure || !prior.result.partitionEvidence?.length || !['failed', 'superseded', 'settled'].includes(attempt.status) || attempt.failure?.kind !== 'repairable') fail('readonly_spec_repair_binding', '只读V1诊断缺少同输入已审P1及已结算失败')
  const planDigests = new Set(prior.result.partitionEvidence.map(owner => (JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration).partitionBinding?.planDigest))
  const origins = store.listAttempts(operation.id).filter(item => item.number <= attempt.number)
  let planSource: { attemptId: string; ref: BlobRef } | undefined
  for (const origin of origins) {
    const approved = stage<SavedElaboration>(store, operation, origin, 'elaboration'), plan = stage<SyncPartitionPlan>(store, operation, origin, 'partition-plan')
    if (approved && plan && writeEvidence(operation.input.source.commonDir, approved).sha256 === prior.resultRef.sha256 && planDigests.size === 1 && planDigests.has(plan.digest)
      && (!approved.analysisOnlyPartitions || authenticatedMixedElaborationCoverage(store, operation, origin, plan, approved))) { planSource = { attemptId: origin.id, ref: writeEvidence(operation.input.source.commonDir, plan) }; break }
  }
  if (!planSource) fail('readonly_spec_repair_binding', '只读V1诊断缺少原已审全分区计划')
  const candidate = generation.result.candidate, commonDir = operation.input.source.commonDir
  if (candidate.sourceInputId !== operation.input.id) fail('readonly_spec_repair_binding', '只读V1诊断候选属于另一输入')
  const entries = new Map(verifyCandidate(commonDir, candidate).map(entry => [entry.path, entry]))
  if (semantic) {
    const contracts = prior.result.changes.flatMap(change => parseContract(change).contract ?? [])
    const invalid = generation.result.partitionEvidence!.filter(evidence => candidateReviewLocationError(evidence.review, contracts, writable)?.code === 'review_location_format')
    if (invalid.length) {
      const plan = reviewPlanStage(store, operation, attempt, 'candidate-partition-plan')?.result
      if (!plan || invalid.some(evidence => !failedCandidateReviewSource(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, candidate, plan))) fail('readonly_spec_repair_binding', '字段格式无效的历史独审缺少完整原Native成功认证，不能取得草稿续修权限')
      return null
    }
  }
  if (semantic && (prior.result.changes.every(change => within(change.path, writable)) || generation.result.partitionEvidence!.some(evidence => evidence.review.findings.some(finding => finding.ruleLocation.startsWith('contract-omission:'))))) return null
  const reviewEvidence: NonNullable<ReadonlyOwnerRepair['reviewEvidence']> = []
  if (semantic) {
    allFindings = readonlyReviewFindings(generation.result, prior.result.changes, writable)
    for (const evidence of generation.result.partitionEvidence!) {
      const saved = partitionStage<SavedGeneration>(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, operation.baselineSelection)
      const result = saved?.result, trace = result?.traces.find(trace => trace.purpose === 'code_review')
      const currentDispatch = trace && attempt.dispatchPlans.some(dispatch => dispatch.purpose === 'code_review' && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)
      const reviewPlan = evidence.review.verdict === 'accept' && !currentDispatch ? partitionStage<SyncPartitionPlan>(store, operation, attempt, 'candidate-partition-plan') : null
      const acceptedInput = saved && reviewPlan ? acceptedReviewInput(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, saved.resultRef) : null
      const acceptedSource = reviewPlan && acceptedInput && acceptedCandidateReviewSource(store, operation, attempt, `partition:${evidence.partitionId}:candidate-review`, candidate, reviewPlan.result, acceptedInput)
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
      const source = readonlyLocalSource(store, operation, origin, key, owner.resultRef, prior.resultRef)
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

function readonlyRepairContext(store: SyncStore, operation: SyncOperation, source: SyncAttempt, generationRef: BlobRef): SyncOperation {
  let context = operation
  if (operation.baselineSelection) {
    const basis = readSyncCheckpoints(store, operation, source).json.map(({ value }) => value as Stage).find(saved => saved.version === 'sync-stage-v1' && saved.stage === 'generation' && saved.operationId === operation.id && saved.attemptId === source.id && saved.inputId === operation.input.id && saved.policyDigest === operation.policyDigest && saved.resultRef?.sha256 === generationRef.sha256)
    if (!basis?.readSetDigest || !basis.baselineSelectionRef || !stageSelectionMatches(store, operation, basis)) fail('readonly_spec_repair_binding', '只读续修原generation绑定不属于当前合法null资源扩展')
    context = withCheckpointStageBasis(operation, basis.readSetDigest, JSON.parse(readEvidence(operation.input.source.commonDir, basis.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection)
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
  const source = store.readAttempt(repair.fromAttemptId)
  const context = readonlyRepairContext(store, operation, source, repair.generationRef)
  const derived = readonlyRepairFromAttempt(store, context, source)
  const originalShape = readonlyRepairOriginalShape(derived, repair)
  if (source.operationId !== operation.id || canonical(originalShape) !== canonical(repair)) fail('readonly_spec_repair_binding', '只读V1续修来源、owner或原件绑定失配')
}

function refinementGeneration(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, refinement: Refinement): SavedGeneration {
  const previous = store.listAttempts(operation.id).filter(prior => prior.number < attempt.number).reverse().map(prior => stage<SavedGeneration>(store, operation, prior, 'generation')).find(value => value?.candidate?.digest === refinement.candidateDigest)
  const findings = refinement.diagnostics.map(item => JSON.parse(item.message) as GenerationFinding)
  if (!previous?.review || previous.review.verdict !== 'repair' || canonical(previous.candidate) !== canonical(refinement.candidate) || findings.some(finding => !previous.review!.findings.some(actual => canonical(actual) === canonical(finding)))) fail('refinement_binding', '持久遗漏诊断缺少对应实际候选及完整独审原件')
  return previous
}

function reviewedReadonlyLocal(store: SyncStore, operation: SyncOperation, sourceAttempt: SyncAttempt, key: string, resultRef: BlobRef, aggregateRef: BlobRef, afterAttemptNumber = 0): SavedElaboration {
  const source = readonlyLocalSource(store, operation, sourceAttempt, key, resultRef, aggregateRef)
  const prior = source?.result, round = prior?.rounds.at(-1)
  const generationTrace = round?.traces.find(trace => trace.purpose === 'elaboration_generate'), reviewTrace = round?.traces.find(trace => trace.purpose === 'elaboration_review')
  if (!prior || !round || !elaborationGenerationSource(store, operation, sourceAttempt, round) || source.resultRef.sha256 !== resultRef.sha256 || !prior.structurePassed || !prior.reviewPassed || prior.failure || !hasApprovedElaborationReview(prior) || round.review!.inputDigest !== prior.inputDigest || round.review!.candidateDigest !== prior.candidateDigest || round.traces.length !== 2 || !generationTrace || !reviewTrace || generationTrace.sessionId === reviewTrace.sessionId || generationTrace.threadId === reviewTrace.threadId || generationTrace.resultDigest !== contentHash(JSON.stringify(round.output)) || reviewTrace.resultDigest !== contentHash(JSON.stringify(round.reviewOutput)) || !store.listAttempts(operation.id).some(attempt => attempt.number > afterAttemptNumber && readSyncCheckpoints(store, operation, attempt).json.some(({ ref }) => ref.sha256 === resultRef.sha256) && attempt.dispatchPlans.some(dispatch => dispatch.purpose === reviewTrace.purpose && dispatch.session?.sessionId === reviewTrace.sessionId && dispatch.session.threadId === reviewTrace.threadId && dispatch.session.turnId === reviewTrace.turnId))) fail('readonly_spec_repair_binding', '只读V1 owner原件、完整输入或独审派发绑定失配')
  return prior
}

type ApprovedElaborationSource = { result: SavedElaboration; attemptId: string; operationId: string; resultRef: BlobRef }
type ApprovedElaboration = ApprovedElaborationSource & { lineage: ApprovedElaborationSource[] }
function latestApprovedElaboration(store: SyncStore, operation: SyncOperation, attemptNumber: number): ApprovedElaboration | null {
  let ancestor: SyncOperation | null = operation
  while (ancestor) {
    if (ancestor.input.id !== operation.input.id || canonical(ancestor.input.source) !== canonical(operation.input.source) || ancestor.policyDigest !== operation.policyDigest || (ancestor.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null) || ancestor.origin !== operation.origin) fail('retry_provenance_binding', '重试链不能借用另一来源或原意的已接受契约')
    let selected: { result: SavedElaboration; attemptId: string } | undefined
    const lineage: ApprovedElaborationSource[] = []
    for (const prior of store.listAttempts(ancestor.id).filter(item => ancestor!.id !== operation.id || item.number < attemptNumber)) {
      const approved = stage<SavedElaboration>(store, ancestor, prior, 'elaboration')
      if (!approved?.structurePassed || !approved.reviewPassed || !['complete', 'needs_input', 'conflict'].includes(approved.status)) continue
      if (!selected) { selected = { result: approved, attemptId: prior.id }; lineage.push({ ...selected, operationId: ancestor.id, resultRef: writeEvidence(operation.input.source.commonDir, approved) }); continue }
      const readonlyInput = readonlyRepairBinding(store, ancestor, prior), readonlySupplement = readonlyInput?.readonlyOwnerRepair
      if (!readonlySupplement && readSyncCheckpoints(store, ancestor, prior).json.some(({ value }) => (value as Partial<Stage>).stage?.endsWith(':readonly-repair-provenance'))) fail('readonly_spec_repair_binding', '已审只读返修whole缺少同attempt原始因果绑定')
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
      const supplementation = stage<{ refinement?: Refinement }>(store, ancestor, prior, 'repair-input')?.refinement
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
  const history = store.listAttempts(operation.id), generations = history.filter(prior => prior.number < attempt.number).flatMap(prior => {
    const result = stage<SavedGeneration>(store, operation, prior, 'generation')
    return result?.candidate ? [{ prior, result }] : []
  })
  const candidate = generations.at(-1)?.result.candidate
  if (!candidate) return null
  if (candidate.sourceInputId !== operation.input.id) fail('readonly_spec_repair_binding', '最新候选不属于当前冻结输入，不能清除待处理诊断')
  verifyCandidate(operation.input.source.commonDir, candidate)
  const candidateDigest = candidate.digest
  for (const { prior, result } of generations) {
    if (result.candidate?.digest !== candidateDigest || prior.failure?.kind !== 'repairable' || !['failed', 'superseded', 'settled'].includes(prior.status)) continue
    const repair = readonlyRepairFromAttempt(store, operation, prior)
    if (!repair) continue
    const owners: ReadonlyOwnerRepair['owners'] = []
    for (const owner of repair.owners) {
      const response = approved.lineage.flatMap(base => {
        const saved = base.result.partitionEvidence?.find(item => item.partitionId === owner.partitionId && item.resultRef.sha256 !== owner.resultRef.sha256)
        const result = saved && JSON.parse(readEvidence(operation.input.source.commonDir, saved.resultRef).toString('utf8')) as SavedElaboration | undefined
        return saved && result?.readonlySpecRepair?.generationRef.sha256 === repair.generationRef.sha256 && result.readonlySpecRepair.acceptedRef.sha256 === owner.resultRef.sha256 ? [{ base, saved }] : []
      }).at(-1)
      if (response) {
        const origin = history.find(origin => origin.number > prior.number && readonlyLocalSource(store, operation, origin, owner.key, response.saved.resultRef, response.base.resultRef))
        if (!origin) fail('readonly_spec_repair_binding', '诊断结算缺少该owner的新P1来源')
        const reviewed = reviewedReadonlyLocal(store, operation, origin, owner.key, response.saved.resultRef, response.base.resultRef, prior.number)
        const original = JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration
        if (canonical(reviewed.partitionBinding) !== canonical(original.partitionBinding) || reviewed.readonlySpecRepair?.baseInputDigest !== (original.readonlySpecRepair?.baseInputDigest ?? original.inputDigest)) fail('readonly_spec_repair_binding', '诊断结算改变了原owner完整输入绑定')
        continue
      }
      const current = approved.result.partitionEvidence?.find(item => item.partitionId === owner.partitionId)
      if (!current || current.resultRef.sha256 !== owner.resultRef.sha256) fail('readonly_spec_repair_binding', '待处理owner缺失或已换ref，不能以另一source响应清除诊断')
      owners.push(owner)
    }
    if (owners.length) { validateReadonlyRepair(store, operation, repair); return { repair, owners } }
  }
  return null
}

function saveStage(store: SyncStore, fence: WriteFence, name: string, value: unknown, basis?: Pick<Stage, 'readSetDigest' | 'baselineSelectionRef'>, composition?: ElaborationComposedBinding): BlobRef {
  const operation = store.readOperation(fence.operationId), commonDir = operation.input.source.commonDir
  const resultRef = writeEvidence(commonDir, value)
  const artifacts = syncCheckpointArtifacts(value, resultRef)
  const bindings = basis ? { readSetDigest: basis.readSetDigest, baselineSelectionRef: basis.baselineSelectionRef } : operation.baselineSelection ? { readSetDigest: operation.readSetDigest, baselineSelectionRef: writeEvidence(commonDir, store.readBusinessBaselineSelection(operation.id)) } : {}
  const guidance = behaviorAnalysisStage(name) && (value as CodeBehaviorAnalysis).reviewPassed === true ? { guidanceContractVersion: CODE_BEHAVIOR_GUIDANCE_VERSION } : {}
  if (bindings.baselineSelectionRef) artifacts.push({ kind: 'json', ref: bindings.baselineSelectionRef })
  store.checkpoint(fence, { ...writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: fence.attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest, ...bindings, ...guidance, ...composition, stage: name, resultRef } satisfies Stage), artifacts })
  return resultRef
}
function analysisStageBinding(store: SyncStore, operation: SyncOperation, analysis: CodeBehaviorAnalysis): Stage | null {
  const digest = contentHash(JSON.stringify(analysis))
  for (const attempt of store.listAttempts(operation.id)) for (const { value } of readSyncCheckpoints(store, operation, attempt).json) {
    const saved = value as Stage
    if (saved.version !== 'sync-stage-v1' || saved.stage !== 'analysis' || saved.operationId !== operation.id || saved.attemptId !== attempt.id || saved.inputId !== operation.input.id || saved.policyDigest !== operation.policyDigest || saved.resultRef?.sha256 !== digest) continue
    if (!operation.baselineSelection) return analysis.readSetDigest === operation.readSetDigest && analysis.baselinePairId === (operation.previousBaselinePair?.id ?? null) ? saved : null
    if (!stageSelectionMatches(store, operation, saved) || saved.readSetDigest !== analysis.readSetDigest || !saved.baselineSelectionRef) continue
    const selected = JSON.parse(readEvidence(operation.input.source.commonDir, saved.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection
    if (analysis.baselineSelectionDigest === selected.digest && analysis.baselinePairId === null) return saved
  }
  return null
}
/** 批准只来自原局部分析与独审，未生成旧whole也可认证。 */
function authenticateApprovedBehaviorPartition(store: SyncStore, source: SyncOperation, origin: SyncAttempt, key: string, local: CodeBehaviorAnalysis, changedPaths: readonly string[], selection: FrozenBaselineSelection | undefined, checkpoints: (attempt: SyncAttempt) => SyncCheckpointStageView, analysisSchemaDigest?: string): boolean {
  const original = checkpoints(origin), commonDir = source.input.source.commonDir
  const analysisDigest = contentHash(JSON.stringify({ ...local, traces: [], reviewPassed: false }))
  if (!local.reviewPassed || local.traces.length !== 2 || local.traces[0].purpose !== 'code_behavior_analyze' || local.traces[1].purpose !== 'code_behavior_review' || local.traces[0].sessionId === local.traces[1].sessionId || local.traces[0].threadId === local.traces[1].threadId) return false
  let reviewOutput: unknown
  if (stage<{ version: string }>(store, source, origin, 'behavior-draft-protocol', 'automatic', original)?.version === 'code-behavior-draft-v1') {
    if (!local.traces.every(trace => behaviorTraceBinding(store, source, origin, key, trace, selection, checkpoints, true))) return false
    const drafts = partitionStage<CodeBehaviorContinuation>(store, source, origin, `${key}:continuation`, selection, original)?.result.drafts
    const draft = drafts?.code_behavior_review
    if (!draft || analysisSchemaDigest !== undefined && (drafts.code_behavior_analyze?.schemaDigest !== analysisSchemaDigest || draft.schemaDigest !== contentHash(JSON.stringify(codeBehaviorReviewSchema(local.inputDigest, analysisDigest))))) return false
    reviewOutput = JSON.parse(readStageDraft(commonDir, draft, draft))
  } else {
    if (analysisSchemaDigest !== undefined) return false
    for (const trace of local.traces) {
      const requestKey = `sync:${origin.id}:analysis:partition:${key.slice('partition:'.length, -':analysis'.length)}:${trace.purpose}`
      const dispatch = origin.dispatchPlans.find(item => item.key === requestKey && item.purpose === trace.purpose && item.session?.sessionId === trace.sessionId && item.session.threadId === trace.threadId && item.session.turnId === trace.turnId)
      if (!dispatch || trace.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey)) return false
      const resource = store.findResource(origin.id, requestKey)
      let result: ElaborationSessionResult | undefined
      if (resource) {
        const native = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString('utf8')) as NativeRunPlan
        const checkpoint = JSON.parse(readEvidence(commonDir, resource.checkpointRef).toString('utf8')) as NativeRunCheckpoint
        if (!checkpoint.result || native.request.model !== syncModel(source)) return false
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
    && new Set(review.checkedChangeIds).size === review.checkedChangeIds.length && review.checkedChangeIds.length === local.changes.length && local.changes.every(change => review.checkedChangeIds.includes(change.id))
}

/** P0-only资格回到原冻结计划、P0 stage和每区真实独审，不依赖P1自报。 */
function authenticateAnalysisOnlyPartitions(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, plan: SyncPartitionPlan, evidence: CodeBehaviorEvidence, owners: readonly AnalysisOnlyPartitionEvidence[]): boolean {
  const whole = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis')
  if (!whole || contentHash(JSON.stringify(whole)) !== evidence.ref.sha256 || whole.inputId !== operation.input.id || whole.policyDigest !== operation.policyDigest || whole.composedDigest !== attempt.composedInput?.contentDigest) return false
  const basis = analysisStageBinding(store, operation, whole)
  if (!basis || basis.guidanceContractVersion !== CODE_BEHAVIOR_GUIDANCE_VERSION) return false
  const p0 = store.readAttempt(basis.attemptId), commonDir = operation.input.source.commonDir
  if (p0.number > attempt.number || p0.composedInput?.contentDigest !== whole.composedDigest) return false
  const selection = basis.baselineSelectionRef ? JSON.parse(readEvidence(commonDir, basis.baselineSelectionRef).toString('utf8')) as FrozenBaselineSelection : undefined
  const source = withCheckpointStageBasis(operation, whole.readSetDigest, selection)
  const history = new Map<string, SyncCheckpointStageView>()
  const checkpoints = (origin: SyncAttempt): SyncCheckpointStageView => {
    const cached = history.get(origin.id) ?? readSyncCheckpointStageIndex(store, origin.operationId === operation.id ? source : store.readOperation(origin.operationId), origin)
    history.set(origin.id, cached)
    return cached
  }
  const planDigest = contentHash(JSON.stringify(plan))
  let ancestors: Map<string, SyncOperation> | undefined
  return owners.every(owner => {
    const member = whole.partitionEvidence?.find(item => item.partitionId === owner.partitionId), key = `partition:${owner.partitionId}:analysis`
    if (!member || member.analysisRef.sha256 !== owner.analysisRef.sha256 || owner.wholeAnalysisRef.sha256 !== evidence.ref.sha256) return false
    let origin = p0, ownerOperation = source
    for (;;) {
      const original = checkpoints(origin)
      const oldPlan = partitionStage<SyncPartitionPlan>(store, ownerOperation, origin, 'partition-plan', selection, original)
      const local = partitionStage<CodeBehaviorAnalysis>(store, ownerOperation, origin, key, selection, original)
      if (oldPlan?.resultRef.sha256 !== planDigest || local?.resultRef.sha256 !== owner.analysisRef.sha256 || origin.composedInput?.contentDigest !== whole.composedDigest) return false
      const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, ownerOperation, origin, `${key}:provenance`, 'automatic', original)
      if (!provenance) break
      if (provenance.resultRef.sha256 !== owner.analysisRef.sha256) return false
      const previous = store.readAttempt(provenance.fromAttemptId)
      if (previous.operationId !== provenance.fromOperationId || !['failed', 'superseded', 'settled'].includes(previous.status)) return false
      if (previous.operationId === ownerOperation.id) {
        if (previous.number >= origin.number) return false
      } else {
        if (ownerOperation.id !== operation.id) return false
        ancestors ??= new Map([...retryOperationLineage(store, operation)].filter(candidate => candidate.id !== operation.id && settledApprovalSource(store, candidate)).map(candidate => [candidate.id, candidate]))
        const ancestor = ancestors.get(previous.operationId)
        if (!ancestor) return false
        ownerOperation = withCheckpointStageBasis(ancestor, whole.readSetDigest, selection)
      }
      origin = previous
    }
    return authenticateApprovedBehaviorPartition(store, ownerOperation, origin, key, member.analysis, member.changedPaths, selection, checkpoints)
  })
}

function authenticatedMixedElaborationCoverage(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, plan: SyncPartitionPlan, result: SavedElaboration): boolean {
  const owners = result.analysisOnlyPartitions, writers = result.partitionEvidence
  if (!owners?.length || !writers?.length || !partitionedElaborationCoverageMatches(plan.partitions.map(partition => partition.id), writers.map(owner => owner.partitionId), owners.map(owner => owner.partitionId))) return false
  const checkpoints = readSyncCheckpoints(store, operation, origin), whole = stage<CodeBehaviorAnalysis>(store, operation, origin, 'analysis', 'automatic', checkpoints)
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

/** 查询与裁决复用同一真实阶段绑定，已审未来 null 资源扩展不篡改原分析原件。 */
export function readCurrentSyncAnalysis(store: SyncStore, operation: SyncOperation): CodeBehaviorEvidence | null {
  if (!operation.currentAttemptId) return null
  const attempt = store.readAttempt(operation.currentAttemptId), analysis = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis', 'evidence')
  if (!analysis?.reviewPassed || analysis.inputId !== operation.input.id || analysis.policyDigest !== operation.policyDigest || analysis.composedDigest !== attempt.composedInput?.contentDigest) return null
  const saved = analysisStageBinding(store, operation, analysis)
  return saved ? { ref: saved.resultRef, analysis } : null
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
export async function candidateContext(operation: SyncOperation, candidate: CandidateRef, elaboration?: Pick<SavedElaboration, 'rounds' | 'partitionSeal'>): Promise<FrozenContracts> {
  const files = new Map<string, string>()
  const entries = verifyCandidate(operation.input.source.commonDir, candidate)
  readTree(operation.input.source.commonDir, candidate.tree, (entry, bytes) => {
    if (entry.mode === '120000' || isHostPrivatePath(entry.path)) return
    if (isUtf8Text(bytes)) files.set(entry.path, bytes.toString('utf8'))
  })
  const reviewed = operation.recordUnverifiedCoverage && elaboration ? new Set(unexecutedAcceptanceIds(elaboration)) : undefined
  return readFrozenContracts(operation.input.source.canonicalRoot, files, new Set(entries.map(entry => entry.path)), reviewed && (id => reviewed.has(id)))
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
async function verificationRetrySource(store: SyncStore, operation: SyncOperation, view: InputView, renew: () => Promise<void>): Promise<{ operation: SyncOperation; attempt: SyncAttempt; generation: SavedGeneration; elaboration: SavedElaboration; analysis: CodeBehaviorEvidence; partitions: SyncPartitionPlan } | null> {
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
  if (first?.failure?.code !== 'verification_unsupported') return null
  function reject(message: string): never { return fail('candidate_retry_binding', message) }
  const candidate = first.candidate
  if (!candidate) reject('原验证失败缺少冻结候选，不能作为续验或重新生成')
  const seen = new Set<string>(), verifiedCarriers: { operation: SyncOperation; attempt: SyncAttempt }[] = []
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
    if (!generation) {
      const history = store.listAttempts(owner.id)
      if (!owner.retryOf || owner.callsUsed !== 0 || owner.delivery !== null || history.length !== 1 || history[0].id !== prior.id || prior.dispatchPlans.length || prior.currentSession !== null) reject('候选续验后继已有模型派发或不完整历史，不能跳过它复用祖先候选')
      if (prior.failure.code !== 'verification_unsupported') {
        verifiedCarriers.push({ operation: owner, attempt: prior })
        owner = store.readOperation(owner.retryOf); continue
      }
    }
    if (prior.failure.code !== 'verification_unsupported' || prior.failure.kind !== 'unsupported') reject('原冻结候选没有V3前置unsupported失败，不能取得续验资格')
    const unsupported = readSyncCheckpoints(store, owner, prior).json.map(({ value }) => value as Stage).filter(value => value.version === 'sync-stage-v1' && value.stage?.startsWith('v3:') && value.operationId === owner.id && value.attemptId === prior.id && value.inputId === owner.input.id && value.policyDigest === owner.policyDigest && stageSelectionMatches(store, owner, value))
    if (unsupported.length !== 1 || !prior.failure.evidenceRefs.some(ref => ref.sha256 === unsupported[0].resultRef.sha256) || stage<VerificationResult>(store, owner, prior, unsupported[0].stage)?.status !== 'unsupported' || store.findResource(prior.id, `verification:${contentHash(`${prior.id}:${unsupported[0].stage.slice(3)}`)}`) || !generation && store.listResources(prior.id).length) reject('续验缺少原V3前置unsupported原件，或原验证已经登记资源')
    if (!generation) { owner = store.readOperation(owner.retryOf!); continue }
    const elaboration = stage<SavedElaboration>(store, owner, prior, 'elaboration'), analysis = readCurrentSyncAnalysis(store, owner)
    const partitions = reviewPlanStage(store, owner, prior, 'candidate-partition-plan')?.result, originalPlan = reviewPlanStage(store, owner, prior, 'partition-plan')?.result
    if (generation.status !== 'reviewed' || !generation.reviewPassed || !generation.candidateValidated || generation.failure || generation.validationFindings.some(finding => finding.severity === 'error') || canonical(generation.candidate) !== canonical(candidate) || !elaboration?.structurePassed || !elaboration.reviewPassed || elaboration.status !== 'complete' || elaboration.failure || !elaborationComposedBinding(store, owner, prior, elaboration, view.composed) || !analysis || !partitions || !originalPlan || !generation.partitionEvidence?.length || !elaboration.partitionEvidence?.length || !analysis.analysis.partitionEvidence?.length) reject('续验需要完整P0、已审P1、V1及全部最终分区独审原件，旧缺席不补签')
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
      if (resource && (JSON.parse(readEvidence(owner.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan).request.model !== syncModel(owner)) reject('原Native模型与候选冻结模型不同')
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
    if (verifiedCarriers.length) {
      const historical = new Set([...(owner.previousBaselinePair?.retiredIds ?? []), ...(owner.baselineSelection ? selectedRetiredIds(store.readBusinessBaselineSelection(owner.id)!) : [])])
      const before = await readFrozenContracts(owner.input.source.canonicalRoot, priorDeliveryFiles({ ...owner, baselineSelection: store.readBusinessBaselineSelection(owner.id) }, view, [...policy.readPaths, ...owner.scope.paths], policy))
      const frozen = await candidateContext(owner, candidate, p1)
      const runs = acceptanceRuns(frozen, owner.readyScope, policy, { before, ids: p1.retiredIds.filter(id => !historical.has(id)) }, unexecutedCandidateIds(owner, frozen, owner.readyScope))
      for (const carrier of verifiedCarriers) {
        await renew()
        const { operation: source, attempt } = carrier, commonDir = source.input.source.commonDir
        const exported = stage<{ path: string; digest: string }>(store, source, attempt, 'export')
        const intent = stage<{ path: string; tree: string; candidateDigest: string }>(store, source, attempt, 'export-intent')
        const resources = store.listResources(attempt.id)
        if (!resources.length || !exported || !intent || intent.path !== exported.path || intent.tree !== candidate.tree || intent.candidateDigest !== candidate.digest || exported.digest !== await verificationExportDigest(exported.path)) reject('候选续验后继缺少原冻结导出或真实已结算验收资源')
        for (const resource of resources) {
          const run = runs.find(run => resource.plan.key === `verification:${contentHash(`${attempt.id}:${run.verificationId}`)}`)
          if (!run || resource.plan.kind !== 'verification' || resource.phase !== 'removed' || resource.operationId !== source.id || resource.attemptId !== attempt.id || resource.generation !== attempt.generation || resource.plan.inputId !== source.input.id || resource.plan.candidateDigest !== candidate.digest) reject('候选续验后继存在未知、未结算或绑定失配的验证资源')
          const request = JSON.parse(readEvidence(commonDir, resource.plan.planBlob).toString()) as Omit<VerificationRequest, 'previousCheckpoint'>
          if (request.runId !== contentHash(`${attempt.id}:${run.verificationId}`) || canonical(request.policy) !== canonical(run.policy) || request.candidateExportPath !== exported!.path || request.candidateExportDigest !== exported!.digest || contentHash(JSON.stringify(request)) !== resource.plan.payloadDigest) reject('候选续验后继原验证请求、政策或导出绑定失配')
          const recovered = await runAttemptVerification(store, fenceFor(source, attempt), request, { driver: async () => reject('只读冷验不得派发验证driver'), onCheckpointRecorded: async () => reject('只读冷验不得写入旧验证checkpoint') })
          const checkpoint = recovered.result.checkpoint, evidence = recovered.result.evidence
          if (recovered.resourceId !== resource.id || recovered.result.status !== 'passed' || !checkpoint || !evidence || checkpoint.notCreated || evidence.outcome !== 'passed' || evidence.exitCode !== 0 || evidence.logsTruncated || evidence.reportFormat !== 'node-test-events-v1' || evidence.runId !== request.runId || evidence.inputDigest !== source.input.id || evidence.candidateDigest !== candidate.digest || evidence.exportDigest !== exported!.digest || evidence.policyDigest !== checkpoint.policyDigest || evidence.configDigest !== checkpoint.configDigest || evidence.runnerDigest !== checkpoint.config.runnerDigest || evidence.containerId !== checkpoint.containerId || canonical(checkpoint.config.policy) !== canonical(run.policy)) reject('候选续验后继原真实验证没有完整passed回执或内容绑定失配')
          const report = parseVerificationReport(evidence.stdout, run.policy.expectedTestIds)
          if (!report.reportComplete || report.reportTruncated || report.unmatchedTestIds.length || report.tests.some(test => test.status !== 'passed') || canonical(report.tests) !== canonical(evidence.tests) || canonical(report.unmatchedTestIds) !== canonical(evidence.unmatchedTestIds) || evidence.reportComplete !== report.reportComplete) reject('候选续验后继原业务测试失败、缺失或报告不完整')
          const terminal = resource.checkpoints.filter(item => item.phase === 'terminal').map(item => JSON.parse(readEvidence(commonDir, item.checkpointRef).toString()) as NonNullable<typeof checkpoint>)
          if (!resource.checkpoints.some(item => item.phase === 'created') || !terminal.length || terminal.some(item => canonical(item.evidence) !== canonical(evidence) || item.configDigest !== checkpoint.configDigest || item.containerId !== checkpoint.containerId)) reject('候选续验后继缺少原真实created及terminal验证回执')
          if (checkpoint.version === 'verification-checkpoint-v2') {
            const transport = checkpoint.transport
            const closed = transport?.closed as { closed?: boolean; rebuildersDrained?: boolean; effects?: { receipt?: { effect: unknown; settled?: boolean; rejected?: string } }[]; fencedNotExecuted?: unknown[] } | undefined
            const cleanup = transport?.cleanup as { effect?: unknown; settled?: boolean; cleaned?: boolean } | undefined
            if (!transport || canonical(transport.plan) !== canonical(checkpoint.config.transport) || transport.attestation?.exportDigest !== exported!.digest || transport.attestation.runnerDigest !== checkpoint.config.runnerDigest || !closed?.closed || !closed.rebuildersDrained || !Array.isArray(closed.effects) || !Array.isArray(closed.fencedNotExecuted) || closed.fencedNotExecuted.length || !cleanup?.settled || !cleanup.cleaned || !transport.effects.some(effect => canonical(effect) === canonical(cleanup.effect)) || transport.effects.filter(effect => effect.kind !== 'cleanup').some(effect => !closed.effects!.some(item => item.receipt?.settled && !item.receipt.rejected && canonical(item.receipt.effect) === canonical(effect)))) reject('候选续验后继缺少原远端closed排空、完整effect或staging移除证明')
          }
        }
      }
    }
    return { operation: owner, attempt: prior, generation: p2, elaboration: p1, analysis: analysis!, partitions: plan }
  }
}

/** 唯一应用编排入口；副作用恢复优先于新生成，四层真实证据通过后才发布。 */
export async function runSyncOperation(store: SyncStore, operationId: string, supplied: SyncCoordinatorOptions): Promise<SyncCoordinatorResult> {
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
    const frozenCandidate = await candidateContext(operation, candidate, elaboration)
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
      if (physicallyPaused()) {
        if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
        return current('paused')
      }
      const active = attempt && !['failed', 'superseded', 'settled'].includes(attempt.status) && attempt.expiresAtMs > Date.now()
      if (!await recoverResources(store, operation, options, !active)) return current('recovery_required')
      if (!active) {
        if (attempt?.failure?.kind === 'repairable') {
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
      const savedRepair = stage<{ repairContext?: typeof repairContext; seed?: ElaborationRepairSeed; refinement?: Refinement; readonlyOwnerRepair?: ReadonlyOwnerRepair }>(store, operation, attempt, 'repair-input')
      if (savedRepair) { repairContext = savedRepair.repairContext; seed = savedRepair.seed; refinement = savedRepair.refinement; readonlyOwnerRepair = savedRepair.readonlyOwnerRepair }
      const frozenReadonlyRepair = readonlyRepairBinding(store, operation, attempt)
      if (frozenReadonlyRepair?.readonlyOwnerRepair) validateReadonlyRepair(store, operation, frozenReadonlyRepair.readonlyOwnerRepair)
      readonlyBase = null; readonlyActiveOwners = []
      if (options.plan.version === 'sync-coordinator-v2') {
        readonlyBase = latestApprovedElaboration(store, operation, attempt.number + 1)
        const pending = pendingReadonlyRepair(store, operation, attempt, readonlyBase)
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
      const retrySource = await verificationRetrySource(store, operation, view, async () => { store.renewLease(fence!, leaseMs); await yieldToControl(); store.renewLease(fence!, leaseMs) })
      if (retrySource) {
        if (attempt.dispatchPlans.length) fail('candidate_retry_binding', '本次重试已有模型派发，不能把原候选当作其新生成或独审结果')
        const { elaboration, analysis, generation, partitions } = retrySource, source = retrySource.operation
        const files = new Map(view.files)
        for (const change of elaboration.nodeChanges ?? []) if (change.action === 'retire' || change.from.path !== change.to.path) files.delete(change.from.path)
        for (const change of elaboration.changes) files.set(change.path, change.source)
        const accepted = await readFrozenContracts(operation.input.source.canonicalRoot, files), candidate = generation.candidate!
        const frozen = await candidateContext(operation, candidate, elaboration)
        const findings = [...frozen.findings, ...await checkCandidateContractIntent(operation, candidate, accepted, frozen, { newNodeRawSources: new Map([...(options.plan.newNodeRawSources ?? []), ...analysis.analysis.newNodes].map(item => [item.path, item.rawSource])), verifications: options.plan.verifications.map(item => item.definition) })]
        for (const oracle of options.plan.mandatoryTests) if (frozen.files.get(oracle.testPath) !== view.files.get(oracle.testPath)) fail('candidate_retry_binding', '续验候选改变原独立oracle')
        if (findings.some(finding => finding.severity === 'error')) fail('candidate_retry_binding', '原冻结候选未通过本次机械V1', [writeEvidence(operation.input.source.commonDir, findings)])
        if (!attempt.candidate) {
          operation = store.startGeneration(fence, { readyScope: source.readyScope, blockedScope: source.blockedScope, blockedReason: source.blockedReason })
          if (retrySource.attempt.publicationBase) {
            await acquirePublication()
            const currentAttempt = store.readAttempt(attempt.id)
            const base = assemblePublicationBase(store, operation, currentAttempt, view.composed, view.readPaths)
            const { operationId: _newOperation, attemptId: _newAttempt, parentCommit: _newMetadata, ...currentBase } = verifyPublicationBase(operation, currentAttempt, base)
            const { operationId: _oldOperation, attemptId: _oldAttempt, parentCommit: _oldMetadata, ...originalBase } = verifyPublicationBase(source, retrySource.attempt, retrySource.attempt.publicationBase)
            if (canonical(currentBase) !== canonical(originalBase)) fail('candidate_retry_binding', '原候选发布基树已变化，不能覆盖新发布')
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
      let reviewContinuation: { attempt: SyncAttempt; plan: SyncPartitionPlan; generation: SavedGeneration; failedReviewKeys: string[] } | undefined
      if (readonlyBase && !readonlyOwnerRepair && !refinement && options.plan.version === 'sync-coordinator-v2') {
        for (const prior of store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse()) {
          const generation = partitionStage<SavedGeneration>(store, operation, prior, 'generation')?.result
          if (!generation) continue
          const approved = stage<SavedElaboration>(store, operation, prior, 'elaboration')
          const originalPlan = reviewPlanStage(store, operation, prior, 'partition-plan')?.result
          const candidatePlan = reviewPlanStage(store, operation, prior, 'candidate-partition-plan')?.result
          const candidate = generation.candidate
          if (!candidate || !generation.candidateValidated || generation.reviewPassed || !(reviewFormatRepairCodes.has(generation.failure?.code ?? '') || completedReviewRepairCodes.has(generation.failure?.code ?? '') || approved && generation.partitionEvidence?.some(evidence => candidateReviewLocationError(evidence.review, approved.changes.flatMap(change => parseContract(change).contract ?? []), generation.p2SpecWritePaths)?.code === 'review_location_format')) || generation.validationFindings.some(finding => finding.severity === 'error') || !approved || writeEvidence(operation.input.source.commonDir, approved).sha256 !== readonlyBase.resultRef.sha256 || !elaborationComposedBinding(store, operation, prior, approved, view.composed) || !originalPlan || !candidatePlan || canonical(candidate.coveredScope.paths) !== canonical(operation.scope.paths)) break
          const reviewKeys = readSyncCheckpoints(store, operation, prior).json.map(({ value }) => value as Stage).filter(value => value.stage?.endsWith(':candidate-review')).map(value => value.stage)
          if (!reviewKeys.length || !reviewKeys.some(key => failedCandidateReviewSource(store, operation, prior, key, candidate, candidatePlan)) || !reviewKeys.every(key => { const result = partitionStage<SavedGeneration>(store, operation, prior, key)?.result; return result?.reviewPassed && result.review?.verdict === 'accept' && !result.failure || failedCandidateReviewSource(store, operation, prior, key, candidate, candidatePlan) })) break
          verifyCandidate(operation.input.source.commonDir, candidate)
          reviewContinuation = { attempt: prior, plan: originalPlan, generation, failedReviewKeys: reviewKeys.filter(key => !partitionStage<SavedGeneration>(store, operation, prior, key)?.result.reviewPassed) }
          repairContext = stage<{ repairContext?: typeof repairContext }>(store, operation, prior, 'repair-input')?.repairContext
          saveStage(store, fence, 'repair-input', { ...repairInput, repairContext })
          break
        }
      }
      const runner = options.runner ? injectedRunner(store, fence, options.runner) : createAttemptRunner(store, fence, { retireSettledWorktrees: true })
      const readonlyAccepted = (key: string, binding: NonNullable<ElaborationResult['partitionBinding']>, inputDigest: string): SavedElaboration | null => {
        if (!readonlyBase || readonlyActiveOwners.some(owner => owner.key === key)) return null
        const approved = readonlyBase!.result
        const expected = approved.partitionEvidence?.find(item => item.partitionId === binding.partitionId)
        if (!expected) return null
        for (const origin of store.listAttempts(operation.id).filter(item => item.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(item.status)).reverse()) {
          const source = readonlyLocalSource(store, operation, origin, key, expected.resultRef, readonlyBase!.resultRef)
          if (!source || !source.result.structurePassed || !source.result.reviewPassed || source.result.failure || source.result.rounds.at(-1)?.review?.verdict !== 'accept' || canonical(source.result.partitionBinding) !== canonical(binding) || (source.result.readonlySpecRepair?.baseInputDigest ?? source.result.inputDigest) !== inputDigest) continue
          saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: origin.id, resultRef: source.resultRef })
          partitionCheckpoints.save(key, source.result)
          return source.result
        }
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
      const historicalStageIndexes = new Map<string, SyncCheckpointStageView>()
      const historyCheckpoints = (owner: SyncOperation, prior: SyncAttempt): SyncCheckpointStageView => {
        const checkpoints = historicalStageIndexes.get(prior.id) ?? readSyncCheckpointStageIndex(store, owner, prior)
        historicalStageIndexes.set(prior.id, checkpoints)
        return checkpoints
      }
      const draftMaterialStage = (owner: SyncOperation, prior: SyncAttempt, key: string): { result: SavedElaboration; resultRef: BlobRef } | null => {
        const checkpoints = historyCheckpoints(owner, prior)
        const exact = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints)
        if (exact || !owner.baselineSelection || owner.id !== operation.id) return exact
        const result = stage<SavedElaboration>(store, owner, prior, key, 'automatic', checkpoints)
        return result ? { result, resultRef: writeEvidence(operation.input.source.commonDir, result) } : null
      }
      const loadElaborationDraft = (key: string, binding?: NonNullable<ElaborationResult['partitionBinding']>, schemaDigest?: string): ElaborationDraft | null => {
        const sources = retryDraftSources(store, operation, attempt!.number)
        for (const { owner, prior } of sources) {
          const source = draftMaterialStage(owner, prior, key)
          if (!source || source.result.phase === 'partitioned_final' || source.result.partitionBinding?.partitionId !== binding?.partitionId) continue
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
        let allowCommitted = false
        if (request?.allowStoppedGitDraft) {
          const saved = stage<{ sourceKind: string; approved: boolean; currentInputDigest: string; currentSeed: StageDraftMaterialRequest['worktree']; schemaDigest: string; draftSha256: string; materialRef: BlobRef }>(store, operation, attempt!, provenanceKey, 'automatic', materialCheckpoints ??= readSyncCheckpoints(store, operation, attempt!))
          if (saved) {
            const packet = JSON.parse(readEvidence(commonDir, saved.materialRef).toString('utf8')) as ElaborationDraftMaterial & { version: string; path: string }
            if (saved.sourceKind !== 'stopped_git_draft' || saved.approved !== false || saved.currentInputDigest !== request.inputDigest || canonical(saved.currentSeed) !== canonical(request.worktree) || saved.schemaDigest !== schemaDigest || schemaDigest !== request.binding.schemaDigest
              || packet.version !== 'stopped-git-draft-v1' || packet.path !== request.binding.path || packet.sourceKind !== 'stopped_git_draft' || typeof packet.source !== 'string' || contentHash(packet.source) !== saved.draftSha256) fail('draft_material_binding', '已冻结的P1提交草稿与本轮owner、seed或原材料摘要不匹配')
            return packet
          }
          const ownerRequestKey = `sync:${attempt!.id}:elaborate${binding ? `:partition:${binding.partitionId}` : ''}:`
          allowCommitted = !attempt!.dispatchPlans.some(dispatch => dispatch.purpose === 'elaboration_generate' && dispatch.key.startsWith(ownerRequestKey))
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
              const state = readRecord(native.expectedSessionId)?.structuredExecution, zcode = native.request.model?.startsWith('zcode:') === true
              const stoppedTransport = zcode && state?.state === 'failed' && state.errorCode === 'native_turn_transport_failed'
              const completedEventsRpc = allowCommitted && zcode && !!state && isZCodeEventsRpcTimeout(state)
              if (native.request.purpose === 'elaboration_generate' && native.request.worktree?.mode === 'edit' && !native.request.frozenContext && state && (zcode || native.request.model?.startsWith('claude:')) && (state.state === 'cancelled' || zcode && state.state === 'failed') && state.cancellation?.nativeStopped && !state.failedWorktree && !state.resultWorktree && !state.rejectedOutput && (!state.errorCode || stoppedTransport || completedEventsRpc) && state.threadId && state.turnId) {
                const proof = authenticateNativeFailure(store, owner, prior, requestKey, { code: completedEventsRpc ? 'native_rpc_timeout' : stoppedTransport ? 'native_turn_transport_failed' : 'failed', message: state.state === 'failed' ? state.error! : prior.failure?.message ?? '', sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, readRecord, true)
                if (completedEventsRpc) assertStoppedEventsRpcDraft(prior, requestKey, proof)
                const context = elaborationMaterialContext(operation.input.source.commonDir, native.request, request)
                if (proof.record.base === native.request.worktree.baseCommit && proof.record.forkCommit === native.request.worktree.baseCommit && /草稿文件=([^\s；。]+)/.exec(native.request.prompt)?.[1] === request.binding.path && context) {
                  let skipSource = false
                  const material = await withArchivedStructuredWorktree(proof.record, (): ElaborationDraftMaterial | null => {
                    const prompt = nativeWorktreePrompt(native.request.prompt, native.request.worktree!)
                    const failed = zcode ? assertZCodeStoppedDraftSource(prompt, (completedEventsRpc ? proof.state : state) as ZCodeStructuredExecution, proof.record.worktreePath) : undefined
                    if (zcode && failed === null) { skipSource = true; return null }
                    if (!zcode) assertClaudeStoppedDraftSource(prompt, state, proof.record.worktreePath)
                    assertMaterialFence()
                    store.assertWriteFence(fence!)
                    const physical = readStoppedPhysicalDraft(commonDir, proof.record.worktreePath, native.request.worktree!, request.binding, { allowCommitted })
                    if (physical && (!completedEventsRpc || physical.committedOid)) {
                      if (zcode && !failed) fail('stale_result', 'ZCode物理细化草稿没有原精确失败终态')
                      const errors = [...existingDraft?.errors ?? [], ...round.findings, ...source.result.failure ? [{ code: source.result.failure.code, message: source.result.failure.message }] : []]
                      if (physical.committedOid) {
                        const material = { source: physical.source, errors, diagnostics: context.diagnostics, sourceKind: 'stopped_git_draft' as const }
                        const materialRef = writeEvidence(commonDir, { version: 'stopped-git-draft-v1', path: request.binding.path, ...material })
                        saveStage(store, fence!, provenanceKey, { sourceKind: material.sourceKind, approved: false, observationKind: zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt: Date.now(), fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), resultCommit: physical.observedHeadCommit, resultTree: physical.observedTree, oid: physical.committedOid, indexSha256: physical.indexSha256, readonlyOverlay: { previous: context.previousReadonlyOverlay, current: context.currentReadonlyOverlay }, materialRef, draftSha256: contentHash(physical.source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: request.inputDigest, currentSeed: request.worktree })
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
        if (!renderedRepairAttempt(prior)) return null
        const source = partitionStage<SavedElaboration>(store, owner, prior, key, undefined, checkpoints), round = source?.result.rounds.at(-1)
        if (!source || source.result.reviewPassed || source.result.phase === 'partitioned_final' || source.result.status !== 'exhausted' || source.result.failure?.code !== 'repair_budget_exhausted' || !round?.candidate || !round.findings.some(finding => finding.severity === 'error' && (!matchesFinding || matchesFinding(finding)))) return null
        if (round.candidate.inputDigest !== source.result.inputDigest || round.candidateDigest !== contentHash(JSON.stringify(round.candidate))) fail('review_retry_binding', '已生成P1候选的原输入或摘要失配，不能回退为重新生成')
        const generation = elaborationGenerationSource(store, owner, prior, round)
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
      const loadElaborationRepairDiagnostics = (key: string, inputDigest: string, binding?: NonNullable<ElaborationResult['partitionBinding']>): ElaborationRepairDiagnostics | null => {
        const ownerSuffix = `elaborate${binding ? `:partition:${binding.partitionId}` : ''}`
        const hasOwnerGeneration = (origin: SyncAttempt): boolean => origin.dispatchPlans.some(dispatch => dispatch.purpose === 'elaboration_generate' && dispatch.key.startsWith(`sync:${origin.id}:${ownerSuffix}:`))
        let newerGeneration = hasOwnerGeneration(attempt!)
        const carriedGenerations = new Set<string | undefined>()
        for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse()) {
          if (!['failed', 'superseded', 'settled'].includes(prior.status)) return null
          const saved = stage<SavedElaboration>(store, operation, prior, key)
          const source = binding ? partitionElaborationStage(store, operation, prior, key, binding, inputDigest) : partitionStage<SavedElaboration>(store, operation, prior, key)
          if (saved && (!source || saved.inputDigest !== inputDigest || saved.phase === 'partitioned_final' || saved.reviewPassed)) return null
          const failure = source?.result.failure, round = source?.result.rounds.at(-1), requestKey = `sync:${prior.id}:${ownerSuffix}`
          if (!newerGeneration && source && round && failure
            && (!carriedGenerations.size || carriedGenerations.size === 1 && carriedGenerations.has(canonical(round.traces.find(trace => trace.purpose === 'elaboration_generate'))))
            && (prior.failure?.kind === 'repairable' || prior.status === 'superseded' && !prior.failure)
            && (failure.code === 'native_rpc_timeout' || reviewFormatRepairCodes.has(failure.code)) && priorElaborationInputMatches(prior, binding)) {
            const settledReview = settledElaborationReview(store, operation, prior, requestKey, source.result, round, failure)
            if (settledReview) {
              saveStage(store, fence!, `${key}:repair-diagnostics-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
              return { requestKey, inputDigest, resultRef: source.resultRef, failure, round, settledReview }
            }
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
        return null
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
      let p0StatusOnly = false
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
        const frozen = stage<{ committedDraft?: ElaborationDraft; currentSeed?: StageDraftMaterialRequest['worktree']; currentInputDigest: string; draftSha256: string }>(store, operation, attempt!, materialKey)
        if (frozen?.committedDraft) {
          assertMaterialFence()
          if (frozen.currentInputDigest !== inputDigest || canonical(frozen.currentSeed) !== canonical(request.worktree) || frozen.committedDraft.sourceInputId !== binding.sourceInputId) fail('behavior_draft_material_binding', '已冻结的P0提交草稿与本轮owner、seed或输入不匹配')
          const source = readStageDraft(commonDir, frozen.committedDraft, binding)
          if (contentHash(source) !== frozen.draftSha256) fail('behavior_draft_material_binding', '已冻结的P0提交草稿与原字节摘要不匹配')
          return { source, errors: frozen.committedDraft.errors, sourceKind: 'git_draft' }
        }
        const allowCommitted = purpose === 'code_behavior_analyze' && !attempt!.dispatchPlans.some(dispatch => dispatch.key === `sync:${attempt!.id}:analysis${suffix}:${purpose}`)
        const sources = retryDraftSources(store, operation, attempt!.number)
        const existingIndex = existingDraft ? sources.findIndex(({ owner, prior }) => {
          const saved = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`)?.result.drafts[purpose as keyof CodeBehaviorContinuation['drafts']]
          return !!saved && canonical(p0StatusOnly ? codeBehaviorDraftStatus(saved) : saved) === canonical(p0StatusOnly ? codeBehaviorDraftStatus(existingDraft) : existingDraft)
            && authenticatedDraftResult(store, owner, prior, `sync:${prior.id}:analysis${suffix}:${purpose}`, purpose, saved)
        }) : -1
        for (const [sourceIndex, { owner, prior }] of sources.entries()) {
          if (existingDraft && (existingIndex < 0 || sourceIndex >= existingIndex)) continue
          if (owner.id === operation.id && (prior.baselineSelectionDigest ?? null) !== (operation.baselineSelection?.digest ?? null) || canonical(prior.composedInput) !== canonical(view.composed) || planDigest && partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan')?.result.digest !== planDigest) continue
          const continuation = partitionStage<CodeBehaviorContinuation>(store, owner, prior, `${key}:continuation`)
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
                const { pendingAnalysis: reviewed, task } = readCodeBehaviorContext(reviewRequest, commonDir)
                if (!reviewed) fail('behavior_review_material_binding', '业务续修缺少原完整待审分析')
                if (outputErrors(review, JSON.parse(readObject(commonDir, reviewSchema.oid).toString()) as Record<string, unknown>).length || reviewRequest.inputDigest !== continuation!.result.inputDigest || review.inputDigest !== inputDigest || reviewed.analysis.inputDigest !== inputDigest || review.analysisDigest !== reviewed.analysisDigest || reviewed.analysisDigest !== contentHash(JSON.stringify(reviewed.analysis))
                  || (task.requiredChangedPaths as string[]).some(path => !review.checkedPaths.includes(path)) || new Set(review.checkedPaths).size !== review.checkedPaths.length || new Set(review.checkedChangeIds).size !== reviewed.analysis.changes.length || review.checkedChangeIds.some(id => !reviewed.analysis.changes.some(change => change.id === id))) fail('behavior_review_material_binding', '业务续修诊断未绑定原完整分析、schema或独审范围')
                if (review.verdict === 'repair' && review.findings.length) errors.push({ code: 'behavior_review_failed', message: JSON.stringify({ approved: false, review }) })
              }
              saveStage(store, fence!, `${key}:${purpose}:draft-material-provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: continuation!.resultRef, resultCommit: materialDraft.resultCommit, oid: materialDraft.oid })
              return { source, errors, sourceKind: 'git_draft' }
            }
          }
          const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
          const requestKey = `sync:${prior.id}:analysis${suffix}:${purpose}`, resource = store.findResource(prior.id, requestKey)
          if (!resource || resource.phase !== 'removed' || resource.plan.inputId !== operation.input.id) continue
          const native = JSON.parse(readEvidence(operation.input.source.commonDir, resource.plan.planBlob).toString()) as NativeRunPlan
          const checkpoint = JSON.parse(readEvidence(operation.input.source.commonDir, resource.checkpointRef).toString()) as NativeRunCheckpoint
          if (native.request.worktree?.mode === 'edit' && (native.request.model?.startsWith('claude:') || native.request.model?.startsWith('zcode:')) && native.request.purpose === purpose && !native.request.frozenContext) {
            const state = readRecord(native.expectedSessionId)?.structuredExecution
            const zcode = native.request.model?.startsWith('zcode:') === true
            const completedEventsRpc = zcode && !!state && isZCodeEventsRpcTimeout(state)
            const stoppedTransport = zcode && state?.state === 'failed' && state.errorCode === 'native_turn_transport_failed'
            if (!state || state.state !== 'cancelled' && !(zcode && state.state === 'failed') || !state.cancellation?.nativeStopped || !(zcode ? state.zcodeNative : state.claudeNative) || !state.threadId || !state.turnId || !checkpoint.session.threadId || !checkpoint.session.turnId || state.failedWorktree || state.resultWorktree || state.rejectedOutput || state.errorCode && !completedEventsRpc && !stoppedTransport) continue
            const proof = authenticateNativeFailure(store, owner, prior, requestKey, { code: completedEventsRpc ? 'native_rpc_timeout' : stoppedTransport ? 'native_turn_transport_failed' : 'failed', message: state.state === 'failed' ? state.error! : prior.failure?.message ?? '', sessionId: checkpoint.session.sessionId, threadId: checkpoint.session.threadId ?? undefined, turnId: checkpoint.session.turnId ?? undefined }, readRecord, true)
            if (completedEventsRpc) assertStoppedEventsRpcDraft(prior, requestKey, proof)
            const seedEntries = readTree(operation.input.source.commonDir, native.request.worktree.tree)
            const schema = seedEntries.find(entry => entry.path === binding.path.replace(/\.json$/, '.schema.json'))
            if (proof.record.base !== native.request.worktree.baseCommit || proof.record.forkCommit !== native.request.worktree.baseCommit || /草稿文件=([^\s；]+)/.exec(native.request.prompt)?.[1] !== binding.path || !schema || schema.mode !== '100644' || contentHash(readObject(operation.input.source.commonDir, schema.oid)) !== schemaDigest || !matchesMaterialTask(native.request)) continue
            const protectedEntries = (tree: string) => readTree(operation.input.source.commonDir, tree).filter(entry => entry.path !== binding.path && entry.path !== binding.path.replace(/\.json$/, '.schema.json') && entry.path !== binding.path.replace(/\.json$/, '.context.json'))
            if (!request.worktree || canonical(protectedEntries(native.request.worktree.tree)) !== canonical(protectedEntries(request.worktree.tree))) continue
            const allowUnpublishedCompletion = zcode && proof.observedFailure
              && checkpoint.status === 'cancelled' && checkpoint.nativeState === 'cancelled' && checkpoint.stop?.nativeStatus === 'stopped' && !checkpoint.result && !checkpoint.failure
              && proof.record.harnessSessionId === checkpoint.session.threadId && canonical(prior.dispatchPlans.find(dispatch => dispatch.key === requestKey)?.session) === canonical(checkpoint.session)
            const material = await withArchivedStructuredWorktree(proof.record, (): ElaborationDraftMaterial | null => {
              if (allowUnpublishedCompletion) assertMaterialFence()
              const prompt = nativeWorktreePrompt(native.request.prompt, native.request.worktree!)
              const zcodeFailed = zcode ? assertZCodeStoppedDraftSource(prompt, (completedEventsRpc ? proof.state : state) as ZCodeStructuredExecution, proof.record.worktreePath, allowUnpublishedCompletion) : undefined
              if (zcode && zcodeFailed === null) return null
              if (!zcode) assertClaudeStoppedDraftSource(prompt, state, proof.record.worktreePath)
              assertMaterialFence()
              let physical: ReturnType<typeof readStoppedPhysicalDraft>
              try {
                physical = completedEventsRpc ? null : readStoppedPhysicalDraft(commonDir, proof.record.worktreePath, native.request.worktree!, binding, { allowCommitted })
              } catch (error) {
                if (purpose !== 'code_behavior_review' || !(error instanceof StoppedPhysicalDraftStatusError)) throw error
                saveStage(store, fence!, `${key}:${purpose}:stopped-physical-material-rejection`, { reason: 'outside-owner-status', fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef })
                return null
              }
              if (physical && !physical.committedOid) {
                if (zcode && !zcodeFailed) fail('stale_result', 'ZCode物理草稿没有原精确失败终态')
                const context = readCodeBehaviorContext(native.request, operation.input.source.commonDir)
                const materialRef = writeEvidence(operation.input.source.commonDir, { version: 'stopped-physical-draft-v1', path: binding.path, source: physical.source })
                saveStage(store, fence!, `${key}:${purpose}:stopped-physical-material-provenance`, { sourceKind: 'physical_draft', approved: false, observationKind: zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt: Date.now(), fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: p0StatusOnly && prior.failure ? { code: prior.failure.code, kind: prior.failure.kind } : prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), observedHeadCommit: physical.observedHeadCommit, observedTree: physical.observedTree, indexSha256: physical.indexSha256, materialRef, draftSha256: contentHash(physical.source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest })
                return { source: physical.source, errors: [...context.errors], repairDiagnostics: context.repairDiagnostics, sourceKind: 'physical_draft' }
              }
              const worktree = native.request.worktree!
              const witness = physical?.committedOid
                ? { baseCommit: worktree.baseCommit, baseTree: worktree.tree, headCommit: physical.observedHeadCommit, tree: physical.observedTree, worktreePath: proof.record.worktreePath }
                : nativeWorktreeResult(proof.record.worktreePath, worktree)
              if (witness.headCommit === native.request.worktree!.baseCommit || zcode && witness.tree === witness.baseTree) return null
              if (zcode && !zcodeFailed) fail('stale_result', 'ZCode新Git材料没有原精确失败终态')
              const format = !zcode && proof.observedFailure ? observeClaudeStoppedWorktreeFailure(prompt, state, proof.record.worktreePath) : undefined
              const draft = captureStageDraft(operation.input.source.commonDir, native.request.worktree!, { worktree: witness }, binding)
              const source = readStageDraft(operation.input.source.commonDir, draft, binding), observedAt = Date.now()
              const context = completedEventsRpc ? readCodeBehaviorContext(native.request, operation.input.source.commonDir) : undefined
              const errors = context && [...context.errors]
              if (errors) {
                const rpc = { code: 'native_rpc_timeout', message: proof.state.error! }
                if (!errors.some(error => canonical(error) === canonical(rpc))) errors.push(rpc)
              }
              const materialErrors = p0StatusOnly ? [] : errors ?? (zcode ? [...readCodeBehaviorContext(native.request, commonDir).errors] : format ? [{ code: format.code, message: format.message }] : [])
              saveStage(store, fence!, materialKey, { sourceKind: 'git_draft', approved: false, observationKind: format ? 'missing-final' : zcode || proof.observedFailure ? 'native-failure' : 'pause', observedAt, fromOperationId: owner.id, fromAttemptId: prior.id, nativePlanRef: resource.plan.planBlob, checkpointRef: resource.checkpointRef, originalFailure: p0StatusOnly && prior.failure ? { code: prior.failure.code, kind: prior.failure.kind } : prior.failure, canonicalRecordSha256: contentHash(JSON.stringify(proof.record)), resultCommit: draft.resultCommit, resultTree: draft.resultTree, oid: draft.oid, draftSha256: contentHash(source), schemaDigest, originalInputDigest: native.request.inputDigest, currentInputDigest: inputDigest, ...(physical?.committedOid ? { committedDraft: { ...draft, errors: materialErrors }, currentSeed: request.worktree, indexSha256: physical.indexSha256 } : {}) })
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
        return null
      }
      const loadBehaviorContinuation = (key: string, inputDigest: string, planDigest?: string): CodeBehaviorContinuation | null => {
        const current = stage<CodeBehaviorContinuation>(store, operation, store.readAttempt(attempt!.id), `${key}:continuation`)
        if (current) {
          if (current.inputDigest !== inputDigest) fail('behavior_continuation_binding', '当前P0草稿与完整业务输入不匹配')
          if (current.readyAnalysis && !behaviorTraceBinding(store, operation, store.readAttempt(attempt!.id), key, current.readyAnalysis.trace)) fail('behavior_continuation_binding', '当前P0分析原件没有精确Native/Git来源证明')
          return current
        }
        const priorAttempts = store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status))
        for (const prior of priorAttempts.reverse()) {
          const source = partitionStage<CodeBehaviorContinuation>(store, operation, prior, `${key}:continuation`)
          if (!source || source.result.inputDigest !== inputDigest || stage<{ version: string }>(store, operation, prior, 'behavior-draft-protocol')?.version !== 'code-behavior-draft-v1') continue
          if (planDigest && partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan')?.result.digest !== planDigest) continue
          const trace = source.result.readyAnalysis?.trace
          const suffix = key === 'analysis' ? '' : `:partition:${key.slice('partition:'.length, -':analysis'.length)}`
          if (Object.entries(source.result.drafts).some(([purpose, draft]) => !(purpose === 'code_behavior_analyze' && trace) && !authenticatedDraftResult(store, operation, prior, `sync:${prior.id}:analysis${suffix}:${purpose}`, purpose, draft) && !(purpose === 'code_behavior_analyze' && behaviorAnalysisDraftBinding(store, operation, prior, key, draft, planDigest, p0StatusOnly)))) continue
          if (trace && !behaviorTraceBinding(store, operation, prior, key, trace)) fail('behavior_continuation_binding', 'P0已校验分析没有原生派发身份')
          saveStage(store, fence!, `${key}:continuation-provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          const continuation = p0StatusOnly ? codeBehaviorContinuationStatus(source.result) : source.result
          saveStage(store, fence!, `${key}:continuation`, continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined)
          return continuation
        }
        return null
      }
      const loadBehaviorReviewFeedback = (key: string, inputDigest: string, planDigest?: string): CodeBehaviorReviewReference | null => {
        assertMaterialFence()
        const priorAttempts = store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status))
        for (const prior of priorAttempts.reverse()) {
          const source = partitionStage<CodeBehaviorContinuation>(store, operation, prior, `${key}:continuation`)
          if (!source || source.result.inputDigest !== inputDigest || planDigest && partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan')?.result.digest !== planDigest) continue
          const review = source.result.reviewResult, draft = source.result.drafts.code_behavior_review
          if (!review || !draft) continue
          const { trace } = review
          if (!prior.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId)) {
            const provenance = stage<{ fromOperationId: string; fromAttemptId: string; resultRef: BlobRef }>(store, operation, prior, `${key}:continuation-provenance`)
            const origin = provenance && priorAttempts.find(candidate => candidate.id === provenance.fromAttemptId && candidate.number < prior.number)
            const original = origin && partitionStage<CodeBehaviorContinuation>(store, operation, origin, `${key}:continuation`)
            const originalDraft = original?.result.drafts.code_behavior_review
            if (!provenance || provenance.fromOperationId !== operation.id || !original || original.resultRef.sha256 !== provenance.resultRef.sha256
              || original.result.inputDigest !== inputDigest || canonical(original.result.reviewResult) !== canonical(review)
              || !originalDraft || canonical(codeBehaviorDraftStatus(originalDraft)) !== canonical(codeBehaviorDraftStatus(draft))) fail('behavior_review_material_binding', '业务续修缺少原独审continuation来源')
            continue
          }
          if (trace.purpose !== 'code_behavior_review' || !behaviorTraceBinding(store, operation, prior, key, trace)) fail('behavior_review_material_binding', '业务续修缺少原独审Native/Git身份')
          if (source.result.readyAnalysis) return null
          const output = JSON.parse(readObject(operation.input.source.commonDir, draft.oid).toString()) as { verdict: string; findings: unknown[] }
          if (output.verdict === 'repair' && output.findings.length) return { commit: draft.resultCommit, path: draft.path }
          return null
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
            || ![interfaceSeed ? 'interface_seed' : 'complete', 'needs_input', 'conflict'].includes(result.status) || !authenticatedApprovedElaboration(store, owner, prior, result)) continue
          assertMaterialFence()
          saveStage(store, fence!, `${key}:provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef })
          partitionCheckpoints.save(key, result)
          return result
        }
        return null
      }
      const partitionCheckpoints: PartitionCheckpoints = {
        load: <T>(key: string) => stage<T>(store, operation, store.readAttempt(attempt!.id), key),
        elaborationDraftTagged: (key, result) => elaborationDraftTagged(store, operation, store.readAttempt(attempt!.id), key, result),
        loadAcceptedCandidateReview: (key, plan, input, candidate, builders, current) => {
          if (signal.aborted) return null
          verifyCandidate(operation.input.source.commonDir, candidate)
          const currentAttempt = store.readAttempt(attempt!.id)
          const replayInput = (previous: GenerationInput | null): GenerationInput => {
            if (repairContext || readonlyOwnerRepair || refinement || input.repairContext || !previous?.repairContext) return input
            const previousDigest = freezeGenerationInput({ ...previous, requestKey: input.requestKey, repairContext: undefined }).inputDigest
            if (previousDigest !== freezeGenerationInput(input).inputDigest) return input
            return { ...input, repairContext: previous.repairContext }
          }
          const provenance = current ? stage<AcceptedReviewProvenance>(store, operation, currentAttempt, `${key}:provenance`) : null
          if (current) {
            if (!provenance) {
              if (current.traces.every(trace => currentAttempt.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId))) return current
              fail('accepted_review_binding', '历史独审拷贝缺少完整当前输入及来源证明')
            }
            const local = partitionStage<SavedGeneration>(store, operation, currentAttempt, key)
            const carried = local && acceptedReviewInput(store, operation, currentAttempt, key, local.resultRef)
            const origin = store.readAttempt(provenance.fromAttemptId), expected = replayInput(carried)
            const source = carried && origin.number < currentAttempt.number && acceptedCandidateReviewSource(store, operation, origin, key, candidate, plan, expected)
            if (!carried || freezeGenerationInput(carried).inputDigest !== freezeGenerationInput(expected).inputDigest || !source || source.resultRef.sha256 !== provenance.resultRef.sha256 || canonical(source.result) !== canonical(current) || source.result.traces.some(trace => builders.some(builder => builder.sessionId === trace.sessionId || builder.threadId === trace.threadId))) fail('accepted_review_binding', '缓存独审原件缺少精确当前输入或原始请求/来源证明')
            return source.result
          }
          for (const prior of store.listAttempts(operation.id).filter(prior => prior.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(prior.status)).reverse()) {
            const saved = partitionStage<SavedGeneration>(store, operation, prior, key), original = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, prior, `${key}:input`)?.result
            const expected = replayInput(original ? restoreGenerationInput(original) : saved ? acceptedReviewInput(store, operation, prior, key, saved.resultRef) : null)
            const source = acceptedCandidateReviewSource(store, operation, prior, key, candidate, plan, expected)
            if (!source || source.result.traces.some(trace => builders.some(builder => builder.sessionId === trace.sessionId || builder.threadId === trace.threadId))) continue
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: source.attempt.id, resultRef: source.resultRef, inputRef: writeEvidence(operation.input.source.commonDir, freezeGenerationInput(expected).inputEvidence) })
            partitionCheckpoints.save(key, source.result)
            return source.result
          }
          return null
        },
        loadCandidateReviewRepair: (key, plan, input, candidate) => {
          if (!reviewContinuation) return null
          const origin = reviewContinuation.attempt
          const saved = partitionStage<ReturnType<typeof freezeGenerationInput>['inputEvidence']>(store, operation, origin, `${key}:input`)?.result
          const accepted = !saved && partitionStage<SavedGeneration>(store, operation, origin, key)
          const previous = saved ? restoreGenerationInput(saved) : accepted ? acceptedReviewInput(store, operation, origin, key, accepted.resultRef) : null
          if (previous?.reviewRepair) {
            const carried = { ...input, reviewRepair: previous.reviewRepair }
            if (freezeGenerationInput({ ...previous, requestKey: input.requestKey }).inputDigest === freezeGenerationInput(carried).inputDigest && acceptedCandidateReviewSource(store, operation, origin, key, candidate, plan, carried)) return previous.reviewRepair
          }
          return failedCandidateReviewSource(store, operation, origin, key, candidate, plan, input)
        },
        authenticateAnalysisOnly: (plan, evidence, owners) => authenticateAnalysisOnlyPartitions(store, operation, store.readAttempt(attempt!.id), plan, evidence, owners),
        loadBehaviorDraftMaterial: (key, planDigest, purpose, schemaDigest, inputDigest, request, existingDraft) => loadBehaviorDraftMaterial(key, purpose, schemaDigest, inputDigest, request, planDigest, existingDraft),
        loadBehaviorContinuation: (key, planDigest, inputDigest) => loadBehaviorContinuation(key, inputDigest, planDigest),
        loadBehaviorReviewFeedback: (key, planDigest, inputDigest) => loadBehaviorReviewFeedback(key, inputDigest, planDigest),
        loadAcceptedAnalysis: (key, plan, inputDigest, binding) => {
          for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(item.status))) {
            const source = partitionStage<CodeBehaviorAnalysis>(store, operation, prior, key)
            const priorPlan = source ? partitionStage<SyncPartitionPlan>(store, operation, prior, 'partition-plan') : null
            if (!source || priorPlan?.result.digest !== plan.digest || !source.result.reviewPassed || source.result.inputDigest !== inputDigest || source.result.inputId !== operation.input.id || source.result.policyDigest !== operation.policyDigest || source.result.readSetDigest !== operation.readSetDigest || source.result.composedDigest !== view.composed.contentDigest) continue
            if (source.result.traces.length !== 2 || !source.result.traces.every(trace => stage<{ version: string }>(store, operation, prior, 'behavior-draft-protocol')?.version === 'code-behavior-draft-v1' ? behaviorTraceBinding(store, operation, prior, key, trace) : prior.dispatchPlans.some(dispatch => dispatch.purpose === trace.purpose && dispatch.session?.sessionId === trace.sessionId && dispatch.session.threadId === trace.threadId && dispatch.session.turnId === trace.turnId))) continue
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: operation.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            partitionCheckpoints.save(key, source.result)
            return source.result
          }
          if (!operation.retryOf) return null
          approvalAncestors ??= retryDraftSources(store, operation, attempt!.number).filter(({ owner }) => owner.id !== operation.id && settledApprovalSource(store, owner))
          const planRef = contentHash(JSON.stringify(plan)), selection = store.readBusinessBaselineSelection(operation.id)
          for (const { owner, prior } of approvalAncestors) {
            if (canonical(prior.composedInput) !== canonical(view.composed)) continue
            const checkpoints = (origin: SyncAttempt): SyncCheckpointStageView => historyCheckpoints(owner, origin)
            const original = checkpoints(prior), savedPlan = partitionStage<SyncPartitionPlan>(store, owner, prior, 'partition-plan', selection, original)
            if (savedPlan?.resultRef.sha256 !== planRef) continue
            const source = partitionStage<CodeBehaviorAnalysis>(store, owner, prior, key, selection, original)
            if (!source || source.result.inputDigest !== inputDigest || source.result.inputId !== operation.input.id || source.result.policyDigest !== operation.policyDigest || source.result.readSetDigest !== operation.readSetDigest || source.result.composedDigest !== view.composed.contentDigest) continue
            if (!authenticateApprovedBehaviorPartition(store, owner, prior, key, source.result, binding.changedPaths, selection, checkpoints, binding.analysisSchemaDigest)) continue
            assertMaterialFence()
            saveStage(store, fence!, `${key}:provenance`, { fromOperationId: owner.id, fromAttemptId: prior.id, resultRef: source.resultRef })
            return source.result
          }
          return null
        },
        loadAcceptedElaboration: (key, binding, inputDigest) => {
          const readonly = readonlyAccepted(key, binding, inputDigest)
          if (readonly) return readonly
          for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number && ['failed', 'superseded', 'settled'].includes(item.status))) {
            const source = partitionElaborationStage(store, operation, prior, key, binding, inputDigest)
            if (!source || !source.result.structurePassed || !source.result.reviewPassed || source.result.failure || source.result.phase !== undefined || !['complete', 'needs_input', 'conflict'].includes(source.result.status) || source.result.rounds.at(-1)?.review?.verdict !== 'accept') continue
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
            const generation = elaborationGenerationSource(store, operation, origin, round)
            if (!generation) fail('readonly_spec_repair_binding', '事实继承缺少原已批准owner的真实generation来源')
            const protocol = stage<{ generationGuidance?: ElaborationGenerationGuidance }>(store, operation, generation.attempt, 'elaboration-draft-protocol')
            return protocol?.generationGuidance === ELABORATION_GENERATION_GUIDANCE
          }
          return false
        },
        loadReadonlySpecRepair: (key, binding, inputDigest, localInput) => {
          const owner = readonlyActiveOwners.find(owner => owner.key === key)
          if (!owner) return null
          const sourceAttempt = store.readAttempt(owner.fromAttemptId)
          const prior = reviewedReadonlyLocal(store, operation, sourceAttempt, key, owner.resultRef, readonlyOwnerRepair!.priorRef), round = prior.rounds.at(-1)!
          const protocol = stage<{ generationGuidance?: ElaborationGenerationGuidance }>(store, operation, sourceAttempt, 'elaboration-draft-protocol')
          const priorInput = { ...localInput, generationGuidance: protocol?.generationGuidance }
          if (canonical(prior.partitionBinding) !== canonical(binding) || (prior.readonlySpecRepair?.baseInputDigest ?? prior.inputDigest) !== freezeElaborationInput(priorInput).inputDigest) fail('readonly_spec_repair_binding', '只读owner原件不匹配当前完整局部输入')
          const ids = new Set(prior.changes.flatMap(change => parseContract(change).contract!.items.map(item => item.id)))
          const findings = readonlyOwnerRepair!.findings.filter(finding => prior.changes.some(change => change.nodeId === finding.nodeId && change.path === finding.path))
            .map(finding => localInput.generationGuidance === ELABORATION_GENERATION_GUIDANCE && finding.relatedIds ? { ...finding, relatedIds: finding.relatedIds.filter(id => ids.has(id)) } : finding)
          if (prior.changes.some(change => !within(change.path, options.plan.writePaths) || options.plan.mandatoryTests.some(test => overlap(change.path, test.testPath)))) fail('readonly_spec_repair_binding', '只读V1 owner目标越过冻结授权')
          saveStage(store, fence!, `${key}:readonly-repair-provenance`, { fromAttemptId: sourceAttempt.id, resultRef: owner.resultRef, generationRef: readonlyOwnerRepair!.generationRef })
          return { prior, priorInput, repair: { ...(readonlyOwnerRepair!.kind ? { kind: readonlyOwnerRepair!.kind, reviewEvidence: readonlyOwnerRepair!.reviewEvidence } : {}), baseInputDigest: inputDigest, candidateDigest: readonlyOwnerRepair!.candidateDigest, generationRef: readonlyOwnerRepair!.generationRef, acceptedRef: owner.resultRef, changes: prior.changes, output: round.output, review: round.review, findings } }
        },
        loadPartitionSealRepair: async (key, binding, inputDigest) => {
          const source = await loadSealRepairSource()
          assertMaterialFence()
          const local = source?.locals.get(binding.partitionId), findings = source?.owners.get(binding.partitionId)
          if (!source || !local || !findings) return null
          store.assertWriteFence(fence!)
          const prior = local.result, round = prior.rounds.at(-1)!
          if (canonical(prior.partitionBinding) !== canonical(binding) || (prior.readonlySpecRepair?.baseInputDigest ?? prior.inputDigest) !== inputDigest) return null
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
        loadElaborationDraft: (key, binding, schemaDigest) => loadElaborationDraft(key, binding, schemaDigest),
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
          saveStage(store, fence, 'review-plan-provenance', { fromAttemptId: reviewContinuation.attempt.id, resultRef: writeEvidence(operation.input.source.commonDir, partitions) })
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
        const challenged = (value: CodeBehaviorAnalysis): boolean => postGateReview.some(diagnostic => [writeEvidence(operation.input.source.commonDir, value).sha256, ...value.partitionEvidence?.map(owner => owner.analysisRef.sha256) ?? []].includes(diagnostic.analysisRef.sha256))
        let approved = stage<CodeBehaviorAnalysis>(store, operation, attempt, 'analysis')
        if (approved && challenged(approved)) approved = null
        if (!approved) for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number).reverse()) {
          store.renewLease(fence, leaseMs); await yieldToControl(); store.renewLease(fence, leaseMs)
          const previous = stage<CodeBehaviorAnalysis>(store, operation, store.readAttempt(prior.id), 'analysis')
          const binding = previous ? analysisStageBinding(store, operation, previous) : null
          if (previous?.reviewPassed && !challenged(previous) && binding && previous.inputId === operation.input.id && previous.policyDigest === operation.policyDigest && previous.composedDigest === view.composed.contentDigest) { approved = previous; saveStage(store, fence, 'analysis-provenance', { fromAttemptId: prior.id, analysisRef: writeEvidence(operation.input.source.commonDir, previous), baselineSelectionRef: binding.baselineSelectionRef }); saveStage(store, fence, 'analysis', approved, binding); break }
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
          let behaviorProtocol = stage<{ version: 'code-behavior-draft-v1'; contextTransport?: CodeBehaviorContextTransport }>(store, operation, attempt, 'behavior-draft-protocol')
          if (behaviorProtocol && Object.hasOwn(behaviorProtocol, 'contextTransport') && !isCodeBehaviorContextTransport(behaviorProtocol.contextTransport)) fail('behavior_context_transport_unsupported', '持久P0 contextTransport字段存在但不受支持；仅字段缺席允许legacy运输')
          if (!behaviorProtocol && options.plan.agentWorkflow && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('code_behavior_'))) {
            behaviorProtocol = { version: 'code-behavior-draft-v1', contextTransport: 'git-json-v4' }
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
          try { const analysisInput: import('./code-behavior.js').CodeBehaviorInput = { ...(draftProtocol ? { draftProtocol } : {}), ...(behaviorProtocol?.contextTransport ? { contextTransport: behaviorProtocol.contextTransport } : {}), model, snapshot: operation.input, baseline: operation.previousBaselinePair, ...(operation.baselineSelection ? { baselineSelection: store.readBusinessBaselineSelection(operation.id) } : {}), composed: view.composed, readSetDigest: operation.readSetDigest, policyDigest: operation.policyDigest, plan: operation.baselineSelection ? { ...options.plan, readPaths: view.readPaths } : options.plan, requestKey: `sync:${attempt.id}:analysis`, timeoutMs: callTimeoutMs, signal, origin: operation.origin, ...(decision && previousDecisionAnalysis ? { decision: { request: decision, previous: previousDecisionAnalysis, previousComposed: previousDecisionComposed, previousReadPaths: previousDecisionReadPaths } } : {}), repairDiagnostics, postGateReview }; approved = partitions ? await analyzeSyncPartitions(analysisInput, partitions, options.plan.version === 'sync-coordinator-v2' ? options.plan.partitionPolicy.maxParallel : 1, runner, partitionCheckpoints) : await analyzeCodeBehavior(analysisInput, runner, undefined, { loadReviewFeedback: inputDigest => loadBehaviorReviewFeedback('analysis', inputDigest), loadMaterial: (purpose, schemaDigest, inputDigest, request, existingDraft) => loadBehaviorDraftMaterial('analysis', purpose, schemaDigest, inputDigest, request, undefined, existingDraft), load: inputDigest => loadBehaviorContinuation('analysis', inputDigest), save: continuation => { saveStage(store, fence!, 'analysis:continuation', continuation, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined) } }) }
          catch (error) {
            const issue = error as { code?: string; message?: string }
            const partitionFailures = (error as { partitionFailures?: PartitionAnalysisFailure[] }).partitionFailures
            const errors = [error, ...partitionFailures?.map(item => item.error) ?? []]
            const currentAttempt = store.readAttempt(attempt!.id)
            const blocked = errors.find(item => !(behaviorAnalysisRepairCodes.has((item as { code?: string }).code ?? '') || item instanceof StructuredSessionError && (structuredAnalysisRepairCodes.has(item.code) || hasSettledNativeRpcFailure(store, operation, currentAttempt, item) || hasSettledNativeTurnTransportFailure(store, operation, currentAttempt, item)) || item instanceof SettledSessionCreateTimeoutError))
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
        if (!approved.reviewPassed || !analysisStageBinding(store, operation, approved) || approved.inputId !== operation.input.id || approved.policyDigest !== operation.policyDigest || approved.composedDigest !== view.composed.contentDigest) fail('analysis_binding', '已审行为分析与冻结输入/基线/政策不一致')
        analysis = { ref, analysis: approved }
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
        return { ...(draftProtocol ? { draftProtocol } : {}), ...(operation.recordUnverifiedCoverage ? { recordUnverifiedCoverage: true } : {}), ...(options.plan.agentWorkflow ? { worktree: stageWorktree(operation.input.source.commonDir, operation.input.headCommit, refinement?.candidate.tree ?? view.composed.tree) } : {}), root: operation.input.source.canonicalRoot, base: operation.input.headCommit, requestKey: `sync:${attempt!.id}:elaborate`, intent: { nodeId: effectiveIntentNodeId, rawSource }, targets, context: view.frozen.nodes.filter(node => !targets.some(target => target.path === node.path) && !moved.some(change => change.to.path === node.path)).map(node => ({ nodeId: node.id, path: node.path, source: view.files.get(node.path)! })), files: refinementFiles, facts: behaviorFacts, analysis, decisionAuthorities: analysis?.analysis.decisionAuthorities ?? options.plan.decisionAuthorities,  ...(refinement ? { refinement: { candidateDigest: refinement.candidateDigest, diagnostics: refinement.diagnostics } } : {}), mode: preserveBusiness ? 'preserve_business' : 'reelaborate', nodeChanges, verifications: options.plan.verifications.map(item => item.definition), implementationWritePaths: options.plan.version === 'sync-coordinator-v2' && options.plan.direction === 'code_to_spec' ? [] : unique(options.plan.writePaths), readonlyTestPaths: unique(options.plan.mandatoryTests.map(test => test.testPath)), authorizedChanges: behaviorAuthorization, historyInput: operation.input, retiredIds: unique([...(options.plan.retiredIds ?? []), ...historicalRetiredIds]), maxRepairs: 0, maxCalls: 2, totalTimeoutMs: operation.deadlineAtMs === null ? null : operation.deadlineAtMs - Date.now(), timeoutMs: callTimeoutMs, signal, model, effort: 'high' as const }
      }
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
        let protocol = stage<{ version: 'elaboration-draft-v1'; generationGuidance?: ElaborationGenerationGuidance; compactSealDiagnostics?: true }>(store, operation, attempt, 'elaboration-draft-protocol')
        if (!protocol && options.plan.agentWorkflow && !attempt.dispatchPlans.some(dispatch => dispatch.purpose.startsWith('elaboration_'))) {
          protocol = { version: 'elaboration-draft-v1', generationGuidance: ELABORATION_GENERATION_GUIDANCE, compactSealDiagnostics: true }
          saveStage(store, fence, 'elaboration-draft-protocol', protocol)
        }
        if (protocol && Object.hasOwn(protocol, 'generationGuidance') && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V1 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V2 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V3 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE_V4 && protocol.generationGuidance !== ELABORATION_GENERATION_GUIDANCE) fail('elaboration_generation_guidance_unsupported', '持久P1生成提示版本不受支持；仅字段缺席允许原提示')
        const draftProtocol = protocol?.version
        const elaborationInput = { ...makeElaborationInput(draftProtocol), generationGuidance: protocol?.generationGuidance, compactSealDiagnostics: protocol?.compactSealDiagnostics }
        const loadDraft = draftProtocol ? (schemaDigest: string): ElaborationDraft | null => {
          const draft = loadElaborationDraft('elaboration', undefined, schemaDigest)
          return draft && cacheDraft ? { ...draft, errors: [...draft.errors, ...cacheDraft.errors] } : draft
        } : undefined
        const maxParallel = options.plan.version === 'sync-coordinator-v2' ? options.plan.partitionPolicy.maxParallel : 1
        const serialRetry = partitions && draftProtocol && maxParallel > 1 && attempt.number > 1 && store.listAttempts(operation.id).some(prior =>
          prior.number < attempt!.number && prior.status === 'superseded' && prior.failure?.kind === 'repairable'
          && (prior.failure.serialElaborationRetry || isNativeObservationFailure(prior.failure)))
        const result = partitions ? await elaborateSyncPartitions(elaborationInput, partitions, serialRetry ? 1 : maxParallel, partitionCheckpoints, runner, view.composed) : await elaborate(elaborationInput, { runner, draft: cacheDraft, loadDraft, loadDraftMaterial: draftProtocol ? (schemaDigest, request) => loadElaborationDraftMaterial('elaboration', undefined, schemaDigest, request) : undefined, seed: loadElaborationRepairSeed('elaboration', freezeElaborationInput(elaborationInput).inputDigest) ?? undefined, repairDiagnostics: loadElaborationRepairDiagnostics('elaboration', freezeElaborationInput(elaborationInput).inputDigest) ?? undefined })
        const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = result
        elaboration = compact; saveStage(store, fence, 'elaboration', compact, !operation.baselineSelection ? { readSetDigest: operation.readSetDigest } : undefined, { composedTree: view.composed.tree, composedContentDigest: view.composed.contentDigest })
      }
      if (!elaboration.structurePassed || !elaboration.reviewPassed) {
        if (['SYNC_BUDGET_EXHAUSTED', 'budget_exhausted'].includes(elaboration.failure?.code ?? '')) throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', elaboration.failure!.message)
        const unsupported = elaboration.status === 'unsupported', stopped = elaboration.status === 'cancelled' || signal.aborted
        const kind: SyncFailure['kind'] = unsupported ? 'unsupported' : elaboration.status === 'conflict' ? 'conflict' : elaboration.status === 'needs_input' ? 'missing_input' : 'repairable'
        const issue = failure(elaboration.failure?.code ?? 'elaboration_failed', elaboration.failure?.message ?? '细化结构或独立评审未通过', kind, [writeEvidence(operation.input.source.commonDir, elaboration)])
        if (stopped) fail('cancelled', issue.message, issue.evidenceRefs)
        const failureSources = elaboration.partitionEvidence?.map(owner => JSON.parse(readEvidence(operation.input.source.commonDir, owner.resultRef).toString('utf8')) as SavedElaboration) ?? [elaboration]
        requireSettledRpcSources(store, operation, store.readAttempt(attempt.id), failureSources, issue.evidenceRefs)
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
        store.recordFailure(fence, issue)
        if (kind !== 'repairable') return current(unsupported ? 'unsupported' : undefined, issue)
        seed = elaborationRepairSeed(elaboration, `sync:${attempt.id}:elaborate`)
        continue
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
      if (!attempt.candidate && !reviewContinuation) {
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
              const base = assemblePublicationBase(store, latest, currentAttempt, view.composed, view.readPaths)
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
          const frozen = await candidateContext(operation, candidate, elaboration)
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
        if (signal.aborted || generated.status === 'cancelled') fail('cancelled', issue.message, issue.evidenceRefs)
        const localFailures = partitions ? readSyncCheckpoints(store, operation, store.readAttempt(attempt.id)).json.flatMap(({ value }) => {
          const saved = value as Partial<Stage>
          if (saved.version !== 'sync-stage-v1' || !saved.stage?.startsWith('partition:') || ![':generation', ':candidate-review'].some(suffix => saved.stage!.endsWith(suffix))) return []
          const source = partitionStage<GenerationResult>(store, operation, store.readAttempt(attempt!.id), saved.stage)
          return source ? [source.result] : []
        }) : []
        requireSettledRpcSources(store, operation, store.readAttempt(attempt.id), [generated, ...localFailures], issue.evidenceRefs)
        if (generated.failure?.code === 'cancellation_pending') fail('cancellation_pending', issue.message, issue.evidenceRefs)
        if (kind === 'repairable' && generated.review?.verdict === 'repair' && generated.candidate && !nodeChanges.length) {
          const omissions = generated.review.findings.filter(finding => contractOmissionBound(finding, accepted.contracts))
          if (omissions.length) { refinement = { prior: elaboration, candidate: generated.candidate, candidateDigest: generated.candidate.digest, diagnostics: omissions.map(finding => ({ code: 'contract_boundary_omission', message: JSON.stringify(finding) })) }; saveStage(store, fence, 'refinement', refinement) }
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
    const refs = error instanceof SyncCoordinatorError ? error.evidenceRefs : []
    const settledRpc = !!fence && !signal.aborted && hasSettledNativeRpcFailure(store, operation, store.readAttempt(fence.attemptId), error as StructuredSessionError)
    const kind: SyncFailure['kind'] = settledRpc ? 'repairable' : code === 'SYNC_BUDGET_EXHAUSTED' ? 'budget' : ['input_changed', 'policy_changed', 'readset_changed', 'composition_conflict', 'request_conflict'].includes(code) ? 'conflict' : code === 'missing_intent' || code === 'no_ready_acceptance' ? 'missing_input' : code === 'export_recovery' || code === 'candidate_stage_missing' ? 'environment' : 'unsupported'
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
