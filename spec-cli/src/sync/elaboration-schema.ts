import { CONTRACT_COLUMNS } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'

const string = { type: 'string', minLength: 1 }
const strings = { type: 'array', items: string }
const object = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const businessId = { type: 'string', pattern: '^(REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP)-[A-Z0-9]+(?:-[A-Z0-9]+)+$' }
const refs = { type: 'array', items: businessId }
const source = { type: 'string', pattern: '^(user:(raw|REQ-[A-Z0-9-]+)|decision:[^\\s,:|]+|rule:RULE-[A-Z0-9-]+|derived:(REQ|FLOW|STEP|STATE|EVENT|TR|RULE|AC|GAP)-[A-Z0-9-]+|code:[^\\s,#|]+#[^\\s,#|]+)$' }
const rowProperty = (kind: string, column: string): Record<string, unknown> => {
  if (column === 'id') return { type: 'string', pattern: `^${kind}-[A-Z0-9]+(?:-[A-Z0-9]+)+$` }
  if (column === 'source') return source
  if (['req', 'steps', 'rules', 'covers', 'depends-on', 'affects'].includes(column)) return refs
  if (column === 'initial' || kind === 'STATE' && column === 'terminal') return { type: 'boolean' }
  if (column === 'next' || kind === 'FLOW' && column === 'terminal') return { anyOf: [{ enum: ['END'] }, refs] }
  if (kind === 'VERIFY' && column === 'command') return { type: 'array', minItems: 1, items: { ...string, pattern: '^[^\\u0000\\r\\n]+$' } }
  if (kind === 'VERIFY' && column === 'timeout-ms') return { type: 'integer', minimum: 1 }
  if (kind === 'AC' && column === 'command') return { type: 'string', pattern: '^VERIFY-[A-Z0-9]+(?:-[A-Z0-9]+)+$' }
  if (kind === 'GAP' && column === 'kind') return { enum: ['missing_fact', 'conflict'] }
  if (column === 'disposition') return { enum: ['transition', 'reject', 'idempotent', 'not_applicable'] }
  if (column === 'to') return { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^STATE-[A-Z0-9]+(?:-[A-Z0-9]+)+$' }] }
  if (['from', 'event', 'flow'].includes(column)) return { type: 'string', pattern: `^${column === 'from' ? 'STATE' : column.toUpperCase()}-[A-Z0-9]+(?:-[A-Z0-9]+)+$` }
  return string
}
export const ELABORATION_SCHEMA = object({
  version: { enum: ['elaboration-rows-v1'] },
  changes: { type: 'array', minItems: 1, items: object({ nodeId: string, path: string, title: { ...string, pattern: '^[^\\r\\n]+$' }, description: { type: 'string' }, code: strings, related: strings, prose: { type: 'string' }, tables: object(Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => [kind, { type: 'array', items: object(Object.fromEntries(columns.map(column => [column, rowProperty(kind, column)]))) }]))) }) },
  applicability: { type: 'array', minItems: ELABORATION_BOUNDARIES.length, items: object({ boundary: { enum: ELABORATION_BOUNDARIES }, applies: { type: 'boolean' }, basis: string, affectedIds: strings }) },
})
export const VERIFICATION_REGISTRATION_SCHEMA = object({ id: rowProperty('VERIFY', 'id'), command: rowProperty('VERIFY', 'command'), cwd: rowProperty('VERIFY', 'cwd'), timeoutMs: rowProperty('VERIFY', 'timeout-ms') })
export const ELABORATION_REVIEW_SCHEMA = object({
  verdict: { enum: ['accept', 'repair', 'needs_input', 'conflict'] },
  checkedBoundaries: { type: 'array', items: { enum: ELABORATION_BOUNDARIES }, minItems: ELABORATION_BOUNDARIES.length },
  findings: { type: 'array', items: object({ code: string, kind: { enum: ['repair', 'missing_fact', 'conflict'] }, message: string, affectedIds: strings, evidence: string, decision: string }) },
})

/** 对模型输出这一外部边界重复执行严格 schema 检查，注入 runner 也不能绕过门禁。 */
export function outputErrors(value: unknown, schema: Record<string, unknown>, path = '$'): string[] {
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some(branch => outputErrors(value, branch, path).length === 0) ? [] : [`${path}: 不符合任何允许的业务行结构`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path}: 未满足枚举`]
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (types.length && !types.includes(actual) && !(types.includes('integer') && typeof value === 'number' && Number.isInteger(value))) return [`${path}: 类型应为 ${types.join('/')}`]
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) return [`${path}: 数值小于最小值`]
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return [`${path}: 格式不符合契约`]
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

export const CONTRACT_INSTRUCTIONS = `最终唯一可编辑契约是规范 Markdown，由程序从业务行确定性渲染；程序复制原始raw、contract-schema: sync-v1、固定标题及表格，不让模型拼语法。业务行字段由schema定义；单元格简洁，避免同义政策复制。独立审查检查最终Markdown及业务语义。
冻结输入中的 verifications 是可信执行器的独立技术登记，不属于业务facts，不是用户未知，也不授予改变已有业务契约的权限。提供时，VERIFY.id/command/cwd/timeout-ms 必须精确符合登记，AC.command 只引用已登记VERIFY；不得自行造占位ID、换命令或放宽预算。执行器启动这些命令并汇总真实结果；generated业务测试只实现业务断言，不自行启动runner/oracle或递归运行登记命令。不要为这些已明确编排职责新增业务REQ/RULE/AC，或将它们误写为业务GAP。真正业务GAP仍按raw/facts保留；没有verifications时细化不代表命令已登记、已执行或具备交付权。
raw、冻结事实和权威业务规则优先。仅影响权限、资金或业务权益、数据范围、保留删除义务、不可逆副作用、竞争胜负、重复执行语义或业务承诺的重要未知事实，以及实际意图冲突才形成GAP。可观察本身不等于重大业务政策。既有无冲突错误名称/错误协议、普通字段表示/参数类型/序列化及等价校验顺序等实现细节可自动沿用，使用code来源并追到REQ；不冒充decision授权，不制造GAP或再次要求用户裁决。没有明确矛盾，不扩展管理员、防枚举等政策。参数类型或校验若违反明确raw/facts，必须保留要求并修实现，不能新增GAP掩盖冲突。不得仅凭代码授权上述重大业务政策。
生成与审查均须核实每条评审发现是否获raw、facts或相应代码来源支持；误读实现细节、错把技术选择当业务政策的发现必须纠正，不能照单全收并扩大GAP。只修已核实缺口及直接依赖，逐条保留未受影响且符合raw/facts的既有AC细分断言，包括已有测试支持的断言；不因重写表格把断言挪成前置条件、缩成部分效果或删除。来源混合时拆分业务规则与实现细节或建立相应依赖，不能因仅能填写一个source而要求用户重复授权普通技术约定。
所有出现表包含完整表头和非空数据行；空值用 -，布尔 true/false，引用集合逗号分隔。ID为类型-业务域-稳定后缀（ASCII大写/数字/连字符）。source必须是唯一单值，不能逗号拼多个来源；例如derived:REQ-EXPORT-01有效，user:REQ-EXPORT-01,decision:EXPORT-POLICY无效。REQ来源user:raw；其他单值来源user:REQ-ID、decision:裁决ID、rule:RULE-ID、derived:稳定ID、code:相对路径#符号。多个推导依赖只放depends-on引用列表。必须真实depends-on追到原意；每项业务政策有可核实来源。缺代码/测试属于待实现证据，不是业务事实GAP；不要为已有明确政策伪造缺失事实。
FLOW.req引用REQ，FLOW.steps引用STEP；STEP.flow是单FLOW，STEP.next为STEP/TR/STATE引用列表或END单值，END不能和ID混写。有状态对象的FLOW.terminal列对应STATE结果；只有整个能力完全无状态时才用END，同步调用不等于无状态。无状态必须正文说明输入域、不变量、不适用依据和可观察结束。
状态派发STEP必须以next、depends-on或source显式引用实际执行或选择的TR，并在depends-on或source声明对应EVENT。TR集合须忠实覆盖该步骤input/action/output声明的对象、状态域和条件分支；不能只列已确定TR掩盖同一步里的未决TR，也不反推与步骤无关的全事件所有状态。纯参数校验、提交和导航步骤不强求TR。next→TR是业务依赖；next→STEP/STATE、FLOW.steps仍仅导航，不扩大GAP闭包。独立审查必须重走派发步骤，对照TR集合核实声明范围与受阻处置的真实依赖；正文提到GAP或对应TR不能替代结构引用，不能把含未知派发的父FLOW列为完整可交付。
STATE/EVENT/TR.object为稳定对象名。每个适用对象全部可达状态×事件必须有TR，disposition为transition/reject/idempotent/not_applicable；reject/idempotent.to等于from；not_applicable.to为-且reason必填。condition成立、不成立、边界、失败/恢复、取消、重试、重复回调、竞争的必要到达顺序、副作用均覆盖。不能用“其他忽略”缩减范围。
主动从场景发现响应丢失后的重复请求、异步任务失联、失败后恢复、取消与完成的两种顺序、回调身份过期、操作时权限变化及外部结果不可用；不能把“用户没写”当作这些相关边界不适用的依据。未知是否允许取消/重试及失联恢复政策须保留具体GAP和受阻分支，不能通过删去事件或宣布不适用让覆盖变绿。
RULE.authority为唯一权威nodeId；其他节点引用RULE，不复制政策。AC.covers引用REQ/RULE/TR，AC.test是测试相对路径#稳定用例ID，AC.command引用VERIFY-ID；VERIFY.command是JSON argv数组文本，cwd相对根，timeout-ms正整数。叶节点code最多一个真实代码文件，related不计实现覆盖。不存在的代码/测试只作为待实现绑定，绝不声称运行已过。
未知重大业务政策必须写GAP，kind为missing_fact/conflict，unknown/affects/evidence/decision具体明确；只阻塞依赖项，独立分支继续完善。不可发明权限、保留时间、超时或竞争政策。未获冻结authorizedChanges提供具体用户原意或可信裁决的依据时，保留REQ/AC/VERIFY及验证政策；明确已决定的退役或验证政策变更可按依据执行，无需再批准，但独立审查须核对与raw/facts相符且未缩减未授权范围。retiredIds中的历史稳定ID不能复用。不能弱化验收断言或改写raw让结果变绿。无GAP省略表，不输出空表。`
