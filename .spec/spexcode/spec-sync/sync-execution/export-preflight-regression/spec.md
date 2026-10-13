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

针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/test/p2-export-preflight.test.ts`。
