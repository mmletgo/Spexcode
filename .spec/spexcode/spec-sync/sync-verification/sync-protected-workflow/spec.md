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

明确选择专用 self-hosted/macOS/ARM64/spex-sync-conformance 标签。管理员为独立、单任务 runner 安装 LLM Manager，登记正式验收功能组及该组原生 CLI 的系统认证，并提供运行中的 Linux Docker 引擎和政策冻结镜像。workflow 只探测 Manager 安装入口和 Docker，不安装服务或读取认证内容。无对应 runner、Manager 路线、镜像或管理权限时远端门禁仍待配置；workflow 文件不代替 required-check 设置。
