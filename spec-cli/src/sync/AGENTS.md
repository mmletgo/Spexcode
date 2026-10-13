# 持续同步编排

- 本目录复用 session 受限结构化执行与 spec-core/contracts；不自行维护第二份契约图或会话执行器。
- 模型临时业务行由 `CONTRACT_COLUMNS` 渲染唯一 Markdown；raw/摘要由程序复制，JSON 仅是执行证据。
- 生成和独立评审使用不同会话。输入、候选和检查结果均按内容摘要绑定；未决 GAP 只阻塞依赖闭包。
- 状态派发 STEP 显式关联实际 TR；next→TR 是依赖，next→STEP/STATE 仍为导航，独立审查核对派发集合与步骤声明范围。
- `readyIds` 是声明级可推进；完整流程使用 `readyFlowIds`，`blockedFlows` 解释受阻步骤/GAP，不向独立子项回传父阻塞。
- 普通无冲突实现约定用 code 来源沿用；GAP 仅承载重大业务未知/意图冲突。内部已结算 seed 只作诊断，新请求/完整独立审查必须重新绑定，不能升格为 raw 或事实。
- `complete` 仅表示当前细化阶段通过，不代表代码、测试、落盘或全产品已同步。
- 针对性验证：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-*.test.ts`；`npx eslint spec-cli/src/sync/`；`npm run typecheck`。
- V3 Docker 验收由 `verification-executor.ts` 运行；仅接收可信冻结政策和不含 Git/宿主依赖的 export。检查点通过调用者持久保存，`recovery_required` 不释放未知容器的容量；不使用宿主 fallback。
- 执行器单测：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.test.ts`；真实 Linux/arm64 Docker 验收：先准备测试中冻结的官方 Node 镜像，再 `SPEX_DOCKER_VERIFICATION_TEST=1 npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-executor.docker.test.ts`。`SPEX_VERIFICATION_EVIDENCE_DIR` 可指定已存在的外部证据目录；未设置时用系统临时目录，不把运行证据写入源码。

- 持久协调使用 `operation-types.ts` 共享身份，原source/composed/candidate分离；所有写入走store动作门禁及既有protocol事务，native/Git/FS副作用放事务外。
- 存储验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts packages/session-protocol/src/adopter-seams.test.ts`。

- P2 快照/候选仅操作明确 commonDir 的 Git 对象及私有保活 refs，禁用元数据 fsmonitor/reference hooks；开发/交付提交不可照搬禁 hooks。原输入与 ComposedInputRef 分开；实际模型 diff 和最终 apply diff 分开。
- 快照/候选针对验证：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/snapshot-candidate.test.ts`；build 后 `npm run typecheck`、`npx eslint spec-cli/src/sync/{snapshot,composition,candidate,snapshot-candidate.test}.ts`。
