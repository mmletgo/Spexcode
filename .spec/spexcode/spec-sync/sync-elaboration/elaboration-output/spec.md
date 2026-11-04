---
title: 细化结构化输出与独立审查约束
status: pending
desc: 模型输出和审查输出的严格结构，以及冻结 sync-v1 Markdown 生成契约。
code:
  - spec-cli/src/sync/elaboration-schema.ts
---
# 细化结构化输出与独立审查约束

## raw source

结构化执行必须能程序检查完整候选和独立审查，不能接受一段完成声明作为契约。

## expanded spec

原生 code/related 字段说明明确沿用仓库文件关系语义：code 最多治理一个源文件基路径，related 是补充文件/目录关系，节点或 REQ/FLOW/RULE/VERIFY 等业务 ID 不是文件路径。完整候选仍经 [[spec-lint]] 同源关系完整性门禁，不把字段说明当作验证证据。

review verdict 的原生说明明确 accept 仅可搭配空 findings；implementation-review 等待修发现也使用 repair，再由现有分类门禁转交对应阶段，不把矛盾回执自动改成通过。code字段说明完整业务契约下的实现/测试发现使用精确`code:"implementation-review"`及repair分类/结论，不能添加后缀或自定实现code；普通业务repair保留具体业务code并在P1修复。此说明不改变string/minLength约束、schema接受范围或既有精确分类门禁。

模型临时输出 `elaboration-target-rows-v3`：冻结目标的输入内 targetIndex、标题和说明、真实代码/相关绑定、业务解释（null 表示沿用）、显式 removeIds、各类型新增或替换的完整业务行，以及每个适用性边界的依据和影响 ID。模型不返回 nodeId/path；wire 为每个冻结目标附原数组下标 targetIndex，程序从同一冻结目标及显式 nodeChanges 唯一绑定节点、可写路径、原意和源摘要。全部类型数组均存在，空数组表示无该表；行对象的列直接派生自解析器 `CONTRACT_COLUMNS`，不复制另一份列定义。严格 schema 约束稳定 ID、单一来源、引用数组、布尔值、VERIFY argv 和正整数超时；`STEP.next` 的 END 单值不能混入 ID 列表。有状态流程引用 STATE 结果，不能把同步动作当成无状态能力。

生成与独审指令明确区分临时 JSON 行和最终 Markdown：模型提供所有 schema 必填列，引用集合使用 JSON 数组，布尔使用 boolean，schema 允许 null 的列使用 null 表达空值；不适用的 `TR.to` 明确为 null，不能省略或填空字符串、字符串 `-`。表头、Markdown 空值 `-` 与逗号分隔引用由程序渲染，不能将最终文件语法作为模型 JSON 的值约定。严格 schema 接受范围及完整候选、全图和独审门槛不变。 AC-ELABORATION-21 先以当前 v3 wire 校验合法基线，再核字段负例确实在业务行内被拒绝；不适用 TR 的 null 经绑定、渲染及契约解析后仍为 null，不能以旧协议版本错误冒充字段校验覆盖。

`RULE.authority` 的生成请求 schema 仅接受本轮冻结可写 target 的 canonical `nodeId`，不能接受 REQ/RULE 业务 ID。合法 move 中，冻结旧节点已有 `authority` 等于其 `from.nodeId` 的 RULE 时，schema 还保留该旧 `nodeId`，供 renderer 按真实 `nodeChanges` 归一到目的身份；最终 owner 仍由现有逐项校验确认，enum 不授予跨叶归属。没有可写 target 时不产生空 enum。

`interface_seed` 是分区编排内部的父接口schema：只允许REQ/RULE/GAP行，不允许新增FLOW/STEP/AC/VERIFY；既有精确匹配冻结登记的技术VERIFY由程序沿用而非模型重选；首次raw-only或既有纯接口均沿用同一行差量和旧新演进门禁。既有条目默认保留，removeIds仅可取本目标已有且经输入门禁核验的显式retire授权ID，schema以精确enum和数量限域；无合法退役授权时仍为零项且不产生空enum。code/related严格沿用冻结父节点绑定，空绑定用`maxItems:0`和普通string items约束，不生成空enum。

完整P1生成指令要求每个业务 REQ 至少由一个主 FLOW.req 覆盖；interface_seed只生成必要共享REQ/RULE/GAP，不向生成或独审下发完整FLOW/状态矩阵/AC展开任务，其覆盖仍由后续子区和严格全局seal证明。共用行差量、列/null、来源、授权及原意保护规则复用同一指令段；父接口不新增VERIFY/AC，精确可信技术行由程序保留。description/prose同样只保存稳定业务说明，不写本轮修复或候选changelog。阶段分离不允许父条款错误、矛盾或无来源通过。验证配置、写路径授权、执行器/schema 和本轮元数据属于执行边界，不另造业务 REQ 或测试执行 FLOW；这些边界仍须遵守，测试和验证绑定在业务 AC/可信 VERIFY 中，不能因此省略 raw 里的业务需求。

状态派发 STEP 须以 next、depends-on 或 source 显式关联实际执行或选择的 TR，并声明对应 EVENT；集合须忠实覆盖该步骤声明的对象、状态域和条件分支，不能只列已确定处置掩盖同一步里的未决处置。纯参数校验、提交和导航步骤不强求 TR；不反推无关事件的全部状态。next→TR 是业务依赖；next→STEP/STATE 和 FLOW.steps 仍为导航。独立审查核对派发表与步骤声明的范围，不能因正文提到 GAP 就跳过结构依赖，或把含未知派发的父 FLOW 当作完整可交付。

[[elaboration-markdown]] 从这些临时行确定性渲染唯一可编辑的 [[sync-contract-schema]] Markdown。原文、源摘要、输入和候选摘要由程序复制绑定，不交由模型填写。生成行只是一次执行的受检中间产物，不能持久化为第二份权威业务 JSON。返回候选仍为完整 UTF-8 Markdown 文件变更。

raw、事实及权威业务规则优先。重大未知仅指权限/资金/业务权益、数据范围、保留删除义务、不可逆副作用、竞争胜负、重复执行语义或业务承诺；实际意图冲突也须明确 GAP。现存无冲突错误协议、普通参数/字段表示、序列化和等价校验顺序等实现细节可沿用 code 来源并追到 REQ，不能冒充 decision，也不制造 GAP。“可观察”本身不等于重大政策。实现若违反明确 raw/facts，保留要求并修实现，不能用 GAP 掩盖矛盾。生成及审查须重新核实旧发现是否有原意/事实/对应代码支持，不照单全收误判。修复只改变已核实缺口及其直接依赖，逐条保留未受影响且符合 raw/facts 的既有验收细分断言；不能将断言移为前置条件或缩为部分效果。

权限、写入、异步、网络、并发、回调、重试、取消、幂等和外部副作用都须唯一标明适用或不适用及依据；适用项关联已定义业务 ID。独立评审输出由程序绑定输入及候选摘要，逐项检查全部边界，并把具体发现区分为可修复缺口、缺失业务事实或业务冲突，附证据、影响和裁决问题。

严格 schema 拒绝缺字段、未知字段、错误类型及无效枚举；空集合保留合法的普通items schema与零项上限，不构造非法空enum。即使注入执行器也执行相同输出边界检查。任何非接受结论必须有具体发现；接受结论不得仍带未解决发现。

可信输入登记 schema 复用 VERIFY 行的 ID、argv、cwd 与超时属性；登记还经唯一 Markdown 渲染及契约解析器检查安全 cwd、直接工具 argv、转义与唯一 ID。三段 ID 不合法、shell/空/换行 argv、越界 cwd、非法超时或重复登记在任何 native 派发前拒绝。模型输出若提供独立登记，VERIFY 与 AC.command 必须引用并精确符合登记，不得自造占位或改命令/预算。CONTRACT_INSTRUCTIONS 区分业务规则与执行器编排：测试不自行启动 runner/oracle，不能将这些明确技术职责发明成业务 REQ/RULE/AC 或业务 GAP；真实业务 GAP 仍完整保留。

生成与独审共用的来源说明须与 [[sync-contract-evolution]] 一致：普通 raw 需求使用 user:raw，其他合法冻结 code/derived 来源继续沿用。当前精确已独审裁决合法改变 REQ 意义时，REQ.source 必须为当前 decision:stableDecisionId；共享上游 REQ 仍受旧规则直接来源、原 affected、同一 allowed_change 与实质政策变化见证限制，不能只写 RULE basis 或反向依赖造循环。明确 REQ-only 且无旧政策的裁决不强制虚构规则；keep 保持原来源和业务意义，未选义务不变。AC-ELABORATION-44 用受控生成读取实际派发指令、完整候选门禁及独审捕获验证来源说明一致，user:raw 改义和仅换规则来源仍拒绝；它不替代真实 native 产品验收。

Native worktree P1生成和独审复用同一来源说明中的短来源语义；不因此把完整行、流程或验证指令加入提示，也不改变`interface_seed`对父层范围的限制。父阶段未由raw/facts确定的普通字段表示、缺省值与等价校验顺序留给后续子分区细化，具体阶段边界见[[sync-elaboration]]。

生成 schema 字段说明与共用指令明确沿用 [[sync-contract-schema]] 的引用语义：STEP.rules 和 TR.rules 只能引用已定义 RULE，不能放入 REQ 或其他类型；user:raw 只是原文来源，decision/code 来源本身也不建立需求依赖边。除 REQ 自身外，每个业务项须沿实际 depends-on 或 user:REQ、rule:RULE、derived 来源引用追到 REQ，不能以正文提及原意替代图路径。提供可信登记时，AC.command 引用的 ID 若尚无只读或候选 VERIFY 行，须按精确冻结登记定义该行；登记 JSON 本身不是契约行。说明不改变原 schema 接受范围、引用类型校验、追溯门禁或独审标准。

changes 允许空数组表达无行差量或已冻结的全节点退役：既有完整契约目标由程序补全；新/raw-only目标仍须显式构建，空输出自身不授权删除；节点生命周期从调用者 nodeChanges 程序复制并在全图确认。独立审查看到旧新路径、原文及逐项授权；不能因当前 active AC 数量为零跳过旧契约及退役检查。既有验收更新要求 update_acceptance 引用变化 ruleIds 和真实独审分析；普通无冲突反写可自动更新，模型自身失败不能转成要求。pure refactor/preserve_business 保留业务正文和字段，仅更新必要绑定。

业务行中的 `source=code` 必须以相对路径和 `#symbol` 指向冻结源码中的真实声明；测试用例稳定 ID 只写入 `AC.test`，不能当成代码符号。

P1 的 prose 和持久契约只写业务约定；V3 尚未运行、通过或失败等本轮状态与生成进度查冻结执行证据，不得写进业务正文成为持久政策。

每轮 tables 差量相对于本轮权威冻结 Markdown：未列行由程序保留，removeIds 只删除该节点明确列出的旧行并继续受原授权约束；完整候选及全图而非差量交给独立审查和所有旧新门禁。新节点与 raw-only 输入以空行基线首次构建同一协议，不增加另一条全量生成路径。已持久失败 seed 的旧 v1/v2 路径回显输出只按原 schema、候选摘要和追踪读取诊断，不用当前目标绑定重新改写历史候选，也不成为新生成输出或权威合成基线。

派发 schema 把 targetIndex 限为原冻结数组的整数范围；索引不排序或压缩，move 绑定目的身份，retire 下标留洞并由输出 schema 拒绝，具体结构发现进入既有有限修复循环，不能因绑定异常提前跳过剩余修复预算。生成 prompt 使用同一冻结目标绑定分别列出全部合法可更新目标及原数组下标、首次必须构建的子集，并要求形成一个完整、可解析的紧凑 JSON 对象；新草稿协议写入指定Git文件、final仅返回小summary，历史只读协议仍通过final传回完整JSON；首次必建0不代表禁止更新已有目标，既有完整契约仅在本轮确无相关业务差量和已核实必要修复时可省略。changes 的 `minItems` 固定为零，`maxItems` 仍限制为合法目标数，以便合法但不完整的输出经过绑定和渲染后形成具体诊断候选。程序逐项核对所有目标；新目标、raw-only 或无已解析 sync-v1 契约的目标缺失时，报告 `target_not_elaborated` 并阻止独审及交付。最低数量不取代该硬门禁；重复/未知身份、额外 path 字段、索引越界和退役索引仍按结构规则拒绝，完整候选、全图与独审门禁保持。已结算 seed 仍仅为诊断，不作生成基线。


implementationWritePaths 显式为空时，生成与独审说明本轮源码及全部测试只读。AC.test 只能绑定冻结上下文中真实文件和用例，不把新测试或实现修复留给 P2；技术缺证不改写业务原意。

提供冻结verifications且只读context已有技术登记时，生成VERIFY.id只可取当前登记且未在只读context中定义的ID；全部已在context时VERIFY差量为零项，AC.command直接引用已有技术定义，不复制只读owner。不同分区首次各自声明同一精确登记不改变业务授权，全部局部独审后由[[sync-partition-execution]]确定唯一owner；非精确登记、命令漂移和重复业务ID仍受原硬门禁。

纯父既有VERIFY与本轮新登记不同，但本target拥有经过原输入授权核验的合法update_verification时，可保留旧定义进入同一接口更新；无授权或伪造授权仍拒绝。seed模型schema仍禁止所有VERIFY差量，程序只对该target已有且合法授权的ID，从精确冻结登记补入更新行，独立审查看到完整新候选。既有验证政策的完整演进与registration检查仍要求授权和新定义精确匹配，不开放任意技术行选择。


共用行差量指令明确reelaborate按本轮raw/facts、authorizedChanges及具体repair核实必要更新，不能仅复制raw或返回空changes保留已核实失配；未批准诊断和授权字段不增加权限，也不强制改动已符合要求的行。合法目标数仍只控制maxItems与原targetIndex范围，minItems保持0，partial/空输出、首次目标遗漏、raw/授权及独审门不改变。interface_seed仍仅REQ/RULE/GAP，retire留洞、move原index及只读context排除继续共用既有绑定。
