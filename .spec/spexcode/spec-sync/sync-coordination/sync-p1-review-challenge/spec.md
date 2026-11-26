---
title: 原生 P1 局部候选的操作员复审
status: active
hue: 175
desc: 保留通过结构门的原作者候选，向同一分区的新独审提交可核的只读线索。
code:
  - spec-cli/src/sync/elaboration-review-challenge.ts
---
# 原生 P1 局部候选的操作员复审

## raw source

当原独审误读契约中的源码列与测试列而要求返修时，操作员需要能指出冻结证据。原结构合格的作者稿应保留，先由独立审查判断原发现是否成立。

## expanded spec

请求包含原 operation、稳定 requestId、expectedRevision、冻结 inputId、partitionId、候选及局部结果 SHA256、至多 64 KiB 的非空 UTF-8 诊断与非空 evidencePaths。证据路径采用精确规范仓库文件路径，去重排序，拒绝私密和临时草稿协议路径。服务核对相关证据在原独审所读冻结 Git 树中的文件身份。诊断 CAS 绑定全部请求字段及规范字节，冷读要求内容摘要、包版本与授权字段逐项一致。

[[sync-store]] 在原生分区 P1 结构合格候选收到独审拒绝后接入。目标 operation 已正式暂停，原尝试、原生资源、租约及 journal 均已结算，尚未进入验证或交付，输入、计划及范围仍匹配。服务只能引用原持久局部 wrapper、精确候选及原分区计划。相同请求与授权幂等，重用请求键提交不同内容冲突。登记保留原独审、候选、历史与预算。

操作员诊断只供同分区的新真实独审核对。新审查依据冻结原件独立裁决，可确认原修复要求仍然成立。原稿继续经过正式结构、独审和交付验证门槛。授权记录由 [[sync-operation-types]] 定义，writer 围栏按 [[sync-migrations]] 升级。
