import type { ElaborationSessionRequest } from '../src/sync/elaboration-types.js'

type TargetPosition = { nodeId: string; path: string }
type FrozenNodeChange = { action: string; from: TargetPosition; to?: TargetPosition }
type FrozenElaborationInput = { targets: readonly TargetPosition[]; nodeChanges?: readonly FrozenNodeChange[] }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function frozenElaborationInput(request: ElaborationSessionRequest): FrozenElaborationInput {
  const marker = request.prompt.includes('冻结业务输入:\n') ? '冻结业务输入:\n' : '任务:\n'
  const markerIndex = request.prompt.indexOf(marker)
  if (markerIndex < 0) throw new Error('细化生成夹具缺少冻结业务输入')
  const jsonLine = request.prompt.slice(markerIndex + marker.length).split(/\r?\n/, 1)[0]
  return JSON.parse(jsonLine) as FrozenElaborationInput
}

function targetIndexForChange(input: FrozenElaborationInput, change: Record<string, unknown>): number | null {
  const matches = (position: TargetPosition | undefined, nodeId: unknown, path: unknown): boolean => position !== undefined && position.nodeId === nodeId && position.path === path
  for (const lifecycle of input.nodeChanges ?? []) {
    if (lifecycle.action !== 'move' || !matches(lifecycle.to, change.nodeId, change.path)) continue
    const index = input.targets.findIndex(target => matches(target, lifecycle.from.nodeId, lifecycle.from.path))
    return index < 0 ? null : index
  }
  const index = input.targets.findIndex(target => {
    if (!matches(target, change.nodeId, change.path)) return false
    return !(input.nodeChanges ?? []).some(lifecycle => matches(target, lifecycle.from.nodeId, lifecycle.from.path))
  })
  return index < 0 ? null : index
}

/** 将内部canonical行仅在fake Native返回边界转换为当前wire协议。 */
export function adaptElaborationNativeOutput(request: ElaborationSessionRequest, output: unknown): unknown {
  if (request.purpose !== 'elaboration_generate' || !isRecord(output) || output.version !== 'elaboration-rows-v2' || !Array.isArray(output.changes)) return output
  const frozen = frozenElaborationInput(request)
  const changes = output.changes.map(value => {
    if (!isRecord(value)) return value
    const targetIndex = targetIndexForChange(frozen, value)
    if (targetIndex === null || 'targetIndex' in value && value.targetIndex !== targetIndex) return value
    const { nodeId: _nodeId, path: _path, ...businessRow } = value
    return { ...businessRow, targetIndex }
  })
  return { ...output, version: 'elaboration-target-rows-v3', changes }
}
