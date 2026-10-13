---
title: Spec 驱动隔离执行与完整交付
status: pending
hue: 175
desc: 待实现 — Spec 驱动隔离执行与完整交付，证据与产品验收完成前不宣称交付。
related:
  - spec-cli/src/spec-body-edit.ts
  - spec-cli/src/sessions.ts
---
# Spec 驱动隔离执行与完整交付

## raw source

合法 Spec 保存后自动补齐逻辑、调用已有 Agent、更新代码和测试，验证成功后交付完整候选。

## expanded spec

范围映射：REQ-SYNC-01、06；P2；AC-SYNC-01、02、03、12、16、17、21、23。实施依据为 `docs/spec-code-continuous-sync-plan.md`，当前绑定和真实产品证据尚待实现，不能把本节点作为已同步证明。

执行前先满足 [[sync-coordination]] 的隔离、generation、范围校验、journal 与回声安全原语。程序限制实际 diff 和适配器写权限，不能只靠提示词。生成失败在有限预算内修复，不改弱原始需求或验收。统一候选含 Spec、代码、测试与映射。协作输入树只回写生成差量并保持用户 index；非协作外部输入树不后台改写，实际受管交付树自动落盘。main dirty 保留完整结果等待落地。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。
