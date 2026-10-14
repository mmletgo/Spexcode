import { loadSpecs } from '@spexcode/spec-core'
import { contractImpact } from '@spexcode/spec-core/contracts'
import type { SyncCoordinatorPlan } from './coordinator-types.js'
import type { InputSnapshot } from './operation-types.js'
import { readFrozenContracts } from './frozen-contracts.js'
import { readObject, verifySnapshot } from './snapshot.js'
import { coveredPath, readSyncSettings, SyncApplicationError } from './settings.js'

/** 冻结契约影响与既有节点治理共同决定闭包；目录授权允许新自然语言需求创建实现。 */
export async function buildSyncApplicationPlan(snapshot: InputSnapshot, nodeId: string): Promise<SyncCoordinatorPlan> {
  const { settings } = readSyncSettings(snapshot), entries = verifySnapshot(snapshot)
  const specEntries = entries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md'))
  const files = new Map(specEntries.map(entry => [entry.path, readObject(snapshot.source.commonDir, entry.oid).toString('utf8')]))
  const frozen = await readFrozenContracts(snapshot.source.canonicalRoot, files)
  const nodes = await loadSpecs(snapshot.source.canonicalRoot, { tip: snapshot.headCommit, history: null, drift: null, snapshot: { tip: snapshot.headCommit, files: new Map([...files].filter(([path]) => path.startsWith('.spec/') && path.endsWith('/spec.md'))) } })
  const intent = nodes.find(node => node.id === nodeId)
  if (!intent) throw new SyncApplicationError('sync_node_unknown', `不存在 Spec 节点 ${nodeId}`, 404)
  const impact = contractImpact(frozen.graph, [nodeId])
  const selected = new Set([nodeId, ...impact.nodeIds, ...nodes.filter(node => node.path.startsWith(intent.path.slice(0, -'spec.md'.length))).map(node => node.id)])
  // 普通旧节点尚无 sync-v1 契约时仍按共同治理文件纳入其它权威叶。
  let changed = true
  while (changed) {
    changed = false
    const governed = new Set(nodes.filter(node => selected.has(node.id)).flatMap(node => node.code))
    for (const node of nodes) if (!selected.has(node.id) && node.code.some(path => governed.has(path))) { selected.add(node.id); changed = true }
  }
  const targets = nodes.filter(node => selected.has(node.id)).map(node => ({ nodeId: node.id, path: node.path }))
  const codePaths = [...new Set([...impact.codePaths, ...nodes.filter(node => selected.has(node.id)).flatMap(node => node.code)])]
  const writable = [...settings.sourcePaths, ...settings.testPaths]
  for (const path of [...codePaths, ...impact.testPaths]) if (!coveredPath(path, writable) && !settings.mandatoryTests.some(test => test.testPath === path)) throw new SyncApplicationError('sync_scope_unauthorized', `受影响文件未在可信授权中：${path}`)
  return {
    version: 'sync-coordinator-v1', intentNodeId: nodeId, targets,
    readPaths: [...new Set([...specEntries.map(entry => entry.path), '.spec/spexcode.json', ...writable, ...settings.readPaths, ...codePaths, ...impact.testPaths, ...settings.mandatoryTests.map(test => test.testPath)])].sort(),
    writePaths: [...new Set([...targets.map(target => target.path), ...writable])].sort(),
    facts: settings.facts, verifications: settings.verifications, mandatoryTests: settings.mandatoryTests,
  }
}
