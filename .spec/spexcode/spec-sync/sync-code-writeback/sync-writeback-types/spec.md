---
title: 行为反写及裁决共享证据
status: active
code:
  - spec-cli/src/sync/writeback-types.ts
---
## raw source

行为反写、具体业务发现与用户裁决必须共享不可变身份和证据，避免文本重叠被当成业务冲突，避免模型自批新政策。

## expanded spec

行为分析绑定真实新输入、共同成对基线、组合及读集合与政策摘要，保存源码及交付行为、原意、路径、规则、反例和独立会话迹线。分类为重构、合法变化、覆盖缺口或明确冲突；程序给变化及发现生成稳定身份。独审通过才可派生事实、验收更新授权、节点迁移或新节点。裁决输入绑定旧operation/input/analysis及具体findingIds，选择保留原意、采用行为或新规则，不能变更已冻结政策。

节点迁移携旧新node/path及证据，退役携旧node/path及证据；业务ID保持连续，退役历史只在真实receipt结算后累积。生成方向区分业务正文稳定、保留外部可观察行为与按明确裁决纠正代码。整体真实产品验收仍由 [[sync-code-writeback]] 承担。

分析正文保存无自身引用的验收及节点proposal；分析证据先冻结为内容寻址blob，再由程序派生带同analysisRef/evidenceRef的具体授权，避免内容摘要自引用。move必须携to，retire不得携to；文件解决方案mode限定Git普通/可执行/符号链接模式或删除。

具体finding保存ruleIds，裁决能仅覆盖选择的业务规则；未选事实和验证/工具政策不受影响。结算后下一无关代码输入沿decisionRefs继承同一用户裁决，不退回历史政策。

authorChanges由程序对真实旧作者输入与新作者/受控请求文本比较得出，包含节点路径、前后raw及语义变化ID，并进入同一独审分析。它证明用户已实际修改原意或显式规则，user:raw验收授权不要求细化再重复改一次相同规则；合法来源闭包允许REQ/RULE/TR，仍不能让模型自行填写作者证据。

裁决新操作重新运行独立行为分析，绑定当前policy/readSet/composed及不可变decision provenance（原requestRef/analysisRef/findingIds）；不能改旧analysis字节冒充新的独审。保留原意和新规则按明确目标修实现，只有采用行为选择保留所选外部行为；未选冲突继续阻依赖。

SyncDecisionAuthority由程序重读真实不可变request和原分析所选finding派生，固定stableDecisionId、原operation/input、requestRef/analysisRef、具体findingIds/ruleIds/affectedIds/paths和choice。文字facts或模型claims不能自造裁决范围。当前及已结算authority作为可信冻结执行输入；AC更新及逐项节点退役只能沿选中规则的合法依赖闭包，不能借source字符串修改未选政策，也不能改标user:raw绕过。退役proposal只由明确作者删除或具体所选节点裁决及新独审产生，不接受模型任意ID列表。

rawIntegrations是程序从已绑定三方Spec及受审完整resolution派生的精确原意整合证据：sourceRaw仍是真作者/不可变原patch字节，deliveryRaw保历史交付，resolvedRaw为相容整合，expectedRaw仅由真实用户choice程序渲染。它进入独审内容摘要但不扩大实际作者changedIds、不回填作者正文、不自行授予新政策；P1可核当前raw exact绑定。
