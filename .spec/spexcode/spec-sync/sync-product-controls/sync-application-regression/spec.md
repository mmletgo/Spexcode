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

故障 runner 为测试接缝，不算真实模型产品验收。完整真实 Agent/Docker 落地仍按 [[spec-sync]] 分阶段验收。
