---
title: sync-operation-panel
status: active
hue: 195
desc: 当前节点的同步状态与操作控制，完成凭当前输入和已结算回执。
code:
  - spec-dashboard/src/SyncOperationPanel.jsx
related:
  - spec-dashboard/src/SpecView.jsx
  - spec-dashboard/src/styles.css
  - spec-dashboard/src/i18n/en.js
  - spec-dashboard/src/i18n/zh.js
---
# sync-operation-panel

当前节点的同步状态与操作控制，完成凭当前输入和已结算回执。

复用当前 Spec 文档布局持续显示同步状态，面板可见时每三秒串行读取当前节点 status，离开或请求过时时取消读取，不抢焦点。配置由现有版本化政策启用，不从 UI 编造执行命令或默认政策；缺失/错误明确诊断。正常来源可立即同步、暂停、恢复已暂停操作或取消；交付树保持只读。failed/needs_input/预算耗尽重新提交须新请求身份，recovery_required仅诊断，不虚承诺一键恢复。

只有非 stale、执行资料可用、当前 generation/attempt 的 journal 已 settled 且 receipt 存在，并且阶段宣告完成时，才画同步完成。sourceSynced 决定来源是否已同步；否则明确“交付工作树已同步，原工作树待落地”。正文与改动链接只指 receipt 的真实交付树，任何尚未获得 settled receipt 的私有树都不开放。

来源、输入、授权范围、读集摘要、候选实际文件差量、验证、阶段/GAP及失败证据可展开。摘要不冒称真实完整读集。证据按需请求被操作授权的引用与 resultRef，不展示整段代理 prompt。阶段变化不自动展开证据，不改变用户焦点。P1业务契约面板保持原实现。

完整代码/测试review复用 [[sync-operation-diff]]，Spec历史diff深链接只有已结算落地文件确实包含该节点path时才开放，避免把非该节点历史的commit误作Spec版本。

activation=invalidated 表示既有同步配置/来源绑定失效，明确展示configurationError，不能画成用户主动关闭的普通Spec模式；有当前有效配置时可显式重新启用该版本。

status 定时读取与用户保存refreshKey驱动刷新，不依赖全局graph-input/contentRevision重启请求；同步只读快照可能产生Git内部事件，不能据此取消自己正在进行的状态读取并自激重读。
