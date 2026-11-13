import type { CodeBehaviorEvidence, ContractNodeChange, GenerationDirection } from './writeback-types.js'
import type { Acceptance, Contract, ContractFinding } from '@spexcode/spec-core/contracts'
import type { ElaborationFact, ElaborationRunner, ElaborationSessionRequest, ElaborationTrace } from './elaboration-types.js'
import type { CandidateRef, ComposedInputRef, InputSnapshot, SyncScope } from './operation-types.js'
import type { CandidateChanges } from './candidate.js'
import type { SnapshotManifest, TreeEntry } from './snapshot.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'

/** 一次生成尝试的全部可信输入；调用者管理预算、attempt 和持久状态。 */
export type GenerationInput = {
  root: string
  nativeWorktree?: boolean
  /** 分区继承同一个已审全局Spec overlay，不把局部投影当整棵输入。 */
  stageTree?: string
  requestKey: string
  snapshot: InputSnapshot
  composed?: ComposedInputRef
  manifest: SnapshotManifest
  files: ReadonlyMap<string, string>
  contracts: readonly Contract[]
  readonlyContractPaths?: readonly string[]
  priorContext?: readonly { role: 'source_before' | 'verified_delivery'; pairId?: string; snapshot: InputSnapshot; entries: readonly TreeEntry[]; files: ReadonlyMap<string, string>; objects: readonly { entry: TreeEntry; kind: 'binary' | 'symlink'; encoding: 'base64'; content: string }[] }[]
  /** P1 通过后的待交付详细 Spec；不替换 original composed 基线。 */
  elaboratedSpecs: readonly { path: string; source: string }[]
  readyIds: readonly string[]
  blockedIds: readonly string[]
  retiredIds?: readonly string[]
  retiredOwners?: readonly { id: string; path: string }[]
  intent: { nodeId: string; rawSource: string }
  facts: readonly ElaborationFact[]
  existingAcceptance: readonly Acceptance[]
  mandatoryTests: SyncCoordinatorPlan['mandatoryTests']
  recordUnverifiedCoverage?: true
  verifications: readonly SyncCoordinatorPlan['verifications'][number]['definition'][]
  /** 已结算失败产物和诊断；修复上下文不是新的业务事实或通过证据。 */
  /** 仅引用同组已认证格式拒绝或Native成功但字段无效的原件；原JSON仍为未批准诊断，不进入业务候选。 */
  reviewRepair?: { resultRef: import('./operation-types.js').BlobRef; nativePlanRef: import('./operation-types.js').BlobRef; checkpointRef: import('./operation-types.js').BlobRef; stoppedDraftRef?: import('./operation-types.js').BlobRef }
  repairContext?: { previousOutput: unknown; diagnostics: readonly { code: string; message: string }[] }
  analysis?: CodeBehaviorEvidence
  analysisEvidence?: readonly CodeBehaviorEvidence[]
  direction?: GenerationDirection
  nodeChanges?: readonly ContractNodeChange[]
  allowedScope: SyncScope
  policy: { version: string; digest: string }
  timeoutMs: number | null
  signal?: AbortSignal
  model: string
  effort: 'high'
}

export type StoppedCandidateReviewDraft = {
  version: 'candidate-review-stopped-draft-v1'
  fromOperationId: string
  fromAttemptId: string
  sourceResultRef: import('./operation-types.js').BlobRef
  nativePlanRef: import('./operation-types.js').BlobRef
  checkpointRef: import('./operation-types.js').BlobRef
  draft: import('./elaboration-types.js').ElaborationDraft
  indexSha256: string
}
/** 独立语义发现均为阻断项；程序硬门禁另用 ContractFinding.severity。 */
export type GenerationFinding = {
  kind: 'repair' | 'missing_fact' | 'conflict'
  affectedIds: string[]
  ruleLocation: string
  codeLocation: string
  evidence: string
  counterexample: string
  message: string
}
export type GenerationReview = {
  inputId: string
  candidateDigest: string
  verdict: 'accept' | 'repair' | 'needs_input' | 'conflict'
  checkedIds: string[]
  findings: GenerationFinding[]
}
export type GenerationOptions = {
  runner: ElaborationRunner
  prepareOnly?: boolean
  reviewCandidate?: CandidateRef
  builderTraces?: readonly ElaborationTrace[]
  /** 既有最终分区dispatch推导的P2 Spec写范围；只读返P1定位早验不改变冻结输入。 */
  reviewSpecWritePaths?: readonly string[]
  implementationPolicy?: { writePaths: readonly string[]; sourcePaths: readonly string[] }
  beforePartitionGeneration?: (paths: readonly string[], evidenceRef: import('./operation-types.js').BlobRef) => Promise<{ scope: SyncScope; composed?: ComposedInputRef }>
  validateCandidate: (candidate: CandidateRef) => Promise<readonly ContractFinding[]>
  /** 必须在 native 派发前完成持久登记；native 身份绑定由 runner 包装者负责。 */
  onDispatch?: (request: ElaborationSessionRequest) => Promise<void>
  /** 可信发布器在生成响应核验后锁定发布父树；原始模型输入不变。 */
  beforeFreezeCandidate?: () => Promise<ComposedInputRef>
  /** 包含不存在文件的完整只读闭包，不加入模型提示或输入摘要。 */
  protectedReadPaths?: readonly string[]
}
export type GenerationResult = {
  status: 'prepared' | 'reviewed' | 'repair' | 'needs_input' | 'conflict' | 'failed' | 'cancelled' | 'unsupported'
  inputId: string
  inputDigest: string
  candidate: CandidateRef | null
  /** 仅本地使用的完整候选文本，不序列化进 store/外发 JSON。 */
  candidateFiles: ReadonlyMap<string, string> | null
  fileWriterPlanRef?: import('./operation-types.js').BlobRef
  preparedChanges?: CandidateChanges
  partitionEvidence?: { partitionId: string; candidateDigest: string; review: GenerationReview; traces: ElaborationTrace[] }[]
  output: unknown
  reviewOutput: unknown
  review: GenerationReview | null
  validationFindings: ContractFinding[]
  traces: ElaborationTrace[]
  candidateValidated: boolean
  reviewPassed: boolean
  runtimeVerification: 'not_run'
  delivery: 'not_applied'
  failure: { code: string; message: string; sessionId?: string; threadId?: string; turnId?: string; requestKey?: string; inputDigest?: string } | null
}
