---
title: 协调存储 SQLite 回归证据
status: active
hue: 175
desc: 针对真实 SQLite 多 handle、重启、迁移和应用结算门禁的回归测试。
code:
  - spec-cli/src/sync/store.test.ts
---
# 协调存储 SQLite 回归证据

## raw source

持久协调安全性必须由真实数据库事务和恢复测试证明，内存回调不代表真实 Git 已交付。

## expanded spec

覆盖 [[sync-store]] 与 [[sync-migrations]] 的数据库边界：重复输入/capture时间回放只一operation一message；同key不同payload拒绝；claim与exact FIFO dequeue及所有租约同事务；共享path/规则冲突、独立范围并行、释放后generation不归零；独立原生dispatch预算及稳定创建键；过期fence、物理树重建失权；actual diff和V1至V4绑定门禁；取消前无journal、写入中待receipt结算、取消后保留receipt；receipt登记后重启幂等结算；partial保留needs_input；成对源/交付基线；GC pin；旧库online backup可恢复、失败DDL事务回滚、未知高版本拒写。

验证命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts`。测试模拟已复核的 tree/commit 引用，只证明数据库结算，不替代真实Git应用与产品全链路验收。

追加验证：交付intent先durable、物理target不可替换；人类输入与模型差量分别计算并共同journal；迟到native回调不降applying状态；窄验证范围不被外层扩大；partial同source再次接入保留blocked输入与原coveredScope；预算超时持久拒绝且不重置；旧派发安全消费后最新输入领取FIFO。

receipt树引用相同但manifest不同仍拒绝，journal保持未登记；相同已冻结manifest可结算。

协作source与delivery同物理身份发布后，readBaseline返回真实发布快照同值pair，原冻结source pair仍持久保留。

时钟回拨回归：input1在1000ms结算，input2于1100ms开始、回拨至900ms后成功结算；独立handle重开后source和delivery基线都对应input2的receipt，settledAtMs仍保留900ms展示值。

资源生命周期回归先复现取消后checkpoint被旧fence拒绝且恢复查询遗漏；新增typed资源路径证明取消后created/terminal/removed可持久且业务写权仍撤销。覆盖真实SQLite多handle同阶段CAS冲突、精确重放、错input/candidate/attempt拒绝、历史attempt资源查询、未创建终止仍需terminal→removed、removed精确查询防重复创建、资源证据GC pin。v1→v2保留已有active attempt和protocol消息，online backup独立恢复v1、v2 DDL中断回滚、重复启动及升级后资源重开查询。
