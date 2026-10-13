---
title: Markdown 契约解析与语法诊断
status: active
hue: 175
desc: 从调用方给定的源文本解析启用契约，拒绝错误语法并保留真实源位置。
code:
  - packages/spec-core/src/contracts/parser.ts
---
# Markdown 契约解析与语法诊断

## raw source

同一份人写 Markdown 必须产生可追踪的契约结构；草稿与错误语法需要分清，不能依赖派生文件维护另一份事实。

## expanded spec

唯一语法及固定表头属于 [[sync-contract-schema]]。`parseContract` 接收节点身份、Spec 相对路径和源文本；未启用不产生契约，错误 schema 或结构产生定位诊断。仅 raw 或 REQ 的高层草稿可以解析，完成范围由 [[sync-contract-validator]] 判断。

解析忽略围栏中的结构示例，识别 Markdown 转义竖线与单元格代码范围；表头可换序但必须完整，行与语义必需值必须合法。来源、引用集合、布尔、处置、GAP 类型和命令 argv 按父契约解析。治理、代码来源、测试路径和执行目录只接受相应仓库相对形式；一个启用节点最多治理一个文件。

解析器不读取仓库、不调用 Git、不执行 VERIFY，也不证明自然语言规则或测试真实通过。
