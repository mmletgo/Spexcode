---
title: 同步共享应用入口
status: active
hue: 175
desc: HTTP 与 CLI 共用持久协调服务，受控正文差量不先提交，实际交付与原树状态分开查询。
code:
  - spec-cli/src/sync/application.ts
---
# 同步共享应用入口

## raw source

启用、保存 Spec、显式执行、查询、暂停、恢复和取消必须进入同一真实协调操作。失败或新输入到来后能查询具体结果，不由界面推断完成。

## expanded spec

本节点落实 [[sync-product-controls]] 的 P2 应用入口与 P3 手动代码意图/裁决；P4 外部 watcher由本服务实现，完整恢复矩阵与P5最终验收由上层保留。生产 configuredSyncApplication 复用后端同仓库的 canonical session protocol，按已注册 source 工作树实例化，不创建其它数据库或队列，迁移先备份。运行资料及固定 compiled CLI 位于源码外当前用户拥有的独占 0700 runtime。

enable 读取 [[sync-application-settings]]，可用预期配置摘要检查并发变化；只原子保存本机授权记录，不改版本化配置。配置或 source 物理身份改变拒旧授权；重新启用是本阶段的授权入口。启用展示输入身份、交付根、授权范围、预算及 Spec/initial/code/combined、Docker Node test 能力，后台外部监听由正式service lifecycle启动。

readSettings.activation 区分 disabled、enabled 与 invalidated：未有本机启用记录是 disabled；记录存在且当前身份/配置摘要一致是 enabled；已启用后配置删除、坏格式、越界授权、身份或摘要失配是 invalidated，并保留具体 configurationError。enabled:false 不等于用户关闭同步，invalidated 正文保存必须拒绝，不能降级为普通 Spec 独立提交。

submit 接收 nodeId、稳定 requestId、spec/initial/code/combined 来源与可选 SpecBodyEdit。来源真实参与持久操作和幂等身份；initial 沿同一 Spec 业务管线，不能把同键改来源当重放。受控编辑先 capture 真 source，从冻结节点解析路径，在准备函数读正文前检查 symlink；prepareControlledRequest 独立冻结请求，不改原文件、index 或 HEAD。相同字节 no-op 不入队；同请求键和相同内容返回原操作，不同内容拒绝。[[sync-application-planning]] 构造 plan；固定 compiled runtime 与内容寻址计划在 admit 前保存，随后唯一 coordinator 实际细化、生成、验证和交付。V4 重新读当前相关输入与可信配置；固定计划与当前配置摘要必须一致，不能因重新enable而让旧请求沿用新政策。正常 typed failure 持久结算，后端持有运行 Promise 并显式诊断无法结算的故障，不丢 rejection；P4停机自动补偿由正式观察器执行。

status 按节点及 bounded limit 查询，detail 返回 operation、当前 attempt、完整 journal 和 settled receipt；证据按 hash 校验读取。旧P3以完整source input ID判断过期，P4使用协调器精确闭包判据；workspace_synced 只表明实际受管交付，原树待落地单独展示。GAP/冲突与验证失败保留各自 phase/failure。pause/cancel 使用 store 控制及 AbortSignal，写入中由 coordinator 结算真实副作用；resume 先检查当前输入和授权，过期要求最新请求，不先改变旧控制。

同 ingress 的准备及受理复用 file-mutex bounded 串接，并发相同请求只建立同一操作和固定 runtime，不重置预算。planBlob 由 coordinator 用 syncPlanDigest 的唯一规范化 bytes 冻结和 pin，应用直接按 op.planBlob 校验读取；旧操作无固定引用时明确不可猜测恢复。detail.executionAvailability 从实际固定计划、描述和 runtime manifest 推导恢复诊断，queued 也不能隐藏资料缺失。工具描述有 ownedruntime 副本；丢失索引时，只能校验同一原 runtime manifest/digest 后恢复。已有 attempt、verification 或 journal 且原描述不能恢复时，禁止以当前升级工具重冻结或沿用旧证据；仅未派发 queued 操作可重新准备并完整运行。resume 先等旧 abort 执行结算，再恢复 run 控制，避免旧结束回调覆盖恢复。

派发使用 canonical protocol 中按 repositoryId 固定的真实地址，同仓库多个 source 工作树共享 FIFO，不同仓库共享 session DB 时互不堵塞。入口只唤醒当前仓库有效消息头，精确清理已停止的旧消息；同仓库来源由对应应用实例执行，禁止跨仓库 fallback。busy 返回真实 queued 状态，不自旋重试。前序结算后继续读取真实 FIFO；消息已耗尽时，从 canonical store 的 queued/run 状态恢复已出队暂停操作，不创建第二队列、不重置预算。wait 等待当前仓库实际运行中的前序和目标任务，外部互斥仍占用时诚实返回 queued 详情，不把它标为完成。

显式 retryOf 由用户授权为同一冻结输入、节点、政策、来源和正文请求建立关联的新 operation 及新预算；省略 patch 继承原 requestBlob，省略 origin 继承原输入来源与裁决（若是原decision），沿旧 previousBaselinePair，不丢失未落地编辑。不能混入新 patch 或改节点、来源/政策，当前 source 已变应提交正常新输入。普通重复事件继续归并原 operation 及预算，同 retry requestId 精确幂等。detail.retryEligibility 复用 store 只读 phase、所有历史 resource/journal/live authority 门禁，并附当前输入/授权及固定 plan 诊断；只有 failed、budget_exhausted，以及从未交付的 cancelled 可重试，GAP、冲突、active 或未知资源禁止借新预算重启。准入事务重新检查门禁，不以先前只读结果代替原子检查。

detail.resources 只列该操作尚未 removed 的真实历史资源；暂停、取消、失败/预算、待输入/冲突或完成状态若仍有此类资源或未 settled journal，executionAvailability 显示 recovery_required 与 sync_resources_unsettled，不能因工具描述可读就显示 ready。该投影不虚构资源已释放；retryEligibility 仍由 canonical 门禁拒绝，精确资源恢复由 coordinator 负责，恢复入口单独验收，不能因尚未恢复就允许重试。

control(recover) 是独立于 resume/retry 的清理入口：保原 control、输入、预算和业务结果，不要求重新启用当前已经变化的配置；先等旧执行结算，再用原固定计划和工具调用 coordinator.recoveryOnly。它只核已有 native/verification 资源与已经开始的 journal，不创建 attempt、模型调用、验证或新 apply，也不自动唤醒其它 queued 任务。资料缺失或资源仍未知时保留具体恢复诊断，不假称释放；清理后另由明确 resume/retry 推进。conflicted 状态也必须按真实未结算资源投影 recovery_required。

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

P4 的正式服务生命周期持有 [[sync-input-observer]]，不依赖浏览器/SSE。enable 继续绑定明确 config 摘要与完整 source 身份；服务启动仅恢复已有 enable 记录，不通过发现新目录或分支授予权限。HTTP/CLI automatic pause/resume 按 repositoryId/canonicalRoot/physicalFingerprint 的物理控制管理，跨branch暂停保留；operation pause/cancel/recover保持独立语义。暂停仍采集不可变 snapshot 和逐资源差异，恢复先扫描最新输入再开放准入，旧候选不能继续覆盖新输入。自动接入在事务外对同一个snapshot构造plan、exactbaseline selection及作者差量，在store同一事务绑定control revision/selection/input；planning失败也记录真实观测，不假造完成。配置/branch身份变化使观察诊断可见，不自动重新enable。status.observation返回实际服务健康、物理控制、latestsnapshot/差异及registeredNodes，offline不能由旧记录冒充online。服务关停回收自身watcher和timer，并在安全边界结算已开始执行。

注册意图由版本化nodeIds限定，父/子重复登记只扫描一次最外明确意图；其实际子树/影响闭包由既有node与图派生。省略nodeIds仅注册真实治理授权源码/测试的意图，纯raw新功能需明确意图根。status.observation.coverage列included/excluded/total，未知或未授权节点不产生虚假已覆盖结果。

健康持久记录绑定instanceId/真实PID/startToken，查询重新验证进程身份；旧online字段不能证明服务活着。热重载通过instance CAS接管，旧观察器准入前重核所有权。status.sources列明确enable的物理来源、注册意图、存在性、控制、最近观测及持久健康；缺失来源启动仍保观察职责，周期重试。删除重建改变物理身份先报需重新授权，未授权新物理树不创建快照。最后差异正文保存在同一内容寻址evidence；commonDir被删除/移动导致证据不可读时返回明确unavailable/hash/reason，仍可查询missing健康和最后已捕获snapshot身份。

派发先ack真实protocol消息成为durablequeued，再使用store.nextQueued资格与原anchor FIFO；已开始的安全checkpoint仅按原anchor恢复，失败/预算/冲突不能自动重开。coordinator未领取前的明确unsupported不能触发递归自旋。fresh manual与自动输入统一exactselection规划；P4previousBaselinePair为空，逐资源真实pair不被latest伪拼。旧P3显式retry只沿原冻结pair/plan，P4retry沿原selection。

重新enable与新配置只保当前注册意图，不把旧branch/config下的root继续扫描。已注册意图根删除后保留missingNodeIds与真实planning failure，不能因当前nodes缺失清掉责任；上下文祖先单列contextNodeIds，不把只读上下文冒充完整业务范围已同步。

P4 stale/retry/resume采用协调器唯一isSyncInputCurrent判据，比较真实source身份与读取/写入闭包的working/index/HEAD对象；无关路径或提交不使精确操作过期。retry和裁决仍绑定原完整input及原selection，不能借新snapshot套用旧analysis；当前分析查询复用协调器阶段校验，已审null资源扩展不得隐藏可信分析。相同request重放沿其原接入收据，scope外编辑不重新冻结旧请求。sourceSynced仍仅由实际canonical交付阶段与原树接收事实决定，不能由闭包current推定。

每个operation detail单独投影其原physical scope的physicalControl；show不依赖另读status即可看见物理暂停，operation.control和phase仍保真实单操作控制与检查点，不伪造阶段。

重复补偿仅在同不可变snapshot、完整真实baseline资源/heads摘要与配置政策均相同时复用锁外规划/差异；不是仅按input ID跳过。真实heads或输入变化重新规划。此前同difference已admitted/coalesced/duplicate的观察只继续记录真实snapshot，避免重复冻结runtime阻塞异步验证；paused-only observation不挡resume首次准入，store仍执行最终准入CAS。

P4运行时重建固定计划与裁决raw也使用原operation.input/selection；live snapshot仅用于enable与协调器相关输入复核，scope外全snapshot变化不能使受控裁决请求被误读为旧analysis绑定失败。

观察差异组合与正式准入同用executionScope.paths作为执行字节、plan.readPaths作为真实只读上下文，不能把全部selection绑定当可写路径。自动changed同时保真正选中意图的artifact/residualPaths：byte head已推进但意图尚未消费的代码变化仍须准入，不能因base/source文件相同压掉。

新输入的三次exact规划沿同一原始heads选择传递discoverySelection；它仅作已治理发现元数据，不是基线或写入授权。同request重放、retry、decide及V4保留原冻结plan与政策，不用latest broad heads重建；同request更换已授权子节点仍拒绝。P1扩展后的显式retry沿原operation最终selection、execution scope与impact摘要重组readset，原planBlob/policy不变；重复retry请求仍沿该接入最初范围，不借后续扩展改原请求。

交付只推进实际files的bytehead；Spec、源码或测试未实际改写但所含ID/治理artifact已消费时，不能仅因路径bytehead显式null制造回声；合法空生成差量也适用。观察器复用逐intent owner与code/test artifact关联，仅在相关当前/退役intent非空、全部已消费且artifact无残差，各真实intent pair.sourceInput中该路径的oid、mode及存在性均与当前原始snapshot一致时消除该假差异；raw-only编辑、无ID高层原意、新增/退役ID、owner迁移或删除仍保变化，不按inputID猜测已处理。
