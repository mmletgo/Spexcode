---
title: Dashboard、CLI 与同一应用服务
status: pending
hue: 175
desc: 已提供同一服务的保存、运行、差异、重试和恢复入口；裁决与持续运行等完整产品行为仍待完成。
related:
  - spec-dashboard/src/SpecView.jsx
  - spec-dashboard/src/ProseActions.jsx
---
# Dashboard、CLI 与同一应用服务

## raw source

CLI/HTTP/Dashboard 共享协调应用服务；无浏览器仍持续同步，界面展示真实作用域、状态、证据和裁决。

## expanded spec

范围映射：REQ-SYNC-06、07、08；P1至P5；AC-SYNC-07、21、26、28。实施依据为 `docs/spec-code-continuous-sync-plan.md`。[[sync-application]]、[[sync-cli]] 与 [[sync-operation-panel]] 已共享启用、受控保存、运行、暂停、取消、显式重试、恢复和真实差异读取。业务裁决、无界面的持续观察、迁移回退与成组补偿仍按完整方案继续实现。

首次 enable 说明输入/交付工作树、分支、可写范围与资源。run/status/pause/resume/verify 与取消/裁决使用同一操作。状态显示监听离线、待同步、细化、生成、验证、待输入、冲突、写入、工作树已同步、主分支待落地/已同步、过期、暂停、取消、失败和恢复。显示具体覆盖分子/分母，打开实际产物，键盘可完成操作，动态状态不抢焦点。UI 不自行判断完成。迁移在 worktree 保留原意和节点身份；独立 spec-sync 数据迁移事务失败可回滚，版本回退先结算 journal，保留新增表和证据；撤销使用成组补偿提交，不重写共享历史。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。
