import { contractReferences, parseContract, parseParts } from '@spexcode/spec-core/contracts'
import { analyzeCodeBehavior, deriveBehaviorAuthorization } from './code-behavior.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import { outputErrors } from './elaboration-schema.js'
import { elaborate, projectElaborationFlowReadiness, sealPartitionedElaboration } from './elaboration.js'
import type { Contract } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { Applicability, ElaborationInput, ElaborationResult, ElaborationRunner, ElaborationTrace, ElaborationSessionRequest } from './elaboration-types.js'
import { actualTreeDiff, verifyCandidate } from './candidate.js'
import type { CandidateChanges } from './candidate.js'
import { freezeGenerationCandidate, runGeneration } from './generation.js'
import type { GenerationInput, GenerationOptions, GenerationResult } from './generation-types.js'
import type { BlobRef } from './operation-types.js'
import { contentHash, readEvidence, validateRepositoryPath, verifySnapshot, writeEvidence } from './snapshot.js'
import { projectSyncPartition, rawOnlyInterfaceSeedEvidence } from './partitioning.js'
import { historicalOwnerPaths, historicalRetiredIds, obligationPaths, projectPriorContext } from './prior-context.js'
import type { RawOnlyInterfaceSeedDescendant, RawOnlyInterfaceSeedEvidence, SyncPartition, SyncPartitionPlan } from './partitioning.js'
import type { CodeBehaviorAnalysis, CodeBehaviorEvidence } from './writeback-types.js'

export type PartitionCheckpoints = { load<T>(key: string): T | null; save(key: string, value: unknown): BlobRef }
const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const reject = (message: string): never => { throw Object.assign(new Error(message), { code: 'partition_binding' }) }

function interfaceSeedPartitions(input: ElaborationInput, plan: SyncPartitionPlan): { seeds: Map<string, RawOnlyInterfaceSeedEvidence>; descendants: RawOnlyInterfaceSeedDescendant[] } {
  const sources = [...input.targets.filter((target): target is typeof target & { source: string } => target.source !== null), ...(input.context ?? [])]
  const files = new Map(input.files)
  for (const source of sources) files.set(source.path, source.source)
  const classificationInput = { files, sourcePaths: unique(plan.partitions.flatMap(partition => partition.sourcePaths)),
    contracts: sources.flatMap(source => parseContract(source).contract ?? []), targets: input.targets,
    nodes: sources.map(source => ({ id: source.nodeId, path: source.path, rawSource: parseParts(source.source)?.rawSource })),
  }
  const descendants = (input.analysis?.analysis.newNodes ?? []).flatMap(node => {
    const owners = plan.partitions.filter(partition => partition.sourcePaths.includes(node.codePath))
    if (!input.targets.some(target => target.nodeId === node.nodeId && target.path === node.path)) return []
    if (owners.length !== 1) reject(`新增归属必须精确属于唯一source partition: ${node.codePath}`)
    if (!input.analysis!.analysis.reviewPassed || contentHash(JSON.stringify(input.analysis!.analysis)) !== input.analysis!.ref.sha256) reject('新增后代接口分类缺少完整独审分析绑定')
    return [{ ...node, sourcePartitionId: owners[0].id, sourcePaths: owners[0].sourcePaths }]
  })
  const seeds = new Map<string, RawOnlyInterfaceSeedEvidence>()
  for (const partition of plan.partitions) {
    const target = partition.targets.length === 1 ? input.targets.find(target => target.nodeId === partition.targets[0].nodeId && target.path === partition.targets[0].path) : undefined
    const evidence = target && !partition.sourcePaths.length ? rawOnlyInterfaceSeedEvidence(classificationInput, target, descendants) : null
    if (partition.phase === 'interface_seed' && !evidence) reject(`冻结父接口分区缺少真实纯父证据: ${partition.id}`)
    if (evidence) seeds.set(partition.id, evidence)
  }
  return { seeds, descendants }
}

function partitionApplicability(results: readonly Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>[]): Applicability[] {
  return ELABORATION_BOUNDARIES.flatMap(boundary => {
    const entries = results.flatMap(result => result.rounds.at(-1)?.candidate?.applicability ?? []).filter(entry => entry.boundary === boundary)
    if (!entries.length) return []
    return [{ boundary, applies: entries.some(entry => entry.applies), basis: unique(entries.map(entry => entry.basis)).join('\n'), affectedIds: unique(entries.flatMap(entry => entry.affectedIds)) }]
  })
}

function interfaceOnlyParentPartitions(partitions: readonly SyncPartition[], contracts: readonly Contract[]): Set<string> {
  const sourceOwners = new Set(partitions.filter(partition => contracts.some(contract => contract.code.length && partition.targets.some(target => target.path === contract.path))).map(partition => partition.id))
  return new Set(partitions.filter(parent => {
    const owned = contracts.filter(contract => parent.targets.some(target => target.path === contract.path))
    if (!owned.length || owned.some(contract => contract.code.length || contract.items.some(item => !['REQ', 'RULE', 'GAP'].includes(item.kind)))) return false
    return parent.targets.some(target => {
      const prefix = target.path.slice(0, -'spec.md'.length)
      return partitions.some(child => child.id !== parent.id && sourceOwners.has(child.id) && child.targets.some(childTarget => childTarget.path.startsWith(prefix)))
    })
  }).map(partition => partition.id))
}

/** 预算与执行共享真实实施集合；纯接口父由P1及真实子owner/边证明，不派无源码的实现独审。 */
export function implementationPartitionSelection(plan: SyncPartitionPlan, contracts: readonly Contract[]): { interfaceParents: Set<string>; partitions: SyncPartition[]; dependencies: SyncPartitionPlan['dependencies'] } {
  const interfaceParents = interfaceOnlyParentPartitions(plan.partitions, contracts)
  return { interfaceParents, partitions: plan.partitions.filter(partition => !interfaceParents.has(partition.id)),
    dependencies: plan.dependencies.filter(edge => !interfaceParents.has(edge.from) || !interfaceParents.has(edge.to)),
  }
}

/** 小批调度只限制当前操作在途量；真实容量及原子预算仍由既有 runner/store 控制。 */
export async function mapSyncPartitions<T, R>(items: readonly T[], maxParallel: number, signal: AbortSignal | undefined, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) throw new TypeError('分区并发数必须是正整数')
  const results: R[] = new Array(items.length)
  let next = 0, failure: unknown, stopped = false
  await Promise.all(Array.from({ length: Math.min(maxParallel, items.length) }, async () => {
    while (!stopped && !signal?.aborted && next < items.length) {
      const index = next++
      try { results[index] = await run(items[index], index) }
      catch (error) { if (!stopped) failure = error; stopped = true }
    }
  }))
  if (stopped) throw failure
  if (signal?.aborted) throw Object.assign(new Error('分区执行已取消，不再派发新调用'), { code: 'cancelled' })
  return results
}

function distinct<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const seen = new Map<string, T>()
  for (const value of values) {
    const id = key(value), previous = seen.get(id)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(value)) reject(`分区${label}身份冲突: ${id}`)
    if (previous !== undefined && ['change', 'finding', 'target', 'newNode', 'resolution'].includes(label)) reject(`分区${label}重复: ${id}`)
    seen.set(id, value)
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value)
}

function independentTraces(traces: readonly ElaborationTrace[]): void {
  if (new Set(traces.map(trace => trace.sessionId)).size !== traces.length || new Set(traces.map(trace => trace.threadId)).size !== traces.length) reject('各分区构建和独审必须保持独立真实会话及线程')
}

export function partitionAnalysisEvidence(commonDir: string, analysis: CodeBehaviorEvidence | undefined, partitionId: string): CodeBehaviorEvidence | undefined {
  if (!analysis) return undefined
  const binding = analysis.analysis.partitionEvidence?.find(item => item.partitionId === partitionId)
  if (!binding) return analysis
  const local = JSON.parse(readEvidence(commonDir, binding.analysisRef).toString('utf8')) as CodeBehaviorAnalysis
  if (!local.reviewPassed || contentHash(JSON.stringify(local)) !== binding.analysisRef.sha256) reject('分区分析原件没有完整独审绑定')
  return { ref: binding.analysisRef, analysis: local }
}

/** 每区独立分析及独审，程序只合并真实原件，不合成一次不存在的全局模型审查。 */
export async function analyzeSyncPartitions(input: CodeBehaviorInput, plan: SyncPartitionPlan, maxParallel: number, runner: ElaborationRunner, checkpoints: PartitionCheckpoints): Promise<CodeBehaviorAnalysis> {
  const { signal, ...data } = input
  input = { ...structuredClone(data), signal }; plan = structuredClone(plan)
  const analyses = await mapSyncPartitions(plan.partitions, maxParallel, input.signal, async partition => {
    const key = `partition:${partition.id}:analysis`
    const saved = checkpoints.load<CodeBehaviorAnalysis>(key)
    if (saved) return saved
    const local = await analyzeCodeBehavior({ ...input, requestKey: `${input.requestKey}:partition:${partition.id}`, plan: projectSyncPartition(input.plan, partition), partition: { id: partition.id, changedPaths: partition.changedPaths, factSourcePaths: unique(partition.writePaths.filter(path => !path.startsWith('.spec/'))) } }, runner)
    if (local.changes.some(change => change.paths.some(path => !partition.changedPaths.includes(path)))) reject(`分析超出本区真实变更集合: ${partition.id}`)
    checkpoints.save(key, local)
    return local
  })
  if (plan.expectedPaths.some(path => plan.partitions.filter(partition => partition.changedPaths.includes(path)).length !== 1) || analyses.some(analysis => !analysis.reviewPassed)) reject('分区并集未唯一覆盖完整变更集合或缺少独审')
  independentTraces(analyses.flatMap(analysis => analysis.traces))
  const first = analyses[0]
  if (!first) reject('分区计划为空')
  const merged: CodeBehaviorAnalysis = { ...first,
    inputDigest: contentHash(JSON.stringify({ partitionPlanDigest: plan.digest, inputs: analyses.map(item => item.inputDigest) })),
    authorChanges: distinct(analyses.flatMap(item => item.authorChanges ?? []), item => item.path, 'author'),
    rawIntegrations: distinct(analyses.flatMap(item => item.rawIntegrations ?? []), item => item.path, 'raw'),
    changes: distinct(analyses.flatMap(item => item.changes), item => item.id, 'change'),
    findings: distinct(analyses.flatMap(item => item.findings), item => item.id, 'finding'),
    facts: distinct(analyses.flatMap(item => item.facts), item => item.source, 'fact'),
    authorizedChanges: distinct(analyses.flatMap(item => item.authorizedChanges), item => item.id, 'authorization'),
    nodeChanges: distinct(analyses.flatMap(item => item.nodeChanges), item => item.from.path, 'lifecycle'),
    newNodes: distinct(analyses.flatMap(item => item.newNodes), item => item.path, 'newNode'),
    resolutions: distinct(analyses.flatMap(item => item.resolutions), item => item.path, 'resolution'),
    decisionAuthorities: distinct(analyses.flatMap(item => item.decisionAuthorities ?? []), item => item.requestRef.sha256, 'authority'),
    traces: analyses.flatMap(item => item.traces), reviewPassed: true,
    partitionCoverage: { planDigest: plan.digest, partitionIds: plan.partitions.map(partition => partition.id), changedPaths: [...plan.expectedPaths] },
    partitionEvidence: analyses.map((analysis, index) => ({ analysis, partitionId: plan.partitions[index].id, changedPaths: [...plan.partitions[index].changedPaths], analysisRef: writeEvidence(input.snapshot.source.commonDir, analysis) })),
  }
  return merged
}

/** 纯父按祖先层级先审自身原意接口；叶继承只读接口，新归属按真实 codePath 唯一分区。 */
export async function elaborateSyncPartitions(input: ElaborationInput, plan: SyncPartitionPlan, maxParallel: number, checkpoints: PartitionCheckpoints, runner: ElaborationRunner): Promise<ElaborationResult> {
  const { signal, ...data } = input
  input = { ...structuredClone(data), signal }; plan = structuredClone(plan)
  const commonDir = input.historyInput!.source.commonDir
  const { seeds, descendants } = interfaceSeedPartitions(input, plan)
  const settledSources = new Map<string, string>()
  const run = async (partition: SyncPartition): Promise<Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>> => {
    const interfaceSeed = seeds.get(partition.id)
    const partitionBinding = { planDigest: plan.digest, partitionId: partition.id, ...(input.analysis ? { analysisRef: input.analysis.ref } : {}), ...(interfaceSeed ? { interfaceSeed } : {}) }
    const key = `partition:${partition.id}:elaboration`, saved = checkpoints.load<Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>>(key)
    if (saved) {
      if (JSON.stringify(saved.partitionBinding) !== JSON.stringify(partitionBinding)) reject(`局部细化原件没有绑定当前分区分类: ${partition.id}`)
      return saved
    }
    const analysis = partitionAnalysisEvidence(commonDir, input.analysis, partition.id)
    const newPaths = descendants.filter(node => node.sourcePartitionId === partition.id).map(node => node.path)
    const targets = input.targets.filter(target => partition.targets.some(local => local.path === target.path || input.nodeChanges?.some(change => change.action === 'move' && change.from.path === target.path && change.to.path === local.path)) || newPaths.includes(target.path))
    if (!targets.length) reject(`分区缺少可写细化目标: ${partition.id}`)
    const readPaths = unique([...partition.readPaths, ...targets.map(target => target.path)])
    const sources = [...input.targets.filter((target): target is typeof target & { source: string } => target.source !== null), ...(input.context ?? [])].map(source => ({ ...source, source: settledSources.get(source.path) ?? source.source }))
    const context = sources.filter(source => within(source.path, readPaths) && !targets.some(target => target.path === source.path))
    const ids = new Set([...targets, ...context].flatMap(source => source.source ? parseContract({ nodeId: source.nodeId, path: source.path, source: source.source }).contract?.items.map(item => item.id) ?? [] : []))
    const seedTarget = interfaceSeed ? targets[0] : undefined
    const intent = seedTarget && seedTarget.nodeId !== input.intent.nodeId ? { nodeId: seedTarget.nodeId, rawSource: parseParts(seedTarget.source ?? '')?.rawSource ?? seedTarget.rawSource! } : input.intent
    const localInput: ElaborationInput = { ...input, requestKey: `${input.requestKey}:partition:${partition.id}`, intent, targets, context,
      partitionBinding,
      files: new Map([...input.files ?? []].filter(([path]) => within(path, readPaths)).map(([path, source]) => [path, settledSources.get(path) ?? source])), analysis,
      validationScope: 'partition_local',
      facts: [...input.facts ?? []].filter(fact => (!fact.source.startsWith('code:') || within(fact.source.slice(5).split('#')[0], readPaths)) && (!fact.source.startsWith('derived:') || ids.has(fact.source.slice(8)))),
      nodeChanges: input.nodeChanges?.filter(change => targets.some(target => target.path === change.from.path)),
      authorizedChanges: [...(input.authorizedChanges ?? []).filter(change => !analysis?.analysis.authorizedChanges.some(local => local.id === change.id) && (change.action === 'restore' || ids.has(change.id))), ...(analysis ? deriveBehaviorAuthorization(analysis.analysis, analysis.ref) : [])],
      implementationWritePaths: input.implementationWritePaths?.length === 0 ? [] : partition.writePaths, readonlyTestPaths: input.readonlyTestPaths?.filter(path => within(path, readPaths)),
      phase: interfaceSeed ? 'interface_seed' : undefined,
    }
    const result = await elaborate(localInput, { runner })
    const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = result
    checkpoints.save(key, compact)
    return compact
  }
  const byPartition = new Map<string, Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>>()
  let pending = plan.partitions.filter(partition => seeds.has(partition.id))
  while (pending.length) {
    const layer = pending.filter(partition => !pending.some(ancestor => ancestor.id !== partition.id && seeds.get(partition.id)!.parentPath.startsWith(seeds.get(ancestor.id)!.parentPath.slice(0, -'spec.md'.length))))
    const results = await mapSyncPartitions(layer, maxParallel, input.signal, run)
    for (let index = 0; index < layer.length; index++) {
      const partition = layer[index], result = results[index]
      byPartition.set(partition.id, result)
      if (!result.structurePassed || !result.reviewPassed) return { ...result, contracts: [], graph: null, coverage: null, partitionEvidence: [{ partitionId: partition.id, resultRef: writeEvidence(commonDir, result) }] }
      for (const change of result.changes) settledSources.set(change.path, change.source)
    }
    pending = pending.filter(partition => !byPartition.has(partition.id))
  }
  const remaining = plan.partitions.filter(partition => !byPartition.has(partition.id))
  const parallel = await mapSyncPartitions(remaining, maxParallel, input.signal, run)
  for (let index = 0; index < remaining.length; index++) byPartition.set(remaining[index].id, parallel[index])
  const results = plan.partitions.map(partition => byPartition.get(partition.id)!)
  const first = results[0]
  if (!first) reject('分区细化结果为空')
  independentTraces(results.flatMap(result => result.rounds.flatMap(round => round.traces)))
  const changes = distinct(results.flatMap(result => result.changes), change => change.path, 'target')
  const candidateChanges = changes.map(({ contentDigest: _contentDigest, ...change }) => change)
  const applicability = partitionApplicability(results)
  const seal = sealPartitionedElaboration(input, candidateChanges, applicability)
  const readiness = seal.seal.passed ? projectElaborationFlowReadiness(seal.graph, seal.coverage) : { readyFlowIds: [], blockedFlows: [] }
  const gaps = seal.contracts.flatMap(contract => contract.items.filter((item): item is import('@spexcode/spec-core/contracts').Gap => item.kind === 'GAP'))
  const localStructurePassed = results.every(result => result.structurePassed)
  const reviewPassed = results.every(result => result.reviewPassed)
  const structurePassed = localStructurePassed && seal.seal.passed
  const status = !structurePassed || !reviewPassed
    ? results.find(result => !result.structurePassed || !result.reviewPassed)?.status ?? 'failed'
    : gaps.some(gap => gap.gapKind === 'conflict') ? 'conflict' : gaps.length ? 'needs_input' : 'complete'
  const failure = results.find(result => result.failure)?.failure ?? (!seal.seal.passed ? { code: 'partition_final_seal_failed', message: JSON.stringify(seal.seal.findings.map(({ code, itemId, message }) => ({ code, itemId, message }))) } : null)
  const compact = { ...first, partitionBinding: undefined, phase: 'partitioned_final' as const, inputDigest: contentHash(JSON.stringify({ partitionPlanDigest: plan.digest, inputs: results.map(result => result.inputDigest) })), candidateDigest: seal.seal.candidateDigest, changes,
    readyIds: structurePassed ? seal.coverage.items.filter(item => item.blockedBy.length === 0 && item.kind !== 'GAP').map(item => item.id) : [], readyFlowIds: readiness.readyFlowIds,
    blockedIds: seal.coverage.items.filter(item => item.blockedBy.length > 0).map(item => item.id), blockedFlows: readiness.blockedFlows,
    retiredIds: unique([...results.flatMap(result => result.retiredIds), ...seal.resolvedGapIds]), nodeChanges: [...input.nodeChanges ?? []],
    gaps, rounds: results.flatMap(result => result.rounds),
    deferredImplementationFindings: results.flatMap(result => result.deferredImplementationFindings), blockedStructureFindings: results.flatMap(result => result.blockedStructureFindings),
    structurePassed, reviewPassed, status, failure,
    contracts: seal.contracts, graph: seal.graph, coverage: seal.coverage, partitionSeal: seal.seal,
    partitionEvidence: results.map((result, index) => ({ partitionId: plan.partitions[index].id, resultRef: writeEvidence(commonDir, result) })),
  }
  return compact
}

/** P1新身份与实际依赖完成后冻结候选审查覆盖；沿用原分区身份及原独审原件。 */
export function completeSyncPartitionPlan(plan: SyncPartitionPlan, contracts: readonly Contract[], files: ReadonlyMap<string, string>, authorization: { writePaths: readonly string[]; readonlyPaths: readonly string[] }, analysis?: CodeBehaviorEvidence): SyncPartitionPlan {
  const partitions = plan.partitions.map(partition => {
    const added = analysis?.analysis.newNodes.filter(node => within(node.codePath, partition.sourcePaths)).map(node => ({ nodeId: node.nodeId, path: node.path, rawSource: node.rawSource })) ?? []
    const targets = [...partition.targets, ...added]
    const owned = contracts.filter(contract => targets.some(target => target.path === contract.path))
    const approvedWrites = owned.flatMap(contract => [...contract.code, ...contract.items.flatMap(item => item.kind === 'AC' ? [item.test] : [])]).map(anchor => anchor.split('#')[0]).filter(path => within(path, authorization.writePaths) && !authorization.readonlyPaths.some(oracle => within(path, [oracle]) || within(oracle, [path])))
    const readPaths = new Set([...partition.readPaths, ...targets.map(target => target.path)])
    for (const contract of owned) {
      for (const anchor of [...contract.code, ...contract.related]) readPaths.add(anchor.split('#')[0])
      for (const item of contract.items) { if (item.kind === 'AC') readPaths.add(item.test.split('#')[0]); if (item.kind !== 'VERIFY' && item.source.kind === 'code') readPaths.add(item.source.ref.split('#')[0]) }
    }
    const needed = new Set(owned.flatMap(contract => contract.items.flatMap(item => contractReferences(item).map(ref => ref.id))))
    let changed = true
    while (changed) { changed = false; for (const contract of contracts) if (contract.items.some(item => needed.has(item.id))) {
      if (!readPaths.has(contract.path)) { readPaths.add(contract.path); changed = true }
      for (const item of contract.items) for (const ref of contractReferences(item)) if (!needed.has(ref.id)) { needed.add(ref.id); changed = true }
    } }
    const bodies = new Map<string, number>()
    for (const [path, source] of files) if (within(path, [...readPaths])) bodies.set(contentHash(source), Buffer.byteLength(source))
    return { ...partition, targets, readPaths: [...readPaths].sort(), writePaths: unique([...partition.writePaths, ...added.map(target => target.path), ...approvedWrites]), readBytes: [...bodies.values()].reduce((sum, size) => sum + size, 0) }
  })
  const owner = new Map<string, string>()
  for (const partition of partitions) for (const contract of contracts.filter(contract => partition.targets.some(target => target.path === contract.path))) for (const item of contract.items) {
    if (owner.has(item.id)) reject(`业务身份存在多个分区writer: ${item.id}`)
    owner.set(item.id, partition.id)
  }
  const dependencies = new Map(plan.dependencies.map(edge => [`${edge.from}\0${edge.to}`, { ...edge, contractIds: [...edge.contractIds], paths: [...edge.paths] }]))
  for (const contract of contracts) for (const item of contract.items) for (const ref of contractReferences(item)) {
    const from = owner.get(item.id), to = owner.get(ref.id)
    if (!from || !to || from === to) continue
    const key = `${from}\0${to}`, edge = dependencies.get(key) ?? { from, to, contractIds: [], paths: [] }
    edge.contractIds = unique([...edge.contractIds, item.id, ref.id]); edge.paths = unique([...edge.paths, contract.path, ...contracts.filter(candidate => candidate.items.some(candidate => candidate.id === ref.id)).map(candidate => candidate.path)])
    dependencies.set(key, edge)
  }
  const completed = { ...plan, partitions, dependencies: [...dependencies.values()].sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)) }
  return { ...completed, digest: contentHash(JSON.stringify({ parentPlanDigest: plan.digest, ...completed, digest: undefined })) }
}

function localGeneration(input: GenerationInput, partition: SyncPartition, commonDir: string): GenerationInput {
  const lifecyclePaths = input.nodeChanges?.filter(change => partition.targets.some(target => target.path === change.from.path || change.action === 'move' && target.path === change.to.path)).map(change => change.from.path) ?? []
  const oldTests = input.existingAcceptance.filter(item => partition.targets.some(target => target.path === item.path) || lifecyclePaths.includes(item.path)).map(item => item.test.split('#')[0])
  const readPaths = unique([...partition.readPaths, ...lifecyclePaths, ...oldTests, ...input.elaboratedSpecs.filter(spec => partition.targets.some(target => target.path === spec.path) || input.analysis?.analysis.newNodes.some(node => node.path === spec.path && partition.sourcePaths.includes(node.codePath))).map(spec => spec.path)])
  const ownerPaths = historicalOwnerPaths(input, partition.targets)
  const priorPaths = new Set(readPaths)
  for (const prior of input.priorContext ?? []) for (const ownerPath of ownerPaths) {
    const source = prior.files.get(ownerPath)
    if (!source) continue
    const actualPaths = [...prior.entries.map(entry => entry.path), ...prior.objects.map(object => object.entry.path)]
    for (const path of obligationPaths(source, ownerPath, actualPaths)) priorPaths.add(path)
  }
  const files = new Map([...input.files].filter(([path]) => within(path, readPaths)))
  const contracts = input.contracts.filter(contract => within(contract.path, readPaths))
  const owned = new Set([...partition.contractIds, ...partition.flowIds, ...contracts.filter(contract => partition.targets.some(target => target.path === contract.path) || input.analysis?.analysis.newNodes.some(node => node.path === contract.path && partition.sourcePaths.includes(node.codePath))).flatMap(contract => contract.items.map(item => item.id)), ...historicalRetiredIds(input, partition.targets)])
  const ownedSpecPaths = new Set([...partition.targets.map(target => target.path), ...input.nodeChanges?.filter(change => lifecyclePaths.includes(change.from.path)).flatMap(change => change.action === 'move' ? [change.from.path, change.to.path] : [change.from.path]) ?? [], ...input.elaboratedSpecs.filter(spec => input.analysis?.analysis.newNodes.some(node => node.path === spec.path && partition.sourcePaths.includes(node.codePath))).map(spec => spec.path)])
  const writablePaths = unique([...partition.writePaths.filter(path => within(path, input.allowedScope.paths)), ...input.allowedScope.paths.filter(path => within(path, partition.writePaths))])
  return { ...input, requestKey: `${input.requestKey}:partition:${partition.id}`, files, contracts, priorContext: projectPriorContext(input.priorContext, [...priorPaths]), readonlyContractPaths: contracts.filter(contract => !partition.targets.some(target => target.path === contract.path)).map(contract => contract.path),
    readyIds: input.readyIds.filter(id => owned.has(id)), blockedIds: input.blockedIds.filter(id => owned.has(id)),
    retiredIds: input.retiredIds?.filter(id => owned.has(id)), retiredOwners: input.retiredOwners?.filter(item => owned.has(item.id)),
    elaboratedSpecs: input.elaboratedSpecs.filter(spec => partition.targets.some(target => target.path === spec.path) || input.analysis?.analysis.newNodes.some(node => node.path === spec.path && partition.sourcePaths.includes(node.codePath))),
    analysis: partitionAnalysisEvidence(commonDir, input.analysis, partition.id),
    facts: input.facts.filter(fact => (!fact.source.startsWith('code:') || within(fact.source.slice(5).split('#')[0], readPaths)) && (!fact.source.startsWith('derived:') || contracts.some(contract => contract.items.some(item => item.id === fact.source.slice(8))))),
    existingAcceptance: input.existingAcceptance.filter(item => within(item.path, readPaths)),
    mandatoryTests: input.mandatoryTests.filter(test => within(test.testPath, readPaths)),
    nodeChanges: input.nodeChanges?.filter(change => partition.targets.some(target => target.path === change.from.path || change.action === 'move' && target.path === change.to.path)),
    allowedScope: { paths: writablePaths.filter(path => path !== '.spec' && !path.startsWith('.spec/') || ownedSpecPaths.has(path)), contractIds: input.allowedScope.contractIds.filter(id => owned.has(id)), flowIds: input.allowedScope.flowIds.filter(id => owned.has(id)) },
  }
}

type LocalGeneration = { partition: SyncPartition; input: GenerationInput }
export const IMPLEMENTATION_PLAN_SCHEMA: Record<string, unknown> = { type: 'object', additionalProperties: false, required: ['version', 'paths'], properties: { version: { type: 'string', enum: ['sync-implementation-plan-v1'] }, paths: { type: 'array', items: { type: 'string', minLength: 1 } } } }
type FileWriterPlan = { version: 'sync-file-writers-v1'; writers: { partitionId: string; paths: string[] }[]; traces: ElaborationTrace[] }

export function implementationPlanningPartitions(partitions: readonly SyncPartition[], contracts: readonly Contract[], nodeChanges: GenerationInput['nodeChanges'] = []): string[] {
  return partitions.filter(partition => {
    const ownsSource = contracts.some(contract => contract.code.length && partition.targets.some(target => target.path === contract.path))
    const parentOnly = partition.targets.some(target => partitions.some(other => other.id !== partition.id && other.targets.some(child => child.path.startsWith(`${target.path.slice(0, -'spec.md'.length)}`))))
    const retiredOnly = partition.targets.length > 0 && partition.targets.every(target => nodeChanges?.some(change => change.action === 'retire' && change.from.path === target.path))
    return !ownsSource && !parentOnly && !retiredOnly
  }).map(partition => partition.id)
}

async function implementationFileWriters(input: GenerationInput, locals: readonly LocalGeneration[], plan: SyncPartitionPlan, maxParallel: number, options: GenerationOptions, checkpoints: PartitionCheckpoints): Promise<FileWriterPlan> {
  const owner = new Map<string, string>()
  for (const local of locals) for (const path of local.input.allowedScope.paths) {
    if ([...owner].some(([owned, id]) => id !== local.partition.id && (within(path, [owned]) || within(owned, [path])))) throw Object.assign(new Error(`P1分区争用实现writer: ${path}; 需要互不重叠的文件规划`), { code: 'implementation_plan_conflict' })
    owner.set(path, local.partition.id)
  }
  const saved = checkpoints.load<FileWriterPlan>('file-writer-plan')
  if (saved) return saved
  const needs = new Set(implementationPlanningPartitions(plan.partitions, input.contracts, input.nodeChanges))
  const proposed = await mapSyncPartitions(locals.filter(local => needs.has(local.partition.id)), maxParallel, input.signal, async local => {
    const key = `partition:${local.partition.id}:implementation-plan`, prior = checkpoints.load<{ paths: string[]; trace: ElaborationTrace }>(key)
    if (prior) return { partitionId: local.partition.id, ...prior }
    const policy = options.implementationPolicy
    if (!policy) return reject('新功能分区缺少冻结的实现文件规划授权')
    const context = { partitionId: local.partition.id, inputId: input.snapshot.id, policy: input.policy, intent: local.input.intent, specs: local.input.elaboratedSpecs, contracts: local.input.contracts, facts: local.input.facts, files: [...local.input.files], authorizedWritePaths: policy.writePaths.filter(path => !path.startsWith('.spec/')), sourcePaths: policy.sourcePaths, readonlyTests: local.input.mandatoryTests, repairContext: input.repairContext }
    const inputDigest = contentHash(JSON.stringify(context)), purpose = 'implementation_plan'
    if (input.signal?.aborted) throw Object.assign(new Error('文件规划已取消'), { code: 'cancelled' })
    const request: ElaborationSessionRequest = { root: input.root, base: input.snapshot.headCommit, requestKey: `${input.requestKey}:partition:${local.partition.id}:${purpose}`, purpose, inputDigest, prompt: `只规划本区已批准需求所需的精确源码/测试文件路径，不返回正文、不新增业务、政策或Spec目标。新文件只能在authorizedWritePaths中；已有文件必须已在本区files完整读取，readonlyTests不可改。不能选目录、通配符或其它区的Spec；优先复用本区已有实现。若本区没有实现/测试变更可返回空paths。只返回schema JSON。\n冻结局部输入:\n${JSON.stringify(context)}`, schema: structuredClone(IMPLEMENTATION_PLAN_SCHEMA), timeoutMs: input.timeoutMs, signal: input.signal, model: input.model, effort: input.effort }
    const { signal: dispatchSignal, ...serializable } = request
    await options.onDispatch?.({ ...structuredClone(serializable), signal: dispatchSignal })
    if (input.signal?.aborted) throw Object.assign(new Error('文件规划已取消'), { code: 'cancelled' })
    const native = await options.runner(request)
    if (input.signal?.aborted) throw Object.assign(new Error('文件规划结果已取消'), { code: 'cancelled' })
    const output = structuredClone(native.output)
    if (!native.sessionId || !native.threadId || !native.turnId || native.resultDigest !== contentHash(JSON.stringify(output)) || outputErrors(output, IMPLEMENTATION_PLAN_SCHEMA).length) reject('实现文件计划的schema/native身份/摘要不合法')
    const paths = (output as { paths: string[] }).paths
    if (new Set(paths).size !== paths.length) reject('实现文件计划不能重复路径')
    for (const path of paths) {
      validateRepositoryPath(path)
      if (path.startsWith('.spec/') || /[*?\[\]]/.test(path) || !within(path, policy.writePaths) || input.mandatoryTests.some(test => path === test.testPath) || input.manifest.entries.some(entry => entry.path.startsWith(`${path}/`)) || input.manifest.entries.some(entry => entry.path === path) && !local.input.files.has(path)) reject(`实现文件计划越过本区完整读取或原授权: ${path}`)
    }
    const result = { paths: [...paths].sort(), trace: { purpose, sessionId: native.sessionId, threadId: native.threadId, turnId: native.turnId, resultDigest: native.resultDigest, inputDigest } }
    checkpoints.save(key, result)
    return { partitionId: local.partition.id, ...result }
  })
  for (const proposal of proposed) for (const path of proposal.paths) {
    if ([...owner].some(([owned, id]) => id !== proposal.partitionId && (within(path, [owned]) || within(owned, [path])))) throw Object.assign(new Error(`多个分区提出同一实现writer: ${path}; 请在原预算内规划互不重叠的对应模块文件`), { code: 'implementation_plan_conflict' })
    owner.set(path, proposal.partitionId)
  }
  const result: FileWriterPlan = { version: 'sync-file-writers-v1', writers: proposed.map(({ partitionId, paths }) => ({ partitionId, paths })), traces: proposed.map(proposal => proposal.trace) }
  checkpoints.save('file-writer-plan', result)
  return result
}

/** 各区只构建结构化补丁，唯一写者/CAS核验后一次冻结，再按区及跨区边独审同一树。 */
export async function generateSyncPartitions(input: GenerationInput, plan: SyncPartitionPlan, maxParallel: number, specOnly: boolean, options: GenerationOptions, checkpoints: PartitionCheckpoints): Promise<GenerationResult> {
  const { signal, ...data } = input
  input = { ...structuredClone(data), signal }; plan = structuredClone(plan)
  const commonDir = input.snapshot.source.commonDir
  let generationPartitions = [...plan.partitions]
  let selection = implementationPartitionSelection(plan, input.contracts)
  const interfaceParents = selection.interfaceParents
  let locals = selection.partitions.map(partition => ({ partition, input: localGeneration(input, partition, commonDir) })).filter(local => local.input.readyIds.length)
  let planned: FileWriterPlan = { version: 'sync-file-writers-v1', writers: [], traces: [] }
  try {
    if (!specOnly) planned = await implementationFileWriters(input, locals, plan, maxParallel, options, checkpoints)
    const plannedPaths = unique(planned.writers.flatMap(writer => writer.paths))
    const authorization = await options.beforePartitionGeneration?.(plannedPaths, writeEvidence(commonDir, planned))
    if (authorization) { input = { ...input, allowedScope: authorization.scope, composed: authorization.composed ?? input.composed } }
    generationPartitions = generationPartitions.map(partition => { const paths = planned.writers.find(writer => writer.partitionId === partition.id)?.paths ?? []; return { ...partition, readPaths: unique([...partition.readPaths, ...paths]), writePaths: unique([...partition.writePaths, ...paths]), sourcePaths: unique([...partition.sourcePaths, ...paths.filter(path => within(path, options.implementationPolicy?.sourcePaths ?? []))]) } })
    selection = implementationPartitionSelection({ ...plan, partitions: generationPartitions }, input.contracts)
    locals = selection.partitions.map(partition => ({ partition, input: localGeneration(input, partition, commonDir) })).filter(local => local.input.readyIds.length)
  } catch (error) {
    const cause = error as { code?: string; message?: string }
    return { status: input.signal?.aborted ? 'cancelled' : 'repair', inputId: input.snapshot.id, inputDigest: '', candidate: null, candidateFiles: null, output: planned, reviewOutput: null, review: null, validationFindings: [], traces: planned.traces, candidateValidated: false, reviewPassed: false, runtimeVerification: 'not_run', delivery: 'not_applied', failure: { code: cause.code ?? 'implementation_plan_invalid', message: cause.message ?? String(error) } }
  }
  const prepared = specOnly ? [] : await mapSyncPartitions(locals, maxParallel, input.signal, async local => {
    const key = `partition:${local.partition.id}:generation`, saved = checkpoints.load<GenerationResult>(key)
    if (saved) return saved
    const result = await runGeneration(local.input, { ...options, beforeFreezeCandidate: undefined, prepareOnly: true })
    if (result.status === 'prepared') for (const change of result.preparedChanges!.changes) {
      if (!within(change.path, local.input.allowedScope.paths) || change.beforeDigest !== null && !local.input.files.has(change.path)) reject(`分区补丁越过读取/写入范围: ${change.path}`)
      if (change.path.startsWith('.spec/') && !local.input.elaboratedSpecs.some(spec => spec.path === change.path) && !local.input.nodeChanges?.some(item => item.from.path === change.path || item.action === 'move' && item.to.path === change.path)) reject(`分区不能改写只读Spec: ${change.path}`)
    }
    const { candidateFiles: _files, ...compact } = result
    checkpoints.save(key, compact)
    return compact
  })
  const failed = prepared.find(result => result.status !== 'prepared')
  if (failed) return { ...failed, candidateFiles: null }
  const interfaceSpecChanges = input.elaboratedSpecs.filter(spec => interfaceParents.has(generationPartitions.find(partition => partition.targets.some(target => target.path === spec.path))?.id ?? '') && input.files.get(spec.path) !== spec.source).map(spec => {
    const before = input.manifest.entries.find(entry => entry.path === spec.path)
    return { path: spec.path, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content: spec.source, mode: null }
  })
  const changes: CandidateChanges['changes'] = specOnly
    ? input.elaboratedSpecs.filter(spec => input.files.get(spec.path) !== spec.source).map(spec => { const before = input.manifest.entries.find(entry => entry.path === spec.path); return { path: spec.path, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content: spec.source, mode: null } })
    : [...prepared.flatMap(result => result.preparedChanges!.changes), ...interfaceSpecChanges]
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.path)) reject(`候选文件存在多个写者: ${change.path}`)
    seen.add(change.path)
    if (specOnly && (!change.path.startsWith('.spec/') || !change.path.endsWith('/spec.md'))) reject('代码到Spec方向不得修改代码或测试')
    if (input.mandatoryTests.some(test => test.testPath === change.path)) reject(`禁止改写独立oracle: ${change.path}`)
  }
  let candidate = checkpoints.load<NonNullable<GenerationResult['candidate']>>('partition:candidate')
  if (!candidate) { candidate = await freezeGenerationCandidate(input, { version: 'sync-files-v1', changes: changes.sort((a, b) => a.path.localeCompare(b.path)) }, options); checkpoints.save('partition:candidate', candidate) }
  if (specOnly && actualTreeDiff(verifySnapshot(input.snapshot), verifyCandidate(commonDir, candidate)).some(change => !input.elaboratedSpecs.some(spec => spec.path === change.path))) reject('代码提交方向只能替换本次已审Spec；组合基树改变其它真实source/tests或配置时先结算冲突，禁止反向写代码或测试')
  const validationFindings = [...await options.validateCandidate(candidate)]
  const builders = [...planned.traces, ...prepared.flatMap(result => result.traces)]
  const base: GenerationResult = { fileWriterPlanRef: writeEvidence(commonDir, planned), status: 'repair', inputId: input.snapshot.id, inputDigest: contentHash(JSON.stringify({ partitionPlanDigest: plan.digest, candidateDigest: candidate.digest })), candidate, candidateFiles: null, output: { version: 'sync-files-v1', changes }, reviewOutput: null, review: null, validationFindings, traces: builders, candidateValidated: false, reviewPassed: false, runtimeVerification: 'not_run', delivery: 'not_applied', failure: null }
  if (validationFindings.some(finding => finding.severity === 'error')) return base
  base.candidateValidated = true
  const reviews = [...locals.map(local => ({ id: local.partition.id, input: local.input })), ...selection.dependencies.map((edge, index) => {
    const endpoints = generationPartitions.filter(partition => [edge.from, edge.to].includes(partition.id))
    const paths = unique(endpoints.flatMap(partition => partition.readPaths)), targets = endpoints.flatMap(partition => partition.targets)
    const combined = { ...endpoints[0], id: `edge-${index}`, readPaths: paths, writePaths: unique(endpoints.flatMap(partition => partition.writePaths)), sourcePaths: unique(endpoints.flatMap(partition => partition.sourcePaths)), targets }
    const projected = { ...localGeneration(input, combined, commonDir), analysisEvidence: endpoints.flatMap(partition => { const evidence = partitionAnalysisEvidence(commonDir, input.analysis, partition.id); return evidence ? [evidence] : [] }) }
    return { id: `edge:${edge.from}:${edge.to}`, input: { ...projected, readyIds: input.readyIds.filter(id => edge.contractIds.includes(id) || projected.retiredIds?.includes(id)) } }
  })].filter(local => local.input.readyIds.length)
  const checked = await mapSyncPartitions(reviews, maxParallel, input.signal, async local => {
    const key = `partition:${local.id}:candidate-review`, saved = checkpoints.load<GenerationResult>(key)
    if (saved) { if (saved.candidate?.digest !== candidate.digest) reject('分区独审绑定了另一候选'); return saved }
    const result = await runGeneration({ ...local.input, requestKey: `${input.requestKey}:final:${local.id}` }, { ...options, beforeFreezeCandidate: undefined, reviewCandidate: candidate, builderTraces: builders, validateCandidate: async () => validationFindings })
    const { candidateFiles: _files, ...compact } = result
    checkpoints.save(key, compact)
    return compact
  })
  if (!checked.length) reject('最终候选缺少分区独审覆盖')
  base.traces = [...builders, ...checked.flatMap(result => result.traces)]
  independentTraces(base.traces)
  base.partitionEvidence = checked.flatMap((result, index) => result.review ? [{ partitionId: reviews[index].id, candidateDigest: candidate.digest, review: result.review, traces: result.traces }] : [])
  const rejected = checked.find(result => !result.reviewPassed)
  if (rejected) return { ...base, status: rejected.status, failure: rejected.failure, review: rejected.review }
  const checkedIds = unique(checked.flatMap(result => result.review!.checkedIds))
  if (input.readyIds.some(id => !checkedIds.includes(id))) reject('最终候选独审并集遗漏预定业务ID')
  // review 留空：各独立原件及覆盖集合才是 V2，不伪造一个全仓模型 accept。
  return { ...base, status: 'reviewed', reviewPassed: true }
}
