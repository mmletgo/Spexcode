---
title: 中央协调可信计划接口
status: active
hue: 175
desc: 冻结可信读写影响、业务事实、验证命令与独立测试义务。
code:
  - spec-cli/src/sync/coordinator-types.ts
---
# 中央协调可信计划接口

## raw source

高层需求通过可信配置确定读写影响与执行政策；用户无需提前知道未来实现文件或验收 ID，模型不能自批授权及测试义务。

## expanded spec

P4 计划的 executionScope 单独冻结本次实际写入文件及目标契约/流程；writePaths 继续表达生成授权，不能作为写锁或已验证覆盖范围。baselineSelection 完整记录精确读取、保护和写入资源的独立字节/意图基线，接入使用同一已捕获 InputSnapshot，不为观察事件重新采集另一版本。既有 P3 冻结操作缺少这些字段时仍按其原计划恢复。

SyncCoordinatorPlan 是普通可内容寻址 JSON；version、intentNodeId、targets、readPaths、writePaths、facts、verifications、mandatoryTests、明确授权变更及新节点原意均参与 policyDigest。readPaths/writePaths 可是可信目录前缀；读取冻结完整 manifest 展开现存文件，不存在的精确路径也参与 readSetDigest，新增文件以整个冻结树中的不存在身份为基线。外部输入与 HEAD 的实际差异必须在授权写范围且进入可信读集合，不能静默提交无关 dirty 内容。

mandatoryTests 是额外已有独立测试义务，包含 verificationId/testPath/testId；文件不能与模型 writePaths 重叠，必须在冻结读集合，不能由模型改 oracle 自免。未来 ready AC 由可信契约图计算，完整流程使用 readyFlowIds。verification definitions 明确进入 P1 verifications 字段，不能当待裁决业务 facts。

prepareSyncAdmission 返回既有 AdmitSyncInput；runSyncOperation 的 options 提供固定计划、再次读取当前可信计划、source 外预建0700的 managedRoot/artifactRoot及固定可信 tools。可注入模型 runner 或 Docker driver 仅作为明确测试接缝，生产默认既有原生执行。返回操作真实状态/receipt/typed failure，不以本地 Promise 成功代表交付。

SyncAdmissionOptions可带retryOf，新用户显式重试身份透传admission；冻结input/request/policy与旧已接受契约义务不变，仅经store真实eligibility核验后授权新执行预算。

SyncCoordinatorOptions.recoveryOnly?:boolean显式请求只结算已有资源或已开始journal；不启动未派发operation、新attempt/native/verification或无journal交付，保持用户control/input与执行预算。

可信计划可携已结算decisionRefs，完整参与policyDigest，并以不可变用户裁决及已审finding.ruleIds派生精确业务supersession。模型分析产出的事实及授权通过独立checkpoint绑定，不修改计划或政策摘要。

plan.decisionAuthorities是重读已结算decisionRefs或当前请求及原真实finding形成的结构化scope，完整参与policyDigest；source字符串或facts自然语言不能扩大范围。模型不拥有此结构生成入口，授权不得越过所选ruleIds依赖闭包。
