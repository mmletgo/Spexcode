# 持续同步编排

- 本目录复用 session 原生工作树执行与 spec-core/contracts；不自行维护第二份契约图或会话执行器。旧受限结构化策略只按原绑定恢复历史任务。
- Dashboard 保存 Spec 立即进入 spec→code；外部文件保存/index变化只观察，Git 提交冻结 HEAD 后才派发。已采纳的真实同步发布先消费为基线，避免回声或污染下次提交方向。
- code→spec 只装配已审 Spec，source/test 的 Git path、mode、OID 与 absence 必须不变；不能调用代码生成器修绿验收。
- 分区复用 partitioning/partition-execution 的唯一计划，共用 operation、fence、预算与最终 candidate/journal/receipt。任务只交付变更 Spec、相关接口和明确目标；Agent 在独立 worktree 自由读取，不以分块读取或逐字消费证明作为同步门禁。
- 每阶段绑定真实 seed commit/tree：分析使用 composed，细化包含已审祖先，构建包含已审 Spec，独审使用实际候选。缓存同时核验实际可见 tree；不能只传原 HEAD 而漏掉受控 Spec 修改，也不能混入提交后的 index/WIP。
- 实现 Agent 在工作树真实修改、测试并正常提交；候选从实际 Git 对象差量导入。程序检查写范围、CAS、原测试和契约演进，生成摘要或自报补丁不能替代实际修改。
- 模型临时业务行由 `CONTRACT_COLUMNS` 渲染唯一 Markdown；raw/摘要由程序复制，JSON 仅是执行证据。
- 生成和独立评审使用不同会话。输入、候选和检查结果均按内容摘要绑定；未决 GAP 只阻塞依赖闭包。
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

- 模型选择冻结于 operation：新操作缺少显式选择或既有绑定时取版本化 `sync.model`，再缺省 sol；旧 operation 缺字段仍固定 sol。换模型只经新操作或显式 retryOf；resume/recover 不换模型。原生工作树任务使用 sync-tools-v3 固定工作流，旧 v1/v2 只恢复原请求；不因注入 runner 降级生产策略。

- ZCode模型使用 `zcode:<provider-id>/<exact-model-id>`，与 Claude 共用版本化原生工作树执行、队列和资源桥；换provider仍须新操作/正式retryOf，不自动fallback。旧v4只读策略和原生读取证明仅用于其历史请求。

- 原生工作树使用结构化策略 v6，sync v20 组件 marker 拒绝旧 writer；ZCode 新 read 请求冻结精准 ExitPlanMode denylist 与 NativePlan v2，旧资源/记录及仅 reserved dispatch 的字段缺席保持，后者只以完整请求摘要确证；内部创建键首建保留上游冻结字段并严格验策略，不能恢复时补默认。旧数字与 null 的只读 v1–v5 原样恢复。unlimited 模型调用期限为 null，创建、租约、stop/close 及 Docker 期限仍独立有限。升级先停全部旧 backend/queue 并结算资源、备份数据库；回滚恢复升级前备份，不能只删 marker 或改工具描述。
- 格式/schema拒绝的final仅经adapter原请求/身份/停止认证后保存为可选rejectedOutput诊断；原文ref/SHA与完整正文进入同owner下一prompt，不能填成功output或候选、继承accept、读取thinking或追补旧缺席。review失败保留此前合法generation和candidate。

- 跨boot显式continuity用offline `sync source-continuity`，先停稳并清资源，核原op/input/revision、enabled原字节SHA与三旧dev双哈希；commonDir共享enable/register锁。v20拒旧writer，成功仅暂停原PhysicalControl并登记v2；旧op/input/CAS不改。私有runtime/sync/continuity-evidence保原enabled及proof链，不依赖DB-only GC；回滚配套恢复DB/启用原件/证据。正常身份只投影已证明哈希并保actual branch/path，失效不fallback；raw仅显式证明及资源清理可用。
