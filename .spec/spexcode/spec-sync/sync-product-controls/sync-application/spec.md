---
title: 同步共享应用入口
status: active
hue: 175
desc: HTTP 与 CLI 共用持久协调服务，受控正文差量不先提交，实际交付与原树状态分开查询。
code:
  - spec-cli/src/sync/application.ts
related:
  - spec-cli/src/sync/historical-workflow.test-helpers.ts
---
# 同步共享应用入口

## raw source

启用、保存 Spec、显式执行、查询、暂停、恢复和取消必须进入同一真实协调操作。失败或新输入到来后能查询具体结果，不由界面推断完成。

已验证交付通过同一服务采纳到原工作树，资格和执行沿同一后端判据，不由界面复制安全判断。

## expanded spec

正式 configuredSyncApplication 与 configuredSyncResourceRecoveryApplication 共用 [[verification-transport]] 的可信 server 装配。可由 server 的 SPEX_VERIFICATION_SSH_ALIAS 与 SPEX_VERIFICATION_SSH_ROOT 选择既有 SSH 配置和远端独占 root，必须成对提供；缺席保持本地。alias/host 权限和认证不进入候选 Spec、项目 sync settings 或模型请求，凭据沿 SSH 原生机制，不能因当前配置改变而重绑定旧 v1/v2 resource。此装配不增加 P0/readiness 阶段或第二业务状态机。

server可选SPEX_VERIFICATION_SSH_DOCKER_ENDPOINT只接受本机Unix socket，缺省unix:///var/run/docker.sock，按原plan冻结并显式传每次Docker CLI，不使用远端默认context猜执行主机。

显式offline source-continuity见 [[sync-source-registration]]，不创建缓存owner、observer、attempt或模型调用。enable与登记在commonDir共享注册锁内写启用记录，v2后续配置/实际分支授权保留continuity链；identity不永久绑定旧业务配置。普通assertSource核完整repo/root/commonDir/gitDir/branch/physical，不能因共享repo投影而给未证明旧linked source继续权。资源-only专用factory及coordinator的raw Git元数据核验不受失效v2自锁，且不进入normal恢复或准入。

新操作默认冻结plan.agentWorkflow=native-worktree-v1与sync-tools-v3:{model,agentWorkflow,tools,runtimeDigest}。读取运行资料同时核请求选择及workflow，拒绝新旧协议热替换；旧v1/v2及缺字段plan按原frozen协议恢复/retry，旧已持久payload不改写。新业务裁决/revert为新操作，使用新工作流。新workflow使用Claude Code或ZCode；未显式指定且项目未配置模型时固定请求选择claude:default，交由CLI原生配置解析，不把默认或别名当成精确实际模型。模型、base URL和CLI版本无产品允许名册，实际每轮身份由[[claude-structured-runtime]]、[[zcode-structured-runtime]]记录。历史缺省sol身份不改变，不能把裸sol静默换执行器。v24组件writer marker保护新原生配置语义，固定v3运行描述仍核其请求选择。

本节点落实 [[sync-product-controls]] 的 P2 应用入口与 P3 手动代码意图/裁决；P4 外部 watcher由本服务实现，完整恢复矩阵与P5最终验收由上层保留。生产 configuredSyncApplication 复用后端同仓库的 canonical session protocol，按已注册 source 工作树实例化，不创建其它数据库或队列，迁移先备份。运行资料及固定 compiled CLI 位于源码外当前用户拥有的独占 0700 runtime。

enable 从已提交 HEAD 读取 [[sync-application-settings]]，可用预期配置摘要检查并发变化；只原子保存本机授权记录，不改版本化配置。配置或 source 物理身份改变拒旧授权；重新启用是本阶段的授权入口。启用展示输入身份、交付根、授权范围、预算及 Spec/initial/code/combined、Docker Node test 能力，后台外部监听由正式service lifecycle启动。

readSettings.activation 区分 disabled、enabled 与 invalidated：未有本机启用记录是 disabled；记录存在且当前身份/配置摘要一致是 enabled；已启用后配置删除、坏格式、越界授权、身份或摘要失配是 invalidated，并保留具体 configurationError。enabled:false 不等于用户关闭同步，invalidated 正文保存必须拒绝，不能降级为普通 Spec 独立提交。

submit 接收 nodeId、稳定 requestId、spec/initial/code/combined 来源与可选 SpecBodyEdit。来源真实参与持久操作和幂等身份；initial 沿同一 Spec 业务管线，不能把同键改来源当重放。受控编辑先 capture 真 source，从冻结节点解析路径，在准备函数读正文前检查 symlink；prepareControlledRequest 独立冻结请求，不改原文件、index 或 HEAD。相同字节 no-op 不入队；同请求键和相同内容返回原操作，不同内容拒绝。[[sync-application-planning]] 构造 plan；固定 compiled runtime 与内容寻址计划在 admit 前保存，随后唯一 coordinator 实际细化、生成、验证和交付。V4 重新读当前相关输入与可信配置；固定计划与当前配置摘要必须一致，不能因重新enable而让旧请求沿用新政策。正常 typed failure 持久结算，后端持有运行 Promise 并显式诊断无法结算的故障，不丢 rejection；P4停机自动补偿由正式观察器执行。

status 按节点及 bounded limit 查询，detail 返回 operation、当前 attempt、完整 journal 和 settled receipt；证据按 hash 校验读取。旧P3以完整source input ID判断过期，P4使用协调器精确闭包判据；workspace_synced 只表明实际受管交付，原树待落地单独展示。GAP/冲突与验证失败保留各自 phase/failure。pause/cancel 使用 store 控制及 AbortSignal，写入中由 coordinator 结算真实副作用；resume 先检查当前输入和授权，过期要求最新请求，不先改变旧控制。

同 ingress 的准备及受理复用 file-mutex bounded 串接，并发相同请求只建立同一操作和固定 runtime，不重置预算。planBlob 由 coordinator 用 syncPlanDigest 的唯一规范化 bytes 冻结和 pin，应用直接按 op.planBlob 校验读取；旧操作无固定引用时明确不可猜测恢复。detail.executionAvailability 从实际固定计划、描述和 runtime manifest 推导恢复诊断，queued 也不能隐藏资料缺失。工具描述有 ownedruntime 副本；丢失索引时，只能校验同一原 runtime manifest/digest 后恢复。已有 attempt、verification 或 journal 且原描述不能恢复时，禁止以当前升级工具重冻结或沿用旧证据；仅未派发 queued 操作可重新准备并完整运行。resume 先等旧 abort 执行结算，再恢复 run 控制，避免旧结束回调覆盖恢复。

状态及详情查询对固定 runtime 仍逐项完整读取并核摘要，遍历期间有界让出事件循环，让实际执行器的子进程完成、取消及期限回调及时推进；不缓存或跳过检查，不把未完成检查显示成 ready。派发/恢复/采纳继续在原执行入口重新进行完整校验，不改变创建、调用或操作的既有预算与期限。

派发使用 canonical protocol 中按 repositoryId 固定的真实地址，同仓库多个 source 工作树共享 FIFO，不同仓库共享 session DB 时互不堵塞。入口只唤醒当前仓库有效消息头，精确清理已停止的旧消息；同仓库来源由对应应用实例执行，禁止跨仓库 fallback。busy 返回真实 queued 状态，不自旋重试。前序结算后继续读取真实 FIFO；消息已耗尽时，从 canonical store 的 queued/run 状态恢复已出队暂停操作，不创建第二队列、不重置预算。wait 等待当前仓库实际运行中的前序和目标任务，外部互斥仍占用时诚实返回 queued 详情，不把它标为完成。

显式 retryOf 由用户授权为同一冻结输入、节点、政策、来源和正文请求建立关联的新 operation 及新预算；省略 patch 继承原 requestBlob，省略 origin 继承原输入来源与裁决（若是原decision），沿旧 previousBaselinePair，不丢失未落地编辑。不能混入新 patch 或改节点、来源/政策，当前 source 已变应提交正常新输入。普通重复事件继续归并原 operation 及预算，同 retry requestId 精确幂等。detail.retryEligibility 复用 store 只读 phase、所有历史 resource/journal/live authority 门禁，并附当前输入/授权及固定 plan 诊断；failed、budget_exhausted、从未交付的 cancelled，以及下述经完整证明仍未采纳的 settled 私有交付可正式重试；GAP、冲突、active 或未知资源禁止借新预算重启。准入事务重新检查门禁，不以先前只读结果代替原子检查。

同一正式retry入口保留[[sync-coordinator]]的已冻结完整候选续验资格：原六阶段已审而V3前置unsupported且所有原资源/写权结算时，同输入/原意/模型及完整政策/读集/scope冷验后零新模型调用进入新的验证与交付。相同requestId仍精确重放；改变输入应发起新操作，候选/旧证据失配明确失败而不从P0静默重做。已交付未采纳的重验仍沿其原重建政策。

detail.resources 只列该操作尚未 removed 的真实历史资源；暂停、取消、失败/预算、待输入/冲突或完成状态若仍有此类资源或未 settled journal，executionAvailability 显示 recovery_required 与 sync_resources_unsettled，不能因工具描述可读就显示 ready。该投影不虚构资源已释放；retryEligibility 仍由 canonical 门禁拒绝，精确资源恢复由 coordinator 负责，恢复入口单独验收，不能因尚未恢复就允许重试。

control(recover) 是独立于 resume/retry 的清理入口：保原 control、输入、预算和业务结果，不要求重新启用当前已经变化的配置；先等旧执行结算，再用原固定计划和工具调用 coordinator.recoveryOnly。它只核已有 native/verification 资源与已经开始的 journal，不创建 attempt、模型调用、验证或新 apply，也不自动唤醒其它 queued 任务。资料缺失或资源仍未知时保留具体恢复诊断，不假称释放；清理后另由明确 resume/retry 推进。conflicted 状态也必须按真实未结算资源投影 recovery_required。

stopWriter/stopService停止普通writer后，正式recover仍可运行同一recoveryOnly清理；stopped仅拒普通派发，不阻止取得原清理执行结果。此入口不重新启动observer/FIFO、不恢复physicalControl或operation control、不增加calls/attempts或重置预算/deadline；原failure和checkpoint refs保持。无资源的queued恢复也不派发，错误计划或未知资源继续返回既有恢复诊断且不得标记removed。

recover 等待本次协调清理结果：具体 failure 以原 code/message 的 409 返回，仍未知且无更细 failure 时返回 sync_resources_unsettled。不能仅打印服务器日志；查询详情仍从实际资源/journal保留恢复诊断，不写虚构业务失败或改原冲突结果。

普通受控保存仅换 requestId 仍归同 operation/原预算；精确 alias 接入收据保其请求来源，B 归 A 后 B 重放沿 B 原接入的派生值和 requestBlob 核验，业务执行仍使用 A 冻结证据。改变同 key 正文或用户意图明确拒绝，同语义重复不重置预算；显式新输入的新manual requestId或合法retryOf授权新预算，自动未完成后继继续继承原预算。


本节点同时覆盖 P3 手动 code/combined 接入与业务裁决，外部watcher由P4后台观察器执行。submit/readSettings公开 spec、initial、code、combined 入口；origin本身不构成采用新行为的业务授权。计划使用最近已结算共同基线；retry沿旧input/request/基线/原意，不能把重试当业务裁决。

decide 只接受原needs_input/conflicted（或有明确blockedReason）的可信当前analysis checkpoint。wrapper与analysis必须绑定原operation/attempt/input/policy/readSet及baseline，reviewPassed为真，所选finding IDs真实存在。拒绝stale input、匿名/伪分析、空规则、重复finding IDs、同requestId不同payload。无正文变化的keep_intent仍建有效请求。原controlled patch通过可信originalRequestBlob继承；用户不能自指定原请求引用。新origin=decision操作保rootCause链，旧操作可superseded并撤写权，历史原意和analysis仍可查。

adopt_behavior/new_rule由用户选择冻结新facts与intent raw，保留旧raw并注明具体被采用行为/用户规则；keep_intent不改变用户raw。固定计划及运行前复核使用同一确定性裁决装饰，不能运行中重新编政策。相同裁决请求受入口mutex保护，至多建立一个操作；CLI、HTTP和Dashboard使用同一准入/错误码。detail.decisionContext提供共同基线、具体规则路径、原意、双方行为、反例及待决事实。

业务裁决的事实来源与raw引用使用controlledDecisionIdentity稳定业务摘要（原operation/input/analysis、排序finding IDs与choice/精确rule），不含运输UUID；同选择换requestId或finding顺序不重开操作/预算，同key不同payload仍拒绝。raw明确只替代所选ruleIds的旧行为，未选规则及全部验证政策保持有效。部分独立分支已结算时，P3新裁决采用真实最新共同基线；P4保原已审selection与analysis输入绑定，并按实际扩展ledger验证后推进；运行复核始终使用该操作冻结基线，不在运行中改政策。

裁决计划同时冻结结构化decisionAuthorities：stableDecisionId/requestRef/原operation/input/analysis、所选finding IDs及其ruleIds/affectedIds/paths、用户choice/rule。范围仅由可信旧分析的选中finding派生，调用者不能另交规则或路径授权；自然语言facts/raw说明不作为扩大范围的授权。运行复核按同request重建该结构，未选规则不能借同decision source修改。

同一原输入的部分规则已交付后，剩余裁决的raw从该新操作冻结的最新共同基线、真实作者差量和原受控正文请求合成后追加选择；此前已接受的规则、未选义务及尚未交付的正文编辑必须保留。运行和显式retry使用同一冻结基线重建，不能从历史分析attempt正文覆盖已结算意图。

同行但编辑区间互不重叠时仍自动保留作者与交付字节。真正文本重叠的暂选作者正文只作为分析输入，应用不得将其固定为target.rawSource覆盖后续完整受审resolution；冻结plan仍保原请求、裁决和结构化范围。协调器仅从绑定当前输入与政策的已独审整合结果派生正文，再用renderControlledDecisionRaw程序追加原用户选择，未选规则仍受旧图门禁。


早期blockedReason只显示当前已审业务原因，不授活动attempt裁决权。decide保既有needs_input/conflicted/superseded资格，failed/budget_exhausted须非null业务reason（needs_input或conflicted）；通过store同一只读资格检查，当前attempt已结算、资源全removed及journal全settled后才新建immutable裁决操作，admission事务再次复核。current source/input/可信analysis检查点/具体finding与固定runtime护栏保持；P1非法或执行失败不使已审分析失效，也不宣称P1通过。


detail始终提供required decisionEligibility查询投影，直接读取store同一资格判定，供UI/CLI与decide/admission共用阶段、attempt及资源结算事实；它不替代current input、analysis/finding、固定runtime与stale护栏，不是新的持久或模型协议事实。partial ready生成失败或预算耗尽后，原needs_input业务原因继续保留事实裁决入口；活动P1/生成/写入仍不能由early reason取得裁决权。

P4 的正式服务生命周期持有 [[sync-input-observer]]，不依赖浏览器/SSE。enable 继续绑定明确 config 摘要与完整 source 身份；服务启动仅恢复已有 enable 记录，不通过发现新目录或分支授予权限。HTTP/CLI automatic pause/resume 按 repositoryId/canonicalRoot/physicalFingerprint 的物理控制管理，跨branch暂停保留；operation pause/cancel/recover保持独立语义。暂停仍采集已提交 HEAD 的不可变 snapshot 和逐资源差异，恢复先扫描最新输入再开放准入，旧候选不能继续覆盖新输入。自动接入在事务外对同一个snapshot构造plan、exactbaseline selection及作者差量，在store同一事务绑定control revision/selection/input；planning失败也记录真实观测，不假造完成。配置/branch身份变化使观察诊断可见，不自动重新enable。status.observation返回实际服务健康、物理控制、latestsnapshot/差异及registeredNodes，offline不能由旧记录冒充online。服务关停回收自身watcher和timer，并在安全边界结算已开始执行。

注册意图由版本化nodeIds限定，父/子重复登记只扫描一次最外明确意图；其实际子树/影响闭包由既有node与图派生。省略nodeIds仅注册真实治理授权源码/测试的意图，纯raw新功能需明确意图根。status.observation.coverage列included/excluded/total，未知或未授权节点不产生虚假已覆盖结果。

注册、授权检查和覆盖投影共同采用 [[sync-frozen-contracts]] 的业务 Spec 路径判定，`.plugins` 实例配置不成为业务意图或完整业务覆盖分母；显式登记该类节点仍按不存在的业务意图拒绝。插件继续显示于完整项目图，不因此取得业务同步写权。

健康持久记录绑定instanceId/真实PID/startToken，查询重新验证进程身份；旧online字段不能证明服务活着。热重载通过instance CAS接管，旧观察器准入前重核所有权。status.sources列明确enable的物理来源、注册意图、存在性、控制、最近观测及持久健康；缺失来源启动仍保观察职责，周期重试。删除重建改变物理身份先报需重新授权，未授权新物理树不创建快照。最后差异正文保存在同一内容寻址evidence；commonDir被删除/移动导致证据不可读时返回明确unavailable/hash/reason，仍可查询missing健康和最后已捕获snapshot身份。

派发先ack真实protocol消息成为durablequeued，再使用store.nextQueued资格与原anchor FIFO；已开始的安全checkpoint仅按原anchor恢复，失败/预算/冲突不能自动重开。coordinator未领取前的明确unsupported不能触发递归自旋。fresh manual与自动输入统一exactselection规划；P4previousBaselinePair为空，逐资源真实pair不被latest伪拼。旧P3显式retry只沿原冻结pair/plan，P4retry沿原业务selection；完整未采纳重验另冻结仅由父自身receipt推进的当前selection用于CAS。

重新enable与新配置只保当前注册意图，不把旧branch/config下的root继续扫描。已注册意图根删除后保留missingNodeIds与真实planning failure，不能因当前nodes缺失清掉责任；上下文祖先单列contextNodeIds，不把只读上下文冒充完整业务范围已同步。

P4 stale/retry/resume采用协调器唯一isSyncInputCurrent判据，比较真实source身份与读取/写入闭包的working/index/HEAD对象；无关路径或提交不使精确操作过期。retry仍绑定原完整input及原业务selection，完整未采纳重验的执行CAS另用认证的当前selection；裁决保原完整input/plan/analysis，仅对原最终selection相同资源重读真实heads以纳入已结算partial交付，不能借新snapshot套用旧analysis；当前分析查询复用协调器阶段校验，已审null资源扩展不得隐藏可信分析。相同request重放沿其原接入收据，scope外编辑不重新冻结旧请求。sourceSynced 由真实 settled receipt 提交被原树采纳及当前闭包字节决定，canonicalSynced 另核明确主分支；不能仅由闭包 current 推定。

每个operation detail单独投影其原physical scope的physicalControl；show不依赖另读status即可看见物理暂停，operation.control和phase仍保真实单操作控制与检查点，不伪造阶段。

重复补偿仅在同不可变snapshot、完整真实baseline资源/heads摘要与配置政策均相同时复用锁外规划/差异；不是仅按input ID跳过。真实heads或输入变化重新规划。此前同difference已admitted/coalesced/duplicate的观察只继续记录真实snapshot，避免重复冻结runtime阻塞异步验证；paused-only observation不挡resume首次准入，store仍执行最终准入CAS。

P4运行时重建固定计划与裁决raw也使用原operation.input/selection；live snapshot仅用于enable与协调器相关输入复核，scope外全snapshot变化不能使受控裁决请求被误读为旧analysis绑定失败。

观察差异组合与正式准入同用executionScope.paths作为执行字节、plan.readPaths作为真实只读上下文，不能把全部selection绑定当可写路径。自动changed同时保真正选中意图的artifact/residualPaths：byte head已推进但意图尚未消费的代码变化仍须准入，不能因base/source文件相同压掉。

新输入的三次exact规划沿同一原始heads选择传递discoverySelection；它仅作已治理发现元数据，不是基线或写入授权。同request重放、retry、decide及V4保留原冻结plan与政策，不用latest broad heads重建；同request更换已授权子节点仍拒绝。P1扩展后的显式retry沿原operation最终selection、execution scope与impact摘要重组readset，原planBlob/policy不变；重复retry请求仍沿该接入最初范围，不借后续扩展改原请求。

交付只推进实际files的bytehead；Spec、源码或测试未实际改写但所含ID/治理artifact已消费时，不能仅因路径bytehead显式null或仍指旧非null pair制造回声；合法空生成差量也适用。观察器复用逐intent owner与code/test artifact关联，仅在相关当前/退役intent非空、全部已消费且artifact无残差，各真实intent pair.sourceInput中该路径的oid、mode及存在性均与当前原始snapshot一致时消除该假差异；artifact基准遵循 [[sync-input-composition]] 的真实采纳与消费证明。raw-only编辑、无ID高层原意、新增/退役ID、owner迁移或删除仍保变化，不按inputID猜测已处理。

partial真实receipt推进ready资源heads后，fresh decision须以相同资源的新exact selection准入，并保原已审scope/impact及尚未消费作者raw；不能沿过期selection再领新操作，也不能以latest broad重规划或把其他资源放进授权。相同具体选择的运输alias不因执行selection推进而成为新选择，归并由store controlledDecisionIdentity门禁负责。明确P3历史操作继续用其原固定plan与真实legacy pair恢复，不能将legacy pair伪装为P4heads。

revert 接受 operationId 与稳定 requestId，意图节点从原固定计划派生。仅真实完整 settled 交付、原生资源已结算且 actualCommit 已被当前来源 HEAD 采纳才可撤销；当前相关后续编辑通过 Git 反向三方合成保留。完整补偿路径逐项核当前可信写授权及独立测试边界，精确 before/next 身份删除才能产生既有 user:raw 退役授权。补偿沿 combined 来源建立新的不可变协调操作，真实冲突经同一分析/裁决，成功经同一四层验证与新提交交付；不 reset、不直接改原树。相同请求精确重放，相同补偿不同运输键归并。

stopWriter 在版本回退前先持久暂停当前物理来源，停止相同来源本进程执行者和观察服务，等待已开始执行在安全边界结算；剩余 journal/resource 作为可恢复记录与具体诊断返回，不删除表、worktree 或 blob。诊断与停止执行者共用当前数据库、canonicalRoot 和 repositoryId 范围；同路径另一仓库身份的历史操作和资源原样保留，不读取为当前来源详情，当前身份的真实未结算资源仍须完整返回。物理暂停跨服务重启保留，未知新版 schema 继续由 store 每事务 fencing 拒旧 writer。

detail 的原来源采纳与主分支完成由 [[sync-landing-status]] 只读推导。sourceSynced 表示真实原树包含已验证完整交付且当前执行/读取闭包字节一致；canonicalSynced 还要求当前分支是仓库明确 mainBranch。已采纳后快照身份变化不单独制造 stale，无关提交允许保当前证据；相关工作文件、index、HEAD、配置或只读上下文变化仍过期。返回 operation 的 canonical 阶段是当前 Git 事实投影，不写虚构持久完成状态。

adopt(operationId) 依 [[sync-source-adoption]] 采纳实际 settled receipt.actualCommit。detail 必须返回 adoptionEligibility（eligible:true，或包含 code/message 的明确拒因）；执行复用相同判据，锁内再次核来源、启用配置/节点授权和完整交付证据。只有干净原树且 HEAD 可快进到交付时执行普通 hooks 的 fast-forward；重复已采纳请求返回真实当前详情，不另建请求键或业务完成记录。损坏交付证据保留 recovery_required 诊断及拒因，不让状态读取因 receipt 绑定异常失去可查询性。

历史节点路径恢复仅额外接受原完整 settled receipt 的实际 files 中、被本次 Git 反向三方触及的精确 .spec/.../spec.md 路径；当前原冻结意图仍须通过已注册 node 授权。它不扩大源代码、测试目录、配置或整个 .spec 目录的权限。目标 raw 取本次真实请求中同一节点的正文，删除时保留原历史 raw 供退役验证；节点迁移沿既有生命周期检查保持节点及业务 ID。

revert 将精确历史恢复 Spec 作为可信目标，保原节点/业务 ID 与原路径；restore 授权只能由原 settled receipt 和固定 history 请求派生。原 retired ledger 保留，新完整交付推进该身份当前有效 head，后续普通操作继续使用该 head。

正式 run/verify 可传 model；新原生工作树操作未选择时使用项目配置或claude:default，历史工作流仍默认sol。同 requestId 省略选择及显式 retry 省略选择均继承已持久请求选择；改同 requestId 选择拒绝，普通重复换选择不获新预算。旧非默认frozen操作保存sync-tools-v2/model，新原生操作保存sync-tools-v3；运行描述与operation的请求选择精确一致。v1及缺模型旧operation保原sol/payload/证据，恢复不能换模型。完整合同属于[[sync-model-selection]]。

已存在或备份固定运行描述先核精确期望模型，再允许admission。未受理请求留下的原描述若与后续选择不符，明确早拒，不新建operation/receipt/FIFO且不静默重建；匹配原描述的合法显式retry或新请求仍沿既有入口。

新手动 run/verify operation 可显式选择模型以覆盖项目默认；省略模型时，同 request 的 prior 或显式 retry 的原选择优先于当前版本化配置 `sync.model`，无 prior/retry 才使用项目值或该计划的工作流默认值。自动观察、decide 与 revert 新operation采用相同判据；admission、固定运行描述与真实runner request保相同请求选择，本轮实际模型由CLI证据另行绑定。同request改选择拒绝，普通重复不能用配置变化重置预算；授权/configDigest/currentness门禁保持。

新操作选择 `llm-manager` 时，在 [[sync-model-selection]] 规定的宿主选路成功后固定具体原生 CLI 模型。自动观察在确实准入时才选路。同 requestId 的重放直接使用原操作已固定的模型。

Dashboard 的受控正文保存继续直接 submit，requestBlob 即时触发 spec→code，不等待 Git 提交。外部编辑器的 Spec/代码保存、原子替换与 git add 均不启动自动模型；自动观察只接受已提交 HEAD tree，首次显式 enable 可从既有 committed HEAD 发起 initial，同期未提交或未暂存的新编辑不混入。enable 仅授权已提交配置及意图，不从未提交内容建立初始输入。

首次无已证明自动接入快照时以 initial 纳管当前已提交树；旧无 captureKind 的操作不能被猜作 committed 前态。后续自动输入依据该节点最近已消费的真实 commit 快照到当前输入的 tree 差量区分 spec/code/combined；停机多次提交仍按累计已提交差量分类，paused 中尚未处理的新作者变化只观察而不消费边界。相关路径取当前计划与该节点最近消费记录的精确path绑定并集，已删除路径不能仅因当前树不再列出它而失去方向；不扩大到全局源码根或无关owner。v2 plan 的 commitTrigger 冻结该 before 快照（首次 initial 为 null）及真实累计 paths，after 仍为 operation.input。它是作者提交前态而非已验证交付，不替代 receipt/baseline，也不按 HEAD^ 猜测或只保存可能被 GC 的 OID。仅提交无关路径或空提交不启动模型。code 冻结 code_to_spec、combined 冻结 combined；initial 有已提交授权实现时冻结 code_to_spec，否则与 Spec 保存相同冻结 spec_to_code。沿同一 plan/selection 规划，不复制执行器或分区政策。

自动 ingress 固定到提交快照与节点，同一 commit 重放不因 baseline 或差异证据推进而重新派发；已结算 receipt/baseline 继续按真实意图消费和采纳证明消除同步自身交付/采纳提交的回声，不按 Git author 或 session trailer 猜测作者。停机提交在 service 启动及周期补偿中继续发现。新 commit 沿既有作用域、物理控制和预算族门禁，不新增触发配置开关。

混合资源heads中的旧只读context不改原差异判据。仅从当前exact selection的非null pair定位其实际receipt/journal，核原source、启用配置与节点授权、全部settled journal、四层证据、实际完整scope及Git commit/tree/parent/effect，且当前HEAD/tree精确等于该完整receipt时，观察器才可沿原baseline消费接缝消除自身写回。最近已消费frontier到真实receipt parent只允许空差量，或唯一同mode普通配置文件的有效完整项目JSON变化。parent/current配置原字节摘要与mode须等于receipt原input，且当前已重新授权。完整交付已按该input冻结的配置及验证政策通过全部门禁，配置字段不另设可消费名册。未被该完整receipt逐字绑定的配置、code、业务Spec、只读docs或混合差量保原观察。外部同tree新commit不冒认receipt，同一已接入快照的重复记录仍复用既有前沿，不伪结算原外部操作。此证明复用[[sync-source-adoption]]的纯settledReceipt与[[sync-landing-status]]读取，不调用adopt写入准入、不要求物理run或无在途资源。paused观察仍健康且不派发，仅写既有observation消费证据，不新建或改写receipt、baseline、journal与业务完成状态。

自动 operation 的 detail 当前性、retry、decide、resume 与运行前可信配置复核均按其 input.captureKind 采集同模式当前输入；旧无标记工作区操作保持原判据。status 的原树落地投影与 adoptionEligibility/adopt 仍读取真实工作文件及 index，未提交编辑不能因 commit snapshot 而获得覆盖或采纳资格。

最近已消费提交边界由既有持久 observations 和自动 operation.input 推导：真实 admitted/coalesced/duplicate 接入，或 observationChanges 已判断 changed=false 且 exact selection 含真实非 null 基线的提交快照，均可作为下一次 before。后者仅在既有差异 evidence 写 consumption=baseline，保同一 selection/receipt 证明；旧 evidence 无字段不猜已消费，暂停且 changed=true 的新作者提交不标记。消费查询保留完整历史，不受状态列表的500条展示上限影响；普通重复观察不能挤掉消费点。当前已消费的同一commit也可作为before，真实tree差量为空时不能因captureKind、计划摘要或重新观察而退回旧initial、取代待交付的受控正文请求。同步生成 Spec 的 receipt 被正式采纳并去回声后，该完整已提交快照仍推进消费边界，后续 code-only commit 的 origin 与 commitTrigger.paths 不夹带先前已消费的生成 Spec。服务重启及停机补偿复用同一持久事实，不新建可变游标、DB 表或作者启发式。真正的新提交、文件新增/删除/mode变化与未消费意图仍沿原差量门禁，观察故障或仅暂停的新输入不能消费边界。


用户通过正式decide明确选择保持原意、采用行为或新规则时，受控原意与所选代码分歧共同进入v2 combined新操作；仍只沿原作用域、真实authority、预算、独审及不可改oracle。原code提交操作保持code_to_spec只读，不把自动提交事件本身当作写代码授权。

可信配置可显式选择unlimited总预算；新operation保存null期限，自动前驱原样继承，重复事件和暂停恢复不改预算。接入互斥继续有限等待，单次Native默认120000ms或冻结配置的有限正数；不因总预算无限恢复普通stopped派发或跳过资源结算。

resources-only是独立于control(recover)的显式清理入口：要求完整operation ID与原frozen input ID，仅准当前canonicalRoot/commonDir与历史来源相同的owned资源。它不放松read/resume/adopt的完整assertSource，不赋予身份连续性；结果只返回资源结算与pending journal摘要，不调用readOperation/detail再采集来源。专用factory不注册或复用服务owner、不启动watcher/queue、不读当前业务配置或固定交付工具，也不唤醒其它任务。资源清理成功不重签attempt.failure、accept/review、原输出/digest或预算；旧journal不回放、不新建receipt。

正式detail/read-current与证据BFS使用同一typed checkpoint边界。raw只在强失败来源绑定后以明确untrusted_final/text/SHA投影返回，BFS不解析或追踪raw正文伪sha字段；普通JSON证据仍按原可达链读取，未知坏JSON显式失败。

证据BFS复用[[sync-checkpoint-evidence]]的精确BlobRef形状，保留裸引用、带artifacts的checkpoint及其中真实引用；内联日志字节包的sha256只是原运输校验摘要，不成为CAS可达边，也不阻断后续真实JSON证据读取。查询这种未引用摘要仍返回无关证据，真正可达CAS缺失或损坏继续显式失败。

旧untrusted_final缺ref时，原文sha256仅为诊断摘要，不建立CAS可达边；正式readEvidence仍可读其原JSON材料，查询该缺席raw引用返回无关证据404，不补写旧记录。

正式 retryOf 也允许完整 settled 但明确未采纳的私有交付：先认证全部 receipt/候选/验证/原输入与当前来源仍干净且冻结 HEAD 不变，再在准入事务绑定父记录与全部 journal。只允许父自身 receipt 导致的相同资源 heads 推进。新操作保持原 input/request/plan/scope/原预算，省略模型保持原请求选择，显式换 requested model 仍沿既有 retry 规则且不限制 CLI 版本/baseURL/模型配置；旧操作及其 receipt 不改写；原业务 selection 由 retryOf 派生用于分析，当前 selection 只作新操作 CAS。已采纳、部分交付、未知证据、来源漂移或第三方 heads 推进拒绝。

resources-only 对未发布且确证从未启动的 owned Native 候选允许显式保留式终止：通过原创建拥有权、物理登记、冻结 fork、未发布与无 generation/owner 门后，v2 preserved receipt 明确 cleanupComplete:false，原场地、分支、index、初始化锁及 prepared receipt 原样保留。正式 terminal→removed 只结算执行容量，不表示场地已删除、交付已合入/采纳或保留责任消失；同键不再创建，后续清理必须识别并继续保留该场地。未知身份、已发布或 Native 停止未证仍 recovery_required；普通 recover 的未知内容删除保护不变。此入口不新建业务操作、不修改原 pause/calls/attempt/failure、不启动模型、会话、watcher 或 queue。

手工 initial 请求可显式 committed，从实际 HEAD tree 冻结输入。Git 清理过滤掩盖的本地字节和暂存改动均不混入。该选项仅适用无受控正文、无 retryOf 的新初始化。同 requestId 只能复用原工作区或提交输入类型。普通手工接入及正式 retryOf 保持原来源语义。
