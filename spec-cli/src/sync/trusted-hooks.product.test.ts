import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeRoot } from '@spexcode/spec-core'
import { freezeDeliveryRuntime } from './runtime-freeze.js'
import { inspectTrustedHooksBinding, makeTrustedHookEnv, prepareTrustedHooksBinding, type TrustedHooksBinding } from './trusted-hooks.js'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
let runtime: ReturnType<typeof freezeDeliveryRuntime>, runtimeDirectory: string
before(() => {
  runtimeDirectory = mkdtempSync(join(tmpdir(), 'spex-real-hooks-runtime-'))
  runtime = freezeDeliveryRuntime(join(runtimeDirectory, 'fixed'), packageRoot)
})
after(() => {
  const writable = (path: string): void => {
    if (!lstatSync(path).isDirectory()) return
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) writable(join(path, name))
  }
  writable(runtimeDirectory); rmSync(runtimeDirectory, { recursive: true, force: true })
})
function fixture(t: test.TestContext, differentStore = false, drifted = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'spex-real-hooks-'))), root = join(directory, 'source'), footprint = join(directory, 'footprint'), marker = join(directory, 'untrusted-executed')
  mkdirSync(root); mkdirSync(footprint, { mode: 0o700 })
  if (differentStore) { mkdirSync(join(directory, 'planted-home')); symlinkSync(join(directory, 'planted-home'), join(directory, 'planted-home-alias')) }
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { ...process.env, SPEXCODE_HOME: differentStore ? join(directory, 'planted-home-alias') : process.env.SPEXCODE_HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const cli = (...args: string[]): string => execFileSync(process.execPath, [runtime.toolEntry, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  const author = '# 作者原文\n必须保持冻结字节。\n'
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'AGENTS.md'), author); git('add', 'AGENTS.md'); git('commit', '-m', 'author seed'); git('switch', '-c', 'node/source')
  cli('init', '.', '--harness', 'codex')
  const project = readdirSync(join(root, '.spec')).find(name => existsSync(join(root, '.spec', name, '.plugins')))!
  const plugin = join(root, '.spec', project, '.plugins', 'custom-script'); mkdirSync(plugin)
  writeFileSync(join(plugin, 'spec.md'), '---\ntitle: 静态插件\nstatus: active\nsurface: hook\nevents: [PreToolUse]\norder: 99\nblock: false\n---\n仅静态元数据，不执行脚本。\n')
  writeFileSync(join(plugin, 'custom.sh'), `#!/bin/sh\nprintf bad > '${marker}'\n`); chmodSync(join(plugin, 'custom.sh'), 0o755)
  git('add', '.spec'); git('commit', '-m', 'adopt with static plugin')
  const spec = `.spec/${project}/calculation/spec.md`
  if (drifted) {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, '.spec', project, 'calculation'))
    writeFileSync(join(root, 'src/calculation.py'), 'def result():\n    return 1\n')
    writeFileSync(join(root, spec), '---\ntitle: calculation\ncode:\n  - src/calculation.py#result\n---\n# Calculation\nReturns 1.\n')
    git('add', 'src', spec); git('commit', '-m', 'establish calculation contract')
    writeFileSync(join(root, 'src/calculation.py'), 'def result():\n    return 2\n')
    git('add', 'src/calculation.py')
    const external = git('commit-tree', git('write-tree'), '-p', 'HEAD', '-m', 'external code author')
    git('update-ref', 'refs/remotes/external/calculation', external)
    git('merge', '--ff-only', external)
  }
  for (const name of readdirSync(runtime.canonicalHooksDir)) { copyFileSync(join(runtime.canonicalHooksDir, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755) }
  const parent = git('rev-parse', 'HEAD'), baseTree = git('write-tree')
  const options = { ...runtime, privateFootprintDir: footprint, operation: 'prepare' as const, expectedParent: parent, expectedTree: baseTree, expectedRef: 'refs/heads/node/delivery' }
  if (differentStore) mkdirSync(runtimeRoot(root), { recursive: true })
  const prepared = prepareTrustedHooksBinding(root, options)
  assert.equal(prepared.status, 'supported', prepared.status === 'unsupported' ? JSON.stringify(prepared.issues) : '')
  const binding = (prepared as { binding: TrustedHooksBinding }).binding
  return { root, directory, footprint, marker, author, env: { ...env, SPEXCODE_HOME: process.env.SPEXCODE_HOME }, git, cli, parent, baseTree, options, binding, spec }
}

test('冻结已有锚点漂移的代码提交可严格准备，只有修复Spec的候选通过严格发布', t => {
  const f = fixture(t, false, true), delivery = join(f.directory, 'delivery')
  assert.throws(() => f.cli('spec', 'lint', '--pending', f.parent), /anchor-drift.*src\/calculation\.py#result/)
  const prepared = spawnSync('/usr/bin/git', ['-C', f.root, 'worktree', 'add', '-b', 'node/delivery', delivery, f.parent], { env: makeTrustedHookEnv(f.binding, f.env), encoding: 'utf8' })
  assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`)
  assert.equal(f.git('rev-parse', 'node/delivery'), f.parent)
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', delivery, ...args], { env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const publish = (message: string) => {
    const inspected = prepareTrustedHooksBinding(delivery, { ...f.options, operation: 'publish', expectedTree: git('write-tree') })
    assert.equal(inspected.status, 'supported', inspected.status === 'unsupported' ? JSON.stringify(inspected.issues) : '')
    return spawnSync('/usr/bin/git', ['-C', delivery, 'commit', '-m', message], { env: makeTrustedHookEnv(inspected.binding, f.env), encoding: 'utf8' })
  }
  writeFileSync(join(delivery, 'src/calculation.py'), 'def result():\n    return 3\n')
  git('add', 'src/calculation.py')
  const rejected = publish('candidate with new anchor drift')
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /anchor-drift.*src\/calculation\.py#result/)
  assert.equal(git('rev-parse', 'HEAD'), f.parent)
  git('restore', '--source=HEAD', '--staged', '--worktree', 'src/calculation.py')
  writeFileSync(join(delivery, f.spec), readFileSync(join(delivery, f.spec), 'utf8').replace('Returns 1.', 'Returns 2.'))
  git('add', f.spec)
  const expectedTree = git('write-tree'), committed = publish('update the calculation Spec')
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`)
  assert.equal(git('show', '-s', '--format=%T%n%P', 'HEAD'), `${expectedTree}\n${f.parent}`)
  assert.equal(git('diff', '--name-only', f.parent, 'HEAD'), f.spec)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.equal(f.git('write-tree'), f.baseTree)
})

for (const differentStore of [false, true]) test(`完整冻结发布CLI在${differentStore ? '另一home已植入' : '现有'}canonical filter项目四真hook准备与发布，作者字节/source index/raw tree不变`, t => {
  const f = fixture(t, differentStore), delivery = join(f.directory, 'delivery')
  const filterRootPath = join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'spexcode/contract-filter-root'), filterRootBytes = readFileSync(filterRootPath)
  const sourceBytes = readFileSync(join(f.root, 'AGENTS.md')), sourceIndex = f.git('write-tree')
  const prepared = spawnSync('/usr/bin/git', ['-C', f.root, 'worktree', 'add', '-b', 'node/delivery', delivery, f.parent], { env: makeTrustedHookEnv(f.binding, { ...f.env, SPEXCODE_GATE_TRACE: '1' }), encoding: 'utf8' })
  assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`)
  assert.equal(readFileSync(join(delivery, 'AGENTS.md'), 'utf8'), f.author)
  const candidateAuthor = f.author + '候选作者修改。\n', stagingIndex = join(f.directory, 'candidate.index')
  const indexEnv = { ...f.env, GIT_INDEX_FILE: stagingIndex }
  const indexGit = (args: string[], input?: string) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', f.root, ...args], { env: indexEnv, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  indexGit(['read-tree', f.parent]); const blob = indexGit(['hash-object', '-w', '--stdin'], candidateAuthor)
  indexGit(['update-index', '--cacheinfo', '100644', blob, 'AGENTS.md']); const tree = indexGit(['write-tree'])
  execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', delivery, 'read-tree', tree], { env: f.env })
  writeFileSync(join(delivery, 'AGENTS.md'), candidateAuthor)
  const inspected = prepareTrustedHooksBinding(delivery, { ...f.options, operation: 'publish', expectedTree: tree })
  assert.equal(inspected.status, 'supported', inspected.status === 'unsupported' ? JSON.stringify(inspected.issues) : '')
  const committed = spawnSync('/usr/bin/git', ['--no-replace-objects', '-C', delivery, 'commit', '-m', 'frozen real CLI delivery'], { env: makeTrustedHookEnv((inspected as { binding: TrustedHooksBinding }).binding, { ...f.env, SPEXCODE_SESSION_ID: 'real-delivery-fixture' }), encoding: 'utf8' })
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`)
  assert.equal(f.git('show', '-s', '--format=%T', 'node/delivery'), tree)
  assert.equal(f.git('show', '-s', '--format=%P', 'node/delivery'), f.parent)
  assert.equal(f.git('show', 'node/delivery:AGENTS.md'), candidateAuthor.trimEnd())
  assert.equal(readFileSync(join(delivery, 'AGENTS.md'), 'utf8'), candidateAuthor)
  assert.equal(execFileSync('/usr/bin/git', ['--no-replace-objects', '-C', delivery, 'write-tree'], { encoding: 'utf8' }).trim(), tree)
  assert.match(f.git('show', '-s', '--format=%B', 'node/delivery'), /Session: real-delivery-fixture/)
  assert.equal(f.git('write-tree'), sourceIndex); assert.deepEqual(readFileSync(join(f.root, 'AGENTS.md')), sourceBytes)
  assert.deepEqual(readFileSync(filterRootPath), filterRootBytes)
  const projection = JSON.parse(readFileSync(join(f.footprint, 'footprint.json'), 'utf8')) as { hooks: string; contract: string }
  assert.ok(projection.hooks.includes('custom-script')); assert.ok(projection.contract.length > 0)
  assert.equal(existsSync(f.marker), false)
})

test('canonical filter root必须属于实际commonDir项目，任意目录和外来项目不获交付绑定', t => {
  const f = fixture(t), common = f.git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const metadata = join(common, 'spexcode/contract-filter-root'), original = readFileSync(metadata), project = basename(original.toString().trim())
  for (const root of [join(f.directory, 'arbitrary'), join(f.directory, 'other-store/projects/another-project'), join(f.directory, 'not-projects', project)]) {
    mkdirSync(root, { recursive: true }); writeFileSync(metadata, `${root}\n`)
    const result = prepareTrustedHooksBinding(f.root, f.options)
    assert.equal(result.status, 'unsupported')
    if (result.status === 'unsupported') assert.ok(result.issues.some(issue => issue.path === metadata && issue.reason === 'filter 外部 payload root 与项目身份不符'))
    assert.equal(existsSync(f.marker), false)
  }
  writeFileSync(metadata, original)
  assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'supported')
})

test('真实runtime预检后config/shim/bindings漂移拒绝，unknown filter/custom hook marker从未执行', t => {
  const f = fixture(t), common = f.git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const rejectHook = () => {
    const result = spawnSync('/bin/bash', [join(common, 'hooks/post-checkout'), f.parent, f.parent, '1'], { cwd: f.root, env: makeTrustedHookEnv(f.binding, { ...f.env, SPEXCODE_GATE_TRACE: '1' }), encoding: 'utf8' })
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`); assert.equal(existsSync(f.marker), false)
  }
  const clean = f.git('config', 'filter.spexcode.clean')
  f.git('config', 'filter.spexcode.clean', `sh -c "printf bad > '${f.marker}'"`)
  const unsupported = inspectTrustedHooksBinding(f.root, f.binding)
  assert.equal(unsupported.status, 'unsupported'); assert.ok(!JSON.stringify(unsupported).includes('printf bad')); rejectHook()
  f.git('config', 'filter.spexcode.clean', clean)
  for (const name of ['contract-filter.sh', 'contract-filter-bindings']) {
    const path = join(common, 'spexcode', name), original = readFileSync(path)
    writeFileSync(path, Buffer.concat([original, Buffer.from('\nchanged\n')]))
    assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'unsupported'); rejectHook(); writeFileSync(path, original)
  }
  const custom = join(common, 'hooks/pre-push'); writeFileSync(custom, `#!/bin/sh\nprintf bad > '${f.marker}'\n`); chmodSync(custom, 0o755)
  assert.equal(prepareTrustedHooksBinding(f.root, f.options).status, 'unsupported'); assert.equal(existsSync(f.marker), false)
  assert.equal(existsSync(join(f.footprint, 'footprint.json')), false)
})


test('真实canonical filter拒绝初始manifest外部数据来源与私有目录物理身份漂移', t => {
  const f = fixture(t)
  const manifest = f.binding.footprintPolicy.files.find(file => file.path.endsWith('/contract-filter/manifest'))!.path
  const original = readFileSync(manifest), outside = join(f.directory, 'private-data.txt')
  writeFileSync(outside, '不可作为filter来源的数据\n')
  writeFileSync(manifest, `AGENTS.md\t${outside}\n`)
  assert.equal(prepareTrustedHooksBinding(f.root, f.options).status, 'unsupported')
  writeFileSync(manifest, original)
  const oldDirectory = join(f.directory, 'old-footprint')
  renameSync(f.footprint, oldDirectory); mkdirSync(f.footprint, { mode: 0o700 })
  assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'unsupported')
  const common = f.git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const failed = spawnSync('/bin/bash', [join(common, 'hooks/post-checkout'), f.parent, f.parent, '1'], { cwd: f.root, env: makeTrustedHookEnv(f.binding, f.env), encoding: 'utf8' })
  assert.notEqual(failed.status, 0); assert.equal(existsSync(join(f.footprint, 'footprint.json')), false)
  assert.equal(existsSync(f.marker), false)
})


test('真实CLI未知冻结模式直接失败，不降级ordinary materialize/surgery写作者或shared配置', t => {
  const f = fixture(t), before = readFileSync(join(f.root, 'AGENTS.md')), index = f.git('write-tree')
  for (const verb of ['refresh-footprint', 'commit-surgery']) {
    const failed = spawnSync(process.execPath, [runtime.toolEntry, 'internal', verb], { cwd: f.root, env: { ...f.env, SPEXCODE_SYNC_HOOK_MODE: 'trusted-unknown' }, encoding: 'utf8' })
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /未支持的冻结交付 footprint 模式/)
    assert.deepEqual(readFileSync(join(f.root, 'AGENTS.md')), before); assert.equal(f.git('write-tree'), index)
    assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'supported')
  }
})
