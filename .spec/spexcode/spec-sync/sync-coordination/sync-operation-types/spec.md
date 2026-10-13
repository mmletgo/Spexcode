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

operation 保存不可变输入和 previousBaselinePair、generation/revision、根因及接入键、政策/影响/读集合摘要、8.2 全部阶段、控制与预算、真实 paths/contractIds/flowIds 范围、ready/blocked/delivered 范围及交付目标。attempt 独立保存稳定派发与 session 创建键、原生会话引用、完整 manifest 与实际 diff blob 候选、验证、checkpoint blob 与明确失败类型。fence 绑定 operation、attempt、generation、源物理身份与 lease token。

operation 可保存 contractScopeExpansions：每项只含完整 contractIds/flowIds 和可信细化 evidenceRef，供范围扩展幂等、重启/retry 与证据保活；不携正文或路径扩权。旧数据库无此字段表示尚未通过动作门禁扩展。既有初始 payload 身份不因细化新增 ID 改写。

受控编辑或裁决可提供 requestBlob 保存额外用户意图的不可变引用。input 仍表示实际采集的来源字节，不能为了接收 Dashboard 编辑而谎称 main 已改变或先单独提交 Spec；组合输入在已验证原文条件后叠加请求。纯文件观察事件无需 requestBlob。请求引用参与接入幂等摘要、恢复与证据保活。

ComposedInputRef 可带 requestBlob，表示该组合 tree 已叠加同一不可变用户请求；原始 sourceInputId 不变，不能仅靠相同 source 快照混用两个用户编辑。

journal 保存唯一 effect key、候选/验证/目标绑定、逐文件 pre/post 摘要与 mode、持久 plan blob 和步骤状态。receipt 保存实际 tree/commit、交付快照及证据。baseline 必须同次结算 sourceInput 与 verifiedDelivery，并保存真实 coveredScope；下一次输入由 priorDelivery 加 priorSource→newSource 差量形成，不能丢弃已交付 Agent 内容。部分交付保留根阻塞状态；发布后的交付树作为新来源时建立该物理树自己的成对基线。

adopter control envelope 仅派发协调身份，不作为普通 Agent 文本。共享类型不执行 SQLite、文件或 Git 副作用，调用方必须通过动作门禁修改记录。

每次原生调用先 reserveDispatch 原子预留 maxCalls/callsUsed 与截止时间；attempt 保存完整派发计划数组，稳定 sessionCreateKey 按调用 key 生成，各原生引用不可替换。交付树首次创建前 operation 保存 deliveryPlan，delivery 初始可空，后续绑定真实物理身份。attempt 的 composedInput 与原始 operation.input 分开，包含 sourceInputId、previousBaselinePairId 和组合 tree/manifest/contentDigest。验证引用绑定 policy/readSet/environment/context 摘要；result blob 使用 schemaVersion=1，V1至V4 每层恰有一个独立 verdict 与证据，不能只信任 passed 布尔值。

候选显式绑定 baseTree=attempt.composedInput.tree 与 sourceInputId=operation.input.id。actualDiffBlob 表示组合输入→候选的模型差量；ApplyPlan.files 表示真实交付目标→候选的应用差量，两者不能混同。VerificationResultBlob 同时保存 coveredScope，与外层引用一致，防止扩大窄范围证据。

原生资源计划固定绑定operation/attempt/generation、inputId、candidateDigest、稳定key/kind/payloadDigest及plan blob。verification资源必须绑定已冻结候选；native_session可在冻结前绑定空candidate及固定请求载荷。资源状态为planned→created→terminal→removed，checkpoint正文只存内容寻址引用。更新携expectedCheckpointRef做CAS；相同blob/阶段可幂等重放，迟到观测不能回退阶段或覆盖更完整原生身份。资源观测不授予任何候选、验证或应用写权。

ComposedInputRef 可携 authorProjectionBlob，记录 [[sync-author-input]] 对真实快照的 canonical clean 投影证据。它是派生输入的来源证据，不能替换 sourceInputId 或原始 source/index 身份。
