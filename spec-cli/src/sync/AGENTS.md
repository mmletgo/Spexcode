# 持续同步编排

- 本目录复用 session 原生工作树执行与 spec-core/contracts；不自行维护第二份契约图或会话执行器。旧受限结构化策略只按原绑定恢复历史任务。
- Dashboard 保存 Spec 立即进入 spec→code；外部文件保存/index变化只观察，Git 提交冻结 HEAD 后才派发。已采纳的真实同步发布先消费为基线，避免回声或污染下次提交方向。
- code→spec 只装配已审 Spec，source/test 的 Git path、mode、OID 与 absence 必须不变；不能调用代码生成器修绿验收。
- 分区复用 partitioning/partition-execution 的唯一计划，共用 operation、fence、预算与最终 candidate/journal/receipt。任务只交付变更 Spec、相关接口和明确目标；Agent 在独立 worktree 自由读取，不以分块读取或逐字消费证明作为同步门禁。
- 共享分区调度每项结束均须真正让出事件循环，缓存、末项与失败亦然；让原心跳与控制运行，不延长租约或弱化fence。
- 每阶段绑定真实 seed commit/tree：分析使用 composed，细化包含已审祖先，构建包含已审 Spec，独审使用实际候选。缓存同时核验实际可见 tree；不能只传原 HEAD 而漏掉受控 Spec 修改，也不能混入提交后的 index/WIP。
- 实现 Agent 在工作树真实修改、测试并正常提交；候选从实际 Git 对象差量导入。程序检查写范围、CAS、原测试和契约演进，生成摘要或自报补丁不能替代实际修改。
- 模型临时业务行由 `CONTRACT_COLUMNS` 渲染唯一 Markdown；raw/摘要由程序复制，JSON 仅是执行证据。
- 生成和独立评审使用不同会话。输入、候选和检查结果均按内容摘要绑定；未决 GAP 只阻塞依赖闭包。
- P1独审共用生成侧owner范围；仅要求冻结owner改写的repair或未知ID绑定须给具体拒因重审。原JSON/Git稿、候选与原Native生成身份冷验相同后只续独审；域内语义repair仍续生成，旧请求字段不追补。
- 状态派发 STEP 显式关联实际 TR；next→TR 是依赖，next→STEP/STATE 仍为导航，独立审查核对派发集合与步骤声明范围。
- `readyIds` 是声明级可推进；完整流程使用 `readyFlowIds`，`blockedFlows` 解释受阻步骤/GAP，不向独立子项回传父阻塞。
- 普通无冲突实现约定用 code 来源沿用；GAP 仅承载重大业务未知/意图冲突。内部已结算 seed 只作诊断，新请求/完整独立审查必须重新绑定，不能升格为 raw 或事实。
- `complete` 仅表示当前细化阶段通过，不代表代码、测试、落盘或全产品已同步。
- 细化与契约演化验证：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-*.test.ts spec-cli/src/sync/contract-evolution.test.ts spec-cli/src/sync/frozen-contracts.test.ts`；行为分析与实现验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/code-behavior.test.ts spec-cli/src/sync/generation.test.ts`；`npx eslint spec-cli/src/sync/`；`npm run typecheck`。
- V3 Docker 验收由 `verification-executor.ts` 运行；仅接收可信冻结政策和不含 Git/宿主依赖的 export。检查点通过调用者持久保存，`recovery_required` 不释放未知容器的容量；不使用宿主 fallback。
- 执行器单测：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.test.ts`；真实 Linux/arm64 Docker 验收：先准备测试中冻结的镜像，再 `SPEX_DOCKER_VERIFICATION_TEST=1 npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.docker.test.ts`。`SPEX_VERIFICATION_EVIDENCE_DIR` 可指定已存在的外部证据目录；未设置时用系统临时目录，不把运行证据写入源码。

- 持久协调使用 `operation-types.ts` 共享身份，原source/composed/candidate分离；所有写入走store动作门禁及既有protocol事务，native/Git/FS副作用放事务外。
- `sync resources recover` 仅结算显式 operation/input 的既有 owned 资源；普通 `sync recover` 还可回放 journal。资源清理不授予来源连续性，来源不匹配仍不得 resume/adopt。
- 存储验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts packages/session-protocol/src/adopter-seams.test.ts`。

- P2 快照/候选仅操作明确 commonDir 的 Git 对象及私有保活 refs，禁用元数据 fsmonitor/reference hooks；开发/交付提交不可照搬禁 hooks。原输入与 ComposedInputRef 分开；实际模型 diff 和最终 apply diff 分开。
- 快照/候选针对验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/snapshot-candidate.test.ts`；build 后 `npm run typecheck`、`npx eslint spec-cli/src/sync/{snapshot,composition,candidate,snapshot-candidate.test}.ts`。

- operation固定请求选择；同request/retry先沿原绑定，真正新操作取显式选择或版本化`sync.model`，再按工作流缺省（native为`claude:default`，历史frozen为sol）。旧operation缺字段仍固定sol，不回写。换模型只经新操作或显式 retryOf；resume/recover 不换模型。原生工作树任务使用 sync-tools-v3 固定工作流，旧 v1/v2 只恢复原请求；不因注入 runner 降级生产策略。

- ZCode使用`zcode:default`或`zcode:<provider-id>/<model>`，模型/别名交SDK解析，实际每轮选择另行留证；与Claude共用版本化原生工作树执行、队列和资源桥；换provider仍须新操作/正式retryOf，不自动fallback。旧v4只读策略和原生读取证明仅用于其历史请求。

- 原生工作树使用结构化策略 v6，sync v27 组件 marker 拒绝旧 writer；ZCode 新 read 请求冻结精准 ExitPlanMode denylist 与 NativePlan v2，旧资源/记录及仅 reserved dispatch 的字段缺席保持，后者只以完整请求摘要确证；内部创建键首建保留上游冻结字段并严格验策略，不能恢复时补默认。旧数字与 null 的只读 v1–v5 原样恢复。unlimited 模型调用期限为 null，创建、租约、stop/close 及 Docker 期限仍独立有限。升级先停全部旧 backend/queue 并结算资源、备份数据库；回滚恢复升级前备份，不能只删 marker 或改工具描述。
- 新P1按owner显式冻结elaboration-draft-v1，精确schema在同seed只读sidecar，v6 edit只写真实Git临时草稿并正常提交、小summary回执；程序读指定blob后再JSON/schema/renderer/独审。失败正文留Git refs，checkpoint只记身份和errors并保留原finding定位及severity，旧缺席不补写；诊断不进入raw role/业务candidate；跨父输入只迁draft不迁旧树，accept仍核完整摘要及冷Git/schema/最终正文渲染绑定，原source tag不向legacy补签；仅验证时允许保留hooks的正常空提交，不造业务diff。已冻结/仅reserved旧请求不补协议。该持久变更由writer22围栏保护；精准回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-draft.test.ts`。
- 格式/schema拒绝的final仅经adapter原请求/身份/停止认证后保存为可选rejectedOutput诊断；历史只读请求的原文ref/SHA与完整正文进入同owner下一prompt，不能填成功output或候选、继承accept、读取thinking或追补旧缺席。review失败保留此前合法generation和candidate。 仅格式失败续审沿原P1/null扩域证明保partition计划及候选，认证原Native refs只给精确失败组的只读诊断seed；兄弟accept仍核完整原请求，ZCode policy按saved原字段重建，不追补缺席。


- 跨boot显式continuity用offline `sync source-continuity`，先停稳并清资源，核原op/input/revision、enabled原字节SHA与三旧dev双哈希；commonDir共享enable/register锁。v23拒旧writer，成功仅暂停原PhysicalControl并登记v2；旧op/input/CAS不改。私有runtime/sync/continuity-evidence保原enabled及proof链，不依赖DB-only GC；回滚配套恢复DB/启用原件/证据。正常身份只投影已证明哈希并保actual branch/path，失效不fallback；raw仅显式证明及资源清理可用。

- v21 checkpoint的typed artifacts随JSON wrapper一次动作保活，raw只作untrusted_final；读取须核真实失败round/Native身份，旧无role引用不补写，未知损坏JSON仍报错。升级走online backup，回滚恢复一致旧库与evidence，不能删marker。

- v22登记owner Git草稿续修与已证停止RPC故障的显式准入。草稿只存Git对象身份，不借raw权限；旧缺席字段不追补，已接受候选仍须原绑定。只有现有停止协议确证并结算资源后，运行中的有效fence才能续修，用户暂停/取消和未知停止不自动重启。 缺final的typed格式失败可独立保Git；旧无witness及安全暂停稿只在新有效attempt按原request/owner/seed/schema、完整source/tests对象及正式stop/removed观察最新正常Git，旧record/checkpoint不补签，普通暂停不赋格式码。 明确已停CLI错误终态只授未批准Git材料，不借格式或success角色；可选native-protocol.jsonl只记安全元数据，冷验不追补。

- 新P0的contextTransport:git-json-v1只在原阶段checkpoint与派发均缺席时冻结；旧字段缺席保持legacy。完整任务/诊断/原errors/独审分析在同owner/purpose只读Git context sidecar，业务摘要及accepted早退保持；临时协议文件不是业务checkedPaths。writer25仅追加SELECT1，升级须停稳旧writer、online backup，回滚恢复一致v24库及evidence/Git refs，不删marker。

- writer23围栏保护新P0持久协议；升级前停稳旧writer/结算或保留资源，正常online backup迁移，回滚恢复一致旧库及evidence，不删marker。新P0按attempt显式冻结code-behavior-draft-v1，analyze/review复用stage-worktree的同owner/purpose Git草稿与只读schema；格式失败续原JSON，review格式、引用绑定或覆盖协议错误保已校验分析与完整拒因，仅续原review；完整合法独审的业务finding/repair仍续原analysis并重新独审。旧reserved不补协议；认证旧Native CAS仅作新seed临时材料，不伪造历史Git稿。仅认证且命中原变更owner/affectedIds的P1后置语义质疑才触发新analysis与独审；格式失败继续原文件及失败环节，不改kind或扩授权。

- 完整初始化资格不等于所有源码曾被写过：未写path可用精确已采纳owner Spec、正式settled receipt、scope及三份对象一致证明只读初始化，缺binding/null保持；已有非null头不fallback，未审owner/源码漂移拒绝。规划回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/planning.test.ts`。

- 新Claude/ZCode native-worktree请求只在真正新记录/资源冻结nativeConfiguration:cli-config-v1；原saved及仅reserved请求缺席保持并核完整原摘要。default/不透明模型由原生CLI配置与每轮init核实，不维护CLI版本/模型名册。新sync请求在冻结前省略内部默认high，已有Native原件按原effort或缺席冷验，standalone显式effort保持；派发和coordinator原件重验共用pinSyncNativeRequest。writer24只追加SELECT1；升级停稳旧backend/queue并结算资源、online backup后迁移，回滚停新writer并恢复升级前一致DB及evidence，禁止删marker或改签旧plan。针对回归：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/session-native-configuration.test.ts spec-cli/src/sync/native-run.test.ts spec-cli/src/sync/store.test.ts`。

- ZCode最新失败Git稿沿既有严格较新来源/currentfence材料接缝；旧cancelled/新failed均核formalstop+removed全值及原公开Native身份，冷观察不改旧原件或读success history，不附failedWorktree/授自动重试。writer26保护新准入，升级先停旧writer/结算资源、online backup，回滚恢复一致v25库及evidence/Git refs。定向材料回归：`npx tsx --import ./scripts/test-home.mjs --test --test-name-pattern='mode=zcode-' spec-cli/src/sync/coordinator.test.ts`。

- 已停owner的精确物理JSON草稿只在新fence沿stage-worktree observer读取；只此draft可dirty，source/tests/schema/context/index授权外变化拒绝，原目录/index/Native原件不改。physical_draft明确未批准且不是旧Git/final，正常提交后才形成新draft；P0保严格较新来源与ready，P1保Git优先。writer27围栏，升级停旧writer/结算资源、0600 online backup，回滚恢复一致v26库及evidence/Git refs。
