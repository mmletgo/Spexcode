import { assertNativeWorktreeSeed, assertNativeWorktreeResult, nativeWorktreeResult, nativeWorktreePrompt, type NativeWorktreeRequest, type NativeWorktreeResult } from './native-worktree-runtime.js'
import { Ajv } from 'ajv'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mainRoot, runtimeRoot, sessionArtifactPath } from '@spexcode/spec-core'
import { readRecord, withRecordLock, writeRecord } from './session-record.js'
import { codexStructuredTurn, codexStopStructuredTurn } from './codex-harness.js'
import { commitCodexGenerationRegistration, prepareCodexGenerationRegistration, readCodexGenerationLedger, resolveCodexGenerationForClose } from './codex-runtime-generations.js'
import { assertRejectedOutput, structuredGeneration, prepareStructuredRealm, prepareFrozenReaderRuntime, assertFrozenReaderRuntime, StructuredSessionError, StructuredSessionTransportError, structuredObserverState, structuredExecutionPolicy, structuredRealmRoot, pinNativeConfiguration, pinZCodeToolPolicy, type StructuredExecution, type FrozenReaderRuntime } from './session-structured-policy.js'
import { assertFrozenBinding, prepareFrozenPrompt, readFrozenManifest, type FrozenContextRef, type FrozenEntryJson, type FrozenReadProof, type FrozenReadReceipt } from './frozen-context.js'
import { verifyStructuredFrozenReadProof as verifyFrozenReadProof } from './structured-frozen-proof.js'
import { configuredSessionApplication } from './session-application.js'
import { withDeliveryLocks } from './delivery-lock.js'
import { claudeNativeModel, claudeStructuredTurn, stopClaudeStructuredTurn } from './claude-structured.js'
import { zcodeNativeModel, zcodeStructuredTurn, stopZCodeStructuredTurn } from './zcode-structured.js'
import type { SessionCreateTermination } from './sessions.js'
export { StructuredSessionError } from './session-structured-policy.js'

export class SettledSessionCreateTimeoutError extends StructuredSessionError {
  constructor(readonly termination: SessionCreateTermination) {
    super('timeout', 'native creation timed out and exact cleanup settled', { sessionId: termination.sessionId })
    this.name = 'SettledSessionCreateTimeoutError'
  }
}

export type StructuredSessionRequest = {
  root: string
  base?: string
  prompt: string
  schema: Record<string, unknown>
  requestKey: string
  inputDigest: string
  purpose: string
  timeoutMs: number | null
  signal?: AbortSignal
  model?: string
  effort?: StructuredExecution['effort']
  worktree?: NativeWorktreeRequest
  zcodeToolPolicy?: StructuredExecution['zcodeToolPolicy']
  nativeConfiguration?: StructuredExecution['nativeConfiguration']
  frozenContext?: FrozenContextRef
  /** 通用纯 JSON 冻结条目；prepareFrozenPrompt 在派发前物化并从持久请求中去掉载荷。 */
  frozenEntries?: readonly FrozenEntryJson[]
  /** 只有已登记reserveDispatch的内部资源桥设置；业务requestKey保持冻结清单绑定。 */
  sessionCreateKey?: string
  readerRuntime?: FrozenReaderRuntime
}
export type StructuredSessionResult = { sessionId: string; threadId: string; turnId: string; output: unknown; resultDigest: string; worktree?: NativeWorktreeResult; frozenReadProof?: FrozenReadProof }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requiredRealmRoot = (execution: StructuredExecution): string => {
  const root = structuredRealmRoot(execution)
  if (!root) throw new StructuredSessionError('unsupported', 'structured execution policy cannot select a trusted control realm')
  return root
}
const activeControllers = new Map<string, AbortController>()
const activeFinished = new Map<string, Promise<void>>()
const cancellations = new Map<string, Promise<StructuredCancellationResult>>()

export async function executeQueuedStructuredSession(id: string): Promise<StructuredExecution['state']> {
  const rec = readRecord(id)
  if (!rec?.structuredExecution) throw new StructuredSessionError('failed', 'queued structured session lost its execution policy')
  if (rec.structuredExecution.state && rec.structuredExecution.state !== 'running') return rec.structuredExecution.state
  const execution = rec.structuredExecution
  const nativeWorktree = execution.version === 6 && execution.policy === 'native-worktree-v1'
  const claude = nativeWorktree && execution.model?.startsWith('claude:') || execution.version === (execution.timeoutMs === null ? 5 : 3) && execution.policy === 'claude-frozen-read-only-v1'
  const zcode = nativeWorktree && execution.model?.startsWith('zcode:') || execution.version === (execution.timeoutMs === null ? 5 : 4) && execution.policy === 'zcode-frozen-read-only-v1'
  if (digest(structuredExecutionPolicy(execution)) !== digest({ ...execution, threadId: undefined, turnId: undefined, state: undefined, observer: undefined, cancellation: undefined, turnStartRequested: undefined, output: undefined, resultDigest: undefined, error: undefined, errorCode: undefined, frozenReads: undefined, frozenReadProof: undefined, claudeNative: undefined, zcodeNative: undefined, resultWorktree: undefined, failedWorktree: undefined }) || rec.harness !== (zcode ? 'zcode' : claude ? 'claude-headless' : 'codex-headless') || rec.launchCmd !== (zcode ? 'zcode' : claude ? 'claude' : 'codex'))
    throw new StructuredSessionError('unsupported', 'structured session no longer has the trusted fixed executor policy')
  const controller = new AbortController(); activeControllers.set(id, controller)
  let finish: () => void = () => {}
  activeFinished.set(id, new Promise<void>((resolvePromise) => { finish = resolvePromise }))
  let failedStage: { worktree?: NativeWorktreeResult; stop: { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string } } | undefined
  const update = async (change: Partial<StructuredExecution>): Promise<void> => {
    await withRecordLock(id, async () => {
      const current = readRecord(id)
      if (!current?.structuredExecution) throw new StructuredSessionError('failed', 'structured session record disappeared')
      for (const field of ['threadId', 'turnId'] as const)
        if (current.structuredExecution[field] && change[field] && current.structuredExecution[field] !== change[field])
          throw new StructuredSessionError('stale_result', `structured ${field} cannot replace its pinned identity`)
      if (['completed', 'cancelling', 'cancelled', 'timeout'].includes(current.structuredExecution.state ?? '') && (change.state !== undefined || change.turnStartRequested !== undefined) && change.state !== current.structuredExecution.state)
        throw new StructuredSessionError(current.structuredExecution.state === 'completed' ? 'stale_result' : current.structuredExecution.cancellation?.reason ?? 'cancelled', current.structuredExecution.error || 'structured execution has already settled')
      const next = { ...current.structuredExecution, ...change }
      if (change.turnId && next.state === 'running') {
        configuredSessionApplication().transitionSession(id, { status: 'active', proposal: null, note: null })
        writeRecord({ ...current, status: 'active', proposal: null, note: null, launchOwner: null, launchReadinessStartedAt: null, structuredExecution: next })
      } else writeRecord({ ...current, structuredExecution: next })
    })
  }
  try {
    await update({ state: 'running' })
    const generation = claude || zcode ? undefined : await structuredGeneration(requiredRealmRoot(execution), execution.readerRuntime)
    const callbacks = {
      signal: controller.signal,
      onTimeout: async () => { await cancelStructuredSession(id, { reason: 'timeout' }) },
      onTurnStarting: async () => update({ turnStartRequested: true }),
      onThread: async (threadId: string) => {
        await withRecordLock(id, async () => {
          const current = readRecord(id)!
          if ((current.structuredExecution?.threadId && current.structuredExecution.threadId !== threadId) || (current.harnessSessionId && current.harnessSessionId !== threadId))
            throw new StructuredSessionError('stale_result', 'structured thread cannot replace its pinned identity')
          if (generation) prepareCodexGenerationRegistration(generation.runtimeDir, id, threadId, generation.endpoint.id)
          writeRecord({ ...current, harnessSessionId: threadId, structuredExecution: { ...current.structuredExecution!, threadId, turnStartRequested: current.structuredExecution!.turnStartRequested ?? false } })
        })
        if (generation) commitCodexGenerationRegistration(generation.runtimeDir, id, threadId, generation.endpoint.id)
      },
      onTurn: async (turnId: string) => update({ turnId }),
      onFrozenRead: async (receipt: FrozenReadReceipt) => {
        await withRecordLock(id, async () => {
          const current = readRecord(id)!, state = current.structuredExecution!
          if (state.state !== 'running' || state.threadId !== receipt.threadId || state.turnId !== receipt.turnId)
            throw new StructuredSessionError('stale_result', 'frozen read cannot publish outside its active exact native turn')
          const receipts = state.frozenReads ?? [], previous = receipts.find(item => item.callId === receipt.callId)
          if (previous && digest(previous) !== digest(receipt)) throw new StructuredSessionError('stale_result', 'frozen native call identity was reused with different bytes')
          if (!previous) writeRecord({ ...current, structuredExecution: { ...state, frozenReads: [...receipts, receipt] } })
        })
      },
    }
    const prompt = readFileSync(sessionArtifactPath(id, 'launch'), 'utf8')
    let result: { threadId: string; turnId: string; text: string; frozenReadProof?: FrozenReadProof }
    try { result = zcode
      ? await zcodeStructuredTurn(requiredRealmRoot(execution), id, prompt, execution as Parameters<typeof zcodeStructuredTurn>[3], { ...callbacks, onNative: async native => update({ zcodeNative: native }) }, nativeWorktree ? rec.worktreePath : undefined)
      : claude
      ? await claudeStructuredTurn(requiredRealmRoot(execution), id, prompt, execution, { ...callbacks, onNative: async native => update({ claudeNative: native }) }, nativeWorktree ? rec.worktreePath : undefined)
      : await codexStructuredTurn(generation!.endpoint.socketPath, rec.worktreePath, readFileSync(sessionArtifactPath(id, 'launch'), 'utf8'), execution, callbacks)
    } catch (error) {
      if (nativeWorktree && error instanceof StructuredSessionError && error.rejectedOutput) {
        const current = readRecord(id)!.structuredExecution!
        assertRejectedOutput(error.rejectedOutput, prompt, execution, current)
        const stop = zcode ? await stopZCodeStructuredTurn(current as Parameters<typeof stopZCodeStructuredTurn>[0]) : await stopClaudeStructuredTurn(current)
        if (!stop.nativeStopped) throw new StructuredSessionError('cancellation_pending', stop.error || 'failed native stage stop remains unproven')
        failedStage = { stop }
        try { failedStage.worktree = nativeWorktreeResult(rec.worktreePath, execution.worktree!) }
        catch (cause) {
          if (!(cause instanceof StructuredSessionError) || cause.code !== 'native_worktree_result_invalid') throw cause
          console.error('structured failed stage Git witness rejected', JSON.stringify({ sessionId: id, code: cause.code, message: cause.message }))
        }
      }
      throw error
    }
    if (zcode && !nativeWorktree) {
      const model = zcodeNativeModel(execution.model)
      if (result.frozenReadProof?.version !== 4 || result.frozenReadProof.providerId !== model.providerId || result.frozenReadProof.modelId !== model.modelId) throw new StructuredSessionError('stale_result', 'ZCode result has no exact native provider/model witness')
    }
    if (claude && !nativeWorktree && (result.frozenReadProof?.version !== 3 || result.frozenReadProof.model !== claudeNativeModel(execution.model))) throw new StructuredSessionError('stale_result', 'Claude result has no exact native provider/model witness')
    if (execution.readerRuntime?.version === 2 && result.frozenReadProof?.version !== 2)
      throw new StructuredSessionError('stale_result', 'current frozen execution cannot publish legacy coverage as model-visible proof')
    const output: unknown = JSON.parse(result.text)
    const validate = new Ajv({ allErrors: true }).compile(execution.schema)
    if (!validate(output)) throw new StructuredSessionError('failed', `structured output does not match JSON schema: ${JSON.stringify(validate.errors)}`)
    const resultWorktree = nativeWorktree ? nativeWorktreeResult(rec.worktreePath, execution.worktree!) : undefined
    await update({ state: 'completed', ...(resultWorktree ? { resultWorktree } : {}), threadId: result.threadId, turnId: result.turnId, output, resultDigest: digest(output), ...(result.frozenReadProof ? { frozenReadProof: result.frozenReadProof } : {}) })
    return 'completed'
  } catch (error) {
    // A disconnected transport is recoverable from the same exact thread/turn. Preserve the running state
    // for a subsequent create retry; deterministic model, policy and JSON failures remain terminal.
    const pendingStop = readRecord(id)?.structuredExecution
    if (pendingStop?.state === 'completed' || pendingStop?.state === 'cancelling' || pendingStop?.state === 'cancelled' || pendingStop?.state === 'timeout') return pendingStop.state
    if (error instanceof StructuredSessionTransportError) throw error
    if (error instanceof StructuredSessionError && (error.code === 'cancellation_pending' || error.code === 'native_rpc_timeout')) {
      await update({ state: 'cancelling', ...(error.code === 'native_rpc_timeout' ? { errorCode: error.code } : {}), cancellation: { reason: 'cancelled', requestedAt: Date.now(), nativeStopped: false, acknowledged: false, error: error.message }, error: error.message })
      return 'cancelling'
    }
    const rejectedOutput = error instanceof StructuredSessionError ? error.rejectedOutput : undefined
    if (rejectedOutput) assertRejectedOutput(rejectedOutput, readFileSync(sessionArtifactPath(id, 'launch'), 'utf8'), execution, { threadId: pendingStop?.threadId, turnId: pendingStop?.turnId })
    const state = error instanceof StructuredSessionError && (error.code === 'cancelled' || error.code === 'timeout') ? error.code : 'failed'
    await update({ state, ...(rejectedOutput ? { rejectedOutput } : {}), ...(failedStage ? { ...(failedStage.worktree ? { failedWorktree: failedStage.worktree } : {}), cancellation: { reason: 'cancelled', requestedAt: Date.now(), ...failedStage.stop } } : {}), error: error instanceof Error ? error.message : String(error), ...(error instanceof StructuredSessionError && (error.code === 'structured_output_retries_exhausted' || error.code === 'structured_output_format_invalid' || error.code === 'native_worktree_result_invalid') ? { errorCode: error.code } : {}) })
    return state
  } finally { activeControllers.delete(id); activeFinished.delete(id); finish() }
}

export async function runStructuredSession(request: StructuredSessionRequest): Promise<StructuredSessionResult> {
  if (resolve(mainRoot(request.root)) !== resolve(mainRoot()))
    throw new StructuredSessionError('unsupported', 'structured execution root must belong to the backend project')
  if (!request.prompt.trim() || !request.inputDigest || !request.purpose || request.timeoutMs !== null && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)
    || !request.schema || request.schema.type !== 'object')
    throw new StructuredSessionError('failed', 'structured execution requires a prompt, input digest, purpose, positive or null timeout and object JSON schema')
  const claude = request.model?.startsWith('claude:') === true
  const zcode = request.model?.startsWith('zcode:') === true
  const { sessionCreateRequest, sessionCreateTimeoutMs, requestQueueDrain, queueStructuredRecovery, refreshQueueCandidate, sessionIdForCreateKey } = await import('./sessions.js')
  const saved = (claude || zcode) && request.worktree ? readRecord(sessionIdForCreateKey(request.sessionCreateKey ?? request.requestKey))?.structuredExecution : undefined
  const original = saved ?? (request.sessionCreateKey ? request : null)
  const nativeConfiguration = pinNativeConfiguration(request, original)
  if (nativeConfiguration) request = { ...request, nativeConfiguration }
  if (!nativeConfiguration && claude) claudeNativeModel(request.model)
  if (!nativeConfiguration && zcode) zcodeNativeModel(request.model)
  if (request.worktree) {
    assertNativeWorktreeSeed(request.root, request.worktree)
    if (request.base && request.base !== request.worktree.baseCommit) throw new StructuredSessionError('failed', 'native worktree base differs from immutable seed')
    request = { ...request, base: request.worktree.baseCommit, prompt: nativeWorktreePrompt(request.prompt, request.worktree) }
  }
  if (!request.worktree && !request.frozenContext) request = prepareFrozenPrompt(request, { directory: join(runtimeRoot(), 'frozen-context-v2') })
  const deadline = request.timeoutMs === null ? null : Date.now() + request.timeoutMs
  if (request.frozenContext) assertFrozenBinding(request.frozenContext, { ...readFrozenManifest(request.frozenContext).binding, requestKey: request.requestKey, inputDigest: request.inputDigest })
  const validate = new Ajv().compile(request.schema)
  if (!claude && !zcode && request.frozenContext && !request.readerRuntime) request = { ...request, readerRuntime: await prepareFrozenReaderRuntime(join(runtimeRoot(), 'structured-frozen-read-only-v2'), request.frozenContext) }
  if (request.readerRuntime) assertFrozenReaderRuntime(request.readerRuntime, request.model)
  const zcodeToolPolicy = pinZCodeToolPolicy(request, original)
  if (zcodeToolPolicy) request = { ...request, zcodeToolPolicy }
  const execution = structuredExecutionPolicy(request)
  if (!claude && !zcode) prepareStructuredRealm(requiredRealmRoot(execution), request.readerRuntime)
  const created = await sessionCreateRequest({ prompt: request.prompt, ...(request.base ? { base: request.base } : {}) }, {
    requestKey: request.sessionCreateKey ?? request.requestKey, signal: request.signal, timeoutMs: request.timeoutMs === null ? sessionCreateTimeoutMs() : Math.min(sessionCreateTimeoutMs(), request.timeoutMs), structuredExecution: execution,
  })
  if (created.status !== 201) throw new StructuredSessionError(created.code === 'session_create_key_reused' ? 'key_reused' : created.code === 'session_create_cancelled' ? 'cancelled' : created.code === 'session_create_timeout' ? 'timeout' : 'failed', created.error, { sessionId: created.termination?.sessionId })
  const id = created.session.id
  let cancelTask: Promise<StructuredCancellationResult> | undefined
  const cancel = (reason: 'cancelled' | 'timeout'): Promise<StructuredCancellationResult> => cancelTask ??= cancelStructuredSession(id, { reason })
  const onAbort = (): void => {
    // Retain the promise for the polling caller; the handler only prevents an event-callback rejection
    // from becoming unhandled before that caller awaits the exact cancellation result.
    void cancel('cancelled').catch(() => {})
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // Embedded callers have no index/graph watcher to refresh the queue's durable candidate cache.
    refreshQueueCandidate(id)
    requestQueueDrain()
    // Existing queue/drain owns execution capacity. A retry can rejoin an exact running native turn after
    // transport loss without manufacturing a second session or consulting an arbitrary assistant message.
    let recoveryRequested = false
    for (;;) {
      if (request.signal?.aborted) {
        const stopped = await cancel('cancelled')
        throw new StructuredSessionError(stopped.nativeStopped ? 'cancelled' : 'cancellation_pending', stopped.error || 'structured caller cancelled')
      }
      const rec = readRecord(id)
      const state = rec?.structuredExecution
      if (!state) throw new StructuredSessionError('stale_result', 'structured execution policy/result is missing')
      if (state.version !== execution.version || state.policy !== execution.policy || digest(structuredExecutionPolicy(state)) !== digest(execution))
        throw new StructuredSessionError('stale_result', 'structured result no longer matches its pinned input/schema/policy')
      if (state.state === 'completed') {
        if (!state.threadId || !state.turnId || !state.resultDigest || state.resultDigest !== digest(state.output) || !validate(state.output))
          throw new StructuredSessionError('stale_result', 'structured result identity or digest is invalid')
        if (state.worktree) {
          if (!state.resultWorktree || state.frozenReadProof || rec.base !== state.worktree.baseCommit || rec.forkCommit !== state.worktree.baseCommit || state.resultWorktree.worktreePath !== rec.worktreePath) throw new StructuredSessionError('stale_result', 'native worktree completion lost its Git identity')
          assertNativeWorktreeResult(request.root, state.worktree, state.resultWorktree)
          const rejectReplay = async (): Promise<never> => { throw new StructuredSessionError('stale_result', 'completed native worktree replay cannot dispatch') }
          const callbacks = { onThread: rejectReplay, onTurn: rejectReplay, onNative: rejectReplay }
          const recovered = state.model?.startsWith('zcode:')
            ? await zcodeStructuredTurn(requiredRealmRoot(state), id, request.prompt, state as Parameters<typeof zcodeStructuredTurn>[3], callbacks, rec.worktreePath)
            : await claudeStructuredTurn(requiredRealmRoot(state), id, request.prompt, state, callbacks, rec.worktreePath)
          if (digest(JSON.parse(recovered.text)) !== state.resultDigest || recovered.frozenReadProof) throw new StructuredSessionError('stale_result', 'native worktree completion differs from original native evidence')
        }
        if (state.frozenContext && (!state.frozenReadProof || state.frozenReadProof.contextDigest !== state.frozenContext.contextDigest || state.frozenReadProof.threadId !== state.threadId || state.frozenReadProof.turnId !== state.turnId))
          throw new StructuredSessionError('stale_result', 'structured frozen result lacks exact native history coverage evidence')
        if (state.frozenContext) {
          verifyFrozenReadProof(state.frozenContext, state.frozenReadProof!, { threadId: state.threadId, turnId: state.turnId }, state.readerRuntime?.version === 2 ? state.readerRuntime.toolOutputTokenLimit : undefined, { output: state.output })
          if (state.version === (state.timeoutMs === null ? 5 : 4) && state.policy === 'zcode-frozen-read-only-v1') {
            const rejectReplay = async (): Promise<never> => { throw new StructuredSessionError('stale_result', 'completed ZCode replay cannot dispatch') }
            const recovered = await zcodeStructuredTurn(requiredRealmRoot(state), id, request.prompt, state as Parameters<typeof zcodeStructuredTurn>[3], { onThread: rejectReplay, onTurn: rejectReplay, onNative: rejectReplay })
            if (digest(JSON.parse(recovered.text)) !== state.resultDigest || digest(recovered.frozenReadProof) !== digest(state.frozenReadProof)) throw new StructuredSessionError('stale_result', 'completed ZCode result differs from original native witness')
          } else if (state.version === (state.timeoutMs === null ? 5 : 3) && state.policy === 'claude-frozen-read-only-v1') {
            const recovered = await claudeStructuredTurn(requiredRealmRoot(state), id, request.prompt, state, { onThread: async () => { throw new StructuredSessionError('stale_result', 'completed Claude replay cannot create a session') }, onTurn: async () => { throw new StructuredSessionError('stale_result', 'completed Claude replay cannot create a user turn') }, onNative: async () => { throw new StructuredSessionError('stale_result', 'completed Claude replay cannot dispatch') } })
            if (digest(JSON.parse(recovered.text)) !== state.resultDigest || digest(recovered.frozenReadProof) !== digest(state.frozenReadProof)) throw new StructuredSessionError('stale_result', 'completed Claude result differs from original native witness')
          } else {
            const runtimeDir = join(requiredRealmRoot(state), 'control'), ledger = readCodexGenerationLedger(runtimeDir)
            const binding = ledger.bindings[id], generation = binding && ledger.generations[binding.generationId]
            if (!generation || generation.state === 'reclaimed' || binding.threadId !== state.threadId || rec.harnessSessionId !== state.threadId)
              throw new StructuredSessionError('stale_result', 'frozen completed result lost its exact native generation binding')
            const recovered = await codexStructuredTurn(generation.endpoint.socketPath, rec.worktreePath, request.prompt, { ...state, timeoutMs: deadline === null ? null : Math.max(1, deadline - Date.now()) }, {
              signal: request.signal, onThread: async () => { throw new StructuredSessionError('stale_result', 'completed recovery cannot create a new thread') },
              onTurn: async (turnId) => { if (turnId !== state.turnId) throw new StructuredSessionError('stale_result', 'completed recovery cannot replace its exact turn') },
              onFrozenRead: async () => { throw new StructuredSessionError('stale_result', 'completed recovery cannot reply to a new dynamic call') },
            })
            if (digest(JSON.parse(recovered.text)) !== state.resultDigest || digest(recovered.frozenReadProof) !== digest(state.frozenReadProof))
              throw new StructuredSessionError('stale_result', 'completed frozen result differs from exact native history')
          }
        }
        return { sessionId: id, threadId: state.threadId, turnId: state.turnId, output: state.output, resultDigest: state.resultDigest, ...(state.resultWorktree ? { worktree: state.resultWorktree } : {}), ...(state.frozenReadProof ? { frozenReadProof: state.frozenReadProof } : {}) }
      }
      if (state.state === 'cancelling') {
        if (state.errorCode === 'native_rpc_timeout') {
          const stopped = await (cancelTask ??= cancelStructuredSession(id, { reason: state.cancellation?.reason ?? 'cancelled', settleFailure: true }))
          throw new StructuredSessionError(stopped.nativeStopped ? stopped.state === 'failed' && !request.signal?.aborted ? 'native_rpc_timeout' : state.cancellation?.reason ?? 'cancelled' : 'cancellation_pending', state.error || 'native RPC failed before exact stop')
        }
        if (state.cancellation?.error) throw new StructuredSessionError('cancellation_pending', state.cancellation.error)
        const stopped = await cancel(state.cancellation?.reason ?? 'cancelled')
        throw new StructuredSessionError(stopped.nativeStopped ? state.cancellation?.reason ?? 'cancelled' : 'cancellation_pending', stopped.error || 'structured cancellation settled')
      }
      if (state.state === 'cancelled' || state.state === 'timeout') {
        const stopped = await cancel(state.state)
        throw new StructuredSessionError(stopped.nativeStopped ? state.state : 'cancellation_pending', stopped.error || 'structured cancellation settlement recovered')
      }
      if (state.state === 'failed') {
        if (state.rejectedOutput) assertRejectedOutput(state.rejectedOutput, request.prompt, execution, state)
        if (state.failedWorktree) {
          if (!request.worktree || !state.rejectedOutput || !state.cancellation?.nativeStopped || state.failedWorktree.worktreePath !== rec!.worktreePath) throw new StructuredSessionError('stale_result', 'failed stage Git witness lacks its original stopped request and record')
          assertNativeWorktreeResult(request.root, request.worktree, state.failedWorktree)
        }
        throw new StructuredSessionError(state.errorCode ?? 'failed', state.error || 'structured execution failed', { rejectedOutput: state.rejectedOutput, failedWorktree: state.failedWorktree })
      }
      if (state.state === 'running' && !recoveryRequested && structuredObserverState(state) === 'gone')
        recoveryRequested = await queueStructuredRecovery(id)
      if (deadline !== null && Date.now() >= deadline) {
        const stopped = await cancel('timeout')
        throw new StructuredSessionError(stopped.nativeStopped ? 'timeout' : 'cancellation_pending', stopped.error || 'structured execution exceeded caller deadline')
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  } catch (error) {
    if (error instanceof StructuredSessionError) {
      const state = readRecord(id)?.structuredExecution
      throw new StructuredSessionError(error.code, error.message, { sessionId: id, threadId: state?.threadId, turnId: state?.turnId, rejectedOutput: error.rejectedOutput, failedWorktree: error.failedWorktree })
    }
    throw error
  } finally { request.signal?.removeEventListener('abort', onAbort) }
}


export type StructuredCancellationResult = {
  sessionId: string
  state: NonNullable<StructuredExecution['state']>
  threadId?: string
  turnId?: string
  nativeStopped: boolean
  acknowledged: boolean
  nativeStatus?: string
  error?: string
}

// Cancellation revokes result publication before native control. A queued task has no native turn to
// stop; an accepted task stops only its pinned turn and requires native acknowledgement + settled read.
export async function cancelStructuredSession(id: string, options: { reason?: 'cancelled' | 'timeout'; timeoutMs?: number; wakeQueue?: boolean; settleFailure?: true } = {}): Promise<StructuredCancellationResult> {
  if ((options.reason !== undefined && !['cancelled', 'timeout'].includes(options.reason)) || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)))
    throw new StructuredSessionError('failed', 'structured cancellation needs a valid reason and positive bounded deadline', { sessionId: id })
  const existing = cancellations.get(id)
  if (existing) return existing
  // This control lock is distinct from the record lock: native RPC may wait while the observer
  // persists its exact identities and finishes. Cross-process callers join the same native cancellation.
  const flight = withDeliveryLocks([`structured-cancel-${id}`], async (): Promise<StructuredCancellationResult> => {
    let reason = options.reason ?? 'cancelled'
    const before = await withRecordLock(id, async () => {
      const rec = readRecord(id)
      if (!rec?.structuredExecution) throw new StructuredSessionError('unsupported', 'target is not a structured session', { sessionId: id })
      const execution = rec.structuredExecution
      if (options.settleFailure && execution.errorCode !== 'native_rpc_timeout') throw new StructuredSessionError('unsupported', 'automatic failure settlement requires the original typed native RPC failure', { sessionId: id })
      if (execution.state === 'completed' || execution.cancellation?.nativeStopped) return rec
      reason = execution.cancellation?.reason ?? reason
      writeRecord({ ...rec, stopped: true, structuredExecution: { ...execution, state: 'cancelling', cancellation: {
        reason, requestedAt: execution.cancellation?.requestedAt ?? Date.now(), nativeStopped: false, acknowledged: execution.cancellation?.acknowledged ?? false,
      } } })
      return readRecord(id)!
    })
    const execution = before.structuredExecution!
    if (execution.state === 'completed' || execution.cancellation?.nativeStopped) {
      if (execution.cancellation?.nativeStopped) {
        activeControllers.get(id)?.abort()
        await activeFinished.get(id)
      }
      return { sessionId: id, state: execution.state!, threadId: execution.threadId, turnId: execution.turnId,
        nativeStopped: true, acknowledged: execution.cancellation?.acknowledged ?? false, nativeStatus: execution.cancellation?.nativeStatus ?? execution.state }
    }
    activeControllers.get(id)?.abort()
    const finished = activeFinished.get(id)
    if (finished && (execution.turnStartRequested || execution.turnId)) await finished
    const current = readRecord(id)!, state = current.structuredExecution!
    let stop: { nativeStopped: boolean; acknowledged: boolean; turnId?: string; nativeStatus?: string; error?: string }
    if (state.version === 6 && state.policy === 'native-worktree-v1' && state.model?.startsWith('zcode:') || state.version === (state.timeoutMs === null ? 5 : 4) && state.policy === 'zcode-frozen-read-only-v1') stop = await stopZCodeStructuredTurn(state as Parameters<typeof stopZCodeStructuredTurn>[0], options.timeoutMs ?? 15_000)
    else if (state.version === 6 && state.policy === 'native-worktree-v1' && state.model?.startsWith('claude:') || state.version === (state.timeoutMs === null ? 5 : 3) && state.policy === 'claude-frozen-read-only-v1') stop = await stopClaudeStructuredTurn(state, options.timeoutMs ?? 15_000)
    else if ((!state.threadId || state.turnStartRequested === false) && !state.turnId) stop = { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
    else {
      const runtimeDir = join(requiredRealmRoot(state), 'control')
      const binding = state.threadId && current.harnessSessionId === state.threadId ? resolveCodexGenerationForClose(runtimeDir, id, state.threadId) : null
      if (!binding)
        stop = { nativeStopped: false, acknowledged: false, error: 'exact structured generation/thread binding is unavailable; native stop is unproven' }
      else if (binding.gone) stop = { nativeStopped: true, acknowledged: false, nativeStatus: 'generationGone' }
      else stop = await codexStopStructuredTurn(runtimeDir, binding.endpoint, state.threadId!, state.turnId,
        readFileSync(sessionArtifactPath(id, 'launch'), 'utf8'), options.timeoutMs ?? 15_000)
    }
    const result = await withRecordLock(id, async (): Promise<StructuredCancellationResult> => {
      const latest = readRecord(id)!, pinned = latest.structuredExecution!
      // A late native refusal/timeout cannot downgrade an already durable exact stop proof.
      if (pinned.cancellation?.nativeStopped)
        return { sessionId: id, state: pinned.state!, threadId: pinned.threadId, turnId: pinned.turnId,
          nativeStopped: true, acknowledged: pinned.cancellation.acknowledged, nativeStatus: pinned.cancellation.nativeStatus }
      const cancellation = { reason, requestedAt: pinned.cancellation!.requestedAt, ...stop, acknowledged: stop.acknowledged || pinned.cancellation!.acknowledged }
      const failed = options.settleFailure && pinned.errorCode === 'native_rpc_timeout'
      const next = stop.nativeStopped ? failed ? 'failed' : reason : 'cancelling'
      const note = failed ? pinned.error! : stop.nativeStopped ? `structured execution ${reason}; native ${stop.nativeStatus}` : `structured cancellation pending: ${stop.error}`
      configuredSessionApplication().transitionSession(id, { status: 'error', proposal: null, note })
      writeRecord({ ...latest, status: 'error', proposal: null, note, launchOwner: null, launchReadinessStartedAt: null,
        structuredExecution: { ...pinned, state: next, ...(stop.turnId ? { turnId: stop.turnId } : {}), cancellation, error: note } })
      return { sessionId: id, state: next, threadId: pinned.threadId, turnId: stop.turnId ?? pinned.turnId, ...stop, acknowledged: cancellation.acknowledged }
    })
    const { refreshQueueCandidate, requestQueueDrain } = await import('./sessions.js')
    refreshQueueCandidate(id)
    if (options.wakeQueue !== false) requestQueueDrain()
    return result
  })
  cancellations.set(id, flight)
  try { return await flight } finally { if (cancellations.get(id) === flight) cancellations.delete(id) }
}
