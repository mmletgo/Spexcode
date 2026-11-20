import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { readRecordEntry, sessionArtifactPath } from '@spexcode/spec-core'
import { completedUpload, uploadPathsIn } from './uploads.js'
import { externalClaimFilesPath, readExternalClaims } from './session-adoption.js'

export class SessionFileError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 500, message: string) {
    super(message)
    this.name = 'SessionFileError'
  }
}

type SessionFileLock = <T>(id: string, body: () => T) => T
type SessionFileAsyncLock = <T>(id: string, body: () => Promise<T>) => Promise<T>

export const SESSION_FILE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024
export type SessionFilePreviewKind = 'text' | 'image' | 'html'
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.log', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.xml', '.py', '.go', '.rs', '.java', '.sh', '.sql'])
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
}

const filesPath = (id: string) => sessionArtifactPath(id, 'files.json')

function requireFilesPath(id: string): string {
  const claim = readExternalClaims(id)[0]
  if (claim?.revokedAtMs === null) return externalClaimFilesPath(claim)
  if (claim) throw new SessionFileError(404, `session ${id} does not exist`)
  const record = readRecordEntry(id)
  if (record.kind === 'corrupt') throw new SessionFileError(500, `session ${id} has an unreadable record: ${record.error}`)
  if (record.kind === 'ok') return filesPath(id)
  throw new SessionFileError(404, `session ${id} does not exist`)
}

function readFiles(path: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new SessionFileError(500, `session file list is unreadable: ${path} — ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || !isAbsolute(value)))
    throw new SessionFileError(500, `session file list is invalid: ${path}`)
  return [...new Set(parsed)]
}

function writeFiles(path: string, files: string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(files, null, 2)}\n`)
    renameSync(tmp, path)
  } finally {
    try { unlinkSync(tmp) } catch { /* rename already consumed the temporary file */ }
  }
}

function currentFile(path: string): void {
  try {
    if (!statSync(path).isFile()) throw new SessionFileError(400, `not a regular file: ${path}`)
    accessSync(path, constants.R_OK)
  } catch (error) {
    if (error instanceof SessionFileError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SessionFileError(404, `file does not exist: ${path}`)
    throw new SessionFileError(403, `file is not readable: ${path}`)
  }
}

export function listSessionFiles(id: string): string[] {
  return readFiles(requireFilesPath(id))
}

export type SessionFileStatus = { path: string; valid: boolean; reason?: string }

export function inspectSessionFiles(id: string): SessionFileStatus[] {
  return readFiles(requireFilesPath(id)).map((path) => {
    try { currentFile(path); return { path, valid: true } }
    catch (error) { return { path, valid: false, reason: error instanceof Error ? error.message : String(error) } }
  })
}

// Session projections already hold a parsed runtime envelope; re-checking it here would make an in-memory
// projection depend on the public route's existence guard. The route-facing list keeps that guard above.
export function readSessionFiles(id: string, path = filesPath(id)): string[] {
  return readFiles(path)
}

// How prose points at a posted file: the shortest `/`-bounded tail of its path that no other posted path
// shares. The dashboard resolves `[[file:<tail>]]` against the same list by the same rule, so the reference
// printed here is one it will open.
export function fileReference(path: string, files: readonly string[]): string {
  const parts = path.split('/').filter(Boolean)
  for (let n = 1; n <= parts.length; n++) {
    const tail = parts.slice(-n).join('/')
    if (files.filter((other) => other.endsWith(`/${tail}`)).length === 1) return `[[file:${tail}]]`
  }
  return `[[file:${path}]]`
}

// The inverse of fileReference: what a reader typed — a `[[file:<name>]]` tail or the whole path — back to the one
// posted path it names. The same `/`-bounded-tail rule as the dashboard's fileRefs, so a reference that renders as a
// link there resolves here, and a name that matches several paths (or none) is refused rather than guessed.
export function resolveFileReference(name: string, files: readonly string[]): { path: string } | { error: string } {
  const tail = name.replace(/^\[\[file:|\]\]$/g, '')
  const matches = files.filter((path) => path === tail || path.endsWith(`/${tail}`))
  if (matches.length === 1) return { path: matches[0] }
  if (!matches.length) return { error: `no posted file named ${JSON.stringify(tail)}` }
  return { error: `${JSON.stringify(tail)} names ${matches.length} posted files — use more of the path: ${matches.join(', ')}` }
}

export function addSessionFile(id: string, input: string, lock: SessionFileLock, cwd = process.cwd()): { path: string; added: boolean; reference: string } {
  const path = resolve(cwd, input)
  currentFile(path)
  return lock(id, () => {
    const manifest = requireFilesPath(id)
    const files = readFiles(manifest)
    if (files.includes(path)) return { path, added: false, reference: fileReference(path, files) }
    const next = [...files, path]
    writeFiles(manifest, next)
    return { path, added: true, reference: fileReference(path, next) }
  })
}

export type SessionUpload = { path: string; name: string; uploadedAt: number }

export function sessionUploads(files: readonly string[]): SessionUpload[] {
  return files.flatMap((path) => {
    const upload = completedUpload(path)
    return upload ? [{ path, ...upload }] : []
  })
}

// Only a completed upload that still exists is posted; any other path the text mentions is left alone. The
// backend posts while a starting session's own transactions hold its record, so this waits for the lock.
export async function postSentUploads(id: string, text: string, lock: SessionFileAsyncLock): Promise<string[]> {
  const sent = uploadPathsIn(text).filter((path) => {
    try { currentFile(path); return true } catch { return false }
  })
  if (!sent.length) return []
  return lock(id, async () => {
    const manifest = requireFilesPath(id)
    const files = readFiles(manifest)
    const added = sent.filter((path) => !files.includes(path))
    if (added.length) writeFiles(manifest, [...files, ...added])
    return added
  })
}

export function retractSessionFile(id: string, input: string, lock: SessionFileLock, cwd = process.cwd()): { path: string; removed: boolean } {
  const path = resolve(cwd, input)
  return lock(id, () => {
    const manifest = requireFilesPath(id)
    const files = readFiles(manifest)
    if (!files.includes(path)) return { path, removed: false }
    writeFiles(manifest, files.filter((file) => file !== path))
    return { path, removed: true }
  })
}

export function openSessionFile(id: string, path: string): { path: string; name: string; size: number } {
  if (!readFiles(requireFilesPath(id)).includes(path)) throw new SessionFileError(403, 'that path was not posted by this session')
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new SessionFileError(404, `file no longer exists: ${path}`)
    accessSync(path, constants.R_OK)
    return { path, name: basename(path) || 'download', size: stat.size }
  } catch (error) {
    if (error instanceof SessionFileError) throw error
    throw new SessionFileError(404, `file no longer exists: ${path}`)
  }
}

export function sessionFilePreviewKind(path: string): { kind: SessionFilePreviewKind; contentType: string } | null {
  const extension = basename(path).toLowerCase().match(/\.[^.]+$/)?.[0]
  if (!extension) return null
  if (HTML_EXTENSIONS.has(extension)) return { kind: 'html', contentType: 'text/html; charset=utf-8' }
  if (TEXT_EXTENSIONS.has(extension)) return { kind: 'text', contentType: 'text/plain; charset=utf-8' }
  const contentType = IMAGE_TYPES[extension]
  return contentType ? { kind: 'image', contentType } : null
}

export const sessionFilesPath = (id: string) => filesPath(id)
