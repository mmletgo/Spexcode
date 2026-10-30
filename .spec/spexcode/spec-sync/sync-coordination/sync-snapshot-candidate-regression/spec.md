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

对象批处理以真实 SHA-1/SHA-256 仓库验证特殊 UTF-8 路径、二进制/空文件、mode/symlink、缺失 index 与空树；进程计数锁定每轮观察一次批量写对象、每次读树一次批量读对象。先读后篡改同 OID loose object 或移除对象必须再次失败；聚合超过 128 MiB 的分组、单对象恰好 128 MiB 与超限失败分别验证，避免缓存或批次容量改变不可变对象核对语义。

同次读树交出的原始 bytes 与逐对象读取在真实 SHA-1/SHA-256 树逐字一致，条目 digest 对应这些完整字节，空文件、二进制、mode/symlink 和特殊路径不变；篡改 OID 在交出坏对象前明确失败，仍保留原批次聚合、单对象容量及缺失对象回归。

已提交模式以真实 Git 验证默认工作区快照身份保持、captureKind 参与新身份、staged/unstaged/untracked 与采集中保存/暂存均不污染 HEAD 输入，HEAD 变化重试后只返回同一已提交树；indexTree/indexDigest 绑定 HEAD tree，旧无标记快照仍验证成功。
