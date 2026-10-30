import { posix } from 'node:path'
import { parseCodeEntry, parseRelation, relationClaimsPath } from '@spexcode/spec-core'
import { buildContractGraph, contractReferences } from '@spexcode/spec-core/contracts'
import type { Contract, ContractGraph } from '@spexcode/spec-core/contracts'
import { contentHash } from './snapshot.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { coveredPath } from './settings.js'

const DEFAULT_READ_LIMIT_BYTES = 512 * 1024
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare)

export type SyncPartition = {
  id: string
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
  changedPaths: readonly string[]
  maxReadBytes?: number
  /** 按 path 提供 composed files 外、已由调用方去重的真实版本正文总字节估计。 */
  readByteSizes?: ReadonlyMap<string, number>
}

type Claim = { path: string; contract: Contract }
type Draft = { targetNodeIds: string[]; changedPaths: string[]; discoveryNodeIds: string[]; packingKey: string }
type Context = { readPaths: string[]; contextNodeIds: string[]; contractIds: string[]; flowIds: string[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort(compare).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function ownerNodesForPath(path: string, contracts: readonly Contract[]): Set<string> {
  const owners = new Set<string>()
  for (const contract of contracts) {
    if (parseRelation(contract.code, 'code').entries.some(entry => relationClaimsPath(entry.path, path))) owners.add(contract.nodeId)
    for (const item of contract.items) {
      if (item.kind === 'VERIFY') continue
      if (item.source.kind === 'code' && relationClaimsPath(parseCodeEntry(item.source.ref).path, path)) owners.add(contract.nodeId)
      if (item.kind === 'AC' && relationClaimsPath(parseCodeEntry(item.test).path, path)) owners.add(contract.nodeId)
    }
  }
  return owners
}

function closestNode(path: string, contracts: readonly Contract[], preferred: ReadonlySet<string>): string | undefined {
  const targetParts = posix.dirname(path).split('/').filter(Boolean)
  const candidates = contracts.flatMap(contract => parseRelation(contract.code, 'code').entries.map(entry => {
    const parts = posix.dirname(entry.path).split('/').filter(Boolean)
    let shared = 0
    while (shared < targetParts.length && shared < parts.length && targetParts[shared] === parts[shared]) shared++
    const preference = preferred.has(contract.nodeId) ? 1 : 0
    return { nodeId: contract.nodeId, shared, preference, distance: targetParts.length + parts.length - shared * 2 }
  })).sort((a, b) => b.preference - a.preference || b.shared - a.shared || a.distance - b.distance || compare(a.nodeId, b.nodeId))
  return candidates[0]?.nodeId
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
  contractsByPath: ReadonlyMap<string, Contract>,
  draft: Draft,
): Context {
  const writeNodeIds = new Set(draft.targetNodeIds)
  const initialNodeIds = new Set([...draft.targetNodeIds, ...draft.discoveryNodeIds])
  const relevantItems = new Set<string>()
  const relevantNodes = new Set(initialNodeIds)
  const claimNodeIds = new Set(draft.targetNodeIds)
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
      if (owner) { relevantNodes.add(owner.nodeId); claimNodeIds.add(owner.nodeId) }
      if (!relevantItems.has(reference.id)) { relevantItems.add(reference.id); pending.push(reference.id) }
    }
  }

  const localPaths = new Set<string>(draft.changedPaths)
  for (const target of input.plan.targets) if (writeNodeIds.has(target.nodeId)) localPaths.add(target.path)
  for (const itemId of relevantItems) {
    const item = graph.items.get(itemId)
    if (item) localPaths.add(item.path)
  }

  const pathContracts = new Map<string, Contract>()
  for (const contract of graph.contracts) if (relevantNodes.has(contract.nodeId)) pathContracts.set(contract.path, contract)
  const rawContextPaths = new Set<string>(localPaths)
  const contextNodes = new Set<string>(relevantNodes)
  for (const contract of pathContracts.values()) {
    let directory = posix.dirname(contract.path)
    while (directory !== '.' && directory !== '/') {
      const ancestorPath = posix.join(directory, 'spec.md')
      const ancestor = contractsByPath.get(ancestorPath)
      if (ancestor) contextNodes.add(ancestor.nodeId)
      if (ancestor || input.files.has(ancestorPath)) rawContextPaths.add(ancestorPath)
      const parent = posix.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const intent = (contractsByNode.get(input.plan.intentNodeId) ?? [])[0]
    ?? input.plan.targets.find(target => target.nodeId === input.plan.intentNodeId)
  if (intent) {
    const intentPath = intent.path
    rawContextPaths.add(intentPath)
    if (!writeNodeIds.has(input.plan.intentNodeId)) contextNodes.add(input.plan.intentNodeId)
    let directory = posix.dirname(intentPath)
    while (directory !== '.' && directory !== '/') {
      const ancestor = contractsByPath.get(posix.join(directory, 'spec.md'))
      const ancestorPath = posix.join(directory, 'spec.md')
      if (ancestor) contextNodes.add(ancestor.nodeId)
      if (ancestor || input.files.has(ancestorPath)) rawContextPaths.add(ancestorPath)
      const parent = posix.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const claims: Claim[] = []
  for (const nodeId of claimNodeIds) for (const contract of contractsByNode.get(nodeId) ?? []) {
    for (const entry of parseRelation(contract.code, 'code').entries) claims.push({ path: entry.path, contract })
    for (const entry of parseRelation(contract.related, 'related').entries) claims.push({ path: entry.path, contract })
    for (const item of contract.items) if (item.kind !== 'VERIFY') {
      if (item.source.kind === 'code') claims.push({ path: parseCodeEntry(item.source.ref).path, contract })
      if (item.kind === 'AC') claims.push({ path: parseCodeEntry(item.test).path, contract })
    }
  }
  addContractClaims(rawContextPaths, claims, input.files, new Set(draft.changedPaths))
  for (const mandatory of input.plan.mandatoryTests) {
    if (draft.changedPaths.includes(mandatory.testPath) || claims.some(claim => relationClaimsPath(claim.path, mandatory.testPath))) rawContextPaths.add(mandatory.testPath)
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
    const hash = body === undefined ? `missing:${path}` : contentHash(Buffer.from(body, 'utf8'))
    const bytes = Math.max(body === undefined ? 0 : Buffer.byteLength(body, 'utf8'), estimatedBytes ?? 0)
    const prior = bodies.get(hash)
    if (prior) { prior.bytes = Math.max(prior.bytes, bytes); prior.paths.push(path) }
    else bodies.set(hash, { bytes, paths: [path] })
  }
  const readBytes = [...bodies.values()].reduce((sum, body) => sum + body.bytes, 0)
  const oversizedReads = [...bodies.values()].filter(body => body.bytes > limitBytes).map(body => ({ path: [...body.paths].sort(compare)[0], bytes: body.bytes, limitBytes })).sort((a, b) => compare(a.path, b.path))
  return { readBytes, readLimitBytes: limitBytes, oversizedReads }
}

function contextBytes(input: PlanSyncPartitionsInput, graph: ContractGraph, contractsByNode: ReadonlyMap<string, Contract[]>, contractsByPath: ReadonlyMap<string, Contract>, draft: Draft, limitBytes: number): number {
  const context = contextFor(input, graph, contractsByNode, contractsByPath, draft)
  return readFootprint(context.readPaths, input.files, input.readByteSizes, limitBytes).readBytes
}

function partitionDrafts(input: PlanSyncPartitionsInput, contracts: readonly Contract[], graph: ContractGraph, limitBytes: number): Draft[] {
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
  const assigned = new Map<string, string[]>()
  const discoveries = new Map<string, Draft[]>()
  const preferred = new Set(targetByNode.keys())
  for (const path of changedPaths) {
    const owners = ownerNodesForPath(path, contracts)
    for (const target of targets) if (target.path === path) owners.add(target.nodeId)
    const writableOwners = [...owners].filter(nodeId => targetByNode.has(nodeId)).sort(compare)
    if (writableOwners.length) {
      for (const nodeId of writableOwners.slice(1)) union(writableOwners[0], nodeId)
      assigned.set(path, writableOwners)
      continue
    }
    const nearest = closestNode(path, contracts, preferred) ?? input.plan.intentNodeId
    const directory = posix.dirname(path)
    const key = `${directory}\0${nearest}`
    const groups = discoveries.get(key) ?? []
    groups.push({ targetNodeIds: [], changedPaths: [path], discoveryNodeIds: [nearest], packingKey: `discovery:${key}` })
    discoveries.set(key, groups)
  }

  const byRoot = new Map<string, Draft>()
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
    const targetDirs = uniqueSorted(draft.targetNodeIds.map(nodeId => posix.dirname(targetByNode.get(nodeId)!.path)))
    draft.packingKey = targetDirs.length === 1 ? `targets:${targetDirs[0]}` : `shared:${draft.targetNodeIds.join(',')}`
  }

  const contractsByNode = new Map<string, Contract[]>()
  const contractsByPath = new Map<string, Contract>()
  for (const contract of contracts) {
    const items = contractsByNode.get(contract.nodeId) ?? []
    items.push(contract)
    contractsByNode.set(contract.nodeId, items)
    contractsByPath.set(contract.path, contract)
  }
  const orderedDrafts = [...byRoot.values(), ...[...discoveries.values()].flat()].sort((a, b) => compare(a.packingKey, b.packingKey) || compare(a.changedPaths[0] ?? '', b.changedPaths[0] ?? ''))
  const packed: Draft[] = []
  const lastByKey = new Map<string, number>()
  for (const draft of orderedDrafts) {
    const currentBytes = contextBytes(input, graph, contractsByNode, contractsByPath, draft, limitBytes)
    const previousIndex = lastByKey.get(draft.packingKey)
    const packable = draft.packingKey.startsWith('targets:') || draft.packingKey.startsWith('discovery:')
    if (packable && previousIndex !== undefined && currentBytes <= limitBytes) {
      const previous = packed[previousIndex]
      const combined: Draft = {
        targetNodeIds: uniqueSorted([...previous.targetNodeIds, ...draft.targetNodeIds]),
        changedPaths: uniqueSorted([...previous.changedPaths, ...draft.changedPaths]),
        discoveryNodeIds: uniqueSorted([...previous.discoveryNodeIds, ...draft.discoveryNodeIds]),
        packingKey: draft.packingKey,
      }
      if (contextBytes(input, graph, contractsByNode, contractsByPath, combined, limitBytes) <= limitBytes) {
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

function projectedPartition(input: PlanSyncPartitionsInput, draft: Draft, context: Context, limitBytes: number): SyncPartition {
  const targets = input.plan.targets.filter(target => draft.targetNodeIds.includes(target.nodeId)).sort((a, b) => compare(a.path, b.path) || compare(a.nodeId, b.nodeId))
  const writePaths = uniqueSorted([
    ...draft.changedPaths.filter(path => coveredPath(path, input.plan.writePaths)),
    ...targets.map(target => target.path),
  ])
  const sourcePaths = uniqueSorted(draft.changedPaths.filter(path => coveredPath(path, input.plan.sourcePaths ?? [])))
  const contextNodes = new Set([...context.contextNodeIds, ...draft.discoveryNodeIds])
  const readPaths = uniqueSorted(context.readPaths)
  const read = readFootprint(readPaths, input.files, input.readByteSizes, limitBytes)
  const identity = { targets: targets.map(target => ({ nodeId: target.nodeId, path: target.path })), changedPaths: uniqueSorted(draft.changedPaths) }
  const id = `partition-${contentHash(canonical(identity)).slice(0, 16)}`
  return {
    id,
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
  const contractsByNode = new Map<string, Contract[]>(), contractsByPath = new Map<string, Contract>()
  for (const contract of contracts) {
    const nodeContracts = contractsByNode.get(contract.nodeId) ?? []
    nodeContracts.push(contract)
    contractsByNode.set(contract.nodeId, nodeContracts)
    contractsByPath.set(contract.path, contract)
  }
  const drafts = partitionDrafts(input, contracts, graph, limitBytes)
  const partitions = drafts.map(draft => projectedPartition(input, draft, contextFor(input, graph, contractsByNode, contractsByPath, draft), limitBytes))
    .sort((a, b) => compare(a.id, b.id))
  const expectedPaths = uniqueSorted(input.changedPaths)
  const dependencies = dependencyEdges(partitions, graph)
  const content = uniqueSorted(partitions.flatMap(partition => partition.readPaths)).map(path => ({ path, sha256: input.files.has(path) ? contentHash(Buffer.from(input.files.get(path)!, 'utf8')) : null, estimatedBytes: input.readByteSizes?.get(path) ?? null }))
  const digestShape = { version: 'sync-partitions-v1', plan: planFingerprint(input.plan), partitions, dependencies, expectedPaths, content }
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
    authorizedChanges: plan.authorizedChanges?.filter(change => partition.contractIds.includes(change.id)),
    retiredIds: plan.retiredIds?.filter(id => localIds.has(id)),
    decisionAuthorities,
    decisionRefs: (plan.decisionRefs ?? []).filter(ref => decisionRefs.has(ref.sha256)),
    executionScope: plan.executionScope ? {
      paths: uniqueSorted(plan.executionScope.paths.filter(path => writePaths.includes(path))),
      contractIds: uniqueSorted(partition.contractIds.filter(id => plan.executionScope!.contractIds.includes(id))),
      flowIds: uniqueSorted(partition.flowIds.filter(id => plan.executionScope!.flowIds.includes(id))),
    } : undefined,
    newNodeRawSources: plan.newNodeRawSources?.filter(entry => targetPaths.has(entry.path)),
  }
}
