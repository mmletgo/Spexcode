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

真实 Git 空基线夹具包含多个独立业务 Spec 和非 UTF-8 工具插件实例：组合及证据重读只投影真实业务契约，逐 ID 核对 owner、原始需求和完整对象；插件原字节与用户 index 保持。业务正文经批量对象通道读取，不逐 Spec 启动单 blob 进程；真正业务 Spec 的非 UTF-8 内容仍拒绝。此夹具不创建验证或 receipt，不代表原生产品验收。

回归 [[sync-input-composition]]、[[sync-code-behavior]]、[[sync-controlled-request]] 及 [[sync-application-planning]] 的精确资源行为。夹具保存真实 source/交付 worktree、Git提交/blob/mode，成对基线经真实store admission→generation→verification→journal→receipt→settlement动作建立，禁止手写SQLite伪造权威。验证四层和行为分析runner明确fake，不把这些单测称为真实native产品验收。

大小写混合路径的真实 Git 树经组合后，必须能够重读并核对 manifest/contentDigest，且保留各文件的原始字节。

核心三场景：A pair只消费A，B byte pair接续A1+B1且only消费B；新A2保持B1，pairID不同不等于业务冲突。B.source夹带未消费A2而next source没有继续编辑时，对比legacy全latest漏作者残差的失败证据，再证明精确intent head仍强制完整A2整合。普通ff接受真实receipt commit/blob/mode后回声无作者变化，后续A编辑仍能识别。

程序保护负例覆盖未选B政策、局部AC删除、权限弱化，即使fake审查accept仍拒绝。受控请求覆盖非重叠与真实重叠，保原immutable作者patch、selection digest及完整三方，来源/index保持不变。executionPaths排除不相关dirty/untracked；真实读取/保护闭包不以source/test授权目录冒充范围。P3目录coveredScope能够证明journal exact文件head；FLOW只用flow资源，VERIFY是执行政策保护。getter重核actual snapshots/OID/语义，hash正确的新伪造证据也不能删除残差或替换source对象。

同一真实Git/store夹具另验证code-only A2：Spec行和raw没有本轮变化，B.source已夹A2但交付A1+B1且only覆盖B，直接actual analyzeCodeBehavior的requiredChangedPaths旧版为空而修复后含真实源码。完整整合保A2/B1，fakeaccept也不能删B、弱化权限或mode；getter拒hash正确的伪造artifact无残差。ff采纳真实receipt commit/blob/mode后无代码回声，再A3仍必读；真实原source、交付、newsource全文与OID分别进入上下文，不伪造作者基准。

另以真实 store journal 复现：先 FF 采纳旧源码 byte head，再由新 intent 消费作者源码，本轮交付的 files 只有 Spec，源码 byte head 继续指旧 pair。所有 owner intent 均已消费时 artifact 与 residualPaths 不得重复标记旧源码；新源码、新 raw 和回退到未消费 owner 的 partial selection 仍保真实残差。四层验证沿夹具的明确 fake，不冒称原生模型或 Docker 验收。

只读上下文反例使用真实tracked配置HEAD旧对象与source dirty新对象、mode变化及oracle删除：旧组合返回HEAD旧OID，contextPaths修复后等于实际source且不扩大executionPaths。hash合法的新证据移除context metadata仍因真实source/HEAD不一致而拒绝；input/index不变，原controlled与未选dirty隔离回归保持。

只读范围回归另使用testPaths=generated-tests与现存tests/export.test.mjs保护oracle，证明影响图仍读取并冻结oracle，但executionScope排除它，不以扩大测试授权掩盖写范围错误。

新module发现反例把helper/feature真实提交Git、现治理源码新增literal动态import、独立B已提交后又dirty；直接actual analyzeCodeBehavior要求两个新模块完整正文及requiredChangedPaths，必须真实newNodes或具体coverage_gap，fake模型仅列allowed_change仍被程序拒绝。readPaths/selection只增exact readonly，不晋写scope，B读取与锁范围仍排除。另以真实store结算新leaf/code而source未ff接受的场景证明实际交付治理阻止重复发现；另在真实退役后保旧code头snapshot的历史owner，确认不能复活已删除的真实owner path；验证和runner仍明确fake。

行为分析接缝按body-entry-v3的独立或必读共享entry展开真实冻结正文及JSON语义引用，仍逐字核原三方字节、OID、mode与intent artifacts；运输去重不改变原精确基线、作者残差和独立交付断言。
