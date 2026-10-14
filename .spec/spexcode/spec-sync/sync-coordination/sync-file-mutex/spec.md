---
title: 私有交付的进程独占锁
status: active
hue: 175
desc: 本机内核独占支持可恢复的私有交付文件写入。
code:
  - spec-cli/src/sync/file-mutex.ts
---
# 私有交付的进程独占锁

## raw source

私有交付的文件写入需要真实跨进程独占；进程崩溃后恢复不能和旧进程同时写入。

## expanded spec

采用层在专用本机锁文件上使用 SQLite BEGIN EXCLUSIVE 持有实际内核锁，直到 release 或进程退出；不以时间或 PID 推测独占。忙时返回 null，其余错误保留。独立 rollback-journal 文件具有固定 application_id，拒绝业务数据库、WAL 与 symlink。assertHeld 核锁路径及父目录物理身份和连接生命周期；锁文件不能在使用中删除。可跨 await 持锁，但不把文件副作用混入既有会话数据库事务；没有第二消息队列或持久业务事实。上层必须保证私有目录及所有写方遵守协议，不能据此声称约束普通外部编辑器。
