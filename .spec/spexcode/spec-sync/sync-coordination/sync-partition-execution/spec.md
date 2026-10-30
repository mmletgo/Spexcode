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
没有既有源码writer且非纯父级的功能分区，先经同runner/预算执行一次implementation_plan，只列精确源码/测试路径，不写正文或产生业务批准。完整局部已审契约和实际读取全文仍冻结；程序核原global授权、普通精确文件、已有文件须本区完整读取、Spec只读和外部oracle。所有提案返回后核跨区实际文件writer互斥，冲突作为具体repair沿原attempt/修复预算自动重规划，不降成人工业务GAP，也不把global目录复制给每区。

通过的file-writer-plan同attempt持久，新增路径通过原scope扩充动作取得精确租约及null基线，并在同内容树上重绑readSet，再进入generating。新实现路径只授予对应区；局部和跨边最终独审完整读取实际新增源码。文件规划不另加业务独审：原P1义务、最终候选V2及V1–V4继续审业务。动态阶段在P1揭示实际义务后，精确核尚未派发的文件规划/生成/分区及跨边独审调用与原预算族剩余量；已完成调用不重扣。原计划、文件计划及真实最终覆盖集合分别保留，不把blocked或未独审分区列成已覆盖。


完成依赖闭包仅增加完整契约接口上下文，不把只读dependency owner的全部code/test再次复制进每区。本区owner的完整源码/测试保持；跨边审查显式以两端为实现目标，最终V2以真实owner与边原件分别证明覆盖。
