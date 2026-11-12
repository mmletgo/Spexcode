---
title: 候选外可信 runtime 固定发布
status: active
hue: 175
desc: 从可信已编译安装冻结工具与完整生产依赖闭包，发布到候选外独立 runtime。
code:
  - spec-cli/src/sync/runtime-freeze.ts
---
# 候选外可信 runtime 固定发布

## raw source

受控交付 hooks 必须使用候选外的固定可信工具，不能运行候选 launcher、回连开发源码或随宿主依赖更新而改变验收行为。

## expanded spec

本节点实现 [[sync-execution]] 的工具发布快照；它不表示已完成 private delivery。freezeDeliveryRuntime 接受调用方拥有的绝对目标目录，可由内部调用方提供可信 CLI package root；默认按本模块位置定位当前 spec-cli 包。必须已有 dist/cli.js 与 templates/hooks；源码开发只复制已 build 发布文件，缺失编译物或不支持的发布声明明确 unsupported，不运行 launcher、npm 脚本或联网安装。

workspace 仅复制 package.json 的 files 发布范围及 package 元数据、main/bin 和顶层许可说明，不递归扫描整个源码仓库。显式 files 列表是发布候选 allowlist；精确路径或支持的末段 glob 未匹配到文件时跳过候选，包括其父目录不存在的情况。files 中以 ! 开头的排除项支持精确文件或子树、末段 glob 及 **/basename 递归匹配，在复制发布候选前过滤；必需元数据与 main/bin 不受候选排除影响，仍遵守私有元数据和入口闭合检查。路径仍需安全规范化；非法/越界路径、存在的 symlink 父目录和特殊文件仍拒绝。files 候选缺席不豁免 main/bin、exports 中运行条件或固定 CLI 入口引用的文件，这些实际入口缺失仍明确 unsupported。exports 条件对象中的 `types` 与 `types@...` 分支仅供类型系统解析，不参与运行时闭包检查；`default`、`import`、`require` 等其他条件和普通 `./types` 子路径仍严格闭合。外部已安装包可复制包自有发布内容。生产 dependencies、optionalDependencies 和 peerDependencies 按每个实际物理包的 Node 解析上下文递归冻结；缺包拒绝，不沿用宿主 fallback。每个物理包在 runtime 内独立保存，通过其私有 node_modules 相对 symlink 连接已冻结依赖，保留不同版本、嵌套解析和循环依赖；不能软链到原源码或原 node_modules。

发布文件路径必须可证明在所属 package 内；未知 glob/导出路径不猜默认。Git、node_modules 原目录、home 配置和已知凭据元数据在读取字节前排除，并列出排除路径。遵循 npm 发布不包含 payload symlink 的规则，源 payload symlink（包括越界和断链）不跟随读取并明确列入排除；必需入口、bin/main 和 exports 运行条件引用被排除路径或缺文件仍拒绝，特殊文件也拒绝。最终闭包中所有 symlink 只指向 runtime 内已复制对象。所有实际发布字节、模式和链接由复用的 inspectTrustedRuntime 形成 manifest/digest，并返回 CLI 原 package 身份与依赖关系。

先在目标父目录的独立临时目录复制、核完整声明和内部链接，再封为只读、rename 发布；已存在目标拒绝替换，失败清理本次临时目录，不修改可信安装或主运行配置。清理复用 [[owned-tree-cleanup]]，只解锁实体目录，不跟随 symlink 改动目标。成功返回 trustedRuntimeRoot、toolEntry、canonicalHooksDir、manifest、digest、sourcePackage 和 packages；后续源安装变化不修改固定产物。
