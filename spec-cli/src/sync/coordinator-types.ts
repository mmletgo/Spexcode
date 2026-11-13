import type { SyncDecisionAuthority } from './writeback-types.js'
import type { AuthorizedContractChange, ElaborationFact, ElaborationRunner } from './elaboration-types.js'
import type { AdmitSyncInput, ApplyReceipt, BaselinePair, BlobRef, FrozenBaselineSelection, SyncBudget, SyncFailure, SyncOperation, SyncScope, InputSnapshot } from './operation-types.js'
import type { DeliveryTools, PrivateDeliveryOptions } from './private-delivery.js'
import type { RegisteredVerification } from './verification-plan.js'
import type { VerificationDriver, VerificationTransportConfiguration } from './verification-executor-types.js'

/** 来源与执行政策由可信应用入口冻结，未来业务 ID 由真实细化结果登记。 */
type SyncCoordinatorPlanBody = {
  /** 缺席的历史操作继续原frozen协议，不热迁移。 */
  agentWorkflow?: 'native-worktree-v1'
  intentNodeId: string
  targets: readonly { nodeId: string; path: string; rawSource?: string }[]
  readPaths: readonly string[]
  writePaths: readonly string[]
  sourcePaths?: readonly string[]
  executionScope?: SyncScope
  facts: readonly ElaborationFact[]
  verifications: readonly RegisteredVerification[]
  /** 全图封口保留未选 owner 的可信定义，不增加本轮验证运行。 */
  contextVerifications?: readonly RegisteredVerification['definition'][]
  mandatoryTests: readonly { verificationId: string; testPath: string; testId: string }[]
  authorizedChanges?: readonly AuthorizedContractChange[]
  retiredIds?: readonly string[]
  decisionRefs?: readonly BlobRef[]
  decisionAuthorities?: readonly SyncDecisionAuthority[]
  newNodeRawSources?: readonly { path: string; rawSource: string }[]
}
export type SyncDirection = 'spec_to_code' | 'code_to_spec' | 'combined'
export type SyncCoordinatorPlan = SyncCoordinatorPlanBody & ({ version: 'sync-coordinator-v1' } | {
  version: 'sync-coordinator-v2'
  direction: SyncDirection
  commitTrigger?: { before: InputSnapshot | null; paths: readonly string[] }
  partitionPolicy: { version: 'sync-partition-policy-v1' | 'sync-partition-policy-v2'; maxReadBytes: number; maxParallel: number }
})
export type SyncAdmissionOptions = {
  ingressKey: string; rootCauseId: string; origin: AdmitSyncInput['origin']; budget: SyncBudget
  managedRoot: string; requestBlob?: BlobRef; retryOf?: string; model?: string; previousBaselinePair?: BaselinePair | null; baselineSelection?: FrozenBaselineSelection
  recordUnverifiedCoverage?: true
  /** 可信重试入口沿原 operation 已审扩展重建读集合，不改冻结计划或影响身份。 */
  executionScope?: SyncScope; impactDigest?: string
}
export type SyncCoordinatorOptions = {
  plan: SyncCoordinatorPlan
  readCurrentPlan: () => SyncCoordinatorPlan | Promise<SyncCoordinatorPlan>
  managedRoot: string; artifactRoot: string; tools: DeliveryTools
  recoveryOnly?: boolean
  runner?: ElaborationRunner; verificationDriver?: VerificationDriver; verificationTransport?: VerificationTransportConfiguration; signal?: AbortSignal
  leaseMs?: number; heartbeatMs?: number; callTimeoutMs?: number
  /** 故障注入只暂停已有真实副作用，不能替换 Git 完成证据。 */
  deliveryHooks?: Pick<PrivateDeliveryOptions, 'afterFileWrite' | 'afterCommit' | 'afterReceipt'>
}
export type SyncCoordinatorResult = {
  status: SyncOperation['phase'] | 'busy' | 'unsupported' | 'recovery_required'
  operation: SyncOperation; receipt?: ApplyReceipt; failure?: SyncFailure
}
