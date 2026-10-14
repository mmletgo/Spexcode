import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute } from 'node:path'

type LockDatabase = { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void }
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new(path: string, options: { readOnly: boolean }) => LockDatabase }
export type FileMutex = { assertHeld(): void; release(): void }
const fail = (code: string, message: string): never => { throw new Error(`${code}: ${message}`) }

/** A separate rollback-journal connection holds the OS writer lock across short adopter file work. */
export function claimFileMutex(databasePath: string): FileMutex | null {
  if (!isAbsolute(databasePath) || databasePath.includes("\0")) fail("SYNC_MUTEX_PATH", "mutex requires an absolute file path")
  const identity = (path: string): string => {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || realpathSync(path) !== path) fail('SYNC_MUTEX_PATH', 'mutex paths must be canonical and cannot be symlinks')
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
  }
  const parent = dirname(databasePath), parentId = identity(parent)
  if (existsSync(databasePath) && !lstatSync(databasePath).isFile()) fail('SYNC_MUTEX_PATH', 'mutex must be a dedicated regular file')
  if (existsSync(databasePath)) identity(databasePath)
  const database = new DatabaseSync(databasePath, { readOnly: false })
  let held = false
  try {
    database.exec('PRAGMA busy_timeout=0')
    database.exec('BEGIN EXCLUSIVE'); held = true
    if (String(database.prepare('PRAGMA journal_mode').get()?.journal_mode) !== 'delete') fail('SYNC_MUTEX_PATH', 'mutex requires its own rollback-journal database')
    const marker = Number(database.prepare('PRAGMA application_id').get()?.application_id)
    if (marker === 0 && Number(database.prepare('SELECT count(*) AS n FROM sqlite_master').get()?.n) === 0) {
      database.exec('PRAGMA application_id=1397771597')
      database.exec('COMMIT'); held = false
      database.exec('BEGIN EXCLUSIVE'); held = true
    } else if (marker !== 1397771597) fail('SYNC_MUTEX_PATH', 'mutex cannot use another application database')
    const fileId = identity(databasePath)
    if (identity(parent) !== parentId) fail('SYNC_MUTEX_PATH', 'mutex parent was replaced')
    let released = false
    return {
      assertHeld() {
        if (released || identity(parent) !== parentId || identity(databasePath) !== fileId) fail('SYNC_MUTEX_IDENTITY', 'file mutex is released or its physical path changed')
      },
      release() {
        if (released) return
        try { database.exec('ROLLBACK') } finally { released = true; database.close() }
      },
    }
  } catch (error) {
    try { if (held) database.exec('ROLLBACK') } finally { database.close() }
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) return null
    throw error
  }
}
