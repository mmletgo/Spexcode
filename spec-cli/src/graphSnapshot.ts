import { loadSpecs, requireGitWorkspace } from '@spexcode/spec-core'
import { resolveLayout } from '@spexcode/spec-core'
import { listSessions } from './sessions.js'
import { pruneHistoryCaches, repoRoot } from '@spexcode/spec-core'
import { residentForgeRevision, residentForgeState } from '@spexcode/spec-forge/resident'
import { resolveForgeHost } from '@spexcode/spec-forge/drivers'
import { boardThreads } from './issues.js'
import { localIssueRevision } from './localIssues.js'
import { mergeSessionRows } from './sessionProjection.js'
import { recentLiveSnapshot } from './session-liveness.js'
import { buildBoard as assembleBoard, spliceSessions as spliceBoardSessions, type BoardSnapshot } from '@spexcode/spec-core'

type GraphBoard = Awaited<ReturnType<typeof assembleBoard>>
type SessionProjectionRow = GraphBoard['sessions'][number]

export type SessionSpliceRequest =
  | { scope: 'full' }
  | { scope: 'partial'; affectedSessionIds: readonly string[] }

// The application adapter is the sole reader of runtime/forge state. graph.ts only receives this result.
export async function boardSnapshot(): Promise<BoardSnapshot> {
  const root = repoRoot()
  requireGitWorkspace(root)
  const [specs, sessions] = await Promise.all([loadSpecs(), listSessions()])
  // Session worktrees are the live-root census for immutable history caches. Reconcile before the snapshot
  // returns so closing a session releases its full index immediately rather than waiting for an LRU slot.
  const worktreeSessions = sessions.filter((session) => session.path)
  pruneHistoryCaches([root, ...worktreeSessions.map((session) => session.path)])
  const layout = await resolveLayout({ activeSessionIds: worktreeSessions.map((session) => session.id) })
  const nodeIds = [...new Set([
    ...specs.map((node) => node.id),
    ...layout.worktrees.flatMap((worktree) => (worktree.ops || []).map((op: any) => op.nodeId)),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0))]
  // Sample every issue-store revision BEFORE reading the stores. Sampling after would let a write that
  // landed between the read and the sample be certified as contained in this snapshot, so a reader waiting
  // for that write would be answered with a generation that predates it. Sampling before can only
  // under-claim — the cost is one extra rebuild, never a stale answer presented as current.
  const issueSource = { forge: residentForgeRevision(), local: localIssueRevision() }
  const { issues, stamp: issuesStamp } = boardThreads(
    { host: resolveForgeHost(), state: residentForgeState() },
    nodeIds,
  )
  return {
    root, specs, layout, sessions, issues, issuesStamp, issueSource,
  }
}

export const buildBoard = async () => assembleBoard(await boardSnapshot())

// A partial read can safely replace only rows named by a committed session change. The graph-core splice still
// owns archive overlay semantics; after it runs, rows outside the affected set are put back by identity so a
// lifecycle update does not manufacture a new object for every historical session. `null` means the partial
// evidence was not sufficient to prove a complete replacement (for example, an unseen id with no row); callers
// must then retry with the authoritative full roster.
export async function spliceSessionRows(
  prev: GraphBoard,
  sessions: readonly SessionProjectionRow[],
  affectedSessionIds: readonly string[],
): Promise<GraphBoard | null> {
  const affected = new Set(affectedSessionIds)
  const previousById = new Map(prev.sessions.map((row) => [row.id, row]))
  const combined = mergeSessionRows(prev.sessions, sessions, affectedSessionIds)
  if (!combined) return null
  const projected = await spliceBoardSessions(prev, combined)
  const sessionsWithStableRows = projected.sessions.map((row) => affected.has(row.id) ? row : previousById.get(row.id) ?? row)
  return { ...projected, sessions: sessionsWithStableRows }
}

export const spliceSessions = async (
  prev: GraphBoard,
  request: SessionSpliceRequest = { scope: 'full' },
): Promise<GraphBoard> => {
  if (request.scope === 'full') return spliceBoardSessions(prev, await listSessions())
  // The warm graph poll already owns the process-wide tmux/rendezvous census. Reuse it while it is fresh so a
  // lifecycle-only hook does not launch a second identical census; listSessions still falls back to a fresh
  // probe when the worker has no recent evidence or the warm probe expired.
  const snap = recentLiveSnapshot()
  const partial = await spliceSessionRows(prev, await listSessions(false, request.affectedSessionIds, snap ?? undefined), request.affectedSessionIds)
  if (partial) return partial
  // Unknown ids and absent rows are an explicit full-refresh fallback. A partial result is never guessed into
  // a deletion, because archive/hazard state must remain visible when the caller's change set was incomplete.
  return spliceBoardSessions(prev, await listSessions())
}
