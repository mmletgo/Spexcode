---
title: 已落地功能的成组补偿输入
status: active
desc: 从真实已采纳提交反向三方合成完整补偿，保留后续编辑和冲突证据。
code:
  - spec-cli/src/sync/history-input.ts
---
# 已落地功能的成组补偿输入

## raw source

撤销已落地功能使用新的补偿提交，Spec、代码、测试和映射一起处理，不重写共享历史，不覆盖后续用户编辑。

## expanded spec

固定当前真实输入、已采纳 feature commit 和唯一 parent。交付提交必须有唯一 parent；合并或根提交明确不支持，不猜测要撤销哪侧。feature 必须是当前 HEAD 的祖先。以 feature 为共同基线，将其 parent 的反向变化合入当前不可变工作树，采用 Git 原生三方及 rename 语义；原工作树、index、HEAD 与分支引用不变。

完整变化清单包括新增、删除、mode、Spec frontmatter 与节点位置。每项保留当前对象和补偿对象，Git 对象与 evidence 只作为不可变运行输入。真正冲突保留 Git 原始输出及三方路径，不把带冲突标记的树视作可交付结果；后续业务裁决仍经 [[sync-coordinator]]。无冲突结果必须进入同一四层验证、journal 与新提交交付，不因能合并就宣称业务完成。

读取固定请求重核 input/source、feature/parent、完整三方结果、变化清单与 Git tree；不能伪造、遗漏或替换成单文件请求。新输入不能重放旧补偿。

反向三方仅使用 Git 内置合并，拒绝外部 merge driver，明确关闭 renormalize，避免不可变候选触发宿主自定义合并命令或过滤器。Git 输出中的冲突树仅作证据，分析暂选明确 parent 对象而不传入冲突标记。
