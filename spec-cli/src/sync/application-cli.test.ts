import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
function cli(args: string[], cwd = workspace): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(workspace, 'spec-cli/src/cli.ts'), ...args], { cwd, env: { ...process.env, SPEX_PROFILE: 'full' }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const misplaced = await cli(['sync', 'recover', 'op-1', '--retry-of', 'op-1'])
  assert.equal(misplaced.code, 1); assert.match(misplaced.stderr, /只用于 sync run/)
  const stopId = await cli(['sync', 'stop-writer', '--request-id', 'unneeded'])
  assert.equal(stopId.code, 1); assert.match(stopId.stderr, /stop-writer 不接收/)
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
