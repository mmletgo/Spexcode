---
title: ZCode 原生冻结读取证明
status: pending
hue: 175
desc: 从同轮原始消息、模型请求与终态重建冻结读取，并以完整见证支持零派发冷恢复。
code:
  - spec-cli/src/zcode-frozen-proof.ts
related:
  - spec-cli/src/zcode-frozen-proof.test.ts
  - spec-cli/src/frozen-context.ts
---
# ZCode 原生冻结读取证明

## raw source

[[structured-session-runtime]] 的 ZCode 执行必须证明模型在精确一轮中收到全部冻结正文。MCP 账本只能证明工具服务端收到过调用，不能代替原生模型输入与输出；最终回复的 schema 验证和进程停止仍由执行器完成，重放重新绑定权威原生 JSON 正文。

## expanded spec

版本4证明绑定 provider `zcode`、精确 providerId/modelId、CLI version/SHA256、session/turn/inputId、prompt 摘要及完整原始见证摘要。从 `session/messages` 的原生 `info.id/sessionID` 与 `parts.id/messageID/sessionID/callID/tool/state` 建立关系，不接受声明 DTO 的 messageId/callId 冒充 core 字段。唯一原始 user 的正文、turn.started 的 input/messageId/inputId 和一次 send 的 session/content/inputId 必须一致；唯一原始输入以 real_user/user_prompt、realUser anchor 和可见性识别。只允许原生 environment/model/runtime_mode/date 四类 synthetic model-only 提醒，每类最多一条；其 semantics、anchor、metadata 来源与单个 text part 必须相符。额外真实或未知 synthetic user 输入、消息或调用身份重复、外来 session/turn 均拒绝。

安全事件保留原始 turn lifecycle、tool.updated，以及有 toolCount 的 ModelRequest session.updated；不保存 transport headers。每次实际模型请求的 provider/model 必须精确一致且 toolCount 为1；messageCount 按全部原生 user、此前 assistant 和已完成工具响应重建，总请求数须等于原生 assistant 数，调用只允许 `mcp__frozen__spex_read_frozen`，不把 workspace MCP 列表当模型可见能力。只接受同轮 completed/success、原 inputId 和完整 response；失败、取消或未终结不能产生证明。

每个原生 tool part 必须 completed，使用自身的完整 state.input/output，逐项匹配同轮 scheduled/result 事件。事件可以声明 inputOmitted/model_stream，因为参数权威来自原始 part；缺失 part.input 不能从 MCP 账本补齐。原始 part.state.metadata.serialization 与 result 事件均须未截断、原始/返回字节长度相等；事件结果必须 success、未遗漏且与 part 原文一致；任何参数、正文或工具篡改都拒绝。所有原生调用均须唯一配对，并按终态 anchor 的 assistant 顺序绑定第 i 次 ModelRequest：仅能在其所属 assistant 的生成请求之后派发，并在第 i+1 次请求前完成、由该紧邻后续请求消费。不能借用任意更晚请求，或把已执行工具搬到尚未生成的 assistant。

将严格核真的原生调用转换为共享 normalized history，调用 [[frozen-context-reader]] 的 proveFrozenReads 复用区间、字节摘要与 required 覆盖校验，不另造覆盖算法。historyDigest 继续绑定该标准化历史；完整原始见证另存冻结 histories 中的专属内容寻址文件，以 witnessDigest 绑定。冷恢复只读取这两份原证据，重跑同样验证并逐字段比对 proof；损坏、缺失、错身份或错模型不得回退为旧证明，也不得触发新 CLI、send 或工具调用。

完整公开 MCP JSONL 逐行原始记录及其 JSON 数组内容摘要纳入见证。逐一校验唯一 reader 的实际 tools/list、同 session/turn 的 tools/call、原参数与成功原文响应；请求和响应须一一配对，未配对、多余、未知工具或替代正文不能获得证明。该账本只交叉验证原生调用，不能补原生缺字段；process/startToken 与退出仍由执行器结算。

原生最后一条消息必须是终态 assistant，其 anchor.boundaryMessageId 等于自身，orderedMessageIds 逐项闭合完整原始消息 ID 序列，historyRoundCount 等于原生 assistant 与 ModelRequest 数。只从此边界消息的 text parts 重建终态正文并与 turn.completed.response 逐字相等；不能按正文搜索历史 assistant。同一 JSON 在工具前后合法重复时，仍只绑定最终边界。缺 anchor、错顺序、漏消息、外来边界或轮数不符均拒绝。

最终输出只接受严格 JSON 或唯一完整外层 JSON 围栏。共用 decoder 仅移除合法外围空白或完整 `json` 围栏，不抽取片段、不修改正文、不补字段。携带结果的冷重放从权威 terminal response 重新解码与 JSON.parse，整值比对 output；额外 prose、多段围栏、非 JSON 或另一个 schema 合法结果均拒绝。
