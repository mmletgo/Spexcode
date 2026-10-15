---
title: 实际采纳与主分支落地状态
status: active
desc: 从结算 receipt、提交祖先与当前作用域对象推导原树和主分支实际同步状态。
code:
  - spec-cli/src/sync/landing-status.ts
---
# 实际采纳与主分支落地状态

## raw source

已真实接收的完整交付不能因输入快照 ID 改变而显示过期，开发树采纳和主分支完成必须分开。

## expanded spec

只读投影复用 [[sync-private-delivery]] 的 settled journal 与 receipt。全部交付范围已覆盖、所有 journal 已结算、没有未决业务范围，receipt 的 actualCommit/tree 与实际交付快照一致时，才检查当前源树是否采纳。目标提交须是当前 HEAD 祖先，当前工作文件、index 与 HEAD 的执行及读取闭包均须等于该已验证交付对象，删除同样比较；无关路径和无关后续提交不使证据失效。

原输入工作树采纳只证明 sourceSynced；当前分支还必须等于已确定的受保护主分支，才投影 canonical_synced。未采纳保留开发交付状态，作用域有新编辑则保留已交付历史但当前结果过期。该读取不伪造新的 journal、receipt 或持久 canonical 完成字段。
