---
title: 工作树实际读取回归
status: active
hue: 195
desc: 真实 HTTP 双工作树读取保持正文、历史、源码和附件一致。
code:
  - spec-cli/src/spec-version.api.test.ts
---
# 工作树实际读取回归

## raw source

用户打开交付版本时应看到该树中的实际结果和历史，不能混入后台树的同名节点。

## expanded spec

临时 Git 仓库与独立交付工作树通过真实后台 HTTP 验证：同名节点移动并改正文，新节点仅存在交付树；Spec 列表、正文、图表、附件、源码列表和切片均采用选定树。历史只承认该树该节点自己的版本，未知 hash、HEAD 表达式和选项形字符串不能进入 Git 命令。未注册目录的每种读取入口返回 400。正文写操作不能用只读 targetTree 参数将变更静默写入后台树。两树 HEAD 和状态在读取后保持原样。

同步启用场景先用 `sync.nodeIds` 明确登记测试意图节点，并暂停自动调度以单独验证 HTTP 保存和重试边界；启用前保留普通 no-op，启用后保存必须有稳定请求身份且不先提交 Spec；授权失效不得回落到独立提交。HTTP 显式重试的无效身份返回 400、未知操作返回 404，后端不能丢弃 retryOf 并创建普通任务。所有拒绝后 source HEAD/index 及操作数量保持原样。


P3真实HTTP确认code origin到达共享应用授权校验而非旧unsupported入口；未知decision原operation返回404，path/body身份冲突返回400。
