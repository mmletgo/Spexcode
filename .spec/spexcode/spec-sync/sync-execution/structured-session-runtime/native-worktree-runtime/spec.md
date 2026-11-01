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

Native spawn 前保存同 UID 的 PID/start/PPID 基线，只读取进程元数据。receipt 的原生进程组及实际观察到的历史 owned 后代仍须按精确身份停止。新生 PPID1 或失去父链不等于任务归属；只有唯一 worktree/runtime/私有 tmp 的 cwd 等正向任务域证据才登记关联孤儿。关联证据按 PID/start 粘性保存，后续 chdir 不撤销，直到该精确身份消失；cwd 关联本身不授予 kill 权。无正向关联的同 UID 进程仅作 unattributed 诊断，不占任务容量，不按系统服务名设白名单。此边界不声称证明首次观察前已 chdir 脱域的任意系统进程都与任务无关；普通自由读取、编辑与检查能力保持。

停止重验追加带时间和 boundaryVersion2 的观察，保留旧 unknown 快照及 exit.stopped:false 原件。历史元数据的正式取消/恢复使用相同正向任务域边界取得新停止结算，沿原状态机 terminal→removed；不重写原失败、不补 completed，也不把旧成功输出当作业务通过。
