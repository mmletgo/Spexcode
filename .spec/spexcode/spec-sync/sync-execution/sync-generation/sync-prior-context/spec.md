---
title: 分区历史正文角色
status: active
code:
  - spec-cli/src/sync/prior-context.ts
---

## raw source

删除或移动规格后，分区生成和独审仍须读取真实旧规格、源码及验收正文，明确区分提交前来源和已验证交付，不把摘要或历史正文冒作当前事实。

## expanded spec

复用[[sync-generation-types]]的priorContext角色，以同一物理source核对source_before；verified_delivery仍绑定真实交付快照。按本区旧owner和move目的归属选择历史ready/退役身份，将旧Spec完整正文声明的精确code、related目录或glob、AC.test和code来源用共享[[code-anchor]]路径匹配器展开到真实旧快照entry，再投影为局部历史读集合；不能以字面声明代替正文。manifest、普通文本与非文本对象沿同一真实旧快照保留，原验收不能因当前文件已删除而消失。

角色说明由生成与最终独审共用。无priorContext时不增加任何提示句，保持旧v1冻结JSON和摘要。该模块只提供历史归属和正文投影，不产生业务授权、替代完整读取证明或伪造交付receipt；真实快照校验、写权限和最终候选仍由[[sync-generation]]与[[sync-partition-execution]]执行。
