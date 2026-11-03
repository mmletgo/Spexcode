---
title: 原生结构化派发的持久资源桥
status: active
hue: 175
desc: 将协调派发、固定原生会话身份、运行观测和真实终态证据连接到既有结构化会话执行。
code:
  - spec-cli/src/sync/native-run.ts
related:
  - spec-cli/src/sync/native-run.test.ts
---
# 原生结构化派发的持久资源桥

## raw source

协调尝试的原生推理必须在调用前登记意图，取消、过期和进程重启后仍能核对与结算实际执行资源，而不能只相信本地Promise完成。

## expanded spec

原生错误携rejectedOutput时，仅在本资源精确record为failed、证据与错误相同且固定创建请求/schema/input/purpose/thread/turn逐项一致后，经现有blobIO保存完整被拒final原文字节，并携原文ref/SHA传回；不读取provider协议目录。原error/code/身份保持，资源停止仍走原正式结算，不因诊断取得成功或removed。旧无证据不扫描补读。

真正新建的 Claude/ZCode worktree 资源在 reserveDispatch/requestDigest/plan 之前冻结 nativeConfiguration:cli-config-v1，ZCode read 工具策略独立冻结。已有 resource 只沿原 plan.request 的字段或缺席；仅 reserved 的冷恢复先核调用者完整请求摘要；上一代只冻结 ZCode 工具策略的请求可经原工具策略重建，但只有完整摘要精确匹配原 dispatch 才保留其原配置缺席。字段参与资源 payloadDigest 与创建 execution 哈希；不能重签旧 plan/receipt、补旧缺席或只凭 key 采纳。显式变更配置、model、source/input、prompt、schema 或 seed 仍经原完整摘要拒绝，预算和停止门禁保持。

新 ZCode worktree read 资源在 requestDigest/plan 登记前冻结可选 zcodeToolPolicy，策略见 [[zcode-structured-runtime]]；已登记资源只从原 plan.request 恢复其字段或缺席，显式换策略拒绝，不能给尚无 Native session/send 的旧请求补工具控制。恢复仍完整核其余请求、原 payloadDigest 与创建哈希。worktree 与 frozen 请求统一保留业务 requestKey，并通过已有 sessionCreateKey 传递精确原创建键和已冻结语义；inputDigest 不改，NativeRunPlan schemaVersion 保持1。

reserveDispatch 已提交而 resource 尚未登记的冷恢复窗口同样属于已冻结请求：只有调用者完整请求 hash 精确等于原 dispatch.requestDigest 时，保留该请求的原工具字段或缺席；否则按当前规则重建后仍须经原 reserveDispatch 的完整 digest/purpose 校验，绝不只凭 key 采纳或清空策略。旧缺席与新已冻结 policy 都保持原 requestDigest、sessionCreateKey、callsUsed；prompt/schema/worktree 等任一变化仍拒绝，不能创建 Native 或重发旧 turn。

新操作通过plan.agentWorkflow=native-worktree-v1及sync-tools-v3固定工作流。各阶段请求携明确worktree:{baseCommit,tree,mode}，复用原资源桥、创建键、预算、取消与terminal→removed；不再prepareFrozenPrompt、不安装frozen reader、不要求frozenReadProof。固定策略由真实结构化运行时version6提供，创建及恢复的payload hash使用同一nativeWorktreePrompt纯函数，base为精确seed。成功及冷重放都核result.worktree精确seed/baseTree、真实HEAD tree及祖先关系，并与durable resultWorktree逐字一致；只读阶段HEAD/tree保持seed。历史worktree关闭后只核保活Git对象和原Native终态，不要求目录仍在，也不重派发。旧无工作流标记的操作与既有已持久frozen请求继续按下文原策略恢复，不能补签读取proof冒充新工作树结果。

模型调用 timeoutMs:null 原样进入固定请求和资源计划，取消/创建清理等待仍保持独立最多15秒预算，不能对null执行Math.min而变为零等待。精确nativeStopped与terminal→removed门禁保持。

明确 ZCode 版本4只进入 [[zcode-structured-runtime]]，不准备 Codex reader catalog。新结果和已结算资源重放都核对 [[zcode-frozen-proof]] 的精确 provider/model 与原始输出，沿用同一 reserveDispatch、sessionCreateKey、完整 terminal→removed 和正式取消，不另建队列或伪装其它执行器。

执行器选择只由已冻结 model 命名空间进入 [[structured-session-runtime]]；Claude 版本3结果还核对明确 provider/model 的原生 proof，不准备 Codex reader catalog。共享资源计划、checkpoint、完整 terminal→removed、预算、sessionCreateKey 及恢复门禁保持同一份，旧已持久 Codex 请求和 proof 原样重放。

原生执行权威属于 [[structured-session-runtime]]，资源CAS与恢复记录属于 [[sync-store]]。createAttemptRunner复用runStructuredSession/cancelStructuredSession/readRecord、sessionIdForCreateKey和正式创建恢复入口recoverSessionCreateTermination。每个请求保存完整root/base/prompt/schema/input/purpose/timeout/model/effort摘要，reserveDispatch同键同载荷不重复计费；返回sessionCreateKey是唯一原生创建键，不另造会话ID。资源计划在调用前持久固定key、预期sessionId、原source input和当次durable attempt候选摘要；正文只进既有commonDir evidence blob。

传输阈值更新不能改变已登记资源的固定请求。仅当该 attempt/key 已存在 resource，且调用者除 signal 外的完整请求摘要精确等于原 plan.payloadDigest 时，沿原请求恢复，不再转换 prompt 或重新准备 reader runtime。新请求或摘要不匹配仍执行正常冻结、完整绑定和同键异载荷拒绝；不能只凭 key 跳过摘要。旧大 inline 请求可在已 aborted 的正式恢复中只取消并结算到 removed，原计划、会话身份、callsUsed 不变，不重新调用 native；显式新 retry 使用当前 reader 阈值。

只观察精确预期session ID，不扫session树或造第二队列。published record创建载荷和固定结构化策略匹配时资源进入created，即使仍queued、thread/turn未知；nativeStarted仅表示实际turn实锚已出现，不把queued当原生执行。thread/turn出现后同phase CAS保存实锚，只有当前fence可bindSession。错误身份或摘要拒绝，已绑定身份不可退回或替换。

暂停、取消、过期或新attempt替换时Abort精确调用，再通过正式取消入口与持久record核对nativeStopped。回执丢失可使用同精确身份的持久终态证明；普通错误、本地Promise结束或已发送interrupt都不证明停止，未知终态保留资源给恢复。

成功结果必须完整匹配原生session/thread/turn、schema与实际output hash，先保存完整terminal证据再removed；removed仅表示该turn执行容量结算，原会话和worktree历史保留。精确同键重入复用已持久结果，核blob哈希和完整请求绑定后重放，不再派发；未结算资源重入既有同键结构化执行或精确取消，不重复创建原生turn。旧generation只能登记资源观测，不能重新取得候选/验证/apply写权。

终态result或精确停止证明已持久、removed尚未登记的窗口可仅据内容hash核验的terminal证据补removed，不重复原生调用。外层request.inputDigest属于冻结推理请求，不冒充source snapshot id；资源inputId始终来自operation原source输入，candidateDigest从实际durable attempt获取。

创建已派发但会话尚未发布时，缺失 record 不能证明停止。同进程取消在固定预算内等待原创建事务；只有正式创建事务在 request-key 锁内完成清理、且 version/sessionId/requestDigest/payloadHash 与冻结计划一致的结构化终止收据才证明 notStarted。收据及精确停止事实先进入 terminal 再 removed；收据不存在、错配、创建仍在进行或清理失败时保留资源用于恢复。重启读取该精确收据即可结算，即使原 fence 仍有效也不再调用 runStructuredSession，不复活同键取消或重复计费。

仅`session_create_timeout`的精确未启动receipt在终态与`removed`均已提交后映射为`SettledSessionCreateTimeoutError`，让上层区别已清理的创建期限耗尽与普通timeout。此错误携带原receipt，仍保留原调用与预算计数；一般执行超时、caller取消、已启动或未证明清理不得转换为该类别。同一资源从`removed`重放，或从`terminal`恢复到`removed`时，须重新核验canonical receipt后保留相同子类；不重派发旧sessionCreateKey。

原创建调用已结束或重启后的取消恢复没有本地创建 Promise 时，桥可按冻结计划向 [[session-create-authority]] 请求精确候选清理恢复，再重读 canonical record 与正式终止收据。桥不把 Promise 结束当成证明，不自行删除 Git/FS 资源；正式入口拒绝未知/错配/已发布候选时资源仍保留。清理完成后仍经同一 terminal→removed 与完整收据校验，不增加调用次数；另一个创建者锁内发布的会话转走正式原生取消路径。

恢复参数携带同一次冻结推理的结构化策略，由正式创建入口重建外部runtime候选路径；缺少该策略不得把结构化收据解释为普通主checkout内候选。路径仍由创建事务内部推导，资源桥不接受任意恢复目录。

冻结读取的业务 requestKey 与清单绑定保持不变，内部 sessionCreateKey 承接 reserveDispatch 返回值；实际 attemptId 与 policyDigest 存在时在派发前严格核对，冻结 ref 及读取证明参与计划和原生固定策略摘要。调用者携带的纯 JSON frozenEntries 由 prepareFrozenPrompt 在 reserveDispatch 与计划摘要之前、用本次真实 attempt/policy 冻结；这里不解析行为 JSON，也不按 code-behavior 写分支。持久 plan 只保存去掉条目载荷后的最终 ref。调用者除 signal 外的请求摘要与原 payloadDigest 精确相等时，沿原 prompt、hash 和策略恢复，不重新准备、不重写旧证明。未知工具响应或未证实原生停止继续保留资源，不把本地报错作为释放容量的依据。

已aborted的清理观察只更新精确资源checkpoint；即使旧业务fence仍有效，也不调用authority/reserveDispatch/bindSession或登记新plan，不改变attempt业务状态。原NativePlan/创建键、session/thread/turn、结果与停止证明仍逐项核验，真实未停止或未知继续保留资源；没有收据不能靠缺席伪造nativeStopped。正常未aborted执行的业务绑定与预算门保持。

仅独立资源入口通过非持久runner选项禁止精确取消主动drain队列；原request/NativePlan摘要、candidate刷新与停止证明保持，普通runner和cancel默认不变。

已认证rejectedOutput原文是UTF8诊断artifact，保留精确ref/SHA/text及原失败身份；它不具有JSON stage角色，即使正文可解析且伪装sync-stage-v1也不能取得阶段、候选或引用可达权限。只读恢复以原failed观察与canonical失败/后续精确cancelled停止记录核验，不把后续清理改签为原通过。

已失败且 canonical record 确证 nativeStopped 的资源与成功资格分离：沿原计划/创建键、请求摘要和 session/thread/turn 重核原错误、packet 与可选 failedWorktree，再保存 failed terminal→removed；同键或 terminal 冷恢复重放原失败且不重发。failedWorktree 仍须原 request/seed、已拒 final 和不可变 Git 对象验证，不成为成功 result。Native checkpoint 保留 packet 正文/SHA，Saved round 原子发布前不授独立 raw ref 可达权；live/cold 出站错误可物化精确 ref，不能修改历史 checkpoint 或跳过 owner/round 认证。typed RPC 仅在当前 run/有效 fence、全部派发资源精确 removed、故障 request/dispatch/plan/候选与原 stop 三方一致时为协调器提供已结算资格；未知、错配、旧缺席不得推断或补签。
