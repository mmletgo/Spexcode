---
title: sync-operation-diff
status: active
hue: 195
desc: 按操作授权的真实文件差量，懒加载候选或完整交付差异。
code:
  - spec-dashboard/src/SyncOperationDiff.jsx
related:
  - spec-dashboard/src/NodeView.jsx
  - spec-dashboard/src/syncApplication.js
  - spec-dashboard/src/SyncOperationPanel.jsx
---
# sync-operation-diff

候选审查先读取实际 actualDiffBlob 文件差量，只有其中的路径才有 diff 门，且明确这是组合输入到候选、未证明交付。完整交付只由 settled journal/receipt 的实际文件清单进入，显示交付基线到完整候选。复用现有 DiffEvidence 的 unified patch 展示，通用文件差异使用准确的候选/交付标签；Spec 历史保留原标签。

读取 `/api/sync/operations/:id/diff?path=...&kind=candidate|delivery`，保持 targetTree。文件展开才请求，离开可见 pane 时中止；HTTP 413 或权限/对象错误显示真实 code/message，不将拒绝当空差异。代码和测试文件都经该操作 diff 授权读取，不伪装源码读取政策。没有 receipt 的私有工作树不开放正文阅读门；候选 diff 可以审查但始终标候选。

kind=request复用同一差异展示，从原input正文到requestBlob的请求正文，仅实际请求path可展开；不要求candidate存在，也不能标成完整交付。`sync.history` 请求逐项使用 `changes[].path`，rename旧、新path作为两个精确文件分别读取，不从nodeId或目录推导。

存在实际patch但没有文本hunk时仍原样展示Git差异元数据（如mode或二进制变更），不能因缺少hunk就显示“没有修改”。
