---
title: 路径治理归属判定
status: active
hue: 175
desc: 规划、分区和细化范围共用冻结路径的纯归属判定。
code:
  - spec-cli/src/sync/governance-owners.ts
related:
  - spec-cli/src/sync/partitioning.test.ts
  - spec-cli/src/sync/planning.test.ts
  - spec-cli/src/sync/elaboration-target-binding.test.ts
---
# 路径治理归属判定

## raw source

规划、分区和细化范围应复用相同的当前及历史冻结治理归属；related关联不能授予owner或写权。纯归属判定不依赖分区装配、配置或细化schema。

## expanded spec

`ownerNodesForPath`从精确路径、冻结Contract集合及只含id、path、code的治理节点返回owner ID集合，不读取文件、不修改输入、不维护第二份图。Spec自身路径、节点code绑定、非VERIFY项的真实code来源以及AC.test绑定均参与归属；VERIFY和related不授予归属。

代码引用及路径覆盖复用spec-core现有parseCodeEntry和relationClaimsPath。[[sync-application-planning]]、[[sync-partitioning]]及[[elaboration-markdown]]直接调用同一实现；归属结果仍由各调用方既有范围和授权门禁消费，不能单凭owner取得新写权。
