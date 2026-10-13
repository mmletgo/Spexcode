---
title: 草稿lint与契约指南的真实CLI回归
status: active
hue: 175
desc: 临时Git仓库通过真实命令验证契约草稿、结构拒绝、候选树及指南派生边界。
code:
  - spec-cli/src/sync-contract-lint-guide.cli.test.ts
---
# 草稿lint与契约指南的真实CLI回归

## raw source

作者必须能保存高层需求，也必须从实际CLI看见已有声明的结构错误；提交候选不能借工作区的其他版本通过。

## expanded spec

依据 [[sync-contract-schema]]、[[spec-lint]] 和 [[guide]]，通过构建后的公开启动入口在真实临时Git仓库运行
`spex spec lint --json`、`spex guide spec` 和 `spex help spec`。验收保持JSON报告和错误退出：raw-only、REQ-only、围栏原文、跨节点引用以及未决GAP
可保存；错误表头、非法或重复稳定ID、悬空引用和未知schema均拒绝。

有效候选遇到无效工作区仍通过；无效候选遇到有效工作区仍拒绝。未实现的AC文件只显示未验证提示，
VERIFY登记不触发命令或Agent。实际指南包含核心派生的全部固定表头、单source与多depends-on、草稿
语义和bound不等于运行证据的说明，help同步该草稿规则与证据边界，不宣传未实现命令。该回归仅证明草稿lint和语法指南接入，
不代表后续同步语义、实现、运行或交付完成。
