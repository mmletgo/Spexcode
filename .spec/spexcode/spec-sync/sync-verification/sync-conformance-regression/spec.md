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

公开 CLI 使用模拟 Manager 与 Cursor ACP 测试端点，验证正式选路、预留及结算、候选 Git 工作树只读模式、完整旧新字节的输入绑定、回收和调用方原 Git 状态与数据库隔离。Manager 无就绪路线、无法证明大上下文完整读取时均拒绝派发，后者保留冻结输入。精确结算无法确认时保留原生原件并返回 `recovery_required`。这些模拟端点的证据覆盖产品派发和资源生命周期。

模拟首条路线的精确额度失败后，公开 CLI 使用原功能组、原路线和真实失败会话取得后继。两次独审拥有独立会话和原件，并核对同一冻结候选及完整输入。模拟 Manager 拒绝结算时，公开命令保留现场并阻断后继派发。普通 ACP 错误只结算原会话。

大正文只向原组请求 `frozen-reader-v2` 能力。缺少该能力时保留全文、零会话派发。macOS 隔离验收可载入含持久 Codex 适配器的 Manager 构建产物，使用受控 App Server，核实际冻结候选、完整 v2 可见性证明、Manager 结算、归档、候选工作树和专用 App Server 回收。大正文服务端的确切额度失败先结算并归档，再向同组请求同能力后继并核同一候选。模拟没有所选模型和线程前配置审计拒绝，核独占进程在返回前停止。模拟可疑装载引用时，要求保留现场并报告待恢复。退出原 daemon 后用原请求键复验同一个结果，模拟载体丢失和等字节不同 inode 时分别拒绝，确认没有新轮次。定向命令以 `SPEX_MANAGER_FROZEN_TEST_RUNTIME` 传入该测试产物的绝对路径。真实模型能力验收沿 [[frozen-context-reader]]。

unlimited可信配置的CI独审回归验证缺省120000ms或显式有限callTimeoutMs；旧有限配置原60000ms fallback保持。Docker不可用仍不能passed，不从无限总预算取得审查或验证豁免。
