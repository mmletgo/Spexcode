import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { verificationEffectDigest, verificationExportDigest } from './verification-remote-helper.mjs'
import type { VerificationCheckpoint, VerificationCommandResult, VerificationDriver, VerificationEffect, VerificationRequest, VerificationTransportConfiguration, VerificationTransportPlan, VerificationTransportState } from './verification-executor-types.js'

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
type Rpc = Record<string, unknown>
type EncodedResult = { exitCode: number; truncated: boolean; stdout: { bytes: number; sha256: string; gzip: string }; stderr: { bytes: number; sha256: string; gzip: string } }
type Receipt = { effect: VerificationEffect; settled: boolean; result?: EncodedResult; uploaded?: boolean; attestation?: { exportDigest: string; runnerDigest: string }; cleaned?: boolean; rejected?: string; reason?: string }
export type VerificationRpc = (request: Rpc, frames?: AsyncIterable<string>, maxBytes?: number) => Promise<unknown>
export type VerificationTransportTestOptions = { rpc?: VerificationRpc }

/** 部署只读server环境；项目/模型不能选择SSH权限。 */
export function configuredVerificationTransport(): VerificationTransportConfiguration | undefined {
  const sshAlias = process.env.SPEX_VERIFICATION_SSH_ALIAS, privateRoot = process.env.SPEX_VERIFICATION_SSH_ROOT
  const dockerEndpoint = process.env.SPEX_VERIFICATION_SSH_DOCKER_ENDPOINT
  if (sshAlias === undefined && privateRoot === undefined && dockerEndpoint === undefined) return undefined
  if (!sshAlias || !privateRoot || sshAlias.includes('\0') || !posix.isAbsolute(privateRoot)) throw new Error('SPEX_VERIFICATION_SSH_ALIAS/ROOT必须成对提供有效值')
  if (process.platform === 'win32') throw new Error('SSH验证主机入口需要macOS/Linux/WSL2客户端')
  if (dockerEndpoint !== undefined && !/^unix:\/\/\/.+/.test(dockerEndpoint)) throw new Error('远端V3只支持同SSH主机的本地Unix Docker socket')
  return { kind: 'ssh-docker-v1', sshAlias, privateRoot, ...(dockerEndpoint === undefined ? {} : { dockerEndpoint }) }
}

/** 固定可信bootstrap；全部动态数据仅通过stdin传送。 */
export function sshVerificationRpc(configuration: VerificationTransportConfiguration): VerificationRpc {
  return async (request, frames, maxBytes = 1024 * 1024) => {
    const source = await readFile(new URL('./verification-remote-helper.mjs', import.meta.url))
    const command = `exec node --input-type=module -e 'import("data:text/javascript;base64,${source.toString('base64')}").then(m=>m.verificationSshMain())'`
    return new Promise((fulfil, reject) => {
      const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '--', configuration.sshAlias, command], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = Buffer.alloc(0), diagnostics = Buffer.alloc(0), excessive = false
      child.stdout.on('data', (bytes: Buffer) => { const available = Math.max(0, Math.ceil(maxBytes * 1.5) + 65536 - output.length); if (bytes.length > available) excessive = true; output = Buffer.concat([output, bytes.subarray(0, available)]) })
      child.stderr.on('data', (bytes: Buffer) => { diagnostics = Buffer.concat([diagnostics, bytes.subarray(0, Math.max(0, 65536 - diagnostics.length))]) })
      const materializing = request.action === 'effect' && (request.effect as VerificationEffect).kind === 'materialize'
      const timeoutMs = materializing ? Math.max(1, Number(request.deadlineAt) - Date.now()) : 15_000
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SSH验证请求超时；远端worker/CLI状态仍待原effect恢复')) }, timeoutMs)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code !== 0 || excessive) { reject(new Error(`SSH验证通道失败：${diagnostics.toString('utf8')}`)); return }
        try {
          const response = JSON.parse(output.toString('utf8')) as { ok: boolean; value: unknown; error?: string }
          if (!response.ok) throw new Error(response.error ?? '远端验证请求失败')
          fulfil(response.value)
        } catch (error) { reject(error) }
      })
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error) })
      void (async () => {
        if (!child.stdin.write(JSON.stringify(request) + '\n')) await once(child.stdin, 'drain')
        if (frames) for await (const frame of frames) if (!child.stdin.write(frame)) await once(child.stdin, 'drain')
        child.stdin.end()
      })().catch(error => { child.stdin.destroy(); reject(error) })
    })
  }
}
function decode(result: EncodedResult, maxBytes: number): VerificationCommandResult {
  const stream = (value: EncodedResult['stdout']): string => {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > maxBytes) throw new Error('远端日志原始长度超过预算')
    const bytes = gunzipSync(Buffer.from(value.gzip, 'base64'), { maxOutputLength: Math.max(1, value.bytes) })
    if (bytes.length !== value.bytes || hash(bytes) !== value.sha256) throw new Error('远端日志原始字节/SHA不匹配')
    const valueText = bytes.toString('utf8')
    if (!Buffer.from(valueText, 'utf8').equals(bytes)) throw new Error('远端日志不是有效UTF-8；保留原容器日志等待恢复')
    return valueText
  }
  if (result.stdout.bytes + result.stderr.bytes > maxBytes) throw new Error('远端日志总原始长度超过预算')
  return { exitCode: result.exitCode, stdout: stream(result.stdout), stderr: stream(result.stderr), truncated: result.truncated }
}
async function* frames(source: string, prefix = ''): AsyncGenerator<string> {
  for (const name of (await readdir(join(source, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name, physical = join(source, ...path.split('/')), entry = await lstat(physical)
    if (entry.isDirectory()) { yield JSON.stringify({ kind: 'directory', path }) + '\n'; yield* frames(source, path) }
    else if (entry.isSymbolicLink()) yield JSON.stringify({ kind: 'symlink', path, target: await readlink(physical) }) + '\n'
    else if (entry.isFile()) yield JSON.stringify({ kind: 'file', path, executable: entry.mode & 0o111, bytes: (await readFile(physical)).toString('base64') }) + '\n'
    else throw new Error('上传包含非常规文件')
  }
  if (!prefix) yield '{"kind":"end"}\n'
}

/** 环境探测只读；在canonical planned之前不创建远端资源。 */
export function remoteVerificationEnvironment(configuration: VerificationTransportConfiguration, options: VerificationTransportTestOptions = {}): { driver: VerificationDriver; plan: (runId: string, name: string) => Promise<VerificationTransportPlan>; rpc: VerificationRpc } {
  const rpc = options.rpc ?? sshVerificationRpc(configuration), dockerEndpoint = configuration.dockerEndpoint ?? 'unix:///var/run/docker.sock'
  return {
    rpc,
    driver: async (args, maxBytes) => decode(await rpc({ action: 'unscoped-read', privateRoot: configuration.privateRoot, dockerEndpoint, args, maxBytes }, undefined, maxBytes) as EncodedResult, maxBytes),
    plan: async (runId, name) => {
      const observed = await rpc({ action: 'probe', privateRoot: configuration.privateRoot, dockerEndpoint }) as { rootIdentity: string; daemonId: string }
      const runKey = hash(`${runId}\0${name}`), directory = posix.join(configuration.privateRoot, 'spex-verify-' + runKey)
      return { version: 'verification-ssh-v1', sshAlias: configuration.sshAlias, privateRoot: configuration.privateRoot, dockerEndpoint, ...observed, runKey, directory, candidatePath: posix.join(directory, 'candidate'), runnerPath: posix.join(directory, 'runner') }
    },
  }
}

/** 仅本次run持有闭包；已登记effect重入只观察原件，不再次派发。 */
export function createRemoteVerificationRun(configuration: VerificationTransportConfiguration, read: () => VerificationCheckpoint, persist: (checkpoint: VerificationCheckpoint) => Promise<void>, assertLaunchAllowed: () => void, options: VerificationTransportTestOptions = {}) {
  const rpc = options.rpc ?? sshVerificationRpc(configuration), initial = read(), plan = initial.transport!.plan
  if (plan.sshAlias !== configuration.sshAlias || plan.privateRoot !== configuration.privateRoot || plan.dockerEndpoint !== (configuration.dockerEndpoint ?? 'unix:///var/run/docker.sock') || JSON.stringify(initial.config.transport) !== JSON.stringify(plan)) throw new Error('当前server运输配置与原远端绑定不匹配')
  const identity = { runId: initial.runId, inputDigest: initial.inputDigest, candidateDigest: initial.candidateDigest, configDigest: initial.configDigest, uniqueContainerName: initial.uniqueContainerName }
  const scoped = (request: Rpc, body?: AsyncIterable<string>, maxBytes?: number): Promise<unknown> => rpc({ ...request, plan, identity, deadlineAt: read().deadlineAt }, body, maxBytes)
  const save = async (next: Partial<VerificationTransportState>): Promise<void> => { const current = read(); await persist({ ...current, transport: { ...current.transport!, ...next } }) }
  const effect = async (kind: string, payload: Rpc, body?: AsyncIterable<string>, newUpload = false): Promise<Receipt> => {
    const current = read().transport!, matching = current.effects.filter(item => item.kind === kind), prior = matching.at(-1)
    if (prior && !newUpload) {
      if (prior.digest !== verificationEffectDigest({ effect: { kind }, ...payload })) throw new Error('原effect请求载荷不匹配')
      const observed = await scoped({ action: 'observe', effect: prior }) as { receipt?: Receipt }
      if (!observed.receipt) throw new Error('原远端effect尚无完成receipt，不重复派发')
      return observed.receipt
    }
    if (['materialize', 'create', 'start'].includes(kind)) assertLaunchAllowed()
    const request = { effect: { kind }, ...payload }, item: VerificationEffect = { id: `${kind}-${matching.length}`, kind, digest: verificationEffectDigest(request) }
    await save({ effects: [...current.effects, item] })
    if (['materialize', 'create', 'start'].includes(kind)) assertLaunchAllowed()
    return await scoped({ action: 'effect', requestId: randomUUID(), effect: item, ...payload }, body, Number(payload.maxBytes ?? 1024 * 1024)) as Receipt
  }
  const close = async (): Promise<unknown> => {
    const observation = await scoped({ action: 'close', effects: read().transport!.effects }) as { rebuildersDrained: boolean }
    await save({ closed: observation })
    if (!observation.rebuildersDrained) throw new Error('远端可重建effect未排空，保留unknown资源')
    return observation
  }
  return {
    driver: async (args: readonly string[], maxBytes: number): Promise<VerificationCommandResult> => {
      if (args[0] !== 'container' || ['inspect', 'logs'].includes(args[1])) return decode(await scoped({ action: 'read', args, maxBytes }, undefined, maxBytes) as EncodedResult, maxBytes)
      const receipt = await effect(args[1], { args, maxBytes })
      if (receipt.rejected || !receipt.result) throw new Error('远端effect被closed拒绝或缺失真实调用结果')
      return decode(receipt.result, maxBytes)
    },
    materialize: async (request: VerificationRequest, reporter: string): Promise<void> => {
      if (await verificationExportDigest(request.candidateExportPath, undefined, true) !== request.candidateExportDigest) throw new Error('候选export与冻结摘要不匹配')
      const payload = { reporter: Buffer.from(reporter).toString('base64'), exportDigest: request.candidateExportDigest, runnerDigest: hash(reporter), cwd: request.policy.cwd }
      let receipt = await effect('materialize', payload, frames(request.candidateExportPath))
      if (receipt.settled && receipt.uploaded === false) receipt = await effect('materialize', payload, frames(request.candidateExportPath), true)
      if (!receipt.settled || !receipt.uploaded || !receipt.attestation) throw new Error(`远端上传未完成或未认证：${receipt.reason ?? receipt.rejected ?? '缺少物化原件'}`)
      await save({ attestation: receipt.attestation })
    },
    attest: async (): Promise<void> => {
      const actual = await scoped({ action: 'attest', cwd: read().config.policy.cwd }) as { exportDigest: string; runnerDigest: string }
      if (actual.exportDigest !== read().config.exportDigest || actual.runnerDigest !== read().config.runnerDigest) throw new Error('远端恢复export/reporter模式或字节不匹配')
    },
    close,
    recordRemovalObservation: async (absence: VerificationCommandResult): Promise<void> => {
      if (read().phase !== 'terminal' || absence.exitCode === 0 || absence.truncated || !/No such (object|container)/i.test(absence.stderr) || !read().transport!.closed) throw new Error('删除恢复观察缺少原terminal/closed/精确不存在')
      await save({ removal: { kind: 'container-absence', containerId: read().containerId, uniqueContainerName: read().uniqueContainerName, observation: absence } })
    },
    cleanup: async (): Promise<void> => {
      await close()
      const prior = read().transport!.effects.find(item => item.kind === 'cleanup')
      let observation: unknown
      if (prior) {
        const seen = await scoped({ action: 'observe', effect: prior }) as { receipt?: Receipt; intent: boolean; closed: boolean }
        if (seen.receipt?.cleaned) observation = seen.receipt
        else if (!seen.intent && seen.closed) {
          const receipt = await effect('cleanup', { containerId: read().containerId ?? read().uniqueContainerName }, undefined, true)
          if (!receipt.settled || !receipt.cleaned) throw new Error('已fence未执行的cleanup后继清理未完成')
          observation = receipt
        }
        else observation = await scoped({ action: 'cleanup-observation' })
      } else {
        const receipt = await effect('cleanup', { containerId: read().containerId ?? read().uniqueContainerName })
        if (!receipt.settled || !receipt.cleaned) throw new Error('远端staging清理未完成')
        observation = receipt
      }
      await save({ cleanup: observation })
    },
  }
}
