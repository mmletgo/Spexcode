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
