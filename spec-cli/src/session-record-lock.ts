import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitCommonDir, runtimeRoot } from '@spexcode/spec-core'

const root = (): string => join(runtimeRoot(), '.session-record-locks')
const pathFor = (id: string): string => join(root(), `${id}.lock`)
const pause = (signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })); return }
  const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 10)
  signal?.addEventListener('abort', abort, { once: true })
})

function removeEmptyLock(path: string): boolean {
  try { rmdirSync(path); return true }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return true
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false
    throw error
  }
}

function releaseOwner(path: string, owner: string): boolean {
  try { unlinkSync(join(path, owner)) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
  // A replacement owner is published nonempty, so this cannot remove its directory.
  removeEmptyLock(path)
  return true
}

function tryAcquire(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true })
  const prepared = mkdtempSync(`${path}.claim-`)
  const owner = `${process.pid}-${randomUUID()}`
  let published = false
  try {
    writeFileSync(join(prepared, owner), '', { flag: 'wx' })
    try { renameSync(prepared, path) }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR') return null
      // Windows reports an existing destination directory as access denied.
      if (code === 'EPERM' && lstatSync(path, { throwIfNoEntry: false })) return null
      throw error
    }
    published = true
    return () => { releaseOwner(path, owner) }
  } finally {
    if (!published) rmSync(prepared, { recursive: true, force: true })
  }
}

function reclaimDeadOwner(path: string): boolean {
  let owner: string | undefined, pid: number
  try {
    const state = lstatSync(path)
    if (state.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true })
      if (!entries.length) return removeEmptyLock(path)
      if (entries.length !== 1 || !entries[0].isFile()) return false
      owner = entries[0].name
      const match = /^([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.exec(owner)
      if (!match) return false
      pid = Number(match[1])
    } else if (state.isFile()) {
      const legacy = readFileSync(path, 'utf8').trim()
      if (!/^[1-9]\d*$/.test(legacy)) return false
      pid = Number(legacy)
    } else return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return true
    throw error
  }
  if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) return false
  try { process.kill(pid, 0); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
  if (owner) return releaseOwner(path, owner)
  // Legacy unlink cannot remove a new directory, even if another reclaimer has already published it.
  try { unlinkSync(path); return true }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'EPERM') return false
    throw error
  }
}

async function acquire(path: string, label: string, signal?: AbortSignal): Promise<() => void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    const release = tryAcquire(path)
    if (release) return release
    if (reclaimDeadOwner(path)) continue
    if (Date.now() >= deadline) throw new Error(`${label}: timed out waiting for transaction lock`)
    await pause(signal)
  }
}

export async function withSessionRecordLock<T>(id: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquire(pathFor(id), `session record ${id}`, signal)
  try { return await body() } finally { release() }
}

export async function withWorktreeRegistryLock<T>(body: () => Promise<T>, signal?: AbortSignal, commonDir = gitCommonDir()): Promise<T> {
  const path = join(realpathSync(commonDir), 'spex-worktree-registry.lock')
  const release = await acquire(path, 'Git worktree registry', signal)
  try { return await body() } finally { release() }
}

export function withSessionRecordLockSync<T>(id: string, body: () => T): T {
  const release = trySessionRecordLockSync(id)
  if (!release) throw new Error(`session record ${id}: transaction lock is busy`)
  try { return body() } finally { release() }
}

export function trySessionRecordLockSync(id: string): (() => void) | null {
  return tryAcquire(pathFor(id))
}
