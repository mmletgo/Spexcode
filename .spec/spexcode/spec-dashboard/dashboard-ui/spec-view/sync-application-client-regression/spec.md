---
title: sync-application-client-regression
status: active
hue: 195
desc: 同步回执、证据摘要和稳定请求的针对性回归。
code:
  - spec-dashboard/src/syncApplication.test.mjs
related:
  - spec-dashboard/src/syncApplication.js
  - spec-dashboard/src/data.js
---
# sync-application-client-regression

同步回执、证据摘要和稳定请求的针对性回归。

验证 settled/current receipt 的唯一完成门、stale/failed/needs_input/recovery禁止成功、私有树不可阅读、暂停恢复取消可用状态、重复保存/同步身份稳定、真实结构错误透传、过时读取Abort不重试，以及GAP证据不泄露代理prompt。纯fixture/transport测试不冒充真实HTTP或LLM产品验收。

候选/交付代码及测试diff保持path、kind和targetTree；超过限额的413保留原错误，不截断或空白伪装为成功。

即使存在已结算receipt，activation invalidated仍拒绝当前同步完成投影。

显式终态重试保旧操作origin/retryOf且不携新patch；来源变化后的普通请求不携retryOf。

恢复资格须有真实待结算副作用，recover请求不发新预算；请求证据可读用户原意，request diff保实际kind/path，未交付不能画成功。


裁决客户端验证原operation/input/analysis/selected findings和稳定请求正文完整透传，与retry/patch明确分离；证据投影保新规则并排除prompt。

裁决资格投影回归验证在途 P1 虽有 early conflicted reason，服务端 eligible=false 仍禁写；已结算 failed/budget_exhausted、conflicted、needs_input、superseded 的 eligible=true 可开放。stale、资源恢复或 invalidated 始终覆盖真实资格并禁用，不以 JSX 字串或模拟截图冒充交互验收。

物理自动 pause/resume transport 核对 endpoint、targetTree query 和空请求体，并保留后端控制错误码/消息。HTTP 200 缺少 settings/operations/observation/sources 时 readSyncStatus 返回可重试错误。观察器投影分别覆盖 live online、离线/退化/缺失/失效、持久 watching 但身份未确认、无状态数据、真实补偿扫描时间、项目 coverage 分母与原始节点集合；status.sources 必须按 physical root 对应真实状态，不能把失联的持久 watching 显示为在线，baseline 数只对应最近观测节点，selection 无效时不当作零缺失或全项目结论。

回归覆盖 canonicalSynced/sourceSynced 的分别显示、canonical_synced 仍可作为新输入、source stale 时 backend eligible 仍开放成组撤销但 recovery/invalidated 关闭。Revert transport 失败后稳定 requestId 不变，并校验 response operation；stop-writer transport 保持物理 action scope、pause control 与恢复 operations 子集响应。真实 UI 验收须确认恢复子集不替换历史列表，暂停写入与单项取消文案/行为分离。
