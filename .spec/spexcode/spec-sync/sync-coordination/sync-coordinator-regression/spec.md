---
title: P2 中央编排集成证据
status: active
hue: 175
desc: 真实 SQLite/Git 和隔离 Docker 检查编排与恢复门禁。
code:
  - spec-cli/src/sync/coordinator.test.ts
---
# P2 中央编排集成证据

## raw source

中央应用编排必须由实际输入、候选、验收和交付事实证明，不能把模型 stub 的通过声明当最终产品证据。

## expanded spec

P4 精确 queued 场景必须先消费真实 FIFO 并确认；未确认零模型调用。首轮已审 P1 追加未来 null ID 后，重新绑定实际选择/readSet，经过真实 Docker、四层证据、可信 Git hooks 与 receipt；journal 绑定最终 selection，外部 oracle 不进入本轮写入，原 source/index 保持。原生生成与独审可由确定性 runner 控制，此场景不冒充真实模型执行。

P4 精确接入测试使用真实 Git 快照和 SQLite 基线读取：完整读取选择可含只读 oracle，实际写入范围只含目标文件；同一 InputSnapshot 直接进入 admission，不重新捕获或修改作者 index/字节。缺少实际执行范围时拒绝把目录授权自动当成写锁。

当前版本测试用真实无关文件提交改变全局快照 ID，证明精确操作仍有效且查询不写 index；同一 working tree 的相关 staged 对象变化仍使其过期。历史 P3 完整快照判据保持，不能由新 helper 授予旧操作更宽写权。

针对性测试使用真实 SQLite 与临时Git，可明确注入模型行但V1/意图/diff/独立身份程序门禁保留。真实Docker完整成功、真实断言失败及有限修复；保护AC与命令、GAP独立分支、输入中途变化无交付、取消/重入不重复native或commit，以及source/index原样保留。完成状态重入读取真实receipt。预算和未知资源终态不能假通过。命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/coordinator.test.ts`；Docker cases由 `SPEX_DOCKER_VERIFICATION_TEST=1` 启用。

当前独立证据：真实Linux/arm64 Node固定镜像的完整成功链（真实CLI init与正常hooks、source/index保留、receipt重入）、断言失败新attempt修复、V4中途输入变化、Git commit后DB未结算恢复、GAP独立完整FLOW部分receipt均通过。明确注入模型业务行，V1使用实际Tree-sitter/图/意图门禁，V2程序检查独立session/thread/result摘要，V3与Git均实际执行；不声称已跑真实LLM或P3–P5。未知历史native创建终态保留resource与recovery_required，不假removed。

V3失败后修复的模型若再次收到P1会返回弱化AC，因此测试必须证明不会再次派发P1、后续生成prompt使用精确相同accepted契约/AC内容摘要，callsUsed仅计两次代码调用不重置。数据库重启后失败attempt同样从原P1 evidence复用，不依赖内存状态。

P3 容量失败回归使用真实 SQLite/Git 及明确 native 接缝：已通过行为独审，P1 合法候选仅有 warning/deferredImplementation 缺测试时，独审基础设施失败不能成为业务 seed。live 与 SQLite 重启均在同预算和冻结 inputDigest 内重新生成及独审；此前具体业务拒绝先经 seed 续修，随后容量失败必须清 seed，不借旧 review。取消/总调用预算耗尽及终态重入不增加 calls，source/index/快照身份不变；用例在独立 code review 停止，不冒称 Docker 或交付成功。

高层raw输入没有REQ/FLOW/AC，初始scope只含目录前缀；通过真实细化登记未来业务ID、生成此前absent的新源码模块及可信原意已登记的新治理节点，再经真实Docker/normal Git hooks交付。任意reader-app根通过真实CLI init，作者managed投影不入候选，source/index保持；用户入口无需填写未来实现文件或AC。

第一次V4后、Git准备前人类再次编辑source，beforeApply复采仍拒绝且持久conflicted/input_changed，无业务journal/commit；不被private catch降成environment或FENCE_EXPIRED。

AC-SYNC-02/03使用真实已有详细契约，分别经readonly prepareSpecBodyEdit+requestBlob修改高层raw和具体TR，source/index全程不写。独立模型会话返回固定业务表并检查新意图和旧验收对照；真实V1保护accepted新契约，V3 Docker运行新/旧实际断言，固定CLI hooks/Git交付，receipt覆盖新验收。未受影响作者prose与原ID行保留，旧oracle文件不可改，不把成功从空Spec用例当修改既有契约证据。

真实受控编辑首次30秒租约在连续同步Git/结构微任务阶段过期并返回recovery_required；默认120秒及持权阶段让步后，用未显式指定lease的同一AC02/03场景验证完整Docker/Git交付。已有1500ms短lease/50ms heartbeat取消用例保持，默认调整不放宽过期fence或总deadline。

受控model夹具按原生strict wire返回每个changes行mode:null（沿用或默认100644），包含新文件和既有文件，不以省略optional域掩盖原生服务schema拒绝；业务断言与预算不变。

显式retryOf在真实SQLite重启后复用高层无未来ID输入已通过真实P1程序/独立identity审查的证据；再次P1会返回弱化AC的runner不得收到P1请求，新代码prompt义务摘要相同，新预算只计新dispatch，未输出候选时不伪造V3/交付。另用真实Docker/Git完成后prepare最新baseline、新ingress/allocation/预算证明仍归并原operation，alias沿原完整payload重放。

recoveryOnly真实SQLite证明queued无attempt与paused已计划未原生派发的资源均不新call/attempt/apply；paused/cancel未知创建窗口保持resource未removed与原control/input/budget。真实Docker planned create回执丢失后只inspect/stop/rm既有容器、不create/start；planned目标实际不存在时保持recovery_required，不虚构removed。真实已commit未settle journal恢复只同receipt结算，不新native或commit。

旧 planless 恢复夹具使用明确独立旧政策身份，避免普通相同输入去重命中已取消现代 operation；仍核 plan_missing 持久失败且零 native 派发。

P3真实code来源沿analyzing独立会话、同attempt checkpoint与冻结policy进入P1/生成；refactor保持正文，未完整checkedPaths的独审不得晋级。接缝在生成独审明确终止，不冒称V3或receipt。短租约长调用的真实heartbeat/cancel及重入不重派继续保持。

原raw及TR明确作者编辑场景复用新行为分析/独审并保持真实Docker、原oracle、源码/index和未影响作者内容的完整断言。新裁决独审仍发现同历史ID互斥时不得生成或写journal。

公开buildSyncApplicationPlan无手工退役授权完成新叶→实际receipt→git ff→治理目录搬迁→新叶ID公共入口→实际Docker/receipt→git ff→删能力/治理叶→逐项退役→旧保护oracle及真实负向AC Docker→新receipt/退役累计。未暂存搬迁保稳定业务ID，旧位置删除与新位置创建均进入可信范围；产品交付及重入保source/index、不新增call/commit。receipt后fixture作者显式接受交付，先将未跟踪草稿移到外部保留目录并核对原字节，再以普通ff接受候选，不把该作者动作冒称自动写源。部分正文A实际Docker交付后，B原immutable作者patch同行真重叠；受审整合的精确raw进入P1及实际候选，独审接受后经真实Docker、普通hooks结算receipt。receipt实际tree与deliverySnapshot保A/B及全部原业务义务，source/index保留，重入不新增call/commit。

P3 oracle 绑定负例从真实 Git/SQLite 受控 decision 进入生成独审，错误当前 decision、非 mandatory test、未选 RULE、规则未改或 keep 选择都必须 review_invalid；原版同输入/finding 泛 missing_input 的 fail→pass 成对保存。原 source/index/预算/输入身份与零 receipt 保持。

P3生成诊断在真实SQLite/Git复现普通contract引用错误回P1和symbol修复丢完整finding；live及重开SQLite后均只一次P1、下一代码生成逐字收到全部finding（含重复完成先突变的反例），完整已批准正文/预算/deadline/source/index保持。专用contract-omission绑定真实path/existingID/affectedIds仍回原refinement，代码独审在V3前明确停止，不冒称运行或交付通过；终态重入不增call。

旧refinement stage与已保存repair-input分别经SQLite重启证明合法旧marker不再派P1，仍从实际generation独审恢复全部具体findings；新marker错existingID及损坏JSON保留失败、零新call/receipt。首轮规范P1 implementation-review通过原P1独审defer后，实际code_generate收到完整ContractFinding（证据/修复决定/relatedIds）及previousOutput:null，完整批准义务不改。

旧规则引用RULE位置而affectedIds仅有关联AC的真实历史形态单独回归：先复现误套新omission includes(ID)造成unsupported，再验证只撤细化权、完整独审发现不丢且不再派P1。

合法增补链用真实Git/SQLite及独立native接缝验证：首P1批准后专用遗漏触发第二P1实际新增FLOW/STEP/TR/AC并连入原主流程，经结构和独审批准后再遇普通测试repair；第三次实际code_generate仍收到新增全文、原raw/REQ/RULE/AC/VERIFY义务及第二批准attempt的provenance。live、SQLite重启及同绑定显式retryOf均不再派P1。旧contract:权限证据和未审增补候选不得升级冻结正文；原source/index/预算/deadline、固定验证定义及零receipt断言保持。该接缝在code_review终止，不冒称Docker或交付通过。


已解决诊断GAP定向回归使用真实SQLite、不可变Git裁决、真实dispatch记录和normal hooks私有Git交付，验证部分baseline含旧诊断→keep精确清理→verification/receipt/baseline累计retiredIds→重开SQLite后禁止复用；P1独审拒绝保持无新receipt和无退役记录。V3 adapter与测试report明确模拟，只证明协调/持久化边界，不作为Docker执行或实际产品运行通过的证据；当前产品Docker验收仍另行完成。


真实Git/SQLite及明确native接缝复现reviewPassed conflict→重复AC非法P1→执行failed/预算耗尽、资源清零，却丢blockedReason的失败。修复后保原failure/预算/source/index，正式application.decide精确绑定当前analysis/finding并建立新不可变操作；unreviewed/无conflict不记原因，foreign/stale/finding及活动P1仍拒。无Docker/native实际执行或receipt成功声明。


应用detail的decisionEligibility投影在活动P1为false、结清的已审冲突failed/budget为true、无合格业务原因的失败为false；它直接复用实际store判断，无额外模型调用。
