---
title: 显式跨启动来源连续性
status: active
hue: 175
desc: 明确旧dev双哈希证明后登记当前物理见证，共享仓库身份并逐来源保留旧物理授权。
code:
  - spec-cli/src/sync/source-registration.ts
related:
  - spec-cli/src/sync/source-registration.test.ts
---
# 显式跨启动来源连续性

## raw source

重启只改变设备号时，不能通过伪造旧source或修改历史操作恢复。用户可在离线停稳后显式提供旧设备号候选，严格证明同一来源并正式登记；未证明的来源或再次替换继续拒绝。

## expanded spec

正式offline CLI接收原operationId/inputId/revision、旧enabled原字节SHA和commonDir/root/gitDir各自旧dev。复用真实Git根、commonDir、登记/回链与实际branch采集，登记当刻原branch与配置授权匹配；使用当前ino/birth和显式旧dev同时精确复算原repositoryId与physicalFingerprint。不能搜索猜值、只核一个哈希或改写旧source/input/预算/CAS。相同实际路径的候选dev必须一致，前后stat/Git/配置与原记录摘要稳定。

源enable与continuity登记共用既有file-mutex及原字节摘要CAS；登记仅在offline/quiesced、无活动observer和未结算资源/journal时进行。证明成功后通过既有PhysicalControl正式CAS暂停原logical scope，再写EnabledRecord v2和不可变证据引用。v1不静默重写；v2保留原source/配置授权、原enabled原字节引用和新proof。失败可保持pause，不声称DB与文件是跨介质原子事务；显式operator resume另行授权继续，不自动派发。

proof和旧enabled字节复用putBlob/readBlobByHash置于global runtime/sync/continuity-evidence私有CAS；随注册链保留，不交给只扫描数据库引用的普通Git evidence GC。引用按SHA重读核验；回滚须停新writer并配套恢复升级前online DB备份、旧enabled和原continuity证据。writer20拒绝旧writer，既有1–19 checksum与历史记录不变。

公共身份解析只投影已证明的repositoryId/physicalFingerprint，actual canonical路径、gitDir与实际branch继续真实采集，不能return旧source隐藏切分支或回链变化。commonDir见证共享原logical repositoryId；新建managed/linked工作树的physicalFingerprint来自其真实新stat。其它root的旧physical authority须单独证明，正常操作必须全字段核对来源；commonDir相同不授予旧linked继续权。v2当前raw stat再次变化时正常identify拒绝，不fallback新raw namespace。资源-only专用入口仍可读raw Git登记元数据仅清理，不能把raw能力交给normal admit/resume/adopt。

identity见证不永久绑定业务配置digest或branch授权。后续正式config-only提交与enable在同一锁内核新配置授权，并保留物理continuity链；当前ness、V4与交付仍看到真实branch和真实相关输入。snapshot/source字段集合、顺序及历史哈希不混入v2 wrapper字段。未来稳定VolumeUUID身份不属于本能力。
