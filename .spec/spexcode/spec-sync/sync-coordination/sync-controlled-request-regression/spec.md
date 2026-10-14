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
