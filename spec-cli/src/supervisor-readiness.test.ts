import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { waitHealthy } from './supervisor-readiness.js'

async function listening(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('a backend healthy after the previous 150-attempt window is accepted', async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    res.writeHead(requests <= 150 ? 503 : 200).end()
  })
  const port = await listening(server)
  try {
    assert.equal(await waitHealthy(port, { intervalMs: 0 }), true)
    assert.equal(requests, 151)
  } finally {
    await close(server)
  }
})

test('a timed-out probe advances readiness only once', async () => {
  let requests = 0
  const server = http.createServer((_req, res) => {
    requests++
    if (requests > 1) res.writeHead(200).end()
  })
  const port = await listening(server)
  try {
    assert.equal(await waitHealthy(port, { tries: 10, intervalMs: 0, requestTimeoutMs: 10 }), true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(requests, 2)
  } finally {
    await close(server)
  }
})
