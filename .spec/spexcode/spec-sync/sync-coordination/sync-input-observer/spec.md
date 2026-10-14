---
title: 同步后台输入观察
status: active
hue: 175
desc: 同步后台输入观察的当前行为。
code:
  - spec-cli/src/sync/observer.ts
---
# 同步后台输入观察

## raw source

持续同步必须在无浏览器时可靠观察授权来源，并明确暴露故障。

## expanded spec

正式服务启动和关闭观察器，与 SSE 订阅无关。只观察明确注册的输入 root、其 Git HEAD/index/refs；不发现或自动启用新来源。启动、周期补偿、watcher 恢复、目录重建均重新采集。事件防抖合并突发，扫描中保存通过 dirty 后继扫描处理，不能丢最后输入。复用 [[sync-tree-watcher]]，排除同步私有保活 refs，防止自身快照回声形成循环。来源缺失保留 missing 诊断，不造快照；平台失败保持 degraded 并在补偿周期重新附着。暂停仍观察，执行准入由 [[sync-application]] 的物理控制门禁负责。stop 关闭本实例 watcher、计时器并等待已开始扫描，报告真实 offline。

补偿时核对root的实际dev/inode，目录删除重建后重新附着watcher，不能把旧inode句柄当作新目录在线。补偿tick在既有扫描期间不重复置dirty；真实文件事件仍保最后一次后继扫描，避免慢扫描被高频补偿永久拖住启动。
