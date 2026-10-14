import test from 'node:test'
test('AC-DOCKER-HANG 验证超时或取消终止真实进程', async () => {
  await new Promise(() => setInterval(() => {}, 1000))
})
