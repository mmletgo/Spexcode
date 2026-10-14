---
title: spec-body-save-client
status: active
hue: 195
desc: 正文保存携同次请求的稳定幂等身份，按实际回执反馈。
code:
  - spec-dashboard/src/data.js#postSpecBody
related:
  - spec-dashboard/src/ProseActions.jsx
  - spec-dashboard/src/syncApplication.test.mjs
---
# spec-body-save-client

正文保存携同次请求的稳定幂等身份，按实际回执反馈。

每次用户保存携 idempotency-key header；失败重试同payload复用同key，新payload换key。纯Spec模式旧commit回执继续正常反馈；同步模式新回执ok/changed/commit:null/syncOperation只能显示已接入同步操作，不能声称来源正文已commit。
