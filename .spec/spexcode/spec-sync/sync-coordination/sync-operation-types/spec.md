---
title: 同步协调共享身份与记录
status: active
hue: 175
desc: 定义冻结输入、独立尝试、写入栅栏、成对基线及应用 journal 的共享协议。
code:
  - spec-cli/src/sync/operation-types.ts
---
# 同步协调共享身份与记录

## raw source

各生成、验证和交付组件必须使用同一身份与记录模型，避免旧尝试、重建工作树或未验证候选取得写入权。

## expanded spec

本节点治理共享 TypeScript 数据协议，完整范围遵循 [[sync-coordination]]。工作树身份包含仓库、commonDir、canonicalRoot、gitDir、分支及删除重建可区分的物理指纹。冻结输入保存 HEAD、不可变 tree、index tree/digest、文件 manifest blob 与内容摘要；采集时间仅为元数据，稳定 ID 不包含采集时间。

operation 保存不可变输入和 previousBaselinePair、generation/revision、根因及接入键、政策/影响/读集合摘要、8.2 全部阶段、控制与预算、真实 paths/contractIds/flowIds 范围、ready/blocked/delivered 范围及交付目标。attempt 独立保存稳定派发与 session 创建键、原生会话引用、完整 manifest 与实际 diff blob 候选、验证、checkpoint blob 与明确失败类型。fence 绑定 operation、attempt、generation、源物理身份与 lease token。

operation 可保存 contractScopeExpansions：P3每项只含完整 contractIds/flowIds 和可信细化 evidenceRef；P4可增加已审P1发现的精确paths及扩展前后selection摘要，供范围扩展幂等、重启/retry、组合readSet重绑与证据保活，不携正文。旧数据库无此字段表示尚未通过动作门禁扩展。既有初始 payload 身份不因细化新增 ID 改写。

受控编辑或裁决可提供 requestBlob 保存额外用户意图的不可变引用。input 仍表示实际采集的来源字节，不能为了接收 Dashboard 编辑而谎称 main 已改变或先单独提交 Spec；组合输入在已验证原文条件后叠加请求。纯文件观察事件无需 requestBlob。请求引用参与接入幂等摘要、恢复与证据保活。

operation/admission可带planBlob固定完整可信计划，SHA256必须等于policyDigest；正文仅存既有evidence，operation直接引用以保活并支持queued进程重启。旧记录缺省可读，不能猜计划或借用新policy恢复。

origin包含initial，表示首次高层Spec入场，与spec走相同可信P2链；code/combined在P3接入前明确unsupported。decision/reconcile只有既有明确用户请求及真实计划授权时沿原Spec语义，标记不能自批路径或业务政策。

ComposedInputRef 可带 requestBlob，表示该组合 tree 已叠加同一不可变用户请求；原始 sourceInputId 不变，不能仅靠相同 source 快照混用两个用户编辑。

journal 保存唯一 effect key、候选/验证/目标绑定、逐文件 pre/post 摘要与 mode、持久 plan blob 和步骤状态。receipt 保存实际 tree/commit、交付快照及证据。baseline 必须同次结算 sourceInput 与 verifiedDelivery，并保存真实 coveredScope；下一次输入由 priorDelivery 加 priorSource→newSource 差量形成，不能丢弃已交付 Agent 内容。部分交付保留根阻塞状态；发布后的交付树作为新来源时建立该物理树自己的成对基线。

adopter control envelope 仅派发协调身份，不作为普通 Agent 文本。共享类型不执行 SQLite、文件或 Git 副作用，调用方必须通过动作门禁修改记录。

每次原生调用先 reserveDispatch 原子预留 maxCalls/callsUsed 与截止时间；attempt 保存完整派发计划数组，稳定 sessionCreateKey 按调用 key 生成，各原生引用不可替换。交付树首次创建前 operation 保存 deliveryPlan，delivery 初始可空，后续绑定真实物理身份。attempt 的 composedInput 与原始 operation.input 分开，包含 sourceInputId、previousBaselinePairId 和组合 tree/manifest/contentDigest。验证引用绑定 policy/readSet/environment/context 摘要；result blob 使用 schemaVersion=1，V1至V4 每层恰有一个独立 verdict 与证据，不能只信任 passed 布尔值。

候选显式绑定 baseTree=attempt.composedInput.tree 与 sourceInputId=operation.input.id。actualDiffBlob 表示组合输入→候选的模型差量；ApplyPlan.files 表示真实交付目标→候选的应用差量，两者不能混同。VerificationResultBlob 同时保存 coveredScope，与外层引用一致，防止扩大窄范围证据。

原生资源计划固定绑定operation/attempt/generation、inputId、candidateDigest、稳定key/kind/payloadDigest及plan blob。verification资源必须绑定已冻结候选；native_session可在冻结前绑定空candidate及固定请求载荷。资源状态为planned→created→terminal→removed，checkpoint正文只存内容寻址引用。更新携expectedCheckpointRef做CAS；相同blob/阶段可幂等重放，迟到观测不能回退阶段或覆盖更完整原生身份。资源观测不授予任何候选、验证或应用写权。

ComposedInputRef 可携 authorProjectionBlob，记录 [[sync-author-input]] 对真实快照的 canonical clean 投影证据。它是派生输入的来源证据，不能替换 sourceInputId 或原始 source/index 身份。

operation及admission可带retryOf，明确关联用户主动重开失败/预算耗尽或未曾交付的取消操作。它是新运行授权来源，参与payload身份，不能更换旧冻结input/request/policy/origin/source；自动事件不带此字段，预算不重置。

SyncIngressReceipt 只保存原接入的精确 payload 摘要、operation 引用、requestBlob 与预算/交付计划/旧基线小引用，用于 alias 重放审计，不替代唯一 operation 事实。

共同BaselinePair和VerificationResultBlob可携retiredIds，旧JSON缺省为空。ComposedInputRef可携compositionEvidenceBlob保留三方文本重叠对象，重叠不是业务冲突结论；独立行为审查之后才形成完整交付候选。

共同BaselinePair与验证结算blob可携decisionRefs，引用不可变用户裁决输入。旧JSON为空；仅receipt结算累积引用，未验证/未应用裁决不会成为后续权威。后续planning据引用重读具体finding及ruleIds形成精确supersession，保留原facts历史全文且不改变未选政策或执行授权。

P4 新接入保存 FrozenBaselineSelection：每个精确 path 恰有 bytePair，每个 contract/flow 恰有 intentPair；没有基线显式 null，禁止整对 latest 回退。选择摘要贯穿 composed/apply CAS。PhysicalScope 只含 repositoryId/canonicalRoot/physicalFingerprint，暂停跨同物理树切分支持久生效，基线仍按完整身份隔离。DispatchAnchor 固定首次真实 protocol enqueue_seq、messageId 及预算族根；当前 dispatchMessageId 与 anchor 分开。观察冻结输入、配置 ref、选择摘要、差异与控制 revision。

P4 selection包含全部精确read/protection及write资源，operation.scope只含实际意图/write范围；readonly资源不进入写租约或交付完成计数。ContractScopeExpansion的可选paths仅由已审P1真实新文件授权，范围与选择同事务扩展。新selection摘要贯穿attempt、composed、verification外层及blob和apply。ClaimQueuedAttemptInput只有显式continuation:true允许安全已ack repair/过期续尝试，failed不自动变queued。SyncIngressReceipt保各alias自己的input、origin、selection和payload引用，原operation冻结输入不改。SyncObserverHealth只记录物理scope、进程/实例和健康事实，online由调用者核实际存活，不以旧watching记录推断。

PublicationBase 可选保存于 attempt，绑定实际 parentCommit/parentTree/parentManifestBlob、publication provenance 和派生 composed；原 attempt.composedInput 不替换。PublicationHeads 仅给可信发布器提供同来源已结算 path 选择及无关 legacy 诊断。candidate.baseTree 为 publicationBase.composed.tree（缺字段的 P3 沿原 composed）；ApplyPlan 可携 publicationBaseRef，精确绑定本轮冻结 provenance，不借继承字节扩大 scope。

VerificationResultBlob可携restoredIds，精确对应原冻结restore授权；仅完整验证与receipt结算发布当前有效ID head，旧retirement pair不修改。
