import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { tsxBin } from './tsx-bin.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()))
  return address.port
}

const spec = (title: string, desc: string, body: string[]) => ['---', `title: ${title}`, 'status: active', `desc: ${desc}`, '---', `# ${title}`, '', ...body, ''].join('\n')

// A node's past is read one version at a time, and only a hash from that node's OWN log is a version: the
// read resolves where spec.md sat at that commit (a node moved between versions still reads its old text),
// and any other string — another node's commit, an option-shaped `--output=…` — is a 404 that reaches no git.
test('/api/specs/:id/version and /diff answer only for the node\'s own versions, at the path it had then', { timeout: 60_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'spex-spec-version-'))
  const project = join(fixture, 'project')
  const planted = join(fixture, 'planted-by-diff')
  let backend: ChildProcess | null = null
  try {
    mkdirSync(join(project, '.spec/fixture/alpha'), { recursive: true })
    writeFileSync(join(project, '.spec/spexcode.json'), JSON.stringify({ harnesses: ['claude'], lint: { governedRoots: ['src'] } }) + '\n')
    writeFileSync(join(project, '.spec/fixture/spec.md'), spec('fixture', 'root', ['Root.']))
    writeFileSync(join(project, '.spec/fixture/alpha/spec.md'), spec('alpha', 'alpha as first written', ['Alpha began as a single promise.']))
    git(project, 'init', '-q', '-b', 'main')
    git(project, 'config', 'user.email', 'version@example.test')
    git(project, 'config', 'user.name', 'version')
    git(project, 'add', '.')
    git(project, 'commit', '-qm', 'alpha: first')
    const v1 = git(project, 'rev-parse', 'HEAD')
    mkdirSync(join(project, '.spec/fixture/beta'), { recursive: true })
    writeFileSync(join(project, '.spec/fixture/beta/spec.md'), spec('beta', 'a neighbour', ['Beta is not alpha.']))
    git(project, 'add', '.')
    git(project, 'commit', '-qm', 'beta: a neighbour')
    const betaOnly = git(project, 'rev-parse', 'HEAD')
    // v2 moves alpha under a new group node AND edits it, so its path at v1 is not its path now
    mkdirSync(join(project, '.spec/fixture/group'), { recursive: true })
    writeFileSync(join(project, '.spec/fixture/group/spec.md'), spec('group', 'a parent', ['Group.']))
    git(project, 'mv', '.spec/fixture/alpha', '.spec/fixture/group/alpha')
    writeFileSync(join(project, '.spec/fixture/group/alpha/spec.md'), spec('alpha', 'alpha as it reads now', ['Alpha began as a single promise.', '', 'Alpha moved under group.']))
    git(project, 'add', '.')
    git(project, 'commit', '-qm', 'alpha: move under group')
    const v2 = git(project, 'rev-parse', 'HEAD')

    const delivery = join(fixture, 'delivery')
    git(project, 'worktree', 'add', '-q', '-b', 'delivery', delivery)
    git(delivery, 'mv', '.spec/fixture/group/alpha', '.spec/fixture/alpha')
    writeFileSync(join(delivery, '.spec/fixture/alpha/spec.md'), spec('alpha', 'delivery alpha', ['Delivery-only accepted behavior.']))
    writeFileSync(join(delivery, '.spec/fixture/alpha/evidence.txt'), 'delivery evidence\n')
    writeFileSync(join(delivery, '.spec/fixture/alpha/diagram.json'), JSON.stringify({ diagram_type: 'delivery-invalid-type' }))
    mkdirSync(join(delivery, '.spec/fixture/new-node'))
    writeFileSync(join(delivery, '.spec/fixture/new-node/spec.md'), spec('new-node', 'delivery only', ['New implementation contract.']))
    mkdirSync(join(delivery, 'src'))
    writeFileSync(join(delivery, 'src/result.js'), 'export const result = "delivery"\n')
    git(delivery, 'add', '.')
    git(delivery, 'commit', '-qm', 'delivery: implement alpha')
    const delivered = git(delivery, 'rev-parse', 'HEAD')

    const port = await freePort()
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SPEXCODE_') || key.startsWith('SPEX_SESSION_')) delete env[key]
    Object.assign(env, { SPEXCODE_HOME: join(fixture, 'home'), PORT: String(port) })
    let log = ''
    backend = spawn(process.execPath, [tsxBin(packageRoot), join(packageRoot, 'src', 'index.ts')], {
      cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    backend.stdout?.on('data', (chunk) => { log += String(chunk) })
    backend.stderr?.on('data', (chunk) => { log += String(chunk) })
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 15_000
    while (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
      if (backend.exitCode !== null || Date.now() > deadline) throw new Error(`backend never became healthy: ${log}`)
      await new Promise((done) => setTimeout(done, 50))
    }

    const scoped = (path: string, root = delivery) => `${base}${path}${path.includes('?') ? '&' : '?'}targetTree=${encodeURIComponent(root)}`
    const body = await (await fetch(scoped('/api/specs/alpha/content'))).json()
    assert.match(body.body, /Delivery-only accepted behavior/)
    assert.equal(body.diagram.file, '.spec/fixture/alpha/diagram.json')
    assert.equal(body.diagram.type, 'delivery-invalid-type')
    assert.match((await (await fetch(`${base}/api/specs/alpha/content`)).json()).body, /moved under group/)
    assert.equal((await fetch(`${base}/api/specs/new-node/content`)).status, 404)
    assert.match((await (await fetch(scoped('/api/specs/new-node/content'))).json()).body, /New implementation contract/)
    for (const route of ['/api/specs', '/api/specs/lite']) {
      const nodes = await (await fetch(scoped(route))).json()
      assert.ok(nodes.some((node: { id: string }) => node.id === 'new-node'))
      assert.ok(!(await (await fetch(`${base}${route}`)).json()).some((node: { id: string }) => node.id === 'new-node'))
    }
    const selectedHistory = await (await fetch(scoped('/api/specs/alpha/history'))).json()
    assert.equal(selectedHistory[0].hash, delivered)
    assert.match((await (await fetch(scoped(`/api/specs/alpha/version/${delivered}`))).json()).body, /Delivery-only accepted behavior/)
    assert.match((await (await fetch(scoped(`/api/specs/alpha/diff/${delivered}`))).json()).patch, /Delivery-only accepted behavior/)
    assert.equal((await fetch(`${base}/api/specs/alpha/version/${delivered}`)).status, 404)
    assert.equal((await fetch(scoped('/api/specs/alpha/version/HEAD'))).status, 404)
    const files = await (await fetch(scoped('/api/specs/alpha/files'))).json()
    assert.ok(files.files.some((file: { name: string }) => file.name === 'evidence.txt'))
    assert.equal((await (await fetch(scoped('/api/specs/alpha/files/content?name=evidence.txt'))).json()).text, 'delivery evidence\n')
    assert.equal((await (await fetch(scoped('/api/source?path=src/result.js'))).json()).text, 'export const result = "delivery"\n')
    assert.equal((await fetch(`${base}/api/source?path=src/result.js`)).status, 404)
    const listing = await (await fetch(scoped('/api/files?dir=src'))).json()
    assert.ok(JSON.stringify(listing).includes('result.js'), JSON.stringify(listing))
    for (const path of ['/api/specs', '/api/specs/lite', '/api/specs/alpha/content', '/api/specs/alpha/history', `/api/specs/alpha/version/${delivered}`, `/api/specs/alpha/diff/${delivered}`, '/api/specs/alpha/files', '/api/specs/alpha/files/content?name=evidence.txt', '/api/source?path=src/result.js', '/api/files']) {
      assert.equal((await fetch(scoped(path, fixture))).status, 400, `unregistered target refused: ${path}`)
    }
    const beforeHead = git(project, 'rev-parse', 'HEAD')
    assert.equal((await fetch(scoped('/api/specs/alpha/body'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 409)
    assert.equal(git(project, 'rev-parse', 'HEAD'), beforeHead)
    assert.equal(git(project, 'status', '--porcelain'), '')
    assert.equal(git(delivery, 'status', '--porcelain'), '')

    const history = await (await fetch(`${base}/api/specs/alpha/history`)).json()
    assert.deepEqual(history.map((row: { hash: string }) => row.hash), [v2, v1], 'alpha has exactly its two versions, newest first')

    const old = await fetch(`${base}/api/specs/alpha/version/${v1}`)
    assert.equal(old.status, 200)
    const oldBody = await old.json()
    assert.equal(oldBody.path, '.spec/fixture/alpha/spec.md', 'v1 is read where spec.md sat at v1')
    assert.equal(oldBody.desc, 'alpha as first written')
    assert.equal(oldBody.version, 1)
    assert.equal(oldBody.versions, 2)
    assert.equal(oldBody.reason, 'alpha: first')
    assert.match(oldBody.body, /Alpha began as a single promise\./)
    assert.doesNotMatch(oldBody.body, /moved under group/)

    const change = await fetch(`${base}/api/specs/alpha/diff/${v2}`)
    assert.equal(change.status, 200)
    assert.match((await change.json()).patch, /^\+Alpha moved under group\.$/m)

    const optionShaped = await fetch(`${base}/api/specs/alpha/diff/${encodeURIComponent(`--output=${planted}`)}`)
    assert.equal(optionShaped.status, 404, 'an option-shaped hash is not a version')
    assert.equal(existsSync(planted), false, 'and it never reached git')
    for (const route of ['diff', 'version']) {
      assert.equal((await fetch(`${base}/api/specs/alpha/${route}/${betaOnly}`)).status, 404, `another node's commit is not alpha's version (${route})`)
      assert.equal((await fetch(`${base}/api/specs/alpha/${route}/HEAD`)).status, 404, `a ref expression is not a version (${route})`)
      assert.equal((await fetch(`${base}/api/specs/nope/${route}/${v1}`)).status, 404, `an unknown node has no versions (${route})`)
    }

    // Same registered-tree boundary serves CLI and Dashboard controls; disabled scopes cannot mutate.
    const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })
    const settings = await (await fetch(`${base}/api/sync/settings`)).json()
    assert.equal(settings.enabled, false)
    assert.equal((await fetch(scoped('/api/sync/settings', fixture))).status, 400)
    assert.equal((await post(`/api/sync/settings?targetTree=${encodeURIComponent(project)}`, { targetTree: delivery })).status, 400)
    assert.equal((await fetch(`${base}/api/sync/status?limit=0`)).status, 400)
    assert.equal((await fetch(`${base}/api/sync/operations/unknown`)).status, 404)
    assert.equal((await post('/api/sync/run', {})).status, 400)
    assert.equal((await post('/api/sync/settings', {})).status, 409)
    const patch = { startLine: 1, endLine: 1, original: '# alpha', replacement: '# alpha' }
    assert.equal((await post('/api/specs/alpha/body', patch)).status, 200, 'ordinary no-op remains available before activation')
    const configPath = join(project, '.spec/spexcode.json'), config = JSON.parse(readFileSync(configPath, 'utf8'))
    const sync = {
      version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['test'], readPaths: ['package.json'], facts: [], mandatoryTests: [],
      budget: { maxAttempts: 2, maxCalls: 6, maxRepairs: 1, timeoutMs: 60000 },
      verifications: [{ definition: { id: 'VERIFY-HTTP-01', command: ['node', '--test', 'test/one.test.mjs'], cwd: '.', timeoutMs: 10000 }, environment: { version: 'docker-node-v1', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 268435456, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 1048576 } }],
    }
    writeFileSync(configPath, JSON.stringify({ ...config, sync }))
    const beforeEnable = readFileSync(join(project, '.git/index'))
    assert.equal((await post('/api/sync/settings', {})).status, 200)
    const enabled = await (await fetch(`${base}/api/sync/settings`)).json(); assert.equal(enabled.enabled, true)
    assert.equal((await post('/api/specs/alpha/body', patch)).status, 400, 'enabled save requires stable request identity')
    const noOp = await post('/api/specs/alpha/body', patch, { 'idempotency-key': 'http-noop' })
    assert.equal(noOp.status, 200); assert.deepEqual(await noOp.json(), { ok: true, changed: false, commit: null, syncOperation: null })
    assert.equal((await (await fetch(`${base}/api/sync/status`)).json()).operations.length, 0)
    assert.equal(git(project, 'rev-parse', 'HEAD'), beforeHead)
    assert.deepEqual(readFileSync(join(project, '.git/index')), beforeEnable)
    writeFileSync(configPath, '{broken')
    const refused = await post('/api/specs/alpha/body', { ...patch, replacement: '# changed' }, { 'idempotency-key': 'invalidated' })
    assert.equal(refused.status, 409, 'invalidated synchronization must never fall back to a standalone prose commit')
    assert.equal(git(project, 'rev-parse', 'HEAD'), beforeHead)
    assert.deepEqual(readFileSync(join(project, '.git/index')), beforeEnable)
  } finally {
    if (backend?.pid) {
      try { process.kill(-backend.pid, 'SIGTERM') } catch { /* group already gone */ }
      await new Promise((done) => setTimeout(done, 500))
      try { process.kill(-backend.pid, 'SIGKILL') } catch { /* group already gone */ }
    }
    rmSync(fixture, { recursive: true, force: true })
  }
})
