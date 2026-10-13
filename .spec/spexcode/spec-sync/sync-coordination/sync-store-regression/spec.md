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

受控用户请求回归证明：同一实际来源快照上的不同 requestBlob 不被错误归并；同键改变请求拒绝，原来源字节不改，请求证据被 GC pin 保留。真实 v2 数据库备份升级至 v3 后，无额外请求的旧事件仍命中相同 operation/payload，备份保留 v2 与原消息。

覆盖 [[sync-store]] 与 [[sync-migrations]] 的数据库边界：重复输入/capture时间回放只一operation一message；同key不同payload拒绝；claim与exact FIFO dequeue及所有租约同事务；共享path/规则冲突、独立范围并行、释放后generation不归零；独立原生dispatch预算及稳定创建键；过期fence、物理树重建失权；actual diff和V1至V4绑定门禁；取消前无journal、写入中待receipt结算、取消后保留receipt；receipt登记后重启幂等结算；partial保留needs_input；成对源/交付基线；GC pin；旧库online backup可恢复、失败DDL事务回滚、未知高版本拒写。

验证命令：`npx tsx --import ./scripts/test-home.mjs --test spec-cli/src/sync/store.test.ts`。测试模拟已复核的 tree/commit 引用，只证明数据库结算，不替代真实Git应用与产品全链路验收。

追加验证：交付intent先durable、物理target不可替换；人类输入与模型差量分别计算并共同journal；迟到native回调不降applying状态；窄验证范围不被外层扩大；partial同source再次接入保留blocked输入与原coveredScope；预算超时持久拒绝且不重置；旧派发安全消费后最新输入领取FIFO。

receipt树引用相同但manifest不同仍拒绝，journal保持未登记；相同已冻结manifest可结算。

协作source与delivery同物理身份发布后，readBaseline返回真实发布快照同值pair，原冻结source pair仍持久保留。

时钟回拨回归：input1在1000ms结算，input2于1100ms开始、回拨至900ms后成功结算；独立handle重开后source和delivery基线都对应input2的receipt，settledAtMs仍保留900ms展示值。

资源生命周期回归先复现取消后checkpoint被旧fence拒绝且恢复查询遗漏；新增typed资源路径证明取消后created/terminal/removed可持久且业务写权仍撤销。覆盖真实SQLite多handle同阶段CAS冲突、精确重放、错input/candidate/attempt拒绝、历史attempt资源查询、未创建终止仍需terminal→removed、removed精确查询防重复创建、资源证据GC pin。v1→v2保留已有active attempt和protocol消息，online backup独立恢复v1、v2 DDL中断回滚、重复启动及升级后资源重开查询。

细化范围回归使用真实 SQLite：初始 path scope 没有未来 ID，新增 REQ/AC/FLOW 后共享路径保持 ready、GAP 依赖 ID 单独 blocked，部分 receipt 与 baseline 只推进真实已验证 ID，根仍 needs_input。扩展参数夹带 paths、删除旧 ID、同证据不同集合、错误 hash、过期/旧 fence 或冻结候选后新扩展均拒绝。两个连接竞争新增 ID 时全部回滚，旧路径 lease/token/generation 不变；成功 ID 租约沿用 attempt token/期限，精确重放不增资源 generation/operation revision、不重复派发或计费。证据引用被 GC pin，数据库重启与 retry 保留 expanded scope 和证据。

两个独立进程同时操作同一 SQLite 文件争抢新业务 ID，只有一方扩展成功，另一方明确 lease conflict；数据库只登记一个 ID holder，双方原路径租约保持原 token。

操作列表覆盖仓库隔离、精确来源根、终态可见、rowid顺序与默认/显式分页边界，非法limit拒绝；不同更新时间不会改变接入顺序。

journal精确查询证明未知operation拒绝、另一operation不可串读，终态已结算receipt仍可返回。

接入key精确查询同时覆盖主key和alias、不存在返回null；不要求扫描操作列表或用latest baseline重建旧payload。

先复现applying pause→settled receipt→resume错误queued，修复验证完整及部分receipt分别恢复workspace_synced/needs_input，当前attempt、generation、callsUsed、deadline、receipt不变。

计划引用回归证明queued直接GC pin、同键同计划幂等、policy/ref不匹配及错误bytes摘要拒绝；v3→v4备份可独立打开原v3库，旧无plan payload/队列不变，重复升级及新handle读取plan仍成立。

attempt查询仅返回精确operation、包含历史及终态attempt并按插入顺序排列；未知operation拒绝，不能扫描全库拼接修复证据。

先真实SQLite复现旧queued被supersede但FIFO残留阻新claim；修复证明controlled/terminal旧头及当前claim同tx消费。有效独立queued保持原FIFO，错误expectedMessageId导致全部回滚，readonly nextDispatch不改变queue且返回真实envelope/op绑定。

已消费paused身份resume时，另一有效pending仍在则等待并不创建attempt；pending被正常claim后才恢复已dequeued操作。执行最相关session-protocol adopter-seams回归验证tx.query只读与tx.dequeue原子边界。

真实部分 receipt 结算到 needs_input 后，新尝试只领取原 ready 范围；不同细化 evidence 扩展完整旧/新 ID 集合时，已有 blocked contract/flow ID 仍只在 blockedScope，新 ID 可进入 ready，不能因重新登记旧 ID 造成业务分区重叠。
