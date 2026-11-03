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

P0分析及独审同样复用此草稿捕获/读取能力；owner与purpose共同隔离临时路径，两个阶段只可提交各自精确draft，schema/Spec/源码/tests及其absence继续保持。P0独审seed可以含自身未批准JSON临时稿，但分析稿不混入独审业务tree；最终candidate与交付不含任何临时草稿。认证的旧Native final只作为新seed输入材料，不是旧Git witness，必须经下一真实Agent提交后才产生当前草稿身份。

P1草稿复用同一stageWorktree/verifyStageResult和原生v6 edit执行，不增加执行器。生成只能正常提交指定的`.spex-sync-drafts/<ownerDigest>.json` UTF-8普通文件，精确业务schema作为同seed只读sidecar供Agent读取与自检，仍只有主draft可写；真实seed→result diff若包含schema、Spec、源码、测试、其他owner或symlink即拒绝；只有summary且未形成真实提交也拒绝。程序从提交的精确path/OID读取字节，在JSON解析前以`refs/spex-sync/drafts/<ownerDigest>/<resultCommit>`保活，syntax-invalid同样保留。冷恢复重核seed commit/tree、真实result commit/tree、owner/schema/path/OID/ref及写范围。当前source与已审祖先始终重新建立seed，只overlay旧owner草稿字节，不继承旧工作树；临时文件不进入独审seed、业务candidate或交付。

每次派发以明确的不可变tree生成私有seed commit，parent为原冻结HEAD；私有保活ref保留seed及历史角色，不改变来源HEAD、index或工作文件。P0使用真实composed；P1使用该输入与已审祖先/待审Spec overlay；P2构建使用已审Spec overlay，独审使用真实完整candidate。seed/tree、任务prompt/schema均绑定固定请求和缓存身份，不使用live WIP或猜测阶段tree。

工作树允许自由读取完整仓库，readPaths/files只表示任务上下文及程序校验数据。只读阶段终态HEAD和tree必须等于seed；编辑阶段必须有真实clean提交且HEAD为seed后代。公开结果必须精确绑定baseCommit/baseTree，实际headCommit的tree必须等于结果tree；不接受旧frozen读取证明充当此证据。

P2只把实际seed→HEAD对象差量投影为原CandidateChanges，beforeDigest/mode来自原composed对象，内容与新mode来自真实结果对象；不相信summary中的补丁。原scope、不可改oracle、host-private、UTF8、普通文件及原CAS保护继续执行；已审Spec同时进入最终唯一candidate。私有seed不是交付提交，之后仍须分区/跨边独审、V1–V4、真实Docker、receipt和正式采纳。
