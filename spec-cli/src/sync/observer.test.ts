import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const git = (root: string, ...args: string[]): string => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
}).trim()
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'sync-observer-')), root = join(temp, 'source')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'input.txt'), 'one')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'observer fixture')
  git(root, 'config', 'user.email', 'observer@example.invalid')
  git(root, 'add', 'input.txt')
  git(root, 'commit', '-m', 'seed observer fixture')
  const gitDir = git(root, 'rev-parse', '--absolute-git-dir')
  const commonDir = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return { temp, root, git: gitDir, commonDir }
}
test('AC-OBSERVER-01 仅提交引用事件触发扫描，保存与暂存不触发，重启发现停机提交', async () => {
  const f = fixture(), inputs: string[] = [], health: SyncObserverHealth[] = []
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.git, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, health: value => health.push(value), debounceMs: 5, compensationMs: 10000 })
  try {
    await observer.start(); assert.equal(inputs.at(-1), 'one')
    const initialCount = inputs.length
    writeFileSync(join(f.root, 'replacement'), 'two'); renameSync(join(f.root, 'replacement'), join(f.root, 'input.txt'))
    git(f.root, 'add', 'input.txt')
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(inputs.length, initialCount)
    git(f.root, 'commit', '-m', 'online source change')
    await until(() => inputs.includes('two'))
    await observer.stop(); assert.equal(health.at(-1)?.watchOnline, false)
    const count = inputs.length
    writeFileSync(join(f.root, 'input.txt'), 'offline')
    await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(inputs.length, count)
    await observer.start(); assert.equal(inputs.at(-1), 'offline')
    git(f.root, 'add', 'input.txt'); git(f.root, 'commit', '-m', 'external source change')
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
    writeFileSync(join(f.root, 'input.txt'), 'two'); git(f.root, 'add', 'input.txt'); git(f.root, 'commit', '-m', 'first during scan'); await until(() => release !== null)
    writeFileSync(join(f.root, 'input.txt'), 'three'); git(f.root, 'add', 'input.txt'); git(f.root, 'commit', '-m', 'last during scan'); await new Promise(resolve => setTimeout(resolve, 30))
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
    mkdirSync(f.root, { recursive: true }); writeFileSync(join(f.root, 'input.txt'), 'recreated')
    git(f.root, 'init', '-b', 'main'); git(f.root, 'config', 'user.name', 'observer fixture'); git(f.root, 'config', 'user.email', 'observer@example.invalid')
    git(f.root, 'add', 'input.txt'); git(f.root, 'commit', '-m', 'recreated observer fixture')
    await until(() => inputs.includes('recreated'))
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})

test('AC-OBSERVER-04 unrelated current-Git refs do not start snapshots', async t => {
  const f = fixture(), inputs: string[] = []
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.commonDir, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, health: () => {}, debounceMs: 5, compensationMs: 10000 })
  try {
    await observer.start()
    const initialCount = inputs.length
    const currentHead = git(f.root, 'rev-parse', 'HEAD')
    for (const name of ['unrelated-a', 'unrelated-b', 'unrelated-c']) {
      git(f.root, 'update-ref', `refs/heads/${name}`, currentHead)
      await new Promise(resolve => setTimeout(resolve, 35))
    }
    t.diagnostic(JSON.stringify({ initialCount, scansAfterUnrelatedRefs: inputs.length, unrelatedRefs: 3 }))
    assert.equal(inputs.length, initialCount, '更新非当前HEAD分支不应启动输入快照')
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})

test('AC-OBSERVER-05 current ref, HEAD switch, symbolic alias retarget and packed-refs still scan', async () => {
  const f = fixture(), inputs: string[] = []
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.commonDir, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, health: () => {}, debounceMs: 5, compensationMs: 10000 })
  const settledScan = async (before: number): Promise<void> => {
    await until(() => inputs.length > before)
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  try {
    await observer.start()
    const mainHead = git(f.root, 'rev-parse', 'HEAD')
    git(f.root, 'update-ref', 'refs/heads/alternate', mainHead)
    await new Promise(resolve => setTimeout(resolve, 50))
    const initialCount = inputs.length
    assert.equal(initialCount, 1, 'an unrelated branch creation remains filtered')

    writeFileSync(join(f.root, 'input.txt'), 'main update')
    git(f.root, 'add', 'input.txt'); git(f.root, 'commit', '-m', 'current branch update')
    await settledScan(initialCount)

    const beforeHeadSwitch = inputs.length
    git(f.root, 'switch', 'alternate')
    await settledScan(beforeHeadSwitch)

    git(f.root, 'symbolic-ref', 'refs/heads/current-alias', 'refs/heads/alternate')
    await new Promise(resolve => setTimeout(resolve, 50))
    const beforeAliasHead = inputs.length
    git(f.root, 'symbolic-ref', 'HEAD', 'refs/heads/current-alias')
    await settledScan(beforeAliasHead)

    const beforeAliasRetarget = inputs.length
    git(f.root, 'symbolic-ref', 'refs/heads/current-alias', 'refs/heads/main')
    await settledScan(beforeAliasRetarget)

    const beforePack = inputs.length
    git(f.root, 'pack-refs', '--all', '--prune')
    await settledScan(beforePack)

    const beforeDetach = inputs.length
    git(f.root, 'checkout', '--detach', 'HEAD')
    await settledScan(beforeDetach)

    const beforeDetachedNoise = inputs.length
    git(f.root, 'update-ref', 'refs/heads/detached-noise', git(f.root, 'rev-parse', 'HEAD'))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(inputs.length, beforeDetachedNoise, 'detached HEAD still filters unrelated refs')
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})

test('AC-OBSERVER-06 unknown refs and current-ref ancestors scan; lock events do not', async () => {
  const f = fixture(), inputs: string[] = [], callbacks = new Map<string, (event: 'rename' | 'change', filename: string | Buffer | null) => void>()
  const health: SyncObserverHealth[] = []
  const observer = new SyncInputObserver({
    root: f.root, gitDir: f.git, commonDir: f.commonDir, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) },
    health: value => health.push(value), debounceMs: 5, compensationMs: 10000,
    watchFactory: (path, _options, callback) => {
      callbacks.set(path, callback)
      const handle = new EventEmitter() as FSWatcher
      handle.close = () => {}
      return handle
    },
  })
  const settles = async (before: number): Promise<void> => { await until(() => inputs.length > before); await new Promise(resolve => setTimeout(resolve, 20)) }
  try {
    await observer.start()
    const refsEvent = callbacks.get(join(f.commonDir, 'refs'))
    assert.ok(refsEvent, 'the real refs tree remains physically watched')

    let before = inputs.length
    refsEvent('rename', 'heads')
    await settles(before)

    before = inputs.length
    refsEvent('rename', 'heads/not a valid ref')
    await settles(before)

    before = inputs.length
    refsEvent('rename', 'tags')
    await settles(before)

    before = inputs.length
    refsEvent('rename', 'heads/main.lock')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(inputs.length, before, 'temporary ref lock event does not scan')
    assert.equal(health.at(-1)?.status, 'watching', 'temporary ref lock event does not degrade the watcher')

    refsEvent('rename', 'heads/main')
    await settles(before)
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})

test('AC-OBSERVER-07 startup, explicit scanNow and compensation scans remain unconditional', async () => {
  const f = fixture(), inputs: string[] = []
  const observer = new SyncInputObserver({ root: f.root, gitDir: f.git, commonDir: f.commonDir, scan: async () => { inputs.push(readFileSync(join(f.root, 'input.txt'), 'utf8')) }, health: () => {}, debounceMs: 5, compensationMs: 80 })
  try {
    await observer.start()
    assert.equal(inputs.length, 1, 'startup always captures the current source')
    const beforeManual = inputs.length
    await observer.scanNow()
    assert.ok(inputs.length > beforeManual, 'explicit scanNow always captures the current source')
    const beforeCompensation = inputs.length
    await until(() => inputs.length > beforeCompensation)
  } finally { await observer.stop(); rmSync(f.temp, { recursive: true, force: true }) }
})
