---
title: 原生 worktree Git 执行边界
status: active
hue: 175
desc: 固定 seed Git 对象并验证正常工作区的真实提交结果，不接受模型补丁作为执行证据。
code:
  - spec-cli/src/native-worktree-runtime.ts
related:
  - spec-cli/src/native-worktree-runtime.test.ts
  - spec-cli/src/session-structured-policy.ts
  - spec-cli/src/session-structured.ts
---
# 原生 worktree Git 执行边界

[[structured-session-runtime]] 的 native-worktree-v1 请求固定完整 seed commit SHA、其精确 tree 和 read/edit 模式。边界拒绝 ref、错 tree 或其他 mode；初始化不得读取 live HEAD/index/WIP。

执行器使用真实创建记录 worktreePath。完成时 status 必须干净；read 要求 HEAD/tree 均等于 seed，edit 要求 HEAD 是 seed 后代，代理负责正常 add/commit，任何 dirty/提交失败均失败。结果保存 baseCommit/baseTree/headCommit/tree/worktreePath，在冷复用时再次核同一不可变 Git 对象与祖先关系；正式 close 已移除工作区时保留历史 path 而不重建，不信模型文本或旧 frozenReadProof。
