import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mintIds } from '@spexcode/spec-core'
import { parseContract } from '@spexcode/spec-core/contracts'
import type { Acceptance, Contract } from '@spexcode/spec-core/contracts'
import { ELABORATION_BOUNDARIES } from './elaboration-types.js'
import type { ElaborationRunner, ElaborationSessionRequest } from './elaboration-types.js'
import { elaborate, elaborationDigest, sealPartitionedElaboration } from './elaboration.js'
import { elaborationSchema } from './elaboration-schema.js'
import type { ElaborationInput, ElaborationResult } from './elaboration-types.js'
import { CONTRACT_COLUMNS, parseParts } from '@spexcode/spec-core/contracts'
import type { GeneratedTables, GeneratedTargetElaboration } from './elaboration-markdown.js'
import type { GenerationInput } from './generation-types.js'
import { analyzeSyncPartitions, completeSyncPartitionPlan, elaborateSyncPartitions, generateSyncPartitions, implementationGenerationDispatch, implementationPartitionSelection, mapSyncPartitions } from './partition-execution.js'
import type { PartitionCheckpoints } from './partition-execution.js'
import { planSyncPartitions } from './partitioning.js'
import type { SyncPartitionPlan } from './partitioning.js'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { CodeBehaviorInput } from './code-behavior.js'
import type { CodeBehaviorAnalysis } from './writeback-types.js'
import { composeInputSnapshots } from './composition.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree, writeEvidence } from './snapshot.js'
import { verifyCandidate } from './candidate.js'
import { readFrozenBehaviorContext } from '../../test/frozen-behavior-context.js'

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

async function rawParentInterfaceFixture(t: test.TestContext): Promise<{
  input: ElaborationInput
  plan: SyncPartitionPlan
  checkpoints: PartitionCheckpoints
  paths: { root: string; alpha: string; beta: string; alphaSource: string; betaSource: string; oracle: string; unrelated: string; unrelatedSource: string }
}> {
  const root = mkdtempSync(join(tmpdir(), 'spex-parent-interface-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = {
    root: '.spec/root/spec.md', alpha: '.spec/root/alpha/normalize-tag/spec.md', beta: '.spec/root/beta/join-caption/spec.md',
    alphaSource: 'src/alpha/a.mjs', betaSource: 'src/beta/b.mjs', oracle: 'tests/oracle.test.mjs', unrelated: '.spec/unrelated/spec.md', unrelatedSource: 'src/unrelated/c.mjs',
  }
  const rootRaw = '请把仓库中现有的两个同步纯函数整理为独立、可审查的Spec；只保留当前行为，不增加规则。'
  const rootSource = `---\ntitle: Existing text tools\nstatus: pending\nrelated:\n  - ${paths.oracle}\n  - package.json\n---\n\n## raw source\n\n${rootRaw}\n`
  const alphaSourceSpec = `---\ntitle: Normalize tag\nstatus: pending\ncode:\n  - ${paths.alphaSource}\nrelated:\n  - ${paths.oracle}\n---\n\n此叶属于root原意，记录现有标签规范化函数。\n`
  const betaSourceSpec = `---\ntitle: Join caption\nstatus: pending\ncode:\n  - ${paths.betaSource}\nrelated:\n  - ${paths.oracle}\n---\n\n此叶属于root原意，记录现有标题组合函数。\n`
  for (const path of [paths.root, paths.alpha, paths.beta, paths.alphaSource, paths.betaSource, paths.oracle, paths.unrelated, paths.unrelatedSource, 'package.json']) mkdirSync(join(root, dirname(path)), { recursive: true })
  writeFileSync(join(root, paths.root), rootSource)
  writeFileSync(join(root, paths.alpha), alphaSourceSpec)
  writeFileSync(join(root, paths.beta), betaSourceSpec)
  writeFileSync(join(root, paths.unrelated), `---\ntitle: Unrelated utility\nstatus: pending\ncode:\n  - ${paths.unrelatedSource}\n---\n\n独立工具实现目标。\n`)
  writeFileSync(join(root, paths.alphaSource), `export function normalizeTag(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, '-')\n}\n`)
  writeFileSync(join(root, paths.betaSource), `export function joinCaption(prefix, caption) {\n  return \`${'${prefix.trim()}'}: ${'${caption.trim()}'}\`\n}\n`)
  writeFileSync(join(root, paths.unrelatedSource), 'export function unrelatedUtility(value) { return value }\n')
  writeFileSync(join(root, paths.oracle), `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { normalizeTag } from '../src/alpha/a.mjs'\nimport { joinCaption } from '../src/beta/b.mjs'\n\ntest('ORACLE-LIVE-PARTITION-V2-01', () => {\n  assert.equal(normalizeTag('  Mixed   CASE  '), 'mixed-case')\n  assert.equal(normalizeTag('a/b + c'), 'a/b-+-c')\n  assert.equal(joinCaption('  Product ', ' Update  '), 'Product: Update')\n  assert.equal(joinCaption('', ''), ': ')\n})\n`)
  writeFileSync(join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test tests/oracle.test.mjs"}}\n')
  const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }) }
  git('init', '-b', 'main'); git('config', 'user.email', 'interface@example.invalid'); git('config', 'user.name', 'interface fixture'); git('add', '.'); git('commit', '-m', 'three-node raw-only parent fixture')
  const snapshot = await captureInputSnapshot(root), files = new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const [rootNodeId, alphaNodeId, betaNodeId] = mintIds([paths.root, paths.alpha, paths.beta].map(path => path.split('/').slice(1, -1)))
  const targets = [
    { nodeId: rootNodeId, path: paths.root, source: rootSource, sourceDigest: elaborationDigest(rootSource), rawSource: parseParts(rootSource)!.rawSource! },
    { nodeId: alphaNodeId, path: paths.alpha, source: alphaSourceSpec, sourceDigest: elaborationDigest(alphaSourceSpec) },
    { nodeId: betaNodeId, path: paths.beta, source: betaSourceSpec, sourceDigest: elaborationDigest(betaSourceSpec) },
  ]
  const verification = (suffix: string) => ({ id: `VERIFY-${suffix}-ORACLE`, command: ['node', '--test', paths.oracle], cwd: '.', timeoutMs: 30000 })
  const input: ElaborationInput = {
    root, base: snapshot.headCommit, requestKey: 'parent-interface:p1', intent: { nodeId: rootNodeId, rawSource: parseParts(rootSource)!.rawSource! }, targets,
    files, facts: [], verifications: [verification('ALPHA'), verification('BETA'), verification('ROOT')], implementationWritePaths: [],
    readonlyTestPaths: [paths.oracle], historyInput: snapshot, maxRepairs: 0, maxCalls: 2, timeoutMs: 30000,
  }
  const partitions = [
    { id: 'parent', intentNodeId: rootNodeId, targets: [{ nodeId: rootNodeId, path: paths.root }], readPaths: [paths.root], writePaths: [paths.root], sourcePaths: [], changedPaths: [paths.root], contextNodeIds: [], contractIds: [], flowIds: [], readBytes: Buffer.byteLength(rootSource), readLimitBytes: 524288, oversizedReads: [] },
    { id: 'alpha', intentNodeId: rootNodeId, targets: [{ nodeId: alphaNodeId, path: paths.alpha }], readPaths: [paths.root, paths.alpha, paths.alphaSource, paths.oracle], writePaths: [paths.alpha], sourcePaths: [paths.alphaSource], changedPaths: [paths.alpha], contextNodeIds: [rootNodeId], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] },
    { id: 'beta', intentNodeId: rootNodeId, targets: [{ nodeId: betaNodeId, path: paths.beta }], readPaths: [paths.root, paths.beta, paths.betaSource, paths.oracle], writePaths: [paths.beta], sourcePaths: [paths.betaSource], changedPaths: [paths.beta], contextNodeIds: [rootNodeId], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] },
  ]
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', partitions, dependencies: [], expectedPaths: [paths.root, paths.alpha, paths.beta], digest: contentHash('three-node-parent-interface-plan') }
  const values = new Map<string, unknown>()
  const checkpoints: PartitionCheckpoints = { load: <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : null, save: (key, value) => { values.set(key, structuredClone(value)); return writeEvidence(snapshot.source.commonDir, value) } }
  return { input, plan, checkpoints, paths }
}

async function nestedInterfaceFixture(t: test.TestContext, discoverGamma = false): Promise<{
  input: ElaborationInput
  plan: SyncPartitionPlan
  checkpoints: PartitionCheckpoints
  paths: { root: string; middle: string; alpha: string; gamma: string; alphaSource: string; gammaSource: string; oracle: string }
  nodes: { root: string; middle: string; alpha: string; gamma: string }
  raw: { root: string; middle: string }
}> {
  const root = mkdtempSync(join(tmpdir(), 'spex-nested-interface-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = {
    root: '.spec/root/spec.md', middle: '.spec/root/gamma/spec.md', alpha: '.spec/root/alpha/normalize-tag/spec.md', gamma: '.spec/root/gamma/leaf/upper-tag/spec.md',
    alphaSource: 'src/alpha/normalize.mjs', gammaSource: 'src/gamma/upper.mjs', oracle: 'tests/nested.test.mjs',
  }
  const raw = {
    root: '请分别整理现有标签规范化和gamma子能力，并保持当前行为。',
    middle: 'gamma子能力只整理现有字符串大写转换，不增加其它规则。',
  }
  const source = (title: string, body: string): string => `---\ntitle: ${title}\nstatus: pending\nrelated:\n  - ${paths.oracle}\n---\n\n## raw source\n\n${body}\n`
  const rootSource = source('Text operations', raw.root)
  const middleSource = source('Gamma operations', raw.middle)
  const alphaSourceSpec = `---\ntitle: Normalize tag\nstatus: pending\ncode:\n  - ${paths.alphaSource}\nrelated:\n  - ${paths.oracle}\n---\n\nroot意图中的独立标签能力。\n`
  const gammaSourceSpec = `---\ntitle: Upper tag\nstatus: pending\ncode:\n  - ${paths.gammaSource}\nrelated:\n  - ${paths.oracle}\n---\n\n中间gamma意图下的字符串转换叶能力。\n`
  for (const path of [paths.root, paths.middle, paths.alpha, paths.gamma, paths.alphaSource, paths.gammaSource, paths.oracle, 'package.json']) mkdirSync(join(root, dirname(path)), { recursive: true })
  writeFileSync(join(root, paths.root), rootSource)
  writeFileSync(join(root, paths.middle), middleSource)
  writeFileSync(join(root, paths.alpha), alphaSourceSpec)
  if (!discoverGamma) writeFileSync(join(root, paths.gamma), gammaSourceSpec)
  writeFileSync(join(root, paths.alphaSource), 'export function normalizeTag(value) { return value.trim().toLowerCase() }\n')
  writeFileSync(join(root, paths.gammaSource), 'export function upperTag(value) { return value.toUpperCase() }\n')
  writeFileSync(join(root, paths.oracle), `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { normalizeTag } from '../src/alpha/normalize.mjs'\nimport { upperTag } from '../src/gamma/upper.mjs'\ntest('NESTED-INTERFACE-ORACLE-01', () => { assert.equal(normalizeTag(' Mix '), 'mix'); assert.equal(upperTag('gamma'), 'GAMMA') })\n`)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  const git = (...args: string[]): void => { execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' }) }
  git('init', '-b', 'main'); git('config', 'user.email', 'nested-interface@example.invalid'); git('config', 'user.name', 'nested interface fixture'); git('add', '.'); git('commit', '-m', 'nested raw parent fixture')
  const snapshot = await captureInputSnapshot(root), files = new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const [rootId, middleId, alphaId, gammaId] = mintIds([paths.root, paths.middle, paths.alpha, paths.gamma].map(path => path.split('/').slice(1, -1)))
  const targets = [
    { nodeId: rootId!, path: paths.root, source: rootSource, sourceDigest: elaborationDigest(rootSource), rawSource: parseParts(rootSource)!.rawSource! },
    { nodeId: middleId!, path: paths.middle, source: middleSource, sourceDigest: elaborationDigest(middleSource), rawSource: parseParts(middleSource)!.rawSource! },
    { nodeId: alphaId!, path: paths.alpha, source: alphaSourceSpec, sourceDigest: elaborationDigest(alphaSourceSpec) },
    { nodeId: gammaId!, path: paths.gamma, source: discoverGamma ? null : gammaSourceSpec, sourceDigest: discoverGamma ? null : elaborationDigest(gammaSourceSpec), ...(discoverGamma ? { rawSource: '遵循gamma上层原意，治理现有upperTag字符串转换。' } : {}) },
  ]
  const verify = (domain: 'ALPHA' | 'GAMMA') => ({ id: `VERIFY-${domain}-NESTED`, command: ['node', '--test', paths.oracle], cwd: '.', timeoutMs: 30000 })
  const input: ElaborationInput = {
    root, base: snapshot.headCommit, requestKey: 'nested-interface:p1', intent: { nodeId: rootId!, rawSource: raw.root }, targets,
    files, facts: [], verifications: [verify('ALPHA'), verify('GAMMA')], implementationWritePaths: [], readonlyTestPaths: [paths.oracle],
    historyInput: snapshot, maxRepairs: 0, maxCalls: 2, timeoutMs: 30000,
  }
  const partitions: SyncPartitionPlan['partitions'] = [
    { id: 'root', phase: 'interface_seed', intentNodeId: rootId!, targets: [{ nodeId: rootId!, path: paths.root }], readPaths: [paths.root], writePaths: [paths.root], sourcePaths: [], changedPaths: [paths.root], contextNodeIds: [], contractIds: [], flowIds: [], readBytes: Buffer.byteLength(rootSource), readLimitBytes: 524288, oversizedReads: [] },
    { id: 'middle', phase: 'interface_seed', intentNodeId: rootId!, targets: [{ nodeId: middleId!, path: paths.middle }], readPaths: [paths.root, paths.middle], writePaths: [paths.middle], sourcePaths: [], changedPaths: [paths.middle], contextNodeIds: [rootId!], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] },
    { id: 'alpha', intentNodeId: rootId!, targets: [{ nodeId: alphaId!, path: paths.alpha }], readPaths: [paths.root, paths.alpha, paths.alphaSource, paths.oracle], writePaths: [paths.alpha], sourcePaths: [paths.alphaSource], changedPaths: [paths.alpha], contextNodeIds: [rootId!], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] },
    { id: 'gamma', intentNodeId: rootId!, targets: [{ nodeId: gammaId!, path: paths.gamma }], readPaths: [paths.root, paths.middle, paths.gamma, paths.gammaSource, paths.oracle], writePaths: [paths.gamma], sourcePaths: [paths.gammaSource], changedPaths: [paths.gamma], contextNodeIds: [rootId!, middleId!], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] },
  ]
  if (discoverGamma) {
    delete partitions[1].phase
    partitions[3].targets = []
    partitions[3].changedPaths = [paths.gammaSource]
  }
  const plan: SyncPartitionPlan = { version: 'sync-partitions-v1', partitions, dependencies: [], expectedPaths: [paths.root, paths.middle, paths.alpha, discoverGamma ? paths.gammaSource : paths.gamma], digest: contentHash(`nested-interface-plan:${discoverGamma}`) }
  const values = new Map<string, unknown>()
  const checkpoints: PartitionCheckpoints = { load: <T>(key: string) => values.has(key) ? structuredClone(values.get(key)) as T : null, save: (key, value) => { values.set(key, structuredClone(value)); return writeEvidence(snapshot.source.commonDir, value) } }
  return { input, plan, checkpoints, paths, nodes: { root: rootId!, middle: middleId!, alpha: alphaId!, gamma: gammaId! }, raw }
}

function emptyElaborationTables(): GeneratedTables {
  return Object.fromEntries(Object.keys(CONTRACT_COLUMNS).map(kind => [kind, []])) as unknown as GeneratedTables
}

test('分区分析以独占文件限定事实来源，共享oracle仍逐区全文读取且不制造同源事实冲突', async t => {
  const { input, plan, checkpoints } = await fixture(t), oracle = 'tests/export.test.mjs'
  for (const partition of plan.partitions) {
    partition.readPaths = [...new Set([...partition.readPaths, oracle])]
    partition.writePaths = partition.writePaths.filter(path => path !== oracle)
  }
  const analysisInput: CodeBehaviorInput = {
    snapshot: input.snapshot, baseline: null, composed: composeInputSnapshots(input.snapshot, null).composed!,
    readSetDigest: 'facts-readset', policyDigest: 'facts-policy', requestKey: 'facts-analysis', timeoutMs: 30000, origin: 'initial',
    plan: { version: 'sync-coordinator-v2', direction: 'code_to_spec', intentNodeId: 'export-contract',
      targets: plan.partitions.flatMap(partition => partition.targets), sourcePaths: ['src'], readPaths: ['.spec', 'src', 'tests'],
      writePaths: plan.partitions.flatMap(partition => partition.writePaths), facts: [], verifications: [],
      mandatoryTests: [{ verificationId: 'VERIFY-EXPORT-01', testPath: oracle, testId: 'AC-EXPORT-03' }],
      partitionPolicy: { version: 'sync-partition-policy-v1', maxReadBytes: 524288, maxParallel: 2 },
    },
  }
  const calls: ElaborationSessionRequest[] = []
  const result = await analyzeSyncPartitions(analysisInput, plan, 2, async request => {
    const ordinal = calls.push(request)
    const frozen = readFrozenBehaviorContext<{ partition: { id: string; factSourcePaths: string[] }; changedPaths: string[]; newSource: [string, string][] }>(request)
    const owner = plan.partitions.find(partition => partition.id === frozen.partition?.id)
    assert.ok(owner, '每个真实分区请求必须冻结其事实归属')
    assert.deepEqual(frozen.partition.factSourcePaths, owner.writePaths.filter(path => !path.startsWith('.spec/')).sort())
    assert.equal(frozen.partition.factSourcePaths.includes(oracle), false)
    assert.equal(new Map(frozen.newSource).get(oracle), input.files.get(oracle), '只读oracle不能因事实归属而漏读或截断')
    let output: unknown
    if (request.purpose === 'code_behavior_analyze') {
      const source = owner.sourcePaths[0]
      output = { changes: frozen.changedPaths.map(path => ({ kind: 'refactor', paths: [path], affectedIds: [], ruleIds: [],
        originalIntent: '保留当前模块真实行为', previousBehavior: 'ExportService管理任务状态', sourceBehavior: '当前模块行为不变',
        deliveryBehavior: '首次纳管且没有既有交付', evidence: `完整读取${source}及共享${oracle}的真实断言`, counterexample: '模块断言变化仍需被独审核出',
      })), facts: [{ source: `code:${source}#ExportService`, text: `${source}中的ExportService保留现存任务状态行为。` }], acceptanceChanges: [], newNodes: [], resolutions: [] }
    } else {
      const reviewed = JSON.parse(request.prompt.split('待审分析:\n')[1]) as { analysisDigest: string; analysis: CodeBehaviorAnalysis }
      output = { inputDigest: request.inputDigest, analysisDigest: reviewed.analysisDigest, verdict: 'accept', checkedPaths: frozen.newSource.map(([path]) => path), checkedChangeIds: reviewed.analysis.changes.map(change => change.id), findings: [] }
    }
    return { sessionId: `facts-session-${ordinal}`, threadId: `facts-thread-${ordinal}`, turnId: `facts-turn-${ordinal}`, output, resultDigest: contentHash(JSON.stringify(output)) }
  }, checkpoints)
  assert.equal(result.reviewPassed, true)
  assert.equal(result.facts.length, 3)
  assert.equal(new Set(result.facts.map(fact => fact.source)).size, 3)
  assert.equal(result.partitionEvidence!.length, 3)
  assert.equal(calls.filter(call => call.purpose === 'code_behavior_analyze').length, 3)
  assert.equal(calls.filter(call => call.purpose === 'code_behavior_review').length, 3)
})

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

for (const specOnly of [false, true]) test(`最终派发投影只按真实ready筛选受阻跨边和恢复技术scope：specOnly=${specOnly}`, async t => {
  const { input, plan, checkpoints } = await fixture(t), runtime = native()
  input.readyIds = ['AC-EXPORT-03', 'AC-IMPORT-03']
  input.blockedIds = ['REQ-EXPORT-01', 'REQ-IMPORT-01']
  input.allowedScope.contractIds.push('archive-contract', 'VERIFY-ARCHIVE-01')
  const dispatch = implementationGenerationDispatch(input, plan, specOnly)
  assert.deepEqual(dispatch.locals.map(local => local.partition.id), ['part-export', 'part-import'])
  assert.deepEqual(dispatch.reviews.map(local => local.id), ['part-export', 'part-import'])
  assert.deepEqual(dispatch.planningIds, [])
  assert.equal(dispatch.requiredKeys.length, specOnly ? 2 : 4)
  assert.equal(plan.dependencies.length, 1, '受阻边仍保留于原计划，不冒充实际实施独审')
  const runner: ElaborationRunner = async request => {
    const result = await runtime.runner(request)
    if (request.purpose !== 'code_review') return result
    const context = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { readyIds: string[] }
    const output = { ...result.output as object, checkedIds: context.readyIds }
    return { ...result, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const result = await generateSyncPartitions(input, plan, 2, specOnly, { runner, validateCandidate: async () => [] }, checkpoints)
  assert.equal(result.status, 'reviewed', JSON.stringify(result.failure))
  assert.deepEqual([...dispatch.requiredKeys].sort(), runtime.calls.map(call => call.requestKey).sort())
  assert.deepEqual(result.partitionEvidence!.flatMap(item => item.review.checkedIds).sort(), [...input.readyIds].sort())
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

test('raw-only parent和两个源码叶先审接口再局部细化，完整全局seal后才可推进', async t => {
  const { input, plan, checkpoints, paths } = await rawParentInterfaceFixture(t), calls: ElaborationSessionRequest[] = []
  const rootId = input.intent.nodeId, alphaId = plan.partitions[1].targets[0].nodeId, betaId = plan.partitions[2].targets[0].nodeId
  let childDefect: 'missing-flow' | 'missing-acceptance' | 'missing-code' | 'missing-test' | null = null
  const applicability = () => ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '两个现有纯函数无状态且无外部作用，此边界不适用。', affectedIds: [] }))
  const rootRows = (full: boolean): Record<string, unknown> => {
    const tables = emptyElaborationTables()
    tables.REQ = [
      { id: 'REQ-PARENT-ALPHA-01', goal: '准确说明现有标签规范化函数的可观察行为', source: 'user:raw', constraints: '只整理该函数的已存在行为，不扩展需求。', success: 'normalizeTag的输出保留当前行为。', 'depends-on': [] },
      { id: 'REQ-PARENT-BETA-01', goal: '准确说明现有标题组合函数的可观察行为', source: 'user:raw', constraints: '只整理该函数的已存在行为，不扩展需求。', success: 'joinCaption的输出保留当前行为。', 'depends-on': [] },
    ]
    if (full) {
      tables.AC = [{ id: 'AC-TOOLS-ORACLE', source: 'user:raw', 'depends-on': ['REQ-PARENT-ALPHA-01', 'REQ-PARENT-BETA-01'], covers: ['REQ-PARENT-ALPHA-01', 'REQ-PARENT-BETA-01'], preconditions: '-', action: '运行只读oracle', assertion: '两个现有函数满足原有输出', test: `${paths.oracle}#ORACLE-LIVE-PARTITION-V2-01`, command: 'VERIFY-ROOT-ORACLE' }]
      tables.VERIFY = [{ id: 'VERIFY-ROOT-ORACLE', command: ['node', '--test', paths.oracle], cwd: '.', 'timeout-ms': 30000 }]
    }
    return {
      version: 'elaboration-target-rows-v3',
      changes: [{ targetIndex: 0, title: 'Existing text tools', description: '', code: [], related: [paths.oracle, 'package.json'], prose: null, removeIds: [], tables }],
      applicability: applicability(),
    }
  }
  const childRows = (domain: 'alpha' | 'beta', nodeId: string, targetPath: string, sourcePath: string): Record<string, unknown> => {
    const upper = domain.toUpperCase(), ownReq = `REQ-${upper}-01`, ownRule = `RULE-${upper}-01`, flow = `FLOW-${upper}-01`, step = `STEP-${upper}-01`, ac = `AC-${upper}-ORACLE`, verify = `VERIFY-${upper}-ORACLE`
    const parentReq = `REQ-PARENT-${upper}-01`
    const symbol = domain === 'alpha' ? 'normalizeTag' : 'joinCaption'
    const tables = emptyElaborationTables()
    tables.REQ = [{ id: ownReq, goal: `记录${symbol}现存输出行为`, source: `derived:${parentReq}`, constraints: '只描述当前纯函数行为。', success: `${symbol}输出符合只读oracle。`, 'depends-on': [parentReq] }]
    tables.RULE = [{ id: ownRule, scope: `src/${domain}`, constraint: '保持当前字符串转换结果。', basis: `冻结源码${sourcePath}及oracle断言。`, source: `derived:${ownReq}`, authority: nodeId, 'depends-on': [ownReq] }]
    tables.FLOW = [{ id: flow, req: [parentReq, ownReq], actors: '调用方', entry: `调用${symbol}`, preconditions: '输入为字符串。', steps: [step], terminal: 'END', source: `derived:${ownReq}`, 'depends-on': [parentReq, ownReq] }]
    tables.STEP = [{ id: step, flow, action: `同步调用${symbol}`, input: '字符串输入', output: '转换后的字符串', rules: [ownRule], next: 'END', source: `derived:${ownReq}`, 'depends-on': [parentReq, ownReq] }]
    tables.AC = [{ id: ac, source: `derived:${ownReq}`, 'depends-on': [ownReq], covers: [parentReq, ownReq, ownRule], preconditions: '输入符合oracle用例。', action: `调用${symbol}`, assertion: `结果精确符合${symbol}既有行为`, test: `${paths.oracle}#ORACLE-LIVE-PARTITION-V2-01`, command: verify }]
    tables.VERIFY = [{ id: verify, command: ['node', '--test', paths.oracle], cwd: '.', 'timeout-ms': 30000 }]
    if (domain === 'alpha') {
      if (childDefect === 'missing-flow') tables.FLOW = []
      if (childDefect === 'missing-acceptance') tables.AC = []
      if (childDefect === 'missing-test') tables.AC[0].test = 'tests/missing-oracle.test.mjs#ORACLE-LIVE-PARTITION-V2-01'
    }
    const code = childDefect === 'missing-code' && domain === 'alpha' ? [] : [`${sourcePath}#${symbol}`]
    return {
      version: 'elaboration-target-rows-v3',
      changes: [{ targetIndex: 0, title: domain === 'alpha' ? 'Normalize tag' : 'Join caption', description: '', code, related: [paths.oracle], prose: '这是无状态同步纯函数：状态不适用，没有外部副作用，结果只依赖输入。', removeIds: [], tables }],
      applicability: applicability(),
    }
  }
  const runner: ElaborationRunner = async request => {
    calls.push(request)
    const encoded = request.prompt.split('冻结业务输入:\n')[1]?.split('\n')[0]
    const context = encoded ? JSON.parse(encoded) as { phase?: string; targets: { nodeId: string; path: string }[]; context?: { nodeId: string; path: string; source: string }[]; files: [string, string][] } : null
    let output: unknown
    if (request.purpose === 'elaboration_generate') {
      if (context?.targets[0]?.nodeId === rootId) output = rootRows(context.phase !== 'interface_seed')
      else {
        const target = context?.targets[0]
        assert.ok(target)
        const alpha = target.nodeId === alphaId
        output = childRows(alpha ? 'alpha' : 'beta', target.nodeId, target.path, alpha ? paths.alphaSource : paths.betaSource)
      }
    } else output = { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `interface-session-${calls.length}`, threadId: `interface-thread-${calls.length}`, turnId: `interface-turn-${calls.length}`, output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const result = await elaborateSyncPartitions(input, plan, 2, checkpoints, runner)
  const rootRef = result.partitionEvidence?.find(item => item.partitionId === 'parent')?.resultRef
  const failedRootEvidence = rootRef ? JSON.parse(readEvidence(input.historyInput!.source.commonDir, rootRef).toString('utf8')) as ElaborationResult : null
  assert.equal(result.structurePassed, true, JSON.stringify({ failure: result.failure, rootFindings: failedRootEvidence?.rounds.flatMap(round => round.findings).map(({ code, itemId, message }) => ({ code, itemId, message })), sealFindings: result.partitionSeal?.findings.map(({ code, itemId, message }) => ({ code, itemId, message })), partitions: result.partitionEvidence?.map(item => { const evidence = JSON.parse(readEvidence(input.historyInput!.source.commonDir, item.resultRef).toString('utf8')) as ElaborationResult; return { partitionId: item.partitionId, status: evidence.status, phase: evidence.phase, structurePassed: evidence.structurePassed, reviewPassed: evidence.reviewPassed, failure: evidence.failure, findings: evidence.rounds.flatMap(round => round.findings).map(({ code, itemId, message }) => ({ code, itemId, message })) } }) }))
  assert.equal(result.reviewPassed, true)
  assert.equal(result.status, 'complete')
  assert.equal(result.implementationReady, false)
  assert.equal(result.contracts.length, 3)
  const root = result.contracts.find(contract => contract.nodeId === rootId)!
  assert.deepEqual(root.code, [], '接口父节点不能取得源码治理锚点')
  const alphaRootCoverage = result.coverage!.items.find(item => item.id === 'REQ-PARENT-ALPHA-01')!
  const betaRootCoverage = result.coverage!.items.find(item => item.id === 'REQ-PARENT-BETA-01')!
  assert.equal(alphaRootCoverage.status, 'bound')
  assert.deepEqual(alphaRootCoverage.acceptanceIds, ['AC-ALPHA-ORACLE'])
  assert.deepEqual(alphaRootCoverage.code, [`${paths.alphaSource}#normalizeTag`])
  assert.equal(betaRootCoverage.status, 'bound')
  assert.deepEqual(betaRootCoverage.acceptanceIds, ['AC-BETA-ORACLE'])
  assert.deepEqual(betaRootCoverage.code, [`${paths.betaSource}#joinCaption`])
  assert.equal(result.phase, 'partitioned_final')
  assert.equal(result.partitionSeal?.passed, true)
  assert.ok(result.partitionSeal?.candidateDigest)
  assert.equal(result.partitionSeal?.candidateDigest, elaborationDigest(JSON.stringify({ inputDigest: result.partitionSeal!.inputDigest, changes: result.changes.map(({ contentDigest: _contentDigest, ...change }) => change), applicability: result.partitionSeal!.applicability, nodeChanges: [] })))
  const rootRequest = calls.find(request => request.requestKey.includes(':partition:parent:') && request.purpose === 'elaboration_generate')!
  const rootContext = JSON.parse(rootRequest.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { files: [string, string][]; phase: string }
  assert.equal(rootContext.phase, 'interface_seed')
  assert.deepEqual(rootContext.files.map(([path]) => path), [paths.root])
  const rootChangeSchema = (rootRequest.schema.properties as { changes: { items: { properties: Record<string, { items?: Record<string, unknown> }> } } }).changes.items.properties
  assert.equal('enum' in rootChangeSchema.code.items!, false, '空code锚点不生成非法空enum')
  const emptyRelationsSource = `---\ntitle: Raw parent\nstatus: pending\n---\n\n## raw source\n\n${input.intent.rawSource}\n`
  const noRelationSchema = elaborationSchema({ ...input, targets: [{ ...input.targets[0], source: emptyRelationsSource, sourceDigest: elaborationDigest(emptyRelationsSource) }] }, { purpose: 'interface_seed' })
  const noRelationProperties = (noRelationSchema.properties as { changes: { items: { properties: Record<string, { items?: Record<string, unknown> }> } } }).changes.items.properties
  assert.equal('enum' in noRelationProperties.related.items!, false, '空related路径不生成非法空enum')
  assert.ok(!rootRequest.prompt.includes('return value.trim()') && !rootRequest.prompt.includes("assert.equal(normalizeTag("), '父接口只持分类路径证据，不读取子源码或oracle正文')
  const rootEvidenceRef = result.partitionEvidence!.find(item => item.partitionId === 'parent')!.resultRef
  const rootEvidence = JSON.parse(readEvidence(input.historyInput!.source.commonDir, rootEvidenceRef).toString('utf8')) as { phase?: string; status: string; readyIds: string[]; readyFlowIds: string[]; implementationReady: false; reviewPassed: boolean; changes: { nodeId: string; path: string; source: string }[] }
  assert.equal(rootEvidence.phase, 'interface_seed')
  assert.equal(rootEvidence.status, 'interface_seed')
  assert.deepEqual(rootEvidence.readyIds, [])
  assert.deepEqual(rootEvidence.readyFlowIds, [])
  assert.equal(rootEvidence.implementationReady, false)
  assert.equal(rootEvidence.reviewPassed, true, '接口本身经过独立语义审查，不能冒称全图评审')
  assert.deepEqual(parseContract({ nodeId: rootId, path: paths.root, source: rootEvidence.changes[0].source }).contract!.code, [])
  assert.equal(calls.filter(request => request.purpose === 'elaboration_generate').length, 3)
  assert.equal(calls.filter(request => request.purpose === 'elaboration_review').length, 3)
  assert.ok(calls.filter(request => request.requestKey.includes(':partition:alpha:')).every(request => request.prompt.includes('REQ-PARENT-ALPHA-01')))
  assert.ok(calls.filter(request => request.requestKey.includes(':partition:beta:')).every(request => request.prompt.includes('REQ-PARENT-BETA-01')))
  const alphaContract = result.contracts.find(contract => contract.nodeId === alphaId)!
  const betaContract = result.contracts.find(contract => contract.nodeId === betaId)!
  assert.ok(alphaContract.items.some(item => item.kind === 'FLOW' && item.req.includes('REQ-PARENT-ALPHA-01')))
  assert.ok(alphaContract.items.some(item => item.kind === 'AC' && item.covers.includes('REQ-PARENT-ALPHA-01')))
  assert.ok(!alphaContract.items.some(item => item.kind === 'FLOW' && item.req.includes('REQ-PARENT-BETA-01')))
  assert.ok(!alphaContract.items.some(item => item.kind === 'AC' && item.covers.includes('REQ-PARENT-BETA-01')))
  assert.ok(betaContract.items.some(item => item.kind === 'FLOW' && item.req.includes('REQ-PARENT-BETA-01')))
  assert.ok(betaContract.items.some(item => item.kind === 'AC' && item.covers.includes('REQ-PARENT-BETA-01')))
  assert.ok(!betaContract.items.some(item => item.kind === 'FLOW' && item.req.includes('REQ-PARENT-ALPHA-01')))
  assert.ok(!betaContract.items.some(item => item.kind === 'AC' && item.covers.includes('REQ-PARENT-ALPHA-01')))
  const completed = completeSyncPartitionPlan(plan, result.contracts, input.files!, { writePaths: [], readonlyPaths: [paths.oracle] })
  const alphaEdge = completed.dependencies.find(edge => edge.from === 'alpha' && edge.to === 'parent')!
  const betaEdge = completed.dependencies.find(edge => edge.from === 'beta' && edge.to === 'parent')!
  assert.ok(alphaEdge.contractIds.includes('REQ-PARENT-ALPHA-01'))
  assert.ok(!alphaEdge.contractIds.includes('REQ-PARENT-BETA-01'))
  assert.ok(betaEdge.contractIds.includes('REQ-PARENT-BETA-01'))
  assert.ok(!betaEdge.contractIds.includes('REQ-PARENT-ALPHA-01'))
  const generationInput: GenerationInput = {
    root: input.root, requestKey: 'parent-interface:p2', snapshot: input.historyInput!,
    manifest: { version: 1, entries: readTree(input.historyInput!.source.commonDir, input.historyInput!.immutableTree) },
    files: input.files!, contracts: result.contracts,
    elaboratedSpecs: result.changes.map(change => ({ path: change.path, source: change.source })),
    readyIds: result.readyIds, blockedIds: result.blockedIds, intent: input.intent, facts: [],
    existingAcceptance: result.contracts.flatMap(contract => contract.items.filter((item): item is Acceptance => item.kind === 'AC')),
    mandatoryTests: [], verifications: input.verifications!,
    allowedScope: { paths: completed.partitions.flatMap(partition => partition.writePaths), contractIds: result.readyIds, flowIds: result.readyFlowIds },
    policy: { version: 'sync-coordinator-v2', digest: 'parent-interface-p2-policy' }, timeoutMs: 30000,
    model: 'gpt-6.1-sol', effort: 'high',
  }
  const reviewCalls: ElaborationSessionRequest[] = []
  const reviewed = await generateSyncPartitions(generationInput, completed, 2, true, { runner: async request => {
    const ordinal = reviewCalls.push(request)
    const properties = request.schema.properties as { inputId: { enum: string[] }; candidateDigest: { enum: string[] }; checkedIds: { items: { enum: string[] }; description: string } }
    const requiredIds = JSON.parse(properties.checkedIds.description.match(/全部预定项：(.*)；/)![1]) as string[]
    const output = { inputId: properties.inputId.enum[0], candidateDigest: properties.candidateDigest.enum[0], verdict: 'accept', checkedIds: requiredIds, findings: [] }
    return { sessionId: `parent-p2-session-${ordinal}`, threadId: `parent-p2-thread-${ordinal}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }, validateCandidate: async () => [] }, checkpoints)
  assert.equal(reviewed.status, 'reviewed', JSON.stringify(reviewed.failure))
  assert.equal(reviewCalls.length, 4, '纯接口父节点跳过本地P2 review，仅两个子owner和两条跨边参与')
  assert.ok(reviewCalls.every(request => !request.requestKey.includes(':final:parent')))
  const alphaEdgeReview = reviewCalls.find(request => request.requestKey.includes(':final:edge:alpha:parent'))!
  assert.ok(!alphaEdgeReview.prompt.includes('export function joinCaption(prefix, caption)'), 'alpha跨边独审只读取共享oracle中的beta断言，不读取beta实现')
  const alphaEdgeBinding = (alphaEdgeReview.schema.properties as { checkedIds: { description: string } }).checkedIds.description.match(/全部预定项：(.*)；/)![1]
  const alphaEdgeRequired = JSON.parse(alphaEdgeBinding) as string[]
  assert.ok(alphaEdgeRequired.includes('REQ-PARENT-ALPHA-01'))
  assert.ok(!alphaEdgeRequired.includes('REQ-PARENT-BETA-01'))
  const betaEdgeReview = reviewCalls.find(request => request.requestKey.includes(':final:edge:beta:parent'))!
  assert.ok(!betaEdgeReview.prompt.includes('export function normalizeTag(value)'), 'beta跨边独审只读取共享oracle中的alpha断言，不读取alpha实现')
  const betaEdgeBinding = (betaEdgeReview.schema.properties as { checkedIds: { description: string } }).checkedIds.description.match(/全部预定项：(.*)；/)![1]
  const betaEdgeRequired = JSON.parse(betaEdgeBinding) as string[]
  assert.ok(betaEdgeRequired.includes('REQ-PARENT-BETA-01'))
  assert.ok(!betaEdgeRequired.includes('REQ-PARENT-ALPHA-01'))

  const codePlan = structuredClone(completed)
  codePlan.partitions.find(partition => partition.id === 'alpha')!.writePaths.push(paths.alphaSource)
  codePlan.partitions.find(partition => partition.id === 'beta')!.writePaths.push(paths.betaSource)
  const codeInput: GenerationInput = { ...generationInput, requestKey: 'parent-interface:p2-code', allowedScope: { ...generationInput.allowedScope, paths: codePlan.partitions.flatMap(partition => partition.writePaths) } }
  const codeRuntime = native()
  const codeCheckpoints: PartitionCheckpoints = { load: () => null, save: (_key, value) => writeEvidence(input.historyInput!.source.commonDir, value) }
  const codeGenerated = await generateSyncPartitions(codeInput, codePlan, 2, false, { runner: codeRuntime.runner, validateCandidate: async () => [] }, codeCheckpoints)
  assert.equal(codeGenerated.status, 'reviewed', JSON.stringify(codeGenerated.failure))
  assert.equal(codeRuntime.calls.filter(request => request.purpose === 'code_generate').length, 2, 'spec→code只派两位真实源码owner，不派纯接口父writer')
  const candidateEntries = verifyCandidate(input.historyInput!.source.commonDir, codeGenerated.candidate!)
  const parentEntry = candidateEntries.find(entry => entry.path === paths.root)!
  assert.equal(readObject(input.historyInput!.source.commonDir, parentEntry.oid).toString('utf8'), result.changes.find(change => change.path === paths.root)!.source, 'P2必须保留并装配已审父接口Spec')
  for (const sourcePath of [paths.alphaSource, paths.betaSource]) {
    const sourceEntry = candidateEntries.find(entry => entry.path === sourcePath)!
    assert.match(readObject(input.historyInput!.source.commonDir, sourceEntry.oid).toString('utf8'), /partition implementation/)
  }

  const importPath = '.spec/root/import-contract/spec.md'
  const importSource = result.changes.find(change => change.nodeId === alphaId)!.source
    .replaceAll('Normalize tag', 'External import')
    .replaceAll(paths.alphaSource, 'src/import.js')
    .replaceAll(paths.oracle, 'tests/import.test.mjs')
    .replaceAll('REQ-ALPHA-01', 'REQ-IMPORT-01')
    .replaceAll('RULE-ALPHA-01', 'RULE-IMPORT-01')
    .replaceAll('FLOW-ALPHA-01', 'FLOW-IMPORT-01')
    .replaceAll('STEP-ALPHA-01', 'STEP-IMPORT-01')
    .replaceAll('AC-ALPHA-ORACLE', 'AC-IMPORT-ORACLE')
    .replaceAll('VERIFY-ALPHA-ORACLE', 'VERIFY-IMPORT-ORACLE')
    .replaceAll(alphaId, 'import-contract')
  const importContext = { nodeId: 'import-contract', path: importPath, source: importSource }
  const importVerification = { id: 'VERIFY-IMPORT-ORACLE', command: ['node', '--test', 'tests/import.test.mjs'], cwd: '.', timeoutMs: 30000 }
  const readonlyContextFiles = new Map(input.files!)
  const withMissingReadonlyContext: ElaborationInput = { ...input, requestKey: 'parent-interface:context-files', context: [importContext], files: readonlyContextFiles, verifications: [...input.verifications!, importVerification] }
  const alphaTarget = input.targets.find(target => target.nodeId === alphaId)!
  const parentContext = { nodeId: rootId, path: paths.root, source: result.changes.find(change => change.nodeId === rootId)!.source }
  const missingContextSeal = sealPartitionedElaboration(withMissingReadonlyContext, result.partitionSeal!.changes, result.partitionSeal!.applicability)
  const completeContextFiles = new Map(readonlyContextFiles)
  completeContextFiles.set('src/import.js', "export function normalizeTag(value) { return value.trim().toLowerCase().replace(/\\s+/g, '-') }\n")
  completeContextFiles.set('tests/import.test.mjs', "import test from 'node:test'\ntest('ORACLE-LIVE-PARTITION-V2-01', () => {})\n")
  const completeContextSeal = sealPartitionedElaboration({ ...withMissingReadonlyContext, files: completeContextFiles }, result.partitionSeal!.changes, result.partitionSeal!.applicability)
  await t.test('局部只读context可以延后，但非分区P1和全局seal严格拒绝缺源/测试', async () => {
    const localContextInput = { ...withMissingReadonlyContext, requestKey: 'parent-interface:local-context', targets: [alphaTarget], context: [parentContext, importContext], validationScope: 'partition_local' as const }
    const localContextP1 = await elaborate(localContextInput, { runner })
    assert.equal(localContextP1.structurePassed, true, '局部P1保留只读context缺项延后到全局seal检查')
    const ordinaryContextP1 = await elaborate({ ...withMissingReadonlyContext, requestKey: 'parent-interface:ordinary-context', targets: [alphaTarget], context: [parentContext, importContext] }, { runner })
    assert.equal(ordinaryContextP1.structurePassed, false, '非分区完整P1必须直接严格检查冻结context')
    assert.ok(ordinaryContextP1.rounds.flatMap(round => round.findings).some(issue => issue.code === 'readonly_implementation_gap'))
    assert.notEqual(localContextP1.inputDigest, ordinaryContextP1.inputDigest, '局部校验范围必须绑定输入与调用摘要')
    assert.equal(missingContextSeal.seal.passed, false, '全局final seal必须检查完整只读context')
    assert.ok(missingContextSeal.seal.findings.some(issue => issue.code === 'readonly_implementation_gap'))
    assert.equal(completeContextSeal.seal.passed, true, JSON.stringify(completeContextSeal.seal.findings.map(({ code, itemId }) => ({ code, itemId }))))
  })

  for (const [defect, expectedCode] of [
    ['missing-flow', 'missing-requirement-flow'],
    ['missing-acceptance', 'missing-acceptance'],
    ['missing-code', 'readonly_implementation_gap'],
    ['missing-test', 'readonly_implementation_gap'],
  ] as const) {
    await t.test(`全局seal拒绝子区缺${defect}`, async subtest => {
      childDefect = defect
      try {
        const failed = await rawParentInterfaceFixture(subtest)
        const rejected = await elaborateSyncPartitions(failed.input, failed.plan, 2, failed.checkpoints, runner)
        assert.equal(rejected.structurePassed, false, `${defect}: ${JSON.stringify(rejected.partitionSeal?.findings.map(({ code, itemId }) => ({ code, itemId })))}`)
        assert.equal(rejected.partitionSeal?.passed, false)
        assert.ok(rejected.partitionSeal?.findings.some(issue => issue.code === expectedCode), `${defect} 未由全局seal保留: ${JSON.stringify(rejected.partitionSeal?.findings.map(({ code, itemId }) => ({ code, itemId })))}`)
      } finally { childDefect = null }
    })
  }

  await t.test('无子源码target的raw-only叶仍硬拒', async subtest => {
    const leaf = await rawParentInterfaceFixture(subtest)
    leaf.input.targets = [leaf.input.targets[0]!]
    leaf.plan.partitions = [leaf.plan.partitions[0]!]
    leaf.plan.expectedPaths = [paths.root]
    const readonlyLeaf = await elaborateSyncPartitions(leaf.input, leaf.plan, 1, leaf.checkpoints, runner)
    assert.equal(readonlyLeaf.structurePassed, false, '没有活跃子源码目标的raw-only叶不能借接口seed通过只读实现缺口')
    assert.ok(readonlyLeaf.partitionSeal?.findings.some(issue => issue.code === 'readonly_implementation_gap'))
  })

  await t.test('只有测试治理的后代不能借无关sourcePaths把父判成seed', async subtest => {
    const testOnly = await rawParentInterfaceFixture(subtest)
    testOnly.input.requestKey = 'parent-interface:test-only'
    testOnly.input.targets = testOnly.input.targets.map(target => {
      if (target.nodeId === rootId) return target
      const source = target.source!.replaceAll(target.nodeId === alphaId ? paths.alphaSource : paths.betaSource, paths.oracle)
      return { ...target, source, sourceDigest: elaborationDigest(source) }
    })
    const files = new Map(testOnly.input.files)
    for (const target of testOnly.input.targets) files.set(target.path, target.source!)
    testOnly.input.files = files
    const rejected = await elaborateSyncPartitions(testOnly.input, testOnly.plan, 2, testOnly.checkpoints, runner)
    const rootCall = calls.find(request => request.requestKey.startsWith('parent-interface:test-only:partition:parent:') && request.purpose === 'elaboration_generate')!
    const frozen = JSON.parse(rootCall.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { phase?: string }
    assert.equal(frozen.phase, undefined)
    assert.equal(rejected.structurePassed, false)
  })
  await t.test('目录外的active source target不构成raw-only父的子实现', async subtest => {
    const unrelated = await rawParentInterfaceFixture(subtest)
    const unrelatedId = mintIds([paths.unrelated.split('/').slice(1, -1)])[0]!
    const unrelatedSource = unrelated.input.files!.get(paths.unrelated)!
    unrelated.input.targets = [unrelated.input.targets.find(target => target.nodeId === rootId)!, { nodeId: unrelatedId, path: paths.unrelated, source: unrelatedSource, sourceDigest: elaborationDigest(unrelatedSource) }]
    const parentPartition = unrelated.plan.partitions[0]!
    unrelated.plan.partitions = [parentPartition, { id: 'unrelated', intentNodeId: rootId, targets: [{ nodeId: unrelatedId, path: paths.unrelated }], readPaths: [paths.root, paths.unrelated, paths.unrelatedSource, paths.oracle], writePaths: [paths.unrelated], sourcePaths: [paths.unrelatedSource], changedPaths: [paths.unrelated], contextNodeIds: [rootId], contractIds: [], flowIds: [], readBytes: 3000, readLimitBytes: 524288, oversizedReads: [] }]
    unrelated.plan.expectedPaths = [paths.root, paths.unrelated]
    unrelated.input.requestKey = 'parent-interface:unrelated-target'
    const unrelatedResult = await elaborateSyncPartitions(unrelated.input, unrelated.plan, 1, unrelated.checkpoints, runner)
    const unrelatedRootRequest = calls.find(request => request.requestKey.startsWith('parent-interface:unrelated-target:partition:parent:') && request.purpose === 'elaboration_generate')!
    const unrelatedRootContext = JSON.parse(unrelatedRootRequest.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { phase?: string }
    assert.equal(unrelatedRootContext.phase, undefined, '无关路径下的活跃源码分区不能让root逃过完整只读P1')
    assert.equal(unrelatedResult.structurePassed, false)
  })
})

test('多层raw-only父逐级结算真实接口后两叶并行，并只从严格全局seal推进', async t => {
  const { input, plan, checkpoints, paths, nodes, raw } = await nestedInterfaceFixture(t)
  const calls: ElaborationSessionRequest[] = [], settled = new Set<string>()
  let leafInFlight = 0, maxLeafInFlight = 0
  let releaseLeaves!: () => void
  const bothLeaves = new Promise<void>(resolve => { releaseLeaves = resolve })
  const applicability = ELABORATION_BOUNDARIES.map(boundary => ({ boundary, applies: false, basis: '现有字符串纯函数没有状态与外部副作用。', affectedIds: [] }))
  const rows = (nodeId: string): Record<string, unknown> => {
    const tables = emptyElaborationTables()
    let code: string[] = [], prose: string | null = null
    if (nodeId === nodes.root) {
      tables.REQ = [
        { id: 'REQ-NESTED-ALPHA', goal: '保留既有标签规范化行为', source: 'user:raw', constraints: '不扩展需求', success: '规范化结果不变', 'depends-on': [] },
        { id: 'REQ-NESTED-GAMMA', goal: '保留gamma子能力的现存行为', source: 'user:raw', constraints: '不扩展需求', success: 'gamma结果不变', 'depends-on': [] },
      ]
      tables.RULE = [{ id: 'RULE-NESTED-ALPHA-POLICY', scope: '标签规范化', constraint: '保持既有标签规范化结果。', basis: '父raw要求保留当前行为。', source: 'derived:REQ-NESTED-ALPHA', authority: nodes.root, 'depends-on': ['REQ-NESTED-ALPHA'] }]
    } else if (nodeId === nodes.middle) {
      tables.REQ = [{ id: 'REQ-NESTED-MIDDLE', goal: '只整理既有大写转换', source: 'user:raw', constraints: '不新增转换规则', success: '现有字符串大写结果不变', 'depends-on': ['REQ-NESTED-GAMMA'] }]
    } else {
      const alpha = nodeId === nodes.alpha, domain = alpha ? 'ALPHA' : 'GAMMA', symbol = alpha ? 'normalizeTag' : 'upperTag'
      const sourcePath = alpha ? paths.alphaSource : paths.gammaSource, ancestors = alpha ? ['REQ-NESTED-ALPHA'] : ['REQ-NESTED-GAMMA', 'REQ-NESTED-MIDDLE']
      const req = `REQ-${domain}-NESTED`, flow = `FLOW-${domain}-NESTED`, step = `STEP-${domain}-NESTED`, rule = `RULE-${domain}-NESTED`
      tables.REQ = [{ id: req, goal: `记录${symbol}现有行为`, source: `derived:${ancestors.at(-1)}`, constraints: '只描述冻结实现', success: '输出符合既有oracle', 'depends-on': ancestors }]
      tables.RULE = [{ id: rule, scope: sourcePath, constraint: '只接受字符串输入，返回冻结实现定义的转换结果，保持当前不变量。', basis: '现有源码和只读oracle', source: `derived:${req}`, authority: nodeId, 'depends-on': [req] }]
      tables.FLOW = [{ id: flow, req: [...ancestors, req], actors: '调用方', entry: `调用${symbol}`, preconditions: '输入字符串', steps: [step], terminal: 'END', source: `derived:${req}`, 'depends-on': [...ancestors, req] }]
      tables.STEP = [{ id: step, flow, action: `同步调用${symbol}`, input: '字符串', output: '转换结果', rules: alpha ? [rule, 'RULE-NESTED-ALPHA-POLICY'] : [rule], next: 'END', source: `derived:${req}`, 'depends-on': [req] }]
      tables.AC = [{ id: `AC-${domain}-NESTED`, source: `derived:${req}`, 'depends-on': [req], covers: [...ancestors, req, rule, ...alpha ? ['RULE-NESTED-ALPHA-POLICY'] : []], preconditions: 'oracle输入', action: `调用${symbol}`, assertion: '既有结果不变', test: `${paths.oracle}#NESTED-INTERFACE-ORACLE-01`, command: `VERIFY-${domain}-NESTED` }]
      tables.VERIFY = [{ id: `VERIFY-${domain}-NESTED`, command: ['node', '--test', paths.oracle], cwd: '.', 'timeout-ms': 30000 }]
      code = [`${sourcePath}#${symbol}`]
      prose = '这是无状态同步纯函数，状态不适用，输出只由输入决定。'
    }
    return { version: 'elaboration-target-rows-v3', changes: [{ targetIndex: 0, title: nodeId, description: '', code, related: [paths.oracle], prose, removeIds: [], tables }], applicability }
  }
  const runner: ElaborationRunner = async request => {
    const ordinal = calls.push(request)
    const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { intent: { nodeId: string; rawSource: string }; phase?: string; targets: { nodeId: string }[]; context: { path: string; source: string }[] }
    const nodeId = frozen.targets[0].nodeId, seed = nodeId === nodes.root || nodeId === nodes.middle
    if (request.purpose === 'elaboration_generate') {
      assert.equal(frozen.phase, seed ? 'interface_seed' : undefined)
      if (nodeId === nodes.middle) {
        assert.equal(frozen.intent.nodeId, nodes.middle)
        assert.equal(frozen.intent.rawSource, raw.middle)
        assert.ok(settled.has(nodes.root), '中间父必须等待祖先独审结算')
        assert.ok(frozen.context.find(context => context.path === paths.root)?.source.includes('REQ-NESTED-GAMMA'))
      }
      if (!seed) {
        assert.deepEqual([...settled].sort(), [nodes.root, nodes.middle].sort(), '叶派发前全部祖先seed已审')
        leafInFlight++; maxLeafInFlight = Math.max(maxLeafInFlight, leafInFlight)
        if (leafInFlight === 2) releaseLeaves()
        await bothLeaves
        leafInFlight--
      }
    } else if (seed) settled.add(nodeId)
    const output = request.purpose === 'elaboration_generate' ? rows(nodeId) : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
    return { sessionId: `nested-session-${ordinal}`, threadId: `nested-thread-${ordinal}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
  }
  const result = await elaborateSyncPartitions(input, plan, 2, checkpoints, runner)
  assert.equal(result.structurePassed, true, JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings).map(({ code, message }) => ({ code, message })), seal: result.partitionSeal?.findings }))
  assert.equal(result.reviewPassed, true)
  assert.equal(result.partitionSeal?.passed, true)
  assert.equal(maxLeafInFlight, 2)
  assert.equal(calls.length, 8, '四位构建者与四位独审，无全图模型调用')
  for (const path of [paths.root, paths.middle]) assert.equal(parseParts(result.changes.find(change => change.path === path)!.source)!.rawSource, parseParts(input.files!.get(path)!)!.rawSource)
  for (const req of ['REQ-NESTED-ALPHA', 'REQ-NESTED-GAMMA', 'REQ-NESTED-MIDDLE']) assert.equal(result.coverage!.items.find(item => item.id === req)?.status, 'bound')
  for (const evidence of result.partitionEvidence!) {
    const local = JSON.parse(readEvidence(input.historyInput!.source.commonDir, evidence.resultRef).toString('utf8')) as ElaborationResult
    assert.equal(local.partitionBinding?.planDigest, plan.digest)
    assert.equal(local.partitionBinding?.partitionId, evidence.partitionId)
    const request = calls.find(call => call.requestKey.includes(`:partition:${evidence.partitionId}:`) && call.purpose === 'elaboration_generate')!
    const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { targetIndex?: number }[]; partitionBinding: unknown }
    assert.deepEqual(local.partitionBinding, frozen.partitionBinding)
    frozen.targets = frozen.targets.map(({ targetIndex: _targetIndex, ...target }) => target)
    assert.equal(contentHash(JSON.stringify(frozen)), local.inputDigest, '分区计划与分类证据参与真实局部inputDigest')
  }
  const replay = await elaborateSyncPartitions(input, plan, 2, checkpoints, async () => { throw new Error('相同绑定checkpoint不应重派模型') })
  assert.equal(replay.partitionSeal?.candidateDigest, result.partitionSeal?.candidateDigest)
  await assert.rejects(elaborateSyncPartitions(input, { ...plan, digest: contentHash('another-nested-plan') }, 2, checkpoints, runner), /局部细化原件没有绑定当前分区分类/)
  await assert.rejects(elaborateSyncPartitions({ ...input, targets: [input.targets[0]] }, { ...plan, partitions: [plan.partitions[0]] }, 2, checkpoints, runner), /冻结父接口分区缺少真实纯父证据/)
  const gamma = result.contracts.find(contract => contract.nodeId === nodes.gamma)!
  assert.ok(gamma.items.some(item => item.kind === 'FLOW' && item.req.includes('REQ-NESTED-GAMMA') && item.req.includes('REQ-NESTED-MIDDLE')))
  assert.ok(gamma.items.some(item => item.kind === 'AC' && item.covers.includes('REQ-NESTED-GAMMA') && item.covers.includes('REQ-NESTED-MIDDLE')))
  assert.ok(!gamma.items.some(item => item.kind === 'AC' && item.covers.includes('RULE-NESTED-ALPHA-POLICY')), 'gamma不强制承接兄弟alpha规则')
  assert.ok(calls.filter(request => request.purpose === 'elaboration_generate' && /:partition:(alpha|gamma):/.test(request.requestKey)).every(request => request.prompt.includes('本叶实际执行的祖先RULE') && request.prompt.includes('TR.rules')))
  const missingAncestor = result.partitionSeal!.changes.map(change => ({ ...change, source: change.path === paths.gamma ? change.source.replaceAll('REQ-NESTED-GAMMA,', '') : change.source }))
  const rejected = sealPartitionedElaboration(input, missingAncestor, result.partitionSeal!.applicability)
  assert.equal(rejected.seal.passed, false, '漏祖先直接承接仍由全局final拒绝')
  assert.ok(rejected.seal.findings.some(finding => finding.code === 'missing-requirement-flow' && finding.itemId === 'REQ-NESTED-GAMMA'))
  for (const file of [paths.gammaSource, paths.oracle]) {
    const files = new Map(input.files!)
    files.delete(file)
    assert.equal(sealPartitionedElaboration({ ...input, files }, result.partitionSeal!.changes, result.partitionSeal!.applicability).seal.passed, false, `${file}缺失仍拒绝`)
  }
  for (const [path, source] of input.files!) assert.equal(readFileSync(join(input.root, path), 'utf8'), source, `${path}原bytes保持`)
  execFileSync(process.execPath, ['--test', paths.oracle], { cwd: input.root, stdio: 'pipe' })
  await t.test('完整sync-v1祖先的可信VERIFY登记在中间seed仍保留', async subtest => {
    const mixed = await nestedInterfaceFixture(subtest), complete = await fixture(subtest)
    const ancestor = complete.input.contracts[0], ancestorSource = complete.input.files.get(ancestor.path)!.replaceAll(ancestor.nodeId, nodes.root)
    writeFileSync(join(mixed.input.root, paths.root), ancestorSource)
    const ancestorFiles = [paths.root, ...complete.plan.partitions[0].readPaths.filter(path => !path.startsWith('.spec/'))]
    for (const path of ancestorFiles.filter(path => path !== paths.root)) {
      mkdirSync(join(mixed.input.root, dirname(path)), { recursive: true })
      writeFileSync(join(mixed.input.root, path), complete.input.files.get(path)!)
    }
    execFileSync('git', ['-C', mixed.input.root, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', mixed.input.root, 'commit', '-m', 'complete ancestor with raw middle'], { stdio: 'pipe' })
    mixed.input.historyInput = await captureInputSnapshot(mixed.input.root)
    mixed.input.base = mixed.input.historyInput.headCommit
    mixed.input.files = new Map(readTree(mixed.input.historyInput.source.commonDir, mixed.input.historyInput.immutableTree).map(entry => [entry.path, readObject(mixed.input.historyInput!.source.commonDir, entry.oid).toString('utf8')]))
    mixed.input.targets = mixed.input.targets.filter(target => [nodes.middle, nodes.gamma].includes(target.nodeId))
    mixed.input.context = [{ nodeId: nodes.root, path: paths.root, source: ancestorSource }]
    mixed.input.intent = { nodeId: nodes.root, rawSource: parseParts(ancestorSource)!.rawSource! }
    mixed.input.verifications = [...mixed.input.verifications!, ...ancestor.items.filter(item => item.kind === 'VERIFY').map(({ id, command, cwd, timeoutMs }) => ({ id, command, cwd, timeoutMs }))]
    mixed.plan.partitions = mixed.plan.partitions.filter(partition => ['middle', 'gamma'].includes(partition.id))
    for (const partition of mixed.plan.partitions) partition.readPaths.push(...ancestorFiles)
    mixed.plan.expectedPaths = [paths.middle, paths.gamma]
    mixed.plan.digest = contentHash('nested-complete-ancestor-plan')
    const fresh: PartitionCheckpoints = { load: () => null, save: (_key, value) => writeEvidence(mixed.input.historyInput!.source.commonDir, value) }
    const requests: ElaborationSessionRequest[] = []
    const result = await elaborateSyncPartitions(mixed.input, mixed.plan, 2, fresh, async request => {
      const ordinal = requests.push(request)
      const frozen = JSON.parse(request.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { targets: { nodeId: string }[] }
      const nodeId = frozen.targets[0].nodeId
      const output = request.purpose === 'elaboration_generate' ? JSON.parse(JSON.stringify(rows(nodeId)).replaceAll('REQ-NESTED-GAMMA', 'REQ-EXPORT-01')) as unknown : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { sessionId: `complete-ancestor-session-${ordinal}`, threadId: `complete-ancestor-thread-${ordinal}`, turnId: 'turn', output, resultDigest: contentHash(JSON.stringify(output)) }
    })
    assert.equal(result.structurePassed, true, JSON.stringify({ failure: result.failure, findings: result.rounds.flatMap(round => round.findings).map(({ code, itemId }) => ({ code, itemId })), seal: result.partitionSeal?.findings }))
    assert.equal(result.reviewPassed, true)
    assert.equal(requests.length, 4)
    assert.equal(result.partitionSeal?.passed, true)
    const seed = requests.find(request => request.requestKey.includes(':partition:middle:') && request.purpose === 'elaboration_generate')!
    const frozen = JSON.parse(seed.prompt.split('冻结业务输入:\n')[1].split('\n')[0]) as { verifications: { id: string }[] }
    assert.ok(frozen.verifications.some(verification => verification.id === 'VERIFY-EXPORT-01'))
    const changeSchema = (seed.schema.properties as { changes: { items: { properties: { tables: { properties: { VERIFY: { maxItems: number } } } } } } }).changes.items.properties
    assert.equal(changeSchema.tables.properties.VERIFY.maxItems, 0, '保留祖先可信登记不授予seed新增VERIFY权')
  })
  await t.test('已独审newNodes为没有冻结seed的中间父提供唯一真实源码后代', async subtest => {
    const discovered = await nestedInterfaceFixture(subtest, true), snapshot = discovered.input.historyInput!
    const digest = contentHash('nested-reviewed-analysis')
    const analysis: CodeBehaviorAnalysis = {
      version: 'code-behavior-v1', inputId: snapshot.id, baselinePairId: null, composedDigest: digest, readSetDigest: digest, policyDigest: digest, inputDigest: digest,
      changes: [], findings: [], facts: [], authorizedChanges: [], nodeChanges: [], resolutions: [],
      newNodes: [{ nodeId: nodes.gamma, path: paths.gamma, rawSource: discovered.input.targets[3].rawSource!, codePath: paths.gammaSource }],
      traces: ['code_behavior_analyze', 'code_behavior_review'].map(purpose => ({ purpose, sessionId: `nested-${purpose}`, threadId: `nested-${purpose}`, turnId: 'turn', resultDigest: digest, inputDigest: digest })), reviewPassed: true,
    }
    discovered.input.analysis = { analysis, ref: writeEvidence(snapshot.source.commonDir, analysis) }
    settled.clear()
    const added = await elaborateSyncPartitions(discovered.input, discovered.plan, 2, discovered.checkpoints, runner)
    assert.equal(added.partitionSeal?.passed, true, JSON.stringify(added.failure))
    assert.equal(added.changes.filter(change => change.path === paths.gamma).length, 1)
    const local = JSON.parse(readEvidence(snapshot.source.commonDir, added.partitionEvidence!.find(evidence => evidence.partitionId === 'middle')!.resultRef).toString('utf8')) as ElaborationResult
    assert.equal(local.phase, 'interface_seed')
    assert.equal(local.partitionBinding?.planDigest, discovered.plan.digest)
    assert.equal(local.partitionBinding?.partitionId, 'middle')
    assert.deepEqual(local.partitionBinding?.analysisRef, discovered.input.analysis.ref)
    assert.deepEqual(local.partitionBinding?.interfaceSeed?.descendants, [{ nodeId: nodes.gamma, path: paths.gamma, codePaths: [paths.gammaSource], sourcePartitionId: 'gamma' }])
    const owner = JSON.parse(readEvidence(snapshot.source.commonDir, added.partitionEvidence!.find(evidence => evidence.partitionId === 'gamma')!.resultRef).toString('utf8')) as ElaborationResult
    assert.deepEqual(owner.changes.map(change => change.path), [paths.gamma], '真实newNode只属于唯一source partition')
    for (const evidence of added.partitionEvidence!.filter(evidence => evidence.partitionId !== 'gamma')) {
      const other = JSON.parse(readEvidence(snapshot.source.commonDir, evidence.resultRef).toString('utf8')) as ElaborationResult
      assert.ok(other.changes.every(change => change.path !== paths.gamma))
    }
    const duplicate = structuredClone(discovered.plan)
    duplicate.partitions.find(partition => partition.id === 'alpha')!.sourcePaths.push(paths.gammaSource)
    await assert.rejects(elaborateSyncPartitions(discovered.input, duplicate, 2, discovered.checkpoints, runner), /精确属于唯一source partition/)
    const absent = structuredClone(discovered.plan)
    absent.partitions.find(partition => partition.id === 'gamma')!.sourcePaths = []
    await assert.rejects(elaborateSyncPartitions(discovered.input, absent, 2, discovered.checkpoints, runner), /精确属于唯一source partition/)
    analysis.reviewPassed = false
    discovered.input.analysis = { analysis, ref: writeEvidence(snapshot.source.commonDir, analysis) }
    await assert.rejects(elaborateSyncPartitions(discovered.input, discovered.plan, 2, discovered.checkpoints, runner), /独审分析绑定/)
  })
  for (const appendRaw of [false, true]) await t.test(appendRaw ? '已有纯接口父raw追加后真实spec→code重新细化' : '已完成四节点树再次全量同步保留全部接口义务', async subtest => {
    const repeated = await nestedInterfaceFixture(subtest)
    for (const change of result.changes) writeFileSync(join(repeated.input.root, change.path), change.source)
    const nextRaw = appendRaw ? `${raw.root} 补充说明：后续同步继续保持现有两个字符串能力的结果。` : raw.root
    if (appendRaw) writeFileSync(join(repeated.input.root, paths.root), readFileSync(join(repeated.input.root, paths.root), 'utf8').replace(raw.root, nextRaw))
    execFileSync('git', ['-C', repeated.input.root, 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repeated.input.root, 'commit', '-m', appendRaw ? 'save completed parent raw' : 'settle complete nested tree'], { stdio: 'pipe' })
    const snapshot = await captureInputSnapshot(repeated.input.root)
    const files = new Map(readTree(snapshot.source.commonDir, snapshot.immutableTree).map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
    const targets = repeated.input.targets.map(target => ({ ...target, source: files.get(target.path)!, sourceDigest: elaborationDigest(files.get(target.path)!), ...(target.nodeId === nodes.root ? { rawSource: nextRaw } : {}) }))
    const repeatInput: ElaborationInput = { ...repeated.input, base: snapshot.headCommit, requestKey: `nested-interface:repeat:${appendRaw}`, intent: { nodeId: nodes.root, rawSource: nextRaw }, historyInput: snapshot, files, targets, implementationWritePaths: appendRaw ? [paths.alphaSource, paths.gammaSource] : [] }
    const contracts = targets.map(target => parseContract({ ...target, source: target.source }).contract!)
    const coordinatorPlan: SyncCoordinatorPlan = { version: 'sync-coordinator-v1', intentNodeId: nodes.root, targets: targets.map(({ nodeId, path }) => ({ nodeId, path })),
      readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec', 'src'], sourcePaths: ['src'], facts: [], verifications: [], mandatoryTests: [] }
    const repeatPlan = planSyncPartitions({ plan: coordinatorPlan, files, contracts, nodes: targets.map(target => ({ id: target.nodeId, path: target.path, rawSource: parseParts(target.source)!.rawSource })), changedPaths: targets.map(target => target.path) })
    const unchanged = targets.map(target => ({ nodeId: target.nodeId, path: target.path, beforeDigest: target.sourceDigest, source: target.source }))
    const baselineSeal = sealPartitionedElaboration(repeatInput, unchanged, applicability)
    assert.equal(baselineSeal.seal.passed, true, JSON.stringify(baselineSeal.seal.findings))
    const rootTarget = targets.find(target => target.nodeId === nodes.root)!
    const localInput: ElaborationInput = { ...repeatInput, targets: [rootTarget], context: [], files: new Map([[paths.root, rootTarget.source]]), validationScope: 'partition_local' }
    let localCalls = 0
    const localRunner = (output: GeneratedTargetElaboration): ElaborationRunner => async request => {
      const ordinal = ++localCalls
      const response = request.purpose === 'elaboration_generate' ? output : { verdict: 'accept', checkedBoundaries: [...ELABORATION_BOUNDARIES], findings: [] }
      return { sessionId: `existing-interface-session-${ordinal}`, threadId: `existing-interface-thread-${ordinal}`, turnId: 'turn', output: response, resultDigest: contentHash(JSON.stringify(response)) }
    }
    const ordinary = await elaborate(localInput, { runner: localRunner(rows(nodes.root) as unknown as GeneratedTargetElaboration) })
    assert.equal(ordinary.structurePassed, false, '相同的合法全图不能令缺子实现正文的局部普通P1冒称完整')
    assert.ok(ordinary.rounds.flatMap(round => round.findings).some(finding => finding.code === 'missing-requirement-flow'))
    settled.clear()
    const rerun = await elaborateSyncPartitions(repeatInput, repeatPlan, 2, repeated.checkpoints, runner)
    assert.equal(rerun.structurePassed, true, JSON.stringify({ failure: rerun.failure, findings: rerun.rounds.flatMap(round => round.findings).map(({ code, itemId }) => ({ code, itemId })), seal: rerun.partitionSeal?.findings }))
    assert.equal(rerun.partitionSeal?.passed, true)
    assert.equal(rerun.reviewPassed, true)
    assert.deepEqual(rerun.contracts.flatMap(contract => contract.items.map(item => item.id)).sort(), contracts.flatMap(contract => contract.items.map(item => item.id)).sort())
    assert.equal(parseParts(rerun.changes.find(change => change.path === paths.root)!.source)!.rawSource, nextRaw)
    for (const path of [paths.alphaSource, paths.gammaSource, paths.oracle]) assert.equal(readFileSync(join(repeatInput.root, path), 'utf8'), files.get(path))
    if (appendRaw) return
    const seedInput: ElaborationInput = { ...localInput, phase: 'interface_seed' }
    const retained = await elaborate(seedInput, { runner: localRunner({ version: 'elaboration-target-rows-v3', changes: [], applicability }) })
    assert.equal(retained.reviewPassed, true, '空行差量保留既有全部父REQ/RULE')
    assert.deepEqual(retained.contracts[0].items.map(item => item.id), contracts.find(contract => contract.nodeId === nodes.root)!.items.map(item => item.id))
    for (const defect of ['reference', 'authority', 'remove', 'source-scope'] as const) {
      const output = rows(nodes.root) as unknown as GeneratedTargetElaboration
      if (defect === 'reference') output.changes[0].tables.REQ[0]['depends-on'] = ['REQ-NONEXISTENT-PARENT']
      if (defect === 'authority') output.changes[0].tables.RULE[0].authority = nodes.middle
      if (defect === 'remove') output.changes[0].removeIds = ['REQ-NESTED-ALPHA']
      if (defect === 'source-scope') output.changes[0].code = [paths.alphaSource]
      const rejected = await elaborate(seedInput, { runner: localRunner(output) })
      assert.equal(rejected.structurePassed, false, defect)
      assert.equal(rejected.reviewPassed, false, defect)
      assert.ok(rejected.rounds.flatMap(round => round.findings).some(finding => finding.code === (defect === 'reference' ? 'dangling-reference' : 'output_schema')), defect)
    }
    const removedWithoutAuthority = unchanged.map(change => ({ ...change, source: change.path === paths.root ? change.source.split('\n').filter(line => !line.startsWith('| RULE-NESTED-ALPHA-POLICY |')).join('\n') : change.source }))
    const rejectedRemoval = sealPartitionedElaboration(repeatInput, removedWithoutAuthority, applicability)
    assert.equal(rejectedRemoval.seal.passed, false)
    assert.ok(rejectedRemoval.seal.findings.some(finding => finding.code === 'protected_item_removed' && finding.itemId === 'RULE-NESTED-ALPHA-POLICY'))
    const retiredInput: ElaborationInput = { ...seedInput, intent: { ...seedInput.intent, rawSource: `${nextRaw} 明确取消重复的RULE-NESTED-ALPHA-POLICY接口条目，其余义务保持。` },
      authorizedChanges: [{ id: 'RULE-NESTED-ALPHA-POLICY', action: 'retire', source: 'user:raw', reason: '用户明确取消该重复接口条目' }] }
    const retireSchema = elaborationSchema(retiredInput, { purpose: 'interface_seed' })
    const removeSchema = (retireSchema.properties as { changes: { items: { properties: { removeIds: { maxItems: number; items: { enum: string[] } } } } } }).changes.items.properties.removeIds
    assert.deepEqual(removeSchema.items.enum, ['RULE-NESTED-ALPHA-POLICY'])
    assert.equal(removeSchema.maxItems, 1)
    const retiredOutput = rows(nodes.root) as unknown as GeneratedTargetElaboration
    retiredOutput.changes[0].tables.RULE = []
    retiredOutput.changes[0].removeIds = ['RULE-NESTED-ALPHA-POLICY']
    const retired = await elaborate(retiredInput, { runner: localRunner(retiredOutput) })
    assert.equal(retired.reviewPassed, true, JSON.stringify(retired.rounds.flatMap(round => round.findings)))
    assert.deepEqual(retired.retiredIds, ['RULE-NESTED-ALPHA-POLICY'])
    assert.ok(retired.contracts[0].items.every(item => item.id !== 'RULE-NESTED-ALPHA-POLICY'))
    await assert.rejects(elaborate({ ...retiredInput, authorizedChanges: [{ id: 'RULE-NESTED-ALPHA-POLICY', action: 'retire', source: 'decision:UNTRUSTED', reason: '伪造来源不能获得退役授权' }] }, { runner: localRunner(retiredOutput) }), /没有可信来源/)
  })
  const completed = completeSyncPartitionPlan(plan, result.contracts, input.files!, { writePaths: [], readonlyPaths: [paths.oracle] })
  const generationInput: GenerationInput = {
    root: input.root, requestKey: 'nested-interface:p2', snapshot: input.historyInput!,
    manifest: { version: 1, entries: readTree(input.historyInput!.source.commonDir, input.historyInput!.immutableTree) }, files: input.files!, contracts: result.contracts,
    elaboratedSpecs: result.changes.map(change => ({ path: change.path, source: change.source })), readyIds: result.readyIds, blockedIds: result.blockedIds, intent: input.intent, facts: [],
    existingAcceptance: result.contracts.flatMap(contract => contract.items.filter((item): item is Acceptance => item.kind === 'AC')), mandatoryTests: [], verifications: input.verifications!,
    allowedScope: { paths: completed.partitions.flatMap(partition => partition.writePaths), contractIds: result.readyIds, flowIds: result.readyFlowIds },
    policy: { version: 'sync-coordinator-v2', digest: 'nested-interface-p2-policy' }, timeoutMs: 30000, model: 'gpt-6.1-sol', effort: 'high',
  }
  for (const specOnly of [true, false]) {
    const nextPlan = structuredClone(completed), runtime = native()
    if (!specOnly) for (const partition of nextPlan.partitions) partition.writePaths.push(...partition.sourcePaths)
    const nextInput = { ...generationInput, requestKey: `nested-interface:p2:${specOnly}`, allowedScope: { ...generationInput.allowedScope, paths: nextPlan.partitions.flatMap(partition => partition.writePaths) } }
    const fresh: PartitionCheckpoints = { load: () => null, save: (_key, value) => writeEvidence(input.historyInput!.source.commonDir, value) }
    const implementationRunner: ElaborationRunner = async request => {
      if (request.purpose === 'code_review') {
        const frozen = JSON.parse(request.prompt.split('冻结原意和基线完整输入:\n')[1].split('\n实际候选身份')[0]) as { files: [string, string][] }
        assert.ok(frozen.files.some(([path]) => path.startsWith('src/')), '实现独审必须读取真实叶源码，不能派给只有父接口的双端')
      }
      return runtime.runner(request)
    }
    const generated = await generateSyncPartitions(nextInput, nextPlan, 2, specOnly, { runner: implementationRunner, validateCandidate: async () => [] }, fresh)
    assert.equal(generated.status, 'reviewed', JSON.stringify(generated.failure))
    assert.equal(runtime.calls.filter(call => call.purpose === 'code_generate').length, specOnly ? 0 : 2, '仅真实子owner可写实现')
    const reviews = runtime.calls.filter(call => call.purpose === 'code_review')
    const selected = implementationPartitionSelection(nextPlan, result.contracts)
    assert.deepEqual([...selected.interfaceParents].sort(), ['middle', 'root'])
    assert.deepEqual(selected.partitions.map(partition => partition.id).sort(), ['alpha', 'gamma'])
    assert.ok(completed.dependencies.some(edge => edge.from === 'middle' && edge.to === 'root'), '纯父接口依赖继续留在真实计划')
    assert.ok(selected.dependencies.every(edge => edge.from !== 'middle' || edge.to !== 'root'), '纯接口依赖不冒称实施边')
    assert.equal(reviews.length, 2 + selected.dependencies.length, '两个真实子owner与全部真实实施边独审')
    assert.deepEqual(generated.partitionEvidence!.filter(evidence => evidence.partitionId.startsWith('edge:')).map(evidence => evidence.partitionId).sort(), selected.dependencies.map(edge => `edge:${edge.from}:${edge.to}`).sort())
    const checkedIds = new Set(generated.partitionEvidence!.flatMap(evidence => evidence.review.checkedIds))
    assert.ok(result.readyIds.every(id => checkedIds.has(id)), '跳过纯接口实施审查后，真实独审并集仍完整承接所有ready ID')
    const pendingCode = result.contracts.map(contract => ({ ...contract, code: contract.nodeId === nodes.gamma ? [] : contract.code }))
    assert.ok(implementationPartitionSelection(nextPlan, pendingCode).partitions.some(partition => partition.id === 'gamma'), '没有当前code但具完整业务流程的新叶仍需真实文件规划与实施')
    assert.ok(reviews.every(call => !/:final:(root|middle)$/.test(call.requestKey)))
    assert.equal(new Set(generated.partitionEvidence!.map(evidence => evidence.candidateDigest)).size, 1)
    const entries = verifyCandidate(input.historyInput!.source.commonDir, generated.candidate!)
    for (const path of [paths.root, paths.middle]) assert.equal(readObject(input.historyInput!.source.commonDir, entries.find(entry => entry.path === path)!.oid).toString('utf8'), result.changes.find(change => change.path === path)!.source, '双向P2均原文装配两级已审父接口')
    if (specOnly) for (const path of [paths.alphaSource, paths.gammaSource, paths.oracle]) assert.equal(entries.find(entry => entry.path === path)!.oid, generationInput.manifest.entries.find(entry => entry.path === path)!.oid, 'code→spec的source/test Git对象不变')
  }
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
  const dispatch = implementationGenerationDispatch(input, plan, false)
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
  assert.deepEqual([...dispatch.requiredKeys].sort(), calls.map(call => call.requestKey).sort(), '文件writer扩充只增加读取/写路径，不改变真实派发业务集合')
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
  const dispatch = implementationGenerationDispatch(input, plan, false)
  assert.ok(dispatch.locals.find(local => local.partition.id === 'part-export')!.input.readyIds.includes('AC-EXPORT-03'))
  assert.ok(dispatch.reviews.find(local => local.id.startsWith('edge:'))!.input.readyIds.includes('AC-EXPORT-03'), '历史退役义务仍由同一真实owner投影进入跨边独审及预算')
  assert.deepEqual(dispatch.planningIds, [])
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
