import { isDeepStrictEqual } from 'node:util'
import { assertRejectedOutput, structuredExecutionPolicy, type RejectedStructuredOutput, type StructuredExecution } from '../session-structured-policy.js'
import { nativeWorktreePrompt } from '../native-worktree-runtime.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { readRecord } from '../session-record.js'
import { contentHash, readEvidence } from './snapshot.js'
import type { NativeRunCheckpoint, NativeRunPlan } from './native-run.js'
import { partitionedElaborationCoverageMatches, partitionedElaborationInputDigest } from './elaboration-types.js'
import type { ElaborationResult, ElaborationRound } from './elaboration-types.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'
import type { BlobRef, SyncAttempt, SyncCheckpointRef, SyncOperation } from './operation-types.js'
import type { SyncStore } from './store.js'

type Saved = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
export type RawFinalEvidence = RejectedStructuredOutput & { ownerInputDigest: string; ownerRequestKey: string }
type Wrapper = { version: string; operationId: string; attemptId: string; inputId: string; policyDigest: string; stage: string; resultRef: BlobRef }
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'checkpoint_artifact_binding' }) }
const hash = (value: unknown): string => contentHash(JSON.stringify(value))
type DecodedCheckpoint = { value: unknown } | { error: SyntaxError }
const decodedCheckpoints = new WeakMap<SyncStore, { operationId: string; commonDir: string; values: Map<string, DecodedCheckpoint> }>()

function readCheckpointJson<T>(store: SyncStore, operation: SyncOperation, ref: BlobRef): T {
  const commonDir = operation.input.source.commonDir, bytes = readEvidence(commonDir, ref)
  let cache = decodedCheckpoints.get(store)
  if (!cache || cache.operationId !== operation.id || cache.commonDir !== commonDir) {
    cache = { operationId: operation.id, commonDir, values: new Map() }
    decodedCheckpoints.set(store, cache)
  }
  let decoded = cache.values.get(ref.sha256)
  if (!decoded) {
    try { decoded = { value: JSON.parse(bytes.toString('utf8')) as unknown } }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; decoded = { error } }
    cache.values.set(ref.sha256, decoded)
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
  const { plan, state } = authenticateNativeFailure(store, operation, origin, key, failure, readNativeRecord)
  const prompt = plan.request.worktree ? nativeWorktreePrompt(plan.request.prompt, plan.request.worktree) : plan.request.prompt
  if (failure.threadId !== packet.threadId || failure.turnId !== packet.turnId) fail('raw的原失败身份不匹配')
  assertRejectedOutput(packet, prompt, structuredExecutionPolicy(plan.request), packet)
  if (!state.rejectedOutput || !isDeepStrictEqual({ ...state.rejectedOutput, ref: undefined }, { ...packet, ref: undefined })) fail('raw没有canonical Native record的精确原final认证')
  if (packet.ref && readEvidence(operation.input.source.commonDir, packet.ref).toString('utf8') !== packet.text) fail('raw原CAS字节不匹配typed失败原文')
  return state
}

/** 先核失败原件与原生资源；JSON外形和checkpoint上的role都不能自行授予stage权限。 */
export function readSyncCheckpoints(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, readNativeRecord: typeof readRecord = readRecord): { json: { ref: BlobRef; value: unknown }[]; raw: Map<string, RawFinalEvidence> } {
  const raw = new Map<string, RawFinalEvidence>()
  const roots = [...attempt.checkpointRefs].reverse(), refs = new Map<string, BlobRef>()
  for (const root of roots) { refs.set(root.sha256, root); for (const artifact of root.artifacts ?? []) refs.set(artifact.ref.sha256, artifact.ref) }
  const json = new Map<string, unknown>(), syntax = new Map<string, SyntaxError>(), proofs = new Set<string>(), decoded = new Map<string, unknown>()
  const read = <T>(ref: BlobRef): T => {
    if (!decoded.has(ref.sha256)) decoded.set(ref.sha256, readCheckpointJson(store, operation, ref))
    return decoded.get(ref.sha256) as T
  }
  const authenticate = (saved: Saved, round: ElaborationRound): void => {
    const packet = round.rejectedOutput
    if (!packet?.ref) return
    if (!['failed', 'structured_output_format_invalid', 'structured_output_retries_exhausted'].includes(saved.failure?.code ?? '') || saved.status !== 'failed' || packet.ownerInputDigest !== saved.inputDigest || !Number.isInteger(round.index)) fail('raw缺少对应失败owner及round绑定')
    const originId = packet.ownerRequestKey.split(':')[1], origin = store.readAttempt(originId)
    const ownerKey = `sync:${origin.id}:elaborate${saved.partitionBinding ? `:partition:${saved.partitionBinding.partitionId}` : ''}`
    if (origin.operationId !== operation.id || packet.ownerRequestKey !== ownerKey || !['elaboration_generate', 'elaboration_review'].includes(packet.purpose) || packet.purpose === 'elaboration_generate' && (round.output !== null || round.candidate !== null || round.candidateDigest !== null) || packet.purpose === 'elaboration_review' && (round.reviewOutput !== null || round.review !== null)) fail('raw不能成为成功候选或其它owner的证据')
    const key = `${ownerKey}:${round.index}:${packet.purpose}`
    const { ownerInputDigest: _ownerInputDigest, ownerRequestKey: _ownerRequestKey, ...original } = packet
    authenticateNativeRejectedFinal(store, operation, origin, key, saved.failure!, original, readNativeRecord)
    raw.set(packet.ref.sha256, packet)
  }
  const inspect = (ref: BlobRef): void => {
    if (proofs.has(ref.sha256)) return
    proofs.add(ref.sha256)
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
        for (const owner of owners) inspect(owner.resultRef)
      } else for (const round of Array.isArray(saved.rounds) ? saved.rounds : []) if (round.rejectedOutput) authenticate(saved, round)
      const diagnostic = Array.isArray(saved.rounds) ? saved.repairDiagnostics : undefined
      if (diagnostic) {
        const original = read<Saved>(diagnostic.resultRef), last = original.rounds.at(-1)
        if (original.inputDigest !== diagnostic.inputDigest || !isDeepStrictEqual(original.failure, diagnostic.failure) || !isDeepStrictEqual(last, diagnostic.round)) fail('历史raw诊断不能改写原失败round')
        inspect(diagnostic.resultRef)
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
  return structuredClone({ json: [...json].filter(([sha256]) => !raw.has(sha256)).map(([sha256, value]) => ({ ref: { sha256 }, value })), raw })
}
