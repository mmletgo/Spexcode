---
title: Claude Code 原生结构化执行
status: active
hue: 175
desc: 在同一结构化会话管线中运行隔离的Claude Code，严格核原生身份、公开可见性和专属进程组终态。
code:
  - spec-cli/src/claude-structured.ts
related:
  - spec-cli/src/claude-structured.test.ts
  - spec-cli/src/claude-structured.native.test.ts
  - spec-cli/src/frozen-context.ts
  - spec-cli/src/session-structured.ts
  - spec-cli/src/session-structured-policy.ts
---
# Claude Code 原生结构化执行

## raw source

用户原话：“用claude code或grok build来做规格树生成”。承接 [[structured-session-runtime]] 的可追踪、可恢复结构化结果接缝与 [[structured-readonly-policy]] 的冻结只读约束；本节点实现其中 Claude Code 执行器，不派生另一条业务管线。

## expanded spec

只接受 `claude:<exact-native-model-id>`，拒绝动态别名、未知 CLI 版本和自动 fallback。固定 Claude Code 2.1.309，经实际 init 和每次 actual API params.model 同时核明确模型；上下文显示后缀不能默默归一化成另一模型。默认或普通 model 字符串继续保留 Codex 含义。CLI 执行器身份与实际模型分开记录；现有 Native 证据的实际模型为 MiniMax-M3，不能标为 Anthropic 模型。

每个正式派发有独立空 cwd、私有配置/home 和专属 session/user UUID，认证与路由透明沿实际 CLI 已有机制；不从环境变量缺失推定失败。同一私有目录、restricted 和外层只读隔离内的官方 auth status 确认可用后才正式派发，只留 loggedIn/authMethod/apiProvider，现有 keychain 或 wrapper 可由 CLI 正常消费。实际确认未认证才 unsupported，不复制凭据或改付费路径。macOS 外层只允许专属 runtime 写入，模型只见 [[claude-frozen-mcp]] 和 StructuredOutput；restricted/空内置工具/独占 MCP 等能力必须由实际 init/API tools 与实际调用再次核验。固定不可调用的 DeferredToolPlaceholder schema 允许存在，真实调用拒绝。

父进程没有任何显式认证/路由键时，允许只从原生用户 settings.json.env 在内存投影 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_BASE_URL；不能复制文件或继承 hooks、MCP、权限、model 或其它设置。父进程只要显式提供其中任一键（包括空值），就使用其自身整组，不逐键混入 profile，避免 token/endpoint 错配。实际值不进入计划、日志或证据；非法 JSON 不回显内容。隔离 auth status 仍是最后认证预检，证据另留非敏感 source。

首轮发送前保存固定请求和专属进程组 receipt，原生 init、user 回显及 promptId 主链按 [[frozen-context-reader]] 绑定。只接受 success + structured_output + 当前 Ajv schema + 完整公开 Native proof，CLI exit0 不代表成功。Claude 原生会缩短过长 cwd 的 history 目录名；只在本专属空 home 按精确 UUID 找唯一 history，不猜私有路径算法，不读取其它任务。

固定 CLI 的 `error_max_structured_output_retries` 只在 exit1、精确原生 result/session/user 回显、原根 user/promptId/prompt、固定 policy/model/API 工具面与整个 CLI/MCP 进程组停止均已核对时，保留为 `structured_output_retries_exhausted` 输出失败。公开 history 的额外未知 user、工具或身份差异不取得此分类；未知 subtype、缺失事件及未停稳仍沿原拒绝/恢复入口。该失败及其原 schema 工具错误不改写、不补数组、不产生 witness/completed/读取 proof；新尝试只能沿原协调预算入口重新派发。完整的同轮失败文件可以离线重新确认此失败，不新建 CLI 或追加 prompt。

失败分类还须逐条按实际 API 的完整 base/keep/tail 重建输入，在每次消费时核每个消息摘要的来源。user 只能是当时已观察的原 prompt 或已严格配对的原 tool_result；CAS 的前置或后置声明、合法 canonical SHA、后续删除或原生 schema 错误都不授予额外正文权限。未知 hash、缺失内容来源、未来回复、错误 base/keep 与新 turn 保守 stale_result，不按位置猜测缺失消息的角色。此分支仍拒绝 compact/recovery 用户伴随输入，成功路径的完整证明含义不变。

模型请求不存在的工具后，只有固定 CLI 的精确未派发拒绝、实际 API 工具面及专属 MCP 派发记录共同满足 [[frozen-context-reader]] 时，才允许同轮自行纠正；不增加工具权限或读取覆盖。原失败操作不改成成功，修复后的正式新尝试仍使用原有重试入口。

同一轮的 reader 范围参数拒绝只按 [[frozen-context-reader]] 的读取前精确重算、公开错误与后续 API 可见性规则保留为零覆盖事件；后续完整正确读取仍独立证明，不能因模型纠错授予新范围或放过上下文、正文摘要与权限错误。

完整 result、公开 witness、proof 和整个 CLI/MCP 进程组停止先持久，再发布 completed。completed 重放验证原请求、schema、proof、原 Native history 和停止证据，零新 CLI/API；完整原生 result 已落盘而 completed 尚未写入的窗口可以离线补证。已有只读 partial witness 必须逐字匹配后复用，不能重写后报 EACCES。缺完整终态的 in-progress 只能保留 recovery_required，不能使用 resume 新 prompt 冒充旧轮恢复。

私有 completed JSON 不是另一份结果权威：其 witness 摘要必须等于 proof 的内容寻址 historyDigest，且 session/user/prompt/model/CLI 与固定 plan 一致。最终 text/output 必须等于该权威见证的原生 structured_output；另一个 schema 合法结果也不能替换。同步资源重放与会话完成重放使用相同 output 绑定。

只有 canonical execution 已真实 completed，且完整 thread/user、output/resultDigest、固定 policy、保存 proof 与已验证权威缓存全相等时，完成重放不再查询历史 PID，避免原 PID 被无关进程复用后误降为 pending；不向复用者发信号。running、缺完成状态、缺摘要或缺完成缓存的恢复仍严格查真实 CLI/MCP 停止，不能仅凭文件存在释放资源。effort 必须原样传递受支持的原生值，不能把 minimal 静默替换为 low；不支持则明确拒绝。

取消先沿公共结构化协议撤销发布权，再向专属 stdin 发精确 interrupt，核 request/session/user 对应 ACK；ACK 本身不证明停止。冷取消仅以相同固定 policy 和 PID/startToken/receipt 对专属进程组操作。全部 CLI/MCP 后代消失才 nativeStopped；只 leader 退出、缺receipt、发布/控制失败或进程组未知均保留容量。spawn之后任何所有权持久化失败都进入 cancellation_pending，不从本地异常推断释放。

验收使用外部公开随机 fixture，保留默认大于50K替换负证据、cap后的逐字正证据、64KiB以内全控制字符最坏转义、completed跨调用零新turn重放和真实取消。测试使用隔离数据库，不操作其它会话或服务。

压缩预检单独显式启用：使用约720KiB公开 filler 和不在 prompt 泄露的随机末尾标记，要求本轮全部读取、实际 compact_boundary、原生完整 proof 与 completed 零新调用重放。子进程整组移除四个认证/路由环境键后沿既有 native-user-settings 投影，不保存凭据或修改用户配置。一次预检最多一轮、五分钟；未发生压缩、读取不全或失去实际 API 可见性均不能声明压缩正例。
