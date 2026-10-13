import { Ajv } from 'ajv'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ApplyFilePlan, CandidateRef, ComposedInputRef, InputSnapshot, SyncScope } from './operation-types.js'
import { isUtf8Text } from './composition.js'
import { contentHash, objectGit, readEvidence, readObject, readTree, safeSymlinkTarget, validateRepositoryPath, verifySnapshot, writeEvidence, writeObject, writeTree } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'

type FileChange = { path: string; beforeDigest: string | null; beforeMode: TreeEntry['mode'] | null; content: string | null; mode?: '100644' | '100755' | null }
export type CandidateChanges = { version: 'sync-files-v1'; changes: FileChange[] }
export const CANDIDATE_CHANGES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'changes'], properties: {
    version: { type: 'string', const: 'sync-files-v1' }, changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'beforeDigest', 'beforeMode', 'content'], properties: {
      path: { type: 'string', minLength: 1 }, beforeDigest: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{64}$' }, { type: 'null' }] }, beforeMode: { type: ['string', 'null'], enum: ['100644', '100755', '120000', null] }, content: { type: ['string', 'null'] }, mode: { type: ['string', 'null'], enum: ['100644', '100755', null] },
    } } },
  },
} as const
export const CANDIDATE_RESPONSE_SCHEMA = { ...CANDIDATE_CHANGES_SCHEMA, properties: {
  ...CANDIDATE_CHANGES_SCHEMA.properties,
  changes: { ...CANDIDATE_CHANGES_SCHEMA.properties.changes, items: {
    ...CANDIDATE_CHANGES_SCHEMA.properties.changes.items,
    required: Object.keys(CANDIDATE_CHANGES_SCHEMA.properties.changes.items.properties),
  } },
} }
const validateChanges = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(CANDIDATE_CHANGES_SCHEMA)
export function actualTreeDiff(before: TreeEntry[], after: TreeEntry[]): ApplyFilePlan[] {
  const old = new Map(before.map(entry => [entry.path, entry])), next = new Map(after.map(entry => [entry.path, entry]))
  return [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => old.get(path)?.oid !== next.get(path)?.oid || old.get(path)?.mode !== next.get(path)?.mode).map(path => ({ path, preDigest: old.get(path)?.digest ?? null, postDigest: next.get(path)?.digest ?? null, preMode: old.get(path)?.mode ?? null, postMode: next.get(path)?.mode ?? null }))
}
const withinScope = (path: string, allowed: string[]): boolean => allowed.some(scope => path === scope || path.startsWith(`${scope}/`))
const candidateDigest = (candidate: Omit<CandidateRef, 'digest'>): string => contentHash(JSON.stringify(candidate))
export function pinCandidate(commonDir: string, candidate: CandidateRef): void {
  verifyCandidate(commonDir, candidate)
  objectGit(commonDir, ['update-ref', `refs/spex-sync/candidates/${candidate.digest}`, candidate.tree])
}
/** 唯一协调写方把结构化文件数据冻结为 Git tree；全部实际 diff 重新检查 scope 和 CAS。 */
export function freezeCandidate(input: InputSnapshot, changes: unknown, allowedScope: SyncScope, composed?: ComposedInputRef): CandidateRef {
  if (!validateChanges(changes)) throw new Error(`候选文件 schema 不合法: ${JSON.stringify(validateChanges.errors)}`)
  const commonDir = input.source.commonDir
  verifySnapshot(input)
  let before = readTree(commonDir, input.immutableTree)
  if (composed) {
    if (composed.sourceInputId !== input.id) throw new Error('组合输入不属于当前 source snapshot')
    before = readTree(commonDir, composed.tree)
    if (contentHash(JSON.stringify(before)) !== composed.contentDigest || readEvidence(commonDir, composed.manifestBlob).toString() !== JSON.stringify({ version: 1, entries: before })) throw new Error('组合输入 manifest 摘要不匹配')
  }
  const allowedPaths = allowedScope.paths.map(validateRepositoryPath), entries = new Map(before.map(entry => [entry.path, entry])), seen = new Set<string>()
  for (const change of (changes as CandidateChanges).changes) {
    const path = validateRepositoryPath(change.path)
    if (seen.has(path)) throw new Error(`重复候选路径: ${path}`)
    seen.add(path)
    const previous = entries.get(path)
    if ((previous?.digest ?? null) !== change.beforeDigest || (previous?.mode ?? null) !== change.beforeMode) throw new Error(`候选 CAS 不匹配: ${path}`)
    if (!withinScope(path, allowedPaths)) throw new Error(`候选实际修改越界: ${path}`)
    const parents = path.split('/').slice(0, -1)
    for (let count = 1; count <= parents.length; count++) if (entries.has(parents.slice(0, count).join('/'))) throw new Error(`候选父路径不是目录: ${path}`)
    if (change.content === null) { if (!previous) throw new Error(`不能删除不存在的文件: ${path}`); entries.delete(path); continue }
    if (previous?.mode === '120000' || (previous && !isUtf8Text(readObject(commonDir, previous.oid)))) throw new Error(`结构化修改仅支持 UTF-8 普通文件: ${path}`)
    const bytes = Buffer.from(change.content)
    if (!isUtf8Text(bytes) || bytes.toString() !== change.content) throw new Error(`候选必须为有效 UTF-8 文本: ${path}`)
    if ([...entries.keys()].some(other => other.startsWith(`${path}/`))) throw new Error(`候选文件覆盖目录: ${path}`)
    entries.set(path, { path, mode: change.mode ?? previous?.mode ?? '100644', oid: writeObject(commonDir, bytes), digest: contentHash(bytes) })
  }
  const tree = writeTree(commonDir, [...entries.values()]), after = readTree(commonDir, tree), actualDiff = actualTreeDiff(before, after)
  if (actualDiff.some(file => !withinScope(file.path, allowedPaths))) throw new Error('候选完整实际 diff 越界')
  const ref = { tree, baseTree: composed?.tree ?? input.immutableTree, sourceInputId: input.id, manifestBlob: writeEvidence(commonDir, { version: 1, entries: after }), actualDiffBlob: writeEvidence(commonDir, actualDiff), coveredScope: { paths: [...new Set(allowedPaths)].sort(), contractIds: [...new Set(allowedScope.contractIds)].sort(), flowIds: [...new Set(allowedScope.flowIds)].sort() } }
  const candidate = { ...ref, digest: candidateDigest(ref) }
  pinCandidate(commonDir, candidate)
  return candidate
}
export function verifyCandidate(commonDir: string, candidate: CandidateRef): TreeEntry[] {
  const { digest, ...ref } = candidate
  const entries = readTree(commonDir, candidate.tree)
  if (candidateDigest(ref) !== digest || readEvidence(commonDir, candidate.manifestBlob).toString() !== JSON.stringify({ version: 1, entries })) throw new Error('候选摘要/manifest 不匹配')
  const diff = actualTreeDiff(readTree(commonDir, candidate.baseTree), entries)
  if (readEvidence(commonDir, candidate.actualDiffBlob).toString() !== JSON.stringify(diff) || diff.some(file => !withinScope(file.path, candidate.coveredScope.paths))) throw new Error('候选实际 diff/范围不匹配真实 Git tree')
  return entries
}
export const isHostPrivatePath = (path: string): boolean => path.split('/').some(part => part === 'node_modules' || part === '.git' || part === '.ssh') || /(^|\/)\.(env(?:\..*)?|npmrc|netrc)$/.test(path) || path.startsWith('.spex/runtime/')
/** 只向新的独立验证目录导出不可变 bytes，不带 Git、认证文件或共享运行依赖。 */
export function exportCandidate(commonDir: string, candidate: CandidateRef, target: string): { root: string; excludedPaths: string[]; exclusionBlob: { sha256: string } } {
  const entries = verifyCandidate(commonDir, candidate)
  if (existsSync(target)) { if (lstatSync(target).isSymbolicLink() || readdirSync(target).length) throw new Error('验证目录必须为空且不是符号链接') }
  else mkdirSync(target, { recursive: true })
  const root = realpathSync(target), excludedPaths = entries.filter(entry => isHostPrivatePath(entry.path)).map(entry => entry.path), directories = new Set<string>([root])
  const exported = entries.filter(entry => !isHostPrivatePath(entry.path))
  // 先完整校验链接，避免导出半途才发现越界或链式逃逸。
  for (const entry of exported.filter(item => item.mode === '120000')) {
    const targetPath = readObject(commonDir, entry.oid).toString()
    safeSymlinkTarget(root, entry.path, targetPath)
    const linkPath = join(dirname(entry.path), targetPath)
    if (isHostPrivatePath(linkPath)) throw new Error(`符号链接指向禁止的运行/认证文件: ${entry.path}`)
  }
  for (const entry of exported) {
    const absolute = join(root, entry.path)
    let parent = dirname(absolute)
    while (parent !== root) { directories.add(parent); parent = dirname(parent) }
    mkdirSync(dirname(absolute), { recursive: true })
    const bytes = readObject(commonDir, entry.oid)
    if (entry.mode === '120000') symlinkSync(bytes.toString(), absolute)
    else { writeFileSync(absolute, bytes, { flag: 'wx' }); chmodSync(absolute, entry.mode === '100755' ? 0o555 : 0o444) }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o555)
  return { root, excludedPaths, exclusionBlob: writeEvidence(commonDir, { version: 1, candidateDigest: candidate.digest, excludedEntries: entries.filter(entry => excludedPaths.includes(entry.path)), reason: 'host-credentials-or-runtime' }) }
}
