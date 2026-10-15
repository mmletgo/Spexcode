---
title: 目标创建前中断恢复回归
status: active
desc: 真实创建进程中断后，只在从未发布的完整边界证明下结算未启动资源。
code:
  - spec-cli/src/session-create-pretarget-recovery.test.ts
related:
  - spec-cli/src/sessions.ts#recoverSessionCreateTermination
---
# 目标创建前中断恢复回归

## raw source

原生后台创建中断不能永久占用尚未启动的资源，也不能将未知候选或已发布会话误判为未启动。

## expanded spec

真实 sessionCreateRequest 在 target-resolution 开始处随进程退出，下一进程持同一请求键、冻结载荷和结构化策略调用正式恢复入口。只有从未初始化 canonical 地址且无原生登记、目录、worktree、分支、session store 或候选拥有权时，原双锁才允许写精确 notStarted 终止收据；同键创建重放返回同一终态，不发布会话或启动原生调用。

路径内未知用户文件、已有分支或 store、异常私有收据、错误载荷和已有 canonical 地址全部保留且不出具证明。候选资源锁竞争先等待原持有者，锁内重读其新建内容后拒绝恢复。原作者 HEAD、index、status 及 Git worktree 注册前后相同；本回归不调用实际模型，不冒称业务同步或 Docker 验收通过。
