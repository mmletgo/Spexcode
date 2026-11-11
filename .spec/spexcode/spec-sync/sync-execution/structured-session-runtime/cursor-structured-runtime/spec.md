---
title: Cursor CLI 原生工作树执行
status: active
code:
  - spec-cli/src/cursor-structured.ts
related:
  - spec-cli/src/cursor-structured.test.ts
---

# Cursor CLI 原生工作树执行

## raw source

SpexCode 优先使用本机 Cursor CLI 进行 Spec 与代码同步。用户沿用 CLI 已有的认证、连接和模型配置，也可以显式选择 Cursor CLI 支持的模型。

## expanded spec

`cursor:default` 沿用 Cursor CLI 的原生配置。`cursor:<模型或别名>` 的模型参数原样交给 CLI。[[structured-session-runtime]] 在托管工作树中启动 Cursor ACP stdio，每轮新建独立会话，启动目录与 `session/new.cwd` 一致。只读阶段确认会话处于 Cursor 的 `ask` 模式后才发出任务，必要时先发出 ACP 模式切换请求。编辑阶段在托管工作树内授权编辑和验证，正常 Git 交付由 [[native-worktree-runtime]] 核验。适配器沿用 CLI 的现有认证，不发起登录或新增 MCP 授权。

运行记录绑定固定请求、实际 CLI 版本、工作树、原生会话 ID 和客户端生成的 prompt 请求 ID。原生协议报告模型时保留其原值。同一会话最后一次工具活动后的 assistant 文本，随原请求的唯一成功响应结束并通过冻结 JSON schema。原生终态后关闭 ACP 输入，必要时按原启动凭据主动关闭服务。只有证明 CLI 及相关进程已停止才交付结果。格式不合格的已停止输出可交给后续修复。冷读取复验原件，未知终态禁止重发。

取消时先向在用会话发出 ACP 取消通知，并核对原 prompt 的取消响应。正式停止还需独立确认进程组及相关进程结算。无法证明停止时保持待结算。

运行中周期进程观察暂时不可用时，沿用 [[native-worktree-runtime]] 的单个绝对恢复窗口，在同一会话内串行复验。原终态或正式取消优先，迟到的周期观察不得改变其结算。窗口耗尽或遇到非暂态错误时关闭原轮，按新鲜停止证明将其记录为已结算失败或待结算。恢复与结算均禁止重发任务。

进入终止窗口后，在原绝对截止内复验暂态停止观察故障。结果仍以原 ACP 终态和新鲜停止证明为准。
