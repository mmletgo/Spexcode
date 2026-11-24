---
title: P0 作者证据预检
status: active
code:
  - spec-cli/src/sync/code-behavior-author-evidence.ts
related:
  - spec-cli/src/sync/code-behavior.ts
  - spec-cli/src/sync/code-behavior.test.ts
---
## raw source

把正式必验归属和重复源码事实的核验前移，避免作者和独审反复交接。原必验范围与独审标准保持。

## expanded spec

正式必验从冻结计划派生完整 verificationId、testPath、testId。作者用精确登记引用声明正式用例。抽象验证定义只可作为定义引用，定向测试单列实际路径与稳定 ID。裸 VERIFY 标识不能成为作者事实字段中的正式证明，冻结必验登记不可由稿件扩减。独审仍核验业务断言与具体测试覆盖。

共享代码事实以 source 唯一登记，其他字段可按同一身份引用，未知引用和重复声明明确拒绝。[[sync-code-behavior]] 沿 [[sync-frozen-anchors]] 在冻结作者源码上核实际符号；真实业务语义和触发路径继续由独审复核。作者事实字段的明确导入异常或首败主张须引用可信冻结观测，无观测时只陈述可证明的静态依赖和缺失。预检不执行项目源码。已冻结的可信事实原字节可作为引用来源，稿件不能新增可信运行观测。

同一问题保留原稿各字段位置。程序检查失败先保原 Git 草稿及原身份，停止本区独审派发。再次续修按同一判据从原稿生成逐字段诊断。已审兄弟按 [[sync-partition-execution]] 保持原批准。
