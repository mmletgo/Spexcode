---
title: 业务契约细化与追踪
status: pending
hue: 175
desc: 待实现 — 业务契约细化与追踪，证据与产品验收完成前不宣称交付。
related:
  - packages/spec-core/src/specs.ts
---
# 业务契约细化与追踪

## raw source

从用户原意生成可完成主流程、适用状态事件处置、规则和验收；无法确认的重要业务政策成为 GAP，只阻塞依赖分支。

## expanded spec

范围映射：REQ-SYNC-03、04；P1；AC-SYNC-01、02、03、08、14、25。实施依据为 `docs/spec-code-continuous-sync-plan.md`，当前绑定和真实产品证据尚待实现，不能把本节点作为已同步证明。

构建者产出 REQ→FLOW/STEP→RULE/TR→code→AC，独立审查者从原意重新走路径。每个适用状态×事件必须明确转移、拒绝、幂等或有依据的不适用。覆盖权限、边界、竞争顺序与副作用。图和覆盖投影只能派生自 [[sync-contract-schema]]；无状态能力须说明输入域、不变量和不适用依据。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。
