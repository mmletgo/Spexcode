---
title: 协调事务动作与恢复存储
status: active
hue: 175
desc: 用受限动作门禁原子协调接入、派发、fence、租约、应用和真实交付结算。
code:
  - spec-cli/src/sync/store.ts
---
# 协调事务动作与恢复存储

## raw source

重复事件、过期 Agent 和并发写入不能重复交付或覆盖新输入，进程中断必须从真实副作用及持久记录恢复。

## expanded spec

共享身份属于 [[sync-operation-types]]。admitAndEnqueue 将冻结 operation、稳定派发计划与现有 protocol 的 sync.dispatch.v1 control envelope 原子写入，注册唯一 coordinator 地址；消息不是普通 Agent 文本。稳定接入 payload 包含输入内容与物理身份、policy/impact/readSet 摘要，capture 时间不参与；同键不同 payload 拒绝。claimAttempt 独立保存 attempt 与 sessionCreateKey（不超过128字符），在同一事务领取所有实际 path/规则写集合及可选 exact FIFO dequeue。dequeue 后仍由未完 attempt 恢复。

额外的受控用户请求通过 requestBlob 单独持久绑定，接入前验存在和内容摘要，并纳入 payload 去重与 pinnedBlobRefs。同一实际来源快照上的不同用户编辑不能误归并为同一次操作。没有额外请求的历史操作及自动文件事件保留原摘要语义；请求正文仅在 evidence blob 中，不改来源快照或复制入数据库正文。

bindComposedInput 同时核对 operation.requestBlob 与 composed.requestBlob 的内容寻址身份，存在或缺失都必须一致；错误请求、漏叠加请求或把请求附到自动文件操作不能取得生成输入绑定。请求证据读取和 hash 核验在 SQL 事务外完成。

所有结果动作核对 operation/attempt/generation/物理来源/全部资源 lease。范围冲突按实际 paths 与 contractIds/flowIds 检查；独立范围可并行；释放后每资源 generation 不归零。superseded 或过期 fence 拒绝新候选、验证和 beginApply。native 会话创建、Git、blob/文件读取均在事务外，checkpoint 保存 executor runId 对应的内容寻址记录，不另建执行数据库。

P3冻结恢复只允许未来业务ID扩展；P4已审P1可同时登记真实精确新paths。高层输入尚无未来业务 ID 时，expandContractScope(fence, {contractIds, flowIds}, evidenceRef) 在结构校验及独立评审已通过的内部可信细化结果上登记完整单调 ID 集合。先核证据 blob 的真实 SHA256，再在同一 protocol 事务核当前 run/fence，以既有 path/rule 资源键原子取得新增 ID 租约，并扩展 operation.scope 与可供分区的 readyScope。参数不得含 paths 或其它字段，原业务 ID 不可删除；input/payload/路径授权、generation、预算/截止时间和派发消息不改。冲突整体回滚并保留旧租约；每资源 generation 仍递增且释放不重置。operation 保存可选 contractScopeExpansions 证据记录，精确 ref+集合幂等，同 ref 不同集合拒绝；重复不会派发或计费。retry 通过已有 expanded scope 领取租约，幂等重放仍核当前 fence 与真实持有资源。

细化后 startGeneration 的 ready/blocked 是业务分区：共享文件 paths 保持在 readyScope，blockedScope 可仅含 GAP 依赖的 contractIds/flowIds，不机械阻塞整个共享文件。ready 与 blocked 的同类业务 ID 不得重叠；现有路径重叠门禁保持。候选、四层验证和 receipt 的覆盖范围均受 ready 范围约束，未 ready 业务 ID 不能进入 deliveredScope；blockedReason 未消除时，部分 receipt 只能保持 needs_input/conflicted，不能宣称 workspace_synced。

另一细化证据扩展完整 ID 集合时，只把 operation.scope 尚未登记的新 ID 加入 readyScope；已有 blocked ID 不因重新登记/取得租约自动变为 ready，blockedScope 原样保留，完整业务分区由后续 startGeneration 决定。

freezeCandidate 核对实际 diff blob 的文件范围，recordVerification 绑定输入与候选及真实 coveredScope。beginApply 核对控制、fence、完整目标物理身份与复核快照、共同 baseline、候选/验证/真实 target→candidate manifest diff，先提交 journal 才允许文件副作用。effectKey 同 payload 幂等，不同 payload 拒绝。recordApplyStep 保存写入单元进度，recordReceipt 保存真实 tree/commit/交付快照证据；没有实际副作用的回调不能成为 Git 完成证明。

settleApply 原子保存 receipt、journal 结算、sourceInput+verifiedDelivery 成对 baseline 和真实 deliveredScope。部分交付只推进 coveredScope；根仍 needs_input/conflicted。源及交付物理身份不同的外部输入基线不得套到发布交付树后续编辑，交付树另建自己的 source=delivery 成对基线。pause/cancel 在 applying 只记请求并进入等待边界状态，写入单元完成登记结算后停；取消保留实际 receipt，不等于回滚。未结算副作用、过期 attempt 与未派发操作通过 listRecoverable 查询；pinnedBlobRefs 保护冻结输入、候选、证据、checkpoint 与基线引用。

reserveDispatch 在每次原生调用前按key原子预留 callsUsed/maxCalls 与截止时间，bindSession 按已保存 plan 更新不可替换的原生身份。bindDelivery 绑定预先持久 deliveryPlan 的真实仓库/路径/分支；bindComposedInput 保存组合输入且保留原始source identity。冻结候选核对 composed→candidate 的实际模型差量；beginApply 按完整manifest重建 currentTarget→candidate 差量，允许包含原始用户输入，不把source先无journal写入交付树。四层验证 blob 的范围与外层引用一致，所有证据内容摘要在事务外核对。

被取消、暂停或superseded的旧pending envelope可由discardDispatch精确FIFO消费；仅允许控制已停止或终态的operation，不能丢弃仍需attempt的有效输入。恢复不重置预算，retry核maxAttempts/maxRepairs/截止时间；recordBudgetExhaustion仅在真实预算已耗尽时写入budget_exhausted，applying则维持recovery_required。迟到native身份绑定不能将已applying attempt降回running而开放租约抢占。候选覆盖可大于模型diff，外部人类输入路径仍纳入真实应用和验证范围。

receipt 的实际tree与交付manifest必须精确绑定已冻结候选，错误清单不能进入共同基线，即使其他receipt引用形式正确。

协作回写中source与delivery是同一物理树时，仍保留原source→实际delivery历史pair，并建立发布快照sourceInput=verifiedDelivery的后续来源pair；后续人类输入以真实发布字节为基线，不把上一轮Agent输出重新当人类来源差量。

仅供P3冻结历史恢复的readBaseline最新成对baseline由SQLite事务插入顺序（rowid）确定，不以可回拨的settledAtMs排序；结算时间仅用于展示。时间回拨后重新打开数据库，source和发布delivery仍读取最近一次成功结算的pair，不能退回旧输入。

planResource在原生命令前核当前fence及固定input/candidate身份，按attempt+key幂等登记资源计划；同键不同载荷拒绝。recordResourceCheckpoint核资源自己的operation/attempt/input/candidate绑定及expectedCheckpointRef CAS，即使attempt过期、superseded或operation取消仍可保存真实资源证据；任何phase更新都不恢复业务写权。阶段只能逐步planned→created→terminal→removed，相同blob/阶段幂等重放，迟到planned不能覆盖terminal/removed。开始前取消且未实际创建，也明确terminal后removed；仅removed释放资源容量。listRecoverableResources独立查询所有历史attempt的未removed资源，终态取消op与非current attempt不能被遗漏。pinnedBlobRefs包含资源plan与所有checkpoint引用。

findResource(attemptId,key)按精确身份查询包括removed的资源，供同一run重入复用已持久checkpoint；不能只扫描未removed集合，否则完成后重试会再次创建真实资源。同阶段更新也需CAS，精确阶段与blob历史重放返回当前记录，不覆写较新的thread/turn或terminal结果。

listOperations(repositoryId, {limit?, sourceRoot?}) 在 SQL 内按仓库及可选精确来源根筛选，并按 rowid DESC 返回最新接入操作，包含运行中及终态。默认 limit=100，只接受整数1..500；读取仍校验组件版本，不以壁钟决定顺序，也不读全库后过滤。

listJournals(operationId)先核operation存在，再按rowid顺序读取该操作全部journal及已结算receipt；终态交付事实不从恢复列表推断。

findOperationByIngressKey(ingressKey)按精确主键或持久alias查询operation，不存在返回null。应用重放原operation冻结baseline，必须自行核仓库/物理来源、input/request/policy绑定；不能用latest baseline改变已接入payload。

applying期间pause在真实receipt结算后进入paused；随后requestControl(run)仅在当前attempt已settled且同op/attempt存在已settled journal及receipt时恢复原交付结论（blockedReason优先，完整deliveredScope为workspace_synced，否则needs_input），不回queued、不重派发/交付或重置budget/generation。未结算副作用仍按原journal恢复，cancelled不复活；恢复既有结论不替代应用对新source的检查。

planBlob在admit边界核真实bytes SHA256且ref.sha256=policyDigest；引用参与新接入payload去重并被pinnedBlobRefs直接保护，包括queued阶段。历史无plan操作不改变原摘要，不自动绑定另份计划。

listAttempts(operationId)先核operation存在，再按rowid返回该操作全部真实attempt，供从既有checkpoint恢复固定细化证据；不能由另一operation借用候选/义务。

nextDispatch()只读现有protocol的精确FIFO头，返回operation/messageId/envelope，包含已停止或终态头；校typed kind、envelope及持久operation/message/input绑定。claimAttempt携expectedMessageId时，在同一个领取事务精确消费已controlled/terminal的旧sync.dispatch头，再校当前头并dequeue；有效queued头绝不可跳过，任一步失败使旧头消费及attempt/全部lease一起回滚。P3冻结恢复可沿此入口；新P4应用使用ackDispatch与claimQueuedAttempt两阶段调度，不按最新operation列表猜顺序。

paused且尚无attempt的头已被合法消费后resume，claim可依据同op精确owned已dequeued message和持久operation恢复，不再次dequeue或改动别人的有效pending顺序；不造第二队列。应用先FIFO派发，再恢复无pending的unfinished operation；显式resume可直接恢复该持久身份。

已dequeued身份恢复仍须等待所有有效pending FIFO头完成：可精确消费已停止头，有任何有效pending则SYNC_DISPATCH_WAITING整体回滚并不创建attempt。仅queue没有有效头时恢复无pending操作，不能因旧消息已消费越过新的有效调度。

接入payload纳入origin，primary/alias重放必须同origin且精确命中已存在new或旧legacy摘要；不重写既有operation摘要。sameInput归并仅相同origin，不能用Spec旧结果隐式执行code/initial等另一来源。派发地址按repositoryId稳定摘要分区，nextDispatch(repositoryId)读取该真实地址头，同仓库多worktree仍严格FIFO，跨仓库不互堵。

readRetryEligibility(id)只读返回{eligible,reason?:{code,message}}真实事实，admit复用同事务门禁。仅failed/budget_exhausted或从未receipt的cancelled；旧operation所有历史resource必须removed、journals全部settled、无liveattempt/lease。retryOf绑定旧source物理身份、input、requestBlob、policy/readset/impact、scope、baseline与origin；完整复用未落地用户请求，只允许新显式ingress/rootCause、交付私有plan和执行budget/deadline。新operation记录retryOf，同retry ingress/payload重放幂等；原失败及原预算记录不改，不用自动事件重开。

预算耗尽的未消费dispatch已无自动执行资格，作为stopped头由同事务精确消费，避免显式新retry在旧budget头之后永远阻塞；不将可修复failed阶段机械归为终态。

v6原semantic_digest仍保留真实inputId/完整物理source、origin、精确requestBlob、policyDigest、授权paths与retryOf；v7使用normalized_semantic_digest按受控请求语义归并。两者均排除per-ingress交付allocation、预算和可推进baseline派生impact/readSet，使同source的已交付细化不成为新输入或自动补预算。同ingress严格核完整payload；新alias指向既有operation，有精确收据时重放沿本ingress原delivery/budget/baseline，没有收据的旧alias维持owner operation的原重放规则。历史重复记录不删并，按rowid DESC选择已有记录，不改旧payload/消息/native/journal。

受控请求的普通去重按已核不可变请求去除 origin.requestId 后的语义摘要进行，保留 kind/nodeId/intent、原 input/source、path、before/next 与 requestTree。相同编辑仅换请求来源归原 operation/预算；不同编辑或意图不归并。每个新 ingress 保存精确 payload 摘要及恢复接入所需小引用收据，alias 重放按自己的原接入核验，operation 的原 requestBlob/payload 不改，所有 alias 请求引用保活。旧 v6 请求按当前仓库、物理来源、input、政策和授权范围惰性核验；缺证据明确拒接，不猜同意图或建立新预算。

P3业务decision请求沿同一接入门禁归一化去transport requestId、findingIds次序，精确payload收据仍核同key全内容。新裁决保原analysis历史并supersede旧运行写权；旧fence/resume不能覆盖新意图。compositionEvidenceBlob直接核hash并保活。

真实verification包含的retiredIds和decisionRefs只在receipt结算事务累积进共同BaselinePair；未验证/未应用候选不推进历史。settle先在事务外读取并核verification blob，事务内复核同ref。published delivery基线继承相同退役及裁决引用，后续无关代码变化不退回原已裁决规则。

裁决语义由实际来源/input、原operation/analysis、所选finding集合及choice/新规则决定；运输requestId、绑定该运输ref的派生policy和已结算历史fact不新建预算。精确ingress仍校完整payload；同choice结算后重放仍返回旧operation，真实来源/配置字节变化和显式retry保持独立身份。旧v8裁决索引在接入前从不可变request核验并重算，不重写业务记录。

P4 裁决的 selection/readSet 是新操作执行时的完整 CAS 绑定，不改变人的同一选择身份；即使后续真实 receipt 推进该资源头，同一原分析/finding/choice 的新运输仍复用原操作、预算和回执，不能再次执行旧选择覆盖后来结果。新 ingress 保其实际选择快照；同 key 变 payload 仍拒绝。自动观察继续按精确 selection 区分新语义，不能套用此裁决归并。


recordReviewedConflict仅在当前analyzing fence内登记已由协调器完整核验并持久保存的当前独审业务冲突原因，精确重放幂等；phase、scope、预算、失败与交付事实不变。readDecisionEligibility与decision admission事务复用同一真实资格：保既有needs_input/conflicted/superseded入口，failed/budget_exhausted另需非null业务blockedReason（needs_input或conflicted）；当前attempt须settled/failed/superseded，所有历史资源removed且journal全settled。早期原因不授权在途阶段、applying/recovering或未结算资源；事务重新读取parent实际状态防应用检查后发生竞态。

P4 精确资源 frontier 独立保存路径字节头与 contract/flow 作者意图头。readBaselineSelection 对每个请求资源返回显式 null 或精确 pair；历史不可证明时返回失败。settleApply 同事务推进实际 journal.files 路径、真实 verified covered IDs 与 retired tombstone heads；未交付 ID、读目录不推进。beginApply 只复核冻结选择对应资源，独立资源交付不使任务过期。物理 pause 由 scope/revision CAS 持久门禁，claim/checkFence/beginApply 事务复核，已登记 applying finishing 可以结算。ackDispatch 只消费真实协议头并保存 durable queued 与首入 anchor；claimQueuedAttempt 不 dequeue，按原 enqueue_seq 检查重叠前序与锁，独立范围可推进。自动观察的同范围最新输入建立不可变 successor，继承 anchor、预算族及截止时间，运行输入不改；所有族成员的 attempts/calls/repair failures 汇总。所有观察与接入、协议 enqueue、ingress 结算同事务，Git/FS/blob 核验在事务外。

新P4 lease路径分别绑定完整来源身份和交付计划仓库/根/分支命名空间；业务ID绑定完整来源身份。共享真实交付分支的同路径互斥，独立树/分支不因同名资源互锁。P3未命名旧租约保守阻塞相同资源直到恢复移除。selection摘要同时绑定attempt及verification外层/blob；scope扩展同事务补显式binding并更新attempt选择，旧已组合摘要不能取得generation授权。预算根只保存dispatchAnchor.budgetRootOperationId这一事实，按全族真实attempt的dispatchPlans累加calls。

selection保存完整精确语义read/protection与write资源；assertSelection重读全部binding并至少含实际operation.scope，允许readonly extras。scope、ready/blocked/delivered只计实际意图/write资源，readonly不取得write lease。expand保原全部readonly binding，union已审新ID/path，任何缺证明的旧资源不能推定null。

P4原自动语义摘要包括冻结selection；仅逐binding完全相同、或变成该operation自身已settled receipt头才可兼容归并自身已审扩展scope回声。新外来相关byte/intent/read头不能仅凭sameInput/policy吞掉；不同头的新语义重新准入，仍受自动预算族约束。观察的自动去重在同事务以完整source identity、configRef、latestDifferenceDigest和实际selectionDigest命中已有已准入观测；即使全输入/HEAD因无关字节改变，也保存当前真实snapshot与alias payload收据，复用原op/预算而不改其input。仅observed、blocked/failure及显式request/retry不取得此快捷授权。

bindComposedInput可带readSetDigest绑定：只有已审scope扩展真实改变selection、仍analyzing/elaborating/repairing且无candidate/verification，才允许从旧composed重组到新digest并原子更新readSet。扩展ledger保存前后摘要。相同selection二次换composed/readSet、生成后换或没有真实扩展均拒绝，输入/policy/原payload不改。新增非null author意图的重新独审由协调器证明，存储不解析业务。

readLatestObservation/listObservations按事务插入顺序提供当前完整来源观测及失败信息，不按可回拨壁钟排序。listBaselineResources只列真实heads及明确legacy未知条目，不造新头。recordObserverHealth以expectedInstanceId CAS保存当前物理scope进程实例健康；旧实例不能覆盖新实例。缺失来源用health记录，不伪造snapshot。readBudgetUsage从全族真实attempt及dispatchPlans派生calls/attempts/repair统计，显示不得以新op局部callsUsed假充剩余预算。

物理run仅对同scope、原control仍run、实际settled attempt+journal+receipt的paused操作恢复已交付结论，保blockedReason和真实完整度；不新claim、不重应用或重置预算。所有历史原生resources必须removed、journals必须settled才允许新P4 claim/continuation；callback仍可登记真实清理并在removed后释放终结attempt租约。

P4 receipt结算从冻结selection各真实pair以及legacy previous保留已有retiredIds/decisionRefs历史，再追加本次真实verification。history refs不扩展coveredScope；heads仍只推进实际journal.files、verified covered IDs和本次已验证retired ID。后续同ID非decision交付不能让其新intent head遗失之前已结算裁决。

bindPublicationBase 消费 [[sync-publication-base]] 实际对象证明，只在 generating 且无 candidate/verification、fence/原 selected 资源仍有效时绑定一次；事务外核 Git/manifest/read closure，事务内核同来源完整 path frontier CAS，原 composed 保留。readPublicationHeads 单事务返回已结算 receipt 支持的 path heads，无关 legacy 未知单列诊断。freezeCandidate 的模型 manifest diff 与 baseTree 改核冻结 publication composed；beginApply 同时绑定 publication ref 和真实 parent，不改变本轮 scope/头推进规则。

自动预算继承只适用于 observeAndAdmit 携 P4 selection 的新不可变观察（非 retry），同来源同 scope 的未完成前序含 failed/budget_exhausted 均保持原 FIFO anchor、预算族和 deadline。显式 admitAndEnqueue 新输入是新预算授权，P3 缺 selection 不继承 P4 自动族；同意图精确去重仍复用原 operation，旧未 removed resources/未 settled journals 仍阻止新执行。

同来源持久 publication gate 复用 attempts/resources/journals，不建第二锁表。其它 attempt 已有 publicationBase 且仍运行，或其仍有未 removed resource/未 settled journal（即使 attempt failed/superseded/settled）时，bind/尚未应用的恢复/new beginApply 返回 SYNC_PUBLICATION_BUSY。没有 publicationBase 的独立生成资源不参加该 gate。bind 同 base 重入也复核完整 frozen frontier；assertPublicationBaseCurrent 是只读恢复门禁，事务外核 provenance hash、事务内核当前 attempt/selection/全 path heads，旧 image 不能因重入跳过 CAS。实际 applying/settled 沿原 journal/receipt，不重新选择 heads 或修改 parent。

sync.history 请求采用固定输入、目标真实交付及完整成组差量；规范语义身份仅排除运输 requestId，相同补偿换运输键不重开预算。精确接入收据与原 requestBlob 继续保留每个运输请求，schema generation 使旧 writer 拒绝未知成组授权。

精确 restore 只在完整验证与 receipt 结算后发布该 ID 的新有效 intent head；verification 的 restoredIds 必须精确对应本操作冻结 restore 授权。successor pair 的当前 retiredIds 释放这些已证明恢复的 ID，既有 immutable retirement pair 不修改。旧 path pair 的累计集合不覆盖该 ID 的较新 intent head。此 writer 语义通过 schema generation fence 隔离旧 writer，不新增表。
