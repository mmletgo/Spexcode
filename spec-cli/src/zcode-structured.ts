import { Ajv } from 'ajv'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { detachedRuntimeIsGone, processStartToken, verifyDetachedRuntime, writeDetachedRuntimeReceipt, type ProcessIdentity } from '@spexcode/spec-core'
import { StructuredSessionError, structuredExecutionPolicy, structuredSeatbeltProfile, type StructuredExecution } from './session-structured-policy.js'
import { decodeZCodeJsonText, type ZCodeFrozenReadProof, type ZCodeFrozenWitness } from './zcode-frozen-proof.js'

export const zcodeCapability = Object.freeze({
  cliVersion: '0.17.1',
  cliSha256: '9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6',
  builtinSha256: 'e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9',
  builtinPath: '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json',
  tool: 'mcp__frozen__spex_read_frozen',
})
export type ZCodeNativeState = { version: 1; root: string; sessionId: string; inputId: string; pid?: number; receiptFile?: string; turnId?: string }
export type ZCodeStructuredExecution = Omit<StructuredExecution, 'version' | 'policy' | 'frozenReadProof'> & {
  version: 4; policy: 'zcode-frozen-read-only-v1'; zcodeNative?: ZCodeNativeState; frozenReadProof?: ZCodeFrozenReadProof
}
type NativeCallbacks = { onThread(id: string): Promise<void>; onTurn(id: string): Promise<void>; onTurnStarting?(): Promise<void>; onNative(state: ZCodeNativeState): Promise<void>; onTimeout?(): Promise<void>; signal?: AbortSignal }
type NativeResult = { threadId: string; turnId: string; text: string; frozenReadProof: ZCodeFrozenReadProof }
type NativeEvent = { sessionId: string; turnId?: string; seq: number; eventId: string; type: string; payload: Record<string, unknown> }
type NativePlan = ZCodeNativeState & { requestDigest: string; policyDigest: string; cliPath: string; cliVersion: string; cliSha256: string; builtinSha256: string; model: { providerId: string; modelId: string }; queryId: string; runtime: string; tmp: string; workspace: string; receiptFile: string }
type StopResult = { nativeStopped: boolean; acknowledged: boolean; nativeStatus?: string; error?: string }
type StopEvidence = { code: number | null; signal: NodeJS.Signals | null; stopped: boolean; acknowledged: boolean; idle: boolean; closed: boolean; stderrBytes: number; stderrSha256: string }
type Completed = { plan: NativePlan; witness: ZCodeFrozenWitness; result: NativeResult }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytesDigest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))
const active = new Map<string, { interrupt(): void }>()
const fixedPolicy = (execution: ZCodeStructuredExecution) => ({ ...structuredExecutionPolicy(execution), version: 4, policy: 'zcode-frozen-read-only-v1' })

/** namespace只做原生路由，provider与模型必须同时明确，不接受动态别名。 */
export function zcodeNativeModel(model: string | undefined): { providerId: string; modelId: string } {
  const match = /^zcode:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(model ?? '')
  if (!match || ['default', 'auto', 'latest', 'fast', 'smart'].includes(match[2].toLowerCase())) throw new StructuredSessionError('unsupported', 'ZCode execution requires zcode:<provider-id>/<exact-model-id>')
  return { providerId: match[1], modelId: match[2] }
}

/** 只解一个完整json围栏；不修补正文，不接受解释文字、多段或宽松JSON。 */
export function decodeZCodeStructuredText(text: string): unknown {
  try { return JSON.parse(decodeZCodeJsonText(text)) as unknown }
  catch { throw new StructuredSessionError('failed', 'ZCode terminal response is not one strict JSON document') }
}

/** 仅返回原样安全证明事件；transport只按type计数，绝不读取或保存headers。 */
export function zcodeProofEvent(event: NativeEvent): NativeEvent | undefined {
  if (['turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'tool.updated'].includes(event.type)) return event
  if (event.type !== 'session.updated' || typeof event.payload.toolCount !== 'number') return undefined
  const keys = ['messageCount', 'providerId', 'modelId', 'temperature', 'maxTokens', 'toolCount', 'iteration']
  if (Object.keys(event.payload).some(key => !keys.includes(key))) throw new StructuredSessionError('stale_result', 'ZCode ModelRequest includes unknown proof fields')
  return event
}

/** 配置由控制面固定，SDK只消费认证路径引用；不继承用户能力或读取认证字节。 */
export function zcodeRuntimeConfiguration(): Record<string, unknown> {
  return { features: { mcp: true, subagent: false, memory: false, skill: false }, mcp: { servers: {} }, plugins: { enabled: false, dirs: [], enabledPlugins: {}, extraKnownMarketplaces: {}, options: {}, suppressedBuiltins: [] }, hooks: { enabled: false, events: {} }, skills: { enabled: false, includeInstructions: false, roots: [] } }
}

function writeJson(path: string, value: unknown, immutable = false): void {
  const bytes = JSON.stringify(value)
  if (immutable && existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new StructuredSessionError('stale_result', 'ZCode immutable native evidence differs')
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, bytes, { mode: immutable ? 0o400 : 0o600 }); renameSync(temporary, path)
}

/** 宿主只读ps元数据补充reader内不可用的startToken，不读取命令行或认证参数。 */
function sampleOwnedProcesses(plan: NativePlan): ProcessIdentity[] {
  const saved = join(plan.root, 'owned-processes.json')
  const owned = new Map((existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) as ProcessIdentity[] : []).map(item => [item.pid, item]))
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new StructuredSessionError('cancellation_pending', 'ZCode owned process observation is unavailable')
  const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) throw new StructuredSessionError('cancellation_pending', 'ZCode process observation has an unknown shape')
    return { pid: Number(match[1]), ppid: Number(match[2]), startToken: match[3].replace(/\s+/g, ' ') }
  })
  const queue = [plan.pid!], seen = new Set<number>()
  while (queue.length) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find(item => item.pid === pid), old = owned.get(pid)
    if (old && row && old.startToken !== row.startToken) continue
    if (row) owned.set(pid, { pid, startToken: row.startToken })
    queue.push(...rows.filter(item => item.ppid === pid).map(item => item.pid))
  }
  const identities = [...owned.values()]
  writeJson(saved, identities)
  return identities
}

function processIdentityState(identity: ProcessIdentity): 'live' | 'gone' | 'unknown' {
  const start = processStartToken(identity.pid)?.replace(/\s+/g, ' ')
  if (start) return start === identity.startToken ? 'live' : 'gone'
  try { process.kill(identity.pid, 0); return 'unknown' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown' }
}

/** 整组、宿主观察后代与实际reader记录分别核死亡；缺身份不取得冷取消权限。 */
function ownedProcessesStopped(plan: NativePlan, terminate = false): boolean {
  if (!plan.pid || !existsSync(join(plan.root, 'owned-processes.json'))) return false
  const owned = JSON.parse(readFileSync(join(plan.root, 'owned-processes.json'), 'utf8')) as ProcessIdentity[]
  const ledger = join(plan.runtime, 'frozen-mcp', 'mcp-public.jsonl')
  const records = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; pid?: number; startToken?: string }) : []
  let stopped = detachedRuntimeIsGone(plan.pid, plan.receiptFile)
  for (const record of records.filter(item => item.type === 'process')) {
    if (!record.pid) return false
    if (!owned.some(item => item.pid === record.pid)) {
      if (record.startToken) owned.push({ pid: record.pid, startToken: record.startToken.replace(/\s+/g, ' ') })
      else {
        try { process.kill(record.pid, 0); return false }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
      }
    }
  }
  for (const identity of owned) {
    const state = processIdentityState(identity)
    if (state === 'gone') continue
    stopped = false
    if (terminate && state === 'live') {
      try { process.kill(identity.pid, 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  return stopped
}

function verifyPlan(plan: NativePlan, root: string, prompt: string | undefined, execution: ZCodeStructuredExecution): void {
  const native = execution.zcodeNative
  if (plan.root !== root || native?.root !== root || plan.sessionId !== native.sessionId || plan.inputId !== native.inputId
    || plan.policyDigest !== digest(fixedPolicy(execution)) || prompt !== undefined && plan.requestDigest !== digest({ prompt, policy: fixedPolicy(execution) })
    || plan.cliVersion !== zcodeCapability.cliVersion || plan.cliSha256 !== zcodeCapability.cliSha256 || plan.builtinSha256 !== zcodeCapability.builtinSha256
    || digest(plan.model) !== digest(zcodeNativeModel(execution.model)) || native.turnId && native.turnId !== plan.turnId || native.pid !== plan.pid || native.receiptFile && native.receiptFile !== plan.receiptFile
    || execution.threadId && execution.threadId !== plan.sessionId || execution.turnId && execution.turnId !== plan.turnId)
    throw new StructuredSessionError('stale_result', 'ZCode fixed native plan or durable identity differs')
}

async function settleResult(plan: NativePlan, prompt: string, execution: ZCodeStructuredExecution): Promise<NativeResult> {
  const terminal = JSON.parse(readFileSync(join(plan.root, 'terminal.json'), 'utf8')) as NativeEvent
  const exit = JSON.parse(readFileSync(join(plan.root, 'exit.json'), 'utf8')) as StopEvidence
  const messages = JSON.parse(readFileSync(join(plan.root, 'messages.json'), 'utf8')) as unknown[]
  const events = JSON.parse(readFileSync(join(plan.root, 'events.json'), 'utf8')) as NativeEvent[]
  const send = JSON.parse(readFileSync(join(plan.root, 'send.json'), 'utf8')) as { sessionId: string; content: string; inputId: string }
  if (!plan.turnId || terminal.type !== 'turn.completed' || terminal.sessionId !== plan.sessionId || terminal.turnId !== plan.turnId || terminal.payload.inputId !== plan.inputId
    || terminal.payload.resultType !== 'success' || typeof terminal.payload.response !== 'string' || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null)
    throw new StructuredSessionError('failed', 'ZCode has no exact successful terminal, close and complete native stop')
  const output = decodeZCodeStructuredText(terminal.payload.response), validate = new Ajv({ allErrors: true }).compile(execution.schema)
  if (!validate(output)) throw new StructuredSessionError('failed', 'ZCode terminal JSON does not match the pinned JSON schema')
  const mcpPath = join(plan.runtime, 'frozen-mcp', 'mcp-public.jsonl')
  const records = readFileSync(mcpPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const witness = { version: 1, provider: 'zcode', cliVersion: plan.cliVersion, cliSha256: plan.cliSha256, ...plan.model, sessionId: plan.sessionId, turnId: plan.turnId, inputId: plan.inputId, prompt, send, messages, events,
    mcpHistory: { records, digest: digest(records) } } as ZCodeFrozenWitness
  const { proveZCodeFrozenReads } = await import('./zcode-frozen-proof.js')
  const frozenReadProof = proveZCodeFrozenReads(execution.frozenContext!, witness)
  const result: NativeResult = { threadId: plan.sessionId, turnId: plan.turnId, text: JSON.stringify(output), frozenReadProof }
  writeJson(join(plan.root, 'witness.json'), witness, true)
  writeJson(join(plan.root, 'completed.json'), { plan, witness, result } satisfies Completed, true)
  return result
}

async function completedResult(root: string, prompt: string, execution: ZCodeStructuredExecution): Promise<NativeResult | null> {
  if (!existsSync(join(root, 'plan.json'))) return null
  const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as NativePlan
  verifyPlan(plan, root, prompt, execution)
  const path = join(root, 'completed.json')
  if (!existsSync(path)) {
    if (!['terminal.json', 'messages.json', 'events.json', 'exit.json', 'send.json'].every(name => existsSync(join(root, name))) || !ownedProcessesStopped(plan)) return null
    const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as StopEvidence
    const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as NativeEvent
    if (!exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null || terminal.type !== 'turn.completed' || terminal.payload.resultType !== 'success') return null
    return settleResult(plan, prompt, execution)
  }
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Completed
  const exit = JSON.parse(readFileSync(join(root, 'exit.json'), 'utf8')) as StopEvidence
  const mcpRecords = readFileSync(join(plan.runtime, 'frozen-mcp/mcp-public.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  if (digest(saved.plan) !== digest(plan) || digest(saved.witness) !== digest(JSON.parse(readFileSync(join(root, 'witness.json'), 'utf8')))
    || saved.witness.prompt !== prompt || digest(saved.witness.messages) !== digest(JSON.parse(readFileSync(join(root, 'messages.json'), 'utf8')))
    || digest(saved.witness.events) !== digest(JSON.parse(readFileSync(join(root, 'events.json'), 'utf8'))) || saved.witness.mcpHistory.digest !== digest(mcpRecords)
    || digest(saved.witness) !== saved.result.frozenReadProof.witnessDigest
    || !exit.stopped || !exit.idle || !exit.closed || exit.code !== 0 || exit.signal !== null)
    throw new StructuredSessionError('stale_result', 'ZCode completion cache differs from original native evidence')
  const { verifyZCodeFrozenReadProof } = await import('./zcode-frozen-proof.js')
  const proof = saved.result.frozenReadProof
  const terminal = JSON.parse(readFileSync(join(root, 'terminal.json'), 'utf8')) as NativeEvent
  const output = decodeZCodeStructuredText(terminal.payload.response as string), validate = new Ajv({ allErrors: true }).compile(execution.schema)
  verifyZCodeFrozenReadProof(execution.frozenContext!, saved.result.frozenReadProof, { threadId: plan.sessionId, turnId: plan.turnId!, inputId: plan.inputId, prompt }, { ...plan.model, cliVersion: plan.cliVersion, cliSha256: plan.cliSha256 }, { output })
  if (!validate(output) || saved.result.text !== JSON.stringify(output) || digest(proof) !== digest(saved.result.frozenReadProof) || saved.result.threadId !== plan.sessionId || saved.result.turnId !== plan.turnId
    || !saved.witness.events.some(event => digest(event) === digest(terminal))) throw new StructuredSessionError('stale_result', 'ZCode original terminal, schema or proof differs from completion')
  if (execution.state === 'completed') {
    if (execution.threadId !== plan.sessionId || execution.turnId !== plan.turnId || execution.resultDigest !== digest(execution.output) || execution.resultDigest !== digest(output)
      || !execution.frozenReadProof || digest(execution.frozenReadProof) !== digest(proof)) throw new StructuredSessionError('stale_result', 'ZCode durable completed result or proof differs')
  } else if (!ownedProcessesStopped(plan)) return null
  return saved.result
}

/** 正式取消仅对同一固定plan及已核PID/start/receipt操作，不恢复或追加prompt。 */
export async function stopZCodeStructuredTurn(execution: ZCodeStructuredExecution, timeoutMs = 15000): Promise<StopResult> {
  const native = execution.zcodeNative
  if (!native) return execution.turnStartRequested ? { nativeStopped: false, acknowledged: false, error: 'ZCode dispatch identity is unproven' } : { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  const path = join(native.root, 'plan.json')
  if (!existsSync(path)) return { nativeStopped: false, acknowledged: false, error: 'ZCode exact launch plan is missing' }
  const plan = JSON.parse(readFileSync(path, 'utf8')) as NativePlan
  try { verifyPlan(plan, native.root, undefined, execution) }
  catch { return { nativeStopped: false, acknowledged: false, error: 'ZCode fixed launch policy or native identity differs' } }
  if (!execution.turnStartRequested && !plan.pid) return { nativeStopped: true, acknowledged: false, nativeStatus: 'notStarted' }
  if (!plan.pid || plan.pid !== native.pid || plan.receiptFile !== native.receiptFile) return { nativeStopped: false, acknowledged: false, error: 'ZCode launch/process identity differs' }
  const local = active.get(native.root)
  if (local) local.interrupt()
  else if (!detachedRuntimeIsGone(plan.pid, plan.receiptFile)) {
    if (!verifyDetachedRuntime(plan.pid, plan.receiptFile).ok) return { nativeStopped: false, acknowledged: false, error: 'ZCode detached runtime identity is unproven' }
    sampleOwnedProcesses(plan)
    try { process.kill(-plan.pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const deadline = Date.now() + timeoutMs
  while (!ownedProcessesStopped(plan, !local) && Date.now() < deadline) await sleep(50)
  const stopped = ownedProcessesStopped(plan), exitPath = join(native.root, 'exit.json')
  const exit = existsSync(exitPath) ? JSON.parse(readFileSync(exitPath, 'utf8')) as StopEvidence : undefined
  return { nativeStopped: stopped, acknowledged: exit?.acknowledged ?? false, nativeStatus: stopped ? 'stopped' : 'unknown', ...(!stopped ? { error: 'ZCode owned app/MCP processes remain unproven' } : {}) }
}

/** 单次真实send及原生证明共用已有结构化队列；未完成身份只允许精确取消。 */
export async function zcodeStructuredTurn(realm: string, id: string, prompt: string, execution: ZCodeStructuredExecution, callbacks: NativeCallbacks): Promise<NativeResult> {
  if (execution.version !== 4 || execution.policy !== 'zcode-frozen-read-only-v1' || !execution.frozenContext || execution.readerRuntime) throw new StructuredSessionError('unsupported', 'ZCode requires its exact isolated frozen policy')
  if (execution.effort !== undefined) throw new StructuredSessionError('unsupported', 'ZCode effort mapping has no verified frozen runtime capability')
  const model = zcodeNativeModel(execution.model), root = join(realm, id)
  const replay = await completedResult(root, prompt, execution)
  if (replay) return replay
  if (execution.zcodeNative || execution.turnStartRequested || execution.threadId || execution.turnId || existsSync(join(root, 'plan.json'))) throw new StructuredSessionError('cancellation_pending', 'ZCode in-progress dispatch cannot append another prompt; exact stop is required')
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw new StructuredSessionError('unsupported', 'ZCode requires the verified macOS read-only sandbox')
  const resolved = spawnSync('/usr/bin/which', ['zcode'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  if (resolved.error || resolved.status !== 0) throw new StructuredSessionError('unsupported', 'ZCode CLI is unavailable')
  const cliPath = realpathSync(resolved.stdout.trim())
  if (bytesDigest(cliPath) !== zcodeCapability.cliSha256 || !existsSync(zcodeCapability.builtinPath) || bytesDigest(zcodeCapability.builtinPath) !== zcodeCapability.builtinSha256) throw new StructuredSessionError('unsupported', 'ZCode CLI or public builtin capability digest is unverified')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const runtime = join(root, 'runtime'), home = join(runtime, 'home'), ledgerRoot = join(runtime, 'frozen-mcp'), tmp = mkdtempSync('/private/tmp/spex-zcode-tmp-'), workspace = mkdtempSync('/private/tmp/spex-zcode-frozen-')
  for (const path of [runtime, home, ledgerRoot, join(home, '.zcode/cli'), join(home, '.zcode/v2')]) mkdirSync(path, { recursive: true, mode: 0o700 })
  const config = join(home, '.zcode/cli/config.json'), credentialSource = join(homedir(), '.zcode/v2/credentials.json'), personal = join(homedir(), '.zcode/v2/provider_config.json'), credentialLink = join(home, '.zcode/v2/credentials.json')
  writeJson(config, zcodeRuntimeConfiguration(), true)
  if (existsSync(credentialSource)) symlinkSync(credentialSource, credentialLink)
  const input = join(root, 'reader-input.json'), profile = join(root, 'policy.sb')
  writeJson(input, { root: ledgerRoot, ref: execution.frozenContext }, true)
  let policy = structuredSeatbeltProfile(realpathSync(runtime)) + `(allow file-write* (subpath ${JSON.stringify(realpathSync(tmp))}))\n`
  for (const path of [config, credentialLink, credentialSource, personal, zcodeCapability.builtinPath, input, profile]) policy += `(deny file-write* (literal ${JSON.stringify(path)}))\n`
  writeFileSync(profile, policy, { mode: 0o400 })
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: `${tmp}/`, ZCODE_DATA_BASE_DIR: home, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: zcodeCapability.builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal }
  const version = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, cliPath, '--version'], { cwd: workspace, env, encoding: 'utf8', timeout: 10000 })
  if (version.error || version.status !== 0 || version.stdout.trim() !== zcodeCapability.cliVersion) throw new StructuredSessionError('unsupported', 'ZCode CLI version has no verified isolated capability identity')
  const oracle = join(root, 'outside-oracle.txt'); writeFileSync(oracle, 'UNCHANGED', { mode: 0o600 })
  const targets = { runtime: join(runtime, 'canary'), tmp: join(tmp, 'canary'), oracle, config, input, profile, frozen: execution.frozenContext.manifestPath, workspace: join(workspace, 'forbidden-write') }
  const canaryCode = `const fs=require('node:fs'),net=require('node:net'),x=JSON.parse(process.argv[1]),r={};for(const[k,p]of Object.entries(x)){try{if(['runtime','tmp','oracle','workspace'].includes(k))fs.appendFileSync(p,'CANARY');else fs.closeSync(fs.openSync(p,'a'));r[k]=true}catch{r[k]=false}}const s=net.createServer();s.once('error',()=>{r.socket=false;process.stdout.write(JSON.stringify(r));process.exitCode=1});s.listen(process.argv[2],()=>{r.socket=true;s.close(()=>process.stdout.write(JSON.stringify(r)))})`
  const canary = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', canaryCode, JSON.stringify(targets), join(tmp, 's.sock')], { cwd: workspace, env, encoding: 'utf8', timeout: 10000 })
  let boundary: Record<string, boolean> = {}
  if (!canary.error && canary.status === 0) { try { boundary = JSON.parse(canary.stdout) as typeof boundary } catch { /* fail closed below */ } }
  if (!boundary.runtime || !boundary.tmp || !boundary.socket || Object.keys(targets).filter(key => !['runtime', 'tmp'].includes(key)).some(key => boundary[key] !== false) || readFileSync(oracle, 'utf8') !== 'UNCHANGED') throw new StructuredSessionError('unsupported', 'ZCode exact read-only write/socket boundary preflight failed')
  writeJson(join(root, 'boundary.json'), { passed: true, results: boundary, profileSha256: bytesDigest(profile) }, true)
  let plan: NativePlan = { version: 1, root, sessionId: `sess_${randomUUID()}`, inputId: randomUUID(), queryId: randomUUID(), requestDigest: digest({ prompt, policy: fixedPolicy(execution) }), policyDigest: digest(fixedPolicy(execution)), cliPath, cliVersion: zcodeCapability.cliVersion, cliSha256: zcodeCapability.cliSha256, builtinSha256: zcodeCapability.builtinSha256, model, runtime, tmp, workspace, receiptFile: join(root, 'process.json') }
  writeJson(join(root, 'plan.json'), plan)
  const native = (): ZCodeNativeState => ({ version: 1, root, sessionId: plan.sessionId, inputId: plan.inputId, ...(plan.pid ? { pid: plan.pid, receiptFile: plan.receiptFile } : {}), ...(plan.turnId ? { turnId: plan.turnId } : {}) })
  await callbacks.onNative(native()); await callbacks.onTurnStarting?.()
  const child: ChildProcessWithoutNullStreams = spawn('/usr/bin/sandbox-exec', ['-f', profile, cliPath, 'app-server', '--cwd', workspace], { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (!child.pid) throw new StructuredSessionError('failed', 'ZCode isolated process could not start')
  let exited = false
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  try {
    writeDetachedRuntimeReceipt(child.pid, plan.receiptFile)
    plan = { ...plan, pid: child.pid }; writeJson(join(root, 'plan.json'), plan); sampleOwnedProcesses(plan); await callbacks.onNative(native())
  } catch {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
    throw new StructuredSessionError('cancellation_pending', 'ZCode spawned ownership could not be durably published; exact stop is required')
  }
  let nextId = 0, protocolError: Error | undefined, abortRequested = false, timedOut = false, acknowledged = false, sessionCreated = false, sent = false, closeAcknowledged = false, idle = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (exited || !child.stdin.writable) { reject(new StructuredSessionError('cancellation_pending', 'ZCode native transport ended before exact settlement')); return }
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new StructuredSessionError('cancellation_pending', `ZCode native RPC timeout (${method})`)) }, 10000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    let packet: { id?: number | string; method?: string; params?: { sessionId?: string }; result?: unknown; error?: { code?: number } }
    try { packet = JSON.parse(line) as typeof packet } catch { protocolError = new StructuredSessionError('failed', 'ZCode emitted non-JSON native protocol'); return }
    if (packet.method && packet.id !== undefined) {
      if (packet.method === 'session/requestRuntimePreferences' && packet.params?.sessionId === plan.sessionId) child.stdin.write(`${JSON.stringify({ id: packet.id, result: { nativeSearchEnhancementsEnabled: false, toolSearchMode: 'off', subagentRuntimeConfigEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, additionalDirectories: [], modelContextBudgetStrategy: 'preflight-v1' } })}\n`)
      else child.stdin.write(`${JSON.stringify({ id: packet.id, error: { code: -32601, message: 'Unavailable in frozen read-only runtime' } })}\n`)
      return
    }
    if (typeof packet.id !== 'number') return
    const waiter = pending.get(packet.id)
    if (!waiter) return
    pending.delete(packet.id); clearTimeout(waiter.timer)
    if (packet.error) waiter.reject(new StructuredSessionError('failed', `ZCode native RPC rejected (code ${typeof packet.error.code === 'number' ? packet.error.code : 'unknown'})`))
    else waiter.resolve(packet.result)
  })
  const stderrHash = createHash('sha256'); let stderrBytes = 0
  child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; stderrHash.update(bytes) })
  child.once('error', () => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode native process failed') })
  const events: NativeEvent[] = [], seen = new Set<string>(), counts: Record<string, number> = {}
  let terminal: NativeEvent | undefined, cursor: number | undefined, stopSent = false
  const interrupt = (): void => { abortRequested = true }
  active.set(root, { interrupt }); callbacks.signal?.addEventListener('abort', interrupt, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true; interrupt()
    void Promise.resolve().then(() => callbacks.onTimeout?.()).catch(() => { protocolError = new StructuredSessionError('cancellation_pending', 'ZCode timeout cancellation could not be durably published') })
  }, execution.timeoutMs)
  const poll = async (): Promise<void> => {
    sampleOwnedProcesses(plan)
    const page = await request('session/events', { sessionId: plan.sessionId, ...(cursor === undefined ? {} : { afterSeq: cursor }), limit: 100 }) as { events?: NativeEvent[] }
    for (const event of page.events ?? []) {
      if (seen.has(event.eventId)) continue
      seen.add(event.eventId)
      if (event.sessionId !== plan.sessionId || !Number.isSafeInteger(event.seq) || typeof event.eventId !== 'string') throw new StructuredSessionError('stale_result', 'ZCode native event identity differs')
      cursor = Math.max(cursor ?? -1, event.seq); counts[event.type] = (counts[event.type] ?? 0) + 1
      const safe = zcodeProofEvent(event)
      if (!safe) continue
      if (event.type === 'turn.started') {
        if (!sent || plan.turnId || !event.turnId || event.payload.inputId !== plan.inputId || event.payload.queryId !== plan.queryId) throw new StructuredSessionError('stale_result', 'ZCode has no exact original input/query turn identity')
        plan = { ...plan, turnId: event.turnId }; writeJson(join(root, 'plan.json'), plan); await callbacks.onNative(native()); await callbacks.onTurn(plan.turnId!)
      }
      if (!plan.turnId || event.turnId !== plan.turnId) throw new StructuredSessionError('stale_result', 'ZCode proof event belongs to another turn')
      if (event.type === 'session.updated' && (event.payload.providerId !== model.providerId || event.payload.modelId !== model.modelId || event.payload.toolCount !== 1)) throw new StructuredSessionError('unsupported', 'ZCode actual ModelRequest identity or toolCount differs')
      if (event.type === 'tool.updated' && event.payload.kind === 'scheduled' && event.payload.toolName !== zcodeCapability.tool) throw new StructuredSessionError('unsupported', 'ZCode scheduled an uncontrolled tool')
      events.push(event)
      if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
        if (terminal) throw new StructuredSessionError('stale_result', 'ZCode returned multiple terminal events')
        terminal = event; writeJson(join(root, 'terminal.json'), terminal, true)
      }
    }
    writeJson(join(root, 'events.json'), events); writeJson(join(root, 'event-counts.json'), counts)
  }
  const stop = async (): Promise<void> => {
    if (stopSent || !sessionCreated || terminal) return
    stopSent = true; await request('session/stop', { sessionId: plan.sessionId }); acknowledged = true
  }
  let resultError: unknown
  try {
    const source = import.meta.url.endsWith('.ts'), reader = fileURLToPath(new URL(source ? './claude-frozen-mcp.ts' : './claude-frozen-mcp.js', import.meta.url))
    const args = [...(source ? ['--import', import.meta.resolve('tsx')] : []), reader, input]
    const created = await request('session/create', { sessionId: plan.sessionId, workspace: { workspacePath: workspace, workspaceKey: workspace }, model, mode: 'plan', persistence: 'immediate', titleGenerationEnabled: false,
      mcpServers: [{ name: 'frozen', command: process.execPath, args, env: [], cwd: workspace, isolation: 'session', protocolVersion: 'legacy', alwaysLoad: true }], toolAllowlist: [zcodeCapability.tool], toolDenylist: ['Bash', 'Read', 'Edit', 'Write', 'Task', 'WebSearch', 'WebFetch'] }) as { session?: { sessionId: string; model: typeof model }; snapshot?: { session?: { sessionId: string; model: typeof model } } }
    const session = created.session ?? created.snapshot?.session
    if (session?.sessionId !== plan.sessionId || digest(session.model) !== digest(model)) throw new StructuredSessionError('unsupported', 'ZCode actual session model or identity differs')
    sessionCreated = true; await callbacks.onThread(plan.sessionId)
    if (callbacks.signal?.aborted) interrupt()
    if (abortRequested) throw new StructuredSessionError(timedOut ? 'timeout' : 'cancelled', 'ZCode cancelled before send')
    const send = { sessionId: plan.sessionId, content: prompt, inputId: plan.inputId }
    writeJson(join(root, 'send.json'), send, true); sent = true
    const ack = await request('session/send', { ...send, queryId: plan.queryId }) as { accepted?: boolean; sessionId?: string }
    if (ack.accepted !== true || ack.sessionId !== plan.sessionId) throw new StructuredSessionError('stale_result', 'ZCode send ACK has no exact accepted session')
    let cancellationDeadline: number | undefined
    while (!terminal) {
      if (protocolError) throw protocolError
      if (abortRequested) { await stop(); cancellationDeadline ??= Date.now() + 10000 }
      await poll()
      if (cancellationDeadline && Date.now() > cancellationDeadline) throw new StructuredSessionError('cancellation_pending', 'ZCode stop ACK has no bounded exact terminal')
      if (!terminal) await sleep(100)
    }
    const history = await request('session/messages', { sessionId: plan.sessionId }) as { messages?: unknown[]; hasMore?: boolean }
    if (!Array.isArray(history.messages) || history.hasMore === true) throw new StructuredSessionError('stale_result', 'ZCode raw native history is incomplete')
    writeJson(join(root, 'messages.json'), history.messages, true)
  } catch (error) { resultError = error }
  try {
    try {
      if (sent && !terminal) {
        await stop()
        const deadline = Date.now() + 10000
        while (!terminal && Date.now() < deadline && !exited) { await poll(); if (!terminal) await sleep(100) }
      }
      if (sessionCreated && (!sent || terminal)) {
        const deadline = Date.now() + 3000
        do {
          const snapshot = await request('session/read', { sessionId: plan.sessionId }) as { session?: { sessionId: string; status: string }; runtime?: { activeTurnId?: string; activeTurnKind?: string; pendingRequestIds?: unknown[] }; projection?: { currentTurnId?: string; pendingPermissions?: unknown[]; activeToolCalls?: { status?: string }[] } }
          idle = snapshot.session?.sessionId === plan.sessionId && snapshot.session.status === 'idle' && !!snapshot.runtime && !snapshot.runtime.activeTurnId && !snapshot.runtime.activeTurnKind
            && Array.isArray(snapshot.runtime.pendingRequestIds) && snapshot.runtime.pendingRequestIds.length === 0 && !!snapshot.projection && !snapshot.projection.currentTurnId
            && Array.isArray(snapshot.projection.pendingPermissions) && snapshot.projection.pendingPermissions.length === 0 && Array.isArray(snapshot.projection.activeToolCalls)
            && !snapshot.projection.activeToolCalls.some(tool => ['pending', 'running'].includes(tool.status ?? ''))
          if (!idle) await sleep(50)
        } while (!idle && Date.now() < deadline)
        writeJson(join(root, 'idle.json'), { sessionId: plan.sessionId, turnId: plan.turnId, idle }, true)
        if (!idle) throw new StructuredSessionError('cancellation_pending', 'ZCode exact terminal has no matching idle runtime')
        sampleOwnedProcesses(plan)
        const response = await request('session/close', { sessionId: plan.sessionId, expectedPersistence: 'immediate' }) as { closed?: boolean }
        closeAcknowledged = response.closed === true
      }
    } catch (error) { resultError ??= error }
    child.stdin.end()
    let exit = await Promise.race([closed, sleep(3000).then(() => undefined)])
    if (!exit || !ownedProcessesStopped(plan)) {
      if (verifyDetachedRuntime(plan.pid!, plan.receiptFile).ok) {
        sampleOwnedProcesses(plan)
        try { process.kill(-plan.pid!, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      const deadline = Date.now() + 3000
      while (!ownedProcessesStopped(plan, true) && Date.now() < deadline) await sleep(50)
      exit ??= await Promise.race([closed, sleep(100).then(() => undefined)])
    }
    const stopped = ownedProcessesStopped(plan)
    writeJson(join(root, 'exit.json'), { code: exit?.code ?? null, signal: exit?.signal ?? null, stopped, acknowledged, idle, closed: closeAcknowledged, stderrBytes, stderrSha256: stderrHash.digest('hex') } satisfies StopEvidence, true)
    if (!stopped) { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); resultError = new StructuredSessionError('cancellation_pending', 'ZCode app/MCP process stop is unproven') }
  } catch {
    resultError = new StructuredSessionError('cancellation_pending', 'ZCode native cleanup or stop evidence could not be settled')
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
  } finally {
    clearTimeout(timeout); callbacks.signal?.removeEventListener('abort', interrupt); active.delete(root); lines.close()
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new StructuredSessionError('cancellation_pending', 'ZCode transport closed')) }
  }
  if (abortRequested) throw new StructuredSessionError(ownedProcessesStopped(plan) ? timedOut ? 'timeout' : 'cancelled' : 'cancellation_pending', 'ZCode cancellation revoked result publication')
  if (resultError) throw resultError
  return settleResult(plan, prompt, execution)
}
