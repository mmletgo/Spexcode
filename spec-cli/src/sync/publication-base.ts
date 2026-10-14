import type { ComposedInputRef, PublicationBase, PublicationHeads, SyncAttempt, SyncOperation } from './operation-types.js'
import type { SyncStore } from './store.js'
import { contentHash, objectGit, readEvidence, readTree, validateRepositoryPath, verifySnapshot, writeEvidence, writeTree } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

export type PublicationProvenance = {
  version: 'sync-publication-base-v1'; operationId: string; attemptId: string; sourceInputId: string
  originalComposed: ComposedInputRef; readSetDigest: string; readPaths: string[]; writePaths: string[]
  heads: PublicationHeads
  paths: { path: string; pairId: string; receiptId: string; delivered: TreeEntry | null; selected: TreeEntry | null; cause: 'settled_delivery' | 'current_head' }[]
  parentCommit: string; parentTree: string; parentManifestBlob: PublicationBase['parentManifestBlob']; composed: ComposedInputRef
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const within = (path: string, paths: readonly string[]): boolean => paths.some(parent => path === parent || path.startsWith(`${parent}/`))
const canonical = (paths: readonly string[]): string[] => [...new Set(paths.map(validateRepositoryPath))].sort()
function composedEntries(commonDir: string, composed: ComposedInputRef): TreeEntry[] {
  const entries = readTree(commonDir, composed.tree)
  if (contentHash(JSON.stringify(entries)) !== composed.contentDigest || readEvidence(commonDir, composed.manifestBlob).toString() !== JSON.stringify({ version: 1, entries })) throw new Error('SYNC_PUBLICATION_BASE_BINDING: composed manifest differs from actual tree')
  return entries
}
/** 发布父树只继承同来源真实已结算对象；只读冻结字节作为输入携带，不成为本轮写入。 */
function publicationImage(operation: SyncOperation, composed: ComposedInputRef, heads: PublicationHeads, readPaths: readonly string[], writePaths: readonly string[]): { parent: TreeEntry[]; candidate: TreeEntry[]; paths: PublicationProvenance['paths'] } {
  const commonDir = operation.input.source.commonDir, source = operation.input.source
  const headTree = objectGit(commonDir, ['rev-parse', `${operation.input.headCommit}^{tree}`]).toString().trim()
  const current = new Map(readTree(commonDir, headTree).map(entry => [entry.path, entry])), image = new Map(current), paths: PublicationProvenance['paths'] = []
  const pairImages = new Map<string, { delivery: Map<string, TreeEntry>; head: Map<string, TreeEntry> }>()
  if (!same(heads.selection.source, source)) throw new Error('SYNC_PUBLICATION_BASE_BINDING: foreign source frontier')
  for (const binding of heads.selection.bindings) {
    if (binding.resource.kind !== 'path' || !('bytePair' in binding) || !binding.bytePair) throw new Error('SYNC_PUBLICATION_BASE_BINDING: publication frontier requires settled path pairs')
    const path = validateRepositoryPath(binding.resource.path), pair = binding.bytePair
    if (!same(pair.source, source) || pair.repositoryId !== source.repositoryId || !within(path, pair.coveredScope.paths)) throw new Error('SYNC_PUBLICATION_BASE_BINDING: foreign or uncovered path pair')
    let pairImage = pairImages.get(pair.id)
    if (!pairImage) {
      const delivery = new Map(verifySnapshot(pair.verifiedDelivery).map(entry => [entry.path, entry]))
      verifySnapshot(pair.sourceInput)
      const originalHead = objectGit(commonDir, ['rev-parse', `${pair.sourceInput.headCommit}^{tree}`]).toString().trim()
      pairImage = { delivery, head: originalHead === headTree ? current : new Map(readTree(commonDir, originalHead).map(entry => [entry.path, entry])) }; pairImages.set(pair.id, pairImage)
    }
    const delivered = pairImage.delivery.get(path) ?? null, original = pairImage.head.get(path) ?? null, head = current.get(path) ?? null
    const inherited = same(head, original) || same(head, delivered), selected = inherited ? delivered : head
    if (selected) image.set(path, selected); else image.delete(path)
    paths.push({ path, pairId: pair.id, receiptId: pair.receiptId, delivered, selected, cause: inherited ? 'settled_delivery' : 'current_head' })
  }
  const original = composedEntries(commonDir, composed), originalMap = new Map(original.map(entry => [entry.path, entry]))
  // 写路径保留真实已结算/HEAD preimage；只读路径的输入在父树中已存在，apply 不冒领它们。
  for (const path of new Set([...image.keys(), ...originalMap.keys()])) if (within(path, readPaths) && !within(path, writePaths)) {
    const entry = originalMap.get(path)
    if (entry) image.set(path, entry); else image.delete(path)
  }
  const parent = [...image.values()]
  for (const path of new Set([...image.keys(), ...originalMap.keys()])) if (within(path, [...readPaths, ...writePaths])) {
    const entry = originalMap.get(path)
    if (entry) image.set(path, entry); else image.delete(path)
  }
  return { parent, candidate: [...image.values()], paths }
}

/** 只在来源发布锁内调用；恢复使用已冻结记录，不重新读取最新 frontier。 */
export function assemblePublicationBase(store: SyncStore, operation: SyncOperation, attempt: SyncAttempt, viewComposed: ComposedInputRef, readPaths: readonly string[]): PublicationBase {
  if (attempt.publicationBase) return attempt.publicationBase
  if (!operation.baselineSelection || attempt.operationId !== operation.id || !attempt.composedInput || !same(attempt.composedInput, viewComposed)) throw new Error('SYNC_PUBLICATION_BASE_BINDING: original frozen composition required')
  const commonDir = operation.input.source.commonDir, reads = canonical(readPaths), writes = canonical(operation.readyScope.paths), heads = store.readPublicationHeads(operation.input.source)
  const image = publicationImage(operation, viewComposed, heads, reads, writes), parentTree = writeTree(commonDir, image.parent), tree = writeTree(commonDir, image.candidate)
  const entries = readTree(commonDir, tree), parentManifestBlob = writeEvidence(commonDir, { version: 1, entries: readTree(commonDir, parentTree) })
  const composed = { ...viewComposed, tree, manifestBlob: writeEvidence(commonDir, { version: 1, entries }), contentDigest: contentHash(JSON.stringify(entries)) }
  const headTree = objectGit(commonDir, ['rev-parse', `${operation.input.headCommit}^{tree}`]).toString().trim()
  const parentCommit = parentTree === headTree ? operation.input.headCommit : objectGit(commonDir, ['-c', 'user.name=SpexCode input', '-c', 'user.email=publication-input@spexcode.invalid', 'commit-tree', parentTree, '-p', operation.input.headCommit], Buffer.from(`SpexCode frozen publication input\n\nOperation: ${operation.id}\nAttempt: ${attempt.id}\n`)).toString().trim()
  const provenance: PublicationProvenance = { version: 'sync-publication-base-v1', operationId: operation.id, attemptId: attempt.id, sourceInputId: operation.input.id, originalComposed: viewComposed, readSetDigest: operation.readSetDigest, readPaths: reads, writePaths: writes, heads, paths: image.paths, parentCommit, parentTree, parentManifestBlob, composed }
  const provenanceBlob = writeEvidence(commonDir, provenance)
  objectGit(commonDir, ['update-ref', `refs/spex-sync/publication-bases/${provenanceBlob.sha256}`, parentCommit])
  objectGit(commonDir, ['update-ref', `refs/spex-sync/publication-compositions/${provenanceBlob.sha256}`, tree])
  return { parentCommit, parentTree, parentManifestBlob, provenanceBlob, composed }
}

/** 事务外核验全部实际 Git 对象、逐路径来源和完整读闭包，包括不存在路径。 */
export function verifyPublicationBase(operation: SyncOperation, attempt: SyncAttempt, base: PublicationBase): PublicationProvenance {
  const commonDir = operation.input.source.commonDir, evidence = JSON.parse(readEvidence(commonDir, base.provenanceBlob).toString()) as PublicationProvenance
  if (evidence.version !== 'sync-publication-base-v1' || evidence.operationId !== operation.id || evidence.attemptId !== attempt.id || evidence.sourceInputId !== operation.input.id || evidence.readSetDigest !== operation.readSetDigest || !attempt.composedInput || !same(evidence.originalComposed, attempt.composedInput) || !same(evidence.writePaths, canonical(operation.readyScope.paths)) || !same(evidence.readPaths, canonical(evidence.readPaths)) || !same({ parentCommit: evidence.parentCommit, parentTree: evidence.parentTree, parentManifestBlob: evidence.parentManifestBlob, composed: evidence.composed }, { parentCommit: base.parentCommit, parentTree: base.parentTree, parentManifestBlob: base.parentManifestBlob, composed: base.composed })) throw new Error('SYNC_PUBLICATION_BASE_BINDING: frozen identity or provenance differs')
  if (operation.planBlob) {
    const plan = JSON.parse(readEvidence(commonDir, operation.planBlob).toString()) as { readPaths: string[] }
    if (plan.readPaths.some(path => !evidence.readPaths.includes(path))) throw new Error('SYNC_PUBLICATION_BASE_BINDING: declared read closure omitted')
  }
  const image = publicationImage(operation, attempt.composedInput, evidence.heads, evidence.readPaths, evidence.writePaths)
  if (!same(image.paths, evidence.paths) || writeTree(commonDir, image.parent) !== base.parentTree || writeTree(commonDir, image.candidate) !== base.composed.tree) throw new Error('SYNC_PUBLICATION_BASE_BINDING: actual publication images differ')
  const parentEntries = readTree(commonDir, base.parentTree)
  if (readEvidence(commonDir, base.parentManifestBlob).toString() !== JSON.stringify({ version: 1, entries: parentEntries }) || objectGit(commonDir, ['rev-parse', `${base.parentCommit}^{tree}`]).toString().trim() !== base.parentTree) throw new Error('SYNC_PUBLICATION_BASE_BINDING: actual parent differs')
  const headTree = objectGit(commonDir, ['rev-parse', `${operation.input.headCommit}^{tree}`]).toString().trim()
  if (base.parentCommit !== operation.input.headCommit && (base.parentTree === headTree || objectGit(commonDir, ['show', '-s', '--format=%P', base.parentCommit]).toString().trim() !== operation.input.headCommit)) throw new Error('SYNC_PUBLICATION_BASE_BINDING: metadata parent differs')
  composedEntries(commonDir, base.composed)
  const { tree: _tree, manifestBlob: _manifest, contentDigest: _content, ...originalIdentity } = attempt.composedInput
  const { tree: _baseTree, manifestBlob: _baseManifest, contentDigest: _baseContent, ...baseIdentity } = base.composed
  if (!same(originalIdentity, baseIdentity)) throw new Error('SYNC_PUBLICATION_BASE_BINDING: original composition identity changed')
  return evidence
}
