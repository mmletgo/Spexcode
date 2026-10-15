---
title: 跨机器候选严格一致性检查
status: active
hue: 175
desc: 从受信基线与政策重算新旧治理闭包，在独立审查和当前候选真实执行后给出结论。
code:
  - spec-cli/src/sync/conformance.ts
related:
  - spec-cli/src/sync/conformance.test.ts
---
# 跨机器候选严格一致性检查

## raw source

CI 不能依赖开发机数据库或候选自行提交的通过记录，也不能因候选删除节点、验收或弱化命令让旧义务消失。

## expanded spec

实现 [[sync-verification]] 的可携带检查入口。调用者明确提供真实 baseCommit、candidateCommit 与受信 policyCommit 的不可变提交 SHA；policy 默认受保护基线，外部 CI 才能指定其他已受信政策版本。候选配置不能选择自己的 runner 或政策。读取真实 Git 对象；原工作文件、index、HEAD 与本机数据库不参与结论、不被修改。临时 Git evidence 只保存本次检查材料，不复用开发机 receipt。

影响范围使用 base 与 candidate 契约图及真实变化路径并集，复用 parser、contractImpact、coverage 和完整冻结锚点校验。删除 schema、节点、AC、测试、修改 VERIFY 或同步配置仍进入旧范围。命令及 mandatory oracle 从新旧真实 owner 和影响闭包选择；删除 owner 仍受基线归属约束，无 owner 的外部保护登记继续严格保留。oracle 自身变更按旧新归属进入影响范围，不能因没有 AC 引用略过。无关路径不强制全仓验证，结果列明未治理路径；局部 passed 不能宣称全项目覆盖。候选不能在保留节点时去除 schema。合法 raw/规则演化和新增验收交由同一独立候选审查核实来源；退役的旧 AC 保留旧 test 路径、稳定 ID 与固定命令，必须有变化后的真实负向断言，完整旧新源码和断言一起独审。

每次新建独立 native 请求，不回放先前会话通过结果。V2 使用 [[sync-candidate-review]] 与既有 readonly native structured adapter，完整绑定 base/candidate/policy/tree、范围和读集合摘要。不存在语义能力或完整上下文超过 2MiB 时明确 unsupported，不截断。测试可注入 runner，结果明确标记 injected；产品入口不接受传入 passed JSON。V3 仅复用 [[verification-executor]]，基线和候选 AC 分别按可信固定政策计划，再合并全部必需稳定 test ID；候选导出无 Git 和宿主认证依赖。旧命令与新政策命令均执行，无法登记的新政策变更明确阻塞。Docker 不可用、测试缺失/跳过/失败、独审拒绝与绑定不匹配都不能通过。

每次输出包含完整冻结输入身份、范围、真实审查 trace、容器结果与诊断；passed 只说明这次候选检查，不授予落盘或主分支同步状态。远端 required-check 必须由受保护目标版本 runner 启动，仓库 workflow 建议本身不证明保护设置已启用。
