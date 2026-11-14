import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectTrustedHooksBinding, inspectTrustedRuntime, inspectTrustedRuntimeAsync, makeTrustedHookEnv, prepareTrustedHooksBinding } from './trusted-hooks.js'
import type { TrustedHooksBinding } from './trusted-hooks.js'

const canonical = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
function runtimeFixture(t: test.TestContext): { root: string; outside: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'spex-runtime-inspection-')))
  const root = join(parent, 'runtime'), outside = join(parent, 'outside.txt')
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  mkdirSync(root)
  writeFileSync(join(root, 'target.txt'), 'original target\n')
  for (let directory = 0; directory < 4; directory++) {
    const nested = join(root, `part-${directory}`)
    mkdirSync(nested)
    for (let file = 0; file < 12; file++) writeFileSync(join(nested, `file-${String(file).padStart(2, '0')}.js`), `export const value = ${directory * 12 + file}\n`)
  }
  return { root, outside }
}

test('async runtime inspection在超过一批的manifest完成前让出事件循环，且与sync顺序完全一致', async t => {
  const { root } = runtimeFixture(t)
  let immediateRan = false
  setImmediate(() => { immediateRan = true })
  const manifest = inspectTrustedRuntimeAsync(root).then(entries => {
    assert.equal(immediateRan, true, 'manifest结束前应让已排队的setImmediate回调执行')
    return entries
  })
  const asyncEntries = await manifest
  assert.ok(asyncEntries.length > 32)
  assert.deepEqual(asyncEntries, inspectTrustedRuntime(root))
})

test('async runtime inspection逐次反映文件字节、模式和内部链接变化', async t => {
  const { root } = runtimeFixture(t), target = join(root, 'target.txt')
  chmodSync(target, 0o644)
  const original = await inspectTrustedRuntimeAsync(root)
  assert.deepEqual(original, inspectTrustedRuntime(root))
  const originalTarget = original.find(entry => entry.path === 'target.txt')
  assert.ok(originalTarget?.kind === 'file')

  writeFileSync(target, 'changed target bytes\n')
  const changedBytes = await inspectTrustedRuntimeAsync(root)
  assert.deepEqual(changedBytes, inspectTrustedRuntime(root))
  const changedTarget = changedBytes.find(entry => entry.path === 'target.txt')
  assert.ok(changedTarget?.kind === 'file')
  assert.notEqual(changedTarget.digest, originalTarget.digest)

  chmodSync(target, 0o600)
  const changedMode = await inspectTrustedRuntimeAsync(root)
  assert.deepEqual(changedMode, inspectTrustedRuntime(root))
  const modeTarget = changedMode.find(entry => entry.path === 'target.txt')
  assert.ok(modeTarget?.kind === 'file')
  assert.notEqual(modeTarget.mode, changedTarget.mode)

  symlinkSync('target.txt', join(root, 'inside-link.txt'))
  const changedLink = await inspectTrustedRuntimeAsync(root)
  assert.deepEqual(changedLink, inspectTrustedRuntime(root))
  const link = changedLink.find(entry => entry.path === 'inside-link.txt')
  assert.ok(link?.kind === 'symlink')
  assert.equal(link.target, 'target.txt')
})

test('async runtime inspection让出期间修改尚未读取的文件不会沿用旧manifest', async t => {
  const { root } = runtimeFixture(t)
  const before = inspectTrustedRuntime(root)
  setImmediate(() => writeFileSync(join(root, 'target.txt'), 'changed during the first yield\n'))
  const after = await inspectTrustedRuntimeAsync(root)
  assert.notDeepEqual(after, before)
  assert.deepEqual(after, inspectTrustedRuntime(root))
})

test('sync與async runtime inspection都拒絕外部symlink', async t => {
  const { root, outside } = runtimeFixture(t)
  writeFileSync(outside, 'outside bytes\n')
  symlinkSync(outside, join(root, 'outside-link.txt'))
  assert.throws(() => inspectTrustedRuntime(root), /runtime 外部链接无法绑定: outside-link\.txt/)
  await assert.rejects(inspectTrustedRuntimeAsync(root), /runtime 外部链接无法绑定: outside-link\.txt/)
})

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-trusted-hooks-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'candidate'), trusted = join(directory, 'trusted'), log = join(directory, 'trusted.log'), malicious = join(directory, 'candidate-executed')
  mkdirSync(root); mkdirSync(join(directory, 'footprint'), { mode: 0o700 }); mkdirSync(join(trusted, 'dist'), { recursive: true }); mkdirSync(join(trusted, 'templates/hooks'), { recursive: true })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'file.txt'), 'seed\n'); git('add', '.'); git('commit', '-m', 'seed'); git('switch', '-c', 'delivery'); git('branch', 'other')
  mkdirSync(join(trusted, 'dist/sync'))
  copyFileSync(fileURLToPath(new URL('../../dist/sync/trusted-footprint.js', import.meta.url)), join(trusted, 'dist/sync/trusted-footprint.js'))
  writeFileSync(join(trusted, 'package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(trusted, 'dist/helper.mjs'), 'export const stable = true;\n')
  writeFileSync(join(trusted, 'dist/cli.mjs'), `import './helper.mjs';
import { appendFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
const args=process.argv.slice(2); appendFileSync(process.env.TRUSTED_HOOK_LOG,args.join(' ')+'\\n');
if(args[0]==='internal'&&args[1]==='trunk') console.log('main');
if(process.env.FIXTURE_EXIT_75==='1'||process.env.FIXTURE_FAIL_AT===args[1]) process.exit(75);
if(process.env.FIXTURE_LINT_76==='1'&&args[1]==='lint') process.exit(76);
if(process.env.FIXTURE_SURGERY==='1'&&args[1]==='commit-surgery') {
const oid=execFileSync(process.env.SPEXCODE_SYNC_GIT,['hash-object','-w','--stdin'],{input:'surgery mutation\\n'}).toString().trim();
execFileSync(process.env.SPEXCODE_SYNC_GIT,['update-index','--cacheinfo','100644',oid,'file.txt']);
}
`)
  for (const name of readdirSync(canonical)) {
    copyFileSync(join(canonical, name), join(trusted, 'templates/hooks', name))
    copyFileSync(join(canonical, name), join(root, '.git/hooks', name)); chmodSync(join(root, '.git/hooks', name), 0o755)
  }
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules/.bin/spex'), `#!/bin/sh\nprintf bad > '${malicious}'\nexit 0\n`); chmodSync(join(root, 'node_modules/.bin/spex'), 0o755)
  writeFileSync(join(root, 'file.txt'), 'candidate\n'); git('add', 'file.txt')
  const parent = git('rev-parse', 'HEAD'), tree = git('write-tree')
  const options = { privateFootprintDir: join(directory, 'footprint'), operation: 'publish' as const, nodePath: process.execPath, gitPath: '/usr/bin/git', toolEntry: join(trusted, 'dist/cli.mjs'), trustedRuntimeRoot: trusted, canonicalHooksDir: join(trusted, 'templates/hooks'), expectedTree: tree, expectedParent: parent, expectedRef: 'refs/heads/delivery' }
  const prepared = prepareTrustedHooksBinding(root, options)
  assert.equal(prepared.status, 'supported', prepared.status === 'unsupported' ? JSON.stringify(prepared.issues) : '')
  const binding = (prepared as { binding: TrustedHooksBinding }).binding
  const controlled = (extra: NodeJS.ProcessEnv = {}) => makeTrustedHookEnv(binding, { ...env, TRUSTED_HOOK_LOG: log, ...extra })
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync('/usr/bin/git', ['-C', root, ...args], { env: controlled(extra), encoding: 'utf8' })
  const prepareRun = (args: string[], extra: NodeJS.ProcessEnv = {}, expectedRef = options.expectedRef) => {
    const prepared = prepareTrustedHooksBinding(root, { ...options, operation: 'prepare' as const, expectedTree: git('rev-parse', `${parent}^{tree}`), expectedRef })
    assert.equal(prepared.status, 'supported', prepared.status === 'unsupported' ? JSON.stringify(prepared.issues) : '')
    return spawnSync('/usr/bin/git', ['-C', root, ...args], { env: makeTrustedHookEnv((prepared as { binding: TrustedHooksBinding }).binding, { ...env, TRUSTED_HOOK_LOG: log, ...extra }), encoding: 'utf8' })
  }
  return { root, trusted, log, malicious, git, parent, tree, options, binding, controlled, run, prepareRun, directory }
}

test('四个真实Git hook调用候选外固定编译入口，candidate.bin从未执行且ref/parent/tree绑定', t => {
  const f = fixture(t)
  const checkout = f.prepareRun(['checkout', 'delivery'], { SPEXCODE_GATE_TRACE: '1' })
  assert.equal(checkout.status, 0, `${checkout.stdout}${checkout.stderr}`)
  const committed = f.run(['commit', '-m', 'frozen delivery'], { SPEXCODE_GATE_TRACE: '1' })
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`)
  const calls = readFileSync(f.log, 'utf8')
  for (const command of ['internal refresh-footprint', 'internal trunk', 'internal commit-surgery', 'internal commit-context', 'spec lint --pending']) assert.ok(calls.includes(command), calls)
  assert.equal(existsSync(f.malicious), false)
  assert.equal(f.git('show', '-s', '--format=%T', 'HEAD'), f.tree)
  assert.equal(f.git('show', '-s', '--format=%P', 'HEAD'), f.parent)
})

test('wrong tree/parent/ref真实prepared拒绝，原ref不前进', t => {
  const f = fixture(t)
  const newTree = f.git('rev-parse', 'HEAD^{tree}')
  const wrongTreeCommit = f.git('commit-tree', newTree, '-p', f.parent, '-m', 'wrong tree')
  const noParentCommit = f.git('commit-tree', f.tree, '-m', 'wrong parent')
  const goodCommit = f.git('commit-tree', f.tree, '-p', f.parent, '-m', 'right content wrong ref')
  for (const [oid, ref] of [[wrongTreeCommit, 'refs/heads/delivery'], [noParentCommit, 'refs/heads/delivery'], [goodCommit, 'refs/heads/other']]) {
    const failed = f.run(['update-ref', ref, oid, f.parent])
    assert.notEqual(failed.status, 0); assert.match(`${failed.stdout}${failed.stderr}`, /frozen delivery.*mismatch/)
    assert.equal(f.git('rev-parse', ref), f.parent)
  }
  assert.equal(existsSync(f.malicious), false)
})

test('可信surgery修改index导致实际commit tree不符，真实ref保持原parent', t => {
  const f = fixture(t)
  const failed = f.run(['commit', '-m', 'surgery must not change frozen candidate'], { FIXTURE_SURGERY: '1' })
  assert.notEqual(failed.status, 0); assert.match(`${failed.stdout}${failed.stderr}`, /frozen delivery tree\/parent\/ref mismatch/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.notEqual(f.git('write-tree'), f.tree)
  assert.equal(existsSync(f.malicious), false)
})

test('missing工具与exit75严格阻断，不沿用普通advisory或candidate fallback', t => {
  const f = fixture(t)
  const paused = f.run(['commit', '-m', 'paused'], { FIXTURE_EXIT_75: '1' })
  assert.notEqual(paused.status, 0); assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  const absent = spawnSync('/usr/bin/git', ['-C', f.root, 'commit', '-m', 'missing'], { env: { ...f.controlled(), SPEXCODE_SYNC_TOOL: join(f.trusted, 'dist/missing.js') }, encoding: 'utf8' })
  assert.notEqual(absent.status, 0); assert.equal(f.git('rev-parse', 'HEAD'), f.parent); assert.equal(existsSync(f.malicious), false)
})

test('静态preflight拒绝未知hook、候选hooksPath、外部filter/signing，不执行任何探针', t => {
  const f = fixture(t)
  const custom = join(f.root, '.git/hooks/pre-commit')
  writeFileSync(custom, `#!/bin/sh\n# spexcode-managed-hook-v1\nprintf bad > '${f.malicious}'\nexit 0\n`)
  let result = prepareTrustedHooksBinding(f.root, f.options)
  assert.equal(result.status, 'unsupported'); if (result.status === 'unsupported') assert.ok(result.issues.some(issue => issue.path === join(f.binding.hooksDir, 'pre-commit')))
  assert.equal(existsSync(f.malicious), false)
  copyFileSync(join(canonical, 'pre-commit'), custom); chmodSync(custom, 0o755)
  for (const [key, value] of [['core.hooksPath', 'candidate-hooks'], ['filter.evil.clean', `sh -c "printf secret > '${f.malicious}'"`], ['commit.gpgSign', 'true'], ['diff.external', `sh -c "printf secret > '${f.malicious}'"`], ['trailer.session.cmd', `sh -c "printf secret > '${f.malicious}'"`]]) {
    f.git('config', key, value)
    result = prepareTrustedHooksBinding(f.root, f.options)
    assert.equal(result.status, 'unsupported'); assert.equal(existsSync(f.malicious), false)
    if (result.status === 'unsupported') assert.ok(!JSON.stringify(result.issues).includes('printf secret'))
    f.git('config', '--unset', key)
  }
})

test('完整runtime/imported模块、模板或binary摘要变化拒绝旧binding，源码launcher和候选模板不可自认', t => {
  const f = fixture(t)
  assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'supported')
  writeFileSync(join(f.trusted, 'dist/helper.mjs'), 'export const stable = false;\n')
  assert.equal(inspectTrustedHooksBinding(f.root, f.binding).status, 'unsupported')
  const failed = f.run(['commit', '-m', 'mutated imported module'])
  assert.notEqual(failed.status, 0); assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.equal(existsSync(f.malicious), false)
  const launcher = prepareTrustedHooksBinding(f.root, { ...f.options, toolEntry: join(f.root, 'node_modules/.bin/spex') })
  assert.equal(launcher.status, 'unsupported')
  const candidateTemplates = prepareTrustedHooksBinding(f.root, { ...f.options, canonicalHooksDir: join(f.root, '.git/hooks') })
  assert.equal(candidateTemplates.status, 'unsupported')
})

test('普通模式没有CLI仍按原advisory提交；受控环境移除注入和bypass', t => {
  const f = fixture(t)
  rmSync(join(f.root, 'node_modules'), { recursive: true })
  const ordinary = spawnSync('/usr/bin/git', ['-C', f.root, 'commit', '-m', 'ordinary no CLI'], { env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8' })
  assert.equal(ordinary.status, 0, `${ordinary.stdout}${ordinary.stderr}`)
  assert.match(ordinary.stderr, /no `spex` CLI found/)
  assert.equal(existsSync(f.log), false)
  const env = f.controlled({ NODE_OPTIONS: '--require=candidate.js', BASH_ENV: 'candidate.sh', LD_PRELOAD: 'candidate.so', GIT_CONFIG_COUNT: '1', SPEXCODE_SKIP_LINT: '1', SPEXCODE_DEFER_FOOTPRINT_REFRESH: 'session-create', SPEXCODE_ALLOW_MAIN: '1' })
  for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'GIT_CONFIG_COUNT', 'SPEXCODE_SKIP_LINT', 'SPEXCODE_DEFER_FOOTPRINT_REFRESH', 'SPEXCODE_ALLOW_MAIN']) assert.equal(env[key], undefined)
})


test('strict模式各工具阶段exit75/76均阻断，issue-only不能免frozen版本绑定', t => {
  const f = fixture(t)
  for (const stage of ['commit-surgery', 'commit-context', 'lint']) {
    const failed = f.run(['commit', '-m', `strict ${stage} failure`], { FIXTURE_FAIL_AT: stage })
    assert.notEqual(failed.status, 0); assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  }
  assert.notEqual(f.prepareRun(['checkout', 'delivery'], { FIXTURE_FAIL_AT: 'refresh-footprint' }).status, 0)
  assert.notEqual(f.run(['commit', '-m', 'scope exit76 is not full proof'], { FIXTURE_LINT_76: '1' }).status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  f.git('reset', '--hard', f.parent)
  mkdirSync(join(f.root, '.spec/.issues'), { recursive: true }); writeFileSync(join(f.root, '.spec/.issues/one.json'), '{}\n'); f.git('add', '.spec/.issues/one.json')
  const failed = f.run(['commit', '-m', 'issue-only wrong frozen tree'])
  assert.notEqual(failed.status, 0); assert.match(`${failed.stdout}${failed.stderr}`, /frozen delivery.*mismatch/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent); assert.equal(existsSync(f.malicious), false)
})


test('prepare真实创建绑定分支与worktree，仅已有base身份', t => {
  const f = fixture(t)
  const delivery = join(f.directory, 'fresh-delivery')
  const prepared = f.prepareRun(['worktree', 'add', '-b', 'fresh-delivery', delivery, f.parent], { FIXTURE_FAIL_AT: 'lint' }, 'refs/heads/fresh-delivery')
  assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`)
  assert.equal(f.git('rev-parse', 'refs/heads/fresh-delivery'), f.parent)
  assert.ok(readFileSync(f.log, 'utf8').includes('internal refresh-footprint'))
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /spec lint --pending/)
  assert.equal(existsSync(f.malicious), false)
  // The coordinator later fills the exact candidate index in the created worktree and rebinds publish.
  execFileSync('/usr/bin/git', ['-C', delivery, 'read-tree', f.tree])
  const published = prepareTrustedHooksBinding(delivery, { ...f.options, expectedRef: 'refs/heads/fresh-delivery' })
  assert.equal(published.status, 'supported', published.status === 'unsupported' ? JSON.stringify(published.issues) : '')
  const publishEnv = makeTrustedHookEnv((published as { binding: TrustedHooksBinding }).binding, { ...process.env, TRUSTED_HOOK_LOG: f.log })
  const rejected = spawnSync('/usr/bin/git', ['-C', delivery, 'commit', '-m', 'candidate still fails lint'], { env: { ...publishEnv, FIXTURE_FAIL_AT: 'lint' }, encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /candidate spec-lint failed/)
  assert.equal(f.git('rev-parse', 'refs/heads/fresh-delivery'), f.parent)
  const committed = spawnSync('/usr/bin/git', ['-C', delivery, 'commit', '-m', 'prepared worktree publication'], { env: publishEnv, encoding: 'utf8' })
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`)
  assert.equal(f.git('show', '-s', '--format=%T', 'refs/heads/fresh-delivery'), f.tree)
  assert.equal(f.git('show', '-s', '--format=%P', 'refs/heads/fresh-delivery'), f.parent)
})

test('publish拒绝HEAD-only作者提交，detached HEAD保持原base', t => {
  const f = fixture(t)
  const detached = f.prepareRun(['switch', '--detach', f.parent], { SPEXCODE_GATE_TRACE: '1' })
  assert.equal(detached.status, 0, `${detached.stdout}${detached.stderr}`)
  writeFileSync(join(f.root, 'file.txt'), 'unverified detached content\n'); f.git('add', 'file.txt')
  const failed = f.run(['commit', '-m', 'detached author must fail'])
  assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.equal(f.git('rev-parse', 'refs/heads/delivery'), f.parent)
})


test('prepare不接受作者对象、其它ref/base；operation必需且prepare tree必须为base', t => {
  const f = fixture(t)
  const author = f.git('commit-tree', f.tree, '-p', f.parent, '-m', 'not structural')
  const failed = f.prepareRun(['update-ref', 'refs/heads/new-author', author, '0'.repeat(40)], {}, 'refs/heads/new-author')
  assert.notEqual(failed.status, 0)
  assert.equal(spawnSync('/usr/bin/git', ['-C', f.root, 'show-ref', '--verify', '--quiet', 'refs/heads/new-author']).status, 1)
  const wrongRef = f.prepareRun(['branch', 'unbound-branch', f.parent])
  assert.notEqual(wrongRef.status, 0)
  assert.equal(spawnSync('/usr/bin/git', ['-C', f.root, 'show-ref', '--verify', '--quiet', 'refs/heads/unbound-branch']).status, 1)
  const wrongBase = f.prepareRun(['switch', '--detach', author])
  assert.notEqual(wrongBase.status, 0); assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.equal(prepareTrustedHooksBinding(f.root, { ...f.options, operation: 'prepare' }).status, 'unsupported')
  const missing = { ...f.options }
  delete (missing as Partial<typeof missing>).operation
  assert.equal(prepareTrustedHooksBinding(f.root, missing as typeof f.options).status, 'unsupported')
  assert.notEqual(spawnSync('/usr/bin/git', ['-C', f.root, 'commit', '-m', 'missing operation'], { env: { ...f.controlled(), SPEXCODE_SYNC_OPERATION: undefined }, encoding: 'utf8' }).status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
})

test('post-checkout严格可信刷新失败不会抹去已完成的HEAD结构切换', t => {
  const f = fixture(t)
  const failed = f.prepareRun(['switch', '--detach', f.parent], { FIXTURE_FAIL_AT: 'refresh-footprint' })
  assert.notEqual(failed.status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  assert.equal(spawnSync('/usr/bin/git', ['-C', f.root, 'symbolic-ref', '-q', 'HEAD']).status, 1)
  assert.ok(readFileSync(f.log, 'utf8').includes('internal refresh-footprint'))
  assert.equal(existsSync(f.malicious), false)
})

for (const defect of ['tree', 'parent'] as const) {
  test(`refs/replace不能伪造实际commit的${defect}，移除child环境保护仍由严格Git参数拒绝`, t => {
    const f = fixture(t)
    const baseTree = f.git('rev-parse', `${f.parent}^{tree}`)
    const wrong = defect === 'tree' ? f.git('commit-tree', baseTree, '-p', f.parent, '-m', 'raw wrong tree') : f.git('commit-tree', f.tree, '-m', 'raw wrong parent')
    const good = f.git('commit-tree', f.tree, '-p', f.parent, '-m', 'replacement good')
    assert.notEqual(f.git('--no-replace-objects', 'show', '-s', defect === 'tree' ? '--format=%T' : '--format=%P', wrong), defect === 'tree' ? f.tree : f.parent)
    f.git('replace', wrong, good)
    assert.equal(prepareTrustedHooksBinding(f.root, f.options).status, 'supported')
    assert.equal(f.git('show', '-s', '--format=%T', wrong), f.tree)
    assert.equal(f.git('show', '-s', '--format=%P', wrong), f.parent)
    const failed = spawnSync('/usr/bin/git', ['-C', f.root, 'update-ref', f.options.expectedRef, wrong, f.parent], { env: { ...f.controlled(), GIT_NO_REPLACE_OBJECTS: undefined }, encoding: 'utf8' })
    assert.notEqual(failed.status, 0, `${failed.stdout}${failed.stderr}`)
    assert.equal(f.git('rev-parse', f.options.expectedRef), f.parent)
  })
}

test('prepare静态读取不信替代parent的tree；child环境固定禁止replace；raw valid不被坏替代降级', t => {
  const f = fixture(t)
  const changedParent = f.git('commit-tree', f.tree, '-m', 'replacement parent with wrong base tree')
  f.git('replace', f.parent, changedParent)
  assert.equal(prepareTrustedHooksBinding(f.root, { ...f.options, operation: 'prepare' }).status, 'unsupported')
  assert.equal(makeTrustedHookEnv(f.binding, { GIT_NO_REPLACE_OBJECTS: '0' }).GIT_NO_REPLACE_OBJECTS, '1')
  f.git('replace', '-d', f.parent)
  const good = f.git('commit-tree', f.tree, '-p', f.parent, '-m', 'raw valid')
  const wrong = f.git('commit-tree', f.git('rev-parse', `${f.parent}^{tree}`), '-m', 'replacement wrong tree and parent')
  f.git('replace', good, wrong)
  const committed = spawnSync('/usr/bin/git', ['-C', f.root, 'update-ref', f.options.expectedRef, good, f.parent], { env: { ...f.controlled(), GIT_NO_REPLACE_OBJECTS: undefined }, encoding: 'utf8' })
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`)
  assert.equal(f.git('rev-parse', f.options.expectedRef), good)
  assert.equal(f.git('--no-replace-objects', 'show', '-s', '--format=%T', good), f.tree)
  assert.equal(f.git('--no-replace-objects', 'show', '-s', '--format=%P', good), f.parent)
})
