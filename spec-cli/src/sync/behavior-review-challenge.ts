import type { BlobRef, P0ReviewChallenge } from './operation-types.js'
import { isHostPrivatePath } from './candidate.js'
import { SyncApplicationError } from './settings.js'
import { contentHash, readEvidence, validateRepositoryPath } from './snapshot.js'

export type P0ReviewChallengeRequest = Pick<P0ReviewChallenge, 'requestId' | 'expectedRevision' | 'inputId' | 'partitionId' | 'analysisRef'> & {
  operationId: string
  diagnostic: string
} & ({ evidencePaths?: never } | { evidencePaths: string[] })

export type P0ReviewDiagnostic = { ref: BlobRef; text: string; evidencePaths?: readonly string[] }

function normalizeEvidencePaths(value: unknown): string[] {
  const invalid = () => new SyncApplicationError('sync_p0_challenge_invalid', '证据须为非空的规范仓库文件路径', 400)
  if (!Array.isArray(value) || !value.length) throw invalid()
  const evidencePaths = value.map((path: unknown) => {
    if (typeof path !== 'string' || isHostPrivatePath(path) || /^\.spex-sync-drafts(?:\/|$)/iu.test(path)) throw invalid()
    try { return validateRepositoryPath(path) } catch { throw invalid() }
  })
  return [...new Set(evidencePaths)].sort()
}

export function requiredBehaviorReviewPaths(changedPaths: readonly string[], diagnostic?: P0ReviewDiagnostic): readonly string[] {
  return diagnostic?.evidencePaths ? [...new Set([...changedPaths, ...diagnostic.evidencePaths])].sort() : changedPaths
}

/** 只接收定位原批准的身份和待核诊断，批准及来源证据由后端取得。 */
export function readP0ReviewChallengeRequest(value: unknown): P0ReviewChallengeRequest {
  const request = value as Partial<P0ReviewChallengeRequest> | null
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== (Object.hasOwn(request, 'evidencePaths') ? 8 : 7)
    || ![request.operationId, request.requestId, request.inputId, request.partitionId].every(item => typeof item === 'string' && item.trim() === item && item.length > 0)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 1
    || !request.analysisRef || typeof request.analysisRef !== 'object' || Object.keys(request.analysisRef).length !== 1
    || typeof request.analysisRef.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.analysisRef.sha256)
    || typeof request.diagnostic !== 'string' || !request.diagnostic.trim() || Buffer.byteLength(request.diagnostic) > 65536
    || Buffer.from(request.diagnostic, 'utf8').toString('utf8') !== request.diagnostic) {
    throw new SyncApplicationError('sync_p0_challenge_invalid', '复审须提供原 operation、requestId、expectedRevision、inputId、partitionId、局部分析 SHA 和至多 64 KiB 的非空 UTF-8 诊断', 400)
  }
  const { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic, evidencePaths } = request as P0ReviewChallengeRequest
  const original = { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic }
  return Object.hasOwn(request, 'evidencePaths') ? { ...original, evidencePaths: normalizeEvidencePaths(evidencePaths) } : original
}

export function p0ReviewDiagnosticEvidence(request: P0ReviewChallengeRequest) {
  const { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic, evidencePaths } = request
  const original = { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic }
  return evidencePaths
    ? { version: 'p0-review-diagnostic-v2' as const, ...original, evidencePaths }
    : { version: 'p0-review-diagnostic-v1' as const, ...original }
}

export function p0ReviewDiagnosticRef(request: P0ReviewChallengeRequest): BlobRef {
  return { sha256: contentHash(JSON.stringify(p0ReviewDiagnosticEvidence(request))) }
}

function readDiagnosticPacket(commonDir: string, ref: BlobRef) {
  const { version, ...body } = JSON.parse(readEvidence(commonDir, ref).toString('utf8')) as ReturnType<typeof p0ReviewDiagnosticEvidence>
  const request = readP0ReviewChallengeRequest(body)
  const packet = p0ReviewDiagnosticEvidence(request)
  if (version !== packet.version || contentHash(JSON.stringify(packet)) !== ref.sha256) {
    throw new SyncApplicationError('sync_p0_challenge_binding', '复审诊断版本或规范字节不一致')
  }
  return packet
}

export function p0ReviewDiagnosticMatches(commonDir: string, diagnostic: P0ReviewDiagnostic): boolean {
  const packet = readDiagnosticPacket(commonDir, diagnostic.ref)
  return packet.diagnostic === diagnostic.text && JSON.stringify(packet.version === 'p0-review-diagnostic-v2' ? packet.evidencePaths : undefined) === JSON.stringify(diagnostic.evidencePaths)
}

/** 独审读取实际保存的同授权诊断，原业务分析输入不消费这份资料。 */
export function readP0ReviewDiagnostic(operationId: string, commonDir: string, challenge: P0ReviewChallenge): P0ReviewDiagnostic {
  const packet = readDiagnosticPacket(commonDir, challenge.diagnosticRef)
  if ((packet.version === 'p0-review-diagnostic-v2') !== (challenge.version === 'p0-review-challenge-v2')
    || packet.operationId !== operationId || packet.requestId !== challenge.requestId
    || packet.expectedRevision !== challenge.expectedRevision || packet.inputId !== challenge.inputId || packet.partitionId !== challenge.partitionId
    || packet.analysisRef.sha256 !== challenge.analysisRef.sha256) {
    throw new SyncApplicationError('sync_p0_challenge_binding', '复审诊断与原授权绑定不一致')
  }
  return { ref: challenge.diagnosticRef, text: packet.diagnostic, ...(packet.version === 'p0-review-diagnostic-v2' ? { evidencePaths: packet.evidencePaths } : {}) }
}
