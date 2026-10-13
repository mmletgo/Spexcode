import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONTRACT_COLUMNS, parseContract, parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { elaborate, elaborationDigest } from './elaboration.js'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationInput, ElaborationReview, ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { ContractCell, GeneratedElaboration, GeneratedTables } from './elaboration-markdown.js'
import { renderElaboration } from './elaboration-markdown.js'
import { ELABORATION_SCHEMA, outputErrors } from './elaboration-schema.js'

const fixture = new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url)
const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(new URL(path, fixture), 'utf8')
const rawSource = parseContract({ nodeId: 'export-contract', path, source }).contract!.rawSource
const files = new Map(['src/export.js', 'tests/export.test.mjs'].map(file => [file, readFileSync(new URL(file, fixture), 'utf8')]))
const input = (existing = false): ElaborationInput => ({ root: '/test/frozen-repository', requestKey: 'operation-1', intent: { nodeId: 'export-contract', rawSource }, targets: [{ nodeId: 'export-contract', path, source: existing ? source : null, sourceDigest: existing ? elaborationDigest(source) : null }], facts: [{ source: 'decision:EXPORT-POLICY', text: source }], files, maxRepairs: 1 })
const candidate = (_request: ElaborationSessionRequest, source: string, _beforeDigest: string | null = null): GeneratedElaboration => {
  const contract = parseContract({ nodeId: 'export-contract', path, source }).contract!
  const fm = parseFrontmatter(source).fm
  const tables = Object.fromEntries(Object.entries(CONTRACT_COLUMNS).map(([kind, columns]) => {
    const items = contract.items.filter(item => item.kind === kind)
    return [kind, items.map(item => Object.fromEntries(columns.map(column => {
      const key = column === 'depends-on' ? 'dependsOn' : column === 'timeout-ms' ? 'timeoutMs' : column === 'kind' ? 'gapKind' : column
      const value = (item as unknown as Record<string, ContractCell>)[key]
      return [column, column === 'source' && item.kind !== 'VERIFY' ? `${item.source.kind}:${item.source.ref}` : value]
    })))]
  })) as GeneratedTables
  return { version: 'elaboration-rows-v1', changes: [{ nodeId: 'export-contract', path, title: String(fm.title), description: '', code: contract.code, related: contract.related, prose: parseParts(source)!.expandedSpec.split(/^### /m)[0], tables }], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '冻结夹具的显式事件及政策', affectedIds: ['REQ-EXPORT-01'] })) }
}
const review = (_request: ElaborationSessionRequest): Omit<ElaborationReview, 'inputDigest' | 'candidateDigest'> => ({ verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] })
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
  assert.equal(result.contracts[0].rawSource, rawSource)
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
      if (variant === 'digest') Object.assign(output.changes[0], { beforeDigest: 'stale' })
      if (variant === 'raw') Object.assign(output.changes[0], { rawSource: '模型擅自替换用户目标' })
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
  assert.equal(interrupted.contracts[0].rawSource, rawSource)
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

test('AC-ELABORATION-15 raw里的围栏标题完整保留，不误判为正文分界', async () => {
  const raw = `${rawSource}\n\n\`\`\`markdown\n## expanded spec\n示例内容\n\`\`\``
  const fake = runner(request => candidate(request, source.replace(rawSource, raw)))
  const result = await elaborate({ ...input(), intent: { nodeId: 'export-contract', rawSource: raw } }, { runner: fake.run })
  assert.equal(result.status, 'complete')
  assert.equal(result.contracts[0].rawSource, raw)
})

test('AC-ELABORATION-16 GAP覆盖的未知状态事件对不要求虚构TR，独立成功分支仍经review推进', async () => {
  const removed = new Set(['TR-EXPORT-CANCELLED-COMPLETE', 'TR-EXPORT-STALE-CANCELLED-COMPLETE'])
  const missing = source.split('\n').filter(line => !/^\| TR-EXPORT-(?:STALE-)?CANCELLED-COMPLETE \|/.test(line)).map(line => {
    if (!line.startsWith('| AC-')) return line
    const cells = line.split('|')
    cells[2] = ` ${cells[2].trim().split(',').filter(id => !removed.has(id)).join(',')} `
    return cells.join('|')
  }).join('\n')
  const gapSource = `${missing}\n### GAP\n\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-CANCEL-COMPLETE | missing_fact | 取消终态收到完成回调的政策未知 | STATE-EXPORT-CANCELLED,EVENT-EXPORT-COMPLETE | 原意未定义这对状态事件 | 明确是否拒绝或幂等忽略 | user:raw | REQ-EXPORT-01 |\n`
  const fake = runner(request => candidate(request, gapSource))
  const result = await elaborate({ ...input(), maxRepairs: 0 }, { runner: fake.run })
  assert.equal(result.status, 'needs_input')
  assert.equal(result.reviewPassed, true)
  assert.ok(result.blockedStructureFindings.some(issue => issue.code === 'missing-event-disposition'))
  assert.ok(result.readyIds.includes('FLOW-EXPORT-01'))
  assert.equal(fake.calls.length, 2)
  const dangling = runner(request => candidate(request, gapSource.replace('| STEP-EXPORT-01 | FLOW-EXPORT-01 |', '| STEP-EXPORT-01 | FLOW-NONEXISTENT-01 |')))
  const rejected = await elaborate({ ...input(), maxRepairs: 0 }, { runner: dangling.run })
  assert.equal(rejected.status, 'exhausted')
  assert.equal(rejected.reviewPassed, false)
})

test('AC-ELABORATION-17 调用预算和总时间预算真实截止，保留生成产物并停止后续review', async () => {
  const one = runner(request => candidate(request, source))
  const calls = await elaborate({ ...input(), maxCalls: 1 }, { runner: one.run })
  assert.equal(calls.status, 'exhausted')
  assert.equal(calls.failure!.code, 'budget_exhausted')
  assert.equal(one.calls.length, 1)
  assert.equal(calls.contracts[0].rawSource, rawSource)
  const slow = runner(request => candidate(request, source))
  const expired = await elaborate({ ...input(), timeoutMs: 10000, totalTimeoutMs: 10 }, { runner: async request => {
    await new Promise(resolve => setTimeout(resolve, 20))
    return slow.run(request)
  } })
  assert.equal(expired.status, 'exhausted')
  assert.equal(expired.failure!.code, 'budget_exhausted')
  assert.equal(slow.calls.length, 1)
  assert.equal(slow.calls[0].timeoutMs, 10000)
})

test('AC-ELABORATION-18 真实错列问题由业务行协议和程序固定分隔行解决', async () => {
  const fake = runner(request => candidate(request, source))
  const result = await elaborate(input(), { runner: fake.run })
  assert.ok(result.changes[0].source.includes('### RULE\n\n| id | scope | constraint | basis | authority | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- |'))
  assert.ok(result.changes[0].source.includes('### FLOW\n\n| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |'))
  assert.match(fake.calls[0].prompt, /不填写Markdown\/表头\/分隔行\/raw\/digest/)
  assert.ok(!fake.calls[0].prompt.includes('输出inputDigest='))
})

test('AC-ELABORATION-19 未提供真实文件时不能新造code锚点充实现覆盖', async () => {
  const fake = runner(request => candidate(request, source))
  const rejected = await elaborate({ ...input(), files: undefined, maxRepairs: 0 }, { runner: fake.run })
  assert.equal(rejected.status, 'exhausted')
  assert.ok(rejected.rounds[0].findings.some(issue => issue.code === 'unverified_new_code_anchor'))
})

test('AC-ELABORATION-20 固定调用身份不包含剩余预算，重放相同输入和阶段仍幂等', async () => {
  const now = Date.now
  let elapsed = 0
  Date.now = () => now() + elapsed
  try {
    const snapshot = { ...input(), timeoutMs: 10000, totalTimeoutMs: 1000 }
    const first = runner(request => candidate(request, source))
    const second = runner(request => candidate(request, source))
    const execute = async (fake: ReturnType<typeof runner>, delta: number) => elaborate(snapshot, { runner: async request => {
      elapsed += delta
      return fake.run(request)
    } })
    assert.equal((await execute(first, 100)).status, 'complete')
    assert.equal((await execute(second, 200)).status, 'complete')
    assert.deepEqual(first.calls.map(({ signal: _signal, ...identity }) => identity), second.calls.map(({ signal: _signal, ...identity }) => identity))
    assert.ok(first.calls.every(call => call.timeoutMs === 10000))
  } finally { Date.now = now }
})

test('AC-ELABORATION-21 行schema在模型边界拒绝拼接来源、错误引用/布尔/argv', () => {
  const request = { purpose: 'elaboration_generate' } as ElaborationSessionRequest
  for (const edit of [
    (rows: GeneratedTables) => { rows.RULE[0].source = 'decision:EXPORT-POLICY,user:raw' },
    (rows: GeneratedTables) => { rows.STATE[0].initial = 'true' },
    (rows: GeneratedTables) => { rows.FLOW[0].req = ['不是稳定ID'] },
    (rows: GeneratedTables) => { rows.VERIFY[0].command = '["node"]' },
    (rows: GeneratedTables) => { rows.VERIFY[0].command = ['node', '非法\n参数'] },
    (rows: GeneratedTables) => { rows.VERIFY[0]['timeout-ms'] = 0 },
  ]) {
    const output = candidate(request, source)
    edit(output.changes[0].tables)
    assert.ok(outputErrors(output, ELABORATION_SCHEMA).length)
  }
})

test('AC-ELABORATION-22 程序复制原文和绑定，保留元数据，正确渲染转义及argv', () => {
  const snapshot = input(true)
  snapshot.targets[0].source = source.replace('status: active', 'status: active\nhue: 175')
  snapshot.targets[0].sourceDigest = elaborationDigest(snapshot.targets[0].source!)
  const output = candidate({ purpose: 'elaboration_generate' } as ElaborationSessionRequest, source)
  output.changes[0].tables.REQ[0].goal = '管道 | 路径 \\ 和换行\n下一行'
  output.changes[0].tables.VERIFY[0].command = ['node', '--test', 'tests/export.test.mjs', '`含|参数`', '路径\\参数']
  const rendered = renderElaboration(snapshot, output, 'program-bound-input')
  const parsed = parseContract({ nodeId: 'export-contract', path, source: rendered.changes[0].source })
  assert.deepEqual(parsed.findings, [])
  assert.equal(parsed.contract!.rawSource, snapshot.intent.rawSource)
  assert.equal(rendered.inputDigest, 'program-bound-input')
  assert.equal(rendered.changes[0].beforeDigest, snapshot.targets[0].sourceDigest)
  assert.equal(parseFrontmatter(rendered.changes[0].source).fm.hue, parseFrontmatter(snapshot.targets[0].source!).fm.hue)
  assert.equal(parsed.contract!.items.find(item => item.kind === 'REQ')!.goal, '管道 | 路径 \\ 和换行<br>下一行')
  assert.deepEqual(parsed.contract!.items.find(item => item.kind === 'VERIFY')!.command, output.changes[0].tables.VERIFY[0].command)
  assert.ok(!rendered.changes[0].source.includes('### GAP'))
})

test('AC-ELABORATION-23 总预算耗尽但原生停止未证实时保留pending身份，不派后续会话', async () => {
  let calls = 0
  const result = await elaborate({ ...input(), totalTimeoutMs: 10 }, { runner: async () => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 20))
    throw Object.assign(new Error('原生interrupt尚未证实停稳'), { code: 'cancellation_pending', sessionId: 'pending-session', threadId: 'pending-thread', turnId: 'pending-turn' })
  } })
  assert.equal(result.status, 'failed')
  assert.equal(result.failure!.code, 'cancellation_pending')
  assert.equal(result.failure!.sessionId, 'pending-session')
  assert.equal(result.failure!.threadId, 'pending-thread')
  assert.equal(result.failure!.turnId, 'pending-turn')
  assert.equal(calls, 1)
  assert.equal(result.reviewPassed, false)
})

test('AC-ELABORATION-24 完整业务行生成默认保留900秒调用窗口，上层可明确覆盖', async () => {
  const defaults = runner(request => candidate(request, source))
  assert.equal((await elaborate(input(), { runner: defaults.run })).status, 'complete')
  assert.ok(defaults.calls.every(call => call.timeoutMs === 900000))
  const configured = runner(request => candidate(request, source))
  assert.equal((await elaborate({ ...input(), timeoutMs: 1200000 }, { runner: configured.run })).status, 'complete')
  assert.ok(configured.calls.every(call => call.timeoutMs === 1200000))
})
