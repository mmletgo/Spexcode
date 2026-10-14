---
title: 快照整合与候选真实Git回归
status: active
hue: 175
desc: 真实临时仓库验证原index、物理身份、三方整合、冻结范围与独立导出。
code:
  - spec-cli/src/sync/snapshot-candidate.test.ts
---
# 快照整合与候选真实Git回归

## raw source

局部原语必须以真实临时 Git 仓库验证，不能仅凭类型、mock 或 Agent 声明认定成功。

## expanded spec

验证 [[sync-input-snapshot]]、[[sync-input-composition]]、[[sync-frozen-candidate]]：staged/unstaged/untracked 原字节/index 保留，file↔directory 完整新文件采集且 index 字节/mtime 不变，真实 gitlink 明确拒绝，稳定 ID、GC pin、并发保存/切分支重试、删除重建物理身份撤销，前轮生成内容保留与三方非重叠/重叠处理，新增/删除/mode/binary 完整差量，schema/CAS/遍历/.git/父 symlink/实际范围拒绝，冻结后旧文件改写无影响，独立只读导出对应真实摘要及明确排除，SHA篡改拒绝与元数据 hooks 不执行。本节点不代表完整持续后台、apply journal、真实 Agent 或产品最终验收已交付。
