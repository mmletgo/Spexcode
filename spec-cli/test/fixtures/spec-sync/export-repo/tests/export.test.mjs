import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportService } from '../src/export.js';

function fixture(state) {
  const service = new ExportService();
  const job = service.submit('owner', 'key', 'active');
  if (state !== 'QUEUED') service.dispatch(job.id, 'START', { attempt: 1 });
  if (state === 'SUCCEEDED') service.dispatch(job.id, 'COMPLETE', { attempt: 1, result: 'file.csv' });
  if (state === 'FAILED') service.dispatch(job.id, 'FAIL', { attempt: 1, reason: 'source-unavailable' });
  if (state === 'CANCELLED') service.dispatch(job.id, 'CANCEL', { actor: 'owner' });
  return { service, id: job.id };
}

test('AC-EXPORT-01 响应丢失后同键返回同任务，参数冲突不重复创建', () => {
  const service = new ExportService();
  const first = service.submit('owner', 'key', 'active');
  assert.deepEqual(service.submit('owner', 'key', 'active'), first);
  assert.equal(service.jobs.size, 1);
  assert.throws(() => service.submit('owner', 'key', 'all'), /idempotency-conflict/);
  assert.deepEqual(service.jobs.get(first.id), first);
  const firstPair = service.submit('a:b', 'c', 'active');
  const secondPair = service.submit('a', 'b:c', 'active');
  assert.notEqual(firstPair.id, secondPair.id, '不同所有者与键的组合不能因分隔符碰撞共享任务');
  assert.equal(secondPair.owner, 'a');
  assert.deepEqual(service.submit('a:b', 'c', 'active'), firstPair);
  assert.deepEqual(service.submit('a', 'b:c', 'active'), secondPair);
});

test('AC-EXPORT-02 输入和结果边界拒绝且保持状态', () => {
  const service = new ExportService();
  assert.throws(() => service.submit('', 'key', 'active'), /forbidden/);
  assert.throws(() => service.submit('owner', '', 'active'), /invalid-request/);
  assert.throws(() => service.submit('owner', 'key', ''), /invalid-request/);
  assert.equal(service.jobs.size, 0);
  const job = service.submit('owner', 'key', 'active');
  assert.throws(() => service.dispatch(job.id, 'DOWNLOAD', { actor: 'owner' }), /not-ready/);
  service.dispatch(job.id, 'START', { attempt: 1 });
  assert.throws(() => service.dispatch(job.id, 'COMPLETE', { attempt: 1, result: '' }), /invalid-result/);
  assert.throws(() => service.dispatch(job.id, 'FAIL', { attempt: 1, reason: '' }), /invalid-reason/);
  assert.equal(service.jobs.get(job.id).state, 'RUNNING');
});

test('AC-EXPORT-03 下载时重新检查所有者，权限拒绝不影响结果', () => {
  const { service, id } = fixture('SUCCEEDED');
  for (const event of ['DOWNLOAD', 'CANCEL', 'RETRY']) {
    assert.throws(() => service.dispatch(id, event, { actor: 'other' }), /forbidden/);
  }
  assert.equal(service.dispatch(id, 'DOWNLOAD', { actor: 'owner' }), 'file.csv');
  assert.equal(service.jobs.get(id).published, 1);
});

const expected = {
  QUEUED: { START: 'RUNNING', COMPLETE: 'invalid-state', FAIL: 'invalid-state', CANCEL: 'CANCELLED', RETRY: 'invalid-state', DOWNLOAD: 'not-ready' },
  RUNNING: { START: 'RUNNING', COMPLETE: 'SUCCEEDED', FAIL: 'FAILED', CANCEL: 'CANCELLED', RETRY: 'invalid-state', DOWNLOAD: 'not-ready' },
  SUCCEEDED: { START: 'invalid-state', COMPLETE: 'SUCCEEDED', FAIL: 'SUCCEEDED', CANCEL: 'invalid-state', RETRY: 'invalid-state', DOWNLOAD: 'file.csv' },
  FAILED: { START: 'invalid-state', COMPLETE: 'invalid-state', FAIL: 'FAILED', CANCEL: 'invalid-state', RETRY: 'QUEUED', DOWNLOAD: 'not-ready' },
  CANCELLED: { START: 'invalid-state', COMPLETE: 'CANCELLED', FAIL: 'CANCELLED', CANCEL: 'CANCELLED', RETRY: 'invalid-state', DOWNLOAD: 'not-ready' },
};

test('AC-EXPORT-04 五种状态与六种当前事件全部有可观察处置', () => {
  for (const [state, events] of Object.entries(expected)) {
    for (const [event, outcome] of Object.entries(events)) {
      const { service, id } = fixture(state);
      const before = { ...service.jobs.get(id) };
      const act = () => service.dispatch(id, event, { actor: 'owner', attempt: 1, result: 'file.csv', reason: 'source-unavailable' });
      if (['invalid-state', 'not-ready'].includes(outcome)) {
        assert.throws(act, new RegExp(outcome), `${state} ${event}`);
        assert.deepEqual(service.jobs.get(id), before);
      } else if (event === 'DOWNLOAD') {
        assert.equal(act(), outcome);
        assert.deepEqual(service.jobs.get(id), before);
      } else {
        assert.equal(act().state, outcome, `${state} ${event}`);
        assert.equal(service.jobs.get(id).published, outcome === 'SUCCEEDED' ? 1 : 0);
      }
    }
  }
});

test('AC-EXPORT-05 每个状态的旧 attempt 回调全部保持原任务', () => {
  for (const state of Object.keys(expected)) {
    const { service, id } = fixture(state);
    const before = { ...service.jobs.get(id) };
    for (const event of ['START', 'COMPLETE', 'FAIL']) {
      assert.deepEqual(service.dispatch(id, event, { attempt: 0, result: 'stale.csv', reason: 'stale' }), before);
      assert.deepEqual(service.jobs.get(id), before);
    }
  }
});

test('AC-EXPORT-06 取消和完成两种顺序服从先提交终态', () => {
  const cancelled = fixture('RUNNING');
  cancelled.service.dispatch(cancelled.id, 'CANCEL', { actor: 'owner' });
  cancelled.service.dispatch(cancelled.id, 'COMPLETE', { attempt: 1, result: 'late.csv' });
  assert.equal(cancelled.service.jobs.get(cancelled.id).state, 'CANCELLED');
  assert.equal(cancelled.service.jobs.get(cancelled.id).published, 0);
  const completed = fixture('RUNNING');
  completed.service.dispatch(completed.id, 'COMPLETE', { attempt: 1, result: 'file.csv' });
  assert.throws(() => completed.service.dispatch(completed.id, 'CANCEL', { actor: 'owner' }), /invalid-state/);
  assert.equal(completed.service.jobs.get(completed.id).state, 'SUCCEEDED');
  assert.equal(completed.service.jobs.get(completed.id).published, 1);
});

test('AC-EXPORT-07 重复成功保留首次结果且只发布一次', () => {
  const { service, id } = fixture('SUCCEEDED');
  service.dispatch(id, 'COMPLETE', { attempt: 1, result: 'second.csv' });
  assert.equal(service.jobs.get(id).result, 'file.csv');
  assert.equal(service.jobs.get(id).published, 1);
});

test('AC-EXPORT-08 失败可行动，重试保持ID并拒绝旧成功', () => {
  const { service, id } = fixture('FAILED');
  assert.equal(service.jobs.get(id).reason, 'source-unavailable');
  const retry = service.dispatch(id, 'RETRY', { actor: 'owner' });
  assert.equal(retry.id, id);
  assert.equal(retry.attempt, 2);
  service.dispatch(id, 'COMPLETE', { attempt: 1, result: 'stale.csv' });
  assert.equal(service.jobs.get(id).state, 'QUEUED');
  service.dispatch(id, 'START', { attempt: 2 });
  service.dispatch(id, 'COMPLETE', { attempt: 2, result: 'fresh.csv' });
  assert.equal(service.dispatch(id, 'DOWNLOAD', { actor: 'owner' }), 'fresh.csv');
});
