import { isDeepStrictEqual } from 'node:util'
import { contractReferences, parseContract, projectContractCoverage } from '@spexcode/spec-core/contracts'
import type { ContractGraph, ContractItem } from '@spexcode/spec-core/contracts'
import { sameContractBusinessMeaning } from './contract-evolution.js'
import { verifyBaselineSelection } from './composition.js'
import { isSyncSpecPath, readFrozenContracts } from './frozen-contracts.js'
import type { BaselinePair, BlobRef, FrozenBaselineSelection, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import { obligationPaths } from './prior-context.js'
import { assertSourceAdoptionComplete, isSourceCommitAncestor, settledReceipt } from './source-adoption.js'
import { contentHash, readEvidence, readObject, verifySnapshot, writeObject } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'
import type { SyncStore } from './store.js'

export type HistoricalCoverage = {
  version: 'sync-historical-unexecuted-coverage-v1'
  inputId: string
  proofs: { pairId: string; receiptId: string; verificationRef: BlobRef; contractIds: string[] }[]
  digest: string
}
export type HistoricalCoverageCheck = (graph: ContractGraph, files: ReadonlyMap<string, string>) => ReadonlySet<string>
type PriorProof = { pair: BaselinePair; verificationRef: BlobRef; unexecuted: ReadonlySet<string>; entries: TreeEntry[] }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const bodyDigest = (value: Omit<HistoricalCoverage, 'digest'>): string => contentHash(canonical(value))
const sameEntry = (left: TreeEntry | undefined, right: TreeEntry | undefined): boolean => left?.mode === right?.mode && left?.oid === right?.oid
const within = (path: string, scope: readonly string[]): boolean => scope.some(parent => path === parent || path.startsWith(`${parent}/`))
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'historical_coverage_binding' }) }

function priorProof(store: SyncStore, input: InputSnapshot, pairId: string): PriorProof | null {
  const pair = store.readBaselinePair(pairId)
  if (pair.id !== pairId || !isDeepStrictEqual(pair.source, input.source) || !isDeepStrictEqual(pair.sourceInput.source, input.source) || pair.repositoryId !== input.source.repositoryId || !pair.receiptId.startsWith('receipt-')) fail('历史覆盖基线不属于本次精确来源')
  const journal = store.readJournal(pair.receiptId.slice('receipt-'.length)), operation = store.readOperation(journal.operationId)
  if (!operation.recordUnverifiedCoverage) return null
  assertSourceAdoptionComplete(operation)
  const attempt = store.readAttempt(journal.attemptId), verified = settledReceipt(store, operation, journal)
  if (!isDeepStrictEqual(operation.input.source, input.source) || !isDeepStrictEqual(pair.sourceInput, operation.input) || !isDeepStrictEqual(pair.verifiedDelivery, verified.receipt.deliverySnapshot) || !isDeepStrictEqual(pair.coveredScope, journal.plan.coveredScope) || pair.receiptId !== verified.receipt.id || store.listResources(attempt.id).some(resource => resource.phase !== 'removed')) fail('历史覆盖基线、正式收据或资源结算不匹配')
  const verificationRef = attempt.verification!.resultBlob
  const result = JSON.parse(readEvidence(input.source.commonDir, verificationRef).toString('utf8')) as VerificationResultBlob
  const ids = result.unexecutedContractIds
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !/^(REQ|RULE|TR)-[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) || !result.coveredScope.contractIds.includes(id))) fail('原正式报告没有精确的未执行覆盖清单')
  if (!isSourceCommitAncestor(input.source.commonDir, verified.receipt.actualCommit!, input.headCommit)) return null
  return { pair, verificationRef, unexecuted: new Set(ids), entries: verifySnapshot(pair.verifiedDelivery) }
}

function candidateEntries(input: InputSnapshot, entries: readonly TreeEntry[], files: ReadonlyMap<string, string>): Map<string, TreeEntry> {
  const result = new Map(entries.map(entry => [entry.path, entry]))
  for (const path of result.keys()) if (isSyncSpecPath(path) && !files.has(path)) result.delete(path)
  for (const [path, source] of files) if (isSyncSpecPath(path)) {
    const previous = result.get(path), digest = contentHash(source)
    if (previous?.digest !== digest) result.set(path, { path, mode: previous?.mode ?? '100644', oid: writeObject(input.source.commonDir, Buffer.from(source)), digest })
  }
  return result
}

function unchangedHistoricalId(input: InputSnapshot, scope: SyncScope, id: string, prior: PriorProof, graph: ContractGraph, original: ReadonlyMap<string, TreeEntry>, candidate: ReadonlyMap<string, TreeEntry>, files: ReadonlyMap<string, string>): boolean {
  const item = graph.items.get(id)
  if (!item || !['REQ', 'RULE', 'TR'].includes(item.kind) || scope.contractIds.includes(id) || within(item.path, scope.paths) || !prior.unexecuted.has(id) || !prior.pair.coveredScope.contractIds.includes(id)) return false
  const delivered = new Map(prior.entries.map(entry => [entry.path, entry])), owner = delivered.get(item.path)
  if (!owner || owner.mode === '120000' || !sameEntry(owner, original.get(item.path)) || !sameEntry(owner, candidate.get(item.path))) return false
  const before = parseContract({ nodeId: item.nodeId, path: item.path, source: readObject(input.source.commonDir, owner.oid).toString('utf8') }).contract?.items.find(previous => previous.id === id)
  if (!before || before.kind !== item.kind || before.nodeId !== item.nodeId || before.path !== item.path || !isDeepStrictEqual((before as Exclude<ContractItem, { kind: 'VERIFY' }>).source, (item as Exclude<ContractItem, { kind: 'VERIFY' }>).source) || !sameContractBusinessMeaning(before, item)) return false
  const pending = [id], seen = new Set<string>(), owners = new Set<string>()
  while (pending.length) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    const contract = graph.owners.get(next)
    if (!contract) return false
    if (owners.has(contract.path)) continue
    owners.add(contract.path)
    for (const entry of contract.items) for (const reference of contractReferences(entry)) {
      if (!graph.items.has(reference.id)) return false
      pending.push(reference.id)
    }
  }
  const inventory = [...new Set([...delivered.keys(), ...original.keys(), ...candidate.keys()])]
  for (const path of owners) {
    const source = files.get(path)
    if (source === undefined) return false
    for (const protectedPath of obligationPaths(source, path, inventory, true)) {
      const entry = delivered.get(protectedPath), current = candidate.get(protectedPath)
      if (!sameEntry(entry, original.get(protectedPath)) || !sameEntry(entry, current) || current && files.has(protectedPath) && contentHash(files.get(protectedPath)!) !== current.digest) return false
    }
  }
  return true
}

/** 新接入仅冻结精确已采纳旧缺口的身份；以后不依赖可变资源头。 */
export async function freezeHistoricalCoverage(store: SyncStore, input: InputSnapshot, scope: SyncScope, selection: FrozenBaselineSelection): Promise<HistoricalCoverage | undefined> {
  verifyBaselineSelection(input, selection)
  if (!selection.bindings.some(binding => binding.resource.kind === 'contract' && 'intentPair' in binding && binding.intentPair)) return undefined
  const entries = verifySnapshot(input), files = new Map(entries.filter(entry => entry.mode !== '120000' && isSyncSpecPath(entry.path)).map(entry => [entry.path, readObject(input.source.commonDir, entry.oid).toString('utf8')]))
  const frozen = await readFrozenContracts(input.source.canonicalRoot, files)
  const missing = new Set(projectContractCoverage(frozen.graph).items.filter(item => !item.acceptanceIds.length && !item.blockedBy.length).map(item => item.id))
  const groups = new Map<string, string[]>()
  for (const binding of selection.bindings) if (binding.resource.kind === 'contract' && 'intentPair' in binding && binding.intentPair && missing.has(binding.resource.id)) {
    const item = frozen.graph.items.get(binding.resource.id)
    if (!item || !['REQ', 'RULE', 'TR'].includes(item.kind) || scope.contractIds.includes(item.id) || within(item.path, scope.paths)) continue
    groups.set(binding.intentPair.id, [...groups.get(binding.intentPair.id) ?? [], item.id])
  }
  const original = new Map(entries.map(entry => [entry.path, entry])), proofs: HistoricalCoverage['proofs'] = []
  for (const [pairId, ids] of groups) {
    const prior = priorProof(store, input, pairId)
    if (!prior) continue
    const contractIds = ids.filter(id => unchangedHistoricalId(input, scope, id, prior, frozen.graph, original, original, files)).sort()
    if (contractIds.length) proofs.push({ pairId, receiptId: prior.pair.receiptId, verificationRef: prior.verificationRef, contractIds })
  }
  if (!proofs.length) return undefined
  const body = { version: 'sync-historical-unexecuted-coverage-v1' as const, inputId: input.id, proofs: proofs.sort((left, right) => left.pairId.localeCompare(right.pairId)) }
  return { ...body, digest: bodyDigest(body) }
}

/** 全图 seal 与 V1 共用同一冷验；只给未变的既有 ID 保留未执行事实。 */
export function historicalCoverageCheck(store: SyncStore, input: InputSnapshot, scope: SyncScope, proof: HistoricalCoverage, entries: readonly TreeEntry[]): HistoricalCoverageCheck {
  const { digest, ...body } = proof
  if (proof.version !== 'sync-historical-unexecuted-coverage-v1' || proof.inputId !== input.id || bodyDigest(body) !== digest || !proof.proofs.length) fail('历史覆盖证明不匹配冻结输入或摘要')
  const original = new Map(verifySnapshot(input).map(entry => [entry.path, entry]))
  return (graph, files) => {
    const candidate = candidateEntries(input, entries, files), accepted = new Set<string>(), ids = new Set<string>()
    for (const record of proof.proofs) {
      const prior = priorProof(store, input, record.pairId)
      if (!prior || prior.pair.receiptId !== record.receiptId || !isDeepStrictEqual(prior.verificationRef, record.verificationRef) || !record.contractIds.length) fail('冻结历史覆盖原件已失配或不再可证')
      for (const id of record.contractIds) {
        if (ids.has(id) || !prior.unexecuted.has(id) || !prior.pair.coveredScope.contractIds.includes(id)) fail('历史覆盖ID重复或未由原正式报告覆盖')
        ids.add(id)
        if (unchangedHistoricalId(input, scope, id, prior, graph, original, candidate, files)) accepted.add(id)
      }
    }
    return accepted
  }
}
