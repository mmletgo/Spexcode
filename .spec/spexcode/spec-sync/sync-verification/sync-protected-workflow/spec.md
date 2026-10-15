---
title: 受保护同步检查的CI工作流
status: active
hue: 175
desc: 在已验证的专用原生环境运行目标基线校验器，只把候选作为不可变数据。
code:
  - .github/workflows/sync-conformance.yml
related:
  - scripts/sync-conformance-ci.mjs
---
# 受保护同步检查的CI工作流

## raw source

跨机器检查必须在真实支持的隔离环境执行，普通候选不能改写自己的校验器或取消门禁。

## expanded spec

复用 [[sync-conformance-ci]]：pull_request_target 只checkout/build事件base SHA，候选仅fetch Git对象，核merge snapshot的两个父提交精确等于事件base/head后调用受保护runner。token仅只读fetch，不持久写配置或输出认证内容；不运行候选安装脚本或workflow，候选代码只进入既有无网络/宿主认证挂载的Docker边界。

明确选择专用self-hosted/macOS/ARM64/spex-sync-conformance标签，不将只有macOS Seatbelt证明的adapter派到Ubuntu。管理员为独立、单任务且不承载其它项目凭据的runner配置该标签，预装codex-cli 0.160.0及正常系统认证、运行中的Linux Docker引擎和政策冻结镜像。workflow只探测能力，不安装服务、不读取或写入认证内容。无对应runner、认证、镜像或管理权限时远端门禁仍待配置，不能记为验收通过；workflow文件不代替required-check设置。
