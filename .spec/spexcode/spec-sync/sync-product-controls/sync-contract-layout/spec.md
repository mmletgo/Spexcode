---
title: 契约阅读布局
status: active
hue: 175
desc: 复用仪表盘主题和正文布局，键盘阅读与窄屏矩阵滚动。
code:
  - spec-dashboard/src/SyncContractPanel.css
---
# 契约阅读布局

## raw source

契约阅读保持与 Spec 正文一致的主题；长稳定 ID、依赖列表和状态事件表在窄屏仍可阅读。

## expanded spec

[[sync-contract-panel]] 复用主题颜色、字体、分隔线和尺寸 token。节点筛选可折行，字段值与路径换行，窄屏字段纵向排列。矩阵在可聚焦的局部区域内横向滚动，页面本身不横向溢出；select、button、summary 和滚动区有可见键盘焦点。bound 使用信息颜色，不用验证通过色；missing 与错误发现使用错误颜色。
