---
title: 同步操作的固定模型选择
status: active
code:
  - spec-cli/src/sync/model-selection.ts
---
# 同步操作的固定模型选择

## raw source

用户选择“补齐模型选择入口，换用其他可用模型继续（推荐）”。正式同步允许选择可用模型继续执行；每个项目也可在版本化 `sync.model` 固定新操作的正式后端默认值，手动模型选择优先。缺省仍为 gpt-6.1-sol，选择不改变业务原意、预算、权限或独立审查门禁。

## expanded spec

新native-worktree工作流明确仅支持claude:<exact-model>与zcode:<provider>/<exact-model>，新准入对其它模型给unsupported，不自动回退到旧frozen或另一provider。优先使用已获授权的Claude模型；实际目录/Native可用性仍由原运行时核对。DEFAULT_SYNC_MODEL、旧缺字段sol身份及旧请求/retry模型继承均不改；项目或显式操作选择应指定支持的真实CLI。新工具描述v3同时绑定model与agentWorkflow，不能由旧v1/v2资料热升级。下文默认模型/供应商范围描述保留于历史无workflow操作。

`zcode:<provider-id>/<exact-model-id>` 明确选择 [[zcode-structured-runtime]]，provider 与 model 都作为固定身份核对，不接受自动别名或 provider fallback。它与 Claude/Codex 共用以下 admission/retryOf 规则，模型变化不改原业务意图和验收门槛。

sync run/verify 的 API 和 CLI --model 接受操作级模型选择。选择进入不可变 admission/payload/ingress 身份，同 requestId 改模型拒绝；普通重复业务请求不能靠新 requestId 换模型取得新预算或归并到另一模型，换模型必须经正式 retryOf。显式 retry 未指定模型时继承原操作，显式另选模型仍复用原 source/input/policy/readset/request/origin 并保持既有已批准 P1 义务。

缺省及显式 gpt-6.1-sol 统一为字段省略，其持久语义固定为该模型。旧操作不回写字段，不改旧 payload、receipt、fence；重启、恢复及同请求重放保持原选择。非默认模型的新操作使用带精确模型的 sync-tools-v2 固定运行描述，旧二进制只识别 v1 时明确拒绝执行；同时以既有 sync component v13 无DDL writer marker 在入口整体拒绝旧二进制，避免其绕过原运行描述派生 sol 重试；运行描述仅为能力/回滚门，选择权威仍为 operation。默认旧操作继续读原 v1。

新手动 run/verify 操作可显式选择模型覆盖项目默认；省略时同 request 的 prior 或 retryOf 原 operation 模型优先于当前输入冻结的版本化项目 `sync.model`，无 prior/retry 才使用项目值或 gpt-6.1-sol。相同 requestId 改模型拒绝；普通重复即使换 requestId 也不能改变模型或取得新预算，换模型须经正式 retryOf。自动观察、decide 和 revert 的新 operation 采用同一项目配置值。项目值作为精确字符串交给正式 runtime，不增加供应商白名单。旧 operation 缺少 model 字段仍固定为 gpt-6.1-sol；配置变化不能替换已准入模型或重置预算。

所有行为分析、P1/P2 及独立审查的真实结构化请求使用该选择，requestDigest、会话隔离及完整冻结读取证明照常绑定；是否可用仍由实际 native/catalog 校验。不增加自动 fallback、effort/UI 选择或全局默认变更，不把模型变化当业务政策授权。
