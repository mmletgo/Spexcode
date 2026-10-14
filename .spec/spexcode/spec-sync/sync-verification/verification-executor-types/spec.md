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

`VerificationRequest` 绑定 runId、inputDigest、candidateDigest、candidateExportDigest、export 目录、用户私有 scratch root、可信政策、取消信号及可选 previousCheckpoint。`verificationExportDigest` 提供独立 export 字节摘要；业务候选摘要仍由上层统一定义。

`VerificationPolicy` 冻结镜像摘要、Linux 平台、Node 测试 argv、仓库相对 cwd、必需稳定 testID 和资源预算；不接受候选自定义政策。cwd 为 `.` 或候选内部的规范目录，不允许上跳；testID 是测试标题开头的无空白标识，允许既有测试命名，不要求与业务 AC 的 ID 同名。`VerificationCheckpoint` 按 planned/created/terminal/removed 保存唯一名字、labels、实际 configDigest、私有副本、截止时间、actual container ID、inspect 和终态证据。`onCheckpoint` 返回成功才获得继续副作用的许可，失败保留已持久阶段供恢复。

`VerificationEvidence` 保存输入/候选/export/政策摘要、Docker 平台/镜像实际 ID/daemon 版本、真实 exitCode、stdout/stderr、截断标记、完整报告标志、稳定 testID 的 passed/failed/skipped、未匹配 ID、终态 inspect 与结果。`VerificationResult` 明确 passed/failed/cancelled/timeout/unsupported/recovery_required；运行证据不是完整产品已同步的声明。上层据 recovery_required 保留执行容量并重新传递同一检查点，终态后再结算容量。
