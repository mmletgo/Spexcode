---
title: 私有交付逐文件应用
status: active
hue: 175
desc: 已登记journal在协调器独占私有树内逐文件写入、复核和恢复，不自行公开或结算。
code:
  - spec-cli/src/sync/apply-files.ts
---
# 私有交付逐文件应用

## raw source

只对协调器真实独占、尚未公开的私有交付树执行已登记 journal。保留原来源工作树及 index；崩溃恢复不能重复改已完成文件或覆盖第三方内容。

## expanded spec

本节点实现 [[sync-coordination]] 的私有逐文件应用原语，完整候选遵循 [[sync-frozen-candidate]]。prepareApplyPlan 从 currentTarget 到冻结 candidate 重建完整 bytes/mode 差量，绑定 operation、attempt、原 source/input、验证证据、目标快照和成对基线；稳定 payload 不含采集时间。超出真实验证 coveredScope 的差量明确拒绝，不通过扩大范围补齐门禁。

applyJournalFiles 要求调用者以实际所有权记录及执行隔离断言独占且未公开，每个短单元复核此断言与 registered worktree 真实物理身份；硬拒 source 与 delivery 为同一物理路径。协作原树回写需要后续独立写入入口，本边界不删减上层完整产品需求，也不以哈希比较伪称普通外部树的绝对 CAS。写前经 store finishing fence 检查 generation/租约与已登记步骤；只修改 plan.files 的业务路径。

先核对全部当前 preimage/postimage/mode，再执行先删除后创建/替换。preimage 经同目录临时文件、fsync、原子 rename 或 unlink 形成 postimage，写后复核真实字节/mode才记录 completed。已有 postimage 仅补 checkpoint，不重新写；已 completed 路径必须仍是 postimage。第三方值不覆盖，持久失败证据并进入 recovery_required。目录互换只删除已计划文件，禁止递归删除未知内容，空目录用 rmdir；父 symlink 始终不跟随。未变 symlink 保留。新增/修改链接仅当 candidate 条目与 composed 条目完全相同且实际模型 diff 未改该链接时允许；模型新增/修改链接拒绝。链接目标按候选 manifest 解析完整相对链接链，外部目标、未知目标、.git 元数据和循环拒绝；临时 symlink 经原子 rename、目录 fsync 落地，写后核 linktext/mode，最终真实解析必须落在交付树内且等于 manifest 解析目标。第三方链接不覆盖，postimage 恢复不重复创建。

applying 期间的取消继续完成既定短单元，不能开始新阶段。返回真实完整目标 InputSnapshot 与应用证据；完整 tree 必须等于候选，原 target HEAD/index 保留。根协调器另负责可信 Git 提交、ref 发布、receipt 与结算；此节点不标记 synced，不自行提交、合并或公开，不沿用元数据禁 hooks 规则绕过交付门禁。
