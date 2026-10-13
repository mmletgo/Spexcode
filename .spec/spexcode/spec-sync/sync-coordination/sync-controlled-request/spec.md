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

composeControlledRequest 不修改 InputSnapshot 或伪造 BaselinePair。它验证已有 ComposedInputRef 的完整 manifest/tree/contentDigest，以原 source 为 base、用户 next 为 source、已有 composed 为 delivery，复用真实 UTF-8 三方合并。非重叠请求保留 prior delivery 的 expanded 内容与其它生成文件；重叠、删除/修改或 mode/symlink 分歧返回明确 base/source/delivery Git 对象证据，不能覆盖或吞掉冲突。成功另存完整 manifest/tree/private composition ref，并把 requestBlob 绑定到 resulting composed；同请求重入幂等，不同请求不能隐式复用已有请求结果。没有用户请求时，既有 composeInputSnapshots API 与行为保持不变。
