import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contractImpact, dependencyClosure, validateContractGraph } from '@spexcode/spec-core/contracts'
import type { Acceptance, ContractGraph } from '@spexcode/spec-core/contracts'
import { actualTreeDiff, exportCandidate, isHostPrivatePath } from './candidate.js'
import { CANDIDATE_REVIEW_INSTRUCTIONS, GENERATION_REVIEW_SCHEMA, runCandidateReview } from './candidate-review.js'
import { isUtf8Text } from './composition.js'
import type { ElaborationRunner, ElaborationTrace } from './elaboration-types.js'
import { readFrozenContracts } from './frozen-contracts.js'
import type { FrozenContracts } from './frozen-contracts.js'
import type { GenerationReview } from './generation-types.js'
import type { CandidateRef, InputSnapshot } from './operation-types.js'
import { coveredPath, readSyncSettings } from './settings.js'
import { contentHash, objectGit, readObject, readTree, writeEvidence } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'
import { executeVerification, verificationExportDigest } from './verification-executor.js'
import type { VerificationDriver, VerificationResult } from './verification-executor-types.js'
import { planAcceptanceRuns, planMandatoryRuns } from './verification-plan.js'
import type { AcceptanceRun } from './verification-plan.js'

export type ConformanceInput = {
  repository: string
  baseCommit: string
  candidateCommit: string
  /** 由可信调用者选择；候选不能从自己的配置选择此身份。 */
  policyCommit: string
  evidenceDirectory?: string
  signal?: AbortSignal
}
export type ConformanceResult = {
  version: 'sync-conformance-v1'
  status: 'passed' | 'not_applicable' | 'failed' | 'unsupported' | 'recovery_required'
  applicable: boolean
  identities: { baseCommit: string; candidateCommit: string; policyCommit: string; baseTree: string; candidateTree: string; policyTree: string } | null
  inputDigest: string | null
  readSetDigest: string | null
  scope: { nodeIds: string[]; itemIds: string[]; acceptanceIds: string[]; retiredIds: string[]; readPaths: string[] }
  unmanagedPaths: string[]
  /** 映射覆盖与本次影响范围的通过分开；不能从scope通过推断全项目同步。 */
  coverage: { mapping: 'unconfigured' | 'partial' | 'complete'; governedNodeIds: string[]; uncoveredNodeIds: string[]; governedPaths: string[]; uncoveredPaths: string[] }
  verificationExtent: 'affected_scope'
  reviewExecution: 'native' | 'injected'
  verificationExecution: 'docker' | 'injected'
  review: GenerationReview | null
  trace: ElaborationTrace | null
  runs: { bindings: AcceptanceRun['bindings']; result: VerificationResult }[]
  diagnostics: { code: string; message: string }[]
  evidenceDirectory: string
}
export type ConformanceOptions = {
  /** 仅用于可控制负例；结果必须明确显示 injected，CLI 不暴露该入口。 */
  testReviewRunner?: ElaborationRunner
  testVerificationDriver?: VerificationDriver
}
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort()
const pathOf = (anchor: string): string => anchor.split('#')[0]
const digest = (value: unknown): string => contentHash(JSON.stringify(value))
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_REPLACE_OBJECTS: '1' }, maxBuffer: 16 * 1024 * 1024,
  }).trim()
}
function commit(commonDir: string, supplied: string): { commit: string; tree: string } {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(supplied)) fail('commit_identity', 'base/candidate/policy 必须是完整不可变 Git commit SHA')
  const actual = objectGit(commonDir, ['rev-parse', '--verify', `${supplied}^{commit}`]).toString().trim()
  if (actual !== supplied) fail('commit_identity', '必须直接指定 commit，不接受 tag 或可替换身份')
  return { commit: actual, tree: objectGit(commonDir, ['rev-parse', `${actual}^{tree}`]).toString().trim() }
}
function files(commonDir: string, entries: readonly TreeEntry[]): Map<string, string> {
  return new Map(entries.filter(entry => entry.mode !== '120000' && !isHostPrivatePath(entry.path)).flatMap(entry => {
    const bytes = readObject(commonDir, entry.oid)
    return isUtf8Text(bytes) ? [[entry.path, bytes.toString('utf8')]] : []
  }))
}
/** 构造只在本次临时 object store 内使用的冻结协议输入，绝不读取开发机 receipt。 */
function frozenSnapshot(commonDir: string, root: string, version: { commit: string; tree: string }, entries: TreeEntry[]): InputSnapshot {
  const source = { repositoryId: digest({ root, commonDir }), commonDir, canonicalRoot: root, gitDir: commonDir, branch: 'HEAD', physicalFingerprint: digest(commonDir) }
  const contentDigest = digest(entries), indexDigest = digest(null)
  const id = digest({ source, headCommit: version.commit, indexTree: version.tree, indexDigest, tree: version.tree, contentDigest })
  return { id, source, headCommit: version.commit, immutableTree: version.tree, indexTree: version.tree, indexDigest, manifestBlob: writeEvidence(commonDir, { version: 1, entries }), contentDigest, capturedAtMs: 0 }
}
function scopeOf(before: FrozenContracts, after: FrozenContracts, changed: string[], policyChanged: boolean): { nodeIds: string[]; itemIds: string[] } {
  const graphs = [before.graph, after.graph], ids = new Set<string>(), nodes = new Set<string>()
  for (const graph of graphs) for (const contract of graph.contracts) {
    const paths = [contract.path, ...contract.code.map(pathOf), ...contract.related.map(pathOf), ...contract.items.flatMap(item => item.kind === 'AC' ? [pathOf(item.test)] : item.kind !== 'VERIFY' && item.source.kind === 'code' ? [pathOf(item.source.ref)] : [])]
    if (policyChanged || paths.some(path => changed.includes(path))) { nodes.add(contract.nodeId); for (const item of contract.items) ids.add(item.id) }
  }
  for (const frozen of [before, after]) for (const finding of frozen.findings) if (finding.severity === 'error' && changed.includes(finding.path)) nodes.add(finding.nodeId)
  let previous = ''
  while (previous !== JSON.stringify([sorted(ids), sorted(nodes)])) {
    previous = JSON.stringify([sorted(ids), sorted(nodes)])
    for (const graph of graphs) {
      const impact = contractImpact(graph, [...ids, ...nodes])
      for (const id of dependencyClosure(graph, impact.itemIds)) ids.add(id)
      for (const id of impact.nodeIds) nodes.add(id)
      for (const contract of graph.contracts) if (nodes.has(contract.nodeId)) for (const item of contract.items) ids.add(item.id)
    }
  }
  return { nodeIds: sorted(nodes), itemIds: sorted(ids) }
}
function acceptances(graph: ContractGraph, ids: readonly string[]): Acceptance[] {
  return ids.flatMap(id => { const item = graph.items.get(id); return item?.kind === 'AC' ? [item] : [] })
}

/** 对真实 Git base∪candidate 闭包独立执行 V1/V2/V3/V4；不产生开发或交付状态。 */
export async function runConformance(supplied: ConformanceInput, options: ConformanceOptions = {}): Promise<ConformanceResult> {
  const { signal, ...data } = supplied, input = structuredClone(data)
  const evidenceDirectory = input.evidenceDirectory ? realpathSync(input.evidenceDirectory) : mkdtempSync(join(tmpdir(), 'spex-conformance-'))
  const result: ConformanceResult = { version: 'sync-conformance-v1', status: 'failed', applicable: false, identities: null, inputDigest: null, readSetDigest: null, scope: { nodeIds: [], itemIds: [], acceptanceIds: [], retiredIds: [], readPaths: [] }, unmanagedPaths: [], coverage: { mapping: 'unconfigured', governedNodeIds: [], uncoveredNodeIds: [], governedPaths: [], uncoveredPaths: [] }, verificationExtent: 'affected_scope', reviewExecution: options.testReviewRunner ? 'injected' : 'native', verificationExecution: options.testVerificationDriver ? 'injected' : 'docker', review: null, trace: null, runs: [], diagnostics: [], evidenceDirectory }
  try {
    if (signal?.aborted) fail('cancelled', '检查已取消')
    const root = realpathSync(input.repository), sourceCommon = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    // 只复用不可变 Git 对象；所有 protocol blob 和 refs 均留在独立临时库。
    const commonDir = mkdtempSync(join(evidenceDirectory, 'objects-'))
    git(commonDir, ['init', '--bare', '--quiet'])
    writeFileSync(join(commonDir, 'objects/info/alternates'), `${join(sourceCommon, 'objects')}\n`)
    const base = commit(commonDir, input.baseCommit), candidate = commit(commonDir, input.candidateCommit), policy = commit(commonDir, input.policyCommit)
    const baseEntries = readTree(commonDir, base.tree), candidateEntries = candidate.tree === base.tree ? baseEntries : readTree(commonDir, candidate.tree)
    const policyEntries = policy.tree === base.tree ? baseEntries : policy.tree === candidate.tree ? candidateEntries : readTree(commonDir, policy.tree)
    result.identities = { baseCommit: base.commit, candidateCommit: candidate.commit, policyCommit: policy.commit, baseTree: base.tree, candidateTree: candidate.tree, policyTree: policy.tree }
    const before = await readFrozenContracts(root, files(commonDir, baseEntries))
    const after = candidate.tree === base.tree ? before : await readFrozenContracts(root, files(commonDir, candidateEntries))
    result.coverage.governedNodeIds = sorted(after.contracts.map(contract => contract.nodeId))
    result.coverage.uncoveredNodeIds = sorted(after.nodes.filter(node => !after.contracts.some(contract => contract.path === node.path)).map(node => node.id))
    result.coverage.governedPaths = sorted(after.contracts.flatMap(contract => [...contract.code.map(pathOf), ...contract.items.flatMap(item => item.kind === 'AC' ? [pathOf(item.test)] : [])]))
    const changed = actualTreeDiff(baseEntries, candidateEntries).map(change => change.path)
    const policyPath = '.spec/spexcode.json'
    const policyFiles = policy.tree === base.tree ? before.files : policy.tree === candidate.tree ? after.files : files(commonDir, policyEntries), policyConfig = policyFiles.get(policyPath)
    const hasPolicy = policyConfig && (JSON.parse(policyConfig) as { sync?: unknown }).sync !== undefined
    const trustedSettings = hasPolicy ? readSyncSettings(frozenSnapshot(commonDir, root, policy, policyEntries)).settings : null
    const baseConfig = before.files.get(policyPath)
    const baseHasPolicy = baseConfig && (JSON.parse(baseConfig) as { sync?: unknown }).sync !== undefined
    const baseSettings = baseHasPolicy ? readSyncSettings(frozenSnapshot(commonDir, root, base, baseEntries)).settings : null
    const policies = [baseSettings, trustedSettings].filter(settings => settings !== null)
    result.coverage.uncoveredPaths = sorted([...after.files.keys()].filter(path => policies.some(settings => coveredPath(path, [...settings.sourcePaths, ...settings.testPaths])) && !result.coverage.governedPaths.includes(path)))
    result.coverage.mapping = !baseSettings || !trustedSettings ? 'unconfigured' : result.coverage.uncoveredNodeIds.length || result.coverage.uncoveredPaths.length ? 'partial' : 'complete'
    const dependencyChanged = policies.some(settings => changed.some(path => coveredPath(path, settings.readPaths)))
    const effectiveChanged = [...changed]
    let unknownOracleChanged = false
    for (const settings of policies) for (const binding of settings.mandatoryTests.filter(binding => changed.includes(binding.testPath))) {
      const owners = [...before.contracts, ...after.contracts].filter(contract => contract.items.some(item => item.id === binding.verificationId))
      if (owners.length) effectiveChanged.push(...owners.map(owner => owner.path))
      else unknownOracleChanged = true
    }
    const scope = scopeOf(before, after, effectiveChanged, changed.includes(policyPath) || policy.commit !== base.commit || dependencyChanged || unknownOracleChanged)
    result.scope.nodeIds = scope.nodeIds; result.scope.itemIds = scope.itemIds
    result.applicable = scope.nodeIds.length > 0
    if (trustedSettings) for (const node of after.nodes.filter(node => changed.includes(node.path))) {
      const roots = trustedSettings.nodeIds?.flatMap(id => [...before.nodes, ...after.nodes].filter(rootNode => rootNode.id === id).map(rootNode => rootNode.path.slice(0, -'/spec.md'.length)))
      const enabled = !roots || roots.some(parent => node.path.startsWith(`${parent}/`))
      if (enabled && !after.contracts.some(contract => contract.path === node.path) && !after.findings.some(finding => finding.path === node.path && finding.severity === 'error')) {
        result.scope.nodeIds = sorted([...result.scope.nodeIds, node.id]); result.applicable = true
        fail('pending_contract', `启用范围的新需求尚未细化为完整同步契约: ${node.path}`)
      }
    }
    const governed = new Set([...before.contracts, ...after.contracts].flatMap(contract => [contract.path, ...contract.code.map(pathOf), ...contract.items.flatMap(item => item.kind === 'AC' ? [pathOf(item.test)] : [])]))
    result.unmanagedPaths = changed.filter(path => !governed.has(path) && path !== policyPath)
    const ungoverned = changed.filter(path => policies.some(settings => coveredPath(path, [...settings.sourcePaths, ...settings.testPaths])) && !governed.has(path))
    if (ungoverned.length) fail('ungoverned_change', `启用范围的新源码或测试缺少业务治理: ${ungoverned.join(', ')}`)
    if (!result.applicable) {
      // 新同步授权仍需可信政策；不能把首次声明自批为免检。
      if (changed.some(path => path === policyPath && after.files.get(path) !== before.files.get(path))) fail('unsupported_policy_introduction', '无契约闭包的同步政策变更需要可信政策接入验证')
      if (!baseSettings || !trustedSettings) fail('unsupported_unconfigured', '仓库尚未建立可信sync配置和共同基线；未纳入节点已列入coverage，空影响范围不能证明同步完成')
      result.status = 'not_applicable'; return result
    }
    const oldPolicy = baseSettings ?? fail('unsupported_baseline_policy', '基线缺少已验证的同步政策，须先建立可信接入基线')
    const trusted = trustedSettings ?? fail('unsupported_policy_missing', '受信policyCommit缺少同步政策')
    const candidateConfig = after.files.get(policyPath)
    const candidateSync: unknown = candidateConfig ? (JSON.parse(candidateConfig) as { sync?: unknown }).sync : undefined
    if (candidateSync === undefined || digest(candidateSync) !== digest(trusted)) fail('unsupported_policy_update', '候选 sync 政策与受信 policyCommit 不同；必须由可信调用者提供已验证的政策 SHA')
    const ids = new Set(scope.itemIds), selected = (item: { nodeId: string; itemId?: string }): boolean => scope.nodeIds.includes(item.nodeId) || !!item.itemId && ids.has(item.itemId)
    const errors = [...before.findings, ...after.findings].filter(finding => finding.severity === 'error' && selected(finding))
    if (errors.length) fail('structure', errors.map(finding => `${finding.path}: ${finding.message}`).join('\n'))
    for (const contract of before.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId))) {
      if (after.nodes.some(node => node.path === contract.path) && !after.contracts.some(next => next.path === contract.path)) fail('schema_removed', `已有节点移除了同步 schema: ${contract.path}`)
    }
    for (const item of after.coverage.items.filter(item => ids.has(item.id))) if (item.blockedBy.length || item.status !== 'bound') fail('coverage', `声明尚未完整绑定或仍有缺口: ${item.id}`)
    const oldAcs = acceptances(before.graph, scope.itemIds), newAcs = acceptances(after.graph, scope.itemIds)
    result.scope.acceptanceIds = sorted([...oldAcs, ...newAcs].map(ac => ac.id))
    result.scope.retiredIds = scope.itemIds.filter(id => before.graph.items.has(id) && !after.graph.items.has(id))
    if (!result.scope.acceptanceIds.length) fail('coverage', '影响闭包没有可执行验收，不能给出同步完成结论')
    for (const ac of oldAcs) {
      const path = pathOf(ac.test), old = before.files.get(path), next = after.files.get(path)
      if (next === undefined) fail('old_test_removed', `必须保留旧验收测试路径和稳定 ID: ${ac.id} ${ac.test}`)
      if (result.scope.retiredIds.includes(ac.id) && old === next) fail('retirement_negative_missing', `退役验收必须改成真实负向断言并独审: ${ac.id} ${ac.test}`)
    }
    const oldBindingErrors = validateContractGraph(before.graph, { files: after.files, nodeIds: new Set(after.nodes.map(node => node.id)) }).filter(finding => finding.itemId && oldAcs.some(ac => ac.id === finding.itemId) && ['missing-test-file', 'missing-test-case', 'invalid-test-binding'].includes(finding.code))
    if (oldBindingErrors.length) fail('old_test_binding', oldBindingErrors.map(finding => finding.message).join('\n'))
    const selectedMandatory = (settings: typeof trusted): typeof trusted.mandatoryTests => settings.mandatoryTests.filter(binding => ids.has(binding.verificationId) || ![before.graph, after.graph].some(graph => graph.items.has(binding.verificationId)))
    const oldMandatory = selectedMandatory(oldPolicy), newMandatory = selectedMandatory(trusted)
    const runs: AcceptanceRun[] = []
    const planned: AcceptanceRun[] = []
    for (const [graph, acs, settings] of [[before.graph, oldAcs, oldPolicy], [after.graph, newAcs, trusted]] as const) {
      if (acs.length) planned.push(...planAcceptanceRuns(graph, acs.map(ac => ac.id), settings.verifications))
      planned.push(...planMandatoryRuns(selectedMandatory(settings), settings.verifications))
    }
    for (const run of planned) {
      const key = digest({ ...run.policy, expectedTestIds: [] }), group = runs.find(existing => digest({ ...existing.policy, expectedTestIds: [] }) === key)
      if (group) {
        if (run.bindings.some(binding => group.bindings.some(existing => existing.testId === binding.testId && existing.testPath !== binding.testPath))) fail('ambiguous_test', '旧新运行计划的同名测试ID指向不同文件')
        group.bindings.push(...run.bindings.filter(binding => !group.bindings.some(existing => digest(existing) === digest(binding)))); group.policy.expectedTestIds = sorted([...group.policy.expectedTestIds, ...run.policy.expectedTestIds])
      } else runs.push(structuredClone(run))
    }
    for (const oracle of oldMandatory) {
      if (before.files.get(oracle.testPath) !== after.files.get(oracle.testPath)) fail('oracle_changed', `基线不可改 oracle 被更改: ${oracle.testPath}`)
    }
    for (const oracle of newMandatory) if (policyFiles.get(oracle.testPath) !== after.files.get(oracle.testPath)) fail('oracle_changed', `候选必须保留受信政策版本oracle全文: ${oracle.testPath}`)
    const readPaths = new Set<string>([policyPath, ...changed.filter(path => !isHostPrivatePath(path))])
    for (const frozen of [before, after]) for (const contract of frozen.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId))) {
      readPaths.add(contract.path)
      for (const path of [...contract.code, ...contract.related]) readPaths.add(pathOf(path))
      for (const item of contract.items) { if (item.kind === 'AC') readPaths.add(pathOf(item.test)); if (item.kind !== 'VERIFY' && item.source.kind === 'code') readPaths.add(pathOf(item.source.ref)) }
    }
    for (const settings of [oldPolicy, trusted]) {
      for (const oracle of selectedMandatory(settings)) readPaths.add(oracle.testPath)
      for (const frozen of [before, after]) for (const path of frozen.files.keys()) if (coveredPath(path, settings.readPaths)) readPaths.add(path)
    }
    for (const path of readPaths) for (const [entries, texts] of [[baseEntries, before.files], [candidateEntries, after.files]] as const) {
      if (isHostPrivatePath(path)) fail('unsupported_read_path', `契约读集合不能包含宿主私有资料: ${path}`)
      if (entries.some(entry => entry.path === path) && !texts.has(path)) fail('unsupported_read_format', `独立语义审查必须完整读取UTF-8普通来源，当前路径为链接或二进制: ${path}`)
    }
    result.scope.readPaths = sorted(readPaths)
    const readSet = result.scope.readPaths.map(path => ({ path, before: before.files.get(path) ?? null, candidate: after.files.get(path) ?? null }))
    result.readSetDigest = digest(readSet)
    const context = { identities: result.identities, scope: result.scope, readSetDigest: result.readSetDigest, readSet, oldPolicy, trustedPolicy: trusted, oldContracts: before.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId)), candidateContracts: after.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId)), runs }
    result.inputDigest = digest(context)
    const candidateDigest = digest({ commit: candidate.commit, tree: candidate.tree, entries: candidateEntries })
    const reviewContext = { ...context, inputId: result.inputDigest, candidateDigest }
    const serialized = JSON.stringify(reviewContext)
    writeFileSync(join(evidenceDirectory, 'input.json'), serialized)
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) fail('unsupported_context_budget', `完整候选审查读集合 ${Buffer.byteLength(serialized)} bytes 超过2MiB，不能截断源码或断言`)
    const runner: ElaborationRunner = options.testReviewRunner ?? (async request => (await import('../session-structured.js')).runStructuredSession(request))
    const reviewed = await runCandidateReview({ root, base: base.commit, requestKey: `conformance:${result.inputDigest}:${randomUUID()}`, inputDigest: result.inputDigest, purpose: 'code_review', timeoutMs: trusted.callTimeoutMs ?? trusted.budget.timeoutMs, signal, model: 'gpt-6.1-sol', effort: 'high', schema: GENERATION_REVIEW_SCHEMA,
      prompt: `${CANDIDATE_REVIEW_INSTRUCTIONS}\n这是从真实Git对象重建的独立CI候选检查，没有builder总结或本机passed证据。base∪candidate旧新完整契约和断言同入读集合。candidate raw变化只能是确有业务来源的合法新需求；退役必须由真实raw或上层规则变更支持，旧AC保留原test路径、稳定ID与固定命令，改成验证移除后行为的真实负向断言。逐项核退役来源和负向断言，随意删schema/node/AC/test、弱化raw或断言均repair。新旧所有itemIds均必须checkedIds，retiredIds仍是本次实际待审义务。没有裁决权限，不得用oracle-policy批准命令或oracle更新。缺少调用依赖必须repair。\n冻结完整输入:\n${serialized}` }, runner, { inputId: result.inputDigest, candidateDigest, requiredIds: scope.itemIds, actualIds: scope.itemIds, priorIds: [...before.graph.items.keys()] })
    result.review = reviewed.review; result.trace = reviewed.trace
    if (reviewed.review.verdict !== 'accept') fail('review_rejected', JSON.stringify(reviewed.review.findings))
    if (signal?.aborted) fail('cancelled', '独审后已取消，拒绝运行候选')
    const ref = { tree: candidate.tree, baseTree: base.tree, sourceInputId: result.inputDigest, manifestBlob: writeEvidence(commonDir, { version: 1, entries: candidateEntries }), actualDiffBlob: writeEvidence(commonDir, actualTreeDiff(baseEntries, candidateEntries)), coveredScope: { paths: changed, contractIds: scope.itemIds, flowIds: scope.itemIds.filter(id => (after.graph.items.get(id) ?? before.graph.items.get(id))?.kind === 'FLOW') } }
    const candidateRef: CandidateRef = { ...ref, digest: digest(ref) }
    const exported = exportCandidate(commonDir, candidateRef, join(evidenceDirectory, 'candidate'))
    const exportDigest = await verificationExportDigest(exported.root)
    mkdirSync(join(evidenceDirectory, 'scratch'), { mode: 0o700 })
    for (const [index, run] of runs.entries()) {
      const verification = await executeVerification({ runId: `conformance-${result.inputDigest.slice(0, 16)}-${index}`, inputDigest: result.inputDigest, candidateDigest, candidateExportDigest: exportDigest, candidateExportPath: exported.root, privateScratchRoot: join(evidenceDirectory, 'scratch'), policy: run.policy, signal }, { driver: options.testVerificationDriver, onCheckpoint: async checkpoint => { writeFileSync(join(evidenceDirectory, `${checkpoint.runId}-${checkpoint.phase}.json`), JSON.stringify(checkpoint)) } })
      result.runs.push({ bindings: run.bindings, result: verification })
      if (verification.status !== 'passed') { result.status = verification.status === 'unsupported' ? 'unsupported' : verification.status === 'recovery_required' ? 'recovery_required' : 'failed'; result.diagnostics.push({ code: 'verification', message: verification.reason ?? verification.status }); return result }
    }
    // 再读不可变对象核对输入绑定；不接受调用者/runner 改写结果来替代 V4。
    if (digest(readTree(commonDir, candidate.tree)) !== digest(candidateEntries) || digest(reviewContext) !== digest(JSON.parse(serialized))) fail('input_binding', '冻结候选或完整读集合在检查期间改变')
    result.status = 'passed'
  } catch (error) {
    const cause = error as { code?: string; message?: string }
    const code = cause.code ?? 'conformance_failed'
    result.status = code.startsWith('unsupported') || code === 'sync_configuration_missing' || code === 'unsupported' ? 'unsupported' : 'failed'
    result.diagnostics.push({ code, message: cause.message ?? String(error) })
  } finally { writeFileSync(join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2)) }
  return result
}
