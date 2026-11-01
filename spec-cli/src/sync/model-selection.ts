export const DEFAULT_SYNC_MODEL = 'gpt-6.1-sol'

/** 历史缺省固定为原模型，不能由当前全局配置改变。 */
export function syncModel(input: { model?: string }): string { return input.model ?? DEFAULT_SYNC_MODEL }

/** 默认选择保留原持久载荷字节；只有非默认选择增加字段。 */
export function syncModelBinding(model?: string): { model?: string } {
  return model === undefined || model === DEFAULT_SYNC_MODEL ? {} : { model }
}

/** 新工作树执行只使用明确的真实Claude/ZCode CLI，历史缺省模型身份保持。 */
export function assertWorktreeSyncModel(model: string): void {
  if (!/^claude:.+/.test(model) && !/^zcode:[^/]+\/.+/.test(model)) throw Object.assign(new Error('native-worktree同步需要明确的claude:<exact-model>或zcode:<provider>/<exact-model>；当前模型不支持该工作流，不自动回退'), { code: 'unsupported' })
}
