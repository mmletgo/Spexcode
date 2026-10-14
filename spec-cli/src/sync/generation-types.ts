import type { CodeBehaviorEvidence, ContractNodeChange, GenerationDirection } from './writeback-types.js'
import type { Acceptance, Contract, ContractFinding } from '@spexcode/spec-core/contracts'
import type { ElaborationFact, ElaborationRunner, ElaborationSessionRequest, ElaborationTrace } from './elaboration-types.js'
import type { CandidateRef, ComposedInputRef, InputSnapshot, SyncScope } from './operation-types.js'
import type { SnapshotManifest } from './snapshot.js'

/** 一次生成尝试的全部可信输入；调用者管理预算、attempt 和持久状态。 */
export type GenerationInput = {
  root: string
  requestKey: string
  snapshot: InputSnapshot
  composed?: ComposedInputRef
  manifest: SnapshotManifest
  files: ReadonlyMap<string, string>
  contracts: readonly Contract[]
  /** P1 通过后的待交付详细 Spec；不替换 original composed 基线。 */
  elaboratedSpecs: readonly { path: string; source: string }[]
  readyIds: readonly string[]
  blockedIds: readonly string[]
  intent: { nodeId: string; rawSource: string }
  facts: readonly ElaborationFact[]
  existingAcceptance: readonly Acceptance[]
  /** 已结算失败产物和诊断；修复上下文不是新的业务事实或通过证据。 */
  repairContext?: { previousOutput: unknown; diagnostics: readonly { code: string; message: string }[] }
  analysis?: CodeBehaviorEvidence
  direction?: GenerationDirection
  nodeChanges?: readonly ContractNodeChange[]
  allowedScope: SyncScope
  policy: { version: string; digest: string }
  timeoutMs: number
  signal?: AbortSignal
  model: 'gpt-6.1-sol'
  effort: 'high'
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
  validateCandidate: (candidate: CandidateRef) => Promise<readonly ContractFinding[]>
  /** 必须在 native 派发前完成持久登记；native 身份绑定由 runner 包装者负责。 */
  onDispatch?: (request: ElaborationSessionRequest) => Promise<void>
}
export type GenerationResult = {
  status: 'reviewed' | 'repair' | 'needs_input' | 'conflict' | 'failed' | 'cancelled' | 'unsupported'
  inputId: string
  inputDigest: string
  candidate: CandidateRef | null
  /** 仅本地使用的完整候选文本，不序列化进 store/外发 JSON。 */
  candidateFiles: ReadonlyMap<string, string> | null
  output: unknown
  reviewOutput: unknown
  review: GenerationReview | null
  validationFindings: ContractFinding[]
  traces: ElaborationTrace[]
  candidateValidated: boolean
  reviewPassed: boolean
  runtimeVerification: 'not_run'
  delivery: 'not_applied'
  failure: { code: string; message: string } | null
}
