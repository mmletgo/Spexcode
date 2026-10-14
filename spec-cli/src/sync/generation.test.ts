import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseContract } from '@spexcode/spec-core/contracts'
import type { Acceptance, ContractFinding } from '@spexcode/spec-core/contracts'
import { CANDIDATE_RESPONSE_SCHEMA, verifyCandidate } from './candidate.js'
import type { CandidateChanges } from './candidate.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { GENERATION_REVIEW_SCHEMA, runGeneration } from './generation.js'
import type { GenerationInput, GenerationReview } from './generation-types.js'
import { captureInputSnapshot, contentHash, readObject, readTree, writeEvidence, writeObject, writeTree } from './snapshot.js'

const contractPath = '.spec/export/export-contract/spec.md'
async function input(t: test.TestContext): Promise<GenerationInput> {
  const root = mkdtempSync(join(tmpdir(), 'spex-generation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
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
  const identity = JSON.parse(request.prompt.split('实际候选身份与 manifest:\n')[1].split('\n实际完整候选')[0]) as { inputId: string; candidate: { digest: string } }
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

test('生成复用唯一文件 schema/CAS/scope，评审独立读取完整候选、源码与真实断言，仍不表示运行/交付', async t => {
  const source = await input(t); const native = runner(source); const events: string[] = []
  const index = readFileSync(join(source.root, '.git/index'))
  const head = execFileSync('git', ['-C', source.root, 'rev-parse', 'HEAD']).toString()
  const result = await runGeneration(source, { runner: native.run, onDispatch: async request => { events.push(`planned:${request.purpose}`) }, validateCandidate: async candidate => { events.push('hard-gate'); assert.equal(candidate.sourceInputId, source.snapshot.id); return [{ severity: 'warning', code: 'diagnostic', nodeId: 'export-contract', path: contractPath, message: '非阻断诊断' }] } })
  assert.equal(result.status, 'reviewed'); assert.equal(result.reviewPassed, true); assert.equal(result.candidateValidated, true)
  assert.equal(result.runtimeVerification, 'not_run'); assert.equal(result.delivery, 'not_applied')
  assert.deepEqual(native.calls[0].schema, CANDIDATE_RESPONSE_SCHEMA)
  assert.deepEqual(events, ['planned:code_generate', 'hard-gate', 'planned:code_review'])
  assert.deepEqual(native.calls.map(call => call.requestKey), ['operation-1:attempt-1:code_generate', 'operation-1:attempt-1:code_review'])
  assert.notEqual(result.traces[0].sessionId, result.traces[1].sessionId); assert.notEqual(result.traces[0].threadId, result.traces[1].threadId)
  assert.ok(native.calls[1].prompt.includes('actual candidate implementation'))
  assert.ok(native.calls[1].prompt.includes(JSON.stringify(source.files.get('tests/export.test.mjs')!)))
  assert.ok(native.calls[1].prompt.includes(JSON.stringify(source.files.get(contractPath)!)))
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
