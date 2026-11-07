---
title: 业务契约细化与追踪
status: active
hue: 175
desc: 从高层原意生成可追踪的主流程与状态处置，经独立审查和有限修复，精确保留未知政策。
code:
  - spec-cli/src/sync/elaboration.ts#elaborate
  - spec-cli/src/sync/elaboration.ts#elaborationMaterialContext
  - spec-cli/src/sync/elaboration.ts#elaborationScopeErrors
  - spec-cli/src/sync/elaboration.ts#elaborationReviewScopeErrors
  - spec-cli/src/sync/elaboration.ts#targetHasCurrentChanges
  - spec-cli/src/sync/elaboration.ts#freezeElaborationInput
  - spec-cli/src/sync/elaboration.ts#projectElaborationFlowReadiness
  - spec-cli/src/sync/elaboration.ts#verifyElaborationDraftCache
  - spec-cli/src/sync/elaboration.ts#partitionSealRepairContext
related:
  - spec-cli/src/sync/elaboration-orchestration.test.ts
  - spec-cli/src/sync/elaboration-target-binding.test.ts
  - spec-cli/src/sync/elaboration-draft.test.ts
---
# 业务契约细化与追踪

## raw source

从用户原意生成可完成主流程、适用状态事件处置、规则和验收；无法确认的重要业务政策成为 GAP，只阻塞依赖分支。

## expanded spec

P1物理选源的新鲜度来自原认证generation的attempt与round，不来自载体round、观察时间或mtime。既有draft定位时忽略非权威errors增补但完整身份必须相同，并经原Native/Git冷验；同attempt较晚真实generation亦可优于早轮稿，不能定位来源时拒绝覆盖。原candidate/合法仅续审资格不因材料被替换。

完整生成`ac-test-flow-binding-v2`可在派发前沿相同来源顺序接收`stopped_git_draft`。提示明确这是已停止旧工作树的真实提交中的唯一授权草稿，仍未批准，须沿原字节和拒因继续编辑、正常提交并重新独审。冻结后的同一请求按原材料重放，旧v1、缺字段、父接口及历史派发保持原提示。已接受候选和仅续审资格仍优先，临时草稿不进入业务交付。

原P1程序冻结task/诊断沿精确schema尾段只读解析，不解析模型正文；新旧可信readonly overlay只取原task的relatedSpecs、repair.baselines/specs及本轮程序context/anchor/seal投影，逐项记录精确path/mode/OID。比较仅排这些路径并集及draft/schema，处理新增或消失诊断路径；不豁免整个.spec或source/tests/其absence。旧工作树仍对原seed全量冷验，新seed保当前已审父/诊断内容。原冻结诊断对象完整作为非权威materialDiagnostics进入新请求，新provenance留双投影，旧请求/NativePlan/摘要不重签，writer27已覆盖。

P1材料回调还接收当前StageDraftBinding、含完整只读overlay的真实StageWorktree及业务inputDigest，均仅进程内参数，不重签旧saved/reserved请求。原认证Git draft必须定位到其真实owner/attempt/round；仅严格较新的已认证物理来源可替换为同一observer的physical_draft，未知或更早来源保原稿，合法candidate/仅续审仍优先，提示明确它未提交、未批准且不是Native final或历史Git稿。只复制原bytes，原Native失败/全部具体诊断保留；Agent正常提交后才沿原schema、renderer、业务授权和独立审查形成新稿，原只读祖先/source/tests/absence保持。

存在当前受审分析及冻结owner时，独审与生成共享同一owner范围事实及生命周期目标绑定；新独审任务明确可变目标与冻结目标/上下文。repair的affectedIds必须全部真实存在，并至少定位一个本轮可变owner；可同时引用冻结祖先或依赖作为证据，真实受影响owner的语义修复继续原生成修复与分析回审通道。仅指向未变owner的历史description/prose/进度文案，不能取得本轮写权。程序在转换业务finding前拒绝越界或未知ID绑定，给出具体review_scope/review_binding拒因并保留完整原review JSON，不过滤发现或替模型改accept。历史无当前分析的请求不顺带改变绑定语义。

此类独审权限/绑定错误仅重开独审：原生成JSON或Git稿、原summary追踪和候选必须经当前完整输入、source、schema、目标范围、唯一renderer、机械校验及candidate摘要重新证明，且原review在当前范围下仍确属权限/绑定错误；不能凭旧finding.code取得资格。沿现有rounds及同owner已结算repairDiagnostics保留原review、拒因、Git身份与generation trace，新round只派独立read审查同一候选，不重新生成，不新增业务/源码/tests写权。真正域内repair、输入/分析变化或机械检查失败仍走原修复/失效门；预算、取消、独立性与全图seal保持。新任务范围只是prompt派生数据，不追补历史请求、字段或marker。

经[[sync-coordinator]]认证的原ZCode `session/events` 独审超时也沿仅续审入口。程序冷读原Git草稿，逐项重核owner、source、精确业务schema、唯一renderer和机械门，并要求候选摘要、原任务和owner范围、实际只读评审seed及评审schema一致。身份冲突在派发前明确停止，剩余预算不能转为自动生成。旧失败没有review、accept或ready。新只读评审使用当前冻结的完整独审范围，独立于原生成及原超时会话和线程；通过前原候选仍未批准，预算和后续全图封口继续生效。

本轮已审分析只为实际受影响owner提供范围证据；冻结targets不自动授权重写每个已有目标。细化在生成后和完整候选检查时核本轮影响归属、作者原意及已有逐项/生命周期授权，未受影响目标的metadata、解释、绑定及行变化以可续修rows_patch阻断。范围门与原行结构核验分离：历史合法JSON和精确schema继续作为原诊断材料进入续修，不能因新增语义门直接丢弃；旧候选不取得accept或ready。省略及显式等价输出由[[elaboration-markdown]]逐字沿用冻结正文，合法受影响owner的prose-only更新继续进入原演进检查及新独审。

已审缓存除原input/Git/ref/schema/渲染绑定外，必须按当前本区输入重核同一owner范围。仅范围不合格返回不可复用资格，不抛原件损坏、不改旧reviewPassed/trace/JSON/ref；原身份或正文绑定损坏仍明确报错。调用者放弃该ready承接后，优先沿现有正式草稿来源，无来源则把已冷验缓存的精确末轮Git稿作为未批准材料续修，附rows_patch诊断并重新生成及独审，不能从零丢稿。全局兄弟分析命中祖先ID不替代本区scope，whole分区结果须回各局部缓存核资格后重新seal。

P1草稿与旧Native材料在本轮业务schema计算完成后才通过进程内回调选源，跨正式retryOf的材料必须精确匹配schema；旧只读成功输出明确标为新临时材料，不能冒充历史Git草稿或批准。该回调不进入持久输入、wrapper或receipt。实际Git稿已按当前binding读出后，材料回调仅可按认证来源顺序选择严格较新的物理稿，不读普通Native fallback；命中物理稿须清旧draft角色并保原完整errors和冻结程序诊断，不能把新bytes包成旧Git身份。原review final格式失败时保留已认证generation业务稿，review原文只作untrusted诊断，不能覆为业务JSON。

临时草稿的续修诊断保留原finding完整身份，包括原有severity、nodeId、path、line、itemId及relatedIds；同码同文但定位不同的发现不得压成重复code/message。当前轮检查点、跨请求的已结算诊断及其实际生成prompt均保留这些字段，未提供的字段保持缺席。诊断仅帮助定位与区分error/warning，不改变业务授权、拒绝门、原稿或独审资格。

显式draft-v1的只读V1锚点返修沿既有未定义kind分支，把完整finding身份、原candidate/accepted/generation引用及真实baselineSpecPath同时交给生成与独审；不能只压成重复code/message或把mode=reelaborate误当重新细化授权。baseline只从当前acceptedRef核验的真实owner完整正文复制为只读诊断文件，独审候选overlay不能覆盖它；文件不成为raw、事实、新义务或写权限。Agent依据该正文自行恢复坏草稿中被改写的prose及已接受RULE等业务字段，仅修finding定位的typed code来源选择器，选择冻结源码真实可索引声明，不猜局部变量或调用符号，不顺手改basis、政策、流程/验收和稳定ID。原草稿字节、错误及trace不改写，schema、单一draft写范围、源码/tests对象与absence、契约演进及锚点门保持；candidate_review、partition_seal和旧无草稿请求不取得此V1任务。提示或seed改变不能为旧同attempt reserved请求重签，冷切换须在原请求结算后通过新attempt冻结。

跨owner全局封口返修中，生成与独审共用由原失败aggregate/local refs核验的完整error定位、owner、原candidate身份和Spec路径映射。真实失败并集只在以aggregate SHA命名的只读诊断目录呈现，不覆盖作者基线、raw或事实；程序图与独审诊断副本复用同一原VERIFY技术归属投影，将本owner替为本轮候选，兄弟原件保持，本区候选原件不重写。只可修改原单一draft，schema、诊断文件、源码和全部测试不可写；正常提交hooks继续面对原作者Spec。候选先以现有parser/严格契约图替回原失败并集，本区候选先完整经过当前登记及演进门，再沿原aggregate相对原已审local确证的VERIFY移除集合复用原技术表投影，不重选owner，不隐藏漂移定义、删除义务或未登记VERIFY。本owner可修的原分配错误未消除或新增跨owner结构错误时不得进入独审，其他owner既有错误仍留最终strict seal。仅原真实duplicate-id精确绑定的本owner、本轮新增且不在冻结作者/已采纳基线的临时ID，可推导唯一一对一、同kind同业务字段（含代码/测试绑定）的更名，并逐项保留本owner每条原typed引用的field及其更名后身份，不能用冗余覆盖掩盖删除引用；原作者/已采纳及非冲突ID保护保持，不把兄弟同ID当成本区义务仍存在。旧draft错误只保历史，不覆盖当前已认证资格；新输入或诊断仍须新生成、新独审及严格全局封口。此回归的受控Git runner不代表真实模型全链验收。

仅当前及原已审局部均为同一已认证interface_seed分类时，原失败并集已存在且确由后代补齐的missing-requirement-flow、missing-acceptance、missing-implementation或incomplete-contract完成性错误可留给真实full后代承接；纯父仍真实生成及独审，不被要求添加FLOW/AC。代码来源、治理源码或测试的真实缺席不属于可委派完成性，父RULE自身missing-source-file须由父修复，不能交无父写权的叶或先获父独审accept。新增跨owner错误、父自身可修结构错误及full owner未消除的原分配错误仍在独审前阻断。失败并集替回校验与最终strict seal共用同一真实composed补全后的全图文件集；partitionSealFiles只作进程内程序参数，复制后overlay原aggregate和本区候选，不进入ElaborationInput、冻结摘要、prompt或checkpoint，不扩大Agent局部files与写权。真实源码或测试缺席不能由此补造，完整全图seal仍在全部局部完成后执行。

新草稿的接受缓存沿同一readStageDraft边界重核全部tagged轮的Git/ref/owner/schema/source身份，历史syntax/schema坏稿不要求满足成功schema。仅最终已接受轮严格解析正文、校验当前schema/行差量，并用现有绑定与renderer重算candidate、candidateDigest和完整changes；原JSON缓存不能替代Git正文。新tag但最终draft缺席拒绝。source tag只取原attempt已冻结的协议stage，沿同一原件provenance读取，不用当前attempt新tag给legacy补签；旧无tag无draft批准沿旧门。合法正文无需改动、仅重试回执或审查时，任务明确允许保留hooks的正常git commit --allow-empty，不制造业务diff；仍须真实新提交，不放宽head/seed证据。

新P1按owner使用显式`elaboration-draft-v1`：Agent把完整elaboration-target-rows-v3业务JSON实际写入私有临时草稿文件，正常Git提交后，Native final只返回符合`DRAFT_RECEIPT_SCHEMA`的单一JSON对象，形如`{"summary":"..."}`，前后不附说明或Markdown代码围栏；业务JSON只写入草稿文件。精确schema留同seed只读sidecar供读取、自检，仍仅draft可写。程序经真实seed/result Git校验，从指定path/OID读取完整字节，再严格JSON/schema、目标绑定、唯一renderer/checkCandidate及不同会话的read审查。语法损坏、38KB级业务行或schema错误保留原始Git字节，下一轮明确给已有草稿路径、精确schema与程序/独审错误，让Agent实际编辑续修，不把旧大JSON/Markdown塞回prompt重答。历史已认证failed output或合法旧行可先复制为非权威材料，原字段和失败认证保持；不能成为raw、事实或批准。草稿元数据只作检查点身份，正文不成为第二份业务权威，也不进入最终candidate/delivery。输入或已审父接口改变时只复制同owner/schema的旧草稿到当前冻结source及新祖先seed，旧seed整树和旧accept都不继承；所有当前业务门、只读源码/tests对象与absence及独审仍完整执行。草稿失败在现有预算内修复，Native成功回执与业务draft拒绝分开，不伪造Native rejected final。已认证且停稳的Native小回执失败若由现有资源桥提供精确failedWorktree，只从该真实提交经同样scope校验保留非权威草稿；原Native错误和旧缺席不变，下一实际编辑继续该文件，不把失败回执文本当业务JSON。无安全Git见证不补Git身份；未提交文件仅可按已认证停止的精确physical_draft材料接缝读取，不猜路径或补签。受控runner的真实Git回归不代表真实ClaudeCode/ZCode全链验收。

历史未启用草稿协议的同owner已结算原生格式/schema失败可通过既有repairDiagnostics传递round.rejectedOutput完整文本及原文ref/SHA，提示明确untrusted prior failed output。原生边界先认证final与停止，资源桥再核原请求；本轮call重核请求摘要/schema/purpose/身份后才保诊断。它不是业务输出、候选、raw/facts或批准，所有JSON/schema/引用/业务/独审门不变，旧缺席不补。

当前native-worktree操作的新P1草稿生成使用[[sync-stage-worktree]]的真实edit seed，独审仍使用真实只读seed，允许按需读取完整仓库。生成seed为原composed加已审祖先接口；独审seed另覆盖本轮渲染的完整Spec候选及真实move/retire。提示只给相关Spec路径、targetIndex/首次必建indices、真实raw差量、事实、技术范围/不可改oracle、精确授权与失败诊断，schema仍规范业务行；不重复完整树或强制逐字读取运输。程序按实际seed对象补足契约引用验证所需代码/测试，不把files投影当读取权限。完整业务输入、实际seed/tree及prompt/schema参与摘要；原raw/ID/演进/全图seal、独审与预算门均保留。下文受限frozen读取说明仅用于无worktree的历史操作与旧单测。

首次P1原生草稿协议登记且没有既有P1派发时，本attempt的`elaboration-draft-protocol`冻结`generationGuidance`。`ac-test-binding-v1`仅在完整生成提示说明`AC.test`使用仓库相对测试路径#稳定用例ID，引用现有测试必须读取其真实声明并核对用例覆盖本条断言。裸路径、pytest `::`等框架选择器、自然语言后缀、伪造ID或无关测试均不得作为绑定。`AC.command`引用可信登记中实际执行该用例的VERIFY-ID。包装测试须有真实稳定ID且执行确实覆盖本条断言，套件登记本身不构成绑定。code→spec的源码及全部测试保持只读，缺失证据仍由现有校验门阻断。

`ac-test-flow-binding-v2`的完整生成除原测试绑定说明外，还复用受限完整流程提示，本轮实际承接的每项业务REQ至少由一个主FLOW.req直接覆盖。`TR.from`、`TR.event`和非空`TR.to`引用同一`TR.object`。从冻结原意、事实、契约与实现识别真实有状态对象的初始状态、事件及非终态出口，不能虚构状态、事件或终点。确属无状态的`FLOW.terminal=END`在正文说明不适用依据，每个STEP提供输入、可观察输出和已定义的失败或不变量RULE。旧v1、历史stage缺字段及已有reserved请求且无stage各按原提示恢复，字段存在但未知时停止。提示参与派发摘要，业务输入、schema、独审、父接口提示及写入权限保持。跨已结算attempt的新生成继续原Git草稿及完整拒因。[[sync-migrations]] writer30阻止旧writer写入v2阶段或派发。

`ac-test-flow-review-binding-v3`完整生成沿v2的测试与流程提示和已停Git草稿准入，并复用 [[elaboration-output]] 的冻结VERIFY登记规则。正常独审与仅续审复用生成侧测试绑定判据。对已有测试，沿冻结VERIFY命令和包装器的实际调用核实其选中并执行覆盖当前AC的断言。套件登记或包装器的稳定ID不足以证明覆盖。已有证据错绑须结合候选AC及冻结测试证据提出普通P1 repair。原授权可写范围内合法缺失的实现、测试文件或用例，若冻结VERIFY可在补齐后执行且未触及只读测试，沿原结构诊断交P2，由V3实测。仅有可绑定的真实冻结证据时，独审发现的实现或测试缺陷才另报implementation-review。待实现不算既有覆盖，明确原意下的只读实现或测试缺口仍以readonly_implementation_gap阻断。保持候选、原生成身份、独审隔离和权限。父接口及已冻结v1、v2、字段缺席或仅reserved无阶段记录的请求按原提示恢复，不重派已接受结果。[[sync-migrations]] writer31保护新冻结版本。

新登记使用`ac-test-flow-review-verify-repair-v4`，继承v3的生成与独审约定。完整Native生成沿原稿续修时，若真实失败诊断指出可信登记中同一VERIFY的重复定义或AC.command悬空，在任务前给出该ID在本轮完整局部候选中的单一位置。已有冻结定义优先保留，处于只读context或本轮未受影响目标时直接引用。无已有归属时，仅在原冻结绑定允许且当前分析可修改的一个targetIndex给出精确登记的声明位置。多个冻结归属无法唯一决定、已退役、本轮没有可变目标、纯重构、纯父接口或非此类失败不提示新增定义。Agent先核对共享定义，再逐项复查全部原诊断，不能删AC、改变验证政策或借诊断扩写权。原Git字节、完整诊断、任务与诊断JSON边界保持，生成后继续通过原结构、演进、独审及最终全图封口；程序不改候选。v1、v2、v3和缺字段的已冻结请求按原字节恢复。

存在当前受审P0时，Native生成与独审共用的任务快照完整保留既有analysis正文及ref（含changes分类、paths、affectedIds、ruleIds、原意/行为、evidence、反例与追踪），分区同时保留实际partitionBinding及aggregate analysisRef；本区分析沿既有分区投影选源，不另猜范围。authorChanges仅保留在analysis内，不另造重复投影。authorizedChanges只列AC/VERIFY变更、退役/恢复等特殊动作，空数组不禁止依据当前分类、raw与源码同步已审非冲突明细；历史finding原样保留并按当前分类重新核实，不能用旧refactor限制替代当前allowed_change。当前analysis不等于本轮P1批准，原preserve_business、AC/VERIFY逐项授权、退役、owner写范围及独审硬门保持；analysis缺席时不宣称已有分类，不新增持久字段或版本。受控真实Git回归覆盖whole/partition两阶段精确分析投影、原八条诊断保持与特殊动作越权拒绝，不替代真实模型业务验收。

Native P1生成和独审共用既有短来源语义：可观察不等于重大业务政策；普通无冲突实现细节可沿合法code来源并追到REQ；明确原意下的实现/测试缺陷不是未知政策或业务GAP，独审须纠正对实现的误读。显式空`implementationWritePaths`时，提示须明确源码和全部测试只读，不发明或新增测试，也不把实现差异交给无写权P2；缺口继续以`readonly_implementation_gap`阻断。共享这段来源语义不改变`interface_seed`只维护父接口、不要求完整FLOW/AC/实现的阶段边界。历史请求及原件不改写。

模型调用期限沿 [[structured-session-runtime]] 原样传递，明确 null 不装调用计时器；生成与独审、完整读取及各自业务门禁保持。

interface_seed的生成与独审只承担必要REQ/RULE/GAP及跨子区共享接口，不混入完整P1的全对象、FLOW/STATE/TR和AC覆盖任务。父层已经声明的条款仍须准确、相容且有原意/事实来源；尚未确定的普通字段表示、缺省值或等价校验顺序留给对应子分区读取实现后细化，不强迫父层提前穷举或制造GAP。description与prose只保存稳定业务用途、接口与不适用依据，不保存上一候选、本轮修复或去重过程。共用表列、来源、null、权限/原意保护规则保持；非父完整细化与独审指令逐字保持原契约。schema门槛、独审、预算/修复循环和严格全局seal不改变。

生成与独审共同读取冻结技术写范围及只读测试清单。既有只读 oracle 继续执行；需要新增断言时，P1 先把 AC.test 绑定到原授权可写测试路径，不能把修改只读 oracle 的要求延后交给 P2。本轮可变owner候选业务正文的待办/进度问题须在 P1 普通 repair 修正。implementation-review 仅用于可在原授权实现/测试范围完成且无需改业务正文的实现修复；含此发现的原生 verdict 同样须为 repair，accept 仍严格要求无发现。

范围映射：REQ-SYNC-03、04；P1；AC-SYNC-01、02、03、08、14、25。实施依据为 `docs/spec-code-continuous-sync-plan.md`。本节点交付需求细化、声明追踪及独立语义审查；完整代码、运行验收和落盘由 [[sync-execution]] 与 [[sync-verification]] 继续完成，不能把细化通过作为已同步证明。

构建者产出 REQ→FLOW/STEP→RULE/TR→code→AC，独立审查者从原意重新走路径。每个适用状态×事件必须明确转移、拒绝、幂等或有依据的不适用。覆盖权限、边界、竞争顺序与副作用。图和覆盖投影只能派生自 [[sync-contract-schema]]；无状态能力须说明输入域、不变量和不适用依据。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。

未启用草稿协议的历史`elaborate` 接收冻结的目标路径、节点身份、原文字节及摘要、用户原意、已有契约和有来源的事实；生成、审查都调用受限只读结构化会话，返回完整 Markdown 候选，交付写权限仍属于协调器。候选不得越过目标范围、更换源摘要或改写用户原意；无明确变更依据时保留既有 REQ、AC、VERIFY 和验证政策。[[sync-contract-evolution]] 在旧新全图核对稳定 ID，跨叶移动不当作删除。已有 AC 语义仅在合法规则变化及真实冻结、独立审查的行为分析授权 update_acceptance 后自动更新；生成器自身失败不构成授权。用户原意或可信裁决已决定退役或改变验证政策时，冻结 `authorizedChanges` 提供具体 ID、操作、来源及理由，程序允许该变化并由独立审查核对依据，无需再次批准。返回实际退役 ID，拒绝复用协调器提供的历史退役 ID；退役记录由后续协调交付持久化。新增裁决来源必须属于冻结事实或既有可信契约中的裁决 ID，不能由模型声明获得授权。每个业务项经来源与依赖能追到用户需求。

每轮先验证 [[elaboration-output]] 的结构，再调用 [[sync-contract-schema]] 解析与引用、完整性和状态矩阵检查；raw 段使用解析器的围栏感知结果，原文里的示例标题不成为正文分界。独立审查使用另一会话及线程，从原意、冻结事实、全部适用性和候选重新走路径。程序或审查的具体缺口触发有限修复；重要未知事实或业务冲突须先形成准确 GAP，不能自动编造政策消除错误。GAP 仅阻塞来源、规则和验收依赖闭包；确实位于同一 GAP 闭包中的未知状态事件处置和业务完整性发现保留为 `blockedStructureFindings`，独立流程仍由审查确认后输出可推进项。重复 ID、悬空引用、非法来源等全域结构错误不能借 GAP 豁免。

独审在完整冻结输入、raw 和候选 Markdown 之外，同时取得同一轮候选检查已解析的业务行视图：仅包含本轮 changes 的精确 nodeId/path 对应契约内全部业务行及其原解析字段，不重复未变更或只读上下文契约，不以生成器差量或自述代替候选。JSON 和 Markdown 的转义是展示编码，审查须以解码后的解析字段值对照原意和事实，不能仅凭序列化反斜杠数量断言业务字面值改变。视图不提供通过结论，不替代原 Markdown、全图验证或独立语义审查。AC-ELABORATION-45 以真实渲染和解析核对正则、反斜杠、管道与反引号逐字一致及只读上下文隔离；AC-ELABORATION-35 保留完整旧行，AC-ELABORATION-46 保持错误引用类型、悬空 VERIFY 和无需求追溯在独审前拒绝。注入 runner 的这些回归不代表真实 Agent 验收通过。

[[elaboration-result]] 保存各轮完整候选、生成与审查原始输出、具体发现、会话追踪及摘要。业务结构与独立审查通过后，根据 GAP 返回 `complete`、`needs_input` 或 `conflict`；安全能力不足为 `unsupported`，执行失败为 `failed`，取消为 `cancelled`，未消除失败且预算耗尽为 `exhausted`。总预算到期但原生停止未证实时，保留 `cancellation_pending` 原始错误和精确会话身份，结果为 failed；不得用 exhausted 掩盖未停稳或派发新原生会话。确认取消后，总预算才归为 exhausted。

这些均是细化阶段结果；`runtimeVerification: not_run`、`implementationReady: false` 不能作为已同步证据。尚无实现锚点或测试的具体缺口保留给 P2，不制造虚构 `code:` 或运行通过结论。

独立审查发现完整业务契约下的源码或测试缺陷时，Native与非Native请求共用完整说明，明确 `verdict: "repair"`、`kind: "repair"`、`code: "implementation-review"` 三个精确值，不得添加后缀或自定实现code；例如代码 TypeError、DTO 被当完整对象递归、修改返回值后按污染结构比较导致误断言，不触发业务细化或新 REQ/RULE/GAP。该发现必须关联当前契约图真实且非空的 affectedIds，并在 evidence 中提供冻结上下文中受治理 code 或 AC.test 的具体相对路径加符号或行号、失败反例；decision 明确仅修实现并保留业务义务。程序核对身份和冻结治理位置，绑定不成立仍作为具体阻断发现。原 review 完整留存，待实现发现保留受影响身份、位置、证据及修复决定；review 新增发现后刷新 deferredImplementationFindings。任意自定义业务 repair、真实遗漏边界、重大未知和冲突继续按原门禁处理；reviewPassed 仅表示业务独审通过，不是运行通过。仅有待实现发现的候选不能成为要求具体业务阻断的 repair seed。AC-ELABORATION-41–43 覆盖完整契约不变与实现证据延后、位置/身份不合法的硬拒和混合业务缺口阻断。Native请求的受控消费者回归验证精确协议经真实P1门禁后产生待实现发现并可进入现有code_generate派发，后缀code仍阻断；该模拟不证明真实模型必然遵守，实际新Native仍须产品验收，旧拒绝结果不变接受。

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

freezeElaborationInput为生成、独审及同operation局部interface_seed承接共享的唯一完整输入冻结与摘要接缝；requestKey和执行预算不改变业务摘要，原意/目标/上下文/文件/授权/技术政策/分析及完整分区绑定均参与。承接不能另造摘要算法或改写旧inputDigest。

readonlySpecRepair独立于P2独审refinement，绑定真实全候选V1错误及已接受局部原件；只作为技术锚点失败诊断进入对应owner冻结输入。历史JSON/review不是新事实或授权，raw、业务义务及稳定ID保持，允许修正实际冻结代码的定位选择器，不能修改只读代码或测试。新候选继续结构校验、全量独审及最终seal/V1；历史accepted结果不会被改成失败seed。

其candidate_review分支绑定真实独立code_review的具体repair及候选内契约定位，历史生成JSON只作诊断和稳定ID对照，保持原冻结作者source/raw/facts及授权；不得把尚未交付的生成候选提升为作者政策。新叶可按原意和实际代码/测试纠正错误的Spec证据表述，既有作者AC/VERIFY仍受原演进授权硬门，不得改只读源码/tests或降减原raw义务。缺事实或冲突仍按原门阻断。

totalTimeoutMs显式null表示本次P1没有总时间期限，省略仍沿既有有限默认；每次调用timeoutMs仍为有限正整数。无总deadline不创建总期计时器，不将null参与减法；每attempt原maxCalls/maxRepairs机制及生成/独审角色保持，取消与未停稳原生资源仍按原失败门禁。

跨attempt的P1续修在validateRepairSeed核对原结构化输出schema、候选/生成/独审摘要及traces之后，将seed.output原始JSON逐字序列化投影到repairContext，明确仅作拒绝候选的格式骨架/诊断、以当前schema为准而非事实或授权。seedCandidate保留为Markdown渲染视图作业务对照，不得把表格占位符当JSON值；null、数组等按当前schema的真实JSON类型修复，旧协议字段不取得新生成权限。原结构与独审诊断、review、来源及原件不改，仍须新独审与全部验收门槛；不涉及Native schema错误采集或分类。


分区最终封口的程序校验上下文以协调器已验证的真实 composed 不可变树为基准，补入未参与本轮分区的既有只读承接节点及其真实源码/测试；不能把只读祖先的全部义务误要求由本轮局部叶重新承接。Agent 的 targets/context/files、完整读取证明和写范围保持原分区投影。已冻结局部读范围中的真实缺席不得从旧树补回；本轮完整候选的替换、新叶和冻结 move/retire 仍由原候选 overlay 在严格全图检查前执行，删除的旧节点不能继续提供覆盖。最终门继续检查完整图的真实引用、祖先义务、AC、代码与测试，不能过滤 projection missing 或关闭 strictContextCoverage；局部已审原件与摘要不改，最终 seal 摘要绑定补全后的实际程序图。


生成提示从同一elaborationTargetBindings分别列出全部合法可更新目标及其原始targetIndex，以及缺少完整sync-v1基线而首次必须显式构建的子集；首次必建为零不能被表述为本轮没有可更新目标。已有契约只在确无相关业务差量、也无已核实修复需要时可省略；reelaborate仍按本轮raw/facts、具体repair及明确authorizedChanges范围落实必要业务行，不以仅复制raw或空changes保留失配。授权不强制改动已经符合要求的行，未受影响义务及原写权保持；真实零目标、只读context、父接口阶段和合法退役仍沿原target/schema门。

Native每轮生成复用与历史受限路径相同的repairContext，收到上一轮真实结构化输出、按当前阻断/P2待实现/GAP闭包分类的具体发现及原独审；已结算拒绝seed和只读owner诊断也保留完整原件对照。运行时格式失败没有候选时，不伪造seed：协调器只向同完整输入的本owner传入原失败code/message、resultRef及实际末轮输出/发现/独审/trace。诊断不成为raw/facts、业务批准、政策或写授权；新的生成和独审仍完整执行。业务inputDigest及已审缓存资格保持，诊断正文与来源ref进入真实prompt，因而参与现有模型requestDigest；旧原件、Legacy模板、解析schema、预算和全部readonly/REQ/AC门禁保持。

同一诊断接缝也保留候选渲染前的具体结构拒绝：已结算repairable来源必须为exhausted/repair_budget_exhausted、末轮candidate:null且有明确error发现（如重复业务行rows_patch）；不伪造候选seed，原schema和结构门槛保持。

Native完整叶生成提示明确区分引用类型：FLOW.req只引用REQ，并直接承接各级实际适用祖先REQ，AC.covers也直接承接这些祖先REQ；实际适用祖先RULE由AC.covers直接承接，或经本叶TR.rules引用并由对应AC覆盖该TR。不能将REQ/RULE合写为FLOW.req的合法集合，不引用兄弟或不适用义务。interface_seed仍不展开FLOW/AC；Legacy有效模板、schema、reference-kind硬门、原AC授权与独审范围保持。

readonlySpecRepair的partition_seal分支复用已接受局部诊断接缝，绑定真实失败aggregate与其局部原件，仅传severity:error和历史JSON/review；保留原业务写权限，不强制改变implementationWritePaths。父仍仅审接口，真实full owner修复适用承接，原raw、稳定ID及作者AC/VERIFY授权门保持；旧accept不成为失败seed或全局批准。
