---
title: 跨冻结影响原件回归
status: active
hue: 175
desc: 检查完整 Git 差量、独立 Native 回执和只读冷恢复的证据约束。
code:
  - spec-cli/src/sync/cross-freeze-impact-review.test.ts
---

## raw source

跨冻结复核须逐路径覆盖实际 Git 差量，原件可冷恢复。独立会话与真实只读 Git 结果须可验证。

## expanded spec

[[cross-freeze-impact-review]] 回归使用真实 Git 和受控 Native 独审，核对读集外路径、模式与内容变化、删除及新增、空差量历史、文件原件与正式结算身份。冷恢复还须重建完全一致的请求，拒绝变化的作用域和可写 seed，原 Git 引用保持。
