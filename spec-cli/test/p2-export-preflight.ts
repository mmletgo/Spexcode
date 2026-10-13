import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv } from 'ajv'
import { parseParts } from '@spexcode/spec-core/contracts'
import type { Acceptance, ContractFinding } from '@spexcode/spec-core/contracts'
import { runStructuredSession } from '../src/session-structured.js'
import { elaborate, elaborationDigest } from '../src/sync/elaboration.js'
import { ELABORATION_SCHEMA } from '../src/sync/elaboration-schema.js'
import type { ElaborationRunner } from '../src/sync/elaboration-types.js'
import { runGeneration } from '../src/sync/generation.js'
import { checkGenerationContractIntent, readFrozenContracts } from '../src/sync/frozen-contracts.js'
import { exportCandidate, freezeCandidate } from '../src/sync/candidate.js'
import { captureInputSnapshot, contentHash, readEvidence, readObject, readTree } from '../src/sync/snapshot.js'
import type { SnapshotManifest } from '../src/sync/snapshot.js'
import { planAcceptanceRuns } from '../src/sync/verification-plan.js'
import { executeVerification, verificationExportDigest } from '../src/sync/verification-executor.js'

export const FIXTURE_FILES = ['AGENTS.md', 'package.json', 'fixture-facts.txt', '.spec/export/spec.md', '.spec/export/export-contract/spec.md', 'trusted-oracle/export.oracle.test.mjs'] as const
export const WRITE_PATHS = ['.spec/export/export-contract/spec.md', 'src/export.js', 'tests/export.generated.test.mjs']
export const ORACLE_IDS = ['ORACLE-ROWS', 'ORACLE-IDEMPOTENCY', 'ORACLE-INVALID', 'ORACLE-OWNER', 'ORACLE-CALLBACKS', 'ORACLE-ATTEMPTS', 'ORACLE-RACES', 'ORACLE-RETRY-STATE']
export const VERIFICATION = { id: 'VERIFY-EXPORT-01', command: ['node', '--test', 'tests/export.generated.test.mjs', 'trusted-oracle/export.oracle.test.mjs'], cwd: '.', timeoutMs: 30_000 }
const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = join(sourceDirectory, 'fixtures/spec-sync/export-implementation-repo')
const contractPath = '.spec/export/export-contract/spec.md'
const registrationSchema = new Ajv().addSchema(ELABORATION_SCHEMA, 'elaboration')
const validVerifyId = registrationSchema.compile({ $ref: 'elaboration#/properties/changes/items/properties/tables/properties/VERIFY/items/properties/id' })
const validAcceptanceCommand = registrationSchema.compile({ $ref: 'elaboration#/properties/changes/items/properties/tables/properties/AC/items/properties/command' })

export function assertVerificationRegistrationId(id: string): void {
  if (!validVerifyId(id) || !validAcceptanceCommand(id)) throw new Error(`验证登记不符合生产 VERIFY ID/AC.command schema: ${id}`)
}

/** 独立 fixture 冻结业务输入；native 库级桥固定使用真实后端 commit，不冒充产品交付入口。 */
export async function runExportPreflight(outputParent: string): Promise<{ status: string; evidenceDirectory: string }> {
  assertVerificationRegistrationId(VERIFICATION.id)
  const backendRoot = resolve(sourceDirectory, '../..'), backendBase = execFileSync('git', ['-C', backendRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = randomUUID(), evidenceDirectory = join(resolve(outputParent), `run-${runId}`)
  mkdirSync(evidenceDirectory, { recursive: true })
  const save = (name: string, value: unknown): void => writeFileSync(join(evidenceDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  const saveFiles = (folder: string, files: ReadonlyMap<string, string>): void => {
    for (const [path, text] of files) {
      const target = join(evidenceDirectory, folder, path)
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text, { flag: 'wx' })
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'spex-export-preflight-'))
  const initial = new Map<string, string>(FIXTURE_FILES.map(path => [path, readFileSync(join(fixtureDirectory, path), 'utf8')]))
  for (const [path, text] of initial) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' })
  execFileSync('git', ['-C', root, 'add', '.'])
  execFileSync('git', ['-C', root, '-c', 'user.name=Preflight Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Freeze natural-language export fixture'], { stdio: 'ignore' })
  const snapshot = await captureInputSnapshot(root), commonDir = snapshot.source.commonDir
  const manifest = JSON.parse(readEvidence(commonDir, snapshot.manifestBlob).toString()) as SnapshotManifest
  const files = new Map(manifest.entries.filter(entry => entry.mode !== '120000').map(entry => [entry.path, readObject(commonDir, entry.oid).toString('utf8')]))
  saveFiles('input', files)
  save('input.json', { version: 1, runId, boundary: 'library-preflight-only; no apply/commit/receipt/product-entry proof', backend: { root: backendRoot, base: backendBase }, fixture: snapshot, manifest, verification: VERIFICATION, model: 'gpt-6.1-sol', effort: 'high' })
  let dispatch = 0
  const runner: ElaborationRunner = async request => {
    const number = ++dispatch
    const bridged = { ...request, root: backendRoot, base: backendBase, model: 'gpt-6.1-sol', effort: 'high' as const }
    save(`native-${number}-request.json`, { ...bridged, signal: undefined, fixtureSnapshotId: snapshot.id })
    try {
      const result = await runStructuredSession(bridged)
      save(`native-${number}-result.json`, result)
      return result
    } catch (error) {
      const failure = error as Error & { code?: string; sessionId?: string; threadId?: string; turnId?: string }
      save(`native-${number}-failure.json`, { code: failure.code, message: failure.message, sessionId: failure.sessionId, threadId: failure.threadId, turnId: failure.turnId })
      throw error
    }
  }
  const initialContract = files.get(contractPath)!, rawSource = parseParts(initialContract)!.rawSource
  const facts = [{ source: 'decision:fixture-author-policy', text: files.get('fixture-facts.txt')! }]
  const elaboration = await elaborate({ root, requestKey: `${runId}:elaboration`, intent: { nodeId: 'export-contract', rawSource }, targets: [{ nodeId: 'export-contract', path: contractPath, source: initialContract, sourceDigest: elaborationDigest(initialContract) }], files, facts, model: 'gpt-6.1-sol', effort: 'high', maxRepairs: 2, maxCalls: 6, timeoutMs: 900_000, totalTimeoutMs: 3_600_000 }, { runner })
  save('elaboration.json', { ...elaboration, graph: undefined, contracts: undefined, coverage: undefined })
  saveFiles('elaborated', new Map(elaboration.changes.map(change => [change.path, change.source])))
  const finish = async (status: string): Promise<{ status: string; evidenceDirectory: string }> => {
    const unchanged = await captureInputSnapshot(root)
    if (unchanged.id !== snapshot.id) throw new Error('预检修改了真实输入或 index')
    save('outcome.json', { status, runId, fixtureSnapshotId: snapshot.id, backendBase, dispatchCount: dispatch, sourceUnchanged: true, applied: false, productComplete: false })
    return { status, evidenceDirectory }
  }
  if (elaboration.status !== 'complete') return finish(`elaboration:${elaboration.status}`)
  const detailedFiles = new Map(files)
  for (const change of elaboration.changes) detailedFiles.set(change.path, change.source)
  const detailed = await readFrozenContracts(root, detailedFiles)
  const acceptance = [...detailed.graph.items.values()].filter((item): item is Acceptance => item.kind === 'AC')
  if (!acceptance.length || elaboration.blockedIds.length || elaboration.blockedFlows.length) throw new Error('预检需要全业务细化且无阻塞，不能缩小必需集合')
  const allowedScope = { paths: WRITE_PATHS, contractIds: elaboration.readyIds, flowIds: elaboration.readyFlowIds }
  const generation = await runGeneration({ root, requestKey: `${runId}:generation`, snapshot, manifest, files, contracts: detailed.contracts, elaboratedSpecs: elaboration.changes.map(change => ({ path: change.path, source: change.source })), readyIds: elaboration.readyIds, blockedIds: elaboration.blockedIds, intent: { nodeId: 'export-contract', rawSource }, facts, existingAcceptance: acceptance, allowedScope, policy: { version: 'fixture-author-v1', digest: contentHash(JSON.stringify({ facts, VERIFICATION, allowedScope })) }, timeoutMs: 900_000, model: 'gpt-6.1-sol', effort: 'high' }, {
    runner,
    validateCandidate: async candidate => {
      const candidateFiles = new Map(readTree(commonDir, candidate.tree).filter(entry => entry.mode !== '120000').map(entry => [entry.path, readObject(commonDir, entry.oid).toString('utf8')]))
      const next = await readFrozenContracts(root, candidateFiles)
      const findings: ContractFinding[] = [...next.findings, ...checkGenerationContractIntent(detailed, next, { newNodeRawSources: new Map(), verifications: [VERIFICATION] })]
      const ownTest = candidateFiles.get('tests/export.generated.test.mjs') ?? ''
      if (!ownTest.includes('assert') || /trusted-oracle|ORACLE-/.test(ownTest)) findings.push({ code: 'generated-test-independent', severity: 'error', nodeId: 'export-contract', path: contractPath, message: '生成测试必须新增业务断言且不能复制或调用 oracle' })
      return findings
    },
  })
  save('generation.json', { ...generation, candidateFiles: undefined })
  if (generation.candidateFiles) saveFiles('candidate-output', new Map([...generation.candidateFiles].filter(([path]) => WRITE_PATHS.includes(path))))
  if (generation.status !== 'reviewed' || !generation.candidate || !generation.candidateFiles) return finish(`generation:${generation.status}`)
  // 再调用生产冻结边界，证明返回的结构化 bytes 与已审查 candidate 确实相同。
  const frozen = freezeCandidate(snapshot, generation.output, allowedScope)
  if (frozen.digest !== generation.candidate.digest) throw new Error('审查候选与重新冻结内容不一致')
  const finalContracts = await readFrozenContracts(root, generation.candidateFiles)
  const jobs = planAcceptanceRuns(finalContracts.graph, acceptance.map(item => item.id), [{ definition: VERIFICATION, environment: { version: 'export-preflight-node-v1', image: 'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392', platform: 'linux/arm64', memoryBytes: 256 * 1024 * 1024, cpus: 1, pidsLimit: 64, scratchBytes: 16 * 1024 * 1024, logBytes: 256 * 1024 } }])
  const exportRoot = join(root, '../', `spex-export-validation-${runId}`)
  const exported = exportCandidate(commonDir, frozen, exportRoot)
  if (exported.excludedPaths.length) throw new Error(`白名单夹具不应有排除项: ${exported.excludedPaths.join(',')}`)
  save('candidate.json', { candidate: frozen, manifest: JSON.parse(readEvidence(commonDir, frozen.manifestBlob).toString()), actualDiff: JSON.parse(readEvidence(commonDir, frozen.actualDiffBlob).toString()), export: exported })
  for (const [number, job] of jobs.entries()) {
    const policy = { ...job.policy, expectedTestIds: [...new Set([...job.policy.expectedTestIds, ...ORACLE_IDS])] }
    save(`verification-${number}-policy.json`, { requiredAcIds: acceptance.map(item => item.id), bindings: job.bindings, policy })
    let checkpointNumber = 0
    const result = await executeVerification({ runId: `${runId}:${number}`, inputDigest: snapshot.contentDigest, candidateDigest: frozen.digest, candidateExportDigest: await verificationExportDigest(exportRoot), candidateExportPath: exportRoot, privateScratchRoot: mkdtempSync(join(tmpdir(), 'spex-export-docker-')), policy }, { onCheckpoint: async checkpoint => save(`verification-${number}-checkpoint-${++checkpointNumber}.json`, checkpoint) })
    save(`verification-${number}-result.json`, result)
    if (result.status !== 'passed') return finish(`verification:${result.status}`)
  }
  return finish('library-preflight:passed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputParent = process.argv[2]
  if (!outputParent) throw new Error('需要明确用户可视化目录中的 p2-export-preflight 输出目录')
  console.log(JSON.stringify(await runExportPreflight(outputParent)))
}
