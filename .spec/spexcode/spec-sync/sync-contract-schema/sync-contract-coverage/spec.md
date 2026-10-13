---
title: 声明覆盖、GAP 与变更影响投影
status: active
hue: 175
desc: 从同一契约图派生条目绑定、状态事件矩阵、局部阻塞及实现与验收影响范围。
code:
  - packages/spec-core/src/contracts/coverage.ts
---
# 声明覆盖、GAP 与变更影响投影

## raw source

需求必须能找到叶实现与验收，未决政策必须显示准确影响；图和覆盖不能成为第二份可编辑契约。

## expanded spec

覆盖状态和治理政策遵循 [[sync-contract-schema]]，依赖扩散由 [[sync-contract-graph]] 提供。`projectContractCoverage` 从契约图派生业务项 AC 声明、真实治理映射、测试及 VERIFY 身份、GAP 阻塞闭包和按对象区分的状态事件矩阵。需求可无本地 code，通过明确推导链找到叶节点；实现与 AC 分属不同节点仍可形成绑定，related 不计治理。

条目绑定结合验收声明与治理映射；矩阵显示处置及验收声明，缺失处置保持 missing。所有 bound 均只表示结构声明，不能作为真实测试通过、条件完备或功能已同步的证据。

`contractImpact` 从变更业务 ID 或节点身份反查引用消费者，并纳入共享代码文件的治理节点，返回受影响节点、代码、测试及 VERIFY 范围。导航可以扩大变更影响，但不扩大 GAP 阻塞范围；结果不修改输入、不执行命令。
