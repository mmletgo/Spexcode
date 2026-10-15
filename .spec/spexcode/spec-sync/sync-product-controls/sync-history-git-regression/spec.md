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

精确恢复证明保留原节点、业务字段、代码锚点和验收测试映射，并核对原操作及已结算 receipt。错误对象、路径、receipt、伪来源字符串、缺少固定历史输入或未知请求字段均拒绝；仍存在于其他路径的同 ID 不得被误判为退休。当前真实 intent head 已恢复 A 时，旧路径的退休历史不能再次污染 A，无关退休 B 仍须禁用。普通新节点和业务项复用退休 ID 仍拒绝；真实旧 source 与 delivery 对象不能被历史请求投影覆盖。
