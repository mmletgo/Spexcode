---
title: 历史补偿真实Git回归
status: active
desc: 用真实提交与精确基线核验不可变成组请求、冲突和已采纳删除的恢复投影。
code:
  - spec-cli/src/sync/history-input.test.ts
---
# 历史补偿真实Git回归

## raw source

[[sync-history-input]] 的反向三方必须保留真实历史和用户后续工作，不能靠构造JSON或冲突标记假装完成。

## expanded spec

真实 Git 提交覆盖 Spec、代码与测试的成组反向三方；无关 staged/unstaged、同文件后续非重叠编辑与原 index/HEAD 保留。重叠保留 Git 冲突证据，真实 rename 跟随节点路径，不接受错误输入或未采纳提交。外部 merge driver 明确拒绝且不在宿主运行。

已采纳删除的精确 ID before/delivery/source 皆空时，固定补偿请求恢复的真实 Markdown 仍进入逐ID意图与残差核验；此投影证明不批准退役身份复用，后续业务门禁继续生效。
