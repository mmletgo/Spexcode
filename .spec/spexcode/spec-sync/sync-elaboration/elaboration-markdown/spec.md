---
title: 业务行确定性渲染 Markdown
status: pending
desc: 原意及绑定由程序复制，临时业务行生成唯一可编辑契约。
code:
  - spec-cli/src/sync/elaboration-markdown.ts#renderElaboration
  - spec-cli/src/sync/elaboration-markdown.ts#elaborationPatchErrors
related:
  - spec-cli/src/sync/elaboration-markdown.test.ts
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

当前统一行差量协议从本轮冻结 sync-v1 Markdown 解析旧行身份，只替换同 ID 完整行、追加新行及显式 removeIds；未列旧行保持原字节、顺序和义务。同节点重复更新、重复删除、未知删除或同 ID 删除后更新被明确拒绝，不能用合并掩盖重复。跨叶移动以旧叶 removeIds 与新叶完整行表达，再经旧新全图核对；缺少删除仍保留旧行并触发重复 ID，节点迁移或退役仍仅来自冻结生命周期授权。

prose:null保留完整既有 expanded 段，包括表间/表后说明、围栏示例和无状态不适用依据；显式 string 替换只改业务解释，仍受原意与既有义务门禁。没有业务行的 raw-only 或新节点从空基线应用同一协议。删空类型省略该表，无状态与有状态转换使用显式正文及普通 STATE/EVENT/TR 行，渲染器不猜业务 N/A。空差量且元数据不变、原样行更新逐字返回既有文件（含换行格式），不能借纯重构重排表格或改写说明。

差量回归验证大冻结基线只返回一条新行但完整保留全部旧 ID、raw 和后置正文，响应大小由新行决定；更新、显式删除、重复操作、raw-only、正文围栏和状态不适用转换均保持可解析完整候选。

changes 省略已启用 sync-v1 的既有目标时，程序把该冻结文件补入完整候选，保持原字节；只返回子叶差量或空 changes 不要求模型重抄 primary/其他未变叶。新节点或 raw-only 目标没有可沿用的完整行基线，省略它们是明确未细化错误。冻结 retire 排除旧目标，不能因补全而复活；冻结 move 以新定位补入旧内容，保留 RULE 行或提供旧 canonical authority 时仅按该真实 move 将 authority 更新为新 nodeId，业务 ID/约束/raw 保持，不授权任意改名。

冻结表头可使用解析器允许的非canonical列顺序。沿用正文保留旧表头时，新增/替换行按现解析器 contractTableCells 读出的旧列序渲染；显式正文替换使用canonical新表头时，所有继承旧行先按已解析字段重建到新列序。两方向均保留原字段语义，不能将目标、来源或验证绑定错列。

raw/expanded 的更新位置来自 [[sync-spec-parts]] 原围栏感知扫描的实际内容行，不用 indexOf 查找整段文本；标题、导言或围栏示例先出现相同文本不会成为替换目标。未变段落保持原字节；重复识别段落仅更新各自真实连续内容区间，不能跨过交错段落。raw 更新与行差量可同时处理，CRLF与原意里的围栏伪标题保持保真。
