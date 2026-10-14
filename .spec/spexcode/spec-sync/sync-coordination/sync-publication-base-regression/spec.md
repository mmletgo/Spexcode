---
title: 精确资源发布保全回归
status: active
hue: 175
desc: 以真实Git/SQLite证明独立发布保全、范围约束和冻结恢复。
code:
  - spec-cli/src/sync/publication-base.test.ts
---
# 精确资源发布保全回归

## raw source

后发布的独立结果必须保留先发布者，不夹带来源未消费 dirty，真实恢复不能更换已验证树。

## expanded spec

针对 [[sync-publication-base]]、[[sync-store]] 与 [[sync-private-delivery]] 建立真实 Git 仓库、SQLite store、canonical hooks、journal、receipt 及 source/index 字节断言。覆盖已结算 A1 未合回来源后 B2、同 HEAD A/B 两种发布顺序，完整结果均保留 A1+B2 且不含 A2；B journal 不冒领 A/readonly，A path head 不推进。已结算删除 tombstone 和可执行 mode/OID 逐对象跨独立交付保留。

config/oracle 只读当前冻结字节和不存在路径进入父树与实际候选；原 source/index 保留。伪 parent、readonly/absence、异来源 frontier、全 path-head CAS、绑定后更换 base 和 candidate 冻结后再绑定均拒绝；无关资源更新不使原 selected 资源过期。真实 commit 后中断恢复同一 commit/tree/parent，不重新读取 latest；来源已提交新 HEAD 对象保留且记录 current_head，无关 legacy 只记录明确诊断。

native 与 V1-V4 前置证明明确使用受控测试替身，不能声明真实模型或 Docker 已验收。实际 canonical hook 物理绑定、Git tree/commit 与 SQLite journal/receipt 均真实运行。针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/publication-base.test.ts`。
