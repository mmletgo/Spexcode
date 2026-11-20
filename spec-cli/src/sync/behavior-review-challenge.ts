import type { BlobRef, P0ReviewChallenge } from './operation-types.js'
import { SyncApplicationError } from './settings.js'
import { contentHash, readEvidence } from './snapshot.js'

export type P0ReviewChallengeRequest = Pick<P0ReviewChallenge, 'requestId' | 'expectedRevision' | 'inputId' | 'partitionId' | 'analysisRef'> & {
  operationId: string
  diagnostic: string
}

export type P0ReviewDiagnostic = { ref: BlobRef; text: string }

/** 只接收定位原批准的身份和待核诊断，批准及来源证据由后端取得。 */
export function readP0ReviewChallengeRequest(value: unknown): P0ReviewChallengeRequest {
  const request = value as Partial<P0ReviewChallengeRequest> | null
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== 7
    || ![request.operationId, request.requestId, request.inputId, request.partitionId].every(item => typeof item === 'string' && item.trim() === item && item.length > 0)
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 1
    || !request.analysisRef || typeof request.analysisRef !== 'object' || Object.keys(request.analysisRef).length !== 1
    || typeof request.analysisRef.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.analysisRef.sha256)
    || typeof request.diagnostic !== 'string' || !request.diagnostic.trim() || Buffer.byteLength(request.diagnostic) > 65536
    || Buffer.from(request.diagnostic, 'utf8').toString('utf8') !== request.diagnostic) {
    throw new SyncApplicationError('sync_p0_challenge_invalid', '复审须提供原 operation、requestId、expectedRevision、inputId、partitionId、局部分析 SHA 和至多 64 KiB 的非空 UTF-8 诊断', 400)
  }
  const { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic } = request as P0ReviewChallengeRequest
  return { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic }
}

export function p0ReviewDiagnosticEvidence(request: P0ReviewChallengeRequest) {
  const { operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic } = request
  return { version: 'p0-review-diagnostic-v1' as const, operationId, requestId, expectedRevision, inputId, partitionId, analysisRef, diagnostic }
}

export function p0ReviewDiagnosticRef(request: P0ReviewChallengeRequest): BlobRef {
  return { sha256: contentHash(JSON.stringify(p0ReviewDiagnosticEvidence(request))) }
}

/** 独审读取实际保存的同授权诊断，原业务分析输入不消费这份资料。 */
export function readP0ReviewDiagnostic(operationId: string, commonDir: string, challenge: P0ReviewChallenge): P0ReviewDiagnostic {
  const { version, ...body } = JSON.parse(readEvidence(commonDir, challenge.diagnosticRef).toString('utf8')) as ReturnType<typeof p0ReviewDiagnosticEvidence>
  const request = readP0ReviewChallengeRequest(body)
  if (version !== 'p0-review-diagnostic-v1' || request.operationId !== operationId || request.requestId !== challenge.requestId
    || request.expectedRevision !== challenge.expectedRevision || request.inputId !== challenge.inputId || request.partitionId !== challenge.partitionId
    || request.analysisRef.sha256 !== challenge.analysisRef.sha256 || p0ReviewDiagnosticRef(request).sha256 !== challenge.diagnosticRef.sha256) {
    throw new SyncApplicationError('sync_p0_challenge_binding', '复审诊断与原授权绑定不一致')
  }
  return { ref: challenge.diagnosticRef, text: request.diagnostic }
}
