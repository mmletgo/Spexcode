---
title: 结构化推理固定只读策略
status: active
hue: 175
desc: 独立清洁 Codex 配置及经过探针验证的外层隔离，禁止继承宽松 launcher、shell、MCP、apps 与 hooks。
code:
  - spec-cli/src/session-structured-policy.ts
related:
  - spec-cli/src/session-structured.test.ts
  - spec-cli/src/frozen-context.test.ts
  - spec-cli/src/codex-runtime-generations.ts
---
# 结构化推理固定只读策略

## raw source

生成和独立审查只能读取协调器提供的冻结上下文并返回 JSON。Agent 不能修改源码、交付树或用户配置；没有安全能力时明确失败，不能退回宽松执行。

## expanded spec

内部固定策略为 codex-read-only-v1。独立 CODEX_HOME 仅包含可信配置及既有认证文件的只读安全引用；不读取、复制或打印认证字节，不继承用户 config 或 launcher 的 yolo/bypass 权限。配置关闭 shell、code mode、多 Agent、MCP、apps、plugins、hooks 和 web search；在模型 turn 前检查有效只读/never 策略、禁用特性以及零 MCP/hook 工具。

macOS 外层 Seatbelt 对 app-server 及全部后代实施写入限制。runtime 的 rollout/cache 可以写入，coordinator 控制文件、固定 config/auth 引用、源码树、交付树与用户配置保持不可写。原生 daemon 仅获准写本 generation 的精确 socket/lock 和日志，不放开整个共享 socket 目录。启动前必须真实 probe 运行目录可写且外部文件不可写。

Codex 原生 readOnly 策略保留，P1 使用提供正文的纯推理，不依赖嵌套 sandbox 中的 shell。新旧 generation 继续复用现有持久 ledger 和 detached receipt。未验证等效隔离的平台返回 unsupported，P4/P5 继续建设与验证；安全预检失败不得 fallback，也不能当作已完成同步。

冻结读取策略 codex-frozen-read-only-v2 保留相同 readOnly、never、零 shell/MCP/apps/hooks 权限，只注册一个 spex_read_frozen 动态工具。清单以内容摘要绑定业务 requestKey、inputDigest 及实际存在时的 policyDigest/attemptId；源码树外的私有目录保存不可变内容寻址字节，逻辑 entry 与内容摘要分别保留。模型只能提供 contextDigest、entryId 和 end-exclusive 字节区间，不能提供路径、URL 或读取 live source。UTF-8 区间必须保留字符边界，binary 使用明确 base64，absence 显式返回；缺失、篡改、错身份或错摘要拒绝。返回字节和请求摘要在回复前持久保存。

最终结果必须从精确 thread/turn 原生历史的真实动态调用 arguments、completed/success 和完整 contentItems 重新核验，所有 required 内容需要完整区间覆盖，相同 kind/SHA/长度的逻辑条目可以共用覆盖。生成和独立审查分别取得自己原生 turn 的完整覆盖，不能借用另一 turn 的回执或模型声称已读。恢复已完成 turn 只核历史，不能重调用工具。断连后仍有未答动态调用时，旧RPC id不再可用；保留未知资源，沿既有精确取消机制停止后以新attempt重试，禁止伪造历史回执或盲目重发。

默认gpt-6.1-sol通过原生code-mode host中转动态调用；单纯开启host会暴露apply_patch、图片和goals，不能作为冻结读取策略。v2独立realm仅对经过真实探针验证的Codex0.160.0启用受限host，code_mode仍false，禁goals/view_image/image_generation/sleep/tool_suggest/current_time_reminder/asyncuserinput/tokenbudget。clean metadata子realm只调用typed model/list、不创建thread/turn；只提取其原生provider模型metadata，保相同实际模型所有信息，仅清空apply_patch_tool_type和experimental_supported_tools工具能力。冻结catalog的SHA、CLI版本和控制路径进入固定execution与资源计划，预检/恢复校验内容与版本，变更不可沿用旧证据。模型不能写catalog/config；无受验证版本、目录或隔离证明时明确unsupported。

原生能力探针必须亲读custom exec代码与返回值：registry只有注册reader；process/require/fetch/module不可用，Node/HTTP/data动态import拒绝，constructor不取得宿主process，任意path/live诱饵不可读、任意写入与子进程不可达，网络诱饵0命中。metadata临时daemon只有在零native references且精确PID/start/receipt证实后才停止，停止确认后保存来源/前后目录摘要和changedFields，不能操作既有v1或其他generation。错误工具请求未获回复时沿cancelling保留容量，不能因本地快速失败就声称原生已停止。
