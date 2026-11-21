---
title: Codex CLI 原生工作树执行
status: active
code:
  - spec-cli/src/codex-native-worktree-structured.ts
related:
  - spec-cli/src/codex-harness.ts
  - spec-cli/src/codex-native-worktree-structured.test.ts
---

# Codex CLI 原生工作树执行

## raw source

LLM Manager 已冻结到 Codex 的工作树任务通过本机 Codex CLI 执行。默认模型沿用 CLI 当前配置，明确选择的模型原样交给 CLI。

## expanded spec

[[structured-session-runtime]] 为每次派发启动独立的 Codex app-server stdio 进程和临时原生 thread。启动 cwd、工作区根和 thread cwd 绑定同一真实工作树。只读调用使用 Codex 只读 sandbox。编辑调用使用 Codex 原生权限配置，写入范围为工作树、任务私有临时目录及正常提交所需的 Git 元数据。共享配置与其他分支继续只读。两种模式均关闭 MCP、拒绝审批、交互输入及权限扩张。Git 结果按 [[native-worktree-runtime]] 核验。

首轮派发以原生 thread/start 和 turn/start 的回复确认身份。Codex 以冻结 JSON schema 生成输出；同一 thread 和 turn 的唯一 final_answer 及 completed 终态、冻结 schema 的本地验证、整个受管进程组停止缺一不可。JSON 或 schema 拒绝保留固定 thread/turn、原始 final 和校验失败，供后续修复使用。有原生用量时只接收同一轮的原生累计计数，总输入含缓存命中，未缓存输入从原生总量扣除命中量。取消以精确 turn 发出 interrupt，ACK 单独记录，最终停止仍须独立的进程证明。无法证明停止的原生进程继续占用容量。明确的原生额度错误或原生 HTTP 429 在精确停止后交还 Manager，固定路由不变。

原生终态、最终文本和进程停止证据在发布前持久绑定固定请求。冷读取只验证原证据和不可变 Git 对象，停止或关闭后不会重新启动 CLI、重新派发 prompt 或重建工作树。该入口与 [[codex-runtime]] 的常规项目会话入口各持有自己的原生进程。归档要求由本次结构化会话与原生 thread 的固定记录独立证明进程和后代均已停止，不会连接同项目的共享 app-server。
