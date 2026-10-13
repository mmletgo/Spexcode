---
title: 协调数据库增量迁移
status: active
hue: 175
desc: 在既有会话 SQLite 注册独立 spec-sync 组件，备份后事务升级并拒绝未知版本。
code:
  - spec-cli/src/sync/migrations.ts
---
# 协调数据库增量迁移

## raw source

持续同步必须能安全升级既有会话数据库，失败不破坏已有会话和恢复记录。

## expanded spec

复用现有 SessionProtocol 和 applyComponentMigrations，不打开第二执行数据库或第二消息队列。升级前使用 backupTo 的 SQLite online backup；禁止直接复制 WAL 主文件。组件迁移在 BEGIN IMMEDIATE 中原子执行，错误全部回滚；重复启动核对 checksum，未知更高 generation 拒绝同步写入。不做破坏性 down migration，回退保留表和 blob。

初始v1保存 operation（内含冻结输入引用）、attempt（候选/证据/checkpoint 引用）、逐实际文件/规则 lease、apply journal（内含 receipt）、成对 baseline。检索身份、阶段、generation、唯一接入/派发/副作用键显式列，scope/budget/refs 小 JSON 保存运行记录，不保存正文、大契约图或第二份可编辑源码。lease tombstone 的 generation 在释放后保留。范围和动作门禁由 [[sync-store]] 负责。

v2在v1原迁移字节保持不变的基础上增加sync_resources，记录稳定资源计划、生命周期阶段及checkpoint blob引用，按未removed状态索引所有历史attempt资源。升级使用一致性backup保存v1；已有会话、operation、attempt、journal与基线不改含义。不复制checkpoint正文，也不引入执行数据库或消息队列。

v3 登记受控用户请求 requestBlob 的运行语义版本，无破坏性表结构或旧记录改写。升级前仍保存一致性备份；旧版写方因更高组件版本拒绝写入，不能忽略新请求后按旧输入执行。旧版无 requestBlob 的 payload 摘要保持相同，升级后重复事件继续命中原 operation。

v4登记可信计划planBlob直接持久引用/GC保活的语义版本，仍仅增marker、不改旧记录。v3升级先online backup，旧无plan操作和原payload/队列可读；旧writer拒绝新版本，不允许在忽略plan恢复引用的情况下写入。
