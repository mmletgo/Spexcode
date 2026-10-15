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

`spex sync settings|enable|status|run|verify|decide|show|pause|resume|cancel|recover` 通过 clientSyncRequest 调后端 [[sync-application]]，请求携带 cwd 项目的 targetTree，由后端持有 pipeline 生命周期。mutator 复用项目匹配 guard 和显式 API 路由；不可达或 HTTP 拒绝非零退出，不使用 cached/mock fallback。结果输出 JSON，queued、failed、GAP 及原树待落地不能用成功文案掩盖。

run 接收 node-id 或 --node，--request-id 提供稳定键，缺省一次 UUID。--patch-file 是 UTF-8 JSON SpecBodyEdit，复用正文校验。status 支持 --node 和 1..200 的 --limit；show/cancel/recover 需要完整 operation ID，pause/resume 可省略ID控制物理来源。未知 flag/缺值拒绝。enable 可用 --config-digest 检查并发配置变化。help 明确手动 Spec/代码驱动、业务裁决与 Docker Node 验证，已启用来源由正式后端独立持续观察。

--retry-of 显式引用旧 operation ID，由共享服务检查 retryEligibility 后建立关联的新操作及新预算；不带此参数的重复输入不重置预算。不能与 --patch-file 同用，重试保留旧正文意图和 origin；CLI 不传固定 spec 覆盖旧 initial 来源。同重试 request-id 幂等，服务拒绝未结算资源或已变输入时非零退出。

recover 提交完整旧 operation ID 到同后端清理入口；保持原控制与预算，只结算已有资源/已开始日志，不等同 resume 或新预算重试。返回真实状态和尚未知资源的诊断，不把 HTTP 受理称为资源已释放。

--retry-of 只属于 run；放在 recover 或其它控制命令上明确拒绝，不能静默忽略而混淆清理与新预算。


P3增加run --origin spec|initial|code|combined与decide。decide接受完整operation ID、原input-id、可信analysis hash、逗号分隔findings、keep_intent/adopt_behavior/new_rule choice、稳定request-id；new_rule必须带非空rule。裁决选项不能放其它命令，rule不能放其它choice，origin只属run；HTTP共享应用校验具体身份、scope和stale，不由CLI自行授权。help诚实说明手动代码接入和三种裁决已提供，后台watcher属于后端生命周期。

P4 增加无operation参数的 pause/resume，调用 /automatic/pause|resume 物理输入门禁；带完整ID仍只控制指定操作。verify <node-id> 调 /verify 沿同一真实完整管线，status查询后台实际监听/快照/差异。enable 后服务保存即观察，CLI离线仍非零退出。

--node只用于run/verify/status，不能在pause/resume上静默扩大为整个物理来源；--patch-file只用于run，verify不能默默忽略正文请求。非法组合必须在发送HTTP前明确拒绝。

`spex sync check` 在普通后端命令解析前路由到 [[sync-conformance-cli]]；这是显式基线、候选与可信政策的独立重验，不调用后端或修改同步状态。顶层保留真实检查退出码。

`spex sync revert <operation-id> [--request-id <id>]` 明确请求撤销已采纳的完整交付，由同一应用资格检查和成组补偿管线建立新操作；稳定请求键幂等，CLI不直接reset、改源文件或假造已落地。`spex sync stop-writer` 不接操作ID或请求键，暂停物理来源、停止新派发并结算或保留实际资源/journal，返回恢复诊断；stopped只指停写入口，不能解释为所有未知原生资源已释放。两者沿既有targetTree/后端路由与拒绝退出码，帮助页说明其语义。

独立check的help与guide说明受信policyCommit中的原意精确登记、null新增删除、移动双登记及失败摘要；外部调用方负责选择受信政策并配置必需检查，授权不豁免独审/VERIFY/oracle。
