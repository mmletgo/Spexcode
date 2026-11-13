---
title: 协调存储 SQLite 回归证据
status: active
hue: 175
desc: 针对真实 SQLite 多 handle、重启、迁移和应用结算门禁的回归测试。
code:
  - spec-cli/src/sync/store.test.ts
---
# 协调存储 SQLite 回归证据

## raw source

持久协调安全性必须由真实数据库事务和恢复测试证明，内存回调不代表真实 Git 已交付。

## expanded spec

writer49→50 复用隔离 SQLite 迁移回归，验证旧 writer 拒绝、事务失败回滚、原观察及旧表行保持和在线备份可恢复。具体历史资格与新收据行为由 [[sync-historical-coverage]] 验收。

观察存储回归以已结算 pair 建立同一 selection 的新旧两种记录，验证旧行原字节、GC引用、消费顺序、去重条件和前端覆盖保持。新记录只存业务覆盖投影及原摘要，完整 selection 继续由受权准入与收据使用。

writer48→49 使用同一 SQLite 迁移回归，额外保留旧内联格式的观察原行。升级后经正式观察读取等价投影，冷读不改旧行；旧 writer 拒绝升级库，备份保留旧观察的原字段。

writer47→48 复用真实 SQLite marker 回归：完整旧表行、schema、自动采纳索引与 v1–v47 registry 保持，模拟 marker 事务内失败后最高版本仍为 47。正常升级只做一次 online backup，重复升级幂等，旧 47 迁移集合对新库拒绝；备份可按原 47 集合恢复且与升级前逐值相同。不操作生产库或删除真实 marker。

writer46→47 使用隔离 SQLite 验证正常 online backup、仅追加程序语义 marker、旧 writer 写前拒绝与备份可由原迁移集合恢复。所有表行、完整 schema（含原自动采纳索引）和已有迁移字节保持；重复升级不重做备份。

自动采纳政策回归覆盖新字段的 payload/规范语义/alias 冻结、无效来源拒绝、正式 retry 保原值，以及有/无标记的旧操作在同提交重复观察中不升权、不丢权、不新增消息。候选查询使用真实 SQLite 的结算记录，核完整来源、当前 settled attempt、全部 settled journal、完整 scope、精确父 HEAD、noop 排除和确定顺序；超过 500 条无关历史不漏候选，执行计划须命中父 HEAD 及 journal 索引。此测试只证明存储查询，真实 Git 采纳由 [[sync-source-adoption]] 验收。

自动采纳索引迁移沿隔离库 online backup 核旧数据/registry 不变、索引与 marker 原子提交或整体回滚、旧 writer 拒绝及原备份可恢复。历史 marker 回归模拟旧 schema 时移除后续新增索引，并把这些索引的独立证明与旧 schema 不变断言分开。

提交观察抢先接入后，真实 SQLite 同时覆盖按基线选择兼容归并和按语义摘要归并。被替换、仅收件且零领取的显式初始化允许新交付计划入队，保留冻结输入、全量范围、原预算和截止时间。旧 ingress、同 payload、已领取及过期输入保持原去重，后续等价请求复用新操作。

writer34 至 writer44 升级到 writer45 的回归验证只追加无 DDL 的缺失 marker。备份可由各自原迁移集合读取，原 schema、操作、attempt 和已注册迁移字节保持。旧 writer 对升级后的库明确拒绝。

批量基线回归使用含引号、换行和 Unicode 的已结算路径及同一合约的真实 pair。加入 1,748 个缺席路径与重复键后，结果仍保留相同 pair、精确缺席及原排序，查询次数与小集合相同；同一事务每个真实 pair 及 settled receipt 只读一次并共享正文。精确选择与发布头摘要须等于原完整 canonical JSON。随后移除 settled 状态或破坏 pair 正文，下一事务必须明确拒绝，原件恢复后才再次通过。

writer34索引回归核v33→v34先一次online backup、只新增目标索引，全部业务/protocol表和v1–v33 registry原行保持；DDL失败时索引及marker整体回滚，旧v33 writer拒绝升级库，备份可按v33读取，重复启动不再备份。历史marker用例模拟旧schema时同时移除该新增索引，旧schema不变断言仅排除这个由v34独立验证的新增对象。完整commit观察以禁用索引的原SQL重算作对照，覆盖超过500条重复、来源/input/difference/outcome分组、failure/blocked及缺失captureKind/outcome、显式null failure、新写和重开；执行计划使用表达式索引、无历史JSON函数及临时GROUP BY，不用固定耗时阈值替代结构证明。

writer33回归在隔离SQLite保存旧V4 protocol且尚无dispatch，核32→33只追加SELECT1、恰一次online backup；完整旧schema/业务与protocol表及V1–V32 registry原行保持。旧32迁移集合在新库拒绝且不写数据，32备份可由旧writer读取，重复启动幂等。不触用户或生产数据库。

writer32回归由隔离真实SQLite核v31→v32只追加marker、只备份一次，旧表/schema/旧registry原行保持，旧31 writer拒绝新库且备份可由31读取；不触用户库。

writer28回归在隔离真实SQLite中核v27到v28无DDL，只增加一条组件marker，保留完整v1–v27 registry与业务/protocol旧表。旧writer拒绝升级库，一致online backup可由旧writer读取，重复升级幂等。

writer27沿真实online backup验证旧v26一致库可独立恢复，升级无DDL且所有旧表与v1–v26完整registry行不变；旧v26 writer拒绝新代，重复迁移幂等，不触默认用户库。

v26 ZCode停止材料marker回归仅操作专用临时SQLite：25→26只追加SELECT1，完整保v1–v25 migration行/checksum/applied_at及全部业务/protocol旧表与schema，旧25 writer拒26，online backup可由25 writer读取且原行相等，重复迁移幂等。不得操作生产数据库或删除真实marker。

v25 P0 context marker回归使用专用临时SQLite：24→25仅追加SELECT1，逐行保全部业务/protocol表及v1–v24完整migration行和checksum/applied_at；旧24 writer拒绝升级库，online backup可由24 writer读取且原行一致，重复迁移幂等。不打开用户或生产数据库。

v24 cli-config-v1回归在专用临时SQLite保存已结算journal/receipt，23→24只追加SELECT1 marker。online backup前后比较全部旧业务/protocol表逐行原值与v1–v23完整migration行（含checksum/applied_at）；旧23 writer拒绝24库，升级前备份可由23 writer读取并保持全部旧行，重复迁移幂等。不得操作用户或真实同步库。

v23回归在隔离真实SQLite保存behavior-draft-protocol checkpoint且dispatch为空，明确复现未reserved崩溃窗口；正式online backup后22→23保持原operation/attempt/resource/ingress/journal/pair/lease行与v1–v22 checksum逐字不变，旧slice(0,22) writer被组件围栏拒绝，备份仍可由v22打开并保原数据，重入迁移幂等。仅验证专用私库，不访问用户或生产数据库。

v17语义marker的隔离真实SQLite迁移先online backup，逐字保留历史payload/receipt与v1–v16 checksum；旧v16组件writer拒绝升级后库，备份仍可按v16读取，不修改实际用户库。

ZCode v16 marker 回归保存真实 SQLite 中旧 operation/attempt/resource/ingress/journal/receipt/pair 的逐字节行，核 v1–v15 checksum 不变、升级前一致备份可由 v15 打开、旧 writer 在新库拒绝及重入迁移幂等；不以模拟 receipt 表示产品 Git 交付已通过。

受控用户请求回归证明：同一实际来源快照上的不同用户编辑语义不被错误归并，仅来源requestId不同则归并原预算；同键改变请求拒绝，原来源字节不改，请求证据被 GC pin 保留。真实 v2 数据库备份升级至 v3 后，无额外请求的旧事件仍命中相同 operation/payload，备份保留 v2 与原消息。

覆盖 [[sync-store]] 与 [[sync-migrations]] 的数据库边界：重复输入/capture时间回放只一operation一message；同key不同payload拒绝；claim与exact FIFO dequeue及所有租约同事务；共享path/规则冲突、独立范围并行、释放后generation不归零；独立原生dispatch预算及稳定创建键；过期fence、物理树重建失权；actual diff和V1至V4绑定门禁；取消前无journal、写入中待receipt结算、取消后保留receipt；receipt登记后重启幂等结算；partial保留needs_input；成对源/交付基线；GC pin；旧库online backup可恢复、失败DDL事务回滚、未知高版本拒写。

验证命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts`。测试模拟已复核的 tree/commit 引用，只证明数据库结算，不替代真实Git应用与产品全链路验收。

追加验证：交付intent先durable、物理target不可替换；人类输入与模型差量分别计算并共同journal；迟到native回调不降applying状态；窄验证范围不被外层扩大；partial同source再次接入保留blocked输入与原coveredScope；预算超时持久拒绝且不重置；旧派发安全消费后最新输入领取FIFO。

receipt树引用相同但manifest不同仍拒绝，journal保持未登记；相同已冻结manifest可结算。

协作source与delivery同物理身份发布后，readBaseline返回真实发布快照同值pair，原冻结source pair仍持久保留。

时钟回拨回归：input1在1000ms结算，input2于1100ms开始、回拨至900ms后成功结算；独立handle重开后source和delivery基线都对应input2的receipt，settledAtMs仍保留900ms展示值。

资源生命周期回归先复现取消后checkpoint被旧fence拒绝且恢复查询遗漏；新增typed资源路径证明取消后created/terminal/removed可持久且业务写权仍撤销。覆盖真实SQLite多handle同阶段CAS冲突、精确重放、错input/candidate/attempt拒绝、历史attempt资源查询、未创建终止仍需terminal→removed、removed精确查询防重复创建、资源证据GC pin。v1→v2保留已有active attempt和protocol消息，online backup独立恢复v1、v2 DDL中断回滚、重复启动及升级后资源重开查询。

细化范围回归使用真实 SQLite：初始 path scope 没有未来 ID，新增 REQ/AC/FLOW 后共享路径保持 ready、GAP 依赖 ID 单独 blocked，部分 receipt 与 baseline 只推进真实已验证 ID，根仍 needs_input。扩展参数夹带 paths、删除旧 ID、同证据不同集合、错误 hash、过期/旧 fence 或冻结候选后新扩展均拒绝。两个连接竞争新增 ID 时全部回滚，旧路径 lease/token/generation 不变；成功 ID 租约沿用 attempt token/期限，精确重放不增资源 generation/operation revision、不重复派发或计费。证据引用被 GC pin，数据库重启与 retry 保留 expanded scope 和证据。

大范围租约领取及幂等扩域通过真实 SQLite 返回行的资源键读取次数验证成员查找按集合大小线性增长，不用固定耗时阈值。全部已持有时原租约逐值保持；缺失或被另一持有人替换时旧 fence 拒绝且不写回；已过期的外部租约必须实际接管并递增 generation，不能仅因键存在而当作自己已持有。

两个独立进程同时操作同一 SQLite 文件争抢新业务 ID，只有一方扩展成功，另一方明确 lease conflict；数据库只登记一个 ID holder，双方原路径租约保持原 token。

操作列表覆盖仓库隔离、精确来源根、终态可见、rowid顺序与默认/显式分页边界，非法limit拒绝；不同更新时间不会改变接入顺序。

commit观察历史读取覆盖超过500条普通重复记录、同input/difference的admitted与observed同时保留、真实来源与captureKind隔离、失败/blocked排除及数据库重开后的rowid顺序；折叠重复行不改变原持久记录或消费语义。真实临时evidence缓存先复现裸字符串差异引用未pin而被gc删除，再验证重开后按pinnedBlobRefs执行真实gc仍可逐字读取消费blob，同时确实删除无引用blob。

journal精确查询证明未知operation拒绝、另一operation不可串读，终态已结算receipt仍可返回。

接入key精确查询同时覆盖主key和alias、不存在返回null；不要求扫描操作列表或用latest baseline重建旧payload。

先复现applying pause→settled receipt→resume错误queued，修复验证完整及部分receipt分别恢复workspace_synced/needs_input，当前attempt、generation、callsUsed、deadline、receipt不变。

计划引用回归证明queued直接GC pin、同键同计划幂等、policy/ref不匹配及错误bytes摘要拒绝；v3→v4备份可独立打开原v3库，旧无plan payload/队列不变，重复升级及新handle读取plan仍成立。

attempt查询仅返回精确operation、包含历史及终态attempt并按插入顺序排列；未知operation拒绝，不能扫描全库拼接修复证据。

先真实SQLite复现旧queued被supersede但FIFO残留阻新claim；修复证明controlled/terminal旧头及当前claim同tx消费。有效独立queued保持原FIFO，错误expectedMessageId导致全部回滚，readonly nextDispatch不改变queue且返回真实envelope/op绑定。

已消费paused身份resume时，另一有效pending仍在则等待并不创建attempt；pending被正常claim后才恢复已dequeued操作。执行最相关session-protocol adopter-seams回归验证tx.query只读与tx.dequeue原子边界。

真实部分 receipt 结算到 needs_input 后，新尝试只领取原 ready 范围；不同细化 evidence 扩展完整旧/新 ID 集合时，已有 blocked contract/flow ID 仍只在 blockedScope，新 ID 可进入 ready，不能因重新登记旧 ID 造成业务分区重叠。

v5真实SQLite证明同ingress不同origin拒、同input不同origin不归并、已有legacy摘要同origin可重放且不改原payload。两个仓库真实protocol地址独立，同仓库不同worktree有效头不可越过；v4旧global FIFO迁移保序且旧消息留审计，失败回滚并可重启。

先复现failed/budget相同input自动去重无法显式新run；真实SQLite验证retryOf新operation/新budget及链接，自动旧事件仍去重原op，同retry ingress幂等，跨身份/request/policy拒，历史非removed资源/未知journal/liveauthority拒。cancelled无receipt可重开，有真实receipt拒；v5→v6 backup可恢复、旧writer拒写。

真实受控请求覆盖同 patch 不同 requestId 归原操作/预算、alias 精确重放及同 key 改 payload 拒绝；不同 patch/用户意图分离，显式 retry 继承原 requestBlob 才建立新预算。真实 v6 库重开惰性归一化保持旧 payload、记录和队列，缺当前来源证据拒接，已移除其它仓库不被读取。v6→v7备份可恢复、失败事务回滚、重启及旧 writer 拒写。

P3覆盖retiredIds在receipt前不推进、结算及重启/published pair累积，v7→v8在线backup及旧writer拒写，immutable decision相同选择换requestId/finding顺序复用原预算，同key新choice冲突、新真实choice撤旧fence而完整历史保留；旧superseded resume不重新授权。

裁决同choice跨requestId/finding顺序/运输ref派生policy及真实receipt结算后的历史facts复用原operation与预算；旧v8索引核验重算，同key新choice拒绝，v8→v9先备份且旧writer拒写。


当前fence的独审冲突原因与执行状态分开持久，错误generation/物理来源/旧fence拒绝，失败、预算及独立handle重开保原因且不改原证据。decision admission事务测试活动analyzing、applying、未removed资源及资格读取后新attempt竞态均拒；缺事实needs_input不因本次conflict修复被收窄。


partial startGeneration登记needs_input后，生成environment失败及后续预算耗尽分别保原业务reason与失败证据，结清attempt/资源后eligibility和实际decision admission通过；仍在generating时同请求被拒。不以数据库伪造状态证明该路径。

P4 针对性回归覆盖精确资源 frontier、物理暂停跨分支/重启、FIFO 收件与领取分离、暂停重叠前序和独立范围、不可变 successor 原位置与预算族、事务 CAS 与旧基线恢复；迁移覆盖在线备份、失败回滚、未知 writer 拒绝及原会话读取。

P4新增定向矩阵使用真实SQLite句柄/事务、online backup及真实Git分支快照：共享byteB与intentA残差、explicit null vs legacy未知、readonly共享并行与read CAS、self future echo与foreign新语义、same selected差异+无关dirty不重开失败、ack提交前rollback/后reopen、原位置successor、全预算族统计、物理pause apply安全结算、旧P3 applying迁移恢复、P1新path/ID选择扩展及readset重组、health实例CAS和失败观测保活。存储文件与adopter-seams为定向套件，不运行完整测试集；完整业务author/raw归属与真实产品Agent闭环由协调/组合/应用验收证明。

补充fail→pass：外repo/branch同名FLOW污染本source退休kind的迁移反例，旧kind缺证明应始终legacy unknown；同source真实前驱正例仍得到准确flow tombstone。P4后续同ID新intent head保selection中的裁决/退役历史，未覆盖历史ID的head/coverage保持不动。

自动预算回归通过真实 observeAndAdmit 验证不可变 successor 继承 FIFO/全族预算/截止时间，包括失败后的新 byte；显式新输入和 P3 无 selection 获独立预算族，旧未 removed 原生资源仍阻止新 claim，清理后才可使用新预算。

P4 裁决复现已结算选择后，另一真实 SQLite journal/receipt 推进相同资源头，同一选择因 selection 变化错误新建操作的失败。修复后运输 alias 与独立 handle 重开均保原 operation/calls/deadline/receipt，保存新 ingress 的实际 selection，同 key 换 choice 拒绝。测试的 Git tree/四层证据明确模拟，只证明事务归并，不冒称产品 Docker 或原生模型执行。

模拟旧版迁移库时移除目标旧代之后全部 marker，不能留下新增 writer marker 形成不存在的 schema gap；旧 writer 拒绝断言从当前迁移注册推导最高代数。

历史恢复结算仅接受与冻结计划逐项相同的 restoredIds；未获固定历史授权的验证元数据不能发布新资源头或解除退休状态。新 pair 的当前退休集合按真实恢复身份推进，原不可变退休审计保持；新版 writer 语义 marker 必须拒绝旧 writer 和未知未来版本写入。

固定模型用例先复现旧实现忽略模型，再验证同键冲突、普通重复换模型拒绝、显式retry可换且旧sol记录不改写；预算与原业务绑定保持，遵循 [[sync-model-selection]]。

v12→v13真实SQLite marker升级逐字比较operation、attempt、ingress receipt、journal/receipt及baseline表，核一致备份保原generation且旧migration数组拒读新generation；模型缺字段旧记录保持sol语义，无DDL与payload改写。

v13→v14提交快照/分区语义marker回归逐字比较旧operation、attempt、resource、ingress、journal与baseline记录；旧输入不添加captureKind、不改payload，升级前online backup保v13供停writer后的正式回退，旧13代writer必须拒绝14代。

unlimited回归以真实SQLite越过70calls、10attempts/repair及旧90分钟阈值仍记真实用量；四种旧有限cap逐项保持拒绝，maxRepairs=0不改义。自动前驱跨有限新配置仍继承原unlimited及显式null，物理pause/resume、防回声、cancel与过期/旧fence继续生效。v15升级先online backup，v1–v14 checksum及旧operation/payload/receipt逐字保持，旧writer拒绝且原备份可恢复。

v21迁移以隔离真实SQLite和online backup证明v1–v20 checksum及旧flat raw refs原字节不改，旧v20 writer被组件门拒绝，回滚备份仍可按v20读取。新wrapper一个checkpoint动作保留全部JSON/raw保活refs；材料缺失时不发布部分引用，旧ref不补role。

v22 writer marker用隔离真实SQLite与online backup核对v1–v21 checksum、旧operation/attempt/checkpoint及资源记录逐字保持；旧v21 writer被组件门拒绝，升级前备份可按v21读取。迁移不把历史缺席的草稿或RPC停止字段补写为新协议证明。

v43 回归核对 v34–v42 原 SQL 与已有记录。覆盖选择分隔显式请求和默认自动观察，同一提交的自动观察保留手动操作；新提交按原顺序接入，且沿自身授权与预算。真实未执行覆盖清单必须与正式验证范围绑定。
