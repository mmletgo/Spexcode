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

type NativeProcessRow = ProcessIdentity & { ppid: number }

/** 只读取同 UID 的 PID、父图与启动身份，不读取 argv、环境或凭据。 */
function nativeProcessCensus(): NativeProcessRow[] {
  const uid = process.getuid?.()
  if (uid === undefined) throw new StructuredSessionError('unsupported', 'native worktree requires a same-UID process census')
  const result = spawnSync('/bin/ps', ['-axo', 'uid=,pid=,ppid=,lstart='], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new StructuredSessionError('cancellation_pending', 'native worktree process census is unproven')
  return result.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return match && Number(match[1]) === uid ? [{ pid: Number(match[2]), ppid: Number(match[3]), startToken: match[4].replace(/\s+/g, ' ') }] : []
  })
}

/** spawn 前冻结同 UID 基线；运行中仅把实际观察到的 Native 后代记为已拥有。 */
export function sampleNativeWorktreeProcesses(plan: NativeOwnedPlan): void {
  const path = join(plan.root, 'owned-processes.json'), rows = nativeProcessCensus()
  if (!plan.pid) {
    writeFileSync(join(plan.root, 'process-baseline.json'), JSON.stringify(rows), { mode: 0o400, flag: 'wx' })
    writeFileSync(path, '[]', { mode: 0o600 })
    return
  }
  const owned = new Map((existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[] : []).map(item => [item.pid, item]))
  const queue = [plan.pid, ...owned.keys()], seen = new Set<number>()
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

/** 采样间隙失去父链的新进程只记 unknown；不能假定归属，也不能杀它。 */
function nativeUnknownProcesses(plan: NativeOwnedPlan, owned: ProcessIdentity[]): NativeProcessRow[] {
  const rows = nativeProcessCensus(), current = new Map(rows.map(row => [row.pid, row]))
  const baseline = new Map((JSON.parse(readFileSync(join(plan.root, 'process-baseline.json'), 'utf8')) as NativeProcessRow[]).map(row => [row.pid, row]))
  const unknown = rows.filter(row => {
    if (owned.some(identity => identity.pid === row.pid && identity.startToken === row.startToken) || baseline.get(row.pid)?.startToken === row.startToken) return false
    let parent = current.get(row.ppid)
    const seen = new Set<number>()
    while (parent && parent.pid > 1 && !seen.has(parent.pid)) {
      if (baseline.get(parent.pid)?.startToken === parent.startToken) return false
      seen.add(parent.pid); parent = current.get(parent.ppid)
    }
    return true
  })
  writeFileSync(join(plan.root, 'unknown-processes.json'), JSON.stringify(unknown), { mode: 0o600 })
  return unknown
}

/** 已知整组/后代死亡后再查孤儿窗口；未知进程保留容量且从不取得终止权限。 */
export function nativeWorktreeProcessesStopped(plan: NativeOwnedPlan, terminate = false): boolean {
  const path = join(plan.root, 'owned-processes.json')
  if (!plan.pid || !existsSync(path) || !existsSync(join(plan.root, 'process-baseline.json'))) return false
  sampleNativeWorktreeProcesses(plan)
  let stopped = detachedRuntimeIsGone(plan.pid, plan.receiptFile)
  const owned = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[]
  for (const identity of owned) {
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
  return stopped && nativeUnknownProcesses(plan, owned).length === 0
}
