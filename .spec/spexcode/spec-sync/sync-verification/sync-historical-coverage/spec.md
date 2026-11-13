---
title: 已采纳历史未执行覆盖的精确保留
status: active
desc: 仅把未变且不属本轮影响范围的既有已审未执行义务保留为 warning，所有当前义务和普通结构门保持。
code:
  - spec-cli/src/sync/historical-coverage.ts
related:
  - spec-cli/src/sync/historical-coverage.test.ts
---
# 已采纳历史未执行覆盖的精确保留

## raw source

手动初始化已明确记录某项测试未执行并正式采纳后，独立业务的新提交不应被这项完全未变的历史缺口阻断。新的或已改变的业务义务仍须按本轮严格规则验证，历史报告不能变成新的跳测授权。

## expanded spec

可信新接入只从当前完整发现选择中的精确 contract intent pair 冻结既有缺口候选，不能扫描历史列表或借全局最新 pair。既有 planBlob 内联版本、输入 ID、摘要，以及按精确基线分组的 pairId、receiptId、原 verificationRef 和契约 ID 列表；不复制整个基线、源码或 manifest。重复请求和正式 retry 使用原计划，旧缺席保持严格语义。

每次使用按 pair 主键读取原件，复用完整 settledReceipt 验证真实 Git、四层通过、输入、政策、范围、candidate、journal 与 receipt 绑定。原操作须明确记录未执行覆盖，原报告须列出该 ID，原资源须结算，receipt 提交须为本次冻结输入 HEAD 的祖先。缺证、异源、未采纳或不匹配不得换来源或补签。

只允许本轮 scope 外的 REQ、RULE、TR。稳定 ID、kind、owner、来源及业务含义必须保持；其 owner 与声明依赖闭包内的 Spec、code、related、测试和源码引用在原 receipt、本次 input、实际候选之间逐路径 mode、OID 及 absence 相等。已有缺席路径和目录声明命中的新增路径也参与检查。当前可变身份、owner 改写、代码或依赖变化、新义务与未知结构错误均不获得资格。

P1 全图 seal 与候选 V1 在已有唯一契约图上调用同一逐 ID 判据，仍由原 validateContractGraph 产生 warning；不能过滤所有范围外错误。局部模型请求不携历史证明或扩大读取，执行计划、mandatory、预算、显式 recordUnverifiedCoverage 及新报告范围保持。新层仅保留历史未执行事实，不声称本轮运行过这些测试。

同一 warning 明确显示“历史上未执行”，只进入当前 P1/V1 的正式证据，不扩展新验证报告的 coveredScope 或 unexecutedContractIds。新 receipt 与采纳不能替换范围外旧义务的 pair/head，旧报告与旧详情继续保留其原未执行清单。

冻结计划的证明沿原件读取。原报告、manifest 与 receipt 继续由既有持久记录保活，计划本身沿原 planBlob 内容寻址。writer50 保护新判据，旧 saved/reserved 计划保持原字段，升级与回滚保一致数据库、证据和 Git 引用。

每次冻结或候选检查重新认证原件；只在该次校验内按精确 pair、owner 和路径复用条目清单、解析与闭包结果，并沿已有 Git 对象批读读取原件。同 owner 增加旧 ID 不重复原件 I/O 或整份 inventory 构造；当前图的义务展开复用已有 Contract，不能持久缓存授权或跨候选跳过冷验。

真实 Git/SQLite 回归先由正式交付、采纳和独立业务提交复现全图 missing-acceptance，再核完整 V1 及实际分区 seal 保留精确 warning。覆盖旧字段缺席、当前 scope、新义务、一般结构错误、源码/测试/跨 owner 依赖/模式/目录成员变化，以及同字节但无真实采纳祖先、原授信或报告缺席、来源或 receipt 失配、资源未结算。原件保持。初始化四层通过和分区模型回应是明确受控前置，不冒称真实模型或 Docker 执行。

独立联合用例沿真实应用协调、当前 Docker 验收、正式新 receipt 和采纳，核只有当前 owner 的测试实际运行，历史 pair/head/原报告与旧详情保持。它仍使用明确受控的模型回应；当前 Docker 执行与初始化受控前置分开陈述。
