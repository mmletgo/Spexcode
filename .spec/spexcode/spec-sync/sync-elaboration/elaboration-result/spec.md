---
title: 细化输入快照与可追溯结果
status: pending
desc: 细化候选、缺口、阶段证据和明确失败类型；结果不代替实际运行与落盘。
code:
  - spec-cli/src/sync/elaboration-types.ts
---
# 细化输入快照与可追溯结果

## raw source

未知业务政策只阻塞依赖分支；失败、预算耗尽和待输入结果应保留可检查产物，不能显示已同步。

## expanded spec

输入快照拥有用户原意节点和原文、允许变更的节点与路径、源正文及摘要、既有只读契约、有来源的事实和可选实际代码/测试字节。新增子节点原意或上层引用正文必须由冻结输入提供；模型不能自行扩大写范围。新增治理锚点必须指向冻结上下文的真实代码文件，不能借未提供文件上下文伪装已实现。`authorizedChanges` 是调用者已确认原意或裁决产生的具体退役/验证政策变更，不接受模型自产批准；历史 `retiredIds` 由协调器登记，新候选不得复用。完整高层导出真实首轮生成约 600 秒，默认单次窗口为 900 秒（15 分钟），`timeoutMs` 可明确覆盖；该时限不是运行成功证明。每次请求携带稳定请求键及独立输入摘要；修复轮数、调用次数 `maxCalls` 和总时间 `totalTimeoutMs` 有明确可配置上限。原生每次调用超时使用固定归一化单次配置，不把浮动剩余时间放入创建身份；总时间由独立 AbortSignal 截止，同一冻结输入/阶段重试仍可幂等回放。预算耗尽在原生停止已证实后为 exhausted，区别于用户 cancelled；停止未证实保留 cancellation_pending 和精确身份、结果 failed，保留产物并停止派发，供 P2 统一操作预算覆盖。

结果返回候选正文及内容摘要、解析图与覆盖投影、具体 GAP、受阻依赖 ID 和无直接 GAP 阻塞的声明项 `readyIds`、实际退役 ID、结构与独立审查结论。`readyIds` 不代表整条所属流程可交付。`readyFlowIds` 仅包含 FLOW 自身及全部声明 steps 均无 GAP 阻塞的流程；`blockedFlows` 返回 flowId、blockedStepIds 和 gapIds。聚合只向父流程形成结果，不回传父阻塞到无关子项，因此未知完成/取消权限不阻断创建/查看。可推进/退役结论仅在当前结构和独立审查通过后输出。每轮保留生成输出、审查输出、失败发现和 session/thread/turn/result 摘要，不能只保留最后“成功”声明。调用期间外部继续编辑不改变冻结输入。

内部协调器可为新的请求键提供已结算拒绝候选 `seed`，只包含原冻结输入摘要、原候选/摘要、生成输出、具体失败、评审和原追踪。程序核对相同业务输入、原候选自摘要、生成输出与原 trace.resultDigest、评审 inputDigest/candidateDigest 及去除程序身份后的原生输出摘要，并用当前 schema 校验、重新渲染；续修提示同时提供原失败及当前程序结构诊断，后者不改写原发现或追踪。它仍是不可信诊断候选，不能改写 raw/facts/source 或充当权威规则。只支持已有具体失败，不恢复运行中 native 或迁移持久 store。新预算由调用者显式决定；新 rounds 只记录新执行，prior 保留原请求键/摘要/追踪及重新渲染摘要。新独立审查必须重查当前完整 Markdown，并独立于新构建及所有种子会话；即使渲染版本改变也不得借用旧审查。

细化状态遵循上层 [[sync-elaboration]]；实现缺口、实际执行 `not_run` 和 `implementationReady: false` 始终明确。P2 及验证服务必须另外完成代码、测试、当前版本证据和允许范围的实际落盘，才能形成 [[sync-verification]] 定义的同步结论。

调用者可提供可选 `verifications: readonly Pick<Verification,'id'|'command'|'cwd'|'timeoutMs'>[]`，其权威类型来自 spec-core 契约。它是独立可信执行器登记，不混入 ElaborationFact 业务事实，不代表新增业务政策或变更授权；开始前与其他输入一起复制并进入冻结摘要。未提供登记仍保留独立 P1 细化语义，执行未运行、实现不可交付，不能凭模型 VERIFY 获得执行权。

细化输入可携独审行为分析证据、节点迁移及preserve_business/reelaborate模式。update_acceptance必须绑定合法规则ID、analysisRef和具体依据；代码来源仅授权符合明确原意的细节变更，不能删除既有验收或改变验证政策。候选及结果保留nodeChanges供协调器形成同一迁移候选。

refinement可携已接受candidateDigest和生成独审的具体失败诊断，只表示在既定原意下补齐遗漏边界；它不能成为新事实、来源或政策授权。上一完整已接受契约作为输入，REQ/AC/VERIFY和既有义务保留，再经独审后新增普通必要状态/转移及验收。

decisionAuthorities携可信程序派生裁决范围；update_acceptance及具体retire既核独审分析，又核所选规则/业务ID闭包。使用同decision source或改标user:raw均不能授权无关政策。未选冲突仍为独审finding阻断项。

程序由公共节点删除/所选裁决派生的retire可携analysisRef证明逐项已独审授权；旧可信显式raw/plan授权仍沿自身来源门禁。它不授予验证执行政策变更，退休仍保留旧负向运行义务。


retiredIds同时承载逐项合法业务退役与经当前精确裁决确证结清的旧诊断GAP身份。GAP删除仅在本轮P1结构与独审通过后输出；独审拒绝、旧/foreign裁决、共享选外或未解决诊断不记入此集合。协调验证与baseline复用该既有字段累计，后续候选禁止复用。诊断结清不改变用户原意或增加业务退役计划。
