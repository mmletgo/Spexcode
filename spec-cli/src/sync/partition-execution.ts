import type { StageDraftMaterialRequest } from './stage-worktree.js'
import { setImmediate as yieldToControl } from 'node:timers/promises'
import { stageWorktree, STAGE_READING_INSTRUCTIONS } from './stage-worktree.js'
import { posix } from 'node:path'
import { contractReferences, parseContract, parseParts } from '@spexcode/spec-core/contracts'
import { analyzeCodeBehavior, compositionConflictPaths, deriveBehaviorAuthorization, partitionBehaviorChangedPaths, uncoveredCompositionConflicts, verifyBehaviorReadBasis } from './code-behavior.js'
import type { CodeBehaviorApprovalBinding, CodeBehaviorInput, CodeBehaviorContinuation, CodeBehaviorMaterialRequest, CodeBehaviorReviewReference } from './code-behavior.js'
import { outputErrors } from './elaboration-schema.js'
import { elaborate, freezeElaborationInput, verifyElaborationDraftCache, projectElaborationFlowReadiness, sealPartitionedElaboration, partitionSealRepairContext } from './elaboration.js'
import type { Contract, ContractFinding, Verification } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES, ELABORATION_GENERATION_GUIDANCE, partitionedElaborationInputDigest } from './elaboration-types.js'
import type { AnalysisOnlyPartitionEvidence, Applicability, ElaborationInput, ElaborationResult, ElaborationRunner, ElaborationTrace, ElaborationSessionRequest, ElaborationChange, ElaborationRepairSeed, ElaborationRepairDiagnostics, ElaborationDraft, ElaborationDraftMaterial, ReadonlySpecRepair, VerificationOwnershipProjection } from './elaboration-types.js'
import { elaborationTargetBindings, projectVerificationTable, withoutVerificationTables, readonlyFactRepairPreservesTarget, targetHasCurrentChanges } from './elaboration-markdown.js'
import { actualTreeDiff, isHostPrivatePath, verifyCandidate } from './candidate.js'
import type { CandidateChanges } from './candidate.js'
import { freezeGenerationCandidate, freezeGenerationInput, generationBrief, generationStageTree, runGeneration } from './generation.js'
import type { GenerationInput, GenerationOptions, GenerationResult } from './generation-types.js'
import type { BlobRef, ComposedInputRef } from './operation-types.js'
import { contentHash, readEvidence, readObject, readTree, validateRepositoryPath, verifySnapshot, writeEvidence } from './snapshot.js'
import { isUtf8Text } from './composition.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { projectSyncPartition, rawOnlyInterfaceSeedEvidence } from './partitioning.js'
import { historicalOwnerPaths, historicalRetiredIds, obligationPaths, projectPriorContext } from './prior-context.js'
import type { RawOnlyInterfaceSeedDescendant, RawOnlyInterfaceSeedEvidence, SyncPartition, SyncPartitionPlan } from './partitioning.js'
import type { CodeBehaviorAnalysis, CodeBehaviorEvidence } from './writeback-types.js'

type PartitionSealRepair = { prior: Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>; repair: ReadonlySpecRepair }
export type PartitionCheckpoints = {
  load<T>(key: string): T | null
  loadCandidateReviewRepair?(key: string, plan: SyncPartitionPlan, input: GenerationInput, candidate: NonNullable<GenerationResult['candidate']>): GenerationInput['reviewRepair'] | null
  loadAcceptedCandidateReview?(key: string, plan: SyncPartitionPlan, input: GenerationInput, candidate: NonNullable<GenerationResult['candidate']>, builders: readonly ElaborationTrace[], current?: Omit<GenerationResult, 'candidateFiles'>): Omit<GenerationResult, 'candidateFiles'> | null
  elaborationDraftTagged?(key: string, result: Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>): boolean
  loadBehaviorDraftMaterial?(key: string, planDigest: string, purpose: string, schemaDigest: string, inputDigest: string, request: CodeBehaviorMaterialRequest, existingDraft?: ElaborationDraft): ElaborationDraftMaterial | null | Promise<ElaborationDraftMaterial | null>
  loadBehaviorContinuation?(key: string, planDigest: string, inputDigest: string): CodeBehaviorContinuation | null
  loadBehaviorReviewFeedback?(key: string, planDigest: string, inputDigest: string): CodeBehaviorReviewReference | null
  loadAcceptedAnalysis?(key: string, plan: SyncPartitionPlan, inputDigest: string, binding: CodeBehaviorApprovalBinding): CodeBehaviorAnalysis | null
  authenticateAnalysisOnly?(plan: SyncPartitionPlan, evidence: CodeBehaviorEvidence, owners: readonly AnalysisOnlyPartitionEvidence[]): boolean
  loadAcceptedElaboration?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string): Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'> | null
  loadAcceptedInterfaceSeed?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string): Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'> | null
  loadElaborationDraftMaterial?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, schemaDigest?: string, request?: StageDraftMaterialRequest): ElaborationDraftMaterial | null | Promise<ElaborationDraftMaterial | null>
  loadElaborationDraft?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, schemaDigest?: string): ElaborationDraft | null
  loadElaborationRepairSeed?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string): ElaborationRepairSeed | null
  loadElaborationRepairDiagnostics?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string): ElaborationRepairDiagnostics | null
  readonlyFactRepairSource?(key: string, repair: ReadonlySpecRepair): boolean
  loadReadonlySpecRepair?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string, localInput: ElaborationInput): (PartitionSealRepair & { priorInput?: ElaborationInput }) | null
  loadPartitionSealRepair?(key: string, binding: NonNullable<ElaborationInput['partitionBinding']>, inputDigest: string): PartitionSealRepair | null | Promise<PartitionSealRepair | null>
  save(key: string, value: unknown): BlobRef
}
export type PartitionAnalysisFailure = { partitionId: string; code: string; message: string; error?: unknown }
export type PartitionAnalysisFailures = { planDigest: string; failures: PartitionAnalysisFailure[] }
const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
const unique = (values: readonly string[]): string[] => [...new Set(values)].sort()
const reject = (message: string): never => { throw Object.assign(new Error(message), { code: 'partition_binding' }) }
function primaryPartitionFailure<T>(values: readonly T[]): T | undefined {
  const priority = (value: unknown): number => {
    const failure = value as { code?: unknown; status?: unknown; failure?: { code?: unknown } | null } | null | undefined
    const code = failure?.failure?.code ?? failure?.code
    return code === 'cancellation_pending' ? 2 : code === 'unsupported' || failure?.status === 'unsupported' ? 1 : 0
  }
  return values.reduce<T | undefined>((primary, value) => priority(value) > priority(primary) ? value : primary, values[0])
}
function readonlyRepairInput(input: ElaborationInput, repair: ReadonlySpecRepair, inheritFacts = false): ElaborationInput {
  if (repair.kind === 'partition_seal') {
    const repaired = { ...input, readonlySpecRepair: repair }
    partitionSealRepairContext(repaired)
    return repaired
  }
  if (input.worktree && input.historyInput) {
    const generation = JSON.parse(readEvidence(input.historyInput.source.commonDir, repair.generationRef).toString('utf8')) as Pick<GenerationResult, 'candidate'>
    if (!generation.candidate || generation.candidate.digest !== repair.candidateDigest) return reject('只读修复seed必须绑定原真实失败candidate')
    verifyCandidate(input.historyInput.source.commonDir, generation.candidate)
    input = { ...input, worktree: stageWorktree(input.historyInput.source.commonDir, input.historyInput.headCommit, generation.candidate.tree) }
  }
  const sources = new Map(repair.changes.map(change => [change.path, change]))
  if (repair.changes.some(change => !input.targets.some(target => target.nodeId === change.nodeId && target.path === change.path))) reject('只读V1修复不能取得其它owner目标')
  if (repair.kind === 'candidate_review') {
    const targets = inheritFacts && input.generationGuidance === ELABORATION_GENERATION_GUIDANCE && input.phase !== 'interface_seed' ? input.targets.map(target => {
      const accepted = sources.get(target.path)
      if (!accepted || accepted.source === target.source || targetHasCurrentChanges(input, target)) return target
      const ids = new Set(parseContract({ ...target, source: target.source! }).contract!.items.map(item => item.id))
      if (!readonlyFactRepairPreservesTarget(target, accepted.source, ids)) reject('只读事实继承必须逐值保原raw、业务列、身份、AC/VERIFY与绑定')
      return { ...target, source: accepted.source, sourceDigest: contentHash(accepted.source) }
    }) : input.targets
    const inherited = targets.filter(target => target.source !== null && target.source !== input.targets.find(original => original.path === target.path)!.source)
    return { ...input, implementationWritePaths: [], readonlySpecRepair: repair, targets, files: inherited.length ? new Map([...input.files ?? [], ...inherited.map(target => [target.path, target.source!] as const)]) : input.files }
  }
  return { ...input, implementationWritePaths: [], readonlySpecRepair: repair, targets: input.targets.map(target => { const source = sources.get(target.path)?.source ?? target.source; return { ...target, source, sourceDigest: source === null ? null : contentHash(source) } }), files: new Map([...input.files ?? [], ...repair.changes.map(change => [change.path, change.source] as const)]) }
}

export function partitionSealRepairOwners(plan: SyncPartitionPlan, aggregate: Pick<ElaborationResult, 'partitionSeal' | 'changes'>, locals: ReadonlyMap<string, Pick<ElaborationResult, 'changes' | 'partitionBinding'>>): Map<string, ContractFinding[]> {
  const changes = aggregate.partitionSeal!.changes, reviewed = [...locals.values()].flatMap(local => local.changes)
  if (changes.length !== reviewed.length || changes.length !== aggregate.changes.length || new Set(reviewed.map(change => change.path)).size !== reviewed.length || changes.some(change => !reviewed.some(local => local.nodeId === change.nodeId && local.path === change.path && withoutVerificationTables(local.source) === withoutVerificationTables(change.source)) || !aggregate.changes.some(local => local.nodeId === change.nodeId && local.path === change.path && local.beforeDigest === change.beforeDigest && local.source === change.source && local.contentDigest === contentHash(change.source)))) throw Object.assign(new Error('全局seal候选不是所绑定已审局部的真实并集'), { code: 'partition_final_seal_binding' })
  const routed = new Map<string, ContractFinding[]>()
  for (const finding of aggregate.partitionSeal!.findings.filter(finding => finding.severity === 'error')) {
    const owners = [...locals].filter(([, local]) => local.changes.some(change => change.path === finding.path && change.nodeId === finding.nodeId && (!finding.itemId || parseContract(change).contract?.items.some(item => item.id === finding.itemId))))
    if (owners.length !== 1) throw Object.assign(new Error(`全局seal错误没有唯一可修owner: ${finding.code} ${finding.path} ${finding.itemId ?? ''}`), { code: 'partition_final_seal_unroutable' })
    const [ownerId, local] = owners[0], recipients = new Set([ownerId])
    for (const descendant of local.partitionBinding?.interfaceSeed?.descendants ?? []) {
      // 既有后代的分类证据没有sourcePartitionId，按原node/path反查本轮真实writer。
      const children = [...locals].filter(([id, child]) => (!descendant.sourcePartitionId || descendant.sourcePartitionId === id) && child.changes.some(change => change.path === descendant.path && change.nodeId === descendant.nodeId))
      if (children.length !== 1) throw Object.assign(new Error(`全局seal诊断缺少唯一接口后代owner: ${descendant.path}`), { code: 'partition_final_seal_unroutable' })
      recipients.add(children[0][0])
    }
    for (const edge of plan.dependencies) if (edge.to === ownerId && edge.contractIds.some(id => id === finding.itemId || finding.relatedIds?.includes(id))) recipients.add(edge.from)
    for (const id of recipients) {
      if (!plan.partitions.some(partition => partition.id === id) || !locals.has(id)) throw Object.assign(new Error(`全局seal诊断缺少真实依赖owner: ${id}`), { code: 'partition_final_seal_unroutable' })
      routed.set(id, [...routed.get(id) ?? [], finding])
    }
  }
  return routed
}

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
    if (!owned.length || owned.some(contract => contract.code.length || !contract.items.some(item => ['REQ', 'RULE', 'GAP'].includes(item.kind)) || contract.items.some(item => !['REQ', 'RULE', 'GAP', 'VERIFY'].includes(item.kind)))) return false
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
      catch (error) { failure = stopped ? primaryPartitionFailure([failure, error]) : error; stopped = true }
      await yieldToControl()
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
  const failures: PartitionAnalysisFailure[] = []
  const scopes = new Map<string, string[]>()
  let verified: ReturnType<typeof verifyBehaviorReadBasis> | undefined
  let analyses: CodeBehaviorAnalysis[]
  try { analyses = await mapSyncPartitions(plan.partitions, maxParallel, input.signal, async partition => {
    try {
      const key = `partition:${partition.id}:analysis`
      const saved = checkpoints.load<CodeBehaviorAnalysis>(key)
      // 只把全局授权、处于本区targets/只读上下文且正文可读的父Spec投影给新叶门禁，不扩充局部writePaths。
      const authorizedParentSpecPaths = input.plan.version === 'sync-coordinator-v2' && input.plan.direction === 'code_to_spec' && input.plan.sourcePaths !== undefined
        ? input.plan.targets.filter(target => (partition.contextNodeIds.includes(target.nodeId) || partition.targets.some(local => local.nodeId === target.nodeId && local.path === target.path))
          && within(target.path, partition.readPaths) && within(posix.dirname(target.path), input.plan.writePaths)).map(target => target.path).sort()
        : undefined
      const factSourcePaths = input.plan.sourcePaths === undefined
        ? unique(partition.writePaths.filter(path => !path.startsWith('.spec/')))
        : unique(partition.sourcePaths.filter(path => !path.startsWith('.spec/')))
      const localInput: CodeBehaviorInput = { ...input, postGateReview: input.postGateReview?.filter(diagnostic => diagnostic.partitionId === partition.id), repairDiagnostics: input.repairDiagnostics?.filter(diagnostic => 'partitionId' in diagnostic && diagnostic.partitionId === partition.id), requestKey: `${input.requestKey}:partition:${partition.id}`, plan: projectSyncPartition(input.plan, partition), partition: { id: partition.id, changedPaths: partition.changedPaths, factSourcePaths, ...(authorizedParentSpecPaths !== undefined ? { authorizedParentSpecPaths } : {}) } }
      const paths = partitionBehaviorChangedPaths(localInput)
      scopes.set(partition.id, paths)
      const local = await analyzeCodeBehavior(localInput, runner, (inputDigest, binding) => saved?.inputDigest === inputDigest ? saved : checkpoints.loadAcceptedAnalysis?.(key, plan, inputDigest, binding) ?? null, { loadReviewFeedback: inputDigest => checkpoints.loadBehaviorReviewFeedback?.(key, plan.digest, inputDigest) ?? null, loadMaterial: (purpose, schemaDigest, inputDigest, request, existingDraft) => checkpoints.loadBehaviorDraftMaterial?.(key, plan.digest, purpose, schemaDigest, inputDigest, request, existingDraft) ?? null, load: inputDigest => checkpoints.loadBehaviorContinuation?.(key, plan.digest, inputDigest) ?? null, save: continuation => { checkpoints.save(`${key}:continuation`, continuation) } }, verified ??= verifyBehaviorReadBasis(localInput))
      if (local.changes.some(change => change.paths.some(path => !paths.includes(path)))) reject(`分析超出本区真实变更集合: ${partition.id}`)
      checkpoints.save(key, local)
      return local
    } catch (error) {
      const issue = error as { code?: string; message?: string }
      failures.push({ partitionId: partition.id, code: issue.code ?? 'behavior_analysis_failed', message: issue.message ?? String(error), error })
      throw error
    }
  }) } catch (error) {
    checkpoints.save('partition:analysis-failures', { planDigest: plan.digest, failures: failures.map(({ error: _error, ...failure }) => failure) } satisfies PartitionAnalysisFailures)
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { partitionFailures: failures })
  }
  if (plan.expectedPaths.some(path => plan.partitions.filter(partition => partition.changedPaths.includes(path)).length !== 1) || analyses.some(analysis => !analysis.reviewPassed)) reject('分区并集未唯一覆盖完整变更集合或缺少独审')
  const conflicts = compositionConflictPaths(input)
  if (conflicts.some(path => [...scopes.values()].filter(paths => paths.includes(path)).length !== 1)) reject('组合冲突没有唯一分区归属')
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
    partitionCoverage: { planDigest: plan.digest, partitionIds: plan.partitions.map(partition => partition.id), changedPaths: unique([...scopes.values()].flat()) },
    partitionEvidence: analyses.map((analysis, index) => ({ analysis, partitionId: plan.partitions[index].id, changedPaths: scopes.get(plan.partitions[index].id)!, analysisRef: writeEvidence(input.snapshot.source.commonDir, analysis) })),
  }
  const missingConflicts = uncoveredCompositionConflicts(conflicts, merged.findings, merged.resolutions)
  if (missingConflicts.length) reject(`分区合并遗漏组合冲突: ${missingConflicts.join(', ')}`)
  return merged
}

/** 只投影跨owner重复的冻结技术登记，保留所有局部独审原件及非VERIFY源码字节。 */
export function projectPartitionVerificationOwnership(input: ElaborationInput, changes: readonly ElaborationChange[], writablePaths: readonly string[]): { changes: ElaborationChange[]; evidence: VerificationOwnershipProjection } {
  changes = changes.map(({ nodeId, path, beforeDigest, source }) => ({ nodeId, path, beforeDigest, source })).sort((a, b) => a.path.localeCompare(b.path))
  const registrations = [...input.verifications ?? []].sort((a, b) => a.id.localeCompare(b.id))
  const registered = new Map(registrations.map(row => [row.id, row]))
  const bindings = elaborationTargetBindings(input)
  for (const change of changes) if (!bindings.some(target => target.nodeId === change.nodeId && target.path === change.path) || !writablePaths.includes(change.path)) reject(`VERIFY投影目标不是本轮真实可写目标: ${change.path}`)
  const beforeSources = [...input.targets.filter((target): target is typeof target & { source: string } => target.source !== null), ...input.context ?? []]
  const rows = (source: { nodeId: string; path: string; source: string }): Verification[] => {
    const parsed = parseContract(source)
    if (parsed.findings.some(finding => finding.severity === 'error')) reject(`VERIFY投影不能修复非法契约正文: ${source.path}`)
    return parsed.contract?.items.filter((item): item is Verification => item.kind === 'VERIFY') ?? []
  }
  const definition = (row: Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>) => ({ id: row.id, command: row.command, cwd: row.cwd, timeoutMs: row.timeoutMs })
  const original = new Map<string, string>()
  for (const source of beforeSources) for (const row of rows(source)) {
    if (original.has(row.id)) reject(`原始VERIFY已有多个physical owner，不能静默修复: ${row.id}`)
    original.set(row.id, source.path)
  }
  const effective = [...changes, ...beforeSources.filter(source => !changes.some(change => change.path === source.path) && !input.nodeChanges?.some(change => change.from.path === source.path))]
  const byId = new Map<string, string[]>(), byPath = new Map<string, Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>[]>()
  for (const source of effective) {
    const items = rows(source)
    byPath.set(source.path, items)
    for (const row of items) {
      const policy = registered.get(row.id)
      if (!policy || JSON.stringify(definition(row)) !== JSON.stringify(definition(policy))) reject(`VERIFY投影仅接受精确可信登记: ${row.id}`)
      byId.set(row.id, [...byId.get(row.id) ?? [], source.path])
    }
  }
  const owners: VerificationOwnershipProjection['owners'] = []
  for (const [id, paths] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    const priorOwnerPath = original.get(id) ?? null
    const move = priorOwnerPath ? input.nodeChanges?.find(change => change.action === 'move' && change.from.path === priorOwnerPath && beforeSources.some(source => source.path === priorOwnerPath && source.nodeId === change.from.nodeId)) : undefined
    const effectivePriorOwnerPath = move?.action === 'move' ? move.to.path : priorOwnerPath
    if (effectivePriorOwnerPath && !paths.includes(effectivePriorOwnerPath)) reject(`VERIFY投影不能迁移既有physical owner: ${id}`)
    if (paths.length < 2) continue
    const ownerPath = effectivePriorOwnerPath ?? changes.find(change => change.nodeId === input.intent.nodeId)?.path ?? changes[0]?.path
    if (!ownerPath) reject(`VERIFY投影缺少真实可写owner: ${id}`)
    const policy = registered.get(id)!
    for (const path of paths) if (path !== ownerPath) {
      if (!changes.some(change => change.path === path)) reject(`VERIFY投影不能改写只读owner: ${path}`)
      byPath.set(path, byPath.get(path)!.filter(row => row.id !== id))
    }
    if (!byPath.get(ownerPath)?.some(row => row.id === id)) byPath.set(ownerPath, [...byPath.get(ownerPath) ?? [], policy])
    owners.push({ id, definitionDigest: contentHash(JSON.stringify(definition(policy))), priorOwnerPath, reviewedOwnerPaths: [...paths].sort(), ownerPath })
  }
  const projected = changes.map(change => {
    const expected = byPath.get(change.path) ?? []
    const current = rows(change)
    const source = JSON.stringify(current.map(definition)) === JSON.stringify(expected.map(definition)) ? change.source : projectVerificationTable(change.source, expected)
    if (withoutVerificationTables(change.source) !== withoutVerificationTables(source)) reject(`VERIFY投影改变了业务源码: ${change.path}`)
    return { ...change, source }
  })
  return { changes: projected, evidence: { version: 'verification-ownership-v1', registrationDigest: contentHash(JSON.stringify(registrations.map(definition))), owners,
    sources: changes.map((change, index) => ({ path: change.path, beforeDigest: contentHash(change.source), afterDigest: contentHash(projected[index].source), nonVerificationDigest: contentHash(withoutVerificationTables(change.source)) })),
  } }
}


/** 只有原冻结source-only分区的正式P0可证明无P1义务。 */
export function analysisOnlyPartitionEvidence(commonDir: string, plan: SyncPartitionPlan, evidence?: CodeBehaviorEvidence): AnalysisOnlyPartitionEvidence[] {
  if (!evidence) return []
  const { analysis, ref } = evidence, coverage = analysis.partitionCoverage, locals = analysis.partitionEvidence
  const candidates = plan.partitions.filter(partition => !partition.phase && !partition.targets.length && !partition.writePaths.length && !partition.contractIds.length && !partition.flowIds.length
    && partition.sourcePaths.length > 0 && partition.sourcePaths.length === unique(partition.sourcePaths).length
    && JSON.stringify(unique(partition.changedPaths)) === JSON.stringify(unique(partition.sourcePaths)) && partition.changedPaths.length === partition.sourcePaths.length
    && partition.sourcePaths.every(path => !path.startsWith('.spec/') && plan.expectedPaths.includes(path) && plan.partitions.filter(owner => owner.changedPaths.includes(path)).length === 1)
    && !plan.dependencies.some(edge => edge.from === partition.id || edge.to === partition.id)
    && !analysis.newNodes.some(node => partition.sourcePaths.includes(node.codePath)))
  if (!candidates.length) return []
  const orderedIds = plan.partitions.map(partition => partition.id)
  if (!analysis.reviewPassed || !coverage || coverage.planDigest !== plan.digest || JSON.stringify(coverage.partitionIds) !== JSON.stringify(orderedIds)
    || !locals || JSON.stringify(locals.map(owner => owner.partitionId)) !== JSON.stringify(orderedIds)
    || contentHash(JSON.stringify(analysis)) !== ref.sha256 || !readEvidence(commonDir, ref).equals(Buffer.from(JSON.stringify(analysis)))
    || analysis.inputDigest !== contentHash(JSON.stringify({ partitionPlanDigest: plan.digest, inputs: locals.map(owner => owner.analysis.inputDigest) }))
    || JSON.stringify(analysis.traces) !== JSON.stringify(locals.flatMap(owner => owner.analysis.traces))) return reject('仅分析分区缺少精确全局P0与原冻结计划')
  independentTraces(analysis.traces)
  return candidates.flatMap(partition => {
    const owner = locals.find(item => item.partitionId === partition.id)!, local = owner.analysis
    if (local.authorChanges?.length || local.rawIntegrations?.length || local.findings.length || local.authorizedChanges.length || local.nodeChanges.length
      || local.newNodes.length || local.resolutions.length || local.decision || local.decisionAuthorities?.length
      || local.changes.some(change => change.kind !== 'refactor' && change.kind !== 'allowed_change' || change.affectedIds.length || change.ruleIds.length)) return []
    if (!local.reviewPassed || local.partitionCoverage || local.partitionEvidence || local.inputId !== analysis.inputId || local.baselinePairId !== analysis.baselinePairId
      || local.baselineSelectionDigest !== analysis.baselineSelectionDigest || local.policyDigest !== analysis.policyDigest || local.readSetDigest !== analysis.readSetDigest || local.composedDigest !== analysis.composedDigest
      || local.traces.length !== 2 || local.traces[0].purpose !== 'code_behavior_analyze' || local.traces[1].purpose !== 'code_behavior_review'
      || local.traces.some(trace => !trace.sessionId || !trace.threadId || !trace.turnId || !trace.resultDigest || trace.inputDigest !== local.inputDigest)
      || owner.changedPaths.length !== partition.changedPaths.length || JSON.stringify(unique(owner.changedPaths)) !== JSON.stringify(unique(partition.changedPaths))
      || owner.changedPaths.some(path => !coverage.changedPaths.includes(path))
      || JSON.stringify(unique(local.changes.flatMap(change => change.paths))) !== JSON.stringify(unique(partition.changedPaths))
      || contentHash(JSON.stringify(local)) !== owner.analysisRef.sha256 || !readEvidence(commonDir, owner.analysisRef).equals(Buffer.from(JSON.stringify(local)))) reject(`仅分析分区没有真实已审P0原件及完整覆盖: ${partition.id}`)
    return [{ partitionId: partition.id, analysisRef: owner.analysisRef, wholeAnalysisRef: ref }]
  })
}

/** 纯父按祖先层级先审自身原意接口；叶继承只读接口，新归属按真实 codePath 唯一分区。 */
export async function elaborateSyncPartitions(input: ElaborationInput, plan: SyncPartitionPlan, maxParallel: number, checkpoints: PartitionCheckpoints, runner: ElaborationRunner, composed?: ComposedInputRef): Promise<ElaborationResult> {
  const { signal, ...data } = input
  input = { ...structuredClone(data), signal }; plan = structuredClone(plan); composed = composed && structuredClone(composed)
  const commonDir = input.historyInput!.source.commonDir
  let sealInput = input
  if (composed) {
    const files = new Map(input.files), readPaths = unique(plan.partitions.flatMap(partition => partition.readPaths))
    for (const entry of readTree(commonDir, composed.tree)) {
      if (files.has(entry.path) || within(entry.path, readPaths) || isHostPrivatePath(entry.path) || entry.mode === '120000') continue
      const bytes = readObject(commonDir, entry.oid)
      if (isUtf8Text(bytes)) files.set(entry.path, bytes.toString('utf8'))
    }
    const frozen = await readFrozenContracts(input.root, files)
    const excluded = new Set([...input.targets, ...input.context ?? []].map(source => source.path))
    for (const change of input.nodeChanges ?? []) { excluded.add(change.from.path); if (change.action === 'move') excluded.add(change.to.path) }
    sealInput = { ...input, files, context: [...input.context ?? [], ...frozen.nodes.filter(node => !excluded.has(node.path)).map(node => ({ nodeId: node.id, path: node.path, source: files.get(node.path)! }))] }
  }
  const { seeds, descendants } = interfaceSeedPartitions(input, plan)
  const analysisOnlyPartitions = analysisOnlyPartitionEvidence(commonDir, plan, input.analysis)
  if (analysisOnlyPartitions.length && !checkpoints.authenticateAnalysisOnly?.(plan, input.analysis!, analysisOnlyPartitions)) reject('仅分析分区缺少原正式P0与独审派发证明')
  const writers = plan.partitions.filter(partition => !analysisOnlyPartitions.some(owner => owner.partitionId === partition.id))

  const settledSources = new Map<string, string>(), factBaselines = new Map<string, string>()
  const run = async (partition: SyncPartition): Promise<Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>> => {
    const interfaceSeed = seeds.get(partition.id)
    const partitionBinding = { planDigest: plan.digest, partitionId: partition.id, ...(input.analysis ? { analysisRef: input.analysis.ref } : {}), ...(interfaceSeed ? { interfaceSeed } : {}) }
    const key = `partition:${partition.id}:elaboration`, saved = checkpoints.load<Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>>(key)
    if (saved && JSON.stringify(saved.partitionBinding) !== JSON.stringify(partitionBinding)) reject(`局部细化原件没有绑定当前分区分类: ${partition.id}`)
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
      recordUnverifiedCoverage: interfaceSeed ? undefined : input.recordUnverifiedCoverage,
    }
    let cacheDraft: ElaborationDraft | undefined
    const reusableCache = (cachedInput: ElaborationInput, cached: Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>): boolean => {
      const reusable = verifyElaborationDraftCache(cachedInput, cached, checkpoints.elaborationDraftTagged?.(key, cached))
      const draft = cached.rounds.at(-1)?.draft
      if (!reusable && !cacheDraft && draft) cacheDraft = { ...draft, errors: [...draft.errors, { code: 'rows_patch', message: '已审草稿超出本轮局部owner范围；恢复未受影响目标并重新独审' }] }
      return reusable
    }
    const loadDraft = localInput.draftProtocol ? (schemaDigest: string): ElaborationDraft | null => {
      const draft = checkpoints.loadElaborationDraft?.(key, partitionBinding, schemaDigest) ?? null
      return draft && cacheDraft ? { ...draft, errors: [...draft.errors, ...cacheDraft.errors] } : draft
    } : undefined
    const inputDigest = freezeElaborationInput(localInput).inputDigest
    const readonlyRepair = checkpoints.loadReadonlySpecRepair?.(key, partitionBinding, inputDigest, localInput) ?? await checkpoints.loadPartitionSealRepair?.(key, partitionBinding, inputDigest)
    if (readonlyRepair) {
      const priorBase = 'priorInput' in readonlyRepair ? (readonlyRepair as { priorInput?: ElaborationInput }).priorInput ?? localInput : localInput
      const priorInput = readonlyRepair.prior.readonlySpecRepair ? readonlyRepairInput(priorBase, readonlyRepair.prior.readonlySpecRepair, checkpoints.readonlyFactRepairSource?.(key, readonlyRepair.prior.readonlySpecRepair) === true) : priorBase
      if (freezeElaborationInput(priorInput).inputDigest !== readonlyRepair.prior.inputDigest) reject('只读V1修复的已审owner不匹配当前完整局部输入')
      const repairedInput = readonlyRepairInput(localInput, readonlyRepair.repair, checkpoints.readonlyFactRepairSource?.(key, readonlyRepair.repair) === true)
      for (const target of readonlyRepair.repair.kind === 'candidate_review' ? repairedInput.targets : []) if (target.source !== null && target.source !== localInput.targets.find(original => original.path === target.path)!.source) factBaselines.set(target.path, target.source)
      if (saved && saved.inputDigest === freezeElaborationInput(repairedInput).inputDigest && JSON.stringify(saved.readonlySpecRepair) === JSON.stringify(readonlyRepair.repair)) {
        if (reusableCache(repairedInput, saved)) return saved
      } else if (saved && contentHash(JSON.stringify(saved)) !== readonlyRepair.repair.acceptedRef.sha256) reject('只读V1修复不能绕过另一份当前局部原件')
      const accepted = (interfaceSeed ? checkpoints.loadAcceptedInterfaceSeed : checkpoints.loadAcceptedElaboration)?.(key, partitionBinding, freezeElaborationInput(repairedInput).inputDigest)
      if (accepted) {
        if (JSON.stringify(accepted.readonlySpecRepair) !== JSON.stringify(readonlyRepair.repair)) reject('只读修复承接不能改变原诊断来源')
        if (reusableCache(repairedInput, accepted)) return accepted
      }
      const seed = checkpoints.loadElaborationRepairSeed?.(key, partitionBinding, freezeElaborationInput(repairedInput).inputDigest) ?? undefined
      const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = await elaborate(repairedInput, { runner, partitionSealFiles: sealInput.files, seed, draft: cacheDraft, loadDraft, loadDraftMaterial: localInput.draftProtocol ? (schemaDigest, request) => checkpoints.loadElaborationDraftMaterial?.(key, partitionBinding, schemaDigest, request) ?? null : undefined, repairDiagnostics: checkpoints.loadElaborationRepairDiagnostics?.(key, partitionBinding, freezeElaborationInput(repairedInput).inputDigest) ?? undefined })
      checkpoints.save(key, compact)
      return compact
    }
    const cachedInput = (cached: Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>): ElaborationInput => {
      if (!cached.readonlySpecRepair) return localInput
      const restored = readonlyRepairInput(localInput, cached.readonlySpecRepair, checkpoints.readonlyFactRepairSource?.(key, cached.readonlySpecRepair) === true)
      if (freezeElaborationInput(restored).inputDigest !== cached.inputDigest) reject('已审只读owner续修原件不匹配当前唯一冻结摘要')
      for (const target of cached.readonlySpecRepair.kind === 'candidate_review' ? restored.targets : []) if (target.source !== null && target.source !== localInput.targets.find(original => original.path === target.path)!.source) factBaselines.set(target.path, target.source)
      return restored
    }
    if (saved && reusableCache(cachedInput(saved), saved)) return saved
    const accepted = interfaceSeed ? checkpoints.loadAcceptedInterfaceSeed?.(key, partitionBinding, inputDigest) : checkpoints.loadAcceptedElaboration?.(key, partitionBinding, inputDigest)
    if (accepted) {
      if (reusableCache(cachedInput(accepted), accepted)) return accepted
    }
    const seed = checkpoints.loadElaborationRepairSeed?.(key, partitionBinding, inputDigest) ?? undefined
    const result = await elaborate(localInput, { runner, seed, draft: cacheDraft, loadDraft, loadDraftMaterial: localInput.draftProtocol ? (schemaDigest, request) => checkpoints.loadElaborationDraftMaterial?.(key, partitionBinding, schemaDigest, request) ?? null : undefined, repairDiagnostics: checkpoints.loadElaborationRepairDiagnostics?.(key, partitionBinding, inputDigest) ?? undefined })
    const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = result
    checkpoints.save(key, compact)
    return compact
  }
  const byPartition = new Map<string, Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>>()
  let pending = writers.filter(partition => seeds.has(partition.id))
  while (pending.length) {
    const layer = pending.filter(partition => !pending.some(ancestor => ancestor.id !== partition.id && seeds.get(partition.id)!.parentPath.startsWith(seeds.get(ancestor.id)!.parentPath.slice(0, -'spec.md'.length))))
    const results = await mapSyncPartitions(layer, maxParallel, input.signal, run)
    for (let index = 0; index < layer.length; index++) byPartition.set(layer[index].id, results[index])
    const failed = primaryPartitionFailure(results.filter(result => !result.structurePassed || !result.reviewPassed))
    if (failed) return { ...failed, contracts: [], graph: null, coverage: null, partitionEvidence: writers.filter(partition => byPartition.has(partition.id)).map(partition => ({ partitionId: partition.id, resultRef: writeEvidence(commonDir, byPartition.get(partition.id)!) })) }
    for (const result of results) for (const change of result.changes) settledSources.set(change.path, change.source)
    pending = pending.filter(partition => !byPartition.has(partition.id))
  }
  const remaining = writers.filter(partition => !byPartition.has(partition.id))
  const parallel = await mapSyncPartitions(remaining, maxParallel, input.signal, run)
  for (let index = 0; index < remaining.length; index++) byPartition.set(remaining[index].id, parallel[index])
  const results = writers.map(partition => byPartition.get(partition.id)!)
  const first = results[0]
  if (!first) reject('分区细化结果为空')
  independentTraces(results.flatMap(result => result.rounds.flatMap(round => round.traces)))
  const reviewedChanges = distinct(results.flatMap(result => result.changes.map(change => result.readonlySpecRepair ? { ...change, beforeDigest: input.targets.find(target => target.nodeId === change.nodeId && target.path === change.path)!.sourceDigest } : change)), change => change.path, 'target')
  const partitionEvidence = results.map((result, index) => ({ partitionId: writers[index].id, resultRef: writeEvidence(commonDir, result) }))
  const projection = input.verifications && results.every(result => result.structurePassed && result.reviewPassed)
    ? projectPartitionVerificationOwnership(input, reviewedChanges, elaborationTargetBindings(input).filter(binding => plan.partitions.some(partition => partition.targets.some(target => target.path === input.targets[binding.targetIndex].path)) || descendants.some(node => node.path === binding.path)).map(binding => binding.path)) : null
  const verificationProjectionRef = projection ? checkpoints.save('partition:verification-ownership', { ...projection.evidence, partitionPlanDigest: plan.digest, partitionEvidence }) : undefined
  const candidateChanges = (projection?.changes ?? reviewedChanges).map(({ nodeId, path, beforeDigest, source }) => ({ nodeId, path, beforeDigest, source }))
  const changes = candidateChanges.map(change => ({ ...change, contentDigest: contentHash(change.source) }))
  const applicability = partitionApplicability(results)
  const seal = sealPartitionedElaboration(sealInput, candidateChanges, applicability, results.flatMap(result => result.readonlySpecRepair?.kind === 'candidate_review' ? [result.readonlySpecRepair] : []), factBaselines)
  const readiness = seal.seal.passed ? projectElaborationFlowReadiness(seal.graph, seal.coverage) : { readyFlowIds: [], blockedFlows: [] }
  const gaps = seal.contracts.flatMap(contract => contract.items.filter((item): item is import('@spexcode/spec-core/contracts').Gap => item.kind === 'GAP'))
  const localStructurePassed = results.every(result => result.structurePassed)
  const reviewPassed = results.every(result => result.reviewPassed)
  const structurePassed = localStructurePassed && seal.seal.passed
  const failed = primaryPartitionFailure(results.filter(result => !result.structurePassed || !result.reviewPassed || result.failure))
  const status = !structurePassed || !reviewPassed
    ? failed?.status ?? 'failed'
    : gaps.some(gap => gap.gapKind === 'conflict') ? 'conflict' : gaps.length ? 'needs_input' : 'complete'
  const failure = failed?.failure ?? (!seal.seal.passed ? { code: 'partition_final_seal_failed', message: JSON.stringify(seal.seal.findings.map(({ code, itemId, message }) => ({ code, itemId, message }))) } : null)
  const compact = { ...first, partitionBinding: undefined, readonlySpecRepair: undefined, repairDiagnostics: undefined, phase: 'partitioned_final' as const, inputDigest: partitionedElaborationInputDigest(plan.digest, results.map(result => result.inputDigest), analysisOnlyPartitions), candidateDigest: seal.seal.candidateDigest, changes,
    readyIds: structurePassed ? seal.coverage.items.filter(item => item.blockedBy.length === 0 && item.kind !== 'GAP').map(item => item.id) : [], readyFlowIds: readiness.readyFlowIds,
    blockedIds: seal.coverage.items.filter(item => item.blockedBy.length > 0).map(item => item.id), blockedFlows: readiness.blockedFlows,
    retiredIds: unique([...results.flatMap(result => result.retiredIds), ...seal.resolvedGapIds]), nodeChanges: [...input.nodeChanges ?? []],
    gaps, rounds: results.flatMap(result => result.rounds),
    deferredImplementationFindings: results.flatMap(result => result.deferredImplementationFindings), blockedStructureFindings: results.flatMap(result => result.blockedStructureFindings),
    structurePassed, reviewPassed, status, failure,
    contracts: seal.contracts, graph: seal.graph, coverage: seal.coverage, partitionSeal: seal.seal,
    partitionEvidence, ...(analysisOnlyPartitions.length ? { analysisOnlyPartitions } : {}), ...(verificationProjectionRef ? { verificationProjectionRef } : {}),
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
export type FileWriterPlan = { version: 'sync-file-writers-v1'; writers: { partitionId: string; paths: string[] }[]; traces: ElaborationTrace[] }

export function implementationPlanningPartitions(partitions: readonly SyncPartition[], contracts: readonly Contract[], nodeChanges: GenerationInput['nodeChanges'] = []): string[] {
  return partitions.filter(partition => {
    const ownsSource = contracts.some(contract => contract.code.length && partition.targets.some(target => target.path === contract.path))
    const parentOnly = partition.targets.some(target => partitions.some(other => other.id !== partition.id && other.targets.some(child => child.path.startsWith(`${target.path.slice(0, -'spec.md'.length)}`))))
    const retiredOnly = partition.targets.length > 0 && partition.targets.every(target => nodeChanges?.some(change => change.action === 'retire' && change.from.path === target.path))
    return !ownsSource && !parentOnly && !retiredOnly
  }).map(partition => partition.id)
}

/** 从真实局部/跨边输入投影尚需派发的阶段，预算和最终独审共用同一业务集合。 */
export function implementationGenerationDispatch(input: GenerationInput, plan: SyncPartitionPlan, specOnly: boolean): { interfaceParents: Set<string>; locals: LocalGeneration[]; reviews: { id: string; input: GenerationInput }[]; planningIds: string[]; requiredKeys: string[]; specWritePaths: string[] } {
  const commonDir = input.snapshot.source.commonDir
  const selection = implementationPartitionSelection(plan, input.contracts)
  const locals = selection.partitions.map(partition => ({ partition, input: localGeneration(input, partition, commonDir) })).filter(local => local.input.readyIds.length)
  const reviews = [...locals.map(local => ({ id: local.partition.id, input: local.input })), ...selection.dependencies.map((edge, index) => {
    const endpoints = plan.partitions.filter(partition => [edge.from, edge.to].includes(partition.id))
    const paths = unique(endpoints.flatMap(partition => partition.readPaths)), targets = endpoints.flatMap(partition => partition.targets)
    const combined = { ...endpoints[0], id: `edge-${index}`, readPaths: paths, writePaths: unique(endpoints.flatMap(partition => partition.writePaths)), sourcePaths: unique(endpoints.flatMap(partition => partition.sourcePaths)), targets }
    const projected = { ...localGeneration(input, combined, commonDir), analysisEvidence: endpoints.flatMap(partition => { const evidence = partitionAnalysisEvidence(commonDir, input.analysis, partition.id); return evidence ? [evidence] : [] }) }
    return { id: `edge:${edge.from}:${edge.to}`, input: { ...projected, readyIds: input.readyIds.filter(id => edge.contractIds.includes(id) || projected.retiredIds?.includes(id)) } }
  })].filter(local => local.input.readyIds.length)
  const activeIds = new Set(locals.map(local => local.partition.id))
  const planningIds = specOnly ? [] : implementationPlanningPartitions(plan.partitions, input.contracts, input.nodeChanges).filter(id => activeIds.has(id))
  const requiredKeys = [
    ...specOnly ? [] : locals.map(local => `${input.requestKey}:partition:${local.partition.id}:code_generate`),
    ...planningIds.map(id => `${input.requestKey}:partition:${id}:implementation_plan`),
    ...reviews.map(local => `${input.requestKey}:final:${local.id}:code_review`),
  ]
  const specWritePaths = specOnly ? [] : input.elaboratedSpecs.filter(spec => locals.some(local => within(spec.path, local.input.allowedScope.paths) && !local.input.readonlyContractPaths?.includes(spec.path))).map(spec => spec.path)
  return { interfaceParents: selection.interfaceParents, locals, reviews, planningIds, requiredKeys, specWritePaths: unique(specWritePaths) }
}

async function implementationFileWriters(input: GenerationInput, locals: readonly LocalGeneration[], planningIds: readonly string[], maxParallel: number, options: GenerationOptions, checkpoints: PartitionCheckpoints): Promise<FileWriterPlan> {
  const commonDir = input.snapshot.source.commonDir
  const owner = new Map<string, string>()
  for (const local of locals) for (const path of local.input.allowedScope.paths) {
    if ([...owner].some(([owned, id]) => id !== local.partition.id && (within(path, [owned]) || within(owned, [path])))) throw Object.assign(new Error(`P1分区争用实现writer: ${path}; 需要互不重叠的文件规划`), { code: 'implementation_plan_conflict' })
    owner.set(path, local.partition.id)
  }
  const saved = checkpoints.load<FileWriterPlan>('file-writer-plan')
  if (saved) return saved
  const needs = new Set(planningIds)
  const proposed = await mapSyncPartitions(locals.filter(local => needs.has(local.partition.id)), maxParallel, input.signal, async local => {
    const key = `partition:${local.partition.id}:implementation-plan`, prior = checkpoints.load<{ paths: string[]; trace: ElaborationTrace }>(key)
    if (prior) return { partitionId: local.partition.id, ...prior }
    const policy = options.implementationPolicy
    if (!policy) return reject('新功能分区缺少冻结的实现文件规划授权')
    const context = { partitionId: local.partition.id, inputId: input.snapshot.id, policy: input.policy, intent: local.input.intent, specs: local.input.elaboratedSpecs, contracts: local.input.contracts, facts: local.input.facts, files: [...local.input.files], authorizedWritePaths: policy.writePaths.filter(path => !path.startsWith('.spec/')), sourcePaths: policy.sourcePaths, readonlyTests: local.input.mandatoryTests, repairContext: input.repairContext }
    const worktree = input.nativeWorktree ? stageWorktree(commonDir, input.snapshot.headCommit, generationStageTree(input)) : undefined
    const inputDigest = contentHash(JSON.stringify(worktree ? { context, worktree } : context)), purpose = 'implementation_plan'
    if (input.signal?.aborted) throw Object.assign(new Error('文件规划已取消'), { code: 'cancelled' })
    const request: ElaborationSessionRequest = { root: input.root, base: worktree?.baseCommit ?? input.snapshot.headCommit, ...(worktree ? { worktree } : {}), requestKey: `${input.requestKey}:partition:${local.partition.id}:${purpose}`, purpose, inputDigest, prompt: worktree ? `${STAGE_READING_INSTRUCTIONS} 只读规划本区已审需求所需的精确源码/测试文件路径；只返回schema paths，不改文件、不新增业务或政策。只能选authorizedWritePaths内文件，readonlyTests不可改；不能选目录、通配符或其它区Spec。先读取现有实现并复用，确无变更则paths=[]。\n任务:\n${JSON.stringify({ ...generationBrief(local.input), partitionId: local.partition.id, authorizedWritePaths: policy.writePaths.filter(path => !path.startsWith('.spec/')), sourcePaths: policy.sourcePaths })}` : `只规划本区已批准需求所需的精确源码/测试文件路径，不返回正文、不新增业务、政策或Spec目标。新文件只能在authorizedWritePaths中；已有文件必须已在本区files完整读取，readonlyTests不可改。不能选目录、通配符或其它区的Spec；优先复用本区已有实现。若本区没有实现/测试变更可返回空paths。只返回schema JSON。\n冻结局部输入:\n${JSON.stringify(context)}`, schema: structuredClone(IMPLEMENTATION_PLAN_SCHEMA), timeoutMs: input.timeoutMs, signal: input.signal, model: input.model, effort: input.effort }
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
      if (path.startsWith('.spec/') || /[*?\[\]]/.test(path) || !within(path, policy.writePaths) || input.mandatoryTests.some(test => path === test.testPath) || input.manifest.entries.some(entry => entry.path.startsWith(`${path}/`)) || !input.nativeWorktree && input.manifest.entries.some(entry => entry.path === path) && !local.input.files.has(path)) reject(`实现文件计划越过本区完整读取或原授权: ${path}`)
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
  let dispatch = implementationGenerationDispatch(input, plan, specOnly)
  const interfaceParents = dispatch.interfaceParents
  let locals = dispatch.locals
  let planned: FileWriterPlan = { version: 'sync-file-writers-v1', writers: [], traces: [] }
  try {
    if (options.reviewCandidate) {
      const saved = checkpoints.load<FileWriterPlan>('file-writer-plan')
      planned = saved ?? reject('原候选续审缺少原file-writer-plan')
    } else if (!specOnly) planned = await implementationFileWriters(input, locals, dispatch.planningIds, maxParallel, options, checkpoints)
    const plannedPaths = unique(planned.writers.flatMap(writer => writer.paths))
    const authorization = await options.beforePartitionGeneration?.(plannedPaths, writeEvidence(commonDir, planned))
    if (authorization) { input = { ...input, allowedScope: authorization.scope, composed: authorization.composed ?? input.composed } }
    generationPartitions = generationPartitions.map(partition => { const paths = planned.writers.find(writer => writer.partitionId === partition.id)?.paths ?? []; return { ...partition, readPaths: unique([...partition.readPaths, ...paths]), writePaths: unique([...partition.writePaths, ...paths]) } })
    if (input.nativeWorktree) input = { ...input, stageTree: generationStageTree(input) }
    dispatch = implementationGenerationDispatch(input, { ...plan, partitions: generationPartitions }, specOnly)
    locals = dispatch.locals
  } catch (error) {
    const cause = error as { code?: string; message?: string; sessionId?: string; threadId?: string; turnId?: string; requestKey?: string; inputDigest?: string }
    return { status: input.signal?.aborted ? 'cancelled' : cause.code === 'unsupported' ? 'unsupported' : 'repair', inputId: input.snapshot.id, inputDigest: '', candidate: null, candidateFiles: null, output: planned, reviewOutput: null, review: null, validationFindings: [], traces: planned.traces, candidateValidated: false, reviewPassed: false, runtimeVerification: 'not_run', delivery: 'not_applied', failure: { code: cause.code ?? 'implementation_plan_invalid', message: cause.message ?? String(error), ...(cause.sessionId ? { sessionId: cause.sessionId, ...(cause.threadId ? { threadId: cause.threadId } : {}), ...(cause.turnId ? { turnId: cause.turnId } : {}), ...(cause.requestKey ? { requestKey: cause.requestKey, inputDigest: cause.inputDigest } : {}) } : {}) } }
  }
  const prepared = specOnly || options.reviewCandidate ? [] : await mapSyncPartitions(locals, maxParallel, input.signal, async local => {
    const key = `partition:${local.partition.id}:generation`, saved = checkpoints.load<GenerationResult>(key)
    if (saved) return saved
    const result = await runGeneration(local.input, { ...options, beforeFreezeCandidate: undefined, prepareOnly: true })
    if (result.status === 'prepared') for (const change of result.preparedChanges!.changes) {
      if (!within(change.path, local.input.allowedScope.paths) || !input.nativeWorktree && change.beforeDigest !== null && !local.input.files.has(change.path)) reject(`分区补丁越过读取/写入范围: ${change.path}`)
      if (change.path.startsWith('.spec/') && !local.input.elaboratedSpecs.some(spec => spec.path === change.path) && !local.input.nodeChanges?.some(item => item.from.path === change.path || item.action === 'move' && item.to.path === change.path)) reject(`分区不能改写只读Spec: ${change.path}`)
    }
    const { candidateFiles: _files, ...compact } = result
    checkpoints.save(key, compact)
    return compact
  })
  const failed = primaryPartitionFailure(prepared.filter(result => result.status !== 'prepared'))
  if (failed) return { ...failed, candidateFiles: null }
  const interfaceSpecChanges = input.elaboratedSpecs.filter(spec => interfaceParents.has(generationPartitions.find(partition => partition.targets.some(target => target.path === spec.path))?.id ?? '') && input.files.get(spec.path) !== spec.source).map(spec => {
    const before = input.manifest.entries.find(entry => entry.path === spec.path)
    return { path: spec.path, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content: spec.source, mode: null }
  })
  const reviewEntries = options.reviewCandidate ? new Map(verifyCandidate(commonDir, options.reviewCandidate).map(entry => [entry.path, entry])) : null
  const changes: CandidateChanges['changes'] = options.reviewCandidate
    ? actualTreeDiff(readTree(commonDir, options.reviewCandidate.baseTree), [...reviewEntries!.values()]).map(change => ({ path: change.path, beforeDigest: change.preDigest, beforeMode: change.preMode as CandidateChanges['changes'][number]['beforeMode'], content: reviewEntries!.has(change.path) ? readObject(commonDir, reviewEntries!.get(change.path)!.oid).toString('utf8') : null, mode: change.postMode as CandidateChanges['changes'][number]['mode'] }))
    : specOnly
    ? input.elaboratedSpecs.filter(spec => input.files.get(spec.path) !== spec.source).map(spec => { const before = input.manifest.entries.find(entry => entry.path === spec.path); return { path: spec.path, beforeDigest: before?.digest ?? null, beforeMode: before?.mode ?? null, content: spec.source, mode: null } })
    : [...prepared.flatMap(result => result.preparedChanges!.changes), ...interfaceSpecChanges]
  const seen = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.path)) reject(`候选文件存在多个写者: ${change.path}`)
    seen.add(change.path)
    if (specOnly && (!change.path.startsWith('.spec/') || !change.path.endsWith('/spec.md'))) reject('代码到Spec方向不得修改代码或测试')
    if (input.mandatoryTests.some(test => test.testPath === change.path)) reject(`禁止改写独立oracle: ${change.path}`)
  }
  let candidate = options.reviewCandidate ?? checkpoints.load<NonNullable<GenerationResult['candidate']>>('partition:candidate')
  if (!candidate) { candidate = await freezeGenerationCandidate(input, { version: 'sync-files-v1', changes: changes.sort((a, b) => a.path.localeCompare(b.path)) }, options); checkpoints.save('partition:candidate', candidate) }
  if (options.reviewCandidate) {
    const publication = await options.beforeFreezeCandidate?.()
    if (publication && publication.tree !== candidate.baseTree) reject('原候选发布基树已改变，不能借续审覆盖新发布')
    checkpoints.save('partition:candidate', candidate)
  }
  if (specOnly && actualTreeDiff(verifySnapshot(input.snapshot), verifyCandidate(commonDir, candidate)).some(change => !input.elaboratedSpecs.some(spec => spec.path === change.path))) reject('代码提交方向只能替换本次已审Spec；组合基树改变其它真实source/tests或配置时先结算冲突，禁止反向写代码或测试')
  const validationFindings = [...await options.validateCandidate(candidate)]
  const builders = options.builderTraces ? [...options.builderTraces] : [...planned.traces, ...prepared.flatMap(result => result.traces)]
  const base: GenerationResult = { fileWriterPlanRef: writeEvidence(commonDir, planned), status: 'repair', inputId: input.snapshot.id, inputDigest: contentHash(JSON.stringify({ partitionPlanDigest: plan.digest, candidateDigest: candidate.digest })), candidate, candidateFiles: null, output: { version: 'sync-files-v1', changes }, reviewOutput: null, review: null, validationFindings, traces: builders, candidateValidated: false, reviewPassed: false, runtimeVerification: 'not_run', delivery: 'not_applied', failure: null }
  if (validationFindings.some(finding => finding.severity === 'error')) return base
  base.candidateValidated = true
  const reviews = dispatch.reviews
  const settledReviewTraces = [...builders]
  const checked = await mapSyncPartitions(reviews, maxParallel, input.signal, async local => {
    const key = `partition:${local.id}:candidate-review`, saved = checkpoints.load<GenerationResult>(key)
    const baseInput = { ...local.input, requestKey: `${input.requestKey}:final:${local.id}` }
    const repair = checkpoints.loadCandidateReviewRepair?.(key, plan, baseInput, candidate)
    const reviewInput = repair ? { ...baseInput, reviewRepair: repair } : baseInput
    if (saved) {
      if (JSON.stringify(saved.candidate) !== JSON.stringify(candidate)) reject('分区独审绑定了另一候选')
      const current = saved.reviewPassed ? checkpoints.loadAcceptedCandidateReview?.(key, plan, reviewInput, candidate, settledReviewTraces, saved) ?? saved : saved
      settledReviewTraces.push(...current.traces); return current
    }
    const accepted = checkpoints.loadAcceptedCandidateReview?.(key, plan, reviewInput, candidate, settledReviewTraces)
    if (accepted) { settledReviewTraces.push(...accepted.traces); return accepted }
    checkpoints.save(`${key}:input`, freezeGenerationInput(reviewInput).inputEvidence)
    const result = await runGeneration(reviewInput, { ...options, beforeFreezeCandidate: undefined, reviewCandidate: candidate, reviewSpecWritePaths: dispatch.specWritePaths, builderTraces: builders, validateCandidate: async () => validationFindings })
    const { candidateFiles: _files, ...compact } = result
    settledReviewTraces.push(...compact.traces)
    checkpoints.save(key, compact)
    return compact
  })
  if (!checked.length) reject('最终候选缺少分区独审覆盖')
  base.traces = [...builders, ...checked.flatMap(result => result.traces)]
  independentTraces(base.traces)
  base.partitionEvidence = checked.flatMap((result, index) => result.review ? [{ partitionId: reviews[index].id, candidateDigest: candidate.digest, review: result.review, traces: result.traces }] : [])
  const rejected = primaryPartitionFailure(checked.filter(result => !result.reviewPassed))
  if (rejected) return { ...base, status: rejected.status, failure: rejected.failure, review: rejected.review }
  const checkedIds = unique(checked.flatMap(result => result.review!.checkedIds))
  if (input.readyIds.some(id => !checkedIds.includes(id))) reject('最终候选独审并集遗漏预定业务ID')
  // review 留空：各独立原件及覆盖集合才是 V2，不伪造一个全仓模型 accept。
  return { ...base, status: 'reviewed', reviewPassed: true }
}
