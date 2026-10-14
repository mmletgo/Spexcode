---
title: 成对基线三方整合
status: active
hue: 175
desc: 将真实来源差量叠加前轮已验证交付，保留生成内容并显式返回冲突。
code:
  - spec-cli/src/sync/composition.ts
---
# 成对基线三方整合

## raw source

下一轮必须保留前轮 Agent 的 Spec、代码与测试，只把外部来源的新差量整合到前次已验证交付。

## expanded spec

本节点实现 [[sync-coordination]] 成对基线原语：next = priorVerifiedDelivery + delta(priorSourceInput, newSourceInput)。无基线时从新来源构建派生输入，previousBaselinePairId 为 null，不伪称已验证基线。来源物理身份、分支或仓库不匹配时拒绝；发布交付树成为来源必须使用该真实物理树自己的基线。

ComposedInputRef 独立绑定 sourceInputId、previousBaselinePairId、tree、manifestBlob 和 contentDigest；原 InputSnapshot 的 immutableTree/indexDigest 不改变。成对基线只证明 coveredScope；未覆盖的来源路径直接采用 newSource，即使本轮没有继续编辑也保留前轮未交付的 blocked 输入，不把完整 sourceInput 误作全量已交付基线。原字节和 mode 相同视为未改；新增、删除、移动表现为完整 path/mode/bytes 差量。同文件双方非重叠 UTF-8 文本通过真实三方合并；重叠、删除修改、二进制和 symlink 分歧保存 base/source/delivery 的 Git blob OID 与摘要，返回明确冲突，不产出可自动接受的组合输入。私有 composition ref 保活派生对象，不执行候选代码或提交。

mergeText 导出同一真实三方文本算法供 [[sync-controlled-request]] 叠加用户请求；调用方明确提供 delivery/base/source Git 对象，冲突返回 null，运行故障继续抛出，不能把冲突标记当有效正文。

可信作者投影可在三方整合之前对各快照的对象条目应用同一已验证规则。InputSnapshot 身份和原始对象保持不变，冲突仍引用参与整合的真实派生 blob；只有经过 [[sync-author-input]] 核对的托管文本可采用该接缝。

P3协调可显式retainConflicts，重叠位置暂采用新source字节并将完整base/source/delivery对象存compositionEvidenceBlob；它只是待分析输入，不是冲突裁决或可交付证明。默认原语仍在文本重叠返回null。独审相容整合或具体业务finding之后的最终候选必须再通过完整V1–V4，不能把暂选字节当自动覆盖授权。
