---
title: 持续协调、并发与恢复
status: pending
hue: 175
desc: 已提供持久协调、隔离写权与基础恢复；后台持续观察、补偿和完整故障矩阵仍待完成。
related:
  - spec-cli/src/graphStream.ts
  - spec-cli/src/sessions.ts
---
# 持续协调、并发与恢复

## raw source

同一 SyncOperation 协调两边变化。后台独立于 Dashboard，保存、提交、切分支、停机恢复和漏事件补偿都能捕获。

## expanded spec

范围映射：REQ-SYNC-05、09；P2、P4；AC-SYNC-11、12、15至20、24、28。实施依据为 `docs/spec-code-continuous-sync-plan.md`。[[sync-store]]、[[sync-input-snapshot]]、[[sync-coordinator]] 和 [[sync-private-delivery]] 已提供不可变输入、作用域写权、幂等交付与基础恢复；完整后台监听和跨分支补偿尚待实现，不能把本节点作为全部持续同步已完成的证明。

稳定接入键归并重复事件；前后复核 HEAD/index/文件身份并冻结输入。独立 attempt 隔离旧 Agent；generation 撤销过期写权，冻结候选不得被继续写入。按实际文件与规则协调重叠写集合。登记 intent→durable journal→真实字节核对→receipt，允许重复计算，不重复应用。自身回声仅匹配登记来源与实际字节，不屏蔽用户保存。暂停仍观察；取消前未写入则无副作用，写入中先结算，异常维持 recovery_required；恢复只使用最新有效输入。

上层完整需求见 [[spec-sync]]；所有来源、稳定 ID、契约与验证绑定遵循 [[sync-contract-schema]]。`related:` 只提供现存接入点上下文，不计实现覆盖。适用产品验收由上层映射保留，不能用局部夹具通过替代全量结果。
