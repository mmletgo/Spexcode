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

来源HEAD已包含旧verifiedDelivery提交时，仅对delivery快照等于该提交树字节/mode且在coveredScope内的路径采用已交付条目作为真实作者基准。此Git采纳证明使前次新增叶后来移动/删除成为真实差量；未采纳来源缺失不删前次delivery，也不将交付回声重新升级为作者授权。

采纳集合包含coveredScope内旧source与delivery路径并集的已交付删除：HEAD树与verified snapshot均缺失也构成tombstone证明。ff接受删除后重建相同旧字节是真新输入；未接受来源旧字节不复活已验证删除。作者基准对采纳tombstone删除旧条目，退役业务身份仍禁止复用。

P4按冻结 FrozenBaselineSelection 逐资源组合：path 的 bytePair 只负责该真实完整文件 bytes/mode/tombstone；contract/flow 的 intentPair 只证明其 covered ID 已消费的作者意图。两者可长期不同，不以 pair ID 不同造冲突，也不以 byte source 未变化认定业务无变化。每个非空 pair 核验来源身份、真实覆盖及不可变对象，空绑定不回退全局 latest。selection digest 同时绑定 ComposedInputRef、作者投影与完整组合证据。逐 ID source/delivery/newSource 的真实 owner path/blob/mode、语义摘要与 Git 采纳证明随证据保留；未消费语义残差的 owner path 进入必分析路径。残差不能按 ID 伪拼 raw 或整文件作者基准，组合正文遗漏真实残差时要求完整文件独立整合；归属不明明确 blocked。

精确资源可以由历史P3目录覆盖证明，但选择键必须是实际journal文件路径，目录覆盖不变成虚构文件。执行路径通过executionPaths精确冻结；非执行路径的作者dirty/untracked不进入派生候选，基础采用真实HEAD，完整InputSnapshot继续保原内容。只读资源保完整证据而不授交付写权。读取组合证据时重核真实tree/manifest、路径source/base/delivery对象、每ID真实owner和语义残差及采纳证明，合法hash不能把虚构无变化或替换OID升级成作者事实。

受控投影即使与历史pair共用同一snapshot ID，也不得反改原immutable source对象缓存；作者请求和真正历史基准仍是分别可核验的Git事实。声明executionPaths时，每个路径必须有显式exact byte绑定（可null），缺失不能静默采用HEAD掩盖本轮输入。

代码或测试变化不会因Spec行未变而消失。逐真实intent pair根据其ID实际所属owner的code与AC测试绑定，保source/delivery/newsource完整真实Git对象及owner；不从共享REQ扩大无关消费者。artifacts独立记录authorBase与真实采纳pair/commit，code/test差量进入residualPaths，即使path bytePair.source已夹带该差量也不认定已消费。实际HEAD已接受较新byte head的完整提交时，该真实交付对象可作文件作者基准；code回声不制造变化，后续新编辑仍捕获。getter从同一真实pairs、snapshot、治理和测试绑定重算全部artifact对象与残差，不能凭hash正确的新JSON抹去code-only差量。
