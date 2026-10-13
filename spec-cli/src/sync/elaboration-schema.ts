import { CONTRACT_COLUMNS } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'

const string = { type: 'string', minLength: 1 }
const strings = { type: 'array', items: string }
const object = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
export const ELABORATION_SCHEMA = object({
  inputDigest: string,
  changes: { type: 'array', minItems: 1, items: object({ nodeId: string, path: string, beforeDigest: { type: ['string', 'null'] }, source: string }) },
  applicability: { type: 'array', minItems: ELABORATION_BOUNDARIES.length, items: object({ boundary: { enum: ELABORATION_BOUNDARIES }, applies: { type: 'boolean' }, basis: string, affectedIds: strings }) },
})
export const ELABORATION_REVIEW_SCHEMA = object({
  inputDigest: string, candidateDigest: string,
  verdict: { enum: ['accept', 'repair', 'needs_input', 'conflict'] },
  checkedBoundaries: { type: 'array', items: { enum: ELABORATION_BOUNDARIES }, minItems: ELABORATION_BOUNDARIES.length },
  findings: { type: 'array', items: object({ code: string, kind: { enum: ['repair', 'missing_fact', 'conflict'] }, message: string, affectedIds: strings, evidence: string, decision: string }) },
})

/** 对模型输出这一外部边界重复执行严格 schema 检查，注入 runner 也不能绕过门禁。 */
export function outputErrors(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: 未满足枚举`]
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (types.length && !types.includes(actual)) return [`${path}: 类型应为 ${types.join('/')}`]
  if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) return [`${path}: 字符串不能为空`]
  if (Array.isArray(value)) {
    const errors = typeof schema.minItems === 'number' && value.length < schema.minItems ? [`${path}: 项数不足`] : []
    if (schema.items) value.forEach((item, index) => errors.push(...outputErrors(item, schema.items as Record<string, unknown>, `${path}[${index}]`)))
    return errors
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!properties) return []
    const errors = (schema.required as string[]).filter(key => !(key in record)).map(key => `${path}.${key}: 缺少字段`)
    for (const key of Object.keys(record)) {
      if (!(key in properties)) errors.push(`${path}.${key}: 未允许字段`)
      else errors.push(...outputErrors(record[key], properties[key], `${path}.${key}`))
    }
    return errors
  }
  return []
}

export const CONTRACT_INSTRUCTIONS = `输出唯一可编辑的规范 Markdown，每个文件 YAML frontmatter 含 contract-schema: sync-v1，## raw source 原样保留用户原文，## expanded spec 包含适用的 ### 固定标题及表格。
直接使用以下精确表头与分隔模板，分隔行列数必须与表头一致；三级标题之后只允许空行再紧接表头，不插说明段落。说明写在固定标题前。表格单元格保持简洁，避免同义政策复制。
${Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => `### ${kind}\n\n| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |`).join('\n\n')}
所有出现表包含完整表头和非空数据行；空值用 -，布尔 true/false，引用集合逗号分隔。ID为类型-业务域-稳定后缀（ASCII大写/数字/连字符）。source必须是唯一单值，不能逗号拼多个来源；例如derived:REQ-EXPORT-01有效，user:REQ-EXPORT-01,decision:EXPORT-POLICY无效。REQ来源user:raw；其他单值来源user:REQ-ID、decision:裁决ID、rule:RULE-ID、derived:稳定ID、code:相对路径#符号。多个推导依赖只放depends-on引用列表。必须真实depends-on追到原意；每项业务政策有可核实来源。缺代码/测试属于待实现证据，不是业务事实GAP；不要为已有明确政策伪造缺失事实。
FLOW.req引用REQ，FLOW.steps引用STEP；STEP.flow是单FLOW，STEP.next为STEP/TR/STATE引用列表或END单值，END不能和ID混写。有状态对象的FLOW.terminal列对应STATE结果；只有整个能力完全无状态时才用END，同步调用不等于无状态。无状态必须正文说明输入域、不变量、不适用依据和可观察结束。
STATE/EVENT/TR.object为稳定对象名。每个适用对象全部可达状态×事件必须有TR，disposition为transition/reject/idempotent/not_applicable；reject/idempotent.to等于from；not_applicable.to为-且reason必填。condition成立、不成立、边界、失败/恢复、取消、重试、重复回调、竞争的必要到达顺序、副作用均覆盖。不能用“其他忽略”缩减范围。
主动从场景发现响应丢失后的重复请求、异步任务失联、失败后恢复、取消与完成的两种顺序、回调身份过期、操作时权限变化及外部结果不可用；不能把“用户没写”当作这些相关边界不适用的依据。未知是否允许取消/重试及失联恢复政策须保留具体GAP和受阻分支，不能通过删去事件或宣布不适用让覆盖变绿。
RULE.authority为唯一权威nodeId；其他节点引用RULE，不复制政策。AC.covers引用REQ/RULE/TR，AC.test是测试相对路径#稳定用例ID，AC.command引用VERIFY-ID；VERIFY.command是JSON argv数组文本，cwd相对根，timeout-ms正整数。叶节点code最多一个真实代码文件，related不计实现覆盖。不存在的代码/测试只作为待实现绑定，绝不声称运行已过。
未知重大业务政策必须写GAP，kind为missing_fact/conflict，unknown/affects/evidence/decision具体明确；只阻塞依赖项，独立分支继续完善。不可发明权限、保留时间、超时或竞争政策。未获冻结authorizedChanges提供具体用户原意或可信裁决的依据时，保留REQ/AC/VERIFY及验证政策；明确已决定的退役或验证政策变更可按依据执行，无需再批准，但独立审查须核对与raw/facts相符且未缩减未授权范围。retiredIds中的历史稳定ID不能复用。不能弱化验收断言或改写raw让结果变绿。无GAP省略表，不输出空表。`
