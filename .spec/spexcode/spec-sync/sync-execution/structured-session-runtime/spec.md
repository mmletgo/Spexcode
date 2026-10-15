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

传输断连保留 running 身份；重试通过原启动队列恢复该 thread/turn。丢失 turn 接受回复时，只有唯一初轮且用户输入匹配冻结 prompt 才可恢复。不得从历史最后一条 assistant 消息猜测结果。读取持久结果再次检查输入/schema/策略、精确身份及结果摘要，拒绝旧输入或损坏结果。取消先持久化 `cancelling` 撤销结果发布，再中断原生 turn，禁止迟到结果改写终态。

本节点只交付结构化推理接缝；返回的文本差量由同步协调器负责验证与落盘，不代表上层 [[sync-execution]] 的 P2 完整交付已完成。

每次结构化请求发布或复用会话后，runner 显式向原启动队列登记该精确候选 ID，再请求 drain；嵌入调用不依赖 Dashboard、index 或文件 watcher 通知。maxActive=1 时，不同请求键的生成、修复和独立审查可以连续实际启动并完成。已经结算的结构化会话保持原 awaiting/nothing 历史与 offline 投影，普通人工会话的 awaiting 资源语义不变。取消或超时标记仍禁止后续派发；断连的 running 请求继续按原精确身份恢复。

`cancelStructuredSession(sessionId, { reason?, timeoutMs? })` 是结构化取消入口，返回精确 session/thread/turn、nativeStopped、acknowledged、nativeStatus 和未证实停止的 error。queued 或明确尚未发送首轮的请求可以证明 notStarted，无需进入普通 adapter 的无 thread 控制路径。已经接收的请求只控制其持久的 generation/thread/turn；收到 interrupt ACK 后仍须读取同一个 turn 的终态才能证明停止。原生首轮接受后的空 rollout 属于有限预算内的启动竞争，允许在 generation fence 内重读，不视为空闲。已自然结算的精确 turn 无需再次 interrupt。

精确 session/thread 与 generation binding 一致时，取消复用 [[shared-runtime-generation-rotation]] 的只读 close 解析。原 detached 进程组已由 [[detached-runtime-identity]] 正面证明消失，即使 ledger 尚未 reclaimed，也可持久结算 nativeStopped/generationGone；不发送 RPC、不启动或恢复 native、不替换绑定。原失败首轮只有 thread 而没有 turnId 也适用。缺失或不匹配绑定、错 receipt、PID 查询未知、仅 socket 消失或残留进程组仍保持 pending，不能从错误字符串或原生缺行推断停止。

结构化 record 的固定 policy 唯一决定其 Codex control realm：v1 使用 `structured-read-only-v1/control`；v2 使用 `structured-frozen-read-only-v2/<readerRuntime.catalogDigest>/control`。创建登记、恢复、取消以及后续 close 都解析同一 realm，并继续核对精确 session/thread/generation binding；另一个 realm 中看似匹配的 binding 不能替代。

AbortSignal、caller 超时与显式取消使用同一持久取消协议。确认停止后 cancelled/timeout 为 offline 并允许下一请求使用容量；拒绝控制、连接中断、generation 身份失效或 ACK 后仍 active 时，保持 cancelling/unknown 和原容量保留，返回 cancellation_pending。调用方可以重试取消取得真实结算证据；不得 kill 共享 realm，不能仅凭已发送 frame、RPC ACK 或 caller 截止宣称模型停止。断连 running 的原恢复语义不变。

跨进程取消共用独立的原生控制互斥；控制 RPC 不占用会话 record 锁，observer 可以保存身份并结束。取消开始及结算均在短 record 事务内重读当前记录；同一精确原生身份的 nativeStopped 终态证明不能被迟到的开始、失败、超时或 observer 诊断降回 cancelling。已收到 ACK 的历史也在重试中保留，返回结果来自实际持久结算。已绑定的 thread/turn 不能被不同迟到身份替换；同一身份的补全仍可保存。外部取消完成后，原 caller 撤销本地观察，新的无 Dashboard 进程可从持久证明释放容量并派发不同请求键。损坏的取消状态仅通过正式取消入口重读精确原生终态恢复，不手工清除容量或改写记录。

原生精确 turn 接受后，在保存 turnId 的同一 record 事务中发布 canonical active；Board 显示 working，不能继续显示 queued。结构化启动及运行不依赖普通 daemon 的 liveness census：active/running 保守投影 unknown 并预留容量，精确结果结算后才 offline；断连 error 与显式 queued 恢复沿用原恢复入口。取消中的迟到身份补全不能重新发布 active。

精确原生执行与本机结果 observer 的存活分别记录：队列在短 record 事务中以 PID/startToken 领取 observer 身份，正常退出释放为 null；此运行字段不参与固定请求摘要。同键调用看到仍存活的 observer 仅等待原持久结果。observer 已释放、明确死亡或 PID 已被不同启动身份复用时，同键新进程通过原队列恢复同一 thread/turn；缺失或无法验证 owner 的 running 状态不得当作死亡抢占。两个恢复进程只允许一个领取观察，既有 turn 不再发送 turn/start。native 仍运行或已完成都可恢复精确结果，completed 同键回放保持原身份与摘要；恢复不调用普通会话 resume，也不扩大固定只读策略。

结构化创建期间取消或超时、尚未发布会话时，正式创建事务完成清理后保留精确 SessionCreateTermination。错误包含该收据的预期 sessionId；同键重放返回原取消/超时，不进入队列或重新创建。创建事务等待锁时被取消不能生成他人停止证明；清理失败不提供 nativeStopped。上层只能用匹配固定请求的收据结算尚未开始的资源。

提供 frozenContext 时采用 [[structured-readonly-policy]] 的 v2 冻结读取，清单参与固定请求摘要；内部 sessionCreateKey 仅承接已持久 reserveDispatch 的原生创建身份，业务 requestKey/inputDigest 保持清单绑定。真实工具请求与回复证据先持久再发送，最终必须核验精确原生历史及完整覆盖。未答动态请求的恢复不能伪回执，改由既有取消协议确认精确turn停止；确认前不得释放资源。
