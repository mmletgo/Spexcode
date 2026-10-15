---
title: 共享目录观察原语
status: active
hue: 175
desc: 共享目录观察原语的当前行为。
code:
  - spec-cli/src/tree-watcher.ts
---
# 共享目录观察原语

## raw source

持续同步必须在无浏览器时可靠观察授权来源，并明确暴露故障。

## expanded spec

Graph SSE 与无浏览器同步服务复用同一 TreeWatcherRegistry。Darwin/Windows 使用递归平台观察，其他平台按目录枚举；路径事件不绑定文件 inode，原子替换可见。未知路径或平台故障关闭该注册全部句柄并报告具体错误，调用者负责有界恢复；关闭回收全部句柄。census 统计所有实际源和平台注册。graphStream 保持既有公共导出。
