import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildContractGraph, parseContract } from '@spexcode/spec-core/contracts'
import { planAcceptanceRuns } from './verification-plan.js'
import type { RegisteredVerification } from './verification-plan.js'

const path = '.spec/export/export-contract/spec.md'
const source = readFileSync(new URL(`../../test/fixtures/spec-sync/export-repo/${path}`, import.meta.url), 'utf8')
function fixture() {
  const contract = parseContract({ nodeId: 'export-contract', path, source }).contract!
  const graph = buildContractGraph([contract])
  const verify = contract.items.find(item => item.kind === 'VERIFY')!
  assert.equal(verify.kind, 'VERIFY')
  const registrations: RegisteredVerification[] = [{ definition: structuredClone(verify), environment: { version: 'trusted', image: `node@sha256:${'a'.repeat(64)}`, platform: 'linux/arm64', memoryBytes: 134217728, cpus: 1, pidsLimit: 64, scratchBytes: 16777216, logBytes: 65536 } }]
  return { contract, graph, registrations }
}

test('必需AC集合完整映射到真实testID，按固定VERIFY命令分组', () => {
  const { graph, registrations } = fixture()
  const jobs = planAcceptanceRuns(graph, ['AC-EXPORT-03', 'AC-EXPORT-01'], registrations)
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].policy.expectedTestIds, ['AC-EXPORT-01', 'AC-EXPORT-03'])
  assert.deepEqual(jobs[0].policy.argv, ['node', '--test', 'tests/export.test.mjs'])
  assert.deepEqual(jobs[0].bindings.map(binding => binding.acceptanceId), ['AC-EXPORT-01', 'AC-EXPORT-03'])
  registrations[0].definition.command.push('changed')
  assert.equal(jobs[0].policy.argv.length, 3)
})

test('空集合、未知/重复/非AC、候选换命令或未登记不能静默跳过', () => {
  const { graph, registrations } = fixture()
  for (const ids of [[], ['AC-MISSING'], ['REQ-EXPORT-01'], ['AC-EXPORT-01', 'AC-EXPORT-01']]) assert.throws(() => planAcceptanceRuns(graph, ids, registrations))
  assert.throws(() => planAcceptanceRuns(graph, ['AC-EXPORT-01'], []), /未登记/)
  registrations[0].definition.command = ['node', '--test', 'tests/empty.mjs']
  assert.throws(() => planAcceptanceRuns(graph, ['AC-EXPORT-01'], registrations), /被更改/)
})

test('GAP阻塞的必需验收拒绝，同名用例跨文件拒绝歧义', () => {
  const { graph, registrations } = fixture()
  const first = graph.items.get('AC-EXPORT-01')!, second = graph.items.get('AC-EXPORT-03')!
  assert.equal(first.kind, 'AC'); assert.equal(second.kind, 'AC')
  second.test = 'tests/other.mjs#AC-EXPORT-01'
  assert.throws(() => planAcceptanceRuns(graph, [first.id, second.id], registrations), /多个文件/)
  const gapSource = `${source}\n### GAP\n| id | kind | unknown | affects | evidence | decision | source | depends-on |\n|---|---|---|---|---|---|---|---|\n| GAP-EXPORT-TEST | missing_fact | 下载政策缺失 | AC-EXPORT-03 | 无输入 | 用户说明 | derived:REQ-EXPORT-01 | - |\n`
  const blocked = buildContractGraph([parseContract({ nodeId: 'export-contract', path, source: gapSource }).contract!])
  assert.throws(() => planAcceptanceRuns(blocked, ['AC-EXPORT-03'], registrations), /缺口阻塞/)
  assert.equal(planAcceptanceRuns(blocked, ['AC-EXPORT-01'], registrations).length, 1)
})
