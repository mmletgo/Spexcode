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
export const SYNC_PHASES = ['detected', 'queued', 'analyzing', 'elaborating', 'generating', 'verifying', 'repairing', 'needs_input', 'conflicted', 'ready_to_apply', 'applying', 'workspace_synced', 'awaiting_landing', 'canonical_synced', 'superseded', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'budget_exhausted', 'recovering', 'recovery_required'] as const
export type SyncPhase = typeof SYNC_PHASES[number]
export type SyncControl = 'run' | 'pause' | 'cancel'
export type SyncBudget = { maxAttempts: number; maxRepairs: number; timeoutMs: number }
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
}
export type SyncOperation = {
  id: string; ingressKey: string; payloadDigest: string; rootCauseId: string
  origin: 'spec' | 'code' | 'combined' | 'reconcile' | 'decision'
  generation: number; revision: number; phase: SyncPhase; control: SyncControl
  input: InputSnapshot; previousBaselinePair: BaselinePair | null
  scope: SyncScope; readyScope: SyncScope; blockedScope: SyncScope; deliveredScope: SyncScope
  blockedReason: 'needs_input' | 'conflicted' | null
  budget: SyncBudget; currentAttemptId: string | null
  dispatchMessageId: string; delivery: WorktreeIdentity; createdAtMs: number; updatedAtMs: number
}
export type NativeSessionRef = { sessionId: string; threadId: string | null; turnId: string | null }
export type CandidateRef = { tree: string; digest: string; manifestBlob: BlobRef; coveredScope: SyncScope }
export type VerificationRef = { candidateDigest: string; inputId: string; passed: boolean; coveredScope: SyncScope; evidenceRefs: BlobRef[]; resultBlob: BlobRef }
export type SyncAttempt = {
  id: string; operationId: string; number: number; generation: number
  dispatchKey: string; sessionCreateKey: string; status: 'claimed' | 'running' | 'frozen' | 'verified' | 'applying' | 'settled' | 'failed' | 'superseded'
  session: NativeSessionRef | null; candidate: CandidateRef | null; verification: VerificationRef | null
  checkpointRefs: BlobRef[]; failure: SyncFailure | null; leaseToken: string; expiresAtMs: number
}
export type WriteFence = { operationId: string; attemptId: string; generation: number; sourceFingerprint: string; leaseToken: string }
export type ScopeLease = { token: string; operationId: string; attemptId: string; repositoryId: string; generation: number; scope: SyncScope; expiresAtMs: number }
export type ApplyFilePlan = { path: string; preDigest: string | null; postDigest: string | null; preMode: string | null; postMode: string | null }
export type ApplyPlan = {
  effectKey: string; payloadDigest: string; candidateDigest: string; verificationBlob: BlobRef
  target: WorktreeIdentity; expectedTargetSnapshotId: string; expectedBaselinePairId: string | null
  coveredScope: SyncScope; files: ApplyFilePlan[]; planBlob: BlobRef
}
export type ApplyStep = { key: string; status: 'planned' | 'completed'; evidenceRef: BlobRef | null }
export type ApplyReceipt = { id: string; journalId: string; effectKey: string; actualTree: string; actualCommit: string | null; deliverySnapshot: InputSnapshot; evidenceRefs: BlobRef[]; completedAtMs: number }
export type ApplyJournal = { id: string; operationId: string; attemptId: string; generation: number; plan: ApplyPlan; status: 'prepared' | 'applying' | 'completed' | 'settled' | 'recovery_required'; steps: ApplyStep[]; receipt: ApplyReceipt | null; createdAtMs: number }
export type SyncDispatchEnvelope = { version: 1; type: 'sync.dispatch'; operationId: string; inputId: string; generation: number; dispatchKey: string }
export type AdmitSyncInput = Pick<SyncOperation, 'ingressKey' | 'rootCauseId' | 'origin' | 'input' | 'scope' | 'budget' | 'delivery'> & { previousBaselinePair?: BaselinePair | null }
export type ClaimAttemptInput = { operationId: string; source: WorktreeIdentity; scope: SyncScope; leaseMs: number; expectedMessageId?: string }
export type ClaimedAttempt = { operation: SyncOperation; attempt: SyncAttempt; fence: WriteFence; lease: ScopeLease }
export type RecoverableSync = { operation: SyncOperation; attempt: SyncAttempt | null; journals: ApplyJournal[] }
