---
title: 契约阅读作用域
status: active
hue: 175
desc: 节点筛选保留跨节点对象矩阵、GAP 依赖及结构发现。
code:
  - spec-dashboard/src/syncContractModel.js
related:
  - spec-dashboard/src/syncContractModel.test.mjs
---
# 契约阅读作用域

## raw source

查看单一契约节点时，仍能理解关联对象的完整状态事件处置和其他节点 GAP 对当前节点的影响。

## expanded spec

为 [[sync-contract-panel]] 筛选后端报告。正文条目和绑定按 nodeId 筛选，对象矩阵保留所选条目关联对象的全部单元，转移及 GAP 原始条目可跨节点查找。GAP 按服务端 nodeIds 影响范围及所在节点保留；结构发现保留当前节点、关联 GAP 及无 nodeId 的工作树边界错误。全部节点筛选原样保留所有数据。未启用旧节点返回无面板；解析失败的启用节点保留其 findings。此模型不重算 coverage、不产生运行验证结论。
