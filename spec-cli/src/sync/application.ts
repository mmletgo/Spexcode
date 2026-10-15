import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpecs, parseContract, parseParts, processStartToken, repoRoot, runtimeRoot } from '@spexcode/spec-core'
import type { SessionProtocol } from '@spexcode/session-protocol'
import { configuredSessionApplication } from '../session-application.js'
import { prepareSpecBodyEdit, readSpecBodyEdit } from '../spec-body-edit.js'
import type { SpecBodyEdit } from '../spec-body-edit.js'
import { isSyncInputCurrent, prepareSyncAdmission, readCurrentSyncAnalysis, runSyncOperation, syncPlanDigest } from './coordinator.js'
import type { SyncCoordinatorOptions, SyncCoordinatorPlan, SyncCoordinatorResult } from './coordinator-types.js'
import { migrateSyncStore } from './migrations.js'
import type { BaselinePair, BlobRef, FrozenBaselineSelection, InputSnapshot, PhysicalControl, PhysicalScope, SyncObserverHealth as PersistentObserverHealth, SyncObservation, SyncOperation, WorktreeIdentity } from './operation-types.js'
import { buildSyncApplicationPlan, deriveSyncBaselineResources } from './planning.js'
import { readDecisionAuthority } from './code-behavior.js'
import { readCompositionEvidence, type SelectedCompositionEvidence } from './composition.js'
import { composeAuthoredInput } from './author-input.js'
import { claimFileMutex } from './file-mutex.js'
import { composeControlledRequest, controlledDecisionIdentity, guardControlledRequestPath, prepareControlledDecision, readControlledDecision, prepareControlledRequest, renderControlledDecisionRaw } from './request-input.js'
import type { CodeBehaviorAnalysis, SyncDecisionInput } from './writeback-types.js'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { captureInputSnapshot, contentHash, identifyWorktree, readEvidence, readObject, readPhysicalFingerprint, readTree, verifySnapshot, writeEvidence } from './snapshot.js'
import { inspectTrustedRuntime } from './trusted-hooks.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'
import { SyncInputObserver, type SyncObserverHealth } from './observer.js'
import { SyncStore, SyncStoreError } from './store.js'

export type SyncScopeCoverage = { includedNodeIds: string[]; contextNodeIds: string[]; missingNodeIds: string[]; excludedNodeIds: string[]; totalNodeCount: number }
export type SyncSubmitInput = { nodeId: string; requestId: string; origin?: 'spec' | 'initial' | 'code' | 'combined' | 'decision'; patch?: SpecBodyEdit; retryOf?: string }
export type SyncOperationDetail = { operation: SyncOperation; physicalControl: PhysicalControl; attempt: ReturnType<SyncStore['readAttempt']> | null; journals: ReturnType<SyncStore['listJournals']>; stale: boolean; sourceSynced: boolean; retryEligibility: ReturnType<SyncStore['readRetryEligibility']>; decisionEligibility: ReturnType<SyncStore['readDecisionEligibility']>; resources: ReturnType<SyncStore['listRecoverableResources']>[number]['resource'][]; decisionContext: { analysisRef: BlobRef; analysis: CodeBehaviorAnalysis } | null; executionAvailability: { status: 'ready' | 'recovery_required'; failure?: { code: string; message: string } } }
export type SyncApplicationOptions = Partial<Pick<SyncCoordinatorOptions, 'runner' | 'verificationDriver'>> & {
  protocol: SessionProtocol
  runtimeDirectory?: string
  tools?: SyncCoordinatorOptions['tools']
}
type EnabledRecord = { registeredNodeIds?: string[]; version: 1; source: WorktreeIdentity; configDigest: string; enabledAtMs: number }
type SavedTools = { version: 'sync-tools-v1'; tools: SyncCoordinatorOptions['tools']; runtimeDigest: string | null }
function enabledSources(runtime: string): EnabledRecord[] {
  if (!existsSync(runtime)) return []
  return readdirSync(runtime).filter(name => /^enabled-[a-f0-9]+\.json$/.test(name)).map(name => {
    const record = JSON.parse(readFileSync(join(runtime, name), 'utf8')) as EnabledRecord
    if (record.version !== 1 || !record.source || typeof record.configDigest !== 'string') throw new SyncApplicationError('sync_activation_invalid', '同步启用记录不合法')
    return record
  })
}
function observerProcessAlive(health: PersistentObserverHealth | null): boolean {
  const tokenEnd = health?.instanceId.lastIndexOf('|') ?? -1
  return !!health && tokenEnd > 0 && processStartToken(health.processId) === health.instanceId.slice(0, tokenEnd)
}
const completed = new Set(['workspace_synced', 'awaiting_landing', 'canonical_synced', 'cancelled', 'superseded'])

/** HTTP 与 CLI 共用持久协调入口；应用只持有进程生命周期，不复制协调状态机。 */
export class SyncApplication {
  readonly store: SyncStore
  private readonly sourceAtCreation: WorktreeIdentity
  private readonly root: string
  private readonly repositoryId: string
  private readonly runtime: string
  private readonly managedRoot: string
  private readonly artifactRoot: string
  private readonly enabledPath: string
  private observerIdentity: { instanceId: string; source: WorktreeIdentity; startedAtMs: number } | null = null
  private stopped = false
  private observer: SyncInputObserver | null = null
  private observerHealth: SyncObserverHealth = { status: 'offline', watchOnline: false, reason: { code: 'sync_service_offline', message: '同步观察服务未运行' }, lastScanAtMs: null }
  private latestObservation: SyncObservation | null = null
  private latestSnapshot: InputSnapshot | null = null
  private scopeCoverage = { includedNodeIds: [] as string[], contextNodeIds: [] as string[], missingNodeIds: [] as string[], excludedNodeIds: [] as string[], totalNodeCount: 0 }
  private readonly registeredNodes = new Set<string>()
  private readonly observedPlans = new Map<string, { inputId: string; headsDigest: string; plan: SyncCoordinatorPlan; selection: FrozenBaselineSelection }>()
  private readonly observedDifferences = new Map<string, { key: string; changed: boolean; specChanged: boolean; codeChanged: boolean; latestDifferenceDigest: string }>()
  private routing: Promise<void> | null = null
  private readonly running = new Map<string, { controller: AbortController; finished: Promise<SyncCoordinatorResult> }>()
  private constructor(root: string, private readonly options: SyncApplicationOptions, registeredSource?: WorktreeIdentity) {
    const source = registeredSource ?? identifyWorktree(root)
    this.sourceAtCreation = source
    this.root = source.canonicalRoot
    this.repositoryId = source.repositoryId
    const directory = options.runtimeDirectory ?? join(runtimeRoot(registeredSource ? repoRoot() : root), 'sync')
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
  static async create(root: string, options: SyncApplicationOptions, registeredSource?: WorktreeIdentity): Promise<SyncApplication> {
    await migrateSyncStore(options.protocol)
    const application = new SyncApplication(root, options, registeredSource)
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
  async readSettings(): Promise<{ activation: 'disabled' | 'enabled' | 'invalidated'; enabled: boolean; configuration: ReturnType<typeof readSyncSettings>['settings'] | null; configDigest: string | null; input: WorktreeIdentity; deliveryRoot: string; capabilities: { origins: ['spec', 'initial', 'code', 'combined']; externalWatcher: true; verification: 'docker-node-test' }; configurationError: { code: string; message: string } | null }> {
    if (!existsSync(this.root)) return { activation: existsSync(this.enabledPath) ? 'invalidated' : 'disabled', enabled: false, configuration: null, configDigest: null, input: this.sourceAtCreation, deliveryRoot: this.managedRoot, capabilities: { origins: ['spec', 'initial', 'code', 'combined'], externalWatcher: true, verification: 'docker-node-test' }, configurationError: { code: 'sync_source_missing', message: '已注册输入工作树不存在' } }
    const snapshot = await captureInputSnapshot(this.root)
    const activated = existsSync(this.enabledPath)
    const base = { input: snapshot.source, deliveryRoot: this.managedRoot, capabilities: { origins: ['spec', 'initial', 'code', 'combined'] as ['spec', 'initial', 'code', 'combined'], externalWatcher: true as const, verification: 'docker-node-test' as const } }
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
    const snapshot = await captureInputSnapshot(this.root), { configDigest, settings } = readSyncSettings(snapshot)
    if (expectedConfigDigest && expectedConfigDigest !== configDigest) throw new SyncApplicationError('sync_configuration_changed', '启用请求的配置摘要已过期')
    const nodes = await this.frozenNodes(snapshot)
    const roots = this.selectRegisteredNodes(nodes, settings, snapshot)
    if (!roots.length) throw new SyncApplicationError('sync_scope_unregistered', '没有受授权源码/测试治理的节点；新需求请在 sync.nodeIds 明确登记意图节点')
    const record: EnabledRecord = { version: 1, source: snapshot.source, configDigest, enabledAtMs: Date.now(), registeredNodeIds: roots.map(node => node.id) }
    const temp = `${this.enabledPath}.${randomUUID()}`
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temp, this.enabledPath)
    if (this.observerIdentity && this.observerIdentity.source.physicalFingerprint !== snapshot.source.physicalFingerprint) await this.stopService()
    if (syncServicesOnline && !this.observer) await this.startService()
    else if (this.observer) await this.observer.scanNow()
    return this.readSettings()
  }
  private requireEnabled(snapshot: InputSnapshot, operation?: SyncOperation): void {
    const record = this.enabled(snapshot), { configDigest } = readSyncSettings(snapshot)
    if (!record) throw new SyncApplicationError('sync_disabled', '请先启用 Spec 驱动同步')
    if (record.configDigest !== configDigest) throw new SyncApplicationError('sync_configuration_changed', '同步授权配置已变化，请重新启用')
    if (operation && readSyncSettings(operation.input).configDigest !== configDigest) throw new SyncApplicationError('sync_configuration_changed', '原操作的可信配置已变化，请为当前配置发起新请求')
  }
  async status(options: { nodeId?: string; limit?: number } = {}): Promise<{ settings: Awaited<ReturnType<SyncApplication['readSettings']>>; operations: SyncOperationDetail[]; observation: ReturnType<SyncApplication['observationStatus']>; sources: ReturnType<SyncApplication['registeredSources']> }> {
    if (!existsSync(this.root)) {
      const operations = await Promise.all(this.store.listOperations(this.repositoryId, { sourceRoot: this.root, limit: options.limit ?? 30 }).filter(operation => !options.nodeId || operation.scope.contractIds.includes(options.nodeId)).map(operation => this.detail(operation, this.latestSnapshot ?? operation.input)))
      return { settings: await this.readSettings(), operations, observation: this.observationStatus(), sources: this.registeredSources() }
    }
    const snapshot = await captureInputSnapshot(this.root)
    const files = new Map(verifySnapshot(snapshot).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const node = options.nodeId ? (await loadSpecs(this.root, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files } })).find(node => node.id === options.nodeId) : null
    const operations = await Promise.all(this.store.listOperations(snapshot.source.repositoryId, { sourceRoot: this.root, limit: options.limit ?? 30 })
      .filter(operation => !options.nodeId || operation.scope.contractIds.includes(options.nodeId) || !!node && coveredPath(node.path, operation.scope.paths))
      .map(operation => this.detail(operation, snapshot)))
    return { settings: await this.readSettings(), operations, observation: this.observationStatus(), sources: this.registeredSources() }
  }
  registeredSources(): { source: WorktreeIdentity; configDigest: string; registeredNodeIds: string[]; exists: boolean; watchOnline: boolean; health: PersistentObserverHealth | null; control: PhysicalControl; latest: SyncObservation | null }[] {
    return enabledSources(this.runtime).filter(record => record.source.repositoryId === this.repositoryId).map(record => {
      const scope = this.physicalScope(record.source), health = this.store.readObserverHealth(scope)
      return { source: record.source, configDigest: record.configDigest, registeredNodeIds: record.registeredNodeIds ?? [], exists: existsSync(record.source.canonicalRoot), watchOnline: health?.status === 'watching' && observerProcessAlive(health), health, control: this.store.readPhysicalControl(scope), latest: this.store.readLatestObservation(record.source) }
    })
  }
  private async frozenNodes(snapshot: InputSnapshot): Promise<Awaited<ReturnType<typeof loadSpecs>>> {
    const files = new Map(verifySnapshot(snapshot).filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md')).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    return loadSpecs(this.root, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files } })
  }
  private selectRegisteredNodes(nodes: Awaited<ReturnType<typeof loadSpecs>>, settings: ReturnType<typeof readSyncSettings>['settings'], snapshot: InputSnapshot): Awaited<ReturnType<typeof loadSpecs>> {
    const entries = new Map(verifySnapshot(snapshot).map(entry => [entry.path, entry]))
    const authorized = [...settings.sourcePaths, ...settings.testPaths]
    const candidates = settings.nodeIds ? settings.nodeIds.map(id => {
      const node = nodes.find(node => node.id === id)
      if (!node) throw new SyncApplicationError('sync_node_unknown', `登记的意图节点不存在：${id}`, 404)
      return node
    }) : nodes.filter(node => {
      if (node.code.some(path => coveredPath(path.split('#')[0], authorized))) return true
      const entry = entries.get(node.path)
      if (!entry || node.contractSchema !== 'sync-v1') return false
      const contract = parseContract({ nodeId: node.id, path: node.path, source: readObject(snapshot.source.commonDir, entry.oid).toString('utf8') }).contract
      return contract?.items.some(item => item.kind === 'AC' && coveredPath(item.test.split('#')[0], authorized)) ?? false
    })
    return candidates.filter(node => !candidates.some(parent => parent.id !== node.id && node.path.startsWith(`${parent.path.slice(0, -'spec.md'.length)}`)))
  }
  private async requireNodeAuthorized(snapshot: InputSnapshot, nodeId: string): Promise<void> {
    const { settings } = readSyncSettings(snapshot)
    if (!settings.nodeIds || settings.nodeIds.includes(nodeId)) return
    const nodes = await this.frozenNodes(snapshot), node = nodes.find(node => node.id === nodeId)
    if (!node) throw new SyncApplicationError('sync_node_unknown', `不存在 Spec 节点 ${nodeId}`, 404)
    const roots = this.selectRegisteredNodes(nodes, settings, snapshot)
    if (!roots.some(root => root.id === node.id || node.path.startsWith(root.path.slice(0, -'spec.md'.length)))) throw new SyncApplicationError('sync_scope_unauthorized', `节点 ${nodeId} 未在 sync.nodeIds 授权作用域内`)
  }
  private physicalScope(source: WorktreeIdentity): PhysicalScope {
    return { repositoryId: source.repositoryId, canonicalRoot: source.canonicalRoot, physicalFingerprint: source.physicalFingerprint }
  }
  observationStatus(): { health: SyncObserverHealth; persistedHealth: PersistentObserverHealth | null; control: PhysicalControl; latestSnapshot: InputSnapshot | null; latest: SyncObservation | null; latestDifference: unknown; registeredNodes: string[]; coverage: SyncScopeCoverage } {
    const source = this.latestSnapshot?.source ?? this.sourceAtCreation, scope = this.physicalScope(source)
    const persistedHealth = this.store.readObserverHealth(scope), latest = this.latestObservation ?? this.store.readLatestObservation(source)
    const alive = observerProcessAlive(persistedHealth)
    const watchOnline = alive && persistedHealth?.status === 'watching'
    const health = this.observer ? { ...this.observerHealth, watchOnline } : { ...this.observerHealth, watchOnline, status: watchOnline ? 'watching' as const : 'offline' as const }
    let latestDifference: unknown = null
    if (latest) {
      try { latestDifference = JSON.parse(readEvidence(latest.input.source.commonDir, { sha256: latest.latestDifferenceDigest }).toString('utf8')) as unknown }
      catch (error) { latestDifference = { availability: 'unavailable', reference: { sha256: latest.latestDifferenceDigest }, failure: { code: 'sync_observation_evidence_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    }
    return { health, persistedHealth, control: this.store.readPhysicalControl(scope), latestSnapshot: this.latestSnapshot ?? latest?.input ?? null, latest, latestDifference, registeredNodes: [...this.registeredNodes].sort(), coverage: this.scopeCoverage }
  }
  private ownsObservation(): boolean {
    return !!this.observerIdentity && this.store.readObserverHealth(this.physicalScope(this.observerIdentity.source))?.instanceId === this.observerIdentity.instanceId
  }
  private recordObserverHealth(health: SyncObserverHealth): void {
    this.observerHealth = health
    if (!this.observerIdentity) return
    if (!this.ownsObservation()) {
      this.observerHealth = { ...health, status: 'offline', watchOnline: false, reason: { code: 'sync_observer_replaced', message: '观察职责已由新服务实例接管' } }
      return
    }
    const { instanceId, source, startedAtMs } = this.observerIdentity
    this.store.recordObserverHealth({ scope: this.physicalScope(source), instanceId, processId: process.pid, startedAtMs, updatedAtMs: Date.now(), status: health.status === 'offline' ? 'stopped' : health.status === 'watching' || health.status === 'starting' ? health.status : 'degraded', ...(health.reason ? { failure: { ...health.reason, kind: 'environment', evidenceRefs: [] } } : {}) }, instanceId)
  }
  /** 正式后端生命周期持有观察，无浏览器和 HTTP 请求时仍扫描已启用来源。 */
  async startService(options: { compensationMs?: number; debounceMs?: number } = {}): Promise<void> {
    if (this.observer || !existsSync(this.enabledPath)) return
    this.stopped = false
    const source = existsSync(this.root) ? identifyWorktree(this.root) : this.sourceAtCreation, scope = this.physicalScope(source), token = processStartToken(process.pid)
    if (!token) throw new SyncApplicationError('sync_service_identity_unknown', '无法确认同步服务的真实进程身份')
    const current = this.store.readObserverHealth(scope)
    const identity = { instanceId: `${token}|${randomUUID()}`, source, startedAtMs: Date.now() }
    this.store.recordObserverHealth({ scope, instanceId: identity.instanceId, processId: process.pid, startedAtMs: identity.startedAtMs, updatedAtMs: identity.startedAtMs, status: 'starting' }, current?.instanceId ?? null)
    this.observerIdentity = identity
    this.observer = new SyncInputObserver({ root: this.root, gitDir: source.gitDir, commonDir: source.commonDir, ...options,
      scan: () => this.scanObservedInput(), health: health => this.recordObserverHealth(health),
    })
    await this.observer.start()
    if ((await this.readSettings()).enabled) this.startNextDispatch()
  }
  async stopService(): Promise<void> {
    this.stopped = true
    const observer = this.observer; this.observer = null
    for (const flight of this.running.values()) flight.controller.abort()
    await observer?.stop()
    this.observerIdentity = null
    await Promise.all([...this.running.values()].map(flight => flight.finished))
  }
  /** 暂停属于物理输入门禁；取消仍只控制指定操作。恢复先补偿最新输入。 */
  async automaticControl(action: 'pause' | 'resume'): Promise<ReturnType<SyncApplication['observationStatus']>> {
    if (action !== 'pause' && action !== 'resume') throw new SyncApplicationError('sync_control_invalid', '自动控制仅接受 pause 或 resume', 400)
    const source = identifyWorktree(this.root), scope = this.physicalScope(source), current = this.store.readPhysicalControl(scope)
    if (action === 'pause') {
      this.store.requestPhysicalControl(scope, 'pause', current.revision)
      for (const flight of this.running.values()) flight.controller.abort()
    } else {
      await this.observer?.scanNow()
      await Promise.all([...this.running.values()].map(flight => flight.finished))
      await this.observer?.scanNow()
      this.requireEnabled(await captureInputSnapshot(this.root))
      this.store.requestPhysicalControl(scope, 'run', current.revision)
      await this.observer?.scanNow()
      this.startNextDispatch()
    }
    return this.observationStatus()
  }
  private async scanObservedInput(): Promise<void> {
    if (!this.ownsObservation()) return
    const registered = JSON.parse(readFileSync(this.enabledPath, 'utf8')) as EnabledRecord
    if (readPhysicalFingerprint(this.root, registered.source.gitDir) !== registered.source.physicalFingerprint) throw new SyncApplicationError('sync_source_changed', '输入工作树被删除重建或仓库身份变化，请明确重新启用')
    const snapshot = await captureInputSnapshot(this.root)
    this.latestSnapshot = snapshot
    this.latestObservation = this.store.readLatestObservation(snapshot.source)
    if (!existsSync(this.enabledPath)) return
    this.requireEnabled(snapshot)
    const { settings } = readSyncSettings(snapshot), nodes = await this.frozenNodes(snapshot)
    const record = this.enabled(snapshot)!
    const currentRoots = settings.nodeIds ? nodes.filter(node => settings.nodeIds!.includes(node.id)) : this.selectRegisteredNodes(nodes, settings, snapshot)
    const rootIds = settings.nodeIds ?? record.registeredNodeIds ?? currentRoots.map(node => node.id)
    const roots = nodes.filter(node => rootIds.includes(node.id))
    const included = nodes.filter(node => roots.some(root => root.id === node.id || node.path.startsWith(root.path.slice(0, -'spec.md'.length))))
    this.scopeCoverage = { includedNodeIds: included.map(node => node.id), missingNodeIds: rootIds.filter(id => !nodes.some(node => node.id === id)), contextNodeIds: nodes.filter(node => !included.some(member => member.id === node.id) && roots.some(root => root.path.startsWith(node.path.slice(0, -'spec.md'.length)))).map(node => node.id), excludedNodeIds: nodes.filter(node => !included.some(member => member.id === node.id)).map(node => node.id), totalNodeCount: nodes.length }
    this.registeredNodes.clear()
    for (const rootId of rootIds) this.registeredNodes.add(rootId)
    for (const nodeId of this.registeredNodes) await this.observeNode(snapshot, nodeId)
  }
  private async freezeNodePlan(snapshot: InputSnapshot, nodeId: string, reuseObserved = false): Promise<{ plan: SyncCoordinatorPlan; selection: FrozenBaselineSelection }> {
    const resourcesInStore = this.store.listBaselineResources(snapshot.source)
    let heads = this.store.readBaselineSelection(snapshot.source, resourcesInStore)
    if ('failure' in heads && heads.failure.code === 'SYNC_BASELINE_LEGACY_UNKNOWN') {
      const known = resourcesInStore.filter(resource => 'selection' in this.store.readBaselineSelection(snapshot.source, [resource]))
      heads = this.store.readBaselineSelection(snapshot.source, known)
    }
    if ('failure' in heads) throw Object.assign(new SyncApplicationError(heads.failure.code, heads.failure.message), { syncFailure: heads.failure })
    const headsDigest = contentHash(JSON.stringify({ resources: resourcesInStore, selection: heads.selection.digest }))
    const cached = reuseObserved ? this.observedPlans.get(nodeId) : null
    if (cached?.inputId === snapshot.id && cached.headsDigest === headsDigest) return { plan: structuredClone(cached.plan), selection: cached.selection }
    const discoverySelection = heads.selection
    const provisional = await buildSyncApplicationPlan(snapshot, nodeId, heads.selection, { discoverySelection })
    const resources = await deriveSyncBaselineResources(snapshot, provisional, heads.selection)
    const selected = this.store.readBaselineSelection(snapshot.source, resources)
    if ('failure' in selected) throw Object.assign(new SyncApplicationError(selected.failure.code, selected.failure.message), { syncFailure: selected.failure })
    const selectedPlan = await buildSyncApplicationPlan(snapshot, nodeId, selected.selection, { discoverySelection })
    const exact = this.store.readBaselineSelection(snapshot.source, await deriveSyncBaselineResources(snapshot, selectedPlan, selected.selection))
    if ('failure' in exact) throw Object.assign(new SyncApplicationError(exact.failure.code, exact.failure.message), { syncFailure: exact.failure })
    const plan = await buildSyncApplicationPlan(snapshot, nodeId, exact.selection, { discoverySelection })
    if (reuseObserved) this.observedPlans.set(nodeId, { inputId: snapshot.id, headsDigest, plan: structuredClone(plan), selection: exact.selection })
    return { plan, selection: exact.selection }
  }
  private observationChanges(snapshot: InputSnapshot, plan: SyncCoordinatorPlan, selection: FrozenBaselineSelection, evidence: SelectedCompositionEvidence): { changed: boolean; specChanged: boolean; codeChanged: boolean; readonlyContext: { path: string; oid: string | null; mode: string | null }[] } {
    const scope = plan.executionScope!
    const owns = (binding: FrozenBaselineSelection['bindings'][number]): boolean => binding.resource.kind === 'path' ? coveredPath(binding.resource.path, scope.paths) : binding.resource.kind === 'contract' ? scope.contractIds.includes(binding.resource.id) : scope.flowIds.includes(binding.resource.id)
    const actualSource = new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => [entry.path, entry]))
    const intentPairs = new Map(selection.bindings.flatMap(binding => 'intentPair' in binding && binding.intentPair ? [[binding.intentPair.id, binding.intentPair] as const] : []))
    const intentSources = new Map<string, ReturnType<typeof readTree>>()
    const consumedPath = (path: SelectedCompositionEvidence['paths'][number]): boolean => {
      if (path.base) return false
      const artifacts = evidence.artifacts.filter(artifact => artifact.path === path.path)
      const intents = evidence.intents.filter(intent => intent.before?.path === path.path || intent.source?.path === path.path || artifacts.some(artifact => artifact.resource.kind === intent.resource.kind && artifact.resource.id === intent.resource.id))
      if (!intents.length || intents.some(intent => intent.changed || !intent.pairId) || artifacts.some(artifact => artifact.changed || !artifact.pairId)) return false
      const current = actualSource.get(path.path)
      return intents.every(intent => {
        const pair = intentPairs.get(intent.pairId!)!
        let entries = intentSources.get(pair.id)
        if (!entries) { entries = readTree(snapshot.source.commonDir, pair.sourceInput.immutableTree); intentSources.set(pair.id, entries) }
        const before = entries.find(entry => entry.path === path.path)
        return before?.oid === current?.oid && before?.mode === current?.mode
      })
    }
    const changedPaths = evidence.paths.filter(path => coveredPath(path.path, scope.paths) && (path.base?.oid !== path.source?.oid || path.base?.mode !== path.source?.mode) && !consumedPath(path))
    const residualPaths = evidence.residualPaths.filter(path => coveredPath(path, scope.paths))
    const intentChanged = evidence.intents.some(intent => (intent.resource.kind === 'contract' ? scope.contractIds : scope.flowIds).includes(intent.resource.id) && intent.changed)
    const readonlyContext = evidence.paths.filter(path => !coveredPath(path.path, scope.paths)).map(path => ({ path: path.path, oid: path.source?.oid ?? null, mode: path.source?.mode ?? null }))
    const pairs = new Map(selection.bindings.filter(owns).flatMap(binding => { const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair; return pair ? [[pair.id, pair] as const] : [] }))
    const contextChanged = [...pairs.values()].some(pair => {
      const canonical = composeAuthoredInput(pair.sourceInput).composed!
      const prior = new Map(readTree(snapshot.source.commonDir, canonical.tree).map(entry => [entry.path, entry]))
      return readonlyContext.some(entry => entry.oid !== (prior.get(entry.path)?.oid ?? null) || entry.mode !== (prior.get(entry.path)?.mode ?? null))
    })
    return { changed: changedPaths.length > 0 || residualPaths.length > 0 || intentChanged || contextChanged, specChanged: intentChanged || changedPaths.some(path => path.path.startsWith('.spec/')), codeChanged: contextChanged || changedPaths.some(path => !path.path.startsWith('.spec/')) || residualPaths.some(path => !path.startsWith('.spec/')), readonlyContext }
  }
  private async observeNode(snapshot: InputSnapshot, nodeId: string): Promise<void> {
    const { settings, configDigest } = readSyncSettings(snapshot)
    const configRef = writeEvidence(snapshot.source.commonDir, { version: 'sync-observed-configuration-v1', configDigest, settings })
    const control = this.store.readPhysicalControl(this.physicalScope(snapshot.source))
    let selection: FrozenBaselineSelection | null = null
    try {
      const frozen = await this.freezeNodePlan(snapshot, nodeId, true), plan = frozen.plan
      selection = frozen.selection
      const differenceKey = `${snapshot.id}:${selection.digest}:${syncPlanDigest(plan)}`
      let cachedDifference = this.observedDifferences.get(nodeId)
      if (cachedDifference?.key !== differenceKey) {
        const composed = composeAuthoredInput(snapshot, selection, { retainConflicts: true, executionPaths: plan.executionScope!.paths, contextPaths: plan.readPaths }).composed!
        const evidence = readCompositionEvidence(snapshot, composed, selection)
        const { changed, specChanged, codeChanged, readonlyContext } = this.observationChanges(snapshot, plan, selection, evidence)
        const difference = { nodeId, readonlyContext, selection: selection.digest, configDigest, policyDigest: syncPlanDigest(plan), paths: evidence.paths.map(path => ({ path: path.path, base: path.base?.oid ?? null, baseMode: path.base?.mode ?? null, source: path.source?.oid ?? null, sourceMode: path.source?.mode ?? null })), intents: evidence.intents.map(intent => ({ resource: intent.resource, changed: intent.changed, before: intent.before?.semanticDigest ?? null, source: intent.source?.semanticDigest ?? null })), residualPaths: evidence.residualPaths, conflicts: evidence.conflicts }
        cachedDifference = { key: differenceKey, changed, specChanged, codeChanged, latestDifferenceDigest: writeEvidence(snapshot.source.commonDir, difference).sha256 }
        this.observedDifferences.set(nodeId, cachedDifference)
      }
      const { changed, specChanged, codeChanged, latestDifferenceDigest } = cachedDifference
      const observation = { input: snapshot, configRef, selection, latestDifferenceDigest }
      const previouslyAdmitted = this.store.listObservations(snapshot.source).some(prior => prior.operationId && ['admitted', 'coalesced', 'duplicate'].includes(prior.outcome) && prior.configRef.sha256 === configRef.sha256 && prior.latestDifferenceDigest === latestDifferenceDigest)
      if (!changed || control.control === 'pause' || previouslyAdmitted) {
        this.latestObservation = this.store.recordObservation(observation, { controlRevision: control.revision, selectionDigest: selection.digest }); return
      }
      const ingressKey = `observation:${snapshot.source.repositoryId}:${snapshot.id}:${nodeId}:${latestDifferenceDigest}`
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: ingressKey, origin: !selection.bindings.some(binding => ('bytePair' in binding ? binding.bytePair : binding.intentPair)) ? 'initial' : specChanged && codeChanged ? 'combined' : codeChanged ? 'code' : 'spec', budget: settings.budget, managedRoot: this.managedRoot, baselineSelection: selection })
      if (!this.ownsObservation()) return
      this.prepareTools(ingressKey, this.store.findOperationByIngressKey(ingressKey))
      const result = this.store.observeAndAdmit(observation, admission, { controlRevision: control.revision, selectionDigest: selection.digest })
      this.latestObservation = result.observation
      if (result.outcome !== 'blocked') this.start(result.operation.id)
    } catch (error) {
      const failure = (error as { syncFailure?: NonNullable<SyncObservation['failure']> }).syncFailure ?? { code: error instanceof SyncApplicationError || error instanceof SyncStoreError ? error.code : 'sync_observation_planning_failed', message: error instanceof Error ? error.message : String(error), kind: 'unsupported' as const, evidenceRefs: [] }
      this.latestObservation = this.store.recordObservation({ input: snapshot, configRef, selection, latestDifferenceDigest: writeEvidence(snapshot.source.commonDir, { nodeId, configDigest, selection: selection?.digest ?? null, failure, content: snapshot.contentDigest }).sha256, failure }, { controlRevision: control.revision, selectionDigest: selection?.digest ?? null })
    }
  }
  private async retryEligibility(operation: SyncOperation, snapshot: InputSnapshot): Promise<SyncOperationDetail['retryEligibility']> {
    const eligibility = this.store.readRetryEligibility(operation.id)
    if (!eligibility.eligible) return eligibility
    if (!['spec', 'initial', 'code', 'combined', 'decision'].includes(operation.origin)) return { eligible: false, reason: { code: 'sync_origin_unsupported', message: '当前入口接受 Spec 输入，原操作来源不能在此重试' } }
    try {
      this.requireEnabled(snapshot, operation)
      if (!await isSyncInputCurrent(operation, snapshot, this.operationPlan(operation))) return { eligible: false, reason: { code: 'sync_retry_stale', message: '原输入已变化，请为当前 Spec 发起新操作' } }
    }
    catch (error) { return { eligible: false, reason: { code: error instanceof SyncApplicationError ? error.code : 'sync_retry_plan_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    return eligibility
  }
  private async detail(operation: SyncOperation, snapshot: InputSnapshot): Promise<SyncOperationDetail> {
    let executionAvailability: SyncOperationDetail['executionAvailability']
    try { this.executionInputs(operation); executionAvailability = { status: 'ready' } }
    catch (error) { executionAvailability = { status: 'recovery_required', failure: { code: 'sync_execution_metadata_unavailable', message: error instanceof Error ? error.message : String(error) } } }
    const journals = this.store.listJournals(operation.id), resources = this.store.listRecoverableResources().filter(item => item.operation.id === operation.id).map(item => item.resource)
    const stopped = operation.control !== 'run' || completed.has(operation.phase) || ['paused', 'failed', 'budget_exhausted', 'needs_input', 'conflicted', 'recovery_required'].includes(operation.phase)
    if (executionAvailability.status === 'ready' && stopped && (resources.length || journals.some(journal => journal.status !== 'settled'))) executionAvailability = { status: 'recovery_required', failure: { code: 'sync_resources_unsettled', message: '操作仍有未结算资源或交付日志，请先恢复清理再重试' } }
    const current = existsSync(this.root) && executionAvailability.status === 'ready' && await isSyncInputCurrent(operation, snapshot, this.operationPlan(operation))
    return { operation, physicalControl: this.store.readPhysicalControl(this.physicalScope(operation.input.source)), decisionContext: existsSync(operation.input.source.commonDir) ? this.decisionContext(operation) : null, attempt: operation.currentAttemptId ? this.store.readAttempt(operation.currentAttemptId) : null, journals, resources, stale: !current, sourceSynced: existsSync(this.root) && operation.phase === 'canonical_synced' && snapshot.id === operation.input.id, retryEligibility: await this.retryEligibility(operation, snapshot), decisionEligibility: this.store.readDecisionEligibility(operation.id), executionAvailability }
  }
  /** 只有原操作当前 attempt 的可信分析检查点能成为业务裁决对象。 */
  private decisionContext(operation: SyncOperation): SyncOperationDetail['decisionContext'] {
    const evidence = readCurrentSyncAnalysis(this.store, operation)
    return evidence ? { analysisRef: evidence.ref, analysis: evidence.analysis } : null
  }
  async readOperation(id: string): Promise<SyncOperationDetail> {
    const operation = this.store.readOperation(id)
    this.assertSource(operation)
    return this.detail(operation, existsSync(this.root) ? await captureInputSnapshot(this.root) : this.latestSnapshot ?? operation.input)
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
    let snapshot = await captureInputSnapshot(this.root)
    this.requireEnabled(snapshot)
    await this.requireNodeAuthorized(snapshot, input.nodeId)
    const retry = input.retryOf ? this.store.readOperation(input.retryOf) : null
    if (retry) {
      this.assertSource(retry)
      const eligibility = await this.retryEligibility(retry, snapshot)
      if (!eligibility.eligible) throw new SyncApplicationError(eligibility.reason!.code, eligibility.reason!.message)
      if (this.operationPlan(retry).intentNodeId !== input.nodeId) throw new SyncApplicationError('sync_retry_changed', '显式重试不能改为另一个节点')
      if (retry.baselineSelection) snapshot = retry.input
    }
    const origin = input.origin ?? retry?.origin ?? 'spec'
    const { settings } = readSyncSettings(snapshot)
    const ingressKey = `application:${snapshot.source.repositoryId}:${this.root}:${input.requestId}`
    const mutex = await this.requestMutex(ingressKey, settings.budget.timeoutMs)
    try {
      const prior = this.store.findOperationByIngressKey(ingressKey), ingress = this.store.findIngressReceipt(ingressKey)
      if (prior?.baselineSelection) {
        this.requireEnabled(snapshot, prior)
        if (!await isSyncInputCurrent(prior, snapshot, this.operationPlan(prior))) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
        snapshot = ingress?.input ?? prior.input
      }
      const previousBaselinePair = prior ? (ingress ?? prior).previousBaselinePair : retry ? retry.previousBaselinePair : null
      const oldSelection = (ingress ?? prior)?.baselineSelection ?? retry?.baselineSelection
      const frozen = oldSelection ? { plan: this.operationPlan(prior ?? retry!), selection: oldSelection } : prior || retry ? null : await this.freezeNodePlan(snapshot, input.nodeId)
      const plan = frozen?.plan ?? this.operationPlan((prior ?? retry)!)
      if (prior && input.nodeId !== plan.intentNodeId) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
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
      if (prior && ((ingress?.origin ?? prior.origin) !== origin || (prior.retryOf ?? null) !== (retry?.id ?? null) || (ingress?.input ?? prior.input).id !== snapshot.id || JSON.stringify((ingress?.input ?? prior.input).source) !== JSON.stringify(snapshot.source) || prior.policyDigest !== syncPlanDigest(plan) || ((ingress ?? prior).requestBlob?.sha256 ?? null) !== (requestBlob?.sha256 ?? null))) throw new SyncStoreError('SYNC_IDEMPOTENCY_CONFLICT', ingressKey)
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: input.requestId, origin, ...(retry ? { retryOf: retry.id, ...(retry.baselineSelection ? { executionScope: retry.scope, impactDigest: retry.impactDigest } : {}) } : {}), budget: settings.budget, managedRoot: this.managedRoot, ...(requestBlob ? { requestBlob } : {}), previousBaselinePair, ...(frozen ? { baselineSelection: frozen.selection } : {}) })
      if (prior) { admission.deliveryPlan = (ingress ?? prior).deliveryPlan; admission.budget = (ingress ?? prior).budget }
      this.prepareTools(admission.ingressKey, prior)
      const operation = this.store.admitAndEnqueue(admission)
      this.start(operation.id)
      return { changed: true, operation: this.store.readOperation(operation.id) }
    } finally { mutex.release() }
  }
  private decorateDecisionPlan(plan: SyncCoordinatorPlan, snapshot: InputSnapshot, input: SyncDecisionInput, analysis: CodeBehaviorAnalysis, requestRef: BlobRef, previousBaselinePair: BaselinePair | FrozenBaselineSelection | null): void {
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
      const overlaps = composed.compositionEvidenceBlob ? (JSON.parse(readEvidence(snapshot.source.commonDir, composed.compositionEvidenceBlob).toString('utf8')) as { conflicts: { path: string }[] }).conflicts : []
      plan.targets = plan.targets.map(target => {
        const entry = entries.find(entry => entry.path === target.path)
        if (!entry) return target
        // 重叠处暂选作者字节只供分析，不覆盖随后独审整合的完整正文。
        if (overlaps.some(conflict => conflict.path === target.path)) return target
        const source = readObject(snapshot.source.commonDir, entry.oid).toString('utf8')
        const contract = parseContract({ nodeId: target.nodeId, path: target.path, source }).contract
        if (target.nodeId !== plan.intentNodeId && !affectedIds.has(target.nodeId) && !contract?.items.some(item => affectedIds.has(item.id))) return target
        const raw = target.rawSource ?? parseParts(source)?.rawSource
        if (!raw) throw new SyncApplicationError('sync_decision_intent', '原需求正文不可读取，不能猜测新需求')
        return { ...target, rawSource: renderControlledDecisionRaw(raw, input, analysis) }
      })
    }
  }
  /** 具体分歧的用户选择建立新协调操作，保留原冲突和 root cause 证据链。 */
  async decide(input: SyncDecisionInput): Promise<{ changed: true; operation: SyncOperation }> {
    if (!input || typeof input.operationId !== 'string') throw new SyncApplicationError('sync_decision_invalid', '裁决需要原 operation ID', 400)
    const original = this.store.readOperation(input.operationId); this.assertSource(original)
    const current = await captureInputSnapshot(this.root); this.requireEnabled(current, original)
    if (!await isSyncInputCurrent(original, current, this.operationPlan(original)) || input.inputId !== original.input.id) throw new SyncApplicationError('sync_decision_stale', '原输入已变化，不能对旧分歧裁决')
    const snapshot = original.baselineSelection ? original.input : current
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
      const eligibility = this.store.readDecisionEligibility(original.id)
      if (!eligibility.eligible) throw new SyncApplicationError(eligibility.reason!.code === 'SYNC_DECISION_RESOURCE_PENDING' ? 'sync_resources_unsettled' : 'sync_decision_not_needed', eligibility.reason!.message)
      const detail = await this.detail(original, snapshot)
      if (detail.executionAvailability.status !== 'ready') throw new SyncApplicationError('sync_resources_unsettled', '请先恢复原操作的未结算资源')
      const previousBaselinePair = original.baselineSelection ? null : this.store.readBaseline(snapshot.source) ?? original.previousBaselinePair
      const selected = original.baselineSelection ? this.store.readBaselineSelection(snapshot.source, original.baselineSelection.bindings.map(binding => binding.resource)) : null
      if (selected && 'failure' in selected) throw Object.assign(new SyncApplicationError(selected.failure.code, selected.failure.message), { syncFailure: selected.failure })
      const selection = selected?.selection, plan = this.operationPlan(original)
      this.decorateDecisionPlan(plan, snapshot, input, context.analysis, requestBlob, selection ?? previousBaselinePair)
      const admission = await prepareSyncAdmission(snapshot, plan, { ingressKey, rootCauseId: original.rootCauseId, origin: 'decision', budget: settings.budget, managedRoot: this.managedRoot, requestBlob, previousBaselinePair, ...(selection ? { baselineSelection: selection, executionScope: original.scope, impactDigest: original.impactDigest } : {}) })
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
    if (this.stopped) return false
    if (this.routing) return true
    let head = this.store.nextDispatch(this.repositoryId)
    while (head) {
      this.store.ackDispatch(this.repositoryId, head.messageId)
      head = this.store.nextDispatch(this.repositoryId)
    }
    const queued = this.store.nextQueued(this.repositoryId)
    const checkpoint = this.store.listRecoverable().filter(({ operation, attempt }) => operation.input.source.repositoryId === this.repositoryId && operation.control === 'run' && !!operation.dispatchAnchor && !!attempt && (!attempt.failure || attempt.failure.kind === 'repairable') && ['analyzing', 'elaborating', 'generating', 'verifying', 'repairing', 'ready_to_apply'].includes(operation.phase) && this.store.readPhysicalControl(this.physicalScope(operation.input.source)).control === 'run' && !applicationOwners.get(this.ownerKey(operation.input.source.canonicalRoot))?.running.has(operation.id)).sort((a, b) => a.operation.dispatchAnchor!.firstEnqueueSeq - b.operation.dispatchAnchor!.firstEnqueueSeq)[0]?.operation
    const operation = checkpoint && (!queued || checkpoint.dispatchAnchor!.firstEnqueueSeq < queued.dispatchAnchor!.firstEnqueueSeq) ? checkpoint : queued
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
    if (this.stopped || this.running.has(id) || !recoveryOnly && (completed.has(operation.phase) || ['failed', 'budget_exhausted', 'conflicted', 'needs_input', 'recovery_required', 'paused'].includes(operation.phase) || operation.control !== 'run' || this.store.readPhysicalControl(this.physicalScope(operation.input.source)).control === 'pause')) return
    const controller = new AbortController()
    const { plan, tools } = this.executionInputs(operation)
    const { settings } = readSyncSettings(operation.input)
    let advance = false
    const finished = runSyncOperation(this.store, id, { plan, ...(recoveryOnly ? { recoveryOnly: true } : {}), readCurrentPlan: async () => {
      const current = await captureInputSnapshot(this.root); this.requireEnabled(current, operation)
      return plan
    }, managedRoot: this.managedRoot, artifactRoot: this.artifactRoot, tools, runner: this.options.runner, verificationDriver: this.options.verificationDriver, signal: controller.signal, callTimeoutMs: settings.callTimeoutMs }).then(result => { advance = !recoveryOnly && result.status !== 'busy' && result.operation.phase !== 'queued'; return result }).finally(() => {
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
      const current = await captureInputSnapshot(this.root); this.requireEnabled(current, operation)
      if (!await isSyncInputCurrent(operation, current, this.operationPlan(operation))) throw new SyncApplicationError('sync_input_stale', '恢复输入已变化，请为最新 Spec 发起新操作')
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
export function configuredSyncApplication(root: string, registeredSource?: WorktreeIdentity): Promise<SyncApplication> {
  const identity = registeredSource ?? identifyWorktree(root), key = `${identity.repositoryId}:${identity.canonicalRoot}`
  if (identity.commonDir !== identifyWorktree(repoRoot()).commonDir) throw new SyncApplicationError('sync_project_mismatch', '输入工作树不属于当前后端项目')
  let application = applications.get(key)
  if (!application) {
    application = SyncApplication.create(identity.canonicalRoot, { protocol: configuredSessionApplication().protocol }, registeredSource)
    if (syncServicesOnline) application = application.then(async owner => { await owner.startService(); return owner })
    applications.set(key, application)
    void application.catch(() => applications.delete(key))
  }
  return application
}

let syncServicesOnline = false
/** 启动只恢复本机明确 enable 记录，不遍历工作树自动授予授权。 */
export async function startConfiguredSyncServices(root: string): Promise<void> {
  syncServicesOnline = true
  const runtime = join(runtimeRoot(root), 'sync')
  if (!existsSync(runtime)) return
  for (const record of enabledSources(runtime)) {
    if (record.source.repositoryId !== identifyWorktree(root).repositoryId) continue
    await (await configuredSyncApplication(record.source.canonicalRoot, record.source)).startService()
  }
}
export async function closeConfiguredSyncServices(): Promise<void> {
  syncServicesOnline = false
  await Promise.all([...applicationOwners.values()].map(application => application.stopService()))
}
