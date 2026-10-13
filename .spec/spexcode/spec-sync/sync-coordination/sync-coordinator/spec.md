---
title: P2 中央应用编排
status: active
hue: 175
desc: 从稳定输入经独立细化生成及四层验证结算真实私有交付。
code:
  - spec-cli/src/sync/coordinator.ts
---
# P2 中央应用编排

## raw source

一次高层需求应自动完成可信细化、实现、真实验收和可复核交付；暂停、取消、进程中断和输入变化不能重复副作用或用旧结果覆盖新输入。

## expanded spec

复用现有快照、成对 composition、受控 request overlay、P1 elaborate、scope 扩充/租约、generation、真实 V3 resource 执行与 private delivery，不另建消息队列、契约图或事实数据库。原 source/composed/candidate 分开，policy/readset 内容摘要必须绑定 operation。读集合完整保留契约及 source/code/related/AC 测试全文，2MiB 预算失败不截断。host private、越界路径、目录未授权字节拒绝。

operation 独立本机 kernel mutex 防双 coordinator；紧凑 stage checkpoint 只保存 refs、独立结果及诊断，不复制整张契约图。当前 attempt 在独占证明下重入稳定 requestKey，派发前原子计费、持久资源意图，完整真实结果/hash/独立身份保存后重放。lease heartbeat 贯穿原生长调用，控制/总deadline触发 Abort；旧 generation 只能结算真实资源证据。历史未removed资源精确恢复，未知终态保留 recovery_required，不假释放容量。

P1 已审结构结果登记所有未来业务 ID，包括 GAP/partial FLOW；ready/blocked 分区只隔离业务 ID，共享 paths 留 ready。无可执行 ready AC 不生成或写半成品；V1 仅容许已审 GAP 精确解释的缺口。generation 硬门禁保护 raw/全局REQ/AC/VERIFY、实际diff与独立oracle，V2使用不同会话；V3仅执行 ready AC 和 mandatoryTests 的固定命令/镜像；V4复采完整source、当前可信plan/readset与物理身份，一致才可交付，并于 beginApply 前再核。完整V1–V4 pass才 recordVerification(pass)，范围精确ready声明/完整FLOW，不包含blocked。

失败通过新attempt有限修复，冻结预算、deadline及政策不重置，诊断不能升格为事实；环境unsupported、真正业务 GAP/conflict、未知资源恢复停止自动重跑。候选冻结后不覆盖；applying/receipt恢复优先既定交付，真实Git commit及DB未结算不会再生成或重复提交。仅receipt结算可推进成对baseline和deliveredScope，根有blockedReason保持needs_input/conflicted。code/combined来源明确P3未接入。

freezeSyncPlanEvidence复用同一canonical JSON排序，使planBlob.sha256严格等于policyDigest；接入直接保存plan引用，queued恢复不依赖另一个索引文件。派生authorProjection仅规范化已核canonical managed文本，真实snapshot不变；Spec受控decision/reconcile沿用P2，只有code/combined明确P3未接入。阶段result及嵌套refs直接checkpoint保活，不能只pin wrapper。

同operation/input/policy首个P1结构及独立评审通过的细化结果永久冻结为生成义务；code/V3修复的新attempt与进程重启复用原精确结果，并checkpoint原attempt/result evidence provenance，不能再派发P1或更改其稳定AC/ID/政策。仅P1本身未通过时可再细化；通过后清空失败seed，未通过旧seed不能复活。
