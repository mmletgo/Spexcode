---
title: 稳定身份引用图与依赖闭包
status: active
hue: 175
desc: 索引跨节点契约身份与引用，区分推导依赖、治理归属和业务导航。
code:
  - packages/spec-core/src/contracts/graph.ts
---
# 稳定身份引用图与依赖闭包

## raw source

一个需求、共享规则与验收可以跨节点追踪；未知政策只影响真正依赖它的业务范围。

## expanded spec

引用种类、身份唯一性及阻塞语义遵循 [[sync-contract-schema]]，不另定义规则或表格。`buildContractGraph` 按同步范围建立稳定 ID、节点归属、来源与 depends-on 索引，重复节点或条目保留明确诊断。`contractReferences` 提供每种引用的目标类型；AC 的业务覆盖与 VERIFY 命令引用分开检查。

推导依赖只含来源和 depends-on，允许业务状态与步骤导航循环。`dependencyClosure` 沿来源、推导依赖、规则使用及 AC 覆盖反向扩散，排除流程归属和 next 导航；因此仅重试政策未知不会顺着导航阻塞成功流程。悬空、类型、循环和归属是否有效由 [[sync-contract-validator]] 检查。
