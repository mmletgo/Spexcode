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

新规划冻结从版本化 settings.sourcePaths 派生的可选 sourcePaths，表达业务源码角色，参与现有整个 plan 的 canonical policyDigest；它只限制未治理业务源码发现及新业务归属，不扩展 readPaths/writePaths/executionScope。历史持久 JSON 缺此字段时保留原 writePaths 发现及原业务归属判断，旧摘要逐字不变，不从 live settings 补角色或回写 planBlob；无需数据库迁移。回滚实现前先结算使用新字段的活动操作，保留全部历史 blob/摘要；按所用版本发起新的可信请求，不原地删字段或换算已有操作政策。

mandatoryTests 是额外已有独立测试义务，包含 verificationId/testPath/testId；文件不能与模型 writePaths 重叠，必须在冻结读集合，不能由模型改 oracle 自免。未来 ready AC 由可信契约图计算，完整流程使用 readyFlowIds。verification definitions 明确进入 P1 verifications 字段，不能当待裁决业务 facts。

prepareSyncAdmission 返回既有 AdmitSyncInput；runSyncOperation 的 options 提供固定计划、再次读取当前可信计划、source 外预建0700的 managedRoot/artifactRoot及固定可信 tools。可注入模型 runner 或 Docker driver 仅作为明确测试接缝，生产默认既有原生执行。返回操作真实状态/receipt/typed failure，不以本地 Promise 成功代表交付。

SyncAdmissionOptions可带retryOf，新用户显式重试身份透传admission；冻结input/request/policy与旧已接受契约义务不变，仅经store真实eligibility核验后授权新执行预算。

可信应用沿旧 operation 的 executionScope 与 impactDigest 重建显式重试接入：P1 已审扩展的路径及业务 ID 进入实际读取/选择，原计划正文与 policyDigest 保持。store 仍逐项核原 scope、readSet、selection、impact 及请求，外部请求不能直接指定这两个内部值。

SyncCoordinatorOptions.recoveryOnly?:boolean显式请求只结算已有资源或已开始journal；不启动未派发operation、新attempt/native/verification或无journal交付，保持用户control/input与执行预算。

可信计划可携已结算decisionRefs，完整参与policyDigest，并以不可变用户裁决及已审finding.ruleIds派生精确业务supersession。模型分析产出的事实及授权通过独立checkpoint绑定，不修改计划或政策摘要。

plan.decisionAuthorities是重读已结算decisionRefs或当前请求及原真实finding形成的结构化scope，完整参与policyDigest；source字符串或facts自然语言不能扩大范围。模型不拥有此结构生成入口，授权不得越过所选ruleIds依赖闭包。

可信 authorizedChanges 可携 restore 动作及固定 history request/input；只有正式 revert 由原 settled receipt 派生，协调器再次核原 operation、journal/receipt、commit 与请求身份。模型分析不能产生此动作，普通任务不能声明恢复。

接入选项可携 model，规范化后写入共享 operation 身份；模型选择与预算、可信计划及业务授权分离，遵循 [[sync-model-selection]]。


计划类型为显式 v1/v2 联合：v1 保留原 JSON 形状；v2 必填 direction（spec_to_code/code_to_spec/combined）及 partitionPolicy（sync-partition-policy-v1、maxReadBytes、maxParallel），可携 commitTrigger:{before:InputSnapshot|null,paths}。它们完整参与 canonical policyDigest。before 只是同物理来源的真实已提交前态，after 唯一使用 operation.input，不能伪造共同验证基线。默认小批并行不改变 session 容量或调用计费。阶段分区及最终覆盖证据复用 BlobRef，不新增数据库任务身份。
