---
title: 行为验证检查点与证据类型
status: active
hue: 175
desc: 自包含的可信政策、检查点、真实行为证据和恢复接口。
code:
  - spec-cli/src/sync/verification-executor-types.ts
---
# 行为验证检查点与证据类型

## raw source

执行器与协调存储之间通过明确的检查点和真实证据交接；调用者负责持久化，不另建执行数据库。

## expanded spec

远端新增 verification-checkpoint-v2，固定 SSH target、远端 root/daemon 身份、真实挂载路径、物化认证、固定 effect IDs/request digests 及 closed/cleanup 观察，仍按 planned/created/terminal/removed 由同一 ledger 持久。not-created terminal 明确 cancelled/timeout 及原关闭/不存在观察，没有真实容器时不生成 VerificationEvidence。旧 v1 请求/checkpoint 原字段与本地绑定保持，不从当前 SSH 配置追补。

transport 配置只来自可信 server 注入，不进入模型可写的 VerificationPolicy。每个 execute/recover 使用独立 per-run adapter，不能共享 mutable currentPlan。原 VerificationDriver 仍是本地测试故障接缝。日志传输可 lossless gzip，但预算按压缩前 bytes，解压后原 stdout/stderr SHA 与长度须匹配，真实 inspect 不改写。

`VerificationRequest` 绑定 runId、inputDigest、candidateDigest、candidateExportDigest、export 目录、用户私有 scratch root、可信政策、取消信号及可选 previousCheckpoint。`verificationExportDigest` 提供独立 export 字节摘要；业务候选摘要仍由上层统一定义。

`VerificationPolicy` 冻结镜像摘要、Linux 平台、Node 测试 argv、仓库相对 cwd、必需稳定 testID 和资源预算；不接受候选自定义政策。cwd 为 `.` 或候选内部的规范目录，不允许上跳；testID 是测试标题开头的无空白标识，允许既有测试命名，不要求与业务 AC 的 ID 同名。`VerificationCheckpoint` 按 planned/created/terminal/removed 保存唯一名字、labels、实际 configDigest、私有副本、截止时间、actual container ID、inspect 和终态证据。`onCheckpoint` 返回成功才获得继续副作用的许可，失败保留已持久阶段供恢复。

`VerificationEvidence` 保存输入/候选/export/政策摘要、Docker 平台/镜像实际 ID/daemon 版本、真实 exitCode、stdout/stderr、截断标记、完整报告标志、稳定 testID 的 passed/failed/skipped、未匹配 ID、终态 inspect 与结果。`VerificationResult` 明确 passed/failed/cancelled/timeout/unsupported/recovery_required；运行证据不是完整产品已同步的声明。上层据 recovery_required 保留执行容量并重新传递同一检查点，终态后再结算容量。

政策的可选布尔 `scratchExecutable` 缺省为 false，仅显式 true 允许独立 V3 容器私有 `/tmp` tmpfs 执行；由可信 `RegisteredVerification.environment` 继承并随政策摘要冻结。该字段不改变只读输入、宿主权限或生产候选隔离。
