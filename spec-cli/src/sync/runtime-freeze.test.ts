import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { freezeDeliveryRuntime, RuntimeFreezeError } from './runtime-freeze.js'
import { inspectTrustedRuntime } from './trusted-hooks.js'

function temporary(t: test.TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-runtime-test-')))
  t.after(() => { const unlock = (path: string): void => { if (lstatSync(path).isDirectory()) { chmodSync(path, 0o755); for (const child of readdirSync(path)) unlock(join(path, child)) } }; unlock(root); rmSync(root, { recursive: true, force: true }) })
  return root
}
const put = (root: string, path: string, bytes: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes) }
const json = (root: string, value: object): void => put(root, 'package.json', JSON.stringify(value))
function cliFixture(root: string): string {
  const cli = join(root, 'trusted-cli')
  json(cli, { name: '@spexcode/spec-cli', version: 'test-1', type: 'module', files: ['dist', 'templates', 'bin'], exports: { '.': './dist/cli.js', './package.json': './package.json' }, bin: { spex: 'bin/spex.mjs' }, scripts: { prepublishOnly: 'exit 99' } })
  put(cli, 'dist/cli.js', 'console.log("compiled fixture")\n')
  put(cli, 'templates/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
  put(cli, 'bin/spex.mjs', 'throw new Error("source launcher must not execute")\n')
  put(cli, 'src/not-published.ts', 'source must not be copied')
  return cli
}
const rejection = (action: () => unknown, code = 'unsupported'): void => { assert.throws(action, (error: unknown) => error instanceof RuntimeFreezeError && error.code === code) }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('当前已build真CLI完整闭包独立运行 trunk/lint/readonly，runtime manifest不变', t => {
  const root = temporary(t), runtime = freezeDeliveryRuntime(join(root, 'runtime')), project = join(root, 'project'), home = join(root, 'isolated-home')
  mkdirSync(home); mkdirSync(project)
  put(project, 'file.js', 'export const value = 1\n')
  put(project, '.spec/fixture/node/spec.md', '---\ntitle: Runtime fixture\nstatus: active\ncode:\n  - file.js\n---\n# Runtime fixture\n\n## raw source\n\nRead-only runtime proof.\n\n## expanded spec\n\nA fixed trusted tool can inspect this file.\n')
  const env = { PATH: '/usr/bin:/bin', HOME: home, SPEXCODE_HOME: home, CODEX_HOME: join(home, 'codex'), SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]): string => execFileSync('git', ['-C', project, ...args], { env, encoding: 'utf8' }).trim()
  git('init', '-b', 'main'); git('config', 'user.email', 'runtime@example.invalid'); git('config', 'user.name', 'runtime fixture'); git('add', '.'); git('commit', '-m', 'fixture')
  const before = { head: git('rev-parse', 'HEAD'), index: readFileSync(join(project, '.git/index')), spec: readFileSync(join(project, '.spec/fixture/node/spec.md')) }
  const run = (...args: string[]): { stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [runtime.toolEntry, ...args], { cwd: project, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return { stdout: result.stdout, stderr: result.stderr }
  }
  assert.equal(run('internal', 'trunk').stdout.trim(), 'main')
  assert.match(run('spec', 'lint').stderr, /0 error/)
  assert.match(run('spec', 'owner', 'file.js').stdout, /node/)
  assert.equal(runtime.sourcePackage.name, '@spexcode/spec-cli')
  assert.ok(runtime.packages.length > 10)
  assert.equal(runtime.digest, digest(runtime.manifest))
  assert.deepEqual(inspectTrustedRuntime(runtime.trustedRuntimeRoot), runtime.manifest)
  for (const pkg of runtime.packages.filter(pkg => !pkg.source.canonicalRoot.split('/').includes('node_modules'))) assert.ok(runtime.manifest.every(entry => !entry.path.startsWith(`packages/${pkg.id}/src/`)))
  for (const entry of runtime.manifest.filter(entry => entry.kind === 'symlink')) {
    assert.ok(entry.target && !entry.target.startsWith('/'))
    assert.ok(realpathSync(join(runtime.trustedRuntimeRoot, entry.path)).startsWith(`${runtime.trustedRuntimeRoot}/`))
  }
  assert.deepEqual({ head: git('rev-parse', 'HEAD'), index: readFileSync(join(project, '.git/index')), spec: readFileSync(join(project, '.spec/fixture/node/spec.md')) }, before)
})

test('嵌套同名不同版本和循环依赖保留，源包后来变化不影响固定工具', t => {
  const root = temporary(t), cli = cliFixture(root), metadata = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'))
  json(cli, { ...metadata, dependencies: { left: '1', right: '1' } })
  for (const [name, version] of [['left', '1'], ['right', '2']]) {
    const pkg = join(cli, 'node_modules', name), sibling = name === 'left' ? 'right' : 'left'
    json(pkg, { name, version: '1', main: 'index.js', dependencies: { same: version, [sibling]: '1' } })
    put(pkg, 'index.js', 'module.exports = require("same")\n')
    const same = join(pkg, 'node_modules/same')
    json(same, { name: 'same', version, main: 'index.js' }); put(same, 'index.js', `module.exports = ${JSON.stringify(version)}\n`)
    symlinkSync(join(cli, 'node_modules', sibling), join(pkg, 'node_modules', sibling), 'dir')
  }
  put(cli, 'dist/cli.js', 'import {createRequire} from "node:module"; const r=createRequire(import.meta.url); console.log(JSON.stringify([r("left"),r("right")]));\n')
  const runtime = freezeDeliveryRuntime(join(root, 'runtime'), cli)
  assert.equal(execFileSync(process.execPath, [runtime.toolEntry], { encoding: 'utf8' }).trim(), '["1","2"]')
  assert.deepEqual(runtime.packages.filter(pkg => pkg.source.name === 'same').map(pkg => pkg.source.version).sort(), ['1', '2'])
  put(cli, 'node_modules/left/node_modules/same/index.js', 'module.exports = "changed"\n')
  put(cli, 'dist/cli.js', 'throw new Error("source changed")\n')
  assert.equal(execFileSync(process.execPath, [runtime.toolEntry], { encoding: 'utf8' }).trim(), '["1","2"]')
  assert.deepEqual(inspectTrustedRuntime(runtime.trustedRuntimeRoot), runtime.manifest)
  rejection(() => freezeDeliveryRuntime(runtime.trustedRuntimeRoot, cli), 'conflict')
})

test('发布范围不复制源码/home/凭据，payload越界与断链symlink明确排除、不跟随读取', t => {
  const root = temporary(t), cli = cliFixture(root), outside = join(root, 'outside')
  put(root, 'outside', 'outside fixture bytes')
  for (const file of ['dist/.npmrc', 'dist/.env', 'dist/.codex/auth.json']) put(cli, file, 'fixture metadata must remain outside runtime')
  put(cli, 'dist/auth.js', 'export const authentication = true\n')
  symlinkSync(outside, join(cli, 'dist/outside.js')); symlinkSync(join(root, 'missing'), join(cli, 'dist/dangling.js'))
  const runtime = freezeDeliveryRuntime(join(root, 'runtime'), cli)
  assert.ok(runtime.excluded.some(entry => entry.path === 'dist/outside.js' && entry.reason === 'source_symlink'))
  assert.ok(runtime.excluded.some(entry => entry.path === 'dist/.npmrc' && entry.reason === 'private_metadata'))
  for (const path of ['dist/outside.js', 'dist/dangling.js', 'dist/.npmrc', 'dist/.env', 'dist/.codex', 'src']) assert.equal(existsSync(join(dirname(dirname(runtime.toolEntry)), path)), false)
  assert.equal(existsSync(join(dirname(runtime.toolEntry), 'auth.js')), true)
  assert.equal(readFileSync(outside, 'utf8'), 'outside fixture bytes')
  const metadata = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'))
  json(cli, { ...metadata, exports: { ...metadata.exports, './outside': './dist/outside.js' } })
  rejection(() => freezeDeliveryRuntime(join(root, 'invalid-export'), cli))
  assert.equal(existsSync(join(root, 'invalid-export')), false)
})

test('缺编译入口/模板/依赖及未知workspace发布/exports拒绝，不留已发布目录', t => {
  const root = temporary(t), cli = cliFixture(root), metadata = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'))
  for (const broken of [{ ...metadata, files: undefined }, { ...metadata, files: ['**/*.js'] }, { ...metadata, dependencies: { 'missing-runtime-package': '1' } }, { ...metadata, dependencies: { '..': '1' } }, { ...metadata, bin: { spex: 'bin/missing.mjs' } }, { ...metadata, exports: 'outside.js' }]) {
    json(cli, broken)
    rejection(() => freezeDeliveryRuntime(join(root, 'runtime'), cli))
    assert.equal(existsSync(join(root, 'runtime')), false)
    assert.ok(readdirSync(root).every(name => !name.startsWith('.spex-runtime-')))
  }
  json(cli, metadata); rmSync(join(cli, 'dist/cli.js'))
  rejection(() => freezeDeliveryRuntime(join(root, 'runtime'), cli))
  put(cli, 'dist/cli.js', 'console.log("compiled fixture")\n'); rmSync(join(cli, 'templates'), { recursive: true })
  rejection(() => freezeDeliveryRuntime(join(root, 'runtime'), cli))
})
