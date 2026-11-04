---
title: Claude 专属冻结 reader 桥
status: active
hue: 175
desc: 仅将不可变reader暴露为单一stdio MCP，并在回复前保存完整公开请求与响应。
code:
  - spec-cli/src/claude-frozen-mcp.ts
related:
  - spec-cli/src/claude-structured.native.test.ts
  - spec-cli/src/frozen-context.ts
---
# Claude 专属冻结 reader 桥

## raw source

派生自 [[claude-structured-runtime]] 的单一 reader 隔离与 [[frozen-context-reader]] 的不可变字节合同；只提供宿主桥，不增加生成、审查或业务政策。

## expanded spec

只注册 spex_read_frozen，复用原 manifest/ref 和 readFrozenRange，不接受模型路径、URL 或其它宿主操作。参数仍为 contextDigest/entryId/startByte/endByte，最多65536原字节。工具声明 anthropic/maxResultSizeChars=500000，回复还核实际字符长度，不能返回文件引用或摘要来绕过上限。

完整公开 RPC 请求与响应先保存再发送，但 RPC id 仅是传输相关键；它不冒充 native tool_use.id，也不提供模型可见证明。真实可见性和主链覆盖由上层 Native history 重新核验。进程身份在专属 runtime 留存，必须和 CLI 同一已证明消失的进程组一起结算。

宿主另核每个桥自记 PID 已停止；Seatbelt内无法取得 startToken 时不伪造身份，只以明确 ESRCH 证明该 PID 缺席。PID仍在而身份未知时保留 pending，不因缺 token 推断死亡，也不能向它发信号。
