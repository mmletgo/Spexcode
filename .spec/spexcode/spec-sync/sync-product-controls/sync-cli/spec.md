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

`spex sync settings|enable|status|run|show|pause|resume|cancel|recover` 通过 clientSyncRequest 调后端 [[sync-application]]，请求携带 cwd 项目的 targetTree，由后端持有 pipeline 生命周期。mutator 复用项目匹配 guard 和显式 API 路由；不可达或 HTTP 拒绝非零退出，不使用 cached/mock fallback。结果输出 JSON，queued、failed、GAP 及原树待落地不能用成功文案掩盖。

run 接收 node-id 或 --node，--request-id 提供稳定键，缺省一次 UUID。--patch-file 是 UTF-8 JSON SpecBodyEdit，复用正文校验。status 支持 --node 和 1..200 的 --limit；show/control 需要完整 operation ID。未知 flag/缺值拒绝。enable 可用 --config-digest 检查并发配置变化。help 明确 P2 Spec 驱动与 Docker Node 验证，P3/P4 双向和外部持续监听尚未交付。

--retry-of 显式引用旧 operation ID，由共享服务检查 retryEligibility 后建立关联的新操作及新预算；不带此参数的重复输入不重置预算。不能与 --patch-file 同用，重试保留旧正文意图和 origin；CLI 不传固定 spec 覆盖旧 initial 来源。同重试 request-id 幂等，服务拒绝未结算资源或已变输入时非零退出。

recover 提交完整旧 operation ID 到同后端清理入口；保持原控制与预算，只结算已有资源/已开始日志，不等同 resume 或新预算重试。返回真实状态和尚未知资源的诊断，不把 HTTP 受理称为资源已释放。

--retry-of 只属于 run；放在 recover 或其它控制命令上明确拒绝，不能静默忽略而混淆清理与新预算。
