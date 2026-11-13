import { isDeepStrictEqual } from 'node:util'
import { contractReferences, parseContract, projectContractCoverage } from '@spexcode/spec-core/contracts'
import type { ContractGraph, ContractItem } from '@spexcode/spec-core/contracts'
import { sameContractBusinessMeaning } from './contract-evolution.js'
import { verifyBaselineSelection } from './composition.js'
import { isSyncSpecPath, readFrozenContracts } from './frozen-contracts.js'
import type { BaselinePair, BlobRef, FrozenBaselineSelection, InputSnapshot, SyncScope, VerificationResultBlob } from './operation-types.js'
import { obligationPaths } from './prior-context.js'
import { assertSourceAdoptionComplete, isSourceCommitAncestor, settledReceipt } from './source-adoption.js'
import { contentHash, readEvidence, readObjectBatch, verifySnapshot, writeObject } from './snapshot.js'
import type { TreeEntry } from './snapshot.js'
import type { SyncStore } from './store.js'

export type HistoricalCoverage = {
  version: 'sync-historical-unexecuted-coverage-v1'
  inputId: string
  entries: { pairId: string; receiptId: string; verificationRef: BlobRef; contractIds: string[] }[]
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

function unchangedHistoricalIds(input: InputSnapshot, scope: SyncScope, ids: readonly string[], prior: PriorProof, graph: ContractGraph, original: ReadonlyMap<string, TreeEntry>, candidate: ReadonlyMap<string, TreeEntry>, files: ReadonlyMap<string, string>): string[] {
  const delivered = new Map(prior.entries.map(entry => [entry.path, entry])), covered = new Set(prior.pair.coveredScope.contractIds), current = new Set(scope.contractIds)
  const items = ids.flatMap(id => {
    const item = graph.items.get(id)
    if (!item || !['REQ', 'RULE', 'TR'].includes(item.kind) || current.has(id) || within(item.path, scope.paths) || !prior.unexecuted.has(id) || !covered.has(id)) return []
    const owner = delivered.get(item.path)
    return owner && owner.mode !== '120000' && sameEntry(owner, original.get(item.path)) && sameEntry(owner, candidate.get(item.path)) ? [{ item, owner }] : []
  })
  const sources = readObjectBatch(input.source.commonDir, items.map(({ owner }) => owner.oid)), previous = new Map<string, Map<string, ContractItem>>()
  for (const { item, owner } of items) if (!previous.has(item.path)) {
    const contract = parseContract({ nodeId: item.nodeId, path: item.path, source: sources.get(owner.oid)!.toString('utf8') }).contract
    previous.set(item.path, new Map(contract?.items.map(entry => [entry.id, entry])))
  }
  const inventory = [...new Set([...delivered.keys(), ...original.keys(), ...candidate.keys()])]
  const pathChecks = new Map<string, boolean>(), ownerChecks = new Map<string, boolean>(), closureChecks = new Map<string, boolean>()
  return items.filter(({ item }) => {
    const before = previous.get(item.path)!.get(item.id)
    if (!before || before.kind !== item.kind || before.nodeId !== item.nodeId || before.path !== item.path || !isDeepStrictEqual((before as Exclude<ContractItem, { kind: 'VERIFY' }>).source, (item as Exclude<ContractItem, { kind: 'VERIFY' }>).source) || !sameContractBusinessMeaning(before, item)) return false
    if (!closureChecks.has(item.path)) {
      const pending = [item.id], owners = new Set<string>()
      let valid = true
      while (pending.length && valid) {
        const contract = graph.owners.get(pending.pop()!)
        if (!contract) { valid = false; break }
        if (owners.has(contract.path)) continue
        owners.add(contract.path)
        if (!ownerChecks.has(contract.path)) {
          const source = files.get(contract.path)
          ownerChecks.set(contract.path, source !== undefined && obligationPaths(source, contract.path, inventory, true, contract).every(path => {
            if (!pathChecks.has(path)) {
              const entry = delivered.get(path), next = candidate.get(path)
              pathChecks.set(path, sameEntry(entry, original.get(path)) && sameEntry(entry, next) && (!next || !files.has(path) || contentHash(files.get(path)!) === next.digest))
            }
            return pathChecks.get(path)!
          }))
        }
        if (!ownerChecks.get(contract.path)) { valid = false; break }
        for (const entry of contract.items) for (const reference of contractReferences(entry)) {
          if (!graph.items.has(reference.id)) valid = false
          else pending.push(reference.id)
        }
      }
      closureChecks.set(item.path, valid)
    }
    return closureChecks.get(item.path)!
  }).map(({ item }) => item.id)
}

/** 新接入仅冻结精确已采纳旧缺口的身份；以后不依赖可变资源头。 */
export async function freezeHistoricalCoverage(store: SyncStore, input: InputSnapshot, scope: SyncScope, selection: FrozenBaselineSelection): Promise<HistoricalCoverage | undefined> {
  verifyBaselineSelection(input, selection)
  if (!selection.bindings.some(binding => binding.resource.kind === 'contract' && 'intentPair' in binding && binding.intentPair)) return undefined
  const entries = verifySnapshot(input), specs = entries.filter(entry => entry.mode !== '120000' && isSyncSpecPath(entry.path)), sources = readObjectBatch(input.source.commonDir, specs.map(entry => entry.oid))
  const files = new Map(specs.map(entry => [entry.path, sources.get(entry.oid)!.toString('utf8')]))
  const frozen = await readFrozenContracts(input.source.canonicalRoot, files)
  const missing = new Set(projectContractCoverage(frozen.graph).items.filter(item => !item.acceptanceIds.length && !item.blockedBy.length).map(item => item.id))
  const groups = new Map<string, string[]>()
  for (const binding of selection.bindings) if (binding.resource.kind === 'contract' && 'intentPair' in binding && binding.intentPair && missing.has(binding.resource.id)) {
    const item = frozen.graph.items.get(binding.resource.id)
    if (!item || !['REQ', 'RULE', 'TR'].includes(item.kind) || scope.contractIds.includes(item.id) || within(item.path, scope.paths)) continue
    groups.set(binding.intentPair.id, [...groups.get(binding.intentPair.id) ?? [], item.id])
  }
  const original = new Map(entries.map(entry => [entry.path, entry])), historicalEntries: HistoricalCoverage['entries'] = []
  for (const [pairId, ids] of groups) {
    const prior = priorProof(store, input, pairId)
    if (!prior) continue
    const contractIds = unchangedHistoricalIds(input, scope, ids, prior, frozen.graph, original, original, files).sort()
    if (contractIds.length) historicalEntries.push({ pairId, receiptId: prior.pair.receiptId, verificationRef: prior.verificationRef, contractIds })
  }
  if (!historicalEntries.length) return undefined
  const body = { version: 'sync-historical-unexecuted-coverage-v1' as const, inputId: input.id, entries: historicalEntries.sort((left, right) => left.pairId.localeCompare(right.pairId)) }
  return { ...body, digest: bodyDigest(body) }
}

/** 全图 seal 与 V1 共用同一冷验；只给未变的既有 ID 保留未执行事实。 */
export function historicalCoverageCheck(store: SyncStore, input: InputSnapshot, scope: SyncScope, proof: HistoricalCoverage, entries: readonly TreeEntry[]): HistoricalCoverageCheck {
  const { digest, ...body } = proof
  if (proof.version !== 'sync-historical-unexecuted-coverage-v1' || proof.inputId !== input.id || bodyDigest(body) !== digest || !proof.entries.length) fail('历史覆盖证明不匹配冻结输入或摘要')
  const original = new Map(verifySnapshot(input).map(entry => [entry.path, entry]))
  return (graph, files) => {
    const candidate = candidateEntries(input, entries, files), accepted = new Set<string>(), ids = new Set<string>()
    for (const record of proof.entries) {
      const prior = priorProof(store, input, record.pairId)
      if (!prior || prior.pair.receiptId !== record.receiptId || !isDeepStrictEqual(prior.verificationRef, record.verificationRef) || !record.contractIds.length) fail('冻结历史覆盖原件已失配或不再可证')
      for (const id of record.contractIds) {
        if (ids.has(id) || !prior.unexecuted.has(id) || !prior.pair.coveredScope.contractIds.includes(id)) fail('历史覆盖ID重复或未由原正式报告覆盖')
        ids.add(id)
      }
      for (const id of unchangedHistoricalIds(input, scope, record.contractIds, prior, graph, original, candidate, files)) accepted.add(id)
    }
    return accepted
  }
}
