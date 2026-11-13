---
title: 同步 CLI
status: active
hue: 175
desc: 无浏览器提交与控制真实后端操作，离线明确失败。
code:
  - spec-cli/src/sync-cli.ts
related:
  - spec-cli/src/help.ts
---
# 同步 CLI

## raw source

无 Dashboard 时仍能启用、执行、查询和控制同步；CLI 不静默 mock，不只打印 proposal，也不退出后丢掉长流程。

## expanded spec

`spex sync run` 可将 `--inherit-retry-budget` 与 `--retry-of`、`--model` 合用，向正式后端提交原候选续审交接。保留原预算族、已用调用与截止时间。普通的暂停和恢复沿原模型。

`spex sync source-continuity <operation-id> --input-id <id> --revision <N> --enabled-digest <sha256> --old-common-dev <N> --old-root-dev <N> --old-git-dev <N>` 是 [[sync-source-registration]] 的正式offline入口，拒绝API路由和多余业务选项，缺值/错配非零退出。不调用HTTP或启动服务，成功输出真实proof引用与pause，重复登记不重复派发。文档要求停稳及先结算资源，v20配套备份/启用原件回滚；resume为后续明确控制。

`spex sync settings|enable|status|run|verify|decide|show|pause|resume|cancel|recover` 通过 clientSyncRequest 调后端 [[sync-application]]，请求携带 cwd 项目的 targetTree，由后端持有 pipeline 生命周期。mutator 复用项目匹配 guard 和显式 API 路由；不可达或 HTTP 拒绝非零退出，不使用 cached/mock fallback。结果输出 JSON，queued、failed、GAP 及原树待落地不能用成功文案掩盖。

run 接收 node-id 或 --node，--request-id 提供稳定键，缺省一次 UUID。--patch-file 是 UTF-8 JSON SpecBodyEdit，复用正文校验。status 支持 --node 和 1..200 的 --limit；show/cancel/recover 需要完整 operation ID，pause/resume 可省略ID控制物理来源。未知 flag/缺值拒绝。enable 可用 --config-digest 检查并发配置变化。help 明确手动 Spec/代码驱动、业务裁决与 Docker Node 验证，已启用来源由正式后端独立持续观察。

--retry-of 显式引用旧 operation ID，由共享服务检查 retryEligibility 后建立关联操作。普通显式重试使用新预算，候选续审交接沿用原预算族；重复输入沿既有操作。不能与 --patch-file 同用，重试保留旧正文意图和 origin；CLI 不传固定 spec 覆盖旧 initial 来源。同重试 request-id 幂等，服务拒绝未结算资源或已变输入时非零退出。

recover 提交完整旧 operation ID 到同后端清理入口；保持原控制与预算，只结算已有资源/已开始日志，不等同 resume 或新预算重试。返回真实状态和尚未知资源的诊断，不把 HTTP 受理称为资源已释放。

--retry-of 只属于 run；放在 recover 或其它控制命令上明确拒绝，不能静默忽略而混淆清理与新预算。


P3增加run --origin spec|initial|code|combined与decide。decide接受完整operation ID、原input-id、可信analysis hash、逗号分隔findings、keep_intent/adopt_behavior/new_rule choice、稳定request-id；new_rule必须带非空rule。裁决选项不能放其它命令，rule不能放其它choice，origin只属run；HTTP共享应用校验具体身份、scope和stale，不由CLI自行授权。help诚实说明手动代码接入和三种裁决已提供，后台watcher属于后端生命周期。

P4 增加无operation参数的 pause/resume，调用 /automatic/pause|resume 物理输入门禁；带完整ID仍只控制指定操作。verify <node-id> 调 /verify 沿同一真实完整管线，status查询后台实际监听/快照/差异。enable 后服务保存即观察，CLI离线仍非零退出。

--node只用于run/verify/status，不能在pause/resume上静默扩大为整个物理来源；--patch-file只用于run，verify不能默默忽略正文请求。非法组合必须在发送HTTP前明确拒绝。

`spex sync check` 在普通后端命令解析前路由到 [[sync-conformance-cli]]；这是显式基线、候选与可信政策的独立重验，不调用后端或修改同步状态。顶层保留真实检查退出码。

`spex sync revert <operation-id> [--request-id <id>]` 明确请求撤销已采纳的完整交付，由同一应用资格检查和成组补偿管线建立新操作；稳定请求键幂等，CLI不直接reset、改源文件或假造已落地。`spex sync stop-writer` 不接操作ID或请求键，暂停物理来源、停止新派发并结算或保留实际资源/journal，返回恢复诊断；stopped只指停写入口，不能解释为所有未知原生资源已释放。两者沿既有targetTree/后端路由与拒绝退出码，帮助页说明其语义。

`spex sync adopt <operation-id>` 将已验证且结算的交付交给 [[sync-source-adoption]] 采纳，只传当前 targetTree 和完整操作身份，不由 CLI 执行 Git。无参数或多余操作参数在 HTTP 前拒绝；后端资格不满足时非零退出并保留具体原因。成功输出仍区分 sourceSynced 与 canonicalSynced，不把工作树交付当作主分支完成。

帮助说明 [[sync-application]] 会按新操作的冻结政策自动采纳已启用主来源的完整结算交付，显式 adopt 仍提供同一正式采纳入口。

独立check的help与guide说明受信policyCommit中的原意精确登记、null新增删除、移动双登记及失败摘要；外部调用方负责选择受信政策并配置必需检查，授权不豁免独审/VERIFY/oracle。

run/verify 接收 --model 并传给正式 HTTP 应用；控制/恢复命令遇到该 flag 明确拒绝。help/guide说明新业务操作显式模型覆盖版本化 `sync.model`，无 prior/retry 时以项目值或 sol 为默认；同 request ID 保持原模型，换模型必须使用 retryOf，合法省略 retry 继承原选择，遵循 [[sync-model-selection]]。

spex sync resources recover <operation-id> --input-id <frozen-input-id>是显式单次离线资源入口，直接调用同一resources-only应用，不启动API、watcher或automatic queue；不接受模型、retry、业务request或HTTP选项。必须提供精确旧输入身份，当前canonicalRoot/commonDir核对仍执行；只输出资源结算及未决journal摘要。busy/资源未证实停止时非零退出并保留资源。普通recover仍走后端且可能恢复已开始journal，语义不变；离线资源清理不表示resume、adopt、业务通过或可忽略source身份变化。

run --origin initial --committed 显式选择实际提交 HEAD。CLI 只对新的 initial 请求发送布尔 committed，遇到其它命令、正文 patch 或 retryOf 时在 HTTP 前拒绝。

仅 `run --record-unverified-coverage` 可显式登记未执行覆盖。后端核实操作为代码→规格且已有可信保护测试。普通 `verify` 和独立 `check` 沿默认严格规则，`show` 在正式验证通过后显示未执行的契约 ID。
