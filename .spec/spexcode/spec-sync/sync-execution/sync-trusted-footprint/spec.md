---
title: 冻结交付 footprint 政策
status: active
hue: 175
desc: 用只读配置/数据身份核对已登记私有目录，保护冻结作者字节。
code:
  - spec-cli/src/sync/trusted-footprint.ts
---
# 冻结交付 footprint 政策

## raw source

真实可信刷新必须检查当前配置与契约；受控交付不能执行未知 filter，也不能以托管指令渲染改写冻结作者字节。

## expanded spec

政策仅记录私有目录 physical dev/ino/mode、有效执行配置摘要和 canonical filter 外部元数据/数据文件的路径、模式、摘要；不存环境、命令或凭据。私有目录由协调器预建登记且在候选/runtime 外。所有配置读取固定 Git 与 --no-replace-objects，不执行任何 filter/hook。已有 filter payload 的目录清单、manifest/块文件及 common shim/root/bindings/attributes 均冻结；变化拒绝；manifest 仅可引用已声明文本路径与同目录普通数字 payload，外链/越界来源拒绝。

四条 canonical hook 在验证完整受信 runtime 后，从同一固定 dist 目录导入此仅 Node builtins 的政策检查器；每次工具调用前重新核对配置、外部文件和私有目录。materialize 的冻结策略再次检查同一政策，正常解析配置、静态 surface/契约/manifest，并仅刷新 private footprint.json，不植入可执行 command，不写作者文件、source index、common filter 配置、harness trust 或主工作树。静态 plugin 声明和文本允许可信解析投影，其脚本仅作为文本元数据，不执行、不安装 dispatcher。

此模块不创建 worktree、发布 commit 或负责资源锁/恢复；外部并发写者的排他性由协调器保证。ordinary materialize/filter 行为保持。


契约 loader 按进程缓存 repoRoot，因此冻结 materialize 必须在目标 worktree 的独立可信 CLI 进程执行；跨根直接函数调用明确拒绝，避免读取别树契约。
