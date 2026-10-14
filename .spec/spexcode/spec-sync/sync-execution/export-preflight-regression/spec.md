---
title: 导出预验边界回归
status: active
desc: 验证自然语言初始条件和可信 oracle 的实际冻结写保护。
code:
  - spec-cli/test/p2-export-preflight.test.ts
---
# 导出预验边界回归

## raw source

预验不能预填业务实现或契约表，也不能让模型通过修改可信验收和政策制造通过。

## expanded spec

检查自然语言 raw 输入无契约表、初始白名单无实现或 generated tests，固定命令含独立 oracle 且其稳定标题存在。创建真实临时 Git 仓库，经生产 capture/freeze 验证修改全部受保护文件均因实际 scope 越界拒绝，源 snapshot/index 不变。本静态边界回归不替代真实 native/Docker 运行。

直接复用生产 schema 验证派发前可信登记：旧两段 VERIFY-EXPORT 和错误种类 AC-EXPORT-01 被拒，合法三段 VERIFY-EXPORT-01 通过，登记/指令必须一致；业务命令与 oracle 稳定断言不因技术 ID 修正而缩小。

业务 facts 不含 VERIFY、oracle 或生成器编排指令；固定作者政策独立于业务 facts 并保留“不得复制/import/调用oracle”和完整业务测试要求。生产 verifications 字段承载登记，不将合法技术职责混入业务GAP。

针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/test/p2-export-preflight.test.ts`。
