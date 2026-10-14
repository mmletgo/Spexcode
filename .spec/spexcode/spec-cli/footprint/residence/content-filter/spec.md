---
title: content-filter
status: active
hue: 200
desc: The mixed-content answer — a per-clone git clean/smudge filter for a contract file the host TRACKS (or has begun writing its own prose into) keeps the pristine host prose in the index and the injected block in the working tree; clean(smudge(x)) == x.
code:
  - spec-cli/src/contract-filter.ts
---
# content-filter

## raw source

A mixed-content file is the one place exclude cannot reach: the filter chain lives on git's TRACKED
pipeline (checkout smudges, stage/diff cleans), the ignore family on the untracked namespace, and a
contract file that carries BOTH host prose and our block needs the tracked-pipeline tool — gitignoring a
tracked file is a no-op, and the folded-in block would otherwise ride the file into every teammate's diff.
The filter keeps the two contents on their own sides of the index: the repo stores the HOST's pristine
prose (clean strips our sentinel block on stage/diff), the WORKING TREE carries prose + block (smudge
re-injects on checkout), and history never sees the block.

## expanded spec

The sentinel markers (`<!-- spexcode:start/end -->`) are the load-bearing anchor: clean strips exactly the
marked block, smudge (re)injects it, and the invariant is **clean(smudge(x)) == x** byte for byte, whatever
x's tail. Smudge appends the block after the host's exact bytes with one separating newline — a blank line
before the block when the host ended with a newline, none when it ended mid-line — and clean of a block that
ends the file removes exactly that. A repository whose `.gitignore` ends without a newline (common) or on a
blank line therefore shows no phantom modification after adoption, and uninstall hands the same bytes back.
Text with no sentinel passes through unchanged. A block the user moved away from the end keeps the older
collapse (the block and its surrounding blank lines become one gap). Smudge strips defensively before
injecting, so a block that somehow reached the index can never double-inject.

The driver is PER-CLONE, while its payload is PER-TREE. One stable `git config
filter.spexcode.smudge/clean` and a managed `.git/info/attributes` binding cover the closed materialized text
paths. At invocation the driver asks Git for the current toplevel, resolves that tree's existing runtime slot,
and selects the exact `%f` payload there; no payload means identity. Thus two linked worktrees can carry
different contracts and ignore blocks without `extensions.worktreeConfig`, without replacing the user's
global excludes, and without a last-writer common `contract-block.md`.

**Where it is planted — mixed content, present or imminent.** The kind detection ([[residence]]) binds
the filter for a contract file that is host-TRACKED, and PRE-ARMS it for an untracked contract file the
user's own prose has entered: arming costs nothing while the file stays untracked (no pipeline events
fire), and it makes the user's eventual `git add` — through any route, `-p` included; the block never even
appears in a hunk, since add/diff compare clean(worktree) against the index — strip the block
automatically. A wholly-ours contract file gets no filter: exclude is the weakest sufficient tool there.

Three field-verified edges the mechanism must hold:

1. **Graceful degradation.** The configured filter command points at the STABLE shim path and tests it
   before exec, degrading to `cat` (identity) when the shim is missing — a bare missing filter command
   makes git spray fatals on EVERY operation touching the file.
2. **No self-propagation + the phantom-`M`.** git re-smudges only on checkout, so a changed contract does
   not propagate by itself: the re-materialize writes the managed block straight into the working file (the
   block write IS the re-smudge) and refreshes the shim's block-content file. And a filtered path can never
   be verified by stat alone, so `git status` reports it modified FOREVER without content-checking (while
   `git diff` runs the filter and shows nothing) — settled by a content-GUARDED `git add --renormalize`:
   run only when the cleaned worktree already equals the index blob, a pure stat refresh that can never
   stage a user's real unstaged edit (a genuine edit keeps its honest `M`).
3. **Ordered unplant.** Strip the block from the working files FIRST, then remove its tree payload; remove the
   common attributes/config/shim only after no registered tree payload needs them —
   the reverse order leaves the block exposed as an uncommitted modification the moment the clean filter
   disappears ([[harness-delivery]]'s erase order honors this).

The filter guards the ADD path; the index a commit is actually built from is re-checked once more at the
last gate by [[commit-surgery]] (a blob staged before the filter existed — a `-f`, a pre-arming edit —
is cleaned there in place). Between the two, no route into history carries the block.

**JSON has no smudge/clean filter, and will not get one.** A comment-delimited block cannot exist in JSON,
so the sentinel that scopes ownership there is the hook COMMAND itself: every entry we write invokes
`dispatch.sh`, and only such entries are ever written or removed ([[harness-adapter]]'s
`writeManagedJsonHooks` / `removeManagedJsonHooks`). That is co-ownership by identity stamp, the same idea
this filter implements for text, minus the index/history half.

The earlier plan recorded here — REDUCE THE DIMENSION by moving the shim to claude's `settings.local.json`,
turning it back into a whole-file machine fact — is **wrong and must not be revived**: Claude Code writes
that file itself (every permission the user approves accumulates there), so the move relocates the collision
onto a file the host agent actively rewrites, and each side would drop the other's edits. There is no file in
a harness's config directory that is reliably ours alone; co-ownership is the answer, not relocation.

What JSON co-ownership does NOT preserve is LAYOUT: a merge re-serializes the whole object (2-space, one
member per line), so a hand-compacted config comes back semantically identical and textually reformatted.
Values, key order and the trailing-newline convention all round-trip; hand layout does not, because no JSON
writer can reproduce it. That is an accepted, visible cost — unlike a whole-file write, it destroys nothing.


受控冻结交付复用 describeCanonicalContractFilter 的唯一 SHIM/filterCmd 源，只读核对精确 effective commands 和实际 shim 普通文件字节/0755 模式；不按名称信任、不执行未知命令、不改变 ordinary 安装/降级/clean-smudge 行为。当前 common 属性/root/bindings 与外部 per-tree filter 数据纳入冻结政策。strict materialize 不调用植入/撤销/filter-stat repair，所有新托管投影只落登记私有目录。

同步作者字节投影复用同一 SHIM 源与 canonical bindings。cleanCanonicalContractText 在独占临时目录内只运行可信发布代码、固定绑定和冻结 stdin；不读取或执行仓库配置中的 filter 命令，不触碰工作树或用户 index，不为同步另写一套 sentinel 归一化算法。
