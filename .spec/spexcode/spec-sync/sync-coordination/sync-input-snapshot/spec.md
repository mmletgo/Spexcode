---
title: 不可变外部输入快照
status: active
hue: 175
desc: 区分已提交HEAD输入与显式工作区输入，双重核对身份并保留可恢复Git对象。
code:
  - spec-cli/src/sync/snapshot.ts
---
# 不可变外部输入快照

## raw source

保存、切分支和删除重建不能形成混合输入；用户 staged、unstaged 和 untracked 字节及 index 必须原样保留。

## expanded spec

[[sync-source-registration]] 的显式见证在公共identify/fingerprint接缝投影logical repositoryId及本root已证明的physicalFingerprint；actual路径、Git登记与branch仍真实读取，snapshot/source字段和顺序不增加wrapper。commonDir共享仓库ID，新managed root保真实新physical；未证明linked旧权限不能借repo共享继续。失效v2正常读取fail closed，不fallback新namespace。仅正式continuity配置核验与resource-only清理可用具名raw探针，normal capture/currentness/V4/准入不采用raw旁路。

明确 blob OID 集合的批读接缝先批量查询真实对象类型和大小，再复用读树原有的容量分组、framing、完整字节与 SHA-1/SHA-256 OID 校验。去重只减少同次重复对象读取，不改变调用者的逐路径解析；空集合不启动 Git，单对象沿用原路径。元数据不匹配、缺失和损坏明确失败，每次调用重新读取，不建立跨调用缓存或放宽单对象容量。

已授权的 canonicalRoot/gitDir 可独立重读同一物理 fingerprint，用于在目录删除重建、HEAD 尚不可解析时立即识别旧授权失效；它不读取 Git 业务内容，也不为缺失或未初始化来源生成 InputSnapshot。完整身份与快照继续使用同一 fingerprint 算法。

同一 Git commonDir 实际登记的嵌套 worktree 是独立输入边界。未被外层 index 跟踪的这些目录及子项不进入外层快照，即使用户没有配置 ignore；因此产品自行创建会话工作树不会改变来源输入或使状态读取失败。只按真实 Git 登记判断，不按 `.worktrees` 等目录名猜测；普通未跟踪作者文件仍采集，已有 tracked 字节不能由登记关系隐去，未登记的嵌套仓库仍明确拒绝。

本节点实现 [[sync-coordination]] 的 P2 输入原语。只接受 registered worktree 根目录，canonical commonDir、仓库身份、分支、root/gitDir 的 dev/ino/birthtime 组成物理身份。前后采集 HEAD、index 实际字节、tracked/untracked 文件集合、mode、内容摘要与文件变化时间；有限重试后仍不稳定明确失败。父 symlink 不被当成目录读取；symlink 自身保存链接目标 bytes；真实 Git index gitlink/submodule（即使其工作目录已缺失）及其他非文件条目明确失败。普通 cached 文件被目录替换时跳过旧文件条目，完整采集新 untracked 子文件；旧子路径因目录被普通文件替换而 ENOTDIR 时记录为删除，保留原 index 字节及 mtime。

来源身份只核对自己的 Git 登记：primary 沿用 Git 从 canonical commonDir 去掉 `/.git` 后得到的主工作树路径；linked 的 gitDir 必须是该 commonDir 的 worktrees 直属登记，且自身 gitdir 回链指向 canonicalRoot/.git（支持相对回链）。不为身份检查枚举其他 worktree，因此无关登记事务的半写入元数据不能使已提交来源读取失败。复制 gitfile、丢失自身登记、错误回链或 foreign commonDir 仍拒绝；separate-git-dir 主工作区沿用既有登记路径不匹配时的拒绝，其正规 linked 工作树仍可使用。显式工作区采集仍完整枚举真实嵌套登记，但只在同一物理 commonDir 的既有登记事务锁内读取清单，随即释放；文件扫描、前后观察间回调及模型执行不持有该锁。身份字段、物理 fingerprint 与历史摘要顺序不变。

临时 index 构建 immutable tree 和 index tree，不 stage 用户文件或写用户 index。split index 的 sharedindex 字节复制到 owned 临时目录并参与前后核对，支持 linked worktree 的独立 index，原 index/sharedindex 不变。源码仅存 Git blob；manifest 和摘要证据使用明确 commonDir 的既有 evidence store。稳定 ID 不含采集时间；相同身份和相同字节重复采集得到相同 ID。读回校验 evidence SHA 与真实 Git blob OID。私有 refs/spex-sync/snapshots 和 indices 保活对象。

仅本节点的非交付 Git 元数据原语禁用 fsmonitor/reference hooks，防止读取或私有 pin 间接执行候选代码；不能写用户 branch/HEAD，不 commit/merge。开发提交保持正常 hooks；后续 apply/landing 必须另经可信验证门禁，不能套用此元数据边界绕过提交门禁。

来源元数据读取器也供输入观察器解析当前 symbolic HEAD，沿用相同的 Git 参数、环境清理、输出及超时边界；不另建可执行候选 hooks 的读取通道，也不改变来源身份字段或历史快照摘要算法。

读取 blob 后在本进程按完整 OID 的 SHA-1/SHA-256 格式校验 `blob <原始字节长度>\0` 和全部原始字节，不借助第二次 Git stdin 调用或 UTF-8 转换。写对象、更新临时 index 等需 stdin 的元数据命令仅从 owned 私有普通文件读取（目录私有、文件权限 0600），包括空输入；无输入命令关闭 stdin。成功、失败和超时均关闭 fd 并清理 owned 输入目录。每次外部 Git 命令沿用 `SPEXCODE_GIT_TIMEOUT_MS`（默认 120000ms）上界，超时杀死该命令并透传错误；这不是整体操作预算或 heartbeat 保证，不改变已冻结操作的预算。

同一轮观察把已读取的原字节写入 owned 私有普通文件，使用 Git `hash-object --stdin-paths --no-filters` 一次写入，仍逐文件保留 mode、摘要及前后观察。读树由 Git 长列表取得对象大小，按原 128 MiB 输出容量分组使用 `cat-file --batch`；每个对象按 framing、完整原字节与 OID 核对。没有显式只读查询作用域时仍逐调用重读，不共享全局缓存。聚合字节不能收紧或放宽单对象容量：framing 超过批次容量的单对象沿用原 `cat-file blob` 路径。空树、缺失 index、二进制、有效 UTF-8 路径及 symlink 语义保持不变，真实 Git 失败继续透传。

读树调用者可同时接收同次批量校验后的条目和完整原始 bytes，复用已经读取的正文，避免摘要之后再逐对象启动 Git。回调只在该对象 framing、完整字节与 OID 核对成功后交出字节，返回的 TreeEntry 顺序、digest 和全部快照身份计算保持不变；带 `onObject` 的调用每次逐调用完整读取，不共享缓存。

仅只读 HTTP status/detail 查询可用 `withReadonlySnapshotQuery` 在本次异步上下文内重用无回调且完整读回/OID 核验成功的 TreeEntry。key 同时绑定 commonDir 的 realpath、既有物理 dev/ino/birthtime 与完整 tree OID；命中返回独立副本。`onObject` 始终走原批量字节路径并交出每个对象；失败读不留下成功项。作用域结束或失败后立即停用并清空，继承上下文的遗留异步任务也不能命中。verifySnapshot 每次仍核对 HEAD/tree、manifest blob、contentDigest 与 snapshot id，不缓存验证结论。业务写入、派发、采纳、验证交付等真实动作入口保持在作用域外；只读查询保留快照自身原有 owned private evidence/ref 写入。未显式作用域的读对象继续逐次完整读取。

自动提交输入使用同一 captureInputSnapshot 的 committed 模式：前后核对物理来源、分支、HEAD 与其不可变 tree，仅从 Git 对象读取条目和原字节。它不读取工作文件、用户 index 或 untracked 字节；同期保存、暂存和冲突 index 不影响该输入，HEAD 变化仍有限重试。InputSnapshot.captureKind=commit 参与新身份摘要，immutableTree/indexTree 均等于已冻结 HEAD tree，indexDigest 是该 tree OID 的 SHA256，不伪称保存了用户 index。读回同时验证 HEAD/tree/index 绑定。缺 captureKind 的历史记录及默认显式工作区采集保原摘要算法、index 与完整工作字节语义，不能升级重写历史快照身份。


物理source的身份字段按既有固定顺序参与SHA，JSON键排序不是身份变化。固定计划规范序列化后的历史before快照仍可验证；字段值、树、mode、摘要篡改继续拒绝，不重写历史快照或接收另一来源。

内部CAS读取只交出原始字节并逐次核SHA，不为不存在的展示需求嗅探MIME或预先解码JSON；不合法摘要、缺失或损坏的证据仍显式失败，JSON语法由实际读取方判断。
