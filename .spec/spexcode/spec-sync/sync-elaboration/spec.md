---
title: 业务契约细化与追踪
status: pending
hue: 175
desc: 受限生成、结构检查、独立审查和有限修复；真实产品联合验收通过前保持待交付。
code:
  - spec-cli/src/sync/elaboration.ts#elaborate
  - spec-cli/src/sync/elaboration.ts#projectElaborationFlowReadiness
related:
  - spec-cli/src/sync/elaboration-orchestration.test.ts
---
# 业务契约细化与追踪

## raw source

从用户原意生成可完成主流程、适用状态事件处置、规则和验收；无法确认的重要业务政策成为 GAP，只阻塞依赖分支。

## expanded spec

范围映射：REQ-SYNC-03、04；P1；AC-SYNC-01、02、03、08、14、25。实施依据为 `docs/spec-code-continuous-sync-plan.md`，真实产品联合验收仍须独立完成，不能把本节点作为已同步证明。

构建者产出 REQ→FLOW/STEP→RULE/TR→code→AC，独立审查者从原意重新走路径。每个适用状态×事件必须明确转移、拒绝、幂等或有依据的不适用。覆盖权限、边界、竞争顺序与副作用。图和覆盖投影只能派生自 [[sync-contract-schema]]；无状态能力须说明输入域、不变量和不适用依据。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。

`elaborate` 接收冻结的目标路径、节点身份、原文字节及摘要、用户原意、已有契约和有来源的事实；生成、审查都调用受限只读结构化会话，返回完整 Markdown 候选，交付写权限仍属于协调器。候选不得越过目标范围、更换源摘要或改写用户原意；无明确变更依据时保留既有 REQ、AC、VERIFY 和验证政策。用户原意或可信裁决已决定退役或改变验证政策时，冻结 `authorizedChanges` 提供具体 ID、操作、来源及理由，程序允许该变化并由独立审查核对依据，无需再次批准。返回实际退役 ID，拒绝复用协调器提供的历史退役 ID；退役记录由后续协调交付持久化。新增裁决来源必须属于冻结事实或既有可信契约中的裁决 ID，不能由模型声明获得授权。每个业务项经来源与依赖能追到用户需求。

每轮先验证 [[elaboration-output]] 的结构，再调用 [[sync-contract-schema]] 解析与引用、完整性和状态矩阵检查；raw 段使用解析器的围栏感知结果，原文里的示例标题不成为正文分界。独立审查使用另一会话及线程，从原意、冻结事实、全部适用性和候选重新走路径。程序或审查的具体缺口触发有限修复；重要未知事实或业务冲突须先形成准确 GAP，不能自动编造政策消除错误。GAP 仅阻塞来源、规则和验收依赖闭包；确实位于同一 GAP 闭包中的未知状态事件处置和业务完整性发现保留为 `blockedStructureFindings`，独立流程仍由审查确认后输出可推进项。重复 ID、悬空引用、非法来源等全域结构错误不能借 GAP 豁免。

[[elaboration-result]] 保存各轮完整候选、生成与审查原始输出、具体发现、会话追踪及摘要。业务结构与独立审查通过后，根据 GAP 返回 `complete`、`needs_input` 或 `conflict`；安全能力不足为 `unsupported`，执行失败为 `failed`，取消为 `cancelled`，未消除失败且预算耗尽为 `exhausted`。总预算到期但原生停止未证实时，保留 `cancellation_pending` 原始错误和精确会话身份，结果为 failed；不得用 exhausted 掩盖未停稳或派发新原生会话。确认取消后，总预算才归为 exhausted。

这些均是细化阶段结果；`runtimeVerification: not_run`、`implementationReady: false` 不能作为已同步证据。尚无实现锚点或测试的具体缺口保留给 P2，不制造虚构 `code:` 或运行通过结论。

编排回归由 `AC-ELABORATION-01` 至 `AC-ELABORATION-31` 覆盖解析/矩阵/独立审查、状态缺支修复、语义发现修复、GAP 独立分支、冲突证据、路径/摘要/raw 边界、既有验收保护、无效结构与重复会话、待实现证据、伪造裁决、安全失败/取消、输入冻结、合法退役、验证政策演进、围栏原意、未知矩阵单元、调用/总时间预算、行 schema、固定格式渲染、幂等预算身份及字符/argv 转义、未停稳取消、证据支持的可覆盖默认超时、真实 GAP 候选的父流程聚合及已结算拒绝候选的摘要/输入/原生审查追踪核对、渲染升级和新独立审查，以及 GAP 仅影响 TR 时经派发步骤传递的父流程阻塞、旧种子在当前结构检查新增缺口后的准确修复反馈。注入 runner 仅用于控制这些编排路径；P1 的真实 Agent 自然语言细化验收仍由完整产品链路单独验证。
