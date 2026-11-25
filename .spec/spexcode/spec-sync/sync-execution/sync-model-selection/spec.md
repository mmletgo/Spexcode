---
title: 同步操作的固定模型选择
status: active
code:
  - spec-cli/src/sync/model-selection.ts
related:
  - spec-cli/src/sync/model-settings.test.ts
---
# 同步操作的固定模型选择

## raw source

新原生工作树同步优先使用宿主启用的 CLI 功能组。无宿主选路时默认使用 Claude Code。原生执行沿用用户 CLI 的认证、base URL 与模型配置，显式模型原样传递。每次记录真实执行信息用于审计与恢复。

正式同步允许选择可用模型继续执行。每个项目可在版本化 `sync.model` 固定新操作的正式后端默认值，手动模型选择优先。旧操作缺省仍为 gpt-6.1-sol。选择不改变业务原意、预算、权限或独立审查门禁。

宿主启用 LLM Manager 后，由同一功能组管理 API 供应商、凭据、模型、原生 CLI 和正式选路。SpexCode 在原工作树、独审和交付门禁内启动所选执行器。完整宿主合同见 [[llm-manager-host]]。

## expanded spec

已结算的原生代码→Spec 候选可用显式 retryOf、新模型和原预算继承继续独审。原结论按实际派发模型和原件认证，需补的独审以新模型和新请求执行。交接依照 [[sync-coordinator]] 的同候选资格，原来源、业务范围和验收条件保持。

新 native-worktree 操作在没有显式选择、项目模型或宿主选路时固定请求选择 `claude:default`，由 Claude CLI 原生配置决定实际模型，执行时不传 `--model`。显式 `claude:<模型或别名>`、`zcode:<provider>/<模型>` 原样交给对应 CLI，`zcode:default` 使用其原生默认值；模型和 CLI 版本没有产品允许名册，实际协议或模型不可用时报告原生错误，不自动换执行器。新请求冻结 `nativeConfiguration: cli-config-v1`；每轮实际 CLI 与模型信息由适配器独立记录和校验，不把默认或别名强行当成实际模型。DEFAULT_SYNC_MODEL 与旧缺字段 sol 身份不变，同 request 及省略 retry 继续继承已持久请求选择，不热改历史。新工具描述 v3 绑定请求选择与 agentWorkflow；旧 v1/v2 按原协议恢复。

`zcode:<provider-id>/<model-id>` 明确选择 [[zcode-structured-runtime]]，用户选择交给原生 SDK 解析，实际 provider 与 model 绑定当轮结果。它与 Claude 共用以下 admission/retryOf 规则，请求选择变化不改原业务意图和验收门槛。

`grok:default` 选择 [[grok-structured-runtime]] 并沿用本机 Grok Build 配置。`grok:<模型或别名>` 原样交给 CLI。只接受新原生工作树请求。正式 retryOf 可以显式选用 Grok 并继续原冻结意图。

`cursor:default` 选择 [[cursor-structured-runtime]] 并沿用本机 Cursor CLI 配置。`cursor:<模型或别名>` 原样交给 CLI。启用 llm_manager 的宿主功能组将 Cursor 放在首位时，已就绪的 Cursor 路线优先。

`--model llm-manager` 和 `sync.model: llm-manager` 选择 [[llm-manager-host]]。启用完整宿主管理的新原生工作树操作在登记的功能组准入，并保留原准入身份。项目的原生默认值仍供未启用完整管理的宿主使用。相同请求和未另选路线的正式重试复用原准入绑定。每个真正新建的托管原生会话，包括独审，从同组首位按当时的可用性选路。首选路线冷却期满且通过 Manager 的恢复核验后，可承接下一次新派发。原已预留派发、进行中的会话及其观察、重放、恢复和结算保持该次冻结的执行路线。显式 Manager 重试仍锚定原功能组。遇到已结算的额度失败，Manager 以实际失败派发为游标选后继，后继用于重试操作的首个新会话。其后新会话重新从原组首位选路。

工作台在已启用完整管理的宿主显示 LLM Manager 的当前可用路线和同源设置入口。默认执行器、API 地址、模型和凭据通过同一管理界面保存。设置变更作用于后续新派发，既有操作和冻结结果维持各自已保存的身份。

P1 独审因已结算的 Manager 额度失败时，在原 operation 的下一次尝试从失败会话所在组取得其后继。继续审查通过结构门的同一份 Git 候选。每个分区沿自己的独审记录取后继，原作者、输入和预算保留。组内无可用后继时保留候选及原因。

sync run/verify 的 API 和 CLI --model 接受操作级模型选择。选择进入不可变 admission/payload/ingress 身份，同 requestId 改模型拒绝；普通重复业务请求不能靠新 requestId 换模型取得新预算或归并到另一模型，换模型必须经正式 retryOf。显式 retry 未指定模型时继承原操作，显式另选模型仍复用原 source/input/policy/readset/request/origin 并保持既有已批准 P1 义务。

历史缺省及显式 gpt-6.1-sol 统一为字段省略，其持久语义固定为该模型。旧操作不回写字段，不改旧 payload、receipt、fence；重启、恢复及同请求重放保持原选择。非默认模型的新操作使用带精确模型的 sync-tools-v2 固定运行描述，旧二进制只识别 v1 时明确拒绝执行；同时以既有 sync component v13 无DDL writer marker 在入口整体拒绝旧二进制，避免其绕过原运行描述派生 sol 重试；运行描述仅为能力/回滚门，选择权威仍为 operation。默认旧操作继续读原 v1。

新手动 run/verify 操作可显式选择模型覆盖项目默认。省略时，同 request 的 prior 或 retryOf 原 operation 选择优先于当前输入冻结的版本化项目 `sync.model`。无 prior/retry 才使用项目值、宿主原生选路或当前工作流默认值。相同 requestId 改选择拒绝；普通重复即使换 requestId 也不能改变选择或取得新预算，换执行器或选择须经正式 retryOf。自动观察、decide 和 revert 的新 operation 采用相同默认判据。显式 CLI 模型原样交给正式 runtime。旧 operation 缺少 model 字段仍固定为 gpt-6.1-sol；配置变化不能替换已准入选择或重置预算。

行为分析、P1/P2 及独立审查的真实结构化请求按各自的正式派发身份校验 requestDigest、会话隔离及完整冻结读取证明。托管派发使用当次 Manager 选定的路线。非托管派发沿已准入的操作选择，由实际 native/catalog 核验可用性；显式另选执行器通过正式 retryOf 重新准入。
