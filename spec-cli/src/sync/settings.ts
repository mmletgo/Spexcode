import { Ajv } from 'ajv'
import type { InputSnapshot, SyncBudget } from './operation-types.js'
import type { ElaborationFact } from './elaboration-types.js'
import type { RegisteredVerification } from './verification-plan.js'
import { isHostPrivatePath } from './candidate.js'
import { outputErrors, VERIFICATION_REGISTRATION_SCHEMA } from './elaboration-schema.js'
import { readObject, validateRepositoryPath, verifySnapshot } from './snapshot.js'

export type SyncSettings = {
  version: 'sync-settings-v1'
  nodeIds?: string[]
  sourcePaths: string[]
  testPaths: string[]
  readPaths: string[]
  verifications: RegisteredVerification[]
  mandatoryTests: { verificationId: string; testPath: string; testId: string }[]
  facts: ElaborationFact[]
  budget: SyncBudget
  callTimeoutMs?: number
}
export class SyncApplicationError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404 | 409 = 409) { super(message); this.name = 'SyncApplicationError' }
}
const paths = { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } }
const positive = { type: 'integer', minimum: 1 }
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['version', 'sourcePaths', 'testPaths', 'readPaths', 'verifications', 'mandatoryTests', 'facts', 'budget'],
  properties: {
    version: { const: 'sync-settings-v1' }, nodeIds: { ...paths, minItems: 1 }, sourcePaths: { ...paths, minItems: 1 }, testPaths: { ...paths, minItems: 1 }, readPaths: paths, callTimeoutMs: positive,
    facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['source', 'text'], properties: { source: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 } } } },
    budget: { type: 'object', additionalProperties: false, required: ['maxAttempts', 'maxCalls', 'maxRepairs', 'timeoutMs'], properties: { maxAttempts: positive, maxCalls: positive, maxRepairs: { type: 'integer', minimum: 0 }, timeoutMs: positive } },
    mandatoryTests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['verificationId', 'testPath', 'testId'], properties: { verificationId: { type: 'string', minLength: 1 }, testPath: { type: 'string', minLength: 1 }, testId: { type: 'string', pattern: '^\\S+$' } } } },
    verifications: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['definition', 'environment'], properties: {
      definition: { type: 'object', additionalProperties: false, required: ['id', 'command', 'cwd', 'timeoutMs'], properties: { id: { type: 'string', minLength: 1 }, command: { type: 'array', minItems: 2, items: { type: 'string', minLength: 1 } }, cwd: { type: 'string', minLength: 1 }, timeoutMs: positive } },
      environment: { type: 'object', additionalProperties: false, required: ['version', 'image', 'platform', 'memoryBytes', 'cpus', 'pidsLimit', 'scratchBytes', 'logBytes'], properties: { version: { type: 'string', minLength: 1 }, image: { type: 'string', pattern: '^\\S+@sha256:[a-f0-9]{64}$' }, platform: { enum: ['linux/arm64', 'linux/amd64'] }, memoryBytes: positive, cpus: { type: 'number', exclusiveMinimum: 0 }, pidsLimit: positive, scratchBytes: positive, logBytes: positive } },
    } } },
  },
})
export const coveredPath = (path: string, parents: readonly string[]): boolean => parents.some(parent => path === parent || path.startsWith(`${parent}/`))
function settingsPath(path: string): string {
  try { return validateRepositoryPath(path) }
  catch (error) { throw new SyncApplicationError('sync_configuration_invalid', error instanceof Error ? error.message : String(error)) }
}

/** 只读取不可变输入内的版本化授权；不猜宿主命令，也不合入本机凭据配置。 */
export function readSyncSettings(snapshot: InputSnapshot): { settings: SyncSettings; configDigest: string } {
  const entry = verifySnapshot(snapshot).find(file => file.path === '.spec/spexcode.json')
  if (!entry || entry.mode === '120000') throw new SyncApplicationError('sync_configuration_missing', '请在 .spec/spexcode.json 登记 sync 的授权目录、Docker 验证命令与预算后启用')
  let parsed: unknown
  try { parsed = JSON.parse(readObject(snapshot.source.commonDir, entry.oid).toString('utf8')) as unknown }
  catch { throw new SyncApplicationError('sync_configuration_invalid', '项目配置 JSON 无法解析，请检查格式') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyncApplicationError('sync_configuration_invalid', '项目配置须为 JSON 对象')
  const config = parsed as { sync?: unknown }
  if (!validate(config.sync)) throw new SyncApplicationError('sync_configuration_invalid', `sync 配置缺口：${new Ajv().errorsText(validate.errors)}`)
  const settings = config.sync as SyncSettings
  if (settings.nodeIds?.some(id => !id.trim() || id !== id.trim())) throw new SyncApplicationError('sync_configuration_invalid', 'nodeIds 必须为非空精确节点 ID')
  if (settings.callTimeoutMs !== undefined && settings.callTimeoutMs > settings.budget.timeoutMs) throw new SyncApplicationError('sync_configuration_invalid', 'callTimeoutMs 不能超过操作总预算 timeoutMs')
  for (const path of [...settings.sourcePaths, ...settings.testPaths, ...settings.readPaths]) {
    settingsPath(path)
    if (isHostPrivatePath(path)) throw new SyncApplicationError('sync_configuration_invalid', `授权不能读取或写入私有资料：${path}`)
  }
  if ([...settings.sourcePaths, ...settings.testPaths].some(path => path === '.spec' || path.startsWith('.spec/') || path.split('/').some(part => ['node_modules', '.codex', '.claude', '.ssh'].includes(part)))) throw new SyncApplicationError('sync_configuration_invalid', '源码与测试授权不能覆盖 Spec、依赖或本机私有目录')
  if (new Set(settings.verifications.map(item => item.definition.id)).size !== settings.verifications.length) throw new SyncApplicationError('sync_configuration_invalid', '验证登记 ID 必须唯一')
  for (const item of settings.verifications) {
    const errors = outputErrors(item.definition, VERIFICATION_REGISTRATION_SCHEMA)
    if (errors.length) throw new SyncApplicationError('sync_configuration_invalid', `验证登记不合法：${errors.join('; ')}`)
    const { command, cwd } = item.definition
    if (cwd !== '.') settingsPath(cwd)
    if (command[0] !== 'node' || !command.includes('--test') || command.some(arg => arg.startsWith('--test-reporter') || arg === '--')) throw new SyncApplicationError('sync_verification_unsupported', '支持已登记的 Docker Node --test 验证')
  }
  if (settings.facts.some(fact => !fact.source.trim() || !fact.text.trim())) throw new SyncApplicationError('sync_configuration_invalid', '业务事实须有具名来源和非空文本')
  for (const item of settings.mandatoryTests) {
    settingsPath(item.testPath)
    if (!settings.verifications.some(verification => verification.definition.id === item.verificationId) || coveredPath(item.testPath, [...settings.sourcePaths, ...settings.testPaths])) throw new SyncApplicationError('sync_configuration_invalid', '保护测试须引用已登记验证，且不能位于模型可写范围')
  }
  return { settings, configDigest: entry.digest }
}
