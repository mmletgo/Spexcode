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

targetTree阅读范围显示“只读工作树视图”和当前查看的工作树，不把该树称为同步来源，不显示其disabled/配置启用指南。任意已登记工作树不必有交付回执；targetTree本身不证明已同步。源操作及真实receipt仍是交付状态的依据。

复用当前 Spec 文档布局持续显示同步状态，面板可见时每三秒串行读取当前节点 status，离开或请求过时时取消读取，不抢焦点。配置由现有版本化政策启用，不从 UI 编造执行命令或默认政策；缺失/错误明确诊断。正常来源可立即同步、暂停、恢复已暂停操作或取消；交付树保持只读。终态显式重试依据实际资格。recovery_required显示真实诊断，有实际未结算资源或journal时可“恢复清理”，只交服务结算已有副作用，不新开attempt/call/验证/落地；资料缺失而无副作用时只诊断，不装一键恢复。

只有非 stale、执行资料可用、当前 generation/attempt 的 journal 已 settled 且 receipt 存在，并且阶段宣告完成时，才画同步完成。sourceSynced 决定来源是否已同步；否则明确“交付工作树已同步，原工作树待落地”。正文与改动链接只指 receipt 的真实交付树，任何尚未获得 settled receipt 的私有树都不开放。

来源、输入、授权范围、读集摘要、候选实际文件差量、验证、阶段/GAP及失败证据可展开。摘要不冒称真实完整读集。证据按需请求被操作授权的引用与 resultRef，不展示整段代理 prompt。阶段变化不自动展开证据，不改变用户焦点。P1业务契约面板保持原实现。

完整代码/测试review复用 [[sync-operation-diff]]，Spec历史diff深链接只有已结算落地文件确实包含该节点path时才开放，避免把非该节点历史的commit误作Spec版本。

activation=invalidated 表示既有同步配置/来源绑定失效，明确展示configurationError，不能画成用户主动关闭的普通Spec模式；有当前有效配置时可显式重新启用该版本。

status 定时读取与用户保存refreshKey驱动刷新，不依赖全局graph-input/contentRevision重启请求；同步只读快照可能产生Git内部事件，不能据此取消自己正在进行的状态读取并自激重读。

当前input未变化时，failed/budget_exhausted/cancelled的重试是用户显式动作，必须由实际Detail.retryEligibility.eligible开放并展示不开放的reason，不能凭phase猜门禁：用新requestId与retryOf关联旧操作并保原origin，不传新patch，由应用保留旧requestBlob的未落地正文意图且核资源/回执已结算。needs_input/conflicted不能无新事实随机重跑；stale时按最新来源普通同步，不带retryOf。恢复诊断不能生成重试预算。

存在requestBlob时直接在功能上下文展示授权证据中的用户origin.intent，来源正文仍来自原文件。请求实际path的完整正文diff可展开，始终明确这是提交的用户请求、交付结果以receipt为准；不能用候选生成与否限制请求阅读，也不能把用户需求埋在摘要hash或代理prompt中。


P3手动“接入代码修改”提交code来源，正常“立即同步”保initial语义；后台外部watcher尚未启用。可信decisionContext由 [[sync-business-decision]] 展示三种业务裁决，无分歧不加确认。操作记录可切换历史原operation查原analysis和请求；裁决请求展示选择、所选finding IDs、用户新rule、原operation与继承原正文diff。新operation可以supersede原冲突但不能丢原始需求链。

裁决按钮复用 syncProjection.canDecide 消费实际 Detail.decisionEligibility；活动 P1 的冲突证据继续可读，尚不可裁决时原三按钮禁用，结算并取得真实资格后开放。global busy、只读树、未启用配置仍额外禁写；两个准入后尚未查询的临时 Detail 明确 eligible=false，不猜执行资格。前端不另建 phase/attempt/resource 判定，既有布局、焦点与 Hooks 顺序保持。
