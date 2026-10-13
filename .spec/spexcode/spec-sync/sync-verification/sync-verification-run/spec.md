---
title: 同步尝试的持久行为验证
status: active
hue: 175
desc: 将真实验证容器检查点关联到固定尝试，取消后仍结算资源且不恢复业务写权。
code:
  - spec-cli/src/sync/verification-run.ts
related:
  - spec-cli/src/sync/verification-run.test.ts
---
# 同步尝试的持久行为验证

## raw source

取消或新输入可以撤销旧候选写入权，但不能让已创建的验证资源丢失恢复记录，也不能在重试时重复运行已经结算的验收。

## expanded spec

本节点连接 [[sync-store]] 的资源记录与 [[verification-executor]]。每次运行由 attempt 与稳定 runId 定位，计划保存固定请求摘要和输入/候选身份。首次 planned 在容器 create 前持久化；后续 created、terminal、removed 使用精确资源身份与前一检查点 CAS 保存，原业务 fence 失效不阻止真实资源结算。

同一请求重入读取既有资源及内容寻址检查点；removed 回放原终态，不重新创建容器。不同请求载荷不得复用原 runId。恢复已取消、暂停或被取代的尝试时传递取消信号，只终止和清理已有资源，不启动新的验收。检查点持久后通知观察者；观察者失败按执行器恢复语义处理，已持久记录仍是下次恢复依据。

资源结算不会调用 recordVerification、落盘或推进同步完成；V1/V2/V4 及当前 fence 必须另行通过。Docker 不可用或检查点未完成时保留真实 unsupported/recovery_required。运行记录继续使用已有 SQLite 和 evidence blob，不新增数据库或队列。

针对验证：`SPEX_DOCKER_VERIFICATION_TEST=1 npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/verification-run.test.ts`，使用真实 SQLite 与 Docker 检查取消后的完整资源结算、创建后中断并重开数据库恢复同一容器、已结算重入不再调用 Docker，以及旧尝试恢复不得重新启动容器。
