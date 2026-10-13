---
title: 结构化推理固定只读策略
status: active
hue: 175
desc: 独立清洁 Codex 配置及经过探针验证的外层隔离，禁止继承宽松 launcher、shell、MCP、apps 与 hooks。
code:
  - spec-cli/src/session-structured-policy.ts
related:
  - spec-cli/src/session-structured.test.ts
  - spec-cli/src/codex-runtime-generations.ts
---
# 结构化推理固定只读策略

## raw source

生成和独立审查只能读取协调器提供的冻结上下文并返回 JSON。Agent 不能修改源码、交付树或用户配置；没有安全能力时明确失败，不能退回宽松执行。

## expanded spec

内部固定策略为 codex-read-only-v1。独立 CODEX_HOME 仅包含可信配置及既有认证文件的只读安全引用；不读取、复制或打印认证字节，不继承用户 config 或 launcher 的 yolo/bypass 权限。配置关闭 shell、code mode、多 Agent、MCP、apps、plugins、hooks 和 web search；在模型 turn 前检查有效只读/never 策略、禁用特性以及零 MCP/hook 工具。

macOS 外层 Seatbelt 对 app-server 及全部后代实施写入限制。runtime 的 rollout/cache 可以写入，coordinator 控制文件、固定 config/auth 引用、源码树、交付树与用户配置保持不可写。原生 daemon 仅获准写本 generation 的精确 socket/lock 和日志，不放开整个共享 socket 目录。启动前必须真实 probe 运行目录可写且外部文件不可写。

Codex 原生 readOnly 策略保留，P1 使用提供正文的纯推理，不依赖嵌套 sandbox 中的 shell。新旧 generation 继续复用现有持久 ledger 和 detached receipt。未验证等效隔离的平台返回 unsupported，P4/P5 继续建设与验证；安全预检失败不得 fallback，也不能当作已完成同步。
