import { posix } from 'node:path'
import { parseCodeEntry, parseRelation, relationClaimsPath } from '@spexcode/spec-core'
import type { RelationEntry } from '@spexcode/spec-core'
import { buildContractGraph, contractReferences, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import type { Contract, ContractGraph } from '@spexcode/spec-core/contracts'
import { contentHash } from './snapshot.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { coveredPath } from './settings.js'

const DEFAULT_READ_LIMIT_BYTES = 512 * 1024
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare)

export type SyncPartition = {
  id: string
  phase?: 'interface_seed'
  intentNodeId: string
  targets: SyncCoordinatorPlan['targets']
  readPaths: string[]
  writePaths: string[]
  sourcePaths: string[]
  changedPaths: string[]
  contextNodeIds: string[]
  contractIds: string[]
  flowIds: string[]
  readBytes: number
  readLimitBytes: number
  oversizedReads: { path: string; bytes: number; limitBytes: number }[]
}

export type SyncPartitionDependency = { from: string; to: string; contractIds: string[]; paths: string[] }
export type SyncPartitionPlan = {
  version: 'sync-partitions-v1'
  partitions: SyncPartition[]
  dependencies: SyncPartitionDependency[]
  expectedPaths: string[]
  digest: string
}

export type PlanSyncPartitionsInput = {
  plan: SyncCoordinatorPlan
  files: ReadonlyMap<string, string>
  contracts: readonly Contract[]
  nodes?: readonly { id: string; path: string; rawSource?: string | null }[]
  /** 仅提供 current files 缺失 Spec 路径的旧治理正文；不得并入当前读取视图。 */
  governanceSources?: ReadonlyMap<string, string>
  changedPaths: readonly string[]
  maxReadBytes?: number
  /** 按 path 提供 composed files 外、已由调用方去重的真实版本正文总字节估计。 */
  readByteSizes?: ReadonlyMap<string, number>
}

/** 纯接口父判定只需调用方冻结的节点、Spec正文、契约、源码角色与本地target；不依赖完整协调plan。 */
export type RawOnlyInterfaceSeedInput = {
  files: ReadonlyMap<string, string>
  sourcePaths: readonly string[]
  contracts: readonly Contract[]
  nodes?: readonly { id: string; path: string; rawSource?: string | null }[]
  governanceSources?: ReadonlyMap<string, string>
  targets: readonly SyncCoordinatorPlan['targets'][number][]
}

export type RawOnlyInterfaceSeedDescendant = {
  nodeId: string
  path: string
  codePath: string
  sourcePartitionId: string
  sourcePaths: readonly string[]
}
export type RawOnlyInterfaceSeedEvidence = {
  phase: 'interface_seed'
  parentNodeId: string
  parentPath: string
  descendants: { nodeId: string; path: string; codePaths: string[]; sourcePartitionId?: string }[]
}

type Claim = { path: string }
type GovernanceNode = { id: string; path: string; rawSource: string | null; code: RelationEntry[]; related: RelationEntry[]; current: boolean; sourceDigest: string | null }
type Draft = { targetNodeIds: string[]; changedPaths: string[]; discoveryNodeIds: string[]; packingKey: string; phase?: 'interface_seed' }
type Context = { readPaths: string[]; contextNodeIds: string[]; contractIds: string[]; flowIds: string[] }

function frontmatterPaths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  return Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []
}

function parseNodeRelation(path: string, entries: string[], relation: 'code' | 'related'): RelationEntry[] {
  const parsed = parseRelation(entries, relation)
  if (parsed.problems.length) throw new Error(`${path} 的 ${relation} 声明无效: ${parsed.problems.join('; ')}`)
  return parsed.entries
}

function governanceNodeKey(id: string, path: string): string { return `${id}\0${path}` }

function governanceNodeAtPath(nodes: ReadonlyMap<string, GovernanceNode>, path: string): GovernanceNode | undefined {
  return [...nodes.values()].find(node => node.path === path)
}

function governanceNodesForId(nodes: ReadonlyMap<string, GovernanceNode>, id: string): GovernanceNode[] {
  return [...nodes.values()].filter(node => node.id === id).sort((a, b) => compare(a.path, b.path))
}

function governanceNodesForInput(input: RawOnlyInterfaceSeedInput, contracts: readonly Contract[]): Map<string, GovernanceNode> {
  const identities = new Map<string, { id: string; path: string; rawSource?: string | null }>()
  const addIdentity = (identity: { id: string; path: string; rawSource?: string | null }): void => {
    const key = governanceNodeKey(identity.id, identity.path), prior = identities.get(key)
    if (!prior) identities.set(key, identity)
    else if (prior.rawSource === undefined && identity.rawSource !== undefined) identities.set(key, { ...prior, rawSource: identity.rawSource })
  }
  for (const node of [...(input.nodes ?? [])].sort((a, b) => compare(a.id, b.id) || compare(a.path, b.path))) addIdentity(node)
  for (const target of [...input.targets].sort((a, b) => compare(a.nodeId, b.nodeId) || compare(a.path, b.path))) addIdentity({ id: target.nodeId, path: target.path, rawSource: target.rawSource })
  for (const contract of [...contracts].sort((a, b) => compare(a.nodeId, b.nodeId) || compare(a.path, b.path))) addIdentity({ id: contract.nodeId, path: contract.path, rawSource: contract.rawSource })

  const contractByPath = new Map(contracts.map(contract => [governanceNodeKey(contract.nodeId, contract.path), contract]))
  const nodes = new Map<string, GovernanceNode>()
  for (const identity of identities.values()) {
    const currentSource = input.files.get(identity.path)
    const historicalSource = currentSource === undefined ? input.governanceSources?.get(identity.path) : undefined
    const source = currentSource ?? historicalSource
    const contract = contractByPath.get(governanceNodeKey(identity.id, identity.path))
    const fm = source === undefined ? undefined : parseFrontmatter(source).fm
    const code = fm?.code === undefined ? contract?.code ?? [] : frontmatterPaths(fm.code)
    const related = fm?.related === undefined ? contract?.related ?? [] : frontmatterPaths(fm.related)
    const rawSource = source === undefined ? identity.rawSource ?? contract?.rawSource ?? null : parseParts(source)?.rawSource || null
    nodes.set(governanceNodeKey(identity.id, identity.path), {
      id: identity.id,
      path: identity.path,
      rawSource,
      code: parseNodeRelation(identity.path, code, 'code'),
      related: parseNodeRelation(identity.path, related, 'related'),
      current: currentSource !== undefined,
      sourceDigest: historicalSource === undefined ? null : contentHash(Buffer.from(historicalSource, 'utf8')),
    })
  }
  return nodes
}

function rawIntentSeedNodes(input: PlanSyncPartitionsInput, contracts: readonly Contract[], governanceNodes: ReadonlyMap<string, GovernanceNode>): Set<string> {
  const contractedNodeIds = new Set(contracts.map(contract => contract.nodeId))
  return new Set(input.plan.targets.filter(target => target.nodeId === input.plan.intentNodeId && !contractedNodeIds.has(target.nodeId))
    .filter(target => !!(governanceNodeAtPath(governanceNodes, target.path)?.rawSource ?? target.rawSource)?.trim()).map(target => target.nodeId))
}

function rawOnlyInterfaceSeedEvidenceFrom(
  input: RawOnlyInterfaceSeedInput,
  target: SyncCoordinatorPlan['targets'][number],
  governanceNodes: ReadonlyMap<string, GovernanceNode>,
  additionalCodeBearingDescendants: readonly RawOnlyInterfaceSeedDescendant[],
): RawOnlyInterfaceSeedEvidence | null {
  if (!input.targets.some(candidate => candidate.nodeId === target.nodeId && candidate.path === target.path)) return null
  const parentContracts = input.contracts.filter(contract => contract.nodeId === target.nodeId)
  if (parentContracts.length) {
    if (parentContracts.length !== 1) return null
    const parentContract = parentContracts[0]
    // VERIFY 只供父项分类；命令的精确登记匹配仍由上游硬门禁负责。
    if (parentContract.path !== target.path || parentContract.code.length !== 0
      || !parentContract.items.some(item => item.kind === 'REQ' || item.kind === 'RULE' || item.kind === 'GAP')
      || parentContract.items.some(item => item.kind !== 'REQ' && item.kind !== 'RULE' && item.kind !== 'GAP' && item.kind !== 'VERIFY')) return null
  }
  const parent = governanceNodeAtPath(governanceNodes, target.path)
  if (!parent || parent.code.length) return null
  const rawSource = parent.current ? parent.rawSource : parent.rawSource ?? target.rawSource ?? null
  if (!rawSource?.trim()) return null

  const parentDirectory = posix.dirname(target.path)
  const isDescendant = (path: string): boolean => path !== target.path && path.startsWith(`${parentDirectory}/`)
  const descendants = new Map<string, RawOnlyInterfaceSeedEvidence['descendants'][number]>()
  for (const candidate of input.targets) {
    if (candidate.nodeId === target.nodeId || !isDescendant(candidate.path)) continue
    const node = governanceNodeAtPath(governanceNodes, candidate.path)
    if (!node?.code.length) continue
    const codePaths = uniqueSorted(node.code.flatMap(entry => [...input.files.keys()].filter(path =>
      coveredPath(path, input.sourcePaths) && relationClaimsPath(entry.path, path))))
    if (codePaths.length) descendants.set(`${candidate.nodeId}\0${candidate.path}`, { nodeId: candidate.nodeId, path: candidate.path, codePaths })
  }
  const sourcePartitionOwners = new Map<string, Set<string>>()
  for (const candidate of additionalCodeBearingDescendants) {
    if (!isDescendant(candidate.path) || !candidate.nodeId || !candidate.codePath || !candidate.sourcePartitionId
      || !candidate.sourcePaths.includes(candidate.codePath)
      || !input.targets.some(target => target.nodeId === candidate.nodeId && target.path === candidate.path)) continue
    const owners = sourcePartitionOwners.get(candidate.codePath) ?? new Set<string>()
    owners.add(candidate.sourcePartitionId)
    sourcePartitionOwners.set(candidate.codePath, owners)
  }
  for (const candidate of additionalCodeBearingDescendants) {
    if (!isDescendant(candidate.path) || !candidate.nodeId || !candidate.codePath || !candidate.sourcePartitionId
      || !candidate.sourcePaths.includes(candidate.codePath)
      || sourcePartitionOwners.get(candidate.codePath)?.size !== 1
      || !input.targets.some(target => target.nodeId === candidate.nodeId && target.path === candidate.path)) continue
    const key = `${candidate.nodeId}\0${candidate.path}`
    const prior = descendants.get(key)
    descendants.set(key, {
      nodeId: candidate.nodeId,
      path: candidate.path,
      codePaths: uniqueSorted([...(prior?.codePaths ?? []), candidate.codePath]),
      sourcePartitionId: candidate.sourcePartitionId,
    })
  }
  if (!descendants.size) return null
  return {
    phase: 'interface_seed',
    parentNodeId: target.nodeId,
    parentPath: target.path,
    descendants: [...descendants.values()].sort((a, b) => compare(a.path, b.path) || compare(a.nodeId, b.nodeId)),
  }
}

/** 唯一判定 raw-only 或仅含 REQ/RULE/GAP 的纯接口父节点；后代来源须受冻结分区 sourcePaths 约束。 */
export function rawOnlyInterfaceSeedEvidence(
  input: RawOnlyInterfaceSeedInput,
  target: SyncCoordinatorPlan['targets'][number],
  additionalCodeBearingDescendants: readonly RawOnlyInterfaceSeedDescendant[] = [],
): RawOnlyInterfaceSeedEvidence | null {
  const contracts = [...input.contracts].sort((a, b) => compare(a.nodeId, b.nodeId) || compare(a.path, b.path))
  return rawOnlyInterfaceSeedEvidenceFrom(input, target, governanceNodesForInput(input, contracts), additionalCodeBearingDescendants)
}

function targetWritePaths(input: PlanSyncPartitionsInput, nodeId: string, governanceNodes: ReadonlyMap<string, GovernanceNode>, specOnly = false): string[] {
  const target = input.plan.targets.find(target => target.nodeId === nodeId)!
  if (specOnly) return coveredPath(target.path, input.plan.writePaths)
    && (!input.plan.executionScope || coveredPath(target.path, input.plan.executionScope.paths)) ? [target.path] : []
  const paths = new Set<string>([target.path])
  const claims: Claim[] = []
  for (const node of governanceNodesForId(governanceNodes, nodeId)) for (const entry of node.code) claims.push({ path: entry.path })
  for (const contract of input.contracts.filter(contract => contract.nodeId === nodeId)) {
    for (const item of contract.items) if (item.kind === 'AC') claims.push({ path: parseCodeEntry(item.test).path })
  }
  addContractClaims(paths, claims, input.files, new Set(input.changedPaths))
  const knownPaths = [...input.files.keys(), ...input.changedPaths]
  return uniqueSorted([...paths].filter(path =>
    coveredPath(path, input.plan.writePaths)
    && (!input.plan.executionScope || coveredPath(path, input.plan.executionScope.paths))
    && !input.plan.mandatoryTests.some(test => coveredPath(test.testPath, [path]) || coveredPath(path, [test.testPath]))
    && (input.files.has(path) || !knownPaths.some(known => known.startsWith(`${path}/`)))))
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort(compare).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 当前及历史冻结治理共用同一 owner 判定，related 不授予归属。 */
export function ownerNodesForPath(path: string, contracts: readonly Contract[], governanceNodes: Iterable<Pick<GovernanceNode, 'id' | 'path' | 'code'>>): Set<string> {
  const owners = new Set<string>()
  for (const node of governanceNodes) if (node.path === path || node.code.some(entry => relationClaimsPath(entry.path, path))) owners.add(node.id)
  for (const contract of contracts) {
    for (const item of contract.items) {
      if (item.kind === 'VERIFY') continue
      if (item.source.kind === 'code' && relationClaimsPath(parseCodeEntry(item.source.ref).path, path)) owners.add(contract.nodeId)
      if (item.kind === 'AC' && relationClaimsPath(parseCodeEntry(item.test).path, path)) owners.add(contract.nodeId)
    }
  }
  return owners
}

function closestNode(path: string, governanceNodes: ReadonlyMap<string, GovernanceNode>, preferred: ReadonlySet<string>): GovernanceNode | undefined {
  const targetParts = posix.dirname(path).split('/').filter(Boolean)
  const candidates = [...governanceNodes.values()].flatMap(node => [...node.code, ...node.related].map(entry => {
    const parts = posix.dirname(entry.path).split('/').filter(Boolean)
    let shared = 0
    while (shared < targetParts.length && shared < parts.length && targetParts[shared] === parts[shared]) shared++
    const preference = preferred.has(node.id) ? 1 : 0
    return { node, shared, preference, distance: targetParts.length + parts.length - shared * 2 }
  })).filter(candidate => candidate.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.distance - b.distance || b.preference - a.preference || compare(a.node.id, b.node.id) || compare(a.node.path, b.node.path))
  return candidates[0]?.node
}

function specModuleDirectory(specPath: string): string {
  return posix.dirname(posix.dirname(specPath))
}

function sourceModuleDirectory(path: string, sourcePaths: readonly string[]): string {
  const root = [...sourcePaths].filter(source => coveredPath(path, [source])).sort((a, b) => b.length - a.length || compare(a, b))[0]
  if (!root) return posix.dirname(path)
  const normalizedRoot = root.replace(/\/+$/, '')
  const relative = path === normalizedRoot ? '' : path.slice(normalizedRoot.length).replace(/^\/+/, '')
  const segments = relative.split('/').filter(Boolean)
  const topModule = segments.length > 1 ? segments[0] : undefined
  return topModule ? posix.join(normalizedRoot, topModule) : normalizedRoot
}

function addContractClaims(paths: Set<string>, claims: readonly Claim[], files: ReadonlyMap<string, string>, changed: ReadonlySet<string>): void {
  for (const { path } of claims) {
    if (!path.includes('*')) paths.add(path)
    for (const file of files.keys()) if (relationClaimsPath(path, file)) paths.add(file)
    for (const file of changed) if (relationClaimsPath(path, file)) paths.add(file)
  }
}

function contextFor(
  input: PlanSyncPartitionsInput,
  graph: ContractGraph,
  contractsByNode: ReadonlyMap<string, Contract[]>,
  governanceNodes: ReadonlyMap<string, GovernanceNode>,
  specOnlyNodeIds: ReadonlySet<string>,
  draft: Draft,
): Context {
  const writeNodeIds = new Set(draft.targetNodeIds)
  const initialNodeIds = new Set([...draft.targetNodeIds, ...draft.discoveryNodeIds])
  const relevantItems = new Set<string>()
  const relevantNodes = new Set(initialNodeIds)
  const claimNodeIds = new Set(draft.targetNodeIds.filter(nodeId => !specOnlyNodeIds.has(nodeId)))
  const pending: string[] = []
  for (const nodeId of draft.targetNodeIds) for (const contract of contractsByNode.get(nodeId) ?? []) {
    for (const item of contract.items) if (item.kind !== 'VERIFY') { relevantItems.add(item.id); pending.push(item.id) }
  }
  for (let at = 0; at < pending.length; at++) {
    const item = graph.items.get(pending[at])
    if (!item) continue
    for (const reference of contractReferences(item)) {
      const dependency = graph.items.get(reference.id)
      if (!dependency) continue
      const owner = graph.owners.get(reference.id)
      if (owner) relevantNodes.add(owner.nodeId)
      if (!relevantItems.has(reference.id)) { relevantItems.add(reference.id); pending.push(reference.id) }
    }
  }

  const localPaths = new Set<string>(draft.changedPaths)
  for (const target of input.plan.targets) if (writeNodeIds.has(target.nodeId)) localPaths.add(target.path)
  for (const itemId of relevantItems) {
    const item = graph.items.get(itemId)
    if (item) localPaths.add(item.path)
  }

  const nodesByPath = new Map([...governanceNodes.values()].map(node => [node.path, node]))
  const pathNodes = new Map<string, GovernanceNode>()
  for (const node of governanceNodes.values()) if (relevantNodes.has(node.id)) pathNodes.set(node.path, node)
  const rawContextPaths = new Set<string>(localPaths)
  const contextNodes = new Set<string>(relevantNodes)
  for (const node of pathNodes.values()) {
    rawContextPaths.add(node.path)
    let directory = posix.dirname(node.path)
    while (directory !== '.' && directory !== '/') {
      const ancestorPath = posix.join(directory, 'spec.md')
      const ancestor = nodesByPath.get(ancestorPath)
      if (ancestor) contextNodes.add(ancestor.id)
      if (ancestor || input.files.has(ancestorPath)) rawContextPaths.add(ancestorPath)
      const parent = posix.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const intentTarget = input.plan.targets.find(target => target.nodeId === input.plan.intentNodeId)
  const intent = (intentTarget && governanceNodeAtPath(governanceNodes, intentTarget.path))
    ?? governanceNodesForId(governanceNodes, input.plan.intentNodeId).find(node => node.current)
    ?? intentTarget
  if (intent) {
    const intentPath = intent.path
    rawContextPaths.add(intentPath)
    if (!writeNodeIds.has(input.plan.intentNodeId)) contextNodes.add(input.plan.intentNodeId)
    let directory = posix.dirname(intentPath)
    while (directory !== '.' && directory !== '/') {
      const ancestorPath = posix.join(directory, 'spec.md')
      const ancestor = nodesByPath.get(ancestorPath)
      if (ancestor) contextNodes.add(ancestor.id)
      if (ancestor || input.files.has(ancestorPath)) rawContextPaths.add(ancestorPath)
      const parent = posix.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const claims: Claim[] = []
  const contextRelatedNodeIds = new Set([...draft.targetNodeIds, ...draft.discoveryNodeIds].filter(nodeId => !specOnlyNodeIds.has(nodeId)))
  for (const node of governanceNodes.values()) {
    if (claimNodeIds.has(node.id)) for (const entry of node.code) claims.push({ path: entry.path })
    if (contextRelatedNodeIds.has(node.id)) for (const entry of node.related) claims.push({ path: entry.path })
  }
  for (const nodeId of claimNodeIds) for (const contract of contractsByNode.get(nodeId) ?? []) {
    for (const item of contract.items) if (item.kind !== 'VERIFY') {
      if (item.source.kind === 'code') claims.push({ path: parseCodeEntry(item.source.ref).path })
      if (item.kind === 'AC') claims.push({ path: parseCodeEntry(item.test).path })
    }
  }
  addContractClaims(rawContextPaths, claims, input.files, new Set(draft.changedPaths))
  const needsInitialMandatoryTests = draft.targetNodeIds.some(nodeId => {
    const sourceWriter = targetWritePaths(input, nodeId, governanceNodes, specOnlyNodeIds.has(nodeId))
      .some(path => coveredPath(path, input.plan.sourcePaths ?? []))
    const hasAcceptance = (contractsByNode.get(nodeId) ?? []).some(contract => contract.items.some(item => item.kind === 'AC'))
    return sourceWriter && !hasAcceptance
  })
  for (const mandatory of input.plan.mandatoryTests) {
    if (needsInitialMandatoryTests || draft.changedPaths.includes(mandatory.testPath) || claims.some(claim => relationClaimsPath(claim.path, mandatory.testPath))) rawContextPaths.add(mandatory.testPath)
  }
  if (input.files.has('.spec/spexcode.json') && coveredPath('.spec/spexcode.json', input.plan.readPaths)) rawContextPaths.add('.spec/spexcode.json')

  const readable = (path: string): boolean => coveredPath(path, input.plan.readPaths) || input.plan.targets.some(target => target.path === path)
  const readPaths = uniqueSorted([...rawContextPaths].filter(readable))
  const localItems = graph.contracts.filter(contract => writeNodeIds.has(contract.nodeId)).flatMap(contract => contract.items)
  const contractIds = uniqueSorted(localItems.filter(item => item.kind !== 'VERIFY' && item.kind !== 'FLOW').map(item => item.id))
    .filter(id => input.plan.executionScope?.contractIds.includes(id) ?? false)
  const flowIds = uniqueSorted(localItems.filter(item => item.kind === 'FLOW').map(item => item.id))
    .filter(id => input.plan.executionScope?.flowIds.includes(id) ?? false)
  return {
    readPaths,
    contextNodeIds: uniqueSorted([...contextNodes].filter(nodeId => !writeNodeIds.has(nodeId))),
    contractIds,
    flowIds,
  }
}

function readFootprint(paths: readonly string[], files: ReadonlyMap<string, string>, estimates: ReadonlyMap<string, number> | undefined, limitBytes: number): Pick<SyncPartition, 'readBytes' | 'readLimitBytes' | 'oversizedReads'> {
  const bodies = new Map<string, { bytes: number; paths: string[] }>()
  for (const path of paths) {
    const body = files.get(path)
    const estimatedBytes = estimates?.get(path)
    if (estimatedBytes !== undefined && (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0)) throw new Error(`readByteSizes 中的字节估算无效: ${path}`)
    if (body === undefined && estimatedBytes === undefined) continue
    // A per-path estimate can include different historical versions behind identical current bytes.
    const hash = estimatedBytes !== undefined ? `estimated:${path}` : body === undefined ? `missing:${path}` : contentHash(Buffer.from(body, 'utf8'))
    const bytes = Math.max(body === undefined ? 0 : Buffer.byteLength(body, 'utf8'), estimatedBytes ?? 0)
    const prior = bodies.get(hash)
    if (prior) { prior.bytes = Math.max(prior.bytes, bytes); prior.paths.push(path) }
    else bodies.set(hash, { bytes, paths: [path] })
  }
  const readBytes = [...bodies.values()].reduce((sum, body) => sum + body.bytes, 0)
  const oversizedReads = [...bodies.values()].filter(body => body.bytes > limitBytes).map(body => ({ path: [...body.paths].sort(compare)[0], bytes: body.bytes, limitBytes })).sort((a, b) => compare(a.path, b.path))
  return { readBytes, readLimitBytes: limitBytes, oversizedReads }
}

function contextBytes(input: PlanSyncPartitionsInput, graph: ContractGraph, contractsByNode: ReadonlyMap<string, Contract[]>, governanceNodes: ReadonlyMap<string, GovernanceNode>, specOnlyNodeIds: ReadonlySet<string>, draft: Draft, limitBytes: number): number {
  const context = contextFor(input, graph, contractsByNode, governanceNodes, specOnlyNodeIds, draft)
  return readFootprint(context.readPaths, input.files, input.readByteSizes, limitBytes).readBytes
}

function partitionDrafts(input: PlanSyncPartitionsInput, contracts: readonly Contract[], governanceNodes: ReadonlyMap<string, GovernanceNode>, specOnlyNodeIds: ReadonlySet<string>, interfaceSeedNodeIds: ReadonlySet<string>, graph: ContractGraph, limitBytes: number): Draft[] {
  const targets = [...input.plan.targets].sort((a, b) => compare(a.path, b.path) || compare(a.nodeId, b.nodeId))
  const targetByNode = new Map(targets.map(target => [target.nodeId, target]))
  const parent = new Map<string, string>(targets.map(target => [target.nodeId, target.nodeId]))
  const find = (nodeId: string): string => {
    const current = parent.get(nodeId)!
    if (current !== nodeId) parent.set(nodeId, find(current))
    return parent.get(nodeId)!
  }
  const union = (left: string, right: string): void => {
    const a = find(left), b = find(right)
    if (a !== b) parent.set(compare(a, b) <= 0 ? b : a, compare(a, b) <= 0 ? a : b)
  }
  const changedPaths = uniqueSorted(input.changedPaths)
  const writers = new Map(targets.map(target => [target.nodeId, targetWritePaths(input, target.nodeId, governanceNodes, specOnlyNodeIds.has(target.nodeId))]))
  const activeTargets = targets.filter(target => target.nodeId !== input.plan.intentNodeId || changedPaths.includes(target.path)
    || specOnlyNodeIds.has(target.nodeId) || writers.get(target.nodeId)!.some(path => path !== target.path))
  const writerByPath = new Map<string, string>()
  for (const target of activeTargets) for (const path of writers.get(target.nodeId)!) {
    const prior = writerByPath.get(path)
    if (prior) union(prior, target.nodeId)
    else writerByPath.set(path, target.nodeId)
  }
  const assigned = new Map<string, string[]>()
  const discoveries = new Map<string, Draft[]>()
  const preferred = new Set(targetByNode.keys())
  for (const path of changedPaths) {
    const owners = ownerNodesForPath(path, contracts, governanceNodes.values())
    for (const target of targets) if (target.path === path) owners.add(target.nodeId)
    const writableOwners = [...owners].filter(nodeId => targetByNode.has(nodeId)
      && (!specOnlyNodeIds.has(nodeId) || targetByNode.get(nodeId)!.path === path)).sort(compare)
    if (writableOwners.length) {
      for (const nodeId of writableOwners.slice(1)) union(writableOwners[0], nodeId)
      assigned.set(path, writableOwners)
      continue
    }
    const nearest = closestNode(path, governanceNodes, preferred)
    const module = nearest ? specModuleDirectory(nearest.path) : sourceModuleDirectory(path, input.plan.sourcePaths ?? [])
    const key = nearest ? `discovery:${module}` : `discovery-source:${module}`
    const groups = discoveries.get(key) ?? []
    groups.push({ targetNodeIds: [], changedPaths: [path], discoveryNodeIds: nearest ? [nearest.id] : [], packingKey: key })
    discoveries.set(key, groups)
  }

  const byRoot = new Map<string, Draft>()
  for (const target of activeTargets) {
    const root = find(target.nodeId)
    const draft = byRoot.get(root) ?? { targetNodeIds: [], changedPaths: [], discoveryNodeIds: [], packingKey: '' }
    draft.targetNodeIds.push(target.nodeId)
    byRoot.set(root, draft)
  }
  for (const path of changedPaths) for (const nodeId of assigned.get(path) ?? []) {
    const root = find(nodeId)
    const draft = byRoot.get(root) ?? { targetNodeIds: [], changedPaths: [], discoveryNodeIds: [], packingKey: '' }
    if (!draft.targetNodeIds.includes(nodeId)) draft.targetNodeIds.push(nodeId)
    if (!draft.changedPaths.includes(path)) draft.changedPaths.push(path)
    byRoot.set(root, draft)
  }
  for (const draft of byRoot.values()) {
    draft.targetNodeIds = uniqueSorted(draft.targetNodeIds)
    draft.changedPaths = uniqueSorted(draft.changedPaths)
    const interfaceParent = draft.targetNodeIds.length === 1 && interfaceSeedNodeIds.has(draft.targetNodeIds[0]) ? draft.targetNodeIds[0] : null
    if (interfaceParent) {
      draft.phase = 'interface_seed'
      draft.packingKey = `interface-seed:${interfaceParent}`
    } else {
      const targetModules = uniqueSorted(draft.targetNodeIds.map(nodeId => specModuleDirectory(targetByNode.get(nodeId)!.path)))
      draft.packingKey = targetModules.length === 1 ? `targets:${targetModules[0]}` : `shared:${draft.targetNodeIds.join(',')}`
    }
  }

  const contractsByNode = new Map<string, Contract[]>()
  for (const contract of contracts) {
    const items = contractsByNode.get(contract.nodeId) ?? []
    items.push(contract)
    contractsByNode.set(contract.nodeId, items)
  }
  const orderedDrafts = [...byRoot.values(), ...[...discoveries.values()].flat()].sort((a, b) => compare(a.packingKey, b.packingKey) || compare(a.changedPaths[0] ?? '', b.changedPaths[0] ?? ''))
  const packed: Draft[] = []
  const lastByKey = new Map<string, number>()
  for (const draft of orderedDrafts) {
    const currentBytes = contextBytes(input, graph, contractsByNode, governanceNodes, specOnlyNodeIds, draft, limitBytes)
    const previousIndex = lastByKey.get(draft.packingKey)
    const packable = draft.packingKey.startsWith('targets:') || draft.packingKey.startsWith('discovery:') || draft.packingKey.startsWith('discovery-source:')
    if (packable && previousIndex !== undefined && currentBytes <= limitBytes) {
      const previous = packed[previousIndex]
      const combined: Draft = {
        targetNodeIds: uniqueSorted([...previous.targetNodeIds, ...draft.targetNodeIds]),
        changedPaths: uniqueSorted([...previous.changedPaths, ...draft.changedPaths]),
        discoveryNodeIds: uniqueSorted([...previous.discoveryNodeIds, ...draft.discoveryNodeIds]),
        packingKey: draft.packingKey,
      }
      if (contextBytes(input, graph, contractsByNode, governanceNodes, specOnlyNodeIds, combined, limitBytes) <= limitBytes) {
        packed[previousIndex] = combined
        continue
      }
    }
    packed.push(draft)
    if (packable && currentBytes <= limitBytes) lastByKey.set(draft.packingKey, packed.length - 1)
    else lastByKey.delete(draft.packingKey)
  }
  return packed
}

function projectedPartition(input: PlanSyncPartitionsInput, draft: Draft, context: Context, governanceNodes: ReadonlyMap<string, GovernanceNode>, specOnlyNodeIds: ReadonlySet<string>, limitBytes: number): SyncPartition {
  const targets = input.plan.targets.filter(target => draft.targetNodeIds.includes(target.nodeId)).sort((a, b) => compare(a.path, b.path) || compare(a.nodeId, b.nodeId))
  const writePaths = uniqueSorted([
    ...draft.changedPaths.filter(path => coveredPath(path, input.plan.writePaths)
      && (!input.plan.executionScope || coveredPath(path, input.plan.executionScope.paths))
      && !input.plan.mandatoryTests.some(test => coveredPath(test.testPath, [path]) || coveredPath(path, [test.testPath]))),
    ...targets.flatMap(target => targetWritePaths(input, target.nodeId, governanceNodes, specOnlyNodeIds.has(target.nodeId))),
  ])
  const sourcePaths = uniqueSorted([...draft.changedPaths, ...writePaths].filter(path => coveredPath(path, input.plan.sourcePaths ?? [])))
  const contextNodes = new Set([...context.contextNodeIds, ...draft.discoveryNodeIds])
  const readPaths = uniqueSorted(context.readPaths)
  const read = readFootprint(readPaths, input.files, input.readByteSizes, limitBytes)
  const identity = { targets: targets.map(target => ({ nodeId: target.nodeId, path: target.path })), changedPaths: uniqueSorted(draft.changedPaths) }
  const id = `partition-${contentHash(canonical(identity)).slice(0, 16)}`
  return {
    id,
    ...(draft.phase ? { phase: draft.phase } : {}),
    intentNodeId: input.plan.intentNodeId,
    targets,
    readPaths,
    writePaths,
    sourcePaths,
    changedPaths: uniqueSorted(draft.changedPaths),
    contextNodeIds: uniqueSorted(contextNodes),
    contractIds: context.contractIds,
    flowIds: context.flowIds,
    ...read,
  }
}

function dependencyEdges(partitions: readonly SyncPartition[], graph: ContractGraph): SyncPartitionDependency[] {
  const partitionByNode = new Map<string, string>()
  for (const partition of partitions) for (const target of partition.targets) partitionByNode.set(target.nodeId, partition.id)
  const edges = new Map<string, { from: string; to: string; contractIds: Set<string>; paths: Set<string> }>()
  for (const item of graph.items.values()) {
    const owner = graph.owners.get(item.id)
    const from = owner && partitionByNode.get(owner.nodeId)
    if (!owner || !from) continue
    for (const reference of contractReferences(item)) {
      const dependency = graph.items.get(reference.id)
      const dependencyOwner = dependency && graph.owners.get(dependency.id)
      const to = dependencyOwner && partitionByNode.get(dependencyOwner.nodeId)
      if (!to || to === from) continue
      const key = `${from}\0${to}`
      const edge = edges.get(key) ?? { from, to, contractIds: new Set<string>(), paths: new Set<string>() }
      edge.contractIds.add(item.id)
      edge.contractIds.add(reference.id)
      edge.paths.add(owner.path)
      edge.paths.add(dependencyOwner.path)
      for (const contract of [owner, dependencyOwner]) {
        for (const entry of parseRelation(contract.code, 'code').entries) edge.paths.add(entry.path)
        for (const entry of parseRelation(contract.related, 'related').entries) edge.paths.add(entry.path)
      }
      edges.set(key, edge)
    }
  }
  return [...edges.values()].map(edge => ({ from: edge.from, to: edge.to, contractIds: uniqueSorted(edge.contractIds), paths: uniqueSorted(edge.paths) }))
    .sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to))
}

function planFingerprint(plan: SyncCoordinatorPlan): unknown {
  return {
    ...plan,
    targets: [...plan.targets].sort((a, b) => compare(a.nodeId, b.nodeId) || compare(a.path, b.path)),
    readPaths: uniqueSorted(plan.readPaths),
    writePaths: uniqueSorted(plan.writePaths),
    sourcePaths: uniqueSorted(plan.sourcePaths ?? []),
    facts: [...plan.facts].sort((a, b) => compare(a.source, b.source) || compare(a.text, b.text)),
    verifications: [...plan.verifications].sort((a, b) => compare(a.definition.id, b.definition.id)),
    mandatoryTests: [...plan.mandatoryTests].sort((a, b) => compare(a.testPath, b.testPath) || compare(a.testId, b.testId) || compare(a.verificationId, b.verificationId)),
    retiredIds: uniqueSorted(plan.retiredIds ?? []),
  }
}

/** 从现有冻结计划和契约图确定分区；不访问工作树、仓库或模型。 */
export function planSyncPartitions(input: PlanSyncPartitionsInput): SyncPartitionPlan {
  const limitBytes = input.maxReadBytes ?? DEFAULT_READ_LIMIT_BYTES
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new Error('maxReadBytes 必须为正安全整数')
  const contracts = [...input.contracts].sort((a, b) => compare(a.nodeId, b.nodeId) || compare(a.path, b.path))
  const graph = buildContractGraph(contracts)
  const frozenInput: RawOnlyInterfaceSeedInput = {
    files: input.files, sourcePaths: input.plan.sourcePaths ?? [], contracts, nodes: input.nodes, governanceSources: input.governanceSources, targets: input.plan.targets,
  }
  const governanceNodes = governanceNodesForInput(frozenInput, contracts)
  const interfaceSeedNodeIds = new Set(input.plan.targets.flatMap(target => rawOnlyInterfaceSeedEvidenceFrom(frozenInput, target, governanceNodes, []) ? [target.nodeId] : []))
  const specOnlyNodeIds = new Set([...rawIntentSeedNodes(input, contracts, governanceNodes), ...interfaceSeedNodeIds])
  const contractsByNode = new Map<string, Contract[]>()
  for (const contract of contracts) {
    const nodeContracts = contractsByNode.get(contract.nodeId) ?? []
    nodeContracts.push(contract)
    contractsByNode.set(contract.nodeId, nodeContracts)
  }
  const drafts = partitionDrafts(input, contracts, governanceNodes, specOnlyNodeIds, interfaceSeedNodeIds, graph, limitBytes)
  const partitions = drafts.map(draft => projectedPartition(input, draft, contextFor(input, graph, contractsByNode, governanceNodes, specOnlyNodeIds, draft), governanceNodes, specOnlyNodeIds, limitBytes))
    .sort((a, b) => compare(a.id, b.id))
  const expectedPaths = uniqueSorted(input.changedPaths)
  const dependencies = dependencyEdges(partitions, graph)
  const content = uniqueSorted(partitions.flatMap(partition => partition.readPaths)).map(path => ({ path, sha256: input.files.has(path) ? contentHash(Buffer.from(input.files.get(path)!, 'utf8')) : null, estimatedBytes: input.readByteSizes?.get(path) ?? null }))
  const governance = [...governanceNodes.values()].filter(node => node.sourceDigest)
    .map(node => ({ id: node.id, path: node.path, sha256: node.sourceDigest! })).sort((a, b) => compare(a.id, b.id) || compare(a.path, b.path))
  const digestShape = { version: 'sync-partitions-v1', plan: planFingerprint(input.plan), partitions, dependencies, expectedPaths, content, governance }
  return { version: 'sync-partitions-v1', partitions, dependencies, expectedPaths, digest: contentHash(canonical(digestShape)) }
}

/** 将全局计划收窄成一个分区；根意图保留为读取上下文，局部写权只来自全局授权交集。 */
export function projectSyncPartition(plan: SyncCoordinatorPlan, partition: SyncPartition): SyncCoordinatorPlan {
  const targets = plan.targets.filter(target => partition.targets.some(local => local.nodeId === target.nodeId && local.path === target.path))
  const targetPaths = new Set(targets.map(target => target.path))
  const readPaths = uniqueSorted(partition.readPaths.filter(path => coveredPath(path, plan.readPaths) || targetPaths.has(path)))
  const writePaths = uniqueSorted(partition.writePaths.filter(path => coveredPath(path, plan.writePaths) || targetPaths.has(path)))
  const sourcePaths = uniqueSorted(partition.sourcePaths.filter(path => coveredPath(path, plan.sourcePaths ?? [])))
  const mandatoryTests = plan.mandatoryTests.filter(test => readPaths.includes(test.testPath) || partition.changedPaths.includes(test.testPath))
  const localPathSet = new Set([...readPaths, ...partition.changedPaths, ...writePaths])
  const localIds = new Set([...partition.contractIds, ...partition.flowIds])
  const decisionAuthorities = (plan.decisionAuthorities ?? []).filter(authority =>
    authority.paths.some(path => localPathSet.has(path)) && [...authority.affectedIds, ...authority.ruleIds].some(id => localIds.has(id)))
  const decisionRefs = new Set(decisionAuthorities.map(authority => authority.requestRef.sha256))
  return {
    ...plan,
    intentNodeId: plan.intentNodeId,
    targets,
    readPaths,
    writePaths,
    sourcePaths,
    mandatoryTests,
    facts: plan.facts.filter(fact => !fact.source.startsWith('code:')
      || readPaths.some(path => relationClaimsPath(parseCodeEntry(fact.source.slice('code:'.length)).path, path))),
    authorizedChanges: plan.authorizedChanges?.filter(change => partition.contractIds.includes(change.id)),
    retiredIds: plan.retiredIds?.filter(id => localIds.has(id)),
    decisionAuthorities,
    decisionRefs: (plan.decisionRefs ?? []).filter(ref => decisionRefs.has(ref.sha256)),
    executionScope: plan.executionScope ? {
      paths: uniqueSorted(writePaths.filter(path => coveredPath(path, plan.executionScope!.paths))),
      contractIds: uniqueSorted(partition.contractIds.filter(id => plan.executionScope!.contractIds.includes(id))),
      flowIds: uniqueSorted(partition.flowIds.filter(id => plan.executionScope!.flowIds.includes(id))),
    } : undefined,
    newNodeRawSources: plan.newNodeRawSources?.filter(entry => targetPaths.has(entry.path)),
  }
}
