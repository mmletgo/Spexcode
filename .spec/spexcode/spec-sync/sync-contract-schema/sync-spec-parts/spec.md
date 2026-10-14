---
title: 围栏感知的规范段落读取
status: active
desc: 同一状态机读取raw与expanded内容，提供真实内容行位置供确定性更新。
code:
  - packages/spec-core/src/spec-source.ts#parseParts
related:
  - spec-cli/src/sync/elaboration-markdown.test.ts
---
# 围栏感知的规范段落读取

## raw source

规范段落只按真实标题和围栏边界读取；更新原意及正文时不能把标题、导言或示例里的相同文本当成实际段落。

## expanded spec

parseParts 复用唯一围栏状态机识别 raw source 和 expanded spec，围栏里的伪标题不切换段落；未知二级标题仍属于当前段落。识别段落的全部内容行按原顺序合并并 trim，现有返回形状和默认调用语义不变。

可选 onContentLine 回调由同次扫描报告当前段落、内容行和规范化换行后的起始位置，不从内容文本猜位置，不引入文件读取或运行副作用。调用方可从相邻真实内容行派生连续区间；重复识别段落可形成多段位置，不能以首尾大范围覆盖交错的另一段落。位置针对规范化后的输入文本，CRLF输出格式由调用方保留。
