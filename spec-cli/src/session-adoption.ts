import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { gitCommonDir, HARNESS_IDENTITIES, listSessionIds, readRecordEntry, sessionArtifactPath } from '@spexcode/spec-core'
import { resolveDatabasePath, type ExternalSessionClaim, type ExternalSessionIdentity } from '@spexcode/session-application'
import { configuredSessionApplication } from './session-application.js'
import { withSessionRecordLockSync } from './session-record-lock.js'

const NATIVE_ID = /^(?!-)[0-9A-Za-z_-]{1,256}$/
const nativeHarnesses = HARNESS_IDENTITIES.filter(({ id }) => !id.endsWith('-headless') && !id.endsWith('-structured'))
const projectKey = () => realpathSync(gitCommonDir())
const hasCanonicalStore = () => existsSync(`${resolveDatabasePath()}.json-migration.json`)

function ownNativeIdentity(): Omit<ExternalSessionIdentity, 'projectKey'> | null {
  const identities = nativeHarnesses.flatMap(({ id: harness, sessionEnvVar }) => {
    const sessionId = process.env[sessionEnvVar]?.trim()
    return sessionId ? [{ harness, sessionId }] : []
  })
  return identities.length === 1 && NATIVE_ID.test(identities[0].sessionId) ? identities[0] : null
}

function ownExternalIdentity(): ExternalSessionIdentity {
  const identity = ownNativeIdentity()
  if (!identity) throw new Error('run this command inside the native chat with one unambiguous harness thread identity')
  return { ...identity, projectKey: projectKey() }
}

export function currentExternalSessionId(harness: string): string | null {
  const identity = ownNativeIdentity()
  return identity?.harness === harness ? identity.sessionId : null
}

export function readExternalClaims(id?: string): ExternalSessionClaim[] {
  return hasCanonicalStore() ? configuredSessionApplication().readExternalClaims(projectKey(), id) : []
}

export function externalClaimFilesPath({ projectKey, sessionId }: ExternalSessionIdentity): string {
  const digest = createHash('sha256').update(projectKey).digest('hex')
  return sessionArtifactPath(sessionId, `external-${digest}-files.json`)
}

export function externalControlRefusal(id: string): string | null {
  return readExternalClaims(id).length ? `session ${id} is an external chat with no SpexCode runtime control` : null
}

export function adoptCurrentSession(): ExternalSessionClaim {
  const identity = ownExternalIdentity()
  return withSessionRecordLockSync(identity.sessionId, () => {
    for (const id of new Set([identity.sessionId, ...listSessionIds()])) {
      const record = readRecordEntry(id)
      if (id === identity.sessionId && record.kind === 'corrupt')
        throw new Error(`thread ${identity.sessionId} has an unreadable session record`)
      if (record.kind === 'ok' && record.raw.governed && (id === identity.sessionId || record.raw.harness_session_id === identity.sessionId))
        throw new Error(`thread ${identity.sessionId} already belongs to a SpexCode session record`)
    }
    return configuredSessionApplication().adoptExternalSession(identity)
  })
}

export function unadoptCurrentSession(): string {
  const identity = ownExternalIdentity()
  const removed = withSessionRecordLockSync(identity.sessionId, () =>
    hasCanonicalStore() && configuredSessionApplication().revokeExternalSession(identity))
  if (!removed) throw new Error(`thread ${identity.sessionId} has no active claim in this project`)
  return identity.sessionId
}

export function ownAdoptedSessionId(): string | null {
  const identity = ownNativeIdentity()
  if (!identity) return null
  const claim = readExternalClaims(identity.sessionId)[0]
  return claim?.harness === identity.harness && claim.revokedAtMs === null ? identity.sessionId : null
}
