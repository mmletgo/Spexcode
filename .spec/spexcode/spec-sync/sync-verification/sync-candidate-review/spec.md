---
title: 共享独立候选语义审查接缝
status: active
hue: 175
desc: 生成与独立 CI 共用同一结构化候选审查规则和 native 输出绑定。
code:
  - spec-cli/src/sync/candidate-review.ts
related:
  - spec-cli/src/sync/generation.ts
---
# 共享独立候选语义审查接缝

## raw source

本地生成与 CI 重新检查必须沿用同一候选独审协议，不允许新增只返回 passed 的平行语义判定。

## expanded spec

从 [[sync-generation]] 原封提取候选 review schema、基础完整性校验与审查任务指令。接受结论必须精确绑定 inputId/candidateDigest，checkedIds 唯一且覆盖预定完整集合，不含未知项；发现 affectedIds 唯一且属于候选或旧契约，非接受 verdict 必须有对应类型、位置、证据与反例，accept 不能有发现。既有生成流程继续校验构建与评审 session/thread 不同，contract-omission 与 oracle-policy 等专用语义门禁保持原样。

每次派发从基础 schema 复制原生输出约束：inputId/candidateDigest 为当前冻结身份的单值枚举，checkedIds 只允许真实候选及本轮退役项，最小数量为预定完整集合大小，最大数量为实际候选集合大小，并明确列出必须独审的项。程序不填充或修正模型回执；未知、重复、遗漏及不诚实的覆盖仍由消费者和独立语义审查拒绝，共享基础 schema 不随请求改变。

contractOmissionBound 在本接缝统一核 repair、专用 marker、实际已审路径、既有 ID 及 affectedIds 关联。生成、协调器恢复和 owner 局部 refinement 共用同一判据；普通 finding 不因与遗漏同轮出现而取得遗漏权限。

调用既有 runner，核 native session/thread/turn 非空及实际输出摘要；不自行调用模型 SDK、不新建队列或信任本地 passed 标记。完整输入由调用者从不可变对象构造，返回原结构化 review 与真实 trace，不能等同于真实运行或交付完成。

Native候选独审仅对实际不可由P2写入、可能授予后继只读P1路由的Spec发现早验定位；实际P2 Spec写范围来自唯一dispatch的瞬态投影，一般可写P2评审协议不变。普通ruleLocation为真实Spec路径#唯一既有ID，affectedIds保持原全图唯一语义，可关联不同owner；同一路径的非空expanded spec正文定位及格式稿续修才要求全部affectedIds属于同一唯一owner。专用contract-omission/oracle-policy仍由原业务门处理。正确路径及affectedIds已绑定、但位置字段夹入说明等格式错误属于review_location_format，仅能续改原review临时稿；未知/重复affectedIds、错路径、形状合法但不存在的ID属于review_location_binding，不取得P1路由或业务写权。原输出不被剥括号或程序修正，Native schema成功也不能替代后继定位协议校验。
