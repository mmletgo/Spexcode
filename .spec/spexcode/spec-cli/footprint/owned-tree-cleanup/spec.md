---
title: 自有只读树回收
status: active
hue: 20
desc: 回收调用方已证明拥有的树，包括只读快照；删除链接本身，保留链接目标。
code:
  - packages/spec-core/src/owned-tree.ts#removeOwnedTree
related:
  - spec-cli/src/owned-tree.test.ts
---
# 自有只读树回收

## raw source

SpexCode 必须能完整回收自己拥有的临时目录与项目运行状态，包括封为只读的 runtime 快照，同时保留 symlink 指向的外部内容。

## expanded spec

调用方先证明目标存在且属于本次清理范围。spec-core 的 removeOwnedTree 使用 lstat 识别实体目录，只补齐目录所有者所需的读、写、执行权限，保留原有组与其他用户权限，再删除整棵树；不跟随 symlink，也不修改链接目标的字节或模式。错误直接传回调用方，不以重试掩盖无法清理的状态。

[[spex-uninstall]] 的项目 store 回收与 [[sync-runtime-freeze]] 的失败临时目录清理共用这一原语。
