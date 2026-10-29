import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export type BodyReference = { bodyRef: string }
type ProjectedText = Record<string, unknown> & { bodyRef?: string }
type BodyLocator = { entryId: string; kind: string; encoding?: 'json-string-v1' | 'json-object-v1'; sha256: string; byteLength: number; contentByteLength?: number; required?: boolean }
export type FrozenBehaviorEntry = { id: string; kind: string; text?: string; required?: boolean }
type FrozenBehaviorSource = string | { prompt: string; frozenEntries?: readonly FrozenBehaviorEntry[] }

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

/** 按 bodyIndex 从纯 JSON frozenEntries 取回完整 UTF-8，并核对 SHA 与字节长度。 */
export function frozenBodyText(source: { prompt: string; frozenEntries?: readonly FrozenBehaviorEntry[] }, bodyRef: string): string {
  const contextText = source.prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]
  const context = JSON.parse(contextText) as { textBodies?: Record<string, string>; bodyIndex?: Record<string, BodyLocator> }
  const inline = context.textBodies?.[bodyRef]
  const locator = context.bodyIndex?.[bodyRef]
  const entry = source.frozenEntries?.find(item => item.kind === 'utf8' && item.id === (locator?.entryId ?? bodyRef))
  const payload = typeof inline === 'string' ? inline : entry?.text
  const decoded: unknown = locator?.encoding && typeof payload === 'string' ? JSON.parse(payload) : payload
  const text = locator?.encoding === 'json-object-v1' ? (decoded as Record<string, string>)[bodyRef] : decoded
  if (typeof text !== 'string') assert.fail(`缺少冻结正文引用 ${bodyRef}`)
  assert.equal(sha256(text), bodyRef, `冻结正文与 bodyRef 不一致 ${bodyRef}`)
  if (locator) {
    assert.equal(locator.kind, 'utf8')
    assert.equal(locator.sha256, sha256(payload!))
    assert.equal(locator.entryId, entry?.id ?? bodyRef)
    assert.equal(locator.byteLength, Buffer.byteLength(payload!, 'utf8'))
    if (locator.contentByteLength !== undefined) assert.equal(locator.contentByteLength, Buffer.byteLength(text, 'utf8'))
  }
  return text
}

/** 仅供冻结行为分析的测试 runner 把 wire 正文引用还原为原逻辑上下文。 */
export function readFrozenBehaviorContext<T>(source: FrozenBehaviorSource): T {
  const prompt = typeof source === 'string' ? source : source.prompt
  const entries = typeof source === 'string' ? undefined : source.frozenEntries
  const contextText = prompt.split('冻结三方输入:\n')[1].split('\n待审分析:')[0]
  const context = JSON.parse(contextText) as Record<string, unknown>
  if (!['sha256-body-ref-v1', 'sha256-body-entry-v2'].includes(context.textEncoding as string)) return context as T
  const textBodies = context.textBodies as Record<string, string> | undefined
  const expand = (value: string | BodyReference): string => {
    if (typeof value === 'string') return value
    if (textBodies && typeof textBodies[value.bodyRef] === 'string') {
      assert.equal(sha256(textBodies[value.bodyRef]), value.bodyRef)
      return textBodies[value.bodyRef]
    }
    return frozenBodyText({ prompt, frozenEntries: entries }, value.bodyRef)
  }
  for (const key of ['oldSource', 'newSource', 'authorBaseline', 'verifiedDelivery', 'composedFiles', 'controlledBeforeFiles']) {
    context[key] = (context[key] as [string, string | BodyReference][]).map(([path, value]) => [path, expand(value)])
  }
  context.nonTextFiles = (context.nonTextFiles as (Record<string, unknown> & { content?: string; bodyRef?: string })[]).map(({ bodyRef, ...file }) => bodyRef ? { ...file, content: expand({ bodyRef }) } : file)
  context.intentArtifactFiles = (context.intentArtifactFiles as ProjectedText[]).map(({ bodyRef, ...entry }) => bodyRef ? { ...entry, text: expand({ bodyRef }) } : entry)
  context.authorByteProjections = (context.authorByteProjections as { snapshotId: string; path: string; before: ProjectedText; after: ProjectedText }[]).map(({ before, after, ...projection }) => {
    const expandProjection = ({ bodyRef, ...entry }: ProjectedText): Record<string, unknown> => bodyRef ? { ...entry, text: expand({ bodyRef }) } : entry
    return { ...projection, before: expandProjection(before), after: expandProjection(after) }
  })
  delete context.textEncoding
  delete context.textBodies
  delete context.bodyIndex
  return context as T
}
