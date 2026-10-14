import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpecs, parseContract, parseParts, repoRoot, runtimeRoot } from '@spexcode/spec-core'
import type { SessionProtocol } from '@spexcode/session-protocol'
import { configuredSessionApplication } from '../session-application.js'
import { prepareSpecBodyEdit, readSpecBodyEdit } from '../spec-body-edit.js'
import type { SpecBodyEdit } from '../spec-body-edit.js'
import { prepareSyncAdmission, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan, SyncCoordinatorResult } from './coordinator-types.js'
import { migrateSyncStore } from './migrations.js'
import type { BaselinePair, BlobRef, InputSnapshot, SyncOperation, WorktreeIdentity } from './operation-types.js'
import { buildSyncApplicationPlan } from './planning.js'
import { readDecisionAuthority } from './code-behavior.js'
import { composeAuthoredInput } from './author-input.js'
import { claimFileMutex } from './file-mutex.js'
import { composeControlledRequest, controlledDecisionIdentity, guardControlledRequestPath, prepareControlledDecision, readControlledDecision, prepareControlledRequest } from './request-input.js'
import type { CodeBehaviorAnalysis, SyncDecisionInput } from './writeback-types.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, identifyWorktree, readEvidence, readObject, readTree, verifySnapshot } from './snapshot.js'
import { inspectTrustedRuntime } from './trusted-hooks.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'
import { SyncStore, SyncStoreError } from './store.js'

export type SyncSubmitInput = { nodeId: string; requestId: string; origin?: 'spec' | 'initial' | 'code' | 'combined' | 'decision'; patch?: SpecBodyEdit; retryOf?: string }
export type SyncOperationDetail = { operation: SyncOperation; attempt: ReturnType<SyncStore['readAttempt']> | null; journals: ReturnType<SyncStore['listJournals']>; stale: boolean; sourceSynced: boolean; retryEligibility: ReturnType<SyncStore['readRetryEligibility']>; resources: ReturnType<SyncStore['listRecoverableResources']>[number]['resource'][]; decisionContext: { analysisRef: BlobRef; analysis: CodeBehaviorAnalysis } | null; executionAvailability: { status: 'ready' | 'recovery_required'; failure?: { code: string; message: string } } }
export type SyncApplicationOptions = Partial<Pick<SyncCoordinatorOptions, 'runner' | 'verificationDriver'>> & {
  protocol: SessionProtocol
  runtimeDirectory?: string
  tools?: SyncCoordinatorOptions['tools']
}
type EnabledRecord = { version: 1; source: WorktreeIdentity; configDigest: string; enabledAtMs: number }
type SavedTools = { version: 'sync-tools-v1'; tools: SyncCoordinatorOptions['tools']; runtimeDigest: string | null }
const completed = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced', 'cancelled', 'superseded'])

/** HTTP 与 CLI 共用持久协调入口；应用只持有进程生命周期，不复制协调状态机。 */
export class SyncApplication {
  readonly store: SyncStore
  private readonly root: string
  private readonly repositoryId: string
  private readonly runtime: string
  private readonly managedRoot: string
  private readonly artifactRoot: string
  private readonly enabledPath: string
  private routing: Promise<void> | null = null
  private readonly running = new Map<string, { controller: AbortController; finished: Promise<SyncCoordinatorResult> }>()
  private constructor(root: string, private readonly options: SyncApplicationOptions) {
    const source = identifyWorktree(root)
    this.root = source.canonicalRoot
    this.repositoryId = source.repositoryId
    const directory = options.runtimeDirectory ?? join(runtimeRoot(root), 'sync')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.runtime = realpathSync(directory)
    this.managedRoot = join(this.runtime, 'managed')
    this.artifactRoot = join(this.runtime, 'artifacts')
    for (const owned of [this.runtime, this.managedRoot, this.artifactRoot]) {
      mkdirSync(owned, { recursive: true, mode: 0o700 })
      const stat = lstatSync(owned)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new SyncApplicationError('sync_runtime_unsafe', '同步 runtime 必须是当前用户拥有的独占 0700 目录')
    }
    if (this.runtime === this.root || this.runtime.startsWith(`${this.root}/`)) throw new SyncApplicationError('sync_runtime_unsafe', '同步运行资料不能写入源码树')
    this.enabledPath = join(this.runtime, `enabled-${contentHash(this.root)}.json`)
    this.store = new SyncStore(options.protocol, { readBlob: ref => readEvidence(source.commonDir, ref) })
  }
  static async create(root: string, options: SyncApplicationOptions): Promise<SyncApplication> {
    await migrateSyncStore(options.protocol)
    const application = new SyncApplication(root, options)
    applicationOwners.set(`${options.protocol.databasePath}\0${application.repositoryId}\0${application.root}`, application)
    return application
  }
  private enabled(snapshot: InputSnapshot): EnabledRecord | null {
    if (!existsSync(this.enabledPath)) return null
    let record: EnabledRecord
    try { record = JSON.parse(readFileSync(this.enabledPath, 'utf8')) as EnabledRecord }
    catch { throw new SyncApplicationError('sync_activation_invalid', '同步启用记录无法读取，请重新启用当前授权') }
    if (record?.version !== 1 || !record.source || typeof record.configDigest !== 'string') throw new SyncApplicationError('sync_activation_invalid', '同步启用记录不合法，请重新启用当前授权')
    if (JSON.stringify(record.source) !== JSON.stringify(snapshot.source)) throw new SyncApplicationError('sync_source_changed', '启用时的输入工作树身份已变化，请重新启用')
    return record
  }
  async readSettings(): Promise<{ activation: 'disabled' | 'enabled' | 'invalidated'; enabled: boolean; configuration: ReturnType<typeof readSyncSettings>['settings'] | null; configDigest: string | null; input: WorktreeIdentity; deliveryRoot: string; capabilities: { origins: ['spec', 'initial', 'code', 'combined']; externalWatcher: false; verification: 'docker-node-test' }; configurationError: { code: string; message: string } | null }> {
    const snapshot = await captureInputSnapshot(this.root)
    const activated = existsSync(this.enabledPath)
    const base = { input: snapshot.source, deliveryRoot: this.managedRoot, capabilities: { origins: ['spec', 'initial', 'code', 'combined'] as ['spec', 'initial', 'code', 'combined'], externalWatcher: false as const, verification: 'docker-node-test' as const } }
    try {
      const { settings, configDigest } = readSyncSettings(snapshot), record = this.enabled(snapshot)
      const enabled = record?.configDigest === configDigest
      return { ...base, activation: enabled ? 'enabled' : activated ? 'invalidated' : 'disabled', enabled, configuration: settings, configDigest, configurationError: record && record.configDigest !== configDigest ? { code: 'sync_configuration_changed', message: '授权配置已变化，请重新启用' } : null }
    } catch (error) {
      if (!(error instanceof SyncApplicationError)) throw error
      return { ...base, activation: activated ? 'invalidated' : 'disabled', enabled: false, configuration: null, configDigest: null, configurationError: { code: error.code, message: error.message } }
    }
  }
  /** 仅授权当前已版本化配置；可选摘要防止用户阅读后配置已经被另一编辑者改变。 */
  async enable(expectedConfigDigest?: string): ReturnType<SyncApplication['readSettings']> {
    const snapshot = await captureInputSnapshot(this.root), { configDigest } = readSyncSettings(snapshot)
    if (expectedConfigDigest && expectedConfigDigest !== configDigest) throw new SyncApplicationError('sync_configuration_changed', '启用请求的配置摘要已过期')
    const record: EnabledRecord = { version: 1, source: snapshot.source, configDigest, enabledAtMs: Date.now() }
    const temp = `${this.enabledPath}.${randomUUID()}`
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temp, this.enabledPath)
    return this.readSettings()
  }
  private requireEnabled(snapshot: InputSnapshot): void {
    const record = this.enabled(snapshot), { configDigest } = readSyncSettings(snapshot)
    if (!record) throw new SyncApplicationError('sync_disabled', '请先启用 Spec 驱动同步')
    if (record.configDigest !== configDigest) throw new SyncApplicationError('sync_configuration_changed', '同步授权配置已变化，请重新启用')
  }
  async status(options: { nodeId?: string; limit?: number } = {}): Promise<{ settings: Awaited<ReturnType<SyncApplication['readSettings']>>; operations: SyncOperationDetail[] }> {
    const snapshot = await captureInputSnapshot(this.root)
    const files = new Map(verifySnapshot(snapshot).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const node = options.nodeId ? (await loadSpecs(this.root, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files } })).find(node => node.id === options.nodeId) : null
    const operations = this.store.listOperations(snapshot.source.repositoryId, { sourceRoot: this.root, limit: options.limit ?? 30 })
      .filter(operation => !options.nodeId || operation.scope.contractIds.includes(options.nodeId) || !!node && coveredPath(node.path, operation.scope.paths))
      .map(operation => this.detail(operation, snapshot))
    return { settings: await this.readSettings(), operations }
  }
  private retryEligibility(operation: SyncOperation, snapshot: InputSnapshot): SyncOperationDetail['retryEligibility'] {
    const eligibility = this.store.readRetryEligibility(operation.id)
    if (!eligibility.eligible) return eligibility
    if (!['spec', 'initial', 'code', 'combined', 'decision'].includes(operation.origin)) return { eligible: false, reason: { code: 'sync_origin_unsupported', message: '当前入口接受 Spec 输入，原操作来源不能在此重试' } }
    if (snapshot.id !== operation.input.id || JSON.stringify(snapshot.source) !== JSON.stringify(operation.input.source)) return { eligible: false, reason: { code: 'sync_retry_stale', message: '原输入已变化，请为当前 Spec 发起新操作' } }
    try { this.requireEnabled(snapshot); this.operationPlan(operation) }
    catch (error) { return { eligible: false, reason: { code: error instanceof SyncApplicationError ? error.code : 'sync_retry_plan_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    return eligibility
  }
  private detail(operation: SyncOperation, snapshot: InputSnapshot): SyncOperationDetail {
    let executionAvailability: SyncOperationDetail['executionAvailability']
    try { this.executionInputs(operation); executionAvailability = { status: 'ready' } }
    catch (error) { executionAvailability = { status: 'recovery_required', failure: { code: 'sync_execution_metadata_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    const journals = this.store.listJournals(operation.id), resources = this.store.listRecoverableResources().filter(item => item.operation.id === operation.id).map(item => item.resource)
    const stopped = operation.control !== 'run' || completed.has(operation.phase) || ['paused', 'failed', 'budget_exhausted', 'needs_input', 'conflicted', 'recovery_required'].includes(operation.phase)
    if (executionAvailability.status === 'ready' && stopped && (resources.length || journals.some(journal => journal.status !== 'settled'))) executionAvailability = { status: 'recovery_required', failure: { code: 'sync_resources_unsettled', message: '操作仍有未结算资源或交付日志，请先恢复清理再重试' } }
    return { operation, decisionContext: this.decisionContext(operation), attempt: operation.currentAttemptId ? this.store.readAttempt(operation.currentAttemptId) : null, journals, resources, stale: snapshot.id !== operation.input.id, sourceSynced: operation.phase === 'canonical_synced' && snapshot.id === operation.input.id, retryEligibility: this.retryEligibility(operation, snapshot), executionAvailability }
  }
  /** 只有原操作当前 attempt 的可信分析检查点能成为业务裁决对象。 */
  private decisionContext(operation: SyncOperation): SyncOperationDetail['decisionContext'] {
    if (!operation.currentAttemptId) return null
    const attempt = this.store.readAttempt(operation.currentAttemptId)
    for (const ref of attempt.checkpointRefs) {
      const stage = JSON.parse(readEvidence(operation.input.source.commonDir, ref).toString('utf8')) as { version?: string; stage?: string; operationId?: string; attemptId?: string; inputId?: string; policyDigest?: string; resultRef?: BlobRef }
      if (stage.version !== 'sync-stage-v1' || stage.stage !== 'analysis' || stage.operationId !== operation.id || stage.attemptId !== attempt.id || stage.inputId !== operation.input.id || stage.policyDigest !== operation.policyDigest || !stage.resultRef) continue
      const analysis = JSON.parse(readEvidence(operation.input.source.commonDir, stage.resultRef).toString('utf8')) as CodeBehaviorAnalysis
      if (analysis.version !== 'code-behavior-v1' || analysis.inputId !== operation.input.id || analysis.policyDigest !== operation.policyDigest || analysis.readSetDigest !== operation.readSetDigest || analysis.baselinePairId !== (operation.previousBaselinePair?.id ?? null) || !analysis.reviewPassed) throw new SyncApplicationError('sync_analysis_invalid', '分析证据与原操作冻结输入不一致')
      return { analysisRef: stage.resultRef, analysis }
    }
    return null
  }
  async readOperation(id: string): Promise<SyncOperationDetail> {
    const operation = this.store.readOperation(id)
    this.assertSource(operation)
    return this.detail(operation, await captureInputSnapshot(this.root))
  }
  private assertSource(operation: SyncOperation): void {
    if (operation.input.source.canonicalRoot !== this.root || operation.input.source.repositoryId !== identifyWorktree(this.root).repositoryId) throw new SyncApplicationError('sync_operation_wrong_source', '操作不属于当前输入工作树', 404)
  }
  private operationPlan(operation: SyncOperation): SyncCoordinatorPlan {
    if (!operation.planBlob) throw new SyncApplicationError('sync_plan_unavailable', '旧操作缺少持久固定计划，不能猜测恢复')
    const plan = JSON.parse(readEvidence(operation.input.source.commonDir, operation.planBlob).toString('utf8')) as SyncCoordinatorPlan
    if (syncPlanDigest(plan) !== operation.policyDigest) throw new SyncApplicationError('sync_plan_conflict', '持久应用计划摘要不符')
    return plan
  }
  private executionInputs(operation: SyncOperation): { plan: SyncCoordinatorPlan; tools: SyncCoordinatorOptions['tools'] } {
    const plan = this.operationPlan(operation)
    const { tools } = this.readSavedTools(this.toolsRef(operation.ingressKey))
    for (const owned of [this.runtime, this.managedRoot, this.artifactRoot]) {
      const stat = lstatSync(owned)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new SyncApplicationError('sync_runtime_unsafe', '同步运行目录不再是当前用户独占 0700 目录')
    }
    return { plan, tools }
  }
  private toolsRef(ingressKey: string): string { return join(this.artifactRoot, `application-runtime-${contentHash(ingressKey)}.json`) }
  private toolsBackup(ingressKey: string): string { return join(this.runtime, 'runtimes', contentHash(ingressKey), 'tools.json') }
  private readSavedTools(path: string): SavedTools {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as SavedTools
    if (saved?.version !== 'sync-tools-v1' || !saved.tools || ![saved.tools.trustedRuntimeRoot, saved.tools.toolEntry, saved.tools.canonicalHooksDir].every(path => typeof path === 'string' && path.startsWith('/'))) throw new SyncApplicationError('sync_execution_metadata_invalid', '固定 runtime 描述不合法')
    if (saved.runtimeDigest === null) {
      if (!this.options.tools) throw new SyncApplicationError('sync_execution_metadata_invalid', '生产固定 runtime 缺少完整 manifest 摘要')
    } else if (!/^[a-f0-9]{64}$/.test(saved.runtimeDigest) || contentHash(JSON.stringify(inspectTrustedRuntime(saved.tools.trustedRuntimeRoot))) !== saved.runtimeDigest) throw new SyncApplicationError('sync_execution_runtime_changed', '固定 runtime 实际 manifest 已变化，禁止沿用旧证据')
    return saved
  }
  private prepareTools(ingressKey: string, prior: SyncOperation | null): void {
    const path = this.toolsRef(ingressKey)
    if (existsSync(path)) { this.readSavedTools(path); return }
    const backup = this.toolsBackup(ingressKey)
    if (existsSync(backup)) {
      const saved = this.readSavedTools(backup)
      writeFileSync(path, JSON.stringify(saved), { mode: 0o600, flag: 'wx' })
      return
    }
    if (prior && (prior.currentAttemptId !== null || prior.phase !== 'queued')) throw new SyncApplicationError('sync_execution_metadata_unavailable', '已派发操作缺失原固定工具描述，禁止用当前 runtime 替换旧运行证据')
    const runtimeParent = join(this.runtime, 'runtimes', contentHash(ingressKey)); mkdirSync(runtimeParent, { recursive: true, mode: 0o700 })
    const slot = mkdtempSync(join(runtimeParent, 'trusted-'))
    const frozen = this.options.tools ? null : freezeDeliveryRuntime(join(slot, 'package'))
    const saved: SavedTools = { version: 'sync-tools-v1', tools: this.options.tools ?? frozen!, runtimeDigest: frozen?.digest ?? null }
    const bytes = JSON.stringify(saved)
    writeFileSync(backup, bytes, { mode: 0o600, flag: 'wx' })
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
  }
  private async requestMutex(ingressKey: string, timeoutMs: number) {
    const locks = join(this.artifactRoot, '.application-locks'); mkdirSync(locks, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + Math.min(30000, timeoutMs)
    let mutex = claimFileMutex(join(locks, `${contentHash(ingressKey)}.sqlite`))
    while (!mutex) {
      if (Date.now() >= deadline) throw new SyncApplicationError('sync_request_busy', '相同请求正在准备，请使用相同 requestId 重试')
      await new Promise(resolve => setTimeout(resolve, 25))
      mutex = claimFileMutex(join(locks, `${contentHash(ingressKey)}.sqlite`))
    }
    return mutex
  }
  /** 用户请求独立保存为不可变差量，no-op 不建操作；其它请求直接进入真实 pipeline。 */
  async submit(input: SyncSubmitInput): Promise<{ changed: boolean; operation: SyncOperation | null }> {
    if (!input || typeof input.nodeId !== 'string' || !input.nodeId.trim() || typeof input.requestId !== 'string' || !input.requestId.trim()) throw new SyncApplicationError('sync_request_invalid', '请求需要 nodeId 与稳定 requestId', 400)
    if (input.retryOf !== undefined && (typeof input.retryOf !== 'string' || !input.retryOf.trim())) throw new SyncApplicationError('sync_retry_invalid', '显式重试需要完整旧 operation ID', 400)
    if (input.retryOf && input.patch) throw new SyncApplicationError('sync_retry_changed', '显式重试沿用原正文意图；新的正文修改请发起新请求', 400)
    if (input.origin !== undefined && !['spec', 'initial', 'code', 'combined'].includes(input.origin) && !(input.retryOf && input.origin === 'decision')) throw new SyncApplicationError('sync_origin_unsupported', '输入来源必须为 spec、initial、code 或 combined', 400)
    const snapshot = await captureInputSnapshot(this.root)
    this.requireEnabled(snapshot)
    const retry = input.retryOf ? this.store.readOperation(input.retryOf) : null
    if (retry) {
      this.assertSource(retry)
      const eligibility = this.retryEligibility(retry, snapshot)
      if (!eligibility.eligible) throw new SyncApplicationError(eligibility.reason!.code, eligibility.reason!.message)
      if (this.operationPlan(retry).intentNodeId !== input.nodeId) throw new SyncApplicationError('sync_retry_changed', '显式重试不能改为另一个节点')
    }
    const origin = input.origin ?? retry?.origin ?? 'spec'
    const { settings } = readSyncSettings(snapshot)
    const ingressKey = `application:${snapshot.source.repositoryId}:${this.root}:${input.requestId}`
    const mutex = await this.requestMutex(ingressKey, settings.budget.timeoutMs)
    try {
      const prior = this.store.findOperationByIngressKey(ingressKey), ingress = this.store.findIngressReceipt(ingressKey)
      const previousBaselinePair = prior ? (ingress ?? prior).previousBaselinePair : retry ? retry.previousBaselinePair : this.store.readBaseline(snapshot.source)
      const plan = await buildSyncApplicationPlan(snapshot, input.nodeId, previousBaselinePair)
      if (retry?.origin === 'decision' && retry.requestBlob) this.restoreDecisionPlan(plan, snapshot, retry.requestBlob, previousBaselinePair ?? null)
      if (retry && (origin !== retry.origin || syncPlanDigest(plan) !== retry.policyDigest)) throw new SyncApplicationError('sync_retry_changed', '显式重试必须沿用原来源和授权计划；新的输入请发起新请求')
      let requestBlob: BlobRef | undefined = retry?.requestBlob
      if (input.patch) {
        const target = plan.targets.find(target => target.nodeId === input.nodeId)!
        guardControlledRequestPath(snapshot, target.path)
        const prepared = await prepareSpecBodyEdit(this.root, input.nodeId, readSpecBodyEdit(input.patch))
        const request = prepareControlledRequest(snapshot, prepared, { kind: 'user_edit', requestId: input.requestId, nodeId: input.nodeId, intent: input.patch.reason?.trim() || `更新 ${input.nodeId} 正文 ${input.patch.startLine}-${input.patch.endLine} 行：${input.patch.replacement}` })
        if (!request.changed) return { changed: false, operation: null }
        requestBlob = request.requestBlob
      }
      if (prior && (prior.origin !== origin || (prior.retryOf ?? null) !== (retry?.id ?? null) || prior.input.id !== snapshot.id || JSON.stringify(prior.input.source) !== JSON.stringify(snapshot.source) || prior.policyDigest !== syncPlanDigest(plan) || ((ingress ?? prior).requestBlob?.sha256 ?? null) !== (requestBlob?.sha256 ?? null))) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: input.requestId, origin, ...(retry ? { retryOf: retry.id } : {}), budget: settings.budget, managedRoot: this.managedRoot, ...(requestBlob ? { requestBlob } : {}), previousBaselinePair })
      if (prior) { admission.deliveryPlan = (ingress ?? prior).deliveryPlan; admission.budget = (ingress ?? prior).budget }
      this.prepareTools(admission.ingressKey, prior)
      const operation = this.store.admitAndEnqueue(admission)
      this.start(operation.id)
      return { changed: true, operation: this.store.readOperation(operation.id) }
    } finally { mutex.release() }
  }
  private decorateDecisionPlan(plan: SyncCoordinatorPlan, snapshot: InputSnapshot, input: SyncDecisionInput, analysis: CodeBehaviorAnalysis, requestRef: BlobRef, previousBaselinePair: BaselinePair | null): void {
    const findingIds = [...input.findingIds].sort(), decisionId = controlledDecisionIdentity(input)
    const findings = findingIds.map(id => analysis.findings.find(finding => finding.id === id))
    const selectedRules = [...new Set(findings.flatMap(finding => finding!.ruleIds))].sort()
    const affectedIds = new Set(findings.flatMap(finding => [...finding!.ruleIds, ...finding!.affectedIds]))
    const authority = readDecisionAuthority(snapshot.source.commonDir, requestRef)
    plan.decisionAuthorities = [...(plan.decisionAuthorities ?? []).filter(prior => prior.stableDecisionId !== decisionId), authority]
    const boundary = `本次裁决仅适用于分歧 ${findingIds.join(', ')}，业务规则 ${selectedRules.join(', ') || '该分歧明确指出的未覆盖行为'}；未选中的原需求、其他规则与全部验证政策保持有效。`
    const decisionText = input.decision.choice === 'new_rule' ? input.decision.rule : input.decision.choice === 'keep_intent' ? findings.map(finding => `保持需求：${finding!.originalIntent}；修复与需求不符的代码：${finding!.sourceBehavior}`).join('\n') : findings.map(finding => `采用当前行为并更新需求：${finding!.sourceBehavior}；原需求：${finding!.originalIntent}`).join('\n')
    plan.facts = [...plan.facts, { source: `decision:${decisionId}`, text: `${boundary}\n${decisionText}` }]
    if (input.decision.choice !== 'keep_intent') {
      const authored = composeAuthoredInput(snapshot, previousBaselinePair ?? undefined, { retainConflicts: true }).composed!
      const composed = composeControlledRequest(snapshot, authored, requestRef, { retainConflicts: true }).composed!
      const entries = readTree(snapshot.source.commonDir, composed.tree)
      plan.targets = plan.targets.map(target => {
        const entry = entries.find(entry => entry.path === target.path)
        if (!entry) return target
        const source = readObject(snapshot.source.commonDir, entry.oid).toString('utf8')
        const contract = parseContract({ nodeId: target.nodeId, path: target.path, source }).contract
        if (target.nodeId !== plan.intentNodeId && !affectedIds.has(target.nodeId) && !contract?.items.some(item => affectedIds.has(item.id))) return target
        const raw = target.rawSource ?? parseParts(source)?.rawSource
        if (!raw) throw new SyncApplicationError('sync_decision_intent', '原需求正文不可读取，不能猜测新需求')
        return { ...target, rawSource: `${raw.trim()}\n\n用户裁决（${decisionId}，分析 ${input.analysisRef.sha256}）：\n${boundary}\n以下选择明确替代所选规则中的旧行为要求，其余原文继续有效：\n${decisionText}` }
      })
    }
  }
  private restoreDecisionPlan(plan: SyncCoordinatorPlan, snapshot: InputSnapshot, requestBlob: BlobRef, previousBaselinePair: BaselinePair | null): void {
    const decision = readControlledDecision(snapshot, requestBlob)
    const original = this.store.readOperation(decision.operationId), context = this.decisionContext(original)
    if (!context || context.analysisRef.sha256 !== decision.analysisRef.sha256) throw new SyncApplicationError('sync_decision_analysis', '原操作分析已变化，不能沿用旧裁决')
    this.decorateDecisionPlan(plan, snapshot, decision, context.analysis, requestBlob, previousBaselinePair)
  }
  /** 具体分歧的用户选择建立新协调操作，保留原冲突和 root cause 证据链。 */
  async decide(input: SyncDecisionInput): Promise<{ changed: true; operation: SyncOperation }> {
    if (!input || typeof input.operationId !== 'string') throw new SyncApplicationError('sync_decision_invalid', '裁决需要原 operation ID', 400)
    const original = this.store.readOperation(input.operationId); this.assertSource(original)
    const snapshot = await captureInputSnapshot(this.root); this.requireEnabled(snapshot)
    if (snapshot.id !== original.input.id || input.inputId !== original.input.id) throw new SyncApplicationError('sync_decision_stale', '原输入已变化，不能对旧分歧裁决')
    const context = this.decisionContext(original)
    if (!context || context.analysisRef.sha256 !== input.analysisRef?.sha256) throw new SyncApplicationError('sync_decision_analysis', '裁决分析必须属于原操作的可信当前检查点', 400)
    let requestBlob: BlobRef
    try {
      let originalRequestBlob = original.requestBlob
      if (originalRequestBlob) {
        const saved = JSON.parse(readEvidence(snapshot.source.commonDir, originalRequestBlob).toString('utf8')) as { type?: string }
        if (saved.type === 'sync.decision') originalRequestBlob = readControlledDecision(snapshot, originalRequestBlob).originalRequestBlob
      }
      requestBlob = prepareControlledDecision(snapshot, input, originalRequestBlob)
    }
    catch (error) { throw new SyncApplicationError('sync_decision_invalid', error instanceof Error ? error.message : String(error), 400) }
    const findings = input.findingIds.map(id => context.analysis.findings.find(finding => finding.id === id))
    if (findings.some(finding => !finding)) throw new SyncApplicationError('sync_decision_finding', '裁决只能选择分析中真实存在的分歧', 400)
    const ingressKey = `application:${snapshot.source.repositoryId}:${this.root}:${input.requestId}`
    const { settings } = readSyncSettings(snapshot)
    const mutex = await this.requestMutex(ingressKey, settings.budget.timeoutMs)
    try {
      const prior = this.store.findOperationByIngressKey(ingressKey), ingress = this.store.findIngressReceipt(ingressKey)
      if (prior) {
        if (prior.origin !== 'decision' || ((ingress ?? prior).requestBlob?.sha256 ?? null) !== requestBlob.sha256) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
        return { changed: true, operation: prior }
      }
      if (!['needs_input', 'conflicted', 'superseded'].includes(original.phase) && !original.blockedReason) throw new SyncApplicationError('sync_decision_not_needed', '此操作没有待裁决的具体业务分歧')
      const detail = this.detail(original, snapshot)
      if (detail.executionAvailability.status !== 'ready') throw new SyncApplicationError('sync_resources_unsettled', '请先恢复原操作的未结算资源')
      const previousBaselinePair = this.store.readBaseline(snapshot.source) ?? original.previousBaselinePair
      const plan = await buildSyncApplicationPlan(snapshot, this.operationPlan(original).intentNodeId, previousBaselinePair)
      this.decorateDecisionPlan(plan, snapshot, input, context.analysis, requestBlob, previousBaselinePair)
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: original.rootCauseId, origin: 'decision', budget: settings.budget, managedRoot: this.managedRoot, requestBlob, previousBaselinePair })
      this.prepareTools(ingressKey, null)
      const operation = this.store.admitAndEnqueue(admission)
      if (operation.ingressKey === ingressKey) this.start(operation.id)
      return { changed: true, operation: this.store.readOperation(operation.id) }
    } finally { mutex.release() }
  }
  /** 长流程附着于后端进程；拒绝和环境失败必须持久结算，不能成为悬空 Promise。 */
  start(id: string): void {
    this.assertSource(this.store.readOperation(id))
    if (!this.startNextDispatch()) this.launch(id)
  }
  /** 先沿真实仓库 FIFO，再恢复 canonical store 中已出队的 queued 操作。 */
  private startNextDispatch(): boolean {
    if (this.routing) return true
    let head = this.store.nextDispatch(this.repositoryId)
    while (head && (head.operation.control !== 'run' || completed.has(head.operation.phase))) {
      this.store.discardDispatch(head.operation.id, head.messageId)
      head = this.store.nextDispatch(this.repositoryId)
    }
    const operation = head?.operation ?? this.store.listRecoverable().map(item => item.operation).find(operation =>
      operation.input.source.repositoryId === this.repositoryId && operation.phase === 'queued' && operation.control === 'run' &&
      !applicationOwners.get(this.ownerKey(operation.input.source.canonicalRoot))?.running.has(operation.id))
    if (!operation) return false
    const sourceRoot = operation.input.source.canonicalRoot
    const owner = applicationOwners.get(this.ownerKey(sourceRoot))
    if (owner) owner.launch(operation.id)
    else {
      const id = operation.id
      const routing = configuredSyncApplication(sourceRoot).then(application => application.launch(id)).finally(() => { this.routing = null })
      this.routing = routing
      void routing.catch((error: unknown) => console.error(`sync FIFO ${id} 来源服务不可恢复：`, error))
    }
    return true
  }
  private ownerKey(root: string): string { return `${this.options.protocol.databasePath}\0${this.repositoryId}\0${root}` }
  private launch(id: string, recoveryOnly = false): void {
    const operation = this.store.readOperation(id); this.assertSource(operation)
    if (this.running.has(id) || !recoveryOnly && (completed.has(operation.phase) || operation.control !== 'run')) return
    const controller = new AbortController()
    const { plan, tools } = this.executionInputs(operation)
    const { settings } = readSyncSettings(operation.input)
    let advance = false
    const finished = runSyncOperation(this.store, id, { plan, ...(recoveryOnly ? { recoveryOnly: true } : {}), readCurrentPlan: async () => {
      const current = await captureInputSnapshot(this.root); this.requireEnabled(current)
      const currentPlan = await buildSyncApplicationPlan(current, plan.intentNodeId, operation.previousBaselinePair)
      if (operation.origin === 'decision' && operation.requestBlob) this.restoreDecisionPlan(currentPlan, current, operation.requestBlob, operation.previousBaselinePair)
      return currentPlan
    }, managedRoot: this.managedRoot, artifactRoot: this.artifactRoot, tools, runner: this.options.runner, verificationDriver: this.options.verificationDriver, signal: controller.signal, callTimeoutMs: settings.callTimeoutMs }).then(result => { advance = !recoveryOnly && result.status !== 'busy'; return result }).finally(() => {
      this.running.delete(id)
      if (advance) {
        try { this.startNextDispatch() }
        catch (error) { console.error('sync FIFO 后继操作无法启动，需查询其运行资料恢复诊断：', error) }
      }
    })
    this.running.set(id, { controller, finished })
    // 结算失败本身不能吞掉；后端会得到明确诊断，操作仍保留在 canonical store。
    void finished.catch((error: unknown) => console.error(`sync operation ${id} 无法持久结算：`, error))
  }
  async wait(id: string): Promise<SyncOperationDetail> {
    this.assertSource(this.store.readOperation(id))
    const owners = (): SyncApplication[] => [...applicationOwners.values()].filter(owner => owner.repositoryId === this.repositoryId && owner.options.protocol.databasePath === this.options.protocol.databasePath)
    for (;;) {
      await Promise.all(owners().map(owner => owner.routing))
      const own = this.running.get(id)
      if (own) await own.finished
      const operation = this.store.readOperation(id)
      if (operation.phase !== 'queued' || operation.control !== 'run') return this.readOperation(id)
      const preceding = owners().flatMap(owner => [...owner.running.values()].map(flight => flight.finished))
      if (!preceding.length) return this.readOperation(id)
      await Promise.race(preceding)
    }
  }
  async control(id: string, action: 'pause' | 'resume' | 'cancel' | 'recover'): Promise<SyncOperationDetail> {
    const operation = this.store.readOperation(id); this.assertSource(operation)
    if (!['pause', 'resume', 'cancel', 'recover'].includes(action)) throw new SyncApplicationError('sync_control_invalid', '不支持的同步控制', 400)
    if (action === 'recover') {
      await this.running.get(id)?.finished
      this.launch(id, true)
      const result = await this.running.get(id)!.finished
      if (result.failure) throw new SyncApplicationError(result.failure.code, result.failure.message)
      if (result.status === 'recovery_required') throw new SyncApplicationError('sync_resources_unsettled', '已有资源或交付日志尚未确认结算，请查询实际记录后继续恢复')
    } else if (action === 'resume') {
      await this.running.get(id)?.finished
      const current = await captureInputSnapshot(this.root); this.requireEnabled(current)
      if (current.id !== operation.input.id) throw new SyncApplicationError('sync_input_stale', '恢复输入已变化，请为最新 Spec 发起新操作')
      this.store.requestControl(id, 'run')
      this.start(id)
    } else {
      this.store.requestControl(id, action === 'pause' ? 'pause' : 'cancel')
      this.running.get(id)?.controller.abort()
    }
    return this.readOperation(id)
  }
  async readEvidence(id: string, ref: BlobRef): Promise<unknown> {
    const detail = await this.readOperation(id)
    if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new SyncApplicationError('sync_evidence_unrelated', '证据摘要不合法', 400)
    const references = (value: unknown): string[] => [...JSON.stringify(value).matchAll(/"sha256":"([a-f0-9]{64})"/g)].map(match => match[1])
    const queue = references(detail), seen = new Set<string>()
    let belongs = false
    for (let at = 0; at < queue.length; at++) {
      const hash = queue[at]
      if (seen.has(hash)) continue
      seen.add(hash)
      if (hash === ref.sha256) { belongs = true; break }
      queue.push(...references(JSON.parse(readEvidence(detail.operation.input.source.commonDir, { sha256: hash }).toString('utf8')) as unknown))
    }
    if (!belongs) throw new SyncApplicationError('sync_evidence_unrelated', '证据不属于此操作的可查询结果', 404)
    return JSON.parse(readEvidence(detail.operation.input.source.commonDir, ref).toString('utf8')) as unknown
  }
}
const applicationOwners = new Map<string, SyncApplication>()
const applications = new Map<string, Promise<SyncApplication>>()
/** 生产入口只使用现有 canonical session protocol；不新建队列或数据库。 */
export function configuredSyncApplication(root: string): Promise<SyncApplication> {
  const identity = identifyWorktree(root), key = `${identity.repositoryId}:${identity.canonicalRoot}`
  if (identity.commonDir !== identifyWorktree(repoRoot()).commonDir) throw new SyncApplicationError('sync_project_mismatch', '输入工作树不属于当前后端项目')
  let application = applications.get(key)
  if (!application) {
    application = SyncApplication.create(identity.canonicalRoot, { protocol: configuredSessionApplication().protocol })
    applications.set(key, application)
    void application.catch(() => applications.delete(key))
  }
  return application
}
