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

v5保持v1-v4迁移字节/checksum，新增origin摘要与按仓库protocol地址的语义版本。升级先online backup；旧global pending按真实FIFO逐个tx.dequeue再tx.enqueue到仓库地址并更新operation.dispatchMessageId，稳定迁移key幂等，旧消息保留审计。迁移不得直接更新protocol内部消息字段。版本marker与数据迁移必须同事务；中断全部回滚。旧writer拒写v5；已消费消息/native/attempt/journal身份保留。

v6增加retryOf显式用户重试语义及semantic_digest索引，由checksummed callback从旧冻结record回填，不改v1-v5迁移字节/checksum。升级前online backup，旧记录无retryOf仍按旧精确摘要重放，旧writer拒写更高版本，禁止downmigration。

v7新增规范请求语义索引和精确 ingress 接入收据，不改 v6 helper、checksum 或历史 payload/record。DDL 迁移不读取任何仓库 Git/blob；旧受控请求在当前来源接入边界惰性核验后填索引。升级仍 online backup、原子回滚、重启幂等和旧 writer 拒写；其它已移除仓库的证据缺失不阻数据库升级。

v8登记P3行为授权、已结算精确业务裁决和退役身份的writer语义版本，保持v1-v7迁移字节/checksum不变。升级前online backup、marker同事务、重启幂等；旧P2 writer必须因generation更高拒绝，不能忽略新JSON引用后丢弃已确认用户规则。旧缺省refs仍可读，禁止破坏性downgrade。

v9登记结构化裁决授权范围和结算后稳定裁决身份语义，v1-v8迁移字节/checksum不变；先online backup，marker事务幂等，旧v8 writer拒写。旧裁决规范索引仅在真实不可变request可核验的当前来源接入边界重算，历史payload/record/receipt不改。

P4 采用第10代增量组件迁移：新增物理控制、资源 frontier、持久观察，原会话数据意义不变。升级前在线一致备份；组件事务失败整体回滚，重复启动幂等，未知新版拒绝同步写入。P3 资源头仅从 coveredScope、实际 journal.files、receipt 与明确前驱链回填；不能以 rowid、时间或文件授权目录猜精确历史。无法证明的资源记录 legacy 阻断，新接入失败而旧冻结 journal 恢复保留。
