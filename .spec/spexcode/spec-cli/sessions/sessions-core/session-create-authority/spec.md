---
title: session-create-authority
status: active
hue: 280
desc: What a public create must establish before it may use the local path — one identity probe with its own budget and its single ECONNREFUSED licence — plus the fork point it may pin, the fork commit it always records, and the supervisor its prompt may address.
code:
  - spec-cli/src/sessions.ts#sessionCreateRequest
  - spec-cli/src/sessions.ts#recoverSessionCreateTermination
related:
  - spec-cli/src/session-create-cli.test.ts
  - spec-cli/src/session-create-orphan.yatu.test.ts
  - spec-cli/src/client.ts
  - spec-cli/src/session-selectors.ts
  - spec-cli/src/mentions.ts
  - spec-cli/src/sessions.test.ts
  - packages/spec-core/src/layout.ts
---

# session-create-authority

A create is the one session verb that can be asked of the wrong backend, the one that decides which commit
the work starts from, and the one that decides whose subtree the new work belongs to. All three are settled
BEFORE any Git mutation, so a refusal leaves no half-made worktree, branch, store, or receipt behind.

**Public session creation asks one lightweight authority question before it may use the local path.** The CLI
first opens a bounded TCP connection to the target. A completed connect is the presence fact: the supervisor's
proxy accepts it even while the child event loop is busy, so a slow `/api/instance` response is still a present
backend. Only a connection that is refused (the entire transport cause chain is `ECONNREFUSED`) licenses the
in-process fallback. After presence is established, `GET /api/instance` is the identity read — it enumerates
no governed records and derives no worktree overlays — and it uses the ordinary session-create request deadline,
not the presence budget; an optional recorded-endpoint health read is discovery only and never consumes either
budget. An explicit target skips project comparison and normally owns the one keyed `POST /api/sessions`; an
implicit target does so once the instance identity canonically matches, compared through the shared main-root
resolver (which follows a linked worktree to its common checkout and applies the configured `main`) rather than
by raw path. Any HTTP response proves ownership, and a proven mismatch is still refused. A timeout, reset, DNS,
or other transport failure before TCP acceptance is indeterminate and fails without local creation; a failure
after acceptance is a present-backend authority-read failure and also never falls back.

**Measured finding (out of scope for this lane).** On 2026-08-29 the live backend logged
`/api/graph build took 11822ms (budget 1500ms)`: one event-loop stall is long enough to make a header-deadline
probe report a false absence. The create authority now treats that stall as presence and delegates to the
backend; the graph build's blocking work remains a separate performance investigation.

**A create may pin its fork point.** Creation accepts an optional `base` — any commit-ish the main checkout can
resolve. Absent, the session forks from the auto-detected source-of-truth branch, i.e. from whatever that branch
has drifted to at the moment the worktree is made; that is right for ordinary work but leaves a run against a
frozen commit inexpressible, so an evaluation, a bisect, or a replay could not name the code it actually ran on.
A supplied `base` is resolved during target resolution, BEFORE any Git mutation: one that names no commit fails
the request with a 400 and leaves no half-made worktree, branch, store, or private candidate receipt behind. A
resolved pin becomes the `git worktree add` start point and is stored on the record, so a later reader can tell
a pinned run from an unpinned one. It also joins the idempotency payload hash — a retry that changes the pin is
a different request, not the same one — while an unpinned create keeps its exact legacy record bytes and
receipt hash, so nothing that never pinned gains a field.

**A create records the commit it actually forked from.** Whether or not a pin was supplied, the branch ref right
after `git worktree add` IS the fork point, and the record keeps it. It is written like the optional pin — present
only on records created since it existed, so an older record keeps its exact bytes — and it is the one fact that
later separates a branch which never authored a commit from one whose commits the base has absorbed. Git ancestry
cannot: both heads are ancestors of the base. A reader that lacks the field recovers the same commit from the branch
ref's creation reflog entry, which is where git wrote that start point; the diff document ([[diff-document]]) is the
surface that spends it.

**A create may address its supervisor from the prompt.** The `parent` field records who RAN the create, which
is provenance and nothing more — so before this, a human launching from the dashboard had no way to hang the
new worker under an existing session at all, and an agent could only ever produce its own children. The prompt
therefore carries the grammar's one create-time directive, `@parent:<selector>` ([[mentions]]). It is read off
the raw prompt first: the token is stripped, the selector resolved against the retained board — archived rows
included, because parentage is a durable pointer that outlives its parent's liveness — through the same shared
matcher every session verb uses ([[session-selectors]]), and the resolved id REPLACES any supplied `parent`.
Explicit addressing outranks provenance. The two candidate sources — the caller that ran the create and the
prompt that addressed a supervisor — are ranked in exactly one place, which yields one settled parentage
carrying both the id and which source won; nothing downstream re-asks, and the source never becomes a second
flag riding the transaction. The published record's `parent` is then an ordinary one, so the read-time
forest, the parent watch source, and [[session-reparent]] all treat it exactly like a spawned child's
([[session-nesting]]).

Everything that could make the directive silently wrong is a `400` before the transaction opens: two different
selectors in one prompt, a selector that names no session, an ambiguous prefix. A create that dropped an
unusable directive would land the worker at top level, where nothing distinguishes the miss from an ordinary
unparented launch until a human goes looking at the forest. `.` resolves to nothing here — the backend's own
environment id and working directory are not a stand-in for whichever caller wrote the prompt. The board read
is paid for only when the directive is present. Because the strip happens before the payload is normalized, a
same-key retry of the same raw prompt hashes identically; the resolved parent is part of that payload, so a
retry whose named supervisor has since vanished is a different request and is refused rather than silently
reparented. The launch text tells the child the truth about which of the two it is: created by a spawner, or
attached under a supervisor that did not create it.

The reserved selector `none` is the one explicit top-level escape at birth. The create boundary first asks the
ordinary resolver for an exact id, id-prefix, or branch; only a true no-match for the literal `none` settles
`parent: null` with directive provenance. Thus a real session id or branch named `none` remains addressable, a
prefix/branch collision remains ambiguous, and every other no-match still returns the ordinary `400`.

**A create may bind its issue.** Creation accepts an optional `issue` — the id of the issue the worker is for
([[issue-binding]]): a thread's `@new` passes its thread id, `spex session new --issue <id>` passes one by hand.
It is typed like `name` and `base` (a non-string is refused before the transaction), trimmed, bound into the
idempotency payload, and copied onto the record as provenance beside `parent`. Nothing here resolves it against
an issue store — the boundary records what the caller said, and the Issues page's read-time join gives it meaning.

**A create may choose the initial reply channel.** The optional `initialReplyVia` request field currently accepts only
`"note"`. A creator whose new document opens on the terminal-free Conversation passes that value through the
same prompt-composition seam used by later input, so a pane-backed launcher receives the full note-flow guidance
on its first turn. It is part of the normalized idempotency payload; omitting it preserves the ordinary terminal
launch text, while a headless launcher still defaults to note through the target capability.

**A node branch never tracks the base branch.** Creation passes `--no-track` when forking from any start point,
including a remote-tracking ref, because landing explicitly merges the base and the node has no business upstream.
This keeps concurrent creates from contending on `.git/config` while Git writes branch upstream metadata.


结构化后台任务复用同一创建事务与启动队列，但固定只读执行选项来自可信内部调用，不能由公开 JSON body 注入。安全策略、输出 schema 与输入摘要一起绑定请求载荷哈希并持久化在运行 envelope；重试不得切换权限或复用旧结构化结果。此类 prompt 不解析普通命令及 parent 指令、不物化项目 hook/trust 配置。普通会话的公开创建对象及既有 launcher 行为保持原契约。

受限结构化创建的取消/超时终止事实由原 request-key record 锁内写入私有原子收据，精确绑定 sessionId、requestDigest、payloadHash、phase 与 cleanupComplete/notStarted；仅已取得创建权、未publish、自己拥有的候选资源已清理完毕时写入。等待锁时退出、未知候选或清理残留不产生证明；readSessionCreateTermination 是只读入口。相同结构化键和载荷返回原终态，不重新创建；不同载荷仍 key_reused。收据不保存 prompt 或凭据，普通会话仍沿用原创建重试语义。

取消恢复可经 recoverSessionCreateTermination 重入既有候选清理：先取得原 request-key 锁再取得精确候选资源锁，拒绝已有 canonical 会话（即使运行 envelope 缺失）。私有候选收据须精确匹配请求、载荷和从原 prompt 推导的 root/path/branch；没有收据、路径注册身份未知或分支偏离冻结 fork point 均不得删除或生成 notStarted 证明。已移除候选也必须锁内重读确认 Git registry、目录、分支与 session store 清理完成，退休私有候选收据后才写正式终止收据。首次清理失败或超时保留候选所有权，后续恢复不重建会话、不占新调用预算；清理错误保留 Git 命令阶段、截止事实和 stderr 诊断，不输出环境或凭据。

候选资源所有权不能证明后来的文件字节仍属于创建事务。恢复须拒绝 tracked/staged/untracked/ignored 的新增或修改内容；只有既有 host-state seed `.spec/spexcode.local.json` 与 source 副本逐字节相同可视作已知可重建内容。恢复使用非 force 的 Git worktree remove，检查后出现未提交或未跟踪编辑仍由 Git 拒绝删除；未知内容不生成终止证明，原资源和预算保留。

恢复清理仅由非 force 的 Git worktree remove 删除目录；命令完成后同路径出现的未知残留或外部重建内容保持原样并阻止终止证明，不能用递归 FS 删除兜底。恢复分支删除使用已解析的真实冻结 fork commit 作为 Git expected-old CAS，正常 reference-transaction hooks 继续执行；检查后分支前进则保留引用与残留，不生成 notStarted 收据。Git registry 尚未移除候选时不删除恢复分支。
