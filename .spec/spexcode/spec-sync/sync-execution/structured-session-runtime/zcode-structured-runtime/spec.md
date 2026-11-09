---
title: ZCode 原生结构化执行
status: active
hue: 175
desc: 在同一结构化会话管线中运行隔离的 ZCode，绑定原生消息、实际模型工具面和完整进程停止。
code:
  - spec-cli/src/zcode-structured.ts
related:
  - spec-cli/src/zcode-structured.test.ts
  - spec-cli/src/zcode-structured.native.test.ts
  - spec-cli/src/zcode-noninteractive.test.ts
  - spec-cli/src/zcode-stdio.test.ts
---
# ZCode 原生结构化执行

## raw source

沿 [[structured-session-runtime]] 的队列、资源桥和取消接缝，增加已实测 ZCode 的最小结构化执行器；不派生第二套业务协调器，不降低 [[frozen-context-reader]] 的完整读取证明门槛。

## expanded spec

新fence观察已停ZCode edit的未批准Git稿时，复用原verifyPlan、send与public model snapshot，精确核workspace、原session/model、唯一turn.started的input/query/非空messageId、所有events身份与唯一terminal原摘要。只读核原receipt/进程组与正式canonical stop/removed，不能调用会改写旧观察的进程采样或要求messages/success/final。原exit须code0、signal:null、stopped:true，idle/closed原值保持；基础认证后，P0 的原 seed 或完整 Git tree 与 seed 相同的干净后代都只跳过无进度；常规有真实树差量仅原精确turn.failed可授Git材料，cancelled终态不取得材料资格；已结算P0 events RPC例外见下。仅打开exit.json时遇到ENOENT返回缺证据（null），将此候选标为不合格；不会用canonical stop/removed替代exit或turn.failed证明。缺plan/send、其他读取错误、坏JSON及存在但非法exit仍显式失败。新failed和旧cancelled沿[[sync-checkpoint-evidence]]各自原证明认证，不附failedWorktree/rejectedOutput，不改原计划/策略/请求或错误分类。

P0已结算的canonical failed原typed `native_rpc_timeout` 与同一adapter官方`session/events` method/message同时精确匹配时，复用上述原计划、模型、send、process/receipt及完整公开events/terminal认证。仅原同session/turn/input的唯一turn.completed/success、同session/turn的idle.json为true及原exit0/signal:null/idle/closed/stopped全真才通过未批准Git材料源检查；不解码response、不读messages或补completed、原Native版本/CLI版本/实际模型选择照原冻结策略认证。仅打开terminal.json遇到ENOENT返回无材料；同身份原失败/取消通过公开事件和相容的原stop证据后也跳过，不要求成功的exit0/idle/closed；错误身份、未知终态结果、损坏原件及互斥停止证据仍明确拒绝。该进程内分类不认普通pause、其它method或脏物理稿；仍由[[sync-coordinator]]核原正式removed/stop、正常Git、源/测试/owner及当前fence，不授成功、格式或新调用权。

仅version6工作区路径在原plan/send/user/model/final消息/turn/idle/close/stop全部认证后，将格式或schema拒绝的terminal原response附为tagged untrusted_final诊断，保原字节与SHA和原请求绑定。格式失败仍不写completed/output；取消、缺terminal、身份或stop失败不授正文，旧failed缺字段不追补。不得提取thinking或放宽JSON/schema。

新 ZCode 原生 worktree read 请求在创建/资源登记时冻结 `zcodeToolPolicy:{version:1,toolDenylist:['ExitPlanMode']}`。其 NativePlan 与持久 native 身份为 version2，计划保存同一精准 denylist；唯一 session/send 通过 SDK 已有 per-send toolDenylist 从模型可见工具列表移除 ExitPlanMode，SDK mode 仍为 plan。完整提示明确本轮交完整 schema JSON，不请求计划审批；业务正文逐字保留。tool policy 进入固定 policy/创建摘要，effective denylist 另进入 NativePlan.requestDigest，原 send、计划与恢复逐项核验；篡改或版本不符拒绝。Read/Glob/Grep/Bash 与原读范围、Edit/Write/NotebookEdit 拒绝、read Git seed/clean 门均不变，不切 build、不增 sandbox/MCP。edit、旧冻结和 Claude 不采用该工具策略。

旧 NativePlan version1 及已持久但尚无 native session/send 的旧请求保持原工具列表、原提示和摘要，不能补加新字段。未完成仍不重发，已完成恢复零新 send；结构化 policy 仍 version6、工作流仍 native-worktree-v1。只有真正新建记录或新资源冻结当前策略，缺席也是旧请求的固定语义。

严格 JSON.parse 语法失败的 typed message 仅保留静态错误类别及解析器提供的数值 position/line/column；位置对应移除唯一精确围栏后的 JSON 正文。不得透传可能包含原文片段的 SyntaxError.message，不输出 raw/snippet 或敏感值。失败原 terminal/messages/send/ref 与其身份保持，不修补或接受坏 JSON、不写 completed；completed 篡改仍为 stale_result。

ZCode 0.17.1 的 app-server stdin 对每个 Buffer 单独 toString('utf8')；中文/astral 跨 stdio chunk 会替换为 U+FFFD。客户端全部 JSON-RPC request/回复共用 ASCII-safe 行编码，非 ASCII UTF-16 code unit 使用 JSON 的 \uXXXX，代理 JSON.parse 后语义精确相同；不改 SDK、不修补回显、不改持久 plan/send 对象或摘要。客户端 stdout 继续使用 Node readline 的流式 UTF-8 解码，并以三字节/astral 跨 chunk 及 64KiB 边界核验。旧 v1/v2 请求恢复不重发，原生 user/input/query/session/turn 精确身份门及历史失效证据保持。

version5/null 请求沿原 ZCode policy、realm 与版本4读取证明执行，不装模型调用timeout timer；数字 version4 原样恢复。每次RPC、idle/close与精确停止各自期限不变。

新建的 v6/native-worktree ZCode 请求冻结 `nativeConfiguration: cli-config-v1`。执行器写 NativePlan/ZCodeNative version3，并记录本次实际解析 CLI path、`--version`、CLI SHA256、所引用 public builtin path 及可读取时的 SHA256；这些运行身份绑定 plan、model snapshot、send 与完成证据，不作为版本、摘要、provider 或模型准入名单。显式 `zcode:<provider>/<model>` 原样交给 SDK；`zcode:default` 创建 session 时省略 model，随后只从 SDK 原生 session/read 取得实际选择，不合成 provider/model。effort 原样作为请求交给 SDK，只有 session/read 的当前选项与可用项精确证实后才发送；SDK拒绝、未回显或不可用时保留真实失败，不按具体模型推断成功。既有 personal provider config、endpoint/baseurl 与凭据引用不改写，控制面不读取或输出凭据字节。

NativePlan v1/v2 与缺席 `nativeConfiguration` 的历史请求保持原策略及持久字节，不补字段、不重签 plan/receipt。历史完成恢复按原 plan 中保存的 CLI、builtin、provider/model 与原 send/schema/input 重新核对，不比较当前安装的 CLI 常量；新配置 v3 冷恢复也只核原快照和全部原始 Native 证据，不新建 CLI/send。旧未完成 plan 不得由新配置启动或续发；只允许按原身份精确取消。固定冻结读取 v4/v5 的派发仍沿原固定隔离策略与 frozen proof，不借用 worktree 的新配置语义。

缺席 `nativeConfiguration` 的 legacy v1/v2 与固定冻结读取路径沿原能力配置：只接受 `zcode:<provider-id>/<exact-model-id>`；新派发要求 macOS ZCode CLI 0.17.1、CLI SHA256 `9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6` 和公开 builtin provider SHA256 `e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9`。该门槛不用于新建 `cli-config-v1` worktree，也不用于已完成历史的冷恢复。策略为 version4 / `zcode-frozen-read-only-v1`。

每次派发使用专属空 workspace、私有 HOME / ZCODE_DATA_BASE_DIR 和 `/private/tmp` 下短 TMPDIR。固定配置关闭 plugins、hooks、skills/includeInstructions、memory、subagent；child-only 的两个 provider config 环境变量显式引用公开 builtin 与原 personal provider config。现有 credentials 只通过私有 home 的只读符号链接供 SDK 正常消费；控制器不读取、复制或记录凭据字节。父环境仅传必要 PATH，不继承其它配置或认证变量。

外层 Seatbelt 对 app-server 及全部 MCP 后代生效：只允许专属 runtime 与 tmp 写入；配置、profile、reader-input、冻结正文和 workspace 不可写。发送前以真实文件写入和 Unix socket bind 预检同一 profile；长路径 socket 失败不通过扩大权限修补。

使用现有只读 reader 的 legacy MCP，唯一 allowlist 为 `mcp__frozen__spex_read_frozen`。create 显式绑定 workspace、provider/model、immediate persistence 和关闭标题生成；runtime preferences 全关闭。仅一次 send，固定 session/input/query 身份；ACK 不是 turn 终态。每次实际 ModelRequest 必须精确 provider/model、toolCount1。未知或认证 server request 一律拒绝，不读取其参数或保存传输头。

唯一 `zcodeStructuredPrompt` 在原业务正文前加入 deterministic 只读控制段及精确 JSON schema，保留业务正文全部字节，不修改 provided frozenRef/task。唯一 Native user/send 和 witness.prompt 都是该完整 NativePrompt，不得把旧裸业务 prompt 当作实际输入。原业务 prompt、完整 NativePrompt、schema 和 native selection 共同绑定固定请求摘要；新派发、结算与冷重放使用同一函数重算，篡改 schema、正文或原 send 都拒绝，不能补写结果或新增 schema 工具。

固定公开 builtin 中 GLM-5.3-Flash 继承 `low/high/max`；只对 `bigmodel-api/GLM-5.3-Flash` 接受显式 high。create 同时固定 `model.options.reasoningLevel: high` 与顶层 `thoughtLevel: high`；原生 provider 映射为 `thinking.type: enabled`、`output_config.effort: high`。原生 selection 进入 plan 与固定请求摘要。send 前用真实 session/read 核 `settings.model.current.options.reasoningLevel`、`settings.thoughtLevel.current` 都为 high，且 available 的 value 包含 high；session.model 只用于基础 provider/model 身份，不能假定它回显 options。已确认同 session 创建后立即持久身份，模型不符仍走该 session 的正式 close，不发送。其它 effort 或未证模型组合明确 unsupported，不忽略、不换模型。

唯一 session/send 显式携带已核 SDK 的 modelSelection，原样保存于 send.json 与 witness.send，并与真实用户消息的原生 modelSelection 严格绑定；不从仅用于展示的 model_change timeline 推断实际 API 选择，也不以 UI 记录补造模型请求。

原始 session/messages 的 core info 与 parts、原始 turn lifecycle / tool.updated / 含 toolCount 的 ModelRequest 安全事件构成原生见证；不以 ledger 补写 native arguments。transport 及未知事件只保存类型计数，不保存 payload 或 headers。原生工具、消息、输入、模型和 MCP ledger 必须由专用证明模块严格绑定。

终态仅接受本轮 success，响应可以是直接 JSON 或一个完整、精确的外层 `json` Markdown fence。decoder 只移除该单一外壳，正文仍使用 JSON.parse 和原 Ajv schema；不得修补 JSON、接受解释文字或多段输出。规范 JSON 结果绑定原始终态响应与完整见证。version4/5 冻结路径首次结算先核终态与原事件精确一致，并通过完整原生消息、工具/MCP 及 required 读取证明；随后仅该严格文本解码的 JSON 语法失败标为 `structured_output_format_invalid`，仍为失败且不发布输出或读取证明；原生协议、模型/工具/消息真实性、schema 与覆盖失败不取得此码，保持旧分类。version6/native-worktree 仅在精确 Native 模型、原输入/消息、success 终态、idle/close 与 exit stopped 均核验后，AJV schema 不符才复用 `structured_output_format_invalid`；错误message保留 AJV 字段/路径诊断且不包含原始输出；可选rejectedOutput独立按上述不可信诊断规则保原件，不修补 JSON、不写 completed 或发布业务输出。此前身份或停止门失败仍按原 stale/cancellation 分类。completed 冷重放的终态篡改、schema 或格式异常仍为 stale_result，不转自动修复。

先捕获原始消息，再精确 session/close:true 与 EOF，确认自有 detached 进程组及全部已观察 app/MCP 子进程死亡，才写 completed。MCP startToken 缺失时使用宿主 ps 的精确 PID/start 身份补证，不伪造 reader ledger。completed 冷重放核原请求、原始见证、schema、proof 与 durable output，零新 SDK/API；未知 in-progress 不追加 prompt，保留 cancellation_pending。

原生 TurnComplete 将 projection.status 置 idle，但保留 currentTurnId 作为历史指针；此指针只允许缺省或精确等于已核终态 turn，另一 turn 仍拒绝。真正活动来自 runtime.activeTurnId/kind，终态事件可先于 finally 清除它；必须等真实活动消失，pending request/permission 为空且工具状态全部为 completed/failed/denied，未知、pending/running 均拒绝。idle 诊断逐次保留白名单真实 status、active/current turn、pending 身份数组和工具状态，不保存传输头、工具输入或权限正文。正式 close ACK 和整组/reader 死亡仍是独立必需结算证据，不改写旧失败的 idle=false。

取消沿原协调入口撤销发布权。活运行向同 session 发 stop，核 ACK 后仍要求精确 turn 终态与 idle；关闭后仍核全部进程。冷取消只允许原固定 plan、PID/start/receipt 的专属 runtime，精确 TERM 后核进程组与 MCP 全亡；未知身份不操作，不以 ACK、leader 退出或迟到 output 释放容量或发布结果。

普通测试覆盖命名空间、精确 fence decoder、事件安全投影、固定能力配置和冷取消身份；真实 native 测试必须显式环境开关，默认不得运行模型。当前节点保持 pending，直到正式产品 A/B 证据及门槛全部成立。


明确的 version6/native-worktree-v1 使用创建记录的真实 worktree 作为 workspace/cwd，read 用原生 plan、edit 用原生 build，保留正常内置工具，不设 frozen MCP/只读 Seatbelt 或唯一工具限制。权限请求仅对当前 session 一次批准正常读/搜索/shell，文件修改只批准 edit 模式的本 worktree，且不写 permissionUpdates、不建立读取内容/路径白名单。仅 schema 控制最终 JSON；原 provider/model/effort 快照、唯一 session/input/query/turn、原始 send/messages/events、精确成功终态、idle/close、exit0 与整个自有进程停止仍逐项核实。完成及冷复用不生成或消费 frozenReadProof，也不要求分块读取及逐字 API 消费；旧 frozen policy 及工具门不变。

同一 v6 worktree 调用收到原子进程 close、且没有 stop 请求、取消、协议错误或原执行错误时，关闭后的首次非终止完整观察一旦确认停止，就在原绝对截止内直接用它写原 exit。未获 close、首检未证停止、进入终止回退、已有取消或失败及旧 frozen 仍按原观察与结算路径。随后本次 worktree 调用直接使用写原 exit 前的同一次新鲜停止观察。只有该次观察确认原进程组、相关后代与任务域未知进程都已结算，才进入同栈完成核验；期间不再排队重复观察，仍在原绝对停止截止内完成核验与发布。取消优先、原 exit、终态、消息、模型与 schema 门不变。

已持久 completed 的 worktree 冷重放核原完成缓存、固定请求、Native 身份、schema/输出和原 exit.stopped/close 证据，不再探测历史 PID/PGID，避免无关复用导致伪 stale；未结算的冷恢复仍必须重新实时证明原进程与后代停止。

worktree轮询、取消、未结算恢复与finally逐次等待[[native-worktree-runtime]]的异步有界进程观察，同root采样和停止串行，不让慢cwd探针阻塞RPC/取消timer或叠加观察。取消的原15秒与清理的原分段窗口以绝对截止沿排队/观察传递，内部剩余不重置；过期不追加Native信号或真停止原件，最后取消分类消费已保存的同一次fresh停止事实，不在截止后另开采样。探针失败保原未知停止及容量，不据此写成功exit/完成证据；已completed和sealed材料读取继续核原件，不活探历史PID或增加Native杀权。冷取消及清理在等待观察后、实际发TERM前重新核同一原receipt/专属组身份，等待前的proof不能跨异步窗口授信号权。

worktree 停止沿 [[native-worktree-runtime]] 正向任务域边界及 boundaryVersion2 追加观察，保留原 failed exit/unknown；首次派发在宿主平台的临时目录中创建唯一私有 tmp，workspace 与 tmp 随原 plan 固定，冷恢复不重选或改写。旧 macOS frozen policy 的 `/private/tmp` 短路径不变，无关联同 UID 进程仅诊断。

每次 stdio RPC 的 10000ms 计时器以 native_rpc_timeout 标记超时，删除原 pending ID 并忽略迟到回复。已 ACK 的活跃轮询仅在精确 `session/events` 超时且没有取消或协议故障时，以同一 session 和未移动的游标发一次新的只读 RPC。只有该页交回经原身份核验的本轮 `turn.completed` / `success` 才继续原 messages、idle、close、停稳与输出认证；其它结果按失败或取消结算。模型 send 保持一次，其它 RPC 超时、未 ACK create、原失败证据与停止证明仍沿既有门禁，由 [[structured-session-runtime]] 正式消费。

本次新观察的 turn.failed 必须绑定原 session、turn、已接受的 input 和唯一 turn.started 的 query；认证后以进程内专用错误保留首要失败，仅投影宿主 errno 定义中的安全原码，不透传 provider 错误正文。原生工作树的公开结构化 error.code 精确为 EPIPE，且 error.attribution 同时明确 source=provider、exceptionKind=provider_business、retryable=false 时，投影既有 unsupported 和固定无正文摘要，不能自动按传输故障续修；errorPhase/transport 不增加门槛。其余 EPIPE 保持 native_turn_transport_failed，普通 errno、缺失或未知 attribution、可重试形状及历史冻结模式沿原分类；不按错误正文猜分类。失败不请求成功消息历史，不授 output、rejectedOutput 或 Git witness；finally 仍原样观察并保留 error/idle=false、close=false 和 exit，不把 error 当作 idle。清理异常不覆盖已认证首要失败，正式结算仍由现有 exact adapter.stop 独立核原 plan、PID/start/receipt、整组、后代与任务域停止，未知不得释放容量。历史失败不补读或追补认证，不新增 plan/持久策略版本；native_turn_transport_failed 只在 [[sync-coordinator]] 的正式 P0 资源门作为新增重试依据；unsupported 沿既有业务阶段拒绝路径，不授自动重试资格。
