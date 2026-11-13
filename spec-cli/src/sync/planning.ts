import { posix } from 'node:path'
import { loadSpecs, parseCodeEntry, parseRelation, relationClaimsPath } from '@spexcode/spec-core'
import { contractImpact, contractReferences, parseContract, parseFrontmatter } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan, SyncDirection } from './coordinator-types.js'
import type { BaselinePair, BaselineResource, FrozenBaselineSelection, InputSnapshot, SyncScope } from './operation-types.js'
import { adoptedDeliveryPaths, selectedRetiredIds, verifyBaselineSelection } from './composition.js'
import { isSyncSpecPath, readFrozenContracts } from './frozen-contracts.js'
import { readEvidence, readObjectBatch, readTree, verifySnapshot, type TreeEntry } from './snapshot.js'
import { controlledDecisionIdentity } from './request-input.js'
import { readDecisionAuthority } from './code-behavior.js'
import type { CodeBehaviorAnalysis, SyncDecisionInput } from './writeback-types.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'
import { ownerNodesForPath } from './governance-owners.js'
import { ownedObligationPaths } from './prior-context.js'

/** 授权范围只枚举实际未治理源码；当前及真实交付治理均排除，发现不授予归属或执行范围。 */
export function discoverSyncSourcePaths(snapshot: InputSnapshot, sourcePaths: readonly string[], governanceFiles: Iterable<string>): string[] {
  return discoverSourcePaths(verifySnapshot(snapshot), sourcePaths, governanceFiles)
}

function discoverSourcePaths(entries: readonly TreeEntry[], sourcePaths: readonly string[], governanceFiles: Iterable<string>): string[] {
  const governed = new Set([...governanceFiles].flatMap(text => {
    const code = parseFrontmatter(text).fm.code
    return Array.isArray(code) ? code.filter((anchor): anchor is string => typeof anchor === 'string').map(anchor => posix.normalize(anchor.split('#')[0])) : []
  }))
  return entries.filter(entry => entry.mode !== '120000' && coveredPath(entry.path, sourcePaths) && /\.(?:[cm]?[jt]sx?|py|go|rs|java|rb)$/.test(entry.path) && !/\.(?:test|spec)\./.test(entry.path) && !governed.has(entry.path)).map(entry => entry.path).sort()
}

export type SyncPlanningOptions = { discoverySelection?: FrozenBaselineSelection; direction?: SyncDirection; commitTrigger?: { before: InputSnapshot | null; paths: readonly string[] } }

/** 同一次冻结的各轮共享已验证 Git 输入及其纯派生数据。 */
export function createSyncApplicationPlanner(snapshot: InputSnapshot) {
  const reads = createPlanningReads(snapshot)
  return {
    build: (nodeId: string, baseline?: BaselinePair | FrozenBaselineSelection | null, options: SyncPlanningOptions = {}) => buildPlan(snapshot, nodeId, baseline, options, reads),
    resources: (plan: SyncCoordinatorPlan, baseline?: FrozenBaselineSelection | null) => deriveResources(snapshot, plan, baseline, reads),
  }
}

type PlanningReads = ReturnType<typeof createPlanningReads>

function createPlanningReads(snapshot: InputSnapshot) {
  const { commonDir, canonicalRoot } = snapshot.source
  const snapshots = new Map<string, { entries: TreeEntry[]; byPath: Map<string, TreeEntry> }>()
  const texts = new Map<string, string>()
  const graphs = new Map<string, ReturnType<typeof readFrozenContracts>>()
  const adoptions = new Map<string, Set<string>>()
  let settings: ReturnType<typeof readSyncSettings>['settings'] | undefined
  let nodes: ReturnType<typeof loadSpecs> | undefined
  const specTexts = (entries: readonly TreeEntry[]): ReadonlyMap<string, string> => {
    for (const [oid, bytes] of readObjectBatch(commonDir, entries.filter(entry => !texts.has(entry.oid)).map(entry => entry.oid))) {
      texts.set(oid, bytes.toString('utf8'))
    }
    return new Map(entries.map(entry => [entry.path, texts.get(entry.oid)!]))
  }
  return {
    settings: () => settings ??= readSyncSettings(snapshot).settings,
    nodes: (files: ReadonlyMap<string, string>) => nodes ??= loadSpecs(canonicalRoot, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files } }),
    snapshot: (input: InputSnapshot) => {
      const key = JSON.stringify(input)
      const existing = snapshots.get(key)
      if (existing) return existing
      const entries = verifySnapshot(input)
      const verified = { entries, byPath: new Map(entries.map(entry => [entry.path, entry])) }
      snapshots.set(key, verified)
      return verified
    },
    frozen: (entries: readonly TreeEntry[]): ReturnType<typeof readFrozenContracts> => {
      const specs = entries.filter(entry => entry.mode !== '120000' && isSyncSpecPath(entry.path))
      const key = JSON.stringify(specs.map(({ path, oid }) => [path, oid]))
      const existing = graphs.get(key)
      if (existing) return existing
      const frozen = readFrozenContracts(canonicalRoot, specTexts(specs))
      graphs.set(key, frozen)
      return frozen
    },
    specText: (entry: TreeEntry): string => texts.get(entry.oid) ?? specTexts([entry]).get(entry.path)!,
    adopted: (before: InputSnapshot, pair: BaselinePair): Set<string> => {
      const key = JSON.stringify([before, pair])
      const existing = adoptions.get(key)
      if (existing) return existing
      const paths = adoptedDeliveryPaths(before, pair)
      adoptions.set(key, paths)
      return paths
    },
  }
}

/** 冻结契约影响与既有节点治理共同决定闭包；目录授权允许新自然语言需求创建实现。 */
export async function buildSyncApplicationPlan(snapshot: InputSnapshot, nodeId: string, baseline?: BaselinePair | FrozenBaselineSelection | null, options: SyncPlanningOptions = {}): Promise<SyncCoordinatorPlan & { executionScope: SyncScope }> {
  return createSyncApplicationPlanner(snapshot).build(nodeId, baseline, options)
}

async function buildPlan(snapshot: InputSnapshot, nodeId: string, baseline: BaselinePair | FrozenBaselineSelection | null | undefined, options: SyncPlanningOptions, reads: PlanningReads): Promise<SyncCoordinatorPlan & { executionScope: SyncScope }> {
  if (options.discoverySelection) verifyBaselineSelection(snapshot, options.discoverySelection)
  const selection = baseline && 'version' in baseline ? baseline : null
  if (selection) verifyBaselineSelection(snapshot, selection)
  const baselinePair = baseline && !('version' in baseline) ? baseline : null
  const pairs = selection ? [...new Map(selection.bindings.flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.id, pair] as const] : [] })).values()] : baselinePair ? [baselinePair] : []
  const settings = reads.settings(), { entries } = reads.snapshot(snapshot)
  const oldEntryMap = new Map((selection ? entries : baselinePair ? readTree(snapshot.source.commonDir, baselinePair.verifiedDelivery.immutableTree) : []).map(entry => [entry.path, entry]))
  const before = options.commitTrigger?.before
  const beforeTree = before ? reads.snapshot(before) : null
  if (before) {
    for (const entry of readTree(snapshot.source.commonDir, before.immutableTree)) if (isSyncSpecPath(entry.path)) oldEntryMap.set(entry.path, entry)
  }
  for (const binding of selection?.bindings ?? []) if ('bytePair' in binding && binding.bytePair) { const entry = reads.snapshot(binding.bytePair.verifiedDelivery).byPath.get(binding.resource.path); if (entry) oldEntryMap.set(entry.path, entry); else oldEntryMap.delete(binding.resource.path) }
  const oldEntries = [...oldEntryMap.values()]
  const oldFrozen = await reads.frozen(oldEntries)
  const protectedGraphs = await Promise.all(pairs.map(pair => reads.frozen(reads.snapshot(pair.verifiedDelivery).entries)))
  const frozen = await reads.frozen(entries), files = frozen.files, oldFiles = oldFrozen.files
  const nodes = await reads.nodes(files)
  const currentIntent = nodes.find(node => node.id === nodeId)
  const currentIntentIds = new Set(frozen.contracts.find(contract => contract.nodeId === currentIntent?.id)?.items.map(item => item.id) ?? [])
  const previousIntent = oldFrozen.nodes.find(node => node.id === nodeId) ?? oldFrozen.nodes.find(node => oldFrozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(item => currentIntentIds.has(item.id)))
  const intent = currentIntent ?? nodes.find(node => previousIntent && (oldFrozen.contracts.find(contract => contract.nodeId === previousIntent.id)?.items.some(item => frozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(next => next.id === item.id)) || previousIntent.rawSource === node.parts?.rawSource)) ?? nodes.filter(node => previousIntent && previousIntent.path.startsWith(`${posix.dirname(node.path)}/`) && node.parts?.rawSource).sort((a, b) => b.path.length - a.path.length)[0] ?? previousIntent
  if (!intent) throw new SyncApplicationError('sync_node_unknown', `不存在 Spec 节点 ${nodeId}`, 404)
  const views = [frozen, oldFrozen, ...protectedGraphs]
  const governanceNodes = views.flatMap(view => view.nodes.map(node => {
    const code = parseFrontmatter(view.files.get(node.path)!).fm.code
    return { ...node, code: parseRelation(Array.isArray(code) ? code.filter((entry): entry is string => typeof entry === 'string') : [], 'code').entries }
  }))
  const readinessSelection = options.discoverySelection
  const readinessPairs = new Map((readinessSelection?.bindings ?? []).flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.id, pair] as const] : [] }))
  const adopted = new Map([...readinessPairs.values()].map(pair => [pair.id, before ? reads.adopted(before, pair) : new Set<string>()]))
  const beforeEntries = beforeTree?.byPath ?? new Map<string, TreeEntry>()
  const beforePaths = new Set(beforeEntries.keys())
  const bootstrapNodes = oldFrozen.nodes.filter(node => beforePaths.has(node.path) && coveredPath(node.path, [posix.dirname(previousIntent?.path ?? intent.path)]))
  const bootstrapPaths = new Set(bootstrapNodes.map(node => node.path))
  const bootstrapItems = oldFrozen.contracts.filter(contract => bootstrapPaths.has(contract.path)).flatMap(contract => contract.items.filter(item => item.kind !== 'VERIFY'))
  const claims = [...governanceNodes.filter(node => bootstrapPaths.has(node.path)).flatMap(node => node.code.map(entry => entry.path)), ...bootstrapItems.filter(item => item.kind === 'AC').map(item => parseCodeEntry(item.test).path)]
  for (const path of beforePaths) if (coveredPath(path, [...settings.sourcePaths, ...settings.testPaths]) && !settings.mandatoryTests.some(test => test.testPath === path) && claims.some(claim => relationClaimsPath(claim, path))) bootstrapPaths.add(path)
  const settledResource = (resource: BaselineResource, path: string): boolean => {
    const binding = readinessSelection?.bindings.find(binding => resource.kind === 'path' ? binding.resource.kind === 'path' && binding.resource.path === resource.path : binding.resource.kind === resource.kind && binding.resource.id === resource.id)
    const pair = binding ? 'bytePair' in binding ? binding.bytePair : binding.intentPair : null
    return !!pair && (resource.kind === 'path' ? pair.coveredScope.paths.some(scope => coveredPath(resource.path, [scope])) : (resource.kind === 'flow' ? pair.coveredScope.flowIds : pair.coveredScope.contractIds).includes(resource.id)) && !!adopted.get(pair.id)?.has(path)
  }
  // 初始化的只读源码不产生byte head；仅已采纳owner的真实正文和未改对象能证明其先前已验证。
  const readonlyOwners = bootstrapNodes.flatMap(node => {
    const binding = readinessSelection?.bindings.find(binding => binding.resource.kind === 'path' && binding.resource.path === node.path)
    const pair = binding && 'bytePair' in binding ? binding.bytePair : null
    if (!pair || !settledResource({ kind: 'path', path: node.path }, node.path)) return []
    const source = reads.snapshot(pair.sourceInput).byPath, delivery = reads.snapshot(pair.verifiedDelivery).byPath
    const owner = delivery.get(node.path), prior = beforeEntries.get(node.path)
    if (!owner || owner.mode === '120000') return []
    const text = reads.specText(owner), code = parseFrontmatter(text).fm.code
    const contract = parseContract({ nodeId: node.id, path: node.path, source: text }).contract
    const claims = [...parseRelation(Array.isArray(code) ? code.filter((entry): entry is string => typeof entry === 'string') : [], 'code').entries.map(entry => entry.path), ...contract?.items.filter(item => item.kind === 'AC').map(item => parseCodeEntry(item.test).path) ?? []]
    for (const path of delivery.keys()) if (coveredPath(path, [...settings.sourcePaths, ...settings.testPaths]) && !settings.mandatoryTests.some(test => test.testPath === path) && claims.some(claim => relationClaimsPath(claim, path))) bootstrapPaths.add(path)
    if (prior?.oid !== owner.oid || prior.mode !== owner.mode) return []
    return [{ pair, source, delivery, claims }]
  })
  const readonlyInitialized = (path: string): boolean => {
    if (isSyncSpecPath(path)) return false
    const binding = readinessSelection?.bindings.find(binding => binding.resource.kind === 'path' && binding.resource.path === path)
    if (binding && 'bytePair' in binding && binding.bytePair) return false
    return readonlyOwners.some(({ pair, source, delivery, claims }) => {
      if (!claims.some(claim => relationClaimsPath(claim, path)) || !adopted.get(pair.id)?.has(path)) return false
      const original = source.get(path), verified = delivery.get(path), prior = beforeEntries.get(path)
      return !!original && !!verified && !!prior && original.oid === verified.oid && original.mode === verified.mode && prior.oid === verified.oid && prior.mode === verified.mode
    })
  }
  const subtreeIds = new Set([...nodes, ...oldFrozen.nodes].filter(node => coveredPath(node.path, [posix.dirname(intent.path), ...previousIntent ? [posix.dirname(previousIntent.path)] : []])).map(node => node.id))
  const changedOwners = (options.commitTrigger?.paths ?? []).map(path => ({ path, ids: [...ownerNodesForPath(path, views.flatMap(view => view.contracts), governanceNodes)].filter(id => subtreeIds.has(id)) }))
  const incremental = !!before && !!readinessSelection && bootstrapNodes.length > 0
    && [...bootstrapPaths].every(path => settledResource({ kind: 'path', path }, path) || readonlyInitialized(path))
    && bootstrapItems.every(item => settledResource({ kind: item.kind === 'FLOW' ? 'flow' : 'contract', id: item.id }, item.path))
    && !options.commitTrigger!.paths.includes(intent.path) && !options.commitTrigger!.paths.includes('.spec/spexcode.json')
    && changedOwners.some(change => change.ids.length) && changedOwners.every(change => change.ids.length || !coveredPath(change.path, [...settings.sourcePaths, ...settings.testPaths]))
  const seedIds = incremental ? [...new Set(changedOwners.flatMap(change => change.ids))] : [nodeId, intent.id]
  const impacts = views.map((view, index) => contractImpact(view.graph, !incremental && index === 1 ? [nodeId, ...previousIntent ? [previousIntent.id] : []] : seedIds))
  const impact = { nodeIds: [...new Set(impacts.flatMap(item => item.nodeIds))], codePaths: [...new Set(impacts.flatMap(item => item.codePaths))], testPaths: [...new Set(impacts.flatMap(item => item.testPaths))] }
  const selected = new Set([...seedIds, ...impact.nodeIds, ...incremental ? [] : nodes.filter(node => node.path.startsWith(intent.path.slice(0, -'spec.md'.length))).map(node => node.id)])
  // 普通旧节点尚无 sync-v1 契约时仍按共同治理文件纳入其它权威叶。
  let changed = true
  while (changed) {
    changed = false
    const governed = new Set(nodes.filter(node => selected.has(node.id)).flatMap(node => node.code))
    for (const node of nodes) if (!selected.has(node.id) && node.code.some(path => governed.has(path))) { selected.add(node.id); changed = true }
  }
  const targets = nodes.filter(node => selected.has(node.id)).map(node => ({ nodeId: node.id, path: node.path }))
  const codePaths = [...new Set([...impact.codePaths, ...nodes.filter(node => selected.has(node.id)).flatMap(node => node.code)])]
  const priorTargets = oldFrozen.nodes.filter(node => selected.has(node.id) || impact.nodeIds.includes(node.id))
  const missingPrior = priorTargets.filter(node => !targets.some(target => target.nodeId === node.id || frozen.contracts.find(contract => contract.nodeId === target.nodeId)?.items.some(item => oldFrozen.contracts.find(contract => contract.nodeId === node.id)?.items.some(previous => item.id === previous.id))))
  targets.push(...missingPrior.map(node => ({ nodeId: node.id, path: node.path, ...(node.rawSource ? { rawSource: node.rawSource } : {}) })))
  const writable = [...settings.sourcePaths, ...settings.testPaths]
  for (const path of [...codePaths, ...impact.testPaths]) if (!coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path)) throw new SyncApplicationError('sync_scope_unauthorized', `受影响文件未在可信授权中：${path}`)
  const decisionRefs = [...new Map(pairs.flatMap(pair => pair.decisionRefs ?? []).map(ref => [ref.sha256, ref])).values()]
  const retiredIds = selection ? selectedRetiredIds(selection) : [...new Set(pairs.flatMap(pair => pair.retiredIds ?? []))]
  const decisionFacts = decisionRefs.map(ref => {
    const request = JSON.parse(readEvidence(snapshot.source.commonDir, ref).toString('utf8')) as SyncDecisionInput & { type: string }
    const analysis = JSON.parse(readEvidence(snapshot.source.commonDir, request.analysisRef).toString('utf8')) as CodeBehaviorAnalysis
    if (request.type !== 'sync.decision' || !analysis.reviewPassed || request.inputId !== analysis.inputId || request.findingIds.some(id => !analysis.findings.some(finding => finding.id === id))) throw new SyncApplicationError('sync_decision_history_invalid', '已结算裁决证据不匹配具体分析')
    const selectedFindings = analysis.findings.filter(finding => request.findingIds.includes(finding.id))
    return { source: `decision:${controlledDecisionIdentity(request)}`, text: JSON.stringify({ settledDecisionRef: ref, decision: request.decision, ruleIds: [...new Set(selectedFindings.flatMap(finding => finding.ruleIds))], findings: selectedFindings, supersession: '仅上述所选规则按用户裁决生效；原facts在这些规则上保留为历史，不得恢复旧规则；未选政策及VERIFY执行政策保持有效。' }) }
  })
  const selectedContractIds = new Set([...frozen.contracts, ...oldFrozen.contracts, ...protectedGraphs.flatMap(graph => graph.contracts)].filter(contract => selected.has(contract.nodeId)).flatMap(contract => contract.items.filter(item => item.kind !== 'VERIFY').map(item => item.id)))
  const readIds = new Set(selectedContractIds)
  const graphs = [frozen.graph, oldFrozen.graph, ...protectedGraphs.map(graph => graph.graph)]
  let expanded = true
  while (expanded) { expanded = false; for (const graph of graphs) for (const id of [...readIds]) { const item = graph.items.get(id); if (!item) continue; for (const ref of contractReferences(item)) if (graph.items.has(ref.id) && !readIds.has(ref.id)) { readIds.add(ref.id); expanded = true } } }
  const specReadPaths = new Set([intent.path, ...previousIntent ? [previousIntent.path] : [], ...targets.map(target => target.path), ...priorTargets.map(target => target.path)])
  for (const graph of graphs) for (const id of readIds) { const item = graph.items.get(id); if (item) specReadPaths.add(item.path) }
  for (const node of [...nodes, ...oldFrozen.nodes]) if (targets.some(target => target.path.startsWith(`${posix.dirname(node.path)}/`))) specReadPaths.add(node.path)
  const declaredReadPaths = [...frozen.contracts, ...oldFrozen.contracts, ...protectedGraphs.flatMap(graph => graph.contracts)]
    .filter(contract => coveredPath(contract.path, [...specReadPaths, ...settings.readPaths]))
    .flatMap(contract => [...contract.code.map(anchor => anchor.split('#')[0]), ...contract.items.filter(item => item.kind === 'AC').map(item => item.test.split('#')[0])])
  const ownedReadPaths = [
    ...ownedObligationPaths(targets, undefined, files, entries.map(entry => entry.path)),
    ...ownedObligationPaths(priorTargets, undefined, oldFiles, oldEntries.map(entry => entry.path)),
    ...protectedGraphs.flatMap((graph, index) => ownedObligationPaths([...targets, ...priorTargets], undefined, graph.files, reads.snapshot(pairs[index].verifiedDelivery).entries.map(entry => entry.path))),
  ]
  const ownedVerificationIds = new Set(graphs.flatMap(graph => [...graph.items.values()].filter(item => item.kind === 'VERIFY').map(item => item.id)))
  const activeVerificationIds = new Set([...impacts.flatMap(item => item.verifyIds), ...graphs.flatMap(graph => [...graph.items.values()].filter(item => item.kind === 'VERIFY' && (selected.has(item.nodeId) || readIds.has(item.id))).map(item => item.id))])
  const contextVerificationIds = new Set(graphs.flatMap(graph => [...graph.items.values()].filter(item => item.kind === 'VERIFY' && coveredPath(item.path, [...specReadPaths, ...settings.readPaths])).map(item => item.id)))
  const verifications = settings.verifications.filter(item => !ownedVerificationIds.has(item.definition.id) || activeVerificationIds.has(item.definition.id) || contextVerificationIds.has(item.definition.id))
  const contextVerifications = settings.verifications.filter(item => !verifications.includes(item)).map(item => item.definition)
  const mandatoryTests = settings.mandatoryTests.filter(item => !ownedVerificationIds.has(item.verificationId) || activeVerificationIds.has(item.verificationId))
  const discoveryOwnerFiles = (options.discoverySelection?.bindings ?? []).flatMap(binding => {
    if (!('bytePair' in binding) || !binding.bytePair || !isSyncSpecPath(binding.resource.path)) return []
    const entry = reads.snapshot(binding.bytePair.verifiedDelivery).byPath.get(binding.resource.path)
    return entry && entry.mode !== '120000' ? [reads.specText(entry)] : []
  })
  const discoveryGovernance = [...files.values(), ...oldFiles.values(), ...discoveryOwnerFiles]
  const discoveryPaths = [...new Set([entries, ...beforeTree ? [beforeTree.entries] : []].flatMap(input => discoverSourcePaths(input, settings.sourcePaths, discoveryGovernance)))].filter(path => !before || options.commitTrigger!.paths.includes(path))
  const executionScope: SyncScope = { paths: [...new Set([...targets.map(target => target.path), ...priorTargets.map(target => target.path), ...[...codePaths, ...impact.testPaths].filter(path => coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path))])].sort(), contractIds: [...selectedContractIds].filter(id => !graphs.some(graph => graph.items.get(id)?.kind === 'FLOW')).sort(), flowIds: [...selectedContractIds].filter(id => graphs.some(graph => graph.items.get(id)?.kind === 'FLOW')).sort() }
  const initialDiscovery = options.direction === 'code_to_spec' && !before && pairs.length === 0 && readinessPairs.size === 0
  return {
    executionScope,
    version: 'sync-coordinator-v2', direction: options.direction ?? 'spec_to_code', ...(options.commitTrigger ? { commitTrigger: options.commitTrigger } : {}), partitionPolicy: { version: initialDiscovery ? 'sync-partition-policy-v2' : 'sync-partition-policy-v1', maxReadBytes: 512 * 1024, maxParallel: 4 }, intentNodeId: intent.id, targets,
    readPaths: [...new Set([...specReadPaths, ...declaredReadPaths, ...ownedReadPaths, '.spec/spexcode.json', ...settings.readPaths, ...settings.testPaths, ...codePaths, ...discoveryPaths, ...impact.testPaths, ...mandatoryTests.map(test => test.testPath)])].sort(),
    writePaths: [...new Set([...targets.map(target => target.path), ...targets.map(target => posix.dirname(target.path)), ...priorTargets.map(target => target.path), ...writable])].sort(),
    sourcePaths: [...settings.sourcePaths].sort(),
    facts: [...settings.facts, ...decisionFacts], decisionAuthorities: decisionRefs.map(ref => readDecisionAuthority(snapshot.source.commonDir, ref)), decisionRefs, retiredIds, verifications, ...(contextVerifications.length ? { contextVerifications } : {}), mandatoryTests,
  }
}

/** 语义读取与保护对象按实际快照枚举；授权目录不是 lease，也不是已验证覆盖。 */
export async function deriveSyncBaselineResources(snapshot: InputSnapshot, plan: SyncCoordinatorPlan, baseline?: FrozenBaselineSelection | null): Promise<BaselineResource[]> {
  return createSyncApplicationPlanner(snapshot).resources(plan, baseline)
}

async function deriveResources(snapshot: InputSnapshot, plan: SyncCoordinatorPlan, baseline: FrozenBaselineSelection | null | undefined, reads: PlanningReads): Promise<BaselineResource[]> {
  if (baseline) verifyBaselineSelection(snapshot, baseline)
  const snapshots = [snapshot, ...(plan.version === 'sync-coordinator-v2' && plan.commitTrigger?.before ? [plan.commitTrigger.before] : []), ...new Map((baseline?.bindings ?? []).flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.sourceInput.id, pair.sourceInput] as const, [pair.verifiedDelivery.id, pair.verifiedDelivery] as const] : [] })).values()]
  const paths = new Set<string>(['.spec/spexcode.json', ...plan.targets.map(target => target.path), ...plan.mandatoryTests.map(test => test.testPath)])
  const resources = new Map<string, BaselineResource>()
  const readable = (path: string): boolean => plan.readPaths.some(parent => path === parent || path.startsWith(`${parent}/`))
  for (const input of snapshots) {
    const entries = reads.snapshot(input).entries.filter(entry => readable(entry.path))
    for (const entry of entries) paths.add(entry.path)
    const frozen = await reads.frozen(entries)
    for (const node of frozen.nodes) if (baseline?.bindings.some(binding => binding.resource.kind === 'contract' && binding.resource.id === node.id && 'intentPair' in binding && binding.intentPair)) resources.set(`contract:${node.id}`, { kind: 'contract', id: node.id })
    for (const item of frozen.graph.items.values()) {
      if (item.kind === 'VERIFY') {
        if (baseline?.bindings.some(binding => binding.resource.kind === 'contract' && binding.resource.id === item.id && 'intentPair' in binding && binding.intentPair)) resources.set(`contract:${item.id}`, { kind: 'contract', id: item.id })
        continue
      }
      if (item.kind === 'FLOW') resources.set(`flow:${item.id}`, { kind: 'flow', id: item.id })
      else resources.set(`contract:${item.id}`, { kind: 'contract', id: item.id })
    }
  }
  // 精确已知的缺失文件/tombstone仍是读取对象，目录前缀不能假扮该对象。
  for (const binding of baseline?.bindings ?? []) if (binding.resource.kind === 'path' && readable(binding.resource.path)) paths.add(binding.resource.path)
  for (const path of paths) resources.set(`path:${path}`, { kind: 'path', path })
  return [...resources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, resource]) => resource)
}
