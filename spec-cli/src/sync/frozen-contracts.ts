import { loadSpecs } from '@spexcode/spec-core'
import { buildContractGraph, parseContract, parseParts, projectContractCoverage, validateContractGraph } from '@spexcode/spec-core/contracts'
import type { Contract, ContractCoverage, ContractFinding, ContractGraph, ContractItem, Verification } from '@spexcode/spec-core/contracts'
import { validateFrozenAnchors } from './frozen-anchors.js'

export type FrozenContracts = {
  files: ReadonlyMap<string, string>
  nodes: { id: string; path: string; rawSource: string | null }[]
  contracts: Contract[]
  graph: ContractGraph
  coverage: ContractCoverage
  findings: ContractFinding[]
}

/** 使用现有节点身份与契约解析器读取固定文本；root 只表示来源，不读取它的工作文件。 */
export async function readFrozenContracts(root: string, input: ReadonlyMap<string, string>): Promise<FrozenContracts> {
  const files = new Map(input)
  const sources = new Map([...files].filter(([path]) => path.startsWith('.spec/') && path.endsWith('/spec.md')))
  const nodes = await loadSpecs(root, { history: null, drift: null, snapshot: { tip: 'HEAD', files: sources } })
  const parsed = nodes.map(node => parseContract({ nodeId: node.id, path: node.path, source: sources.get(node.path)! }))
  const contracts = parsed.flatMap(result => result.contract ? [result.contract] : [])
  const graph = buildContractGraph(contracts)
  const findings = [...parsed.flatMap(result => result.findings), ...validateContractGraph(graph, { mode: 'final', files, nodeIds: new Set(nodes.map(node => node.id)) })]
  findings.push(...(await validateFrozenAnchors(graph, files)).findings)
  return { files, nodes: nodes.map(node => ({ id: node.id, path: node.path, rawSource: parseParts(sources.get(node.path)!)?.rawSource ?? null })), contracts, graph, coverage: projectContractCoverage(graph), findings }
}

export type GenerationContractPolicy = {
  /** 协调器冻结的新子节点原意或上层引用，模型不能自批。 */
  newNodeRawSources: ReadonlyMap<string, string>
  verifications: readonly Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>[]
}
const policyShape = (item: Verification): unknown => ({ command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs })
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function protectedMeaning(item: ContractItem): unknown {
  if (item.kind === 'REQ') return { goal: item.goal, constraints: item.constraints, success: item.success, source: item.source, dependsOn: item.dependsOn }
  if (item.kind === 'AC') return { covers: item.covers, preconditions: item.preconditions, action: item.action, assertion: item.assertion, command: item.command, source: item.source, dependsOn: item.dependsOn }
  return item.kind === 'VERIFY' ? policyShape(item) : null
}

/** 对生成基线与候选的并集检查保护项；业务改动必须先成为新的细化输入。 */
export function checkGenerationContractIntent(before: FrozenContracts, after: FrozenContracts, policy: GenerationContractPolicy): ContractFinding[] {
  const findings: ContractFinding[] = []
  const issue = (code: string, path: string, nodeId: string, message: string, itemId?: string): void => {
    findings.push({ code, severity: 'error', path, nodeId, message, ...(itemId ? { itemId } : {}) })
  }
  const priorNodes = new Map(before.nodes.map(node => [node.path, node]))
  const nextNodes = new Map(after.nodes.map(node => [node.path, node]))
  for (const node of before.nodes) {
    const next = nextNodes.get(node.path)
    if (!next || next.rawSource !== node.rawSource) issue('generation-raw-changed', node.path, node.id, '生成阶段必须保留冻结原始需求及其节点')
  }
  for (const node of after.nodes) if (!priorNodes.has(node.path) && (!policy.newNodeRawSources.has(node.path) || node.rawSource !== policy.newNodeRawSources.get(node.path))) {
    issue('generation-new-intent', node.path, node.id, '新增节点必须使用协调器冻结的原意或上层引用')
  }
  for (const contract of before.contracts) if (!after.contracts.some(next => next.path === contract.path)) {
    issue('generation-schema-removed', contract.path, contract.nodeId, '已有同步契约不能退出检查范围')
  }
  for (const item of before.graph.items.values()) {
    if (!['REQ', 'AC', 'VERIFY'].includes(item.kind)) continue
    const next = after.graph.items.get(item.id)
    if (!next || next.kind !== item.kind) issue('generation-protected-item-removed', item.path, item.nodeId, '生成候选必须保留需求、验收和验证身份', item.id)
    else if (!same(protectedMeaning(item), protectedMeaning(next))) issue('generation-protected-meaning-changed', next.path, next.nodeId, '生成器不能更改已细化需求、验收语义或验证政策', item.id)
  }
  const registered = new Map(policy.verifications.map(item => [item.id, item]))
  for (const item of after.graph.items.values()) if (item.kind === 'VERIFY') {
    const trusted = registered.get(item.id)
    if (!trusted || !same(policyShape(item), { command: trusted.command, cwd: trusted.cwd, timeoutMs: trusted.timeoutMs })) {
      issue('generation-verification-unregistered', item.path, item.nodeId, '命令、目录与预算必须符合冻结验证登记', item.id)
    }
  }
  return findings
}
