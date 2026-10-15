import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { putBlob, readBlobByHash } from '@spexcode/spec-core'
import type { BlobRef, InputSnapshot, WorktreeIdentity } from './operation-types.js'

export type TreeEntry = { path: string; mode: '100644' | '100755' | '120000'; oid: string; digest: string }
export type SnapshotManifest = { version: 1; entries: TreeEntry[] }
export class UnstableSnapshotError extends Error { override name = 'UnstableSnapshotError' }
export const contentHash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const evidenceDir = (commonDir: string): string => join(commonDir, 'spexcode', 'evidence')
const gitEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
const GIT_TIMEOUT_MS = Number(process.env.SPEXCODE_GIT_TIMEOUT_MS || 120000)
const GIT_MAX_BUFFER = 128 * 1024 * 1024

/** Git 对象操作只面向明确的 commonDir；永不复用进程中的用户 index。 */
export function objectGit(commonDir: string, args: string[], input?: Buffer, indexFile?: string, worktreeRoot?: string): Buffer {
  const gitDir = indexFile ? dirname(indexFile) : commonDir
  const temp = input === undefined ? undefined : mkdtempSync(join(tmpdir(), 'spex-sync-git-input-'))
  let inputFd: number | undefined
  try {
    if (temp) {
      // 同步 stdin socket 的 EOF 曾阻塞快照；普通文件给 Git 固定字节与明确 EOF。
      const path = join(temp, 'input')
      writeFileSync(path, input!, { flag: 'wx', mode: 0o600 })
      inputFd = openSync(path, 'r')
    }
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', `--git-dir=${gitDir}`, ...(worktreeRoot ? [`--work-tree=${worktreeRoot}`] : []), ...args], { stdio: [inputFd ?? 'ignore', 'pipe', 'pipe'], cwd: worktreeRoot ?? commonDir, env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: '1', ...(indexFile ? { GIT_INDEX_FILE: indexFile, GIT_COMMON_DIR: commonDir } : {}) }, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GIT_MAX_BUFFER })
  } finally {
    if (inputFd !== undefined) closeSync(inputFd)
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}
const sourceGit = (root: string, args: string[]): Buffer => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.splitIndex=false', '-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: '1' }, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 * 1024 })
export function writeEvidence(commonDir: string, value: unknown): BlobRef { return { sha256: putBlob(Buffer.from(JSON.stringify(value)), evidenceDir(commonDir)) } }
export function readEvidence(commonDir: string, ref: BlobRef): Buffer {
  const result = readBlobByHash(ref.sha256, evidenceDir(commonDir))
  if (!result.ok) throw new Error(`缺失证据 ${ref.sha256}`)
  if (contentHash(result.bytes) !== ref.sha256) throw new Error(`证据摘要不匹配 ${ref.sha256}`)
  return result.bytes
}
export function validateRepositoryPath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error(`不合法仓库路径: ${path}`)
  return path
}
const physicalStat = (path: string): string => {
  const stat = lstatSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}
/** 已授权路径可在 HEAD 不可读前核对物理替换，不为缺失来源伪造快照。 */
export const readPhysicalFingerprint = (canonicalRoot: string, gitDir: string): string => contentHash(`${physicalStat(canonicalRoot)}:${physicalStat(gitDir)}`)
const registeredWorktreeRoots = (root: string): string[] => sourceGit(root, ['worktree', 'list', '--porcelain', '-z']).toString().split('\0').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice(9)))
export function identifyWorktree(root: string): WorktreeIdentity {
  const canonicalRoot = realpathSync(root)
  if (realpathSync(sourceGit(canonicalRoot, ['rev-parse', '--show-toplevel']).toString().trim()) !== canonicalRoot) throw new Error('输入必须为工作树根目录')
  const commonDir = realpathSync(sourceGit(canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim())
  const gitDir = realpathSync(sourceGit(canonicalRoot, ['rev-parse', '--absolute-git-dir']).toString().trim())
  const registered = registeredWorktreeRoots(canonicalRoot)
  if (!registered.includes(canonicalRoot)) throw new Error('输入不是 registered worktree')
  const branch = sourceGit(canonicalRoot, ['rev-parse', '--symbolic-full-name', 'HEAD']).toString().trim()
  return { repositoryId: contentHash(`${commonDir}:${physicalStat(commonDir)}`), commonDir, canonicalRoot, gitDir, branch, physicalFingerprint: readPhysicalFingerprint(canonicalRoot, gitDir) }
}
export function readTree(commonDir: string, tree: string): TreeEntry[] {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) throw new Error('tree 必须为不可变 Git OID')
  const listing = objectGit(commonDir, ['ls-tree', '-rlz', '--full-tree', tree])
  if (!Buffer.from(listing.toString('utf8')).equals(listing)) throw new Error('仓库路径必须为有效 UTF-8')
  const records = listing.toString().split('\0').filter(Boolean)
  const entries = records.map(record => {
    const tab = record.indexOf('\t'), [mode, type, oid, size] = record.slice(0, tab).split(/ +/), path = record.slice(tab + 1)
    validateRepositoryPath(path)
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw new Error(`不支持的 Git 条目: ${path} (${mode})`)
    return { path, mode: mode as TreeEntry['mode'], oid, size: /^\d+$/.test(size) ? Number(size) : NaN }
  })
  const digests = readObjectDigests(commonDir, entries)
  return entries.map(({ size: _size, ...entry }, index) => ({ ...entry, digest: digests[index] })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function verifyObjectOid(oid: string, bytes: Buffer): void {
  const actualOid = createHash(oid.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
  if (actualOid !== oid) throw new Error('Git blob OID 不匹配')
}
function readObjectDigests(commonDir: string, objects: { oid: string; size: number }[]): string[] {
  const digests: string[] = []
  for (let start = 0; start < objects.length;) {
    let end = start, capacity = 0
    while (end < objects.length) {
      const { oid, size } = objects[end], framedSize = Buffer.byteLength(`${oid} blob ${size}\n`) + size + 1
      if (!Number.isSafeInteger(size) || capacity + framedSize > GIT_MAX_BUFFER) break
      capacity += framedSize; end++
    }
    // 单个 blob 的原 128 MiB 输出上限不因 batch framing 缩小，也不被聚合放大。
    if (end === start) { digests.push(contentHash(readObject(commonDir, objects[start].oid))); start++; continue }
    const batch = objects.slice(start, end), output = objectGit(commonDir, ['cat-file', '--batch'], Buffer.from(batch.map(item => `${item.oid}\n`).join('')))
    let offset = 0
    for (const { oid, size } of batch) {
      const header = Buffer.from(`${oid} blob ${size}\n`)
      if (!output.subarray(offset, offset + header.length).equals(header)) {
        // missing/type 错误沿用单对象 Git 失败，保留采集端的有界重试分类。
        readObject(commonDir, oid)
        throw new Error('Git batch blob 响应不匹配')
      }
      offset += header.length
      const bytes = output.subarray(offset, offset + size)
      if (bytes.length !== size || output[offset + size] !== 10) throw new Error('Git batch blob 字节不完整')
      verifyObjectOid(oid, bytes)
      digests.push(contentHash(bytes)); offset += size + 1
    }
    if (offset !== output.length) throw new Error('Git batch blob 响应存在额外字节')
    start = end
  }
  return digests
}
export function readObject(commonDir: string, oid: string): Buffer {
  const bytes = objectGit(commonDir, ['cat-file', 'blob', oid])
  verifyObjectOid(oid, bytes)
  return bytes
}
export function writeObject(commonDir: string, bytes: Buffer): string { return objectGit(commonDir, ['hash-object', '-w', '--stdin'], bytes).toString().trim() }
export function writeTree(commonDir: string, entries: TreeEntry[]): string {
  const temp = mkdtempSync(join(tmpdir(), 'spex-sync-index-')), index = join(temp, 'index')
  writeFileSync(join(temp, 'HEAD'), 'ref: refs/heads/spex-sync-temporary\n')
  try {
    objectGit(commonDir, ['read-tree', '--empty'], undefined, index)
    const records = entries.map(entry => `${entry.mode} ${entry.oid}\t${validateRepositoryPath(entry.path)}\0`).join('')
    objectGit(commonDir, ['update-index', '-z', '--index-info'], Buffer.from(records), index)
    return objectGit(commonDir, ['write-tree'], undefined, index).toString().trim()
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function pinSnapshot(snapshot: InputSnapshot): void {
  verifySnapshot(snapshot)
  objectGit(snapshot.source.commonDir, ['update-ref', `refs/spex-sync/snapshots/${snapshot.id}`, snapshot.immutableTree])
  objectGit(snapshot.source.commonDir, ['update-ref', `refs/spex-sync/indices/${snapshot.id}`, snapshot.indexTree])
}
/** 从确认的原始字节形成来源快照；时间不参与身份或内容摘要。 */
function snapshotFromTree(source: InputSnapshot, tree: string): InputSnapshot {
  const entries = readTree(source.source.commonDir, tree), contentDigest = contentHash(JSON.stringify(entries))
  const manifestBlob = writeEvidence(source.source.commonDir, { version: 1, entries } satisfies SnapshotManifest)
  const snapshot = { ...source, immutableTree: tree, contentDigest, manifestBlob }
  snapshot.id = contentHash(JSON.stringify({ source: snapshot.source, headCommit: snapshot.headCommit, indexTree: snapshot.indexTree, indexDigest: snapshot.indexDigest, tree, contentDigest }))
  pinSnapshot(snapshot)
  return snapshot
}
function checkParents(root: string, path: string): void {
  let parent = dirname(join(root, path))
  while (parent !== root) {
    if (lstatSync(parent).isSymbolicLink()) throw new Error(`父路径为符号链接: ${path}`)
    parent = dirname(parent)
  }
}
type Observation = { source: WorktreeIdentity; head: string; indexTree: string; indexDigest: string; sharedIndexDigest: string; entries: TreeEntry[]; fileStamp: string }
function observe(root: string): Observation {
  const source = identifyWorktree(root), head = sourceGit(root, ['rev-parse', 'HEAD']).toString().trim()
  const indexPath = sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).toString().trim()
  const indexBytes = existsSync(indexPath) ? readFileSync(indexPath) : null
  // Git 读取 split index 也会更新 sharedindex 时间；所有 index 命令只读 owned 副本。
  const temp = mkdtempSync(join(tmpdir(), 'spex-sync-capture-')), index = join(temp, 'index'), sharedDigests: string[] = []
  let listing: Buffer, indexTree: string
  try {
    writeFileSync(join(temp, 'HEAD'), 'ref: refs/heads/spex-sync-temporary\n')
    for (const name of readdirSync(source.gitDir).filter(name => /^sharedindex\.[0-9a-f]+$/.test(name)).sort()) {
      const bytes = readFileSync(join(source.gitDir, name))
      writeFileSync(join(temp, name), bytes)
      sharedDigests.push(`${name}:${contentHash(bytes)}`)
    }
    if (indexBytes) writeFileSync(index, indexBytes)
    else objectGit(source.commonDir, ['read-tree', '--empty'], undefined, index)
    listing = objectGit(source.commonDir, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard'], undefined, index, root)
    indexTree = objectGit(source.commonDir, ['write-tree'], undefined, index).toString().trim()
  } finally { rmSync(temp, { recursive: true, force: true }) }
  if (!Buffer.from(listing.toString('utf8')).equals(listing)) throw new Error('仓库路径必须为有效 UTF-8')
  const paths = [...new Set(listing.toString().split('\0').filter(Boolean))].sort()
  const cachedRecords = objectGit(source.commonDir, ['ls-tree', '-rz', '--full-tree', indexTree]).toString().split('\0').filter(Boolean)
  if (cachedRecords.some(record => record.startsWith('160000 commit '))) throw new Error('不支持真实 gitlink/submodule 条目')
  const cachedPaths = new Set(cachedRecords.map(record => record.slice(record.indexOf('\t') + 1)))
  const nestedWorktrees = registeredWorktreeRoots(root).filter(path => path.startsWith(`${root}${sep}`))
  const stamps: string[] = [], entries: TreeEntry[] = [], objects = mkdtempSync(join(tmpdir(), 'spex-sync-objects-'))
  try {
    for (const path of paths) {
      const absolute = join(root, path)
      if (!cachedPaths.has(path) && nestedWorktrees.some(nested => absolute === nested || absolute.startsWith(`${nested}${sep}`))) continue
      validateRepositoryPath(path)
      // 已删除的 tracked 文件保留为 tree 中的删除差量。
      try { lstatSync(absolute) } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) { stamps.push(`${path}:deleted`); continue } throw error }
      checkParents(root, path)
      const stat = lstatSync(absolute, { bigint: true })
      if (stat.isDirectory() && cachedPaths.has(path)) { stamps.push(`${path}:directory-replacement`); continue }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`不支持目录/submodule条目: ${path}`)
      const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111n) !== 0n ? '100755' : '100644'
      writeFileSync(join(objects, String(entries.length)), bytes, { flag: 'wx', mode: 0o600 })
      entries.push({ path, mode, oid: '', digest: contentHash(bytes) })
      stamps.push(`${path}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${mode}:${contentHash(bytes)}`)
    }
    if (entries.length) {
      const oids = objectGit(source.commonDir, ['hash-object', '-w', '--no-filters', '--stdin-paths'], Buffer.from(entries.map((_, index) => `${index}\n`).join('')), undefined, objects).toString().trim().split('\n')
      if (oids.length !== entries.length || oids.some(oid => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))) throw new Error('Git batch 对象写入响应不匹配')
      entries.forEach((entry, index) => { entry.oid = oids[index] })
    }
  } finally { rmSync(objects, { recursive: true, force: true }) }
  return { source, head, indexTree, sharedIndexDigest: contentHash(JSON.stringify(sharedDigests)), indexDigest: contentHash(indexBytes ?? Buffer.alloc(0)), entries, fileStamp: contentHash(JSON.stringify(stamps)) }
}
const observationKey = (item: Observation): string => JSON.stringify({ source: item.source, head: item.head, indexDigest: item.indexDigest, indexTree: item.indexTree, sharedIndexDigest: item.sharedIndexDigest, entries: item.entries, fileStamp: item.fileStamp })
/** 双重采集完整文件清单、原字节、HEAD、index 与物理身份，不接受保存/切分支中的混合版本。 */
export async function captureInputSnapshot(root: string, options: { maxAttempts?: number; onObservation?: (attempt: number) => void | Promise<void> } = {}): Promise<InputSnapshot> {
  let readFailure: unknown
  for (let attempt = 1; attempt <= (options.maxAttempts ?? 3); attempt++) {
    try {
      const first = observe(realpathSync(root))
      const tree = writeTree(first.source.commonDir, first.entries)
      await options.onObservation?.(attempt)
      await new Promise<void>(done => setImmediate(done))
      const second = observe(realpathSync(root))
      if (observationKey(first) !== observationKey(second)) continue
      return snapshotFromTree({ id: '', source: first.source, headCommit: first.head, immutableTree: tree, indexTree: first.indexTree, indexDigest: first.indexDigest, manifestBlob: { sha256: '' }, contentDigest: '', capturedAtMs: Date.now() }, tree)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && typeof (error as { status?: unknown }).status !== 'number') throw error
      readFailure = error
    }
  }
  throw new UnstableSnapshotError('输入在采集期间持续变化或Git读取失败，未形成稳定快照', { cause: readFailure })
}
/** 只验证 tree 与 evidence；不读取可能继续被 Agent 写入的旧 attempt。 */
export function verifySnapshot(snapshot: InputSnapshot): TreeEntry[] {
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const actual = JSON.stringify({ version: 1, entries } satisfies SnapshotManifest)
  if (readEvidence(snapshot.source.commonDir, snapshot.manifestBlob).toString() !== actual || contentHash(JSON.stringify(entries)) !== snapshot.contentDigest) throw new Error('快照 manifest/contentDigest 不匹配 Git 对象')
  const expectedId = contentHash(JSON.stringify({ source: snapshot.source, headCommit: snapshot.headCommit, indexTree: snapshot.indexTree, indexDigest: snapshot.indexDigest, tree: snapshot.immutableTree, contentDigest: snapshot.contentDigest }))
  if (snapshot.id !== expectedId) throw new Error('快照身份摘要不匹配')
  return entries
}
export function safeSymlinkTarget(root: string, path: string, target: string): void {
  const absolute = resolve(dirname(join(root, path)), target)
  if (!absolute.startsWith(`${root}${sep}`) || target.startsWith('/') || absolute.slice(root.length + 1).split(sep).some(part => part.toLowerCase() === '.git')) throw new Error(`导出符号链接越界: ${path}`)
}
