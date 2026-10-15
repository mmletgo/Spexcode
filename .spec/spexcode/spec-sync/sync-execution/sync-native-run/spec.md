---
title: 原生结构化派发的持久资源桥
status: active
hue: 175
desc: 将协调派发、固定原生会话身份、运行观测和真实终态证据连接到既有结构化会话执行。
code:
  - spec-cli/src/sync/native-run.ts
---
# 原生结构化派发的持久资源桥

## raw source

协调尝试的原生推理必须在调用前登记意图，取消、过期和进程重启后仍能核对与结算实际执行资源，而不能只相信本地Promise完成。

## expanded spec

原生执行权威属于 [[structured-session-runtime]]，资源CAS与恢复记录属于 [[sync-store]]。createAttemptRunner复用runStructuredSession/cancelStructuredSession/readRecord、sessionIdForCreateKey和正式创建恢复入口recoverSessionCreateTermination。每个请求保存完整root/base/prompt/schema/input/purpose/timeout/model/effort摘要，reserveDispatch同键同载荷不重复计费；返回sessionCreateKey是唯一原生创建键，不另造会话ID。资源计划在调用前持久固定key、预期sessionId、原source input和当次durable attempt候选摘要；正文只进既有commonDir evidence blob。

只观察精确预期session ID，不扫session树或造第二队列。published record创建载荷和固定结构化策略匹配时资源进入created，即使仍queued、thread/turn未知；nativeStarted仅表示实际turn实锚已出现，不把queued当原生执行。thread/turn出现后同phase CAS保存实锚，只有当前fence可bindSession。错误身份或摘要拒绝，已绑定身份不可退回或替换。

暂停、取消、过期或新attempt替换时Abort精确调用，再通过正式取消入口与持久record核对nativeStopped。回执丢失可使用同精确身份的持久终态证明；普通错误、本地Promise结束或已发送interrupt都不证明停止，未知终态保留资源给恢复。

成功结果必须完整匹配原生session/thread/turn、schema与实际output hash，先保存完整terminal证据再removed；removed仅表示该turn执行容量结算，原会话和worktree历史保留。精确同键重入复用已持久结果，核blob哈希和完整请求绑定后重放，不再派发；未结算资源重入既有同键结构化执行或精确取消，不重复创建原生turn。旧generation只能登记资源观测，不能重新取得候选/验证/apply写权。

终态result或精确停止证明已持久、removed尚未登记的窗口可仅据内容hash核验的terminal证据补removed，不重复原生调用。外层request.inputDigest属于冻结推理请求，不冒充source snapshot id；资源inputId始终来自operation原source输入，candidateDigest从实际durable attempt获取。

创建已派发但会话尚未发布时，缺失 record 不能证明停止。同进程取消在固定预算内等待原创建事务；只有正式创建事务在 request-key 锁内完成清理、且 version/sessionId/requestDigest/payloadHash 与冻结计划一致的结构化终止收据才证明 notStarted。收据及精确停止事实先进入 terminal 再 removed；收据不存在、错配、创建仍在进行或清理失败时保留资源用于恢复。重启读取该精确收据即可结算，即使原 fence 仍有效也不再调用 runStructuredSession，不复活同键取消或重复计费。

原创建调用已结束或重启后的取消恢复没有本地创建 Promise 时，桥可按冻结计划向 [[session-create-authority]] 请求精确候选清理恢复，再重读 canonical record 与正式终止收据。桥不把 Promise 结束当成证明，不自行删除 Git/FS 资源；正式入口拒绝未知/错配/已发布候选时资源仍保留。清理完成后仍经同一 terminal→removed 与完整收据校验，不增加调用次数；另一个创建者锁内发布的会话转走正式原生取消路径。

恢复参数携带同一次冻结推理的结构化策略，由正式创建入口重建外部runtime候选路径；缺少该策略不得把结构化收据解释为普通主checkout内候选。路径仍由创建事务内部推导，资源桥不接受任意恢复目录。

冻结读取的业务 requestKey 与清单绑定保持不变，内部 sessionCreateKey 承接 reserveDispatch 返回值；实际 attemptId 与 policyDigest 存在时在派发前严格核对，冻结 ref 及读取证明参与计划和原生固定策略摘要。未知工具响应或未证实原生停止继续保留资源，不把本地报错作为释放容量的依据。
