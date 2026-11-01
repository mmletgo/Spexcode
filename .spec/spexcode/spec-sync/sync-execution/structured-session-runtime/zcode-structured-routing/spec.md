---
title: ZCode固定结构化路由回归
status: active
code:
  - spec-cli/src/zcode-structured-routing.test.ts
---
# ZCode固定结构化路由回归

## raw source

明确选择ZCode后应使用自己的固定执行策略及完整MCP读取计划，不能误入Codex执行器。

## expanded spec

覆盖 [[structured-session-runtime]] 的版本4策略、独立realm、完整task冻结、4096字节有界直接MCP计划、无Codex exec计划、已有ref不改与旧Claude/Codex策略保持。仅验证路由和传输计划，不代替真实Native、V1–V4、Docker或产品交付。
