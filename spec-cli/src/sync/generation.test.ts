import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseContract } from '@spexcode/spec-core/contracts'
import type { Acceptance, ContractFinding } from '@spexcode/spec-core/contracts'
import { CANDIDATE_RESPONSE_SCHEMA, freezeCandidate, verifyCandidate } from './candidate.js'
import type { CandidateChanges } from './candidate.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { GENERATION_REVIEW_SCHEMA, freezeGenerationInput, generationReviewRequest, restoreGenerationInput, reviewError, runGeneration } from './generation.js'
import { candidateReviewSchema, candidateReviewError, candidateReviewLocationError } from './candidate-review.js'
import { rejectedFinalOutput, StructuredSessionError } from '../session-structured-policy.js'
import { nativeWorktreeResult } from '../native-worktree-runtime.js'
import { nativeWorktreePrompt } from '../native-worktree-runtime.js'
import type { GenerationInput, GenerationReview } from './generation-types.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence, writeObject, writeTree } from './snapshot.js'

const contractPath = '.spec/export/export-contract/spec.md'
async function input(t: test.TestContext, largeContext = false): Promise<GenerationInput> {
  const root = mkdtempSync(join(tmpdir(), 'spex-generation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  if (largeContext) {
    const path = join(root, 'tests/export.test.mjs')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n/* LARGE-CONTEXT-START ${'x'.repeat(2 * 1024 * 1024)} LARGE-CONTEXT-END */\n`)
  }
  const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) }
  git('init', '-b', 'main'); git('config', 'user.email', 'generation@example.invalid'); git('config', 'user.name', 'generation fixture'); git('add', '.'); git('commit', '-m', 'fixture')
  const snapshot = await captureInputSnapshot(root)
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString()]))
  const contract = parseContract({ nodeId: 'export-contract', path: contractPath, source: files.get(contractPath)! }).contract!
  return { root, requestKey: 'operation-1:attempt-1', snapshot, manifest: { version: 1, entries }, files, contracts: [contract], elaboratedSpecs: [{ path: contractPath, source: files.get(contractPath)! }], readyIds: ['REQ-EXPORT-01', 'AC-EXPORT-03'], blockedIds: [], intent: { nodeId: contract.nodeId, rawSource: contract.rawSource }, facts: [{ source: 'rule:RULE-EXPORT-01', text: '保留已有下载权限规则' }], existingAcceptance: contract.items.filter((item): item is Acceptance => item.kind === 'AC'), mandatoryTests: [], verifications: contract.items.filter(item => item.kind === 'VERIFY').map(item => ({ id: item.id, command: item.command, cwd: item.cwd, timeoutMs: item.timeoutMs })), allowedScope: { paths: ['src', 'tests', '.spec'], contractIds: ['REQ-EXPORT-01', 'AC-EXPORT-03'], flowIds: [] }, policy: { version: 'trusted-v1', digest: 'policy-digest' }, timeoutMs: 30_000, model: 'gpt-6.1-sol', effort: 'high' }
}
function changes(input: GenerationInput): unknown {
  const entry = input.manifest.entries.find(entry => entry.path === 'src/export.js')!
  return { version: 'sync-files-v1', changes: [{ path: entry.path, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content: `${input.files.get(entry.path)}\n// actual candidate implementation\n` }] }
}
function review(request: ElaborationSessionRequest): GenerationReview {
  const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as { inputId: string; candidate: { digest: string } }
  return { inputId: identity.inputId, candidateDigest: identity.candidate.digest, verdict: 'accept', checkedIds: ['REQ-EXPORT-01', 'AC-EXPORT-03'], findings: [] }
}
function runner(input: GenerationInput, generation: (request: ElaborationSessionRequest) => unknown = () => changes(input), inspect: (request: ElaborationSessionRequest) => unknown = review) {
  const calls: ElaborationSessionRequest[] = []
  const run: ElaborationRunner = async request => {
    calls.push(request)
    const output = request.purpose === 'code_generate' ? generation(request) : inspect(request)
    return { sessionId: `session-${calls.length}`, threadId: `thread-${calls.length}`, turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  return { calls, run }
}
const valid = async (): Promise<ContractFinding[]> => []

test('空候选项输出面也不与共享schema复用可变属性', () => {
  const schema = candidateReviewSchema({ inputId: 'input', candidateDigest: 'candidate', requiredIds: [], actualIds: [], priorIds: [] })
  const items = (schema.properties as { checkedIds: { items: Record<string, unknown> } }).checkedIds.items
  const before = JSON.stringify(GENERATION_REVIEW_SCHEMA)
  items.minLength = 99
  assert.equal(JSON.stringify(GENERATION_REVIEW_SCHEMA), before)
})

test('超过2MiB的真实冻结测试全文仍到达生成和独审，保留首尾及全部断言', async t => {
  const source = await input(t, true), assertions = source.files.get('tests/export.test.mjs')!
  const native = runner(source)
  const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.equal(native.calls.length, 2)
  for (const request of native.calls) {
    assert.ok(Buffer.byteLength(request.prompt) > 2 * 1024 * 1024)
    assert.ok(request.prompt.includes(JSON.stringify(assertions)), request.purpose)
    assert.ok(request.prompt.includes('LARGE-CONTEXT-START'))
    assert.ok(request.prompt.includes('LARGE-CONTEXT-END'))
  }
  assert.equal(result.candidateFiles!.get('tests/export.test.mjs'), assertions)
  assert.notEqual(result.traces[0].threadId, result.traces[1].threadId)
})

test('原生候选独审批读冻结正文，不构造未发送的内联投影，冷重建保持完整请求', async t => {
  const source = await input(t)
  mkdirSync(join(source.root, 'src/unprojected'))
  for (let index = 0; index < 64; index++) writeFileSync(join(source.root, `src/unprojected/${index}.txt`), `frozen unprojected ${index}\n`)
  writeFileSync(join(source.root, 'src/unprojected/duplicate.txt'), 'frozen unprojected 63\n')
  writeFileSync(join(source.root, 'src/unprojected/binary.dat'), Buffer.from([0, 255, 0]))
  symlinkSync('../export.js', join(source.root, 'src/unprojected/link'))
  execFileSync('git', ['-C', source.root, 'add', '.'])
  execFileSync('git', ['-C', source.root, 'commit', '-qm', 'frozen review corpus'])
  source.snapshot = await captureInputSnapshot(source.root)
  source.manifest = { version: 1, entries: readTree(source.snapshot.source.commonDir, source.snapshot.immutableTree) }
  source.nativeWorktree = true; source.model = 'claude:fixture'
  source.allowedScope.paths = ['src/export.js']
  const candidate = freezeCandidate(source.snapshot, changes(source), source.allowedScope)
  const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
  const originalExec = childProcess.execFileSync, originalStringify = JSON.stringify
  const gitCalls: string[][] = [], requests: ElaborationSessionRequest[] = []
  let inlineProjections = 0
  childProcess.execFileSync = ((...args: Parameters<typeof execFileSync>) => {
    if (args[0] === 'git') gitCalls.push(args[1] as string[])
    return Reflect.apply(originalExec, childProcess, args)
  }) as typeof execFileSync
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    const value: unknown = args[0]
    if (value && typeof value === 'object' && Object.hasOwn(value, 'manifestProjection')) inlineProjections++
    return Reflect.apply(originalStringify, JSON, args)
  }) as typeof JSON.stringify
  syncBuiltinESMExports()
  let result: Awaited<ReturnType<typeof runGeneration>>
  try {
    result = await runGeneration(source, { reviewCandidate: candidate, validateCandidate: valid, runner: async request => {
      requests.push(request)
      const output = { inputId: source.snapshot.id, candidateDigest: candidate.digest, verdict: 'accept', checkedIds: source.readyIds, findings: [] }
      return { sessionId: 'review-only', threadId: 'review-only-thread', turnId: 'review-only-turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    } })
  } finally {
    childProcess.execFileSync = originalExec; JSON.stringify = originalStringify; syncBuiltinESMExports()
  }
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].purpose, 'code_review')
  assert.equal(result.candidateFiles!.get('src/unprojected/63.txt'), 'frozen unprojected 63\n')
  assert.equal(result.candidateFiles!.get('src/unprojected/duplicate.txt'), 'frozen unprojected 63\n')
  assert.equal(result.candidateFiles!.has('src/unprojected/binary.dat'), false)
  assert.equal(result.candidateFiles!.has('src/unprojected/link'), false)
  assert.equal(requests[0].worktree!.tree, candidate.tree)
  const frozen = freezeGenerationInput(source)
  const restored = restoreGenerationInput(JSON.parse(JSON.stringify(frozen.inputEvidence)))
  assert.deepEqual(generationReviewRequest(restored, candidate).request, requests[0])
  assert.equal(requests[0].inputDigest, frozen.inputDigest)
  const perBlobReads = gitCalls.filter(args => args[args.indexOf('cat-file') + 1] === 'blob').length
  t.diagnostic(JSON.stringify({ files: source.manifest.entries.length, perBlobReads, inlineProjections }))
  assert.deepEqual({ perBlobReads, inlineProjections }, { perBlobReads: 0, inlineProjections: 0 })
})

test('原生严格响应schema显式类型和required属性完整，不能仅以本地Ajv接受自证', () => {
  const check = (schema: Record<string, unknown>): void => {
    if (schema.const !== undefined || schema.enum) assert.ok(schema.type, '常量/枚举必须声明类型')
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false)
      const properties = schema.properties as Record<string, Record<string, unknown>>
      assert.deepEqual(new Set(schema.required as string[]), new Set(Object.keys(properties)))
      Object.values(properties).forEach(check)
    }
    if (schema.items) check(schema.items as Record<string, unknown>)
    if (schema.anyOf) (schema.anyOf as Record<string, unknown>[]).forEach(check)
    assert.equal(schema.uniqueItems, undefined, '跨元素唯一性由本地业务门禁核验')
  }
  check(CANDIDATE_RESPONSE_SCHEMA); check(GENERATION_REVIEW_SCHEMA)
})

for (const timeoutMs of [30000, null]) test(`生成和独审原样携带timeout=${timeoutMs}并复用唯一文件schema/CAS/scope`, async t => {
  const source = await input(t); source.timeoutMs = timeoutMs; const native = runner(source); const events: string[] = []
  const index = readFileSync(join(source.root, '.git/index'))
  const head = execFileSync('git', ['-C', source.root, 'rev-parse', 'HEAD']).toString()
  const result = await runGeneration(source, { runner: native.run, onDispatch: async request => { events.push(`planned:${request.purpose}`) }, validateCandidate: async candidate => { events.push('hard-gate'); assert.equal(candidate.sourceInputId, source.snapshot.id); return [{ severity: 'warning', code: 'diagnostic', nodeId: 'export-contract', path: contractPath, message: '非阻断诊断' }] } })
  assert.equal(result.status, 'reviewed'); assert.equal(result.reviewPassed, true); assert.equal(result.candidateValidated, true)
  assert.equal(result.runtimeVerification, 'not_run'); assert.equal(result.delivery, 'not_applied')
  assert.deepEqual(native.calls[0].schema, CANDIDATE_RESPONSE_SCHEMA)
  const properties = native.calls[1].schema.properties as Record<string, { enum?: string[]; items?: { enum: string[] }; minItems?: number }>
  assert.deepEqual(properties.inputId.enum, [source.snapshot.id])
  assert.deepEqual(properties.candidateDigest.enum, [result.candidate!.digest])
  assert.deepEqual(new Set(properties.checkedIds.items!.enum), new Set(source.contracts.flatMap(contract => contract.items.map(item => item.id))))
  assert.equal(properties.checkedIds.minItems, source.readyIds.length)
  assert.equal(JSON.stringify(GENERATION_REVIEW_SCHEMA).includes(source.snapshot.id), false, '请求专属约束不能污染共享schema')
  assert.deepEqual(events, ['planned:code_generate', 'hard-gate', 'planned:code_review'])
  assert.deepEqual(native.calls.map(call => call.requestKey), ['operation-1:attempt-1:code_generate', 'operation-1:attempt-1:code_review'])
  assert.ok(native.calls.every(call => call.timeoutMs === timeoutMs))
  assert.notEqual(result.traces[0].sessionId, result.traces[1].sessionId); assert.notEqual(result.traces[0].threadId, result.traces[1].threadId)
  assert.ok(native.calls[1].prompt.includes('actual candidate implementation'))
  assert.ok(native.calls[1].prompt.includes(JSON.stringify(source.files.get('tests/export.test.mjs')!)))
  assert.ok(native.calls[1].prompt.includes(JSON.stringify(source.files.get(contractPath)!)))
  for (const marker of ['冻结原意和基线完整输入:\n', '实际候选身份与 manifest:\n']) {
    const view = JSON.parse(native.calls[1].prompt.split(marker)[1].split('\n')[0]) as { manifest: { entries: unknown[] }; manifestProjection: unknown }
    assert.deepEqual(view.manifestProjection, { scope: 'local-read-set', includedEntryCount: view.manifest.entries.length, completeEntryCount: source.manifest.entries.length, complete: true })
  }
  assert.ok(result.candidateFiles!.get('tests/export.test.mjs')!.includes('assert.'))
  assert.equal(result.candidate!.baseTree, source.snapshot.immutableTree)
  assert.deepEqual(readFileSync(join(source.root, '.git/index')), index)
  assert.equal(execFileSync('git', ['-C', source.root, 'rev-parse', 'HEAD']).toString(), head)
  assert.equal(readFileSync(join(source.root, 'src/export.js'), 'utf8'), source.files.get('src/export.js'))
})

test('注入 runner 也不能绕过生成 schema、CAS 或越界，失败不进入硬门禁/评审', async t => {
  const source = await input(t)
  for (const variant of ['schema', 'cas', 'scope', 'mode']) {
    const native = runner(source, () => {
      const output = changes(source) as { changes: { path: string; beforeDigest: string | null; beforeMode: string | null; mode?: string | null }[] }
      if (variant === 'schema') return { summary: '全部已通过' }
      if (variant === 'cas') output.changes[0].beforeDigest = '0'.repeat(64)
      if (variant === 'scope') { output.changes[0].path = 'outside.js'; output.changes[0].beforeDigest = null; output.changes[0].beforeMode = null }
      if (variant === 'mode') delete output.changes[0].mode
      return output
    })
    const result = await runGeneration(source, { runner: native.run, validateCandidate: async () => assert.fail('无效候选不能进硬门禁') })
    assert.equal(result.status, 'repair'); assert.equal(result.failure!.code, 'candidate_invalid'); assert.equal(native.calls.length, 1)
    assert.equal(result.candidate, null); assert.equal(result.reviewPassed, false)
    if (variant === 'scope') assert.match(result.failure!.message, /越界/)
  }
})

test('必需硬门禁 error/抛错/缺失均拒绝评审，warning不阻断', async t => {
  const source = await input(t)
  const native = runner(source)
  const result = await runGeneration(source, { runner: native.run, validateCandidate: async () => [{ severity: 'error', code: 'protected_ac', nodeId: 'export-contract', path: contractPath, message: '既有AC不能弱化' }] })
  assert.equal(result.status, 'repair'); assert.equal(native.calls.length, 1); assert.equal(result.candidateValidated, false)
  const broken = runner(source)
  const failure = await runGeneration(source, { runner: broken.run, validateCandidate: async () => { throw new Error('可信保护验证失败') } })
  assert.equal(failure.status, 'failed'); assert.equal(failure.failure!.code, 'candidate_validation_failed'); assert.equal(broken.calls.length, 1)
  const absent = await runGeneration(source, { runner: native.run } as unknown as Parameters<typeof runGeneration>[1])
  assert.equal(absent.status, 'failed'); assert.equal(native.calls.length, 1)
})

test('评审错inputId/digest、覆盖不全/不存在/重复ID、accept带发现或复用会话都拒绝', async t => {
  const source = await input(t)
  for (const variant of ['input', 'digest', 'missing', 'unknown', 'duplicate', 'findings', 'session', 'thread']) {
    const native = runner(source, undefined, request => {
      const output = review(request)
      if (variant === 'input') output.inputId = 'wrong-input'
      if (variant === 'digest') output.candidateDigest = 'wrong-candidate'
      if (variant === 'missing') output.checkedIds.pop()
      if (variant === 'unknown') output.checkedIds.push('REQ-UNKNOWN-01')
      if (variant === 'duplicate') output.checkedIds.push(output.checkedIds[0])
      if (variant === 'findings') output.findings.push({ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#download', evidence: '权限检查遗漏', counterexample: '无权限调用可下载', message: '修复显式权限' })
      return output
    })
    const result = await runGeneration(source, { runner: async request => { const value = await native.run(request); return variant === 'session' ? { ...value, sessionId: 'same' } : variant === 'thread' ? { ...value, threadId: 'same' } : value }, validateCandidate: valid })
    assert.equal(result.status, 'failed', variant); assert.equal(result.reviewPassed, false); assert.equal(native.calls.length, 2)
  }
})

test('修复/未知事实/冲突保留位置、反例与真实分类，仅一次生成一次review', async t => {
  const source = await input(t)
  for (const [verdict, kind, expected] of [['repair', 'repair', 'repair'], ['needs_input', 'missing_fact', 'needs_input'], ['conflict', 'conflict', 'conflict']] as const) {
    const native = runner(source, undefined, request => ({ ...review(request), verdict, findings: [{ kind, affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#download', evidence: '显式验收与代码的具体差异', counterexample: '无权限下载场景', message: '保留待处理发现' }] }))
    const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
    assert.equal(result.status, expected); assert.equal(native.calls.length, 2); assert.equal(result.review!.findings[0].counterexample, '无权限下载场景'); assert.equal(result.reviewPassed, false)
  }
})

test('manifest/files与实际snapshot或composed tree绑定，磁盘变化和输入数组/policy后改不混入', async t => {
  const source = await input(t)
  const entry = source.manifest.entries.find(entry => entry.path === 'src/export.js')!
  const bytes = Buffer.from(`${source.files.get(entry.path)}\n// composed-only\n`)
  const entries = source.manifest.entries.map(item => item === entry ? { ...item, digest: contentHash(bytes), oid: writeObject(source.snapshot.source.commonDir, bytes) } : item)
  const tree = writeTree(source.snapshot.source.commonDir, entries)
  const composed = { sourceInputId: source.snapshot.id, previousBaselinePairId: null, tree, contentDigest: contentHash(JSON.stringify(entries)), manifestBlob: writeEvidence(source.snapshot.source.commonDir, { version: 1, entries }) }
  const desiredSpec = `${source.files.get(contractPath)}\n细化目标：交付正确实现和真实测试断言。\n`
  const composedInput = { ...source, elaboratedSpecs: [{ path: contractPath, source: desiredSpec }], readyIds: [...source.readyIds], policy: { ...source.policy }, composed, manifest: { version: 1 as const, entries }, files: new Map(source.files).set(entry.path, bytes.toString()) }
  const native = runner(composedInput)
  const original = structuredClone({ policy: composedInput.policy, readyIds: composedInput.readyIds })
  const result = await runGeneration(composedInput, { runner: async request => {
    if (request.purpose === 'code_generate') {
      const output = changes(composedInput) as CandidateChanges
      const specEntry = entries.find(item => item.path === contractPath)!
      output.changes.push({ path: contractPath, beforeDigest: specEntry.digest, beforeMode: specEntry.mode, mode: null, content: desiredSpec })
      ;(composedInput.readyIds as string[]).push('REQ-MUTATED-01'); composedInput.policy.digest = 'mutated-policy'; composedInput.files.set('tests/export.test.mjs', 'erased assertions')
      writeFileSync(join(source.root, 'src/export.js'), 'live disk unrelated change')
      const generated = { sessionId: 'generation', threadId: 'generation-thread', turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
      native.calls.push(request)
      return generated
    }
    assert.ok(request.prompt.includes('composed-only'))
    assert.ok(request.prompt.includes(JSON.stringify(desiredSpec)))
    assert.ok(request.prompt.includes(original.policy.digest)); assert.ok(!request.prompt.includes('mutated-policy')); assert.ok(!request.prompt.includes('erased assertions')); assert.ok(!request.prompt.includes('REQ-MUTATED-01'))
    return native.run(request)
  }, validateCandidate: valid })
  assert.equal(result.status, 'reviewed'); assert.equal(result.candidate!.baseTree, tree)
  assert.equal(result.candidateFiles!.get(contractPath), desiredSpec)
  assert.equal(readObject(source.snapshot.source.commonDir, entries.find(entry => entry.path === contractPath)!.oid).toString(), source.files.get(contractPath))
  const bad = runner(source)
  const mismatched = await runGeneration({ ...source, files: new Map(source.files).set(entry.path, 'caller disk bytes') }, { runner: bad.run, validateCandidate: valid })
  assert.equal(mismatched.failure!.code, 'input_invalid'); assert.equal(bad.calls.length, 0)
  const wrongManifest = await runGeneration({ ...source, manifest: { version: 1, entries: [] } }, { runner: bad.run, validateCandidate: valid })
  assert.equal(wrongManifest.status, 'failed'); assert.equal(bad.calls.length, 0)
})

test('已审详细Spec由程序加入实际候选，生成器只需返回实现差量', async t => {
  const source = await input(t)
  const desiredSpec = `${source.files.get(contractPath)}\n已审补充：保留既有权限与全部验收。\n`
  const supplied = { ...source, elaboratedSpecs: [{ path: contractPath, source: desiredSpec }] }
  const native = runner(supplied)
  const result = await runGeneration(supplied, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed')
  assert.equal(result.candidateFiles!.get(contractPath), desiredSpec)
  assert.equal((result.output as CandidateChanges).changes.some(change => change.path === contractPath), false)
  assert.equal(result.traces[0].resultDigest, contentHash(JSON.stringify(result.output)))
  assert.ok(native.calls[1].prompt.includes(JSON.stringify(desiredSpec)))
  assert.equal(readFileSync(join(source.root, contractPath), 'utf8'), source.files.get(contractPath))

  const denied = runner(supplied)
  const outside = await runGeneration({ ...supplied, allowedScope: { ...source.allowedScope, paths: ['src'] } }, { runner: denied.run, validateCandidate: valid })
  assert.equal(outside.status, 'repair'); assert.match(outside.failure!.message, /越界/); assert.equal(denied.calls.length, 1)

  const explicit = runner(supplied, () => {
    const output = changes(supplied) as CandidateChanges
    const entry = source.manifest.entries.find(entry => entry.path === contractPath)!
    output.changes.push({ path: contractPath, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content: 'unauthorized raw replacement' })
    return output
  })
  const rejected = await runGeneration(supplied, { runner: explicit.run, validateCandidate: async candidate => {
    const entry = verifyCandidate(source.snapshot.source.commonDir, candidate).find(entry => entry.path === contractPath)!
    assert.equal(readObject(source.snapshot.source.commonDir, entry.oid).toString('utf8'), 'unauthorized raw replacement')
    return [{ code: 'raw_changed', severity: 'error', message: '不得改写原意', nodeId: 'export-contract', path: contractPath }]
  } })
  assert.equal(rejected.status, 'repair'); assert.equal(explicit.calls.length, 1)
})

test('取消、unsupported和派发持久失败保持明确原因，不额外调用或发布晚结果', async t => {
  const source = await input(t)
  const controller = new AbortController(); controller.abort()
  const native = runner(source)
  assert.equal((await runGeneration({ ...source, signal: controller.signal }, { runner: native.run, validateCandidate: valid })).status, 'cancelled'); assert.equal(native.calls.length, 0)
  const unsupported = await runGeneration(source, { runner: async () => { throw Object.assign(new Error('平台隔离暂不支持'), { code: 'unsupported' }) }, validateCandidate: valid })
  assert.equal(unsupported.status, 'unsupported'); assert.equal(unsupported.failure!.message, '平台隔离暂不支持')
  const saveFailed = await runGeneration(source, { runner: native.run, validateCandidate: valid, onDispatch: async () => { throw new Error('durable dispatch failed') } })
  assert.equal(saveFailed.status, 'failed'); assert.equal(native.calls.length, 0)
  const during = new AbortController()
  const stopped = await runGeneration({ ...source, signal: during.signal }, { runner: async request => { const result = await native.run(request); during.abort(); return result }, validateCandidate: async () => assert.fail('取消后不接受晚候选') })
  assert.equal(stopped.status, 'cancelled'); assert.equal(native.calls.length, 1); assert.ok(stopped.output); assert.equal(stopped.candidate, null)
})


test('允许文件scope冻结且native摘要仍需真实匹配，硬门禁中取消不派发review', async t => {
  const source = await input(t)
  const scoped = { ...source, allowedScope: { ...source.allowedScope, paths: ['src'] } }
  const escaped = await runGeneration(scoped, { runner: async () => {
    scoped.allowedScope.paths.push('outside.js')
    const output = { version: 'sync-files-v1', changes: [{ path: 'outside.js', beforeDigest: null, beforeMode: null, mode: null, content: 'escape' }] }
    return { sessionId: 'generation', threadId: 'generation-thread', turnId: 'turn-1', output, resultDigest: contentHash(JSON.stringify(output)) }
  }, validateCandidate: async () => assert.fail('冻结scope不允许越界') })
  assert.equal(escaped.status, 'repair'); assert.match(escaped.failure!.message, /越界/)
  const native = runner(source)
  const forged = await runGeneration(source, { runner: async request => ({ ...await native.run(request), resultDigest: 'forged' }), validateCandidate: valid })
  assert.equal(forged.status, 'failed'); assert.equal(forged.failure!.code, 'native_result_invalid'); assert.equal(native.calls.length, 1)
  const controller = new AbortController()
  const cancelled = runner(source)
  const stopped = await runGeneration({ ...source, signal: controller.signal }, { runner: cancelled.run, validateCandidate: async () => { controller.abort(); return [] } })
  assert.equal(stopped.status, 'cancelled'); assert.equal(cancelled.calls.length, 1); assert.equal(stopped.reviewOutput, null)
})

test('已冻结宿主凭据不外发，读集合保留真实auth业务源码和全部相关断言', async t => {
  const initial = await input(t), marker = 'DO_NOT_DISCLOSE_FIXTURE_SECRET'
  writeFileSync(join(initial.root, '.env'), `TOKEN=${marker}\n`)
  writeFileSync(join(initial.root, 'unrelated.txt'), 'UNRELATED_CONTEXT_NOT_SENT\n')
  writeFileSync(join(initial.root, 'src/auth.js'), 'export const authorize = actor => actor === "owner";\n')
  execFileSync('git', ['-C', initial.root, 'add', '-f', '.env', 'unrelated.txt', 'src/auth.js'], { stdio: 'pipe' })
  const snapshot = await captureInputSnapshot(initial.root), entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const source = { ...initial, snapshot, manifest: { version: 1 as const, entries }, files: new Map(initial.files).set('src/auth.js', readFileSync(join(initial.root, 'src/auth.js'), 'utf8')) }
  const native = runner(source), result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed')
  for (const call of native.calls) {
    assert.ok(!call.prompt.includes(marker)); assert.ok(!call.prompt.includes('UNRELATED_CONTEXT_NOT_SENT'))
    assert.ok(call.prompt.includes('export const authorize')); assert.ok(call.prompt.includes(JSON.stringify(source.files.get('tests/export.test.mjs')!)))
  }
  assert.ok(readTree(snapshot.source.commonDir, result.candidate!.tree).some(entry => entry.path === '.env'))
  assert.equal(result.candidateFiles!.has('.env'), false)
  const leaked = runner(source), rejected = await runGeneration({ ...source, files: new Map(source.files).set('.env', `TOKEN=${marker}\n`) }, { runner: leaked.run, validateCandidate: valid })
  assert.equal(rejected.status, 'failed'); assert.equal(leaked.calls.length, 0)
})

test('不能省略契约测试断言，不能改没读取的既有文件', async t => {
  const source = await input(t), files = new Map(source.files); files.delete('tests/export.test.mjs')
  const native = runner(source), incomplete = await runGeneration({ ...source, files }, { runner: native.run, validateCandidate: valid })
  assert.equal(incomplete.status, 'failed'); assert.match(incomplete.failure!.message, /缺少契约引用/); assert.equal(native.calls.length, 0)
  writeFileSync(join(source.root, 'unread.txt'), 'unchanged context\n')
  const snapshot = await captureInputSnapshot(source.root), entries = readTree(snapshot.source.commonDir, snapshot.immutableTree), entry = entries.find(entry => entry.path === 'unread.txt')!
  const updated = { ...source, snapshot, manifest: { version: 1 as const, entries }, allowedScope: { ...source.allowedScope, paths: [...source.allowedScope.paths, 'unread.txt'] } }
  const blind = runner(updated, () => ({ version: 'sync-files-v1', changes: [{ path: entry.path, beforeDigest: entry.digest, beforeMode: entry.mode, mode: null, content: 'blind overwrite\n' }] }))
  const rejected = await runGeneration(updated, { runner: blind.run, validateCandidate: async () => assert.fail('盲改不能进入硬门禁') })
  assert.equal(rejected.status, 'repair'); assert.match(rejected.failure!.message, /未完整读取/); assert.equal(blind.calls.length, 1)
})


test('mandatory oracle全文及冻结定义进入同一输入，调用者后改登记不混入独审', async t => {
  const source = await input(t)
  source.mandatoryTests = [{ verificationId: source.verifications[0].id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }]
  const original = structuredClone({ mandatoryTests: source.mandatoryTests, verifications: source.verifications })
  const native = runner(source, request => {
    const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as GenerationInput
    assert.deepEqual(context.mandatoryTests, original.mandatoryTests); assert.deepEqual(context.verifications, original.verifications)
    source.mandatoryTests[0].testId = 'MUTATED-ORACLE'
    source.verifications[0].command.push('--skip')
    return changes(source)
  }, request => {
    const context = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as GenerationInput
    assert.deepEqual(context.mandatoryTests, original.mandatoryTests); assert.deepEqual(context.verifications, original.verifications)
    assert.ok(request.prompt.includes(JSON.stringify(source.files.get('tests/export.test.mjs')!)))
    return review(request)
  })
  const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed'); assert.equal(native.calls[0].inputDigest, native.calls[1].inputDigest)
})

test('未绑定当前裁决的reserved oracle finding不能仅靠needs_input逃过review gate', async t => {
  const source = await input(t)
  source.mandatoryTests = [{ verificationId: source.verifications[0].id, testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }]
  const native = runner(source, undefined, request => ({ ...review(request), verdict: 'needs_input', findings: [{ kind: 'missing_fact', affectedIds: ['AC-EXPORT-03'], ruleLocation: 'oracle-policy:decision:unbound', codeLocation: 'tests/export.test.mjs#AC-EXPORT-03', evidence: '没有真实当前adopt/new_rule授权的声明', counterexample: '任意测试失败不能当作政策互斥', message: '不能授予未知事实分类' }] }))
  const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.failure?.code, 'review_invalid'); assert.equal(result.reviewPassed, false); assert.equal(result.review, null)
})


test('contract-omission必须精确绑定已审Spec路径和关联existingID，普通contract引用仍是代码repair', async t => {
  const source = await input(t)
  for (const marker of [`contract-omission:${contractPath}#RULE-EXPORT-05`, 'contract-omission:.spec/foreign/spec.md#AC-EXPORT-03', `contract-omission:${contractPath}#MISSING-ID`, `contract:${contractPath}#AC-EXPORT-03`]) {
    const native = runner(source, undefined, request => ({ ...review(request), verdict: 'repair', findings: [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: marker, codeLocation: 'tests/export.test.mjs#assertCall', evidence: '已有明确验收的测试helper错误', counterexample: 'TypeError不是新业务边界', message: '修代码和断言' }] }))
    const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
    if (marker.startsWith('contract-omission:')) { assert.equal(result.failure?.code, 'review_invalid', marker); assert.equal(result.review, null) }
    else { assert.equal(result.status, 'repair'); assert.equal(result.review!.findings[0].ruleLocation, marker) }
    assert.equal(result.reviewPassed, false); assert.equal(native.calls.length, 2)
  }
})

test('可信freeze回调发生在生成返回后，实际候选继承闭包外字节且原模型输入/readonly保持原绑定', async t => {
  const initial = await input(t), source = { ...initial, files: new Map(initial.files) }
  source.files.delete('package.json')
  const native = runner(source), originalManifest = structuredClone(source.manifest)
  source.allowedScope.paths = ['src/export.js']
  const inherited = Buffer.from('settled independent delivery\n'), entries = [...source.manifest.entries, { path: 'unselected.txt', mode: '100644' as const, oid: writeObject(source.snapshot.source.commonDir, inherited), digest: contentHash(inherited) }]
  const tree = writeTree(source.snapshot.source.commonDir, entries), actual = readTree(source.snapshot.source.commonDir, tree)
  let bound = false
  const result = await runGeneration(source, { runner: native.run, protectedReadPaths: [...source.files.keys(), 'absent-readonly.txt'], beforeFreezeCandidate: async () => {
    assert.equal(native.calls.length, 1); assert.equal(native.calls[0].purpose, 'code_generate'); bound = true
    return { sourceInputId: source.snapshot.id, previousBaselinePairId: null, tree, manifestBlob: writeEvidence(source.snapshot.source.commonDir, { version: 1, entries: actual }), contentDigest: contentHash(JSON.stringify(actual)) }
  }, validateCandidate: async candidate => { assert.equal(bound, true); assert.equal(candidate.baseTree, tree); return [] } })
  assert.equal(result.status, 'reviewed'); assert.equal(result.candidateFiles?.get('unselected.txt'), inherited.toString())
  assert.deepEqual(source.manifest, originalManifest)
  assert.ok(!native.calls[0].prompt.includes(inherited.toString().trim()))
  assert.ok(native.calls[1].prompt.includes(result.candidate!.digest))
  assert.equal(result.candidateFiles?.get('tests/export.test.mjs'), source.files.get('tests/export.test.mjs'))
  const projected = runner(source, () => assert.fail('已冻结候选仅独审，不重新生成'), request => ({ ...review(request), verdict: 'repair', findings: [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `contract:${contractPath}#AC-EXPORT-03`, codeLocation: 'unselected.txt', evidence: '分派义务所需的具体实现证据未提供', counterexample: '当前投影不足以判断该义务', message: '需要该义务的具体证据，不推断完整候选缺文件' }] }))
  const checked = await runGeneration(source, { runner: projected.run, reviewCandidate: result.candidate!, validateCandidate: valid })
  assert.equal(checked.status, 'repair'); assert.equal(projected.calls.length, 1)
  assert.equal(checked.review!.findings[0].codeLocation, 'unselected.txt', '具体证据不足仍可要求repair')
  const prompt = projected.calls[0].prompt
  assert.ok(prompt.includes('本地审查投影'))
  assert.ok(!prompt.includes('实际完整候选'))
  assert.ok(prompt.includes('不能仅据本投影未提供文件就宣称完整候选缺文件'))
  assert.ok(prompt.includes('具体义务确需未提供证据时仍返回repair'))
  type ManifestView = { manifest: { entries: { path: string }[] }; manifestProjection: { scope: string; includedEntryCount: number; completeEntryCount: number; complete: boolean }; completeManifestDigest: string }
  const identity = JSON.parse(prompt.split('实际候选身份与 manifest:\n')[1].split('\n')[0]) as ManifestView
  const baseline = JSON.parse(prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as ManifestView
  assert.deepEqual(baseline.manifestProjection, { scope: 'local-read-set', includedEntryCount: baseline.manifest.entries.length, completeEntryCount: source.manifest.entries.length, complete: false })
  assert.equal(baseline.completeManifestDigest, contentHash(JSON.stringify(source.manifest)))
  assert.equal(baseline.manifest.entries.some(entry => entry.path === 'package.json'), false)
  assert.deepEqual(identity.manifestProjection, { scope: 'local-read-set', includedEntryCount: identity.manifest.entries.length, completeEntryCount: verifyCandidate(source.snapshot.source.commonDir, result.candidate!).length, complete: false })
  assert.equal(identity.manifest.entries.some(entry => entry.path === 'unselected.txt'), false)
  assert.equal(identity.completeManifestDigest, contentHash(JSON.stringify({ version: 1, entries: verifyCandidate(source.snapshot.source.commonDir, result.candidate!) })))
  assert.ok(!prompt.includes(JSON.stringify(inherited.toString())), '不为更正caption扩大本地读取范围')
  assert.ok(!prompt.includes(JSON.stringify(initial.files.get('package.json')!)), '未额外发送源manifest闭包外正文')
})

test('可信publication回调仍不能改变readonly或缺失路径；模型改readonly也硬拒绝', async t => {
  const source = await input(t); source.allowedScope.paths = ['src/export.js']
  for (const path of ['tests/export.test.mjs', 'absent-readonly.txt']) {
    const bytes = Buffer.from('modified readonly\n'), entries = source.manifest.entries.filter(entry => entry.path !== path)
    entries.push({ path, mode: '100644', oid: writeObject(source.snapshot.source.commonDir, bytes), digest: contentHash(bytes) })
    const tree = writeTree(source.snapshot.source.commonDir, entries), actual = readTree(source.snapshot.source.commonDir, tree), native = runner(source)
    const result = await runGeneration(source, { runner: native.run, protectedReadPaths: ['absent-readonly.txt'], beforeFreezeCandidate: async () => ({ sourceInputId: source.snapshot.id, previousBaselinePairId: null, tree, manifestBlob: writeEvidence(source.snapshot.source.commonDir, { version: 1, entries: actual }), contentDigest: contentHash(JSON.stringify(actual)) }), validateCandidate: valid })
    assert.equal(result.status, 'repair'); assert.equal(result.candidate, null); assert.match(result.failure!.message, /读写闭包/); assert.equal(native.calls.length, 1)
  }
  const path = 'tests/export.test.mjs', before = source.manifest.entries.find(entry => entry.path === path)!, native = runner(source, () => ({ version: 'sync-files-v1', changes: [{ path, beforeDigest: before.digest, beforeMode: before.mode, content: 'model changed oracle\n', mode: null }] }))
  const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'repair'); assert.match(result.failure!.message, /越界/); assert.equal(result.candidate, null)
})

test('旧v1请求没有priorContext时冻结JSON与提示保持原样', async t => {
  const source = await input(t)
  const native = runner(source)
  const result = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  const omitted = await runGeneration({ ...source, priorContext: undefined }, { runner: runner(source).run, validateCandidate: valid })
  assert.equal(omitted.inputDigest, result.inputDigest)
  for (const request of native.calls) {
    assert.equal(request.prompt.includes('priorContext'), false)
    assert.equal(request.prompt.includes('独立旧来源角色'), false)
  }
})

test('删除后的旧Spec与已不在current的源码以source_before进入生成和独审', async t => {
  const source = await input(t)
  const beforeSnapshot = source.snapshot
  const spec = source.files.get(contractPath)!
  const code = source.files.get('src/export.js')!
  const testSource = source.files.get('tests/export.test.mjs')!
  const historicalPaths = [contractPath, 'src/export.js', 'tests/export.test.mjs']
  rmSync(join(source.root, contractPath))
  rmSync(join(source.root, 'src/export.js'))
  const git = (...args: string[]): void => { execFileSync('git', ['-C', source.root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) }
  git('add', '-A'); git('commit', '-m', 'remove specification and implementation')
  const snapshot = await captureInputSnapshot(source.root)
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString()]))
  const prior = { role: 'source_before' as const, snapshot: beforeSnapshot, entries: source.manifest.entries.filter(entry => historicalPaths.includes(entry.path)), files: new Map(historicalPaths.map(path => [path, source.files.get(path)!])), objects: [] }
  const deleted: GenerationInput = { ...source, snapshot, manifest: { version: 1, entries }, files, elaboratedSpecs: [], readyIds: ['AC-EXPORT-03'], retiredIds: ['AC-EXPORT-03'], retiredOwners: [{ id: 'AC-EXPORT-03', path: contractPath }], priorContext: [prior], policy: { ...source.policy, version: 'sync-coordinator-v2' } }
  assert.equal(deleted.files.has(contractPath), false)
  assert.equal(deleted.files.has('src/export.js'), false)
  const accept = (request: ElaborationSessionRequest): GenerationReview => {
    const properties = request.schema.properties as { inputId: { enum: string[] }; candidateDigest: { enum: string[] }; checkedIds: { items: { enum: string[] } } }
    return { inputId: properties.inputId.enum[0], candidateDigest: properties.candidateDigest.enum[0], verdict: 'accept', checkedIds: properties.checkedIds.items.enum, findings: [] }
  }
  const native = runner(deleted, () => ({ version: 'sync-files-v1', changes: [] }), accept)
  const result = await runGeneration(deleted, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.equal(native.calls.length, 2)
  for (const request of native.calls) {
    const context = JSON.parse(request.prompt.split(request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; priorContext: { role: string; pairId?: string; files: [string, string][] }[]; readyIds: string[] }
    const bodies = new Map(context.priorContext[0].files)
    assert.equal(context.priorContext.length, 1)
    assert.equal(context.priorContext[0].role, 'source_before')
    assert.equal(context.priorContext[0].pairId, undefined)
    assert.equal(bodies.get(contractPath), spec)
    assert.equal(bodies.get('src/export.js'), code)
    assert.equal(bodies.get('tests/export.test.mjs'), testSource)
    assert.equal(context.files.some(([path]) => path === contractPath || path === 'src/export.js'), false)
    assert.ok(context.readyIds.includes('AC-EXPORT-03'))
    assert.ok(request.prompt.includes('role为source_before时明确不是verifiedDelivery'))
    assert.equal(context.priorContext.some(item => item.role === 'verified_delivery'), false)
  }
  assert.ok(result.review!.checkedIds.includes('AC-EXPORT-03'))
  const mismatched = { ...deleted, priorContext: [{ ...prior, files: new Map([...prior.files].map(([path, body]) => [path, path === 'src/export.js' ? `${body}\n` : body])) }] }
  const rejected = await runGeneration(mismatched, { runner: runner(mismatched).run, validateCandidate: valid })
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.failure!.message, /历史正文与真实旧快照不匹配/)
})

test('旧related glob匹配到历史根层helper正文缺失时在Native前拒绝', async t => {
  const source = await input(t)
  const helperPath = 'src/helpers/format.js'
  const helper = 'export function format(value) { return String(value) }\n// helper tail marker\n'
  const oldSpec = source.files.get(contractPath)!.replace('  - src/export.js#ExportService\n', '  - src/export.js#ExportService\nrelated:\n  - src/helpers/**/*.js\n')
  writeFileSync(join(source.root, contractPath), oldSpec)
  mkdirSync(join(source.root, 'src/helpers'), { recursive: true })
  writeFileSync(join(source.root, helperPath), helper)
  const git = (...args: string[]): void => { execFileSync('git', ['-C', source.root, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) }
  git('add', '-A'); git('commit', '-m', 'record related helper obligation')
  const before = await captureInputSnapshot(source.root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const beforeFiles = new Map(beforeEntries.map(entry => [entry.path, readObject(before.source.commonDir, entry.oid).toString()]))
  git('rm', contractPath, helperPath); git('commit', '-m', 'delete spec and related helper')
  const snapshot = await captureInputSnapshot(source.root, { committed: true })
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString()]))
  const oldContract = parseContract({ nodeId: 'export-contract', path: contractPath, source: oldSpec }).contract!
  const historicalPaths = [contractPath, 'src/export.js', 'tests/export.test.mjs', helperPath]
  const prior: NonNullable<GenerationInput['priorContext']>[number] = {
    role: 'source_before', snapshot: before,
    entries: beforeEntries.filter(entry => historicalPaths.includes(entry.path)),
    files: new Map(historicalPaths.filter(path => path !== helperPath).map(path => [path, beforeFiles.get(path)!])),
    objects: [],
  }
  const deleted: GenerationInput = {
    ...source, snapshot, manifest: { version: 1, entries }, files, contracts: [], elaboratedSpecs: [],
    readyIds: oldContract.items.map(item => item.id), retiredIds: oldContract.items.map(item => item.id),
    retiredOwners: oldContract.items.map(item => ({ id: item.id, path: contractPath })),
    priorContext: [prior], policy: { ...source.policy, version: 'sync-coordinator-v2' },
  }
  const native = runner(deleted)
  const result = await runGeneration(deleted, { runner: native.run, validateCandidate: valid })
  assert.equal(result.status, 'failed')
  assert.equal(native.calls.length, 0, '历史义务缺少正文须在任何Native派发前拒绝')
  assert.ok(result.failure!.message.includes(helperPath))
})

test('native worktree可读取未投影源码，已审Spec可见，真实Git diff导入且summary伪补丁无效', async t => {
  const source = await input(t), originalSource = source.files.get('src/export.js')!, originalHead = source.snapshot.headCommit
  source.nativeWorktree = true; source.model = 'claude:MiniMax-M3.1-Flash'
  source.files = new Map([...source.files].filter(([path]) => path !== 'src/export.js' && path !== contractPath))
  source.elaboratedSpecs = [{ path: contractPath, source: source.elaboratedSpecs[0].source + '\n已审业务说明。\n' }]
  writeFileSync(join(source.root, 'src/export.js'), 'later staged source\n')
  execFileSync('git', ['-C', source.root, 'add', 'src/export.js'])
  writeFileSync(join(source.root, 'src/export.js'), 'later working source\n')
  const calls: ElaborationSessionRequest[] = []
  const run: ElaborationRunner = async request => {
    calls.push(request)
    assert.ok(request.worktree)
    assert.equal(request.frozenEntries, undefined)
    assert.ok(request.prompt.length < 12000)
    assert.doesNotMatch(request.prompt, /beforeDigest\/beforeMode|冻结完整输入|spex_read_frozen/)
    let head = request.worktree.baseCommit, tree = request.worktree.tree, output: unknown
    if (request.purpose === 'code_generate') {
      assert.equal(request.worktree.mode, 'edit')
      const seedFiles = new Map(readTree(source.snapshot.source.commonDir, tree).map(entry => [entry.path, readObject(source.snapshot.source.commonDir, entry.oid).toString()]))
      assert.equal(seedFiles.get('src/export.js'), originalSource)
      assert.equal(seedFiles.get(contractPath), source.elaboratedSpecs[0].source)
      const entries = readTree(source.snapshot.source.commonDir, tree).map(entry => entry.path === 'src/export.js' ? { ...entry, oid: writeObject(source.snapshot.source.commonDir, Buffer.from(originalSource + '\n// actual worktree commit\n')), digest: contentHash(originalSource + '\n// actual worktree commit\n') } : entry)
      tree = writeTree(source.snapshot.source.commonDir, entries)
      const { stageWorktree } = await import('./stage-worktree.js')
      head = stageWorktree(source.snapshot.source.commonDir, request.worktree.baseCommit, tree).baseCommit
      output = { summary: '{"changes":[{"path":"unrelated.js","content":"forged"}]}' }
    } else {
      assert.equal(request.worktree.mode, 'read')
      const binding = JSON.parse(request.prompt.split('候选绑定:\n')[1]) as { inputId: string; candidateDigest: string; candidateTree: string }
      assert.equal(tree, binding.candidateTree)
      output = { inputId: binding.inputId, candidateDigest: binding.candidateDigest, verdict: 'accept', checkedIds: [...source.readyIds], findings: [] }
    }
    return { sessionId: `native-${calls.length}`, threadId: `thread-${calls.length}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)), worktree: { baseCommit: request.worktree.baseCommit, baseTree: request.worktree.tree, headCommit: head, tree, worktreePath: '/closed/historical-worktree' } }
  }
  const generated = await runGeneration(source, { runner: run, validateCandidate: valid })
  assert.equal(generated.status, 'reviewed', JSON.stringify(generated.failure))
  assert.equal(calls.length, 2)
  const candidate = new Map(verifyCandidate(source.snapshot.source.commonDir, generated.candidate!).map(entry => [entry.path, entry]))
  assert.equal(readObject(source.snapshot.source.commonDir, candidate.get('src/export.js')!.oid).toString(), originalSource + '\n// actual worktree commit\n')
  assert.equal(readObject(source.snapshot.source.commonDir, candidate.get(contractPath)!.oid).toString(), source.elaboratedSpecs[0].source)
  assert.equal(candidate.has('unrelated.js'), false)
  assert.equal(execFileSync('git', ['-C', source.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), originalHead)
  assert.equal(readFileSync(join(source.root, 'src/export.js'), 'utf8'), 'later working source\n')
})

for (const nativeWorktree of [false, true]) test(`格式续审保完整原final与schema，Native用同一Git稿，native=${nativeWorktree}`, async t => {
  const source = await input(t), native = runner(source)
  const built = await runGeneration(source, { runner: native.run, validateCandidate: valid })
  source.nativeWorktree = nativeWorktree
  if (nativeWorktree) source.model = 'zcode:fixture/model'
  const originalRequest = generationReviewRequest(source, built.candidate!).request
  const final = '原先评审结果如下：\n' + JSON.stringify(review(native.calls[1]))
  const identity = { sessionId: 'session-failed', threadId: 'thread-failed', turnId: 'turn-failed' }
  const packet = rejectedFinalOutput(final, originalRequest.worktree ? nativeWorktreePrompt(originalRequest.prompt, originalRequest.worktree) : originalRequest.prompt, originalRequest, identity)
  const failed = { ...built, status: 'failed', reviewOutput: null, review: null, reviewPassed: false, inputDigest: originalRequest.inputDigest, failure: { code: 'structured_output_format_invalid', message: 'invalid_json', ...identity, requestKey: originalRequest.requestKey, inputDigest: originalRequest.inputDigest } }
  const { signal: _signal, ...request } = originalRequest
  const repair = { resultRef: writeEvidence(source.snapshot.source.commonDir, failed), nativePlanRef: writeEvidence(source.snapshot.source.commonDir, { request }), checkpointRef: writeEvidence(source.snapshot.source.commonDir, { failure: { code: failed.failure.code, message: failed.failure.message, rejectedOutput: packet } }) }
  const resumed = generationReviewRequest({ ...source, requestKey: source.requestKey + ':next', reviewRepair: repair }, built.candidate!).request
  assert.notEqual(resumed.inputDigest, originalRequest.inputDigest)
  assert.match(resumed.prompt, /未批准.*格式/)
  if (nativeWorktree) {
    assert.equal(resumed.worktree!.mode, 'edit')
    const files = new Map(readTree(source.snapshot.source.commonDir, resumed.worktree!.tree).map(entry => [entry.path, readObject(source.snapshot.source.commonDir, entry.oid).toString('utf8')]))
    assert.ok([...files].some(([path, body]) => path.startsWith('.spex-sync-drafts/') && body === final))
    assert.ok([...files].some(([path, body]) => path.endsWith('.schema.json') && body === JSON.stringify(originalRequest.schema)))
    for (const entry of readTree(source.snapshot.source.commonDir, built.candidate!.tree)) assert.equal(files.get(entry.path), readObject(source.snapshot.source.commonDir, entry.oid).toString('utf8'))
  } else assert.ok(resumed.prompt.includes(final))
  const secondPacket = rejectedFinalOutput('再次格式失败：' + final, resumed.worktree ? nativeWorktreePrompt(resumed.prompt, resumed.worktree) : resumed.prompt, resumed, identity)
  const secondFailure = { ...failed, inputDigest: resumed.inputDigest, failure: { ...failed.failure, requestKey: resumed.requestKey, inputDigest: resumed.inputDigest } }
  const { signal: _nextSignal, ...nextRequest } = resumed
  const nextRepair = { resultRef: writeEvidence(source.snapshot.source.commonDir, secondFailure), nativePlanRef: writeEvidence(source.snapshot.source.commonDir, { request: nextRequest }), checkpointRef: writeEvidence(source.snapshot.source.commonDir, { failure: { code: failed.failure.code, message: failed.failure.message, rejectedOutput: secondPacket } }) }
  const third = generationReviewRequest({ ...source, requestKey: source.requestKey + ':third', reviewRepair: nextRepair }, built.candidate!).request
  if (nativeWorktree) {
    const entries = readTree(source.snapshot.source.commonDir, third.worktree!.tree)
    assert.ok(entries.some(entry => readObject(source.snapshot.source.commonDir, entry.oid).toString('utf8') === secondPacket.text))
    for (const entry of readTree(source.snapshot.source.commonDir, built.candidate!.tree)) assert.deepEqual(entries.find(actual => actual.path === entry.path), entry)
  } else assert.ok(third.prompt.includes(secondPacket.text))
  assert.equal(secondPacket.ref, undefined)
  assert.equal(packet.ref, undefined)
  const foreign = { ...packet, threadId: 'another-owner' }
  assert.throws(() => generationReviewRequest({ ...source, reviewRepair: { ...repair, checkpointRef: writeEvidence(source.snapshot.source.commonDir, { failure: { ...failed.failure, rejectedOutput: foreign } }) } }, built.candidate!), StructuredSessionError)
})


test('已认证原716完整JSON不能带括号通过位置门禁，也不能按affectedIds替代原位置', async t => {
  const original = JSON.parse(readFileSync(new URL('../../test/fixtures/spec-sync/candidate-review-decorated-location.json', import.meta.url), 'utf8')) as GenerationReview
  assert.equal(contentHash(JSON.stringify(original)), '69149f84bf8fc0ad9f5add024ae4d4fa458d9c985fa929c00da04b1dc2146986')
  const source = await input(t)
  source.nativeWorktree = true
  const path = '.spec/root/sync-code-12718cdd3f7cfae8/spec.md', nodeId = path.split('/').at(-2)!
  const contract = { ...source.contracts[0], nodeId, path, items: source.contracts[0].items.slice(0, 1).flatMap(item => original.findings[0].affectedIds.map(id => ({ ...item, id, path, nodeId }))) }
  const binding = { inputId: original.inputId, candidateDigest: original.candidateDigest, requiredIds: original.checkedIds, actualIds: original.checkedIds, priorIds: [] }
  assert.equal(candidateReviewError(original, binding), null, '原Native schema成功及基础schema成功不是位置协议证明')
  assert.ok(reviewError(source, original, binding, [contract], []), '原完整回答必须在路由P1前拒绝')
  assert.equal(candidateReviewLocationError(original, [contract])?.code, 'review_location_format')
  for (const invalid of ['unknown', 'duplicate', 'path', 'id']) {
    const value = structuredClone(original)
    if (invalid === 'unknown') value.findings[0].affectedIds.push('REQ-FOREIGN')
    if (invalid === 'duplicate') value.findings[0].affectedIds.push(value.findings[0].affectedIds[0])
    if (invalid === 'path') value.findings[0].ruleLocation = '.spec/foreign/spec.md#REQ-TODO-STORAGE-SAVE-01'
    if (invalid === 'id') value.findings[0].ruleLocation = `${path}#REQ-FOREIGN`
    assert.equal(candidateReviewLocationError(value, [contract])?.code, 'review_location_binding', invalid)
  }
  const crossOwner = structuredClone(original), peer = { ...contract, nodeId: 'peer', path: '.spec/peer/spec.md', items: [{ ...contract.items[0], id: 'REQ-PEER', nodeId: 'peer', path: '.spec/peer/spec.md' }] }
  crossOwner.findings[0].ruleLocation = `${path}#REQ-TODO-STORAGE-SAVE-01`
  crossOwner.findings[0].affectedIds.push('REQ-PEER')
  assert.equal(candidateReviewLocationError(crossOwner, [contract, peer]), null, '精确path#ID保持原全图唯一affectedIds跨owner语义')
  assert.equal(candidateReviewLocationError(original, [contract], [path]), null, '真实可写P2的Spec发现不取得只读P1早验限制')
  const unicode = structuredClone(crossOwner), unicodeContract = structuredClone(contract)
  unicodeContract.items[0].id = 'REQ-存储'
  unicode.findings[0].ruleLocation = `${path}#REQ-存储`; unicode.findings[0].affectedIds = ['REQ-存储']
  assert.equal(candidateReviewLocationError(unicode, [unicodeContract]), null, '实际候选精确存在的ID优先，不新增ASCII白名单')
  const mixed = structuredClone(crossOwner); mixed.findings[0].kind = 'missing_fact'
  assert.equal(candidateReviewLocationError(mixed, [contract, peer])?.code, 'review_location_binding', '只读P1返修仍须repair finding，混合kind不取得位置权限')
  assert.equal(original.findings[0].ruleLocation.includes('（同一冲突亦见同文件'), true, '程序不能清洗原输出')
})

for (const formatRejected of [false, true]) test(`Native成功但ruleLocation格式无效：保同candidate原JSON到唯一Git稿，真实提交后严格复核，原件=${formatRejected ? 'Native schema拒绝' : 'Native completed'}`, async t => {
  const source = await input(t), built = await runGeneration(source, { runner: runner(source).run, validateCandidate: valid })
  source.nativeWorktree = true
  const fixed: GenerationReview = { inputId: source.snapshot.id, candidateDigest: built.candidate!.digest, verdict: 'repair', checkedIds: [...source.readyIds], findings: [{ kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#download', evidence: '保留原检查证据', counterexample: '无权限不得下载', message: '复核原候选' }] }
  const bad = structuredClone(fixed); bad.findings[0].ruleLocation += '（同一冲突亦见同文件）'
  let originalRequest: ElaborationSessionRequest | undefined
  const native = { sessionId: 'original-review', threadId: 'original-thread', turnId: 'turn', output: bad, resultDigest: contentHash(JSON.stringify(bad)) }
  const failed = await runGeneration(source, { reviewCandidate: built.candidate!, reviewSpecWritePaths: [], validateCandidate: valid, runner: async request => { originalRequest = request; assert.equal(request.purpose, 'code_review'); return native } })
  for (const reviewSpecWritePaths of [undefined, [contractPath]]) {
    const ordinary = await runGeneration(source, { reviewCandidate: built.candidate!, reviewSpecWritePaths, validateCandidate: valid, runner: async () => native })
    assert.equal(ordinary.status, 'repair', '普通可写P2保原评审协议，定位门只约束实际只读P1路由')
    assert.deepEqual(ordinary.review, bad)
  }
  assert.equal(failed.failure?.code, 'review_location_format'); assert.equal(failed.review, null)
  assert.deepEqual(failed.reviewOutput, bad); assert.deepEqual(failed.candidate, built.candidate)
  const originalText = formatRejected ? JSON.stringify({ inputId: source.snapshot.id, candidateDigest: built.candidate!.digest, findings: 'invalid-array' }) : JSON.stringify(bad)
  const identity = { sessionId: native.sessionId, threadId: native.threadId, turnId: native.turnId }
  const packet = rejectedFinalOutput(originalText, nativeWorktreePrompt(originalRequest!.prompt, originalRequest!.worktree!), originalRequest!, identity, 'native_json')
  const material = formatRejected ? { ...failed, reviewOutput: null, failure: { code: 'structured_output_format_invalid', message: 'schema拒绝原JSON', ...identity, requestKey: originalRequest!.requestKey, inputDigest: originalRequest!.inputDigest } } : failed
  const resultRef = writeEvidence(source.snapshot.source.commonDir, material)
  const reviewRepair = { resultRef, nativePlanRef: writeEvidence(source.snapshot.source.commonDir, { request: originalRequest }), checkpointRef: writeEvidence(source.snapshot.source.commonDir, formatRejected ? { status: 'failed', phase: 'removed', failure: { code: material.failure!.code, message: material.failure!.message, rejectedOutput: packet } } : { status: 'completed', phase: 'removed', result: native }) }
  const attempts: ElaborationSessionRequest[] = []
  for (const variant of ['valid', 'reordered', 'no-commit', 'source', 'schema', 'output', 'syntax']) {
    const repaired = await runGeneration({ ...source, requestKey: 'next-attempt', reviewRepair }, { reviewCandidate: built.candidate!, reviewSpecWritePaths: [], validateCandidate: valid, runner: async request => {
      attempts.push(request); assert.equal(request.purpose, 'code_review'); assert.equal(request.worktree!.mode, 'edit')
      const path = /草稿文件=([^；]+)/.exec(request.prompt)![1], seed = request.worktree!, workspace = join(source.root, '..', `review-draft-${resultRef.sha256}-${variant}`)
      t.after(() => rmSync(workspace, { recursive: true, force: true }))
      execFileSync('git', ['-C', source.root, 'worktree', 'add', '--detach', workspace, seed.baseCommit], { stdio: 'pipe' })
      assert.equal(readFileSync(join(workspace, path), 'utf8'), originalText, '原JSON逐字保全，非重答或程序清洗')
      assert.match(readFileSync(join(workspace, path.replace(/\.json$/, '.errors.json')), 'utf8'), formatRejected ? /schema/ : /ruleLocation/)
      assert.ok(readFileSync(join(workspace, path.replace(/\.json$/, '.trace.json')), 'utf8').includes(formatRejected ? packet.sha256 : native.resultDigest))
      writeFileSync(join(workspace, path), variant === 'syntax' ? '{broken-review' : JSON.stringify(variant === 'reordered' ? Object.fromEntries(Object.entries(fixed).reverse()) : fixed))
      if (variant === 'source') writeFileSync(join(workspace, 'src/export.js'), 'unauthorized source')
      if (variant === 'schema') writeFileSync(join(workspace, path.replace(/\.json$/, '.schema.json')), '{}')
      if (variant !== 'no-commit') { execFileSync('git', ['-C', workspace, 'add', '.'], { stdio: 'pipe' }); execFileSync('git', ['-C', workspace, 'commit', '-m', 'repair original review JSON'], { stdio: 'pipe' }) }
      return { sessionId: 'repair-review', threadId: 'repair-thread', turnId: 'turn', output: variant === 'output' ? bad : fixed, resultDigest: contentHash(JSON.stringify(variant === 'output' ? bad : fixed)), worktree: nativeWorktreeResult(workspace, seed) }
    } })
    if (variant === 'valid' || variant === 'reordered') { assert.equal(repaired.status, 'repair', JSON.stringify(repaired.failure)); assert.deepEqual(repaired.review, fixed) }
    else { assert.equal(repaired.review, null, variant); assert.ok(repaired.failure, variant) }
    assert.deepEqual(repaired.candidate, built.candidate)
  }
  assert.equal(attempts.length, 7)
  assert.equal(verifyCandidate(source.snapshot.source.commonDir, built.candidate!).some(entry => entry.path.startsWith('.spex-sync-')), false)
  assert.equal(readEvidence(source.snapshot.source.commonDir, resultRef).toString(), JSON.stringify(material), '旧失败原件不可改签')
})


for (const cold of [false, true]) test(`mixed只读格式稿与可写missing_fact：续修及原请求冷重建保留瞬态写范围 cold=${cold}`, async t => {
  const source = await input(t), writablePath = '.spec/import/import-contract/spec.md'
  mkdirSync(join(source.root, '.spec/import/import-contract'), { recursive: true })
  writeFileSync(join(source.root, writablePath), source.files.get(contractPath)!.replaceAll('EXPORT', 'IMPORT'))
  execFileSync('git', ['-C', source.root, 'add', '.'], { stdio: 'pipe' })
  execFileSync('git', ['-C', source.root, 'commit', '-m', 'add independent writable owner'], { stdio: 'pipe' })
  source.snapshot = await captureInputSnapshot(source.root)
  source.manifest = { version: 1, entries: readTree(source.snapshot.source.commonDir, source.snapshot.immutableTree) }
  source.files = new Map(source.manifest.entries.map(entry => [entry.path, readObject(source.snapshot.source.commonDir, entry.oid).toString('utf8')]))
  source.contracts = [...source.contracts, parseContract({ nodeId: 'import-contract', path: writablePath, source: source.files.get(writablePath)! }).contract!]
  source.elaboratedSpecs = [...source.elaboratedSpecs, { path: writablePath, source: source.files.get(writablePath)! }]
  source.readyIds = [...source.readyIds, 'AC-IMPORT-03']
  const built = await runGeneration(source, { runner: runner(source, () => changes(source), request => ({ ...review(request), checkedIds: [...source.readyIds] })).run, validateCandidate: valid })
  assert.equal(built.status, 'reviewed', JSON.stringify(built.failure))
  source.nativeWorktree = true
  const fixed: GenerationReview = { inputId: source.snapshot.id, candidateDigest: built.candidate!.digest, verdict: 'repair', checkedIds: [...source.readyIds], findings: [
    { kind: 'repair', affectedIds: ['AC-EXPORT-03'], ruleLocation: `${contractPath}#AC-EXPORT-03`, codeLocation: 'src/export.js#download', evidence: '同一候选的只读诊断', counterexample: '无权限不得下载', message: '复核只读owner' },
    { kind: 'missing_fact', affectedIds: ['AC-IMPORT-03'], ruleLocation: `${writablePath}#AC-IMPORT-03`, codeLocation: 'src/export.js#download', evidence: '同一候选的可写诊断', counterexample: '缺少可信输入', message: '保留可写P2原协议' },
  ] }
  const bad = structuredClone(fixed); bad.findings[0].ruleLocation += '（原说明）'
  assert.equal(candidateReviewLocationError(bad, source.contracts, [writablePath])?.code, 'review_location_format')
  assert.equal(candidateReviewLocationError(bad, source.contracts)?.code, 'review_location_binding')
  const native = { sessionId: 'mixed-original', threadId: 'mixed-original-thread', turnId: 'turn', output: bad, resultDigest: contentHash(JSON.stringify(bad)) }
  let originalRequest: ElaborationSessionRequest | undefined
  const failed = await runGeneration(source, { reviewCandidate: built.candidate!, reviewSpecWritePaths: [writablePath], validateCandidate: valid, runner: async request => { originalRequest = request; return native } })
  assert.equal(failed.failure?.code, 'review_location_format')
  const commonDir = source.snapshot.source.commonDir
  const repairInput = { ...source, requestKey: 'mixed-next', reviewRepair: { resultRef: writeEvidence(commonDir, failed), nativePlanRef: writeEvidence(commonDir, { request: originalRequest }), checkpointRef: writeEvidence(commonDir, { status: 'completed', phase: 'removed', result: native }) } }
  const stored = JSON.parse(readEvidence(commonDir, writeEvidence(commonDir, freezeGenerationInput(repairInput).inputEvidence)).toString()) as ReturnType<typeof freezeGenerationInput>['inputEvidence']
  const restored = restoreGenerationInput(stored)
  assert.equal(Object.hasOwn(restored, 'reviewSpecWritePaths'), false, '写范围不进入持久输入或摘要')
  let calls = 0, dispatched: ElaborationSessionRequest | undefined
  const repaired = await runGeneration(cold ? restored : repairInput, { reviewCandidate: built.candidate!, reviewSpecWritePaths: [writablePath], validateCandidate: valid, runner: async request => {
    calls++; dispatched = request
    const path = /草稿文件=([^；]+)/.exec(request.prompt)![1], seed = request.worktree!, workspace = join(source.root, '..', `mixed-review-${cold}-${failed.inputDigest}`)
    t.after(() => rmSync(workspace, { recursive: true, force: true }))
    execFileSync('git', ['-C', source.root, 'worktree', 'add', '--detach', workspace, seed.baseCommit], { stdio: 'pipe' })
    assert.equal(readFileSync(join(workspace, path), 'utf8'), JSON.stringify(bad))
    writeFileSync(join(workspace, path), JSON.stringify(fixed))
    execFileSync('git', ['-C', workspace, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', workspace, 'commit', '-m', 'repair mixed review draft'], { stdio: 'pipe' })
    return { sessionId: 'mixed-repair', threadId: 'mixed-repair-thread', turnId: 'turn', output: fixed, resultDigest: contentHash(JSON.stringify(fixed)), worktree: nativeWorktreeResult(workspace, seed) }
  } })
  assert.equal(repaired.status, 'repair', JSON.stringify(repaired.failure))
  assert.equal(calls, 1)
  assert.deepEqual(repaired.review, fixed, '可写missing_fact保持原语义，只读定位严格修复')
  assert.deepEqual(repaired.candidate, built.candidate)
  assert.deepEqual(generationReviewRequest(restored, built.candidate!, true, [writablePath]).request, dispatched, '原request冷重建与当前派发逐字一致')
  for (const invalid of ['readonly-kind', 'unknown-id']) {
    const rejected = structuredClone(fixed)
    if (invalid === 'readonly-kind') rejected.findings[0].kind = 'missing_fact'
    else rejected.findings[0].affectedIds = ['AC-FOREIGN']
    const result = await runGeneration(source, { reviewCandidate: built.candidate!, reviewSpecWritePaths: [writablePath], validateCandidate: valid, runner: async () => ({ ...native, output: rejected, resultDigest: contentHash(JSON.stringify(rejected)) }) })
    assert.equal(result.failure?.code, 'review_location_binding', invalid)
    assert.equal(result.review, null, invalid)
  }
})
