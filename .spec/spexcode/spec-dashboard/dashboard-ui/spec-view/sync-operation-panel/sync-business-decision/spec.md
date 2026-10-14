---
title: 业务分歧裁决界面
status: active
hue: 195
desc: 按可信分析的具体分歧显示原意与行为，三种用户选择建立独立裁决操作。
code:
  - spec-dashboard/src/SyncBusinessDecision.jsx
related:
  - spec-dashboard/src/SyncOperationPanel.jsx
  - spec-dashboard/src/syncApplication.js
  - spec-dashboard/src/styles.css
  - spec-dashboard/src/i18n/en.js
  - spec-dashboard/src/i18n/zh.js
---
# 业务分歧裁决界面

## raw source

有真实业务分歧时，用户看到共同基线、原始需求、双方代码行为、具体规则/路径、反例与需要明确的事实，并只裁决选中的分歧。正常无冲突同步无需额外确认。

## expanded spec

界面使用 [[sync-application]] 返回的可信 decisionContext，不从模型自由文本或匿名证据引用构造授权。选项为“保持需求并修代码”“采用新行为并更新需求”和“输入新规则”；前两项直接提交，第三项显示有明确标签的规则输入框并要求非空正文。多项分歧使用原生 checkbox 选择，不选项不提交，剩余 GAP 按依赖范围保留。请求包含原 operation/input/analysisRef、选中 finding IDs、用户 choice/rule 与稳定 requestId；同 payload 重试保键，修改选择或规则换键。

readonly、stale、授权失效、资源未结算、非待裁决状态禁写；独立请求进行期间阻止重复提交，失败保具体 code/message 和用户输入。原生表单、checkbox/button及textarea支持键盘；390px 窄屏按单列展示规则与行为，正文/路径可换行。Hooks 始终位于任何 early return 之前。只呈现真实分析事实，不编造业务决定或把正常完成交给用户再次确认。
