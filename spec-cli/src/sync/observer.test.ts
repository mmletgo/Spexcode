import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SyncInputObserver } from './observer.js'
import type { SyncObserverHealth } from './observer.js'

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) { assert.ok(Date.now() < deadline, '等待真实观察超时'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'sync-observer-')), root = join(temp, 'source'), git = join(root, '.git')
  mkdirSync(join(git, 'refs', 'heads'), { recursive: true })
  writeFileSync(join(root, 'input.txt'), 'one')
  return { temp, root, git }
}
test('AC-OBSERVER-01 仅提交引用事件触发扫描，保存与暂存不触发，重启发现停机提交', async () => {
  const f = fixture(), inputs: string[] = [], health: SyncObserverHealth[] = []
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.git, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, health: value => health.push(value), debounceMs: 5, compensationMs: 10000 })
  try {
    await observer.start(); assert.equal(inputs.at(-1), 'one')
    const initialCount = inputs.length
    writeFileSync(join(f.root, 'replacement'), 'two'); renameSync(join(f.root, 'replacement'), join(f.root, 'input.txt'))
    writeFileSync(join(f.git, 'index'), 'staged bytes')
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(inputs.length, initialCount)
    writeFileSync(join(f.git, 'refs/heads/main'), 'online-commit')
    await until(() => inputs.includes('two'))
    await observer.stop(); assert.equal(health.at(-1)?.watchOnline, false)
    const count = inputs.length
    writeFileSync(join(f.root, 'input.txt'), 'offline')
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(inputs.length, count)
    await observer.start(); assert.equal(inputs.at(-1), 'offline')
    writeFileSync(join(f.git, 'refs/heads/main'), 'external-commit')
    await until(() => inputs.length > count + 1)
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})
test('AC-OBSERVER-02 扫描中多次提交引用事件不会丢最后输入', async () => {
  const f = fixture(), inputs: string[] = []
  let release: (() => void) | null = null, scanning = false
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.git, debounceMs: 5, compensationMs: 10000, health: () => {}, scan: async () => {
    inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8'))
    if (scanning) await new Promise<void>(resolve => { release = resolve })
  } })
  try {
    await observer.start(); scanning = true
    writeFileSync(join(f.root, 'input.txt'), 'two'); writeFileSync(join(f.git, 'refs/heads/main'), 'two'); await until(() => release !== null)
    writeFileSync(join(f.root, 'input.txt'), 'three'); writeFileSync(join(f.git, 'refs/heads/main'), 'three'); await new Promise(resolve => setTimeout(resolve, 30))
    scanning = false; release!(); await until(() => inputs.includes('three'))
  } finally { (release as (() => void) | null)?.(); await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})
test('AC-OBSERVER-03 watcher平台故障和来源删除不冒充online，周期恢复与重建再次扫描', async () => {
  const f = fixture(), health: SyncObserverHealth[] = [], inputs: string[] = []
  let fail = true
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.git, debounceMs: 5, compensationMs: 30, health: value => health.push(value), scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, watchFactory: () => {
    if (fail) throw new Error('injected watch failure')
    const handle = new EventEmitter() as FSWatcher; handle.close = () => {}; return handle
  } })
  try {
    await observer.start(); assert.equal(health.at(-1)?.status, 'degraded'); assert.equal(health.at(-1)?.watchOnline, false)
    fail = false; await until(() => health.at(-1)?.status === 'watching')
    rmSync(f.root, { recursive: true }); await until(() => health.at(-1)?.status === 'missing')
    mkdirSync(join(f.git, 'refs'), { recursive: true }); writeFileSync(join(f.root, 'input.txt'), 'recreated')
    await until(() => inputs.includes('recreated'))
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})
