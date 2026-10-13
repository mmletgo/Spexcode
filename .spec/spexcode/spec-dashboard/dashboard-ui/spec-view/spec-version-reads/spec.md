---
title: spec-version-reads
status: active
hue: 195
desc: 历史版本属于所选工作树的同一文档。
code:
  - spec-dashboard/src/specHistory.js
related:
  - spec-dashboard/src/ContextDock.jsx
---
# spec-version-reads

历史版本属于所选工作树的同一文档。

history、version 和 diff 全部通过现有 specUrl 携带 targetTree。history 的 held identity 及不可变缓存均以工作树、节点及 hash 区分；同 id/hash 在另一树不共享 held 结果。失败显式为 error，不缓存失败。
