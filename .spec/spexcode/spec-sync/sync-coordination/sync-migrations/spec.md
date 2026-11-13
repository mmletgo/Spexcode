---
title: 协调数据库增量迁移
status: active
hue: 175
desc: 在既有会话 SQLite 注册独立 spec-sync 组件，备份后事务升级并拒绝未知版本。
code:
  - spec-cli/src/sync/migrations.ts
---
# 协调数据库增量迁移

## raw source

持续同步必须能安全升级既有会话数据库，失败不破坏已有会话和恢复记录。

## expanded spec

v52 只追加 SELECT 1 writer marker，保护 [[sync-coordinator]] 的候选 GAP 独审及 [[elaboration-result]] 的精确 owner 续稿引用。先停稳并结算旧 writer，再保存一致 online backup。旧请求、批准和 Git/CAS 原件保持。回滚恢复一致 v51 备份及配套证据和 Git 引用。

v51 只追加 SELECT 1 writer marker，保护 [[sync-coordinator]] 的混合候选续审与 [[elaboration-result]] 的精确 owner 契约遗漏返修。停稳并结算旧 writer 后保留一致 online backup。旧阶段、候选和结算记录的原字节保持。回滚恢复一致 v50 备份及配套证据和 Git 引用。

v50 只追加 SELECT 1 writer marker，保护 [[sync-historical-coverage]] 的精确历史未执行资格。升级先停稳 v49 writer、正式结算资源并 online backup。旧计划按原资格验证，历史报告、收据、基线、表行、索引与迁移 checksum 保持。回滚先停稳新 writer，再恢复一致 v49 备份及配套证据和 Git 引用。

v49 追加 SELECT 1 writer marker，保护 [[sync-store]] 的新观察覆盖投影。升级先停稳并结算 v48 writer，保留一致 online backup；原观察 JSON、旧迁移 checksum、完整基线与收据原件保持。新版按旧字段投影读取。旧 writer 在写入或派发前拒绝。回滚停稳新版后恢复一致 v48 备份及配套证据和 Git 引用。

v48 只追加 SELECT 1 writer marker，保护 [[sync-code-behavior]] 新 git-json-v6 的冻结方向、当前作者意图指导及程序 analysis 的真实指导版本。升级先正式停稳 v47 writer、结算资源与租约并保存 online backup，再由原组件事务追加；v1–v47 SQL/checksum、历史请求与缺席字段、原 Git/CAS 和自动采纳索引保持。旧 writer 在写入或派发前拒绝，迁移失败整体回滚。回滚先停稳新版并结算资源，再恢复一致 v47 备份及配套证据和 Git 引用，不删 marker 或补签旧批准。

v47 只追加 SELECT 1 writer marker，保护 [[sync-coordinator-types]] 的 contextVerifications 完整封口语义。升级先停稳 v46 writer、正式结算资源并 online backup；既有自动采纳索引、迁移 checksum 和历史计划/记录原字节保持。旧 writer 在写入或派发前拒绝。回滚先停稳新 writer，再恢复一致 v46 备份及配套证据和 Git 引用，不删 marker 或改签旧计划。

v46 以原组件事务登记自动主来源采纳政策，并为已结算 publication parent、来源原 delivery parent 与按 operation/attempt 读取 journal 增加表达式及复合索引。v1–v45 的迁移、checksum 和历史 JSON 保持。升级前正式停稳旧 writer、结算资源并做 online backup。索引与 marker 同事务，失败整体回滚，旧 writer 拒绝新代。回滚停稳新版后恢复一致 v45 备份及对应证据和 Git 引用。

v45 追加 SELECT 1 writer marker，保护 [[sync-publication-base]] 绑定真实来源 HEAD 或正式交付 receipt 的 v2 父提交证据。升级先正式停稳 v44 writer、结算资源并在线备份，历史发布基树、候选及原迁移保持原字节。回滚恢复一致的 v44 备份和配套证据及 Git 引用。

v44 追加 SELECT 1 writer marker，保护 P0 分析的 git-json-v5 冻结协议。升级先正式停稳 v43 writer、结算资源并在线备份，原迁移、历史请求和证据原字节保留。回滚先停稳新 writer，再恢复一致的 v43 备份和配套证据及 Git 引用。

v43 追加 `SELECT 1` writer marker，保护手动只读操作的未执行覆盖选择、正式验证清单和验证检查点中的镜像卷遮盖。升级先正式停稳 v42 writer、结算资源并在线备份。历史请求与迁移字节保持。回滚先停稳新版，再恢复配套的 v42 备份、证据和 Git 引用。

v42 追加 SELECT 1 writer marker，保护正式重试继承的 P1 分区批准及其原派发证据。旧 writer 在写入或派发前拒绝。升级先正式停稳旧 writer、结算资源并在线备份，再在原迁移事务追加。原迁移 SQL、历史操作和证据保持原字节。回滚先停稳新 writer，再恢复本次升级前的一致备份和对应证据与 Git 引用。

v41 追加 SELECT 1 writer marker，保护 Cursor 原生 ACP 工作树操作及停止证明。部署前正式停稳 v40 writer 并结算资源，保留一致在线备份。回滚先停稳新 writer，再恢复 v40 备份与对应证据和 Git 引用。

v40 追加 SELECT 1 writer marker，保护 Grok 原生工作树操作及其停止证据。部署前正式停稳 v39 writer 并结算资源，再保留一致的在线备份。回滚须先停稳新 writer，再恢复 v39 备份及对应证据和 Git 引用。

v39 只追加 SELECT 1 writer marker，保护 P0 首次派发前冻结的原正常提交草稿。旧 writer 不得重新选择新请求的原料。升级先正式停稳旧 writer 并结算，再正常 online backup 和组件事务。回滚先停稳新 writer 并结算，再恢复一致 v38 备份及配套证据和 Git refs。

v38 只追加 SELECT 1 writer marker，保护从未领取的提交快照初始化被替换后的接入规则。旧业务记录、迁移和索引保持原样。升级先正式停稳旧 writer 并结算资源与租约，再正常 online backup 和组件事务。回滚先停稳新 writer 并结算，再恢复一致 v37 备份及配套证据和 Git refs。

v37 只追加 SELECT 1 writer marker，保护派发前冻结的 P0 独审路径自检。升级先正式停稳旧 writer 并结算资源与租约，再正常 online backup 和组件事务。旧 writer 在写入和派发前拒绝。回滚先停稳新 writer 并结算，再恢复一致 v36 备份及配套证据和 Git refs。

v36 只追加 SELECT 1 writer marker，保护在派发前冻结的 P0 草稿覆盖自检指引。旧请求和数据原字节保持。升级先正式停稳旧 writer 并结算资源、租约，再做 SQLite online backup 并事务追加。回滚先停稳新 writer 并结算，再恢复一致 v35 备份及配套证据和 Git refs。

v35 只追加 SELECT 1 writer marker，保护新初始化分区策略和跨操作的 P0 原批准来源。旧计划、调用与历史 records 保持原字节。旧 writer 遇到新库须在写入和派发前拒绝。升级先正式停稳旧 writer 并结算资源和租约，正常 online backup 后事务追加。回滚先停稳并结算新 writer，再恢复一致 v34 备份和配套证据及 Git refs。

v34只新增sync_observations的部分表达式索引：键为完整source_key、input.id、latestDifferenceDigest与outcome，成员条件逐字沿用commit、failure为NULL且outcome非blocked。索引由SQLite维护既有行及后续写入，不保存第二份观察事实，不改原查询、分组、rowid顺序或任何历史业务行。升级前停稳旧writer并结算或保留资源和租约，沿正常online backup及组件事务建索引；v1–v33 SQL/checksum与全部旧记录保持，v33及更旧writer拒绝新代。建索引失败连同marker整体回滚，重复迁移幂等。回滚先停新writer并结算或保留资源，再恢复升级前一致v33库与配套evidence/runtime/Git refs，不能删marker降级。

v33仅追加SELECT 1 marker，保护P1 V5只读事实修正资格及其阶段摘要。所有旧32及更旧writer在任何claim、renew、状态写或派发前拒绝；V1–V32 SQL/checksum和全部历史记录保持。升级先停稳旧backend/queue、结算或保留真实资源及租约，做一次32一致SQLite online backup后事务追加。回滚先停新writer并结算33产生的资源，再恢复32一致备份和配套evidence/runtime/Git refs；不能删marker、改历史请求或补写旧字段。

v32仅追加无DDL SELECT 1 writer marker，保护远端 V3 v2 的 target/effect/closed 持久语义，以及 removed 须确证容器和临时 staging 均已清算的边界。v31及更旧 writer 在任何写入/派发前拒绝；保 v1–v31 SQL/checksum 与旧记录原字节。升级停稳旧 backend/queue并结算或保留资源，再 online backup 后事务追加。回滚停新 writer，先结算远端资源，再恢复一致 v31 备份及配套 evidence/runtime/Git refs；未知远端 effect 未结算不能用旧备份抹掉 ledger，不能删 marker 降级。

v31仅追加无DDL SELECT 1 marker，保护完整Native P1独审的`ac-test-flow-review-binding-v3`及已结算 `session/events` 超时后仅预留P1独审的派发形态。v30及更旧writer须在任何写入或派发前拒绝。停稳旧backend/queue并结算资源及租约后，v30→v31做一次SQLite online backup，再在组件事务追加marker，保留旧SQL、checksum、旧表及已冻结请求。回滚先停新writer，再恢复升级前一致的v30备份及原evidence/Git refs。

v30仅追加无DDL SELECT 1 marker，保护完整P1生成提示版本`ac-test-flow-binding-v2`。v29原能在拒绝未知阶段版本后持久化unsupported，故旧writer须在任何写入和派发前拒绝新库。升级停稳旧backend/queue并结算资源及租约后，v29→v30做一次SQLite online backup，再在组件事务追加marker，历史SQL、checksum、旧表和请求原件保持。回滚先停新writer，再恢复升级前一致备份及原evidence/Git refs。

v29仅追加无DDL SELECT 1 marker，保护P1原生草稿`elaboration-draft-protocol`已冻结的完整生成提示版本。v28及更旧writer必须在写入与派发前拒绝，包括提示版本已保存而派发尚未reserve的窗口。升级停稳旧backend/queue并结算资源和租约后，先做一次SQLite online backup，再在组件事务追加缺失marker。v27直升v29同样只备份一次。既有迁移SQL、checksum、旧表和请求原件保持，回滚先停新writer再恢复升级前一致备份及原evidence/Git refs。

v28仅追加无DDL SELECT 1 marker，保护P1全局证据中独立的analysisOnlyPartitions和精确摘要。v27及更旧writer必须在写入和派发前拒绝。升级先停稳旧backend/queue并正式结算资源和租约，再用SQLite online backup及组件事务迁移，v1–v27 SQL、checksum、applied_at和旧业务表原样保留。回滚先停新writer，再恢复升级前一致v27备份及原evidence/Git refs，不删marker。

v27仅追加无DDL SELECT1 marker，保护已停owner物理JSON草稿的明确未批准材料准入及来源选择；v26及更旧writer必须写入/派发前拒绝。升级先停稳全部旧writer并结算或保留资源，经0600私有SQLite online backup及组件事务26→27，v1–v26完整migration/checksum/applied_at和全部旧表/请求/receipt保持。回滚停新writer后恢复一致v26库及evidence/Git refs，不删marker、不改旧计划或原工作树/index。NativePlan、structured policy与业务schema不改。

v26仅追加无DDL SELECT1 marker，保护精确已停ZCode失败的未批准Git材料准入与既有严格较新来源选择，v25及更旧writer写入/派发前拒绝。NativePlan及structured policy仍按原v3/v6或原历史版本冷验，不补字段。升级前停稳旧writer并结算或保留资源，经SQLite online backup及组件事务25→26；v1–v25 migration完整行/checksum/applied_at与全部旧业务/protocol表保持。回滚停新writer并恢复升级前v25一致备份及原evidence/Git refs，不删marker、不重签旧记录或丢弃最新未批准稿。

v25仅追加无DDL SELECT 1 marker，保护P0 behavior-draft-protocol可选contextTransport:git-json-v1及同owner/purpose只读Git context文件运输。v24及更旧writer必须在写入或派发前拒绝，避免已冻结传输选择被忽略。升级先停稳全部旧backend/queue并结算或保留资源，再沿既有SQLite online backup及组件事务迁移；v1–v24 SQL/checksum/applied_at、全部旧表、请求、缓存和receipt原字节保持，不补历史缺席。回滚先停新writer，再恢复升级前v24一致备份及原evidence/Git refs；不能删marker或重签旧请求。

v24仅追加无DDL SELECT 1 marker，保护 nativeConfiguration:cli-config-v1、Claude NativePlan v2 与 ZCode NativePlan v3 的实际每轮配置/模型证据协议。v23及更旧writer在写入或派发前拒绝；正常升级先停稳全部旧backend/queue并结算或保留资源，按既有online backup后事务迁移。v1–v23 SQL/checksum/applied_at及全部旧表/请求/receipt原字节保持，不补历史字段。回滚先停新writer，再恢复升级前v23一致备份及配套evidence/Git refs；不能删marker或重签旧计划。

v23以无DDL SELECT 1登记P0按purpose的Git草稿、认证Native材料和精确分析续审协议；关闭behavior-draft-protocol已保存而dispatch尚未reserved的崩溃窗口，v22及更旧writer必须在任何业务写入/派发前拒绝。沿既有online backup及组件事务保v1–v22 checksum、原记录/请求/CAS不变；既有reserved请求仍按原绑定恢复。升级先停稳全部旧writer并结算或保留真实资源，回滚先停新writer，再恢复升级前v22一致备份及原evidence/Git refs，不删marker或补造历史草稿。

v20仅以SELECT 1登记 [[sync-source-registration]] 及EnabledRecord v2的writer语义。沿原online backup与组件事务，旧v19 writer逐事务拒绝，v1–v19 checksum及全部旧记录/CAS保持。continuity记录另在私有global runtime保存；回滚停新writer后恢复升级前一致DB备份、原enabled字节及原continuity-evidence链，不删marker或用新见证改旧input。失败暂停可能已生效，文件CAS和DB不是跨介质原子事务，不自动恢复run。

v19以无DDL SELECT 1登记 ZCode 非交互工具策略与 NativePlan version2 的 writer 能力；结构化策略仍 version6、工作流仍 native-worktree-v1。旧 v18 writer 不能理解新固定请求字段，必须整体拒绝。沿原 online backup/事务迁移保留 v1–v18 checksum、旧 record/payload/receipt 与旧请求缺席语义；升级前停止旧 backend/queue 并结算或保留真实资源，回滚恢复升级前一致备份和原 evidence，不能删 marker 或改写历史请求。

v18以无DDL SELECT 1登记native-worktree阶段seed、自由仓库读取与实际Git候选导入的writer能力，结构化执行为固定version6。沿既有online backup及组件事务升级，保v1–v17原字节/checksum、旧record/payload/receipt。旧v17及更早writer必须整体拒绝；升级前正式停止全部旧backend/queue并结算真实资源。回滚先停新writer、结算或保留真实资源，再恢复升级前一致备份及原evidence，不能删marker、改v3工具描述或手改任务DB伪装旧协议。

v17 为无限模型调用的语义writer marker；正式online backup后正常迁移，不修改v1–v16 checksum或历史JSON。旧v16 sync writer因组件版本拒绝；独立旧结构化queue另由新null执行策略version5在固定策略校验时拒绝。升级前停止全部旧backend/queue consumer并结算或保留在途资源；回滚停新writer后恢复升级前一致性备份，不删marker或改写null记录冒充旧数字。

复用现有 SessionProtocol 和 applyComponentMigrations，不打开第二执行数据库或第二消息队列。升级前使用 backupTo 的 SQLite online backup；禁止直接复制 WAL 主文件。组件迁移在 BEGIN IMMEDIATE 中原子执行，错误全部回滚；重复启动核对 checksum，未知更高 generation 拒绝同步写入。不做破坏性 down migration，回退保留表和 blob。

初始v1保存 operation（内含冻结输入引用）、attempt（候选/证据/checkpoint 引用）、逐实际文件/规则 lease、apply journal（内含 receipt）、成对 baseline。检索身份、阶段、generation、唯一接入/派发/副作用键显式列，scope/budget/refs 小 JSON 保存运行记录，不保存正文、大契约图或第二份可编辑源码。lease tombstone 的 generation 在释放后保留。范围和动作门禁由 [[sync-store]] 负责。

v2在v1原迁移字节保持不变的基础上增加sync_resources，记录稳定资源计划、生命周期阶段及checkpoint blob引用，按未removed状态索引所有历史attempt资源。升级使用一致性backup保存v1；已有会话、operation、attempt、journal与基线不改含义。不复制checkpoint正文，也不引入执行数据库或消息队列。

v3 登记受控用户请求 requestBlob 的运行语义版本，无破坏性表结构或旧记录改写。升级前仍保存一致性备份；旧版写方因更高组件版本拒绝写入，不能忽略新请求后按旧输入执行。旧版无 requestBlob 的 payload 摘要保持相同，升级后重复事件继续命中原 operation。

v4登记可信计划planBlob直接持久引用/GC保活的语义版本，仍仅增marker、不改旧记录。v3升级先online backup，旧无plan操作和原payload/队列可读；旧writer拒绝新版本，不允许在忽略plan恢复引用的情况下写入。

v5保持v1-v4迁移字节/checksum，新增origin摘要与按仓库protocol地址的语义版本。升级先online backup；旧global pending按真实FIFO逐个tx.dequeue再tx.enqueue到仓库地址并更新operation.dispatchMessageId，稳定迁移key幂等，旧消息保留审计。迁移不得直接更新protocol内部消息字段。版本marker与数据迁移必须同事务；中断全部回滚。旧writer拒写v5；已消费消息/native/attempt/journal身份保留。

v6增加retryOf显式用户重试语义及semantic_digest索引，由checksummed callback从旧冻结record回填，不改v1-v5迁移字节/checksum。升级前online backup，旧记录无retryOf仍按旧精确摘要重放，旧writer拒写更高版本，禁止downmigration。

v7新增规范请求语义索引和精确 ingress 接入收据，不改 v6 helper、checksum 或历史 payload/record。DDL 迁移不读取任何仓库 Git/blob；旧受控请求在当前来源接入边界惰性核验后填索引。升级仍 online backup、原子回滚、重启幂等和旧 writer 拒写；其它已移除仓库的证据缺失不阻数据库升级。

v8登记P3行为授权、已结算精确业务裁决和退役身份的writer语义版本，保持v1-v7迁移字节/checksum不变。升级前online backup、marker同事务、重启幂等；旧P2 writer必须因generation更高拒绝，不能忽略新JSON引用后丢弃已确认用户规则。旧缺省refs仍可读，禁止破坏性downgrade。

v9登记结构化裁决授权范围和结算后稳定裁决身份语义，v1-v8迁移字节/checksum不变；先online backup，marker事务幂等，旧v8 writer拒写。旧裁决规范索引仅在真实不可变request可核验的当前来源接入边界重算，历史payload/record/receipt不改。

P4 采用第10代增量组件迁移：新增物理控制、资源 frontier、持久观察，原会话数据意义不变。升级前在线一致备份；组件事务失败整体回滚，重复启动幂等，未知新版拒绝同步写入。P3 资源头仅从 coveredScope、实际 journal.files、receipt 与明确前驱链回填；不能以 rowid、时间或文件授权目录猜精确历史。无法证明的资源记录 legacy 阻断，新接入失败而旧冻结 journal 恢复保留。

第10代同组件增量表包含observer health，旧实例CAS与观察/头记录不影响原会话读义。升级事务核在途journal的operation/attempt/generation绑定；异常整体回滚并保升级前online backup。缺settled journal的旧coverage记录legacy未知；退役kind只从原coveredScope/operation.scope证明，未知kind明确阻断而不猜contract或flow初始null。实际path头仅来自完整journal.files；path授权目录不伪造成文件头。源同物理发布pair仅凭同receipt且sourceInput=verifiedDelivery的明确发布关系选取，不凭rowid/updatedAt/settledAt猜语义先后。

退役kind证明仅使用当前pair、其settled journal对应operation.scope及明确前驱receipt可证明的同完整source祖先；同receipt发布对应源身份明确匹配才连接祖先。其它repo、branch、物理树的同名ID及未关联queued operation不得给该source制造确定kind。无本source证明仍保两kind legacy unknown。

第11代仅登记成组不可变历史请求的 writer 语义，不修改既有迁移字节、会话或 journal。先在线备份，marker 与升级事务一起结算，旧 writer 拒绝未知授权；版本回退保留新增表和 evidence。

v12标记同一历史身份restore及按当前逐ID head读取退休状态的writer语义；v11及更旧writer必须拒绝新generation，迁移保原表/retirement pair并先一致备份。

v13仅以无DDL SELECT 1登记操作固定模型的writer能力，保v1-v12字节/checksum及全部旧operation/payload/receipt/fence记录。先按原流程online backup，旧二进制必须在读取operation或派生retry前因未来generation拒绝；v2运行描述继续核精确操作模型。回滚须先停writer并结算或保留真实资源，按既有恢复流程恢复升级前一致数据库备份及其原evidence，不能让旧writer直接读v13或删marker降级。模型合同属于 [[sync-model-selection]]。

v14仅登记提交边界快照、分区计划与分布式审查的 writer 语义，沿现有流程先在线一致备份，再在组件事务中增加 marker。旧 operation、输入/请求摘要、分区前历史与 receipt 字节不变，旧版写方不能忽略新语义而继续派发。分区运行记录复用既有 attempt/checkpoint/resource，不另建任务数据库或队列。回退须停 writer、保留或结算资源并恢复升级前备份及原 evidence，不能删 marker 或把新计划伪装成旧单任务。

v15以无DDL SELECT 1登记显式unlimited预算与nullable operation期限的writer语义；保持v1–v14迁移字节/checksum及全部旧record/payload/receipt。须先停writer并结算或保留真实资源，再沿online backup和组件事务升级；旧writer因v15拒写。回滚恢复升级前一致数据库备份及其evidence，不删marker、不手改旧记录或重置预算。

v16以无DDL SELECT 1登记 ZCode 固定命名空间、结构化策略与原生证明的 writer 语义；保留 v1–v15 原字节/checksum 及历史记录。升级前停 writer、核对在途资源并保存一致备份，正常迁移原子登记 marker；旧 writer 必须整体拒绝，不能把 ZCode 派发为 Codex。回滚先结算或保留资源，再恢复升级前一致备份与 evidence，不删 marker 或手改 operation。

v21以无DDL SELECT 1登记typed checkpoint artifacts与raw/stage权限边界；沿正常online backup与组件事务拒v20旧writer，v1–v20 checksum及旧记录/CAS原字节保持。升级前停稳全部旧服务/队列并结算或保留真实资源。回滚先停新writer，再恢复升级前一致备份及对应evidence，不删marker或改写历史raw refs。

v22以无DDL SELECT 1登记按owner保留的Git JSON草稿续修及已证停止的原生RPC暂态失败准入。忽略这些持久身份与结算边界的v21及更旧writer必须拒绝；结构化执行仍复用v6 read/edit，不改写旧请求、输出、缺席字段或CAS。升级前停稳writer并结算或保留真实资源，沿既有online backup和组件事务保v1–v21 checksum与全部旧记录。回滚先停新writer，再恢复升级前一致DB备份、原enabled/continuity evidence及相应Git保活引用，保留未采纳的新草稿，禁止删marker降级。
