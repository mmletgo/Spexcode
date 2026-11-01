---
title: 结构化执行策略与只读历史边界
status: active
hue: 175
desc: 显式区分原生 worktree 执行与固定只读历史，禁止权限降级复用或静默切换执行器。
code:
  - spec-cli/src/session-structured-policy.ts
related:
  - spec-cli/src/session-structured.test.ts
  - spec-cli/src/frozen-context.test.ts
  - spec-cli/src/codex-runtime-generations.ts
---
# 结构化推理固定只读策略

## raw source

旧冻结生成和独立审查只能读取协调器提供的冻结上下文并返回 JSON。新原生 worktree 工作流由协调器交付 seed 及变更 Spec/上下文，Agent 正常读取、编辑、检查和提交。两类能力必须显式区分；旧只读请求不得通过新模式获得权限，没有对应能力时明确失败，不能静默切换。

## expanded spec

新显式 worktree:{baseCommit,tree,mode} 采用独立 version6/native-worktree-v1，数字或 null 期限都保持该版本。固定 schema/inputDigest/purpose/timeoutMs/model/effort/worktree 参与创建哈希，resultWorktree 仅为终态观察；不能同时携 frozenContext/readerRuntime，不产生 frozenReadProof。仅明确 Claude/ZCode 原生名字空间可用，无前缀/default/Codex 模型明确 unsupported。realm 固定为 structured-native-worktree-v1/claude 或 /zcode，禁止借旧只读 realm/证明；正常文件工具与 Git 结果边界见 [[native-worktree-runtime]]，两个执行器的正常模式分别由 [[claude-structured-runtime]]、[[zcode-structured-runtime]] 规定。下述 version1–5 的冻结策略完整保留，不因新增模式而放宽。

version5 仅标识 timeoutMs:null 的固定调用预算能力，policy 字符串、隔离配置、realm、模型及 reader 证明保持原 Codex/Claude/ZCode 语义；数字请求继续使用原 version1–4。三个执行器复用同一计时接缝，null 不安装调用 timer；版本/timeout 不一致不得取得原生派发权。

明确 `zcode:<provider-id>/<exact-model-id>` 使用版本4 `zcode-frozen-read-only-v1`，固定隔离合同见 [[zcode-structured-runtime]]。它复用私有 HOME、私有数据根、空工作目录和实测 macOS Seatbelt；私有配置关闭插件、hooks、skills、用户指令及额外 MCP，模型仅获唯一冻结 reader。既有 provider 配置与认证只作 SDK 正常使用的只读安全引用，不读取、复制或打印凭据。短私有 TMPDIR 的实际 Unix socket bind 与内外写入诱饵必须通过，不能放宽宿主目录或改用宽松 launcher。原始证明事件不包含 transport headers；未知能力或完整证明缺失仍失败，不自动切换 provider。

以下 v1/v2 为原有 Codex 策略；明确 Claude 命名空间另使用 [[claude-structured-runtime]] 的版本3固定策略，不能自动 fallback。其空执行 cwd、私有 CLAUDE_CONFIG_DIR 和同一 macOS Seatbelt 写入边界只允许专属 runtime 写入。官方 restricted、空 built-in tools、独占 MCP、空 settings sources、关闭 hooks/记忆/普通指令文件和 slash commands 共同限制能力；仅 reader 与 StructuredOutput 可实际调用。CLI 2.1.309 的固定不可调用 DeferredToolPlaceholder schema 可以存在，实际调用拒绝。

结构化执行的可选精确失败码属于 [[structured-session-runtime]] 的终态观测，不授予新工具、模型或读取能力，不改变固定策略摘要与成功的完整读取证明要求。

Claude 透明沿用实际 CLI 的既有认证机制与 API 路由，包括安全环境、正常 keychain 或现有 wrapper；不读取或复制凭据文件，不保存/打印 token，不改变付费路径。不能仅凭父进程缺少环境变量判定未认证；同一 CLI 在同一私有配置目录、restricted 与外层隔离中运行只读 auth status，仅保存 loggedIn/authMethod/apiProvider，实际确认不可用才 unsupported。未知 CLI 版本或未证明 managed policy/provider 同样拒绝。服务启动环境缺变量不能从交互终端偷取或写入全局配置。完整工具 surface 和实际 API model 必须再次由原生 init/history 核实，不能只相信 flags。

已有原生用户 settings.json.env 的认证来源按 [[claude-structured-runtime]] 只在内存投影四个允许键；任一显式进程键优先整组。其它用户 settings 仍由 restricted 和空配置来源排除，不能以复用认证为由继承权限、hooks 或 MCP。

内部固定策略为 codex-read-only-v1。独立 CODEX_HOME 仅包含可信配置及既有认证文件的只读安全引用；不读取、复制或打印认证字节，不继承用户 config 或 launcher 的 yolo/bypass 权限。配置关闭 shell、code mode、多 Agent、MCP、apps、plugins、hooks 和 web search；在模型 turn 前检查有效只读/never 策略、禁用特性以及零 MCP/hook 工具。

macOS 外层 Seatbelt 对 app-server 及全部后代实施写入限制。runtime 的 rollout/cache 可以写入，coordinator 控制文件、固定 config/auth 引用、源码树、交付树与用户配置保持不可写。原生 daemon 仅获准写本 generation 的精确 socket/lock 和日志，不放开整个共享 socket 目录。启动前必须真实 probe 运行目录可写且外部文件不可写。

Codex 原生 readOnly 策略保留，P1 使用提供正文的纯推理，不依赖嵌套 sandbox 中的 shell。新旧 generation 继续复用现有持久 ledger 和 detached receipt。未验证等效隔离的平台返回 unsupported，P4/P5 继续建设与验证；安全预检失败不得 fallback，也不能当作已完成同步。

冻结读取策略 codex-frozen-read-only-v2 保留相同 readOnly、never、零 shell/MCP/apps/hooks 权限，只注册一个 spex_read_frozen 动态工具。清单以内容摘要绑定业务 requestKey、inputDigest 及实际存在时的 policyDigest/attemptId；源码树外的私有目录保存不可变内容寻址字节，逻辑 entry 与内容摘要分别保留。模型只能提供 contextDigest、entryId 和 end-exclusive 字节区间，不能提供路径、URL 或读取 live source。UTF-8 区间必须保留字符边界，binary 使用明确 base64，absence 显式返回；缺失、篡改、错身份或错摘要拒绝。返回字节和请求摘要在回复前持久保存。

最终结果必须从精确 thread/turn 原生历史的真实动态调用 arguments、completed/success 和完整 contentItems 重新核验，所有 required 内容需要完整区间覆盖，相同 kind/SHA/长度的逻辑条目可以共用覆盖。生成和独立审查分别取得自己原生 turn 的完整覆盖，不能借用另一 turn 的回执或模型声称已读。恢复已完成 turn 只核历史，不能重调用工具。断连后仍有未答动态调用时，旧RPC id不再可用；保留未知资源，沿既有精确取消机制停止后以新attempt重试，禁止伪造历史回执或盲目重发。

默认gpt-6.1-sol通过原生code-mode host中转动态调用；单纯开启host会暴露apply_patch、图片和goals，不能作为冻结读取策略。v2独立realm仅对经过真实探针验证的Codex0.160.0启用受限host，code_mode仍false，禁goals/view_image/image_generation/sleep/tool_suggest/current_time_reminder/asyncuserinput/tokenbudget。clean metadata子realm只调用typed model/list、不创建thread/turn；只提取其原生provider模型metadata，保相同实际模型所有信息，仅清空apply_patch_tool_type和experimental_supported_tools工具能力。冻结catalog的SHA、CLI版本和控制路径进入固定execution与资源计划，预检/恢复校验内容与版本，变更不可沿用旧证据。模型不能写catalog/config；无受验证版本、目录或隔离证明时明确unsupported。

新readerRuntime版本2的固定tool_output_token_limit按[[frozen-context-reader]]从冻结清单派生，并进入descriptor缓存、realm路径和execution身份；实际config/read必须精确相等，不能只核磁盘配置或修改provider目录声明。新预算能力与旧catalog相同也不能复用旧daemon路径。旧版本1保留原realm/config与已存在thread/turn的历史恢复，不重写旧清单、响应或proof，不把旧证明升格为模型可见全文证明。host的独立exec额度和公开outer完整输出另由版本2读取证明核验；关闭host在当前原生路径不可用，不能把无成功读取的turn接受为完成。

原生能力探针必须亲读custom exec代码与返回值：registry只有注册reader；process/require/fetch/module不可用，Node/HTTP/data动态import拒绝，constructor不取得宿主process，任意path/live诱饵不可读、任意写入与子进程不可达，网络诱饵0命中。metadata临时daemon只有在零native references且精确PID/start/receipt证实后才停止，停止确认后保存来源/前后目录摘要和changedFields，不能操作既有v1或其他generation。错误工具请求未获回复时沿cancelling保留容量，不能因本地快速失败就声称原生已停止。
