---
title: 同操作分区阶段执行
status: active
code:
  - spec-cli/src/sync/partition-execution.ts
---

## raw source

大型同步应由多个分区完整读取对应源码并写对应Spec，完整性由分区并集证明；不能要求每个模型读取全仓，也不能放宽预算、独审或最终验证。

## expanded spec

复用 [[sync-partitioning]] 的唯一计划与既有runner/store/checkpoint，按固定小批并行各区分析、P1及补丁准备；取消或异常后不派新工作，已在途任务先结算。真实native容量及原子预算不改变，不另建SQL队列、子operation或自定义持久任务表。

分区analyze/P1保存原件；聚合拒重复变更ID、目标路径、新归属和resolution写者及冲突事实来源。真实changedPaths必须由分区唯一覆盖。上层raw作为只读context，首次raw-only根先完成一次独审，其他区随后并行；新叶只按真实codePath归属。P1后沿真实契约引用完成最终分区依赖覆盖，保持原partition身份和原分析引用。

生成区只返回本区完整文件补丁，核实际读取、scope、局部Spec目标和独立oracle后统一确定序装配。唯一publication/CAS接缝只冻结一棵candidate。每个局部/跨边独审重新读取对应完整最终正文，全部绑定同一candidateDigest并与全部builder身份独立；聚合保存原review，不生成全仓模型accept。code_to_spec仅装配已审Spec，核source/tests Git对象逐字、mode及absence不变，不运行可写代码生成器。V1–V4及单journal/receipt仍由 [[sync-coordinator]] 完成。

所有局部阶段键含partitionId，完成后持久refs，重入复用真实已完成结果。异步完成顺序不影响最终树；相同文件多writer或业务ID冲突拒绝，不按最后完成者覆盖。


code_to_spec 的 P1 实现写范围显式为空；分区投影保留该只读约束，不把各区代码 writer 误传成允许补写源码或测试的权限。
