---
title: 分区执行证据回归
status: active
code:
  - spec-cli/src/sync/partition-execution.test.ts
---

## raw source

分区并行、局部全文、共同最终候选和只反写Spec必须由可复现的真实Git夹具验证。

## expanded spec

定向测试覆盖局部完整源码/测试正文、同时在途上限、分区和跨边同candidateDigest、独审原件集合而非虚构全局review、已完成检查点重入不重调、异步完成序相同树、code_to_spec无code_generate且source/tests对象不变、取消停止后续派发、只读原意P1及唯一根writer、新依赖冻结和重复业务writer拒绝。协调器的最少调用不足零模型派发/零超扣及v1恢复回归保留在 [[sync-coordinator-regression]]。注入runner不代替真实native读取、Docker及正常hooks验收。


新增功能文件布局回归让三个独立分区分别规划一个此前不存在的源码文件，检查生成allowedScope只有对应精确文件而无共享src目录，跨边审查包含两端真实新增正文。多个区提出同一文件时返回原repair且零code_generate；不得按完成顺序抢writer。原代码方向测试证明从不派implementation_plan或code_generate。


只读接口回归让A仅借读B完整Spec而不含B源码，核A checkedIds没有B业务项；最终A/B cross-edge同时完整读取两端源码，不能保留readonly skip或以局部checkedIds冒充跨边实现覆盖。

旧生命周期Spec的`related: [src/helpers/**/*.js]`在真实删除提交中命中根层`src/helpers/format.js`；生成和最终独立审查都收到同一旧快照里的helper完整首尾字节，且不把它伪装为current files。
