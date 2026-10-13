---
title: 同步协调共享身份与记录
status: active
hue: 175
desc: 定义冻结输入、独立尝试、写入栅栏、成对基线及应用 journal 的共享协议。
code:
  - spec-cli/src/sync/operation-types.ts
---
# 同步协调共享身份与记录

## raw source

各生成、验证和交付组件必须使用同一身份与记录模型，避免旧尝试、重建工作树或未验证候选取得写入权。

## expanded spec

本节点治理共享 TypeScript 数据协议，完整范围遵循 [[sync-coordination]]。工作树身份包含仓库、commonDir、canonicalRoot、gitDir、分支及删除重建可区分的物理指纹。冻结输入保存 HEAD、不可变 tree、index tree/digest、文件 manifest blob 与内容摘要；采集时间仅为元数据，稳定 ID 不包含采集时间。

operation 保存不可变输入和 previousBaselinePair、generation/revision、根因及接入键、8.2 全部阶段、控制与预算、真实 paths/contractIds/flowIds 范围、ready/blocked/delivered 范围及交付目标。attempt 独立保存稳定派发与 session 创建键、原生会话引用、候选、验证、checkpoint blob 与明确失败类型。fence 绑定 operation、attempt、generation、源物理身份与 lease token。

journal 保存唯一 effect key、候选/验证/目标绑定、逐文件 pre/post 摘要与 mode、持久 plan blob 和步骤状态。receipt 保存实际 tree/commit、交付快照及证据。baseline 必须同次结算 sourceInput 与 verifiedDelivery，并保存真实 coveredScope；下一次输入由 priorDelivery 加 priorSource→newSource 差量形成，不能丢弃已交付 Agent 内容。部分交付保留根阻塞状态；发布后的交付树作为新来源时建立该物理树自己的成对基线。

adopter control envelope 仅派发协调身份，不作为普通 Agent 文本。共享类型不执行 SQLite、文件或 Git 副作用，调用方必须通过动作门禁修改记录。
