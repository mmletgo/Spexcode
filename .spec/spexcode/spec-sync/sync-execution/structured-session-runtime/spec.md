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

`runStructuredSession` 接收冻结 prompt、object JSON schema、输入摘要、用途、请求键、超时和可选 model/effort，返回 sessionId、threadId、turnId、output 与结果摘要。输入树必须属于当前 backend 项目，可指定 base commit。生成和审查分别使用不同请求键与原生上下文；安全约束见 [[structured-readonly-policy]]。

策略/schema/输入/预算参与幂等哈希，公开会话创建对象不能注入安全策略。相同载荷复用同一结果，不同载荷拒绝。同一连接在初轮前订阅，原生 thread 与 turn 接受后立即持久化；只读取精确 turn 的 completed 与 final_answer。失败、取消、超时、缺失结果、非法 JSON 或 schema 不符不算成功，创建后失败包含已知的会话和原生身份。

传输断连保留 running 身份；重试通过原启动队列恢复该 thread/turn。丢失 turn 接受回复时，只有唯一初轮且用户输入匹配冻结 prompt 才可恢复。不得从历史最后一条 assistant 消息猜测结果。读取持久结果再次检查输入/schema/策略、精确身份及结果摘要，拒绝旧输入或损坏结果。取消中断原生 turn 并禁止迟到结果改写终态。

本节点只交付结构化推理接缝；返回的文本差量由同步协调器负责验证与落盘，不代表上层 [[sync-execution]] 的 P2 完整交付已完成。

每次结构化请求发布或复用会话后，runner 显式向原启动队列登记该精确候选 ID，再请求 drain；嵌入调用不依赖 Dashboard、index 或文件 watcher 通知。maxActive=1 时，不同请求键的生成、修复和独立审查可以连续实际启动并完成。已经结算的结构化会话保持原 awaiting/nothing 历史与 offline 投影，普通人工会话的 awaiting 资源语义不变。取消或超时标记仍禁止后续派发；断连的 running 请求继续按原精确身份恢复。
