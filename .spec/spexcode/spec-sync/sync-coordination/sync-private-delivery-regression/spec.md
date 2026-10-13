---
title: 私有完整交付与Git恢复回归
status: active
hue: 175
desc: 用真实Git和SQLite核验完整提交、原树保留、取消与提交后中断恢复。
code:
  - spec-cli/src/sync/private-delivery.test.ts
---
# 私有完整交付与Git恢复回归

## raw source

完整交付不能仅凭写文件成功或 git commit 的退出码判断，恢复必须核对实际Git和持久receipt。

## expanded spec

针对 [[sync-private-delivery]] 建立真实临时Git仓库、实际SQLite store及canonical四hook；V1-V3前置证明与CLI内容判定以明确的测试替身控制，不能把这些夹具当真实模型/完整发布runtime产品证据。覆盖source staged/unstaged保留、完整candidate commit与receipt、重入不重复、commit之后数据库结算之前中断、receipt之后owner公开之前中断、applying中取消完整结算、写前取消无交付目录、无变化不造空提交、第三方文件拒绝覆盖。真实发布工具集成与模型执行另行验收。

交付故障夹具的受控 CLI 仍只替代业务 lint 前置；canonical hooks 的 footprint 校验使用实际编译模块，避免新门禁在测试中被替代。完整发布工具的行为另由 [[sync-trusted-hooks-product]] 验证。

受控 prepare 失败保留真实 stderr 检查点，提交结果按独立种类读取，避免将成功准备的退出码误认成最终提交结果。

先复现V4 callback已recordFailure(conflict)后catch二次使用旧fence，原错误被FENCE_EXPIRED遮蔽；修复证明真实Git已准备但无业务journal，保留原typed input_changed/conflicted及原错误，私有文件仍base、source/index未改。
