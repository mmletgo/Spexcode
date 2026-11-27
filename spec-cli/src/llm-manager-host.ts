import { execFile, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readManagedRoute, type ManagedRoute } from './llm-manager-route.js'
import type { NativeTokenUsage } from './session-structured-policy.js'

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
    return loaded as ManagerNativeRuntime
  }).catch(error => {
    nativeRuntimes.delete(key)
    if (error instanceof LlmManagerHostError) throw error
    throw new LlmManagerHostError('llm_manager_native_unavailable')
  })
  nativeRuntimes.set(key, runtime)
  return runtime
}

export function applyLlmManagerSettings(body: Record<string, unknown>): Promise<unknown> {
  return managerCall({ action: 'settings', body })
}

export async function resolveManagedRoute(nextAfter?: ManagedRoute, sameGroupAs?: ManagedRoute, failedSessionId?: string): Promise<ManagedRoute | null> {
  const route = await managerCall({
    action: 'resolve',
    ...(nextAfter ? { nextAfter } : {}),
    ...(sameGroupAs ? { sameGroupAs } : {}),
    ...(failedSessionId ? { failedSessionId } : {}),
  })
  return route === null ? null : readManagedRoute(route)
}

export async function reserveManagedRoute(route: ManagedRoute, sessionId: string, signal: AbortSignal): Promise<void> {
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
