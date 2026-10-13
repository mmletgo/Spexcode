import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectTrustedHooksBinding, makeTrustedHookEnv, prepareTrustedHooksBinding } from './trusted-hooks.js'
import type { TrustedHooksBinding } from './trusted-hooks.js'

const canonical = fileURLToPath(new URL('../../templates/hooks/', import.meta.url))
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'spex-trusted-hooks-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'candidate'), trusted = join(directory, 'trusted'), log = join(directory, 'trusted.log'), malicious = join(directory, 'candidate-executed')
  mkdirSync(root); mkdirSync(join(trusted, 'dist'), { recursive: true }); mkdirSync(join(trusted, 'templates/hooks'), { recursive: true })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  const git = (...args: string[]): string => execFileSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, 'file.txt'), 'seed\n'); git('add', '.'); git('commit', '-m', 'seed'); git('switch', '-c', 'delivery'); git('branch', 'other')
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
  const options = { nodePath: process.execPath, gitPath: '/usr/bin/git', toolEntry: join(trusted, 'dist/cli.mjs'), trustedRuntimeRoot: trusted, canonicalHooksDir: join(trusted, 'templates/hooks'), expectedTree: tree, expectedParent: parent, expectedRef: 'refs/heads/delivery' }
  const prepared = prepareTrustedHooksBinding(root, options)
  assert.equal(prepared.status, 'supported', prepared.status === 'unsupported' ? JSON.stringify(prepared.issues) : '')
  const binding = (prepared as { binding: TrustedHooksBinding }).binding
  const controlled = (extra: NodeJS.ProcessEnv = {}) => makeTrustedHookEnv(binding, { ...env, TRUSTED_HOOK_LOG: log, ...extra })
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync('/usr/bin/git', ['-C', root, ...args], { env: controlled(extra), encoding: 'utf8' })
  return { root, trusted, log, malicious, git, parent, tree, options, binding, controlled, run }
}

test('四个真实Git hook调用候选外固定编译入口，candidate.bin从未执行且ref/parent/tree绑定', t => {
  const f = fixture(t)
  const checkout = f.run(['checkout', 'delivery'])
  assert.equal(checkout.status, 0, `${checkout.stdout}${checkout.stderr}`)
  const committed = f.run(['commit', '-m', 'frozen delivery'])
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
  for (const [key, value] of [['core.hooksPath', 'candidate-hooks'], ['filter.evil.clean', `sh -c "printf secret > '${f.malicious}'"`], ['commit.gpgSign', 'true']]) {
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
  assert.notEqual(f.run(['checkout', 'delivery'], { FIXTURE_FAIL_AT: 'refresh-footprint' }).status, 0)
  assert.notEqual(f.run(['commit', '-m', 'scope exit76 is not full proof'], { FIXTURE_LINT_76: '1' }).status, 0)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent)
  f.git('reset', '--hard', f.parent)
  mkdirSync(join(f.root, '.spec/.issues'), { recursive: true }); writeFileSync(join(f.root, '.spec/.issues/one.json'), '{}\n'); f.git('add', '.spec/.issues/one.json')
  const failed = f.run(['commit', '-m', 'issue-only wrong frozen tree'])
  assert.notEqual(failed.status, 0); assert.match(`${failed.stdout}${failed.stderr}`, /frozen delivery.*mismatch/)
  assert.equal(f.git('rev-parse', 'HEAD'), f.parent); assert.equal(existsSync(f.malicious), false)
})
