import { finiteSyncBudget } from './budget.js'
import { randomUUID } from 'node:crypto'
import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runtimeRoot } from '@spexcode/spec-core'
import { contractImpact, dependencyClosure, validateContractGraph } from '@spexcode/spec-core/contracts'
import type { Acceptance, ContractGraph } from '@spexcode/spec-core/contracts'
import { FROZEN_PROMPT_THRESHOLD_BYTES, prepareFrozenPrompt } from '../frozen-context.js'
import { llmManagerRequested, LlmManagerHostError, resolveManagedRoute } from '../llm-manager-host.js'
import { managedFrozenCapability, managedModel, managedRoute, type ManagedRoute } from '../llm-manager-route.js'
import { structuredExecutionPolicy } from '../session-structured-policy.js'
import { DEFAULT_SYNC_MODEL } from './model-selection.js'
import { actualTreeDiff, exportCandidate, isHostPrivatePath } from './candidate.js'
import { CANDIDATE_REVIEW_INSTRUCTIONS, GENERATION_REVIEW_SCHEMA, runCandidateReview } from './candidate-review.js'
import { isUtf8Text } from './composition.js'
import type { ElaborationRunner, ElaborationSessionRequest, ElaborationSessionResult, ElaborationTrace } from './elaboration-types.js'
import { readFrozenContracts } from './frozen-contracts.js'
import type { FrozenContracts } from './frozen-contracts.js'
import type { GenerationReview } from './generation-types.js'
import { bindIntentAuthorizations, INTENT_AUTHORIZATION_PATH, rawIntentChanges } from './intent-authorization.js'
import type { IntentAuthorizationCheck } from './intent-authorization.js'
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
  intentAuthorization: IntentAuthorizationCheck
  scope: { nodeIds: string[]; itemIds: string[]; acceptanceIds: string[]; retiredIds: string[]; readPaths: string[] }
  unmanagedPaths: string[]
  /** 映射覆盖与本次影响范围的通过分开；不能从scope通过推断全项目同步。 */
  coverage: { mapping: 'unconfigured' | 'partial' | 'complete'; governedNodeIds: string[]; uncoveredNodeIds: string[]; governedPaths: string[]; uncoveredPaths: string[] }
  verificationExtent: 'affected_scope'
  reviewExecution: 'native' | 'injected'
  reviewRoute?: ManagedRoute
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
    encoding: 'utf8', env: conformanceGitEnvironment(), maxBuffer: 16 * 1024 * 1024,
  }).trim()
}

function conformanceGitEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

type NativeReviewRequest = Omit<ElaborationSessionRequest, 'signal'>
type NativeReviewReply = { result: ElaborationSessionResult } | { diagnostic: ConformanceResult['diagnostics'][number]; stoppedQuota?: { sessionId: string; threadId?: string; turnId?: string } }

/** 原生创建/回收以当前进程 Git 根和 session store 为权威，故每次检查使用独立进程和证据库。 */
async function isolatedNativeReview(request: ElaborationSessionRequest, commonDir: string, evidenceDirectory: string): Promise<NativeReviewReply> {
  const { signal, ...frozen } = request
  if (signal?.aborted) fail('cancelled', '独审派发前已取消')
  const realm = mkdtempSync(join(evidenceDirectory, 'review-')), checkout = join(realm, 'source'), runtime = join(realm, 'runtime')
  mkdirSync(runtime, { mode: 0o700 })
  git(commonDir, ['update-ref', 'refs/heads/conformance-seed', frozen.base!])
  git(commonDir, ['clone', '--quiet', '--template=', '--no-checkout', '--depth=1', '--branch', 'conformance-seed', pathToFileURL(commonDir).href, checkout])
  git(checkout, ['remote', 'remove', 'origin'])
  git(checkout, ['config', 'core.hooksPath', '/dev/null'])
  git(checkout, ['config', 'core.fsmonitor', 'false'])
  const env = { ...conformanceGitEnvironment(), SPEXCODE_HOME: runtime, SPEX_SESSION_DATABASE_PATH: join(runtime, 'sessions.sqlite'), SPEXCODE_TMUX: `spex-check-${randomUUID()}`, SPEX_SESSION_CONFIG: undefined, SPEXCODE_SESSION_ID: undefined, SPEXCODE_TMUX_RECORD: undefined }
  const entry = fileURLToPath(import.meta.url)
  const worker = fork(entry, ['--conformance-native-worker'], {
    cwd: checkout, env, execArgv: entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let reply: NativeReviewReply | undefined
  const cancel = (): void => { if (worker.connected) worker.send('cancel', () => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await new Promise<NativeReviewReply>((resolve, reject) => {
      worker.on('message', (message: NativeReviewReply) => { reply = message })
      worker.once('error', reject)
      worker.once('exit', (code, endingSignal) => {
        if (code === 0 && reply) resolve(reply)
        else reject(new Error(`独审进程未交付正式终态（${endingSignal ?? code}）`))
      })
      worker.send({ ...frozen, root: checkout }, error => { if (error) reject(error) })
      if (signal?.aborted) cancel()
    }).catch((error: Error) => fail('native_review_recovery_required', `${error.message}，保留独审证据目录 ${realm}`))
  } finally { signal?.removeEventListener('abort', cancel) }
}

async function runNativeReviewWorker(request: NativeReviewRequest, signal: AbortSignal): Promise<NativeReviewReply> {
  const { nativeWorktreePrompt, nativeWorktreeResult } = await import('../native-worktree-runtime.js')
  const { readRecord } = await import('../session-record.js')
  const { withoutSessionApplicationExecutionWake } = await import('../session-application.js')
  const { closeSession, pendingSessionCreateWorktreePaths, readSessionCreateTermination, sessionIdForCreateKey } = await import('../sessions.js')
  const { cancelStructuredSession, runStructuredSession, StructuredSessionError } = await import('../session-structured.js')
  const id = sessionIdForCreateKey(request.requestKey), commonDir = join(request.root, '.git')
  let reply: NativeReviewReply
  let quota: InstanceType<typeof StructuredSessionError> | undefined
  try { reply = { result: await runStructuredSession({ ...request, signal }) } }
  catch (error) {
    if (error instanceof StructuredSessionError && error.code === 'provider_quota_exhausted') quota = error
    const cause = error as { code?: string; message?: string }
    reply = { diagnostic: { code: cause.code ?? 'native_review_failed', message: cause.message ?? String(error) } }
  }
  try {
    let record = readRecord(id)
    if (!record) {
      const termination = readSessionCreateTermination(request.requestKey)
      if ('result' in reply || termination?.cleanupComplete === false || pendingSessionCreateWorktreePaths().size || git(request.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length !== 1)
        throw new Error('独审工作树缺少正式会话记录')
      return reply
    }
    const execution = record.structuredExecution!
    const route = managedRoute(request.model)
    if ('diagnostic' in reply && quota && request.worktree?.mode === 'read' && route
      && execution.state === 'failed' && execution.cancellation?.nativeStopped && execution.errorCode === quota.code && execution.error === quota.message
      && quota.sessionId === id && execution.threadId === quota.threadId && execution.turnId === quota.turnId) {
      const { pinSyncNativeRequest } = await import('./native-run.js')
      const frozen = route.frozenReader ? prepareFrozenPrompt(request, { directory: join(runtimeRoot(), 'frozen-context-v2') }) : undefined
      const expected = structuredExecutionPolicy(frozen ? { ...frozen, readerRuntime: execution.readerRuntime } : pinSyncNativeRequest(request, null))
      const payloadHash = digest({ prompt: frozen?.prompt ?? nativeWorktreePrompt(request.prompt, request.worktree), parent: null, launcher: null, base: request.worktree.baseCommit, structuredExecution: expected })
      if (record.createRequestId === contentHash(request.requestKey) && record.createPayloadHash === payloadHash && digest(structuredExecutionPolicy(execution)) === digest(expected))
        reply.stoppedQuota = { sessionId: id, threadId: quota.threadId, turnId: quota.turnId }
    }
    if (execution.state !== 'completed' && !execution.cancellation?.nativeStopped) {
      const stop = await cancelStructuredSession(id, { wakeQueue: false })
      if (!stop.nativeStopped) throw new Error(stop.error ?? '精确原生停止未证实')
      record = readRecord(id)!
    }
    const worktree = 'result' in reply ? reply.result.worktree : undefined
    if ('result' in reply && (reply.result.sessionId !== id || request.worktree && !worktree)) throw new Error('独审结果缺少本次冻结 Git 身份')
    if ('result' in reply && route?.frozenReader && reply.result.frozenReadProof?.version !== 2)
      reply = { diagnostic: { code: 'stale_result', message: '独审结果缺少本次冻结内容的完整可见性证明' } }
    const settled = request.worktree && record.structuredExecution?.state !== 'timeout' ? { record, commonDir, ...(worktree ? { worktree } : {}) } : undefined
    if (!settled && request.worktree) nativeWorktreeResult(record.worktreePath, request.worktree)
    await withoutSessionApplicationExecutionWake(() => closeSession(id, undefined, { wakeQueue: false, ...(settled ? { settled } : {}) }))
    const closed = readRecord(id)
    if (!closed?.archived || existsSync(record.worktreePath)) throw new Error('独审工作树尚未正式回收')
    if (route?.frozenReader && closed.structuredExecution?.threadId) {
      const { releaseManagedFrozenReviewRealm } = await import('../codex-harness.js')
      await releaseManagedFrozenReviewRealm(closed)
    }
    return reply
  } catch (error) {
    return { diagnostic: { code: 'native_review_recovery_required', message: `独审会话 ${id} 尚未结算，保留原件。${error instanceof Error ? error.message : String(error)}` } }
  }
}

if (process.send && process.argv[2] === '--conformance-native-worker') {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.once('disconnect', abort)
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  process.once('message', async (request: NativeReviewRequest) => {
    process.on('message', message => { if (message === 'cancel') abort() })
    const response = await runNativeReviewWorker(request, controller.signal)
    writeFileSync(join(dirname(request.root), 'native-result.json'), JSON.stringify(response), { mode: 0o600 })
    if (process.connected) process.send!(response, () => process.disconnect?.())
  })
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
  const result: ConformanceResult = { version: 'sync-conformance-v1', status: 'failed', applicable: false, identities: null, inputDigest: null, readSetDigest: null, intentAuthorization: { artifactPath: INTENT_AUTHORIZATION_PATH, artifactDigest: null, changes: [] }, scope: { nodeIds: [], itemIds: [], acceptanceIds: [], retiredIds: [], readPaths: [] }, unmanagedPaths: [], coverage: { mapping: 'unconfigured', governedNodeIds: [], uncoveredNodeIds: [], governedPaths: [], uncoveredPaths: [] }, verificationExtent: 'affected_scope', reviewExecution: options.testReviewRunner ? 'injected' : 'native', verificationExecution: options.testVerificationDriver ? 'injected' : 'docker', review: null, trace: null, runs: [], diagnostics: [], evidenceDirectory }
  try {
    if (signal?.aborted) fail('cancelled', '检查已取消')
    const root = realpathSync(input.repository), sourceCommon = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
    // 只复用不可变 Git 对象；所有 protocol blob 和 refs 均留在独立临时库。
    const commonDir = mkdtempSync(join(evidenceDirectory, 'objects-'))
    git(commonDir, ['init', '--bare', '--quiet', '--template=', `--object-format=${git(root, ['rev-parse', '--show-object-format'])}`])
    writeFileSync(join(commonDir, 'objects/info/alternates'), `${join(sourceCommon, 'objects')}\n`)
    const base = commit(commonDir, input.baseCommit), candidate = commit(commonDir, input.candidateCommit), policy = commit(commonDir, input.policyCommit)
    const baseEntries = readTree(commonDir, base.tree), candidateEntries = candidate.tree === base.tree ? baseEntries : readTree(commonDir, candidate.tree)
    const policyEntries = policy.tree === base.tree ? baseEntries : policy.tree === candidate.tree ? candidateEntries : readTree(commonDir, policy.tree)
    result.identities = { baseCommit: base.commit, candidateCommit: candidate.commit, policyCommit: policy.commit, baseTree: base.tree, candidateTree: candidate.tree, policyTree: policy.tree }
    const before = await readFrozenContracts(root, files(commonDir, baseEntries), new Set(baseEntries.map(entry => entry.path)))
    const after = candidate.tree === base.tree ? before : await readFrozenContracts(root, files(commonDir, candidateEntries), new Set(candidateEntries.map(entry => entry.path)))
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
    const scope = scopeOf(before, after, effectiveChanged, changed.includes(policyPath) || digest(baseSettings) !== digest(trustedSettings) || dependencyChanged || unknownOracleChanged)
    result.scope.nodeIds = scope.nodeIds; result.scope.itemIds = scope.itemIds
    const intentChanges = rawIntentChanges(before.files, after.files, [...before.contracts, ...after.contracts].filter(contract => scope.nodeIds.includes(contract.nodeId)).map(contract => contract.path))
    result.intentAuthorization = bindIntentAuthorizations(intentChanges, undefined)
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
    const intentPolicy = policyFiles.get(INTENT_AUTHORIZATION_PATH)
    if (policyEntries.some(entry => entry.path === INTENT_AUTHORIZATION_PATH) && intentPolicy === undefined) fail('invalid_intent_authorizations', '受信原意授权文件必须是普通 UTF-8 Git 对象')
    result.intentAuthorization = bindIntentAuthorizations(intentChanges, intentPolicy)
    const unauthorized = result.intentAuthorization.changes.filter(change => change.authorization === null)
    if (unauthorized.length) fail('intent_unauthorized', `受信 policyCommit 未授权精确原意差量: ${JSON.stringify(unauthorized)}`)
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
    const context = { identities: result.identities, scope: result.scope, readSetDigest: result.readSetDigest, readSet, intentAuthorization: result.intentAuthorization, intentChanges, oldPolicy, trustedPolicy: trusted, oldContracts: before.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId)), candidateContracts: after.contracts.filter(contract => scope.nodeIds.includes(contract.nodeId)), runs }
    result.inputDigest = digest(context)
    const candidateDigest = digest({ commit: candidate.commit, tree: candidate.tree, entries: candidateEntries })
    const reviewContext = { ...context, inputId: result.inputDigest, candidateDigest }
    const serialized = JSON.stringify(reviewContext)
    writeFileSync(join(evidenceDirectory, 'input.json'), serialized)
    const prompt = `${CANDIDATE_REVIEW_INSTRUCTIONS}\n这是从真实Git对象重建的独立CI候选检查，没有builder总结或本机passed证据。base∪candidate旧新完整契约和断言同入读集合。intentAuthorization仅来自外部可信调用者选定的policyCommit，程序已精确匹配intentChanges的path及旧新raw摘要；此登记批准该具体原意差量，source是来源说明而非身份签名，候选自带记录不提供权限。授权不证明实现正确；仍须核对完整旧新raw、实现、规则及断言。退役必须由授权raw或上层规则变更支持，旧AC保留原test路径、稳定ID与固定命令，改成验证移除后行为的真实负向断言。逐项核退役来源和负向断言，随意删schema/node/AC/test、弱化未授权raw或断言均repair。新旧所有itemIds均必须checkedIds，retiredIds仍是本次实际待审义务。没有裁决权限，不得用oracle-policy批准命令或oracle更新。缺少调用依赖必须repair。\n冻结完整输入:\n${serialized}`
    const capability = Buffer.byteLength(prompt, 'utf8') > FROZEN_PROMPT_THRESHOLD_BYTES ? managedFrozenCapability : undefined
    if (!options.testReviewRunner && llmManagerRequested()) {
      if (signal?.aborted) fail('cancelled', '独审选路前已取消')
      const route = await resolveManagedRoute(undefined, undefined, undefined, capability).catch(error => {
        if (capability && error instanceof LlmManagerHostError && ['llm_manager_invalid', 'llm_manager_native_capability_mismatch', 'llm_manager_native_capability_unavailable'].includes(error.code)) return null
        if (error instanceof LlmManagerHostError) return fail(`unsupported_${error.code}`, 'LLM Manager 无法为候选独审完成正式选路')
        throw error
      })
      if (capability && !route) fail('unsupported_managed_frozen_reader', 'LLM Manager 功能组没有可证明完整冻结读取的就绪路线，已保留全部输入以供复验')
      result.reviewRoute = route ?? fail('unsupported_llm_manager_no_ready_route', 'LLM Manager 功能组没有可用于候选独审的就绪路线')
    }
    const route = result.reviewRoute
    const keyPrefix = `conformance:${result.inputDigest}:`
    const runner: ElaborationRunner = options.testReviewRunner ?? (async request => {
      let current = route, dispatch = request
      const usedRoutes = new Set<string>()
      while (true) {
        if (current) usedRoutes.add(current.routeId)
        const response = await isolatedNativeReview(dispatch, commonDir, evidenceDirectory)
        if ('result' in response) return response.result
        if (!current || !response.stoppedQuota) return fail(response.diagnostic.code, response.diagnostic.message)
        if (signal?.aborted) fail('cancelled', '独审续路前已取消')
        const successor = await resolveManagedRoute(current, route, response.stoppedQuota.sessionId, current.frozenReader?.capability).catch(error => {
          if (error instanceof LlmManagerHostError) return fail(`unsupported_${error.code}`, 'LLM Manager 无法确认原独审额度或完成正式续路')
          throw error
        })
        current = successor ?? fail('unsupported_llm_manager_no_review_successor', 'LLM Manager 功能组没有可用于同一候选的额度后继')
        if (usedRoutes.has(current.routeId)) fail('unsupported_llm_manager_review_route_reused', 'LLM Manager 为同一候选返回了已使用的路线')
        result.reviewRoute = current
        dispatch = { ...request, requestKey: `${keyPrefix}${randomUUID()}`, model: managedModel(current) }
      }
    })
    const reviewed = await runCandidateReview({ root, base: route ? candidate.commit : base.commit, requestKey: `${keyPrefix}${randomUUID()}`, inputDigest: result.inputDigest, purpose: 'code_review', timeoutMs: trusted.callTimeoutMs ?? finiteSyncBudget(trusted.budget)?.timeoutMs ?? 120_000, signal, schema: GENERATION_REVIEW_SCHEMA, prompt,
      ...(route ? { model: managedModel(route), worktree: { baseCommit: candidate.commit, tree: candidate.tree, mode: 'read' as const } } : { model: DEFAULT_SYNC_MODEL, effort: 'high' as const }) }, runner, { inputId: result.inputDigest, candidateDigest, requiredIds: scope.itemIds, actualIds: scope.itemIds, priorIds: [...before.graph.items.keys()] })
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
    result.status = code === 'native_review_recovery_required' ? 'recovery_required' : code.startsWith('unsupported') || code === 'sync_configuration_missing' ? 'unsupported' : 'failed'
    result.diagnostics.push({ code, message: cause.message ?? String(error) })
  } finally { writeFileSync(join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2)) }
  return result
}
