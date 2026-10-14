import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BaselinePair, ComposedInputRef, InputSnapshot } from './operation-types.js'
import { contentHash, objectGit, readObject, readTree, verifySnapshot, writeEvidence, writeObject, writeTree } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

export type CompositionConflict = { path: string; base: TreeEntry | null; source: TreeEntry | null; delivery: TreeEntry | null }
export const isUtf8Text = (bytes: Buffer): boolean => !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes)
const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean => a?.oid === b?.oid && a?.mode === b?.mode

/** 已验证交付被来源 Git 采纳后，以实际已提交的覆盖路径作为作者差量基准。 */
export function adoptedDeliveryPaths(source: InputSnapshot, prior?: BaselinePair | null): Set<string> {
  if (!prior) return new Set()
  try { objectGit(source.source.commonDir, ['merge-base', '--is-ancestor', prior.verifiedDelivery.headCommit, source.headCommit]) }
  catch (error) { if ((error as { status?: number }).status === 1) return new Set(); throw error }
  const committed = new Map(readTree(source.source.commonDir, objectGit(source.source.commonDir, ['rev-parse', `${prior.verifiedDelivery.headCommit}^{tree}`]).toString().trim()).map(entry => [entry.path, entry]))
  const delivered = new Map(verifySnapshot(prior.verifiedDelivery).map(entry => [entry.path, entry]))
  const paths = new Set([...verifySnapshot(prior.sourceInput).map(entry => entry.path), ...delivered.keys()])
  return new Set([...paths].filter(path => same(delivered.get(path), committed.get(path)) && prior.coveredScope.paths.some(scope => path === scope || path.startsWith(`${scope}/`))))
}

/** source 的真实差量叠加到前次已验证 delivery；任何重叠歧义保留三方对象而不自动覆盖。 */
export function composeInputSnapshots(newSource: InputSnapshot, prior?: BaselinePair | null, options: { projectEntries?: (snapshot: InputSnapshot, entries: TreeEntry[]) => TreeEntry[]; retainConflicts?: boolean } = {}): { composed: ComposedInputRef | null; conflicts: CompositionConflict[] } {
  const project = (snapshot: InputSnapshot): TreeEntry[] => { const entries = verifySnapshot(snapshot); return options.projectEntries ? options.projectEntries(snapshot, entries) : entries }
  const commonDir = newSource.source.commonDir, incoming = project(newSource)
  let entries = incoming
  const conflicts: CompositionConflict[] = []
  if (prior) {
    if (JSON.stringify(prior.source) !== JSON.stringify(prior.sourceInput.source) || JSON.stringify(newSource.source) !== JSON.stringify(prior.sourceInput.source) || prior.repositoryId !== newSource.source.repositoryId || prior.verifiedDelivery.source.repositoryId !== newSource.source.repositoryId || prior.verifiedDelivery.source.commonDir !== commonDir) throw new Error('成对基线不属于当前来源物理身份/分支/仓库')
    const base = new Map(project(prior.sourceInput).map(entry => [entry.path, entry]))
    const delivery = new Map(project(prior.verifiedDelivery).map(entry => [entry.path, entry]))
    const source = new Map(incoming.map(entry => [entry.path, entry]))
    const adopted = adoptedDeliveryPaths(newSource, prior)
    const result = new Map(delivery)
    for (const path of new Set([...base.keys(), ...source.keys(), ...delivery.keys()])) {
      const old = adopted.has(path) ? delivery.get(path) : base.get(path), next = source.get(path), delivered = delivery.get(path)
      // 成对基线只证明已交付 scope，未覆盖的旧来源编辑仍是待生成输入。
      if (!prior.coveredScope.paths.some(scope => path === scope || path.startsWith(`${scope}/`))) {
        if (next) result.set(path, next); else result.delete(path)
        continue
      }
      if (same(old, next)) continue
      if (same(old, delivered) || same(next, delivered)) { if (next) result.set(path, next); else result.delete(path); continue }
      if (old && next && delivered && [old.mode, next.mode, delivered.mode].every(mode => mode !== '120000')) {
        const mode = next.mode === old.mode ? delivered.mode : delivered.mode === old.mode || next.mode === delivered.mode ? next.mode : null
        const merged = mode ? mergeText(commonDir, delivered, old, next) : null
        if (merged && mode) { result.set(path, { path, mode, oid: writeObject(commonDir, merged), digest: contentHash(merged) }); continue }
      }
      if (options.retainConflicts) { if (next) result.set(path, next); else result.delete(path) }
      conflicts.push({ path, base: old ?? null, source: next ?? null, delivery: delivered ?? null })
    }
    entries = [...result.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    // 两边分别引入同一文件/目录位置也属于真实路径冲突。
    for (const entry of entries) {
      const ancestor = entries.find(other => entry.path.startsWith(`${other.path}/`))
      if (ancestor && !conflicts.some(conflict => conflict.path === entry.path)) conflicts.push({ path: entry.path, base: base.get(entry.path) ?? null, source: source.get(entry.path) ?? null, delivery: delivery.get(entry.path) ?? null })
    }
  }
  if (conflicts.length && !options.retainConflicts) return { composed: null, conflicts }
  const tree = writeTree(commonDir, entries), contentDigest = contentHash(JSON.stringify(entries)), manifestBlob = writeEvidence(commonDir, { version: 1, entries })
  objectGit(commonDir, ['update-ref', `refs/spex-sync/compositions/${tree}`, tree])
  return { composed: { sourceInputId: newSource.id, previousBaselinePairId: prior?.id ?? null, tree, manifestBlob, contentDigest, ...(conflicts.length ? { compositionEvidenceBlob: writeEvidence(commonDir, { version: 'composition-overlap-v1', sourceInputId: newSource.id, baselinePairId: prior?.id ?? null, conflicts }) } : {}) }, conflicts }
}
export function mergeText(commonDir: string, delivery: TreeEntry, base: TreeEntry, source: TreeEntry): Buffer | null {
  const buffers = [delivery, base, source].map(entry => readObject(commonDir, entry.oid))
  if (!buffers.every(isUtf8Text)) return null
  const temp = mkdtempSync(join(tmpdir(), 'spex-sync-merge-'))
  try {
    const files = buffers.map((bytes, index) => { const file = join(temp, String(index)); writeFileSync(file, bytes); return file })
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'merge-file', '-p', '--diff3', ...files], { maxBuffer: 128 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status === 0) return result.stdout
    if (result.status !== null && result.status >= 1 && result.status <= 127) return null
    throw new Error(`三方合并失败: ${result.stderr.toString()}`)
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
