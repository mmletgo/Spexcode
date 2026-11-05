---
title: 细化输入快照与可追溯结果
status: pending
desc: 细化候选、缺口、阶段证据和明确失败类型；结果不代替实际运行与落盘。
code:
  - spec-cli/src/sync/elaboration-types.ts
---
# 细化输入快照与可追溯结果

## raw source

未知业务政策只阻塞依赖分支；失败、预算耗尽和待输入结果应保留可检查产物，不能显示已同步。

## expanded spec

临时ElaborationDraftMaterial可显式标明git_draft、native_output或physical_draft来源：前者只复制认证Git草稿原字节，后者只序列化已认证的历史成功结构化输出，不冒称旧Git稿；physical_draft只标识经新fence观察的已停owner工作树原字节，未提交且明确未批准，原errors及可用repairDiagnostics完整传递；该标注仅用于新请求的材料提示，不补历史持久字段或授予已校验资格。

draft.errors保留每项原finding的code/message及实际存在的severity、nodeId、path、line、itemId、relatedIds；原生运行失败可仅有code/message，不补造缺席定位。既有较短历史错误不回写，已认证repairDiagnostics.round的完整findings作为新请求诊断另行传递，不能借此升级旧批准或原始需求。

新派发可显式冻结`draftProtocol:elaboration-draft-v1`并进入完整inputDigest。该协议的round.output是Native真实小summary回执，业务JSON正文留在Git；可选round.draft仅记录version、ownerDigest、sourceInputId、schemaDigest、seed commit/tree/mode、resultCommit/resultTree、path/OID和具体errors，不含正文或raw BlobRef/role。语法/业务schema失败不是Native rejected final，不伪造rejectedOutput、candidate或成功认证；旧round和已有rejectedOutput字段不补写、不改签。临时历史材料只在内存读取并复制到当前seed，须经新的真实编辑提交才形成draft检查点；旧accept仍不继承。已携真实Git结果的小回执schema失败也先保留非权威草稿，结果仍为失败；Native错误仅在现有adapter与资源桥认证原final、确证原Native停止并提供failedWorktree实际Git失败见证后，才可经同一stage范围检查保留advisory draft；原Native失败、rejectedOutput和output/candidate/traces缺席保持，错误见证不能伪造成功。未提供实际Git见证不能补造draft身份；精确已认证停止的未提交文件仅可按physical_draft材料进入新seed，不回填旧round。

ElaborationRound可选rejectedOutput为显式untrusted_final诊断，包含完整被拒final文本、SHA、可用原文BlobRef与原调用绑定；generation的output/candidate/candidateDigest仍为null。其随已结算同owner完整round沿既有repairDiagnostics进入新真实prompt/request摘要，明确untrusted prior failed output；业务inputDigest不变，仍要求新生成与独立审查。旧round缺席不改写，无新增成功typed输出或业务授权。

ElaborationSessionRequest 可携由 [[sync-native-run]] 冻结的 nativeConfiguration:cli-config-v1 与 ZCode 专属工具策略；它仅属于运行请求/创建摘要，不进入业务 inputDigest，也不授予新业务政策或文件写权限。旧请求缺席按原语义恢复。

ElaborationInput与ElaborationSessionRequest可携明确worktree:{baseCommit,tree,mode:read|edit}，ElaborationSessionResult可携真实worktree:{baseCommit,baseTree,headCommit,tree,worktreePath}。各阶段直接传递精确私有seed，调用与缓存身份绑定实际可见tree；该字段不授予主树写入或完成权。新native-worktree结果按真实Git对象验证，不能以frozenReadProof代替；旧frozenContext/frozenEntries/readProof字段只保留历史恢复及纯单测接缝。

同步 budget.mode=unlimited 的新模型请求使用 timeoutMs:null，表示不设置模型调用总时限；有限数字期限及旧记录语义保持。null 调用仍受独立会话创建、租约/心跳、显式取消/停止/关闭和可信 VERIFY/Docker 各自期限约束，不以大数模拟无限。 timeoutMs 可显式为 null，省略仍沿原默认数字；totalTimeoutMs 为 null 时不产生隐式总截止时间。

协调器可显式传入 implementationWritePaths 与 readonlyTestPaths，均只由冻结计划的写授权和 mandatory oracle 文件派生，随业务输入在第一个异步等待前复制，并同时进入生成与独审快照。它们是技术权限，不是业务事实或新授权；直接细化调用未提供时不推测目录权限。

输入快照拥有用户原意节点和原文、允许变更的节点与路径、源正文及摘要、既有只读契约、有来源的事实和可选实际代码/测试字节。新增子节点原意或上层引用正文必须由冻结输入提供；模型不能自行扩大写范围。新增治理锚点必须指向冻结上下文的真实代码文件，不能借未提供文件上下文伪装已实现。`authorizedChanges` 是调用者已确认原意或裁决产生的具体退役/验证政策变更，不接受模型自产批准；历史 `retiredIds` 由协调器登记，新候选不得复用。完整高层导出真实首轮生成约 600 秒，默认单次窗口为 900 秒（15 分钟），`timeoutMs` 可明确覆盖；该时限不是运行成功证明。每次请求携带稳定请求键及独立输入摘要；修复轮数、调用次数 `maxCalls` 和总时间 `totalTimeoutMs` 有明确可配置上限。原生每次调用超时使用固定归一化单次配置，不把浮动剩余时间放入创建身份；总时间由独立 AbortSignal 截止，同一冻结输入/阶段重试仍可幂等回放。预算耗尽在原生停止已证实后为 exhausted，区别于用户 cancelled；停止未证实保留 cancellation_pending 和精确身份、结果 failed，保留产物并停止派发，供 P2 统一操作预算覆盖。

结果返回候选正文及内容摘要、解析图与覆盖投影、具体 GAP、受阻依赖 ID 和无直接 GAP 阻塞的声明项 `readyIds`、实际退役 ID、结构与独立审查结论。`readyIds` 不代表整条所属流程可交付。`readyFlowIds` 仅包含 FLOW 自身及全部声明 steps 均无 GAP 阻塞的流程；`blockedFlows` 返回 flowId、blockedStepIds 和 gapIds。聚合只向父流程形成结果，不回传父阻塞到无关子项，因此未知完成/取消权限不阻断创建/查看。可推进/退役结论仅在当前结构和独立审查通过后输出。每轮保留生成输出、审查输出、失败发现和 session/thread/turn/result 摘要，不能只保留最后“成功”声明。调用期间外部继续编辑不改变冻结输入。

`interface_seed`结果显式返回phase/status，并保持`implementationReady:false`、`readyIds:[]`和`readyFlowIds:[]`；其独立审查只证明父接口阶段，不代表全图P1；首次raw-only与已有业务限REQ/RULE/GAP且可附精确可信VERIFY的纯接口的后续同步使用同一阶段标记，不因历史已完成而跳过本轮独审或丢失旧义务。完成分区后，aggregate以`phase:partitioned_final`标记，并保存`partitionSeal`的完整规范材料：全局`inputDigest`、候选摘要、规范changes、合并applicability、冻结nodeChanges、全部final findings及passed。候选摘要由`{inputDigest,changes,applicability,nodeChanges}`确定；最终ready/blocked投影只能来自完整seal。子分区局部checkpoint可省略图与coverage对象，但必须保留自身phase/status、规范changes和原始round/trace。

局部输入与结果的`partitionBinding`保留原planDigest、partitionId，以及可选的独审analysisRef和唯一interfaceSeed分类证据；这些字段在模型派发前冻结并参与inputDigest。后验新增叶的分类证明保留真实后代路径、codePath与唯一sourcePartitionId；结果不能以另一plan或分类复用旧checkpoint。聚合结果保留各局部原件引用，不继承首区的局部partitionBinding。

只有分区执行器可冻结`validationScope: partition_local`，该范围进入inputDigest和派发身份，允许单个局部候选暂缓只读context完整性；普通细化与全局seal默认严格验证完整冻结context的源码/测试覆盖。局部校验结果不能冒充全局coverage或ready。

内部协调器可为新的请求键提供已结算拒绝候选 `seed`，只包含原冻结输入摘要、原候选/摘要、生成输出、具体失败、评审和原追踪。程序核对相同业务输入、原候选自摘要、生成输出与原 trace.resultDigest、评审 inputDigest/candidateDigest 及去除程序身份后的原生输出摘要，并用当前 schema 校验、重新渲染；续修提示同时提供原失败及当前程序结构诊断，后者不改写原发现或追踪。它仍是不可信诊断候选，不能改写 raw/facts/source 或充当权威规则。只支持已有具体失败，不恢复运行中 native 或迁移持久 store。新预算由调用者显式决定；新 rounds 只记录新执行，prior 保留原请求键/摘要/追踪及重新渲染摘要。新独立审查必须重查当前完整 Markdown，并独立于新构建及所有种子会话；即使渲染版本改变也不得借用旧审查。

细化状态遵循上层 [[sync-elaboration]]；实现缺口、实际执行 `not_run` 和 `implementationReady: false` 始终明确。P2 及验证服务必须另外完成代码、测试、当前版本证据和允许范围的实际落盘，才能形成 [[sync-verification]] 定义的同步结论。

调用者可提供可选 `verifications: readonly Pick<Verification,'id'|'command'|'cwd'|'timeoutMs'>[]`，其权威类型来自 spec-core 契约。它是独立可信执行器登记，不混入 ElaborationFact 业务事实，不代表新增业务政策或变更授权；开始前与其他输入一起复制并进入冻结摘要。未提供登记仍保留独立 P1 细化语义，执行未运行、实现不可交付，不能凭模型 VERIFY 获得执行权。

细化输入可携独审行为分析证据、节点迁移及preserve_business/reelaborate模式。update_acceptance必须绑定合法规则ID、analysisRef和具体依据；代码来源仅授权符合明确原意的细节变更，不能删除既有验收或改变验证政策。候选及结果保留nodeChanges供协调器形成同一迁移候选。

refinement可携已接受candidateDigest和生成独审的具体失败诊断，只表示在既定原意下补齐遗漏边界；它不能成为新事实、来源或政策授权。上一完整已接受契约作为输入，REQ/AC/VERIFY和既有义务保留，再经独审后新增普通必要状态/转移及验收。

decisionAuthorities携可信程序派生裁决范围；update_acceptance及具体retire既核独审分析，又核所选规则/业务ID闭包。使用同decision source或改标user:raw均不能授权无关政策。未选冲突仍为独审finding阻断项。

程序由公共节点删除/所选裁决派生的retire可携analysisRef证明逐项已独审授权；旧可信显式raw/plan授权仍沿自身来源门禁。它不授予验证执行政策变更，退休仍保留旧负向运行义务。


retiredIds同时承载逐项合法业务退役与经当前精确裁决确证结清的旧诊断GAP身份。GAP删除仅在本轮P1结构与独审通过后输出；独审拒绝、旧/foreign裁决、共享选外或未解决诊断不记入此集合。协调验证与baseline复用该既有字段累计，后续候选禁止复用。诊断结清不改变用户原意或增加业务退役计划。

结构化runner请求可携 [[frozen-context-reader]] 的不可变frozenContext引用；结果可携精确thread/turn的frozenReadProof，包含真实原生history摘要与完整required内容覆盖。它仅是输入读取证据，不替代业务结果、独立审查、运行验证或落盘证明；inputDigest保持业务输入语义。

authorizedChanges 的 restore 动作保存原固定历史请求及 input 引用，仅表达同一历史业务身份恢复；调用者在原协调器核原 settled receipt，细化再核真实 Git parent、原路径与旧业务字段。候选不能用普通 user:raw 或模型文字自授恢复。恢复的当前 ID 不继续列为禁用 retiredIds，原历史退役 pair 与审计证据不修改。

结构化runner请求也可携通用纯JSON frozenEntries（UTF8 text、binary base64或absent）；它在真实attempt/policy绑定后转换为frozenContext，持久计划不携条目正文。该传输字段不新增调用、业务授权或完成语义，旧固定ref/请求原样恢复。


分区聚合结果可携partitionEvidence:{partitionId,resultRef}[]，每份ref保存独立局部结构和原生审查原件。合并结果不能冒充一次全仓审查，P2仍须核唯一目标writer、全局契约关系及最终candidate。intent可来自只读context，只有targets可写。

分区aggregate可携verificationProjectionRef，指向[[sync-partition-execution]]的唯一技术归属投影证据，包含冻结登记digest、真实owner决策、受审原件refs和每候选before/after及非VERIFY字节摘要。局部changes、rounds、review及其摘要保留原件；aggregate changes及partitionSeal绑定投影后规范正文。该ref只证明冻结技术policy的可重算投影，不代替新业务独审、全局严格封口或真实运行验证。

ElaborationInput.totalTimeoutMs可显式null表示无总期限；省略及正整数继续原语义，单次timeoutMs仍有限且独立。该执行预算不进入业务输入摘要，也不授予未审候选通过或写入权。

readonlySpecRepair保存独立于业务拒绝seed和P2独审refinement的只读全候选V1诊断：原baseInputDigest、失败candidate/generationRef、已审acceptedRef、历史JSON/review/changes及精确owner findings进入唯一局部输入摘要。局部结果保留该来源以便后续多轮重算，旧已审原件不改；聚合仅把新局部差量的beforeDigest投影回原全局source或absence基准，最终完整seal/V1重做，不把局部旧正文基准写成全局原输入或取得新源码权限。

ReadonlySpecRepair的candidate_review来源保留真实generationRef、各分区独审原件ref及完整finding，按本owner投影到唯一冻结输入；诊断不是refinement、fact、raw或新授权。原acceptedRef和结构化JSON/review保留，旧结果与失败原件不重写；既有无kind的锚点诊断仍以原字段冻结和摘要验证，不给旧原件补标记。

可选repairDiagnostics由内部协调器沿同输入、同owner的已结算可修复失败原件提供，记录原请求键、业务inputDigest、resultRef、完整failure及实际末轮round；无candidate的格式失败不伪造ElaborationRepairSeed或prior。新结果保留该诊断来源，旧结果不补写。诊断不是业务输入或授权，模型调用prompt及requestDigest绑定其完整正文和旧ref；所有新round仍只记本次真实生成与独审。

同一诊断接缝也保留候选渲染前的具体结构拒绝：已结算repairable来源必须为exhausted/repair_budget_exhausted、末轮candidate:null且有明确error发现（如重复业务行rows_patch）；不伪造候选seed，原schema和结构门槛保持。

单体P1同样允许越过上述纯控制中断：同operation不可变计划下，readInput由相同composed、selection及冻结读集合唯一派生上下文，真实来源whole wrapper仍精确核readSet和完整inputDigest；已有P0时须保同一analysisRef，没有P0则双方均须缺席。单体不要求不存在的partition-plan，不新增checkpoint或补写历史绑定。

ReadonlySpecRepair可用kind:partition_seal标记全局封口反馈；generationRef在此分支指原失败partitioned_final aggregate，acceptedRef仍指其真实已审局部，candidateDigest绑定原partitionSeal候选，findings仅含error。该诊断进入新局部输入/请求摘要，不修改历史accept、原意、作者授权或预算。
