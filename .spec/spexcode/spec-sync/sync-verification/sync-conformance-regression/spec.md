---
title: 跨机器严格检查的拒绝与运行回归
status: active
hue: 175
desc: 用真实Git基线、独立克隆和真实Docker核候选义务与拒绝边界，明确注入审查范围。
code:
  - spec-cli/src/sync/conformance.test.ts
---
# 跨机器严格检查的拒绝与运行回归

## raw source

跨机器检查不能信本机通过记录，也不能让候选自行删除旧义务或选择较弱政策。

## expanded spec

[[sync-conformance]] 的回归从真实Git提交、独立克隆和新HOME重算，不读取开发机DB/receipt。覆盖Spec-only未实现独审拒绝、删除schema/node/AC/test、改变固定命令或oracle、未治理新源码、纯raw未细化、缺失稳定旧用例、错candidate/readSet/policy绑定、能力不可用、无配置及未治理范围。已配置无关变化为not_applicable，不能空范围passed。

[[sync-intent-authorization]] 的精确登记只从外部选定的 policyCommit 读取；缺失、错路径、前后摘要不匹配、缺显式 null、二进制及链接文件都在独审前拒绝。候选自行登记或篡改授权不能改变受信差量。授权后 Spec-only 与错误实现仍由独审拒绝，旧稳定用例、退役负向断言、固定命令及保护 oracle 均不免检。纯授权政策提交不扩大独立模块的读集合或运行计划；节点移动必须分别登记旧路径删除和新路径新增。

合法业务变更、合法AC退役的旧负向用例、新旧可信命令并集在启用Docker场景中真实执行；审查runner为明确标记的注入接缝，不能冒称原生语义验证。真实CLI跨进程保0/1/2退出码，产品入口无注入passed参数。大于2MiB的完整旧新源码、断言及身份仍送达独审，受控拒绝依然阻断V3；原生按需读取覆盖由 [[frozen-context-reader]] 单独证明。
