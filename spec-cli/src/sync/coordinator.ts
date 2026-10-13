import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { ContractFinding } from '@spexcode/spec-core/contracts'
import { actualTreeDiff, exportCandidate, isHostPrivatePath, verifyCandidate } from './candidate.js'
import { isUtf8Text } from './composition.js'
import { composeAuthoredInput } from './author-input.js'
import { elaborate } from './elaboration.js'
import type { ElaborationResult, ElaborationRunner, ElaborationSessionResult, ElaborationRepairSeed } from './elaboration-types.js'
import { claimFileMutex } from './file-mutex.js'
import { checkGenerationContractIntent, readFrozenContracts } from './frozen-contracts.js'
import type { FrozenContracts } from './frozen-contracts.js'
import { runGeneration } from './generation.js'
import type { GenerationResult } from './generation-types.js'
import { createAttemptRunner } from './native-run.js'
import type { NativeRunPlan } from './native-run.js'
import type { AdmitSyncInput, ApplyReceipt, BlobRef, CandidateRef, ComposedInputRef, InputSnapshot, SyncAttempt, SyncFailure, SyncOperation, SyncScope, VerificationResultBlob, WriteFence } from './operation-types.js'
import { deliverVerifiedAttempt, planPrivateDelivery } from './private-delivery.js'
import { composeControlledRequest } from './request-input.js'
import { sessionIdForCreateKey } from '../sessions.js'
import { captureInputSnapshot, contentHash, objectGit, readEvidence, readObject, readTree, validateRepositoryPath, verifySnapshot, writeEvidence } from './snapshot.js'
import type { SnapshotManifest } from './snapshot.js'
import { SyncStoreError } from './store.js'
import type { SyncStore } from './store.js'
import { verificationExportDigest } from './verification-executor.js'
import type { VerificationRequest, VerificationResult } from './verification-executor-types.js'
import { planAcceptanceRuns } from './verification-plan.js'
import type { AcceptanceRun } from './verification-plan.js'
import { runAttemptVerification } from './verification-run.js'
import type { SyncAdmissionOptions, SyncCoordinatorOptions, SyncCoordinatorPlan, SyncCoordinatorResult } from './coordinator-types.js'

export class SyncCoordinatorError extends Error {
  constructor(readonly code: string, message: string, readonly evidenceRefs: BlobRef[] = []) { super(`${code}: ${message}`); this.name = 'SyncCoordinatorError' }
}
function fail(code: string, message: string, refs: BlobRef[] = []): never { throw new SyncCoordinatorError(code, message, refs) }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
export const syncPlanDigest = (plan: SyncCoordinatorPlan): string => contentHash(canonical(plan))
export const freezeSyncPlanEvidence = (commonDir: string, plan: SyncCoordinatorPlan): BlobRef => writeEvidence(commonDir, JSON.parse(canonical(plan)))
const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
const overlap = (a: string, b: string): boolean => within(a, [b]) || within(b, [a])
const unique = (ids: readonly string[]): string[] => [...new Set(ids)].sort()
const fenceFor = (operation: SyncOperation, attempt: SyncAttempt): WriteFence => ({ operationId: operation.id, attemptId: attempt.id, generation: attempt.generation, leaseToken: attempt.leaseToken, sourceFingerprint: operation.input.source.physicalFingerprint })
type InputView = { composed: ComposedInputRef; manifest: SnapshotManifest; files: Map<string, string>; readSetDigest: string; frozen: FrozenContracts }

async function readInput(input: InputSnapshot, plan: SyncCoordinatorPlan, previous?: SyncOperation['previousBaselinePair'], requestBlob?: BlobRef): Promise<InputView> {
  if (plan.version !== 'sync-coordinator-v1' || !plan.targets.length || !plan.writePaths.length) fail('invalid_plan', '可信计划缺少版本、目标或写范围')
  for (const path of [...plan.readPaths, ...plan.writePaths, ...plan.targets.map(item => item.path), ...(plan.newNodeRawSources ?? []).map(item => item.path)]) {
    validateRepositoryPath(path)
    if (isHostPrivatePath(path)) fail('private_context', `可信读写集合包含宿主运行资料: ${path}`)
  }
  verifySnapshot(input)
  let composition = composeAuthoredInput(input, previous ?? undefined)
  if (!composition.composed) fail('composition_conflict', '人类输入与前次交付存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
  if (requestBlob) composition = composeControlledRequest(input, composition.composed, requestBlob)
  if (!composition.composed) fail('request_conflict', '用户受控差量与已交付细化存在重叠冲突', [writeEvidence(input.source.commonDir, composition.conflicts)])
  const composed = composition.composed, entries = readTree(input.source.commonDir, composed.tree)
  if (contentHash(JSON.stringify(entries)) !== composed.contentDigest || readEvidence(input.source.commonDir, composed.manifestBlob).toString() !== JSON.stringify({ version: 1, entries })) fail('composition_digest', '组合输入真实清单与引用不一致')
  const readEntries = entries.filter(entry => within(entry.path, plan.readPaths))
  const files = new Map<string, string>()
  for (const entry of readEntries) {
    if (isHostPrivatePath(entry.path)) fail('private_context', `读集合包含宿主运行资料: ${entry.path}`)
    const bytes = readObject(input.source.commonDir, entry.oid)
    if (entry.mode !== '120000' && isUtf8Text(bytes)) files.set(entry.path, bytes.toString('utf8'))
  }
  if (Buffer.byteLength(canonical([...files])) > 2 * 1024 * 1024) fail('context_budget', '完整可信上下文超过2MiB，不截断')
  for (const target of plan.targets) if (!within(target.path, plan.writePaths) || !within(target.path, plan.readPaths)) fail('target_scope', `目标必须在可信读写集合: ${target.path}`)
  const ids = new Set<string>()
  for (const test of plan.mandatoryTests) {
    validateRepositoryPath(test.testPath)
    if (!test.testId || ids.has(`${test.verificationId}:${test.testId}`) || !files.has(test.testPath) || plan.writePaths.some(path => overlap(path, test.testPath)) || !plan.verifications.some(item => item.definition.id === test.verificationId)) fail('oracle_binding', '独立测试必须唯一、已完整读取、不可模型写入且关联可信登记')
    ids.add(`${test.verificationId}:${test.testId}`)
  }
  const headTree = objectGit(input.source.commonDir, ['rev-parse', `${input.headCommit}^{tree}`]).toString().trim()
  const uncovered = actualTreeDiff(readTree(input.source.commonDir, headTree), entries).filter(file => !within(file.path, plan.writePaths) || !within(file.path, plan.readPaths))
  if (uncovered.length) fail('uncovered_source_change', `外部输入/前次交付差量不在可信影响范围: ${uncovered.map(file => file.path).join(', ')}`, [writeEvidence(input.source.commonDir, uncovered)])
  const readSetDigest = contentHash(canonical({ declared: unique(plan.readPaths), entries: readEntries, absent: unique(plan.readPaths.filter(path => !entries.some(entry => within(entry.path, [path])))) }))
  return { composed, manifest: { version: 1, entries }, files, readSetDigest, frozen: await readFrozenContracts(input.source.canonicalRoot, files) }
}

/** 接入之前冻结真实读集合和派生输入，只返回既有协议接入结构，不改 source/index。 */
export async function prepareSyncAdmission(input: InputSnapshot, supplied: SyncCoordinatorPlan, options: SyncAdmissionOptions): Promise<AdmitSyncInput> {
  const plan = structuredClone(supplied), view = await readInput(input, plan, options.previousBaselinePair, options.requestBlob)
  return { ingressKey: options.ingressKey, rootCauseId: options.rootCauseId, origin: options.origin, budget: options.budget, input, ...(options.requestBlob ? { requestBlob: options.requestBlob } : {}), planBlob: freezeSyncPlanEvidence(input.source.commonDir, plan), scope: { paths: unique(plan.writePaths), contractIds: [], flowIds: [] }, policyDigest: syncPlanDigest(plan), impactDigest: contentHash(canonical({ targets: plan.targets, writePaths: unique(plan.writePaths), readSetDigest: view.readSetDigest })), readSetDigest: view.readSetDigest, delivery: null, deliveryPlan: planPrivateDelivery(input, options.managedRoot, options.ingressKey), previousBaselinePair: options.previousBaselinePair ?? null }
}

type Stage = { version: 'sync-stage-v1'; operationId: string; attemptId: string; inputId: string; policyDigest: string; stage: string; resultRef: BlobRef }
type SavedElaboration = Omit<ElaborationResult, 'contracts' | 'graph' | 'coverage'>
type SavedGeneration = Omit<GenerationResult, 'candidateFiles'>
function stage<T>(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, name: string): T | null {
  for (const ref of [...attempt.checkpointRefs].reverse()) {
    const value = JSON.parse(readEvidence(operation.input.source.commonDir, ref).toString('utf8')) as Partial<Stage>
    if (value.version !== 'sync-stage-v1' || value.stage !== name) continue
    if (value.operationId !== operation.id || value.attemptId !== attempt.id || value.inputId !== operation.input.id || value.policyDigest !== operation.policyDigest || !value.resultRef) fail('stage_binding', '持久阶段身份不一致')
    return JSON.parse(readEvidence(operation.input.source.commonDir, value.resultRef).toString('utf8')) as T
  }
  return null
}
function saveStage(store: SyncStore, fence: WriteFence, name: string, value: unknown): BlobRef {
  const operation = store.readOperation(fence.operationId), commonDir = operation.input.source.commonDir
  const resultRef = writeEvidence(commonDir, value)
  const refs = new Map<string, BlobRef>([[resultRef.sha256, resultRef]])
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    if ('sha256' in entry && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) refs.set(entry.sha256, { sha256: entry.sha256 })
    for (const child of Object.values(entry)) visit(child)
  }
  visit(value)
  for (const ref of refs.values()) store.checkpoint(fence, ref)
  store.checkpoint(fence, writeEvidence(commonDir, { version: 'sync-stage-v1', operationId: operation.id, attemptId: fence.attemptId, inputId: operation.input.id, policyDigest: operation.policyDigest, stage: name, resultRef } satisfies Stage))
  return resultRef
}
function injectedRunner(store: SyncStore, fence: WriteFence, runner: ElaborationRunner): ElaborationRunner {
  return async request => {
    const { signal, ...payload } = request
    const requestDigest = contentHash(JSON.stringify(payload))
    const operation = store.readOperation(fence.operationId), attempt = store.readAttempt(fence.attemptId)
    const saved = stage<{ requestDigest: string; result: ElaborationSessionResult }>(store, operation, attempt, `injected:${request.requestKey}`)
    const dispatch = store.reserveDispatch(fence, { key: request.requestKey, purpose: request.purpose, requestDigest })
    if (saved) { if (saved.requestDigest !== requestDigest) fail('dispatch_conflict', '测试接缝重入请求改变'); return saved.result }
    const result = await runner(request)
    if (signal?.aborted) fail('cancelled', '模型结果到达时已停止')
    if (result.sessionId !== sessionIdForCreateKey(dispatch.sessionCreateKey) || !result.threadId || !result.turnId || contentHash(JSON.stringify(result.output)) !== result.resultDigest) fail('native_identity', '模型结果身份或摘要不匹配持久派发计划')
    store.bindSession(fence, request.requestKey, { sessionId: result.sessionId, threadId: result.threadId, turnId: result.turnId })
    saveStage(store, fence, `injected:${request.requestKey}`, { requestDigest, result })
    return result
  }
}
function safeArtifactRoot(root: string, operation: SyncOperation): void {
  const stat = lstatSync(root)
  if (resolve(root) !== root || realpathSync(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || root === operation.input.source.canonicalRoot || root.startsWith(`${operation.input.source.canonicalRoot}${sep}`) || operation.input.source.canonicalRoot.startsWith(`${root}${sep}`)) fail('artifact_directory', 'artifactRoot必须是source外canonical、当前用户独占0700目录')
}
function findingKey(finding: ContractFinding): string { return canonical({ code: finding.code, path: finding.path, nodeId: finding.nodeId, itemId: finding.itemId ?? null, relatedIds: unique(finding.relatedIds ?? []) }) }
async function candidateContext(operation: SyncOperation, candidate: CandidateRef, view: InputView): Promise<FrozenContracts> {
  const files = new Map(view.files)
  const entries = verifyCandidate(operation.input.source.commonDir, candidate), changed = actualTreeDiff(view.manifest.entries, entries)
  for (const file of changed) {
    const entry = entries.find(item => item.path === file.path)
    if (!entry) files.delete(file.path)
    else {
      const bytes = readObject(operation.input.source.commonDir, entry.oid)
      if (entry.mode !== '120000' && isUtf8Text(bytes)) files.set(file.path, bytes.toString('utf8'))
    }
  }
  return readFrozenContracts(operation.input.source.canonicalRoot, files)
}
function acceptanceRuns(frozen: FrozenContracts, ready: SyncScope, plan: SyncCoordinatorPlan): AcceptanceRun[] {
  const acIds = ready.contractIds.filter(id => frozen.graph.items.get(id)?.kind === 'AC')
  if (!acIds.length) fail('no_ready_acceptance', '没有可执行的ready验收，不写半成品')
  const runs = planAcceptanceRuns(frozen.graph, acIds, plan.verifications)
  for (const mandatory of plan.mandatoryTests) {
    let run = runs.find(item => item.verificationId === mandatory.verificationId)
    if (!run) {
      const registered = plan.verifications.find(item => item.definition.id === mandatory.verificationId)!
      const verify = frozen.graph.items.get(mandatory.verificationId)
      if (verify?.kind !== 'VERIFY' || canonical({ id: verify.id, command: verify.command, cwd: verify.cwd, timeoutMs: verify.timeoutMs }) !== canonical(registered.definition)) fail('oracle_verification', '独立测试政策未被真实候选准确登记')
      run = { verificationId: mandatory.verificationId, bindings: [], policy: { ...registered.environment, argv: [...registered.definition.command], cwd: registered.definition.cwd, timeoutMs: registered.definition.timeoutMs, expectedTestIds: [] } }; runs.push(run)
    }
    if (!run.policy.expectedTestIds.includes(mandatory.testId)) run.policy.expectedTestIds.push(mandatory.testId)
  }
  for (const run of runs) run.policy.expectedTestIds.sort()
  return runs.sort((a, b) => a.verificationId.localeCompare(b.verificationId))
}
async function recoverResources(store: SyncStore, operation: SyncOperation, options: SyncCoordinatorOptions, all: boolean): Promise<boolean> {
  for (const item of store.listRecoverableResources().filter(item => item.operation.id === operation.id && (all || item.attempt.id !== operation.currentAttemptId))) {
    const fence = fenceFor(item.operation, item.attempt), commonDir = operation.input.source.commonDir
    if (item.resource.plan.kind === 'verification') {
      const request = JSON.parse(readEvidence(commonDir, item.resource.plan.planBlob).toString('utf8')) as Omit<VerificationRequest, 'previousCheckpoint'>
      const recovered = await runAttemptVerification(store, fence, { ...request, signal: AbortSignal.abort() }, { driver: options.verificationDriver })
      if (recovered.result.status === 'recovery_required' || store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') return false
    } else {
      const plan = JSON.parse(readEvidence(commonDir, item.resource.plan.planBlob).toString('utf8')) as NativeRunPlan
      try { await createAttemptRunner(store, fence)({ ...plan.request, signal: AbortSignal.abort() }) }
      catch (error) { if (store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') fail('resource_recovery', error instanceof Error ? error.message : String(error)) }
      if (store.findResource(item.attempt.id, item.resource.plan.key)?.phase !== 'removed') return false
    }
  }
  return true
}

/** 唯一应用编排入口；副作用恢复优先于新生成，四层真实证据通过后才发布。 */
export async function runSyncOperation(store: SyncStore, operationId: string, supplied: SyncCoordinatorOptions): Promise<SyncCoordinatorResult> {
  const options = { ...supplied, plan: structuredClone(supplied.plan) }
  let operation = store.readOperation(operationId)
  safeArtifactRoot(options.artifactRoot, operation)
  const locks = join(options.artifactRoot, '.locks')
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  safeArtifactRoot(locks, operation)
  const mutex = claimFileMutex(join(locks, `${contentHash(operation.id)}.sqlite`))
  if (!mutex) return { status: 'busy', operation }
  let fence: WriteFence | undefined, timer: ReturnType<typeof setInterval> | undefined, repairContext: { previousOutput: unknown; diagnostics: { code: string; message: string }[] } | undefined, seed: ElaborationRepairSeed | undefined, heartbeatFailure: SyncFailure | undefined
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const leaseMs = options.leaseMs ?? 30_000, heartbeatMs = options.heartbeatMs ?? Math.min(5_000, Math.floor(leaseMs / 3))
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 3 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseMs) { mutex.release(); fail('lease_configuration', 'heartbeat必须是正整数且小于leaseMs') }
  const receipt = (): ApplyReceipt | undefined => store.listJournals(operationId).find(journal => journal.status === 'settled')?.receipt ?? undefined
  const current = (status?: SyncCoordinatorResult['status'], failure?: SyncFailure): SyncCoordinatorResult => { operation = store.readOperation(operationId); return { status: status ?? operation.phase, operation, ...(receipt() ? { receipt: receipt() } : {}), ...(failure ? { failure } : {}) } }
  const failure = (code: string, message: string, kind: SyncFailure['kind'], evidenceRefs: BlobRef[] = []): SyncFailure => ({ code, message, kind, evidenceRefs })
  const v4 = async (): Promise<BlobRef> => {
    mutex.assertHeld()
    const snapshot = await captureInputSnapshot(operation.input.source.canonicalRoot)
    if (snapshot.id !== operation.input.id) fail('input_changed', '来源内容/index/HEAD或物理身份已改变', [writeEvidence(operation.input.source.commonDir, { expected: operation.input, actual: snapshot })])
    const plan = await options.readCurrentPlan()
    if (syncPlanDigest(plan) !== operation.policyDigest) fail('policy_changed', '当前可信政策与冻结操作不同')
    const view = await readInput(snapshot, plan, operation.previousBaselinePair, operation.requestBlob)
    if (view.readSetDigest !== operation.readSetDigest) fail('readset_changed', '当前完整读取上下文已改变')
    const now = store.readOperation(operation.id), attempt = store.readAttempt(fence!.attemptId)
    if (now.control !== 'run' || now.currentAttemptId !== attempt.id || attempt.expiresAtMs <= Date.now() || now.deadlineAtMs <= Date.now() || signal.aborted) fail('controlled', '交付门禁已停止或过期')
    return writeEvidence(operation.input.source.commonDir, { version: 1, layer: 'V4', inputId: snapshot.id, source: snapshot.source, policyDigest: now.policyDigest, readSetDigest: view.readSetDigest, checkedAtMs: Date.now() })
  }
  try {
    operation = store.readOperation(operationId)
    let attempt = operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId) : null
    if (attempt?.status === 'applying' || attempt?.status === 'verified') {
      fence = fenceFor(operation, attempt)
      if (attempt.status === 'verified' && (operation.control !== 'run' || attempt.expiresAtMs <= Date.now() || operation.deadlineAtMs <= Date.now())) {
        if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      } else {
        if (attempt.status === 'verified') timer = setInterval(() => { try { store.renewLease(fence!, leaseMs) } catch (error) { heartbeatFailure = failure('lease_heartbeat', error instanceof Error ? error.message : String(error), 'environment'); controller.abort() } }, heartbeatMs)
        const delivered = await deliverVerifiedAttempt(store, fence, { managedRoot: options.managedRoot, tools: options.tools, beforeApply: async () => { await v4() }, ...options.deliveryHooks })
        return { status: delivered.operation.phase, ...delivered }
      }
    }
    const terminal = ['workspace_synced', 'canonical_synced', 'awaiting_landing', 'cancelled', 'superseded', 'paused', 'budget_exhausted']
    if (terminal.includes(operation.phase) || operation.control !== 'run' || attempt?.status === 'settled' || (attempt?.status === 'failed' && attempt.failure?.kind !== 'repairable')) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      return current()
    }
    if (['code', 'combined'].includes(operation.origin)) {
      const claimed = store.claimAttempt({ operationId, source: operation.input.source, scope: operation.scope, leaseMs, ...(operation.currentAttemptId ? {} : { expectedMessageId: operation.dispatchMessageId }) })
      fence = claimed.fence
      const denied = failure('p3_origin_unsupported', 'code/combined行为分类在P3接入，不能强行按Spec覆盖', 'unsupported')
      store.recordFailure(fence, denied); return current('unsupported', denied)
    }
    for (;;) {
      mutex.assertHeld()
      operation = store.readOperation(operationId)
      attempt = operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId) : null
      const active = attempt && !['failed', 'superseded', 'settled'].includes(attempt.status) && attempt.expiresAtMs > Date.now()
      if (!await recoverResources(store, operation, options, !active)) return current('recovery_required')
      if (!active) {
        if (attempt?.failure?.kind === 'repairable') {
          const previous = stage<SavedGeneration>(store, operation, attempt, 'generation')
          if (previous) repairContext = { previousOutput: previous.output, diagnostics: [{ code: attempt.failure.code, message: attempt.failure.message }, ...previous.validationFindings.map(item => ({ code: item.code, message: item.message }))] }
          else {
            const elaboration = stage<SavedElaboration>(store, operation, attempt, 'elaboration'), last = elaboration?.rounds.at(-1)
            if (elaboration && last?.candidate && last.candidateDigest) seed = { settled: true, requestKey: `sync:${attempt.id}:elaborate`, inputDigest: elaboration.inputDigest, candidateDigest: last.candidateDigest, output: last.output, candidate: last.candidate, findings: last.findings, review: last.review, traces: last.traces }
          }
        }
        try {
          const claimed = store.claimAttempt({ operationId, source: operation.input.source, scope: operation.scope, leaseMs, ...(operation.currentAttemptId ? {} : { expectedMessageId: operation.dispatchMessageId }) })
          fence = claimed.fence; attempt = claimed.attempt; operation = claimed.operation
        } catch (error) {
          if (error instanceof SyncStoreError && error.code === 'SYNC_BUDGET_EXHAUSTED') { store.recordBudgetExhaustion(operationId); return current() }
          throw error
        }
      } else fence = fenceFor(operation, attempt!)
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        try {
          mutex.assertHeld()
          const now = store.readOperation(operationId)
          if (now.control !== 'run' || now.currentAttemptId !== fence!.attemptId || now.deadlineAtMs <= Date.now()) controller.abort()
          else store.renewLease(fence!, leaseMs)
        } catch (error) { heartbeatFailure = failure('lease_heartbeat', error instanceof Error ? error.message : String(error), 'environment'); controller.abort() }
      }, heartbeatMs)
      operation = store.readOperation(operationId); attempt = store.readAttempt(fence.attemptId)
      if (!operation.planBlob) fail('plan_missing', '旧操作没有完整可信计划证据，不能猜测或借用另一份政策恢复')
      const savedRepair = stage<{ repairContext?: typeof repairContext; seed?: ElaborationRepairSeed }>(store, operation, attempt, 'repair-input')
      if (savedRepair) { repairContext = savedRepair.repairContext; seed = savedRepair.seed }
      else if (repairContext || seed) saveStage(store, fence, 'repair-input', { repairContext, seed })
      if (syncPlanDigest(options.plan) !== operation.policyDigest) fail('policy_binding', '提供的可信计划与operation.policyDigest不同')
      const view = await readInput(operation.input, options.plan, operation.previousBaselinePair, operation.requestBlob)
      if (view.readSetDigest !== operation.readSetDigest) fail('readset_binding', '冻结读集合与operation.readSetDigest不同')
      if (signal.aborted) fail('cancelled', '协调执行已停止')
      store.bindComposedInput(fence, view.composed)
      const callTimeoutMs = options.callTimeoutMs ?? Math.min(120_000, operation.budget.timeoutMs)
      const runner = options.runner ? injectedRunner(store, fence, options.runner) : createAttemptRunner(store, fence)
      let elaboration = stage<SavedElaboration>(store, operation, attempt, 'elaboration')
      if (!elaboration) {
        for (const prior of store.listAttempts(operation.id).filter(item => item.number < attempt!.number)) {
          const approved = stage<SavedElaboration>(store, operation, prior, 'elaboration')
          if (!approved?.structurePassed || !approved.reviewPassed || !['complete', 'needs_input', 'conflict'].includes(approved.status)) continue
          elaboration = approved
          saveStage(store, fence, 'elaboration-provenance', { operationId: operation.id, inputId: operation.input.id, policyDigest: operation.policyDigest, fromAttemptId: prior.id, evidenceRef: writeEvidence(operation.input.source.commonDir, approved), candidateDigest: approved.candidateDigest })
          saveStage(store, fence, 'elaboration', approved)
          break
        }
      }
      if (!elaboration) {
        if (operation.phase === 'analyzing') store.startElaboration(fence)
        const intent = view.frozen.nodes.find(node => node.id === options.plan.intentNodeId)
        const rawSource = options.plan.targets.find(target => target.nodeId === options.plan.intentNodeId)?.rawSource ?? intent?.rawSource
        if (!rawSource) fail('missing_intent', '冻结readset中没有明确raw原意')
        const targets = options.plan.targets.map(target => {
          const source = view.files.get(target.path) ?? null
          if (source !== null && view.frozen.nodes.find(node => node.path === target.path)?.id !== target.nodeId) fail('target_identity', '可信目标node/path与冻结解析结果不同')
          return { ...target, source, sourceDigest: source === null ? null : contentHash(source) }
        })
        const result = await elaborate({ root: operation.input.source.canonicalRoot, base: operation.input.headCommit, requestKey: `sync:${attempt.id}:elaborate`, intent: { nodeId: options.plan.intentNodeId, rawSource }, targets, context: view.frozen.nodes.filter(node => !targets.some(target => target.path === node.path)).map(node => ({ nodeId: node.id, path: node.path, source: view.files.get(node.path)! })), files: view.files, facts: options.plan.facts, verifications: options.plan.verifications.map(item => item.definition), authorizedChanges: options.plan.authorizedChanges ?? [], retiredIds: options.plan.retiredIds ?? [], maxRepairs: 0, maxCalls: 2, totalTimeoutMs: operation.deadlineAtMs - Date.now(), timeoutMs: callTimeoutMs, signal, model: 'gpt-6.1-sol', effort: 'high' }, { runner, seed })
        const { contracts: _contracts, graph: _graph, coverage: _coverage, ...compact } = result
        elaboration = compact; saveStage(store, fence, 'elaboration', compact)
      }
      if (!elaboration.structurePassed || !elaboration.reviewPassed) {
        if (['SYNC_BUDGET_EXHAUSTED', 'budget_exhausted'].includes(elaboration.failure?.code ?? '')) throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', elaboration.failure!.message)
        const last = elaboration.rounds.at(-1)
        const unsupported = elaboration.status === 'unsupported', stopped = elaboration.status === 'cancelled' || signal.aborted
        const kind: SyncFailure['kind'] = unsupported ? 'unsupported' : elaboration.status === 'conflict' ? 'conflict' : elaboration.status === 'needs_input' ? 'missing_input' : 'repairable'
        const issue = failure(elaboration.failure?.code ?? 'elaboration_failed', elaboration.failure?.message ?? '细化结构或独立评审未通过', kind, [writeEvidence(operation.input.source.commonDir, elaboration)])
        if (stopped) fail('cancelled', issue.message, issue.evidenceRefs)
        store.recordFailure(fence, issue)
        if (kind !== 'repairable') return current(unsupported ? 'unsupported' : undefined, issue)
        if (last?.candidate && last.candidateDigest) seed = { settled: true, requestKey: `sync:${attempt.id}:elaborate`, inputDigest: elaboration.inputDigest, candidateDigest: last.candidateDigest, output: last.output, candidate: last.candidate, findings: last.findings, review: last.review, traces: last.traces }
        continue
      }
      const acceptedFiles = new Map(view.files)
      seed = undefined
      for (const change of elaboration.changes) acceptedFiles.set(change.path, change.source)
      const accepted = await readFrozenContracts(operation.input.source.canonicalRoot, acceptedFiles)
      const scopeIds = unique([...operation.scope.contractIds, ...[...accepted.graph.items.values()].filter(item => item.kind !== 'FLOW' && item.kind !== 'VERIFY').map(item => item.id)])
      const flowIds = unique([...operation.scope.flowIds, ...[...accepted.graph.items.values()].filter(item => item.kind === 'FLOW').map(item => item.id)])
      const p1Evidence = writeEvidence(operation.input.source.commonDir, elaboration)
      if (!attempt.candidate) store.expandContractScope(fence, { contractIds: scopeIds, flowIds }, p1Evidence)
      const ready: SyncScope = { paths: [...operation.scope.paths], contractIds: unique(elaboration.readyIds.filter(id => accepted.graph.items.get(id)?.kind !== 'FLOW')), flowIds: unique(elaboration.readyFlowIds) }
      const blocked: SyncScope = { paths: [], contractIds: scopeIds.filter(id => !ready.contractIds.includes(id)), flowIds: flowIds.filter(id => !ready.flowIds.includes(id)) }
      const blockedReason = elaboration.status === 'conflict' ? 'conflicted' : elaboration.status === 'needs_input' || blocked.contractIds.length || blocked.flowIds.length ? 'needs_input' : null
      if (!ready.contractIds.some(id => accepted.graph.items.get(id)?.kind === 'AC')) {
        const issue = failure('no_ready_acceptance', '业务缺口阻塞全部可执行验收，保留细化证据而不写半成品', blockedReason === 'conflicted' ? 'conflict' : 'missing_input', [p1Evidence])
        store.recordFailure(fence, issue); return current(undefined, issue)
      }
      let generated = stage<SavedGeneration>(store, operation, store.readAttempt(attempt.id), 'generation')
      if (!generated) {
        if (attempt.candidate) fail('candidate_stage_missing', '已有冻结候选没有完整独立生成证据，不能覆盖或重新生成')
        store.startGeneration(fence, { readyScope: ready, blockedScope: blocked, blockedReason })
        const allowedGap = new Set([...elaboration.blockedStructureFindings, ...elaboration.rounds.flatMap(round => round.findings.filter(issue => ['unresolved-gap', 'unresolved-conflict'].includes(issue.code) && issue.itemId && accepted.graph.items.get(issue.itemId)?.kind === 'GAP'))].map(findingKey))
        const result = await runGeneration({ root: operation.input.source.canonicalRoot, requestKey: `sync:${attempt.id}:generation`, snapshot: operation.input, composed: view.composed, manifest: view.manifest, files: view.files, contracts: accepted.contracts, elaboratedSpecs: elaboration.changes.map(change => ({ path: change.path, source: change.source })), readyIds: [...ready.contractIds, ...ready.flowIds], blockedIds: [...blocked.contractIds, ...blocked.flowIds], intent: { nodeId: options.plan.intentNodeId, rawSource: accepted.nodes.find(node => node.id === options.plan.intentNodeId)!.rawSource! }, facts: options.plan.facts, existingAcceptance: view.frozen.contracts.flatMap(contract => contract.items.filter(item => item.kind === 'AC')), repairContext, allowedScope: ready, policy: { version: options.plan.version, digest: operation.policyDigest }, timeoutMs: callTimeoutMs, signal, model: 'gpt-6.1-sol', effort: 'high' }, { runner, validateCandidate: async candidate => {
          const frozen = await candidateContext(operation, candidate, view)
          const findings = frozen.findings.filter(issue => !(allowedGap.has(findingKey(issue)) && (!issue.itemId || blocked.contractIds.includes(issue.itemId) || blocked.flowIds.includes(issue.itemId))))
          for (const gap of [...accepted.graph.items.values()].filter(item => item.kind === 'GAP')) {
            const next = frozen.graph.items.get(gap.id)
            const meaning = (item: typeof gap): unknown => ({ id: item.id, kind: item.kind, gapKind: item.gapKind, unknown: item.unknown, affects: item.affects, evidence: item.evidence, decision: item.decision, source: item.source, dependsOn: item.dependsOn })
            if (next?.kind !== 'GAP' || canonical(meaning(gap)) !== canonical(meaning(next))) findings.push({ code: 'generation-gap-changed', severity: 'error', path: gap.path, nodeId: gap.nodeId, itemId: gap.id, message: '生成阶段不能删除或改变已独立审查GAP及其精确阻塞范围' })
          }
          findings.push(...checkGenerationContractIntent(accepted, frozen, { newNodeRawSources: new Map((options.plan.newNodeRawSources ?? []).map(item => [item.path, item.rawSource])), verifications: options.plan.verifications.map(item => item.definition) }))
          for (const oracle of options.plan.mandatoryTests) if (frozen.files.get(oracle.testPath) !== view.files.get(oracle.testPath)) findings.push({ code: 'oracle_changed', severity: 'error', path: oracle.testPath, nodeId: options.plan.intentNodeId, message: '独立测试义务不得由模型改写' })
          return findings
        } })
        const { candidateFiles: _files, ...compact } = result
        generated = compact; saveStage(store, fence, 'generation', compact)
      }
      if (generated.status !== 'reviewed' || !generated.candidate || !generated.candidateValidated || !generated.reviewPassed) {
        if (generated.failure?.code === 'SYNC_BUDGET_EXHAUSTED') throw new SyncStoreError('SYNC_BUDGET_EXHAUSTED', generated.failure.message)
        const kind: SyncFailure['kind'] = generated.status === 'needs_input' ? 'missing_input' : generated.status === 'conflict' ? 'conflict' : generated.status === 'unsupported' || ['input_invalid', 'context_budget'].includes(generated.failure?.code ?? '') ? 'unsupported' : 'repairable'
        const issue = failure(generated.failure?.code ?? 'generation_failed', generated.failure?.message ?? '实现候选或独立评审未通过', kind, [writeEvidence(operation.input.source.commonDir, generated)])
        if (signal.aborted || generated.status === 'cancelled') fail('cancelled', issue.message, issue.evidenceRefs)
        store.recordFailure(fence, issue)
        if (kind !== 'repairable') return current(kind === 'unsupported' ? 'unsupported' : undefined, issue)
        repairContext = { previousOutput: generated.output, diagnostics: generated.validationFindings.map(item => ({ code: item.code, message: item.message })).concat(generated.review?.findings.map(item => ({ code: item.kind, message: item.message })) ?? []) }; continue
      }
      const candidate = generated.candidate
      attempt = store.readAttempt(attempt.id)
      if (!attempt.candidate) store.freezeCandidate(fence, candidate)
      else if (canonical(attempt.candidate) !== canonical(candidate)) fail('candidate_binding', '已有候选不能替换')
      const frozenCandidate = await candidateContext(operation, candidate, view)
      const runs = acceptanceRuns(frozenCandidate, ready, options.plan)
      const candidateExportPath = join(options.artifactRoot, `export-${attempt.id}`), scratch = join(options.artifactRoot, `scratch-${attempt.id}`)
      let exported = stage<{ path: string; digest: string; exclusionBlob: BlobRef }>(store, operation, store.readAttempt(attempt.id), 'export')
      if (!exported) {
        saveStage(store, fence, 'export-intent', { path: candidateExportPath, tree: candidate.tree, candidateDigest: candidate.digest })
        if (existsSync(candidateExportPath)) fail('export_recovery', 'export存在但没有完整证明，保留现场等待恢复')
        const exportResult = exportCandidate(operation.input.source.commonDir, candidate, candidateExportPath)
        exported = { path: exportResult.root, digest: await verificationExportDigest(exportResult.root), exclusionBlob: exportResult.exclusionBlob }
        saveStage(store, fence, 'export', exported)
      }
      if (exported.path !== candidateExportPath || exported.digest !== await verificationExportDigest(candidateExportPath)) fail('export_changed', '候选readonly export已改变')
      mkdirSync(scratch, { recursive: true, mode: 0o700 }); safeArtifactRoot(scratch, operation)
      const v3Results: VerificationResult[] = []
      for (const run of runs) {
        const name = `v3:${run.verificationId}`
        let result = stage<VerificationResult>(store, operation, store.readAttempt(attempt.id), name)
        if (!result) {
          const verified = await runAttemptVerification(store, fence, { runId: contentHash(`${attempt.id}:${run.verificationId}`), inputDigest: operation.input.id, candidateDigest: candidate.digest, candidateExportDigest: exported.digest, candidateExportPath, privateScratchRoot: scratch, policy: run.policy, signal }, { driver: options.verificationDriver })
          result = verified.result
          if (store.readOperation(operationId).control === 'run' && store.readOperation(operationId).currentAttemptId === attempt.id && !signal.aborted) saveStage(store, fence, name, result)
        }
        v3Results.push(result)
        if (result.status !== 'passed') break
      }
      const failedV3 = v3Results.find(result => result.status !== 'passed')
      if (failedV3) {
        if (failedV3.status === 'recovery_required') return current('recovery_required')
        const ref = writeEvidence(operation.input.source.commonDir, failedV3)
        if (signal.aborted || failedV3.status === 'cancelled') fail('cancelled', failedV3.reason ?? '隔离运行已停止', [ref])
        const kind: SyncFailure['kind'] = failedV3.status === 'unsupported' ? 'unsupported' : 'repairable'
        const issue = failure(`verification_${failedV3.status}`, failedV3.reason ?? '真实隔离验收未通过', kind, [ref])
        store.recordFailure(fence, issue)
        if (kind === 'unsupported') return current('unsupported', issue)
        repairContext = { previousOutput: generated.output, diagnostics: [{ code: issue.code, message: `${issue.message}\n${canonical(failedV3.evidence ?? {})}` }] }; continue
      }
      const v4Ref = await v4(), v1Ref = writeEvidence(operation.input.source.commonDir, { candidateDigest: candidate.digest, findings: generated.validationFindings, candidateValidated: generated.candidateValidated }), v2Ref = writeEvidence(operation.input.source.commonDir, { candidateDigest: candidate.digest, review: generated.review, traces: generated.traces }), v3Refs = v3Results.map(result => writeEvidence(operation.input.source.commonDir, result))
      const bindings = { inputId: operation.input.id, candidateDigest: candidate.digest, policyDigest: operation.policyDigest, readSetDigest: operation.readSetDigest, environmentDigest: contentHash(canonical(runs.map(run => run.policy))), contextDigest: contentHash(canonical({ readSetDigest: view.readSetDigest, elaboration: p1Evidence, composed: view.composed })) }
      const result: VerificationResultBlob = { schemaVersion: 1, coveredScope: ready, ...bindings, layers: [{ layer: 'V1', verdict: 'pass', evidenceRefs: [v1Ref] }, { layer: 'V2', verdict: 'pass', evidenceRefs: [v2Ref] }, { layer: 'V3', verdict: 'pass', evidenceRefs: v3Refs }, { layer: 'V4', verdict: 'pass', evidenceRefs: [v4Ref] }] }
      store.recordVerification(fence, { ...bindings, passed: true, coveredScope: ready, evidenceRefs: [p1Evidence, v1Ref, v2Ref, ...v3Refs, v4Ref], resultBlob: writeEvidence(operation.input.source.commonDir, result) })
      const delivered = await deliverVerifiedAttempt(store, fence, { managedRoot: options.managedRoot, tools: options.tools, beforeApply: async () => { await v4() }, ...options.deliveryHooks })
      return { status: delivered.operation.phase, ...delivered }
    }
  } catch (error) {
    operation = store.readOperation(operationId)
    if (operation.phase === 'recovery_required') return current('recovery_required', operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId).failure ?? undefined : undefined)
    if (error instanceof SyncCoordinatorError && error.code === 'resource_recovery') return current('recovery_required', { code: error.code, message: error.message, kind: 'environment', evidenceRefs: error.evidenceRefs })
    if (operation.control !== 'run' || signal.aborted) {
      if (!await recoverResources(store, operation, options, true)) return current('recovery_required')
      if (heartbeatFailure && operation.control === 'run') return current('recovery_required', heartbeatFailure)
      if (operation.control === 'run' && operation.deadlineAtMs <= Date.now()) { store.recordBudgetExhaustion(operationId); return current() }
      if (operation.control === 'run') store.requestControl(operation.id, 'pause')
      return current()
    }
    const code = error instanceof SyncCoordinatorError || error instanceof SyncStoreError ? error.code : typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'coordinator_failed'
    const refs = error instanceof SyncCoordinatorError ? error.evidenceRefs : []
    const kind: SyncFailure['kind'] = code === 'SYNC_BUDGET_EXHAUSTED' ? 'budget' : ['input_changed', 'policy_changed', 'readset_changed', 'composition_conflict', 'request_conflict'].includes(code) ? 'conflict' : code === 'missing_intent' || code === 'no_ready_acceptance' ? 'missing_input' : code === 'export_recovery' || code === 'candidate_stage_missing' ? 'environment' : 'unsupported'
    const issue = failure(code, error instanceof Error ? error.message : String(error), kind, refs)
    if (code === 'SYNC_FENCE_EXPIRED') return current('recovery_required', issue)
    if (code === 'SYNC_BUDGET_EXHAUSTED') { store.recordBudgetExhaustion(operationId); return current(undefined, issue) }
    if (fence && operation.currentAttemptId === fence.attemptId && !['failed', 'superseded', 'settled'].includes(store.readAttempt(fence.attemptId).status)) {
      const attempt = store.readAttempt(fence.attemptId)
      if (attempt.expiresAtMs <= Date.now() && attempt.status !== 'applying') return current('recovery_required', issue)
      store.recordFailure(fence, issue)
    }
    const durableFailure = operation.currentAttemptId ? store.readAttempt(operation.currentAttemptId).failure : null
    return current(['export_recovery', 'candidate_stage_missing', 'cancellation_pending'].includes(code) ? 'recovery_required' : (durableFailure ?? issue).kind === 'unsupported' ? 'unsupported' : undefined, durableFailure ?? issue)
  } finally { if (timer) clearInterval(timer); mutex.release() }
}
