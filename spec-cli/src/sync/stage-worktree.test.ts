import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { encodeProject } from '@spexcode/spec-core'
import { canonicalContractFilterBindings, describeCanonicalContractFilter } from '../contract-filter.js'
import { contentHash, objectGit, readObject, readTree, writeObject, writeTree } from './snapshot.js'
import { importStageChanges, overlayStageTree, readStoppedPhysicalDraft, stageWorktree, verifyStageResult } from './stage-worktree.js'
import { nativeWorktreeResult } from '../native-worktree-runtime.js'
import { assertWorktreeSyncModel, DEFAULT_SYNC_MODEL, syncModel } from './model-selection.js'
import type { ElaborationSessionResult } from './elaboration-types.js'

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim()
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sync-stage-worktree-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'stage fixture'); git(root, 'config', 'user.email', 'stage@example.invalid')
  writeFileSync(join(root, 'source.mjs'), 'export const value = 1\n'); writeFileSync(join(root, 'oracle.test.mjs'), 'immutable oracle\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
  return { root, commonDir: git(root, 'rev-parse', '--absolute-git-dir'), parent: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') }
}
function result(seed: ReturnType<typeof stageWorktree>, headCommit = seed.baseCommit, tree = seed.tree): ElaborationSessionResult {
  const output = { summary: '摘要声称的补丁不作为候选' }
  return { sessionId: 'session', threadId: 'thread', turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit, tree, worktreePath: '/historical/closed-worktree' } }
}

for (const mode of ['canonical', 'host-text', 'payload', 'payload-link', 'paired-edit', 'late-source-bytes', 'late-source-mode', 'foreign-path', 'foreign-filter', 'foreign-exec-config', 'outside-link'] as const) test(`stopped committed draft requires exact canonical filter projection: ${mode}`, t => {
  const f = fixture(t), root = join(realpathSync(f.root), 'linked'), ownerDigest = 'e'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const hosts = new Map([['.gitignore', 'host-pattern\n/linked/\n'], ['AGENTS.md', 'host instructions without newline']])
  for (const [file, host] of hosts) writeFileSync(join(f.root, file), host)
  mkdirSync(join(f.root, '.spec/fixture/.plugins/system'), { recursive: true })
  writeFileSync(join(f.root, '.spec/spexcode.json'), '{"harnesses":["codex"]}')
  writeFileSync(join(f.root, '.spec/fixture/spec.md'), '# Fixture\n')
  writeFileSync(join(f.root, '.spec/fixture/.plugins/system/spec.md'), '---\nsurface: system\n---\nFrozen product contract\n')
  mkdirSync(join(f.root, 'aliases')); mkdirSync(join(f.root, 'targets'))
  writeFileSync(join(f.root, 'targets/note.txt'), 'immutable target')
  symlinkSync('../targets', join(f.root, 'aliases/level'))
  symlinkSync('aliases/level/note.txt', join(f.root, 'through'))
  if (mode === 'outside-link') symlinkSync('../AGENTS.md', join(f.root, 'outside'))
  if (mode === 'foreign-exec-config') writeFileSync(join(f.root, '.gitattributes'), '/source.mjs filter=unsafe\n')
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'track pristine host files and system surface')
  const tree = git(f.root, 'rev-parse', 'HEAD^{tree}'), seed = stageWorktree(f.commonDir, git(f.root, 'rev-parse', 'HEAD'), overlayStageTree(f.commonDir, tree, [{ path: path.replace('.json', '.schema.json'), source: schema }]), 'edit')
  git(f.root, 'worktree', 'add', '--detach', root, seed.baseCommit)
  const nativeRoot = join(f.commonDir, 'original-native'), home = join(nativeRoot, 'runtime/home')
  const runtime = join(home, '.spexcode/projects', encodeProject(realpathSync(f.root)))
  const directory = join(runtime, 'trees', encodeProject(root), 'contract-filter')
  mkdirSync(home, { recursive: true })
  const materialize = fileURLToPath(new URL('../../dist/materialize.js', import.meta.url))
  execFileSync(process.execPath, ['--input-type=module', '--eval', 'await (await import(process.argv[1])).materialize()', materialize], {
    cwd: root, stdio: 'pipe',
    env: { PATH: '/usr/bin:/bin', HOME: home, SPEXCODE_HOME: join(home, '.spexcode'), CODEX_HOME: join(home, '.codex'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const { metadataPaths: [filterRoot, , attributesPath] } = describeCanonicalContractFilter(f.commonDir)
  const bindings = canonicalContractFilterBindings(root), managed = new Map<string, { target: string; body: string }>()
  for (const row of readFileSync(join(directory, 'manifest'), 'utf8').trim().split('\n')) {
    const [file, target] = row.split('\t')
    managed.set(file, { target, body: readFileSync(target, 'utf8') })
  }
  for (const [file, host] of hosts) {
    const delimiters = bindings.find(row => row.file === file)!
    assert.equal(readFileSync(join(root, file), 'utf8'), `${host}\n${delimiters.start}\n${managed.get(file)!.body}${delimiters.end}\n`)
  }
  git(root, 'add', '--renormalize', '--', ...hosts.keys())
  const source = '{committed unapproved draft'
  writeFileSync(join(root, path), source); git(root, 'add', path); git(root, 'commit', '-m', 'authorized draft only')
  writeFileSync(filterRoot, `${join(f.commonDir, 'another-session')}\n`)
  if (mode === 'canonical') rmSync(nativeRoot, { recursive: true })
  if (mode === 'host-text') writeFileSync(join(root, 'AGENTS.md'), `changed ${readFileSync(join(root, 'AGENTS.md'), 'utf8')}`)
  const { target, body } = managed.get('AGENTS.md')!
  if (mode === 'payload') writeFileSync(target, 'changed archived payload\n')
  if (mode === 'payload-link') { renameSync(target, `${target}.old`); symlinkSync(`${target}.old`, target) }
  if (mode === 'paired-edit') {
    writeFileSync(target, 'forged managed text\n')
    const file = join(root, 'AGENTS.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(body, 'forged managed text\n'))
  }
  if (mode === 'foreign-path') {
    writeFileSync(attributesPath, `${readFileSync(attributesPath, 'utf8')}/source.mjs filter=spexcode\n`)
    writeFileSync(join(root, 'source.mjs'), 'export const value = 1\n\n<!-- spexcode:start -->\nunauthorized\n<!-- spexcode:end -->\n')
  }
  const marker = join(f.commonDir, 'filter-executed')
  if (mode === 'foreign-filter') {
    git(root, 'config', 'filter.spexcode.clean', `touch '${marker}' && cat`)
    utimesSync(join(root, 'AGENTS.md'), new Date(0), new Date(0))
  }
  if (mode === 'foreign-exec-config') {
    git(root, 'config', 'filter.unsafe.smudge', `touch '${marker}' && cat`)
    git(root, 'config', 'core.hooksPath', join(f.commonDir, 'hooks'))
    writeFileSync(join(f.commonDir, 'hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  }
  const indexPath = resolve(root, git(root, 'rev-parse', '--git-path', 'index'))
  const index = readFileSync(indexPath)
  const observe = () => readStoppedPhysicalDraft(f.commonDir, root, seed, binding, { allowCommitted: true })
  let indexReads = 0
  const late = mode === 'late-source-bytes' || mode === 'late-source-mode'
  if (late) {
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
      if (args[0] === indexPath && ++indexReads === 2) {
        const file = join(root, 'source.mjs')
        if (mode === 'late-source-bytes') writeFileSync(file, 'late unauthorized source')
        else chmodSync(file, 0o755)
      }
      return read(...args)
    })
    syncBuiltinESMExports()
  }
  try {
    if (['canonical', 'payload', 'payload-link', 'foreign-exec-config'].includes(mode)) assert.equal(observe()?.source, source)
    else assert.throws(observe, /越界变化/)
  } finally {
    if (late) { t.mock.restoreAll(); syncBuiltinESMExports() }
  }
  if (late) assert.equal(indexReads, 2)
  assert.equal(existsSync(marker), false)
  assert.deepEqual(readFileSync(indexPath), index)
})

for (const mode of ['clean', 'ignored', 'ignored-foreign-draft', 'untracked', 'hidden-source', 'hidden-draft', 'wrong-index', 'committed-source', 'binary', 'unchanged'] as const) test(`stopped committed draft opt-in: ${mode}`, t => {
  const f = fixture(t), ownerDigest = 'd'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [{ path: path.replace('.json', '.schema.json'), source: schema }]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit)
  const source = '{未批准的真实已提交草稿', ordinaryIgnored = mode === 'ignored' || mode === 'ignored-foreign-draft'
  if (ordinaryIgnored) {
    writeFileSync(join(f.root, '.git/info/exclude'), '/runtime-cache/\n/.spex-sync-drafts/foreign.json\n')
    mkdirSync(join(f.root, 'runtime-cache')); writeFileSync(join(f.root, 'runtime-cache/entry'), 'ignored')
  }
  if (mode !== 'unchanged') {
    writeFileSync(join(f.root, path), mode === 'binary' ? Buffer.from([0xff, 0x00]) : source)
    git(f.root, 'add', path)
    if (mode === 'committed-source') { writeFileSync(join(f.root, 'source.mjs'), 'outside draft scope'); git(f.root, 'add', 'source.mjs') }
    git(f.root, 'commit', '-m', 'normal draft progress before Native stop')
  }
  if (mode === 'ignored-foreign-draft') writeFileSync(join(f.root, '.spex-sync-drafts/foreign.json'), 'unauthorized')
  if (mode === 'untracked') writeFileSync(join(f.root, 'untracked.test.mjs'), 'unauthorized')
  if (mode === 'hidden-source' || mode === 'hidden-draft') {
    const changed = mode === 'hidden-source' ? 'source.mjs' : path
    git(f.root, 'update-index', '--assume-unchanged', changed)
    writeFileSync(join(f.root, changed), 'hidden change')
  }
  if (mode === 'wrong-index') {
    writeFileSync(join(f.root, path), 'different staged draft'); git(f.root, 'add', path)
    writeFileSync(join(f.root, path), source)
  }
  const head = git(f.root, 'rev-parse', 'HEAD'), tree = git(f.root, 'rev-parse', 'HEAD^{tree}'), index = readFileSync(join(f.root, '.git/index'))
  const observe = () => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding, { allowCommitted: true })
  if (mode === 'clean' || mode === 'ignored') {
    if (mode === 'clean') assert.equal(readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), null)
    else assert.throws(() => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), /越界变化/)
    assert.deepEqual(observe(), { source, observedHeadCommit: head, observedTree: tree, indexSha256: contentHash(index), committedOid: git(f.root, 'rev-parse', `HEAD:${path}`) })
  } else if (mode === 'unchanged') assert.equal(observe(), null)
  else if (mode === 'wrong-index') assert.equal(observe()?.committedOid, undefined, '仅本稿暂存的物理路径仍无已提交角色')
  else assert.throws(observe, /越界变化/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head)
})

for (const kind of ['untracked', 'tracked', 'staged'] as const) test(`stopped physical draft与普通ignored缓存并存，只读保存原bytes，不授clean交付 kind=${kind}`, t => {
  const f = fixture(t), ownerDigest = 'a'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{"type":"object"}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [{ path: path.replace('.json', '.schema.json'), source: schema }, { path: path.replace('.json', '.context.json'), source: '{"readonly":true}' }, ...(kind === 'tracked' ? [{ path, source: '{EARLIER' }] : [])]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit)
  writeFileSync(join(f.root, '.git/info/exclude'), '/runtime-cache/\n')
  mkdirSync(join(f.root, 'runtime-cache')); writeFileSync(join(f.root, 'runtime-cache/retained'), 'ignored cache is not draft material')
  const source = '{INVALID_JSON原文\n'; writeFileSync(join(f.root, path), source)
  if (kind === 'staged') { git(f.root, 'add', path); writeFileSync(join(f.root, path), source + '未暂存的最新正文') }
  const bytes = readFileSync(join(f.root, path)), index = readFileSync(join(f.root, '.git/index'))
  const statusArgs = ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']
  const status = git(f.root, ...statusArgs)
  assert.throws(() => nativeWorktreeResult(f.root, seed), { code: 'native_worktree_result_invalid' })
  const material = readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding)!
  assert.deepEqual(material, { source: bytes.toString('utf8'), observedHeadCommit: seed.baseCommit, observedTree: seed.tree, indexSha256: contentHash(index) })
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.deepEqual(readFileSync(join(f.root, path)), bytes); assert.equal(git(f.root, 'rev-parse', 'HEAD'), seed.baseCommit)
  assert.equal(git(f.root, ...statusArgs), status)
  assert.equal(readFileSync(join(f.root, 'runtime-cache/retained'), 'utf8'), 'ignored cache is not draft material')
})

for (const defect of ['source', 'test', 'schema', 'context', 'absence', 'index', 'hidden-source', 'mode', 'symlink', 'ignored-namespace', 'ignored-foreign-draft', 'ignored-foreign-sidecar', 'ignored-foreign-case'] as const) test(`stopped physical draft不豁免其他文件/index对象与absence defect=${defect}`, t => {
  const f = fixture(t), ownerDigest = 'b'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [{ path: path.replace('.json', '.schema.json'), source: schema }, { path: path.replace('.json', '.context.json'), source: '{}' }]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit); writeFileSync(join(f.root, path), '{partial')
  const foreign = defect === 'ignored-foreign-draft' ? '.spex-sync-drafts/foreign.json' : defect === 'ignored-foreign-sidecar' ? '.spex-sync-drafts/foreign.schema.json' : defect === 'ignored-foreign-case' ? '.SPEX-SYNC-DRAFTS/foreign.context.json' : null
  writeFileSync(join(f.root, '.git/info/exclude'), ['/runtime-cache/', ...(foreign ? [`/${foreign}`, `/${foreign.toLowerCase()}`] : []), ...(defect === 'ignored-namespace' ? ['/.spex-sync-drafts/'] : [])].join('\n') + '\n')
  mkdirSync(join(f.root, 'runtime-cache')); writeFileSync(join(f.root, 'runtime-cache/retained'), 'ordinary ignored cache')
  if (foreign) { mkdirSync(join(f.root, foreign, '..'), { recursive: true }); writeFileSync(join(f.root, foreign), 'unauthorized ignored draft material') }
  const protectedPath = defect === 'test' ? 'oracle.test.mjs' : defect === 'schema' ? path.replace('.json', '.schema.json') : defect === 'context' ? path.replace('.json', '.context.json') : defect === 'absence' ? 'unexpected.test.mjs' : 'source.mjs'
  if (defect === 'mode') chmodSync(join(f.root, protectedPath), 0o755)
  else if (defect === 'symlink') { rmSync(join(f.root, path)); symlinkSync('source.mjs', join(f.root, path)) }
  else if (!defect.startsWith('ignored-')) {
    const original = defect === 'index' ? readFileSync(join(f.root, protectedPath)) : undefined
    if (defect === 'hidden-source') git(f.root, 'update-index', '--assume-unchanged', protectedPath)
    writeFileSync(join(f.root, protectedPath), 'unauthorized')
    if (defect === 'index') { git(f.root, 'add', protectedPath); writeFileSync(join(f.root, protectedPath), original!) }
  }
  const index = readFileSync(join(f.root, '.git/index'))
  assert.throws(() => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), /越界变化/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
})

for (const mode of ['absent', 'seed-draft', 'hidden-source', 'index', 'ignored-draft', 'ignored-draft-symlink', 'ignored-foreign-draft', 'ignored-foreign-sidecar', 'ignored-foreign-case', 'parent-symlink', 'source-parent-symlink', 'dirty-source', 'dirty-draft', 'committed-draft'] as const) test(`stopped worktree ignored-only no-material boundary: ${mode}`, t => {
  const f = fixture(t), ownerDigest = 'c'.repeat(64), path = `.spex-sync-drafts/${ownerDigest}.json`, schema = '{"type":"object"}'
  const binding = { ownerDigest, path, sourceInputId: 'input', schemaDigest: contentHash(schema) }
  const seed = stageWorktree(f.commonDir, f.parent, overlayStageTree(f.commonDir, f.tree, [
    { path: path.replace('.json', '.schema.json'), source: schema },
    { path: path.replace('.json', '.context.json'), source: '{"readonly":true}' },
    ...(mode === 'seed-draft' ? [{ path, source: '{"original":"immutable"}' }] : []),
    ...(mode === 'source-parent-symlink' ? [{ path: 'src/nested.mjs', source: 'export const value = 1\n' }] : []),
  ]), 'edit')
  git(f.root, 'checkout', '--detach', seed.baseCommit)
  const foreign = mode === 'ignored-foreign-draft' ? '.spex-sync-drafts/foreign.json' : mode === 'ignored-foreign-sidecar' ? '.spex-sync-drafts/foreign.schema.json' : mode === 'ignored-foreign-case' ? '.SPEX-SYNC-DRAFTS/foreign.context.json' : null
  const ignored = ['/runtime-cache/']
  if (mode.startsWith('ignored-draft')) ignored.push(`/${path}`)
  if (foreign) ignored.push(`/${foreign}`, `/${foreign.toLowerCase()}`)
  if (mode === 'parent-symlink') ignored.push('/.spex-sync-drafts')
  if (mode === 'source-parent-symlink') ignored.push('/src')
  writeFileSync(join(f.root, '.git/info/exclude'), ignored.join('\n') + '\n')
  mkdirSync(join(f.root, 'runtime-cache'))
  writeFileSync(join(f.root, 'runtime-cache/retained'), 'ignored run cache')
  if (foreign) {
    mkdirSync(join(f.root, foreign, '..'), { recursive: true })
    writeFileSync(join(f.root, foreign), '{"unauthorized":"different owner"}')
  }
  if (mode === 'hidden-source') git(f.root, 'update-index', '--assume-unchanged', 'source.mjs')
  if (mode === 'hidden-source' || mode === 'index' || mode === 'dirty-source') {
    writeFileSync(join(f.root, 'source.mjs'), 'unauthorized change\n')
    if (mode === 'index') { git(f.root, 'add', 'source.mjs'); writeFileSync(join(f.root, 'source.mjs'), 'export const value = 1\n') }
  }
  if (mode === 'ignored-draft' || mode === 'dirty-draft' || mode === 'committed-draft') writeFileSync(join(f.root, path), '{"unauthorized":"new"}')
  if (mode === 'ignored-draft-symlink') symlinkSync('../source.mjs', join(f.root, path))
  if (mode === 'parent-symlink') {
    git(f.root, 'update-index', '--assume-unchanged', path.replace('.json', '.schema.json'), path.replace('.json', '.context.json'))
    renameSync(join(f.root, '.spex-sync-drafts'), join(f.root, 'runtime-cache/drafts'))
    symlinkSync('runtime-cache/drafts', join(f.root, '.spex-sync-drafts'))
  }
  if (mode === 'source-parent-symlink') {
    git(f.root, 'update-index', '--assume-unchanged', 'src/nested.mjs')
    renameSync(join(f.root, 'src'), join(f.root, 'runtime-cache/source'))
    symlinkSync('runtime-cache/source', join(f.root, 'src'))
  }
  if (mode === 'committed-draft') { git(f.root, 'add', path); git(f.root, 'commit', '-m', 'real draft progress') }
  const ordinary = git(f.root, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all')
  const strict = git(f.root, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored')
  const visibleChange = ['index', 'dirty-source', 'dirty-draft'].includes(mode)
  assert.equal(ordinary.length > 0, visibleChange)
  assert.equal(strict.split('\0').filter(Boolean).every(row => row.startsWith('!! ')), !visibleChange)
  if (foreign) assert(strict.split('\0').some(row => row.toLowerCase() === `!! ${foreign.toLowerCase()}`))
  const index = readFileSync(join(f.root, '.git/index'))
  const head = git(f.root, 'rev-parse', 'HEAD')
  if (mode === 'absent' || mode === 'seed-draft') assert.equal(readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), null)
  else if (mode === 'dirty-draft') assert.deepEqual(readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), {
    source: readFileSync(join(f.root, path), 'utf8'), observedHeadCommit: seed.baseCommit, observedTree: seed.tree, indexSha256: contentHash(index),
  })
  else assert.throws(() => readStoppedPhysicalDraft(f.commonDir, f.root, seed, binding), /越界变化/)
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index)
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head)
})

test('精确阶段tree含受控raw/已审overlay并隔离后续index和WIP；同树同seed、异树不同身份', t => {
  const f = fixture(t), controlled = overlayStageTree(f.commonDir, f.tree, [{ path: 'spec.md', source: '真实受控raw\n' }])
  const seed = stageWorktree(f.commonDir, f.parent, controlled)
  writeFileSync(join(f.root, 'source.mjs'), 'later index\n'); git(f.root, 'add', 'source.mjs'); writeFileSync(join(f.root, 'source.mjs'), 'later WIP\n')
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.parent)
  assert.equal(git(f.root, 'show', `${seed.baseCommit}:spec.md`), '真实受控raw')
  assert.equal(git(f.root, 'show', `${seed.baseCommit}:source.mjs`), 'export const value = 1')
  assert.equal(git(f.root, 'show', '-s', '--format=%P', seed.baseCommit), f.parent)
  assert.equal(objectGit(f.commonDir, ['rev-parse', `refs/spex-sync/seeds/${seed.baseCommit}`]).toString().trim(), seed.baseCommit)
  assert.deepEqual(stageWorktree(f.commonDir, f.parent, controlled), seed)
  assert.notEqual(stageWorktree(f.commonDir, f.parent, f.tree).baseCommit, seed.baseCommit)
  assert.equal(verifyStageResult(f.commonDir, seed, result(seed)).tree, controlled)
})

test('actualdiff只从真实不可变对象导入；前摘要/mode取原树，冷恢复不要求历史WT存在', t => {
  const f = fixture(t), approved = overlayStageTree(f.commonDir, f.tree, [{ path: 'spec.md', source: '已审Spec\n' }]), seed = stageWorktree(f.commonDir, f.parent, approved, 'edit')
  const after = overlayStageTree(f.commonDir, approved, [{ path: 'source.mjs', source: 'export const value = 2\n' }])
  const head = stageWorktree(f.commonDir, seed.baseCommit, after).baseCommit, actual = result(seed, head, after)
  const imported = importStageChanges(f.commonDir, seed, actual, f.tree, [])
  const original = readTree(f.commonDir, f.tree).find(entry => entry.path === 'source.mjs')!
  assert.deepEqual(imported.changes, [{ path: 'source.mjs', beforeDigest: original.digest, beforeMode: original.mode, content: 'export const value = 2\n', mode: '100644' }])
  assert.equal(readObject(f.commonDir, readTree(f.commonDir, after).find(entry => entry.path === 'spec.md')!.oid).toString(), '已审Spec\n')
  assert.throws(() => importStageChanges(f.commonDir, seed, { ...actual, worktree: { ...actual.worktree!, baseTree: f.tree } }, f.tree, []), /固定seed/)
  assert.throws(() => importStageChanges(f.commonDir, seed, { ...actual, worktree: { ...actual.worktree!, tree: f.tree } }, f.tree, []), /真实HEAD tree/)
  assert.throws(() => verifyStageResult(f.commonDir, { ...seed, mode: 'read' }, actual), /只读阶段/)
})

test('真实diff的不可改oracle/host-private和非UTF8修改都拒绝', t => {
  const f = fixture(t), seed = stageWorktree(f.commonDir, f.parent, f.tree, 'edit')
  for (const path of ['oracle.test.mjs', '.env']) {
    const tree = overlayStageTree(f.commonDir, f.tree, [{ path, source: 'mutated\n' }]), head = stageWorktree(f.commonDir, seed.baseCommit, tree).baseCommit
    assert.throws(() => importStageChanges(f.commonDir, seed, result(seed, head, tree), f.tree, ['oracle.test.mjs']), /禁止路径/)
  }
  const entries = readTree(f.commonDir, f.tree).map(entry => entry.path === 'source.mjs' ? { ...entry, oid: writeObject(f.commonDir, Buffer.from([255, 254])), digest: contentHash(Buffer.from([255, 254])) } : entry)
  const binaryTree = writeTree(f.commonDir, entries), binaryHead = stageWorktree(f.commonDir, seed.baseCommit, binaryTree).baseCommit
  assert.throws(() => importStageChanges(f.commonDir, seed, result(seed, binaryHead, binaryTree), f.tree, []), /不是UTF8文本/)
})

test('新workflow明确选择真实CLI；旧缺省模型身份不变且不fallback', () => {
  assert.equal(syncModel({}), DEFAULT_SYNC_MODEL)
  assert.equal(syncModel({}, true), 'claude:default')
  assert.equal(syncModel({ model: 'zcode:team/model:preview' }, true), 'zcode:team/model:preview')
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:default'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('zcode:default'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:team/model:preview[1m]'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('claude:MiniMax-M3.1-Flash'))
  assert.doesNotThrow(() => assertWorktreeSyncModel('zcode:bigmodel-api/GLM-5.3-Flash'))
  assert.throws(() => assertWorktreeSyncModel(DEFAULT_SYNC_MODEL), { code: 'unsupported' })
})

test('native P1将已审祖先overlay和当前Spec候选分别绑定真实只读seed', async t => {
  const { cpSync, readFileSync } = await import('node:fs'), { captureInputSnapshot } = await import('./snapshot.js'), { elaborate, elaborationDigest } = await import('./elaboration.js'), { ELABORATION_BOUNDARIES } = await import('./elaboration-types.js'), { parseParts } = await import('@spexcode/spec-core/contracts')
  const f = fixture(t), path = '.spec/export/export-contract/spec.md'
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), f.root, { recursive: true })
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'business fixture')
  const snapshot = await captureInputSnapshot(f.root), source = readFileSync(join(f.root, path), 'utf8'), ancestor = '---\ntitle: 上层接口\n---\n## raw source\n已审祖先原意\n\n## expanded spec\n已审祖先接口\n', calls: { purpose: string; tree: string; source: string }[] = []
  const result = await elaborate({ root: f.root, base: snapshot.headCommit, worktree: stageWorktree(f.commonDir, snapshot.headCommit, snapshot.immutableTree), historyInput: snapshot, requestKey: 'native-p1', intent: { nodeId: 'export-contract', rawSource: parseParts(source)!.rawSource! }, targets: [{ nodeId: 'export-contract', path, source, sourceDigest: elaborationDigest(source) }], context: [{ nodeId: 'ancestor', path: '.spec/ancestor/spec.md', source: ancestor }], files: new Map(), maxRepairs: 0, model: 'claude:MiniMax-M3.1-Flash' }, { runner: async request => {
    assert.ok(request.worktree); assert.equal(request.worktree.mode, 'read'); assert.doesNotMatch(request.prompt, /冻结业务输入|bodyRef|spex_read_frozen/)
    assert.equal(git(f.root, 'show', `${request.worktree.baseCommit}:.spec/ancestor/spec.md`), ancestor.trim())
    calls.push({ purpose: request.purpose, tree: request.worktree.tree, source: git(f.root, 'show', `${request.worktree.baseCommit}:${path}`) })
    const output = request.purpose === 'elaboration_generate' ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '沿用已审导出契约边界', affectedIds: [] })) } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `p1-${calls.length}`, threadId: `p1-thread-${calls.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  } })
  assert.equal(result.reviewPassed, true, JSON.stringify({ failure: result.failure, rounds: result.rounds.map(round => round.findings) }))
  assert.deepEqual(calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.equal(calls[1].source, result.changes.find(change => change.path === path)!.source.trim())
})
