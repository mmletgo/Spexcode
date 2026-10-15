---
title: 原生派发资源桥针对性回归
status: active
hue: 175
desc: 用真实SQLite与可观察原生运行接缝验证持久意图、身份、取消和重入边界。
code:
  - spec-cli/src/sync/native-run.test.ts
---
# 原生派发资源桥针对性回归

## raw source

资源桥必须证明实际记录与数据库协议之间的故障窗口可恢复，不能把模拟结果称为真实LLM完成。

## expanded spec

验证派发前持久计划、published但thread未知、精确thread/turn绑定、完整结果证据、同键无重复调用与计费、同键不同载荷拒绝、结果/record身份与hash错配拒绝、未知原生终态不removed、取消回执丢失与旧fence资源结算、已结算结果blob核验重放、精确同键恢复不另造会话。真实原生Agent全链路验收由上层负责。

命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/native-run.test.ts`；相关lint与typecheck沿用sync目录约定，不运行无关完整套件。

已覆盖terminal写入后本地失败的无重复重放、旧source被superseded后的精确Abort/stop、已冻结candidate资源绑定、调用前已aborted的notDispatched证明，以及取消回执丢失仍保存已确认终态。测试仅验证真实SQLite和可观察runtime协议；不宣称真实LLM或真实原生RPC已执行。

创建阶段覆盖真实 Git target-resolution 与 worktree-add 后被取消：锁等待者取消不能替已取得创建权的事务写收据，worktree/branch 清理完成后方可结算资源。新进程同键重放取消收据且不同载荷拒绝；取消资源恢复不重派发、不增预算。未证实停止继续保留容量，收据版本、session、request、payload、清理与 nativeStopped 任一错配都拒绝。真实 Git fail→pass 验证仍不代表真实模型已经执行。

真实 Git 清理失败和 10 秒截止中断后重入正式恢复：已有精确候选收据才可继续，已移除候选重读确认后结算；调用次数与预算均不增加。源 checkout 的 staged/unstaged 内容、index 以及另一个用户 worktree 逐字节保留。候选后来出现 unstaged/staged/untracked/ignored 内容时恢复拒绝并保留原文件；撤去测试新增内容后原候选可正常清理。并发 canonical publication 持有同 request-key 锁时恢复不得抢先，发布后即使 envelope 缺失仍拒绝 notStarted 清理。

所有真实结构化创建取消/重启恢复都携带原冻结策略，核对同一外部runtime候选收据；不能以普通checkout内目标冒充原候选。

检查后竞争使用真实 Git 命令复现：worktree remove 完成后外部重建同路径内容、分支在删除前前进时均拒绝结算并保留文件或引用；撤去竞争后同键恢复通过，正常 reference-transaction hook 可观察删除。两种拒绝及成功恢复均保留源 checkout/index、其它用户 worktree 与原调用预算。

冻结读取回归另外验证业务requestKey与实际sessionCreateKey分离、真实attempt/policy绑定、派发摘要前自动无损冻结超大prompt、稳定引用同键重入、精确native history proof保存与removed重放核验。此文件使用受控runtime接缝；真正原生大于2MiB读取和能力隔离证据由 [[frozen-context-reader]] 的独立native测试承担，不混称为LLM验收。

1至2MiB旧 inline 资源回归固定完整请求、dispatch及真实SQLite资源后，以已 aborted 的原请求重入，核对只取消原精确会话并推进 removed、无新 run、callsUsed 不增、计划摘要不变。同 key 修改正文仍拒绝，不能借旧资源跳过新请求冻结或摘要核验。该前置资源是明确夹具，不冒称原生模型交付。
