import type { CodeBehaviorEvidence, ContractNodeChange, SyncDecisionAuthority } from './writeback-types.js'
import type { RawOnlyInterfaceSeedEvidence } from './partitioning.js'
import type { BlobRef, InputSnapshot } from './operation-types.js'
import type { FrozenContextRef, FrozenEntryJson, FrozenReadProof } from '../frozen-context.js'
import type { Contract, ContractCoverage, ContractFinding, ContractGraph, Gap, ParseContractInput, Verification } from '@spexcode/spec-core/contracts'

export const ELABORATION_BOUNDARIES = ['permissions', 'mutation', 'async', 'network', 'concurrency', 'callbacks', 'retries', 'cancellation', 'idempotency', 'external_side_effects'] as const
export type ElaborationBoundary = typeof ELABORATION_BOUNDARIES[number]
export type ElaborationTarget = { nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }
export type ElaborationFact = { source: string; text: string }
export type ElaborationPhase = 'interface_seed' | 'partitioned_final'
export type ElaborationPartitionBinding = { planDigest: string; partitionId: string; analysisRef?: BlobRef; interfaceSeed?: RawOnlyInterfaceSeedEvidence }
/** 调用者已确认的用户原意或裁决变更；不是 Agent 自己生成的批准请求。 */
export type AuthorizedContractChange = { id: string; action: 'retire' | 'update_verification'; source: 'user:raw' | `decision:${string}`; reason: string; analysisRef?: BlobRef } | { id: string; action: 'update_acceptance'; source: 'user:raw' | `decision:${string}` | `code:${string}`; reason: string; ruleIds: string[]; analysisRef: BlobRef } | { id: string; action: 'restore'; source: 'user:raw'; reason: string; history: { inputId: string; requestBlob: BlobRef } }
export type ElaborationInput = {
  root: string
  base?: string
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
  /** 冻结上下文中的源码/测试字节；存在时验证契约绑定指向真实文件。 */
  files?: ReadonlyMap<string, string>
  maxRepairs?: number
  maxCalls?: number
  totalTimeoutMs?: number
  timeoutMs?: number
  signal?: AbortSignal
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}
export type Applicability = { boundary: ElaborationBoundary; applies: boolean; basis: string; affectedIds: string[] }
export type ElaborationChange = { nodeId: string; path: string; beforeDigest: string | null; source: string }
export type ElaborationCandidate = { inputDigest: string; changes: ElaborationChange[]; applicability: Applicability[]; nodeChanges?: ContractNodeChange[] }
export type ElaborationPartitionSeal = { inputDigest: string; candidateDigest: string; changes: ElaborationChange[]; applicability: Applicability[]; nodeChanges: ContractNodeChange[]; findings: ContractFinding[]; passed: boolean }
export type ElaborationReviewFinding = { code: string; kind: 'repair' | 'missing_fact' | 'conflict'; message: string; affectedIds: string[]; evidence: string; decision: string }
export type ElaborationReview = { inputDigest: string; candidateDigest: string; verdict: 'accept' | 'repair' | 'needs_input' | 'conflict'; checkedBoundaries: ElaborationBoundary[]; findings: ElaborationReviewFinding[] }
export type ElaborationTrace = { purpose: string; sessionId: string; threadId: string; turnId: string; resultDigest: string; inputDigest: string }
export type ElaborationRound = { index: number; output: unknown; candidate: ElaborationCandidate | null; candidateDigest: string | null; findings: ContractFinding[]; reviewOutput: unknown; review: ElaborationReview | null; traces: ElaborationTrace[] }
export type BlockedElaborationFlow = { flowId: string; blockedStepIds: string[]; gapIds: string[] }
/** 仅由内部协调器提供的已结算、被拒绝候选；候选不是新的业务事实。 */
export type ElaborationRepairSeed = {
  settled: true; requestKey: string; inputDigest: string; candidateDigest: string
  output: unknown; candidate: ElaborationCandidate; findings: ContractFinding[]
  review: ElaborationReview | null; traces: ElaborationTrace[]
}
export type ElaborationPriorReference = { requestKey: string; inputDigest: string; candidateDigest: string; renderedCandidateDigest: string; traces: ElaborationTrace[] }
export type ElaborationResult = {
  status: 'complete' | 'needs_input' | 'conflict' | 'unsupported' | 'failed' | 'cancelled' | 'exhausted' | 'interface_seed'
  /** 局部interface seed与全局分区seal均显式标记，不能误读为独立完整P1。 */
  phase?: ElaborationPhase
  partitionBinding?: ElaborationPartitionBinding
  inputDigest: string
  candidateDigest: string | null
  prior: ElaborationPriorReference | null
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
  partitionSeal?: ElaborationPartitionSeal
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
  root: string; base?: string; prompt: string; schema: Record<string, unknown>; requestKey: string; inputDigest: string; purpose: string; timeoutMs: number; signal?: AbortSignal; model?: string; effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  frozenContext?: FrozenContextRef
  /** 派发前由 prepareFrozenPrompt 冻结的纯 JSON 条目；持久计划只保留最终 ref。 */
  frozenEntries?: readonly FrozenEntryJson[]
}
export type ElaborationSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string; frozenReadProof?: FrozenReadProof }
export type ElaborationRunner = (request: ElaborationSessionRequest) => Promise<ElaborationSessionResult>
