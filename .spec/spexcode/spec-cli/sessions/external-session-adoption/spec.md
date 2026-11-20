---
title: external session adoption
status: active
hue: 205
desc: Attach the current external harness conversation to one project for read-only viewing and file handoffs.
code:
  - spec-cli/src/session-adoption.ts
related:
  - .spec/spexcode/spec-cli/sessions/files/spec.md
  - .spec/spexcode/spec-cli/sessions/harness-adapter/session-transcript/spec.md
  - .spec/spexcode/session-runtime/application-service/application-composition/spec.md
---

# external session adoption

In a running external harness conversation, `spex session adopt` claims the current native thread for the
Git project identified by the real path of its common directory, shared by its linked checkouts.
The local CLI takes the identity from the harness's own per-thread environment. No native id operand,
remote self-registration, launcher identity fallback, synthetic SessionStart, process, or worktree is involved.
Ambiguous environments and a native identity already governed by SpexCode are refused.
Codex claims take the complete native UUID. Its transcript is available only when one exact rollout filename
and that rollout's first `session_meta` record identify the claimed UUID. Missing, mismatched, and duplicate
rollouts produce a named transcript error. The posted files remain available.

The application commits the project claim and the native id's existing or new protocol address together.
The same project and thread are idempotent. A competing project claim is refused while the first is active.
`spex session unadopt` withdraws the current thread's claim from its project. Posted files and mailbox data
remain; the board, transcript, and file access for that project disappear while the claim is withdrawn.
A later claim in the same project restores its published list. The native thread is left running.
An existing external runtime envelope cannot change the adopted file list or reopen access after withdrawal.

An active claim projects directly from the application as a session row with external ownership and unknown
liveness. It owns neither checkout nor branch and contributes no worktree overlay. The board and exact session
details show the same row. File posting, listing, byte retrieval, retraction and dashboard preview continue
through [[files]]. The console opens [[adopted-conversation]] for the native transcript.
Control verbs for process, launch, worktree, terminal and session topology refuse the external identity.
That refusal covers both ends of watch and parent relations, and every namespace of runtime bind or dequeue.
A claim conflicts with existing control relations or bindings of that identity.
The intentionally explicit mailbox commands remain protocol-addressed independently of a claim.

The additive application migration leaves existing addresses, histories and runtime bindings in place.
Opening the application under the new toolchain can apply this migration. Stop the processes sharing the store,
take an SQLite backup, and upgrade all writers together. The previous generation refuses to reopen the upgraded
store. Roll back by stopping the new writers and restoring the backup. Posted file lists remain in their
project-local session directory.
