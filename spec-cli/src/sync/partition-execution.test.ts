import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseContract } from '@spexcode/spec-core/contracts'
import type { Acceptance, Contract } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import type { GenerationInput } from './generation-types.js'
import { completeSyncPartitionPlan, elaborateSyncPartitions, generateSyncPartitions, mapSyncPartitions } from './partition-execution.js'
import type { PartitionCheckpoints } from './partition-execution.js'
import type { SyncPartitionPlan } from './partitioning.js'
import { captureInputSnapshot, contentHash, readObject, readTree, writeEvidence } from './snapshot.js'
import { verifyCandidate } from './candidate.js'

async function fixture(t: test.TestContext): Promise<{ input: GenerationInput; plan: SyncPartitionPlan; checkpoints: PartitionCheckpoints; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'spex-partition-execution-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../../test/fixtures/spec-sync/export-repo/', import.meta.url), root, { recursive: true })
  const base = readFileSync(join(root, '.spec/export/export-contract/spec.md'), 'utf8')
  for (const domain of ['import', 'archive']) {
    const path = join(root, `.spec/export/${domain}-contract/spec.md`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, base.replaceAll('export-job', `${domain}-job`).replaceAll('EXPORT', domain.toUpperCase()).replaceAll('export-contract', `${domain}-contract`).replaceAll('src/export.js', `src/${domain}.js`).replaceAll('tests/export.test.mjs', `tests/${domain}.test.mjs`))
    cpSync(join(root, 'src/export.js'), join(root, `src/${domain}.js`))
    writeFileSync(join(root, `tests/${domain}.test.mjs`), readFileSync(join(root, 'tests/export.test.mjs'), 'utf8').replaceAll('EXPORT', domain.toUpperCase()))
  }
  const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }) }
  git('init', '-b', 'main'); git('config', 'user.email', 'partition@example.invalid'); git('config', 'user.name', 'partition fixture'); git('add', '.'); git('commit', '-m', 'fixture')
  const snapshot = await captureInputSnapshot(root), entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  const files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const contracts: Contract[] = ['export', 'import', 'archive'].map(domain => { const path = `.spec/export/${domain}-contract/spec.md`; return parseContract({ nodeId: `${domain}-contract`, path, source: files.get(path)! }).contract! })
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', digest: 'frozen-plan', expectedPaths: contracts.map(contract => contract.code[0].split('#')[0]), dependencies: [{ from: 'part-export', to: 'part-import', contractIds: ['REQ-EXPORT-01', 'REQ-IMPORT-01'], paths: ['src/export.js', 'src/import.js'] }], partitions: contracts.map(contract => {
    const domain = contract.nodeId.split('-')[0], source = `src/${domain}.js`, paths = [contract.path, source, `tests/${domain}.test.mjs`]
    return { id: `part-${domain}`, intentNodeId: 'export-contract', targets: [{ nodeId: contract.nodeId, path: contract.path }], readPaths: [...paths], writePaths: [...paths], sourcePaths: [source], changedPaths: [source], contextNodeIds: [], contractIds: [], flowIds: [], readBytes: 100, readLimitBytes: 524288, oversizedReads: [] }
  }) }
  const readyIds = contracts.flatMap(contract => [`REQ-${contract.nodeId.split('-')[0].toUpperCase()}-01`, `AC-${contract.nodeId.split('-')[0].toUpperCase()}-03`])
  const input: GenerationInput = { root, snapshot, requestKey: 'operation:attempt:generation', manifest: { version: 1, entries }, files, contracts, elaboratedSpecs: contracts.map(contract => ({ path: contract.path, source: files.get(contract.path)! })), readyIds, blockedIds: [], intent: { nodeId: 'export-contract', rawSource: contracts[0].rawSource }, facts: [], existingAcceptance: contracts.flatMap(contract => contract.items.filter((item): item is Acceptance => item.kind === 'AC')), mandatoryTests: [], verifications: [], allowedScope: { paths: plan.partitions.flatMap(partition => partition.writePaths), contractIds: readyIds, flowIds: [] }, policy: { version: 'sync-coordinator-v2', digest: 'policy' }, timeoutMs: 30000, model: 'gpt-6.1-sol', effort: 'high' }
  const values = new Map<string, unknown>()
  const checkpoints: PartitionCheckpoints = { load: <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : null, save: (key, value) => { values.set(key, structuredClone(value)); return writeEvidence(snapshot.source.commonDir, value) } }
  return { input, plan, checkpoints, root }
}

function native(delayReverse = false): { runner: ElaborationRunner; calls: ElaborationSessionRequest[]; peak: () => number } {
  const calls: ElaborationSessionRequest[] = []
  let active = 0, peak = 0
  const runner: ElaborationRunner = async request => {
    const ordinal = calls.push(request)
    active++; peak = Math.max(peak, active)
    const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]?.split('\n实际候选身份')[0] ?? request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; allowedScope: { paths: string[] }; manifest: { entries: { path: string; digest: string; mode: string }[] } }
    await new Promise(resolve => setTimeout(resolve, delayReverse ? (4 - ordinal % 4) * 10 : ordinal % 4 * 10))
    let output: unknown
    if (request.purpose === 'code_generate') {
      const file = context.manifest.entries.find(entry => entry.path.startsWith('src/') && context.allowedScope.paths.some(path => entry.path === path || entry.path.startsWith(`${path}/`)))!
      const source = new Map(context.files).get(file.path)!
      output = { version: 'sync-files-v1', changes: [{ path: file.path, beforeDigest: file.digest, beforeMode: file.mode, content: `${source}\n// partition implementation\n`, mode: null }] }
    } else {
      const properties = request.schema.properties as { inputId: { enum: string[] }; candidateDigest: { enum: string[] }; checkedIds: { items: { enum: string[] } } }
      output = { inputId: properties.inputId.enum[0], candidateDigest: properties.candidateDigest.enum[0], verdict: 'accept', checkedIds: properties.checkedIds.items.enum, findings: [] }
    }
    active--
    return { sessionId: `session-${ordinal}`, threadId: `thread-${ordinal}`, turnId: `turn-${ordinal}`, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  return { runner, calls, peak: () => peak }
}

test('分区生成同时在途，每区只收到本区完整正文；分区和跨边独审绑定唯一最终candidate', async t => {
  const { input, plan, checkpoints } = await fixture(t), runtime = native()
  const result = await generateSyncPartitions(input, plan, 2, false, { runner: runtime.runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.equal(runtime.peak(), 2)
  assert.equal(runtime.calls.filter(call => call.purpose === 'code_generate').length, 3)
  assert.equal(runtime.calls.filter(call => call.purpose === 'code_review').length, 4)
  assert.equal(result.review, null, '不得伪造全仓模型review')
  assert.equal(result.partitionEvidence!.length, 4)
  assert.ok(result.partitionEvidence!.every(item => item.candidateDigest === result.candidate!.digest))
  for (const request of runtime.calls.filter(call => call.purpose === 'code_generate')) {
    const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as { files: [string, string][] }
    assert.equal(context.files.filter(([path]) => path.startsWith('src/')).length, 1)
    assert.ok(context.files.length < input.files.size)
    const testFile = context.files.find(([path]) => path.startsWith('tests/'))!
    assert.equal(testFile[1], input.files.get(testFile[0]), '断言全文不得截断')
  }
  const callsBeforeResume = runtime.calls.length
  const resumed = await generateSyncPartitions(input, plan, 2, false, { runner: runtime.runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(resumed.candidate!.digest, result.candidate!.digest)
  assert.equal(runtime.calls.length, callsBeforeResume, '恢复不得重复完成阶段的真实模型调用')
})

test('异步完成顺序不改变确定序装配的候选树', async t => {
  const first = await fixture(t), a = native(false), b = native(true)
  const resultA = await generateSyncPartitions(first.input, first.plan, 3, false, { runner: a.runner, validateCandidate: async () => [] }, first.checkpoints)
  const other: PartitionCheckpoints = { load: () => null, save: (_key, value) => writeEvidence(first.input.snapshot.source.commonDir, value) }
  const resultB = await generateSyncPartitions(first.input, first.plan, 3, false, { runner: b.runner, validateCandidate: async () => [] }, other)
  assert.equal(resultA.status, 'reviewed'); assert.equal(resultB.status, 'reviewed')
  assert.equal(resultA.candidate!.tree, resultB.candidate!.tree)
  assert.equal(resultA.candidate!.digest, resultB.candidate!.digest)
})

test('code→Spec只装配已审Spec，不调用code_generate，源码和测试对象逐字不变', async t => {
  const { input, plan, checkpoints } = await fixture(t), runtime = native()
  input.elaboratedSpecs = input.elaboratedSpecs.map(spec => ({ ...spec, source: `${spec.source}\n已核代码的业务说明。\n` }))
  const result = await generateSyncPartitions(input, plan, 2, true, { runner: runtime.runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.ok(runtime.calls.every(call => call.purpose === 'code_review'))
  const before = input.manifest.entries.filter(entry => !entry.path.startsWith('.spec/'))
  const after = verifyCandidate(input.snapshot.source.commonDir, result.candidate!).filter(entry => !entry.path.startsWith('.spec/'))
  assert.deepEqual(after, before)
})

test('取消停止小批后续派发，已在途任务先结算；失败亦不再派新工作', async () => {
  const controller = new AbortController(), dispatched: number[] = []
  await assert.rejects(mapSyncPartitions([1, 2, 3, 4], 2, controller.signal, async value => { dispatched.push(value); controller.abort(); return value }), /取消/)
  assert.deepEqual(dispatched, [1])
  await assert.rejects(mapSyncPartitions([1, 2, 3], 1, undefined, async value => { throw new Error(`failed-${value}`) }), /failed-1/)
})


test('分区P1原意根作为其他区只读上下文，独审原件与可写目标各自保留', async t => {
  const { input, plan, checkpoints } = await fixture(t), calls: ElaborationSessionRequest[] = []
  const rootContract = input.contracts[0], rootPaths = plan.partitions[0].readPaths
  plan.dependencies = []
  for (const partition of plan.partitions.slice(1)) partition.readPaths = [...new Set([...partition.readPaths, ...rootPaths])]
  const runner: ElaborationRunner = async request => {
    const index = calls.push(request)
    const context = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string; path: string }[]; files: [string, string][] }
    assert.equal(context.targets.length, 1)
    assert.ok(context.files.length < input.files.size)
    const domain = context.targets[0].nodeId.split('-')[0].toUpperCase()
    const output = request.purpose === 'elaboration_generate' ? { version: 'elaboration-target-rows-v3', changes: [], applicability: ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: true, basis: '固定夹具明确业务边界', affectedIds: [`REQ-${domain}-01`] })) } : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `p1-session-${index}`, threadId: `p1-thread-${index}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const result = await elaborateSyncPartitions({ root: input.root, requestKey: 'p1', intent: input.intent, targets: input.contracts.map(contract => ({ nodeId: contract.nodeId, path: contract.path, source: input.files.get(contract.path)!, sourceDigest: contentHash(input.files.get(contract.path)!) })), files: input.files, facts: input.contracts.map(contract => ({ source: `decision:${contract.nodeId.split('-')[0].toUpperCase()}-POLICY`, text: '固定夹具显式业务政策' })), maxRepairs: 0, maxCalls: 2, historyInput: input.snapshot }, plan, 2, checkpoints, runner)
  assert.equal(result.structurePassed, true, JSON.stringify(result.rounds.flatMap(round => round.findings)))
  assert.equal(result.reviewPassed, true)
  assert.equal(result.partitionEvidence!.length, 3)
  assert.equal(result.changes.filter(change => change.path === rootContract.path).length, 1)
  assert.equal(calls.length, 6)
})

test('P1后的真实新跨区依赖进入冻结覆盖集合，业务ID多writer被拒绝', async t => {
  const { input, plan } = await fixture(t)
  plan.dependencies = []
  const next = structuredClone(input.contracts)
  const item = next[1].items.find(item => item.kind === 'REQ')!
  item.dependsOn.push('RULE-EXPORT-01')
  const completed = completeSyncPartitionPlan(plan, next, input.files, { writePaths: input.allowedScope.paths, readonlyPaths: input.mandatoryTests.map(test => test.testPath) })
  assert.ok(completed.dependencies.some(edge => edge.from === 'part-import' && edge.to === 'part-export' && edge.contractIds.includes('RULE-EXPORT-01')))
  assert.notEqual(completed.digest, plan.digest)
  assert.ok(completed.partitions[1].readPaths.includes(next[0].path))
  const duplicated = { ...plan, partitions: [...plan.partitions, { ...plan.partitions[0], id: 'duplicate-writer' }] }
  assert.throws(() => completeSyncPartitionPlan(duplicated, next, input.files, { writePaths: input.allowedScope.paths, readonlyPaths: input.mandatoryTests.map(test => test.testPath) }), /多个分区writer/)
})

test('未读取/只读root Spec和独立oracle不能因全局scope可写而被分区补丁改写', async t => {
  const first = await fixture(t), runtime = native()
  first.plan.partitions[1].readPaths.push(...first.plan.partitions[0].readPaths)
  first.plan.partitions[1].writePaths.push(first.input.contracts[0].path)
  const runner: ElaborationRunner = async request => {
    const result = await runtime.runner(request)
    if (request.purpose !== 'code_generate' || !request.requestKey.includes('part-import')) return result
    const path = first.input.contracts[0].path, before = first.input.manifest.entries.find(entry => entry.path === path)!
    const output = result.output as { changes: unknown[] }
    output.changes.push({ path, beforeDigest: before.digest, beforeMode: before.mode, content: `${first.input.files.get(path)}\n越界root编辑\n`, mode: null })
    return { ...result, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  await assert.rejects(generateSyncPartitions(first.input, first.plan, 2, false, { runner, validateCandidate: async () => [] }, first.checkpoints), /分区补丁越过读取\/写入范围: \.spec\/export\/export-contract\/spec\.md/)
  assert.ok(runtime.calls.every(call => call.purpose === 'code_generate'))
  const second = await fixture(t), oracleRuntime = native()
  second.input.mandatoryTests = [{ verificationId: 'VERIFY-EXPORT-01', testPath: 'tests/export.test.mjs', testId: 'AC-EXPORT-03' }]
  const oracleRunner: ElaborationRunner = async request => {
    const result = await oracleRuntime.runner(request)
    if (request.purpose !== 'code_generate' || !request.requestKey.includes('part-export')) return result
    const path = 'tests/export.test.mjs', before = second.input.manifest.entries.find(entry => entry.path === path)!
    const output = result.output as { changes: unknown[] }
    output.changes.push({ path, beforeDigest: before.digest, beforeMode: before.mode, content: `${second.input.files.get(path)}\n// oracle rewrite\n`, mode: null })
    return { ...result, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  await assert.rejects(generateSyncPartitions(second.input, second.plan, 2, false, { runner: oracleRunner, validateCandidate: async () => [] }, second.checkpoints), /oracle/)
})

test('分区响应不能以完成顺序覆盖同文件writer，过期beforeDigest在统一CAS拒绝', async t => {
  const first = await fixture(t), runtime = native()
  first.plan.partitions[1].readPaths.push('src/export.js')
  first.plan.partitions[1].writePaths.push('src/export.js')
  const conflict = await generateSyncPartitions(first.input, first.plan, 2, false, { runner: runtime.runner, validateCandidate: async () => [] }, first.checkpoints)
  assert.equal(conflict.status, 'repair')
  assert.equal(conflict.failure?.code, 'implementation_plan_conflict')
  assert.equal(conflict.candidate, null)
  assert.equal(runtime.calls.length, 0)
  const second = await fixture(t), invalid = native()
  const runner: ElaborationRunner = async request => {
    const result = await invalid.runner(request)
    if (request.purpose !== 'code_generate') return result
    const output = result.output as { changes: { beforeDigest: string }[] }
    output.changes[0].beforeDigest = '0'.repeat(64)
    return { ...result, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  await assert.rejects(generateSyncPartitions(second.input, second.plan, 2, false, { runner, validateCandidate: async () => [] }, second.checkpoints))
  assert.ok(invalid.calls.every(call => call.purpose === 'code_generate'))
})

test('多节点新功能先规划互斥精确文件，再只向对应writer授予新增路径', async t => {
  const { input, plan, checkpoints } = await fixture(t), calls: ElaborationSessionRequest[] = []
  for (const contract of input.contracts) contract.code = []
  for (const partition of plan.partitions) partition.writePaths = partition.writePaths.filter(path => !path.startsWith('src/'))
  input.allowedScope.paths = input.allowedScope.paths.filter(path => !path.startsWith('src/'))
  const runner: ElaborationRunner = async request => {
    const ordinal = calls.push(request)
    const domain = /part-(export|import|archive)/.exec(request.requestKey)?.[1]
    let output: unknown
    if (request.purpose === 'implementation_plan') output = { version: 'sync-implementation-plan-v1', paths: [`src/new-${domain}.js`] }
    else if (request.purpose === 'code_generate') {
      const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as { allowedScope: { paths: string[] } }
      assert.ok(context.allowedScope.paths.includes(`src/new-${domain}.js`))
      assert.ok(!context.allowedScope.paths.includes('src'))
      assert.equal(context.allowedScope.paths.filter(path => path.startsWith('src/new-')).length, 1)
      output = { version: 'sync-files-v1', changes: [{ path: `src/new-${domain}.js`, beforeDigest: null, beforeMode: null, mode: '100644', content: `export const value = '${domain}'\n` }] }
    } else {
      const properties = request.schema.properties as { inputId: { enum: string[] }; candidateDigest: { enum: string[] }; checkedIds: { items: { enum: string[] } } }
      output = { inputId: properties.inputId.enum[0], candidateDigest: properties.candidateDigest.enum[0], verdict: 'accept', checkedIds: properties.checkedIds.items.enum, findings: [] }
    }
    return { sessionId: `layout-session-${ordinal}`, threadId: `layout-thread-${ordinal}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  let acquired: readonly string[] = []
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, implementationPolicy: { writePaths: ['src', 'tests', '.spec'], sourcePaths: ['src'] }, beforePartitionGeneration: async paths => { acquired = paths; return { scope: { ...input.allowedScope, paths: [...input.allowedScope.paths, ...paths] } } }, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.deepEqual(acquired, ['src/new-archive.js', 'src/new-export.js', 'src/new-import.js'])
  assert.equal(calls.filter(call => call.purpose === 'implementation_plan').length, 3)
  assert.equal(calls.filter(call => call.purpose === 'code_generate').length, 3)
  const entries = verifyCandidate(input.snapshot.source.commonDir, result.candidate!)
  for (const path of acquired) assert.ok(entries.some(entry => entry.path === path))
})

test('新功能布局冲突进入原有限修复结果，不向任何区复制共享目录或派代码生成', async t => {
  const { input, plan, checkpoints } = await fixture(t), calls: ElaborationSessionRequest[] = []
  for (const contract of input.contracts) contract.code = []
  const runner: ElaborationRunner = async request => {
    const ordinal = calls.push(request), output = { version: 'sync-implementation-plan-v1', paths: ['src/shared.js'] }
    return { sessionId: `conflict-session-${ordinal}`, threadId: `conflict-thread-${ordinal}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, implementationPolicy: { writePaths: ['src', 'tests'], sourcePaths: ['src'] }, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'repair')
  assert.equal(result.failure!.code, 'implementation_plan_conflict')
  assert.ok(calls.every(call => call.purpose === 'implementation_plan'))
  assert.equal(result.candidate, null)
})

test('局部只借读依赖Spec接口，checkedIds不冒充其实现；最终跨边仍完整重读双端源码', async t => {
  const { input, plan, checkpoints } = await fixture(t), runtime = native()
  plan.partitions[1].readPaths.push(input.contracts[0].path)
  let localChecks = 0, edgeChecks = 0
  const runner: ElaborationRunner = async request => {
    if (request.purpose === 'code_review') {
      const context = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; readonlyContractPaths?: string[] }
      const checked = (request.schema.properties as { checkedIds: { items: { enum: string[] } } }).checkedIds.items.enum
      if (request.requestKey.includes('final:part-import')) {
        localChecks++
        assert.ok(context.readonlyContractPaths!.includes(input.contracts[0].path))
        assert.ok(context.files.some(([path]) => path === input.contracts[0].path))
        assert.ok(!context.files.some(([path]) => path === 'src/export.js'))
        assert.ok(checked.every(id => !id.includes('-EXPORT-')))
      }
      if (request.requestKey.includes('final:edge:')) {
        edgeChecks++
        assert.ok(context.files.some(([path]) => path === 'src/export.js'))
        assert.ok(context.files.some(([path]) => path === 'src/import.js'))
        assert.ok(!context.readonlyContractPaths?.includes(input.contracts[0].path))
        assert.ok(!context.readonlyContractPaths?.includes(input.contracts[1].path))
      }
    }
    return runtime.runner(request)
  }
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.equal(localChecks, 1); assert.equal(edgeChecks, 1)
})

test('已退役旧ID仍按真实owner保留局部ready及负向验收输入，不触发新文件规划', async t => {
  const { input, plan, checkpoints } = await fixture(t), runtime = native(), retired = input.contracts[0]
  input.contracts = input.contracts.slice(1)
  input.elaboratedSpecs = input.elaboratedSpecs.filter(spec => spec.path !== retired.path)
  input.retiredIds = input.readyIds.filter(id => id.includes('-EXPORT-'))
  input.retiredOwners = input.retiredIds.map(id => ({ id, path: retired.path }))
  input.nodeChanges = [{ action: 'retire', from: { nodeId: retired.nodeId, path: retired.path }, evidenceRef: writeEvidence(input.snapshot.source.commonDir, { explicit: 'fixture retirement authorization' }) }]
  let generatedRetirement = false
  const runner: ElaborationRunner = async request => {
    if (request.purpose === 'implementation_plan') assert.fail('退役writer不能规划新实现文件')
    if (request.purpose === 'code_generate' && request.requestKey.includes('part-export')) {
      const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as { readyIds: string[]; existingAcceptance: { id: string }[] }
      assert.ok(context.readyIds.includes('AC-EXPORT-03'))
      assert.ok(context.existingAcceptance.some(item => item.id === 'AC-EXPORT-03'))
      const before = input.manifest.entries.find(entry => entry.path === retired.path)!
      const output = { version: 'sync-files-v1', changes: [{ path: retired.path, beforeDigest: before.digest, beforeMode: before.mode, content: null, mode: null }] }
      generatedRetirement = true
      return { sessionId: 'retirement-builder', threadId: 'retirement-builder', turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    }
    return runtime.runner(request)
  }
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(generatedRetirement, true)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.ok(result.partitionEvidence!.find(item => item.partitionId === 'part-export')!.review.checkedIds.includes('AC-EXPORT-03'))
})

function priorFrom(snapshot: GenerationInput['snapshot'], entries: GenerationInput['manifest']['entries'], files: ReadonlyMap<string, string>, paths: readonly string[]): NonNullable<GenerationInput['priorContext']>[number] {
  return { role: 'source_before', snapshot, entries: entries.filter(entry => paths.includes(entry.path)), files: new Map(paths.map(path => [path, files.get(path)!])), objects: [] }
}

test('删除后本区按related glob把旧Spec和已不在current的helper完整送入生成及独审', async t => {
  const { input, plan, checkpoints, root } = await fixture(t)
  const retiredPath = input.contracts[0].path
  const helperPath = 'src/helpers/format.js'
  const helper = '// helper first marker\nexport function format(value) { return String(value) }\n// helper tail marker\n'
  const oldSpec = input.files.get(retiredPath)!.replace('  - src/export.js#ExportService\n', '  - src/export.js#ExportService\nrelated:\n  - src/helpers/**/*.js\n')
  writeFileSync(join(root, retiredPath), oldSpec)
  mkdirSync(join(root, 'src/helpers'), { recursive: true })
  writeFileSync(join(root, helperPath), helper)
  const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }) }
  git('add', '-A'); git('commit', '-m', 'declare related helper glob')
  const before = await captureInputSnapshot(root, { committed: true })
  const beforeEntries = readTree(before.source.commonDir, before.immutableTree)
  const beforeFiles = new Map(beforeEntries.map(entry => [entry.path, readObject(before.source.commonDir, entry.oid).toString('utf8')]))
  const oldCode = beforeFiles.get('src/export.js')!
  input.snapshot = before
  input.manifest = { version: 1, entries: beforeEntries }
  input.files = beforeFiles
  input.contracts = input.contracts.map(contract => contract.path === retiredPath ? parseContract({ nodeId: contract.nodeId, path: retiredPath, source: oldSpec }).contract! : contract)
  input.elaboratedSpecs = input.elaboratedSpecs.map(spec => spec.path === retiredPath ? { path: retiredPath, source: oldSpec } : spec)
  rmSync(join(root, input.contracts[0].path))
  rmSync(join(root, 'src/export.js'))
  rmSync(join(root, helperPath))
  git('add', '-A'); git('commit', '-m', 'delete specification, source, and related helper')
  const snapshot = await captureInputSnapshot(root)
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  input.snapshot = snapshot
  input.manifest = { version: 1, entries }
  input.files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const retired = input.contracts[0]
  input.contracts = input.contracts.slice(1)
  input.elaboratedSpecs = input.elaboratedSpecs.filter(spec => spec.path !== retired.path)
  input.retiredIds = retired.items.map(item => item.id)
  input.retiredOwners = input.retiredIds.map(id => ({ id, path: retired.path }))
  input.nodeChanges = [{ action: 'retire', from: { nodeId: retired.nodeId, path: retired.path }, evidenceRef: writeEvidence(snapshot.source.commonDir, { explicit: 'deleted specification' }) }]
  input.priorContext = [priorFrom(before, beforeEntries, beforeFiles, [retired.path, 'src/export.js', 'tests/export.test.mjs', helperPath])]
  const exportPartition = plan.partitions.find(partition => partition.id === 'part-export')!
  exportPartition.readPaths = exportPartition.readPaths.filter(path => path !== 'src/export.js')
  exportPartition.writePaths = exportPartition.writePaths.filter(path => path !== 'src/export.js')
  let sawReview = false
  const runtime = native()
  const runner: ElaborationRunner = async request => {
    if (request.purpose === 'code_generate' && request.requestKey.includes('part-export')) {
      const context = JSON.parse(request.prompt.split('冻结完整输入:\n')[1]) as { files: [string, string][]; priorContext?: { role: string; files: [string, string][] }[]; readyIds: string[] }
      const bodies = new Map(context.priorContext?.[0]?.files ?? [])
      assert.equal(context.priorContext?.[0]?.role, 'source_before')
      assert.equal(bodies.get(retired.path), oldSpec)
      assert.equal(bodies.get('src/export.js'), oldCode)
      assert.equal(bodies.get(helperPath), helper)
      assert.equal(context.files.some(([path]) => path === retired.path || path === 'src/export.js'), false)
      assert.ok(context.readyIds.includes('AC-EXPORT-03'))
      assert.ok(request.prompt.includes('不是verifiedDelivery'))
      return { sessionId: 'deleted-builder', threadId: 'deleted-builder', turnId: 'turn', output: { version: 'sync-files-v1', changes: [] }, resultDigest: contentHash(JSON.stringify({ version: 'sync-files-v1', changes: [] })) }
    }
    if (request.purpose === 'code_review' && request.requestKey.includes('final:part-export')) {
      const context = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][]; priorContext?: { role: string; files: [string, string][] }[] }
      const bodies = new Map(context.priorContext?.[0]?.files ?? [])
      assert.equal(bodies.get('src/export.js'), oldCode)
      assert.equal(bodies.get(helperPath), helper)
      assert.equal(context.files.some(([path]) => path === 'src/export.js'), false)
      assert.equal(context.priorContext?.some(item => item.role === 'verified_delivery'), false)
      sawReview = true
    }
    if (request.purpose === 'code_review' && request.requestKey.includes('final:part-import')) {
      const context = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { priorContext?: { files: [string, string][] }[] }
      assert.equal(context.priorContext?.some(item => item.files.some(([, source]) => source === oldSpec)) ?? false, false)
    }
    return runtime.runner(request)
  }
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(sawReview, true)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.ok(result.partitionEvidence!.find(item => item.partitionId === 'part-export')!.review.checkedIds.includes('AC-EXPORT-03'))
})

test('移动后的旧Spec正文仍属于新路径分区，并保留旧ready退役ID', async t => {
  const { input, plan, checkpoints, root } = await fixture(t)
  const oldPath = input.contracts[0].path
  const movedPath = '.spec/export/moved-export/spec.md'
  const oldSpec = input.files.get(oldPath)!
  const before = input.snapshot
  const beforeEntries = input.manifest.entries
  const beforeFiles = new Map(input.files)
  mkdirSync(join(root, '.spec/export/moved-export'), { recursive: true })
  execFileSync('git', ['-C', root, 'mv', oldPath, movedPath], { stdio: 'pipe' })
  execFileSync('git', ['-C', root, 'commit', '-m', 'move export specification'], { stdio: 'pipe' })
  const snapshot = await captureInputSnapshot(root)
  const entries = readTree(snapshot.source.commonDir, snapshot.immutableTree)
  input.snapshot = snapshot
  input.manifest = { version: 1, entries }
  input.files = new Map(entries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  input.contracts = input.contracts.map(contract => contract.path === oldPath ? { ...contract, path: movedPath } : contract)
  input.elaboratedSpecs = input.elaboratedSpecs.map(spec => spec.path === oldPath ? { path: movedPath, source: spec.source } : spec)
  input.retiredIds = ['AC-EXPORT-03']
  input.retiredOwners = [{ id: 'AC-EXPORT-03', path: oldPath }]
  input.nodeChanges = [{ action: 'move', from: { nodeId: 'export-contract', path: oldPath }, to: { nodeId: 'moved-export', path: movedPath }, evidenceRef: writeEvidence(snapshot.source.commonDir, { explicit: 'moved specification' }) }]
  input.priorContext = [priorFrom(before, beforeEntries, beforeFiles, [oldPath, 'src/export.js', 'tests/export.test.mjs'])]
  const exportPartition = plan.partitions.find(partition => partition.id === 'part-export')!
  exportPartition.targets = [{ nodeId: 'moved-export', path: movedPath }]
  exportPartition.readPaths = [movedPath, 'src/export.js', 'tests/export.test.mjs']
  exportPartition.writePaths = [...exportPartition.readPaths]
  let sawReview = false
  const runtime = native()
  const runner: ElaborationRunner = async request => {
    if (request.requestKey.includes('part-export') && (request.purpose === 'code_generate' || request.purpose === 'code_review')) {
      const marker = request.purpose === 'code_generate' ? '冻结完整输入:\n' : '冻结原意和基线完整输入:\n'
      const context = JSON.parse(request.prompt.split(marker)[1].split('\n实际候选身份')[0]) as { files: [string, string][]; priorContext?: { role: string; pairId?: string; files: [string, string][] }[]; readyIds: string[] }
      const bodies = new Map(context.priorContext?.[0]?.files ?? [])
      assert.equal(context.priorContext?.[0]?.role, 'source_before')
      assert.equal(context.priorContext?.[0]?.pairId, undefined)
      assert.equal(bodies.get(oldPath), oldSpec)
      assert.equal(context.files.some(([path]) => path === oldPath), false)
      assert.ok(context.readyIds.includes('AC-EXPORT-03'))
      if (request.purpose === 'code_review') sawReview = true
    }
    return runtime.runner(request)
  }
  const result = await generateSyncPartitions(input, plan, 2, false, { runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(sawReview, true)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.ok(result.partitionEvidence!.find(item => item.partitionId === 'part-export')!.review.checkedIds.includes('AC-EXPORT-03'))
})


test('P1新测试写者只继承原全局授权交集，其他区和只读oracle不获写权', async t => {
  const { input, plan } = await fixture(t)
  const next = structuredClone(input.contracts)
  const owner = next[0], ac = owner.items.find(item => item.kind === 'AC')!
  assert.equal(ac.kind, 'AC')
  ac.test = 'generated-tests/approved.test.mjs#AC-EXPORT-03'
  const authorization = { writePaths: [...input.allowedScope.paths, 'generated-tests'], readonlyPaths: input.mandatoryTests.map(test => test.testPath) }
  const completed = completeSyncPartitionPlan(plan, next, input.files, authorization)
  assert.ok(completed.partitions.find(partition => partition.targets.some(target => target.path === owner.path))!.writePaths.includes('generated-tests/approved.test.mjs'))
  assert.equal(completed.partitions.filter(partition => partition.writePaths.includes('generated-tests/approved.test.mjs')).length, 1)
  const refused = completeSyncPartitionPlan(plan, next, input.files, { ...authorization, readonlyPaths: ['generated-tests/approved.test.mjs'] })
  assert.ok(refused.partitions.every(partition => !partition.writePaths.includes('generated-tests/approved.test.mjs')))
  ac.test = 'outside/unauthorized.test.mjs#AC-EXPORT-03'
  const outside = completeSyncPartitionPlan(plan, next, input.files, authorization)
  assert.ok(outside.partitions.every(partition => !partition.writePaths.includes('outside/unauthorized.test.mjs')))
})


test('P1跨区共享新测试writer在任何代码生成前给出规划repair', async t => {
  const { input, plan, checkpoints } = await fixture(t)
  const path = 'generated-tests/shared.test.mjs'
  for (const partition of plan.partitions.slice(0, 2)) partition.writePaths.push(path)
  input.allowedScope.paths.push(path)
  let calls = 0
  const result = await generateSyncPartitions(input, plan, 2, false, { runner: async () => { calls++; throw new Error('重复writer不得派发代码生成') }, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'repair')
  assert.equal(result.failure?.code, 'implementation_plan_conflict')
  assert.ok(result.failure!.message.includes(path))
  assert.equal(calls, 0)
})
