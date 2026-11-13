# 持续同步编排

- 本目录复用 session 原生工作树执行与 spec-core/contracts；不自行维护第二份契约图或会话执行器。旧受限结构化策略只按原绑定恢复历史任务。
- Dashboard 保存 Spec 立即进入 spec→code；外部文件保存/index变化只观察，Git 提交冻结 HEAD 后才派发。已采纳的真实同步发布先消费为基线，避免回声或污染下次提交方向。
- 已启用的主分支自动采纳新授权的完整已验证交付；与显式采纳共用发布锁、原收据和普通 Git 快进。每个直接后继采纳后先观察该 HEAD 再继续；历史无标记或来源有改动时保留私有结果。writer46 只追加自动采纳索引与版本围栏，回滚恢复一致 v45 备份及原证据。
- code→spec 只装配已审 Spec，source/test 的 Git path、mode、OID 与 absence 必须不变；不能调用代码生成器修绿验收。
- 手动 code→spec 显式记录未执行覆盖时，已审声明与实际测试分开。全部旧绑定、冻结 mandatory、V1–V4、严格交付和采纳保持，`unexecutedContractIds` 只来自通过的正式验证原件。
- 分区复用 partitioning/partition-execution 的唯一计划，共用 operation、fence、预算与最终 candidate/journal/receipt。任务只交付变更 Spec、相关接口和明确目标；Agent 在独立 worktree 自由读取，不以分块读取或逐字消费证明作为同步门禁。
- 新计划的 contextVerifications 只供全图 seal 校验未选 owner 的冻结定义；局部模型和 V3 保原登记及运行范围，旧 plan 缺席不从实时配置补入。writer47 只追加 marker；停稳并结算旧 writer 后 online backup，回滚恢复一致 v46 库及配套证据/Git refs，不删 marker。
- 新计划的历史未执行资格只由 historical-coverage 按精确已采纳 pair/receipt/report 和三份 Git 对象冷验；P1 全图 seal 与 V1 共用逐 ID 判据，局部请求与当前义务保持严格。证明沿原 planBlob，旧缺席不补写。
- 共享分区调度每项结束均须真正让出事件循环，缓存、末项与失败亦然；让原心跳与控制运行，不延长租约或弱化fence。P1只按最近有真实P1派发的已结算观测故障收紧下一次返修，故障消失后恢复冻结并发；无派发或仅复用检查点的控制重启不消耗或重置该次返修。
- 每阶段绑定真实 seed commit/tree：分析使用 composed，细化包含已审祖先，构建包含已审 Spec，独审使用实际候选。缓存同时核验实际可见 tree；不能只传原 HEAD 而漏掉受控 Spec 修改，也不能混入提交后的 index/WIP。
- 实现 Agent 在工作树真实修改、测试并正常提交；候选从实际 Git 对象差量导入。程序检查写范围、CAS、原测试和契约演进，生成摘要或自报补丁不能替代实际修改。
- 模型临时业务行由 `CONTRACT_COLUMNS` 渲染唯一 Markdown；raw/摘要由程序复制，JSON 仅是执行证据。
- 生成和独立评审使用不同会话。输入、候选和检查结果均按内容摘要绑定；未决 GAP 只阻塞依赖闭包。
- P1 V5完整叶只读事实返修只消费原candidate_review认证诊断的typed relatedIds与冻结owner交集：仅desc/expanded及命中RULE.basis可变，其余业务列/raw/绑定/AC/VERIFY严格保持；旧缺席不补写、不从message或草稿errors授信，局部与strict seal共用。
- P1独审共用生成侧owner范围；仅要求冻结owner改写的repair或未知ID绑定须给具体拒因重审。原JSON/Git稿、候选与原Native生成身份冷验相同后只续独审；域内语义repair仍续生成。已结算的ZCode session/events独审超时同样可仅续审，须同operation冷验原只读请求、canonical失败与正式removed/stop，保原失败及未批准状态。旧请求字段不追补。
- 状态派发 STEP 显式关联实际 TR；next→TR 是依赖，next→STEP/STATE 仍为导航，独立审查核对派发集合与步骤声明范围。
- `readyIds` 是声明级可推进；完整流程使用 `readyFlowIds`，`blockedFlows` 解释受阻步骤/GAP，不向独立子项回传父阻塞。
- 普通无冲突实现约定用 code 来源沿用；GAP 仅承载重大业务未知/意图冲突。内部已结算 seed 只作诊断，新请求/完整独立审查必须重新绑定，不能升格为 raw 或事实。
- `complete` 仅表示当前细化阶段通过，不代表代码、测试、落盘或全产品已同步。
- 细化与契约演化验证：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-*.test.ts spec-cli/src/sync/contract-evolution.test.ts spec-cli/src/sync/frozen-contracts.test.ts`；行为分析与实现验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/code-behavior.test.ts spec-cli/src/sync/generation.test.ts`；`npx eslint spec-cli/src/sync/`；`npm run typecheck`。
- V3 Docker 验收由 `verification-executor.ts` 运行；仅接收可信冻结政策和不含 Git/宿主依赖的 export。检查点通过调用者持久保存，`recovery_required` 不释放未知容器的容量；不使用宿主 fallback。
- 远端V3仅由server的`SPEX_VERIFICATION_SSH_ALIAS`/`SPEX_VERIFICATION_SSH_ROOT`成对选择既有SSH与独占root，`SPEX_VERIFICATION_SSH_DOCKER_ENDPOINT`可选同机Unix socket（默认`unix:///var/run/docker.sock`），每次显式绑定、不继承Docker context。正常/恢复共用transport；v1保持本地，v2按原target/daemon、单run effect/closed排空，容器及staging均清算才removed。控制历史保留，不用SSH退出或NoSuch推定未知create已停。writer32升级沿原停稳/online backup，回滚须先结算远端资源并恢复一致旧库及evidence，不删marker。
- 运输定向验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.test.ts spec-cli/src/sync/verification-transport.test.ts`；fixture以隔离SSH/CLI和实际内核文件锁验证断连与迟到请求，真实Linux/产品入口证据另行验收。
- 执行器单测：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.test.ts`；真实 Linux/arm64 Docker 验收：先准备测试中冻结的镜像，再 `SPEX_DOCKER_VERIFICATION_TEST=1 npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.docker.test.ts`。`SPEX_VERIFICATION_EVIDENCE_DIR` 可指定已存在的外部证据目录；未设置时用系统临时目录，不把运行证据写入源码。

- 持久协调使用 `operation-types.ts` 共享身份，原source/composed/candidate分离；所有写入走store动作门禁及既有protocol事务，native/Git/FS副作用放事务外。
- `sync resources recover` 仅结算显式 operation/input 的既有 owned 资源；普通 `sync recover` 还可回放 journal。资源清理不授予来源连续性，来源不匹配仍不得 resume/adopt。
- 普通协调器逐任务回收已完成或精确停止且clean的Native工作树，正式close保branch/archive/record与原结果/错误；removed不代表物理删除。已归档失败稿经原认证临时restore→严格观察→复用物理回收段，保原archive/Native，零launch/wake；仅回收registry内本次created场地。dirty/未知停止保留，pending不改业务结果或烧新调用。
- 存储验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts packages/session-protocol/src/adopter-seams.test.ts`。
- writer34以正常online backup/组件事务新增commit观察frontier部分表达式索引，保原SQL、全历史分组与旧记录；升级停稳旧writer/结算资源，旧writer拒新代，回滚恢复一致v33备份及配套evidence，不能删marker。

- P2 快照/候选仅操作明确 commonDir 的 Git 对象及私有保活 refs，禁用元数据 fsmonitor/reference hooks；开发/交付提交不可照搬禁 hooks。原输入与 ComposedInputRef 分开；实际模型 diff 和最终 apply diff 分开。
- 快照/候选针对验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/snapshot-candidate.test.ts`；build 后 `npm run typecheck`、`npx eslint spec-cli/src/sync/{snapshot,composition,candidate,snapshot-candidate.test}.ts`。

- operation固定请求选择；同request/retry先沿原绑定，真正新操作取显式选择或版本化`sync.model`，再按工作流缺省（native为`claude:default`，历史frozen为sol）。旧operation缺字段仍固定sol，不回写。换模型只经新操作或显式 retryOf；resume/recover 不换模型。完整已审冻结候选仅在未登记V3资源的unsupported正式retry、全部原件与输入/模型/政策绑定冷验一致时零模型续验；缺证或漂移明确拒绝，不静默从P0重做。严格同绑定且已结算的零调用/派发/候选/副作用空失败后继仅可回溯原已审祖先重新认证，不授批准或补旧checkpoint；同parent幂等保持。零调用候选后继仅在全部原验证资源正式removed且完整passed、原导出/政策/closed原件冷验时可沿祖先续验；原记账失败及报告保持，业务failed、缺证或未知资源拒绝，新V3仍fresh。原生工作树任务使用 sync-tools-v3 固定工作流，旧 v1/v2 只恢复原请求；不因注入 runner 降级生产策略。

- ZCode使用`zcode:default`或`zcode:<provider-id>/<model>`，模型/别名交SDK解析，实际每轮选择另行留证；与Claude共用版本化原生工作树执行、队列和资源桥；换provider仍须新操作/正式retryOf，不自动fallback。旧v4只读策略和原生读取证明仅用于其历史请求。

- 原生工作树使用结构化策略 v6，sync v31 组件 marker 拒绝旧 writer；ZCode 新 read 请求冻结精准 ExitPlanMode denylist 与 NativePlan v2，旧资源/记录及仅 reserved dispatch 的字段缺席保持，后者只以完整请求摘要确证；内部创建键首建保留上游冻结字段并严格验策略，不能恢复时补默认。旧数字与 null 的只读 v1–v5 原样恢复。unlimited 模型调用期限为 null，创建、租约、stop/close 及 Docker 期限仍独立有限。升级先停全部旧 backend/queue 并结算资源、备份数据库；回滚恢复升级前备份，不能只删 marker 或改工具描述。
- 新P1按owner显式冻结elaboration-draft-v1，精确schema在同seed只读sidecar，v6 edit只写真实Git临时草稿并正常提交、小summary回执；程序读指定blob后再JSON/schema/renderer/独审。失败正文留Git refs，checkpoint只记身份和errors并保留原finding定位及severity，旧缺席不补写；诊断不进入raw role/业务candidate；跨父输入只迁draft不迁旧树，accept仍核完整摘要及冷Git/schema/最终正文渲染绑定，原source tag不向legacy补签；仅验证时允许保留hooks的正常空提交，不造业务diff。已冻结/仅reserved旧请求不补协议。该草稿协议由writer22围栏保护；完整生成与独审的测试绑定和流程提示由新attempt原stage的generationGuidance冻结，writer31保护v3；旧v1/v2及字段缺席按原提示恢复；精准回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-draft.test.ts`。
- 格式/schema拒绝的final仅经adapter原请求/身份/停止认证后保存为可选rejectedOutput诊断；历史只读请求的原文ref/SHA与完整正文进入同owner下一prompt，不能填成功output或候选、继承accept、读取thinking或追补旧缺席。review失败保留此前合法generation和candidate。 仅格式失败续审沿原P1/null扩域证明保partition计划及候选，认证原Native refs只给精确失败组的只读诊断seed；兄弟accept仍核完整原请求，ZCode policy按saved原字段重建，不追补缺席。


- 跨boot显式continuity用offline `sync source-continuity`，先停稳并清资源，核原op/input/revision、enabled原字节SHA与三旧dev双哈希；commonDir共享enable/register锁。v23拒旧writer，成功仅暂停原PhysicalControl并登记v2；旧op/input/CAS不改。私有runtime/sync/continuity-evidence保原enabled及proof链，不依赖DB-only GC；回滚配套恢复DB/启用原件/证据。正常身份只投影已证明哈希并保actual branch/path，失效不fallback；raw仅显式证明及资源清理可用。

- v21 checkpoint的typed artifacts随JSON wrapper一次动作保活，raw只作untrusted_final；读取须核真实失败round/Native身份，旧无role引用不补写，未知损坏JSON仍报错。升级走online backup，回滚恢复一致旧库与evidence，不能删marker。

- v22登记owner Git草稿续修与已证停止RPC故障的显式准入。草稿只存Git对象身份，不借raw权限；旧缺席字段不追补，已接受候选仍须原绑定。只有现有停止协议确证并结算资源后，运行中的有效fence才能续修，用户暂停/取消和未知停止不自动重启。 缺final的typed格式失败可独立保Git；旧无witness及安全暂停稿只在新有效attempt按原request/owner/seed/schema、完整source/tests对象及正式stop/removed观察最新正常Git，旧record/checkpoint不补签，普通暂停不赋格式码。 明确已停CLI错误终态只授未批准Git材料，不借格式或success角色；可选native-protocol.jsonl只记安全元数据，冷验不追补。

- 新P0首次冻结git-json-v5，沿v4分析覆盖与独审路径自检。分析只读自检以正式判据定位当前非`user:raw`验收更新中的未变化只读来源。续修同一JSON，诊断只输出给当次会话，持久失败保持状态。v1–v4、缺席字段和saved/reserved按原绑定恢复，业务摘要与批准复用保持。writer44只追加SELECT1，升级先停稳结算并online backup，回滚恢复一致v43库及evidence/Git refs。

- writer38保护提交快照初始化的接入：被替换且从未领取时，新显式请求用新交付计划入队，继承原预算、截止时间及队列锚。旧请求身份、已有领取和自动观察去重保持。升级先停稳结算并 online backup，回滚恢复一致 v37 库及证据和 Git refs。

- writer39保护 P0 分析首次 reserve 前已验证的停止提交草稿。复用现有提交和托管投影核验，先冻结原 Git 引用与当前输入、seed、owner、schema；冷续直接核冻结稿。原 P0 协议和批准复用保持，升级和回滚配套保留一致 v38 备份、证据与 Git refs。

- writer23围栏保护新P0持久协议；升级前停稳旧writer/结算或保留资源，正常online backup迁移，回滚恢复一致旧库及evidence，不删marker。新P0按attempt显式冻结code-behavior-draft-v1，analyze/review复用stage-worktree的同owner/purpose Git草稿与只读schema；格式失败续原JSON，review格式、引用绑定或覆盖协议错误保已校验分析与完整拒因，仅续原review；完整合法独审的业务finding/repair仍续原analysis并重新独审。旧reserved不补协议；认证旧Native CAS仅作新seed临时材料，不伪造历史Git稿。仅认证且命中原变更owner/affectedIds的P1后置语义质疑才触发新analysis与独审；格式失败继续原文件及失败环节，不改kind或扩授权。

- 完整初始化资格不等于所有源码曾被写过：未写path可用精确已采纳owner Spec、正式settled receipt、scope及三份对象一致证明只读初始化，缺binding/null保持；已有非null头不fallback，未审owner/源码漂移拒绝。规划回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/planning.test.ts`。

- 新 Claude、ZCode 和 Grok native-worktree 请求只在真正新记录/资源冻结nativeConfiguration:cli-config-v1；原saved及仅reserved请求缺席保持并核完整原摘要。default/不透明模型由原生 CLI 配置与每轮原生证据核实，不维护CLI版本/模型名册。新sync请求在冻结前省略内部默认high，已有Native原件按原effort或缺席冷验，standalone显式effort保持；派发和coordinator原件重验共用pinSyncNativeRequest。writer24只追加SELECT1；升级停稳旧backend/queue并结算资源、online backup后迁移，回滚停新writer并恢复升级前一致DB及evidence，禁止删marker或改签旧plan。针对回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/session-native-configuration.test.ts spec-cli/src/sync/native-run.test.ts spec-cli/src/sync/store.test.ts`。

- ZCode最新失败Git稿沿既有严格较新来源/currentfence材料接缝；旧cancelled/新failed均核formalstop+removed全值及原公开Native身份，冷观察不改旧原件或读success history，不附failedWorktree/授自动重试。P0 已封存却未发布的历史候选只在原失败、正式结算及当前fence认证后复验封存并跳过，不能作为续修材料。writer26保护新准入，升级先停旧writer/结算资源、online backup，回滚恢复一致v25库及evidence/Git refs。定向材料回归：`npx tsx --import ./scripts/test-home.mjs --test --test-name-pattern='mode=zcode-' spec-cli/src/sync/coordinator.test.ts`。

- 已停owner的精确物理JSON草稿只在新fence沿stage-worktree observer读取；ZCode另须原精确turn.failed（可保原canonical cancelled），普通暂停的turn.completed/turn.cancelled不在此物理准入，既有正常Git暂停材料政策保持；只此draft可dirty，source/tests/schema/context/index授权外变化拒绝，原目录/index/Native原件不改。physical_draft明确未批准且不是旧Git/final，正常提交后才形成新draft；P0保严格较新来源与ready，P1按真实Native attempt/round只取严格较新物理稿，合法candidate/续审优先；跨父/诊断只豁免程序可信精确overlay投影，其余保护面保持。writer27围栏，升级停旧writer/结算资源、0600 online backup，回滚恢复一致v26库及evidence/Git refs。P0独审准备时，已认证历史稿的明确越界Git状态只拒绝该来源并留证；不能从同一来源捕获Git稿，保当前已校验分析，身份/停止/索引/竞态与P1仍走原门。

- P1完整生成v2/v3在本owner reserve前可认证同一已停来源的真实单稿提交，要求完整index与两次读取的全部受控物理模式和字节匹配HEAD，允许草稿命名空间外的ignored。仅 canonical 托管路径可以用原冻结seed的隔离materialize全文件重建证明，旧runtime slot不作证。冻结`stopped_git_draft`未批准原bytes、原诊断和Git/Native身份，已冻结的请求冷重放按同一材料。其他已reserved、历史v1、P0与物理未提交路径沿原门，writer30围栏v2，writer31围栏v3。

- 全局P1仅分析分区沿正式P0原件和同一冻结计划认证。真实P1与仅分析P0证据分别保存并完全覆盖原计划，封口返修和V1复用重核来源。writer28只追加SELECT1，升级须停稳旧writer、正式结算资源和租约并先做一致online backup；回滚恢复v27一致库及原evidence/Git refs。

- writer33保护P1 V5事实资格；旧V1–V4/缺席、saved/reserved请求不补升级。升级先停稳旧writer/结算资源并做32一致online backup，回滚停新writer并恢复32库及配套evidence/Git refs，禁止删marker。旧批准owner按原source protocol冷验，新返修才绑定V5。

- writer35 钉新初始化分区策略及跨正式 retry 的局部 P0 批准来源。升级停稳旧 writer 并结算资源及租约，保 v34 一致备份。旧分区按原冻结策略继续。回滚恢复对应 v34 库及证据和 Git refs，不删 marker。
