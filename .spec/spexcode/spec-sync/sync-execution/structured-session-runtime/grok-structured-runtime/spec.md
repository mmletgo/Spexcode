---
title: Grok Build 原生工作树执行
status: active
code:
  - spec-cli/src/grok-structured.ts
related:
  - spec-cli/src/grok-structured.test.ts
---

# Grok Build 原生工作树执行

## raw source

Claude Code 或 ZCode 限流时，用户可以显式选择本机已配置的 Grok Build 接续。Grok Build 在 SpexCode 创建的隔离工作树中完成原任务，沿用正式独审、验收和交付。

## expanded spec

明确的 `grok:<模型或别名>` 仅进入 [[structured-session-runtime]] 的原生 worktree 路由。`grok:default` 沿用本机配置。每轮记录实际 CLI 版本和模型。选择、输入、预算、独审身份与正式重试规则沿 [[sync-model-selection]]。

一轮只启动一次本机 CLI，使用实际托管工作树和预先绑定的会话 UUID。原生流必须以同一会话、同一工作目录且带唯一原生 request ID 的成功终态结束。终态的 request ID 是 turn 身份。最后一个工具之后的完整原生文本通过冻结 JSON schema。只读任务使用计划模式，并成对关闭进入和退出计划模式的工具。编辑任务在独立工作树中使用明确授权。模型的工作和正常 Git 提交由 [[native-worktree-runtime]] 从实际 Git 对象核验。

在原生停止和进程组结算确证后发布结果。收到绑定原请求的成功终态且 CLI 自然退出为零时，进程组结算与读取 stdout 至 EOF 共用一次独立有界的观察窗口，轮询不延长该窗口。若后代仍占用 stdout，允许沿原进程身份与 receipt 停止已登记后代。收到绑定的成功终态后，在当前退出窗口继续复查进程归属，先给 CLI 五秒完成自己的关闭流程。原 CLI 届时仍在运行才停止已登记且身份仍匹配的后代，包括终态后才启动的后代。同一启动身份至多成功发送一次信号，CLI 自然退出立即结束此等待；本步骤不向 CLI 本身发送信号，接受结果仍须其自然退出为零。只有流实际到达 EOF 且终态后没有其他事件才接受输出。取消或超时仍阻止结果发布。格式失败可保存绑定同一请求的未批准输出及真实停止后的 Git 草稿供返修。冷读取复验原件，未知启动、未知终态和未知进程组保持待结算，正式停止和回收共用现有控制路径。

周期观察遇到暂态 pending 时，在 [[native-worktree-runtime]] 的固定观察窗口内继续核验原会话。窗口耗尽或发生非暂态故障时停止原轮。新鲜停止证明成立时登记为失败，停止仍未知时保持待结算。原终态与正式取消优先，恢复不重派任务。
