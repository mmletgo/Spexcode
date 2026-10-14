import { readFileSync } from 'node:fs'
import { canonicalContractFilterBindings, cleanCanonicalContractText, describeCanonicalContractFilter } from '../contract-filter.js'
import { composeInputSnapshots, isUtf8Text } from './composition.js'
import type { CompositionOptions } from './composition.js'
import type { BaselinePair, FrozenBaselineSelection, InputSnapshot } from './operation-types.js'
import { contentHash, objectGit, readEvidence, readObject, writeEvidence, writeObject } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'
import { readFootprintConfiguration, snapshotFootprintFile } from './trusted-footprint.js'

/** 真实快照不变；canonical clean 的作者字节才参与三方整合和后续候选。 */
export function composeAuthoredInput(input: InputSnapshot, prior?: BaselinePair | FrozenBaselineSelection, options: Pick<CompositionOptions, 'retainConflicts' | 'executionPaths'> = {}): ReturnType<typeof composeInputSnapshots> {
  const root = input.source.canonicalRoot, commonDir = input.source.commonDir
  const configuration = readFootprintConfiguration('/usr/bin/git', root)
  const filters = configuration.records.filter((_, index) => index % 2 === 1).filter(record => record.startsWith('filter.'))
  if (!filters.length) return composeInputSnapshots(input, prior, options)
  const canonical = describeCanonicalContractFilter(commonDir), bindings = canonicalContractFilterBindings(root)
  for (const record of filters) {
    const split = record.indexOf('\n'), key = record.slice(0, split), value = record.slice(split + 1)
    if (!Object.hasOwn(canonical.commands, key) || value !== canonical.commands[key]) throw new Error(`SYNC_AUTHOR_FILTER_UNSUPPORTED: ${key}`)
  }
  if (!Object.keys(canonical.commands).every(key => filters.some(record => record.startsWith(`${key}\n`)))) throw new Error('SYNC_AUTHOR_FILTER_UNSUPPORTED: canonical clean/smudge must both be registered')
  if (configuration.records.some((record, index) => index % 2 === 1 && record.startsWith('core.attributesfile\n'))) throw new Error('SYNC_AUTHOR_FILTER_UNSUPPORTED: external attributes policy')
  const metadata = [canonical.shim.path, canonical.metadataPaths[1], canonical.metadataPaths[2]].map(snapshotFootprintFile)
  if (metadata.some(file => file.kind !== 'file') || metadata[0].mode !== canonical.shim.mode || metadata[0].digest !== contentHash(canonical.shim.source)) throw new Error('SYNC_AUTHOR_FILTER_UNSUPPORTED: canonical shim or metadata differs')
  const expectedBindings = bindings.map(binding => `${binding.file}\t${binding.start}\t${binding.end}`).join('\n') + '\n'
  if (readFileSync(canonical.metadataPaths[1], 'utf8') !== expectedBindings) throw new Error('SYNC_AUTHOR_FILTER_UNSUPPORTED: canonical bindings differ')
  const projections: { snapshotId: string; changes: { path: string; before: TreeEntry; after: TreeEntry }[] }[] = []
  const result = composeInputSnapshots(input, prior, { ...options, projectEntries(snapshot, entries) {
    // --source reads each immutable tree's .gitattributes, never the editor's current files or index.
    const attributes = objectGit(commonDir, ['check-attr', `--source=${snapshot.immutableTree}`, '-z', '--stdin', 'filter'], Buffer.from(bindings.map(binding => binding.file).join('\0') + '\0')).toString().split('\0')
    const enabled = new Set<string>()
    for (let index = 0; index + 2 < attributes.length; index += 3) if (attributes[index + 2] === 'spexcode') enabled.add(attributes[index])
    const changes: { path: string; before: TreeEntry; after: TreeEntry }[] = []
    const projected = entries.map(entry => {
      const binding = bindings.find(binding => binding.file === entry.path)
      if (!binding || !enabled.has(entry.path) || entry.mode === '120000') return entry
      const bytes = readObject(commonDir, entry.oid)
      if (!isUtf8Text(bytes)) throw new Error(`SYNC_AUTHOR_FILTER_UNSUPPORTED: managed text is not UTF-8: ${entry.path}`)
      const cleaned = cleanCanonicalContractText(bytes, binding)
      if (cleaned.equals(bytes)) return entry
      const after = { ...entry, oid: writeObject(commonDir, cleaned), digest: contentHash(cleaned) }
      changes.push({ path: entry.path, before: entry, after })
      return after
    })
    projections.push({ snapshotId: snapshot.id, changes })
    return projected
  } })
  if (readFootprintConfiguration('/usr/bin/git', root).digest !== configuration.digest || metadata.some(file => JSON.stringify(snapshotFootprintFile(file.path)) !== JSON.stringify(file))) throw new Error('SYNC_AUTHOR_FILTER_CHANGED: normalization policy changed while composing')
  if (result.composed) result.composed.authorProjectionBlob = writeEvidence(commonDir, { version: 'canonical-author-projection-v1', baselineSelectionDigest: result.composed.baselineSelectionDigest ?? null, semanticProjection: result.composed.authorProjectionBlob ? JSON.parse(readEvidence(commonDir, result.composed.authorProjectionBlob).toString('utf8')) as unknown : null, configurationDigest: configuration.digest, metadata, projections })
  return result
}
