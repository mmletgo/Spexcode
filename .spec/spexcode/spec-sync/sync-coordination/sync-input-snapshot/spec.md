---
title: 不可变外部输入快照
status: active
hue: 175
desc: 前后核对物理身份、HEAD、index和完整字节，形成可恢复Git对象输入。
code:
  - spec-cli/src/sync/snapshot.ts
---
# 不可变外部输入快照

## raw source

保存、切分支和删除重建不能形成混合输入；用户 staged、unstaged 和 untracked 字节及 index 必须原样保留。

## expanded spec

同一 Git commonDir 实际登记的嵌套 worktree 是独立输入边界。未被外层 index 跟踪的这些目录及子项不进入外层快照，即使用户没有配置 ignore；因此产品自行创建会话工作树不会改变来源输入或使状态读取失败。只按真实 Git 登记判断，不按 `.worktrees` 等目录名猜测；普通未跟踪作者文件仍采集，已有 tracked 字节不能由登记关系隐去，未登记的嵌套仓库仍明确拒绝。

本节点实现 [[sync-coordination]] 的 P2 输入原语。只接受 registered worktree 根目录，canonical commonDir、仓库身份、分支、root/gitDir 的 dev/ino/birthtime 组成物理身份。前后采集 HEAD、index 实际字节、tracked/untracked 文件集合、mode、内容摘要与文件变化时间；有限重试后仍不稳定明确失败。父 symlink 不被当成目录读取；symlink 自身保存链接目标 bytes；真实 Git index gitlink/submodule（即使其工作目录已缺失）及其他非文件条目明确失败。普通 cached 文件被目录替换时跳过旧文件条目，完整采集新 untracked 子文件；旧子路径因目录被普通文件替换而 ENOTDIR 时记录为删除，保留原 index 字节及 mtime。

临时 index 构建 immutable tree 和 index tree，不 stage 用户文件或写用户 index。split index 的 sharedindex 字节复制到 owned 临时目录并参与前后核对，支持 linked worktree 的独立 index，原 index/sharedindex 不变。源码仅存 Git blob；manifest 和摘要证据使用明确 commonDir 的既有 evidence store。稳定 ID 不含采集时间；相同身份和相同字节重复采集得到相同 ID。读回校验 evidence SHA 与真实 Git blob OID。私有 refs/spex-sync/snapshots 和 indices 保活对象。

仅本节点的非交付 Git 元数据原语禁用 fsmonitor/reference hooks，防止读取或私有 pin 间接执行候选代码；不能写用户 branch/HEAD，不 commit/merge。开发提交保持正常 hooks；后续 apply/landing 必须另经可信验证门禁，不能套用此元数据边界绕过提交门禁。

读取 blob 后在本进程按完整 OID 的 SHA-1/SHA-256 格式校验 `blob <原始字节长度>\0` 和全部原始字节，不借助第二次 Git stdin 调用或 UTF-8 转换。写对象、更新临时 index 等需 stdin 的元数据命令仅从 owned 私有普通文件读取（目录私有、文件权限 0600），包括空输入；无输入命令关闭 stdin。成功、失败和超时均关闭 fd 并清理 owned 输入目录。每次外部 Git 命令沿用 `SPEXCODE_GIT_TIMEOUT_MS`（默认 120000ms）上界，超时杀死该命令并透传错误；这不是整体操作预算或 heartbeat 保证，不改变已冻结操作的预算。
