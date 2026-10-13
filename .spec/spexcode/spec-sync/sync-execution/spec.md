---
title: Spec 驱动隔离执行与完整交付
status: pending
hue: 175
desc: 待实现 — Spec 驱动隔离执行与完整交付，证据与产品验收完成前不宣称交付。
related:
  - spec-cli/src/spec-body-edit.ts
  - spec-cli/src/sessions.ts
---
# Spec 驱动隔离执行与完整交付

## raw source

合法 Spec 保存后自动补齐逻辑、调用已有 Agent、更新代码和测试，验证成功后交付完整候选。

## expanded spec

范围映射：REQ-SYNC-01、06；P2；AC-SYNC-01、02、03、12、16、17、21、23。实施依据为 `docs/spec-code-continuous-sync-plan.md`，当前绑定和真实产品证据尚待实现，不能把本节点作为已同步证明。

执行前先满足 [[sync-coordination]] 的隔离、generation、范围校验、journal 与回声安全原语。程序限制实际 diff 和适配器写权限，不能只靠提示词。生成失败在有限预算内修复，不改弱原始需求或验收。统一候选含 Spec、代码、测试与映射。协作输入树只回写生成差量并保持用户 index；非协作外部输入树不后台改写，实际受管交付树自动落盘。main dirty 保留完整结果等待落地。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。


### 结构化只读 Agent 接缝

P1 的生成与独立审查通过 `session-structured.ts#runStructuredSession` 复用会话创建事务、幂等请求键、启动队列和 Codex headless app-server/generation。内部安全策略、输出 JSON schema、输入摘要、用途、模型与预算共同进入创建载荷哈希，公开 session-create HTTP 对象不能指定这些内部权限字段。同键同载荷回放精确结果，同键不同载荷拒绝。结构化 prompt 保持原字节语义，不解释普通会话命令或 `@parent:` 指令。

协调器提供冻结上下文正文，Agent 只推理并返回 JSON。固定 `codex-read-only-v1` 配置不继承 launcher 的宽松权限、用户 config、MCP、apps、plugins 或 hooks；shell、code mode 与多 Agent 执行关闭，启动前检查有效配置及零 MCP/hook 工具。macOS 外层 Seatbelt 保护源码树、交付树和用户配置，允许独立 runtime 的 rollout/cache 及精确 daemon socket/log 写入。认证通过既有系统认证文件的只读安全引用复用，不读取、复制或打印凭据。外层写入探针必须通过；暂未验证等效隔离的平台明确返回 unsupported，后续 P4/P5 继续补齐与验证，不能声称全平台完成。

初轮开始前就在同一连接订阅事件，持久化 thread/turn 后只读取该精确 turn 的最终回答及完成状态；失败、中断、超时、丢失最终回答或 schema 不符均不算成功。断连重试恢复原 thread/turn，不重复发起模型 turn；接受回执丢失时，仅唯一初轮且用户输入与固定 prompt 一致可恢复，不从任意历史最后一条 assistant 消息取结果。结果及摘要持久化，读取时复核输入/schema/策略与结果摘要。取消先撤销后续结果发布并中断精确 turn。返回的文本变更只有协调器能够写入交付树；本接缝不证明 P2 的完整隔离交付已完成。
