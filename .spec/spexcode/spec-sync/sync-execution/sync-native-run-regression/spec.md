---
title: 原生派发资源桥针对性回归
status: active
hue: 175
desc: 用真实SQLite与可观察原生运行接缝验证持久意图、身份、取消和重入边界。
code:
  - spec-cli/src/sync/native-run.test.ts
---
# 原生派发资源桥针对性回归

## raw source

资源桥必须证明实际记录与数据库协议之间的故障窗口可恢复，不能把模拟结果称为真实LLM完成。

## expanded spec

验证派发前持久计划、published但thread未知、精确thread/turn绑定、完整结果证据、同键无重复调用与计费、同键不同载荷拒绝、结果/record身份与hash错配拒绝、未知原生终态不removed、取消回执丢失与旧fence资源结算、已结算结果blob核验重放、精确同键恢复不另造会话。真实原生Agent全链路验收由上层负责。

命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/native-run.test.ts`；相关lint与typecheck沿用sync目录约定，不运行无关完整套件。

已覆盖terminal写入后本地失败的无重复重放、旧source被superseded后的精确Abort/stop、已冻结candidate资源绑定、调用前已aborted的notDispatched证明，以及取消回执丢失仍保存已确认终态。测试仅验证真实SQLite和可观察runtime协议；不宣称真实LLM或真实原生RPC已执行。

创建阶段覆盖真实 Git target-resolution 与 worktree-add 后被取消：锁等待者取消不能替已取得创建权的事务写收据，worktree/branch 清理完成后方可结算资源。新进程同键重放取消收据且不同载荷拒绝；取消资源恢复不重派发、不增预算。未证实停止继续保留容量，收据版本、session、request、payload、清理与 nativeStopped 任一错配都拒绝。真实 Git fail→pass 验证仍不代表真实模型已经执行。
