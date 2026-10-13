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
