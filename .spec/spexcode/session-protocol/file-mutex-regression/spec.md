---
title: 本机文件独占锁回归
status: active
hue: 280
desc: 真实 SQLite 和独立进程证明文件写入独占、崩溃释放及路径身份检查。
code:
  - packages/session-protocol/src/file-mutex.test.ts
---
# 本机文件独占锁回归

## raw source

文件交付不能只依赖过期时间或 PID 猜测独占；多个进程与进程崩溃必须有实际互斥证据。

## expanded spec

对 [[engine]] 的 claimFileMutex 使用独立临时目录和实际 SQLite。验证同进程第二连接与另一进程均无法取得已持有的锁；持有者 SIGKILL 后无人工删锁即可重新取得。释放后 assertHeld 失败；锁文件替换不能被旧持有者视为继续独占；专用锁入口拒绝业务数据库及 symlink。只销毁测试自己创建的目录。
