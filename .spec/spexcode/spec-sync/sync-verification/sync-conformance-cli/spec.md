---
title: 无后台的候选严格检查命令
status: active
hue: 175
desc: sync check 显式指定基线、候选与可信政策，从 Git 对象独立重跑。
code:
  - spec-cli/src/sync/conformance-cli.ts
related:
  - spec-cli/src/sync-cli.ts
  - spec-cli/src/cli.ts
  - spec-cli/src/help.ts
  - spec-cli/src/guide.ts
---
# 无后台的候选严格检查命令

## raw source

跨机器验证必须能够在没有开发机后台和数据库的克隆中，从明确的不可变 Git 提交重新执行。

## expanded spec

`spex sync check --base <sha> --candidate <sha> [--policy <trusted-sha>]` 直接调用 [[sync-conformance]]。policy 缺省 base，调用者才能选择外部已受信政策版本，不能读取候选声明的自选政策。可用 `--repository` 指定被检查仓库、`--evidence-directory` 指定已存在外部证据目录；默认独立临时目录。CLI 不暴露注入 reviewer/driver，不接受 passed JSON，不连接开发机后台。输出完整 JSON，passed 或已配置且无影响的 not_applicable 退出0，unsupported退出2，失败或未完成恢复退出1；顶层 CLI 必须保留此退出码。

`spex help sync` 与 `spex guide sync` 同步展示该真实入口、可信政策含义、退出码及未纳入范围，不将本次局部passed宣称为全项目完成。
