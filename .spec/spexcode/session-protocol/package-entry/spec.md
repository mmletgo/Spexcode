---
title: session protocol package entry
status: active
hue: 280
desc: The exact published TypeScript and JavaScript surface of the production protocol package.
code:
  - packages/session-protocol/src/index.ts
related:
  - .spec/spexcode/session-protocol/spec.md
  - .spec/spexcode/session-protocol/sqlite-engine/spec.md
---
# session protocol package entry

This node owns the one published entry through which consumers open the protocol, compose a transaction, apply a
component migration, inspect stable constants, and use the protocol's types. It re-exports complete operations and
read models while keeping connection handles, inspection helpers, and partial writes private.

The entry has one spelling for each capability and no compatibility aliases or internal package subpath. Its runtime
keys and generated declarations are both part of the boundary: adding an export is a contract change even when no
current consumer imports it.

公开 SessionProtocol.backupTo(destination): Promise<void> 与 ProtocolTransaction.dequeue(sessionId, expectedMessageId?)；前者提供一致性备份，后者提供消息消费与采用层 claim 的共享事务边界。

公开 `claimFileMutex(absolutePath): FileMutex | null` 及 `FileMutex { assertHeld(): void; release(): void }`，供采用层在专用本机锁文件上独占短文件副作用。它不返回 SQLite 连接、不改变会话数据库的同步事务约束。
