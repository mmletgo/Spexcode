---
title: 固定 runtime 闭包回归
status: active
hue: 175
desc: 用真实已编译 CLI 和不同版本依赖证明发布闭包独立、可运行且不泄露宿主数据。
code:
  - spec-cli/src/sync/runtime-freeze.test.ts
---
# 固定 runtime 闭包回归

## raw source

仅复制入口或返回 stub 不能证明可信工具可以离开原安装独立运行，复制宿主 node_modules 也不能保证安全与版本解析正确。

## expanded spec

验证 [[sync-runtime-freeze]]：从当前可信已编译安装冻结真实生产闭包，在独立临时 Git 仓库运行 dist/cli.js 的 internal trunk、spec lint 和只读 Spec 命令；不调用源码 launcher或网络安装。manifest/digest 精确覆盖实际文件/模式/内部链接，固定包中没有 workspace src 或宿主 node_modules 链接，当前运行配置不变。

用独立已编译 fixture 验证同名不同版本与嵌套依赖保留、循环闭包、源依赖后变而固定产物仍运行原字节，以及已有目标拒绝替换。workspace 未列发布范围、缺 dist/入口/模板/依赖、未知发布路径和越界 symlink 明确拒绝；凭据元数据在读取前排除，不进入 manifest。失败不会留下已发布目标。

显式 files 中不存在的精确候选与缺失父目录候选跳过，冻结后的依赖仍可实际加载；缺少 main、default/require 运行导出和普通 `./types` 子路径仍拒绝。条件对象里的 `types` / `types@...` 声明文件缺失不阻断运行时闭包冻结。
