---
title: 受控请求真实 Git 回归
status: active
hue: 175
desc: 用真实临时 Git 与 SQLite 证明受控请求不改源、保留生成内容并拒错绑定。
code:
  - spec-cli/src/sync/request-input.test.ts
---
# 受控请求真实 Git 回归

## raw source

不能把只读准备回调当作已经保存的输入，或以整份用户文件覆盖 Agent 已交付的细化。

## expanded spec

验证 [[sync-controlled-request]]：在真实临时仓库中调用 readonly prepareSpecBodyEdit，准备、验证、组合全程保持实际 source、用户 index 和 HEAD 不变。同一来源两种编辑得到不同请求与组合对象且不能混用；no-op 不产生请求。真实 prior delivery 的 expanded 和独立生成文件在用户 raw source 非重叠修改后保留。重叠编辑返回可读取的三方 Git blob 证据，不产出可接受组合。

Spec 文件及父目录 symlink 越界在 guard 阶段拒绝，不跟随外部读取；错误物理 root、原文、frontmatter、请求 hash、inputId、next digest、requestTree、composed manifest 均拒绝。新 source 不重放旧请求。SQLite 的 bindComposedInput 只接受与 operation.requestBlob 相同的请求引用，无请求操作不接受有请求的组合输入；正确绑定可在数据库重启后读取。

无正文差量的 keep_intent 裁决仍冻结有效对象并绑定组合输入，保持原 tree/manifest/contentDigest；校验 input、非空不重复 finding IDs 和新规则内容。原 controlled patch 由 originalRequestBlob 继承，重新组合和重复绑定保持原用户需求；跨输入或嵌套裁决引用拒绝。

controlledDecisionIdentity 从原operation/input/analysis、排序finding IDs与choice/精确rule计算稳定业务摘要，排除运输requestId。同选择换UUID或finding顺序仍为同一业务身份，不应重开operation/预算；改变选择、规则或原分析则是新的业务输入。原requestId仍用于接入收据与同key全payload严格重放。

P3业务分析调用retainConflicts:true时，正文文本重叠先冻结作者next字节和完整三方Git对象，保存composition-overlap-v1/sourceInputId/baselinePairId/conflicts；保留既有组合冲突证据，裁决继承原body时透传相同选择。它不证明业务获准，协调器必须依据原始三方上下文独立分析，要求具体resolved正文或业务finding；默认受控编辑组合仍明确返回冲突，不能静默吞掉。

真实临时Git验证同行不重叠文本编辑自动保留完整作者与交付字节、source/index/HEAD只读；真正相互覆盖的文本仍有三方证据。裁决raw渲染保传入已接受正文，仅追加所选finding的adopt/new_rule，keep_intent字节不变；换运输UUID得到同正文，未选规则不进入说明。
