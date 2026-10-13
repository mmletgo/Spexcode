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

原生执行权威属于 [[structured-session-runtime]]，资源CAS与恢复记录属于 [[sync-store]]。createAttemptRunner复用runStructuredSession/cancelStructuredSession/readRecord和sessionIdForCreateKey。每个请求保存完整root/base/prompt/schema/input/purpose/timeout/model/effort摘要，reserveDispatch同键同载荷不重复计费；返回sessionCreateKey是唯一原生创建键，不另造会话ID。资源计划在调用前持久固定key、预期sessionId、原source input和当次durable attempt候选摘要；正文只进既有commonDir evidence blob。

只观察精确预期session ID，不扫session树或造第二队列。published record创建载荷和固定结构化策略匹配时资源进入created，即使仍queued、thread/turn未知；nativeStarted仅表示实际turn实锚已出现，不把queued当原生执行。thread/turn出现后同phase CAS保存实锚，只有当前fence可bindSession。错误身份或摘要拒绝，已绑定身份不可退回或替换。

暂停、取消、过期或新attempt替换时Abort精确调用，再通过正式取消入口与持久record核对nativeStopped。回执丢失可使用同精确身份的持久终态证明；普通错误、本地Promise结束或已发送interrupt都不证明停止，未知终态保留资源给恢复。

成功结果必须完整匹配原生session/thread/turn、schema与实际output hash，先保存完整terminal证据再removed；removed仅表示该turn执行容量结算，原会话和worktree历史保留。精确同键重入复用已持久结果，核blob哈希和完整请求绑定后重放，不再派发；未结算资源重入既有同键结构化执行或精确取消，不重复创建原生turn。旧generation只能登记资源观测，不能重新取得候选/验证/apply写权。

终态result或精确停止证明已持久、removed尚未登记的窗口可仅据内容hash核验的terminal证据补removed，不重复原生调用。外层request.inputDigest属于冻结推理请求，不冒充source snapshot id；资源inputId始终来自operation原source输入，candidateDigest从实际durable attempt获取。

创建已派发但会话尚未发布时，缺失 record 不能证明停止。同进程取消在固定预算内等待原创建事务；只有正式创建事务在 request-key 锁内完成清理、且 version/sessionId/requestDigest/payloadHash 与冻结计划一致的结构化终止收据才证明 notStarted。收据及精确停止事实先进入 terminal 再 removed；收据不存在、错配、创建仍在进行或清理失败时保留资源用于恢复。重启读取该精确收据即可结算，即使原 fence 仍有效也不再调用 runStructuredSession，不复活同键取消或重复计费。
