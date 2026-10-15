---
title: 同步应用政策范围回归
status: active
hue: 175
desc: 用真实Git与旧政策基线证明独立验证政策按影响范围执行，保护oracle不被削弱。
code:
  - spec-cli/src/sync/planning.test.ts
---
# 同步应用政策范围回归

## raw source

同一项目配置的独立节点各自验证，不因别的节点未进入候选上下文而失败，也不能以缩范围为由删除保护测试、弱化命令或逃避退役验收。

## expanded spec

回归 [[sync-application-planning]] 的精确政策选择。真实Git夹具包含两个独立Spec、源码、VERIFY与不可写mandatory oracle；A计划只执行A政策，B不进入A的读取、执行或验证覆盖。候选实际硬门禁仍拒绝删除/改写oracle与删除/弱化VERIFY。

A仅引用B规则或显式readonly上下文纳入B Spec时，B整Spec作为readonly上下文包含真实VERIFY，仍精确登记该定义满足候选检查，但不因此执行无关B mandatory或授B写范围。真实store admission、candidate、verification、journal、receipt、settlement建立旧基线后，删除当前A owner仍从旧政策并集保留原命令及oracle，不能删除owner规避保护。Git对象、store动作和receipt真实，四层验证明确fake，不是native或Docker产品验收。

没有任何真实owner的预登记定义和mandatory继续保留，供纯raw细化或由严格门禁暴露缺口；坏schema/未支持命令不能被范围筛选吞掉。此回归不运行整个仓库测试或native。
