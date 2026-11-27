import { execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { managedFrozenCapability, readManagedRoute, type ManagedFrozenReader, type ManagedRoute } from './llm-manager-route.js'
import type { FrozenReaderRuntime, NativeTokenUsage, StructuredExecution } from './session-structured-policy.js'
import type { FrozenVisibleOutput, ManagedFrozenPromptInput, NormalizedFrozenRead } from './frozen-context.js'

const bridge = fileURLToPath(new URL('../llm-manager/host.py', import.meta.url))
const installedSettingsPath = '/llm-manager/'
const bundledNativeRuntime = new URL('../llm-manager/native-runtime.mjs', import.meta.url).href

export class LlmManagerHostError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function llmManagerRequested(): boolean {
  return Boolean(process.env.SPEX_LLM_MANAGER_CONFIG)
}

function llmManagerHost(): { python: string; config: string } {
  const python = process.env.SPEX_LLM_MANAGER_PYTHON, config = process.env.SPEX_LLM_MANAGER_CONFIG
  if (!python || !config || !isAbsolute(python) || !isAbsolute(config)) throw new LlmManagerHostError('llm_manager_host_config')
  return { python, config }
}

export function llmManagerSettingsFile(): string | undefined {
  const path = process.env.SPEX_LLM_MANAGER_SETTINGS_HTML
  return llmManagerRequested() && path && isAbsolute(path) && statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined
}

export function llmManagerSettingsPath(): string | undefined {
  return llmManagerSettingsFile() ? installedSettingsPath : undefined
}

type ManagerResponse = { ok: true; value: unknown } | { ok: false; code: string }

/** 只向桥进程 stdin 发送设置请求；进程错误的正文不跨越宿主边界。 */
function managerCall(message: Record<string, unknown>): Promise<unknown> {
  const { python, config } = llmManagerHost()
  return new Promise((accept, reject) => {
    const child = execFile(python, ['-I', bridge, 'rpc', config], {
      cwd: dirname(config), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
    }, (error, stdout) => {
      if (error) return reject(new LlmManagerHostError('llm_manager_host_unavailable'))
      let parsed: ManagerResponse
      try { parsed = JSON.parse(stdout) as ManagerResponse }
      catch { return reject(new LlmManagerHostError('llm_manager_host_invalid_response')) }
      if (parsed?.ok === true && Object.hasOwn(parsed, 'value')) return accept(parsed.value)
      const code = parsed?.ok === false && /^[a-z0-9_]{1,100}$/u.test(parsed.code) ? parsed.code : 'llm_manager_host_invalid_response'
      reject(new LlmManagerHostError(code))
    })
    child.stdin!.once('error', () => reject(new LlmManagerHostError('llm_manager_host_unavailable')))
    child.stdin!.end(JSON.stringify(message))
  })
}

type NativeVendor = 'claude' | 'codex' | 'cursor' | 'grok' | 'zcode'
type ManagerNativeRuntime = {
  nativeRuntimeVersion: 1
  nativeAdapterContract: 5
  findNativeExecutable(vendor: NativeVendor): string | undefined
  spawnGatedNativeProcess(command: string, args: readonly string[], options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stderr?: 'pipe' | 'ignore'
  }): ChildProcess
  spawnNativeProcess(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams
  loadNativeAdapter(vendor: NativeVendor): Promise<unknown>
}

const nativeRuntimes = new Map<string, Promise<ManagerNativeRuntime>>()

/** Locate the execution component in the same installed Manager that owns the provider route. */
export function loadManagerNativeRuntime(): Promise<ManagerNativeRuntime> {
  const python = llmManagerRequested() ? llmManagerHost().python : undefined
  const key = python ?? bundledNativeRuntime
  const previous = nativeRuntimes.get(key)
  if (previous) return previous
  const source = python ? new Promise<string>((accept, reject) => {
    execFile(python, ['-I', '-m', 'llm_manager.native_runtime'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 16384,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
    }, (error, stdout) => {
      if (error) return reject(new LlmManagerHostError('llm_manager_native_unavailable'))
      let result: { version?: unknown; path?: unknown } | null
      try { result = JSON.parse(stdout) as typeof result }
      catch { return reject(new LlmManagerHostError('llm_manager_native_invalid_response')) }
      if (result?.version !== 1 || typeof result.path !== 'string' || !isAbsolute(result.path))
        return reject(new LlmManagerHostError('llm_manager_native_invalid_response'))
      accept(pathToFileURL(result.path).href)
    })
  }) : Promise.resolve(bundledNativeRuntime)
  const runtime = source.then(async path => {
    const loaded = await import(path) as Partial<ManagerNativeRuntime>
    if (loaded.nativeRuntimeVersion !== 1 || typeof loaded.findNativeExecutable !== 'function'
        || typeof loaded.spawnGatedNativeProcess !== 'function' || typeof loaded.spawnNativeProcess !== 'function'
        || typeof loaded.loadNativeAdapter !== 'function')
      throw new LlmManagerHostError('llm_manager_native_invalid_response')
    if (loaded.nativeAdapterContract !== 5) throw new LlmManagerHostError('llm_manager_native_incompatible')
    return loaded as ManagerNativeRuntime
  }).catch(error => {
    nativeRuntimes.delete(key)
    if (error instanceof LlmManagerHostError) throw error
    throw new LlmManagerHostError('llm_manager_native_unavailable')
  })
  nativeRuntimes.set(key, runtime)
  return runtime
}

type NativeRecord = Record<string, unknown>
export type ManagedPersistentCodexTurn = { id: string; status: string; error?: unknown }
type PersistentCodexThread = { id: string; path?: string | null }
type ExactPersistentTurn = { threadId: string; turnId?: string; prompt: string }
export type ManagedFrozenArchiveOptions = { generation: string; home: string; cwd: string; threadId: string; turnId: string; prompt: string; toolName: string; expectedHistoryDigest?: string }
export type ManagedFrozenArchiveReceipt = {
  version: 1; generation: string; threadId: string; turnId: string; cwd: string; status: string; historySha256: string
  carrier: { path: string; sha256: string; size: number; dev: string; ino: string }
}
type ManagedFrozenArchiveHistory = { status: string; items: NativeRecord[]; outputs: FrozenVisibleOutput[]; finalText?: string }

type ManagerPersistentCodex = {
  initialize(clientName: string, version: string): Promise<void>
  auditReadOnly(options: { cwd: string; readerRuntime?: FrozenReaderRuntime }): Promise<void>
  startThread(options: { cwd: string; model?: string; dynamicTools?: readonly unknown[] }): Promise<PersistentCodexThread>
  startTurn(options: { threadId: string; cwd: string; prompt: string; schema: NativeRecord; model?: string; effort?: StructuredExecution['effort'] }): Promise<string>
  readTurns(threadId: string, turnId?: string): Promise<ManagedPersistentCodexTurn[]>
  readExactTurn(options: ExactPersistentTurn): Promise<ManagedPersistentCodexTurn>
  readItems(threadId: string, turnId: string): Promise<NativeRecord[]>
  readThread(threadId: string, includeTurns?: boolean): Promise<PersistentCodexThread>
  refreshModels(): Promise<string[]>
  listLoadedThreadIds(): Promise<string[]>
  listThreads(cwd: string, archived: boolean): Promise<string[]>
  archiveThread(threadId: string): Promise<void>
  captureFrozenArchive(options: ManagedFrozenArchiveOptions): Promise<{ receipt: ManagedFrozenArchiveReceipt; historyBytes: Buffer }>
  interrupt(threadId: string, turnId: string): Promise<void>
  onCompleted(handler: (threadId: string, turn: ManagedPersistentCodexTurn) => void): void
  onFrozenToolCall(toolName: string, handler: (call: Omit<NormalizedFrozenRead, 'text'> & { threadId: string; turnId: string }) => Promise<string>): void
  onFailure(handler: (error: Error & { code?: string }) => void): void
  drainToolCalls(): Promise<void>
  close(): void
}
export type ManagerPersistentCodexModule = {
  CodexPersistentAppServer: new (socketPath: string, requestTimeoutMs?: number) => ManagerPersistentCodex
  codexPersistentAppServerArgs(socketPath: string): string[]
  codexPersistentTerminalError(turn: ManagedPersistentCodexTurn): Error & { code?: string }
  codexPersistentConfig(readerRuntime?: FrozenReaderRuntime): string
  assertCodexUnboundRealmHasNoRollouts(home: string): void
  codexPersistentHomePaths(home: string): { configPath: string; authPath: string }
  codexPersistentSocketPaths(socketPath: string, uid: number): { rendezvous: string; daemonDirectory: string; physicalSocket: string; lockPath: string }
  codexBuildFrozenCatalog(options: { home: string; cliVersion: string; model?: string }): { bytes: Buffer; beforeDigest: string; digest: string; changedFields: string[] }
  codexAuditFrozenCatalog(options: { path: string; digest: string; model?: string }): void
  codexFrozenPrompt(input: ManagedFrozenPromptInput): { prompt: string; toolOutputTokenLimit: number }
  codexFrozenToolOutputTokenLimit(maxResponseBytes: number): number
  codexFrozenToolDefinition(): NativeRecord
  codexDecodeFrozenItems(items: readonly NativeRecord[], toolName: string): { finalText: string; reads: NormalizedFrozenRead[] }
  codexValidateFrozenVisibility(outputs: FrozenVisibleOutput[], toolOutputTokenLimit: number, expectedResponses: string[]): void
  codexReadFrozenRollout(options: { path: string; threadId: string; turnId: string; cwd: string; requireCompleted?: boolean }): { archived: boolean; outputs: FrozenVisibleOutput[] }
  verifyCodexFrozenArchive(options: ManagedFrozenArchiveOptions, receipt: ManagedFrozenArchiveReceipt, history: Uint8Array): ManagedFrozenArchiveHistory

}
export type ManagedCodexFrozenRuntime = ManagerPersistentCodexModule & { executable: string; reader: ManagedFrozenReader }

/** 冷复验只加载 Manager 的本地证据读取器。 */
export async function loadManagerPersistentCodex(): Promise<ManagerPersistentCodexModule> {
  if (!llmManagerRequested()) throw new LlmManagerHostError('llm_manager_native_capability_unavailable')
  const manager = await loadManagerNativeRuntime(), adapter = await manager.loadNativeAdapter('codex') as Partial<ManagerPersistentCodexModule>
  const exports: readonly (keyof ManagerPersistentCodexModule)[] = ['CodexPersistentAppServer', 'codexPersistentAppServerArgs', 'codexPersistentTerminalError',
    'codexPersistentConfig', 'codexPersistentHomePaths', 'assertCodexUnboundRealmHasNoRollouts', 'codexPersistentSocketPaths', 'codexBuildFrozenCatalog', 'codexAuditFrozenCatalog',
    'codexFrozenPrompt', 'codexFrozenToolOutputTokenLimit', 'codexFrozenToolDefinition', 'codexDecodeFrozenItems', 'codexValidateFrozenVisibility', 'codexReadFrozenRollout', 'verifyCodexFrozenArchive']
  if (exports.some(name => typeof adapter[name] !== 'function')) throw new LlmManagerHostError('llm_manager_native_capability_unavailable')
  return adapter as ManagerPersistentCodexModule
}

/** 实际启动必须使用原 Manager 选路认证的可执行文件。 */
export async function loadManagedCodexFrozenRuntime(reader: ManagedFrozenReader): Promise<ManagedCodexFrozenRuntime> {
  const adapter = await loadManagerPersistentCodex(), manager = await loadManagerNativeRuntime()
  const executable = manager.findNativeExecutable('codex')
  if (!executable || createHash('sha256').update(readFileSync(executable)).digest('hex') !== reader.cliSha256)
    throw new LlmManagerHostError('llm_manager_native_capability_unavailable')
  return { ...adapter, executable, reader }
}

export function applyLlmManagerSettings(body: Record<string, unknown>): Promise<unknown> {
  return managerCall({ action: 'settings', body })
}

export async function resolveManagedRoute(nextAfter?: ManagedRoute, sameGroupAs?: ManagedRoute, failedSessionId?: string, capability?: typeof managedFrozenCapability): Promise<ManagedRoute | null> {
  await loadManagerNativeRuntime()
  const route = await managerCall({
    action: 'resolve',
    ...(nextAfter ? { nextAfter } : {}),
    ...(sameGroupAs ? { sameGroupAs } : {}),
    ...(failedSessionId ? { failedSessionId } : {}),
    ...(capability ? { capability } : {}),
  })
  if (route === null) return null
  let selected: ManagedRoute
  try { selected = readManagedRoute(route) }
  catch (error) { if (capability) throw new LlmManagerHostError('llm_manager_native_capability_mismatch'); throw error }
  if (selected.frozenReader?.capability !== capability) throw new LlmManagerHostError('llm_manager_native_capability_mismatch')
  return selected
}

export async function reserveManagedRoute(route: ManagedRoute, sessionId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await loadManagerNativeRuntime()
  for (;;) {
    signal.throwIfAborted()
    try {
      await managerCall({ action: 'reserve', route, sessionId })
      return
    } catch (error) {
      if (!(error instanceof LlmManagerHostError) || error.code !== 'llm_manager_capacity') throw error
      await wait(350, undefined, { signal })
    }
  }
}

export async function settleManagedRoute(
  route: ManagedRoute,
  sessionId: string,
  outcome: 'completed' | 'quota' | 'stopped',
  usage?: NativeTokenUsage,
): Promise<'completed' | 'quota' | 'stopped'> {
  const result = await managerCall({ action: 'settle', route, sessionId, outcome, ...(usage ? { usage: {
    inputTokens: usage.totalInputTokens ?? usage.uncachedInputTokens,
    cachedInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
  } } : {}) })
  if (!result || typeof result !== 'object' || !('outcome' in result)
    || (result.outcome !== 'completed' && result.outcome !== 'quota' && result.outcome !== 'stopped'))
    throw new LlmManagerHostError('llm_manager_host_invalid_response')
  return result.outcome
}

export function managedClaudeCommand(route: ManagedRoute, sessionId: string, cli: string, sandboxProfile?: string): { command: string; args: string[] } {
  const { python, config } = llmManagerHost()
  return { command: python, args: ['-I', bridge, 'claude', config, route.routeId, sessionId, cli,
    ...(sandboxProfile ? ['--spex-sandbox-profile', sandboxProfile] : [])] }
}
