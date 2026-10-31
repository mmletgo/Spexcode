---
title: ZCode 原生结构化执行
status: pending
hue: 175
desc: 在同一结构化会话管线中运行隔离的 ZCode，绑定原生消息、实际模型工具面和完整进程停止。
code:
  - spec-cli/src/zcode-structured.ts
related:
  - spec-cli/src/zcode-structured.test.ts
  - spec-cli/src/zcode-structured.native.test.ts
---
# ZCode 原生结构化执行

## raw source

沿 [[structured-session-runtime]] 的队列、资源桥和取消接缝，增加已实测 ZCode 的最小结构化执行器；不派生第二套业务协调器，不降低 [[frozen-context-reader]] 的完整读取证明门槛。

## expanded spec

只接受 `zcode:<provider-id>/<exact-model-id>`。当前能力固定 macOS ZCode CLI 0.17.1、CLI SHA256 `9afd565a104d660259e6bdeeaa5cb8abc74a908559e21aa3c5f6a06f2a9da6c6` 和公开 builtin provider SHA256 `e537b380df05656e3757c2b220ae1044fe8a32c0ac148de265a05a94cc24b3a9`，未知版本、摘要、平台或模型别名明确拒绝，不 fallback。策略为 version4 / `zcode-frozen-read-only-v1`。

每次派发使用专属空 workspace、私有 HOME / ZCODE_DATA_BASE_DIR 和 `/private/tmp` 下短 TMPDIR。固定配置关闭 plugins、hooks、skills/includeInstructions、memory、subagent；child-only 的两个 provider config 环境变量显式引用公开 builtin 与原 personal provider config。现有 credentials 只通过私有 home 的只读符号链接供 SDK 正常消费；控制器不读取、复制或记录凭据字节。父环境仅传必要 PATH，不继承其它配置或认证变量。

外层 Seatbelt 对 app-server 及全部 MCP 后代生效：只允许专属 runtime 与 tmp 写入；配置、profile、reader-input、冻结正文和 workspace 不可写。发送前以真实文件写入和 Unix socket bind 预检同一 profile；长路径 socket 失败不通过扩大权限修补。

使用现有只读 reader 的 legacy MCP，唯一 allowlist 为 `mcp__frozen__spex_read_frozen`。create 显式绑定 workspace、provider/model、immediate persistence 和关闭标题生成；runtime preferences 全关闭。仅一次 send，固定 session/input/query 身份；ACK 不是 turn 终态。每次实际 ModelRequest 必须精确 provider/model、toolCount1。未知或认证 server request 一律拒绝，不读取其参数或保存传输头。

原始 session/messages 的 core info 与 parts、原始 turn lifecycle / tool.updated / 含 toolCount 的 ModelRequest 安全事件构成原生见证；不以 ledger 补写 native arguments。transport 及未知事件只保存类型计数，不保存 payload 或 headers。原生工具、消息、输入、模型和 MCP ledger 必须由专用证明模块严格绑定。

终态仅接受本轮 success，响应可以是直接 JSON 或一个完整、精确的外层 `json` Markdown fence。decoder 只移除该单一外壳，正文仍使用 JSON.parse 和原 Ajv schema；不得修补 JSON、接受解释文字或多段输出。规范 JSON 结果绑定原始终态响应与完整见证。

先捕获原始消息，再精确 session/close:true 与 EOF，确认自有 detached 进程组及全部已观察 app/MCP 子进程死亡，才写 completed。MCP startToken 缺失时使用宿主 ps 的精确 PID/start 身份补证，不伪造 reader ledger。completed 冷重放核原请求、原始见证、schema、proof 与 durable output，零新 SDK/API；未知 in-progress 不追加 prompt，保留 cancellation_pending。

取消沿原协调入口撤销发布权。活运行向同 session 发 stop，核 ACK 后仍要求精确 turn 终态与 idle；关闭后仍核全部进程。冷取消只允许原固定 plan、PID/start/receipt 的专属 runtime，精确 TERM 后核进程组与 MCP 全亡；未知身份不操作，不以 ACK、leader 退出或迟到 output 释放容量或发布结果。

普通测试覆盖命名空间、精确 fence decoder、事件安全投影、固定能力配置和冷取消身份；真实 native 测试必须显式环境开关，默认不得运行模型。当前节点保持 pending，直到正式产品 A/B 证据及门槛全部成立。
