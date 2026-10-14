---
title: 业务行确定性渲染 Markdown
status: pending
desc: 原意及绑定由程序复制，临时业务行生成唯一可编辑契约。
code:
  - spec-cli/src/sync/elaboration-markdown.ts#renderElaboration
---
# 业务行确定性渲染 Markdown

## raw source

模型不应承担表格语法和摘要计算；业务行必须转为唯一 Markdown 候选，保留冻结原意和来源绑定。

## expanded spec

[[elaboration-output]] 的临时行通过 schema 检查后，按 `CONTRACT_COLUMNS` 顺序和列名渲染固定标题、表头及相同列数的分隔行。空类型数组不生成空表。引用数组生成逗号集合，布尔保留 true/false，空引用和 null 使用 `-`，VERIFY 命令序列化为 JSON argv。单元格转义反斜杠、反引号和管道，换行使用 `<br>`；argv 不允许 NUL 或换行，转义不改变其解析后参数。

程序从冻结目标复制原内容摘要和既有 frontmatter 元数据，原文从冻结 primary intent 或子节点原意/围栏感知 raw 段复制。模型不能生成 raw 或摘要字段；节点、路径越界仍由 [[sync-elaboration]] 拒绝。最终候选包含完整 UTF-8 Markdown，程序计算输入/候选/内容摘要；临时业务行只保留为执行证据，不构成第二份权威契约。

`AC-ELABORATION-18`、21、22 验证真实错列/拼接来源的失败路径由行协议消除，原文与源绑定由程序复制，元数据和含转义字符的 argv 可解析回原值。业务范围、政策真实性和主流程完整仍须结构校验及独立审查，不由渲染器补写答案。

冻结 nodeChanges 决定节点搬迁与退役，模型不能自行指定生命周期授权。move 按旧节点复制原意、元数据及源摘要，输出新 canonical 定位，并在候选显式保存生命周期记录；retire 可产生没有文件正文变更的候选，由完整旧新图继续检查授权和引用。preserve_business 使用既有正文和元数据，忽略模型重写的业务解释与标题，仅渲染必要契约行绑定及 code/related，防止纯重构改写文案。

纯重构替换业务表时识别反引号和波浪线围栏，围栏中的固定标题与示例表格逐字保留；仅替换围栏外的真实契约表。验证登记的临时技术渲染始终使用独立 reelaborate 上下文，不继承业务纯重构、迁移或再细化模式，不会清空既有业务表。
