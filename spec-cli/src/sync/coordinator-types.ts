import type { AuthorizedContractChange, ElaborationFact, ElaborationRunner } from './elaboration-types.js'
import type { AdmitSyncInput, ApplyReceipt, BaselinePair, BlobRef, SyncBudget, SyncFailure, SyncOperation } from './operation-types.js'
import type { DeliveryTools, PrivateDeliveryOptions } from './private-delivery.js'
import type { RegisteredVerification } from './verification-plan.js'
import type { VerificationDriver } from './verification-executor-types.js'

/** 来源与执行政策由可信应用入口冻结，未来业务 ID 由真实细化结果登记。 */
export type SyncCoordinatorPlan = {
  version: 'sync-coordinator-v1'
  intentNodeId: string
  targets: readonly { nodeId: string; path: string; rawSource?: string }[]
  readPaths: readonly string[]
  writePaths: readonly string[]
  facts: readonly ElaborationFact[]
  verifications: readonly RegisteredVerification[]
  mandatoryTests: readonly { verificationId: string; testPath: string; testId: string }[]
  authorizedChanges?: readonly AuthorizedContractChange[]
  retiredIds?: readonly string[]
  newNodeRawSources?: readonly { path: string; rawSource: string }[]
}
export type SyncAdmissionOptions = {
  ingressKey: string; rootCauseId: string; origin: AdmitSyncInput['origin']; budget: SyncBudget
  managedRoot: string; requestBlob?: BlobRef; retryOf?: string; previousBaselinePair?: BaselinePair | null
}
export type SyncCoordinatorOptions = {
  plan: SyncCoordinatorPlan
  readCurrentPlan: () => SyncCoordinatorPlan | Promise<SyncCoordinatorPlan>
  managedRoot: string; artifactRoot: string; tools: DeliveryTools
  recoveryOnly?: boolean
  runner?: ElaborationRunner; verificationDriver?: VerificationDriver; signal?: AbortSignal
  leaseMs?: number; heartbeatMs?: number; callTimeoutMs?: number
  /** 故障注入只暂停已有真实副作用，不能替换 Git 完成证据。 */
  deliveryHooks?: Pick<PrivateDeliveryOptions, 'afterFileWrite' | 'afterCommit' | 'afterReceipt'>
}
export type SyncCoordinatorResult = {
  status: SyncOperation['phase'] | 'busy' | 'unsupported' | 'recovery_required'
  operation: SyncOperation; receipt?: ApplyReceipt; failure?: SyncFailure
}
