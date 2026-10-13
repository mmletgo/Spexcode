import type { Contract, ContractCoverage, ContractFinding, ContractGraph, Gap, ParseContractInput } from '@spexcode/spec-core/contracts'

export const ELABORATION_BOUNDARIES = ['permissions', 'mutation', 'async', 'network', 'concurrency', 'callbacks', 'retries', 'cancellation', 'idempotency', 'external_side_effects'] as const
export type ElaborationBoundary = typeof ELABORATION_BOUNDARIES[number]
export type ElaborationTarget = { nodeId: string; path: string; source: string | null; sourceDigest: string | null; rawSource?: string }
export type ElaborationFact = { source: string; text: string }
/** 调用者已确认的用户原意或裁决变更；不是 Agent 自己生成的批准请求。 */
export type AuthorizedContractChange = { id: string; action: 'retire' | 'update_verification'; source: 'user:raw' | `decision:${string}`; reason: string }
export type ElaborationInput = {
  root: string
  base?: string
  requestKey: string
  intent: { nodeId: string; rawSource: string }
  targets: readonly ElaborationTarget[]
  context?: readonly ParseContractInput[]
  facts?: readonly ElaborationFact[]
  authorizedChanges?: readonly AuthorizedContractChange[]
  /** 协调器保存的稳定 ID 退役记录，新候选不可复用。 */
  retiredIds?: readonly string[]
  /** 冻结上下文中的源码/测试字节；存在时验证契约绑定指向真实文件。 */
  files?: ReadonlyMap<string, string>
  maxRepairs?: number
  timeoutMs?: number
  signal?: AbortSignal
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}
export type Applicability = { boundary: ElaborationBoundary; applies: boolean; basis: string; affectedIds: string[] }
export type ElaborationChange = { nodeId: string; path: string; beforeDigest: string | null; source: string }
export type ElaborationCandidate = { inputDigest: string; changes: ElaborationChange[]; applicability: Applicability[] }
export type ElaborationReviewFinding = { code: string; kind: 'repair' | 'missing_fact' | 'conflict'; message: string; affectedIds: string[]; evidence: string; decision: string }
export type ElaborationReview = { inputDigest: string; candidateDigest: string; verdict: 'accept' | 'repair' | 'needs_input' | 'conflict'; checkedBoundaries: ElaborationBoundary[]; findings: ElaborationReviewFinding[] }
export type ElaborationTrace = { purpose: string; sessionId: string; threadId: string; turnId: string; resultDigest: string; inputDigest: string }
export type ElaborationRound = { index: number; output: unknown; candidate: ElaborationCandidate | null; candidateDigest: string | null; findings: ContractFinding[]; reviewOutput: unknown; review: ElaborationReview | null; traces: ElaborationTrace[] }
export type ElaborationResult = {
  status: 'complete' | 'needs_input' | 'conflict' | 'unsupported' | 'failed' | 'cancelled' | 'exhausted'
  inputDigest: string
  candidateDigest: string | null
  changes: (ElaborationChange & { contentDigest: string })[]
  contracts: Contract[]
  graph: ContractGraph | null
  coverage: ContractCoverage | null
  gaps: Gap[]
  blockedIds: string[]
  readyIds: string[]
  retiredIds: string[]
  structurePassed: boolean
  reviewPassed: boolean
  runtimeVerification: 'not_run'
  implementationReady: false
  deferredImplementationFindings: ContractFinding[]
  rounds: ElaborationRound[]
  failure: { code: string; message: string; sessionId?: string; threadId?: string; turnId?: string } | null
}
export type ElaborationSessionRequest = {
  root: string; base?: string; prompt: string; schema: Record<string, unknown>; requestKey: string; inputDigest: string; purpose: string; timeoutMs: number; signal?: AbortSignal; model?: string; effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}
export type ElaborationSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string }
export type ElaborationRunner = (request: ElaborationSessionRequest) => Promise<ElaborationSessionResult>
