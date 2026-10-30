import assert from 'node:assert/strict'
import test from 'node:test'
import { parseContract } from '@spexcode/spec-core/contracts'
import type { Contract } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import { planSyncPartitions, projectSyncPartition, rawOnlyInterfaceSeedEvidence } from './partitioning.js'

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
  const rawAlphaPath = '.spec/raw-project/module-alpha/alpha/spec.md'
  const rawBetaPath = '.spec/raw-project/module-beta/beta/spec.md'
  const nodes = [
    { id: 'raw-root', path: rawRootPath },
    { id: 'raw-alpha', path: rawAlphaPath },
    { id: 'raw-beta', path: rawBetaPath },
  ]
  const files = new Map<string, string>([
    [rawRootPath, rawSpec('raw-root', [])],
    [rawAlphaPath, rawSpec('raw-alpha', ['src/raw/alpha.ts'], ['src/shared/common.ts'])],
    [rawBetaPath, rawSpec('raw-beta', ['src/raw/beta.ts'], ['src/shared/common.ts'])],
    ['src/raw/alpha.ts', 'export const alpha = true'], ['src/raw/beta.ts', 'export const beta = true'],
    ['src/raw/orphan.ts', 'export const orphan = true'], ['src/shared/common.ts', 'export const common = true'],
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
  const root = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'raw-root'))!
  const alpha = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'raw-alpha'))!
  const beta = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'raw-beta'))!
  assert.deepEqual(root.writePaths, [rawRootPath])
  assert.deepEqual(root.readPaths, [rawRootPath])
  assert.ok(alpha.writePaths.includes('src/raw/alpha.ts'))
  assert.ok(alpha.readPaths.includes('src/raw/alpha.ts'))
  assert.ok(alpha.readPaths.includes('src/shared/common.ts'))
  assert.ok(!alpha.readPaths.includes('src/raw/beta.ts'))
  assert.ok(!alpha.readPaths.includes('src/unrelated/global.ts'))
  assert.ok(alpha.contextNodeIds.includes('raw-root'))
  assert.ok(beta.writePaths.includes('src/raw/beta.ts'))
  assert.ok(!beta.writePaths.includes('src/raw/alpha.ts'))
  assert.ok(beta.contextNodeIds.includes('raw-root'))
  assert.deepEqual(result.expectedPaths, [rawAlphaPath])
})

test('raw-only unowned sources discover the nearest provided node identity instead of defaulting to root', () => {
  const rawRootPath = '.spec/raw-project/spec.md'
  const rawAlphaPath = '.spec/raw-project/module-alpha/alpha/spec.md'
  const rawBetaPath = '.spec/raw-project/module-beta/beta/spec.md'
  const nodes = [
    { id: 'raw-root', path: rawRootPath },
    { id: 'raw-alpha', path: rawAlphaPath },
    { id: 'raw-beta', path: rawBetaPath },
  ]
  const files = new Map<string, string>([
    [rawRootPath, rawSpec('raw-root', [])],
    [rawAlphaPath, rawSpec('raw-alpha', ['src/raw/alpha.ts'], ['src/shared/common.ts'])],
    [rawBetaPath, rawSpec('raw-beta', ['src/raw/beta.ts'], ['src/shared/common.ts'])],
    ['src/raw/alpha.ts', 'alpha'], ['src/raw/beta.ts', 'beta'],
    ['src/raw/orphan.ts', 'orphan'], ['src/shared/common.ts', 'shared'],
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
    plan: { ...plan(), intentNodeId: 'upstream-intent', targets: [{ nodeId: 'raw-leaf', path }], readPaths: ['.spec', 'src'], writePaths: ['.spec/raw-project', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files, contracts: [], changedPaths: [path],
  })
  assert.ok(result.partitions[0].writePaths.includes('src/raw/leaf.ts'))
  assert.ok(result.partitions[0].readPaths.includes('src/raw/leaf.ts'))
})

test('ordinary contract dependencies retain spec and ID context but defer implementation reads to cross-edge review', () => {
  const root = contract('root', rootPath, [], [requirement('REQ-ROOT', 'root', rootPath, ['REQ-LEAF-A', 'REQ-LEAF-B'])])
  const leafAPath = '.spec/project/services/leaf-a/spec.md', leafBPath = '.spec/project/api/leaf-b/spec.md'
  const leafA = contract('leaf-a', leafAPath, ['src/leaf-a.ts'], [requirement('REQ-LEAF-A', 'leaf-a', leafAPath), acceptance('AC-LEAF-A', 'leaf-a', leafAPath, 'tests/leaf-a.test.ts#A-1')])
  const leafB = contract('leaf-b', leafBPath, ['src/leaf-b.ts'], [requirement('REQ-LEAF-B', 'leaf-b', leafBPath), acceptance('AC-LEAF-B', 'leaf-b', leafBPath, 'tests/leaf-b.test.ts#B-1')])
  const files = new Map<string, string>([
    [rootPath, 'root spec'], [leafAPath, 'leaf a spec'], [leafBPath, 'leaf b spec'],
    ['src/leaf-a.ts', 'leaf a implementation'], ['src/leaf-b.ts', 'leaf b implementation'],
    ['tests/leaf-a.test.ts', 'leaf a oracle'], ['tests/leaf-b.test.ts', 'leaf b oracle'],
  ])
  const inputPlan: SyncCoordinatorPlan = {
    ...plan(), intentNodeId: 'root', targets: [root, leafA, leafB].map(item => ({ nodeId: item.nodeId, path: item.path })),
    readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec/project', 'src', 'tests'], sourcePaths: ['src'],
    executionScope: { paths: ['.spec/project', 'src', 'tests'], contractIds: ['REQ-ROOT', 'REQ-LEAF-A', 'AC-LEAF-A', 'REQ-LEAF-B', 'AC-LEAF-B'], flowIds: [] },
    mandatoryTests: [
      { verificationId: 'VERIFY-A', testPath: 'tests/leaf-a.test.ts', testId: 'A-1' },
      { verificationId: 'VERIFY-B', testPath: 'tests/leaf-b.test.ts', testId: 'B-1' },
    ],
  }
  const result = planSyncPartitions({ plan: inputPlan, files, contracts: [root, leafA, leafB], changedPaths: [rootPath] })
  const rootPartition = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'root'))!
  const leafAPartition = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'leaf-a'))!
  const leafBPartition = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'leaf-b'))!
  assert.ok(rootPartition.readPaths.includes(leafAPath) && rootPartition.readPaths.includes(leafBPath), 'dependency Specs provide the read-only ID interface')
  assert.ok(!rootPartition.readPaths.includes('src/leaf-a.ts') && !rootPartition.readPaths.includes('src/leaf-b.ts'))
  assert.ok(!rootPartition.readPaths.includes('tests/leaf-a.test.ts') && !rootPartition.readPaths.includes('tests/leaf-b.test.ts'))
  assert.ok(leafAPartition.readPaths.includes('src/leaf-a.ts') && !leafAPartition.readPaths.includes('src/leaf-b.ts'))
  assert.ok(leafBPartition.readPaths.includes('src/leaf-b.ts') && !leafBPartition.readPaths.includes('src/leaf-a.ts'))
  assert.ok(result.dependencies.some(edge => edge.from === rootPartition.id && edge.to === leafAPartition.id && edge.paths.includes('src/leaf-a.ts')))
  assert.ok(result.dependencies.some(edge => edge.from === rootPartition.id && edge.to === leafBPartition.id && edge.paths.includes('src/leaf-b.ts')))
  const detailedNoop = planSyncPartitions({ plan: inputPlan, files, contracts: [root, leafA, leafB], changedPaths: [] })
  assert.ok(!detailedNoop.partitions.some(partition => partition.targets.some(target => target.nodeId === 'root')), 'an unchanged Contract-backed intent is not repeated as a seed')
})

test('a raw intent target gets one Spec-only seed partition before raw-only leaf work', () => {
  const rawRootPath = '.spec/raw-seed/spec.md'
  const rawAlphaPath = '.spec/raw-seed/module-alpha/alpha/spec.md'
  const rawBetaPath = '.spec/raw-seed/module-beta/beta/spec.md'
  const nodes = [
    { id: 'seed-root', path: rawRootPath },
    { id: 'seed-alpha', path: rawAlphaPath },
    { id: 'seed-beta', path: rawBetaPath },
  ]
  const files = new Map<string, string>([
    [rawRootPath, rawSpec('seed-root', [], ['src/leaf-alpha.ts', 'src/leaf-beta.ts'])],
    [rawAlphaPath, rawSpec('seed-alpha', ['src/leaf-alpha.ts'])],
    [rawBetaPath, rawSpec('seed-beta', ['src/leaf-beta.ts'])],
    ['src/leaf-alpha.ts', 'alpha implementation'], ['src/leaf-beta.ts', 'beta implementation'],
  ])
  const result = planSyncPartitions({
    plan: {
      ...plan(), intentNodeId: 'seed-root', targets: nodes.map(node => ({ nodeId: node.id, path: node.path })),
      readPaths: ['.spec', 'src'], writePaths: ['.spec/raw-seed', 'src'], sourcePaths: ['src'],
      executionScope: { paths: ['.spec/raw-seed', 'src'], contractIds: [], flowIds: [] }, mandatoryTests: [],
    },
    files, contracts: [], nodes, changedPaths: [],
  })
  const rootPartitions = result.partitions.filter(partition => partition.targets.some(target => target.nodeId === 'seed-root'))
  const alpha = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'seed-alpha'))!
  const beta = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'seed-beta'))!
  assert.equal(rootPartitions.length, 1)
  assert.deepEqual(rootPartitions[0].writePaths, [rawRootPath])
  assert.deepEqual(rootPartitions[0].readPaths, [rawRootPath])
  assert.ok(alpha.writePaths.includes('src/leaf-alpha.ts') && alpha.readPaths.includes('src/leaf-alpha.ts'))
  assert.ok(!alpha.writePaths.includes('src/leaf-beta.ts') && !alpha.readPaths.includes('src/leaf-beta.ts'))
  assert.ok(beta.writePaths.includes('src/leaf-beta.ts') && beta.readPaths.includes('src/leaf-beta.ts'))
  assert.ok(!beta.writePaths.includes('src/leaf-alpha.ts') && !beta.readPaths.includes('src/leaf-alpha.ts'))
})

test('nested raw-only parents get isolated interface seeds while same-bucket childless concepts still batch', () => {
  const rootPath = '.spec/interface-project/spec.md'
  const parentPath = '.spec/interface-project/controller/spec.md'
  const sourcedLeafPath = '.spec/interface-project/controller/device/spec.md'
  const childlessPaths = ['.spec/interface-project/device/spec.md', '.spec/interface-project/web/spec.md']
  const nodes = [
    { id: 'interface-project', path: rootPath }, { id: 'controller', path: parentPath },
    { id: 'controller-device', path: sourcedLeafPath }, ...childlessPaths.map((path, index) => ({ id: index ? 'web' : 'device', path })),
  ]
  const targets = nodes.map(node => ({ nodeId: node.id, path: node.path, rawSource: '' }))
  const files = new Map<string, string>([
    [rootPath, rawSpec('interface-project', [])], [parentPath, rawSpec('controller', [])],
    [sourcedLeafPath, rawSpec('controller-device', ['src/controller/device.ts'])],
    [childlessPaths[0], rawSpec('device', [])], [childlessPaths[1], rawSpec('web', [])],
    ['src/controller/device.ts', 'export const device = true'],
  ])
  const inputPlan: SyncCoordinatorPlan = {
    ...plan(), intentNodeId: 'interface-project', targets, readPaths: ['.spec', 'src'],
    writePaths: ['.spec/interface-project', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [],
  }
  const result = planSyncPartitions({ plan: inputPlan, files, contracts: [], nodes, changedPaths: [] })
  const partitionFor = (nodeId: string) => result.partitions.find(partition => partition.targets.some(target => target.nodeId === nodeId))!
  const root = partitionFor('interface-project'), parent = partitionFor('controller'), leaf = partitionFor('controller-device')
  const childless = result.partitions.find(partition => childlessPaths.every(path => partition.targets.some(target => target.path === path)))!
  for (const [partition, id, path] of [[root, 'interface-project', rootPath], [parent, 'controller', parentPath]] as const) {
    assert.equal(partition.phase, 'interface_seed')
    assert.deepEqual(partition.targets.map(target => target.nodeId), [id])
    assert.deepEqual(partition.writePaths, [path])
    assert.deepEqual(partition.sourcePaths, [])
  }
  assert.equal(leaf.phase, undefined)
  assert.ok(leaf.writePaths.includes('src/controller/device.ts'))
  assert.equal(childless.phase, undefined)
  assert.deepEqual(childless.targets.map(target => target.nodeId), ['device', 'web'])
})

test('nested interface parent rawSource falls back to frozen node identity when its Spec body is unavailable', () => {
  const rootPath = '.spec/interface-fallback/spec.md'
  const parentPath = '.spec/interface-fallback/controller/spec.md'
  const leafPath = '.spec/interface-fallback/controller/device/spec.md'
  const targets = [
    { nodeId: 'interface-fallback', path: rootPath }, { nodeId: 'controller', path: parentPath, rawSource: '' }, { nodeId: 'controller-device', path: leafPath },
  ]
  const files = new Map<string, string>([
    [rootPath, rawSpec('interface-fallback', [])], [leafPath, rawSpec('controller-device', ['src/controller/device.ts'])],
    ['src/controller/device.ts', 'export const device = true'],
  ])
  const inputPlan: SyncCoordinatorPlan = {
    ...plan(), intentNodeId: 'interface-fallback', targets, readPaths: ['.spec', 'src'],
    writePaths: ['.spec/interface-fallback', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [],
  }
  const result = planSyncPartitions({
    plan: inputPlan, files, contracts: [], nodes: [
      { id: 'interface-fallback', path: rootPath }, { id: 'controller', path: parentPath, rawSource: 'frozen controller request' },
      { id: 'controller-device', path: leafPath },
    ], changedPaths: [],
  })
  const parent = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'controller'))!
  assert.equal(parent.phase, 'interface_seed')
  assert.deepEqual(parent.writePaths, [parentPath])
  assert.deepEqual(parent.sourcePaths, [])
})

test('analysis descendant evidence must be a target below the parent and bound to its real source partition', () => {
  const rootPath = '.spec/interface-analysis/spec.md'
  const parentPath = '.spec/interface-analysis/controller/spec.md'
  const newLeafPath = '.spec/interface-analysis/controller/new-device/spec.md'
  const root = { nodeId: 'interface-analysis', path: rootPath }, parent = { nodeId: 'controller', path: parentPath }
  const newLeaf = { nodeId: 'new-device', path: newLeafPath, rawSource: 'new device behavior' }
  const input = {
    sourcePaths: ['src'],
    files: new Map([[rootPath, rawSpec(root.nodeId, [])], [parentPath, rawSpec(parent.nodeId, [])]]),
    contracts: [], nodes: [root, parent].map(target => ({ id: target.nodeId, path: target.path })), targets: [root, parent, newLeaf],
  }
  const accepted = {
    nodeId: newLeaf.nodeId, path: newLeaf.path, codePath: 'src/new-device.ts',
    sourcePartitionId: 'partition-source-new-device', sourcePaths: ['src/new-device.ts'],
  }
  const evidence = rawOnlyInterfaceSeedEvidence(input, parent, [accepted])
  assert.equal(evidence?.phase, 'interface_seed')
  assert.equal(evidence?.parentNodeId, 'controller')
  assert.deepEqual(evidence?.descendants, [{ nodeId: 'new-device', path: newLeafPath, codePaths: ['src/new-device.ts'], sourcePartitionId: 'partition-source-new-device' }])
  assert.equal(rawOnlyInterfaceSeedEvidence(input, parent, [{ ...accepted, sourcePaths: ['src/unrelated.ts'] }]), null)
  assert.equal(rawOnlyInterfaceSeedEvidence(input, parent, [{ ...accepted, path: '.spec/unrelated/new-device/spec.md' }]), null)
  assert.equal(rawOnlyInterfaceSeedEvidence(input, parent, [accepted, { ...accepted, sourcePartitionId: 'another-owner' }]), null)
})

test('a parsed REQ RULE GAP interface parent with a complete sourced child qualifies for a seed', () => {
  const parentPath = '.spec/interface-sync/controller/spec.md'
  const leafPath = '.spec/interface-sync/controller/leaf/spec.md'
  const parentSource = `---
title: controller
contract-schema: sync-v1
code:
related:
---
## raw source
保留控制器接口。

## expanded spec
维持稳定的子节点职责边界。

### REQ
| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-CONTROLLER-01 | 保留控制器接口 | user:raw | - | 接口保持兼容 | - |

### RULE
| id | scope | constraint | basis | authority | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- |
| RULE-CONTROLLER-01 | 控制器 | 保留既有接口语义 | 当前契约 | controller | user:raw | REQ-CONTROLLER-01 |

### GAP
| id | kind | unknown | affects | evidence | decision | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GAP-CONTROLLER-01 | missing_fact | 子节点的扩展细节待确认 | REQ-CONTROLLER-01 | 原始需求未说明 | 暂不扩大父职责 | user:raw | REQ-CONTROLLER-01 |
`
  const leafSource = `---
title: leaf
contract-schema: sync-v1
code:
  - src/controller/leaf.ts
related: []
---
## raw source
提供叶节点行为。

## expanded spec
叶节点独立实现并验证自己的行为。

### REQ
| id | goal | source | constraints | success | depends-on |
| --- | --- | --- | --- | --- | --- |
| REQ-LEAF-01 | 执行叶节点行为 | user:raw | - | 行为按契约完成 | - |

### FLOW
| id | req | actors | entry | preconditions | steps | terminal | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FLOW-LEAF-01 | REQ-LEAF-01 | 调用者 | 执行叶节点 | 输入有效 | STEP-LEAF-01 | END | derived:REQ-LEAF-01 | REQ-LEAF-01 |

### STEP
| id | flow | action | input | output | rules | next | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STEP-LEAF-01 | FLOW-LEAF-01 | 执行行为 | request | response | - | END | derived:FLOW-LEAF-01 | FLOW-LEAF-01 |

### AC
| id | covers | preconditions | action | assertion | test | command | source | depends-on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-LEAF-01 | REQ-LEAF-01 | 输入有效 | 执行叶节点 | 返回正确结果 | tests/leaf.test.ts#LEAF-01 | VERIFY-LEAF-01 | derived:REQ-LEAF-01 | REQ-LEAF-01 |

### VERIFY
| id | command | cwd | timeout-ms |
| --- | --- | --- | --- |
| VERIFY-LEAF-01 | ["node","--test","tests/leaf.test.ts"] | . | 1000 |
`
  const parentParsed = parseContract({ nodeId: 'controller', path: parentPath, source: parentSource })
  const leafParsed = parseContract({ nodeId: 'leaf', path: leafPath, source: leafSource })
  assert.deepEqual(parentParsed.findings, [])
  assert.deepEqual(leafParsed.findings, [])
  assert.ok(parentParsed.contract)
  assert.ok(leafParsed.contract)
  assert.deepEqual(parentParsed.contract.code, [])
  assert.deepEqual(parentParsed.contract.items.map(item => item.kind), ['REQ', 'RULE', 'GAP'])
  assert.deepEqual(leafParsed.contract.code, ['src/controller/leaf.ts'])
  const parent = { nodeId: 'controller', path: parentPath }
  const leaf = { nodeId: 'leaf', path: leafPath }
  const evidence = rawOnlyInterfaceSeedEvidence({
    sourcePaths: ['src'], files: new Map([
      [parentPath, parentSource], [leafPath, leafSource], ['src/controller/leaf.ts', 'export const leaf = true'],
      ['tests/leaf.test.ts', 'test leaf'],
    ]), contracts: [parentParsed.contract, leafParsed.contract],
    nodes: [parent, leaf].map(target => ({ id: target.nodeId, path: target.path })), targets: [parent, leaf],
  }, parent)

  assert.equal(evidence?.phase, 'interface_seed')
  assert.deepEqual(evidence?.descendants, [{ nodeId: 'leaf', path: leafPath, codePaths: ['src/controller/leaf.ts'] }])
  assert.equal(rawOnlyInterfaceSeedEvidence({
    sourcePaths: ['src'], files: new Map([
      [parentPath, parentSource], [leafPath, leafSource], ['src/controller/leaf.ts', 'export const leaf = true'],
    ]), contracts: [{ ...parentParsed.contract, path: '.spec/interface-sync/old-controller/spec.md' }, leafParsed.contract],
    nodes: [parent, leaf].map(target => ({ id: target.nodeId, path: target.path })), targets: [parent, leaf],
  }, parent), null, 'an old path with the same node ID cannot impersonate the current parent contract')

  const expectedParentIds = ['GAP-CONTROLLER-01', 'REQ-CONTROLLER-01', 'RULE-CONTROLLER-01']
  const rawRounds = [
    '保留控制器接口。',
    '保留控制器接口。追加：保留现有REQ与RULE ID。',
    '保留控制器接口。追加：保留现有REQ与RULE ID。再追加：新需求由后代承担。',
  ]
  for (const [round, rawSource] of rawRounds.entries()) {
    const roundParentSource = parentSource.replace('保留控制器接口。', rawSource)
    const roundParentParsed = parseContract({ nodeId: 'controller', path: parentPath, source: roundParentSource })
    assert.deepEqual(roundParentParsed.findings, [])
    assert.ok(roundParentParsed.contract)
    assert.equal(roundParentParsed.contract.rawSource, rawSource)
    const originalItems = structuredClone(roundParentParsed.contract.items)
    const inputPlan: SyncCoordinatorPlan = {
      ...plan(), intentNodeId: 'controller', targets: [parent, leaf],
      readPaths: ['.spec', 'src', 'tests'], writePaths: ['.spec/interface-sync', 'src'], sourcePaths: ['src'],
      executionScope: {
        paths: ['.spec/interface-sync', 'src', 'tests'],
        contractIds: [...expectedParentIds, 'REQ-LEAF-01', 'STEP-LEAF-01', 'AC-LEAF-01'],
        flowIds: ['FLOW-LEAF-01'],
      },
      mandatoryTests: [{ verificationId: 'VERIFY-LEAF-01', testPath: 'tests/leaf.test.ts', testId: 'LEAF-01' }],
    }
    const result = planSyncPartitions({
      plan: inputPlan,
      files: new Map([
        [parentPath, roundParentSource], [leafPath, leafSource], ['src/controller/leaf.ts', 'export const leaf = true'],
        ['tests/leaf.test.ts', 'test leaf'],
      ]),
      contracts: [roundParentParsed.contract, leafParsed.contract],
      changedPaths: round === 0 ? [] : [parentPath],
    })
    const parentPartition = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'controller'))
    assert.ok(parentPartition, `round ${round + 1} retains the existing parent target`)
    assert.equal(parentPartition.phase, 'interface_seed', `round ${round + 1} keeps the parent isolated`)
    assert.deepEqual(parentPartition.contractIds, expectedParentIds, `round ${round + 1} keeps existing contract IDs`)
    assert.deepEqual(roundParentParsed.contract.items, originalItems, `round ${round + 1} does not clear existing contract items`)
  }

  const richParentSource = `${parentSource.replace(
    '| REQ-CONTROLLER-01 | 保留控制器接口 | user:raw | - | 接口保持兼容 | - |',
    '| REQ-CONTROLLER-01 | 保留控制器接口 | user:raw | - | 接口保持兼容 | - |\n| REQ-PARENT-EXTRA-01 | 完成父节点流程 | user:raw | - | 父流程可执行 | - |',
  )}\n${leafSource.slice(leafSource.indexOf('\n### FLOW')).replaceAll('LEAF', 'PARENT-EXTRA')}`
  const richParentParsed = parseContract({ nodeId: 'controller', path: parentPath, source: richParentSource })
  assert.deepEqual(richParentParsed.findings, [])
  assert.ok(richParentParsed.contract)
  assert.equal(richParentParsed.contract.code.length, 0)
  assert.ok(richParentParsed.contract.items.some(item => ['FLOW', 'STEP', 'AC', 'VERIFY'].includes(item.kind)))
  assert.equal(rawOnlyInterfaceSeedEvidence({
    sourcePaths: ['src'], files: new Map([
      [parentPath, richParentSource], [leafPath, leafSource], ['src/controller/leaf.ts', 'export const leaf = true'],
      ['tests/leaf.test.ts', 'test leaf'],
    ]), contracts: [richParentParsed.contract, leafParsed.contract],
    nodes: [parent, leaf].map(target => ({ id: target.nodeId, path: target.path })), targets: [parent, leaf],
  }, parent), null, 'a parent with workflow, acceptance, step, or verification rows stays modeled')
})

test('a test-only descendant is not a frozen source implementation descendant', () => {
  const rootPath = '.spec/interface-test-only/spec.md'
  const parentPath = '.spec/interface-test-only/controller/spec.md'
  const leafPath = '.spec/interface-test-only/controller/leaf/spec.md'
  const root = { nodeId: 'interface-test-only', path: rootPath }
  const parent = { nodeId: 'controller', path: parentPath }
  const leaf = { nodeId: 'leaf', path: leafPath }
  const input = {
    sourcePaths: ['src'],
    files: new Map([
      [rootPath, rawSpec(root.nodeId, [])], [parentPath, rawSpec(parent.nodeId, [])],
      [leafPath, rawSpec(leaf.nodeId, ['tests/leaf.test.ts'])], ['tests/leaf.test.ts', 'test leaf'],
    ]),
    contracts: [], nodes: [root, parent, leaf].map(target => ({ id: target.nodeId, path: target.path })),
    targets: [root, parent, leaf],
  }

  assert.equal(rawOnlyInterfaceSeedEvidence(input, parent), null)

  const relatedOnlyInput = {
    ...input,
    files: new Map(input.files),
  }
  relatedOnlyInput.files.set(leafPath, rawSpec(leaf.nodeId, [], ['src/leaf.ts']))
  relatedOnlyInput.files.set('src/leaf.ts', 'related source context')
  assert.equal(rawOnlyInterfaceSeedEvidence(relatedOnlyInput, parent), null)

  const sourceInput = {
    ...input,
    files: new Map(input.files),
  }
  sourceInput.files.set(leafPath, rawSpec(leaf.nodeId, ['src/leaf.ts']))
  sourceInput.files.set('src/leaf.ts', 'source implementation')
  assert.deepEqual(rawOnlyInterfaceSeedEvidence(sourceInput, parent)?.descendants, [
    { nodeId: leaf.nodeId, path: leafPath, codePaths: ['src/leaf.ts'] },
  ])
})

test('an existing Contract, own code binding, absent source file, or unrelated source cannot create a pure-parent phase', () => {
  const rootPath = '.spec/interface-guards/spec.md'
  const contractParentPath = '.spec/interface-guards/contract-parent/spec.md'
  const contractLeafPath = '.spec/interface-guards/contract-parent/leaf/spec.md'
  const codedParentPath = '.spec/interface-guards/coded-parent/spec.md'
  const codedLeafPath = '.spec/interface-guards/coded-parent/leaf/spec.md'
  const missingParentPath = '.spec/interface-guards/missing-parent/spec.md'
  const missingLeafPath = '.spec/interface-guards/missing-parent/leaf/spec.md'
  const unrelatedPath = '.spec/elsewhere/leaf/spec.md'
  const targets = [rootPath, contractParentPath, contractLeafPath, codedParentPath, codedLeafPath, missingParentPath, missingLeafPath, unrelatedPath]
    .map((path, index) => ({ nodeId: ['interface-guards', 'contract-parent', 'contract-leaf', 'coded-parent', 'coded-leaf', 'missing-parent', 'missing-leaf', 'elsewhere-leaf'][index], path }))
  const files = new Map<string, string>([
    [rootPath, rawSpec('interface-guards', [])],
    [contractParentPath, rawSpec('contract-parent', [])], [contractLeafPath, rawSpec('contract-leaf', ['src/contract/leaf.ts'])],
    [codedParentPath, rawSpec('coded-parent', ['src/coded/parent.ts'])], [codedLeafPath, rawSpec('coded-leaf', ['src/coded/leaf.ts'])],
    [missingParentPath, rawSpec('missing-parent', [])], [missingLeafPath, rawSpec('missing-leaf', ['src/missing/leaf.ts'])],
    [unrelatedPath, rawSpec('elsewhere-leaf', ['src/elsewhere/leaf.ts'])],
    ['src/contract/leaf.ts', 'contract child'], ['src/coded/parent.ts', 'parent implementation'], ['src/coded/leaf.ts', 'coded child'],
    ['src/elsewhere/leaf.ts', 'unrelated implementation'],
  ])
  const inputPlan: SyncCoordinatorPlan = {
    ...plan(), intentNodeId: 'interface-guards', targets, readPaths: ['.spec', 'src'],
    writePaths: ['.spec/interface-guards', '.spec/elsewhere', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [],
  }
  const result = planSyncPartitions({
    plan: inputPlan, files, contracts: [contract('contract-parent', contractParentPath, [])], nodes: targets.map(target => ({ id: target.nodeId, path: target.path })), changedPaths: [],
  })
  const partitionFor = (nodeId: string) => result.partitions.find(partition => partition.targets.some(target => target.nodeId === nodeId))!
  assert.equal(partitionFor('contract-parent').phase, undefined)
  assert.equal(partitionFor('coded-parent').phase, undefined)
  assert.equal(partitionFor('missing-parent').phase, undefined)
  assert.equal(partitionFor('interface-guards').phase, 'interface_seed')
})

test('a raw global intent with no actual child keeps its legacy Spec-only seed without interface phase', () => {
  const rootPath = '.spec/interface-no-child/spec.md', unrelatedPath = '.spec/unrelated/leaf/spec.md'
  const targets = [{ nodeId: 'interface-no-child', path: rootPath }, { nodeId: 'unrelated-leaf', path: unrelatedPath }]
  const files = new Map<string, string>([
    [rootPath, rawSpec('interface-no-child', [])], [unrelatedPath, rawSpec('unrelated-leaf', ['src/unrelated/leaf.ts'])],
    ['src/unrelated/leaf.ts', 'unrelated source'],
  ])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'interface-no-child', targets, readPaths: ['.spec', 'src'], writePaths: ['.spec/interface-no-child', '.spec/unrelated', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files, contracts: [], nodes: targets.map(target => ({ id: target.nodeId, path: target.path })), changedPaths: [],
  })
  const root = result.partitions.find(partition => partition.targets.some(target => target.nodeId === 'interface-no-child'))!
  assert.equal(root.phase, undefined)
  assert.deepEqual(root.writePaths, [rootPath])
  assert.deepEqual(root.sourcePaths, [])
})

test('raw intent seed detection accepts frozen node and target rawSource fields when Markdown is absent', () => {
  const path = '.spec/raw-source/spec.md'
  const buildPlan = (rawSource?: string): SyncCoordinatorPlan => ({
    ...plan(), intentNodeId: 'raw-source', targets: [{ nodeId: 'raw-source', path, ...(rawSource === undefined ? {} : { rawSource }) }],
    readPaths: ['.spec'], writePaths: ['.spec/raw-source'], executionScope: undefined, mandatoryTests: [],
  })
  const byTarget = planSyncPartitions({ plan: buildPlan('target-authored raw'), files: new Map(), contracts: [], changedPaths: [] })
  assert.deepEqual(byTarget.partitions.map(partition => partition.writePaths), [[path]])
  const byNode = planSyncPartitions({
    plan: buildPlan(), files: new Map(), contracts: [], nodes: [{ id: 'raw-source', path, rawSource: 'frozen-node raw' }], changedPaths: [],
  })
  assert.deepEqual(byNode.partitions.map(partition => partition.writePaths), [[path]])
})

test('moved raw Spec keeps its old code writer metadata without overriding current Markdown', () => {
  const oldPath = '.spec/moved/old/spec.md', currentPath = '.spec/moved/current/spec.md'
  const currentSpec = rawSpec('moving-node', ['src/current.ts'])
  const oldSpec = rawSpec('moving-node', ['src/old.ts'])
  const staleAtCurrentPath = rawSpec('moving-node', ['src/stale.ts'])
  const files = new Map<string, string>([
    [currentPath, currentSpec], ['src/current.ts', 'current source'],
  ])
  const governanceSources = new Map([[oldPath, oldSpec], [currentPath, staleAtCurrentPath]])
  const movePlan: SyncCoordinatorPlan = {
    ...plan(), intentNodeId: 'request-root',
    targets: [{ nodeId: 'moving-node', path: currentPath }],
    readPaths: ['.spec', 'src'], writePaths: ['.spec/moved', 'src'], sourcePaths: ['src'],
    executionScope: { paths: ['.spec/moved', 'src'], contractIds: [], flowIds: [] }, mandatoryTests: [],
  }
  const nodes = [
    { id: 'moving-node', path: oldPath, rawSource: 'old request' },
    { id: 'moving-node', path: currentPath, rawSource: 'current request' },
  ]
  const changedPaths = [oldPath, 'src/old.ts']
  const inputFiles = [...files]
  const result = planSyncPartitions({
    plan: movePlan, files, contracts: [], nodes, governanceSources, changedPaths,
    readByteSizes: new Map([[oldPath, 80], ['src/old.ts', 120]]),
  })
  const partition = result.partitions.find(candidate => candidate.targets.some(target => target.nodeId === 'moving-node'))!
  assert.deepEqual(partition.changedPaths, [oldPath, 'src/old.ts'])
  assert.ok(partition.writePaths.includes(oldPath) && partition.writePaths.includes('src/old.ts'))
  assert.ok(partition.writePaths.includes('src/current.ts'))
  assert.ok(!partition.writePaths.includes('src/stale.ts'))
  assert.ok(partition.readPaths.includes(oldPath) && partition.readPaths.includes(currentPath))
  assert.ok(!partition.readPaths.includes('src/stale.ts'))
  assert.deepEqual(partition.targets.map(target => target.path), [currentPath])
  assert.equal(files.has(oldPath), false, 'historical governance source never enters the current body map')
  assert.deepEqual([...files], inputFiles)
  assert.equal(result.expectedPaths.includes(oldPath), true)
})

test('non-overlapping target writers under one Spec module batch within the byte budget', () => {
  const pathA = '.spec/packing/services/alpha/spec.md', pathB = '.spec/packing/services/beta/spec.md'
  const a = contract('pack-a', pathA, ['src/services/alpha.ts'])
  const b = contract('pack-b', pathB, ['src/services/beta.ts'])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'upper', targets: [a, b].map(node => ({ nodeId: node.nodeId, path: node.path })), readPaths: ['.spec', 'src'], writePaths: ['.spec/packing', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files: new Map([[pathA, 'alpha spec'], [pathB, 'beta spec'], ['src/services/alpha.ts', 'alpha code'], ['src/services/beta.ts', 'beta code']]),
    contracts: [a, b], changedPaths: [],
  })
  assert.equal(result.partitions.length, 1)
  assert.deepEqual(result.partitions[0].targets.map(target => target.nodeId), ['pack-a', 'pack-b'])
  assert.ok(result.partitions[0].writePaths.includes('src/services/alpha.ts'))
  assert.ok(result.partitions[0].writePaths.includes('src/services/beta.ts'))
})

test('target writers in different parent Spec modules remain separate', () => {
  const pathA = '.spec/packing/module-a/alpha/spec.md', pathB = '.spec/packing/module-b/beta/spec.md'
  const a = contract('module-a', pathA, ['src/module-a.ts'])
  const b = contract('module-b', pathB, ['src/module-b.ts'])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'upper', targets: [a, b].map(node => ({ nodeId: node.nodeId, path: node.path })), readPaths: ['.spec', 'src'], writePaths: ['.spec/packing', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files: new Map([[pathA, 'module a'], [pathB, 'module b'], ['src/module-a.ts', 'a code'], ['src/module-b.ts', 'b code']]),
    contracts: [a, b], changedPaths: [],
  })
  assert.equal(result.partitions.length, 2)
  assert.ok(result.partitions.every(partition => partition.targets.length === 1))
})

test('a shared writer across parent modules remains in one partition', () => {
  const pathA = '.spec/writers/module-a/alpha/spec.md', pathB = '.spec/writers/module-b/beta/spec.md'
  const sharedPath = 'src/shared/writer.ts'
  const a = contract('writer-a', pathA, [sharedPath]), b = contract('writer-b', pathB, [sharedPath])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'upper', targets: [a, b].map(node => ({ nodeId: node.nodeId, path: node.path })), readPaths: ['.spec', 'src'], writePaths: ['.spec/writers', 'src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files: new Map([[pathA, 'alpha spec'], [pathB, 'beta spec'], [sharedPath, 'shared implementation']]),
    contracts: [a, b], changedPaths: [sharedPath],
  })
  assert.equal(result.partitions.length, 1)
  assert.deepEqual(result.partitions[0].targets.map(target => target.nodeId), ['writer-a', 'writer-b'])
  assert.equal(result.partitions[0].writePaths.filter(path => path === sharedPath).length, 1)
})

test('unowned paths in different source directories batch by their nearest Spec module', () => {
  const nearestPath = '.spec/discovery/module/nearest/spec.md'
  const files = new Map([
    [nearestPath, rawSpec('nearest', ['src/catalog/existing.ts'])],
    ['src/catalog/existing.ts', 'existing code'], ['src/new-a/one.ts', 'one'], ['src/new-b/two.ts', 'two'],
  ])
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'upper', targets: [], readPaths: ['.spec', 'src'], writePaths: ['src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files, contracts: [], nodes: [{ id: 'nearest', path: nearestPath }], changedPaths: ['src/new-a/one.ts', 'src/new-b/two.ts'],
  })
  assert.equal(result.partitions.length, 1)
  assert.deepEqual(result.partitions[0].changedPaths, ['src/new-a/one.ts', 'src/new-b/two.ts'])
  assert.deepEqual(result.partitions[0].contextNodeIds, ['nearest'])
})

test('unowned paths without a nearby node retain their source top-module boundary', () => {
  const result = planSyncPartitions({
    plan: { ...plan(), intentNodeId: 'upper', targets: [], readPaths: ['src'], writePaths: ['src'], sourcePaths: ['src'], executionScope: undefined, mandatoryTests: [] },
    files: new Map([['src/module-a/one.ts', 'one'], ['src/module-b/two.ts', 'two']]),
    contracts: [], changedPaths: ['src/module-a/one.ts', 'src/module-b/two.ts'],
  })
  assert.equal(result.partitions.length, 2)
  assert.deepEqual(new Set(result.partitions.map(partition => partition.changedPaths[0])), new Set(['src/module-a/one.ts', 'src/module-b/two.ts']))
})
