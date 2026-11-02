---
title: 同步检查点的 JSON 与不可信原文边界
status: active
code:
  - spec-cli/src/sync/checkpoint-evidence.ts
---

## raw source

结构化输出失败的原文必须完整可查并可续修，但不能被当作可信阶段或业务结果；真正损坏的阶段证据必须显式失败。

## expanded spec

新SyncCheckpointRef在一次正常store动作中登记JSON wrapper与全部typed artifacts，保留原resultRef、JSON材料及精确UTF8 raw引用，避免中间出现无认证来源的raw pin。raw即使是合法JSON或形似sync-stage-v1也不取得stage、candidate、review或证据引用可达权限。

旧无role checkpoint引用逐字保留。只沿真实wrapper及失败Saved round（含既有repairDiagnostics原件）认证untrusted_final：原operation/attempt/input、owner及完整NativePlan/dispatch、资源原failed观察、canonical record的原策略/model/请求/错误/原文和thread/turn必须精确一致，CAS正文与SHA/ref相同。后续正式cancelled/removed保原格式错误与原文，且精确nativeStopped/stopped证明成立时仍可读；不复原旧failed或改签成功。generic failed的合法raw可读性不授予格式自动续修资格。

先收集认证结果再赋予JSON材料阶段权限；历史flat材料的解析错误只在精确强失败来源证明其为raw时豁免，任何未认证SyntaxError仍抛出，role本身不能隐藏坏材料。全部协调stage扫描与应用证据BFS共用该边界；raw只返回明确untrusted_final/text/SHA投影，不解析或追踪其正文中的伪引用。旧业务输入/授权/schema/只读范围与预算、调用、停止和交付门保持。

partitionEvidence容器中的rounds是原局部结果的副本，不能以聚合的inputDigest/failure替原owner认证。读取先核唯一partitionId与原local绑定、完整rounds按引用顺序精确拼接；全局partitioned_final重算同planDigest及各local输入摘要，早退单local容器保原binding/inputDigest。随后仅沿各原resultRef执行既有完整Native强认证；嵌套refinement.prior/repair-input沿同一机制，错ref、错输入、删改重排round或重复owner均显式失败。

同一原Native强认证接缝也供精确code_review格式续审的原result/plan/checkpoint引用读取复用，核原canonical record、请求/schema/prompt/模型、失败身份及停止状态；不新增raw role或平铺pin，不给旧缺席补ref，不解析原文取得stage、accept或业务权限。
