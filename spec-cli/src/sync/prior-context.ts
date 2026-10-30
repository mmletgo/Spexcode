import { parseContract } from '@spexcode/spec-core/contracts'
import type { GenerationInput } from './generation-types.js'
import type { ContractNodeChange } from './writeback-types.js'
import type { WorktreeIdentity } from './operation-types.js'

export type PriorContext = NonNullable<GenerationInput['priorContext']>[number]
type PriorTarget = { path: string }

const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))

/** 历史快照必须与当前输入是同一工作树，不能借另一仓库的树冒充提交前正文。 */
export function sameSnapshotSource(left: WorktreeIdentity, right: WorktreeIdentity): boolean {
  return left.repositoryId === right.repositoryId
    && left.commonDir === right.commonDir
    && left.canonicalRoot === right.canonicalRoot
    && left.gitDir === right.gitDir
    && left.branch === right.branch
    && left.physicalFingerprint === right.physicalFingerprint
}

/** 无历史角色时不增加提示句，避免旧请求的冻结 JSON 与摘要发生变化。 */
export function priorContextInstructions(prior: GenerationInput['priorContext']): string {
  if (!prior?.length) return ''
  return 'priorContext是独立旧来源角色，完整正文来自真实提交前快照或旧pair，不是当前files。role为source_before时明确不是verifiedDelivery；只有role为verified_delivery才表示已验证交付。不得用analysis摘要代替这些完整旧Spec、旧源码和旧测试。当前files没有的旧源码仍按对应原义务检查，不得把旧正文伪装成current files。\n'
}

/** 本区旧 owner 路径：目标自身、退役 owner，以及移动到本区目标的 from 路径。 */
export function historicalOwnerPaths(input: Pick<GenerationInput, 'nodeChanges' | 'retiredOwners'>, targets: readonly PriorTarget[]): string[] {
  const changes = lifecycleChanges(input.nodeChanges, targets)
  const paths = new Set(changes.map(change => change.from.path))
  for (const owner of input.retiredOwners ?? []) {
    if (targets.some(target => target.path === owner.path) || changes.some(change => change.from.path === owner.path)) paths.add(owner.path)
  }
  return [...paths].sort()
}

/** 本区必须保留的旧 ready 身份：旧 owner 上的项，以及退役节点自身的 ID。 */
export function historicalRetiredIds(input: Pick<GenerationInput, 'nodeChanges' | 'retiredOwners'>, targets: readonly PriorTarget[]): string[] {
  const changes = lifecycleChanges(input.nodeChanges, targets)
  const owners = new Set(historicalOwnerPaths(input, targets))
  const ids = (input.retiredOwners ?? []).filter(item => owners.has(item.path)).map(item => item.id)
  for (const change of changes) if (change.action === 'retire') ids.push(change.from.nodeId)
  return [...new Set(ids)].sort()
}

/** 从旧 Spec 正文投影其 code/related/测试/源码锚点；解析失败时至少保留 Spec 自身。 */
export function obligationPaths(source: string, path: string): string[] {
  const contract = parseContract({ nodeId: path.split('/').at(-2) ?? path, path, source }).contract
  const paths = new Set<string>([path])
  if (!contract) return [...paths]
  for (const anchor of [...contract.code, ...contract.related]) paths.add(anchor.split('#')[0])
  for (const item of contract.items) {
    if (item.kind === 'AC') paths.add(item.test.split('#')[0])
    if (item.kind !== 'VERIFY' && item.source.kind === 'code') paths.add(item.source.ref.split('#')[0])
  }
  return [...paths]
}

/** 只保留本区授权路径上的历史 manifest、正文和 binary/symlink。 */
export function projectPriorContext(prior: GenerationInput['priorContext'], paths: readonly string[]): GenerationInput['priorContext'] {
  return prior?.map(item => ({
    ...item,
    entries: item.entries.filter(entry => within(entry.path, paths)),
    objects: item.objects.filter(object => within(object.entry.path, paths)),
    files: new Map([...item.files].filter(([filePath]) => within(filePath, paths))),
  })).filter(item => item.entries.length)
}

function lifecycleChanges(changes: GenerationInput['nodeChanges'], targets: readonly PriorTarget[]): ContractNodeChange[] {
  return changes?.filter(change => targets.some(target => target.path === change.from.path || change.action === 'move' && target.path === change.to.path)) ?? []
}
