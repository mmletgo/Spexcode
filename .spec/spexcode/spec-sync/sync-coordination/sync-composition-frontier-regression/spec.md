---
title: 精确基线组合回归
status: active
hue: 175
desc: 用真实Git对象和store动作证明文件基线与业务意图基线独立推进。
code:
  - spec-cli/src/sync/composition-frontier.test.ts
---
# 精确基线组合回归

## raw source

共享文件部分交付后，未消费的作者意图必须继续被识别，既有独立交付不能丢失。实际Git采纳后的交付回声不应再次成为作者授权。

## expanded spec

回归 [[sync-input-composition]]、[[sync-code-behavior]]、[[sync-controlled-request]] 及 [[sync-application-planning]] 的精确资源行为。夹具保存真实 source/交付 worktree、Git提交/blob/mode，成对基线经真实store admission→generation→verification→journal→receipt→settlement动作建立，禁止手写SQLite伪造权威。验证四层和行为分析runner明确fake，不把这些单测称为真实native产品验收。

核心三场景：A pair只消费A，B byte pair接续A1+B1且only消费B；新A2保持B1，pairID不同不等于业务冲突。B.source夹带未消费A2而next source没有继续编辑时，对比legacy全latest漏作者残差的失败证据，再证明精确intent head仍强制完整A2整合。普通ff接受真实receipt commit/blob/mode后回声无作者变化，后续A编辑仍能识别。

程序保护负例覆盖未选B政策、局部AC删除、权限弱化，即使fake审查accept仍拒绝。受控请求覆盖非重叠与真实重叠，保原immutable作者patch、selection digest及完整三方，来源/index保持不变。executionPaths排除不相关dirty/untracked；真实读取/保护闭包不以source/test授权目录冒充范围。P3目录coveredScope能够证明journal exact文件head；FLOW只用flow资源，VERIFY是执行政策保护。getter重核actual snapshots/OID/语义，hash正确的新伪造证据也不能删除残差或替换source对象。

同一真实Git/store夹具另验证code-only A2：Spec行和raw没有本轮变化，B.source已夹A2但交付A1+B1且only覆盖B，直接actual analyzeCodeBehavior的requiredChangedPaths旧版为空而修复后含真实源码。完整整合保A2/B1，fakeaccept也不能删B、弱化权限或mode；getter拒hash正确的伪造artifact无残差。ff采纳真实receipt commit/blob/mode后无代码回声，再A3仍必读；真实原source、交付、newsource全文与OID分别进入上下文，不伪造作者基准。

只读上下文反例使用真实tracked配置HEAD旧对象与source dirty新对象、mode变化及oracle删除：旧组合返回HEAD旧OID，contextPaths修复后等于实际source且不扩大executionPaths。hash合法的新证据移除context metadata仍因真实source/HEAD不一致而拒绝；input/index不变，原controlled与未选dirty隔离回归保持。

只读范围回归另使用testPaths=generated-tests与现存tests/export.test.mjs保护oracle，证明影响图仍读取并冻结oracle，但executionScope排除它，不以扩大测试授权掩盖写范围错误。
