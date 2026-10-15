---
title: 共享独立候选语义审查接缝
status: active
hue: 175
desc: 生成与独立 CI 共用同一结构化候选审查规则和 native 输出绑定。
code:
  - spec-cli/src/sync/candidate-review.ts
related:
  - spec-cli/src/sync/generation.ts
---
# 共享独立候选语义审查接缝

## raw source

本地生成与 CI 重新检查必须沿用同一候选独审协议，不允许新增只返回 passed 的平行语义判定。

## expanded spec

从 [[sync-generation]] 原封提取候选 review schema、基础完整性校验与审查任务指令。接受结论必须精确绑定 inputId/candidateDigest，checkedIds 唯一且覆盖预定完整集合，不含未知项；发现 affectedIds 唯一且属于候选或旧契约，非接受 verdict 必须有对应类型、位置、证据与反例，accept 不能有发现。既有生成流程继续校验构建与评审 session/thread 不同，contract-omission 与 oracle-policy 等专用语义门禁保持原样。

调用既有 runner，核 native session/thread/turn 非空及实际输出摘要；不自行调用模型 SDK、不新建队列或信任本地 passed 标记。完整输入由调用者从不可变对象构造，返回原结构化 review 与真实 trace，不能等同于真实运行或交付完成。
