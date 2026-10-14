---
title: 受控用户请求与组合输入
status: active
hue: 175
desc: 冻结用户 Spec 编辑意图，把真实来源差量叠加到已组合输入，保留生成细化与冲突证据。
code:
  - spec-cli/src/sync/request-input.ts
---
# 受控用户请求与组合输入

## raw source

用户通过受控编辑或裁决请求修改 Spec 时，实际来源文件还没有保存。协调器必须保留真实来源身份和先前生成的细化，只应用用户要求的差量。

## expanded spec

本节点属于 [[sync-coordination]]。guardControlledRequestPath 在旧 readonly prepareSpecBodyEdit 之前按冻结 source 的真实物理 root 核已知 Spec 路径，逐级 lstat 拒 symlink 和非目录父路径，不读取外部文件。prepareControlledRequest 接受该 readonly 准备结果，核原 bytes 与稳定 InputSnapshot 的 Git blob/digest 相同、Spec frontmatter 未改和 UTF-8 文本；不写来源、用户 index、HEAD 或真实分支。无文字变化明确返回 changed=false/requestBlob=null。

请求采用 schemaVersion=1，绑定 inputId、完整来源物理身份、Spec path、原 before 与用户 next 的 path/mode/Git blob OID/SHA256 digest、requestTree，以及 kind、requestId、nodeId 和 intent 的用户原意来源。正文仍是 Git blob，请求 evidence blob 只保存不可变引用与意图。请求 tree 由原 source 仅替换目标 Spec 构成；私有 request ref 保活全部对象。validateControlledRequest 重新核请求 hash、输入身份、原文、目标对象、完整 tree 和 frontmatter；不同新 input 不能重放旧请求。

只读历史展示通过 readControlledRequest 复用同一不可变对象校验，不访问当前来源路径；来源文件移动或删除后仍能审阅当时的用户请求。validateControlledRequest 在此基础上额外核当前物理来源及路径，保持应用前的原有门禁。

composeControlledRequest 不修改 InputSnapshot 或伪造 BaselinePair。它验证已有 ComposedInputRef 的完整 manifest/tree/contentDigest，以原 source 为 base、用户 next 为 source、已有 composed 为 delivery，复用真实 UTF-8 三方合并。非重叠请求保留 prior delivery 的 expanded 内容与其它生成文件；重叠、删除/修改或 mode/symlink 分歧返回明确 base/source/delivery Git 对象证据，不能覆盖或吞掉冲突。成功另存完整 manifest/tree/private composition ref，并把 requestBlob 绑定到 resulting composed；同请求重入幂等，不同请求不能隐式复用已有请求结果。没有用户请求时，既有 composeInputSnapshots API 与行为保持不变。


裁决使用显式 type=sync.decision 的 schemaVersion=1 不可变请求，prepareControlledDecision/readControlledDecision 绑定原 operationId、inputId、可信 analysisRef、非空且不重复的 findingIds、稳定 requestId、source 与 keep_intent/adopt_behavior/new_rule 选择；new_rule 必须有用户规则正文。保持原需求没有正文差量也保存有效请求。它与正文差量明确区分，composeControlledRequest 仅绑定裁决 requestBlob、保持组合 tree/manifest/contentDigest，实际规则或代码变化由经验证的裁决协调方向生成。请求本身不把任意 analysisRef 升为授权；可信分析的原操作/检查点归属由应用与协调器核验。
