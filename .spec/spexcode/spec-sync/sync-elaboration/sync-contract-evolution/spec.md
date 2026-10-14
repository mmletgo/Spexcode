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

RULE 独立跨叶搬迁时，旧定义与新定义的 authority 均须等于各自 canonical owner，归属路径发生变化才把 authority 调整视为定位变化；业务 constraint、范围、来源及依赖仍保护。错误 authority 不豁免，不能全局忽略治理字段；单纯搬迁也不能冒充业务规则变化来授权 AC 更新。

当前及已结算裁决使用程序从真实 request、旧独审 analysis 与所选 finding 冻结的 decisionAuthorities；fact.text 或模型声明不能提供作用范围。decision 来源的 AC 授权同时核对验收目标和每个来源 ID，沿所选规则的旧依赖闭包核对AC与来源；当前真实所选发现明确涉及且属于所选旧RULE/TR依赖或来源的共享REQ，仅可追加该REQ本身，不从父REQ展开全域。当前裁决还限制实际既有业务语义变化与退役，换成 user:raw、新 code 来源或旧 decision 名称不能扩权；既有身份必须属于旧图闭包，新图仅补入新身份，不能加一条依赖边给旧无关义务自批权限。原有 code 来源的独立实现细节及合法定位搬迁保持各自门禁。

同一操作的独立真实作者需求编辑仍可自动结算：具体 user:raw 验收提案经独审，来源 ID 对应程序作者差量及旧来源闭包，可更新对应 AC；raw-only 高层需求可使用合法 REQ 来源，不强制虚构 RULE。它不豁免未选规则；其他既有业务项变化仅在该 ID 本身属于实际作者差量且独审明确 allowed_change 时通过。相容整合保留真实作者 afterRaw，以独审冻结 rawIntegrations 的 sourceRaw、具体 resolution 的 resolvedRaw 与本轮 expectedRaw 精确匹配，不能用 contains 或把模型整合正文回填为作者事实。已审真实作者节点删除仍可逐项退役，不借另一裁决扩大范围。

真实 raw-only 高层编辑可同时派生已有 RULE/TR 和对应 AC：同一独审 allowed_change 明确列出实际作者 REQ 来源、具体规则来源及受影响规则/AC，逐字 user:raw 验收提案的 ruleIds 同时关联真实作者来源和该具体规则，且来源均属于该 AC 的旧来源闭包，才允许这组详细业务变化。父 REQ 的整个依赖闭包仅用于核对来源关系，不能无条件放行其他规则；缺少具体映射或提案的未选规则仍拒绝。

带 analysisRef 的逐项退役必须对应已审提案、同节点退休记录、content:null 删除候选和具体 allowed_change；user:raw 还要求程序冻结的作者删除差量（对应节点/路径/ID、beforeRaw 非空缺且 afterRaw 为 null）。三方来源中的 raw 版本可以不同，不能把前轮交付新原意误当作作者未删除。decision 退役使用具体所选作用范围及删除证明，不冒充作者先删除；不带分析引用的明确用户/计划授权仍须可信来源。

当前裁决的旧FLOW/STEP目标还须属于原真实所选finding affectedIds；共享权限规则的闭包不能改未选操作流程。新图闭包仅补新身份，不能加边扩大旧目标。decisionAuthorizationErrors、演进currentScope与行为分析复用同一有限scope；eligible只表示可继续校验，不代表语义批准。

共享REQ更新必须精确绑定当前requestRef/analysisRef/findingIds及已独审分析，REQ来源为本次decision；同一个已审allowed_change同时列该REQ及所选旧RULE/TR，且最终候选中该规则政策定义真实变化。RULE的scope/constraint或TR的状态、条件、处置、反馈与效果定义构成见证，source、定位及实现绑定变化不构成政策变化。旧authority、keep、无关REQ、新连边、缺同次见证均不授权。REQ自由文本与未选规则的语义矛盾仍由原P1完整候选独审判定，图关系不冒充自然语言证明；既有AC精确提案、真实变化来源、RAW/VERIFY和全部未选业务守卫保持。
