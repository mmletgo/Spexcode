---
title: 受保护目标启动的跨机器检查
status: active
hue: 175
desc: CI只构建目标基线的校验器，候选对象仅作为数据进入独审和隔离执行。
code:
  - scripts/sync-conformance-ci.mjs
related:
  - .github/workflows/sync-conformance.yml
  - scripts/sync-conformance-ci.test.mjs
---
# 受保护目标启动的跨机器检查

## raw source

普通候选不能修改自己的 workflow、命令或政策来取消本次门禁，远端检查不信开发机记录。

## expanded spec

启动脚本核真实 HEAD 等于调用者提供的受保护 base SHA，受信 runner 的受跟踪文件必须干净；candidate 和 policy 必须是真实不可变提交。只调用当前受保护目标编译的 [[sync-conformance-cli]]；不执行候选安装脚本或 runner。调用者缺省 policy 为 base，也可明确传入外部已受信政策 SHA。

配套 workflow 使用 pull_request_target，从明确 base SHA checkout/安装/构建。候选只 fetch Git 对象，不 checkout；验证 merge snapshot 两个父提交精确等于事件 base/head，目标前进则失败并等待新组合检查。Git token只读、不持久写入配置，候选代码只在 [[verification-executor]] 无网络/认证挂载的容器运行。无 native readonly 语义能力、认证或 Docker 返回 unsupported，不以 CI 运行完成替代业务通过。

workflow 文件落地不等于远端 required-check 已配置；需要仓库管理者在外部保护设置登记 sync-conformance，并提供既有受支持 readonly adapter 的实际运行环境。未启用同步范围仍明确显示未治理，不由单个 green check 推断所有需求完成。既有 CI job 保留。
