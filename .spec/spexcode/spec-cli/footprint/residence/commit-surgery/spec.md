---
title: commit-surgery
status: active
hue: 200
desc: The git-native anchors of the footprint — pre-commit runs an UNCONDITIONAL materialize + staged-index repair (strip leaked blocks in place, evict HEAD-untracked artifacts; never reject), post-checkout/post-merge re-materialize; no harness event ever triggers a materialize. A git hook invoked from a linked worktree resolves the CLI from that checkout first, so an older main-checkout materializer cannot rewrite newer worktree artifacts.
code:
  - spec-cli/src/commit-surgery.ts#commitSurgery
related:
  - spec-cli/templates/hooks/pre-commit
  - spec-cli/templates/hooks/post-checkout
  - spec-cli/templates/hooks/post-merge
  - spec-cli/hooks/dispatch.sh
---
# commit-surgery

## raw source

"The masks must never be stale" is a temporal invariant no gate can guarantee — so it is replaced by an
EVENT-anchored one: the materialized artifacts are provably fresh at the only moments freshness matters.
History is written
at exactly one gate (commit), and a clone's materialize inputs (.spec/.plugins content, a contract file's
trackedness) move only through git's own transitions (commit, checkout, merge) or the user's editor. So
the anchors are git-native and ONLY git-native: the spex verbs (init/materialize), session-worktree
creation, and the planted pre-commit / post-checkout / post-merge hooks. The harness is a READER of the
materialized files, never a trigger — the old dispatch-gate auto-materialize is retired, and `.plugins` edits
became git-transactional: they take effect at the commit/checkout/merge that carries them, like any other
source change.

## expanded spec

**pre-commit — the correctness anchor.** Two halves, in order:

1. *Unconditional materialize.* Every machine-fixable staleness (exclude entries, filter binding, a
   contract file's kind flip) is repaired before the index is inspected. Unconditional is affordable
   precisely because of the vote's collapse: materialize's write surface is untracked artifacts + per-clone
   config — ZERO tracked-file touches — so running it inside a hook can neither dirty the commit nor need
   to amend it.
2. *Staged-index surgery — repair, never reject.* Over staged ∩ artifact paths, by kind: a contract blob
   carrying our sentinel block is cleaned IN PLACE (source = the STAGED BLOB, never the worktree — `git
   add -p` partial staging survives byte-for-byte; only the block is removed); a HEAD-untracked
   machine/run-residue/generated artifact is EVICTED (its tracked contribution is zero bytes — an empty
   husk is worse than absence; the file stays on disk); anything HEAD already tracks is never deleted by a
   hook — a legacy committed artifact heals via the block-strip, converging history toward pristine without
   a surprise deletion. Both operations carry zero intent ambiguity (the block's content is never the
   user's; a wholly-ours file holds no user byte), so there is no question to ask and no rejection — one
   stderr note per repair, and the commit proceeds.

The surgery deliberately INVERTS the hook-env rule the rest of the hook chain lives by: it PRESERVES
`GIT_INDEX_FILE` so the exact index this commit is built from — including the TEMPORARY index of a
pathspec or `-a` commit — is the one read and repaired (git.ts's `git()` strips that env for repo
discovery; index surgery is the one place the env is the point). Resolution and failure are advisory like
the lint shim: no CLI → skipped with a note, CI lint stays the enforcement gate; and the guard travels
with the risk — the artifacts and the hook are planted by the same materialize, so any clone that can leak
necessarily carries the repair.

**post-checkout / post-merge — the freshness anchors.** A branch checkout can flip a contract file's
trackedness (switching to a branch that tracks CLAUDE.md checks out the pristine index prose): the
post-checkout re-materialize writes the block back into the working file, binds the filter, and withdraws the
exclude entry — the kind transition heals itself; file checkouts (flag 0) are skipped. post-merge
re-materializes after received `.spec`/`.plugins` changes. Both are quiet and best-effort: a missed refresh
self-heals at the next anchor, pre-commit being the backstop. A session-created worktree is the one deliberate
handoff: its `git worktree add` passes a child-only defer marker to post-checkout, then the creation transaction
copies `.spec/spexcode.local.json` and performs ONE explicit materialize. The marker neither changes Git's hook
semantics nor persists beyond that child; it prevents a pre-seed best-effort render from racing or duplicating
the transaction-owned render. Ordinary checkout, switch, worktree add, and merge carry no marker.

**Known self-hosting residue.** The hook resolves `spex` PATH-first, so on a branch that CHANGES
materialize's own semantics the commit anchor still runs the OLD toolchain until the deployed
global/hook copies update — a stale toolchain's materialize can momentarily overwrite a new one at commit
frequency
(down from the retired gate's every-event frequency; visible in git status, self-healing at the next
current-toolchain anchor, never blocking). The remedy is operational, not mechanical: ship + update
the global right after such a branch merges.

**The friction budget this buys.** Worst full path: the user edits a wholly-ours contract file, `git add`
hits git's own ignored-path refusal (ONE bump — git's message, git's `-f` answer), forces, commits — and
the surgery makes that native escape hatch safe. One bump is the floor under git physics (add has no hook;
a pure materialized artifact must stay excluded or `??` noise and empty-file scooping return). Every other
path — an
anchor ran between edit and add — is zero-bump.


**受控同步交付。** 内部 trusted-v1 hook 只启动协调器绑定的候选外完整已编译发布工具，不解析 candidate.bin。既有 surgery/refresh 仍执行，真实 commitSurgery 的 materialize 异常在 trusted-v1 模式传播原异常，不能只打印 advisory 后返回成功；普通模式仍只打印 footprint may be stale 提醒并继续。工具不可用、失败或 exit75 必须返回失败；post-checkout 也不得沿用普通 best-effort 或 session-create defer 来隐藏该失败。surgery 若修改计划冻结的 index，reference-transaction prepared 以实际 commit tree 拒绝 ref 更新，不自动接受新 tree，不弱化门禁。未知 custom hooks、候选 hookspath 或无法证明的外部 signing/filter 由内部静态 preflight 明确 unsupported，不替换、删除或探测执行。普通 authoring 的 repair-and-proceed 与 refresh best-effort 保持。


strict hook 的固定 Git wrapper 必须附加 --no-replace-objects，并为可信工具 child 固定 GIT_NO_REPLACE_OBJECTS=1；身份基于原始对象，refs/replace 不参与受控 tree/parent 判断，普通模式保持。


严格 materialize 的 footprint 策略正常检查静态声明与契约，并仅写登记私有投影；surgery 仍核对实际 staged index。不能通过刷新托管 AGENTS/CLAUDE 块或新植入 command 污染冻结候选；既有 canonical filter 由静态 preflight 精确识别，其漂移阻断。


非空内部冻结模式值未知时同样失败并传播，不能静默降级到 ordinary materialize 或 advisory；普通未设置内部模式的行为保留。
