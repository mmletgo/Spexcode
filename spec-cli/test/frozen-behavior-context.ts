import assert from 'node:assert/strict'

export type BodyReference = { bodyRef: string }
type ProjectedText = Record<string, unknown> & { bodyRef?: string }

/** 仅供冻结行为分析的测试runner把wire正文引用还原为原逻辑上下文。 */
export function readFrozenBehaviorContext<T>(prompt: string): T {
  const contextText = prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]
  const context = JSON.parse(contextText) as Record<string, unknown>
  if (context.textEncoding !== 'sha256-body-ref-v1') return context as T
  const textBodies = context.textBodies as Record<string, string>
  const expand = (value: string | BodyReference): string => {
    if (typeof value === 'string') return value
    const text = textBodies[value.bodyRef]
    assert.equal(typeof text, 'string', `缺少冻结正文引用 ${value.bodyRef}`)
    return text
  }
  for (const key of ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles']) {
    context[key] = (context[key] as [string, string | BodyReference][]).map(([path, value]) => [path, expand(value)])
  }
  context.intentArtifactFiles = (context.intentArtifactFiles as ProjectedText[]).map(({ bodyRef, ...entry }) => bodyRef ? { ...entry, text: expand({ bodyRef }) } : entry)
  context.authorByteProjections = (context.authorByteProjections as { snapshotId: string; path: string; before: ProjectedText; after: ProjectedText }[]).map(({ before, after, ...projection }) => {
    const expandProjection = ({ bodyRef, ...entry }: ProjectedText): Record<string, unknown> => bodyRef ? { ...entry, text: expand({ bodyRef }) } : entry
    return { ...projection, before: expandProjection(before), after: expandProjection(after) }
  })
  delete context.textEncoding
  delete context.textBodies
  return context as T
}
