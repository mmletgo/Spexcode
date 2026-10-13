---
title: 受控交付可信工具与 Git hooks 静态绑定
status: active
hue: 175
desc: 在执行前核对候选外完整发布 runtime、系统 Node/Git 与实际 canonical hooks，不执行未知候选配置。
code:
  - spec-cli/src/sync/trusted-hooks.ts
---
# 受控交付可信工具与 Git hooks 静态绑定

## raw source

受控交付不能让候选代码通过本地 CLI、自动 build、未知 Git hooks、签名或过滤器取得宿主执行权；必须预先证明实际工具来源并保持正常门禁。

## expanded spec

受控身份读取始终使用原始 Git 对象，不能通过 refs/replace 伪造 tree 或 parent。makeTrustedHookEnv 固定 GIT_NO_REPLACE_OBJECTS=1；preflight 和四个 strict hook 的 Git 调用同时强制 --no-replace-objects，不只依赖可变 child env。refs/replace 不改变 raw valid commit 的结论，普通 authoring 的 replace 语义保留。

prepareTrustedHooksBinding(root, options) 是内部协调器只读 preflight；inspectTrustedHooksBinding(root, binding) 在实际操作前再次核对已登记绑定。输入不是 HTTP 参数，工具/runtime/canonical 模板位置由协调器内置受信发布位置提供，不能由模型候选选择。返回 supported binding 或 unsupported 的路径与原因；不安装、替换、删除或探测执行 custom hook，不创建 worktree、commit 或交付副作用。

Node/Git 使用明确绝对 realpath 与文件摘要，默认 Node 为当前进程，Git 仅从固定系统位置查找，不读候选 PATH。工具入口必须为候选目录外已编译 dist/cli.js 或 cli.mjs，不启动源码 launcher，也不调用 npm build。当前构建是多模块；trustedRuntimeRoot 因此必须为候选外完整固定发布包，包含全部已编译模块、依赖和 canonical 模板。递归 manifest 绑定每个普通文件的 bytes/mode、目录 mode、内部 symlink target；外链和特殊文件 unsupported。完整 runtimeDigest、入口摘要与 Node/Git 摘要在四个 strict hook 每次工具调用前以固定 Node built-in 检查，不能替换 imported 模块后仍信入口 hash。发布包应由协调器准备为闭合固定 runtime；本模块不替调用者下载、构建或判断发布者身份。

通过固定系统 Git 仅读取有效配置和实际 hooks 路径，明确拒绝 hookspath 重定向、无法证明来源的 filter/签名/diff-driver/trailer-command/fsmonitor/外部 attributes 配置。诊断不回显这些命令值，避免凭据泄露。实际可执行 hook 必须逐字等于受信 runtime 内 canonical 模板，必需 pre-commit/prepare-commit-msg/reference-transaction/post-checkout 全部存在且可执行；未知额外可执行文件同样拒绝，Git sample 文件不参与执行。仅 managed header 不能证明来源。

makeTrustedHookEnv 仅供内部 child 构建环境，清理 Node/shell/loader/Git 注入、继承的 lint/main/defer bypass 和旧同步字段，固定工具路径和 runtime digest，并设置 trusted-v1、必需 operation: prepare|publish 与预定 tree/parent/ref。operation 纳入持久 binding、env(SPEXCODE_SYNC_OPERATION) 和 inspect 比较；缺失或未知值 unsupported。prepare 的 expectedTree 必须等于已有 expectedParent 的 base tree，publish 则绑定计划交付候选 tree。四 hook 使用该入口优先于 candidate.bin；工具 missing/失败/exit75 一律失败，普通 authoring 的 existing advisory 行为不变。pre-commit 仍执行 trunk gate/surgery；prepare-commit-msg 保留 identity 与 context；post-checkout 保留既有 refresh，严格模式失败返回非零。post-checkout 发生在 Git 切换后，非零不能当作切换没有副作用，调用者须核对真实 Git 并恢复。

reference-transaction 在 prepared 的原 lint 之前按显式 operation 核对事务。prepare 只允许 expectedRef 从全零创建到已有 expectedParent（Git 初始化 HEAD 还会投影为同分支 base→base 无内容更新），以及 HEAD 从全零/base 到 base 或 ref:expectedRef（该 ref 实际解析必须仍为 base）的结构切换；不允许新作者 commit、其它分支或其它对象。Git worktree 初始化还会写 ORIG_HEAD，仅允许全零/base 到 base 且当前 HEAD 仍为 base；Git checkout 的 AUTO_MERGE 全零到全零清理同样仅在 base HEAD 上接受。它们都不构成发布。publish 的作者事务必须恰有一个 expectedRef 更新，old 等于 expectedParent、新 commit 的实际 tree 等于 expectedTree 且恰一个 parent 等于 expectedParent；同事务 HEAD 如存在必须一致，任何 HEAD-only 作者提交拒绝。Git commit 在发布后发出的 AUTO_MERGE 全零到全零无对象清理仅在当前 HEAD 符号指向 expectedRef 且当前实际 commit tree/单 parent 已匹配发布绑定时接受；不能以清理身份作者对象。未知其它 ref 事务拒绝。

issue-only/reachable/non-governed 分类都不能跳过受控版本绑定或 required lint；surgery 改 index 导致 tree 与冻结预期不同则实际 ref 不前进。没有禁 hook、no-verify 或 SKIP_LINT 模式。本模块提供静态执行接缝，交付身份、独占写入、journal、实际 index/read-tree、commit 与失败恢复由上层协调器负责；不单独证明完整 P2 同步完成。
