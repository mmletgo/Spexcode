import assert from 'node:assert/strict'
import test from 'node:test'
import type { Contract } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { planSyncPartitions, projectSyncPartition } from './partitioning.js'

const rootPath = '.spec/project/spec.md'
const alphaPath = '.spec/project/services/alpha/spec.md'
const betaPath = '.spec/project/services/beta/spec.md'
const gammaPath = '.spec/project/api/gamma/spec.md'

function contract(nodeId: string, path: string, code: string[], items: Contract['items'] = []): Contract {
  return { schema: 'sync-v1', nodeId, path, rawSource: `${nodeId} intent`, expandedSpec: `${nodeId} contract`, code, related: [], items }
}

function requirement(id: string, nodeId: string, path: string, dependsOn: string[] = []): Contract['items'][number] {
  return { kind: 'REQ', id, nodeId, path, line: 1, source: { kind: 'user', ref: 'raw' }, dependsOn, goal: id, constraints: '', success: id }
}

function acceptance(id: string, nodeId: string, path: string, test: string): Contract['items'][number] {
  return { kind: 'AC', id, nodeId, path, line: 2, source: { kind: 'user', ref: 'raw' }, dependsOn: [], covers: [], preconditions: '', action: 'run', assertion: 'passes', test, command: 'VERIFY-LOCAL' }
}

function rawSpec(id: string, code: string[], related: string[] = []): string {
  const rows = (name: string, values: string[]): string[] => [name + ':', ...values.map(value => `  - ${value}`)]
  return [
    '---', `title: ${id}`, 'status: active', ...rows('code', code), ...rows('related', related), '---',
    `# ${id}`, '', '## raw source', '', `${id} 的原始需求。`,
  ].join('\n')
}

function plan(): SyncCoordinatorPlan {
  return {
    version: 'sync-coordinator-v1', intentNodeId: 'root',
    targets: [
      { nodeId: 'alpha', path: alphaPath },
      { nodeId: 'beta', path: betaPath },
      { nodeId: 'gamma', path: gammaPath },
    ],
    readPaths: ['.spec', 'src', 'tests', '.spec/spexcode.json'],
    writePaths: ['.spec/project', 'src', 'tests'],
    sourcePaths: ['src'],
    executionScope: { paths: [alphaPath, betaPath, gammaPath, 'src/services/new.ts', 'src/api/gamma.ts', 'src/unowned/orphan.ts'], contractIds: ['REQ-ALPHA', 'AC-ALPHA', 'REQ-BETA', 'REQ-GAMMA', 'AC-GAMMA'], flowIds: [] },
    facts: [{ source: 'user:raw', text: '保留用户原意' }],
    verifications: [],
    mandatoryTests: [
      { verificationId: 'VERIFY-LOCAL', testPath: 'tests/gamma.test.ts', testId: 'GAMMA-1' },
      { verificationId: 'VERIFY-GLOBAL', testPath: 'tests/all.test.ts', testId: 'ALL-1' },
    ],
  }
}

function fixture(): { files: Map<string, string>; contracts: Contract[]; plan: SyncCoordinatorPlan; changedPaths: string[] } {
  const contracts = [
    contract('root', rootPath, []),
    contract('alpha', alphaPath, ['src/services/*'], [requirement('REQ-ALPHA', 'alpha', alphaPath), acceptance('AC-ALPHA', 'alpha', alphaPath, 'tests/alpha.test.ts#ALPHA-1')]),
    contract('beta', betaPath, ['src/services/new.ts#helper'], [requirement('REQ-BETA', 'beta', betaPath)]),
    contract('gamma', gammaPath, ['src/api/gamma.ts#run'], [requirement('REQ-GAMMA', 'gamma', gammaPath, ['REQ-BETA']), acceptance('AC-GAMMA', 'gamma', gammaPath, 'tests/gamma.test.ts#GAMMA-1')]),
  ]
  const files = new Map<string, string>([
    [rootPath, 'root intent'], [alphaPath, 'alpha spec'], [betaPath, 'beta spec'], [gammaPath, 'gamma spec'],
    ['.spec/spexcode.json', '{}'], ['src/services/new.ts', 'export const helper = 1'],
    ['src/api/gamma.ts', 'export const run = () => true'], ['src/unowned/orphan.ts', 'export const orphan = 1'],
    ['tests/alpha.test.ts', 'test alpha'], ['tests/gamma.test.ts', 'test gamma'], ['tests/all.test.ts', 'global test'],
    ['docs/unrelated.md', 'unrelated'],
  ])
  return { files, contracts, plan: plan(), changedPaths: ['tests/gamma.test.ts', 'src/unowned/orphan.ts', 'src/api/gamma.ts', 'src/services/new.ts'] }
}

test('shared code writers merge; changed paths are covered once and unowned paths stay visible', () => {
  const input = fixture(), originalPlan = structuredClone(input.plan), originalFiles = [...input.files], originalContracts = structuredClone(input.contracts)
  const result = planSyncPartitions(input)
  const coverage = result.partitions.flatMap(partition => partition.changedPaths)
  assert.deepEqual(coverage.sort(), [...new Set(input.changedPaths)].sort())
  assert.equal(new Set(coverage).size, coverage.length)
  assert.ok(result.partitions.every(partition => partition.readPaths.length < input.files.size))
  const writeCounts = result.partitions.flatMap(partition => partition.writePaths).reduce((counts, path) => counts.set(path, (counts.get(path) ?? 0) + 1), new Map<string, number>())
  assert.ok([...writeCounts.values()].every(count => count === 1))
  assert.deepEqual(result.expectedPaths, [...new Set(input.changedPaths)].sort())
  const shared = result.partitions.find(partition => partition.changedPaths.includes('src/services/new.ts'))!
  assert.deepEqual(shared.targets.map(target => target.nodeId), ['alpha', 'beta'])
  const discovery = result.partitions.find(partition => partition.changedPaths.includes('src/unowned/orphan.ts'))!
  assert.deepEqual(discovery.targets, [])
  assert.ok(discovery.contextNodeIds.length > 0)
  assert.deepEqual(input.plan, originalPlan)
  assert.deepEqual([...input.files], originalFiles)
  assert.deepEqual(input.contracts, originalContracts)
})

test('dependencies add the upstream spec as read-only context and create a directed cross-partition edge', () => {
  const input = fixture(), result = planSyncPartitions(input)
  const gamma = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'gamma'))!
  const shared = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'beta'))!
  assert.ok(gamma.readPaths.includes(betaPath))
  assert.ok(gamma.contextNodeIds.includes('beta'))
  assert.ok(!gamma.targets.some(target => target.nodeId === 'beta'))
  assert.deepEqual(result.dependencies, [{ from: gamma.id, to: shared.id, contractIds: ['REQ-BETA', 'REQ-GAMMA'], paths: [gammaPath, betaPath, 'src/api/gamma.ts', 'src/services/new.ts'] }])
})

test('projection keeps the root intent read-only and narrows targets, writes, sources, and mandatory tests', () => {
  const input = fixture(), result = planSyncPartitions(input)
  const gamma = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'gamma'))!
  const projected = projectSyncPartition(input.plan, gamma)
  assert.equal(projected.intentNodeId, 'root')
  assert.ok(projected.readPaths.includes(rootPath))
  assert.ok(!projected.targets.some(target => target.nodeId === 'root'))
  assert.deepEqual(projected.targets.map(target => target.nodeId), ['gamma'])
  assert.ok(projected.writePaths.includes(gammaPath))
  assert.ok(projected.writePaths.includes('src/api/gamma.ts'))
  assert.ok(!projected.writePaths.includes(rootPath))
  assert.deepEqual(projected.sourcePaths, ['src/api/gamma.ts'])
  assert.deepEqual(projected.mandatoryTests.map(test => test.testId), ['GAMMA-1'])
  assert.deepEqual(projected.executionScope, { paths: [gammaPath, 'src/api/gamma.ts'], contractIds: ['AC-GAMMA', 'REQ-GAMMA'], flowIds: [] })
  assert.ok(!projected.readPaths.includes('src/unowned/orphan.ts'))
  assert.ok(!projected.readPaths.includes('tests/alpha.test.ts'))
  assert.ok(!projected.readPaths.includes('tests/all.test.ts'))
  assert.ok(!projected.readPaths.includes('docs/unrelated.md'))
})

test('input ordering does not affect digest', () => {
  const input = fixture()
  const normal = planSyncPartitions(input)
  const reordered = planSyncPartitions({
    ...input,
    plan: { ...input.plan, targets: [...input.plan.targets].reverse(), readPaths: [...input.plan.readPaths].reverse(), writePaths: [...input.plan.writePaths].reverse(), sourcePaths: [...input.plan.sourcePaths ?? []].reverse(), mandatoryTests: [...input.plan.mandatoryTests].reverse() },
    files: new Map([...input.files].reverse()), contracts: [...input.contracts].reverse(), changedPaths: [...input.changedPaths].reverse(),
  })
  assert.equal(reordered.digest, normal.digest)
  assert.deepEqual(reordered.partitions, normal.partitions)
})

test('UTF-8 byte accounting deduplicates identical bodies instead of using JS string length', () => {
  const body = '雪'
  const pathA = 'src/one.ts', pathB = 'src/two.ts'
  const node = contract('one', '.spec/project/one/spec.md', [pathA, pathB])
  const files = new Map([[node.path, 's'], ['.spec/project/spec.md', 'r'], [pathA, body], [pathB, body], ['.spec/spexcode.json', '{}']])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'one', targets: [{ nodeId: 'one', path: node.path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/project', 'src'], sourcePaths: ['src'], mandatoryTests: [] },
    files, contracts: [node], changedPaths: [pathA, pathB],
  })
  const partition = result.partitions[0]
  assert.equal(partition.readBytes, Buffer.byteLength('s', 'utf8') + Buffer.byteLength('r', 'utf8') + Buffer.byteLength(body, 'utf8') + Buffer.byteLength('{}', 'utf8'))
  assert.equal(Buffer.byteLength(body, 'utf8'), 3)
})

test('a whole oversized body stays intact in its own explicit budget report', () => {
  const path = 'src/large.ts', body = '雪'.repeat(8)
  const node = contract('large', '.spec/project/large/spec.md', [path])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'large', targets: [{ nodeId: 'large', path: node.path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/project', 'src'], sourcePaths: ['src'], mandatoryTests: [] },
    files: new Map([[node.path, 'spec'], ['.spec/project/spec.md', 'root'], [path, body]]), contracts: [node], changedPaths: [path], maxReadBytes: 10,
  })
  const partition = result.partitions[0]
  assert.deepEqual(partition.oversizedReads, [{ path, bytes: Buffer.byteLength(body, 'utf8'), limitBytes: 10 }])
  assert.ok(partition.readPaths.includes(path))
  assert.equal(partition.readBytes, Buffer.byteLength('spec', 'utf8') + Buffer.byteLength('root', 'utf8') + Buffer.byteLength(body, 'utf8'))
})

test('historical read estimates count when a deleted path has no composed body', () => {
  const path = 'src/removed.ts', node = contract('removed', '.spec/project/removed/spec.md', [path])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'removed', targets: [{ nodeId: 'removed', path: node.path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/project', 'src'], sourcePaths: ['src'], mandatoryTests: [] },
    files: new Map([[node.path, 'spec'], ['.spec/project/spec.md', 'root']]), contracts: [node], changedPaths: [path], readByteSizes: new Map([[path, 48]]), maxReadBytes: 100,
  })
  assert.equal(result.partitions[0].readBytes, Buffer.byteLength('spec', 'utf8') + Buffer.byteLength('root', 'utf8') + 48)
})

test('unowned same-directory paths split into byte-bounded discovery groups', () => {
  const files = new Map<string, string>([
    [rootPath, 'r1'], ['.spec/spexcode.json', 'c1'],
    ['src/new/one.ts', '1111'], ['src/new/two.ts', '2222'], ['src/new/three.ts', '3333'],
  ])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'root', targets: [{ nodeId: 'root', path: rootPath }], readPaths: ['.spec', 'src'], writePaths: [rootPath, 'src'], sourcePaths: ['src'], mandatoryTests: [] },
    files, contracts: [], changedPaths: ['src/new/one.ts', 'src/new/two.ts', 'src/new/three.ts'], maxReadBytes: 10,
  })
  assert.equal(result.partitions.length, 3)
  assert.ok(result.partitions.every(partition => partition.targets.length === 0 && partition.readBytes <= partition.readLimitBytes))
  assert.deepEqual(result.partitions.flatMap(partition => partition.changedPaths).sort(), ['src/new/one.ts', 'src/new/three.ts', 'src/new/two.ts'])
  assert.ok(result.partitions.every(partition => partition.contextNodeIds.includes('root')))
})

test('an indivisible shared target remains combined when its total context exceeds budget', () => {
  const path = 'src/shared/one.ts', secondPath = 'src/shared/two.ts'
  const node = contract('shared', '.spec/project/shared/spec.md', [path, secondPath])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'shared', targets: [{ nodeId: 'shared', path: node.path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/project', 'src'], sourcePaths: ['src'], mandatoryTests: [] },
    files: new Map([[node.path, 'spec'], [path, '1111'], [secondPath, '2222']]), contracts: [node], changedPaths: [path, secondPath], maxReadBytes: 10,
  })
  assert.equal(result.partitions.length, 1)
  assert.equal(result.partitions[0].readBytes, Buffer.byteLength('spec', 'utf8') + 8)
  assert.ok(result.partitions[0].readBytes > result.partitions[0].readLimitBytes)
})

test('a Spec-only save retains source write authority and all affected downstream targets', () => {
  const input = fixture()
  const result = planSyncPartitions({ ...input, changedPaths: [alphaPath] })
  assert.deepEqual(result.partitions.flatMap(partition => partition.targets.map(target => target.nodeId)).sort(), ['alpha', 'beta', 'gamma'])
  const alpha = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'alpha'))!
  assert.ok(alpha.writePaths.includes('src/services/new.ts'))
  assert.ok(alpha.targets.some(target => target.nodeId === 'beta'), 'two potential writers of unchanged source must share one partition')
  const gamma = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'gamma'))!
  assert.ok(gamma.writePaths.includes('src/api/gamma.ts'))
  assert.ok(!gamma.writePaths.includes('tests/gamma.test.ts'), 'mandatory oracle stays read-only even in broad global test scope')
})

test('directory execution authority narrows to concrete local files instead of disappearing', () => {
  const input = fixture()
  input.plan.executionScope!.paths = ['.spec/project', 'src']
  const result = planSyncPartitions({ ...input, changedPaths: [gammaPath] })
  const gamma = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'gamma'))!
  const projected = projectSyncPartition(input.plan, gamma)
  assert.deepEqual(projected.executionScope!.paths, [gammaPath, 'src/api/gamma.ts'])
  assert.ok(!projected.executionScope!.paths.includes('src'))
})

test('unrelated code facts are excluded while literal shared intent remains', () => {
  const input = fixture()
  input.files.set('src/ignored/unused.ts', 'export const unused = true')
  input.plan.facts = [...input.plan.facts, { source: 'code:src/ignored/unused.ts#unused', text: 'unrelated implementation fact' }]
  const result = planSyncPartitions(input)
  const gamma = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'gamma'))!
  assert.deepEqual(projectSyncPartition(input.plan, gamma).facts, [{ source: 'user:raw', text: '保留用户原意' }])
})

test('identical current bytes do not collapse distinct per-path historical estimates', () => {
  const pathA = 'src/a.ts', pathB = 'src/b.ts', node = contract('both', alphaPath, [pathA, pathB])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'both', targets: [{ nodeId: 'both', path: alphaPath }], executionScope: undefined, mandatoryTests: [] },
    files: new Map([[alphaPath, 'spec'], [pathA, 'same'], [pathB, 'same']]), contracts: [node], changedPaths: [pathA, pathB],
    readByteSizes: new Map([[pathA, 12], [pathB, 24]]),
  })
  assert.equal(result.partitions[0].readBytes, Buffer.byteLength('spec') + 12 + 24)
})

test('raw-only Spec governance assigns leaf writers and keeps raw ancestors read-only', () => {
  const rawRootPath = '.spec/raw-project/spec.md'
  const rawAlphaPath = '.spec/raw-project/alpha/spec.md'
  const rawBetaPath = '.spec/raw-project/beta/spec.md'
  const nodes = [
    { id: 'raw-root', path: rawRootPath },
    { id: 'raw-alpha', path: rawAlphaPath },
    { id: 'raw-beta', path: rawBetaPath },
  ]
  const files = new Map<string, string>([
    [rawRootPath, rawSpec('raw-root', [], ['src/shared/root-context.ts'])],
    [rawAlphaPath, rawSpec('raw-alpha', ['src/raw/alpha.ts'], ['src/shared/common.ts'])],
    [rawBetaPath, rawSpec('raw-beta', ['src/raw/beta.ts'], ['src/shared/common.ts'])],
    ['src/raw/alpha.ts', 'export const alpha = true'], ['src/raw/beta.ts', 'export const beta = true'],
    ['src/raw/orphan.ts', 'export const orphan = true'], ['src/shared/common.ts', 'export const common = true'],
    ['src/shared/root-context.ts', 'export const rootContext = true'],
    ['src/unrelated/global.ts', 'export const unrelated = true'], ['tests/oracle.test.ts', 'test oracle'],
  ])
  const globalPlan: SyncCoordinatorPlan = {
    version: 'sync-coordinator-v1', intentNodeId: 'raw-root',
    targets: nodes.map(node => ({ nodeId: node.id, path: node.path })),
    readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec/raw-project', 'src', 'tests'], sourcePaths: ['src'],
    executionScope: { paths: ['.spec/raw-project', 'src', 'tests'], contractIds: [], flowIds: [] },
    facts: [{ source: 'user:raw', text: '根原意保持只读' }], verifications: [],
    mandatoryTests: [{ verificationId: 'VERIFY-RAW', testPath: 'tests/oracle.test.ts', testId: 'ORACLE-1' }],
  }
  const result = planSyncPartitions({ plan: globalPlan, files, contracts: [], nodes, changedPaths: [rawAlphaPath] })
  const alpha = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'raw-alpha'))!
  const beta = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'raw-beta'))!
  assert.ok(alpha.writePaths.includes('src/raw/alpha.ts'))
  assert.ok(alpha.readPaths.includes('src/raw/alpha.ts'))
  assert.ok(alpha.readPaths.includes('src/shared/common.ts'))
  assert.ok(alpha.readPaths.includes('src/shared/root-context.ts'), 'raw ancestor related is read-only context')
  assert.ok(!alpha.readPaths.includes('src/raw/beta.ts'))
  assert.ok(!alpha.readPaths.includes('src/unrelated/global.ts'))
  assert.ok(alpha.contextNodeIds.includes('raw-root'))
  assert.ok(beta.writePaths.includes('src/raw/beta.ts'))
  assert.ok(!beta.writePaths.includes('src/raw/alpha.ts'))
  assert.ok(beta.contextNodeIds.includes('raw-root'))
  assert.ok(!result.partitions.some(partition => partition.targets.some(target => target.nodeId === 'raw-root')))
  assert.deepEqual(result.expectedPaths, [rawAlphaPath])
})

test('raw-only unowned sources discover the nearest provided node identity instead of defaulting to root', () => {
  const rawRootPath = '.spec/raw-project/spec.md'
  const rawAlphaPath = '.spec/raw-project/alpha/spec.md'
  const rawBetaPath = '.spec/raw-project/beta/spec.md'
  const nodes = [
    { id: 'raw-root', path: rawRootPath },
    { id: 'raw-alpha', path: rawAlphaPath },
    { id: 'raw-beta', path: rawBetaPath },
  ]
  const files = new Map<string, string>([
    [rawRootPath, rawSpec('raw-root', [], ['src/shared/root-context.ts'])],
    [rawAlphaPath, rawSpec('raw-alpha', ['src/raw/alpha.ts'], ['src/shared/common.ts'])],
    [rawBetaPath, rawSpec('raw-beta', ['src/raw/beta.ts'], ['src/shared/common.ts'])],
    ['src/raw/alpha.ts', 'alpha'], ['src/raw/beta.ts', 'beta'],
    ['src/raw/orphan.ts', 'orphan'], ['src/shared/common.ts', 'shared'], ['src/shared/root-context.ts', 'root context'],
  ])
  const input = {
    plan: { ...plan(), intentNodeId: 'raw-root', targets: nodes.map(node => ({ nodeId: node.id, path: node.path })), readPaths: ['.spec', 'src'], writePaths: ['.spec/raw-project', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files, contracts: [], nodes, changedPaths: ['src/raw/orphan.ts'],
  }
  const result = planSyncPartitions(input)
  const discovery = result.partitions.find(partition => partition.changedPaths.includes('src/raw/orphan.ts'))!
  assert.deepEqual(discovery.targets, [])
  assert.ok(discovery.contextNodeIds.includes('raw-alpha'))
  assert.ok(discovery.contextNodeIds.includes('raw-root'))
  assert.ok(!discovery.contextNodeIds.includes('raw-beta'))
  assert.ok(discovery.readPaths.includes('src/shared/common.ts'))
  assert.ok(!discovery.readPaths.includes('src/raw/beta.ts'))
})

test('target frontmatter is recovered from files even when callers omit nodes and contracts', () => {
  const path = '.spec/raw-project/leaf/spec.md'
  const files = new Map([[path, rawSpec('raw-leaf', ['src/raw/leaf.ts'])], ['src/raw/leaf.ts', 'export const leaf = true']])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'raw-leaf', targets: [{ nodeId: 'raw-leaf', path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/raw-project', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files, contracts: [], changedPaths: [path],
  })
  assert.ok(result.partitions[0].writePaths.includes('src/raw/leaf.ts'))
  assert.ok(result.partitions[0].readPaths.includes('src/raw/leaf.ts'))
})
