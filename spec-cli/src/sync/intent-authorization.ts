import { Ajv } from 'ajv'
import { parseFrontmatter, parseParts } from '@spexcode/spec-core/contracts'
import { contentHash, validateRepositoryPath } from './snapshot.js'

export const INTENT_AUTHORIZATION_PATH = '.spec/sync-intent-authorizations.json'
export type IntentAuthorization = { path: string; beforeRawDigest: string | null; afterRawDigest: string | null; source: string }
export type RawIntentChange = Omit<IntentAuthorization, 'source'> & { beforeRaw: string | null; afterRaw: string | null }
export type IntentAuthorizationCheck = {
  artifactPath: typeof INTENT_AUTHORIZATION_PATH
  artifactDigest: string | null
  changes: (Omit<RawIntentChange, 'beforeRaw' | 'afterRaw'> & { authorization: IntentAuthorization | null })[]
}
const rawDigest = { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] }
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false, required: ['version', 'authorizations'],
  properties: {
    version: { const: 'sync-intent-authorizations-v1' },
    authorizations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['path', 'beforeRawDigest', 'afterRawDigest', 'source'],
      properties: { path: { type: 'string' }, beforeRawDigest: rawDigest, afterRawDigest: rawDigest, source: { type: 'string', minLength: 1 } },
    } },
  },
})
const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid_intent_authorizations' }) }

function raw(source: string | undefined): string | null {
  if (source === undefined) return null
  const { body } = parseFrontmatter(source)
  return parseParts(body)?.rawSource ?? body.trim()
}

export function rawIntentChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, paths: readonly string[]): RawIntentChange[] {
  return [...new Set(paths)].sort().flatMap(path => {
    const beforeRaw = raw(before.get(path)), afterRaw = raw(after.get(path))
    return beforeRaw === afterRaw ? [] : [{ path, beforeRaw, afterRaw, beforeRawDigest: beforeRaw === null ? null : contentHash(beforeRaw), afterRawDigest: afterRaw === null ? null : contentHash(afterRaw) }]
  })
}

export function readIntentAuthorizations(source: string | undefined): IntentAuthorization[] {
  if (source === undefined) return []
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown }
  catch { return invalid('受信原意授权文件不是有效 JSON') }
  if (!validate(parsed)) invalid(`受信原意授权格式错误: ${new Ajv().errorsText(validate.errors)}`)
  const { authorizations } = parsed as { authorizations: IntentAuthorization[] }
  const paths = new Set<string>()
  for (const authorization of authorizations) {
    try { validateRepositoryPath(authorization.path) }
    catch { invalid(`受信原意授权必须使用规范仓库路径: ${authorization.path}`) }
    if (!authorization.path.startsWith('.spec/') || !authorization.path.endsWith('/spec.md') || authorization.path.split('/').length < 3) invalid(`受信原意授权必须指向 Spec: ${authorization.path}`)
    if (!authorization.source.trim() || authorization.beforeRawDigest === authorization.afterRawDigest) invalid(`受信原意授权缺少来源或实际差量: ${authorization.path}`)
    if (paths.has(authorization.path)) invalid(`受信原意授权路径重复: ${authorization.path}`)
    paths.add(authorization.path)
  }
  return authorizations
}

export function bindIntentAuthorizations(changes: readonly RawIntentChange[], source: string | undefined): IntentAuthorizationCheck {
  const authorizations = readIntentAuthorizations(source)
  return {
    artifactPath: INTENT_AUTHORIZATION_PATH, artifactDigest: source === undefined ? null : contentHash(source),
    changes: changes.map(({ beforeRaw: _beforeRaw, afterRaw: _afterRaw, ...change }) => ({ ...change, authorization: authorizations.find(authorization => authorization.path === change.path && authorization.beforeRawDigest === change.beforeRawDigest && authorization.afterRawDigest === change.afterRawDigest) ?? null })),
  }
}
