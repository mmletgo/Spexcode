---
title: Spec 与代码持续双向同步
status: pending
hue: 175
desc: 已实现业务细化、双向变更、持续观察与隔离交付；完整当前版本验收及远端保护配置仍须证明。
---
# Spec 与代码持续双向同步

## raw source

用户主要通过功能需求控制软件，也允许从代码入口开发。正常变更全自动，业务冲突时确认；P0 至 P5 均须实现，不以提醒或建议补丁代替实际同步。

## expanded spec

基线来自 `docs/spec-code-continuous-sync-plan.md`（2026-10-13、42f4cf169），九项需求和全部二十八项验收保留。此节点是产品范围，尚无全部运行证据，保持 pending；新增结构化契约遵循 [[sync-contract-schema]]，不得由本文件状态推断同步成功。

受控 Spec 保存、代码保存与显式运行复用同一应用服务，进入业务细化、实现生成、独立审查、四层验证与实际交付。代码反写与业务裁决、无浏览器持续观察和停机补偿、逐资源基线及成组历史补偿均有对应实现；[[sync-application]]、[[sync-coordinator]] 和 [[sync-private-delivery]] 定义共同运行路径。功能存在不等于下表所有当前版本产品验收完成，仍须逐项核对真实输入、原生执行、运行证据及完整治理范围。

| 需求 ID | 用户结果 | 阶段 | AC-SYNC 编号 | 权威子节点 |
|---|---|---|---|---|
| REQ-SYNC-01 | 修改 Spec 自动驱动完整代码与测试 | P1、P2 | 01、02、03 | [[sync-execution]] |
| REQ-SYNC-02 | 修改代码自动原位更新详细 Spec | P3 | 04、05、09、13、14 | [[sync-code-writeback]] |
| REQ-SYNC-03 | 从高层需求补齐业务主流程 | P1、P2 | 01、02、08 | [[sync-elaboration]] |
| REQ-SYNC-04 | 补齐底层状态流及事件处置 | P1 至 P5 | 03、14、25 | [[sync-elaboration]] |
| REQ-SYNC-05 | 持续检测、补偿与保持当前版本一致 | P2 至 P5 | 11、15、20、22、26、27 | [[sync-coordination]] |
| REQ-SYNC-06 | 正常变更全自动生成、验证和落盘 | P2 至 P5 | 01、04、09、26 | [[sync-execution]] |
| REQ-SYNC-07 | 解释业务冲突，裁决后自动继续 | P2、P3、P5 | 06、07、08、10 | [[sync-code-writeback]] |
| REQ-SYNC-08 | 追踪需求至真实运行证据且不虚报完成 | P1 至 P5 | 13、14、21、22、23、27 | [[sync-verification]] |
| REQ-SYNC-09 | 并发、中断、取消与恢复不丢修改或重复应用 | P2、P4、P5 | 11、12、15 至 19、24、28 | [[sync-coordination]] |

完整实现由 [[sync-elaboration]]、[[sync-execution]]、[[sync-code-writeback]]、[[sync-coordination]]、[[sync-verification]] 和 [[sync-product-controls]] 配合完成。共享规则唯一，子节点引用对应 REQ-SYNC，不另造第二份业务真相。

开发工作树已同步、原输入树待落地、主分支已同步分别展示。main 有未提交改动时不自动合并；这不阻止受管交付工作树的自动生成和验证。任何过期、缺口、冲突、验证失败或未结算 journal 都不算已同步。
