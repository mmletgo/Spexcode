---
title: 同步应用回归
status: active
hue: 175
desc: 临时 Git/SQLite 验证受控请求、幂等、失败查询和过期输入。
code:
  - spec-cli/src/sync/application.test.ts
---
# 同步应用回归

## raw source

真实 Git 与 SQLite 必须证明不先提交 Spec、不重复受理、不虚报失败或旧版本结果。

## expanded spec

AC-APPLICATION-01 验证配置缺口、enable 摘要 CAS 与配置字节保留；02 验证 no-op 不派发、不提交及过期正文拒绝；03 验证 requestBlob 进入 coordinator、请求幂等/键冲突、失败查询及 source/HEAD 保留；04 验证输入过期、旧输入恢复拒绝及配置变化失效；05 验证共享治理叶闭包及宿主命令拒绝。

06 使用真实 Docker、compiled CLI 和正常 Git hooks 交付完整候选，source 不被覆盖，completed 重放沿原共同基线，不重复 native/commit，工具索引丢失只恢复相同 frozen runtime；模型 runner 为确定性替身，不能算真实 LLM 验收。07 验证并发同请求只有一个 runtime/operation且预算不重置；08 验证 queued 资料缺失可查询恢复诊断、原描述恢复成功、已派发操作在原描述丢失后禁止重冻结。

09 验证显式 callTimeoutMs 只来自 operation 冻结配置，live 修改不扩大旧请求或总预算；10 验证已启用后删除、坏 JSON 或越界配置保持 invalidated，恢复原字节才恢复 enabled，不允许自动降级普通独立 Spec 提交。

11 验证 initial 来源真实执行、持久入账和同键改来源拒绝；12 用同仓库两个真实 Git worktree 和 OS 互斥锁验证 FIFO、busy 无自旋及后继来源接续；13 验证已出队暂停恢复先等待有效 FIFO，前序结算后自动恢复，wait 等真实执行，预算不重置；14 验证两个仓库共享 canonical SQLite 时各自派发，不能执行或被另一仓库消息头堵塞。

15 验证普通重复归并、显式 retry 关联新操作/预算及同 retry 幂等；16 验证完整继承原 requestBlob/正文意图及旧共同基线，禁止新 patch 或旧来源变化；17 验证 queued 不可借 retry 重置预算，从未交付 cancelled 可经真实 FIFO 明确重试。

18 用真实 SQLite 注册 native 创建结果未知的固定 plan/checkpoint，验证已失败/暂停但资源未 removed 时 executionAvailability 为 recovery_required，retryEligibility 拒绝新预算。创建故障为明确测试接缝，不代表实际模型或未知宿主进程已验收。

19 验证 recover 对 queued 不派发、不改 operation/control/预算/输入、不消费有效 FIFO；20 用真实 store conflict 事件验证 conflicted + 未结算资源不能 ready，再恢复固定且未曾请求 native call 的资源，保留冲突、attempt和预算，配置失效也不阻清理。恢复已创建 native 或 Docker 的真实案例仍由 coordinator 的资源恢复验收覆盖。

21 注入内容可寻址但 native 身份不匹配的固定恢复计划，验证 coordinator 的具体 resource_recovery 以可见 409 返回，原业务 operation/attempt/预算及未释放资源保留，不只打印日志。

故障 runner 为测试接缝，不算真实模型产品验收。完整真实 Agent/Docker 落地仍按 [[spec-sync]] 分阶段验收。
