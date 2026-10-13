import test from 'node:test'
import assert from 'node:assert/strict'
import { createExportService } from '../src/export.js'

const original = [
  { id: 'r1', category: 'books', value: 11 },
  { id: 'r2', category: 'book', value: 22 },
  { id: 'r3', category: 'books', value: 33 },
  { id: 'r4', category: 'Books', value: 44 },
  { id: 'r5', category: ' books ', value: 55 },
]
const expected = [original[0], original[2]]
function setup() {
  const rows = structuredClone(original), events = []
  let reads = 0
  const service = createExportService({ readRows: () => { reads++; return rows }, enqueue: event => events.push(structuredClone(event)) })
  return { service, rows, events, reads: () => reads }
}
const unchanged = (service, id, action) => {
  const before = service.view('alice', id)
  action()
  assert.deepEqual(service.view('alice', id), before)
}

test('ORACLE-ROWS 实际精确筛选、顺序、提交复制、输出复制', () => {
  const { service, rows, events, reads } = setup()
  const job = service.submit('alice', 'k', '  books\n')
  assert.equal(job.owner, 'alice'); assert.equal(job.category, 'books')
  assert.equal(job.status, 'QUEUED'); assert.equal(job.attempt, 1)
  assert.equal(job.rows, null); assert.equal(job.error, null)
  assert.equal(typeof job.id, 'string'); assert.ok(job.id.length)
  assert.deepEqual(events, [{ jobId: job.id, attempt: 1 }]); assert.equal(reads(), 1)
  rows[0].value = 999; rows.push({ id: 'late', category: 'books', value: 77 })
  job.owner = 'mallory'
  assert.equal(service.start(job.id, 1).status, 'RUNNING')
  assert.equal(service.complete(job.id, 1).status, 'SUCCEEDED')
  assert.deepEqual(service.download('alice', job.id), expected)
  const downloaded = service.download('alice', job.id); downloaded[0].value = -1; downloaded.pop()
  const viewed = service.view('alice', job.id); viewed.rows[0].category = 'bad'
  assert.deepEqual(service.view('alice', job.id).rows, expected)
  assert.deepEqual(service.download('alice', job.id), expected); assert.equal(reads(), 1)
})

test('ORACLE-IDEMPOTENCY actor 与 key 组合身份、规范化筛选、无重复排队', () => {
  const { service, events, reads } = setup()
  const first = service.submit('alice', 'k', 'books')
  assert.deepEqual(service.submit('alice', 'k', '\tbooks '), first)
  assert.throws(() => service.submit('alice', 'k', 'Books'))
  const second = service.submit('bob', 'k', 'books')
  assert.notEqual(second.id, first.id); assert.equal(second.owner, 'bob')
  service.start(first.id, 1); service.complete(first.id, 1)
  assert.equal(service.submit('alice', 'k', 'books').status, 'SUCCEEDED')
  assert.equal(events.length, 2); assert.equal(reads(), 2)
})

test('ORACLE-INVALID 无效提交、未知任务、无匹配成功', () => {
  const { service, events, reads } = setup()
  for (const [actor, key, filter] of [['', 'k', 'books'], [' ', 'k', 'books'], ['a', '', 'books'], ['a', ' ', 'books'], ['a', 'k', ' '], ['a', 'k', null]]) assert.throws(() => service.submit(actor, key, filter))
  assert.equal(reads(), 0); assert.equal(events.length, 0)
  for (const method of ['view', 'download', 'cancel', 'retry']) assert.throws(() => service[method]('alice', 'missing'))
  for (const method of ['start', 'complete', 'fail']) assert.throws(() => service[method]('missing', 1, 'error'))
  const job = service.submit('alice', 'empty', 'unknown')
  service.start(job.id, 1); service.complete(job.id, 1)
  assert.deepEqual(service.download('alice', job.id), [])
})

test('ORACLE-OWNER 所有状态的查看、下载、取消和重试权限', () => {
  for (const state of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) {
    const { service } = setup(), job = service.submit('alice', state, 'books')
    if (['RUNNING', 'SUCCEEDED', 'FAILED'].includes(state)) service.start(job.id, 1)
    if (state === 'SUCCEEDED') service.complete(job.id, 1)
    if (state === 'FAILED') service.fail(job.id, 1, 'failed')
    if (state === 'CANCELLED') service.cancel('alice', job.id)
    for (const method of ['view', 'download', 'cancel', 'retry']) unchanged(service, job.id, () => assert.throws(() => service[method]('bob', job.id)))
    if (state !== 'SUCCEEDED') assert.throws(() => service.download('alice', job.id))
    assert.equal(service.view('alice', job.id).status, state)
  }
})

test('ORACLE-CALLBACKS 当前状态回调矩阵、payload 拒绝与首次终态', () => {
  const { service, events } = setup(), job = service.submit('alice', 'k', 'books')
  unchanged(service, job.id, () => assert.throws(() => service.complete(job.id, 1)))
  unchanged(service, job.id, () => assert.throws(() => service.fail(job.id, 1, 'early')))
  service.start(job.id, 1)
  unchanged(service, job.id, () => service.start(job.id, 1))
  for (const error of ['', ' ', null]) unchanged(service, job.id, () => assert.throws(() => service.fail(job.id, 1, error)))
  service.fail(job.id, 1, ' exact failure ')
  assert.equal(service.view('alice', job.id).error, ' exact failure ')
  assert.equal(service.view('alice', job.id).rows, null)
  for (const action of [() => service.start(job.id, 1), () => service.complete(job.id, 1), () => service.fail(job.id, 1, null), () => service.cancel('alice', job.id)]) unchanged(service, job.id, action)
  assert.equal(events.length, 1)
})

test('ORACLE-ATTEMPTS 缺失及未来拒绝、旧尝试忽略、重试保留原始数据', () => {
  const { service, rows, events, reads } = setup(), job = service.submit('alice', 'k', 'books')
  for (const attempt of [undefined, 0, -1, 1.5, '1', 2]) for (const method of ['start', 'complete', 'fail']) unchanged(service, job.id, () => assert.throws(() => service[method](job.id, attempt, 'error')))
  service.start(job.id, 1); service.fail(job.id, 1, 'network')
  rows.splice(0, rows.length, { id: 'replacement', category: 'books', value: 999 })
  const next = service.retry('alice', job.id)
  assert.equal(next.id, job.id); assert.equal(next.attempt, 2); assert.equal(next.status, 'QUEUED')
  assert.equal(next.error, null); assert.equal(next.rows, null)
  assert.deepEqual(events, [{ jobId: job.id, attempt: 1 }, { jobId: job.id, attempt: 2 }])
  assert.equal(reads(), 1)
  for (const phase of ['QUEUED', 'RUNNING']) {
    if (phase === 'RUNNING') service.start(job.id, 2)
    for (const method of ['start', 'complete', 'fail']) unchanged(service, job.id, () => service[method](job.id, 1, null))
    unchanged(service, job.id, () => assert.throws(() => service.retry('alice', job.id)))
  }
  service.complete(job.id, 2)
  assert.deepEqual(service.download('alice', job.id), expected)
  assert.equal(events.length, 2); assert.equal(reads(), 1)
  unchanged(service, job.id, () => assert.throws(() => service.complete(job.id, 3)))
})

test('ORACLE-RACES 完成、失败与取消每种竞争顺序首次终态胜出', () => {
  for (const [first, later, status] of [['complete', 'cancel', 'SUCCEEDED'], ['cancel', 'complete', 'CANCELLED'], ['fail', 'complete', 'FAILED'], ['complete', 'fail', 'SUCCEEDED'], ['fail', 'cancel', 'FAILED'], ['cancel', 'fail', 'CANCELLED']]) {
    const { service } = setup(), job = service.submit('alice', `${first}-${later}`, 'books')
    service.start(job.id, 1)
    const action = name => name === 'cancel' ? service.cancel('alice', job.id) : service[name](job.id, 1, 'first error')
    action(first); const terminal = service.view('alice', job.id)
    action(later); assert.deepEqual(service.view('alice', job.id), terminal); assert.equal(terminal.status, status)
    service.start(job.id, 1); service.complete(job.id, 1); service.fail(job.id, 1, 'overwritten')
    assert.deepEqual(service.view('alice', job.id), terminal)
    if (status === 'SUCCEEDED') assert.deepEqual(service.download('alice', job.id), expected)
    if (status === 'FAILED') assert.equal(terminal.error, 'first error')
  }
})

test('ORACLE-RETRY-STATE 只有失败能重试、排队取消不被回调启动', () => {
  for (const state of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'CANCELLED']) {
    const { service, events } = setup(), job = service.submit('alice', state, 'books')
    if (['RUNNING', 'SUCCEEDED'].includes(state)) service.start(job.id, 1)
    if (state === 'SUCCEEDED') service.complete(job.id, 1)
    if (state === 'CANCELLED') service.cancel('alice', job.id)
    unchanged(service, job.id, () => assert.throws(() => service.retry('alice', job.id)))
    assert.equal(events.length, 1)
    if (state === 'CANCELLED') for (const method of ['start', 'complete', 'fail']) unchanged(service, job.id, () => service[method](job.id, 1, 'later'))
  }
})
