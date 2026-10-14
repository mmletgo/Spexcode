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
