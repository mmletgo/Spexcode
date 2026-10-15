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

GenerationInput 复用 InputSnapshot、ComposedInputRef、SnapshotManifest、Contract、Acceptance、SyncScope 和既有只读会话输入类型。files 是协调器确定的完整受影响读集合，各完整正文用 ReadonlyMap；完整仓库身份仍由 manifest 绑定，不默认把整个仓库或凭据送给模型；elaboratedSpecs 单独携带 P1 通过后待交付完整正文，不替换 candidate.baseTree；事实、契约和 ready/blocked 集合由调用者冻结。可信政策带版本及摘要，执行模型固定上层指定 gpt-6.1-sol/high。

GenerationOptions 必须提供 ElaborationRunner 和异步 validateCandidate；硬门禁返回既有 ContractFinding，error 阻断、warning 保留。可选 onDispatch 在 native 之前完成持久登记，不代替 native 身份绑定。

GenerationReview 绑定 inputId/candidateDigest、verdict、checkedIds 和全部阻断 GenerationFinding；发现包含类别、影响业务 ID、规则/代码位置、证据、反例与信息。GenerationResult 区分 reviewed、repair、needs_input、conflict、failed、cancelled、unsupported，保留候选 refs、程序门禁发现、独立 review、native traces 和失败原因。完整 candidateFiles 仅本地消费；runtimeVerification 和 delivery 明确尚未运行及尚未交付。接口不隐含持久队列、重试预算或同步完成权限。

repairContext 可携带既有失败产物和具体诊断，只是修复输入，不能升格为需求、政策或通过证据。

生成可携 [[sync-writeback-types]] 的独审行为证据、节点迁移及明确direction。合法外部行为必须保留，纯重构保持业务正文；保持需求的裁决才授权纠正外部行为。分析结果属于绑定执行上下文，不能追加到冻结计划改变policyDigest。

retiredIds可由已接受细化携入生成；已明确退役的验收身份保留为负向验证义务，独审必须核对应实际代码移除及真实反例测试。没有active AC不能靠空集合自动通过，退役仍须执行固定登记命令及旧验收绑定的测试标识。

GenerationInput 必填 mandatoryTests 与 verifications 直接复用 SyncCoordinatorPlan 的可信 tuple/definition 类型；两者纳入同一冻结输入，不另建授权配置。reserved oracle-policy:decision:<stableDecisionId> 复用既有 missing_fact finding 与 needs_input verdict，只传具体政策互斥诊断，不增加写入权或新的审查阶段。

GenerationOptions 可选 beforeFreezeCandidate 为可信程序回调，在生成响应 schema 与 approvedSpecs 核验后、freezeCandidate 前取得派生发布组合输入；protectedReadPaths 携完整读闭包（含不存在路径），不进入模型提示或 inputDigest。回调不授予模型选择发布父树的权限。
