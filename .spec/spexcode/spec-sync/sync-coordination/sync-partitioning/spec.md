---
title: 同步上下文分区
status: active
hue: 175
desc: 从冻结计划和契约图派生确定性局部工作集，完整覆盖变更路径且不扩张局部写权。
code:
  - spec-cli/src/sync/partitioning.ts
related:
  - spec-cli/src/sync/partitioning.test.ts
---
# 同步上下文分区

## raw source

同步工作可按节点或合理小组并行。每组需要有边界的代码、Spec 和测试上下文；所有需处理的变更路径必须有且只有一个负责组。只读上下文可跨组引用，但不能扩张组的写权。

## expanded spec

规划覆盖真实影响目标，不以目标文件本身出现在diff为前提。Spec保存后，已治理实现虽尚未变化也纳入本区原授权写集合；所有潜在实现/非只读测试writer重叠的目标先合区。上层纯原意节点仍只作上下文，除非本次自身变化或实际持有实现写职责。mandatory oracle与只读依赖永不升格writer，目录级执行授权收窄到本区实际文件；不相关code来源事实不进入本区。

规划只接受调用方冻结的 `SyncCoordinatorPlan`、文件正文、已解析 `Contract` 集合和精确 `changedPaths`，不读取实时工作树、不发起模型调用，也不修改输入。契约引用与反向关系复用 `spec-core/contracts` 图；Spec 的 `code:`、`related:` 锚点、selector、目录与 glob 匹配复用现有 relation parser 和 matcher。

每个 `changedPath` 在 `expectedPaths` 与恰好一个分区中出现。目标 Spec 路径按节点归属；代码与验收文件按其真实声明者归区。多个目标声明同一实际写文件时必须合区，任何分区路径不得被另一区重复写入。没有当前治理所有者的变更也必须归入按目录和最近已知治理邻域组织的发现组；该组应保留近邻 Spec 作为只读背景，不得因此把变更解释为已有合法归属。独立发现路径可按真实上下文字节预算拆组，之后发现的新治理叶由上层流程取得局部写权。

局部分区只读取目标正文、关联验收与源码、上游契约引用、必要的祖先 Spec 原文、近邻发现上下文和本组变更路径。契约依赖边方向为 `from` 消费方到 `to` 前置依赖方；只读依赖进入上下文，不成为 `targets`、`executionScope` 身份或写授权。全局 intent 保留为只读输入；分区投影只带本区 `targets`、精确写路径、本区 source 路径、本地 executionScope 身份与实际相关 `mandatoryTests`，不把全局读/源路径目录或全部测试路径复制给每组。

每区默认上下文预算为 512 KiB 完整 UTF-8 正文，按 SHA-256 相同正文去重后累计；内容不得截断。单个完整正文超过预算时独立成区，并通过 `oversizedReads` 报告路径、实际估算字节和预算。不可拆共享写者或强依赖组因合计正文超过预算时保持合区，`readBytes` 与 `readLimitBytes` 如实暴露超额；规划层报告是工作集估算，不替代原生执行器对真实读取和历史 before/after 内容的证明。调用方可用 `readByteSizes` 补充 `files` 未含的真实版本字节估算。

分区顺序、路径顺序和摘要不受输入 Map/列表顺序影响。摘要使用现有 `snapshot.contentHash`，绑定冻结计划、分区与跨区边、变更路径及投影正文摘要。`projectSyncPartition` 只从全局可信授权取交集：全局 intent 可读，分区 targets 与写路径仅限本地；不得通过只读依赖取得 writer 身份。
