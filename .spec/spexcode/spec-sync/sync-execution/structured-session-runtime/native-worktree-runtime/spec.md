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

macOS 在登记新原生 worktree 进程的启动请求之前解析该工作树实际 Git common directory。版本探测及执行子进程共用同一保护，仅禁止子进程及后代写入共享 config 及其锁文件。读文件、原生认证与模型配置、每个工作树的 index、Git 对象、引用与不写共享配置的带钩子提交保持原能力；共享配置如需更新，由宿主在该执行边界之外处理。其他平台沿原启动和严格结果校验；此启动边界不改签已有原生请求、结果或停止证明。

Native spawn 前保存同 UID 的 PID/start/PPID 基线，只读取进程元数据。receipt 的原生进程组及实际观察到的历史 owned 后代仍须按精确身份停止。新生 PPID1 或失去父链不等于任务归属；只有唯一 worktree/runtime/私有 tmp 的 cwd 等正向任务域证据才登记关联孤儿。关联证据按 PID/start 粘性保存，后续 chdir 不撤销，直到该精确身份消失；cwd 关联本身不授予 kill 权。无正向关联的同 UID 进程仅作 unattributed 诊断，不占任务容量，不按系统服务名设白名单。此边界不声称证明首次观察前已 chdir 脱域的任意系统进程都与任务无关；普通自由读取、编辑与检查能力保持。

Linux 新基线明确登记 `linux-proc-start-ticks-v1`。候选进程以同一 `/proc` 进程目录核对 UID、PPID 和启动 ticks，owned 身份、detached receipt 和停止核验使用同一启动标识。新登记进程根必须匹配原 detached receipt，历史 owned 父身份匹配时才继续登记其后代。历史 Linux `ps lstart` 基线及其记录保留原件，尚未确证的停止保持待结算。macOS 继续读取和写入原有基线格式。

macOS按PID查询cwd时使用lsof -b，避开此查询不需要的stat/lstat/readlink；cwd仍取原libproc结果，候选UID与停止身份门保持，其他潜在阻塞继续受原期限和pending规则约束。

进程列表与macOS cwd探针异步运行，单个探针固定10秒期限及1MiB合计输出上限，不能阻塞心跳、异步Git回调、创建期限或取消timer。一次公共观察默认也共享同一个10秒绝对截止，内部ps/cwd不各自重置。正式stop继续传递原控制窗口的绝对截止，排队等待也受该截止约束，探针取10秒与真实remaining的较小值；过期队列轮到后不再派发，等待后、Native信号与最终停止观察发布前重核，不迟到写stopped:true。stop只更新原owned采样，再在身份核验/信号后做一次新鲜cwd分类，不用旧pending代替停止证明。既有Native控制timer、租约和模型预算不变。探针使用本次创建的独立进程组；超时或输出溢出先返回cancellation_pending，仅向该自有探针组发一次SIGKILL，不等待close，不能据此签发Native停止收据。父close不代表内部helper消失；沿既有只读进程组absence判据，未证gone持续保在途债务且不再spawn，后续只读核实整组gone后才可重新观察，不补发信号。各root的采样、分类与停止串行，未完成观察和迟到回复不能覆盖粘性任务关联；失败不返回空集或释放Native容量。该探针组所有权不来自cwd，不扩Native杀权、持久字段或版本。

运行中的周期采样恢复沿用同一 10 秒观察上限及探针组债务规则，首次 pending 后的复验共用固定绝对截止。原终态或正式取消开始后停止领取周期采样，迟到观察不能决定原轮结果。[[claude-structured-runtime]] [[cursor-structured-runtime]] [[grok-structured-runtime]]

一次周期采样共用同一份新鲜进程列表登记 owned 并查找关联孤儿。原生适配器在已认证成功终态后等待原 CLI 自然退出时，可以在原有串行观察和期限内更新 owned 列表。适配器声明自然关闭等待时间时，继续登记可见后代，等待期结束后才向新鲜进程列表中启动身份仍匹配的已登记后代发送终止信号。同一退出窗口内已经成功发信的精确身份无需再次发信。原 CLI 与仅按 cwd 关联的进程不在此权限中。停止时，历史 PID 只有直接核对仍可能存活才查询启动身份；发送信号前仍须匹配原身份，随后另取新鲜列表复查任务关联。

Cursor 与 Grok 在终止窗口内遇到暂态观察 pending 时，在原绝对截止内复验同一 receipt 和当前进程。每次复验仍遵守探针组债务及原终止权限。期限耗尽、receipt 不匹配或新鲜停止证明缺失时，停止保持未知。

停止重验追加带时间和 boundaryVersion2 的观察，保留旧 unknown 快照及 exit.stopped:false 原件。历史元数据的正式取消/恢复使用相同正向任务域边界取得新停止结算，沿原状态机 terminal→removed；不重写原失败、不补 completed，也不把旧成功输出当作业务通过。

只有原生身份、真实停止、成功输出与 schema 均已通过后的 Git 结果后置合约失败取得 native_worktree_result_invalid；诊断保留 mode、expected seed/tree、actual HEAD/tree/root 与完整 porcelain status。read 改 HEAD/index、edit 未正常提交或非后代仍严格拒绝，不修改 Git 状态、不采纳输出、不清理失败工作树。初始 seed 身份错误与历史结果缓存损坏不取得此分类。只读失败反馈说明本阶段只交可审分析，不生成或提交试验 Spec；实验必须使用独立临时 Git 元数据，不保留指回原工作树的 .git，可交候选由后续独审逐轮修复。
