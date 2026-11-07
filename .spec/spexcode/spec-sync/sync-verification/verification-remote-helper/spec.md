---
title: 远端验证副作用排空
status: active
hue: 175
desc: 可信Node helper共享摘要并用单run内核锁、effect原件与closed阻断迟到副作用。
code:
  - spec-cli/src/sync/verification-remote-helper.mjs
related:
  - spec-cli/src/sync/verification-transport.test.ts
---
# 远端验证副作用排空

## raw source

SSH 断线不能把仍在运行的上传、Docker CLI 或未知 API 请求当作已停止；清理后旧请求不得重建资源。

## expanded spec

helper作为实际.mjs运行时随正常NodeNext/allowJs构建和dist发布，导出精确JSDoc供TypeScript使用，不放同名.d.mts遮蔽真实模块。构建回归必须正常编译后由实际consumer import并进入发布清单，source-only测试不能替代产物证明。

本地与远端使用同一 export walker：逐层 JS readdir().sort() 深度优先，file 按相对POSIX路径、mode&0111、原bytes摘要，directory 与 symlink 文本按既有NUL格式摘要。原 v1 本地摘要保留；v2 运输统一POSIX路径。拒绝Git、宿主依赖、特殊文件和绝对/越界/悬空/循环链接。任何文件/目录写入、rename、清理前逐级拒绝 symlink parent，物化先普通文件后链接；末尾认证不能替代写前保护。

planned先持久，再创建owned控制历史与staging。每run固定lock inode永不由cleanup删除/替换。独立一次性worker脱离SSH会话，持flock后核完整marker/closed，先持久effect intent再副作用，DockerCLI显式继承同一lock FD；完整响应与后置观察持久receipt后才解锁。客户端断开不杀worker，上传EOF须排空写入并记录失败。worker/CLI崩溃留下已提交无receipt的create/start为unknown，不能用NoSuch证明停止或盲重派。

清理在同排他锁内先durable closed，迟到未取得锁请求之后拒绝；closed后的无remote intent证明该effect未执行，不伪造Docker receipt。控制历史可记录独立拒绝观察，但不能重建payload/容器。所有可重建effect完成或已fence未执行后才允许终态清理；未知者保留容量。原terminal已持久且同target/daemon时，rm/cleanup丢回执可通过exact ID/path实际不存在另记恢复观察，原调用结果保持。容器及临时candidate/runner确证清算后才removed；小型lock/closed/effect历史保留，不表示活跃staging。

materialize的完整帧/半帧EOF、JSON错误、已结束的只读inspect前置失败及文件写入失败，均须在持锁且自身FS操作排空后保存uploaded:false/settled的真实失败receipt，供同资源新序号续传；不能与未知create/start混同。上传受原冻结deadline约束；bootstrap在输入EOF后才启动有限回执等待，超时或worker退出无reply返回pending并关闭自身stdin管道，不杀worker/CLI、不假称停止，不永久驻留。

Docker只接本机实际Unix socket，每次显式绑定原endpoint并核原daemonId，不继承可换主机的DOCKER_HOST/DOCKER_CONTEXT。endpoint为TCP/SSH或非socket时明确unsupported，FS物化/摘要与实际Docker挂载必须处于同一SSH主机。
