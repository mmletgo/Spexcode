---
title: 不可变冻结上下文的按需读取
status: active
hue: 175
desc: 以唯一受限动态工具无损读取冻结字节，并用精确原生历史证明完整覆盖。
code:
  - spec-cli/src/frozen-context.ts
related:
  - spec-cli/src/frozen-context.test.ts
  - spec-cli/src/frozen-context.native.test.ts
  - spec-cli/src/session-structured.ts
  - spec-cli/src/codex-harness.ts
  - spec-cli/src/sync/native-run.ts
---
# 不可变冻结上下文的按需读取

## raw source

结构化生成与独立审查必须完整接收冻结上下文。超大正文不应只因内联prompt大小而unsupported，也不能静默截断、读取live文件或凭模型声称已读。

## expanded spec

[[structured-readonly-policy]] 的v2仍保留既有只读隔离，仅增加spex_read_frozen。源码树外0700目录存储内容寻址字节与清单；contextDigest绑定logicalentry、类型、SHA256、字节长度、required及业务requestKey/inputDigest。真实attempt/policy存在时额外严格绑定，普通结构化调用不编造身份。相同bytes去重，logical身份仍保留。

工具参数仅contextDigest/entryId/startByte/endByte，区间end-exclusive、每次不超过262144字节；UTF8字符边界、binary base64、absence均显式处理。路径、URL、额外参数、错摘要、篡改、非法区间立即拒绝。模型索引不含控制路径。真实请求与回复全文及摘要先持久后回RPC；精确turn的真实native history再次核验arguments、completed/success、contentItems全文和required完整coverage，相同kind/SHA/长度可共享覆盖。生成/审查各自在自己turn取得完整证明。

prepareFrozenPrompt在创建或资源计划摘要前将超过2MiB的完整正文转换为单个required UTF8 entry和短读取指令，保原inputDigest；小正文保持v1。相同绑定/内容返回稳定ref，重试不因随机路径改变幂等哈希。createAttemptRunner附加真实policy/attempt并保持业务requestKey，sessionCreateKey另承接正式派发键。provided ref在派发前严格校验绑定。

completed恢复读取精确native history不新起turn或重调用工具，已结算资源核保存history全文/hash和覆盖。断连inProgress的v2不重发旧RPC id，不造完成回执；沿既有cancelling/unknown保留容量，只有正式精确停止证明才允许新attempt。独立actualnative测试必须在专用realm完整覆盖大于2MiB的真实工具返回，并核首中尾内容、原生历史和无新调用恢复，不能把controlled RPC测试冒充实际模型证明。

v2 native能力身份另外冻结CLI版本与去工具provider catalog摘要。默认6.1-sol真实2,097,265字节场景必须使用该能力策略，完整原生tool arguments/results覆盖及随机首中尾证明后才能接受；compatibility模型失败不能充作交付或更换默认模型。
