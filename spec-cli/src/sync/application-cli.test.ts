import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { SyncApplicationError } from './settings.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openProtocol } from '@spexcode/session-protocol'
import { migrateSyncStore } from './migrations.js'
import { SyncStore } from './store.js'
import { captureInputSnapshot, readEvidence } from './snapshot.js'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
function cli(args: string[], cwd = workspace): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), join(workspace, 'spec-cli/src/cli.ts'), ...args], { cwd, env: { ...process.env, SPEX_PROFILE: 'full' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString() })
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString() })
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }))
  })
}
test('AC-SYNC-CLI-01 sync help说明真实后端与阶段范围，错误flag和缺失参数明确拒绝', async () => {
  const help = await cli(['sync', '--help'])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /sync run/); assert.match(help.stdout, /不先单独提交 Spec/); assert.match(help.stdout, /持续观察授权来源/)
  const bad = await cli(['sync', 'run', 'demo', '--pretend'])
  assert.equal(bad.code, 1); assert.match(bad.stderr, /未知选项/)
  const missing = await cli(['sync', 'run'])
  assert.equal(missing.code, 1); assert.match(missing.stderr, /需要节点/)
  const conflicting = await cli(['sync', 'run', 'demo', '--retry-of', 'op-1', '--patch-file', 'unread.json'])
  assert.equal(conflicting.code, 1); assert.match(conflicting.stderr, /不能同时指定/)
  const scopedPause = await cli(['sync', 'pause', '--node', 'demo'])
  assert.equal(scopedPause.code, 1); assert.match(scopedPause.stderr, /物理暂停请省略节点选项/)
  const verifyPatch = await cli(['sync', 'verify', 'demo', '--patch-file', 'unread.json'])
  assert.equal(verifyPatch.code, 1); assert.match(verifyPatch.stderr, /只用于 sync run/)
  for (const args of [['verify', 'demo'], ['run', 'demo', '--origin', 'spec'], ['run', 'demo', 'false', '--origin', 'code'], ['run', 'demo', '--origin', 'code', '--patch-file', 'unread.json']]) {
    const coverage = await cli(['sync', ...args, '--record-unverified-coverage'])
    assert.equal(coverage.code, 1); assert.match(coverage.stderr, /--record-unverified-coverage 只用于/)
  }
  const misplaced = await cli(['sync', 'recover', 'op-1', '--retry-of', 'op-1'])
  assert.equal(misplaced.code, 1); assert.match(misplaced.stderr, /只用于 sync run/)
  const stopId = await cli(['sync', 'stop-writer', '--request-id', 'unneeded'])
  assert.equal(stopId.code, 1); assert.match(stopId.stderr, /stop-writer 不接收/)
  const missingAdoption = await cli(['sync', 'adopt'])
  assert.equal(missingAdoption.code, 1); assert.match(missingAdoption.stderr, /adopt 需要完整 operation ID/)
})
test('AC-SYNC-CLI-02 CLI run/status/control 走相同持久服务HTTP且保留稳定request ID', async () => {
  const requests: { method: string; url: string; body: unknown }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const bytes of request) chunks.push(bytes as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push({ method: request.method!, url: request.url!, body: body ? JSON.parse(body) as unknown : null })
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ operation: { id: 'op-1', phase: 'queued' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const run = await cli(['sync', 'run', '[[demo]]', '--request-id', 'request-1', '--api', api])
    assert.equal(run.code, 0, run.stderr); assert.equal(JSON.parse(run.stdout).operation.id, 'op-1')
    assert.deepEqual(requests[0], { method: 'POST', url: '/api/sync/run', body: { targetTree: workspace.replace(/\/$/, ''), nodeId: 'demo', requestId: 'request-1', origin: 'spec' } })
    assert.equal((await cli(['sync', 'status', '--node', 'demo', '--limit', '4', '--api', api])).code, 0)
    const status = new URL(requests[1].url, api)
    assert.equal(status.pathname, '/api/sync/status'); assert.equal(status.searchParams.get('nodeId'), 'demo'); assert.equal(status.searchParams.get('limit'), '4')
    assert.equal((await cli(['sync', 'pause', 'op-1', '--api', api])).code, 0)
    assert.equal(requests[2].url, '/api/sync/operations/op-1/pause')
    assert.equal((await cli(['sync', 'show', 'op-1', '--api', api])).code, 0)
    assert.match(requests[3].url, /^\/api\/sync\/operations\/op-1\?targetTree=/)
    const retry = await cli(['sync', 'run', 'demo', '--request-id', 'retry-1', '--retry-of', 'op-1', '--api', api])
    assert.equal(retry.code, 0, retry.stderr)
    assert.deepEqual(requests[4].body, { targetTree: workspace.replace(/\/$/, ''), nodeId: 'demo', requestId: 'retry-1', retryOf: 'op-1' })
    const recover = await cli(['sync', 'recover', 'op-1', '--api', api])
    assert.equal(recover.code, 0, recover.stderr); assert.equal(requests[5].url, '/api/sync/operations/op-1/recover')
    assert.deepEqual(requests[5].body, { targetTree: workspace.replace(/\/$/, '') })
    const codeInput = await cli(['sync', 'run', 'demo', '--origin', 'code', '--request-id', 'code-1', '--api', api])
    assert.equal(codeInput.code, 0, codeInput.stderr)
    assert.deepEqual(requests[6].body, { targetTree: workspace.replace(/\/$/, ''), nodeId: 'demo', requestId: 'code-1', origin: 'code' })
    const decision = await cli(['sync', 'decide', 'op-1', '--input-id', 'input-1', '--analysis', 'a'.repeat(64), '--findings', 'finding-1,finding-2', '--choice', 'new_rule', '--rule', '新的明确规则', '--request-id', 'decision-1', '--api', api])
    assert.equal(decision.code, 0, decision.stderr)
    assert.equal(requests[7].url, '/api/sync/operations/op-1/decide')
    assert.deepEqual(requests[7].body, { targetTree: workspace.replace(/\/$/, ''), requestId: 'decision-1', inputId: 'input-1', analysisRef: { sha256: 'a'.repeat(64) }, findingIds: ['finding-1', 'finding-2'], decision: { choice: 'new_rule', rule: '新的明确规则' } })

    assert.equal((await cli(['sync', 'pause', '--api', api])).code, 0)
    assert.equal(requests[8].url, '/api/sync/automatic/pause')
    assert.equal((await cli(['sync', 'resume', '--api', api])).code, 0)
    assert.equal(requests[9].url, '/api/sync/automatic/resume')
    const revert = await cli(['sync', 'revert', 'op-1', '--request-id', 'revert-1', '--api', api])
    assert.equal(revert.code, 0, revert.stderr); assert.equal(requests[10].url, '/api/sync/operations/op-1/revert')
    assert.deepEqual(requests[10].body, { targetTree: workspace.replace(/\/$/, ''), requestId: 'revert-1' })
    const stop = await cli(['sync', 'stop-writer', '--api', api])
    assert.equal(stop.code, 0, stop.stderr); assert.equal(requests[11].url, '/api/sync/stop-writer')
    assert.deepEqual(requests[11].body, { targetTree: workspace.replace(/\/$/, '') })
    assert.equal((await cli(['sync', 'verify', 'demo', '--request-id', 'verify-1', '--api', api])).code, 0)
    assert.equal(requests[12].url, '/api/sync/verify')

    const adopted = await cli(['sync', 'adopt', 'op-1', '--api', api])
    assert.equal(adopted.code, 0, adopted.stderr)
    assert.deepEqual(requests[13], { method: 'POST', url: '/api/sync/operations/op-1/adopt', body: { targetTree: workspace.replace(/\/$/, '') } })

    const coverage = await cli(['sync', 'run', 'demo', '--retry-of', 'op-1', '--record-unverified-coverage', '--request-id', 'coverage-1', '--api', api])
    assert.equal(coverage.code, 0, coverage.stderr)
    assert.deepEqual(requests[14], { method: 'POST', url: '/api/sync/run', body: { targetTree: workspace.replace(/\/$/, ''), nodeId: 'demo', requestId: 'coverage-1', retryOf: 'op-1', recordUnverifiedCoverage: true } })
    const handoff = await cli(['sync', 'run', 'demo', '--retry-of', 'op-1', '--model', 'grok:default', '--inherit-retry-budget', '--request-id', 'handoff-1', '--api', api])
    assert.equal(handoff.code, 0, handoff.stderr)
    assert.deepEqual(requests[15], { method: 'POST', url: '/api/sync/run', body: { targetTree: workspace.replace(/\/$/, ''), nodeId: 'demo', requestId: 'handoff-1', retryOf: 'op-1', model: 'grok:default', inheritRetryBudget: true } })
    const missingModel = await cli(['sync', 'run', 'demo', '--retry-of', 'op-1', '--inherit-retry-budget', '--api', api])
    assert.equal(missingModel.code, 1); assert.match(missingModel.stderr, /--inherit-retry-budget/)
    assert.equal(requests.length, 16)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
test('sync run和verify传递--model，resume/recover不接受模型切换', async () => {
  const requests: { url: string; body: { model?: string } }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const bytes of request) chunks.push(bytes as Buffer)
    requests.push({ url: request.url!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    for (const verb of ['run', 'verify']) assert.equal((await cli(['sync', verb, 'demo', '--model', 'gpt-6.1-terra', '--api', api])).code, 0)
    assert.deepEqual(requests.map(item => [item.url, item.body.model]), [['/api/sync/run', 'gpt-6.1-terra'], ['/api/sync/verify', 'gpt-6.1-terra']])
    for (const verb of ['resume', 'recover']) {
      const refused = await cli(['sync', verb, 'op-1', '--model', 'gpt-6-astra', '--api', api])
      assert.equal(refused.code, 1); assert.equal(requests.length, 2)
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

test('AC-SYNC-CLI-03 后端离线不回退mock或留下虚假成功输出', async () => {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const result = await cli(['sync', 'status', '--api', `http://127.0.0.1:${port}`])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no backend reachable/)
})

test('resource-only CLI单次离线访问精确operation/input，不向API发送或启动服务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-resource-cli-')), requests: string[] = []
  execFileSync('git', ['init', '-q', root])
  writeFileSync(join(root, 'fixture.txt'), '原作者内容不改\n'); execFileSync('git', ['-C', root, 'add', 'fixture.txt'])
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  const database = join(root, '.git', 'private-cli-proof.sqlite'), gitBackup = `${root}-original-git`
  const server = createServer((request, response) => { requests.push(request.url!); response.writeHead(200); response.end('{}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const originalApi = process.env.SPEXCODE_API_URL, originalDatabase = process.env.SPEX_SESSION_DATABASE_PATH, api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.SPEXCODE_API_URL = api; process.env.SPEX_SESSION_DATABASE_PATH = database
  try {
    const help = await cli(['sync', '--help'], root)
    assert.equal(help.code, 0, help.stderr)
    assert.match(help.stdout, /sync resources recover/); assert.match(help.stdout, /离线/)
    const result = await cli(['sync', 'resources', 'recover', 'missing-operation', '--input-id', 'a'.repeat(64)], root)
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /SYNC_OPERATION_UNKNOWN/)
    // 先经上述正式CLI初始化canonical protocol，再登记隔离历史操作，不手造cutover marker。
    const protocol = openProtocol(database)
    await migrateSyncStore(protocol)
    const input = await captureInputSnapshot(root), store = new SyncStore(protocol, { readBlob: ref => readEvidence(input.source.commonDir, ref) })
    const operation = store.admitAndEnqueue({ ingressKey: 'offline-resource-proof', rootCauseId: 'offline-resource-proof', origin: 'spec', input, scope: { paths: ['fixture.txt'], contractIds: [], flowIds: [] }, budget: { maxCalls: 4, maxAttempts: 2, maxRepairs: 1, timeoutMs: 30000 }, delivery: null, deliveryPlan: { canonicalRoot: root, branch: 'refs/heads/codex/delivery', baseCommit: input.headCommit }, policyDigest: 'frozen-policy', impactDigest: 'frozen-impact', readSetDigest: 'frozen-readset' })
    protocol.close()
    renameSync(join(root, '.git'), gitBackup); cpSync(gitBackup, join(root, '.git'), { recursive: true })
    const cleaned = await cli(['sync', 'resources', 'recover', operation.id, '--input-id', input.id], root)
    assert.equal(cleaned.code, 0, cleaned.stderr)
    assert.deepEqual(JSON.parse(cleaned.stdout), { operationId: operation.id, inputId: input.id, status: 'resources_recovered', resources: [], pendingJournalIds: [] })
    const reopened = openProtocol(database)
    try {
      const after = new SyncStore(reopened, { readBlob: ref => readEvidence(input.source.commonDir, ref) })
      assert.deepEqual(after.readOperation(operation.id), operation); assert.deepEqual(after.listAttempts(operation.id), [])
      assert.equal(after.nextDispatch(input.source.repositoryId)?.operation.id, operation.id, '离线清理不能消费原业务队列')
    } finally { reopened.close() }
    assert.deepEqual(requests, [], '离线入口不能fallback HTTP')
    const missing = await cli(['sync', 'resources', 'recover', 'op'], root)
    assert.equal(missing.code, 1); assert.match(missing.stderr, /input-id/)
    const remote = await cli(['sync', 'resources', 'recover', 'op', '--input-id', 'a'.repeat(64), '--api', api], root)
    assert.equal(remote.code, 1); assert.match(remote.stderr, /离线|仅接受/); assert.deepEqual(requests, [])
  } finally {
    if (originalApi === undefined) delete process.env.SPEXCODE_API_URL; else process.env.SPEXCODE_API_URL = originalApi
    if (originalDatabase === undefined) delete process.env.SPEX_SESSION_DATABASE_PATH; else process.env.SPEX_SESSION_DATABASE_PATH = originalDatabase
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(root, { recursive: true, force: true })
    rmSync(gitBackup, { recursive: true, force: true })
  }
})

test('resource-only API真实路由handler只委派专用factory并要求明确input ID', async () => {
  const source = readFileSync(join(workspace, 'spec-cli/src/index.ts'), 'utf8'), file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let arrow: ts.Expression | undefined
  const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && node.expression.getText(file) === 'app.post' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/sync/operations/:id/resources/recover') arrow = node.arguments[1]; ts.forEachChild(node, visit) }
  visit(file); assert.ok(arrow, '必须有独立resources/recover路由')
  const compiled = ts.transpileModule(`const handler = ${arrow.getText(file)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  type Context = { req: { json(): Promise<unknown>; param(name: string): string; query(name: string): string | undefined }; json(value: unknown): unknown }
  const calls: unknown[] = [], reply = { status: 'resources_recovered', pendingJournalIds: ['preserved-journal'] }
  const handler = new Function('syncRequestBody', 'syncTargetRoot', 'configuredSyncResourceRecoveryApplication', 'SyncApplicationError', `${compiled}; return handler`)(async (request: Context['req']) => request.json(), async (query: unknown, target: unknown) => { assert.equal(query, '/trusted-root'); assert.equal(target, '/trusted-root'); return '/trusted-root' }, async (root: string) => { assert.equal(root, '/trusted-root'); return { recoverResources: async (id: string, input: string) => { calls.push([id, input]); return reply } } }, SyncApplicationError) as (context: Context) => Promise<unknown>
  const context = (body: unknown): Context => ({ req: { json: async () => body, param: () => 'explicit-operation', query: () => '/trusted-root' }, json: value => value })
  assert.deepEqual(await handler(context({ targetTree: '/trusted-root', inputId: 'frozen-input' })), reply)
  assert.deepEqual(calls, [['explicit-operation', 'frozen-input']])
  for (const body of [{ targetTree: '/trusted-root' }, { targetTree: '/trusted-root', inputId: '' }, { targetTree: '/trusted-root', inputId: 'frozen-input', operationId: 'foreign' }]) await assert.rejects(handler(context(body)), { code: 'sync_request_invalid', status: 400 })
  assert.equal(calls.length, 1, '非法请求不能进入资源清理')
})
