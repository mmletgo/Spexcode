---
title: codex-runtime
status: active
hue: 280
desc: The Codex adapter's project-shared app-server runtime — where the daemon lives and what it may not inherit, the three trust tiers a dispatched thread needs, backend-owned thread identity and the rollout warm-up, JSON-RPC delivery and interrupt, descendant-tree liveness, and the ownership proofs behind stop, archive, and quarantine.
code:
  - spec-cli/src/codex-harness.ts
related:
  - spec-cli/src/cli.ts
  - spec-cli/src/codex-runtime-generations.ts
  - spec-cli/src/sessions.ts
  - spec-cli/src/codex-headless.test.ts
  - spec-cli/src/harness.test.ts
---

# codex-runtime

Every worktree's Codex thread runs on ONE project-scoped `codex app-server`, and that single fact is the root of
everything here: the daemon belongs to the project rather than to whoever launched it, a dispatched thread must
clear three independent trust tiers before any hook fires, the backend rather than a capture hook owns each
thread's id, liveness must be read from something a shared daemon cannot fake, and every lifecycle mutation must
prove which threads it owns before it moves one. [[codex-headless]] shares this runtime;
[[shared-runtime-generation-rotation]] owns the generation ledger that routes traffic to one canonical root;
[[hook-shell-mirror]] owns the payload parse on the shell side. Everything below is measured against a real
codex (0.142.3–0.142.5) or read from codex-rs, never inferred.

## The app-server

**One per project, and every seam derives its address.** The socket is `<socketBase>/spexcode-cx-<hash>.sock`,
where `<hash>` digests the same project identity (`runtimeRoot()`) that launch, liveness, and delivery already
carry — so all three compute the identical socket with no coordination, which is what makes
one-app-server-per-project an invariant rather than a convention. `<socketBase>` is a 0700 per-uid subdirectory
of the platform tmpdir (`SPEXCODE_CODEX_SOCKET_DIR` replaces it), never the bare tmpdir: on a stock hardened
Linux (`fs.protected_regular=2`, root-owned sticky `/tmp`) codex refuses to bind there at all, so the server
never comes up and every codex-launcher session dies in launch retries while claude launchers work (github#30).
Per-uid, so a second user never lands in the first's 0700 dir, and the launch script re-creates the base at run
time in case a tmp cleaner removed it. The path must also stay inside `sun_path` (~104 bytes on macOS, 108 on
Linux): `runtimeRoot()` flattens the whole project path into one segment, so the naive
`<runtimeRoot>/codex-app-server.sock` overran the cap on a deep macOS project and the server never bound. The
short derivation is unconditional on every platform — a platform difference handled at the path seam, not a
product `if`. The `.pid`/`.log`/`.lock` sidecars carry no such cap and stay under the project runtime dir.

**It is the same install the session runs.** The app-server command derives from the in-effect launcher
`codexCmd`'s binary — its first shell token, dropping args like `--yolo` — because the daemon and the visible
`codex --remote … resume` TUI share that one socket, and a version split across it breaks the
`thread/start`→resume handoff. A bare `codex` off PATH resolves to a different install on a multi-install host,
which was the macOS-only version-skew failure. `SPEXCODE_CODEX_SERVER_CMD` overrides the derivation outright; a
`codexCmd` whose first token is a wrapper forwards `app-server` through it. The capability probe
(`<binary> --help`) obeys the same rule: the launch script exports `SPEXCODE_CODEX_CMD` so the probe interrogates
the codex the session will actually run rather than mis-deciding off a stray PATH entry.

The generation ledger is a live coordination file, but its parsed value is process-local state: readers stat the
ledger path and reuse the parsed object while its `mtimeNs` and byte size are unchanged, then re-read and parse
after an atomic replacement. No ledger content or cache survives the process, so generation routing remains
derived from the current runtime files.

**Started once, under a portable lock.** Check-and-start is serialized by an atomic `mkdir` mutex with a bounded
wait, not `flock` — absent on macOS, where it failed the whole bootstrap and left the pane at a shell. The lock
is held only across check-and-start, and a stale dir left by a dead launcher clears after a bounded wait so it
can never deadlock a launch. A mkdir lock has no inherited-fd hazard, so the long-lived daemon cannot pin it and
the spawn needs no fd-inheritance guard.

**It inherits neither a worktree nor an identity.** The daemon starts in the stable per-project runtime dir: one
that inherited a caller's transient worktree is bricked when that worktree is removed — its cwd reads
`(deleted)` and codex then fails every new thread's config load. For the same reason the spawn strips
`SPEXCODE_SESSION_ID` and every adapter's `sessionEnvVar` (the list is adapter-derived, so a new harness needs no
edit): a project-scoped daemon started by whichever session launched first would otherwise hand that one
session's id to every later thread's tool shell — a stale lie for everyone else, and for nobody at all once that
session closes and its record is swept (measured: daemons here ran for days under a long-gone session's id).
The id a thread actually needs, its own, codex injects per command, so stripping the inherited ones removes a
wrong answer without removing a right one.

**It is detached, and its receipt is proven, not assumed.** The daemon is a detached child in its own process
group and session rather than a `nohup` wrapper, which did not survive the real Codex Node launcher resetting
signal behaviour. The process adapter writes its private receipt only after proving PID/start and `PGID == PID`,
plus Linux `SID == PID`; Darwin deliberately asks no `ps sess` question. Every later consumer re-verifies through
that adapter, because a receipt alone never proves the live boundary. Killing the pane that happened to launch
the daemon therefore cannot HUP unrelated turns.

## Trust — three independent tiers

`--dangerously-bypass-hook-trust` satisfies exactly ONE of them. With the other two unmet a fresh-init codex
worker fires ZERO hooks, its runtime envelope never advances past launch, and its commits carry no `Session`
trailer — silently, which is why each tier is asserted rather than hoped for.

- **Layer BUILT.** codex-rs builds a project config layer only for a directory that itself contains `.codex/`.
  A linked worktree without one anchors no layer, so the rewritten root hooks below are never discovered. The
  adapter therefore writes a pure ANCHOR at the worktree's own `.codex/hooks.json` (`worktreeHookAnchor`) whose
  content the rewrite ignores — null for claude, whose shim already lives in the worktree, and for the main
  checkout, where `shimFile` wrote it. A fresh-init project is exactly what lacks it: the dogfood worked only by
  accident, its materialized `.codex/skills` incidentally supplying the anchor.
- **Layer ENABLED.** codex-rs disables an untrusted project's WHOLE layer before hook discovery runs and reads
  `bypass_hook_trust` only afterwards, per handler, so the flag can never enable a layer; and the
  dispatched-worker app-server does not auto-trust the way the interactive TUI and `codex exec` approval flows
  do — the confound that made a standalone `.codex` appear to work. So the adapter writes project trust
  (`[projects."<mainCheckout>"] trust_level = "trusted"`) unconditionally, the main-checkout key covering every
  worktree through codex's repo-root fallback. That write must be duplicate-safe: codex refuses a `config.toml`
  carrying a duplicate key, and auto-writes a bare `[projects."<proj>"]` the moment it trusts a folder. The
  writer therefore strips every prior definition of this project's trust — a sentinel block in any past format,
  a bare table, and its `[hooks.state]` entries — before appending, self-healing a config that already carries
  one rather than appending a second key that takes codex fully offline. The same file has a second writer the
  adapter cannot coordinate with — codex itself rewrites it whole when it trusts a folder or records a hook hash
  — so the adapter never persists bytes codex could not load: the body about to be written must parse as TOML,
  else the write is refused loudly and the file is left exactly as found (a line read mid-rewrite would otherwise
  be committed as truncation, and every dispatched thread then dies at config load). The write itself is an
  atomic replacement, so codex's own reader never sees the adapter's half-written file either.
- **Hooks REVIEWED.** Even trusted and enabled, an unhashed hook counts as new-or-changed, and codex forces the
  startup hook-review prompt on a PERSISTENT RESUME regardless of the bypass flag. The visible TUI attaches by
  `resume`, so an unhashed hook wedges the worker at an interactive menu. The adapter writes the per-hook
  `trusted_hash` blocks unconditionally. The version-brittleness the bypass was meant to avoid is inherent —
  codex offers no config to disable the review — so bypass is kept only as DEFENCE, riding both thread paths:
  the backend-owned `thread/start`, which applies it per thread from the request's `config` map and NOT from the
  daemon's own CLI flag (inert for a thread), and the visible resume TUI. `SPEXCODE_CODEX_BYPASS_HOOK_TRUST`
  forces it.

A trust writer returns the paths it asserted, so the materialization receipt and the init report derive from the
adapter's real side effect instead of a parallel capability claim.

## Hooks, and the events codex does not have

A linked worktree's PROJECT hooks come from the ROOT CHECKOUT: codex-rs rewrites any linked worktree's
hooks-config folder to `<repo_root>/<rel>/.codex` (`root_checkout_hooks_folder_for_dir`), so a thread whose cwd
is the worktree reads `<mainCheckout>/.codex/hooks.json` and NEVER the worktree's own. Shim and trust therefore
materialize at the main checkout as one per-project artifact, mirroring the per-project runtime tier, while
`dispatch.sh` resolves its `proj` from the thread cwd so the single shared shim still gates each worktree
correctly. Its five event keys are CamelCase. Everything else a worktree thread reads is per-cwd — `AGENTS.md`,
skills, project config are walked from the thread cwd — so one project-scoped server behaves like a per-worktree
launch in every respect except the hooks, which are genuinely per-project.

Codex has no `Notification` and no `StopFailure` in its canonical event set, so the claude-only idle and
failed-stop states are genuinely absent rather than unimplemented, and no substitute hook is fabricated. Turn
failure reaches the session layer instead through `observeTurnFailures`, below.

## The thread id is the backend's, and it is resume-ready or it fails loud

Codex mints its thread id internally and exposes no flag or env to pin a new one (`CODEX_THREAD_ID` is an output,
and resume takes an existing rollout id), so a governed record cannot be keyed by the harness id the way claude's
`--session-id` allows. The backend owns it instead: at launch it `thread/start { cwd: <this worktree> }`s on the
shared server, fires the launch prompt as the FIRST turn, and stages the returned `thread.id` for the lifecycle
owner to bind as `harness_session_id` — no capture hook, no rollout-file scan, no cwd guess. A hook resolves the
acting id from the payload thread id and aliases it onto that record ([[hook-shell-mirror]]).

Only a fired turn writes the thread's rollout file, and a freshly-spawned daemon persists it 2–4s LATE. A launch
that hands the id straight to `resume` dies with "no rollout found for thread id"; the retry loop then misreads
that fast failure as a daemon race, sprays fresh threads, and stores the last, non-resumable one — wedging every
future reopen. So `codex-launch` waits for the rollout to land (20s) BEFORE it stages identity or prints the id:
what it returns is always resume-ready, and a genuine miss fails loud, staging nothing. The 20s budget
deliberately exceeds launch.sh's fast-fail threshold, so a real failure reads as a true end rather than a
duplicate-prompt respray. The rollout scan walks day-directories newest-first but EXHAUSTIVELY, never capped at
the newest few: future-dated junk under `sessions/` sorts above every real day-dir, and a cap once let three such
directories mask every real rollout while the file sat on disk.

The server may register a thread before its first user message materializes it. In that window
`thread/turns/list` returns the exact refusals `is not materialized yet; thread/turns/list is unavailable before
first user message` or, after native cleanup, `thread not loaded: <id>`. Only those exact responses prove a
no-turn interrupt result, and during cold proof they prove an otherwise absent, descendant-free target is in the
startup-only shape — an existing loaded reference is removed by the exact native delete, an already-unloaded
target needs no mutation. Every other absent, unowned, timed-out, or unreadable state stays a refusal.

**A launch before its identity exists is recoverable, never empty.** Absence of `harness_session_id` while the
authoritative resolved `launch` payload remains means resume replays that payload through the adapter; only the
adapter's proof that identity AND the first durable turn both landed may bind the id and consume the payload. A
missing payload leaves the record unchanged and refuses loudly.

### Native thread succession

The SpexCode session id is the stable product address; the Codex thread id is a replaceable native
execution address. Codex TUI rewind/backtrack may fork the current conversation and switch the TUI to a
new thread whose `forkedFromId` is the previously bound thread. The shared-runtime adapter opens one
observer for the app-server generation and reports exact `{ previousThreadId, nextThreadId, runtimeKey }`
successor pairs. The session layer maps the predecessor to its unique SpexCode record, then rebinds the same
record, runtime binding, and generation ledger entry under the record lock, preserving the generation while
replacing only the native target. A notification with no exact parent,
an already changed record, or a failed rebind is ignored or reported as a refusal; it must never guess from
cwd, title, rollout order, or another loaded thread. All later transcript, delivery, liveness, resume, and
cold-operation reads resolve the newly bound child through the unchanged SpexCode session id.

## Liveness is the pane's process tree

A session is live when its tmux window is up AND a codex process lives among the pane pid's DESCENDANTS —
matched by basename `codex*` or `node*`, since the CLI runs as node before and alongside the vendored binary.
Failed is the complement: retries exhausted, everything under the pane exited, a bare idle shell with no codex or
node below it. A probe tmux or ps could not answer is not-live rather than dead, and the `starting` boot grace
stays in the caller, so a pane still bootstrapping the daemon reads `starting` for its legitimate startup window.

Two nearer signals are rejected, each field-confirmed wrong in a different direction. The pane's FOREGROUND
command is `bash` (the launch wrapper) for a healthy TUI's entire life — the codex processes sit below it — so a
foreground probe read every live codex as offline, the strictly worse direction: the board showed working
sessions as dead and a supervisor could reopen or kill them. And the app-server socket is per-project and
SHARED, so it stays bound even after this session's own `resume` TUI failed and its pane fell back to a shell —
socket presence read a dead launch as online.

## Delivery, interrupt, and the failure observer

Codex has no claude-style rendezvous control socket, so the adapter declares `ownsRendezvous: false` and reaches its session
through that same project app-server: it IS the delivery channel, just not the liveness gate. Its endpoint is a WebSocket at `/rpc` —
the upgrade the remote TUI performs — and delivery speaks JSON-RPC over it directly, never through
`codex app-server proxy`, a byte relay that performs no HTTP upgrade and is rejected. The handshake
`initialize → initialized → thread/loaded/list` proves the OWNED thread is resident. If the session's exact
generation binding has already been positively reclaimed, delivery first repairs that route by re-pinning the
same native thread onto a newly proven current generation; it never leaves an accepted prompt stranded merely
because a host restart retired the old daemon.

Delivery must not read the native conversation to choose between starting and steering: that transcript is
unbounded and can push a durable send past its confirmation budget. The observer's `turn/started`/`turn/completed`
notifications are the active-turn-id cache, and a cached id is the ONLY basis for `turn/steer`, which requires it
as `expectedTurnId`; a turn that ends inside that window fails the precondition and is retried as `turn/start`.
Steering injects INTO the live turn, so the model reacts mid-turn rather than after it. With no cached id,
delivery opens a new turn with `turn/start` and reports a native rejection promptly, leaving the durable message
pending rather than replaying history or hiding an unobserved active turn. There is no tmux typing fallback:
typed keys can truncate and prove only that tmux accepted input, never that codex accepted a turn. Routing is
solely the owned thread id, so several backends sharing one socket never cross-send; the loaded-thread list is a
fallback only for a pre-existing session whose id was never stored. A headless thread that is intact on disk but
has been evicted from the shared server is reloaded with `thread/resume` (without replaying history) and the same
`turn/start` is retried once, since headless has no TUI resume step to perform that load.

Hard interrupt follows the same exact-native rule: read the newest `inProgress` turn through the owned
generation, send `turn/interrupt {threadId, turnId}`, then re-read until it settles. An idle thread is already
interrupted, while a generation change, an unreadable turn, or a still-active turn refuses loudly.

The failure observer holds one independent `thread/resume` connection, atomically subscribing to the owned
thread's outcomes. A `turn/completed` with status `failed` carries the native message and `completedAt`;
`completed` and `interrupted` are controls and write no lifecycle. A backend replacement joining a thread already
in `systemError` takes the latest turn id and completion time from that same response's `initialTurnsPage`, and a
concurrent `turn/started` cancels the historical projection so an old failure cannot overwrite a new turn's
active lifecycle. Subscription is allowed up to 30 seconds because the measured daemon can take 15–17 under
load; a shorter timeout turns a slow but valid response into a retry storm and a resource leak. While subscribed
it discards unrelated progress notifications at the WebSocket frame boundary, before UTF-8 decoding or JSON
parsing.

## Resume is a marker, not an argument

Claude appends `--resume <id>` to its own command. Codex has no bare command to append to: its `launchCmd` is a
bootstrap script that feeds its tail to `spex internal codex-launch`, which mints a NEW thread and fires that
tail as the first prompt. So the codex resume tail is a `--resume <thread-id>` MARKER the script branches on —
skip `codex-launch` entirely, no new thread and no prompt turn, then `codex … resume "$tid"` performs codex's own
resume against the owned id's on-disk rollout, the SAME conversation. The discriminator is sound because a new
launch's tail is always ONE single-quoted prompt argument and never the literal `--resume`, so a resume can never
be mistaken for a prompt and mint a thread whose first message is the marker text.

The remote TUI also receives `--cd <worktree-cwd>` explicitly, because under `tui.resume_cwd = "current"` codex
refuses a remote workspace without one; the generated command quotes the pane's `$PWD` as a single argument so a
worktree path containing spaces survives. Explicit `--remote` is the default because it deterministically binds
both the pane and backend control to the project app-server.

## Ownership proofs, because the runtime is shared

The adapter declares its PID/isolation artifacts and a live control-plane probe. The probe reports the loaded
thread set, whether each reference is active — active is a state of ONE loaded reference, never of another — and
the native parent each resident reference's rollout header names, read off disk rather than through a thread the
census would otherwise leave alone, so the resource projection can attribute a subagent that has no record of its
own to the session governing its ancestor ([[host-resource-budget]]). A
record-only or queued session cannot invent a reference; a loaded thread with no matching record stays in the set
as unowned. Ownership joins only governed records whose adapter declares this same shared-runtime descriptor, so
a coincidentally equal id from another adapter, or a non-governed record, is not an owner. An unhealthy or
unknown probe returns an unknown refcount rather than a record-derived fallback, and mutation treats that
uncertainty as its own fail-closed blocker.

**Projection and mutation are separate capabilities, and cost decides the boundary.** Resource reporting may read
every loaded reference to describe turn presence. Lifecycle mutation proves one target subtree, so its cost tracks
that subtree: never how much history any one thread holds, and never how many threads the host has ever created.
Both grow without bound on a long-lived host. A per-thread transcript read makes a long-lived session unmutatable
against any fixed budget, and raising the budget only moves the threshold. A whole-collection census makes every
close slower than the one before it, because each close adds a row to the archived collection the next close
reads. So the normal record-backed mutation reads the paginated loaded-ID set, both exact target descendant
collections, and scoped rows only: the target's own rows through the exact `cwd` its governed record binds, the
rows of any descendant whose `cwd` differs through that `cwd`, and each subtree member's direct children through
`parentThreadId` — plus, off the native server entirely, the rollout header of each resident thread the listing
did not place in the subtree (below). Every `thread/list` row already carries its live turn state, its direct
parent, and its `cwd`, so presence and ownership for every listed member are answered by reads the proof performs
anyway. Turn IDENTITY is the
separate question — only interrupt must name the turn it interrupts, so only interrupt pays a transcript read,
against a target that is active by definition. Presence the daemon did not report, including two native sources
contradicting each other, never becomes an `active` verdict.
The periodic report keeps a short bounded probe budget while a mutation's target census gets its own longer one,
so a busy daemon cannot turn a safe proof into a false refusal; a transport-local census refusal retries a small
bounded number of times under the same generation fence, while a semantic ownership refusal returns at once.

**A filter is a request, not a proof.** The native server silently ignores a filter key it does not know and
answers with the whole collection. Every scoped read therefore checks each returned row against the predicate it
asked for — the row's `cwd` equals the requested `cwd`, the row's `parentThreadId` equals the requested parent —
and one violating row refuses the mutation and names the filter. A record that binds no worktree `cwd` refuses
too, rather than widening its own scope. Quarantine (below) still uses the whole host from the start because no
record exists to bind a cwd. No whole-collection read is issued for a record-backed proof.

**The listing hides what has no preview; the rollout is the witness it cannot be.** `thread/list` filters
`threads.preview <> ''` (codex-rs `state/runtime/threads.rs`): on 0.146 in every listing, lineage filters
included; on 0.153 in the plain and `cwd` listings, while `parentThreadId`/`ancestorThreadId` return empty-preview
rows. A spawned subagent (`source: subagent.thread_spawn`) can live, work, and finish without ever earning a
preview, so it is resident in `thread/loaded/list` and answers `thread/read`, yet no listing the proof performs
returns it — on 0.146 it never enters the closure and would be left loaded, pinning the shared server as a
reference nobody can release; on 0.153 it enters through the lineage read and no `cwd` read can then witness it.
Its rollout is the durable witness: the `session_meta` header binds its `cwd` and, for a spawned subagent, its
`parent_thread_id`, and the rollout's directory — the dated tree or the flat `archived_sessions/` — is its
collection. So the proof walks the resident set through rollout headers: a resident thread the listing did not
place in the subtree is a member when its header's parent chain reaches the subtree, and a member the scoped
listing does not return (an empty-preview row, or a `cwd` filter the server answered empty) is witnessed by its
rollout, whose bound `cwd` must equal the scope already bound for that member. Only positive evidence admits a
member: a resident thread with no readable rollout, or whose header names no parent or another thread, is
nobody's on this proof's word and is left exactly as found — the pre-fix state, never a mutation of someone
else's thread. A member the lineage read placed in the subtree that neither its `cwd` listing nor its rollout can
witness refuses and names both facts; a rollout that binds a different `cwd` than the member's scope refuses the
same way. A child that one listing returns and another omits is a census fault no rollout heals. The
continuing-cold proof of an already-archived record reads only that target's own collections and never walks the
resident set, so a hidden child an earlier close left resident does not block retirement: the resource report
shows it as that archived session's reference, and `resume` followed by `close` collects it through the resident
walk.

**Teardown.** Ordinary stop reads the target through its record's `cwd` and refuses descendants. Cold archive
treats the native `ancestorThreadId` result as an ownership closure at all depths excluding the ancestor, and
holds every fact about that closure to a second native witness before it may mutate. The target must occur in
exactly one of the active and archived collections, on a row whose `cwd` is the record binding. Every descendant
must occur in exactly one collection on a row matching its own reported `cwd`, and that assignment must equal the
descendant collection that returned it; normally those rows come from the scoped reads, with the rollout witness
above as the only alternative. Every member's direct-parent chain must reach the target without a gap or a cycle,
and the closure must equal the union of the subtree's direct-children reads: a child the closure lacks, a listed
closure member no parent returned, or one id under two parents refuses; a rollout-witnessed member is the one edge
no listing returns under its parent, and its header named that parent instead. Every listed loaded member's turn
presence comes from those same rows; a rollout-witnessed member's presence is unknown to the listing and is
settled by its rollout tail exactly as below. It then archives the initially-active closure deepest-first with
the ancestor last; already-archived members are proof, not mutation. The proof taken before the mutation and the
one taken after must name the same subtree, the same parent edges, and the same collection assignment, in the
same scope — a receipt carries its scope, and a receipt of one scope never authorizes a proof in another; the
members it witnessed through rollouts are re-witnessed the same way afterwards, since an archived unlisted member
is neither resident nor listed.
Scope agreement is settled where the teardown is still preventable: the stop guard compares the receipt's scope
against what the target's record binds NOW, before it re-proves anything, and refuses a mismatch or an absent
binding without a native read. Re-proving in the receipt's own scope would agree with itself, pass the guard,
let the leaf teardown proceed, and only then meet the commit's scope check — a teardown performed for a proof
that was already refused. A refused receipt authorizes no cold teardown on any seam that reads it.
Afterwards the whole subtree must be unloaded and uniquely archived while unrelated loaded siblings stay intact.
Duplicate active/archived membership, a member absent from both collections and unwitnessed by its rollout, a
wrong `cwd` binding, changed ancestry, or a late replacement fails closed. For Codex cold teardown alone, an
otherwise uniquely-owned member with unknown presence may consult the final record in its durable rollout tail: a
terminal native event proves the turn settled, while a missing, unreadable, incomplete, or non-terminal tail stays
fail-closed and names both the live client and the rollout evidence in its refusal. A live `active` report remains an immediate refusal the
tail cannot override.

When the exact bound generation is already reclaimed, close treats generation death as a positive empty-control
plane proof: it skips native subtree census, removes the stale binding, and completes the record's own cold-stop
archive. A live, unaddressable, or active generation remains fail-closed.

**Quarantine is narrower than archive** because an unreadable record has no record-shaped ownership claim to hand
it. It takes one exact native thread id plus the exact unreadable record id excluded from the owner census — an
exclusion that leaves the incident record opaque without blindfolding the census, so any OTHER unreadable
governed record still refuses as unknown control. It first proves the one materialized occurrence of that target
across every non-reclaimed generation (no occurrence, a duplicate, or an unproven generation refuses rather than
falling back to current or legacy), then that exact stable generation, zero other governed owners, an exact
one-thread closure, no descendants, and an idle known turn; an already-archived target is accepted only after
that exact target is proven unloaded. It then archives only that target, re-censuses the same generation and
target while preserving every loaded sibling reference, and returns public audit facts plus an in-memory
compensation closure. With no record to bind a `cwd`, quarantine reads the target's own rows from the whole
collections under the same member verification; it is an incident path, and its cost is accepted rather than
bought down with a binding it cannot prove.

**The fence, and what compensation may undo.** Every mutation proof fences the shared
PID/start/detached-receipt/socket generation across its reads, so an unrelated slow sibling remains a protective
loaded ID without blocking an isolated target subtree. That generation exists only for one verifier-owned
version-4 detached launch receipt whose live PID/start and process group agree, whose Linux `/proc` session also
agrees when running on Linux, and whose socket inode is unchanged. During the one-way v3 migration a MUTATION
GUARD ONLY may atomically promote the retired `detached-v3 PID start PGID SID` scope to that v4 receipt, and only
when every stored field equals the exact live Linux identity; reporting and every other read never mints or
repairs a receipt. Missing, malformed, or mismatched legacy evidence is an unproven generation and refuses before
any teardown. Compensation lives outside the native RPC boundary: until the product commits the archive record
and its final offline proof, a failure returns the same receipt to `restoreRuntime`, which restores all and only
its originally-active subtree members, and only on the unchanged original generation. The receipt carries the
scope each member was proven at, and compensation reads those same scopes, re-reading a rollout-witnessed member
through its rollout: a failure path must not put back the whole-host cost the proof removed. A receipt-free resume
remains the normal parent-only restore, read through its own record's `cwd` and refused without one.

## Headless readiness

Codex-headless readiness freezes one exact live detached receipt/socket generation, the loaded target thread, and
its unique governed record owner. Ownership joins every governed record whose adapter declares that
shared-runtime descriptor: exactly one record may claim the target thread and it must be the session being
resumed, since the loaded-ID set establishes reference state but never record ownership. The post-pending
validator repeats the full generation, loaded-reference, and owner join; an unload, restart, owner collision, or
reassignment retains or restores the original stopped/offline projection without a false transition. This launch
fence does not replace steady-state shared-record liveness: once committed, a sleeping thread stays addressable
through the app-server.

## Relocation checkpoint

The Codex protocol machine (2,107 top-level declaration lines) now lives in `spec-cli/src/codex-harness.ts`;
`harness.ts` retains the adapter interface, shared generic helpers, and the `HARNESSES` registry only. The
registry remains the single place that lists both Codex rows. `harness.test.ts` derives the allowed Codex mentions
from import lines and the registry line, so a future Codex declaration added to `harness.ts` fails the test without
duplicating a harness-name list.

The 22 active nodes that related `spec-cli/src/harness.ts` were scanned. Codex-specific anchors in this node,
`codex-headless`, and the parent harness evals now point at `codex-harness.ts`; generic adapter, lifecycle, Claude,
and shell-mirror nodes retain `harness.ts` because they govern the interface or shared helpers. The shared
shim/file-management and process-probe helpers now live once in `spec-cli/src/harness-shim.ts`, including the
single `PKG`/`SPEX` path derivation and `pexec` executor; both harness implementations consume those exports.
A companion structural test discovers the harness module cluster and rejects duplicate top-level declarations
(including `let`) pairwise. Injecting a temporary duplicate into `harness-shim.ts` made that guard fail with the
offending name, then the probe declaration was removed. This third-module boundary is the required escape hatch
for future large-adapter splits, rather than copying helpers to bypass a runtime import cycle. No behavior bug was
found or changed during the relocation. The same copy-versus-shared-helper wall also appeared in the concurrent
record-I/O extraction lane and is recorded here as a structural lesson, not a behavior fix.

内部结构化执行的受限分支沿 [[structured-session-runtime]] 与 [[structured-readonly-policy]]，不继承普通项目daemon能力。v2仅登记 [[frozen-context-reader]] 的动态工具，按精确thread/turn/callId服务并持久化真实回复；原生history独立核验完整覆盖。CLI与去工具provider目录构成冻结能力身份，未答请求恢复不伪造RPC回执；普通项目runtime的归属与控制契约保持本节点定义。
