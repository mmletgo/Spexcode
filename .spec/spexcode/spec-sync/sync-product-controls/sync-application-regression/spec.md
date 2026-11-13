---
title: 同步应用回归
status: active
hue: 175
desc: 临时 Git/SQLite 验证受控请求、幂等、失败查询和过期输入。
code:
  - spec-cli/src/sync/application.test.ts
---
# 同步应用回归

## raw source

真实 Git 与 SQLite 必须证明不先提交 Spec、不重复受理、不虚报失败或旧版本结果。

## expanded spec

AC-APPLICATION-STOPPED-04 以真实 Git 元数据身份替换复现同 canonicalRoot、不同 repositoryId 的历史 queued 操作和未结算资源共存；当前来源 stopWriter 成功暂停，只返回当前仓库诊断及其真实未结算资源，旧操作、attempt、资源与物理控制逐值保持。使用隔离 SQLite 与受控 runner，不声称真实 Native 执行或生产恢复完成。

资源专用入口用真实隔离Git的.git替换复现repoId变化，先确认正常read/recover/cancel/resume仍404，再证明只结算原operation/input的精确Native资源。错误input/foreign root拒绝，缺失/错配计划及停止未知保持未结算；pending journal原样保留，原operation/attempt.failure、输出/发现原件逐字不变，业务claim/dispatch/生成/交付方法均零调用。测试只证明正式资源接缝，不冒称真实Native停止。

AC-APPLICATION-STOPPED-01/02/03用真实Git/SQLite和正式stopWriter→control(recover)入口先复现stopped门禁使finished缺席的TypeError，再证明只清理原planned且明确未派发的资源；六次真实store预算预留（模型runner一次）及原operation/失败/refs/deadline保持，observer/FIFO和物理控制不恢复。queued无资源仍零模型/attempt；stopService且物理control仍run的对照在recover后显式start仍不派发，不能靠物理pause掩盖stopped门禁。错误plan仍以resource_recovery 409保留planned及原业务失败，不以空值fallback或假removed绕过。夹具仅证明编排与原清理机制，不作为真实Native调用/清理的产品验收。

官方 init 的 `.plugins` 实例模板出现在注册根之下时，显式 nodeIds 与缺省治理注册仍只扫描业务节点；覆盖分母及 included/excluded 不含插件，显式提交插件意图在模型调用前拒绝。真实业务子树的新增 raw 与独立未授权节点保持原判据。

状态查询对超过单批的真实固定 runtime 仍完整核对 manifest；前次查询通过后修改任一文件，下一次必须显示恢复诊断且零模型派发，真正执行入口同样重新拒绝。异步检查只改变事件循环公平性，不产生可绕过完整读取的缓存或 ready 捷径。

AC-APPLICATION-01 验证配置缺口、enable 摘要 CAS 与配置字节保留；02 验证 no-op 不派发、不提交及过期正文拒绝；03 验证 requestBlob 进入 coordinator、请求幂等/键冲突、失败查询及 source/HEAD 保留；04 验证输入过期、旧输入恢复拒绝及配置变化失效；05 验证共享治理叶闭包及宿主命令拒绝。

AC-APPLICATION-SCRATCH 从真实 Git 冻结配置读取 environment 的可选布尔 scratchExecutable，省略/false/true 原样进入受信环境，字符串、数字和 null 明确拒绝。

06 使用真实 Docker、compiled CLI 和正常 Git hooks 交付完整候选，source 不被覆盖，completed 重放沿原共同基线，不重复 native/commit，工具索引丢失只恢复相同 frozen runtime；模型 runner 为确定性替身，不能算真实 LLM 验收。07 验证并发同请求只有一个 runtime/operation且预算不重置；08 验证 queued 资料缺失可查询恢复诊断、原描述恢复成功、已派发操作在原描述丢失后禁止重冻结。

09 验证显式 callTimeoutMs 只来自 operation 冻结配置，live 修改不扩大旧请求或总预算；10 验证已启用后删除、坏 JSON 或越界配置保持 invalidated，恢复原字节才恢复 enabled，不允许自动降级普通独立 Spec 提交。

11 验证 initial 来源真实执行、持久入账和同键改来源拒绝；12 用同仓库两个真实 Git worktree 和 OS 互斥锁验证 FIFO、busy 无自旋及后继来源接续；13 验证已出队暂停恢复先等待有效 FIFO，前序结算后自动恢复，wait 等真实执行，预算不重置；14 验证两个仓库共享 canonical SQLite 时各自派发，不能执行或被另一仓库消息头堵塞。

15 验证普通重复归并、显式 retry 关联新操作/预算及同 retry 幂等；16 验证完整继承原 requestBlob/正文意图及旧共同基线，禁止新 patch 或旧来源变化；17 验证 queued 不可借 retry 重置预算，从未交付 cancelled 可经真实 FIFO 明确重试。

旧 failed plan 的 owned related 漏读回归使用真实 Git 与公开 store 准入/失败动作固定原 plan、selection、旧读摘要，再经实际 submit(retryOf) 验证读取摘要改变时按原 SYNC_RETRY_BINDING 明确拒绝，原 operation、plan/policy、scope/targets、dispatch 与读取证明均不补签。实际 fresh submit 以新计划冻结完整只读闭包，保持相同目标与写范围。observed 的 index-only 新 glob 成员与实际依赖变化须 stale，commit 捕获忽略后续 index/WIP、真实 HEAD 改变仍拒重试。snapshot 已有的 untracked related glob 成员须以原 mode/OID/完整正文进入实际分区分析分派且保持只读。字面 absence、合法 docs/ 前缀与发布父树保护沿同一闭包；原 base 恢复只用冻结 provenance，不读取新 frontier。受控 runner 仅捕获请求并失败，不证明真实 Native、代码生成或交付。

18 用真实 SQLite 注册 native 创建结果未知的固定 plan/checkpoint，验证已失败/暂停但资源未 removed 时 executionAvailability 为 recovery_required，retryEligibility 拒绝新预算。创建故障为明确测试接缝，不代表实际模型或未知宿主进程已验收。

19 验证 recover 对 queued 不派发、不改 operation/control/预算/输入、不消费有效 FIFO；20 用真实 store conflict 事件验证 conflicted + 未结算资源不能 ready，再恢复固定且未曾请求 native call 的资源，保留冲突、attempt和预算，配置失效也不阻清理。恢复已创建 native 或 Docker 的真实案例仍由 coordinator 的资源恢复验收覆盖。

21 注入内容可寻址但 native 身份不匹配的固定恢复计划，验证 coordinator 的具体 resource_recovery 以可见 409 返回，原业务 operation/attempt/预算及未释放资源保留，不只打印日志。

故障 runner 为测试接缝，不算真实模型产品验收。完整真实 Agent/Docker 落地仍按 [[spec-sync]] 分阶段验收。

22 先复现同受控 patch 仅换 requestId 导致两次模型调用和新预算；修复验证同一 failed operation/deadline/calls、B 再次重放、不同 patch/意图分离、同 key 冲突、显式 retry 原 requestBlob；实际 source/index/HEAD 不改。

23 以正式 v6 schema 及保留原请求/payload/预算的历史受理记录重开真实应用，再提交相同 patch 的新 requestId 和 alias 重放；仍只一个操作、零新增模型调用。


AC-APPLICATION-P3 在真实临时Git和canonical SQLite中冻结可信analysis checkpoint；手动code/combined入口真实受理。三个选择各自建立decision新operation，keep_intent无正文差量不丢请求，adopt/new_rule固定plan确含用户新输入且保旧原意；相同请求并发只派发一次，同key不同选择拒绝。错analysis、未知finding、stale input拒绝，旧operation superseded但分析可查，source/index/HEAD不先写。该场景只证明应用准入，真实生成/独审/Docker由协调器与上层验收。

跨应用/store验证：同choice换运输UUID、同findings换顺序仍复用同operation/deadline/calls，不只验证samekey幂等；修改选择仍需新业务输入且samekey拒绝。

P3准入同时断言固定plan的decisionAuthorities精确只含所选finding的规则/影响项/路径及不可变requestRef，不从用户任意字段或自然语言fact提取授权；未选独立GAP不进入该结构。

AC-APPLICATION-P3-PARTIAL用真实临时Git及明确fixture结算基线验证：已交付A规则后在同一原输入选择B，冻结raw同时保留A、未选义务、原受控正文编辑和B选择，source字节保持只读；先复现旧attempt raw丢失A，再验证修复。不将fixture receipt宣称真实模型或Docker交付。

P3-PARTIAL同时覆盖分行及同行互不重叠的A交付/B裁决，完整原raw和受控字节均保留；同行失败证据先确认旧行级冲突fallback丢A。真正覆盖同一文本区间时，准入冻结plan不得写临时rawSource，完整三方对象仍可读，留给绑定当前operation的独审整合；本应用场景仅验证准入与原意保真，独审解析和最终候选另由协调器回归。

AC-APPLICATION-P3-DELIVERY复用06的真实临时Git、canonical SQLite、compiled CLI与普通hooks，可信预登记VERIFY-DECISION-01。外部源码新增filter超过8字符拒绝，与原RULE-EXPORT-02/AC-EXPORT-02的非空要求形成具体冲突；submit(code)真实分析和独审生成检查点，公共wait读取analysisRef/finding，三choice分别decide→wait→V1–V4/Docker→settled receipt。keep_intent移除上限且raw不变，adopt_behavior明确8上限，new_rule明确128上限；原oracle不改，新generated-tests覆盖8/9、128/129、空、幂等和权限。实际receipt正文、规则及源码符合冻结选择，未选原义务保持，source/index保留、重复裁决不新增call/commit。native输出为确定性替身，不宣称真实模型验收。

AC-APPLICATION-P3-ORACLE-REAL 在 fixture 作者起始可信提交中登记不可改旧 oracle：9/129 长度均接受。公共 submit(code)→decide→wait 三选择执行同一完整 Docker 命令，keep 相容分支真实 receipt；adopt/new_rule 新限额真实 V3 非零、预算耗尽且无 receipt，绝不在裁决后改 oracle。ORACLE-PROTOCOL 用同一精确独审 finding 和冻结输入验证互斥分类由泛 generation_failed 改为 needs_input/oracle_policy_conflict，保具体裁决、定义、旧 oracle 摘要及矛盾反例；终态 wait 重放不新增 call，source/index 保留。本协议 runner 为明确独审接缝，不冒称真实模型判断。

ORACLE-PROTOCOL的adopt_behavior/new_rule使用无已验证pair的精确all-null选择，先复现AC02被空旧图误拒至预算耗尽，再核原analysis所属attempt的composedInput精确绑定并进入新分析与独审；两者均以6次调用到达原政策互斥needs_input，verifiedDelivery仍为空，无verification/receipt/source/index变更。

AC-APPLICATION-P4-01 使用真实Git/SQLite和明确故障runner验证无Dashboard持续服务：物理暂停期间提交保持0dispatch，恢复绑定最新snapshot，重复补偿不重开失败调用；02 验证服务offline、停机外部Git提交和启动补偿；03 验证branch切换旧授权失效、物理pause跨branch保持以及显式新授权。

AC-APPLICATION-P4-04 验证nodeIds明确子树、新纯raw后续提交、parent/child不重复注册和越域manual拒绝；05验证省略nodeIds仅从实际受治理授权路径接入、未授权code保持excluded以及纯raw首次需显式注册。

AC-APPLICATION-P4-06 使用真实Git root移动/重建，验证持久健康、实际process在线、最后差异证据、missing query与snapshot保留；新物理root未授权不冻结新snapshot、不派发，stop持久stopped而非旧online。

AC-APPLICATION-P4-07 验证重新授权后旧root确实撤权，已注册root被删除时仍在missing范围且保留真实node_unknown观测，不把它显示为空项目正常。

AC-APPLICATION-06 使用 Spec 驱动的实现交付验证真实 Docker、普通 Git hooks 和新的收据提交。原分支保留初始 HEAD，完成后重放原请求及恢复固定工具描述均保持原共同基线、收据和调用数。

AC-APPLICATION-P4-08 真实Git/SQLite、正式观察服务、compiled hooks与Docker验证无浏览器提交触发自动交付；native runner是明确确定性替身。输入冻结commit，代码提交只更新已审Spec、不派code_generate，交付的全部非Spec Git对象与提交输入保持一致；未采纳前原source/index/HEAD保持，补偿及scope外作者编辑不新开回声operation，scope外变化不错误标stale。

AC-APPLICATION-P4-09 真实失败后scope外编辑不改变stale/重试资格，同request重放沿原receipt，新retry绑定原input；相关原始意图变动则stale并拒绝旧输入重试。

AC-APPLICATION-P4-10 在可控native执行期间物理pause，单operation detail独立展示physicalControl=pause，原operation.control保持run且资源在安全边界结算；暂停提交仍更新latest且无新调用，resume先准入最新input，原active input不被改写。

AC-APPLICATION-P4-11 同一真实Git/SQLite来源两个独立节点分别提交，四轮实际Docker/正常hooks交付（在线两次、停机编辑重启补偿两次）均要求workspace_synced和真实receipt，source/index/HEAD保持；实际作者源码完整保留，每轮全部非Spec Git对象与该轮真实composed树一致，不派code_generate。第二节点的原Spec和确定性P1输出共用独立other-job实体域，STATE、EVENT、TR不与export-job合并。同一HEAD内已提交源码作为原样基底保留，独立节点隔离核对另一Spec的Git对象保持原值、且未列入本轮deliveredScope；行为runner明确为确定性替身，不算真实模型验收。

Docker应用夹具可复用SPEX_VERIFICATION_EVIDENCE_DIR保存实际观察/operation/attempt/journal投影、关闭后的真实SQLite与Git对象证据，失败断言含journal与blockedReason；归档不制造基线或修改权威状态。独立节点以首个真实receipt的完成顺序核对另一未消费输入，不能假设独立范围的完成顺序。

纯注释自动场景的确定性行为分析明确返回refactor；只有显式choice冲突夹具返回filter长度冲突，不能把夹具主动冲突误报为产品交付失败。AC-APPLICATION-P4-12验证同request换已授权child拒绝且无新派发，重新enable变更预算后旧请求重放/重试均保配置失效，不能以新配置重用旧政策。

AC-APPLICATION-P4-13以真实Git快照、显式仅投影fixture pair及公共三方getter先复现Spec nullbytehead回声，再验证已消费原样Spec不变、raw编辑/退役ID/owner消失仍有变化；不登记假receipt或改SQLite。真实首receipt只改src的自动回声fail→pass仍由08同场景验收。

AC-APPLICATION-P4-14复现真实source作者注释、delivery等于source、所有bytehead均null而仅intent已消费时的源码回声，再验证统一消费判据；无生成字节差量不强迫模型添加无意义注释。P3公开裁决入口测试通过正式ack/claimQueued领取fresh exact操作，组合与analysis stage绑定真实selection/readset；旧legacy claim不再用于新操作。

AC-APPLICATION-P4-15用真实 Git 快照和明确只读投影 pair 复现旧非 null 源码 byte head 对已完整消费源码的回声，不向 SQLite 登记假 receipt。统一组合证明后重复 observeNode 不新建 operation 或派发；后续新源码与新 raw 仍分别显示真实 code/spec 变化。真实 journal 只写 Spec 而保旧源码头的证明由 [[sync-composition-frontier-regression]] 补齐，实际自动重复与修复后的 Dashboard 采纳由产品验收留证。

P4 partial→decide使用原P3-DELIVERY keep_intent真实链补强：fresh exact source先产生settled partial receipt，断言原selection与真实heads已分离；旧caller准入复现SYNC_BASELINE_STALE。修后新decision保原input/analysis/scope，沿相同资源当前selection经Docker落地，交付后同选择新运输ID仍归原operation/deadline/calls/receipt。确定性冲突仅指真实src的filter边界，其他changed路径逐项refactor覆盖，不能制造无关分歧或漏分析。P3-PARTIAL历史case通过公开无selection legacy准入明确旧身份，保既有历史pair夹具，不用它代替P4真实partial验收。

确定性细化夹具保留表格之间全部业务说明，不按首张表截断。partial裁决整合仅在冻结source与base逐字一致、Spec原raw及全部业务项和说明等价时沿完整真实delivery；双节点停机补偿则逐字核对source仅新增指定作者注释、delivery仅新增受审生成注释，再提交保留两者的完整resolution。两者均经过正式独审与候选门禁，不能以refactor分类代替文本重叠整合。

真实 Git/SQLite 用例覆盖默认旧 JSON 与 v1 描述不改、正式另模型 retry、重启省略继承、普通重复换模型拒绝、全阶段请求及描述/operation 模型冲突拒绝；遵循 [[sync-model-selection]]。版本化 `sync.model` 用例先复现现有 schema 拒绝配置，再验证精确字符串及空白拒绝；两个项目独立使用各自新操作默认选择，手动选择覆盖项目默认值，同 request 与省略 retry 仍沿 prior/retry 绑定。新原生工作树未配置时，正式手动准入和自动观察都固定claude:default，工具描述v3及runner request保持同值；手动暂停场景只证明准入/重放/取消后省略retry继承，自动服务场景才证明真实runner接缝收到默认选择。历史工作流省略配置仍保旧默认语义，受控runner不冒充真实Claude模型或最终交付。

已存在或备份固定运行描述先核精确期望模型，再允许admission。未受理请求留下的原描述若与后续选择不符，明确早拒，不新建operation/receipt/FIFO且不静默重建；匹配原描述的合法显式retry或新请求仍沿既有入口。

行为分析测试接缝从完整runner request还原body-entry-v2正文，保留真实冻结视图的逐字校验；模型接缝的确定性输出仍不能充当真实Native读取或业务同步完成证明。

暂停/恢复夹具必须使用真实在途可取消调用，验证两次attempt均沿原operation的callTimeoutMs与总deadline；已失败的精确请求重放不能制造额外调用。raw-only initial先行为分析；FIFO/资源专属夹具则以真实已提交code映射隔离未治理启动分支，使用持久nextQueued核队列位置。recover后资源清空不等于坏配置恢复有效，仍应保留conflicted、原attempt/预算及sync_delivery_evidence_invalid诊断。

提交门禁回归先以旧实现证明未提交 Spec/代码保存错误改变自动输入，再验证保存、git add、提交后立即出现的新 dirty 字节均不混入自动输入。真实 Git code-only/spec-only/mixed commit 分别形成 code/spec/combined；同 commit 重扫、服务重启不重派，停机 commit 启动补偿保持分类与已提交字节。Dashboard 受控 patch 仍由03的即时 submit、不先提交原树证明。enable 配置和注册树夹具必须明确先 commit，未提交配置不成为自动授权。

累计提交边界由应用传给规划器的 commitTrigger 验证：initial.before 为 null，后续 before 精确复用上次自动接入 InputSnapshot；停机先提交 Spec 再提交代码仍为 combined，paths 同时含两次真实 tree 差量，before 不是 HEAD parent。暂停期间仅观测的快照不能消费首次 initial 边界。

消费边界回归用真实Git/SQLite与明确只读的消费记录投影（不登记receipt或权威baseline）复现两个失败：当前已消费HEAD被排除后，自动Spec操作supersede尚未交付且保requestBlob的UI正文；501条普通observed挤掉已消费Spec后，真正code-only提交误分为combined。修复要求同HEAD为空差量、不新增operation且原请求保持queued；重新创建应用后before仍为完整已消费快照、paths仅真实新源码，不调用模型。新文件、删除、mode与null绑定的真实残差继续由提交及组合回归保留。


分区故障回归允许单操作的不同分区同时在途，按实际唯一 requestKey 集合核对首次派发与重放/暂停期间的零新增；不把整操作固定成一个模型调用。应用夹具提供足够通过真实分区预检的测试预算，预算不足零调用的产品门禁仍由协调器专门用例验证；不调整实际项目预算。

自动观察模型绑定与retry幂等回归按每个operation首次真实runner请求集合核对 `callsUsed` 和唯一 `requestKey`；同请求或retry重放不能扩大该集合。提交分类夹具可拦截执行入口以隔离 `code`/`spec`/`combined` 准入与commitTrigger分类，但必须保留operation准入，不把初始分区派发假设成固定一次或零次。

配置回归精确接受原有限budget及仅mode=unlimited，拒混合、空或无效mode，单次callTimeoutMs仍有限正整数；无限总期允许独立20分钟调用设置，旧有限调用不得超过总期的断言保持。

v21下真实oracle状态证据从统一typed checkpoint读取接缝提取JSON材料，原status、命令、exit、具体旧断言及source/index字节断言保持；不能因wrapper原子bundle丢失内层验收证据或把raw解析成测试结果。真实Docker门仍按原显式环境标记运行。

手工 committed 初始化回归使用真实 Git clean filter 隐藏本地正文变化，再暂存另一文件。请求冻结原 HEAD 及精确摘要；工作文件、当前 index、幂等和派发门禁保持。

隔离 Git/SQLite 准入用例核 `llm-manager` 路由进程仅收宿主配置路径和允许的 CLI 厂商，无继承环境。实际选择持久进入 operation 与工具描述。重复请求不重新选路，正式 retryOf 可以沿同输入和政策选另一个就绪 CLI，非 CLI 路由拒绝准入。
