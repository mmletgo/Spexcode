---
title: 原生派发资源桥针对性回归
status: active
hue: 175
desc: 用真实SQLite与可观察原生运行接缝验证持久意图、身份、取消和重入边界。
code:
  - spec-cli/src/sync/native-run.test.ts
---
# 原生派发资源桥针对性回归

## raw source

资源桥必须证明实际记录与数据库协议之间的故障窗口可恢复，不能把模拟结果称为真实LLM完成。

## expanded spec

受控 ZCode 真实创建/队列/Git 结算复现已接受 turn 的 EPIPE。原公开失败和 exit=0、idle=false、closed=false、acknowledged=false 经正式肯定停止后成为 native_turn_transport_failed，原 canonical/CAS 与完整请求身份在同键冷重放保持，派发数不增加。EACCES 保持普通失败，错 session/turn/input 与未知停止无此资格，取 events 的 RPC 超时仍使用原错误类型。

隔离真实SQLite及受控runtime覆盖新Claude/ZCode worktree冻结nativeConfiguration:cli-config-v1、旧plan与仅reserved缺席、上一代工具策略已冻结但配置仍缺席的完整摘要恢复；schema/prompt/purpose/tree/配置篡改均不得派发。dispatch/requestDigest/plan/payload及callsUsed原绑定保持。同一真实创建/queue/fake CLI集成核新配置进入创建哈希、正常Git提交及冷完成不重发；已认证格式失败确证停止后自动removed，cold replay保原错误而不改为cancelled。此证明使用专用私库与进程级fake CLI，不访问真实provider。

被拒final回归用真实SQLite及受控runtime逐项拒绝session/thread/turn/input/schema/prompt/purpose/SHA、未settled或record缺证据；匹配原failed record才生成可读原文字节ref，legacy无字段不补且不把诊断当removed。实际Git/正式创建队列与MockNative组合另证syntax/schema两种失败完整正文进入下一实际send、候选仍null和同键不重发；此证据不冒充真实LLM通过。

有限与null请求均通过精确取消/回执丢失场景结算原资源，null的取消清理预算仍为15秒；未知停止不释放容量。

验证派发前持久计划、published但thread未知、精确thread/turn绑定、完整结果证据、同键无重复调用与计费、同键不同载荷拒绝、结果/record身份与hash错配拒绝、未知原生终态不removed、取消回执丢失与旧fence资源结算、已结算结果blob核验重放、精确同键恢复不另造会话。真实原生Agent全链路验收由上层负责。

命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/native-run.test.ts`；相关lint与typecheck沿用sync目录约定，不运行无关完整套件。

已覆盖terminal写入后本地失败的无重复重放、旧source被superseded后的精确Abort/stop、已冻结candidate资源绑定、调用前已aborted的notDispatched证明，以及取消回执丢失仍保存已确认终态。测试仅验证真实SQLite和可观察runtime协议；不宣称真实LLM或真实原生RPC已执行。

创建阶段覆盖真实 Git target-resolution 与 worktree-add 后被取消：锁等待者取消不能替已取得创建权的事务写收据，worktree/branch 清理完成后方可结算资源。新进程同键重放取消收据且不同载荷拒绝；取消资源恢复不重派发、不增预算。未证实停止继续保留容量，收据版本、session、request、payload、清理与 nativeStopped 任一错配都拒绝。真实 Git fail→pass 验证仍不代表真实模型已经执行。

结构化创建timeout回归使用受控runtime证明：精确`session_create_timeout` receipt通过现有身份、清理和notStarted门后，只有`terminal→removed`提交完成才发出`SettledSessionCreateTimeoutError`，错误携原receipt且同键dispatch/callsUsed不重复。removed重放和terminal→removed恢复重新核验canonical receipt后保持子类；receipt缺失、字段/cleanup错配或Native thread/turn已出现时不产生该类型，资源保持原未结算/已启动阶段。

真实 Git 清理失败和 10 秒截止中断后重入正式恢复：已有精确候选收据才可继续，已移除候选重读确认后结算；调用次数与预算均不增加。源 checkout 的 staged/unstaged 内容、index 以及另一个用户 worktree 逐字节保留。候选后来出现 unstaged/staged/untracked/ignored 内容时恢复拒绝并保留原文件；撤去测试新增内容后原候选可正常清理。并发 canonical publication 持有同 request-key 锁时恢复不得抢先，发布后即使 envelope 缺失仍拒绝 notStarted 清理。

所有真实结构化创建取消/重启恢复都携带原冻结策略，核对同一外部runtime候选收据；不能以普通checkout内目标冒充原候选。

检查后竞争使用真实 Git 命令复现：worktree remove 完成后外部重建同路径内容、分支在删除前前进时均拒绝结算并保留文件或引用；撤去竞争后同键恢复通过，正常 reference-transaction hook 可观察删除。两种拒绝及成功恢复均保留源 checkout/index、其它用户 worktree 与原调用预算。

冻结读取回归另外验证业务requestKey与实际sessionCreateKey分离、真实attempt/policy绑定、派发摘要前自动无损冻结超大prompt、稳定引用同键重入、精确native history proof保存与removed重放核验。此文件使用受控runtime接缝；真正原生大于2MiB读取和能力隔离证据由 [[frozen-context-reader]] 的独立native测试承担，不混称为LLM验收。

1至2MiB旧 inline 资源回归固定完整请求、dispatch及真实SQLite资源后，以已 aborted 的原请求重入，核对只取消原精确会话并推进 removed、无新 run、callsUsed 不增、计划摘要不变。旧fence仍有效时也必须零authority/reserveDispatch/bindSession/planResource，原operation/attempt业务记录不改。同 key 修改正文仍拒绝，不能借旧资源跳过新请求冻结或摘要核验。该前置资源是明确夹具，不冒称原生模型交付。

固定非默认 terra/high 运行通过原完整 frozenReadProof 接缝，plan/requestDigest及实际结构化记录均保精确模型；同key换模型或published record模型错配拒绝。此为受控runtime协议证明，不冒称实时容量或真实LLM完成；操作选择属于 [[sync-model-selection]]。

纯JSON frozenEntries经真实资源桥绑定当前attempt/policy，派发前转换为不可变ref，保存计划不含正文载荷；重启与terminal重放继续使用原请求/证明，不增加调用或预算。小prompt也可有显式冻结条目，旧已有ref及旧inline恢复不被新传输重写。

资源-only 保留回归使用真实 Git 候选与真实 SQLite 资源计划，确认只有显式选项传入创建恢复；严格认证 v2 preserved/cleanupComplete:false 的原收据和物理身份后 terminal→removed，不调用模型/新会话、不增调用预算、不改变原 pause/attempt/failure。terminal 和 removed 冷重放都重新认证 canonical receipt，伪造/缺失/错配或当前 session 的 Native 已启动均拒绝，未结算资源继续保留；原场地保留不能变成清理或采纳证明。

真实queue/SQLite/Git桥中，受控Claude exit0/success缺structured_output必须失败为typed格式错误，原文缺席但实际正常提交可成为failedWorktree；资源先terminal再removed，同键冷重放无新CLI/预算/record变化。合法schema坏final原packet继续同门续修；completed损坏、错session/user/turn、非零退出/signal及未停稳保持拒绝。
