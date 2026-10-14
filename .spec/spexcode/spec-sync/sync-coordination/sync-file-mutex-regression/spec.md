---
title: 私有交付独占锁回归
status: active
hue: 175
desc: 本机内核独占支持可恢复的私有交付文件写入。
code:
  - spec-cli/src/sync/file-mutex.test.ts
---
# 私有交付独占锁回归

## raw source

私有交付的文件写入需要真实跨进程独占；进程崩溃后恢复不能和旧进程同时写入。

## expanded spec

真实 SQLite 连接与独立子进程覆盖 [[sync-file-mutex]]：第二连接和另一进程均无法获得已持有的锁；持有者 SIGKILL 后无需删锁即可重获。release 后授权失效，目录重建使旧锁失权且旧 release 不删除新文件；业务库、symlink拒绝。测试只清理自己创建的临时目录。
