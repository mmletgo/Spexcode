---
title: 接受细化的契约演进授权
status: active
desc: 旧新全图验证稳定身份、原意、独立分析授权和退役引用；纯重构保留业务正文。
code:
  - spec-cli/src/sync/contract-evolution.ts
related:
  - spec-cli/src/sync/contract-evolution.test.ts
---
# 接受细化的契约演进授权

## raw source

正常无冲突行为变更自动反写详细契约，真实业务冲突才需要用户裁决；移动保留稳定业务 ID，退役不能逃避验收或复用身份。

## expanded spec

[[sync-elaboration]] 在旧契约到接受细化间，以同一解析图和旧新节点并集核对变更；[[sync-frozen-contracts]] 继续检查接受契约到最终生成代码，生成器不能重新决定业务要求、验收或政策。

业务项按全图稳定 ID 查找，跨叶搬迁不当作删除。节点生命周期记录 move/retire、旧新 canonical 定位及冻结证据；canonical 节点身份继续来自共享 mintIds，目录改名记录旧新身份而业务项身份不变。move 原样保留 raw、清理旧定位并重定向权威引用。新节点使用冻结原意或上层引用。删除契约标记不能让旧节点免检。节点退役及契约项删除必须逐项由 user:raw 或冻结 decision 授权，清理引用；节点和业务项退役立即加入本轮禁用身份集，不能在本轮换路径重建，也不能在后续操作复用。

update_acceptance 必须绑定真实内容摘要的冻结行为分析；分析及独审会话/线程独立并绑定冻结输入。具体 allowed_change 明确涉及该验收和合法 REQ/RULE/TR 来源闭包，授权提案与调用者冻结授权逐字一致；需求原意、规则或状态处置实际改变且该验收可追到变化来源，才允许更新已有 AC 语义。模型自身代码失败、伪造摘要或独审、无来源变化不能成为授权。退役及验证政策仍只接受用户原意或可信裁决，不能由 code 来源授权。

preserve_business 保持 raw、expanded 业务正文和全部业务字段，只允许必要实现、来源符号及测试定位变化，以及移动导致的 canonical 权威身份调整。reelaborate 接受合法意图细化；未经授权不能弱化已有验收。所有检查独立于当前 active AC 数量，不以空验收或 GAP 跳过旧图和退役检查；GAP 仍只影响真实依赖分支。

用户已经编辑 raw/详细规则、保留旧 AC 时，真实作者 old→new 差量由程序生成并纳入同一独审分析：changedIds 包含合法来源，定位匹配该来源节点，afterRaw 必须精确匹配当前冻结原意。它证明用户变更已经发生，不要求细化再改一次规则；模型不能填此作者差量，旧合法分析不能跨输入复用，版本绑定由协调器核对。

实现遗漏诊断触发再细化时，preserveAcceptedItems 保护全部既有稳定身份、raw/REQ、RULE政策、AC/VERIFY与原业务说明；FLOW/STEP/TR等详细逻辑可增补原意允许的失败出口与边界，并经结构检查及独审接受。已有TR不能改为not_applicable逃检查。诊断本身不授予任何原意、政策或验收变更授权。
