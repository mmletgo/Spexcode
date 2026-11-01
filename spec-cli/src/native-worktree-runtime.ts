import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detachedRuntimeIsGone, processStartToken, type ProcessIdentity } from '@spexcode/spec-core'
import { StructuredSessionError } from './session-structured-policy.js'

export type NativeWorktreeRequest = { baseCommit: string; tree: string; mode: 'read' | 'edit' }
export type NativeWorktreeResult = { baseCommit: string; baseTree: string; headCommit: string; tree: string; worktreePath: string }
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** 固定真实 seed 对象，拒绝 ref 或从当前工作区派生输入。 */
export function assertNativeWorktreeSeed(root: string, seed: NativeWorktreeRequest): void {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(seed.baseCommit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(seed.tree) || !['read', 'edit'].includes(seed.mode))
    throw new StructuredSessionError('failed', 'native worktree requires an immutable seed commit/tree and read or edit mode')
  if (git(root, ['rev-parse', '--verify', `${seed.baseCommit}^{commit}`]) !== seed.baseCommit || git(root, ['rev-parse', '--verify', `${seed.baseCommit}^{tree}`]) !== seed.tree)
    throw new StructuredSessionError('failed', 'native worktree seed commit/tree identity differs')
}

/** 只接受干净且归属 seed 的真实 Git 提交，冷复用必须保留全部身份。 */
export function nativeWorktreeResult(worktreePath: string, seed: NativeWorktreeRequest): NativeWorktreeResult {
  assertNativeWorktreeSeed(worktreePath, seed)
  if (realpathSync(git(worktreePath, ['rev-parse', '--show-toplevel'])) !== realpathSync(worktreePath) || git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']))
    throw new StructuredSessionError('failed', 'native worktree must be its recorded Git root and clean after normal add/commit')
  const headCommit = git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']), tree = git(worktreePath, ['rev-parse', '--verify', 'HEAD^{tree}'])
  if (seed.mode === 'read' && (headCommit !== seed.baseCommit || tree !== seed.tree)) throw new StructuredSessionError('failed', 'native read worktree changed its seed')
  try { git(worktreePath, ['merge-base', '--is-ancestor', seed.baseCommit, headCommit]) }
  catch { throw new StructuredSessionError('failed', 'native worktree HEAD is not a descendant of its seed') }
  const result = { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit, tree, worktreePath }
  return result
}

/** 正式 close 可移除历史工作区；冷复用只验证保留的不可变 Git 对象。 */
export function assertNativeWorktreeResult(root: string, seed: NativeWorktreeRequest, result: NativeWorktreeResult): void {
  assertNativeWorktreeSeed(root, seed)
  if (result.baseCommit !== seed.baseCommit || result.baseTree !== seed.tree || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.headCommit)
    || git(root, ['rev-parse', '--verify', `${result.headCommit}^{commit}`]) !== result.headCommit || git(root, ['rev-parse', '--verify', `${result.headCommit}^{tree}`]) !== result.tree
    || seed.mode === 'read' && (result.headCommit !== seed.baseCommit || result.tree !== seed.tree)) throw new StructuredSessionError('stale_result', 'native worktree saved Git object identity differs')
  try { git(root, ['merge-base', '--is-ancestor', seed.baseCommit, result.headCommit]) }
  catch { throw new StructuredSessionError('stale_result', 'native worktree saved HEAD is not a descendant of its seed') }
}

/** 给代理明确正常 Git 收尾要求；不限制正常文件工具。 */
export function nativeWorktreePrompt(prompt: string, seed: NativeWorktreeRequest): string {
  return `${prompt}\n\nWork in the current Git worktree using normal read/search/edit/test tools. ${seed.mode === 'read' ? 'This is a read/review task: leave HEAD, index and all worktree files unchanged and clean.' : 'Complete the requested changes and relevant checks, then use normal git add and git commit with hooks enabled. Leave the worktree clean; uncommitted edits are a failed result.'}`
}

export type NativeOwnedPlan = { root: string; pid?: number; receiptFile: string }

/** 正常 shell 工具可能派生新进程组，按 PID/start 身份记录全部已观察后代。 */
export function sampleNativeWorktreeProcesses(plan: NativeOwnedPlan): void {
  const path = join(plan.root, 'owned-processes.json')
  const owned = new Map((existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[] : []).map(item => [item.pid, item]))
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new StructuredSessionError('cancellation_pending', 'native worktree process census is unproven')
  const rows = result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), startToken: match[3].replace(/\s+/g, ' ') }] : []
  })
  const queue = plan.pid ? [plan.pid, ...owned.keys()] : [...owned.keys()], seen = new Set<number>()
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find(item => item.pid === pid), previous = owned.get(pid)
    if (previous && row && previous.startToken !== row.startToken) continue
    if (row) owned.set(pid, { pid, startToken: row.startToken })
    queue.push(...rows.filter(item => item.ppid === pid).map(item => item.pid))
  }
  writeFileSync(path, JSON.stringify([...owned.values()]), { mode: 0o600 })
}

/** CLI 整组和记录后代均死亡才释放容量；身份未知保留取消债务。 */
export function nativeWorktreeProcessesStopped(plan: NativeOwnedPlan, terminate = false): boolean {
  const path = join(plan.root, 'owned-processes.json')
  if (!plan.pid || !existsSync(path)) return false
  let stopped = detachedRuntimeIsGone(plan.pid, plan.receiptFile)
  for (const identity of JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[]) {
    const token = processStartToken(identity.pid)?.replace(/\s+/g, ' ')
    if (token && token !== identity.startToken) continue
    try { process.kill(identity.pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error }
    stopped = false
    if (terminate && token === identity.startToken) {
      try { process.kill(identity.pid, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return stopped
}
