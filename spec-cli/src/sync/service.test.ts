import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { SyncApplication } from './application.js'
type Status = Awaited<ReturnType<SyncApplication['status']>>

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12000
  while (!await predicate()) { assert.ok(Date.now() < deadline, '真实后台服务未达到预期状态'); await new Promise(resolve => setTimeout(resolve, 40)) }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await exited
}
function cli(root: string, api: string, env: NodeJS.ProcessEnv, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(workspace, 'spec-cli/src/cli.ts'), 'sync', ...args, '--api', api], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString() })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
test('AC-SYNC-SERVICE-01 真实HTTP/CLI共享物理暂停，无Dashboard保存与停机重启持续补偿', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'sync-service-')), source = join(temp, 'source'), home = join(temp, 'home')
  mkdirSync(join(source, '.spec/demo'), { recursive: true }); mkdirSync(join(source, 'src')); mkdirSync(join(source, 'tests')); mkdirSync(home)
  const settings = { version: 'sync-settings-v1', nodeIds: ['demo'], sourcePaths: ['src'], testPaths: ['tests'], readPaths: [], facts: [], mandatoryTests: [], budget: { maxAttempts: 1, maxCalls: 2, maxRepairs: 0, timeoutMs: 10000 }, verifications: [{ definition: { id: 'VERIFY-DEMO-01', command: ['node', '--test', 'tests/demo.test.mjs'], cwd: '.', timeoutMs: 1000 }, environment: { version: 'v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 100000000, cpus: 1, pidsLimit: 64, scratchBytes: 1000000, logBytes: 100000 } }] }
  writeFileSync(join(source, '.spec/spexcode.json'), JSON.stringify({ sync: settings }))
  writeFileSync(join(source, '.spec/demo/spec.md'), '---\ntitle: Demo\nstatus: pending\ncode:\n  - src/demo.mjs\n---\n# Demo\n\n## raw source\n\n返回文本。\n\n## expanded spec\n\n待细化。\n')
  writeFileSync(join(source, 'src/demo.mjs'), 'export const demo = text => text\n'); writeFileSync(join(source, 'tests/demo.test.mjs'), "import test from 'node:test'; test('DEMO', () => {})\n")
  const git = (...args: string[]): string => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'fixture')
  const root = realpathSync(source), port = await freePort(), api = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite') }
  delete env.SPEXCODE_API_URL
  let serverLog = '', child: ChildProcess | null = null
  const start = (): ChildProcess => {
    const next = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(workspace, 'spec-cli/src/index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    next.stdout?.on('data', (bytes: Buffer) => { serverLog += bytes.toString() }); next.stderr?.on('data', (bytes: Buffer) => { serverLog += bytes.toString() })
    return next
  }
  const request = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${api}/api/sync${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>
  }
  try {
    child = start()
    await until(async () => fetch(`${api}/health`).then(response => response.ok).catch(() => false))
    await request('/automatic/pause', { targetTree: root })
    const enabled = await cli(root, api, env, ['enable']); assert.equal(enabled.code, 0, enabled.stderr)
    const initial = await request<Status>(`/status?targetTree=${encodeURIComponent(root)}`)
    assert.ok(initial.observation.latestSnapshot)
    const initialInputId = initial.observation.latestSnapshot.id
    assert.equal(initial.observation.control.control, 'pause'); assert.equal(initial.observation.health.watchOnline, true); assert.equal(initial.operations.length, 0)
    writeFileSync(join(root, 'src/demo.mjs'), 'export const demo = text => `saved:${text}`\n')
    await until(async () => { const snapshot = (await request<Status>(`/status?targetTree=${encodeURIComponent(root)}`)).observation.latestSnapshot; return !!snapshot && snapshot.id !== initialInputId })
    const paused = await cli(root, api, env, ['status']); assert.equal(paused.code, 0, paused.stderr)
    assert.equal(JSON.parse(paused.stdout).operations.length, 0)
    const observed = JSON.parse(paused.stdout).observation.latestSnapshot.id
    await stop(child); child = null
    writeFileSync(join(root, 'src/demo.mjs'), 'export const demo = text => `offline:${text}`\n'); git('add', 'src/demo.mjs'); git('commit', '-qm', 'external offline commit')
    const offline = await cli(root, api, env, ['status']); assert.equal(offline.code, 1); assert.equal(offline.stdout, '')
    child = start()
    await until(async () => fetch(`${api}/health`).then(response => response.ok).catch(() => false))
    await until(async () => { const current = await request<Status>(`/status?targetTree=${encodeURIComponent(root)}`); return current.observation.health.watchOnline && !!current.observation.latestSnapshot && current.observation.latestSnapshot.id !== observed })
    const restarted = await request<Status>(`/status?targetTree=${encodeURIComponent(root)}`)
    assert.ok(restarted.observation.latestSnapshot)
    assert.equal(restarted.observation.latestSnapshot.headCommit, git('rev-parse', 'HEAD')); assert.equal(restarted.observation.control.control, 'pause'); assert.equal(restarted.operations.length, 0)
    const verify = await cli(root, api, env, ['verify', 'demo', '--request-id', 'verify-1']); assert.equal(verify.code, 0, verify.stderr)
    const queued = JSON.parse(verify.stdout).operation
    assert.equal(queued.phase, 'queued'); assert.equal(queued.callsUsed, 0)
    const refused = await cli(root, api, env, ['recover', queued.id]); assert.equal(refused.code, 0, refused.stderr)
    assert.equal(JSON.parse(refused.stdout).operation.callsUsed, 0)
    for (const body of [{ targetTree: root, requestId: 'revert-1', operationId: 'different-operation' }, { targetTree: root, requestId: ' ' }]) {
      const response = await fetch(`${api}/api/sync/operations/${queued.id}/revert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, 'sync_request_invalid')
    }
    const unlanded = await cli(root, api, env, ['revert', queued.id, '--request-id', 'revert-unlanded'])
    assert.equal(unlanded.code, 1); assert.equal(unlanded.stdout, ''); assert.match(unlanded.stderr, /sync_revert_not_landed/)
    const stopped = await cli(root, api, env, ['stop-writer']); assert.equal(stopped.code, 0, stopped.stderr)
    const stopResult = JSON.parse(stopped.stdout) as { stopped: boolean; control: { control: string }; operations: unknown[] }
    assert.equal(stopResult.stopped, true); assert.equal(stopResult.control.control, 'pause'); assert.ok(Array.isArray(stopResult.operations))
    const retained = await request<Status>(`/status?targetTree=${encodeURIComponent(root)}`)
    assert.equal(retained.operations.length, 1); assert.equal(retained.operations[0].operation.id, queued.id)
    assert.equal(retained.operations[0].operation.callsUsed, 0); assert.equal(retained.observation.control.control, 'pause')
  } catch (error) { assert.fail(`${error instanceof Error ? error.stack : String(error)}\n真实产品日志：\n${serverLog}`) }
  finally {
    if (child) await stop(child)
    const unlock = (directory: string): void => { chmodSync(directory, 0o700); for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) unlock(join(directory, entry.name)) }
    unlock(temp); rmSync(temp, { recursive: true, force: true })
  }
})
