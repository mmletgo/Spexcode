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
