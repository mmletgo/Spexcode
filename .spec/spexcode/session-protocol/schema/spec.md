---
title: session protocol schema
status: active
hue: 280
desc: The production schema registry and one forward-only migration mechanism shared with database components.
code:
  - packages/session-protocol/src/schema.ts
related:
  - .spec/spexcode/session-protocol/spec.md
  - .spec/spexcode/session-protocol/sqlite-engine/spec.md
---
# session protocol schema

This node owns the production migration registry and the single mechanism used by both the protocol schema and
co-located component schemas. Each component advances through one contiguous, checksummed sequence, and every
pending step and registry row commits together. Existing rows are verified before use so rewritten or unrecognised
generations stop the caller before any protocol operation proceeds.

The protocol component remains reserved to the engine. External components may use the mechanism but cannot reach
the connection, bypass the registry, migrate a read-only handle, or partially apply a sequence.

组件迁移可附afterApply={key,run(tx)}，key为显式稳定语义身份且与version/SQL一起参与checksum。旧SQL-only迁移checksum保持原值；同步回调在同BEGIN IMMEDIATE执行，地址初始化/消息完整迁移/registry全部原子回滚，异步回调拒绝。
