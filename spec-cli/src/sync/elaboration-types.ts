import { contentHash } from './snapshot.js'
import type { CodeBehaviorEvidence, ContractNodeChange, SyncDecisionAuthority } from './writeback-types.js'
import type { RawOnlyInterfaceSeedEvidence } from './partitioning.js'
import type { BlobRef, InputSnapshot } from './operation-types.js'
import type { FrozenContextRef, FrozenEntryJson, FrozenReadProof } from '../frozen-context.js'
import type { RejectedStructuredOutput, StructuredExecution, ZCodeToolPolicy } from '../session-structured-policy.js'
import type { Contract, ContractCoverage, ContractFinding, ContractGraph, Gap, ParseContractInput, Verification } from '@spexcode/spec-core/contracts'

export const ELABORATION_BOUNDARIES = ['permissions', 'mutation', 'async', 'network', 'concurrency', 'callbacks', 'retries', 'cancellation', 'idempotency', 'external_side_effects'] as const
export const ELABORATION_GENERATION_GUIDANCE_V1 = 'ac-test-binding-v1'
export const ELABORATION_GENERATION_GUIDANCE = 'ac-test-flow-binding-v2'
export type ElaborationGenerationGuidance = typeof ELABORATION_GENERATION_GUIDANCE_V1 | typeof ELABORATION_GENERATION_GUIDANCE
export type ElaborationBoundary = typeof ELABORATION_BOUNDARIES[number]
export type ElaborationTarget = { nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }
export type ElaborationFact = { source: string; text: string }
/** 真实全候选V1、独审或分区seal失败；历史已审候选仅作诊断，不是业务拒绝seed或新授权。 */
export type ReadonlySpecRepair = { kind?: 'candidate_review' | 'partition_seal'; reviewEvidence?: { partitionId: string; resultRef: BlobRef }[]; baseInputDigest: string; candidateDigest: string; generationRef: BlobRef; acceptedRef: BlobRef; changes: ElaborationResult['changes']; output: unknown; review: ElaborationReview | null; findings: ContractFinding[] }
export type ElaborationPhase = 'interface_seed' | 'partitioned_final'
export type ElaborationPartitionBinding = { planDigest: string; partitionId: string; analysisRef?: BlobRef; interfaceSeed?: RawOnlyInterfaceSeedEvidence }
export type AnalysisOnlyPartitionEvidence = { partitionId: string; analysisRef: BlobRef; wholeAnalysisRef: BlobRef }

export function partitionedElaborationInputDigest(planDigest: string, inputs: readonly string[], analysisOnlyPartitions?: readonly AnalysisOnlyPartitionEvidence[]): string {
  return contentHash(JSON.stringify({ partitionPlanDigest: planDigest, inputs, ...(analysisOnlyPartitions?.length ? { analysisOnlyPartitions } : {}) }))
}

export function partitionedElaborationCoverageMatches(partitionIds: readonly string[], writerIds: readonly string[], analysisOnlyIds: readonly string[]): boolean {
  const writers = new Set(writerIds), analysisOnly = new Set(analysisOnlyIds)
  return writers.size === writerIds.length && analysisOnly.size === analysisOnlyIds.length
    && writerIds.length + analysisOnlyIds.length === partitionIds.length
    && new Set(partitionIds).size === partitionIds.length
    && partitionIds.every(id => writers.has(id) !== analysisOnly.has(id))
    && partitionIds.filter(id => writers.has(id)).every((id, index) => id === writerIds[index])
    && partitionIds.filter(id => analysisOnly.has(id)).every((id, index) => id === analysisOnlyIds[index])
}

/** 调用者已确认的用户原意或裁决变更；不是 Agent 自己生成的批准请求。 */
export type AuthorizedContractChange = { id: string; action: 'retire' | 'update_verification'; source: 'user:raw' | `decision:${string}`; reason: string; analysisRef?: BlobRef } | { id: string; action: 'update_acceptance'; source: 'user:raw' | `decision:${string}` | `code:${string}`; reason: string; ruleIds: string[]; analysisRef: BlobRef } | { id: string; action: 'restore'; source: 'user:raw'; reason: string; history: { inputId: string; requestBlob: BlobRef } }
export type ElaborationInput = {
  root: string
  base?: string
  /** 明确绑定的实际阶段seed；不限制仓库读取。 */
  worktree?: { baseCommit: string; tree: string; mode: 'read' | 'edit' }
  /** 新派发显式冻结；缺席继续使用原请求协议，不重写历史reserved请求。 */
  draftProtocol?: 'elaboration-draft-v1'
  /** 原attempt阶段冻结的生成提示版本，仅影响Native generation的请求摘要。 */
  generationGuidance?: ElaborationGenerationGuidance
  /** 仅由分区执行器用于无源码writer的初始或既有纯父接口；结果不是完整P1或实现就绪。 */
  phase?: 'interface_seed'
  /** 原分区计划及后验纯父分类证据，只绑定本区来源，不授予写权限或完成度。 */
  partitionBinding?: ElaborationPartitionBinding
  /** 分区局部候选允许把只读context覆盖留给合并后的严格全图seal。 */
  validationScope?: 'partition_local'
  requestKey: string
  intent: { nodeId: string; rawSource: string }
  targets: readonly ElaborationTarget[]
  context?: readonly ParseContractInput[]
  facts?: readonly ElaborationFact[]
  /** 可信执行器登记属于技术编排，不是待裁决的业务事实或变更授权。 */
  verifications?: readonly Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>[]
  /** 冻结计划的技术写范围与不可修改的外部验收文件，不授予新的业务权限。 */
  implementationWritePaths?: readonly string[]
  readonlyTestPaths?: readonly string[]
  authorizedChanges?: readonly AuthorizedContractChange[]
  /** 协调器保存的稳定 ID 退役记录，新候选不可复用。 */
  retiredIds?: readonly string[]
  /** 当前真实操作输入；仅供核验既有restore授权，不成为模型授权。 */
  historyInput?: InputSnapshot
  nodeChanges?: readonly ContractNodeChange[]
  mode?: 'preserve_business' | 'reelaborate'
  analysis?: CodeBehaviorEvidence
  decisionAuthorities?: readonly SyncDecisionAuthority[]
  refinement?: { candidateDigest: string; diagnostics: readonly { code: string; message: string }[] }
  readonlySpecRepair?: ReadonlySpecRepair
  /** 冻结上下文中的源码/测试字节；存在时验证契约绑定指向真实文件。 */
  files?: ReadonlyMap<string, string>
  maxRepairs?: number
  maxCalls?: number
  totalTimeoutMs?: number | null
  timeoutMs?: number | null
  signal?: AbortSignal
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}
export type Applicability = { boundary: ElaborationBoundary; applies: boolean; basis: string; affectedIds: string[] }
export type ElaborationChange = { nodeId: string; path: string; beforeDigest: string | null; source: string }
export type ElaborationCandidate = { inputDigest: string; changes: ElaborationChange[]; applicability: Applicability[]; nodeChanges?: ContractNodeChange[] }
export type ElaborationPartitionSeal = { inputDigest: string; candidateDigest: string; changes: ElaborationChange[]; applicability: Applicability[]; nodeChanges: ContractNodeChange[]; findings: ContractFinding[]; passed: boolean }
export type VerificationOwnershipProjection = {
  version: 'verification-ownership-v1'
  registrationDigest: string
  owners: { id: string; definitionDigest: string; priorOwnerPath: string | null; reviewedOwnerPaths: string[]; ownerPath: string }[]
  sources: { path: string; beforeDigest: string; afterDigest: string; nonVerificationDigest: string }[]
}
export type ElaborationReviewFinding = { code: string; kind: 'repair' | 'missing_fact' | 'conflict'; message: string; affectedIds: string[]; evidence: string; decision: string }
export type ElaborationReview = { inputDigest: string; candidateDigest: string; verdict: 'accept' | 'repair' | 'needs_input' | 'conflict'; checkedBoundaries: ElaborationBoundary[]; findings: ElaborationReviewFinding[] }
export type ElaborationTrace = { purpose: string; sessionId: string; threadId: string; turnId: string; resultDigest: string; inputDigest: string }
/** 草稿正文只存在真实Git blob中；这是未批准材料的身份，不是成功或accept证明。 */
export type ElaborationDraft = {
  version: 'elaboration-draft-v1'; ownerDigest: string; sourceInputId: string; schemaDigest: string
  seed: { baseCommit: string; tree: string; mode: 'edit' }
  resultCommit: string; resultTree: string; path: string; oid: string
  errors: (Pick<ContractFinding, 'code' | 'message'> & Partial<ContractFinding>)[]
}
/** 仅在内存中从已认证历史原件读取；进入新seed后由真实提交形成draft检查点。 */
export type ElaborationDraftMaterial = { source: string; errors: (Pick<ContractFinding, 'code' | 'message'> & Partial<ContractFinding>)[]; repairDiagnostics?: readonly { code: string; message: string }[]; diagnostics?: Record<string, unknown>; sourceKind?: 'git_draft' | 'native_output' | 'physical_draft' | 'stopped_git_draft' }
export type ElaborationRound = { draft?: ElaborationDraft; rejectedOutput?: RejectedStructuredOutput & { ownerInputDigest: string; ownerRequestKey: string }; index: number; output: unknown; candidate: ElaborationCandidate | null; candidateDigest: string | null; findings: ContractFinding[]; reviewOutput: unknown; review: ElaborationReview | null; traces: ElaborationTrace[] }
export type BlockedElaborationFlow = { flowId: string; blockedStepIds: string[]; gapIds: string[] }
/** 仅由内部协调器提供的已结算、被拒绝候选；候选不是新的业务事实。 */
export type ElaborationRepairSeed = {
  settled: true; requestKey: string; inputDigest: string; candidateDigest: string
  output: unknown; candidate: ElaborationCandidate; findings: ContractFinding[]
  review: ElaborationReview | null; traces: ElaborationTrace[]
}
/** 已结算的生成/独审失败；完整原round仅作同绑定诊断，不伪造业务拒绝seed。 */
export type ElaborationRepairDiagnostics = { requestKey: string; inputDigest: string; resultRef: BlobRef; failure: NonNullable<ElaborationResult['failure']>; round: ElaborationRound }
export type ElaborationPriorReference = { requestKey: string; inputDigest: string; candidateDigest: string; renderedCandidateDigest: string; traces: ElaborationTrace[] }
export type ElaborationResult = {
  status: 'complete' | 'needs_input' | 'conflict' | 'unsupported' | 'failed' | 'cancelled' | 'exhausted' | 'interface_seed'
  /** 局部interface seed与全局分区seal均显式标记，不能误读为独立完整P1。 */
  phase?: ElaborationPhase
  partitionBinding?: ElaborationPartitionBinding
  readonlySpecRepair?: ReadonlySpecRepair
  inputDigest: string
  candidateDigest: string | null
  prior: ElaborationPriorReference | null
  repairDiagnostics?: ElaborationRepairDiagnostics
  changes: (ElaborationChange & { contentDigest: string })[]
  contracts: Contract[]
  graph: ContractGraph | null
  coverage: ContractCoverage | null
  gaps: Gap[]
  blockedIds: string[]
  /** 无直接 GAP 阻塞的声明项，不代表所属流程全部可推进。 */
  readyIds: string[]
  readyFlowIds: string[]
  blockedFlows: BlockedElaborationFlow[]
  retiredIds: string[]
  nodeChanges?: ContractNodeChange[]
  partitionEvidence?: { partitionId: string; resultRef: BlobRef }[]
  analysisOnlyPartitions?: AnalysisOnlyPartitionEvidence[]
  partitionSeal?: ElaborationPartitionSeal
  verificationProjectionRef?: BlobRef
  structurePassed: boolean
  reviewPassed: boolean
  runtimeVerification: 'not_run'
  implementationReady: false
  deferredImplementationFindings: ContractFinding[]
  blockedStructureFindings: ContractFinding[]
  rounds: ElaborationRound[]
  failure: { code: string; message: string; sessionId?: string; threadId?: string; turnId?: string } | null
}
export type ElaborationSessionRequest = {
  root: string; base?: string; prompt: string; schema: Record<string, unknown>; requestKey: string; inputDigest: string; purpose: string; timeoutMs: number | null; signal?: AbortSignal; model?: string; effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  worktree?: { baseCommit: string; tree: string; mode: 'read' | 'edit' }
  zcodeToolPolicy?: ZCodeToolPolicy
  nativeConfiguration?: StructuredExecution['nativeConfiguration']
  frozenContext?: FrozenContextRef
  /** 派发前由 prepareFrozenPrompt 冻结的纯 JSON 条目；持久计划只保留最终 ref。 */
  frozenEntries?: readonly FrozenEntryJson[]
}
export type ElaborationSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string; frozenReadProof?: FrozenReadProof; worktree?: { baseCommit: string; baseTree: string; headCommit: string; tree: string; worktreePath: string } }
export type ElaborationRunner = (request: ElaborationSessionRequest) => Promise<ElaborationSessionResult>
