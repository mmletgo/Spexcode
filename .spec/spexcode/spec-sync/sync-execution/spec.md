---
title: Spec 驱动隔离执行与完整交付
status: pending
hue: 175
desc: 已提供受控 Spec 请求、隔离生成、验证与完整交付；外部保存监听及最终落地策略继续扩展。
related:
  - spec-cli/src/spec-body-edit.ts
  - spec-cli/src/sessions.ts
---
# Spec 驱动隔离执行与完整交付

## raw source

合法 Spec 保存后自动补齐逻辑、调用已有 Agent、更新代码和测试，验证成功后交付完整候选。

同步交给 Agent 的是变更部分相关 Spec 和明确任务。Agent 在独立 worktree 中正常查阅仓库、完成修改；不限制其读取内容，不要求分块读取或逐字模型消费证明。修改经独立审查和真实验证通过后自动落地。

## expanded spec

范围映射：REQ-SYNC-01、06；P2；AC-SYNC-01、02、03、12、16、17、21、23。实施依据为 `docs/spec-code-continuous-sync-plan.md`。受控保存和显式运行通过 [[sync-application]]、[[sync-generation]]、[[sync-coordinator]] 与 [[sync-private-delivery]] 自动交付实际 Spec、代码和测试；外部文件事件的持续接入、主分支最终门禁及全量范围仍受后续阶段约束。

执行前先满足 [[sync-coordination]] 的隔离、generation、范围校验、journal 与回声安全原语。程序限制实际 diff 和适配器写权限，不能只靠提示词。生成失败在有限预算内修复，不改弱原始需求或验收。统一候选含 Spec、代码、测试与映射。协作输入树只回写生成差量并保持用户 index；非协作外部输入树不后台改写，实际受管交付树自动落盘。main dirty 保留完整结果等待落地。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。


### 原生工作树 Agent 接缝

分析、细化、实现规划、构建和独立审查共同复用版本化会话执行、创建事务、幂等请求键、启动队列和资源结算。新同步任务使用原生工作树策略：任务说明只包含本次变化、相关 Spec/接口路径、目标和约束，Agent 可用真实 Claude Code 或 ZCode 的正常文件与命令能力自行查阅，不再通过冻结 reader 分块取正文。JSON 仅是需要机器结果的阶段的输出格式，不代表限制 Agent 的正常读取能力。

每次派发绑定不可变 seed commit 及其精确 tree。分析使用受控请求已组合的输入，细化叠加对应已审上下文，构建使用已审 Spec，独审使用最终候选；不能只从来源 HEAD 创建而遗漏受控正文，也不能从当前 index/WIP 拼接后来的内容。相同输入摘要但可见 tree 不同的结果不能复用。分区共享同一 operation、fence、预算和最终 candidate，Agent 的自由读取不扩大实际写入范围。

构建者在自己的工作树真实修改代码和测试并正常提交，可信层从实际 Git 对象及差量导入候选，不接纳模型自报文件内容作为实际修改证明。独立审查使用另一工作树及会话，结果发布前须确认其候选未被审查者修改。只更新 Spec 的代码提交方向继续禁止 code_generate，并逐项保持全部源码及测试的 path、mode、OID 与 absence。

会话请求、模型、阶段 seed、原生身份、结果摘要及实际输出 commit/tree 共同形成可恢复证据。失败、中断、超时、非法结果或未确认停止均不能产生成功；显式取消撤销后续发布并通过原控制协议结算精确进程。旧只读策略及读取证明仅用于原固定请求的历史恢复，不能改写为新工作树结果。

实际工作树修改仍须经过 [[sync-coordinator]] 的契约演进、原测试保护、独立审查、V1–V4、真实 Docker、严格 Git journal/receipt 和正式采纳。通过全部门禁且主树干净时按既有原子 landing 规则自动合并；主树脏、版本过期或资源未知则保留真实结果等待处理。Agent 声称完成或自行提交不等于已同步。
