---
title: 同步应用政策范围回归
status: active
hue: 175
desc: 用真实Git与旧政策基线证明独立验证政策按影响范围执行，保护oracle不被削弱。
code:
  - spec-cli/src/sync/planning.test.ts
---
# 同步应用政策范围回归

## raw source

同一项目配置的独立节点各自验证，不因别的节点未进入候选上下文而失败，也不能以缩范围为由删除保护测试、弱化命令或逃避退役验收。

## expanded spec

只读初始化回归不用projectedSelection：实际P4 derive初始all-null、精确scope/ack/queued claim、受控四门、真实private delivery正常hooks与settleApply、application.adopt建立基线。journal.files只有root与三叶Spec，234个业务ID头真实结算，源码无byte资源行；从listBaselineResources取得discovery后，单Storage型JSON序列化commit三轮均只派owner及真实依赖，最终source bytePair仍显式null。正式冻结的计划及精确selection与独立执行三轮的输出逐字节一致。原receipt/journal不改。四门为明确fake前置，不冒称真实模型/Docker验收。

负例保留scope外、缺owner/ID头、未采纳before、before源码内容/mode/absence与正式对象不一致、未审owner正文/新增code claim漂移的bootstrap；不得借兄弟全树pair或当前未审声明。隔离库将journal列与原件一致改为未settled、撤销结算凭据后，真实readBaselineSelection必须返回unsupported，不补头/receipt、不修库。

回归 [[sync-application-planning]] 的精确政策选择。真实Git夹具包含两个独立Spec、源码、VERIFY与不可写mandatory oracle；A计划只执行A政策，B不进入A的读取、执行或验证覆盖。候选实际硬门禁仍拒绝删除/改写oracle与删除/弱化VERIFY。

新计划另冻结未选 B 的 contextVerifications，并证明它改变 policyDigest 而不改变实际 acceptance run 或 mandatory 范围。旧 canonical JSON 的字段缺席及 undefined 均保持原摘要，不能从实时配置补签。

A仅引用B规则或显式readonly上下文纳入B Spec时，B整Spec作为readonly上下文包含真实VERIFY，仍精确登记该定义满足候选检查，但不因此执行无关B mandatory或授B写范围。真实store admission、candidate、verification、journal、receipt、settlement建立旧基线后，删除当前A owner仍从旧政策并集保留原命令及oracle，不能删除owner规避保护。Git对象、store动作和receipt真实，四层验证明确fake，不是native或Docker产品验收。

没有任何真实owner的预登记定义和mandatory继续保留，供纯raw细化或由严格门禁暴露缺口；坏schema/未支持命令不能被范围筛选吞掉。此回归不运行整个仓库测试或native。

raw-only冷启动即使没有AC.test，也把settings.testPaths内的现有pytest/npm正文加入冻结读取与行为分析；授权目录外的测试和独立源码仍排除，仅读取不扩展executionScope或mandatoryTests。

整合回归确认这些未改测试不会进入 business changedPaths；source/test 角色交换但 readPaths、writePaths、executionScope 及其余计划完全相同时，sourcePaths 的政策摘要必须不同。旧 canonical 持久 JSON 的缺字段/undefined 摘要均与原字节 SHA256 相等，不通过 live 配置重解释旧计划。

真实 Git 夹具复制官方 init 的 `.plugins` 模板，先复现插件脚本被误纳入业务授权导致规划失败；修后插件实例不进入当前/历史业务图、targets、读取/写入或执行覆盖，显式插件意图拒绝，原业务源码、VERIFY 与不可写 oracle 政策保持。真实插件脚本即使位于业务 Spec 的目录前缀下，仍被候选实际 executionScope 越界门禁拒绝。

真实Git/store旧基线上的子节点移动先复现readonly父契约的code/AC文件未入readPaths；修后同一官方validateContractGraph完整严格检查无error。当前及历史映射变化两个case都读取真实精确声明文件，executionScope和writePaths逐项保持原目标范围，候选硬门禁拒绝覆盖readonly父assets；独立B的Spec/code/test及其资源均未纳入。旧基线仍经现有store动作建立，四层验证明确fake；只证明规划/读取/候选门禁，不宣称native或Docker交付。

行为输入接缝从完整runner request还原body-entry-v2正文，正文可位于独立或必读共享entry；规划输出、原授权范围、requiredChangedPaths与完整引用字节继续逐项核对，不用运输元数据替代业务覆盖。

真实Git提交回归证明，只有完整 settled baseline 的真实delivery已由 before HEAD 采纳、且完整 discovery selection 为相关bootstrap Spec及业务ID提供精确头、治理路径另有原精确头或严格只读验证证明时，单叶源码提交才能只规划其真实owners及共享/contract依赖影响闭包。三轮 freeze 保留同一完整 discovery selection；即使完整 BaselinePair 存在，只要discovery selection缺少某一精确Spec/业务ID binding仍须回到全树；未写源码的缺binding/null不能被误当业务ID缺失。首次、before缺失、未完成/未采纳基线、根意图变更和未治理源码提交保持完整纳管；move/delete 使用真实 before owner 与旧原意，不能漏差量或把失败 admission 当成已消费。
