import { watch, readdirSync, type Dirent, type FSWatcher } from 'node:fs'
import { join, relative, resolve } from 'node:path'
type Scope = 'sessions' | 'full'
type TreeWatchCallback = (event: 'rename' | 'change', filename: string | Buffer | null) => void
// the one filesystem primitive the registry is allowed to call — `fs.watch`'s overloads narrowed to the
// exact shape both transports use, so an injected fake is the same three arguments.
export type WatchFactory = (path: string, options: { recursive?: boolean }, callback: TreeWatchCallback) => FSWatcher
type WatchTransport = 'consolidated-recursive' | 'exact-directory'

export type TreeWatcherOptions = {
  root: string
  source: string
  scope: Scope
  recursive?: boolean
  ignore?: (relativePath: string) => boolean
  watchFactory?: WatchFactory
  transport?: WatchTransport
  onInput: (event: 'rename' | 'change', relativePath: string) => void
  onFailure: (error: Error) => void
}

// @@@ watch transport - the ONE place the platform appears. Observing a tree is a single product-level
// registration; how many registrations the OS actually holds for it is the transport's business.
//   consolidated-recursive — the OS itself observes a whole subtree from one registration (Darwin
//     FSEvents, Windows ReadDirectoryChangesW). It reports by PATH, so an atomic replacement inside the
//     tree stays visible, and exclusions filter on delivery because nothing is consumed per directory.
//   exact-directory — no such observer exists (Linux), and Node's `recursive` option is a USERSPACE
//     fan-out registering one inotify watch per file AND directory (measured: 201 directories -> 801
//     watches) which, watching files by inode, goes blind the moment a file is atomically replaced. So
//     we enumerate directories once and install one NON-recursive watch each, all multiplexed onto the
//     loop's single shared inotify descriptor, excluding .git/node_modules at traversal time.
export const consolidatedRecursiveWatch = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'darwin' || platform === 'win32'

// The live census across every registry: `sources` is what graph-stream asked the platform for (one per
// canonical root), `registrations` is what the platform is actually holding for them. Both are read by the
// watcher-budget tests and logged under SPEXCODE_BOARD_DEBUG, so a plateau is observable on every platform
// rather than only where /proc exposes inotify descriptors.
const liveRegistries = new Set<TreeWatcherRegistry>()
let liveRegistrations = 0
export function graphWatcherCensus(): { sources: number; registrations: number } {
  return { sources: liveRegistries.size, registrations: liveRegistrations }
}

export class TreeWatcherRegistry {
  readonly root: string
  readonly source: string
  readonly scope: Scope
  readonly transport: WatchTransport
  private readonly recursive: boolean
  private readonly ignore: (relativePath: string) => boolean
  private readonly watchFactory: WatchFactory
  private readonly onInput: TreeWatcherOptions['onInput']
  private readonly onFailure: TreeWatcherOptions['onFailure']
  private readonly handles = new Map<string, FSWatcher>()
  private refreshImmediate: ReturnType<typeof setImmediate> | null = null
  private failed = false

  constructor(options: TreeWatcherOptions) {
    this.root = resolve(options.root)
    this.source = options.source
    this.scope = options.scope
    this.recursive = options.recursive !== false
    this.transport = options.transport
      ?? (this.recursive && consolidatedRecursiveWatch() ? 'consolidated-recursive' : 'exact-directory')
    this.ignore = options.ignore ?? (() => false)
    this.watchFactory = options.watchFactory ?? (watch as unknown as WatchFactory)
    this.onInput = options.onInput
    this.onFailure = options.onFailure
  }

  get size(): number { return this.handles.size }
  paths(): string[] { return [...this.handles.keys()].sort() }
  // one kernel-side observer covers the subtree: the root is the only path we register, and no rename can
  // make the desired set drift, so there is nothing to re-walk.
  private get consolidated(): boolean { return this.recursive && this.transport === 'consolidated-recursive' }

  private desiredDirectories(): Set<string> {
    const desired = new Set<string>()
    const visit = (dir: string): void => {
      desired.add(dir)
      if (!this.recursive || this.consolidated) return
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) }
      catch (error) {
        if (dir !== this.root && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          desired.delete(dir)
          return
        }
        throw error
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        const rel = relative(this.root, path)
        if (!this.ignore(rel)) visit(path)
      }
    }
    visit(this.root)
    return desired
  }

  private closeHandles(): void {
    if (this.refreshImmediate) { clearImmediate(this.refreshImmediate); this.refreshImmediate = null }
    const handles = [...this.handles.values()]
    this.handles.clear()
    liveRegistrations -= handles.length
    liveRegistries.delete(this)
    for (const handle of handles) { try { handle.close() } catch { /* already gone */ } }
  }

  private sourceError(path: string, error: unknown): Error {
    const err = error as NodeJS.ErrnoException
    const reason = error instanceof Error ? error.message : String(error)
    // source + path + errno, always — an exhausted platform must name which syscall budget it refused.
    const errno = err?.code && !reason.includes(err.code) ? ` (errno ${err.code})` : ''
    return new Error(`spec-cli: graph watcher '${this.source}' failed at ${path}: ${reason}${errno}`)
  }

  private fail(path: string, error: unknown): false {
    if (this.failed) return false
    this.failed = true
    this.closeHandles()
    this.onFailure(this.sourceError(path, error))
    return false
  }

  private scheduleRefresh(): void {
    if (this.refreshImmediate || this.failed) return
    this.refreshImmediate = setImmediate(() => {
      this.refreshImmediate = null
      this.refresh()
    })
    this.refreshImmediate.unref?.()
  }

  refresh(): boolean {
    if (this.refreshImmediate) { clearImmediate(this.refreshImmediate); this.refreshImmediate = null }
    this.failed = false
    let desired: Set<string>
    try { desired = this.desiredDirectories() }
    catch (error) { return this.fail(this.root, error) }

    const before = this.handles.size
    for (const [path, handle] of [...this.handles]) {
      if (desired.has(path)) continue
      this.handles.delete(path)
      liveRegistrations--
      try { handle.close() } catch { /* already gone */ }
    }
    const options = this.consolidated ? { recursive: true } : {}
    for (const path of desired) {
      if (this.handles.has(path)) continue
      try {
        let handle: FSWatcher
        const callback: TreeWatchCallback = (event, filename) => {
          if (this.handles.get(path) !== handle) return
          if (filename == null) { this.fail(path, new Error('pathless filesystem event')); return }
          const inputPath = resolve(path, String(filename))
          const rel = relative(this.root, inputPath)
          if (rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel === '..') {
            this.fail(path, new Error(`event escaped watcher root: ${String(filename)}`))
            return
          }
          if (this.ignore(rel)) return
          this.onInput(event, rel)
          // only the userspace transport's desired set can drift: a new directory under a consolidated
          // observer is already covered by the kernel.
          if (this.recursive && !this.consolidated && event === 'rename') this.scheduleRefresh()
        }
        handle = this.watchFactory(path, options, callback)
        this.handles.set(path, handle)
        liveRegistrations++
        handle.on('error', (error) => {
          if (this.handles.get(path) === handle) this.fail(path, error)
        })
      } catch (error) { return this.fail(path, error) }
    }
    if (this.handles.size) liveRegistries.add(this)
    if (process.env.SPEXCODE_BOARD_DEBUG === '1' && this.handles.size !== before)
      console.warn(`spec-cli: graph watchers — sources=${liveRegistries.size} registrations=${liveRegistrations} (${this.source}: ${this.transport} ${this.handles.size})`)
    return true
  }

  close(): void {
    this.failed = false
    this.closeHandles()
  }
}

