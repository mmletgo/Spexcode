---
title: 可信工具 hook 接缝真实 Git 回归
status: active
hue: 175
desc: 在真实小仓库验证固定编译工具、真实 ref 拒绝、surgery 漂移及普通模式回归。
code:
  - spec-cli/src/sync/trusted-hooks.test.ts
---
# 可信工具 hook 接缝真实 Git 回归

## raw source

受控工具与候选不能混淆；版本绑定和失败必须通过实际 Git hook/ref 行为证明，不相信成功声明。

## expanded spec

测试使用独立临时 Git 仓库、候选外已编译闭合 fixture runtime 与实际 canonical templates。可信 fixture 仅模拟现有工具 verbs，Git checkout/commit/update-ref 都真实执行。候选 bin/custom hook/filter 为未执行 marker 断言，不在宿主运行其恶意代码。

覆盖四 hook 固定可信入口、wrong tree/parent/ref 原 ref 不前进、surgery 改 index 后 prepared 拒绝、每个工具阶段的 missing/exit75/76 阻断、issue-only 不免冻结绑定、静态 unknown hook/hookspath/filter/signing/diff/trailer 拒绝且不回显命令值、imported module 替换导致整个 runtime 摘要失效、源码 launcher 与候选模板不能自认可、普通 no-CLI advisory 保留以及 child 注入/bypass 清理。另覆盖 refs/replace 替代 raw 错 tree/parent 不能通过 publish（主动移除 child 环境保护仍拒绝）、prepare 不接受替代 parent tree、固定 GIT_NO_REPLACE_OBJECTS 及 raw valid 不被坏替代降级。另覆盖真实 worktree add 的符号 HEAD/ORIG_HEAD/base 事务、prepare 不接受作者对象/错 ref/base、publish 拒绝 detached HEAD-only 作者且 ref/HEAD 不推进、缺失 operation 与错误 prepare tree 预检拒绝，以及 post-checkout 失败后真实 HEAD 已切换的副作用证据。现有 candidate-gate、session-stamp、commit-context 和 post-checkout 单项回归提供普通行为证明。

针对命令：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/trusted-hooks.test.ts`；`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/commit-gate.test.ts spec-cli/src/session-stamp.test.ts spec-cli/src/commit-context.test.ts`；`npx tsx --import ./scripts/test-home.mjs --test --test-name-pattern='post-checkout defers only the session-owned refresh' spec-cli/src/init.test.ts`；局部 ESLint 与 typecheck。本测试不声称真实发布包已在完整 P2 coordinator 交付，该包准备和集成由上层证明。
