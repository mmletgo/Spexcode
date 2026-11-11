---
title: 同步阶段的真实私有工作树
status: active
desc: 为各阶段固定真实Git输入，并从代理提交的实际对象差量导入候选。
code:
  - spec-cli/src/sync/stage-worktree.ts
related:
  - spec-cli/src/sync/stage-worktree.test.ts
---
## raw source

Spec变更只把任务相关规格与原始需求差量告知代理，代理在新的工作树自由读取仓库并完成授权修改。SpexCode继续负责独立审查、实际范围、验证与正式采纳。

## expanded spec

已结算且clean的Native工作树可以由[[sync-native-run]]正式close；branch/archive与原不可变Git对象保持。captureStageDraft、readStageDraft和importStageChanges不依赖结果物理目录，业务JSON/schema后置拒绝仍保原bytes及未批准身份。尚未capture的已提交失败/取消稿，由调用者在原真实性/停止认证后沿[[archive]]临时还原同一checkout，再执行本模块原严格观察及capture，结束后回收。无新增提交保持空材料，不改旧witness或批准；未提交physical稿为dirty来源，未知停止及dirty仍不自动关闭。

StageDraftMaterialRequest仅在进程内传当前binding/真实seed/inputDigest、可定位的existingDraft与程序可信readonly overlay的精确path/mode/OID投影，供P1按真实Native attempt/round选择严格较新物理材料及跨父/诊断比较。它不进入旧请求或NativePlan，不改变本模块对原停止工作树、index、schema/context及其他文件的完整冷验，也不能赋予旧稿新的Git或批准角色。

已认证原Native身份并正式stop/removed的owner编辑工作树，可由调用者在新有效fence只读观察精确UTF8普通JSON草稿。ZCode物理来源还须原精确turn.failed；原canonical cancelled可与该失败终态并存，普通暂停的turn.completed/turn.cancelled不在本轮physical_draft准入，既有正常Git暂停材料政策保持。仅打开原exit.json时遇到ENOENT，使该物理/Git候选不合格并在读取新进度前跳过；formal stop/removed不能替代缺失的exit或失败终态。缺plan/send、其他读取错误、坏JSON及存在但非法exit仍显式失败。HEAD仍为seed或其后代；Git提交、index及工作区仅此draft允许变化，schema/context/Spec/源码/tests的path-mode-OID与absence全部保持，含隐藏index标记也不豁免。允许untracked、tracked修改及仅draft暂存，并可与草稿命名空间外的普通ignored缓存并存；ignored的`.spex-sync-drafts`本身、子项、大小写别名及其他owner草稿/sidecar仍拒绝。材料始终只取最新工作区原draft bytes并记录原index SHA，ignored缓存不进入材料或候选，syntax/schema坏稿不修正文；完整严格状态仍在返回前逐字复核。只读Git命令禁optional locks，旧HEAD/index/工作文件/Native原件不改写。此来源是physical_draft，不能构造ElaborationDraft或旧Git结果；正常交付仍须真实clean正常提交。

P0分析及独审同样复用此草稿捕获/读取能力；owner与purpose共同隔离临时路径，两个阶段只可提交各自精确draft，schema/Spec/源码/tests及其absence继续保持。P0独审seed可以含自身未批准JSON临时稿，但分析稿不混入独审业务tree；最终candidate与交付不含任何临时草稿。认证的旧Native final只作为新seed输入材料，不是旧Git witness，必须经下一真实Agent提交后才产生当前草稿身份。

精确通过仓库、owner、原seed、schema和提交差量的旧物理草稿，若严格Git状态出现非ignored的授权范围外路径或状态，仍拒绝整份材料，并将此类工作区状态与身份、索引、物理字节和复查竞态失配区分。调用者不能把该拒绝当作空草稿后继续捕获同一来源的Git结果。

正式停止的工作树若严格Git状态只有ignored条目，只在HEAD及tree仍为精确原seed、全部stage-0索引path/mode/OID和受控物理文件逐项相等时判定无新增材料。`.spex-sync-drafts`本身及其所有子项的ignored变化（含大小写别名和其他owner草稿/sidecar）明确拒绝。授权draft在seed中缺席则物理也须缺席，已存在则保持原普通文件模式和字节。禁止穿过父目录软链接，并在返回前复核原索引摘要、HEAD及完整严格状态。其它ignored条目不进入草稿材料或交付；隐藏只读修改、索引变化、实际dirty与已有新提交仍经原严格门。

P0分析与P1完整生成的`ac-test-flow-binding-v2`、`ac-test-flow-review-binding-v3`与`ac-test-flow-review-verify-repair-v4`调用者可在原停止认证后显式观察已提交草稿。真实HEAD须为原seed后代，树差量只包含唯一授权UTF-8普通草稿，工作树须clean或只有下段认证托管投影及草稿命名空间之外的ignored项。完整stage-0索引及全部受控物理文件（含草稿）逐项匹配实际HEAD的path、mode、OID和字节，返回前复读HEAD、索引、状态和所有受控物理路径的模式与字节以拒绝竞态。原停止来源与只读保护规则保持。返回真实commit/tree/OID用于未批准材料，其他调用者及无新增稿继续沿原规则。

上述提交观察用 `ls-files` 枚举未跟踪和 ignored 项，完整验证索引与受控物理文件，无需由 Git 执行内容过滤器。存在字节差异时，只有冻结HEAD属性精确使用 `filter=spexcode` 的 [[content-filter]] 已知路径可用投影证明。验证原 canonical shim、commands、bindings，再按 [[content-filter]] 仅从冻结 seed 重建可信完整托管投影。两次读取的完整物理字节都须匹配该重建结果。改写 host、同时修改物理托管块和旧 payload、任意源码或测试差异均拒绝。

P1草稿复用同一stageWorktree/verifyStageResult和原生v6 edit执行，不增加执行器。生成只能正常提交指定的`.spex-sync-drafts/<ownerDigest>.json` UTF-8普通文件，精确业务schema作为同seed只读sidecar供Agent读取与自检，仍只有主draft可写；真实seed→result diff若包含schema、Spec、源码、测试、其他owner或symlink即拒绝；只有summary且未形成真实提交也拒绝。程序从提交的精确path/OID读取字节，在JSON解析前以`refs/spex-sync/drafts/<ownerDigest>/<resultCommit>`保活，syntax-invalid同样保留。冷恢复重核seed commit/tree、真实result commit/tree、owner/schema/path/OID/ref及写范围。同一次冷验从一份完整核验的seed树确定schema与写范围。当前source与已审祖先始终重新建立seed，只overlay旧owner草稿字节，不继承旧工作树；临时文件不进入独审seed、业务candidate或交付。

P0/P1草稿业务JSON与Native final回执是两份不同内容：业务JSON只写入指定Git草稿文件；Native final只返回符合`DRAFT_RECEIPT_SCHEMA`的单一JSON对象，形如`{"summary":"..."}`，前后不附说明或Markdown代码围栏。

每次派发以明确的不可变tree生成私有seed commit，parent为原冻结HEAD；私有保活ref保留seed及历史角色，不改变来源HEAD、index或工作文件。P0使用真实composed；P1使用该输入与已审祖先/待审Spec overlay；P2构建使用已审Spec overlay，独审使用真实完整candidate。seed/tree、任务prompt/schema均绑定固定请求和缓存身份，不使用live WIP或猜测阶段tree。

工作树允许自由读取完整仓库，readPaths/files只表示任务上下文及程序校验数据。只读阶段终态HEAD和tree必须等于seed；编辑阶段必须有真实clean提交且HEAD为seed后代。公开结果必须精确绑定baseCommit/baseTree，实际headCommit的tree必须等于结果tree；不接受旧frozen读取证明充当此证据。

P2只把实际seed→HEAD对象差量投影为原CandidateChanges，beforeDigest/mode来自原composed对象，内容与新mode来自真实结果对象；不相信summary中的补丁。原scope、不可改oracle、host-private、UTF8、普通文件及原CAS保护继续执行；已审Spec同时进入最终唯一candidate。私有seed不是交付提交，之后仍须分区/跨边独审、V1–V4、真实Docker、receipt和正式采纳。
