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

config/oracle 只读当前冻结字节和不存在路径进入父树与实际候选；原 source/index 保留。伪 parent、readonly/absence、异来源 frontier、全 path-head CAS、绑定后更换 base 和 candidate 冻结后再绑定均拒绝；无关资源更新不使原 selected 资源过期。真实 commit 后中断仍沿原 commit/tree/parent 恢复，后续独立发布必须等待其结算，再形成继承它的新 base；来源已提交新 HEAD 对象保留且记录 current_head，无关 legacy 只记录明确诊断。

native 与 V1-V4 前置证明明确使用受控测试替身，不能声明真实模型或 Docker 已验收。实际 canonical hook 物理绑定、Git tree/commit 与 SQLite journal/receipt 均真实运行。针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/publication-base.test.ts`。

故障回归让 A/B 都先生成并各预留一次 call，B 无 base 的 native 仍运行时 A 可冻结并实际提交；A 提交后崩溃释放文件锁，B bind 被持久 BUSY 阻挡，不生成新输出或扣新 call。A 恢复真实 receipt 后 B 原待绑定 base 变 stale，重新组装当前 base 继承 A 完成 B。failed 发布的未知 resource 在真实 removed 前仍阻 B。另以真实已结算 A1 和内容寻址重算的额外 readonly a 路径伪造，证明不能抹掉 A1；factory 与 verifier 均拒绝不精确 read closure。旧无 base 冻结发布推进实际 head 后，新 base 的相同对象重入及 verified 新交付明确 stale，保原验证状态且无 journal。
