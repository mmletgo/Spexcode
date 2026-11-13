import { isDeepStrictEqual } from 'node:util'
import { assertRejectedOutput, structuredExecutionPolicy, type RejectedStructuredOutput, type StructuredExecution } from '../session-structured-policy.js'
import { nativeWorktreePrompt } from '../native-worktree-runtime.js'
import { assertGrokRejectedFinalSource } from '../grok-structured.js'
import { assertCursorRejectedFinalSource } from '../cursor-structured.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { readRecord } from '../session-record.js'
import { contentHash, readEvidence } from './snapshot.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import { partitionedElaborationCoverageMatches, partitionedElaborationInputDigest } from './elaboration-types.js'
import type { ElaborationResult, ElaborationRound } from './elaboration-types.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'
import { extendsWithUninitializedResources, verifyBaselineSelection } from './composition.js'
import { syncModel } from './model-selection.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { BlobRef, ComposedInputRef, FrozenBaselineSelection, SyncAttempt, SyncCheckpointRef, SyncOperation } from './operation-types.js'
import type { SyncStore } from './store.js'

type Saved = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
export type RawFinalEvidence = RejectedStructuredOutput & { ownerInputDigest: string; ownerRequestKey: string }
type StageBasis = { readSetDigest?: string; baselineSelectionRef?: BlobRef }
type Wrapper = StageBasis & { version: string; operationId: string; attemptId: string; inputId: string; policyDigest: string; stage: string; resultRef: BlobRef; composedTree?: string; composedContentDigest?: string }
const checkpointOwner = Symbol('checkpointOwner')
type PhaseOperation = SyncOperation & { [checkpointOwner]?: SyncOperation }

export function withCheckpointStageBasis(operation: PhaseOperation, readSetDigest: string, baselineSelection?: FrozenBaselineSelection): SyncOperation {
  const phase: PhaseOperation = { ...operation, readSetDigest, ...(baselineSelection ? { baselineSelection } : {}), [checkpointOwner]: operation[checkpointOwner] ?? operation }
  return phase
}

function fail(message: string): never { throw Object.assign(new Error(message), { code: 'checkpoint_artifact_binding' }) }
const hash = (value: unknown): string => contentHash(JSON.stringify(value))
/** 正式重试沿相同冻结来源、输入、政策与意图回溯。 */
export function* retryOperationLineage(store: SyncStore, operation: SyncOperation): Generator<SyncOperation> {
  const seen = new Set<string>()
  let owner: SyncOperation | null = operation
  while (owner) {
    if (seen.has(owner.id) || owner.input.id !== operation.input.id || !isDeepStrictEqual(owner.input.source, operation.input.source) || owner.policyDigest !== operation.policyDigest || (owner.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null) || owner.origin !== operation.origin) {
      throw Object.assign(new Error('重试链不匹配固定来源、输入或政策'), { code: 'retry_provenance_binding' })
    }
    seen.add(owner.id)
    yield owner
    owner = owner.retryOf ? store.readOperation(owner.retryOf) : null
  }
}

export function settledApprovalSource(store: SyncStore, source: SyncOperation): boolean {
  if (source.phase !== 'superseded') return ['failed', 'budget_exhausted', 'cancelled'].includes(source.phase) && store.readRetryEligibility(source.id).eligible
  return store.isSupersededOperationSettled(source.id)
}

/** 显式候选交接仅承接已结算的直接父操作及其原冻结授权。 */
export function findReviewHandoffParent(store: SyncStore, operation: SyncOperation): SyncOperation | null {
  if (!operation.inheritRetryBudget) return null
  const parent = operation.retryOf ? store.readOperation(operation.retryOf) : null
  const receipt = store.findIngressReceipt(operation.ingressKey), initialScope = operation.contractScopeExpansions?.[0]
  const selection = store.readBusinessBaselineSelection(operation.id)
  if (!parent || receipt?.operationId !== operation.id || !receipt.inheritRetryBudget || !receipt.baselineSelection || !selection || !settledApprovalSource(store, parent) || syncModel(parent) === syncModel(operation)
    || !isDeepStrictEqual(parent.input, operation.input) || parent.origin !== operation.origin || parent.policyDigest !== operation.policyDigest
    || parent.planBlob?.sha256 !== operation.planBlob?.sha256 || !initialScope && parent.readSetDigest !== operation.readSetDigest || parent.impactDigest !== operation.impactDigest
    || (initialScope ? !(['paths', 'contractIds', 'flowIds'] as const).every(field => parent.scope[field].every(value => operation.scope[field].includes(value))) : !isDeepStrictEqual(parent.scope, operation.scope))
    || !isDeepStrictEqual(store.readBusinessBaselineSelection(parent.id), receipt.baselineSelection)
    || selection.digest !== receipt.baselineSelection.digest && (!initialScope || !extendsWithUninitializedResources(receipt.baselineSelection, selection))
    || initialScope && initialScope.previousBaselineSelectionDigest !== receipt.baselineSelection.digest
    || (parent.requestBlob?.sha256 ?? null) !== (operation.requestBlob?.sha256 ?? null) || (parent.previousBaselinePair?.id ?? null) !== (operation.previousBaselinePair?.id ?? null)
    || parent.delivery || parent.deliveryPlan.baseCommit !== operation.deliveryPlan.baseCommit || parent.recordUnverifiedCoverage !== operation.recordUnverifiedCoverage || parent.automaticSourceAdoption !== operation.automaticSourceAdoption
    || !isDeepStrictEqual(parent.budget, operation.budget) || parent.deadlineAtMs !== operation.deadlineAtMs
    || !parent.dispatchAnchor || operation.dispatchAnchor?.budgetRootOperationId !== parent.dispatchAnchor.budgetRootOperationId
    || store.hasVerificationOrJournal(parent.id)) return null
  return parent
}

/** 仅在正式 null 扩域已核实后，允许同一冻结树按新选择重算合成元数据。 */
export function composedBeforeNullExpansionMatches(before: ComposedInputRef | null, after: ComposedInputRef | null, selectionDigest: string | undefined): boolean {
  return !!before && !!after && before.sourceInputId === after.sourceInputId && before.previousBaselinePairId === after.previousBaselinePairId
    && before.tree === after.tree && before.contentDigest === after.contentDigest && before.baselineSelectionDigest === selectionDigest
    && isDeepStrictEqual(before.manifestBlob, after.manifestBlob) && isDeepStrictEqual(before.requestBlob, after.requestBlob)
}

type DecodedCheckpoint = { value: unknown } | { error: SyntaxError }
const DECODE_CACHE_BYTES = 32 * 1024 * 1024
const decodedCheckpoints = new WeakMap<SyncStore, { operationId: string; commonDir: string; bytes: number; values: Map<string, DecodedCheckpoint> }>()

function readCheckpointJson<T>(store: SyncStore, operation: SyncOperation, ref: BlobRef): T {
  const commonDir = operation.input.source.commonDir, bytes = readEvidence(commonDir, ref)
  let cache = decodedCheckpoints.get(store)
  if (!cache || cache.operationId !== operation.id || cache.commonDir !== commonDir) {
    cache = { operationId: operation.id, commonDir, bytes: 0, values: new Map() }
    decodedCheckpoints.set(store, cache)
  }
  let decoded = cache.values.get(ref.sha256)
  if (!decoded) {
    try { decoded = { value: JSON.parse(bytes.toString('utf8')) as unknown } }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; decoded = { error } }
    if (bytes.length <= DECODE_CACHE_BYTES) {
      if (cache.bytes + bytes.length > DECODE_CACHE_BYTES) {
        cache.values.clear()
        cache.bytes = 0
      }
      cache.values.set(ref.sha256, decoded)
      cache.bytes += bytes.length
    }
  }
  if ('error' in decoded) throw decoded.error
  return decoded.value as T
}

export function isSyncBlobRef(value: unknown): value is BlobRef {
  return !!value && typeof value === 'object' && 'sha256' in value && typeof value.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(value.sha256) && Object.keys(value).every(key => key === 'sha256' || key === 'artifacts')
}

export function syncCheckpointArtifacts(value: unknown, resultRef: BlobRef): NonNullable<SyncCheckpointRef['artifacts']> {
  const refs = new Map([[resultRef.sha256, resultRef]]), raw = new Set<string>()
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    const packet = entry as Partial<RejectedStructuredOutput>
    if (packet.kind === 'untrusted_final') {
      if (packet.ref) {
        if (typeof packet.text !== 'string' || packet.ref.sha256 !== packet.sha256 || contentHash(packet.text) !== packet.sha256) fail('拒绝final保活引用必须保持精确原文及摘要')
        raw.add(packet.ref.sha256); refs.set(packet.ref.sha256, packet.ref)
      }
      return
    }
    if (isSyncBlobRef(entry)) refs.set(entry.sha256, { sha256: entry.sha256 })
    for (const child of Object.values(entry)) visit(child)
  }
  visit(value)
  return [...refs.values()].map(ref => ({ kind: raw.has(ref.sha256) ? 'untrusted_final' : 'json', ref }))
}

/** 共用原请求、原failed观察和canonical身份；不补字段或改写历史终态。 */
export function authenticateNativeFailure(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, failure: NonNullable<ElaborationResult['failure']>, readNativeRecord: typeof readRecord = readRecord, allowStoppedDraft = false): { plan: NativeRunPlan; checkpoint: NativeRunCheckpoint; record: NonNullable<ReturnType<typeof readRecord>>; state: StructuredExecution; observedFailure: boolean } {
  const read = <T>(ref: BlobRef): T => readCheckpointJson<T>(store, operation, ref)
  const resource = store.findResource(origin.id, key), dispatch = origin.dispatchPlans.find(item => item.key === key)
  if (!resource || !dispatch || origin.operationId !== operation.id || resource.operationId !== operation.id || resource.plan.kind !== 'native_session' || resource.plan.inputId !== operation.input.id) fail('失败缺少原正式Native资源与派发')
  const plan = read<NativeRunPlan>(resource.plan.planBlob), checkpoint = read<NativeRunCheckpoint>(resource.checkpointRef)
  if (plan.operationId !== operation.id || plan.attemptId !== origin.id || plan.inputId !== operation.input.id || plan.request.requestKey !== key || plan.request.purpose !== dispatch.purpose || plan.requestDigest !== resource.plan.payloadDigest || plan.requestDigest !== dispatch.requestDigest || hash(plan.request) !== plan.requestDigest || plan.sessionCreateKey !== dispatch.sessionCreateKey || plan.expectedSessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || failure.sessionId !== plan.expectedSessionId) fail('失败的原请求、身份或输入摘要不匹配')
  const bound = (item: NativeRunCheckpoint): boolean => item.operationId === operation.id && item.attemptId === origin.id && item.inputId === operation.input.id && item.candidateDigest === plan.candidateDigest && item.candidateDigest === resource.plan.candidateDigest && item.requestDigest === plan.requestDigest && item.expectedSessionId === plan.expectedSessionId && item.session.sessionId === plan.expectedSessionId && item.session.threadId === failure.threadId && item.session.turnId === failure.turnId
  const observedFailure = resource.checkpoints.some(item => { const observed = read<NativeRunCheckpoint>(item.checkpointRef); return bound(observed) && observed.nativeState === 'failed' })
  if (!bound(checkpoint) || checkpoint.phase !== resource.phase || !observedFailure && !allowStoppedDraft) fail('失败缺少原failed资源观察；后续控制不补签旧失败')
  const prompt = plan.request.worktree ? nativeWorktreePrompt(plan.request.prompt, plan.request.worktree) : plan.request.prompt
  const record = readNativeRecord(plan.expectedSessionId), state = record?.structuredExecution, execution = structuredExecutionPolicy(plan.request), base = plan.request.worktree?.baseCommit ?? plan.request.base
  if (!record || !state || record.session !== plan.expectedSessionId || record.createRequestId !== contentHash(plan.sessionCreateKey) || record.createPayloadHash !== hash({ prompt, parent: null, launcher: null, ...(base?.trim() ? { base: base.trim() } : {}), structuredExecution: execution }) || hash(structuredExecutionPolicy(state)) !== hash(execution) || (state.errorCode ?? 'failed') !== failure.code || state.state === 'failed' && state.error !== failure.message || state.threadId !== failure.threadId || state.turnId !== failure.turnId) fail('失败没有canonical Native record的精确原请求、错误与身份认证')
  if (state.state !== 'failed' && !(state.state === 'cancelled' && resource.phase === 'removed' && state.cancellation?.nativeStopped === true)) fail('失败的后续控制状态没有精确停止证明')
  if (allowStoppedDraft && state.cancellation?.nativeStopped && resource.phase === 'removed' && !isDeepStrictEqual(checkpoint.stop, { sessionId: plan.expectedSessionId, state: state.state, threadId: state.threadId, turnId: state.turnId, nativeStopped: true, acknowledged: state.cancellation.acknowledged, nativeStatus: state.cancellation.nativeStatus, ...(state.cancellation.error ? { error: state.cancellation.error } : {}) })) fail('失败的checkpoint与canonical停止原值不一致')
  if (allowStoppedDraft && dispatch.session && (dispatch.session.sessionId !== checkpoint.session.sessionId || dispatch.session.threadId !== null && dispatch.session.threadId !== checkpoint.session.threadId || dispatch.session.turnId !== null && dispatch.session.turnId !== checkpoint.session.turnId)) fail('新Git材料缺少原派发的精确Native身份')
  if (allowStoppedDraft && (state.state !== 'cancelled' && !(state.state === 'failed' && observedFailure) || resource.phase !== 'removed' || state.cancellation?.nativeStopped !== true)) fail('新Git材料观察必须有原正式取消或已认证失败及资源停止证明')
  return { plan, checkpoint, record, state, observedFailure }
}

/** 原文另核其packet、SHA及CAS字节；Git材料不借raw权限。 */
export function authenticateNativeRejectedFinal(store: SyncStore, operation: SyncOperation, origin: SyncAttempt, key: string, failure: NonNullable<ElaborationResult['failure']>, packet: RejectedStructuredOutput, readNativeRecord: typeof readRecord = readRecord): StructuredExecution {
  const { plan, record, state } = authenticateNativeFailure(store, operation, origin, key, failure, readNativeRecord)
  const prompt = plan.request.worktree ? nativeWorktreePrompt(plan.request.prompt, plan.request.worktree) : plan.request.prompt
  if (failure.threadId !== packet.threadId || failure.turnId !== packet.turnId) fail('raw的原失败身份不匹配')
  assertRejectedOutput(packet, prompt, structuredExecutionPolicy(plan.request), packet)
  if (!state.rejectedOutput || !isDeepStrictEqual({ ...state.rejectedOutput, ref: undefined }, { ...packet, ref: undefined })) fail('raw没有canonical Native record的精确原final认证')
  if (packet.ref && readEvidence(operation.input.source.commonDir, packet.ref).toString('utf8') !== packet.text) fail('raw原CAS字节不匹配typed失败原文')
  if (plan.request.model?.startsWith('grok:')) {
    if (record.harness !== 'grok-structured') fail('Grok拒绝结果没有原结构化执行器身份')
    assertGrokRejectedFinalSource(prompt, state, record.worktreePath)
  }
  if (plan.request.model?.startsWith('cursor:')) {
    if (record.harness !== 'cursor-structured') fail('Cursor 拒绝结果没有原结构化执行器身份')
    assertCursorRejectedFinalSource(prompt, state, record.worktreePath)
  }
  return state
}

export type SyncCheckpointStageView = { json: { ref: BlobRef; value: unknown }[]; raw: { has(sha256: string): boolean } }
type ScannedCheckpoints = SyncCheckpointStageView & { raw: Map<string, RawFinalEvidence> }

function scanSyncCheckpoints(store: SyncStore, operation: PhaseOperation, attempt: SyncAttempt, readNativeRecord: typeof readRecord): ScannedCheckpoints {
  operation = operation[checkpointOwner] ?? operation
  const raw = new Map<string, RawFinalEvidence>()
  const roots = [...attempt.checkpointRefs].reverse(), refs = new Map<string, BlobRef>()
  for (const root of roots) { refs.set(root.sha256, root); for (const artifact of root.artifacts ?? []) refs.set(artifact.ref.sha256, artifact.ref) }
  const json = new Map<string, unknown>(), syntax = new Map<string, SyntaxError>(), proofs = new Set<string>(), decoded = new Map<string, unknown>()
  const read = <T>(ref: BlobRef): T => {
    if (!decoded.has(ref.sha256)) decoded.set(ref.sha256, readCheckpointJson(store, operation, ref))
    return decoded.get(ref.sha256) as T
  }
  const stageResult = (owner: SyncOperation, source: SyncAttempt, key: string, digest?: string, basis: StageBasis | null = { readSetDigest: owner.readSetDigest }): Wrapper | null => {
    for (const root of [...source.checkpointRefs].reverse()) {
      if (!root.artifacts?.some(artifact => artifact.kind === 'json')) continue
      const wrapper = read<Partial<Wrapper>>(root)
      const ref = wrapper?.resultRef
      if (wrapper?.version === 'sync-stage-v1' && wrapper.stage === key && wrapper.operationId === owner.id && wrapper.attemptId === source.id
        && wrapper.inputId === owner.input.id && wrapper.policyDigest === owner.policyDigest && isSyncBlobRef(ref)
        && (!basis || (wrapper.readSetDigest === basis.readSetDigest || key.endsWith(':provenance') && wrapper.readSetDigest === undefined && !owner.baselineSelection)
          && (!basis.baselineSelectionRef || wrapper.baselineSelectionRef?.sha256 === basis.baselineSelectionRef.sha256 && root.artifacts.some(artifact => artifact.kind === 'json' && artifact.ref.sha256 === basis.baselineSelectionRef!.sha256)))
        && (digest === undefined || ref.sha256 === digest) && root.artifacts.some(artifact => artifact.kind === 'json' && artifact.ref.sha256 === ref.sha256)) return wrapper as Wrapper
    }
    return null
  }
  let lineage: SyncOperation[] | undefined
  const handoffParents = new Map<string, SyncOperation>()
  const inheritedDiagnosticOwner = (saved: Saved, original: Saved, diagnostic: NonNullable<Saved['repairDiagnostics']>, origin: SyncAttempt): SyncOperation => {
    if (!saved.structurePassed || !saved.reviewPassed || saved.failure || saved.rounds.at(-1)?.review?.verdict !== 'accept'
      || !saved.partitionBinding || !isDeepStrictEqual(saved.partitionBinding, original.partitionBinding) || saved.inputDigest !== original.inputDigest) fail('跨重试raw诊断必须来自同一已审局部原件')
    const key = `partition:${saved.partitionBinding.partitionId}:elaboration`, digest = hash(saved)
    if (diagnostic.requestKey !== `sync:${origin.id}:elaborate:partition:${saved.partitionBinding.partitionId}`) fail('跨重试raw诊断不匹配原失败owner')
    let basis: StageBasis = { readSetDigest: operation.readSetDigest }, scope = operation.scope
    let expectedSelection = attempt.baselineSelectionDigest, expectedComposition = attempt.composedInput
    let expandedAt: string | undefined, rebasedOwnerId: string | undefined, expansionOwnerId = operation.id
    lineage ??= [...retryOperationLineage(store, operation)]
    let owner = operation, source = attempt, position = 0
    for (;;) {
      if (!stageResult(owner, source, key, digest, basis)) {
        if (rebasedOwnerId === owner.id || owner.id !== expansionOwnerId) fail('跨重试raw诊断缺少原批准resultRef')
        const local = stageResult(owner, source, key, digest, null)
        if (!local?.readSetDigest || !local.baselineSelectionRef || !owner.baselineSelection || !expectedComposition || owner.planBlob?.sha256 !== owner.policyDigest) fail('跨重试raw诊断缺少原批准resultRef')
        const before = read<FrozenBaselineSelection>(local.baselineSelectionRef)
        basis = { readSetDigest: local.readSetDigest, baselineSelectionRef: local.baselineSelectionRef }
        const originalScope = read<SyncCoordinatorPlan>(owner.planBlob).executionScope
        const expansion = owner.contractScopeExpansions?.find(item => item.previousBaselineSelectionDigest === before.digest && item.baselineSelectionDigest === owner.baselineSelection!.digest)
        const earlierAttempt = source.baselineSelectionDigest === before.digest && expectedComposition.baselineSelectionDigest === before.digest
        const seal = !earlierAttempt && expansion && stageResult(owner, source, 'elaboration', expansion.evidenceRef.sha256, basis)
        const whole = seal && read<Saved>(seal.resultRef)
        if (!originalScope || !expansion || !isDeepStrictEqual(expansion.paths, owner.scope.paths)
          || !isDeepStrictEqual(expansion.contractIds, owner.scope.contractIds) || !isDeepStrictEqual(expansion.flowIds, owner.scope.flowIds)
          || !stageResult(owner, source, key, digest, basis)) fail('跨重试raw诊断缺少同阶段批准及正式扩域证明')
        if (!earlierAttempt && (source.baselineSelectionDigest !== owner.baselineSelection.digest
          || !seal || seal.composedTree !== expectedComposition.tree || seal.composedContentDigest !== expectedComposition.contentDigest
          || !whole || !whole.structurePassed || !whole.reviewPassed || whole.failure || whole.phase !== 'partitioned_final'
          || !whole.partitionEvidence?.some(member => member.partitionId === saved.partitionBinding!.partitionId && member.resultRef.sha256 === digest))) fail('跨重试raw诊断缺少同阶段批准及正式扩域证明')
        verifyBaselineSelection(owner.input, before)
        if (!extendsWithUninitializedResources(before, owner.baselineSelection)) fail('跨重试raw诊断扩域改变原冻结选择')
        scope = originalScope
        expectedSelection = before.digest
        rebasedOwnerId = owner.id
        if (!earlierAttempt) expandedAt = source.id
      }
      if (owner.id === origin.operationId) {
        if (origin.number >= source.number || !stageResult(owner, origin, key, diagnostic.resultRef.sha256, basis)) fail('跨重试raw诊断缺少原失败resultRef')
        return owner
      }
      const wrapper = stageResult(owner, source, `${key}:provenance`, undefined, basis)
      if (!wrapper) fail('跨重试raw诊断缺少已审复用来源')
      const proof = read<{ fromOperationId?: string; fromAttemptId: string; resultRef: BlobRef }>(wrapper.resultRef)
      const nextPosition = lineage.findIndex(prior => prior.id === (proof.fromOperationId ?? owner.id))
      if (nextPosition < position || proof.resultRef?.sha256 !== digest) fail('跨重试raw诊断复用来源不匹配原批准resultRef')
      const previous = store.readAttempt(proof.fromAttemptId), previousOwner = lineage[nextPosition]
      const composed = previous.composedInput
      const unchangedComposition = source.id === expandedAt
        ? composedBeforeNullExpansionMatches(composed, expectedComposition, expectedSelection)
        : isDeepStrictEqual(composed, expectedComposition)
      if (previous.operationId !== previousOwner.id || nextPosition === position && previous.number >= source.number || !['failed', 'superseded', 'settled'].includes(previous.status)
        || (previousOwner.id !== rebasedOwnerId && (previousOwner.readSetDigest !== basis.readSetDigest || !isDeepStrictEqual(previousOwner.scope, scope)))
        || previous.baselineSelectionDigest !== expectedSelection || !unchangedComposition) fail('跨重试raw诊断的原attempt或冻结范围失配')
      if (owner.id === expansionOwnerId && owner.inheritRetryBudget && owner.retryOf === previousOwner.id) {
        const parent = handoffParents.get(owner.id) ?? findReviewHandoffParent(store, owner)
        if (parent?.id !== previousOwner.id || previousOwner.baselineSelection?.digest !== expectedSelection) fail('跨重试raw诊断的正式换模型交接失配')
        handoffParents.set(owner.id, parent)
        expansionOwnerId = previousOwner.id
      }
      expectedComposition = composed
      owner = previousOwner; source = previous; position = nextPosition
    }
  }
  const authenticate = (owner: SyncOperation, saved: Saved, round: ElaborationRound): void => {
    const packet = round.rejectedOutput
    if (!packet?.ref) return
    if (!['failed', 'structured_output_format_invalid', 'structured_output_retries_exhausted'].includes(saved.failure?.code ?? '') || saved.status !== 'failed' || packet.ownerInputDigest !== saved.inputDigest || !Number.isInteger(round.index)) fail('raw缺少对应失败owner及round绑定')
    const originId = packet.ownerRequestKey.split(':')[1], origin = store.readAttempt(originId)
    const ownerKey = `sync:${origin.id}:elaborate${saved.partitionBinding ? `:partition:${saved.partitionBinding.partitionId}` : ''}`
    if (origin.operationId !== owner.id || packet.ownerRequestKey !== ownerKey || !['elaboration_generate', 'elaboration_review'].includes(packet.purpose) || packet.purpose === 'elaboration_generate' && (round.output !== null || round.candidate !== null || round.candidateDigest !== null) || packet.purpose === 'elaboration_review' && (round.reviewOutput !== null || round.review !== null)) fail('raw不能成为成功候选或其它owner的证据')
    const key = `${ownerKey}:${round.index}:${packet.purpose}`
    const { ownerInputDigest: _ownerInputDigest, ownerRequestKey: _ownerRequestKey, ...original } = packet
    authenticateNativeRejectedFinal(store, owner, origin, key, saved.failure!, original, readNativeRecord)
    raw.set(packet.ref.sha256, packet)
  }
  const inspect = (ref: BlobRef, owner = operation): void => {
    const proofKey = `${owner.id}:${ref.sha256}`
    if (proofs.has(proofKey)) return
    proofs.add(proofKey)
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      const saved = value as Saved
      const owners = Array.isArray(saved.rounds) ? saved.partitionEvidence : undefined
      const analysisOnly = Array.isArray(saved.rounds) ? saved.analysisOnlyPartitions : undefined
      if (analysisOnly !== undefined && (!owners || !Array.isArray(analysisOnly) || !analysisOnly.length || saved.partitionBinding || saved.phase !== 'partitioned_final')) fail('仅分析分区必须附在真实P1全局聚合')
      if (owners) {
        const locals = owners.map(owner => read<Saved>(owner.resultRef))
        if (!locals.length || new Set(owners.map(owner => owner.partitionId)).size !== owners.length || locals.some((local, index) => local.partitionBinding?.partitionId !== owners[index].partitionId || !local.partitionBinding?.planDigest) || !isDeepStrictEqual(saved.rounds, locals.flatMap(local => local.rounds))) fail('聚合rounds必须是原partitionEvidence局部结果的精确有序并集')
        const planDigest = locals[0].partitionBinding!.planDigest
        if (analysisOnly) {
          if (analysisOnly.some(owner => !owner?.partitionId || !owner.analysisRef?.sha256 || !owner.wholeAnalysisRef?.sha256)) fail('仅分析分区缺少原P0引用')
          const wholeRef = analysisOnly[0].wholeAnalysisRef, whole = read<CodeBehaviorAnalysis>(wholeRef), coverage = whole.partitionCoverage
          if (!whole.reviewPassed || whole.inputId !== operation.input.id || whole.policyDigest !== operation.policyDigest || coverage?.planDigest !== planDigest
            || locals.some(local => local.partitionBinding!.analysisRef?.sha256 !== wholeRef.sha256)
            || !partitionedElaborationCoverageMatches(coverage.partitionIds, owners.map(owner => owner.partitionId), analysisOnly.map(owner => owner.partitionId))) fail('仅分析与真实P1分区必须精确覆盖原全局P0计划')
          for (const owner of analysisOnly) {
            const original = whole.partitionEvidence?.find(member => member.partitionId === owner.partitionId)
            const local = read<CodeBehaviorAnalysis>(owner.analysisRef)
            if (owner.wholeAnalysisRef.sha256 !== wholeRef.sha256 || original?.analysisRef.sha256 !== owner.analysisRef.sha256 || !local.reviewPassed
              || !isDeepStrictEqual(original.analysis, local)) fail('仅分析分区引用必须匹配原已审P0局部')
          }
        }
        const inputMatches = saved.partitionBinding
          ? owners.length === 1 && isDeepStrictEqual(saved.partitionBinding, locals[0].partitionBinding) && saved.inputDigest === locals[0].inputDigest
          : saved.phase === 'partitioned_final' && locals.every(local => local.partitionBinding!.planDigest === planDigest) && saved.inputDigest === partitionedElaborationInputDigest(planDigest, locals.map(local => local.inputDigest), analysisOnly)
        if (!inputMatches) fail('聚合诊断必须保留原局部身份或精确重算全局输入，不能替代原owner认证')
        for (const member of owners) inspect(member.resultRef, owner)
      } else for (const round of Array.isArray(saved.rounds) ? saved.rounds : []) if (round.rejectedOutput) authenticate(owner, saved, round)
      const diagnostic = Array.isArray(saved.rounds) ? saved.repairDiagnostics : undefined
      if (diagnostic) {
        const original = read<Saved>(diagnostic.resultRef), last = original.rounds.at(-1)
        if (original.inputDigest !== diagnostic.inputDigest || !isDeepStrictEqual(original.failure, diagnostic.failure) || !isDeepStrictEqual(last, diagnostic.round)) fail('历史raw诊断不能改写原失败round')
        let diagnosticOwner = owner
        if (owner.retryOf && (diagnostic.round.rejectedOutput?.ref || original.repairDiagnostics)) {
          const origin = store.readAttempt(diagnostic.requestKey.split(':')[1])
          if (origin.operationId !== owner.id) diagnosticOwner = inheritedDiagnosticOwner(saved, original, diagnostic, origin)
        }
        inspect(diagnostic.resultRef, diagnosticOwner)
      }
      for (const child of Object.values(value)) walk(child)
    }
    walk(read(ref))
  }
  for (const root of roots) {
    if (raw.has(root.sha256)) continue
    let value: unknown
    try { value = read(root) }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // 旧flat pin可能先于完整失败wrapper被观察；未得到精确typed原件认证的错误最终仍抛出。
      syntax.set(root.sha256, error); continue
    }
    json.set(root.sha256, value)
    const wrapper = value as Partial<Wrapper> | null
    if (wrapper?.version === 'sync-stage-v1' && wrapper.operationId === operation.id && wrapper.attemptId === attempt.id && wrapper.inputId === operation.input.id && wrapper.policyDigest === operation.policyDigest && typeof wrapper.stage === 'string' && wrapper.resultRef && refs.has(wrapper.resultRef.sha256)) inspect(wrapper.resultRef)
    for (const artifact of root.artifacts ?? []) {
      if (artifact.kind === 'json' && !raw.has(artifact.ref.sha256)) json.set(artifact.ref.sha256, read(artifact.ref))
    }
  }
  for (const root of roots) for (const artifact of root.artifacts ?? []) if (artifact.kind === 'untrusted_final' && !raw.has(artifact.ref.sha256)) fail('raw role没有真实失败原件，不能隐藏损坏checkpoint')
  for (const [sha256, error] of syntax) if (!raw.has(sha256)) throw error
  return { json: [...json].filter(([sha256]) => !raw.has(sha256)).map(([sha256, value]) => ({ ref: { sha256 }, value })), raw }
}

/** 先核失败原件与原生资源；JSON外形和checkpoint上的role都不能自行授予stage权限。 */
export function readSyncCheckpoints(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, readNativeRecord: typeof readRecord = readRecord): ScannedCheckpoints {
  return structuredClone(scanSyncCheckpoints(store, operation, attempt, readNativeRecord))
}

/** 历史阶段查询只保留已核根wrapper与raw摘要；正文按所需resultRef读取。 */
export function readSyncCheckpointStageIndex(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, readNativeRecord: typeof readRecord = readRecord): SyncCheckpointStageView {
  const { json, raw } = scanSyncCheckpoints(store, operation, attempt, readNativeRecord)
  const roots = new Set(attempt.checkpointRefs.map(ref => ref.sha256))
  const wrappers = json.filter(({ ref, value }) => roots.has(ref.sha256) && (value as Partial<Wrapper> | null)?.version === 'sync-stage-v1')
  return { json: structuredClone(wrappers), raw: new Set(raw.keys()) }
}
