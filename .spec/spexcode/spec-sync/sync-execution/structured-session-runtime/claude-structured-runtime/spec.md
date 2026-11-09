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

用户原话：“用claude code或grok build来做规格树生成”；“不应该限制cli的版本和所使用的模型!我希望优先使用claude code(也不要限制它接的baseurl和模型)”。承接 [[structured-session-runtime]] 的可追踪、可恢复结构化结果接缝与 [[structured-readonly-policy]] 的冻结只读约束；本节点实现其中 Claude Code 执行器，不派生另一条业务管线。

## expanded spec

原生 worktree 只从同一原生 CLI `result.modelUsage` 读取计数。按字段跨全部模型汇总安全非负整数，分别保留未缓存输入、输出、缓存读和缓存创建；缺值、非法值或超安全整数范围的分量缺席，明确的零保留。仅以该轮固定请求的首个原生会话计数范围解释，涵盖 Claude Code query pipeline 报告的模型调用。规范化计数随本轮 result 快照保存，在精确原生终态和停止认证后才交给 [[structured-session-runtime]]。不使用只含主循环的 usage、价格、单消息或旧历史推估，不保留原始 modelUsage、模型分组、价格或其它 provider 字段。

工作区schema拒绝仅在原plan/prompt/model/turn/终态与stop认证后保留不可信final诊断：success的structured_output schema拒绝可保存其原生JSON值的确定JSON表示；重试耗尽仅取最后一份已严格配对、被本schema拒绝的StructuredOutput input，不提取thinking/任意assistant文本。标明native_json表示与原请求/schema身份，仍不填成功output或写completed，原错误分类不变；没有可证final则缺席。

version5/null 请求沿原 Claude policy、realm 与版本3读取证明执行，不装模型调用timeout timer；数字 version3 原样恢复。显式取消的interrupt、ACK及整组/MCP停止证明与独立stop期限保持。

缺少 `nativeConfiguration` 的既有请求保持原 exact 语义：只接受 `claude:<exact-native-model-id>`，拒绝动态别名、未知 CLI 版本和自动 fallback。固定 Claude Code 2.1.309，经实际 init 和每次 actual API params.model 同时核明确模型；上下文显示后缀不能默默归一化成另一模型。默认或普通 model 字符串继续保留 Codex 含义。CLI 执行器身份与实际模型分开记录；现有 Native 证据的实际模型为 MiniMax-M3，不能标为 Anthropic 模型。

上述旧冻结派发有独立空 cwd、私有配置/home 和专属 session/user UUID，认证与路由透明沿实际 CLI 已有机制；不从环境变量缺失推定失败。同一私有目录、restricted 和外层只读隔离内的官方 auth status 确认可用后才正式派发，只留 loggedIn/authMethod/apiProvider，现有 keychain 或 wrapper 可由 CLI 正常消费。实际确认未认证才 unsupported，不复制凭据或改付费路径。macOS 外层只允许专属 runtime 写入，模型只见 [[claude-frozen-mcp]] 和 StructuredOutput；restricted/空内置工具/独占 MCP 等能力必须由实际 init/API tools 与实际调用再次核验。固定不可调用的 DeferredToolPlaceholder schema 允许存在，真实调用拒绝。

上述旧请求在父进程没有任何显式认证/路由键时，允许只从原生用户 settings.json.env 在内存投影 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY、CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_BASE_URL；不能复制文件或继承 hooks、MCP、权限、model 或其它设置。父进程只要显式提供其中任一键（包括空值），就使用其自身整组，不逐键混入 profile，避免 token/endpoint 错配。实际值不进入计划、日志或证据；非法 JSON 不回显内容。隔离 auth status 仍是最后认证预检，证据另留非敏感 source。

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


明确的 version6/native-worktree-v1 是独立执行模式：cwd 必须为创建记录的真实 worktree；read 使用原生 plan 权限且完成不许改动，edit 使用正常可写权限与内置文件/Bash 工具，不施加 frozen MCP 唯一工具、restricted/空工具或只读 Seatbelt。仍隔离运行记录，不输出凭据。缺少新配置标记时保持旧认证投影与精确模型语义；原 session/user UUID、原 prompt 回显及 history、成功 structured_output/schema、自然 exit0 或下述精确受控非零退出、专属整组停止共同绑定结果；不要求分块读取或逐字 API 消费证明，也不借用旧 frozenReadProof。冷完成读取原 evidence 并核 Git 结果，不重启 CLI。旧 claude-frozen-read-only-v1 原约束不变。

macOS 的新 worktree 版本探测与执行子进程沿 [[native-worktree-runtime]] 保护实际共享 Git config 及其锁文件；仍使用原生 CLI、同一参数与本机配置。冻结只读和历史结果的认证保持原协议。

新建 worktree 请求显式冻结 `nativeConfiguration: cli-config-v1`，对应 Native plan/version2，不能替已有 saved、reserved 或旧 plan1 补标记或重签。此分支只用 `claude:` 路由执行器：`claude:default` 完全省略 `--model`，由 CLI 现有配置选择；其它非空、无 NUL 的后缀原串作为单个 argv 交给 CLI，接受别名、供应商路径及上下文后缀，不维护模型、供应商、baseurl 或 CLI 版本名册，不拼 shell。CLI 实际 `--version` 和 binaryDigest 只记录本轮观测；旧未完成请求不能借新配置语义在另一 binary 冒充执行。

新分支继承正常进程环境和 CLI 用户/项目/managed 配置解析；仅按现有 harness 身份枚举移除父会话的 SPEXCODE_SESSION_ID 与各 sessionEnvVar，再注入本轮创建记录的 SPEXCODE_SESSION_ID，避免原生 hooks/工具写入父会话。认证、provider/baseurl、SPEXCODE_HOME 和数据库路由等非身份环境仍正常继承；不设置私有 CLAUDE_CONFIG_DIR，不清空 setting-sources，不投影或读取 settings/credentials，不探测、改写、保存或打印认证值和实际 baseurl；CLI 自己沿原认证、替代供应商及路由执行。只隔离本轮 tmp/debug、进程 receipt 与公开证据；read/edit 权限、JSON schema 与原生内置工具模式保持，不添加冻结分块读取约束。配置来源可记为 native，协议缺少所需真实字段仍如实失败。

本轮唯一 init 的非空 model 是 CLI 解析的选择表达式，沿既有 plan.resolvedModel 原串保存；plan.requestedModel 保留原请求选择，不回写 execution.model。init 选择表达式与各 api-request.model 的实际 wire 字符串属于不同命名空间：后者只按其原 requestId、同轮公开 history 来源及既有 historyDigest 认证，不要求与 init 字符串相等，也不要求各 API 请求的 wire model 相同；不去后缀、映射别名或猜供应商模型。schema 耗尽仍须以每个 assistant.requestRef 绑定已出现的实际 API request，再核原工具调用/回复及 schema 错误，不能因模型命名空间分离放宽身份或工具配对；缺实际 requestId/model、原摘要不符仍拒绝。新配置语义的冷恢复保留两类原观测各自绑定；旧 plan1 exact 语义不变，不用新规则重新解释其成功缓存。重复 init、外来 session/user、原 prompt/echo/result/exit 或缓存身份差异仍拒绝。调用前固定 CLI 实际配置根（继承非空 CLAUDE_CONFIG_DIR，未设或空串时使用 HOME/.claude），停止后只在其 projects 一层目录按本轮精确 UUID 查唯一原生 history；不扫全 home、不读取其它 session 正文。复用现有公开 history 过滤器，过滤私密块后以内容摘要封存本轮 public-history.json，completed 绑定其原 plan/init/echo/result/exit/prompt 与该摘要。冷完成仅认证本轮保存的公开 snapshot，不重读今天用户配置/认证、CLI 版本或全局 history，不启动新 CLI/API。缺少完整终态的旧请求仍只能停止并保留恢复债务，不能追加 prompt。

已持久 completed 的 worktree 冷重放核原完成缓存、固定请求、Native 身份、schema/输出和原 exit.stopped/close 证据，不再探测历史 PID/PGID，避免无关复用导致伪 stale；running 或未结算仍必须实时证明原进程与后代停止。

worktree 停止与未结算重放共用 [[native-worktree-runtime]] 的正向任务域边界及 boundaryVersion2 追加观察，保留原 failed exit/unknown 原件。进程观察沿同一异步有界接缝等待；100ms采样仅保一个在途任务，首个终态/取消/协议失败窗口固定原15秒绝对截止并停止定时采样，既有10秒终止timer不变；finally等待在途采样结算，再在同一截止内核最终停止与清理流。普通采样整次最多10秒，停止后不再领新采样预算；不能以最后一次观察重置停止期限。收尾不得留下迟到写入或未处理的Promise拒绝；sealed缺final认证的原receipt门与已completed冷读不活探历史PID的语义保持。旧 Claude plan 缺 workspace 时，stop/replay/settle 都从原不可变 launch.cwd 归一，域缺失明确 pending，不以 stale→failed 释放真实任务孤儿。

已启动的 v6 Claude 周期采样遇到首个 cancellation_pending 时保留运行状态、容量和已证实的进程关联。按原 100ms 单在途节奏在同一 10 秒绝对截止内重观察，连续 pending 共用首次截止，完整健康样本结束本段恢复。原生 result 或显式取消立即启用原停止门并接管结算。其后到达的在途周期采样回报交由新鲜停止验证处理。运行中恢复到期或其它采样异常保留首诊断，按精确 receipt 的原终止窗口收尾。已证实停止才进入原失败结算，停止不明时以 cancellation_pending 保留首诊断与资源债务。内部失败收尾不记外部 interrupt。诊断仅输出固定周期观察标签、pending/recovered/expired 与 elapsedMs，不写协议错误或正文。

原生 worktree v6 的 error_max_structured_output_retries 在原请求/Native session/user/promptId、实际 model、exit1/is_error 与真实停止均绑定后，依据原 history 中精确 StructuredOutput 调用及配对 schema 错误，返回同一 structured_output_retries_exhausted。诊断复用原安全字段提取，不规范化或补填业务 JSON、不创建 completed/读取证明/Git 结果。原生同 promptId 的结构输出 enforce 元消息不是新业务用户；正常内置工具不受旧 frozen 白名单及逐字消费证明限制。旧冻结失败认证仍完整保留；普通失败、身份差异、停止不明或 completed 原件篡改不取得此分类。既有 runtime 持久 code、协调 repairDiagnostics、新 attempt 与独审/资源结算接缝保持。

取消先幂等启动原 10 秒精确 receipt 组终止与 15 秒未证实停止截止，再判断 stdin 是否仍可写或 interrupt 是否已发送；重复取消不重置期限。收到原生 result 后也启动同一有限收尾窗口，与 timeoutMs:null 的无限模型调用预算独立，不能无限等待 CLI close。未证实专属组及全部任务后代停止仍保持 cancellation_pending 与容量债务。

终态收尾触发 SIGTERM 时，先保存不可变 terminal-stop-request.json 控制意图，绑定原 session/user、PID、receipt 摘要、固定请求及原 result 摘要和时间，再追加 terminal-stop.json 记录同意图的真实 syscall sent/gone 结果；ESRCH 不能冒充已发 TERM，意图已有但结果未知仍 pending。exit.json 始终记录真实 code/signal/stopped。仅 v6 native-worktree 的完整 result/success/is_error:false 且含 structured_output 可在同轮精确 sent 观察、原 receipt 及完整停止证明下接受实际 143/null 或 null/SIGTERM；仍核原 prompt、模型、schema、Native 身份与 Git 结果，保留真实 exit 原件。受控 handler exit0、其它非零/信号及旧冻结 sent-success 仍拒绝；ESRCH 且真实自然 exit0 仍沿原门。受控成功的冷读同样认证原终止链，canonical completed 不活探旧 PID；缺失、错链或未知停止不产生完成。warm 等原 finally 停止证明及晚到取消/错误结算后才写完成；冷发布前再核调用取消。已有失败、取消中、已取消、超时、错误或取消记录、同轮 interrupt 意图或协议错误均不得补成受控完成。stdin 已结束时仍持久化同一 interrupt 意图，不发送控制消息或伪造 ACK。worktree 的真实 error_max_structured_output_retries 只有完整原身份、模型、prompt/history/schema 错误与停止门通过，并且自然 exit1，或实际 SIGTERM 退出和同 terminal/plan/receipt 控制观察精确相等时，保留原 typed schema 失败；无观察、错观察、未知停止不取得分类，不伪造 exit0/1。原自然 completed 冷缓存不要求新增观察或活查历史 PID；旧冻结失败仍只接受自然 exit1，新 sent 观察下 handler 返回1不冒充自然退出，也不扩展到受控 SIGTERM 类型。

模型观测命名空间修复不增加持久字段、profile或数据库版本：已有 init/plan 与已封存 history 足以分别认证两类事实。旧 plan2 的正式 failed 操作及原件保留失败，不通过离线补签、改变真实状态或手工改写对侧恢复；后续正式调用沿原协调恢复入口。离线真实公开原件回归如需重绑定测试 policy、目录或自有停止 receipt，必须逐项记录受控差异并证明原字节逐 SHA 未变，只能声称协议谓词的失败到通过，不能声称原业务、Git、操作或真实新调用已通过。

原生worktree在原plan/policy/session/user、init/回显/公开history、exit0/success/is_error:false和完整停止均认证后，唯独缺少必需structured_output时，返回structured_output_format_invalid及原thread/turn；诊断固定指出缺字段，不从assistant文本、空对象或任意JSON合成final/rejectedOutput，不发布completed。已有canonical completed或完成缓存被删改仍stale_result，非零退出、signal、未知subtype、错身份或未知停止仍沿原拒绝路径。新attempt对历史缺字段仅沿共用纯读取认证核已封存history、原计划/输入与进程receipt；不封存旧缺席、不写completed或修改原Native文件。正式已停编辑稿的材料观察另核原plan/policy/init/echo、同一owned cwd与已消失原进程组，不能给普通暂停赋缺字段分类。

正式已停owned edit的实际错误投影（type=result/subtype=success/is_error:true、无structured_output、原session/user集合精确匹配、exit1/signal:null/stopped）可仅作为新attempt未批准Git材料；不要求本次原生失败前尚未封存的public-history，不给予success、格式码、raw或业务批准。原exit0/is_error:false精准missing-final仍须完整sealed认证，未知形状和身份差异仍拒绝。新观察只读原件，旧record/plan/结果与缺席字段不追补。

新派发只在既有Native证据目录追加可选native-protocol.jsonl，保存消费ordinal及init/result的公开白名单身份、parent字段存在性与string/null值、model/tools和user UUID集合摘要/数量、result错误标志和structured_output存在位；协议异常仅记固定code。不得写模型正文、error body、thinking、stderr正文、环境或凭据，不赋新运输、receipt、完成或认证角色；其中 error 仅阻止受控成功发布，冷观察不补写。重复init继续严格拒绝，首异常保留；缺init/echo/result按实际缺席字段诊断，事件完整但不满足受控成功或已认证 schema 耗尽的非零退出另记真实code/signal/is_error，仍为failed，不猜HTTP错误类型。 非boolean的is_error仅记固定invalid，不插值原值。
