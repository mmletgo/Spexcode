import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { runConformance } from './conformance.js'
import type { ConformanceInput } from './conformance.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { GenerationReview } from './generation-types.js'
import { INTENT_AUTHORIZATION_PATH } from './intent-authorization.js'
import type { IntentAuthorization, IntentAuthorizationCheck, RawIntentChange } from './intent-authorization.js'
import { contentHash } from './snapshot.js'

const specPath = '.spec/product/greeting/spec.md'
const image = 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'
const source = `---
title: 问候
status: active
contract-schema: sync-v1
code:
  - src/greet.mjs
---
## raw source
用户请求时返回 hi。
## expanded spec
状态不适用：纯同步问候，无持久状态与异步副作用。
### REQ
| id | goal | source | constraints | success | depends-on |
|---|---|---|---|---|---|
| REQ-GREET-01 | 返回问候 | user:raw | 无副作用 | 返回 hi | - |
### RULE
| id | scope | constraint | basis | authority | source | depends-on |
|---|---|---|---|---|---|---|
| RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting | derived:REQ-GREET-01 | REQ-GREET-01 |
### FLOW
| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| FLOW-GREET-01 | REQ-GREET-01 | 用户 | 请求 | 无 | STEP-GREET-01 | END | derived:REQ-GREET-01 | REQ-GREET-01 |
### STEP
| id | flow | action | input | output | rules | next | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| STEP-GREET-01 | FLOW-GREET-01 | 问候 | 请求 | hi | RULE-GREET-01 | END | derived:FLOW-GREET-01 | RULE-GREET-01 |
### AC
| id | covers | preconditions | action | assertion | test | command | source | depends-on |
|---|---|---|---|---|---|---|---|---|
| AC-GREET-01 | REQ-GREET-01,RULE-GREET-01,FLOW-GREET-01,STEP-GREET-01 | 无 | 请求 | 返回 hi | tests/greet.test.mjs#CASE-GREET | VERIFY-GREET-01 | derived:RULE-GREET-01 | RULE-GREET-01 |
### VERIFY
| id | command | cwd | timeout-ms |
|---|---|---|---|
| VERIFY-GREET-01 | ["node","--test","tests/greet.test.mjs"] | . | 30000 |
`
const implementation = 'export function greet() { return "hi" }\n'
const assertion = 'import test from "node:test"; import assert from "node:assert/strict"; import {greet} from "../src/greet.mjs"; test("CASE-GREET greeting", () => assert.equal(greet(), "hi"));\n'
const settings = { version: 'sync-settings-v1', sourcePaths: ['src'], testPaths: ['tests'], readPaths: ['src'], facts: [], mandatoryTests: [], budget: { maxAttempts: 2, maxCalls: 4, maxRepairs: 1, timeoutMs: 60000 }, verifications: [{ definition: { id: 'VERIFY-GREET-01', command: ['node', '--test', 'tests/greet.test.mjs'], cwd: '.', timeoutMs: 30000 }, environment: { version: 'ci-fixture-v1', image, platform: 'linux/arm64', memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 65536 } }] }
function git(root: string, args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8' }).trim() }
function put(root: string, path: string, content: string): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
function save(root: string): string { git(root, ['add', '-A']); git(root, ['commit', '-qm', 'fixture']); return git(root, ['rev-parse', 'HEAD']) }
function fixture(): { root: string; base: string; input: (candidate: string) => ConformanceInput } {
  const root = mkdtempSync(join(tmpdir(), 'spex-conformance-repo-'))
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Conformance']); git(root, ['config', 'user.email', 'conformance@example.test'])
  put(root, specPath, source); put(root, 'src/greet.mjs', implementation); put(root, 'tests/greet.test.mjs', assertion); put(root, '.spec/spexcode.json', JSON.stringify({ sync: settings }))
  const base = save(root)
  return { root, base, input: candidate => ({ repository: root, baseCommit: base, candidateCommit: candidate, policyCommit: base }) }
}
function authorization(before: string | null, after: string | null, path = specPath): IntentAuthorization {
  const rawDigest = (source: string | null): string | null => { if (source === null) return null; const { body } = parseFrontmatter(source); return contentHash(parseParts(body)?.rawSource ?? body.trim()) }
  return { path, beforeRawDigest: rawDigest(before), afterRawDigest: rawDigest(after), source: '用户明确修改问候需求的受信记录' }
}
function authorized(repo: ReturnType<typeof fixture>, candidate: string, records = [authorization(source, git(repo.root, ['show', `${candidate}:${specPath}`]))]): ConformanceInput {
  git(repo.root, ['checkout', '--detach', '-q', repo.base])
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: records }))
  const policyCommit = save(repo.root)
  git(repo.root, ['checkout', '--detach', '-q', candidate])
  return { ...repo.input(candidate), policyCommit }
}
type ReviewContext = { inputId: string; candidateDigest: string; identities: { baseCommit: string; candidateCommit: string; policyCommit: string }; scope: { itemIds: string[]; retiredIds: string[] }; readSet: { path: string; before: string | null; candidate: string | null }[]; intentAuthorization: IntentAuthorizationCheck; intentChanges: RawIntentChange[] }
function context(request: ElaborationSessionRequest): ReviewContext { return JSON.parse(request.prompt.split('\n冻结完整输入:\n').at(-1)!) as ReviewContext }
function reviewer(change?: (review: GenerationReview, value: ReviewContext, request: ElaborationSessionRequest) => void): ElaborationRunner {
  return async request => {
    const value = context(request)
    const output: GenerationReview = { inputId: value.inputId, candidateDigest: value.candidateDigest, verdict: 'accept', checkedIds: [...value.scope.itemIds], findings: [] }
    change?.(output, value, request)
    return { sessionId: 'FAKE-REVIEW-SESSION', threadId: 'FAKE-REVIEW-THREAD', turnId: 'FAKE-REVIEW-TURN', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
}
const noDocker = async (): Promise<never> => { throw new Error('fixture: Docker unavailable') }
const evidence = (name: string): Pick<ConformanceInput, 'evidenceDirectory'> => process.env.SPEX_VERIFICATION_EVIDENCE_DIR ? { evidenceDirectory: mkdtempSync(join(process.env.SPEX_VERIFICATION_EVIDENCE_DIR, `${name}-`)) } : {}

test('受信政策未登记精确raw差量时，程序门禁拒绝并保留前后摘要', async () => {
  const repo = fixture()
  put(repo.root, specPath, source.replaceAll('hi', 'hello'))
  put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello'))
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const result = await runConformance({ ...repo.input(save(repo.root)), ...evidence('unauthorized') }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].code, 'intent_unauthorized')
  const { source: _source, ...expected } = authorization(source, source.replaceAll('hi', 'hello'))
  assert.deepEqual(result.intentAuthorization.changes, [{ ...expected, authorization: null }])
  assert.equal(result.review, null)
  assert.equal(result.runs.length, 0)
})

test('受信policy中的错路径/前后摘要不授权，非法文件在独审前失败', async () => {
  for (const variant of ['path', 'before', 'after', 'missing-null', 'binary', 'symlink'] as const) {
    const repo = fixture(), changed = source.replaceAll('hi', 'hello')
    put(repo.root, specPath, changed)
    const candidate = save(repo.root), record = authorization(source, changed)
    if (variant === 'path') record.path = '.spec/product/other/spec.md'
    if (variant === 'before') record.beforeRawDigest = contentHash('不同旧原意')
    if (variant === 'after') record.afterRawDigest = contentHash('不同新原意')
    let input = authorized(repo, candidate, [record])
    if (['missing-null', 'binary', 'symlink'].includes(variant)) {
      git(repo.root, ['checkout', '--detach', '-q', input.policyCommit])
      if (variant === 'missing-null') { const { beforeRawDigest: _before, ...missing } = record; put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [missing] })) }
      if (variant === 'binary') writeFileSync(join(repo.root, INTENT_AUTHORIZATION_PATH), Buffer.from([0xff, 0x00]))
      if (variant === 'symlink') { rmSync(join(repo.root, INTENT_AUTHORIZATION_PATH)); symlinkSync('spexcode.json', join(repo.root, INTENT_AUTHORIZATION_PATH)) }
      input = { ...input, policyCommit: save(repo.root) }
      git(repo.root, ['checkout', '--detach', '-q', candidate])
    }
    const result = await runConformance(input, { testReviewRunner: async () => assert.fail(`${variant}不应派发独审`) })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.diagnostics[0].code, ['missing-null', 'binary', 'symlink'].includes(variant) ? 'invalid_intent_authorizations' : 'intent_unauthorized')
    assert.equal(result.intentAuthorization.changes[0].afterRawDigest, contentHash('用户请求时返回 hello。'))
    assert.equal(result.review, null)
  }
})

test('候选自行登记无法授权；同一候选只有外部选定精确policyCommit后才能进入独审', async () => {
  const repo = fixture(), changed = source.replaceAll('hi', 'hello'), record = authorization(source, changed)
  put(repo.root, specPath, changed)
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [record] }))
  const candidate = save(repo.root), input = authorized(repo, candidate, [record])
  const untrusted = await runConformance(repo.input(candidate), { testReviewRunner: async () => assert.fail('候选记录不能自批') })
  assert.equal(untrusted.diagnostics[0].code, 'intent_unauthorized')
  let reviewed = false
  const trusted = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    reviewed = true
    assert.equal(value.identities.policyCommit, input.policyCommit)
    assert.equal(value.intentAuthorization.artifactDigest, contentHash(JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [record] })))
    assert.equal(value.intentChanges[0].beforeRaw, '用户请求时返回 hi。')
    assert.equal(value.intentChanges[0].afterRaw, '用户请求时返回 hello。')
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '受信授权只确认需求，当前实现仍返回hi', counterexample: '请求仍得到hi', message: '已授权Spec-only仍缺实现' }]
  }) })
  assert.equal(reviewed, true); assert.equal(trusted.diagnostics[0].code, 'review_rejected')
  put(repo.root, specPath, changed.replaceAll('hello', 'forged'))
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [authorization(source, changed.replaceAll('hello', 'forged'))] }))
  const tampered = await runConformance({ ...input, candidateCommit: save(repo.root) }, { testReviewRunner: async () => assert.fail('候选篡改登记不能改变受信政策') })
  assert.equal(tampered.diagnostics[0].code, 'intent_unauthorized')
})

test('原意精确授权不绕过旧稳定ID、退役负向断言、固定命令与保护oracle', async () => {
  for (const variant of ['old-case', 'retirement', 'command', 'oracle'] as const) {
    const repo = fixture(), trusted = structuredClone(settings)
    if (variant === 'oracle') {
      trusted.verifications[0].definition.command.push('checks/greet.test.mjs')
      put(repo.root, specPath, source.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(trusted.verifications[0].definition.command)))
      put(repo.root, 'checks/greet.test.mjs', 'import test from "node:test"; test("ORACLE-GREET fixed", () => {});\n')
      put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: { ...trusted, mandatoryTests: [{ verificationId: 'VERIFY-GREET-01', testPath: 'checks/greet.test.mjs', testId: 'ORACLE-GREET' }] } }))
    }
    const base = variant === 'oracle' ? save(repo.root) : repo.base
    const baseline = git(repo.root, ['show', `${base}:${specPath}`]), changed = baseline.replaceAll('hi', 'hello')
    put(repo.root, specPath, variant === 'old-case' ? changed.replaceAll('CASE-GREET', 'CASE-NEW') : variant === 'retirement' ? changed.replaceAll('AC-GREET-01', 'AC-GREET-02') : variant === 'command' ? changed.replace('["node","--test","tests/greet.test.mjs"]', '["node","--test","tests/empty.test.mjs"]') : changed)
    if (variant === 'old-case') put(repo.root, 'tests/greet.test.mjs', assertion.replaceAll('CASE-GREET', 'CASE-NEW'))
    if (variant === 'oracle') put(repo.root, 'checks/greet.test.mjs', 'import test from "node:test"; test("ORACLE-GREET weak", () => {});\n')
    const candidate = save(repo.root), input = authorized({ ...repo, base }, candidate, [authorization(baseline, changed)])
    const result = await runConformance({ ...input, baseCommit: base }, { testReviewRunner: async () => assert.fail(`${variant}不应派发独审`) })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.diagnostics[0].code, { 'old-case': 'old_test_binding', retirement: 'retirement_negative_missing', command: 'conformance_failed', oracle: 'oracle_changed' }[variant])
    if (variant === 'command') assert.match(result.diagnostics[0].message, /未登记或被更改的验证命令/)
  }
})

test('精确授权后错误实现仍由独立审查拒绝，授权不等于业务验收通过', async () => {
  const repo = fixture(), changed = source.replaceAll('hi', 'hello')
  put(repo.root, specPath, changed)
  put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'wrong'))
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const input = authorized(repo, save(repo.root))
  const result = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    assert.ok(value.intentAuthorization.changes[0].authorization)
    assert.match(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate!, /wrong/)
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '实现返回wrong，授权新需求要求hello', counterexample: '请求得到wrong', message: '实现不满足已授权需求' }]
  }) })
  assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0].code, 'review_rejected'); assert.equal(result.runs.length, 0)
})

test('纯授权policy提交只验证A差量，无关B原意不索取登记或派发B验证', async () => {
  const repo = fixture(), policy = structuredClone(settings)
  policy.readPaths = []
  const other = structuredClone(policy.verifications[0]); other.definition.id = 'VERIFY-BYE-01'; other.definition.command = ['node', '--test', 'tests/bye.test.mjs']; policy.verifications.push(other)
  const byePath = '.spec/product/bye/spec.md'
  put(repo.root, byePath, source.replaceAll('GREET', 'BYE').replaceAll('greeting', 'bye').replaceAll('greet', 'bye').replace('用户请求时返回 hi。', 'B独立需求不在A的授权范围。'))
  put(repo.root, 'src/bye.mjs', implementation.replaceAll('greet', 'bye')); put(repo.root, 'tests/bye.test.mjs', assertion.replaceAll('GREET', 'BYE').replaceAll('greet', 'bye'))
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: policy }))
  const base = save(repo.root), changed = source.replaceAll('hi', 'hello')
  put(repo.root, specPath, changed); put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello')); put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const input = authorized({ ...repo, base }, save(repo.root), [authorization(source, changed)])
  const result = await runConformance({ ...input, baseCommit: base }, { testReviewRunner: reviewer((_review, value) => {
    assert.deepEqual(value.scope.itemIds.filter(id => id.includes('BYE')), [])
    assert.ok(!value.readSet.some(file => file.path === byePath || file.path.includes('/bye.')))
    assert.equal(value.intentChanges.length, 1); assert.equal(value.intentChanges[0].path, specPath)
  }), testVerificationDriver: noDocker })
  assert.equal(result.status, 'unsupported', JSON.stringify(result.diagnostics))
  assert.deepEqual(result.scope.nodeIds, ['greeting'])
  assert.equal(result.runs.length, 1)
  assert.deepEqual(result.runs[0].bindings.map(binding => binding.testId), ['CASE-GREET'])
})

test('节点移动需要旧路径删除与新路径新增两条精确登记，不能从相同raw继承授权', async () => {
  const repo = fixture(), nextPath = '.spec/product/greeting-next/spec.md'
  put(repo.root, nextPath, source.replace('RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting |', 'RULE-GREET-01 | 请求 | 返回 hi | 用户原意 | greeting-next |'))
  rmSync(join(repo.root, specPath))
  const candidate = save(repo.root), records = [authorization(source, null), authorization(null, source, nextPath)]
  const incomplete = await runConformance(authorized(repo, candidate, [records[0]]), { testReviewRunner: async () => assert.fail('移动的新增路径也需要精确授权') })
  assert.equal(incomplete.diagnostics[0].code, 'intent_unauthorized')
  const complete = await runConformance(authorized(repo, candidate, records), { testReviewRunner: reviewer((_review, value) => {
    assert.equal(value.intentChanges.length, 2)
    assert.ok(value.intentAuthorization.changes.every(change => change.authorization))
  }), testVerificationDriver: noDocker })
  assert.equal(complete.status, 'unsupported', JSON.stringify(complete.diagnostics)); assert.equal(complete.runs.length, 1)
})

test('超过2MiB的跨机器候选全文仍进入独审，不以大小绕过或截断旧新断言', async () => {
  const repo = fixture(), large = `${implementation}\n/* BEGIN-CONTEXT ${'x'.repeat(2 * 1024 * 1024)} END-CONTEXT */\n`
  put(repo.root, 'src/greet.mjs', large)
  let checked = false
  const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer((review, value, request) => {
    checked = true
    assert.ok(Buffer.byteLength(request.prompt) > 2 * 1024 * 1024)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.before, implementation)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate, large)
    assert.equal(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate, assertion)
    review.verdict = 'repair'
    review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '完整读集合已交给独立审查；受控接缝明确拒绝', counterexample: '独立审查拒绝不能因上下文过大被跳过', message: '受控拒绝' }]
  }) })
  assert.equal(checked, true)
  assert.equal(result.status, 'failed')
  assert.equal(result.diagnostics[0].code, 'review_rejected')
  assert.equal(result.runs.length, 0)
})

test('AC-CONFORMANCE-01 Spec-only未实现由独审拒绝；完整源码与真实Git身份都进入审查', async () => {
  const repo = fixture(); put(repo.root, specPath, source.replaceAll('hi', 'hello')); const candidate = save(repo.root)
  const input = authorized(repo, candidate)
  const result = await runConformance(input, { testReviewRunner: reviewer((review, value) => {
    assert.equal(value.identities.candidateCommit, candidate); assert.equal(value.identities.policyCommit, input.policyCommit)
    assert.equal(value.intentAuthorization.changes[0].authorization?.source, '用户明确修改问候需求的受信记录')
    assert.equal(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate, assertion)
    assert.equal(value.readSet.find(file => file.path === 'src/greet.mjs')!.candidate, implementation)
    review.verdict = 'repair'; review.findings = [{ kind: 'repair', affectedIds: ['REQ-GREET-01'], ruleLocation: `${specPath}#REQ-GREET-01`, codeLocation: 'src/greet.mjs#greet', evidence: '冻结需求要求hello但实现与完整断言仍为hi', counterexample: '请求返回hi', message: '缺少实现' }]
  }) })
  assert.equal(result.status, 'failed'); assert.equal(result.diagnostics[0].code, 'review_rejected'); assert.equal(result.reviewExecution, 'injected'); assert.equal(result.runs.length, 0)
})

test('AC-CONFORMANCE-02 删除schema/整个node/AC/test或放宽命令仍进入旧治理闭包且失败', async () => {
  for (const variant of ['schema', 'node', 'ac', 'test', 'command'] as const) {
    const repo = fixture()
    if (variant === 'schema') put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', ''))
    if (variant === 'node') rmSync(join(repo.root, specPath))
    if (variant === 'ac') put(repo.root, specPath, source.replace(/^\| AC-GREET-01 .*\n/m, ''))
    if (variant === 'test') rmSync(join(repo.root, 'tests/greet.test.mjs'))
    if (variant === 'command') put(repo.root, specPath, source.replace('"tests/greet.test.mjs"', '"tests/empty.test.mjs"'))
    const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.ok(result.scope.nodeIds.includes('greeting')); assert.ok(result.scope.itemIds.includes('AC-GREET-01')); assert.equal(result.runs.length, 0)
  }
})

test('AC-CONFORMANCE-03 独立clone无本机DB与receipt仍重算；无关修改不强制整个仓库验收', async () => {
  const repo = fixture(); put(repo.root, 'README.md', 'unrelated\n'); const candidate = save(repo.root)
  const clone = mkdtempSync(join(tmpdir(), 'spex-conformance-clone-')); git(clone, ['clone', '--no-local', '-q', repo.root, '.'])
  const before = git(clone, ['status', '--porcelain=v1'])
  const result = await runConformance({ ...repo.input(candidate), repository: clone }, { testReviewRunner: async () => assert.fail('unrelated不派发模型'), testVerificationDriver: async () => assert.fail('unrelated不派发验收') })
  assert.equal(result.status, 'not_applicable'); assert.equal(result.applicable, false); assert.deepEqual(result.unmanagedPaths, ['README.md']); assert.equal(git(clone, ['status', '--porcelain=v1']), before); assert.equal(git(clone, ['rev-parse', 'HEAD']), candidate)
})

test('AC-CONFORMANCE-04 错candidate/readset/policy绑定与缺失语义/Docker不能伪通过', async () => {
  const repo = fixture(); put(repo.root, 'src/greet.mjs', implementation + '// internal refactor\n'); const candidate = save(repo.root)
  for (const corrupt of ['candidateDigest', 'inputId'] as const) {
    const result = await runConformance(repo.input(candidate), { testReviewRunner: reviewer(review => { review[corrupt] = 'forged' }), testVerificationDriver: noDocker })
    assert.equal(result.status, 'failed'); assert.match(result.diagnostics[0].message, /不匹配/)
  }
  const unsupported = await runConformance(repo.input(candidate), { testReviewRunner: async () => { throw Object.assign(new Error('readonly native unavailable'), { code: 'unsupported' }) } })
  assert.equal(unsupported.status, 'unsupported')
  const docker = await runConformance(repo.input(candidate), { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(docker.status, 'unsupported'); assert.equal(docker.verificationExecution, 'injected')
  const policy = structuredClone(settings); policy.verifications[0].definition.command = ['node', '--test', 'tests/empty.test.mjs']
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: policy })); put(repo.root, specPath, source.replace('"tests/greet.test.mjs"', '"tests/empty.test.mjs"'))
  const changed = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer() })
  assert.equal(changed.status, 'unsupported'); assert.equal(changed.diagnostics[0].code, 'unsupported_policy_update')
  assert.equal((await runConformance({ ...repo.input(candidate), candidateCommit: 'HEAD' })).status, 'failed')
})

const docker = process.env.SPEX_DOCKER_VERIFICATION_TEST === '1'
test('AC-CONFORMANCE-05 完整业务变更在独立clone与真实Docker通过；注入审查明确标记', { skip: !docker }, async () => {
  const repo = fixture(); put(repo.root, specPath, source.replaceAll('hi', 'hello')); put(repo.root, 'src/greet.mjs', implementation.replace('hi', 'hello')); put(repo.root, 'tests/greet.test.mjs', assertion.replace('"hi"', '"hello"'))
  const candidate = save(repo.root), input = authorized(repo, candidate), clone = mkdtempSync(join(tmpdir(), 'spex-conformance-docker-clone-')); git(clone, ['clone', '--no-local', '-q', repo.root, '.'])
  git(clone, ['fetch', '-q', repo.root, input.policyCommit])
  const index = readFileSync(join(clone, '.git/index')), head = git(clone, ['rev-parse', 'HEAD'])
  const result = await runConformance({ ...input, repository: clone, ...evidence('authorized-docker') }, { testReviewRunner: reviewer((_review, value) => {
    assert.equal(value.intentChanges[0].beforeRaw, '用户请求时返回 hi。')
    assert.equal(value.intentChanges[0].afterRaw, '用户请求时返回 hello。')
    assert.ok(value.intentAuthorization.changes[0].authorization)
  }) })
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics)); assert.equal(result.reviewExecution, 'injected'); assert.equal(result.verificationExecution, 'docker'); assert.equal(result.runs.length, 1); assert.equal(result.runs[0].result.evidence!.environment.driver, 'docker')
  assert.deepEqual(readFileSync(join(clone, '.git/index')), index); assert.equal(git(clone, ['rev-parse', 'HEAD']), head); assert.equal(git(clone, ['status', '--porcelain=v1']), '')
})

test('AC-CONFORMANCE-06 合法AC退役保留旧负向用例与固定命令；新旧政策命令并集都真实执行', { skip: !docker }, async () => {
  const repo = fixture()
  const newSource = source.replaceAll('返回 hi', '明确拒绝问候').replace('用户请求时返回 hi。', '用户明确撤销问候，所有请求必须拒绝。').replace('| AC-GREET-01 |', '| AC-GREET-01-NEW |').replace('#CASE-GREET', '#CASE-REJECTED')
  put(repo.root, specPath, newSource)
  put(repo.root, 'src/greet.mjs', 'export function greet() { throw new Error("retired") }\n')
  put(repo.root, 'tests/greet.test.mjs', assertion.replace('assert.equal(greet(), "hi")', 'assert.throws(() => greet(), /retired/)') + 'test("CASE-REJECTED negative", () => assert.throws(() => greet(), /retired/));\n')
  const candidate = save(repo.root)
  const result = await runConformance({ ...authorized(repo, candidate), ...evidence('retirement-docker') }, { testReviewRunner: reviewer((_review, value) => { assert.ok(value.scope.retiredIds.includes('AC-GREET-01')); assert.match(value.readSet.find(file => file.path === 'tests/greet.test.mjs')!.candidate!, /assert\.throws/); assert.match(value.readSet.find(file => file.path === specPath)!.before!, /AC-GREET-01/) }) })
  assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics)); assert.deepEqual(result.runs[0].result.evidence!.tests.map(row => row.testId).sort(), ['CASE-GREET', 'CASE-REJECTED'])
  const trusted = structuredClone(settings); trusted.verifications[0].definition.command = ['node', '--test', '--test-concurrency=1', 'tests/greet.test.mjs']
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: trusted })); put(repo.root, specPath, newSource.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(trusted.verifications[0].definition.command)))
  put(repo.root, INTENT_AUTHORIZATION_PATH, JSON.stringify({ version: 'sync-intent-authorizations-v1', authorizations: [authorization(source, newSource)] }))
  const approvedPolicy = save(repo.root)
  const evolved = await runConformance({ ...repo.input(approvedPolicy), policyCommit: approvedPolicy, ...evidence('policy-evolution-docker') }, { testReviewRunner: reviewer() })
  assert.equal(evolved.status, 'passed', JSON.stringify(evolved.diagnostics)); assert.equal(evolved.runs.length, 2); assert.ok(evolved.runs.every(run => run.result.status === 'passed'))
})


test('AC-CONFORMANCE-07 新raw未细化、未治理新源码、畸形契约和缺少旧稳定用例均不能自免检', async () => {
  for (const variant of ['raw', 'ungoverned', 'malformed', 'old-case'] as const) {
    const repo = fixture()
    if (variant === 'raw') put(repo.root, '.spec/product/new-feature/spec.md', '---\ntitle: 新功能\n---\n## raw source\n用户需要新功能\n## expanded spec\n尚未实现\n')
    if (variant === 'ungoverned') put(repo.root, 'src/new.mjs', 'export const unimplemented = true\n')
    if (variant === 'malformed') put(repo.root, specPath, source.replaceAll('REQ-GREET-01', 'BAD-ID'))
    if (variant === 'old-case') { put(repo.root, specPath, source.replaceAll('AC-GREET-01', 'AC-GREET-02').replaceAll('CASE-GREET', 'CASE-NEW')); put(repo.root, 'tests/greet.test.mjs', assertion.replaceAll('CASE-GREET', 'CASE-NEW')) }
    const result = await runConformance(repo.input(save(repo.root)), { testReviewRunner: reviewer() })
    assert.equal(result.status, 'failed', `${variant}: ${JSON.stringify(result.diagnostics)}`)
    assert.equal(result.review, null)
  }
})

test('AC-CONFORMANCE-08 真实CLI在新HOME跨进程复算，保留失败退出码且不依赖原DB', () => {
  const repo = fixture(); put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', '')); const candidate = save(repo.root)
  const freshHome = mkdtempSync(join(tmpdir(), 'spex-conformance-new-home-'))
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli.ts', import.meta.url)), 'sync', 'check', '--repository', repo.root, '--base', repo.base, '--candidate', candidate, '--json'], { cwd: repo.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: freshHome, SPEXCODE_HOME: join(freshHome, 'spex'), CODEX_HOME: join(freshHome, 'codex'), SPEX_SESSION_DATABASE_PATH: join(freshHome, 'spex/sessions.sqlite') } })
  assert.ifError(run.error); assert.equal(run.status, 1, run.stderr + run.stdout)
  const output = JSON.parse(run.stdout) as { status: string; reviewExecution: string; diagnostics: unknown[] }
  assert.equal(output.status, 'failed'); assert.equal(output.reviewExecution, 'native'); assert.ok(output.diagnostics.length)
  put(repo.root, specPath, source); put(repo.root, 'README.md', 'unrelated\n'); const unrelated = save(repo.root)
  const invoke = (tip: string) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../cli.ts', import.meta.url)), 'sync', 'check', '--repository', repo.root, '--base', repo.base, '--candidate', tip], { cwd: repo.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: freshHome, SPEXCODE_HOME: join(freshHome, 'spex'), CODEX_HOME: join(freshHome, 'codex'), SPEX_SESSION_DATABASE_PATH: join(freshHome, 'spex/sessions.sqlite') } })
  const passed = invoke(unrelated)
  assert.equal(passed.status, 0, passed.stderr + passed.stdout); assert.equal((JSON.parse(passed.stdout) as { applicable: boolean }).applicable, false)
  const untrustedPolicy = structuredClone(settings); untrustedPolicy.verifications[0].environment.version = 'candidate-self-policy'
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: untrustedPolicy })); const untrusted = save(repo.root)
  const unsupported = invoke(untrusted)
  assert.equal(unsupported.status, 2, unsupported.stderr + unsupported.stdout); assert.equal((JSON.parse(unsupported.stdout) as { status: string }).status, 'unsupported')
})

test('AC-CONFORMANCE-09 新旧真实VERIFY归属选择oracle，无关模块不强制运行或读取；删除owner不能缩小旧义务', async () => {
  const repo = fixture(), policy = structuredClone(settings)
  policy.readPaths = []
  const firstCommand = ['node', '--test', 'tests/greet.test.mjs', 'checks/greet.test.mjs']
  policy.verifications[0].definition.command = firstCommand
  const other = structuredClone(policy.verifications[0]); other.definition.id = 'VERIFY-BYE-01'; other.definition.command = ['node', '--test', 'tests/bye.test.mjs', 'checks/bye.test.mjs']; policy.verifications.push(other)
  const fullPolicy = { ...policy, mandatoryTests: [{ verificationId: 'VERIFY-GREET-01', testPath: 'checks/greet.test.mjs', testId: 'ORACLE-GREET' }, { verificationId: 'VERIFY-BYE-01', testPath: 'checks/bye.test.mjs', testId: 'ORACLE-BYE' }] }
  const firstSpec = source.replace('["node","--test","tests/greet.test.mjs"]', JSON.stringify(firstCommand))
  put(repo.root, specPath, firstSpec)
  put(repo.root, '.spec/product/bye/spec.md', firstSpec.replaceAll('GREET', 'BYE').replaceAll('greeting', 'bye').replaceAll('greet', 'bye'))
  put(repo.root, 'src/bye.mjs', implementation.replaceAll('greet', 'bye')); put(repo.root, 'tests/bye.test.mjs', assertion.replaceAll('GREET', 'BYE').replaceAll('greet', 'bye'))
  for (const id of ['greet', 'bye']) put(repo.root, `checks/${id}.test.mjs`, `import test from "node:test"; test("ORACLE-${id.toUpperCase()} fixed", () => {});\n`)
  put(repo.root, '.spec/spexcode.json', JSON.stringify({ sync: fullPolicy })); const base = save(repo.root)
  put(repo.root, 'src/greet.mjs', implementation + '// refactor\n'); const candidate = save(repo.root)
  const result = await runConformance({ ...repo.input(candidate), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer((_review, value) => {
    assert.ok(value.scope.itemIds.includes('AC-GREET-01')); assert.ok(!value.scope.itemIds.includes('AC-BYE-01')); assert.ok(!value.readSet.some(file => file.path === 'checks/bye.test.mjs'))
  }), testVerificationDriver: noDocker })
  assert.equal(result.status, 'unsupported', JSON.stringify(result.diagnostics)); assert.equal(result.runs.length, 1)
  assert.deepEqual(result.runs[0].bindings.map(binding => binding.testId).sort(), ['CASE-GREET', 'ORACLE-GREET'])
  rmSync(join(repo.root, specPath)); const deleted = save(repo.root)
  const guarded = await runConformance({ ...repo.input(deleted), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(guarded.status, 'failed'); assert.ok(guarded.scope.itemIds.includes('VERIFY-GREET-01'))
})


test('AC-CONFORMANCE-10 无sync配置或既有非sync-v1范围明确未纳入，绝不空scope passed', async () => {
  const repo = fixture()
  put(repo.root, specPath, source.replace('contract-schema: sync-v1\n', '')); put(repo.root, '.spec/spexcode.json', '{}'); const unconfiguredBase = save(repo.root)
  put(repo.root, 'README.md', 'unrelated\n'); const candidate = save(repo.root)
  const uncovered = await runConformance({ ...repo.input(candidate), baseCommit: unconfiguredBase, policyCommit: unconfiguredBase }, { testReviewRunner: reviewer() })
  assert.equal(uncovered.status, 'unsupported'); assert.equal(uncovered.coverage.mapping, 'unconfigured'); assert.deepEqual(uncovered.coverage.uncoveredNodeIds, ['greeting']); assert.equal(uncovered.diagnostics[0].code, 'unsupported_unconfigured'); assert.equal(uncovered.review, null)
  const configured = fixture(); put(configured.root, '.spec/product/legacy/spec.md', '---\ntitle: 旧需求\n---\n## raw source\n旧需求尚未迁移\n## expanded spec\n尚未纳入\n'); const base = save(configured.root)
  put(configured.root, 'src/greet.mjs', implementation + '// internal\n'); const changed = save(configured.root)
  const partial = await runConformance({ ...configured.input(changed), baseCommit: base, policyCommit: base }, { testReviewRunner: reviewer(), testVerificationDriver: noDocker })
  assert.equal(partial.coverage.mapping, 'partial'); assert.deepEqual(partial.coverage.uncoveredNodeIds, ['legacy']); assert.deepEqual(partial.coverage.governedNodeIds, ['greeting']); assert.equal(partial.verificationExtent, 'affected_scope')
})
