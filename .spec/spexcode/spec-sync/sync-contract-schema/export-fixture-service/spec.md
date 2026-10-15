---
title: 导出验收夹具的内存服务
status: active
hue: 175
desc: 忠实执行固定夹具的既有业务规则，不因键编码碰撞泄漏或复用另一任务。
code:
  - spec-cli/test/fixtures/spec-sync/export-repo/src/export.js
related:
  - spec-cli/test/fixtures/spec-sync/export-repo/.spec/export/export-contract/spec.md
---
# 导出验收夹具的内存服务

## raw source

固定夹具的唯一业务规则保存在随附契约；实际服务必须满足已声明的任务身份、权限和状态处置。

## expanded spec

复用内存Map按actor和key分别索引任务，使所有当前接受的值沿与所有者检查一致的身份语义隔离。不能用JSON组合序列化把Infinity/-Infinity或不同对象折成相同任务，也不为修复编码缺陷缩小既有输入域。其余规则、稳定ID、状态流及固定验证命令仍由随附契约定义。
