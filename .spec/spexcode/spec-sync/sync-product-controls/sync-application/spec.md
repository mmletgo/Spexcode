---
title: 同步共享应用入口
status: active
hue: 175
desc: HTTP 与 CLI 共用持久协调服务，受控正文差量不先提交，实际交付与原树状态分开查询。
code:
  - spec-cli/src/sync/application.ts
---
# 同步共享应用入口

## raw source

启用、保存 Spec、显式执行、查询、暂停、恢复和取消必须进入同一真实协调操作。失败或新输入到来后能查询具体结果，不由界面推断完成。

## expanded spec

本节点落实 [[sync-product-controls]] 的 P2 应用入口；P3 代码意图、P4 外部 watcher 与完整恢复、P5 最终验收仍由上层保留。生产 configuredSyncApplication 复用后端同仓库的 canonical session protocol，按已注册 source 工作树实例化，不创建其它数据库或队列，迁移先备份。运行资料及固定 compiled CLI 位于源码外当前用户拥有的独占 0700 runtime。

enable 读取 [[sync-application-settings]]，可用预期配置摘要检查并发变化；只原子保存本机授权记录，不改版本化配置。配置或 source 物理身份改变拒旧授权；重新启用是本阶段的授权入口。启用展示输入身份、交付根、授权范围、预算及 Spec/initial、Docker Node test 能力，不承诺反向同步或外部监听。

readSettings.activation 区分 disabled、enabled 与 invalidated：未有本机启用记录是 disabled；记录存在且当前身份/配置摘要一致是 enabled；已启用后配置删除、坏格式、越界授权、身份或摘要失配是 invalidated，并保留具体 configurationError。enabled:false 不等于用户关闭同步，invalidated 正文保存必须拒绝，不能降级为普通 Spec 独立提交。

submit 接收 nodeId、稳定 requestId、spec/initial 来源与可选 SpecBodyEdit。来源真实参与持久操作和幂等身份；initial 沿同一 Spec 业务管线，不能把同键改来源当重放。受控编辑先 capture 真 source，从冻结节点解析路径，在准备函数读正文前检查 symlink；prepareControlledRequest 独立冻结请求，不改原文件、index 或 HEAD。相同字节 no-op 不入队；同请求键和相同内容返回原操作，不同内容拒绝。[[sync-application-planning]] 构造 plan；固定 compiled runtime 与内容寻址计划在 admit 前保存，随后唯一 coordinator 实际细化、生成、验证和交付。V4 重新读当前输入与可信配置，不能用旧 plan 自证。正常 typed failure 持久结算，后端持有运行 Promise 并显式诊断无法结算的故障，不丢 rejection；P4 停机自动补偿不属于当前阶段。

status 按节点及 bounded limit 查询，detail 返回 operation、当前 attempt、完整 journal 和 settled receipt；证据按 hash 校验读取。新 source input ID 使旧结果过期；workspace_synced 只表明实际受管交付，原树待落地单独展示。GAP/冲突与验证失败保留各自 phase/failure。pause/cancel 使用 store 控制及 AbortSignal，写入中由 coordinator 结算真实副作用；resume 先检查当前输入和授权，过期要求最新请求，不先改变旧控制。

同 ingress 的准备及受理复用 file-mutex bounded 串接，并发相同请求只建立同一操作和固定 runtime，不重置预算。planBlob 由 coordinator 用 syncPlanDigest 的唯一规范化 bytes 冻结和 pin，应用直接按 op.planBlob 校验读取；旧操作无固定引用时明确不可猜测恢复。detail.executionAvailability 从实际固定计划、描述和 runtime manifest 推导恢复诊断，queued 也不能隐藏资料缺失。工具描述有 ownedruntime 副本；丢失索引时，只能校验同一原 runtime manifest/digest 后恢复。已有 attempt、verification 或 journal 且原描述不能恢复时，禁止以当前升级工具重冻结或沿用旧证据；仅未派发 queued 操作可重新准备并完整运行。resume 先等旧 abort 执行结算，再恢复 run 控制，避免旧结束回调覆盖恢复。

派发使用 canonical protocol 中按 repositoryId 固定的真实地址，同仓库多个 source 工作树共享 FIFO，不同仓库共享 session DB 时互不堵塞。入口只唤醒当前仓库有效消息头，精确清理已停止的旧消息；同仓库来源由对应应用实例执行，禁止跨仓库 fallback。busy 返回真实 queued 状态，不自旋重试。前序结算后继续读取真实 FIFO；消息已耗尽时，从 canonical store 的 queued/run 状态恢复已出队暂停操作，不创建第二队列、不重置预算。wait 等待当前仓库实际运行中的前序和目标任务，外部互斥仍占用时诚实返回 queued 详情，不把它标为完成。

显式 retryOf 由用户授权为同一冻结输入、节点、政策、来源和正文请求建立关联的新 operation 及新预算；省略 patch 继承原 requestBlob，省略 origin 继承原 spec/initial 来源，沿旧 previousBaselinePair，不丢失未落地编辑。不能混入新 patch 或改节点、来源/政策，当前 source 已变应提交正常新输入。普通重复事件继续归并原 operation 及预算，同 retry requestId 精确幂等。detail.retryEligibility 复用 store 只读 phase、所有历史 resource/journal/live authority 门禁，并附当前输入/授权及固定 plan 诊断；只有 failed、budget_exhausted，以及从未交付的 cancelled 可重试，GAP、冲突、active 或未知资源禁止借新预算重启。准入事务重新检查门禁，不以先前只读结果代替原子检查。

detail.resources 只列该操作尚未 removed 的真实历史资源；暂停、取消、失败/预算、待输入/冲突或完成状态若仍有此类资源或未 settled journal，executionAvailability 显示 recovery_required 与 sync_resources_unsettled，不能因工具描述可读就显示 ready。该投影不虚构资源已释放；retryEligibility 仍由 canonical 门禁拒绝，精确资源恢复由 coordinator 负责，恢复入口单独验收，不能因尚未恢复就允许重试。

control(recover) 是独立于 resume/retry 的清理入口：保原 control、输入、预算和业务结果，不要求重新启用当前已经变化的配置；先等旧执行结算，再用原固定计划和工具调用 coordinator.recoveryOnly。它只核已有 native/verification 资源与已经开始的 journal，不创建 attempt、模型调用、验证或新 apply，也不自动唤醒其它 queued 任务。资料缺失或资源仍未知时保留具体恢复诊断，不假称释放；清理后另由明确 resume/retry 推进。conflicted 状态也必须按真实未结算资源投影 recovery_required。

recover 等待本次协调清理结果：具体 failure 以原 code/message 的 409 返回，仍未知且无更细 failure 时返回 sync_resources_unsettled。不能仅打印服务器日志；查询详情仍从实际资源/journal保留恢复诊断，不写虚构业务失败或改原冲突结果。
