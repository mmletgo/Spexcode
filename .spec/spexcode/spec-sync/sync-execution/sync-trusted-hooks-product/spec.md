---
title: 可信交付真实发布 CLI 回归
status: active
hue: 175
desc: 完整冻结 runtime 的真实四条 hooks、canonical filter、原文字节和故障拒绝。
code:
  - spec-cli/src/sync/trusted-hooks.product.test.ts
---
# 可信交付真实发布 CLI 回归

## raw source

stub CLI 成功不能证明实际 Spex 项目的过滤器和托管指令渲染可以安全交付。

## expanded spec

先 build 当前可信工具，由 freezeDeliveryRuntime 固定完整已编译发布闭包、templates 和生产依赖。临时项目使用该真实 dist CLI init/codex 安装 canonical filter，正常 hooks 提交既有 Spec，tracked AGENTS 保留作者 prose。严格 prepare 经真实 worktree add 的四条 canonical hooks 调用同一 dist；随后用独立候选 index 精确生成 tree/read-tree，再以真实 commit-surgery/context/lint 发布。

验证新 worktree 和最终作者字节未混入 managed block；raw commit tree/单 parent/实际 index 精确匹配，原 source index 与 working 作者字节不变。静态自定义 plugin 声明可编译到私有投影，其 marker 脚本绝不执行；真实 Session stamping 证明 prepare-commit-msg 路径。初始manifest外部数据来源、私有目录物理身份变化、配置/shim/绑定或实际 hooks 漂移先检查拒绝，未知 filter/custom hook marker 不执行且诊断不回显命令值。

命令：`npm run build`；`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/trusted-hooks.product.test.ts`。普通 materialize/clean-smudge 与 staged surgery 使用 materialize.test.ts 的相关模式回归。未知冻结模式在真实CLI refresh/surgery 中直接失败，保留原文字节/index/config而不降级ordinary。此测试不代表 coordinator/P2 整体通过。
