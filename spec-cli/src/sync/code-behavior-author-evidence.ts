import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { ElaborationFact } from './elaboration-types.js'
import type { AcceptanceChangeProposal, CodeBehaviorChange } from './writeback-types.js'

export type AuthorEvidenceDraft = {
  changes: readonly Omit<CodeBehaviorChange, 'id'>[]
  facts: readonly ElaborationFact[]
  acceptanceChanges: readonly Pick<AcceptanceChangeProposal, 'reason'>[]
  newNodes: readonly { basis: string }[]
}
type EvidenceIssue = { message: string; locations: string[] }

function mandatoryReferences(plan: SyncCoordinatorPlan): string[] {
  return plan.mandatoryTests.map(({ verificationId, testPath, testId }) => `${verificationId}:${testPath}#${testId}`)
}

export function authorEvidenceInstructions(plan: SyncCoordinatorPlan): string {
  return `\n作者证据自检：正式必验取自以下冻结登记，逐项使用 [[mandatory:完整值]]，不在事实正文直接抄写 VERIFY ID 或列举它所含的定向测试。实际定向测试用独立 testPath#testId 描述，不能由外层测试名称推断覆盖。正式必验引用：${JSON.stringify(mandatoryReferences(plan))}。仅引用执行定义时可以使用 [[verification:登记ID]]，该引用不声明用例资格或覆盖。\n由同一冻结代码事实支撑多项时，在 facts 一次登记 code:实际路径#符号，通过 [[fact:完整source]] 引用。具体导入异常或首个失败位置是运行时主张，只能引用可信冻结事实中的已观测结论 [[fact:完整source]]，不可从导入语句存在或文件缺失推断运行顺序。没有冻结观测时，描述已经核实的代码引用、缺失对象和静态边界。程序校验事实引用，独审仍核证据是否支持业务结论。`
}

/** 对同一冻结登记和原稿输出可定位的证据问题，不推断业务含义或执行项目代码。 */
export function checkAuthorEvidence(draft: AuthorEvidenceDraft, plan: SyncCoordinatorPlan): EvidenceIssue[] {
  const issues = new Map<string, EvidenceIssue>()
  const report = (message: string, location: string) => {
    const issue = issues.get(message)
    if (issue) { if (!issue.locations.includes(location)) issue.locations.push(location) }
    else issues.set(message, { message, locations: [location] })
  }
  const mandatory = new Set(mandatoryReferences(plan))
  const verificationIds = new Set(plan.verifications.map(entry => entry.definition.id))
  const frozenFacts = new Map(plan.facts.map(({ source, text }) => [source, text]))
  const sources = new Set(frozenFacts.keys()), declared = new Set<string>()
  for (const [index, item] of draft.facts.entries()) {
    if (declared.has(item.source)) report(`事实来源须只登记一次：${item.source}`, `/facts/${index}/source`)
    declared.add(item.source)
    if (item.source.startsWith('code:')) sources.add(item.source)
  }
  const inspect = (text: string, location: string) => {
    const prose = text.replace(/\[\[(mandatory|verification|fact):([^\]\n]+)\]\]/g, (_match, kind: string, ref: string) => {
      const known = kind === 'mandatory' ? mandatory.has(ref) : kind === 'verification' ? verificationIds.has(ref) : sources.has(ref)
      if (!known) report(`冻结证据中没有此 ${kind} 引用：${ref}`, location)
      return ''
    })
    if (mandatory.size) for (const id of new Set(prose.match(/\bVERIFY-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g))) {
      report(`正式验证 ${id} 须使用精确登记引用；普通定向测试请单独引用实际路径及稳定 ID`, location)
    }
    if (/(?:\b(?:ImportError|ModuleNotFoundError)\b|(?:导入|import).{0,100}(?:首个失败|首先失败|先失败)|(?:首个失败|首先失败|先失败).{0,100}(?:导入|import))/i.test(prose)) {
      report('导入异常与首个失败位置须复用可信冻结观测；只有静态源码时请描述可核实的依赖和缺失对象', location)
    }
  }
  for (const [index, change] of draft.changes.entries()) {
    for (const key of ['previousBehavior', 'sourceBehavior', 'deliveryBehavior', 'evidence', 'counterexample'] as const) inspect(change[key], `/changes/${index}/${key}`)
  }
  for (const [index, fact] of draft.facts.entries()) if (frozenFacts.get(fact.source) !== fact.text) inspect(fact.text, `/facts/${index}/text`)
  for (const [index, node] of draft.newNodes.entries()) inspect(node.basis, `/newNodes/${index}/basis`)
  for (const [index, change] of draft.acceptanceChanges.entries()) inspect(change.reason, `/acceptanceChanges/${index}/reason`)
  return [...issues.values()]
}
