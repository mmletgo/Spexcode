---
title: commit-surgery 真实失败传播回归
status: active
hue: 200
desc: 注入真实 materialize 文件系统 EACCES，证明普通 advisory 与严格原异常传播。
code:
  - spec-cli/src/commit-surgery.test.ts
---
# commit-surgery 真实失败传播回归

## raw source

受控交付不能将 footprint materialize 的真实失败误报为 surgery 成功；普通提交仍保持原 advisory。

## expanded spec

独立临时 Git 仓库和独立进程调用真实 commitSurgery；通过 Node builtin ordinary mkdirSync / strict private writeFileSync 注入 EACCES，并为冻结策略登记真实私有政策 并同步 ESM binding，确保异常来自真实 materialize 路径。普通模式返回成功并提示 footprint 可能过期；trusted-v1 模式传播同一个原异常，不转换为成功或仅测 mock CLI 退出码。finally 恢复 builtin，临时仓库自动清理。

针对命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/commit-surgery.test.ts`。既有 index/partial staging 行为由 materialize.test.ts 中 commit surgery 两项回归验证。
