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

所有结果动作核对 operation/attempt/generation/物理来源/全部资源 lease。范围冲突按实际 paths 与 contractIds/flowIds 检查；独立范围可并行；释放后每资源 generation 不归零。superseded 或过期 fence 拒绝新候选、验证和 beginApply。native 会话创建、Git、blob/文件读取均在事务外，checkpoint 保存 executor runId 对应的内容寻址记录，不另建执行数据库。

freezeCandidate 核对实际 diff blob 的文件范围，recordVerification 绑定输入与候选及真实 coveredScope。beginApply 核对控制、fence、完整目标物理身份与复核快照、共同 baseline、候选/验证/真实 target→candidate manifest diff，先提交 journal 才允许文件副作用。effectKey 同 payload 幂等，不同 payload 拒绝。recordApplyStep 保存写入单元进度，recordReceipt 保存真实 tree/commit/交付快照证据；没有实际副作用的回调不能成为 Git 完成证明。

settleApply 原子保存 receipt、journal 结算、sourceInput+verifiedDelivery 成对 baseline 和真实 deliveredScope。部分交付只推进 coveredScope；根仍 needs_input/conflicted。源及交付物理身份不同的外部输入基线不得套到发布交付树后续编辑，交付树另建自己的 source=delivery 成对基线。pause/cancel 在 applying 只记请求并进入等待边界状态，写入单元完成登记结算后停；取消保留实际 receipt，不等于回滚。未结算副作用、过期 attempt 与未派发操作通过 listRecoverable 查询；pinnedBlobRefs 保护冻结输入、候选、证据、checkpoint 与基线引用。

reserveDispatch 在每次原生调用前按key原子预留 callsUsed/maxCalls 与截止时间，bindSession 按已保存 plan 更新不可替换的原生身份。bindDelivery 绑定预先持久 deliveryPlan 的真实仓库/路径/分支；bindComposedInput 保存组合输入且保留原始source identity。冻结候选核对 composed→candidate 的实际模型差量；beginApply 按完整manifest重建 currentTarget→candidate 差量，允许包含原始用户输入，不把source先无journal写入交付树。四层验证 blob 的范围与外层引用一致，所有证据内容摘要在事务外核对。

被取消、暂停或superseded的旧pending envelope可由discardDispatch精确FIFO消费；仅允许控制已停止或终态的operation，不能丢弃仍需attempt的有效输入。恢复不重置预算，retry核maxAttempts/maxRepairs/截止时间；recordBudgetExhaustion仅在真实预算已耗尽时写入budget_exhausted，applying则维持recovery_required。迟到native身份绑定不能将已applying attempt降回running而开放租约抢占。候选覆盖可大于模型diff，外部人类输入路径仍纳入真实应用和验证范围。

receipt 的实际tree与交付manifest必须精确绑定已冻结候选，错误清单不能进入共同基线，即使其他receipt引用形式正确。
