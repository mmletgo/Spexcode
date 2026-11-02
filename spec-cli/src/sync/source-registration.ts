import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectRuntimeRoot, putBlob, readBlobByHash } from '@spexcode/spec-core'
import { claimFileMutex, type FileMutex } from './file-mutex.js'
import type { BlobRef, WorktreeIdentity } from './operation-types.js'

export type SourceStat = { dev: string; ino: string; birthtimeNs: string }
export type SourceStats = { commonDir: SourceStat; root: SourceStat; gitDir: SourceStat }
export type PreviousDevices = { commonDir: string; root: string; gitDir: string }
export type SourceContinuityProof = {
  version: 1; operationId: string; inputId: string; operationRevision: number
  source: WorktreeIdentity; observed: SourceStats; previousDevices: PreviousDevices
  previousRecordRef: BlobRef; enabledDigest: string; configDigest: string
  pausedControlRevision: number; registeredAtMs: number
}
type EnabledBase = { source: WorktreeIdentity; configDigest: string; enabledAtMs: number; registeredNodeIds?: string[] }
export type EnabledRecord = EnabledBase & ({ version: 1 } | { version: 2; continuity: { version: 1; proofRef: BlobRef; previousRecordRef: BlobRef } })
export class SourceContinuityError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SourceContinuityError' }
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const fail = (message: string): never => { throw new SourceContinuityError('sync_source_continuity_changed', message) }
export const sourceStatText = (stat: SourceStat): string => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
export const rawRepositoryId = (commonDir: string, stat: SourceStat): string => hash(`${commonDir}:${sourceStatText(stat)}`)
export const rawPhysicalFingerprint = (root: SourceStat, gitDir: SourceStat): string => hash(`${sourceStatText(root)}:${sourceStatText(gitDir)}`)
export function readSourceStat(path: string): SourceStat {
  const stat = lstatSync(path, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }
}
export const readSourceStats = (source: Pick<WorktreeIdentity, 'commonDir' | 'canonicalRoot' | 'gitDir'>): SourceStats => ({ commonDir: readSourceStat(source.commonDir), root: readSourceStat(source.canonicalRoot), gitDir: readSourceStat(source.gitDir) })
export const sourceRegistryDirectory = (commonDir: string): string => {
  const path = join(projectRuntimeRoot(commonDir), 'sync')
  return existsSync(path) ? realpathSync(path) : path
}
export const sourceRegistrationPath = (commonDir: string, root: string, runtime = sourceRegistryDirectory(commonDir)): string => join(runtime, `enabled-${hash(root)}.json`)
export const registrationEvidenceDirectory = (commonDir: string, runtime = sourceRegistryDirectory(commonDir)): string => join(runtime, 'continuity-evidence')
export function writeRegistrationEvidence(commonDir: string, bytes: Buffer, runtime?: string): BlobRef {
  const directory = registrationEvidenceDirectory(commonDir, runtime)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return { sha256: putBlob(bytes, directory) }
}

/** 沿既有本机启用记录读取原字节；v1 不改写，v2 只增独立物理见证。 */
export function readEnabledRecord(path: string): { record: EnabledRecord; bytes: Buffer; digest: string } | null {
  if (!existsSync(path)) return null
  const bytes = readFileSync(path), record = JSON.parse(bytes.toString('utf8')) as EnabledRecord
  if (![1, 2].includes(record.version) || !record.source || typeof record.configDigest !== 'string'
    || record.version === 2 && (record.continuity?.version !== 1 || !/^[a-f0-9]{64}$/.test(record.continuity.proofRef?.sha256) || !/^[a-f0-9]{64}$/.test(record.continuity.previousRecordRef?.sha256))) fail('同步启用记录或连续性引用无效')
  return { record, bytes, digest: hash(bytes) }
}
export function registeredSources(runtime: string): EnabledRecord[] {
  return existsSync(runtime) ? readdirSync(runtime).filter(name => /^enabled-[a-f0-9]+\.json$/.test(name)).map(name => readEnabledRecord(join(runtime, name))!.record) : []
}

/** 同commonDir的启用与登记共用锁，不能在登记途中开出新raw仓库namespace。 */
export function sourceRegistrationLock(commonDir: string, root: string, runtime = sourceRegistryDirectory(commonDir)): FileMutex {
  if (runtime === root || runtime.startsWith(`${root}/`)) fail('源注册目录不能位于输入源码树')
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const stat = lstatSync(realpathSync(runtime))
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('源注册目录必须为当前用户独占的0700目录')
  const requested = join(runtime, '.source-registration-locks')
  mkdirSync(requested, { recursive: true, mode: 0o700 })
  const directory = realpathSync(requested)
  const mutex = claimFileMutex(join(directory, `${hash(commonDir)}.sqlite`))
  if (!mutex) throw new SourceContinuityError('sync_source_registration_busy', '同一来源正在启用或登记连续性，请稍后重试')
  return mutex
}
export function writeEnabledRecord(path: string, record: EnabledRecord, expectedDigest: string | null): void {
  if ((readEnabledRecord(path)?.digest ?? null) !== expectedDigest) throw new SourceContinuityError('sync_source_registration_stale', '启用记录已变化，拒绝覆盖')
  const temporary = `${path}.${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path)
}

/** 只接受调用者明确提供的旧 dev；当前 inode/birth 必须同时重现两个旧哈希。 */
export function proveSourceContinuity(source: WorktreeIdentity, current: WorktreeIdentity, observed: SourceStats, previousDevices: PreviousDevices): void {
  if (source.commonDir !== current.commonDir || source.canonicalRoot !== current.canonicalRoot || source.gitDir !== current.gitDir || source.branch !== current.branch) fail('来源路径、Git登记或分支与原授权不一致')
  for (const device of Object.values(previousDevices)) if (!/^(0|[1-9][0-9]*)$/.test(device)) fail('旧 dev 必须为显式非负十进制整数')
  const paths = { commonDir: source.commonDir, root: source.canonicalRoot, gitDir: source.gitDir }
  for (const left of Object.keys(paths) as (keyof SourceStats)[]) for (const right of Object.keys(paths) as (keyof SourceStats)[]) {
    if (paths[left] === paths[right] && previousDevices[left] !== previousDevices[right]) fail('同一实际路径的旧 dev 候选不一致')
  }
  const previous = Object.fromEntries(Object.entries(observed).map(([key, stat]) => [key, { ...stat, dev: previousDevices[key as keyof SourceStats] }])) as SourceStats
  if (rawRepositoryId(source.commonDir, previous.commonDir) !== source.repositoryId || rawPhysicalFingerprint(previous.root, previous.gitDir) !== source.physicalFingerprint) fail('显式旧 dev 无法同时精确重现原 repositoryId 与 physicalFingerprint')
}
export function readRegistrationEvidence(commonDir: string, ref: BlobRef, runtime?: string): Buffer {
  const result = readBlobByHash(ref.sha256, registrationEvidenceDirectory(commonDir, runtime))
  if (!result.ok) throw new SourceContinuityError('sync_source_continuity_changed', '连续性证据缺失')
  if (hash(result.bytes) !== ref.sha256) fail('连续性证据摘要不符')
  return result.bytes
}
function proofFor(record: Extract<EnabledRecord, { version: 2 }>, runtime: string): SourceContinuityProof {
  const proof = JSON.parse(readRegistrationEvidence(record.source.commonDir, record.continuity.proofRef, runtime).toString('utf8')) as SourceContinuityProof
  if (proof.version !== 1 || proof.enabledDigest !== record.continuity.previousRecordRef.sha256 || !same(proof.previousRecordRef, record.continuity.previousRecordRef)) fail('连续性证据与原启用引用不一致')
  const previous = JSON.parse(readRegistrationEvidence(record.source.commonDir, proof.previousRecordRef, runtime).toString('utf8')) as EnabledRecord
  if (!same(previous.source, proof.source) || previous.configDigest !== proof.configDigest
    || record.source.commonDir !== proof.source.commonDir || record.source.canonicalRoot !== proof.source.canonicalRoot || record.source.gitDir !== proof.source.gitDir
    || record.source.repositoryId !== proof.source.repositoryId || record.source.physicalFingerprint !== proof.source.physicalFingerprint) fail('连续性见证不能更改原物理来源或配置授权')
  proveSourceContinuity(proof.source, proof.source, proof.observed, proof.previousDevices)
  return proof
}

/** commonDir 见证只共享仓库哈希；每个 root 的旧 physical authority 必须单独证明。 */
export function projectSourceHashes(current: Pick<WorktreeIdentity, 'commonDir' | 'canonicalRoot' | 'gitDir'>, observed: SourceStats, runtime = sourceRegistryDirectory(current.commonDir)): Pick<WorktreeIdentity, 'repositoryId' | 'physicalFingerprint'> {
  let repositoryId: string | undefined, physicalFingerprint = rawPhysicalFingerprint(observed.root, observed.gitDir)
  const proofs = registeredSources(runtime).filter((record): record is Extract<EnabledRecord, { version: 2 }> => record.version === 2 && record.source.commonDir === current.commonDir).map(record => ({ record, proof: proofFor(record, runtime) }))
  for (const { record, proof } of proofs) {
    if (!same(proof.observed.commonDir, observed.commonDir)) fail('commonDir 物理身份再次变化，需要重新证明连续性')
    if (repositoryId !== undefined && repositoryId !== proof.source.repositoryId) fail('同一 commonDir 存在互斥的 logical repositoryId')
    repositoryId = proof.source.repositoryId
    if (record.source.canonicalRoot === current.canonicalRoot) {
      if (record.source.gitDir !== current.gitDir || !same(proof.observed.root, observed.root) || !same(proof.observed.gitDir, observed.gitDir)) fail('已登记来源物理身份再次变化，需要重新证明连续性')
      physicalFingerprint = proof.source.physicalFingerprint
    }
  }
  return { repositoryId: repositoryId ?? rawRepositoryId(current.commonDir, observed.commonDir), physicalFingerprint }
}
export const projectSourceIdentity = (current: WorktreeIdentity, observed: SourceStats): WorktreeIdentity => ({ ...current, ...projectSourceHashes(current, observed) })
