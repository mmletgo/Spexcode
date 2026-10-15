---
title: 受信政策精确授权原意差量
status: active
hue: 175
desc: policyCommit 中的版本化登记只授权指定规范路径及前后原意摘要。
code:
  - spec-cli/src/sync/intent-authorization.ts
related:
  - spec-cli/src/sync/intent-authorization.test.ts
---
# 受信政策精确授权原意差量

## raw source

复用受信 policyCommit，精确登记需求修改前后摘要；之后自动验证。候选自带的请求或通过记录不能证明用户授权。

## expanded spec

[[sync-conformance]] 只从外部可信调用者选定的 policyCommit 读取 `.spec/sync-intent-authorizations.json` 普通 UTF-8 Git blob，不读取本机数据库或工作文件。信任来自 policyCommit 的外部选择；SHA256 与 source 说明均不是审批人签名。

文件格式为 `{ "version": "sync-intent-authorizations-v1", "authorizations": [{ "path": ".spec/product/node/spec.md", "beforeRawDigest": "64位小写SHA256或null", "afterRawDigest": "64位小写SHA256或null", "source": "用户裁决或外部审批的来源说明" }] }`。两个摘要键必须存在；不存在的节点一侧用 JSON null，不与空原意的摘要混淆。拒绝未知字段、重复路径、非规范仓库 Spec 路径、空来源及无差量登记。该文件是受信政策对具体意图差量的登记，不是第二份需求正文。

原意使用已有 `parseFrontmatter` 去除元数据并将 CRLF/CR 规范成 LF，再用围栏感知 `parseParts` 提取 rawSource；无分段标题时使用完整 body.trim()。沿用 parser 的段落拼接和首尾 trim，内部空白及围栏示例保留。摘要是该规范字符串 UTF-8 字节的 SHA256。新增与删除节点显式绑定 null；节点移动按旧路径删除及新路径新增分别登记，不凭相同正文自动继承授权。

仅检查新旧受影响治理闭包中原意确有差量的路径。每条差量必须精确匹配规范路径及 before/after 摘要；无关原意或详细契约修改不索取新授权。缺失、错配或无效受信文件不能进入独审或运行验收。结果列明路径、前后摘要及匹配登记，冻结独审输入同时保存完整旧新原意、所选 policyCommit 和授权文件摘要。独审仍须核实实现、规则演化、退役来源与负向断言；登记不能放宽 V1–V4、旧稳定用例、固定命令或保护 oracle。
