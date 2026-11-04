import http from 'node:http'
import { loopbackHttpAgent } from './loopback-transport.js'

export type ReadinessOptions = {
  tries?: number
  intervalMs?: number
  requestTimeoutMs?: number
}

export function waitHealthy(port: number, options: ReadinessOptions = {}): Promise<boolean> {
  const { tries = 600, intervalMs = 100, requestTimeoutMs = 1000 } = options
  return new Promise((resolve) => {
    const retry = (left: number) => { if (left <= 1) resolve(false); else setTimeout(() => attempt(left - 1), intervalMs) }
    const attempt = (left: number) => {
      // A plain agent keeps this private loopback probe direct under environment proxying ([[loopback-transport]]).
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: requestTimeoutMs, agent: loopbackHttpAgent }, (r) => {
        r.resume()
        if (r.statusCode === 200) resolve(true); else retry(left)
      })
      req.on('error', () => retry(left))
      req.on('timeout', () => req.destroy())
    }
    attempt(tries)
  })
}
