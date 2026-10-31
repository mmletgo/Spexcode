---
title: 同步总预算判据
status: active
desc: 共享显式有限或无限预算与可空总期限的唯一判据。
code:
  - spec-cli/src/sync/budget.ts
---
# 同步总预算判据

## raw source

总预算无限必须明确表达，不得借Infinity、大数、零值改义或NaN绕过门禁。

## expanded spec

复用 [[sync-operation-types]] 的SyncBudget union。finiteSyncBudget只为原四numeric对象返回有限限制，为精确mode=unlimited返回null；syncDeadlineExpired仅在非null期限到达时返回true。调用方保持实际用量记录及独立单次timeout、租约/控制、资源结算、独审和完整交付门禁。本模块不执行存储或时序副作用，不修改旧预算对象。
