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

GenerationInput 复用 InputSnapshot、ComposedInputRef、SnapshotManifest、Contract、Acceptance、SyncScope 和既有只读会话输入类型。original composed 的完整文件用 ReadonlyMap；elaboratedSpecs 单独携带 P1 通过后待交付完整正文，不替换 candidate.baseTree；事实、契约和 ready/blocked 集合由调用者冻结。可信政策带版本及摘要，执行模型固定上层指定 gpt-6.1-sol/high。

GenerationOptions 必须提供 ElaborationRunner 和异步 validateCandidate；硬门禁返回既有 ContractFinding，error 阻断、warning 保留。可选 onDispatch 在 native 之前完成持久登记，不代替 native 身份绑定。

GenerationReview 绑定 inputId/candidateDigest、verdict、checkedIds 和全部阻断 GenerationFinding；发现包含类别、影响业务 ID、规则/代码位置、证据、反例与信息。GenerationResult 区分 reviewed、repair、needs_input、conflict、failed、cancelled、unsupported，保留候选 refs、程序门禁发现、独立 review、native traces 和失败原因。完整 candidateFiles 仅本地消费；runtimeVerification 和 delivery 明确尚未运行及尚未交付。接口不隐含持久队列、重试预算或同步完成权限。
