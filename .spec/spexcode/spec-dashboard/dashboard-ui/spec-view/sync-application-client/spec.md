---
title: sync-application-client
status: active
hue: 195
desc: 同步客户端读取真实应用回执、保护请求身份和完成状态。
code:
  - spec-dashboard/src/syncApplication.js
related:
  - spec-dashboard/src/data.js
  - spec-dashboard/src/syncApplication.test.mjs
---
# sync-application-client

同步客户端读取真实应用回执、保护请求身份和完成状态。

使用现有项目 API 前缀和 targetTree 路由。status/settings/run/control/evidence 直接传递实际应用错误的 code/message；不吞成空操作。相同用户 payload 在失败重试中保留 UUID，新 payload 换 UUID。前端只有一个真实回执投影：stale/失败/缺口/恢复诊断都不能绿色显示已同步，未 settled 的 deliveryPlan 也不能生成文档链接。证据只呈现业务诊断与文件/验证事实，代理 prompt 和输出正文不直接 dump。

activation=invalidated 也使旧receipt不能投影为当前已同步，保留可读的历史交付链接但强制真实失效诊断。enabled=false本身不证明可退回Spec-only模式，必须区分disabled与invalidated。

非2xx且非JSON的服务错误显示HTTP状态与最多500字符的服务诊断，不能将JSON解析异常冒充业务失败原因。

显式终态重试发送retryOf与旧origin，不能把新patch混入重试；应用复用旧用户意图并确认当前input/policy及资源结算门禁，客户端只依据实际retryEligibility开放重试。普通来源同步不发送retryOf。

资源恢复资格只由真实recovery_required与未结算resources/journals共同决定，发送recover控制不附新请求/预算。请求证据投影保留用户origin.intent与实际path，原Git对象/代理prompt不直接dump；请求diff透传kind=request，不能改成候选或交付读取。


decideSync直接传原operation ID、inputId、analysisRef、选中finding IDs及用户choice/rule到共享decide HTTP入口；保持payload幂等键与原错误code/message，不混成retry或SpecBodyEdit。业务分析证据投影保具体路径、原意、双方行为、反例；裁决投影保选择/新规则/所选项/原operation身份，不泄露prompt。

Detail.decisionEligibility 是服务端始终返回的裁决资格；syncProjection 的 canDecide 仅在该 eligible 为真且非 stale、非 recovery_required、授权未 invalidated 时开放。前端不重算 phase、attempt、资源或 journal 的裁决算法；早期 conflict 证据不代表当前可提交裁决。

automaticControl(action, targetTree) 只把 pause/resume 发送到既有 `/api/sync/automatic/{action}` 物理控制入口，经现有 targetTree URL helper 传递工作树且不附 operation ID；面板仅从 enabled 的默认来源视图调用，所有 targetTree 视图由面板Spec保持只读。返回实际 observation；非成功响应继续透传 code/message。syncObserverProjection 整理 health.watchOnline/status/lastScanAtMs、物理控制、真实 coverage 数组、最近 observation 的 baseline selection 和 status.sources 物理来源摘要供界面显示：persistedHealth 和更新时间不能生成在线或扫描结论，baseline 汇总明确限于 latestDifference.nodeId，不能补造项目级 per-node 结果。来源列表从 source.watchOnline 判断在线，并且只读。

readSyncStatus 要求实际 settings、operations、observation 和 sources 结构；HTTP 成功但缺少同步 UI 必需字段时返回可重试的 sync_response_invalid，不能让缺字段被解释为空覆盖或离线状态。
