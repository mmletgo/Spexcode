# sync-v1 纯契约核心

本目录从 Markdown 推导契约、引用图、声明覆盖及影响范围；禁止导入文件读取、Git、仓库根初始化或执行调度。调用方提供源文本及 `context.files`，未提供文件时只能报告绑定未验证。

- 解析允许 raw/REQ 草稿；`validateContractGraph` 默认检查完成范围，`mode: draft` 只检查已经声明的结构。条件文本必须经过独立语义审查。
- `depends-on` 与引用来源必须无环；合法状态转移、STEP 导航循环不因此报来源循环。GAP 沿来源、依赖、规则使用、AC 覆盖及 STEP.next→TR 处置引用扩散；流程归属、FLOW.steps 和 next→STEP/STATE 导航不扩散。
- 完成模式要求 STEP 显式 EVENT 依赖/来源有匹配事件的 next、depends-on 或直接 source TR；草稿允许待细化。不从正文推断状态域，也不自动关联同事件全部 TR，集合完整性仍需语义审查。
- `related` 不算治理，覆盖仅 `declared/bound/missing`；运行通过状态属于证据层。每节点最多治理一个文件，跨文件职责拆子节点。
- 验证：仓库根 `npm run build -w @spexcode/spec-core`；`node --test packages/spec-core/dist/contracts/contracts.test.js`；`npx eslint packages/spec-core/src/contracts packages/spec-core/src/spec-source.ts packages/spec-core/src/specs.ts`。禁止运行完整测试套件。
