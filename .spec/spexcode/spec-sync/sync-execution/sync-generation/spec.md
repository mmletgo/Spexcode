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

候选 schema、基础校验与任务指令由 [[sync-candidate-review]] 共用；本节点保留所有生成身份隔离及专用业务标记校验。

本节点实现 [[sync-execution]] 的一次生成尝试，依赖 [[sync-input-snapshot]]、[[sync-input-composition]] 与 [[sync-frozen-candidate]]。不单独代表 P2、V3/V4 或完整产品已交付。

`runGeneration(input, { runner, validateCandidate, onDispatch? })` 复用调用者注入的 ElaborationRunner 接缝，不新建会话执行器、持久 store、队列或修复循环。调用者决定 attempt、总预算、恢复和有限重试；一次调用至多生成一次与独立评审一次。模型与 effort 由上层指定为 gpt-6.1-sol/high，不私自切换模型。稳定 requestKey 分出 code_generate/code_review 用途；onDispatch 先完成 durable 登记才进入 native runner，最终 session/thread/turn 的持久绑定由上层 runner 包装负责。

第一个异步等待前复制 manifest、original composed 的受影响文本读集合、细化契约、待交付 elaboratedSpecs 全文、ready/blocked ID、原始需求/事实/既有验收、允许范围和政策；只保留原 AbortSignal 身份。先验证 snapshot manifest，组合输入则核对 sourceInputId、composed.tree、manifest evidence 和内容摘要。传入 manifest 必须精确对应实际 tree；读集合各完整正文必须逐字匹配实际 Git 对象中的 UTF-8 普通文件，不混用后续磁盘字节。所给契约的 code/related/source 引用、现存 AC 测试及细化 Spec 必须完整进入读集合，不能省略未改断言。协调器另外负责完整依赖影响闭包；独立评审发现缺少依赖上下文时必须要求修复。既有文件未进入读集合时不能修改，新增文件和所有实际变化必须进入候选审查。完整二进制与链接身份仍保留于 manifest，不把它们伪装成文本。

P1 通过后的 elaboratedSpecs 是需实现和交付的目标正文，contracts 可以来自该细化结果；它们不替换 original composed tree，不制造细化中间 tree/commit。程序把未由生成器显式修改的已审正文直接加入最终候选，避免模型重复抄写完整契约；未变字节不产生额外修改。生成器只需返回实际实现、测试和必要映射修改，确需调整 Spec anchors 时可以显式返回完整 Spec，仍受同一硬门禁约束，不能用程序默认正文掩盖模型的越权改写。所有 beforeDigest/beforeMode 仍对应 original composed，程序加入的 Spec 同样经过 CAS、范围、完整 diff 及独立审查。原始模型输出和 trace 摘要保持原样，候选同时绑定冻结的已审正文。

模型只返回从现有文件语义 schema 派生的严格 CANDIDATE_RESPONSE_SCHEMA 的 sync-files-v1，所有属性 required，mode:null 表示沿用或新增普通模式。即使注入 runner 也验证该响应结构。freezeCandidate 以输入或 composed 基线的真实对象执行 beforeDigest/beforeMode CAS 和允许文件范围校验，并冻结实际 diff、完整 tree 与保活 refs。schema、CAS 或越界拒绝后不进入评审。此模块仅写既有不可变 Git 对象/证据/候选 refs，不改用户文件、index、HEAD 或交付树。评审响应采用原生服务支持的 schema 子集，checkedIds/affectedIds 唯一性由本地程序继续严格核验。

validateCandidate 是必需可信硬门禁，按实际候选回调；没有回调、回调抛错或返回 error 都不得进入独立评审。返回 ContractFinding.severity，warning 只保留诊断，不阻断。raw/全局 REQ/AC/VERIFY 身份、语义和命令的程序保护由上层该回调统一提供，不在本模块维护第二套契约政策。

评审重新接收冻结原意/基线、实际候选 manifest、影响闭包内完整候选 Spec、源码与测试断言，包括未修改文件；不接收构建者总结作为可信证据。审查主流程/状态、遗漏边界、权限/副作用/顺序、弱化验收、空或假断言、跳过与自免检。review 严格 schema 绑定 inputId/candidateDigest，checkedIds 必须唯一、属于实际候选项并覆盖全部预定 readyIds。会话和线程都必须独立于生成。accept 必须无发现；其余 verdict 必须有对应 repair/missing_fact/conflict 的具体 affectedIds、规则位置、代码位置、证据、反例和信息。发现均为阻断项，不能以未知事实为理由编造政策。

取消检查贯穿派发前、登记后、native 输出后和硬门禁后，拒绝继续派发或发布晚结果；unsupported 保留平台原因，不隐式重试。结果保留候选引用、真实结构化输出和 native trace；完整 candidateFiles Map 仅作本地检查，不能写入 store 或外发 JSON。成功仅为 reviewed，始终 runtimeVerification=not_run、delivery=not_applied；上层必须另行完成真实 V3、版本交付门禁和 journal 结算。

模型输入拒绝 [[sync-frozen-candidate]] 定义的宿主凭据和运行文件；业务 src/auth 不因名称被排除。发送的 manifest 只含已读取路径并附完整 manifest 摘要，本地冻结仍使用完整 manifest。生成及审查上下文完整传入既有 runner；超过2MiB时由 [[frozen-context-reader]] 在派发身份冻结前转换为无损按需读取，两次独立turn各自证明完整覆盖。不能截断源码或断言，也不能仅因内联大小拒绝完整义务；总时间、调用次数及资源预算继续约束。candidateFiles 作为本地投影排除同一凭据路径；审查只发送可信读集合及实际变化的完整文件。原 source 与 candidate 身份不因投影改变。repairContext 仅为既有失败诊断，不是新原意、政策或通过证据。

已审三方analysis及明确direction纳入同一冻结输入和独审上下文。合法外部行为及resolutions保持，纯重构业务正文稳定；明确裁决或真实作者raw/规则变更时依对应新原意修实现，其他合法外部行为保持。retiredIds明确负向测试义务，旧binding标识/固定命令仍执行。真正已明确原意的契约遗漏只通过专用contract-omission:path#existingID位置回细化；普通contract:path#id只是规则引用，代码/测试TypeError、错误断言与实现次序缺陷继续generation repair，不自行新增或改已接受业务项。持久Spec不写暂态V3尚未运行/已通过，运行状态只在receipt及证据记录。

采用行为裁决只保所选外部行为，不阻独立作者目标。

外部不可改 mandatoryTests 和可信 verifications 复用冻结计划中的现有类型，登记定义与 oracle 完整正文同入生成/独审输入摘要及各自完整冻结读取证明。独审仅在当前 adopt_behavior/new_rule 已批准规则与具体不可改旧 oracle 断言互斥时用 needs_input/missing_fact，ruleLocation 为 oracle-policy:decision:<stableDecisionId>，codeLocation 为 <testPath>#<testId>，具体受影响 RULE/TR、AC、旧断言、新规则与同一反例完整保留。程序核唯一当前 requestRef/decision、精确 mandatory tuple 及 verification 登记；错误绑定为 review_invalid。此发现只诊断缺失可信输入，不授予修改 oracle、跳过命令或改回旧意图的权利；普通实现错误继续 repair，managed 业务测试沿现有契约授权演化。

专用 contract-omission 发现必须为 repair，精确引用已审 contracts 的仓库Spec路径与既有ID，且 affectedIds 包含该ID；错路径、未知/不关联ID或错分类均 review_invalid。它只请求既有受限refinement，不新增授权。普通修复诊断完整保留实际finding的规则/代码位置、证据、反例与信息，仍不作为新需求或批准证据。

contractOmissionBound为生成独审、协调器live与持久恢复共用的专用marker/path/existingID/affectedIds判断；旧contract:合法诊断仅可校验后撤销重细化权限，不作为新marker别名或授权。

P4 可在模型响应核 schema、计算 approvedSpecs 后调用可信 beforeFreezeCandidate。程序逐 entry 核 protectedReadPaths、原 files 和实际 allowedScope 的完整原字节/mode/OID/absence 未变，随后在发布组合树 freeze 并执行 V1/V2、实际候选独审；模型 prompt、beforeDigest/beforeMode、inputDigest 和行为分析仍绑定 original composed/readSet。闭包外真实已结算继承进入实际 candidate manifest/完整摘要，不能成为模型写权限；readonly 模型修改继续按原 scope 拒绝。
