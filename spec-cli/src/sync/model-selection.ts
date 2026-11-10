export const DEFAULT_SYNC_MODEL = 'gpt-6.1-sol'
export const DEFAULT_NATIVE_SYNC_MODEL = 'claude:default'

/** 新操作可按工作流取CLI默认；读取历史操作时省略该参数，保原缺省身份。 */
export function syncModel(input: { model?: string }, nativeWorkflow = false): string { return input.model ?? (nativeWorkflow ? DEFAULT_NATIVE_SYNC_MODEL : DEFAULT_SYNC_MODEL) }

/** 默认选择保留原持久载荷字节；只有非默认选择增加字段。 */
export function syncModelBinding(model?: string): { model?: string } {
  return model === undefined || model === DEFAULT_SYNC_MODEL ? {} : { model }
}

/** 仅选择CLI执行器；模型和别名交给原生配置解析，不设模型允许名册。 */
export function assertWorktreeSyncModel(model: string): void {
  if (!['claude:', 'zcode:', 'grok:'].some(prefix => model.startsWith(prefix) && model.length > prefix.length)) throw Object.assign(new Error('native-worktree同步需要选择claude:、zcode:或grok:执行器；可用default沿用CLI配置或指定模型'), { code: 'unsupported' })
}
