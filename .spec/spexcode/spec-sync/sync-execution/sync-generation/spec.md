---
title: 冻结候选实现生成与独立语义审查
status: active
hue: 175
desc: 在完整冻结输入上各执行一次生成与独立审查，不执行候选或交付。
code:
  - spec-cli/src/sync/generation.ts
related:
  - spec-cli/src/sync/candidate.ts
  - spec-cli/src/sync/elaboration.ts
  - spec-cli/src/session-structured.ts
---
# 冻结候选实现生成与独立语义审查

## raw source

依据原始需求、冻结事实和已细化契约生成完整代码与真实测试；实际候选先通过可信程序门禁，再由不同会话重新审查原意、主流程和状态处置，不能以构建者总结代替审查。

## expanded spec

本节点实现 [[sync-execution]] 的一次生成尝试，依赖 [[sync-input-snapshot]]、[[sync-input-composition]] 与 [[sync-frozen-candidate]]。不单独代表 P2、V3/V4 或完整产品已交付。

`runGeneration(input, { runner, validateCandidate, onDispatch? })` 复用调用者注入的 ElaborationRunner 接缝，不新建会话执行器、持久 store、队列或修复循环。调用者决定 attempt、总预算、恢复和有限重试；一次调用至多生成一次与独立评审一次。模型与 effort 由上层指定为 gpt-6.1-sol/high，不私自切换模型。稳定 requestKey 分出 code_generate/code_review 用途；onDispatch 先完成 durable 登记才进入 native runner，最终 session/thread/turn 的持久绑定由上层 runner 包装负责。

第一个异步等待前复制 manifest、original composed 的完整文本 Map、细化契约、待交付 elaboratedSpecs 全文、ready/blocked ID、原始需求/事实/既有验收、允许范围和政策；只保留原 AbortSignal 身份。先验证 snapshot manifest，组合输入则核对 sourceInputId、composed.tree、manifest evidence 和内容摘要。传入 manifest 必须精确对应实际 tree；文本 Map 必须完整且逐字匹配实际 Git 对象中的 UTF-8 普通文件，不混用后续磁盘字节。完整二进制与链接身份仍保留于 manifest，不把它们伪装成文本。

P1 通过后的 elaboratedSpecs 是需实现和交付的目标正文，contracts 可以来自该细化结果；它们不替换 original composed tree，不制造细化中间 tree/commit。生成提示要求最终 changes 包含详细 Spec、真实实现/测试和 anchors，所有 beforeDigest/beforeMode 仍对应 original composed。

模型只返回现有 CANDIDATE_CHANGES_SCHEMA 的 sync-files-v1。freezeCandidate 以输入或 composed 基线的真实对象执行 beforeDigest/beforeMode CAS 和允许文件范围校验，并冻结实际 diff、完整 tree 与保活 refs。schema、CAS 或越界拒绝后不进入评审。此模块仅写既有不可变 Git 对象/证据/候选 refs，不改用户文件、index、HEAD 或交付树。

validateCandidate 是必需可信硬门禁，按实际候选回调；没有回调、回调抛错或返回 error 都不得进入独立评审。返回 ContractFinding.severity，warning 只保留诊断，不阻断。raw/全局 REQ/AC/VERIFY 身份、语义和命令的程序保护由上层该回调统一提供，不在本模块维护第二套契约政策。

评审重新接收冻结原意/基线、实际候选 manifest、全部候选 Spec、完整源码与测试断言，包括未修改文件；不接收构建者总结作为可信证据。审查主流程/状态、遗漏边界、权限/副作用/顺序、弱化验收、空或假断言、跳过与自免检。review 严格 schema 绑定 inputId/candidateDigest，checkedIds 必须唯一、属于实际候选项并覆盖全部预定 readyIds。会话和线程都必须独立于生成。accept 必须无发现；其余 verdict 必须有对应 repair/missing_fact/conflict 的具体 affectedIds、规则位置、代码位置、证据、反例和信息。发现均为阻断项，不能以未知事实为理由编造政策。

取消检查贯穿派发前、登记后、native 输出后和硬门禁后，拒绝继续派发或发布晚结果；unsupported 保留平台原因，不隐式重试。结果保留候选引用、真实结构化输出和 native trace；完整 candidateFiles Map 仅作本地检查，不能写入 store 或外发 JSON。成功仅为 reviewed，始终 runtimeVerification=not_run、delivery=not_applied；上层必须另行完成真实 V3、版本交付门禁和 journal 结算。
