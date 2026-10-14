---
title: session protocol production engine
status: active
hue: 280
desc: The synchronous production implementation of addresses, FIFO delivery, history, retirement, and bounded transactions.
code:
  - packages/session-protocol/src/engine.ts
related:
  - .spec/spexcode/session-protocol/spec.md
  - .spec/spexcode/session-protocol/sqlite-engine/spec.md
---
# session protocol production engine

This node owns the synchronous production implementation of the protocol operations and their transaction
boundaries. Opening establishes and verifies the frozen connection contract before schema or message work begins.
Writes reserve the database writer before reading mutable state; reads remain single statements over durable state;
and the shared transaction surface admits only SQL plus complete protocol enqueue/dequeue.

The engine exposes no connection or partial operation. Re-entering a protocol write from a shared transaction is a
composition error with a direct repair instruction, and asynchronous transaction bodies are refused before commit.
An exception raised by the transaction body belongs to its caller: the engine rolls back and rethrows that same
value without interpreting its type, code, or message. Failures from transaction control and the SQL operations
mediated by the transaction object remain protocol failures and retain the protocol's stable error classification.
Storage placement and locality are caller preconditions and have no implementation in this module.

共享事务增加 tx.dequeue(sessionId, expectedMessageId?)，只消费 FIFO 首消息；指定消息与首消息不符时拒绝且事务回滚。采用层可以将 durable claim 与消费消息原子提交，崩溃后由已保存运行记录恢复。backupTo(destination) 使用 SQLite online backup 保存一致性数据库，禁止复制 WAL 主文件；目标必须是不同的新绝对文件，同 handle 备份期间拒绝写入、关闭或迁移。

tx.initialize(sessionId)复用正式地址内核，可将地址与enqueue及采用层记录同事务提交；迁移afterApply只接收该受限tx，不暴露connection、不允许重入外层protocol写入。
