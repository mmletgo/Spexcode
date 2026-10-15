---
title: 验收绑定到受信运行计划
status: active
hue: 175
desc: 将本轮必需AC绑定到真实测试用例和冻结验证命令，不用测试数量替代覆盖。
code:
  - spec-cli/src/sync/verification-plan.ts
related:
  - spec-cli/src/sync/verification-plan.test.ts
---
# 验收绑定到受信运行计划

## raw source

本轮需要验证的每项验收都必须对应实际运行的测试；候选不能换掉命令，或借助缺失绑定与重复名称把未运行的行为计为通过。

## expanded spec

协调器依据原始及候选影响范围与 GAP 依赖确定必需 AC 集合，本节点不得自行缩小该集合。全部 ID 必须唯一、存在且为 AC；阻塞 AC 明确拒绝，不静默跳过。将 AC.test 拆成仓库路径与稳定用例 ID，并按 AC.command 引用的 VERIFY 分组。VERIFY 的 argv、cwd 和超时必须与外部冻结登记完全相同；镜像、平台和资源配置也由该登记提供，不能从候选自批。

每组运行计划携带全部 AC 到测试文件和用例的映射，expectedTestIds 从这些必需绑定推导。一个测试可以检验多项业务断言，但同一运行命令内同名用例指向不同文件时拒绝歧义。绑定文件或用例仍由结构门禁校验；真实结果由 [[verification-executor]] 唯一通过事件及 [[sync-verification-run]] 的持久身份确认。返回计划不代表测试已运行，也不代表整个业务范围已同步。

不可改 mandatory oracle 也使用同一分组和固定执行政策；不存在候选 AC 引用不能让它漏跑。唯一可信登记、稳定测试ID及文件路径均须有效，与 AC 共享同名用例歧义拒绝及资源政策复制规则。
