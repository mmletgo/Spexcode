import { isHostPrivatePath } from './candidate.js'
import type { BlobRef, P1ReviewChallenge } from './operation-types.js'
import { SyncApplicationError } from './settings.js'
import { contentHash, readEvidence, validateRepositoryPath } from './snapshot.js'

export type P1ReviewChallengeRequest = Pick<P1ReviewChallenge, 'requestId' | 'expectedRevision' | 'inputId' | 'partitionId' | 'candidateDigest' | 'resultRef'> & {
  operationId: string
  diagnostic: string
  evidencePaths: string[]
}

export type P1ReviewDiagnostic = { ref: BlobRef; text: string; evidencePaths: readonly string[] }

/** 同一授权标记进入新 Native 只读提示，冷验用它识别复审的真实请求。 */
export function p1ReviewDiagnosticMarker(ref: BlobRef): string {
  return `操作员复审诊断 SHA-256 ${ref.sha256}。`
}

const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** 只接收指定候选的身份和只读证据提示，原审查来源由服务冷验。 */
export function readP1ReviewChallengeRequest(value: unknown): P1ReviewChallengeRequest {
  const request = value as Partial<P1ReviewChallengeRequest> | null
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== 9
    || ![request.operationId, request.requestId, request.inputId, request.partitionId].every(item => typeof item === 'string' && item.trim() === item && item.length > 0)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 1
    || !isSha256(request.candidateDigest) || !request.resultRef || typeof request.resultRef !== 'object' || Array.isArray(request.resultRef)
    || Object.keys(request.resultRef).length !== 1 || !Object.hasOwn(request.resultRef, 'sha256') || !isSha256(request.resultRef.sha256)
    || typeof request.diagnostic !== 'string' || !request.diagnostic.trim() || Buffer.byteLength(request.diagnostic) > 65536
    || Buffer.from(request.diagnostic, 'utf8').toString('utf8') !== request.diagnostic) {
    throw new SyncApplicationError('sync_p1_challenge_invalid', '复审须提供原操作与分区身份、候选及局部结果 SHA、证据路径和至多 64 KiB 的非空 UTF-8 诊断', 400)
  }
  const { operationId, requestId, expectedRevision, inputId, partitionId, candidateDigest, resultRef, diagnostic, evidencePaths } = request as P1ReviewChallengeRequest
  const invalidPath = () => new SyncApplicationError('sync_p1_challenge_invalid', '证据须为非空的规范仓库文件路径', 400)
  if (!Array.isArray(evidencePaths) || !evidencePaths.length) throw invalidPath()
  const paths = evidencePaths.map((path: unknown) => {
    if (typeof path !== 'string' || isHostPrivatePath(path) || /^\.spex-sync-drafts(?:\/|$)/iu.test(path)) throw invalidPath()
    try { return validateRepositoryPath(path) } catch { throw invalidPath() }
  })
  return { operationId, requestId, expectedRevision, inputId, partitionId, candidateDigest, resultRef, diagnostic, evidencePaths: [...new Set(paths)].sort() }
}

export function p1ReviewDiagnosticEvidence(request: P1ReviewChallengeRequest) {
  const { operationId, requestId, expectedRevision, inputId, partitionId, candidateDigest, resultRef, diagnostic, evidencePaths } = request
  return { version: 'p1-review-diagnostic-v1' as const, operationId, requestId, expectedRevision, inputId, partitionId, candidateDigest, resultRef, diagnostic, evidencePaths }
}

export function p1ReviewDiagnosticRef(request: P1ReviewChallengeRequest): BlobRef {
  return { sha256: contentHash(JSON.stringify(p1ReviewDiagnosticEvidence(request))) }
}

export function authenticateP1ReviewDiagnostic(bytes: Buffer, operationId: string, challenge: P1ReviewChallenge): P1ReviewDiagnostic {
  const { version, ...body } = JSON.parse(bytes.toString('utf8')) as ReturnType<typeof p1ReviewDiagnosticEvidence>
  const request = readP1ReviewChallengeRequest(body)
  const packet = p1ReviewDiagnosticEvidence(request)
  if (challenge.version !== 'p1-review-challenge-v1' || version !== packet.version
    || !bytes.equals(Buffer.from(JSON.stringify(packet), 'utf8')) || contentHash(bytes) !== challenge.diagnosticRef.sha256
    || packet.operationId !== operationId || packet.requestId !== challenge.requestId
    || packet.expectedRevision !== challenge.expectedRevision || packet.inputId !== challenge.inputId || packet.partitionId !== challenge.partitionId
    || packet.candidateDigest !== challenge.candidateDigest || packet.resultRef.sha256 !== challenge.resultRef.sha256) {
    throw new SyncApplicationError('sync_p1_challenge_binding', '复审诊断与原授权或规范字节不一致')
  }
  return { ref: challenge.diagnosticRef, text: packet.diagnostic, evidencePaths: packet.evidencePaths }
}

/** 独审只从正式授权绑定的原始 CAS 字节读取诊断和证据路径。 */
export function readP1ReviewDiagnostic(commonDir: string, challenge: P1ReviewChallenge, operationId = challenge.origin.operationId): P1ReviewDiagnostic {
  return authenticateP1ReviewDiagnostic(readEvidence(commonDir, challenge.diagnosticRef), operationId, challenge)
}
