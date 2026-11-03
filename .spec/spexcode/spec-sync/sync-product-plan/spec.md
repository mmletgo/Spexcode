---
title: 持续同步产品边界与验收方案
status: active
hue: 175
desc: 九项需求与二十八项最终验收的唯一产品方案，明确授权、运行及交付边界。
code:
  - docs/spec-code-continuous-sync-plan.md
---
# 持续同步产品边界与验收方案

## raw source

P0至P5按完整需求交付，不以阶段演示、局部测试或可修改的通过记录替代最终验收；产品授权和操作入口必须与实施契约一致。

## expanded spec

P0的analysis/review同样按owner/purpose保真实Git临时JSON与精确只读schema；格式失败跨attempt续原稿，review格式失败保已校验分析，业务repair仍回分析和独审。旧只读Native原输出只在精确schema与原任务（仅剥非权威repairDiagnostics）、seed及冻结身份一致并经原真实性/停止认证后成为新seed材料，不冒充旧Git稿或批准。三轮兄弟分区仍承接原analyze及review出处，不重跑已接受区。持久语义由writer23在线备份/事务迁移围栏保护，回滚恢复升级前v22一致库及原evidence；既有reserved请求保持原绑定，原预算、source/tests只读与最终V1–V4/采纳门不变。

机器重启造成物理来源身份变化时，可由[[sync-application]]的显式历史operation/input资源入口结算精确owned资源；canonicalRoot/commonDir仍须相同，正常read/resume/adopt完整身份门不变。此单次离线入口不重放journal或新建交付，不改原失败/候选/独审，不授予业务连续性，未知停止继续保留资源；复用原CAS/lease协议，不新增身份字段或writer版本。

明确ZCode provider/model沿 [[zcode-structured-runtime]] 与同一会话/资源接缝执行。私有配置和实测只读边界下仅允许冻结reader；完整原生参数/结果、精确schema的实际模型输入、独立审查及正式关闭/全进程停止分别核验。既有认证只由SDK正常沿用，不复制凭据；不同provider不自动fallback，换模型仅新操作或合法retryOf。引擎能力证明不等于项目V1–V4、Docker、Git交付或采纳完成。

自动事件边界为 SpexCode 页面保存 Spec，或外部编辑后形成的真实 Git 提交。未提交保存与暂存不启动模型；提交树输入排除同期工作区编辑。Spec 变化驱动代码，代码提交只驱动对应 Spec，不自动修写代码或测试；组合提交和真实冲突仍按既有意图/裁决规则处理，已结算同步提交按 receipt 与实际基线去回声。

已消费提交的完整持久观察是后续差量边界，不因500条展示窗口、重复采集或同HEAD计划元数据变化回退并取代待交付正文请求。当前及精确前态范围共同保留真实文件新增、删除、mode与absence；已删除源码仍从before冻结读取，未消费或失败观察不冒作消费证明。

首次建档和增量同步均先按归属、写文件及依赖规划分区，再由多个独立上下文读取本区完整资料。完整覆盖由分区及跨区接口审查证据的并集证明；不要求一个调用读全仓。各区共享 operation/attempt、预算、最终候选和一次受管交付，局部通过不替代全图、真实运行、receipt 或原树采纳。

原生输出上限的精确同轮续行在成功与已停结构输出耗尽中使用相同身份和实际API消费证明；合法续行不误判新用户轮，未知内部提示继续拒绝，耗尽仍是失败而非业务或交付通过。ZCode 严格 JSON 格式错误仅在完整原生真实性与 required 读取已核真后沿原预算有限续修，原 code/message 只反馈对应分区的新分析和独审；冷态原件篡改、真实性失败和旧缺码失败不取得该资格，原输出不改判通过。

只读Spec全候选的晚发现锚点错误回到唯一P1 owner新生成并独审，保留其它已审分区及源/tests；相同产物且无owner新派发时停止热循环，真实多轮修订不增加预算上限。

完整初始化资格与源码写头分开：正式已审并采纳的精确owner Spec/业务ID基线可证明其声明的未写源码或生成测试曾被只读验证，但须有settled receipt、真实scope、未漂移的before owner正文与sourceInput/delivery/before对象一致；缺binding/null不因此变成byte头或三方基线。已有非null路径头仍只认原头，未采纳、缺结算凭据、scope外或owner/源码漂移不取得该资格；单代码提交只派真实owner及原影响闭包，源码/tests与全部验证/采纳门保持。

全量重建允许在同一 operation 内多轮生成与独立审查，不要求首次生成即完全一致。已独审通过的局部结果仅在原输入、政策、分区、依赖及实际局部冻结正文均保持精确绑定时跨 attempt 承接，并保留原审查与产物引用；未审、拒绝或仅生成的内容不能当作已通过。下一轮针对剩余问题继续，候选改变后必须重新审查受其影响的范围，最终候选仍须取得完整覆盖的独立审查。各轮共同消耗原 calls、attempts、repairs 与绝对期限，暂停恢复不重置预算，不通过另建操作绕过限制；局部进度不推进正式交付、基线或已同步状态。

相同冻结绑定的局部生成若在任何输出前失败并保存空轮原件，下一轮可承接最近更早的具体业务拒绝诊断；缺局部检查点、绑定改变或已有候选的基础设施失败仍停止回溯，不改变重试资格、独审或最终验证门槛。

父接口起步阶段仅生成和独审必要的共享REQ/RULE/GAP，不同时要求完整对象、流程、状态与AC展开。具体子区承担完整细化，最后仍核全图覆盖；父层已声明的义务必须准确、有来源且相容，不能以分阶段为由接受错误。

Native P1生成与独审对普通无冲突实现约定、重大业务未知和明确意图冲突按[[sync-elaboration]]的共享来源边界判断。空`implementationWritePaths`表示源码与全部测试只读，不新增测试或把实现缺口交给无权P2，并以`readonly_implementation_gap`阻断；父接口阶段仍只审必要接口种子。

代码提交可在完整已结算基线已被来源 Git 真实采纳后，按提交路径的实际 owner 与必要影响闭包规划。只有真实 `before`、完整 discovery selection 的精确资源头和对应 delivery 采纳均可验证时才收窄；首次、无/未采纳/未完成基线、缺少精确绑定、根原意或配置变化、未治理源码变化继续完整 bootstrap/发现。多轮 freeze 始终用原始 discovery selection 证明完整基线，不能将上一轮的窄 selection 当作覆盖证明；失败 admission、保存或暂存信号不消费基线。

方案保留九项REQ和二十八项AC及阶段依赖；产品实施状态由 [[spec-sync]] 与各权威子节点、实际当前版本证据决定。跨机器原意授权由 [[sync-intent-authorization]] 定义，可信CI从受保护目标提供policyCommit；普通候选不能选择自身政策来授予自己权限。撤销和版本回退分别复用 [[sync-history-input]] 与 [[sync-application]] 的新成组补偿及停止写入动作，真实来源采纳和主分支同步按 [[sync-landing-status]] 区分。大上下文通过 [[frozen-context-reader]] 完整读取，不改变原预算或降低审查义务。

已结算交付的显式来源采纳由 [[sync-source-adoption]] 处理，只快进干净原树至真实收据提交；Dashboard 和 CLI 共用门禁，保留未提交内容及分叉历史，不自动代替另行授权的分支合并。

用户可用精确budget.mode=unlimited解除同operation总调用、attempt、修复次数和总期限，持续保存真实用量且deadline显式null；有限预算原语义保持，模型调用使用显式null且不装调用超时timer；会话创建、精确Native取消/停止/关闭、验证timeout、租约和全部独审/完整交付验收不变。

首次纳管的行为分析只覆盖真实输入与业务变化，不在没有作者/交付差量、重叠或明确裁决时重抄或展开原Spec；此时空整合输出合法，详细规格由后续P1及程序raw复制形成，独审与原始字节门禁保持。

Native worktree分区分析brief同步传递本区facts与newNodes约束：同一facts.source只给一个完整text，newNodes仅来自本区unownedSourcePaths及schema候选，候选为空或maxItems为0时返回[]；Root/接口分区不得替兄弟源码分区提出叶。该业务提示不限制Agent自由读取完整worktree，也不要求frozen-reader或逐字消费证明。

Native worktree新分析请求的schema按旧/current冻结图限制受影响ID，并只允许REQ/RULE/TR作为规则依据；空ID/规则域不生成空enum，raw-only空图的GAP/conflict仍可用空身份数组。已接受的合法v6缓存继续按原摘要复用，不重派Native。

Native worktree P0分析与独审共用业务语义：可由raw、源码和完整测试核实的行为，即使治理叶、稳定ID或覆盖映射尚未生成，也以facts/newNodes交P1；只有具体未决业务政策及可观察后果才是coverage_gap，只有真实互斥才是conflict。明确原意下的实现/测试缺陷不是新业务GAP；P2修复仍受原写权限制，只读code_to_spec缺口保持readonly_implementation_gap。独审须repair纯治理缺席误报；原Native自由读取与ID、权限、AC、unbound门保持。

初始化待生成规格叶和覆盖映射不等于缺用户业务事实；已有raw、源码与测试可核的职责交后续P1，真实未知/互斥仍明确阻塞。分析指导版本纳入输入摘要，职责澄清后旧已审结果须重新分析独审，旧证据不改。

初始化重试的扩展资源尚无真实owner时，分区分析与独审保留其null意图元数据，不猜路径或缩小原scope/选择；空资源名不构成契约正文、读取证明或写权，已存在owner仍受本区读取范围限定。

跨轮续修保留已核真的拒绝候选原结构化JSON作格式诊断，Markdown只作渲染对照；不将表格占位复制为JSON值，也不把旧候选升为事实、授权或已审通过。

精确结构输出错误的续修准入和单体/分区诊断筛选共用错误码集合，保留原已认证code/message，仅发回对应失败分区的新分析和独审；错误诊断不授政策或业务权限，缺码、未知失败及普通Error伪码不取得资格。

行为resolution的格式与业务失配诊断分别定位：既有Spec分节不可解析先报格式，未消费义务真正失配反馈完整expected/proposed业务字段。原proposal、分析拒绝及权限/三方整合门保持，不自动反转义或代写正文，不以诊断替代新独审或P1生成。


局部同步的最终程序校验必须看见真实composed冻结全树中的未改动承接方，并叠加本轮完整候选及原删除/迁移语义；Agent仍只读本区。已有whole封口仅在原wrapper保存的tree/contentDigest与当前全树精确相同时直接承接；缺绑定或异树重新严格封口，已有局部审查只按原完整输入与来源规则复用，不能拿扩域后已重绑的attempt为旧proof补签，也不以过滤缺口或扩张写权掩盖真实义务缺失。


细化指导区分全部合法可更新目标与首次必须构建的子集；首次必建0不等于当前无更新任务。既有完整契约可按真实raw/facts、明确授权及已核实repair落实必要差量，确无变化的目标仍可省略。原目标索引、只读上下文、父接口阶段、退役、授权及schema空/部分输出门保持。

原生 worktree 的资源证明按 [[native-worktree-runtime]] 的正向任务域边界：receipt/历史 owned 精确停止，cwd 关联孤儿保留粘性 PID/start 债务但不授 kill 权，无关联同 UID 系统进程只诊断。正式恢复保留旧失败原件并追加版本化停止观察，不补签 completed 或业务通过。

已真实停止、输入与 Native 身份绑定的原生结构化 JSON 语法失败，以及仅 version6/native-worktree 在精确模型、输入、消息、成功终态、idle/close 与 exit 均核验后出现的 AJV schema 不符，沿现有精确格式错误码进入格式修复与独审循环；后者复用 [[zcode-structured-runtime]] 的 `structured_output_format_invalid` 并保留 AJV 字段/路径诊断。原失败输出和资源证明保留，不补造业务结果；version4/5 冻结路径 schema 不符仍保持旧分类。

真实原生协议成功但 Git 结果违反 read/edit 合约时仍为业务失败；精确 native_worktree_result_invalid 沿原资源结算、逐轮修复与独审闭环反馈真实 Git 差异，在新工作树重做。旧失败工作树、原生完成缓存及历史失败保留，不由程序恢复 Git 或补签通过。

局部分区全部accept仍不能替代全局seal。封口error绑定原aggregate/局部ref及真实输入后交回所属owner、接口后代与引用依赖重新生成和独审，保无关accept；warning不升error，父不补FLOW、不降覆盖或作者授权。无法路由或同候选同error无新派发时typed停止；只有同selection、无任何检查点/派发/业务/会话锚的superseded空控制attempt可越过，旧真实证据仍完整重验，所有attempt/calls仍计原预算。

格式或schema失败的完整raw final属于不可信UTF8证据，不能被checkpoint或证据API当作stage/业务JSON。正式详情与原操作恢复在保留历史raw refs的同时继续可读；权限由原失败round/Native身份及当前停止证据核验，未知损坏材料不被静默跳过。v21按原备份/拒旧writer/回滚路径切换。
