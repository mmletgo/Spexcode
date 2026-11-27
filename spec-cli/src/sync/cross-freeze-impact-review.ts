import { Ajv } from 'ajv'
import { isDeepStrictEqual } from 'node:util'
import type { CrossFreezeSource } from './cross-freeze-source.js'
import type { ElaborationSessionRequest, ElaborationSessionResult, ElaborationTrace } from './elaboration-types.js'
import { syncModel } from './model-selection.js'
import type { BlobRef, InputSnapshot, NativeSessionRef, SyncOperation } from './operation-types.js'
import { contentHash, objectGit, readEvidence, readTree } from './snapshot.js'
import { overlayStageTree, STAGE_READING_INSTRUCTIONS, stageWorktree, verifyStageResult, type StageWorktree } from './stage-worktree.js'

const version = 'cross-freeze-impact-review-v1' as const
export const CROSS_FREEZE_IMPACT_PURPOSE = 'cross_freeze_impact_review'

export type CrossFreezeImpactPrior = {
  attemptId: string
  candidateDigest: string
  resultRef: BlobRef
  approvalRef?: BlobRef
  author: NativeSessionRef
  reviewer?: NativeSessionRef
}

type ImpactReviewInput = Pick<ElaborationSessionRequest, 'timeoutMs' | 'signal'> & {
  operation: Pick<SyncOperation, 'id' | 'input' | 'policyDigest' | 'model'>
  attemptId: string
  source: CrossFreezeSource
  prior: CrossFreezeImpactPrior
  owner: string
  stage: 'p0' | 'p1'
  seed: StageWorktree
  readPaths?: readonly string[]
}

type ReviewBinding = {
  version: typeof version
  current: { operationId: string; attemptId: string; inputId: string; policyDigest: string }
  prior: CrossFreezeImpactPrior & { operationId: string; inputId: string }
  owner: string
  stage: ImpactReviewInput['stage']
  provenanceDigest: string
  seed: StageWorktree
  readPaths: string[]
}

type Verdict = 'reuse' | 'affected'
export type CrossFreezeImpactOutput = {
  inputDigest: string
  verdict: Verdict
  history: { previousCommit: string; currentCommit: string; evidence: string; reason: string }
  paths: { path: string; verdict: Verdict; evidence: string; reason: string }[]
}

export type CrossFreezeImpactReview = {
  request: ElaborationSessionRequest & { worktree: StageWorktree }
  binding: ReviewBinding
  changedPaths: readonly string[]
  commonDir: string
}

export type CrossFreezeImpactEvidence = {
  version: typeof version
  binding: ReviewBinding
  requestKey: string
  trace: ElaborationTrace
  verdict: Verdict
  output: CrossFreezeImpactOutput
}

const hash = (value: unknown): string => contentHash(JSON.stringify(value))
const sha256 = /^[a-f0-9]{64}$/u
const gitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const freeze = (input: InputSnapshot) => ({ inputId: input.id, commit: input.headCommit, tree: input.immutableTree })
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const exactString = (value: string) => ({ type: 'string', enum: [value] })

function readReviewMaterial(commonDir: string, ref: BlobRef): string {
  const bytes = readEvidence(commonDir, ref), source = bytes.toString('utf8')
  if (!bytes.equals(Buffer.from(source, 'utf8'))) throw new Error('影响复核的原候选或批准不是 UTF-8')
  return source
}

function impactSchema(inputDigest: string, previousCommit: string, currentCommit: string, pathCount: number): Record<string, unknown> {
  const verdict = { type: 'string', enum: ['reuse', 'affected'] }
  const text = { type: 'string', pattern: '\\S', maxLength: 4096 }
  return object({
    inputDigest: exactString(inputDigest), verdict,
    history: object({ previousCommit: exactString(previousCommit), currentCommit: exactString(currentCommit), evidence: text, reason: text }),
    paths: { type: 'array', minItems: pathCount, maxItems: pathCount, items: object({ path: { type: 'string', minLength: 1 }, verdict, evidence: text, reason: text }) },
  })
}

function assertCurrentSeed(commonDir: string, seed: StageWorktree, headCommit: string): void {
  if (!gitOid.test(seed.baseCommit) || !gitOid.test(seed.tree)
    || objectGit(commonDir, ['rev-parse', '--verify', `${seed.baseCommit}^{tree}`]).toString().trim() !== seed.tree
    || seed.baseCommit !== headCommit && objectGit(commonDir, ['rev-parse', `${seed.baseCommit}^@`]).toString().trim() !== headCommit)
    throw new Error('影响复核的阶段 seed 未绑定当前冻结提交和实际树')
}

/** 以已认证的旧候选和完整差量冻结当前 owner 的只读 Native 请求。 */
export function prepareCrossFreezeImpactReview(input: ImpactReviewInput): CrossFreezeImpactReview {
  const { operation, attemptId, source, prior, owner, stage, seed, timeoutMs, signal } = input
  const { commonDir, canonicalRoot } = operation.input.source
  const { operation: oldOperation, provenance } = source, { digest, patch, ...delta } = provenance
  if (oldOperation.id === operation.id || oldOperation.policyDigest !== operation.policyDigest
    || !source.attempts.some(attempt => attempt.id === prior.attemptId && attempt.operationId === oldOperation.id)
    || !isDeepStrictEqual(provenance.previous, freeze(oldOperation.input)) || !isDeepStrictEqual(provenance.current, freeze(operation.input))
    || !isDeepStrictEqual(provenance.source, operation.input.source) || hash({ ...delta, patch }) !== digest
    || !owner || !attemptId || !sha256.test(prior.candidateDigest) || !prior.author.sessionId
    || prior.approvalRef && !prior.reviewer?.sessionId || prior.reviewer && !prior.reviewer.sessionId)
    throw new Error('影响复核缺少精确的双冻结来源、原候选或原审查身份')

  assertCurrentSeed(commonDir, seed, operation.input.headCommit)
  const binding: ReviewBinding = {
    version,
    current: { operationId: operation.id, attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest },
    prior: { ...prior, operationId: oldOperation.id, inputId: oldOperation.input.id },
    owner, stage, provenanceDigest: digest, seed, readPaths: [...new Set(input.readPaths ?? [])].sort(),
  }
  const folder = `.spex-sync-drafts/cross-freeze-impact-${hash(binding)}`
  if (readTree(commonDir, seed.tree).some(({ path }) => {
    const lower = path.toLowerCase()
    return lower === folder || lower.startsWith(`${folder}/`) || folder.startsWith(`${lower}/`)
  })) throw new Error('影响复核证据目录与当前阶段 Git 树冲突')

  const approvalFile = prior.approvalRef?.sha256 === prior.resultRef.sha256 ? 'candidate.json' : 'approval.json'
  const files = [
    { path: `${folder}/review.json`, source: JSON.stringify({ ...binding, ...delta, digest, candidateFile: 'candidate.json', approvalFile: prior.approvalRef ? approvalFile : null }, null, 2) },
    { path: `${folder}/changes.diff`, source: patch },
    { path: `${folder}/candidate.json`, source: readReviewMaterial(commonDir, prior.resultRef) },
    ...(prior.approvalRef && approvalFile === 'approval.json' ? [{ path: `${folder}/approval.json`, source: readReviewMaterial(commonDir, prior.approvalRef) }] : []),
  ]
  const worktree = stageWorktree(commonDir, seed.baseCommit, overlayStageTree(commonDir, seed.tree, files))
  const inputDigest = hash({ binding, worktree })
  const requestKey = `sync:${attemptId}:${CROSS_FREEZE_IMPACT_PURPOSE}:${stage}:${inputDigest}`
  const prompt = [
    '独立复核旧候选对当前冻结分区的适用性。', STAGE_READING_INSTRUCTIONS,
    `读取 ${folder}/review.json、同目录 changes.diff 和引用的原候选及原批准文件。`,
    '对照两个冻结的 Git 对象、旧候选和当前阶段可见的源码及规范。逐一核查完整 changes 中的路径，包括旧读集之外的调用、共享依赖、契约、配置和测试发现。删除与新增分别报告。',
    '每个 paths 条目写精确仓库路径、实际观察到的文件位置或符号及事实 evidence、对当前分区义务的理由 reason 和 verdict。即使无路径变化，history 也须给出实际检查的历史证据和适用理由。',
    '所有变化均已查明且旧候选仍适用时给 reuse；有变化影响本区或证据不足时给 affected，并写出具体影响。只读复核，常规阶段审批由当前操作决定。',
  ].join('\n')
  return {
    request: { root: canonicalRoot, base: worktree.baseCommit, worktree, requestKey, inputDigest, purpose: CROSS_FREEZE_IMPACT_PURPOSE, prompt,
      schema: impactSchema(inputDigest, provenance.previous.commit, provenance.current.commit, provenance.changes.length), timeoutMs, model: syncModel(operation), signal },
    binding, changedPaths: provenance.changes.map(change => change.path), commonDir,
  }
}

/** 认证已由调用者核实正式派发及资源的独立结论，并生成可保存的精确证据。 */
export function verifyCrossFreezeImpactReview(
  prepared: CrossFreezeImpactReview,
  result: ElaborationSessionResult,
  canonical: { request: ElaborationSessionRequest; result: ElaborationSessionResult },
): CrossFreezeImpactEvidence {
  const { request, binding, changedPaths } = prepared
  const { root, base, worktree, requestKey, inputDigest, purpose, prompt, schema, timeoutMs } = canonical.request
  if (!isDeepStrictEqual({ root, base, worktree, requestKey, inputDigest, purpose, prompt, schema, timeoutMs }, {
    root: request.root, base: request.base, worktree: request.worktree, requestKey: request.requestKey, inputDigest: request.inputDigest,
    purpose: request.purpose, prompt: request.prompt, schema: request.schema, timeoutMs: request.timeoutMs,
  }) || !isDeepStrictEqual(result, canonical.result) || !result.sessionId || !result.threadId || !result.turnId
    || [binding.prior.author, binding.prior.reviewer].some(prior => prior && (result.sessionId === prior.sessionId || result.threadId === prior.threadId || result.turnId === prior.turnId))
    || canonical.request.frozenContext || canonical.request.frozenEntries || result.frozenReadProof || result.resultDigest !== hash(result.output))
    throw new Error('影响复核未绑定本次独立 Native 派发或实际结果')

  const validate = new Ajv().compile<CrossFreezeImpactOutput>(schema), output = result.output
  if (!validate(output)) throw new Error('影响复核结果不符合冻结 schema')
  const reviewedPaths = new Set(output.paths.map(path => path.path))
  if (reviewedPaths.size !== changedPaths.length || changedPaths.some(path => !reviewedPaths.has(path))
    || output.verdict === 'reuse' && output.paths.some(path => path.verdict === 'affected'))
    throw new Error('影响复核未逐项覆盖精确 Git 差量或结论矛盾')

  verifyStageResult(prepared.commonDir, request.worktree, result)
  const trace: ElaborationTrace = { purpose, sessionId: result.sessionId, threadId: result.threadId, turnId: result.turnId, resultDigest: result.resultDigest, inputDigest }
  return { version, binding, requestKey, trace, verdict: output.verdict, output }
}
