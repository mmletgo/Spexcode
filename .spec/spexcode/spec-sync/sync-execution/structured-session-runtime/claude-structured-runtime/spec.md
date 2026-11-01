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

version5/null 请求沿原 Claude policy、realm 与版本3读取证明执行，不装模型调用timeout timer；数字 version3 原样恢复。显式取消的interrupt、ACK及整组/MCP停止证明与独立stop期限保持。

只接受 `claude:<exact-native-model-id>`，拒绝动态别名、未知 CLI 版本和自动 fallback。固定 Claude Code 2.1.309，经实际 init 和每次 actual API params.model 同时核明确模型；上下文显示后缀不能默默归一化成另一模型。默认或普通 model 字符串继续保留 Codex 含义。CLI 执行器身份与实际模型分开记录；现有 Native 证据的实际模型为 MiniMax-M3，不能标为 Anthropic 模型。

每个正式派发有独立空 cwd、私有配置/home 和专属 session/user UUID，认证与路由透明沿实际 CLI 已有机制；不从环境变量缺失推定失败。同一私有目录、restricted 和外层只读隔离内的官方 auth status 确认可用后才正式派发，只留 loggedIn/authMethod/apiProvider，现有 keychain 或 wrapper 可由 CLI 正常消费。实际确认未认证才 unsupported，不复制凭据或改付费路径。macOS 外层只允许专属 runtime 写入，模型只见 [[claude-frozen-mcp]] 和 StructuredOutput；restricted/空内置工具/独占 MCP 等能力必须由实际 init/API tools 与实际调用再次核验。固定不可调用的 DeferredToolPlaceholder schema 允许存在，真实调用拒绝。

父进程没有任何显式认证/路由键时，允许只从原生用户 settings.json.env 在内存投影 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_BASE_URL；不能复制文件或继承 hooks、MCP、权限、model 或其它设置。父进程只要显式提供其中任一键（包括空值），就使用其自身整组，不逐键混入 profile，避免 token/endpoint 错配。实际值不进入计划、日志或证据；非法 JSON 不回显内容。隔离 auth status 仍是最后认证预检，证据另留非敏感 source。

首轮发送前保存固定请求和专属进程组 receipt，原生 init、user 回显及 promptId 主链按 [[frozen-context-reader]] 绑定。只接受 success + structured_output + 当前 Ajv schema + 完整公开 Native proof，CLI exit0 不代表成功。Claude 原生会缩短过长 cwd 的 history 目录名；只在本专属空 home 按精确 UUID 找唯一 history，不猜私有路径算法，不读取其它任务。

固定 CLI 的 `error_max_structured_output_retries` 只在 exit1、精确原生 result/session/user 回显、原根 user/promptId/prompt、固定 policy/model/API 工具面与整个 CLI/MCP 进程组停止均已核对时，保留为 `structured_output_retries_exhausted` 输出失败。公开 history 的额外未知 user、工具或身份差异不取得此分类；未知 subtype、缺失事件及未停稳仍沿原拒绝/恢复入口。该失败及其原 schema 工具错误不改写、不补数组、不产生 witness/completed/读取 proof；新尝试只能沿原协调预算入口重新派发。完整的同轮失败文件可以离线重新确认此失败，不新建 CLI 或追加 prompt。

已停耗尽路径与成功路径共用精确输出上限续行身份及实际API消费规则：仅已核183字符max_output_tokens_recovery、原promptId、meta/turnCompanion、直接最近max_tokens assistant及无外来source标志可参与来源重建；每条续行须在出现后由新API及其assistant实际消费。普通额外user、113字符structured-output-enforce、伪压缩、未消费或借用旧请求仍拒绝。该兼容只把已核真的终态归为结构输出耗尽，不能产生成功proof或业务通过，不产生成功读取证明。

失败分类还须逐条按实际 API 的完整 base/keep/tail 重建输入，在每次消费时核每个消息摘要的来源。user 只能是当时已观察的原 prompt、已严格配对的原 tool_result或上述严格核真的输出上限续行；CAS 的前置或后置声明、合法 canonical SHA、后续删除或原生 schema 错误都不授予额外正文权限。未知 hash、缺失内容来源、未来回复、错误 base/keep 与新 turn 保守 stale_result，不按位置猜测缺失消息的角色。已停失败与成功证明复用同一流式主链认证：system/compact_boundary、唯一runningTurnSends、logical parent、原parent链完整preserved UUID集合与summary anchor逐项保持；精确同轮摘要仅在实际API输入摘要与原生来源/顺序吻合时参与失败分类，不按compact标志豁免。未知recovery仍拒绝，成功路径原事件检查顺序和完整证明含义保持。

仅在此已停失败分支使用 [[frozen-context-reader]] 的只读来源元数据解释明确非 USER CAS 与已观察的原生 assistant 分片前缀；源 UUID、角色和消费顺序必须分别绑定。并行 tool_result 合并仍逐个以当时已配对的公开 USER 正文验证后才接受前缀摘要。可修复错误码只说明该失败拥有完整原输入来源与停止证明，不代表业务、读取覆盖或输出 schema 通过；已认证压缩摘要的原生string→单text块API别名沿同一摘要门核对，不将摘要变成原prompt、工具回复或读取覆盖；source角色与消费点ordinal仍独立核验。元数据不进入成功 witness 或 proof，也不改原失败文件。

仅在完整已停耗尽身份与API来源认证通过后，可从同一原生StructuredOutput调用与精确配对的is_error tool_result提取固定schema错误字段；不采信模型说明或未配对回复。最多最近5个调用、每调用12个字段，只保留受限JSON路径及类型/必填字段/数组上限错误，不输出prompt、摘要、模型正文或实际业务值；未知错误格式保原耗尽失败但不猜字段。该具体诊断进入原error.message供既有按区重试反馈，不改旧失败原件、结果或schema。

固定 CLI 的 StructuredOutput enforce meta 提醒仅按 [[frozen-context-reader]] 的原始 metadata、唯一同轮 prompt/parent、精确 API 字节与后续 StructuredOutput 消费核验；不能给一般 user 或未核真的内部提示授权，也不扩展已停失败分类。

模型请求不存在的工具后，只有固定 CLI 的精确未派发拒绝、实际 API 工具面及专属 MCP 派发记录共同满足 [[frozen-context-reader]] 时，才允许同轮自行纠正；不增加工具权限或读取覆盖。原失败操作不改成成功，修复后的正式新尝试仍使用原有重试入口。

同一轮的 reader 范围参数拒绝只按 [[frozen-context-reader]] 的读取前精确重算、公开错误与后续 API 可见性规则保留为零覆盖事件；后续完整正确读取仍独立证明，不能因模型纠错授予新范围或放过上下文、正文摘要与权限错误。

完整 result、公开 witness、proof 和整个 CLI/MCP 进程组停止先持久，再发布 completed。completed 重放验证原请求、schema、proof、原 Native history 和停止证据，零新 CLI/API；完整原生 result 已落盘而 completed 尚未写入的窗口可以离线补证。已有只读 partial witness 必须逐字匹配后复用，不能重写后报 EACCES。缺完整终态的 in-progress 只能保留 recovery_required，不能使用 resume 新 prompt 冒充旧轮恢复。

私有 completed JSON 不是另一份结果权威：其 witness 摘要必须等于 proof 的内容寻址 historyDigest，且 session/user/prompt/model/CLI 与固定 plan 一致。最终 text/output 必须等于该权威见证的原生 structured_output；另一个 schema 合法结果也不能替换。同步资源重放与会话完成重放使用相同 output 绑定。

只有 canonical execution 已真实 completed，且完整 thread/user、output/resultDigest、固定 policy、保存 proof 与已验证权威缓存全相等时，完成重放不再查询历史 PID，避免原 PID 被无关进程复用后误降为 pending；不向复用者发信号。running、缺完成状态、缺摘要或缺完成缓存的恢复仍严格查真实 CLI/MCP 停止，不能仅凭文件存在释放资源。effort 必须原样传递受支持的原生值，不能把 minimal 静默替换为 low；不支持则明确拒绝。

取消先沿公共结构化协议撤销发布权，再向专属 stdin 发精确 interrupt，核 request/session/user 对应 ACK；ACK 本身不证明停止。冷取消仅以相同固定 policy 和 PID/startToken/receipt 对专属进程组操作。全部 CLI/MCP 后代消失才 nativeStopped；只 leader 退出、缺receipt、发布/控制失败或进程组未知均保留容量。spawn之后任何所有权持久化失败都进入 cancellation_pending，不从本地异常推断释放。

验收使用外部公开随机 fixture，保留默认大于50K替换负证据、cap后的逐字正证据、64KiB以内全控制字符最坏转义、completed跨调用零新turn重放和真实取消。测试使用隔离数据库，不操作其它会话或服务。

压缩预检单独显式启用：使用约720KiB公开 filler 和不在 prompt 泄露的随机末尾标记，要求本轮全部读取、实际 compact_boundary、原生完整 proof 与 completed 零新调用重放。子进程整组移除四个认证/路由环境键后沿既有 native-user-settings 投影，不保存凭据或修改用户配置。一次预检最多一轮、五分钟；未发生压缩、读取不全或失去实际 API 可见性均不能声明压缩正例。


明确的 version6/native-worktree-v1 是独立执行模式：cwd 必须为创建记录的真实 worktree；read 使用原生 plan 权限且完成不许改动，edit 使用正常可写权限与内置文件/Bash 工具，不施加 frozen MCP 唯一工具、restricted/空工具或只读 Seatbelt。仍隔离运行记录、沿既有认证在内存使用，不输出凭据。精确 init model、原 session/user UUID、原 prompt 回显及 history、成功 structured_output/schema、exit0 和专属整组停止共同绑定结果；不要求分块读取或逐字 API 消费证明，也不借用旧 frozenReadProof。冷完成读取原 evidence 并核 Git 结果，不重启 CLI。旧 claude-frozen-read-only-v1 原约束不变。

已持久 completed 的 worktree 冷重放核原完成缓存、固定请求、Native 身份、schema/输出和原 exit.stopped/close 证据，不再探测历史 PID/PGID，避免无关复用导致伪 stale；running 或未结算仍必须实时证明原进程与后代停止。

worktree 停止与未结算重放共用 [[native-worktree-runtime]] 的正向任务域边界及 boundaryVersion2 追加观察，保留原 failed exit/unknown 原件。旧 Claude plan 缺 workspace 时，stop/replay/settle 都从原不可变 launch.cwd 归一，域缺失明确 pending，不以 stale→failed 释放真实任务孤儿。
