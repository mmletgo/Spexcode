---
title: sync-v1 Markdown 契约语法
status: active
hue: 175
desc: 固定表格、稳定 ID、来源和验收绑定已接入纯核心、指南与草稿lint；完整同步产品仍待交付。
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

一个启用契约节点的 `code:` 最多指向一个代码文件；跨文件职责按需拆为子节点，可在该文件中列多个 `path#symbol`。`related:` 不计实现覆盖。`AC.test` 为 `仓库相对测试路径#稳定用例ID`；测试用例标题携带该 ID。`AC.command` 引用已登记 VERIFY-ID；VERIFY 与业务 ID 在同一同步范围内全局唯一，跨节点可引用，执行目录相对仓库根解析。VERIFY `command` 单元格是 JSON argv 数组文本，例如 `["node","--test","tests/export.test.mjs"]`，`cwd` 是仓库相对目录（`.` 为根），`timeout-ms` 是正整数。执行器通过 argv 直接调用工具，不把命令拼进 shell，也不登记 shell 可执行文件。命令、测试文件和断言是验证政策，删除或改弱都不能自行退出门禁。

表格接受 Markdown 转义竖线 `\|` 与单元格代码字面量；解析时先识别转义和代码范围，再分列。测试绑定指向真实可运行场景。结构检查能证明引用、归属与声明处置，不能证明自然语言条件互斥完备；独立审查和具体运行补足语义。

完整参考输入位于 `spec-cli/test/fixtures/spec-sync/export-repo/`；其规则只属于夹具演示，不是用户项目默认政策。缺失分支与违背下载权限的变体用于拒绝虚假通过。语法定义、纯解析和结构投影、[[guide]] 中的表头与字段指南、[[spec-lint]] 中的启用契约草稿检查已有实现；本节点 active 仅表示这一语法接入范围，完整细化及运行证据由 [[sync-elaboration]] 和 [[sync-verification]] 继续交付。

本节点唯一维护语法与业务约束；实现治理分属 [[sync-contract-types]]、[[sync-contract-parser]]、[[sync-contract-graph]]、[[sync-contract-validator]]、[[sync-contract-coverage]]、[[sync-contract-digest]]、[[sync-contract-api]]，针对性回归由 [[sync-contract-regression]] 和 [[sync-contract-lint-guide-regression]] 治理。技术叶及本节点 active 不表示运行证据或全产品交付完成，上层 [[spec-sync]] 的完整交付状态独立保留。

普通 `spex spec lint` 只校验已经声明的结构，允许 raw/REQ 高层草稿和未决 GAP；完整性、独立语义审查、实现与真实执行属于后续同步门禁。候选提交中的启用标记和全部表格必须从同一提交树判断，工作区的不同内容不能替候选通过或失败。指南直接使用纯核心表头定义，避免产生第二份维护的语法。


纯核心入口为 `@spexcode/spec-core/contracts`。`parseContract` 接受节点 ID、仓库相对 Spec 路径和源文本；未启用返回空契约，raw/REQ 草稿保留为可细化输入。默认完整性检查与草稿结构检查分离；重复 ID、悬空或类型错误引用、来源/推导依赖循环、归属错误、状态对象不一致、状态事件处置缺失、不可达状态及无出口非终态均阻断完成。业务状态循环与流程导航循环允许存在，只要流程有可达结束。

完成范围内，STEP 通过 depends-on 或 source 显式引用 EVENT 时，必须在 next、depends-on 或直接 TR source 中声明至少一个 event 匹配的 TR，表示该步骤涉及的状态处置；缺失或引用错误事件的 TR 报告 `step-event-disposition-missing`，草稿允许继续细化。输入检查或路由步骤同样明示自身涉及的处置引用；结构检查不从动作正文推断状态域，也不自动关联同 EVENT 的全部状态 TR。步骤涉及的处置集合是否忠实完整仍由独立语义审查判断，不能通过新增 GAP 豁免结构缺口。

GAP 的阻塞闭包沿来源、depends-on、规则使用、AC 覆盖及 STEP.next 的 TR 处置引用扩散，不沿流程归属、FLOW.steps、STEP.next 的 STEP/STATE 导航扩散；步骤只依赖自身明确引用的处置，同事件其他状态的未知政策不得污染限定状态步骤。高层需求可以无本地 code，由明确推导关系、叶节点治理与 AC 绑定形成实现覆盖；验收与实现可以分属不同节点，覆盖不得依赖 AC 与实现文件同归属。覆盖只投影 `declared/bound/missing`，结构 bound 不代表真实测试通过。

实际文件由调用方传入 `context.files`；缺少该上下文须报告绑定未验证。提供文件后检查治理文件、代码来源文件、测试文件和携带稳定 ID 的测试标题；通过测试 API 的合法导入别名声明的静态标题同样有效，注释和字符串中的调用示例不计声明。已登记 VERIFY 可为直接测试入口或工具脚本；间接入口的用例选择不能由 argv 字面量机械证明，报告待运行证据确认。条件语义及竞争完备性始终需要独立审查，不能凭某状态存在一行 TR 自动通过。内容摘要包含原始意图、详细正文、治理、来源、全部条目及验证政策；派生图和覆盖不是另一份可编辑事实。
