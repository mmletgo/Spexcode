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

submit 接收 nodeId、稳定 requestId 与可选 SpecBodyEdit。受控编辑先 capture 真 source，从冻结节点解析路径，在准备函数读正文前检查 symlink；prepareControlledRequest 独立冻结请求，不改原文件、index 或 HEAD。相同字节 no-op 不入队；同请求键和相同内容返回原操作，不同内容拒绝。[[sync-application-planning]] 构造 plan；固定 compiled runtime 与内容寻址计划在 admit 前保存，随后唯一 coordinator 实际细化、生成、验证和交付。V4 重新读当前输入与可信配置，不能用旧 plan 自证。正常 typed failure 持久结算，后端持有运行 Promise 并显式诊断无法结算的故障，不丢 rejection；P4 停机自动补偿不属于当前阶段。

status 按节点及 bounded limit 查询，detail 返回 operation、当前 attempt、完整 journal 和 settled receipt；证据按 hash 校验读取。新 source input ID 使旧结果过期；workspace_synced 只表明实际受管交付，原树待落地单独展示。GAP/冲突与验证失败保留各自 phase/failure。pause/cancel 使用 store 控制及 AbortSignal，写入中由 coordinator 结算真实副作用；resume 先检查当前输入和授权，过期要求最新请求，不先改变旧控制。

同 ingress 的准备及受理复用 file-mutex bounded 串接，并发相同请求只建立同一操作和固定 runtime，不重置预算。planBlob 由 coordinator 用 syncPlanDigest 的唯一规范化 bytes 冻结和 pin，应用直接按 op.planBlob 校验读取；旧操作无固定引用时明确不可猜测恢复。detail.executionAvailability 从实际固定计划、描述和 runtime manifest 推导恢复诊断，queued 也不能隐藏资料缺失。工具描述有 ownedruntime 副本；丢失索引时，只能校验同一原 runtime manifest/digest 后恢复。已有 attempt、verification 或 journal 且原描述不能恢复时，禁止以当前升级工具重冻结或沿用旧证据；仅未派发 queued 操作可重新准备并完整运行。resume 先等旧 abort 执行结算，再恢复 run 控制，避免旧结束回调覆盖恢复。
