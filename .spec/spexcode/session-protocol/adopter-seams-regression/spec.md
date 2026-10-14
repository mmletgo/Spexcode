---
title: 通用采用事务与备份回归
status: active
hue: 280
desc: 实际 SQLite 验证采用层 claim+dequeue 共享事务及 WAL 一致性 online backup。
code:
  - packages/session-protocol/src/adopter-seams.test.ts
---
# 通用采用事务与备份回归

## raw source

采用层必须能把消息消费和自己的持久处理记录原子登记，并在 WAL 模式备份可恢复数据库。

## expanded spec

治理 tx.dequeue 与 backupTo 的针对性测试。指定非FIFO首消息时，前置采用层SQL也回滚，消息不被消费；匹配首消息时claim及dequeue一起提交。online backup保存已提交WAL消息，独立open能读出相同messageId；已存在目标拒绝覆盖。此处不引入业务专用队列或connection handle。

运行：`npx tsx --import ./scripts/test-home.mjs --test packages/session-protocol/src/adopter-seams.test.ts`。

真实SQLite验证tx.initialize+afterApply的消息搬迁与registry及采用层指针同事务：故障全部回滚，修复重启仅一次迁移；改callback key拒checksum，原SQL-onlychecksum不变，Promise回调不能提交。
