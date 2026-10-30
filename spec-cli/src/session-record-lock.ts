import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
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

async function acquire(path: string, label: string, signal?: AbortSignal): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + 30_000
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { unlinkSync(path) } catch { /* dead-owner recovery may have removed it */ } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner = 0
      try { owner = Number(readFileSync(path, 'utf8').trim()) || 0 } catch { /* creator/releaser race */ }
      if (owner && owner !== process.pid) {
        try { process.kill(owner, 0) } catch { try { unlinkSync(path) } catch { /* race */ }; continue }
      }
      if (Date.now() >= deadline) throw new Error(`${label}: timed out waiting for transaction lock`)
      await pause(signal)
    }
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
  mkdirSync(root(), { recursive: true })
  const path = pathFor(id)
  try {
    const fd = openSync(path, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return () => { try { unlinkSync(path) } catch { /* dead-owner recovery may have removed it */ } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw error
  }
}
