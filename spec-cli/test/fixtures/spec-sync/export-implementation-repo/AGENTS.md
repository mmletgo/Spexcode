# 导出生成基准

这是夹具作者限定的纯内存导出服务，不代表持续同步产品的默认业务政策。`.spec/` 保存自然语言原意与生成契约；`fixture-facts.txt` 是可信完整政策；`trusted-oracle/` 是不可修改的独立验收。初始输入不含业务实现。

只允许生成或修改 `.spec/export/export-contract/spec.md`、`src/export.js`、`tests/export.generated.test.mjs`。原始需求、facts、package、oracle 与本指令不可修改。必须生成自己的完整业务测试，不能复制 oracle。

运行：`node --test tests/export.generated.test.mjs trusted-oracle/export.oracle.test.mjs`。所有 AC 绑定 generated tests 的稳定标题 ID；固定 VERIFY-EXPORT-01 使用上述 argv、cwd `.`、timeoutMs `30000`。代码治理锚点只有实现存在后添加。
