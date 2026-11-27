---
title: Grok Build 原生 ACP 协议
status: active
code:
  - spec-cli/src/grok-native-acp.ts
related:
  - spec-cli/src/grok-native-acp.test.ts
---

# Grok Build 原生 ACP 协议

[[grok-structured-runtime]] 的直连 ACP driver 在已登记的 Grok 进程上初始化，使用厂商声明可用的本机非交互认证方法，按原生默认顺序优先使用缓存会话，其次使用厂商的本机 API 认证。会话创建须回显原计划的会话 UUID 和物理工作目录。可选的显式模型与原冻结 prompt、schema 和 prompt UUID 随各自原生请求派发。驱动不操作凭据或进程组。

响应必须关联当前 JSON-RPC 请求，成功终态必须回显原会话及 prompt UUID。实际模型取同一响应的原生用量账本，结构化结果取同一响应的字段。合法终态缺字段时保留同一会话最后一次工具之后的助手文本，由运行时按原格式失败处理。匹配的原生 prompt 错误继续自然收尾，固定 HTTP 429 的供应商协议字段供运行时核验。终态触发真实 stdin EOF，持续验证 stdout EOF，其后的多余或不合规帧使原生协议失败。
