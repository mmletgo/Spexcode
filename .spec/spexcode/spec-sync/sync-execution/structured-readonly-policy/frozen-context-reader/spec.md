---
title: 不可变冻结上下文的按需读取
status: active
hue: 175
desc: 以唯一受限动态工具无损读取冻结字节，并用精确原生历史证明完整覆盖。
code:
  - spec-cli/src/frozen-context.ts
related:
  - spec-cli/src/frozen-context.test.ts
  - spec-cli/src/frozen-context.native.test.ts
  - spec-cli/src/session-structured.ts
  - spec-cli/src/codex-harness.ts
  - spec-cli/src/sync/native-run.ts
---
# 不可变冻结上下文的按需读取

## raw source

结构化生成与独立审查必须完整接收冻结上下文。超大正文不应只因内联prompt大小而unsupported，也不能静默截断、读取live文件或凭模型声称已读。

## expanded spec

明确 Claude provider 的读取使用 [[claude-frozen-mcp]]，原不可变 manifest/readFrozenRange 响应及 requested coverage 共用，单段保守最多65536原字节。首次 prompt 准备即生成该计划，不能先产生 Codex 的262144字节 exec 计划再由 MCP 拒绝。原 Codex 索引、response、history 与旧 hash 不改。

固定 Claude CLI 的 `system/api_error` 仅在原生 `request_retry`、error 级别、合法重试计数/延迟及原错误摘要完整时作为链节点保留；同 session、非 sidechain/agent、唯一 UUID 且直接衔接实际链尾（含附件与连续重试）。成功证明和失败专用来源索引共用该投影，错误正文不进入模型输入、receipt、coverage 或输出资格；未知来源、断链、fork 与新用户轮继续拒绝。没有此事件的既有公开历史及成功 proof 字节不变。

Claude 采用显式500000字符和500000 MCP token上限，并核实际序列化文本长度；UTF8最坏JSON转义及两端边界扩展在保守段内保留。版本3 proof 明确 provider=claude-code，保存经精确原生 user UUID/promptId 主链配对的公开 tool_use/tool_result、当前 CLI/model 身份和 actual API request 索引。每个实际 API 请求必须关联本轮已核工具面的 shapeHash；首轮 tail 必须包含原 user canonical SHA，不能只比对 prompt/echo/history 三份副本。每条真实 response 必须逐字等于同一 readFrozenRange 的结果；原生并行调用若合并为 API user blob，先逐项核其公开 tool_result，再核递归键排序 canonical message SHA 与 request.tail/base/keep 边界及后续 assistant.requestRef。文件引用、截断、错误或只在服务端发送成功均不能作为可见性证明。仅排除真实私密 thinking 内容块及元数据，公开 tool_use.input 中名为 signature/thinking 的合法业务字段完整保留；不按全局键名删除。completed 重放以内容寻址原生见证绑定最终 output，并核原专属 history，不能发新 turn 或伪装 Codex dynamicToolCall/H。

同一原生轮的压缩只接受专属主链中的 system/compact_boundary：logicalParentUuid 必须是已观察的最近对话节点，runningTurnSends 的唯一 UUID 及 openerUuid 均精确等于原 user UUID。后续只读摘要须从该边界或其附件链连接，保持原 promptId，明确 transcript-only 且仅总结原 user UUID；保留段存在时，其两份完整 UUID 列表、首尾及摘要 anchor 必须一致，并对应压缩前已观察的连续父链。未知保留段形式、外来会话/sidechain、错 opener/parent/anchor、新用户轮均拒绝。摘要记录只保留公开消息摘要及身份标志；原生 API 若用 string 存储该同一摘要，仅按实际 API 的单个 text block 规范化并逐字核 canonical SHA。摘要不成为源码、工具回复、receipt 或读取覆盖；每次真实 reader 回复仍须有后续实际 API 消费，required 全文及 StructuredOutput 门槛不变。没有压缩事件的旧公开历史和 proof 保持原字段与摘要。

公开 Claude content 按原生 string 或 block 数组读取。原始用户正文为 string 时，仍要求 echo/history 原消息完全一致、正文逐字等于固定 prompt，实际首个 API 请求绑定该原消息的 canonical SHA；内容视图不能改写保存的 message、历史摘要或用数组 SHA 替代 string SHA。额外用户正文默认以明确 stale_result 拒绝；仅允许下述固定原生内部续接事件，不能仅因同 promptId、固定文案或 CLI success 获得新业务轮授权。tool_result 只接受原数组并继续核精确调用、全文及后续 API 可见性；未通过原生读取器摘要绑定的原始 string API blob 不可绕过审核。

固定 Claude Code 2.1.309 的非 subagent `truncated_response_recovery` 只接受其已核 producer 分支产生的原生 user string，正文逐字为 `Your response above was cut off mid-stream. Resume directly from where it stops — no apology, no recap. If none of it survived, answer the request from the start.`。必须同 session/promptId、isMeta===true 且 turnCompanion===true、无 sourceToolAssistantUUID，父节点精确等于此前最近的 actual assistant。两个 flags 仅在 raw 存在时保存进公开 witness，原 message/string SHA 不重写；historyDigest 和 completed 重放重新核原始 flags，缺失、篡改或假类型均拒绝。该事件不能伪装压缩摘要，不贡献 reader receipt 或覆盖。

同一固定版本的 `max_output_tokens_recovery` 另接受已核 producer 的唯一原生 user string：`Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`。复用上述全部身份、flags、主链与消费门槛，且原始 history 中直接父 assistant 必须为此前最近 assistant、其 message.stop_reason 精确为 max_tokens；不能借其他位置的截断事件。该原件校验不增加公开 witness 字段，成功证明也重新读取并核同一原生投影，不能用手造 witness 绕过。旧文案、无续接历史及其 proof 字节保持不变。每条续接仅授权其自身已观察的精确正文及合并形态，不能将另一允许文案的未观察 API 输入授予它。

每条续接必须由它出现之后的新 actual API request 消费，再由 assistant 精确 requestRef 引用；同文重复续接即使具有相同 API SHA，也不能借用此前请求或此前 assistant 的证据。允许保留原始 string API SHA，或将该正文精确映射为单个 text block 的真实 API SHA；合并 blob 继续逐项核已观察 tool_result，只接受精确续接 text，或已证的“原 prompt 加单个 LF”text 后紧接续接 text。未知附加/缺失文字、前后缀、额外 text block、JSON 包装的伪 tool_result 与不匹配 hash 均拒绝，不按 trim 或宽泛拼接归一化。已逐条经新 API/assistant 消费的续接遇到上述严格同轮压缩时，经过完整边界及摘要身份校验的 summary 可成为该代消费链的别名；string summary 的实际 text-array API SHA 仍须经原 compactSummaryDigest 对应确认。未消费续接不能借摘要取得首次消费资格，新续接不能继承前代别名，摘要仍不增加任何读取覆盖。其后请求继承该新消费链时仍须保留对应续接或已核摘要别名 SHA；续接后的 assistant 不能回引旧请求。每次续接清除先前最终输出资格，最终 StructuredOutput 调用必须在最后一条续接之后并引用有效的新请求，旧调用延迟回复不能恢复该资格；原 user UUID、首个 API 的原始 prompt 输入、固定工具/model、完整 required requested coverage、每条 reader 后续可见性及最终 output/digest 绑定仍独立成立。

公开 API user blob 的 CAS 声明不授予额外输入权。先按原字节、类型与 canonical SHA 登记内容，再对每条实际 API 请求按 base/keep/tail 重建的完整输入统一核来源，不依赖 blob 在续接之前或之后出现，也不依赖是否发生续接。user text 只能精确对应原 prompt、该时点已严格验证的同轮摘要、已观察合法续接及上述固定合并形态；tool_result 在声明与实际请求处复用同一原公开回复配对检查，可见性消息 SHA 只随实际请求消费绑定。未知正文即使在续接前已被请求消费、随后从输入删除，仍拒绝；不得过滤其 hash 后继续证明。合法 CAS 重复、提前声明原 prompt 或续接内容不等于提前消费，续接仍须由其后新请求独立使用。未被请求引用的合法字节声明可以保留，但不成为模型输入、receipt、读取覆盖或新业务授权。

公开 CAS 字节索引、actual API base/keep/tail 重建与原 tool_result 来源检查由成功证明和 [[claude-structured-runtime]] 的失败分类共用同一窄校验原语。失败分类不能以 schema 拒绝或 CLI 已停绕过实际输入来源；共享原语不提供跳过完整结果、读取覆盖或成功验收的开关，成功 proof 的字段、摘要和验收含义保持。

失败专用只读来源元数据依据固定 Claude 2.1.309 producer 的 `U5.noteLine`、`MRt`、`ORt`、`gue/NRt` 与 replay writer 静态核对（artifact SHA256 `5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c`）：string content 转单 text 块，消息摘要递归排序并省略 cache_control；连续 user 块累计，assistant 仅同明确 message.id 连续累计，每个已观察前缀登记 hash。writer 只在既有 transcript/CAS 索引未命中时写 CAS，不能要求每个消息必有独立 CAS，也不能把无 CAS 自动视为非 USER。

该索引仅返回每条实际 API 消费点之前的 digest、role、源 UUID、ordinal 和来源种类。非 USER 只接受明确 canonical CAS 或已观察 assistant 前缀；USER 前缀须按每个源 UUID 回到当时已认证的公开原 prompt/配对 tool_result 正文重组并重算摘要，opaque USER hash 不授予输入权。已停失败允许重建上述精确183字符max_output_tokens_recovery的来源，沿原始history核最近max_tokens assistant及原prompt身份，再由耗尽验证复用成功路径的精确plain/merged字节和新API/assistant消费证明。跨角色、未知来源、未来来源、错 hash/base/keep、foreign/sidechain、新 turn、fork、compact及其它recovery继续拒绝；元数据不输出或持久化原始消息、thinking 或签名，不贡献读取覆盖、witness、completed 或业务成功。原公开读取器、成功 witness/historyDigest 与完整 proof 验收保持不变。

实际 API 工具面之外的名字只能保留为原生明确未派发的拒绝事件：唯一 callId、session/user/prompt 与 parent/source assistant 完整配对，`is_error:true` 且公开回复逐字等于固定 CLI 的 `<tool_use_error>Error: No such tool available: 名字</tool_use_error>`；全文还须进入后续真实 API 并由 assistant 消费。专属 MCP 实际派发名与见证一致且只含唯一 reader，存在外部派发或日志矛盾即拒绝。拒绝事件保留原名及全文，不改名、不产生 reader receipt、不贡献任何覆盖；缺读取仍失败。普通工具错误、权限错误、未知回复、未配对结果、实际工具面扩张和 DeferredToolPlaceholder 调用继续拒绝。其后正确读取、完整覆盖、StructuredOutput 与停止证明仍须分别通过。

reader 的非法范围仍在读取正文前即时拒绝。同一原生轮中，只有独立重算同一冻结上下文/参数确实在范围边界抛出精确错误、公开 `is_error:true` 回复逐字匹配该错误、专属 MCP 无外部派发且后续 API 已消费错误时，才将它保留为无读取覆盖的参数拒绝事件，允许随后自行纠正。原意/entry 身份错误、正文摘要损坏、权限错误及未知错误不享有此例外；不能把失败请求算作已读。读取指引要求逐项照用计划 endByte，65536 只是最大跨度，不是短 entry 的结束位置。

[[structured-readonly-policy]] 的v2仍保留既有只读隔离，仅增加spex_read_frozen。源码树外0700目录存储内容寻址字节与清单；contextDigest绑定logicalentry、类型、SHA256、字节长度、required及业务requestKey/inputDigest。真实attempt/policy存在时额外严格绑定，普通结构化调用不编造身份。相同bytes去重，logical身份仍保留。

工具参数仅contextDigest/entryId/startByte/endByte，区间end-exclusive、每次请求不超过262144字节；binary base64、absence均显式处理。UTF8完整entry在冻结时严格校验；合法请求切入多字节码点时，解码区间向外扩至完整码点边界，两端最多各多3字节，包含全部请求字节，只允许重叠、不截断或替换字符。arguments、startByte/endByte与rangeSha256仍绑定原请求；仅确实扩展时，文本额外列decodedStartByte/decodedEndByte。原对齐响应的全文、字段顺序与摘要保持不变，binary行为不变。

只有实际扩展的解码使用ignoreBOM保留开头BOM码点，不能因解码器默认行为丢掉新增覆盖的字符；原对齐区间的既有BOM解码结果及持久响应摘要仍逐字节保持。

读取指令和工具说明必须明确下一次startByte取响应的原endByte；decodedStartByte/decodedEndByte仅说明显示文本的UTF8扩展，不能推进请求游标。真实1048576→1048578扩展仍须以1048576续读；用1048578续读造成的两字节requested缺口继续拒绝。

路径、URL、额外参数、错摘要、篡改、非法区间立即拒绝。模型索引不含控制路径。真实请求与回复全文及摘要先持久后回RPC；精确turn的真实native history再次核验arguments、completed/success、contentItems全文和required完整coverage，相同kind/SHA/长度可共享覆盖。coverage只累计原requested区间，不用扩展解码字节豁免缺口；精确响应仍由同一解码规则重建。生成/审查各自在自己turn取得完整证明。直接回归覆盖中文和emoji每个字节切点、相邻片段、完整coverage与隐藏缺口，以及旧对齐响应的全文和hash兼容。

prepareFrozenPrompt在创建或新资源计划摘要前将超过512KiB的完整正文转换为单个required UTF8 entry和短读取指令，保原inputDigest；较小且没有条目的正文保持v1。该保守阈值只选择无损传输，不截断或拒绝业务输入，避免1至2MiB正文仍超过原生RPC字符串上限。调用者也可给出通用纯 JSON `frozenEntries`：utf8 用 text、binary 用规范 base64、absent 无字节，不把 Buffer 放进会被 JSON 拷贝的请求。这些条目在同一 freezeContext 中按原 id/label/required 冻结；超阈值 prompt 仍另成 required `task`，条目正文不写入该 task。返回值和持久计划只留最终 ref，去掉条目载荷。已有 ref 原样返回，不重写 prompt、证明或绑定。相同绑定/内容返回稳定ref，重试不因随机路径改变幂等哈希。createAttemptRunner附加真实policy/attempt并保持业务requestKey，sessionCreateKey另承接正式派发键。provided ref在派发前严格校验绑定。普通结构化调用不编造 attempt/policy。

completed恢复读取精确native history不新起turn或重调用工具，已结算资源核保存history全文/hash和覆盖。断连inProgress的v2不重发旧RPC id，不造完成回执；沿既有cancelling/unknown保留容量，只有正式精确停止证明才允许新attempt。独立actualnative测试必须在专用realm完整覆盖大于2MiB的真实工具返回，并核首中尾内容、原生历史和无新调用恢复，不能把controlled RPC测试冒充实际模型证明。

新readerRuntime版本2另外冻结CLI版本、去工具provider catalog摘要和固定toolOutputTokenLimit；额度从本次不可变清单的真实entryId、长度及响应元数据推导：单次最多262144字节，UTF8解码最多增加6字节，JSON字符串每输入字节最多转义为6字节，binary按base64长度计；以完整inputText字节上界除4向上取整，并至少保留原生host默认10000额度。该额度进入runtime descriptor缓存、realm路径、execution及请求身份，不改provider catalog的模型容量声明。旧runtime版本1保留旧realm、配置和历史摘要，只能恢复已有精确turn，不能新起turn或获得版本2保真声明。

默认6.1-sol通过受限code-mode host中转reader。模型索引给出派生readBatches：每段仍是同一entry内最多262144字节的连续请求；只有相邻两段的真实JSON回复按ceil(UTF8字节数/4)计费后合计不超过当前固定额度N时才配成一批，每批最多两段，否则分开。required内容按kind/SHA/长度去重计划；optional条目仍可按需读取。计划只指导顺序，不增加工具参数或读取授权。每批使用一次exec，首行pragma设置H=ceil(1.2N)的execMaxOutputTokens；每条回复分别用text原样打印，不能拼接或包装。exec若返回running cell marker，必须用原cell_id调用wait并带max_tokens=H；yield_time_ms省略使用原生10000ms默认值，wait仍running时继续wait同一cell，完成前不得重读或推进批次。running marker不是读取正文；只有最终wait返回的完整文本才能作为可见读取证据。摘要、计数或模型声称已读都不能替代全文。

新runtime必须取得版本2读取证明：在既有精确原生history/required requested coverage之外，从原生Thread.path定位同一thread的rollout，并核session_meta中的thread/cwd；只提取同一turn公开exec的custom_tool_call/custom_tool_call_output，以及wait的function_call/function_call_output，分别要求同kind且同callId配对，不读取或保存私密推理。outer output保留原生形状，允许一个纯文本string或只含input_text的数组；image及未知类型拒绝。每条inner响应text必须与至少一条outer原始string或单个input_text逐字节整项相等；string中的状态marker不能代替缺失正文，本地reader receipt也不能冒充模型可见结果。string按一个文本项计费，数组按其中每项ceil(UTF8字节/4)累计；每个outer输出的全部文本不得超过其真实history_truncation_token_limit（rollout字段fallback_token_limit_override），该实际额度H必须等于固定配置N加原生20%序列化余量后向上取整。配对只基于两条真实inner响应的JSON文本费用之和不超过N，host余量覆盖外层header等文本；配置与runtime固定N不因配对改变。不能只凭pragma、未出现截断提示或完整rollout断言模型收到全文。公开outer证据单独内容寻址且保留字符串/数组形状，恢复重新核验同一正文及摘要；旧证明的字段、历史和hash不重写。

真实Native必须使用默认6.1-sol，在单次256KiB非空正文中取得不泄露答案的随机内部标记失败→通过对照，并逐字节核outer全文；再完整读取大于2MiB非空正文、核随机首中尾及精确恢复。中段标记必须位于片段内部，不能以片段边缘标记或空白填充掩盖中段裁剪；compatibility模型失败不能充作交付或更换默认模型。
