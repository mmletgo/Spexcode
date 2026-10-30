---
title: 持续同步产品边界与验收方案
status: active
hue: 175
desc: 九项需求与二十八项最终验收的唯一产品方案，明确授权、运行及交付边界。
code:
  - docs/spec-code-continuous-sync-plan.md
---
# 持续同步产品边界与验收方案

## raw source

P0至P5按完整需求交付，不以阶段演示、局部测试或可修改的通过记录替代最终验收；产品授权和操作入口必须与实施契约一致。

## expanded spec

自动事件边界为 SpexCode 页面保存 Spec，或外部编辑后形成的真实 Git 提交。未提交保存与暂存不启动模型；提交树输入排除同期工作区编辑。Spec 变化驱动代码，代码提交只驱动对应 Spec，不自动修写代码或测试；组合提交和真实冲突仍按既有意图/裁决规则处理，已结算同步提交按 receipt 与实际基线去回声。

首次建档和增量同步均先按归属、写文件及依赖规划分区，再由多个独立上下文读取本区完整资料。完整覆盖由分区及跨区接口审查证据的并集证明；不要求一个调用读全仓。各区共享 operation/attempt、预算、最终候选和一次受管交付，局部通过不替代全图、真实运行、receipt 或原树采纳。

代码提交可在完整已结算基线已被来源 Git 真实采纳后，按提交路径的实际 owner 与必要影响闭包规划。只有真实 `before`、完整 discovery selection 的精确资源头和对应 delivery 采纳均可验证时才收窄；首次、无/未采纳/未完成基线、缺少精确绑定、根原意或配置变化、未治理源码变化继续完整 bootstrap/发现。多轮 freeze 始终用原始 discovery selection 证明完整基线，不能将上一轮的窄 selection 当作覆盖证明；失败 admission、保存或暂存信号不消费基线。

方案保留九项REQ和二十八项AC及阶段依赖；产品实施状态由 [[spec-sync]] 与各权威子节点、实际当前版本证据决定。跨机器原意授权由 [[sync-intent-authorization]] 定义，可信CI从受保护目标提供policyCommit；普通候选不能选择自身政策来授予自己权限。撤销和版本回退分别复用 [[sync-history-input]] 与 [[sync-application]] 的新成组补偿及停止写入动作，真实来源采纳和主分支同步按 [[sync-landing-status]] 区分。大上下文通过 [[frozen-context-reader]] 完整读取，不改变原预算或降低审查义务。

已结算交付的显式来源采纳由 [[sync-source-adoption]] 处理，只快进干净原树至真实收据提交；Dashboard 和 CLI 共用门禁，保留未提交内容及分叉历史，不自动代替另行授权的分支合并。
