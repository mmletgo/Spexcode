import type { CodeBehaviorEvidence, ContractNodeChange, SyncDecisionAuthority } from './writeback-types.js'
import type { BlobRef } from './operation-types.js'
import type { Contract, ContractCoverage, ContractFinding, ContractGraph, Gap, ParseContractInput, Verification } from '@spexcode/spec-core/contracts'

export const ELABORATION_BOUNDARIES = ['permissions', 'mutation', 'async', 'network', 'concurrency', 'callbacks', 'retries', 'cancellation', 'idempotency', 'external_side_effects'] as const
export type ElaborationBoundary = typeof ELABORATION_BOUNDARIES[number]
export type ElaborationTarget = { nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }
export type ElaborationFact = { source: string; text: string }
/** 调用者已确认的用户原意或裁决变更；不是 Agent 自己生成的批准请求。 */
export type AuthorizedContractChange = { id: string; action: 'retire' | 'update_verification'; source: 'user:raw' | `decision:${string}`; reason: string } | { id: string; action: 'update_acceptance'; source: 'user:raw' | `decision:${string}` | `code:${string}`; reason: string; ruleIds: string[]; analysisRef: BlobRef }
export type ElaborationInput = {
  root: string
  base?: string
  requestKey: string
  intent: { nodeId: string; rawSource: string }
  targets: readonly ElaborationTarget[]
  context?: readonly ParseContractInput[]
  facts?: readonly ElaborationFact[]
  /** 可信执行器登记属于技术编排，不是待裁决的业务事实或变更授权。 */
  verifications?: readonly Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>[]
  authorizedChanges?: readonly AuthorizedContractChange[]
  /** 协调器保存的稳定 ID 退役记录，新候选不可复用。 */
  retiredIds?: readonly string[]
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
  status: 'complete' | 'needs_input' | 'conflict' | 'unsupported' | 'failed' | 'cancelled' | 'exhausted'
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
}
export type ElaborationSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string }
export type ElaborationRunner = (request: ElaborationSessionRequest) => Promise<ElaborationSessionResult>
