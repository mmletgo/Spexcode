/** 上层提供并保护政策；候选不能更换镜像、命令或缩小验收集合。 */
export interface VerificationPolicy {
  version: string
  image: string
  platform: 'linux/arm64' | 'linux/amd64'
  argv: string[]
  cwd: string
  expectedTestIds: string[]
  timeoutMs: number
  memoryBytes: number
  cpus: number
  pidsLimit: number
  scratchBytes: number
  scratchExecutable?: boolean
  logBytes: number
}
export interface VerificationRequest {
  runId: string
  inputDigest: string
  candidateDigest: string
  candidateExportDigest: string
  candidateExportPath: string
  privateScratchRoot: string
  policy: VerificationPolicy
  previousCheckpoint?: VerificationCheckpoint
  signal?: AbortSignal
}
export interface VerificationCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
}
export type VerificationTransportConfiguration = { kind: 'ssh-docker-v1'; sshAlias: string; privateRoot: string; dockerEndpoint?: string }
export type VerificationTransportPlan = {
  version: 'verification-ssh-v1'; sshAlias: string; privateRoot: string; rootIdentity: string; daemonId: string; dockerEndpoint: string
  runKey: string; directory: string; candidatePath: string; runnerPath: string
}
export type VerificationEffect = { id: string; digest: string; kind: string }
export type VerificationTransportState = { plan: VerificationTransportPlan; effects: VerificationEffect[]; attestation?: { exportDigest: string; runnerDigest: string }; closed?: unknown; removal?: unknown; cleanup?: unknown }
/** CLI adapter 仅接受 argv；不启动 shell。测试可注入可观察的故障驱动。 */
export type VerificationDriver = (argv: readonly string[], maxBytes: number) => Promise<VerificationCommandResult>
export interface VerificationConfig {
  image: string
  imageId: string
  environment: string[]
  platform: string
  argv: string[]
  candidatePath: string
  runnerPath: string
  exportDigest: string
  runnerDigest: string
  policy: VerificationPolicy
  maskedVolumePaths?: string[]
  transport?: VerificationTransportPlan
}
export interface VerificationTestResult {
  testId: string
  status: 'passed' | 'failed' | 'skipped'
}
export interface VerificationEvidence {
  runId: string
  inputDigest: string
  candidateDigest: string
  exportDigest: string
  policyDigest: string
  configDigest: string
  runnerDigest: string
  environment: { driver: 'docker'; platform: string; image: string; imageId: string; daemonVersion: string }
  containerId: string
  exitCode: number
  stdout: string
  stderr: string
  logsTruncated: boolean
  tests: VerificationTestResult[]
  unmatchedTestIds: string[]
  reportComplete: boolean
  reportFormat: 'node-test-events-v1'
  terminalInspect: unknown
  outcome: 'passed' | 'failed' | 'cancelled' | 'timeout'
  stdoutDigest?: string
  stderrDigest?: string
}
export interface VerificationCheckpoint {
  version: 'verification-checkpoint-v1' | 'verification-checkpoint-v2'
  phase: 'planned' | 'created' | 'terminal' | 'removed'
  runId: string
  inputDigest: string
  candidateDigest: string
  policyDigest: string
  uniqueContainerName: string
  labels: Record<string, string>
  configDigest: string
  config: VerificationConfig
  daemonVersion: string
  deadlineAt: number
  containerId?: string
  createdInspect?: unknown
  evidence?: VerificationEvidence
  transport?: VerificationTransportState
  notCreated?: { outcome: 'cancelled' | 'timeout'; observation: unknown }
}
export interface VerificationDependencies {
  onCheckpoint: (checkpoint: VerificationCheckpoint) => Promise<void>
  driver?: VerificationDriver
  transport?: VerificationTransportConfiguration
  assertLaunchAllowed?: () => void
}
/** 仅SSH超时的安全观察元数据；不包含请求、路径或输出正文，也不证明远端已停止。 */
export interface VerificationRpcDiagnostics {
  version: 'verification-ssh-rpc-diagnostics-v1'
  action: string
  dockerVerb?: string
  budgetMs: number
  elapsedMs: number
  overdueMs: number
  preparationMs: number
  eventLoopActiveMs: number
  eventLoopIdleMs: number
  firstOutputAtMs: number | null
  lastOutputAtMs: number | null
  stdoutBytes: number
  stderrBytes: number
  stdinFinished: boolean
  stdoutEnded: boolean
  stderrEnded: boolean
  responseLineComplete: boolean
  childExitObserved: boolean
  childCloseObserved: boolean
  childExitCode: number | null
  childSignalCode: string | null
  moduleFile: string
  moduleUrlSha256: string
  helperSha256: string
  helperBytes: number
  bootstrapBytes: number
}
export interface VerificationResult {
  status: VerificationEvidence['outcome'] | 'unsupported' | 'recovery_required'
  checkpoint?: VerificationCheckpoint
  evidence?: VerificationEvidence
  reason?: string
  rpcDiagnostics?: VerificationRpcDiagnostics
}
