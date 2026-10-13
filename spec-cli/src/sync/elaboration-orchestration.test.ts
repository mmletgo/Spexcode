import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseContract } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest } from './elaboration.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationCandidate, ElaborationInput, ElaborationReview, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(new URL(path, fixture), 'utf8')
const rawSource = parseContract({ nodeId: 'export-contract', path, source }).contract!.rawSource
const files = new Map(['src/export.js', 'tests/export.test.mjs'].map(file => [file, readFileSync(new URL(file, fixture), 'utf8')]))
const input = (existing = false): ElaborationInput => ({ root: '/test/frozen-repository', requestKey: 'operation-1', intent: { nodeId: 'export-contract', rawSource }, targets: [{ nodeId: 'export-contract', path, source: existing ? source : null, sourceDigest: existing ? elaborationDigest(source) : null }], facts: [{ source: 'decision:EXPORT-POLICY', text: source }], files, maxRepairs: 1 })
const binding = (request: ElaborationSessionRequest, key: 'inputDigest' | 'candidateDigest'): string => request.prompt.match(new RegExp(`${key}=([a-f0-9]{64})`))![1]
const candidate = (request: ElaborationSessionRequest, source: string, beforeDigest: string | null = null): ElaborationCandidate => ({ inputDigest: binding(request, 'inputDigest'), changes: [{ nodeId: 'export-contract', path, beforeDigest, source }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '冻结夹具的显式事件及政策', affectedIds: ['REQ-EXPORT-01'] })) })
const review = (request: ElaborationSessionRequest): ElaborationReview => ({ inputDigest: binding(request, 'inputDigest'), candidateDigest: binding(request, 'candidateDigest'), verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] })
const runner = (build: (request: ElaborationSessionRequest, call: number) => unknown, inspect = review): { run: ElaborationRunner; calls: ElaborationSessionRequest[] } => {
  const calls: ElaborationSessionRequest[] = []
  return { calls, run: async request => {
    calls.push(request)
    const output = request.purpose === 'elaboration_review' ? inspect(request) : build(request, calls.length)
    return { sessionId: `session-${calls.length}`, threadId: `thread-${calls.length}`, turnId: 'turn-1', output, resultDigest: elaborationDigest(JSON.stringify(output)) }
  } }
}

test('AC-ELABORATION-01 生产编排完成解析、矩阵和独立评审，完整绑定仍不宣称运行或同步', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.structurePassed, true)
  assert.equal(result.reviewPassed, true)
  assert.equal(result.runtimeVerification, 'not_run')
  assert.equal(result.implementationReady, false)
  assert.equal(result.coverage!.matrix.length, 30)
  assert.equal(result.changes[0].source, source)
  assert.deepEqual(fake.calls.map(call => call.purpose), ['elaboration_generate', 'elaboration_review'])
  assert.notEqual(fake.calls[0].requestKey, fake.calls[1].requestKey)
  assert.notEqual(result.rounds[0].traces[0].sessionId, result.rounds[0].traces[1].sessionId)
  assert.match(fake.calls[1].prompt, /冻结业务输入/)
  assert.match(fake.calls[1].prompt, /候选Markdown与适用性/)
})

test('AC-ELABORATION-02 状态事件缺支先产生具体失败，再按失败修复并重新独立审查', async () => {
  const missing = source.split('\n').filter(line => !/^\| TR-EXPORT-(?:STALE-)?CANCELLED-COMPLETE \|/.test(line)).join('\n')
  const fake = runner((request, call) => candidate(request, call === 1 ? missing : source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.rounds.length, 2)
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'missing-event-disposition'))
  assert.equal(fake.calls[0].purpose, 'elaboration_generate')
  assert.equal(fake.calls[1].purpose, 'elaboration_generate')
  assert.match(fake.calls[1].prompt, /missing-event-disposition/)
})

test('AC-ELABORATION-03 独立评审发现弱化或漏分支后必须修复具体发现', async () => {
  let reviews = 0
  const fake = runner(request => candidate(request, source), request => {
    reviews++
    return reviews === 1 ? { ...review(request), verdict: 'repair', findings: [{ code: 'condition_boundary_missing', kind: 'repair', message: '条件不成立缺少反馈', affectedIds: ['TR-EXPORT-RUNNING-COMPLETE'], evidence: '重走完成路径发现失败出口遗漏', decision: '补齐否定分支' }] } : review(request)
  })
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.rounds.length, 2)
  assert.match(fake.calls[2].prompt, /condition_boundary_missing/)
  assert.equal(reviews, 2)
})

test('AC-ELABORATION-04 未知重试政策仅阻塞依赖，成功主流程可继续', async () => {
  const gapSource = `${source}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-RETRY | missing_fact | 是否允许失败后重试 | RULE-EXPORT-06,TR-EXPORT-FAILED-RETRY,AC-EXPORT-08 | 用户未定义重试政策 | 明确重试权限及attempt身份 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, gapSource), request => ({ ...review(request), verdict: 'needs_input', findings: [{ code: 'retry_policy', kind: 'missing_fact', message: '重试政策未确认', affectedIds: ['RULE-EXPORT-06'], evidence: '原意未定义恢复', decision: '明确重试政策' }] }))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.rounds.length, 1)
  assert.ok(result.blockedIds.includes('FLOW-EXPORT-02'))
  assert.ok(result.readyIds.includes('FLOW-EXPORT-01'))
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'unresolved-gap'))
})

test('AC-ELABORATION-05 未决冲突保留明确证据，不伪装为自动修复失败', async () => {
  const conflicted = `${source}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-CONFLICT | conflict | 下载权限双方互斥 | RULE-EXPORT-01 | 用户要求权限隔离，变更公开下载 | 明确是否允许公开下载 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, conflicted))
  const result = await elaborate(input(), { runner: fake.run })
  assert.equal(result.status, 'conflict')
  assert.equal(result.gaps[0].evidence, '用户要求权限隔离，变更公开下载')
})

test('AC-ELABORATION-06 越界路径、错误源摘要和raw改写都不能绕过门禁', async () => {
  for (const variant of ['path', 'digest', 'raw']) {
    const fake = runner(request => {
      const output = candidate(request, source)
      if (variant === 'path') output.changes[0].path = '../escape/spec.md'
      if (variant === 'digest') output.changes[0].beforeDigest = 'stale'
      if (variant === 'raw') output.changes[0].source = source.replace(rawSource, '模型擅自替换用户目标')
      return output
    })
    const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted', variant)
    assert.equal(result.reviewPassed, false)
    assert.equal(fake.calls.length, 1)
  }
})

test('AC-ELABORATION-07 删除既有验收或改变验证命令不能自行退出门禁', async () => {
  for (const changed of [source.split('\n').filter(line => !line.startsWith('| AC-EXPORT-03 |')).join('\n'), source.replace('["node","--test","tests/export.test.mjs"]', '["node","--version"]')]) {
    const snapshot = input(true)
    const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
    const result = await elaborate({ ...snapshot, maxRepairs: 0 }, { runner: fake.run })
    assert.equal(result.status, 'exhausted')
    assert.ok(result.rounds[0].findings.some(issue => ['protected_item_removed', 'verification_policy_changed'].includes(issue.code)))
  }
})

test('AC-ELABORATION-08 结构化错误、伪绿评审和重复会话都明确失败且留存产物', async () => {
  const malformed = runner(() => ({ summary: '已完成' }))
  const malformedResult = await elaborate({ ...input(), maxRepairs: 0 }, { runner: malformed.run })
  assert.equal(malformedResult.status, 'exhausted')
  assert.deepEqual(malformedResult.rounds[0].output, { summary: '已完成' })
  const reused = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: async request => ({ ...await reused.run(request), sessionId: 'same-session' }) })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'review_not_independent'))
})

test('AC-ELABORATION-09 新功能未实现不伪造锚点/运行证据，保留实现缺口给P2', async () => {
  const planned = source.replace('code:\n  - src/export.js#ExportService\n', '')
  const fake = runner(request => candidate(request, planned))
  const result = await elaborate({ ...input(), files: new Map() }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.implementationReady, false)
  assert.ok(result.deferredImplementationFindings.some(issue => issue.code === 'missing-implementation'))
  assert.ok(result.deferredImplementationFindings.some(issue => issue.code === 'missing-test-file'))
})

test('AC-ELABORATION-10 未提供的重要政策来源不允许模型假造', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate({ ...input(), facts: [], maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'exhausted')
  assert.ok(result.rounds[0].findings.some(issue => issue.code === 'unsupported_policy_source'))
})

test('AC-ELABORATION-11 安全能力不足及执行失败保留真实状态，取消不再派发', async () => {
  for (const code of ['unsupported', 'failed', 'timeout']) {
    const result = await elaborate(input(), { runner: async () => { throw Object.assign(new Error(`真实${code}错误`), { code }) } })
    assert.equal(result.status, code === 'unsupported' ? 'unsupported' : 'failed')
    assert.equal(result.failure!.code, code)
    assert.equal(result.reviewPassed, false)
  }
  const controller = new AbortController()
  controller.abort()
  const result = await elaborate({ ...input(), signal: controller.signal }, { runner: async () => { assert.fail('取消后不能派发') } })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.rounds.length, 0)
  const during = new AbortController()
  const fake = runner(request => { during.abort(); return candidate(request, source) })
  const interrupted = await elaborate({ ...input(), signal: during.signal }, { runner: fake.run })
  assert.equal(interrupted.status, 'cancelled')
  assert.equal(fake.calls.length, 1)
  assert.equal(interrupted.changes[0].source, source)
})

test('AC-ELABORATION-12 调用中外部继续编辑不改变冻结业务输入', async () => {
  const mutable = input()
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(mutable, { runner: async request => {
    mutable.intent.rawSource = '继续编辑的新意图'
    return fake.run(request)
  } })
  assert.equal(result.status, 'complete')
  assert.ok(fake.calls.every(call => !call.prompt.includes('继续编辑的新意图')))
})

test('AC-ELABORATION-13 用户原意已决定的退役自动处理且输出稳定ID，历史退役ID不可复用', async () => {
  const snapshot = input(true)
  const changedRaw = `${rawSource} 用户移除重复验收 AC-EXPORT-04，保留全部状态处置和逐规则验收。`
  const changed = source.replace(rawSource, changedRaw).split('\n').filter(line => !line.startsWith('| AC-EXPORT-04 |')).join('\n')
  const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
  const result = await elaborate({ ...snapshot, intent: { ...snapshot.intent, rawSource: changedRaw }, authorizedChanges: [{ id: 'AC-EXPORT-04', action: 'retire', source: 'user:raw', reason: '用户取消重复验收条目，其他状态处置保留' }] }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.deepEqual(result.retiredIds, ['AC-EXPORT-04'])
  assert.match(fake.calls[1].prompt, /authorizedChanges/)
  const reused = runner(request => candidate(request, source))
  const rejected = await elaborate({ ...input(), retiredIds: ['AC-EXPORT-04'], maxRepairs: 0 }, { runner: reused.run })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'retired_id_reused'))
})

test('AC-ELABORATION-14 可信且已决定的验证政策变更须经独立审查，未提供裁决不能伪造授权', async () => {
  const snapshot = input(true)
  const changedRaw = `${rawSource} 验证命令添加 tap 报告格式。`
  const changed = source.replace(rawSource, changedRaw).replace('["node","--test","tests/export.test.mjs"]', '["node","--test","--test-reporter=tap","tests/export.test.mjs"]')
  const fake = runner(request => candidate(request, changed, snapshot.targets[0].sourceDigest))
  const result = await elaborate({ ...snapshot, intent: { ...snapshot.intent, rawSource: changedRaw }, authorizedChanges: [{ id: 'VERIFY-EXPORT-01', action: 'update_verification', source: 'user:raw', reason: '已明确要求tap报告，不删除或弱化用例' }] }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(fake.calls.length, 2)
  await assert.rejects(() => elaborate({ ...snapshot, authorizedChanges: [{ id: 'AC-EXPORT-04', action: 'retire', source: 'decision:FAKE', reason: '模型伪造批准' }] }, { runner: fake.run }), /没有可信来源/)
})
