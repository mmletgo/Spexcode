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

当前及历史路径治理归属复用[[sync-governance-owners]]的同一纯函数，分区装配不另建归属算法；related仍不授予归属或写权。

规划覆盖真实影响目标，不以目标文件本身出现在diff为前提。Spec保存后，已治理实现虽尚未变化也纳入本区原授权写集合；所有潜在实现/非只读测试writer重叠的目标先合区。上层纯原意节点仍只作上下文，除非本次自身变化或实际持有实现写职责。mandatory oracle与只读依赖永不升格writer，目录级执行授权收窄到本区实际文件；不相关code来源事实不进入本区。

普通契约依赖只把前置项的完整 Spec、上层原意与业务 ID 接口带入本区，不继承其全部源码、related 文件或验收实现；两端真实 code 路径随跨区依赖边返回，供上层最终独立交叉审查。显式目标 intent 若有真实 rawSource 且尚无任何 sync-v1 Contract，则规划唯一纯 Spec 写者的根种子区，之后实现叶仍各持本区源码。种子区不取得根的 code/related 或后代实现写权；已结构化的 intent 不重复成为只读目标，不在 targets 的节点不得提权。

规划只接受调用方冻结的 `SyncCoordinatorPlan`、文件正文、已解析 `Contract` 集合、可选的真实节点身份清单和精确 `changedPaths`，不读取实时工作树、不发起模型调用，也不修改输入。契约引用与反向关系只复用 `spec-core/contracts` 图；即使 Spec 尚无 `contract-schema`，仍从冻结正文的 frontmatter 及节点身份读取真实 `code:`/`related:` 治理。raw-only 节点只决定文件所有权、上下文及局部潜在 writer，不伪造成业务契约、依赖或批准身份。Spec 的 `code:`、`related:` 锚点、selector、目录与 glob 匹配复用现有 relation parser 和 matcher。根 seed 只在显式 target 无真实 Contract 且其实际 `rawSource` 非空时产生；存在性取冻结节点/target 的 rawSource 或 `parseParts` 对应正文结果。

任一当前 target 若从当前 Spec 正文优先解析到非空 `rawSource`、自身无 `code:` 绑定，且同 Spec 子树内有带真实 code 绑定与现存源码文件的 target 后代，则规划为独立单 target `phase: interface_seed`。父节点可以没有 sync-v1 Contract，也可以恰有一个 nodeId/path 与 target 精确匹配、`code: []`、至少含一项 `REQ`、`RULE`、`GAP`，且其它项只限这三类或可信技术 `VERIFY` 的 sync-v1 纯接口 Contract；既有业务项与稳定 ID 在分区中保留。`VERIFY` 只能作为已登记技术定义随父契约存在，分类本身不授予命令执行权，命令必须继续通过上游的精确登记匹配硬门禁；仅有 `VERIFY` 的父节点不符合纯接口条件。多重或身份不匹配的 Contract，以及含 `FLOW`、`STEP`、`STATE`、`EVENT`、`TR`、`AC` 等行为契约项的父节点不标 interface phase。当前后代的实际文件还必须落在冻结计划的 `sourcePaths` 下；文件虽存在但只处于测试、只读或其他非 source 角色时不构成源码后代，`related:` 也不构成 code 绑定。该区只写父 Spec、`sourcePaths` 为空，不参与同模块贪心合批；叶子仍由自己的分区持有源码。`phase` 标记随分区进入既有 plan digest。已审分析新节点只有在其目标位于该父目录下、`codePath` 精确属于唯一来源分区的 `sourcePaths` 时才能提供后代证据；有效 P1 冻结保留后代身份与来源分区，并绑定 plan digest 和 analysis ref。没有真实后代的全局 raw intent 继续保留原 Spec-only 根 seed，但不标 interface phase；无子 raw-only 叶仍走普通模块合批。分析节点证据不另建图、队列或权限。

每个 `changedPath` 在 `expectedPaths` 与恰好一个分区中出现。目标 Spec 路径按节点归属；代码与验收文件按其真实声明者归区。多个目标声明同一实际写文件时必须合区，任何分区路径不得被另一区重复写入。没有当前治理所有者的变更也必须归入按目录和最近已知治理邻域组织的发现组；该组应保留近邻 Spec 作为只读背景，不得因此把变更解释为已有合法归属。独立发现路径可按真实上下文字节预算拆组，之后发现的新治理叶由上层流程取得局部写权。

无路径重叠的目标先按直属父 Spec 模块（`dirname(dirname(specPath))`）形成责任桶，再按完整上下文 UTF-8 bytes 贪心并组；跨父模块不因容量富余自动合并。发现组优先按最近真实治理节点的父 Spec 模块合并，保留每个最近节点的只读上下文；没有真实近邻时，按冻结 `sourcePaths` 下的顶层源模块/目录分界，避免无关模块混组。共享 writer 在分桶前合并，预算不足则保持完整并明示超额。

局部分区只读取目标正文、关联验收与源码、上游契约引用、必要的祖先 Spec 原文、近邻发现上下文和本组变更路径。旧治理可由调用方传入 `governanceSources` 供缺失路径的 frontmatter 解析；它只用于元数据，不加入当前正文视图，当前存在的 Spec 始终优先。同一 node ID 可对应冻结输入中的多个旧/新 path 身份，旧路径只补真实影响归属，实际写权仍受当前 plan 的精确 scope 限制。契约依赖边方向为 `from` 消费方到 `to` 前置依赖方；只读依赖进入上下文，不成为 `targets`、`executionScope` 身份或写授权。全局 intent 保留为只读输入；分区投影只带本区 `targets`、精确写路径、本区 source 路径、本地 executionScope 身份与实际相关 `mandatoryTests`，不把全局读/源路径目录或全部测试路径复制给每组。

当本区变更路径或目标的 `code:` 治理元数据指向全局 `sourcePaths` 中的源码，且对应owner没有既有 AC 时，AC 生成前的局部只读闭包必须纳入全局 `mandatoryTests` 中仍受全局 `readPaths` 授权的精确测试路径及原绑定。未治理源码的 targetless discovery 与已治理但源码只读的目标都按此规则读取；读取资格不取决于源码是否可写。存在的测试正文按完整正文进入本区读取预算与摘要；正文缺失时仍保留绑定以便只读 AC 校验拒绝。该只读依赖不扩张 `writePaths`、`sourcePaths`、`executionScope`，也不成为业务事实来源；未获全局读取授权的路径不进入局部正文视图。

每区默认上下文预算为 512 KiB 完整 UTF-8 正文，按 SHA-256 相同正文去重后累计；内容不得截断。单个完整正文超过预算时独立成区，并通过 `oversizedReads` 报告路径、实际估算字节和预算。不可拆共享写者或强依赖组因合计正文超过预算时保持合区，`readBytes` 与 `readLimitBytes` 如实暴露超额；规划层报告是工作集估算，不替代原生执行器对真实读取和历史 before/after 内容的证明。调用方可用 `readByteSizes` 补充 `files` 未含的真实版本字节估算。

分区顺序、路径顺序和摘要不受输入 Map/列表顺序影响。摘要使用现有 `snapshot.contentHash`，绑定冻结计划、分区与跨区边、变更路径及投影正文摘要。`projectSyncPartition` 只从全局可信授权取交集：全局 intent 可读，分区 targets 与写路径仅限本地；不得通过只读依赖取得 writer 身份。
