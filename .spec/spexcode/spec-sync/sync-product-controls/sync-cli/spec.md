---
title: 同步 CLI
status: active
hue: 175
desc: 无浏览器提交与控制真实后端操作，离线明确失败。
code:
  - spec-cli/src/sync-cli.ts
---
# 同步 CLI

## raw source

无 Dashboard 时仍能启用、执行、查询和控制同步；CLI 不静默 mock，不只打印 proposal，也不退出后丢掉长流程。

## expanded spec

`spex sync settings|enable|status|run|show|pause|resume|cancel` 通过 clientSyncRequest 调后端 [[sync-application]]，请求携带 cwd 项目的 targetTree，由后端持有 pipeline 生命周期。mutator 复用项目匹配 guard 和显式 API 路由；不可达或 HTTP 拒绝非零退出，不使用 cached/mock fallback。结果输出 JSON，queued、failed、GAP 及原树待落地不能用成功文案掩盖。

run 接收 node-id 或 --node，--request-id 提供稳定键，缺省一次 UUID。--patch-file 是 UTF-8 JSON SpecBodyEdit，复用正文校验。status 支持 --node 和 1..200 的 --limit；show/control 需要完整 operation ID。未知 flag/缺值拒绝。enable 可用 --config-digest 检查并发配置变化。help 明确 P2 Spec 驱动与 Docker Node 验证，P3/P4 双向和外部持续监听尚未交付。
