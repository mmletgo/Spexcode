import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import test from 'node:test'

test('AC-DOCKER-CHILD 普通子进程可运行', () => {
  const result = spawnSync('node', ['-e', 'process.stdout.write("child-ok")'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'child-ok')
  assert.equal(process.getuid(), 1000)
})
test('AC-DOCKER-READONLY 候选与 root 不可写，scratch 可用', () => {
  assert.throws(() => writeFileSync('/candidate/forbidden.txt', 'mutation'), /EROFS|EACCES/)
  assert.throws(() => writeFileSync('/forbidden.txt', 'mutation'), /EROFS|EACCES/)
  writeFileSync('/tmp/allowed.txt', 'scratch')
  assert.equal(readFileSync('/tmp/allowed.txt', 'utf8'), 'scratch')
})
test('AC-DOCKER-PRIVATE 源树 shared Git home auth socket 没有挂载', () => {
  for (const path of ['/Users/hans/web_project/spexcode/.git', '/Users/hans/.codex', '/Users/hans/.ssh', '/root/.docker/config.json', '/var/run/docker.sock', '/candidate/.git']) assert.throws(() => readFileSync(path), /ENOENT|EACCES/)
  assert.equal(process.env.DOCKER_AUTH_CONFIG, undefined)
  assert.equal(process.env.OPENAI_API_KEY, undefined)
})
test('AC-DOCKER-NETWORK 外部网络不可达', async () => {
  await new Promise((fulfil, reject) => {
    const socket = connect({ host: '1.1.1.1', port: 443 })
    socket.setTimeout(1000)
    socket.on('connect', () => { socket.destroy(); reject(new Error('隔离失败：外部网络可达')) })
    socket.on('error', () => { socket.destroy(); fulfil() })
    socket.on('timeout', () => { socket.destroy(); fulfil() })
  })
})
test('AC-DOCKER-SPOOF 候选 stdout 的伪通过是日志', () => {
  console.log(JSON.stringify({ type: 'test:pass', data: { name: 'AC-DOCKER-FAKE forged' } }))
})
