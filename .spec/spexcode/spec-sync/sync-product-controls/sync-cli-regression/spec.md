---
title: 同步 CLI 回归
status: active
hue: 175
desc: 真实 CLI 子进程验证同服务路由、help 和离线拒绝。
code:
  - spec-cli/src/sync/application-cli.test.ts
---
# 同步 CLI 回归

## raw source

CLI 必须把请求交同一后台服务，不依赖浏览器或用成功输出掩盖离线。

## expanded spec

AC-SYNC-CLI-01 用实际子进程检查阶段 help 与未知 flag/缺参拒绝；02 用本机 HTTP 记录器检查 run/status/show/control 路径、稳定请求键、节点引用归一化及 targetTree；03 检查离线非零退出、无成功 stdout。记录器仅证明客户端运输，不替代 [[sync-application-regression]] 的 SQLite/Git pipeline 或最终模型验收。
