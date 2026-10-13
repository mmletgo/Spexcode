---
title: 业务契约与缺口阅读面板
status: active
hue: 175
desc: 阅读真实契约、状态事件处置、AC 绑定与 GAP；声明和绑定不代表验证通过。
code:
  - spec-dashboard/src/SyncContractPanel.jsx
related:
  - spec-dashboard/src/syncContractModel.js
  - spec-dashboard/src/syncContractModel.test.mjs
  - spec-dashboard/src/SpecView.jsx
  - spec-dashboard/src/data.js
  - spec-dashboard/src/SyncContractPanel.css
  - spec-dashboard/src/i18n/en.js
  - spec-dashboard/src/i18n/zh.js
---
# 业务契约与缺口阅读面板

## raw source

用户打开启用 sync-v1 的当前 Spec，可阅读契约链、状态事件矩阵、AC 与真实绑定、source、GAP 依赖和缺失发现。此阶段仅阅读，不执行契约、启动 Agent 或作业务裁决。

## expanded spec

复用 [[sync-contract-report]] 的 HTTP 投影和覆盖状态，不在浏览器重算是否完成。默认跟随当前正文后台的工作树；显示报告的 canonical targetTree。面板 API 支持显式 targetTree 供后续工作树入口使用，当前 SpecView 不独立选择另一棵树。

默认筛选当前节点，可切换启用契约的节点及全部契约。关联状态事件单元及跨节点 GAP 依赖必须可见：显示 affectedIds、nodeIds、blockedBy 和声明的 dependsOn。每项展示稳定 ID、类型、来源定位与全部契约字段；AC 展示 covers、test、VERIFY command；完整矩阵明确缺失的状态事件处置。

declared、bound、missing 只表示声明、结构绑定和处置缺失。报告 verification: not_run 明确显示；绑定分子/分母不作为真实运行通过或已同步的证据。解析及验证 findings 显示级别、位置、关联 ID 和原消息。旧版未启用节点不显示空面板；公开静态图、历史版本和 pending change face 不挂当前报告。

读取失败显示真实错误并支持重试；加载中不抢焦点。原生 select、details/summary 与表格支持键盘阅读；窄屏在面板内横向滚动矩阵，不撑宽正文。复用现有 i18n、主题 token 和正文布局。

当前阅读随 [[graph-stream]] 同一 SSE 的 full 输入失效及重连 ready 更新，不只依赖节点 commit version。未提交的 Spec、代码和测试编辑也重新读取真实报告；刷新期间保留面板 DOM、展开项和焦点并标记正在读取。会话专属事件不引起契约刷新；不新增轮询或后台同步机制。当前正文共享缓存使用同一内容 revision 失效，避免正文和契约读取版本不同。
