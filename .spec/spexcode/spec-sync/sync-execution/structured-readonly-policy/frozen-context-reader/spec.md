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

Claude 采用显式500000字符和500000 MCP token上限，并核实际序列化文本长度；UTF8最坏JSON转义及两端边界扩展在保守段内保留。版本3 proof 明确 provider=claude-code，保存经精确原生 user UUID/promptId 主链配对的公开 tool_use/tool_result、当前 CLI/model 身份和 actual API request 索引。每个实际 API 请求必须关联本轮已核工具面的 shapeHash；首轮 tail 必须包含原 user canonical SHA，不能只比对 prompt/echo/history 三份副本。每条真实 response 必须逐字等于同一 readFrozenRange 的结果；原生并行调用若合并为 API user blob，先逐项核其公开 tool_result，再核递归键排序 canonical message SHA 与 request.tail/base/keep 边界及后续 assistant.requestRef。文件引用、截断、错误或只在服务端发送成功均不能作为可见性证明。仅排除真实私密 thinking 内容块及元数据，公开 tool_use.input 中名为 signature/thinking 的合法业务字段完整保留；不按全局键名删除。completed 重放以内容寻址原生见证绑定最终 output，并核原专属 history，不能发新 turn 或伪装 Codex dynamicToolCall/H。

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
