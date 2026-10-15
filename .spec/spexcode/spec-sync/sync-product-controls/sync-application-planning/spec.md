---
title: 同步应用影响计划
status: active
hue: 175
desc: 复用冻结契约图与旧节点治理，构造可信读写闭包。
code:
  - spec-cli/src/sync/planning.ts
---
# 同步应用影响计划

## raw source

已有功能或高层自然语言节点都复用治理及契约影响；授权目录内可创建实现和测试，不能要求用户逐函数写计划或漏掉共享权威节点。

## expanded spec

[[sync-application]] 从 source snapshot 读取 Spec，复用 loadSpecs、readFrozenContracts 和 contractImpact，不维护第二份业务图。初始上下文仅读 Spec，不把整仓未授权文件或凭据转成字符串。目标包含意图节点、其子节点、图影响节点和共享代码治理闭包；related 不计治理。受影响 code/test 必须在 [[sync-application-settings]] 的授权或独立保护测试登记，否则显示未授权路径。

readPaths 纳入冻结 Spec、版本化配置、额外 readPaths、实际影响代码/测试及保护测试；writePaths 只含目标 Spec 精确路径和 source/test 授权目录。目录授权允许新自然语言需求创建实现，不授权任意磁盘或模型创造新 raw 意图。plan 传递 facts、精确 verification 和 mandatoryTests 给 coordinator；全部 source/composed 差量仍经过完整 read/write 检查，不能偷偷交付未验证的其它 dirty 修改。V4 复核冻结 plan 的配置、selection与readSet，不能借最新无关基线改写本次政策。

可携最近共同BaselinePair，对旧verifiedDelivery及当前source图求影响并集，旧测试/治理路径与移动退役目标仍纳入完整范围，不因删除文件退出验收。从移动后的节点发起同步时，同样依稳定业务ID找到旧节点并读取旧影响闭包；已匹配新位置的旧节点不重复成为生成目标，其旧Spec精确路径仍在写范围中，以便真实删除旧位置。被明确移除的意图定位最近仍存在的上层需求。目标Spec目录受控授权自动新治理叶，但不授权宿主或其它未选节点。

已receipt结算decisionRefs重读不可变用户裁决与所选finding.ruleIds，派生精确supersession事实。原settings facts全文留历史，只有所选规则按裁决生效；未选业务事实、VERIFY及工具政策保持。后续无关代码输入继承同一已结算裁决，不恢复旧行为。

已消失的显式旧nodeId始终保留旧目标及raw、旧新图的测试影响。上层仍存在则以最近上层原意协调；最后业务节点被删时以旧验证交付冻结原意定位退役，仍须独审及真实负向验收，不因当前树404或0AC自免。已结算结构化decisionAuthorities从immutable request/原finding程序派生，文字facts说明不扩授权范围。

P4规划可读取精确 FrozenBaselineSelection：文件正文以各 path 真 bytePair 的交付对象恢复保护上下文，逐 ID 不同旧交付图的真实影响保持并集。deriveSyncBaselineResources 从真实当前/既有快照及 plan 的实际读取/保护文件推导 exact path 与既有契约/flow ID；授权目录不是完整范围或已验证覆盖。缺失的精确目标、保护测试、配置与既有 tombstone 仍是资源；未来新业务 ID 由真实细化结果原子扩范围，不猜测。已结算裁决与退役历史按实际选中 pair 去重继承。

P4的executionScope只含实际目标Spec/治理代码/影响测试路径及目标业务身份。readPaths只含目标、实际引用权威、祖先需求、影响code/test、mandatory测试与明确额外上下文；source/test授权目录保持模型写授权，不能假冒本次完整读取。FLOW只用flow资源，VERIFY保执行政策而不是已消费业务身份；只读与保护资源不等同写lease或验证覆盖。

mandatoryTests即使由contractImpact引用也只读；executionScope仅纳入可信source/test授权内且非保护测试的实际code/test，不把独立oracle晋升为写lease。

已注册上层的源码发现复用冻结snapshot及现有治理元数据：sourcePaths仅作为可信枚举授权，实际未治理功能源码（含已commit与未跟踪新模块）以exact readonly路径进入readPaths/selection及完整行为分析，不能被窄闭包静默遗漏。治理排除取当前source、真实path交付及每个实际path byte头对应的verifiedDelivery owner Spec并集；来源尚未ff接受的已结算新leaf/code亦不重复当无治理。独立已治理B的dirty/commit不进入A读取、executionScope或coverage。发现不是归属批准：沿已有raw提出newNodes，归属不明返回具体coverage_gap；不能仅因sourcePaths发现新模块而自动启用新节点，注册成员仍由应用层可信nodeIds/既有治理范围限定。

业务selection裁到本次真实读取资源后，调用者仍以discoverySelection传已有真实全资源头selection，仅供各真实path头对应的已交付治理元数据排除；程序重核该selection和真实delivery对象。它不作本次byte/intent基准，不加入write/coverage，不恢复global latestpair回退。fresh freeze的各次构建传同一实际发现selection；V4/重放/重试复用冻结plan并复核配置及既有readSet/selection门禁，不能改用最新无关头重新规划policy。不能从其它code头的历史全树复活已退役owner；避免完全独立的已结算新leaf被裁掉后再次误归无治理。

版本化配置可登记多个独立节点政策。执行mandatory仅保当前目标、实际impact及真实依赖VERIFY的政策；已知独立owner的无关mandatory不因共享配置被送入本次候选。verification定义另保实际readonly Spec上下文中的VERIFY，满足候选逐项严格登记，但该只读登记不授独立节点write/coverage或触发全仓oracle执行。当前、旧交付及保护图的真实owner并集决定范围，当前输入删owner/VERIFY不能规避旧命令及退役oracle。无任何真实owner的预登记定义和mandatory继续保留供纯raw细化/严格gate暴露缺口；schema及命令校验先于范围筛选，不能静默过滤坏政策。
