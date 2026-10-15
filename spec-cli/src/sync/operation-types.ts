/** 内容寻址运行证据；正文、文件清单与命令结果保存在既有 evidence blob。 */
export type BlobRef = { sha256: string }
export type WorktreeIdentity = {
  repositoryId: string
  commonDir: string
  canonicalRoot: string
  gitDir: string
  branch: string
  physicalFingerprint: string
}
export type PhysicalScope = Pick<WorktreeIdentity, 'repositoryId' | 'canonicalRoot' | 'physicalFingerprint'>
export type PhysicalControl = { scope: PhysicalScope; control: 'run' | 'pause'; revision: number }
export type DispatchAnchor = { scope: PhysicalScope; firstMessageId: string; firstEnqueueSeq: number; budgetRootOperationId: string }
export type InputSnapshot = {
  /** 内容与物理身份形成稳定 ID；采集时间不参与。 */
  id: string
  source: WorktreeIdentity
  headCommit: string
  immutableTree: string
  indexTree: string
  indexDigest: string
  manifestBlob: BlobRef
  contentDigest: string
  capturedAtMs: number
}
export type SyncScope = { paths: string[]; contractIds: string[]; flowIds: string[] }
export type ContractScopeExpansion = Pick<SyncScope, 'contractIds' | 'flowIds'> & { paths?: string[]; previousBaselineSelectionDigest?: string; baselineSelectionDigest?: string; evidenceRef: BlobRef }
export const SYNC_PHASES = ['detected', 'queued', 'analyzing', 'elaborating', 'generating', 'verifying', 'repairing', 'needs_input', 'conflicted', 'ready_to_apply', 'applying', 'workspace_synced', 'awaiting_landing', 'canonical_synced', 'superseded', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'budget_exhausted', 'recovering', 'recovery_required'] as const
export type SyncPhase = typeof SYNC_PHASES[number]
export type SyncControl = 'run' | 'pause' | 'cancel'
export type SyncBudget = { maxAttempts: number; maxCalls: number; maxRepairs: number; timeoutMs: number }
export type SyncFailure = { code: string; message: string; kind: 'repairable' | 'environment' | 'conflict' | 'missing_input' | 'unsupported' | 'budget'; evidenceRefs: BlobRef[] }
export type BaselinePair = {
  id: string
  repositoryId: string
  source: WorktreeIdentity
  sourceInput: InputSnapshot
  verifiedDelivery: InputSnapshot
  coveredScope: SyncScope
  receiptId: string
  settledAtMs: number
  retiredIds?: string[]
  decisionRefs?: BlobRef[]
}
export type BaselineResource = { kind: 'path'; path: string } | { kind: 'contract' | 'flow'; id: string }
export type BaselineBinding = { resource: { kind: 'path'; path: string }; bytePair: BaselinePair | null } | { resource: { kind: 'contract' | 'flow'; id: string }; intentPair: BaselinePair | null }
export type FrozenBaselineSelection = { version: 'sync-baseline-selection-v1'; source: WorktreeIdentity; bindings: BaselineBinding[]; digest: string }
export type BaselineSelectionResult = { selection: FrozenBaselineSelection } | { failure: SyncFailure }
export type SyncOperation = {
  id: string; ingressKey: string; payloadDigest: string; rootCauseId: string
  origin: 'initial' | 'spec' | 'code' | 'combined' | 'reconcile' | 'decision'
  generation: number; revision: number; phase: SyncPhase; control: SyncControl
  input: InputSnapshot; previousBaselinePair: BaselinePair | null
  baselineSelection?: FrozenBaselineSelection
  dispatchAnchor?: DispatchAnchor
  dispatchAcknowledged?: boolean
  successorOf?: string
  /** 额外的受控用户编辑/裁决请求；与实际来源字节分开，自动文件事件无需该字段。 */
  requestBlob?: BlobRef
  /** 用户显式重开已结束操作；冻结业务输入不变，新执行预算属于新operation。 */
  retryOf?: string
  /** 可恢复的可信政策全文；内容摘要必须等于policyDigest。旧无计划操作明确缺省。 */
  planBlob?: BlobRef
  scope: SyncScope; readyScope: SyncScope; blockedScope: SyncScope; deliveredScope: SyncScope
  contractScopeExpansions?: ContractScopeExpansion[]
  blockedReason: 'needs_input' | 'conflicted' | null
  policyDigest: string; impactDigest: string; readSetDigest: string
  budget: SyncBudget; callsUsed: number; deadlineAtMs: number; currentAttemptId: string | null
  dispatchMessageId: string; delivery: WorktreeIdentity | null; deliveryPlan: DeliveryPlan; createdAtMs: number; updatedAtMs: number
}
export type DeliveryPlan = { canonicalRoot: string; branch: string; baseCommit: string }
export type ComposedInputRef = { sourceInputId: string; previousBaselinePairId: string | null; baselineSelectionDigest?: string; tree: string; manifestBlob: BlobRef; contentDigest: string; requestBlob?: BlobRef; authorProjectionBlob?: BlobRef; compositionEvidenceBlob?: BlobRef }
export type PublicationHeads = { selection: FrozenBaselineSelection; unknownPaths: { path: string; reason: string }[] }
export type PublicationBase = { parentCommit: string; parentTree: string; parentManifestBlob: BlobRef; provenanceBlob: BlobRef; composed: ComposedInputRef }
export type DispatchPlan = { key: string; purpose: string; requestDigest: string; sessionCreateKey: string; session: NativeSessionRef | null }
export type NativeSessionRef = { sessionId: string; threadId: string | null; turnId: string | null }
export type CandidateRef = { baseTree: string; sourceInputId: string; tree: string; digest: string; manifestBlob: BlobRef; actualDiffBlob: BlobRef; coveredScope: SyncScope }
export type VerificationRef = { candidateDigest: string; inputId: string; passed: boolean; coveredScope: SyncScope; policyDigest: string; readSetDigest: string; baselineSelectionDigest?: string; environmentDigest: string; contextDigest: string; evidenceRefs: BlobRef[]; resultBlob: BlobRef }
export type SyncAttempt = {
  id: string; operationId: string; number: number; generation: number
  baselineSelectionDigest?: string
  publicationBase?: PublicationBase
  dispatchKey: string; sessionCreateKey: string; status: 'claimed' | 'running' | 'frozen' | 'verified' | 'applying' | 'settled' | 'failed' | 'superseded'
  currentSession: NativeSessionRef | null; dispatchPlans: DispatchPlan[]; composedInput: ComposedInputRef | null; candidate: CandidateRef | null; verification: VerificationRef | null
  checkpointRefs: BlobRef[]; failure: SyncFailure | null; leaseToken: string; expiresAtMs: number
}
export type WriteFence = { operationId: string; attemptId: string; generation: number; sourceFingerprint: string; leaseToken: string }
export type ScopeLease = { token: string; operationId: string; attemptId: string; repositoryId: string; generation: number; scope: SyncScope; expiresAtMs: number }
export type ApplyFilePlan = { path: string; preDigest: string | null; postDigest: string | null; preMode: string | null; postMode: string | null }
export type ApplyPlan = {
  effectKey: string; payloadDigest: string; candidateDigest: string; verificationBlob: BlobRef
  target: WorktreeIdentity; expectedTargetSnapshotId: string; expectedBaselinePairId: string | null; expectedBaselineSelectionDigest?: string
  publicationBaseRef?: BlobRef
  coveredScope: SyncScope; files: ApplyFilePlan[]; planBlob: BlobRef
}
export type ApplyStep = { key: string; status: 'planned' | 'completed'; evidenceRef: BlobRef | null }
export type ApplyReceipt = { id: string; journalId: string; effectKey: string; actualTree: string; actualCommit: string | null; deliverySnapshot: InputSnapshot; evidenceRefs: BlobRef[]; completedAtMs: number }
export type ApplyJournal = { id: string; operationId: string; attemptId: string; generation: number; plan: ApplyPlan; status: 'prepared' | 'applying' | 'completed' | 'settled' | 'recovery_required'; steps: ApplyStep[]; receipt: ApplyReceipt | null; createdAtMs: number }
export type SyncDispatchEnvelope = { version: 1; type: 'sync.dispatch'; operationId: string; inputId: string; generation: number; dispatchKey: string }
export type AdmitSyncInput = Pick<SyncOperation, 'ingressKey' | 'rootCauseId' | 'origin' | 'input' | 'requestBlob' | 'retryOf' | 'planBlob' | 'scope' | 'budget' | 'delivery' | 'policyDigest' | 'impactDigest' | 'readSetDigest' | 'deliveryPlan'> & { previousBaselinePair?: BaselinePair | null; baselineSelection?: FrozenBaselineSelection }
export type ClaimAttemptInput = { operationId: string; source: WorktreeIdentity; scope: SyncScope; leaseMs: number; expectedMessageId?: string }
export type ClaimedAttempt = { operation: SyncOperation; attempt: SyncAttempt; fence: WriteFence; lease: ScopeLease }
export type RecoverableSync = { operation: SyncOperation; attempt: SyncAttempt | null; journals: ApplyJournal[] }

export type VerificationLayerResult = { layer: 'V1' | 'V2' | 'V3' | 'V4'; verdict: 'pass' | 'fail' | 'unsupported'; evidenceRefs: BlobRef[] }
export type VerificationResultBlob = { schemaVersion: 1; coveredScope: SyncScope; inputId: string; candidateDigest: string; policyDigest: string; readSetDigest: string; baselineSelectionDigest?: string; environmentDigest: string; contextDigest: string; layers: VerificationLayerResult[]; retiredIds?: string[]; decisionRefs?: BlobRef[] }

/** 原生资源状态与业务写入授权分离；removed 才表示容量可释放。 */
export type SyncResourcePhase = 'planned' | 'created' | 'terminal' | 'removed'
export type SyncResourcePlan = {
  key: string; kind: 'verification' | 'native_session'; payloadDigest: string
  inputId: string; candidateDigest: string | null; planBlob: BlobRef; checkpointRef: BlobRef
}
export type SyncResourceRecord = {
  id: string; operationId: string; attemptId: string; generation: number; plan: SyncResourcePlan
  phase: SyncResourcePhase; checkpointRef: BlobRef
  checkpoints: { phase: SyncResourcePhase; checkpointRef: BlobRef }[]
  createdAtMs: number; updatedAtMs: number
}
export type SyncResourceCheckpoint = {
  operationId: string; attemptId: string; inputId: string; candidateDigest: string | null
  phase: SyncResourcePhase; expectedCheckpointRef: BlobRef; checkpointRef: BlobRef
}
export type RecoverableSyncResource = { operation: SyncOperation; attempt: SyncAttempt; resource: SyncResourceRecord }

export type SyncIngressReceipt = Pick<AdmitSyncInput, 'requestBlob' | 'budget' | 'deliveryPlan' | 'previousBaselinePair' | 'baselineSelection'> & { operationId: string; payloadDigest: string; input?: InputSnapshot; origin?: SyncOperation['origin'] }

export type ClaimQueuedAttemptInput = ClaimAttemptInput & { expectedRevision: number; continuation?: true }
export type SyncObservationInput = { input: InputSnapshot; configRef: BlobRef; selection: FrozenBaselineSelection | null; latestDifferenceDigest: string; failure?: SyncFailure }
export type SyncObservation = SyncObservationInput & { id: string; controlRevision: number; selectionDigest: string | null; observedAtMs: number; operationId: string | null; outcome: 'observed' | 'admitted' | 'coalesced' | 'duplicate' | 'blocked'; reason: SyncFailure | null }
export type ObserveAndAdmitResult = { outcome: 'admitted' | 'coalesced' | 'duplicate'; operation: SyncOperation; observation: SyncObservation } | { outcome: 'blocked'; observation: SyncObservation; reason: SyncFailure }

export type SyncObserverHealth = { scope: PhysicalScope; instanceId: string; processId: number; startedAtMs: number; updatedAtMs: number; status: 'starting' | 'watching' | 'degraded' | 'stopped'; failure?: SyncFailure }
