export function verificationExportDigest(source: string, destination?: string, portable?: boolean): Promise<string>
export function verificationEffectDigest(request: { effect: { kind: string }; args?: readonly string[]; maxBytes?: number; reporter?: string; exportDigest?: string; runnerDigest?: string; containerId?: string; cwd?: string }): string
export function verificationSshMain(options?: { dockerProgram?: string; flockProgram?: string; replyWaitMs?: number }): Promise<void>
export function verificationSshWorker(options?: { dockerProgram?: string; flockProgram?: string; replyWaitMs?: number }): Promise<void>
