---
title: session application composition
status: active
hue: 280
desc: The cached one-database composition that joins protocol, topology, events, and runtime bindings.
code:
  - packages/session-application/src/production.ts
related:
  - .spec/spexcode/session-runtime/application-service/spec.md
  - .spec/spexcode/session-runtime/runtime-bindings/spec.md
---
# session application composition

`openProjectSessionApplication` requires the absolute database path resolved by the package's own storage-path precedence ([[storage-path]]) and
a locality precondition before it opens protocol. It caches one composition per path, initializes each component once,
and closes the shared protocol handle only when that composition closes. State/topology/event/message writes share one
synchronous transaction; post-commit callbacks are wake hints only. A lifecycle transition may accept a caller-resolved
recipient set when an adopter owns a richer delivery policy; the composition validates and enqueues that set without
interpreting relation names. Runtime identities and generation expectations are always caller supplied. Conversation sends use an explicit `enqueueConversationMessage` action: it records the
model-facing message fact in `session-events` in the same transaction as the protocol queue write. Canonical event reads go through the application's `readEvents` boundary; consumers do not import the old file timeline reader. Durable follow cursors are also owned by the application and advance monotonically in the same SQLite store; a caller without a canonical session keeps a process-local cursor. Managed watch delivery belongs to the backend that owns the watcher's control channel: it polls the global event store by durable watch edge and cursor, then enqueues and hands over after the read transaction commits. Generic protocol
messages remain opaque and do not become conversation history. The composition never reads JSON records or exposes
an opt-in compatibility switch.
Duplicate checks use the event store's scoped message lookup rather than replaying the session history. In the same
way, `readMessageKeys` answers the idempotency key of named messages addressed to one session by message id, so a
reader that must tell which messages a policy minted never replays that session's queue; the keys stay opaque here
and are interpreted only by the adopter that minted them. Generic protocol
messages remain opaque and do not become conversation history. The composition never reads JSON records or exposes an
opt-in compatibility switch. State replay folds `session.state.changed.v1` and passes over the conversation message
fact recorded beside it; migrated legacy history carries its own ignorable types and is skipped by the same fold.

Lifecycle transitions record the subject event and return the affected watcher ids as a post-commit wake list. The post-commit callback also carries a deduplicated `subjectSessionIds` list and a bitwise `changeMask`: state transitions name the changed session (plus old/new parents when topology moves), while topology and delivery operations name both relation endpoints where applicable. Existing recipient wakes remain unchanged; these fields are advisory projection inputs, never a second source of truth. The owner-side adopter resolves watcher recipients by their durable channel: a `watch:parent` relation suppresses the
routine `active`/working transition, while `watch:manual` opts into the complete feed. A migrated `watch` channel
is normalized by the importer. When both channels point at one watcher, the union emits one queue item. The post-commit adopter wake reads the affected cursors, commits, enqueues and attempts transport, then advances the cursor in a separate short transaction; the patrol is recovery only. Event ids are idempotency keys, giving at-least-once delivery without duplicate prompts after a crash. A backend restart resumes from the durable cursor. Creation still publishes its initial
snapshot through the ordinary relation transaction; this policy applies to later transitions.

The application also exposes a read-only event watermark: `readChangedSessionIdsSince` uses the append-only event table's database-local rowid to return distinct subjects added after a caller's cursor, their current watcher recipients, and advances that cursor in the same `BEGIN IMMEDIATE` barrier transaction. Recipient resolution shares that transaction, so an external database watcher can add only affected delivery debt without enumerating the durable roster. It returns the connection-local SQLite `data_version` observed under the same barrier, so an external database watcher can distinguish an empty duplicate/early filesystem notification from a committed database move with no state subject. This is an advisory bridge; callers must still fall back to a full projection when the event stream cannot account for a change.

The typed [[external-session-adoption]] command initializes the protocol address and records the project
claim in the same transaction. The claim table does not publish lifecycle events or runtime bindings.
The same transaction boundary fences control operations on a claimed address, including addresses whose claim
was withdrawn. Watch relations and durable follow cursors check both endpoints. A runtime binding checks its
protocol address and native identity in every namespace. Failed creation, state, watch, and binding checks
leave the prospective address, relationship, and cursor unchanged. Explicit protocol mailbox operations
remain independent.
