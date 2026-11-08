---
title: 冻结生成与独立审查接口类型
status: active
hue: 175
desc: 一次生成尝试的可信输入、强制硬门禁与可追踪局部结果。
code:
  - spec-cli/src/sync/generation-types.ts
---
# 冻结生成与独立审查接口类型

## raw source

协调器向生成和独立审查提供同一冻结输入，以明确类型交接候选和证据，不混淆生成、运行、落盘及同步状态。

## expanded spec

GenerationInput可携nativeWorktree:true与明确stageTree；前者只由已冻结新workflow计划派生，后者让各分区继承同一个已审全局Spec overlay。files仍是核真的相关业务数据，不是读取授权；worktree builder结果不返回完整文件补丁，preparedChanges由真实Git diff导入并保持原CandidateChanges结构。无标记输入仅作历史协议和旧纯单测接缝，不改变新生产默认。

模型调用期限沿 [[structured-session-runtime]] 原样传递，明确 null 不装调用计时器；生成与独审、完整读取及各自业务门禁保持。

GenerationInput 复用 InputSnapshot、ComposedInputRef、SnapshotManifest、Contract、Acceptance、SyncScope 和既有只读会话输入类型。files 是协调器确定的完整受影响读集合，各完整正文用 ReadonlyMap；完整仓库身份仍由 manifest 绑定，不默认把整个仓库或凭据送给模型；elaboratedSpecs 单独携带 P1 通过后待交付完整正文，不替换 candidate.baseTree；事实、契约和 ready/blocked 集合由调用者冻结。可信政策带版本及摘要，执行模型固定上层指定 gpt-6.1-sol/high。

GenerationOptions 必须提供 ElaborationRunner 和异步 validateCandidate；硬门禁返回既有 ContractFinding，error 阻断、warning 保留。可选 onDispatch 在 native 之前完成持久登记，不代替 native 身份绑定。

GenerationReview 绑定 inputId/candidateDigest、verdict、checkedIds 和全部阻断 GenerationFinding；发现包含类别、影响业务 ID、规则/代码位置、证据、反例与信息。GenerationResult 区分 reviewed、repair、needs_input、conflict、failed、cancelled、unsupported，保留候选 refs、程序门禁发现、独立 review、native traces 和失败原因。完整 candidateFiles 仅本地消费；runtimeVerification 和 delivery 明确尚未运行及尚未交付。接口不隐含持久队列、重试预算或同步完成权限。

repairContext 可携带既有失败产物和具体诊断，只是修复输入，不能升格为需求、政策或通过证据。

生成可携 [[sync-writeback-types]] 的独审行为证据、节点迁移及明确direction。合法外部行为必须保留，纯重构保持业务正文；保持需求的裁决才授权纠正外部行为。分析结果属于绑定执行上下文，不能追加到冻结计划改变policyDigest。

retiredIds可由已接受细化携入生成；已明确退役的验收身份保留为负向验证义务，独审必须核对应实际代码移除及真实反例测试。没有active AC不能靠空集合自动通过，退役仍须执行固定登记命令及旧验收绑定的测试标识。

GenerationInput 必填 mandatoryTests 与 verifications 直接复用 SyncCoordinatorPlan 的可信 tuple/definition 类型；两者纳入同一冻结输入，不另建授权配置。reserved oracle-policy:decision:<stableDecisionId> 复用既有 missing_fact finding 与 needs_input verdict，只传具体政策互斥诊断，不增加写入权或新的审查阶段。

GenerationOptions 可选 beforeFreezeCandidate 为可信程序回调，在生成响应 schema 与 approvedSpecs 核验后、freezeCandidate 前取得派生发布组合输入；protectedReadPaths 携完整读闭包（含不存在路径），不进入模型提示或 inputDigest。回调不授予模型选择发布父树的权限。

GenerationInput.model 是由 operation 固定的模型 ID，effort 保持 high；缺省 sol 与显式选择的持久语义属于 [[sync-model-selection]]。


GenerationOptions新增prepareOnly、reviewCandidate与builderTraces，分别用于结构化补丁准备和统一冻结候选的独立审查；原runGeneration默认行为保持。GenerationResult可返回prepared及preparedChanges，此状态没有候选验证或review通过含义。partitionEvidence保存每个真实分区/跨边review、同candidateDigest及trace；聚合review留null，不捏造全仓模型accept。跨边analysisEvidence携对应端点的真实独审原件用于提示，原业务授权核验仍沿不可变analysis。


分区调用可携implementationPolicy的原授权目录与源码角色，只供受限文件规划；beforePartitionGeneration接收程序已核的精确路径及持久证据，由可信协调器沿既有scope门禁取得租约/绑定后返回实际scope/composed。此回调发生在任何code_generate前，不授予局部builder全局目录。GenerationResult.fileWriterPlanRef把真实布局计划绑定最终V2证据。


readonlyContractPaths只用于sync-coordinator-v2局部只读接口上下文，不授予写权或实现审查覆盖；跨边合并两端targets后对应路径不再只读。完整Spec仍在files中，真实owner代码/测试及外部oracle读取不变。

失败值可携原 Native session/thread/turn、requestKey/inputDigest，仅绑定原故障来源，不表示成功或自动续修授权；已结算资格由 [[sync-native-run]] 与 [[sync-coordinator]] 重核。

GenerationInput可选reviewRepair只携既有resultRef、nativePlanRef、checkpointRef，交精确失败组的未批准格式诊断；既可来自Native格式拒绝，也可来自已认证Native成功但程序位置字段格式拒绝。复用既有stage-worktree临时Git稿，不新增持久字段，不追补旧ref/缺席。该引用进入失败组真实请求摘要，兄弟输入不带它。

GenerationOptions.reviewSpecWritePaths只接唯一最终dispatch已派生的P2 Spec写范围，供实际只读P1位置早验使用；不进入GenerationInput、inputDigest或持久记录，不是新的权限配置。一般可写P2与合法跨owner精确诊断保持原协议。
