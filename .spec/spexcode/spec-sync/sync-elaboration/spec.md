---
title: 业务契约细化与追踪
status: active
hue: 175
desc: 从高层原意生成可追踪的主流程与状态处置，经独立审查和有限修复，精确保留未知政策。
code:
  - spec-cli/src/sync/elaboration.ts#elaborate
  - spec-cli/src/sync/elaboration.ts#projectElaborationFlowReadiness
related:
  - spec-cli/src/sync/elaboration-orchestration.test.ts
  - spec-cli/src/sync/elaboration-target-binding.test.ts
---
# 业务契约细化与追踪

## raw source

从用户原意生成可完成主流程、适用状态事件处置、规则和验收；无法确认的重要业务政策成为 GAP，只阻塞依赖分支。

## expanded spec

生成与独审共同读取冻结技术写范围及只读测试清单。既有只读 oracle 继续执行；需要新增断言时，P1 先把 AC.test 绑定到原授权可写测试路径，不能把修改只读 oracle 的要求延后交给 P2。候选业务正文的待办/进度问题也须在 P1 普通 repair 修正。implementation-review 仅用于可在原授权实现/测试范围完成且无需改业务正文的实现修复；含此发现的原生 verdict 同样须为 repair，accept 仍严格要求无发现。

范围映射：REQ-SYNC-03、04；P1；AC-SYNC-01、02、03、08、14、25。实施依据为 `docs/spec-code-continuous-sync-plan.md`。本节点交付需求细化、声明追踪及独立语义审查；完整代码、运行验收和落盘由 [[sync-execution]] 与 [[sync-verification]] 继续完成，不能把细化通过作为已同步证明。

构建者产出 REQ→FLOW/STEP→RULE/TR→code→AC，独立审查者从原意重新走路径。每个适用状态×事件必须明确转移、拒绝、幂等或有依据的不适用。覆盖权限、边界、竞争顺序与副作用。图和覆盖投影只能派生自 [[sync-contract-schema]]；无状态能力须说明输入域、不变量和不适用依据。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。

`elaborate` 接收冻结的目标路径、节点身份、原文字节及摘要、用户原意、已有契约和有来源的事实；生成、审查都调用受限只读结构化会话，返回完整 Markdown 候选，交付写权限仍属于协调器。候选不得越过目标范围、更换源摘要或改写用户原意；无明确变更依据时保留既有 REQ、AC、VERIFY 和验证政策。[[sync-contract-evolution]] 在旧新全图核对稳定 ID，跨叶移动不当作删除。已有 AC 语义仅在合法规则变化及真实冻结、独立审查的行为分析授权 update_acceptance 后自动更新；生成器自身失败不构成授权。用户原意或可信裁决已决定退役或改变验证政策时，冻结 `authorizedChanges` 提供具体 ID、操作、来源及理由，程序允许该变化并由独立审查核对依据，无需再次批准。返回实际退役 ID，拒绝复用协调器提供的历史退役 ID；退役记录由后续协调交付持久化。新增裁决来源必须属于冻结事实或既有可信契约中的裁决 ID，不能由模型声明获得授权。每个业务项经来源与依赖能追到用户需求。

每轮先验证 [[elaboration-output]] 的结构，再调用 [[sync-contract-schema]] 解析与引用、完整性和状态矩阵检查；raw 段使用解析器的围栏感知结果，原文里的示例标题不成为正文分界。独立审查使用另一会话及线程，从原意、冻结事实、全部适用性和候选重新走路径。程序或审查的具体缺口触发有限修复；重要未知事实或业务冲突须先形成准确 GAP，不能自动编造政策消除错误。GAP 仅阻塞来源、规则和验收依赖闭包；确实位于同一 GAP 闭包中的未知状态事件处置和业务完整性发现保留为 `blockedStructureFindings`，独立流程仍由审查确认后输出可推进项。重复 ID、悬空引用、非法来源等全域结构错误不能借 GAP 豁免。

[[elaboration-result]] 保存各轮完整候选、生成与审查原始输出、具体发现、会话追踪及摘要。业务结构与独立审查通过后，根据 GAP 返回 `complete`、`needs_input` 或 `conflict`；安全能力不足为 `unsupported`，执行失败为 `failed`，取消为 `cancelled`，未消除失败且预算耗尽为 `exhausted`。总预算到期但原生停止未证实时，保留 `cancellation_pending` 原始错误和精确会话身份，结果为 failed；不得用 exhausted 掩盖未停稳或派发新原生会话。确认取消后，总预算才归为 exhausted。

这些均是细化阶段结果；`runtimeVerification: not_run`、`implementationReady: false` 不能作为已同步证据。尚无实现锚点或测试的具体缺口保留给 P2，不制造虚构 `code:` 或运行通过结论。

独立审查发现完整业务契约下的源码或测试缺陷时，用 `kind: repair`、规范 `code: implementation-review` 交给 P2；例如代码 TypeError、DTO 被当完整对象递归、修改返回值后按污染结构比较导致误断言，不触发业务细化或新 REQ/RULE/GAP。该发现必须关联当前契约图真实且非空的 affectedIds，并在 evidence 中提供冻结上下文中受治理 code 或 AC.test 的具体相对路径加符号或行号、失败反例；decision 明确仅修实现并保留业务义务。程序核对身份和冻结治理位置，绑定不成立仍作为具体阻断发现。原 review 完整留存，待实现发现保留受影响身份、位置、证据及修复决定；review 新增发现后刷新 deferredImplementationFindings。任意自定义业务 repair、真实遗漏边界、重大未知和冲突继续按原门禁处理；reviewPassed 仅表示业务独审通过，不是运行通过。仅有待实现发现的候选不能成为要求具体业务阻断的 repair seed。AC-ELABORATION-41–43 覆盖完整契约不变与实现证据延后、位置/身份不合法的硬拒和混合业务缺口阻断。

编排回归由 `AC-ELABORATION-01` 至 `AC-ELABORATION-31` 覆盖解析/矩阵/独立审查、状态缺支修复、语义发现修复、GAP 独立分支、冲突证据、路径/摘要/raw 边界、既有验收保护、无效结构与重复会话、待实现证据、伪造裁决、安全失败/取消、输入冻结、合法退役、验证政策演进、围栏原意、未知矩阵单元、调用/总时间预算、行 schema、固定格式渲染、幂等预算身份及字符/argv 转义、未停稳取消、证据支持的可覆盖默认超时、真实 GAP 候选的父流程聚合及已结算拒绝候选的摘要/输入/原生审查追踪核对、渲染升级和新独立审查，以及 GAP 仅影响 TR 时经派发步骤传递的父流程阻塞、旧种子在当前结构检查新增缺口后的准确修复反馈。注入 runner 仅用于控制这些编排路径；P1 的真实 Agent 自然语言细化验收仍由完整产品链路单独验证。

可选 verifications 是与 facts 分开的可信执行器登记；schema/解析器及唯一性在派发前校验，登记冻结进入输入摘要。候选 VERIFY 的 id/argv/cwd/timeout 与 AC.command 经程序逐项核对全契约图，未登记或漂移是具体可修复错误，不能以 GAP 豁免或进入独立审查。执行器怎样启动命令/汇总、generated 测试不自启 oracle 等技术职责不额外生成导出业务规则和验收。登记不替代既有契约变更授权，也不证明运行通过。AC-ELABORATION-32–34 验证非法登记零派发、错输出在 review 前拒绝、合法独立登记冻结与无作者假 GAP，原31项业务GAP/独立审查回归保持。

节点生命周期由冻结 nodeChanges 记录 move/retire、旧新 canonical 定位与 evidenceRef，程序复制到候选及结果，独审同时读取旧新正文和授权。节点改名继续复用共享 mintIds 得到新定位身份，业务 ID 保持；move raw 原样保留，旧位置删除和 authority 重定向参与全图检查。退役逐项覆盖既有契约授权并清理引用。preserve_business 仅刷新必要实现和测试符号，沿用业务正文与字段；reelaborate 的变化仍受已接受意图保护。即使所有 AC 退役，旧新节点并集仍接受 schema、授权、引用及历史身份检查，不把空集合当验证通过。

已有合法用户编辑可由同一真实冻结独审分析中的程序作者差量证明，必须对应当前节点原意和来源闭包，不能让要求重复变更阻碍自动反写。P1 的新审查还须独立于行为分析的既有会话和线程；具体裁决须通过新的当前版本独审分析结算，未选冲突继续阻其依赖分支，不能靠塞入任意 decision 事实跳过旧发现。

实现独审指出已确定原意下的遗漏边界时，可携冻结 refinement（已接受候选摘要及具体诊断）重新细化，诊断不是事实或授权。程序保持全部既有稳定身份、raw/REQ、RULE政策、AC/VERIFY及原业务说明；FLOW/STEP/TR等详细逻辑允许在原意支持下增补，把新增失败出口与边界实际接到主流程，不能删除旧义务或改为不适用逃检查；不得把实现失败转成新政策、删除义务或 GAP。新候选须再次结构检查和独立审查后成为生成基线。

可信 VERIFY 登记在独立技术渲染上下文校验，不继承 preserve_business 或节点生命周期模式；真实候选继续保持原来的业务模式。P1 业务正文不保存本轮 V3 状态，验证状态与结果由执行证据表达。

冻结输入与摘要包含结构化 decisionAuthorities。契约变更在任何模型派发前核对所选裁决目标及来源闭包；接受候选时再核对实际 RULE/REQ/TR/AC 等变化和退役范围。历史 decision 事实、模型 claims、假 user:raw 或候选新增依赖边均不能扩大对旧义务的授权；未选分歧继续保留自己的阻塞与证据。

实际作者 raw-only 编辑与当前裁决相容时，可依据具体独审验收提案、合法 REQ 来源和真实作者差量结算；不把父 raw 的依赖闭包变成未选规则的通行证。三方 raw 整合使用程序冻结、独审绑定的精确字节证明；派发前与候选接受时均核对本轮冻结原意，保留真实作者原字节。

现行生成只使用 [[elaboration-output]] 的目标绑定 v3 行差量，程序从冻结 Markdown 重建完整唯一候选；独立审查与原 raw、REQ/AC/VERIFY、稳定 ID、节点生命周期和全图演进门禁继续读取完整输入和候选。失败 seed 仅供诊断：历史 v1/v2 路径回显输出不能用当前目标绑定渲染器重放，原拒绝候选按既有摘要与会话追踪读取并明确标识，绝不成为事实或新基线，原持久结果和历史摘要不改写。v3 repair seed 仍按当前 targetIndex、类型和冻结目标绑定校验；仅 RULE.authority 保留原生字符串供诊断重放，随后由当前候选全图校验保留真实权威归属错误。这些未批准的 seed 字段不扩充新生成 schema，也不授予权威。修复反馈按现有判断分为当前阻断、P2 待实现证据与已有 GAP 闭包阻断；缺代码/测试不得要求在 P1 造 GAP、放宽政策或把新断言挪绑旧测试。AC-ELABORATION-35–37 验证差量独审仍看到完整义务、历史诊断隔离和修复分类。

AC-ELABORATION-38–40 验证空 changes 的完整既有目标、只返回子叶差量时省略 primary/其他既有叶、及新/raw-only目标省略拒绝；真实节点 move 的空行差量仍按冻结生命周期迁移 RULE authority，未授权改名保持 scope 拒绝。


已解决裁决诊断的删除由[[sync-contract-evolution]]从旧图、精确当前独审裁决和实际候选确认。checkCandidate保留此次确证删除的GAP身份；仅在完整P1结构检查与新独审通过后并入既有retiredIds，未批准或仍未解决的候选不记录退役。后续协调验证、receipt和baseline沿原字段累计身份并阻止未来复用，不新增用户业务退役提案。

显式历史补偿的 restore 是既有 authorizedChanges 的精确动作：仅可信 revert 入口从原 settled receipt、真实 parent 和不可变 sync.history 请求导出同一历史对象。程序重核原路径、身份与业务字段；普通 raw、模型分析或伪 source 字符串不能批准恢复。精确恢复仍经过当前结构、独审、代码和运行验证；新业务复用退役身份继续拒绝。

冻结目标或上下文没有真实非空 raw 段时，缺席保持 null；本轮 raw 政策只登记调用者冻结的非空原意，不用空字符串授权或把解析器的整段 body fallback 当作原意。候选对照真实分段 raw：未变 rawless 节点不得误报 raw_changed，真实非空 raw 仍须原字节保留。无 schema 的旧节点仍必须显式细化；rawless 节点新增 user:raw 业务行继续由 missing-raw-source 拒绝，不能借沿用旧正文扩张业务来源授权。

目标绑定 v3 的 targetIndex 只引用本次冻结 targets 的原数组位置，wire 显式附该下标；完整业务 inputDigest 保持原冻结结构，实际 prompt/schema 继续由 requestDigest 绑定。生成 prompt 列出本轮须显式构建的目标数量和原数组下标；输出必须是完整、可解析的结构化对象，但 changes 的 schema 最低数量为零，使合法部分输出也能形成诊断候选。输出不回显 nodeId/path，程序沿同一目标和明确生命周期补入身份；retire 留洞、move 绑定新定位。程序继续逐项检查目标覆盖，遗漏新目标、raw-only 目标或无 sync-v1 契约的目标产生 `target_not_elaborated` 并阻止独审及交付；数量、索引范围和已结算 seed 均不豁免该门禁。


分区输入的intent允许属于冻结只读context而不属于targets；该上层原意全文仍必须存在，raw不改变。本区targets非空且身份、路径、摘要及原有授权检查保持；只读原意节点不要求出现在本区changes，也不获得写权。可信验证登记的纯技术校验可取本区首个目标作临时渲染，不改变实际契约writer。


分区编排复用 [[sync-partitioning]] 的唯一分类证据及冻结phase；初始raw-only父和既有业务仅含REQ/RULE/GAP且可附精确可信VERIFY的纯父，在没有自身源码writer、真实raw非空且当前计划含真实后代实现目标时，都用`interface_seed`生成或维护必要接口；已有FLOW/AC等实施内容的富父继续按正常P1核对。重复全量同步或父raw追加不能让已完成父重新承担子实现正文，也不能丢弃旧REQ/RULE/GAP、稳定ID或演进授权；removeIds仅限本目标已核验的精确retire集合，完整候选与严格全图seal仍核原意、引用、权威及全部子承接。纯父按祖先层级先独审；中间父以自己的真实raw绑定局部intent，并只读已审祖先接口，同层独立纯父可并行，全部纯父结算后再并行叶分区。原始计划、分区身份、独审分析ref及分类证据进入局部输入摘要和结果，不把分类路径证明当作已读取子源码正文。可由不同子目标独立承接的意图拆成独立REQ，避免每条跨边审查都依赖兄弟实现；Seed保持原raw、code和related，禁止新增源码、测试或实现就绪声明；独立语义审查只审接口，不要求父节点拥有FLOW/AC或子叶代码；冻结可信VERIFY登记仍保留供完整只读祖先的AC/VERIFY核验，seed自身的schema继续禁止新增AC/VERIFY，既有精确可信VERIFY按行差量原样保留。局部叶若读取多层只读祖先接口，必须在自身FLOW.req和AC.covers直接引用全部实际承接的祖先REQ；只引用最近一级无法满足最终全图完整性，也不能把兄弟REQ加入当前叶。本叶实际执行的祖先RULE须在AC.covers直接承接，或通过本叶TR.rules及覆盖该TR的AC承接；同义子RULE不能替代父RULE的真实验收覆盖，不要求不适用或兄弟规则。既有AC改变仍受原冻结演进授权约束。没有活跃子实现目标时仍按完整P1和既有readonly_implementation_gap门禁处理。Seed状态不得投影为全局ready或完整P1。

普通非分区细化与合并后的partition seal都对完整冻结图执行final completeness检查；只有带冻结`validationScope: partition_local`的分区子候选，才把只读context的源码/测试完整性留给之后的全局seal。该技术范围参与inputDigest，不能从模型输出取得，也不能把局部结果当全局ready。

显式空 implementationWritePaths 表示本轮只观察既有实现（code→spec）。生成和独审均不得将缺代码、测试文件或用例延后交给 P2；这些缺口保留为具体 readonly_implementation_gap 并阻止细化通过，不能虚构新测试、编造业务GAP或弱化验收。已有完整实现/测试仍按原结构与独审门禁通过。

纯父已有VERIFY可在本target合法update_verification经原checkInput授权门禁核验后进入接口更新，即使旧定义不同于本轮新登记。程序只从冻结登记补入该已有ID的精确新技术行，模型仍不得选择VERIFY；原候选演进、登记一致性与独审完整执行，无授权或伪授权漂移拒绝。已保存raw与空行差量不吞掉技术更新，也不允许通过技术投影改变业务或用户原意。
