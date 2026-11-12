import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detachedRuntimeIsGone, hostProcessAdapter, parseProcStat, processStartToken, verifyDetachedRuntime, type ProcessIdentity } from '@spexcode/spec-core'
import { StructuredSessionError } from './session-structured-policy.js'

export type NativeWorktreeRequest = { baseCommit: string; tree: string; mode: 'read' | 'edit' }
export type NativeWorktreeResult = { baseCommit: string; baseTree: string; headCommit: string; tree: string; worktreePath: string }
const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function nativeWorktreeLaunch(worktreePath: string, cliPath: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'darwin') return { command: cliPath, args }
  const commonDir = realpathSync(git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const config = join(commonDir, 'config')
  const profile = `(version 1) (allow default) (deny file-write* (literal ${JSON.stringify(config)}) (literal ${JSON.stringify(config + '.lock')}))`
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, cliPath, ...args] }
}

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
  const actualRoot = realpathSync(git(worktreePath, ['rev-parse', '--show-toplevel']))
  const headCommit = git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']), tree = git(worktreePath, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const status = execFileSync('git', ['--no-optional-locks', '-C', worktreePath, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  const invalid = (reason: string): never => {
    const diagnostic = { mode: seed.mode, expected: { root: worktreePath, headCommit: seed.baseCommit, tree: seed.tree }, actual: { root: actualRoot, headCommit, tree, status } }
    throw new StructuredSessionError('native_worktree_result_invalid', `${reason}; Git result=${JSON.stringify(diagnostic)}. ${seed.mode === 'read' ? 'Read/review submits only this stage’s reviewable analysis; do not generate or commit experimental Specs. Experiments need independent temporary Git metadata: never copy a .git file that points back to this worktree. Submit a reviewable candidate for subsequent independent review and repair; one round need not be perfect.' : 'Use normal git add and git commit with hooks enabled after the relevant checks, and leave the worktree clean.'}`)
  }
  if (actualRoot !== realpathSync(worktreePath) || status) invalid('native worktree must be its recorded Git root and clean after normal add/commit')
  if (seed.mode === 'read' && (headCommit !== seed.baseCommit || tree !== seed.tree)) invalid('native read worktree changed its seed')
  try { git(worktreePath, ['merge-base', '--is-ancestor', seed.baseCommit, headCommit]) }
  catch (error) { if ((error as { status?: number }).status === 1) invalid('native worktree HEAD is not a descendant of its seed'); throw error }
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

export type NativeOwnedPlan = { root: string; pid?: number; receiptFile: string; workspace?: string; tmp?: string }

type NativeProcessRow = ProcessIdentity & { ppid: number }
const linuxProcessIdentityDomain = 'linux-proc-start-ticks-v1'
type NativeProcessBaseline = NativeProcessRow[] | { identityDomain: typeof linuxProcessIdentityDomain; rows: NativeProcessRow[] }

export const NATIVE_PROCESS_OBSERVATION_LIMIT_MS = 10_000
export const NATIVE_PROCESS_OBSERVATION_PENDING = 'native worktree process observation remains unproven'
export const NATIVE_PERIODIC_OBSERVATION_FAILURE = {
  cursor: 'Cursor periodic native process observation did not recover',
  grok: 'Grok periodic native process observation did not recover',
} as const

const observing = new Map<string, Promise<unknown>>()
const probes = new Map<string, { child: ReturnType<typeof spawn>; closed: boolean }>()
function observationPending(): StructuredSessionError { return new StructuredSessionError('cancellation_pending', NATIVE_PROCESS_OBSERVATION_PENDING) }
function assertObservationDeadline(deadline: number): void { if (Date.now() >= deadline) throw observationPending() }
function observeSerially<T>(plan: NativeOwnedPlan, observe: (deadline: number) => Promise<T>, deadline = Date.now() + NATIVE_PROCESS_OBSERVATION_LIMIT_MS): Promise<T> {
  const run = (): Promise<T> => { assertObservationDeadline(deadline); return observe(deadline) }
  const previous = observing.get(plan.root), current = previous ? previous.then(run, run) : Promise.resolve().then(run)
  observing.set(plan.root, current)
  const settled = current.finally(() => { if (observing.get(plan.root) === current) observing.delete(plan.root) })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(observationPending()), Math.max(0, deadline - Date.now()))
    settled.then(value => { clearTimeout(timer); if (Date.now() >= deadline) reject(observationPending()); else resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function nativeProcessOutput(plan: NativeOwnedPlan, command: string, args: string[], deadline: number, absentAllowed = false): Promise<string> {
  assertObservationDeadline(deadline)
  const previous = probes.get(plan.root)
  const gone = (probe: NonNullable<typeof previous>): boolean => probe.closed && (!probe.child.pid || hostProcessAdapter.liveness(-probe.child.pid) === 'absent')
  if (previous) {
    if (!gone(previous)) return Promise.reject(observationPending())
    probes.delete(plan.root)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const probe = { child, closed: false }
    probes.set(plan.root, probe)
    let stdout = Buffer.alloc(0), bytes = 0, failed = false
    const stopProbe = (): void => {
      if (failed) return
      failed = true
      const error = observationPending()
      reject(error)
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') Object.assign(error, { cause }) }
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref()
    }
    const append = (chunk: Buffer, output: boolean): void => {
      if (failed) return
      bytes += chunk.length
      if (bytes > 1024 * 1024) { stopProbe(); return }
      if (output) stdout = Buffer.concat([stdout, chunk])
    }
    child.stdout!.on('data', (chunk: Buffer) => append(chunk, true))
    child.stderr!.on('data', (chunk: Buffer) => append(chunk, false))
    const timer = setTimeout(stopProbe, Math.min(NATIVE_PROCESS_OBSERVATION_LIMIT_MS, Math.max(0, deadline - Date.now())))
    child.once('error', cause => { failed = true; clearTimeout(timer); reject(Object.assign(observationPending(), { cause })) })
    child.once('close', code => {
      clearTimeout(timer); probe.closed = true
      const stopped = gone(probe)
      if (stopped && probes.get(plan.root) === probe) probes.delete(plan.root)
      if (failed || !stopped || Date.now() >= deadline || code !== 0 && !(absentAllowed && code === 1)) reject(observationPending())
      else resolve(stdout.toString('utf8'))
    })
  })
}

/** 只读取同 UID 的 PID、父图与启动身份，不读取 argv、环境或凭据。 */
async function nativeProcessCensus(plan: NativeOwnedPlan, deadline: number): Promise<NativeProcessRow[]> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new StructuredSessionError('unsupported', 'native worktree requires a same-UID process census')
  const linux = process.platform === 'linux'
  const output = await nativeProcessOutput(plan, '/bin/ps', ['-axo', linux ? 'uid=,pid=' : 'uid=,pid=,ppid=,lstart='], deadline)
  if (!linux) {
    return output.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      return match && Number(match[1]) === uid ? [{ pid: Number(match[2]), ppid: Number(match[3]), startToken: match[4].replace(/\s+/g, ' ') }] : []
    })
  }
  const rows: NativeProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match || Number(match[1]) !== uid) continue
    assertObservationDeadline(deadline)
    const pid = Number(match[2])
    try {
      // A directory handle keeps both reads on the same proc entry even if the numeric PID is reused.
      const directory = await open(join('/proc', String(pid)), 'r')
      try {
        const path = join('/proc/self/fd', String(directory.fd))
        const status = await readFile(join(path, 'status'), 'utf8')
        const effectiveUid = /^Uid:[ \t]+\d+[ \t]+(\d+)/m.exec(status)?.[1]
        if (effectiveUid === undefined) throw observationPending()
        if (Number(effectiveUid) !== uid) continue
        const { ppid, startToken } = parseProcStat(await readFile(join(path, 'stat'), 'utf8'))
        rows.push({ pid, ppid, startToken })
      } finally { await directory.close() }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw Object.assign(observationPending(), { cause: error })
    }
  }
  assertObservationDeadline(deadline)
  return rows
}

function readProcessBaseline(root: string): NativeProcessRow[] {
  const saved = JSON.parse(readFileSync(join(root, 'process-baseline.json'), 'utf8')) as NativeProcessBaseline | null
  if (process.platform !== 'linux' && Array.isArray(saved)) return saved
  if (process.platform === 'linux' && !Array.isArray(saved) && saved?.identityDomain === linuxProcessIdentityDomain && Array.isArray(saved.rows)) return saved.rows
  throw observationPending()
}

/** spawn 前冻结同 UID 基线；运行中仅把实际观察到的 Native 后代记为已拥有。 */
export function sampleNativeWorktreeProcesses(plan: NativeOwnedPlan, deadline?: number): Promise<void> {
  return observeSerially(plan, limit => sampleProcesses(plan, limit), deadline)
}

/** 周期观测失败可在同一轮内复查，启动和最终停止仍各自取得原始证明。 */
export function periodicNativeWorktreeSampler(plan: NativeOwnedPlan, stopping: () => boolean, onFailure: (error: unknown) => void): () => void {
  let sampling = false, recovery: { deadline: number; error: StructuredSessionError } | undefined
  return () => {
    if (sampling || stopping()) return
    if (recovery && Date.now() >= recovery.deadline) { onFailure(recovery.error); return }
    sampling = true
    void sampleNativeWorktreeProcesses(plan, recovery?.deadline).then(() => { recovery = undefined }, error => {
      if (stopping()) return
      if (error instanceof StructuredSessionError && error.code === 'cancellation_pending')
        recovery ??= { deadline: Date.now() + NATIVE_PROCESS_OBSERVATION_LIMIT_MS, error }
      else onFailure(error)
    }).finally(() => { sampling = false })
  }
}

async function sampleProcesses(plan: NativeOwnedPlan, deadline: number): Promise<void> {
  await captureOwnedProcesses(plan, deadline)
  if (plan.pid) {
    const observation = await classifyOrphans(plan, deadline)
    assertObservationDeadline(deadline)
    persistNativeOrphanObservation(plan, observation)
  }
}
async function captureOwnedProcesses(plan: NativeOwnedPlan, deadline: number): Promise<void> {
  if (plan.pid) readProcessBaseline(plan.root)
  const path = join(plan.root, 'owned-processes.json'), rows = await nativeProcessCensus(plan, deadline)
  assertObservationDeadline(deadline)
  if (!plan.pid) {
    const baseline: NativeProcessBaseline = process.platform === 'linux' ? { identityDomain: linuxProcessIdentityDomain, rows } : rows
    writeFileSync(join(plan.root, 'process-baseline.json'), JSON.stringify(baseline), { mode: 0o400, flag: 'wx' })
    writeFileSync(path, '[]', { mode: 0o600 })
    return
  }
  const owned = new Map((existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[] : []).map(item => [item.pid, item]))
  const byPid = new Map(rows.map(row => [row.pid, row])), leader = byPid.get(plan.pid)
  if (leader && !owned.has(plan.pid)) {
    const verified = verifyDetachedRuntime(plan.pid, plan.receiptFile)
    if (verified.ok && leader.startToken === verified.identity.startToken.replace(/\s+/g, ' '))
      owned.set(leader.pid, { pid: leader.pid, startToken: leader.startToken })
  }
  const queue = [...owned.keys()], seen = new Set<number>()
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = byPid.get(pid), previous = owned.get(pid)
    if (!row || previous && previous.startToken !== row.startToken) continue
    owned.set(pid, { pid, startToken: row.startToken })
    queue.push(...rows.filter(item => item.ppid === pid).map(item => item.pid))
  }
  assertObservationDeadline(deadline)
  writeFileSync(path, JSON.stringify([...owned.values()]), { mode: 0o600 })
}

type NativeTaskRelatedProcess = ProcessIdentity & { boundaryVersion: 2; observedAt: number; cwd: string }
export type NativeOrphanObservation = { related: NativeTaskRelatedProcess[]; pending: NativeTaskRelatedProcess[]; unattributed: Array<NativeProcessRow & { cwd: string | null }> }

/** 只查候选 cwd；读取不到的位置不伪造成任务关联，且从不读取 argv/env。 */
async function nativeProcessWorkingDirectories(plan: NativeOwnedPlan, pids: number[], deadline: number): Promise<Map<number, string>> {
  const paths = new Map<number, string>()
  if (!pids.length) return paths
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try { paths.set(pid, readlinkSync(`/proc/${pid}/cwd`)) }
      catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
    return paths
  }
  const output = await nativeProcessOutput(plan, '/usr/sbin/lsof', [...(process.platform === 'darwin' ? ['-b'] : []), '-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], deadline, true)
  let pid: number | undefined
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    else if (pid !== undefined && line.startsWith('n')) paths.set(pid, line.slice(1))
  }
  return paths
}

/** 只读分类可用于旧现场离线核验；同 UID/PPID1 本身不产生任务债务。 */
export function classifyNativeWorktreeOrphans(plan: NativeOwnedPlan, deadline?: number): Promise<NativeOrphanObservation> {
  return observeSerially(plan, limit => classifyOrphans(plan, limit), deadline)
}
async function classifyOrphans(plan: NativeOwnedPlan, deadline: number): Promise<NativeOrphanObservation> {
  const baseline = new Map(readProcessBaseline(plan.root).map(row => [row.pid, row]))
  const rows = await nativeProcessCensus(plan, deadline), current = new Map(rows.map(row => [row.pid, row]))
  assertObservationDeadline(deadline)
  const owned = JSON.parse(readFileSync(join(plan.root, 'owned-processes.json'), 'utf8')) as ProcessIdentity[]
  const relatedPath = join(plan.root, 'task-related-processes.json')
  const related = existsSync(relatedPath) ? JSON.parse(readFileSync(relatedPath, 'utf8')) as NativeTaskRelatedProcess[] : []
  const candidates = rows.filter(row => {
    if (owned.some(identity => identity.pid === row.pid && identity.startToken === row.startToken) || baseline.get(row.pid)?.startToken === row.startToken) return false
    let parent = current.get(row.ppid)
    const seen = new Set<number>()
    while (parent && parent.pid > 1 && !seen.has(parent.pid)) {
      if (baseline.get(parent.pid)?.startToken === parent.startToken) return false
      seen.add(parent.pid); parent = current.get(parent.ppid)
    }
    return true
  })
  const paths = await nativeProcessWorkingDirectories(plan, candidates.filter(row => !related.some(item => item.pid === row.pid && item.startToken === row.startToken)).map(row => row.pid), deadline)
  assertObservationDeadline(deadline)
  const domains = [plan.root, plan.workspace, plan.tmp].filter((path): path is string => !!path).map(path => existsSync(path) ? realpathSync(path) : resolve(path))
  const unattributed: NativeOrphanObservation['unattributed'] = []
  for (const row of candidates) {
    if (related.some(item => item.pid === row.pid && item.startToken === row.startToken)) continue
    const cwd = paths.get(row.pid) ?? null
    if (cwd && domains.some(domain => cwd === domain || cwd.startsWith(domain + '/')))
      related.push({ pid: row.pid, startToken: row.startToken, cwd, boundaryVersion: 2, observedAt: Date.now() })
    else unattributed.push({ ...row, cwd })
  }
  return { related, pending: related.filter(item => current.get(item.pid)?.startToken === item.startToken), unattributed }
}

/** 新边界观察另存，绝不覆盖旧 unknown/exit 原件，也不为 cwd 关联授予 kill 权。 */
function persistNativeOrphanObservation(plan: NativeOwnedPlan, observation: NativeOrphanObservation): void {
  writeFileSync(join(plan.root, 'task-related-processes.json'), JSON.stringify(observation.related), { mode: 0o600 })
  writeFileSync(join(plan.root, 'unattributed-processes.json'), JSON.stringify(observation.unattributed), { mode: 0o600 })
}

/** receipt/历史 owned 与正向任务关联分别结算；系统旁观进程不进入任务容量。 */
export function nativeWorktreeProcessesStopped(plan: NativeOwnedPlan, terminate = false, deadline?: number): Promise<boolean> {
  return observeSerially(plan, limit => processesStopped(plan, terminate, limit), deadline)
}

/** 终止窗口内的暂态探针故障允许复验，每次仍要求原 receipt 和新鲜停止证明。 */
export async function waitForNativeWorktreeProcessesStopped(plan: NativeOwnedPlan, deadline: number, terminate: boolean, receiptMatches: () => boolean): Promise<boolean> {
  while (Date.now() < deadline && receiptMatches()) {
    try { if (await nativeWorktreeProcessesStopped(plan, terminate, deadline)) return true }
    catch (error) { if (!(error instanceof StructuredSessionError && error.code === 'cancellation_pending')) throw error }
    await delay(Math.min(25, Math.max(0, deadline - Date.now())))
  }
  return false
}

async function processesStopped(plan: NativeOwnedPlan, terminate: boolean, deadline: number): Promise<boolean> {
  const path = join(plan.root, 'owned-processes.json')
  if (!plan.pid || !existsSync(path) || !existsSync(join(plan.root, 'process-baseline.json'))) return false
  await captureOwnedProcesses(plan, deadline)
  assertObservationDeadline(deadline)
  let stopped = detachedRuntimeIsGone(plan.pid, plan.receiptFile)
  const owned = JSON.parse(readFileSync(path, 'utf8')) as ProcessIdentity[]
  for (const identity of owned) {
    const token = processStartToken(identity.pid)?.replace(/\s+/g, ' ')
    if (token && token !== identity.startToken) continue
    try { process.kill(identity.pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error }
    stopped = false
    if (terminate && token === identity.startToken) {
      assertObservationDeadline(deadline)
      try { process.kill(identity.pid, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  const observation = await classifyOrphans(plan, deadline)
  assertObservationDeadline(deadline)
  persistNativeOrphanObservation(plan, observation)
  const nativeStopped = stopped && observation.pending.length === 0
  assertObservationDeadline(deadline)
  appendFileSync(join(plan.root, 'process-stop-observations.jsonl'), JSON.stringify({ boundaryVersion: 2, at: Date.now(), pid: plan.pid, receiptFile: plan.receiptFile, knownStopped: stopped, taskRelatedPending: observation.pending, unattributed: observation.unattributed, nativeStopped }) + '\n', { mode: 0o600 })
  return nativeStopped
}
