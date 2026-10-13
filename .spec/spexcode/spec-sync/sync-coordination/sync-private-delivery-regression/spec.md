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
