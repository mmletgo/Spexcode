---
title: 协调事务动作与恢复存储
status: active
hue: 175
desc: 用受限动作门禁原子协调接入、派发、fence、租约、应用和真实交付结算。
code:
  - spec-cli/src/sync/store.ts
---
# 协调事务动作与恢复存储

## raw source

重复事件、过期 Agent 和并发写入不能重复交付或覆盖新输入，进程中断必须从真实副作用及持久记录恢复。

## expanded spec

共享身份属于 [[sync-operation-types]]。admitAndEnqueue 将冻结 operation、稳定派发计划与现有 protocol 的 sync.dispatch.v1 control envelope 原子写入，注册唯一 coordinator 地址；消息不是普通 Agent 文本。稳定接入 payload 包含输入内容与物理身份、policy/impact/readSet 摘要，capture 时间不参与；同键不同 payload 拒绝。claimAttempt 独立保存 attempt 与 sessionCreateKey（不超过128字符），在同一事务领取所有实际 path/规则写集合及可选 exact FIFO dequeue。dequeue 后仍由未完 attempt 恢复。

额外的受控用户请求通过 requestBlob 单独持久绑定，接入前验存在和内容摘要，并纳入 payload 去重与 pinnedBlobRefs。同一实际来源快照上的不同用户编辑不能误归并为同一次操作。没有额外请求的历史操作及自动文件事件保留原摘要语义；请求正文仅在 evidence blob 中，不改来源快照或复制入数据库正文。

bindComposedInput 同时核对 operation.requestBlob 与 composed.requestBlob 的内容寻址身份，存在或缺失都必须一致；错误请求、漏叠加请求或把请求附到自动文件操作不能取得生成输入绑定。请求证据读取和 hash 核验在 SQL 事务外完成。

所有结果动作核对 operation/attempt/generation/物理来源/全部资源 lease。范围冲突按实际 paths 与 contractIds/flowIds 检查；独立范围可并行；释放后每资源 generation 不归零。superseded 或过期 fence 拒绝新候选、验证和 beginApply。native 会话创建、Git、blob/文件读取均在事务外，checkpoint 保存 executor runId 对应的内容寻址记录，不另建执行数据库。

高层输入尚无未来业务 ID 时，expandContractScope(fence, {contractIds, flowIds}, evidenceRef) 在结构校验及独立评审已通过的内部可信细化结果上登记完整单调 ID 集合。先核证据 blob 的真实 SHA256，再在同一 protocol 事务核当前 run/fence，以既有 path/rule 资源键原子取得新增 ID 租约，并扩展 operation.scope 与可供分区的 readyScope。参数不得含 paths 或其它字段，原业务 ID 不可删除；input/payload/路径授权、generation、预算/截止时间和派发消息不改。冲突整体回滚并保留旧租约；每资源 generation 仍递增且释放不重置。operation 保存可选 contractScopeExpansions 证据记录，精确 ref+集合幂等，同 ref 不同集合拒绝；重复不会派发或计费。retry 通过已有 expanded scope 领取租约，幂等重放仍核当前 fence 与真实持有资源。

细化后 startGeneration 的 ready/blocked 是业务分区：共享文件 paths 保持在 readyScope，blockedScope 可仅含 GAP 依赖的 contractIds/flowIds，不机械阻塞整个共享文件。ready 与 blocked 的同类业务 ID 不得重叠；现有路径重叠门禁保持。候选、四层验证和 receipt 的覆盖范围均受 ready 范围约束，未 ready 业务 ID 不能进入 deliveredScope；blockedReason 未消除时，部分 receipt 只能保持 needs_input/conflicted，不能宣称 workspace_synced。

另一细化证据扩展完整 ID 集合时，只把 operation.scope 尚未登记的新 ID 加入 readyScope；已有 blocked ID 不因重新登记/取得租约自动变为 ready，blockedScope 原样保留，完整业务分区由后续 startGeneration 决定。

freezeCandidate 核对实际 diff blob 的文件范围，recordVerification 绑定输入与候选及真实 coveredScope。beginApply 核对控制、fence、完整目标物理身份与复核快照、共同 baseline、候选/验证/真实 target→candidate manifest diff，先提交 journal 才允许文件副作用。effectKey 同 payload 幂等，不同 payload 拒绝。recordApplyStep 保存写入单元进度，recordReceipt 保存真实 tree/commit/交付快照证据；没有实际副作用的回调不能成为 Git 完成证明。

settleApply 原子保存 receipt、journal 结算、sourceInput+verifiedDelivery 成对 baseline 和真实 deliveredScope。部分交付只推进 coveredScope；根仍 needs_input/conflicted。源及交付物理身份不同的外部输入基线不得套到发布交付树后续编辑，交付树另建自己的 source=delivery 成对基线。pause/cancel 在 applying 只记请求并进入等待边界状态，写入单元完成登记结算后停；取消保留实际 receipt，不等于回滚。未结算副作用、过期 attempt 与未派发操作通过 listRecoverable 查询；pinnedBlobRefs 保护冻结输入、候选、证据、checkpoint 与基线引用。

reserveDispatch 在每次原生调用前按key原子预留 callsUsed/maxCalls 与截止时间，bindSession 按已保存 plan 更新不可替换的原生身份。bindDelivery 绑定预先持久 deliveryPlan 的真实仓库/路径/分支；bindComposedInput 保存组合输入且保留原始source identity。冻结候选核对 composed→candidate 的实际模型差量；beginApply 按完整manifest重建 currentTarget→candidate 差量，允许包含原始用户输入，不把source先无journal写入交付树。四层验证 blob 的范围与外层引用一致，所有证据内容摘要在事务外核对。

被取消、暂停或superseded的旧pending envelope可由discardDispatch精确FIFO消费；仅允许控制已停止或终态的operation，不能丢弃仍需attempt的有效输入。恢复不重置预算，retry核maxAttempts/maxRepairs/截止时间；recordBudgetExhaustion仅在真实预算已耗尽时写入budget_exhausted，applying则维持recovery_required。迟到native身份绑定不能将已applying attempt降回running而开放租约抢占。候选覆盖可大于模型diff，外部人类输入路径仍纳入真实应用和验证范围。

receipt 的实际tree与交付manifest必须精确绑定已冻结候选，错误清单不能进入共同基线，即使其他receipt引用形式正确。

协作回写中source与delivery是同一物理树时，仍保留原source→实际delivery历史pair，并建立发布快照sourceInput=verifiedDelivery的后续来源pair；后续人类输入以真实发布字节为基线，不把上一轮Agent输出重新当人类来源差量。

最新成对baseline由SQLite事务插入顺序（rowid）确定，不以可回拨的settledAtMs排序；结算时间仅用于展示。时间回拨后重新打开数据库，source和发布delivery仍读取最近一次成功结算的pair，不能退回旧输入。

planResource在原生命令前核当前fence及固定input/candidate身份，按attempt+key幂等登记资源计划；同键不同载荷拒绝。recordResourceCheckpoint核资源自己的operation/attempt/input/candidate绑定及expectedCheckpointRef CAS，即使attempt过期、superseded或operation取消仍可保存真实资源证据；任何phase更新都不恢复业务写权。阶段只能逐步planned→created→terminal→removed，相同blob/阶段幂等重放，迟到planned不能覆盖terminal/removed。开始前取消且未实际创建，也明确terminal后removed；仅removed释放资源容量。listRecoverableResources独立查询所有历史attempt的未removed资源，终态取消op与非current attempt不能被遗漏。pinnedBlobRefs包含资源plan与所有checkpoint引用。

findResource(attemptId,key)按精确身份查询包括removed的资源，供同一run重入复用已持久checkpoint；不能只扫描未removed集合，否则完成后重试会再次创建真实资源。同阶段更新也需CAS，精确阶段与blob历史重放返回当前记录，不覆写较新的thread/turn或terminal结果。

listOperations(repositoryId, {limit?, sourceRoot?}) 在 SQL 内按仓库及可选精确来源根筛选，并按 rowid DESC 返回最新接入操作，包含运行中及终态。默认 limit=100，只接受整数1..500；读取仍校验组件版本，不以壁钟决定顺序，也不读全库后过滤。

listJournals(operationId)先核operation存在，再按rowid顺序读取该操作全部journal及已结算receipt；终态交付事实不从恢复列表推断。
