---
title: 精确资源发布基树
status: active
hue: 175
desc: 冻结模型读闭包之外继承同来源已结算对象，使独立交付保留彼此完整版本。
code:
  - spec-cli/src/sync/publication-base.ts
---
# 精确资源发布基树

## raw source

独立 A1 已交付但尚未被来源采纳时，B2 的完整交付必须保留 A1。A/B 可以在同一 HEAD 并行生成，发布顺序互换仍保留先发布版本；未消费的来源 dirty A2 不进入 B 的交付。本轮覆盖与历史资源头不能借此扩大。

## expanded spec

发布锁由协调器按完整来源身份取得，仅串行冻结候选、独立审查、验证和真实发布；模型生成仍可并行。assemblePublicationBase 在锁内从 operation.input.headCommit 和 [[sync-store]] 同事务读取的完整同来源 path heads 形成父树，不使用全局 latest pair，也不读取 live dirty。每条继承证据绑定真实 pair、receipt、OID、mode 或删除。无关 legacy 未知路径只保留诊断并沿原 HEAD，不猜已交付对象、不阻塞其他已证明资源；原 selected 未知资源继续严格拒绝。

逐路径比较当前冻结 HEAD、该 pair.sourceInput 对应 HEAD 和 verifiedDelivery 的实际对象。当前 HEAD 等于原 HEAD 时继承已结算 delivery；已等于 delivery 时保留；有真实新提交对象时保留当前 HEAD 并记录 current_head 原因。作者未消费 dirty 不作为闭包外发布输入。

父树的写路径保留已结算/HEAD preimage；只读 read closure 从 original composed 原字节携入父树，包含配置、oracle、mode 与不存在路径，使它们不产生本轮 apply 差量。candidate composition 在父树上仅叠 original composed 读写闭包；原 composed、sourceInput、baseline selection、request、作者投影和行为分析身份均不替换。metadata commit-tree 与私有保活 ref 只固定输入对象，使用原 source HEAD 为唯一 parent，不是交付提交或 receipt；真正发布仍执行 [[sync-private-delivery]] 的可信普通 hooks。

publication readPaths 必须精确等于可信 plan.readPaths 与当前已审 operation.scope.paths 的去重排序并集；factory 和 verifier 都核该唯一集合。不能添加无关路径把继承的已结算字节当作 readonly carry 恢复成 original composed，亦不能遗漏配置、oracle、absence 或已审 P1 新文件。缺失冻结计划不能猜读闭包。

publication provenance 内容寻址绑定 operation/attempt、原输入与 readSet、original composed、完整读写路径、path frontier、诊断及实际 parent/候选组合对象。[[sync-store]] bindPublicationBase 在事务外重建实际对象，在事务内复核当前 fence、原 selection 与完整 frontier CAS；仅 generating 且无 candidate/verification 时可首次绑定，相同对象重入仍核当前完整 path frontier，已变化明确 stale，不能替换。候选冻结后和恢复只能使用该 parent，不重新读取 latest 更换树。冻结候选的模型 diff 基线为 publicationBase.composed；完整 apply 差量仍须严格属于本轮实际验证 scope，继承路径、readonly 与历史 ID 不取得本轮 journal 或头推进。

[[sync-publication-base-regression]] 的真实 Git/SQLite 回归覆盖 A1 后 B2、同 HEAD A/B 两种发布顺序、未消费 A2/source/index 保留、readonly config/oracle 当前字节与 absence、逐路径 head 不冒领、伪 parent/闭包/来源拒绝、全 head CAS、冻结后改 base 拒绝及已提交中断恢复原 parent。native 与 V1-V4 前置明确为受控测试证据，不能宣称真实模型或 Docker 已验收；实际 canonical hooks、Git tree/commit、SQLite journal/receipt 均真实运行。

针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/publication-base.test.ts`。

来源发布文件锁释放不消除持久未结算事实。bindPublicationBase 与尚未进入 applying 的 assertPublicationBaseCurrent/new beginApply 共用 store 事务门禁：同完整来源其它 attempt 已有 publicationBase，且未 failed/superseded/settled，或它仍有未 removed resource/未 settled journal 时，返回 SYNC_PUBLICATION_BUSY。无 publicationBase 的独立 analyze/code_generate 资源不被该发布层跨节点互锁。旧实际 applying 沿原冻结 journal 完成结算；尚未 applying 的 verified 恢复先核原 selection 与全 path heads，stale/BUSY 不登记成新失败或生成另一输出。
