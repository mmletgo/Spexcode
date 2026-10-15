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

P5 来源树增加项目观察摘要：观察在线必须由 status.observation.health.watchOnline 与真实 health 状态共同证明；persistedHealth 中旧的 watching 记录不能证明进程在线。明确显示 offline、starting、watching、degraded、missing、invalidated、身份未确认与观察读取不可用，并展示 health.lastScanAtMs 的最近完成扫描时间和真实原因；updatedAtMs 不冒称扫描时间。读取错误或缺失 status 的观察/来源字段关闭在线/控制推断，展示原 API code/message（结构不完整使用本地化诊断）并允许重读。

物理自动接入 pause/resume 通过 `/api/sync/automatic/{pause|resume}`，与单 operation 的 pause/resume/cancel/recover 分开。控件只在默认来源视图且 settings.enabled=true 时开放；targetTree 即使指向已登记输入工作树也仍是只读视图。物理暂停仍持续观察并记录差异；按钮文案明确说明它不会自动解除任何单操作暂停。控制失败展示原错误并重试同一控制请求；成功后仍以接口返回和下一次真实 status 为准，不做乐观状态迁移。

项目覆盖展开显示最近一次成功扫描返回的 totalNodeCount 分母及 included、context、missing、excluded 的原始 ID 清单。服务尚无成功扫描时间时，coverage 显示不可用，不把初始化 0/0 当实际结果。明确说明 included 是配置的观察子树，不等于共同基线或同步完成；只读 context 计入 excluded 数量。共同基线只可由最近 observation 的 selection.bindings 汇总，并清楚标出 latestDifference.nodeId；selection 缺失/失败显示未知和真实原因，不推断全项目未建基线。最新观测 outcome/reason可读，摘要不放内容哈希。

来源工作树 root/branch、receipt 中真实交付树 root/branch/actualCommit，以及 workspace_synced、awaiting_landing、source_synced 阶段各自显示，不能凭 main/master 分支名称推断已落地或完成。targetTree 继续只读且不显示它为同步来源。覆盖与观察证据放进原生 details；状态更新不重挂操作区、不抢键盘焦点，窄屏内容可换行。

status.sources 按实际启用的物理来源工作树只读列出 root、branch、存在性、经服务端确认的观察健康、自动接入控制、登记意图与最近输入观测；不在来源列表提供控制按钮。persisted watching 而 watchOnline 不成立时展示身份未确认，不能显示在线。

operation Detail 的 `sourceSynced` 与 `canonicalSynced` 是独立事实：来源已采纳单独标记，只有服务端确认 canonicalSynced=true 才显示“主分支已同步”；不按分支名或 deliveryPlan 推断落地。Run/code 在 canonical_synced 状态仍可作为新输入启动。

已结算交付详情可提供“生成成组撤销”，只在 backend `revertEligibility.eligible` 且执行/恢复资料可用时开放，不因 `stale` 单独禁止；后续编辑由后端冻结为新的受控候选。文案须说明撤销会进入新的业务审查与验证，不会立即改写主分支。失败重试复用同一操作稳定 requestId。

成组撤销产生的 `sync.history` 请求在原操作证据区明确显示原operation、receipt、feature commit、精确变更path和冲突path，并按请求正文展示。每个差异请求只使用对应 `changes[].path`，rename的旧、新path分别读取；不从nodeId推导路径，不把history请求当作普通用户intent。未知请求类型应显示类型诊断，不能回退读取不存在的 `origin.intent`。

物理“停止后台写入”是来源级服务动作，区别于单项取消与暂停自动接入。使用真实 `stop-writer` 返回更新物理控制并刷新完整 status 历史；其 `operations` 只是需要恢复的子集，不能替换用户已加载的操作记录。说明已交付结果及恢复记录会保留、恢复自动接入会重新启动服务，并且停止回执不证明所有原生执行资源已释放。targetTree 仍只读。
