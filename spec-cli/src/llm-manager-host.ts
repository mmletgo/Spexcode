import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManagedRoute, type ManagedRoute } from './llm-manager-route.js'

const bridge = fileURLToPath(new URL('../llm-manager/host.py', import.meta.url))
const installedSettingsPath = '/llm-manager/'

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

export function applyLlmManagerSettings(body: Record<string, unknown>): Promise<unknown> {
  return managerCall({ action: 'settings', body })
}

export async function resolveManagedRoute(nextAfter?: ManagedRoute): Promise<ManagedRoute | null> {
  const route = await managerCall({ action: 'resolve', ...(nextAfter ? { nextAfter } : {}) })
  return route === null ? null : readManagedRoute(route)
}

export async function reserveManagedRoute(route: ManagedRoute, sessionId: string): Promise<void> {
  await managerCall({ action: 'reserve', route, sessionId })
}

export async function settleManagedRoute(
  route: ManagedRoute,
  sessionId: string,
  outcome: 'completed' | 'quota' | 'stopped',
  usage?: { inputTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number; outputTokens?: number },
): Promise<'completed' | 'quota' | 'stopped'> {
  const result = await managerCall({ action: 'settle', route, sessionId, outcome, ...(usage ? { usage } : {}) })
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
