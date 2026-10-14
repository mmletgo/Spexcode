---
title: 作者输入投影回归
status: active
hue: 175
desc: 真实Git中的工具段不进入候选，作者字节和并发编辑仍保留。
code:
  - spec-cli/src/sync/author-input.test.ts
---
# 作者输入投影回归

## raw source

作者文本与工具插入内容共存时，同步必须保留作者工作并避免发布工具段。

## expanded spec

针对 [[sync-author-input]] 使用真实 Git、canonical clean/smudge 配置、真实快照与三方组合。验证不同末尾换行及空白逐字往返，来源物理文件和 index 保持不变；无 filter 的 marker 文字不可删除。前次交付与当前工具段变化可以与非重叠作者修改合并，真正重叠修改保留冲突。未知命令和漂移绑定拒绝且 marker 不被执行。原始物理组合保留工具段的对照直接证明此作者投影的必要性。
