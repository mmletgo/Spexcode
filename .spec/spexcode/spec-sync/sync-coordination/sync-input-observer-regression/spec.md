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

使用真实临时 Git 验证无浏览器提交引用变化、保存/原子替换及 index 暂存不触发、扫描中连续提交、停止后停机变化补偿、来源缺失重建及平台故障恢复。当前 main source 有效 HEAD 下，多次新建/更新无关 branch refs 不得开始扫描；当前 HEAD ref 提交、HEAD branch/detached 切换、符号 alias 链 retarget、packed-refs 变化仍触发。未知 ref 路径和当前 ref 的目录祖先保守触发；refs 下的 `*.lock` 不触发，也不能使后续有效 commit 漏扫或令 watcher degraded。显式 scanNow 与周期补偿仍无条件采集。断言 scan 输入来自实际字节；故障不宣称监听正常，停止回收本实例资源。

高频补偿与慢startup扫描同时运行时，补偿tick不永久追加dirty，startup可返回；真实扫描中提交仍必须驱动最后一次后继采集。
