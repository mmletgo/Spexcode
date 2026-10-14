---
title: 持续同步中央编排
status: active
hue: 175
desc: 从稳定输入经独立细化生成及四层验证结算真实私有交付。
code:
  - spec-cli/src/sync/coordinator.ts
---
# 持续同步中央编排

## raw source

一次高层需求应自动完成可信细化、实现、真实验收和可复核交付；暂停、取消、进程中断和输入变化不能重复副作用或用旧结果覆盖新输入。

## expanded spec

复用现有快照、成对 composition、受控 request overlay、P1 elaborate、scope 扩充/租约、generation、真实 V3 resource 执行与 private delivery，不另建消息队列、契约图或事实数据库。原 source/composed/candidate 分开，policy/readset 内容摘要必须绑定 operation。读集合完整保留契约及 source/code/related/AC 测试全文，2MiB 预算失败不截断。host private、越界路径、目录未授权字节拒绝。

operation 独立本机 kernel mutex 防双 coordinator；紧凑 stage checkpoint 只保存 refs、独立结果及诊断，不复制整张契约图。当前 attempt 在独占证明下重入稳定 requestKey，派发前原子计费、持久资源意图，完整真实结果/hash/独立身份保存后重放。lease heartbeat 贯穿原生长调用，控制/总deadline触发 Abort；旧 generation 只能结算真实资源证据。历史未removed资源精确恢复，未知终态保留 recovery_required，不假释放容量。

P1 已审结构结果登记所有未来业务 ID，包括 GAP/partial FLOW；ready/blocked 分区只隔离业务 ID，共享 paths 留 ready。无可执行 ready AC 不生成或写半成品；V1 仅容许已审 GAP 精确解释的缺口。generation 硬门禁保护 raw/全局REQ/AC/VERIFY、实际diff与独立oracle，V2使用不同会话；V3仅执行 ready AC 和 mandatoryTests 的固定命令/镜像；V4复采完整source、当前可信plan/readset与物理身份，一致才可交付，并于 beginApply 前再核。完整V1–V4 pass才 recordVerification(pass)，范围精确ready声明/完整FLOW，不包含blocked。

失败通过新attempt有限修复，冻结预算、deadline及政策不重置，诊断不能升格为事实；环境unsupported、真正业务 GAP/conflict、未知资源恢复停止自动重跑。候选冻结后不覆盖；applying/receipt恢复优先既定交付，真实Git commit及DB未结算不会再生成或重复提交。仅receipt结算可推进成对baseline和deliveredScope，根有blockedReason保持needs_input/conflicted。

P1 续修种子仅取完整结算的具体业务拒绝轮（repair_budget_exhausted）。模型容量或原生执行等基础设施失败不构成业务拒绝，即使保留了合法候选、语义审查 warning 或 deferredImplementation 缺测试 error；连续执行及 checkpoint 恢复均清空旧 seed，在原预算/deadline/冻结输入内用新 attempt 重新生成及独立审查，不批准未审候选或沿用旧 review。此前真正业务拒绝的 seed 继续沿既有严格校验修复；无具体业务拒绝的种子仍被拒绝，取消及总预算耗尽不新增派发。

freezeSyncPlanEvidence复用同一canonical JSON排序，使planBlob.sha256严格等于policyDigest；接入直接保存plan引用，queued恢复不依赖另一个索引文件。派生authorProjection仅规范化已核canonical managed文本，真实snapshot不变；受控Spec输入与代码行为分析共用冻结计划和交付链。阶段result及嵌套refs直接checkpoint保活，不能只pin wrapper。

同operation/input/policy首个P1结构及独立评审通过的细化结果永久冻结为生成义务；code/V3修复的新attempt与进程重启复用原精确结果，并checkpoint原attempt/result evidence provenance，不能再派发P1或更改其稳定AC/ID/政策。仅P1本身未通过时可再细化；通过后清空失败seed，未通过旧seed不能复活。

initial与spec共享P2入口。旧无planBlob operation先claim持久unsupported，不借当前plan猜恢复。终态/controlled操作只精确消费自己的stopped FIFO头；有效queued头由应用FIFO调度，中央重入不把顺序冲突误报成永久unsupported，也不跳过有效pending。

受控Spec requestBlob必须绑定真实input/path；业务decision必须携带绑定原分析、具体finding与所选规则的裁决输入。仅来源标记不构成修改原意的授权；code/combined/reconcile通过下述行为分析和独立审查决定后续义务。

交付准备后beforeApply再核V4；input/policy/readset变化先以当前fence登记精确conflict，再抛原错误供private-delivery保留，不能变成笼统environment。deadline真实耗尽保存budget_exhausted；controlled/过期旧fence不能借guard重新取得写权。

运行及恢复只查询operation所属repositoryId的真实FIFO地址；不扫描global head后按仓库过滤，也不跨仓库运行另一项目的原生后端。

默认租约120秒，heartbeat最多5秒且小于lease，总deadline与预算不因租约调整改变。持权细化/生成阶段边界先renewLease门禁再setImmediate给控制/heartbeat一次执行机会，再核控制和fence；长native调用由heartbeat续约/Abort，已过期authority绝不能恢复。该窗口覆盖实际同步Git/Tree-sitter可信读取阶段。

显式retryOf沿真实operation链读取同source/input/policy/request的持久accepted P1证据；保留原approved contract/AC及原attempt/evidence provenance，不重新细化弱化AC。只有链上从未approved时才P1新派发；新operation重新执行generation/V1-V4，不借旧fence或receipt发布。

recoveryOnly在独占mutex后先于普通phase/claim运行：精确终止所有历史未removed资源，再仅恢复当前attempt已存在且绑定delivery的未settled journal。Docker恢复driver拒绝create/start，planned容器不存在保留未知恢复状态，不新建容器补齐。原生资源只以aborted既有请求桥取真实stop证据；无journal即使verified也不进入prepare/apply。错误返回recovery_required及诊断而不自动pause/run、扣budget或新建attempt；已有journal结算可登记真实receipt/原结论。

code/combined/reconcile及已共同验证基线上的外部代码差量、真实作者raw/规则差量、文本重叠进入 [[sync-code-behavior]] analyzing独审；不再以来源标记或Git重叠直接unsupported/conflict。分析完整binding核对后存同attempt checkpoint，派生facts/AC授权/nodeChanges作为执行上下文，不修改冻结plan/policyDigest。真正conflict/GAP仅经既有dependencyClosure阻依赖，完整FLOW受阻但独立ready分支仍生成与四层验证，receipt覆盖不含blocked。

节点移动以旧from正文为细化输入、新to为候选位置，完整规范node universe保持mintIds语义及业务ID连续。明确退役保旧新范围与负向测试义务；没有active AC时只有具体已授权退役AC仍执行固定命令及旧test ID才可推进，不靠空验收通过。retiredIds/decisionRefs仅真实receipt结算累计。

三种裁决作为新immutable operation进入分析，保旧分析/ref/具体finding历史，绑定新input/policy/readset独审。只有adopt_behavior保所选外部行为，keep_intent及new_rule按对应明确意图修实现；未选分歧不被顺便采用。分析、裁决与细化证据都进入contextDigest，V4仍核原source和当前可信政策。

已接受契约为普通生成修复的冻结义务。独立code review明确contract:path#id普通遗漏时，保留失败candidate及已接受完整正文的refinement checkpoint，在同预算的新attempt回P1；诊断不是fact/批准。再次细化只补已确定原意下的新必要边界，既有REQ/AC/VERIFY及全部业务义务不被弱化；真正重大未知仍GAP。node生命周期与此路径独立结算，不能用修复扩大迁移授权。

行为独审完整findings决定阻断；用户选中过的历史ID不能清除新审查同ID发现。作者基准识别实际Git采纳的前次交付，明确raw/TR变更进入独立分析，交付回声不授权新业务。移动及公开删除沿旧目标/旧raw与新路径执行，生成读取旧verifiedDelivery全部AC作为退役历史，最后节点退役仍用旧固定命令及负向测试完成V1–V4。

已完整独审的rawIntegrations.expectedRaw优先进入派生P1 intent/targets，真实source/composed manifest仍作diff/readSet基准，不修改冻结plan/policy。原immutable作者patch在decision分析中按原ref重读，不能丢或冒作模型事实。真实作者新raw/明确规则驱动对应实现修复；旧代码行为不因曾符合旧原意就覆盖新用户意图，其余合法外部行为保持。

已批准 adopt_behavior/new_rule 与不可改外部 oracle 真实互斥时，独立 code_review 的 oracle-policy:decision:<stableDecisionId> missing_fact 复用现有 needs_input 停止路径。程序核当前 immutable requestRef、实际 mandatory testPath/testId/verification 定义、现有 decisionAuthorizationErrors 的所选范围，且旧/新适用 RULE/TR 确已改义。错误裁决、非登记测试、未选规则、未变规则或 keep_intent 均为 review_invalid，不能泛从 V3 nonzero 推断政策冲突。有效失败 code 为 oracle_policy_conflict，保存旧 oracle 内容摘要、精确测试/定义、裁决与规则、证据/反例，要求可信 owner 发布相容版本；旧 oracle 未通过，固定 whole command、全部守卫和原总预算仍有效。managed AC/test 演化继续原精确授权机制；不自动修改外部测试、不再造 checkpoint 或模型阶段。
