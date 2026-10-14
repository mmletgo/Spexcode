---
title: 冻结三方行为分类与独立审查
status: active
code:
  - spec-cli/src/sync/code-behavior.ts
---
## raw source

外部代码和两边同改应依据真实共同验证基线自动协调；文本重叠不是业务冲突，模型自身错误不能成为新需求或批准。

## expanded spec

[[sync-code-writeback]] 的行为分析复用独立受限native会话及既有budget/checkpoint。完整旧source、已验证delivery/newsource、共同coveredScope和冻结raw/规则/调用/测试字节进入分析，原意与真实外部差量分别保留；未读取上下文或超预算拒绝，不截断断言。构建与审查session/thread独立，输出及完整readSet/policy/composed/input绑定；审查重新检查每个变化和实际影响路径。

分类为refactor、allowed_change、coverage_gap或conflict。重构不授权业务正文漂移；合法变化保外部行为、沿明确原意补齐必要状态边界及验收。过窄测试不能把允许行为反改成旧代码。每项发现含原意、原/新及双方行为、影响路径与ID、实际证据、具体反例和所需裁决，程序形成稳定ID。

原始作者raw/规则差量是已有用户授权，不重复提问；authorChanges由程序从冻结字节求语义差量并进入独审。AC更新proposal仅在合法已审REQ/RULE/TR变化与完整来源链成立时派生，不删验收或改VERIFY。独审proposal先冻结，程序再绑定真实analysisRef形成授权；模型不能自填作者证据或可信批准。

相容重叠必须提供完整整合正文并独审，不丢前次交付或合法外部行为。无治理新增代码自动定位真实上层raw、生成唯一治理叶；目标未知提出具体GAP，不跳过该文件。节点移动保业务ID及旧新路径证据，节点退役仍需逐项用户原意/裁决授权。裁决新操作重读原具体分析和不可变choice，在当前policy/readset下重新独审；未选冲突保持，仅选择采用行为保对应外部行为，保留原意/新规则按明确目标修代码。
