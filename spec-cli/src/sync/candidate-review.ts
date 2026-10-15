import { Ajv } from 'ajv'
import type { ElaborationRunner, ElaborationSessionRequest, ElaborationTrace } from './elaboration-types.js'
import type { GenerationReview } from './generation-types.js'
import { contentHash } from './snapshot.js'

const string = { type: 'string', minLength: 1 }
const strings = { type: 'array', items: string }
const object = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
export const GENERATION_REVIEW_SCHEMA = object({
  inputId: string,
  candidateDigest: string,
  verdict: { type: 'string', enum: ['accept', 'repair', 'needs_input', 'conflict'] },
  checkedIds: strings,
  findings: { type: 'array', items: object({ kind: { type: 'string', enum: ['repair', 'missing_fact', 'conflict'] }, affectedIds: { ...strings, minItems: 1 }, ruleLocation: string, codeLocation: string, evidence: string, counterexample: string, message: string }) },
})
const validateReview = new Ajv({ allErrors: true, strict: true }).compile(GENERATION_REVIEW_SCHEMA)

export type CandidateReviewBinding = {
  inputId: string
  candidateDigest: string
  requiredIds: readonly string[]
  actualIds: readonly string[]
  priorIds: readonly string[]
}

/** 生成和跨机器检查共用同一结构与完成语义；调用者继续核验专用业务标记。 */
export function candidateReviewError(output: unknown, binding: CandidateReviewBinding): string | null {
  if (!validateReview(output)) return `评审 schema 不合法: ${JSON.stringify(validateReview.errors)}`
  const review = output as GenerationReview
  if (review.inputId !== binding.inputId || review.candidateDigest !== binding.candidateDigest) return '独立评审 inputId/candidateDigest 与实际候选不匹配'
  if (new Set(review.checkedIds).size !== review.checkedIds.length || review.findings.some(finding => new Set(finding.affectedIds).size !== finding.affectedIds.length)) return '独立评审 checkedIds/affectedIds 不能重复'
  const actual = new Set(binding.actualIds), prior = new Set(binding.priorIds)
  if (review.checkedIds.some(id => !actual.has(id)) || binding.requiredIds.some(id => !review.checkedIds.includes(id))) return '独立评审 checkedIds 含不存在候选项或未覆盖全部预定 readyIds'
  if (review.findings.some(finding => finding.affectedIds.some(id => !actual.has(id) && !prior.has(id)))) return '独立评审发现引用不存在的业务项'
  if (review.verdict === 'accept' && review.findings.length) return 'accept 不能包含未解决发现'
  const kind = { repair: 'repair', needs_input: 'missing_fact', conflict: 'conflict' } as const
  const expectedKind = review.verdict === 'accept' ? null : kind[review.verdict]
  if (expectedKind && !review.findings.some(finding => finding.kind === expectedKind)) return '拒绝结论必须有对应类型、位置、证据和反例的发现'
  return null
}

/** 只读独立审查经既有 runner 派发，绑定完整输入和真实 native 身份。 */
export async function runCandidateReview(request: ElaborationSessionRequest, runner: ElaborationRunner, binding: CandidateReviewBinding): Promise<{ review: GenerationReview; trace: ElaborationTrace }> {
  const native = await runner(request), output: unknown = structuredClone(native.output)
  if (!native.sessionId || !native.threadId || !native.turnId || native.resultDigest !== contentHash(JSON.stringify(output))) throw new Error('native 身份或输出摘要不匹配')
  const error = candidateReviewError(output, binding)
  if (error) throw new Error(error)
  return { review: output as GenerationReview, trace: { purpose: request.purpose, sessionId: native.sessionId, threadId: native.threadId, turnId: native.turnId, resultDigest: native.resultDigest, inputDigest: request.inputDigest } }
}

export const CANDIDATE_REVIEW_INSTRUCTIONS = '你是独立实现语义审查者。重新从冻结原始 raw、可信事实、已细化契约、elaboratedSpecs 的待交付详细正文与既有验收重走主流程/状态、失败/边界/取消/重试/重复与必要竞争顺序。检查下面影响闭包内实际候选的完整 Spec、源码和真实测试断言，以及全部新增/修改文件；测试数、builder 总结、Agent 完成声明都不是证据。代码或测试TypeError、错误断言、顺序/状态实现缺陷属于普通repair；contract:<仓库Spec路径>#<既有ID>仅为规则引用，不触发细化，修实现/测试并保已批准业务正文。只有已有原意明确支持的业务边界确实在已接受Spec中遗漏时，返回repair且ruleLocation严格为contract-omission:<仓库Spec路径>#<关联既有ID>，affectedIds必须包含该ID；协调器回细化保留原完整义务后补齐。不得用该专用标记处理实现/测试错误，重大政策未知仍missing_fact，不得把自身错误当新需求。mandatoryTests及verifications是冻结的外部不可改oracle与固定命令，不是managed业务测试；managed AC/test按已批准授权正常演化。若当前adopt/new_rule已批准规则与具体旧oracle断言互斥，且任何符合新规则的实现都会失败，则needs_input/missing_fact，ruleLocation严格为oracle-policy:decision:<当前stableDecisionId>，codeLocation严格为<mandatory testPath>#<testId>，affectedIds列所选真实变更RULE/TR与对应AC，evidence/counterexample逐项引用旧完整断言、新已批准规则及同一矛盾输入，要求可信owner更新oracle版本；不能改回旧意图、改oracle或跳过命令。普通代码缺陷、未选/未改规则及任意V3 nonzero不能冒充oracle政策互斥，仍repair。发现缺少必要依赖上下文时返回repair说明缺失文件，不能猜测依赖行为或接受不完整闭包。独立核对analysis三方字节对应的合法外部行为及resolutions没有被恢复成旧行为，refactor没有业务正文漂移；运行状态不得写入业务正文。核查遗漏分支、权限/副作用/次序变化、raw/REQ/AC/VERIFY弱化、空测试/假断言/跳过/自免检。checkedIds 独立列实际检查的候选项并覆盖全部预定 readyIds，不能列不存在项；未知事实和冲突保留具体位置、影响ID、实际证据与可观察反例。accept 必须无发现；发现均阻断。只返回绑定 inputId/candidateDigest 的 schema JSON，不修改文件或执行候选。'
