---
title: 私有交付工作树与提交结算
status: active
hue: 175
desc: 从持久交付计划创建私有工作树，经真实独占、严格hooks、journal和receipt交付完整候选。
code:
  - spec-cli/src/sync/private-delivery.ts
---
# 私有交付工作树与提交结算

## raw source

验证通过的 Spec、代码和测试必须实际落盘为完整受管交付版本。原工作树与 index 保留；文件写入或 Git 提交中断后核实真实结果，不重复提交、不把半成品公开为已同步。

## expanded spec

planPrivateDelivery 从受管根、实际 source 身份和稳定 ingressKey 得到 source 外的固定 parent/worktree 与 refs/heads/codex 分支。deliverVerifiedAttempt 只消费 [[sync-store]] 中的已验证或已进入 applying 的同一 attempt；不生成模型结果、不补造验证通过。固定发布 runtime 由调用者提供，按 [[sync-trusted-hooks]] 在准备和提交前精确核验。

受管根在 source 外、非 symlink 且仅为当前用户所有。[[sync-file-mutex]] 在根下独立锁目录持有实际跨进程锁；parent ownership 在第一次 Git/文件副作用前 durable 保存 operation、attempt、input、交付计划、父目录及 sibling staging 物理身份。恢复只能使用同一记录和身份，未知目录内容或第三方变更拒绝。Agent 只有结构化只读执行权，尚未结算的树不向普通编辑、session close 或归档入口公开。所有者文件不是第二份可编辑业务事实。

父目录同时持有 sibling footprint 私有指令投影目录，其物理身份写入 version 2 ownership 并逐次复核；privateFootprintDir 从所有权记录得到，不能由候选选择。严格 materialize 的产物通过此入口与冻结业务工作树分离，具体绑定由 [[sync-trusted-hooks]] 验证。

创建 fresh worktree 使用 prepare 模式的真实 Git/hooks；失败后检查实际 registered worktree/ref，不以退出码推测无副作用。关联物理 delivery 后，由 [[sync-private-file-apply]] 的真实 journal 逐文件写入，staging 在树外且同 filesystem。暂停或取消前未进入 applying 时不写业务文件；applying 中结算既定完整单元后再停。

完整文件通过复核后，先持久 commit intent（journal/effectKey、固定 tree/parent/ref、消息及工具绑定），再以 read-tree 精确建立私有 index，不执行 git add 或候选过滤脚本。普通 git commit 仍执行严格 canonical hooks。提交返回任何退出码都核真实 raw commit/tree/单parent/分支和 effectKey；满足 intent 的已提交结果补 receipt，不盲重提、不回滚共享历史。无提交且失败保留恢复证据；实际 index/worktree/HEAD 不属于计划的前后状态则拒绝覆盖。

receipt 使用真实最终 InputSnapshot，要求 tree/manifest 完全等于冻结候选且 index tree 等于 commit tree；所有文件步骤已完成后才能 recordReceipt/settleApply。已结算的重入只核对并返回原结果。结算前 owner 保持私有；结算后标记 published 并返回实际交付身份、commit 与 receipt，主分支合并由上层另行治理。此节点不宣称原 source 或主分支已经同步，不自动删除未知残片或用户产物。

候选 tree 与既有 parent tree 完全相同则登记明确 unchanged intent，复用实际 parent commit，不制造空提交；验证与receipt仍不可省略。publish 的 prepared 已成功后 Git 后续 AUTO_MERGE 清理可返回非零，即使退出128也必须先核实际结果；只有 tree、单parent、分支及 effectKey 都匹配才补结算。
