import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TreeWatcherRegistry } from '../tree-watcher.js'
import type { TreeWatcherOptions } from '../tree-watcher.js'

export type SyncObserverHealth = {
  status: 'offline' | 'starting' | 'watching' | 'degraded' | 'missing' | 'invalidated'
  watchOnline: boolean
  reason: { code: string; message: string } | null
  lastScanAtMs: number | null
}
export type SyncObserverOptions = {
  root: string
  gitDir: string
  commonDir: string
  scan: () => Promise<void>
  health: (health: SyncObserverHealth) => void
  debounceMs?: number
  compensationMs?: number
  watchFactory?: TreeWatcherOptions['watchFactory']
}

/** 服务持有观察器；事件合并只减少突发扫描，不丢扫描期间的最后一次保存。 */
export class SyncInputObserver {
  private rootFingerprint: string | null = null
  private watchers: TreeWatcherRegistry[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private compensation: ReturnType<typeof setInterval> | null = null
  private flight: Promise<void> | null = null
  private dirty = false
  private active = false
  private lastScanAtMs: number | null = null
  private watchFailure: Error | null = null
  constructor(private readonly options: SyncObserverOptions) {}

  private report(status: SyncObserverHealth['status'], reason: SyncObserverHealth['reason'] = null): void {
    this.options.health({ status, watchOnline: this.active && status === 'watching', reason, lastScanAtMs: this.lastScanAtMs })
  }
  private attach(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.watchFailure = null
    this.rootFingerprint = null
    if (!existsSync(this.options.root)) { this.report('missing', { code: 'sync_source_missing', message: '已注册输入工作树不存在，等待补偿扫描确认恢复' }); return }
    const stat = statSync(this.options.root)
    this.rootFingerprint = `${stat.dev}:${stat.ino}`
    const paths = [...new Set([this.options.root, this.options.gitDir, this.options.commonDir, join(this.options.commonDir, 'refs')])]
    for (const root of paths) {
      const sourceTree = root === this.options.root, refsTree = root === join(this.options.commonDir, 'refs')
      if (refsTree && !existsSync(root)) continue
      const watcher = new TreeWatcherRegistry({
        root, source: `sync:${root}`, scope: 'full', recursive: sourceTree || refsTree,
        ignore: path => sourceTree ? path.split(/[\\/]/).some(part => ['.git', 'node_modules', '.worktrees', '.codex', '.claude'].includes(part)) : refsTree ? path === 'spex-sync' || path.startsWith('spex-sync/') : !['HEAD', 'index', 'packed-refs', 'config'].includes(path),
        watchFactory: this.options.watchFactory,
        onInput: () => this.schedule(),
        onFailure: error => { this.watchFailure = error; this.report('degraded', { code: 'sync_watch_failed', message: error.message }); this.schedule() },
      })
      this.watchers.push(watcher)
      if (!watcher.refresh()) break
    }
    if (!this.watchFailure) this.report('watching')
  }
  async start(): Promise<void> {
    if (this.active) return
    this.active = true
    this.report('starting')
    this.attach()
    this.compensation = setInterval(() => {
      if (this.flight) return
      const stat = existsSync(this.options.root) ? statSync(this.options.root) : null
      if (this.watchFailure || !stat || !this.watchers.length || this.rootFingerprint !== `${stat.dev}:${stat.ino}`) this.attach()
      void this.scanNow()
    }, this.options.compensationMs ?? 15000)
    this.compensation.unref?.()
    await this.scanNow()
  }
  private schedule(): void {
    if (!this.active) return
    this.dirty = true
    if (this.timer || this.flight) return
    this.timer = setTimeout(() => { this.timer = null; void this.scanNow() }, this.options.debounceMs ?? 80)
    this.timer.unref?.()
  }
  async scanNow(): Promise<void> {
    if (!this.active) return
    this.dirty = true
    if (this.flight) return this.flight
    const flight = (async () => {
      while (this.active && this.dirty) {
        this.dirty = false
        if (!existsSync(this.options.root)) { this.report('missing', { code: 'sync_source_missing', message: '已注册输入工作树不存在，等待补偿扫描确认恢复' }); return }
        try {
          await this.options.scan()
          this.lastScanAtMs = Date.now()
          if (!this.watchFailure) this.report('watching')
        } catch (error) {
          this.report('degraded', { code: (error as { code?: string }).code ?? 'sync_scan_failed', message: error instanceof Error ? error.message : String(error) })
        }
      }
    })().finally(() => { if (this.flight === flight) this.flight = null })
    this.flight = flight
    return flight
  }
  async stop(): Promise<void> {
    this.active = false
    this.dirty = false
    if (this.timer) clearTimeout(this.timer)
    if (this.compensation) clearInterval(this.compensation)
    this.timer = null; this.compensation = null
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    await this.flight
    this.report('offline', { code: 'sync_service_offline', message: '同步观察服务未运行' })
  }
}
