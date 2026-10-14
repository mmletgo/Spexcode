---
title: 同步应用回归
status: active
hue: 175
desc: 临时 Git/SQLite 验证受控请求、幂等、失败查询和过期输入。
code:
  - spec-cli/src/sync/application.test.ts
---
# 同步应用回归

## raw source

真实 Git 与 SQLite 必须证明不先提交 Spec、不重复受理、不虚报失败或旧版本结果。

## expanded spec

AC-APPLICATION-01 验证配置缺口、enable 摘要 CAS 与配置字节保留；02 验证 no-op 不派发、不提交及过期正文拒绝；03 验证 requestBlob 进入 coordinator、请求幂等/键冲突、失败查询及 source/HEAD 保留；04 验证输入过期、旧输入恢复拒绝及配置变化失效；05 验证共享治理叶闭包及宿主命令拒绝。

06 使用真实 Docker、compiled CLI 和正常 Git hooks 交付完整候选，source 不被覆盖，completed 重放沿原共同基线，不重复 native/commit，工具索引丢失只恢复相同 frozen runtime；模型 runner 为确定性替身，不能算真实 LLM 验收。07 验证并发同请求只有一个 runtime/operation且预算不重置；08 验证 queued 资料缺失可查询恢复诊断、原描述恢复成功、已派发操作在原描述丢失后禁止重冻结。

09 验证显式 callTimeoutMs 只来自 operation 冻结配置，live 修改不扩大旧请求或总预算；10 验证已启用后删除、坏 JSON 或越界配置保持 invalidated，恢复原字节才恢复 enabled，不允许自动降级普通独立 Spec 提交。

11 验证 initial 来源真实执行、持久入账和同键改来源拒绝；12 用同仓库两个真实 Git worktree 和 OS 互斥锁验证 FIFO、busy 无自旋及后继来源接续；13 验证已出队暂停恢复先等待有效 FIFO，前序结算后自动恢复，wait 等真实执行，预算不重置；14 验证两个仓库共享 canonical SQLite 时各自派发，不能执行或被另一仓库消息头堵塞。

15 验证普通重复归并、显式 retry 关联新操作/预算及同 retry 幂等；16 验证完整继承原 requestBlob/正文意图及旧共同基线，禁止新 patch 或旧来源变化；17 验证 queued 不可借 retry 重置预算，从未交付 cancelled 可经真实 FIFO 明确重试。

18 用真实 SQLite 注册 native 创建结果未知的固定 plan/checkpoint，验证已失败/暂停但资源未 removed 时 executionAvailability 为 recovery_required，retryEligibility 拒绝新预算。创建故障为明确测试接缝，不代表实际模型或未知宿主进程已验收。

19 验证 recover 对 queued 不派发、不改 operation/control/预算/输入、不消费有效 FIFO；20 用真实 store conflict 事件验证 conflicted + 未结算资源不能 ready，再恢复固定且未曾请求 native call 的资源，保留冲突、attempt和预算，配置失效也不阻清理。恢复已创建 native 或 Docker 的真实案例仍由 coordinator 的资源恢复验收覆盖。

21 注入内容可寻址但 native 身份不匹配的固定恢复计划，验证 coordinator 的具体 resource_recovery 以可见 409 返回，原业务 operation/attempt/预算及未释放资源保留，不只打印日志。

故障 runner 为测试接缝，不算真实模型产品验收。完整真实 Agent/Docker 落地仍按 [[spec-sync]] 分阶段验收。

22 先复现同受控 patch 仅换 requestId 导致两次模型调用和新预算；修复验证同一 failed operation/deadline/calls、B 再次重放、不同 patch/意图分离、同 key 冲突、显式 retry 原 requestBlob；实际 source/index/HEAD 不改。

23 以正式 v6 schema 及保留原请求/payload/预算的历史受理记录重开真实应用，再提交相同 patch 的新 requestId 和 alias 重放；仍只一个操作、零新增模型调用。


AC-APPLICATION-P3 在真实临时Git和canonical SQLite中冻结可信analysis checkpoint；手动code/combined入口真实受理。三个选择各自建立decision新operation，keep_intent无正文差量不丢请求，adopt/new_rule固定plan确含用户新输入且保旧原意；相同请求并发只派发一次，同key不同选择拒绝。错analysis、未知finding、stale input拒绝，旧operation superseded但分析可查，source/index/HEAD不先写。该场景只证明应用准入，真实生成/独审/Docker由协调器与上层验收。

跨应用/store验证：同choice换运输UUID、同findings换顺序仍复用同operation/deadline/calls，不只验证samekey幂等；修改选择仍需新业务输入且samekey拒绝。

P3准入同时断言固定plan的decisionAuthorities精确只含所选finding的规则/影响项/路径及不可变requestRef，不从用户任意字段或自然语言fact提取授权；未选独立GAP不进入该结构。

AC-APPLICATION-P3-PARTIAL用真实临时Git及明确fixture结算基线验证：已交付A规则后在同一原输入选择B，冻结raw同时保留A、未选义务、原受控正文编辑和B选择，source字节保持只读；先复现旧attempt raw丢失A，再验证修复。不将fixture receipt宣称真实模型或Docker交付。

P3-PARTIAL同时覆盖分行及同行互不重叠的A交付/B裁决，完整原raw和受控字节均保留；同行失败证据先确认旧行级冲突fallback丢A。真正覆盖同一文本区间时，准入冻结plan不得写临时rawSource，完整三方对象仍可读，留给绑定当前operation的独审整合；本应用场景仅验证准入与原意保真，独审解析和最终候选另由协调器回归。

AC-APPLICATION-P3-DELIVERY复用06的真实临时Git、canonical SQLite、compiled CLI与普通hooks，可信预登记VERIFY-DECISION-01。外部源码新增filter超过8字符拒绝，与原RULE-EXPORT-02/AC-EXPORT-02的非空要求形成具体冲突；submit(code)真实分析和独审生成检查点，公共wait读取analysisRef/finding，三choice分别decide→wait→V1–V4/Docker→settled receipt。keep_intent移除上限且raw不变，adopt_behavior明确8上限，new_rule明确128上限；原oracle不改，新generated-tests覆盖8/9、128/129、空、幂等和权限。实际receipt正文、规则及源码符合冻结选择，未选原义务保持，source/index保留、重复裁决不新增call/commit。native输出为确定性替身，不宣称真实模型验收。

AC-APPLICATION-P3-ORACLE-REAL 在 fixture 作者起始可信提交中登记不可改旧 oracle：9/129 长度均接受。公共 submit(code)→decide→wait 三选择执行同一完整 Docker 命令，keep 相容分支真实 receipt；adopt/new_rule 新限额真实 V3 非零、预算耗尽且无 receipt，绝不在裁决后改 oracle。ORACLE-PROTOCOL 用同一精确独审 finding 和冻结输入验证互斥分类由泛 generation_failed 改为 needs_input/oracle_policy_conflict，保具体裁决、定义、旧 oracle 摘要及矛盾反例；终态 wait 重放不新增 call，source/index 保留。本协议 runner 为明确独审接缝，不冒称真实模型判断。
