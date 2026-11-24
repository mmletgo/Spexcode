---
title: 已批准 P0 局部分析的操作员复审
status: active
hue: 175
desc: 在正式暂停后用同一作者候选独立核查一个分区的具体诊断。
code:
  - spec-cli/src/sync/behavior-review-challenge.ts
---
# 已批准 P0 局部分析的操作员复审

## raw source

生产环境发现已批准的代码行为分类可能有漏错。操作员应能指出一个冻结 owner 的具体反例，保住其他 owner 的有效审查和原作者稿，先由新的独立审查判断质疑是否成立。

## expanded spec

操作员以稳定 requestId、expectedRevision、冻结 inputId、partitionId、当前批准的局部 analysisRef 与至多 64 KiB 的非空 UTF-8 诊断正文发起。只接入已暂停、原生分区 P0 且在 P1 派发之前的原 operation。原资源、执行 fence、租约与 journal 必须已正式结算，也必须保持原冻结输入、配置、组合、读集、基线、计划与范围。服务查自己的 typed checkpoints 和真实 Git/Native 原件，核实该 owner 当前批准及其原作者与独审。诊断以不可变私有 CAS 引用记录，内容仅供独立核实。相同 operation/requestId 和完全相同内容幂等，不同内容冲突。接入不会派发模型。 新授权还须显式提交非空 evidencePaths。程序按原待审 Git 树验证规范仓库文件路径，允许分区外冻结依赖作为只读证据，拒绝未知、私密或临时协议路径。去重排序后的路径同原诊断保存在 v2 CAS，由 v2 授权引用绑定。已登记的 v1 授权及相同旧请求的幂等回放沿原素材和摘要。

显式 resume 建立新 attempt 和 fence。受质疑分区的任何无本次响应的批准不得由 current、history、whole 或普通正式 retry 复用，也不能退回更老批准。新的独审先核同一个待审分析，原作者 Git JSON、trace、业务 digest 和 schema 不变。新独审请求的 Git context 和正式原件绑定诊断，诊断不能写入业务事实、原意、生成权限或其他分区的任务。格式拒绝与中断继续同一候选。新真实 accept 才恢复推进资格。新真实业务 repair 按既有机制携原作者 JSON 和真实独审发现续修，再独立复审。 续修中断时，若没有新的作者稿，沿精确续跑来源核验最新完成的作者派发与 Git 稿，继续使用同一原稿和独审发现，仍需新的独立复审。其他 owner 保留已认证原批准。正式历史与原预算、累计调用、截止时间不重签。P1 之后的撤销不在此入口的授权范围。

v2 独审前置指向精确诊断和证据路径。[[sync-code-behavior]] 将原变化路径和证据路径求并，冻结为本次独审的必审集合。缺任一路径时，原稿与机器可复验的覆盖拒因保留，沿同一待审分析只续独审。覆盖齐备后，独审仍依据事实自由接受或提出具体修复。[[sync-coordinator]] 重用批准时重新核查原证据、精确覆盖和审查 schema。

当前和历史的局部批准、whole 聚合与只读查询使用同一原生产者认证。认证缺失时明确拒绝复用，保留原稿及原批准记录。
