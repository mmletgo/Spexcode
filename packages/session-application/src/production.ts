import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'

import {
  applyComponentMigrations,
  openProtocol,
  ProtocolError,
  type Message,
  type MessageInput,
  type ProtocolTransaction,
  type SessionAddress,
  type SessionProtocol,
  payloadHash,
} from '@spexcode/session-protocol'
import {
  encodeEventJson,
  openSessionEvents,
  type SessionEvent,
  type SessionEventStore,
} from '@spexcode/session-events'
import {
  openRuntimeBindings,
  type RuntimeBinding,
  type SessionRuntimeBindings,
} from '@spexcode/session-runtime'
import { openTopology, type SessionTopology, type TopologyEdge } from '@spexcode/session-topology'

import { SESSION_APPLICATION_MIGRATIONS } from './schema.js'

const SESSION_ID = /^(?!-)[0-9A-Za-z_-]{1,256}$/
const STATUS = /^[0-9A-Za-z._:-]{1,64}$/
const STATE_EVENT = 'session.state.changed.v1'
const MESSAGE_EVENT = 'session.message.sent.v1'
const PARENT_RELATION = 'parent'
const WATCH_RELATION = 'watch'
const PARENT_WATCH_RELATION = 'watch:parent'
const MANUAL_WATCH_RELATION = 'watch:manual'
const compositions = new Map<string, ProductionSessionApplication>()

/** Additive post-commit facts; consumers can select the work implied by one commit without re-enumerating all sessions. */
export const SESSION_CHANGE = Object.freeze({
  state: 1 << 0,
  topology: 1 << 1,
  delivery: 1 << 2,
} as const)
export type SessionChangeMask = number

export interface LocalityPrecondition {
  (databasePath: string): void
}

export interface SessionState {
  sessionId: string
  status: string
  proposal: string | null
  note: string | null
  parentSessionId: string | null
  updatedAtMs: number
}

export interface SessionStateChange {
  sessionId: string
  status: string
  proposal: string | null
  note: string | null
  previousProposal: string | null
  previousNote: string | null
  parentSessionId: string | null
  previousStatus: string | null
  previousParentSessionId: string | null
  reason: string | null
}

export interface ChangedSessionIds {
  /** The append-only session-event rowid to use as the next watermark. */
  watermark: number
  /** SQLite's connection-local data version observed under the same write transaction barrier. */
  dataVersion: number
  /** Distinct event subjects appended after the requested watermark. */
  subjectSessionIds: string[]
  /** Watcher recipients currently attached to those subjects, resolved inside the same read barrier. */
  recipientSessionIds: string[]
}

export interface NativeRuntimeIdentity {
  namespace: string
  runtimeKind: string
  nativeSessionId: string
  nativeStartToken: string
  metadata?: Record<string, unknown>
}

export interface ExternalSessionIdentity {
  projectKey: string
  harness: string
  sessionId: string
}

export interface ExternalSessionClaim extends ExternalSessionIdentity {
  claimedAtMs: number
  revokedAtMs: number | null
}

export class ExternalSessionControlError extends Error {
  readonly code = 'external_session_read_only'

  constructor(sessionId: string) {
    super(`session ${sessionId} belongs to an external thread and cannot participate in runtime control`)
    this.name = 'ExternalSessionControlError'
  }
}

export interface ProjectSessionApplicationOptions {
  databasePath: string
  locality: LocalityPrecondition
  now?: () => number
  onCommitted?: (result: Pick<CommittedSessionChange, 'recipients' | 'subjectSessionIds' | 'changeMask'>) => void
  /** Runtime binding is the event that makes an existing canonical delivery debt drainable. */
  onRuntimeBound?: (sessionId: string) => void
}

export interface CreateSessionInput {
  sessionId: string
  status?: string
  parentSessionId?: string | null
  runtime?: NativeRuntimeIdentity
  eventId?: string
  updatedAtMs?: number
  proposal?: string | null
  note?: string | null
}

export interface TransitionSessionInput {
  status?: string
  proposal?: string | null
  note?: string | null
  parentSessionId?: string | null
  reason?: string | null
  /** An upstream policy may resolve recipients before this neutral transition. */
  recipientSessionIds?: readonly string[]
}

export interface CommittedSessionChange {
  state: SessionState
  event: SessionEvent
  edge: TopologyEdge | null
  recipients: string[]
  messages: Message[]
  /** Session rows whose state or topology may have changed in this transaction. */
  subjectSessionIds: string[]
  /** Bitwise OR of SESSION_CHANGE flags describing the durable effects. */
  changeMask: SessionChangeMask
}

export interface WatchEvent {
  watcherSessionId: string
  subjectSessionId: string
  event: SessionEvent
  sources: readonly string[]
}

export interface ConversationMessageInput {
  text: string
  from: string | null
  replyVia?: 'note'
}

export interface ProductionSessionApplication extends SessionApplication {
  readonly databasePath: string
  readonly protocol: SessionProtocol
  readonly topology: SessionTopology
  readonly events: SessionEventStore
  readonly runtimeBindings: SessionRuntimeBindings
  adoptExternalSession(identity: ExternalSessionIdentity): ExternalSessionClaim
  revokeExternalSession(identity: ExternalSessionIdentity): boolean
  readExternalClaims(projectKey: string, sessionId?: string): ExternalSessionClaim[]
  createSession(input: CreateSessionInput): SessionState
  transitionSession(sessionId: string, input: TransitionSessionInput): CommittedSessionChange
  enqueueMessage(sessionId: string, message: MessageInput): Message
  enqueueConversationMessage(sessionId: string, message: MessageInput, conversation: ConversationMessageInput): Message
  broadcast(senderSessionId: string, recipients: readonly string[], message: MessageInput): Record<string, string>
  attachWatcher(watcherSessionId: string, subjectSessionId: string, channel?: string): TopologyEdge
  detachWatcher(watcherSessionId: string, subjectSessionId: string, channel?: string): TopologyEdge
  listWatchers(watcherSessionId: string, channel?: string): TopologyEdge[]
  bindRuntime(sessionId: string, identity: NativeRuntimeIdentity, expectedGeneration?: number): RuntimeBinding
  resolveRuntime(sessionId: string, namespace: string): RuntimeBinding | null
  dequeueForRuntime(sessionId: string, namespace: string, expectedGeneration?: number, expectedMessageId?: string): Message | null
  readPendingMessages(sessionId: string): readonly Message[]
  readMessageHistory(sessionId: string): readonly Message[]
  /** The idempotency key each named message was enqueued with (absent ids are simply missing): a scoped lookup, never a history replay. */
  readMessageKeys(sessionId: string, messageIds: readonly string[]): ReadonlyMap<string, string | null>
  dequeuePendingMessage(sessionId: string, expectedMessageId: string): Message | null
  readState(sessionId: string): SessionState | null
  /** The protocol address row itself — present for every registered session, governed or not; null means never initialized. */
  readAddress(sessionId: string): SessionAddress | null
  readEvents(sessionId: string, afterSequence?: number): readonly SessionEvent[]
  readChangedSessionIdsSince(watermark: number): ChangedSessionIds
  readWatchEvents(watcherSessionIds: readonly string[], limit?: number): readonly WatchEvent[]
  readFollowCursor(watcherSessionId: string, subjectSessionId: string): number | null
  advanceFollowCursor(watcherSessionId: string, subjectSessionId: string, eventSequence: number): void
  replayState(sessionId: string): SessionState | null
  close(): void
}

export interface SessionApplication {
  notifyRecipients(subjectSessionId: string, message: MessageInput): NotificationResult
  attachAndNotify(
    fromSessionId: string,
    subjectSessionId: string,
    relationType: string,
    message: MessageInput,
  ): NotificationResult
}

export interface NotificationResult {
  edge: TopologyEdge | null
  recipients: string[]
  messages: Message[]
}

interface StateRow extends Record<string, unknown> {
  session_id: string
  status: string
  parent_session_id: string | null
  updated_at_ms: number | bigint
  proposal: string | null
  note: string | null
}

const requirePath = (databasePath: string): void => {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath) || databasePath.startsWith('file:') || databasePath.includes('\0') || databasePath.endsWith('/')) {
    throw new TypeError('session application requires an explicit absolute databasePath naming a file')
  }
}

const requireId = (value: string, field: string): void => {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new TypeError(`${field} must be a valid protocol session id`)
}

const uniqueSessionIds = (...ids: readonly (string | null | undefined)[]): string[] =>
  [...new Set(ids.filter((id): id is string => id !== null && id !== undefined))]

const requireStatus = (value: string): void => {
  if (typeof value !== 'string' || !STATUS.test(value)) throw new TypeError('session status has an invalid grammar')
}

const externalClaim = (row: Record<string, unknown>): ExternalSessionClaim => ({
  projectKey: String(row.project_key),
  harness: String(row.harness),
  sessionId: String(row.session_id),
  claimedAtMs: Number(row.claimed_at_ms),
  revokedAtMs: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
})

const assertExternalAddressUnclaimed = (tx: ProtocolTransaction, sessionId: string, otherId = sessionId): void => {
  const claim = tx.query('SELECT session_id FROM session_external_claims WHERE session_id IN (?,?) LIMIT 1', sessionId, otherId)[0]
  if (claim) throw new ExternalSessionControlError(String(claim.session_id))
}

const eventId = (): string => randomBytes(16).toString('hex')

const readStateInTransaction = (tx: ProtocolTransaction, sessionId: string): SessionState | null => {
  const row = tx.query(
    'SELECT session_id, status, proposal, note, parent_session_id, updated_at_ms FROM session_application_state WHERE session_id=?',
    sessionId,
  )[0] as StateRow | undefined
  return row
    ? {
        sessionId: String(row.session_id),
        status: String(row.status),
        proposal: row.proposal === null ? null : String(row.proposal),
        note: row.note === null ? null : String(row.note),
        parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
        updatedAtMs: Number(row.updated_at_ms),
      }
    : null
}

const messageForEvent = (state: SessionStateChange, id: string): MessageInput => ({
  kind: STATE_EVENT,
  body: encodeEventJson({
    eventId: id,
    sessionId: state.sessionId,
    status: state.status,
    proposal: state.proposal,
    note: state.note,
    previousProposal: state.previousProposal,
    previousNote: state.previousNote,
    parentSessionId: state.parentSessionId,
    previousStatus: state.previousStatus,
    previousParentSessionId: state.previousParentSessionId,
    reason: state.reason,
  }),
  senderSessionId: state.sessionId,
  idempotencyKey: id,
})

export function openProjectSessionApplication(options: ProjectSessionApplicationOptions): ProductionSessionApplication {
  requirePath(options.databasePath)
  if (typeof options.locality !== 'function') throw new TypeError('session application requires a locality precondition')
  options.locality(options.databasePath)
  const existing = compositions.get(options.databasePath)
  if (existing) return existing

  const protocol = openProtocolOnce(options.databasePath, options.now)
  const topology = openTopology(protocol)
  const events = openSessionEvents(protocol)
  const runtimeBindings = openRuntimeBindings(protocol)
  applyComponentMigrations(protocol, 'session-application', SESSION_APPLICATION_MIGRATIONS)
  const now = options.now ?? (() => Date.now())
  const initialized = new Set<string>()

  const initialize = (sessionId: string): void => {
    requireId(sessionId, 'sessionId')
    if (!initialized.has(sessionId)) {
      protocol.initialize(sessionId)
      initialized.add(sessionId)
    }
  }

  const notifyCommitted = (result: Pick<CommittedSessionChange, 'recipients' | 'subjectSessionIds' | 'changeMask'>): void => {
    options.onCommitted?.(result)
  }

  const app: ProductionSessionApplication = {
    databasePath: options.databasePath,
    protocol,
    topology,
    events,
    runtimeBindings,

    adoptExternalSession(identity) {
      const { projectKey, harness, sessionId } = identity
      requirePath(projectKey)
      requireStatus(harness)
      requireId(sessionId, 'sessionId')
      const claimedAtMs = now()
      return protocol.withTransaction(tx => {
        const active = tx.query('SELECT * FROM session_external_claims WHERE session_id=? AND revoked_at_ms IS NULL', sessionId)[0]
        if (active) {
          if (active.project_key !== projectKey || active.harness !== harness)
            throw new Error(`external thread ${sessionId} already has a different project or harness claim`)
          return externalClaim(active)
        }
        if (tx.query('SELECT session_id FROM session_external_claims WHERE session_id=? AND harness<>? LIMIT 1', sessionId, harness).length)
          throw new Error(`external thread ${sessionId} already belongs to a different harness address`)
        if (readStateInTransaction(tx, sessionId) || tx.query(
          'SELECT 1 FROM session_runtime_bindings WHERE protocol_session_id=? OR native_session_id=? LIMIT 1',
          sessionId, sessionId,
        ).length || tx.query(
          'SELECT 1 FROM topology_edges WHERE removed_at_ms IS NULL AND (from_session_id=? OR to_session_id=?) LIMIT 1',
          sessionId, sessionId,
        ).length) throw new Error(`thread ${sessionId} already has a lifecycle, binding, or control relation`)
        tx.initialize(sessionId)
        tx.exec(`INSERT INTO session_external_claims(project_key,session_id,harness,claimed_at_ms,revoked_at_ms)
          VALUES(?,?,?,?,NULL) ON CONFLICT(project_key,session_id) DO UPDATE
          SET revoked_at_ms=NULL`, projectKey, sessionId, harness, claimedAtMs)
        return externalClaim(tx.query('SELECT * FROM session_external_claims WHERE project_key=? AND session_id=?', projectKey, sessionId)[0])
      })
    },

    revokeExternalSession({ projectKey, harness, sessionId }) {
      requirePath(projectKey)
      requireStatus(harness)
      requireId(sessionId, 'sessionId')
      const revokedAtMs = now()
      return protocol.withTransaction(tx => tx.exec(`UPDATE session_external_claims
        SET revoked_at_ms=MAX(claimed_at_ms,?) WHERE project_key=? AND harness=? AND session_id=?
        AND revoked_at_ms IS NULL`, revokedAtMs, projectKey, harness, sessionId).changes === 1)
    },

    readExternalClaims(projectKey, sessionId) {
      requirePath(projectKey)
      return protocol.withTransaction(tx => (sessionId === undefined
        ? tx.query('SELECT * FROM session_external_claims WHERE project_key=?', projectKey)
        : tx.query('SELECT * FROM session_external_claims WHERE project_key=? AND session_id=?', projectKey, sessionId)
      ).map(externalClaim))
    },

    broadcast(senderSessionId, recipients, message) {
      requireId(senderSessionId, 'senderSessionId')
      const unique = [...new Set(recipients)]
      unique.forEach(recipient => requireId(recipient, 'recipientSessionId'))
      return protocol.withTransaction(tx => Object.fromEntries(unique.map(recipient => {
        const hash = Buffer.from(payloadHash({
          protocolVersion: message.protocolVersion ?? 1,
          targetSessionId: recipient,
          senderSessionId,
          kind: message.kind,
          headers: message.headers,
          body: message.body,
        })).toString('hex')
        const queued = tx.enqueue(recipient, { ...message, senderSessionId, idempotencyKey: `${senderSessionId}:${hash}:${recipient}` })
        return [recipient, queued.messageId]
      })))
    },

    notifyRecipients(subjectSessionId, message) {
      const result = protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, subjectSessionId)
        const recipients = topology.recipients(subjectSessionId, tx)
        const messages = recipients.map(recipient => tx.enqueue(recipient, {
          ...message,
          senderSessionId: message.senderSessionId === undefined ? subjectSessionId : message.senderSessionId,
        }))
        return { edge: null, recipients, messages }
      })
      notifyCommitted({
        ...result,
        subjectSessionIds: [subjectSessionId],
        changeMask: SESSION_CHANGE.delivery,
      })
      return result
    },

    attachAndNotify(fromSessionId, subjectSessionId, relationType, message) {
      const result = protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, fromSessionId, subjectSessionId)
        const edge = topology.attach(tx, fromSessionId, subjectSessionId, relationType)
        const recipients = topology.recipients(subjectSessionId, tx)
        const messages = recipients.map(recipient => tx.enqueue(recipient, {
          ...message,
          senderSessionId: message.senderSessionId === undefined ? subjectSessionId : message.senderSessionId,
        }))
        return { edge, recipients, messages }
      })
      notifyCommitted({
        ...result,
        subjectSessionIds: uniqueSessionIds(fromSessionId, subjectSessionId),
        changeMask: SESSION_CHANGE.topology | SESSION_CHANGE.delivery,
      })
      return result
    },

    createSession(input) {
      requireId(input.sessionId, 'sessionId')
      const status = input.status ?? 'created'
      requireStatus(status)
      const proposal = input.proposal ?? null
      const note = input.note ?? null
      const parentSessionId = input.parentSessionId ?? null
      if (parentSessionId !== null) requireId(parentSessionId, 'parentSessionId')
      const created = protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, input.sessionId, input.runtime?.nativeSessionId)
        if (parentSessionId) assertExternalAddressUnclaimed(tx, parentSessionId)
        if (readStateInTransaction(tx, input.sessionId)) {
          throw new Error(`session application state already exists: ${input.sessionId}`)
        }
        tx.initialize(input.sessionId)
        if (parentSessionId) tx.initialize(parentSessionId)
        let edge: TopologyEdge | null = null
        if (parentSessionId) edge = topology.attach(tx, parentSessionId, input.sessionId, PARENT_RELATION)
        const updatedAtMs = input.updatedAtMs ?? now()
        tx.exec(
          'INSERT INTO session_application_state(session_id,status,proposal,note,parent_session_id,updated_at_ms) VALUES(?,?,?,?,?,?)',
          input.sessionId,
          status,
          proposal,
          note,
          parentSessionId,
          updatedAtMs,
        )
        const id = input.eventId ?? eventId()
        const change: SessionStateChange = {
          sessionId: input.sessionId,
          status,
          proposal,
          note,
          previousProposal: null,
          previousNote: null,
          parentSessionId,
          previousStatus: null,
          previousParentSessionId: null,
          reason: 'create',
        }
        const event = events.append(tx, {
          eventId: id,
          type: STATE_EVENT,
          schemaVersion: 1,
          subjectSessionId: input.sessionId,
          payload: encodeEventJson(change),
          occurredAtMs: updatedAtMs,
        })
        const recipients: string[] = []
        const messages: Message[] = []
        let runtime: RuntimeBinding | null = null
        if (input.runtime) {
          runtime = runtimeBindings.bind(tx, input.sessionId, input.runtime)
        }
        return {
          state: { sessionId: input.sessionId, status, proposal, note, parentSessionId, updatedAtMs },
          event,
          edge,
          recipients,
          messages,
          runtime,
        }
      })
      const result: CommittedSessionChange = {
        state: created.state,
        event: created.event,
        edge: created.edge,
        recipients: created.recipients,
        messages: created.messages,
        subjectSessionIds: uniqueSessionIds(input.sessionId, parentSessionId),
        changeMask: SESSION_CHANGE.state | (created.edge ? SESSION_CHANGE.topology : 0),
      }
      notifyCommitted(result)
      return created.state
    },

    transitionSession(sessionId, input) {
      requireId(sessionId, 'sessionId')
      const nextStatus = input.status
      if (nextStatus !== undefined) requireStatus(nextStatus)
      if (input.parentSessionId !== undefined && input.parentSessionId !== null) requireId(input.parentSessionId, 'parentSessionId')
      if (input.parentSessionId === sessionId) throw new TypeError('a session cannot be its own parent')
      const result = protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, sessionId, input.parentSessionId ?? undefined)
        const current = readStateInTransaction(tx, sessionId)
        if (!current) {
          throw new Error(`session application state is missing: ${sessionId}`)
        }
        const status = nextStatus ?? current.status
        const proposal = input.proposal === undefined ? current.proposal : input.proposal
        const note = input.note === undefined ? current.note : input.note
        const parentSessionId = input.parentSessionId === undefined ? current.parentSessionId : input.parentSessionId
        if (input.parentSessionId) tx.initialize(input.parentSessionId)
        let edge: TopologyEdge | null = null
        if (parentSessionId !== current.parentSessionId) {
          if (parentSessionId && current.parentSessionId) edge = topology.reparent(tx, sessionId, parentSessionId, PARENT_RELATION)
          else if (parentSessionId) edge = topology.attach(tx, parentSessionId, sessionId, PARENT_RELATION)
          else if (current.parentSessionId) {
            const former = topology.parents(sessionId, PARENT_RELATION, tx)[0]
            if (former) topology.detach(tx, former.edgeId)
          }
        }
        const updatedAtMs = now()
        tx.exec(
          'UPDATE session_application_state SET status=?, proposal=?, note=?, parent_session_id=?, updated_at_ms=? WHERE session_id=?',
          status,
          proposal,
          note,
          parentSessionId,
          updatedAtMs,
          sessionId,
        )
        const id = eventId()
        const change: SessionStateChange = {
          sessionId,
          status,
          proposal,
          note,
          previousProposal: current.proposal,
          previousNote: current.note,
          parentSessionId,
          previousStatus: current.status,
          previousParentSessionId: current.parentSessionId,
          reason: input.reason ?? null,
        }
        const event = events.append(tx, {
          eventId: id,
          type: STATE_EVENT,
          schemaVersion: 1,
          subjectSessionId: sessionId,
          payload: encodeEventJson(change),
          occurredAtMs: updatedAtMs,
        })
        const explicitRecipients = input.recipientSessionIds !== undefined
        const recipients = explicitRecipients
          ? [...new Set(input.recipientSessionIds!.map(recipient => {
            requireId(recipient, 'recipientSessionId')
            return recipient
          }))]
          : topology.recipients(sessionId, tx)
        // Explicit callers own the legacy state-message queue shape. Normal lifecycle transitions publish
        // watcher recipients as a post-commit wake list; the CLI adopter translates their cursor events into
        // conversation messages, so no raw duplicate queue row is created here.
        const messages = explicitRecipients ? recipients.map(recipient => tx.enqueue(recipient, messageForEvent(change, id))) : []
        return {
          state: { sessionId, status, proposal, note, parentSessionId, updatedAtMs },
          event,
          edge,
          recipients,
          messages,
          subjectSessionIds: uniqueSessionIds(sessionId, current.parentSessionId, parentSessionId),
          changeMask: SESSION_CHANGE.state | (parentSessionId === current.parentSessionId ? 0 : SESSION_CHANGE.topology),
        }
      })
      notifyCommitted(result)
      return result
    },

    enqueueMessage(sessionId, message) {
      requireId(sessionId, 'sessionId')
      initialize(sessionId)
      return protocol.withTransaction(tx => tx.enqueue(sessionId, message))
    },

    enqueueConversationMessage(sessionId, message, conversation) {
      requireId(sessionId, 'sessionId')
      if (!conversation || typeof conversation.text !== 'string' || conversation.text.length === 0) {
        throw new TypeError('conversation message requires non-empty text')
      }
      if (conversation.from !== null && typeof conversation.from !== 'string') {
        throw new TypeError('conversation message from must be a session id or null')
      }
      return protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, sessionId)
        tx.initialize(sessionId)
        const queued = tx.enqueue(sessionId, message)
        const recorded = events.hasMessageEvent(tx, sessionId, queued.messageId)
        if (!recorded) {
          events.append(tx, {
            eventId: eventId(),
            type: MESSAGE_EVENT,
            schemaVersion: 1,
            subjectSessionId: sessionId,
            payload: encodeEventJson({
              messageId: queued.messageId,
              text: conversation.text,
              from: conversation.from,
              ...(conversation.replyVia ? { replyVia: conversation.replyVia } : {}),
            }),
            occurredAtMs: queued.enqueuedAtMs,
          })
        }
        return queued
      })
    },

    attachWatcher(watcherSessionId, subjectSessionId, channel = WATCH_RELATION) {
      requireId(watcherSessionId, 'watcherSessionId')
      requireId(subjectSessionId, 'subjectSessionId')
      return protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, watcherSessionId, subjectSessionId)
        tx.initialize(watcherSessionId)
        tx.initialize(subjectSessionId)
        const edge = topology.subscribe(tx, watcherSessionId, subjectSessionId, channel)
        tx.exec(
          `INSERT INTO session_follow_cursors (watcher_session_id, subject_session_id, event_seq)
           SELECT ?, ?, COALESCE(MAX(event_seq), 0)
             FROM session_events
            WHERE subject_session_id=?
           ON CONFLICT(watcher_session_id, subject_session_id) DO UPDATE
             SET event_seq=MAX(session_follow_cursors.event_seq, excluded.event_seq)`,
          watcherSessionId,
          subjectSessionId,
          subjectSessionId,
        )
        return edge
      })
    },

    detachWatcher(watcherSessionId, subjectSessionId, channel = WATCH_RELATION) {
      requireId(watcherSessionId, 'watcherSessionId')
      requireId(subjectSessionId, 'subjectSessionId')
      return protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, watcherSessionId, subjectSessionId)
        return topology.unsubscribe(tx, watcherSessionId, subjectSessionId, channel)
      })
    },

    listWatchers(watcherSessionId, channel = WATCH_RELATION) {
      requireId(watcherSessionId, 'watcherSessionId')
      return topology.subscriptions(watcherSessionId).filter(edge => edge.relationType === channel)
    },

    bindRuntime(sessionId, identity, expectedGeneration) {
      requireId(sessionId, 'sessionId')
      const binding = protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, sessionId, identity?.nativeSessionId)
        tx.initialize(sessionId)
        return runtimeBindings.bind(tx, sessionId, identity, { expectedGeneration })
      })
      options.onRuntimeBound?.(sessionId)
      return binding
    },

    resolveRuntime(sessionId, namespace) {
      requireId(sessionId, 'sessionId')
      return runtimeBindings.resolve(namespace, sessionId)
    },

    dequeueForRuntime(sessionId, namespace, expectedGeneration, expectedMessageId) {
      requireId(sessionId, 'sessionId')
      return protocol.withTransaction(tx => {
        const binding = runtimeBindings.resolve(namespace, sessionId, tx)
        assertExternalAddressUnclaimed(tx, sessionId, binding?.nativeSessionId)
        if (!binding || binding.status !== 'bound') throw new Error(`runtime binding is not active for ${sessionId}`)
        if (expectedGeneration !== undefined && binding.bindingGeneration !== expectedGeneration) {
          throw new Error(`runtime binding generation is stale for ${sessionId}`)
        }
        try { return tx.dequeue(sessionId, expectedMessageId) }
        catch (error) {
          if (error instanceof ProtocolError && error.code === 'PROTOCOL_CURSOR_INVALID') return null
          throw error
        }
      })
    },

    readPendingMessages(sessionId) {
      requireId(sessionId, 'sessionId')
      return protocol.listPending(sessionId)
    },

    readMessageHistory(sessionId) {
      requireId(sessionId, 'sessionId')
      return protocol.readMessages(sessionId)
    },

    readMessageKeys(sessionId, messageIds) {
      requireId(sessionId, 'sessionId')
      const ids = [...new Set(messageIds)]
      const keys = new Map<string, string | null>()
      if (ids.length === 0) return keys
      protocol.withTransaction(tx => {
        // chunked so a wide window never meets SQLite's bound-parameter ceiling
        for (let start = 0; start < ids.length; start += 500) {
          const chunk = ids.slice(start, start + 500)
          const rows = tx.query(
            `SELECT message_id, idempotency_key FROM protocol_messages
              WHERE target_session_id=? AND message_id IN (${chunk.map(() => '?').join(',')})`,
            sessionId, ...chunk,
          )
          for (const row of rows) keys.set(String(row.message_id), row.idempotency_key === null ? null : String(row.idempotency_key))
        }
      })
      return keys
    },

    dequeuePendingMessage(sessionId, expectedMessageId) {
      requireId(sessionId, 'sessionId')
      requireId(expectedMessageId, 'expectedMessageId')
      const head = protocol.listPending(sessionId)[0]
      if (!head || head.messageId !== expectedMessageId) return null
      return protocol.dequeue(sessionId)
    },

    readState(sessionId) {
      requireId(sessionId, 'sessionId')
      const state = protocol.withTransaction(tx => readStateInTransaction(tx, sessionId))
      return state
    },

    readAddress(sessionId) {
      requireId(sessionId, 'sessionId')
      // A pure read of the protocol's own address row. The adopter needs to tell "registered but recordless"
      // (a self-launched harness) from "unknown" without creating the address as a side effect, which is what
      // every enqueue path would do.
      const row = protocol.withTransaction(tx => tx.query(
        'SELECT session_id, created_at_ms, retired_at_ms FROM protocol_sessions WHERE session_id = ?', sessionId,
      ))[0]
      if (!row) return null
      return {
        sessionId: String(row.session_id),
        createdAtMs: Number(row.created_at_ms),
        retiredAtMs: row.retired_at_ms === null || row.retired_at_ms === undefined ? null : Number(row.retired_at_ms),
      }
    },

    readEvents(sessionId, afterSequence) {
      requireId(sessionId, 'sessionId')
      return events.read(sessionId, afterSequence === undefined ? undefined : { afterSequence })
    },

    readChangedSessionIdsSince(watermark) {
      if (!Number.isSafeInteger(watermark) || watermark < 0) {
        throw new TypeError('session event watermark must be a non-negative safe integer')
      }
      return protocol.withTransaction(tx => {
        // session_events is append-only and uses SQLite's implicit rowid, giving separate processes a
        // database-local commit cursor without adding a migration. The event table never deletes or updates
        // rows, so a caller can safely retain the returned watermark between watcher notifications.
        const rows = tx.query(
          `SELECT rowid, subject_session_id FROM session_events
             WHERE rowid>? AND event_type=? ORDER BY rowid`,
          watermark,
          STATE_EVENT,
        ) as Array<{ rowid: number | bigint; subject_session_id: string }>
        const latest = tx.query('SELECT COALESCE(MAX(rowid), 0) AS watermark FROM session_events')[0]?.watermark ?? 0
        const nextWatermark = Number(latest)
        if (!Number.isSafeInteger(nextWatermark) || nextWatermark < watermark) {
          throw new Error('session event watermark is outside the safe integer range')
        }
        const subjectSessionIds = [...new Set(rows.map(row => String(row.subject_session_id)))]
        const recipientSessionIds = [...new Set(subjectSessionIds.flatMap(subject => topology.recipients(subject, tx)))]
        return {
          watermark: nextWatermark,
          dataVersion: Number(tx.query('PRAGMA data_version')[0]?.data_version),
          subjectSessionIds,
          recipientSessionIds,
        }
      })
    },

    readWatchEvents(watcherSessionIds, limit = 1000) {
      const ids = [...new Set(watcherSessionIds)]
      ids.forEach(id => requireId(id, 'watcherSessionId'))
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('watch event limit must be a positive safe integer')
      if (ids.length === 0) return []
      const placeholders = ids.map(() => '?').join(',')
      return protocol.withTransaction(tx => {
        const rows = tx.query(
          `SELECT edge.from_session_id AS watcher_session_id, edge.to_session_id AS subject_session_id,
                  e.event_seq, e.event_id, e.event_type, e.schema_version, e.ignorable, e.payload, e.occurred_at_ms,
                  GROUP_CONCAT(edge.relation_type) AS sources
             FROM topology_edges AS edge
             JOIN session_events AS e ON e.subject_session_id=edge.to_session_id
             LEFT JOIN session_follow_cursors AS cursor
               ON cursor.watcher_session_id=edge.from_session_id AND cursor.subject_session_id=edge.to_session_id
            WHERE edge.from_session_id IN (${placeholders})
              AND edge.removed_at_ms IS NULL
              AND edge.relation_type IN (?, ?, ?, ?)
              AND e.event_type=?
              AND e.event_seq>COALESCE(cursor.event_seq, 0)
            GROUP BY edge.from_session_id, edge.to_session_id, e.event_seq
            ORDER BY e.event_seq, edge.from_session_id
            LIMIT ?`,
          ...ids, PARENT_RELATION, WATCH_RELATION, PARENT_WATCH_RELATION, MANUAL_WATCH_RELATION, STATE_EVENT, limit,
        ) as Array<Record<string, unknown>>
        return rows.map(row => ({
          watcherSessionId: String(row.watcher_session_id),
          subjectSessionId: String(row.subject_session_id),
          event: Object.freeze({
            eventId: String(row.event_id),
            eventSeq: Number(row.event_seq),
            type: String(row.event_type),
            schemaVersion: Number(row.schema_version),
            subjectSessionId: String(row.subject_session_id),
            payload: new Uint8Array(row.payload as Uint8Array),
            occurredAtMs: Number(row.occurred_at_ms),
            ignorable: Number(row.ignorable) !== 0,
          }),
          sources: String(row.sources ?? '').split(',').filter(Boolean),
        }))
      })
    },

    readFollowCursor(watcherSessionId, subjectSessionId) {
      requireId(watcherSessionId, 'watcherSessionId')
      requireId(subjectSessionId, 'subjectSessionId')
      const rows = protocol.withTransaction(tx => tx.query(
        'SELECT event_seq FROM session_follow_cursors WHERE watcher_session_id=? AND subject_session_id=?',
        watcherSessionId,
        subjectSessionId,
      ))
      const value = rows[0]?.event_seq
      return value === undefined ? null : Number(value)
    },

    advanceFollowCursor(watcherSessionId, subjectSessionId, eventSequence) {
      requireId(watcherSessionId, 'watcherSessionId')
      requireId(subjectSessionId, 'subjectSessionId')
      if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) throw new TypeError('eventSequence must be a non-negative safe integer')
      protocol.withTransaction(tx => {
        assertExternalAddressUnclaimed(tx, watcherSessionId, subjectSessionId)
        const prior = tx.query(
          'SELECT event_seq FROM session_follow_cursors WHERE watcher_session_id=? AND subject_session_id=?',
          watcherSessionId,
          subjectSessionId,
        )[0]?.event_seq
        if (prior !== undefined && Number(prior) >= eventSequence) return
        tx.exec(
          `INSERT INTO session_follow_cursors (watcher_session_id, subject_session_id, event_seq)
           VALUES (?, ?, ?)
           ON CONFLICT(watcher_session_id, subject_session_id) DO UPDATE SET event_seq=excluded.event_seq`,
          watcherSessionId,
          subjectSessionId,
          eventSequence,
        )
      })
    },

    replayState(sessionId) {
      requireId(sessionId, 'sessionId')
      initialize(sessionId)
      return events.replay<SessionState | null>(sessionId, {
        initialState: null,
        reducers: {
          // A conversation message is a public fact beside the state fold, not a state transition.
          [MESSAGE_EVENT]: state => state,
          [STATE_EVENT]: (_state, event) => {
            const decoded = JSON.parse(new TextDecoder().decode(event.payload)) as SessionStateChange
            return {
              sessionId: decoded.sessionId,
              status: decoded.status,
              proposal: decoded.proposal ?? null,
              note: decoded.note ?? null,
              parentSessionId: decoded.parentSessionId,
              updatedAtMs: event.occurredAtMs,
            }
          },
        },
      })
    },

    close() {
      compositions.delete(options.databasePath)
      closeProtocol(options.databasePath, protocol)
    },
  }
  compositions.set(options.databasePath, app)
  return app
}

const protocols = new Map<string, SessionProtocol>()

function openProtocolOnce(databasePath: string, now?: () => number): SessionProtocol {
  const existing = protocols.get(databasePath)
  if (existing) return existing
  const protocol = openProtocol(databasePath, now ? { now } : undefined)
  protocols.set(databasePath, protocol)
  return protocol
}

function closeProtocol(databasePath: string, protocol: SessionProtocol): void {
  if (protocols.get(databasePath) !== protocol) return
  protocols.delete(databasePath)
  protocol.close()
}
