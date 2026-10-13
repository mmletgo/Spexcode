---
title: 契约内容摘要与确定性
status: active
hue: 175
desc: 将原意、详细政策、治理和契约内容规范化为确定性摘要，不赋予摘要完成语义。
code:
  - packages/spec-core/src/contracts/digest.ts
---
# 契约内容摘要与确定性

## raw source

调用方需要识别同一契约版本及内容变化；仅记录派生图或数量不足以绑定实际用户意图。

## expanded spec

内容归属与证据边界遵循 [[sync-contract-schema]]。`contractDigest` 纳入原始需求、详细正文、节点与路径、治理和上下文映射、全部条目与验证政策；按节点、条目及映射集合和对象键规范化排序，去除诊断行位置，输出 SHA-256 摘要且不修改输入。

相同内容的节点收集顺序不影响摘要，业务原意或验证政策改变必须改变摘要。摘要是版本识别输入，不证明源码符合规则、不证明测试执行，也不替代 [[sync-verification]] 的当前候选证据。
