---
title: 当前 Spec 正文读取
status: active
hue: 195
desc: 共享正文缓存随已有 SSE 内容失效更新，未提交内容不冒充旧提交版本。
code:
  - spec-dashboard/src/specContent.js
related:
  - spec-dashboard/src/NodeView.jsx
  - spec-dashboard/src/ProseActions.jsx
---
# 当前 Spec 正文读取

## raw source

当前文档、节点浮层及段落操作读取同一份当前正文；未提交 Spec 编辑后不能继续展示缓存旧正文。

## expanded spec

复用 [[dashboard-shell]] 的内容 revision 失效共享缓存，不以 commit 次数证明文件未变。缓存按节点和版本保留一份，带当前 revision，避免每个输入更新保留新的历史缓存键。读取新正文期间保留已显示内容；已嵌入正文不读取 API。公开静态文档使用自己的静态缓存，不订阅实时输入。历史版本的不可变读取由 specHistory 独立管理。失败显式给调用者 error。

正文缓存身份包含 targetTree、节点和版本；main 与交付树同 id 不共享内容。交付树正文及 diagram 从该树的 content 端点读取，错误明确显示。树节点清单已有 body 时，diagram 与当前正文仍通过同树端点保持一致。
