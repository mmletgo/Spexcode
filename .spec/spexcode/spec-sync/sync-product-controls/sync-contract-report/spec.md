---
title: 业务契约的只读覆盖投影
status: active
hue: 175
desc: 读取当前工作树中的契约和真实绑定，结构投影不冒充运行通过。
code:
  - spec-cli/src/sync/contract-report.ts
related:
  - spec-cli/src/sync-contract-report.test.ts
  - spec-cli/src/index.ts
---
# 业务契约的只读覆盖投影

## raw source

用户查看业务契约时能看到真实声明、代码和测试绑定及缺失处置。仅阅读契约不能产生测试通过或已同步结论。

## expanded spec

读取显式指定工作树的 sync-v1 节点，复用 [[sync-contract-schema]] 的解析、图、检查和覆盖算法。上下文文件来自该工作树的实际代码和测试，不运行 VERIFY 命令，不启动 Agent，不写 Git 或运行状态。

返回当前契约摘要、所有语法与结构发现、需求覆盖、对象状态事件处置及业务 GAP。运行验证明确为 not_run；bound 只表示结构绑定。相同输入产生相同摘要，缺失测试或指向工作树外的符号链接不能假装是有效绑定。HTTP 与后续界面使用同一个投影。
