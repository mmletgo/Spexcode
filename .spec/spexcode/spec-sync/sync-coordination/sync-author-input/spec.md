---
title: 托管文本的作者输入投影
status: active
hue: 175
desc: 真实来源快照保持不变，只把已证明的托管 clean 内容送入候选。
code:
  - spec-cli/src/sync/author-input.ts
---
# 托管文本的作者输入投影

## raw source

普通 Spex 项目中 tracked AGENTS 和 ignore 文件可含工具插入的托管段。同步不得把工具投影作为用户修改提交，也不得为了剔除托管段丢失作者的 staged 或 unstaged 内容。

## expanded spec

composeAuthoredInput 保持真实 InputSnapshot 和原 index 字节，复用 [[sync-input-composition]] 形成派生输入。只有精确符合 [[content-filter]] 当前发布源的 clean/smudge 命令、SHIM 字节/模式及绑定才允许作者投影；未知 filter 或外部 attributes 配置拒绝且从不执行。没有已登记 filter 时所有正文逐字保留，不能仅凭相同 marker 删除用户文字。

每个参与三方整合的快照都从其不可变 tree 求实际 filter 属性；只处理属性为 spexcode 的 canonical 普通 UTF-8 文件。复用固定 clean 算法，不运行候选或仓库自定义程序。metadata 与配置前后复核，变化明确拒绝。原来源、前次来源与已验证交付先采用同一作者投影，再按既有三方规则合并；工具段变化不产生业务冲突，真正作者重叠变化仍冲突。

证据保存配置与元数据摘要、各快照及其 path/preimage/postimage 对象，不保存宿主命令值或凭据。composed 引用该证据，原 physical snapshot 身份继续供 V4 检测并发用户编辑。正常无改仓库的组合作者 tree 与 HEAD 相符，作者实际编辑仍进入差量，原 index 从不被重写。

P3 retainConflicts透传同一作者投影原语，保留待独审的文本重叠对象。作者文字的Git重叠不直接断言业务互斥；完整行为分类与最终整合证据由 [[sync-code-behavior]] 承担。
