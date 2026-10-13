---
title: spec-body-edit
status: active
hue: 150
desc: The named lane through which a human at the board edits a spec BODY and lands it as a real commit.
code:
  - spec-cli/src/spec-body-edit.ts
related:
  - spec-cli/src/index.ts
  - spec-cli/src/spec-body-edit.test.ts
  - spec-cli/templates/hooks/pre-commit
---
# spec-body-edit

## raw source

Reading a spec on the board and finding a wrong sentence should not mean opening an editor somewhere else.
Give the board the affordance GitHub's web view has — **edit this passage right here and commit it** —
without giving it anything else. Only `spec.md` bodies. Never code. And when it can't be done, say so
loudly instead of half-doing it. The same Edit Manually action is reachable from the full spec document and
the spec pane in the node information popup; it opens the body editor for the selected range and commits
only that replacement.

## expanded spec

以下即时提交保证适用于未启用同步的普通正文编辑。启用 [[sync-application]] 后，HTTP 入口只调用本模块只读 preparation，将 patch 与稳定请求标识交给完整同步操作；响应 commit:null，Spec、代码与测试经共同验证后在受管交付树落盘。原正文文件和 index 不会提前被单独修改。

**Who this is for, and why it is not the dogfood ritual.** [[topology-eager]] rules that a node's body
"carries the session's in-flight intent and is fine to sit as a worktree diff until reviewed and merged."
That is the cadence for an AGENT's proposal — a proposal exists to be reviewed, so it waits for a review.
A human correcting their own spec at the board is not proposing anything to anyone; they are the review.
[[three-part-body]] makes the same point from the other side: changing the `## raw source` half "needs
**human approval**", and this is the only surface where the human can give it directly. So this lane is not
an exception carved out of the worktree model — it is the one writer the worktree model was never about.

**Four guarantees, each structural rather than checked.**

1. **Only a spec body.** The request carries no path. The file is DERIVED from the node id through the spec
   tree's own reader, and the result must still be a `.spec/**/spec.md`; a node whose folder resolves
   anywhere else is a broken tree, not an edit target. Within that file only the region between the
   frontmatter and the end is rewritten — the frontmatter is re-emitted byte-for-byte, so no request can
   move a `code:` anchor, a `status:`, or one byte of source. "Only prose, never code" is therefore not a
   rule someone could forget to enforce; there is no expressible request that reaches code.
2. **Only the region the reader saw.** The caller sends back the exact lines it rendered. The server
   re-reads the file and compares. A mismatch is a **concurrent modification**: refused with the text that
   is actually there, so the human sees the collision rather than a verdict. Nothing is ever merged,
   reconciled, or guessed — and a path that already carries a *staged* change is refused for the same
   reason, because committing here would sweep someone else's staging into this edit's commit.
   Line numbers address the TRIMMED body, the same text `/api/specs/:id/content` serves, so the reader and
   the writer are counting the same lines.
3. **The gates stay up.** The commit opens exactly ONE door in [[main-guard]] — `SPEXCODE_ALLOW_MAIN`, the
   escape hatch that guard already names — and never `--no-verify`. This is the load-bearing difference
   from the neighbouring programmatic writers: [[local-issues]] and human sign-off may skip the pre-commit
   hook because their paths are unanchored **data**, and that justification does not transfer to a
   `spec.md`, which is the contract itself. So the spec-lint shim judges this commit exactly as it judges
   a session's, and the non-bypassable reference-transaction candidate gate judges it
   after that. An edit that would break the spec↔code graph does not land.
4. **Break, then recover, visibly.** The file is written before the commit is attempted, because the hook
   must judge the real tree. If the commit is refused for any reason, the original bytes are put back and
   the path is unstaged, and the refusal is reported **with the hook's own output**. The tree is never left
   half-edited, and the reason is never paraphrased into "commit failed".

**The commit is the whole record.** Nothing is stored beside it — [[source-of-truth]] recomputes the node's
version from its count of content commits and re-derives drift from ancestry, so the version bump and the
drift recount are consequences of the commit, not writes of their own. The board is invalidated on the way
out so the writer's own refetch cannot race a stale cache.

**Identity is server-derived.** The commit carries `Session: human`, the same rule human sign-off states: the
actor is the person at the board and no request body gets to claim to be someone else. That trailer is what
the node's "last edited by" then reads, honestly.

**Which checkout it commits on.** The one the backend is serving. On the trunk checkout the edit lands on
the trunk through the door above; on a session worktree it lands on that branch, where [[main-guard]] never
fires at all — one call, no branch in the code, and the same meaning either way: an edit at the board lands
where the board is looking.


**Read-only preparation in an explicit checkout.** `prepareSpecBodyEdit(root, id, patch)` resolves the
node through the existing filesystem-only spec loader for that exact root, including its canonical ID
mint. It does not rely on the backend's implicit checkout, so two worktrees with the same node ID prepare
against their own current bytes. It returns the repository-relative spec path, complete `source` and
`next` strings, `changed`, and the resulting replacement's `startLine`/`endLine`. The existing trimmed-body
line checks and exact original-text comparison apply before any result; nonexistent nodes and stale
regions remain explicit errors. Frontmatter, leading body whitespace, untouched lines and the trailing
suffix retain their original bytes.

Preparation reads files only: it does not write a file, stage, commit, move HEAD, or reject an existing
staged change merely to calculate a candidate. Identical text returns `changed: false`. `editSpecBody`
reuses preparation for the backend checkout, then keeps its existing staged-conflict check, actual write,
hook-enforced target-only commit, human identity and visible rollback on refusal. Preparation grants no
write authority and does not promise exclusive access after it returns; a synchronizing coordinator must
freeze and verify the prepared candidate and enforce its own delivery protocol before applying it.
