import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpecs, repoRoot, runtimeRoot } from '@spexcode/spec-core'
import type { SessionProtocol } from '@spexcode/session-protocol'
import { configuredSessionApplication } from '../session-application.js'
import { prepareSpecBodyEdit, readSpecBodyEdit } from '../spec-body-edit.js'
import type { SpecBodyEdit } from '../spec-body-edit.js'
import { prepareSyncAdmission, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan } from './coordinator-types.js'
import { migrateSyncStore } from './migrations.js'
import type { BlobRef, InputSnapshot, SyncOperation, WorktreeIdentity } from './operation-types.js'
import { buildSyncApplicationPlan } from './planning.js'
import { claimFileMutex } from './file-mutex.js'
import { guardControlledRequestPath, prepareControlledRequest } from './request-input.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, identifyWorktree, readEvidence, readObject, verifySnapshot } from './snapshot.js'
import { inspectTrustedRuntime } from './trusted-hooks.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'
import { SyncStore, SyncStoreError } from './store.js'

export type SyncSubmitInput = { nodeId: string; requestId: string; origin?: 'spec' | 'initial'; patch?: SpecBodyEdit }
export type SyncOperationDetail = { operation: SyncOperation; attempt: ReturnType<SyncStore['readAttempt']> | null; journals: ReturnType<SyncStore['listJournals']>; stale: boolean; sourceSynced: boolean; executionAvailability: { status: 'ready' | 'recovery_required'; failure?: { code: string; message: string } } }
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
  private readonly runtime: string
  private readonly managedRoot: string
  private readonly artifactRoot: string
  private readonly enabledPath: string
  private readonly running = new Map<string, { controller: AbortController; finished: Promise<void> }>()
  private constructor(root: string, private readonly options: SyncApplicationOptions) {
    const source = identifyWorktree(root)
    this.root = source.canonicalRoot
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
    return new SyncApplication(root, options)
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
  async readSettings(): Promise<{ activation: 'disabled' | 'enabled' | 'invalidated'; enabled: boolean; configuration: ReturnType<typeof readSyncSettings>['settings'] | null; configDigest: string | null; input: WorktreeIdentity; deliveryRoot: string; capabilities: { origins: ['spec', 'initial']; externalWatcher: false; verification: 'docker-node-test' }; configurationError: { code: string; message: string } | null }> {
    const snapshot = await captureInputSnapshot(this.root)
    const activated = existsSync(this.enabledPath)
    const base = { input: snapshot.source, deliveryRoot: this.managedRoot, capabilities: { origins: ['spec', 'initial'] as ['spec', 'initial'], externalWatcher: false as const, verification: 'docker-node-test' as const } }
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
  private detail(operation: SyncOperation, snapshot: InputSnapshot): SyncOperationDetail {
    let executionAvailability: SyncOperationDetail['executionAvailability']
    try { this.executionInputs(operation); executionAvailability = { status: 'ready' } }
    catch (error) { executionAvailability = { status: 'recovery_required', failure: { code: 'sync_execution_metadata_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    return { operation, attempt: operation.currentAttemptId ? this.store.readAttempt(operation.currentAttemptId) : null, journals: this.store.listJournals(operation.id), stale: snapshot.id !== operation.input.id, sourceSynced: operation.phase === 'canonical_synced' && snapshot.id === operation.input.id, executionAvailability }
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
  /** 用户请求独立保存为不可变差量，no-op 不建操作；其它请求直接进入真实 pipeline。 */
  async submit(input: SyncSubmitInput): Promise<{ changed: boolean; operation: SyncOperation | null }> {
    if (!input || typeof input.nodeId !== 'string' || !input.nodeId.trim() || typeof input.requestId !== 'string' || !input.requestId.trim()) throw new SyncApplicationError('sync_request_invalid', '请求需要 nodeId 与稳定 requestId', 400)
    if (input.origin !== undefined && !['spec', 'initial'].includes(input.origin)) throw new SyncApplicationError('sync_origin_unsupported', '当前入口接受 Spec 输入，代码变更分析尚未启用', 400)
    const snapshot = await captureInputSnapshot(this.root)
    this.requireEnabled(snapshot)
    const plan = await buildSyncApplicationPlan(snapshot, input.nodeId)
    let requestBlob: BlobRef | undefined
    if (input.patch) {
      const target = plan.targets.find(target => target.nodeId === input.nodeId)!
      guardControlledRequestPath(snapshot, target.path)
      const prepared = await prepareSpecBodyEdit(this.root, input.nodeId, readSpecBodyEdit(input.patch))
      const request = prepareControlledRequest(snapshot, prepared, { kind: 'user_edit', requestId: input.requestId, nodeId: input.nodeId, intent: input.patch.reason?.trim() || `更新 ${input.nodeId} 正文 ${input.patch.startLine}-${input.patch.endLine} 行：${input.patch.replacement}` })
      if (!request.changed) return { changed: false, operation: null }
      requestBlob = request.requestBlob
    }
    const { settings } = readSyncSettings(snapshot)
    const ingressKey = `application:${snapshot.source.repositoryId}:${this.root}:${input.requestId}`
    const locks = join(this.artifactRoot, '.application-locks'); mkdirSync(locks, { recursive: true, mode: 0o700 })
    const deadline = Date.now() + Math.min(30000, settings.budget.timeoutMs)
    let mutex = claimFileMutex(join(locks, `${contentHash(ingressKey)}.sqlite`))
    while (!mutex) {
      if (Date.now() >= deadline) throw new SyncApplicationError('sync_request_busy', '相同请求正在准备，请使用相同 requestId 重试')
      await new Promise(resolve => setTimeout(resolve, 25))
      mutex = claimFileMutex(join(locks, `${contentHash(ingressKey)}.sqlite`))
    }
    try {
      const prior = this.store.findOperationByIngressKey(ingressKey)
      if (prior && (prior.input.id !== snapshot.id || JSON.stringify(prior.input.source) !== JSON.stringify(snapshot.source) || prior.policyDigest !== syncPlanDigest(plan) || (prior.requestBlob?.sha256 ?? null) !== (requestBlob?.sha256 ?? null))) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: input.requestId, origin: 'spec', budget: settings.budget, managedRoot: this.managedRoot, ...(requestBlob ? { requestBlob } : {}), previousBaselinePair: prior ? prior.previousBaselinePair : this.store.readBaseline(snapshot.source) })
      this.prepareTools(admission.ingressKey, prior)
      const operation = this.store.admitAndEnqueue(admission)
      this.start(operation.id)
      return { changed: true, operation: this.store.readOperation(operation.id) }
    } finally { mutex.release() }
  }
  /** 长流程附着于后端进程；拒绝和环境失败必须持久结算，不能成为悬空 Promise。 */
  start(id: string): void {
    const operation = this.store.readOperation(id); this.assertSource(operation)
    if (this.running.has(id) || completed.has(operation.phase) || operation.control !== 'run') return
    const controller = new AbortController()
    const { plan, tools } = this.executionInputs(operation)
    const { settings } = readSyncSettings(operation.input)
    const finished = runSyncOperation(this.store, id, { plan, readCurrentPlan: async () => {
      const current = await captureInputSnapshot(this.root); this.requireEnabled(current)
      return buildSyncApplicationPlan(current, plan.intentNodeId)
    }, managedRoot: this.managedRoot, artifactRoot: this.artifactRoot, tools, runner: this.options.runner, verificationDriver: this.options.verificationDriver, signal: controller.signal, callTimeoutMs: settings.callTimeoutMs }).then(() => {}).finally(() => { this.running.delete(id) })
    this.running.set(id, { controller, finished })
    // 结算失败本身不能吞掉；后端会得到明确诊断，操作仍保留在 canonical store。
    void finished.catch((error: unknown) => console.error(`sync operation ${id} 无法持久结算：`, error))
  }
  async wait(id: string): Promise<SyncOperationDetail> { await this.running.get(id)?.finished; return this.readOperation(id) }
  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<SyncOperationDetail> {
    const operation = this.store.readOperation(id); this.assertSource(operation)
    if (!['pause', 'resume', 'cancel'].includes(action)) throw new SyncApplicationError('sync_control_invalid', '不支持的同步控制', 400)
    if (action === 'resume') {
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
