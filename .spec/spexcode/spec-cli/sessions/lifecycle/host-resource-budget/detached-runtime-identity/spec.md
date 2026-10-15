---
title: Detached runtime identity and positive death proof
status: active
desc: 统一核验 detached PID、启动身份、receipt 和内核进程组存活事实。
code:
  - packages/spec-core/src/process-identity.ts
related:
  - spec-cli/src/process-identity.test.ts
---
# Detached runtime identity

## raw source

共享原生 runtime 的身份和死亡必须有正面证据，不能将查不到身份当作已停止并释放保护资源。

## expanded spec

启动 receipt 严格绑定 PID/startToken 与同 PID 的进程组 leader；Linux session 也须等于该 PID。存活核验复用同一宿主进程适配边界，Windows 的 detached 身份与死亡证明不受支持。

死亡与不能证明存活不是互补关系。适配器的单个 liveness 探针对正 PID 或负进程组返回 present/absent/unknown；宿主仅以 kill(0) 成功证明 present，ESRCH 证明 absent，EPERM 或任何其他查询错误均为 unknown。仍为原 startToken 的 PID 不算死亡；原 PID 已明确 absent，或已由不同 startToken 证明复用，且原进程组明确 absent，才证明 gone。无效或错 PID/group/session 的 receipt、缺失或未知查询以及任何残留进程组成员都拒绝。证明只读，不发送信号终止进程、不修改 receipt。

直接回归使用可注入适配器覆盖 unknown、权限拒绝、错 receipt 和残留组；真实专用 detached 子进程退出证明完整进程组消失。该测试证据不替代现场原生业务操作恢复。
