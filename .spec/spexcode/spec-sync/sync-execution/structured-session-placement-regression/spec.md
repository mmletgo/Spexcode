---
title: 结构化候选外置回归
status: active
hue: 175
desc: 真实未初始化Git与linked source验证结构化候选外置、源码只读与错误runtime配置拒绝。
code:
  - spec-cli/src/structured-session-placement.test.ts
---
# 结构化候选外置回归

## raw source

没有初始化SpexCode的普通Git源码也必须保持原样；后台结构化推理不能因为准备会话目录使其出现未跟踪的`.worktrees`。

## expanded spec

使用正式sessionCreateRequest内部结构化入口与真实Git注册候选，不启动模型。plain source无`.spec`及忽略配置，创建后status、HEAD、tree与index逐字节保持；真实worktree注册位于外部项目runtime的structured-worktrees，父目录为0700，源码没有新增.worktrees。

SPEXCODE_HOME位于主checkout或linked source内时明确target-resolution拒绝，Git注册与原HEAD/tree/index不变；不能把错误runtime配置默许成源码内候选目录。此场景只验证创建与布局，真实取消/故障重启及拥有权清理沿 [[sync-native-run-regression]]，完整native调用另由上层验收。

命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/structured-session-placement.test.ts`。
