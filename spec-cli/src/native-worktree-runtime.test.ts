import test from 'node:test'
import assert from 'node:assert/strict'
import { StructuredSessionError, structuredExecutionPolicy, structuredRealmRoot, type StructuredExecution } from './session-structured-policy.js'
import childProcess, { ChildProcess, execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { hostProcessAdapter, processStartToken, writeDetachedRuntimeReceipt } from '@spexcode/spec-core'
import { assertNativeWorktreeSeed, assertNativeWorktreeResult, nativeWorktreeResult, nativeWorktreePrompt, sampleNativeWorktreeProcesses, nativeWorktreeProcessesStopped, classifyNativeWorktreeOrphans } from './native-worktree-runtime.js'
import { claudeWorktreeArgs, claudeStructuredArgs, claudeStructuredTurn, observeClaudeWorktreeMissingFinal, stopClaudeStructuredTurn } from './claude-structured.js'
import { zcodeWorktreePermission, zcodeWorktreeConfiguration, zcodeRuntimeConfiguration, zcodeStructuredTurn, zcodeCapability, zcodeNativeSelection, type ZCodeStructuredExecution } from './zcode-structured.js'
import { spawnSync } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
const seed = { baseCommit: 'a'.repeat(40), tree: 'b'.repeat(40), mode: 'edit' as const }
const request = { schema: { type: 'object' }, inputDigest: 'input', purpose: 'worktree-test', timeoutMs: null, model: 'claude:MiniMax-M3.1-Flash', worktree: seed }

function controlledCwdProbe(t: test.TestContext, slow: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spex-controlled-cwd-'))), platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const execute = childProcess.execFile, executeSync = childProcess.spawnSync, launch = childProcess.spawn, kill = process.kill
  const census = `${process.getuid!()} 999991 1 Mon Nov 9 00:00:00 2026\n`, cwd = `p999991\nn${root}\n`, probePid = 999993
  writeFileSync(join(root, 'process-baseline.json'), '[]'); writeFileSync(join(root, 'owned-processes.json'), '[]')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  let probeStarted!: () => void
  const ready = new Promise<void>(resolve => { probeStarted = resolve })
  let probeClosed!: () => void
  const closed = new Promise<void>(resolve => { probeClosed = resolve })
  let probes = 0, active = 0, maximum = 0, late: (() => void) | undefined, groupPresent = true, unreferenced = false
  const signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = []
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== undefined && signal !== 0) signals.push({ pid, signal })
    if (pid !== -probePid) return kill(pid, signal)
    if (signal === 0) { if (groupPresent) return true; throw Object.assign(new Error('synthetic group gone'), { code: 'ESRCH' }) }
    return true
  })
  t.mock.method(childProcess, 'spawnSync', (file: string) => executeSync(process.execPath, ['-e', `${file.endsWith('lsof') && slow ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,350);' : ''}process.stdout.write(${JSON.stringify(file.endsWith('lsof') ? cwd : census)})`], { encoding: 'utf8' }))
  t.mock.method(childProcess, 'spawn', (file: string, args: string[], options: SpawnOptions) => {
    if (!['/bin/ps', '/usr/sbin/lsof'].includes(file)) return launch(file, args, options)
    if (file.endsWith('lsof')) {
      assert.deepEqual(args, ['-b', '-a', '-p', '999991', '-d', 'cwd', '-Fn'], 'cwd查询只增加-b并保留精确PID/descriptor/输出范围')
      probes++; active++; maximum = Math.max(maximum, active)
      if (!slow && probes === 1) {
        const child = new ChildProcess()
        Object.defineProperty(child, 'pid', { value: probePid })
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
        child.unref = () => { unreferenced = true }
        late = () => { active--; child.stdout!.emit('data', Buffer.from(cwd)); child.emit('close', 0, null); probeClosed() }
        probeStarted()
        return child
      }
    }
    const child = launch(process.execPath, ['-e', `${file.endsWith('lsof') ? 'setTimeout(()=>process.stdout.write(' + JSON.stringify(cwd) + '),350)' : 'process.stdout.write(' + JSON.stringify(census) + ')'}`], options)
    if (file.endsWith('lsof')) { probeStarted(); child.once('close', () => { active--; probeClosed() }) }
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { groupPresent = false; late?.(); t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, 'platform', platform); rmSync(root, { recursive: true, force: true }) })
  return { plan: { root, receiptFile: join(root, 'process.json') }, execute, ready, closed, parentClosed: () => { const close = late; late = undefined; close?.() }, groupGone: () => { groupPresent = false }, state: () => ({ probes, maximum, signals, unreferenced }) }
}

test('slow cwd observation yields heartbeat, asynchronous Git and cancellation callbacks', async t => {
  const f = controlledCwdProbe(t, true), controller = new AbortController()
  let ticks = 0, gitFinished = false
  const heartbeat = setInterval(() => { ticks++ }, 5), cancel = setTimeout(() => controller.abort(), 20)
  const gitFinishedPromise = new Promise<void>((resolve, reject) => f.execute('git', ['--version'], { encoding: 'utf8' }, error => { if (error) reject(error); else { gitFinished = true; resolve() } }))
  try {
    const observation = await classifyNativeWorktreeOrphans(f.plan)
    assert.equal(observation.pending.length, 1)
    assert.ok(ticks > 0, 'cwd观察期间必须让心跳执行')
    assert.equal(gitFinished, true, '快速异步Git回调不能等cwd探针返回')
    assert.equal(controller.signal.aborted, true, '取消/创建预算timer必须在探针期间响应')
  } finally { clearInterval(heartbeat); clearTimeout(cancel); await gitFinishedPromise }
})

test('cwd deadline rejects without close and keeps probe debt until the actual close', async t => {
  const f = controlledCwdProbe(t, false)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const flight = classifyNativeWorktreeOrphans(f.plan), rejected = assert.rejects(flight, { code: 'cancellation_pending' })
  await f.ready
  t.mock.timers.tick(10_000)
  await rejected
  assert.deepEqual(f.state().signals, [{ pid: -999993, signal: 'SIGKILL' }]); assert.equal(f.state().unreferenced, true)
  await assert.rejects(Promise.resolve().then(() => classifyNativeWorktreeOrphans(f.plan)), { code: 'cancellation_pending' })
  assert.equal(f.state().probes, 1, '未close的探针不得叠加新进程')
  assert.equal(existsSync(join(f.plan.root, 'task-related-processes.json')), false, '超时不能伪造正向关联或停止收据')
  f.parentClosed()
  await assert.rejects(Promise.resolve().then(() => classifyNativeWorktreeOrphans(f.plan)), { code: 'cancellation_pending' })
  assert.equal(f.state().probes, 1, '仅父close不能清除仍存helper的组债务')
  assert.equal(f.state().signals.length, 1, '后续只读观察不能补发任何信号')
  f.groupGone()
  assert.equal((await classifyNativeWorktreeOrphans(f.plan)).pending.length, 1, '自有probe整组确证gone后可以重新真实观察')
  assert.equal(f.state().maximum, 1)
})

test('same-root sampling, classification and final stop serialize and preserve sticky evidence', async t => {
  const f = controlledCwdProbe(t, true), plan = { ...f.plan, pid: 999992 }
  const sampling = sampleNativeWorktreeProcesses(plan), inspection = classifyNativeWorktreeOrphans(plan), stopping = nativeWorktreeProcessesStopped(plan)
  await sampling
  const original = readFileSync(join(plan.root, 'task-related-processes.json'))
  assert.equal((await inspection).pending.length, 1)
  assert.equal(await stopping, false, '未证实Native停止时不能释放容量或移除工作区')
  assert.equal(f.state().maximum, 1, '同root定时采样与finally/stop不能叠加探针')
  assert.equal(f.state().probes, 1, '已登记的正向关联粘性保留，不因后续读取重选cwd')
  assert.deepEqual(readFileSync(join(plan.root, 'task-related-processes.json')), original)
  await new Promise<void>(resolve => setTimeout(resolve, 400))
  assert.deepEqual(readFileSync(join(plan.root, 'task-related-processes.json')), original, '收尾后不能有迟到采样覆盖关联证据')
})

test('a short absolute stop deadline bounds an active probe without late evidence', async t => {
  const f = controlledCwdProbe(t, true), plan = { ...f.plan, pid: 999992 }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const flight = sampleNativeWorktreeProcesses(plan, Date.now() + 50), rejected = assert.rejects(flight, { code: 'cancellation_pending' })
  await f.ready
  t.mock.timers.tick(50)
  await rejected
  assert.equal(f.state().signals.length, 1); assert.equal(f.state().signals[0].signal, 'SIGKILL')
  assert.ok(f.state().signals[0].pid < 0, '只终止自有probe组，不按cwd发Native信号')
  const keepAlive = setInterval(() => {}, 5)
  try { await f.closed } finally { clearInterval(keepAlive) }
  assert.equal(existsSync(join(plan.root, 'task-related-processes.json')), false)
  assert.equal(existsSync(join(plan.root, 'process-stop-observations.jsonl')), false)
})

test('an expired queued stop cannot dispatch, signal or publish after the first sample settles', async t => {
  const f = controlledCwdProbe(t, true), plan = { ...f.plan, pid: 999992 }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const first = sampleNativeWorktreeProcesses(plan)
  await f.ready
  let settled = false
  const later = nativeWorktreeProcessesStopped(plan, true, Date.now() + 50), rejected = assert.rejects(later, { code: 'cancellation_pending' })
  first.then(() => { settled = true })
  t.mock.timers.tick(50)
  await rejected
  assert.equal(settled, false, '排队截止不能等前一个慢观察完成')
  await first
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.state().probes, 1); assert.deepEqual(f.state().signals, [])
  assert.equal(existsSync(join(plan.root, 'process-stop-observations.jsonl')), false, '过期排队stop不能迟到写停止证明')
})

test('native worktree uses independent policy and native realm without frozen reader', () => {
  const execution = structuredExecutionPolicy(request)
  assert.equal(execution.version, 6)
  assert.equal(execution.policy, 'native-worktree-v1')
  assert.deepEqual((execution as StructuredExecution & { worktree: unknown }).worktree, seed)
  assert.equal(structuredRealmRoot(execution, '/runtime'), '/runtime/structured-native-worktree-v1/claude')
})


const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const git = (root: string, args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'spex-native-worktree-')), repo = join(root, 'repo'), path = join(root, 'worktree')
  mkdirSync(repo)
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) git(repo, args)
  writeFileSync(join(repo, 'value'), 'seed\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'seed'])
  const seed = { baseCommit: git(repo, ['rev-parse', 'HEAD']), tree: git(repo, ['rev-parse', 'HEAD^{tree}']), mode: 'edit' as const }
  git(repo, ['worktree', 'add', '-qb', 'candidate', path, seed.baseCommit])
  return { root, repo, path, seed, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('seed excludes live HEAD, index and WIP; edit result requires a real clean descendant commit with hooks', () => {
  const f = repoFixture()
  try {
    writeFileSync(join(f.repo, 'value'), 'later HEAD\n'); git(f.repo, ['commit', '-am', 'later'])
    writeFileSync(join(f.repo, 'value'), 'later index\n'); git(f.repo, ['add', 'value']); writeFileSync(join(f.repo, 'value'), 'later WIP\n')
    assertNativeWorktreeSeed(f.repo, f.seed)
    assert.equal(readFileSync(join(f.path, 'value'), 'utf8'), 'seed\n')
    assert.throws(() => assertNativeWorktreeSeed(f.repo, { ...f.seed, baseCommit: 'HEAD' }), /immutable/)
    assert.throws(() => assertNativeWorktreeSeed(f.repo, { ...f.seed, tree: git(f.repo, ['rev-parse', 'HEAD^{tree}']) }), /identity/)
    writeFileSync(join(f.path, 'value'), 'candidate\n')
    assert.throws(() => nativeWorktreeResult(f.path, f.seed), /clean/)
    git(f.path, ['add', 'value'])
    const hook = join(f.repo, '.git/hooks/pre-commit'), marker = join(f.root, 'hook-ran')
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\nexit 1\n`); chmodSync(hook, 0o755)
    assert.throws(() => git(f.path, ['commit', '-qm', 'blocked']))
    assert(existsSync(marker)); assert.throws(() => nativeWorktreeResult(f.path, f.seed), /clean/)
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`)
    git(f.path, ['commit', '-qm', 'candidate'])
    const result = nativeWorktreeResult(f.path, f.seed)
    assert.equal(result.tree, git(f.path, ['rev-parse', 'HEAD^{tree}'])); assert.notEqual(result.headCommit, f.seed.baseCommit)
    assertNativeWorktreeResult(f.repo, f.seed, result)
    assert.throws(() => assertNativeWorktreeResult(f.repo, f.seed, { ...result, tree: f.seed.tree }), /identity/)
    git(f.repo, ['worktree', 'remove', f.path])
    assertNativeWorktreeResult(f.repo, f.seed, result)
    assert.equal(existsSync(f.path), false, 'completed cold result does not recreate a closed worktree')
  } finally { f.close() }
})

test('read mode requires unchanged seed and a clean index/worktree', () => {
  const f = repoFixture(), seed = { ...f.seed, mode: 'read' as const }
  try {
    assert.equal(nativeWorktreeResult(f.path, seed).tree, seed.tree)
    writeFileSync(join(f.path, 'untracked'), 'review mutation')
    assert.throws(() => nativeWorktreeResult(f.path, seed), /clean/)
    git(f.path, ['add', '.']); git(f.path, ['commit', '-qm', 'review mutation'])
    assert.throws(() => nativeWorktreeResult(f.path, seed), { code: 'native_worktree_result_invalid', message: /changed/ })
  } finally { f.close() }
})

test('edit HEAD outside seed ancestry remains a typed Git result failure', () => {
  const f = repoFixture()
  try {
    git(f.path, ['checkout', '--orphan', 'unrelated']); git(f.path, ['add', '.']); git(f.path, ['commit', '-qm', 'unrelated root'])
    assert.equal(git(f.path, ['status', '--porcelain']), '')
    assert.throws(() => nativeWorktreeResult(f.path, f.seed), { code: 'native_worktree_result_invalid', message: /not a descendant/ })
  } finally { f.close() }
})

test('read Git alias probe is a typed invalid result and preserves the actual HEAD/index/worktree', () => {
  const f = repoFixture(), seed = { ...f.seed, mode: 'read' as const }, copy = join(f.root, 'copied-worktree')
  try {
    cpSync(f.path, copy, { recursive: true })
    writeFileSync(join(copy, 'probe'), 'experimental spec draft\n'); git(copy, ['add', 'probe']); git(copy, ['commit', '-qm', 'probe'])
    writeFileSync(join(copy, 'staged-probe'), 'uncommitted experiment\n'); git(copy, ['add', 'staged-probe'])
    const head = git(f.path, ['rev-parse', 'HEAD']), status = git(f.path, ['status', '--porcelain=v1', '--untracked-files=all'])
    const index = readFileSync(git(f.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
    assert.notEqual(head, seed.baseCommit); assert.match(status, /probe/)
    assert.throws(() => nativeWorktreeResult(f.path, seed), error => {
      assert.equal((error as { code: string }).code, 'native_worktree_result_invalid')
      const message = (error as Error).message
      for (const value of [seed.baseCommit, seed.tree, head, status, f.path]) assert(message.includes(value) || message.includes(JSON.stringify(value).slice(1, -1)), value)
      assert.match(message, /independent.*Git|独立.*Git/)
      return true
    })
    assert.equal(git(f.path, ['rev-parse', 'HEAD']), head); assert.equal(git(f.path, ['status', '--porcelain=v1', '--untracked-files=all']), status)
    assert.deepEqual(readFileSync(git(f.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])), index)
    assert.equal(readFileSync(join(copy, 'probe'), 'utf8'), 'experimental spec draft\n')
    assert.throws(() => assertNativeWorktreeSeed(f.path, { ...seed, tree: 'f'.repeat(40) }), { code: 'failed' })
    assert.throws(() => assertNativeWorktreeResult(f.repo, seed, { baseCommit: seed.baseCommit, baseTree: seed.tree, headCommit: head, tree: git(f.path, ['rev-parse', 'HEAD^{tree}']), worktreePath: f.path }), { code: 'stale_result' })
  } finally { f.close() }
})

test('normal worktree capabilities and prompt remain distinct from the frozen reader', () => {
  const args = claudeWorktreeArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: { type: 'object' } })
  assert.equal(args.includes('--restricted'), false); assert.equal(args.includes('--tools'), false); assert.equal(args.includes('--allowedTools'), false)
  assert.equal(args.includes('--json-schema'), true)
  const readArgs = claudeWorktreeArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: {}, mode: 'read' })
  assert.equal(readArgs[readArgs.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Read', input: { file_path: '/any/context' } }, 'session', '/worktree', 'read'), 'allow')
  assert.equal(zcodeWorktreePermission({ sessionId: 'foreign', toolName: 'Bash' }, 'session', '/worktree', 'edit'), 'deny')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: 'src/file.ts' } }, 'session', '/worktree', 'read'), 'deny')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: 'src/file.ts' } }, 'session', '/worktree', 'edit'), 'allow')
  assert.equal(zcodeWorktreePermission({ sessionId: 'session', toolName: 'Edit', input: { file_path: '../outside' } }, 'session', '/worktree', 'edit'), 'deny')
  const old = claudeStructuredArgs({ sessionId: 'session', model: 'MiniMax-M3.1-Flash', schema: {}, mcpConfig: '/frozen' })
  assert(old.includes('--restricted')); assert(old.includes('--tools')); assert(old.includes('--allowedTools'))
  assert.equal((zcodeRuntimeConfiguration().features as { mcp: boolean }).mcp, true)
  assert.equal((zcodeWorktreeConfiguration().features as { mcp: boolean }).mcp, false)
  assert.equal(nativeWorktreePrompt('unchanged task', seed), nativeWorktreePrompt('unchanged task', seed))
  assert(nativeWorktreePrompt('unchanged task', seed).includes('git commit with hooks enabled'))
  for (const model of ['claude:MiniMax-M3.1-Flash', 'zcode:bigmodel-api/GLM-5.3-Flash']) for (const timeoutMs of [null, 1000]) {
    const policy = structuredExecutionPolicy({ ...request, model, timeoutMs })
    assert.equal(policy.version, 6); assert.equal(policy.frozenContext, undefined); assert.equal(policy.readerRuntime, undefined)
    assert.notEqual(hash(policy), hash(structuredExecutionPolicy({ ...request, model, timeoutMs, worktree: { ...seed, baseCommit: 'c'.repeat(40) } })))
  }
  assert.throws(() => structuredExecutionPolicy({ ...request, model: 'gpt-default' }), /explicit/)
})

async function deadProcess(root: string) {
  await sampleNativeWorktreeProcesses({ root, receiptFile: join(root, 'process.json') })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  assert(child.pid)
  const exited = new Promise<void>(resolve => child.once('close', () => resolve())), receiptFile = join(root, 'process.json')
  const identity = writeDetachedRuntimeReceipt(child.pid, receiptFile)
  writeFileSync(join(root, 'owned-processes.json'), JSON.stringify([{ pid: child.pid, startToken: identity.startToken.replace(/\s+/g, ' ') }]))
  process.kill(-child.pid, 'SIGTERM'); await exited
  return { pid: child.pid, receiptFile }
}
const noDispatch = { onThread: async (): Promise<void> => assert.fail('cold replay cannot create thread'), onTurn: async (): Promise<void> => assert.fail('cold replay cannot send turn'), onNative: async (): Promise<void> => assert.fail('cold replay cannot launch CLI') }

test('Claude worktree cold completion binds native user/model/exit and never borrows frozen proof', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native')
  mkdirSync(join(root, 'claude-home/projects/exact'), { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = nativeWorktreePrompt('read real files', { ...f.seed, mode: 'edit' }), output = { ok: true }
    const policy = structuredExecutionPolicy({ ...request, schema: { type: 'object', required: ['ok'] }, worktree: { ...f.seed, mode: 'edit' } })
    const native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', ...processIdentity }, execution: StructuredExecution = { ...policy, claudeNative: native, state: 'running' }
    const plan = { ...native, policyDigest: hash(policy), requestDigest: hash({ prompt, policy }), cliVersion: '2.1.309 (Claude Code)' }
    const echo = { uuid: 'user', session_id: 'session', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'launch.json': { cwd: f.path }, 'init.json': { session_id: 'session', model: 'MiniMax-M3.1-Flash', tools: ['Read', 'Bash', 'Edit', 'StructuredOutput'] }, 'user-echo.json': echo, 'result.json': { type: 'result', subtype: 'success', is_error: false, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'], structured_output: output }, 'exit.json': { code: 0, signal: null, stopped: true } })) writeFileSync(join(root, name), JSON.stringify(value))
    writeFileSync(join(root, 'claude-home/projects/exact/session.jsonl'), JSON.stringify({ type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message: echo.message }) + '\n')
    const savedResult = readFileSync(join(root, 'result.json'))
    const missing = { ...JSON.parse(savedResult.toString('utf8')) }; delete missing.structured_output
    writeFileSync(join(root, 'result.json'), JSON.stringify(missing))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path), error => {
      assert(error instanceof StructuredSessionError); assert.equal(error.code, 'structured_output_format_invalid')
      assert.equal(error.threadId, 'session'); assert.equal(error.turnId, 'user'); assert.equal(error.rejectedOutput, undefined)
      assert.match(error.message, /missing required structured_output/); assert.equal(existsSync(join(root, 'completed.json')), false)
      return true
    })
    const nativeFiles = ['plan.json', 'init.json', 'user-echo.json', 'result.json', 'exit.json', 'owned-processes.json']
    const beforeObservation = nativeFiles.map(name => readFileSync(join(root, name)))
    const observed = observeClaudeWorktreeMissingFinal(prompt, { ...execution, state: 'cancelled', threadId: 'session', turnId: 'user' }, f.path)
    assert.equal(observed.code, 'structured_output_format_invalid'); assert.equal(observed.rejectedOutput, undefined)
    assert.deepEqual(nativeFiles.map(name => readFileSync(join(root, name))), beforeObservation, '新观察不得补写旧adapter原件')
    for (const changed of [{ ...missing, session_id: 'foreign' }, { ...missing, user_message_uuid: 'foreign' }, { ...missing, user_message_uuids: ['foreign'] }, { ...missing, subtype: 'unknown' }, { ...missing, is_error: true }]) {
      writeFileSync(join(root, 'result.json'), JSON.stringify(changed))
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path), { code: 'stale_result' })
    }
    writeFileSync(join(root, 'result.json'), JSON.stringify(missing))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, { ...execution, state: 'completed' }, noDispatch, f.path), { code: 'stale_result' })
    for (const changed of [{ code: 1, signal: null, stopped: true }, { code: null, signal: 'SIGTERM', stopped: true }, { code: 0, signal: null, stopped: false }]) {
      writeFileSync(join(root, 'exit.json'), JSON.stringify(changed))
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path), { code: 'stale_result' })
    }
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: true }))
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ...JSON.parse(savedResult.toString('utf8')), structured_output: {} }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path), error => {
      assert(error instanceof StructuredSessionError); assert.equal(error.code, 'failed')
      assert.equal(error.rejectedOutput?.text, '{}'); assert.equal(error.rejectedOutput?.representation, 'native_json')
      assert.equal(existsSync(join(root, 'completed.json')), false)
      return true
    })
    writeFileSync(join(root, 'result.json'), savedResult)
    const result = await claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path)
    assert.equal(result.frozenReadProof, undefined); assert.deepEqual(JSON.parse(result.text), output)
    const completed = { ...execution, state: 'completed' as const, threadId: 'session', turnId: 'user', output, resultDigest: hash(output) }
    git(f.repo, ['worktree', 'remove', f.path])
    const kill = process.kill; let historicalProbes = 0
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === processIdentity.pid && signal === 0) { historicalProbes++; return true }
      return kill(pid, signal)
    }) as typeof process.kill
    try {
      assert.deepEqual(await claudeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), result)
      assert.equal(historicalProbes, 0, 'completed replay must not consult an unrelated reused PID/PGID')
      await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, { ...completed, state: 'running' }, noDispatch, f.path), { code: 'cancellation_pending' })
      assert(historicalProbes > 0, 'unsettled recovery must still consult the live native process identity')
    } finally { process.kill = kill }
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt + 'changed', completed, noDispatch, f.path), { code: 'stale_result' })
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ code: 0, signal: null, stopped: false }))
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
  } finally { f.close() }
})

test('ZCode worktree cold completion binds original send, model snapshot and exact terminal without MCP', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native'), runtime = join(root, 'runtime')
  mkdirSync(runtime, { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = 'Review normal worktree', output = { ok: true }, response = JSON.stringify(output)
    const policy = structuredExecutionPolicy({ ...request, schema: { type: 'object', required: ['ok'] }, model: 'zcode:bigmodel-api/GLM-5.3-Flash', effort: 'high', worktree: { ...f.seed, mode: 'read' } })
    const selection = zcodeNativeSelection(policy.model, policy.effort), nativePrompt = `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(policy.schema)}\n\n${prompt}`
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input', turnId: 'turn', ...processIdentity }
    const execution: ZCodeStructuredExecution = { ...policy, version: 6, policy: 'native-worktree-v1', zcodeNative: native, state: 'running', frozenReadProof: undefined }
    const modelSnapshot = { sessionId: 'session', model: selection.model, thoughtLevel: 'high' }
    const plan = { ...native, worktreeProcessBaseline: 1, queryId: 'query', runtime, workspace: f.path, ...selection, policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, modelSnapshotDigest: hash(modelSnapshot) }
    const events = [
      { type: 'turn.started', payload: { inputId: 'input', queryId: 'query', messageId: 'user' } },
      { type: 'session.updated', payload: { providerId: selection.model.providerId, modelId: selection.model.modelId, toolCount: 9 } },
      { type: 'tool.updated', payload: { kind: 'scheduled', toolName: 'Bash', toolCallId: 'normal' } },
      { type: 'turn.completed', payload: { inputId: 'input', resultType: 'success', response } },
    ].map((event, index) => ({ ...event, eventId: `event-${index}`, seq: index + 1, sessionId: 'session', turnId: 'turn' }))
    const messages = [
      { info: { id: 'user', sessionID: 'session', role: 'user', anchor: { turnId: 'turn' }, modelSelection: selection.model, semantics: { kind: 'user_prompt' } }, parts: [{ type: 'text', text: nativePrompt }] },
      { info: { id: 'final', sessionID: 'session', role: 'assistant', anchor: { turnId: 'turn' }, ...selection.model, semantics: { kind: 'assistant_response' } }, parts: [{ type: 'text', text: response }] },
    ]
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'model-snapshot.json': modelSnapshot, 'events.json': events, 'messages.json': messages, 'terminal.json': events.at(-1), 'exit.json': { code: 0, signal: null, stopped: true, idle: true, closed: true }, 'send.json': { sessionId: 'session', content: nativePrompt, inputId: 'input', modelSelection: selection.model } })) writeFileSync(join(root, name), JSON.stringify(value))
    const result = await zcodeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path)
    assert.deepEqual(JSON.parse(result.text), output); assert.equal(result.frozenReadProof, undefined)
    const completed = { ...execution, state: 'completed' as const, threadId: 'session', turnId: 'turn', output, resultDigest: hash(output) }
    git(f.repo, ['worktree', 'remove', f.path])
    const kill = process.kill; let historicalProbes = 0
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (Math.abs(pid) === processIdentity.pid && signal === 0) { historicalProbes++; return true }
      return kill(pid, signal)
    }) as typeof process.kill
    try {
      assert.deepEqual(await zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), result)
      assert.equal(historicalProbes, 0, 'completed replay must not consult an unrelated reused PID/PGID')
      await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, { ...completed, state: 'running' }, noDispatch, f.path), { code: 'cancellation_pending' })
      assert(historicalProbes > 0, 'unsettled recovery must still consult the live native process identity')
    } finally { process.kill = kill }
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, { ...completed, effort: undefined }, noDispatch, f.path), { code: 'stale_result' })
    writeFileSync(join(root, 'terminal.json'), JSON.stringify({ ...events.at(-1), turnId: 'foreign' }))
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
    const schemaInvalidEvents = structuredClone(events), schemaInvalidMessages = structuredClone(messages), schemaInvalidResponse = JSON.stringify({ wrong: true })
    schemaInvalidEvents.at(-1)!.payload.response = schemaInvalidResponse
    schemaInvalidMessages.at(-1)!.parts[0].text = schemaInvalidResponse
    writeFileSync(join(root, 'events.json'), JSON.stringify(schemaInvalidEvents)); writeFileSync(join(root, 'messages.json'), JSON.stringify(schemaInvalidMessages)); writeFileSync(join(root, 'terminal.json'), JSON.stringify(schemaInvalidEvents.at(-1)))
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
    const malformedEvents = structuredClone(events), malformedMessages = structuredClone(messages), malformedResponse = 'not one JSON document'
    malformedEvents.at(-1)!.payload.response = malformedResponse
    malformedMessages.at(-1)!.parts[0].text = malformedResponse
    writeFileSync(join(root, 'events.json'), JSON.stringify(malformedEvents)); writeFileSync(join(root, 'messages.json'), JSON.stringify(malformedMessages)); writeFileSync(join(root, 'terminal.json'), JSON.stringify(malformedEvents.at(-1)))
    const changedEvidence = ['events.json', 'messages.json', 'terminal.json'] as const
    const sha = (name: string): string => createHash('sha256').update(readFileSync(join(root, name))).digest('hex')
    const evidenceHashes = changedEvidence.map(name => [name, sha(name)] as const), completedCache = readFileSync(join(root, 'completed.json'))
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, completed, noDispatch, f.path), { code: 'stale_result' })
    assert.deepEqual(changedEvidence.map(name => [name, sha(name)]), evidenceHashes, 'completed replay must not rewrite original Native evidence')
    assert.deepEqual(readFileSync(join(root, 'completed.json')), completedCache, 'completed replay must preserve the original completed cache')
  } finally { f.close() }
})

test('ZCode authenticated worktree schema mismatch is typed for repair without publishing or changing Native evidence', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native'), runtime = join(root, 'runtime')
  mkdirSync(runtime, { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = 'Review normal worktree', output = { ids: ['outside-domain'] }, response = JSON.stringify(output)
    const schema = { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 0 } }, required: ['ids'], additionalProperties: false }
    const policy = structuredExecutionPolicy({ ...request, schema, model: 'zcode:bigmodel-api/GLM-5.3-Flash', effort: 'high', worktree: { ...f.seed, mode: 'read' } })
    const selection = zcodeNativeSelection(policy.model, policy.effort), nativePrompt = `Return exactly one JSON value matching this JSON Schema, without prose or Markdown: ${JSON.stringify(schema)}\n\n${prompt}`
    const native = { version: 1 as const, root, sessionId: 'session', inputId: 'input', turnId: 'turn', ...processIdentity }
    const execution: ZCodeStructuredExecution = { ...policy, version: 6, policy: 'native-worktree-v1', zcodeNative: native, state: 'running', frozenReadProof: undefined }
    const modelSnapshot = { sessionId: 'session', model: selection.model, thoughtLevel: 'high' }
    const plan = { ...native, worktreeProcessBaseline: 1, queryId: 'query', runtime, workspace: f.path, ...selection, policyDigest: hash(policy), requestDigest: hash({ prompt, nativePrompt, policy, selection }), cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, modelSnapshotDigest: hash(modelSnapshot) }
    const events = [
      { type: 'turn.started', payload: { inputId: 'input', queryId: 'query', messageId: 'user' } },
      { type: 'session.updated', payload: { providerId: selection.model.providerId, modelId: selection.model.modelId, toolCount: 9 } },
      { type: 'turn.completed', payload: { inputId: 'input', resultType: 'success', response } },
    ].map((event, index) => ({ ...event, eventId: `event-${index}`, seq: index + 1, sessionId: 'session', turnId: 'turn' }))
    const messages = [
      { info: { id: 'user', sessionID: 'session', role: 'user', anchor: { turnId: 'turn' }, modelSelection: selection.model, semantics: { kind: 'user_prompt' } }, parts: [{ type: 'text', text: nativePrompt }] },
      { info: { id: 'final', sessionID: 'session', role: 'assistant', anchor: { turnId: 'turn' }, ...selection.model, semantics: { kind: 'assistant_response' } }, parts: [{ type: 'text', text: response }] },
    ]
    const files = { 'plan.json': plan, 'model-snapshot.json': modelSnapshot, 'events.json': events, 'messages.json': messages, 'terminal.json': events.at(-1), 'exit.json': { code: 0, signal: null, stopped: true, idle: true, closed: true }, 'send.json': { sessionId: 'session', content: nativePrompt, inputId: 'input', modelSelection: selection.model } }
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value))
    const sha = (name: string): string => createHash('sha256').update(readFileSync(join(root, name))).digest('hex')
    const originalHashes = Object.keys(files).map(name => [name, sha(name)] as const)
    const requestTurn = () => zcodeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path)
    for (let replay = 0; replay < 2; replay++) await assert.rejects(requestTurn(), error => {
      assert(error instanceof StructuredSessionError)
      const failure = error
      assert.equal(failure.rejectedOutput?.text, response)
      assert.equal(failure.rejectedOutput?.sha256, createHash('sha256').update(response).digest('hex'))
      assert.equal(failure.code, 'structured_output_format_invalid')
      assert.match(failure.message ?? '', /"instancePath":"\/ids"/)
      assert.match(failure.message ?? '', /"keyword":"maxItems"/)
      assert.match(failure.message ?? '', /"limit":0/)
      assert(!failure.message?.includes(JSON.stringify(output)), 'diagnostics must not echo the invalid output')
      return true
    })
    assert.equal(existsSync(join(root, 'completed.json')), false, 'invalid schema output must not complete or publish')
    assert.deepEqual(Object.keys(files).map(name => [name, sha(name)]), originalHashes, 'cold failure replay must preserve every original Native file and send')

    const malformedEvents = structuredClone(events), malformedMessages = structuredClone(messages), malformedResponse = `{\n"payload":"${'x'.repeat(13200)}PRIVATE_DIAGNOSTIC_CANARY"\n"next":1\n}`
    malformedEvents.at(-1)!.payload.response = malformedResponse
    malformedMessages.at(-1)!.parts[0].text = malformedResponse
    writeFileSync(join(root, 'events.json'), JSON.stringify(malformedEvents)); writeFileSync(join(root, 'messages.json'), JSON.stringify(malformedMessages)); writeFileSync(join(root, 'terminal.json'), JSON.stringify(malformedEvents.at(-1)))
    const malformedHashes = Object.keys(files).map(name => [name, sha(name)] as const)
    for (let replay = 0; replay < 2; replay++) await assert.rejects(requestTurn(), error => {
      assert(error instanceof StructuredSessionError)
      assert.equal(error.code, 'structured_output_format_invalid')
      assert.equal(error.rejectedOutput?.text, malformedResponse)
      const message = (error as Error).message
      for (const value of ['"category":"expected_property_delimiter"', `"position":${malformedResponse.indexOf('"next"')}`, '"line":3', '"column":1']) assert(message.includes(value), value)
      assert(!message.includes('PRIVATE_DIAGNOSTIC_CANARY'))
      return true
    })
    assert.deepEqual(Object.keys(files).map(name => [name, sha(name)]), malformedHashes, 'large JSON syntax failures preserve original Native evidence and send')
    assert.equal(existsSync(join(root, 'completed.json')), false)
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value))

    for (const [name, value] of [
      ['plan.json', { ...plan, requestDigest: '0'.repeat(64) }],
      ['plan.json', { ...plan, inputId: 'foreign' }],
      ['send.json', { ...files['send.json'], content: nativePrompt + 'foreign owner' }],
      ['terminal.json', { ...events.at(-1), sessionId: 'foreign' }],
      ['terminal.json', { ...events.at(-1), payload: { ...events.at(-1)!.payload, resultType: 'cancelled' } }],
    ] as const) {
      writeFileSync(join(root, name), JSON.stringify(value))
      await assert.rejects(requestTurn(), error => { assert(!(error instanceof StructuredSessionError) || !error.rejectedOutput); return true })
      writeFileSync(join(root, name), JSON.stringify(files[name]))
    }
    await assert.rejects(zcodeStructuredTurn(realm, 'native', prompt, { ...execution, schema: { type: 'object', required: ['foreign'] } }, noDispatch, f.path), error => { assert(!(error instanceof StructuredSessionError) || !error.rejectedOutput); return true })
    rmSync(join(root, 'terminal.json'))
    await assert.rejects(requestTurn(), error => { assert(!(error instanceof StructuredSessionError) || !error.rejectedOutput); return true })
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(files['terminal.json']))
    writeFileSync(join(root, 'terminal.json'), JSON.stringify({ ...events.at(-1), turnId: 'foreign' }))
    await assert.rejects(requestTurn(), { code: 'stale_result' })
    writeFileSync(join(root, 'terminal.json'), JSON.stringify(events.at(-1)))
    writeFileSync(join(root, 'exit.json'), JSON.stringify({ ...files['exit.json'], stopped: false }))
    await assert.rejects(requestTurn(), { code: 'stale_result' })
    writeFileSync(join(root, 'exit.json'), JSON.stringify(files['exit.json']))
    assert.deepEqual(Object.keys(files).map(name => [name, sha(name)]), originalHashes)
    assert.equal(existsSync(join(root, 'completed.json')), false)
  } finally { f.close() }
})

test('unknown worktree process ownership cannot be declared stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-native-worktree-pending-')), root = join(directory, 'native')
  mkdirSync(root)
  try {
    const policy = structuredExecutionPolicy(request), native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', pid: process.pid, receiptFile: join(root, 'missing-receipt') }
    const execution = { ...policy, claudeNative: native, turnStartRequested: true }
    writeFileSync(join(root, 'plan.json'), JSON.stringify({ ...native, policyDigest: hash(policy) }))
    const stop = await stopClaudeStructuredTurn(execution, 10)
    assert.equal(stop.nativeStopped, false); assert.match(stop.error ?? '', /unproven/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('real creation queue runs a fake native CLI in the exact seed worktree, commits edits and replays after close without dispatch', () => {
  const f = repoFixture(), bin = join(f.root, 'bin'), home = join(f.root, 'home'), count = join(f.root, 'dispatches.json'), runner = join(f.root, 'runner.mts')
  mkdirSync(bin); mkdirSync(home)
  try {
    // Discard this fixture's unused first candidate; production creates its own governed linked worktree.
    git(f.repo, ['worktree', 'remove', f.path])
    mkdirSync(join(f.repo, '.spec')); writeFileSync(join(f.repo, '.spec/spexcode.json'), JSON.stringify({ mainBranch: 'main', sessions: { maxActive: 1 } }))
    git(f.repo, ['add', '.spec']); git(f.repo, ['commit', '-qm', 'project'])
    const seed = { ...f.seed, baseCommit: git(f.repo, ['rev-parse', 'HEAD']), tree: git(f.repo, ['rev-parse', 'HEAD^{tree}']) }
    writeFileSync(join(f.repo, 'value'), 'later index'); git(f.repo, ['add', 'value']); writeFileSync(join(f.repo, 'value'), 'later WIP')
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline'),cp=require('node:child_process');
if(process.argv.includes('--version')){process.stdout.write('2.1.309 (Claude Code)\\n');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const prompt=user.message.content[0].text;
const rows=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];rows.push({cwd:process.cwd(),args:process.argv.slice(2),prompt});fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(rows));
const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(path.join(project,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
const init={type:'system',subtype:'init',session_id:session,uuid:'public-init',parent_tool_use_id:null,model,tools:['Read','Grep','Bash','Edit','StructuredOutput'],thinking:'SYNTHETIC_SECRET_INIT_BODY',credentials:{token:'SYNTHETIC_SECRET_CREDENTIAL'}};if(!prompt.startsWith('missing-init'))send(init);send(user);
if(prompt.startsWith('exit-error')||prompt.startsWith('duplicate-init')||prompt.startsWith('unsafe-errorflag')){send({type:'result',subtype:'success',is_error:prompt.startsWith('unsafe-errorflag')?'SYNTHETIC_SECRET_ERROR_FLAG':true,session_id:session,uuid:'public-result',user_message_uuid:user.uuid,user_message_uuids:[user.uuid],result:'SYNTHETIC_SECRET_RESULT_BODY',error:{message:'SYNTHETIC_SECRET_ERROR_BODY'}});if(prompt.startsWith('duplicate-init'))send(init);process.exitCode=1;return;}
if(prompt.startsWith('malformed')){const Ajv=require(${JSON.stringify(createRequire(import.meta.url).resolve('ajv'))}).default,validate=new Ajv({allErrors:true}).compile(JSON.parse(arg('--json-schema'))),input={items:{}};validate(input);const error='Output does not match required schema: '+validate.errors.map(item=>item.instancePath+': '+item.message).join(', '),rows=[{type:'api-request',sessionId:session,id:'request',params:{model}},{type:'assistant',sessionId:session,uuid:'schema-assistant',parentUuid:user.uuid,requestRef:'request',message:{role:'assistant',content:[{type:'tool_use',id:'schema-call',name:'StructuredOutput',input}]}},{type:'user',sessionId:session,uuid:'schema-error',parentUuid:'schema-assistant',promptId:'prompt-'+user.uuid,sourceToolAssistantUUID:'schema-assistant',message:{role:'user',content:[{type:'tool_result',tool_use_id:'schema-call',is_error:true,content:error}]}}];fs.appendFileSync(path.join(project,session+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');process.exitCode=1;send({type:'result',subtype:'error_max_structured_output_retries',is_error:true,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});return;}

if(prompt.startsWith('alias')){const copy=path.join(${JSON.stringify(f.root)},'alias-copy');fs.cpSync(process.cwd(),copy,{recursive:true});fs.writeFileSync(path.join(copy,'probe'),'draft');cp.execFileSync('git',['-C',copy,'add','probe']);cp.execFileSync('git',['-C',copy,'commit','-qm','experimental probe']);fs.writeFileSync(path.join(copy,'index-probe'),'staged');cp.execFileSync('git',['-C',copy,'add','index-probe'])}
if(prompt.startsWith('edit')||prompt.startsWith('dirty')){fs.writeFileSync('value','actual candidate\\n');if(!prompt.startsWith('dirty')){cp.execFileSync('git',['add','value']);cp.execFileSync('git',['commit','-qm','native candidate'])}}
send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'result',user_message_uuid:user.uuid,user_message_uuids:[user.uuid],structured_output:{ok:true}});
});
`)
    chmodSync(executable, 0o755)
    const structured = fileURLToPath(new URL('./session-structured.ts', import.meta.url)), records = fileURLToPath(new URL('./session-record.ts', import.meta.url))
    writeFileSync(runner, `import assert from 'node:assert/strict';import{readFileSync,renameSync,existsSync}from'node:fs';import{execFileSync}from'node:child_process';import{runStructuredSession,cancelStructuredSession}from${JSON.stringify(structured)};import{readRecord,writeRecord}from${JSON.stringify(records)};
const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim(),seed=${JSON.stringify(seed)},schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const make=(key,prompt,mode,timeoutMs)=>({root:process.cwd(),base:seed.baseCommit,requestKey:key,inputDigest:key,purpose:'real-queue-worktree',prompt,schema,timeoutMs,model:'claude:MiniMax-M3.1-Flash',worktree:{...seed,mode}});
const first=make('read','read '+'x'.repeat(70000),'read',10000),read=await runStructuredSession(first),record=readRecord(read.sessionId);
assert.equal(record.structuredExecution.nativeConfiguration,'cli-config-v1');
assert.equal(record.forkCommit,seed.baseCommit);assert.equal(record.base,seed.baseCommit);assert.equal(record.structuredExecution.frozenContext,undefined);assert.equal(record.structuredExecution.frozenReadProof,undefined);assert.equal(read.worktree.tree,seed.tree);assert.equal(readFileSync(read.worktree.worktreePath+'/value','utf8'),'seed\\n');
const nextSeed=git(['commit-tree',seed.tree,'-p',seed.baseCommit,'-m','other seed']);await assert.rejects(runStructuredSession({...first,base:nextSeed,worktree:{...first.worktree,baseCommit:nextSeed}}),{code:'key_reused'});
git(['worktree','remove',read.worktree.worktreePath]);assert.deepEqual(await runStructuredSession(first),read);
const stoppedRecord=readRecord(read.sessionId),receipt=stoppedRecord.structuredExecution.claudeNative.receiptFile;renameSync(receipt,receipt+'.held');writeRecord({...stoppedRecord,structuredExecution:{...stoppedRecord.structuredExecution,state:'running',output:undefined,resultDigest:undefined,resultWorktree:undefined}});
const pending=await cancelStructuredSession(read.sessionId,{timeoutMs:20});assert.equal(pending.nativeStopped,false);assert.equal(pending.state,'cancelling');
await assert.rejects(runStructuredSession(make('blocked','edit blocked','edit',500)),{code:'timeout'});assert.equal(JSON.parse(readFileSync(${JSON.stringify(count)},'utf8')).length,1);
renameSync(receipt+'.held',receipt);const restoredStop=await cancelStructuredSession(read.sessionId,{timeoutMs:1000});assert.equal(restoredStop.nativeStopped,true,JSON.stringify({restoredStop,unknown:JSON.parse(readFileSync(stoppedRecord.structuredExecution.claudeNative.root+'/unattributed-processes.json','utf8'))}));

const edit=await runStructuredSession(make('edit','edit candidate','edit',null));assert.notEqual(edit.worktree.headCommit,seed.baseCommit);assert.equal(git(['rev-parse',edit.worktree.headCommit+'^{tree}']),edit.worktree.tree);assert.equal(readRecord(edit.sessionId).structuredExecution.resultWorktree.tree,edit.worktree.tree);
const dirtyFailure=await runStructuredSession(make('dirty','dirty candidate','edit',10000)).then(()=>null,error=>error);const dirtyRecord=dirtyFailure?.sessionId&&readRecord(dirtyFailure.sessionId),unknownFile=dirtyRecord?.structuredExecution?.claudeNative?.root+'/unattributed-processes.json';assert.equal(dirtyFailure?.code,'native_worktree_result_invalid',JSON.stringify({code:dirtyFailure?.code,unknown:unknownFile&&existsSync(unknownFile)?JSON.parse(readFileSync(unknownFile,'utf8')):null}));
assert.equal(dirtyRecord.structuredExecution.errorCode,'native_worktree_result_invalid');assert.equal(dirtyRecord.structuredExecution.state,'failed');assert.equal(dirtyRecord.structuredExecution.output,undefined);assert.equal(dirtyRecord.structuredExecution.resultWorktree,undefined);assert.equal(existsSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json'),true);const beforeReplay=readFileSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json');await assert.rejects(runStructuredSession(make('dirty','dirty candidate','edit',10000)),{code:'native_worktree_result_invalid'});assert.deepEqual(readFileSync(dirtyRecord.structuredExecution.claudeNative.root+'/completed.json'),beforeReplay);
const aliasRequest=make('alias','alias read experiment','read',null),aliasFailure=await runStructuredSession(aliasRequest).then(()=>null,error=>error),aliasRecord=readRecord(aliasFailure.sessionId);assert.equal(aliasFailure.code,'native_worktree_result_invalid');assert.equal(aliasRecord.structuredExecution.errorCode,aliasFailure.code);assert.equal(aliasRecord.structuredExecution.output,undefined);assert.equal(aliasRecord.structuredExecution.resultWorktree,undefined);assert.match(aliasFailure.message,/index-probe/);await assert.rejects(runStructuredSession(aliasRequest),{code:'native_worktree_result_invalid'});
for(const timeoutMs of [10000,null]){const malformed={...make('malformed-'+timeoutMs,'malformed output','read',timeoutMs),schema:{type:'object',properties:{items:{type:'array',maxItems:0}},required:['items'],additionalProperties:false}},failure=await runStructuredSession(malformed).then(()=>null,error=>error);assert.equal(failure?.code,'structured_output_retries_exhausted');assert.match(failure.message,/items.*must be array/);const record=readRecord(failure.sessionId);assert.equal(record.structuredExecution.errorCode,'structured_output_retries_exhausted');assert.equal(record.structuredExecution.output,undefined);assert.equal(record.structuredExecution.resultWorktree,undefined);await assert.rejects(runStructuredSession(malformed),{code:'structured_output_retries_exhausted'});assert.equal(existsSync(record.structuredExecution.claudeNative.root+'/completed.json'),false);}
for(const [key,prompt]of[['exit-error','exit-error safe metadata'],['unsafe-errorflag','unsafe-errorflag sentinel'],['duplicate-init','duplicate-init remains rejected'],['missing-init','missing-init explicit diagnosis']]){const task=make(key,prompt,'read',10000),error=await runStructuredSession(task).then(()=>null,error=>error);assert(error);const record=readRecord(error.sessionId),nativeRoot=record.structuredExecution.claudeNative.root,logPath=nativeRoot+'/native-protocol.jsonl',bytes=readFileSync(logPath),events=bytes.toString('utf8').trim().split('\\n').map(line=>JSON.parse(line));assert.equal(bytes.includes('SYNTHETIC_SECRET'),false);assert.equal(events.some(event=>'message'in event||'result'in event||'structured_output'in event||'thinking'in event||'credentials'in event||'error'in event),false);assert(events.every(event=>Number.isInteger(event.ordinal)&&event.ordinal>0));assert.equal(record.structuredExecution.output,undefined);assert.equal(record.structuredExecution.errorCode,undefined);if(key==='exit-error'){assert.equal(error.code,'failed');assert.match(error.message,/code=1, signal=null, result.is_error=true/);assert.doesNotMatch(error.message,/missing native events/);const observed=events.find(event=>event.kind==='result');assert.equal(observed.isError,true);assert.equal(observed.parentToolUseIdOwn,false);assert.equal(observed.structuredOutputOwn,false);}if(key==='unsafe-errorflag'){assert.equal(error.code,'failed');assert.match(error.message,/result.is_error=invalid/);assert.equal(error.message.includes('SYNTHETIC_SECRET'),false);assert.equal(record.structuredExecution.error.includes('SYNTHETIC_SECRET'),false);assert.equal(events.find(event=>event.kind==='result').isError,undefined);}if(key==='duplicate-init'){assert.match(error.message,/more than one native init/);assert.equal(events.filter(event=>event.kind==='init').length,2);assert.equal(events.at(-1).code,'stale_result');assert.equal(events.filter(event=>event.kind==='init').every(event=>event.parentToolUseIdOwn&&event.parentToolUseId===null),true);assert.equal(events.find(event=>event.kind==='result').ordinal,3);assert.equal(events.filter(event=>event.kind==='init').at(-1).ordinal,4);}if(key==='missing-init')assert.match(error.message,/missing native events: init/);await assert.rejects(runStructuredSession(task),{code:'failed'});assert.deepEqual(readFileSync(logPath),bytes,'冷重放不补diagnostic');}
const calls=JSON.parse(readFileSync(${JSON.stringify(count)},'utf8'));assert.equal(calls.length,10);assert.equal(calls[0].cwd,read.worktree.worktreePath);assert.equal(calls[1].cwd,edit.worktree.worktreePath);assert(calls[0].prompt.startsWith(first.prompt));assert.equal(calls.some(x=>x.args.includes('--restricted')||x.args.includes('--allowedTools')),false);process.exit(0);
`)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: f.repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SPEXCODE_HOME: home, SPEX_SESSION_DATABASE_PATH: join(home, 'sessions.sqlite'), SPEX_RUNTIME_HOME: join(home, 'runtime'), CLAUDE_CONFIG_DIR: join(home, 'claude-config'), ANTHROPIC_BASE_URL: 'https://example.invalid', SPEXCODE_CODEX_USAGE_GUARD: '0', SPEX_TEST: '1' }, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally { f.close() }
})

test('Claude terminal settlement and closed-stdin cancellation remain bounded with an unlimited model budget', () => {
  const f = repoFixture(), bin = join(f.root, 'lifecycle-bin'), runner = join(f.root, 'lifecycle.mjs'), count = join(f.root, 'lifecycle-dispatches.json')
  const termMs = 10_000, stopMs = 15_000, probeMs = 10_000, settlementMs = 2000
  const modes = ['natural-success', 'natural-exhausted', 'hanging-exhausted', 'hanging-success', 'term-exit-zero', 'hanging-exhausted-exit1', 'esrch-race', 'cancel-closed', 'ignore-term', 'wrong-receipt']
  mkdirSync(bin)
  try {
    const executable = join(bin, 'claude')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
if(process.argv.includes('--version')){console.log('2.1.309 (Claude Code)');process.exit(0)}
const arg=n=>process.argv[process.argv.indexOf(n)+1],session=arg('--session-id'),model=arg('--model'),root=path.dirname(process.env.CLAUDE_CONFIG_DIR),send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const input=rl.createInterface({input:process.stdin});input.on('close',()=>fs.writeFileSync(path.join(root,'stdin-ended'),'true'));
input.on('line',line=>{const user=JSON.parse(line);if(user.type!=='user')return;const mode=user.message.content[0].text,project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects/exact');
const calls=fs.existsSync(${JSON.stringify(count)})?JSON.parse(fs.readFileSync(${JSON.stringify(count)},'utf8')):[];calls.push(mode);fs.writeFileSync(${JSON.stringify(count)},JSON.stringify(calls));
fs.mkdirSync(project,{recursive:true});const history=path.join(project,session+'.jsonl');fs.writeFileSync(history,JSON.stringify({type:'user',sessionId:session,uuid:user.uuid,parentUuid:null,promptId:'prompt-'+user.uuid,message:user.message})+'\\n');
send({type:'system',subtype:'init',session_id:session,model,tools:['Read','Bash','StructuredOutput']});send(user);
if(mode==='ignore-term')process.on('SIGTERM',()=>fs.writeFileSync(path.join(root,'term-received'),'true'));
if(mode==='term-exit-zero'||mode==='hanging-exhausted-exit1')process.on('SIGTERM',()=>process.exit(mode==='term-exit-zero'?0:1));
if(mode==='esrch-race')setTimeout(()=>process.exit(0),${termMs + 500});
if(!mode.startsWith('natural'))setInterval(()=>{},1000);
if(mode.includes('exhausted')){const Ajv=require(${JSON.stringify(createRequire(import.meta.url).resolve('ajv'))}).default,validate=new Ajv({allErrors:true}).compile(JSON.parse(arg('--json-schema'))),value={items:{}};validate(value);const error='Output does not match required schema: '+validate.errors.map(e=>e.instancePath+': '+e.message).join(', ');fs.appendFileSync(history,[{type:'api-request',sessionId:session,id:'request',params:{model}},{type:'assistant',sessionId:session,uuid:'call-parent',parentUuid:user.uuid,requestRef:'request',message:{role:'assistant',content:[{type:'tool_use',id:'schema-call',name:'StructuredOutput',input:value}]}},{type:'user',sessionId:session,uuid:'schema-error',parentUuid:'call-parent',promptId:'prompt-'+user.uuid,sourceToolAssistantUUID:'call-parent',message:{role:'user',content:[{type:'tool_result',tool_use_id:'schema-call',is_error:true,content:error}]}}].map(x=>JSON.stringify(x)).join('\\n')+'\\n');process.exitCode=1;send({type:'result',subtype:'error_max_structured_output_retries',is_error:true,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid]});}
else send({type:'result',subtype:'success',is_error:false,session_id:session,user_message_uuid:user.uuid,user_message_uuids:[user.uuid],structured_output:{items:[]}});
});`)
    chmodSync(executable, 0o755)
    const modulePath = (name: string): string => fileURLToPath(new URL(name, import.meta.url))
    writeFileSync(runner, String.raw`import assert from 'node:assert/strict';import{readFileSync,writeFileSync,existsSync,renameSync,chmodSync}from'node:fs';import{join}from'node:path';import{randomUUID,createHash}from'node:crypto';
import childProcess from 'node:child_process';import{syncBuiltinESMExports}from'node:module';import{Transform}from'node:stream';
import{claudeStructuredTurn,stopClaudeStructuredTurn}from${JSON.stringify(modulePath('./claude-structured.ts'))};import{structuredExecutionPolicy}from${JSON.stringify(modulePath('./session-structured-policy.ts'))};
const originalTimeout=globalThis.setTimeout,armed=[];globalThis.setTimeout=(callback,delay,...args)=>{const control=delay===15000||delay===10000&&callback.name==='killOwnGroup';if(control)armed.push(delay);return originalTimeout(callback,delay,...args)};
const sleep=ms=>new Promise(resolve=>originalTimeout(resolve,ms)),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),count=${JSON.stringify(count)},realm=${JSON.stringify(join(f.root, 'lifecycle-realm'))},workspace=${JSON.stringify(f.path)},seed=${JSON.stringify(f.seed)},schema={type:'object',properties:{items:{type:'array',maxItems:0}},required:['items'],additionalProperties:false};
const errors=[],unhandled=[],originalKill=process.kill,originalSpawn=childProcess.spawn,fixtureIdentities=new Map();let scope;
childProcess.spawn=(command,args,options)=>{
  const child=originalSpawn(command,args,options);
  if(command==='/usr/sbin/lsof'){
    scope.cwdProbes++;const pids=args[args.indexOf('-p')+1].split(',').map(Number);
    assert(pids.every(pid=>fixtureIdentities.has(pid)),'cwd candidates must have real fixture ancestry and start identity');
  }
  if(command==='/bin/ps'&&args.join(' ')==='-axo uid=,pid=,ppid=,lstart='){
    scope.psProbes++;const stdout=child.stdout,chunks=[];
    const filtered=new Transform({transform(chunk,_encoding,callback){chunks.push(chunk);callback()},flush(callback){
      const rows=Buffer.concat(chunks).toString('utf8').split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);return match?[{line,pid:Number(match[2]),ppid:Number(match[3]),start:match[4].replace(/\s+/g,' ')}]:[]});
      const live=new Map(rows.map(row=>[row.pid,row]));
      for(const[pid,start]of fixtureIdentities)if(live.get(pid)?.start!==start)fixtureIdentities.delete(pid);
      const runner=live.get(process.pid);assert(runner,'real runner must exist in the actual census');fixtureIdentities.set(runner.pid,runner.start);
      for(let changed=true;changed;){changed=false;for(const row of rows)if(!fixtureIdentities.has(row.pid)&&fixtureIdentities.get(row.ppid)===live.get(row.ppid)?.start&&live.has(row.ppid)){fixtureIdentities.set(row.pid,row.start);changed=true}}
      const included=rows.filter(row=>fixtureIdentities.get(row.pid)===row.start);scope.excludedNonFixtureRows+=rows.length-included.length;
      this.push(included.map(row=>row.line).join('\n')+'\n');callback();
    },destroy(error,callback){stdout.destroy();callback(error)}});
    stdout.pipe(filtered);child.stdout=filtered;
  }
  return child;
};syncBuiltinESMExports();
process.on('unhandledRejection',error=>unhandled.push(error?.code??'unknown'));
for(const mode of ${JSON.stringify(modes)}){
  scope={psProbes:0,cwdProbes:0,excludedNonFixtureRows:0};
  const execution={...structuredExecutionPolicy({schema,inputDigest:mode,purpose:'lifecycle',timeoutMs:null,model:'claude:MiniMax-M3.1-Flash',worktree:{...seed,mode:'read'}}),state:'running'},id=randomUUID(),root=join(realm,id),controller=new AbortController(),start=armed.length;
  const callbacks={signal:controller.signal,onThread:async value=>{execution.threadId=value},onTurn:async value=>{execution.turnId=value},onTurnStarting:async()=>{execution.turnStartRequested=true},onNative:async value=>{execution.claudeNative=value}};
  const flight=claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace).then(value=>({value}),error=>({error}));
  try{
    const ready=Date.now()+${probeMs};while(!existsSync(join(root,'stdin-ended'))&&Date.now()<ready)await sleep(10);assert(existsSync(join(root,'stdin-ended')),'stdin must have ended after the terminal result');
    if(mode==='wrong-receipt'){const path=execution.claudeNative.receiptFile,receipt=JSON.parse(readFileSync(path,'utf8'));renameSync(path,path+'.held');writeFileSync(path,JSON.stringify({...receipt,pid:process.pid}))}
    if(mode==='esrch-race')process.kill=(pid,signal)=>{if(pid===-execution.claudeNative.pid&&signal==='SIGTERM'){const error=new Error('simulated exit between verification and signal');error.code='ESRCH';throw error}return originalKill(pid,signal)};
    if(mode==='cancel-closed')controller.abort();
    if(mode==='ignore-term'){controller.abort();await stopClaudeStructuredTurn(execution,30);await sleep(30);await stopClaudeStructuredTurn(execution,30)}
    const outcome=await Promise.race([flight,sleep(${stopMs + settlementMs}).then(()=>{throw new Error('terminal/cancel flight exceeded real stop window and fixture settlement allowance')})]);
    if(mode==='natural-success'||mode==='esrch-race'){
      assert.deepEqual(JSON.parse(outcome.value.text),{items:[]});if(mode==='natural-success')assert.equal(existsSync(join(root,'terminal-stop.json')),false);else assert.equal(JSON.parse(readFileSync(join(root,'terminal-stop.json'),'utf8')).outcome,'gone');
      execution.state='completed';execution.output={items:[]};execution.resultDigest=hash(execution.output);renameSync(execution.claudeNative.receiptFile,execution.claudeNative.receiptFile+'.held');assert.deepEqual(await claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),outcome.value);
    }else if(mode==='hanging-exhausted-exit1'){assert.equal(outcome.error?.code,'stale_result');assert.equal(existsSync(join(root,'completed.json')),false);const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.code,1);assert.equal(exit.signal,null)
    }else if(mode.includes('exhausted')){
      assert.equal(outcome.error?.code,'structured_output_retries_exhausted');assert.match(outcome.error.message,/items.*must be array/);assert.equal(existsSync(join(root,'completed.json')),false);
      const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.stopped,true);assert.equal(exit.code,mode==='natural-exhausted'?1:null);assert.equal(exit.signal,mode==='natural-exhausted'?null:'SIGTERM');
      const dispatched=JSON.parse(readFileSync(count,'utf8')).length;execution.state='failed';await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:'structured_output_retries_exhausted'});assert.equal(JSON.parse(readFileSync(count,'utf8')).length,dispatched);
      if(mode==='hanging-exhausted'){
        for(const [name,fields] of [['terminal-stop-request.json',['sessionId','userUuid','pid','receiptDigest','requestDigest','resultDigest','signal','requestedAt']],['terminal-stop.json',['requestObservationDigest','outcome','version','observedAt']]]){
          const path=join(root,name),bytes=readFileSync(path),observed=JSON.parse(bytes);
          for(const field of fields){chmodSync(path,0o600);writeFileSync(path,JSON.stringify({...observed,[field]:'foreign'}));await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:'stale_result'})}
          chmodSync(path,0o600);writeFileSync(path,bytes);chmodSync(path,0o400);renameSync(path,path+'.held');await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),{code:name==='terminal-stop.json'?'cancellation_pending':'stale_result'});renameSync(path+'.held',path);
        }
      }
    }else if(mode==='hanging-success'||mode==='term-exit-zero'){
      assert.equal(outcome.error?.code,'failed');assert.equal(existsSync(join(root,'completed.json')),false);const exit=JSON.parse(readFileSync(join(root,'exit.json'),'utf8'));assert.equal(exit.code,mode==='hanging-success'?null:0);assert.equal(exit.signal,mode==='hanging-success'?'SIGTERM':null);assert.equal(exit.stopped,true);execution.state='failed';await assert.rejects(claudeStructuredTurn(realm,id,mode,execution,callbacks,workspace),error=>['failed','stale_result'].includes(error.code));
    }else if(mode==='cancel-closed'){assert.equal(outcome.error?.code,'cancelled');assert.equal(JSON.parse(readFileSync(join(root,'exit.json'),'utf8')).signal,'SIGTERM')}
    else{
      assert.equal(outcome.error?.code,'cancellation_pending');assert.equal(existsSync(join(root,'exit.json')),false);assert.equal(existsSync(join(root,'completed.json')),false);process.kill(execution.claudeNative.pid,0);
      if(mode==='ignore-term'){assert(existsSync(join(root,'term-received')));assert.deepEqual(armed.slice(start),[10000,15000]);const stop=await stopClaudeStructuredTurn(execution,20);assert.equal(stop.nativeStopped,false)}
      else assert.equal(existsSync(join(root,'terminal-stop.json')),false,'wrong receipt must not authorize process termination');
    }
    console.log(JSON.stringify({mode,status:'passed',error:outcome.error?.code,armed:armed.slice(start),scope:{...scope,cwdCandidatesAllFixture:true}}));
  }catch(error){errors.push({mode,message:error.message})}
  finally{
    process.kill=originalKill;const native=execution.claudeNative;if(native?.receiptFile&&existsSync(native.receiptFile+'.held'))renameSync(native.receiptFile+'.held',native.receiptFile);
    if(native?.pid){try{process.kill(-native.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}}
    await Promise.race([flight,sleep(1000)]);
  }
}
childProcess.spawn=originalSpawn;syncBuiltinESMExports();assert.deepEqual(errors,[]);assert.deepEqual(unhandled,[],'async settle rejection must be consumed before awaited final stop');`)
    const result = spawnSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), runner], { cwd: f.repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_BASE_URL: 'https://example.invalid', SPEX_TEST: '1' }, encoding: 'utf8', timeout: modes.length * (probeMs + stopMs + settlementMs) })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    console.log(result.stdout)
  } finally { f.close() }
})


for (const taskScoped of [true, false]) test(taskScoped ? 'task cwd orphan stays pending after chdir without gaining kill authority' : 'external orphan and reused task PID do not block stop or replace original evidence', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'spex-native-orphan-')), root = join(directory, 'native'), workspace = join(directory, 'worktree'), outside = join(directory, 'outside')
  for (const path of [root, workspace, outside]) mkdirSync(path)
  const receiptFile = join(root, 'process.json'), daemonFile = join(directory, 'daemon.json'), plan = { root, workspace, receiptFile, pid: undefined as number | undefined }
  await sampleNativeWorktreeProcesses(plan)
  const daemonSource = `const fs=require('node:fs');const publish=()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,cwd:process.cwd()}));process.on('SIGUSR1',()=>{process.chdir(process.argv[2]);publish()});publish();setInterval(()=>{},1000)`
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process');process.stdin.once('data',()=>{spawn(process.execPath,['-e',process.argv[4],process.argv[1],process.argv[3]],{detached:true,stdio:'ignore',cwd:process.argv[2]}).unref();process.exit(0)});process.stdout.write('READY')`, daemonFile, taskScoped ? workspace : outside, outside, daemonSource], { cwd: workspace, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  assert(leader.pid)
  const closed = new Promise<void>(resolve => leader.once('close', () => resolve()))
  let daemonPid: number | undefined
  const launch = childProcess.spawn, probes: Array<{ command: string; pid: number; startedAt: number; closedAt?: number }> = []
  t.mock.method(childProcess, 'spawn', (command: string, args: string[], options: SpawnOptions) => {
    const child = launch(command, args, options)
    if (command === '/usr/sbin/lsof' || command === '/bin/ps') {
      assert(child.pid); assert.equal(options.detached, true)
      const observation: (typeof probes)[number] = { command, pid: child.pid, startedAt: performance.now() }
      probes.push(observation); child.once('close', () => { observation.closedAt = performance.now() })
    }
    return child
  })
  syncBuiltinESMExports()
  try {
    await new Promise<void>(resolve => leader.stdout.once('data', () => resolve()))
    writeDetachedRuntimeReceipt(leader.pid, receiptFile); plan.pid = leader.pid
    await sampleNativeWorktreeProcesses(plan); leader.stdin.end('GO'); await closed
    for (let retry = 0; !existsSync(daemonFile) && retry < 100; retry++) await new Promise(resolve => setTimeout(resolve, 10))
    daemonPid = (JSON.parse(readFileSync(daemonFile, 'utf8')) as { pid: number }).pid
    process.kill(daemonPid, 0)
    const oldUnknown = JSON.stringify([{ pid: daemonPid, ppid: 1, startToken: 'historical-other-identity' }]), oldExit = JSON.stringify({ code: 0, signal: null, stopped: false })
    writeFileSync(join(root, 'unknown-processes.json'), oldUnknown); writeFileSync(join(root, 'exit.json'), oldExit)
    if (!taskScoped) writeFileSync(join(root, 'task-related-processes.json'), JSON.stringify([{ pid: daemonPid, startToken: 'historical-other-identity', cwd: workspace, boundaryVersion: 2, observedAt: 1 }]))
    assert.equal((JSON.parse(readFileSync(join(root, 'owned-processes.json'), 'utf8')) as Array<{ pid: number }>).some(row => row.pid === daemonPid), false)
    const originalPlan = JSON.stringify(plan), originalReceipt = readFileSync(receiptFile)
    const originalDaemon = readFileSync(daemonFile), daemonStart = processStartToken(daemonPid)
    assert(daemonStart)
    let recovered = false
    const observeStopped = async (terminate = false): Promise<boolean> => {
      try { return await nativeWorktreeProcessesStopped(plan, terminate) }
      catch (error) {
        if (!(error instanceof StructuredSessionError) || error.code !== 'cancellation_pending' || recovered) throw error
        recovered = true
        const probe = probes.at(-1); assert(probe, '必须是本fixture实际派发的探针，不能拿其它unknown续验'); assert.equal(probe.command, '/usr/sbin/lsof')
        const count = probes.length, waitUntil = Date.now() + 35_000
        while ((probe.closedAt === undefined || hostProcessAdapter.liveness(-probe.pid) !== 'absent') && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 25))
        assert(probe.closedAt !== undefined); assert.equal(hostProcessAdapter.liveness(-probe.pid), 'absent', '原探针整组未停不能再派发')
        assert.equal(probes.length, count, '等待原探针结算期间不能叠加新探针')
        assert.equal(JSON.stringify(plan), originalPlan); assert.deepEqual(readFileSync(receiptFile), originalReceipt)
        assert.deepEqual(readFileSync(daemonFile), originalDaemon); assert.equal(processStartToken(daemonPid!), daemonStart)
        assert.equal(readFileSync(join(root, 'unknown-processes.json'), 'utf8'), oldUnknown); assert.equal(readFileSync(join(root, 'exit.json'), 'utf8'), oldExit)
        const result = await nativeWorktreeProcessesStopped(plan, terminate)
        console.log(JSON.stringify({ fixture: taskScoped ? 'task-cwd' : 'outside-cwd', recovered: true, samePlanReceiptAndPidStart: true, oldUnknownAndExitUnchanged: true, probeGroupGone: true, probeCloseElapsedMs: probe.closedAt - probe.startedAt, nativeStopped: result }))
        return result
      }
    }
    assert.equal(await observeStopped(), !taskScoped)
    assert.equal(await observeStopped(true), !taskScoped)
    process.kill(daemonPid, 0)
    assert.equal(readFileSync(join(root, 'unknown-processes.json'), 'utf8'), oldUnknown)
    assert.equal(readFileSync(join(root, 'exit.json'), 'utf8'), oldExit)
    if (taskScoped) {
      const legacyRoot = join(directory, 'legacy'); mkdirSync(join(legacyRoot, 'claude-home/projects/exact'), { recursive: true })
      for (const name of ['process.json', 'process-baseline.json', 'owned-processes.json']) writeFileSync(join(legacyRoot, name), readFileSync(join(root, name)))
      const prompt = 'Read the original worktree', policy = structuredExecutionPolicy(request), native = { version: 1 as const, root: legacyRoot, sessionId: 'legacy-session', userUuid: 'legacy-user', pid: leader.pid, receiptFile: join(legacyRoot, 'process.json') }
      const execution = { ...policy, state: 'running' as const, claudeNative: native }, message = { role: 'user', content: [{ type: 'text', text: prompt }] }
      const legacyPlan = { ...native, cliVersion: '2.1.309 (Claude Code)', requestDigest: hash({ prompt, policy }), policyDigest: hash(policy) }
      for (const [name, value] of Object.entries({ 'plan.json': legacyPlan, 'launch.json': { cwd: workspace }, 'init.json': { session_id: native.sessionId, model: 'MiniMax-M3.1-Flash', tools: ['Bash', 'StructuredOutput'] }, 'user-echo.json': { uuid: native.userUuid, session_id: native.sessionId, message }, 'result.json': { subtype: 'success', is_error: false, session_id: native.sessionId, user_message_uuid: native.userUuid, user_message_uuids: [native.userUuid], structured_output: { ok: true } }, 'exit.json': { code: 0, signal: null, stopped: false } })) writeFileSync(join(legacyRoot, name), JSON.stringify(value))
      writeFileSync(join(legacyRoot, 'claude-home/projects/exact/legacy-session.jsonl'), JSON.stringify({ type: 'user', sessionId: native.sessionId, uuid: native.userUuid, promptId: 'prompt', parentUuid: null, message }) + '\n')
      await assert.rejects(claudeStructuredTurn(directory, 'legacy', prompt, execution, noDispatch, workspace), { code: 'cancellation_pending' })
      assert.equal(readFileSync(join(legacyRoot, 'exit.json'), 'utf8'), JSON.stringify({ code: 0, signal: null, stopped: false }))
      const related = JSON.parse(readFileSync(join(root, 'task-related-processes.json'), 'utf8')) as Array<{ pid: number; startToken: string; cwd: string }>
      assert(related.some(row => row.pid === daemonPid && row.cwd === realpathSync(workspace)))
      process.kill(daemonPid, 'SIGUSR1')
      for (let retry = 0; retry < 100 && JSON.parse(readFileSync(daemonFile, 'utf8')).cwd !== realpathSync(outside); retry++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(JSON.parse(readFileSync(daemonFile, 'utf8')).cwd, realpathSync(outside))
      assert.equal(await observeStopped(), false, 'positive task association remains sticky after chdir')
    } else {
      const diagnostic = JSON.parse(readFileSync(join(root, 'unattributed-processes.json'), 'utf8')) as Array<{ pid: number }>
      assert(diagnostic.some(row => row.pid === daemonPid))
    }
    const observations = readFileSync(join(root, 'process-stop-observations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { boundaryVersion: number; at: number; nativeStopped: boolean })
    assert(observations.length >= 2); assert(observations.every(row => row.boundaryVersion === 2 && row.at > 0))
    process.kill(-daemonPid, 'SIGTERM')
    for (let retry = 0; retry < 100; retry++) {
      try { process.kill(daemonPid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    daemonPid = undefined
    assert.equal(await nativeWorktreeProcessesStopped(plan), true)
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports()
    if (daemonPid) { try { process.kill(-daemonPid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') } }
    if (leader.exitCode === null && leader.signalCode === null) {
      try { process.kill(-leader.pid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
    }
    await closed; rmSync(directory, { recursive: true, force: true })
  }
})


test('Claude worktree exhaustion retains only the last authenticated rejected StructuredOutput input', async () => {
  const f = repoFixture(), realm = join(f.root, 'realm'), root = join(realm, 'native'), historyPath = join(root, 'claude-home/projects/exact/session.jsonl')
  mkdirSync(join(root, 'claude-home/projects/exact'), { recursive: true })
  try {
    const processIdentity = await deadProcess(root), prompt = 'Review this exact owner', output = { ok: 'rejected final' }
    const policy = structuredExecutionPolicy({ ...request, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, worktree: { ...f.seed, mode: 'read' } })
    const native = { version: 1 as const, root, sessionId: 'session', userUuid: 'user', ...processIdentity }, execution: StructuredExecution = { ...policy, claudeNative: native, state: 'running' }
    const plan = { ...native, policyDigest: hash(policy), requestDigest: hash({ prompt, policy }), cliVersion: '2.1.309 (Claude Code)' }
    const message = { role: 'user', content: [{ type: 'text', text: prompt }] }
    for (const [name, value] of Object.entries({ 'plan.json': plan, 'launch.json': { cwd: f.path }, 'init.json': { session_id: 'session', model: 'MiniMax-M3.1-Flash', tools: ['Read', 'StructuredOutput'] }, 'user-echo.json': { uuid: 'user', session_id: 'session', message }, 'result.json': { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, session_id: 'session', user_message_uuid: 'user', user_message_uuids: ['user'] }, 'exit.json': { code: 1, signal: null, stopped: true } })) writeFileSync(join(root, name), JSON.stringify(value))
    const history = [
      { type: 'user', sessionId: 'session', uuid: 'user', parentUuid: null, promptId: 'prompt', message },
      { type: 'api-request', sessionId: 'session', id: 'request', keep: 0, tail: [], params: { model: 'MiniMax-M3.1-Flash' } },
      { type: 'assistant', sessionId: 'session', uuid: 'schema-call', parentUuid: 'user', requestRef: 'request', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_PRIVATE_THINKING' }, { type: 'tool_use', id: 'schema', name: 'StructuredOutput', input: output }] } },
      { type: 'user', sessionId: 'session', uuid: 'schema-error', parentUuid: 'schema-call', promptId: 'prompt', sourceToolAssistantUUID: 'schema-call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'schema', is_error: true, content: 'Output does not match required schema: /ok: must be boolean' }] } },
    ]
    writeFileSync(historyPath, history.map(row => JSON.stringify(row)).join('\n') + '\n')
    await assert.rejects(claudeStructuredTurn(realm, 'native', prompt, execution, noDispatch, f.path), error => {
      assert(error instanceof StructuredSessionError); assert.equal(error.code, 'structured_output_retries_exhausted')
      assert.equal(error.rejectedOutput?.text, JSON.stringify(output)); assert.equal(error.rejectedOutput?.representation, 'native_json')
      assert(!JSON.stringify(error.rejectedOutput).includes('SYNTHETIC_PRIVATE_THINKING'))
      assert.equal(existsSync(join(root, 'completed.json')), false)
      return true
    })
  } finally { f.close() }
})
