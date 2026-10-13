import { projectContractCoverage } from '@spexcode/spec-core/contracts'
import type { ContractGraph, Verification } from '@spexcode/spec-core/contracts'
import { validateRepositoryPath } from './snapshot.js'
import type { VerificationPolicy } from './verification-executor-types.js'

export type RegisteredVerification = {
  definition: Pick<Verification, 'id' | 'command' | 'cwd' | 'timeoutMs'>
  environment: Omit<VerificationPolicy, 'argv' | 'cwd' | 'timeoutMs' | 'expectedTestIds'>
}
export type AcceptanceRun = {
  verificationId: string
  bindings: { acceptanceId: string; testPath: string; testId: string }[]
  policy: VerificationPolicy
}

/** 必需集合由可信协调器确定；此处只验证并映射，不忽略未知、阻塞或未登记项。 */
export function planAcceptanceRuns(graph: ContractGraph, requiredAcceptanceIds: readonly string[], registrations: readonly RegisteredVerification[]): AcceptanceRun[] {
  if (!requiredAcceptanceIds.length || new Set(requiredAcceptanceIds).size !== requiredAcceptanceIds.length) throw new Error('必需验收集合必须非空且唯一')
  if (new Set(registrations.map(entry => entry.definition.id)).size !== registrations.length) throw new Error('验证命令登记不能重复')
  const registered = new Map(structuredClone(registrations).map(entry => [entry.definition.id, entry]))
  const coverage = projectContractCoverage(graph)
  const groups = new Map<string, AcceptanceRun>()
  for (const id of [...requiredAcceptanceIds].sort()) {
    const ac = graph.items.get(id)
    if (ac?.kind !== 'AC') throw new Error(`必需验收不存在或类型错误: ${id}`)
    if (coverage.items.find(item => item.id === id)!.blockedBy.length) throw new Error(`必需验收仍被业务缺口阻塞: ${id}`)
    const hash = ac.test.lastIndexOf('#')
    const testPath = validateRepositoryPath(ac.test.slice(0, hash)), testId = ac.test.slice(hash + 1)
    if (hash < 1 || !testId || /\s/.test(testId)) throw new Error(`验收测试绑定不明确: ${id}`)
    const verify = graph.items.get(ac.command), trusted = registered.get(ac.command)
    if (verify?.kind !== 'VERIFY' || !trusted || verify.cwd !== trusted.definition.cwd || verify.timeoutMs !== trusted.definition.timeoutMs || JSON.stringify(verify.command) !== JSON.stringify(trusted.definition.command)) throw new Error(`验收引用未登记或被更改的验证命令: ${id}`)
    let group = groups.get(verify.id)
    if (!group) {
      group = { verificationId: verify.id, bindings: [], policy: { ...trusted.environment, argv: [...trusted.definition.command], cwd: trusted.definition.cwd, timeoutMs: trusted.definition.timeoutMs, expectedTestIds: [] } }
      groups.set(verify.id, group)
    }
    if (group.bindings.some(binding => binding.testId === testId && binding.testPath !== testPath)) throw new Error(`同一验证运行内测试标识有多个文件: ${testId}`)
    group.bindings.push({ acceptanceId: id, testPath, testId })
    if (!group.policy.expectedTestIds.includes(testId)) group.policy.expectedTestIds.push(testId)
  }
  return [...groups.values()].sort((a, b) => a.verificationId.localeCompare(b.verificationId))
}
