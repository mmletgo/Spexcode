---
title: 快照Git进程边界回归
status: active
hue: 175
desc: 真实Git及进程shim验证私有普通文件stdin、原字节、对象核对、失败与超时清理。
code:
  - spec-cli/src/sync/snapshot-process.test.ts
---
# 快照Git进程边界回归

## raw source

快照对象元数据命令必须以真实普通文件提供明确 EOF，失败或超时不泄漏 owned 文件、fd 或写入用户 index。

## expanded spec

验证 [[sync-input-snapshot]] 的真实 Git 进程边界：单对象、批量对象和 update-index 的 stdin 是 owned 私有普通文件，目录权限 0700、文件权限 0600，空 stdin 明确 EOF；没有输入的命令关闭 stdin。批量写入的每个 owned 对象文件与来源空/二进制/文本字节相同，完成后全部删除；读对象仅核对原字节和完整 SHA-1/SHA-256 OID，不另调用 hash-object。非 UTF-8 blob、错误 OID 与对象损坏明确失败。

退出错误与超时使用真实子进程 shim 注入，检查原错误、SIGKILL、fd 及 owned 输入/对象目录清理；包括观察已读取原字节后的批量写对象失败。来源字节及用户 index 保持不变，验证环境与用户持久状态隔离。
