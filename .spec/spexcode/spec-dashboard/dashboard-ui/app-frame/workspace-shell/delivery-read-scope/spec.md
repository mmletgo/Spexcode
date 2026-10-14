---
title: delivery-read-scope
status: active
hue: 195
desc: 交付文档按已注册 targetTree 读取真实节点清单，失效树明确失败。
code:
  - spec-dashboard/src/workspace.jsx#ReadScopeProvider
related:
  - spec-dashboard/src/Shell.jsx
---
# delivery-read-scope

交付文档按已注册 targetTree 读取真实节点清单，失效树明确失败。

阅读宿主内嵌 BoardState，以 `/api/specs?targetTree=...` 取得该树节点，支持 main 不存在的节点。API 拒绝或读取失败替换为显式错误，不使用 main 节点兜底。挂载宿主重新显示或收到内容 revision 时重新读取，隐藏宿主暂停刷新。交付节点不进入 main 的 graph 投影。

每次真实树清单重读后递增该宿主的内容 revision，让未提交正文也重新读取；不依赖 main 内容 revision 或该节点 commit 版本变化证明交付文件未变。
