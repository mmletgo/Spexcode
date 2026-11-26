---
title: LLM Manager 宿主管理
status: active
code:
  - spec-cli/llm-manager/host.py
related:
  - spec-cli/src/llm-manager-host.ts
  - spec-cli/src/llm-manager-route.ts
  - spec-cli/llm-manager/requirements.txt
  - spec-cli/llm-manager/test_host.py
---
# LLM Manager 宿主管理

## raw source

用户要求由 LLM Manager 完全接管执行器管理。Claude Code 的 API 地址、Key 和模型，以及 Grok Build、Claude Code、ZCode、Cursor 和 Codex 原生 CLI 的功能组优先级，在同一份管理配置里维护。SpexCode 通过所登记的功能组调用实际执行器。

## expanded spec

宿主用绝对路径登记 `SPEX_LLM_MANAGER_PYTHON` 和 `SPEX_LLM_MANAGER_CONFIG`，在独立宿主数据库按 owner 使用 Manager 的 Provider、Key 和功能组。设置入口复用原 LlmSettings 组件，走同源、仅本机宿主管理授权的端点。浏览器读取只得到 Key hint。保存和测试使用 Manager 的公开方法，交易和秘密保管由宿主提供。组件与私有依赖在本机选装，公开发行的默认构建和未启用管理的宿主仍可工作。

宿主通过同一设置端点读写当前 owner 的全局调度时区。Manager 验证 IANA 时区，并用保存值判断所有 Provider 的周时段与节假日。首次选择前由历史 Provider 时区继续决定可用时段，保存 Provider 表单时保留该历史值。已有宿主在升级 Manager 依赖后、恢复服务前执行 `host.py upgrade <绝对配置路径>`。该命令通过 Manager 加入调度时区表，可重复执行。初始化新库时直接创建该表。

Manager 按功能组挑选已就绪路线。Claude Code 的 API 路线通过会话专属 loopback 转发连接兼容 Anthropic Messages 的 Provider，并由官方 Claude CLI 完成原有结构化工具执行。供应商 Key 仅留在 Manager 受控进程内，Claude 获得同轮临时地址和授权。其余受支持路线使用真实原生 CLI 及原生登录。模型缺省沿用原生 CLI，固定模型原样交给对应执行器。

API 冷却到期时，宿主用 Manager 当前候选路线的模型，以及同次试探请求的端点、协议和凭据发起探测。Manager 根据真实探测结果恢复该路线或继续组选路。现有操作新建托管会话时，宿主认证原准入路线与当前 owner 和功能组一致，再从该组首位选路。原准入路线的供应商配置发生变化时，只要其原归属仍能认证，就可为新会话选择同组当前健康路线。既有会话继续按所登记的路线执行。

准入冻结由 Manager 签名身份所绑定的 provider、模型、凭据版本与选项。持久的 model 只携带可区分的路由身份和 CLI 所需的公开模型，保留厂商命名空间，以便复用原生运行描述和证据。浏览器可见的路线状态不带 Key 正文。新结果、冷恢复、工作树、源快照、独立审查和 Git 交付沿原门禁，历史原生 model 原样读取。

同一轮正式派发在 Manager 登记组与 Provider 名额，确证原执行已结算后释放；无法证明停止的轮次保留名额及原先的停止债务。真实额度耗尽或 HTTP 429 交还 Manager 处理。显式正式重试由已登记功能组按当前路线与结算状态选路。同一候选续审可提供实际失败会话的身份，Manager 只接受该会话、该路线和同一功能组下已结算的额度记录。同步执行与正式验收可登记不同的通用功能组，共享供应商配置与凭据。主进程、浏览器响应、argv、记录、诊断和日志不带 API Key 正文。已冻结路线被撤销或配置版本不符时，该次调用明确失败。

原生 Claude 进程结束后，若最新正式 Messages 请求确实在上游响应头前超时，且原绑定和租约仍有效，宿主向 Manager 报告传输超时。Manager 的 Provider 健康策略用于之后的新派发，已登记会话继续使用各自的冻结路线。后续 Messages 覆盖较早请求的超时观察，token 计数、下游传输及本机故障沿各自边界。只有真实额度结算产生正式后继游标。
