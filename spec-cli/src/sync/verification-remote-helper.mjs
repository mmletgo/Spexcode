import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'

const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.stringify(value)
const inside = (root, path) => path === root || path.startsWith(root + sep)
/**
 * @param {{effect: {kind: string}, args?: readonly string[], maxBytes?: number, reporter?: string, exportDigest?: string, runnerDigest?: string, containerId?: string, cwd?: string}} request
 * @returns {string}
 */
export const verificationEffectDigest = request => hash(json({ kind: request.effect.kind, args: request.args ?? null, maxBytes: request.maxBytes ?? null, reporter: request.reporter ?? null, exportDigest: request.exportDigest ?? null, runnerDigest: request.runnerDigest ?? null, containerId: request.containerId ?? null, cwd: request.cwd ?? null }))
const safePath = path => {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('不合法的候选路径')
  return path
}

/**
 * 本地与SSH使用同一walker；缺省保留旧本地摘要的路径字节。
 * @param {string} source
 * @param {string=} destination
 * @param {boolean=} portable
 * @returns {Promise<string>}
 */
export async function verificationExportDigest(source, destination, portable = false) {
  const root = await fs.realpath(source), digest = createHash('sha256')
  const visit = async directory => {
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = join(directory, name), entry = await fs.lstat(path), local = relative(root, path)
      const key = portable ? local.split(sep).join('/') : local
      if (name === '.git' || name === 'node_modules') throw new Error(`unsupported: export 不得包含 ${name}`)
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(path), absolute = resolve(dirname(path), target)
        if (isAbsolute(target) || !absolute.startsWith(root + sep) || relative(root, absolute).split(sep).some(part => part.toLowerCase() === '.git')) throw new Error(`导出符号链接越界: ${local}`)
        const resolved = await fs.realpath(path)
        if (!resolved.startsWith(root + sep) || relative(root, resolved).split(sep).some(part => part === '.git' || part === 'node_modules')) throw new Error(`unsupported: 符号链接越界或指向排除内容 ${local}`)
        digest.update(`symlink:${key}\0${target}\0`)
        if (destination) { checkParents(destination, join(destination, local)); await fs.symlink(target, join(destination, local)) }
      } else if (entry.isDirectory()) {
        digest.update(`directory:${key}\0`)
        if (destination) { checkParents(destination, join(destination, local)); await fs.mkdir(join(destination, local), { mode: 0o755 }) }
        await visit(path)
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(path)
        digest.update(`file:${key}:${entry.mode & 0o111}\0`).update(bytes).update('\0')
        if (destination) { const target = join(destination, local); checkParents(destination, target); await fs.writeFile(target, bytes, { flag: 'wx', mode: entry.mode & 0o111 ? 0o555 : 0o444 }); await fs.chmod(target, entry.mode & 0o111 ? 0o555 : 0o444) }
      } else throw new Error(`unsupported: export 包含非常规文件 ${local}`)
    }
  }
  await visit(root)
  return digest.digest('hex')
}

function checkParents(root, path, includeLeaf = false) {
  if (!inside(root, path)) throw new Error('写入路径越界')
  const parts = relative(root, includeLeaf ? path : dirname(path)).split(sep).filter(Boolean)
  let current = root
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('root不能为链接')
  for (const part of parts) {
    current = join(current, part)
    const entry = lstatSync(current)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('父目录不能为链接或非常规目录')
  }
}
function atomic(root, path, value) {
  checkParents(root, path)
  const temporary = path + '.tmp-' + randomUUID()
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, json(value)); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  checkParents(root, path)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('控制文件不能为链接')
  renameSync(temporary, path)
  const directory = openSync(dirname(path), 'r')
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
function readJson(root, path) {
  checkParents(root, path)
  const entry = lstatSync(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('控制记录不是普通文件')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function rootIdentity(root) {
  if (!isAbsolute(root) || realpathSync(root) !== root || root.includes(',')) throw new Error('远端root必须是无逗号canonical绝对目录')
  const entry = lstatSync(root)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077)) throw new Error('远端root必须是当前用户独占0700目录')
  return `${entry.dev}:${entry.ino}:${entry.uid}`
}
function scope(request) {
  const { plan, identity } = request
  if (rootIdentity(plan.privateRoot) !== plan.rootIdentity || !/^[a-f0-9]{64}$/.test(plan.runKey) || plan.directory !== join(plan.privateRoot, 'spex-verify-' + plan.runKey) || plan.candidatePath !== join(plan.directory, 'candidate') || plan.runnerPath !== join(plan.directory, 'runner')) throw new Error('远端原绑定不匹配')
  const controls = join(plan.privateRoot, '.spex-verification-control')
  if (!existsSync(controls)) { checkParents(plan.privateRoot, controls); mkdirSync(controls, { recursive: true, mode: 0o700 }) }
  checkParents(plan.privateRoot, controls, true)
  const control = join(controls, plan.runKey), marker = { version: 'verification-control-v1', plan, identity }
  if (!existsSync(control)) {
    checkParents(plan.privateRoot, control); mkdirSync(control, { mode: 0o700 })
    atomic(plan.privateRoot, join(control, 'identity.json'), marker)
    for (const name of ['intents', 'receipts', 'replies', 'observations']) { checkParents(plan.privateRoot, join(control, name)); mkdirSync(join(control, name), { mode: 0o700 }) }
    const fd = openSync(join(control, 'lock'), 'wx', 0o600); closeSync(fd)
  }
  checkParents(plan.privateRoot, control, true)
  if (json(readJson(plan.privateRoot, join(control, 'identity.json'))) !== json(marker)) throw new Error('控制marker缺失或身份不匹配')
  const lock = join(control, 'lock')
  checkParents(plan.privateRoot, lock)
  if (!lstatSync(lock).isFile() || lstatSync(lock).isSymbolicLink()) throw new Error('lock不是原普通文件')
  return { root: plan.privateRoot, control, lock, plan, identity }
}
function collect(program, argv, maxBytes, lockFd, environment) {
  return new Promise((fulfil, reject) => {
    const child = spawn(program, argv, { shell: false, ...(environment ? { env: environment } : {}), stdio: ['ignore', 'pipe', 'pipe', ...(lockFd === undefined ? [] : [lockFd])] })
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false
    const append = (chunk, output) => {
      const available = Math.max(0, maxBytes - stdout.length - stderr.length)
      if (chunk.length > available) truncated = true
      if (output === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, available)])
      else stderr = Buffer.concat([stderr, chunk.subarray(0, available)])
    }
    child.stdout.on('data', chunk => append(chunk, 'stdout')); child.stderr.on('data', chunk => append(chunk, 'stderr'))
    child.once('error', reject)
    child.once('close', code => fulfil({ exitCode: code ?? -1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), rawStdout: stdout, rawStderr: stderr, truncated }))
  })
}
function dockerCommand(request, options, args, maxBytes, lockFd) {
  const endpoint = request.plan?.dockerEndpoint ?? request.dockerEndpoint
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///') || endpoint.includes('\0')) throw new Error('unsupported: Docker endpoint必须是同SSH主机的本地Unix socket')
  const path = endpoint.slice('unix://'.length)
  if (!lstatSync(realpathSync(path)).isSocket()) throw new Error('unsupported: Docker endpoint不是实际Unix socket')
  return collect(options.dockerProgram ?? 'docker', ['--host', endpoint, ...args], maxBytes, lockFd, { ...process.env, DOCKER_HOST: '', DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '', DOCKER_TLS: '', DOCKER_CERT_PATH: '' })
}
async function locked(request, options, action) {
  const current = scope(request), fd = openSync(current.lock, 'r')
  try {
    const acquired = await collect(options.flockProgram ?? '/usr/bin/flock', ['-x', '-n', '3'], 4096, fd)
    if (acquired.exitCode !== 0) throw new Error('verification remote run busy; worker/CLI尚未排空')
    const daemon = await dockerCommand(request, options, ['info', '--format', '{{.ID}}'], 65536, fd)
    if (daemon.exitCode !== 0 || daemon.truncated || daemon.stdout.trim() !== request.plan.daemonId) throw new Error('远端Docker daemon原身份不匹配')
    return await action({ ...current, fd })
  } finally { closeSync(fd) }
}
function encode(result) {
  const stream = (value, original) => { const bytes = original ?? Buffer.from(value, 'utf8'); return { bytes: bytes.length, sha256: hash(bytes), gzip: gzipSync(bytes).toString('base64') } }
  return { exitCode: result.exitCode, stdout: stream(result.stdout, result.rawStdout), stderr: stream(result.stderr, result.rawStderr), truncated: result.truncated }
}
function effectPaths(current, effect) {
  if (!/^[a-z0-9-]+$/.test(effect.id) || !/^[a-f0-9]{64}$/.test(effect.digest)) throw new Error('无效effect身份')
  return { intent: join(current.control, 'intents', effect.id + '.json'), receipt: join(current.control, 'receipts', effect.id + '.json') }
}
function closed(current) { return existsSync(join(current.control, 'closed.json')) }
function effects(current) {
  return readdirSync(join(current.control, 'intents')).sort().map(name => {
    const intent = readJson(current.root, join(current.control, 'intents', name)), receipt = join(current.control, 'receipts', name)
    return { intent, ...(existsSync(receipt) ? { receipt: readJson(current.root, receipt) } : {}) }
  })
}
function drained(current) {
  return effects(current).filter(item => ['materialize', 'create', 'start'].includes(item.intent.effect.kind)).every(item => item.receipt?.settled === true)
}
async function attestation(current, cwd = '.') {
  const { plan } = current
  checkParents(current.root, plan.directory, true)
  if (json(readJson(current.root, join(plan.directory, 'owner.json'))) !== json({ plan, identity: current.identity })) throw new Error('staging marker不匹配')
  for (const path of [plan.candidatePath, plan.runnerPath]) if ((lstatSync(path).mode & 0o777) !== 0o755) throw new Error('物化根目录模式不匹配')
  const visit = async directory => {
    checkParents(current.root, directory, true)
    for (const name of await fs.readdir(directory)) {
      const path = join(directory, name), entry = await fs.lstat(path)
      if (entry.isDirectory()) { if ((entry.mode & 0o777) !== 0o755) throw new Error('candidate目录模式不匹配'); await visit(path) }
      else if (entry.isFile() && ![0o444, 0o555].includes(entry.mode & 0o777)) throw new Error('candidate文件模式不匹配')
    }
  }
  await visit(plan.candidatePath)
  checkParents(current.root, plan.runnerPath, true)
  if (json(readdirSync(plan.runnerPath).sort()) !== '["reporter.mjs"]') throw new Error('runner包含额外文件')
  const reporter = join(plan.runnerPath, 'reporter.mjs'), entry = lstatSync(reporter)
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o444) throw new Error('reporter模式不匹配')
  const exportDigest = await verificationExportDigest(plan.candidatePath, undefined, true)
  if (!(await fs.stat(cwd === '.' ? plan.candidatePath : join(plan.candidatePath, safePath(cwd)))).isDirectory()) throw new Error('验证cwd必须是候选内部目录')
  return { exportDigest, runnerDigest: hash(readFileSync(reporter)) }
}
async function materialize(current, request, stream) {
  const { plan } = current
  if (!Number.isFinite(request.deadlineAt)) throw new Error('上传缺少原冻结deadline')
  if (Date.now() >= request.deadlineAt) return { settled: true, uploaded: false, reason: '原上传期限已过' }
  if (existsSync(plan.directory)) {
    checkParents(current.root, plan.directory, true)
    if (json(readJson(current.root, join(plan.directory, 'owner.json'))) !== json({ plan, identity: current.identity })) throw new Error('不能重写未知staging')
    for (const part of ['candidate', 'runner']) { checkParents(current.root, join(plan.directory, part)); if (existsSync(join(plan.directory, part)) && lstatSync(join(plan.directory, part)).isSymbolicLink()) throw new Error('staging子目录不能为链接'); rmSync(join(plan.directory, part), { recursive: true, force: true }) }
  } else {
    checkParents(current.root, plan.directory); mkdirSync(plan.directory, { mode: 0o755 }); chmodSync(plan.directory, 0o755)
    atomic(current.root, join(plan.directory, 'owner.json'), { plan, identity: current.identity })
  }
  for (const part of ['candidate', 'runner']) { checkParents(current.root, join(plan.directory, part)); mkdirSync(join(plan.directory, part), { mode: 0o755 }); chmodSync(join(plan.directory, part), 0o755) }
  const links = []; let complete = false
  const uploadTimer = setTimeout(() => stream.destroy(new Error('上传超过原冻结deadline')), Math.max(1, request.deadlineAt - Date.now()))
  try { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    const frame = JSON.parse(line)
    if (complete) throw new Error('上传结束后还有数据')
    if (frame.kind === 'end') { complete = true; continue }
    const path = join(plan.candidatePath, safePath(frame.path)); checkParents(plan.candidatePath, path)
    if (frame.kind === 'directory') { mkdirSync(path, { mode: 0o755 }); chmodSync(path, 0o755) }
    else if (frame.kind === 'file') {
      if (![0, 0o111].includes(frame.executable)) throw new Error('不支持的执行权限')
      writeFileSync(path, Buffer.from(frame.bytes, 'base64'), { flag: 'wx', mode: frame.executable ? 0o555 : 0o444 })
    } else if (frame.kind === 'symlink') links.push(frame)
    else throw new Error('未知上传frame')
  } } finally { clearTimeout(uploadTimer) }
  if (!complete) return { settled: true, uploaded: false, reason: '上传流中断，已排空文件写入' }
  for (const frame of links) {
    const path = join(plan.candidatePath, safePath(frame.path)), resolved = resolve(dirname(path), frame.target)
    if (isAbsolute(frame.target) || !resolved.startsWith(plan.candidatePath + sep)) throw new Error('上传链接越界')
    checkParents(plan.candidatePath, path); await fs.symlink(frame.target, path)
  }
  const reporter = join(plan.runnerPath, 'reporter.mjs'); checkParents(current.root, reporter)
  writeFileSync(reporter, Buffer.from(request.reporter, 'base64'), { flag: 'wx', mode: 0o444 })
  const actual = await attestation(current, request.cwd)
  if (actual.exportDigest !== request.exportDigest || actual.runnerDigest !== request.runnerDigest) throw new Error('远端物化摘要不匹配')
  return { settled: true, uploaded: true, attestation: actual }
}
async function readHeader(stream) {
  return new Promise((fulfil, reject) => {
    let bytes = Buffer.alloc(0)
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf(10)
      if (end < 0) return
      stream.pause(); stream.off('data', onData); stream.off('end', onEnd); stream.off('error', reject)
      if (end + 1 < bytes.length) stream.unshift(bytes.subarray(end + 1))
      try { fulfil(JSON.parse(bytes.subarray(0, end).toString('utf8'))) } catch (error) { reject(error) }
    }
    const onEnd = () => reject(new Error('请求header不完整'))
    stream.on('data', onData); stream.once('end', onEnd); stream.once('error', reject); stream.resume()
  })
}
async function executeEffect(current, request, options, stream) {
  const paths = effectPaths(current, request.effect)
  if (verificationEffectDigest(request) !== request.effect.digest) throw new Error('effect实际载荷摘要不匹配')
  if (closed(current) && !['rm', 'cleanup', 'stop', 'kill'].includes(request.effect.kind)) return { rejected: 'closed', effect: request.effect }
  if (existsSync(paths.intent)) {
    if (json(readJson(current.root, paths.intent)) !== json({ effect: request.effect, payloadDigest: request.effect.digest })) throw new Error('effect重用载荷不匹配')
    if (existsSync(paths.receipt)) return readJson(current.root, paths.receipt)
    throw new Error('已有effect无完成receipt，保留unknown，不重复执行')
  }
  if (existsSync(join(current.control, 'cleanup.json'))) return { rejected: 'closed', effect: request.effect }
  atomic(current.root, paths.intent, { effect: request.effect, payloadDigest: request.effect.digest })
  let result
  if (request.effect.kind === 'materialize') {
    try {
      const existing = await dockerCommand(request, options, ['container', 'inspect', current.identity.uniqueContainerName], 1048576, current.fd)
      if (existing.truncated || existing.exitCode === 0 || !/No such (object|container)/i.test(existing.stderr)) throw new Error('上传前不能确认原名字容器不存在')
      result = await materialize(current, request, stream)
    }
    catch (error) { result = { settled: true, uploaded: false, reason: String(error) } }
  }
  else if (request.effect.kind === 'cleanup') {
    if (!closed(current) || !drained(current)) throw new Error('cleanup前closed或重建effect未排空')
    const existing = await dockerCommand(request, options, ['container', 'inspect', request.containerId ?? current.identity.uniqueContainerName], 1048576, current.fd)
    if (existing.truncated || existing.exitCode === 0 || !/No such (object|container)/i.test(existing.stderr)) throw new Error('cleanup前不能确认原容器不存在')
    if (existsSync(current.plan.directory)) {
      checkParents(current.root, current.plan.directory, true)
      if (json(readJson(current.root, join(current.plan.directory, 'owner.json'))) !== json({ plan: current.plan, identity: current.identity })) throw new Error('不能清理未知staging')
      rmSync(current.plan.directory, { recursive: true })
    }
    result = { settled: true, cleaned: true }
  } else {
    if (request.args[0] !== 'container' || request.args[1] !== request.effect.kind) throw new Error('Docker effect类型不匹配')
    const actual = await dockerCommand(request, options, request.args, request.maxBytes, current.fd)
    result = { settled: actual.exitCode === 0 && !actual.truncated, result: encode(actual) }
  }
  const receipt = { effect: request.effect, ...result }
  atomic(current.root, paths.receipt, receipt)
  if (request.effect.kind === 'cleanup' && result.cleaned) atomic(current.root, join(current.control, 'cleanup.json'), { effect: request.effect, observedAbsent: !existsSync(current.plan.directory) })
  return receipt
}

/**
 * 一次性worker脱离SSH；所有实际副作用在同run锁内。
 * @param {{dockerProgram?: string, flockProgram?: string, replyWaitMs?: number}=} options
 * @returns {Promise<void>}
 */
export async function verificationSshWorker(options = {}) {
  const request = await readHeader(process.stdin)
  const initial = scope(request), reply = join(initial.control, 'replies', request.requestId + '.json')
  try {
    const result = await locked(request, options, current => executeEffect(current, request, options, process.stdin))
    atomic(initial.root, reply, { ok: true, value: result })
  } catch (error) { atomic(initial.root, reply, { ok: false, error: String(error) }) }
}

/**
 * SSH入口只启动一次性worker或执行只读观察；候选帧永远只是数据。
 * @param {{dockerProgram?: string, flockProgram?: string, replyWaitMs?: number}=} options
 * @returns {Promise<void>}
 */
export async function verificationSshMain(options = {}) {
  try {
    const request = await readHeader(process.stdin)
    let value
    if (request.action === 'probe') {
      const identity = rootIdentity(request.privateRoot), daemon = await dockerCommand(request, options, ['info', '--format', '{{.ID}}'], 65536)
      if (daemon.exitCode !== 0 || daemon.truncated || !daemon.stdout.trim()) throw new Error('Docker daemon身份不可用')
      value = { rootIdentity: identity, daemonId: daemon.stdout.trim() }
    } else if (request.action === 'unscoped-read') {
      rootIdentity(request.privateRoot)
      if (!(request.args[0] === 'version' || request.args[0] === 'image' && request.args[1] === 'inspect')) throw new Error('未绑定请求只能环境只读检查')
      value = encode(await dockerCommand(request, options, request.args, request.maxBytes))
    } else if (request.action === 'effect') {
      if (!/^[a-f0-9-]+$/.test(request.requestId)) throw new Error('无效requestId')
      const current = scope(request), reply = join(current.control, 'replies', request.requestId + '.json')
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import(${json(import.meta.url)}).then(m=>m.verificationSshWorker(${json(options)}))`], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
      child.unref(); child.stdin.on('error', () => { /* worker拒绝/结束后，上传方会通过receipt取得原结果。 */ })
      const replyWaitMs = options.replyWaitMs ?? 10_000
      let replyDeadline = request.effect.kind === 'materialize' ? undefined : Date.now() + replyWaitMs
      process.stdin.once('end', () => { replyDeadline = Date.now() + replyWaitMs })
      child.stdin.write(json(request) + '\n'); process.stdin.pipe(child.stdin); process.stdin.resume()
      while (!existsSync(reply) && child.exitCode === null && child.signalCode === null && (replyDeadline === undefined || Date.now() < replyDeadline)) await new Promise(fulfil => setTimeout(fulfil, 25))
      process.stdin.unpipe(child.stdin); child.stdin.destroy(); process.stdin.destroy()
      if (!existsSync(reply)) {
        value = { pending: true, effect: request.effect }
      } else {
        const response = readJson(current.root, reply)
        if (!response.ok) throw new Error(response.error)
        value = response.value
      }
    } else value = await locked(request, options, async current => {
      if (request.action === 'read') {
        if (!(request.args[0] === 'version' || request.args[0] === 'image' && request.args[1] === 'inspect' || request.args[0] === 'container' && ['inspect', 'logs'].includes(request.args[1]))) throw new Error('只读请求不得执行变更')
        return encode(await dockerCommand(request, options, request.args, request.maxBytes, current.fd))
      }
      if (request.action === 'attest') return attestation(current, request.cwd)
      if (request.action === 'observe') {
        const paths = effectPaths(current, request.effect)
        return { ...(existsSync(paths.receipt) ? { receipt: readJson(current.root, paths.receipt) } : {}), intent: existsSync(paths.intent), closed: closed(current) }
      }
      if (request.action === 'close') {
        const path = join(current.control, 'closed.json')
        if (!existsSync(path)) atomic(current.root, path, { version: 'verification-closed-v1', identity: current.identity, plan: current.plan })
        return { closed: true, rebuildersDrained: drained(current), effects: effects(current), fencedNotExecuted: request.effects.filter(effect => !existsSync(effectPaths(current, effect).intent)).map(effect => effect.id) }
      }
      if (request.action === 'cleanup-observation') {
        if (!closed(current) || !drained(current) || existsSync(current.plan.directory)) throw new Error('清理不存在观察不满足closed/排空/路径条件')
        const observation = { kind: 'cleanup-absence', identity: current.identity, directory: current.plan.directory, absent: true }
        atomic(current.root, join(current.control, 'observations', 'cleanup.json'), observation)
        atomic(current.root, join(current.control, 'cleanup.json'), { observation })
        return observation
      }
      throw new Error('未知transport请求')
    })
    process.stdout.write(json({ ok: true, value }) + '\n')
  } catch (error) { process.stdout.write(json({ ok: false, error: String(error) }) + '\n') }
}
