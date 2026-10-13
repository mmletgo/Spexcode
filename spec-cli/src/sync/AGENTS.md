# 持续同步编排

- 本目录复用 session 受限结构化执行与 spec-core/contracts；不自行维护第二份契约图或会话执行器。
- 模型临时业务行由 `CONTRACT_COLUMNS` 渲染唯一 Markdown；raw/摘要由程序复制，JSON 仅是执行证据。
- 生成和独立评审使用不同会话。输入、候选和检查结果均按内容摘要绑定；未决 GAP 只阻塞依赖闭包。
- `readyIds` 是声明级可推进；完整流程使用 `readyFlowIds`，`blockedFlows` 解释受阻步骤/GAP，不向独立子项回传父阻塞。
- `complete` 仅表示当前细化阶段通过，不代表代码、测试、落盘或全产品已同步。
- 针对性验证：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/elaboration-*.test.ts`；`npx eslint spec-cli/src/sync/`；`npm run typecheck`。
