---
title: 持续同步中央编排
status: active
hue: 175
desc: 从稳定输入经独立细化生成及四层验证结算真实私有交付。
code:
  - spec-cli/src/sync/coordinator.ts
---
# 持续同步中央编排

## raw source

一次高层需求应自动完成可信细化、实现、真实验收和可复核交付；暂停、取消、进程中断和输入变化不能重复副作用或用旧结果覆盖新输入。

## expanded spec

P2 的 V1 把实际验证 candidate tree 的完整 entry 路径清单交给 [[sync-frozen-contracts]]，与冻结正文共同核前元数据关系完整性。模型可读正文子集不能被当作完整存在性清单；错误 related/code/one-govern 在生成修复阶段拒绝，不推进 V2、V3 或 apply journal。

派发 P1 时由同一冻结 plan.writePaths 和 mandatoryTests 派生显式技术写范围与只读测试文件清单，供生成及独审正确绑定新增测试；不改变原写授权、实际 scope、只读 oracle 或预算。

P4 接入在同一真实快照上冻结完整资源基线选择及实际执行范围；读取/保护集合、生成授权和写入/验收覆盖分别保留，不能用目录授权取得整个目录的写锁。资源选择参与组合与读集合摘要，尚未建立的基线显式为 null；既有 P3 操作按原冻结成对基线恢复；没有精确资源选择时保留原writePaths目录准入范围，只有精确选择接入才默认采用plan.executionScope，显式可信重试范围仍优先。后台观察和显式入口共用这一接入动作。

精确操作的当前输入判据比较完整物理身份/分支及实际读写闭包的 working、HEAD 与 index 对象；无关文件或无关提交不会使本节点证据过期，也不会进入候选。闭包内编辑、成员增删、index 或 HEAD 对象变化仍立即过期。状态查询、重试资格与交付 V4 复用同一判据，既有 P3 冻结操作继续使用完整快照 ID。

P4 派发先由应用消费真实 protocol FIFO 头并事务确认到持久 queued，协调器只按已确认记录与 revision 领取；内部有限修复/过期原 attempt 用显式 continuation，同一预算族不重置。未确认、前序或租约冲突返回 busy，不当成永久失败或另造消息。物理暂停由安全边界和 heartbeat 停止新阶段，结算真实资源后返回暂停位置，保持单操作 control 与检查点；全局恢复不能解除用户另行设置的单操作暂停。已登记 applying 继续原短写单元完整性结算。

P1 只把实际目标正文及其已审代码/可写验收路径、业务 ID 加入执行范围；只读上下文的声明不取得覆盖或写锁。新增资源由同一 fence 事务取得精确选择及租约，再从原不可变输入重组并绑定新 readSet。阶段复用保原选择与 readSet 证据：仅追加 null 资源且原绑定不变可沿用已审义务；真实组合字节变化或引入既有非 null 基线时，在原预算内重新分析。V1–V4、验证 blob 与 apply 均绑定最终选择。目标及退役历史按各文件的实际交付头读取，不能借另一个资源的全局最新交付作为作者来源。构造分区历史上下文时，协调器用[[code-anchor]]共享路径匹配器展开旧code/related/测试/源码义务并逐entry核对全局read授权；命中旧entry但超出冻结全局readPaths时明确拒绝，不能让局部glob投影绕过授权。

生成可独立并行；结构化生成响应核验后才取得同来源发布 mutex，冻结 [[sync-publication-base]]，随后独审、真实验证和完整交付针对同一实际组合树。只读上下文保持当前冻结 source 的 bytes/mode/absence，不成为模型写权。闭包外的已结算组件只作可继承交付，不进入本轮业务覆盖；结构检查只重读实际影响闭包与本轮修改，不能把继承节点冒作本轮新增需求。发布父树及 provenance 参与 contextDigest；恢复保原冻结父树与 journal，不读取 latest 换候选。失败或安全边界释放本机 mutex，持久门禁负责跨进程的已冻结发布次序。

复用现有快照、成对 composition、受控 request overlay、P1 elaborate、scope 扩充/租约、generation、真实 V3 resource 执行与 private delivery，不另建消息队列、契约图或事实数据库。原 source/composed/candidate 分开，policy/readset 内容摘要必须绑定 operation。读集合完整保留契约及 source/code/related/AC 测试全文，不以2MiB内联限制拒绝或截断。超大阶段正文由 [[frozen-context-reader]] 在正式派发摘要前无损冻结，各独立turn核完整读取证明，仍保原input/readSet/policy和总预算。host private、越界路径、目录未授权字节拒绝。

operation 独立本机 kernel mutex 防双 coordinator；紧凑 stage checkpoint 只保存 refs、独立结果及诊断，不复制整张契约图。当前 attempt 在独占证明下重入稳定 requestKey，派发前原子计费、持久资源意图，完整真实结果/hash/独立身份保存后重放。lease heartbeat 贯穿原生长调用，控制/总deadline触发 Abort；旧 generation 只能结算真实资源证据。历史未removed资源精确恢复，未知终态保留 recovery_required，不假释放容量。

P1 已审结构结果登记所有未来业务 ID，包括 GAP/partial FLOW；ready/blocked 分区只隔离业务 ID，共享 paths 留 ready。无可执行 ready AC 不生成或写半成品；V1 仅容许已审 GAP 精确解释的缺口。generation 硬门禁保护 raw/全局REQ/AC/VERIFY、实际diff与独立oracle，V2使用不同会话；V3仅执行 ready AC 和 mandatoryTests 的固定命令/镜像；V4复采完整source、当前可信plan/readset与物理身份，一致才可交付，并于 beginApply 前再核。完整V1–V4 pass才 recordVerification(pass)，范围精确ready声明/完整FLOW，不包含blocked。

失败通过新attempt有限修复，冻结预算、deadline及政策不重置，诊断不能升格为事实；环境unsupported、真正业务 GAP/conflict、未知资源恢复停止自动重跑。候选冻结后不覆盖；applying/receipt恢复优先既定交付，真实Git commit及DB未结算不会再生成或重复提交。仅receipt结算可推进成对baseline和deliveredScope，根有blockedReason保持needs_input/conflicted。

P1 续修种子仅取完整结算的具体业务拒绝轮（repair_budget_exhausted）。模型容量或原生执行等基础设施失败不构成业务拒绝，即使保留了合法候选、语义审查 warning 或 deferredImplementation 缺测试 error；连续执行及 checkpoint 恢复均清空旧 seed，在原预算/deadline/冻结输入内用新 attempt 重新生成及独立审查，不批准未审候选或沿用旧 review。此前真正业务拒绝的 seed 继续沿既有严格校验修复；无具体业务拒绝的种子仍被拒绝，取消及总预算耗尽不新增派发。

freezeSyncPlanEvidence复用同一canonical JSON排序，使planBlob.sha256严格等于policyDigest；接入直接保存plan引用，queued恢复不依赖另一个索引文件。派生authorProjection仅规范化已核canonical managed文本，真实snapshot不变；受控Spec输入与代码行为分析共用冻结计划和交付链。阶段result及嵌套refs直接checkpoint保活，不能只pin wrapper。

同operation/input/policy首个P1结构及独立评审通过的细化结果作为普通实现修复的冻结义务；code/V3修复的新attempt与进程重启复用精确结果，并checkpoint原attempt/result evidence provenance。真正绑定的contract-omission可经新P1结构与独立评审批准增补已明确原意的必要边界，后续普通修复冻结该合法增补链；稳定AC/ID/政策不被弱化。P1本身未通过时沿原续修语义处理；通过后清空失败seed，未通过旧seed不能复活。

initial与spec共享P2入口。旧无planBlob operation先claim持久unsupported，不借当前plan猜恢复。终态/controlled操作只精确消费自己的stopped FIFO头；有效queued头由应用FIFO调度，中央重入不把顺序冲突误报成永久unsupported，也不跳过有效pending。

受控Spec requestBlob必须绑定真实input/path；业务decision必须携带绑定原分析、具体finding与所选规则的裁决输入。仅来源标记不构成修改原意的授权；code/combined/reconcile通过下述行为分析和独立审查决定后续义务。

交付准备后beforeApply再核V4；input/policy/readset变化先以当前fence登记精确conflict，再抛原错误供private-delivery保留，不能变成笼统environment。deadline真实耗尽保存budget_exhausted；controlled/过期旧fence不能借guard重新取得写权。

运行及恢复只查询operation所属repositoryId的真实FIFO地址；不扫描global head后按仓库过滤，也不跨仓库运行另一项目的原生后端。

默认租约120秒，heartbeat最多5秒且小于lease，总deadline与预算不因租约调整改变。持权细化/生成阶段边界先renewLease门禁再setImmediate给控制/heartbeat一次执行机会，再核控制和fence；长native调用由heartbeat续约/Abort，已过期authority绝不能恢复。该窗口覆盖实际同步Git/Tree-sitter可信读取阶段。

显式retryOf沿真实operation链读取同source/input/policy/request的持久accepted P1证据；保留原approved contract/AC及原attempt/evidence provenance，不重新细化弱化AC。只有链上从未approved时才P1新派发；新operation重新执行generation/V1-V4，不借旧fence或receipt发布。

P4 显式重试按原 operation 已审扩展后的 scope 及最终 selection 重组同一 readSet，复用原 impactDigest；冻结 planBlob 和 policyDigest 不被扩展结果改写。原严格接入事务仍拒绝缺失路径、改变义务或不匹配的读取/选择，不能以重试丢弃已批准的实现范围。

recoveryOnly在独占mutex后先于普通phase/claim运行：精确终止所有历史未removed资源，再仅恢复当前attempt已存在且绑定delivery的未settled journal。Docker恢复driver拒绝create/start，planned容器不存在保留未知恢复状态，不新建容器补齐。原生资源只以aborted既有请求桥取真实stop证据；无journal即使verified也不进入prepare/apply。错误返回recovery_required及诊断而不自动pause/run、扣budget或新建attempt；已有journal结算可登记真实receipt/原结论。

code/combined/reconcile及已共同验证基线上的外部代码差量、真实作者raw/规则差量、文本重叠进入 [[sync-code-behavior]] analyzing独审；不再以来源标记或Git重叠直接unsupported/conflict。分析完整binding核对后存同attempt checkpoint，派生facts/AC授权/nodeChanges作为执行上下文，不修改冻结plan/policyDigest。具有关联业务ID的真正conflict/GAP经既有dependencyClosure阻依赖，完整FLOW受阻但独立ready分支仍生成与四层验证，receipt覆盖不含blocked。

raw-only 初始化允许的空 affectedIds 不能被解释为没有阻塞。完整分析独审已通过且正式 checkpoint 持久后，若真实 blocking finding 仍未关联既有契约 ID，则在 P1/facts/生成之前按 conflict 或 missing_input 记录明确业务失败，保原 finding 完整正文及 analysis 证据引用；不把它转 allowed_change、补假业务 ID、生成 derived:undefined 或以空 closure 放行。该失败停止自动修复尝试，不增加 P1/生成/验证或 journal。无 blocking finding 的初始化仍正常交 P1；已有 ID 的发现继续使用原依赖闭包与独立 ready 分支机制。

节点移动以旧from正文为细化输入、新to为候选位置，完整规范node universe保持mintIds语义及业务ID连续。明确退役保旧新范围与负向测试义务；没有active AC时只有具体已授权退役AC仍执行固定命令及旧test ID才可推进，不靠空验收通过。retiredIds/decisionRefs仅真实receipt结算累计。

三种裁决作为新immutable operation进入分析，保旧分析/ref/具体finding历史，绑定新input/policy/readset独审。只有adopt_behavior保所选外部行为，keep_intent及new_rule按对应明确意图修实现；未选分歧不被顺便采用。分析、裁决与细化证据都进入contextDigest，V4仍核原source和当前可信政策。

原裁决分析的归属以真实analysis stage绑定定位所属attempt，取其composedInput作为同内容Git指针并核原inputId及analysis.composedDigest。合法null资源扩充可替换该指针的selection元数据但不改变完整树内容，不能把新composition证据配旧selection核验。临时传入行为分析的原读取范围由原冻结plan.readPaths及该stage原selection的path资源复原，不用当前扩充scope扩大原独审图；原计划仍须绑定旧policyDigest。不增加持久字段或把该图升格verifiedDelivery。

已接受契约为普通生成修复的冻结义务。独立code review明确contract-omission:path#existingID且通过已审路径/ID/affectedIds绑定时，保留失败candidate及已接受完整正文的refinement checkpoint，在同预算的新attempt回P1；诊断不是fact/批准。再次细化只补已确定原意下的新必要边界，既有REQ/AC/VERIFY及全部业务义务不被弱化；真正重大未知仍GAP。node生命周期与此路径独立结算，不能用修复扩大迁移授权。

行为独审完整findings决定阻断；用户选中过的历史ID不能清除新审查同ID发现。作者基准识别实际Git采纳的前次交付，明确raw/TR变更进入独立分析，交付回声不授权新业务。移动及公开删除沿旧目标/旧raw与新路径执行，生成读取旧verifiedDelivery全部AC作为退役历史，最后节点退役仍用旧固定命令及负向测试完成V1–V4。

已完整独审的rawIntegrations.expectedRaw优先进入派生P1 intent/targets，真实source/composed manifest仍作diff/readSet基准，不修改冻结plan/policy。原immutable作者patch在decision分析中按原ref重读，不能丢或冒作模型事实。真实作者新raw/明确规则驱动对应实现修复；旧代码行为不因曾符合旧原意就覆盖新用户意图，其余合法外部行为保持。

已批准 adopt_behavior/new_rule 与不可改外部 oracle 真实互斥时，独立 code_review 的 oracle-policy:decision:<stableDecisionId> missing_fact 复用现有 needs_input 停止路径。程序核当前 immutable requestRef、实际 mandatory testPath/testId/verification 定义、现有 decisionAuthorizationErrors 的所选范围，且旧/新适用 RULE/TR 确已改义。错误裁决、非登记测试、未选规则、未变规则或 keep_intent 均为 review_invalid，不能泛从 V3 nonzero 推断政策冲突。有效失败 code 为 oracle_policy_conflict，保存旧 oracle 内容摘要、精确测试/定义、裁决与规则、证据/反例，要求可信 owner 发布相容版本；旧 oracle 未通过，固定 whole command、全部守卫和原总预算仍有效。managed AC/test 演化继续原精确授权机制；不自动修改外部测试、不再造 checkpoint 或模型阶段。

普通 contract:path#id 引用不赋予重细化权限；代码/测试错误保持当前合法增补链的已批准完整P1正文，在原预算的新attempt修生成。live与checkpoint恢复均将每个实际 GenerationFinding 完整JSON存入现有 repairContext.diagnostics.message，保 codeLocation/evidence/counterexample，不嵌冻结全文或旧诊断递归体，不增加DB/恢复层。下一生成仍需新的独立code_review；取消/耗尽/终态重入不额外派发。

新遗漏权限在live、refinement stage及repair-input恢复复用同一精确path/existingID/affectedIds判断。旧合法contract:诊断不再赋予重细化权：原批准P1保持，按对应实际generation checkpoint重新提取完整独审finding继续普通修复，不修改历史证据。新marker绑定错误、空/损坏诊断或未批准P1明确失败，JSON解析错误保原诊断，不吞错误或猜恢复。首轮生成仅将P1规范implementation-review的完整ContractFinding JSON加入既有repairContext；没有前轮代码产物时previousOutput为null，普通missing-test-*不灌入该诊断，不把P1 review升格为实现通过。

旧合法contract规则引用不要求被引用RULE本身包含于affectedIds；撤销旧细化权前，candidateDigest定位对应同绑定SavedGeneration，并逐项核完整finding与独审原件一致，再核既有path/ID。实际affectedIds沿已验证独审原件保留，禁止把旧marker转为新授权；外来路径/ID、来源原件不符或损坏证据仍明确失败。

冻结选择默认保首个批准P1，只按真实批准增补链前进：同attempt已有refinement的prior须完整绑定当前冻结结果，专用遗漏诊断须绑定现有path/ID/affectedIds，并由此前实际generation的完整candidate/digest及独审repair finding原件证明；增补P1自身仍须结构及独审通过。普通repair、旧contract:标记及未审/失败增补候选不升级义务。复用既有repair-input、elaboration与provenance，SQLite恢复及同绑定retryOf保实际选中增补来源；不新增持久字段或重开预算。


完整独审行为分析通过现有input/baseline/policy/readSet/composed绑定且analysis检查点已持久后，具体conflict立即由当前fence登记blockedReason=conflicted。它独立于后续P1执行结论：非法P1、执行失败或预算耗尽保原phase/failure/预算/evidence，不把候选升为合法义务，不抹去当前已审分歧的裁决资格。未批准分析或无conflict不得登记此原因。

已落地交付的成组补偿与正文编辑统一进入受控输入、精确基线、完整行为分析、P1、生成及四层验证。作者差量逐文件展开，删除不会被单 path/next 假设遗漏。补偿不直接写来源或自行产生完成状态；完整私有新提交、journal 和 receipt 仍是唯一交付结算路径。

成组受控请求发生节点迁移或删除时，明确 bytePair:null 的 Spec 路径用 immutable group.before 作为当前作者真实前置；before:null 的新增目的路径不冒充旧契约。它只补无基线时的生命周期原文，已有非 null 交付头仍保持权威，不创建虚构 BaselinePair、receipt 或已验证声明。固定旧节点全文进入 P1，当前请求中的同节点目标 raw 保持作者原意，身份及退役政策照常验证。

精确历史恢复核原receipt、节点与业务项；node tombstone沿原scope/head结算，生成及独审只检查实际业务readyIds，已审Spec节点身份另由路径和恢复授权保护。

恢复Spec自带VERIFY时，其原技术ID与node tombstone同样纳入已审scope/head覆盖并推进新receipt；generation/review的readyIds仍只业务ID。P1及当前可信verifications的argv/cwd/预算精确登记不变，restore不能批准旧验证命令覆盖新政策。

显式 retryOf 的行为修复反馈沿真实不可变引用逐代读取，仅在来源物理身份、input.id、policyDigest、readSetDigest、requestBlob 及 origin 与当前操作精确相同时，将各代 behavior_analysis_invalid/behavior_review_failed 的完整 code/message 按原先后交给本次分析和新独审。来源/input/政策/request/origin 结构绑定不符仍拒绝；合法 P1 扩作用域使当前 readSetDigest 不同于祖先时，只停止继承该代及更早诊断，保留本操作反馈并继续新分析，不由可选诊断新增业务阻断。不沿 changed-input successorOf 取反馈。诊断始终是未批准数据，不构成基线、业务批准、权限或可重用分析；现有预算、尝试、deadline 和独审门禁保持。

所有行为分析、细化、生成与各自独立评审使用 operation 的固定有效 model（历史缺省为 gpt-6.1-sol），遵循 [[sync-model-selection]]；恢复沿原结构化请求，模型不改变预算、业务权限或已批准 P1 继承。


新正式计划使用 sync-coordinator-v2，冻结 spec_to_code、code_to_spec 或 combined 方向及分区字节/批并行策略；旧 v1 持久计划、请求和摘要按原路径恢复，不补写新字段。[[sync-partitioning]] 在同一 operation/attempt/fence 内冻结工作分区，[[sync-partition-execution]] 复用原原子派发计费、原生容量、deadline、有限修复、checkpoint 和单交付 journal/receipt。每区稳定阶段键含 partitionId，完整原始结果持久后恢复不重复模型调用。

提交触发前态使用 plan.commitTrigger.before 的真实 InputSnapshot，after 为 operation.input；paths 是真实累计提交差量，首次全量建档 before:null。没有共同验证基线时，该前态只是旧来源，不冒充 verifiedDelivery。普通提交只分析实际路径残差，首次建档才纳入全部授权实现；直接受控 Spec 保存只把真实 Spec 差量当新意图，现存代码仍是只读实现上下文。V4 和派发前复采沿 input.captureKind 选择同一 commit 或工作区模式，提交操作不受未提交 WIP 变化误伤。

分区分析及独审只接本区完整三方来源、必要只读 raw/契约/代码/测试，不接全仓正文索引。程序核分区并集唯一覆盖实际 changedPaths，合并已审事实、授权、归属和原始证据引用，拒绝重复身份和写者冲突。P1 上层原意可在只读 context，只有局部 targets 获得写权；raw-only 根首次先细化并独审一次，再成为其他区的只读上下文。新叶按真实 codePath 唯一归区，P1 完成后另冻结新增业务依赖及最终审查覆盖，不改变原分析原件。

spec_to_code/combined 各区并行产出结构化补丁，程序核本区读取、scope、Spec目标、不可改oracle及唯一文件writer，沿原 publication-base 保护与 CAS 确定序冻结一棵候选。所有局部及跨区边独审绑定同一最终 candidateDigest，V2 明示各原始独审及覆盖集合，不合成不存在的全仓模型review。code_to_spec 不派 code_generate，只装配 P1 已审Spec；程序核最终source/tests对象与真实输入逐字/mode/absence一致，发生代码组合差异就停止，不能反向改代码或测试。代码方向 V3 失败不进入可写实现自修复循环。

启动前保存完整最少调用估计与原预算族剩余量，所需分析、P1及最终分区/跨边独审超预算时明确拒绝，不少算或免计调用。全局 V1、真实隔离 V3、V4、正常 hooks 和单 receipt 仍是完成门槛，局部结果不构成全产品完成。


v2新功能的精确实现文件规划由 [[sync-partition-execution]] 使用同一runner和预算执行。全部提案经程序核原授权与唯一writer后，生成开始前沿既有expandContractScope为明确新文件取得精确租约和null bytePair，真实输入树内容不变时重绑composition/readSet，再startGeneration；恢复保持原文件计划，不重复规划或扩权。文件计划不能让尚未读的既有文件进入生成。最终V2只列真正有同candidateDigest独审原件的分区和依赖边，并引用fileWriterPlanRef；blocked或未检查区不冒充覆盖。code_to_spec仍无文件规划及代码生成。
