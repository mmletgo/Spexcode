---
title: 同步观察回归
status: active
hue: 175
desc: 同步观察回归的当前行为。
code:
  - spec-cli/src/sync/observer.test.ts
---
# 同步观察回归

## raw source

持续同步必须在无浏览器时可靠观察授权来源，并明确暴露故障。

## expanded spec

使用真实临时目录和 Git 文件事件验证无浏览器保存、原子替换、扫描中连续保存、停止后停机变化补偿、来源缺失重建及平台故障恢复。断言 scan 输入来自实际字节；故障不宣称监听正常，停止回收本实例资源。

高频补偿与慢startup扫描同时运行时，补偿tick不永久追加dirty，startup可返回；真实扫描中保存仍必须驱动最后一次后继采集。
