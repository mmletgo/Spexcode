import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { VerificationCheckpoint, VerificationCommandResult, VerificationConfig, VerificationDependencies, VerificationDriver, VerificationEvidence, VerificationPolicy, VerificationRequest, VerificationResult, VerificationTestResult } from './verification-executor-types.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const reporter = (maxBytes: number): string => `export default async function* (source) {
  let bytes = 0; let truncated = false;
  for await (const event of source) {
    if (['test:pass','test:fail','test:plan','test:summary','test:stdout','test:stderr'].includes(event.type)) {
      const line = JSON.stringify({type:event.type,data:event.data})+'\\n';
      bytes += Buffer.byteLength(line);
      if (bytes <= ${maxBytes - 128} && !truncated) yield line;
      else if (!truncated) { truncated = true; yield JSON.stringify({type:'spex:truncated',data:{}})+'\\n'; }
    }
  }
}\n`
const MAX_INSPECT = 1024 * 1024

/** Docker 子进程退出只表示 CLI 结束；容器终态必须另外 inspect。 */
export const dockerVerificationDriver: VerificationDriver = (argv, maxBytes) => new Promise((fulfil, reject) => {
  const child = spawn('docker', [...argv], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let truncated = false
  const append = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
    const available = Math.max(0, maxBytes - stdout.length - stderr.length)
    if (chunk.length > available) truncated = true
    if (target === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, available)])
    else stderr = Buffer.concat([stderr, chunk.subarray(0, available)])
  }
  child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
  child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Docker CLI 超时；容器状态未确认')) }, 15_000)
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('close', code => { clearTimeout(timer); fulfil({ exitCode: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated }) })
})

function validatePolicy(policy: VerificationPolicy): void {
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(policy.image)) throw new Error('unsupported: 需要冻结 image@sha256')
  if (!['linux/arm64', 'linux/amd64'].includes(policy.platform)) throw new Error('unsupported: 当前仅支持 Linux Docker')
  if (policy.argv[0] !== 'node' || !policy.argv.includes('--test') || policy.argv.some(arg => arg.startsWith('--test-reporter') || arg === '--')) throw new Error('unsupported: 当前仅支持受信 node --test 命令')
  if (!policy.expectedTestIds.length || new Set(policy.expectedTestIds).size !== policy.expectedTestIds.length || policy.expectedTestIds.some(id => !/^[A-Z][A-Z0-9-]+$/.test(id))) throw new Error('unsupported: 验收 ID 必须唯一且非空')
  for (const key of ['timeoutMs', 'memoryBytes', 'cpus', 'pidsLimit', 'scratchBytes', 'logBytes'] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) throw new Error(`unsupported: 无效 ${key} 预算`)
  }
}

/** 复制完整 export，并拒绝 Git 元数据、宿主依赖和可逃逸的文件；不运行候选脚本。 */
export async function verificationExportDigest(source: string, destination?: string): Promise<string> {
  const root = await realpath(source)
  const hash = createHash('sha256')
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const entry = await lstat(path)
      const local = relative(root, path)
      if (name === '.git' || name === 'node_modules') throw new Error(`unsupported: export 不得包含 ${name}`)
      if (entry.isSymbolicLink()) throw new Error(`unsupported: export 不支持 symlink ${local} → ${await readlink(path)}`)
      if (entry.isDirectory()) {
        hash.update(`directory:${local}\0`)
        if (destination) await mkdir(join(destination, local), { recursive: true, mode: 0o755 })
        await visit(path)
      } else if (entry.isFile()) {
        const bytes = await readFile(path)
        hash.update(`file:${local}:${entry.mode & 0o111}\0`).update(bytes).update('\0')
        if (destination) {
          const target = join(destination, local)
          await writeFile(target, bytes)
          await chmod(target, entry.mode & 0o111 ? 0o555 : 0o444)
        }
      } else throw new Error(`unsupported: export 包含非常规文件 ${local}`)
    }
  }
  await visit(root)
  return hash.digest('hex')
}

type Inspect = {
  Id: string; Name: string; Image: string; Platform: string
  Config: { Image: string; User: string; WorkingDir: string; Entrypoint: string[]; Cmd: string[]; Labels: Record<string, string>; Env: string[]; Healthcheck?: { Test: string[] } }
  HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string; Privileged: boolean; CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[]; Init: boolean; AutoRemove: boolean; CgroupnsMode: string; RestartPolicy: { Name: string }; Memory: number; MemorySwap: number; NanoCpus: number; PidsLimit: number; Tmpfs: Record<string, string>; LogConfig: { Type: string; Config: Record<string, string> }; Binds: string[] | null; Devices: unknown[]; PidMode: string; IpcMode: string }
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[]
  State: { Status: string; Running: boolean; ExitCode: number; OOMKilled: boolean; Error: string }
}

function assertInspect(actual: Inspect, checkpoint: VerificationCheckpoint): void {
  const config = checkpoint.config
  const host = actual.HostConfig
  const expectedMounts = [{ Type: 'bind', Source: config.candidatePath, Destination: '/candidate', RW: false }, { Type: 'bind', Source: config.runnerPath, Destination: '/runner', RW: false }]
  const mounts = actual.Mounts.map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW })).sort((a, b) => a.Destination.localeCompare(b.Destination))
  if (actual.Name !== `/${checkpoint.uniqueContainerName}` || actual.Image !== config.imageId || actual.Config.Image !== config.image || actual.Platform !== 'linux' || Object.entries(checkpoint.labels).some(([key, value]) => actual.Config.Labels[key] !== value) || Object.keys(actual.Config.Labels).filter(key => key.startsWith('spex.')).length !== Object.keys(checkpoint.labels).length) throw new Error('容器身份、labels 或镜像不匹配，拒绝接管')
  if (checkpoint.containerId && actual.Id !== checkpoint.containerId) throw new Error('容器 ID 不匹配，拒绝接管')
  if (actual.Config.User !== '1000:1000' || actual.Config.WorkingDir !== '/candidate' || JSON.stringify(actual.Config.Entrypoint) !== JSON.stringify([config.argv[0]]) || JSON.stringify(actual.Config.Cmd) !== JSON.stringify(config.argv.slice(1)) || actual.Config.Healthcheck?.Test[0] !== 'NONE' || JSON.stringify([...actual.Config.Env].sort()) !== JSON.stringify([...config.environment].sort())) throw new Error('容器 command/user/healthcheck 不匹配')
  if (!host.ReadonlyRootfs || host.NetworkMode !== 'none' || host.Privileged || JSON.stringify(host.CapDrop) !== '["ALL"]' || host.CapAdd?.length || JSON.stringify(host.SecurityOpt) !== '["no-new-privileges"]' || !host.Init || host.AutoRemove || host.CgroupnsMode !== 'private' || host.RestartPolicy.Name !== 'no' || host.Memory !== config.policy.memoryBytes || host.MemorySwap !== config.policy.memoryBytes || host.NanoCpus !== config.policy.cpus * 1e9 || host.PidsLimit !== config.policy.pidsLimit || host.Devices.length || host.PidMode || host.IpcMode !== 'private') throw new Error('容器安全或预算配置不匹配')
  if (JSON.stringify(mounts) !== JSON.stringify(expectedMounts) || host.Binds?.length || JSON.stringify(host.Tmpfs) !== JSON.stringify({ '/tmp': `rw,noexec,nosuid,nodev,size=${config.policy.scratchBytes},mode=1777` })) throw new Error('容器 mounts/scratch 不匹配')
  if (host.LogConfig.Type !== 'local' || host.LogConfig.Config['max-size'] !== String(config.policy.logBytes) || host.LogConfig.Config['max-file'] !== '1' || host.LogConfig.Config['compress'] !== 'false') throw new Error('容器日志预算不匹配')
}

function createArgs(checkpoint: VerificationCheckpoint): string[] {
  const { config, labels, uniqueContainerName } = checkpoint
  const policy = config.policy
  return ['container', 'create', '--pull', 'never', '--name', uniqueContainerName, '--platform', config.platform, '--user', '1000:1000', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init', '--restart', 'no', '--no-healthcheck', '--ipc', 'private', '--cgroupns', 'private', '--memory', String(policy.memoryBytes), '--memory-swap', String(policy.memoryBytes), '--cpus', String(policy.cpus), '--pids-limit', String(policy.pidsLimit), '--log-driver', 'local', '--log-opt', `max-size=${policy.logBytes}`, '--log-opt', 'max-file=1', '--log-opt', 'compress=false', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${policy.scratchBytes},mode=1777`, '--mount', `type=bind,src=${config.candidatePath},dst=/candidate,readonly`, '--mount', `type=bind,src=${config.runnerPath},dst=/runner,readonly`, '--workdir', '/candidate', '--env', 'HOME=/tmp', '--env', 'NODE_OPTIONS=', '--entrypoint', config.argv[0], ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), config.image, ...config.argv.slice(1)]
}

/** 仅消费可信 Node reporter 的事件；子测试 stdout/stderr 是数据，不冒充测试事件。 */
export function parseVerificationReport(stdout: string, expectedIds: readonly string[]): { tests: VerificationTestResult[]; unmatchedTestIds: string[]; reportComplete: boolean; reportTruncated: boolean } {
  const tests: VerificationTestResult[] = []
  let complete = false
  let malformed = false
  let reportTruncated = false
  let resultCount = 0
  let summaries = 0
  let declaredResults = -1
  for (const line of stdout.trim().split('\n')) {
    try {
      const event = JSON.parse(line) as { type: string; data: { name?: string; skip?: boolean; todo?: boolean; nesting?: number; success?: boolean; file?: string; counts?: { tests: number; suites?: number } } }
      if (event.type === 'spex:truncated') { malformed = true; reportTruncated = true }
      if (event.type === 'test:summary' && !event.data.file) {
        summaries++
        complete = event.data.success === true && typeof event.data.counts?.tests === 'number'
        declaredResults = (event.data.counts?.tests ?? -1) + (event.data.counts?.suites ?? 0)
      }
      if (['test:pass', 'test:fail'].includes(event.type)) {
        resultCount++
        const id = event.data.name?.split(' ')[0]
        if (id && expectedIds.includes(id)) tests.push({ testId: id, status: event.data.skip || event.data.todo ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed' })
      }
    } catch { malformed = true }
  }
  const unmatchedTestIds = expectedIds.filter(id => tests.filter(test => test.testId === id).length !== 1)
  return { tests, unmatchedTestIds, reportComplete: complete && summaries === 1 && declaredResults === resultCount && !malformed, reportTruncated }
}

/** 运行/恢复一次真实隔离验收；持久失败保留容器，绝不释放未知资源。 */
export async function executeVerification(request: VerificationRequest, dependencies: VerificationDependencies): Promise<VerificationResult> {
  const driver = dependencies.driver ?? dockerVerificationDriver
  let checkpoint = request.previousCheckpoint
  const command = async (args: string[], bytes = MAX_INSPECT): Promise<VerificationCommandResult> => {
    const result = await driver(args, bytes)
    if (result.exitCode !== 0 || result.truncated) throw new Error(`Docker ${args.slice(0, 2).join(' ')} 失败：${result.stderr || result.stdout}`)
    return result
  }
  const persist = async (next: VerificationCheckpoint): Promise<void> => {
    await dependencies.onCheckpoint(structuredClone(next))
    checkpoint = next
  }
  const inspect = async (identity: string): Promise<Inspect> => JSON.parse((await command(['container', 'inspect', identity])).stdout)[0] as Inspect
  try {
    validatePolicy(request.policy)
    if (!request.runId || !request.inputDigest || !request.candidateDigest || !request.candidateExportDigest) throw new Error('unsupported: 缺少执行身份/内容绑定')
    const policyDigest = digest(JSON.stringify(request.policy))
    if (checkpoint && (checkpoint.runId !== request.runId || checkpoint.inputDigest !== request.inputDigest || checkpoint.candidateDigest !== request.candidateDigest || checkpoint.policyDigest !== policyDigest || checkpoint.config.exportDigest !== request.candidateExportDigest || checkpoint.configDigest !== digest(JSON.stringify(checkpoint.config)))) throw new Error('恢复检查点与输入/政策不匹配')
    if (checkpoint?.phase === 'removed') return { status: checkpoint.evidence!.outcome, checkpoint, evidence: checkpoint.evidence }
    const environment = JSON.parse((await command(['version', '--format', '{{json .Server}}'])).stdout) as { Os: string; Arch: string; Version: string }
    if (environment.Os !== 'linux' || `linux/${environment.Arch}` !== request.policy.platform) throw new Error('unsupported: Docker platform 不满足政策')
    if (!checkpoint) {
      if (request.signal?.aborted) return { status: 'cancelled', reason: '开始前取消' }
      const image = JSON.parse((await command(['image', 'inspect', request.policy.image])).stdout)[0] as { Id: string; Os: string; Architecture: string; Config: { Env: string[]; Volumes: Record<string, unknown> | null } }
      if (`${image.Os}/${image.Architecture}` !== request.policy.platform || Object.keys(image.Config.Volumes ?? {}).length) throw new Error('unsupported: 镜像 platform/anonymous volume 不满足政策')
      await mkdir(request.privateScratchRoot, { recursive: true, mode: 0o700 })
      const scratchRoot = await realpath(request.privateScratchRoot)
      const scratchStat = await lstat(scratchRoot)
      if (scratchStat.uid !== process.getuid?.() || (scratchStat.mode & 0o077) !== 0) throw new Error('unsupported: scratch root 必须是当前用户独占的目录')
      const directory = await mkdtemp(join(scratchRoot, 'spex-verify-'))
      const candidatePath = join(directory, 'candidate')
      const runnerPath = join(directory, 'runner')
      await mkdir(candidatePath, { mode: 0o755 })
      await mkdir(runnerPath, { mode: 0o755 })
      const exportDigest = await verificationExportDigest(request.candidateExportPath, candidatePath)
      if (exportDigest !== request.candidateExportDigest) throw new Error('unsupported: 候选 export 与冻结摘要不匹配')
      await writeFile(join(runnerPath, 'reporter.mjs'), reporter(request.policy.logBytes), { mode: 0o444 })
      await chmod(directory, 0o755)
      const config: VerificationConfig = { image: request.policy.image, imageId: image.Id, environment: [...image.Config.Env.filter(value => !/^(HOME|NODE_OPTIONS)=/.test(value)), 'HOME=/tmp', 'NODE_OPTIONS='], platform: request.policy.platform, argv: ['node', '--test-reporter=/runner/reporter.mjs', ...request.policy.argv.slice(1)], candidatePath, runnerPath, exportDigest, policy: structuredClone(request.policy), runnerDigest: digest(reporter(request.policy.logBytes)) }
      if ([candidatePath, runnerPath].some(path => path.includes(','))) throw new Error('unsupported: mount 路径包含逗号')
      const configDigest = digest(JSON.stringify(config))
      const uniqueContainerName = `spex-verify-${randomUUID()}`
      const labels = { 'spex.owner': 'verification-v1', 'spex.run': request.runId, 'spex.input': request.inputDigest, 'spex.candidate': request.candidateDigest, 'spex.config': configDigest }
      await persist({ version: 'verification-checkpoint-v1', phase: 'planned', runId: request.runId, inputDigest: request.inputDigest, candidateDigest: request.candidateDigest, policyDigest, uniqueContainerName, labels, configDigest, config, daemonVersion: environment.Version, deadlineAt: Date.now() + request.policy.timeoutMs })
    }
    const current = checkpoint!
    if (current.phase !== 'terminal' && (await verificationExportDigest(current.config.candidatePath) !== current.config.exportDigest || digest(await readFile(join(current.config.runnerPath, 'reporter.mjs'), 'utf8')) !== current.config.runnerDigest)) throw new Error('恢复 export/reporter 字节不匹配')
    if (current.phase === 'terminal') {
      const existing = await driver(['container', 'inspect', current.containerId!], MAX_INSPECT)
      if (existing.exitCode === 0) {
        const actual = JSON.parse(existing.stdout)[0] as Inspect
        assertInspect(actual, current)
        if (actual.State.Running || (!['exited', 'dead'].includes(actual.State.Status) && !(actual.State.Status === 'created' && ['cancelled', 'timeout'].includes(current.evidence!.outcome)))) throw new Error('终态检查点对应容器仍未终止')
        await command(['container', 'rm', current.containerId!])
      } else if (!/No such (object|container)/i.test(existing.stderr)) throw new Error('无法确认终态容器是否已清理')
      await persist({ ...current, phase: 'removed' })
      return { status: checkpoint!.evidence!.outcome, checkpoint, evidence: checkpoint!.evidence }
    }
    let actual: Inspect
    if (current.phase === 'planned') {
      const existing = await driver(['container', 'inspect', current.uniqueContainerName], MAX_INSPECT)
      if (existing.exitCode === 0 && !existing.truncated) actual = JSON.parse(existing.stdout)[0] as Inspect
      else {
        if (!/No such (object|container)/i.test(existing.stderr)) throw new Error('无法确认计划容器不存在')
        await command(createArgs(current))
        actual = await inspect(current.uniqueContainerName)
      }
      assertInspect(actual, current)
      await persist({ ...current, phase: 'created', containerId: actual.Id, createdInspect: actual })
    } else {
      actual = await inspect(current.containerId!)
      assertInspect(actual, current)
    }
    const id = checkpoint!.containerId!
    actual = await inspect(id)
    assertInspect(actual, checkpoint!)
    let outcome: VerificationEvidence['outcome'] | undefined
    if (actual.State.Status === 'created' && !request.signal?.aborted && Date.now() < checkpoint!.deadlineAt) {
      await command(['container', 'start', id])
      actual = await inspect(id)
      assertInspect(actual, checkpoint!)
    }
    while (actual.State.Running || actual.State.Status === 'created') {
      if (request.signal?.aborted || Date.now() >= checkpoint!.deadlineAt) {
        outcome = request.signal?.aborted ? 'cancelled' : 'timeout'
        if (actual.State.Running) {
          await driver(['container', 'stop', '--time', '1', id], MAX_INSPECT)
          actual = await inspect(id)
          if (actual.State.Running) {
            await command(['container', 'kill', id])
            actual = await inspect(id)
          }
        } else { // 未启动容器的终止是无运行副作用的精确删除；证据仍先持久。
          break
        }
        break
      }
      await new Promise<void>(fulfil => setTimeout(fulfil, 50))
      actual = await inspect(id)
      assertInspect(actual, checkpoint!)
    }
    if (actual.State.Running || (!['exited', 'dead'].includes(actual.State.Status) && !(actual.State.Status === 'created' && outcome))) throw new Error('无法确认真实容器终态')
    assertInspect(actual, checkpoint!)
    const logs = actual.State.Status === 'created' ? { exitCode: 0, stdout: '', stderr: '', truncated: false } : await driver(['container', 'logs', id], request.policy.logBytes)
    if (logs.exitCode !== 0) throw new Error('容器 logs 获取失败')
    const report = parseVerificationReport(logs.stdout, request.policy.expectedTestIds)
    outcome ??= actual.State.ExitCode === 0 && !actual.State.OOMKilled && !actual.State.Error && !logs.truncated && report.reportComplete && !report.unmatchedTestIds.length && report.tests.every(test => test.status === 'passed') ? 'passed' : 'failed'
    const evidence: VerificationEvidence = { runId: request.runId, inputDigest: request.inputDigest, candidateDigest: request.candidateDigest, exportDigest: checkpoint!.config.exportDigest, policyDigest, configDigest: checkpoint!.configDigest, runnerDigest: checkpoint!.config.runnerDigest, environment: { driver: 'docker', platform: request.policy.platform, image: request.policy.image, imageId: actual.Image, daemonVersion: environment.Version }, containerId: id, exitCode: actual.State.ExitCode, stdout: logs.stdout, stderr: logs.stderr, logsTruncated: logs.truncated || report.reportTruncated, reportFormat: 'node-test-events-v1', ...report, terminalInspect: actual, outcome }
    await persist({ ...checkpoint!, phase: 'terminal', evidence })
    await command(['container', 'rm', id])
    await persist({ ...checkpoint!, phase: 'removed' })
    return { status: outcome, checkpoint, evidence }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: checkpoint ? 'recovery_required' : 'unsupported', checkpoint, evidence: checkpoint?.evidence, reason }
  }
}
