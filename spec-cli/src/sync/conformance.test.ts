import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { runConformance } from './conformance.js'
import type { ConformanceInput, ConformanceResult } from './conformance.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { GenerationReview } from './generation-types.js'
import { INTENT_AUTHORIZATION_PATH } from './intent-authorization.js'
import type { IntentAuthorization, IntentAuthorizationCheck, RawIntentChange } from './intent-authorization.js'
import { contentHash } from './snapshot.js'
import { FROZEN_PROMPT_THRESHOLD_BYTES } from '../frozen-context.js'
import { frozenReaderDisabledFeatures } from '../session-structured-policy.js'

const specPath = '.spec/product/greeting/spec.md'
const image = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const source = `---
title: 问候
status: active
contract-schema: sync-v1
code:
  - src/greet.mjs
---
## raw source
用户请求时返回 hi。
## expanded spec
状态不适用：纯同步问候，无持久状态与异步副作用。
### REQ
| id | goal | source | constraints | success | depends-on |
|---|---|---|---|---|---|
| REQ-GREET-01 | 返回问候 | user:raw | 无副作用 | 返回 hi | - |
### RULE
| id | scope | constraint | basis | authority | source | depends-on |
|---|---|---|---|---|---|---|
| RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting | derived:REQ-GREET-01 | REQ-GREET-01 |
### FLOW
| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| FLOW-GREET-01 | REQ-GREET-01 | 用户 | 请求 | 无 | STEP-GREET-01 | END | derived:REQ-GREET-01 | REQ-GREET-01 |
### STEP
| id | flow | action | input | output | rules | next | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| STEP-GREET-01 | FLOW-GREET-01 | 问候 | 请求 | hi | RULE-GREET-01 | END | derived:FLOW-GREET-01 | RULE-GREET-01 |
### AC
| id | covers | preconditions | action | assertion | test | command | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| AC-GREET-01 | REQ-GREET-01,RULE-GREET-01,FLOW-GREET-01,STEP-GREET-01 | 无 | 请求 | 返回 hi | tests/greet.test.mjs#CASE-GREET | VERIFY-GREET-01 | derived:RULE-GREET-01 | RULE-GREET-01 |
### VERIFY
| id | command | cwd | timeout-ms |
|---|---|---|---|
| VERIFY-GREET-01 | ["node","--test","tests/greet.test.mjs"] | . | 30000 |
`
const implementation = 'export function greet() { return "hi" }\n'
const assertion = 'import test from "node:test"; import assert from "node:assert/strict"; import {greet} from "../src/greet.mjs"; test("CASE-GREET greeting", () => assert.equal(greet(), "hi"));\n'
const settings = { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['src'], facts: [], mandatoryTests: [], budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 60000 }, verifications: [{ definition: { id: 'VERIFY-GREET-01', command: ['node', '--test', 'tests/greet.test.mjs'], cwd: '.', timeoutMs: 30000 }, environment: { version: 'ci-fixture-v1', image, platform: 'linux/arm64', memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 65536 } }] }
function git(root: string, args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8' }).trim() }
function put(root: string, path: string, content: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
function save(root: string): string { git(root, ['add', '-A']); git(root, ['commit', '-qm', 'fixture']); return git(root, ['rev-parse', 'HEAD']) }
function fixture(): { root: string; base: string; input: (candidate: string) => ConformanceInput } {
  const root = mkdtempSync(join(tmpdir(), 'spex-conformance-repo-'))
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Conformance']); git(root, ['config', 'user.email', 'conformance@example.test'])
  put(root, specPath, source); put(root, 'src/greet.mjs', implementation); put(root, 'tests/greet.test.mjs', assertion); put(root, '.spec/spexcode.json', JSON.stringify({ sync: settings }))
  const base = save(root)
  return { root, base, input: candidate => ({ repository: root, baseCommit: base, candidateCommit: candidate, policyCommit: base }) }
}
function authorization(before: string | null, after: string | null, path = specPath): IntentAuthorization {
  const rawDigest = (source: string | null): string | null => { if (source === null) return null; const { body } = parseFrontmatter(source); return contentHash(parseParts(body)?.rawSource ?? body.trim()) }
  return { path, beforeRawDigest: rawDigest(before), afterRawDigest: rawDigest(after), source: '用户明确修改问候需求的受信记录' }
}
function authorized(repo: ReturnType<typeof fixture>, candidate: string, records = [authorization(source, git(repo.root, ['show', `${candidate}:${specPath}`]))]): ConformanceInput {
  git(repo.root, ['checkout', '--detach', '-q', repo.base])
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: records }))
  const policyCommit = save(repo.root)
  git(repo.root, ['checkout', '--detach', '-q', candidate])
  return { ...repo.input(candidate), policyCommit }
}
type ReviewContext = { inputId: string; candidateDigest: string; identities: { baseCommit: string; candidateCommit: string; policyCommit: string }; scope: { itemIds: string[]; retiredIds: string[] }; readSet: { path: string; before: string | null; candidate: string | null }[]; intentAuthorization: IntentAuthorizationCheck; intentChanges: RawIntentChange[] }
function context(request: ElaborationSessionRequest): ReviewContext { return JSON.parse(request.prompt.split('\n冻结完整输入:\n').at(-1)!) as ReviewContext }
function reviewer(change?: (review: GenerationReview, value: ReviewContext, request: ElaborationSessionRequest) => void): ElaborationRunner {
  return async request => {
    const value = context(request)
    const output: GenerationReview = { inputId: value.inputId, candidateDigest: value.candidateDigest, verdict: 'accept', checkedIds: [...value.scope.itemIds], findings: [] }
    change?.(output, value, request)
    return { sessionId: 'FAKE-REVIEW-SESSION', threadId: 'FAKE-REVIEW-THREAD', turnId: 'FAKE-REVIEW-TURN', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}
const noDocker = async (): Promise<never> => { throw new Error('fixture: Docker unavailable') }
const evidence = (name: string): Pick<ConformanceInput, 'evidenceDirectory'> => process.env.SPEX_VERIFICATION_EVIDENCE_DIR ? { evidenceDirectory: mkdtempSync(join(process.env.SPEX_VERIFICATION_EVIDENCE_DIR, `${name}-`)) } : {}

function publicCheck(t: TestContext, input: ConformanceInput, config: string): { status: number | null; result: ConformanceResult } {
  const host = dirname(config), evidenceDirectory = mkdtempSync(join(tmpdir(), 'spex-conformance-public-'))
  const callerDatabase = join(host, 'caller-sessions.sqlite')
  t.after(() => {
    const candidate = join(evidenceDirectory, 'candidate')
    if (existsSync(candidate)) execFileSync('chmod', ['-R', 'u+w', candidate])
    rmSync(evidenceDirectory, { recursive: true, force: true, maxRetries: 3 })
  })
  const cli = spawnSync(process.execPath, [
    '--import', fileURLToPath(new URL('../../../scripts/test-home.mjs', import.meta.url)), '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../cli.ts', import.meta.url)), 'sync', 'check', '--base', input.baseCommit, '--candidate', input.candidateCommit, '--policy', input.policyCommit, '--repository', input.repository, '--evidence-directory', evidenceDirectory,
  ], { cwd: input.repository, env: { ...process.env, PATH: [host, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter), SPEX_SESSION_DATABASE_PATH: callerDatabase, SPEX_LLM_MANAGER_CONFIG: config, SPEX_LLM_MANAGER_PYTHON: join(host, 'bridge'), SPEX_VERIFICATION_SSH_ALIAS: undefined, SPEX_VERIFICATION_SSH_ROOT: undefined, SPEX_VERIFICATION_SSH_DOCKER_ENDPOINT: undefined }, encoding: 'utf8', timeout: 30000 })
  assert.ifError(cli.error)
  assert.ok(cli.stdout, cli.stderr)
  assert.equal(existsSync(callerDatabase), false, '公开命令不接触调用方会话数据库')
  return { status: cli.status, result: JSON.parse(cli.stdout) as ConformanceResult }
}

function managerFixture(t: TestContext, selection: ConformanceResult['reviewRoute'] | null, settle = true, successor?: ConformanceResult['reviewRoute'], nativeRuntime = fileURLToPath(new URL('../../llm-manager/native-runtime.mjs', import.meta.url))) {
  const host = mkdtempSync(join(tmpdir(), 'spex-conformance-manager-fixture-')), config = join(host, 'config.json'), log = join(host, 'calls.jsonl')
  t.after(() => rmSync(host, { recursive: true, force: true }))
  writeFileSync(config, JSON.stringify({ selection, successor }))
  writeFileSync(join(host, 'docker'), '#!/bin/sh\nexit 127\n', { mode: 0o700 })
  writeFileSync(join(host, 'bridge'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
if (process.argv[3] === '-m' && process.argv[4] === 'llm_manager.native_runtime') {
  process.stdout.write(JSON.stringify({ version: 1, path: ${JSON.stringify(nativeRuntime)} })); process.exit(0)
}
const message = JSON.parse(readFileSync(0, 'utf8'))
appendFileSync('calls.jsonl', JSON.stringify(message) + '\\n')
const { selection, successor } = JSON.parse(readFileSync(process.argv[5], 'utf8'))
if (message.nextAfter) {
  const calls = readFileSync('calls.jsonl', 'utf8').trim().split('\\n').map(line => JSON.parse(line))
  const previous = calls.find(call => call.action === 'settle' && call.sessionId === message.failedSessionId && call.outcome === 'quota')
  if (!${settle} || previous?.route.routeId !== message.nextAfter.routeId || message.sameGroupAs?.routeId !== selection.routeId) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'llm_manager_quota_required' })); process.exit(0)
  }
}
const selected = message.nextAfter ? successor ?? null : selection
const value = message.action === 'resolve' ? selected?.frozenReader?.capability === message.capability ? selected : null : message.action === 'reserve' ? {} : { outcome: message.outcome }
process.stdout.write(JSON.stringify(message.action === 'settle' && !${settle} ? { ok: false, code: 'llm_manager_host_unavailable' } : { ok: true, value }))
`, { mode: 0o700 })
  return { host, config, calls: (): { action: string; route?: unknown; sessionId?: string; outcome?: string }[] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
}

test('公开 sync check 在 Manager 功能组没有就绪路线时拒绝使用旧默认模型', t => {
  const repo = fixture(), manager = managerFixture(t, null)
  t.after(() => rmSync(repo.root, { recursive: true, force: true }))
  put(repo.root, 'src/greet.mjs', `${implementation}\n// reference refactor\n`)
  const { result, status } = publicCheck(t, repo.input(save(repo.root)), manager.config)
  assert.equal(status, 2, JSON.stringify(result.diagnostics))
  assert.equal(result.status, 'unsupported')
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['unsupported_llm_manager_no_ready_route'])
  assert.equal(result.reviewExecution, 'native')
  assert.equal(result.review, null)
  assert.deepEqual(result.runs, [])
  assert.equal(git(repo.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1)
  assert.deepEqual(manager.calls(), [{ action: 'resolve' }])
})

const cursorRoute = { routeId: 'a'.repeat(64), vendor: 'cursor', model: 'default', kind: 'cli' } as const
const successorRoute = { ...cursorRoute, routeId: 'b'.repeat(64), model: 'cursor-successor-fixture' } as const

for (const scenario of ['accept', 'accept-unsettled', 'quota', 'quota-unsettled', 'protocol'] as const) test(`公开 sync check 的模拟 Manager 与 Cursor CLI ${scenario}`, t => {
  const settle = !scenario.endsWith('unsettled'), quota = scenario.startsWith('quota'), protocol = scenario === 'protocol'
  const repo = fixture(), manager = managerFixture(t, cursorRoute, settle, successorRoute)
  t.after(() => rmSync(repo.root, { recursive: true, force: true }))
  const candidateSource = `${implementation}\n/* ${'x'.repeat(400 * 1024)} candidate content */\n`
  put(repo.root, 'src/greet.mjs', candidateSource)
  const candidate = save(repo.root)
  git(repo.root, ['checkout', '-q', '--detach', repo.base])
  put(repo.root, 'src/greet.mjs', 'uncommitted source must never be read\n')
  const project = ['worktree list --porcelain', 'show-ref', 'status --porcelain'].map(command => git(repo.root, command.split(' ')))
  writeFileSync(join(manager.host, 'cursor-agent'), String.raw`#!${process.execPath}
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
if (process.argv[2] === '--version') { console.log('cursor-conformance-fixture'); process.exit(0) }
const successor = process.argv.includes(${JSON.stringify(successorRoute.model)})
assert.deepEqual(process.argv.slice(2), ['--workspace', process.cwd(), '--sandbox', 'enabled', '--trust', '--mode', 'ask', ...(successor ? ['--model', ${JSON.stringify(successorRoute.model)}] : []), 'acp'])
const sessionId = 'cursor-conformance-native' + (successor ? '-successor' : '')
const send = packet => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n')
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') send({ id, result: { protocolVersion: 1, authMethods: [] } })
  else if (method === 'session/new') send({ id, result: { sessionId, modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }] } } })
  else if (method === 'session/prompt') {
    assert.equal(params.sessionId, sessionId)
    const full = params.prompt[0].text.split('\n冻结完整输入:\n')[1].split('\n\nWork in the current Git worktree')[0]
    const ctx = JSON.parse(full)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), ctx.identities.candidateCommit)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), ctx.identities.candidateTree)
    assert.equal(ctx.identities.baseCommit, ${JSON.stringify(repo.base)})
    assert.equal(ctx.identities.policyCommit, ${JSON.stringify(repo.base)})
    assert.deepEqual(ctx.readSet.find(file => file.path === 'src/greet.mjs'), { path: 'src/greet.mjs', before: ${JSON.stringify(implementation)}, candidate: ${JSON.stringify(candidateSource)} })
    assert.equal(readFileSync('src/greet.mjs', 'utf8'), ${JSON.stringify(candidateSource)})
    if (${quota} && !successor) {
      send({ id, error: { code: 429, message: 'fixture provider quota' } })
      return
    }
    if (${protocol}) {
      send({ id, error: { code: -32001, message: 'fixture ACP error' } })
      return
    }
    const output = { inputId: ctx.inputId, candidateDigest: ctx.candidateDigest, checkedIds: ctx.scope.itemIds, verdict: 'accept', findings: [] }
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(output) } } } })
    send({ id, result: { stopReason: 'end_turn' } })
  } else assert.fail('unexpected native ACP request ' + method)
})
`, { mode: 0o700 })
  const { status, result } = publicCheck(t, repo.input(candidate), manager.config)
  assert.equal(result.reviewExecution, 'native')
  assert.deepEqual(result.reviewRoute, quota && settle ? successorRoute : cursorRoute)
  const attempts = readdirSync(result.evidenceDirectory).filter(path => path.startsWith('review-')).map(path => {
    const realm = join(result.evidenceDirectory, path)
    assert.ok(existsSync(join(realm, 'runtime', 'sessions.sqlite')))
    return { realm, raw: JSON.parse(readFileSync(join(realm, 'native-result.json'), 'utf8')) }
  })
  assert.equal(attempts.length, quota && settle ? 2 : 1)
  assert.deepEqual(['worktree list --porcelain', 'show-ref', 'status --porcelain'].map(command => git(repo.root, command.split(' '))), project)
  const calls = manager.calls(), sessionId = calls.find(call => call.action === 'reserve')?.sessionId
  assert.ok(sessionId)
  const reserve = { action: 'reserve', route: cursorRoute, sessionId }, complete = { action: 'settle', route: cursorRoute, sessionId, outcome: protocol ? 'stopped' : quota ? 'quota' : 'completed' }
  if (!settle) {
    const [{ realm, raw }] = attempts
    assert.equal(status, 1, JSON.stringify(result.diagnostics))
    assert.deepEqual(calls, [{ action: 'resolve' }, reserve, complete, { ...complete, outcome: 'stopped' }])
    assert.equal(result.status, 'recovery_required')
    assert.deepEqual(result.diagnostics, [raw.diagnostic])
    assert.equal(raw.diagnostic.code, 'native_review_recovery_required')
    assert.deepEqual(result.runs, [])
    assert.equal(git(join(realm, 'source'), ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 2)
    return
  }
  if (protocol) {
    assert.equal(status, 1, JSON.stringify(result.diagnostics))
    assert.deepEqual(calls, [{ action: 'resolve' }, reserve, complete])
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.runs, [])
    assert.equal(attempts[0].raw.stoppedQuota, undefined)
    return
  }
  assert.equal(result.review?.verdict, 'accept', JSON.stringify(result.diagnostics))
  assert.equal(result.trace?.threadId, quota ? 'cursor-conformance-native-successor' : 'cursor-conformance-native')
  if (quota) {
    const first = attempts.find(attempt => attempt.raw.diagnostic?.code === 'provider_quota_exhausted')!
    assert.equal(first.raw.stoppedQuota.sessionId, sessionId)
    assert.equal(git(join(first.realm, 'source'), ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1)
    assert.notEqual(result.trace.sessionId, sessionId)
    const launches = attempts.map(({ realm, raw }) => {
      const projects = join(realm, 'runtime', 'projects')
      return readFileSync(join(projects, readdirSync(projects)[0], 'sessions', raw.stoppedQuota?.sessionId ?? raw.result.sessionId, 'launch'), 'utf8')
    })
    assert.ok(launches[0] === launches[1], '正式续路保持完整冻结提示原字节')
    assert.deepEqual(calls, [{ action: 'resolve' }, reserve, complete,
      { action: 'resolve', nextAfter: cursorRoute, sameGroupAs: cursorRoute, failedSessionId: sessionId },
      { action: 'reserve', route: successorRoute, sessionId: result.trace.sessionId },
      { action: 'settle', route: successorRoute, sessionId: result.trace.sessionId, outcome: 'completed' }])
  } else {
    assert.equal(result.trace.sessionId, sessionId)
    assert.deepEqual(calls, [{ action: 'resolve' }, reserve, complete])
  }
  const { raw } = attempts.find(attempt => attempt.raw.result)!
  assert.equal(existsSync(raw.result.worktree.worktreePath), false)
  assert.equal(raw.result.worktree.headCommit, candidate)
  assert.equal(status, 2, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['verification'], '模拟环境明确阻断 Docker 执行')
})

test('Manager 大正文缺少逐字读取证明时保留完整冻结输入并阻断派发', t => {
  const repo = fixture(), manager = managerFixture(t, cursorRoute)
  t.after(() => rmSync(repo.root, { recursive: true, force: true }))
  const large = `${implementation}\n/* ${'x'.repeat(FROZEN_PROMPT_THRESHOLD_BYTES)} END-FROZEN-CONTEXT */\n`
  put(repo.root, 'src/greet.mjs', large)
  const { status, result } = publicCheck(t, repo.input(save(repo.root)), manager.config)
  assert.equal(status, 2, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['unsupported_managed_frozen_reader'])
  const frozen = JSON.parse(readFileSync(join(result.evidenceDirectory, 'input.json'), 'utf8')) as ReviewContext
  assert.deepEqual(frozen.readSet.find(file => file.path === 'src/greet.mjs'), { path: 'src/greet.mjs', before: implementation, candidate: large })
  assert.deepEqual(manager.calls(), [{ action: 'resolve', capability: 'frozen-reader-v2' }])
  assert.deepEqual(result.runs, [])
})

const managedFrozenTestRuntime = process.env.SPEX_MANAGER_FROZEN_TEST_RUNTIME
for (const mode of ['completed', 'quota', 'metadata-rejected', 'audit-rejected', 'audit-references-unknown']) test(`公开 sync check 的 Manager 持久 Codex 独占资源 ${mode}`, { skip: !managedFrozenTestRuntime || process.platform !== 'darwin' }, t => {
  const quota = mode === 'quota'
  const auditRejected = mode.startsWith('audit-')

  const repo = fixture(), nativeModel = 'gpt-6.1-sol'
  t.after(() => rmSync(repo.root, { recursive: true, force: true }))
  const cliVersion = 'codex-cli 0.160.0', fixtureBin = String.raw`#!${process.execPath}
const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { createHash } = require('node:crypto')
const { join, dirname, basename } = require('node:path')
const { execFileSync } = require('node:child_process')
if (process.argv[2] === '--version') { console.log(${JSON.stringify(cliVersion)}); process.exit(0) }
const model = ${JSON.stringify(nativeModel)}, identity = '10000000-0000-4000-8000-000000000000', turn = { id: 'turn-frozen-original', status: 'inProgress' }
const home = process.env.CODEX_HOME, settings = readFileSync(join(home, 'config.toml'), 'utf8')
writeFileSync(join(home, 'test-runtime.pid'), String(process.pid))
const runtimeLabel = home.includes('/metadata/') ? 'metadata' : 'review'
const mode = ${JSON.stringify(mode)}
const auditRejected = runtimeLabel === 'review' && mode.startsWith('audit-')
const catalog = settings.match(/^model_catalog_json = (.+)$/m), limit = Number(settings.match(/^tool_output_token_limit = (.+)$/m)?.[1])
writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ client_version: '0.160.0', models: [{ slug: model, apply_patch_tool_type: 'freeform', experimental_supported_tools: [] }] }))
const disabled = Object.fromEntries(${JSON.stringify(frozenReaderDisabledFeatures)}.map(feature => [feature, false]))
let cwd, path, archived = false, endpoint = false
const items = [], ranges = new Map(), outputs = new Map()
const socketPath = process.argv.find(arg => arg.startsWith('unix://')).slice(7)
const server = createServer(socket => {
  let buffer = Buffer.alloc(0), ready = false
  const send = value => {
    const bytes = Buffer.from(JSON.stringify(value)), header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.alloc(bytes.length < 65536 ? 4 : 10)
    if (bytes.length >= 126) { header[0] = 0x81; header[1] = header.length === 4 ? 126 : 127; if (header.length === 4) header.writeUInt16BE(bytes.length, 2); else header.writeBigUInt64BE(BigInt(bytes.length), 2) }
    socket.write(Buffer.concat([header, bytes]))
  }
  const methods = {
    initialize: () => ({}), 'model/list': () => ({ data: mode === 'metadata-rejected' ? [] : [{ id: model, model, slug: model }], nextCursor: null }),
    'config/read': () => ({ config: { sandbox_mode: auditRejected ? 'workspace-write' : 'read-only', approval_policy: 'never', model_catalog_json: JSON.parse(catalog[1]), tool_output_token_limit: limit,
      features: { apps: false, plugins: false, hooks: false, shell_tool: false, code_mode: false, code_mode_host: true, ...disabled }, mcp_servers: {} } }),
    'hooks/list': () => ({ data: [{ hooks: [], errors: [] }] }), 'mcpServerStatus/list': () => ({ data: [], nextCursor: null }),
    'thread/start': p => {
      assert.equal(auditRejected, false)
      assert.equal(p.model, model); assert.equal(p.ephemeral, false); assert.deepEqual(p.dynamicTools.map(tool => tool.name), ['spex_read_frozen'])
      cwd = p.cwd; path = join(home, 'sessions', 'rollout-2026-11-27T00-00-00-' + identity + '.jsonl'); mkdirSync(dirname(path), { recursive: true })
      return { thread: { id: identity, cwd, path, ephemeral: false }, model }
    },
    'thread/read': p => { assert.equal(p.threadId, identity); return { thread: { id: identity, cwd, path, turns: p.includeTurns ? [{ ...turn, items }] : [] } } },
    'thread/turns/list': p => { assert.equal(p.threadId, identity); return { data: [{ ...turn }], nextCursor: null } },
    'thread/items/list': p => { assert.equal(p.threadId, identity); assert.equal(p.turnId, turn.id); return { data: items.map(item => ({ turnId: turn.id, item })), nextCursor: null } },
    'thread/list': p => ({ data: cwd && p.archived === archived ? [{ id: identity, cwd }] : [], nextCursor: null }),
    'thread/loaded/list': () => ({ data: runtimeLabel === 'review' && mode === 'audit-references-unknown' ? ['unowned-thread'] : cwd && !archived ? [identity] : [], nextCursor: null }),
    'thread/archive': p => {
      assert.equal(p.threadId, identity); assert.ok(['completed', 'failed'].includes(turn.status)); assert.equal(archived, false)
      const archive = join(home, 'archived_sessions', basename(path)); mkdirSync(dirname(archive), { recursive: true }); renameSync(path, archive); path = archive; archived = true
      return {}
    },
    'turn/start': p => {
      assert.equal(p.threadId, identity); assert.equal(p.model, model); assert.equal(p.cwd, cwd)
      const prompt = p.input[0].text, index = JSON.parse(prompt.split('\n').at(-1))
      assert.equal(prompt.includes('candidate-body-ends'), false); items.push({ type: 'userMessage', content: p.input })
      if (${quota} && home.includes('c'.repeat(64))) {
        writeFileSync(path, [{ type: 'session_meta', payload: { id: identity, cwd } }, { type: 'turn_context', payload: { turn_id: turn.id } },
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } }].map(row => JSON.stringify(row)).join('\n') + '\n')
        turn.status = 'failed'; turn.error = { codexErrorInfo: 'usageLimitExceeded' }
        setImmediate(() => send({ method: 'turn/completed', params: { threadId: identity, turn } }))
        return { turn: { ...turn } }
      }
      let id = 100
      setImmediate(() => { for (const batch of index.readBatches) for (const range of batch.ranges) {
        const args = { contextDigest: index.contextDigest, entryId: batch.entryId, ...range }, next = id++
        ranges.set(next, args); send({ id: next, method: 'item/tool/call', params: { threadId: identity, turnId: turn.id, callId: String(next), tool: 'spex_read_frozen', arguments: args } })
      } })
      return { turn: { ...turn } }
    },
  }
  const handle = request => {
    if (request.method && request.id !== undefined) { assert.ok(methods[request.method], request.method); send({ id: request.id, result: methods[request.method](request.params) }); return }
    if (!ranges.has(request.id)) return
    const args = ranges.get(request.id), text = request.result.contentItems[0].text, reply = JSON.parse(text)
    outputs.set(request.id, { text, bytes: Buffer.from(reply.text).subarray(args.startByte - (reply.decodedStartByte ?? args.startByte), args.endByte - (reply.decodedStartByte ?? args.startByte)) })
    items.push({ type: 'dynamicToolCall', id: String(request.id), tool: 'spex_read_frozen', status: 'completed', arguments: args, ...request.result })
    if (outputs.size !== ranges.size || endpoint) return
    endpoint = true
    const full = Buffer.concat([...outputs].sort(([a], [b]) => a - b).map(([, output]) => output.bytes)).toString('utf8')
    const context = JSON.parse(full.split('\n冻结完整输入:\n')[1])
    const source = context.readSet.find(item => item.path === 'src/greet.mjs')
    assert.ok(source.candidate.includes('candidate-body-ends')); assert.equal(readFileSync(join(cwd, source.path), 'utf8'), source.candidate)
    assert.equal(execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), context.identities.candidateCommit)
    assert.equal(execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), context.identities.candidateTree)
    writeFileSync(path, [{ type: 'session_meta', payload: { id: identity, cwd } }, { type: 'turn_context', payload: { turn_id: turn.id } },
      ...[...outputs].flatMap(([id, output]) => [{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: String(id) } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: String(id), output: output.text }, metadata: { fallback_token_limit_override: Math.ceil(limit * 1.2) } }]),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn.id } }].map(row => JSON.stringify(row)).join('\n') + '\n')
    items.push({ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ inputId: context.inputId, candidateDigest: context.candidateDigest, checkedIds: context.scope.itemIds, verdict: 'accept', findings: [] }) })
    turn.status = 'completed'; send({ method: 'turn/completed', params: { threadId: identity, turn } })
  }
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (!ready) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return
      const key = buffer.subarray(0, end).toString().match(/^Sec-WebSocket-Key: (.+)$/im)?.[1]
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      buffer = buffer.subarray(end + 4); ready = true
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, masked = !!(buffer[1] & 128); let length = buffer[1] & 127, offset = 2
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4 }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10 }
      const start = offset + (masked ? 4 : 0); if (buffer.length < start + length) return
      const data = Buffer.from(buffer.subarray(start, start + length)); if (masked) for (let i = 0; i < length; i++) data[i] ^= buffer[offset + i % 4]
      buffer = buffer.subarray(start + length); if (opcode === 1) handle(JSON.parse(data.toString()))
    }
  })
})
server.listen(socketPath)
setTimeout(() => process.exit(1), 30_000).unref()
`
  const route = { routeId: 'c'.repeat(64), vendor: 'codex', model: nativeModel, kind: 'cli', frozenReader: { capability: 'frozen-reader-v2', protocol: 'codex-persistent-v2', model: nativeModel, cliVersion, cliSha256: contentHash(fixtureBin) } } as const
  const successor = quota ? { ...route, routeId: 'd'.repeat(64) } : undefined
  const manager = managerFixture(t, route, true, successor, managedFrozenTestRuntime)
  writeFileSync(join(manager.host, 'codex'), fixtureBin, { mode: 0o700 })
  put(repo.root, 'src/greet.mjs', `${implementation}\n/* ${'x'.repeat(FROZEN_PROMPT_THRESHOLD_BYTES)} candidate-body-ends */\n`)
  const candidate = save(repo.root), original = git(repo.root, ['worktree', 'list', '--porcelain'])
  const { status, result } = publicCheck(t, repo.input(candidate), manager.config)
  if (mode === 'metadata-rejected' || auditRejected) {
    const realm = readdirSync(result.evidenceDirectory).find(name => name.startsWith('review-'))!
    const runtime = join(result.evidenceDirectory, realm, 'runtime', 'projects')
    const markers = readdirSync(runtime, { recursive: true }).filter(name => String(name).endsWith('/test-runtime.pid'))
    const endpoint = markers.find(name => String(name).includes(auditRejected ? '/structured-managed-frozen-worktree-v1/' : '/metadata/'))
    assert.ok(endpoint)
    const pid = Number(readFileSync(join(runtime, String(endpoint)), 'utf8'))
    try {
      assert.equal(status, mode === 'metadata-rejected' ? 2 : 1, JSON.stringify(result.diagnostics))
      assert.equal(result.review, null)
      if (mode === 'audit-references-unknown') {
        assert.deepEqual(result.diagnostics.map(({ code }) => code), ['native_review_recovery_required'])
        assert.deepEqual(manager.calls().map(call => call.action), ['resolve', 'reserve'])
        assert.doesNotThrow(() => process.kill(pid, 0))
      } else {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '独占进程须在返回诊断前停止')
        assert.deepEqual(manager.calls().map(call => call.action), auditRejected ? ['resolve', 'reserve', 'settle'] : ['resolve'])
      }
    } finally {
      // 旧实现或故意不完整的资源证明可能保留本测试自己的进程。
      try { process.kill(pid, 'SIGTERM') } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH') }
    }
    return
  }
  assert.equal(result.review?.verdict, 'accept', JSON.stringify(result.diagnostics))
  const accepted = successor ?? route
  assert.deepEqual(result.reviewRoute, accepted)
  const calls = manager.calls(), firstId = calls[1].sessionId
  assert.ok(firstId)
  if (quota) assert.notEqual(firstId, result.trace?.sessionId)
  assert.deepEqual(calls, [{ action: 'resolve', capability: 'frozen-reader-v2' }, { action: 'reserve', route, sessionId: firstId },
    ...(quota ? [{ action: 'settle', route, sessionId: firstId, outcome: 'quota' },
      { action: 'resolve', nextAfter: route, sameGroupAs: route, failedSessionId: firstId, capability: 'frozen-reader-v2' },
      { action: 'reserve', route: accepted, sessionId: result.trace?.sessionId }] : []),
    { action: 'settle', route: accepted, sessionId: result.trace?.sessionId, outcome: 'completed' }])
  const realms = readdirSync(result.evidenceDirectory).filter(name => name.startsWith('review-'))
  assert.equal(realms.length, quota ? 2 : 1)
  for (const realm of realms.map(name => join(result.evidenceDirectory, name))) {
    const worker = JSON.parse(readFileSync(join(realm, 'native-result.json'), 'utf8'))
    if (worker.result) {
      assert.equal(worker.result.frozenReadProof.version, 2)
      assert.deepEqual(worker.result.frozenReadProof.coveredEntryIds, ['task'])
      assert.equal(worker.result.worktree.headCommit, candidate)
      assert.equal(existsSync(worker.result.worktree.worktreePath), false)
    } else {
      assert.equal(worker.diagnostic.code, 'provider_quota_exhausted')
      assert.equal(worker.stoppedQuota.sessionId, firstId)
    }
    const runtime = join(realm, 'runtime', 'projects')
    const runtimePidPath = readdirSync(runtime, { recursive: true }).find(name => String(name).includes('/structured-managed-frozen-worktree-v1/') && String(name).endsWith('/test-runtime.pid'))
    assert.ok(runtimePidPath)
    const pid = Number(readFileSync(join(runtime, String(runtimePidPath)), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'review process has exited before V2 publication')
  }
  assert.equal(git(repo.root, ['worktree', 'list', '--porcelain']), original)
  assert.equal(status, 2, JSON.stringify(result.diagnostics))
  assert.deepEqual(result.diagnostics.map(({ code }) => code), ['verification'], 'fixture stops at Docker availability')
})

for (const mode of ['finite', 'unlimited', 'configured'] as const) test(`unlimited CI独审单次timeout ${mode} 保持有限且不依赖总cap`, async () => {
  const repo = fixture()
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: { ...settings, budget: mode === 'finite' ? settings.budget : { mode: 'unlimited' }, ...(mode === 'configured' ? { callTimeoutMs: 1200000 } : {}) } }))
  const policy = mode === 'finite' ? repo.base : save(repo.root)
  put(repo.root, 'src/greet.mjs', `${implementation}\n// same business behavior\n`)
  let seen = false
  const result = await runConformance({ repository: repo.root, baseCommit: policy, policyCommit: policy, candidateCommit: save(repo.root) }, { testReviewRunner: reviewer((_review, _context, request) => {
    seen = true; assert.equal(request.timeoutMs, mode === 'finite' ? 60000 : mode === 'configured' ? 1200000 : 120000)
  }), testVerificationDriver: noDocker })
  assert.equal(seen, true, JSON.stringify(result.diagnostics)); assert.equal(result.review!.verdict, 'accept')
  assert.notEqual(result.status, 'passed', '注入Docker不可用不能被无限预算绕过')
})

test('受信政策未登记精确raw差量时，程序门禁拒绝并保留前后摘要', async () => {
  const repo = fixture()
  put(repo.root, specPath, source.replaceAll('hi', 'hello'))
  put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello'))
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const result = await runConformance({ ...repo.input(save(repo.root)), ...evidence('unauthorized') }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].code, 'intent_unauthorized')
  const { source: _source, ...expected } = authorization(source, source.replaceAll('hi', 'hello'))
  assert.deepEqual(result.intentAuthorization.changes, [{ ...expected, authorization: null }])
  assert.equal(result.review, null)
  assert.equal(result.runs.length, 0)
})

test('受信policy中的错路径/前后摘要不授权，非法文件在独审前失败', async () => {
  for (const variant of ['path', 'before', 'after', 'missing-null', 'binary', 'symlink'] as const) {
    const repo = fixture(), changed = source.replaceAll('hi', 'hello')
    put(repo.root, specPath, changed)
    const candidate = save(repo.root), record = authorization(source, changed)
    if (variant === 'path') record.path = '.spec/product/other/spec.md'
    if (variant === 'before') record.beforeRawDigest = contentHash('不同旧原意')
    if (variant === 'after') record.afterRawDigest = contentHash('不同新原意')
    let input = authorized(repo, candidate, [record])
    if (['missing-null', 'binary', 'symlink'].includes(variant)) {
      git(repo.root, ['checkout', '--detach', '-q', input.policyCommit])
      if (variant === 'missing-null') { const { beforeRawDigest: _before, ...missing } = record; put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [missing] })) }
      if (variant === 'binary') writeFileSync(join(repo.root, INTENT_AUTHORIZATION_PATH), Buffer.from([0xff, 0x00]))
      if (variant === 'symlink') { rmSync(join(repo.root, INTENT_AUTHORIZATION_PATH)); symlinkSync('spexcode.json', join(repo.root, INTENT_AUTHORIZATION_PATH)) }
      input = { ...input, policyCommit: save(repo.root) }
      git(repo.root, ['checkout', '--detach', '-q', candidate])
    }
    const result = await runConformance(input, { testReviewRunner: async () => assert.fail(`${variant}不应派发独审`) })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.diagnostics[0].code, ['missing-null', 'binary', 'symlink'].includes(variant) ? 'invalid_intent_authorizations' : 'intent_unauthorized')
    assert.equal(result.intentAuthorization.changes[0].afterRawDigest, contentHash('用户请求时返回 hello。'))
    assert.equal(result.review, null)
  }
})

test('候选自行登记无法授权；同一候选只有外部选定精确policyCommit后才能进入独审', async () => {
  const repo = fixture(), changed = source.replaceAll('hi', 'hello'), record = authorization(source, changed)
  put(repo.root, specPath, changed)
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [record] }))
  const candidate = save(repo.root), input = authorized(repo, candidate, [record])
  const untrusted = await runConformance(repo.input(candidate), { testReviewRunner: async () => assert.fail('候选记录不能自批') })
  assert.equal(untrusted.diagnostics[0].code, 'intent_unauthorized')
  let reviewed = false
  const trusted = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    reviewed = true
    assert.equal(value.identities.policyCommit, input.policyCommit)
    assert.equal(value.intentAuthorization.artifactDigest, contentHash(JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [record] })))
    assert.equal(value.intentChanges[0].beforeRaw, '用户请求时返回 hi。')
    assert.equal(value.intentChanges[0].afterRaw, '用户请求时返回 hello。')
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '受信授权只确认需求，当前实现仍返回hi', counterexample: '请求仍得到hi', message: '已授权Spec-only仍缺实现' }]
  }) })
  assert.equal(reviewed, true); assert.equal(trusted.diagnostics[0].code, 'review_rejected')
  put(repo.root, specPath, changed.replaceAll('hello', 'forged'))
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [authorization(source, changed.replaceAll('hello', 'forged'))] }))
  const tampered = await runConformance({ ...input, candidateCommit: save(repo.root) }, { testReviewRunner: async () => assert.fail('候选篡改登记不能改变受信政策') })
  assert.equal(tampered.diagnostics[0].code, 'intent_unauthorized')
})

test('原意精确授权不绕过旧稳定ID、退役负向断言、固定命令与保护oracle', async () => {
  for (const variant of ['old-case', 'retirement', 'command', 'oracle'] as const) {
    const repo = fixture(), trusted = structuredClone(settings)
    if (variant === 'oracle') {
      trusted.verifications[0].definition.command.push('checks/greet.test.mjs')
      put(repo.root, specPath, source.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(trusted.verifications[0].definition.command)))
      put(repo.root, 'checks/greet.test.mjs', 'import test from "node:test"; test("ORACLE-GREET fixed", () => {});\n')
      put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: { ...trusted, mandatoryTests: [{ verificationId: 'VERIFY-GREET-01', testPath: 'checks/greet.test.mjs', testId: 'ORACLE-GREET' }] } }))
    }
    const base = variant === 'oracle' ? save(repo.root) : repo.base
    const baseline = git(repo.root, ['show', `${base}:${specPath}`]), changed = baseline.replaceAll('hi', 'hello')
    put(repo.root, specPath, variant === 'old-case' ? changed.replaceAll('CASE-GREET', 'CASE-NEW') : variant === 'retirement' ? changed.replaceAll('AC-GREET-01', 'AC-GREET-02') : variant === 'command' ? changed.replace('["node","--test","tests/greet.test.mjs"]', '["node","--test","tests/empty.test.mjs"]') : changed)
    if (variant === 'old-case') put(repo.root, 'tests/greet.test.mjs', assertion.replaceAll('CASE-GREET', 'CASE-NEW'))
    if (variant === 'oracle') put(repo.root, 'checks/greet.test.mjs', 'import test from "node:test"; test("ORACLE-GREET weak", () => {});\n')
    const candidate = save(repo.root), input = authorized({ ...repo, base }, candidate, [authorization(baseline, changed)])
    const result = await runConformance({ ...input, baseCommit: base }, { testReviewRunner: async () => assert.fail(`${variant}不应派发独审`) })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.diagnostics[0].code, { 'old-case': 'old_test_binding', retirement: 'retirement_negative_missing', command: 'conformance_failed', oracle: 'oracle_changed' }[variant])
    if (variant === 'command') assert.match(result.diagnostics[0].message, /未登记或被更改的验证命令/)
  }
})

test('精确授权后错误实现仍由独立审查拒绝，授权不等于业务验收通过', async () => {
  const repo = fixture(), changed = source.replaceAll('hi', 'hello')
  put(repo.root, specPath, changed)
  put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'wrong'))
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const input = authorized(repo, save(repo.root))
  const result = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    assert.ok(value.intentAuthorization.changes[0].authorization)
    assert.match(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate!, /wrong/)
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '实现返回wrong，授权新需求要求hello', counterexample: '请求得到wrong', message: '实现不满足已授权需求' }]
  }) })
  assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0].code, 'review_rejected'); assert.equal(result.runs.length, 0)
})

test('纯授权policy提交只验证A差量，无关B原意不索取登记或派发B验证', async () => {
  const repo = fixture(), policy = structuredClone(settings)
  policy.readPaths = []
  const other = structuredClone(policy.verifications[0]); other.definition.id = 'VERIFY-BYE-01'; other.definition.command = ['node', '--test', 'tests/bye.test.mjs']; policy.verifications.push(other)
  const byePath = '.spec/product/bye/spec.md'
  put(repo.root, byePath, source.replaceAll('GREET', 'BYE').replaceAll('greeting', 'bye').replaceAll('greet', 'bye').replace('用户请求时返回 hi。', 'B独立需求不在A的授权范围。'))
  put(repo.root, 'src/bye.mjs', implementation.replaceAll('greet', 'bye')); put(repo.root, 'tests/bye.test.mjs', assertion.replaceAll('GREET', 'BYE').replaceAll('greet', 'bye'))
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: policy }))
  const base = save(repo.root), changed = source.replaceAll('hi', 'hello')
  put(repo.root, specPath, changed); put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello')); put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const input = authorized({ ...repo, base }, save(repo.root), [authorization(source, changed)])
  const result = await runConformance({ ...input, baseCommit: base }, { testReviewRunner: reviewer((_review, value) => {
    assert.deepEqual(value.scope.itemIds.filter(id => id.includes('BYE')), [])
    assert.ok(!value.readSet.some(file => file.path === byePath || file.path.includes('/bye.')))
    assert.equal(value.intentChanges.length, 1); assert.equal(value.intentChanges[0].path, specPath)
  }), testVerificationDriver: noDocker })
  assert.equal(result.status, 'unsupported', JSON.stringify(result.diagnostics))
  assert.deepEqual(result.scope.nodeIds, ['greeting'])
  assert.equal(result.runs.length, 1)
  assert.deepEqual(result.runs[0].bindings.map(binding => binding.testId), ['CASE-GREET'])
})

test('节点移动需要旧路径删除与新路径新增两条精确登记，不能从相同raw继承授权', async () => {
  const repo = fixture(), nextPath = '.spec/product/greeting-next/spec.md'
  put(repo.root, nextPath, source.replace('RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting |', 'RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting-next |'))
  rmSync(join(repo.root, specPath))
  const candidate = save(repo.root), records = [authorization(source, null), authorization(null, source, nextPath)]
  const incomplete = await runConformance(authorized(repo, candidate, [records[0]]), { testReviewRunner: async () => assert.fail('移动的新增路径也需要精确授权') })
  assert.equal(incomplete.diagnostics[0].code, 'intent_unauthorized')
  const complete = await runConformance(authorized(repo, candidate, records), { testReviewRunner: reviewer((_review, value) => {
    assert.equal(value.intentChanges.length, 2)
    assert.ok(value.intentAuthorization.changes.every(change => change.authorization))
  }), testVerificationDriver: noDocker })
  assert.equal(complete.status, 'unsupported', JSON.stringify(complete.diagnostics)); assert.equal(complete.runs.length, 1)
})

test('超过2MiB的跨机器候选全文仍进入独审，不以大小绕过或截断旧新断言', async () => {
  const repo = fixture(), large = `${implementation}\n/* BEGIN-CONTEXT ${'x'.repeat(2 * 1024 * 1024)} END-CONTEXT */\n`
  put(repo.root, 'src/greet.mjs', large)
  let checked = false
  const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer((review, value, request) => {
    checked = true
    assert.ok(Buffer.byteLength(request.prompt) > 2 * 1024 * 1024)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.before, implementation)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate, large)
    assert.equal(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate, assertion)
    review.verdict = 'repair'
    review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '完整读集合已交给独立审查；受控接缝明确拒绝', counterexample: '独立审查拒绝不能因上下文过大被跳过', message: '受控拒绝' }]
  }) })
  assert.equal(checked, true)
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].code, 'review_rejected')
  assert.equal(result.runs.length, 0)
})

test('AC-CONFORMANCE-01 Spec-only未实现由独审拒绝；完整源码与真实Git身份都进入审查', async () => {
  const repo = fixture(); put(repo.root, specPath, source.replaceAll('hi', 'hello')); const candidate = save(repo.root)
  const input = authorized(repo, candidate)
  const result = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    assert.equal(value.identities.candidateCommit, candidate); assert.equal(value.identities.policyCommit, input.policyCommit)
    assert.equal(value.intentAuthorization.changes[0].authorization?.source, '用户明确修改问候需求的受信记录')
    assert.equal(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate, assertion)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate, implementation)
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '冻结需求要求hello但实现与完整断言仍为hi', counterexample: '请求返回hi', message: '缺少实现' }]
  }) })
  assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0].code, 'review_rejected'); assert.equal(result.reviewExecution, 'injected'); assert.equal(result.runs.length, 0)
})

test('AC-CONFORMANCE-02 删除schema/整个node/AC/test或放宽命令仍进入旧治理闭包且失败', async () => {
  for (const variant of ['schema', 'node', 'ac', 'test', 'command', 'related'] as const) {
    const repo = fixture()
    if (variant === 'schema') put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', ''))
    if (variant === 'node') rmSync(join(repo.root, specPath))
    if (variant === 'ac') put(repo.root, specPath, source.replace(/^\| AC-GREET-01 .*\n/m, ''))
    if (variant === 'test') rmSync(join(repo.root, 'tests/greet.test.mjs'))
    if (variant === 'command') put(repo.root, specPath, source.replace('"tests/greet.test.mjs"', '"tests/empty.test.mjs"'))
    if (variant === 'related') put(repo.root, specPath, source.replace('code:\n', 'related:\n  - REQ-GREET-01\ncode:\n'))
    const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.ok(result.scope.nodeIds.includes('greeting')); assert.ok(result.scope.itemIds.includes('AC-GREET-01')); assert.equal(result.runs.length, 0)
  }
})

test('AC-CONFORMANCE-03 独立clone无本机DB与receipt仍重算；无关修改不强制整个仓库验收', async () => {
  const repo = fixture(); put(repo.root, 'README.md', 'unrelated\n'); const candidate = save(repo.root)
  const clone = mkdtempSync(join(tmpdir(), 'spex-conformance-clone-')); git(clone, ['clone', '--no-local', '-q', repo.root, '.'])
  const before = git(clone, ['status', '--porcelain=v1'])
  const result = await runConformance({ ...repo.input(candidate), repository: clone }, { testReviewRunner: async () => assert.fail('unrelated不派发模型'), testVerificationDriver: async () => assert.fail('unrelated不派发验收') })
  assert.equal(result.status, 'not_applicable'); assert.equal(result.applicable, false); assert.deepEqual(result.unmanagedPaths, ['README.md']); assert.equal(git(clone, ['status', '--porcelain=v1']), before); assert.equal(git(clone, ['rev-parse', 'HEAD']), candidate)
})

test('AC-CONFORMANCE-04 错candidate/readset/policy绑定与缺失语义/Docker不能伪通过', async () => {
  const repo = fixture(); put(repo.root, 'src/greet.mjs', implementation + '// internal refactor\n'); const candidate = save(repo.root)
  for (const corrupt of ['candidateDigest', 'inputId'] as const) {
    const result = await runConformance(repo.input(candidate), { testReviewRunner: reviewer(review => { review[corrupt] = 'forged' }), testVerificationDriver: noDocker })
    assert.equal(result.status, 'failed'); assert.match(result.diagnostics[0].message, /不匹配/)
  }
  const unsupported = await runConformance(repo.input(candidate), { testReviewRunner: async () => { throw Object.assign(new Error('readonly native unavailable'), { code: 'unsupported' }) } })
  assert.equal(unsupported.status, 'unsupported')
  const docker = await runConformance(repo.input(candidate), { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(docker.status, 'unsupported'); assert.equal(docker.verificationExecution, 'injected')
  const policy = structuredClone(settings); policy.verifications[0].definition.command = ['node', '--test', 'tests/empty.test.mjs']
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: policy })); put(repo.root, specPath, source.replace('"tests/greet.test.mjs"', '"tests/empty.test.mjs"'))
  const changed = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer() })
  assert.equal(changed.status, 'unsupported'); assert.equal(changed.diagnostics[0].code, 'unsupported_policy_update')
  assert.equal((await runConformance({ ...repo.input(candidate), candidateCommit: 'HEAD' })).status, 'failed')
})

const docker = process.env.SPEX_DOCKER_VERIFICATION_TEST === '1'
test('AC-CONFORMANCE-05 完整业务变更在独立clone与真实Docker通过；注入审查明确标记', { skip: !docker }, async () => {
  const repo = fixture(); put(repo.root, specPath, source.replaceAll('hi', 'hello')); put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello')); put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const candidate = save(repo.root), input = authorized(repo, candidate), clone = mkdtempSync(join(tmpdir(), 'spex-conformance-docker-clone-')); git(clone, ['clone', '--no-local', '-q', repo.root, '.'])
  git(clone, ['fetch', '-q', repo.root, input.policyCommit])
  const index = readFileSync(join(clone, '.git/index')), head = git(clone, ['rev-parse', 'HEAD'])
  const result = await runConformance({ ...input, repository: clone, ...evidence('authorized-docker') }, { testReviewRunner: reviewer((_review, value) => {
    assert.equal(value.intentChanges[0].beforeRaw, '用户请求时返回 hi。')
    assert.equal(value.intentChanges[0].afterRaw, '用户请求时返回 hello。')
    assert.ok(value.intentAuthorization.changes[0].authorization)
  }) })
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics)); assert.equal(result.reviewExecution, 'injected'); assert.equal(result.verificationExecution, 'docker'); assert.equal(result.runs.length, 1); assert.equal(result.runs[0].result.evidence!.environment.driver, 'docker')
  assert.deepEqual(readFileSync(join(clone, '.git/index')), index); assert.equal(git(clone, ['rev-parse', 'HEAD']), head); assert.equal(git(clone, ['status', '--porcelain=v1']), '')
})

test('AC-CONFORMANCE-06 合法AC退役保留旧负向用例与固定命令；新旧政策命令并集都真实执行', { skip: !docker }, async () => {
  const repo = fixture()
  const newSource = source.replaceAll('返回 hi', '明确拒绝问候').replace('用户请求时返回 hi。', '用户明确撤销问候，所有请求必须拒绝。').replace('| AC-GREET-01 |', '| AC-GREET-01-NEW |').replace('#CASE-GREET', '#CASE-REJECTED')
  put(repo.root, specPath, newSource)
  put(repo.root, 'src/greet.mjs', 'export function greet() { throw new Error("retired") }\n')
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('assert.equal(greet(), "hi")', 'assert.throws(() => greet(), /retired/)') + 'test("CASE-REJECTED negative", () => assert.throws(() => greet(), /retired/));\n')
  const candidate = save(repo.root)
  const result = await runConformance({ ...authorized(repo, candidate), ...evidence('retirement-docker') }, { testReviewRunner: reviewer((_review, value) => { assert.ok(value.scope.retiredIds.includes('AC-GREET-01')); assert.match(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate!, /assert\.throws/); assert.match(value.readSet.find(file => file.path === specPath)!.before!, /AC-GREET-01/) }) })
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics)); assert.deepEqual(result.runs[0].result.evidence!.tests.map(row => row.testId).sort(), ['CASE-GREET', 'CASE-REJECTED'])
  const trusted = structuredClone(settings); trusted.verifications[0].definition.command = ['node', '--test', '--test-concurrency=1', 'tests/greet.test.mjs']
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: trusted })); put(repo.root, specPath, newSource.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(trusted.verifications[0].definition.command)))
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [authorization(source, newSource)] }))
  const approvedPolicy = save(repo.root)
  const evolved = await runConformance({ ...repo.input(approvedPolicy), policyCommit: approvedPolicy, ...evidence('policy-evolution-docker') }, { testReviewRunner: reviewer() })
  assert.equal(evolved.status, 'passed', JSON.stringify(evolved.diagnostics)); assert.equal(evolved.runs.length, 2); assert.ok(evolved.runs.every(run => run.result.status === 'passed'))
})


test('AC-CONFORMANCE-07 新raw未细化、未治理新源码、畸形契约和缺少旧稳定用例均不能自免检', async () => {
  for (const variant of ['raw', 'ungoverned', 'malformed', 'old-case'] as const) {
    const repo = fixture()
    if (variant === 'raw') put(repo.root, '.spec/product/new-feature/spec.md', '---\ntitle: 新功能\n---\n## raw source\n用户需要新功能\n## expanded spec\n尚未实现\n')
    if (variant === 'ungoverned') put(repo.root, 'src/new.mjs', 'export const unimplemented = true\n')
    if (variant === 'malformed') put(repo.root, specPath, source.replaceAll('REQ-GREET-01', 'BAD-ID'))
    if (variant === 'old-case') { put(repo.root, specPath, source.replaceAll('AC-GREET-01', 'AC-GREET-02').replaceAll('CASE-GREET', 'CASE-NEW')); put(repo.root, 'tests/greet.test.mjs', assertion.replaceAll('CASE-GREET', 'CASE-NEW')) }
    const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer() })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.review, null)
  }
})

test('AC-CONFORMANCE-08 真实CLI在新HOME跨进程复算，保留失败退出码且不依赖原DB', () => {
  const repo = fixture(); put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', '')); const candidate = save(repo.root)
  const freshHome = mkdtempSync(join(tmpdir(), 'spex-conformance-new-home-'))
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli.ts', import.meta.url)), 'sync', 'check', '--repository', repo.root, '--base', repo.base, '--candidate', candidate, '--json'], { cwd: repo.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: freshHome, SPEXCODE_HOME: join(freshHome, 'spex'), CODEX_HOME: join(freshHome, 'codex'), SPEX_SESSION_DATABASE_PATH: join(freshHome, 'spex/sessions.sqlite') } })
  assert.ifError(run.error); assert.equal(run.status, 1, run.stderr + run.stdout)
  const output = JSON.parse(run.stdout) as { status: string; reviewExecution: string; diagnostics: unknown[] }
  assert.equal(output.status, 'failed'); assert.equal(output.reviewExecution, 'native'); assert.ok(output.diagnostics.length)
  put(repo.root, specPath, source); put(repo.root, 'README.md', 'unrelated\n'); const unrelated = save(repo.root)
  const invoke = (tip: string) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli.ts', import.meta.url)), 'sync', 'check', '--repository', repo.root, '--base', repo.base, '--candidate', tip], { cwd: repo.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: freshHome, SPEXCODE_HOME: join(freshHome, 'spex'), CODEX_HOME: join(freshHome, 'codex'), SPEX_SESSION_DATABASE_PATH: join(freshHome, 'spex/sessions.sqlite') } })
  const passed = invoke(unrelated)
  assert.equal(passed.status, 0, passed.stderr + passed.stdout); assert.equal((JSON.parse(passed.stdout) as { applicable: boolean }).applicable, false)
  const untrustedPolicy = structuredClone(settings); untrustedPolicy.verifications[0].environment.version = 'candidate-self-policy'
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: untrustedPolicy })); const untrusted = save(repo.root)
  const unsupported = invoke(untrusted)
  assert.equal(unsupported.status, 2, unsupported.stderr + unsupported.stdout); assert.equal((JSON.parse(unsupported.stdout) as { status: string }).status, 'unsupported')
})

test('AC-CONFORMANCE-09 新旧真实VERIFY归属选择oracle，无关模块不强制运行或读取；删除owner不能缩小旧义务', async () => {
  const repo = fixture(), policy = structuredClone(settings)
  policy.readPaths = []
  const firstCommand = ['node', '--test', 'tests/greet.test.mjs', 'checks/greet.test.mjs']
  policy.verifications[0].definition.command = firstCommand
  const other = structuredClone(policy.verifications[0]); other.definition.id = 'VERIFY-BYE-01'; other.definition.command = ['node', '--test', 'tests/bye.test.mjs', 'checks/bye.test.mjs']; policy.verifications.push(other)
  const fullPolicy = { ...policy, mandatoryTests: [{ verificationId: 'VERIFY-GREET-01', testPath: 'checks/greet.test.mjs', testId: 'ORACLE-GREET' }, { verificationId: 'VERIFY-BYE-01', testPath: 'checks/bye.test.mjs', testId: 'ORACLE-BYE' }] }
  const firstSpec = source.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(firstCommand))
  put(repo.root, specPath, firstSpec)
  put(repo.root, '.spec/product/bye/spec.md', firstSpec.replaceAll('GREET', 'BYE').replaceAll('greeting', 'bye').replaceAll('greet', 'bye'))
  put(repo.root, 'src/bye.mjs', implementation.replaceAll('greet', 'bye')); put(repo.root, 'tests/bye.test.mjs', assertion.replaceAll('GREET', 'BYE').replaceAll('greet', 'bye'))
  for (const id of ['greet', 'bye']) put(repo.root, `checks/${id}.test.mjs`, `import test from "node:test"; test("ORACLE-${id.toUpperCase()} fixed", () => {});\n`)
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: fullPolicy })); const base = save(repo.root)
  put(repo.root, 'src/greet.mjs', implementation + '// refactor\n'); const candidate = save(repo.root)
  const result = await runConformance({ ...repo.input(candidate), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer((_review, value) => {
    assert.ok(value.scope.itemIds.includes('AC-GREET-01')); assert.ok(!value.scope.itemIds.includes('AC-BYE-01')); assert.ok(!value.readSet.some(file => file.path === 'checks/bye.test.mjs'))
  }), testVerificationDriver: noDocker })
  assert.equal(result.status, 'unsupported', JSON.stringify(result.diagnostics)); assert.equal(result.runs.length, 1)
  assert.deepEqual(result.runs[0].bindings.map(binding => binding.testId).sort(), ['CASE-GREET', 'ORACLE-GREET'])
  rmSync(join(repo.root, specPath)); const deleted = save(repo.root)
  const guarded = await runConformance({ ...repo.input(deleted), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(guarded.status, 'failed'); assert.ok(guarded.scope.itemIds.includes('VERIFY-GREET-01'))
})


test('AC-CONFORMANCE-10 无sync配置或既有非sync-v1范围明确未纳入，绝不空scope passed', async () => {
  const repo = fixture()
  put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', '')); put(repo.root, '.spec/spexcode.json', '{}'); const unconfiguredBase = save(repo.root)
  put(repo.root, 'README.md', 'unrelated\n'); const candidate = save(repo.root)
  const uncovered = await runConformance({ ...repo.input(candidate), baseCommit: unconfiguredBase, policyCommit: unconfiguredBase }, { testReviewRunner: reviewer() })
  assert.equal(uncovered.status, 'unsupported'); assert.equal(uncovered.coverage.mapping, 'unconfigured'); assert.deepEqual(uncovered.coverage.uncoveredNodeIds, ['greeting']); assert.equal(uncovered.diagnostics[0].code, 'unsupported_unconfigured'); assert.equal(uncovered.review, null)
  const configured = fixture(); put(configured.root, '.spec/product/legacy/spec.md', '---\ntitle: 旧需求\n---\n## raw source\n旧需求尚未迁移\n## expanded spec\n尚未纳入\n'); const base = save(configured.root)
  put(configured.root, 'src/greet.mjs', implementation + '// internal\n'); const changed = save(configured.root)
  const partial = await runConformance({ ...configured.input(changed), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(partial.coverage.mapping, 'partial'); assert.deepEqual(partial.coverage.uncoveredNodeIds, ['legacy']); assert.deepEqual(partial.coverage.governedNodeIds, ['greeting']); assert.equal(partial.verificationExtent, 'affected_scope')
})
