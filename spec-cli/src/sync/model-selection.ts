import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { llmManagerRequested, llmManagerSettingsPath, LlmManagerHostError, resolveManagedRoute } from '../llm-manager-host.js'
import { managedModel, managedRoute, type ManagedRoute } from '../llm-manager-route.js'
import { SyncApplicationError } from './settings.js'

export const DEFAULT_SYNC_MODEL = 'gpt-6.1-sol'
export const DEFAULT_NATIVE_SYNC_MODEL = 'claude:default'
const MANAGED_SYNC_MODEL = 'llm-manager'
const WORKTREE_PROGRAMS = { cursor: 'cursor-agent', claude: 'claude', zcode: 'zcode', grok: 'grok', codex: 'codex' }
const WORKTREE_VENDORS = Object.keys(WORKTREE_PROGRAMS)
const run = promisify(execFile)

function installed(program: string): Promise<boolean> {
  return run('/usr/bin/which', [program], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 1000, maxBuffer: 4096,
  }).then(({ stdout }) => Boolean(stdout.trim()), () => false)
}

/** 网页只显示宿主的公开选路能力，实际设置经同源管理入口。 */
export async function readSyncModelSettings() {
  const authoritative = llmManagerRequested()
  const resolveManager = authoritative
    ? resolveManagedRoute().catch(error => {
      if (error instanceof LlmManagerHostError) return null
      throw error
    })
    : Promise.resolve(null)
  const [nativeVendors, selection] = await Promise.all([
    Promise.all(Object.entries(WORKTREE_PROGRAMS).map(async ([id, program]) => ({ id, installed: await installed(program) }))),
    resolveManager,
  ])
  const settingsPath = llmManagerSettingsPath()
  return {
    nativeVendors,
    llmManager: { configured: authoritative, ...(authoritative ? { authoritative: true } : {}), ...(settingsPath ? { settingsPath } : {}),
      ...(selection ? { selection: selection.vendor + ':' + selection.model } : {}) },
  }
}

/** 读取已持久历史时保留原缺省模型。 */
export function syncModel(input: { model?: string }, nativeWorkflow = false): string {
  return input.model ?? (nativeWorkflow ? DEFAULT_NATIVE_SYNC_MODEL : DEFAULT_SYNC_MODEL)
}

/** 宿主全托管只影响新准入，旧请求始终先读取原存档模型。 */
export function configuredSyncModel(input: { model?: string }, nativeWorkflow: boolean): string {
  return nativeWorkflow && llmManagerRequested() ? MANAGED_SYNC_MODEL : syncModel(input, nativeWorkflow)
}

/** 默认选择保留原持久载荷字节；只有非默认选择增加字段。 */
export function syncModelBinding(model?: string): { model?: string } {
  return model === undefined || model === DEFAULT_SYNC_MODEL ? {} : { model }
}

/** 新请求固定 Manager 的路线；同请求、普通重试和恢复沿原绑定。 */
export async function resolveSyncModel(
  selection: string,
  nativeWorkflow: boolean,
  previouslyBound?: string,
  nextAfter?: ManagedRoute,
): Promise<string> {
  if (previouslyBound !== undefined && (selection === MANAGED_SYNC_MODEL || selection === previouslyBound)) return previouslyBound
  if (selection !== MANAGED_SYNC_MODEL) {
    if (managedRoute(selection)) throw new SyncApplicationError('sync_llm_manager_untrusted_route', '只可从功能组取得 Manager 路线')
    if (nativeWorkflow && llmManagerRequested() && previouslyBound === undefined)
      throw new SyncApplicationError('sync_llm_manager_managed', '此宿主由 LLM Manager 功能组选路')
    return selection
  }
  if (!nativeWorkflow) throw new SyncApplicationError('sync_llm_manager_requires_native', 'llm-manager 需要原生工作树执行')
  if (!llmManagerRequested()) throw new SyncApplicationError('sync_llm_manager_config', '宿主尚未登记完整 LLM Manager 配置')
  const route = await resolveManagedRoute(nextAfter).catch(error => {
    if (error instanceof LlmManagerHostError) throw new SyncApplicationError(error.code, 'LLM Manager 未能完成正式选路')
    throw error
  })
  if (!route) throw new SyncApplicationError('sync_llm_manager_no_ready_route', 'LLM Manager 功能组没有已就绪路线')
  return managedModel(route)
}

/** 仅选择 CLI 执行器；固定模型或别名由原生配置解析。 */
export function assertWorktreeSyncModel(model: string): void {
  if (!WORKTREE_VENDORS.some(vendor => model.startsWith(vendor + ':') && model.length > vendor.length + 1)) throw Object.assign(new Error('native-worktree 同步需要选择已支持的执行器，可用 default 沿用 CLI 配置或指定模型'), { code: 'unsupported' })
}
