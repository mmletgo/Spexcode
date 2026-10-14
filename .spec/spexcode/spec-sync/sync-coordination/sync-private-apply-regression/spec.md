---
title: 私有应用故障与恢复回归
status: active
hue: 175
desc: 真实Git与SQLite journal验证写后故障、第三方值、取消与目录互换。
code:
  - spec-cli/src/sync/apply-files.test.ts
---
# 私有应用故障与恢复回归

## raw source

私有逐文件应用必须以真实 Git、SQLite journal 和可控故障注入验证，不能仅凭文件已修改宣称完成。

## expanded spec

针对 [[sync-private-file-apply]] 验证：原来源 staged/unstaged 内容及 source/target index 原字节不变；write 后 checkpoint 前故障进入 recovery_required，恢复补登记 postimage；重复恢复不改变已完成文件 inode/mtime；先预检全部文件，第三方值不会导致更早文件被提前覆盖；单元中第三方变更也保留。applying 取消继续短单元，只有根协调器结算 receipt 后才成为 cancelled；模块本身不发布或标 synced。

file↔directory 双向转换和恢复得到完整冻结树；未知目录文件不递归删除，父 symlink 不跟随，未变链接保留，来源安全新增链接及链接链交付/故障恢复不重建，模型链接 schema、外部目标、循环及第三方 link 值拒绝，可执行 mode 准确，无变化计划仍返回完整真实快照。独占断言、原 source 交付和验证范围错误明确拒绝。验证命令：根目录 `npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/apply-files.test.ts`，`npx eslint spec-cli/src/sync/apply-files.ts spec-cli/src/sync/apply-files.test.ts`，build 后 typecheck。前置 V1–V4 记录是此局部故障夹具的可控门禁，不代表真实 Agent 或最终产品验收通过。

恢复回归同时包含目录→来源安全链接后 receipt 前重入、链接→目录初次应用与重入；未知祖先链接仍拒绝。真实应用子进程打开已授权 scratch 临时文件，在 0 字节及首 3 字节 fsync 后 SIGKILL，随后用同一真实 SQLite journal 恢复：旧残片保留、候选不含暂存、source/target index 原样。暂存 source/target 内部路径及 symlink 拒绝；已有其它 namespace symlink/未知残片不采用、不跟随、不删除。
