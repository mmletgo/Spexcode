---
title: sync-v1 Markdown 契约语法
status: pending
hue: 175
desc: 唯一可编辑业务契约的固定表格、稳定 ID、来源和可执行验收绑定；解析器与指南落地后启用。
---
# sync-v1 Markdown 契约语法

## raw source

Spec Markdown 是唯一可编辑业务契约。原始需求、详细规则与实现可双向追踪；规则唯一归属，验证须真正执行且绑定当前候选。

## expanded spec

启用节点的 YAML frontmatter 增加 `contract-schema: sync-v1`。保留 `## raw source` 和 `## expanded spec`；前者保留人写原意，后者包含以下固定三级标题与表格。表头按下表固定拼写；顺序不改变含义；每行一项，不把 prose 或第二份 JSON 视为契约。业务表的公共列为 `id`、`source`、`depends-on`。

| 标题 | 固定表头（包含公共列） |
|---|---|
| REQ | id, goal, source, constraints, success, depends-on |
| FLOW | id, req, actors, entry, preconditions, steps, terminal, source, depends-on |
| STEP | id, flow, action, input, output, rules, next, source, depends-on |
| STATE | id, object, meaning, initial, terminal, feedback, source, depends-on |
| EVENT | id, object, origin, trigger, input, source, depends-on |
| TR | id, object, from, event, condition, to, disposition, reason, effects, rules, source, depends-on |
| RULE | id, scope, constraint, basis, authority, source, depends-on |
| AC | id, covers, preconditions, action, assertion, test, command, source, depends-on |
| GAP | id, kind, unknown, affects, evidence, decision, source, depends-on |
| VERIFY | id, command, cwd, timeout-ms |

`REQ/FLOW/STEP/STATE/EVENT/TR/RULE/AC/GAP` 是项类型；`VERIFY` 只登记可执行工具命令。空值使用 `-`，布尔使用 `true/false`，引用集合以逗号分隔，不含隐藏 JSON。出现的结构表必须使用固定标题、完整表头和非空行；行必须包含全部列，id/source及语义必需值非空，允许缺省的引用或终止值使用 `-`。解析与完成是不同层：仅 raw/REQ 的高层输入可解析为 incomplete；完成范围至少需要 REQ、RULE、AC、其命令绑定和适用 FLOW/STEP，缺少这些由完整性检查阻断，不冒充语法错误。只有适用的表出现，无状态能力必须以正文写清不适用依据，不能提交空状态表冒充覆盖。`GAP` 无缺口时省略，不写伪造的“已解决”行。

ID 使用 `类型-业务域-稳定后缀`（ASCII 大写字母、数字和连字符）；`VERIFY` 使用 `VERIFY-业务域-稳定后缀`。身份不依赖标题或路径，移动保持 ID，复制生成新 ID，退役不复用。`req/flow/steps/rules/from/event/to/covers/depends-on/affects` 引用同范围或其他启用节点的稳定 ID：req 为 REQ 列表；flow 为单 FLOW；steps 为 STEP 列表；rules 为 RULE 列表；from/to 为单 STATE（不适用目标除外）；event 为单 EVENT；covers/depends-on/affects 为业务 ID 列表。`FLOW.terminal` 为 STATE 列表或 `END`（无状态流程结束，须写明可观察结果及不适用依据）。`STEP.next` 为 STEP/TR/STATE 引用列表或 `END`（终止）；正常和失败分支可引用对应 TR，拒绝及结束的可观察结果写在 output 与权威规则中。文本条件和动作不作 ID 解析。`STATE.object`、`EVENT.object` 与 `TR.object` 是稳定业务对象名；每个对象单独命名事件，由 EVENT.object 确定状态×事件适用域。TR.disposition 为 `transition/reject/idempotent/not_applicable`；transition 的目标是有效状态，reject/idempotent 的目标等于原状态，not_applicable 的目标为 `-` 且 reason 必填。condition 不成立的边界仍须有明确规则和验收。

来源使用 `user:raw`、`user:REQ-ID`、`decision:裁决ID`、`rule:RULE-ID`、`derived:稳定ID` 或 `code:仓库相对路径#符号`。用户原意只在 raw 定义一次；结构化 REQ 用 `source: user:raw` 提取目标。`depends-on` 保存推导依赖，代码来源仍要验证与上层原意相容。`RULE.authority` 为唯一定义规则的节点 ID；其他节点引用该 RULE-ID，不能复制同义政策。来源不替代运行证据。

`GAP.kind` 为 `missing_fact/conflict`；每个 GAP 必须写明未知或互斥事实、影响 ID、证据与所需具体裁决。未决 GAP 阻断依赖项，不能以置信度或空值通过。

一个治理叶节点的 `code:` 最多指向一个代码文件，可在该文件中列多个 `path#symbol`。`related:` 不计实现覆盖。`AC.test` 为 `仓库相对测试路径#稳定用例ID`；测试用例标题携带该 ID。`AC.command` 引用已登记 VERIFY-ID；VERIFY 与业务 ID 在同一同步范围内全局唯一，跨节点可引用，执行目录相对仓库根解析。VERIFY `command` 单元格是 JSON argv 数组文本，例如 `["node","--test","tests/export.test.mjs"]`，`cwd` 是仓库相对目录（`.` 为根），`timeout-ms` 是正整数。执行器通过 argv 调用工具，不把命令拼进 shell。命令、测试文件和断言是验证政策，删除或改弱都不能自行退出门禁。

表格接受 Markdown 转义竖线 `\|` 与单元格代码字面量；解析时先识别转义和代码范围，再分列。测试绑定指向真实可运行场景。结构检查能证明引用、归属与声明处置，不能证明自然语言条件互斥完备；独立审查和具体运行补足语义。

完整参考输入位于 `spec-cli/test/fixtures/spec-sync/export-repo/`；其规则只属于夹具演示，不是用户项目默认政策。缺失分支与违背下载权限的变体用于拒绝虚假通过。产品节点本身仍 pending，等待 [[sync-elaboration]] 和 [[sync-verification]] 的解析、覆盖及证据实现。
