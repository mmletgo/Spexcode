---
title: 导出验收夹具的真实断言
status: active
hue: 175
desc: 八个稳定验收覆盖既有规则，包括接受值的身份隔离和重试清除失败原因。
code:
  - spec-cli/test/fixtures/spec-sync/export-repo/tests/export.test.mjs
related:
  - spec-cli/test/fixtures/spec-sync/export-repo/.spec/export/export-contract/spec.md
---
# 导出验收夹具的真实断言

## raw source

验收必须真实检验固定契约，不以测试存在或字符串样例通过冒充所有既有边界已覆盖。

## expanded spec

保持原八个AC标题/ID与命令。幂等验收补不同非有限数字键和不同对象所有者的真实隔离反例，同一值重放仍返回同任务；重试验收同时检查返回任务和存储任务的reason已清空。这些断言补齐已明确的身份及重试义务，不引入新的业务政策。
