import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseContract, parseParts } from '@spexcode/spec-core/contracts'
import type { ContractItem } from '@spexcode/spec-core/contracts'
import { contractBusinessMeaning, contractBusinessProse, sameContractBusinessMeaning } from './contract-evolution.js'
import { canonicalContractFilterBindings, cleanCanonicalContractText } from '../contract-filter.js'
import type { BaselinePair, BaselineResource, BlobRef, ComposedInputRef, FrozenBaselineSelection, InputSnapshot } from './operation-types.js'
import { contentHash, objectGit, readEvidence, readObject, readTree, verifySnapshot, writeEvidence, writeObject, writeTree } from './snapshot.js'
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
export type CompositionOptions = { projectEntries?: (snapshot: InputSnapshot, entries: TreeEntry[]) => TreeEntry[]; retainConflicts?: boolean; executionPaths?: readonly string[] }
export function composeInputSnapshots(newSource: InputSnapshot, prior?: BaselinePair | FrozenBaselineSelection | null, options: CompositionOptions = {}): { composed: ComposedInputRef | null; conflicts: CompositionConflict[] } {
  if (prior && 'version' in prior) return composeSelectedInput(newSource, prior, options)
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

export type IntentObject = { path: string; entry: TreeEntry; item: ContractItem; semanticDigest: string; rawSource: string | null; businessProse: string }
export type IntentResidual = {
  resource: Exclude<BaselineResource, { kind: 'path' }>; pairId: string | null
  before: IntentObject | null; delivery: IntentObject | null; source: IntentObject | null
  adopted: boolean; changed: boolean; broadChange: boolean
}
export type SelectedCompositionEvidence = {
  version: 'selected-composition-v1'; sourceInputId: string; baselineSelectionDigest: string
  paths: { path: string; pairId: string | null; base: TreeEntry | null; delivery: TreeEntry | null; source: TreeEntry | null; adopted: boolean }[]
  intents: IntentResidual[]; residualPaths: string[]; conflicts: CompositionConflict[]
  controlledAuthorPatch?: { requestBlob: BlobRef; before: TreeEntry; next: TreeEntry; intents: IntentResidual[] }
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

/** 精确选择是边界输入；不接受遗漏、错误归属或由全局 latest 补出的基线。 */
export function verifyBaselineSelection(input: InputSnapshot, selection: FrozenBaselineSelection): void {
  if (selection.version !== 'sync-baseline-selection-v1' || canonical(selection.source) !== canonical(input.source) || selection.digest !== contentHash(canonical({ version: selection.version, source: selection.source, bindings: selection.bindings }))) throw new Error('SYNC_BASELINE_SELECTION_INVALID: identity or digest')
  const keys = new Set<string>(), checkedPairs = new Map<string, string>()
  for (const binding of selection.bindings) {
    const resource = binding.resource, key = resource.kind === 'path' ? `path:${resource.path}` : `${resource.kind}:${resource.id}`
    if (keys.has(key)) throw new Error(`SYNC_BASELINE_SELECTION_INVALID: duplicate ${key}`)
    keys.add(key)
    const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair
    if (!pair) continue
    if (canonical(pair.source) !== canonical(input.source) || canonical(pair.sourceInput.source) !== canonical(input.source) || pair.repositoryId !== input.source.repositoryId || pair.verifiedDelivery.source.repositoryId !== input.source.repositoryId || pair.verifiedDelivery.source.commonDir !== input.source.commonDir) throw new Error(`SYNC_BASELINE_SELECTION_INVALID: pair identity ${pair.id}`)
    const covered = resource.kind === 'path' ? pair.coveredScope.paths.some(path => resource.path === path || resource.path.startsWith(`${path}/`)) : resource.kind === 'flow' ? pair.coveredScope.flowIds.includes(resource.id) : pair.coveredScope.contractIds.includes(resource.id)
    if (!covered) throw new Error(`SYNC_BASELINE_SELECTION_INVALID: uncovered ${key}`)
    const pairDigest = canonical(pair), checked = checkedPairs.get(pair.id)
    if (checked && checked !== pairDigest) throw new Error(`SYNC_BASELINE_SELECTION_INVALID: pair payload differs ${pair.id}`)
    if (!checked) { verifySnapshot(pair.sourceInput); verifySnapshot(pair.verifiedDelivery); checkedPairs.set(pair.id, pairDigest) }
  }
}

function intentObjects(commonDir: string, entries: readonly TreeEntry[]): Map<string, IntentObject> {
  const objects = new Map<string, IntentObject>()
  for (const entry of entries.filter(entry => entry.mode !== '120000' && entry.path.startsWith('.spec/') && entry.path.endsWith('/spec.md'))) {
    const bytes = readObject(commonDir, entry.oid)
    if (!isUtf8Text(bytes)) throw new Error(`SYNC_COMPOSITION_BLOCKED: non UTF-8 contract ${entry.path}`)
    const text = bytes.toString('utf8'), contract = parseContract({ nodeId: entry.path.split('/').at(-2)!, path: entry.path, source: text }).contract
    for (const item of contract?.items ?? []) {
      if (objects.has(item.id)) throw new Error(`SYNC_COMPOSITION_BLOCKED: ambiguous owner ${item.id}`)
      objects.set(item.id, { path: entry.path, entry, item, semanticDigest: contentHash(canonical(contractBusinessMeaning(item))), rawSource: parseParts(text)?.rawSource ?? null, businessProse: contractBusinessProse(contract!.expandedSpec) })
    }
  }
  return objects
}
const sameIntent = (a: IntentObject | null, b: IntentObject | null): boolean => a && b ? sameContractBusinessMeaning(a.item, b.item) : a === b

/** 文件只做真实 byte-pair 三方；逐 ID 的 source 残差独立于文件级未变化判定。 */
function composeSelectedInput(input: InputSnapshot, selection: FrozenBaselineSelection, options: CompositionOptions): ReturnType<typeof composeInputSnapshots> {
  verifyBaselineSelection(input, selection)
  for (const path of options.executionPaths ?? []) if (!selection.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === path)) throw new Error(`SYNC_COMPOSITION_BLOCKED: execution path missing exact byte binding ${path}`)
  const commonDir = input.source.commonDir, cache = new Map<string, TreeEntry[]>()
  const project = (snapshot: InputSnapshot): TreeEntry[] => {
    let entries = cache.get(snapshot.id)
    if (!entries) { const actual = verifySnapshot(snapshot); entries = options.projectEntries ? options.projectEntries(snapshot, actual) : actual; cache.set(snapshot.id, entries) }
    return entries
  }
  const incoming = project(input), next = new Map(incoming.map(entry => [entry.path, entry]))
  const headEntries = readTree(commonDir, objectGit(commonDir, ['rev-parse', `${input.headCommit}^{tree}`]).toString().trim())
  const writable = (path: string): boolean => options.executionPaths ? options.executionPaths.includes(path) : selection.bindings.some(binding => binding.resource.kind === 'path' && binding.resource.path === path)
  const result = new Map(headEntries.map(entry => [entry.path, entry])), paths: SelectedCompositionEvidence['paths'] = [], conflicts: CompositionConflict[] = []
  const adoption = new Map<string, Set<string>>()
  const adoptedPaths = (pair: BaselinePair): Set<string> => { let value = adoption.get(pair.id); if (!value) { value = adoptedDeliveryPaths(input, pair); adoption.set(pair.id, value) }; return value }
  for (const binding of selection.bindings) {
    const pair = 'bytePair' in binding ? binding.bytePair : binding.intentPair
    if (!('bytePair' in binding)) continue
    const path = binding.resource.path, source = next.get(path)
    if (!pair) { paths.push({ path, pairId: null, base: null, delivery: null, source: source ?? null, adopted: false }); if (writable(path)) { if (source) result.set(path, source); else result.delete(path) }; continue }
    const base = new Map(project(pair.sourceInput).map(entry => [entry.path, entry])), delivered = new Map(project(pair.verifiedDelivery).map(entry => [entry.path, entry]))
    const adopted = adoptedPaths(pair).has(path), old = adopted ? delivered.get(path) : base.get(path), delivery = delivered.get(path)
    paths.push({ path, pairId: pair.id, base: old ?? null, delivery: delivery ?? null, source: source ?? null, adopted })
    if (!writable(path)) continue
    if (same(old, source)) { if (delivery) result.set(path, delivery); else result.delete(path); continue }
    if (same(old, delivery) || same(source, delivery)) { if (source) result.set(path, source); else result.delete(path); continue }
    const mode = old && source && delivery && source.mode !== '120000' && old.mode !== '120000' && delivery.mode !== '120000' ? source.mode === old.mode ? delivery.mode : delivery.mode === old.mode || source.mode === delivery.mode ? source.mode : null : null
    const merged = mode && old && source && delivery ? mergeText(commonDir, delivery, old, source) : null
    if (merged && mode) result.set(path, { path, mode, oid: writeObject(commonDir, merged), digest: contentHash(merged) })
    else {
      conflicts.push({ path, base: old ?? null, source: source ?? null, delivery: delivery ?? null })
      if (options.retainConflicts) { if (source) result.set(path, source); else result.delete(path) }
    }
  }
  const currentObjects = intentObjects(commonDir, incoming), objectCache = new Map<string, Map<string, IntentObject>>()
  const objects = (snapshot: InputSnapshot): Map<string, IntentObject> => { let value = objectCache.get(snapshot.id); if (!value) { value = intentObjects(commonDir, project(snapshot)); objectCache.set(snapshot.id, value) }; return value }
  const intents: IntentResidual[] = [], residualPaths = new Set<string>(), composedObjects = intentObjects(commonDir, [...result.values()])
  for (const binding of selection.bindings) {
    if (!('intentPair' in binding)) continue
    const resource = binding.resource, pair = binding.intentPair, source = currentObjects.get(resource.id) ?? null
    const original = pair ? objects(pair.sourceInput).get(resource.id) ?? null : null, delivery = pair ? objects(pair.verifiedDelivery).get(resource.id) ?? null : null
    const adopted = !!pair && !!(delivery ?? original) && adoptedPaths(pair).has((delivery ?? original)!.path)
    const before = adopted ? delivery : original
    const byte = paths.find(item => item.path === (source?.path ?? before?.path))
    const acceptedByte = byte?.adopted && byte.source && byte.delivery && same(byte.source, byte.delivery)
    const broadChange = (!acceptedByte && (before?.rawSource !== source?.rawSource || before?.businessProse !== source?.businessProse)) || before?.path !== source?.path
    const changed = !sameIntent(before, source) || broadChange
    const evidence: IntentResidual = { resource, pairId: pair?.id ?? null, before, delivery, source, adopted, changed, broadChange }
    intents.push(evidence)
    if (!changed) continue
    for (const path of [before?.path, source?.path].filter((path): path is string => !!path)) residualPaths.add(path)
    // 差量只用于识别，绝不把多个 intent-pair 伪拼成 raw/整文件作者基线。
    const composed = composedObjects.get(resource.id) ?? null
    if (writable(source?.path ?? before?.path ?? '') && (!sameIntent(source, composed) || source?.rawSource !== composed?.rawSource || source?.businessProse !== composed?.businessProse || source?.path !== composed?.path)) {
      const path = source?.path ?? before?.path
      if (path && !conflicts.some(conflict => conflict.path === path)) {
        const byte = paths.find(item => item.path === path)
        if (!byte) throw new Error(`SYNC_COMPOSITION_BLOCKED: semantic owner missing byte binding ${path}`)
        conflicts.push({ path, base: byte.base, source: byte.source, delivery: byte.delivery })
      }
    }
  }
  const entries = [...result.values()].sort((a, b) => a.path.localeCompare(b.path))
  for (const entry of entries) if (entries.some(other => entry.path.startsWith(`${other.path}/`)) && !conflicts.some(conflict => conflict.path === entry.path)) conflicts.push({ path: entry.path, base: null, source: next.get(entry.path) ?? null, delivery: result.get(entry.path) ?? null })
  if (conflicts.length && !options.retainConflicts) return { composed: null, conflicts }
  const evidence: SelectedCompositionEvidence = { version: 'selected-composition-v1', sourceInputId: input.id, baselineSelectionDigest: selection.digest, paths, intents, residualPaths: [...residualPaths].sort(), conflicts }
  const tree = writeTree(commonDir, entries), contentDigest = contentHash(JSON.stringify(entries)), manifestBlob = writeEvidence(commonDir, { version: 1, entries })
  objectGit(commonDir, ['update-ref', `refs/spex-sync/compositions/${tree}`, tree])
  return { composed: { sourceInputId: input.id, previousBaselinePairId: null, baselineSelectionDigest: selection.digest, tree, manifestBlob, contentDigest, compositionEvidenceBlob: writeEvidence(commonDir, evidence), authorProjectionBlob: writeEvidence(commonDir, { version: 'selected-author-projection-v1', sourceInputId: input.id, baselineSelectionDigest: selection.digest, intents, residualPaths: evidence.residualPaths }) }, conflicts }
}

/** 重读 hash 校验后的证据，逐资源的真实对象仍由 selection 再计算并校验。 */
export function readCompositionEvidence(input: InputSnapshot, composed: ComposedInputRef, selection: FrozenBaselineSelection): SelectedCompositionEvidence {
  verifyBaselineSelection(input, selection)
  if (!composed.compositionEvidenceBlob || composed.sourceInputId !== input.id || composed.baselineSelectionDigest !== selection.digest) throw new Error('SYNC_COMPOSITION_BINDING: selection or evidence missing')
  const evidence = JSON.parse(readEvidence(input.source.commonDir, composed.compositionEvidenceBlob).toString('utf8')) as SelectedCompositionEvidence
  if (evidence.version !== 'selected-composition-v1' || evidence.sourceInputId !== input.id || evidence.baselineSelectionDigest !== selection.digest) throw new Error('SYNC_COMPOSITION_BINDING: evidence identity')
  const commonDir = input.source.commonDir, entries = readTree(commonDir, composed.tree)
  if (contentHash(JSON.stringify(entries)) !== composed.contentDigest || !readEvidence(commonDir, composed.manifestBlob).equals(Buffer.from(JSON.stringify({ version: 1, entries })))) throw new Error('SYNC_COMPOSITION_BINDING: tree or manifest')
  const entriesCache = new Map<string, TreeEntry[]>()
  const actualEntries = (snapshot: InputSnapshot): TreeEntry[] => { let value = entriesCache.get(snapshot.id); if (!value) { value = verifySnapshot(snapshot); entriesCache.set(snapshot.id, value) }; return value }
  const cache = new Map<string, Map<string, IntentObject>>(), adoption = new Map<string, Set<string>>()
  const objects = (snapshot: InputSnapshot): Map<string, IntentObject> => { let value = cache.get(snapshot.id); if (!value) { value = intentObjects(commonDir, actualEntries(snapshot)); cache.set(snapshot.id, value) }; return value }
  const current = new Map(objects(input)), patch = evidence.controlledAuthorPatch
  const pathBindings = selection.bindings.filter(binding => 'bytePair' in binding)
  if (pathBindings.length !== evidence.paths.length) throw new Error('SYNC_COMPOSITION_BINDING: byte resources differ')
  const canonicalBindings = canonicalContractFilterBindings(input.source.canonicalRoot)
  const sameProjectedEntry = (actual: TreeEntry | undefined, claimed: TreeEntry | null): boolean => {
    if (same(actual, claimed ?? undefined)) return actual?.digest === claimed?.digest
    if (!actual || !claimed || actual.path !== claimed.path || actual.mode !== claimed.mode) return false
    const binding = canonicalBindings.find(binding => binding.file === actual.path)
    if (!binding) return false
    const cleaned = cleanCanonicalContractText(readObject(commonDir, actual.oid), binding)
    return cleaned.equals(readObject(commonDir, claimed.oid)) && contentHash(cleaned) === claimed.digest
  }
  for (const binding of pathBindings) {
    const path = binding.resource.path, pair = binding.bytePair, claim = evidence.paths.find(item => item.path === path)
    let adopted = false
    if (pair) { let paths = adoption.get(pair.id); if (!paths) { paths = adoptedDeliveryPaths(input, pair); adoption.set(pair.id, paths) }; adopted = paths.has(path) }
    const before = pair ? actualEntries(adopted ? pair.verifiedDelivery : pair.sourceInput).find(entry => entry.path === path) : undefined
    const delivered = pair ? actualEntries(pair.verifiedDelivery).find(entry => entry.path === path) : undefined
    const source = actualEntries(input).find(entry => entry.path === path)
    if (!claim || claim.pairId !== (pair?.id ?? null) || claim.adopted !== adopted || !sameProjectedEntry(before, claim.base) || !sameProjectedEntry(delivered, claim.delivery) || !sameProjectedEntry(source, claim.source)) throw new Error(`SYNC_COMPOSITION_BINDING: true byte objects differ ${path}`)
  }
  if (patch) {
    const request = JSON.parse(readEvidence(commonDir, patch.requestBlob).toString('utf8')) as { inputId: string; source: InputSnapshot['source']; before: TreeEntry; next: TreeEntry }
    if (request.inputId !== input.id || canonical(request.source) !== canonical(input.source) || canonical(request.before) !== canonical(patch.before) || canonical(request.next) !== canonical(patch.next) || canonical(actualEntries(input).find(entry => entry.path === patch.before.path)) !== canonical(patch.before)) throw new Error('SYNC_COMPOSITION_BINDING: immutable author patch')
    const patched = intentObjects(commonDir, [patch.next])
    for (const [id, item] of patched) current.set(id, item)
    for (const [id, item] of [...current]) if (item.path === patch.next.path && !patched.has(id)) current.delete(id)
    const previous = intentObjects(commonDir, [patch.before])
    const patchIntents = [...new Set([...previous.keys(), ...patched.keys()])].map(id => {
      const before = previous.get(id) ?? null, source = patched.get(id) ?? null, broadChange = before?.rawSource !== source?.rawSource || before?.businessProse !== source?.businessProse
      return { resource: { kind: 'contract', id }, pairId: null, before, delivery: evidence.intents.find(item => item.resource.id === id)?.delivery ?? null, source, adopted: false, broadChange, changed: !sameIntent(before, source) || broadChange }
    })
    if (canonical(patchIntents) !== canonical(patch.intents)) throw new Error('SYNC_COMPOSITION_BINDING: true immutable author patch intent differs')
  }
  const expected: IntentResidual[] = []
  for (const binding of selection.bindings) if ('intentPair' in binding) {
    const pair = binding.intentPair, original = pair ? objects(pair.sourceInput).get(binding.resource.id) ?? null : null, delivery = pair ? objects(pair.verifiedDelivery).get(binding.resource.id) ?? null : null
    let adopted = false
    if (pair && (delivery ?? original)) { let paths = adoption.get(pair.id); if (!paths) { paths = adoptedDeliveryPaths(input, pair); adoption.set(pair.id, paths) }; adopted = paths.has((delivery ?? original)!.path) }
    const before = adopted ? delivery : original, source = current.get(binding.resource.id) ?? null
    const byteBinding = selection.bindings.find(item => 'bytePair' in item && item.resource.path === (source?.path ?? before?.path))
    const bytePair = byteBinding && 'bytePair' in byteBinding ? byteBinding.bytePair : null
    const byteDelivery = bytePair ? actualEntries(bytePair.verifiedDelivery).find(entry => entry.path === (source?.path ?? before?.path)) : undefined
    const byteSource = actualEntries(input).find(entry => entry.path === (source?.path ?? before?.path))
    let acceptedByte = false
    if (bytePair) { let paths = adoption.get(bytePair.id); if (!paths) { paths = adoptedDeliveryPaths(input, bytePair); adoption.set(bytePair.id, paths) }; acceptedByte = paths.has((source?.path ?? before?.path)!) && same(byteSource, byteDelivery) }
    const broadChange = ((!acceptedByte || !!patch && patch.next.path === source?.path) && (before?.rawSource !== source?.rawSource || before?.businessProse !== source?.businessProse)) || before?.path !== source?.path
    expected.push({ resource: binding.resource, pairId: pair?.id ?? null, before, delivery, source, adopted, broadChange, changed: !sameIntent(before, source) || broadChange })
  }
  if (canonical(expected) !== canonical(evidence.intents)) throw new Error('SYNC_COMPOSITION_BINDING: true intent objects or residual differ')
  const residualPaths = [...new Set(expected.filter(item => item.changed).flatMap(item => [item.before?.path, item.source?.path].filter((path): path is string => !!path)))].sort()
  if (patch && !same(patch.before, patch.next) && !residualPaths.includes(patch.next.path)) residualPaths.push(patch.next.path)
  if (canonical(residualPaths.sort()) !== canonical(evidence.residualPaths)) throw new Error('SYNC_COMPOSITION_BINDING: residual paths differ')
  return evidence
}

/** 受控编辑未写source，作者next仍是原请求真实blob；只更新语义投影而不伪造快照。 */
export function projectSelectedAuthorPatch(input: InputSnapshot, evidence: SelectedCompositionEvidence, requestBlob: BlobRef, before: TreeEntry, next: TreeEntry): SelectedCompositionEvidence {
  const current = intentObjects(input.source.commonDir, [next]), previous = intentObjects(input.source.commonDir, [before])
  const intents = evidence.intents.map(residual => {
    if (residual.source?.path !== next.path && residual.before?.path !== next.path && residual.delivery?.path !== next.path) return residual
    const source = current.get(residual.resource.id) ?? null
    const broadChange = residual.before?.rawSource !== source?.rawSource || residual.before?.businessProse !== source?.businessProse || residual.before?.path !== source?.path
    return { ...residual, source, broadChange, changed: !sameIntent(residual.before, source) || broadChange }
  })
  const residualPaths = [...new Set(intents.filter(item => item.changed).flatMap(item => [item.before?.path, item.source?.path].filter((path): path is string => !!path)))].sort()
  // 原不可变patch独立保留；不能因与历史delivery相同或文件byte未变而丢弃本次用户授权。
  if (!same(before, next) && !residualPaths.includes(next.path)) residualPaths.push(next.path)
  const patchIntents: IntentResidual[] = [...new Set([...previous.keys(), ...current.keys()])].map(id => {
    const prior = previous.get(id) ?? null, source = current.get(id) ?? null, broadChange = prior?.rawSource !== source?.rawSource || prior?.businessProse !== source?.businessProse
    return { resource: { kind: 'contract', id }, pairId: null, before: prior, delivery: evidence.intents.find(item => item.resource.id === id)?.delivery ?? null, source, adopted: false, broadChange, changed: !sameIntent(prior, source) || broadChange }
  })
  return { ...evidence, intents, residualPaths: residualPaths.sort(), controlledAuthorPatch: { requestBlob, before, next, intents: patchIntents } }
}
