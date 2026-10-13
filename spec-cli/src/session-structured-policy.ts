import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnDetachedRuntime } from './runtime-ownership.js'
import { ensureCodexCurrentGeneration, type CodexGenerationEndpoint } from './codex-runtime-generations.js'

export type StructuredExecution = {
  version: 1
  policy: 'codex-read-only-v1'
  schema: Record<string, unknown>
  inputDigest: string
  purpose: string
  timeoutMs: number
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  threadId?: string
  turnId?: string
  state?: 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled' | 'timeout'
  turnStartRequested?: boolean
  cancellation?: { reason: 'cancelled' | 'timeout'; requestedAt: number; nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
  output?: unknown
  resultDigest?: string
  error?: string
}
export class StructuredSessionError extends Error {
  readonly sessionId?: string
  readonly threadId?: string
  readonly turnId?: string
  constructor(readonly code: 'unsupported' | 'failed' | 'cancelled' | 'timeout' | 'key_reused' | 'stale_result' | 'cancellation_pending', message: string, identity: { sessionId?: string; threadId?: string; turnId?: string } = {}) {
    super(message)
    this.name = 'StructuredSessionError'
    this.sessionId = identity.sessionId
    this.threadId = identity.threadId
    this.turnId = identity.turnId
  }
}

export class StructuredSessionTransportError extends StructuredSessionError {
  constructor(message: string) {
    super('failed', message)
    this.name = 'StructuredSessionTransportError'
  }
}

const configText = `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\napps = false\nplugins = false\nhooks = false\nmulti_agent = false\nshell_tool = false\ncode_mode = false\ncode_mode_host = false\nunified_exec = false\n[mcp_servers]\n`

// The outer boundary contains the app-server itself, hooks, MCP subprocesses and tool descendants. Native
// read-only applies inside it too. Only the runtime's own rollouts/cache can be written; configuration and
// the secure auth reference remain outside that writable subtree. No launcher or user config is inherited.
export function structuredSeatbeltProfile(writableRoot: string): string {
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(writableRoot)}) (literal "/dev/null"))\n`
}

export function prepareStructuredRealm(root: string): { runtimeDir: string; start: (endpoint: CodexGenerationEndpoint) => Promise<void> } {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
    throw new StructuredSessionError('unsupported', 'structured read-only execution requires a verified macOS Seatbelt runtime; no permissive fallback is allowed')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const writable = join(root, 'data'); mkdirSync(writable, { recursive: true, mode: 0o700 })
  const home = join(root, 'config'); mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = join(home, 'config.toml')
  if (existsSync(config) && readFileSync(config, 'utf8') !== configText)
    throw new StructuredSessionError('unsupported', 'structured runtime configuration differs from the trusted fixed policy')
  writeFileSync(config, configText, { mode: 0o600 })
  // Auth remains an existing system-managed file. Do not read, copy or log its bytes. The outer sandbox
  // prevents refresh/overwrite of the original; an expired credential fails explicitly and needs login.
  const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  const reference = join(home, 'auth.json')
  if (existsSync(auth) && !existsSync(reference)) symlinkSync(realpathSync(auth), reference)
  // Codex writes state/cache files at CODEX_HOME, so use a clean writable home with only fixed config and
  // auth symlinks. Protect those exact paths in addition to the deny-by-default external write rule.
  const runtimeHome = join(writable, 'codex-home'); mkdirSync(runtimeHome, { recursive: true, mode: 0o700 })
  for (const name of ['config.toml', 'auth.json']) {
    const source = join(home, name)
    if (existsSync(source) && !existsSync(join(runtimeHome, name))) symlinkSync(source, join(runtimeHome, name))
  }
  const profile = join(root, 'policy.sb')
  const policy = structuredSeatbeltProfile(realpathSync(writable)) + `(deny file-write* (literal ${JSON.stringify(join(realpathSync(runtimeHome), 'config.toml'))}) (literal ${JSON.stringify(join(realpathSync(runtimeHome), 'auth.json'))}))\n`
  writeFileSync(profile, policy, { mode: 0o600 })
  const outside = join(root, 'write-probe'); writeFileSync(outside, 'unchanged', { mode: 0o600 })
  const probe = join(writable, 'write-probe')
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', 'printf allowed > "$1"; printf forbidden > "$2" 2>/dev/null; test -f "$1"', 'probe', probe, outside], { stdio: 'ignore' })
    if (readFileSync(outside, 'utf8') !== 'unchanged') throw new Error('outside write succeeded')
  } catch {
    throw new StructuredSessionError('unsupported', 'outer read-only sandbox probe failed; refusing Agent execution')
  }
  const runtimeDir = join(root, 'control'); mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const start = async (endpoint: CodexGenerationEndpoint): Promise<void> => {
    // Explicit allowlist avoids inherited wrappers, server overrides, tools, credentials in logs and
    // foreign session identity. The auth reference is consumed by Codex's normal authentication mechanism.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: join(writable, 'tmp'), CODEX_HOME: runtimeHome }
    mkdirSync(env.TMPDIR!, { recursive: true, mode: 0o700 })
    const endpointProfile = join(root, `${endpoint.id}.sb`)
    const rendezvous = join(realpathSync(dirname(endpoint.socketPath)), basename(endpoint.socketPath))
    // Codex 0.160 protects Unix RPC sockets in its fixed executor-local daemon directory; the advertised
    // endpoint is a symlink. Grant only this generation's hashed socket/lock, never the shared directory.
    const daemonDirectory = join('/private/tmp', `codex-daemon-${process.getuid!()}`)
    const physicalSocket = join(daemonDirectory, createHash('sha256').update(rendezvous).digest('hex'))
    writeFileSync(endpointProfile, policy
      + `(allow file-write-create (literal ${JSON.stringify(daemonDirectory)}) (literal ${JSON.stringify(dirname(rendezvous))}))\n`
      + `(allow file-write* (literal ${JSON.stringify(rendezvous)}) (literal ${JSON.stringify(physicalSocket)}) (literal ${JSON.stringify(`${physicalSocket}.lock`)}) (literal ${JSON.stringify(join(realpathSync(dirname(endpoint.logFile)), basename(endpoint.logFile)))}))\n`, { mode: 0o600 })
    spawnDetachedRuntime({ cwd: runtimeHome, logFile: endpoint.logFile, pidFile: endpoint.pidFile,
      receiptFile: endpoint.receiptFile, command: '/usr/bin/sandbox-exec',
      args: ['-f', endpointProfile, 'codex', 'app-server', '--strict-config', '--listen', `unix://${endpoint.socketPath}`], env })
  }
  return { runtimeDir, start }
}

export async function structuredGeneration(root: string): Promise<{ endpoint: CodexGenerationEndpoint; runtimeDir: string }> {
  const { runtimeDir, start } = prepareStructuredRealm(root)
  const socketDirectory = join('/private/tmp', `spex-ro-${createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16)}`)
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
  return { endpoint: await ensureCodexCurrentGeneration(runtimeDir, start, { socketDirectory }), runtimeDir }
}
