import { parse } from '@babel/parser'
import { contractReferences } from './graph.js'
import { projectContractCoverage } from './coverage.js'
import { isRepositoryPath } from './parser.js'
import type { ContractFinding, ContractGraph, ContractItem, ContractValidationContext, State, Transition } from './types.js'

// This is a declaration check, not proof that a test ran or that its assertion enforces the rule.
// The parser owns JS/TS/JSX syntax; only the closed literal subset below has a static value.
type Syntax = { type: string; start: number; [field: string]: any }
type Scope = { parent?: Scope; function: boolean; bindings: Map<string, Binding> }
type Binding = { start: number; init?: Syntax; test?: boolean }
type StaticValue = string | number | boolean | null | StaticValue[] | Map<string, StaticValue>
const unknownValue = Symbol('unknown test title')
type Value = StaticValue | typeof unknownValue
const children = (node: Syntax): Syntax[] => Object.values(node).flatMap((value) =>
  (Array.isArray(value) ? value : [value]).filter((child): child is Syntax => child && typeof child.type === 'string'))

function testCaseTitles(source: string): string[] {
  let tree: Syntax | undefined
  for (const plugins of [['typescript', 'jsx'], ['typescript']] as const) {
    try { tree = parse(source, { sourceType: 'unambiguous', plugins: [...plugins] }) as unknown as Syntax; break }
    catch (error) { if (!(error instanceof SyntaxError)) throw error }
  }
  if (!tree) return []
  const scopes = new Map<Syntax, Scope>(), all: Syntax[] = []
  const lookup = (scope: Scope, name: string): Binding | undefined => scope.bindings.get(name) ?? (scope.parent && lookup(scope.parent, name))
  const bind = (pattern: Syntax, scope: Scope, data: Partial<Binding> = {}): void => {
    if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, { start: pattern.start, ...data })
    else if (pattern.type === 'RestElement') bind(pattern.argument, scope)
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, scope)
    else if (pattern.type === 'TSParameterProperty') bind(pattern.parameter, scope)
    else if (pattern.type === 'ArrayPattern') for (const entry of pattern.elements) { if (entry) bind(entry, scope) }
    else if (pattern.type === 'ObjectPattern') for (const entry of pattern.properties) bind(entry.type === 'RestElement' ? entry.argument : entry.value, scope)
  }
  const scan = (node: Syntax, outer?: Scope): void => {
    if (['FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSDeclareFunction', 'TSImportEqualsDeclaration'].includes(node.type)) {
      if (node.id) bind(node.id, outer!)
    }
    const fn = /^(?:Function|ArrowFunction|ObjectMethod|ClassMethod|ClassPrivateMethod)/.test(node.type)
    const scoped = fn || ['Program', 'BlockStatement', 'StaticBlock', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'CatchClause', 'ClassDeclaration', 'ClassExpression', 'TSModuleDeclaration', 'TSModuleBlock'].includes(node.type)
    const scope = scoped ? { parent: outer, function: fn || node.type === 'Program', bindings: new Map<string, Binding>() } : outer!
    scopes.set(node, scope); all.push(node)
    if (fn) {
      if (node.id) bind(node.id, scope)
      for (const param of node.params) bind(param, scope)
    }
    if (node.type === 'CatchClause' && node.param) bind(node.param, scope)
    if (node.type === 'ClassExpression' && node.id) bind(node.id, scope)
    if (node.type === 'VariableDeclaration') {
      let target = scope
      if (node.kind === 'var') while (!target.function) target = target.parent!
      for (const entry of node.declarations) bind(entry.id, target, node.kind === 'const' && entry.id.type === 'Identifier' ? { init: entry.init } : {})
    }
    if (node.type === 'ImportDeclaration') for (const entry of node.specifiers) {
      const api = ['node:test', 'vitest', '@jest/globals', 'bun:test'].includes(node.source.value)
      const test = api && node.importKind !== 'type' && entry.importKind !== 'type' &&
        (entry.type === 'ImportDefaultSpecifier' ? node.source.value === 'node:test' : ['test', 'it'].includes(entry.imported?.name ?? entry.imported?.value))
      bind(entry.local, scope, { test })
    }
    for (const child of children(node)) scan(child, scope)
  }
  const globals: Scope = { function: true, bindings: new Map() }
  for (const name of ['test', 'it']) globals.bindings.set(name, { start: 0, test: true })
  scan(tree, globals)
  const mutated = new Set<Binding>(), origins = new Map<Binding, Set<Binding>>()
  const rootBinding = (node: Syntax | undefined): Binding | undefined => {
    if (!node) return undefined
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return rootBinding(node.object)
    if (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) return rootBinding(node.expression)
    return node.type === 'Identifier' ? lookup(scopes.get(node)!, node.name) : undefined
  }
  const references = (node: Syntax | undefined): Binding[] => {
    if (!node) return []
    const root = rootBinding(node)
    if (root) return [root]
    // Calls and function bodies do not prove which references their result retains.
    if (['CallExpression', 'OptionalCallExpression', 'NewExpression', 'TaggedTemplateExpression', 'ImportExpression'].includes(node.type) || /^(?:Function|ArrowFunction|ObjectMethod|ClassMethod|ClassPrivateMethod)/.test(node.type)) return []
    if (node.type.startsWith('TS')) return node.expression ? references(node.expression) : []
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) return [...references(node.object), ...(node.computed ? references(node.property) : [])]
    if (node.type === 'ObjectProperty') return [...references(node.value), ...(node.computed ? references(node.key) : [])]
    return children(node).flatMap(references)
  }
  const writes = (node: Syntax | undefined): Binding[] => {
    if (!node) return []
    const root = rootBinding(node)
    if (root) return [root]
    if (node.type === 'ObjectProperty') return writes(node.value)
    if (node.type === 'AssignmentPattern') return writes(node.left)
    return ['ArrayPattern', 'ObjectPattern', 'RestElement'].includes(node.type) ? children(node).flatMap(writes) : []
  }
  const defaults = (node: Syntax): Binding[] => node.type === 'AssignmentPattern'
    ? [...references(node.right), ...defaults(node.left)] : children(node).flatMap(defaults)
  const alias = (target: Syntax, source: Syntax | undefined): void => {
    const sources = [...references(source), ...defaults(target)]
    for (const binding of writes(target)) {
      const previous = origins.get(binding) ?? new Set<Binding>()
      for (const source of sources) previous.add(source)
      origins.set(binding, previous)
    }
  }
  for (const node of all) {
    if (node.type === 'VariableDeclarator') alias(node.id, node.init)
    if (node.type === 'AssignmentExpression' && ['=', '&&=', '||=', '??='].includes(node.operator)) alias(node.left, node.right)
    if (node.type === 'ForOfStatement') alias(node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left, node.right)
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' || node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument
      : ['CallExpression', 'OptionalCallExpression'].includes(node.type) && ['MemberExpression', 'OptionalMemberExpression'].includes(node.callee.type) ? node.callee.object
        : ['ForOfStatement', 'ForInStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration' ? node.left : undefined
    for (const binding of writes(target)) {
      const testModifier = ['CallExpression', 'OptionalCallExpression'].includes(node.type) && binding.test && ['only', 'skip', 'todo'].includes(node.callee.property?.name)
      if (!testModifier) mutated.add(binding)
    }
  }
  const invalidate = (binding: Binding): void => {
    for (const origin of origins.get(binding) ?? []) if (!mutated.has(origin)) { mutated.add(origin); invalidate(origin) }
  }
  for (const binding of mutated) invalidate(binding)
  const value = (node: Syntax | undefined, overrides: Map<Binding, Value>, at: number, resolving = new Set<Binding>()): Value => {
    if (!node) return unknownValue
    const scope = scopes.get(node)!
    if (['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(node.type)) return node.value
    if (node.type === 'NullLiteral') return null
    if (['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(node.type)) return value(node.expression, overrides, at, resolving)
    if (node.type === 'Identifier') {
      const binding = lookup(scope, node.name)
      if (!binding || mutated.has(binding) || resolving.has(binding)) return unknownValue
      if (overrides.has(binding)) return overrides.get(binding)!
      if (!binding.init || binding.start > at) return unknownValue
      return value(binding.init, overrides, binding.start, new Set([...resolving, binding]))
    }
    if (node.type === 'ArrayExpression') {
      const entries = node.elements.map((entry: Syntax) => value(entry, overrides, at, resolving)) as Value[]
      return entries.includes(unknownValue) ? unknownValue : entries as StaticValue[]
    }
    if (node.type === 'ObjectExpression') {
      const entries = new Map<string, StaticValue>()
      for (const entry of node.properties) {
        if (entry.type !== 'ObjectProperty' || entry.method) return unknownValue
        const key = entry.computed ? value(entry.key, overrides, at, resolving) : entry.key.name ?? entry.key.value
        const field = value(entry.value, overrides, at, resolving)
        if (!['string', 'number'].includes(typeof key) || key === '__proto__' || field === unknownValue) return unknownValue
        entries.set(String(key), field)
      }
      return entries
    }
    if (node.type === 'MemberExpression') {
      const object = value(node.object, overrides, at, resolving)
      const key = node.computed ? value(node.property, overrides, at, resolving) : node.property.name
      if (typeof key !== 'string' && typeof key !== 'number') return unknownValue
      if (object instanceof Map && object.has(String(key))) return object.get(String(key))!
      if (Array.isArray(object) && /^(0|[1-9][0-9]*)$/.test(String(key)) && Object.hasOwn(object, key)) return object[Number(key)]
      return unknownValue
    }
    if (node.type === 'TemplateLiteral') {
      let title = node.quasis[0].value.cooked
      if (title === null) return unknownValue
      for (let i = 0; i < node.expressions.length; i++) {
        const part = value(node.expressions[i], overrides, at, resolving), tail = node.quasis[i + 1].value.cooked
        if (part === unknownValue || typeof part === 'object' && part !== null || tail === null) return unknownValue
        title += String(part) + tail
      }
      return title
    }
    return unknownValue
  }
  const titles = new Set<string>()
  const collect = (node: Syntax, overrides: Map<Binding, Value>): void => {
    if (node.type === 'WithStatement') return
    if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration' && node.left.kind === 'const' && node.left.declarations[0].id.type === 'Identifier') {
      const entries = value(node.right, overrides, node.start)
      if (Array.isArray(entries)) {
        const binding = lookup(scopes.get(node)!, node.left.declarations[0].id.name)!
        for (const entry of entries) collect(node.body, new Map([...overrides, [binding, entry]]))
        return
      }
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee.type === 'MemberExpression' && !node.callee.computed && ['only', 'skip', 'todo'].includes(node.callee.property.name) ? node.callee.object : node.callee
      if (callee.type === 'Identifier') {
        const binding = lookup(scopes.get(callee)!, callee.name)
        if (binding?.test && !mutated.has(binding)) {
          const title = value(node.arguments[0], overrides, node.start)
          if (typeof title === 'string') titles.add(title)
        }
      }
    }
    for (const child of children(node)) collect(child, overrides)
  }
  collect(tree, new Map())
  return [...titles]
}

export function validateContractGraph(graph: ContractGraph, context: ContractValidationContext = {}): ContractFinding[] {
  const findings = [...graph.findings]
  const titlesByFile = new Map<string, string[]>()
  const final = context.mode !== 'draft'
  const report = (code: string, message: string, item: ContractItem | undefined, relatedIds?: string[], severity: 'error' | 'warning' = 'error'): void => {
    const owner = item ? graph.owners.get(item.id) : graph.contracts[0]
    if (owner) findings.push({ code, message, severity, nodeId: owner.nodeId, path: owner.path, line: item?.line, itemId: item?.id, relatedIds })
  }
  const byKind = <K extends ContractItem['kind']>(kind: K): Extract<ContractItem, { kind: K }>[] =>
    [...graph.items.values()].filter((item): item is Extract<ContractItem, { kind: K }> => item.kind === kind)
  const reqs = byKind('REQ'), rules = byKind('RULE'), acs = byKind('AC'), flows = byKind('FLOW'), steps = byKind('STEP')
  const states = byKind('STATE'), events = byKind('EVENT'), transitions = byKind('TR')
  for (const item of graph.items.values()) {
    for (const ref of contractReferences(item)) {
      const target = graph.items.get(ref.id)
      if (!target) report('dangling-reference', `${item.id}.${ref.field} 引用不存在的 ${ref.id}`, item, [ref.id])
      else if (!ref.kinds.includes(target.kind)) report('reference-kind', `${item.id}.${ref.field} 需要 ${ref.kinds.join('/')}，实际为 ${target.kind}`, item, [ref.id])
    }
    if (item.kind === 'RULE' && item.authority !== item.nodeId) report('rule-authority', `${item.id} 权威定义必须归属当前节点 ${item.nodeId}`, item)
    if (item.kind !== 'VERIFY' && item.source.kind === 'user' && item.source.ref === 'raw' && !graph.owners.get(item.id)?.rawSource) report('missing-raw-source', `${item.id} 的 user:raw 缺少原始需求`, item)
    if (item.kind !== 'VERIFY' && item.source.kind === 'code' && context.files && !context.files.has(item.source.ref.split('#')[0])) report('missing-source-file', `${item.id} 的代码来源文件不存在`, item)
    if (item.kind === 'FLOW') for (const id of item.steps) {
      const step = graph.items.get(id)
      if (step?.kind === 'STEP' && step.flow !== item.id) report('step-ownership', `${id} 不属于 ${item.id}`, item, [id])
    }
    if (item.kind === 'STEP') {
      const flow = graph.items.get(item.flow)
      if (flow?.kind === 'FLOW' && !flow.steps.includes(item.id)) report('step-ownership', `${item.id} 未列入所属 FLOW.steps`, item, [flow.id])
    }
    if (item.kind === 'TR') {
      for (const id of [item.from, item.event, item.to].filter((id): id is string => id !== null)) {
        const target = graph.items.get(id)
        if ((target?.kind === 'STATE' || target?.kind === 'EVENT') && target.object !== item.object) report('transition-object', `${item.id} 的状态和事件必须属于 ${item.object}`, item, [id])
      }
      if (item.disposition === 'transition' && !item.to) report('transition-target', `${item.id} 转移必须有目标状态`, item)
      if (['reject', 'idempotent'].includes(item.disposition) && item.to !== item.from) report('unchanged-target', `${item.id} 拒绝或幂等处置必须保持原状态`, item)
      if (item.disposition === 'not_applicable' && (item.to !== null || !item.reason)) report('not-applicable-reason', `${item.id} 不适用必须无目标且有原因`, item)
    }
  }
  // Only derivation/source dependencies are acyclic. Business transitions and navigation may loop.
  const visited = new Set<string>(), active = new Set<string>(), trail: string[] = [], cycles = new Set<string>()
  const visit = (id: string): void => {
    if (active.has(id)) {
      const cycle = trail.slice(trail.indexOf(id))
      const key = [...cycle].sort().join(',')
      if (!cycles.has(key)) { cycles.add(key); report('dependency-cycle', `推导来源/依赖存在循环：${cycle.join(' → ')} → ${id}`, graph.items.get(id), cycle) }
      return
    }
    if (visited.has(id)) return
    active.add(id); trail.push(id)
    for (const dep of graph.dependencies.get(id) ?? []) if (graph.items.has(dep)) visit(dep)
    trail.pop(); active.delete(id); visited.add(id)
  }
  for (const id of graph.items.keys()) visit(id)
  const nodes = context.nodeIds ?? new Set(graph.contracts.map((contract) => contract.nodeId))
  for (const rule of rules) if (!nodes.has(rule.authority)) report('missing-authority-node', `${rule.id} 的权威节点不存在`, rule)
  for (const contract of graph.contracts) {
    if (context.files) for (const entry of contract.code) if (!context.files.has(entry.split('#')[0])) {
      findings.push({ code: 'missing-governed-file', severity: 'error', nodeId: contract.nodeId, path: contract.path, message: `治理文件不存在：${entry.split('#')[0]}` })
    }
    if (final && contract.items.some((item) => item.kind === 'RULE' || item.kind === 'TR')) findings.push({ code: 'semantic-review-required', severity: 'warning', nodeId: contract.nodeId, path: contract.path,
      message: '结构只证明规则和适用处置已声明；输入域、不变量、失败、条件成立/不成立、边界、竞争与副作用须独立语义审查及运行测试' })
  }
  for (const ac of acs) {
    const hash = ac.test.lastIndexOf('#'), testPath = ac.test.slice(0, hash), caseId = ac.test.slice(hash + 1)
    const command = graph.items.get(ac.command)
    if (!isRepositoryPath(testPath) || !caseId) report('invalid-test-binding', `${ac.id} 测试绑定无效`, ac)
    if (!context.files) {
      report('bindings-unverified', `${ac.id} 测试及实现文件尚未提供；结构绑定不代表真实验收已验证`, ac, undefined, 'warning')
      continue
    }
    const source = context.files.get(testPath)
    if (source === undefined) report('missing-test-file', `${ac.id} 测试文件不存在：${testPath}`, ac)
    else {
      const titles = titlesByFile.get(testPath) ?? testCaseTitles(source)
      titlesByFile.set(testPath, titles)
      const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const id = new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?![A-Z0-9-])`)
      if (!titles.some((title) => id.test(title))) report('missing-test-case', `${ac.id} 测试标题未声明稳定用例 ${caseId}`, ac)
    }
    if (command?.kind === 'VERIFY') {
      const resolves = (arg: string): string => `${command.cwd === '.' ? '' : `${command.cwd}/`}${arg.replace(/^\.\//, '')}`
      if (!command.command.slice(1).some((arg) => resolves(arg) === testPath)) report('verification-selection-unverified', `${ac.id} 的 VERIFY 使用间接测试入口，是否执行绑定用例须由运行证据确认`, ac, [command.id], 'warning')
    }
  }
  if (!final) return findings
  if (!graph.contracts.length) return findings
  for (const step of steps) {
    const refs = contractReferences(step)
    const eventIds = new Set(refs.filter((ref) => ['depends-on', 'source'].includes(ref.field) && graph.items.get(ref.id)?.kind === 'EVENT').map((ref) => ref.id))
    const dispositions = refs.filter((ref) => ['next', 'depends-on', 'source'].includes(ref.field))
      .map((ref) => graph.items.get(ref.id)).filter((item): item is Transition => item?.kind === 'TR')
    for (const eventId of eventIds) if (!dispositions.some((tr) => tr.event === eventId)) {
      report('step-event-disposition-missing', `${step.id} 引用 ${eventId}，但未声明该事件的 TR 处置`, step, [eventId])
    }
  }
  for (const [kind, values] of [['REQ', reqs], ['RULE', rules], ['AC', acs], ['FLOW', flows], ['STEP', steps]] as const) {
    if (!values.length) report('incomplete-contract', `完成范围缺少 ${kind}；高层输入可以继续细化`, undefined)
  }
  const coverage = projectContractCoverage(graph)
  for (const req of reqs) if (!flows.some((flow) => flow.req.includes(req.id))) report('missing-requirement-flow', `${req.id} 缺少主流程`, req)
  for (const item of [...reqs, ...rules, ...transitions]) {
    const row = coverage.items.find((candidate) => candidate.id === item.id)!
    if (!row.acceptanceIds.length) report('missing-acceptance', `${item.id} 缺少可执行 AC 绑定`, item)
    if (!row.code.length) report('missing-implementation', `${item.id} 缺少 code 治理映射；related 不能计覆盖`, item)
  }
  for (const gap of coverage.gaps) report(gap.kind === 'conflict' ? 'unresolved-conflict' : 'unresolved-gap', `${gap.id} 阻塞依赖范围`, graph.items.get(gap.id), gap.affectedIds)
  for (const cell of coverage.matrix) if (cell.status === 'missing') report('missing-event-disposition', `${cell.stateId} × ${cell.eventId} 缺少明确处置`, graph.items.get(cell.stateId), [cell.eventId])
  const objects = new Set([...states.map((state) => state.object), ...events.map((event) => event.object), ...transitions.map((tr) => tr.object)])
  for (const object of objects) {
    const objectStates: State[] = states.filter((state) => state.object === object)
    const initial = objectStates.filter((state) => state.initial)
    const objectTransitions: Transition[] = transitions.filter((tr) => tr.object === object && tr.disposition === 'transition')
    if (!initial.length) report('missing-initial-state', `${object} 缺少初始状态`, objectStates[0] ?? events.find((event) => event.object === object))
    if (!events.some((event) => event.object === object)) report('missing-object-event', `${object} 缺少事件`, objectStates[0])
    const reachable = new Set(initial.map((state) => state.id))
    let changed = true
    while (changed) {
      changed = false
      for (const tr of objectTransitions) if (reachable.has(tr.from) && tr.to && !reachable.has(tr.to)) { reachable.add(tr.to); changed = true }
    }
    for (const state of objectStates) {
      if (!reachable.has(state.id)) report('unreachable-state', `${state.id} 不能从初始状态到达`, state)
      if (!state.terminal && !objectTransitions.some((tr) => tr.from === state.id && tr.to !== state.id)) report('nonterminal-no-exit', `${state.id} 非终态缺少出口`, state)
    }
  }
  for (const flow of flows) {
    if (!flow.steps.length) report('empty-flow', `${flow.id} 缺少步骤`, flow)
    if (flow.terminal === 'END') {
      const owner = graph.owners.get(flow.id)!
      if (!/(状态.{0,20}不适用|不适用.{0,20}状态|无状态|stateless|state.{0,20}not applicable)/i.test(owner.expandedSpec)) report('missing-stateless-rationale', `${flow.id} 无状态结束必须解释状态不适用依据`, flow)
      for (const id of flow.steps) {
        const step = graph.items.get(id)
        if (step?.kind === 'STEP' && (!step.input || !step.output || !step.rules.length)) report('incomplete-stateless-step', `${id} 必须声明输入域、可观察输出及失败/不变量规则`, step)
      }
    } else if (!flow.terminal.length) report('missing-flow-terminal', `${flow.id} 缺少明确结束结果`, flow)
    // A terminal declaration alone cannot rescue a closed STEP navigation cycle.
    const reached = new Set<string>(), queue = [...flow.steps.slice(0, 1)]
    let hasExit = false
    for (let at = 0; at < queue.length; at++) {
      const id = queue[at]
      if (reached.has(id)) continue
      reached.add(id)
      const step = graph.items.get(id)
      if (step?.kind !== 'STEP') { if (step?.kind === 'TR' || step?.kind === 'STATE') hasExit = true; continue }
      if (step.next === 'END') hasExit = true
      else queue.push(...step.next)
    }
    if (flow.steps.length && !hasExit) report('flow-no-exit', `${flow.id} 步骤没有可达结束或状态出口`, flow)
    for (const id of flow.steps) if (!reached.has(id)) report('unreachable-step', `${id} 不能从 ${flow.id} 入口步骤到达`, flow, [id])
  }
  return findings
}
