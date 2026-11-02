---
title: 结构化会话运行与结果恢复
status: active
hue: 175
desc: 复用会话创建和启动队列，持久化精确 thread/turn 的结构化结果，供业务细化与独立审查使用。
code:
  - spec-cli/src/session-structured.ts
related:
  - spec-cli/src/session-structured.test.ts
  - spec-cli/src/session-structured-queue.test.ts
  - spec-cli/src/sessions.ts
  - spec-cli/src/codex-harness.ts
---
# 结构化会话运行与结果恢复

## raw source

业务细化与独立审查需要可追踪、可恢复的结构化 Agent 结果。使用现有会话事务、幂等键和启动队列，正常推理无需逐次确认。

## expanded spec

新产生的已认证final格式/schema拒绝可在failed运行元数据及StructuredSessionError上携可选tagged rejectedOutput：完整final文本、SHA、prompt/schema/input/purpose及原生thread/turn绑定。它只是不可信诊断，成功output槽仍缺席，旧failed无字段不补读/不猜分类。同键读取和资源桥重核固定请求与证据身份；取消、无final、未停稳、身份不符不得附正文。可选观测不参与固定策略/创建摘要、不增加执行authority，因此不新增writer marker。

资源专用恢复可在非持久取消选项中明确wakeQueue:false：仍刷新原queue candidate投影并保存精确取消/停止证明，只禁止本次主动requestQueueDrain。独立资源入口同时沿[[production-cutin]]静音本次canonical提交后的主动delivery wake；普通cancel默认行为保持。已有queued目标尚无nativeStopped时同样适用，资源结算不替旁置queued任务或watcher启动新turn；后续正常drain重新核目标stopped，仅推进仍合法的queued任务。

ZCode worktree read 真正新建记录默认冻结 [[zcode-structured-runtime]] 的非交互工具策略；同创建键已有记录按原字段或缺席恢复，显式不同策略拒绝。内部 sessionCreateKey 表示资源桥已经冻结工具策略：尚无会话记录时原样保留上游显式字段或缺席，由固定策略构造严格验证 provider、mode 和精准 denylist，不能改成空策略或再补默认；已有记录仍优先核原记录。业务 requestKey、inputDigest 和创建实际键的语义保持。策略字段参与创建摘要，旧创建哈希和原 native 输入不改。

同步 budget.mode=unlimited 的新模型请求使用 timeoutMs:null，表示不设置模型调用总时限；有限数字期限及旧记录语义保持。null 调用仍受独立会话创建、租约/心跳、显式取消/停止/关闭和可信 VERIFY/Docker 各自期限约束，不以大数模拟无限。 仅 null 固定执行策略采用 version5，原 policy/realm/原生读取证明版本保持各执行器语义；旧数字 version1–4 原样兼容。独立旧 queue 的固定策略比较必须在任何 Native 启动、timer 或停止副作用前拒绝新版本。创建仍取独立 sessionCreateTimeoutMs，模型无期限不解除创建限幅。

明确 ZCode 命名空间进入 [[zcode-structured-runtime]]，复用现有 `zcode` harness 身份、同一创建事务、启动队列、资源桥与取消门禁，不进入普通 one-shot launcher 或 Codex generation。版本4固定策略和原生 `zcodeNative` 身份分别持久化；换 provider 仅新操作或合法 retryOf。最终文本可解码唯一完整的外层 JSON 代码围栏，正文仍由 JSON.parse 与原 object schema 严格校验，不补字段、拼接多段或接收额外说明。真实精确终态、[[zcode-frozen-proof]] 与全进程结算后才能发布；冷 completed 回放只读原证据，未知在途不追加 prompt。

明确命名空间 `claude:<exact-native-model-id>` 选择 [[claude-structured-runtime]]，继续复用同一创建、排队、预算和结果接缝；无前缀或缺省 model 完全保持既有 Codex 策略、请求摘要和历史恢复。Claude 使用版本3 `claude-frozen-read-only-v1`，不进入 Codex generation ledger，不借用其 turn 或版本2证明。已冻结 operation 不能热切 provider，切换仅属于新 operation 或合法 retry 的新固定请求。

`runStructuredSession` 接收冻结 prompt、object JSON schema、输入摘要、用途、请求键、超时和可选 model/effort，返回 sessionId、threadId、turnId、output 与结果摘要。输入树必须属于当前 backend 项目，可指定 base commit。生成和审查分别使用不同请求键与原生上下文；安全约束见 [[structured-readonly-policy]]。

结构化调用仍使用原会话创建事务的 `SPEXCODE_SESSION_CREATE_TIMEOUT_MS` 配置与限幅（默认 30 秒），实际创建期限取该值与本次请求预算的较小者。不能用另一处固定 30 秒覆盖已配置的创建期限；取消、清理证明及原生执行预算仍沿原协议。

策略/schema/输入/预算参与幂等哈希，公开会话创建对象不能注入安全策略。相同载荷复用同一结果，不同载荷拒绝。同一连接在初轮前订阅，原生 thread 与 turn 接受后立即持久化；只读取精确 turn 的 completed 与 final_answer。失败、取消、超时、缺失结果、非法 JSON 或 schema 不符不算成功，创建后失败包含已知的会话和原生身份。

[[claude-structured-runtime]] 已确证的结构输出重试耗尽在 failed 运行元数据中保留可选 `errorCode: structured_output_retries_exhausted`；调用与同键重放保留该精确码、原错误及已知 session/thread/user 身份。[[zcode-structured-runtime]] 的严格 JSON 文本格式失败同样在 failed 中保留 `errorCode: structured_output_format_invalid`，调用与同键重放保留精确码、原错误和 session/thread/turn 身份，不接纳原无效输出。此观测字段不参与固定策略或创建摘要，只扩展已有 JSON 可选值，不改变存储 schema；旧 failed 没有此字段仍返回 failed，不按错误文本猜分类。

传输断连保留 running 身份；重试通过原启动队列恢复该 thread/turn。丢失 turn 接受回复时，只有唯一初轮且用户输入匹配冻结 prompt 才可恢复。不得从历史最后一条 assistant 消息猜测结果。读取持久结果再次检查输入/schema/策略、精确身份及结果摘要，拒绝旧输入或损坏结果。取消先持久化 `cancelling` 撤销结果发布，再中断原生 turn，禁止迟到结果改写终态。

精确结果读取沿 [[codex-runtime]] 的原生 turn/item 分页，不依赖整段 history hydration；每页核固定 turn 身份并保留全部原始工具 arguments/result，再执行既有 final_answer、JSON/schema 和冻结覆盖校验。原 owner 在预算内用轻量 metadata 补证丢失的完成通知，仍等待原工具工作完成；恢复只沿已有 thread/turn，不额外派发。

本节点只交付结构化推理接缝；返回的文本差量由同步协调器负责验证与落盘，不代表上层 [[sync-execution]] 的 P2 完整交付已完成。

每次结构化请求发布或复用会话后，runner 显式向原启动队列登记该精确候选 ID，再请求 drain；嵌入调用不依赖 Dashboard、index 或文件 watcher 通知。maxActive=1 时，不同请求键的生成、修复和独立审查可以连续实际启动并完成。已经结算的结构化会话保持原 awaiting/nothing 历史与 offline 投影，普通人工会话的 awaiting 资源语义不变。取消或超时标记仍禁止后续派发；断连的 running 请求继续按原精确身份恢复。

`cancelStructuredSession(sessionId, { reason?, timeoutMs? })` 是结构化取消入口，返回精确 session/thread/turn、nativeStopped、acknowledged、nativeStatus 和未证实停止的 error。queued 或明确尚未发送首轮的请求可以证明 notStarted，无需进入普通 adapter 的无 thread 控制路径。已经接收的请求只控制其持久的 generation/thread/turn；收到 interrupt ACK 后仍须读取同一个 turn 的终态才能证明停止。原生首轮接受后的空 rollout 属于有限预算内的启动竞争，允许在 generation fence 内重读，不视为空闲。已自然结算的精确 turn 无需再次 interrupt。

精确 session/thread 与 generation binding 一致时，取消复用 [[shared-runtime-generation-rotation]] 的只读 close 解析。原 detached 进程组已由 [[detached-runtime-identity]] 正面证明消失，即使 ledger 尚未 reclaimed，也可持久结算 nativeStopped/generationGone；不发送 RPC、不启动或恢复 native、不替换绑定。原失败首轮只有 thread 而没有 turnId 也适用。缺失或不匹配绑定、错 receipt、PID 查询未知、仅 socket 消失或残留进程组仍保持 pending，不能从错误字符串或原生缺行推断停止。

结构化 record 的固定 policy 唯一决定其 Codex control realm：v1 使用 `structured-read-only-v1/control`；v2 的旧 readerRuntime 版本1使用 `structured-frozen-read-only-v2/<readerRuntime.catalogDigest>/control`，新版本2在同一目录下以 `output-<toolOutputTokenLimit>/control` 隔离传输额度能力。创建登记、恢复、取消以及后续 close 都解析同一 realm，并继续核对精确 session/thread/generation binding；另一个 realm 中看似匹配的 binding 不能替代。

AbortSignal、caller 超时与显式取消使用同一持久取消协议。确认停止后 cancelled/timeout 为 offline 并允许下一请求使用容量；拒绝控制、连接中断、generation 身份失效或 ACK 后仍 active 时，保持 cancelling/unknown 和原容量保留，返回 cancellation_pending。调用方可以重试取消取得真实结算证据；不得 kill 共享 realm，不能仅凭已发送 frame、RPC ACK 或 caller 截止宣称模型停止。断连 running 的原恢复语义不变。

跨进程取消共用独立的原生控制互斥；控制 RPC 不占用会话 record 锁，observer 可以保存身份并结束。取消开始及结算均在短 record 事务内重读当前记录；同一精确原生身份的 nativeStopped 终态证明不能被迟到的开始、失败、超时或 observer 诊断降回 cancelling。已收到 ACK 的历史也在重试中保留，返回结果来自实际持久结算。已绑定的 thread/turn 不能被不同迟到身份替换；同一身份的补全仍可保存。外部取消完成后，原 caller 撤销本地观察，新的无 Dashboard 进程可从持久证明释放容量并派发不同请求键。损坏的取消状态仅通过正式取消入口重读精确原生终态恢复，不手工清除容量或改写记录。

原生精确 turn 接受后，在保存 turnId 的同一 record 事务中发布 canonical active；Board 显示 working，不能继续显示 queued。结构化启动及运行不依赖普通 daemon 的 liveness census：active/running 保守投影 unknown 并预留容量，精确结果结算后才 offline；断连 error 与显式 queued 恢复沿用原恢复入口。取消中的迟到身份补全不能重新发布 active。

精确原生执行与本机结果 observer 的存活分别记录：队列在短 record 事务中以 PID/startToken 领取 observer 身份，正常退出释放为 null；此运行字段不参与固定请求摘要。同键调用看到仍存活的 observer 仅等待原持久结果。observer 已释放、明确死亡或 PID 已被不同启动身份复用时，同键新进程通过原队列恢复同一 thread/turn；缺失或无法验证 owner 的 running 状态不得当作死亡抢占。两个恢复进程只允许一个领取观察，既有 turn 不再发送 turn/start。native 仍运行或已完成都可恢复精确结果，completed 同键回放保持原身份与摘要；恢复不调用普通会话 resume，也不扩大固定只读策略。

结构化创建期间取消或超时、尚未发布会话时，正式创建事务完成清理后保留精确 SessionCreateTermination。错误包含该收据的预期 sessionId；同键重放返回原取消/超时，不进入队列或重新创建。创建事务等待锁时被取消不能生成他人停止证明；清理失败不提供 nativeStopped。上层只能用匹配固定请求的收据结算尚未开始的资源。

Native资源桥仅在精确绑定的`session_create_timeout` receipt通过sessionId/requestDigest/payloadHash、nativeStopped/notStarted/cleanupComplete与未启动身份检查，且资源`terminal→removed`已持久化后，抛出携带原receipt的`SettledSessionCreateTimeoutError`。此子类的`code`仍为`timeout`，其独立类型只标识可由上层消耗现有预算重试的已清理创建超时；caller取消、普通timeout、receipt缺失/错配、清理未证实或已有thread/turn均不能构造该类型。

尚无 frozenContext 时，runStructuredSession 先调用 prepareFrozenPrompt：普通小 prompt 保持 v1；带纯 JSON frozenEntries 或超阈值正文才生成 ref，且不编造 attempt/policy。提供 frozenContext 时采用 [[structured-readonly-policy]] 的 v2 冻结读取，清单参与固定请求摘要；内部 sessionCreateKey 仅承接已持久 reserveDispatch 的原生创建身份，业务 requestKey/inputDigest 保持清单绑定。已有 ref 与旧证明按原字段恢复。真实工具请求与回复证据先持久再发送，最终必须核验精确原生历史及完整覆盖。未答动态请求的恢复不能伪回执，改由既有取消协议确认精确turn停止；确认前不得释放资源。

readerRuntime版本2在新结果发布、completed精确恢复和同步资源结果读取中均要求[[frozen-context-reader]]的版本2模型可见证明及固定额度，不能携旧coverage证明降级。旧runtime只恢复已有turn；保留唯一原turn加精确prompt的丢ack识别，但不得发送thread/start或turn/start。旧字段和摘要保持原样。

Claude 新请求在首次冻结时把完整 task 和条目生成最多65536字节的直接 MCP 计划，现有 ref/prompt 原样恢复。其 threadId 是真实原生 session UUID，turnId 是经回显、history 与 result.user_message_uuid(s) 三方确认的原始 user UUID，promptId 另外持久绑定。result.uuid 只是结果事件身份。success、structured_output、当前 schema、原生完整读取证明和整个 CLI/MCP 进程组停止缺一不可。先持久完整原生终态/证明，再发布 completed；同键 completed 仅重读原证据，零新 CLI/API。未知 in-progress 保留 cancelling/recovery_required，禁止用 resume 追加 prompt 冒充同轮恢复；精确停止后由既有新 attempt 协议重试。


原生 worktree 请求明确提供 worktree:{baseCommit,tree,mode} 时，走独立 version6/native-worktree-v1 策略及专属 realm，不调用 prepareFrozenPrompt，不产生 frozenReadProof，旧只读策略与证明仍完整保留。仅明确 Claude/ZCode 原生模型可执行。baseCommit 必须是完整不可变 seed commit SHA，tree 精确等于其 Git tree；创建固定 base 与 forkCommit 均为 seed，后续主 checkout 的 HEAD/index/WIP 不参与初始化。runner 用创建记录的真实 worktreePath 作为 cwd，允许正常文件读取、搜索、编辑与检查，schema 仅控制最终输出格式。read 模式完成要求 HEAD/tree 等于 seed 且工作区干净；edit 模式要求代理正常 Git add/commit（保留 hooks），HEAD 是 seed 后代且干净。结果及持久 envelope 保存 baseCommit/baseTree/headCommit/tree/worktreePath，所有差量由真实 Git 对象导出。精确原生模型、session/turn、终态、退出与完整进程停止仍必需；冷 completed 核原证据和同一不可变 Git 对象身份，正式 close 移除 worktree 不阻断复用、不重建工作区，零新派发。有限与 null 模型期限均支持，创建及取消期限独立。

已认证原生成功输出通过 schema 后，Git 后置合约拒绝以 native_worktree_result_invalid 持久在 failed.errorCode；原错误及已知精确身份在同键冷重放保持，不新派 Native，不写 output/resultWorktree 或 canonical completed。原生 CLI 协议完成缓存与原 Git/index/草稿保持原件，不能代表业务通过；旧缺码失败不按文本推定新分类。

本地 Native RPC 的 typed native_rpc_timeout 先保存 cancelling 与原 code/message，再复用既有精确 adapter.stop 协议消费 PID/start/receipt 和原 session/turn 停止证明；确证后保存 failed 与原错误及 stop，未知仍 cancelling 占容量。同键只重放失败，不重发未 ACK 的 create，不把原生故障改签为用户取消；显式取消和总 timeout 保持原语义。新 observer 对已认证 rejectedOutput 且确证停稳的 version6 stage 可保存 failedWorktree：只取实际记录工作树的干净、归属原 seed 的真实 Git 结果。Git 后置合约不成立时保留原格式错误及原 final，不附 witness；冷读取只核已有事实，不补捕。该持久失败/停止语义受统一 sync v22 writer fence 约束，旧 writer 不得消费新状态。
