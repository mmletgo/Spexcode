import { execFile } from 'node:child_process'
import { dirname, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { SyncApplicationError } from './settings.js'

export const DEFAULT_SYNC_MODEL = 'gpt-6.1-sol'
export const DEFAULT_NATIVE_SYNC_MODEL = 'claude:default'
const MANAGED_SYNC_MODEL = 'llm-manager'
const WORKTREE_VENDORS: readonly string[] = ['cursor', 'claude', 'zcode', 'grok']
const runRouteBridge = promisify(execFile)

/** 新准入采用项目或宿主配置；读取历史操作时保留原缺省身份。 */
export function syncModel(input: { model?: string }, nativeWorkflow = false): string {
  if (input.model !== undefined) return input.model
  if (!nativeWorkflow) return DEFAULT_SYNC_MODEL
  return process.env.SPEX_LLM_MANAGER_PYTHON || process.env.SPEX_LLM_MANAGER_CLI_CONFIG ? MANAGED_SYNC_MODEL : DEFAULT_NATIVE_SYNC_MODEL
}

/** 默认选择保留原持久载荷字节；只有非默认选择增加字段。 */
export function syncModelBinding(model?: string): { model?: string } {
  return model === undefined || model === DEFAULT_SYNC_MODEL ? {} : { model }
}

/** 在准入时解析宿主功能组，之后只使用固定的原生 CLI 选择。 */
export async function resolveSyncModel(selection: string, nativeWorkflow: boolean, previouslyBound?: string): Promise<string> {
  if (selection !== MANAGED_SYNC_MODEL) return selection
  if (previouslyBound !== undefined) return previouslyBound
  if (!nativeWorkflow) throw new SyncApplicationError('sync_llm_manager_requires_native', 'llm-manager 需要原生工作树执行')
  const python = process.env.SPEX_LLM_MANAGER_PYTHON, config = process.env.SPEX_LLM_MANAGER_CLI_CONFIG
  if (!python || !config || !isAbsolute(python) || !isAbsolute(config)) throw new SyncApplicationError('sync_llm_manager_config', '宿主需登记 llm_manager 的 Python 与 CLI 路由配置绝对路径')
  let stdout: string
  try {
    ({ stdout } = await runRouteBridge(python, ['-I', '-m', 'llm_manager.cli_route', '--config', config, ...WORKTREE_VENDORS.flatMap(vendor => ['--vendor', vendor])], {
      cwd: dirname(config),
      encoding: 'utf8',
      env: {},
      timeout: 5000,
      maxBuffer: 4096,
    }))
  } catch (error) {
    if ((error as { code?: string | number }).code === 3) throw new SyncApplicationError('sync_llm_manager_no_ready_cli', 'llm_manager 功能组没有已就绪的原生 CLI')
    throw new SyncApplicationError('sync_llm_manager_unavailable', 'llm_manager CLI 选路失败，请检查宿主配置和 Python 安装')
  }
  let route: unknown
  try { route = JSON.parse(stdout) }
  catch { throw new SyncApplicationError('sync_llm_manager_route_invalid', 'llm_manager 返回了无法解析的 CLI 路由') }
  if (typeof route !== 'object' || route === null || Array.isArray(route) || Object.keys(route).length !== 3
    || !('version' in route) || route.version !== 'llm-manager-cli-route-v1'
    || !('vendor' in route) || typeof route.vendor !== 'string' || !WORKTREE_VENDORS.includes(route.vendor)
    || !('model' in route) || typeof route.model !== 'string' || !route.model || route.model !== route.model.trim() || /[\r\n\0]/.test(route.model)) {
    throw new SyncApplicationError('sync_llm_manager_route_invalid', 'llm_manager 返回了无效或未受支持的 CLI 路由')
  }
  return `${route.vendor}:${route.model}`
}

/** 仅选择CLI执行器；模型和别名交给原生配置解析，不设模型允许名册。 */
export function assertWorktreeSyncModel(model: string): void {
  if (!WORKTREE_VENDORS.some(vendor => model.startsWith(`${vendor}:`) && model.length > vendor.length + 1)) throw Object.assign(new Error('native-worktree 同步需要选择已支持的执行器，可用 default 沿用 CLI 配置或指定模型'), { code: 'unsupported' })
}
