---
title: 协议生产边界回归
status: active
hue: 280
desc: 固定公开 API、SQLite 行为和迁移错误边界的生产回归。
code:
  - packages/session-protocol/src/production.test.ts
---
# 协议生产边界回归

## raw source

公开协议的运行时导出、类型、错误和持久化行为必须经真实 SQLite 回归，新增采用层能力也保持接口明确。

## expanded spec

验证 [[package-entry]] 的确切运行时导出与声明，包括 claimFileMutex/FileMutex。保持 [[engine]] 的事务与数据库行为回归，不能把内部连接或部分写入能力暴露给调用方。独占文件锁的跨进程与崩溃行为另由 [[file-mutex-regression]] 覆盖。
