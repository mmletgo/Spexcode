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
}
export interface VerificationCheckpoint {
  version: 'verification-checkpoint-v1'
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
}
export interface VerificationDependencies {
  onCheckpoint: (checkpoint: VerificationCheckpoint) => Promise<void>
  driver?: VerificationDriver
}
export interface VerificationResult {
  status: VerificationEvidence['outcome'] | 'unsupported' | 'recovery_required'
  checkpoint?: VerificationCheckpoint
  evidence?: VerificationEvidence
  reason?: string
}
