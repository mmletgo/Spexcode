import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isHostPrivatePath } from './candidate.js'
import { isUtf8Text } from './composition.js'
import type { InputSnapshot, WorktreeIdentity } from './operation-types.js'
import { canonicalSnapshotSource, contentHash, identifyWorktree, objectGit, verifySnapshot, type TreeEntry } from './snapshot.js'
import { isSourceCommitAncestor } from './source-adoption.js'

type Freeze = { inputId: string; commit: string; tree: string }
type GitFile = Pick<TreeEntry, 'mode' | 'oid'>
export type CrossFreezeProvenance = {
  version: 'cross-freeze-provenance-v1'
  source: WorktreeIdentity
  previous: Freeze
  current: Freeze
  changes: { path: string; before: GitFile | null; after: GitFile | null }[]
  patch: string
  digest: string
}

const MAX_EVIDENCE_BYTES = 1024 * 1024
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const binding = (input: InputSnapshot): Freeze => ({ inputId: input.id, commit: input.headCommit, tree: input.immutableTree })
const objectEntry = (entry: TreeEntry): GitFile => ({ mode: entry.mode, oid: entry.oid })
const gitText = (commonDir: string, args: string[]): string => objectGit(commonDir, args).toString().trim()

function hasOriginalHistory(source: WorktreeIdentity): boolean {
  return isDeepStrictEqual(identifyWorktree(source.canonicalRoot), source)
    && !lstatSync(join(source.commonDir, 'info', 'grafts'), { throwIfNoEntry: false })
    && gitText(source.commonDir, ['rev-parse', '--is-shallow-repository']) === 'false'
}

function exactTree(input: InputSnapshot): boolean {
  const { headCommit, immutableTree, indexTree, source: { commonDir } } = input
  return oid.test(headCommit) && oid.test(immutableTree) && indexTree === immutableTree
    && gitText(commonDir, ['rev-parse', '--verify', `${headCommit}^{commit}`]) === headCommit
    && gitText(commonDir, ['rev-parse', '--verify', `${headCommit}^{tree}`]) === immutableTree
}

function changesEmptyDirectory(commonDir: string, beforeTree: string, afterTree: string): boolean {
  const emptyTree = objectGit(commonDir, ['hash-object', '-t', 'tree', '--stdin'], Buffer.alloc(0)).toString().trim()
  const raw = objectGit(commonDir, ['diff-tree', '-r', '-t', '--raw', '-z', '--no-abbrev', '--no-commit-id',
    '--no-renames', '--ignore-submodules=none', beforeTree, afterTree, '--'])
  // Git 补丁只能表达文件。拒绝 plumbing 在 tree 中保存但无法纳入补丁的空目录。
  return raw.toString('utf8').split('\0').some((record, index) => index % 2 === 0 && record.split(' ').includes(emptyTree))
}

/** 提供两次冻结间供当前独审逐项核对的完整 Git 差量。 */
export function deriveCrossFreezeProvenance(previous: InputSnapshot, current: InputSnapshot): CrossFreezeProvenance | null {
  const source = canonicalSnapshotSource(current.source), { commonDir } = source
  if (previous.headCommit === current.headCommit || !isDeepStrictEqual(previous.source, source)
    || !hasOriginalHistory(source) || !exactTree(previous) || !exactTree(current)
    || !isSourceCommitAncestor(commonDir, previous.headCommit, current.headCommit)) return null

  const before = new Map(verifySnapshot(previous).map(entry => [entry.path, objectEntry(entry)]))
  const after = new Map(verifySnapshot(current).map(entry => [entry.path, objectEntry(entry)]))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  const changes = paths.flatMap(path => {
    const oldEntry = before.get(path) ?? null, newEntry = after.get(path) ?? null
    return oldEntry?.oid === newEntry?.oid && oldEntry?.mode === newEntry?.mode
      ? [] : [{ path, before: oldEntry, after: newEntry }]
  })
  if (changes.some(change => isHostPrivatePath(change.path)) || Buffer.byteLength(JSON.stringify(changes)) > MAX_EVIDENCE_BYTES) return null
  if (previous.immutableTree !== current.immutableTree
    && (!changes.length || changesEmptyDirectory(commonDir, previous.immutableTree, current.immutableTree))) return null

  const patch = objectGit(commonDir, ['diff', '--binary', '--full-index', '--no-renames', '--no-relative',
    '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none', '-O/dev/null',
    '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0',
    previous.immutableTree, current.immutableTree, '--'])
  if (patch.length > MAX_EVIDENCE_BYTES || !isUtf8Text(patch)
    || (patch.length === 0) !== (changes.length === 0) || !hasOriginalHistory(source)) return null
  const body = {
    version: 'cross-freeze-provenance-v1' as const, source, previous: binding(previous), current: binding(current), changes, patch: patch.toString('utf8'),
  }
  const encoded = JSON.stringify(body)
  return Buffer.byteLength(encoded) <= MAX_EVIDENCE_BYTES ? { ...body, digest: contentHash(encoded) } : null
}
