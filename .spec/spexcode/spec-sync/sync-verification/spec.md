---
title: 四层验证、证据与严格完成门禁
status: pending
hue: 175
desc: 本地四层验证与跨机器新旧闭包重验已实现；远端必需检查及完整真实产品验收仍待完成。
related:
  - packages/spec-core/src/evidence.ts
  - spec-cli/src/lint.ts
---
# 四层验证、证据与严格完成门禁

## raw source

只有当前实际候选满足结构、语义、运行和版本交付检查，才能显示范围已同步。

## expanded spec

范围映射：REQ-SYNC-08；P1至P5；AC-SYNC-13、14、21、22、23、25、27。实施依据为 `docs/spec-code-continuous-sync-plan.md`。[[sync-frozen-contracts]]、[[sync-generation]]、[[verification-executor]] 与 [[sync-coordinator]] 已绑定当前候选的本地四层结果；[[sync-conformance]] 从真实Git对象重算完整新旧影响闭包，[[sync-conformance-ci]] 只运行受保护目标校验器；远端必需检查设置与完整真实产品验收仍须交付，不由本地阶段结果推断全项目完成。

V1 检查 ID/引用/锚点/可达性/事件处置；V2 独立审查原意、遗漏与冲突；V3 真正运行 AC 绑定命令并保存结果；V4 校验当前内容、上层规则、依赖、工具和交付身份。完成要求最新输入已落盘、无阻断 GAP/冲突、完整映射与适用 AC、实际测试和独立审查通过、证据有效且 journal 结算。Agent 宣称、lint、Spec-OK 或 hash 均不能单独证明完成。可信目标政策以基线与候选范围并集设门禁；候选删除 schema/AC 或改命令不能免检。CI 在真实候选重跑，未纳入范围明确显示。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。
